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

t('jobSurvivalNeed: threshold is context-tunable (start=14 vs mid-activity critical=6)', () => {
  // starting a deep dive: 13 is too hungry
  assert.strictEqual(arb.jobMayProgress({ food: 13, hp: 20 }, { foodThreshold: 14 }), false)
  // CONTINUING an activity (mid-mine): only a CRITICAL crash (<=6) bails, not a normal 13
  assert.strictEqual(arb.jobMayProgress({ food: 13, hp: 20 }, { foodThreshold: 6 }), true, 'food 13 mid-mine is fine (>critical 6)')
  assert.strictEqual(arb.jobMayProgress({ food: 5, hp: 20 }, { foodThreshold: 6 }), false, 'food 5 mid-mine -> bail')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall arbiter tests passed')
process.exit(failures ? 1 : 0)
