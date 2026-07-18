'use strict'
// WORLD MEMORY (the semantic map): where the bot has successfully gathered each resource,
// where its own infrastructure stands, which routes actually worked, and where it got
// wedged. Split out of provision.js unchanged.
//
// Perception ends at loaded chunks (~64 blocks) and exploration was memoryless - every
// batch re-searched the world at random (verified live: chopped oak at ~570,30 twice, then
// wandered off southwest and forgot it). Like a player, the bot now REMEMBERS where it
// worked, heads straight back next time, and forgets spots that dry up.
//
// This is a PERSISTENCE + RECALL layer, not provisioning: it reads and writes
// world-memory.json and answers "where did I see X" / "where is my stuff". It has no
// gather/craft/smelt logic, which is why it was the cleanest seam to take first.
//
// route-mem.js holds the PURE route/wedge geometry; this file owns the stored form of it.
// noteWaterCrossing deliberately STAYED in provision.js - it reads hutAnchor(), which is
// part of the hut/infra layer, not this one.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const routeMem = require('./route-mem.js') // PURE route/wedge geometry: replay proven treks + soft-steer around learned wedges
const mining = require('./mining.js') // PURE depth model + branch geometry (the mine registry stores its plans)
const arbiter = require('./arbiter.js') // PURE survival authority (the gear-up back-off consults it)

// The ACTIVE BUILD ZONE, mirrored from provision.js via setBuildZone. ownInfraAnchors
// treats the zone centre as an anchor, so wedges inside a live build site are suppressed.
// It is provision.js's state - this is a mirror, not a second owner - but it has to be
// readable here or ownInfraAnchors throws (and the defensive try/catch would silently
// turn that into 'no wedges', which is exactly how this was nearly missed).
// Phase C / §5-P3 (default ON): compose proven route segments over a waypoint graph before
// falling back to whole-route replay / bearing. =0 => graph unused, byte-for-byte.
// Same env gate as provision.js's copy - read here so planTrekRoute keeps working after
// the split (it referenced provision's binding, which no longer exists in this scope).
const NAV_WAYPOINT_GRAPH = process.env.NAV_WAYPOINT_GRAPH !== '0'

let buildZone = null
function setBuildZone (box) { buildZone = box || null }

