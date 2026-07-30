'use strict'
// HOME: the bot's own hut - where it is, whether the bot is inside it, keeping it intact,
// and keeping it liveable. Split out of provision.js unchanged.
//
// This is the layer that answers "is this MY structure?" (ownHutAt / insideOwnStructure /
// onHutApron), the one that repairs it (repairHutStructure, cleanupHutInterior,
// healHomeCrater), and the maintainHome chain the camp pass and the index.js home-repair
// reflex both drive. It also owns the SPAWN ANCHOR primitives: bedUsable (is this bed a
// working anchor?), assertSpawnOn (the one place allowed to claim a spawn), ensureBedSite
// (find OR MAKE somewhere to lay one) and upgradeBedPlacement (the only legal anchor swap).
//
// #110 removed furnishHut entirely: it had zero callers (the camp chain owns bed/station/
// interior duties) and carried three latent destroy-before-create paths.
//
// hut-model.js holds the PURE interior model (classifyCell, decideHutRepair); this file is
// the executor that reads the world through it and actually places blocks.
//
// LATE BINDING, and why: repairHutStructure / maintainHome / ensureHutBed legitimately call
// UP into the provisioning layer (runCraft, healBankDouble, consolidateBank, ensureSpawnBed,
// walkStaged, underArmored). Those are runtime calls, never module-load ones, so they go
// through a lazy require of provision.js - the same pattern provision.js already uses to
// reach commands.js. Threading six injected callbacks through this file instead would be
// noise, and a top-level require would be a genuine cycle.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const hutModel = require('./hut-model.js')   // PURE self-structure model + repair decision
const navigate = require('./navigate.js')    // unified navigation
const mining = require('./mining.js')        // PURE tool-durability model
const provCore = require('./provision-core.js')
const { AIRISH, REPLACEABLE, canBreakNaturally, countItem, inventoryCounts, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt, nearHostile, isNight } = provCore
const worldMemory = require('./world-memory.js')
const INFRA_BLOCK = { table: /crafting_table$/, furnace: /furnace$/, chest: /chest$/, bed: /_bed$/ } // refactor fix: the reconcileInfra consumer moved here but this const stayed (unexported) in world-memory.js -> ReferenceError
const { loadWorldMem, saveWorldMem, listInfra, rememberInfra, forgetInfra, recallInfra,
  recallInfraVerified, knownBed, rememberBed, forgetBed } = worldMemory

// The provisioning layer, resolved at CALL time (see the late-binding note above).
const P = () => require('./provision.js')
const S = () => require('./provision.js').__siblings // refactor fix: reach the __siblings-bridge walkStaged

let dbgSink = null // forwarded from provision.js's setDebugSink
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

let _hutSchemCache = null

const insideHutBox = (p, hut) => hutModel.inBox(hut, p.x, p.z)

function ownHutAt (pos) {
  if (!pos) return null
  const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
  for (const h of listInfra('hut')) {
    if (x >= h.x && x <= h.x + 5 && z >= h.z && z <= h.z + 5 && y >= h.y && y <= h.y + 4) return h
  }
  return null
}

function onHutApron (bot, pos) {
  const p = pos || bot.entity.position.floored()
  for (const h of listInfra('hut')) {
    if (p.x >= h.x - 2 && p.x <= h.x + 6 && p.z >= h.z - 2 && p.z <= h.z + 6) return h
  }
  return null
}

// #115 GROUNDED_CLAIMS - VERIFIED OCCUPANCY. This used to be `ownHutAt(p)`: a pure geometry
// test against the registry box that never read one block of the world. On 2026-07-19 the
// registry held a hut at 456,68,-142 ingested straight after a rebuild that placed 0/94
// blocks, so `boundedHold: holding inside my hut` printed one line after `crossOwnDoor(in):
// still on the wrong side` - the bot was standing in a field, inside the COORDINATES of a
// hut that had never been verified to exist, and held there.
//
// Now: geometry FIRST (cheap, and it short-circuits to null everywhere the bot normally is,
// so this stays off the hot path), then a grounded spot-check that the structure is really
// there - four wall corners at anchor y+1 read through pathfix.readCell.
//   >=3 known solid  -> occupied, and the registry record is UPGRADED to verified (seeing it
//                       IS the proof - this is how a real hut heals a stale hint).
//   unloaded probes  -> null. "Can't tell" is not "yes"; every caller already handles null.
//   known but hollow -> null, and no upgrade. The phantom cannot answer.
// NOTE ownHutAt stays pure geometry ON PURPOSE: its other consumers are anti-grief
// exclusions ("never dig/clutter here"), which must fail PROTECTIVE, while this predicate is
// a claim about the bot's own situation and must fail CLOSED. Opposite directions, so they
// are deliberately two functions.
function insideOwnStructure (bot, pos) {
  const p = pos || (bot && bot.entity && bot.entity.position)
  if (!p) return null
  const h = ownHutAt(p)
  if (!h) return null
  if (process.env.GROUNDED_OBS === '0') return h // temporary rollback seam, deletion scheduled
  const readCell = require('./pathfix.js').readCell
  let knownProbes = 0; let solidProbes = 0
  for (const [dx, dz] of [[0, 0], [5, 0], [0, 5], [5, 5]]) {
    const r = readCell(bot, { x: h.x + dx, y: h.y + 1, z: h.z + dz })
    if (!r.known) continue
    knownProbes++
    if (!AIRISH(r.block.name)) solidProbes++
  }
  if (knownProbes < 3) return null // unloaded / can't see it - refuse to decide
  if (solidProbes < 3) return null // the box is empty air: this hut does not exist
  if (!h.verified) { try { worldMemory.rememberInfra('hut', { x: h.x, y: h.y, z: h.z }, { proof: { verdict: 'OK', epoch: require('./pathfix.js').epoch() } }) } catch {} }
  return h
}

function hasSolidCeiling (bot, upTo = 45, opts = {}) {
  if (!bot.entity) return false
  // Inside the bot's own hut: roofed, yes - underground, no. Without this the interior
  // read as a cave and every "buried" consumer (climb-out, travel surfacing, the fishing/
  // farming gates, /state hazards) misfired while the bot idled at home.
  if (insideOwnStructure(bot)) return false
  const base = bot.entity.position.floored()
  for (let dy = 2; dy <= upTo; dy++) {
    const b = bot.blockAt(base.offset(0, dy, 0))
    if (!b || AIRISH(b.name) || b.boundingBox !== 'block') continue
    // leaves have a 'block' bounding box but a canopy isn't a cave roof - so an
    // "underground" check (opts.ignoreLeaves) sees through a tree, while travelFar's
    // buried() check (default) still treats an overhang as cover.
    if (opts.ignoreLeaves && /_leaves$/.test(b.name)) continue
    return true
  }
  return false
}

function hutAnchor () { return (listInfra('hut')[0]) || null }

function hutReader (bot) { return (x, y, z) => bot.blockAt(new Vec3(x, y, z)) }

async function stepOffApron (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const h = onHutApron(bot)
  if (!h) return true // not on the apron - nothing to step off
  const tag = opts.tag || 'shaft'
  if (process.env.STONE_RELOCATE === '0') { // legacy one-shot: today's exact behavior
    const away = opts.home && (Math.abs(opts.home.x - h.x) > 8 || Math.abs(opts.home.z - h.z) > 8)
      ? new Vec3(opts.home.x, bot.entity.position.y, opts.home.z)
      : new Vec3(h.x + 12, bot.entity.position.y, h.z + 12)
    dbg('  ' + tag + ': on the hut apron - stepping clear to ' + Math.round(away.x) + ',' + Math.round(away.z) + ' before digging')
    // #80 APRON_DOOR_WALK: a raw goto has no door-assist, so from INSIDE the sealed hut every
    // step-off returned noPath instantly (live 03:22Z: all 4 dirs in <300ms, gathers starved).
    // walkStaged carries the door pre-flight + recovery rungs. =0 -> today's raw goto exactly.
    if (process.env.APRON_DOOR_WALK !== '0') { try { await S().walkStaged(bot, Math.round(away.x), Math.round(away.z), { isStopped, range: 3, timeoutMs: 20000 }) } catch {} } else { try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 3), 20000) } catch {} }
    return !onHutApron(bot)
  }
  // STONE_RELOCATE on: rotate the compass so a single wedged direction no longer sticks.
  const radius = opts.radius != null ? opts.radius : 12
  const tries = opts.tries != null ? opts.tries : 4
  for (let i = 0; i < tries && !isStopped(); i++) {
    const [dx, dz] = mining.DIRS[i % 4]
    const away = new Vec3(h.x + dx * radius, bot.entity.position.y, h.z + dz * radius)
    dbg('  ' + tag + ': on the hut apron - stepping clear (dir ' + i + ') to ' + Math.round(away.x) + ',' + Math.round(away.z))
    // #80 APRON_DOOR_WALK: same door-assist swap as the legacy path above (raw goto = instant
    // noPath from inside the sealed hut; walkStaged crosses the own-door first). =0 -> raw goto.
    if (process.env.APRON_DOOR_WALK !== '0') { try { await S().walkStaged(bot, Math.round(away.x), Math.round(away.z), { isStopped, range: 3, timeoutMs: 12000 }) } catch {} } else { try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 3), 12000) } catch {} }
    if (!onHutApron(bot) && !insideOwnStructure(bot)) return true
  }
  return !onHutApron(bot) && !insideOwnStructure(bot)
}

async function ensureHutApron (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const doorX = at.x + 2; const floorY = at.y; const outZ = at.z - 1
  // only bother if the door is actually there (its lower half sits at floorY+1)
  const dl = bot.blockAt(new Vec3(doorX, floorY + 1, at.z))
  if (!dl || !/_door$/.test(dl.name)) return 0
  // get within reach of the threshold
  try { await gotoWithTimeout(bot, new goals.GoalNearXZ(doorX, at.z, 2), 20000) } catch {}
  const DIRTLIKE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|tuff|gravel|netherrack)$/
  const ANYFILL = /(_planks|dirt|cobblestone|cobbled_deepslate|stone)$/
  const fillCell = async (wx, wy, wz) => {
    const b = bot.blockAt(new Vec3(wx, wy, wz))
    if (b && b.boundingBox === 'block' && !AIRISH(b.name)) return false // already solid
    let ok = await placeAt(bot, new Vec3(wx, wy, wz), DIRTLIKE) // cheap filler first (save planks)
    if (!ok) ok = await placeAt(bot, new Vec3(wx, wy, wz), ANYFILL)
    return ok
  }
  let filled = 0
  // door width +-1, the immediate step-out row. Fill support (floorY-1) THEN walk-surface (floorY),
  // bottom-up so each layer has a solid face beneath/beside to place against. A block at floorY tops
  // out flush with the inside floor -> a level walk through the door instead of a fall.
  for (let dx = -1; dx <= 1 && !isStopped(); dx++) {
    if (await fillCell(doorX + dx, floorY - 1, outZ)) filled++
    if (await fillCell(doorX + dx, floorY, outZ)) filled++
  }
  if (filled) { say(`sealed the doorstep - filled ${filled} apron cell(s) so the exit stays walkable`); dbg('  apron: filled ' + filled + ' doorstep cell(s) at ' + doorX + ',' + floorY + ',' + outZ) }
  return filled
}

async function healHomeCrater (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const reposition = opts.reposition !== false
  const floorY = at.y; const doorX = at.x + 2
  const DIRTLIKE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|tuff|gravel|netherrack)$/
  const ANYFILL = /(_planks|dirt|cobblestone|cobbled_deepslate|stone)$/
  const X0 = doorX - 2; const X1 = doorX + 5    // 414..421 - FULL crater width incl. the east pit
  const Z1 = at.z - 1; const Z0 = at.z - 4      // 84..81 - out to the crater's north edge
  const solidAt = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!(b && b.boundingBox === 'block' && !AIRISH(b.name)) }
  const inFootprint = (x, z) => (z >= at.z) || !!ownHutAt(new Vec3(x, floorY, z)) // NEVER inside the hut
  // Restore the WALK SURFACE (y=floorY) across the crater by BRIDGING outward from solid
  // ground - not a bottom-up depth fill, which can't be reached: from the doorstep the
  // pathfinder can't route ACROSS the open pit to the far (east) cells (live: 'none
  // placeable'). Instead place the nearest surface hole that has a solid face, STEP ONTO
  // it, and reach the next - exactly how a player bridges a gap. A 1-thick dirt surface is
  // stable (only sand/gravel fall) and stops the fall-in death; the air below is harmless.
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  // A cell is a real crater ONLY if it's not already walkable at natural grade: intact
  // ground sits one block LOW (grade top at floorY-1, feet at floorY), so a cell that is
  // solid at floorY-1 is fine even though floorY itself is air - filling it would build a
  // waist-high dirt shelf across intact apron (live bug). Only air at BOTH floorY and
  // floorY-1 is an actual pit to bridge.
  const targets = []
  for (let wz = Z1; wz >= Z0; wz--) for (let wx = X0; wx <= X1; wx++) {
    if (inFootprint(wx, wz)) continue
    if (!solidAt(wx, floorY, wz) && !solidAt(wx, floorY - 1, wz)) targets.push({ x: wx, z: wz })
  }
  const holes = targets.length
  if (!holes) return 0
  let filled = 0; let progress = true; let guard = 0
  while (targets.length && progress && guard++ < 80 && !isStopped()) {
    progress = false
    targets.sort((a, b) => bot.entity.position.distanceTo(new Vec3(a.x, floorY, a.z)) - bot.entity.position.distanceTo(new Vec3(b.x, floorY, b.z)))
    for (let i = 0; i < targets.length && !isStopped(); i++) {
      const t = targets[i]
      const sideN = N4.map(([dx, dz]) => ({ x: t.x + dx, z: t.z + dz })).filter(n => !inFootprint(n.x, n.z) && (solidAt(n.x, floorY, n.z) || solidAt(n.x, floorY - 1, n.z)))
      const belowSolid = solidAt(t.x, floorY - 1, t.z)
      if (!sideN.length && !belowSolid) continue // no face to place against yet - a nearer cell bridges here first
      const tv = new Vec3(t.x, floorY, t.z)
      if (bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) > 4.3) {
        if (!reposition) continue // doorway quick-pass: only what's reachable without walking
        let ok = false
        for (const n of sideN) { // stand ON a solid neighbour (its top) to get in reach
          try { await gotoWithTimeout(bot, new goals.GoalBlock(n.x, floorY + 1, n.z), 6000) } catch {}
          if (bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) <= 4.6) { ok = true; break }
        }
        if (!ok && bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) > 4.6) continue
      }
      let ok = await placeAt(bot, tv, DIRTLIKE) // cheap filler first (save planks)
      if (!ok) ok = await placeAt(bot, tv, ANYFILL)
      if (ok) { filled++; targets.splice(i, 1); i--; progress = true }
    }
  }
  if (filled) { say(`patched the creeper crater at my door - bridged ${filled} block(s) so it's walkable`); dbg('  crater heal: bridged ' + filled + '/' + holes + ' surface hole(s), x' + X0 + '-' + X1 + ' z' + Z0 + '-' + Z1 + (targets.length ? ' (' + targets.length + ' left for a later pass)' : '')) }
  else dbg('  crater heal: ' + holes + ' surface hole(s), none bridgeable from here' + (reposition ? '' : ' (no-reposition pass)'))
  return filled
}

