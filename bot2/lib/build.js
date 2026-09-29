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

// FOUR LISTS, four questions - never "unify" them (audit 2026-09-28):
//  SCAFFOLD_RE: is a block standing in the world plausibly scaffold (a scan's guess - no cobblestone: the castle has cobble cells)
//  FILLER_ITEMS: what may we PLACE as a support or pillar (cobblestone yes; granite no - a build course)
//  LEDGER_RE: a spot we recorded placing filler at - still ours to take away (both of the above)
//  STRAY_RE: what counts as leftover round the site after the build (plugs too)
const SCAFFOLD_RE = /^(dirt|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|coarse_dirt)$/
// (granite is not filler: the basilica's brick course is polished granite, and scaffold spends it by the stack)
// (cobblestone too: "no filler for a temporary support" with 250 of it in the pack, 2026-09-27; what is left of it in
//  the footprint comes down with the site clearing)
const FILLER_ITEMS = /^(dirt|andesite|diorite|tuff|cobbled_deepslate|netherrack|coarse_dirt|cobblestone)$/
const LEDGER_RE = new RegExp('^(?:' + FILLER_ITEMS.source.slice(1, -1) + '|' + SCAFFOLD_RE.source.slice(1, -1) + ')$') // (what we place, plus the old scan's kinds: follows FILLER_ITEMS)
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
  // a grindstone hangs on nothing, but its state comes from the face clicked all the same: vanilla puts the clicked face's
  // opposite FIRST among the looking directions (BlockPlaceContext), so a side face gave a wall grindstone whatever
  // the pitch - "came out face=wall" three times, the stone dug out and crafted again each time (2026-09-28)
  if (FACE_ATTACHED_RE.test(c.name) && !c.attach && w.face) {
    if (w.face === 'floor') return [withYaw({ off: [0, -1, 0] })]
    if (w.face === 'ceiling') return [withYaw({ off: [0, 1, 0] })]
    return DIRS[w.facing] ? [withYaw({ off: DIRS[w.facing].map(v => -v) })] : []
  }
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
  // (the clicked face's opposite is the first looking direction - BlockPlaceContext - and every face-attached thing
  //  survives on what was clicked, so it decides: the look gives only a floor/ceiling one's facing)
  if (FACE_ATTACHED_RE.test(n)) {
    const first = OPP[faceDir]
    if (DIRS[first][1]) { out.face = first === 'up' ? 'ceiling' : 'floor'; if (look) out.facing = look } else { out.face = 'wall'; out.facing = faceDir }
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
  detached.clear() // (the stockless verdicts are the old job's: this one's own stock decides them afresh)
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
// The layer the builder's band rises from - and the director's "next layers" window: ONE anchor for both.
// A cell whose item is nowhere - not in the pack, not in the bank - holds nothing down: its trip is wanted all the same
// (nextNeeds counts every cell below the window), but the walls rise past it and it goes in when the item comes. Forty
// bricks of the base layer, the clay a day away, kept a 13,888-block castle to its lowest four layers - 14 blocks in an
// hour, "waiting on bricks" every step (2026-09-28).
// DETACHED until there is enough to go back for: an item out of stock stays out of the band - of the anchor AND of the
// cells in hand - until its stock covers its lowest layers' cells (a stack at most). Re-anchored by the first four bricks
// out of a furnace, the band would walk down for four, run dry and jump back up every batch (audit 2026-09-28).
const detached = new Set()
function detachedItems (todo, bot) {
  const have = Object.assign({}, base().bankCounts())
  for (const [n, k] of Object.entries(inv.counts(bot))) have[n] = (have[n] || 0) + k
  const low = {} // item -> {y: its lowest cell, n: its cells in that layer and the next}
  const band = todo.filter(c => !c.attach && !c.follows && !infillCell(c) && !((cellFails.get(key(c)) || {}).n >= 1)).map(c => [c, stepItem(bot, c)])
  for (const [c, it] of band) if (!low[it] || c.y < low[it].y) low[it] = { y: c.y, n: 0 }
  for (const [c, it] of band) if (c.y <= low[it].y + 1) low[it].n++
  for (const it of Object.keys(low)) {
    const k = have[it] || 0
    if (k <= 0) detached.add(it)
    else if (detached.has(it) && k >= Math.min(low[it].n, 64)) detached.delete(it)
  }
  for (const it of [...detached]) if (!low[it]) detached.delete(it) // (none of it left to place)
  return detached
}
// A cell the band may anchor on: THE one predicate - lowestStructural's minimum, the step's anchor and whether a waited-on
// item holds the band all read it (audit 2026-09-29: three spelled-out copies)
// (a foundation cell anchors nothing: the rim's cells on the trench are slow and many rest, and anchored they held the
//  whole castle to its lowest layers - 3 blocks an hour, the builder placing one and "waiting", 2026-09-28. They go in
//  whenever they can - the doable set takes them outside the band - from their stands outside)
// (and a falling block over a cell still waiting - powder over a brick gap - can't go in either: it anchoring would pin
//  the band a layer up instead of at the gap; audit 2026-09-28)
function anchorable (bot, c, det) {
  if (c.attach || c.follows || c.foundation || infillCell(c) || (cellFails.get(key(c)) || {}).n >= 1) return false
  return !(det && (det.has(stepItem(bot, c)) || fallsIn(bot, c, stepItem(bot, c))))
}
function lowestStructural (todo, bot, det = bot ? detachedItems(todo, bot) : null) {
  let m = Infinity
  for (const c of todo) {
    if (c.y < m && anchorable(bot, c, det)) m = c.y
  }
  return m
}
// A block that falls (sand, gravel, concrete powder, an anvil) goes in only onto something solid NOW: over a cell still
// waiting - a brick gap the band rose past - it drops into the gap. Scaffolding stands on scaffolding beside it too.
const GRAVITY_RE = /^(chipped_|damaged_)?anvil$|^scaffolding$/ // (with world.FALLING_RE: sand, gravel, concrete powder)
function fallsIn (bot, c, item) {
  if (!world.FALLING_RE.test(item) && !GRAVITY_RE.test(item)) return false
  if (world.isSolid(world.at(bot, c.x, c.y - 1, c.z))) return false
  if (item === 'scaffolding') return ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const b = world.at(bot, c.x + dx, c.y, c.z + dz); return b && b.name === 'scaffolding' })
  return true
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
  let done = 0; let unknown = 0; let total = 0
  const md = world.data(bot)
  const need = {}
  // (the foundation is no part of the blueprint: out of total/done - the watchdog's blocks an hour, the brain's "how
  //  far", the percent - and said on its own; its cobblestone is in the need all the same)
  const fd = { placed: 0, left: 0 }
  for (const c of job.cells) {
    const d = cellDone(bot, c)
    if (c.foundation) { if (d === true) fd.placed++; else { fd.left++; needsOf(bot, c, md, (it, n) => { need[it] = (need[it] || 0) + n }) } continue }
    total++
    if (d === true) { done++; continue }
    if (d === null) unknown++
    needsOf(bot, c, md, (it, n) => { need[it] = (need[it] || 0) + n })
  }
  const out = { name: job.name, total, done, unknown, need }
  if (job.foundation && (fd.placed || fd.left)) out.foundation = Object.assign(fd, { dropped: job.foundation.dropped || 0 })
  return out
}
// Items for the cells from the lowest unfinished layer up to `layers` above it (the window the builder
// works in), plus attached cells whose support already stands. Same keying as status().need.
function nextNeeds (bot, layers = 4) {
  if (!job) return {}
  const md = world.data(bot)
  const todo = job.cells.filter(c => !c.follows && cellDone(bot, c) !== true)
  const minY = lowestStructural(todo, bot)
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
  // (never sprinting on the site: a sprint-jump up onto a one-wide wall top carried the body over its far edge - six falls of
  //  4-6 blocks off the walls in a morning, each a jump at y121-123 with the drop on the outer side, 2026-09-29. The walks
  //  here are a few dozen blocks; a player walks a wall top)
  const m = move.movementsFor(bot, { dig: !!dig, place, allowZones: ['build', 'base'], placeCost: 12, sprint: false, edgeCost: 6 }) // (the site's scaffold is ledgered and torn down: a step placed here is no litter - but no bargain either: at 3 the walks laid 21 blocks in a step, the builder's supports then had no filler (5 misses), and each such block is ~15s of teardown later against ~0.45s a step walked round; 12 = a detour of a dozen steps, 2026-09-29)
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
    const out = await move.travel(bot, h || { x: job.origin.x - 8, y: job.origin.y, z: job.origin.z - 8 }, { range: 6, label: 'out from under the build' }).catch(() => null)
    // (no walk out - the rim closed round the hollow as its foundation went in: the climb straight up, which takes our own
    //  floor block over the head and the builder puts it back. Leg after leg "stuck" from a cell a step off the last one
    //  never tripped the same-cell climb, 2026-09-29)
    void out // (a leg failed below the floor climbs out inside move.travel itself - one rule for every walk; audit)
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
  // (a fallback after a walk has already failed, so it is bounded: a door whose step on our side is no place to stand is
  //  not walked to, and the first door the walk cannot reach ends it - 3 doors x 90s after every failed walk, 23
  //  "couldn't reach the step" in a day, 2026-09-28; audit)
  for (const d of doors.slice(0, 3)) {
    const alongZ = d.props.facing === 'north' || d.props.facing === 'south'
    const sides = alongZ ? [{ x: d.x, y: d.y, z: d.z - 1 }, { x: d.x, y: d.y, z: d.z + 1 }] : [{ x: d.x - 1, y: d.y, z: d.z }, { x: d.x + 1, y: d.y, z: d.z }]
    const near = sides.filter(q => world.standable(bot, q.x, q.y, q.z)).sort((a, b) => world.dist3(me, a) - world.dist3(me, b))[0]
    if (!near) continue
    // (the bot's everyday walker, with its own recoveries: the site runGoal got "stuck" in the canopy every time)
    const r0 = await move.travel(bot, near, { range: 1, label: 'to the door', maxMs: 90000 })
    if (!r0.ok) { log('build', `couldn't get to the ${d.name.replace('_door', '')} door at ${move.fmt(d)} (${r0.why})`); if (/timeout|stuck/.test(r0.why || '')) return null; continue } // (a long walk that failed ends it; a quick noPath tries the next door - audit)
    if (!await move.crossDoor(bot, goal).catch(() => false)) return null // (at the door and could not cross: the next door is no better bet)
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
    // (but a FOUNDATION cell of filler - the rim wall, a hole's column - takes a filler block as its own: a tower up it is
    //  the fill itself. Refused, the climb out of a hole column under an open trapdoor found "no tower - a cell of the
    //  build" and the bot sat in the hollow, 2026-09-29. Not a soil top under a plant: that one wants dirt only)
    if (purpose === 'fill') { if (c.foundation && c.name === 'cobblestone') continue; return true }
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
  const record = p => { supportsLaid++; mem.update(m => { m.scaffold = m.scaffold || []; m.scaffold.push({ x: p.x, y: p.y, z: p.z }) }) }
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
// (a face of a block that is USED when clicked - a chest, a furnace, a door - is a face to place against whenever the click
//  goes out sneaking, as a player sneak-clicks it: every cell but a door and a chest's pair. Only attached cells had it:
//  31 floor trapdoors beside the castle's chests were "none clickable" for days, the band held at y119, 2026-09-29)
function sneaksFor (c) { return !/_door$/.test(c.name) && !pairs(c) }
function refOk (bot, c, p) {
  const nb = world.at(bot, c.x + p.off[0], c.y + p.off[1], c.z + p.off[2])
  return act.refUsable(nb, !!c.attach || sneaksFor(c))
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
// THE LADDER DOWN WHEN DONE WITH: the pillar pillarTo raised to reach a high cell comes down from on top - dig the block
// under the feet, drop one, again - before the builder walks to a cell the pillar top does not reach, and at the step's
// end. Left standing till the whole build was done, 391 blocks of pillars stood round the castle for days: the operator
// asked what they were, and they blocked the stands the rim's foundation needed (2026-09-28).
let myPillar = []
async function descendPillar (bot) {
  const ours = q => myPillar.some(p => p.x === q.x && p.y === q.y && p.z === q.z)
  for (let guard = 0; guard < 20 && myPillar.length; guard++) {
    const me = bot.entity.position; const under = { x: Math.floor(me.x), y: Math.floor(me.y - 0.01), z: Math.floor(me.z) }
    if (!ours(under)) break
    // (a pillar block standing in a cell of the build that wants just that is the build now - never dug)
    { const bc = job && job.index.get(key(under)); if (bc && !bc.clear && cellDone(bot, bc) === true) break }
    // (nor one a finished attached cell hangs on - a torch or lantern put on the pillar's side when it was the only
    //  neighbour; audit)
    if (job && job.cells.some(q => q.sup && q.sup.x === under.x && q.sup.y === under.y && q.sup.z === under.z && cellDone(bot, q) === true)) break
    if (!await act.dig(bot, new Vec3(under.x, under.y, under.z), { force: true, own: true, noWalk: true, allowZones: ['build', 'base'], timeoutMs: 6000 }).catch(() => false)) break
    const t0 = Date.now(); while (!bot.entity.onGround && Date.now() - t0 < 1500) await act.sleep(50)
    myPillar = myPillar.filter(p => !(p.x === under.x && p.y === under.y && p.z === under.z)); pillarDug++
  }
  // (what could not come down - walked off it, a block that would not dig - is the site's scaffold still: the site diff
  //  and the finish take it; forgotten here so no later walk digs under someone else's feet)
  myPillar = []
}
async function pillarTo (bot, c, first) {
  const feet = feetFor(bot, c).filter(f => !footBad(f)).slice(0, 3)
  if (first && !feet.some(f => f.x === first.x && f.z === first.z)) feet.unshift(first)
  const stuckAt = [] // (feet that could not be reached this time: the others near them lie in the same ground)
  for (const f of feet.slice(0, 3)) {
    if (stuckAt.some(q => Math.abs(q.x - f.x) <= 3 && Math.abs(q.z - f.z) <= 3)) continue
    // (the site walker: it goes in through the build's doors - the nave is walled round)
    const r = await goSite(bot, new goals.GoalBlock(f.x, f.y, f.z), 'to the foot of a pillar')
    // (a foot that could not be reached rules out the feet NEAR it - same ground - never the rest: a wall cell has feet on
    //  both sides, and the inside one on the wall walk is the one that works. Three stuck walks of 8s in one patch cost
    //  the south wall's high cells 24-32s each, more than half the step; audit 2026-09-28)
    if (!r.ok) { if (move.isVerdict(r)) badFeet.set(key(f), Date.now()); log('build', `pillar for ${c.name} at ${move.fmt(c)}: couldn't reach its foot ${move.fmt(f)} (${r.why})`); if (/stuck|noPath/.test(r.why || '')) stuckAt.push(f); continue }
    await ensureScaffold(bot, 16, { shouldStop: stepStop })
    // (the planner let go of first: its goal left standing, it set the controls every tick and the tower's jump never
    //  held - "towered to y120" 24 times in an hour on the nave floor, where the same tower rose in the yard, 2026-09-27)
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    await act.sleep(100)
    for (let i = 0; i < 16 && Math.floor(bot.entity.position.y) < c.y - 1; i++) {
      if (!await require('./gather').towerUp(bot, { allowZones: ['build', 'base'], builder: true, onPlaced: q => { myPillar.push(q); pillarLaid++ } })) break
    }
    if (act.reach(bot, new Vec3(c.x, c.y, c.z), 4.8)) return true
    log('build', `pillar for ${c.name} at ${move.fmt(c)}: towered from ${move.fmt(f)} to y${Math.floor(bot.entity.position.y)}, still out of reach`)
  }
  return false
}
let lastPlaceFail = ''
// (where a try's time goes, for the step profile: the walk into reach (with its pillars), the digs clearing the cell - the
//  rest is the place itself; 22% of castle time went to placing at ~2s a block, 2026-09-28 - measured, not guessed)
const placeProf = { reach: 0, dig: 0 }
const sealSaid = new Set() // (cells covered for want of a route: said once)
const timed = async (k, p) => { const t = Date.now(); try { return await p } finally { placeProf[k] += Date.now() - t } }
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
    if (!await timed('dig', act.dig(bot, pos, own))) return why(`could not dig the ${cur.name} in the cell`)
    cur = bot.blockAt(pos)
  }
  // a two-block block needs its second cell clear (a scaffold block or a leaf in a door's top, a bed's head)
  const twin = c.twin && { x: c.x + c.twin[0], y: c.y + c.twin[1], z: c.z + c.twin[2] }
  if (twin && !step) {
    const t = world.at(bot, twin.x, twin.y, twin.z)
    if (t && !world.isAirish(t) && !world.isLiquidWater(t) && !act.REPLACEABLE_RE.test(t.name)) { if (!await timed('dig', act.dig(bot, t.position, own))) return why(`could not clear the ${t.name} out of its second cell`) }
  }
  // Within reach of the cell, by the site walker: `faces` the faces to see, or none (a step onto a block that stands).
  // (where the miss was from: the body's cell and its height against the cell - down the slope or up to it; audit)
  const whereFrom = () => { const me = world.feetPos(bot); return ` - from ${me.x},${me.y},${me.z}, ${me.y - c.y >= 0 ? '+' : ''}${me.y - c.y} to the cell, ${world.dist3(me, c).toFixed(1)}b off` }
  const getInReach = async (faces) => {
    // A CELL HIGH OVER ITS FLOOR: pillar up from the floor beside it first. Left to find its own way, the planner climbed
    // onto the rose window's one-wide ring 8 over the plaza and stuck there, cell after cell (2026-09-27).
    let pillared = false
    // A FOUNDATION CELL: a stand below it on the OUTSIDE first - the trench floor or the slope foot, as a player builds a
    // retaining wall - not a sight line from a pillar 5 off across a 3-wide gap: every south rim cell was "stuck"
    // (2026-09-28). Never from the hollow inside: its last rim cell would wall the bot in under the floor (audit)
    if (c.foundation && !act.reach(bot, pos, 4.3)) {
      const st = foundationStand(bot, c)
      // (an OUTSIDE stand is walked to from the outside: never through the castle's doors - the rim's trench lies below the
      //  floor, and the door fallback crossed the south-west rooms toward it, 40s a cell, 8 cells a step, 2026-09-29. Far
      //  or round the build, the long walk's legs; once down there, the in-reach cells round it go in before it leaves)
      if (st) {
        const r1 = await goSite(bot, new goals.GoalBlock(st.x, st.y, st.z), 'place', { doors: false }).catch(() => null)
        if ((!r1 || !r1.ok) && !act.reach(bot, pos, 4.3) && !c.hole) await move.travel(bot, st, { range: 0, label: 'to the rim from outside', maxMs: 90000, shouldStop: stepStop || undefined }).catch(() => null)
      }
      // (from its outside stand or not at all: the planner's own way to a rim cell led from the castle floor into the hollow
      //  under it, walled in by then - fifteen minutes "stuck" under the build, 2026-09-28. It rests; the outside is tried again)
      // (an outside stand that was not reached: the next try goes from inside the hollow if one is safe - the same outside
      //  stand was chosen and missed every step, and the inside pass never ran, 2026-09-29)
      if (!act.reach(bot, pos, 4.3)) { if (st) c.noOutside = true; return why(st ? 'its outside stand was not reached' : 'no stand outside the build to place it from') }
    }
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
      if (!up && !act.reach(bot, pos, 4.8)) return why(`could not get within reach (${r.why}; no pillar up to it)${whereFrom()}`)
    } else if (!r.ok && !act.reach(bot, pos, 4.8)) return why(`could not get within reach (${r.why})${whereFrom()}`)
    return true
  }
  if (!step) {
    // after three failures with its own axis, a log takes any face
    if (c.want && c.want.axis && !axisRelaxed(c) && failsOf(c) >= 3 && !(cellFails.get(key(c)) || {}).shared) { relaxAxis(c); log('build', `${c.name} at ${move.fmt(c)} goes in with any axis (nothing to place it against on its own side)`) }
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
    if (!await timed('reach', getInReach(usable.map(p => new Vec3(p.off[0], p.off[1], p.off[2]))))) return false
    const opts = { plans: usable.length ? usable : plans, allowZones: ['build', 'base'], keepExit: true }
    // (a liquid source is poured from its bucket; everything else placed - a pot or a cauldron is its first step. A
    //  chest of a pair is placed standing up: a sneaking placement never pairs)
    const ok = c.pour
      ? await act.pour(bot, c, item.name, Object.assign(opts, { accept: b => nameOk(c, b.name) && String(propsOf(b).level) === '0' }))
      : await act.place(bot, c, item.name, Object.assign(opts, { accept: b => partOk(c, b.name), sneak: !/_door$/.test(item.name) && !pairs(c), twin: c.twin || null, useRefs: !!c.attach || (!/_door$/.test(item.name) && !pairs(c)) }))
    if (!ok) return why(c.pour ? 'the pour itself failed' : 'the place itself failed')
    surveyCache = null
  } else if (!await timed('reach', getInReach(null))) return false
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
    // (through useOn: a raw activateBlock under the ledge crouch was a sneaking click that opened nothing - trapdoors
    //  left shut, taken out and placed again, 2026-09-28. A gate turns to the opener's look when opened from its
    //  front, so it is opened looking the way it faces)
    const gate = /_fence_gate$/.test(c.name) && DIRS[c.want.facing] && !DIRS[c.want.facing][1]
    if (open != null && open !== c.want.open) await act.useOn(bot, pos, null, { accept: b => String(propsOf(b).open) === c.want.open, allowZones: ['build', 'base'], yaw: gate ? yawOf(c.want.facing) : null })
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
let supportsLaid = 0; let pillarLaid = 0; let pillarDug = 0 // (the builder's own supports, pillar blocks up and down - the step profile)
const cellFails = new Map(Object.entries((mem.get().cellFails) || {})) // key -> {n, at}
// (only cells of the job are kept: a cell finished by any other way - a restart, a hand - is dropped at the next save; audit #38)
// (no throttle of its own: memory.save coalesces a burst into one write since 5ca11ef, and the old 5s throttle DROPPED the
//  last write of a burst - the step-end misses never reached memory and a restart brought a never-ready log back to
//  anchor the band, 2026-09-29; audit)
function saveCellFails () { const o = {}; for (const [k, v] of cellFails) { if (job && !job.index.has(k)) { cellFails.delete(k); continue } o[k] = v } mem.set('cellFails', o) }
// A reach miss is the GROUND's: the cells round it (3 across, a layer up or down) share the missed cell's rest, count and
// all. Held back for one step only, each round tried the next cell of the same patch - the south-west hollow's foundation
// took 7 walks of 46s for 1 block, round after round (2026-09-29). A block placed beside them still wakes them.
function restRound (c, ready, holdBack) {
  const f = cellFails.get(key(c)); let n = 0
  for (const q of ready) {
    if (q === c || Math.abs(q.x - c.x) > 3 || Math.abs(q.z - c.z) > 3 || Math.abs(q.y - c.y) > 1) continue
    holdBack.add(key(q)); n++
    const g = cellFails.get(key(q))
    if (f && (!g || g.n < f.n)) cellFails.set(key(q), { n: f.n, at: f.at, shared: true }) // (shared: no count of its own - a log's axis stays)
  }
  if (n) saveCellFails()
  return n
}
function failsOf (c) { const f = cellFails.get(key(c)); return f ? f.n : 0 }
let stepStop = null // (the running build step's stop - a pillar's scaffold top-up inside it keeps the step's day)
async function buildStep (bot, opts = {}) {
  try { return await buildStepInner(bot, opts) } finally { if (myPillar.length) await descendPillar(bot).catch(() => {}) }
}
async function buildStepInner (bot, { shouldStop, maxMs = 10 * 60000 } = {}) {
  stepStop = shouldStop || null
  const t0 = Date.now(); const supports0 = supportsLaid; const pl0 = pillarLaid; const pd0 = pillarDug
  let placed = 0
  if (!ensureSnapshot(bot) || !ensureFoundation(bot)) return { placed, blockedOn: null, done: false }
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
  let waitingCell = null
  let waitingHolds = false // (the item named holds the band up - not a detached one, named only because nothing else is missing)
  const badStands = new Set() // (stands whose walk failed this step: clusterStand passes them by)
  const holdBack = new Set() // (cells that would wall the body in from where it stands: later this step, or the next - wallsMeIn)
  // (where a step's time goes: choosing the cell, walking to and placing it - measured, not guessed)
  const prof = { tries: 0, ms: 0, okMs: 0, dist: 0, pick: 0, why: {} }; let tpick = Date.now()
  // (the misses by their reason - "stand not reached", "could not get within reach", "nothing to click"...: which failure
  //  class the step's time goes to, the numbers stripped; audit 2026-09-29)
  const missed = (why, ms) => { const k = String(why || 'unlogged').replace(/\s*[-(].*$/, '').replace(/-?\d+/g, '#').slice(0, 40) || 'unlogged'; const e = prof.why[k] || (prof.why[k] = { n: 0, ms: 0 }); e.n++; e.ms += ms }
  placeProf.reach = 0; placeProf.dig = 0
  const profLog = () => { if (prof.tries) log('build', `step profile: ${placed}/${prof.tries} placed, ${Math.round(prof.ms / prof.tries)}ms a try (${placed ? Math.round(prof.okMs / placed) : 0}ms a placed block), ${(prof.dist / prof.tries).toFixed(1)} blocks off on average, ${Math.round(prof.pick / Math.max(1, prof.tries))}ms choosing each; a try: ${Math.round(placeProf.reach / prof.tries)}ms getting in reach, ${Math.round(placeProf.dig / prof.tries)}ms clearing, ${Math.round((prof.ms - placeProf.reach - placeProf.dig) / prof.tries)}ms placing; ${Math.round((prof.ms - prof.okMs) / 1000)}s of ${Math.round(prof.ms / 1000)}s on the ${prof.tries - placed} misses${Object.keys(prof.why).length ? ' (' + Object.entries(prof.why).sort((a, b) => b[1].ms - a[1].ms).slice(0, 4).map(([k, e]) => `${k} x${e.n} ${Math.round(e.ms / 1000)}s`).join(', ') + ')' : ''}; the walks laid ${reflex.plannerPlacedSince(t0).filter(q => q.x >= job.box.x1 - 3 && q.x <= job.box.x2 + 3 && q.z >= job.box.z1 - 3 && q.z <= job.box.z2 + 3).length} blocks on the site, the builder ${supportsLaid - supports0} supports, ${pillarLaid - pl0} pillar blocks up, ${pillarDug - pd0} taken back down`) } // (where the site's scaffold comes from - ~1 a castle block, 2026-09-29)
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
    const det = detachedItems(todo, bot)
    const lowestAll = lowestStructural(todo, bot, det)
    // (what ANCHORS the band: the one definition - the step's end lines name it, and an item "holds" only when its cell is
    //  one: a trapdoor - infill - was said to hold the castle for two hours while a lightning rod did; audit 2026-09-29)
    const anchors = c => c.y === lowestAll && anchorable(bot, c, det)
    const items = inv.items(bot)
    // (a cell half-way - an empty pot - waits on its next step's item, the plant)
    // (a two-step cell is ready only with both steps' items in hand: the pot went in without its flower, the step "failed"
    //  and rested, and a second walk came later for the plant - 5 of a step's 16 misses, 2026-09-28)
    const has = c => (stepOf(c, world.at(bot, c.x, c.y, c.z)) === 'then' ? items.some(i => i.name === c.then) : !!pickItem(bot, c, items) && (!c.then || items.some(i => i.name === c.then)))
    // what the band is really held up by: a structural cell of the lowest layers first. A carpet or a pot holds
    // nothing up - reported first, the director chased unreachable sheep for "red_carpet" while two granite stairs
    // and twelve panes (sand) were what kept the walls from rising (2026-09-23)
    const missingItem = () => {
      // (an item with none in stock is DETACHED - the band rises past it, by the builder's own rule - so it holds nothing up
      //  and is no bottleneck: named first, the director spent the young day on 15 note blocks' chain - redstone, an iron
      //  pickaxe, the iron's fuel - while the walls waited on nothing of it, 2026-09-28. Named last, once nothing else is)
      const lowAll = todo.filter(c => !c.attach && !c.follows && !cellUnsourced(c) && c.y <= lowestAll + 1)
      const low = lowAll.find(c => !has(c) && anchors(c)) || lowAll.find(c => !has(c) && !det.has(stepItem(bot, c))) // (the anchor's own missing item first)
      // (then infill waiting on its material - glass: the sand trips are still wanted, only the layers don't wait)
      const m = low || todo.filter(c => c.attach && !cellUnsourced(c) && supportThere(bot, c)).find(c => !has(c)) || todo.filter(c => infillCell(c) && !cellUnsourced(c) && c.y <= lowestAll + 1).find(c => !has(c)) || todo.filter(c => infillCell(c) && !cellUnsourced(c)).sort((a, b) => a.y - b.y).find(c => !has(c)) || lowAll.find(c => !has(c))
      // (the item really missing: a pot in hand and its flower not is waiting on the flower - named for the director; audit)
      waitingCell = m || null
      return m ? (stepOf(m, world.at(bot, m.x, m.y, m.z)) !== 'then' && m.then && pickItem(bot, m, items) ? m.then : stepItem(bot, m)) : null
    }
    // the lowest two layers of what we HAVE the blocks for: 24 missing glass panes in a wall no longer hold up
    // every brick above them (the windows go in when the glass comes)
    const structural = todo.filter(c => !c.attach && !c.foundation && has(c) && !det.has(stepItem(bot, c)) && !fallsIn(bot, c, stepItem(bot, c)))
    const footing = todo.filter(c => c.foundation && !c.attach && has(c)) // (the foundation: outside the band, lowest first)
    const attached = todo.filter(c => c.attach && has(c) && supportThere(bot, c))
    const minY = structural.length ? Math.min(...structural.map(c => c.y)) : Infinity
    // no more than 3 layers above the lowest unfinished cell: walls rise together, nothing floats far up
    let doable = minY <= lowestAll + 3 ? structural.filter(c => c.y <= minY + 1) : []
    // a door goes in once its floor stands (and its own two cells are ours to clear)
    doable = doable.filter(c => !c.twin || supportThere(bot, c)).concat(attached)
    // (the foundation's cells whose column below them is laid already: the wall rises bottom-up, never a block in the air)
    doable = doable.concat(footing.filter(c => { const b = world.at(bot, c.x, c.y - 1, c.z); return b && world.isSolid(b) }))
    // NEVER SEAL AN EMPTY CELL: a block placed straight over a cell still waiting for its own (coal not yet had), when that
    // cell has no other open side, closes the last way to it - the plank floor went in over the base layer's coal blocks
    // and campfires, and they failed "could not get within reach" every step after (2026-09-28). Covered only once it is
    // filled, or while it keeps an open side (a window in a wall does: inside and out)
    const sealsBelow = c => {
      const b = job.index.get(key({ x: c.x, y: c.y - 1, z: c.z }))
      if (!b || b.clear || cellDone(bot, b) === true) return false
      // (never a deadlock: a cell with no route to its item, or one that has already rested once, is covered - else a whole
      //  floor waits for ever on a hay block no trip can bring; audit 2026-09-28)
      if (cellUnsourced(b)) { if (!sealSaid.has(key(b))) { sealSaid.add(key(b)); log('build', `covering ${b.name} at ${move.fmt(b)} - no route for it`) } return false }
      if (failsOf(b) >= 1 && !(cellFails.get(key(b)) || {}).shared) return false // (its OWN miss only: a patch's shared rest proves nothing about it, and covered it is sealed in and dropped - a hole in the wall; audit)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = b.x + dx; const z = b.z + dz
        const nb = job.index.get(key({ x, y: b.y, z }))
        if (nb && !nb.clear) continue // (a cell of the build: it will be solid)
        const w = world.at(bot, x, b.y, z)
        if (w && !world.isSolid(w)) return false // (an open side stays: reachable from there)
      }
      return true
    }
    doable = doable.filter(c => !sealsBelow(c))
    // (a liquid waits for the ground under it: water poured over the hollow's open column runs down and floods it - the
    //  castle's one base water cell sits over a hole the foundation fills first; audit 2026-09-29)
    doable = doable.filter(c => { if (!c.pour) return true; const b = world.at(bot, c.x, c.y - 1, c.z); return !!b && !world.isAirish(b) }) // (anything but air under it: ground, a slab, the pool's own water below)
    waiting = missingItem()
    waitingHolds = !!waiting && !!waitingCell && anchors(waitingCell)
    if (!doable.length) {
      // (the band as it ended the step - which layer anchors it, and by which cell: a step that ends "waiting on X" after
      //  a few blocks said nothing of what held the band down, 2026-09-28)
      const anchor = todo.find(anchors)
      if (placed) log('build', `step ended: band anchored at y${lowestAll}${anchor ? ' by ' + stepItem(bot, anchor) + '@' + anchor.x + ',' + anchor.y + ',' + anchor.z + (has(anchor) ? ' (in hand)' : ' (not in hand)') : ''}, ${structural.length} structural in hand (min y${minY}), ${todo.length} todo`)
      profLog(); if (!placed) log('build', `nothing doable: lowest structural y${lowestAll}, ${todo.length} todo, ${structural.length} structural in hand (min y${minY}), ${attached.length} attached ready, ${waitingHolds ? 'waiting on ' + waiting : (waiting ? waiting + ' missing (detached - holding nothing)' : 'waiting on nothing')}`); return { placed, blockedOn: waiting, blockedHolds: waitingHolds, done: false } }
    const me = bot.entity.position
    // cells that can be clicked right now first; one whose every face is another unbuilt cell of this
    // build waits for its neighbours (trying it costs ~20s of failed placing, and a wall of x-axis logs
    // placed out of order was nothing but failures)
    const clickable = c => plansFor(c).some(p => refOk(bot, c, p))
    const supportable = c => !c.attach && !c.twin && plansFor(c).some(p => !job.index.has(key({ x: c.x + p.off[0], y: c.y + p.off[1], z: c.z + p.off[2] })))
    const ready = doable.filter(c => !holdBack.has(key(c)) && (clickable(c) || supportable(c)))
    if (!ready.length) {
      // (and what anchors the band there - the lowest cell that holds the layers: the step's end is its reach, not the
      //  item a trapdoor waits on, 2026-09-29)
      const anchor = todo.find(anchors)
      const anc = anchor ? `, band anchored by ${stepItem(bot, anchor)}@${anchor.x},${anchor.y},${anchor.z}${has(anchor) ? ' (in hand)' : ' (not in hand)'}${holdBack.has(key(anchor)) ? ' (held back)' : ''}` : ''
      // (a cell that can never be readied - nothing to click, nothing to prop it on - is never tried, so it never fails,
      //  and a cell that never fails anchors the band for ever: a down-facing lightning rod whose only click face is the
      //  candle that stands on it held the castle at y120 for two hours, 2026-09-29. Unready at the step's end is a miss:
      //  it rests like any, the band rises past it, a block placed beside it wakes it)
      for (const c of doable) if (!holdBack.has(key(c))) failed.set(key(c), (failed.get(key(c)) || 0) + 1)
      // (and a log's axis relaxes on these misses too: that rule lived in the try, and a log never tried - a z-axis oak log
      //  between two unplaced z-axis logs - anchored the band round after round, 2026-09-29)
      for (const c of doable) if (c.want && c.want.axis && !axisRelaxed(c) && failsOf(c) >= 3 && !(cellFails.get(key(c)) || {}).shared) { relaxAxis(c); log('build', `${c.name} at ${move.fmt(c)} goes in with any axis (never ready with its own)`) }
      if (doable.length) saveCellFails()
      profLog(); log('build', `${placed ? `step ended after ${placed} placed - ` : ''}nothing ready${anc}: lowest y${lowestAll}, ${doable.length} doable (${doable.slice(0, 5).map(c => c.name + '@' + c.x + ',' + c.y + ',' + c.z).join(' ')}) none clickable or supportable (${doable.filter(c => holdBack.has(key(c))).length} held back this step), ${waitingHolds ? 'waiting on ' + waiting : (waiting ? waiting + ' missing (detached - holding nothing)' : 'waiting on nothing')}`); return { placed, blockedOn: waiting, blockedHolds: waitingHolds, done: false } }
    // everything within reach of where we stand first, then the nearest - a layer down counts one block, not four:
    // the walk between cells is most of a block's six seconds, and "lower first" sent the bot back and forth across the
    // 50x140 site between two layers (2026-09-27)
    const inReach = c => act.reach(bot, new Vec3(c.x, c.y, c.z), 4.3) ? 1 : 0
    ready.sort((a, b) => (clickable(b) - clickable(a)) * 100 + (inReach(b) - inReach(a)) * 50 + (a.y - b.y) + world.dist3(a, me) - world.dist3(b, me))
    const c = ready[0]
    const tp = Date.now(); const d0 = world.dist3(c, bot.entity.position)
    prof.pick += tp - tpick
    // ONE STAND, MANY CELLS: out of reach of the chosen cell, the walk goes to the stand beside it that reaches the most
    // ready cells, and the in-reach-first order places them all before the next walk. Cell by cell, the walks were 80% of
    // a step - 9.3s a block, the next cell 6-9 blocks off (2026-09-28)
    // (a stand whose walk failed is not tried again this step; and when that walk ran out of time, the cell rests without its
    //  own try - the same ground defeats both, 8s + 14s for one cell; a quick no-path falls through to it; audit)
    // (on our pillar and the next cell out of its reach: down first - the next walk starts from the ground)
    if (myPillar.length && !inReach(c)) await descendPillar(bot)
    let skipTry = false
    // (c.ownWay: a cell whose cluster stand's walk ran out goes its own way next time - placeCell's look-at walk, which may
    //  find a wall top; the same unreachable stand was chosen again every step and the look-at walk never ran; audit)
    if (!c.foundation && !c.ownWay && !inReach(c) && ready.length > 2) {
      const st = clusterStand(bot, c, ready, badStands)
      if (st && st.n >= 3) {
        const tw = Date.now()
        const r = await goSite(bot, new goals.GoalBlock(st.x, st.y, st.z), 'place').catch(() => null)
        placeProf.reach += Date.now() - tw
        if (r && !r.ok) { badStands.add(key(st)); if (/timeout|stuck/.test(r.why || '')) { skipTry = true; c.ownWay = true } }
      }
    }
    if (skipTry) {
      failed.set(key(c), (failed.get(key(c)) || 0) + 1); saveCellFails(); missed('the cluster stand not reached', Date.now() - tp); prof.tries++; prof.ms += Date.now() - tp; prof.dist += d0; tpick = Date.now()
      // (the stand's walk ran out: the cells round it lie behind the same ground - the walled garden's 18 tries were all
      //  this branch, one door crossing each, silent; they wait for the next step)
      const n = restRound(c, ready, holdBack)
      log('build', `${c.name} at ${move.fmt(c)}: its stand could not be reached${n ? ` - ${n} cells round it rest with it` : ''}`)
      continue
    }
    if (wallsMeIn(bot, c)) { holdBack.add(key(c)); log('build', `${c.name} at ${move.fmt(c)} would wall me in from ${move.fmt(world.feetPos(bot))} - later`); tpick = Date.now(); continue }
    const ok = await placeCell(bot, c)
    prof.tries++; prof.ms += Date.now() - tp; prof.dist += d0; if (ok) prof.okMs += Date.now() - tp; else missed(lastPlaceFail, Date.now() - tp)
    tpick = Date.now()
    // (a block placed is a new foothold: the resting cells round it wake - a wall top built is how the south wall's high
    //  cells get their stand; the clock was the only waker. Their count stays, only the rest ends; audit 2026-09-28)
    // (bounded: only a block that could be a stand or a support for it - at or below it, beside it within 2 - and once a
    //  rest: a row laid beside a truly unreachable cell would wake it at every block, a 16s failure each; the next failure
    //  writes a fresh record, and the flag with it; audit 2026-09-28)
    // (and the daily teardown's resting blocks round it: a new stand, the ground changed - their rest ends; audit)
    if (ok && tdMiss.size) { let w = 0; for (const k of [...tdMiss.keys()]) { const [x, y, z] = k.split(',').map(Number); if (Math.abs(x - c.x) <= 2 && Math.abs(y - c.y) <= 2 && Math.abs(z - c.z) <= 2) { tdMiss.delete(k); w++ } } if (w) { const o = {}; for (const [k, v] of tdMiss) o[k] = v; mem.set('teardownMiss2', o) } }
    if (ok) { for (const [k, f] of cellFails) { const [x, y, z] = k.split(',').map(Number); if (f.at && !f.woke && c.y <= y && y - c.y <= 2 && Math.abs(x - c.x) <= 2 && Math.abs(z - c.z) <= 2) { f.at = 0; f.woke = true } } }
    if (ok) { placed++; if (cellFails.delete(key(c))) saveCellFails(); if (placed % 25 === 0) { const st = status(bot); log('build', `${st.done}/${st.total} placed`) } } else if (c.foundation && c.name === 'torch' && !world.isAirish(world.at(bot, c.x, job.box.y1, c.z))) dropFoundation(bot, c, 'the floor over it is laid - no way to it from above') // (a hollow's torch goes in from above or not at all)
    else if (c.foundation && sealedIn(bot, c)) dropFoundation(bot, c, 'sealed in') // (a reach miss rests like any cell: a rim cell faces the outside ground - the miss is the stand's, not the cell's, and dropped it is a hole in the wall; audit 2026-09-28)
    else {
      failed.set(key(c), (failed.get(key(c)) || 0) + 1); saveCellFails(); if (failed.get(key(c)) === 1) log('build', `${c.name} at ${move.fmt(c)} won't place (${lastPlaceFail || 'unlogged'}) - leaving it for later`)
      // (a REACH miss is the ground's, not the cell's: the cells round it - 3 across, a layer up or down - lie behind the same
      //  wall. Tried one by one, a walled garden's 18 cells took 18 walks through a door into a dead-end vestibule, 18s each,
      //  0 placed in a 323s step (2026-09-28). They wait for the next step; the step goes elsewhere)
      if (/within reach|stand was not reached|stuck|timeout/.test(lastPlaceFail)) {
        const n = restRound(c, ready, holdBack)
        if (n) log('build', `${n} cells round ${move.fmt(c)} rest with it - the same ground stopped the walk`)
      }
    }
  }
  profLog()
  return { placed, blockedOn: waiting, blockedHolds: waitingHolds, done: false }
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
// THE FOUNDATION: the base layer stood over a drop - the castle's south and west edges over a slope 5-9 blocks down -
// and every cell there was a pillar climbed, stuck at its foot, or a fall (2026-09-28). A player lays a foundation on a
// slope first: under the RIM of the base layer, the air, water or plants down to the ground become cells of the job
// (a filler block each) - a retaining wall, not a solid box - so the band lays it bottom-up before the walls over it rise,
// and the floor inside is placed from solid footing. Only under the BASE layer - a blueprint's own overhang higher up is not propped - and
// no deeper than FOUNDATION_MAX (a ravine keeps its pillars); a column with lava in it is left. Taken once the chunks
// are here, from the ground as it stands (anything solid ends the column: a block of ours there is kept as foundation).
const FOUNDATION_MAX = 16
const FOUNDATION_BLOCKS = /^(cobblestone|dirt|coarse_dirt|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|stone|deepslate)$/
function ensureFoundation (bot) {
  if (!job || job.foundation) return true
  const add = []
  const y1 = job.box.y1
  // (a support of ours in a column is air to the scan: the teardown takes it, and the fill must not end on it - audit)
  const ledger = new Set((mem.get().scaffold || []).map(key))
  const cols = []
  for (const c of job.cells) {
    if (c.y !== y1 || c.clear) continue
    const col = []
    let ok = true; let lastKind = null // (the bottom cell's kind: a torch goes on dry ground only)
    for (let y = y1 - 1; ; y--) {
      const k = kindAt(bot, c.x, y, c.z)
      if (!k) return false // (a column not loaded: taken whole or not at all)
      if (/^lava$/.test(k.name)) { ok = false; break }
      if (k.boundingBox === 'block' && !world.LEAF_RE.test(k.name) && !ledger.has(`${c.x},${y},${c.z}`)) break
      if (y1 - y > FOUNDATION_MAX) { ok = false; break }
      col.push(y); lastKind = k
    }
    if (ok && col.length) cols.push({ x: c.x, z: c.z, ys: col, dry: !/^(water|bubble_column)$/.test(lastKind.name) })
  }
  // THE EDGE ONLY: a one-wide wall down the rim - a column of the base with a side on anything that is not the base
  // (the outside, a courtyard) - not the whole box under it. The floor inside goes in clicked against the rim and its own
  // neighbours as any cell does; the hollow under it is closed in. A solid fill was 1,000-1,900 blocks of mining for the
  // same footing (the operator, 2026-09-28)
  const base = k2 => job.index.has(`${k2.x},${y1},${k2.z}`) && !job.index.get(`${k2.x},${y1},${k2.z}`).clear
  // (the OUTSIDE only: the columns off the base that the open ground round the build reaches - a flood from the ring round
  //  the box through every column that is not the base. A courtyard walled in by the base is not outside: its rim cells
  //  could only be reached through the castle's doors and failed every try, 17 of 29 in a step, 2026-09-28)
  const bx = job.box; const outside = new Set(); const q0 = []
  for (let x = bx.x1 - 1; x <= bx.x2 + 1; x++) for (const z of [bx.z1 - 1, bx.z2 + 1]) q0.push({ x, z })
  for (let z = bx.z1; z <= bx.z2; z++) for (const x of [bx.x1 - 1, bx.x2 + 1]) q0.push({ x, z })
  for (const q of q0) outside.add(`${q.x},${q.z}`)
  while (q0.length) {
    const q = q0.pop()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: q.x + dx, z: q.z + dz }; const k = `${n.x},${n.z}`
      if (n.x < bx.x1 || n.x > bx.x2 || n.z < bx.z1 || n.z > bx.z2 || outside.has(k) || base(n)) continue
      outside.add(k); q0.push(n)
    }
  }
  const outer = k2 => outside.has(`${k2.x},${k2.z}`)
  // THE HOLLOW LIT: the floor over it goes in row by row for hours, and until the last cell it is a dark room under the
  // work - monsters spawn at block light 0 by day as by night (since 1.18). A torch on its ground every 8 blocks, placed
  // while it is still open (an attached cell: in as soon as a torch is in hand and its ground stands; audit 2026-09-28)
  const torches = []
  const inner = new Map()
  // (and a base cell that is NO FLOOR - a wall sign, a torch, an open trapdoor: its column is filled like the rim's, or the
  //  floor has a hole into the hollow. The lectern room's sign square dropped the bot into the hollow three times in a
  //  morning, the ladder beside it the only way back up, 2026-09-29)
  const md0 = world.data(bot)
  const noFloor = q => {
    const c = job.index.get(`${q.x},${y1},${q.z}`); if (!c) return false
    if (/_trapdoor$/.test(c.name) && c.props && String(c.props.open) === 'true') return true
    const d = md0.blocksByName[c.name]; return !!d && d.boundingBox === 'empty'
  }
  let holes = 0
  for (const q of cols) {
    const rim = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => outer({ x: q.x + dx, z: q.z + dz }))
    if (!rim && !noFloor(q)) { inner.set(`${q.x},${q.z}`, q); continue }
    if (!rim) holes++
    // (under a plant the top of the fill is dirt: a tulip or a rose bush stands on nothing else)
    const top = job.index.get(`${q.x},${y1},${q.z}`); const soil = !rim && !!top && (act.PLANT_RE.test(top.name) || /(rose_bush|lilac|peony|sunflower|orchid|allium|lily_of_the_valley|sapling)$/.test(top.name))
    for (const y of q.ys) add.push({ x: q.x, y, z: q.z, hole: !rim, soil: soil && y === y1 - 1 })
  }
  if (holes) log('build', `foundation: ${holes} column${holes > 1 ? 's' : ''} under a base cell that is no floor (a sign, a torch, an open trapdoor) filled - no hole into the hollow`)
  // (every hollow region lit: the 8-grid's cells in it, or - a strip the grid misses, a tower's, the west edge's - its
  //  shallowest dry column, the one a walk down reaches most easily, nearest its middle; audit 2026-09-28)
  const seen = new Set()
  for (const [k0, q0] of inner) {
    if (seen.has(k0)) continue
    const region = []; const stack = [q0]; seen.add(k0)
    while (stack.length) {
      const q = stack.pop(); region.push(q)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const kk = `${q.x + dx},${q.z + dz}`; if (inner.has(kk) && !seen.has(kk)) { seen.add(kk); stack.push(inner.get(kk)) } }
    }
    // (a torch only where a mob could stand: 2 high at least - a 1-high gap under the floor spawns nothing, and its torch
    //  could neither be reached nor kept: "left unlit - could not dig the cobblestone in the cell", 2026-09-28)
    // (and only where the floor over it is still open: a hollow's torch goes in from above or not at all, and the drop that
    //  said so came only after a 20-40s walk to each - every job load, so every restart brought the same 4-5 back, 2026-09-28)
    const open = q => world.isAirish(world.at(bot, q.x, y1, q.z))
    const dry = region.filter(q => q.dry && q.ys.length >= 2 && open(q))
    if (!dry.length && region.some(q => q.dry && q.ys.length >= 2)) { log('build', `hollow of ${region.length} columns under the floor near ${region[0].x},${region[0].z} left unlit - the floor over it is laid`); continue }
    let pick = dry.filter(q => (q.x - job.box.x1) % 8 === 4 && (q.z - job.box.z1) % 8 === 4)
    if (!pick.length && dry.length) {
      const cx = region.reduce((a, q) => a + q.x, 0) / region.length; const cz = region.reduce((a, q) => a + q.z, 0) / region.length
      pick = [dry.sort((a, b) => (a.ys.length - b.ys.length) || (Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz)))[0]]
    }
    if (!dry.length && region.some(q => q.ys.length >= 2)) log('build', `hollow of ${region.length} columns under the floor near ${region[0].x},${region[0].z} is all water - left unlit`)
    for (const q of pick) torches.push({ x: q.x, y: q.ys[q.ys.length - 1], z: q.z })
  }
  for (const p of add) {
    const cell = { x: p.x, y: p.y, z: p.z, name: 'cobblestone', props: {}, foundation: true, hole: !!p.hole, want: null, item: 'cobblestone', alt: FOUNDATION_BLOCKS, prefer: ['cobblestone', 'dirt'], itemAlt: FILLER_ITEMS }
    if (p.soil) Object.assign(cell, { name: 'dirt', item: 'dirt', alt: /^(dirt|grass_block|coarse_dirt|rooted_dirt)$/, prefer: ['dirt'], itemAlt: /^dirt$/ })
    job.cells.push(cell); job.index.set(key(cell), cell)
  }
  // (a support of ours standing in a foundation cell does the foundation's work now: off the scaffold ledger, so no teardown
  //  takes it; and said - the count of cells standing already, which the scan read through as air; audit 2026-09-28)
  const standing = add.filter(p => ledger.has(key(p)) && world.isSolid(world.at(bot, p.x, p.y, p.z)))
  if (standing.length) { const sk = new Set(standing.map(key)); mem.update(m => { m.scaffold = (m.scaffold || []).filter(q => !sk.has(key(q))) }) }
  const md = world.data(bot)
  for (const p of torches) {
    const cell = Object.assign(describe({ x: p.x, y: p.y, z: p.z, name: 'torch', props: {} }, md), { foundation: true }) // (stands on the ground under it)
    job.cells.push(cell); job.index.set(key(cell), cell)
  }
  job.foundation = { cells: add.length, torches: torches.length, outside } // (the flood's open ground: where a rim cell's stand may be)
  statusGen++
  // (headed by what is LEFT - the number status reports: the cells added count our supports standing in them as well)
  if (add.length || cols.length) log('build', `foundation: ${add.filter(p => !world.isSolid(world.at(bot, p.x, p.y, p.z))).length} blocks left of ${add.length}${standing.length ? ` (${standing.length} of them our supports already standing)` : ''} - a wall under the rim of the base where it stands over a drop (${new Set(add.map(p => p.x + ',' + p.z)).size} of ${cols.length} columns over the drop) - laid first${torches.length ? `, ${torches.length} torch${torches.length > 1 ? 'es' : ''} in the hollow under the floor` : ''}`)
  return true
}
// NEVER WALL MYSELF IN: a cell placed while the body stands inside the footprint must leave it a way out - a walk (steps
// up of one, drops of SAFE_DROP at most, the cell counted solid) to a column outside the footprint, or to open sky over a
// cell that is not the build's own (a tower may rise there). Walled in at floor level at dusk, the bed out of reach, the
// night ladder sent the bot on a 43b walk in the dark and it died (2026-09-28); sealed in the hollow under the floor it
// stood 5 minutes. A region bigger than 300 cells is no trap. True: this cell would seal us in - it waits.
function wallsMeIn (bot, c, from = null) {
  if (!job) return false
  // (only a cell that CLOSES the way out seals us: sealed with it and open without it. Sealed either way - a room already
  //  closed - it is no reason to hold that cell back)
  return !wayOut(bot, c, from, true) && wayOut(bot, c, from, false)
}
// A walk from `from` (the feet) reaches a way out of the footprint - a column outside it, or open sky over a cell not the
// build's own - with the cell counted solid (withC) or not. Outside the footprint: out already.
// wayOutPoint: where the walk found its way out - a cell outside the footprint, or the cell under open sky a tower rises
// from (the planner never plans that tower: escapeUp walks here first and climbs; audit 2026-09-29)
let lastExit = null
function wayOutPoint (bot, from = null) { lastExit = null; return wayOut(bot, { x: NaN, y: NaN, z: NaN }, from, false) ? lastExit : null }
function wayOut (bot, c, from = null, withC = true) {
  if (!job) return true
  const b0 = job.box; const f = from ? { x: from.x, y: from.y, z: from.z } : world.feetPos(bot)
  const inBox = p => p.x >= b0.x1 && p.x <= b0.x2 && p.z >= b0.z1 && p.z <= b0.z2
  if (!inBox(f)) return true
  // (a door or a fence gate is a way through - the bot crosses them; counted solid, a room behind a door read as sealed and
  //  every cell placed from inside it was held back, 2026-09-29)
  const passable = b => world.isAirish(b) || (/_door$|_fence_gate$/.test(b.name) && !/^iron_door$/.test(b.name))
  {
    const isC = (x, y, z) => withC && x === c.x && y === c.y && z === c.z
    const air = (x, y, z) => { if (isC(x, y, z)) return false; const b = world.at(bot, x, y, z); return !!b && passable(b) }
    const st = (x, y, z) => { if (!air(x, y, z) || !air(x, y + 1, z)) return false; if (isC(x, y - 1, z)) return true; return world.standable(bot, x, y, z) }
    const seen = new Set([key(f)]); const q = [{ x: f.x, y: f.y, z: f.z }]
    while (q.length) {
      if (seen.size > 300) return true // (a region this big is no trap)
      const p = q.shift()
      if (!inBox(p)) { lastExit = p; return true }
      // (open sky is out only where a tower may rise: below the floor a column with a cell of the build over it is the
      //  climb's "no tower - a cell of the build", and read as a way out it kept the wall-opening escape from running -
      //  the south rim's trench, walk and climb failing in turn, 2026-09-29)
      if (!job.index.has(key(p)) && world.openSky(bot, p) && !isC(p.x, p.y, p.z)) { let clear = true; for (let y = p.y + 2; y < p.y + 22; y++) if (isC(p.x, y, p.z)) clear = false; if (p.y < b0.y1) for (let y = p.y + 1; y <= b0.y1 + 1; y++) { const q = job.index.get(`${p.x},${y},${p.z}`); if (q && !(q.foundation && q.name === 'cobblestone')) clear = false } /* (a filler foundation cell a tower may rise through: the protector's rule) */ if (clear) { lastExit = p; return true } }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = p.x + dx; const z = p.z + dz
        for (let dy = 1; dy >= -world.SAFE_DROP; dy--) {
          const y = p.y + dy
          if (dy === 1 && !air(p.x, p.y + 2, p.z)) continue // (a step up wants the head room to jump)
          if (dy < 0) { let open = true; for (let yy = y + 2; yy <= p.y + 1; yy++) if (!air(x, yy, z)) open = false; if (!open) break } // (a drop wants its column open)
          if (!st(x, y, z)) continue
          const k = key({ x, y, z }); if (!seen.has(k)) { seen.add(k); q.push({ x, y, z }) }
          break
        }
      }
    }
    return false
  }
}
// A foundation cell sealed in under the base already built is dropped, not rested: it is no part of the blueprint, nothing
// can reach it again, and a rest would retry it for ever (the build could never read done; audit 2026-09-28). A cell
// merely out of reach rests like any other.
function dropFoundation (bot, c, why) {
  job.cells = job.cells.filter(q => q !== c); job.index.delete(key(c)); cellFails.delete(key(c)); statusGen++
  if (job.foundation) job.foundation.dropped = (job.foundation.dropped || 0) + 1
  // (a torch dropped is a hollow left dark under the work - said as such, never lost in the foundation's own drops)
  log('build', c.name === 'torch' ? `hollow at ${move.fmt(c)} left unlit - ${why}` : `foundation cell at ${move.fmt(c)} dropped - ${why}`)
}
// The stand beside `c` (feet within 3 across, two below to one above) from which the most ready cells are in reach: clear
// to stand in, no cell of the job at its feet or head, never on a lip, and `c` itself in reach. {x,y,z,n} or null.
const EYE = 1.62; const REACH = 4.2
function clusterStand (bot, c, ready, bad = new Set()) {
  const near = ready.filter(q => Math.abs(q.x - c.x) <= 8 && Math.abs(q.z - c.z) <= 8 && Math.abs(q.y - c.y) <= 6)
  // (a cell counts for a stand only if it has a face to click on the stand's side - within 4.2 through a wall is no reach:
  //  each cell's usable faces, once; audit 2026-09-28)
  const normals = new Map(near.map(q => [q, plansFor(q).filter(pl => refOk(bot, q, pl)).map(pl => pl.off.map(v => -v))]))
  const faces = (p, q) => (normals.get(q) || []).some(nv => (p.x - q.x) * nv[0] + (p.y + 1 - q.y) * nv[1] + (p.z - q.z) * nv[2] > 0)
  const me = bot.entity.position
  const within = (p, q) => { const dx = q.x + 0.5 - (p.x + 0.5); const dy = q.y + 0.5 - (p.y + EYE); const dz = q.z + 0.5 - (p.z + 0.5); return dx * dx + dy * dy + dz * dz <= REACH * REACH }
  let best = null
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -2; dy <= 1; dy++) {
    const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
    if (bad.has(key(p)) || !within(p, c) || job.index.has(key(p)) || job.index.has(key({ x: p.x, y: p.y + 1, z: p.z })) || !world.standable(bot, p.x, p.y, p.z)) continue
    // (never under the build: a stand below the base inside the box is the hollow - the eviction sends the bot home from it)
    if (p.y < job.box.y1 && p.x >= job.box.x1 && p.x <= job.box.x2 && p.z >= job.box.z1 && p.z <= job.box.z2) continue
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => world.dropAt(bot, p.x + ax + 0.5, p.y, p.z + az + 0.5) > world.SAFE_DROP)) continue
    let n = 0; for (const q of near) if (within(p, q) && faces(p, q)) n++
    const d = world.dist3(p, me)
    if (!best || n > best.n || (n === best.n && d < best.d)) best = { x: p.x, y: p.y, z: p.z, n, d }
  }
  return best
}

