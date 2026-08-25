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
const provHut = () => require('./provision-hut.js') // LAZY: provision-hut.js top-requires this module, so an eager import here would be a real cycle
const provRecovery = () => require('./provision-recovery.js') // LAZY: provision-recovery.js top-requires this module, so an eager import here would be a real cycle
const navProfile = require('./nav-profile.js') // PURE terrain policy - findDryLandExit (WATER_ESCAPE); no bot-module cycle
const selfWorld = require('./self-world.js') // THE one self/world truth: is this cell mine? am I at home? (review 2026-08-25 D5/§3.4). Registry arithmetic only - no bot-module cycle
const attempts = require('./attempts.js') // PURE + LEAF (no requires of its own): the (job, step, 4b-cell) memory that BOUNDS the one rescue path, and that the arbiter reads (review 2026-08-25 §3.3/§3.5)
const worldMemory = require('./world-memory.js') // the wedge/infra registry. Already in this module's load graph via self-world.js - reached directly so the rescue can ASK what it learned about a cell (recallWedge)

// §4: one definition of the sink rule; this module still owns its own sink. index.js injects
// it so debug lines persist to logs/bot-events.log.
const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[nav]')

const prov = () => require('./provision.js') // lazy - see layering note above
const provMining = () => require('./provision-mining.js') // LAZY: provision-mining top-requires navigate, so a top-level import here would be a real cycle
// NO touchP HERE, deliberately (2026-08-25). This module used to hold the house `touchP` helper
// for one caller - the recovery-rung stamp in recoverOnce - and that stamp is deleted: a rescue
// may not vouch for the job it is rescuing. Navigation reports movement by MOVING; telemetry's
// new-ground ratchet is what reads it. Re-adding a progress sink to this file is re-adding D1.

// ---- reflex arbitration ------------------------------------------------------------
// While a recovery is physically maneuvering (pillaring out of a pit, threading a
// doorway, hopping from water) the flee/defend reflexes must not hijack the pathfinder
// sideways - the recovery IS the escape. index.js checks this next to isEscaping().
let recoveringDepth = 0
function isRecovering () { return recoveringDepth > 0 }
// Active navigations (for observability + later flow arbitration).
let navDepth = 0
function isNavigating () { return navDepth > 0 }
// THE ONE rescue (unstick, below) is driving the body on manual controls - other gotos must
// stand down. Named for what it is since 2026-08-25: there is no "force escape" any more, and
// a latch that outlives the layer it was named after is the next drift (#4).
let unsticking = false
function isUnsticking () { return unsticking }

// ---- ROOT H (2026-08-02): these two latches GATE THE SCHEDULER TICK -------------------
// index.js's tick returns early while `isRecovering() || isUnsticking()` (its TICK_GATES
// table). Both are raised before an await and lowered in a `finally` - which is correct for a
// throw and useless for a hang: a promise that never settles never reaches its finally, so ONE
// hung await inside a recovery span pins the tick shut permanently. Live 2026-08-02: the tick
// ran every cycle (the liveness rung never fired) yet `schedLastPick` went 412s stale, i.e. the
// tick was returning before it ever picked a job. This is the FOURTH instance of the identical
// defect (`_maintaining` cost 4.5h on 07-31; `_recoveringDegraded` cost a death today), and the
// cure is the one commands.js already documents: the watchdog's terminal rung force-releases the
// latch THROUGH THE MODULE THAT OWNS IT.
//
// recoveringDepth is a COUNTER, not a boolean, so a force-release to 0 leaves any outer spans
// still unwinding: their `finally` would then drive it NEGATIVE, and isRecovering()'s `> 0` test
// would read a LATER, legitimate recovery span as "not recovering" - the protection inverted.
// So every decrement goes through endRecoverySpan(), clamped at 0. One definition, five callers.
function endRecoverySpan () { recoveringDepth = Math.max(0, recoveringDepth - 1) }
function releaseNavLatches () {
  const held = []
  if (recoveringDepth > 0) { held.push('recoveringDepth(' + recoveringDepth + ')'); recoveringDepth = 0 }
  if (unsticking) { held.push('unsticking'); unsticking = false }
  return held.length ? held.join('+') : null
}

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
  // `ms` IS THE ATTEMPT (2026-08-02). Yield to a watchdog FORCE-ESCAPE and to any ACTIVE
  // RECOVERY maneuver: their manual control-state driving must not fight a concurrent goto's
  // physics ticks (the pathfinder rewrites the controls every tick, so the manual escape LOSES -
  // live: step-out rungs reported 'no progress' for 3+ minutes at 433,62,112 while another flow's
  // goto stomped them). Door-assist's own gotos pass duringRecovery to skip the gate (they ARE
  // the recovery).
  //
  // The wait used to carry its OWN 45s bound, spent BEFORE the `ms` timer even started - so a
  // caller that asked for a 15s attempt could be gone for 60s, and navigateToInner's deadline
  // arithmetic (which hands this `ms`) never saw it. #6 says a bound must be a deadline on an
  // ATTEMPT: there is one attempt here, it is `ms` long, and the yield is part of it.
  const started = Date.now()
  if ((unsticking || recoveringDepth > 0) && !gopts.duringRecovery) {
    while ((unsticking || recoveringDepth > 0) && Date.now() - started < ms) await new Promise(r => setTimeout(r, 250))
    const waited = Date.now() - started
    if (waited > 1000) dbg('goto: yielded ' + Math.round(waited / 1000) + 's of its own ' + Math.round(ms / 1000) + 's attempt to a recovery/force-escape')
  }
  // SCAFFOLD SESSION: any block the pathfinder places while EXECUTING a goto (bridge,
  // 1x1 tower) is by definition movement scaffold, never build fabric - build blocks
  // are placed after the goto completes. The bracket lets the scaffold manager tag and
  // later tear down exactly those, even right next to a build made of the same material.
  const scaffold = require('./scaffold.js')
  scaffold.beginSession('goto')
  return new Promise((resolve, reject) => {
    let settled = false
    // #119: hand the bot in so the closing frame can flag what it placed as OWED and queue it
    // for navigateTo's closeOut. Nothing is dug here - this callback is synchronous and on the
    // nav hot path ([[body-first-priority]]).
    const done = (fn, v) => { if (!settled) { settled = true; scaffold.endSession(bot); fn(v) } }
    const timer = setTimeout(() => {
      try { bot.pathfinder.setGoal(null) } catch {}
      done(reject, new Error('goto timed out'))
    }, Math.max(500, ms - (Date.now() - started))) // whatever the yield above did not spend
    bot.pathfinder.goto(goal).then(
      () => { clearTimeout(timer); done(resolve) },
      e => { clearTimeout(timer); done(reject, e) }
    )
  }).finally(async () => {
    // ==== AUDIT 2026-07-29 FIX 6: PAY THE DEBT WHERE IT WAS INCURRED ======================
    // #119 pays scaffold debt in navigateTo's finally - once, when the WHOLE navigation ends.
    // But the debt is created at the PILLAR, mid-leg, and paid at the GOAL, which is somewhere
    // else entirely: by the time the navigation finishes the bot is 30 blocks past the tower it
    // built and every one of those cells is out of closeOut's 4.5-block reach, so it "pays"
    // nothing. Live proof: `session close: reclaimed` fired 3 times in 4h46m while the registry
    // grew to 336 unpaid cells, 155 of them placed by the pathfinder under purpose 'goto'.
    //
    // A 1x1 tower is reachable EXACTLY ONCE - while the bot is still on or beside it, right
    // after the leg that built it. That is this moment, so this is where it gets paid. Bounded
    // to 3 cells and reach-only (never a walk), so the nav hot path stays cheap
    // ([[body-first-priority]]); whatever is out of reach stays on the books as before.
    try {
      await scaffold.closeOut(bot, {
        max: 3,
        isStopped: gopts.isStopped,
        exclude: p => {
          try {
            const prov = require('./provision.js')
            return !!(prov.inBuildZone && prov.inBuildZone(p.x, p.z)) || !!(provHut().ownHutAt && provHut().ownHutAt(p)) || !!(provHut().onHutApron && provHut().onHutApron(null, p))
          } catch { return true } // cannot tell whether a build owns it -> do not touch it
        }
      })
    } catch (e) { dbg('leg closeOut failed (' + e.message + ') - the cells stay owed') }
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
// FIX 18: `target` is the bank cell the CLASSIFIER found (escapeWater passes it). When supplied it
// is authoritative - the whole defect was this function re-deriving "where is the shore" under a
// different rule than the one that decided a shore exists. Omitted -> the original ray search, so
// every other caller is unchanged.
async function swimToShore (bot, isStopped = () => false, target = null) {
  const feet = bot.entity.position.floored()
  // FIX 20b: only chase the classifier's cell when it is PLAUSIBLY SWIMMABLE from here. findBank
  // flood-fills through water AND air in 3D, so it can return a bank reached via an air pocket the
  // bot cannot swim through - and trying anyway costs seconds of air before the proven ray search
  // even starts. Measured today: the escape ladder already succeeds 55 of 63 times, so any change
  // that ADDS latency to the failure path makes the tail worse, not better. Near cells only.
  if (target && Math.hypot(target.x - feet.x, target.z - feet.z) > 6) {
    dbg('swim: the classifier\'s bank is ' + Math.round(Math.hypot(target.x - feet.x, target.z - feet.z)) + 'b out - not spending air on it, going straight to the ray search')
    target = null
  }
  if (target) {
    dbg('swim: heading for the bank the classifier found at (' + target.x + ', ' + target.y + ', ' + target.z + ')')
    try {
      bot.pathfinder.setGoal(null)
      await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), true)
      bot.setControlState('forward', true); bot.setControlState('jump', true); bot.setControlState('sprint', true)
      // FIX 20: the attempt is bounded by DISTANCE, not a flat 8s. Underwater the bot has ~20s of
      // air for the WHOLE ladder, so one rung may not spend half of it on a swim it is not making
      // progress on - the revocation probe will pull it out, but only after it has burned the time.
      const swimBudget = Math.min(6000, 1500 + Math.hypot(target.x - feet.x, target.z - feet.z) * 900)
      const t0 = Date.now()
      while (Date.now() - t0 < swimBudget && !isStopped()) {
        await new Promise(r => setTimeout(r, 120))
        if (!headInWater(bot) && bot.entity.onGround) { bot.clearControlStates(); dbg('swim: ashore at the classifier\'s bank'); return true }
        await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), true).catch(() => {})
      }
    } catch (e) { dbg('swim: bank swim failed (' + e.message + ')') } finally { try { bot.clearControlStates() } catch {} }
    if (!headInWater(bot)) return true
    dbg('swim: could not reach the classifier\'s bank - falling back to the ray search')
  }
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

