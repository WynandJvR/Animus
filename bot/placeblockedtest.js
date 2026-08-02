'use strict'
// OFFLINE test for ROOT S (2026-08-02): NOTHING GUARDED PLACEMENT. No server, no world.
// Run:  cd bot && node placeblockedtest.js
//
// THE LIVE CHAIN. A dirt block was placed in the cell directly above the bank chest at
// 192,68,-103. In vanilla an opaque full cube above a chest makes it unopenable
// (Chest.isBlockedChestByBlock -> isSolidBlocking), so every read of that chest threw a genuine
// in-reach window failure; chest-cache.json held {"192,68,-103":{"counts":{},"at":0,"fails":1}}
// - `at: 0` meaning NEVER successfully read - and the resource model reported the bank as EMPTY.
// The operator had to break the block by hand.
//
// provision-core.placeAt scanned six neighbour faces for anything solid to place against and
// NEVER asked what the placement would cover, seal or shut. This is the mirror of digBlocked
// (the dig half of exactly this rule, shipped earlier the same session): one function, arms in
// a stated order, returns the blocker or null, cheap enough for a loop.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const provCore = require('./provision-core.js')
const provHut = require('./provision-hut.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

// ---- the live geometry, so the rule is checked against the hut that actually exists --------
const HUT = { x: 188, y: 67, z: -104 }        // infra.hut, verified
const CHEST = { x: 192, y: 68, z: -103 }      // the bank half the dirt sealed
const CHEST2 = { x: 192, y: 68, z: -102 }     // its double partner
const BED = { x: 190, y: 68, z: -102 }        // infra.bed, both halves remembered
const DOOR_COL = { x: 190, z: -104 }          // a non-corner rim column on the z-min wall

// A stub world for the doorway detector: plank rim at the door courses, an oak_door hung in
// DOOR_COL, air everywhere else. `reads` counts blockAt calls so the cheapness claim below is
// MEASURED rather than asserted.
let reads = 0
const AIR = { name: 'air', boundingBox: 'empty' }
const PLANK = { name: 'oak_planks', boundingBox: 'block' }
const DOOR = { name: 'oak_door', boundingBox: 'empty' }
const botStub = {
  blockAt (v) {
    reads++
    const { x, y, z } = v
    if (y !== HUT.y + 1 && y !== HUT.y + 2) return AIR
    const inBox = x >= HUT.x && x <= HUT.x + 5 && z >= HUT.z && z <= HUT.z + 5
    if (!inBox) return AIR
    const isRim = x === HUT.x || x === HUT.x + 5 || z === HUT.z || z === HUT.z + 5
    if (!isRim) return AIR
    if (x === DOOR_COL.x && z === DOOR_COL.z) return DOOR
    return PLANK
  }
}

function withRegistry (infra, bed, fn) {
  const wm = require('./world-memory.js')
  const mem = wm.loadWorldMem()
  const savedInfra = mem.infra; const savedBed = mem.bed
  mem.infra = infra
  mem.bed = bed
  try { return fn() } finally { mem.infra = savedInfra; mem.bed = savedBed }
}
const HOME = { hut: [HUT], chest: [CHEST, CHEST2], bed: [BED, { x: 191, y: 68, z: -102 }], furnace: [{ x: 192, y: 68, z: -100 }], table: [{ x: 189, y: 68, z: -100 }] }

// ---- 1. ARM 1: container headroom ---------------------------------------------------------
t('ARM 1 chest-headroom: THE live cell - a dirt block above the bank chest is REFUSED', () => {
  withRegistry(HOME, null, () => {
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 192, y: 69, z: -103 }, 'dirt'), 'chest-headroom',
      'this is the exact placement that bricked the bank and forced the operator to break it by hand')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 192, y: 69, z: -102 }, 'cobblestone'), 'chest-headroom',
      'the double chest\'s other half needs its own headroom - both cells are registered')
  })
})