let dbgSink = null // forwarded from provision.js's setDebugSink
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// ---- WORLD MEMORY (semantic map, layer 1: resources) --------------------------------
// Perception ends at loaded chunks (~64 blocks) and exploration was memoryless - every
// batch re-searched the world at random (verified live: chopped oak at ~570,30 twice,
// then wandered off southwest and forgot it). Like a player, the bot now REMEMBERS where
// it successfully gathered each resource (bot/world-memory.json), heads straight back
// next time, and forgets spots that dry up.
const WORLD_MEM_FILE = process.env.WORLD_MEM_FILE || path.join(__dirname, 'world-memory.json') // env-overridable so a TEST bot never treks to live-world coords / stomps live memory
let worldMem = null
let worldMemTimer = null
function loadWorldMem () {
  if (worldMem) return worldMem
  try { worldMem = JSON.parse(fs.readFileSync(WORLD_MEM_FILE, 'utf8')) } catch { worldMem = {} }
  return worldMem
}
function saveWorldMem () {
  clearTimeout(worldMemTimer)
  worldMemTimer = setTimeout(() => { try { fs.writeFileSync(WORLD_MEM_FILE, JSON.stringify(worldMem, null, 1)) } catch {} }, 2000)
  if (worldMemTimer.unref) worldMemTimer.unref()
}
// ---- SEMANTIC WORLD-MAP slice 1: ROUTE-REUSE + WEDGE-MEMORY -------------------------
// Persistent routes + wedges live in the SAME world-memory.json under the SAME debounced
// saveWorldMem writer (no second writer). Pure geometry is in route-mem.js; these thin
// accessors are the ONLY bot-side wiring. HONEST: this reduces getting-stuck, it does not
// cure it - the blind static straight-line planner is still the root cause (see route-mem.js).
//
// Own-infra anchors (XZ) for the #1 rule: the bot must NEVER route AROUND its own
// hut/build/bank, even if it died or wedged there. Used to SUPPRESS wedges on BOTH the
// record and the recall side (12b). Routes need no suppression (a home<->X route ends AT
// home by construction - a feature).
function ownInfraAnchors () {
  const m = loadWorldMem()
  const out = []
  const push = e => { if (e && typeof e.x === 'number' && typeof e.z === 'number') out.push({ x: e.x, z: e.z }) }
  const infra = m.infra || {}
  for (const kind of ['hut', 'bed', 'chest', 'table', 'furnace', 'shelter', 'water']) for (const e of (infra[kind] || [])) push(e)
  if (m.bed) push(m.bed)                       // the spawn bed (mirrored outside infra too)
  if (m.wheatFarm) push(m.wheatFarm)           // our farm plot anchor
  if (buildZone) push({ x: (buildZone.x1 + buildZone.x2) / 2, z: (buildZone.z1 + buildZone.z2) / 2 }) // active build job
  return out
}
// Record a proven trek as a reusable route (from -> to, thinned crumbs). Rejects trips too
// short to be worth reusing and any polyline that wandered too far off the straight line
// (a survival/shelter detour must never get baked into the line). Merges with an existing
// route on the same endpoints (ok++, fresh crumbs).
function rememberRoute (from, to, crumbs) {
  try {
    if (!from || !to || !Array.isArray(crumbs) || crumbs.length < 2) return
    const straight = Math.hypot(to.x - from.x, to.z - from.z)
    if (straight < routeMem.ROUTE_MIN_LEN) return
    const pts = routeMem.thinPolyline(crumbs)
    if (pts.length < 2) return
    const len = routeMem.polylineLength(pts)
    if (len > routeMem.ROUTE_LEN_SANITY * straight) { dbg('route: not recording - polyline ' + Math.round(len) + 'b is >1.6x the ' + Math.round(straight) + 'b straight-line (detour)'); return }
    const m = loadWorldMem()
    const routes = m.routes = m.routes || []
    routeMem.mergeRoute(routes, { a: { x: Math.round(from.x), z: Math.round(from.z) }, b: { x: Math.round(to.x), z: Math.round(to.z) }, pts, len, at: Date.now() })
    saveWorldMem()
    dbg('route: recorded ' + Math.round(straight) + 'b trek (' + pts.length + ' pts) ' + Math.round(from.x) + ',' + Math.round(from.z) + ' -> ' + Math.round(to.x) + ',' + Math.round(to.z))
  } catch (e) { dbg('route: remember failed - ' + e.message) }
}
// Look up a usable route between two points (endpoints +-24b, net-successes, length sane).
// Returns { route, reversed, pts } (pts already oriented in the travel direction) or null.
function recallRoute (from, to) {
  try {
    const routes = (loadWorldMem().routes) || []
    const m = routeMem.matchRoute(routes, from, to)
    if (!m || !routeMem.routeUsable(m.route)) return null
    const pts = m.reversed ? m.route.pts.slice().reverse() : m.route.pts.slice()
    if (pts.length < 2) return null
    return { route: m.route, reversed: m.reversed, pts }
  } catch { return null }
}
// NAV Phase C (NAV_WAYPOINT_GRAPH): compose a route over the WAYPOINT GRAPH built from ALL usable
// routes + own-infra anchors - so a trek between two proven areas can stitch segments from
// DIFFERENT routes (a shared corridor) that no single recallRoute covers. Returns { pts } (an
// ordered {x,z} polyline to walk like a replay) or null (=> caller falls back to recallRoute, then
// bearing). Length-sane guard: a composed detour >1.6x the straight line is rejected (never bake a
// wander into the line). Reuses the same worldMem.routes / ownInfraAnchors - no new store/writer.
function planTrekRoute (from, to) {
  if (!NAV_WAYPOINT_GRAPH) return null
  try {
    const routes = (loadWorldMem().routes) || []
    if (routes.length < 2) return null // one route is already served by recallRoute's whole-route replay - the graph earns its keep only by COMPOSING >=2
    const graph = routeMem.buildGraph(routes, ownInfraAnchors())
    const nodes = routeMem.planOverGraph(graph, from, to)
    if (!nodes || nodes.length < 2) return null
    const straight = Math.hypot(to.x - from.x, to.z - from.z)
    const plen = routeMem.polylineLength(nodes)
    if (straight > 0 && plen > routeMem.ROUTE_LEN_SANITY * straight) { dbg('graph: composed plan ' + Math.round(plen) + 'b >1.6x the ' + Math.round(straight) + 'b straight-line - falling back'); return null }
    return { pts: nodes }
  } catch (e) { dbg('graph: plan failed - ' + e.message); return null }
}
// A replay stalled (measured, non-reflex) - the route is stale. fail++; 2 consecutive fails
// evict it. Caller then falls back to today's blind bearing UNCHANGED.
function dementRoute (route) {
  try {
    if (!route) return
    route.fail = (route.fail || 0) + 1
    if (routeMem.routeShouldEvict(route)) {
      const routes = (loadWorldMem().routes) || []
      const i = routes.indexOf(route)
      if (i >= 0) routes.splice(i, 1)
      dbg('route: evicted after 2 consecutive fails')
    } else dbg('route: demoted (fail ' + route.fail + ')')
    saveWorldMem()
  } catch (e) { dbg('route: dement failed - ' + e.message) }
}
// Record a physical stuck-spot (forceUnstick fired here). NO-OP under 12b own-infra
// suppression (record side of the #1 rule) - a wedge at/near home must never be learned.
function recordWedge (pos) {
  try {
    if (!pos || typeof pos.x !== 'number') return
    if (routeMem.suppressedNearAnchors(ownInfraAnchors(), pos)) { dbg('wedge: not recording - within 12b of own infra (' + Math.round(pos.x) + ',' + Math.round(pos.z) + ')'); return }
    const m = loadWorldMem()
    const wedges = m.wedges = m.wedges || []
    routeMem.mergeWedge(wedges, pos)
    saveWorldMem()
    dbg('wedge: recorded stuck-spot ' + Math.round(pos.x) + ',' + Math.round(pos.z))
  } catch (e) { dbg('wedge: record failed - ' + e.message) }
}
// The steer-eligible wedge list: alive (age-weighted) AND re-checked NOW against the
// current infra list (recall side of the #1 rule) - a hut built after a wedge, or a stale
// entry near home, is filtered out before it can ever steer routing.
function listWedges () {
  try { return routeMem.activeWedges((loadWorldMem().wedges) || [], ownInfraAnchors()) } catch { return [] }
}
function rememberSpot (item, pos, tag) {
  const m = loadWorldMem()
  const list = m[item] = m[item] || []
  for (const sp of list) {
    if (Math.hypot(sp.x - pos.x, sp.z - pos.z) < 24) {
      sp.hits = (sp.hits || 1) + 1; sp.at = Date.now()
      if (sp.dryAt) delete sp.dryAt // a fresh success here clears the dry-on-arrival cooldown
      if (tag) Object.assign(sp, tag)  // e.g. { orchard:true } so this entry is never hard-deleted
      saveWorldMem(); return
    }
  }
  const e = { x: Math.round(pos.x), z: Math.round(pos.z), at: Date.now(), hits: 1 }
  if (tag) Object.assign(e, tag)
  list.push(e)
  if (list.length > 20) { list.sort((a, b) => (b.hits - a.hits) || (b.at - a.at)); list.length = 20 }
  saveWorldMem()
}
function forgetSpot (item, spot, hard) {
  const list = loadWorldMem()[item] || []
  if (!hard) {
    // soft forget (decrement-decay): the spot lost a little confidence, delete at zero.
    spot.hits = (spot.hits || 1) - 1
    if (spot.hits <= 0) { const i = list.indexOf(spot); if (i >= 0) list.splice(i, 1) }
    saveWorldMem(); return
  }
  // HARD: the spot was BONE-DRY on arrival after a deliberate trek. An ORCHARD entry regrows -
  // NEVER hard-delete it, just rest-cool it so recall skips it while the trees come back. A wild
  // spot: MARK it (dryAt suppresses recall for a cooldown, hits demoted) and give regrowth ONE
  // chance; twice-dead (tries>=2) = gone. Marking-not-deleting stops a hits:5 chopped-out spot
  // from staying a top recall candidate while still remembering the forest may regrow.
  if (spot.orchard) { spot.rest = Date.now() + 8 * 60000; spot.hits = 0; saveWorldMem(); return }
  spot.tries = (spot.tries || 0) + 1
  spot.dryAt = Date.now()
  spot.hits = 0
  if (spot.tries >= 2) { const i = list.indexOf(spot); if (i >= 0) list.splice(i, 1) }
  saveWorldMem()
}
function recallSpot (item, pos, visited) {
  const list = loadWorldMem()[item] || []
  // SCORED pick (not just nearest-unvisited): skip exhausted/cooling spots, and prefer a spot
  // that is NEAR and RECENTLY-PRODUCTIVE over a far/stale one. The old nearest-first pick treks
  // 320b to a stale hits:5 spot, finds it dry, drops it, recalls the next far spot - burning the
  // deadline before the near ring is ever swept.
  const now = Date.now(); const DRY_COOLDOWN = 20 * 60000; const STALE = 45 * 60000
  let best = null; let bs = Infinity
  for (const sp of list) {
    if (visited.has(sp.x + ',' + sp.z)) continue
    if (sp.rest && sp.rest > now) continue // growing grove on cooldown - let the trees grow
    if (sp.dryAt && now - sp.dryAt < DRY_COOLDOWN) continue // just came up dry - don't re-trek it yet
    const d = Math.hypot(sp.x - pos.x, sp.z - pos.z)
    if (d > 400 || d < 16) continue // too far to trek / already here
    const stalePenalty = (now - (sp.at || 0) > STALE) ? 200 : 0
    const score = d + stalePenalty - Math.min(48, (sp.hits || 1) * 8) // near + recently-productive wins
    if (score < bs) { bs = score; best = sp }
  }
  return best
}

