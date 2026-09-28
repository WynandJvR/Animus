'use strict'
// Survival schematic builder. The world is the progress record: a cell is done when the block there IS
// the schematic block - material AND the state that makes its look (a stair's facing and half, a slab's
// type, a log's axis, a wall torch's facing, a hanging lantern) - so a restart, a death, a creeper or a
// griefer never confuses the count. Nothing about the build is latched: complete() is re-derived from
// the world every time it is asked (a "done" latch left a creeper hole in a finished castle for good).
// Order: clear what doesn't belong (top-down), then place bottom-up, nearest first; attached things
// (torches, lanterns, ladders, carpets, doors) once what they hang on stands.
// Scaffold is a DIFF against the site as it was before any work (a snapshot on disk), not a list of
// remembered placements: the planner's own towers and bridges were never recorded, and 467 filler blocks
// were left round a "finished" castle.
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const base = () => require('./base')

const SCAFFOLD_RE = /^(dirt|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|coarse_dirt)$/
// (granite is not filler: the basilica's brick course is polished granite, and scaffold spends it by the stack)
// (cobblestone too: "no filler for a temporary support" with 250 of it in the pack, 2026-09-27; what is left of it in
//  the footprint comes down with the site clearing)
const FILLER_ITEMS = /^(dirt|andesite|diorite|tuff|cobbled_deepslate|netherrack|coarse_dirt|cobblestone)$/
// what the bot leaves standing about: placeSupport/pathfinder filler (+rooted_dirt, the planner's list), and
// the reflexes' plugs (cobblestone, stone, sand, gravel)
const STRAY_RE = /^(dirt|coarse_dirt|rooted_dirt|cobblestone|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|stone|sand|gravel)$/
// our furniture and lights are never scaffold, wherever they stand
// a lantern of any metal - never a jack o'lantern (a pumpkin: a full block, glowstone's stand-in - it was taken for a
// hanging lantern, attached and never anchoring; audit #11)
const LANTERN_RE = world.LANTERN_RE // (world.js: the one rule)
const FURNITURE_RE = world.FURNITURE_RE
const SITE_PAD = 6 // the snapshot / scaffold region: the footprint +6 in x/z, y1-2 .. y2+6

let job = null // { name, origin, cells: [cell], box, index: Map key->cell }

// ---- materials ------------------------------------------------------------------------------------
// The operator chose local wood (2026-09-15: a birch forest, oak scarce, no spruce): a wood cell takes the
// same FORM in any species - planks for planks, stairs for stairs - the blueprint's own species first when
// we hold it. Stone forms stay exact (cobblestone_stairs is cobblestone_stairs).
const LOCAL_WOOD = true
const WOODS = 'oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped'
const LOG_ANY = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/
const PLANKS_ANY = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_planks$/
const WOOD_FORM_RE = new RegExp(`^(${WOODS})_(planks|log|stairs|slab|fence|fence_gate|door|trapdoor|pressure_plate|button)$`)
// grass needs silk touch to carry; dirt under open sky turns to grass by itself (and grass under a block
// turns to dirt): either satisfies either
const GROUND_ALT = /^(dirt|grass_block)$/
const woodAlts = {}
// ...unless the job wants the blueprint's own species (the castle, 2026-09-27: "if it needs a certain wood it can go and
// get it") - then a wood cell is its exact block, like stone
let woodExact = true // (set by setJob before its cells are described)
function exactWood () { return woodExact }
function woodForm (name) { const m = LOCAL_WOOD && !exactWood() && WOOD_FORM_RE.exec(name); return m ? m[2] : null }
function woodAlt (form) { return form === 'log' ? LOG_ANY : (woodAlts[form] || (woodAlts[form] = new RegExp(`^(${WOODS})_${form}$`))) }
// (kept for the material side: truthy for every wood form - 'log', 'planks', 'stairs', ...)
function woodClass (name) { return woodForm(name) }
// The items that may stand in for `itemName` when placing (the material side counts stock with it).
// null = only the item itself.
function acceptsFor (itemName) {
  if (itemName === 'dirt' || itemName === 'grass_block') return GROUND_ALT
  const f = woodForm(itemName)
  if (f) return woodAlt(f)
  // aged/waxed copper is placed plain (it ages in place), stripped wood of any species (materials.js makes them so)
  const m = require('./materials')
  return m.copperAlt(itemName) || (exactWood() ? null : m.woodFamilyAlt(itemName)) || null
}

// ---- cells ----------------------------------------------------------------------------------------
// The props that define a block's look and that the PLACING decides - so they are what "done" means. Everything the
// world derives by itself never makes a block wrong: connections (a wall's/fence's/pane's north..up, a stair's shape, a
// rail's), waterlogged, powered, lit (a campfire comes lit), occupied, has_book, note, a composter's level, a door's
// hinge, a leaf's distance, a chest's pairing (type: both halves placed facing the same way pair by themselves - a
// chest dug out over "type=single" would have been dug out for ever). open counts only where the builder opens it by
// hand (trapdoors, gates); level only where a bucket makes it (a filled cauldron, a liquid's source).
const COUNT_PROPS = ['candles', 'pickles', 'layers', 'flower_amount', 'segment_amount']
const KEY_PROPS = ['facing', 'half', 'type', 'axis', 'hanging', 'face', 'rotation', 'part', 'open', 'level', 'persistent'].concat(COUNT_PROPS)
const DIRS = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
const CCW = { east: 'north', south: 'east', west: 'south', north: 'west' }
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const ALL_FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
const dirOf = v => Object.keys(DIRS).find(k => DIRS[k].every((x, i) => x === v[i]))
// mineflayer yaw: 0 looks north (-z), PI/2 west (-x), PI south, -PI/2 east (lookAt: yaw = atan2(-dx, -dz)); pitch > 0 up
function yawOf (facing) { const d = DIRS[facing]; return d && !d[1] ? Math.atan2(-d[0], -d[2]) : null }
function facingOfYaw (yaw) {
  const dx = -Math.sin(yaw); const dz = -Math.cos(yaw)
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
}
// vanilla getNearestLookingDirection: the axis the view vector is longest along, up and down included
function lookingOf (yaw, pitch) {
  const v = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
  const i = [0, 1, 2].reduce((a, b) => (Math.abs(v[b]) > Math.abs(v[a]) ? b : a), 0)
  return dirOf(v.map((x, k) => (k === i ? Math.sign(x) : 0)))
}
// a sign's or banner's rotation 0..15 from the yaw (vanilla: segment of the player's rotation + 180), and back
function rotationOfYaw (yaw) { return String(((Math.round(-yaw * 8 / Math.PI) % 16) + 16) % 16) }
function yawOfRotation (r) { return -Number(r) * Math.PI / 8 }
// a look steep enough that up/down is the nearest looking direction (69 degrees)
const STEEP = 1.2

