'use strict'
// Contract tests for collision-margin.js: the hitbox never rests exactly on a block face.
// Run:  cd bot && node collisionmargintest.js
const assert = require('assert')
const AABB = require('prismarine-physics/lib/aabb')
const cm = require('./collision-margin.js')
let passed = 0
function t (name, fn) { fn(); passed++; console.log('  ok  ' + name) }
const M = cm.COLLISION_MARGIN
const block = () => new AABB(0, 0, 0, 1, 1, 1)
const r = cm.install()
t('installs on the AABB prototype prismarine-physics uses; idempotent', () => {
  assert.strictEqual(r.installed, true); assert.strictEqual(cm.install().already, true)
})
t('moving -x into a block face lands MARGIN short of it, never on it', () => {
  const me = new AABB(1.5, 0, 0.2, 2.1, 1.8, 0.8) // 0.6 wide player right of the block
  const dx = block().computeOffsetX(me, -0.8)
  assert.ok(Math.abs(dx - (-(0.5 - M))) < 1e-12, 'clipped to ' + dx)
  assert.ok(1.5 + dx > 1, 'strictly outside')
})
t('a rounding-error overlap (2e-16 inside the face) is treated as contact and pushed back out', () => {
  const me = new AABB(0.9999999999999998, 0, 0.2, 1.6, 1.8, 0.8)
  const dx = block().computeOffsetX(me, -0.3)
  assert.ok(dx > 0 && dx < 2 * M, 'pushed out by a hair: ' + dx)
})
t('landing from above stops MARGIN above the top, and stepping down onto it still counts as a clip', () => {
  const me = new AABB(0.2, 1.5, 0.2, 0.8, 3.3, 0.8)
  const dy = block().computeOffsetY(me, -0.9)
  assert.ok(Math.abs(dy - (-(0.5 - M))) < 1e-12, 'clipped to ' + dy)
  assert.ok(dy !== -0.9, 'the fall was clipped (that is what onGround is read from)')
})
t('+z into a face and -y into a ceiling mirror the same rule', () => {
  const me1 = new AABB(0.2, 0, -0.9, 0.8, 1.8, -0.3)
  const dz = block().computeOffsetZ(me1, 0.5)
  assert.ok(Math.abs(dz - (0.3 - M)) < 1e-12, dz)
  const me2 = new AABB(0.2, -2.5, 0.2, 0.8, -0.7, 0.8)
  const dy = block().computeOffsetY(me2, 1.2)
  assert.ok(Math.abs(dy - (0.7 - M)) < 1e-12, dy)
})
t('a move that never reaches the block is untouched; a box beside the block is untouched', () => {
  const me = new AABB(3, 0, 0.2, 3.6, 1.8, 0.8)
  assert.strictEqual(block().computeOffsetX(me, -0.5), -0.5)
  const beside = new AABB(1.5, 0, 2, 2.1, 1.8, 2.6) // not overlapping in z
  assert.strictEqual(block().computeOffsetX(beside, -0.8), -0.8)
})
console.log('collisionmargintest: ' + passed + ' passed')
