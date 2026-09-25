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

// A fall of more than this many blocks hurts (vanilla: damage = distance - 3). The pathfinder's maxDropDown and the
// body's edge guard both read it: one number for "a drop the body may take".
const SAFE_DROP = 3
// How far the body would fall stepping into column (x,z) with its feet at y: the air cells under the feet down to the
// first floor. Water under us breaks a fall (0); a wall at the feet is no drop (0); lava or unloaded ground is a
// drop without end (Infinity - unknown is unsafe). Water under us breaks a fall.
function dropAt (bot, x, y, z, max = 32) {
  const feet = at(bot, x, y, z)
  if (!feet) return Infinity
  if (isSolid(feet) || isWaterBlock(feet)) return 0
  for (let k = 0; k <= max; k++) {
    const b = at(bot, x, y - 1 - k, z)
    if (!b || isLavaBlock(b)) return Infinity
    if (isWaterBlock(b)) return 0 // (landing in water of any depth takes no fall damage)
    if (b.boundingBox === 'block') return k
  }
  return Infinity
}

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
// Ticks a walk from a to b takes: along the ground plus the climb (a staircase is a step across for every step up), at a
// little over walking pace for the detours (4.3 b/s, x1.4). HOME_MARGIN: daylight kept in hand on the way (a fight, a
// door, a detour) - clay's turn-back and every day trip's (director.homeByDark) are the same rule.
function walkTicks (a, b) { return (dist2(a, b) + Math.abs(a.y - b.y)) / 4.3 * 20 * 1.4 }
const HOME_MARGIN = 1800
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

