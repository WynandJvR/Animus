'use strict'
// OFFLINE unit test for the PURE nav-terrain policy core (bot/nav-profile.js) - no bot, no
// pathfinder, no world. Proves the six-layer anti-grief semantics the wild-terrain Movements
// profile relies on (DESIGN-navP1-terrain-profile §4.2):
//   1. the Movements-level TYPE whitelist never admits a STRUCTURE_RE / non-DIGGABLE_NATURAL
//      block id (the two scaffold-material names are the ONLY structure-family exception, and
//      they still require a positional registry hit);
//   2. it admits every DIGGABLE_NATURAL family + _leaves$;
//   3. the positional break exclusion forbids near own infra / buildZone (TYPE-INDEPENDENT);
//   4. the row-19 registry gate: own-tagged cobble breakable, un-registered/expired refused;
//   5. the selector scope gate (wildAllowedAt) boundary.
// The regexes come from provision's NEW exports so the test can never drift from the live
// ones. Run:  cd bot && node navprofiletest.js
//
// This is the anti-grief gate for the ONE change that grants DIG permissions - every case
// here is a griefing pre-condition. A red suite blocks the feature.

const assert = require('assert')
const nav = require('./nav-profile.js')
const provision = require('./provision.js') // for DIGGABLE_NATURAL / STRUCTURE_RE (the live regexes)

const DIGGABLE = provision.DIGGABLE_NATURAL
const STRUCTURE = provision.STRUCTURE_RE
const canType = (name) => nav.canWildBreakType(name, DIGGABLE, STRUCTURE)

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

// ---- sanity: provision really exports the shared regexes ---------------------------------
t('provision exports the shared regexes + canBreakNaturally', () => {
  assert(DIGGABLE instanceof RegExp, 'DIGGABLE_NATURAL exported as a RegExp')
  assert(STRUCTURE instanceof RegExp, 'STRUCTURE_RE exported as a RegExp')
  assert(typeof provision.canBreakNaturally === 'function', 'canBreakNaturally exported')
})

// ---- case 1: whitelist NEVER admits a STRUCTURE_RE family (except the 2 scaffold names) -----
t('type whitelist rejects EVERY STRUCTURE_RE block family (planks/door/torch/chest/bed/glass/bricks/stripped_...)', () => {
  const structureNames = [
    'oak_planks', 'spruce_planks', 'oak_stairs', 'stone_stairs', 'stone_slab', 'oak_slab',
    'oak_fence', 'nether_brick_fence', 'oak_door', 'iron_door', 'oak_trapdoor', 'iron_trapdoor',
    'stone_brick_wall', 'cobblestone_wall', 'glass', 'white_stained_glass', 'glass_pane',
    'white_bed', 'red_bed', 'torch', 'wall_torch', 'soul_torch', 'lantern', 'soul_lantern',
    'crafting_table', 'furnace', 'chest', 'trapped_chest', 'ender_chest', 'barrel', 'bookshelf',
    'ladder', 'oak_sign', 'oak_wall_sign', 'white_carpet', 'white_wool', 'black_wool',
    'stone_bricks', 'nether_bricks', 'bricks', 'smooth_stone', 'polished_granite',
    'polished_andesite', 'composter', 'loom', 'bell', 'dirt_path', 'farmland', 'hay_block',
    'stripped_oak_log', 'stripped_spruce_wood', 'oak_wood', 'oak_log', 'spruce_log'
  ]
  for (const n of structureNames) {
    assert.strictEqual(canType(n), false, 'whitelist must REJECT structure/log block: ' + n)
    // and it must be STRUCTURE_RE or a non-natural id (not a scaffold-material name)
    assert(!nav.SCAFFOLD_BREAK_RE.test(n), n + ' is not a scaffold-material name')
  }
})

t('the ONLY structure-family names the type gate admits are the 2 scaffold materials', () => {
  // cobblestone IS in STRUCTURE_RE, yet must be admitted at the TYPE level (its positional
  // registry gate lives in breakExclusion). cobbled_deepslate is not in DIGGABLE_NATURAL.
  assert.strictEqual(STRUCTURE.test('cobblestone'), true, 'cobblestone is a STRUCTURE_RE name')
  assert.strictEqual(canType('cobblestone'), true, 'cobblestone admitted at type level (registry gates it positionally)')
  assert.strictEqual(DIGGABLE.test('cobbled_deepslate'), false, 'cobbled_deepslate not a DIGGABLE_NATURAL name')
  assert.strictEqual(canType('cobbled_deepslate'), true, 'cobbled_deepslate admitted at type level')
})

