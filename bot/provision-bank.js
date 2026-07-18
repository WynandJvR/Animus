'use strict'
// THE BANK: the bot's chests - placing them, orienting them, walking to them, putting things
// in, taking things out, and keeping the store tidy (double-chest healing, consolidating
// stray field chests and furnaces, litter patrol). Split out of provision.js unchanged.
//
// resources.js is the READ model - "what do I hold, in pack and in verified chests". This is
// the WRITE side: the physical act of banking. The two are deliberately separate; anything
// deciding WHETHER to withdraw should ask resources.js, not this file.
//
// runCraft / runSmelt / runPlan stayed in provision.js on purpose. Turning a bill of
// materials into gather/craft/smelt work IS provision's stated charter - banking is the
// adjacent concern that grew inside it, not the core.
//
// Upward calls (ensureTable, runCraft, placeFromInventory, walkStaged, shelterSite,
// KEEP_WHEN_ALL) resolve at CALL time: public ones through P(), internals through the
// __siblings bridge.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const navigate = require('./navigate.js')
const scaffold = require('./scaffold.js')
const provCore = require('./provision-core.js')
const { AIRISH, REPLACEABLE, canBreakNaturally, countItem, inventoryCounts, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt, nearHostile, isNight, STRUCTURE_RE } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, saveWorldMem, listInfra, rememberInfra, forgetInfra, recallInfra,
  recallInfraVerified, ownInfraAnchors } = worldMemory
const provHut = require('./provision-hut.js')
const { hutAnchor, insideOwnStructure, hasSolidCeiling, freeInteriorCell, stationSlot,
  onHutApron, ownHutAt, recallAndReach, insideHutBox } = provHut

const P = () => require('./provision.js')
const S = () => require('./provision.js').__siblings

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const FACING_OFF = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }

function resolveBankCell (bot) {
  try {
    const bank = listInfra('chest', bot).find(e => ownHutAt({ x: e.x, y: e.y, z: e.z }))
    if (bank) return { x: bank.x, y: bank.y, z: bank.z }
    const hut = hutAnchor()
    if (hut) { const v = require('./resources.js').verifiedChests(bot, hut, 16)[0]; if (v) return { x: v.x, y: v.y, z: v.z } }
  } catch {}
  return null
}

function isBankStand (feetName, headName, sideNames, hasAdjacentWater) {
  if (!hasAdjacentWater) return false // dry but landlocked - a cast can't reach water
  return S().shelterSite.feetCellDry(feetName, headName, sideNames || [])
}

function bankStandFor (bot, w) {
  if (!bot.entity || !w) return null
  const nameAt = p => { const b = bot.blockAt(p); return b ? b.name : null }
  const isSolid = p => { const b = bot.blockAt(p); return !!(b && b.boundingBox === 'block' && !/water|lava/.test(b.name)) }
  const isWater = n => n != null && /water/.test(n)
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const R = 3
  const cand = []
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      if (dx === 0 && dz === 0) continue
      if (Math.hypot(dx, dz) > R + 0.001) continue // within ~3b horizontally of the water (cast range)
      for (let dy = -2; dy <= 2; dy++) {
        const g = new Vec3(w.x + dx, w.y + dy, w.z + dz)
        if (!isSolid(g)) continue // must be a solid block to stand ON
        const feet = g.offset(0, 1, 0); const head = g.offset(0, 2, 0)
        const feetName = nameAt(feet); const headName = nameAt(head)
        const feetSides = SIDES.map(([sx, sz]) => nameAt(feet.offset(sx, 0, sz)))
        // castable: water horizontally adjacent to the GROUND block (at g's level or one below - a
        // flush shore or the foot of a low lip); feet-level neighbours stay dry per feetCellDry.
        const hasAdjacentWater = SIDES.some(([sx, sz]) => isWater(nameAt(g.offset(sx, 0, sz))) || isWater(nameAt(g.offset(sx, -1, sz))))
        if (!isBankStand(feetName, headName, feetSides, hasAdjacentWater)) continue
        cand.push({ x: feet.x, y: feet.y, z: feet.z })
      }
    }
  }
  const ranked = S().shelterSite.rankByDistance(cand, bot.entity.position)
  return ranked.length ? new Vec3(ranked[0].x, ranked[0].y, ranked[0].z) : null
}

