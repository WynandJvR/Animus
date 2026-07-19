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

t('digExposureHazard: a fluid in ANY of the 6 neighbours (incl. below) blocks a shallow dig', () => {
  assert.strictEqual(M.digExposureHazard(['stone', 'stone', 'stone', 'stone', 'stone', 'stone']), 'ok', 'dry rock all around -> safe')
  assert.strictEqual(M.digExposureHazard(['stone', 'water', 'stone', 'stone', 'stone', 'stone']), 'water', 'water beside/behind -> opening it floods the hole')
  assert.strictEqual(M.digExposureHazard(['stone', 'stone', 'stone', 'stone', 'stone', 'water']), 'water', 'water BELOW floods the hole too')
  assert.strictEqual(M.digExposureHazard(['stone', 'water', 'lava', 'stone', 'stone', 'stone']), 'lava', 'lava outranks water (never open lava)')
  assert.strictEqual(M.digExposureHazard(['stone', 'seagrass', 'stone', 'stone', 'stone', 'stone']), 'water', 'aquifer plants count as water')
  assert.strictEqual(M.digExposureHazard(['air', 'cave_air', 'stone', null, 'stone', 'stone']), 'ok', 'air/cave/unloaded neighbours are not fluids')
  assert.strictEqual(M.digExposureHazard([]), 'ok', 'no data -> not a hazard')
})

t('climbStepSafety (#41 up-staircase lava gate): compose descentSafety + digExposureHazard over an opened step', () => {
  const dry6 = ['stone', 'stone', 'stone', 'stone', 'stone', 'stone']
  // all-solid, dry rock under the tread AND around the opened cells -> safe to step up
  assert.strictEqual(M.climbStepSafety('stone', 'stone', dry6), 'ok', 'solid non-lava all around -> ok')
  // lava as the tread's floor (below the cell we step onto) -> descentSafety catches it
  assert.strictEqual(M.climbStepSafety('lava', 'stone', dry6), 'lava', 'lava floor under the tread -> lava (descentSafety)')
  assert.strictEqual(M.climbStepSafety('stone', 'lava', dry6), 'lava', 'lava two below the tread -> lava')
  // lava as a NEIGHBOUR of an opened/entered cell (the tread itself, or a pocket one block over)
  assert.strictEqual(M.climbStepSafety('stone', 'stone', ['stone', 'lava', 'stone', 'stone', 'stone', 'stone']), 'lava', 'lava beside an opened cell -> lava (digExposureHazard)')
  // no floor to place a tread on -> void (caller rotates off it, exactly like a fluid)
  assert.strictEqual(M.climbStepSafety('air', 'stone', dry6), 'void', 'no support under the tread -> void')
  assert.strictEqual(M.climbStepSafety(null, 'stone', dry6), 'void', 'unloaded/absent support -> void')
  // water variants
  assert.strictEqual(M.climbStepSafety('water', 'stone', dry6), 'water', 'water under the tread -> water')
  assert.strictEqual(M.climbStepSafety('stone', 'stone', ['stone', 'water', 'stone', 'stone', 'stone', 'stone']), 'water', 'water beside an opened cell -> water')
  // widened death-danger class (fire/magma) matched WITHOUT touching LAVA_RE
  assert.strictEqual(M.climbStepSafety('stone', 'stone', ['stone', 'magma_block', 'stone', 'stone', 'stone', 'stone']), 'lava', 'a magma block neighbour is the same death-danger class -> lava')
  assert.strictEqual(M.climbStepSafety('stone', 'stone', ['stone', 'fire', 'stone', 'stone', 'stone', 'stone']), 'lava', 'fire neighbour -> lava-class refusal')
  assert.strictEqual(M.climbStepSafety('magma_block', 'stone', dry6), 'lava', 'a magma block AS the tread floor -> lava-class refusal')
  // lava outranks water in the neighbour set
  assert.strictEqual(M.climbStepSafety('stone', 'stone', ['water', 'lava', 'stone', 'stone', 'stone', 'stone']), 'lava', 'lava outranks water')
  // no data at all -> ok (descentSafety null/null is void though - guard the intended shape)
  assert.strictEqual(M.climbStepSafety('stone', 'stone', []), 'ok', 'solid support, no neighbour data -> ok')
})