// ---- BEDS: one place that knows how to GET a bed and how to LAY one -------------------------
// Everything bed-shaped used to be re-derived at each call site, and one of those derivations
// was wrong in a way that cost 23 deaths in a day: the camp step gated bed-crafting on
// "3 wool AND >=3 PLANKS in the pack", so a bot carrying 6 wool and a stack of LOGS decided it
// had no bed and no way to make one - then said so in the log while holding the wool. The fix
// is not a better inventory count; it is to stop counting inventory here at all and let the
// resource model (withdraw > craft) answer "can I have a bed?".

function bedInPack (bot) {
  return (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name)) || null
}

// Bed item names worth ASKING the resource model for, best first: a bed already sitting in
// our own chests (any colour - a withdraw is free), then a bed whose wool we hold enough of,
// then white_bed as the universal fallback. PURE - unit-testable without a bot or a world.
function bedCandidates (totals) {
  const t = totals || {}
  const banked = Object.keys(t).filter(n => /_bed$/.test(n) && t[n] > 0).sort((a, b) => t[b] - t[a])
  const fromWool = Object.keys(t).filter(n => /_wool$/.test(n) && t[n] >= 3)
    .sort((a, b) => t[b] - t[a]).map(n => n.replace(/_wool$/, '_bed'))
  const out = []
  for (const n of [...banked, ...fromWool, 'white_bed']) if (!out.includes(n)) out.push(n)
  return out
}

// Put a bed in the pack, or honestly fail. resources.acquire is the ONLY sanctioned path:
// it withdraws from our own verified chests first and crafts from total holdings second, so
// logs-vs-planks (the live bug) is the planner's problem, not ours. It does not GATHER - if
// the wool genuinely is not ours yet this returns null and the caller says why.
async function acquireBed (bot, opts = {}) {
  const have = bedInPack(bot)
  if (have) return have
  const isStopped = opts.isStopped || (() => false)
  const res = require('./resources.js') // lazy - resources requires provision at load
  const near = opts.near
  const planOpts = { primaryWood: (P().detectWood(bot) || 'oak') }
  // A bed is a COLOUR family: any of the sixteen will anchor a spawn, and the wool the bot ends
  // up holding decides which. So this is a two-pass loop, and the second pass exists for one
  // structural reason - a pass can CHANGE holdings (the plan's sheep hunt puts brown wool in the
  // pack when white was asked for), and the candidate list was computed from the holdings we had
  // BEFORE that. Re-read, recompute, try again; if nothing moved, do not burn a second pass.
  //
  // This replaces AUDIT FIX 16's hand-wired "if the recipe planner gives up, go and kill sheep"
  // bolt-on. Wool is now a `hunt` producer in the capability registry, so res.acquire ->
  // planProvision plans the hunt itself, exactly like it plans a gather or a smelt - and the
  // special case for the one material anybody happened to notice is gone (DESIGN-PRINCIPLES §1:
  // deleting the patch layer is the fix).
  let totals = {}
  const readTotals = async () => { try { return await res.totalCounts(bot, { near, maxDist: 24 }) } catch (e) { dbg('  acquireBed: holdings read failed (' + e.message + ')'); return {} } }
  const sigOf = t => Object.keys(t).sort().map(n => n + ':' + t[n]).join(',')
  totals = await readTotals()
  let tried = []
  for (let pass = 0; pass < 2; pass++) {
    const before = sigOf(totals)
    tried = bedCandidates(totals)
    for (const name of tried) {
      if (isStopped()) break
      // gather:true - this is the BOOTSTRAP caller. A bot with nothing has no bank to withdraw
      // from and no planks to craft from, so a withdraw+craft-only acquire refuses the whole task
      // (`not craftable from holdings (needs gathering birch_log)` - verified live, and the reason
      // no spawn anchor was ever laid). It may chop its own wood and hunt its own sheep; both legs
      // are bounded by their own drivers (roam fence, kill cap, night gate, deadline).
      try { await res.acquire(bot, name, 1, { near, isStopped, say: opts.say, planOpts, gather: true }) }
      catch (e) { dbg('  acquireBed: ' + name + ' failed (' + e.message + ')') }
      const got = bedInPack(bot)
      if (got) { dbg('  acquireBed: now holding a ' + got.name); return got }
    }
    if (isStopped()) break
    totals = await readTotals()
    if (sigOf(totals) === before) { dbg('  acquireBed: the pass changed nothing in my holdings - a second identical attempt cannot do better'); break }
    dbg('  acquireBed: holdings changed during the attempt (wool/materials came in) - re-planning against what i actually hold')
  }
  // Report what IS, not what was hoped for (DESIGN-PRINCIPLES §7): the old line claimed "no sheep
  // in reach" whether or not anything had ever gone looking for a sheep.
  const wool = () => { try { return P().woolCount(bot) } catch { return 0 } }
  dbg('  acquireBed: no bed obtainable - holding ' + wool() + ' wool [tried ' + tried.join(', ') + ']')
  return null
}

// Lay a carried bed on OPEN GROUND near `near` - the fallback for a bot that has no hut yet.
// Rings outward so the bed lands close to home without needing the hut model. Every rung is
// grounded: cells are read before placing and the placed bed is re-read afterwards (that
// re-read IS the proof - pathfix already wraps the place itself). Returns the bed block or null.
// A bed occupies TWO cells and the SERVER decides which two - the orientation follows the
// placer's yaw, not our intent. The old code ASSUMED head = foot+z, validated those cells,
// then accepted any bed found at the foot: it verified EXISTENCE, not CONFORMANCE, so a bed
// that landed facing east (head one cell east, unsupported) passed. Live cost: a bed perched
// on the hut wall crest with its head over open air. Read the real footprint from the block's
// own state instead of predicting it.
const BED_FACE = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }
function bedFootprint (bot, pos) {
  const b = bot.blockAt(pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z))
  if (!b || !/_bed$/.test(b.name)) return null
  let pr = {}
  try { pr = b.getProperties() || {} } catch {}
  const d = BED_FACE[pr.facing]
  if (!d) return null
  const foot = pr.part === 'head' ? b.position.offset(-d[0], -d[1], -d[2]) : b.position
  return { foot, head: foot.offset(d[0], d[1], d[2]), facing: pr.facing }
}

// #110 THE ANCHOR-REPLACEMENT INVARIANT - the placement predicate re-derived from the actual
// REQUIREMENT instead of a cosmetic proxy. The old rule ("support under both cells AND >=3 of
// that support's 4 horizontal neighbours solid") tested whether the ground LOOKS continuous.
// That is not the requirement, and it cost the bot its home: on the chewed-up terrain the bot
// itself creates around its hut, legitimate pit-pocked topsoil was rejected everywhere, so a
// bot holding a bed and planks found "nowhere near home to lay it" (live 2026-07-20 01:17:39)
// while the crest class it was invented to stop was already stopped by footprint support.
//
// The requirement is: THE BED PERSISTS, THE BOT CAN USE IT, AND USING IT IS NOT A HAZARD.
//   P1 integrity - both REAL cells (facing/part, never an assumed +z) read as the bed.
//   P2 support   - a solid block directly under BOTH real cells. A woken/respawning body
//                  standing over air is the live crest failure; this is the clause that kills it.
//   P3 usability - at least ONE standable cell side-adjacent to the footprint (air, air above,
//                  solid below), at bed Y or one step down. A one-wide wall crest with BOTH
//                  cells supported fails HERE - its neighbours are air over air. This is also
//                  exactly the geometry the sleep/activate approach needs (the #77 click-reach fix).
//   P4 no lethal - no lava/fire side-adjacent to the footprint or under a standable cell.
//
// The >=3/4-neighbour count is DELETED, not tuned: once both cells are supported and a stand
// exists, the continuity of the ground AROUND the support is irrelevant. Do not bring a
// neighbour count back (spawnbedtest pins this).
//
// UNKNOWN-SAFE: a null read is "cannot judge" - never a silent pass and never a silent fail.
// Callers get { ok:false, why:'unknown ...' } and must treat it as not-provable, not as bad.
const LETHAL_RE = /^(lava|flowing_lava|fire|soul_fire|magma_block)$/

// Is `c` a cell a body can stand in? null = unknown (chunk not loaded), never a verdict.
function standableCell (bot, c) {
  const feet = bot.blockAt(c); const head = bot.blockAt(c.offset(0, 1, 0)); const floor = bot.blockAt(c.offset(0, -1, 0))
  if (!feet || !head || !floor) return null
  return AIRISH(feet.name) && AIRISH(head.name) && floor.boundingBox === 'block'
}

// P2+P3+P4 over a PAIR of cells. Shared by bedUsable (after P1) and ensureBedSite (before the
// bed exists) so the site the bot prepares is judged by the same rule that judges the result.
function bedPairSafe (bot, foot, head) {
  const cells = [foot, head]
  const inPair = c => cells.some(p => p.x === c.x && p.y === c.y && p.z === c.z)
  for (const c of cells) { // P2
    const sup = bot.blockAt(c.offset(0, -1, 0))
    if (!sup) return { ok: false, why: 'unknown chunk under ' + c.toString() }
    if (sup.boundingBox !== 'block') return { ok: false, why: 'no support under ' + c.toString() }
  }
  let stand = false; let standUnknown = false
  for (const c of cells) { // P3 + P4 over the side-adjacent columns
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const side = c.offset(dx, 0, dz)
      if (inPair(side)) continue
      const sb = bot.blockAt(side)
      if (sb && LETHAL_RE.test(sb.name)) return { ok: false, why: sb.name + ' right beside the bed at ' + side.toString() }
      for (const dy of [0, -1]) { // a bed on a low rise is still clickable from the ground beside it
        const cand = side.offset(0, dy, 0)
        const s = standableCell(bot, cand)
        if (s === null) { standUnknown = true; continue }
        if (!s) continue
        const under = bot.blockAt(cand.offset(0, -1, 0))
        if (under && LETHAL_RE.test(under.name)) return { ok: false, why: 'the only footing beside the bed stands on ' + under.name }
        stand = true
      }
    }
  }
  if (!stand) return { ok: false, why: standUnknown ? 'unknown chunk beside the bed - cannot prove a place to stand' : 'nothing standable beside the bed (a ledge/crest the bot cannot reach it from)' }
  return { ok: true, why: 'both cells supported, standable beside it, nothing lethal adjacent' }
}

function bedUsable (bot, pos) {
  const at = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z)
  const b0 = bot.blockAt(at)
  if (!b0) return { ok: false, why: 'unknown chunk at ' + at.toString() }
  const fp = bedFootprint(bot, at)
  if (!fp) return { ok: false, why: 'not a bed' }
  for (const c of [fp.foot, fp.head]) { // P1 conformance
    const here = bot.blockAt(c)
    if (!here) return { ok: false, why: 'unknown chunk at ' + c.toString() }
    if (!/_bed$/.test(here.name)) return { ok: false, why: 'cell ' + c.toString() + ' is not part of the bed' }
  }
  // ==== THE ANCHOR MUST BE INSIDE THE SHELTER (2026-07-30) ==============================
  // Live: the hut stood 6x6 at 188,67,-104 and the spawn bed sat at 185,68,-102 - THREE BLOCKS
  // OUTSIDE the west wall, on open ground - while the hut's own bed cell stayed empty:
  //   [prov] acquireBed: no bed obtainable - holding 0 wool [tried white_bed]
  //   [prov] camp: hut bed -> none
  //   [prov] bed-upgrade: [noop] the anchor is already usable
  // Every check here passed, because every check asked about the BED and none asked WHERE it is.
  // So the bot had to leave shelter, at night, to use its own anchor - and upgradeBedPlacement,
  // whose entire job is to move a bad anchor, was told the anchor was fine.
  // The operator's question was "why is it even POSSIBLE to place the bed outside its hut" and the
  // answer was that nothing anywhere asserted the invariant. This is that assertion, in the one
  // predicate every caller already consults - so an outdoor anchor now reports NOT usable and the
  // existing upgrade path (acquire -> place inside -> assert -> roll back on no evidence) moves it.
  // GUARDED so it can only ever help: it fires only when a hut is actually registered AND the
  // survey of it is grounded. No hut, or an unknown one, leaves today's verdict untouched - a bot
  // camping in the open must keep its open-ground anchor.
  const hut = hutAnchor()
  if (hut && !insideHutBox(fp.foot, hut) && !insideHutBox(fp.head, hut)) {
    return { ok: false, why: 'the anchor is OUTSIDE my hut at ' + hut.x + ',' + hut.z + ' - a bed I must leave shelter to reach is not a usable anchor' }
  }
  return bedPairSafe(bot, fp.foot, fp.head)
}