async function gotoChest (bot, chestBlock) {
  // BANKING REACH: a single 15s goto times out on a far bank ("chest read failed (goto
  // timed out)", live at 80b out) and the treasury reads as unreachable. Staged legs
  // first when far, then the precise approach - through the hut door if need be.
  const d = bot.entity.position.distanceTo(chestBlock.position)
  if (d > 40) { try { await S().walkStaged(bot, chestBlock.position.x, chestBlock.position.z, { range: 8, timeoutMs: 120000 }) } catch {} }
  if (bot.entity.position.distanceTo(chestBlock.position) > 3) {
    // The bank lives INSIDE the hut - a plain goto can't plan through the door, so go straight
    // through the UNIFIED navigator (its door pre-flight crosses in). Tight at-base budgets.
    try {
      await navigate.navigateTo(bot, new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 0, nudge: 1, stepout: 1 }, label: 'bank' })
    } catch {}
  }
}

async function placeStationInInterior (bot, kind, itemName, opts = {}) {
  const hut = (opts.hut) || (listInfra('hut')[0])
  if (!hut) return null
  // only when we're actually AT the hut (else this is a field station - place locally)
  if (!insideOwnStructure(bot) && !onHutApron(bot)) return null
  if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name === itemName)) return null
  const cell = stationSlot(bot, kind, opts.desired != null ? opts.desired : 1, hut) // null if one already stands / interior full
  if (!cell) return null
  try {
    const nav = require('./navigate.js')
    if (!insideOwnStructure(bot)) { try { await nav.enterStructure(bot, hut, { isStopped: opts.isStopped }) } catch {} } // walk IN through the door first
    if (bot.entity.position.distanceTo(cell) > 3) await gotoWithTimeout(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), 15000)
    if (!await placeAt(bot, cell, new RegExp('^' + itemName + '$'))) { dbg('  interior place: ' + itemName + ' did not land at ' + cell.toString()); return null }
    const md = require('minecraft-data')(bot.version)
    const blk = bot.blockAt(cell)
    if (blk && blk.name === itemName) { rememberInfra(kind, cell, { own: true }); dbg('  placed ' + kind + ' inside the hut at ' + cell.toString() + ' (reachable through the door, not across a wall)'); return blk }
    void md
  } catch (e) { dbg('  interior place failed (' + e.message + ')') }
  return null
}

async function ensureChest (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const chestId = mcData.blocksByName.chest.id
  let chest = bot.findBlock({ matching: chestId, maxDistance: 8 })
  if (chest) { rememberInfra('chest', chest.position); return chest }
  // Reuse the site chest we REMEMBER (tight radius - the stash chest belongs at the site).
  const knownC = await recallAndReach(bot, 'chest', chestId, 24, async () => true)
  if (knownC) { rememberInfra('chest', knownC.position); return knownC }
  if (countItem(bot, 'chest') === 0) {
    const table = await P().ensureTable(bot, opts)
    // Unified navigator (door pre-flight crosses into the hut if the table's inside); tight at-base budgets.
    if (bot.entity.position.distanceTo(table.position) > 3) { try { await navigate.navigateTo(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 0, nudge: 1, stepout: 1 }, label: 'chest-table-reach' }) } catch {} }
    const recipe = bot.recipesFor(mcData.itemsByName.chest.id, null, 1, table)[0]
    if (!recipe) throw new Error('cannot craft a chest (need 8 planks)')
    await bot.craft(recipe, 1, table)
    await new Promise(r => setTimeout(r, 250))
  }
  // BELIEVABILITY: at the hut, place the chest on a valid INTERIOR floor cell (reachable
  // through the door), not floating outside a wall. Falls back to local placement elsewhere.
  const inside = await placeStationInInterior(bot, 'chest', 'chest', { hut: opts.home, isStopped: opts.isStopped })
  if (inside) return inside
  await S().placeFromInventory(bot, 'chest')
  chest = bot.findBlock({ matching: chestId, maxDistance: 6 })
  if (!chest) throw new Error('placed a chest but cannot find it')
  rememberInfra('chest', chest.position)
  return chest
}

