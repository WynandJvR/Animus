'use strict'
// OFFLINE unit test for the pure placement-order logic (bot/buildorder.js). No bot, no I/O.
// Run:  cd bot && node buildordertest.js

const assert = require('assert')
const B = require('./buildorder.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

const A = (x, y, z) => ({ pos: { x, y, z } })

t('orderPlacements: BOTTOM-UP - all of a lower layer before any higher one', () => {
  const acts = [A(0, 3, 0), A(5, 1, 5), A(0, 2, 0), A(9, 1, 9)]
  const ord = B.orderPlacements(acts, { x: 0, y: 1, z: 0 })
  assert.deepStrictEqual(ord.map(a => a.pos.y), [1, 1, 2, 3], 'y ascending')
})

t('orderPlacements: NEAREST within a layer', () => {
  const acts = [A(10, 1, 0), A(1, 1, 0), A(4, 1, 0)]
  const ord = B.orderPlacements(acts, { x: 0.5, y: 1, z: 0.5 })
  assert.deepStrictEqual(ord.map(a => a.pos.x), [1, 4, 10], 'nearest x first within layer y=1')
})

t('orderPlacements: bottom-up DOMINATES nearest (a far low block beats a near high one)', () => {
  const acts = [A(0, 5, 0), A(20, 1, 20)] // high+near vs low+far
  const ord = B.orderPlacements(acts, { x: 0, y: 5, z: 0 })
  assert.strictEqual(ord[0].pos.y, 1, 'the low (far) block is placed before the high (near) one')
})

t('orderPlacements: does not mutate the input', () => {
  const acts = [A(0, 3, 0), A(0, 1, 0)]
  const before = acts.map(a => a.pos.y)
  B.orderPlacements(acts, { x: 0, y: 0, z: 0 })
  assert.deepStrictEqual(acts.map(a => a.pos.y), before)
})

t('isSelfCell: the bot\'s own feet/head column is a trap - defer it', () => {
  const feet = { x: 5, y: 66, z: 5 }
  assert.strictEqual(B.isSelfCell({ x: 5, y: 66, z: 5 }, feet), true, 'feet cell')
  assert.strictEqual(B.isSelfCell({ x: 5, y: 67, z: 5 }, feet), true, 'head cell')
  assert.strictEqual(B.isSelfCell({ x: 5, y: 65, z: 5 }, feet), false, 'the floor under the feet is fine to place on')
  assert.strictEqual(B.isSelfCell({ x: 6, y: 66, z: 5 }, feet), false, 'a neighbour is fine')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall placement-order tests passed')
process.exit(failures ? 1 : 0)