// #110 assertSpawnOn - THE ONE spawn-assert primitive, and the only code in this file allowed
// to claim a spawn. The defect it closes: `await bot.activateBlock(bed); rememberBed(pos)` was
// the idiom at four call sites, and activateBlock RESOLVING only proves the CLICK happened.
// At night with a hostile near, the server refuses and sets nothing - yet memory stamped
// success and cleared the spawn-suspect flag. A claim recorded without server evidence is
// exactly the failure the grounded-truth work exists to end.
//
// Evidence, in strength order:
//   'slept'       - bot.isSleeping observed true (the server granted the sleep). We never
//                   INITIATE a sleep here; nightRest's sleepInBedHere owns that policy.
//   'spawn_set'   - the server's own set-spawn game message arrived.
//   'unconfirmed' - the click resolved and nothing came back.
// rememberBed fires on slept/spawn_set always; on unconfirmed only with opts.allowUnconfirmed
// (recovery paths that have NO anchor at all - an unconfirmed bed beats none), and then the
// record says confirmed:false rather than lying.
const SET_SPAWN_RE = /block\.minecraft\.set_spawn|respawn point set/i
function isSetSpawnMessage (msg) {
  const seen = []
  const walk = (m, depth) => {
    if (m == null || depth > 4) return
    if (typeof m === 'string') { seen.push(m); return }
    if (Array.isArray(m)) { for (const x of m) walk(x, depth + 1); return }
    if (typeof m !== 'object') return
    if (m.translate) seen.push(String(m.translate))
    if (m.text) seen.push(String(m.text))
    walk(m.json, depth + 1); walk(m.extra, depth + 1); walk(m.with, depth + 1)
  }
  walk(msg, 0)
  return seen.some(s => SET_SPAWN_RE.test(s))
}

// A BOUNDED EVIDENCE-ARRIVAL window, NOT a behaviour cooldown: the condition is "the message
// arrived"; the 3s only stops an unbounded wait. A bot with no event channel (offline tests)
// skips the wait entirely rather than burning it for nothing.
const SPAWN_EVIDENCE_MS = 3000
async function assertSpawnOn (bot, bedBlock, opts = {}) {
  if (!bedBlock || !/_bed$/.test(bedBlock.name || '')) return { ok: false, how: 'none', why: 'nothing bed-shaped to assert spawn on' }
  const pos = bedBlock.position
  const remember = (confirmed, how, why) => { rememberBed(pos, { confirmed }); dbg('  assertSpawn: [' + how + '] ' + why); return { ok: true, how, why } }
  if (bot.isSleeping) return remember(true, 'slept', 'already asleep in the bed at ' + pos.toString() + ' - the server granted it')
  let sawSetSpawn = false
  const onMsg = m => { try { if (isSetSpawnMessage(m)) sawSetSpawn = true } catch {} }
  const canListen = typeof bot.on === 'function' && typeof bot.removeListener === 'function'
  if (canListen) { bot.on('message', onMsg); bot.on('messagestr', onMsg) }
  try {
    try { await bot.activateBlock(bedBlock) } catch (e) { return { ok: false, how: 'none', why: 'the bed click failed (' + e.message + ')' } }
    if (canListen) {
      const deadline = Date.now() + SPAWN_EVIDENCE_MS
      while (!sawSetSpawn && !bot.isSleeping && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    }
    if (bot.isSleeping) return remember(true, 'slept', 'the click put the bot to sleep at ' + pos.toString())
    if (sawSetSpawn) return remember(true, 'spawn_set', 'the server confirmed the spawn is set at ' + pos.toString())
    if (opts.allowUnconfirmed) return remember(false, 'unconfirmed', 'the click resolved but the server never said it set the spawn at ' + pos.toString() + ' - recorded UNCONFIRMED (no other anchor)')
    dbg('  assertSpawn: [unconfirmed] no server evidence for a spawn at ' + pos.toString() + ' - claiming nothing')
    return { ok: false, how: 'unconfirmed', why: 'the server never confirmed a spawn at ' + pos.toString() }
  } finally {
    if (canListen) { try { bot.removeListener('message', onMsg); bot.removeListener('messagestr', onMsg) } catch {} }
  }
}

// #110 ensureBedSite - site search AND PREPARATION as a first-class rung. A real player on
// chewed ground does not hunt for a perfect natural pad: they place two blocks and lay the bed
// on them. Search-only placement is a terrain lottery, and around its own hut the bot always
// loses it. Two modes:
//   plan:true - pure reads + a resource-model count check, NO world writes. Returns the chosen
//               site and its cost, or null. This doubles as the SWAP'S ACHIEVABILITY GATE.
//   (default) - executes: places any needed support blocks (verified by a world re-read),
//               returns { foot, head, need, prepared } ready for the bed.
//
// ANTI-GRIEF, all enforced HERE and not at call sites: <=2 pad blocks ever, own materials via
// the resource model, within 12b (XZ) of `near`, never inside a registered build footprint,
// UNKNOWN-read columns skipped, and the pad is judged by bedPairSafe AFTER placement so a pad
// that CREATES a hazard is rolled back. Pad blocks are PERMANENT INFRASTRUCTURE and are
// deliberately NOT registered with scaffold.js - a registered pad would be torn down by the
// next teardown pass, dropping the spawn bed's support out from under it.
const PAD_FILLER = ['cobblestone', 'oak_planks', 'birch_planks', 'spruce_planks', 'dirt']
const PAD_MAX = 2
const BED_SITE_MAX_XZ = 12
async function ensureBedSite (bot, near, opts = {}) {
  if (!near || !bot.entity) return null
  const res = require('./resources.js')
  const isStopped = opts.isStopped || (() => false)
  const base = new Vec3(Math.round(near.x), Math.floor(near.y), Math.round(near.z))
  const excluded = (opts.exclude || []).map(c => c.x + '|' + c.y + '|' + c.z)
  const isExcluded = c => excluded.includes(c.x + '|' + c.y + '|' + c.z)
  const airish = b => !!b && AIRISH(b.name)

  // GROUND-SEEKING, not a single Y: for each column find the surface inside the band instead
  // of assuming the site shares near.y. The single-Y assumption is why the old ring generator
  // found nothing but the wall crest on ground that sits a block or two lower.
  const surfaceY = (x, z) => {
    for (let y = base.y + 2; y >= base.y - 4; y--) {
      const here = bot.blockAt(new Vec3(x, y, z)); const above = bot.blockAt(new Vec3(x, y + 1, z)); const below = bot.blockAt(new Vec3(x, y - 1, z))
      if (!here || !above || !below) return null // unknown column - never "clear"
      if (airish(here) && airish(above) && below.boundingBox === 'block') return y
    }
    return null
  }

  const candidates = []
  for (let r = 1; r <= 8; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
    const x = base.x + dx; const z = base.z + dz
    if (Math.hypot(x - base.x, z - base.z) > BED_SITE_MAX_XZ) continue
    const y = surfaceY(x, z)
    if (y == null) continue
    // the placement code stands off and faces +z, so the pair it aims for is foot + head@+z.
    // The post-place CONFORMANCE read still judges whatever the server actually made.
    const foot = new Vec3(x, y, z); const head = new Vec3(x, y, z + 1)
    if (isExcluded(foot) || isExcluded(head)) continue
    const hb = bot.blockAt(head); const hAbove = bot.blockAt(head.offset(0, 1, 0))
    if (!hb || !hAbove || !airish(hb) || !airish(hAbove)) continue
    const pad = []
    for (const c of [foot, head]) {
      const sup = bot.blockAt(c.offset(0, -1, 0))
      if (!sup) { pad.push(null); break } // unknown - drop the candidate
      if (sup.boundingBox === 'block') continue
      if (!AIRISH(sup.name) && !REPLACEABLE.test(sup.name)) { pad.push(null); break } // liquid/other - not ours to fill
      const under = bot.blockAt(c.offset(0, -2, 0))
      if (!under || under.boundingBox !== 'block') { pad.push(null); break } // nothing to place the pad against
      pad.push(c.offset(0, -1, 0))
    }
    if (pad.some(p => p === null)) continue
    if (pad.length > PAD_MAX) continue
    // anti-grief: neither the bed nor its pad may land inside a registered build footprint
    let inZone = false
    try { inZone = [foot, head, ...pad].some(c => P().inBuildZone(c.x, c.z)) } catch {}
    if (inZone) continue
    candidates.push({ foot, head, pad, need: pad.length, dist: Math.hypot(x - base.x, z - base.z) })
  }
  // fewest filler blocks first (0 = a natural site), then closest to home
  candidates.sort((a, b) => (a.need - b.need) || (a.dist - b.dist))
  if (!candidates.length) { dbg('  ensureBedSite: no bed pair within 8b of ' + base.x + ',' + base.z + ' is preparable for <=' + PAD_MAX + ' blocks'); return null }

  let totals = {}
  try { totals = await res.totalCounts(bot, { near: base, maxDist: 24 }) } catch (e) { dbg('  ensureBedSite: holdings read failed (' + e.message + ')') }
  const fillerFor = n => n === 0 ? 'none' : (PAD_FILLER.find(name => (totals[name] || 0) >= n) || null)

  for (const c of candidates) {
    if (isStopped()) break
    const filler = fillerFor(c.need)
    if (!filler) continue // cannot fund this pad from our own holdings
    if (opts.plan) {
      dbg('  ensureBedSite: [plan] ' + c.foot.toString() + ' needs ' + c.need + ' pad block(s)' + (c.need ? ' of ' + filler : ''))
      return { foot: c.foot, head: c.head, need: c.need, filler: c.need ? filler : null, prepared: false }
    }
    if (c.need === 0) {
      const safe = bedPairSafe(bot, c.foot, c.head)
      if (!safe.ok) { dbg('  ensureBedSite: natural pair at ' + c.foot.toString() + ' rejected (' + safe.why + ')'); continue }
      dbg('  ensureBedSite: natural site at ' + c.foot.toString() + ' - no preparation needed')
      return { foot: c.foot, head: c.head, need: 0, filler: null, prepared: true }
    }
    // EXECUTE: source the filler through the resource model (never a raw pack count), lay the
    // pad, and re-read every cell. Anything short rolls the pad back - it is this call's own
    // uncommitted creation, which is the one dig the invariant always allows.
    try { await res.acquire(bot, filler, c.need, { near: base, isStopped, say: opts.say }) } catch (e) { dbg('  ensureBedSite: could not acquire ' + filler + ' (' + e.message + ')') }
    const laid = []
    let ok = true
    for (const p of c.pad) {
      if (bot.entity.position.distanceTo(p) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y + 1, p.z, 2), 15000) } catch {} }
      const placed = await placeAt(bot, p, new RegExp('^' + filler + '$'))
      const back = bot.blockAt(p) // the re-read IS the proof (pathfix wraps the place itself)
      if (!placed || !back || back.boundingBox !== 'block') { dbg('  ensureBedSite: pad block at ' + p.toString() + ' did not land (' + (placeAt.lastFail || '?') + ')'); ok = false; break }
      laid.push(p)
    }
    const safe = ok ? bedPairSafe(bot, c.foot, c.head) : { ok: false, why: 'pad incomplete' }
    if (ok && safe.ok) { dbg('  ensureBedSite: prepared a ' + laid.length + '-block ' + filler + ' pad at ' + c.foot.toString()); return { foot: c.foot, head: c.head, need: c.need, filler, prepared: true } }
    dbg('  ensureBedSite: pad at ' + c.foot.toString() + ' rolled back (' + safe.why + ')')
    for (const p of laid) { try { const b = bot.blockAt(p); if (b && b.boundingBox === 'block') { await bot.dig(b); await collectDrops(bot, 2) } } catch (e) { dbg('  ensureBedSite: pad rollback failed at ' + p.toString() + ' (' + e.message + ')') } }
  }
  dbg('  ensureBedSite: ' + candidates.length + ' candidate site(s) near ' + base.x + ',' + base.z + ' but none could be funded or prepared')
  return null
}

// Lay a carried bed on OPEN GROUND near `near`. #110: the site now comes from ensureBedSite,
// which SEARCHES AND PREPARES (the inline r<=4 single-Y ring generator and its cosmetic
// pre-screen are gone). This function keeps exactly its old duties - place, verify
// CONFORMANCE, reject-dig a bad one - and the reject-dig stays what it always was: rollback of
// an uncommitted creation made in this same call, which the anchor invariant always permits.
async function placeBedNear (bot, near, opts = {}) {
  let bedItem = bedInPack(bot)
  if (!bedItem || !near) return null
  const isStopped = opts.isStopped || (() => false)
  const exclude = (opts.exclude || []).slice()
  for (let attempt = 0; attempt < 3 && !isStopped(); attempt++) {
    const site = await ensureBedSite(bot, near, { isStopped, say: opts.say, exclude })
    if (!site) { dbg('  placeBedNear: no site near ' + Math.round(near.x) + ',' + Math.round(near.z) + ' could be found or prepared'); return null }
    const { foot, head } = site
    exclude.push(foot, head) // a site that fails is not offered again on the next attempt
    if (bot.entity.position.distanceTo(foot) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(foot.x, foot.y, foot.z, 2), 15000) } catch {} }
    bedItem = bedInPack(bot)
    if (!bedItem) return null
    try {
      await bot.equip(bedItem, 'hand')
      await bot.lookAt(head.offset(0.5, 0, 0.5), true)
      await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0)), new Vec3(0, 1, 0))
    } catch (e) { dbg('  placeBedNear: ' + foot.x + ',' + foot.z + ' place failed (' + e.message + ')'); continue }
    await new Promise(r => setTimeout(r, 400))
    // CONFORMANCE, not existence: read the footprint the server actually produced and judge
    // THAT. A bed we cannot stand behind gets broken and the item reused on the next candidate.
    let landed = null
    for (const c of [foot, head]) { const b = bot.blockAt(c); if (b && /_bed$/.test(b.name)) { landed = b; break } }
    if (!landed) { dbg('  placeBedNear: placement at ' + foot.x + ',' + foot.z + ' did not verify'); continue }
    const verdict = bedUsable(bot, landed.position)
    if (verdict.ok) { dbg('  placeBedNear: bed verified at ' + landed.position.toString() + ' (' + verdict.why + ')'); return landed }
    dbg('  placeBedNear: REJECTING bed at ' + landed.position.toString() + ' - ' + verdict.why + ' - breaking it and trying elsewhere')
    try { await bot.dig(landed); await collectDrops(bot, 3) } catch (e) { dbg('  placeBedNear: could not reclaim the bad bed (' + e.message + ')'); return null }
  }
  return null
}

