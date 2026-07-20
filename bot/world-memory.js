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
// ---- INGESTION GATE (#115 GROUNDED_CLAIMS) -------------------------------------------
// Memory used to accept ANY write and record no provenance, so a consumer could not tell a
// record the bot had SEEN from one it had merely ASSERTED. Live cost: `rememberInfra('hut',
// hutAt)` fired four seconds after a death, immediately after a "rebuild" that placed 0/94
// blocks - and from then on `insideOwnStructure` answered "yes, I'm home" from inside a
// phantom box, and `boundedHold` held the bot there.
//
// The rule now: a record carries HOW and WHEN it was verified.
//   verified:true  - a grounded read/survey backed this write, in THIS life (epoch).
//   verified:false - a hint. Good enough to AIM travel at ("go check the furnace"), never
//                    good enough to make a life-affecting claim from.
// A write that CLAIMS proof and whose proof does not hold up (stale epoch, UNKNOWN/BAD
// survey, wrong block) is the phantom-hut case exactly: it is REJECTED and logged, never
// downgraded to a hint. A write that claims nothing is stored as a hint. Records are then
// upgraded IN PLACE by listInfra() the moment the bot can actually see them (below), so
// this gate needs no changes at 30-odd existing call sites to converge on the truth.
function _epochNow () { try { return require('./pathfix.js').epoch() } catch { return 0 } }
// Does `proof` actually ground a write of `kind` at `pos`, in the current life?
function proofHolds (kind, pos, proof) {
  if (!proof || typeof proof !== 'object') return false
  if (proof.epoch != null && proof.epoch !== _epochNow()) return false // observed in a previous life
  if (proof.verdict != null) return proof.verdict === 'OK' // a surveyCells result
  if (proof.known === true && proof.block && proof.block.name) { // a readCell result
    const re = INFRA_BLOCK[kind]
    if (re && !re.test(proof.block.name)) return false
    const bp = proof.block.position
    if (bp && (Math.floor(bp.x) !== Math.floor(pos.x) || Math.floor(bp.y) !== Math.floor(pos.y) || Math.floor(bp.z) !== Math.floor(pos.z))) return false
    return true
  }
  if (proof.known === false) return false // an UNKNOWN read proves nothing
  return false
}
function infraVerified (e) { return !!(e && e.verified) }
// blockAt returns null for "nothing there" AND for "never sent that chunk"; readCell is the
// one place allowed to tell them apart, so memory reads the world through it too.
function readCellOf (bot, e) { try { return require('./pathfix.js').readCell(bot, { x: e.x, y: e.y, z: e.z }) } catch { return { known: false, block: null } } }

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
    // #118 FARM_SITED_FROM_HOME: open-sky is a QUALIFYING property, established at write time
    // by whoever observed the water (surveyWaterSite), not 150 seconds of walking later on
    // arrival. `false` writes through (a corrected record must be able to lose); null/undefined
    // does NOT (an UNKNOWN read proves nothing and must never overwrite a real observation).
    if (meta.openSky != null) e.openSky = meta.openSky
  }
  // #115: provenance. A claimed-but-failed proof is REJECTED outright (that is the phantom
  // hut); an unclaimed write is stored as an unverified hint.
  let verified = false
  if (meta && meta.proof !== undefined) {
    if (!proofHolds(kind, pos, meta.proof)) {
      dbg('[mem] REJECTED unverified ' + kind + ' at ' + Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z) + ' - proof did not hold')
      return
    }
    verified = true
  }
  const stamp = e => { e.observedAt = Date.now(); if (verified) { e.verified = true; e.epoch = _epochNow() } else if (e.verified === undefined) e.verified = false }
  const m = loadWorldMem()
  const s = m.infra = m.infra || {}
  const list = s[kind] = s[kind] || []
  // EXACT-cell dedup: the old radius-2 merge collapsed adjacent blocks into ONE entry, so
  // a double chest (two adjacent) or a chest+table read as a single remembered thing and
  // the bot lost track of what it had placed (operator: duplicate table, table on chest).
  // On a dedup hit, PRESERVE an existing own flag and only ever SET it (never clear it).
  for (const e of list) { if (e.x === Math.floor(pos.x) && e.y === Math.floor(pos.y) && e.z === Math.floor(pos.z)) { e.at = Date.now(); if (own) e.own = true; applyMeta(e); stamp(e); saveWorldMem(); return } }
  const entry = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at: Date.now() }
  if (own) entry.own = true
  applyMeta(entry)
  stamp(entry)
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
  const now = _epochNow()
  for (const e of list) {
    const r = readCellOf(bot, e)
    if (!r.known) { survivors.push(e); continue } // chunk not loaded - UNKNOWN, can't verify, can't disprove
    if (re.test(r.block.name)) {
      // #115 UPGRADE-ON-OBSERVATION: the bot is looking straight at it. That IS the proof,
      // so the hint becomes a verified record here rather than at 30 call sites.
      if (!e.verified || e.epoch !== now) { e.verified = true; e.epoch = now; e.observedAt = Date.now(); changed = true }
      survivors.push(e)
    } else changed = true // gone/wrong -> prune
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
// #110: the record now carries PROVENANCE. `confirmed` is true only when the SERVER was
// observed to set the spawn (a granted sleep, or the set_spawn game message) - see
// provision-hut.assertSpawnOn, the one primitive allowed to claim a spawn. An unconfirmed
// record is still a record (an unconfirmed anchor beats none) but it never claims proof.
// PROVEN LIVE 2026-07-20: the bot day-clicked a bed, said "i set my spawn at this bed", and
// 17 minutes later died and respawned 462 BLOCKS AWAY at world origin. Day-clicking does NOT
// set spawn on this server; only a granted SLEEP (or the server's own set_spawn message) does.
// So the two facts this function used to smear together are now kept apart:
//   m.bed          - WHERE MY BED IS. Always written. Useful even unconfirmed (nights head
//                    there, the ladder can find it) and it carries its own provenance.
//   m.spawnSuspect - "a respawn proved the anchor wrong". A click we cannot prove worked
//                    CANNOT clear that proof; only server evidence can. Clearing it on an
//                    unconfirmed click is exactly how the bot convinced itself home was solved.
function rememberBed (pos, meta = {}) {
  const m = loadWorldMem()
  const confirmed = meta.confirmed === true
  m.bed = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), at: Date.now(), confirmed }
  m.bedAssertAt = Date.now()
  if (confirmed) delete m.spawnSuspect
  delete m.bedUnobtainable // #117: a bed record exists, so "no bed obtainable" is disproven outright
  saveWorldMem()
  _bedHold = { until: 0, key: '' }
}
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