t('faceExposed: embedded ore (all solid) is unreachable; any open face makes it minable', () => {
  assert.strictEqual(M.faceExposed(['stone', 'stone', 'stone', 'stone', 'stone', 'stone']), false, 'boxed in solid rock -> not reachable, DO NOT target')
  assert.strictEqual(M.faceExposed(['stone', 'air', 'stone', 'stone', 'stone', 'stone']), true, 'an air face -> reachable')
  assert.strictEqual(M.faceExposed(['stone', 'stone', 'stone', 'stone', 'cave_air', 'stone']), true, 'a cave_air face -> reachable')
  assert.strictEqual(M.faceExposed(['void_air', 'stone', 'stone', 'stone', 'stone', 'stone']), true, 'void_air counts as exposed')
  assert.strictEqual(M.faceExposed(['stone', null, 'stone', 'stone', 'stone', 'stone']), false, 'an UNLOADED (null) neighbour is NOT treated as exposed (embedded ore stays filtered at a chunk edge)')
  assert.strictEqual(M.faceExposed([]), false, 'no data -> not exposed')
})

t('digToOreInReach (IRON_GATHER_FIX): only tunnel to a detected ore that is close + roughly level', () => {
  // in-bounds: level ore a few blocks away -> tunnel to it (the reachFails=9,10,11 mined=0 case)
  assert.strictEqual(M.digToOreInReach(0, 3), true, 'same level, 3b away -> tunnel')
  assert.strictEqual(M.digToOreInReach(4, 8), true, 'at the vertical band + horizontal limits -> still in range')
  assert.strictEqual(M.digToOreInReach(2, 9), true, 'horizDist may reach maxHoriz+1 (findBlock 64 slop)')
  // out of bounds: too far vertically (would strand the bot) or across a wide gap
  assert.strictEqual(M.digToOreInReach(5, 3), false, 'ore 5 below/above the band -> do NOT chase it down')
  assert.strictEqual(M.digToOreInReach(1, 12), false, 'ore too far horizontally -> not a bounded tunnel')
  // env-tunable bounds
  assert.strictEqual(M.digToOreInReach(6, 3, { vband: 8 }), true, 'a wider vertical band is honored')
  assert.strictEqual(M.digToOreInReach(2, 5, { maxHoriz: 3 }), false, 'a tighter horizontal cap is honored (5 > 3+1)')
  // defensive: negative/garbage inputs never green-light a tunnel
  assert.strictEqual(M.digToOreInReach(-1, 3), false, 'negative dy -> no')
  assert.strictEqual(M.digToOreInReach(2, -1), false, 'negative dist -> no')
})