// INFRASTRUCTURE MEMORY (operator-requested): remember our OWN tables/furnaces/chests and
// walk back to them instead of littering the landscape with a fresh crafting table every
// time the last one fell out of the loaded chunks or behind torn-up terrain.
function rememberInfra (kind, pos, meta) {
  // PROVENANCE (fix #13): genuine PLACEMENT sites tag { own: true } so furnace consolidation
  // can tell a furnace the bot provably placed from a merely-adopted (possibly player) one.
  // Adoption sites pass no meta => no `own` field (byte-equivalent to fd90c9f when unset).
  const own = !!(meta && meta.own)
  // FARM_EXPAND (§4.5): a whitelisted quality tag for water edges. ensureWheatFarm/scouts survey
  // a bank while standing there and remember tillable/flat/surveyedAt for free; siting reads them
  // back. Byte-equivalent when meta carries none of these (every existing caller passes {own} or
  // nothing). Refreshes on the exact-cell dedup hit so a re-survey overwrites stale numbers.
  const applyMeta = e => {
    if (!meta) return
    if (meta.tillable != null) e.tillable = meta.tillable
    if (meta.flat != null) e.flat = meta.flat
    if (meta.surveyedAt != null) e.surveyedAt = meta.surveyedAt
  }
  const m = loadWorldMem()
  const s = m.infra = m.infra || {}
  const list = s[kind] = s[kind] || []
  // EXACT-cell dedup: the old radius-2 merge collapsed adjacent blocks into ONE entry, so
  // a double chest (two adjacent) or a chest+table read as a single remembered thing and
  // the bot lost track of what it had placed (operator: duplicate table, table on chest).
  // On a dedup hit, PRESERVE an existing own flag and only ever SET it (never clear it).
  for (const e of list) { if (e.x === Math.floor(pos.x) && e.y === Math.floor(pos.y) && e.z === Math.floor(pos.z)) { e.at = Date.now(); if (own) e.own = true; applyMeta(e); saveWorldMem(); return } }
  const entry = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at: Date.now() }
  if (own) entry.own = true
  applyMeta(entry)
  list.push(entry)
  if (list.length > 12) { list.sort((a, b) => b.at - a.at); list.length = 12 }
  saveWorldMem()
}
function recallInfra (kind, pos, maxDist) {
  const list = (loadWorldMem().infra || {})[kind] || []
  let best = null; let bd = Infinity
  for (const e of list) { const d = Math.hypot(e.x - pos.x, e.z - pos.z); if (d <= maxDist && d < bd) { bd = d; best = e } }
  return best
}
function forgetInfra (kind, entry) {
  const list = (loadWorldMem().infra || {})[kind] || []
  let i = list.indexOf(entry)
  // callers hold COPIES (resources.js maps/spreads the entries), so reference identity
  // alone never matched for them - fall back to coordinate identity
  if (i < 0) i = list.findIndex(e => e.x === entry.x && e.y === entry.y && e.z === entry.z)
  if (i >= 0) { list.splice(i, 1); saveWorldMem() }
}
// What block each infra kind IS in the world - lets memory be VERIFIED against reality
// (operator: "fix the memory completely so it applies to everything it needs memory for").
// Remembering a coordinate is worthless if the bot never checks the block is still there.
const INFRA_BLOCK = { table: /crafting_table$/, furnace: /furnace$/, chest: /chest$/, bed: /_bed$/ }
// List remembered infra of a kind. Pass `bot` to VERIFY against the world: any entry whose
// chunk is loaded but no longer holds the expected block is pruned (dead placement, someone
// broke it, a bad memory). Unloaded chunks (blockAt null) are kept - we can't disprove them.
function listInfra (kind, bot) {
  const list = (((loadWorldMem().infra || {})[kind]) || []).slice()
  const re = INFRA_BLOCK[kind]
  if (!bot || !re) return list
  const survivors = []; let changed = false
  for (const e of list) {
    const b = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (b == null) { survivors.push(e); continue } // chunk not loaded - can't verify, keep
    if (re.test(b.name)) survivors.push(e); else changed = true // gone/wrong -> prune
  }
  if (changed) { const m = loadWorldMem(); if (m.infra) { m.infra[kind] = survivors; saveWorldMem() } }
  return survivors
}
// Recall the nearest remembered infra of a kind, VERIFIED against the world when `bot` given.
function recallInfraVerified (bot, kind, pos, maxDist) {
  const list = listInfra(kind, bot)
  let best = null; let bd = Infinity
  for (const e of list) { const d = Math.hypot(e.x - pos.x, e.z - pos.z); if (d <= maxDist && d < bd) { bd = d; best = e } }
  return best
}