// #117 HOME_IS_A_NEED - "acquireBed exhausted its plan, IN THIS LIFE". An OBSERVATION with a
// scope, not a cooldown: a bot on a wool-less, sheep-less island must be able to stop wanting a
// bed long enough to armor up and get on with the build, and it must start wanting one again the
// moment the situation can have changed - never merely because N minutes elapsed. The scope is
// the pathfix life EPOCH, so the record dies with the bot that made it (a respawn puts the body
// somewhere else entirely, usually near world spawn, where the holdings question is genuinely
// open again), and it is cleared outright the instant a bed IS obtained.
function noteBedUnobtainable () { const m = loadWorldMem(); m.bedUnobtainable = { epoch: _epochNow(), at: Date.now() }; saveWorldMem() }
function clearBedUnobtainable () { const m = loadWorldMem(); if (m.bedUnobtainable) { delete m.bedUnobtainable; saveWorldMem() } }
function bedUnobtainable () { const r = loadWorldMem().bedUnobtainable; return !!(r && r.epoch === _epochNow()) }

// #117 - does a hut record stand VERIFIED in this life? Pure in-memory (no world reads, no
// chunk access): it reads the v2 provenance stamps rememberInfra/insideOwnStructure write.
// listInfra cannot upgrade a hut on observation the way it does a chest - INFRA_BLOCK has no
// 'hut' entry because a hut is a 136-cell structure, not one block - so the ONLY writers of a
// verified hut are the post-build survey (commands.js) and the grounded occupancy spot-check
// (provision-hut.insideOwnStructure). A registry box nobody has seen this life reads false,
// which is exactly the phantom-hut condition the 'shelter' verdict exists to clear.
function hutVerifiedNow () {
  const list = ((loadWorldMem().infra || {}).hut) || []
  const now = _epochNow()
  return list.some(e => e && e.verified === true && e.epoch === now)
}

