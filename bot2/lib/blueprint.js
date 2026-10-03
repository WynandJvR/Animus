'use strict'
// BLUEPRINTS - any blueprint file the operator drops into the schematics folder, made buildable in survival.
// Reads Sponge .schem, Litematica .litematic and vanilla structure .nbt, then applies one policy to every block:
//   never obtainable (nether/End-only, a trophy, structure loot, silk-touch-only) -> an overworld block of the same
//     shape and a similar look, or skipped when it is decoration with no stand-in (a mob head, a cobweb);
//   obtainable -> kept exactly. Whether the bot can fetch it TODAY is another matter: materials.unsourced() leaves
//     such cells for last, and they go in once a skill for them exists.
// The policy is rules, not a list per blueprint: a block's own name (nether families, trophies) and its recipe graph
// (a block made of nether quartz or blaze powder is as unobtainable as the quartz) decide.
// load() returns a prismarine Schematic (the builder's input) with .report = { substituted, dropped }.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const DIRS = [path.join(__dirname, '..', 'schematics')]
const EXTS = ['.schem', '.litematic', '.nbt', '.schematic']

// ---- policy --------------------------------------------------------------------------------------------
// skipped outright: trophies, technical blocks, and decoration that only a structure or a rare biome holds
// (banners too: the operator's rule, 2026-10-03 - decoration nothing stands on, 6 wool each; a castle's 38 were half its wool)
const DROP_RE = /(_head|_skull|_wall_head|_wall_skull|_banner)$|^(spawner|trial_spawner|vault|command_block|chain_command_block|repeating_command_block|barrier|structure_block|structure_void|jigsaw|light|bedrock|end_portal|end_portal_frame|end_gateway|nether_portal|reinforced_deepslate|dragon_egg|fire|soul_fire|moving_piston|piston_head|cobweb|spore_blossom|cave_vines|cave_vines_plant|frogspawn|brewing_stand|beacon|conduit|petrified_oak_slab|budding_amethyst|sculk_shrieker|test_block|test_instance_block)$/
// look-alikes for blocks that are never obtainable (by name; shape kept by the family rules below)
const LOOKALIKE = {
  netherrack: 'granite', glowstone: 'jack_o_lantern', shroomlight: 'jack_o_lantern', sea_lantern: 'jack_o_lantern',
  soul_sand: 'coarse_dirt', soul_soil: 'coarse_dirt', magma_block: 'granite', crimson_nylium: 'moss_block', warped_nylium: 'moss_block',
  nether_wart_block: 'red_wool', warped_wart_block: 'cyan_wool', nether_wart: 'poppy', crimson_fungus: 'red_mushroom', warped_fungus: 'brown_mushroom',
  crimson_roots: 'fern', warped_roots: 'fern', nether_sprouts: 'short_grass', weeping_vines: 'vine', weeping_vines_plant: 'vine', twisting_vines: 'vine', twisting_vines_plant: 'vine',
  basalt: 'tuff', polished_basalt: 'polished_tuff', smooth_basalt: 'tuff', blackstone: 'cobbled_deepslate', gilded_blackstone: 'cobbled_deepslate',
  polished_blackstone: 'polished_deepslate', chiseled_polished_blackstone: 'chiseled_deepslate', polished_blackstone_bricks: 'deepslate_bricks', cracked_polished_blackstone_bricks: 'cracked_deepslate_bricks',
  nether_bricks: 'bricks', red_nether_bricks: 'bricks', cracked_nether_bricks: 'bricks', chiseled_nether_bricks: 'bricks',
  quartz_block: 'polished_diorite', smooth_quartz: 'polished_diorite', chiseled_quartz_block: 'polished_diorite', quartz_bricks: 'polished_diorite', quartz_pillar: 'polished_diorite',
  end_stone: 'sandstone', end_stone_bricks: 'smooth_sandstone', purpur_block: 'polished_granite', purpur_pillar: 'polished_granite', end_rod: 'lightning_rod',
  chorus_plant: 'oak_fence', chorus_flower: 'oak_leaves', obsidian_crying: 'obsidian', crying_obsidian: 'obsidian', respawn_anchor: 'obsidian',
  ancient_debris: 'granite', netherite_block: 'iron_block', lodestone: 'chiseled_stone_bricks', ender_chest: 'chest',
  shulker_box: 'barrel', nether_gold_ore: 'granite', nether_quartz_ore: 'granite', daylight_detector: 'smooth_stone_slab', observer: 'furnace',
  comparator: 'repeater', target: 'hay_block', ochre_froglight: 'jack_o_lantern', verdant_froglight: 'jack_o_lantern', pearlescent_froglight: 'jack_o_lantern',
  // overworld, but only in a village, a rare biome or with silk touch
  crimson_stem: 'dark_oak_log', warped_stem: 'spruce_log', stripped_crimson_stem: 'stripped_dark_oak_log', stripped_warped_stem: 'stripped_spruce_log',
  crimson_hyphae: 'dark_oak_wood', warped_hyphae: 'spruce_wood', stripped_crimson_hyphae: 'stripped_dark_oak_wood', stripped_warped_hyphae: 'stripped_spruce_wood',
  bell: 'lantern', closed_eyeblossom: 'white_tulip', open_eyeblossom: 'oxeye_daisy', potted_closed_eyeblossom: 'potted_white_tulip', potted_open_eyeblossom: 'potted_oxeye_daisy',
  suspicious_sand: 'sand', suspicious_gravel: 'gravel', sponge: 'hay_block', wet_sponge: 'hay_block', mycelium: 'dirt', podzol: 'coarse_dirt',
  grass_path: 'dirt_path', infested_stone: 'stone', infested_cobblestone: 'cobblestone', infested_stone_bricks: 'stone_bricks',
  infested_mossy_stone_bricks: 'mossy_stone_bricks', infested_cracked_stone_bricks: 'cracked_stone_bricks', infested_chiseled_stone_bricks: 'chiseled_stone_bricks', infested_deepslate: 'cobbled_deepslate'
}
// family prefixes: the shape (stairs, slab, wall, door...) is kept, the material swapped - first that exists wins
const FAMILY = [
  // (common woods: the job may want the exact species, and a mangrove swamp is rarer than a dark forest)
  [/^crimson_/, ['dark_oak_']], [/^warped_/, ['spruce_']],
  [/^polished_blackstone_brick_/, ['deepslate_brick_']], [/^polished_blackstone_/, ['polished_deepslate_', 'cobbled_deepslate_']], [/^blackstone_/, ['cobbled_deepslate_']],
  [/^red_nether_brick_/, ['brick_']], [/^nether_brick_/, ['brick_']],
  [/^smooth_quartz_/, ['polished_diorite_', 'smooth_stone_', 'diorite_']], [/^quartz_/, ['polished_diorite_', 'smooth_stone_', 'diorite_']],
  [/^end_stone_brick_/, ['sandstone_', 'smooth_sandstone_']], [/^purpur_/, ['polished_granite_', 'granite_']]
]
// ore blocks drop the ore, not the block, without silk touch: the rock they sit in stands in
const ORE_RE = /^(deepslate_)?(coal|iron|copper|gold|redstone|lapis|diamond|emerald)_ore$/
// raw materials no overworld trip yields: a block made of any of them is never obtainable either
const NEVER_RAW = /^(quartz|blaze_rod|blaze_powder|nether_wart|ghast_tear|netherite_scrap|netherite_ingot|ancient_debris|magma_cream|glowstone_dust|shulker_shell|chorus_fruit|popped_chorus_fruit|nether_star|dragon_breath|echo_shard|wither_rose|heart_of_the_sea|nautilus_shell|ender_eye|crimson_stem|warped_stem|crimson_hyphae|warped_hyphae|netherrack|soul_sand|soul_soil|basalt|blackstone|glowstone|shroomlight|magma_block|end_stone|purpur_block|nether_bricks|nether_brick|obsidian_crying|crying_obsidian|disc_fragment_5|trial_key|ominous_trial_key|breeze_rod|heavy_core|sniffer_egg|torchflower_seeds|pitcher_pod|armadillo_scute|nether_gold_ore|nether_quartz_ore|\w*shulker_box)$/
// shapes a stand-in is chosen by when nothing above matched (full blocks: stone)
const SHAPE = [[/_wall_torch$/, 'wall_torch'], [/_torch$/, 'torch'], [/_lantern$/, 'lantern'], [/_campfire$/, 'campfire'], [/shulker_box$/, 'barrel'],
  [/_stem$/, 'oak_log'], [/_hyphae$/, 'oak_wood'], [/_stairs$/, 'cobblestone_stairs'], [/_slab$/, 'cobblestone_slab'], [/_wall$/, 'cobblestone_wall'], [/_fence_gate$/, 'oak_fence_gate'], [/_fence$/, 'oak_fence'],
  [/_door$/, 'oak_door'], [/_trapdoor$/, 'oak_trapdoor'], [/_button$/, 'stone_button'], [/_pressure_plate$/, 'stone_pressure_plate'], [/_wall_sign$/, 'oak_wall_sign'],
  [/_wall_hanging_sign$/, 'oak_wall_hanging_sign'], [/_hanging_sign$/, 'oak_hanging_sign'], [/_sign$/, 'oak_sign'], [/_pane$/, 'glass_pane'], [/_carpet$/, 'white_carpet']]