async function ensureHutBed (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  // 1) already a bed standing in the footprint? assert spawn once, then leave it be.
  for (let dy = 0; dy <= 3 && !isStopped(); dy++) for (let dz = 0; dz <= 5; dz++) for (let dx = 0; dx <= 5; dx++) {
    const b = bot.blockAt(new Vec3(at.x + dx, at.y + dy, at.z + dz))
    if (b && /_bed$/.test(b.name)) {
      const kb = knownBed()
      // opts.force = the server anchor is KNOWN wrong (spawn-suspect) - a matching memory
      // proves nothing then; walk over and genuinely re-activate the bed.
      if (!opts.force && kb && kb.x === b.position.x && kb.y === b.position.y && kb.z === b.position.z) return 'present' // spawn already set here - don't re-trek every pass
      try { await gotoWithTimeout(bot, new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2), 15000) } catch {}
      // #110: evidence or no claim. This is a recovery path with no proven anchor, so an
      // unconfirmed click is still recorded - but recorded HONESTLY (confirmed:false).
      try { await assertSpawnOn(bot, b, { allowUnconfirmed: true, say: opts.say }) } catch {}
      return 'present'
    }
  }
  // 2) carrying a bed? lay it on an interior floor cell. foot (2,1,2) + head (2,1,3): both must
  //    be air over a solid floor. (chest 4,1,1/2, furnace 4,1,4, table 1,1,4 are all clear of this.)
  // No bed in the pack: acquireBed is the one source of truth - withdraw a banked bed,
  // else craft one from total holdings (this is where the old planks-in-pack gate lived).
  const bedItem = await acquireBed(bot, { near: { x: at.x + 2, y: at.y + 1, z: at.z + 2 }, isStopped, say: opts.say })
  if (!bedItem) return 'none'
  const foot = new Vec3(at.x + 2, at.y + 1, at.z + 2)
  const head = new Vec3(at.x + 2, at.y + 1, at.z + 3)
  for (const c of [foot, head]) {
    const cb = bot.blockAt(c); const fl = bot.blockAt(c.offset(0, -1, 0))
    if (cb && !AIRISH(cb.name)) { dbg('  ensureHutBed: interior spot blocked by ' + cb.name); return 'fail' }
    if (!fl || fl.boundingBox !== 'block') { dbg('  ensureHutBed: no solid floor under the bed spot'); return 'fail' }
  }
  try { await gotoWithTimeout(bot, new goals.GoalNear(foot.x, foot.y, foot.z, 2), 15000) } catch {}
  try {
    await bot.equip(bedItem, 'hand')
    await bot.lookAt(head.offset(0.5, 0.0, 0.5), true) // face +z so the head lays toward (2,1,3)
    await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0)), new Vec3(0, 1, 0))
  } catch (e) { dbg('  ensureHutBed: place failed (' + e.message + ')'); return 'fail' }
  await new Promise(r => setTimeout(r, 400))
  for (let dz = 0; dz <= 5; dz++) for (let dx = 0; dx <= 5; dx++) { // verify a bed actually landed, then set spawn
    const b = bot.blockAt(new Vec3(at.x + dx, at.y + 1, at.z + dz))
    if (b && /_bed$/.test(b.name)) {
      try { await assertSpawnOn(bot, b, { allowUnconfirmed: true, say }) } catch {}
      say('set my bed in the hut - spawn point secured')
      return 'placed'
    }
  }
  dbg('  ensureHutBed: placement did not verify - bed still in pack')
  return 'fail'
}

function freeInteriorCell (bot, hut, near) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const cells = hutModel.freeStandCells(hut, hutReader(bot))
  if (!cells.length) return null
  const p = near || bot.entity.position
  cells.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
  const c = cells[0]
  return new Vec3(c.x, c.y, c.z)
}

function findHutDoorway (bot, hut) {
  const d = hutModel.doorwayColumn(hut, hutReader(bot), { preferDoorBlock: process.env.DOOR_CROSS_GEOMETRIC !== '0' })
  return d ? new Vec3(d.x, hut.y + 1, d.z) : null
}

function hutFreeCells (bot, hut) {
  return hutModel.freeStandCells(hut, hutReader(bot)).map(c => new Vec3(c.x, c.y, c.z))
}

function furnitureInHut (bot, hut, itemRe) {
  const read = hutReader(bot)
  for (const [x, z] of hutModel.interiorColumns(hut)) for (let dy = 0; dy < hutModel.DIMS.h; dy++) {
    const b = read(x, hut.y + dy, z)
    if (b && itemRe.test(b.name)) return new Vec3(x, hut.y + dy, z)
  }
  return null
}

// #110 upgradeBedPlacement - MAINTENANCE ONLY, and the ONLY code in the tree permitted to dig
// a bed that memory points at. This is where the quality judgment went after it was taken OUT
// of the spawn-critical path: ensureSpawnBed's STOOD rung used to consult a quality verdict and,
// on a bad one, dig the anchor and forget it BEFORE any replacement existed - executed from a
// 45s background timer that discards failure verdicts. It traded a working anchor for none and
// the bot died in a respawn carousel all night (live 2026-07-19 21:09).
//
// THE ANCHOR-REPLACEMENT INVARIANT, enforced literally here: a swap may not BEGIN until the
// replacement is proven ACHIEVABLE (site preparable AND materials confirmed), and then runs
// acquire -> create -> verify -> assert -> DESTROY LAST. At every await point knownBed() names
// a bed that is PHYSICALLY STANDING. Every failure leaves the old anchor standing and remembered.
//
// Gates are condition gates, zero time windows, cheapest first - the primitive is inert (one
// bedUsable read) whenever the anchor is fine, which is why it needs no flag.
async function upgradeBedPlacement (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const res = require('./resources.js')
  const N = (how, why) => { dbg('bed-upgrade: [' + how + '] ' + why); return { how, why } }
  if (!bot.entity) return N('noop', 'no body yet')
  const kb = knownBed()
  if (!kb) return N('noop', 'no bed remembered - a missing anchor is ensureSpawnBed\'s job, not maintenance\'s')
  if (Math.hypot(kb.x - bot.entity.position.x, kb.z - bot.entity.position.z) > 8) return N('noop', 'the remembered bed is not in reach from here')
  const old = bot.blockAt(new Vec3(kb.x, kb.y, kb.z))
  if (!old || !/_bed$/.test(old.name)) return N('noop', 'nothing reads as a bed at the remembered spot - not a swap, a reconciliation')
  const v = bedUsable(bot, old.position)
  if (v.ok) return N('noop', 'the anchor is already usable')
  // a bot in ANY crisis keeps its ugly bed - a swap is never worth a survival window
  if (isNight(bot)) return N('kept', 'night - an ugly anchor beats a swap in the dark (' + v.why + ')')
  let need = null
  try { need = P().survivalNeed(bot) } catch {}
  if (need) return N('kept', 'a survival need is active - keeping the ugly anchor (' + v.why + ')')

  // ACHIEVABILITY, before anything in the world is touched. A bed occupying the only viable
  // cells is by definition not upgradable: that returns 'kept', never a deadlock or a dig.
  const fp = bedFootprint(bot, old.position)
  const oldCells = fp ? [fp.foot, fp.head] : [old.position]
  const near = opts.near || { x: kb.x, y: kb.y, z: kb.z }
  const plan = await ensureBedSite(bot, near, { plan: true, isStopped, exclude: oldCells, say }).catch(() => null)
  if (!plan) return N('kept', 'no better site near home is findable or preparable (' + v.why + ')')
  let totals = {}
  try { totals = await res.totalCounts(bot, { near, maxDist: 24 }) } catch (e) { dbg('bed-upgrade: holdings read failed (' + e.message + ')') }
  if (!bedObtainable(bot, totals)) return N('kept', 'a replacement bed is not obtainable from what we hold (' + v.why + ')')

  // 1) ACQUIRE FIRST - withdraw > craft through the resource model. Never by touching the
  //    standing bed: cannibalising the anchor to replace the anchor is the bug, not the fix.
  const item = await acquireBed(bot, { near, isStopped, say }).catch(() => null)
  if (!item) return N('kept', 'could not get a replacement bed - the old one stays')
  // 2) CREATE - prepare the site and lay the new bed. placeBedNear's conformance check and
  //    reject-dig are the rollback for an uncommitted creation.
  const nb = await placeBedNear(bot, near, { isStopped, say, exclude: oldCells }).catch(() => null)
  if (!nb) return N('kept', 'the replacement bed would not lay anywhere better - the old one stays')
  // 3) ASSERT - server evidence only. No confirmation means we do NOT move the anchor, so the
  //    new bed is rolled back and memory still names the old, standing one.
  const a = await assertSpawnOn(bot, nb, { allowUnconfirmed: false, say }).catch(() => ({ ok: false, why: 'assert threw' }))
  if (!a.ok) {
    dbg('bed-upgrade: the new bed at ' + nb.position.toString() + ' set no spawn (' + a.why + ') - rolling it back')
    try { await bot.dig(bot.blockAt(nb.position) || nb); await collectDrops(bot, 3) } catch (e) { dbg('bed-upgrade: rollback dig failed (' + e.message + ')') }
    return N('kept', 'spawn-set was not confirmed on the new bed - the old anchor is untouched')
  }
  // 4) DESTROY LAST - memory already names the NEW, verified, standing anchor. From here a
  //    failure costs at most one bed ITEM; it can no longer cost the anchor.
  let husk = ''
  try {
    if (bot.entity.position.distanceTo(new Vec3(kb.x, kb.y, kb.z)) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(kb.x, kb.y, kb.z, 2), 20000) } catch {} }
    const stale = bot.blockAt(new Vec3(kb.x, kb.y, kb.z))
    if (stale && /_bed$/.test(stale.name)) {
      await bot.dig(stale)
      // pickup-verify (the idiom salvaged from the deleted furnishHut): the reclaimed bed is
      // the spare that funds the NEXT swap, so it is worth four tries to actually pocket it.
      for (let tries = 0; tries < 4 && !bedInPack(bot); tries++) { await collectDrops(bot, 6); await new Promise(r => setTimeout(r, 500)) }
      if (!bedInPack(bot)) husk = ' (the old bed dropped but never reached the pack)'
    }
  } catch (e) { husk = ' (old bed husk left standing: ' + e.message + ')' }
  say('moved my bed somewhere i can actually use it')
  return N('swapped', 'anchor moved to ' + nb.position.toString() + ' - the old bed at ' + kb.x + ',' + kb.z + ' was cleared LAST' + husk)
}

// Can we get a replacement bed WITHOUT touching the standing one? Holdings-derived, from the
// resource model's totals - the achievability half of the swap gate.
function bedObtainable (bot, totals) {
  if (bedInPack(bot)) return true
  const t = totals || {}
  const sum = re => Object.keys(t).filter(n => re.test(n)).reduce((s, n) => s + (t[n] || 0), 0)
  if (sum(/_bed$/) >= 1) return true
  return sum(/_wool$/) >= 3 && (sum(/_planks$/) >= 3 || sum(/_log$/) >= 1 || sum(/_wood$/) >= 1)
}

function stationInHut (bot, kind, hut) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const cells = hutModel.stationCells(hut, hutReader(bot))[kind] || []
  return cells.length ? new Vec3(cells[0].x, cells[0].y, cells[0].z) : null
}

function stationSlot (bot, kind, desired = 1, hut) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const c = hutModel.stationSlot(hut, hutReader(bot), kind, desired)
  return c ? new Vec3(c.x, c.y, c.z) : null
}

async function loadHutSchem (version) {
  if (_hutSchemCache && _hutSchemCache.version === version) return _hutSchemCache.schem
  try {
    const schematic = require('./schematic.js') // lazy - schematic requires provision back
    const schem = await schematic.loadFile('hut.schem', version)
    _hutSchemCache = { version, schem }
    return schem
  } catch (e) { dbg('repairHut: schematic load failed (' + e.message + ')'); return null }
}

// The cells the SCHEMATIC designates for each station kind, in WORLD coords. The one authority
// on "which of these two crafting tables is the real one". Live 2026-07-30 cleanupHutInterior
// deduped by scan order and dug the table + furnace standing in their DESIGNED cells, keeping
// the strays - which is where the two permanent `furniture 0/2` holes came from.
async function schemStationCells (bot, hut) {
  const out = { table: [], furnace: [], chest: [], bed: [], torch: [], other: [] }
  const schem = await loadHutSchem(bot.version)
  if (!schem || !hut) return out
  const st = schem.start(); const en = schem.end()
  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const w = schem.getBlock(new Vec3(x, y, z))
    if (!w || !w.name || !hutModel.FURNITURE_RE.test(w.name)) continue
    const kind = hutModel.furnitureKind(w.name)
    if (out[kind]) out[kind].push({ x: hut.x + (x - st.x), y: hut.y + (y - st.y), z: hut.z + (z - st.z) })
  }
  return out
}