// A hollow's torch goes in FROM ABOVE, through the floor not built over it yet: a stand on the base floor already laid, the
// torch's cell within reach below - the hollow never entered (its stands inside were the trap; audit 2026-09-28). The floor
// cell over the torch open is the sight line; once it is built the torch has no way in and is dropped (placeCell).
function torchStand (bot, c) {
  const y1 = job.box.y1
  if (!world.isAirish(world.at(bot, c.x, y1, c.z))) return null
  const me = bot.entity.position; let best = null; let bd = Infinity
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const p = { x: c.x + dx, y: y1 + 1, z: c.z + dz }
    if (!world.isSolid(world.at(bot, p.x, y1, p.z)) || !world.standable(bot, p.x, p.y, p.z)) continue
    if (job.index.has(key(p)) && cellDone(bot, job.index.get(key(p))) !== true) continue // (a cell still to build: not a stand)
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => world.dropAt(bot, p.x + ax + 0.5, p.y, p.z + az + 0.5) > world.SAFE_DROP && !(p.x + ax === c.x && p.z + az === c.z))) continue
    if (world.dist3({ x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 }, { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }) > 4.4) continue
    const d = world.dist3(p, me)
    if (d < bd) { bd = d; best = p }
  }
  return best
}

// Where to stand for a foundation cell: OUTSIDE the footprint (no cell of the base over the column - never in the hollow
// the rim closes), feet within 2 across of it, four below to two above, clear to stand in, never a cell of the job,
// within reach of the cell; the nearest to the body.
function foundationStand (bot, c) {
  if (c.name === 'torch') return torchStand(bot, c)
  const me = bot.entity.position; let best = null; let bd = Infinity
  // (a HOLE in the floor - the column under a sign, a torch, an open trapdoor: filled from the room beside it, placed down
  //  into it. One wide, it walls nothing in)
  if (c.hole) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 3; dy++) {
      if (!dx && !dz) continue
      const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
      if (!world.standable(bot, p.x, p.y, p.z)) continue
      if (world.dist3({ x: p.x + 0.5, y: p.y + 1.6, z: p.z + 0.5 }, { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }) > 4.2) continue
      const d = world.dist3(p, me)
      if (d < bd) { bd = d; best = p }
    }
    if (best) return best // (a deep column's lower cells are out of reach from the room: the passes below, from the hollow; audit)
  }
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -4; dy <= 2; dy++) {
    if (c.noOutside) break // (its outside stand was missed: the inside pass below)
    if (!dx && !dz) continue
    const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
    if (job.index.has(`${p.x},${job.box.y1},${p.z}`)) continue // (under the base: inside)
    // (on the OPEN ground round the build - the rim's own flood from the ring round the box: a courtyard walled in by the
    //  base is not in it (its stands went through the castle's doors, 17s a try, 2026-09-28), but the ground outside that
    //  reaches in under the rim is - "outside the box" left 21 rim cells a step with no stand at all)
    const open = job.foundation && job.foundation.outside
    const inBox = p.x >= job.box.x1 && p.x <= job.box.x2 && p.z >= job.box.z1 && p.z <= job.box.z2
    if (inBox && !(open && open.has(`${p.x},${p.z}`))) continue
    if (job.index.has(key(p)) || job.index.has(key({ x: p.x, y: p.y + 1, z: p.z })) || !world.standable(bot, p.x, p.y, p.z)) continue
    // (never on a lip: a trench's outer edge or a ledge of the slope beside a drop that hurts - audit, the falls' posture)
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => world.dropAt(bot, p.x + ax + 0.5, p.y, p.z + az + 0.5) > world.SAFE_DROP)) continue
    if (world.dist3({ x: p.x + 0.5, y: p.y + 1.6, z: p.z + 0.5 }, { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }) > 4.2) continue
    const d = world.dist3(p, me)
    if (d < bd) { bd = d; best = p }
  }
  if (best) return best
  // (the hollow is DARK and closed: a spawner. Never in with a hostile down there - every one the world holds, seen or not -
  //  and an unlit region only by day at full health; a lit one - a foundation torch within 12 - is the one to prefer; audit)
  const hostileIn = Object.values(bot.entities).some(e => e && e.position && reflex.HOSTILE.has(e.name) && e.position.y <= job.box.y1 + 1 && world.dist3(e.position, c) < 12)
  if (hostileIn) { c.noOutside = false; return null }
  // (from the hollow only when already IN it: sent in from the floor above - through the castle's doors, down its holes -
  //  the walk failed round after round, the bot ended stuck under the floor every other step, 2026-09-29. The holes are
  //  being filled; the hollow is the rim's inside, not a way to it)
  { const f = world.feetPos(bot); if (!(f.y < job.box.y1 && f.x >= job.box.x1 && f.x <= job.box.x2 && f.z >= job.box.z1 && f.z <= job.box.z2)) { c.noOutside = false; return null } }
  const lit = job.cells.some(q => q.foundation && q.name === 'torch' && world.dist3(q, c) <= 12 && cellDone(bot, q) === true)
  if (!lit && !(world.phase(bot) === "day" && bot.health >= 20)) { c.noOutside = false; return null }
  // FROM INSIDE THE HOLLOW when no outside stand will do - the rim's trench stands sat behind drops the walk would not take,
  // and 75 rim cells waited for days while the bot fell off the edge they would close (2026-09-29). Safe by wallsMeIn's own
  // rule, asked from the stand: with this cell in, a walk from there must still find a way out (audit route 2)
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -3; dy <= 1; dy++) {
    if (!dx && !dz) continue
    const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
    if (!job.index.has(`${p.x},${job.box.y1},${p.z}`)) continue // (inside: under the base only)
    if (job.index.has(key(p)) || job.index.has(key({ x: p.x, y: p.y + 1, z: p.z })) || !world.standable(bot, p.x, p.y, p.z)) continue
    if (world.dist3({ x: p.x + 0.5, y: p.y + 1.6, z: p.z + 0.5 }, { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }) > 4.2) continue
    if (!wayOut(bot, c, p, true)) continue // (from there, with the cell in, a way out must stay)
    const d = world.dist3(p, me)
    if (d < bd) { bd = d; best = p }
  }
  if (best) log('build', `${c.name} at ${move.fmt(c)}: no stand outside - from inside the hollow at ${move.fmt(best)} (a way out stays)`)
  else if (c.noOutside) c.noOutside = false // (no safe inside stand either: the outside one again next time)
  return best
}
function sealedIn (bot, c) { return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].every(([dx, dy, dz]) => world.isSolid(world.at(bot, c.x + dx, c.y + dy, c.z + dz))) }
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
// THE DAY, counted the way watchNights and the tidy gates read one - a night seen and then day, or the clock wrapped back
// (a night slept through) - never bot.time.day; kept in memory so a restart keeps the count (audit 2026-09-29)
function today (bot) { return require('./day').dayNo(bot) } // (THE day - day.js)
function resting (bot, p) { const l = leftovers.get(key(p)); return !!l && l.n >= 3 && l.day === today(bot) }
// THE DAILY TEARDOWN'S MISSES, across days: its leftovers rest after 3 tries in a day, and it runs once a day, one pass -
// a block out of reach never rested, and every day walked to the same ones, 30s each, until its 4 minutes ran out: 7
// taken of 108 counted, 2026-09-29. A miss rests 1, 2, 4, 8... days (the build moves on; a stand may open)
const tdMiss = new Map(Object.entries(mem.get().teardownMiss2 || {})) // key -> { n, day }
function tdResting (bot, p) { const m = tdMiss.get(key(p)); return !!m && today(bot) - m.day < Math.pow(2, Math.min(m.n, 6) - 1) }
function tdMissed (bot, p) { const m = tdMiss.get(key(p)); tdMiss.set(key(p), { n: m ? m.n + 1 : 1, day: today(bot) }); const o = {}; for (const [k, v] of tdMiss) o[k] = v; mem.set('teardownMiss2', o) }
function failLeftover (bot, p) { const l = leftovers.get(key(p)); const d = today(bot); leftovers.set(key(p), { n: l && l.day === d ? l.n + 1 : 1, day: d }) }