async function placeChestOriented (bot, target, want, opts = {}) {
  const off = FACING_OFF[want]
  const item = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  if (!off || !item()) return false
  const floor = bot.blockAt(target.offset(0, -1, 0))
  if (!floor || floor.boundingBox !== 'block' || /chest/.test(floor.name)) return false
  for (const sign of [1, -1]) { // stand on the facing side; one flip retry
    if (!item()) return false
    const stand = target.offset(off[0] * sign, 0, off[1] * sign)
    const clear = b => b && b.boundingBox !== 'block'
    const f = bot.blockAt(stand); const h = bot.blockAt(stand.offset(0, 1, 0)); const g = bot.blockAt(stand.offset(0, -1, 0))
    if (!(clear(f) && clear(h) && g && g.boundingBox === 'block')) { dbg('  orientedChest: no standing room ' + want + (sign < 0 ? '-flipped' : '') + ' of ' + target); continue }
    try {
      // door-assist approach: the stand cell is INSIDE the hut and a raw goto can't plan
      // through the closed door (live: the heal's re-place silently failed from outside)
      const nav = require('./navigate.js')
      await nav.navigateTo(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 0, water: 0, nudge: 1, stepout: 1 }, label: 'chest-stand' })
    } catch (e) { dbg('  orientedChest: cannot reach the stand cell ' + stand + ' (' + e.message + ')'); continue }
    const cur = bot.blockAt(target)
    if (cur && /chest/.test(cur.name)) return false // filled meanwhile
    try {
      await bot.equip(item(), 'hand')
      await bot.lookAt(target.offset(0.5, -0.4, 0.5), true) // down through the target cell at the floor
      await bot.placeBlock(floor, new Vec3(0, 1, 0))
    } catch (e) { dbg('  orientedChest: place failed (' + e.message + ')'); return false }
    await new Promise(r => setTimeout(r, 350))
    const b = bot.blockAt(target)
    if (!b || !/chest/.test(b.name)) return false
    let got = null; try { got = (b.getProperties() || {}).facing } catch {}
    if (got === want) return true
    dbg('  orientedChest: landed facing ' + got + ' (wanted ' + want + ') - taking it back, flipping sides')
    try { await bot.dig(b); await collectDrops(bot, 3) } catch { return false }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

