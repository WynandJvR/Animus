'use strict'
// Reading the world. Every predicate here answers from blocks the client actually has; an
// unloaded cell (null) is UNKNOWN and callers treat unknown as unsafe.
const { Vec3 } = require('vec3')

let mcData = null
function data (bot) { if (!mcData) mcData = require('minecraft-data')(bot.version); return mcData }

const WATER_RE = /^(water|flowing_water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
const LAVA_RE = /^(lava|flowing_lava)$/
const DANGER_FLOOR_RE = /^(magma_block|campfire|soul_campfire|fire|soul_fire|sweet_berry_bush|cactus|powder_snow|pointed_dripstone|wither_rose)$/
const FALLING_RE = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*concrete_powder)$/
const LOG_RE = /_(log|stem)$/
const LEAF_RE = /_leaves$/
// Natural terrain the bot may dig anywhere outside protected zones. Crafted blocks are never here.
const NATURAL_RE = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|gravel|sand|red_sand|sandstone|red_sandstone|stone|cobblestone|mossy_cobblestone|deepslate|cobbled_deepslate|tuff|calcite|granite|diorite|andesite|dripstone_block|snow|snow_block|ice|packed_ice|netherrack|soul_sand|soul_soil|basalt|blackstone|terracotta|[a-z_]*_terracotta|.*_ore|raw_[a-z]*_block|amethyst_block|budding_amethyst|moss_block|short_grass|tall_grass|fern|large_fern|dead_bush|leaf_litter|.*_leaves|.*_log|.*_wood|mangrove_roots|muddy_mangrove_roots|obsidian|smooth_basalt|glow_lichen|vine|hanging_roots|big_dripleaf|small_dripleaf|pointed_dripstone|sculk|sculk_vein|infested_.*|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|allium|blue_orchid|sunflower|lilac|rose_bush|peony|pink_petals|brown_mushroom|red_mushroom|sweet_berry_bush|pumpkin|melon|bamboo|sugar_cane|cactus|seagrass|kelp|kelp_plant|firefly_bush|bush|cactus_flower|short_dry_grass|tall_dry_grass|wildflowers)$/

function v (x, y, z) { return new Vec3(x, y, z) }
function at (bot, x, y, z) { return bot.blockAt(v(Math.floor(x), Math.floor(y), Math.floor(z))) }
function name (bot, x, y, z) { const b = at(bot, x, y, z); return b ? b.name : null }

function isWaterBlock (b) {
  if (!b) return false
  if (WATER_RE.test(b.name)) return true
  try { const p = b.getProperties(); if (p && p.waterlogged === true) return true } catch {}
  return false
}
function isLavaBlock (b) { return !!b && LAVA_RE.test(b.name) }
function isSolid (b) { return !!b && b.boundingBox === 'block' && !isWaterBlock(b) && !isLavaBlock(b) }
function isAirish (b) { return !!b && b.boundingBox === 'empty' && !isWaterBlock(b) && !isLavaBlock(b) }

// Can a player stand with feet at (x,y,z)? Solid, non-hazard floor; two clear cells.
function standable (bot, x, y, z) {
  const floor = at(bot, x, y - 1, z)
  const feet = at(bot, x, y, z)
  const head = at(bot, x, y + 1, z)
  if (!floor || !feet || !head) return false
  if (!isSolid(floor) || DANGER_FLOOR_RE.test(floor.name)) return false
  return isAirish(feet) && isAirish(head)
}

function feetPos (bot) { return bot.entity.position.floored() }
function eyeBlock (bot) { const p = bot.entity.position; return at(bot, p.x, p.y + 1.62, p.z) }
function headInWater (bot) { return isWaterBlock(eyeBlock(bot)) }
function feetInWater (bot) { const p = bot.entity.position; return isWaterBlock(at(bot, p.x, p.y, p.z)) }
function inLava (bot) {
  const p = bot.entity.position
  return isLavaBlock(at(bot, p.x, p.y, p.z)) || isLavaBlock(at(bot, p.x, p.y + 1, p.z))
}