// HOW A BLOCK TAKES ITS FACING FROM THE PLACING - one family per vanilla getStateForPlacement rule:
// the direction the PLAYER looks (getHorizontalDirection)
const LOOK_FACING_RE = /_stairs$|_door$|_fence_gate$|_bed$|campfire$|^decorated_pot$/
// TOWARD the player, opposite the look (getHorizontalDirection().getOpposite())
const TOWARD_FACING_RE = /^(chest|trapped_chest|ender_chest|furnace|smoker|blast_furnace|loom|lectern|stonecutter|beehive|bee_nest|carved_pumpkin|jack_o_lantern|repeater|comparator|chiseled_bookshelf|big_dripleaf|pink_petals|wildflowers|leaf_litter|end_portal_frame)$|_glazed_terracotta$/
// the look turned clockwise (an anvil's long side faces the player)
const CLOCKWISE_FACING_RE = /(^|_)anvil$/
// the nearest looking direction, up and down included: observers the same way, barrels/dispensers/droppers/pistons
// toward the player (a barrel "facing up" is placed looking down)
const LOOK6_FACING_RE = /^observer$/
const TOWARD6_FACING_RE = /^(barrel|dispenser|dropper|piston|sticky_piston)$/
// the clicked face's normal, all six (a lightning rod on the underside of a beam points down)
const CLICKED_FACING_RE = /(^|_)(end_rod|lightning_rod)$|amethyst_cluster$|_amethyst_bud$|shulker_box$/
// buttons, levers, grindstones: floor/ceiling when the look is steeply down/up (facing = the look), else on the wall
// facing away from where the player looks (face + facing)
const FACE_ATTACHED_RE = /_button$|^lever$|^grindstone$/
// hung on the side of the block behind them (support = cell - facing). Ladders take the clicked face's normal; the wall
// torch/sign/banner and tripwire hook take the LOOK - the item picks the wall form only when the nearest looking
// direction is horizontal (looking down at a wall's face stands a sign on the floor), so they are placed looking
// straight at the wall
const SIDE_ATTACHED_RE = /wall_torch$|^ladder$|_wall_sign$|_wall_banner$|_wall_hanging_sign$|^tripwire_hook$/
const WALL_LOOK_RE = /wall_torch$|_wall_sign$|_wall_banner$|^tripwire_hook$/
// Trapdoors hang on nothing (vanilla lets them float - open shutters beside a sign, a button, a window): clicked on a side
// face they take that face's normal and the click's height (with the nearest neighbour clicked instead, 24 Nordic
// shutters came out facing east/west, taken out and back for ever, 2026-09-23); clicked on the top of the block below
// they are a bottom half, on the underside of the block above a top half, facing toward the player
const TRAPDOOR_RE = /_trapdoor$/
// what the placed state does not depend on the clicked face for - any solid neighbour will do once its support
// stands (a carpet on a standing sign: the sign is nothing to click)
const FACE_FREE_RE = /_carpet$|_pressure_plate$|^flower_pot$|^potted_|rail$|^redstone_wire$|^repeater$|^comparator$|candle$|^sea_pickle$|^snow$|_bed$|_door$|_mushroom$/
// a carpet stands on anything that is not air (vanilla CarpetBlock)
const ANY_SUPPORT_RE = /_carpet$/
// plants: they stand on soil (vanilla BushBlock mayPlaceOn: the dirt family; dry plants take sand and terracotta too)
const SOIL_PLANT_RE = /^(short_grass|fern|tall_grass|large_fern|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|pitcher_plant|sweet_berry_bush|pink_petals|wildflowers|bush|firefly_bush|open_eyeblossom|closed_eyeblossom|azalea|flowering_azalea|dead_bush|short_dry_grass|tall_dry_grass)$|_tulip$|_sapling$/
const SOIL_RE = /^(dirt|grass_block|podzol|coarse_dirt|mycelium|rooted_dirt|moss_block|pale_moss_block|mud|muddy_mangrove_roots|farmland)$/
const DRY_SOIL_RE = /^(dirt|grass_block|podzol|coarse_dirt|mycelium|rooted_dirt|moss_block|pale_moss_block|mud|muddy_mangrove_roots|farmland|sand|red_sand|suspicious_sand|terracotta|[a-z_]+_terracotta)$/
function soilFor (name) { return /^potted_/.test(name) || !SOIL_PLANT_RE.test(name) ? null : /^(dead_bush|short_dry_grass|tall_dry_grass)$/.test(name) ? DRY_SOIL_RE : SOIL_RE }
// stand on the block below (the standing sign/banner: its rotation form - the wall forms are side-attached above)
const BELOW_ATTACHED_RE = /^(torch|soul_torch|redstone_torch|copper_torch|flower_pot|rail|powered_rail|detector_rail|activator_rail|redstone_wire|repeater|comparator|candle|sea_pickle|snow|brown_mushroom|red_mushroom)$|_carpet$|_pressure_plate$|^potted_|_door$|_candle$|_bed$|_sign$|_banner$/
// TWO-BLOCK blocks: the second half comes with the first (a door's and a tall plant's upper half, a bed's head)
const DOUBLE_PLANT_RE = /^(tall_grass|large_fern|rose_bush|lilac|peony|sunflower|pitcher_plant|tall_dry_grass)$/
// TWO-STEP blocks: the block first, then an item used on it - a flower pot then its plant, a cauldron then a bucket
const CAULDRON_FILL = { water_cauldron: 'water_bucket', lava_cauldron: 'lava_bucket', powder_snow_cauldron: 'powder_snow_bucket' }
// blocks placed by an item of another name (vanilla: the item's block is this one)
const BLOCK_ITEM = { tripwire: 'string', redstone_wire: 'redstone', water: 'water_bucket', lava: 'lava_bucket', cocoa: 'cocoa_beans', sweet_berry_bush: 'sweet_berries', bamboo_sapling: 'bamboo', kelp_plant: 'kelp', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', wheat: 'wheat_seeds', pumpkin_stem: 'pumpkin_seeds', melon_stem: 'melon_seeds', powder_snow: 'powder_snow_bucket' }

// Does prop `k` count toward a cell of `name` being done?
function counts (name, k) {
  if (k === 'type') return /_slab$/.test(name)
  if (k === 'open') return /_trapdoor$|_fence_gate$/.test(name)
  if (k === 'level') return !!CAULDRON_FILL[name] || /^(water|lava)$/.test(name)
  if (k === 'persistent') return /_leaves$/.test(name)
  return true
}
function wantOf (c) {
  if (c.want !== undefined) return c.want
  if (!c.props) return null
  const w = {}
  for (const k of KEY_PROPS) if (c.props[k] != null && counts(c.name, k)) w[k] = String(c.props[k])
  // a placed leaf is persistent, whatever the blueprint's copy of a tree says: a natural leaf in the cell decays once its
  // log is gone, so it is not the block
  if (/_leaves$/.test(c.name)) w.persistent = 'true'
  // flowing liquid: whatever level the source gives it
  if (/^(water|lava)$/.test(c.name) && w.level !== '0') delete w.level
  return Object.keys(w).length ? w : null
}
function nameOk (c, n) { return n === c.name || !!(c.alt && c.alt.test(n)) }
// the cell holds its block, or its first step (the empty pot of a potted plant, the cauldron of a filled one)
function partOk (c, n) { return nameOk(c, n) || (!!c.base && n === c.base) }
function key (p) { return `${p.x},${p.y},${p.z}` }
// a cell of the build still wanting its block (the planner lays no stepping stone there)
function isOpenCell (p) { return !!job && job.index.has(key(p)) }

// The build's own crafted blocks standing where no cell of it wants them, in and round the site: stepping stones the
// planner laid with whatever was in hand (glass, slabs, stairs round the cathedral walls, 2026-09-26). Torches, fences
// and lanterns aside (the base's lights, old mineshafts). Async, sliced.
// Proof they are ours, not merely the castle's kinds: the snapshot says the cell was open before the work, it is not the
// base's or another job's, and never furniture (the audit: a player's blocks, or the bot's own chest by the site, would
// have been force-dug, 2026-09-27). No snapshot - no proof - nothing taken.
async function strayBuildBlocks (bot) {
  if (!job || !site) return []
  const names = [...new Set(job.cells.map(c => c.name))].filter(n => !world.NATURAL_RE.test(n) && !/(torch|lantern|fence|_door|ladder)$/.test(n))
  if (!names.length) return []
  const re = new RegExp('^(' + names.join('|') + ')$')
  const b = job.box; const pad = 3
  const mid = { x: Math.floor((b.x1 + b.x2) / 2), y: Math.floor((b.y1 + b.y2) / 2), z: Math.floor((b.z1 + b.z2) / 2) }
  const r = Math.ceil(Math.hypot(b.x2 - b.x1, b.y2 - b.y1, b.z2 - b.z1) / 2) + pad
  const found = await world.scanBlocks(bot, re, { maxDistance: r, count: 20000, point: mid })
  return found.filter(x => {
    const p = x.position
    if (p.x < b.x1 - pad || p.x > b.x2 + pad || p.z < b.z1 - pad || p.z > b.z2 + pad || p.y < b.y1 - pad || p.y > b.y2 + pad) return false
    // the one scaffold rule (isStray: snapshot was-open, not a cell, not furniture, not others' work) - no second copy
    // of it here (audit #6); a wrong block in a cell of the build is the placer's to swap, not a stray
    return isStray(bot, p.x, p.y, p.z)
  }).map(x => ({ x: x.position.x, y: x.position.y, z: x.position.z, name: x.name }))
}

// The item that places this block (null: it is never placed on its own - a door's or tall plant's upper half, a bed's
// head, flowing water all come with another cell). Grass cells are keyed as dirt: dirt is what a player without silk
// touch can carry. A two-step cell's item is its first step (the pot, the cauldron); thenItem() is the second.
function itemOf (c, md) {
  if (c.item !== undefined) return c.item
  return itemForBlock(c.name, c.props, md)
}
function itemForBlock (name, props, md) {
  if ((/_door$/.test(name) || DOUBLE_PLANT_RE.test(name)) && props && props.half === 'upper') return null
  if (/_bed$/.test(name) && props && props.part === 'head') return null
  if (/^(water|lava)$/.test(name) && props && props.level != null && String(props.level) !== '0') return null
  if (name === 'grass_block') return 'dirt'
  if (BLOCK_ITEM[name]) return BLOCK_ITEM[name]
  if (CAULDRON_FILL[name]) return 'cauldron'
  if (/^potted_/.test(name)) return 'flower_pot'
  if (!md) return name
  if (md.itemsByName[name]) return name
  const unwall = name.replace(/(^|_)wall_/, '$1') // wall_torch -> torch, soul_wall_torch -> soul_torch, oak_wall_sign -> oak_sign
  if (md.itemsByName[unwall]) return unwall
  return null
}
// The second item of a two-step cell: the plant for a pot (potted_flowering_azalea_bush -> flowering_azalea), the
// bucket for a filled cauldron. null for everything else.
function thenItem (name, md) {
  if (CAULDRON_FILL[name]) return CAULDRON_FILL[name]
  const m = /^potted_(.+)$/.exec(name)
  if (!m) return null
  if (!md || md.itemsByName[m[1]]) return m[1]
  const b = m[1].replace(/_bush$/, '')
  return md.itemsByName[b] ? b : null
}
// the block the first step of a two-step cell leaves
function baseOf (name) { return CAULDRON_FILL[name] ? 'cauldron' : /^potted_/.test(name) ? 'flower_pot' : null }

// Everything the builder needs to know about one blueprint cell, decided once when the job is set.
//   item/then: the item placed, and the item then used on it (two-step cells; base = the block the first step leaves)
//   count:     {prop, n} - the same item placed n times into the cell (candles, sea pickles, snow layers, petals)
//   follows:   comes with another cell (sup = that cell): door/tall-plant upper halves, bed heads, flowing liquid
//   twin:      the offset of the cell that comes with this one (it must be clear, and not where we stand)
//   pour:      a liquid source, poured from a bucket rather than placed
//   attach/sup/soil: what it stands or hangs on, and (plants) what that must be
function describe (cell, md) {
  const n = cell.name
  const w = wantOf(Object.assign({}, cell, { want: undefined }))
  cell.want = w
  cell.item = itemForBlock(n, cell.props, md)
  const then = thenItem(n, md)
  if (then) { cell.then = then; cell.base = baseOf(n) }
  const f = woodForm(n)
  if (f) { cell.alt = woodAlt(f); cell.prefer = [n] }
  if (n === 'grass_block' || n === 'dirt') { cell.alt = GROUND_ALT; cell.prefer = n === 'grass_block' ? ['grass_block', 'dirt'] : ['dirt'] }
  // aged/waxed copper stands in any stage (it ages in place), stripped wood in any species: done as it stands
  if (!cell.alt && !f) { const m = require('./materials'); const alt = m.copperAlt(n) || (exactWood() ? null : m.woodFamilyAlt(n)); if (alt) { cell.alt = alt; cell.prefer = [n] } }
  cell.itemAlt = cell.item ? acceptsFor(cell.item) : null
  for (const k of COUNT_PROPS) if (w && w[k] != null) cell.count = { prop: k, n: Number(w[k]) }
  if (/^(water|lava)$/.test(n)) { if (cell.item) cell.pour = true; else cell.follows = true }
  const d = w && DIRS[w.facing]
  if (/_door$/.test(n) || DOUBLE_PLANT_RE.test(n)) {
    if (w && w.half === 'upper') { cell.follows = true; cell.sup = { x: cell.x, y: cell.y - 1, z: cell.z } } else cell.twin = [0, 1, 0]
  }
  if (/_bed$/.test(n) && d) {
    if (w.part === 'head') { cell.follows = true; cell.sup = { x: cell.x - d[0], y: cell.y, z: cell.z - d[2] } } else cell.twin = d
  }
  cell.soil = soilFor(n)
  if (ANY_SUPPORT_RE.test(n)) cell.anySupport = true
  // a double slab: a slab, then a second slab onto it
  if (/_slab$/.test(n) && w && w.type === 'double') cell.count = { prop: 'type', n: 2 }
  if (!cell.follows) {
    const on = attachmentOf(n, w)
    if (on) { cell.attach = on[0]; cell.sup = { x: cell.x + on[1][0], y: cell.y + on[1][1], z: cell.z + on[1][2] } }
  }
  return cell
}

// What a cell stands or hangs on: ['side'|'above'|'below', offset of the support], or null.
function attachmentOf (n, w) {
  const d = w && DIRS[w.facing]
  if (SIDE_ATTACHED_RE.test(n) && d) return ['side', [-d[0], 0, -d[2]]]
  if (LANTERN_RE.test(n)) return w && w.hanging === 'true' ? ['above', [0, 1, 0]] : ['below', [0, -1, 0]]
  // (a grindstone needs nothing to hang on - vanilla lets it float - and takes its state from the look alone)
  if (FACE_ATTACHED_RE.test(n) && n !== 'grindstone' && w) {
    if (w.face === 'wall') return d ? ['side', [-d[0], 0, -d[2]]] : null
    return w.face === 'ceiling' ? ['above', [0, 1, 0]] : ['below', [0, -1, 0]]
  }
  if (/_hanging_sign$/.test(n)) return ['above', [0, 1, 0]]
  if (BELOW_ATTACHED_RE.test(n) || soilFor(n) || DOUBLE_PLANT_RE.test(n)) return ['below', [0, -1, 0]]
  return null
}

// The look a cell is placed with - {yaw, pitch} (either may be missing: then the cursor decides it) - by its family.
function lookFor (c, w) {
  const f = w.facing
  if (w.rotation != null) return { yaw: yawOfRotation(w.rotation), pitch: /_hanging_sign$/.test(c.name) ? STEEP : -STEEP }
  if (!f) return LANTERN_RE.test(c.name) && w.hanging ? { pitch: w.hanging === 'true' ? STEEP : -STEEP } : null
  const flat = DIRS[f] && !DIRS[f][1]
  if (FACE_ATTACHED_RE.test(c.name)) {
    if (w.face === 'floor') return { yaw: yawOf(f), pitch: -STEEP }
    if (w.face === 'ceiling') return { yaw: yawOf(f), pitch: STEEP }
    return { yaw: yawOf(OPP[f]), pitch: 0 }
  }
  if (WALL_LOOK_RE.test(c.name) && flat) return { yaw: yawOf(OPP[f]), pitch: 0 }
  if (TRAPDOOR_RE.test(c.name) && flat) return { yaw: yawOf(OPP[f]) }
  if (LOOK_FACING_RE.test(c.name) && flat) return { yaw: yawOf(f) }
  if (TOWARD_FACING_RE.test(c.name) && flat) return { yaw: yawOf(OPP[f]) }
  if (CLOCKWISE_FACING_RE.test(c.name) && flat) return { yaw: yawOf(CCW[f]) }
  if (LOOK6_FACING_RE.test(c.name) || TOWARD6_FACING_RE.test(c.name)) {
    const look = LOOK6_FACING_RE.test(c.name) ? f : OPP[f]
    return flat ? { yaw: yawOf(look), pitch: 0 } : { pitch: look === 'up' ? STEEP : -STEEP }
  }
  return null
}

// How a cell can be placed, best first: which neighbour to click (off), how high up a side face (cy), and
// the look while clicking (yaw, pitch). Pure: the world decides later which of these are possible.
//   stairs/slabs: top half = click the underside of the block above, or high on a side face; bottom half =
//     the top of the block below, or low on a side face.
//   attached things: the block they hang on / stand on. Rods: the block behind (facing = the clicked face).
//   hoppers: the block they point into. Logs, chains: a face on their own axis.
function plansFor (c) {
  if (c.follows) return []
  const w = wantOf(c) || {}
  const look = lookFor(c, w)
  const withYaw = p => (look ? Object.assign(p, look) : p)
  if (TRAPDOOR_RE.test(c.name) && DIRS[w.facing] && w.half) {
    const d = DIRS[w.facing]
    return [{ off: [-d[0], 0, -d[2]], cy: w.half === 'top' ? 0.75 : 0.25 }, withYaw({ off: w.half === 'top' ? [0, 1, 0] : [0, -1, 0] })]
  }
  if (c.attach && c.sup) {
    const first = withYaw({ off: [c.sup.x - c.x, c.sup.y - c.y, c.sup.z - c.z] })
    return [first].concat(FACE_FREE_RE.test(c.name) ? ALL_FACES.filter(o => !o.every((v, i) => v === first.off[i])).map(off => withYaw({ off })) : [])
  }
  if (CLICKED_FACING_RE.test(c.name) && DIRS[w.facing]) return [withYaw({ off: DIRS[w.facing].map(v => -v) })]
  if (c.name === 'hopper' && DIRS[w.facing]) return w.facing === 'down' ? [{ off: [0, -1, 0] }, { off: [0, 1, 0] }] : [{ off: DIRS[w.facing].slice() }]
  if (w.axis && !axisRelaxed(c) && failsOf(c) < 3) {
    if (w.axis === 'x') return [{ off: [1, 0, 0] }, { off: [-1, 0, 0] }]
    if (w.axis === 'z') return [{ off: [0, 0, 1] }, { off: [0, 0, -1] }]
    if (w.axis === 'y') return [{ off: [0, -1, 0] }, { off: [0, 1, 0] }]
  }
  const half = w.half === 'top' || w.half === 'bottom' ? w.half : (w.type === 'top' || w.type === 'bottom' ? w.type : null)
  if (half === 'top') return [withYaw({ off: [0, 1, 0] })].concat(SIDES.map(s => withYaw({ off: s, cy: 0.75 })))
  if (half === 'bottom') return [withYaw({ off: [0, -1, 0] })].concat(SIDES.map(s => withYaw({ off: s, cy: 0.25 })))
  return ALL_FACES.map(off => withYaw({ off }))
}
// What placing along `plan` makes, by the vanilla rules - the cell as the builder leaves it (every step done: a
// potted plant's plant in its pot, all of a cell's candles) - for checking the rules offline, and for the log.
function predict (c, plan, playerYaw, playerPitch) {
  const face = plan.off.map(v => -v) // the clicked face's normal
  const faceDir = dirOf(face)
  const out = {}
  const w = wantOf(c) || {}
  const n = c.name
  const clickY = face[1] === 1 ? 1 : face[1] === -1 ? 0 : (plan.cy != null ? plan.cy : 0.5)
  if (/_stairs$|_slab$|_trapdoor$/.test(n)) {
    const top = face[1] === -1 || (face[1] === 0 && clickY > 0.5)
    if (/_slab$/.test(n)) out.type = w.type === 'double' ? 'double' : top ? 'top' : 'bottom'; else out.half = top ? 'top' : 'bottom'
  }
  if (w.open != null) out.open = w.open // (opened by hand after the placing - placeCell)
  const yaw = plan.yaw != null ? plan.yaw : playerYaw
  const pitch = plan.pitch != null ? plan.pitch : (playerPitch != null ? playerPitch : null)
  const look = yaw != null ? facingOfYaw(yaw) : null
  const look6 = yaw != null || pitch != null ? lookingOf(yaw != null ? yaw : 0, pitch != null ? pitch : 0) : null
  if (LOOK_FACING_RE.test(n) && look) out.facing = look
  if (TOWARD_FACING_RE.test(n) && look) out.facing = OPP[look]
  if (CLOCKWISE_FACING_RE.test(n) && look) out.facing = CW[look]
  if (LOOK6_FACING_RE.test(n) && look6) out.facing = look6
  if (TOWARD6_FACING_RE.test(n) && look6) out.facing = OPP[look6]
  if (CLICKED_FACING_RE.test(n)) out.facing = faceDir
  if (n === 'hopper') out.facing = face[1] ? 'down' : OPP[faceDir]
  if (TRAPDOOR_RE.test(n)) out.facing = face[1] ? (look ? OPP[look] : undefined) : faceDir
  if (SIDE_ATTACHED_RE.test(n)) out.facing = WALL_LOOK_RE.test(n) ? (look6 && !DIRS[look6][1] ? OPP[look6] : undefined) : faceDir
  if (FACE_ATTACHED_RE.test(n) && look6) {
    if (DIRS[look6][1]) { out.face = look6 === 'up' ? 'ceiling' : 'floor'; out.facing = look } else { out.face = 'wall'; out.facing = OPP[look6] }
  }
  if (w.rotation != null && yaw != null) out.rotation = rotationOfYaw(yaw)
  if (LANTERN_RE.test(n)) out.hanging = pitch != null ? String(pitch > 0) : (face[1] === -1 ? 'true' : 'false')
  if (w.axis) out.axis = face[0] ? 'x' : face[1] ? 'y' : 'z'
  if (/_door$/.test(n) || DOUBLE_PLANT_RE.test(n)) out.half = 'lower'
  if (/_bed$/.test(n)) out.part = 'foot'
  for (const k of COUNT_PROPS) if (w[k] != null) out[k] = w[k] // (one more per use on it, up to the blueprint's - placeCell)
  if (CAULDRON_FILL[n]) out.level = '3' // (a bucket fills it)
  if (/^(water|lava)$/.test(n)) out.level = '0' // (a bucket pours a source)
  if (/_leaves$/.test(n)) out.persistent = 'true'
  return out
}
// The state (props compared) of a block as it stands.
function propsOf (b) { try { return b.getProperties() || {} } catch { return {} } }
// How many of a multi-count cell's items stand in block `b` (a double slab is two slabs)
function amountOf (c, b) { const v = propsOf(b)[c.count.prop]; return c.count.prop === 'type' ? (v === 'double' ? 2 : 1) : Number(v) }
// Where a cell with more than one step stands: 'then' = its pot/cauldron is in, the plant/bucket goes on it; 'more' = the
// right block, rightly set, with fewer candles/pickles/layers than the blueprint's. null = a first placing (or a wrong block).
function stepOf (c, b) {
  if (!b) return null
  if (c.base && b.name === c.base) return 'then'
  if (!c.count || !nameOk(c, b.name)) return null
  const p = propsOf(b); const w = wantOf(c) || {}
  if (!(amountOf(c, b) < c.count.n)) return null
  for (const k in w) if (k !== c.count.prop && p[k] != null && String(p[k]) !== w[k]) return null
  return 'more'
}
// The item the cell's next step takes, as the world stands.
function stepItem (bot, c) { const b = world.at(bot, c.x, c.y, c.z); return stepOf(c, b) === 'then' ? c.then : itemOf(c, world.data(bot)) }
// A chest that pairs with its neighbour: placed without sneaking (a sneaking placement never pairs)
function pairs (c) { return /chest$/.test(c.name) && c.props && c.props.type != null && String(c.props.type) !== 'single' }

// any blueprint format, with the never-obtainable blocks swapped or skipped (blueprint.js)
async function loadSchematic (name, version) {
  return require('./blueprint').load(name, version, { log })
}

async function setJob (bot, name, origin, { exactWood: exact = true } = {}) {
  // (loaded first: a load that throws leaves the running job and its wood rule as they were - audit #35)
  const s = await loadSchematic(name, bot.version)
  woodExact = exact !== false
  try { require('./materials').resetPlanner() } catch {}
  // a different job (or the same one somewhere else) starts with no memory of the old one's hard cells: the castle on
  // the cathedral's ground inherited its rest counts and relaxed log axes by coordinate (audit #9, 2026-09-27)
  const prev = mem.get().build
  if (!prev || prev.name !== name || !prev.origin || prev.origin.x !== origin.x || prev.origin.y !== origin.y || prev.origin.z !== origin.z) {
    cellFails.clear(); mem.update(m => { m.cellFails = {}; m.axisRelaxed = [] }); statusGen++
  }
  const md = world.data(bot)
  const st = s.start(); const en = s.end()
  const cells = []
  for (let y = st.y; y <= en.y; y++) {
    await new Promise(r => setImmediate(r)) // (a layer at a time: the body's ticks go on between them)
    for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const b = s.getBlock(new Vec3(x, y, z))
    if (!b || b.name === 'air') continue
    cells.push(describe({ x: origin.x + x - st.x, y: origin.y + y - st.y, z: origin.z + z - st.z, name: b.name, props: b.getProperties() }, md))
    }
  }
  const box = { x1: origin.x, y1: origin.y, z1: origin.z, x2: origin.x + en.x - st.x, y2: origin.y + en.y - st.y, z2: origin.z + en.z - st.z }
  job = { name, origin, cells, box, index: new Map(cells.map(c => [key(c), c])), exactWood: exact }
  surveyCache = null
  mem.set('build', { name, origin, exactWood: woodExact })
  move.setZone('build', { x1: box.x1 - 1, y1: box.y1 - 1, z1: box.z1 - 1, x2: box.x2 + 1, y2: box.y2 + 3, z2: box.z2 + 1 })
  log('build', `job "${name}" at ${move.fmt(origin)}: ${cells.length} blocks, box ${box.x1}..${box.x2} ${box.y1}..${box.y2} ${box.z1}..${box.z2}`)
  site = loadSite(job)
  if (!site) ensureSnapshot(bot) // at once when the chunks are here; else before any work starts
  return job
}

