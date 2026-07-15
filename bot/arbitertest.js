'use strict'
// OFFLINE unit test for the priority arbiter (bot/arbiter.js) - the PURE body-ownership
// ledger, no bot/pathfinder. Proves the semantics the reflex gates rely on: a running
// maneuver of tier >= a reflex's tier makes the reflex DEFER; a lower-tier maneuver does
// not; concurrent higher-tier survival preempts; and spans auto-expire (leak safety).
// Run:  cd bot && node arbitertest.js

const assert = require('assert')
const arb = require('./arbiter.js')
const P = arb.PRIORITY

let failures = 0
function t (name, fn) {
  arb._reset(); arb._setNow(() => Date.now()) // isolation between cases
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

t('no maneuver -> nothing active, everyone may interrupt', () => {
  assert.strictEqual(arb.maneuverActive(P.PROGRESS), false)
  assert.strictEqual(arb.maneuverActive(P.SURVIVE), false)
  assert.strictEqual(arb.topManeuver(), null)
  assert.strictEqual(arb.mayInterrupt(P.IDLE), true)
})

t('a PROGRESS maneuver blocks IDLE+PROGRESS reflexes, not PRESERVE/SURVIVE', () => {
  arb.beginManeuver('nav', P.PROGRESS)
  assert.strictEqual(arb.maneuverActive(P.IDLE), true, 'idle reflex must defer')
  assert.strictEqual(arb.maneuverActive(P.PROGRESS), true, 'a peer PROGRESS reflex defers')
  assert.strictEqual(arb.maneuverActive(P.PRESERVE), false, 'a PRESERVE need still passes')
  assert.strictEqual(arb.maneuverActive(P.SURVIVE), false, 'a SURVIVE emergency still passes')
  // door-loop semantics: an idle reflex (collect/follow-resume) must NOT interrupt
  assert.strictEqual(arb.mayInterrupt(P.IDLE), false)
  // an emergency (flee-when-hit passes SURVIVE) is clear to act
  assert.strictEqual(arb.mayInterrupt(P.SURVIVE), true)
})

t('ending the maneuver frees the body', () => {
  const tok = arb.beginManeuver('nav', P.PROGRESS)
  assert.strictEqual(arb.maneuverActive(P.PROGRESS), true)
  arb.endManeuver(tok)
  assert.strictEqual(arb.maneuverActive(P.PROGRESS), false)
  assert.strictEqual(arb.maneuverActive(P.IDLE), false)
})

t('concurrent spans report the MAX tier; ending the top drops to the lower', () => {
  arb.beginManeuver('trek', P.PROGRESS)
  const surv = arb.beginManeuver('hut-retreat', P.SURVIVE)
  assert.strictEqual(arb.topManeuver().pri, P.SURVIVE, 'top is the survival retreat')
  assert.strictEqual(arb.maneuverActive(P.SURVIVE), true)
  arb.endManeuver(surv)
  assert.strictEqual(arb.topManeuver().pri, P.PROGRESS, 'back to the trek after the retreat ends')
  assert.strictEqual(arb.maneuverActive(P.SURVIVE), false)
})

t('spans auto-expire on TTL (a leaked maneuver cannot wedge reflexes forever)', () => {
  let clock = 1000
  arb._setNow(() => clock)
  arb.beginManeuver('leaky', P.PROGRESS, 5000) // expires at 6000
  assert.strictEqual(arb.maneuverActive(P.PROGRESS), true)
  clock = 6001 // past the TTL, and NOBODY called end()
  assert.strictEqual(arb.maneuverActive(P.PROGRESS), false, 'expired span must not keep blocking')
  assert.strictEqual(arb.topManeuver(), null)
})

t('refresh extends a span past its original TTL', () => {
  let clock = 0
  arb._setNow(() => clock)
  const tok = arb.beginManeuver('working', P.PROGRESS, 5000) // would expire at 5000
  clock = 4000
  arb.refreshManeuver(tok, 5000) // now expires at 9000
  clock = 6000
  assert.strictEqual(arb.maneuverActive(P.PROGRESS), true, 'refreshed span still active')
  clock = 9001
  assert.strictEqual(arb.maneuverActive(P.PROGRESS), false, 'expires after the refreshed TTL')
})

t('ending a stale/unknown token is a harmless no-op', () => {
  const tok = arb.beginManeuver('nav', P.PROGRESS)
  arb.endManeuver(tok)
  arb.endManeuver(tok) // double-end
  arb.endManeuver(99999) // never issued
  assert.strictEqual(arb.maneuverActive(P.IDLE), false)
})

// ---- JOB-LEVEL ARBITRATION (survive > progress) --------------------------------------
t('jobMayProgress: fed + safe -> progress allowed', () => {
  const s = { food: 18, hp: 20, threatDist: null, isNight: false, underArmored: true }
  assert.strictEqual(arb.jobSurvivalNeed(s), null, 'no unmet survive need')
  assert.strictEqual(arb.jobMayProgress(s), true)
})

t('jobMayProgress: food < 14 -> BLOCK progress (secure food first) - the core rule', () => {
  const s = { food: 13, hp: 20, threatDist: null }
  const need = arb.jobSurvivalNeed(s)
  assert(need && need.need === 'food', 'food need surfaced')
  assert.strictEqual(need.tier, P.SURVIVE)
  assert.strictEqual(arb.jobMayProgress(s), false, 'a progress job may NOT run while hungry')
})

t('jobMayProgress: threat live -> BLOCK progress', () => {
  const s = { food: 18, hp: 20, threatDist: 4 }
  const need = arb.jobSurvivalNeed(s)
  assert(need && need.need === 'threat')
  assert.strictEqual(arb.jobMayProgress(s), false)
  // a far threat does NOT block
  assert.strictEqual(arb.jobMayProgress({ food: 18, hp: 20, threatDist: 12 }), true, 'a hostile 12b away is not an emergency')
})

t('jobSurvivalNeed: PRECEDENCE - immediate danger outranks hunger', () => {
  const s = { food: 2, hp: 3, threatDist: 2, drowning: true }
  const need = arb.jobSurvivalNeed(s)
  assert.strictEqual(need.need, 'drowning', 'drowning (danger) is surfaced before food, even at food=2')
})

t('jobSurvivalNeed: hp critical, lava, night-shelter', () => {
  assert.strictEqual(arb.jobSurvivalNeed({ hp: 6 }).need, 'heal', 'hp<=6 -> heal')
  assert.strictEqual(arb.jobSurvivalNeed({ hp: 20, inLava: true }).need, 'lava')
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, isNight: true, underArmored: true }).need, 'shelter')
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, isNight: true, underArmored: false }), null, 'armored at night is fine')
  // FROZEN/ETERNAL NIGHT: dawn never comes - hiding can't resolve, so re-arm; shelter must NOT
  // block progress (gearup) then. But a REAL survive danger still outranks the stuck night.
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, isNight: true, underArmored: true, nightStuck: true }), null, 'stuck night + naked -> no shelter block (gear up instead of hiding forever)')
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, isNight: true, underArmored: true, nightStuck: true, threatDist: 3 }).need, 'threat', 'a live threat still blocks even on a stuck night')
})

