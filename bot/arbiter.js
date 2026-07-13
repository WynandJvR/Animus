'use strict'
// PRIORITY ARBITER: the ONE owner-of-the-body coordinator. Before this, ~10 index.js
// reflexes (flee, auto-defend, auto-collect, scaffold-sweep, auto-torch, gaze, leash,
// sticky-follow, gear-up, surface) each `setGoal` on the single shared pathfinder with
// no coordination - so a deliberate navigation (walk to the hut door, come to a player)
// got its goal STOLEN mid-maneuver by whichever reflex fired next. Live: the bot could
// not enter its own hut on clear ground - the flight recorder showed FOUR
// `come: goal taken by a reflex - waiting to resume` in a row while flee/gaze/follow
// thrashed the approach, until an operator forced it through.
//
// navigate.isRecovering() half-addressed this but is only true during a RECOVERY rung
// (pillar-out / door-thread / water-hop), NOT during the ordinary goto approach + the
// door-assist that precedes it - exactly the window the door-entry lived in.
//
// This module is that missing coordination, as a tiny PURE priority ledger (no bot, no
// pathfinder - it only records who claims the body and at what tier, so it's offline-
// testable). The tiers ARE the design doc's precedence:
//   SURVIVE (3)  immediate danger - being hit, drowning, point-blank creeper
//   PRESERVE (2) protect gains / get to safety when NOT under active damage
//   PROGRESS (1) pursue the goal - deliberate navigation, builds, gathers
//   IDLE     (0) cosmetic/opportunistic reflexes (collect, torch, gaze, follow-resume)
//
// A "maneuver" is a self-declared span a mover opens while it drives the body (navigate
// wraps every navigateTo in one). A reflex consults `maneuverActive(minPri)` and DEFERS
// when a span at or above its own tier is running, instead of stealing the goal - so
// movers cooperate. Survival still wins: an emergency reflex passes a SURVIVE tier and
// is only ever blocked by another SURVIVE maneuver (or nothing).
//
// SAFETY: every span carries a TTL and auto-expires, so a mover that crashes without
// releasing can never wedge the reflexes permanently (the ledger self-heals).

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[arb] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const PRIORITY = { IDLE: 0, PROGRESS: 1, PRESERVE: 2, SURVIVE: 3 }
const NAMES = ['IDLE', 'PROGRESS', 'PRESERVE', 'SURVIVE']
const priName = p => NAMES[p] || String(p)

// Injectable clock so TTL/expiry logic is deterministically unit-testable.
let nowFn = () => Date.now()
function _setNow (fn) { nowFn = fn || (() => Date.now()) }

// Active maneuver spans, keyed by id. Concurrent spans are legal (navigateToPreempt runs
// alongside a queued navigateTo; a SURVIVE flee-retreat overlaps a PROGRESS trek), so we
// keep a set and report the MAX active tier - the body is effectively owned at that tier.
const spans = new Map() // id -> { label, pri, until }
let seq = 0

function prune () {
  const now = nowFn()
  for (const [id, s] of spans) if (s.until <= now) { spans.delete(id); dbg('maneuver EXPIRED', s.label, priName(s.pri)) }
}

// Open a maneuver span. Returns a token id (pass it to refresh/end). ttlMs bounds how
// long the span can survive without a refresh - a safety cap against a leaked span, not
// the intended lifetime (movers refresh as they work and end() in a finally).
function beginManeuver (label, pri = PRIORITY.PROGRESS, ttlMs = 25000) {
  const id = ++seq
  spans.set(id, { label: label || 'nav', pri, until: nowFn() + Math.max(0, ttlMs) })
  dbg('maneuver BEGIN', label, priName(pri), 'ttl=' + ttlMs)
  return id
}
function refreshManeuver (id, ttlMs = 25000) {
  const s = spans.get(id)
  if (s) s.until = nowFn() + Math.max(0, ttlMs)
}
function endManeuver (id) {
  const s = spans.get(id)
  if (s) { spans.delete(id); dbg('maneuver END', s.label, priName(s.pri)) }
}

// The highest-tier active span, or null. Prunes expired spans first.
function topManeuver () {
  prune()
  let top = null
  for (const s of spans.values()) if (!top || s.pri > top.pri) top = s
  return top ? { label: top.label, pri: top.pri } : null
}

