'use strict'
// ==== #119 COMMITMENT_LEDGER - the ACTOR that pays the debt ================================
//
// ledger.js answers "what do I owe". This pays it. It is the scheduler candidate `reclaim`'s
// executor, dispatched exactly like any other job: one cluster per pass, bounded, yielding.
//
// THIS FILE FILLS AND DIGS, WHICH MAKES IT THE HIGHEST-GRIEF-RISK CODE IN THE SLICE. Every
// invariant below is a hard bound, not a heuristic, and each one exists because its absence has
// a name in the log:
//
//   1. ONLY LEDGER CELLS. The candidate set is exactly what the bot itself placed (scaffold
//      registry) or dug (shaft debts). Nothing is ever derived from "this looks like litter" -
//      that is how a fresh cobblestone castle wall gets read as a scaffold tower.
//   2. FAIL CLOSED ON UNKNOWN. pathfix.readCell, never bot.blockAt. A null is the ABSENCE of
//      information, not the information that a cell is empty (Root A). Unknown -> skip, keep
//      the debt, come back when the chunk is loaded.
//   3. BELIEVE THE WORLD OVER THE LEDGER. A shaft cell that is no longer air was filled by
//      someone - possibly the operator, possibly the terrain. SETTLE the debt; never dig it
//      back out to "restore" it. A scaffold cell that is no longer our filler was repurposed;
//      forget it, never dig it. The ledger is a record of intent, the world is the fact.
//   4. STRICTLY TOP-DOWN. Filling a shaft downward means an interrupted pass leaves the plug
//      above SUPPORTED. Filling upward and stopping halfway leaves exactly the floating
//      topsoil this whole root cause is named after (the 5-block void at 459,-91).
//   5. COARSE MATERIAL MATCH. Dirt-family back into dirt-family holes, stone-family into
//      stone-family. The bot is not restoring a diamond block it never took.
//   6. NEVER INSIDE A BUILD FOOTPRINT, the hut, the hut apron, or the farm plot. Checked per
//      cell, and an inability to CHECK counts as "yes it is" (fail closed again).
//   7. FILL ONLY. healShafts contains no dig call of any kind. The reclaim pass digs only
//      through scaffold.teardownVerified, which has been double-gated since b5b5319 and
//      column-aware since #111.
//
// [[body-first-priority]]: every loop checks isStopped, the pass has a hard cell budget, and it
// is dispatched from the maintain tier - it yields to every real need by construction.

const ledger = require('./ledger.js')
const provHut = require('./provision-hut.js')
const scaffold = require('./scaffold.js')

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[reclaim] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// ---- material families (invariant 5) ------------------------------------------------------
// Coarse on purpose. "Was it soil or was it rock" is the entire question - a grass_block hole
// refilled with dirt reads as healed terrain, and refilled with cobblestone reads as a repair
// job by someone who did not care ([[natural-player-goal]]).
const DIRT_FAMILY = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|moss_block|mud|clay|sand|red_sand|gravel|soul_sand|soul_soil)$/
const STONE_FAMILY = /^(stone|cobblestone|deepslate|cobbled_deepslate|granite|diorite|andesite|tuff|calcite|basalt|blackstone|dripstone_block|netherrack|end_stone|sandstone|red_sandstone)$|terracotta$|_ore$/
function familyOf (name) {
  const n = String(name || '')
  if (DIRT_FAMILY.test(n)) return 'dirt'
  if (STONE_FAMILY.test(n)) return 'stone'
  return null
}
// What the bot may put back into a hole of this family, best first.
const DIRT_FILL = /^(dirt|coarse_dirt|grass_block|podzol|rooted_dirt|mud)$/
const STONE_FILL = /^(cobblestone|stone|cobbled_deepslate|deepslate|andesite|diorite|granite|tuff|blackstone)$/
function fillItemFor (bot, family) {
  const items = bot.inventory ? bot.inventory.items() : []
  const re = family === 'dirt' ? DIRT_FILL : STONE_FILL
  return items.find(i => re.test(i.name)) || null
}