// ---- block search ----------------------------------------------------------------------------
// The state ids of the block types a regex names (a section's palette holds state ids, not block ids).
const stateCache = new Map()
function stateIds (bot, re) {
  const key = String(re)
  let s = stateCache.get(key)
  if (!s) {
    s = new Set()
    for (const b of Object.values(data(bot).blocksByName)) if (re.test(b.name)) for (let i = b.minStateId; i <= b.maxStateId; i++) s.add(i)
    stateCache.set(key, s)
  }
  return s
}
// Can this chunk section hold one of `states`? Answered from its palette, never block by block. mineflayer's own
// search knows only the indirect palette: a UNIFORM section (all air, all stone - most of the world) is a
// single-value container with no palette, which it took for the global palette and read all 4096 blocks of - every
// air section in reach. A sand search of radius 128 that found nothing took 4.0s and a filtered water search 4.3s,
// all of it on the event loop: 128 stalls of up to 13s on 2026-09-23, one of them while a zombie killed the bot.
function sectionMay (section, states) {
  if (!section) return states.has(0)
  const d = section.data
  if (d && d.palette == null && d.value !== undefined) return states.has(d.value)
  const pal = section.palette || (d && d.palette)
  if (pal) { for (const s of pal) if (states.has(s)) return true; return false }
  return true // a direct (global-palette) section: it may hold anything
}
// THE block search: sections nearest first, each ruled out by its palette or read raw (state ids, no Block objects);
// a Block is made only for a match, and only to hand to `filter`. A generator, so the same search runs straight
// through (findBlocks) or in slices that give the event loop back (scanBlocks).
function * search (bot, states, { maxDistance, count, point, filter }, stats) {
  const px = Math.floor(point.x); const py = Math.floor(point.y); const pz = Math.floor(point.z)
  const r = maxDistance; const r2 = r * r
  const minY = bot.game.minY; const maxY = minY + bot.game.height - 1
  const secs = []
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v
  for (let cx = (px - r) >> 4; cx <= (px + r) >> 4; cx++) {
    for (let cz = (pz - r) >> 4; cz <= (pz + r) >> 4; cz++) {
      const col = bot.world.getColumn(cx, cz)
      if (!col || !col.sections) continue
      for (let sy = Math.max(minY, py - r) >> 4; sy <= Math.min(maxY, py + r) >> 4; sy++) {
        const nx = clamp(px, cx * 16, cx * 16 + 15) - px; const ny = clamp(py, sy * 16, sy * 16 + 15) - py; const nz = clamp(pz, cz * 16, cz * 16 + 15) - pz
        const d2 = nx * nx + ny * ny + nz * nz
        if (d2 <= r2) secs.push({ col, cx, sy, cz, d2 })
      }
    }
  }
  secs.sort((a, b) => a.d2 - b.d2)
  const found = []
  let sinceYield = 0
  for (const s of secs) {
    // nothing in this section (or any after it) can be nearer than the count-th found
    if (found.length >= count && s.d2 > found[count - 1].d2) break
    stats.sections++
    const section = s.col.sections[s.sy - (minY >> 4)]
    if (!sectionMay(section, states)) continue
    const data = section ? section.data : null
    const bx = s.cx * 16; const by = s.sy * 16; const bz = s.cz * 16
    for (let i = 0; i < 4096; i++) {
      if (!states.has(data ? data.get(i) : 0)) continue
      const x = bx + (i & 15); const y = by + (i >> 8); const z = bz + ((i >> 4) & 15)
      const dx = x - px; const dy = y - py; const dz = z - pz
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > r2) continue
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) continue
      if (filter) {
        stats.judged++
        if (++sinceYield >= 256) { sinceYield = 0; yield }
        if (!b.position || !filter(b)) continue
      }
      found.push({ b, d2 })
    }
    found.sort((a, b) => a.d2 - b.d2)
    if (found.length > count * 4) found.length = count * 4 // (a uniform stone section matches 4096 times)
    yield
  }
  return found.slice(0, count).map(f => f.b)
}
function searchArgs (bot, re, { maxDistance = 48, count = 64, point, filter } = {}) {
  return { maxDistance, count, point: point || bot.entity.position, filter }
}
function noteSlow (re, o, stats, n, ms, sliced) {
  // a scan on the event loop stops the reflexes and the keep-alives while it runs: name the slow ones
  if (ms > (sliced ? 2000 : 150)) require('./log').log('lag', `${sliced ? 'scanBlocks' : 'findBlocks'} ${re} r${o.maxDistance}: ${n} found in ${ms}ms (${stats.sections} sections, ${stats.judged} judged)`)
}
// How far the bot can see: out to the furthest chunk column the client holds (the server's view distance, whatever it
// is set to), from where we stand - never less than a search's usual 64.
function sightReach (bot) {
  let far = 0
  try {
    const me = bot.entity.position
    const cols = bot.world.getColumns ? bot.world.getColumns() : []
    for (const c of cols) {
      const cx = (c.chunkX != null ? c.chunkX : c.x) * 16 + 8; const cz = (c.chunkZ != null ? c.chunkZ : c.z) * 16 + 8
      const d = Math.hypot(cx - me.x, cz - me.z)
      if (d > far) far = d
    }
  } catch {}
  return Math.max(64, Math.floor(far))
}
// Nearest blocks by name regex, nearest first, straight through. For searches that are cheap by construction (a
// small radius, no heavy filter); anything big goes through scanBlocks.
function findBlocks (bot, re, opts = {}) {
  const states = stateIds(bot, re)
  if (!states.size) return []
  const o = searchArgs(bot, re, opts)
  const stats = { sections: 0, judged: 0 }
  const t0 = Date.now()
  const it = search(bot, states, o, stats)
  let r; while (!(r = it.next()).done);
  noteSlow(re, o, stats, r.value.length, Date.now() - t0, false)
  return r.value
}
// The same search in slices of a few ms, the event loop given back between them (the reflex runs every 200ms; a
// physics tick every 50). For big radii and filters that read the world around each match.
const SLICE_MS = 8
async function scanBlocks (bot, re, opts = {}) {
  const states = stateIds(bot, re)
  if (!states.size) return []
  const o = searchArgs(bot, re, opts)
  const stats = { sections: 0, judged: 0 }
  const t0 = Date.now()
  const it = search(bot, states, o, stats)
  let slice = Date.now()
  for (;;) {
    const r = it.next()
    if (r.done) { noteSlow(re, o, stats, r.value.length, Date.now() - t0, true); return r.value }
    if (Date.now() - slice >= SLICE_MS) { await new Promise(resolve => setImmediate(resolve)); slice = Date.now() }
  }
}

function hasAirNeighbour (bot, p) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = at(bot, p.x + dx, p.y + dy, p.z + dz)
    if (b && isAirish(b)) return true
  }
  return false
}

module.exports = { walkTicks, HOME_MARGIN, SAFE_DROP, dropAt,
  data, v, at, name, isWaterBlock, isLavaBlock, isSolid, isAirish, standable, feetPos, eyeBlock,
  headInWater, feetInWater, inLava, tod, phase, isNight, isDay, ticksUntilNight, canSleepNow, lavaNear, waterNear,
  groundY, openSky, dist2, dist3, blockIds, findBlocks, scanBlocks, stateIds, sectionMay, sightReach, hasAirNeighbour,
  WATER_RE, LAVA_RE, LOG_RE, LEAF_RE, NATURAL_RE, FALLING_RE, DANGER_FLOOR_RE
}
