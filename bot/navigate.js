'use strict'
// UNIFIED NAVIGATION. One entry point - navigateTo() - with the full stuck-recovery
// toolkit baked in, so every caller (goto/come/recover/travel/nightRest/treks) gets the
// same rescues instead of whichever hacks happened to be wired into its loop. Before
// this, door-assist lived only in travelFar (the bot sat "no path" inside its own hut on
// a plain goto), pit-escape only in travelFar+walkStaged, the water-hop only in
// walkStaged... reliable on one route, permanently stuck on another.
//
// Design mirrors buildSurvival's grounded loop: act -> re-read the world -> decide from
// real state. A recovery only "counts" if the bot demonstrably moved; when the toolkit
// is spent it gives up HONESTLY (the error says what it tried) instead of hanging.
//
// Layering: commands.js / provision.js / schematic.js all require this module. The
// recovery primitives that need dig/scaffold machinery (climbToSurface, pillarUpTo,
// manualHopFromWater) stay in provision.js and are require()d LAZILY at call time -
// provision requires us at load, we require it only once both are fully loaded.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const arbiter = require('./arbiter.js') // priority body-ownership: reflexes defer to a running maneuver
const navProfile = require('./nav-profile.js') // PURE terrain policy - findDryLandExit (WATER_ESCAPE); no bot-module cycle

let dbgSink = null // injected by index.js: debug lines persist to logs/bot-events.log
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[nav] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const prov = () => require('./provision.js') // lazy - see layering note above

// ---- reflex arbitration ------------------------------------------------------------
// While a recovery is physically maneuvering (pillaring out of a pit, threading a
// doorway, hopping from water) the flee/defend reflexes must not hijack the pathfinder
// sideways - the recovery IS the escape. index.js checks this next to isEscaping().
let recoveringDepth = 0
function isRecovering () { return recoveringDepth > 0 }
// Active navigations (for observability + later flow arbitration).
let navDepth = 0
function isNavigating () { return navDepth > 0 }
// A watchdog force-escape is driving on manual controls - other gotos must stand down.
let forceUnsticking = false
function isForceUnsticking () { return forceUnsticking }

// PHASE A flag: the bounded reactive-move primitive (reactiveMove, below) is the PRIMARY tool
// for time-critical short moves (creeper flee, low-hp radial retreat, hut-retreat approach,
// recovery nudge/stepout) instead of a long, timeout-prone goto. =0 => every adopter falls
// back to its exact current call and the primitive is defined but unreferenced (today
// byte-for-byte). Default ON.
const REACTIVE_MOVE_ON = process.env.NAV_REACTIVE_MOVE !== '0'

// WATER_ESCAPE (task #48, DEFAULT OFF): the water-stuck livelock fix. OFF (unset / !== '1') =>
// byte-for-byte today (blind nearest-bank picker + the unsatisfiable onGround/dry-feet success
// test + no trek anti-fight). ON => the recovery `water` rung relocates to the nearest REACHABLE,
// DRY, goal-biased land cell (findDryLandExit + escapeToDryLand), the drown reflex's success label
// becomes FEET-based (stops the head-based false victory), and walkStaged stops re-aiming a leg
// back into the pond while an escape owns the body.
const WATER_ESCAPE = process.env.WATER_ESCAPE === '1'

// #63 SUICIDE_DIES §B.1: the DELIBERATE-DROWN latch. During the last-resort suicide-reset
// (provision.deadlockDieByFall's drown fallback) the bot walks into deep water ON PURPOSE and must
// let its oxygen deplete to death - so while this latch is set the drown-escape reflexes
// (escapeWater / escapeToDryLand) MUST NOT swim it out. The latch is OFF by default and only ever
// true inside that bounded drown attempt (set there, cleared in a finally), so a NORMAL accidental
// water entry ALWAYS still escapes byte-for-byte. provision.js toggles it via setDeliberateDrown().
let deliberateDrown = false
function setDeliberateDrown (v) { deliberateDrown = !!v }
function isDeliberateDrown () { return deliberateDrown }
// PURE guard predicate (unit-tested): should the drown-escape reflex SKIP escaping (i.e. leave the
// bot submerged)? ONLY when a deliberate drown is in progress. deliberate=false => never skips, so
// the reflex escapes exactly as today (byte-for-byte when no suicide-drown is active).
function drownReflexSkips (deliberate) { return !!deliberate }

// ---- the ONE deadline-goto ----------------------------------------------------------
// pathfinder.goto with a hard deadline. An unreachable target can hang goto FOREVER
// (verified live: froze a 432-block build for 10+ minutes; froze the whole brain loop).
// This used to exist as three identical copies (commands/provision/schematic).
async function gotoOnce (bot, goal, ms = 20000, gopts = {}) {
  // Yield to a watchdog FORCE-ESCAPE and to any ACTIVE RECOVERY maneuver: their manual
  // control-state driving must not fight a concurrent goto's physics ticks (the pathfinder
  // rewrites the controls every tick, so the manual escape LOSES - live: step-out rungs
  // reported 'no progress' for 3+ minutes at 433,62,112 while another flow's goto stomped
  // them). Bounded wait. Door-assist's own gotos pass duringRecovery to skip the gate
  // (they ARE the recovery).
  if ((forceUnsticking || recoveringDepth > 0) && !gopts.duringRecovery) {
    const t0 = Date.now()
    while ((forceUnsticking || recoveringDepth > 0) && Date.now() - t0 < 45000) await new Promise(r => setTimeout(r, 250))
  }
  // SCAFFOLD SESSION: any block the pathfinder places while EXECUTING a goto (bridge,
  // 1x1 tower) is by definition movement scaffold, never build fabric - build blocks
  // are placed after the goto completes. The bracket lets the scaffold manager tag and
  // later tear down exactly those, even right next to a build made of the same material.
  const scaffold = require('./scaffold.js')
  scaffold.beginSession('goto')
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; scaffold.endSession(); fn(v) } }
    const timer = setTimeout(() => {
      try { bot.pathfinder.setGoal(null) } catch {}
      done(reject, new Error('goto timed out'))
    }, ms)
    bot.pathfinder.goto(goal).then(
      () => { clearTimeout(timer); done(resolve) },
      e => { clearTimeout(timer); done(reject, e) }
    )
  })
}

// A goto rejection that means "someone else took the pathfinder" (a reflex setGoal, a
// concurrent flow) rather than "no route exists".
function goalWasChanged (e) { return /goal.*chang|chang.*goal/i.test((e && e.message) || '') }

// Best-effort target XZ out of any pathfinder goal (for aiming the jump-nudge).
function goalXZ (goal) {
  if (!goal) return null
  if (typeof goal.x === 'number' && typeof goal.z === 'number') return { x: goal.x, z: goal.z }
  if (goal.pos && typeof goal.pos.x === 'number') return { x: goal.pos.x, z: goal.pos.z }
  if (goal.entity && goal.entity.position) return { x: goal.entity.position.x, z: goal.entity.position.z }
  return null
}
function goalY (goal) {
  if (!goal) return null
  if (typeof goal.y === 'number') return goal.y
  if (goal.pos && typeof goal.pos.y === 'number') return goal.pos.y
  return null
}

// ---- situation detectors ------------------------------------------------------------
const AIRISH = (n) => /^(air|cave_air|void_air)$/.test(n)

function feetInWater (bot) {
  const b = bot.blockAt(bot.entity.position.floored())
  return !!b && /water/.test(b.name)
}

// DEEP-water rescue: manualHopFromWater only handles standing in a shallow trench with
// a bank RIGHT THERE - swimming mid-river it finds no adjacent bank and gives up while
// the pathfinder can't plan a single move (watched live: legs no-pathed in <1s each and
// the trek "blocked" in 2 seconds mid-channel). Do what a player does: float up, pick
// the nearest shore cell, and swim straight at it on manual controls.
async function swimToShore (bot, isStopped = () => false) {
  const feet = bot.entity.position.floored()
  // water surface: first non-water cell going up
  let ySurf = feet.y
  for (let dy = 0; dy <= 12; dy++) {
    const b = bot.blockAt(new Vec3(feet.x, feet.y + dy, feet.z))
    if (!b || !/water/.test(b.name)) { ySurf = feet.y + dy; break }
  }
  // nearest bank: solid ground within +-2 of the surface with 2 cells of headroom
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
  let bank = null; let bestD = Infinity
  for (const [dx, dz] of dirs) {
    for (let r = 2; r <= 14; r++) {
      const x = feet.x + dx * r; const z = feet.z + dz * r
      for (let dy = 1; dy >= -2; dy--) {
        const g = bot.blockAt(new Vec3(x, ySurf + dy - 1, z))
        const s1 = bot.blockAt(new Vec3(x, ySurf + dy, z))
        const s2 = bot.blockAt(new Vec3(x, ySurf + dy + 1, z))
        if (!g || g.boundingBox !== 'block' || /water|lava/.test(g.name)) continue
        if (!s1 || (!AIRISH(s1.name) && !/water/.test(s1.name))) continue
        if (!s2 || !AIRISH(s2.name)) continue
        const d = Math.hypot(dx * r, dz * r)
        if (d < bestD) { bestD = d; bank = new Vec3(x, ySurf + dy, z) }
        r = 99 // first hit along this ray is the shore - stop marching it
        break
      }
    }
  }
  if (!bank) { dbg('swim: no shore within 14 - staying put'); return false }
  dbg('swim: heading for the bank at ' + bank)
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    const t0 = Date.now()
    bot.setControlState('jump', true) // float/climb the water column
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    while (Date.now() - t0 < 15000 && !isStopped()) {
      try { await bot.lookAt(new Vec3(bank.x + 0.5, bot.entity.position.y + 0.4, bank.z + 0.5), true) } catch {}
      await new Promise(r => setTimeout(r, 120))
      const f = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (bot.entity.onGround && f && f.boundingBox === 'block' && !/water/.test(f.name) && !feetInWater(bot)) {
        dbg('swim: ashore on ' + f.name + ' at ' + bot.entity.position.floored())
        return true
      }
    }
  } finally { bot.clearControlStates() }
  dbg('swim: still wet after 15s')
  return false
}

// HEAD underwater? The SAME predicate survivalState uses to emit the 'drowning' need
// (head block water/seagrass/kelp/bubble_column) - shared here so the escape's while-loop
// tests exactly the condition that fired it (never "near water", only actually submerged).
function headInWater (bot) {
  try { const h = bot.entity && bot.blockAt(bot.entity.position.floored().offset(0, 1, 0)); return !!(h && /water|seagrass|kelp|bubble_column/.test(h.name)) } catch { return false }
}

