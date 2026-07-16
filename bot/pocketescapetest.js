'use strict'
// OFFLINE unit test for the PURE pocket-breach geometry (bot/pocket-escape.js) - no bot, no
// fs, no pathfinder. Fixtures are little block-name grids fed to planPocketBreach via a
// lookup `read`; `diggable` is injected per case. Proves: horizontal-first breach to a
// standable bank, step-up (dy+1) allowed / step-down excluded, fluid+unknown corridor cells
// reject the direction (never connect the pocket to a lake/lava), the vertical fallback +
// its aquifer rule (never dig up into water), the anti-grief predicate short-circuits any
// geometry, the maxDigs/march bounds, and the zero-dig degenerate.
// Run:  cd bot && node pocketescapetest.js

const assert = require('assert')
const pe = require('./pocket-escape.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

// Build a `read(dx,dy,dz)` over an explicit cell map; `def` fills the rest (a value, null,
// or a function(dx,dy,dz)).
function grid (cells, def) {
  const map = new Map()
  for (const k in cells) map.set(k, cells[k])
  return (dx, dy, dz) => {
    const k = dx + ',' + dy + ',' + dz
    if (map.has(k)) return map.get(k)
    return typeof def === 'function' ? def(dx, dy, dz) : def
  }
}
const allow = (re) => (name) => re.test(name)   // diggable predicate: name matches -> diggable

// 1) LIVE-GEOMETRY REPLICA: 1x1 water column boxed by oak logs with a log ceiling; a dirt
//    bank with clear body/head sits 2 cells east behind the logs. Expect a horizontal plan
//    east, digging exactly the two east log cells, emerging at dy0.
t('horizontal: live water-pocket replica breaches east to the dirt bank (2 log digs)', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air', '0,2,0': 'oak_log', // feet water, head air, log ceiling
    '1,0,0': 'oak_log', '1,1,0': 'oak_log', '1,2,0': 'oak_log', // east log wall
    '2,0,0': 'air', '2,1,0': 'air', '2,-1,0': 'dirt' // dirt bank, clear body+head, 2 east
  }, (dx, dy, dz) => dy <= -1 ? 'water' : 'oak_log') // pocket water under the walls, logs elsewhere
  const plan = pe.planPocketBreach(read, allow(/oak_log|dirt|_leaves$/), { march: 3, maxDigs: 6 })
  assert(plan, 'a plan exists')
  assert.strictEqual(plan.kind, 'horizontal')
  assert.strictEqual(plan.digs.length, 2, 'exactly the two east log cells')
  assert.deepStrictEqual(plan.exit, { dx: 2, dy: 0, dz: 0 }, 'emerges at the bank, dy0')
})

// 2) Bank one step UP (dy+1) is reachable; bank one step DOWN is NOT (down-exits excluded).
t('horizontal: a bank one step UP gives a dy+1 exit', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air',
    '1,1,0': 'air', '1,2,0': 'air', '1,0,0': 'dirt' // step up: stand on dirt at dy0, clear body/head above
  }, null) // everything else unknown -> only the carved up-path can be an exit
  const plan = pe.planPocketBreach(read, allow(/oak_log|_leaves$/), { march: 3, maxDigs: 6 })
  assert(plan, 'a step-up plan exists')
  assert.strictEqual(plan.kind, 'horizontal')
  assert.strictEqual(plan.exit.dy, 1, 'exit one step up')
})
t('horizontal: a bank one step DOWN is not found (down excluded by design)', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air',
    '1,0,0': 'air', '1,1,0': 'air', '1,-1,0': 'air', '1,-2,0': 'dirt' // open east, ground drops one block
  }, null)
  const plan = pe.planPocketBreach(read, allow(/oak_log|dirt|_leaves$/), { march: 3, maxDigs: 6 })
  assert.strictEqual(plan, null, 'no step-down exit')
})

// 3) A water cell in the corridor (a lake behind the wall) rejects that direction; with no
//    other exit -> null. This is the rule that stops the rung connecting the pocket to a lake.
t('horizontal: water in the corridor rejects the direction -> null', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air',
    '1,0,0': 'oak_log', '1,1,0': 'oak_log', '1,-1,0': 'water',
    '2,0,0': 'water' // lake beyond the wall
  }, null)
  const plan = pe.planPocketBreach(read, allow(/oak_log|_leaves$/), { march: 3, maxDigs: 6 })
  assert.strictEqual(plan, null, 'lake corridor -> no plan')
})

// 4) Lava beyond the wall -> rejected (same fluid rule as water).
t('horizontal: lava in the corridor rejects the direction -> null', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air',
    '1,0,0': 'oak_log', '1,1,0': 'oak_log', '1,-1,0': 'water',
    '2,0,0': 'lava'
  }, null)
  const plan = pe.planPocketBreach(read, allow(/oak_log|_leaves$/), { march: 3, maxDigs: 6 })
  assert.strictEqual(plan, null, 'lava corridor -> no plan')
})