// ---- REGISTRIES ALSO BACKED BY world-memory.json ------------------------------------
// Mines, searched-cell negatives, the gear-up back-off latch and the bed/spawn record all
// persist through loadWorldMem()/saveWorldMem() above. They lived in provision.js purely
// because that is where everything lived; they are storage, not provisioning.

// ---- mine registry ----
// end - where to resume), branches (count done), at.
function loadMines () { const m = loadWorldMem(); return (m.mines = m.mines || []) }
function rememberMine (entry) {
  const mines = loadMines()
  const i = mines.findIndex(e => Math.hypot(e.x - entry.x, e.z - entry.z) <= 3)
  const rec = { ...(i >= 0 ? mines[i] : {}), ...entry, at: Date.now() }
  if (i >= 0) mines[i] = rec; else mines.push(rec)
  if (mines.length > 8) { mines.sort((a, b) => b.at - a.at); mines.length = 8 }
  saveWorldMem()
  return rec
}
function recallMine (bot, near, maxDist, opts = {}) {
  const now = Date.now()
  let best = null; let bd = Infinity
  for (const e of loadMines()) {
    if (!mining.mineReusable(e, near, { maxDist, now, ...opts })) continue
    const d = Math.hypot(e.x - near.x, e.z - near.z); if (d < bd) { bd = d; best = e }
  }
  return best
}
function forgetMine (entry) {
  const m = loadWorldMem(); if (!m.mines) return
  m.mines = m.mines.filter(e => !(Math.abs(e.x - entry.x) <= 3 && Math.abs(e.z - entry.z) <= 3))
  saveWorldMem()
}
function updateMineProgress (entry, branches, tip) {
  const mines = loadMines()
  const i = mines.findIndex(e => Math.abs(e.x - entry.x) <= 3 && Math.abs(e.z - entry.z) <= 3)
  if (i >= 0) { mines[i].branches = branches; if (tip) mines[i].tip = { x: tip.x, y: tip.y, z: tip.z }; mines[i].at = Date.now(); saveWorldMem() }
}