// Take down every scaffold block, top-down. A block out of reach is walked to with the planner allowed to
// tower (its tower is new scaffold, found by the next pass); standing on a pillar, the pillar is dug from
// under our own feet a block at a time (how a player takes one down). Bounded: 4 passes, 3 tries per
// block a day; what is left is logged with coordinates.
// THE SITE'S OLD SCAFFOLD, DAILY: pillars left from before the builder took its own down (391 round the castle on
// 2026-09-28, the rim bank's among them - raised, it put the foundation's stand behind a drop the bot could not take).
// Only below the band being built (the band only rises: that scaffold is never wanted again), never a block a finished
// attached cell hangs on. One pass, the day's stop.
// (a cap: 4 minutes a day - the first run took 1037s, pillaring up to high leftovers, while the castle waited; the rest
//  comes down on the days after, and build.finish takes what is left)
const SITE_TIDY_MS = 4 * 60000
// What the day's teardown may take: under the band, holding nothing, not a step - and our ledger's blocks under the site's
// region. One reading for the teardown and for the director's count: it counted every block standing (the builder's own,
// from the band up, too), so the teardown ran every game day - 4 minutes for ~25 blocks, 2026-09-29
function siteTeardownPlan (bot) {
  if (!job || !site) return null
  let bandY = Infinity
  for (const c of job.cells) if (!c.attach && !c.follows && !c.foundation && c.y < bandY && cellDone(bot, c) !== true) bandY = c.y
  const sups = new Set(job.cells.filter(q => q.sup && cellDone(bot, q) === true).map(q => key(q.sup)))
  // (below the band only: it never needs its scaffold again, and that is what raises banks and blocks stands - above it
  //  the same columns would be pillared again within the week; those are build.finish's; audit)
  // (from the band's lowest layer up is the builder's; everything under it is done with - the rim bank's top at y117 was
  //  kept at "band - 2" and stayed in the foundation's way, 2026-09-28)
  // (but a STEP up onto the floor stays: a block just under the base (box.y1 - the floor, for good; not the band, which
  //  rises) with room over it and, beside it, a floor one higher
  //  to step onto - the only way up that side for the walks, which no longer lay steps cheaply; audit)
  const air = (x, y, z) => { const b = world.at(bot, x, y, z); return !!b && world.isAirish(b) }
  const isStep = p => p.y === job.box.y1 - 1 && air(p.x, p.y + 1, p.z) && air(p.x, p.y + 2, p.z) &&
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => world.standable(bot, p.x + dx, p.y + 2, p.z + dz))
  const keep = p => p.y >= bandY || sups.has(key(p)) || isStep(p)
  // (and our ledger's blocks under the snapshot's region - it starts 2 under the base: the rim bank's columns at y112-116
  //  were never in the site diff, so never taken; audit)
  const r = site.region
  const extra = (mem.get().scaffold || []).filter(p => p.y < r.y1 && p.x >= r.x1 && p.x <= r.x2 && p.z >= r.z1 && p.z <= r.z2)
  return { keep, extra, bandY }
}
function siteScaffoldTakeable (bot) {
  const pl = siteTeardownPlan(bot); if (!pl) return 0
  return scaffoldList(bot).filter(p => !pl.keep(p) && !resting(bot, p) && !tdResting(bot, p)).length + pl.extra.filter(p => { const b = world.at(bot, p.x, p.y, p.z); return !!b && LEDGER_RE.test(b.name) && !resting(bot, p) && !tdResting(bot, p) }).length
}
async function siteScaffoldTeardown (bot, { shouldStop } = {}) {
  const pl = siteTeardownPlan(bot); if (!pl) return 0
  const { keep, extra, bandY } = pl
  const t0 = Date.now(); const stop0 = shouldStop
  shouldStop = () => (stop0 && stop0()) || Date.now() - t0 > SITE_TIDY_MS
  const before = scaffoldList(bot).length + extra.length
  const n = await removeScaffold(bot, { shouldStop, maxPasses: 1, keep, extra, climb: false })
  if (n) { const gone = new Set(extra.filter(p => { const b = world.at(bot, p.x, p.y, p.z); return !b || !LEDGER_RE.test(b.name) }).map(key)); if (gone.size) mem.update(m => { m.scaffold = (m.scaffold || []).filter(q => !gone.has(key(q))) }) }
  log('build', `site scaffold: ${n} taken down, ${Math.max(0, before - n)} left (from the band y${bandY} up, holding a finished cell, or out of reach)`)
  return n
}
async function removeScaffold (bot, { shouldStop, maxPasses = 4, keep = null, extra = [], climb = true } = {}) {
  if (!job) return 0
  let removed = 0
  const dig = (p, noWalk = false) => act.dig(bot, p, { force: true, allowZones: ['build', 'base'], timeoutMs: 10000, noWalk, reachMax: noWalk ? 5 : 4.3 })
  if (!site) {
    // no snapshot (a job set before snapshots): the remembered placements and filler in the footprint
    for (const p of (mem.get().scaffold || []).slice()) {
      const b = world.at(bot, p.x, p.y, p.z)
      if (b && LEDGER_RE.test(b.name) && !job.index.has(key(p)) && await act.dig(bot, p, { force: true, allowZones: ['build', 'base'] })) removed++ // (the ledger: cobble supports we placed too)
    }
    mem.update(m => { m.scaffold = [] })
    if (removed) log('build', `removed ${removed} scaffold blocks (no site snapshot - remembered ones only)`)
    return removed
  }
  // (extra: ledger cells outside the snapshot's region - under it, where the site diff cannot see - still our filler)
  const extraSet = new Set(extra.map(key))
  const isExtra = p => { if (!extraSet.has(key(p)) || job.index.has(key(p))) return false; const b = world.at(bot, p.x, p.y, p.z); return !!b && LEDGER_RE.test(b.name) }
  const isScaf = p => isStray(bot, p.x, p.y, p.z) || isExtra(p)
  const miss = p => { failLeftover(bot, p); if (!climb) tdMissed(bot, p) } // (the daily teardown's miss rests across days)
  const rests = p => resting(bot, p) || (!climb && tdResting(bot, p))
  for (let pass = 0; pass < maxPasses; pass++) {
    const list = scaffoldList(bot).concat(extra.filter(isExtra)).filter(p => !rests(p) && !(keep && keep(p)))
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
      if (bot.entity.onGround && isScaf(under) && !rests(under) && safeDrop(bot, under)) {
        if (await dig(under, true)) { removed++; got++; await landed(bot) } else miss(under)
        continue
      }
      const p = queue.shift()
      if (!isScaf(p) || rests(p) || (keep && keep(p))) continue
      if (!act.reach(bot, p, 4.3)) {
        // (near enough, not look-at: the look-at raycast through pews and pillars "stuck" at 5-6b; the server checks distance)
        // a short walk first; then the pillar from the ground beside it; the church door only for what is inside
        let r = await goSite(bot, new goals.GoalNear(p.x, p.y, p.z, 3), 'scaffold', { doors: false })
        if (!r.ok && !act.reach(bot, p, 4.8)) {
          // (climb:false - the daily teardown: no pillar to take a pillar down; a block out of reach from the ground is
          //  build.finish's. Pillaring for leftovers took 1037s of a day; audit)
          if (!climb) { miss(p); continue }
          if (await reachByPillar(bot, p, { shouldStop })) { removed++; got++; continue }
          r = (await viaDoor(bot, new goals.GoalNear(p.x, p.y, p.z, 3), siteMovements(bot, { dig: 'noGround' }))) || r
        }
        if (!r.ok && !act.reach(bot, p, 4.8)) {
          log('build', `scaffold ${move.fmt(p)}: couldn't get within reach (${r.why}, ${world.dist3(bot.entity.position, p).toFixed(1)}b off, from ${move.fmt(bot.entity.position)})`); miss(p); continue
        }
      }
      // within a player's reach after the walk: dig from here (act.dig's stricter 4.3 walked again, 20s a block)
      if (await dig(p, act.reach(bot, p, 5))) { removed++; got++ } else { log('build', `scaffold ${move.fmt(p)}: the dig failed (${world.dist3(bot.entity.position, p).toFixed(1)}b off)`); miss(p) }
      if (inv.freeSlots(bot) <= 1) await base().tossJunk(bot)
    }
    await act.collectDrops(bot, { radius: 10, maxMs: 8000 })
    if (!got) break
  }
  // the hint list only ever shrinks to what is still standing
  mem.update(m => { m.scaffold = (m.scaffold || []).filter(p => { const b = world.at(bot, p.x, p.y, p.z); return !b || (!world.isAirish(b) && LEDGER_RE.test(b.name)) }) }) // (keeps cobble supports on the ledger)
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
const SCAFFOLD_WANT = 32 // (THE scaffold stock a build step starts with - the smelt queue keeps cobblestone back to this)
async function ensureScaffold (bot, n = SCAFFOLD_WANT, { shouldStop } = {}) { // (shouldStop: the caller's day - a top-up is never a night descent)
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
    // (room in the pack first, at the chests beside home: last round's kit filled it, the mine said "pack full" at 0 of 32
    //  and walked the haul home and back - 1.5 minutes a round, 2026-09-29. The kit comes out again right after this)
    const home = mem.get().home
    if (inv.freeSlots(bot) <= 4 && home && world.dist3(bot.entity.position, home) < 24) { log('build', `pack nearly full (${inv.freeSlots(bot)} free) - depositing before the mine trip for scaffold`); await base.depositHaul(bot, { shouldStop }).catch(() => false) }
    // (a trip's worth, not a round's: the foundation's cells are cobblestone too and took each 32 the step it came, so every
    //  round walked to the mine again - 1-3 minutes a round, 2026-09-29. What the foundation still wants rides along, two
    //  stacks at most)
    // (and the whole build's cobblestone - stone is smelted cobble, the castle ~900 short: the mine walk is the fixed cost, so
    //  a trip fills the pack; the smelt queue's keep-back holds the scaffold's and the foundation's share; audit)
    const fnd = job ? job.cells.filter(q => q.foundation && q.name === 'cobblestone' && cellDone(bot, q) !== true).length : 0
    let whole = 0; try { whole = (require('./materials').planFor(bot, cachedStatus(bot).need).raw || {}).cobblestone || 0 } catch {}
    const room = Math.max(1, inv.freeSlots(bot) - 2) * 64
    const ask = Math.max(short, 32, Math.min(room, 256, short + fnd + whole)) // (four stacks: ~10 minutes at the face, not the half-hour a full pack would hold the building up for)
    log('build', `getting ${ask} cobblestone from the mine to scaffold with${fnd || whole ? ` (and ${fnd} foundation cells, ${whole} for the build's stone)` : ''}`)
    await require('./craft').ensure(bot, 'cobblestone', inv.count(bot, 'cobblestone') + ask, { noWithdraw: true, shouldStop }).catch(() => false)
  }
  if (filler() < n / 2) { log('build', `getting ${n - filler()} dirt to scaffold with`); await require('./craft').ensure(bot, 'dirt', inv.count(bot, 'dirt') + (n - filler()), { noWithdraw: true, shouldStop }).catch(() => false) }
  return true
}

module.exports = { siteScaffoldTakeable, wayOut, wayOutPoint, FILLER_ITEMS, SCAFFOLD_WANT, cachedStatus, exactWood, isOpenCell, INFILL_RE, infillItem, unsourced, strayBuildBlocks,
  finishSite, woodClass, woodForm, acceptsFor, itemOf, LOG_ANY, PLANKS_ANY, ensureScaffold, unskippedObstructions, setJob, getJob, status, nextNeeds,
  buildStep, clearSite, obstructions, removeScaffold, siteScaffoldTeardown, loadSchematic, cellDone, cellsDone, inBox, placeCell, registerJob, key,
  complete, needsWork, finish, survey, scaffoldList, holesList, ensureSnapshot, snapshotInfo, snapName,
  // pure helpers (offline checks)
  describe, plansFor, predict, yawOf, facingOfYaw, wantOf, nameOk, partOk, itemForBlock, thenItem, stepOf, stepItem, needsOf, propsOf, KEY_PROPS, COUNT_PROPS
}