t('jobSurvivalNeed: LOW-HP SHELTER-AND-HOLD - hurt+endangered -> heal, hurt+safe-day -> allowed', () => {
  // hp10 at night (not frozen) -> heal
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 10, isNight: true }).need, 'heal', 'hp10 at night -> heal')
  // hp10 in daylight with NO threat -> NOT a heal need (keep working; only the <=6 floor trips in the clear)
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 10, isNight: false }), null, 'hp10 day + no threat -> keep working')
  assert.strictEqual(arb.jobMayProgress({ food: 18, hp: 10, isNight: false }), true)
  // hp10 with a hostile 14b out (past melee range, inside the 16b danger band) -> heal
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 10, isNight: false, threatDist: 14 }).need, 'heal', 'hp10 + threat 14b -> heal')
  // a creeper 15b out (inside the 16b danger band, past the 12b creeper-abort) also endangers
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 10, isNight: false, creeperDist: 15 }).need, 'heal', 'hp10 + creeper 15b -> heal')
  // hp11 is above the 10 threshold -> no heal (hysteresis headroom below the 16 resume target)
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 11, isNight: true }), null, 'hp11 at night is above the low-hp trip')
  // the unconditional hp<=6 FLOOR still trips in broad daylight with nothing around
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 5, isNight: false }).need, 'heal', 'hp5 day -> heal (the <=6 floor)')
  // FROZEN night does not count as endangered for the low-hp trip (re-arm, don't hide)
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 10, isNight: true, nightStuck: true }), null, 'hp10 on a frozen night -> no heal block')
})

t('jobSurvivalNeed: PRECEDENCE - creeper/threat outrank the low-hp heal', () => {
  // a creeper at 8b + hp10 -> creeper (flee first; heal is below it)
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 10, creeperDist: 8, isNight: true }).need, 'creeper', 'creeper outranks low-hp heal')
  // a melee mob at 4b + hp10 -> threat (flee first)
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 10, threatDist: 4, isNight: true }).need, 'threat', 'threat outranks low-hp heal')
})