function cellDone (bot, c) {
  const b = world.at(bot, c.x, c.y, c.z)
  if (!b) return null // unloaded = unknown
  if (c.clear) return world.isAirish(b) || /(_bed|^chest|^furnace|^crafting_table|^barrel|torch|lantern|_carpet)$/.test(b.name)
  if (!nameOk(c, b.name)) return false
  const w = wantOf(c)
  if (!w) return true
  let p
  try { p = b.getProperties() } catch { return true }
  for (const k in w) {
    if (k === 'axis' && axisRelaxed(c)) continue
    if (p[k] != null && String(p[k]) !== w[k]) return false
  }
  return true
}
// Logs that could not be placed with the blueprint's axis (no block on that side to click, too high for a
// support pillar from the ground) go in with whatever axis works - remembered, so they count as done.
function axisRelaxed (c) { return ((mem.get().axisRelaxed || []).includes(key(c))) }
function relaxAxis (c) { mem.update(m => { m.axisRelaxed = m.axisRelaxed || []; if (!m.axisRelaxed.includes(key(c))) m.axisRelaxed.push(key(c)) }); statusGen++ } // (a relaxed cell is judged anew: the cached status too)

// The block a cell hangs on / stands on is there (and, when that is a cell of the build, finished - a torch
// on the filler a wrong cell holds pops off when the builder replaces it).
function supportThere (bot, c) {
  if (!c.sup) return true
  const s = world.at(bot, c.sup.x, c.sup.y, c.sup.z)
  if (!s || !(c.anySupport ? !/^(air|cave_air|void_air)$/.test(s.name) && !world.isLiquidWater(s) : world.isSolid(s))) return false
  // (a plant takes only its soil: a poppy clicked onto stone never stands - it would be tried for ever)
  if (c.soil && !c.soil.test(s.name)) return false
  const sc = job && job.index.get(key(c.sup))
  return !sc || cellDone(bot, sc) === true
}

// The unfinished cells that hold the band up: attached cells (torches, lanterns...) and door upper halves
// never count as "the lowest unfinished" - they go in when what they hang on stands.
// INFILL: blocks that hold nothing up - window glass, bars, lanterns, fences, trapdoors, chains. They never hold the
// layers: the walls, floors and roof rise past an unglazed window and it is glazed when the glass comes (50 glass
// cells at y124 held the whole 42k cathedral for a day while the sand for them was still being found, 2026-09-26).
const INFILL_RE = /glass|_pane$|iron_bars|(?<!jack_o_|sea_)lantern$|_fence$|_trapdoor$|^chain$/
// ...and a cell of a material the bot has no route to yet (the castle's leaves, moss, honeycomb candles, 2026-09-27):
// the structure rises past it and it goes in once a skill for it exists - never the band's anchor, never the chase
function unsourced (item) { try { return !!item && require('./materials').unsourced(item) } catch { return false } }
function infillItem (item) { return !!item && (INFILL_RE.test(item) || unsourced(item)) }
// a cell's materials, both steps (a pot AND its plant): one predicate everywhere (audit #37)
function cellUnsourced (c) { return unsourced(c.item) || (!!c.then && unsourced(c.then)) }
function infillCell (c) { return INFILL_RE.test(c.name) || cellUnsourced(c) }
// (and a cell that has failed at all does not hold the layers either: eight pillar tops at y127 the planner could
//  not reach held the whole cathedral for hours, 2026-09-27 - after its FIRST miss now (n >= 1): the walls rise past it and it is tried again later,
//  from the new structure beside them)
function lowestStructural (todo) {
  let m = Infinity
  for (const c of todo) if (!c.attach && !c.follows && !infillCell(c) && !((cellFails.get(key(c)) || {}).n >= 1) && c.y < m) m = c.y
  return m
}

// The items a cell still takes, as the world stands, into `add(item, n)`: a two-step cell its first item AND its
// second (a pot and a poppy; a cauldron and a water bucket) - or only the second once the first stands; a multi-count
// cell as many as are still missing (three candles, one more once two stand). The right block the wrong way round
// takes nothing new (digging it out hands the item back).
function needsOf (bot, c, md, add) {
  const b = world.at(bot, c.x, c.y, c.z)
  const st = stepOf(c, b)
  if (st === 'then') return add(c.then, 1)
  if (st === 'more') return add(itemOf(c, md), c.count.n - amountOf(c, b))
  const it = itemOf(c, md)
  if (!it || (b && nameOk(c, b.name))) return
  add(it, c.count ? c.count.n : 1)
  if (c.then) add(c.then, 1)
}