// ---- HAZARD MEMORY (#112 HAZARD_NOT_LURE) -------------------------------------------
// WHAT THE WORLD DOES TO THE BOT, kept apart from WHAT THE BOT WANTS FROM THE WORLD.
//
// The grave ledger (last-death.json) used to be BOTH: it drove `graveSweep` ("free gear")
// AND it was the only source deathSpotExclusion had for "this cell kills me". Danger memory
// was therefore created by loot, scoped to loot, retired with loot, and wiped with loot -
// so the more lethal a place was the more gear it accumulated and the more attractive it
// became. Live proof (2026-07-19): drowned at 429,52,-49 at 15:51, the scheduler chose
// graveSweep "near grave 10b - free gear" at 15:58:31 with the death-spot cost ARMED, and
// the bot drowned again at 427,51,-48 at 15:59:15. A soft routing cost of 40 loses to job
// selection every time; and clearing last-death.json (twice that day, at the operator's
// request) silently destroyed the bot's only memory of where it drowns.
//
// So hazards live HERE, in world-memory.json, with their own lifetime: retrieving a grave,
// a grave despawning, or deleting last-death.json cannot touch them. An empty `hazards`
// now truthfully means "no known hazards".
//
// LIFETIME IS CONDITION-GATED, NEVER TIMED. A record is created by a death and de-escalated
// only by EVIDENCE: the bot standing in the cell, alive, and out of the medium that killed
// it there (markTraversed). Nothing here expires on a clock. The timestamps in `deaths` are
// for the operator's eyes and for the storage cap; no decision function reads them.
const gravePolicy = require('./grave-policy.js') // PURE: the hazard box math + cause taxonomy
// Deaths this close to an existing record are the SAME hazard (the two drownings above were
// 2 apart in x, 1 in y, 1 in z - one pocket, one record, two deaths => escalation).
const HAZARD_MERGE = { radius: 3, up: 3, down: 3 }
const HAZARD_MAX = 64
function hazardList () { const m = loadWorldMem(); return (m.hazards = m.hazards || []) }
// The record whose EXCLUSION box (the deathSpotCost box) contains pos, or null. Point query.
function hazardAt (pos, opts) {
  if (!pos) return null
  for (const h of hazardList()) if (gravePolicy.hazardBoxHas(pos, h, opts)) return h
  return null
}
function listHazards () { return hazardList().slice() }
// A death happened here. Merges into the nearby record if one exists (deaths++), and RE-ARMS
// escalation: a fresh death means the last "i walked through it fine" no longer proves anything.
function recordHazard (pos, cause) {
  try {
    if (!pos || pos.x == null) return null
    const list = hazardList()
    const c = cause || 'unknown'
    let rec = null
    for (const h of list) if (gravePolicy.hazardBoxHas(pos, h, HAZARD_MERGE)) { rec = h; break }
    if (!rec) { rec = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), cause: c, deaths: [] }; list.push(rec) }
    rec.cause = c // the LATEST cause owns the record: it is what the bot must survive to come back
    rec.deaths.push(Date.now())
    if (rec.deaths.length > 12) rec.deaths.splice(0, rec.deaths.length - 12)
    rec.traversedSinceDeath = false
    // storage cap only (NOT a decision): keep the records with the most deaths, then the freshest.
    if (list.length > HAZARD_MAX) {
      list.sort((a, b) => (b.deaths.length - a.deaths.length) || ((b.deaths[b.deaths.length - 1] || 0) - (a.deaths[a.deaths.length - 1] || 0)))
      list.length = HAZARD_MAX
    }
    saveWorldMem()
    dbg('hazard: recorded ' + c + ' death at ' + rec.x + ',' + rec.y + ',' + rec.z + ' (' + rec.deaths.length + ' here)')
    return rec
  } catch (e) { dbg('hazard: record failed - ' + e.message); return null }
}
// THE RELEASE CONDITION (the only one). The bot stood in the cell, alive, and NOT in the
// medium that killed it - so the medium is survivable/gone right now. This is both design
// releases at once ("survived traversal" and "cause neutralised"): for a drowning pocket,
// standing there dry IS the grounded probe that the water is no longer in the way.
// Callers must only pass a position the bot is genuinely occupying, having verified it is
// out of the medium (see provision.markHazardTraversal - the one wired caller).
function markTraversed (pos) {
  if (!pos) return false
  let changed = false
  for (const h of hazardList()) {
    if (!gravePolicy.hazardBoxHas(pos, h)) continue
    if (h.traversedSinceDeath) continue
    h.traversedSinceDeath = true
    changed = true
    dbg('hazard: walked through ' + h.x + ',' + h.y + ',' + h.z + ' alive and out of the ' + (h.cause || 'unknown') + ' - escalation released')
  }
  if (changed) saveWorldMem()
  return changed
}
// One-time ingestion of the pre-existing grave ledger, so deploying this does not blank the
// bot's #85 death-spot routing costs. Seeded records carry cause 'unknown' (nothing recorded
// how those deaths happened), which is soft-cost-only - never a hard exclusion.
function hazardsSeeded () { return !!loadWorldMem().hazardsSeeded }
function markHazardsSeeded () { const m = loadWorldMem(); m.hazardsSeeded = true; saveWorldMem() }