t('ARM 1 is derived from the BLOCK, not blanket-banned over all infra', () => {
  withRegistry(HOME, null, () => {
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 192, y: 69, z: -100 }, 'dirt'), null,
      'a FURNACE needs no headroom in 1.21 - refusing above it would forbid ordinary building for nothing')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 189, y: 69, z: -100 }, 'dirt'), null,
      'and neither does a crafting table')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 192, y: 70, z: -103 }, 'dirt'), null,
      'ONE cell, not a column: two above the chest does not block it')
    assert.strictEqual(provCore.placeBlocked(botStub, CHEST, 'chest'), null,
      'and the chest cell itself is not reserved - re-placing a broken chest must still work')
  })
})

t('ARM 1: a placement that does not SEAL the cell is fine (a torch does not shut a chest)', () => {
  withRegistry(HOME, null, () => {
    for (const item of ['torch', 'oak_sign', 'white_carpet', 'oak_trapdoor', 'lantern']) {
      assert.strictEqual(provCore.placeBlocked(botStub, { x: 192, y: 69, z: -103 }, item), null, item + ' hangs/lies flat - the chest still opens')
    }
    // ...and the allow-list is the SMALL side: anything unlisted is treated as sealing.
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 192, y: 69, z: -103 }, 'sculk_shrieker'), 'chest-headroom',
      'an exotic block nobody listed must fail PROTECTIVE (#115), not be waved through')
  })
})

// ---- 2. ARM 2: the bed ---------------------------------------------------------------------
t('ARM 2 bed: a registered bed cell takes nothing but a bed', () => {
  withRegistry(HOME, null, () => {
    assert.strictEqual(provCore.placeBlocked(botStub, BED, 'dirt'), 'bed')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 191, y: 68, z: -102 }, 'oak_planks'), 'bed', 'both halves')
    assert.strictEqual(provCore.placeBlocked(botStub, BED, 'white_bed'), null,
      'a rule that could not put the bed back would be a bug, not a guard - the spawn anchor is repairable')
    assert.strictEqual(provCore.placeBlocked(botStub, BED, 'torch'), 'bed',
      'unlike headroom, ANY occupant defeats a bed cell - a torch in it stops the bed being re-laid')
  })
})

t('ARM 2 also covers the spawn anchor when infra.bed is empty (knownBed)', () => {
  withRegistry({ hut: [HUT] }, { x: 400, y: 70, z: 400, confirmed: true }, () => {
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 400, y: 70, z: 400 }, 'dirt'), 'bed',
      'the bed record and the infra list are two registries; the rule reads both')
  })
})

// ---- 3+4. ARMS 3/4: the doorway and its approach --------------------------------------------
t('ARM 3 door: the doorway column takes nothing but a door', () => {
  withRegistry(HOME, null, () => {
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 68, z: -104 }, 'oak_planks'), 'door',
      'walling the doorway is d4cf46c ("SEALED IN: the bot could not get out of its own front door")')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 69, z: -104 }, 'dirt'), 'door', 'the head course too')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 68, z: -104 }, 'oak_door'), null,
      'repairHutStructure must still be able to re-hang the door')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 189, y: 68, z: -104 }, 'oak_planks'), null,
      'the rim WALL beside the door is ordinary fabric - repair places planks there every pass')
  })
})

t('ARM 4 door-approach: the body column just OUTSIDE the doorway stays walkable', () => {
  withRegistry(HOME, null, () => {
    // outsideCell for a z-min rim door is one cell further -z; approachCells is that cell AND
    // its way out, at the feet (y+1) and head (y+2) courses.
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 68, z: -105 }, 'dirt'), 'door-approach',
      'the doorstep - 2026-07-30: "the generic furnace placer chose the doorstep because nothing tells it the approach is reserved"')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 69, z: -105 }, 'cobblestone'), 'door-approach', 'head course')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 68, z: -106 }, 'dirt'), 'door-approach',
      'AND its way out: doorstep-only made the doorstep a 1x1 dead end that a bot at food 0 cannot jump out of')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 68, z: -107 }, 'dirt'), null, 'three out is ordinary ground')
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 68, z: -105 }, 'torch'), null,
      'a torch AT the doorstep is exactly what secureBase wants there')
  })
})

