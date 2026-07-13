'use strict'
// OFFLINE unit test for the pure mining-strategy logic (bot/mining.js). No bot, no I/O.
// Run:  cd bot && node miningtest.js

const assert = require('assert')
const M = require('./mining.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('targetMineY: reaches the iron band (~y16) from a normal surface, not the old y30', () => {
  assert.strictEqual(M.targetMineY(70), 16, 'default target is the iron-rich ~y16')
  assert.notStrictEqual(M.targetMineY(70), 30, 'no longer the sparse-tail y30')
})

t('targetMineY: honors the hard safety floor and never targets above start', () => {
  assert.strictEqual(M.targetMineY(70, { hardFloor: 5 }), 16)
  assert.strictEqual(M.targetMineY(12), 9, 'a low surface clamps to surface-3 (still descends)')
  assert.strictEqual(M.targetMineY(6), 5, 'never below the hard floor')
  assert.strictEqual(M.targetMineY(70, { targetY: 0, hardFloor: 5 }), 5, 'a deeper target still stops at the hard floor')
  assert.strictEqual(M.targetMineY(200, { targetY: 16 }), 16)
})

t('worthMiningHere: mine at a good-enough depth instead of all-or-nothing (the live gap)', () => {
  // reached y28 but couldn't get to y16 through a cave -> y28 is a fine iron depth, MINE here
  assert.strictEqual(M.worthMiningHere(28), true, 'y28 is worth branch-mining (was returning 0 before)')
  assert.strictEqual(M.worthMiningHere(40), true, 'y40 = the default good-enough threshold')
  assert.strictEqual(M.worthMiningHere(16), true, 'the ideal depth is of course fine')
  // barely descended -> still too shallow, keep trying to get deeper
  assert.strictEqual(M.worthMiningHere(60), false, 'y60 is too shallow - relocate/retry')
  assert.strictEqual(M.worthMiningHere(41), false, 'just above the threshold -> not yet')
  assert.strictEqual(M.worthMiningHere(50, { minIronY: 55 }), true, 'threshold is env-tunable')
})

t('descentSafety: lava at OR under the landing -> never dig', () => {
  assert.strictEqual(M.descentSafety('lava', 'stone'), 'lava')
  assert.strictEqual(M.descentSafety('stone', 'lava'), 'lava', 'lava one below the landing still stops us')
  assert.strictEqual(M.descentSafety('deepslate', 'deepslate'), 'ok')
})

t('descentSafety: water and void are handled distinctly', () => {
  assert.strictEqual(M.descentSafety('water', 'stone'), 'water')
  assert.strictEqual(M.descentSafety('seagrass', 'stone'), 'water', 'aquifer plants count as water')
  assert.strictEqual(M.descentSafety('air', 'stone'), 'void', 'no floor to land on')
  assert.strictEqual(M.descentSafety('stone', 'cave_air'), 'void', 'cave immediately beneath -> stop')
  assert.strictEqual(M.descentSafety(null, 'stone'), 'void')
})

t('faceHazard: fluids ahead stop a tunnel; a floor gap is a void', () => {
  assert.strictEqual(M.faceHazard('lava', 'stone', 'stone'), 'lava')
  assert.strictEqual(M.faceHazard('stone', 'water', 'stone'), 'water')
  assert.strictEqual(M.faceHazard('stone', 'stone', 'air'), 'void')
  assert.strictEqual(M.faceHazard('deepslate', 'deepslate', 'deepslate'), 'ok')
})

t('perpendicular: branches are 90 degrees off the corridor', () => {
  assert.deepStrictEqual(M.perpendicular(0), [1, 3], 'E corridor -> S,N branches')
  assert.deepStrictEqual(M.perpendicular(1), [2, 0], 'S corridor -> W,E branches')
  // left and right are opposite each other and both perpendicular to the corridor
  for (let c = 0; c < 4; c++) {
    const [l, r] = M.perpendicular(c)
    assert.strictEqual((l + 2) % 4, r, 'left and right are opposite')
    assert.notStrictEqual(l % 2, c % 2, 'branch axis differs from corridor axis (perpendicular)')
  }
})

t('branchLayout: resolves directions + sane classic-branch-mine defaults', () => {
  const L = M.branchLayout(0)
  assert.strictEqual(L.corridorIdx, 0)
  assert.deepStrictEqual([L.leftIdx, L.rightIdx], [1, 3])
  assert(L.spacing >= 2 && L.spacing <= 3, 'classic 2-3 block spacing')
  assert(L.branchLen >= 8, 'branches reach materially further than a single face')
  const L2 = M.branchLayout(2, { spacing: 2, branchLen: 16 })
  assert.strictEqual(L2.spacing, 2); assert.strictEqual(L2.branchLen, 16)
})

t('pickUsesLeft: durability accounting per material', () => {
  assert.strictEqual(M.pickMaxUses('stone_pickaxe'), 131)
  assert.strictEqual(M.pickMaxUses('iron_pickaxe'), 250)
  assert.strictEqual(M.pickMaxUses('not_a_pick'), 0)
  assert.strictEqual(M.pickUsesLeft('stone_pickaxe', 0), 131, 'brand new')
  assert.strictEqual(M.pickUsesLeft('stone_pickaxe', undefined), 131, 'no durabilityUsed = new')
  assert.strictEqual(M.pickUsesLeft('stone_pickaxe', 120), 11, 'nearly worn')
  assert.strictEqual(M.pickUsesLeft('stone_pickaxe', 131), 0, 'spent')
  assert.strictEqual(M.pickUsesLeft('stone_pickaxe', 200), 0, 'never negative')
})

t('estExcursionBlocks + picksToCraft: provision enough picks up front', () => {
  const est = M.estExcursionBlocks(48, { branches: 6, branchLen: 12, spacing: 3 }) // 144 + 6*54 = 468
  assert.strictEqual(est, 468)
  // carrying one fresh stone pick (131) for a 468-block estimate -> need more (with a spare margin)
  assert.strictEqual(M.picksToCraft(131, est), Math.ceil((468 + 131 - 131) / 131), 'craft the deficit in stone picks')
  assert.strictEqual(M.picksToCraft(131, est), 4)
  // already have plenty of durability -> craft none
  assert.strictEqual(M.picksToCraft(2000, est), 0)
  assert.strictEqual(M.picksToCraft(0, 50), 2, 'need the excursion pick + a spare even for a tiny dig')
})

t('needReTool: re-tool BEFORE the pick breaks, and only with no spare', () => {
  assert.strictEqual(M.needReTool(10, 0), true, 'low + no spare -> re-tool now (while it can still mine cobble)')
  assert.strictEqual(M.needReTool(10, 1), false, 'a spare pick is available -> no need')
  assert.strictEqual(M.needReTool(80, 0), false, 'plenty of uses left -> not yet')
  assert.strictEqual(M.needReTool(0, 0), true, 'broken + no spare -> definitely')
  assert.strictEqual(M.needReTool(25, 0, { low: 30 }), true, 'threshold is tunable')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall mining-strategy tests passed')
process.exit(failures ? 1 : 0)