// Is a maneuver of tier >= minPri currently driving the body? A reflex passes its OWN
// tier: true means "someone at least as important as me owns the body - defer, don't
// steal the goal." Default PROGRESS: the common case (idle reflexes yielding to any
// deliberate navigation).
function maneuverActive (minPri = PRIORITY.PROGRESS) {
  prune()
  for (const s of spans.values()) if (s.pri >= minPri) return true
  return false
}

// True if a reflex at `reflexPri` is CLEAR to take the body (nothing at or above its
// tier is maneuvering). The inverse of maneuverActive - named for the call site.
function mayInterrupt (reflexPri) { return !maneuverActive(reflexPri) }

// ---- JOB-LEVEL ARBITRATION (survive > preserve > progress > idle at the GOAL level) -------
// The maneuver ledger above governs NAVIGATION body-ownership. This governs which JOB the bot
// may pursue: the big subsystems (secureFood, gearup, build, branchMine, recovery, shelter)
// used to fire on their own triggers with scattered ad-hoc gates and FOUGHT (gearup started
// before secureFood finished -> mined starving -> died). ONE authority, evaluated from a
// survival-state snapshot: the highest UNMET need blocking progress. A PROGRESS job consults
// jobMayProgress() before starting AND while continuing, and YIELDS to the need. PURE (a state
// object in, a decision out - no bot) so it is offline-testable (bot/arbitertest.js) and has
// no module cycle; the bot->state snapshot lives in provision.survivalState.
//
// state fields (all optional; absent = not blocking): food (0..20), hp (0..20),
// threatDist (blocks to nearest hostile | null), drowning, onFire, inLava (bools),
// isNight, underArmored (bools).
// opts: foodThreshold (default 14 - the START gate; pass 6 for a mid-activity critical bail),
//       hpCritical (6), threatRange (6).
function jobSurvivalNeed (state, opts = {}) {
  const s = state || {}
  const hpCritical = opts.hpCritical != null ? opts.hpCritical : 6
  const threatRange = opts.threatRange != null ? opts.threatRange : 6
  const foodThreshold = opts.foodThreshold != null ? opts.foodThreshold : 14
  // IMMEDIATE DANGER first (SURVIVE, non-negotiable)
  if (s.inLava) return { tier: PRIORITY.SURVIVE, need: 'lava', reason: 'in lava' }
  if (s.onFire) return { tier: PRIORITY.SURVIVE, need: 'fire', reason: 'on fire' }
  if (s.drowning) return { tier: PRIORITY.SURVIVE, need: 'drowning', reason: 'head underwater' }
  if (s.hp != null && s.hp <= hpCritical) return { tier: PRIORITY.SURVIVE, need: 'heal', reason: 'hp ' + s.hp + ' <= ' + hpCritical }
  if (s.threatDist != null && s.threatDist <= threatRange) return { tier: PRIORITY.SURVIVE, need: 'threat', reason: 'hostile ' + (typeof s.threatDist === 'number' ? s.threatDist.toFixed(1) : s.threatDist) + 'b' }
  // HUNGER (SURVIVE): a progress job must not run while genuinely hungry (it mined starving)
  if (s.food != null && s.food < foodThreshold) return { tier: PRIORITY.SURVIVE, need: 'food', reason: 'food ' + s.food + ' < ' + foodThreshold }
  // NIGHT SHELTER for a naked bot (SURVIVE)
  if (s.isNight && s.underArmored) return { tier: PRIORITY.SURVIVE, need: 'shelter', reason: 'night + under-armored' }
  return null
}
// May a PROGRESS job run right now? True iff no SURVIVE need is unmet.
function jobMayProgress (state, opts = {}) { return jobSurvivalNeed(state, opts) == null }

module.exports = {
  PRIORITY,
  priName,
  jobSurvivalNeed,
  jobMayProgress,
  beginManeuver,
  refreshManeuver,
  endManeuver,
  topManeuver,
  maneuverActive,
  mayInterrupt,
  setDebugSink,
  _setNow,
  _reset: () => { spans.clear(); seq = 0 } // test hygiene
}
