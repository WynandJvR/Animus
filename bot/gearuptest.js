'use strict'
// OFFLINE unit test for #60 IRON_ARMOR_UNSTICK - the two PURE gear-up policy helpers in
// provision.js, plus the flag-gated compositions they feed (gearupResult's back-off branch,
// and the maintenancePass proactive-armor admission). No bot / pathfinder / world-mem writes.
// Run:  cd bot && node gearuptest.js
//
// (a) gearupShouldArmBackoff({progressed, interrupted, hadMaterial}) -> arm the naked back-off?
//     interrupted (survival preempt / stop) -> NO; a genuine no-progress failure -> YES.
// (b) proactiveGearupGate({armored, hasIron, hp, fed, day, atHome, backoffActive}) -> fire the
//     safe-window smelt->craft->equip only when ALL guards hold.
// BOTH flag regimes are covered by modelling the exact call-site branch the flag gates:
//   §A GEARUP_PREEMPT_EXEMPT: gearupResult arms iff  !progressed && (!flag || shouldArm)
//   §B GEARUP_PROACTIVE:      STEP 6 admits proactively iff  flag && proactiveGearupGate(...)

const assert = require('assert')
const p = require('./provision.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

// --- exact mirrors of the two flag-gated call sites (provision.js) -------------------
// §A: gearupResult's else-branch. progressed short-circuits to a reset (never arms).
const wouldArm = (flagOn, r) => r.progressed ? false : (flagOn ? p.gearupShouldArmBackoff(r) : true)
// §B: the STEP 6 `proactiveArmor` admission (env flag AND the pure gate).
const wouldFireProactive = (flagOn, state, opts) => flagOn && p.proactiveGearupGate(state, opts)

// ---- (a) gearup-accounting predicate ------------------------------------------------
t('gearupShouldArmBackoff: interrupted -> do NOT arm (even with no progress)', () => {
  assert.strictEqual(p.gearupShouldArmBackoff({ progressed: false, interrupted: true }), false)
  assert.strictEqual(p.gearupShouldArmBackoff({ progressed: false, interrupted: true, hadMaterial: true }), false, 'material on hand but survival cut it short - still not a failure')
})

t('gearupShouldArmBackoff: genuine no-progress failure -> ARM (material or not)', () => {
  assert.strictEqual(p.gearupShouldArmBackoff({ progressed: false, interrupted: false, hadMaterial: true }), true, 'completed-but-0-slots / furnace unreachable')
  assert.strictEqual(p.gearupShouldArmBackoff({ progressed: false, interrupted: false, hadMaterial: false }), true, 'no iron obtainable')
})

t('gearupShouldArmBackoff: progress -> never arm (the caller resets instead)', () => {
  assert.strictEqual(p.gearupShouldArmBackoff({ progressed: true, interrupted: false }), false)
  assert.strictEqual(p.gearupShouldArmBackoff({ progressed: true, interrupted: true }), false)
})

t('accounting BOTH regimes: flag ON exempts interrupted; flag OFF arms it (byte-for-byte)', () => {
  const interrupted = { progressed: false, interrupted: true, hadMaterial: true }
  const genuine = { progressed: false, interrupted: false, hadMaterial: true }
  const progressed = { progressed: true, interrupted: false }
  // flag OFF (=0): today's accounting - ANY no-progress attempt arms, progress does not.
  assert.strictEqual(wouldArm(false, interrupted), true, 'flag off: interrupted still arms (unchanged)')
  assert.strictEqual(wouldArm(false, genuine), true, 'flag off: genuine failure arms')
  assert.strictEqual(wouldArm(false, progressed), false, 'flag off: progress never arms')
  // flag ON: the preempt-exempt fix - interrupted no longer arms; genuine still does.
  assert.strictEqual(wouldArm(true, interrupted), false, 'flag on: interrupted is exempt (the fix)')
  assert.strictEqual(wouldArm(true, genuine), true, 'flag on: genuine failure still arms')
  assert.strictEqual(wouldArm(true, progressed), false, 'flag on: progress never arms')
})

// ---- (b) proactive-gearup gate ------------------------------------------------------
const SAFE = { armored: false, hasIron: true, hp: 16, fed: true, day: true, atHome: true, backoffActive: false }

t('proactiveGearupGate: all-safe -> fire', () => {
  assert.strictEqual(p.proactiveGearupGate(SAFE), true)
})

t('proactiveGearupGate: each guard failing -> do NOT fire', () => {
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, armored: true }), false, 'already armored')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, hasIron: false }), false, 'no iron on hand (no naked excursion)')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, hp: 13 }), false, 'hp below the 14 safe floor')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, hp: null }), false, 'unknown hp -> refuse')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, fed: false }), false, 'food crisis')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, day: false }), false, 'night')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, atHome: false }), false, 'away from the furnace/bank')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, backoffActive: true }), false, 'back-off cooling off')
})

t('proactiveGearupGate: GEARUP_SAFE_HP boundary (>= fires, < refuses)', () => {
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, hp: 14 }), true, 'exactly the floor fires')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, hp: 13.9 }), false)
  // an operator-raised floor is honoured
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, hp: 15 }, { safeHp: 18 }), false, 'custom floor 18 not met')
  assert.strictEqual(p.proactiveGearupGate({ ...SAFE, hp: 18 }, { safeHp: 18 }), true)
})

t('proactive BOTH regimes: flag OFF never fires; flag ON fires only when the gate holds', () => {
  // flag OFF (=0): reactive-only - the proactive admission is inert regardless of how safe it is.
  assert.strictEqual(wouldFireProactive(false, SAFE), false, 'flag off: no proactive gear-up (byte-for-byte)')
  // flag ON: fires in the safe window, defers otherwise.
  assert.strictEqual(wouldFireProactive(true, SAFE), true, 'flag on: fires when safe')
  assert.strictEqual(wouldFireProactive(true, { ...SAFE, hasIron: false }), false, 'flag on: no iron -> defer')
  assert.strictEqual(wouldFireProactive(true, { ...SAFE, day: false }), false, 'flag on: night -> defer')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall gearup (#60) tests passed')
process.exit(failures ? 1 : 0)