function reconcileInfra (bot) {
  const m = loadWorldMem()
  const infra = m.infra = m.infra || {}
  const summary = {}
  const hut = hutAnchor()
  const inHut = e => hut && hutModel.isInterior(hut, e.x, e.z) && e.y >= hut.y && e.y <= hut.y + hutModel.DIMS.h - 1
  for (const kind of ['table', 'furnace', 'chest', 'bed']) {
    const re = INFRA_BLOCK[kind]
    const list = (infra[kind] || []).slice()
    const verify = e => { const b = bot.blockAt(new Vec3(e.x, e.y, e.z)); if (b == null) return null; return re.test(b.name) }
    let { keep } = hutModel.reconcileCells(list, verify)
    summary[kind] = { was: list.length }
    // Re-seed the true in-hut stations (world scan) so real furniture is never lost from
    // memory, and phantom in-hut entries (cell now empty) are already gone from `keep`.
    if (hut) {
      const stations = hutModel.stationCells(hut, hutReader(bot))[kind] || []
      for (const s of stations) if (!keep.some(e => e.x === s.x && e.y === s.y && e.z === s.z)) keep.push({ x: s.x, y: s.y, z: s.z, at: Date.now() })
      // any KEEP entry that is inside the hut box but no longer a real station was already
      // dropped by verify; nothing more to do.
    }
    infra[kind] = keep
    summary[kind].now = keep.length
  }
  saveWorldMem()
  // Bed doubles as the spawn anchor - if one stands in the hut and m.bed is empty/stale,
  // point knownBed at it so ensureSpawnBed stops hunting a phantom.
  try {
    if (hut) {
      const beds = hutModel.stationCells(hut, hutReader(bot)).bed
      if (beds.length && (!m.bed || !bot.blockAt(new Vec3(m.bed.x, m.bed.y, m.bed.z)) || !/_bed$/.test((bot.blockAt(new Vec3(m.bed.x, m.bed.y, m.bed.z)) || {}).name || ''))) {
        // RECONCILIATION, not an assert: this only says "the bed we mean is THAT one". No
        // server was asked, so it never claims confirmed - assertSpawnOn owns that word.
        rememberBed(new Vec3(beds[0].x, beds[0].y, beds[0].z), { confirmed: false })
        summary.bed.seededSpawn = true
      }
    }
  } catch (e) { dbg('reconcileInfra: bed/spawn reseed failed (' + e.message + ')') }
  dbg('reconcileInfra: ' + Object.entries(summary).map(([k, v]) => `${k} ${v.was}->${v.now}`).join(', '))
  return summary
}

async function cleanupHutInterior (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hut = hut || hutAnchor()
  if (!hut) return { ok: false, passes: 0, remaining: ['no hut registered'], dug: 0, removedDupes: 0 }
  const read = hutReader(bot)
  const maxPasses = opts.maxPasses || 4
  let dug = 0; let removedDupes = 0; let pass = 0
  // The schematic decides which duplicate is the keeper. A load failure must not turn the
  // dedupe destructive again, so on failure we keep NOTHING protected and skip deduping.
  let schemStations = null
  try { schemStations = await schemStationCells(bot, hut) } catch (e) { dbg('  huttidy: schematic station cells unavailable (' + e.message + ') - skipping the duplicate pass rather than guessing which to dig') }
  const digAt = async (c) => {
    const p = new Vec3(c.x, c.y, c.z)
    const b = bot.blockAt(p)
    if (!b || AIRISH(b.name)) return false
    try {
      if (bot.entity.position.distanceTo(p) > 4) await navigate.gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 12000)
    } catch { /* dig test below still gates reach */ }
    const tool = toolForBlock(bot, b.name); if (tool) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) { dbg('  huttidy: cannot reach ' + b.name + ' at ' + p.toString() + ' this pass'); return false }
    try { await bot.dig(b); await collectDrops(bot, 3); return true } catch (e) { dbg('  huttidy: dig failed at ' + p.toString() + ' (' + e.message + ')'); return false }
  }
  for (pass = 1; pass <= maxPasses; pass++) {
    if (isStopped()) break
    // 1) stray filler (dig top-down so a pile clears cleanly)
    const strays = hutModel.strayCells(hut, read).sort((a, b) => b.y - a.y)
    for (const s of strays) { if (isStopped()) break; if (await digAt(s)) dug++ }
    // 2) duplicate stations: keep the one standing in its SCHEMATIC cell and dig the rest (a
    //    second table boxes the bot in; only one is needed). Chests are exempt (a double chest is
    //    two legit adjacent cells) and so are beds (one bed, never dig the spawn anchor here).
    //    Keeping the FIRST by scan order is what made this pass DESTRUCTIVE: it dug the station
    //    in the designed cell and kept the stray, so repairHut re-reported the hole forever.
    for (const kind of (schemStations ? ['table', 'furnace'] : [])) {
      const cells = hutModel.dedupeOrder(hutModel.stationCells(hut, read)[kind] || [], schemStations[kind] || [])
      for (let i = 1; i < cells.length; i++) {
        if (isStopped()) break
        if (await digAt(cells[i])) { removedDupes++; dbg('  huttidy: removed duplicate ' + kind + ' at ' + cells[i].x + ',' + cells[i].y + ',' + cells[i].z) }
      }
    }
    // 3) floor holes -> fill with carried filler (a hole wedges/traps; NOT a pillar - this
    //    is the floor level, anchor.y-1, the one place filling is legitimate indoors)
    for (const h of hutModel.floorHoles(hut, read)) {
      if (isStopped()) break
      try { await placeAt(bot, new Vec3(h.x, h.y, h.z), /^(dirt|coarse_dirt|cobblestone)$/) } catch {}
    }
    // VERIFY (fresh reads): clean iff no stray, <=1 table, <=1 furnace, no floor hole
    const strayLeft = hutModel.strayCells(hut, read)
    const st = hutModel.stationCells(hut, read)
    const holesLeft = hutModel.floorHoles(hut, read)
    const remaining = []
    if (strayLeft.length) remaining.push(strayLeft.length + ' stray')
    if (st.table.length > 1) remaining.push(st.table.length + ' tables')
    if (st.furnace.length > 1) remaining.push(st.furnace.length + ' furnaces')
    if (holesLeft.length) remaining.push(holesLeft.length + ' floor holes')
    dbg('  huttidy pass ' + pass + ': dug=' + dug + ' dupes=' + removedDupes + ' remaining=[' + remaining.join(', ') + ']')
    if (!remaining.length) { try { reconcileInfra(bot) } catch (e) { dbg('  huttidy: reconcile failed (' + e.message + ')') }; return { ok: true, passes: pass, remaining: [], dug, removedDupes } }
    if (pass === maxPasses) { try { reconcileInfra(bot) } catch {}; return { ok: false, passes: pass, remaining, dug, removedDupes } }
  }
  return { ok: false, passes: pass, remaining: ['stopped'], dug, removedDupes }
}

async function repairHutStructure (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hut = hut || hutAnchor()
  if (!hut) return { skipped: 'no hut' }
  if (process.env.HUT_REPAIR === '0') return { skipped: 'disabled' }
  // repairing under attack means standing still placing blocks while a mob hits us - defer.
  if (nearHostile(bot, 10) && P().underArmored(bot)) return { skipped: 'hostiles near' }
  const schem = await loadHutSchem(bot.version)
  if (!schem) return { skipped: 'no schematic' }
  const st = schem.start(); const en = schem.end()
  const AIRRE = /^(air|cave_air|void_air)$/
  const missPlank = []                 // world coords wanting a plank the world lacks
  let doorLower = null                  // world coord of the door's LOWER cell (place the item once)
  let doorPresent = false
  const missFurn = []                   // { pos, kind, item, re }
  const FURN = {
    chest: { item: 'chest', re: /chest$/ },
    furnace: { item: 'furnace', re: /^furnace$/ },
    crafting_table: { item: 'crafting_table', re: /^crafting_table$/ }
  }
  // 1) scan the schematic, block-read each cell, classify what's MISSING.
  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const w = schem.getBlock(new Vec3(x, y, z))
    if (!w || !w.name || AIRRE.test(w.name)) continue // schema wants air/interior - never fill
    const wp = new Vec3(hut.x + (x - st.x), hut.y + (y - st.y), hut.z + (z - st.z))
    const g = bot.blockAt(wp)
    if (!g) continue // unloaded chunk - skip this pass
    if (/_planks$/.test(w.name)) { if (!/_planks$/.test(g.name)) missPlank.push(wp) }
    else if (/_door$/.test(w.name)) {
      if (/_door$/.test(g.name)) { doorPresent = true } else if (!doorLower || wp.y < doorLower.y) doorLower = wp // lowest door cell = where the item goes
    } else if (/crafting_table$/.test(w.name)) { if (!FURN.crafting_table.re.test(g.name)) missFurn.push({ pos: wp, kind: 'table', item: 'crafting_table', re: FURN.crafting_table.re }) } else if (/^furnace$|furnace$/.test(w.name)) { if (!FURN.furnace.re.test(g.name)) missFurn.push({ pos: wp, kind: 'furnace', item: 'furnace', re: FURN.furnace.re }) } else if (/chest$/.test(w.name)) { if (!FURN.chest.re.test(g.name)) missFurn.push({ pos: wp, kind: 'chest', item: 'chest', re: FURN.chest.re }) }
  }
  const wantDoor = !!doorLower && !doorPresent
  const missing = missPlank.length + (wantDoor ? 1 : 0) + missFurn.length
  if (!missing) { dbg('repairHut: intact - no-op'); return { planks: 0, doors: 0, furniture: 0, missing: 0 } }
  dbg('repairHut: ' + missing + ' cell(s) off (planks ' + missPlank.length + ', door ' + (wantDoor ? 1 : 0) + ', furniture ' + missFurn.length + ') - patching')
  say('creeper damage on my hut - patching ' + missing + ' block(s)')
  const res = require('./resources.js')
  const near = { x: hut.x + 2, y: hut.y + 1, z: hut.z + 2 }
  // helper: dig a natural intruder occupying a cell we need (dirt washed in / grass), never a build block
  const clearCell = async (wp, keepRe) => {
    const b = bot.blockAt(wp)
    if (b && !AIRRE.test(b.name) && !keepRe.test(b.name) && canBreakNaturally(b)) {
      try { if (bot.entity.position.distanceTo(wp) > 4) await navigate.gotoOnce(bot, new goals.GoalNear(wp.x, wp.y, wp.z, 2), 8000); const t = toolForBlock(bot, b.name); if (t) await bot.equip(t, 'hand').catch(() => {}); await bot.dig(b) } catch {}
    }
  }
  // 2) SHELL PLANKS - acquire in one batch, place BOTTOM-UP (each course/roof cell then has a
  //    solid neighbour below/beside to place against). oak to match the schematic (any plank
  //    still works structurally, but matching keeps the camp's mismatch count quiet).
  let plankDone = 0
  if (missPlank.length) {
    try { await res.acquire(bot, 'oak_planks', Math.min(missPlank.length, 128), { near, batch: 64, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: plank acquire failed (' + e.message + ')') }
    for (const wp of missPlank.sort((a, b) => a.y - b.y)) {
      if (isStopped()) break
      const g = bot.blockAt(wp); if (g && /_planks$/.test(g.name)) { plankDone++; continue }
      if (!(bot.inventory ? bot.inventory.items() : []).some(i => /_planks$/.test(i.name))) { dbg('repairHut: out of planks - ' + (missPlank.length - plankDone) + ' wall cell(s) left'); break }
      await clearCell(wp, /_planks$/)
      if (bot.entity.position.distanceTo(wp) > 4) { try { await navigate.gotoOnce(bot, new goals.GoalNear(wp.x, wp.y, wp.z, 2), 12000) } catch {} }
      if (await placeAt(bot, wp, /_planks$/)) plankDone++
      else dbg('repairHut: could not place plank at ' + wp.toString() + ' (' + placeAt.lastFail + ')')
    }
  }
  // 3) DOOR - one item hangs the whole 2-tall door. Stand OUTSIDE facing the hut centre so it
  //    opens the right way (schematic door on the z0 wall opens toward -z).
  let doorDone = 0
  if (wantDoor) {
    let door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name))
    if (!door) { try { await res.acquire(bot, 'oak_door', 1, { near, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: door acquire failed (' + e.message + ')') } ; door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name)) }
    const floor = bot.blockAt(doorLower.offset(0, -1, 0))
    if (door && floor && floor.boundingBox === 'block') {
      const ox = doorLower.x === hut.x ? -1 : doorLower.x === hut.x + hutModel.DIMS.w - 1 ? 1 : 0
      const oz = doorLower.z === hut.z ? -1 : doorLower.z === hut.z + hutModel.DIMS.l - 1 ? 1 : 0
      try { await navigate.gotoOnce(bot, new goals.GoalBlock(doorLower.x + ox, doorLower.y, doorLower.z + oz), 12000) } catch {}
      try { await bot.lookAt(new Vec3(hut.x + 2.5, hut.y + 1.5, hut.z + 2.5), true) } catch {}
      try { await bot.equip(door, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)); doorDone++ } catch (e) { dbg('repairHut: door place failed (' + e.message + ')') }
    } else if (!door) dbg('repairHut: no door and could not craft one')
  }
  // 4) FURNITURE - place each missing chest/furnace/table at its exact cell (the schematic's
  //    two adjacent chests auto-merge into the double bank). Re-register so the infra registry
  //    knows the rebuilt station.
  let furnDone = 0
  for (const f of missFurn) {
    if (isStopped()) break
    const g = bot.blockAt(f.pos); if (g && f.re.test(g.name)) { furnDone++; continue }
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name === f.item)) {
      try { await res.acquire(bot, f.item, 1, { near, batch: 1, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: ' + f.item + ' acquire failed (' + e.message + ')') }
    }
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name === f.item)) { dbg('repairHut: no ' + f.item + ' to place (kept a wall/door open? gather short)'); continue }
    await clearCell(f.pos, f.re)
    if (bot.entity.position.distanceTo(f.pos) > 3) { try { await navigate.gotoOnce(bot, new goals.GoalNear(f.pos.x, f.pos.y, f.pos.z, 2), 12000) } catch {} }
    if (await placeAt(bot, f.pos, f.re)) { furnDone++; rememberInfra(f.kind === 'table' ? 'table' : f.kind, f.pos); dbg('repairHut: re-placed ' + f.kind + ' at ' + f.pos.toString()) } else dbg('repairHut: could not place ' + f.kind + ' at ' + f.pos.toString() + ' (' + placeAt.lastFail + ')')
  }
  try { reconcileInfra(bot) } catch {}
  const done = plankDone + doorDone + furnDone
  if (done) say('hut repaired - ' + [plankDone && plankDone + ' wall', doorDone && 'door', furnDone && furnDone + ' station'].filter(Boolean).join(' + ') + ' back')
  dbg('repairHut: patched planks ' + plankDone + '/' + missPlank.length + ', door ' + doorDone + '/' + (wantDoor ? 1 : 0) + ', furniture ' + furnDone + '/' + missFurn.length)
  return { planks: plankDone, doors: doorDone, furniture: furnDone, missing }
}

async function recallAndReach (bot, kind, blockId, maxDist, reach) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const known = recallInfra(kind, bot.entity.position, maxDist)
    if (!known) return null
    dbg('  remembered ' + kind + ' at ' + known.x + ',' + known.y + ',' + known.z + ' - reusing it instead of placing a new one')
    await S().walkStaged(bot, known.x, known.z, { range: 10, timeoutMs: 60000 })
    const blk = bot.blockAt(new Vec3(known.x, known.y, known.z))
    if (!blk || blk.type !== blockId) { dbg('  remembered ' + kind + ' is gone - forgetting it'); forgetInfra(kind, known); continue }
    if (await reach(blk)) return blk
    return null // it stands but we can't reach it - placing fresh beats looping
  }
  return null
}