async function healBankDouble (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const list = listInfra('chest', bot).filter(e => insideHutBox(e, hut))
  if (!list.length) return false
  const blkOf = e => bot.blockAt(new Vec3(e.x, e.y, e.z))
  const prop = (b, k) => { try { return (b.getProperties() || {})[k] } catch { return null } }
  let pair = null
  for (const a of list) {
    const b = list.find(o => o !== a && o.y === a.y && Math.abs(o.x - a.x) + Math.abs(o.z - a.z) === 1)
    if (b) { pair = [a, b]; break }
  }
  if (!pair) {
    // The other half STANDS in the world but fell out of infra memory (the schematic
    // rebuild registers only ONE chest cell; an aborted heal forgets the half it dug,
    // live: 418,66,87 west stood unregistered while the model saw a lone single). An
    // adjacent standing chest inside the bot's own hut IS the bank's other half - adopt
    // it back into the registry.
    for (const a of list) {
      for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const cell = { x: a.x + dx, y: a.y, z: a.z + dz }
        if (!insideHutBox(cell, hut)) continue
        const cb = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
        if (cb && /chest$/.test(cb.name)) {
          rememberInfra('chest', new Vec3(cell.x, cell.y, cell.z))
          dbg('bank heal: adopted the unregistered half at ' + cell.x + ',' + cell.y + ',' + cell.z + ' back into the registry')
          pair = [a, cell]; break
        }
      }
      if (pair) break
    }
  }
  if (!pair && list.length === 1 && (bot.inventory ? bot.inventory.items() : []).some(i => i.name === 'chest')) {
    // HALF THE BANK IS IN THE PACK (an aborted heal dug it and could not re-place, live
    // 05:44): adopt the free adjacent interior cell as the missing half - the loop below
    // places it oriented and re-registers it.
    const a = list[0]
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const cell = { x: a.x + dx, y: a.y, z: a.z + dz }
      if (!insideHutBox(cell, hut)) continue
      const cb = bot.blockAt(new Vec3(cell.x, cell.y, cell.z)); const fl = bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z))
      if (cb && AIRISH(cb.name) && fl && fl.boundingBox === 'block') { pair = [a, cell]; dbg('bank heal: missing half is in my pack - restoring it at ' + cell.x + ',' + cell.y + ',' + cell.z); break }
    }
  }
  if (!pair) return false
  const [A, B] = pair.map(blkOf)
  const chestish = b => b && /chest$/.test(b.name)
  const airish = b => !b || AIRISH(b.name)
  if (!(chestish(A) || airish(A)) || !(chestish(B) || airish(B))) return false
  if (chestish(A) && chestish(B) && (prop(A, 'type') !== 'single' || prop(B, 'type') !== 'single')) return false // already merged
  // shared facing PERPENDICULAR to the pair axis, on a side with interior standing room
  const axisZ = pair[0].x === pair[1].x
  let want = null
  for (const w of (axisZ ? ['west', 'east'] : ['north', 'south'])) {
    const off = FACING_OFF[w]
    const ok = pair.every(e => {
      const s = new Vec3(e.x + off[0], e.y, e.z + off[1])
      const f = bot.blockAt(s); const g = bot.blockAt(s.offset(0, -1, 0))
      return f && f.boundingBox !== 'block' && g && g.boundingBox === 'block'
    })
    if (ok) { want = w; break }
  }
  if (!want) { dbg('bank heal: no standable shared facing side - leaving the pair as-is'); return false }
  dbg('bank heal: two SINGLE chests at ' + pair.map(e => e.x + ',' + e.y + ',' + e.z).join(' + ') + ' - re-facing both ' + want + ' to merge them')
  for (const e of pair) {
    if (isStopped()) return false
    let b = blkOf(e)
    const missing = airish(b) // this half is in the pack (aborted earlier heal) - just place it
    if (!missing && !/chest$/.test(b.name)) return false
    if (!missing && prop(b, 'facing') === want) continue // this half is already right
    if (!missing) {
      // 1a) SHUTTLE the bulk into the OTHER half first - the pack alone can't hold a
      //     full bank (live: 871 items in one half), and the treasury must never sit
      //     in a dropped pile. withdraw -> deposit trips, bounded.
      const other = pair.find(o => o !== e)
      const otherBlk = () => { const ob = other && blkOf(other); return ob && /chest$/.test(ob.name) ? ob : null }
      if (otherBlk()) {
        for (let trip = 0; trip < 8; trip++) {
          let counts = {}
          try { counts = await chestCounts(bot, blkOf(e)) } catch { break }
          const names = Object.keys(counts)
          if (!names.length) break
          for (const n of names) {
            if ((bot.inventory ? bot.inventory.emptySlotCount() : 0) < 3) break
            try { await withdrawItem(bot, blkOf(e), n, counts[n]) } catch {}
          }
          if (!otherBlk()) break
          try { await depositMaterials(bot, otherBlk(), { all: true, keepDirt: 0 }) } catch (err) { dbg('bank heal: shuttle deposit failed (' + err.message + ')'); break }
        }
      }
      // 1b) empty the remainder into the pack (verified) - never dig a chest with anything inside
      try {
        const counts = await chestCounts(bot, b)
        for (const n of Object.keys(counts)) { await withdrawItem(bot, blkOf(e), n, counts[n]) }
      } catch (err) { dbg('bank heal: empty failed (' + err.message + ') - aborting'); return false }
      let left = {}
      try { left = await chestCounts(bot, blkOf(e)) } catch { left = { unknown: 1 } }
      if (Object.keys(left).length) {
        dbg('bank heal: chest still holds ' + Object.keys(left).join(',') + ' (pack full?) - aborting, nothing lost')
        return false
      }
      // 2) dig + re-place oriented + re-register
      forgetInfra('chest', listInfra('chest').find(x => x.x === e.x && x.y === e.y && x.z === e.z))
      try { await bot.dig(blkOf(e)); await collectDrops(bot, 3) } catch (err) { dbg('bank heal: dig failed (' + err.message + ')'); return false }
    }
    if (!await placeChestOriented(bot, new Vec3(e.x, e.y, e.z), want, opts)) {
      dbg('bank heal: oriented re-place failed - putting a chest back plainly so the bank cell is not lost')
      try { await placeAt(bot, new Vec3(e.x, e.y, e.z), /^chest$/) } catch {}
    }
    const nb = blkOf(e)
    if (!nb || !/chest$/.test(nb.name)) { dbg('bank heal: chest did not go back at ' + e.x + ',' + e.y + ',' + e.z + ' - it is in my pack, next camp pass retries'); return false }
    rememberInfra('chest', new Vec3(e.x, e.y, e.z))
    // 3) put the goods back (working set stays on the bot as usual)
    try { await depositMaterials(bot, nb, { keepDirt: 8 }) } catch (err) { dbg('bank heal: redeposit failed (' + err.message + ') - items safe in my pack') }
  }
  const [A2, B2] = pair.map(blkOf)
  const merged = A2 && B2 && /chest$/.test(A2.name) && /chest$/.test(B2.name) &&
    prop(A2, 'type') !== 'single' && prop(B2, 'type') !== 'single'
  dbg('bank heal: pair now reads ' + (merged ? 'CONNECTED DOUBLE (' + prop(A2, 'type') + '/' + prop(B2, 'type') + ')' : 'still not merged'))
  return !!merged
}