// ---- protected ground (invariant 6) -------------------------------------------------------
// Returns true when the cell must NOT be touched. THROWS NOTHING: if it cannot decide, it says
// "protected". A reclaim pass that cannot tell whether it is standing in a build does nothing.
function isProtected (p) {
  try {
    const prov = require('./provision.js')
    if (prov.inBuildZone && prov.inBuildZone(p.x, p.z)) return true
    if (provHut.ownHutAt && provHut.ownHutAt(p)) return true
    if (provHut.onHutApron && provHut.onHutApron(null, p)) return true // (bot, pos) - the apron test takes the cell as its SECOND arg
    if (scaffold.onFarmFootprint(p)) return true
    return false
  } catch { return true }
}

const AIRISH = n => /^(air|cave_air|void_air)$/.test(String(n))

// ---- healShafts: put the terrain back (invariants 1-6, and NO DIGGING AT ALL) --------------
// `cells` is a list of shaft-debt entries ({x,y,z,was}) that MUST have come from
// scaffold.shaftDebts - this function never discovers its own targets.
async function healShafts (bot, cells, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const budget = opts.max || 12
  const pathfix = require('./pathfix.js')
  const core = require('./provision-core.js')
  const { Vec3 } = require('vec3')
  let filled = 0; let settled = 0

  // Group into columns and work each strictly TOP-DOWN (invariant 4). Columns themselves are
  // ordered tallest-top-first so the most conspicuous damage - the floating plug - is the first
  // thing healed.
  const cols = new Map()
  for (const c of cells) {
    const k = Math.floor(c.x) + ',' + Math.floor(c.z)
    if (!cols.has(k)) cols.set(k, [])
    cols.get(k).push(c)
  }
  const columns = [...cols.values()]
  for (const col of columns) col.sort((a, b) => b.y - a.y)
  columns.sort((a, b) => b[0].y - a[0].y)

  for (const col of columns) {
    if (isStopped() || filled >= budget) break
    for (const c of col) {
      if (isStopped() || filled >= budget) break
      const p = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }

      // (6) protected ground - and an undecidable answer counts as protected
      if (isProtected(p)) { dbg('skip ' + p.x + ',' + p.y + ',' + p.z + ' - a build/hut/farm owns this ground'); break }

      // (2) grounded read; UNKNOWN keeps the debt and stops this column (the cells below it
      //     are only safe to fill if what is above them is understood)
      const r = pathfix.readCell(bot, p)
      if (!r.known) { dbg('column ' + p.x + ',' + p.z + ': UNKNOWN cell at y' + p.y + ' - keeping the debt'); break }

      // (3) the world disagrees with the ledger -> BELIEVE THE WORLD. Something already fills
      //     this cell. Settle the debt and never touch it. This is the operator-cleared case and
      //     the terrain-healed case at once, and the answer to both is the same: hands off.
      if (!AIRISH(r.block.name)) {
        scaffold.settleShaft(p); settled++
        continue
      }

      // (5) coarse material match. No record of what was there, or nothing matching in the
      //     pack, means this hole is not ours to guess at today - keep the debt.
      const family = familyOf(c.was)
      if (!family) { dbg('skip ' + p.x + ',' + p.y + ',' + p.z + ' - no material family for "' + c.was + '"'); continue }
      const item = fillItemFor(bot, family)
      if (!item) { dbg('no ' + family + '-family filler in the pack - ' + col.length + ' cell(s) stay owed'); break }

      // REACH, measured from the EYES like the server does - and NO NAVIGATION HERE.
      //
      // An earlier draft called navigateTo per cell when a cell was out of reach. Offline that
      // looked harmless; run against the real 459,-91 fixture it fired the pathfinder INSIDE
      // the shaft, which is the one place nav reads as "stuck UNDERGROUND" and answers with
      // climbToSurface - a staircase/pillar that DIGS AND PLACES. The reclaim job would have
      // manufactured fresh terrain damage while paying off old, which is precisely the
      // teardown-without-column-integrity failure this slice exists to end. So: the pass-level
      // travel puts the body at the cluster, and out of reach here simply means the column
      // waits. It stays on the books; nothing is lost but time.
      const centre = new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)
      const eyes = bot.entity.position.offset(0, (bot.entity.height || 1.62) * 0.9, 0)
      if (eyes.distanceTo(centre) > 4.5) { dbg('out of reach at ' + p.x + ',' + p.y + ',' + p.z + ' - the column stays owed'); break }

      // (7) FILL. placeAt is the verified placer; a failure leaves the debt exactly as it was.
      let ok = false
      try {
        await bot.equip(item, 'hand').catch(() => {})
        ok = await core.placeAt(bot, centre.floored(), new RegExp('^' + item.name + '$'))
      } catch { ok = false }
      if (!ok) { dbg('fill failed at ' + p.x + ',' + p.y + ',' + p.z + ' (' + (core.placeAt.lastFail || 'unknown') + ') - still owed'); break }

      // The placement is only real if the world says so (the pathfix contract).
      const after = pathfix.readCell(bot, p)
      if (!after.known || AIRISH(after.block.name)) { dbg('fill at ' + p.x + ',' + p.y + ',' + p.z + ' did not land - still owed'); break }
      scaffold.settleShaft(p); filled++
      await new Promise(r2 => setTimeout(r2, 120))
    }
  }
  if (filled || settled) dbg('healed ' + filled + ' dug cell(s), settled ' + settled + ' the world had already closed')
  return { filled, settled }
}