function tod (bot) { return bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 6000 }
// ONE definition of the day's phases - every "is it night / dusk / time to stop" asks this.
// (Two thresholds for one idea twice produced a window where a task was chosen and then instantly
// cancelled by its own stop condition.)
//   day   23200..12000  outdoor work
//   dusk  12000..12900  head home, bed down
//   night 12900..23200  mobs spawn
function phase (bot) { const t = tod(bot); if (t >= 12900 && t < 23200) return 'night'; if (t >= 12000 && t < 12900) return 'dusk'; return 'day' }
function isNight (bot) { return phase(bot) === 'night' }
function isDay (bot) { return phase(bot) === 'day' }
function ticksUntilNight (bot) { const t = tod(bot); if (isNight(bot)) return 0; return t < 12900 ? 12900 - t : 24000 - t + 12900 }
function canSleepNow (bot) { const t = tod(bot); return (t >= 12542 && t < 23460) || bot.thunderState > 0 }

// Is any lava within r blocks (a cube) of pos?
function lavaNear (bot, pos, r = 2) {
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    if (isLavaBlock(at(bot, pos.x + dx, pos.y + dy, pos.z + dz))) return true
  }
  return false
}
function waterNear (bot, pos, r = 2, dyMin = -1, dyMax = 1) {
  for (let dx = -r; dx <= r; dx++) for (let dy = dyMin; dy <= dyMax; dy++) for (let dz = -r; dz <= r; dz++) {
    if (isWaterBlock(at(bot, pos.x + dx, pos.y + dy, pos.z + dz))) return true
  }
  return false
}

// Highest solid, non-leaf block in a column (the ground a player walks on), scanning down from
// `fromY`. Returns the Y of the ground block, or null if nothing loaded.
function groundY (bot, x, z, fromY) {
  const top = fromY != null ? fromY : Math.floor(bot.entity.position.y) + 24
  for (let y = top; y > top - 64; y--) {
    const b = at(bot, x, y, z)
    if (!b) return null
    if (isSolid(b) && !LEAF_RE.test(b.name) && !LOG_RE.test(b.name)) return y
    if (isWaterBlock(b)) return y // water surface counts as "ground" for the caller to reject
  }
  return null
}

// Sky above the head? (open to the sky - no solid block for 20 up)
function openSky (bot, pos) {
  for (let y = pos.y + 2; y < pos.y + 22; y++) { const b = at(bot, pos.x, y, pos.z); if (b && b.boundingBox === 'block') return false }
  return true
}

function dist2 (a, b) { const dx = a.x - b.x; const dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz) }
function dist3 (a, b) { const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz) }

function blockIds (bot, re) {
  const md = data(bot)
  return Object.values(md.blocksByName).filter(b => re.test(b.name)).map(b => b.id)
}

// Nearest blocks by name regex, sorted by distance. Uses the client's chunk index (fast).
function findBlocks (bot, re, { maxDistance = 48, count = 64, point, filter } = {}) {
  const ids = blockIds(bot, re)
  if (!ids.length) return []
  const me = point || bot.entity.position
  const out = []
  if (filter) {
    // filtered DURING the search: the nearest N-then-filter version returned nothing near home, where the
    // nearest few hundred dirt blocks are all buried or inside the base zone
    // (useExtraInfo as a FUNCTION: sections without the block are skipped and the filter runs only on matching
    //  blocks - useExtraInfo:true would read every block of every section)
    const found = bot.findBlocks({ matching: ids, useExtraInfo: b => !!b && !!b.position && filter(b), maxDistance, count, point: me })
    for (const p of found) { const b = bot.blockAt(p); if (b) out.push(b) }
  } else {
    const found = bot.findBlocks({ matching: ids, maxDistance, count, point: me })
    for (const p of found) { const b = bot.blockAt(p); if (b) out.push(b) }
  }
  out.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
  return out
}

function hasAirNeighbour (bot, p) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = at(bot, p.x + dx, p.y + dy, p.z + dz)
    if (b && isAirish(b)) return true
  }
  return false
}

module.exports = {
  data, v, at, name, isWaterBlock, isLavaBlock, isSolid, isAirish, standable, feetPos, eyeBlock,
  headInWater, feetInWater, inLava, tod, phase, isNight, isDay, ticksUntilNight, canSleepNow, lavaNear, waterNear,
  groundY, openSky, dist2, dist3, blockIds, findBlocks, hasAirNeighbour,
  WATER_RE, LAVA_RE, LOG_RE, LEAF_RE, NATURAL_RE, FALLING_RE, DANGER_FLOOR_RE
}