// ---- case 2: whitelist admits DIGGABLE_NATURAL families + _leaves$, rejects log/wood/etc -----
t('type whitelist admits DIGGABLE_NATURAL families + _leaves$', () => {
  const naturalNames = [
    'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'moss_block',
    'stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'sand',
    'red_sand', 'gravel', 'clay', 'mud', 'sandstone', 'snow_block', 'ice', 'packed_ice',
    'netherrack', 'soul_sand', 'magma_block', 'blackstone', 'basalt', 'end_stone',
    'iron_ore', 'diamond_ore', 'deepslate_gold_ore', 'white_terracotta', 'terracotta',
    'oak_leaves', 'spruce_leaves', 'azalea_leaves'
  ]
  for (const n of naturalNames) assert.strictEqual(canType(n), true, 'whitelist must ADMIT natural/leaf block: ' + n)
})

t('type whitelist rejects _log$/_wood$/crafting_table/farmland/dirt_path (design case 2)', () => {
  for (const n of ['oak_log', 'birch_log', 'oak_wood', 'crafting_table', 'farmland', 'dirt_path']) {
    assert.strictEqual(canType(n), false, 'must reject ' + n)
  }
})

t('type whitelist tolerates falsy/unknown names', () => {
  assert.strictEqual(canType(null), false)
  assert.strictEqual(canType(undefined), false)
  assert.strictEqual(canType(''), false)
})

// ---- case 3: breakExclusion positional gate (anchors + buildZone), TYPE-INDEPENDENT ---------
const never = () => false
t('breakExclusion: anchor at 15.9b => 100, at 16.1b => 0 (INFRA_BREAK_RADIUS boundary)', () => {
  const near = [{ x: 15.9, z: 0 }]
  const far = [{ x: 16.1, z: 0 }]
  // TYPE-INDEPENDENT: even natural dirt is forbidden inside the ring
  assert.strictEqual(nav.breakExclusion(near, null, 'dirt', { x: 0, z: 0 }, never), 100, '15.9b dirt forbidden')
  assert.strictEqual(nav.breakExclusion(far, null, 'dirt', { x: 0, z: 0 }, never), 0, '16.1b dirt allowed')
})

t('breakExclusion: buildZone pad boundary (inside/edge/outside +16)', () => {
  const bz = { x1: 0, x2: 10, z1: 0, z2: 10 }
  assert.strictEqual(nav.breakExclusion([], bz, 'dirt', { x: 5, z: 5 }, never), 100, 'inside buildZone forbidden')
  assert.strictEqual(nav.breakExclusion([], bz, 'dirt', { x: 26, z: 5 }, never), 100, 'edge x2+16 forbidden')
  assert.strictEqual(nav.breakExclusion([], bz, 'dirt', { x: 27, z: 5 }, never), 0, 'x2+17 outside pad allowed')
  assert.strictEqual(nav.breakExclusion([], bz, 'dirt', { x: -6, z: -6 }, never), 100, 'x1-6 within pad forbidden')
})

t('breakExclusion: null pos tolerated (=> 0)', () => {
  assert.strictEqual(nav.breakExclusion([{ x: 0, z: 0 }], null, 'dirt', null, never), 0)
})

// ---- case 4: the row-19 registry gate for scaffold materials --------------------------------
t('row-19: cobble with a registry hit => 0; same pos without => 100; expired => 100', () => {
  const pos = { x: 100, z: 100 } // far from any anchor
  const anchors = [{ x: 1000, z: 1000 }]
  const hit = (p) => p.x === 100 && p.z === 100 // registry proves we placed it here
  assert.strictEqual(nav.breakExclusion(anchors, null, 'cobblestone', pos, hit), 0, 'own-tagged cobble breakable')
  assert.strictEqual(nav.breakExclusion(anchors, null, 'cobblestone', pos, never), 100, 'un-registered cobble refused')
  // expired entry is modelled by isScaffold returning false (scaffold.js age-out at :74-77)
  assert.strictEqual(nav.breakExclusion(anchors, null, 'cobblestone', pos, () => false), 100, 'expired cobble refused')
  // cobbled_deepslate behaves identically
  assert.strictEqual(nav.breakExclusion(anchors, null, 'cobbled_deepslate', pos, hit), 0)
  assert.strictEqual(nav.breakExclusion(anchors, null, 'cobbled_deepslate', pos, never), 100)
})