// ROOFED-FLOOD rung: no shore to swim to and no adjacent bank to hop - so rise straight UP
// the water column toward an air pocket (face up, hold jump = swim up in water). Bounded.
// Deliberately NOT climbToSurface (its digs REFUSE water, provision.js:2137 - it would
// no-op in a flooded shaft); this just floats the head up to whatever air the column has.
async function jumpForAir (bot, ms = 6000, isStopped = () => false) {
  const t0 = Date.now()
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.setControlState('jump', true)
    bot.setControlState('forward', true) // nudge along the column - a 1-wide flooded shaft often has air just off-axis
    while (Date.now() - t0 < ms && !isStopped()) {
      try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch {} // look up so the swim-stroke rises
      await new Promise(r => setTimeout(r, 120))
      if (!headInWater(bot)) { dbg('air: head cleared the water rising the column'); return true }
    }
  } finally { bot.clearControlStates() }
  return !headInWater(bot)
}

// DROWN-ESCAPE: the bounded, re-entrant, arbiter-coordinated water escape. The acute fix for
// "drowned gear-mining into a pond aquifer" - AUTO_SURFACE's swimToShore alone LOST because a
// still-running job loop kept re-setting a pathfinder goal and the pathfinder rewrote the
// controls every tick (navigate.js:50-55). The job loops now stopDigging + setGoal(null) and
// AWAIT this; the index.js drown-crisis reflex fires it as a backstop/override. Opens a SURVIVE
// maneuver span so lower reflexes defer. Every rung is bounded (swim 15s + hop 2.5s/dir + air 6s,
// whole call capped at deadlineMs) and it returns an HONEST bool (still wet? false) - never wedges.
let escapingWater = false
async function escapeWater (bot, { isStopped = () => false, deadlineMs = 35000 } = {}) {
  if (drownReflexSkips(deliberateDrown)) { dbg('drown-escape: deliberate-drown latch set (suicide-reset) - NOT escaping, letting it drown'); return false } // #63 §B.1
  if (escapingWater) return false // re-entrant guard: one escape at a time (reflex + job loop can both call)
  escapingWater = true
  const tok = arbiter.beginManeuver('drown-escape', arbiter.PRIORITY.SURVIVE, deadlineMs + 5000)
  try {
    const dl = Date.now() + deadlineMs
    const wet = () => headInWater(bot)
    if (!wet()) return true
    try { bot.stopDigging() } catch {} // a mid-dig await would otherwise hold the body underwater
    try { bot.pathfinder.setGoal(null) } catch {}
    while (wet() && Date.now() < dl && !isStopped()) {
      arbiter.refreshManeuver(tok, deadlineMs + 5000)
      if (await swimToShore(bot, isStopped)) break            // rung 1: float up + swim to the nearest bank
      if (!wet()) break
      try { if (await prov().manualHopFromWater(bot)) break } catch {} // rung 2: hop straight onto an adjacent bank
      if (!wet()) break
      await jumpForAir(bot, 6000, isStopped)                  // rung 3: roofed flood - rise the column for air
    }
    const out = !wet()
    dbg('drown-escape: ' + (out ? 'out of the water at ' + bot.entity.position.floored() : 'STILL WET after the ladder'))
    return out
  } finally { arbiter.endManeuver(tok); escapingWater = false }
}
// Is a water-escape maneuver (escapeWater) actively driving the body right now? walkStaged reads
// this for the WATER_ESCAPE trek anti-fight - don't compose a leg back into the pond while an
// escape is swimming the bot OUT. Bounded: escapingWater is cleared in escapeWater's finally.
function isEscapingWater () { return escapingWater }

