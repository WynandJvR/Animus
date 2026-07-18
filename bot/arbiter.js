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
// threatDist (blocks to nearest MELEE hostile | null), creeperDist (blocks to nearest
// creeper | null - kept SEPARATE from threatDist so it can trigger at a longer range),
// drowning, onFire, inLava (bools), isNight, underArmored (bools), nightStuck (bool - the
// night has stopped ending, so the night+underArmored shelter need is NOT surfaced; the
// resolution is to re-arm, not hide).
// opts: foodThreshold (default 14 - the START gate; pass 6 for a mid-activity critical bail),
//       hpCritical (6), threatRange (6 - melee mobs), creeperRange (12 - a creeper is a walking
//       bomb; a build/mine must abort well before it closes to detonation range, unlike a
//       skeleton at 14m which must NOT abort a build).
function jobSurvivalNeed (state, opts = {}) {
  const s = state || {}
  const hpCritical = opts.hpCritical != null ? opts.hpCritical : 6
  const threatRange = opts.threatRange != null ? opts.threatRange : 6
  const creeperRange = opts.creeperRange != null ? opts.creeperRange : 12
  const foodThreshold = opts.foodThreshold != null ? opts.foodThreshold : 14
  // IMMEDIATE DANGER first (SURVIVE, non-negotiable)
  if (s.inLava) return { tier: PRIORITY.SURVIVE, need: 'lava', reason: 'in lava' }
  if (s.onFire) return { tier: PRIORITY.SURVIVE, need: 'fire', reason: 'on fire' }
  if (s.drowning) return { tier: PRIORITY.SURVIVE, need: 'drowning', reason: 'head underwater' }
  if (s.hp != null && s.hp <= hpCritical) return { tier: PRIORITY.SURVIVE, need: 'heal', reason: 'hp ' + s.hp + ' <= ' + hpCritical }
  if (s.threatDist != null && s.threatDist <= threatRange) return { tier: PRIORITY.SURVIVE, need: 'threat', reason: 'hostile ' + (typeof s.threatDist === 'number' ? s.threatDist.toFixed(1) : s.threatDist) + 'b' }
  // CREEPER (SURVIVE): distinct from a melee mob - it explodes, so a progress job must abort
  // at a longer range (12m) to leave room to back off before it detonates point-blank.
  if (s.creeperDist != null && s.creeperDist <= creeperRange) return { tier: PRIORITY.SURVIVE, need: 'creeper', reason: 'creeper ' + (typeof s.creeperDist === 'number' ? s.creeperDist.toFixed(1) : s.creeperDist) + 'b' }
  // LOW-HP SHELTER-AND-HOLD (SURVIVE): a HURT bot that is also ENDANGERED must stop grinding and
  // heal or it whittles to death (live: an armored far-gather at night went 18.7->11.7->0.77->dead).
  // BELOW threat/creeper on purpose - an active flee/back-off outranks, since resolving the mob is
  // what stops the whittling; this fires once no acute flee is owed but the bot is still exposed
  // (dark night or a hostile/creeper in the 16b danger band). The unconditional hp<=hpCritical(6)
  // floor above is the daylight-safe catch that trips even with nothing else nearby.
  const hpLow = opts.hpLow != null ? opts.hpLow : 10
  const endangered = (s.isNight && !s.nightStuck) || (s.threatDist != null && s.threatDist <= 16) || (s.creeperDist != null && s.creeperDist <= 16)
  if (s.hp != null && s.hp <= hpLow && endangered) return { tier: PRIORITY.SURVIVE, need: 'heal', reason: 'hp ' + s.hp + ' <= ' + hpLow + ' while ' + (s.isNight ? 'night' : 'threatened') }
  // HUNGER (SURVIVE): a progress job must not run while genuinely hungry (it mined starving)
  if (s.food != null && s.food < foodThreshold) return { tier: PRIORITY.SURVIVE, need: 'food', reason: 'food ' + s.food + ' < ' + foodThreshold }
  // NIGHT SHELTER for a naked bot (SURVIVE) - but NOT on a frozen/eternal night. When dawn
  // never comes (live: doDaylightCycle off, timeOfDay pinned) hiding is not a survivable
  // resolution - the bot must re-arm to get safe - so don't let "shelter" block progress
  // (gearup) forever. nightStuck is set once the night has demonstrably stopped ending.
  if (s.isNight && s.underArmored && !s.nightStuck) return { tier: PRIORITY.SURVIVE, need: 'shelter', reason: 'night + under-armored' }
  return null
}
// May a PROGRESS job run right now? True iff no SURVIVE need is unmet.
function jobMayProgress (state, opts = {}) { return jobSurvivalNeed(state, opts) == null }

