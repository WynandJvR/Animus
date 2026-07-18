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

// ============================================================================================
// #72 DEADLOCK_RESET_SOFT (default on): a broadened trigger for the persistently-degraded-and-not-
// recovering equilibrium (the bot sits at hp~4.8/food~7, functionally deadlocked but never at the
// exact hp<=2/food0 floor). The soft path needs low hp AND low food AND no pack food AND MORE
// consecutive all-rungs-tried cycles (K'=6 > the hard 4). All tests pass soft:true explicitly so
// they are independent of the DEADLOCK_RESET_SOFT env default, plus one env-default check.

// The canonical GENUINE soft deadlock: low-hp/low-food equilibrium, nothing edible, K'>=6 cycles,
// past the cooldown. NOT at the hard hp<=2/food0 floor.
const SOFT = { hp: 5, food: 7, hasPackFood: false, failCount: 6, sinceLastResetMs: 600000 }

t('SOFT: fires on a persistent low-hp/low-food stuck equilibrium (hp5/food7/failCount6/no-pack)', () => {
  assert.strictEqual(due({ ...SOFT }, { soft: true }), true, 'the bootstrap-breaker - a real soft deadlock resets')
  assert.strictEqual(due({ ...SOFT, hp: 6, food: 8 }, { soft: true }), true, 'exactly at the soft thresholds -> fires (boundary)')
  assert.strictEqual(due({ ...SOFT, failCount: 6 }, { soft: true }), true, 'exactly K\'=6 -> fires (boundary)')
})

t('SOFT: does NOT fire with edible pack food (recovering, auto-eat handles it)', () => {
  assert.strictEqual(due({ ...SOFT, hasPackFood: true }, { soft: true }), false, 'pack food -> never suicide')
})

t('SOFT: does NOT fire with hp above the soft floor (hp climbing = recovering)', () => {
  assert.strictEqual(due({ ...SOFT, hp: 7 }, { soft: true }), false, 'hp>6 -> not the soft deadlock')
  assert.strictEqual(due({ ...SOFT, hp: 14 }, { soft: true }), false, 'hp14 (secure-base gate) -> obviously not')
})

t('SOFT: does NOT fire with food above the soft floor (food climbing = recovering)', () => {
  assert.strictEqual(due({ ...SOFT, food: 9 }, { soft: true }), false, 'food>8 -> recovering, not stuck')
  assert.strictEqual(due({ ...SOFT, food: 20 }, { soft: true }), false, 'full food -> obviously not')
})

t('SOFT: needs MORE consecutive fails than the hard trigger (transient dip never resets)', () => {
  assert.strictEqual(due({ ...SOFT, failCount: 5 }, { soft: true }), false, 'K\'-1=5 cycles -> hold, do not reset')
  assert.strictEqual(due({ ...SOFT, failCount: 4 }, { soft: true }), false, 'the hard bar (4) is NOT enough for the soft trigger')
  assert.strictEqual(due({ ...SOFT, failCount: 0 }, { soft: true }), false, 'first cycle -> never')
})

t('SOFT: does NOT fire within the anti-loop cooldown (shared 10-min gap, no suicide loop)', () => {
  assert.strictEqual(due({ ...SOFT, sinceLastResetMs: 0 }, { soft: true }), false, 'just reset -> hard cooldown blocks')
  assert.strictEqual(due({ ...SOFT, sinceLastResetMs: 599999 }, { soft: true }), false, 'one ms short -> still blocked')
})

t('SOFT: flag OFF (DEADLOCK_RESET_SOFT=0) -> only the hard trigger, byte-for-byte', () => {
  assert.strictEqual(due({ ...SOFT }, { soft: false }), false, 'soft off -> the soft equilibrium does NOT reset')
  assert.strictEqual(due({ ...SOFT }, { soft: true }), true, 'soft on -> fires')
  // hard trigger is unaffected by the soft flag either way
  assert.strictEqual(due({ ...DEADLOCK }, { soft: false }), true, 'hard trigger fires with soft off')
  assert.strictEqual(due({ ...DEADLOCK }, { soft: true }), true, 'hard trigger fires with soft on')
})

t('SOFT: DEADLOCK_RESET=0 (whole feature off) hard-disables both triggers', () => {
  assert.strictEqual(due({ ...SOFT }, { soft: true, enabled: false }), false, 'enabled:false wins over the soft path')
})

t('SOFT: opts override the soft thresholds (tunable, env-independent)', () => {
  assert.strictEqual(due({ ...SOFT, hp: 5 }, { soft: true, softHp: 4 }), false, 'softHp=4 -> hp5 no longer qualifies')
  assert.strictEqual(due({ ...SOFT, food: 7 }, { soft: true, softFood: 6 }), false, 'softFood=6 -> food7 no longer qualifies')
  assert.strictEqual(due({ ...SOFT, failCount: 6 }, { soft: true, softFails: 9 }), false, 'softFails=9 -> 6 cycles not enough')
  assert.strictEqual(due({ ...SOFT, failCount: 9 }, { soft: true, softFails: 9 }), true, 'softFails=9 -> 9 cycles fires')
})

t('SOFT: env default is ON (DEADLOCK_RESET_SOFT unset -> the soft trigger is live)', () => {
  // no soft opt -> falls through to the DEADLOCK_RESET_SOFT env default (on unless ==="0")
  const expect = process.env.DEADLOCK_RESET_SOFT !== '0'
  assert.strictEqual(due({ ...SOFT }), expect, 'default-on soft trigger fires with no opt override')
})

t('SOFT: the anti-loop MAX_NOFOOD backoff still bounds it (caller composition)', () => {
  // The caller fires only when `due && resetCount < DEADLOCK_MAX_NOFOOD`; at/after the backoff it
  // LOGS a warning and holds instead of spinning suicides. Same safety as the hard trigger.
  const MAX_NOFOOD = 5
  const soft = due({ ...SOFT }, { soft: true })
  const fire = (resetCount) => soft && resetCount < MAX_NOFOOD
  assert.strictEqual(fire(0), true, 'first reset -> fires')
  assert.strictEqual(fire(4), true, 'still under the backoff -> fires')
  assert.strictEqual(fire(5), false, 'at MAX_NOFOOD resets with no food gained -> back off (hold, no suicide-loop)')
  assert.strictEqual(fire(9), false, 'well past the backoff -> stays held')
})

t('deadlockResetState exports the persisted { at, count } shape', () => {
  const s = P.deadlockResetState()
  assert.ok(s && typeof s === 'object', 'returns an object')
  assert.ok('at' in s && 'count' in s, 'has at + count')
})

if (failures) { console.log('\n' + failures + ' FAILED'); process.exit(1) }
console.log('\nALL PASS')