t('the doorway arms are silent when there is no hut / no doorway (#10: unmeasured is not reserved)', () => {
  withRegistry({}, null, () => {
    assert.strictEqual(provCore.placeBlocked(botStub, { x: 190, y: 68, z: -105 }, 'dirt'), null, 'no hut registered -> nothing owns a doorway')
  })
})

// ---- 5. CHEAPNESS - it is asked in loops (#8 body responsiveness) ---------------------------
t('placeBlocked costs NO world read for a cell away from the hut', () => {
  withRegistry(HOME, null, () => {
    reads = 0
    for (let i = 0; i < 64; i++) provCore.placeBlocked(botStub, { x: 1000 + i, y: 60, z: 1000 }, 'dirt')
    assert.strictEqual(reads, 0, 'a cell at an unrelated HEIGHT costs nothing - the door-course test is first')
    // ...and, the arm that actually matters, a cell AT the door courses but far away in XZ: this is
    // the one an ensurePillarFiller-shaped loop near a hillside hut would hit.
    reads = 0
    for (let i = 0; i < 64; i++) provCore.placeBlocked(botStub, { x: 1000 + i, y: HUT.y + 1, z: 1000 }, 'dirt')
    assert.strictEqual(reads, 0,
      'ensurePillarFiller-shaped loops must not pay for a rim scan: the hut XZ bounds test is pure arithmetic and comes FIRST')
  })
})

t('the doorway detection is MEMOISED - a rim scan per candidate would be the cost the bounds test avoids', () => {
  withRegistry(HOME, null, () => {
    provCore.placeBlocked(botStub, { x: 190, y: 68, z: -105 }, 'dirt') // prime
    reads = 0
    for (let i = 0; i < 20; i++) provCore.placeBlocked(botStub, { x: 190, y: 68, z: -105 }, 'dirt')
    assert.ok(reads <= 20, 'one re-validating read per call, not a ~48-read doorwayColumn scan (got ' + reads + ')')
  })
})

t('the memo re-detects when the cached column stops being a doorway (a condition, never a timer)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  const i = src.indexOf('function hutDoorway (bot, hut)')
  const fn = src.slice(i, src.indexOf('\n}', i))
  assert.ok(!/Date\.now|setTimeout|TTL|_ms|Ms\b/.test(fn), 'no clock in the invalidation - the condition IS the invalidation')
  assert.ok(/DOOR_RE\.test|WALL_RE\.test/.test(fn), 'it re-validates against the world it cached')
})