// WATER_ESCAPE (task #48): relocate a bot stuck TREADING water to the nearest REACHABLE, DRY,
// goal-biased land cell - the correct replacement for the blind nearest-bank swim (swimToShore /
// manualHopFromWater) that ignores the goal, holds controls at a possibly-walled cell, and whose
// onGround/dry-feet success test treading water can never satisfy (design §2a/§2b). Bounded ladder,
// whole call <=deadlineMs (default 25s); returns an HONEST !feetInWater bool - never wedges.
async function escapeToDryLand (bot, { goalDir = null, isStopped = () => false, deadlineMs = 25000 } = {}) {
  if (drownReflexSkips(deliberateDrown)) { dbg('escapeToDryLand: deliberate-drown latch set (suicide-reset) - NOT escaping, letting it drown'); return false } // #63 §B.1
  const dl = Date.now() + deadlineMs
  const sample = (x, y, z) => { try { const b = bot.blockAt(new Vec3(x, y, z)); return b && b.name } catch { return null } }
  const solidAt = (x, y, z) => { try { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block' && !/water|lava/.test(b.name) } catch { return false } }
  const feet = bot.entity.position.floored()
  // The finder returns only a cell with a REAL swim corridor (flood-fill, not blind rays) and a
  // genuinely-dry climbable top, ranked toward the goal. No dry land in range => honest hold (below).
  const exit = navProfile.findDryLandExit({ x: feet.x, y: feet.y, z: feet.z }, sample, { maxR: 16, goalDir, solidAt })
  if (!exit) { dbg('escapeToDryLand: no reachable dry land within range - holding (never wedging)'); return false }
  dbg('escapeToDryLand: relocating to dry cell ' + exit.x + ',' + exit.y + ',' + exit.z + (goalDir ? ' (goal-biased)' : ''))
  // CORRECTED success test (design §3b): standing on reachable dry land - onGround-and-dry OR within
  // 0.7b of the exit cell and no longer treading (feet not water). NOT the unsatisfiable
  // onGround-AND-dry-floor-AND-!feetInWater the swim rungs use (deep water never reports onGround).
  const reached = () => {
    if (feetInWater(bot)) return false
    if (bot.entity.onGround) return true
    const p = bot.entity.position
    return Math.hypot(p.x - (exit.x + 0.5), p.z - (exit.z + 0.5)) <= 0.7
  }
  // RUNG 1 (<=12s): swim/step straight at the exit on the swimToShore control idiom.
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    const t0 = Date.now()
    bot.setControlState('jump', true) // float/climb the water column
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    while (Date.now() - t0 < 12000 && Date.now() < dl && !isStopped()) {
      try { await bot.lookAt(new Vec3(exit.x + 0.5, bot.entity.position.y + 0.4, exit.z + 0.5), true) } catch {}
      await new Promise(r => setTimeout(r, 120))
      if (reached()) { dbg('escapeToDryLand: reached dry land at ' + bot.entity.position.floored()); return true }
    }
  } finally { bot.clearControlStates() }
  if (!feetInWater(bot)) return true // the swim landed us dry (onGround may lag) - done
  // RUNG 2: an unclimbable lip the swim couldn't make - pillar up under OPEN SKY, then step off.
  // Reuses the already-anti-grief pillarUpTo (refuses indoors :1586, refuses water-overhead :1602,
  // natural/own-scaffold filler only :1603, self-terminates on clear sky :1594) - NO new placement.
  const roofed = () => { try { return !!(prov().hasSolidCeiling && prov().hasSolidCeiling(bot, 8, { ignoreLeaves: true })) } catch { return false } }
  const indoors = () => { try { return !!(prov().insideOwnStructure && prov().insideOwnStructure(bot)) } catch { return false } }
  if (Date.now() < dl && !isStopped() && !roofed() && !indoors()) {
    let ySurf = feet.y
    for (let dy = 0; dy <= 12; dy++) { const n = sample(feet.x, feet.y + dy, feet.z); if (!n || !/water/.test(n)) { ySurf = feet.y + dy; break } }
    dbg('escapeToDryLand: unclimbable lip - pillaring to y=' + (ySurf + 1) + ' then stepping off')
    try { await prov().pillarUpTo(bot, ySurf + 1, { isStopped }) } catch (e) { dbg('escapeToDryLand: pillar failed (' + e.message + ')') }
    if (!feetInWater(bot) && bot.entity.onGround) { // now on the tower top - step off onto the dry cell
      try {
        try { bot.pathfinder.setGoal(null) } catch {}
        bot.clearControlStates()
        await bot.lookAt(new Vec3(exit.x + 0.5, bot.entity.position.y, exit.z + 0.5), true)
        bot.setControlState('forward', true)
        const t1 = Date.now()
        while (Date.now() - t1 < 3000 && Date.now() < dl && !isStopped()) {
          await new Promise(r => setTimeout(r, 120))
          if (!feetInWater(bot) && bot.entity.onGround && Math.hypot(bot.entity.position.x - (exit.x + 0.5), bot.entity.position.z - (exit.z + 0.5)) < 0.6) break
        }
      } catch {} finally { bot.clearControlStates() }
    }
  }
  const out = !feetInWater(bot)
  dbg('escapeToDryLand: ' + (out ? 'on dry land at ' + bot.entity.position.floored() : 'still wet - honest give-up'))
  return out
}

// Standing in a HOLE: solid walls on 3+ sides at feet level. An open-sky pit makes the
// no-dig profiles no-path INSTANTLY (this was the "stalls on open ground" mystery - the
// bot idled 70s in its own orchard-leveling hole, live). Returns the rim height to
// pillar to, or null. Only counts as a pit under open sky - a walled corner INSIDE a
// roofed room is a door/climb problem, not a pillar problem (pillaring indoors just
// bonks the ceiling).
function detectPit (bot) {
  const f0 = bot.entity.position.floored()
  let pitWalls = 0; let rimY = f0.y
  for (const [wdx, wdz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const w = bot.blockAt(f0.offset(wdx, 0, wdz))
    if (w && w.boundingBox === 'block') pitWalls++
    for (let dy = 2; dy >= 0; dy--) {
      const t = bot.blockAt(f0.offset(wdx, dy, wdz))
      if (t && t.boundingBox === 'block') { rimY = Math.max(rimY, f0.y + dy + 1); break }
    }
  }
  if (pitWalls < 3) return null
  if (prov().insideOwnStructure && prov().insideOwnStructure(bot)) return null // my own hut is not a pit - don't pillar dirt in the living room
  if (prov().hasSolidCeiling(bot, 20, { ignoreLeaves: true })) return null // roofed = not a pit
  return { rimY }
}

// A 4+ deep drop within a few blocks along the nudge line? A blind sprint-jump once
// launched the bot off an edge into a shaft to bedrock (died at y=1, live).
function cliffAhead (bot, tx, tz) {
  const np = bot.entity.position
  const fdx = tx - np.x; const fdz = tz - np.z; const fn = Math.hypot(fdx, fdz) || 1
  for (const dist of [2, 3, 4]) {
    const cx = Math.floor(np.x + (fdx / fn) * dist); const cz = Math.floor(np.z + (fdz / fn) * dist)
    let solid = false
    for (let dy = -1; dy >= -4; dy--) {
      const b = bot.blockAt(new Vec3(cx, Math.floor(np.y) + dy, cz))
      if (b && b.boundingBox === 'block') { solid = true; break }
    }
    if (!solid) return true
  }
  return false
}

// ---- door-assist ----------------------------------------------------------------
// Walk to the nearest CLOSED wooden door / fence gate within 16 blocks and open it,
// like a player leaving a house. Iron doors need redstone - skipped. Returns whether
// a door was crossed/opened (the caller re-plans its path afterwards).
// The pathfinder cannot PLAN through door cells AT ALL (canOpenDoors only bumps them
// open on direct lines) - verified repeatedly in the hut test - so after opening we
// FORCE-WALK through the doorway on manual controls, exiting toward open sky.
// opts.towards {x,z}: cross the doorway toward the SIDE CLOSER TO THE GOAL. Without it
// the exit side is picked by open sky ("outside") - which can only ever LEAVE a building;
// a goto INTO the hut needs to cross the other way (navigateTo passes the goal through).
const OPENABLE_RE = /(_door|_fence_gate)$/
function openableIds (bot) {
  const md = require('minecraft-data')(bot.version)
  return Object.values(md.blocksByName).filter(b => OPENABLE_RE.test(b.name) && b.name !== 'iron_door').map(b => b.id)
}
// Scan centers: around the BOT and around the GOAL. A goto into a doored building
// times out wherever the planner happened to roam (live: 27 blocks off, hunting a way
// into a closed box) - the door that matters is the one next to the GOAL, not the bot.
function doorScanPoints (bot, towards) {
  const pts = [bot.entity.position]
  if (towards && typeof towards.x === 'number') pts.push(new Vec3(towards.x, towards.y != null ? towards.y : bot.entity.position.y, towards.z))
  return pts
}
function doorNearby (bot, towards) { // cheap existence probe - gates the ladder rung
  try {
    const ids = openableIds(bot)
    return doorScanPoints(bot, towards).some(pt => (bot.findBlocks({ point: pt, matching: ids, maxDistance: 16, count: 1 }) || []).length > 0)
  } catch { return false }
}
async function openNearbyDoor (bot, opts = {}) {
  // GEOMETRIC ARRIVAL (DOOR_CROSS_GEOMETRIC): crossOwnDoor threads its inside-ness predicate
  // in as opts.done - once the bot is on the target side (through ANY opening: the door OR a
  // wall hole), the crossing is COMPLETE and we return immediately, instead of walking the
  // bot back out to satisfy one specific door. opts.done is undefined for every other caller
  // (recovery-ladder rung, pathfix pre-flight) => no behavior change for them.
  const isDone = () => { try { return opts.done ? !!opts.done() : false } catch { return false } }
  try {
    const ids = openableIds(bot)
    const seen = new Set(); const cands = []
    for (const pt of doorScanPoints(bot, opts.towards)) {
      for (const c of (bot.findBlocks({ point: pt, matching: ids, maxDistance: 16, count: 8 }) || [])) {
        const k = c.x + ',' + c.y + ',' + c.z
        if (!seen.has(k)) { seen.add(k); cands.push(c) }
      }
    }
    if (opts.doorAt) {
      // PINNED CHOICE (DOOR_CROSS_GEOMETRIC): crossOwnDoor chose ONE doorway column - cross
      // THAT one first, then rank any remainder by distance to the GOAL side (opts.towards)
      // with a stable (x,z) tiebreak. The old distance-to-BOT sort flip-flopped between the
      // door and a wall hole as the bot moved (live: the anchored door coordinate kept
      // changing 430,86 / 414,87 / 416,85). Applies only to this pinned call.
      const gx = (opts.towards && typeof opts.towards.x === 'number') ? opts.towards.x : bot.entity.position.x
      const gz = (opts.towards && typeof opts.towards.z === 'number') ? opts.towards.z : bot.entity.position.z
      const atDoor = c => (c.x === opts.doorAt.x && c.z === opts.doorAt.z) ? 0 : 1
      cands.sort((a, b) => (atDoor(a) - atDoor(b)) || (Math.hypot(a.x - gx, a.z - gz) - Math.hypot(b.x - gx, b.z - gz)) || (a.x - b.x) || (a.z - b.z))
    } else {
      cands.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    }
    dbg('door-assist: ' + cands.length + ' door/gate candidates near me/goal')
    for (const p of cands) {
      if (isDone()) return true // already on the target side (e.g. entered through the hole) - stop
      const blk = bot.blockAt(p)
      if (!blk) continue
      // NOTE: the walk-through below runs regardless of the door's open/closed STATE -
      // the pathfinder cannot ROUTE through door cells at all (it only bumps them open
      // on direct lines), and "open" is normalized to "walk line clear" further down
      // (for a sideways-hung door those are OPPOSITES - see passageClear).
      try { await gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 15000, { duringRecovery: true }) } catch (e) { dbg('door-assist: cannot reach door at ' + p + ' (' + e.message + ')'); continue }
      if (bot.entity.position.distanceTo(p) > 4) continue
      try {
        // WALK THROUGH the doorway before re-planning: the pathfinder won't ROUTE
        // through even an open door that isn't on the direct line (verified in the hut
        // test - door opened, travel still "blocked"). But it CAN step INTO an open
        // doorway cell - so stand in the doorway first, then step out the far side
        // (height-tolerant: outside ground is often ±1).
        // Foot cell from the HALF property, never from the bot's y: a mid-hop read
        // (feet momentarily at y+1) picked the UPPER half here and shifted every
        // geometry probe one block up (live: bogus 'blocked side' flips at the hut).
        let half = null
        try { half = (blk.getProperties() || {}).half || null } catch {}
        const base = half === 'upper' ? p.offset(0, -1, 0) : p
        const before = bot.entity.position.clone()
        // CROSSING AXIS from WALL GEOMETRY, not the door's facing blockstate. facing
        // encodes the PLACER'S YAW at hang time, not which way the wall runs - the bot
        // hung its own hut door sideways during the safehouse build (facing east in a
        // north wall) and door-assist then force-walked ALONG the inside of the wall
        // into the chest corner instead of out the doorway (trapped in its own hut,
        // live 19:16-19:27). The wall is ground truth: the passage axis is the one
        // whose neighbor columns are walkable; the wall axis is solid. facing is only
        // a tiebreak (freestanding door), the old approach-line heuristic dead last.
        const clearCell = (b) => b && (b.boundingBox !== 'block' || OPENABLE_RE.test(b.name))
        const walkable = (cell) => { // can the bot stand there? (±1: outside ground is often a step up/down)
          for (const dy of [0, 1, -1]) {
            const feet = bot.blockAt(cell.offset(0, dy, 0)); const head = bot.blockAt(cell.offset(0, dy + 1, 0)); const floor = bot.blockAt(cell.offset(0, dy - 1, 0))
            if (clearCell(feet) && clearCell(head) && floor && floor.boundingBox === 'block') return true
          }
          return false
        }
        let facing = null
        try { facing = (bot.blockAt(base) && bot.blockAt(base).getProperties().facing) || null } catch {}
        const xOpen = (walkable(base.offset(1, 0, 0)) ? 1 : 0) + (walkable(base.offset(-1, 0, 0)) ? 1 : 0)
        const zOpen = (walkable(base.offset(0, 0, 1)) ? 1 : 0) + (walkable(base.offset(0, 0, -1)) ? 1 : 0)
        let axis
        if (xOpen !== zOpen) axis = xOpen > zOpen ? [1, 0] : [0, 1]
        else if (facing === 'east' || facing === 'west') axis = [1, 0]
        else if (facing === 'north' || facing === 'south') axis = [0, 1]
        else axis = [Math.abs(base.x + 0.5 - before.x) >= Math.abs(base.z + 0.5 - before.z) ? 1 : 0, 0]
        const dx = axis[0]; const dz = axis[0] === 1 ? 0 : 1
        dbg('door-assist: crossing axis ' + (dx ? 'x (east-west)' : 'z (north-south)') + ' - open sides x=' + xOpen + ' z=' + zOpen + ', facing=' + facing)
        // PASSAGE CLEAR, not "open": a sideways-hung door (facing along the wall - THIS
        // hut's door, hung by the builder, live) swings its OPEN panel flat ACROSS the
        // doorway and rests its CLOSED panel parallel to the walk line - forcing
        // open=true is exactly backwards there. The state's collision SHAPES are ground
        // truth: the walk line is clear when no box crosses the corridor's center strip
        // (bot body is 0.6 wide -> a panel overlapping [0.2, 0.8] of the perpendicular
        // coordinate blocks the line). Toggle (bounded) until it clears.
        const passageClear = () => {
          const b = bot.blockAt(base)
          if (!b) return true
          let shapes = null
          try { shapes = b.shapes } catch {}
          if (!Array.isArray(shapes)) { // no shape data - old behavior (trust the open flag)
            try { const pr = b.getProperties(); return !!pr && (pr.open === true || pr.open === 'true') } catch { return true }
          }
          return !shapes.some(s => dx ? (s[2] <= 0.8 && s[5] >= 0.2) : (s[0] <= 0.8 && s[3] >= 0.2))
        }
        const ensurePassage = async (when) => {
          for (let i = 0; i < 2 && !passageClear(); i++) {
            await bot.activateBlock(bot.blockAt(base))
            await new Promise(r => setTimeout(r, 300)) // let the door state land
            dbg('door-assist: toggled ' + blk.name + ' (' + when + ') - walk line ' + (passageClear() ? 'CLEAR' : 'still blocked'))
          }
        }
        // Seal the door behind us (close it if we toggled it open) - "sealed" = the collision
        // shape SPANS the doorway (passageClear false), the inverse of ensurePassage. Reused by
        // the post-crossing close below AND by the geometric short-circuit returns (F1): a done()
        // early-out still leaves the hut sealed to mobs.
        const sealBehind = async () => {
          try {
            for (let i = 0; i < 2 && passageClear(); i++) { await bot.activateBlock(bot.blockAt(base)); await new Promise(r => setTimeout(r, 300)) }
            dbg('door-assist: door behind me ' + (passageClear() ? 'still open' : 'closed'))
          } catch {}
        }
        // Exit toward OPEN SKY: "outside" is the side of the doorway with no ceiling.
        // (Away-from-where-I-stand flips when the bot is mid-doorway - verified: it
        // walked back INTO the hut. Ceiling check is position-independent.)
        const skyless = (cell) => { // solid cover within 12 above? (leaves are canopy, not ceiling)
          for (let dy = 2; dy <= 12; dy++) { const b = bot.blockAt(cell.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return true }
          return false
        }
        const posSide = base.offset(dx * 2, 0, dz * 2); const negSide = base.offset(-dx * 2, 0, -dz * 2)
        let sign = 0; let how = ''
        // Is the GOAL itself inside a structure of ours (e.g. the hut chest), or out in
        // the world? This, not raw goal-distance, decides which way to cross a doorway.
        let goalInside = false
        try { goalInside = !!(opts.towards && typeof opts.towards.x === 'number' && prov().ownHutAt && prov().ownHutAt(new Vec3(opts.towards.x, opts.towards.y != null ? opts.towards.y : base.y, opts.towards.z))) } catch {}
        const posCovered = skyless(posSide); const negCovered = skyless(negSide)
        if (posCovered !== negCovered) {
          // One doorway side is ROOFED (inside a room), the other OPEN (outside). Cross to
          // the side that MATCHES WHERE THE GOAL IS: an outside goal => exit to open sky;
          // an inside goal => step into the covered room. This DOMINATES goal-distance,
          // which wrongly picks "inward" when an outside goal sits beyond the hut's far
          // wall (live: orchard goal is SOUTH, the only door is NORTH -> raw distance
          // walked the bot deeper INTO the hut toward the chest instead of out the door).
          const openSign = posCovered ? -1 : 1 // sign that points at the OPEN (outdoor) side
          sign = goalInside ? -openSign : openSign
          how = goalInside ? ' (toward inside goal)' : ' (open sky)'
        } else if (opts.towards && typeof opts.towards.x === 'number') {
          // Both sides equally open/covered (a freestanding gate): fall back to goal-distance.
          const dPos = Math.hypot(posSide.x + 0.5 - opts.towards.x, posSide.z + 0.5 - opts.towards.z)
          const dNeg = Math.hypot(negSide.x + 0.5 - opts.towards.x, negSide.z + 0.5 - opts.towards.z)
          if (Math.abs(dPos - dNeg) > 0.75) { sign = dPos < dNeg ? 1 : -1; how = ' (toward goal)' }
        }
        if (!sign) { sign = Math.sign((base.x + 0.5 - before.x) * dx + (base.z + 0.5 - before.z) * dz) || 1; how = ' (fallback)' }
        // GROUNDED sanity: never force-walk at a WALL. Flip only when the chosen far
        // side is wall-like (no walk gap at any tolerated step height) and the other
        // side has one. A FLOORLESS far side is NOT wall-like: a blast crater beyond
        // the doorstep is still crossable (step out and drop, recoveries handle the
        // climb) - flipping on it walked the bot right back inside its hut (live).
        const blockedSolid = (cell) => {
          for (const dy of [0, 1, -1]) {
            const feet = bot.blockAt(cell.offset(0, dy, 0)); const head = bot.blockAt(cell.offset(0, dy + 1, 0))
            if (clearCell(feet) && clearCell(head)) return false
          }
          return true
        }
        if (blockedSolid(base.offset(dx * sign * 2, 0, dz * sign * 2)) && !blockedSolid(base.offset(-dx * sign * 2, 0, -dz * sign * 2))) { sign = -sign; how += ' FLIPPED (chosen side blocked)' }
        dbg('door-assist: exit side ' + (dx ? (sign > 0 ? 'east' : 'west') : (sign > 0 ? 'south' : 'north')) + how)
        // Align on the inside cell in front of the door (pathfinder CAN reach that).
        try { await gotoOnce(bot, new goals.GoalBlock(base.x - dx * sign, base.y, base.z - dz * sign), 8000, { duringRecovery: true }) } catch (e2) { dbg('door-assist: could not align (' + e2.message + ')') }
        if (isDone()) { await sealBehind(); return true } // arrival (any opening) during align - stop, don't force-walk out
        // FORCE-WALK through on manual controls. Thread the doorway CENTER-TO-CENTER -
        // one long diagonal walk clipped the open door panel and slid the bot off
        // sideways into the wall corner.
        try { bot.pathfinder.setGoal(null) } catch {}
        bot.setControlState('sprint', false)
        bot.setControlState('jump', false)
        const walkTo = async (tx, tz, doneDist, ms) => {
          try { await bot.lookAt(new Vec3(tx, bot.entity.position.y + 1.2, tz), true) } catch {}
          bot.setControlState('forward', true)
          const t0 = Date.now()
          let lastPos = bot.entity.position.clone(); let lastMove = Date.now()
          while (Date.now() - t0 < ms) {
            await new Promise(r => setTimeout(r, 80))
            if (Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz) < doneDist) break
            const moved = bot.entity.position.distanceTo(lastPos)
            if (moved > 0.15) { lastPos = bot.entity.position.clone(); lastMove = Date.now() }
            else if (Date.now() - lastMove > 350) { // wedged on a step-up (e.g. higher ground outside) - hop
              bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 120)); bot.setControlState('jump', false)
              lastMove = Date.now()
            }
            try { await bot.lookAt(new Vec3(tx, bot.entity.position.y + 1.2, tz), true) } catch {} // keep the line straight
          }
          bot.setControlState('forward', false)
        }
        // Normalize the door RIGHT BEFORE crossing (the align goto's native bump logic
        // can toggle it behind our back) - and by SHAPES, not the open flag: this is
        // where the sideways-hung door gets CLOSED so its panel swings out of the walk
        // line (the old force-open here re-blocked the doorway every pass, live).
        try { await ensurePassage('before crossing') } catch {}
        await walkTo(base.x + 0.5, base.z + 0.5, 0.45, 2500)                                    // into the doorway
        if (isDone()) { await sealBehind(); return true } // stepping into the doorway already put us on the target side (entered via the hole)
        // OWN-HUT crater heal, from THE DOORWAY: standing on the solid door floor the bot
        // reaches the whole exit lane, so fill any creeper crater HERE - before the second
        // step walks it off the doorstep edge into the pit. A blast turned the exit lane
        // into a hole the pathfinder can't cross, so the re-plan gave up at the threshold
        // (live: trapped at 418,67,89). ownHutAt-gated + survival place from our own filler
        // + skips solids => anti-grief and a no-op on a healthy apron. The step-out below
        // then lands on solid ground and the retry routes across.
        const ownHut = prov().ownHutAt && prov().ownHutAt(p)
        try {
          if (ownHut && prov().healHomeCrater) {
            // QUICK patch from the doorway (no repositioning - a rim walk here would pull
            // us off the crossing line): fill only the reachable western lane so the
            // step-out below lands on solid ground.
            const n = await prov().healHomeCrater(bot, ownHut, { isStopped: opts.isStopped, reposition: false })
            if (n) dbg('door-assist: quick-healed ' + n + ' crater cell(s) from the doorway')
          }
        } catch (e3) { dbg('door-assist: crater heal skipped (' + e3.message + ')') }
        await walkTo(base.x + dx * sign * 2 + 0.5, base.z + dz * sign * 2 + 0.5, 0.6, 2500)     // out the far side
        if (isDone()) { await sealBehind(); return true } // reached the target side - crossing complete
        const prog = (bot.entity.position.x - (base.x + 0.5)) * dx * sign + (bot.entity.position.z - (base.z + 0.5)) * dz * sign
        dbg('door-assist: force-walk ' + (prog > 1.2 ? 'THROUGH to ' : 'did not clear, at ') + bot.entity.position.floored())
        // CLOSE THE DOOR BEHIND US so the hut stays sealed to mobs (it was opened/toggled
        // to pass). "Sealed" = the door's collision shape SPANS the doorway (passageClear
        // false) - the inverse of ensurePassage, same shape ground-truth. Do this BEFORE
        // the full crater heal (which walks the rim away from the door), while we're still
        // in reach; we're past the door now, so closing it can't lock us out.
        await sealBehind()
        // FULL crater heal whenever we're actually OUTSIDE the hut now (not just prog>1.2 -
        // a "did not clear" exit still lands the bot outside and can reach the crater): walk
        // the rim and bridge the whole footprint incl. the far EAST pit the doorway can't
        // touch (live: the bot fell into the unhealed (419,62,84) and died). From inside
        // (an entry crossing) this no-ops - it can't reach the outside cells anyway.
        try {
          if (ownHut && prov().healHomeCrater && !(prov().ownHutAt && prov().ownHutAt(bot.entity.position.floored()))) {
            const n = await prov().healHomeCrater(bot, ownHut, { isStopped: opts.isStopped, reposition: true })
            if (n) dbg('door-assist: full-healed ' + n + ' crater cell(s) around home')
          }
        } catch (e5) { dbg('door-assist: full crater heal skipped (' + e5.message + ')') }
        return true
      } catch { continue }
    }
  } catch { }
  return false
}