// Walk to a remembered mine's entrance and descend the EXISTING staircase to the mining

// ---- searched-cell + gearup memory ----
// NEGATIVE MEMORY (roomba rule, operator-requested): remember 32-block cells that were
// SEARCHED AND EMPTY, and stop re-sweeping them - the blind compass kept walking the same
// barren ground round after round. A cell un-marks when we PLANT saplings there (that's a
// reason to come back) or after 2h (world changes - players build, trees grow).
const SEARCH_CELL = 32
function searchCellKey (x, z) { return Math.floor(x / SEARCH_CELL) + ',' + Math.floor(z / SEARCH_CELL) }
function markSearched (item, pos) {
  const m = loadWorldMem()
  const s = m.searched = m.searched || {}
  const l = s[item] = s[item] || {}
  l[searchCellKey(pos.x, pos.z)] = Date.now()
  const keys = Object.keys(l)
  if (keys.length > 300) { keys.sort((a, b) => l[a] - l[b]); for (const k of keys.slice(0, keys.length - 300)) delete l[k] }
  saveWorldMem()
}
function isSearchedDry (item, x, z) {
  const l = (loadWorldMem().searched || {})[item] || {}
  const t = l[searchCellKey(x, z)]
  return !!t && Date.now() - t < 2 * 3600 * 1000
}
// GEAR-UP CONVERGENCE (persisted): the iron/armor bootstrap must converge, not flail.
// Every fruitless attempt (no new piece worn, no net iron gained) widens a back-off
// window so the same death-march doesn't re-run on every resume pass; any real progress
// resets it. Survives restarts - the flailing was worst right after respawns.
function gearupState () { return loadWorldMem().gearup || { fails: 0, until: 0 } }
// PURE (#60 GEARUP_PREEMPT_EXEMPT, offline-testable): should a FINISHED gear-up attempt ARM the
// naked back-off? A pass that made progress never arms (the caller's `progressed` branch resets it
// instead). A no-progress pass arms UNLESS it was interrupted by a survival preempt / stop (the body
// was taken mid-smelt) - that is not a genuine material failure (no iron obtainable, no fuel
// sourceable, furnace unreachable, or completed-but-0-slots), and penalizing it is exactly the bug
// that turned every crisis-timed smelt into a 12-min back-off and a permanent-naked loop. `hadMaterial`
// is informational (both a with-material and a no-material genuine failure arm) - only progressed and
// interrupted flip the outcome.
function gearupShouldArmBackoff (r) {
  const s = r || {}
  if (s.progressed) return false
  if (s.interrupted) return false
  return true
}
// PURE (#60 GEARUP_PROACTIVE, offline-testable): may the bot proactively gear up RIGHT NOW, in a
// SAFE window, instead of only reactively in a crisis? Fires ONLY when EVERY guard holds:
//   !armored       - still under-armored (something to make)
//   hasIron        - iron on hand (raw_iron/iron_ingot) or cheaply obtainable, so smelt->craft->equip
//                    finishes without a naked mining excursion
//   hp >= safeHp   - a real health buffer (14) so a ~40s furnace stand is not preempted 5s in
//   fed            - not in a food crisis (the smelt loop is minutes of AFK)
//   day            - daylight (mobs asleep) so standing at the furnace is safe
//   atHome         - at/near the hut (furnace + bank reachable)
//   !backoffActive - the naked back-off is not cooling us off
// Any guard failing => don't fire (a later safe window / the crisis path handles it). This is the
// calm-window trigger the permanent-naked bot never had: it only ever tried while already dying.
function proactiveGearupGate (state, opts = {}) {
  const s = state || {}
  const safeHp = opts.safeHp != null ? opts.safeHp : 14
  if (s.armored) return false
  if (!s.hasIron) return false
  if (s.hp == null || s.hp < safeHp) return false
  if (!s.fed) return false
  if (!s.day) return false
  if (!s.atHome) return false
  if (s.backoffActive) return false
  return true
}
// opts.naked (bool): the attempt ended fully naked (0 pieces worn). #53 NAKED_IRON_GRACE caps a
// naked bot's fruitless cooldown at 12 min (not 45) so it keeps trying to bootstrap armor instead
// of sitting locked out while it dies naked. Armored/partial + flag off -> today's min(45, fails*10).
// opts.interrupted (bool, #60 GEARUP_PREEMPT_EXEMPT): the attempt was cut short by a survival preempt
// / stop - not a genuine failure, so skip the back-off entirely (flag off -> ignored, byte-for-byte).
function gearupResult (progressed, opts = {}) {
  const m = loadWorldMem()
  const g = m.gearup = m.gearup || { fails: 0, until: 0 }
  if (progressed) { g.fails = 0; g.until = 0 } else if (process.env.GEARUP_PREEMPT_EXEMPT !== '0' && !gearupShouldArmBackoff({ progressed, interrupted: opts.interrupted })) {
    // #60: survival/stop took the body mid-attempt - not a genuine material failure; leave the back-off as-is.
    dbg('gearup: attempt interrupted by survival/stop - not counting it fruitless (#60 GEARUP_PREEMPT_EXEMPT)')
  } else {
    g.fails++
    const base = Math.min(45, g.fails * 10)
    const mins = arbiter.gearupCooldownMin(g.fails, !!opts.naked, { enabled: process.env.NAKED_IRON_GRACE !== '0' })
    g.until = Date.now() + mins * 60000
    dbg('gearup: fruitless attempt #' + g.fails + ' - backing off ' + mins + ' min' + (mins < base ? ' (naked cap)' : ''))
  }
  saveWorldMem()
}