// OPERATOR-ROUTING LATCH (anti-grief, §5): the hard hazard exclusion is for AUTONOMOUS route
// planning only - it must never forbid a route the operator asked for. commands.handle pushes
// this for the duration of an operator-sourced command (counted, so nesting is safe) and the
// exclusion closure degrades to cost-only while it is held. It is a CONDITION (an operator
// command is in flight), not a timer.
let _operatorRouting = 0
function setOperatorRouting (on) { if (on) _operatorRouting++; else _operatorRouting = Math.max(0, _operatorRouting - 1) }
function operatorRouting () { return _operatorRouting > 0 }


module.exports = {
  setDebugSink, setBuildZone,
  loadWorldMem, saveWorldMem, ownInfraAnchors,
  rememberRoute, recallRoute, planTrekRoute, dementRoute,
  recordWedge, listWedges,
  rememberSpot, forgetSpot, recallSpot,
  rememberInfra, recallInfra, forgetInfra, listInfra, recallInfraVerified, infraVerified, proofHolds,
  loadMines, rememberMine, recallMine, forgetMine, updateMineProgress,
  searchCellKey, markSearched, isSearchedDry, clearSearched,
  gearupState, gearupResult, gearupShouldArmBackoff, proactiveGearupGate,
  rememberBed, knownBed, forgetBed, markBedUnusable, bedHeld, bedHoldUntil,
  setSpawnSuspect, isSpawnSuspect,
  noteBedUnobtainable, clearBedUnobtainable, bedUnobtainable, hutVerifiedNow, // #117 HOME_IS_A_NEED
  recordHazard, hazardAt, listHazards, markTraversed, hazardsSeeded, markHazardsSeeded, // #112 HAZARD_NOT_LURE
  setOperatorRouting, operatorRouting,
  WORLD_MEM_FILE
}