// ---- the recovery ladder --------------------------------------------------------
// Ordered, situation-gated, per-type budgets. Each entry: when() says whether it can
// help right now; run() maneuvers. A recovery "worked" if the bot demonstrably MOVED
// (>=2 blocks horizontally or rose >=1) or the entry vouches for itself (door-assist
// returns whether it crossed) - re-read the world, never trust intent.
function defaultBudgets () { return { indoor: 3, water: 2, wetbreach: 1, door: 3, pit: 2, climb: 2, nudge: 2, stepout: 2 } }

async function recoverOnce (bot, goal, counts, budgets, opts) {
  const isStopped = opts.isStopped || (() => false)
  const p0 = bot.entity.position.clone()
  const movedEnough = () => {
    const p1 = bot.entity.position
    return Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 2 || Math.floor(p1.y) > Math.floor(p0.y)
  }
  const xz = goalXZ(goal)
  const twd = xz ? { x: xz.x, z: xz.z, y: goalY(goal) } : null // door scans also look near the GOAL
  const ladder = [
    { // HARD INVARIANT - wedged INSIDE the bot's own structure: step to a schema-correct
      // FREE interior cell, and NEVER pillar/dig/dirt-fill in the living room. Live, the
      // emergency escape pillared out with DIRT (head-height dirt piled on the furniture)
      // and the bot froze 150s boxed in by bed+dirt+table. This rung runs FIRST indoors
      // and uses only the no-dig pathfinder to reach a real floor-standing cell from the
      // self-structure model - no block placement, so the roof/furniture stay clean.
      kind: 'indoor',
      when: () => { try { return !!(prov().insideOwnStructure && prov().insideOwnStructure(bot)) } catch { return false } },
      run: async () => {
        const cell = prov().freeInteriorCell ? prov().freeInteriorCell(bot) : null
        if (!cell) { dbg('recovery: inside own structure but no free interior cell - holding (never pillaring indoors)'); return false }
        dbg('recovery: wedged INSIDE own structure at ' + p0.floored() + ' - stepping to free interior cell ' + cell + ' (no pillaring indoors)')
        // duringRecovery: this rung runs INSIDE recoverOnce's recoveringDepth++ span, so
        // without the flag gotoOnce's yield gate would make this OWN goto wait up to 45s
        // before it even starts whenever a free interior cell exists (latent 45s dead wait).
        try { await gotoOnce(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 0), 8000, { duringRecovery: true }) } catch {}
        if (movedEnough()) return true
        // the no-dig planner couldn't thread the cramped interior - manual step toward the
        // free cell (still no placement): face it, walk, hop once if we bump.
        try {
          bot.pathfinder.setGoal(null); bot.clearControlStates()
          await bot.lookAt(new Vec3(cell.x + 0.5, bot.entity.position.y + 1.2, cell.z + 0.5), true)
          bot.setControlState('forward', true)
          const t0 = Date.now()
          while (Date.now() - t0 < 1800 && !isStopped()) {
            await new Promise(r => setTimeout(r, 120))
            if (Math.hypot(bot.entity.position.x - (cell.x + 0.5), bot.entity.position.z - (cell.z + 0.5)) < 0.5) break
            if (Date.now() - t0 > 500 && bot.entity.position.distanceTo(p0) < 0.3) { bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 150)); bot.setControlState('jump', false) }
          }
        } catch {} finally { bot.clearControlStates() }
        return movedEnough()
      }
    },
    { // in water the pathfinder never registers "on ground", so its planned jumps never
      // fire - it stands in a puddle forever (watched live, 8 min). Shallow trench: hop
      // straight onto the adjacent bank. Deep water (mid-river, no adjacent bank): swim
      // for the nearest shore on manual controls.
      kind: 'water',
      when: () => feetInWater(bot),
      run: async () => {
        await prov().manualHopFromWater(bot)
        if (movedEnough() && !feetInWater(bot)) return true
        if (await swimToShore(bot, isStopped)) return true
        // WATER_ESCAPE (task #48): the blind nearest-bank swim just failed - it ignores the goal and
        // holds controls at a maybe-walled cell (design §2a). Relocate to the nearest REACHABLE, DRY,
        // GOAL-BIASED land cell instead (flood-fill corridor + corrected success test + pillarUpTo the
        // lip). Flag OFF => this block never runs; the rung is byte-for-byte swimToShore's result.
        if (WATER_ESCAPE) {
          const gd = xz ? { x: xz.x - p0.x, z: xz.z - p0.z } : null
          if (await escapeToDryLand(bot, { goalDir: gd, isStopped })) return true
        }
        return false
      }
    },
    { // WATER-WEDGE ESCAPE: boxed in a 1-block water pocket under a solid ceiling (a
      // waterlogged tree the gather walked into) - swim + hop just failed (this rung only
      // ever runs after the water rung above), and no other rung fits: detectPit refuses a
      // roofed cell, pillar/climb refuse water overhead, stepout finds no walkable neighbour.
      // Dig a BOUNDED path to the nearest air/bank (horizontal-first, vertical fallback)
      // through the SAME anti-grief whitelist the wood gather uses, never re-opening water.
      // Gated so a pure leaf canopy over open water does NOT trigger it (ignoreLeaves) - the
      // swim rungs own that; logs/terrain overhead do. WATER_WEDGE_ESCAPE=0 -> byte-for-byte
      // today's ladder (this rung never applies).
      kind: 'wetbreach',
      when: () => process.env.WATER_WEDGE_ESCAPE !== '0' &&
        feetInWater(bot) &&
        prov().hasSolidCeiling(bot, 8, { ignoreLeaves: true }) &&
        !(prov().insideOwnStructure && prov().insideOwnStructure(bot)),
      run: async () => {
        dbg('recovery: WATER POCKET at ' + p0.floored() + ' - breaching toward the nearest bank')
        try { await prov().breachWaterPocket(bot, { isStopped, wide: !!opts.desperate }) } catch (e) { dbg('recovery: wetbreach failed (' + e.message + ')') }
        return movedEnough()
      }
    },
    { // open-sky hole: pillar out to the rim with carried filler. Checked BEFORE the
      // door rung - from inside a pit every door-approach goto just burns its timeout.
      // (A walled corner in a ROOFED room is not a pit - detectPit excludes it - so the
      // inside-the-hut case still reaches door-assist first.)
      kind: 'pit',
      when: () => !!detectPit(bot),
      run: async () => {
        const pit = detectPit(bot)
        if (!pit) return false
        dbg('recovery: wedged in a PIT at ' + p0.floored() + ' - pillaring out to y=' + pit.rimY)
        try { await prov().pillarUpTo(bot, pit.rimY, { isStopped }) } catch (e) { dbg('recovery: pillar-out failed (' + e.message + ')') }
        return movedEnough()
      }
    },
    { // walled into a room with a door (or out of one): open it and walk through like a
      // person, crossing toward the goal side. GATED on a door actually existing nearby:
      // "no door within 16" is NOT APPLICABLE, not a failed attempt - running it in open
      // country burned the whole door budget mid-trek, and by the time the bot reached
      // its hut wall the rung was spent (live: re-entry died at (420,66,85), 3 blocks
      // from its own door, with 'door x3' all wasted 60+ blocks away).
      kind: 'door',
      when: () => doorNearby(bot, twd),
      run: async () => openNearbyDoor(bot, { towards: twd })
    },
    { // buried underground (real ceiling, not a canopy): staircase/pillar up to daylight.
      kind: 'climb',
      when: () => opts.climb !== false && prov().hasSolidCeiling(bot, 12, { ignoreLeaves: true }),
      run: async () => {
        const gy = goalY(goal)
        const targetY = Math.max(Math.floor(bot.entity.position.y) + 10, gy == null ? -Infinity : Math.floor(gy))
        dbg('recovery: stuck UNDERGROUND at ' + p0.floored() + ' - climbing toward y=' + targetY)
        try { await prov().climbToSurface(bot, targetY, { isStopped }) } catch (e) { dbg('recovery: climb-out failed (' + e.message + ')') }
        return movedEnough()
      }
    },
    { // surface wedge the planner just can't solve: face the target and jump-sprint at
      // it - but never blind over a drop (cliff check).
      kind: 'nudge',
      when: () => !!xz && bot.entity.onGround && !cliffAhead(bot, xz.x, xz.z),
      run: async () => {
        dbg('recovery: surface nudge at ' + p0.floored() + ' toward ' + Math.round(xz.x) + ',' + Math.round(xz.z))
        if (REACTIVE_MOVE_ON) { // Phase A: the 2s sprint-jump-toward-the-goal IS reactiveMove(toward) - one bounded code path
          try { await reactiveMove(bot, { toward: { x: xz.x, y: bot.entity.position.y, z: xz.z }, budgetMs: 2000, arriveB: 1.0, isStopped, priority: arbiter.PRIORITY.SURVIVE }) } catch {}
          return movedEnough()
        }
        try {
          try { bot.pathfinder.setGoal(null) } catch {}
          await bot.lookAt(new Vec3(xz.x, bot.entity.position.y + 1, xz.z), true)
          bot.setControlState('jump', true); bot.setControlState('forward', true); bot.setControlState('sprint', true)
          await new Promise(r => setTimeout(r, 2000))
        } catch {} finally { bot.clearControlStates() }
        return movedEnough()
      }
    },
    { // SOFT WEDGE, last rung: the planner refuses to move but the immediate cells are
      // walkable (live: 12-min freeze at 512,68,147 with air/grass on every side - the
      // whole ladder above whiffed and walkStaged looped "giving up wedged"). Do the
      // dumbest human thing: hop in place (clears a block-clip desync), then STEP OUT one
      // or two cells on manual controls - goal-ward first - and verify we actually moved.
      // Unlike the nudge this needs no goal, tolerates a step down, and probes each of 8
      // directions instead of blindly charging one.
      kind: 'stepout',
      when: () => bot.entity.onGround || feetInWater(bot),
      run: async () => {
        try { bot.pathfinder.setGoal(null) } catch {}
        bot.clearControlStates()
        try { bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 260)) } catch {} finally { bot.setControlState('jump', false) }
        await new Promise(r => setTimeout(r, 300)) // land
        const feet = bot.entity.position.floored()
        const clear = b => !b || b.boundingBox !== 'block'
        const walkable = (cell) => { // can the bot stand there? (±1: steps up/down are fine)
          for (const dy of [0, -1, 1]) {
            const f = bot.blockAt(cell.offset(0, dy, 0)); const h = bot.blockAt(cell.offset(0, dy + 1, 0)); const g = bot.blockAt(cell.offset(0, dy - 1, 0))
            if (clear(f) && clear(h) && g && g.boundingBox === 'block' && !/lava|magma/.test(g.name)) return true
          }
          return false
        }
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
        if (xz) { // try the goal-ward directions first
          const gx = xz.x - (feet.x + 0.5); const gz = xz.z - (feet.z + 0.5)
          dirs.sort((a, b) => (b[0] * gx + b[1] * gz) / Math.hypot(b[0], b[1]) - (a[0] * gx + a[1] * gz) / Math.hypot(a[0], a[1]))
        }
        for (const [dx, dz] of dirs) {
          const c1 = feet.offset(dx, 0, dz)
          if (!walkable(c1)) continue
          const c2 = feet.offset(dx * 2, 0, dz * 2)
          const steps = walkable(c2) ? 2 : 1 // 2 cells out when the lane continues
          const tx = feet.x + 0.5 + dx * steps; const tz = feet.z + 0.5 + dz * steps
          dbg('recovery: step-out ' + steps + ' cell(s) toward ' + Math.floor(tx) + ',' + Math.floor(tz))
          if (REACTIVE_MOVE_ON) { // Phase A: the per-direction step-out drive IS reactiveMove(toward) - walk (no sprint), hop only when stalled
            try { await reactiveMove(bot, { toward: { x: tx, y: bot.entity.position.y, z: tz }, budgetMs: 1800, arriveB: 0.4, sprint: false, jump: false, isStopped, priority: arbiter.PRIORITY.SURVIVE }) } catch {}
          } else {
            try {
              await bot.lookAt(new Vec3(tx, bot.entity.position.y + 1.2, tz), true)
              bot.setControlState('forward', true)
              const t0 = Date.now()
              while (Date.now() - t0 < 1800) {
                await new Promise(r => setTimeout(r, 100))
                if (Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz) < 0.4) break
                if (Date.now() - t0 > 600 && bot.entity.position.distanceTo(p0) < 0.3) { // bumped - hop once
                  bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 150)); bot.setControlState('jump', false)
                }
              }
            } catch {} finally { bot.clearControlStates() }
          }
          const p1 = bot.entity.position
          if (Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 1.0) return true // we broke the freeze - that's the job
        }
        return false
      }
    },
    { // LAST RESORT - proven hard-wedge (watchdog digOut only): dig the natural blocks boxing
      // us in. The live death-spiral (§1) was a DRY surface wedge where every geometry-narrow
      // rung's when() was false and nothing ran at all (1ms "escape") - so this rung has NO
      // onGround/ceiling/wall-count gate; the watchdog's measured hard-wedge (opts.digOut) IS
      // the gate. Bounded (<=8/12 digs, 25s), nearHostile-aborting, SAME anti-grief whitelist
      // as wetbreach (escapeDiggable). DIGOUT_ESCAPE=0 -> when() is false -> today byte-for-byte.
      kind: 'drybreach',
      when: () => process.env.DIGOUT_ESCAPE !== '0' && !!opts.digOut &&
        !feetInWater(bot) &&
        !(prov().insideOwnStructure && prov().insideOwnStructure(bot)),
      run: async () => {
        dbg('recovery: HARD-WEDGED dry at ' + p0.floored() + ' - digging out (bounded)')
        try { await prov().breachDryPocket(bot, { isStopped, wide: !!opts.desperate }) } catch (e) { dbg('recovery: drybreach failed (' + e.message + ')') }
        return movedEnough()
      }
    }
  ]
  for (const step of ladder) {
    if (isStopped()) return null
    if ((counts[step.kind] || 0) >= (budgets[step.kind] != null ? budgets[step.kind] : 0)) continue
    let applies = false
    try { applies = step.when() } catch {}
    if (!applies) continue
    counts[step.kind] = (counts[step.kind] || 0) + 1
    recoveringDepth++
    let ok = false
    try { ok = await step.run() } catch (e) { dbg('recovery ' + step.kind + ' threw: ' + e.message) } finally { recoveringDepth-- }
    dbg('recovery ' + step.kind + ' -> ' + (ok ? 'MOVED' : 'no progress'))
    if (ok) return step.kind
    // no progress from this tool - spend its remaining budget so the next pass tries the
    // next rung instead of hammering the same one
    counts[step.kind] = Math.max(counts[step.kind], budgets[step.kind] != null ? budgets[step.kind] : 0)
  }
  return null
}