function clearSearched (item, pos) {
  const l = (loadWorldMem().searched || {})[item]
  if (l && l[searchCellKey(pos.x, pos.z)]) { delete l[searchCellKey(pos.x, pos.z)]; saveWorldMem() }
}

// BED MEMORY: the server knows the bot's spawn bed but never tells the client, and the
// sleep command only scans 48 blocks around wherever the bot happens to stand - so at
// dusk 150 blocks out it "had no bed" and dug a pit instead (7 night deaths in one
// evening, live). Remember the bed like a player does: saved on every successful
// sleep/spawn-set, consulted first every night.
// Every rememberBed call site follows an actual spawn-setting action (a sleep or a
// day bed-use), so it doubles as the "spawn last asserted" timestamp ensureSpawnBed

// ---- bed + spawn-suspect memory ----
// keys off.
function rememberBed (pos) { const m = loadWorldMem(); m.bed = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), at: Date.now() }; m.bedAssertAt = Date.now(); delete m.spawnSuspect; saveWorldMem(); _bedHold = { until: 0, key: '' } }
function knownBed () { return loadWorldMem().bed || null }
function forgetBed () { const m = loadWorldMem(); delete m.bed; saveWorldMem(); _bedHold = { until: 0, key: '' } }

// UNUSABLE-BED HOLD (fix #14, flag SHELTER_BED_FALLBACK): sleepInBedHere's non-/monster/
// failure is stateless, so nightRestInner re-committed every caller to a bed mineflayer had
// just proven unusable (cant-click reach is position-deterministic) - paying a ~40s doomed
// bed prefix each cycle and starving flee/defend. Remember, per-bed and time-bounded, that
// THIS remembered bed just failed so nightRest pits straight away within the window. The bed
// itself is NEVER forgotten (hold != forget - the fell-short regression guard stays); the hold
// is cleared by expiry, a real sleep (rememberBed), or forgetBed, and never persisted (a
// restart forgets it => one extra bed attempt, which is safe). now-injectable for the test.
let _bedHold = { until: 0, key: '' }
function bedHoldUntil () { return _bedHold.until } // read-only: provision logs the remaining hold
function bedKey (pos) { return Math.round(pos.x) + '|' + Math.round(pos.y) + '|' + Math.round(pos.z) }
function markBedUnusable (pos, ms, why, now = Date.now()) {
  if (process.env.SHELTER_BED_FALLBACK === '0' || !pos || !(ms > 0)) return
  _bedHold = { until: now + ms, key: bedKey(pos) }
  dbg('nightRest: bed at ' + bedKey(pos).replace(/\|/g, ',') + ' unusable (' + why + ') - holding off it for ' + Math.round(ms / 1000) + 's')
}
function bedHeld (pos, now = Date.now()) { return !!pos && _bedHold.key === bedKey(pos) && now < _bedHold.until }