async function chestCounts (bot, chestBlock) {
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  const out = {}
  try { for (const i of chest.containerItems()) out[i.name] = (out[i.name] || 0) + i.count } finally { chest.close() }
  return out
}

async function depositMaterials (bot, chestBlock, opts = {}) {
  const keepDirt = opts.keepDirt || 0
  const keepRe = opts.all ? S().KEEP_WHEN_ALL : P().KEEP_ON_BOT
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  let n = 0
  try {
    if (opts.deposits) {
      // EXPLICIT-LIST mode (S6 courier/safekeep): deposit EXACTLY the named counts and IGNORE
      // the keep regexes - P().KEEP_ON_BOT/S().KEEP_WHEN_ALL would otherwise pin food/planks on the bot
      // forever (the pure courierPlan/safekeepPlan already decided what is safe to move). The
      // regex modes below stay byte-identical for every existing caller (opts.deposits absent).
      const want = new Map()
      for (const d of opts.deposits) { if (d && d.name && d.count > 0) want.set(d.name, (want.get(d.name) || 0) + d.count) }
      for (const [name, cnt] of want) {
        let remaining = cnt
        for (const it of bot.inventory.items()) {
          if (remaining <= 0) break
          if (it.name !== name) continue
          const take = Math.min(remaining, it.count)
          try { await chest.deposit(it.type, null, take); n += take; remaining -= take } catch { /* chest full / slot race */ }
        }
      }
    } else {
      for (const it of bot.inventory.items()) {
        if (keepRe.test(it.name)) continue
        let count = it.count
        if (it.name === 'dirt' && keepDirt) count = Math.max(0, it.count - keepDirt)
        if (count <= 0) continue
        try { await chest.deposit(it.type, null, count); n += count } catch { /* chest full / slot race */ }
      }
    }
  } finally { chest.close() }
  return n
}

async function withdrawItem (bot, chestBlock, itemName, count) {
  const mcData = require('minecraft-data')(bot.version)
  const def = mcData.itemsByName[itemName]
  if (!def || count <= 0) return 0
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  let got = 0
  try {
    const have = chest.containerItems().filter(i => i.name === itemName).reduce((a, b) => a + b.count, 0)
    const take = Math.min(count, have)
    if (take > 0) { await chest.withdraw(def.id, null, take); got = take }
  } finally { chest.close() }
  return got
}