// ---- THE entry point ------------------------------------------------------------
// navigateTo(bot, goal, opts): goto with a deadline; on failure, run the recovery
// ladder and retry; on a reflex stealing the pathfinder (flee/defend setGoal), WAIT for
// it to finish and resume instead of failing with "goal was changed". Resolves with
// { recoveries, recoveryMs } (so trek loops can credit rescue time against their travel
// clocks); throws an HONEST error listing what it tried when the toolkit is spent.
//
// opts: timeoutMs (per goto attempt, default 20000) | deadlineMs (overall) | isStopped
//       | movements: () => Movements re-asserted before each attempt (recoveries switch
//         profiles) | budgets: per-rung recovery caps (see defaultBudgets) | climb:false
//         to disable the climb rung (trek loops that manage their own surfacing)
//       | label (debug tag)
// ONE BODY, ONE ROUTE: concurrent navigateTo calls fight over the single pathfinder and
// the control states - live at 433,62,112 a bank-withdraw nav and the build travel each
// ran their own recovery ladder, interleaved every ~2s, and every manual step-out was
// stomped by the other flow's goto physics: position frozen for many minutes while both
// "recovered". Serialize behind a mutex: the body can only walk one route at a time; a
// queued flow just experiences a slower nav (honest) instead of a phantom wedge.
let navChain = Promise.resolve()
// DOOR-CROSS LEDGER (F3, DOOR_CROSS_GEOMETRIC): the per-nav caps (crossings<2, tries<2,
// door budget 3) are each individually bounded, but every CALLER retry (pathfix attempt
// loop, comeToPlayer re-issue, planner/supervisor) builds a FRESH nav with fresh caps, so
// the in/out oscillation is unbounded ACROSS navs. This module-level ledger counts failed
// crossings keyed by (hut,dir): 3 fails in a 90s window -> a 120s cooldown during which
// crossOwnDoor no-ops (returns done()) and the plain goto takes over (it reaches interior
// goals via the same hole the loop kept using); a success deletes the entry. Consulted only
// under the flag; DOOR_CROSS_GEOMETRIC=0 never touches it.
const doorCrossLedger = new Map() // `${hut.x},${hut.y},${hut.z}:${dir}` -> { fails, firstAt, coolUntil }
// PURE ledger transition (unit-tested offline; navigate.js keeps only the Map + the clock).
// `e` = prior entry (or null); `now` = ms; `ok` = did the crossing succeed. Returns the NEXT
// entry (null => delete it) and whether a cooldown was FRESHLY triggered (for the one log line).
function crossVerdict (e, now, ok) {
  if (ok) return { entry: null, cooled: false } // a working door never cools down
  const WINDOW_MS = 90000; const COOL_MS = 120000
  let fails = (e && typeof e.fails === 'number') ? e.fails : 0
  let firstAt = (e && typeof e.firstAt === 'number') ? e.firstAt : now
  if (now - firstAt > WINDOW_MS) { fails = 0; firstAt = now } // window elapsed -> fresh count
  fails++
  let coolUntil = (e && typeof e.coolUntil === 'number') ? e.coolUntil : 0
  let cooled = false
  if (fails >= 3) { coolUntil = now + COOL_MS; cooled = true }
  return { entry: { fails, firstAt, coolUntil }, cooled }
}
// Serialize a body onto the single-pathfinder mutex (see the note above). Any async fn
// that drives the pathfinder/controls end-to-end - a full navigateTo, or an atomic
// enter/exit-door shell - queues here so two flows never fight over the controls.
function runOnNavChain (fn) {
  const p = navChain.then(fn, fn)
  navChain = p.then(() => {}, () => {}) // failures release the mutex like successes
  return p
}
function navigateTo (bot, goal, opts = {}) {
  return runOnNavChain(() => navigateToInner(bot, goal, opts))
}
// PREEMPTING variant for time-critical reflexes (hut-retreat from a creeper): skips the
// queue and takes the pathfinder NOW, like the flee reflex does - the preempted nav sees
// 'goal was changed', waits for the pathfinder to free up, and resumes (that machinery
// predates this). Never use for routine navigation - the mutex exists for a reason.
function navigateToPreempt (bot, goal, opts = {}) { return navigateToInner(bot, goal, opts) }

