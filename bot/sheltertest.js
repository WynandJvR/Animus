'use strict'
// OFFLINE unit test for the pure shelter-siting logic (bot/shelter.js). No bot, no I/O.
// Run:  cd bot && node sheltertest.js

const assert = require('assert')
const S = require('./shelter.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('shelterDiggable: solid dry ground -> yes', () => {
  assert.strictEqual(S.shelterDiggable('dirt', 'stone', ['dirt', 'dirt', 'dirt', 'dirt']), true)
  assert.strictEqual(S.shelterDiggable('grass_block', 'dirt', ['stone', 'stone', 'stone', 'stone']), true)
})

t('shelterDiggable: the LIVE bug - water beside the shaft -> no (this is what looped)', () => {
  assert.strictEqual(S.shelterDiggable('dirt', 'stone', ['water', 'dirt', 'dirt', 'dirt']), false, 'aquifer beside the next cell floods the pit')
  assert.strictEqual(S.shelterDiggable('dirt', 'stone', ['dirt', 'seagrass', 'dirt', 'dirt']), false, 'waterlogged plant beside counts as water')
})

t('shelterDiggable: fluid at or under the dig -> no', () => {
  assert.strictEqual(S.shelterDiggable('water', 'dirt', []), false, 'digging into water')
  assert.strictEqual(S.shelterDiggable('lava', 'stone', []), false, 'digging into lava')
  assert.strictEqual(S.shelterDiggable('dirt', 'water', []), false, 'water one deeper floods')
  assert.strictEqual(S.shelterDiggable('dirt', 'lava', []), false, 'lava one deeper')
})

t('shelterDiggable: nothing to dig / undiggable -> no', () => {
  assert.strictEqual(S.shelterDiggable('air', 'dirt', []), false, 'already a hole')
  assert.strictEqual(S.shelterDiggable(null, 'dirt', []), false, 'unloaded/air')
  assert.strictEqual(S.shelterDiggable('bedrock', 'bedrock', []), false)
  assert.strictEqual(S.shelterDiggable('obsidian', 'stone', []), false)
})

t('feetCellDry: standable + dry vs water-adjacent', () => {
  assert.strictEqual(S.feetCellDry('air', 'air', ['dirt', 'dirt', 'dirt', 'dirt']), true)
  assert.strictEqual(S.feetCellDry('air', 'air', ['water', 'dirt', 'dirt', 'dirt']), false, 'water beside the standing cell -> not dry')
  assert.strictEqual(S.feetCellDry('water', 'air', []), false, 'standing in water')
  assert.strictEqual(S.feetCellDry('air', 'stone', []), false, 'no head clearance')
  assert.strictEqual(S.feetCellDry('dirt', 'air', []), false, 'feet blocked')
})

t('rankByDistance: nearest safe cell first (shortest relocate)', () => {
  const cells = [{ x: 10, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }]
  const ranked = S.rankByDistance(cells, { x: 0, z: 0 })
  assert.deepStrictEqual(ranked.map(c => c.x), [2, 5, 10])
  // pure - does not mutate the input
  assert.strictEqual(cells[0].x, 10)
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall shelter-siting tests passed')
process.exit(failures ? 1 : 0)