async function maintainHut (bot, hut, opts = {}) {
  hut = hut || hutAnchor()
  if (!hut) return { skipped: 'no hut' }
  try { reconcileInfra(bot) } catch (e) { dbg('maintainHut: reconcile failed (' + e.message + ')') }
  // STRUCTURAL REPAIR first: a hole in the shell lets mobs in and the bank chest may be gone
  // (live: a creeper flattened the door, west wall, bank chest, furnace + bed). Idempotent.
  let repair = null
  try { repair = await repairHutStructure(bot, hut, opts) } catch (e) { dbg('maintainHut: structural repair failed (' + e.message + ')') }
  const read = hutReader(bot)
  let strays, st, holes
  try { strays = hutModel.strayCells(hut, read); st = hutModel.stationCells(hut, read); holes = hutModel.floorHoles(hut, read) } catch (e) { dbg('maintainHut: scan failed (' + e.message + ')'); return { skipped: e.message, repair } }
  const dirty = strays.length || (st.table.length > 1) || (st.furnace.length > 1) || holes.length
  if (!dirty) { dbg('maintainHut: interior already clean - no-op'); return { clean: !repair || !repair.missing, repair } }
  dbg('maintainHut: interior dirty (stray=' + strays.length + ' tables=' + st.table.length + ' furnaces=' + st.furnace.length + ' holes=' + holes.length + ') - tidying')
  const r = await cleanupHutInterior(bot, hut, opts)
  return { ...r, repair }
}

// #117 HOME_IS_A_NEED - THE 'shelter' bootstrap producer, and the first code allowed to put the
// home back in order with NO BUILD JOB RUNNING. Root B, design §3.2 B2.
//
// The defect it closes: repairing/verifying the safehouse was step ~6 of an 11-step castle build,
// so it only ever progressed if that job ran AND survived steps 1-5. It never did, and the
// registry kept a hut at 456,68,-142 that had been "rebuilt" by a pass which placed 0/94 blocks -
// a coordinate box with no structure in it, which insideOwnStructure then answered "yes, I'm home"
// from, and boundedHold held the bot inside. Home was a chore; now it is a need with a producer.
//
// GROUNDED THROUGHOUT (§3.1): the only thing that makes this function claim a verified hut is a
// surveyCells verdict of OK, read from loaded chunks, in THIS life. UNKNOWN travels to the anchor
// and looks again; UNKNOWN after that claims NOTHING and says so out loud.
//
// NON-DESTRUCTIVE BY CONSTRUCTION (§5 anti-grief): this path can only PLACE missing cells, via
// maintainHome -> repairHutStructure. It never empties the bank, never calls clearVolume, and
// never sites or raises a first hut - the destructive rebuild and the initial raising both stay
// in the build's camp step, which owns the one implementation of each.
async function ensureHomeShelter (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const R = (ok, how, why) => { dbg('shelter: [' + how + '] ' + (why || '')); return { ok, how, why: why || '' } }
  if (!bot || !bot.entity) return R(false, 'failed', 'no body yet')
  const hut = opts.hut || hutAnchor()
  // No hut ON THE BOOKS at all: siting and raising the first one has exactly ONE implementation
  // and it is the build's camp step. Saying so honestly beats copying it (§8.2 - one operation,
  // one implementation), and bootstrapNeed never routes the homeless case here for that reason.
  if (!hut) return R(false, 'no-hut', 'no hut is registered - the camp step raises the first one')

  const pathfix = require('./pathfix.js')
  const schem = await loadHutSchem(bot.version)
  if (!schem) return R(false, 'failed', 'no hut schematic to check the safehouse against')
  const st = schem.start(); const en = schem.end()
  const cells = []
  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const w = schem.getBlock(new Vec3(x, y, z))
    cells.push({ pos: new Vec3(hut.x + (x - st.x), hut.y + (y - st.y), hut.z + (z - st.z)), want: (w && w.name) || 'air' })
  }
  const survey = () => pathfix.surveyCells(bot, cells, hutModel.cellMismatch)
  // A record verified by a survey we just took, in this life. rememberInfra REJECTS anything
  // weaker, which is the whole point - this is the only memory write site in this function.
  const claim = sv => { try { rememberInfra('hut', { x: hut.x, y: hut.y, z: hut.z }, { proof: { verdict: sv.verdict, epoch: pathfix.epoch() } }) } catch (e) { dbg('shelter: memory write rejected (' + e.message + ')') } }

  let sv = survey()
  if (sv.verdict === 'UNKNOWN') {
    // Not a failure - a "go and look". This is the trek that used to be locked inside the build.
    dbg('shelter: safehouse survey UNKNOWN (' + sv.unknown + '/' + sv.total + ' cells unreadable) - going to look')
    try { await S().walkStaged(bot, hut.x + 2, hut.z + 2, { isStopped, range: 4, timeoutMs: 300000 }) } catch (e) { dbg('shelter: approach failed (' + e.message + ')') }
    if (isStopped()) return R(false, 'failed', 'survival took the body before I could reach the safehouse')
    sv = survey()
  }
  if (sv.verdict === 'UNKNOWN') return R(false, 'failed', 'still cannot see the safehouse at ' + hut.x + ',' + hut.y + ',' + hut.z + ' (' + sv.unknown + '/' + sv.total + ' unreadable) - claiming nothing about it')
  if (sv.verdict === 'OK') { claim(sv); return R(true, 'verified', 'the safehouse at ' + hut.x + ',' + hut.z + ' stands intact - registry record verified') }

  // BAD, and SEEN to be bad. Patch in place; the bank is never opened by this path.
  say('my safehouse has ' + sv.bad + ' block(s) missing - patching it before anything else')
  let home = null
  try { home = await maintainHome(bot, { x: hut.x, y: hut.y, z: hut.z }, { isStopped, say }) } catch (e) { return R(false, 'failed', 'safehouse repair failed (' + e.message + ')') }
  // RE-READ. The repair's own return value is not evidence that a hut stands (§3.1).
  const after = survey()
  if (after.verdict === 'OK') { claim(after); return R(true, 'repaired', 'patched the safehouse at ' + hut.x + ',' + hut.z + ' - ' + sv.bad + ' cell(s) off, now clean') }
  if (after.verdict === 'UNKNOWN') return R(false, 'failed', 'lost sight of the safehouse mid-repair - claiming nothing')
  return R(false, 'partial', 'patched what I could at ' + hut.x + ',' + hut.z + ' but ' + after.bad + ' cell(s) are still off' + (home && home.damaged ? '' : ' (nothing was placed - out of materials?)'))
}

async function maintainHome (bot, hutAt, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hutAt = hutAt || hutAnchor()
  const out = { bed: null, bedUpgrade: null, chestFixed: false, repair: null, consolidated: 0, damaged: false }
  if (!hutAt) return out
  try { await ensureHutApron(bot, hutAt, { isStopped, say }) } catch (e) { dbg('camp: apron fill failed (' + e.message + ')') }
  // rebuild/verify the bed. Anything but 'present' means a bed was missing/placed/unplaceable
  // = the home needed work.
  try { const bs = await ensureHutBed(bot, hutAt, { isStopped, say }); out.bed = bs; dbg('camp: hut bed -> ' + bs); if (bs !== 'present') out.damaged = true } catch (e) { dbg('camp: hut bed failed (' + e.message + ')') }
  // #110 ANCHOR QUALITY - maintenance's business, never the spawn-critical path's. This runs
  // where the bot is AT the hut, in a repair window, with say wired and failure harmless; the
  // 45s keepalive timer that used to own this judgment was precisely the wrong executor.
  // Inert (one bedUsable read) when the anchor is fine, and it can only ever SWAP, never strand.
  try { const up = await upgradeBedPlacement(bot, { isStopped, say }); out.bedUpgrade = up.how; if (up.how === 'swapped') out.damaged = true } catch (e) { dbg('camp: bed upgrade failed (' + e.message + ')') }
  // BANK DOUBLE-CHEST HEAL (liveability, every pass): a rebuild that left the bank as two
  // mismatched single chests gets re-faced into one connected double. Idempotent: a merged
  // pair is a fast no-op (returns false).
  try { if (await P().healBankDouble(bot, { x: hutAt.x, y: hutAt.y, z: hutAt.z }, { isStopped, say })) { out.chestFixed = true; out.damaged = true; say('fixed the bank - one proper double chest again') } } catch (e) { dbg('camp: bank double-heal failed (' + e.message + ')') }
  // SPAWN re-assert: a bed standing in the hut is worthless if the server anchor drifted -
  // use it again so every death keeps coming home. A no-op when the anchored bed still stands
  // (condition-gated inside ensureSpawnBed, no time window).
  try { const r = await P().ensureSpawnBed(bot, { isStopped, say }); dbg('camp: spawn -> ' + r.how + (r.why ? ' (' + r.why + ')' : '')) } catch (e) { dbg('camp: spawn assert failed (' + e.message + ')') }
  // SELF-HEALING structure + interior (liveability, every pass): reconcile the registry, REPAIR
  // creeper damage (missing wall/door/furniture cells), then tidy the interior. Early no-op when
  // already clean+intact. repair.missing (0 = intact) is the cheap structural-damage signal.
  try { const mr = await maintainHut(bot, hutAt, { isStopped, say }); if (mr) { out.repair = mr.repair || null; if (mr.repair && mr.repair.missing) out.damaged = true; if (!mr.clean && !mr.skipped) { out.damaged = true; dbg('camp: hut self-heal -> ' + JSON.stringify({ ok: mr.ok, dug: mr.dug, dupes: mr.removedDupes, passes: mr.passes })) } } } catch (e) { dbg('camp: hut self-heal failed (' + e.message + ')') }
  // HOME BANK (operator promise): the hut chest is the ONE treasury - ferry every loose field
  // chest within 64 into it and pack the empties up. Idempotent.
  try { const nc = await P().consolidateBank(bot, hutAt, { isStopped, say }); if (nc) { out.consolidated = nc; out.damaged = true; dbg('camp: consolidated ' + nc + ' field chest(s) into the bank') } } catch (e) { dbg('camp: bank consolidation failed (' + e.message + ')') }
  return out
}

