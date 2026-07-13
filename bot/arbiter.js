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

module.exports = {
  PRIORITY,
  priName,
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
