'use strict'
// OFFLINE unit test for the pure oriented-block logic (bot/orient.js). No bot, no I/O.
// Run:  cd bot && node orienttest.js

const assert = require('assert')
const O = require('./orient.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('facingVec: the 6 facings map to unit vectors', () => {
  assert.deepStrictEqual(O.facingVec('east'), [1, 0, 0])
  assert.deepStrictEqual(O.facingVec('north'), [0, 0, -1])
  assert.deepStrictEqual(O.facingVec('up'), [0, 1, 0])
  assert.strictEqual(O.facingVec('bogus'), null)
})

t('resolveOrientation: STAIRS facing (the common castle detail, incl. newer wood)', () => {
  // a cherry_stairs blockstate the lib\'s facingData lacks - still resolvable from the string
  const o = O.resolveOrientation({ facing: 'west', half: 'bottom', shape: 'straight' })
  assert.strictEqual(o.kind, 'facing')
  assert.deepStrictEqual(o.facing, [-1, 0, 0])
  assert.strictEqual(o.is3D, false, 'stairs face horizontally')
  assert.strictEqual(o.top, false)
})

t('resolveOrientation: TOP-half stairs / top slab', () => {
  assert.strictEqual(O.resolveOrientation({ facing: 'east', half: 'top' }).top, true)
  const slab = O.resolveOrientation({ type: 'top' })
  assert.strictEqual(slab.kind, 'half'); assert.strictEqual(slab.top, true)
  assert.strictEqual(O.resolveOrientation({ type: 'bottom' }), null, 'a bottom slab is a normal place (no directive)')
})

t('resolveOrientation: LOG axis (upright vs laid)', () => {
  assert.strictEqual(O.resolveOrientation({ axis: 'y' }).kind, 'axis')
  assert.deepStrictEqual(O.resolveOrientation({ axis: 'x' }).facing, [1, 0, 0])
  assert.strictEqual(O.resolveOrientation({ axis: 'x' }).is3D, true, 'a horizontal log axis is 3D')
  assert.strictEqual(O.resolveOrientation({ axis: 'y' }).is3D, false, 'upright is the default')
})

t('resolveOrientation: DOOR facing (hinge handled by the 2-block door placement)', () => {
  const o = O.resolveOrientation({ facing: 'south', half: 'lower', hinge: 'left' })
  assert.deepStrictEqual(o.facing, [0, 0, 1])
  assert.strictEqual(o.is3D, false)
})

t('resolveOrientation: a full cube (no orientation props) -> null', () => {
  assert.strictEqual(O.resolveOrientation({}), null)
  assert.strictEqual(O.resolveOrientation({ waterlogged: 'false' }), null)
})

t('axisOfVec: face vectors -> their axis (Vec3-like or arrays)', () => {
  assert.strictEqual(O.axisOfVec({ x: 1, y: 0, z: 0 }), 'x')
  assert.strictEqual(O.axisOfVec({ x: 0, y: -1, z: 0 }), 'y')
  assert.strictEqual(O.axisOfVec([0, 0, 1]), 'z')
  assert.strictEqual(O.axisOfVec({ x: 1, y: 1, z: 0 }), null, 'diagonal is not a unit axis')
})

t('facesForAxis: LOG axis restricts the clickable faces to that axis', () => {
  const all = [{ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }]
  // axis=x -> only the east/west faces (so the log lays along x)
  const xFaces = O.facesForAxis(all, 'x')
  assert.strictEqual(xFaces.length, 2)
  assert(xFaces.every(f => O.axisOfVec(f) === 'x'))
  // axis=y -> only up/down (upright)
  assert.deepStrictEqual(O.facesForAxis(all, 'y').map(f => O.axisOfVec(f)), ['y', 'y'])
})

t('facesForAxis: no matching-axis face reachable -> keep all (place now, orient later)', () => {
  const onlyY = [{ x: 0, y: 1, z: 0 }]
  assert.deepStrictEqual(O.facesForAxis(onlyY, 'x'), onlyY, 'falls back to what is reachable rather than stalling')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall orientation tests passed')
process.exit(failures ? 1 : 0)
