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

const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[scaffold]') // §4: one definition of the sink rule; this module still owns its own sink

// Retention: with INFRA_CONSOLIDATE on, own-scaffold memory survives 72h (env-tunable) so the
// far-pillar litter patrol can still claim towers that outlive a 6h window; flag off => 6h
// exactly (byte-equivalent to fd90c9f). Longer retention is a POSITIVE own-block permission
// (isScaffold/teardown only ever act on cells WE registered), so widening it never risks a
// player block - the only cost is registry size, bounded by the sweep() cap guard below.
// ==== AUDIT 2026-07-29 FIX 13: A DEBT THAT EXPIRES IS NOT A DEBT =========================
// Measured on the live registry today: 336 cells, the oldest 10 DAYS old - and when the bot
// restarted they did not get paid, they got SWEPT, because the 72h retention had long passed.
// The blocks are still standing in the world; the bot simply stopped knowing they were its own.
// Two things break when that happens, and #119 named neither:
//   - the commitment ledger silently writes off what it owes, so the litter is permanent;
//   - FIX 8's terrain model loses the only signal that tells a floating 1x1 tower from ground,
//     so `surfaceYAt` starts reading the bot's own forgotten litter as the surface again.
// Memory was never the reason for the timer - sweep()'s 512-entry cap guard below already bounds
// the registry, evicting OLDEST-first and PLACED-before-SHAFT. So the cap is the real bound and
// the clock was redundant. Retention is now effectively unbounded (a century), which under
// [[no-blanket-time-holds]] is the honest expression: the registry shrinks when a cell is PAID or
// found repurposed, not when a timer says the mess has become scenery.
// SCAFFOLD_MAX_AGE_MS still overrides for anyone who wants the old behaviour.
const MAX_AGE_MS = process.env.INFRA_CONSOLIDATE !== '0'
  ? Number(process.env.SCAFFOLD_MAX_AGE_MS || 100 * 365 * 24 * 3600 * 1000)
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
// #119 COMMITMENT_LEDGER: a session frame now REMEMBERS WHAT IT PLACED. It used to be a bare
// purpose string, so the moment a movement session closed, the blocks it had just put in the
// world became anonymous members of a 213-entry registry - indistinguishable from litter left
// three days ago, and reachable only by an idle sweep that a never-idle bot never runs. The
// registry grew 199 -> 272 in a single session that way: placement was coupled to MOVEMENT,
// reclamation was coupled to IDLENESS, and the two rates were never going to meet.
//
// Closing a session is the event that creates the debt, so it is the event that must own it.
const sessions = [] // stack of { purpose, cells: [key] }
function beginSession (purpose) { sessions.push({ purpose: purpose || 'move', cells: [] }) }

// Cells left standing by the most recently closed session(s), oldest first. A single
// navigateTo runs many gotoOnce legs (one session each), so these ACCUMULATE and are drained
// once, by closeOut, when the whole navigation is done.
let pendingCloseOut = []

// endSession(bot?) - `bot` is optional and back-compatible. With it, the cells this session
// placed are flagged `owed` (a session-close stamp: this is debt that just came due, not aged
// landscape) and queued for closeOut. WITHOUT digging anything here: this runs inside
// gotoOnce's synchronous settle callback, and [[body-first-priority]] forbids buying tidiness
// with the nav hot path. The dig happens in closeOut, at an await point the body owns.
function endSession (bot) {
  const f = sessions.pop()
  if (!f || !bot || !f.cells.length) return 0
  const now = Date.now()
  for (const k of f.cells) {
    const v = reg.get(k)
    if (!v || isShaft(v)) continue
    v.owed = true; v.closedAt = now
    if (!pendingCloseOut.includes(k)) pendingCloseOut.push(k)
  }
  // BOUNDED. gotoOnce is also called directly (scaffold.teardown's own approach, door assists),
  // and those legs close a session without a navigateTo ever draining the queue. Keep the most
  // RECENT cells - they are the ones the body is still standing next to, and the rest lose
  // nothing: they stay in the registry as ordinary debt for the reclaim candidate to price.
  if (pendingCloseOut.length > 64) pendingCloseOut = pendingCloseOut.slice(-64)
  save()
  return f.cells.length
}
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
  const f = sessions[sessions.length - 1]
  add(pos, f.purpose)
  const k = key(pos)
  if (!f.cells.includes(k)) f.cells.push(k) // #119: the frame owns what it placed
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
    if (Math.hypot(x - pos.x, z - pos.z) <= r) out.push({ x, y, z, t: v.t, purpose: v.purpose, owed: !!v.owed, closedAt: v.closedAt })
  }
  return out
}
function count () { return reg.size }