t('scratchWorthy: at depth, only scratch a NEAR exposed candidate; far/none -> back to branchMine', () => {
  // near surface: scratching is always fine
  assert.strictEqual(M.scratchWorthy(63, 64, [40]), true, 'not at depth -> scratch as usual')
  assert.strictEqual(M.scratchWorthy(63, 64, []), true, 'not at depth, nothing exposed -> still fine (surface path handles it)')
  // at depth (>=8 below surface)
  assert.strictEqual(M.scratchWorthy(16, 64, [8, 30]), true, 'a candidate within ~16b -> worth the scratch')
  assert.strictEqual(M.scratchWorthy(16, 64, [20, 45, 60]), false, 'every candidate farther than 16b -> back to branchMine')
  assert.strictEqual(M.scratchWorthy(16, 64, []), false, 'nothing exposed at depth -> back to branchMine')
  // tunables
  assert.strictEqual(M.scratchWorthy(16, 64, [24], { maxScratch: 30 }), true, 'maxScratch is tunable')
  assert.strictEqual(M.scratchWorthy(60, 64, [40], { deepBelow: 3 }), false, 'deepBelow tunable (y60 now counts as depth, y40 candidate is far)')
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

t('mineReusable: re-enter a close, fresh, real mine; dig fresh otherwise', () => {
  const now = 1000000
  const mine = { x: 100, z: 200, level: 39, at: now - 60000 } // 1 min old, has a level
  assert.strictEqual(M.mineReusable(mine, { x: 110, z: 205 }, { now }), true, 'close + fresh -> re-enter')
  assert.strictEqual(M.mineReusable(mine, { x: 300, z: 200 }, { now }), false, 'too far -> dig fresh')
  assert.strictEqual(M.mineReusable(mine, { x: 100, z: 200 }, { now, maxDist: 5 }), true, 'right on top of it')
  // stale
  assert.strictEqual(M.mineReusable({ ...mine, at: now - 7 * 3600 * 1000 }, { x: 100, z: 200 }, { now }), false, 'too old -> dig fresh')
  // incomplete record (never reached a level) is not reusable
  assert.strictEqual(M.mineReusable({ x: 100, z: 200 }, { x: 100, z: 200 }, { now }), false, 'no level -> not a real mine')
  assert.strictEqual(M.mineReusable(null, { x: 0, z: 0 }, { now }), false)
})

t('mineReusable: maxLevelY depth gate rejects a too-shallow mine (the live 0-iron bug)', () => {
  const at = { x: 0, z: 0 } // right on top -> distance never the reason
  assert.strictEqual(M.mineReusable({ x: 0, z: 0, level: 45 }, at, { maxLevelY: 40 }), false, 'level 45 > iron band 40 -> too shallow, dig deeper')
  assert.strictEqual(M.mineReusable({ x: 0, z: 0, level: 16 }, at, { maxLevelY: 40 }), true, 'a deep mine (y16) is reusable')
  assert.strictEqual(M.mineReusable({ x: 0, z: 0, level: 40 }, at, { maxLevelY: 40 }), true, 'exactly at the band (40) passes (boundary)')
  assert.strictEqual(M.mineReusable({ x: 0, z: 0, level: 45 }, at, {}), true, 'no maxLevelY -> backward compatible (shallow mine still reusable)')
  assert.strictEqual(M.mineReusable({ x: 0, z: 0, level: 35 }, at, { maxLevelY: 40 }), true, 'level 35 < 40 -> deep enough')
})

t('needReTool: re-tool BEFORE the pick breaks, and only with no spare', () => {
  assert.strictEqual(M.needReTool(10, 0), true, 'low + no spare -> re-tool now (while it can still mine cobble)')
  assert.strictEqual(M.needReTool(10, 1), false, 'a spare pick is available -> no need')
  assert.strictEqual(M.needReTool(80, 0), false, 'plenty of uses left -> not yet')
  assert.strictEqual(M.needReTool(0, 0), true, 'broken + no spare -> definitely')
  assert.strictEqual(M.needReTool(25, 0, { low: 30 }), true, 'threshold is tunable')
})

t('mineableWhenBlocked: mine at an iron-viable reached depth, only bail if barely below surface', () => {
  assert.strictEqual(M.mineableWhenBlocked(46, 66), true, 'live gap: descended 20 to y46 -> iron-viable, mine here not bail')
  assert.strictEqual(M.mineableWhenBlocked(50, 66), true, 'y50 is <= iron ceiling (52) -> mine regardless of descent')
  assert.strictEqual(M.mineableWhenBlocked(61, 66), false, 'only descended 5 and above the ceiling -> too shallow, bail')
  assert.strictEqual(M.mineableWhenBlocked(64, 66), false, 'barely scratched the surface -> bail')
  assert.strictEqual(M.mineableWhenBlocked(30, 66), true, 'at least as deep as the old y30 strip floor -> mine')
})

t('preferBranchMine: at-surface iron with only sparse-tail exposure descends; rich/deep exposure scratches', () => {
  // near surface, ore visible but all in the sparse tail (>y52) -> go straight to the branch mine
  assert.strictEqual(M.preferBranchMine('raw_iron', 63, 64, [62, 60, 58]), true, 'only sparse-tail ore visible -> descend')
  // a rich-depth candidate (<=52) is exposed here -> mine what's exposed, don't descend
  assert.strictEqual(M.preferBranchMine('raw_iron', 63, 64, [45, 60]), false, 'a y45 candidate is worth mining -> scratch it')
  // already down a mine (>=8 below surface) -> keep mining the exposed walls
  assert.strictEqual(M.preferBranchMine('raw_iron', 16, 64, [15, 14]), false, 'already deep -> mine what is exposed')
  // nothing exposed at all -> descend
  assert.strictEqual(M.preferBranchMine('raw_iron', 63, 64, []), true, 'no exposed ore -> descend')
  // copper is a SURFACE ore and everything else stays surface too
  assert.strictEqual(M.preferBranchMine('raw_copper', 63, 64, [62]), false, 'copper is surface ore -> never branch-mine')
  assert.strictEqual(M.preferBranchMine('cobblestone', 63, 64, [62]), false, 'cobblestone never reaches the branch mine')
  // tunables
  assert.strictEqual(M.preferBranchMine('raw_iron', 63, 64, [50], { ironCeiling: 40 }), true, 'ironCeiling is tunable (lowered to 40, y50 now sparse-tail -> descend)')
  assert.strictEqual(M.preferBranchMine('raw_iron', 60, 64, [62], { deepBelow: 3 }), false, 'deepBelow is tunable (y60 now counts as deep)')
})

t('preferStoneDescend: at-surface stone with nothing exposed descends; at depth or with candidates it does not; iron is not stone', () => {
  // stone/cobble family, near surface, NOTHING exposed -> descend to the stone layer (the #22 fix)
  assert.strictEqual(M.preferStoneDescend('cobblestone', 63, 64, []), true, 'cobble gather, surface, no exposed stone -> descend')
  assert.strictEqual(M.preferStoneDescend('stone', 70, 70, []), true, 'stone item counts as stone-family')
  // something IS exposed here -> mine it, don't descend
  assert.strictEqual(M.preferStoneDescend('cobblestone', 63, 64, [62, 61]), false, 'exposed stone present -> mine it, no descent')
  // already down a dig (>=8 below surface) -> the loop-top level-preference mines the walls
  assert.strictEqual(M.preferStoneDescend('cobblestone', 50, 64, []), false, 'already deep -> mine the staircase walls, do not re-descend')
  // iron / non-stone items never take the stone descent (they go to preferBranchMine)
  assert.strictEqual(M.preferStoneDescend('raw_iron', 63, 64, []), false, 'iron is not the stone family')
  assert.strictEqual(M.preferStoneDescend('oak_log', 63, 64, []), false, 'logs are not the stone family')
  // deepBelow is tunable
  assert.strictEqual(M.preferStoneDescend('cobblestone', 60, 64, [], { deepBelow: 3 }), false, 'deepBelow tunable (y60 now counts as deep)')
})

t('stoneDescendTargetY: a shallow ~12-below scrape, clamped to the strip floor and never above surface-3', () => {
  assert.strictEqual(M.stoneDescendTargetY(64), 52, 'normal surface -> 12 below (y52), well above the iron/lava depths')
  assert.strictEqual(M.stoneDescendTargetY(70, { hardFloor: 30 }), 58, 'y70 surface -> y58')
  assert.strictEqual(M.stoneDescendTargetY(38, { hardFloor: 30 }), 30, 'low surface clamps to the hard floor (STRIP_FLOOR)')
  assert.ok(M.stoneDescendTargetY(64) <= 64 - 3, 'never sits above surface-3 (always a real descent) via targetMineY')
  assert.strictEqual(M.stoneDescendTargetY(64, { depth: 6 }), 58, 'depth is tunable')
})

t('deepMinePlan: naked digs shallower/shorter with fewer torches; armored gets the full plan', () => {
  const naked = M.deepMinePlan(0)
  assert.strictEqual(naked.targetY, 28, 'naked stays shallower (~y28)')
  assert.strictEqual(naked.maxBranches, 8, 'naked runs a short mine')
  assert.strictEqual(naked.wantTorches, 8)
  assert.strictEqual(naked.naked, true)
  const armored = M.deepMinePlan(4)
  assert.strictEqual(armored.targetY, 16, 'armored reaches the iron band')
  assert.strictEqual(armored.maxBranches, 30)
  assert.strictEqual(armored.wantTorches, 12)
  assert.strictEqual(armored.naked, false)
  // a single piece already counts as armored (modulates, never blocks)
  assert.strictEqual(M.deepMinePlan(1).naked, false, 'one piece -> armored plan')
  // env-style overrides
  assert.strictEqual(M.deepMinePlan(0, { nakedY: 40 }).targetY, 40, 'MINE_NAKED_Y-style override')
  assert.strictEqual(M.deepMinePlan(4, { targetY: 8 }).targetY, 8, 'IRON_TARGET_Y-style override')
})

t('sweepDue: batched-harvest cadence fires on every Nth step (mine-one-pause-one fix)', () => {
  // every=4: a sweep is due at step COUNT 4,8,12 -> 0-based indices 3,7,11; never at 0,1,2
  assert.strictEqual(M.sweepDue(0, 4), false, 'step 0 -> no sweep')
  assert.strictEqual(M.sweepDue(1, 4), false, 'step 1 -> no sweep')
  assert.strictEqual(M.sweepDue(2, 4), false, 'step 2 -> no sweep')
  assert.strictEqual(M.sweepDue(3, 4), true, 'step 3 (4th step) -> sweep')
  assert.strictEqual(M.sweepDue(7, 4), true, 'step 7 (8th step) -> sweep')
  assert.strictEqual(M.sweepDue(11, 4), true, 'step 11 (12th step) -> sweep')
  assert.strictEqual(M.sweepDue(4, 4), false, 'step 4 -> not yet (next is 7)')
  // every=1 -> every step (the MINE_FLUID=0 legacy shape)
  for (let i = 0; i < 6; i++) assert.strictEqual(M.sweepDue(i, 1), true, 'every=1 sweeps every step (legacy cadence)')
})

t('armorBootstrapMining (#71): naked + short of a boots\' worth of iron -> shallow safe band; else inactive', () => {
  // fully naked (0 armor) and 0 raw iron -> ACTIVE, shallow band, descent stops at ymin
  const a = M.armorBootstrapMining(0, 0)
  assert.strictEqual(a.active, true, 'naked + no iron -> bootstrap active')
  assert.strictEqual(a.targetY, 45, 'descent floor = ymin (the deepest of the SAFE band, not the deep y28)')
  assert.strictEqual(a.ymin, 45); assert.strictEqual(a.ymax, 58)
  assert.strictEqual(a.retreatDist, 10, 'default wider retreat band')
  // still short of the 4-iron boots threshold -> still active (accumulating)
  assert.strictEqual(M.armorBootstrapMining(0, 3).active, true, '3 iron (< 4) -> still bootstrapping')
  // reached a boots' worth -> DONE, deep mining may resume
  assert.strictEqual(M.armorBootstrapMining(0, 4).active, false, '4 iron -> boots covered, resume normal depth')
  // #84 SHALLOW_UNTIL_ARMORED (default on): 1-3 pieces KEEP the safe band; 4/4 releases it.
  // Flag =0 -> the original naked-only gate. Drive both env regimes explicitly.
  {
    const prev = process.env.SHALLOW_UNTIL_ARMORED
    delete process.env.SHALLOW_UNTIL_ARMORED // default (flag ON)
    assert.strictEqual(M.armorBootstrapMining(1, 0).active, true, 'one armor piece, flag on -> band kept until fully armored')
    assert.strictEqual(M.armorBootstrapMining(3, 0).active, true, 'three pieces, flag on -> band kept')
    assert.strictEqual(M.armorBootstrapMining(4, 0).active, false, 'fully armored -> inactive')
    process.env.SHALLOW_UNTIL_ARMORED = '0'
    assert.strictEqual(M.armorBootstrapMining(1, 0).active, false, 'one armor piece, flag off -> inactive (original naked-only gate)')
    if (prev === undefined) delete process.env.SHALLOW_UNTIL_ARMORED; else process.env.SHALLOW_UNTIL_ARMORED = prev
  }
  // flag off (ARMOR_BOOTSTRAP=0) -> ALWAYS inactive, byte-for-byte
  assert.strictEqual(M.armorBootstrapMining(0, 0, { enabled: false }).active, false, 'flag off -> inactive even when all else says go')
  // env-tunable band + threshold
  const b = M.armorBootstrapMining(0, 5, { ymin: 40, ymax: 55, bootsIron: 8, retreatDist: 12 })
  assert.strictEqual(b.active, true, '5 iron with bootsIron 8 -> still short')
  assert.strictEqual(b.targetY, 40); assert.strictEqual(b.retreatDist, 12)
})

t('armorBootstrapRetreat (#71): a bootstrapping bot retreats from ANY hostile within the wider band', () => {
  // active + hostile inside the band -> retreat
  assert.strictEqual(M.armorBootstrapRetreat(true, 8, 10), true, 'hostile 8b <= 10b band + active -> retreat')
  assert.strictEqual(M.armorBootstrapRetreat(true, 10, 10), true, 'exactly at the band edge -> retreat')
  // active but the hostile is beyond the band -> keep mining (the shallow band has few of them)
  assert.strictEqual(M.armorBootstrapRetreat(true, 11, 10), false, 'hostile past the band -> no early retreat')
  // no hostile -> never retreat
  assert.strictEqual(M.armorBootstrapRetreat(true, null, 10), false, 'no hostile -> keep mining')
  // NOT bootstrapping (armored / has iron / flag off) -> the wider retreat is off entirely
  assert.strictEqual(M.armorBootstrapRetreat(false, 3, 10), false, 'inactive -> today\'s reflex owns it (no early retreat)')
})

t('ironKeystone (IRON_KEYSTONE): naked + short of a boots\' worth of iron -> descend+commit; else inactive', () => {
  // fully naked (0 armor) + 0 iron -> ACTIVE: descend straight to the branch mine AND commit (hold the
  // build / non-crisis)
  const a = M.ironKeystone({ armorPieces: 0, rawIron: 0 })
  assert.strictEqual(a.active, true, 'naked + no iron -> keystone active')
  assert.strictEqual(a.descend, true, 'active -> must descend to the shallow band, never surface-scratch')
  assert.strictEqual(a.commit, true, 'active -> hold the grind vs the build / a non-crisis')
  assert.strictEqual(a.bootsIron, 4, 'default boots threshold')
  // still short of 4 iron -> still active (accumulating the first boots)
  assert.strictEqual(M.ironKeystone({ armorPieces: 0, rawIron: 3 }).active, true, '3 iron (<4) -> still on the keystone')
  // reached a boots' worth OR wearing any piece -> inactive (the ring can unlock; normal routing resumes)
  assert.strictEqual(M.ironKeystone({ armorPieces: 0, rawIron: 4 }).active, false, '4 iron -> boots affordable, keystone done')
  assert.strictEqual(M.ironKeystone({ armorPieces: 1, rawIron: 0 }).active, false, 'one armor piece -> not naked -> inactive')
  // flag off (IRON_KEYSTONE=0) -> ALWAYS inactive => today byte-for-byte
  assert.strictEqual(M.ironKeystone({ armorPieces: 0, rawIron: 0 }, { enabled: false }).active, false, 'flag off -> inactive')
  assert.strictEqual(M.ironKeystone({ armorPieces: 0, rawIron: 0 }, { enabled: false }).descend, false, 'flag off -> no forced descend')
  assert.strictEqual(M.ironKeystone({ armorPieces: 0, rawIron: 0 }, { enabled: false }).commit, false, 'flag off -> no commit')
  // env-tunable threshold
  assert.strictEqual(M.ironKeystone({ armorPieces: 0, rawIron: 6 }, { bootsIron: 8 }).active, true, '6 iron with bootsIron 8 -> still short')
})

t('ironKeystoneFruitless (IRON_KEYSTONE): only a genuine no-iron-after-mining pass arms the lockout', () => {
  // NOT keystone-active -> defer to today's gearupShouldArmBackoff (caller keeps its verdict)
  assert.strictEqual(M.ironKeystoneFruitless({ active: false, progressed: false, interrupted: false, minedReal: true }), 'defer', 'inactive -> defer to today')
  // progressed -> never arms
  assert.strictEqual(M.ironKeystoneFruitless({ active: true, progressed: true, interrupted: false, minedReal: true }), false, 'progress never arms')
  // interrupted (survival/stop preempt, #60) -> not a material failure
  assert.strictEqual(M.ironKeystoneFruitless({ active: true, progressed: false, interrupted: true, minedReal: true }), false, 'interrupted -> not fruitless (#60)')
  // reclaimed by the build before it ever mined the band (minedReal false) -> NOT fruitless (the bug)
  assert.strictEqual(M.ironKeystoneFruitless({ active: true, progressed: false, interrupted: false, minedReal: false }), false, 'never reached the band -> not fruitless (build reclaim)')
  // GENUINE: descended, mined the shallow band, still found no iron -> honest fruitless (arms)
  assert.strictEqual(M.ironKeystoneFruitless({ active: true, progressed: false, interrupted: false, minedReal: true }), true, 'mined the band + no iron -> honest fruitless')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall mining-strategy tests passed')
process.exit(failures ? 1 : 0)
