'use strict'
// OFFLINE unit test for the pure line-of-sight logic (bot/los.js). No bot, no I/O.
// Run:  cd bot && node lostest.js

const assert = require('assert')
const L = require('./los.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

// a solid set of "x,y,z" cells
const solids = new Set()
const solid = (x, y, z) => solids.add(x + ',' + y + ',' + z)
const isSolid = (x, y, z) => solids.has(x + ',' + y + ',' + z)

t('open air between -> not blocked', () => {
  solids.clear()
  assert.strictEqual(L.lineBlocked({ x: 0.5, y: 1.6, z: 0.5 }, { x: 4.5, y: 1.5, z: 0.5 }, isSolid), false)
})

t('a WALL between the eye and the chest -> blocked (the reach-through-wall case)', () => {
  solids.clear()
  // wall column at x=2 between bot at x=0 and chest at x=4
  for (let y = 0; y <= 3; y++) solid(2, y, 0)
  assert.strictEqual(L.lineBlocked({ x: 0.5, y: 1.6, z: 0.5 }, { x: 4.5, y: 1.5, z: 0.5 }, isSolid), true)
})

t('the target cell itself being solid does NOT count as blocked (it IS the chest)', () => {
  solids.clear()
  solid(4, 1, 0) // the chest cell
  assert.strictEqual(L.lineBlocked({ x: 0.5, y: 1.6, z: 0.5 }, { x: 4.5, y: 1.5, z: 0.5 }, isSolid), false)
})

t('adjacent with clear line -> not blocked', () => {
  solids.clear()
  for (let y = 0; y <= 3; y++) solid(2, y, 0) // wall exists...
  // ...but the bot stands on the SAME side as the chest (x=3, chest x=4) - clear
  assert.strictEqual(L.lineBlocked({ x: 3.5, y: 1.6, z: 0.5 }, { x: 4.5, y: 1.5, z: 0.5 }, isSolid), false)
})

t('faceApproachCells: the horizontal neighbours (+/-1 y) a bot can stand at', () => {
  const cells = L.faceApproachCells({ x: 5, y: 66, z: 5 })
  assert.strictEqual(cells.length, 12) // 4 horizontal x 3 dy
  assert(cells.some(c => c.x === 6 && c.z === 5 && c.y === 66))
  assert(cells.some(c => c.x === 5 && c.z === 4 && c.y === 65)) // step down face
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall line-of-sight tests passed')
process.exit(failures ? 1 : 0)