// Remaining work, from the world. Counts unknown (unloaded) cells as remaining. `need` is ITEMS still to
// place, keyed by the blueprint's own item (wall_torch -> torch, grass -> dirt, a door once).
// THE CASTLE STATUS, CACHED: a pass over every cell (14k here), recomputed only when a block changes in the build's box
// or a chunk over it loads - read by the api's /state and by every "what does the build place" question (the reserved
// wood asked it per recipe choice, a whole pass each time: the fuel stall's shape again; audit 2026-09-28). A caller that
// must see this tick's world (the builder itself) calls status().
let statusGen = 1; let statusCache = { key: null }; const statusWatched = new WeakSet()
function watchStatus (bot) {
  if (statusWatched.has(bot)) return; statusWatched.add(bot)
  const inBox = (x, z) => job && job.box && x >= job.box.x1 - 2 && x <= job.box.x2 + 2 && z >= job.box.z1 - 2 && z <= job.box.z2 + 2
  bot.on('blockUpdate', (o, n) => { const q = (n && n.position) || (o && o.position); if (q && inBox(q.x, q.z)) statusGen++ })
  bot.on('chunkColumnLoad', c => { if (c && job && job.box && c.x <= job.box.x2 + 2 && c.x + 15 >= job.box.x1 - 2 && c.z <= job.box.z2 + 2 && c.z + 15 >= job.box.z1 - 2) statusGen++ })
}
function cachedStatus (bot) {
  if (!job) return null
  watchStatus(bot)
  const key = `${statusGen}|${job.name}@${job.origin.x},${job.origin.z}|${exactWood() ? 'exact' : 'any'}` // (the wood rule decides a wood cell's item)
  if (statusCache.key !== key) statusCache = { key, st: status(bot), at: Date.now() }
  return statusCache.st
}
function status (bot) {
  if (!job) return null
  let done = 0; let unknown = 0
  const md = world.data(bot)
  const need = {}
  for (const c of job.cells) {
    const d = cellDone(bot, c)
    if (d === true) { done++; continue }
    if (d === null) unknown++
    needsOf(bot, c, md, (it, n) => { need[it] = (need[it] || 0) + n })
  }
  return { name: job.name, total: job.cells.length, done, unknown, need }
}
// Items for the cells from the lowest unfinished layer up to `layers` above it (the window the builder
// works in), plus attached cells whose support already stands. Same keying as status().need.
function nextNeeds (bot, layers = 4) {
  if (!job) return {}
  const md = world.data(bot)
  const todo = job.cells.filter(c => !c.follows && cellDone(bot, c) !== true)
  const minY = lowestStructural(todo)
  const out = {}
  for (const c of todo) {
    if (c.attach ? !(c.y <= minY + layers || supportThere(bot, c)) : c.y > minY + layers) continue
    needsOf(bot, c, md, (it, n) => { out[it] = (out[it] || 0) + n })
  }
  return out
}
function cellsDone (bot) { if (!job) return false; for (const c of job.cells) if (cellDone(bot, c) !== true) return false; return true }

// Blocks inside the footprint (above the base layer) that are not part of the schematic.
function obstructions (bot, { maxY = Infinity } = {}) {
  const out = []
  const { box } = job
  for (let y = Math.min(box.y2 + 2, maxY); y >= box.y1 + 1; y--) for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) {
    if (job.index.has(key({ x, y, z }))) { // a schematic cell holding the wrong block
      const c = job.index.get(key({ x, y, z }))
      const b = world.at(bot, x, y, z)
      if (b && !world.isAirish(b) && !world.isLiquidWater(b) && !partOk(c, b.name)) out.push(b)
      continue
    }
    const b = world.at(bot, x, y, z)
    if (!b || world.isAirish(b) || world.isLiquidWater(b) || world.isLavaBlock(b)) continue
    // above the ground layers a dirt/granite block outside the castle's cells is our own scaffold or a
    // pathfinder pillar - not an obstruction (each castle cycle tore down the supports the build then put back);
    // removeScaffold takes them away when the castle is done
    if (y >= box.y1 + 3 && SCAFFOLD_RE.test(b.name)) continue
    // and at any height, a block the snapshot says went where the site was open is our own scaffold (a pathfinder
    // foothold): the finish takes it down. Counted as an obstruction, the clearing dug it and the next walk put it
    // back - "clearing 3 blocks (321 obstructions)" round after round for 10 minutes (2026-09-23)
    if (site && isStray(bot, x, y, z)) continue
    out.push(b)
  }
  return out
}

function inBox (p, pad = 0) { const b = job.box; return p.x >= b.x1 - pad && p.x <= b.x2 + pad && p.z >= b.z1 - pad && p.z <= b.z2 + pad && p.y >= b.y1 - pad && p.y <= b.y2 + pad + 3 }

// Movements for work inside the site: may dig terrain and scaffold there, but never a block that
// already matches the schematic.
const GROUND_RE = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|gravel|sand|red_sand|sandstone|stone|granite|diorite|andesite|tuff|deepslate|calcite|dripstone_block|moss_block)$/
function siteMovements (bot, { place = true, dig = true } = {}) {
  // finished blocks of every build are protected by move's registered protector (one rule, all walks)
  const m = move.movementsFor(bot, { dig: !!dig, place, allowZones: ['build', 'base'] })
  // dig 'noGround' (a finished site): leaves and the like may still be cut (with no digging at all the bot was
  // trapped in the canopy beside the transept), but never the earth and rock the building stands on
  if (dig === 'noGround') { const md = world.data(bot); for (const b of Object.values(md.blocksByName)) if (GROUND_RE.test(b.name)) m.blocksCantBreak.add(b.id) }
  return m
}

// dig: false once every block stands - the finish walks tunnelled through the ground UNDER the nave floor to reach
// scaffold (the bot was found at y69 beneath its own church, 2026-09-23): a finished site is walked, not dug
// Standing inside the footprint under finished build (a floor over our head within 12 blocks)?
function underTheBuild (bot) {
  const f = bot.entity.position.floored(); const b = job.box
  if (f.x < b.x1 || f.x > b.x2 || f.z < b.z1 || f.z > b.z2 || f.y >= b.y1) return false
  for (let y = f.y + 2; y <= Math.min(b.y1 + 1, f.y + 12); y++) { const c = job.index.get(key({ x: f.x, y, z: f.z })); if (c && cellDone(bot, c) === true) return true }
  return false
}
async function goSite (bot, goal, label, { place = true, dig = (job && job.cells.every(c => cellDone(bot, c) === true)) ? 'noGround' : true, doors = true } = {}) {
  // move.goTo builds its own Movements; for site work use pathfinder directly through runGoal
  // leaving the safehouse first: the planner never routes through its door
  if (move.insideHut(bot.entity.position.floored())) await move.crossDoor(bot, goal).catch(e => log('build', `door crossing threw: ${e.message}`))
  // UNDER THE BUILD: the plaza overhangs the mountainside, and the bot, come up the slope from a grave run or a flee,
  // stood in the hollow under the finished floor at y112 trying to reach cells above it - the floor between, every
  // walk "stuck", a day of cells written off (2026-09-26). Out onto open ground first, then the site from the top.
  if (job && underTheBuild(bot)) {
    const h = mem.get().home
    log('build', `under the build's floor at ${move.fmt(bot.entity.position)} - out onto open ground first`)
    await move.travel(bot, h || { x: job.origin.x - 8, y: job.origin.y, z: job.origin.z - 8 }, { range: 6, label: 'out from under the build' }).catch(() => null)
  }
  const r = await move.runGoal(bot, goal, { timeoutMs: 30000, stuckMs: 8000, movements: siteMovements(bot, { place, dig }) })
  if (!r.ok && r.why === 'interrupted') { await reflex.waitClear(); return move.runGoal(bot, goal, { timeoutMs: 30000, stuckMs: 8000, movements: siteMovements(bot, { place, dig }) }) }
  if (doors && !r.ok && r.why !== 'died') { const d = await viaDoor(bot, goal, siteMovements(bot, { place, dig })); if (d) return d }
  return r
}

// The planner never walks through a door (mineflayer-pathfinder opens fence gates only; a door is solid to it, open or
// shut): the church's inside was unreachable, 45 scaffold blocks in the nave "stuck" day after day (2026-09-23). A
// player goes round to the door: walk to its near step, cross it by hand (move.crossDoor), then walk on.
async function viaDoor (bot, goal, movements) {
  if (!job) return null
  const gp = goal && goal.x != null ? { x: goal.x, y: goal.y, z: goal.z } : null
  if (!gp) return null
  const me = bot.entity.position
  const doors = job.cells.filter(c => /_door$/.test(c.name) && !c.follows && c.props && /^(north|south|east|west)$/.test(c.props.facing) && cellDone(bot, c) === true)
    // the ground-floor entrances first (the way in a player takes), then the upper doors
    .sort((a, b) => ((a.y > job.box.y1 + 1) - (b.y > job.box.y1 + 1)) || (world.dist3(me, a) + world.dist3(a, gp)) - (world.dist3(me, b) + world.dist3(b, gp)))
  for (const d of doors.slice(0, 3)) {
    const alongZ = d.props.facing === 'north' || d.props.facing === 'south'
    const sides = alongZ ? [{ x: d.x, y: d.y, z: d.z - 1 }, { x: d.x, y: d.y, z: d.z + 1 }] : [{ x: d.x - 1, y: d.y, z: d.z }, { x: d.x + 1, y: d.y, z: d.z }]
    const near = sides.sort((a, b) => world.dist3(me, a) - world.dist3(me, b))[0]
    // (the bot's everyday walker, with its own recoveries: the site runGoal got "stuck" in the canopy every time)
    const r0 = await move.travel(bot, near, { range: 1, label: 'to the door', maxMs: 90000 })
    if (!r0.ok) { log('build', `couldn't get to the ${d.name.replace('_door', '')} door at ${move.fmt(d)} (${r0.why})`); continue }
    if (!await move.crossDoor(bot, goal).catch(() => false)) continue
    log('build', `went through the ${d.name.replace('_door', '')} door at ${move.fmt(d)} toward ${move.fmt(gp)}`)
    return move.runGoal(bot, goal, { timeoutMs: 30000, stuckMs: 8000, movements })
  }
  return null
}

// Obstructions we could not reach twice are left for the end (scaffold cleanup reaches from the
// finished walls) instead of stalling the whole site on a leaf 12 blocks up.
const clearFails = new Map()
function skippedObstruction (b) { return (clearFails.get(key(b.position)) || 0) >= 2 }
function unskippedObstructions (bot, opts) { return obstructions(bot, opts).filter(b => !skippedObstruction(b)) }

async function clearSite (bot, { shouldStop, maxBlocks = 400, maxY = Infinity, finishing = false, leaves: takeLeaves = true } = {}) {
  // the snapshot of the untouched site comes first: after the first dig it can't be had any more
  if (!ensureSnapshot(bot)) return 0
  let cleared = 0
  for (let pass = 0; pass < 3; pass++) {
    const all = unskippedObstructions(bot, { maxY })
    if (!all.length) break
    // trees first: cut the trunks and the leaves decay by themselves; leaves are dug by hand only
    // when they are still there well after the last trunk came down
    const logs = all.filter(b => world.LOG_RE.test(b.name))
    // a leaf only matters where a block goes (walking cuts through the rest; stragglers are tidied
    // when the build is finished)
    const leaves = all.filter(b => world.LEAF_RE.test(b.name) && (finishing || job.index.has(key(b.position))))
    const rest = all.filter(b => !world.LOG_RE.test(b.name) && !world.LEAF_RE.test(b.name))
    let obs
    if (logs.length) { obs = logs.sort((a, b) => a.position.y - b.position.y); mem.set('siteLogsAt', Date.now()) } else if (rest.length) obs = rest
    else if (!takeLeaves) return cleared
    else if (Date.now() - (mem.get().siteLogsAt || 0) > 4 * 60000) obs = leaves
    else { log('build', `${leaves.length} leaves left on the site - letting them decay`); return cleared }
    if (!obs.length) break
    log('build', `clearing ${obs.length} ${logs.length ? 'logs' : (rest.length ? 'blocks' : 'leftover leaves')} from the site (${all.length} obstructions in all)`)
    for (const b of obs) {
      if (shouldStop && shouldStop()) return cleared
      if (cleared >= maxBlocks) return cleared
      await reflex.waitClear()
      const cur = world.at(bot, b.position.x, b.position.y, b.position.z)
      if (!cur || world.isAirish(cur) || world.isLiquidWater(cur)) continue
      if (!act.reach(bot, cur.position, 4.3)) {
        // a leaf is taken only from where a walk gets us: towering up into a canopy for leaves put up more dirt
        // than the finish could take down (scaffold 148 -> 172 while "clearing 331 leftover leaves", 2026-09-23)
        const r = await goSite(bot, new goals.GoalLookAtBlock(cur.position, bot.world, { reach: 4 }), 'clear', { place: !world.LEAF_RE.test(cur.name) })
        if (!r.ok && !act.reach(bot, cur.position, 5)) { clearFails.set(key(cur.position), (clearFails.get(key(cur.position)) || 0) + 1); continue }
      }
      // (a wrong block in one of our cells is ours to take out; `own` lets it past the finished-block guard
      //  when it is the right material the wrong way round)
      if (await act.dig(bot, cur.position, { force: true, own: job.index.has(key(cur.position)), allowZones: ['build', 'base'], timeoutMs: 15000 })) cleared++
      else clearFails.set(key(cur.position), (clearFails.get(key(cur.position)) || 0) + 1)
      if (inv.freeSlots(bot) <= 1) await base().tossJunk(bot)
    }
    await act.collectDrops(bot, { radius: 10, maxMs: 8000 })
  }
  if (cleared) surveyCache = null
  return cleared
}

