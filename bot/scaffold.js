'use strict'
// SCAFFOLD MANAGER: the one owner of "blocks I placed to move/reach", as distinct from
// blocks that are supposed to STAY (build fabric, shelter walls). The pathfix trail
// remembers every placement (safety net: dig-guard, don't-plant-on-own-blocks); THIS
// registry remembers only the temporary ones, with purpose and time, so teardown can be
// deterministic near a build without ever chewing the build itself - FILLER_RE alone
// couldn't tell a scaffold tower from a fresh cobblestone castle wall.
//
// How entries get in:
//  - a SESSION brackets pathfinder-driven movement (navigate.gotoOnce wraps every goto):
//    any block the lib places while executing a goto is by definition movement scaffold -
//    build fabric is placed AFTER the goto completes, outside the bracket.
//  - explicit add() from the manual placers (pillarUpTo's tower blocks).
// pathfix's verifiedPlace calls onPlaced() for every world-verified placement; we file
// it only when a session is open.

const fs = require('fs')
const path = require('path')

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[scaffold] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// Retention: with INFRA_CONSOLIDATE on, own-scaffold memory survives 72h (env-tunable) so the
// far-pillar litter patrol can still claim towers that outlive a 6h window; flag off => 6h
// exactly (byte-equivalent to fd90c9f). Longer retention is a POSITIVE own-block permission
// (isScaffold/teardown only ever act on cells WE registered), so widening it never risks a
// player block - the only cost is registry size, bounded by the sweep() cap guard below.
const MAX_AGE_MS = process.env.INFRA_CONSOLIDATE !== '0'
  ? Number(process.env.SCAFFOLD_MAX_AGE_MS || 72 * 3600 * 1000)
  : 6 * 3600 * 1000 // registry entries older than this are landscape now
