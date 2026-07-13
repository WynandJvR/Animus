'use strict'
// OFFLINE unit test for the pure multi-material restock logic (bot/restock.js). No bot, no I/O.
// Run:  cd bot && node restocktest.js

const assert = require('assert')
const R = require('./restock.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('restockPlan: tops up LOW, banked, still-needed materials most-needed first', () => {
  const bom = { stone: 400, oak_stairs: 120, glass_pane: 20 }
  const pack = { stone: 2, oak_stairs: 0, glass_pane: 5 }
  const bank = { stone: 400, oak_stairs: 128, glass_pane: 40 }
  const plan = R.restockPlan(bom, pack, bank, { perItem: 64, lowAt: 16 })
  const items = plan.map(p => p.item)
  assert.deepStrictEqual(items, ['stone', 'oak_stairs', 'glass_pane'], 'most-needed (by BOM) first')
  const stone = plan.find(p => p.item === 'stone')
  assert.strictEqual(stone.count, 62, 'stone: min(64,400)=64 target - 2 have = 62')
  const stairs = plan.find(p => p.item === 'oak_stairs')
  assert.strictEqual(stairs.count, 64, 'stairs: min(64,120)=64 - 0 have')
  const pane = plan.find(p => p.item === 'glass_pane')
  assert.strictEqual(pane.count, 15, 'panes: min(64,20)=20 target - 5 have = 15')
})

t('restockPlan: skips materials already stocked, not banked, or not needed', () => {
  const bom = { stone: 100, oak_stairs: 40, dirt: 0 }
  const pack = { stone: 50, oak_stairs: 0 } // stone already >= lowAt
  const bank = { stone: 100, oak_stairs: 0, dirt: 64 } // stairs not banked; dirt not needed
  const plan = R.restockPlan(bom, pack, bank, { perItem: 64, lowAt: 16 })
  assert.deepStrictEqual(plan.map(p => p.item), [], 'nothing to restock (stone stocked, stairs not banked, dirt not needed)')
})

t('restockPlan: never pulls more than the build still needs', () => {
  const bom = { oak_stairs: 5 } // only 5 left to place
  const pack = {}
  const bank = { oak_stairs: 128 }
  const plan = R.restockPlan(bom, pack, bank, { perItem: 64, lowAt: 16 })
  assert.strictEqual(plan[0].count, 5, 'pulls only the 5 still needed, not a full 64 stack')
})

t('restockPlan: caps the number of TYPES per visit (bounded bank session)', () => {
  const bom = {}; const pack = {}; const bank = {}
  for (let i = 0; i < 20; i++) { bom['m' + i] = 100; bank['m' + i] = 100 }
  const plan = R.restockPlan(bom, pack, bank, { maxItems: 8 })
  assert.strictEqual(plan.length, 8, 'at most maxItems types in one restock')
})

t('restockPlan: clamps to what the bank actually holds', () => {
  const bom = { stone: 200 }
  const pack = {}
  const bank = { stone: 30 } // needs a lot, bank only has 30
  const plan = R.restockPlan(bom, pack, bank, { perItem: 64, lowAt: 16 })
  assert.strictEqual(plan[0].count, 30, 'withdraw only the 30 that exist')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall restock tests passed')
process.exit(failures ? 1 : 0)