// #56 FARM_EXCLUDE_YFIX: is `pos` inside our own wheat-farm footprint (a crop cell / its farmland /
// the block just above one)? scaffold.js had NO farm awareness (design §D), so a manual scaffold/
// pillar placer could brick over the crops the pathfinder's cropPlaceExclusion already avoids.
// Lazy-consults provision's wheatFarm memory; false on any error / flag off. Callers gate placement.
function onFarmFootprint (pos) {
  // farmFootprintHas moved to provision-farm.js and left the facade in ea48895; through the old
  // spelling this threw and the catch answered "not farm" for every cell, disarming the guard.
  try { return require('./provision-farm.js').farmFootprintHas(pos) } catch { return false }
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

// ---- SESSION-CLOSE TEARDOWN (#119, design §3.3) --------------------------------------
// "Reclamation coupled to the EVENT THAT CREATED THE DEBT, not to idleness." The bot walks
// home past the pillar it built ninety seconds ago; the old code could only get that pillar
// back via an idle sweep that tore down a handful of cells per pass while movement placed far
// more. This closes the loop at the source: when a whole navigation finishes, the blocks its
// legs placed are still WITHIN ARM'S REACH, and paying for them costs one dig each.
//
// STRICTLY BOUNDED, because this runs after every navigation:
//   - ONLY cells queued by endSession() this navigation - never the wider registry, never the
//     pathfix trail (trail-teardown near builds is FORBIDDEN, [[action-verification]])
//   - ONLY cells already within reach. It NEVER walks. If the bot has moved on, the cell stays
//     on the books and the reclaim job can price a trip for it later.
//   - a hard cell budget, so a long navigation cannot turn into a mining expedition
//   - the same double gate as teardown(): registry says ours AND the world still shows filler
//   - the column invariant: a cell is never removed while a registered cell stands above it
//   - fail CLOSED on an UNKNOWN read (pathfix.readCell) - a null is not "already gone"
//   - `exclude` (build footprints / hut apron) is honoured exactly as in teardown()
async function closeOut (bot, opts = {}) {
  const queued = pendingCloseOut
  pendingCloseOut = []
  if (!bot || !bot.entity || !queued.length) return 0
  if (opts.isStopped && opts.isStopped()) return 0
  const { Vec3 } = require('vec3')
  const budget = opts.max || 6
  const reach = opts.reach || 4.5
  // Highest first: the column invariant is satisfied for free when we always take the top
  // cell that is still standing, and a 1x1 tower is dismantled from the top as the bot rides
  // it down - which is the only order that cannot strand a floater.
  const cells = queued.map(k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z, k } })
    .filter(p => reg.has(p.k))
    .sort((a, b) => b.y - a.y)
  let removed = 0
  let provision = null
  try { provision = require('./provision.js') } catch {}
  for (const p of cells) {
    if (removed >= budget) break
    if (opts.isStopped && opts.isStopped()) break
    if (opts.exclude && opts.exclude(p)) continue          // a build owns this cell
    if (onFarmFootprint(p)) continue                        // never shave the crop plot
    // COLUMN INTEGRITY: something of ours still stands above this cell. Removing it would
    // strand that - the floating-topsoil failure. Leave the whole thing on the books.
    if (reg.has(`${p.x},${p.y + 1},${p.z}`)) continue
    const r = require('./pathfix.js').readCell(bot, p)
    if (!r.known) continue                                  // UNKNOWN: fail closed, keep the debt
    if (!FILLER_RE.test(r.block.name)) { forget(p); continue } // repurposed - nothing of ours here
    if (bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) > reach) continue // out of reach: NEVER walk for it here
    const tool = provision && provision.toolForBlock ? provision.toolForBlock(bot, r.block.name) : null
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(r.block)) continue
    try { await bot.dig(r.block); removed++; forget(p) } catch { /* leave it owed */ }
  }
  if (removed) dbg('session close: reclaimed ' + removed + ' block(s) on the way out (' + reg.size + ' registered left)')
  return removed
}
// Test/observability seam: what is queued for the next closeOut.
function pendingCloseOutCount () { return pendingCloseOut.length }

module.exports = { beginSession, endSession, inSession, add, onPlaced, forget, oweShaft, shaftDebts, settleShaft, isScaffold, near, count, onFarmFootprint, pickFiller, teardown, teardownVerified, closeOut, pendingCloseOutCount, setDebugSink, FILLER_RE }
