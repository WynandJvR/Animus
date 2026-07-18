'use strict'
// OFFLINE unit test for the PURE deadlock suicide-reset detector (#58 DEADLOCK_RESET,
// provision.deadlockResetDue). No bot, no I/O. Run:  cd bot && node deadlocktest.js
//
// The detector fires the last-resort stash-then-die reset ONLY on a GENUINE multi-cycle
// hp<=2/food0 deadlock (no reachable food) once the anti-loop cooldown has elapsed - and
// NEVER on a normal recoverable crisis. Every input is passed in so the trigger is fully
// testable without a live bot.

const assert = require('assert')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

let P
try { P = require('./provision.js') } catch (e) { console.log('FAIL  provision.js not loadable offline: ' + e.message); process.exit(1) }
const due = P.deadlockResetDue

// The canonical GENUINE deadlock: hp at the floor, food empty, nothing edible in the pack,
// K consecutive all-rungs-tried cycles, and well past the 10-min cooldown.
const DEADLOCK = { hp: 2, food: 0, hasPackFood: false, failCount: 4, sinceLastResetMs: 600000 }

t('FIRES on a genuine multi-cycle hp<=2/food0 deadlock past the cooldown', () => {
  assert.strictEqual(due({ ...DEADLOCK }), true, 'the whole point - a real deadlock resets')
  assert.strictEqual(due({ ...DEADLOCK, hp: 1, failCount: 9, sinceLastResetMs: 5000000 }), true, 'hp1, deeper past cooldown -> still fires')
  assert.strictEqual(due({ ...DEADLOCK, sinceLastResetMs: 600001 }), true, 'just past the cooldown -> fires')
})

t('does NOT fire with edible food on hand (auto-eat handles it, not a deadlock)', () => {
  assert.strictEqual(due({ ...DEADLOCK, hasPackFood: true }), false, 'pack food -> never suicide')
})

t('does NOT fire with hp above the floor (a recoverable crisis, regen not dead)', () => {
  assert.strictEqual(due({ ...DEADLOCK, hp: 3 }), false, 'hp>2 -> not the deadlock')
  assert.strictEqual(due({ ...DEADLOCK, hp: 20 }), false, 'full hp -> obviously not')
})

t('does NOT fire while food>0 (still draining, not floored)', () => {
  assert.strictEqual(due({ ...DEADLOCK, food: 1 }), false, 'food 1 -> not yet the food0 floor')
  assert.strictEqual(due({ ...DEADLOCK, food: 6 }), false, 'moderate hunger -> reactive secureFood, not suicide')
})

t('does NOT fire below the fail threshold (a single/brief stall is not a deadlock)', () => {
  assert.strictEqual(due({ ...DEADLOCK, failCount: 3 }), false, 'K-1 cycles -> hold, do not reset')
  assert.strictEqual(due({ ...DEADLOCK, failCount: 0 }), false, 'first cycle -> never')
  assert.strictEqual(due({ ...DEADLOCK, failCount: 4 }), true, 'exactly K -> fires (boundary)')
})

t('does NOT fire within the anti-loop cooldown (no suicide loop)', () => {
  assert.strictEqual(due({ ...DEADLOCK, sinceLastResetMs: 0 }), false, 'just reset -> hard cooldown blocks')
  assert.strictEqual(due({ ...DEADLOCK, sinceLastResetMs: 599999 }), false, 'one ms short of the cooldown -> still blocked')
})

t('does NOT fire when the flag is OFF (DEADLOCK_RESET=0 -> today hold-and-starve)', () => {
  assert.strictEqual(due({ ...DEADLOCK }, { enabled: false }), false, 'flag off hard-disables the reset')
  assert.strictEqual(due({ ...DEADLOCK }, { enabled: true }), true, 'flag on -> fires')
})

t('opts override the thresholds (tunable, and the tests stay independent of env defaults)', () => {
  // a stricter hp floor: hp2 no longer qualifies when HP set to 1
  assert.strictEqual(due({ ...DEADLOCK, hp: 2 }, { hp: 1 }), false, 'DEADLOCK_HP=1 -> hp2 does not fire')
  assert.strictEqual(due({ ...DEADLOCK, hp: 1 }, { hp: 1 }), true, 'DEADLOCK_HP=1 -> hp1 fires')
  // a higher fail bar
  assert.strictEqual(due({ ...DEADLOCK, failCount: 4 }, { fails: 8 }), false, 'DEADLOCK_FAILS=8 -> 4 cycles not enough')
  assert.strictEqual(due({ ...DEADLOCK, failCount: 8 }, { fails: 8 }), true, 'DEADLOCK_FAILS=8 -> 8 cycles fires')
  // a longer cooldown
  assert.strictEqual(due({ ...DEADLOCK, sinceLastResetMs: 600000 }, { cooldownMs: 1200000 }), false, 'longer cooldown not yet elapsed')
  assert.strictEqual(due({ ...DEADLOCK, sinceLastResetMs: 1200000 }, { cooldownMs: 1200000 }), true, 'longer cooldown elapsed -> fires')
})

t('ALL guards together: a normal recoverable crisis never trips it', () => {
  // fed + climbing hp + healthy fail count + fresh reset: every guard says no
  assert.strictEqual(due({ hp: 8, food: 12, hasPackFood: true, failCount: 0, sinceLastResetMs: 0 }), false)
  // deep starvation but a food buffer just arrived -> not a deadlock
  assert.strictEqual(due({ hp: 2, food: 0, hasPackFood: true, failCount: 20, sinceLastResetMs: 9e9 }), false)
})

t('deadlockResetState exports the persisted { at, count } shape', () => {
  const s = P.deadlockResetState()
  assert.ok(s && typeof s === 'object', 'returns an object')
  assert.ok('at' in s && 'count' in s, 'has at + count')
})

if (failures) { console.log('\n' + failures + ' FAILED'); process.exit(1) }
console.log('\nALL PASS')