async function migrateChestInto (bot, oldPos, hut, { isStopped = () => false, say = () => {} } = {}) {
  // WALL-HUGGING interior cells (operator: "why did it place its chest in the middle") -
  // the centre [2,2] stays walkable; corners/edges first. Collect free cells, then find
  // an adjacent PAIR for a DOUBLE chest (operator: "make it a double chest for more space").
  const interior = []
  const order = [[1, 1], [1, 3], [3, 1], [3, 3], [1, 2], [2, 1], [2, 3], [3, 2]] // corners then edges, NEVER [2,2]
  for (const [dx, dz] of order) {
    for (let dy = 0; dy <= 3; dy++) {
      const p = new Vec3(hut.x + dx, hut.y + dy, hut.z + dz)
      const b = bot.blockAt(p); const below = bot.blockAt(p.offset(0, -1, 0)); const above = bot.blockAt(p.offset(0, 1, 0))
      if (b && AIRISH(b.name) && below && below.boundingBox === 'block' && above && AIRISH(above.name)) { interior.push(p); break }
    }
  }
  if (!interior.length) { dbg('  chest migration: no free interior cell in the hut'); return false }
  let target = interior[0]; let target2 = null
  for (const a of interior) { // a same-y neighbour makes the two chests merge into a double
    const n = interior.find(o => o.y === a.y && Math.abs(o.x - a.x) + Math.abs(o.z - a.z) === 1)
    if (n) { target = a; target2 = n; break }
  }
  let chestItem = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  const chestCount = () => countItem(bot, 'chest')
  if (chestCount() < 2) { // want TWO for the double chest
    try { await P().runCraft(bot, 'chest', 2 - chestCount(), true, { isStopped, home: { x: hut.x, y: hut.y, z: hut.z } }) } catch (e) { dbg('  chest migration: cannot craft chests (' + e.message + ')') }
    chestItem = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  }
  if (!chestItem) { dbg('  chest migration: no chest to place'); return false }
  if (bot.entity.position.distanceTo(target) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(target.x, target.y, target.z, 2), 20000) } catch {} }
  if (!await placeAt(bot, target, /^chest$/)) { dbg('  chest migration: could not place inside - ' + (placeAt.lastFail || '?')); return false }
  const newBlk = bot.blockAt(target)
  if (!newBlk || !/chest/.test(newBlk.name)) return false
  rememberInfra('chest', target)
  // second half of the double chest, if we have a pair-cell and a spare chest
  if (target2 && chestCount() >= 1) {
    if (bot.entity.position.distanceTo(target2) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(target2.x, target2.y, target2.z, 2), 15000) } catch {} }
    if (await placeAt(bot, target2, /^chest$/)) { const b2 = bot.blockAt(target2); if (b2 && /chest/.test(b2.name)) { rememberInfra('chest', target2); dbg('  chest migration: double chest placed') } }
  }
  say('moving the bank into the hut where creepers cannot audit it')
  let trips = 0
  while (!isStopped() && trips++ < 6) {
    const oldBlk = bot.blockAt(new Vec3(oldPos.x, oldPos.y, oldPos.z))
    if (!oldBlk || !/chest/.test(oldBlk.name)) break
    let counts
    try { counts = await chestCounts(bot, oldBlk) } catch (e) { dbg('  chest migration: old chest read failed (' + e.message + ')'); break }
    const names = Object.keys(counts)
    if (!names.length) break
    for (const n of names) {
      if ((bot.inventory ? bot.inventory.emptySlotCount() : 36) < 2) break
      try { await withdrawItem(bot, oldBlk, n, counts[n]) } catch {}
    }
    try { await depositMaterials(bot, bot.blockAt(target), { keepDirt: 8 }) } catch (e) { dbg('  chest migration: deposit failed (' + e.message + ')') }
  }
  const oldBlk2 = bot.blockAt(new Vec3(oldPos.x, oldPos.y, oldPos.z))
  let left = {}
  if (oldBlk2 && /chest/.test(oldBlk2.name)) { try { left = await chestCounts(bot, oldBlk2) } catch { left = { unknown: 1 } } }
  if (oldBlk2 && /chest/.test(oldBlk2.name) && !Object.keys(left).length) {
    try {
      const tool = toolForBlock(bot, 'oak_planks')
      if (tool) await bot.equip(tool, 'hand').catch(() => {})
      await bot.dig(oldBlk2); await collectDrops(bot, 4)
      const entry = listInfra('chest').find(e => e.x === Math.floor(oldPos.x) && e.y === Math.floor(oldPos.y) && e.z === Math.floor(oldPos.z))
      if (entry) forgetInfra('chest', entry)
      say('bank moved - old chest packed up')
    } catch (e) { dbg('  chest migration: old chest pickup failed (' + e.message + ')') }
  } else if (Object.keys(left).length) dbg('  chest migration: old chest NOT empty after trips - leaving it standing')
  return true
}

