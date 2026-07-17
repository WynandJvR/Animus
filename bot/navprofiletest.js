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

console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nALL PASS')
process.exit(failures ? 1 : 0)