// md: minecraft-data; planner: materials.makePlanner(md) (the recipe graph). Returns a block name, or null to skip.
function resolve (name, md, planner, memo = new Map()) {
  if (memo.has(name)) return memo.get(name)
  const exists = n => !!md.blocksByName[n]
  let out = name
  if (DROP_RE.test(name)) out = null
  else if (LOOKALIKE[name]) out = LOOKALIKE[name]
  else if (ORE_RE.test(name)) out = /^deepslate_/.test(name) ? 'cobbled_deepslate' : 'stone'
  else if (/^potted_/.test(name)) { // the plant decides: a nether fungus in a pot becomes a mushroom in a pot
    const plant = name.slice(7); const r = exists(plant) ? resolve(plant, md, planner, memo) : plant // (potted_azalea_bush: the pot's own name)
    out = r === plant ? name : r && exists('potted_' + r) ? 'potted_' + r : 'flower_pot'
  }
  else {
    const fam = FAMILY.find(([re]) => re.test(name))
    if (fam) out = fam[1].map(p => name.replace(fam[0], p)).find(exists) || shapeOf(name, exists)
    else if (never(name, md, planner)) out = shapeOf(name, exists)
  }
  if (out && !exists(out)) out = shapeOf(name, exists)
  memo.set(name, out)
  return out
}
function shapeOf (name, exists) {
  const s = SHAPE.find(([re]) => re.test(name))
  if (s) return exists(s[1]) ? s[1] : null
  return /^(potted_|.*_(flower|bush|vines?|roots|fungus|sapling|coral|coral_fan|coral_wall_fan)$)/.test(name) ? null : 'stone'
}
// a block whose item's plan needs a raw no overworld trip yields (daylight detector: quartz; ender chest: blaze powder)
function never (name, md, planner) {
  if (NEVER_RAW.test(name)) return true
  if (!planner) return false
  const item = md.itemsByName[name] ? name : md.itemsByName[name.replace(/(^|_)wall_/, '$1')] ? name.replace(/(^|_)wall_/, '$1') : null
  if (!item) return false
  try { return Object.keys(planner.plan({ [item]: 1 }).raw).some(r => NEVER_RAW.test(r)) } catch { return false }
}