// Other build jobs (the hut) register here so site movement never breaks their finished blocks.
const extraJobs = new Map()
function registerJob (name, j) { if (j) extraJobs.set(name, j); else extraJobs.delete(name) }
function allJobs () { const out = [...extraJobs.values()]; if (job) out.push(job); return out }
// A finished block of any build (the right material in its cell) is never broken: not by a walk, not by
// any dig (act.dig asks this). One exception for digs: the safehouse's door cell is opened and sealed
// every day (its seal block, a rehung door) - it stays protected from walks only.
move.setProtector((block, purpose) => {
  for (const j of allJobs()) {
    const c = j.index.get(key(block.position))
    if (!c || c.clear) continue
    // (a FILL never goes into a cell of the build, placed or not: the fill's target is air, and "finished" was never the
    //  question - dirt in a cell still waiting for its block is a block in the castle's way; audit 2026-09-28)
    if (purpose === 'fill') return true
    if (purpose === 'dig' && c.door && j !== job) continue
    if (partOk(c, block.name)) return true
  }
  return false
})

// The item to place for a cell: its exact item, the preferred species, or any held stand-in.
function pickItem (bot, c, items = inv.items(bot)) {
  const want = c.item !== undefined ? c.item : c.name
  if (!want) return null
  const exact = items.find(i => i.name === want)
  if (exact) return exact
  if (c.prefer) for (const n of c.prefer) { const it = items.find(i => i.name === n); if (it) return it }
  const alt = c.item !== undefined ? c.itemAlt : c.alt
  return alt ? (items.find(i => alt.test(i.name)) || null) : null
}

// A support block for a cell that has nothing to be clicked against. In mid-air a single filler has
// nothing to attach to either (an x-axis log in a wall needs a neighbour on its x side, where there is
// only air): stand a thin pillar up from the ground to it. Every block is scaffold: the snapshot diff
// finds it at the end (mem.scaffold is only a hint).
async function placeSupport (bot, sp, j) {
  const fillerName = () => { const f = inv.items(bot).find(i => FILLER_ITEMS.test(i.name)); return f && f.name }
  if (!fillerName()) return false
  const record = p => mem.update(m => { m.scaffold = m.scaffold || []; m.scaffold.push({ x: p.x, y: p.y, z: p.z }) })
  // 1) straight on: any solid neighbour of the support cell will do (usually the wall we are building)
  const hasNeighbour = ALL_FACES.some(([dx, dy, dz]) => { const nb = world.at(bot, sp.x + dx, sp.y + dy, sp.z + dz); return nb && world.isSolid(nb) })
  if (hasNeighbour) {
    if (await act.place(bot, sp, fillerName(), { allowZones: ['build', 'base'] })) { record(sp); return true }
  }
  // 2) nothing to hang it on: a thin pillar up from whatever is below, however far that is (a fixed cap left
  //    the upper logs with no support at all). 30 is only a guard against building into open void.
  const column = [sp]
  let grounded = false
  for (let y = sp.y - 1; y > sp.y - 30; y--) {
    const b = world.at(bot, sp.x, y, sp.z)
    if (!b) return false
    if (world.isSolid(b)) { grounded = true; break }
    if (j.index.has(key({ x: sp.x, y, z: sp.z }))) return false // a build cell below: that goes in first
    column.unshift({ x: sp.x, y, z: sp.z })
  }
  if (!grounded) return false
  for (const p of column) {
    const cur = world.at(bot, p.x, p.y, p.z)
    if (cur && world.isSolid(cur)) continue
    const n = fillerName()
    if (!n) return false
    if (!await act.place(bot, p, n, { allowZones: ['build', 'base'], faceHint: [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] })) return false
    record(p)
  }
  return true
}

// Can this plan be clicked now (a solid, clickable block where it says)?
// (an attached thing may click a block that does something when clicked - sneaking: a candle on a fence gate, a pot on a
//  trapdoor have no other face)
function refOk (bot, c, p) {
  const nb = world.at(bot, c.x + p.off[0], c.y + p.off[1], c.z + p.off[2])
  return act.refUsable(nb, !!c.attach)
}
function stateOf (b) { try { const p = b.getProperties(); const s = KEY_PROPS.filter(k => p[k] != null).map(k => `${k}=${p[k]}`).join(','); return b.name + (s ? `[${s}]` : '') } catch { return b.name } }

// UP TO A HIGH CELL THE WAY A BUILDER DOES: stand on the floor beside it and pillar straight up by jump-placing, no
// search. The planner, asked to get near a nave pillar top 8 over the floor, climbed the side wall 15 blocks off, might
// not bridge back over the drop, and timed out - every y127-128 cell of the arcade "unreachable" (2026-09-27). The
// pillar is scaffold: the site clearing and the scaffold teardown take it down.
// Standing columns to pillar up from, nearest first: clear air (no build cell) from the ground up past the cell's height,
// within 3 of the cell so its top reaches it (only the eight beside it: the rose window's ring filled all eight with
// its own cells, "no pillar up to it", 2026-09-27).
function feetFor (bot, c) {
  const me = bot.entity.position
  const out = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    if ((!dx && !dz) || Math.hypot(dx, dz) > 3.2) continue
    const x = c.x + dx; const z = c.z + dz
    const gy = world.groundY(bot, x, z, c.y - 1)
    if (gy == null || c.y - 1 - gy > 16) continue
    // (never under the plaza's floor - a gap in it showed the slope 4 below; nor on top of an old scaffold pillar a
    //  walk can't get up onto - the columns tried before were full of their own dirt, 2026-09-27)
    const inFoot = x >= job.box.x1 && x <= job.box.x2 && z >= job.box.z1 && z <= job.box.z2
    if (inFoot && gy < job.box.y1 - 1) continue
    const g = world.at(bot, x, gy, z)
    if (g && gy > job.box.y1 && !job.index.has(key({ x, y: gy, z })) && /^(dirt|cobblestone|andesite|diorite|tuff|coarse_dirt)$/.test(g.name)) continue
    let clear = true
    for (let y = gy + 1; y <= c.y + 1 && clear; y++) { const b = world.at(bot, x, y, z); if (!b || !world.isAirish(b) || job.index.has(key({ x, y, z }))) clear = false }
    if (!clear) continue
    // (on the floor or the ground, not up on a ledge of the build: the walk to a window ledge at y128 stuck every time)
    const raised = gy > job.box.y1 ? 25 : 0
    out.push({ x, y: gy + 1, z, d: Math.hypot(x + 0.5 - me.x, gy + 1 - me.y, z + 0.5 - me.z) + Math.hypot(dx, dz) + raised })
  }
  return out.sort((a, b) => a.d - b.d)
}
function footFor (bot, c) { return feetFor(bot, c)[0] || null }
// Pillar feet the walk could not get to, skipped for half an hour by every cell (the south end's floor inside the facade:
// three feet per cell, each tried twice, eight seconds a try, a dozen cells - a whole day, 2026-09-27)
const badFeet = new Map()
const footBad = f => { const t = badFeet.get(key(f)); return !!t && Date.now() - t < 30 * 60000 }
async function pillarTo (bot, c, first) {
  const feet = feetFor(bot, c).filter(f => !footBad(f)).slice(0, 3)
  if (first && !feet.some(f => f.x === first.x && f.z === first.z)) feet.unshift(first)
  for (const f of feet.slice(0, 3)) {
    // (the site walker: it goes in through the build's doors - the nave is walled round)
    const r = await goSite(bot, new goals.GoalBlock(f.x, f.y, f.z), 'to the foot of a pillar')
    if (!r.ok) { badFeet.set(key(f), Date.now()); log('build', `pillar for ${c.name} at ${move.fmt(c)}: couldn't reach its foot ${move.fmt(f)} (${r.why})`); continue }
    await ensureScaffold(bot, 16, { shouldStop: stepStop })
    // (the planner let go of first: its goal left standing, it set the controls every tick and the tower's jump never
    //  held - "towered to y120" 24 times in an hour on the nave floor, where the same tower rose in the yard, 2026-09-27)
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    await act.sleep(100)
    for (let i = 0; i < 16 && Math.floor(bot.entity.position.y) < c.y - 1; i++) {
      if (!await require('./gather').towerUp(bot, { allowZones: ['build', 'base'], builder: true })) break
    }
    if (act.reach(bot, new Vec3(c.x, c.y, c.z), 4.8)) return true
    log('build', `pillar for ${c.name} at ${move.fmt(c)}: towered from ${move.fmt(f)} to y${Math.floor(bot.entity.position.y)}, still out of reach`)
  }
  return false
}
let lastPlaceFail = ''
async function placeCell (bot, c, j = job) {
  const why = w => { lastPlaceFail = w; return false }
  lastPlaceFail = ''
  const pos = new Vec3(c.x, c.y, c.z)
  const own = { force: true, own: true, allowZones: ['build', 'base'], timeoutMs: 15000 }
  if (c.clear) {
    // a cell that must be empty: dig out whatever is in it
    if (cellDone(bot, c)) return true
    return act.dig(bot, pos, own)
  }
  // the second half of a two-block block (a door's or a tall plant's top, a bed's head) and flowing liquid come with
  // another cell - never placed on their own
  if (c.follows) return cellDone(bot, c) === true
  let cur = bot.blockAt(pos)
  if (!cur) return false
  if (cellDone(bot, c)) return true
  // attached things wait for what they hang on (not a failure - buildStep doesn't pick them until then)
  if (c.attach && !supportThere(bot, c)) return false
  // HALF-WAY: the pot stands empty, two of three candles stand - the next step goes onto what is there, never a dig
  const step = stepOf(c, cur)
  // whatever else is in our cell that isn't the finished block comes out - a wrong block, the right one the wrong way
  // round (our own cell: the one dig allowed past the finished-block guard), a flower where another goes (a flower is
  // no grass tuft: the server keeps it, and the place "failed" for ever)
  if (!step && !world.isAirish(cur) && !world.isLiquidWater(cur) && !act.REPLACEABLE_RE.test(cur.name)) {
    if (!await act.dig(bot, pos, own)) return why(`could not dig the ${cur.name} in the cell`)
    cur = bot.blockAt(pos)
  }
  // a two-block block needs its second cell clear (a scaffold block or a leaf in a door's top, a bed's head)
  const twin = c.twin && { x: c.x + c.twin[0], y: c.y + c.twin[1], z: c.z + c.twin[2] }
  if (twin && !step) {
    const t = world.at(bot, twin.x, twin.y, twin.z)
    if (t && !world.isAirish(t) && !world.isLiquidWater(t) && !act.REPLACEABLE_RE.test(t.name)) { if (!await act.dig(bot, t.position, own)) return why(`could not clear the ${t.name} out of its second cell`) }
  }
  // Within reach of the cell, by the site walker: `faces` the faces to see, or none (a step onto a block that stands).
  const getInReach = async (faces) => {
    // A CELL HIGH OVER ITS FLOOR: pillar up from the floor beside it first. Left to find its own way, the planner climbed
    // onto the rose window's one-wide ring 8 over the plaza and stuck there, cell after cell (2026-09-27).
    let pillared = false
    if (!act.reach(bot, pos, 4.3)) {
      const foot = feetFor(bot, c).find(f => !footBad(f))
      if (foot && c.y - foot.y >= 3) { pillared = true; await pillarTo(bot, c, foot) }
    }
    if (act.reach(bot, pos, 4.3)) return true
    const goal = faces ? new goals.GoalPlaceBlock(pos, bot.world, { range: 4, faces, LOS: true }) : new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 })
    const r = await goSite(bot, goal, 'place')
    // (a cell high over us: the planner won't tower toward a "see this face" goal - it never found one for the nave's
    //  y127 pillar tops, an evening of "stuck" - but it towers to a place to STAND: up beside the cell, then place)
    // (any cell above our feet: standing on a wall top at y125, the y128 cells were "3 above" and never pillared to)
    if (!r.ok && !act.reach(bot, pos, 4.8) && c.y > bot.entity.position.y && !pillared) {
      const up = await pillarTo(bot, c)
      if (!up && !act.reach(bot, pos, 4.8)) return why(`could not get within reach (${r.why}; no pillar up to it)`)
    } else if (!r.ok && !act.reach(bot, pos, 4.8)) return why(`could not get within reach (${r.why})`)
    return true
  }
  if (!step) {
    // after three failures with its own axis, a log takes any face
    if (c.want && c.want.axis && !axisRelaxed(c) && failsOf(c) >= 3) { relaxAxis(c); log('build', `${c.name} at ${move.fmt(c)} goes in with any axis (nothing to place it against on its own side)`) }
    const plans = plansFor(c)
    if (!plans.length) return why('no face to place it against in its plan')
    // is there something to click?
    if (!plans.some(p => refOk(bot, c, p))) {
      if (c.attach) return why('nothing to hang it on')
      // temporary support on any face the cell can be clicked from: not a cell of the build, not where we
      // stand (only ever trying the first face put the support into the bot's own head, 4 minutes of
      // "blockUpdate did not fire")
      const filler = inv.items(bot).find(i => FILLER_ITEMS.test(i.name))
      if (!filler) return why('nothing to click and no filler for a temporary support')
      const me = bot.entity.position.floored()
      let supported = false
      for (const p of plans) {
        const sp = { x: c.x + p.off[0], y: c.y + p.off[1], z: c.z + p.off[2] }
        if (j.index.has(key(sp))) continue
        if (sp.x === me.x && sp.z === me.z && (sp.y === me.y || sp.y === me.y + 1)) continue
        const spb = world.at(bot, sp.x, sp.y, sp.z)
        if (!spb || !(world.isAirish(spb) || world.isLiquidWater(spb))) continue
        if (await placeSupport(bot, sp, j)) { supported = true; break }
      }
      if (!supported) return why('nothing to click and no temporary support would go in')
    }
    const item = pickItem(bot, c)
    if (!item) return why('no block for it in hand')
    const usable = plans.filter(p => refOk(bot, c, p))
    if (!await getInReach(usable.map(p => new Vec3(p.off[0], p.off[1], p.off[2])))) return false
    const opts = { plans: usable.length ? usable : plans, allowZones: ['build', 'base'], keepExit: true }
    // (a liquid source is poured from its bucket; everything else placed - a pot or a cauldron is its first step. A
    //  chest of a pair is placed standing up: a sneaking placement never pairs)
    const ok = c.pour
      ? await act.pour(bot, c, item.name, Object.assign(opts, { accept: b => nameOk(c, b.name) && String(propsOf(b).level) === '0' }))
      : await act.place(bot, c, item.name, Object.assign(opts, { accept: b => partOk(c, b.name), sneak: !/_door$/.test(item.name) && !pairs(c), twin: c.twin || null, useRefs: !!c.attach }))
    if (!ok) return why(c.pour ? 'the pour itself failed' : 'the place itself failed')
    surveyCache = null
  } else if (!await getInReach(null)) return false
  // THE STEPS AFTER THE FIRST PLACING: the plant into its pot, the bucket into its cauldron, one more candle/pickle/layer
  // onto what stands - each the item used on the block in the cell (vanilla useItemOn)
  for (let i = 0; i < 9 && cellDone(bot, c) !== true; i++) {
    const b0 = bot.blockAt(pos); const st = stepOf(c, b0)
    if (!st) break
    const it = st === 'then' ? inv.items(bot).find(x => x.name === c.then) : pickItem(bot, c)
    if (!it) return why(`no ${st === 'then' ? c.then : c.item} in hand for its next step (${stateOf(b0)} stands)`)
    const before = st === 'more' ? amountOf(c, b0) : null
    const accept = b => (st === 'then' ? b.name !== c.base : amountOf(c, b) > before)
    // (a top slab takes its second half from below)
    const face = propsOf(b0).type === 'top' ? 'down' : 'up'
    if (!await act.useOn(bot, pos, it.name, { accept, face, allowZones: ['build', 'base'] })) return why(`the ${it.name} would not go onto the ${stateOf(b0)}`)
    surveyCache = null
  }
  if (cellDone(bot, c) !== true && c.want && c.want.open != null) {
    const b0 = bot.blockAt(pos); let open = null; try { open = String(b0.getProperties().open) } catch {}
    if (open != null && open !== c.want.open) { try { await bot.activateBlock(b0); await act.sleep(300) } catch {} }
  }
  if (cellDone(bot, c) === true) return true
  // placed, but not what the blueprint shows: out again (our own cell), and the failure counts
  const b = bot.blockAt(pos)
  log('build', `${c.name} at ${move.fmt(c)} came out ${b ? stateOf(b) : '?'} (want ${JSON.stringify(c.want || wantOf(c))}) - taking it out again`)
  // (poured water is no block to dig out)
  if (!c.pour) await act.dig(bot, pos, own)
  return false
}