// SPAWN-SUSPECT flag, PERSISTED: a respawn landed far from the remembered bed, so the
// server-side anchor is wrong (bed broken/obstructed) - every death is a world-spawn
// carousel until a bed is re-asserted. The old flag lived in commands.js RAM and died
// with every restart/deploy mid-crisis (the overnight spiral straddled several). Cleared
// by rememberBed (every real spawn-setting action goes through it).
function setSpawnSuspect (v) { const m = loadWorldMem(); if (v) m.spawnSuspect = Date.now(); else delete m.spawnSuspect; saveWorldMem() }
function isSpawnSuspect () { return !!loadWorldMem().spawnSuspect }


module.exports = {
  setDebugSink, setBuildZone,
  loadWorldMem, saveWorldMem, ownInfraAnchors,
  rememberRoute, recallRoute, planTrekRoute, dementRoute,
  recordWedge, listWedges,
  rememberSpot, forgetSpot, recallSpot,
  rememberInfra, recallInfra, forgetInfra, listInfra, recallInfraVerified,
  loadMines, rememberMine, recallMine, forgetMine, updateMineProgress,
  searchCellKey, markSearched, isSearchedDry, clearSearched,
  gearupState, gearupResult, gearupShouldArmBackoff, proactiveGearupGate,
  rememberBed, knownBed, forgetBed, markBedUnusable, bedHeld, bedHoldUntil,
  setSpawnSuspect, isSpawnSuspect,
  WORLD_MEM_FILE
}