// SECURE_BASE (#67, default ON): spawn-proof the home. A base with only ~4 tunnel torches
// stays DARK, so mobs spawn all around every night and daylight-proof creepers/spiders linger
// to harass the bot AT HOME (nightRest: "no armor, mobs about"). A real player lights the
// perimeter + seals the shell. secureBase does both, as a bounded CALM-window step:
//   1) TORCH SUPPLY  - top up torches (ensureTorches; withdraw coal+stick from the bank if short).
//   2) LIGHT THE RING - place torches on solid ground on a spacing lattice around the hut (pure
//      baseTorchAnchors), targeting cells not yet lit; PERSIST each placed torch (world-mem
//      baseLight, keyed to the hut) so it converges across visits and self-heals a blown torch.
//   3) SEAL THE HUT  - reuse repairHutStructure to close wall/roof/door gaps mobs path through.
// Bounded (<=maxPlace torches/visit) and YIELDS to survival (isStopped). Never lights the crops
// (scaffold.onFarmFootprint) or inside the hut box. SECURE_BASE=0 -> the maintenance step never
// calls this (byte-for-byte); a direct call still early-returns here as a belt-and-braces guard.
async function secureBase (bot, opts = {}) {
  if (process.env.SECURE_BASE === '0') return { skipped: 'disabled', placed: 0 }
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const hut = opts.hut || hutAnchor()
  if (!hut) return { skipped: 'no hut', placed: 0 }

  const radius = Math.max(8, Math.min(32, Number(process.env.SECURE_BASE_RADIUS || 18)))
  const spacing = Math.max(4, Math.min(7, Number(process.env.SECURE_BASE_SPACING || 6)))
  const maxPlace = Math.max(1, Number(process.env.SECURE_BASE_MAX || 6))
  const darkTh = Number(process.env.SECURE_BASE_DARK || 8)
  const coverRadius = Math.max(2, Math.floor(spacing / 2))
  const want = Math.max(Number(process.env.SECURE_BASE_TORCHES || 12), maxPlace)

  // Persisted torched cells (world-mem), keyed to THIS hut so a relocated base starts fresh.
  const mem = loadWorldMem()
  let bl = mem.baseLight
  if (!bl || !bl.hut || bl.hut.x !== hut.x || bl.hut.z !== hut.z) { bl = mem.baseLight = { hut: { x: hut.x, z: hut.z }, torched: [] } }
  bl.torched = bl.torched || []
  // SELF-HEAL: forget any persisted torch the world no longer shows (a creeper blew it) so its
  // anchor re-opens and it gets re-lit. Keep entries whose chunk is unloaded (blockAt null).
  const beforeLen = bl.torched.length
  bl.torched = bl.torched.filter(t => { const b = bot.blockAt(new Vec3(t.x, t.y, t.z)); return !b || /torch/.test(b.name) })
  const healed = bl.torched.length !== beforeLen

  const anchors = hutModel.baseTorchAnchors(hut, { radius, spacing })
  let remaining = hutModel.secureBaseRemaining(anchors, bl.torched, { coverRadius })
  // Nearest-first: a bounded visit lights the closest dark ground, converging outward.
  const here = (bot.entity && bot.entity.position) || new Vec3(hut.x + 2, hut.y, hut.z + 2)
  remaining.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))

  // 1) TORCH SUPPLY - top up (never BLOCK on it; place what we have). Coal/stick from the bank
  //    (the #66 fuel path) then craft via the shared ensureTorches (bridge - mining owns it).
  if (remaining.length && countItem(bot, 'torch') < Math.min(want, remaining.length)) {
    try {
      const res = require('./resources.js')
      if (countItem(bot, 'coal') + countItem(bot, 'charcoal') < 1) { try { await res.withdrawItems(bot, 'coal', 8, { near: hut, maxDist: 64 }) } catch {} }
      if (countItem(bot, 'stick') < 1) { try { await res.withdrawItems(bot, 'stick', 4, { near: hut, maxDist: 64 }) } catch {} }
      await S().ensureTorches(bot, want)
    } catch (e) { dbg('  secureBase: torch supply failed (' + e.message + ')') }
  }

  // 2) LIGHT THE PERIMETER - bounded, survival-yielding. Reuse placeAt(/^torch$/) (the same
  //    primitive placeFarmTorches uses) at a solid, non-crop ground cell at/near each anchor.
  const scaffoldMod = (() => { try { return require('./scaffold.js') } catch { return null } })()
  const onFarm = (x, y, z) => { try { return !!(scaffoldMod && scaffoldMod.onFarmFootprint(new Vec3(x, y, z))) } catch { return false } }
  const NB = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
  let placed = 0
  for (const a of remaining) {
    if (isStopped() || placed >= maxPlace) break
    if (countItem(bot, 'torch') < 1) { dbg('  secureBase: out of torches - ' + (remaining.length - placed) + ' ring cell(s) still dark (resume next visit)'); break }
    let handled = false
    for (const [dx, dz] of NB) {
      if (handled) break
      const gx = a.x + dx; const gz = a.z + dz
      if (hutModel.inBox(hut, gx, gz)) continue // never inside the hut box
      for (let gy = hut.y + 3; gy >= hut.y - 3; gy--) { // scan a small Y band for the surface (grade isn't flat)
        const ground = bot.blockAt(new Vec3(gx, gy, gz))
        const air = bot.blockAt(new Vec3(gx, gy + 1, gz))
        if (!ground || ground.boundingBox !== 'block' || AIRISH(ground.name)) continue
        if (/water|lava|farmland/.test(ground.name)) continue
        if (!air || !AIRISH(air.name)) continue
        if (onFarm(gx, gy + 1, gz) || onFarm(gx, gy, gz)) { handled = true; break } // respect crops
        // LIGHT SKIP (best-effort; block-light is sparse on some servers): already bright enough?
        // defer without spending a torch. Not persisted, so it's cheaply re-checked next visit.
        try { const lv = air.light; if (typeof lv === 'number' && lv >= darkTh) { handled = true; break } } catch {}
        const cell = new Vec3(gx, gy + 1, gz)
        if (bot.entity && bot.entity.position.distanceTo(cell) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(gx, gy + 1, gz, 3), 8000) } catch {} }
        if (await placeAt(bot, cell, /^torch$/)) { placed++; bl.torched.push({ x: cell.x, y: cell.y, z: cell.z }); handled = true }
        break // this column's surface handled (placed or not); try the next neighbour column
      }
    }
  }
  if (placed || healed) { try { saveWorldMem() } catch {} }

  // 3) SEAL THE HUT - reuse the structural sealer (closes missing wall/roof/door cells so mobs
  //    can't path in). Idempotent no-op when the shell is intact.
  let sealed = null
  if (!isStopped()) { try { sealed = await repairHutStructure(bot, hut, { isStopped, say }) } catch (e) { dbg('  secureBase: seal failed (' + e.message + ')') } }

  if (placed) { dbg('  secureBase: lit ' + placed + ' perimeter cell(s) (ring ' + bl.torched.length + '/' + anchors.length + ' anchors)'); say('spawn-proofing home - lit ' + placed + ' dark spot(s) around the base') }
  return { placed, ringTorches: bl.torched.length, anchors: anchors.length, remaining: Math.max(0, remaining.length - placed), sealed }
}

// SEAL_HOME_DESCENTS (#89, default ON): CAP the cave/shaft mouths that funnel mobs up into the hut.
// secureBase (#67) only torches the SURFACE ring - nothing closes the UNDERGROUND routes. The bot's
// own abandoned mining descents (staircase entrances, failed shaft starts) are open ramps from the
// mob-filled cave straight up to the bed (live 08:17-08:20Z: 5 spawn-camp deaths in 4 min; and
// vanilla refuses sleep whenever a monster loiters in the bed's 8x5 box, walls notwithstanding).
// This bounded CALM-window step caps those openings within SEAL_RADIUS of home:
//   1) MINE-REGISTRY entrances (world-mem mines {x,z,top}): if the entrance column is an OPEN mouth
//      (airish cells leading down), place a solid filler cap at the entrance cell (x,top,z). The mine
//      record is KEPT (a future armored run may deliberately re-open it). The SINGLE most-recent
//      (active) mine is SKIPPED: enterExistingMine re-enters under gatherMovements, whose
//      blocksCantBreak denies every non-leaf block, so it can NOT dig through a cap - capping the
//      active mine would only orphan it (it forgets the record and re-digs elsewhere). Dormant older
//      mines are safe to seal (a later run re-opens them from scratch anyway).
//   2) DEATH-CLUSTER columns (grave ledger, last-48h, unretrieved, within SEAL_RADIUS): probe the
//      surface column above each death spot; an open hole (>=3 consecutive airish cells from the
//      local surface down) gets capped at its surface cell.
// Anti-grief (HARD): fills ONLY airish cells; NEVER on/inside the hut or its apron, the wheat-farm
// footprint, registered scaffold, or the castle build zone; every cap goes through the verified
// placeAt wrapper (world re-read). Bounded (<=SEAL_MAX_PER_PASS caps, SEAL_DEADLINE_MS deadline) and
// YIELDS to survival (isStopped re-checked before each cap). Material: FILLER_RE from the pack, else
// withdraw <=8 cobble from the bank (best-effort), else skip honestly. SEAL_HOME_DESCENTS=0 -> the
// maintenance step never calls this (byte-for-byte); a direct call still early-returns here.
async function sealHomeDescents (bot, opts = {}) {
  if (process.env.SEAL_HOME_DESCENTS === '0') return { skipped: 'disabled', capped: 0 }
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const hut = opts.hut || hutAnchor()
  if (!hut) return { skipped: 'no hut', capped: 0 }

  const radius = Math.max(8, Math.min(64, Number(process.env.SEAL_RADIUS || 32)))
  const maxCaps = Math.max(1, Number(process.env.SEAL_MAX_PER_PASS || 4))
  const deadline = Date.now() + Number(process.env.SEAL_DEADLINE_MS || 90000)

  const scaffoldMod = (() => { try { return require('./scaffold.js') } catch { return null } })()
  const FILLER_RE = (scaffoldMod && scaffoldMod.FILLER_RE) || /^(cobblestone|dirt|coarse_dirt|stone|gravel|andesite|diorite|granite|cobbled_deepslate|netherrack|tuff|deepslate)$/
  const haveFiller = () => (bot.inventory ? bot.inventory.items() : []).some(i => FILLER_RE.test(i.name))
  // MATERIAL: cobble/dirt from the pack; top up from the bank if bare (never BLOCK on it). Honest skip if none.
  if (!haveFiller()) {
    try { const res = require('./resources.js'); await res.withdrawItems(bot, 'cobblestone', 8, { near: hut, maxDist: 64 }) } catch {}
  }
  if (!haveFiller()) { dbg('  seal: no filler aboard and none banked - skipping this pass'); return { skipped: 'no filler', capped: 0 } }

  // anti-grief: cells we must NEVER cap. onHutApron covers the hut box + a 2-block apron ring (XZ).
  const onFarm = (x, y, z) => { try { return !!(scaffoldMod && scaffoldMod.onFarmFootprint(new Vec3(x, y, z))) } catch { return false } }
  const isScaffold = (x, y, z) => { try { return !!(scaffoldMod && scaffoldMod.isScaffold({ x, y, z })) } catch { return false } }
  const inBuild = (x, z) => { try { return !!P().inBuildZone(x, z) } catch { return false } }
  const protectedCell = (x, y, z) =>
    !!onHutApron(bot, new Vec3(x, y, z)) ||
    onFarm(x, y, z) || onFarm(x, y - 1, z) ||
    isScaffold(x, y, z) ||
    inBuild(x, z)

  // an OPEN descent mouth worth capping: the cap cell itself is airish (never replace a solid) AND
  // the shaft below leads down (>=3 consecutive airish cells from the cap cell going down).
  const openMouth = (x, capY, z) => {
    let run = 0
    for (let dy = 0; dy <= 3; dy++) {
      const b = bot.blockAt(new Vec3(x, capY - dy, z))
      if (b && AIRISH(b.name)) run++
      else break
    }
    return run >= 3
  }
  // death-hole surface cell: feet-level air over the highest intact NEIGHBOUR ground (matches the
  // mine 'top' = feet-Y semantics). null when no intact neighbour surface is loaded around it.
  const deathCapY = (x, z) => {
    let top = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let y = hut.y + 5; y >= hut.y - 8; y--) {
        const g = bot.blockAt(new Vec3(x + dx, y, z + dz)); const air = bot.blockAt(new Vec3(x + dx, y + 1, z + dz))
        if (g && g.boundingBox === 'block' && !AIRISH(g.name) && air && AIRISH(air.name)) { if (top == null || y + 1 > top) top = y + 1; break }
      }
    }
    return top
  }

  // 1) MINE ENTRANCES - skip the single most-recent (active) mine; only dormant older ones.
  const mines = (() => { try { return worldMemory.loadMines() } catch { return [] } })()
  const active = mines.length ? mines.reduce((a, b) => ((b.at || 0) > (a.at || 0) ? b : a)) : null
  const caps = []
  for (const m of mines) {
    if (m === active) continue
    if (m.top == null) continue
    if (Math.hypot(m.x - hut.x, m.z - hut.z) > radius) continue
    caps.push({ x: m.x, y: m.top, z: m.z, kind: 'mine-entrance' })
  }
  // 2) DEATH-CLUSTER HOLES - last-48h, unretrieved, within radius.
  const now = Date.now()
  const ledger = (() => { try { return require('./grave.js').ledger() } catch { return [] } })()
  for (const d of ledger) {
    if (!d || d.x == null || d.retrieved) continue
    if (now - (d.at || 0) >= 48 * 3600 * 1000) continue
    if (Math.hypot(d.x - hut.x, d.z - hut.z) > radius) continue
    const cy = deathCapY(Math.floor(d.x), Math.floor(d.z))
    if (cy != null) caps.push({ x: Math.floor(d.x), y: cy, z: Math.floor(d.z), kind: 'death-hole' })
  }

  // nearest-first so a bounded visit seals the closest ramps; place the verified caps.
  const here = (bot.entity && bot.entity.position) || new Vec3(hut.x + 2, hut.y, hut.z + 2)
  caps.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))
  let capped = 0
  for (const c of caps) {
    if (isStopped() || Date.now() > deadline || capped >= maxCaps) break
    const { x, y, z, kind } = c
    if (protectedCell(x, y, z)) continue
    if (!haveFiller()) { dbg('  seal: out of filler - ' + (caps.length - capped) + ' descent(s) still open (resume next visit)'); break }
    if (!openMouth(x, y, z)) continue
    const cell = new Vec3(x, y, z)
    if (bot.entity && bot.entity.position.distanceTo(cell) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(x, y, z, 3), 10000) } catch {} }
    // re-read after the walk (chunk may have (un)loaded / the world moved): re-gate before placing.
    if (protectedCell(x, y, z) || !openMouth(x, y, z)) continue
    if (await placeAt(bot, cell, FILLER_RE)) { capped++; dbg('  seal: capped descent at ' + x + ',' + y + ',' + z + ' (' + kind + ')') } else dbg('  seal: could not cap ' + kind + ' at ' + x + ',' + y + ',' + z + ' (' + placeAt.lastFail + ')')
  }
  if (capped) say('sealed ' + capped + ' open cave/shaft mouth(s) near home so mobs stop funnelling up to the hut')
  return { capped, candidates: caps.length }
}