t('row-19: natural dirt is terrain (0 away from anchors even with NO registry hit) but 100 within 16b', () => {
  assert.strictEqual(nav.breakExclusion([{ x: 1000, z: 1000 }], null, 'dirt', { x: 0, z: 0 }, never), 0, 'far dirt is terrain, breakable')
  assert.strictEqual(nav.breakExclusion([{ x: 10, z: 0 }], null, 'dirt', { x: 0, z: 0 }, never), 100, 'dirt within 16b of anchor forbidden')
})

t('row-19: a registry hit does NOT rescue cobble sitting inside the 16b infra ring', () => {
  // positional layer (a) is checked FIRST and is type-independent - own scaffold near home
  // still can not be planner-dug (the wild profile never operates there anyway, layer 3).
  assert.strictEqual(nav.breakExclusion([{ x: 5, z: 0 }], null, 'cobblestone', { x: 0, z: 0 }, () => true), 100)
})

// ---- case 5: wildAllowedAt scope gate (WILD_SCOPE_RADIUS boundary) --------------------------
t('wildAllowedAt: 31b from an anchor => false, 33b => true', () => {
  assert.strictEqual(nav.wildAllowedAt([{ x: 31, z: 0 }], null, { x: 0, z: 0 }), false, '31b: inside scope, safe profile')
  assert.strictEqual(nav.wildAllowedAt([{ x: 33, z: 0 }], null, { x: 0, z: 0 }), true, '33b: outside scope, wild allowed')
})

t('wildAllowedAt: null buildZone tolerated; empty anchors => allowed; buildZone+32 pad blocks', () => {
  assert.strictEqual(nav.wildAllowedAt([], null, { x: 0, z: 0 }), true, 'no anchors, no zone => allowed')
  assert.strictEqual(nav.wildAllowedAt(null, null, { x: 0, z: 0 }), true, 'null anchors tolerated')
  assert.strictEqual(nav.wildAllowedAt([], { x1: 0, x2: 10, z1: 0, z2: 10 }, { x: 40, z: 5 }), false, 'inside buildZone+32 => safe')
  assert.strictEqual(nav.wildAllowedAt([], { x1: 0, x2: 10, z1: 0, z2: 10 }, { x: 43, z: 5 }), true, 'outside buildZone+32 => wild')
  assert.strictEqual(nav.wildAllowedAt([{ x: 0, z: 0 }], null, null), false, 'null pos => not allowed')
})

// ---- constants sanity (operator-fixed) ------------------------------------------------------
t('constants: digCost>=20, radii 16/32, liquidCost 4', () => {
  assert(nav.WILD_DIG_COST >= 20, 'digCost >= 20')
  assert.strictEqual(nav.INFRA_BREAK_RADIUS, 16)
  assert.strictEqual(nav.WILD_SCOPE_RADIUS, 32)
  assert.strictEqual(nav.WILD_LIQUID_COST, 4)
})