async function navigateToInner (bot, goal, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000
  const deadline = Date.now() + (opts.deadlineMs || Math.max(90000, timeoutMs * 4))
  const isStopped = opts.isStopped || (() => false)
  const budgets = Object.assign(defaultBudgets(), opts.budgets || {})
  const counts = {}
  const label = opts.label ? opts.label + ': ' : ''
  let interrupts = 0
  let recoveries = 0
  let recoveryMs = 0
  let crossings = 0 // atomic doorway pre-flight crossings this nav (capped so a threshold flicker can't ping-pong)
  let stalls = 0    // consecutive goto+recovery cycles that netted < 2.5b of real travel
  let unstuck = false // forceUnstick fired once already this nav
  // Time spent parked while a REFLEX held the pathfinder must not consume the deadline:
  // in a reflex storm (creeper standoff re-fleeing every second, live 2h+) every nav
  // burned its whole budget waiting and DIED at the deadline check before the recovery
  // ladder ever ran once. Credit the wait back (bounded) so recovery always gets a shot.
  let reflexWaitMs = 0
  const dl = () => deadline + Math.min(reflexWaitMs, 90000)
  navDepth++
  // Claim the body for this maneuver's whole duration so idle/opportunistic reflexes
  // (collect/torch/gaze/follow-resume) and NON-EMERGENCY flee don't steal the goal
  // mid-approach - the door-loop fix. Priority is the caller's tier (a flee hut-retreat
  // via navigateToPreempt passes SURVIVE; ordinary navigation is PROGRESS). The TTL is a
  // leak-safety cap (refreshed each loop); the finally end() is the real release.
  const manTtl = () => Math.min(60000, timeoutMs + 8000)
  const manTok = arbiter.beginManeuver(opts.label || 'nav', opts.priority != null ? opts.priority : arbiter.PRIORITY.PROGRESS, manTtl())
  try {
    for (;;) {
      arbiter.refreshManeuver(manTok, manTtl())
      if (isStopped()) throw new Error('stopped')
      if (opts.movements) { try { bot.pathfinder.setMovements(opts.movements()) } catch {} }
      // INTERIOR DOOR PRE-FLIGHT: the pathfinder cannot PLAN through a closed door, so a
      // plain goto to a cell INSIDE our hut (or from inside OUT to a world goal) burns its
      // whole timeout unplannably. Cross the doorway FIRST with the atomic, mutex-FREE
      // crossOwnDoor (gotoOnce-based - NEVER navigateTo, which would re-take this mutex and
      // deadlock), then fall through to the normal goto. Capped at 2 crossings/nav so a
      // threshold flicker can't ping-pong; arrival stays proven by goal.isEnd below.
      if (opts.doorPreflight !== false && crossings < 2 && !isStopped()) {
        try {
          const P = prov()
          const xz = goalXZ(goal); const gy = goalY(goal)
          const goalHut = xz && P.ownHutAt ? P.ownHutAt(new Vec3(xz.x, gy != null ? gy : bot.entity.position.y, xz.z)) : null
          const botHut = P.insideOwnStructure ? P.insideOwnStructure(bot) : null
          let atGoal = false
          try { atGoal = goal.isEnd(bot.entity.position.floored()) } catch {}
          if (goalHut && !botHut) { crossings++; dbg(label + 'door pre-flight: crossing IN to reach an interior goal'); await crossOwnDoor(bot, goalHut, 'in', { isStopped, priority: opts.priority }) }
          else if (botHut && !goalHut && !atGoal) { crossings++; dbg(label + 'door pre-flight: crossing OUT to reach an exterior goal'); await crossOwnDoor(bot, botHut, 'out', { isStopped, priority: opts.priority }) }
        } catch (e) { dbg(label + 'door pre-flight skipped (' + e.message + ')') }
      }
      const cyclePos = bot.entity.position.clone() // net-travel measurement for stall escalation
      const cycleT0 = Date.now()
      const cycleReflex0 = reflexWaitMs
      let lastErr
      try {
        const attemptMs = stalls >= 1 ? Math.min(timeoutMs, 10000) : timeoutMs // shrink after the first stall
        await gotoOnce(bot, goal, Math.min(attemptMs, Math.max(2000, dl() - Date.now())))
        // GROUNDED, not optimistic: goto "succeeds" WITHOUT ARRIVING when the planner
        // returns an empty path (wedged in a pit = zero legal moves, verified live) or
        // settles at the closest reachable node. Only the goal's own isEnd on our real
        // position counts as arrival - anything else feeds the recovery ladder.
        let arrived = true
        try { arrived = goal.isEnd(bot.entity.position.floored()) } catch {}
        if (arrived) return { recoveries, recoveryMs, reflexWaitMs }
        lastErr = new Error('path ended short of the goal')
      } catch (e) { lastErr = e }
      // Reflex handoff: someone SET a new goal mid-goto (flee/defend/charge). The
      // survival reflex wins - wait for it to release the pathfinder, then resume.
      // A goal cleared to NULL means a cancel (`stop`, our own timeout) - not resumable.
      if (goalWasChanged(lastErr) && bot.pathfinder.goal && interrupts < 6 && !isStopped()) {
        interrupts++
        dbg(label + 'goal taken by a reflex - waiting to resume (' + interrupts + ')')
        const t0 = Date.now()
        while (bot.pathfinder.goal && Date.now() - t0 < 15000 && !isStopped()) await new Promise(r => setTimeout(r, 250))
        await new Promise(r => setTimeout(r, 300)) // let the reflex's controls settle
        reflexWaitMs += Date.now() - t0
        continue
      }
      if (Date.now() >= dl() || isStopped()) throw honestFail(lastErr, counts, label, recoveryMs, reflexWaitMs)
      const r0 = Date.now()
      const rescued = await recoverOnce(bot, goal, counts, budgets, opts)
      recoveryMs += Date.now() - r0
      // MEASURED-STALL ESCALATION (mirrors walkStaged): a whole goto+recovery cycle that
      // netted < 2.5b of real travel - and wasn't dominated by a survival-reflex HOLD
      // (reflexWaitMs, the same exclusion walkStaged uses, so we never fight a flee/shelter
      // hold) - is a wedge. Two in a row and we break it with the aggressive manual escape
      // (forceUnstick), ONCE per nav, gated like the watchdog (never asleep/mid-dig, and not
      // while a force-escape already drives). escalate:false (walkStaged/travelFar legs)
      // keeps sole ownership of THEIR own escalation - no double-unstick.
      let stalled = false
      if (opts.escalate !== false) {
        const moved = Math.hypot(bot.entity.position.x - cyclePos.x, bot.entity.position.z - cyclePos.z)
        const cycleElapsed = Math.max(1, Date.now() - cycleT0)
        const reflexDominated = (reflexWaitMs - cycleReflex0) > cycleElapsed / 2
        stalled = moved < 2.5 && !reflexDominated
        stalls = stalled ? stalls + 1 : 0
        if (stalls >= 2 && !unstuck && !bot.isSleeping && !bot.targetDigBlock && !isForceUnsticking()) {
          unstuck = true
          dbg(label + 'measured wedge ~' + moved.toFixed(1) + 'b/' + Math.round(cycleElapsed / 1000) + 's x' + stalls + ' - forceUnstick')
          try { await forceUnstick(bot, { isStopped }) } catch {}
          if (rescued) recoveries++
          continue
        }
      }
      if (!rescued) {
        // No rung helped this pass. If we're measurably wedged and still hold the escape +
        // deadline budget, keep going so the stall counter can reach the escalation instead
        // of bailing to the caller/watchdog on the first failed recovery. Otherwise give up
        // honestly (unreachable goal, or the escape is already spent).
        if (stalled && opts.escalate !== false && !unstuck && !isForceUnsticking() && !bot.isSleeping && !bot.targetDigBlock && Date.now() < dl()) {
          dbg(label + 'no recovery rung applied but wedged (stall ' + stalls + ') - retrying toward escalation')
          continue
        }
        throw honestFail(lastErr, counts, label, recoveryMs, reflexWaitMs)
      }
      recoveries++
      dbg(label + 'recovered via ' + rescued + ' - retrying the path')
    }
  } finally { navDepth--; arbiter.endManeuver(manTok) }
}