async function consolidateBank (bot, hut, { isStopped = () => false, say = () => {}, radius = 64 } = {}) {
  const chests = listInfra('chest', bot)
  const bank = chests.find(e => ownHutAt({ x: e.x, y: e.y, z: e.z }))
  if (!bank) { dbg('  consolidate: no bank chest inside the hut yet'); return 0 }
  const bankBlk = () => bot.blockAt(new Vec3(bank.x, bank.y, bank.z))
  const bb0 = bankBlk()
  if (!bb0 || !/chest/.test(bb0.name)) { dbg('  consolidate: bank cell does not hold a chest'); return 0 }
  let consolidated = 0
  for (const e of chests) {
    if (isStopped()) break
    if (ownHutAt({ x: e.x, y: e.y, z: e.z })) continue // the bank itself / its double half
    if (Math.hypot(e.x - hut.x, e.z - hut.z) > radius) continue
    const blk = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (!blk || !/chest/.test(blk.name)) continue // unloaded or pruned - a later pass gets it
    dbg('  consolidate: ferrying field chest at ' + e.x + ',' + e.y + ',' + e.z + ' into the bank')
    say('moving a field chest into the bank')
    let trips = 0
    while (!isStopped() && trips++ < 6) {
      const ob = bot.blockAt(new Vec3(e.x, e.y, e.z))
      if (!ob || !/chest/.test(ob.name)) break
      let counts
      try { counts = await chestCounts(bot, ob) } catch (err) { dbg('  consolidate: field chest read failed (' + err.message + ')'); break }
      if (!Object.keys(counts).length) break
      for (const n of Object.keys(counts)) {
        if ((bot.inventory ? bot.inventory.emptySlotCount() : 36) < 2) break
        try { await withdrawItem(bot, ob, n, counts[n]) } catch {}
      }
      const bb = bankBlk()
      if (!bb || !/chest/.test(bb.name)) { dbg('  consolidate: bank vanished mid-ferry - stopping'); return consolidated }
      try { await depositMaterials(bot, bb, { keepDirt: 8, all: true }) } catch (err) { dbg('  consolidate: bank deposit failed (' + err.message + ')') }
    }
    // remove the old chest only once it verifies EMPTY (world re-read is the arbiter)
    const ob2 = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (ob2 && /chest/.test(ob2.name)) {
      let left = { unknown: 1 }
      try { left = await chestCounts(bot, ob2) } catch {}
      if (!Object.keys(left).length) {
        try {
          await bot.dig(ob2); await collectDrops(bot, 4)
          forgetInfra('chest', e)
          consolidated++
          dbg('  consolidate: field chest at ' + e.x + ',' + e.z + ' emptied + packed up')
        } catch (err) { dbg('  consolidate: empty chest pickup failed (' + err.message + ')') }
      } else dbg('  consolidate: field chest not empty after trips - leaving it standing (pack full?)')
    } else { forgetInfra('chest', e); consolidated++ }
    // bank whatever the ferry left in the pack before moving to the next chest
    try { const bb = bankBlk(); if (bb && /chest/.test(bb.name)) await depositMaterials(bot, bb, { keepDirt: 8, all: true }) } catch {}
  }
  if (consolidated) say(`bank consolidated - ${consolidated} field chest(s) moved into the hut`)
  return consolidated
}

function ownInfraCells () {
  const infra = (loadWorldMem().infra || {})
  const set = new Set()
  for (const kind of Object.keys(infra)) {
    for (const e of (infra[kind] || [])) {
      if (e && Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)) set.add(Math.floor(e.x) + ',' + Math.floor(e.y) + ',' + Math.floor(e.z))
    }
  }
  return set
}

function lonelyFurnace (readBlock, cell, ownCells) {
  const own = ownCells instanceof Set ? ownCells : new Set(ownCells || [])
  const cx = Math.floor(cell.x); const cy = Math.floor(cell.y); const cz = Math.floor(cell.z)
  const R = 5
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        if (dx * dx + dy * dy + dz * dz > R * R) continue
        const x = cx + dx; const y = cy + dy; const z = cz + dz
        if (x === cx && y === cy && z === cz) continue // (a) the furnace cell itself
        const b = readBlock(x, y, z)
        if (!b || !b.name) continue // air / unloaded / natural - fine
        if (!STRUCTURE_RE.test(b.name)) continue // natural terrain - fine
        if (/torch/.test(b.name)) continue // (c) own smelt-camp lighting - a torch alone isn't a base
        if (own.has(x + ',' + y + ',' + z)) continue // (b) own remembered infra next to the camp furnace
        return false // player-built structure block adjacent - never reclaim this furnace
      }
    }
  }
  return true
}