// Place as much as the pack allows. Returns {placed, blockedOn: item|null, done}.
// cells that keep failing rest a while - across build steps (a fresh map per step retried the same
// unplaceable cell every call)
// (kept in memory across reloads: a reload forgot every hard cell and each came back to fail three more times, minutes
//  of every build step spent re-learning the same eight unreachable pillar tops, 2026-09-27)
const cellFails = new Map(Object.entries((mem.get().cellFails) || {})) // key -> {n, at}
let cellFailsSaved = 0
// (only cells of the job are kept: a cell finished by any other way - a restart, a hand - is dropped at the next save; audit #38)
function saveCellFails () { if (Date.now() - cellFailsSaved < 5000) return; cellFailsSaved = Date.now(); const o = {}; for (const [k, v] of cellFails) { if (job && !job.index.has(k)) { cellFails.delete(k); continue } o[k] = v } mem.set('cellFails', o) }
function failsOf (c) { const f = cellFails.get(key(c)); return f ? f.n : 0 }
let stepStop = null // (the running build step's stop - a pillar's scaffold top-up inside it keeps the step's day)
async function buildStep (bot, { shouldStop, maxMs = 10 * 60000 } = {}) {
  stepStop = shouldStop || null
  const t0 = Date.now()
  let placed = 0
  if (!ensureSnapshot(bot)) return { placed, blockedOn: null, done: false }
  // (a cell that keeps failing is tried again ever more rarely - 5 min after its third miss, then 10, 20... up to 2h -
  //  never forgotten: the same window glass cells took three tries each, every step, minutes of every day, 2026-09-26)
  const failed = { get: k => { const f = cellFails.get(k); return f ? f.n : 0 }, set: (k, n) => cellFails.set(k, { n, at: Date.now() }) }
  // (after ONE miss: a step's tries were 0 of 8 and 0 of 9 - 30-40s each, walking 25 blocks to cells the reach could not
  //  make, three tries apiece before they rested, while cells in reach waited, 2026-09-27)
  const resting = k => { const f = cellFails.get(k); if (!f || f.n < 1) return false; return Date.now() - f.at < Math.min(2 * 3600000, 3 * 60000 * Math.pow(2, f.n - 1)) }
  // what the lowest layers wait on, as last seen - reported even when the step placed something: a step that placed 19
  // scattered cobblestone in seven minutes counted as progress while 50 glass cells held every layer above them, and
  // the glass's sand and fuel were only fetched when a step placed nothing - at dusk, too late (2026-09-26)
  let waiting = null
  // (where a step's time goes: choosing the cell, walking to and placing it - measured, not guessed)
  const prof = { tries: 0, ms: 0, okMs: 0, dist: 0, pick: 0 }; let tpick = Date.now()
  const profLog = () => { if (prof.tries) log('build', `step profile: ${placed}/${prof.tries} placed, ${Math.round(prof.ms / prof.tries)}ms a try (${placed ? Math.round(prof.okMs / placed) : 0}ms a placed block), ${(prof.dist / prof.tries).toFixed(1)} blocks off on average, ${Math.round(prof.pick / Math.max(1, prof.tries))}ms choosing each`) }
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const todo = job.cells.filter(c => !c.follows && cellDone(bot, c) !== true && !resting(key(c)))
    // (nothing left to try but cells still missing: every one of them failed - stalled, the caller decides what
    //  might be in their way)
    if (!todo.length) { const done = cellsDone(bot); return { placed, blockedOn: null, done, stalled: !done } }
    // the band: attached cells and door tops never hold it down (a lantern under a roof slab waits for the
    // roof; the walls below it must not wait for the lantern)
    const lowestAll = lowestStructural(todo)
    const items = inv.items(bot)
    // (a cell half-way - an empty pot - waits on its next step's item, the plant)
    const has = c => (stepOf(c, world.at(bot, c.x, c.y, c.z)) === 'then' ? items.some(i => i.name === c.then) : !!pickItem(bot, c, items))
    // what the band is really held up by: a structural cell of the lowest layers first. A carpet or a pot holds
    // nothing up - reported first, the director chased unreachable sheep for "red_carpet" while two granite stairs
    // and twelve panes (sand) were what kept the walls from rising (2026-09-23)
    const missingItem = () => {
      const low = todo.filter(c => !c.attach && !c.follows && !cellUnsourced(c) && c.y <= lowestAll + 1).find(c => !has(c))
      // (then infill waiting on its material - glass: the sand trips are still wanted, only the layers don't wait)
      const m = low || todo.filter(c => c.attach && !cellUnsourced(c) && supportThere(bot, c)).find(c => !has(c)) || todo.filter(c => infillCell(c) && !cellUnsourced(c) && c.y <= lowestAll + 1).find(c => !has(c)) || todo.filter(c => infillCell(c) && !cellUnsourced(c)).sort((a, b) => a.y - b.y).find(c => !has(c))
      return m ? stepItem(bot, m) : null
    }
    // the lowest two layers of what we HAVE the blocks for: 24 missing glass panes in a wall no longer hold up
    // every brick above them (the windows go in when the glass comes)
    const structural = todo.filter(c => !c.attach && has(c))
    const attached = todo.filter(c => c.attach && has(c) && supportThere(bot, c))
    const minY = structural.length ? Math.min(...structural.map(c => c.y)) : Infinity
    // no more than 3 layers above the lowest unfinished cell: walls rise together, nothing floats far up
    let doable = minY <= lowestAll + 3 ? structural.filter(c => c.y <= minY + 1) : []
    // a door goes in once its floor stands (and its own two cells are ours to clear)
    doable = doable.filter(c => !c.twin || supportThere(bot, c)).concat(attached)
    waiting = missingItem()
    if (!doable.length) { profLog(); if (!placed) log('build', `nothing doable: lowest structural y${lowestAll}, ${todo.length} todo, ${structural.length} structural in hand (min y${minY}), ${attached.length} attached ready, waiting on ${waiting}`); return { placed, blockedOn: waiting, done: false } }
    const me = bot.entity.position
    // cells that can be clicked right now first; one whose every face is another unbuilt cell of this
    // build waits for its neighbours (trying it costs ~20s of failed placing, and a wall of x-axis logs
    // placed out of order was nothing but failures)
    const clickable = c => plansFor(c).some(p => refOk(bot, c, p))
    const supportable = c => !c.attach && !c.twin && plansFor(c).some(p => !job.index.has(key({ x: c.x + p.off[0], y: c.y + p.off[1], z: c.z + p.off[2] })))
    const ready = doable.filter(c => clickable(c) || supportable(c))
    if (!ready.length) { profLog(); if (!placed) log('build', `nothing ready: lowest y${lowestAll}, ${doable.length} doable (${doable.slice(0, 5).map(c => c.name + '@' + c.x + ',' + c.y + ',' + c.z).join(' ')}) none clickable or supportable, waiting on ${waiting}`); return { placed, blockedOn: waiting, done: false } }
    // everything within reach of where we stand first, then the nearest - a layer down counts one block, not four:
    // the walk between cells is most of a block's six seconds, and "lower first" sent the bot back and forth across the
    // 50x140 site between two layers (2026-09-27)
    const inReach = c => act.reach(bot, new Vec3(c.x, c.y, c.z), 4.3) ? 1 : 0
    ready.sort((a, b) => (clickable(b) - clickable(a)) * 100 + (inReach(b) - inReach(a)) * 50 + (a.y - b.y) + world.dist3(a, me) - world.dist3(b, me))
    const c = ready[0]
    const tp = Date.now(); const d0 = world.dist3(c, bot.entity.position)
    prof.pick += tp - tpick
    const ok = await placeCell(bot, c)
    prof.tries++; prof.ms += Date.now() - tp; prof.dist += d0; if (ok) prof.okMs += Date.now() - tp
    tpick = Date.now()
    if (ok) { placed++; if (cellFails.delete(key(c))) saveCellFails(); if (placed % 25 === 0) { const st = status(bot); log('build', `${st.done}/${st.total} placed`) } } else { failed.set(key(c), (failed.get(key(c)) || 0) + 1); saveCellFails(); if (failed.get(key(c)) === 1) log('build', `${c.name} at ${move.fmt(c)} won't place (${lastPlaceFail || 'unlogged'}) - leaving it for later`) }
  }
  profLog()
  return { placed, blockedOn: waiting, done: false }
}

