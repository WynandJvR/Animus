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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall food-security tests passed')
process.exit(failures ? 1 : 0)