// cells no reader keeps: nothing to place there (air of any kind, structure voids, flowing water's bubbles, tall seagrass)
const NOTHING_RE = /^(air|cave_air|void_air|structure_void|bubble_column|moving_piston|light)$/

// ---- readers: every format to { sx, sy, sz, at(x, y, z) -> { name, props } | null } ------------------------
function findFile (name) {
  const base = name.replace(/\.(schem|litematic|nbt|schematic)$/, '')
  const exts = EXTS.some(e => name.endsWith(e)) ? [path.extname(name)] : EXTS
  for (const d of DIRS) for (const e of exts) { const f = path.join(d, base + e); if (fs.existsSync(f)) return f }
  return null
}
// names an older blueprint may carry that the game has since renamed (the DataFixer's job - a litematic of an older
// version said "grass" and "chain", both came out stone; audit #34)
const RENAMED = { grass: 'short_grass', chain: 'iron_chain', grass_path: 'dirt_path', sign: 'oak_sign', wall_sign: 'oak_wall_sign' }
const bare = n => { const b = String(n).replace(/^minecraft:/, ''); return RENAMED[b] || b }
async function readNbt (buf) {
  const nbt = require('prismarine-nbt')
  const { parsed } = await nbt.parse(buf[0] === 0x1f ? zlib.gunzipSync(buf) : buf)
  return nbt.simplify(parsed)
}
async function readLitematic (file) {
  const s = await readNbt(fs.readFileSync(file))
  const regions = Object.values(s.Regions)
  // several regions: placed by their positions in one box
  const boxes = regions.map(r => {
    const px = r.Position.x; const py = r.Position.y; const pz = r.Position.z
    const sx = r.Size.x; const sy = r.Size.y; const sz = r.Size.z
    return { r, x0: Math.min(px, px + sx + (sx < 0 ? 1 : -1)), y0: Math.min(py, py + sy + (sy < 0 ? 1 : -1)), z0: Math.min(pz, pz + sz + (sz < 0 ? 1 : -1)), sx: Math.abs(sx), sy: Math.abs(sy), sz: Math.abs(sz) }
  })
  const X0 = Math.min(...boxes.map(b => b.x0)); const Y0 = Math.min(...boxes.map(b => b.y0)); const Z0 = Math.min(...boxes.map(b => b.z0))
  const SX = Math.max(...boxes.map(b => b.x0 + b.sx)) - X0; const SY = Math.max(...boxes.map(b => b.y0 + b.sy)) - Y0; const SZ = Math.max(...boxes.map(b => b.z0 + b.sz)) - Z0
  const grid = new Map()
  for (const b of boxes) {
    const pal = b.r.BlockStatePalette; const bits = Math.max(2, Math.ceil(Math.log2(pal.length)))
    const longs = b.r.BlockStates.map(([hi, lo]) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)); const mask = (1n << BigInt(bits)) - 1n
    for (let i = 0, n = b.sx * b.sy * b.sz; i < n; i++) {
      if (i % (b.sx * b.sz) === 0) await new Promise(r => setImmediate(r)) // (a layer at a time: audit #33)
      const bit = i * bits; const li = Math.floor(bit / 64); const off = BigInt(bit % 64)
      let v = longs[li] >> off
      if (Number(off) + bits > 64) v |= longs[li + 1] << (64n - off)
      const p = pal[Number(v & mask)]
      const nm = bare(p.Name); if (NOTHING_RE.test(nm)) continue
      const x = i % b.sx; const z = Math.floor(i / b.sx) % b.sz; const y = Math.floor(i / (b.sx * b.sz))
      grid.set(`${b.x0 - X0 + x},${b.y0 - Y0 + y},${b.z0 - Z0 + z}`, { name: nm, props: p.Properties || {} })
    }
  }
  return { sx: SX, sy: SY, sz: SZ, at: (x, y, z) => grid.get(`${x},${y},${z}`) || null }
}
async function readStructure (file) {
  const s = await readNbt(fs.readFileSync(file))
  const pal = s.palette || (s.palettes && s.palettes[0]) || []
  const grid = new Map()
  for (const b of s.blocks || []) {
    const p = pal[b.state]; const nm = bare(p.Name); if (NOTHING_RE.test(nm)) continue
    grid.set(b.pos.join(','), { name: nm, props: p.Properties || {} })
  }
  return { sx: s.size[0], sy: s.size[1], sz: s.size[2], at: (x, y, z) => grid.get(`${x},${y},${z}`) || null }
}
async function readSponge (file, version) {
  const { Schematic } = require('prismarine-schematic')
  const { Vec3 } = require('vec3')
  // the palette's old names renamed BEFORE the library reads it - it turns a name it does not know (grass, chain) into
  // air without a word, so bare()'s renames never saw them (audit #34)
  let buf = fs.readFileSync(file)
  try {
    const nbt = require('prismarine-nbt')
    const { parsed, type } = await nbt.parse(buf)
    const root = parsed.value
    const sch = root.Schematic ? root.Schematic.value : root // (Sponge v3 wraps it all in a Schematic compound)
    const pal = (sch.Palette && sch.Palette.value) || (sch.Blocks && sch.Blocks.value.Palette && sch.Blocks.value.Palette.value)
    let changed = false
    if (pal) {
      for (const k of Object.keys(pal)) {
        const m = /^(minecraft:)?([a-z0-9_]+)(\[.*\])?$/.exec(k)
        const nk = m && RENAMED[m[2]] ? 'minecraft:' + RENAMED[m[2]] + (m[3] || '') : null
        if (nk && !(nk in pal)) { pal[nk] = pal[k]; delete pal[k]; changed = true } // (never over a key the file already has)
      }
    }
    if (changed) buf = zlib.gzipSync(nbt.writeUncompressed(parsed, type))
  } catch {}
  const s = await Schematic.read(buf, version)
  const st = s.start(); const en = s.end()
  return { sx: en.x - st.x + 1, sy: en.y - st.y + 1, sz: en.z - st.z + 1, at: (x, y, z) => { const b = s.getBlock(new Vec3(st.x + x, st.y + y, st.z + z)); return !b || NOTHING_RE.test(b.name) ? null : { name: b.name, props: b.getProperties() } } }
}