// ---- the site as it was: snapshot, scaffold, holes -------------------------------------------------
// Before the first block is dug or placed, the region round the footprint is recorded to a file next to
// memory (once - it survives restarts). Afterwards scaffold is whatever the bot left standing where the
// site was open, and a hole is ground the site work took away.
let site = null // { name, origin, region, palette: [names], layers: [string per y, one char per (z,x)] }
function siteRegion (j) { const b = j.box; return { x1: b.x1 - SITE_PAD, x2: b.x2 + SITE_PAD, z1: b.z1 - SITE_PAD, z2: b.z2 + SITE_PAD, y1: b.y1 - 2, y2: b.y2 + SITE_PAD } }
function siteFile (j) { return path.join(path.dirname(mem.FILE), `site-${String(j.name).replace(/[^A-Za-z0-9_-]/g, '_')}-${j.origin.x}_${j.origin.y}_${j.origin.z}.json`) }
function loadSite (j) {
  try {
    const s = JSON.parse(fs.readFileSync(siteFile(j), 'utf8'))
    const r = siteRegion(j)
    if (s && s.region && ['x1', 'x2', 'y1', 'y2', 'z1', 'z2'].every(k => s.region[k] === r[k])) return s
  } catch {}
  return null
}
// The region is ~45k blocks: scans read the state id straight from the chunk (no Block object per cell),
// so a look at the whole site costs a few ms, not a tick. null = chunk not loaded.
function kindAt (bot, x, y, z) {
  const w = bot.world
  if (!w || !w.getColumnAt || !w.getBlockStateId) { const b = world.at(bot, x, y, z); return b ? { name: b.name, boundingBox: b.boundingBox } : null }
  const v = new Vec3(x, y, z)
  if (!w.getColumnAt(v)) return null
  return world.data(bot).blocksByStateId[w.getBlockStateId(v)] || null
}
let snapWaitLog = 0
function ensureSnapshot (bot) {
  if (!job) return false
  if (site) return true
  const r = siteRegion(job)
  const palette = []; const pidx = new Map(); const layers = []
  for (let y = r.y1; y <= r.y2; y++) {
    let row = ''
    for (let z = r.z1; z <= r.z2; z++) {
      for (let x = r.x1; x <= r.x2; x++) {
        const b = kindAt(bot, x, y, z)
        if (!b) {
          // every chunk of the region, or none of it: a half snapshot would call real terrain scaffold
          if (Date.now() - snapWaitLog > 60000) { snapWaitLog = Date.now(); log('build', `site snapshot waits: ${x},${y},${z} not loaded - no site work until it is`) }
          return false
        }
        let i = pidx.get(b.name)
        if (i === undefined) { i = palette.length; palette.push(b.name); pidx.set(b.name, i) }
        row += String.fromCharCode(48 + i)
      }
    }
    layers.push(row)
  }
  site = { name: job.name, origin: job.origin, region: r, palette, layers, at: new Date().toISOString() }
  try { fs.writeFileSync(siteFile(job), JSON.stringify(site)) } catch (e) { log('build', `couldn't write the site snapshot: ${e.message}`) }
  log('build', `site snapshot taken: ${(r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1) * (r.z2 - r.z1 + 1)} blocks, ${palette.length} kinds -> ${path.basename(siteFile(job))}`)
  return true
}
function snapName (x, y, z) {
  if (!site) return undefined
  const r = site.region
  if (x < r.x1 || x > r.x2 || y < r.y1 || y > r.y2 || z < r.z1 || z > r.z2) return undefined
  return site.palette[site.layers[y - r.y1].charCodeAt((z - r.z1) * (r.x2 - r.x1 + 1) + (x - r.x1)) - 48]
}
// open before the work: nothing solid there (air, plants, water), or a tree - the site work took those away
function wasOpen (bot, name) {
  if (name == null) return false
  const b = world.data(bot).blocksByName[name]
  return !b || b.boundingBox !== 'block' || world.LEAF_RE.test(name) || world.LOG_RE.test(name) || world.WATER_RE.test(name) || world.LAVA_RE.test(name)
}
// ground before the work: solid natural earth/rock (not a tree)
function wasGround (bot, name) {
  if (name == null) return false
  const b = world.data(bot).blocksByName[name]
  return !!b && b.boundingBox === 'block' && world.NATURAL_RE.test(name) && !world.LEAF_RE.test(name) && !world.LOG_RE.test(name)
}
// Places that belong to someone else's work and are never scaffold or holes: the base (hut, furniture), the
// farm plot, any other build's cells, the mine's stairs.
function othersWork (p) {
  const z = move.inZone(p, 1)
  if (z && z.label === 'base') return true
  for (const [, j] of extraJobs) if (j.index.has(key(p)) || (j.box && p.x >= j.box.x1 - 1 && p.x <= j.box.x2 + 1 && p.z >= j.box.z1 - 1 && p.z <= j.box.z2 + 1 && p.y >= j.box.y1 - 2 && p.y <= j.box.y2 + 1)) return true
  const m = mem.get()
  const f = m.farm && m.farm.water
  if (f && Math.abs(p.x - f.x) <= 5 && Math.abs(p.z - f.z) <= 5 && p.y >= f.y - 1 && p.y <= f.y + 2) return true
  const mine = m.mine
  if (mine && mine.entrance) {
    const a = mine.entrance; const b = mine.cursor || a
    if (p.x >= Math.min(a.x, b.x) - 2 && p.x <= Math.max(a.x, b.x) + 2 && p.z >= Math.min(a.z, b.z) - 2 && p.z <= Math.max(a.z, b.z) + 2 && p.y >= Math.min(a.y, b.y) - 1 && p.y <= Math.max(a.y, b.y) + 3) return true
  }
  return false
}
// Scaffold = in the region, not a cell of the build, not someone else's work, where the site was open, and
// now a block the bot stands on / props with (filler) or anything crafted. Natural terrain that was there is
// never touched; a filler block where there was ground is ground given back (a filled hole), not scaffold.
function isStray (bot, x, y, z, k = kindAt(bot, x, y, z)) {
  if (!k) return false
  const n = k.name
  if (/air$/.test(n) || world.WATER_RE.test(n) || world.LAVA_RE.test(n) || FURNITURE_RE.test(n)) return false
  if (!(STRAY_RE.test(n) || (!world.NATURAL_RE.test(n) && k.boundingBox === 'block'))) return false
  const p = { x, y, z }
  if (job.index.has(key(p))) return false
  const was = snapName(x, y, z)
  return was !== n && wasOpen(bot, was) && !othersWork(p)
}
function scaffoldList (bot) {
  if (!job || !site) return []
  const r = site.region; const out = []
  for (let y = r.y2; y >= r.y1; y--) for (let z = r.z1; z <= r.z2; z++) for (let x = r.x1; x <= r.x2; x++) {
    const k = kindAt(bot, x, y, z)
    if (isStray(bot, x, y, z, k)) out.push({ x, y, z, name: k.name, was: snapName(x, y, z) })
  }
  return out
}
// Holes: ground the site work took away, outside the blueprint's own space (inside the footprint at and
// above its base layer the blueprint says what goes where).
function holesList (bot) {
  if (!job || !site) return []
  const r = site.region; const bx = job.box; const out = []
  for (let y = r.y1; y <= r.y2; y++) for (let z = r.z1; z <= r.z2; z++) for (let x = r.x1; x <= r.x2; x++) {
    if (y >= bx.y1 && x >= bx.x1 && x <= bx.x2 && z >= bx.z1 && z <= bx.z2) continue
    // under the floor the building stands on: sealed in, out of sight, and only reachable by breaking the floor
    // ("filled 0 of 73 holes" - the ground dug out from under the nave before the gatherer kept off it, 2026-09-23)
    if (x >= bx.x1 && x <= bx.x2 && z >= bx.z1 && z <= bx.z2 && job.index.has(key({ x, y: bx.y1, z }))) continue
    const k = kindAt(bot, x, y, z)
    if (!k || (k.boundingBox === 'block' && !world.WATER_RE.test(k.name)) || world.LAVA_RE.test(k.name)) continue
    const was = snapName(x, y, z)
    if (!wasGround(bot, was) || othersWork({ x, y, z })) continue
    out.push({ x, y, z, was })
  }
  return out
}

// Leftovers that failed three times today rest until tomorrow (a Minecraft day): the site is not declared
// finished with them - the director comes back for them the next day.
const leftovers = new Map() // key -> { n, day }
function today (bot) { return (bot.time && typeof bot.time.day === 'number') ? bot.time.day : Math.floor(Date.now() / 1200000) }
function resting (bot, p) { const l = leftovers.get(key(p)); return !!l && l.n >= 3 && l.day === today(bot) }
function failLeftover (bot, p) { const l = leftovers.get(key(p)); const d = today(bot); leftovers.set(key(p), { n: l && l.day === d ? l.n + 1 : 1, day: d }) }

// Take down every scaffold block, top-down. A block out of reach is walked to with the planner allowed to
// tower (its tower is new scaffold, found by the next pass); standing on a pillar, the pillar is dug from
// under our own feet a block at a time (how a player takes one down). Bounded: 4 passes, 3 tries per
// block a day; what is left is logged with coordinates.
async function removeScaffold (bot, { shouldStop, maxPasses = 4 } = {}) {
  if (!job) return 0
  let removed = 0
  const dig = (p, noWalk = false) => act.dig(bot, p, { force: true, allowZones: ['build', 'base'], timeoutMs: 10000, noWalk, reachMax: noWalk ? 5 : 4.3 })
  if (!site) {
    // no snapshot (a job set before snapshots): the remembered placements and filler in the footprint
    for (const p of (mem.get().scaffold || []).slice()) {
      const b = world.at(bot, p.x, p.y, p.z)
      if (b && SCAFFOLD_RE.test(b.name) && !job.index.has(key(p)) && await act.dig(bot, p, { force: true, allowZones: ['build', 'base'] })) removed++
    }
    mem.update(m => { m.scaffold = [] })
    if (removed) log('build', `removed ${removed} scaffold blocks (no site snapshot - remembered ones only)`)
    return removed
  }
  const isScaf = p => isStray(bot, p.x, p.y, p.z)
  for (let pass = 0; pass < maxPasses; pass++) {
    const list = scaffoldList(bot).filter(p => !resting(bot, p))
    if (!list.length) break
    const me0 = bot.entity.position
    // nearest first (top-down within a column): highest-first sent the bot towering up the outside of the transept
    // for one block at y77 and it stuck there in the canopy, pass after pass (2026-09-23)
    list.sort((a, b) => (a.x === b.x && a.z === b.z) ? b.y - a.y : world.dist3(a, me0) - world.dist3(b, me0))
    if (pass === 0) log('build', `taking down ${list.length} scaffold blocks`)
    let got = 0
    const queue = list.slice()
    while (queue.length) {
      await new Promise(r => setImmediate(r))
      if (shouldStop && shouldStop()) return removed
      await reflex.waitClear()
      // standing on scaffold: that block first, from under our own feet (a drop of one)
      const feet = bot.entity.position.floored()
      const under = { x: feet.x, y: feet.y - 1, z: feet.z }
      if (bot.entity.onGround && isScaf(under) && !resting(bot, under) && safeDrop(bot, under)) {
        if (await dig(under, true)) { removed++; got++; await landed(bot) } else failLeftover(bot, under)
        continue
      }
      const p = queue.shift()
      if (!isScaf(p) || resting(bot, p)) continue
      if (!act.reach(bot, p, 4.3)) {
        // (near enough, not look-at: the look-at raycast through pews and pillars "stuck" at 5-6b; the server checks distance)
        // a short walk first; then the pillar from the ground beside it; the church door only for what is inside
        let r = await goSite(bot, new goals.GoalNear(p.x, p.y, p.z, 3), 'scaffold', { doors: false })
        if (!r.ok && !act.reach(bot, p, 4.8)) {
          if (await reachByPillar(bot, p, { shouldStop })) { removed++; got++; continue }
          r = (await viaDoor(bot, new goals.GoalNear(p.x, p.y, p.z, 3), siteMovements(bot, { dig: 'noGround' }))) || r
        }
        if (!r.ok && !act.reach(bot, p, 4.8)) {
          log('build', `scaffold ${move.fmt(p)}: couldn't get within reach (${r.why}, ${world.dist3(bot.entity.position, p).toFixed(1)}b off, from ${move.fmt(bot.entity.position)})`); failLeftover(bot, p); continue
        }
      }
      // within a player's reach after the walk: dig from here (act.dig's stricter 4.3 walked again, 20s a block)
      if (await dig(p, act.reach(bot, p, 5))) { removed++; got++ } else { log('build', `scaffold ${move.fmt(p)}: the dig failed (${world.dist3(bot.entity.position, p).toFixed(1)}b off)`); failLeftover(bot, p) }
      if (inv.freeSlots(bot) <= 1) await base().tossJunk(bot)
    }
    await act.collectDrops(bot, { radius: 10, maxMs: 8000 })
    if (!got) break
  }
  // the hint list only ever shrinks to what is still standing
  mem.update(m => { m.scaffold = (m.scaffold || []).filter(p => { const b = world.at(bot, p.x, p.y, p.z); return !b || (!world.isAirish(b) && SCAFFOLD_RE.test(b.name)) }) })
  surveyCache = null
  const left = scaffoldList(bot)
  if (removed) log('build', `removed ${removed} scaffold blocks`)
  if (left.length) log('build', `${left.length} scaffold blocks still standing (tried again tomorrow if they failed 3x): ${left.slice(0, 20).map(p => `${p.name}@${p.x},${p.y},${p.z}`).join(' ')}`)
  return removed
}
// Digging the block under us drops us to the next solid block: only while that is a short, dry fall.
// A stray block high on the building that no walk gets near: stand on solid ground within two blocks of it, pillar
// straight up until it is in reach, dig it, then dig the pillar back down from the top - the player's way, with no
// route over the roofs (the planner towered onto the transept roof and stuck in the canopy pass after pass, 48
// blocks left standing, 2026-09-23). Returns true if the block is gone.
async function reachByPillar (bot, p, { shouldStop } = {}) {
  const me = bot.entity.position
  const cands = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (!dx && !dz) continue
    const x = p.x + dx; const z = p.z + dz
    for (let y = p.y; y >= p.y - 8; y--) {
      if (!world.standable(bot, x, y, z)) continue
      let clear = true // the column we will stand in, from our feet up past the target's height
      for (let yy = y; yy <= p.y + 1; yy++) { const b = world.at(bot, x, yy, z); if (!b || !world.isAirish(b)) { clear = false; break } }
      if (clear) cands.push({ x, y, z, d: world.dist3(me, { x, y, z }) + (p.y - y) * 2 })
      break
    }
  }
  cands.sort((a, b) => a.d - b.d)
  for (const c of cands.slice(0, 3)) {
    if (shouldStop && shouldStop()) return false
    const r = await move.travel(bot, c, { range: 0, label: 'under the scaffold', maxMs: 90000 })
    const f = bot.entity.position.floored()
    if (!r.ok && !(f.x === c.x && f.z === c.z && f.y === c.y)) continue
    if (!inv.items(bot).some(i => FILLER_ITEMS.test(i.name))) await ensureScaffold(bot, 16, { shouldStop }).catch(() => {})
    const base = bot.entity.position.floored().y
    for (let i = 0; i < 9 && !act.reach(bot, p, 4.3); i++) { if (!await require('./gather').towerUp(bot, { allowZones: ['build', 'base'], builder: true })) break }
    let gone = act.reach(bot, p, 5) && await act.dig(bot, p, { force: true, allowZones: ['build', 'base'], timeoutMs: 10000, noWalk: true, reachMax: 5 })
    // down again: our own pillar, dug from the top
    for (let i = 0; i < 12 && bot.entity.position.floored().y > base; i++) {
      const u = bot.entity.position.floored().offset(0, -1, 0)
      const ub = world.at(bot, u.x, u.y, u.z)
      if (!ub || !FILLER_ITEMS.test(ub.name) || job.index.has(key(u)) || !safeDrop(bot, u)) break
      if (!await act.dig(bot, u, { force: true, allowZones: ['build', 'base'], timeoutMs: 6000, noWalk: true })) break
      await landed(bot)
    }
    gone = gone || !isStray(bot, p.x, p.y, p.z)
    if (gone) { log('build', `took down the scaffold at ${move.fmt(p)} from a pillar at ${c.x},${c.z}`); return true }
  }
  return false
}
function safeDrop (bot, under) {
  for (let y = under.y - 1; y >= under.y - 4; y--) {
    const b = world.at(bot, under.x, y, under.z)
    if (!b || world.isLavaBlock(b)) return false
    if (world.isSolid(b)) return under.y - y <= 3
    if (world.isWaterBlock(b)) return false
  }
  return false
}
async function landed (bot) { const t0 = Date.now(); await act.sleep(150); while (!bot.entity.onGround && Date.now() - t0 < 2000) await act.sleep(50) }