// 5) An UNKNOWN (null) cell in the corridor rejects the direction (would otherwise be a
//    valid bank one cell further) -> null. null is always treated as unsafe.
t('horizontal: an unknown cell in the corridor rejects the direction -> null', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air',
    '1,0,0': 'oak_log', '1,1,0': 'oak_log', '1,-1,0': 'water',
    '2,0,0': null, '2,1,0': 'air', '2,-1,0': 'dirt' // bank behind an UNLOADED cell
  }, null)
  const plan = pe.planPocketBreach(read, allow(/oak_log|dirt|_leaves$/), { march: 3, maxDigs: 6 })
  assert.strictEqual(plan, null, 'unknown corridor cell -> no plan')
})

// 6) VERTICAL fallback: a solid dirt block overhead with air above it -> a 1-dig vertical
//    plan. But WATER above the overhead block -> null (the aquifer rule, the regression guard
//    for "never dig up into water").
t('vertical: solid overhead + air above -> 1-dig plan', () => {
  const read = grid({ '0,0,0': 'water', '0,1,0': 'air', '0,2,0': 'dirt', '0,3,0': 'air' }, null)
  const plan = pe.planPocketBreach(read, allow(/dirt/), { march: 3, maxDigs: 6 })
  assert(plan, 'a vertical plan exists')
  assert.strictEqual(plan.kind, 'vertical')
  assert.strictEqual(plan.digs.length, 1)
})
t('vertical: WATER above the overhead block -> null (aquifer rule)', () => {
  const read = grid({ '0,0,0': 'water', '0,1,0': 'air', '0,2,0': 'dirt', '0,3,0': 'water' }, null)
  const plan = pe.planPocketBreach(read, allow(/dirt/), { march: 3, maxDigs: 6 })
  assert.strictEqual(plan, null, 'never dig up into water')
})

// 7) The anti-grief predicate short-circuits any geometry: a solvable bank walled off by
//    player planks (diggable=false for planks) -> null regardless.
t('anti-grief: a non-diggable (planks) wall gives null regardless of geometry', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air',
    '1,0,0': 'oak_planks', '1,1,0': 'oak_planks', '1,-1,0': 'water',
    '2,0,0': 'air', '2,1,0': 'air', '2,-1,0': 'dirt'
  }, null)
  const plan = pe.planPocketBreach(read, allow(/oak_log|dirt/), { march: 3, maxDigs: 6 }) // planks NOT allowed
  assert.strictEqual(plan, null, 'player build box is never breached')
})

// 8) A 7-dig exit at r=4: NOT found at the default march3/maxDigs6, FOUND with the desperate
//    march4/maxDigs8. (Floors along r1..r3 are water so the march does not stop early.)
t('bounds: a 7-dig exit is null at default, found when desperate (march4/maxDigs8)', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air',
    '1,0,0': 'oak_log', '1,1,0': 'oak_log', '1,-1,0': 'water',
    '2,0,0': 'oak_log', '2,1,0': 'oak_log', '2,-1,0': 'water',
    '3,0,0': 'oak_log', '3,1,0': 'air', '3,-1,0': 'water', // one cell already open -> 1 dig here
    '4,0,0': 'oak_log', '4,1,0': 'oak_log', '4,-1,0': 'dirt' // standable bank -> exit
  }, null)
  const dig = allow(/oak_log/)
  assert.strictEqual(pe.planPocketBreach(read, dig, { march: 3, maxDigs: 6 }), null, 'out of reach at default')
  const plan = pe.planPocketBreach(read, dig, { march: 4, maxDigs: 8 })
  assert(plan, 'reachable when desperate')
  assert.strictEqual(plan.kind, 'horizontal')
  assert.strictEqual(plan.digs.length, 7, 'exactly 7 digs')
  assert.deepStrictEqual(plan.exit, { dx: 4, dy: 0, dz: 0 })
})

// 9) ZERO-DIG: an already-open corridor to a bank -> a plan with digs:[] (the rung then just
//    hops out - a harmless overlap with the water rung).
t('degenerate: an already-open corridor to a bank -> digs:[]', () => {
  const read = grid({
    '0,0,0': 'water', '0,1,0': 'air',
    '1,0,0': 'air', '1,1,0': 'air', '1,-1,0': 'water', // open lane over water (not standable)
    '2,0,0': 'air', '2,1,0': 'air', '2,-1,0': 'dirt' // standable bank
  }, null)
  const plan = pe.planPocketBreach(read, allow(/oak_log|dirt/), { march: 3, maxDigs: 6 })
  assert(plan, 'a plan exists')
  assert.strictEqual(plan.kind, 'horizontal')
  assert.strictEqual(plan.digs.length, 0, 'nothing to dig')
  assert.deepStrictEqual(plan.exit, { dx: 2, dy: 0, dz: 0 })
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall pocket-escape tests passed')
process.exit(failures ? 1 : 0)