// ---- reclaimContainer: go get the property left in a box ----------------------------------
// The 20-beef case. Opens the container, takes everything, and settles the debt ONLY on a
// grounded read of an empty window - "I took it all" is a claim, "the window is empty" is an
// observation (Root A).
async function reclaimContainer (bot, debt, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const { Vec3 } = require('vec3')
  const pathfix = require('./pathfix.js')
  const worldMem = require('./world-memory.js')
  const pos = new Vec3(debt.x, debt.y, debt.z)
  const goals = require('mineflayer-pathfinder').goals
  if (bot.entity.position.distanceTo(pos) > 3) {
    try { await require('./navigate.js').navigateTo(bot, new goals.GoalNear(debt.x, debt.y, debt.z, 2), { timeoutMs: 45000, isStopped, label: 'reclaim' }) } catch {}
    if (!pathfix.arrivedOK(bot, { x: debt.x, y: debt.y, z: debt.z, range: 4 })) {
      dbg('could not reach the ' + debt.kind + ' at ' + debt.x + ',' + debt.y + ',' + debt.z + ' - still owed')
      return 0
    }
  }
  const r = pathfix.readCell(bot, { x: debt.x, y: debt.y, z: debt.z })
  if (!r.known) { dbg('the ' + debt.kind + ' cell is UNKNOWN - keeping the debt'); return 0 }
  if (!new RegExp(debt.kind + '$').test(r.block.name)) {
    // The container is gone. The items went with it; the debt is unpayable, and pretending
    // otherwise would keep a permanent phantom on the books.
    dbg('no ' + debt.kind + ' at ' + debt.x + ',' + debt.y + ',' + debt.z + ' any more (' + r.block.name + ') - writing the debt off')
    worldMem.settleContainer(debt.kind, debt)
    return 0
  }
  let took = 0
  if (debt.kind === 'furnace') {
    let w = null
    try { w = await bot.openFurnace(r.block) } catch (e) { dbg('openFurnace failed (' + e.message + ') - still owed'); return 0 }
    try {
      for (const take of ['takeOutput', 'takeInput', 'takeFuel']) {
        for (let i = 0; i < 3; i++) {
          try { await w[take](); took++ } catch { break }
          await new Promise(r2 => setTimeout(r2, 150))
        }
      }
      const left = {}
      for (const it of [w.inputItem && w.inputItem(), w.fuelItem && w.fuelItem(), w.outputItem && w.outputItem()]) {
        if (it && it.name && it.count > 0) left[it.name] = (left[it.name] || 0) + it.count
      }
      worldMem.noteContainer('furnace', debt, left) // empty -> settles; anything left stays owed
    } finally { try { w.close() } catch {} }
  } else {
    // chest: the bank code already owns chest emptying; reuse it rather than growing a second
    // implementation ([[resource-model]] - one write side).
    try {
      const bank = require('./provision-bank.js')
      const counts = await bank.chestCounts(bot, r.block)
      for (const name of Object.keys(counts || {})) {
        if (isStopped()) break
        try { await bank.withdrawItem(bot, r.block, name, counts[name]); took++ } catch {}
      }
      const after = await bank.chestCounts(bot, r.block)
      worldMem.noteContainer('chest', debt, after || {})
    } catch (e) { dbg('chest reclaim failed (' + e.message + ') - still owed'); return 0 }
  }
  try { await require('./provision-core.js').collectDrops(bot, 4) } catch {}
  dbg('collected from the ' + debt.kind + ' at ' + debt.x + ',' + debt.y + ',' + debt.z)
  return took
}