// ---- ENTER / EXIT my own structure (nav slice B) -----------------------------------
// A first-class, ATOMIC, reflex-protected door maneuver - the fix for "can't reliably enter
// its own hut" (the pathfinder cannot PLAN through a closed door, so a plain goto to a cell
// INSIDE the box times out even on clear ground, and the door-assist force-walk got its goal
// stolen mid-crossing by reflexes - four "goal taken by a reflex" in a row, live).
//
// crossOwnDoor is the MUTEX-FREE crossing CORE (so navigateToInner's door pre-flight can call
// it while already holding the nav mutex - a navigateTo here would DEADLOCK). It:
//   1. (ENTRY only) paths to a PLANNABLE stand-off cell just OUTSIDE the door via
//      gotoOnce({duringRecovery}) - never navigateTo - so it never re-takes the mutex,
//   2. runs ONE open-align-step-through toward the target side INSIDE a protected maneuver span
//      (arbiter + recoveringDepth hold flee/defend off, so nothing interrupts between
//      door-open and threshold-cross), reusing the proven openNearbyDoor crossing logic,
//   3. verifies insideOwnStructure (grounded arrival); retries once; honest give-up.
// `hut` = the infra hut anchor; `dir` = 'in' | 'out'. Returns whether it ended on the target side.
async function crossOwnDoor (bot, hut, dir, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const P = require('./provision.js')
  if (!hut) return false
  const H = require('./hut-model.js')
  const GEO = process.env.DOOR_CROSS_GEOMETRIC !== '0' // default ON; =0 => today byte-for-byte
  const read = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const door = H.doorwayColumn(hut, read, { preferDoorBlock: GEO }) // F2: pin to the real door, ignore hole/unknown flap
  if (!door) { dbg('crossOwnDoor: no doorway found in the hut'); return false }
  const inside = H.thresholdCell(hut, door)
  const out = H.outsideCell(hut, door)
  const towards = dir === 'in'
    ? (inside ? { x: inside.x, y: hut.y, z: inside.z } : null)
    : (out ? { x: out.x, y: hut.y, z: out.z } : null)
  const done = () => dir === 'in'
    ? !!(P.insideOwnStructure && P.insideOwnStructure(bot))
    : !(P.insideOwnStructure && P.insideOwnStructure(bot))
  // F3: during a cooldown (3 failed crossings of this hut/dir in 90s) do NO maneuver at all -
  // return the geometric done() so the caller's plain goto takes over (it reaches interior
  // goals via the hole, which is the route the pathfinder kept proving works). No walking, no
  // fail counting while cooled; the entry clears on cooldown expiry / next success.
  const ledgerKey = hut.x + ',' + hut.y + ',' + hut.z + ':' + dir
  if (GEO) {
    const e = doorCrossLedger.get(ledgerKey)
    if (e && e.coolUntil > Date.now()) { dbg('crossOwnDoor(' + dir + '): cooling down - plain goto takes over (door ' + door.x + ',' + door.z + ')'); return done() }
  }
  const tok = arbiter.beginManeuver('cross-door', opts.priority != null ? opts.priority : arbiter.PRIORITY.PRESERVE, 25000)
  recoveringDepth++
  try {
    // ENTRY: path to the stand-off cell JUST OUTSIDE the door first (a plannable goal on open
    // ground - you cannot goto a cell inside a closed box). gotoOnce+duringRecovery, NOT
    // navigateTo: this may run inside navigateToInner's pre-flight, which holds the nav mutex.
    if (dir === 'in' && out && !done() && !isStopped()) {
      try { await gotoOnce(bot, new goals.GoalNear(out.x, hut.y, out.z, 1), 15000, { duringRecovery: true }) } catch (e) { dbg('crossOwnDoor: could not reach the door stand-off (' + e.message + ')') }
    }
    for (let tries = 0; tries < 2 && !done() && !isStopped(); tries++) {
      arbiter.refreshManeuver(tok, 25000)
      // F1 threads done() into the crossing (arrival via ANY opening ends it early); F2 pins
      // the candidate sort to the chosen door column. Old opts when the flag is off.
      await openNearbyDoor(bot, GEO ? { towards, isStopped, done, doorAt: door } : { towards, isStopped })
    }
  } catch (e) { dbg('crossOwnDoor: crossing failed (' + e.message + ')') } finally { recoveringDepth--; arbiter.endManeuver(tok) }
  const ok = done()
  dbg('crossOwnDoor(' + dir + '): ' + (ok ? 'on the intended side' : 'still on the wrong side') + ' (door ' + door.x + ',' + door.z + ')')
  if (GEO) { // F3: record the outcome; a run of failures trips the cross-nav cooldown
    const { entry, cooled } = crossVerdict(doorCrossLedger.get(ledgerKey), Date.now(), ok)
    if (entry) doorCrossLedger.set(ledgerKey, entry); else doorCrossLedger.delete(ledgerKey)
    if (cooled) dbg('crossOwnDoor: 3 failed crossings of hut ' + hut.x + ',' + hut.y + ',' + hut.z + ' - cooling down 120s, plain goto takes over')
  }
  return ok
}

// Public ENTER: a thin MUTEX-WRAPPED shell over crossOwnDoor (existing callers serialize on
// the nav mutex exactly as before, when enterStructure's stand-off leg took it). `hut`
// defaults to the bot's own. Returns whether it's inside.
function enterStructure (bot, hut, opts = {}) {
  const P = require('./provision.js')
  hut = hut || (P.listInfra && P.listInfra('hut')[0])
  if (!hut) { dbg('enterStructure: no hut known'); return Promise.resolve(false) }
  if (P.insideOwnStructure && P.insideOwnStructure(bot)) return Promise.resolve(true)
  return runOnNavChain(() => crossOwnDoor(bot, hut, 'in', opts))
}

// Public EXIT: the symmetric mutex-wrapped shell. Returns whether it got outside.
function exitStructure (bot, hut, opts = {}) {
  const P = require('./provision.js')
  hut = hut || (P.listInfra && P.listInfra('hut')[0])
  if (!hut) return Promise.resolve(false)
  if (!(P.insideOwnStructure && P.insideOwnStructure(bot))) return Promise.resolve(true) // already out
  return runOnNavChain(() => crossOwnDoor(bot, hut, 'out', opts))
}

// ---- watchdog FORCE-ESCAPE ---------------------------------------------------------
// Called by index.js's freeze watchdog when the position has been FROZEN for minutes
// while something was trying to move (live: 2h creeper standoff in a cave pocket; the
// 12-min surface wedge). Runs the recovery ladder directly - no goal needed - with the
// door rung OFF (door-assist calls gotoOnce, which yields to us: deadlock). Sets
// forceUnsticking so concurrent gotos stand down instead of fighting the manual
// controls, and recoveringDepth so the flee/defend reflexes hold off.
async function forceUnstick (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const p0 = bot.entity.position.clone()
  // WEDGE-MEMORY (semantic-world-map slice 1): this single choke point covers all three
  // forceUnstick escalators (walkStaged, the nav ladder, the watchdog). recordWedge no-ops
  // under 12b own-infra suppression (the #1 rule); the reflex-dominated exclusion is
  // INHERITED (the escalators already refuse forceUnstick while a survival reflex holds).
  try { prov().recordWedge(p0) } catch {}
  forceUnsticking = true
  recoveringDepth++
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    const counts = {}
    // indoor FIRST + generous: a wedge inside the hut must be freed by stepping to a free
    // interior cell, never by the dirt-pillaring the pit/climb rungs would otherwise try.
    const budgets = { indoor: 3, water: 1, wetbreach: 1, pit: 2, door: 0, climb: 2, nudge: 0, stepout: 2, drybreach: 1 }
    for (let i = 0; i < 4 && !isStopped(); i++) {
      const rescued = await recoverOnce(bot, null, counts, budgets, { isStopped, desperate: !!opts.desperate, digOut: !!opts.digOut })
      if (!rescued) break
      dbg('forceUnstick: ' + rescued + ' moved us to ' + bot.entity.position.floored())
      // keep going only while still boxed in (buried or pitted) - once in the open the
      // normal flows take back over. Inside our own hut a "free interior cell" IS the
      // destination - not buried, not a pit - so stop once the indoor rung has moved us.
      try { if (prov().insideOwnStructure && prov().insideOwnStructure(bot) && rescued === 'indoor') break } catch {}
      const buried = prov().hasSolidCeiling(bot, 12, { ignoreLeaves: true })
      if (!buried && !detectPit(bot)) break
    }
  } finally { recoveringDepth--; forceUnsticking = false; bot.clearControlStates() }
  const p1 = bot.entity.position
  return Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 1.5 || Math.abs(p1.y - p0.y) >= 1
}

