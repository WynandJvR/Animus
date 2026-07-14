'use strict'
// OFFLINE unit test for the pure food-security decisions (bot/food.js). No bot, no I/O.
// Run:  cd bot && node foodtest.js

const assert = require('assert')
const F = require('./food.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('hasFoodSupply: a STANDING farm is supplied; else a buffer coasts', () => {
  assert.strictEqual(F.hasFoodSupply(true, 0, 0), true, 'a standing wheat farm = supplied even with 0 buffer')
  assert.strictEqual(F.hasFoodSupply(false, 8, 0), true, 'no farm but a full pack buffer -> coasting')
  assert.strictEqual(F.hasFoodSupply(false, 3, 6), true, 'no farm but pack+bank buffer -> coasting')
  assert.strictEqual(F.hasFoodSupply(false, 2, 0), false, 'no farm + low buffer -> NOT supplied, establish one')
  assert.strictEqual(F.hasFoodSupply(false, 5, 0, { buffer: 4 }), true, 'buffer target is tunable')
})

t('needsFoodSupply: a FED, SAFE bot with no farm + no buffer establishes one (the point)', () => {
  assert.strictEqual(F.needsFoodSupply(18, false, 0, 0, true), true, 'fed + safe + no farm + no buffer -> build the farm now')
  assert.strictEqual(F.needsFoodSupply(18, false, 2, 0, true), true, 'still below the buffer -> build it')
})

t('needsFoodSupply: a standing farm OR a buffer -> nothing to do', () => {
  assert.strictEqual(F.needsFoodSupply(18, true, 0, 0, true), false, 'a standing farm -> supplied, no re-establish churn')
  assert.strictEqual(F.needsFoodSupply(15, false, 3, 6, true), false, 'pack+bank buffer -> coasting, do not scramble')
})

t('needsFoodSupply: NOT while unsafe, NOT during a hunger crisis', () => {
  assert.strictEqual(F.needsFoodSupply(18, false, 0, 0, false), false, 'unsafe -> do not go farming')
  assert.strictEqual(F.needsFoodSupply(4, false, 0, 0, true), false, 'crisis (food<=6) -> reactive secureFood, not proactive')
  assert.strictEqual(F.needsFoodSupply(6, false, 0, 0, true), false, 'at the crisis threshold -> still reactive')
  assert.strictEqual(F.needsFoodSupply(7, false, 0, 0, true), true, 'just above crisis + safe + no supply -> build it')
})

t('shouldSweepForFood: sweep ONLY when no farm, no NEAR animal, no known water', () => {
  assert.strictEqual(F.shouldSweepForFood(false, false, false), true, 'nothing known -> sweep to discover (the whole point)')
  assert.strictEqual(F.shouldSweepForFood(true, false, false), false, 'a standing farm -> no need to sweep')
  assert.strictEqual(F.shouldSweepForFood(false, true, false), false, 'a NEAR animal -> hunt it, do not sweep')
  assert.strictEqual(F.shouldSweepForFood(false, false, true), false, 'a reachable remembered pond -> farm there, do not sweep')
  // the LIVE BUG: a far cow made seesAnimal (unbounded) true -> passing hasNearAnimal=false
  // (distance-bounded) now lets the sweep run
  assert.strictEqual(F.shouldSweepForFood(false, false, false), true)
})

t('foodTier: bad->2, raw meat->1, ready-to-eat (cooked/bread/veg)->0', () => {
  for (const bad of ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish']) assert.strictEqual(F.foodTier(bad), 2, bad + ' is bad (hold-out only)')
  for (const raw of ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon']) assert.strictEqual(F.foodTier(raw), 1, raw + ' is raw cookable')
  for (const ready of ['cooked_beef', 'cooked_cod', 'cooked_mutton', 'bread', 'baked_potato', 'golden_carrot', 'apple']) assert.strictEqual(F.foodTier(ready), 0, ready + ' is ready-to-eat')
  // anchored regexes: cooked_* must NOT be caught by the raw-meat pattern
  assert.strictEqual(F.RAW_COOKABLE_FOOD.test('cooked_beef'), false, 'cooked_beef is not raw')
  assert.strictEqual(F.BAD_FOOD.test('cooked_chicken'), false, 'cooked_chicken is not bad')
})

t('RAW_COOKABLE_FOOD matches provision.RAW_COOKABLE keys (single source of truth)', () => {
  let RAW_COOKABLE
  try { RAW_COOKABLE = require('./provision.js').RAW_COOKABLE } catch (e) { console.log('      (skip: provision.js not loadable offline: ' + e.message + ')'); return }
  for (const name of Object.keys(RAW_COOKABLE)) assert.strictEqual(F.RAW_COOKABLE_FOOD.test(name), true, name + ' (a provision raw-cookable) must be tier 1')
})

t('foodSupplyAction: the discovery->action handoff (the live idle bug)', () => {
  assert.strictEqual(F.foodSupplyAction(true, true, true), 'tend', 'a standing farm -> tend')
  assert.strictEqual(F.foodSupplyAction(false, true, false), 'buildFarm', 'FOUND WATER -> build the farm THERE (was idling)')
  assert.strictEqual(F.foodSupplyAction(false, true, true), 'buildFarm', 'water beats a near animal - farm is renewable')
  assert.strictEqual(F.foodSupplyAction(false, false, true), 'huntNear', 'no water but an animal here -> hunt it')
  assert.strictEqual(F.foodSupplyAction(false, false, false), 'sweep', 'nothing known -> sweep to discover')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall food-security tests passed')
process.exit(failures ? 1 : 0)