// ---- reclaimPass: ONE cluster, then hand the body back ------------------------------------
// Deliberately single-cluster. Reclamation is background work; a pass that chews through the
// whole backlog is a pass that has stopped yielding, and [[single-goal-discipline]] plus
// [[body-first-priority]] both say no. The scheduler will pick it again if it is still the best
// use of the body - which is the entire point of making it a scored candidate.
async function reclaimPass (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const near = (bot && bot.entity && bot.entity.position) || { x: 0, y: 0, z: 0 }
  const cs = ledger.clusters({ near, maxDist: opts.maxDist || 128, radius: 12, kind: ['container', 'shaft', 'scaffold'] })
  const best = cs[0]
  if (!best) return { ok: true, paid: 0, reason: 'nothing owed nearby' }
  dbg('paying ' + best.n + ' ' + best.kind + ' commitment(s) worth ' + best.value + ' at ' + best.x + ',' + best.z + ' (' + Math.round(best.dist) + 'b)')

  if (best.kind === 'container') {
    const took = await reclaimContainer(bot, best.members[0], { isStopped })
    return { ok: true, paid: took, reason: 'container at ' + best.x + ',' + best.y + ',' + best.z }
  }

  // Both remaining kinds need the body at the cluster first.
  if (Math.hypot(near.x - best.x, near.z - best.z) > 6) {
    const goals = require('mineflayer-pathfinder').goals
    try { await require('./navigate.js').navigateTo(bot, new goals.GoalNear(best.x, best.y, best.z, 3), { timeoutMs: 45000, isStopped, label: 'reclaim' }) } catch {}
    if (!require('./pathfix.js').arrivedOK(bot, { x: best.x, y: best.y, z: best.z, range: 8 })) {
      return { ok: false, paid: 0, reason: 'could not reach the debt at ' + best.x + ',' + best.z }
    }
  }
  if (isStopped()) return { ok: false, paid: 0, reason: 'stopped' }

  if (best.kind === 'shaft') {
    const r = await healShafts(bot, best.members, { isStopped, max: opts.max || 12 })
    return { ok: true, paid: r.filled + r.settled, reason: 'filled ' + r.filled + ', settled ' + r.settled }
  }

  // scaffold: the existing double-gated, column-aware teardown owns this. No second
  // implementation ([[action-verification]]: never add ad-hoc success checks).
  let removed = 0
  try {
    const t = await scaffold.teardownVerified(bot, best, {
      radius: 16, max: opts.max || 32, maxPasses: 3, isStopped,
      exclude: p => isProtected(p)
    })
    removed = (t && t.removed) || 0
  } catch (e) { dbg('teardown failed (' + e.message + ')') }
  try { await require('./provision-core.js').collectDrops(bot, 8) } catch {}
  return { ok: true, paid: removed, reason: 'tore down ' + removed + ' placed block(s)' }
}

module.exports = { reclaimPass, healShafts, isProtected, familyOf, setDebugSink }