// ---- NAV Phase B: hazardExclusion (lava / lava-adjacent step cost) ---------------------------
// A block-name sampler over an explicit lava-cell set: sampleName(x,y,z) -> name|null.
const lavaAt = (...cells) => {
  const set = new Set(cells.map(c => c.x + ',' + c.y + ',' + c.z))
  return (x, y, z) => set.has(x + ',' + y + ',' + z) ? 'lava' : 'stone'
}
t('hazardExclusion: standing IN lava => HAZARD_STEP_COST', () => {
  const s = lavaAt({ x: 5, y: 40, z: 5 })
  assert.strictEqual(nav.hazardExclusion({ x: 5, y: 40, z: 5 }, s), nav.HAZARD_STEP_COST)
})
t('hazardExclusion: lava one block BELOW the standing cell (support) => cost', () => {
  const s = lavaAt({ x: 5, y: 39, z: 5 })
  assert.strictEqual(nav.hazardExclusion({ x: 5, y: 40, z: 5 }, s), nav.HAZARD_STEP_COST)
})
t('hazardExclusion: lava in a horizontal neighbour (pool edge) => cost', () => {
  const s = lavaAt({ x: 6, y: 40, z: 5 })
  assert.strictEqual(nav.hazardExclusion({ x: 5, y: 40, z: 5 }, s), nav.HAZARD_STEP_COST)
})
t('hazardExclusion: lava diagonally-below a horizontal neighbour (pool edge you stand beside) => cost', () => {
  const s = lavaAt({ x: 4, y: 39, z: 5 })
  assert.strictEqual(nav.hazardExclusion({ x: 5, y: 40, z: 5 }, s), nav.HAZARD_STEP_COST)
})
t('hazardExclusion: flowing_lava is a hazard name', () => {
  const s = (x, y, z) => (x === 5 && y === 40 && z === 5) ? 'flowing_lava' : 'air'
  assert.strictEqual(nav.hazardExclusion({ x: 5, y: 40, z: 5 }, s), nav.HAZARD_STEP_COST)
})
t('hazardExclusion: no lava anywhere near => 0; water is NOT a lava hazard (priced by liquidCost)', () => {
  assert.strictEqual(nav.hazardExclusion({ x: 5, y: 40, z: 5 }, () => 'stone'), 0)
  assert.strictEqual(nav.hazardExclusion({ x: 5, y: 40, z: 5 }, () => 'water'), 0)
})
t('hazardExclusion: lava 2b away (outside the sampled neighbourhood) => 0 (cost-local, not a map)', () => {
  const s = lavaAt({ x: 7, y: 40, z: 5 }, { x: 5, y: 42, z: 5 })
  assert.strictEqual(nav.hazardExclusion({ x: 5, y: 40, z: 5 }, s), 0)
})
t('hazardExclusion: null pos / non-fn sampler tolerated => 0; HAZARD_STEP_COST is high but sub-forbid (<100)', () => {
  assert.strictEqual(nav.hazardExclusion(null, () => 'lava'), 0)
  assert.strictEqual(nav.hazardExclusion({ x: 0, y: 0, z: 0 }, null), 0)
  assert(nav.HAZARD_STEP_COST > 0 && nav.HAZARD_STEP_COST < 100, 'cost routes around but never forbids the sole path')
})

// ---- WATER_SAFE (task #45): deepWaterHazard (DEEP vs SHALLOW step cost) ----------------------
// A block-name sampler over an explicit water-cell set; everything else is the given floor name.
const waterAt = (floorName, ...cells) => {
  const set = new Set(cells.map(c => c.x + ',' + c.y + ',' + c.z))
  return (x, y, z) => set.has(x + ',' + y + ',' + z) ? 'water' : floorName
}
const FEET = { x: 5, y: 40, z: 5 }
t('deepWaterHazard: feet water + HEAD water (2-deep, submerged) => WATER_STEP_COST', () => {
  const s = waterAt('stone', { x: 5, y: 40, z: 5 }, { x: 5, y: 41, z: 5 })
  assert.strictEqual(nav.deepWaterHazard(FEET, s), nav.WATER_STEP_COST)
})
t('deepWaterHazard: feet water + water BELOW (no floor, over-the-head) => WATER_STEP_COST', () => {
  const s = waterAt('air', { x: 5, y: 40, z: 5 }, { x: 5, y: 39, z: 5 }) // head air, but nothing to stand on
  assert.strictEqual(nav.deepWaterHazard(FEET, s), nav.WATER_STEP_COST)
})
t('deepWaterHazard: 1-deep SHALLOW (feet water, head AIR, solid floor below) => 0 (farm/fishing crossing stays free)', () => {
  const s = waterAt('stone', { x: 5, y: 40, z: 5 }) // only the feet cell is water; head=stone-name->but head is air here
  // make head explicitly air and floor solid:
  const s2 = (x, y, z) => (x === 5 && y === 40 && z === 5) ? 'water' : (y === 39 ? 'stone' : 'air')
  assert.strictEqual(nav.deepWaterHazard(FEET, s2), 0)
  assert.strictEqual(nav.deepWaterHazard(FEET, s), 0) // stone head/floor also -> not submerged, walkable
})
t('deepWaterHazard: DRY cell (feet not water) => 0, even beside deep water (bank/fishing spot stays free)', () => {
  // deep water one block over (x=6), but we stand on the dry bank at x=5 -> NOT surcharged
  const s = (x, y, z) => (x === 6) ? 'water' : (y <= 39 ? 'stone' : 'air')
  assert.strictEqual(nav.deepWaterHazard(FEET, s), 0)
})
t('deepWaterHazard: flowing_water / bubble_column count as submerging liquids', () => {
  const flow = (x, y, z) => (x === 5 && z === 5 && (y === 40 || y === 41)) ? 'flowing_water' : 'stone'
  assert.strictEqual(nav.deepWaterHazard(FEET, flow), nav.WATER_STEP_COST)
  const bub = (x, y, z) => (x === 5 && z === 5 && (y === 40 || y === 41)) ? 'bubble_column' : 'stone'
  assert.strictEqual(nav.deepWaterHazard(FEET, bub), nav.WATER_STEP_COST)
})
t('deepWaterHazard: null pos / non-fn sampler tolerated => 0; WATER_STEP_COST is sub-forbid (<100) and > liquidCost', () => {
  assert.strictEqual(nav.deepWaterHazard(null, () => 'water'), 0)
  assert.strictEqual(nav.deepWaterHazard(FEET, null), 0)
  assert(nav.WATER_STEP_COST > nav.WILD_LIQUID_COST, 'deep water costs more than a shallow crossing')
  assert(nav.WATER_STEP_COST > 0 && nav.WATER_STEP_COST < 100, 'routes around deep water but never noPath (can still reach the river-farm)')
})