// PURE: split the mid-mine break-out into a RESPONSE. `mineDanger` (provision.js) stays as
// sensitive as ever - it breaks the bot OUT of a committed dig at hp<12 OR a hostile<=6, the
// death-carousel guard. This classifies WHAT TO DO once broken out, so a hurt-but-safe bot on
// the surface stops bailing into an unbreakable loop (hp<12 forever, food<18 -> never regens).
// state fields: hp (0..20), hostileNear (bool - a melee/bow mob within 6), deep (bool - below
// the surface under a solid ceiling), threatReacts (climb-out count this run), recoverTries
// (recover attempts this run). Returns:
//   false     -> no danger (mirror mineDanger going quiet: no hostile AND hp back at/over low)
//   'up'      -> deep + a live reason: climb out of the shaft first (re-evaluated up top)
//   'bail'    -> yield the whole gather so isBusy clears and the flee/heal reflex stack owns it
//   'recover' -> the NEW case: hurt (crit<hp<low), no hostile, on the surface -> eat + heal here
//                then RESUME the same gather. Bounded to maxRecover attempts, then an honest bail.
// Every hostile/deep/critical branch maps to today's 'up'/'bail' verbatim; 'recover' is the only
// new outcome and is reachable ONLY on the surface with nothing attacking and hp above critical.
function mineThreatDecision (state, opts = {}) {
  const s = state || {}
  const hp = s.hp != null ? s.hp : 20
  const hostileNear = !!s.hostileNear
  const deep = !!s.deep
  const threatReacts = s.threatReacts || 0
  const recoverTries = s.recoverTries || 0
  const hpCritical = opts.hpCritical != null ? opts.hpCritical : 6   // matches jobSurvivalNeed's floor (arbiter.js:121)
  const hpLowMine = opts.hpLowMine != null ? opts.hpLowMine : 12     // matches mineDanger's arm (provision.js mineDanger)
  const maxClimbs = opts.maxClimbs != null ? opts.maxClimbs : 4      // today's threatReacts <= 4 (provision.js gatherLoop)
  const maxRecover = opts.maxRecover != null ? opts.maxRecover : 2
  if (!hostileNear && hp >= hpLowMine) return false                            // no danger (mirror mineDanger)
  if (hostileNear) return (deep && threatReacts <= maxClimbs) ? 'up' : 'bail'  // today, verbatim
  // hp-only from here (hp < hpLowMine, nothing within 6)
  if (hp <= hpCritical) return 'bail'                                          // truly critical: the hp-crisis reflex owns it
  if (deep) return (threatReacts <= maxClimbs) ? 'up' : 'bail'                 // NEVER eat-and-hold in a shaft: surface first
  if (recoverTries < maxRecover) return 'recover'                             // THE new case
  return 'bail'                                                               // recovery exhausted: honest bail
}

// PURE (#53 NAKED_IRON_GRACE): may a NAKED bot grab a FEW already-found adjacent iron ore
// before it climbs/bails out of a mining threat? The keystone: a naked bot that bails with 0
// iron on every deep threat can never bootstrap even boots -> permanent nakedness -> death loop.
// This lets it net the couple iron it's already standing next to, SAFELY - it never overrides
// the survival bail. Every hard invariant is a deny here; the impure grab-loop just calls this.
//   state: naked (bool, 0 armor pieces worn), isOre (bool, gathering iron ore), hp (0..20),
//          hostileMelee (bool, a mob within ~2.5b), oreGrabbed (count grabbed so far this react)
//   opts:  enabled (NAKED_IRON_GRACE on; false -> today, always deny), graceHpFloor (10 - well
//          above the hp-critical 6), graceOre (3 - the hard grab cap)
// hp <= graceHpFloor -> deny (bail); a mob in melee -> deny (react now, don't tank hits naked);
// grabbed >= graceOre -> deny (bounded); not naked / not ore / flag off -> deny (byte-for-byte).
function nakedGraceAllowed (state, opts = {}) {
  const s = state || {}
  if (opts.enabled === false) return false            // flag off -> today's climb/bail exactly
  if (!s.naked) return false                          // armored/partial mining is UNCHANGED
  if (!s.isOre) return false                          // only the iron-ore bootstrap case
  if (s.hostileMelee) return false                    // a mob within ~2.5b -> react now, no grab
  const hp = s.hp != null ? s.hp : 20
  const hpFloor = opts.graceHpFloor != null ? opts.graceHpFloor : 10
  if (hp <= hpFloor) return false                     // never mine through genuinely-low hp
  const maxOre = opts.graceOre != null ? opts.graceOre : 3
  if ((s.oreGrabbed || 0) >= maxOre) return false     // bounded: at most graceOre this react
  return true
}

// PURE (#53): minutes to cool off a fruitless gear-up attempt. Armored/partial keeps today's
// min(45, fails*10). A FULLY NAKED bot (0 pieces) must keep trying - it can't sit locked out 45
// min while it dies naked - so its cooldown is capped at nakedCap (12). Gated: the naked cap
// applies only when enabled (NAKED_IRON_GRACE on); flag off -> today's min(45, fails*10) exactly.
function gearupCooldownMin (fails, naked, opts = {}) {
  const base = Math.min(45, (fails || 0) * 10)
  if (opts.enabled === false || !naked) return base
  const nakedCap = opts.nakedCap != null ? opts.nakedCap : 12
  return Math.min(base, nakedCap)
}

// PURE: does a hostile at `dist` blocks count as a live threat, given whether the straight
// eye-line to it is blocked by solid rock? Close floor ALWAYS counts (may be right above/below
// or about to break through); beyond it, a fully walled-off mob is discounted.
function hostileThreatens (dist, blocked, opts = {}) {
  const floor = opts.floor != null ? opts.floor : 5
  if (dist == null) return false
  if (dist <= floor) return true
  return !blocked
}

module.exports = {
  PRIORITY,
  priName,
  jobSurvivalNeed,
  jobMayProgress,
  mineThreatDecision,
  nakedGraceAllowed,
  gearupCooldownMin,
  hostileThreatens,
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