async function consolidateFurnaces (bot, { isStopped = () => false, say = () => {} } = {}) {
  const home = hutAnchor()
  if (!home) return 0
  const KEEP_R = Number(process.env.FURNACE_KEEP_R || 32) // keep the in-hut + utility-pad (hut+9,+9) furnaces
  const MAX_R = Number(process.env.FURNACE_MAX_R || 96) // travel bound
  const cands = listInfra('furnace', bot)
    .map(e => ({ e, d: Math.hypot(e.x - home.x, e.z - home.z) }))
    .filter(o => o.d > KEEP_R && o.d <= MAX_R)
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
  if (!cands.length) return 0
  const own = ownInfraCells()
  let reclaimed = 0
  for (const { e } of cands) {
    if (isStopped()) break
    // Walk there first so the chunk loads (recallAndReach pattern, provision.js recallAndReach).
    try { await S().walkStaged(bot, e.x, e.z, { range: 10, timeoutMs: 60000, isStopped }) } catch { continue } // unreachable - keep the entry, retry a later pass
    if (isStopped()) break
    // RE-VERIFY at dig time: the block IS a furnace (exact - stricter than INFRA_BLOCK's
    // /furnace$/, so a player's blast_furnace never qualifies). Not a furnace => forget, NEVER dig.
    const b = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (!(b && b.name === 'furnace')) { forgetInfra('furnace', e); continue }
    // ELIGIBILITY (now that the chunk is loaded): own-tagged (bot provably placed it) OR the
    // lonely-furnace structure scan passes (nothing player-built within 5). Else skip forever.
    const eligible = e.own === true || lonelyFurnace((x, y, z) => bot.blockAt(new Vec3(x, y, z)), e, own)
    if (!eligible) { dbg('  consolidateFurnaces: furnace at ' + e.x + ',' + e.z + ' is near a build - leaving it'); continue }
    if (bot.entity.position.distanceTo(b.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(e.x, e.y, e.z, 2), 20000) } catch { continue } }
    const tool = toolForBlock(bot, 'stone') // wrong-tool digs drop NOTHING
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) continue
    try {
      await bot.dig(b)
      await collectDrops(bot, 4) // breaking a furnace also drops its contents
      forgetInfra('furnace', e)
      reclaimed++
      dbg('  consolidateFurnaces: reclaimed a field furnace at ' + e.x + ',' + e.y + ',' + e.z + ' (' + Math.round(Math.hypot(e.x - home.x, e.z - home.z)) + 'b out)')
    } catch (err) { dbg('  consolidateFurnaces: dig failed at ' + e.x + ',' + e.z + ' (' + err.message + ')') }
  }
  return reclaimed
}

async function litterPatrol (bot, home, { isStopped = () => false, say = () => {} } = {}) {
  const R = Number(process.env.LITTER_PATROL_R || 64)
  const now = Date.now()
  const hb = hutAnchor()
  // Hut box + 2-margin: the apron's self-placed dirt must never be shaved.
  const inHutApron = p => {
    if (ownHutAt(p)) return true
    if (!hb) return false
    const m = 2
    return p.x >= hb.x - m && p.x <= hb.x + 5 + m && p.z >= hb.z - m && p.z <= hb.z + 5 + m
  }
  const spots = scaffold.near(home, R).filter(s => (now - s.t > 600000) && !inHutApron(s)) // older than 10 min, not the hut apron
  if (!spots.length) return 0
  // Pick the densest cluster (most registry neighbors within 8; ties: oldest).
  const neighbors = s => spots.reduce((n, o) => n + (Math.hypot(o.x - s.x, o.z - s.z) <= 8 ? 1 : 0), 0)
  spots.sort((a, b) => (neighbors(b) - neighbors(a)) || (a.t - b.t))
  const spot = spots[0]
  try { await gotoWithTimeout(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 3), 45000) } catch {}
  let removed = 0
  try {
    const r = await scaffold.teardownVerified(bot, spot, { radius: 16, max: 48, maxPasses: 3, isStopped, exclude: p => !!ownHutAt(p) })
    removed = (r && r.removed) || 0
  } catch (e) { dbg('  litterPatrol: teardown failed (' + e.message + ')') }
  try { await collectDrops(bot, 8) } catch {}
  return removed
}

module.exports = {
  setDebugSink,
  FACING_OFF, resolveBankCell, isBankStand, bankStandFor, gotoChest, placeStationInInterior, ensureChest, placeChestOriented, healBankDouble, chestCounts, depositMaterials, withdrawItem, migrateChestInto, consolidateBank, ownInfraCells, lonelyFurnace, consolidateFurnaces, litterPatrol
}