t('jobSurvivalNeed: threshold is context-tunable (start=14 vs mid-activity critical=6)', () => {
  // starting a deep dive: 13 is too hungry
  assert.strictEqual(arb.jobMayProgress({ food: 13, hp: 20 }, { foodThreshold: 14 }), false)
  // CONTINUING an activity (mid-mine): only a CRITICAL crash (<=6) bails, not a normal 13
  assert.strictEqual(arb.jobMayProgress({ food: 13, hp: 20 }, { foodThreshold: 6 }), true, 'food 13 mid-mine is fine (>critical 6)')
  assert.strictEqual(arb.jobMayProgress({ food: 5, hp: 20 }, { foodThreshold: 6 }), false, 'food 5 mid-mine -> bail')
})

t('jobSurvivalNeed: CREEPER at 10b -> BLOCK progress (need:creeper), at 14b -> allowed', () => {
  const near = arb.jobSurvivalNeed({ food: 18, hp: 20, creeperDist: 10 })
  assert(near && near.need === 'creeper', 'a creeper 10b away surfaces need:creeper')
  assert.strictEqual(near.tier, P.SURVIVE)
  assert.strictEqual(arb.jobMayProgress({ food: 18, hp: 20, creeperDist: 10 }), false, 'progress blocked with a creeper at 10b')
  // beyond the 12m creeper range -> allowed
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, creeperDist: 14 }), null, 'a creeper 14b away does not block')
  assert.strictEqual(arb.jobMayProgress({ food: 18, hp: 20, creeperDist: 14 }), true)
  // right at the boundary
  assert(arb.jobSurvivalNeed({ food: 18, hp: 20, creeperDist: 12 }), 'a creeper at exactly 12b blocks')
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, creeperDist: 12.1 }), null, '12.1b is past the creeper range')
})

t('jobSurvivalNeed: MELEE range unchanged - a far skeleton (threatDist 14, no creeper) does NOT block a build', () => {
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, threatDist: 14, creeperDist: null }), null, 'a skeleton 14b away must NOT abort a build (melee keeps range 6)')
  assert.strictEqual(arb.jobMayProgress({ food: 18, hp: 20, threatDist: 14 }), true)
  // a melee mob at 5b still blocks (threatRange 6 intact)
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, threatDist: 5 }).need, 'threat')
})

t('jobSurvivalNeed: PRECEDENCE - hp<=6 outranks a creeper', () => {
  const need = arb.jobSurvivalNeed({ food: 18, hp: 6, creeperDist: 8 })
  assert.strictEqual(need.need, 'heal', 'hp<=6 (heal) is surfaced before the creeper')
  // and a melee threat<=6 is surfaced before the creeper too (checked earlier in the ladder)
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, threatDist: 4, creeperDist: 8 }).need, 'threat')
})

t('jobSurvivalNeed: creeperRange is opt-tunable', () => {
  assert.strictEqual(arb.jobSurvivalNeed({ food: 18, hp: 20, creeperDist: 10 }, { creeperRange: 8 }), null, 'a tighter creeperRange 8 lets a 10b creeper pass')
  assert(arb.jobSurvivalNeed({ food: 18, hp: 20, creeperDist: 15 }, { creeperRange: 16 }), 'a wider creeperRange 16 blocks a 15b creeper')
})

// ---- LOS/reachability threat gate (hostileThreatens) ---------------------------------
t('hostileThreatens: close floor always counts; beyond it a walled-off mob is discounted', () => {
  assert.strictEqual(arb.hostileThreatens(3, true), true, 'point-blank counts even if the eye-line is "blocked"')
  assert.strictEqual(arb.hostileThreatens(4.9, true), true, 'inside the floor (5) always counts')
  assert.strictEqual(arb.hostileThreatens(5.1, true), false, 'just past the floor + walled off -> discounted')
  assert.strictEqual(arb.hostileThreatens(12, true), false, 'far + walled off -> discounted')
  assert.strictEqual(arb.hostileThreatens(8, false), true, 'a clear eye-line counts (reachable)')
  assert.strictEqual(arb.hostileThreatens(16, false), true, 'far but visible still counts')
  assert.strictEqual(arb.hostileThreatens(null, true), false, 'no distance -> not a threat')
  assert.strictEqual(arb.hostileThreatens(null, false), false)
  assert.strictEqual(arb.hostileThreatens(7, true, { floor: 8 }), true, 'a wider floor keeps a 7b walled mob counting')
})

t('jobSurvivalNeed: a walled-off creeper (discounted -> creeperDist null) + fed + healthy -> progress allowed', () => {
  // survivalState would set creeperDist=null once hostileThreatens discounts the enclosed mob
  const s = { food: 18, hp: 20, threatDist: null, creeperDist: null, isNight: false, underArmored: false }
  assert.strictEqual(arb.jobSurvivalNeed(s), null, 'no unmet need once the creeper is walled off')
  assert.strictEqual(arb.jobMayProgress(s), true)
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall arbiter tests passed')
process.exit(failures ? 1 : 0)