// WORLD_TIDY (#94, default ON): actively RECLAIM orphaned litter near own infra. The scaffold
// registry is empty (interrupted ops + restarts + unregistered placements), so scaffold teardown
// alone cannot help - the world holds ~2 days of leveling/pillar scraps, cobble on the hut,
// floating dirt in the farm, and duplicate-torch clusters. This bounded CALM-window step SCANS
// within TIDY_RADIUS of each own infra anchor (hut, wheat-farm, orchard), classifies each
// filler/torch cell through the PURE hutModel.litterSignature, and digs up to TIDY_MAX verified
// digs/pass, collecting the drops and depositing the reclaimed filler to the bank (best-effort).
// Anti-grief (HARD): only filler-class or torch blocks; only within TIDY_RADIUS of OWN infra;
// NEVER in the castle build zone (P().inBuildZone), on a registered station/chest/bed cell, on
// schema-matching hut fabric, or on crops/farmland/saplings/trees; every dig RE-READS the world
// (re-classify + canDigBlock reach) before breaking. Bounded (<=TIDY_MAX digs, a scan cap, and
// isStopped-yielding). WORLD_TIDY=0 -> the maintenance step never calls this (byte-for-byte); a
// direct call still early-returns here as a belt-and-braces guard.
async function worldTidy (bot, opts = {}) {
  if (process.env.WORLD_TIDY === '0') return { skipped: 'disabled', reclaimed: 0 }
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const R = Math.max(8, Math.min(48, Number(process.env.TIDY_RADIUS || 24)))
  const MAX = Math.max(1, Number(process.env.TIDY_MAX || 24))
  const yBand = Math.max(2, Number(process.env.TIDY_Y_BAND || 6))
  const scanCap = Math.max(1000, Number(process.env.TIDY_SCAN_CAP || 40000)) // safety ceiling; near-first order + periodic yields keep it responsive
  const farmBand = Math.max(1, Number(process.env.TIDY_FARM_BAND || 3))
  const CROP_RE = /(wheat|carrots|potatoes|beetroots|_stem|pumpkin|melon|nether_wart|sweet_berry|cocoa)$/
  const TREE_RE = /(_sapling|_log|_wood|_leaves|mushroom|_stem)$/

  // --- own infra anchors + plot footprints --------------------------------------------
  const m = loadWorldMem()
  const anchors = []
  for (const h of listInfra('hut')) anchors.push({ x: h.x + 2, y: h.y, z: h.z + 2, hut: h })
  const plots = []
  const addPlot = (cells) => {
    if (!cells || !cells.length) return
    let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity; let cy = null
    for (const c of cells) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); z0 = Math.min(z0, c.z); z1 = Math.max(z1, c.z); if (c.y != null) cy = cy == null ? c.y : Math.min(cy, c.y) }
    if (cy == null) return
    plots.push({ x0, x1, z0, z1, loY: cy, hiY: cy + farmBand - 1 }) // cy = crop/sapling level; the ground below (cy-1) is never in-band
  }
  const wf = m.wheatFarm
  if (wf && wf.cells && wf.cells.length) { anchors.push({ x: wf.x, y: (wf.y != null ? wf.y : wf.cells[0].y), z: wf.z }); addPlot(wf.cells) }
  const orch = m.orchard
  if (orch && orch.cells && orch.cells.length) { anchors.push({ x: orch.x, y: orch.cells[0].y - 1, z: orch.z }); addPlot(orch.cells) }
  else if (orch && orch.x != null && orch.z != null) anchors.push({ x: orch.x, y: (bot.entity ? Math.floor(bot.entity.position.y) : 64), z: orch.z })
  if (!anchors.length) return { skipped: 'no infra', reclaimed: 0 }

  const huts = listInfra('hut')
  const DIMS = hutModel.DIMS
  // A cell on the hut wall-face/roof exterior layer (ABOVE the floor slab, so the doorstep apron
  // walk-surface at ground level is never touched). Returns the containing hut, else null.
  const hutExteriorOf = (x, y, z) => {
    for (const h of huts) {
      const x0 = h.x; const x1 = h.x + DIMS.w - 1; const z0 = h.z; const z1 = h.z + DIMS.l - 1; const y0 = h.y; const y1 = h.y + DIMS.h - 1
      if (y === y1 + 1 && x >= x0 && x <= x1 && z >= z0 && z <= z1) return h // resting on the roof
      if (y >= y0 + 1 && y <= y1) {
        const withinZ = z >= z0 && z <= z1; const withinX = x >= x0 && x <= x1
        if ((withinZ && (x === x0 - 1 || x === x1 + 1)) || (withinX && (z === z0 - 1 || z === z1 + 1))) return h // stuck to a wall face
      }
    }
    return null
  }
  const hutContaining = (x, z) => huts.find(h => hutModel.inBox(h, x, z)) || null
  const inFarmPlot = (x, y, z) => plots.some(p => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && y >= p.loY && y <= p.hiY)
  const inBuild = (x, z) => { try { return !!P().inBuildZone(x, z) } catch { return false } }
  const infraCells = []
  for (const kind of ['table', 'furnace', 'chest', 'bed']) for (const e of listInfra(kind)) infraCells.push(e)
  const kb = (() => { try { return knownBed() } catch { return null } })()
  if (kb) infraCells.push(kb)
  const isRegistered = (x, y, z) => infraCells.some(e => e.x === x && e.y === y && e.z === z)

  const read = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const airish = b => !b || AIRISH(b.name)
  const airFacesAt = (x, y, z) => {
    let n = 0
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (airish(read(x + dx, y + dy, z + dz))) n++
    return n
  }
  const sidesAirAt = (x, y, z) => {
    let n = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (airish(read(x + dx, y, z + dz))) n++
    return n
  }
  const towerRunAt = (x, y, z) => {
    let run = 1
    for (let dy = 1; dy <= 8; dy++) { const b = read(x, y + dy, z); if (b && hutModel.isTidyFiller(b.name)) run++; else break }
    for (let dy = 1; dy <= 8; dy++) { const b = read(x, y - dy, z); if (b && hutModel.isTidyFiller(b.name)) run++; else break }
    return run
  }
  const torchClusterAt = (x, y, z) => {
    const out = []
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const b = read(x + dx, y + dy, z + dz)
      if (b && hutModel.isTidyTorch(b.name)) out.push({ x: x + dx, y: y + dy, z: z + dz })
    }
    return out
  }
  // Build the per-cell ctx and classify. Cheap early-out: non-litter cells never do neighbour reads.
  const classifyAt = (x, y, z) => {
    const b = read(x, y, z)
    if (!b) return null
    const torch = hutModel.isTidyTorch(b.name)
    const filler = hutModel.isTidyFiller(b.name)
    if (!torch && !filler) return null // not a litter class - skip without any neighbour reads
    const hut = hutContaining(x, z)
    let hutSchemaFabric = false
    if (hut && y >= hut.y && y <= hut.y + DIMS.h - 1) { try { const c = hutModel.classifyCell(hut, hutReader(bot), x, y, z); hutSchemaFabric = c && (c.cls === 'wall' || c.cls === 'door' || c.cls === 'floor' || c.cls === 'furniture') } catch {} }
    const ctx = {
      name: b.name,
      self: { x, y, z },
      hutSchemaFabric,
      isFarmland: /farmland$/.test(b.name),
      isCrop: CROP_RE.test(b.name),
      isTree: TREE_RE.test(b.name),
      onHutExterior: !!hutExteriorOf(x, y, z),
      inFarmPlot: inFarmPlot(x, y, z),
      airFaces: torch ? 0 : airFacesAt(x, y, z),
      sidesAir: torch ? 0 : sidesAirAt(x, y, z),
      towerRun: torch ? 0 : towerRunAt(x, y, z),
      torchCluster: torch ? torchClusterAt(x, y, z) : null
    }
    return { b, ctx, res: hutModel.litterSignature(ctx) }
  }

  // --- SCAN: bounded box per anchor, NEAREST-COLUMN first so the examined budget is always spent
  // on the cells closest to home (litter clusters at the base) and a clean far world can't crowd
  // out near litter. Cheap early-out on non-litter cells (no neighbour reads). Yields the event
  // loop periodically so a large clean-world sweep never hitches the body ([[body-first-priority]]).
  const columns = []
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) { const d = Math.hypot(dx, dz); if (d <= R) columns.push({ dx, dz, d }) }
  columns.sort((a, b) => a.d - b.d)
  const seen = new Set()
  const candidates = []
  let examined = 0
  const candCap = MAX * 3
  scan:
  for (const a of anchors) {
    const ay = Math.floor(a.y)
    const yHi = ay + Math.max(yBand, DIMS.h + 2)
    for (const col of columns) {
      if (isStopped()) break scan
      const x = a.x + col.dx; const z = a.z + col.dz
      for (let y = ay - yBand; y <= yHi; y++) {
        const k = x + ',' + y + ',' + z
        if (seen.has(k)) continue
        seen.add(k)
        if (++examined > scanCap) break scan
        if ((examined & 4095) === 0) { if (isStopped()) break scan; await new Promise(r => setImmediate(r)) } // breathe
        const c = classifyAt(x, y, z)
        if (!c || c.res.decision !== 'dig') continue
        if (inBuild(x, z) || isRegistered(x, y, z)) continue // executor belt-and-braces
        candidates.push({ x, y, z, sig: c.res.sig, name: c.b.name })
        if (candidates.length >= candCap) break scan
      }
    }
  }
  if (!candidates.length) { dbg('  worldTidy: nothing to reclaim (examined ' + examined + ' cell(s) near ' + anchors.length + ' anchor(s))'); return { reclaimed: 0, candidates: 0, examined } }

  // nearest-first so a bounded visit clears the closest mess; verified digs up to MAX.
  const here = (bot.entity && bot.entity.position) || new Vec3(anchors[0].x, anchors[0].y, anchors[0].z)
  candidates.sort((p, q) => Math.hypot(p.x - here.x, p.z - here.z) - Math.hypot(q.x - here.x, q.z - here.z))
  let reclaimed = 0
  for (const c of candidates) {
    if (isStopped() || reclaimed >= MAX) break
    const p = new Vec3(c.x, c.y, c.z)
    if (bot.entity && bot.entity.position.distanceTo(p) > 4) { try { await navigate.gotoOnce(bot, new goals.GoalNear(c.x, c.y, c.z, 2), 10000) } catch {} }
    // RE-READ + re-classify after the walk (chunk (un)loaded / world moved / an earlier dig changed
    // the neighbourhood): re-gate before breaking, exactly the verified-dig contract.
    const re = classifyAt(c.x, c.y, c.z)
    if (!re || re.res.decision !== 'dig') continue
    if (inBuild(c.x, c.z) || isRegistered(c.x, c.y, c.z)) continue
    const b = re.b
    const tool = toolForBlock(bot, b.name); if (tool) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) { dbg('  worldTidy: cannot reach ' + b.name + ' at ' + p.toString() + ' this pass'); continue }
    try {
      await bot.dig(b)
      await collectDrops(bot, 3)
      const after = bot.blockAt(p)
      if (after && !AIRISH(after.name) && after.name === b.name) { dbg('  worldTidy: dig did not clear ' + b.name + ' at ' + p.toString()); continue }
      reclaimed++
      dbg('  tidy: reclaimed ' + c.name + ' at ' + c.x + ',' + c.y + ',' + c.z + ' (' + c.sig + ')')
    } catch (e) { dbg('  worldTidy: dig failed at ' + p.toString() + ' (' + e.message + ')') }
  }

  // BEST-EFFORT: deposit the reclaimed filler surplus to the bank (keep a small working buffer so
  // the sealer/scaffold still has filler on hand). Never blocks the pass; any failure is swallowed.
  if (reclaimed) {
    try {
      const bank = S().resolveBankCell(bot) // #94 fix: resolveBankCell lives on the __siblings bridge, not the facade (caught by the core builder's bridge audit)
      if (bank) {
        const keepEach = Math.max(0, Number(process.env.TIDY_KEEP_FILLER || 64))
        const deposits = []
        for (const it of (bot.inventory ? bot.inventory.items() : [])) {
          if (!hutModel.isTidyFiller(it.name)) continue
          const drop = it.count - keepEach
          if (drop > 0) deposits.push({ name: it.name, count: drop })
        }
        if (deposits.length) {
          const chestBlock = bot.blockAt(new Vec3(bank.x, bank.y, bank.z))
          if (chestBlock && /chest$/.test(chestBlock.name)) await P().depositMaterials(bot, chestBlock, { deposits })
        }
      }
    } catch (e) { dbg('  worldTidy: bank deposit failed (' + e.message + ')') }
    say('tidied up around home - reclaimed ' + reclaimed + ' bit(s) of litter')
    dbg('  worldTidy: reclaimed ' + reclaimed + ' litter block(s) of ' + candidates.length + ' candidate(s) (examined ' + examined + ')')
  }
  return { reclaimed, candidates: candidates.length, examined }
}

module.exports = {
  setDebugSink, insideHutBox,
  insideHutBox, ownHutAt, onHutApron, insideOwnStructure, hasSolidCeiling, hutAnchor, hutReader, ensureHomeShelter, stepOffApron, ensureHutApron, healHomeCrater, ensureHutBed, bedInPack, bedCandidates, acquireBed, placeBedNear, bedFootprint, bedUsable, assertSpawnOn, ensureBedSite, upgradeBedPlacement, freeInteriorCell, findHutDoorway, hutFreeCells, furnitureInHut, stationInHut, stationSlot, loadHutSchem, reconcileInfra, cleanupHutInterior, repairHutStructure, recallAndReach, maintainHut, maintainHome,
  secureBase, secureBaseGate: hutModel.secureBaseGate,
  sealHomeDescents, sealDescentsGate: hutModel.sealDescentsGate,
  worldTidy, litterSignature: hutModel.litterSignature
}