// ---- 6. THE CALL SITES: one definition, every placer (MUTATION CHECKS) ----------------------
t('pathfix.verifiedPlace - the ONE placement primitive - asks the rule (MUTATION CHECK)', () => {
  const pf = fs.readFileSync(path.join(__dirname, 'pathfix.js'), 'utf8')
  const i = pf.indexOf('async function verifiedPlace (referenceBlock, faceVector, options)')
  assert.ok(i > 0, 'verifiedPlace still exists')
  const fn = pf.slice(i, pf.indexOf('\n    bot._placeBlockWithOptions = verifiedPlace', i))
  assert.ok(/placeBlocked\(bot, target, heldName\)/.test(fn),
    'this is the choke point: bot.placeBlock is rebuilt on it, mineflayer-builder calls it directly (index.js:95) ' +
    'and mineflayer-pathfinder goes through bot.placeBlock (index.js:556). A guard at any CALLER leaves the ' +
    "library's own scaffolding placements - the ones that drop filler on the furniture while merely walking past - unguarded.")
  assert.ok(/throw new Error\(`refusing to place/.test(fn), 'a refusal THROWS, which is the failure shape every caller already handles')
  const before = fn.indexOf('placeBlocked')
  const orig = fn.indexOf('origPBWO(')
  assert.ok(before > 0 && before < orig, 'and it is asked BEFORE the packet goes out, not after')
})

t('provision-core.placeAt asks the SAME function, once, before equipping (MUTATION CHECK)', () => {
  const core = fs.readFileSync(path.join(__dirname, 'provision-core.js'), 'utf8')
  const i = core.indexOf('async function placeAt (bot, target, match)')
  const fn = core.slice(i, core.indexOf('\n}', i))
  assert.ok(/const blocked = placeBlocked\(bot, target, item\.name\)/.test(fn), 'one call, same function - no second copy of the rule (#4)')
  assert.ok(/placeAt\.lastFail = 'refused: ' \+ blocked/.test(fn), 'the blocker is named in lastFail, which is what every caller logs')
  assert.ok(fn.indexOf('const blocked =') < fn.indexOf('bot.equip('), 'refuse before equipping, not once per candidate face')
})

t('the rule is ONE function with the arms in a stated order (MUTATION CHECK)', () => {
  const core = fs.readFileSync(path.join(__dirname, 'provision-core.js'), 'utf8')
  const i = core.indexOf('function placeBlocked (bot, cell, itemName)')
  const fn = core.slice(i, core.indexOf('\n}', i))
  assert.ok(!/bot\.blockAt|findBlock/.test(fn), 'no world reads of its own - the hut layer owns the one it needs, memoised')
  assert.ok(!/process\.env/.test(fn), 'ROOT S adds NO process.env flag - the rule has no off switch')
  const arms = ['chest-headroom', 'bed', "'door'", 'door-approach']
  let at = -1
  for (const a of arms) { const j = fn.indexOf(a); assert.ok(j > at, 'arm ' + a + ' is out of order'); at = j }
})

t('ROOT S adds no process.env flag anywhere it touches', () => {
  const hut = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  for (const name of ['function containerHeadroomAt (pos)', 'function ownBedCellAt (pos)', 'function hutDoorway (bot, hut)', 'function doorwayReservationAt (bot, pos, hut)']) {
    const i = hut.indexOf(name)
    assert.ok(i > 0, name + ' exists')
    assert.ok(!/process\.env/.test(hut.slice(i, hut.indexOf('\n}', i))), name + ' has no off switch')
  }
})

// ---- 7. ANTI-ENTOMBMENT: the rule must not break sealing a survival pit ----------------------
t('sealing a survival pit is untouched - the shelter path digs 12 blocks clear of the hut first', () => {
  const sh = fs.readFileSync(path.join(__dirname, 'provision-shelter.js'), 'utf8')
  assert.ok(/shelter: on my hut apron - stepping clear to/.test(sh),
    'digInForNight steps off the apron before it digs, so sealShaft\'s walls and cap cannot reach a reserved cell')
  // ...and the arithmetic says the same thing: a pit that far out is nowhere near the door.
  withRegistry(HOME, null, () => {
    const away = { x: HUT.x + 12, z: HUT.z + 12 }
    for (const dy of [0, 1, 2]) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
        assert.strictEqual(provCore.placeBlocked(botStub, { x: away.x + dx, y: 60 + dy, z: away.z + dz }, 'dirt'), null,
          'every wall/cap cell of a pit on the step-clear target is permitted')
      }
    }
  })
})

t('there is no allowOwnInfra-style carve-out, and that is deliberate (MUTATION CHECK)', () => {
  const core = fs.readFileSync(path.join(__dirname, 'provision-core.js'), 'utf8')
  const i = core.indexOf('function placeBlocked (bot, cell, itemName)')
  const fn = core.slice(i, core.indexOf('\n}', i))
  assert.ok(!/allow|sealing\s*=|opts\./.test(fn),
    'a PLACE rule cannot entomb the bot the way a dig rule can, so it needs no trapped carve-out; and in the ' +
    'one case where the step-clear walk fails and the bot pits ON its own doorstep, refusing is still right - ' +
    'd4cf46c is what the other choice costs.')
})

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
process.exit(failures ? 1 : 0)