// ---- WATER_ESCAPE (task #48): findDryLandExit (nearest REACHABLE-DRY-LAND finder) --------------
// A block-name sampler over an explicit map: `set` maps "x,y,z" -> name; anything unlisted is air.
// The bot's feet cell is water (treading). Cells are integer; the fill is 6-connected over WATER.
const mkSampler = (map) => (x, y, z) => (map[x + ',' + y + ',' + z] || 'air')
const put = (map, name, ...cells) => { for (const c of cells) map[c[0] + ',' + c[1] + ',' + c[2]] = name }
// Build a simple straight water channel along +z at y=40 (feet), depth 1 with a solid floor at y=39,
// air above at y=41. Bot at (0,40,0). Helper adds `len` water cells from z=z0..z0+len-1.
const channel = (map, x, z0, len, floorName = 'stone') => {
  for (let i = 0; i < len; i++) { put(map, 'water', [x, 40, z0 + i]); put(map, floorName, [x, 39, z0 + i]) }
}

t('findDryLandExit: null/!fn tolerated; not-in-water (no water at feet) => null', () => {
  assert.strictEqual(nav.findDryLandExit(null, () => 'water'), null)
  assert.strictEqual(nav.findDryLandExit({ x: 0, y: 40, z: 0 }, null), null)
  // dry cell, no water anywhere -> nothing to escape
  assert.strictEqual(nav.findDryLandExit({ x: 0, y: 40, z: 0 }, () => 'stone'), null)
})

t('findDryLandExit: open pond, DRY banks both sides -> goalDir NORTH picks the north cell even though south is nearer (a)', () => {
  const map = {}
  // water column at x=0: bot at z=0; a near SOUTH bank 2 cells at z=-1 (dist 1 from a z=0-adjacent water),
  // and a farther NORTH bank at z=+5. Both are level dry stand cells (floor stone at y=39, air at 40/41).
  put(map, 'water', [0, 40, 0])            // bot feet cell
  // south water then a dry bank cell just south (nearer)
  put(map, 'water', [0, 40, -1]); put(map, 'stone', [0, 39, -1])
  put(map, 'stone', [0, 39, -2])           // south DRY bank stand cell (0,40,-2): floor stone, feet/head air
  // north channel then a dry bank cell farther north
  for (let z = 1; z <= 4; z++) { put(map, 'water', [0, 40, z]); put(map, 'stone', [0, 39, z]) }
  put(map, 'stone', [0, 39, 5])            // north DRY bank stand cell (0,40,5) - FARTHER
  const s = mkSampler(map)
  const north = nav.findDryLandExit({ x: 0, y: 40, z: 0 }, s, { goalDir: { x: 0, z: 1 } })
  assert(north, 'a reachable dry exit exists')
  assert.strictEqual(north.z, 5, 'goalDir north => picks the north bank (z=5) despite the nearer south bank at z=-2')
  // no goalDir => nearest wins (south, z=-2)
  const nearest = nav.findDryLandExit({ x: 0, y: 40, z: 0 }, s, {})
  assert.strictEqual(nearest.z, -2, 'no goalDir => the nearer south bank')
})