const FILE = process.env.SCAFFOLD_FILE || path.join(__dirname, 'scaffold-registry.json')
const reg = new Map() // "x,y,z" -> { t, purpose }
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const cut = Date.now() - MAX_AGE_MS
  for (const [k, v] of Object.entries(saved)) { if (v && v.t >= cut) reg.set(k, v) }
} catch {}
let saveTimer = null
function save () {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try { fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(reg))) } catch {}
  }, 2000)
}
function key (p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` }
const AIR_RE = /^(air|cave_air|void_air)$/
const isShaft = (v) => !!v && v.purpose === 'shaft'
function sweep () {
  const cut = Date.now() - MAX_AGE_MS
  for (const [k, v] of reg) { if (v.t < cut) reg.delete(k) }
  // CAP GUARD (flag-on only): a 72h retention window can outgrow the registry if the age cut
  // frees nothing. Evict OLDEST-first down to 512 so memory stays bounded. Flag off => this is
  // skipped and sweep() age-culls exactly as fd90c9f did (byte-equivalent).
  // #111: PLACED blocks are evicted before SHAFT DEBT. Forgetting a block we placed loses a
  // chore; forgetting a hole we dug loses the only record that the hole is ours to fill.
  if (process.env.INFRA_CONSOLIDATE !== '0' && reg.size > 512) {
    const byAge = [...reg.entries()].sort((a, b) => (isShaft(a[1]) - isShaft(b[1])) || (a[1].t - b[1].t))
    for (let i = 0; i < byAge.length && reg.size > 512; i++) reg.delete(byAge[i][0])
  }
  save()
}

// ---- sessions -----------------------------------------------------------------
const sessions = [] // stack of purpose strings; any open session tags placements
function beginSession (purpose) { sessions.push(purpose || 'move') }
function endSession () { sessions.pop() }
async function inSession (purpose, fn) {
  beginSession(purpose)
  try { return await fn() } finally { endSession() }
}

// ---- writes ---------------------------------------------------------------------
function add (pos, purpose) {
  reg.set(key(pos), { t: Date.now(), purpose: purpose || 'scaffold' })
  if (reg.size > 512) sweep()
  save()
}
// called by pathfix.verifiedPlace on EVERY world-verified placement
function onPlaced (pos) {
  if (!sessions.length) return
  add(pos, sessions[sessions.length - 1])
}
function forget (pos) { reg.delete(key(pos)); save() }

// ---- ESCAPE COMMITMENTS: the cells we DUG (#111) --------------------------------------
// The registry remembered only blocks we PLACED. Cells the bot DIGS to escape are committed
// world state exactly the same way, and nothing recorded them - so the 5-block void a climb
// cut at 459,-91, left under its own floating topsoil, was not merely unhealed but
// UNNAMEABLE. This is the dig side of the same ledger: `was` is the block that used to fill
// the cell, so a later reclaim pass can settle the debt with coarsely-matching material.
//
// A shaft entry is DEBT, not scaffold. It is deliberately invisible to isScaffold() (there is
// nothing there to grant dig permission over) and to near() (teardown must never see an
// air cell as a candidate - it would "repurposed, already gone" the debt straight out of the
// registry). Readers who want debts ask for them by name.
function oweShaft (pos, wasName) {
  if (!wasName || AIR_RE.test(String(wasName))) return
  const k = key(pos)
  const prev = reg.get(k)
  if (prev && isShaft(prev)) return // idempotent - keep the ORIGINAL block name, not a re-dig's
  reg.set(k, { t: Date.now(), purpose: 'shaft', was: String(wasName) })
  if (reg.size > 512) sweep()
  save()
}
// Outstanding dug-cell debt near a point (the reclaim job's read side).
function shaftDebts (pos, r, maxAgeMs) {
  const out = []
  const cut = Date.now() - (maxAgeMs || MAX_AGE_MS)
  for (const [k, v] of reg) {
    if (!isShaft(v) || v.t < cut) continue
    const [x, y, z] = k.split(',').map(Number)
    if (r == null || Math.hypot(x - pos.x, z - pos.z) <= r) out.push({ x, y, z, t: v.t, was: v.was })
  }
  return out
}
function settleShaft (pos) { const v = reg.get(key(pos)); if (isShaft(v)) { reg.delete(key(pos)); save() } }

// ---- reads -----------------------------------------------------------------------
function isScaffold (pos, maxAgeMs) {
  const e = reg.get(key(pos))
  return !!e && !isShaft(e) && e.t >= Date.now() - (maxAgeMs || MAX_AGE_MS) // a dug cell is debt, not a block we may break
}
function near (pos, r, maxAgeMs, opts = {}) {
  const out = []
  const cut = Date.now() - (maxAgeMs || MAX_AGE_MS)
  for (const [k, v] of reg) {
    if (v.t < cut) continue
    if (isShaft(v) && !opts.includeShafts) continue // debts are not teardown candidates
    const [x, y, z] = k.split(',').map(Number)
    if (Math.hypot(x - pos.x, z - pos.z) <= r) out.push({ x, y, z, t: v.t, purpose: v.purpose })
  }
  return out
}
function count () { return reg.size }

// #56 FARM_EXCLUDE_YFIX: is `pos` inside our own wheat-farm footprint (a crop cell / its farmland /
// the block just above one)? scaffold.js had NO farm awareness (design §D), so a manual scaffold/
// pillar placer could brick over the crops the pathfinder's cropPlaceExclusion already avoids.
// Lazy-consults provision's wheatFarm memory; false on any error / flag off. Callers gate placement.
function onFarmFootprint (pos) {
  try { return require('./provision.js').farmFootprintHas(pos) } catch { return false }
}

// ---- filler policy -----------------------------------------------------------------
// Dirt FIRST: cobble towers read as stone litter and the leveler has to shave them;
// dirt pockets back into scaffold supply. One policy for every scaffold placer.
const FILLER_RE = /^(cobblestone|dirt|coarse_dirt|stone|gravel|andesite|diorite|granite|cobbled_deepslate|netherrack|tuff|deepslate)$/
function pickFiller (bot) {
  const items = bot.inventory ? bot.inventory.items() : []
  return items.find(i => /^(dirt|coarse_dirt)$/.test(i.name)) || items.find(i => FILLER_RE.test(i.name))
}

// ---- teardown -----------------------------------------------------------------------
// Ride the towers back down and pocket the filler. Registry-driven and double-gated:
// only cells WE registered, and only if the world still shows a filler block there
// (anything else means the cell got repurposed - drop the entry, never dig).
// opts.alsoTrail: additionally sweep the pathfix trail (legacy/untagged towers) - safe
// ONLY away from builds, since the trail remembers build fabric too.
async function teardown (bot, around, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const radius = opts.radius || 12
  const { Vec3 } = require('vec3')
  const { goals } = require('mineflayer-pathfinder')
  const provision = require('./provision.js') // lazy: toolForBlock lives there
  let spots = near(around, radius)
  if (opts.alsoTrail) {
    try {
      const pf = require('./pathfix.js')
      const seen = new Set(spots.map(s => `${s.x},${s.y},${s.z}`))
      for (const p of (pf.selfPlacedNear(around, radius) || [])) {
        const k = `${p.x},${p.y},${p.z}`
        if (!seen.has(k)) { seen.add(k); spots.push(p) }
      }
    } catch {}
  }
  if (!spots.length) return 0
  // COLUMN INTEGRITY (#111). This loop used to sort top-down and then treat every cell
  // INDEPENDENTLY: any cell it could not reach was `continue`d while the reachable cells
  // below it were dug. Applied to a column - which is the shape almost all of this litter
  // has - that does not "make partial progress", it deterministically AMPUTATES THE BASE and
  // strands the top where nothing can ever reach it again. The floating dirt plug over a
  // 5-block void at 459,-91 is the guaranteed end state of cell-independent teardown, not
  // bad luck. INVARIANT: a cell may not be removed while a registered cell still stands above
  // it in the same column. A column is dismantled strictly top-down, riding it down; the
  // moment one of its cells cannot be removed the WHOLE column is abandoned and stays on the
  // books as debt. Amputating a base to show a number is forbidden - progress that
  // manufactures an unreachable floater is negative progress.
  const cols = new Map()
  for (const p of spots) {
    const ck = Math.floor(p.x) + ',' + Math.floor(p.z)
    if (!cols.has(ck)) cols.set(ck, [])
    cols.get(ck).push(p)
  }
  const columns = [...cols.values()]
  for (const c of columns) c.sort((a, b) => b.y - a.y) // top-down within the column
  columns.sort((a, b) => b[0].y - a[0].y)              // tallest tops first (the old global order)
  const budget = opts.max || 32
  let considered = 0
  let removed = 0
  const abandon = (col, at, why) => dbg('column ' + Math.floor(col[0].x) + ',' + Math.floor(col[0].z) + ': ' + why + ' at y' + at + ' - leaving the whole column standing (' + col.length + ' cell(s) still owed) rather than stranding what is above it')
  for (const col of columns) {
    if (isStopped() || considered >= budget) break
    for (const p of col) {
      if (isStopped() || considered >= budget) break
      considered++
      if (opts.exclude && opts.exclude(p)) { abandon(col, p.y, 'a cell is excluded (owned by a build)'); break } // e.g. cells the schematic owns
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
      if (!b) { abandon(col, p.y, 'UNKNOWN cell (chunk not loaded)'); break } // a null is not "already gone" - fail closed, keep the debt
      if (!FILLER_RE.test(b.name)) { forget(p); continue } // repurposed: nothing of ours here to strand
      if (bot.entity.position.distanceTo(b.position) > 4.5) {
        try { await require('./navigate.js').gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 3), 8000) } catch {}
        // goto reports success on paths it never walked - the arrival claim is the re-read distance
        if (bot.entity.position.distanceTo(b.position) > 4.5) { abandon(col, p.y, 'cannot reach it'); break }
      }
      const tool = provision.toolForBlock ? provision.toolForBlock(bot, b.name) : null // wrong-tool digs drop NOTHING (hoe-dug scaffold vanished, live)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(b)) { abandon(col, p.y, 'cannot dig it'); break }
      let dug = false
      try { await bot.dig(b); dug = true } catch {}
      if (!dug) { abandon(col, p.y, 'the dig failed'); break }
      removed++; forget(p); await new Promise(r => setTimeout(r, 150))
    }
  }
  if (removed) dbg('tore down ' + removed + ' scaffold block(s) near ' + Math.round(around.x) + ',' + Math.round(around.z) + ' (' + reg.size + ' registered left)')
  return removed
}

// VERIFIED teardown: run teardown, then RE-READ the registry-tracked cells and re-run until
// none still show a filler block in the world (the huttidy "until clean" postcondition) or a
// pass makes no progress. Returns { ok, passes, removed, remaining }.
async function teardownVerified (bot, around, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const radius = opts.radius || 12
  const maxPasses = opts.maxPasses || 4
  const { Vec3 } = require('vec3')
  const stillFiller = () => near(around, radius).filter(p => {
    if (opts.exclude && opts.exclude(p)) return false
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
    return b && FILLER_RE.test(b.name)
  })
  let removed = 0; let pass = 0
  for (pass = 1; pass <= maxPasses && !isStopped(); pass++) {
    if (!stillFiller().length) break
    const r = await teardown(bot, around, opts)
    removed += r
    if (r === 0) break // no progress - the rest is unreachable/protected
  }
  const remaining = stillFiller().length
  dbg('teardownVerified: removed ' + removed + ' in ' + pass + ' pass(es), ' + remaining + ' left (postcondition ' + (remaining === 0 ? 'CLEAN' : 'not met') + ')')
  return { ok: remaining === 0, passes: pass, removed, remaining }
}

module.exports = { beginSession, endSession, inSession, add, onPlaced, forget, oweShaft, shaftDebts, settleShaft, isScaffold, near, count, onFarmFootprint, pickFiller, teardown, teardownVerified, setDebugSink, FILLER_RE }