// Holes the site work left in the ground (the snapshot says there was earth or rock) are filled with dirt,
// lowest first. Without a snapshot, the old groundwork round the outside.
async function finishSite (bot, { shouldStop } = {}) {
  if (!job) return 0
  const bx = job.box
  if (!site) {
    const gy = bx.y1 - 1
    const fixed = await require('./ground').prepare(bot, {
      x1: bx.x1 - 4, z1: bx.z1 - 4, x2: bx.x2 + 4, z2: bx.z2 + 4, groundY: gy, height: bx.y2 + 3 - gy,
      keep: b => !SCAFFOLD_RE.test(b.name),
      skip: (x, z) => (x >= bx.x1 && x <= bx.x2 && z >= bx.z1 && z <= bx.z2) || (move.inZone({ x, y: gy, z }) || {}).label === 'base',
      allowZones: ['base', 'build'] // (the site's own ring: the build zone is its ground)
    }, { shouldStop, label: `finishing round the ${job.name}` })
    log('build', `finished the ground round the ${job.name}: ${fixed} blocks tidied`)
    return fixed
  }
  const holes = holesList(bot).filter(p => !resting(bot, p))
  if (!holes.length) return 0
  if (inv.count(bot, 'dirt') < holes.length + 2) {
    await base().withdraw(bot, 'dirt', holes.length + 2 - inv.count(bot, 'dirt')).catch(() => 0)
    if (inv.count(bot, 'dirt') < holes.length) await require('./craft').ensure(bot, 'dirt', Math.min(holes.length + 2, 128), { noWithdraw: true, shouldStop }).catch(() => false)
  }
  log('build', `filling ${holes.length} holes the site work left in the ground`)
  const me0 = bot.entity.position
  holes.sort((a, b) => a.y - b.y || world.dist3(a, me0) - world.dist3(b, me0))
  let fixed = 0
  for (const h of holes) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const cur = world.at(bot, h.x, h.y, h.z)
    if (!cur || world.isSolid(cur)) continue
    const filler = inv.items(bot).find(i => /^(dirt|coarse_dirt)$/.test(i.name))
    if (!filler) { log('build', 'out of dirt to fill holes with'); break }
    if (!world.isAirish(cur) && !world.isLiquidWater(cur)) await act.dig(bot, h, { force: true, allowZones: ['build', 'base'], timeoutMs: 4000 })
    if (!act.reach(bot, h, 4.3)) {
      const r = await goSite(bot, new goals.GoalNear(h.x, h.y + 1, h.z, 3), 'fill')
      if (!r.ok && !act.reach(bot, h, 4.8)) { failLeftover(bot, h); continue }
    }
    if (await act.place(bot, h, filler.name, { allowZones: ['build', 'base'], sneak: false })) fixed++
    else failLeftover(bot, h)
  }
  surveyCache = null
  log('build', `filled ${fixed} of ${holes.length} holes round the ${job.name}`)
  return fixed
}

// ---- completion: derived from the world, never latched --------------------------------------------
let surveyCache = null // { at, v }
// (scaffold and holes are only looked for once every cell stands - until then there is building to do anyway;
//  `full` asks for them regardless)
function survey (bot, maxAgeMs = 0, { full = false } = {}) {
  if (!job) return null
  if (surveyCache && Date.now() - surveyCache.at <= maxAgeMs && (!full || surveyCache.v.full)) return surveyCache.v
  const st = status(bot)
  const look = site && (full || st.done === st.total)
  const v = { cellsLeft: st.total - st.done, unknown: st.unknown, snapshot: !!site, full: !!look, scaffold: look ? scaffoldList(bot) : [], holes: look ? holesList(bot) : [] }
  surveyCache = { at: Date.now(), v }
  return v
}
// Every cell stands (in loaded chunks - unloaded counts as not known, so not complete), no scaffold is
// left and no hole in the ground.
function complete (bot) {
  const s = survey(bot)
  return !!s && s.cellsLeft === 0 && s.snapshot && !s.scaffold.length && !s.holes.length
}
function siteLoaded (bot) {
  if (!job) return false
  const r = siteRegion(job)
  for (const [x, z] of [[r.x1, r.z1], [r.x2, r.z1], [r.x1, r.z2], [r.x2, r.z2]]) if (!world.at(bot, x, job.box.y1, z)) return false
  return true
}
// Does the site want the builder? Near it: anything left (a missing cell - a creeper hole is a repair -,
// scaffold, a hole) that isn't resting until tomorrow. Away from it: the last look said so, or the last
// look is a Minecraft day old (go and see - cheap upkeep, never a spin: at most one check a day when done).
let lastCheckWrite = 0
function needsWork (bot) {
  if (!job) return false
  if (!siteLoaded(bot)) {
    const m = mem.get().siteCheck
    return !m || !m.complete || Date.now() - m.at > 20 * 60000
  }
  ensureSnapshot(bot)
  const s = survey(bot, 15000)
  const done = s.cellsLeft === 0 && s.snapshot && !s.scaffold.length && !s.holes.length
  const m = mem.get().siteCheck
  if (!m || m.complete !== done || Date.now() - lastCheckWrite > 5 * 60000) { lastCheckWrite = Date.now(); mem.set('siteCheck', { at: Date.now(), complete: done }) }
  if (done) return false
  if (s.cellsLeft > 0 || !s.snapshot) return true
  return s.scaffold.some(p => !resting(bot, p)) || s.holes.some(p => !resting(bot, p))
}
// Every cell stands: the finishing round - leftover obstructions, scaffold down, holes filled. Returns
// true when it changed something (nothing changed = the director backs off).
async function finish (bot, { shouldStop } = {}) {
  if (!job) return false
  if (!ensureSnapshot(bot)) return false
  // from afar every walk to a scaffold block would time out and count against it: be there first
  const bx = job.box; const mid = { x: Math.round((bx.x1 + bx.x2) / 2), y: bx.y1, z: Math.round((bx.z1 + bx.z2) / 2) }
  if (world.dist2(bot.entity.position, mid) > 40) {
    const r = await move.travel(bot, mid, { range: 8, shouldStop, label: 'to site' })
    if (!r.ok) return false
  }
  const s0 = survey(bot)
  log('build', `${job.name}: every block stands - finishing (${s0.scaffold.length} scaffold, ${s0.holes.length} holes in the ground)`)
  // what matters first: stray blocks, then our scaffold down, then the ground; the leftover canopy leaves last (a
  // day of leaf-clearing walks left the scaffold standing, 2026-09-23 - and leaves are taken without towering)
  let did = await clearSite(bot, { finishing: true, shouldStop, leaves: false })
  if (s0.scaffold.length || s0.holes.length) await ensureScaffold(bot, 32, { shouldStop }).catch(() => {})
  // the ground first - a minute's work, and behind the day-long teardown it never got a turn before dusk
  did += await finishSite(bot, { shouldStop })
  did += await removeScaffold(bot, { shouldStop })
  did += await clearSite(bot, { finishing: true, shouldStop })
  surveyCache = null
  if (complete(bot)) { log('build', `${job.name} complete: every block in place, no scaffold, the ground made good`); mem.set('siteCheck', { at: Date.now(), complete: true }) }
  return did > 0
}

function getJob () { return job }
function snapshotInfo (bot) {
  if (!job) return null
  const r = siteRegion(job)
  return { taken: !!site, at: site && site.at, file: siteFile(job), region: r, kinds: site ? site.palette.length : 0, loaded: siteLoaded(bot) }
}

// Filler blocks to stand on while building high (the planner towers with them).
async function ensureScaffold (bot, n = 32, { shouldStop } = {}) { // (shouldStop: the caller's day - a top-up is never a night descent)
  // cobblestone counts: the pack carries hundreds for the walls and the planner towers on it. Asking for dirt first sent
  // the bot to dig grass at the foot of the west cliff it could not reach, twenty seconds a block for ten minutes, with
  // 250 cobblestone in the pack (2026-09-27). Dirt is dug only when there is no cobblestone either.
  const filler = () => inv.items(bot).filter(i => FILLER_ITEMS.test(i.name) || i.name === 'cobblestone').reduce((s, i) => s + i.count, 0)
  if (filler() >= n) return true
  const base = require('./base')
  for (const name of ['andesite', 'diorite', 'tuff', 'dirt', 'cobbled_deepslate', 'cobblestone']) {
    const have = filler()
    if (have >= n) return true
    if (base.bankCount(name) > 0) await base.withdraw(bot, name, n - have).catch(() => 0)
  }
  // (none banked: cobblestone from the mine at home first - the castle burns it as stone anyway, and the mine is a
  //  known walk; the surface dirt round home is protected ground, so "27 dirt" explored 104 blocks out, and the
  //  pathfinder stepped the bot into a roofed water pocket there - drowned with 390 items, 2026-09-28. Dirt only
  //  when the mine gave nothing.)
  if (filler() < n / 2) {
    const short = n - filler()
    log('build', `getting ${short} cobblestone from the mine to scaffold with`)
    await require('./craft').ensure(bot, 'cobblestone', inv.count(bot, 'cobblestone') + Math.max(short, 32), { noWithdraw: true, shouldStop }).catch(() => false)
  }
  if (filler() < n / 2) { log('build', `getting ${n - filler()} dirt to scaffold with`); await require('./craft').ensure(bot, 'dirt', inv.count(bot, 'dirt') + (n - filler()), { noWithdraw: true, shouldStop }).catch(() => false) }
  return true
}

module.exports = { cachedStatus, exactWood, isOpenCell, INFILL_RE, infillItem, unsourced, strayBuildBlocks,
  finishSite, woodClass, woodForm, acceptsFor, itemOf, LOG_ANY, PLANKS_ANY, ensureScaffold, unskippedObstructions, setJob, getJob, status, nextNeeds,
  buildStep, clearSite, obstructions, removeScaffold, loadSchematic, cellDone, cellsDone, inBox, placeCell, registerJob, key,
  complete, needsWork, finish, survey, scaffoldList, holesList, ensureSnapshot, snapshotInfo, snapName,
  // pure helpers (offline checks)
  describe, plansFor, predict, yawOf, facingOfYaw, wantOf, nameOk, partOk, itemForBlock, thenItem, stepOf, stepItem, needsOf, propsOf, KEY_PROPS, COUNT_PROPS
}