t('findDryLandExit: bank WALLED off by terrain between bot and cell => null (flood-fill blocked) (b)', () => {
  const map = {}
  put(map, 'water', [0, 40, 0])            // bot feet cell (isolated pocket)
  put(map, 'stone', [0, 39, 0])
  // a solid wall at z=1 (both the water level and the floor) seals the pocket
  put(map, 'stone', [0, 40, 1]); put(map, 'stone', [0, 41, 1]); put(map, 'stone', [0, 39, 1])
  // a perfectly good DRY bank sits BEYOND the wall at z=2 - unreachable through the solid wall
  put(map, 'water', [0, 40, 2]); put(map, 'stone', [0, 39, 2]); put(map, 'stone', [0, 39, 3])
  const s = mkSampler(map)
  // the only surface water is the bot cell; its z+1 neighbour is stone (wall), not a dry stand cell,
  // and the fill cannot cross the wall to reach the z=3 bank => null.
  assert.strictEqual(nav.findDryLandExit({ x: 0, y: 40, z: 0 }, s, { goalDir: { x: 0, z: 1 } }), null)
})

t('findDryLandExit: 1-deep SHELF (adjacent cell feet=WATER) is NOT a dry exit => null (c)', () => {
  const map = {}
  channel(map, 0, 0, 1)                     // bot at (0,40,0), water over stone
  // neighbour at z=1 is a 1-deep shelf: floor stone at y=39 but the FEET cell (y=40) is WATER, head air
  put(map, 'water', [0, 40, 1]); put(map, 'stone', [0, 39, 1])
  // and z=2 is deeper water with a water floor (no dry land anywhere)
  put(map, 'water', [0, 40, 2]); put(map, 'water', [0, 39, 2])
  const s = mkSampler(map)
  assert.strictEqual(nav.findDryLandExit({ x: 0, y: 40, z: 0 }, s, { goalDir: { x: 0, z: 1 } }), null,
    'a surf shelf (feet still water) must be rejected - no declaring victory in the water')
})

t('findDryLandExit: unclimbable 2-b lip with no other exit => null (d); a reachable +1 lip => returned (e)', () => {
  // (d) 2-block lip: the bank floor top is at y=41 (stand cell would be y=42 = surface+2), too high.
  const d = {}
  put(d, 'water', [0, 40, 0]); put(d, 'stone', [0, 39, 0]) // bot cell (surface: y=41 is air)
  // neighbour column z=1: solid up through y=41 (a 2-high wall), so the only stand cell is y=42.
  put(d, 'stone', [0, 39, 1]); put(d, 'stone', [0, 40, 1]); put(d, 'stone', [0, 41, 1])
  // (y=42/43 are air) - stand cell (0,42,1) would need Δy=+2 from the surface water at y=40 => skipped
  const sd = mkSampler(d)
  assert.strictEqual(nav.findDryLandExit({ x: 0, y: 40, z: 0 }, sd, { goalDir: { x: 0, z: 1 } }), null,
    'a 2-b lip is unclimbable (Δy>+1) and there is no other exit => null')

  // (e) +1 lip: bank floor top at y=40, stand cell at y=41 (surface+1) - reachable.
  const e = {}
  put(e, 'water', [0, 40, 0]); put(e, 'stone', [0, 39, 0]) // bot cell, surface at y=40 (y=41 air)
  put(e, 'stone', [0, 40, 1])                              // neighbour floor block one UP => stand on top at y=41
  // (0,41,1) feet air, (0,42,1) head air by default
  const se = mkSampler(e)
  const exit = nav.findDryLandExit({ x: 0, y: 40, z: 0 }, se, { goalDir: { x: 0, z: 1 } })
  assert(exit, 'a +1 lip is climbable and must be returned')
  assert.deepStrictEqual({ x: exit.x, y: exit.y, z: exit.z }, { x: 0, y: 41, z: 1 }, 'the returned exit is the +1 lip stand cell')
})

t('findDryLandExit: opts.solidAt (real boundingBox) overrides the name heuristic for the floor test', () => {
  const map = {}
  channel(map, 0, 0, 1)                     // bot at (0,40,0)
  put(map, 'oak_leaves', [0, 39, 1])        // neighbour "floor" is LEAVES (not a full solid block)
  // by name heuristic leaves are non-solid -> rejected; assert solidAt=false path also rejects it
  const s = mkSampler(map)
  const solidFalse = () => false
  assert.strictEqual(nav.findDryLandExit({ x: 0, y: 40, z: 0 }, s, { solidAt: solidFalse }), null,
    'solidAt=false => no floor qualifies => null')
})

console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nALL PASS')
process.exit(failures ? 1 : 0)
