'use strict'
// OFFLINE unit test for the WORLD_TIDY (#94) pure litter classifier (hut-model.litterSignature)
// - PURE, no bot, no world. Every one of the five dig signatures gets: a POSITIVE case, a
// near-miss NEGATIVE (just under the threshold), and an anti-grief NEGATIVE (a schema-matching
// hut cell / crop / farmland / tree / non-litter class the classifier must NEVER dig).
// Run:  cd bot && node worldtidytest.js

const assert = require('assert')
const H = require('./hut-model.js')

let n = 0
const dig = (ctx, label) => { n++; const r = H.litterSignature(ctx); assert.strictEqual(r.decision, 'dig', 'DIG ' + label + ' -> got ' + JSON.stringify(r)) }
const digSig = (ctx, sig, label) => { n++; const r = H.litterSignature(ctx); assert.strictEqual(r.decision, 'dig', 'DIG ' + label + ' -> ' + JSON.stringify(r)); assert.strictEqual(r.sig, sig, 'SIG ' + label + ' -> ' + JSON.stringify(r)) }
const keep = (ctx, label) => { n++; const r = H.litterSignature(ctx); assert.strictEqual(r.decision, 'keep', 'KEEP ' + label + ' -> got ' + JSON.stringify(r)) }

// ---- classifier helpers ---------------------------------------------------------------
assert.strictEqual(H.isTidyFiller('cobblestone'), true, 'cobblestone is filler')
assert.strictEqual(H.isTidyFiller('dirt'), true, 'dirt is filler')
assert.strictEqual(H.isTidyFiller('grass_block'), true, 'grass_block is filler (dirt/grass variant)')
assert.strictEqual(H.isTidyFiller('oak_planks'), false, 'planks are NOT filler')
assert.strictEqual(H.isTidyFiller('chest'), false, 'chest is NOT filler')
assert.strictEqual(H.isTidyTorch('torch'), true, 'torch is a torch')
assert.strictEqual(H.isTidyTorch('wall_torch'), true, 'wall_torch is a torch')
assert.strictEqual(H.isTidyTorch('redstone_torch'), false, 'redstone_torch is not a plain torch')
n += 8

// canonical torch keeper: lowest y, then x, then z
{
  const cluster = [{ x: 5, y: 70, z: 5 }, { x: 1, y: 68, z: 9 }, { x: 0, y: 68, z: 0 }]
  const k = H.canonicalLitterTorch(cluster)
  assert.deepStrictEqual(k, { x: 0, y: 68, z: 0 }, 'keeper is lowest y, then lowest x, then z')
  n++
}

// ---- 1. DUPLICATE TORCH ---------------------------------------------------------------
// POSITIVE: a torch that is NOT the cluster keeper (another torch is lower) -> dig.
digSig({ name: 'torch', self: { x: 10, y: 65, z: 10 }, torchCluster: [{ x: 10, y: 65, z: 10 }, { x: 11, y: 64, z: 10 }] }, 'dup-torch', 'torch above a lower cluster-mate')
// The keeper of the same cluster -> keep (exactly one survives).
keep({ name: 'torch', self: { x: 11, y: 64, z: 10 }, torchCluster: [{ x: 10, y: 65, z: 10 }, { x: 11, y: 64, z: 10 }] }, 'the cluster keeper stays lit')
// NEAR-MISS: a lone torch (cluster of one = only itself) -> keep.
keep({ name: 'torch', self: { x: 10, y: 65, z: 10 }, torchCluster: [{ x: 10, y: 65, z: 10 }] }, 'a lone torch is not a duplicate')
// NEAR-MISS: two torches but >2 cells apart are separate clusters (executor never groups them,
// so torchCluster holds only self) -> keep.
keep({ name: 'torch', self: { x: 10, y: 65, z: 10 }, torchCluster: [{ x: 10, y: 65, z: 10 }] }, 'far-apart torches are separate clusters')

// ---- 2. FLOATING SINGLE BLOCK ---------------------------------------------------------
digSig({ name: 'dirt', self: { x: 3, y: 70, z: 3 }, airFaces: 5, sidesAir: 4, towerRun: 1 }, 'floating', 'dirt with 5 air faces')
digSig({ name: 'cobblestone', self: { x: 3, y: 70, z: 3 }, airFaces: 6, sidesAir: 4, towerRun: 1 }, 'floating', 'fully floating cobble (6 faces)')
// NEAR-MISS: only 4 air faces (sitting on something) -> keep (not a floating scrap, and not a tower).
keep({ name: 'dirt', self: { x: 3, y: 70, z: 3 }, airFaces: 4, sidesAir: 4, towerRun: 1 }, '4 air faces is not floating')