// THE ONE READ OF "the escape is actually finished" - the bot-side sampler for
// navProfile.escapeComplete. headInWater alone was the old test, and a bot TREADING water satisfies
// it (head clear, nothing underfoot) - so the escape declared victory, ended the maneuver, released
// the body, and the bot sank and drowned. Twice, live 2026-07-30. `groundSolid` is the floor read
// that distinguishes "standing in a puddle" (done) from "afloat at the surface" (not done).
// Used by BOTH escapeWater's loop and index.js's drown-crisis verdict, so the two cannot disagree.
function outOfWater (bot) {
  try {
    if (!bot.entity) return false
    const f = bot.entity.position.floored()
    const h = bot.blockAt(f.offset(0, 1, 0))
    const g = bot.blockAt(f.offset(0, -1, 0))
    return navProfile.escapeComplete({
      head: h ? h.name : null,
      groundSolid: !!(g && g.boundingBox === 'block' && !/water|lava/.test(g.name))
    })
  } catch { return false }
}

// ROOFED-FLOOD rung: no shore to swim to and no adjacent bank to hop - so rise straight UP
// the water column toward an air pocket (face up, hold jump = swim up in water). Bounded.
// Deliberately NOT climbToSurface (its digs REFUSE water, provision.js climbToSurface - it would
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
// controls every tick (see the REACTIVE_MOVE flag block above). The job loops now stopDigging + setGoal(null) and
// AWAIT this; the index.js drown-crisis reflex fires it as a backstop/override. Opens a SURVIVE
// maneuver span so lower reflexes defer. Every rung is bounded (swim 15s + hop 2.5s/dir + air 6s,
// whole call capped at deadlineMs) and it returns an HONEST bool (still wet? false) - never wedges.
// #116 ESCAPE_ACCOUNTABLE (DESIGN §3.4 D1 + capability gap H, Root D)
//
// What this used to be: a FIXED ladder - swim, hop, rise - run under one SURVIVE span that
// nothing audited. On 2026-07-19 it held the body for 24 seconds in a flooded cave pocket where
// every one of those three rungs was physically impossible, and the span ended 1.7 seconds after
// the bot died. Three separate guards (this ladder, navigate's water/wetbreach rungs, and the
// index drown reflex) each believed one of the others owned the problem; the wetbreach rung
// literally handed control back to the reflex that was already failing.
//
// What it is now, and the three things that changed:
//   1. ONE OWNER. This function is the only water-escape authority. The index reflex is pure
//      detection and the recovery rungs delegate here, so a handoff loop is unrepresentable.
//   2. THE LADDER IS ORDERED BY DIAGNOSIS, NOT BY HABIT. classifySubmersion reads the world and
//      says what kind of trouble this is; 'submerged-enclosed' puts the VERTICAL rung FIRST
//      (capability gap H), because swimming toward a bank that does not exist is not a strategy.
//   3. EVERY RUNG MUST PROVE PROGRESS. Each rung runs under its own probed SURVIVE sub-span. The
//      probe is `floor(y) + 100 if breathing` - rising the column or clearing the head both count,
//      bobbing does not. A rung whose probe goes flat is REVOKED by the arbiter, aborts its await,
//      is BURNED for this crisis instance, and the ladder escalates. No rung can hold the body by
//      assertion again.
//
// The burn set is CONDITION-scoped, not time-scoped: it lives exactly as long as this call, and
// this call lives exactly as long as the bot is submerged. There is no cooldown anywhere in here
// (the 10s drownCooldownUntil timer this replaces was deleted from index.js).
//
// EPOCH: success is claimed only if the bot is alive in the SAME life it started in. The
// `swim: ashore on oak_planks` / `(drown-crisis) out of the water` pair at 15:51:19 was true and
// worthless - it described the respawn point, 137 blocks away, reached by dying.
const ESCAPE_PROBE_MS = 1000
let escapingWater = false
function escapeProbe (bot) {
  try {
    const y = Math.floor(bot.entity.position.y)
    return y + (headInWater(bot) ? 0 : 100)
  } catch { return -Infinity }
}
async function escapeWater (bot, { isStopped = () => false, deadlineMs = 35000 } = {}) {
  if (drownReflexSkips(deliberateDrown)) { dbg('drown-escape: deliberate-drown latch set (suicide-reset) - NOT escaping, letting it drown'); return false } // #63 §B.1
  if (escapingWater) return false // re-entrant guard: one escape at a time (reflex + job loop can both call)
  escapingWater = true
  const pathfix = require('./pathfix.js')
  const pocketEscape = require('./pocket-escape.js')
  const e0 = pathfix.epoch()
  const tok = arbiter.beginManeuver('drown-escape', arbiter.PRIORITY.SURVIVE, deadlineMs + 5000)
  // The sampler IS the accountability. One interval, two block reads per tick, alive only while
  // the bot is actually drowning (body-first-priority: this must not cost anything in peacetime).
  const sampler = setInterval(() => { try { arbiter.sampleManeuvers() } catch {} }, ESCAPE_PROBE_MS)
  // FIX 21: where the bot went under, and how hard the escape was - the inputs to the near-miss
  // record at the end. Captured HERE, before any rung moves the body.
  const startedAt = Date.now()
  let rungsUsed = 0
  let entryPos = null
  try { entryPos = bot.entity.position.floored() } catch {}
  try {
    const dl = Date.now() + deadlineMs
    // NOT `headInWater` any more. The ladder must keep working until the bot actually HAS A FLOOR:
    // a bot treading water is head-clear, and stopping there ended the maneuver, released the body
    // and let it sink - it drowned twice on 2026-07-30 holding a success claim. Same predicate the
    // caller judges by (index.js drown-crisis), so the escape can satisfy its own caller.
    // The TRIGGER is still head-based - this changes only when the ladder STOPS.
    const wet = () => !outOfWater(bot)
    if (!wet()) return true
    try { bot.stopDigging() } catch {} // a mid-dig await would otherwise hold the body underwater
    try { bot.pathfinder.setGoal(null) } catch {}
    const burned = new Set() // rungs proven useless for THIS crisis instance
    // Run one rung under its own probed sub-span. Returns 'out' | 'revoked' | 'failed'.
    const runRung = async (kind, fn) => {
      const rtok = arbiter.beginManeuver('escape:' + kind, arbiter.PRIORITY.SURVIVE, deadlineMs + 5000, { probe: () => escapeProbe(bot) })
      const stop = () => isStopped() || arbiter.maneuverRevoked(rtok)
      let ok = false
      try { ok = await fn(stop) } catch (e) { dbg('drown-escape: rung ' + kind + ' failed (' + e.message + ')') }
      const wasRevoked = arbiter.maneuverRevoked(rtok)
      arbiter.endManeuver(rtok)
      if (!wet()) return 'out'
      if (wasRevoked) { burned.add(kind); dbg('drown-escape: rung ' + kind + ' REVOKED - no progress, escalating'); return 'revoked' }
      if (!ok) burned.add(kind)
      return ok ? 'out' : 'failed'
    }
    // ==== AUDIT 2026-07-29 FIX 18: ONE DEFINITION OF "BANK" ==============================
    // The classifier and the rungs each had their own, and they disagreed. Live, twice today
    // (15:10 and 18:55, both fatal) and twice on the 07-20 tape:
    //   drown-escape: open-water-with-bank -> rung hop      <- classifier: there IS a bank
    //     manual water hop found no bank - still wet        <- executor: there is NOT
    //   ...rise REVOKED... breach... DIED
    // Three searches, three answers: findBank flood-fills 5 blocks in 3D; manualHopFromWater
    // looks ONLY at the 8 immediately adjacent cells; swimToShore marches 8 compass rays at the
    // water surface. So the ladder was ordered by a premise its own rungs could not act on, and
    // burned every rung on it while the bot drowned.
    // The classifier already KNOWS where the bank is - it computes the offset and throws it away.
    // Hand that cell to the rungs instead of making each one rediscover it under a narrower rule.
    // `bankAt` is refreshed every pass below, so a bank that opens mid-escape is picked up.
    let bankAt = null
    const rungs = {
      swim: (stop) => swimToShore(bot, stop, bankAt),
      hop: async () => { try { return await prov().manualHopFromWater(bot, bankAt) } catch { return false } },
      breach: async (stop) => { try { return await prov().breachWaterPocket(bot, { isStopped: stop }) } catch { return false } },
      vertical: async (stop) => { try { return await prov().escapeUpColumn(bot, { isStopped: stop }) } catch { return false } },
      rise: (stop) => jumpForAir(bot, 6000, stop)
    }
    while (wet() && Date.now() < dl && !isStopped()) {
      if (!pathfix.sameEpoch(e0)) { dbg('drown-escape: died mid-escape - abandoning the attempt, claiming nothing'); return false }
      arbiter.refreshManeuver(tok, deadlineMs + 5000)
      // DIAGNOSE, then order the ladder by what is actually wrong. Re-classified every pass, so a
      // situation that changes under us (a breach opens a bank) re-orders immediately.
      let situation = 'open-water-with-bank'
      bankAt = null
      try {
        const feet = bot.entity.position.floored()
        const read = (dx, dy, dz) => { const b = bot.blockAt(feet.offset(dx, dy, dz)); return b ? b.name : null }
        situation = pocketEscape.classifySubmersion(read, null)
        // FIX 18: the SAME search the classifier used to decide "with bank" - so the rung that
        // acts on that verdict aims at the very cell that produced it. Absolute, so the rungs
        // need no knowledge of the classifier's relative frame.
        const b = pocketEscape.findBank(read, 5, 150)
        if (b) bankAt = feet.offset(b.dx, b.dy, b.dz)
      } catch {}
      if (situation === 'open-water-with-bank' && !bankAt) {
        // The premise and the evidence disagree - do not order the ladder by a bank nobody located.
        dbg('drown-escape: classified with-bank but no bank cell resolved - treating as NO bank')
        situation = 'open-water-no-bank'
      }
      let order = pocketEscape.escapeRungOrder(situation) // capability gap H: 'submerged-enclosed' puts vertical FIRST
      // ==== AUDIT 2026-07-29 FIX 20: ORDER THE LADDER BY THE AIR BUDGET ===================
      // Live 19:10:52-57, immediately after FIX 18 shipped: the hop reached the classifier's bank
      // and put the bot on dirt - the capability worked - and it drowned three seconds later
      // anyway, because `swim` ran first and burned ~8 of the ~20 seconds of air failing.
      // Getting out is not enough; getting out IN TIME is the requirement.
      // With a bank cell actually resolved, distance decides which rung is cheapest: a bank at
      // arm's length is a 2-second jump, and swimming to it is the slow way to do the same thing.
      if (bankAt && order.indexOf('hop') > 0) {
        const d = Math.hypot(bankAt.x - bot.entity.position.x, bankAt.z - bot.entity.position.z)
        if (d <= 2.5) {
          order = ['hop', ...order.filter(k => k !== 'hop')]
          dbg('drown-escape: bank is ' + d.toFixed(1) + 'b away - hopping before swimming (air is the budget)')
        }
      }
      const next = order.find(k => !burned.has(k))
      if (!next) { dbg('drown-escape: every rung burned for this crisis (' + situation + ') - honest give-up'); break }
      dbg('drown-escape: ' + situation + ' -> rung ' + next)
      rungsUsed++
      const r = await runRung(next, rungs[next])
      if (r === 'out') break
    }
    // GROUNDED + EPOCH-SCOPED success. Both halves matter: the head must be out of the water NOW,
    // and it must be the same bot that went in.
    const out = !wet() && pathfix.sameEpoch(e0)
    dbg('drown-escape: ' + (out ? 'out of the water at ' + bot.entity.position.floored() : (pathfix.sameEpoch(e0) ? 'STILL WET after the ladder' : 'DIED - the escape outlived the bot, claiming nothing')))
    // ==== AUDIT 2026-07-29 FIX 21: REMEMBER THE PLACE THAT NEARLY DROWNED YOU ============
    // The hazard ledger only ever learned from DEATHS. Measured on today's tape: of 40 times the
    // bot went under, SEVENTEEN were during a drown-escape - it climbed out of a pocket and walked
    // straight back in, 55 escapes teaching it nothing about where they happened.
    // A SURVIVED escape now records a soft route cost at the entry cell, so A* bends around the
    // pocket instead of re-entering it. It is filed as a `miss`, never a death, so
    // gravePolicy.hazardHardArmed (2 deaths) can never be tripped by it - surviving a scare must
    // not be able to wall off terrain. Only NON-TRIVIAL escapes are recorded: one rung and out is
    // ordinary swimming, and 55 records a session would be noise, not memory.
    if (out && entryPos && (rungsUsed > 1 || Date.now() - startedAt > 3000)) {
      try { require('./world-memory.js').recordHazardMiss(entryPos, 'drowning') } catch {}
    }
    return out
  } finally { clearInterval(sampler); arbiter.endManeuver(tok); escapingWater = false }
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
  const roofed = () => { try { return !!(provHut().hasSolidCeiling && provHut().hasSolidCeiling(bot, 8, { ignoreLeaves: true })) } catch { return false } }
  const indoors = () => { try { return !!(provHut().insideOwnStructure && provHut().insideOwnStructure(bot)) } catch { return false } }
  if (Date.now() < dl && !isStopped() && !roofed() && !indoors()) {
    let ySurf = feet.y
    for (let dy = 0; dy <= 12; dy++) { const n = sample(feet.x, feet.y + dy, feet.z); if (!n || !/water/.test(n)) { ySurf = feet.y + dy; break } }
    dbg('escapeToDryLand: unclimbable lip - pillaring to y=' + (ySurf + 1) + ' then stepping off')
    try { await provMining().pillarUpTo(bot, ySurf + 1, { isStopped }) } catch (e) { dbg('escapeToDryLand: pillar failed (' + e.message + ')') }
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
  if (provHut().insideOwnStructure && provHut().insideOwnStructure(bot)) return null // my own hut is not a pit - don't pillar dirt in the living room
  if (provHut().hasSolidCeiling(bot, 20, { ignoreLeaves: true })) return null // roofed = not a pit
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
// ONE PHYSICAL DOOR, ONE CELL: its FOOT (the lower half). findBlocks matches BOTH halves of a
// door, so the collection loop below used to produce two candidates for one doorway - each
// burning a 15s gotoOnce and a door-budget slot on the same piece of wood, and making the
// "N door/gate candidates" line a lie. The HALF normalisation already existed, but only inside
// the per-candidate geometry, i.e. AFTER the goto had been spent. This is that same rule, one
// definition (#4), applied at collection time as well.
// Gates/trapdoors carry no `half` property and pass through unchanged. An unreadable block
// (unloaded chunk) passes through unchanged too - fail-open, because the per-candidate loop
// already re-reads and tolerates a bad cell.
function doorFootCell (bot, p) {
  try {
    const b = bot.blockAt(p)
    const half = b && b.getProperties ? (b.getProperties() || {}).half : null
    return half === 'upper' ? p.offset(0, -1, 0) : p
  } catch { return p }
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
        const foot = doorFootCell(bot, c) // both halves of one door collapse to one candidate
        const k = foot.x + ',' + foot.y + ',' + foot.z
        if (!seen.has(k)) { seen.add(k); cands.push(foot) }
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
    // ONE close-in walk per call, spent on the FIRST candidate we cannot path to. The candidates
    // are sorted best-first (crossOwnDoor pins the chosen doorway; otherwise nearest), so the
    // first one is the door worth walking at - and a village with eight doors can never turn this
    // into eight blind walks. The rest fall back to the honest logged skip.
    let closedIn = false
    for (const p of cands) {
      if (isDone()) return true // already on the target side (e.g. entered through the hole) - stop
      const blk = bot.blockAt(p)
      if (!blk) continue
      // NOTE: the walk-through below runs regardless of the door's open/closed STATE -
      // the pathfinder cannot ROUTE through door cells at all (it only bumps them open
      // on direct lines), and "open" is normalized to "walk line clear" further down
      // (for a sideways-hung door those are OPPOSITES - see passageClear).
      // GoalChanged here means SOMEONE ELSE called setGoal mid-goto. Which writer it was has
      // never been identifiable from the tape, so the line names every span that owned the body
      // at the moment it failed instead of leaving the next investigation to guess (#7).
      let planFail = null
      try { await gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 15000, { duringRecovery: true }) } catch (e) { planFail = e.message; dbg('door-assist: cannot reach door at ' + p + ' (' + e.message + ')' + (/goal was changed/i.test(e.message || '') ? ' - active spans: [' + arbiter.describeSpans() + ']' : '')) }
      // ==== THE CROSSING IS THE LAST RESORT - IT MAY NOT GIVE UP SILENTLY (2026-08-02) ========
      // This was `if (distanceTo(p) > 4) continue` - a measurement that produced NO ACTION and
      // NO LINE (#5, #7). Two ways to land here, and the second is invisible: mineflayer-pathfinder's
      // goto RESOLVES SUCCESSFULLY when the planner returns status 'noPath' with an EMPTY path
      // (node_modules/mineflayer-pathfinder/lib/goto.js:24 - `if (results.path.length === 0) cleanup()`),
      // which is exactly what a bot wedged among its own furniture gets. navigateToInner already
      // knows that resolve is a lie and re-checks goal.isEnd (:1361); this loop believed it and
      // then dropped the ONLY door.
      //
      // Live 2026-08-02 16:19-16:28, the bot sealed inside its own hut at (191,68,-100) with the
      // door 4.1b away at (190,68,-104): every crossing printed `1 door/gate candidates`, skipped
      // it here in 2ms, and reported `still on the wrong side`. Three of those tripped the F3
      // cooldown (now deleted), the harvest goals were all OUTSIDE, and the bot starved to hp1/food0
      // beside 17 mature wheat.
      //
      // The pathfinder is not the only way to travel four blocks, and this crossing already drives
      // the body on controls for the doorway itself. So: measure, and if we are short, WALK - with
      // the bounded reactive primitive the nudge/step-out rungs use (<=2.5s, measured net move, no
      // sprint/no hop so it cannot overshoot a doorway or need a jump the bot may not have at food 0).
      // Only then may we skip, and the skip says the numbers.
      let dist = bot.entity.position.distanceTo(p)
      if (dist > 4 && !closedIn && !isDone()) {
        closedIn = true
        dbg('door-assist: ' + (planFail ? 'no route' : 'goto ended short') + ' to the door at ' + p + ' - ' + dist.toFixed(1) + 'b away, walking at it on controls')
        try { await reactiveMove(bot, { toward: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, arriveB: 2, budgetMs: 2500, sprint: false, jump: false, isStopped: opts.isStopped, priority: arbiter.PRIORITY.SURVIVE }) } catch (e) { dbg('door-assist: close-in walk failed (' + e.message + ')') }
        const after = bot.entity.position.distanceTo(p)
        dbg('door-assist: close-in ' + dist.toFixed(1) + 'b -> ' + after.toFixed(1) + 'b toward the door at ' + p)
        dist = after
      }
      if (dist > 4) { dbg('door-assist: SKIPPING the door at ' + p + ' - still ' + dist.toFixed(1) + 'b away after a goto AND a 2.5s walk'); continue }
      try {
        // WALK THROUGH the doorway before re-planning: the pathfinder won't ROUTE
        // through even an open door that isn't on the direct line (verified in the hut
        // test - door opened, travel still "blocked"). But it CAN step INTO an open
        // doorway cell - so stand in the doorway first, then step out the far side
        // (height-tolerant: outside ground is often ±1).
        // Foot cell from the HALF property, never from the bot's y: a mid-hop read
        // (feet momentarily at y+1) picked the UPPER half here and shifted every
        // geometry probe one block up (live: bogus 'blocked side' flips at the hut).
        // Same rule as the collection loop, ONE definition - and the re-read is deliberate:
        // a candidate can go stale between collection and arrival.
        const base = doorFootCell(bot, p)
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
        try { goalInside = !!(opts.towards && typeof opts.towards.x === 'number' && provHut().ownHutAt && provHut().ownHutAt(new Vec3(opts.towards.x, opts.towards.y != null ? opts.towards.y : base.y, opts.towards.z))) } catch {}
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
        const ownHut = provHut().ownHutAt && provHut().ownHutAt(p)
        try {
          if (ownHut && provHut().healHomeCrater) {
            // QUICK patch from the doorway (no repositioning - a rim walk here would pull
            // us off the crossing line): fill only the reachable western lane so the
            // step-out below lands on solid ground.
            const n = await provHut().healHomeCrater(bot, ownHut, { isStopped: opts.isStopped, reposition: false })
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
          if (ownHut && provHut().healHomeCrater && !(provHut().ownHutAt && provHut().ownHutAt(bot.entity.position.floored()))) {
            const n = await provHut().healHomeCrater(bot, ownHut, { isStopped: opts.isStopped, reposition: true })
            if (n) dbg('door-assist: full-healed ' + n + ' crater cell(s) around home')
          }
        } catch (e5) { dbg('door-assist: full crater heal skipped (' + e5.message + ')') }
        return true
      } catch { continue }
    }
  } catch { }
  return false
}

// ---- the recovery maneuvers, and the plan runner --------------------------------
// The CATALOGUE of maneuvers the body owns. Each entry: when() says whether it can help right
// now (a world re-read, at the moment it would run); run() maneuvers and reports whether the
// bot demonstrably MOVED (>=2 blocks horizontally or rose >=1) or vouches for itself (the
// door-assist returns whether it crossed, the indoor rung whether it reached its cell) - always
// read from the world, never from intent.
//
// ==== IT IS NOT A LADDER ANY MORE (review 2026-08-25 §3.5(2), item 5) ==================
// `defaultBudgets()` stood here - `{ indoor: 3, water: 2, wetbreach: 1, door: 3, pit: 2,
// climb: 2, nudge: 2, stepout: 2 }` - and every caller could hand its own copy. That made the
// ORDER a fixed script (#3) and the BOUND a per-call counter that the next call re-armed to
// zero (#6): 532 step-outs, 325 `recovery: stuck`, 243 `climb -> no progress` and 151
// `drybreach -> no progress` in a single HEAD-era day, at a bot that was not moving.
// unstick() below chooses WHICH maneuvers apply from WHERE THE BODY IS, and the bound is a
// fact about that place (attempts.js), which moving re-arms. recoverOnce is now just the
// executor of that plan: an ordered list of kinds in, the kind that moved us out.
async function recoverOnce (bot, goal, plan, opts) {
  const isStopped = opts.isStopped || (() => false)
  const p0 = bot.entity.position.clone()
  const movedEnough = () => {
    const p1 = bot.entity.position
    return Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 2 || Math.floor(p1.y) > Math.floor(p0.y)
  }
  const xz = goalXZ(goal)
  const twd = xz ? { x: xz.x, z: xz.z, y: goalY(goal) } : null // door scans also look near the GOAL
  // ONE SELF/WORLD TRUTH (review 2026-08-25 §3.4): say WHERE WE ARE before naming a rung.
  // For four hours on 2026-08-03 the log's only account of a bot standing two blocks from its
  // own bed was `stuck UNDERGROUND ... climbing to the surface y=72` - a sentence made of two
  // wrong beliefs (the roof read as terrain, the hut read as a cave). The bot's own structures
  // are in the registry; there is no excuse for the log not to say "I am at home" (principle #7).
  const here = selfWorld.homeVolumeAt(p0.floored())
  if (here) dbg('recovery: I am AT HOME (' + here.zone + ') at ' + p0.floored() + ' - the way out of my own house is the DOOR, never the roof')
  const ladder = [
    { // HARD INVARIANT - wedged INSIDE the bot's own structure: step to a schema-correct
      // FREE interior cell, and NEVER pillar/dig/dirt-fill in the living room. Live, the
      // emergency escape pillared out with DIRT (head-height dirt piled on the furniture)
      // and the bot froze 150s boxed in by bed+dirt+table. This rung runs FIRST indoors
      // and uses only the no-dig pathfinder to reach a real floor-standing cell from the
      // self-structure model - no block placement, so the roof/furniture stay clean.
      kind: 'indoor',
      when: () => { try { return !!(provHut().insideOwnStructure && provHut().insideOwnStructure(bot)) } catch { return false } },
      run: async () => {
        const cell = provHut().freeInteriorCell ? provHut().freeInteriorCell(bot) : null
        if (!cell) { dbg('recovery: inside own structure but no free interior cell - holding (never pillaring indoors)'); return false }
        dbg('recovery: wedged INSIDE own structure at ' + p0.floored() + ' - stepping to free interior cell ' + cell + ' (no pillaring indoors)')
        // ==== THIS RUNG IS JUDGED BY ITS OWN GOAL, NOT BY DISPLACEMENT (2026-07-31) =========
        // The shared movedEnough() asks for >=2b of horizontal travel OR a GAIN in y. This rung's
        // whole job is the opposite: a SHORT step to an adjacent free cell in a 4x4 interior,
        // very often DOWNWARD off the furniture the bot climbed onto. So the correct escape
        // scores as failure on both clauses. Live 2026-07-31: the bot sat on its own crafting
        // table at (189,69,-100) with three free floor cells beside it, and every pass logged
        //   recovery: wedged INSIDE own structure ... stepping to free interior cell (190,68,-100)
        //   recovery indoor -> no progress
        // ...then the ladder escalated, forceUnstick's stepout put it BACK on the table, and the
        // whole watchdog cycle repeated every 5 minutes for hours. The rung was working; the
        // WITNESS was wrong. Success here is "I am standing in the cell I aimed at" - a verdict
        // read from the world, not a displacement threshold borrowed from a different rung.
        const arrivedAtCell = () => {
          try {
            const p1 = bot.entity.position
            return Math.hypot(p1.x - (cell.x + 0.5), p1.z - (cell.z + 0.5)) < 0.8 && Math.floor(p1.y) === Math.floor(cell.y)
          } catch { return false }
        }
        const indoorOK = () => arrivedAtCell() || movedEnough()
        // duringRecovery: this rung runs INSIDE recoverOnce's recoveringDepth++ span, so
        // without the flag gotoOnce's yield gate would make this OWN goto wait up to 45s
        // before it even starts whenever a free interior cell exists (latent 45s dead wait).
        try { await gotoOnce(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 0), 8000, { duringRecovery: true }) } catch {}
        if (indoorOK()) return true
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
        return indoorOK()
      }
    },
    { // in water the pathfinder never registers "on ground", so its planned jumps never
      // fire - it stands in a puddle forever (watched live, 8 min). Shallow trench: hop
      // straight onto the adjacent bank. Deep water (mid-river, no adjacent bank): swim
      // for the nearest shore on manual controls.
      // #116: a DROWNING bot is not this rung's business. When the head is under, this used to
      // run its own hop/swim/relocate ladder in parallel with the index drown reflex and the
      // wetbreach rung - three owners, no accountability. It now DELEGATES to escapeWater, the
      // single authority (which is re-entrant-guarded, so if the reflex already owns the escape
      // this returns honestly instead of starting a competing one). Feet-wet-but-breathing - a
      // shallow trench - is still genuinely this rung's job and is unchanged below.
      kind: 'water',
      when: () => feetInWater(bot),
      run: async () => {
        if (headInWater(bot)) {
          const out = await escapeWater(bot, { isStopped })
          return out || movedEnough()
        }
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
      // #116: gated on !headInWater. This rung's executor used to bail with `breach: low oxygen -
      // handing back to the drown reflex` - handing a drowning bot to the reflex that had already
      // failed it for 15 seconds, which came straight back here. That circular handoff is deleted
      // at both ends: the bail is gone from breachWaterPocket, and a submerged bot never reaches
      // this rung at all (the water rung above delegates to escapeWater first, and escapeWater
      // owns `breach` as one of ITS rungs, under a progress probe).
      kind: 'wetbreach',
      when: () => process.env.WATER_WEDGE_ESCAPE !== '0' &&
        feetInWater(bot) && !headInWater(bot) &&
        provHut().hasSolidCeiling(bot, 8, { ignoreLeaves: true }) &&
        !(provHut().insideOwnStructure && provHut().insideOwnStructure(bot)),
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
        // ==== AUDIT 2026-07-29 FIX 12: A PILLAR NEEDS BLOCKS ===============================
        // Live, on real terrain: the bot spawned into the shelter pit it had dug the night
        // before, with an empty pack, and tried to pillar out SIXTY times without moving - hp 11,
        // y 59.8, `recovery pit -> no progress` forever. It cannot pillar because it has nothing
        // to place, and nothing in this rung ever noticed.
        //
        // The remedy already exists: ensurePillarFiller digs a couple of dirt blocks from nearby
        // (never the bot's own support column, never a build/farm/liquid) - exactly what a player
        // does when stuck in a hole. It was wired to precisely ONE caller, the last-resort suicide
        // reset, and not to the rung whose entire job is climbing out of holes. Same shape as the
        // orchard rung: the capability was written, tested and left unreachable from where it was
        // needed.
        let filler = true
        try { filler = !!require('./scaffold.js').pickFiller(bot) } catch {}
        if (!filler) {
          dbg('recovery: in a PIT with nothing to pillar with - digging filler out of the wall first')
          try { filler = await provRecovery().ensurePillarFiller(bot, { isStopped, need: 4 }) } catch (e) { dbg('recovery: filler dig failed (' + e.message + ')') }
          if (movedEnough()) return true // digging the wall opened a way out on its own
          if (!filler) { dbg('recovery: no filler available and none diggable here - pillar rung cannot help, handing to the next rung'); return false }
        }
        dbg('recovery: wedged in a PIT at ' + p0.floored() + ' - pillaring out to y=' + pit.rimY)
        try { await provMining().pillarUpTo(bot, pit.rimY, { isStopped }) } catch (e) { dbg('recovery: pillar-out failed (' + e.message + ')') }
        if (movedEnough()) return true
        // ==== AUDIT 2026-07-29 FIX 17: IF YOU CANNOT PILLAR OUT, DIG OUT =====================
        // Live, 16:28-16:31 on the live server: wedged in a 1x1 shaft (solid on all four sides at
        // y61 AND y62, stone floor, open sky above), 3 dirt in the pack, needing ~4 blocks of
        // pillar. `recovery pit -> no progress` on repeat, `stepout -> no progress`, and the
        // watchdog's own force-escape gave up ("could not move me - will retry in 4 min"). The bot
        // sat in that hole for over three minutes and only an operator teleport freed it.
        //
        // The ladder had no rung that could help: `pit` escapes by PILLARING only (needs filler >=
        // the height), and `climb` - the rung that DIGS its way out via digStaircaseUp - is gated
        // on being UNDERGROUND, i.e. under a solid ceiling. An open-sky shaft is neither, so
        // nothing applied. Meanwhile digStaircaseUp, which cuts anti-grief-safe steps through
        // natural stone and is exactly what a player with a pickaxe does, sat one require away.
        // That is the fourth capability found today that exists, is tested, and is unreachable
        // from the place that needs it.
        dbg('recovery: pillar did not lift me out - cutting a staircase up the shaft wall instead')
        try { await provMining().digStaircaseUp(bot, pit.rimY + 1, { isStopped }) } catch (e) { dbg('recovery: staircase-out failed (' + e.message + ')') }
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
      //
      // ==== NOT APPLICABLE INSIDE MY OWN HOME (review 2026-08-25 D5/§3.4) ==================
      // This rung works by CUTTING: climbToSurface digs a staircase / pillars up. In the cells
      // the one dig rule protects - the hut fabric and the ground it stands on
      // (provision-core.digBlocked's own-infra arm, asked here through self-world.noDigAt so
      // there is no second copy of it) - every swing is refused by construction. Live
      // 2026-08-03: 243 x `climb -> no progress` at the bot's own doorstep, each one a rung
      // taking the body, burning its budget and reporting a failure it could never have avoided.
      // A rung that cannot succeed by construction is NOT APPLICABLE, not a failed attempt -
      // the same lesson the door rung's 16b gate was paid for. Falling through leaves the
      // situation to the rungs that actually fit a house: indoor and door.
      // This changes NOTHING about what may be dug: those digs were already refused. It only
      // stops asking.
      kind: 'climb',
      when: () => opts.climb !== false && provHut().hasSolidCeiling(bot, 12, { ignoreLeaves: true }) &&
        !selfWorld.noDigAt(bot.entity.position.floored()),
      run: async () => {
        // GROUNDED TARGET (#111). This rung used to hand climbToSurface `feet.y + 10` - a
        // number, not a place. Every hop left the bot ten blocks up and still under a ceiling,
        // so the rung re-fired and stepped again (live: y45 -> 55 -> 65 -> 75 over ground that
        // stands at y70-72), and the last hop pillared several blocks into open sky. The
        // ladder disappears STRUCTURALLY once the target is the surface the world actually has.
        const feet = bot.entity.position.floored()
        const surf = require('./pathfix.js').surfaceYAt(bot, feet.x, feet.z)
        if (!surf.known) { dbg('recovery: climb REFUSED at ' + p0.floored() + ' - the surface of my own column is UNKNOWN (chunk not loaded) - not guessing a target'); return false }
        // The goal's own Y is only admissible when the goal is in THIS column: "above the
        // surface" is a local fact. A remote goal on a hillside says nothing about the ceiling
        // over MY head, and maxing its Y in here is the same guess wearing a different hat.
        const gy = goalY(goal)
        const local = !!xz && Math.abs(Math.floor(xz.x) - feet.x) <= 1 && Math.abs(Math.floor(xz.z) - feet.z) <= 1
        const targetY = (local && gy != null) ? Math.max(surf.y, Math.floor(gy)) : surf.y
        dbg('recovery: stuck UNDERGROUND at ' + p0.floored() + ' - climbing to the surface y=' + targetY + ' (ground reads y' + surf.groundY + ')')
        try { await provMining().climbToSurface(bot, targetY, { isStopped, surfaceY: surf.y }) } catch (e) { dbg('recovery: climb-out failed (' + e.message + ')') }
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
        !(provHut().insideOwnStructure && provHut().insideOwnStructure(bot)),
      run: async () => {
        dbg('recovery: HARD-WEDGED dry at ' + p0.floored() + ' - digging out (bounded)')
        try { await prov().breachDryPocket(bot, { isStopped, wide: !!opts.desperate }) } catch (e) { dbg('recovery: drybreach failed (' + e.message + ')') }
        return movedEnough()
      }
    }
  ]
  // RUN THE PLAN, IN ORDER, EACH RUNG AT MOST ONCE (review 2026-08-25 §3.5(2), item 5).
  // What stood here was a per-rung BUDGET table: `counts[kind] >= budgets[kind] ? continue`,
  // plus, on a failure, `counts[kind] = budgets[kind]` to "spend its remaining budget". Thirteen
  // call sites hand-tuned that table (`{ door: 2, pit: 0, nudge: 1, stepout: 1 }`), which is
  // thirteen private copies of one policy, none of them a condition about the world (#6). Worse,
  // the counters were PER navigateTo: a fresh call re-armed every rung, so the same doomed rung
  // ran forever at the same cell - 532 step-outs, 243 `climb -> no progress` and 151
  // `drybreach -> no progress` in one HEAD-era day, at a bot that never moved.
  // The bound is now a fact about a PLACE, held in attempts.js and asked by unstick(): a rung
  // that achieved nothing in this 4b cell is not offered again until the cell, the world or a
  // full reset says otherwise. Within one rescue, `tried` is the whole of the bookkeeping.
  const byKind = new Map(ladder.map(r => [r.kind, r]))
  const tried = opts.tried instanceof Set ? opts.tried : new Set()
  for (const kind of (plan || [])) {
    if (isStopped()) return null
    if (tried.has(kind)) continue
    const step = byKind.get(kind)
    if (!step) continue
    let applies = false
    try { applies = step.when() } catch {}
    // The plan says "this maneuver can help HERE"; when() is the world re-read at the moment it
    // would run. A rung that does not apply is NOT an attempt and is not remembered as one.
    if (!applies) continue
    tried.add(kind)
    recoveringDepth++
    let ok = false
    try { ok = await step.run() } catch (e) { dbg('recovery ' + kind + ' threw: ' + e.message) } finally { endRecoverySpan() }
    dbg('recovery ' + kind + ' -> ' + (ok ? 'MOVED' : 'no progress'))
    // ==== ESCAPING IS NOT PROGRESS, AND THIS STAMP KILLED THE BOT (deleted 2026-08-25) ====
    // `if (ok) touchP('navRung:' + step.kind)` stood here. It was added on 2026-08-02 to stop a
    // survival job being failed at 43s while one of its legs was legitimately grinding through
    // nudge/stepout rungs, and its own comment conceded what it was: "this stamp says 'the body
    // is not frozen', never 'the job is productive'". Nothing downstream could tell the
    // difference, because there was ONE progress clock and the supervisor read it.
    //
    // What that cost, 2026-08-03 16:54 -> 20:10, wedged one block from its own hut:
    //   (watchdog) position FROZEN ~195s at (190,69,-100) - forcing an escape
    //   [nav] recovery: step-out 2 cell(s) toward 192,-100  -> stepout -> MOVED
    //   [nav] recovery: step-out 2 cell(s) toward 190,-100  -> stepout -> MOVED
    //   (wd) NUDGE autobuild - no verified progress for ~121s ... - marking stalled
    // The freeze watchdog fires at 195s; the job watchdog's fail rung is at 240s. Every rescue
    // netted 1.6-2.2b, returned MOVED, stamped here, and reset the job clock 45 SECONDS BEFORE
    // it could fail. Thirty-two times on an exact 4-minute period, zero FAIL-JOB in the last
    // 4h15m, and the process died still "continuing the active build" (review D1/§1a).
    // (2026-08-25, item 5: BOTH ends of that collision are now gone - the stamp with item 1,
    // and the 195s freeze watchdog with this item. There is no timer left that can rescue.)
    if (ok) return kind
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
//         profiles) | rescue:'light' (a time-critical leg: no cutting/pillaring rungs) | climb:false
//         to disable the climb rung (trek loops that manage their own surfacing)
//       | label (debug tag)
// ONE BODY, ONE ROUTE: concurrent navigateTo calls fight over the single pathfinder and
// the control states - live at 433,62,112 a bank-withdraw nav and the build travel each
// ran their own recovery ladder, interleaved every ~2s, and every manual step-out was
// stomped by the other flow's goto physics: position frozen for many minutes while both
// "recovered". Serialize behind a mutex: the body can only walk one route at a time; a
// queued flow just experiences a slower nav (honest) instead of a phantom wedge.
let navChain = Promise.resolve()
// ==== THE DOOR-CROSS COOLDOWN IS DELETED (2026-08-02) ==================================
// F3 was a module-level ledger keyed by (hut,dir): 3 failed crossings in 90s armed a 120s
// cooldown during which crossOwnDoor did NO MANEUVER AT ALL and returned done(), on the
// stated grounds that "the plain goto takes over". For an EXIT that claim is false by this
// module's own documentation (see the door pre-flight note in navigateToInner: "the
// pathfinder cannot PLAN through a closed door, so a plain goto to a cell INSIDE our hut -
// or from inside OUT to a world goal - burns its whole timeout unplannably"). The cooldown
// therefore disabled the ONLY mechanism that can leave the hut and named a successor that
// cannot do the job - #5, and a blanket timer hiding a livelock - #6.
//
// Live 2026-08-02 16:19-16:28+: `crossOwnDoor(out): cooling down - plain goto takes over
// (door 190,-104)` ~40 times in nine minutes, interleaved with three real attempts that all
// said `still on the wrong side` and immediately re-armed it. The bot never left. It starved
// at hp1/food0 inside a hut wrapped by its own mature wheat.
//
// What actually made the crossings fail is fixed above (door-assist's silent give-up), and
// the oscillation F3 was aimed at is already bounded per-nav (crossings<2, tries<2, door
// budget 3) and now by the nav leg ceiling. A crossing that cannot work must FAIL LOUDLY every
// time it is asked, not go quiet for two minutes. Deleting the patch layer is the fix (#1).
// Serialize a body onto the single-pathfinder mutex (see the note above). Any async fn
// that drives the pathfinder/controls end-to-end - a full navigateTo, or an atomic
// enter/exit-door shell - queues here so two flows never fight over the controls.
function runOnNavChain (fn) {
  const p = navChain.then(fn, fn)
  navChain = p.then(() => {}, () => {}) // failures release the mutex like successes
  return p
}
function navigateTo (bot, goal, opts = {}) {
  return runOnNavChain(async () => {
    try {
      return await navigateToInner(bot, goal, opts)
    } finally {
      // #119 COMMITMENT_LEDGER (design §3.3): the movement session that placed scaffold is
      // over, and this is the ONE moment the bot is still standing next to what it placed.
      // Pay for it here - within reach only, hard budget, never a walk - instead of leaving
      // it to an idle sweep a never-idle bot never reaches. In the `finally` deliberately: a
      // failed navigation placed blocks too, and those are exactly the ones that used to
      // become permanent. Its own errors are logged, never propagated - a tidy-up must not
      // turn a completed navigation into a failed one.
      try {
        const scaffold = require('./scaffold.js')
        await scaffold.closeOut(bot, {
          isStopped: opts.isStopped,
          // trail-teardown near builds is FORBIDDEN ([[action-verification]]); the build
          // zone and the bot's own hut are excluded from the registry pass too.
          exclude: p => {
            try {
              const prov = require('./provision.js')
              return !!(prov.inBuildZone && prov.inBuildZone(p.x, p.z)) || !!(provHut().ownHutAt && provHut().ownHutAt(p)) || !!(provHut().onHutApron && provHut().onHutApron(null, p))
            } catch { return true } // cannot tell whether a build owns it -> do not touch it
          }
        })
      } catch (e) { dbg('closeOut failed (' + e.message + ') - the cells stay owed') }
    }
  })
}
// PREEMPTING variant for time-critical reflexes (hut-retreat from a creeper): skips the
// queue and takes the pathfinder NOW, like the flee reflex does - the preempted nav sees
// 'goal was changed', waits for the pathfinder to free up, and resumes (that machinery
// predates this). Never use for routine navigation - the mutex exists for a reason.
function navigateToPreempt (bot, goal, opts = {}) { return navigateToInner(bot, goal, opts) }

// ==== ONE NUMBER FOR "THIS LEG HAS TAKEN TOO LONG" ([[threshold-seams]], 2026-08-02) ======
// Two layers were each bounding the same thing with their own number, and the OUTER one was
// the impatient one:
//   nav      deadline = max(90000, timeoutMs*4), + up to 90s of reflex credit, + a 45s
//            force-unstick gate inside gotoOnce  -> a caller asking for 10s could legitimately
//            run ~180-278s, logging NOTHING.
//   supervisor  concludes "no verified progress" at scheduler.SURVIVAL_FAIL_MS and revokes the
//            dispatch slot LATCH_GRACE_MS later.
// So the watchdog killed work that was still legally inside its budget and called merely-slow
// work "hung". A nav leg is the INNER layer: it must give its caller an honest answer BEFORE
// the supervisor draws a conclusion, so the supervisor's own patience IS the ceiling. Same
// derivation provision-recovery.js:1362 already uses for RUNG_NOPROGRESS_MS - the number is
// restated, never re-invented, and there is no env knob on it.
const LADDER_ATTEMPTS = 4 // a leg is worth this many `timeoutMs` attempts before it is hopeless
function supervisorPatienceMs () {
  // Lazy: scheduler.js sits above us in the load order (it requires provision -> navigate), so
  // an eager import is a real cycle. Reached once per navigateTo. The literal is a last-resort
  // fallback for a scheduler that failed to load at all - i.e. when there is no supervisor to
  // race - and is deliberately the same value, never a second policy.
  try { const s = require('./scheduler.js'); if (Number.isFinite(s.SURVIVAL_FAIL_MS)) return s.SURVIVAL_FAIL_MS } catch {}
  return 90000
}
// PURE (unit-tested): the overall budget for ONE navigateTo. The caller's timeoutMs finally
// means something - four attempts' worth - an explicit deadlineMs still wins, and NEITHER may
// outlive the supervisor's patience. Never shorter than a single attempt.
function navLegBudget (timeoutMs, deadlineMs, ceilingMs) {
  const asked = deadlineMs || timeoutMs * LADDER_ATTEMPTS
  return Math.max(timeoutMs, Math.min(asked, ceilingMs))
}

async function navigateToInner (bot, goal, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000
  const ceilingMs = supervisorPatienceMs()
  const budgetMs = navLegBudget(timeoutMs, opts.deadlineMs, ceilingMs)
  const startedAt = Date.now()
  const deadline = startedAt + budgetMs
  const isStopped = opts.isStopped || (() => false)
  const counts = {} // per-rung run COUNTS for the honest failure message only - never a gate (review §3.5: the bound is attempt memory, keyed to a cell)
  const label = opts.label ? opts.label + ': ' : ''
  let interrupts = 0
  let recoveries = 0
  let recoveryMs = 0
  let crossings = 0 // atomic doorway pre-flight crossings this nav (capped so a threshold flicker can't ping-pong)
  let stalls = 0    // consecutive goto+recovery cycles that netted < 2.5b of real travel
  // Time spent parked while a REFLEX held the pathfinder must not consume the deadline:
  // in a reflex storm (creeper standoff re-fleeing every second, live 2h+) every nav
  // burned its whole budget waiting and DIED at the deadline check before the recovery
  // ladder ever ran once. Credit the wait back so recovery always gets a shot.
  //
  // The credit is NOT separately capped any more (it was `min(reflexWaitMs, 90000)` - a second
  // invented number on top of the deadline's own). It does not need to be: this is the SAME
  // rule the supervisor applies to itself - boundedRung re-bases its no-progress clock for
  // every moment a hold is declared (provision-recovery.js:1391). Both layers ignore time the
  // body was legitimately owned by someone else; one rule, one definition (#4).
  let reflexWaitMs = 0
  const dl = () => deadline + reflexWaitMs
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
          const goalHut = xz && provHut().ownHutAt ? provHut().ownHutAt(new Vec3(xz.x, gy != null ? gy : bot.entity.position.y, xz.z)) : null
          const botHut = provHut().insideOwnStructure ? provHut().insideOwnStructure(bot) : null
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
      // ONE RESCUE, ONE CALL (review 2026-08-25 §3.5, item 5). Three layers used to live in this
      // block: recoverOnce with its per-rung budget table, a stall-counted forceUnstick "ONCE per
      // nav", and a second forceUnstick({digOut}) for "every rung failed and the goal is STILL
      // unreachable". Each was added after a different incident and none could see the others, so
      // a wedged leg ran the same rungs three ways and reported MOVED after netting two blocks.
      // unstick() is that whole stack: it asks WHERE the body is, plans for it, bounds itself on
      // attempt memory keyed to this 4b cell, escalates to the cutting rungs on the EVIDENCE that
      // the non-cutting plan already failed here, and returns a verdict when it is out of options.
      const res = await unstick(bot, goal, { isStopped, climb: opts.climb, rescue: opts.rescue, escalate: opts.escalate !== false, why: (opts.label || 'nav') + ' leg' })
      recoveryMs += Date.now() - r0
      for (const k of res.tried) counts[k] = (counts[k] || 0) + 1 // for honestFail's "tried:" line ONLY - a log fingerprint, never a gate
      const rescued = res.moved ? res.via : null
      // MEASURED-STALL PATIENCE (mirrors walkStaged): a whole goto+rescue cycle that netted < 2.5b
      // of real travel - and wasn't dominated by a survival-reflex HOLD (reflexWaitMs, the same
      // exclusion walkStaged uses) - is a wedge, and the next goto attempt gets a shorter leash.
      // It no longer TRIGGERS anything: escalation belongs to unstick, on its own evidence.
      let stalled = false
      if (opts.escalate !== false) {
        const moved = Math.hypot(bot.entity.position.x - cyclePos.x, bot.entity.position.z - cyclePos.z)
        const cycleElapsed = Math.max(1, Date.now() - cycleT0)
        const reflexDominated = (reflexWaitMs - cycleReflex0) > cycleElapsed / 2
        stalled = moved < 2.5 && !reflexDominated
        stalls = stalled ? stalls + 1 : 0
      }
      if (!rescued) {
        // No rung helped this pass. If we are measurably wedged and still hold deadline budget,
        // keep going: unstick escalates itself on the next call now that this cell is on its
        // books ("the non-cutting plan already failed here" arms the bounded dig-out), so the
        // retry is what reaches the escalation. Its verdict says whether that is worth anything.
        //
        // ==== NO ROUTE IS THE WEDGE EVIDENCE (2026-07-30, preserved) ========================
        // The dig-out rung was once armed ONLY by opts.digOut, which the freeze watchdog set from
        // a MEASURED POSITIONAL FREEZE. A bot that can still shuffle around inside a dead end is
        // not frozen, so it never qualified - and live, boxed into a 1x1 alcove beside its own
        // front door at hp 0.48 / food 0, it printed this for over an hour:
        //   nav to 185,-106 failed (path ended short of the goal (tried: door x3, climb x2, nudge x2))
        // Stuckness was being judged by the BODY ("am I moving?") when the condition that actually
        // matters is the OUTCOME ("can I get anywhere?"). Exhausting every rung with the goal still
        // unreachable IS that evidence and it is strictly stronger than a freeze. That trigger
        // survives verbatim - it is now unstick's `failedHere >= 1`, recorded per cell instead of
        // per nav, so it is not re-armed to zero by the next caller.
        // The ANTI-GRIEF ENVELOPE IS UNCHANGED: drybreach still refuses inside our own structure
        // and wherever the one dig rule protects the cell, still uses the escapeDiggable
        // whitelist, still bounded (<=8/12 digs, 25s), still aborts near hostiles.
        // Only a rescue that TRIED and failed is worth retrying toward its own escalation. 'held'
        // (a declared hold vouches for this stillness), 'busy' (another rescue owns the body) and
        // 'stopped' are all answers about someone else, and looping on them is a spin.
        const worthRetrying = res.verdict === 'exhausted' || res.verdict === 'no-plan'
        if (stalled && worthRetrying && opts.escalate !== false && !bot.isSleeping && !bot.targetDigBlock && Date.now() < dl()) {
          dbg(label + 'rescue verdict ' + res.verdict + ' (stall ' + stalls + ') - retrying the leg; the next rescue escalates on its own record')
          continue
        }
        throw honestFail(lastErr, counts, label, recoveryMs, reflexWaitMs)
      }
      recoveries++
      dbg(label + 'recovered via ' + rescued + ' - retrying the path')
    }
  } finally {
    navDepth--; arbiter.endManeuver(manTok)
    // #7: a leg that outlives the caller's OWN timeoutMs used to be completely silent - up to
    // a ~4 minute window with nothing in the tape but the caller's eventual error (or, on
    // success, nothing at all), which is how "slow" and "hung" became indistinguishable. One
    // greppable line, with the numbers, and only when the condition is true (#8: no per-leg
    // telemetry on the healthy path).
    const took = Date.now() - startedAt
    if (took > timeoutMs) {
      dbg(label + 'leg took ' + (took / 1000).toFixed(1) + 's: attempt ' + Math.round(timeoutMs / 1000) +
        's, budget ' + Math.round(budgetMs / 1000) + 's, ceiling ' + Math.round(ceilingMs / 1000) +
        's, reflex-hold ' + Math.round(reflexWaitMs / 1000) + 's, recoveries ' + recoveries +
        ' in ' + Math.round(recoveryMs / 1000) + 's')
    }
  }
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
    ? !!(provHut().insideOwnStructure && provHut().insideOwnStructure(bot))
    : !(provHut().insideOwnStructure && provHut().insideOwnStructure(bot))
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
  } catch (e) { dbg('crossOwnDoor: crossing failed (' + e.message + ')') } finally { endRecoverySpan(); arbiter.endManeuver(tok) }
  const ok = done()
  dbg('crossOwnDoor(' + dir + '): ' + (ok ? 'on the intended side' : 'still on the wrong side') + ' (door ' + door.x + ',' + door.z + ', hut ' + hut.x + ',' + hut.y + ',' + hut.z + ')')
  return ok
}

// Public ENTER: a thin MUTEX-WRAPPED shell over crossOwnDoor (existing callers serialize on
// the nav mutex exactly as before, when enterStructure's stand-off leg took it). `hut`
// defaults to the bot's own. Returns whether it's inside.
function enterStructure (bot, hut, opts = {}) {
  const P = require('./provision.js')
  hut = hut || (P.listInfra && P.listInfra('hut')[0])
  if (!hut) { dbg('enterStructure: no hut known'); return Promise.resolve(false) }
  if (provHut().insideOwnStructure && provHut().insideOwnStructure(bot)) return Promise.resolve(true)
  return runOnNavChain(() => crossOwnDoor(bot, hut, 'in', opts))
}

// ---- THE ONE RESCUE PATH: unstick() -------------------------------------------------
//
// ==== WHAT THIS DELETED, AND WHY (structural review 2026-08-25, D4 / §3.5, item 5) ======
// Rescue used to be a STACK of five independent stall detectors, each added after one
// incident, each blind to the others:
//   1. index.js's freeze watchdog  - "position FROZEN ~195s ... forcing an escape", then a
//      flat 4-MINUTE retry, a same-cell failure streak and a "DESPERATE" re-run.
//   2. forceUnstick                - a SECOND run of the same ladder with a second budget table.
//   3. the ladder's per-rung budgets - thirteen hand-tuned copies of one policy.
//   4. cycle-detect.js             - suppressed by its own >=48b gross-path floor, so it could
//      not see slow oscillation, and it delegated that case back to (1).
//   5. navigate's per-leg no-progress tallies.
// They interlocked destructively. The freeze watchdog fires at 195s; the job watchdog's fail
// rung is at 240s; every force-escape "succeeded" by 1.6-2.2b and (through the old navRung
// stamp) reset the job clock 45 seconds before it could fail. 32 times on an exact 4-minute
// period, to process death at 20:10 with the bot two blocks from its own bed. A rescuer invoked
// 3,081 times in four days is not a rescuer, it is the main loop.
//
// So there is ONE rescue now, and it is a PLAN, not a rung pile:
//   1. ASK WHERE I AM FIRST (self-world, the one ownership truth): inside my own structure ->
//      the DOOR, never the roof; at home -> the door; a pit -> pillar/staircase; water -> shore;
//      otherwise -> the open-ground rungs. A rung the situation cannot use is never offered.
//   2. BOUNDED, AND THE BOUND IS A CONDITION. Each rung runs at most once per rescue, and a rung
//      that achieved nothing IN THIS 4-BLOCK CELL is not offered again until the cell changes,
//      the world changes, or a full reset clears the record (attempts.js - the same memory the
//      arbiter uses, and the same one the terminal action re-arms by walking away).
//   3. ESCALATION IS EVIDENCE, NOT A TIMER. The cutting rungs (drybreach, and the wider breach)
//      arm when the non-cutting plan has already failed HERE, or when this cell is on the books
//      as a wedge (world-memory's nearOwnInfra-tagged records are finally read by something).
//      No cooldown, no 4-minute retry: there is nothing here that fires on the clock.
//   4. FAILURE IS A VERDICT. When the plan is spent, unstick RETURNS THAT. It does not re-arm
//      itself. The job's work ledger keeps running, the supervisor reaches NUDGE -> FAIL-JOB ->
//      GIVEUP on honest evidence, and the arbiter's terminal action (reflexes.terminalAction) is
//      the floor that takes the body and calls back in here with `force`.
// NOTHING IN HERE TOUCHES A PROGRESS LEDGER. A rescuer may not write the report card on the job
// it is rescuing (#7, and D1's whole autopsy).
//
// DIG PERMISSION IS UNCHANGED by any of this. provision-core.digBlocked / placeBlocked and
// scaffold.js remain the only authority; the plan merely stops OFFERING maneuvers the one dig
// rule would refuse (selfWorld.noDigAt), which removes 243 futile attempts and grants nothing.

// The rungs that work by CUTTING or by a long placement sequence. A time-critical leg (a
// 1.5s-fuse creeper back-off) may not run one: it would spend the whole fuse pillaring.
const SLOW_RUNGS = new Set(['pit', 'climb', 'wetbreach', 'drybreach'])

// PURE (unit-tested: bot/unsticktest.js). WHERE AM I -> which maneuvers can possibly help,
// in order. No bot, no world reads, no clock: `w` is the situation, already read once.
//   w.indoors  inside my own structure      w.home    in the home volume (structure/under-floor/support/apron)
//   w.wet/.submerged  feet/head in water    w.roofed  a solid ceiling overhead
//   w.pit      an open-sky hole             w.door    a door within reach
//   w.noDig    the one dig rule protects this cell (nothing here may be cut, by construction)
//   w.climb    the caller allows the surface climb    w.cut  the cutting escalation is armed
//   w.light    a time-critical leg: fast rungs only
function unstickPlan (w) {
  const plan = []
  const add = (...kinds) => { for (const k of kinds) if (k && !plan.includes(k)) plan.push(k) }
  // 1. WATER FIRST. A submerged bot has seconds; nothing else on this list matters yet, and
  //    the water rung delegates a drowning bot to escapeWater, the single owner (#116).
  if (w.submerged) add('water')
  else if (w.wet) { add('water'); if (w.roofed && !w.indoors) add('wetbreach') }
  // 2. THE WAY OUT OF MY OWN HOUSE IS THE DOOR (§3.4). For four hours on 2026-08-03 the log's
  //    only account of a bot standing two blocks from its own bed was "stuck UNDERGROUND ...
  //    climbing to the surface" - a sentence made of two wrong beliefs. Indoors, the plan is
  //    step-to-a-free-cell then the door; never the roof, never a dirt pillar in the living room.
  if (w.indoors) add('indoor', 'door', 'stepout')
  else if (w.home) { add('door'); if (w.pit) add('pit'); add('stepout', 'nudge') }
  else {
    if (w.pit) add('pit')
    if (w.door) add('door')
    if (w.roofed && w.climb && !w.noDig) add('climb')
    add('nudge', 'stepout')
  }
  // 3. THE LAST RESORT, and only on the evidence the caller already gathered. `!w.noDig` is the
  //    permission truth asked once (self-world), not a second copy of "don't cut your own house".
  if (w.cut && !w.indoors && !w.wet && !w.noDig) add('drybreach')
  return w.light ? plan.filter(k => !SLOW_RUNGS.has(k)) : plan
}

// THE accountable rescue. Returns a VERDICT, never a promise to try again later:
//   { moved, via, verdict, plan, tried, cell, n }
//   verdict: 'moved' | 'exhausted' | 'no-plan' | 'stopped'
// `goal` may be null (a rescue with nowhere to be - the terminal action's call). opts:
//   isStopped | climb:false | rescue:'light' | escalate:false (the caller owns escalation)
//   | digOut / desperate (the terminal action's deepest passes) | force (ignore this cell's
//   attempt records - the floor may not refuse itself) | why (who asked, for the log)
async function unstick (bot, goal, opts = {}) {
  // ONE BODY, ONE RESCUE. Two rescues driving manual control-states at once is the 433,62,112
  // failure verbatim: a bank-withdraw nav and the build travel each ran their own ladder,
  // interleaved every ~2s, and every manual step-out was stomped by the other flow's goto physics
  // while the position stayed frozen for minutes and both "recovered". The old shape spelled this
  // as a `!isForceUnsticking()` guard at each of the three escalation call sites - three copies of
  // one rule, and one of them (walkStaged) never had it. It belongs here, once, where the latch is.
  if (unsticking) {
    dbg('unstick: a rescue is already driving the body - not starting a second one')
    return { moved: false, via: null, verdict: 'busy', plan: [], tried: [], cell: null, n: 0 }
  }
  const isStopped = opts.isStopped || (() => false)
  // No body, no rescue. The floor calls this from a crisis path where the entity can be briefly
  // absent (a respawn in flight), and an unreadable body is not evidence of a wedge (#10).
  if (!bot.entity || !bot.entity.position) return { moved: false, via: null, verdict: 'no-body', plan: [], tried: [], cell: null, n: 0 }
  const p0 = bot.entity.position.clone()
  const feet = p0.floored()
  const cell = attempts.cellOf(feet)
  const now = Date.now()
  // 1. WHERE AM I - one truth, asked once (review §3.4).
  const home = selfWorld.homeVolumeAt(feet)
  const indoors = (() => { try { return !!(provHut().insideOwnStructure && provHut().insideOwnStructure(bot)) } catch { return false } })()
  // ...AND WHAT DO I ALREADY KNOW ABOUT THIS SPOT. recordWedge has tagged the ones at home
  // `nearOwnInfra` since 2026-08-25 and listWedges (the STEER side) correctly refuses to route
  // the bot away from its own base because of them - which left them recorded and read by
  // nobody. They are evidence for the RESCUE side: "this cell has trapped me before" is exactly
  // the fact that should make the escalation arrive sooner instead of on a 4-minute timer.
  const known = (() => { try { return worldMemory.recallWedge(feet) } catch { return null } })()
  const spent = attempts.recall('unstick', 'exhausted', cell)
  const failedHere = Math.max(spent ? spent.n : 0, known && known.n > 1 ? known.n - 1 : 0)
  const escalate = opts.escalate !== false
  const light = opts.rescue === 'light'
  const w = {
    indoors,
    home: !!home,
    wet: feetInWater(bot),
    submerged: headInWater(bot),
    roofed: (() => { try { return !!provHut().hasSolidCeiling(bot, 12, { ignoreLeaves: true }) } catch { return false } })(),
    pit: !!detectPit(bot),
    door: doorNearby(bot, goalXZ(goal)),
    noDig: !!selfWorld.noDigAt(feet),
    climb: opts.climb !== false,
    cut: escalate && !light && (opts.digOut === true || failedHere >= 1),
    light
  }
  const desperate = opts.desperate === true || failedHere >= 2
  const plan = unstickPlan(w)
  const where = indoors ? 'INSIDE my own structure' : (home ? 'at home (' + home.zone + ')' : (w.submerged ? 'submerged' : (w.wet ? 'in water' : (w.pit ? 'in a pit' : (w.roofed ? 'under a ceiling' : 'in the open')))))
  // ONE greppable line with the numbers in it (#7), and it names the SITUATION before the tools.
  dbg('unstick: ' + where + ' at ' + feet + ' (cell ' + cell + ') - plan ' + (plan.join(' > ') || 'NONE') +
    (failedHere ? ' [failed here x' + failedHere + (known && known.nearOwnInfra ? ', a known wedge at home' : (known ? ', a known wedge' : '')) + ']' : '') +
    (w.cut ? ' [cutting armed]' : '') + (desperate ? ' [wide]' : '') + (light ? ' [light leg]' : '') + (opts.why ? ' - ' + opts.why : ''))
  if (!plan.length) {
    dbg('unstick: NO PLAN applies at ' + feet + ' - reporting that instead of thrashing')
    return { moved: false, via: null, verdict: 'no-plan', plan, tried: [], cell, n: failedHere }
  }
  // A DECLARED HOLD IS NOT A WEDGE. Sitting perfectly still until a named wake IS the goal - sealed
  // in a pit until dawn, asleep in a bed, waiting out a famine indoors - and the layer that could
  // not tell that from a hang was the freeze watchdog: on 2026-07-29 it fired on a correctly sealed
  // night shelter, dug the bot out into the dark, and a creeper killed it at 19:24:33. That guard
  // moves here with the rest of that watchdog's job, and it is asked of the ONE authority
  // (reflexes.activeHold) through the caller, because only the runner can judge a hold's PREMISE -
  // a shelter that declares "resting until dawn" while still eleven blocks away vouches for
  // nothing, and must not be able to stand a rescue down. A caller that supplies no reader gets
  // today's behaviour exactly: the rungs never consulted holds, only the deleted watchdog did.
  const hold = (() => { try { return opts.holdOK ? opts.holdOK() : null } catch { return null } })()
  if (hold) {
    dbg('unstick: standing down - ' + hold.label + ' is a DECLARED hold waking on ' + hold.wake + '; stillness here is the goal, not a wedge')
    return { moved: false, via: null, verdict: 'held', plan, tried: [], cell, n: failedHere }
  }
  // 2. RUN IT. The body is taken on manual controls for the duration (concurrent gotos yield),
  //    and the flee/defend reflexes hold off - unchanged coordination, one owner now instead of two.
  const triedSet = new Set()
  const skipped = new Set() // what this cell has ALREADY failed - not attempts, and never re-recorded as such
  // The floor may not refuse itself (§3.3): a forced rescue re-tries rungs this cell has already
  // failed, because the alternative is a terminal action that cannot break the wedge it names.
  if (!opts.force) for (const kind of plan) { if (attempts.recall('unstick', kind, cell)) { triedSet.add(kind); skipped.add(kind) } }
  if (skipped.size) dbg('unstick: skipping ' + Array.from(skipped).join(',') + ' - already achieved nothing in this cell')
  let via = null
  unsticking = true
  recoveringDepth++
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    // A rescue WITH a goal hands back the moment a rung moves us: the goto is the real arrival
    // test, and re-running rungs against a stale reading is how the old ladder shuttled. A rescue
    // with NO goal (the terminal action) keeps going while still boxed in - one rung rarely frees
    // a buried bot - which is the only thing forceUnstick's 4-iteration loop was ever for.
    const passes = goal ? 1 : 3
    for (let i = 0; i < passes && !isStopped(); i++) {
      const rescued = await recoverOnce(bot, goal, plan, { isStopped, tried: triedSet, digOut: w.cut, desperate, climb: w.climb })
      if (!rescued) break
      via = rescued
      dbg('unstick: ' + rescued + ' moved us to ' + bot.entity.position.floored())
      if (goal) break
      if (indoors && rescued === 'indoor') break
      let buried = false
      try { buried = !!provHut().hasSolidCeiling(bot, 12, { ignoreLeaves: true }) } catch {}
      if (!buried && !detectPit(bot)) break
    }
  } finally { endRecoverySpan(); unsticking = false; bot.clearControlStates() }
  // 3. THE VERDICT, read from the world (never from intent).
  const p1 = bot.entity.position
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 1.5 || Math.abs(p1.y - p0.y) >= 1
  const tried = Array.from(triedSet).filter(k => !skipped.has(k))
  if (isStopped() && !moved) return { moved: false, via, verdict: 'stopped', plan, tried, cell, n: failedHere }
  if (moved) {
    // The cell is behind us. Its records die with it - not because a timer expired, but because
    // the thing they were about (being stuck HERE) stopped being true.
    attempts.forget('unstick', 'exhausted', cell)
    for (const k of triedSet) attempts.forget('unstick', k, cell) // the whole cell's memory, skipped ones included - we are not in it any more
    return { moved: true, via, verdict: 'moved', plan, tried, cell, n: failedHere }
  }
  // ==== FAILURE IS A VERDICT, NOT A RETRY (§3.5(3)) =====================================
  // What used to happen here: nothing was returned to anyone, and index.js's freeze watchdog
  // re-fired the identical escape 4 minutes later, forever. There is no timer in this branch.
  // The record is what the arbiter reads (candidateRefusal asks attempts.futile for every job),
  // the wedge memory is what the next rescue reads, and the supervisor's honest clock is what
  // escalates - to the terminal action, which is the one caller allowed to force a rescue.
  for (const k of tried) attempts.record('unstick', k, cell, { now, why: 'the ' + k + ' maneuver achieved nothing here' })
  const rec = attempts.record('unstick', 'exhausted', cell, { now, why: 'the whole rescue plan (' + plan.join('>') + ') achieved nothing here' })
  try { prov().recordWedge(p0) } catch {} // a stuck-spot is a place the rescue could NOT free me
  dbg('unstick FAILED at ' + feet + ' (' + where + '): tried ' + (tried.join(', ') || 'nothing applicable') +
    (skipped.size ? ' (' + Array.from(skipped).join(',') + ' already failed here)' : '') +
    ' - attempt ' + rec.n + ' in this cell. No retry is armed; the job clock keeps running and the arbiter owns what happens next.')
  return { moved: false, via: null, verdict: 'exhausted', plan, tried, cell, n: rec.n }
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
  // AUDIT 2026-07-29: this used `!solidAt(feet) && !solidAt(head)` to mean "clear", and WATER IS
  // NOT SOLID - so a lake with a sand bottom read as perfectly walkable and the bot fled a creeper
  // straight into it and drowned. liquidCost cannot help here: a reactive flee drives the controls
  // directly and never asks the pathfinder. Now it asks navProfile.standable, the ONE definition
  // (see the header block there for the six that disagreed).
  const nameAt = (x, y, z) => { try { const b = bot.blockAt(new Vec(Math.floor(x), Math.floor(y), Math.floor(z))); return b ? b.name : null } catch { return null } }
  const walkable = (x, z) => {
    const fy = Math.floor(pos.y)
    return navProfile.standable({
      groundSolid: solidAt(x, fy - 1, z),
      ground: nameAt(x, fy - 1, z),
      feet: nameAt(x, fy, z),
      head: nameAt(x, fy + 1, z)
    }) // dry policy: a retreat must never steer the body into water
  }
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
    endRecoverySpan()
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

module.exports = { doorFootCell, navigateTo, navigateToPreempt, gotoOnce, crossOwnDoor, openNearbyDoor, navLegBudget, enterStructure, swimToShore, escapeWater, escapeToDryLand, isEscapingWater, headInWater, feetInWater, outOfWater, jumpForAir, isNavigating, isRecovering, isUnsticking, releaseNavLatches, unstick, unstickPlan, setDebugSink, reactiveMove, reactiveTarget, reactiveDone, setDeliberateDrown, isDeliberateDrown, drownReflexSkips }