// blocks that need a block under them (a lantern standing, a candle, a pot)
const STANDS_ON_RE = /(?<!jack_o_|sea_)lantern$|candles?$|^torch$|_torch$|_carpet$|^flower_pot$|^potted_|_pressure_plate$|rail$|_sapling$|_banner$|^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_sign$/

// ---- load ------------------------------------------------------------------------------------------------
// one conversion per file version: the build command read the castle twice on the body's event loop (for its centre,
// then for the job) - 14-42k cells each time (2026-09-27, the GUI audit)
const loaded = new Map() // file -> { key, s }
async function load (name, version, { log = () => {} } = {}) {
  const file = findFile(name)
  if (!file) throw new Error('no blueprint ' + name + ' (' + EXTS.join(' ') + ')')
  const ckey = version + ':' + fs.statSync(file).mtimeMs
  const hit = loaded.get(file)
  if (hit && hit.key === ckey) return hit.s
  const ext = path.extname(file)
  const g = ext === '.litematic' ? await readLitematic(file) : ext === '.nbt' ? await readStructure(file) : await readSponge(file, version)
  const md = require('minecraft-data')(version)
  const Block = require('prismarine-block')(version)
  const { Schematic } = require('prismarine-schematic')
  const { Vec3 } = require('vec3')
  let planner = null
  try { planner = require('./materials').makePlanner(md) } catch {}
  const memo = new Map(); const stateOf = new Map()
  const palette = [Block.fromProperties('air', {}, 0).stateId]; const blocks = new Array(g.sx * g.sy * g.sz).fill(0)
  const report = { substituted: {}, dropped: {}, blocks: 0, file }
  for (let y = 0; y < g.sy; y++) {
    await new Promise(r => setImmediate(r)) // (a layer at a time: the body's ticks go on between them)
    for (let z = 0; z < g.sz; z++) for (let x = 0; x < g.sx; x++) {
    const c = g.at(x, y, z); if (!c) continue
    let to = resolve(c.name, md, planner, memo)
    // a skipped block that something stands on keeps a post in its place: the castle's lantern on a brewing stand could
    // never go in once the stand was skipped (2026-09-27)
    if (!to) { const up = g.at(x, y + 1, z); if (up && STANDS_ON_RE.test(up.name) && resolve(up.name, md, planner, memo)) to = 'cobblestone_wall' }
    if (!to) { report.dropped[c.name] = (report.dropped[c.name] || 0) + 1; continue }
    if (to !== c.name) { const k = c.name + '->' + to; report.substituted[k] = (report.substituted[k] || 0) + 1 }
    // a lantern standing in for something hung on a wall or ceiling (a bell) hangs from the block above when nothing is
    // under it (the castle's bell-lantern floated in the air, 2026-09-27)
    if (/^(?!jack_o_)(\w+_)?lantern$/.test(to) && !/lantern$/.test(c.name) && !g.at(x, y - 1, z) && g.at(x, y + 1, z)) c.props = Object.assign({}, c.props, { hanging: 'true' })
    const ck = to + JSON.stringify(c.props)
    let i = stateOf.get(ck)
    if (i == null) {
      const def = Block.fromStateId(md.blocksByName[to].defaultState, 0).getProperties()
      // the blueprint's own state where the stand-in has the same property (a stair's facing, a slab's half)
      // the blueprint's own state only where the stand-in HAS that value (a furnace facing "up" - an observer's - came out as
      // farmland: an out-of-range value walks the state id into the next block; audit #10)
      const st0 = md.blocksByName[to].states || []
      const valid = (k, v) => { const d = st0.find(x => x.name === k); return !!d && (d.type === 'bool' || !d.values || d.values.includes(String(v))) }
      const props = {}; for (const [k, v] of Object.entries(c.props)) if (k in def && valid(k, v)) props[k] = v === 'true' ? true : v === 'false' ? false : v
      const st = Block.fromProperties(to, Object.assign({}, def, props), 0).stateId
      i = palette.indexOf(st); if (i < 0) { palette.push(st); i = palette.length - 1 }
      stateOf.set(ck, i)
    }
    blocks[x + z * g.sx + y * g.sx * g.sz] = i
    report.blocks++
    }
  }
  const s = new Schematic(version, new Vec3(g.sx, g.sy, g.sz), new Vec3(0, 0, 0), palette, blocks)
  s.report = report
  loaded.set(file, { key: ckey, s })
  const n = o => Object.values(o).reduce((a, b) => a + b, 0)
  log('blueprint', `${path.basename(file)}: ${report.blocks} blocks, ${n(report.substituted)} swapped for overworld look-alikes ${JSON.stringify(report.substituted)}, ${n(report.dropped)} skipped ${JSON.stringify(report.dropped)}`)
  return s
}

module.exports = { load, resolve, findFile, DROP_RE, LOOKALIKE }