// ---- 3. 1x1 TOWER ---------------------------------------------------------------------
digSig({ name: 'cobblestone', self: { x: 4, y: 66, z: 4 }, airFaces: 4, sidesAir: 4, towerRun: 3 }, 'tower', '3-tall 1x1 pillar cell')
digSig({ name: 'dirt', self: { x: 4, y: 67, z: 4 }, airFaces: 4, sidesAir: 4, towerRun: 5 }, 'tower', 'tall pillar cell')
// NEAR-MISS: only 2 tall -> keep.
keep({ name: 'dirt', self: { x: 4, y: 66, z: 4 }, airFaces: 4, sidesAir: 4, towerRun: 2 }, '2-tall column is not a tower')
// NEAR-MISS: 3 tall but only 3 sides air (part of a 2-wide wall) -> keep.
keep({ name: 'dirt', self: { x: 4, y: 66, z: 4 }, airFaces: 3, sidesAir: 3, towerRun: 3 }, 'a wall column (3 sides air) is not a 1x1 tower')

// ---- 4. HUT-EXTERIOR SCRAP ------------------------------------------------------------
digSig({ name: 'cobblestone', self: { x: 2, y: 70, z: 2 }, onHutExterior: true, airFaces: 5, hutSchemaFabric: false }, 'hut-scrap', 'cobble resting on the roof')
digSig({ name: 'dirt', self: { x: -1, y: 67, z: 2 }, onHutExterior: true, airFaces: 3, hutSchemaFabric: false }, 'hut-scrap', 'dirt stuck to a wall face (3 air faces)')
// NEAR-MISS: on the exterior but embedded in a hillside (only 2 air faces) -> keep (never carve terrain).
keep({ name: 'dirt', self: { x: -1, y: 66, z: 2 }, onHutExterior: true, airFaces: 2, hutSchemaFabric: false }, 'a hillside block against the wall (2 air faces) is left alone')

// ---- 5. FARM / ORCHARD FOOTPRINT SCRAP ------------------------------------------------
digSig({ name: 'dirt', self: { x: 20, y: 64, z: 20 }, inFarmPlot: true, isFarmland: false, isCrop: false, isTree: false }, 'farm-scrap', 'floating dirt in the plot')
digSig({ name: 'cobblestone', self: { x: 21, y: 64, z: 21 }, inFarmPlot: true }, 'farm-scrap', 'cobble scrap in the plot')
// NEAR-MISS: same block, but NOT flagged in-plot (outside the bbox/band) and not floating -> keep.
keep({ name: 'dirt', self: { x: 20, y: 64, z: 20 }, inFarmPlot: false, airFaces: 2, towerRun: 1 }, 'a dirt block outside the plot band is left alone')

// ---- ANTI-GRIEF: sacrosanct classes are NEVER dug (whatever else is set) --------------
// A schema-matching hut FABRIC cell (a plank wall the executor mistakenly scanned) - never dig,
// even if it were somehow a filler class with floating faces.
keep({ name: 'cobblestone', self: { x: 0, y: 67, z: 2 }, hutSchemaFabric: true, airFaces: 6, onHutExterior: true, inFarmPlot: true, towerRun: 5, sidesAir: 4 }, 'hut schema fabric is sacrosanct')
keep({ name: 'oak_planks', self: { x: 0, y: 67, z: 2 }, onHutExterior: true, airFaces: 6 }, 'planks are not a litter class')
// Crops / farmland / trees inside the farm plot - never dig even with inFarmPlot set.
keep({ name: 'wheat', self: { x: 20, y: 64, z: 20 }, inFarmPlot: true, isCrop: true }, 'a crop is never dug')
keep({ name: 'farmland', self: { x: 20, y: 63, z: 20 }, inFarmPlot: true, isFarmland: true }, 'farmland is never dug')
keep({ name: 'oak_sapling', self: { x: 25, y: 64, z: 25 }, inFarmPlot: true, isTree: true }, 'a sapling is never dug')
keep({ name: 'dirt', self: { x: 20, y: 64, z: 20 }, inFarmPlot: true, isTree: true }, 'a tree-flagged cell is never dug even if the name is filler')
// Furniture / stations (non-litter classes) - never dig.
keep({ name: 'chest', self: { x: 1, y: 66, z: 1 }, airFaces: 6 }, 'a chest is never dug')
keep({ name: 'crafting_table', self: { x: 1, y: 66, z: 1 }, onHutExterior: true, airFaces: 6 }, 'a table is never dug')
keep({ name: 'white_bed', self: { x: 1, y: 66, z: 1 }, airFaces: 6 }, 'a bed is never dug')
// Empty / unknown ctx -> keep.
keep({}, 'empty ctx -> keep')
keep(null, 'null ctx -> keep')

console.log('all passed (' + n + ' assertions)')
