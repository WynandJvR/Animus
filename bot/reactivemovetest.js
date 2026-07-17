'use strict'
// OFFLINE unit test for the PURE decision surface of the Phase A reactive-move primitive
// (bot/navigate.js: reactiveTarget + reactiveDone). No bot, no pathfinder, no world - the DRIVE
// loop is I/O and is proven on the live bot; these two functions are the only extractable pure
// seam (DESIGN-nav-overhaul §3 Phase A test plan). They decide WHERE to steer (away-vector /
// toward-cap) and WHEN the move is done (netted the clearance / arrived / keep driving).
// Run:  cd bot && node reactivemovetest.js

const assert = require('assert')
const nav = require('./navigate.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

// ---- sanity: the pure functions are exported ----------------------------------------------
t('navigate exports reactiveTarget + reactiveDone + reactiveMove', () => {
  assert(typeof nav.reactiveTarget === 'function', 'reactiveTarget exported')
  assert(typeof nav.reactiveDone === 'function', 'reactiveDone exported')
  assert(typeof nav.reactiveMove === 'function', 'reactiveMove exported')
})

// ---- reactiveTarget: awayFrom = a point `reach` blocks along the horizontal away-vector -----
t('awayFrom (threat due EAST) steers WEST, exactly `reach` blocks, Y held', () => {
  const pos = { x: 100, y: 64, z: 100 }
  const tgt = nav.reactiveTarget(pos, { awayFrom: { x: 105, y: 64, z: 100 }, reach: 8 })
  assert(tgt.x < pos.x, 'target is west of us (' + tgt.x + ')')
  assert(near(tgt.z, 100), 'z unchanged for a due-east threat')
  assert(near(tgt.y, 64), 'y is held at pos.y (ground move)')
  assert(near(Math.hypot(tgt.x - pos.x, tgt.z - pos.z), 8), 'horizontal netted-target distance == reach')
})

t('awayFrom (threat NE) steers SW, magnitude == reach', () => {
  const pos = { x: 0, y: 70, z: 0 }
  const tgt = nav.reactiveTarget(pos, { awayFrom: { x: 10, y: 70, z: 10 }, reach: 20 })
  assert(tgt.x < 0 && tgt.z < 0, 'target is south-west of us')
  assert(near(Math.hypot(tgt.x, tgt.z), 20, 1e-9), 'target is exactly `reach` (20b) from us')
  assert(near(tgt.x, tgt.z), 'symmetric NE threat -> symmetric SW retreat')
})

t('awayFrom ignores the threat Y (a flee is a ground move) - horizontal norm only', () => {
  const pos = { x: 0, y: 64, z: 0 }
  // threat far ABOVE but only 3b horizontally east -> still a full-reach WEST step, y held
  const tgt = nav.reactiveTarget(pos, { awayFrom: { x: 3, y: 200, z: 0 }, reach: 12 })
  assert(near(tgt.x, -12), 'full 12b west regardless of vertical separation')
  assert(near(tgt.y, 64), 'y held')
})

t('awayFrom with a coincident threat XZ does not divide-by-zero (norm floored to 1)', () => {
  const pos = { x: 5, y: 64, z: 5 }
  const tgt = nav.reactiveTarget(pos, { awayFrom: { x: 5, y: 64, z: 5 }, reach: 8 })
  assert(Number.isFinite(tgt.x) && Number.isFinite(tgt.z), 'finite target, no NaN/Infinity')
})

// ---- reactiveTarget: toward = the goal itself within reach, else a reach-capped step --------
t('toward WITHIN reach returns the goal itself (incl. its Y)', () => {
  const pos = { x: 0, y: 64, z: 0 }
  const goal = { x: 3, y: 67, z: 4 } // 5b away, reach 8
  const tgt = nav.reactiveTarget(pos, { toward: goal, reach: 8 })
  assert(near(tgt.x, 3) && near(tgt.z, 4), 'returns the goal XZ verbatim')
  assert(near(tgt.y, 67), 'carries the goal Y through when in range')
})

t('toward BEYOND reach returns a reach-capped step along the bearing', () => {
  const pos = { x: 0, y: 64, z: 0 }
  const goal = { x: 30, y: 64, z: 0 } // 30b due east, reach 10
  const tgt = nav.reactiveTarget(pos, { toward: goal, reach: 10 })
  assert(near(tgt.x, 10), 'stepped exactly 10b toward the goal')
  assert(near(tgt.z, 0), 'on-bearing (no z drift)')
  assert(near(Math.hypot(tgt.x - pos.x, tgt.z - pos.z), 10), 'step magnitude == reach')
})

// ---- reactiveDone: retreat completes on clearance, approach on arrival, else keep driving ---
t('reactiveDone(awayFrom): short of minClearB => null (keep driving)', () => {
  assert.strictEqual(nav.reactiveDone(7.9, 0, { awayFrom: {}, minClearB: 8 }), null)
})
t('reactiveDone(awayFrom): >= minClearB => "cleared"', () => {
  assert.strictEqual(nav.reactiveDone(8, 0, { awayFrom: {}, minClearB: 8 }), 'cleared')
  assert.strictEqual(nav.reactiveDone(21, 0, { awayFrom: {}, minClearB: 20 }), 'cleared')
})
t('reactiveDone(toward): outside arriveB => null; within => "arrived"', () => {
  assert.strictEqual(nav.reactiveDone(0, 2.0, { arriveB: 1.5 }), null)
  assert.strictEqual(nav.reactiveDone(0, 1.5, { arriveB: 1.5 }), 'arrived')
  assert.strictEqual(nav.reactiveDone(0, 0.3, { arriveB: 0.4 }), 'arrived')
})
t('reactiveDone: awayFrom clearance is measured on NET move, not distance-to-goal', () => {
  // a retreat has no goal distance; only netMoved decides
  assert.strictEqual(nav.reactiveDone(25, 999, { awayFrom: {}, minClearB: 20 }), 'cleared')
})

console.log(failures ? ('\n' + failures + ' FAILED') : '\nALL PASS')
process.exit(failures ? 1 : 0)