// ---- reactiveMove: the bounded reactive-move primitive (NAV_REACTIVE_MOVE, Phase A) -------
// The reliable short move a survival REFLEX can DEPEND on. A creeper flee, a low-hp radial
// retreat, a hut-retreat approach, a recovery nudge/stepout each need to move the body a few
// blocks AWAY from a bomb or TOWARD safety in <2s. A goto is the WRONG instrument: under a live
// threat it can spend a 12s deadline planning-and-yielding and never move the body (the
// ~30x/day 'goto timed out' -> detonation death, DESIGN §1.1). This drives the body DIRECTLY on
// control-states - the proven burstAwayFrom / nudge / swimToShore idiom - HARD-capped at
// budgetMs, and returns a MEASURED net move, never an optimistic bool. Opens a SURVIVE arbiter
// span + recoveringDepth++ exactly like escapeWater, so lower reflexes/gotos hold off (unchanged
// coordination). It NEVER issues a goto or a long deadline. The optional short-A* refine
// (DESIGN §3 Phase A step 4) is INERT until Phase B/C ship a hazard predicate - until then this
// is pure control-driving. NAV_REACTIVE_MOVE=0 => defined but no adopter references it.

// PURE: the short target CELL to steer at, from the bot's current position. `awayFrom` -> a
// point `reach` blocks along the HORIZONTAL away-vector (me - threat) - the same radial
// burstAwayFrom and the flee code use (index.js). `toward` -> the goal itself when within
// `reach`, else a `reach`-capped step toward it. Y is held at pos.y (a flee/approach is a ground
// move; the caller re-lookAt's every tick). No bot, no world reads - offline-testable.
function reactiveTarget (pos, opts = {}) {
  const reach = opts.reach != null ? opts.reach : 8
  if (opts.awayFrom) {
    const ax = pos.x - opts.awayFrom.x; const az = pos.z - opts.awayFrom.z
    const n = Math.hypot(ax, az) || 1
    return { x: pos.x + (ax / n) * reach, y: pos.y, z: pos.z + (az / n) * reach }
  }
  const t = opts.toward || { x: pos.x, y: pos.y, z: pos.z }
  const tx = t.x - pos.x; const tz = t.z - pos.z
  const d = Math.hypot(tx, tz)
  const ty = t.y != null ? t.y : pos.y
  if (d <= reach || d === 0) return { x: t.x, y: ty, z: t.z }
  return { x: pos.x + (tx / d) * reach, y: ty, z: pos.z + (tz / d) * reach }
}

// #NN FLEE-STEER: when a retreat (awayFrom) is driving STRAIGHT into terrain (a wall/hill/water
// directly opposite the threat) it nets ~0 and the creeper catches it (live: 'creeper avoid netted
// only 0.0b' -> death). Pick the nearest WALKABLE direction that still increases distance from the
// threat - slide along the wall instead of into it. Rotates the away-vector outward (0, +/-40, +/-80,
// +/-120 deg) and returns the first cell ~2b ahead that is stand-in-able (solid floor, air at feet+
// head). Returns null only when fully boxed in (then the caller keeps the straight-away + hop). Impure
// (samples blocks) so it lives here, not in the pure reactiveTarget. REACTIVE_FLEE_STEER=0 -> unused.
function fleeSteerTarget (bot, pos, awayFrom, reach) {
  const Vec = Vec3
  const solidAt = (x, y, z) => { try { const b = bot.blockAt(new Vec(Math.floor(x), Math.floor(y), Math.floor(z))); return !!b && b.boundingBox === 'block' && !/water|lava/.test(b.name) } catch { return false } }
  const walkable = (x, z) => { const fy = Math.floor(pos.y); return solidAt(x, fy - 1, z) && !solidAt(x, fy, z) && !solidAt(x, fy + 1, z) } // ground + air for feet+head
  const baseAng = Math.atan2(pos.z - awayFrom.z, pos.x - awayFrom.x) // straight away from the threat
  for (const off of [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1]) { // ~40deg steps outward; prefers straight-away, then sideways
    const a = baseAng + off
    if (walkable(pos.x + Math.cos(a) * 2, pos.z + Math.sin(a) * 2)) { // a clear cell ~2b ahead in this direction
      return { x: pos.x + Math.cos(a) * reach, y: pos.y, z: pos.z + Math.sin(a) * reach }
    }
  }
  return null // fully boxed in
}

// PURE: is the reactive move DONE this tick? Retreat (`awayFrom`) completes once it has netted
// `minClearB` from the start; approach (`toward`) once within `arriveB` of the goal. null =>
// keep driving (the caller also stops at budget end - the fast, honest give-up). Offline-testable.
function reactiveDone (netMoved, distToGoal, opts = {}) {
  if (opts.awayFrom) return netMoved >= (opts.minClearB != null ? opts.minClearB : 8) ? 'cleared' : null
  return distToGoal <= (opts.arriveB != null ? opts.arriveB : 1.5) ? 'arrived' : null
}

let reactiveMoving = false // re-entrant guard: one reactive drive at a time (a reflex + a rung can both call)
async function reactiveMove (bot, opts = {}) {
  const awayFrom = opts.awayFrom || null
  const toward = opts.toward || null
  if ((!awayFrom && !toward) || (awayFrom && toward)) return { moved: 0, ok: false } // exactly one of toward/awayFrom
  if (reactiveMoving) return { moved: 0, ok: false }
  const budgetMs = Math.max(200, Math.min(opts.budgetMs != null ? opts.budgetMs : 2000, 3000)) // HARD cap - never a goto-length wait
  const minClearB = opts.minClearB != null ? opts.minClearB : 8
  const arriveB = opts.arriveB != null ? opts.arriveB : 1.5
  const reach = awayFrom ? minClearB : (opts.reach != null ? opts.reach : Math.max(minClearB, 8))
  const sprint = opts.sprint !== false
  const holdJump = opts.jump !== false // continuous bunny-hop (burst/nudge idiom); false => hop only on a measured stall (stepout idiom)
  const isStopped = opts.isStopped || (() => false)
  const priority = opts.priority != null ? opts.priority : arbiter.PRIORITY.SURVIVE
  reactiveMoving = true
  const tok = arbiter.beginManeuver('reactive-move', priority, budgetMs + 1000)
  recoveringDepth++
  const start = bot.entity.position.clone()
  let result = null
  try {
    try { bot.pathfinder.setGoal(null) } catch {} // honest cancel of any in-flight nav (it unwinds through its own catch while we drive)
    bot.setControlState('forward', true)
    if (sprint) bot.setControlState('sprint', true)
    if (holdJump) bot.setControlState('jump', true)
    const t0 = Date.now()
    let lastPos = start.clone(); let lastMove = Date.now()
    const FLEE_STEER_ON = process.env.REACTIVE_FLEE_STEER !== '0' // steer a stalled retreat around terrain
    let steerNet = 0; let steerSince = Date.now()
    while (Date.now() - t0 < budgetMs && !isStopped()) {
      const pos = bot.entity.position
      let target = reactiveTarget(pos, { awayFrom, toward, reach })
      // FLEE-STEER: a retreat wedged against a wall (net barely growing) -> aim at a clear walkable
      // direction that still moves away, instead of grinding straight into the terrain (the flee-wedge death).
      if (awayFrom && FLEE_STEER_ON) {
        const netNow = Math.hypot(pos.x - start.x, pos.z - start.z)
        if (netNow - steerNet >= 0.2) { steerNet = netNow; steerSince = Date.now() } // real progress -> keep straight away
        else if (Date.now() - steerSince > 450) { const s = fleeSteerTarget(bot, pos, awayFrom, reach); if (s) target = s; steerSince = Date.now() } // stalled -> steer clear
      }
      try { await bot.lookAt(new Vec3(target.x, pos.y + 1, target.z), true) } catch {} // re-aim each tick to hold the line
      await new Promise(r => setTimeout(r, 100))
      const now = bot.entity.position
      const netMoved = Math.hypot(now.x - start.x, now.z - start.z)
      const distToGoal = toward ? Math.hypot(now.x - toward.x, now.z - toward.z) : 0
      result = reactiveDone(netMoved, distToGoal, { awayFrom, minClearB, arriveB })
      if (result) break
      if (!holdJump) { // measured micro-stall hop (walkTo/stepout idiom) when not already hopping continuously
        const moved = now.distanceTo(lastPos)
        if (moved > 0.15) { lastPos = now.clone(); lastMove = Date.now() }
        else if (Date.now() - lastMove > 350) {
          bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 120)); bot.setControlState('jump', false)
          lastMove = Date.now()
        }
      }
    }
  } finally {
    bot.clearControlStates()
    recoveringDepth--
    arbiter.endManeuver(tok)
    reactiveMoving = false
  }
  const net = Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z)
  const ok = awayFrom ? net >= minClearB : (result === 'arrived')
  dbg('reactive-move: ' + (awayFrom ? 'away' : 'toward') + ' netted ' + net.toFixed(1) + 'b in <=' + budgetMs + 'ms -> ' + (ok ? 'ok' : 'short'))
  return { moved: net, ok }
}

function honestFail (lastErr, counts, label, recoveryMs, reflexWaitMs) {
  const tried = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => k + ' x' + n).join(', ')
  const e = new Error(((lastErr && lastErr.message) || 'no path') + (tried ? ' (tried: ' + tried + ')' : ''))
  e.nav = { counts, recoveryMs: recoveryMs || 0, reflexWaitMs: reflexWaitMs || 0 }
  return e
}

module.exports = { navigateTo, navigateToPreempt, gotoOnce, openNearbyDoor, crossOwnDoor, crossVerdict, enterStructure, exitStructure, swimToShore, escapeWater, escapeToDryLand, isEscapingWater, headInWater, feetInWater, jumpForAir, isNavigating, isRecovering, isForceUnsticking, forceUnstick, setDebugSink, detectPit, goalWasChanged, reactiveMove, reactiveTarget, reactiveDone, setDeliberateDrown, isDeliberateDrown, drownReflexSkips }
