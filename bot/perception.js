'use strict'
// PERCEPTION: read-only world/self observation. "What is around me right now" - facing,
// nearby entities, biome, nearest hostile, players, worn armor, and immediate hazards.
// Split out of commands.js unchanged.
//
// Every function here READS the world and returns plain data. None of them mutate module
// state, own a latch, or drive the body - which is exactly why they were separable from
// the command layer's build/telemetry state. The aggregate snapshot builder `state(bot)`
// deliberately STAYS in commands.js: it stitches these reads together with the activity /
// outcome / progress records that commands.js owns.
//
// Cycle note: `hazards` needs provision.hasSolidCeiling, and provision.js already requires
// commands.js lazily (provision.js:62 and friends). The require here is LAZY for the same
// reason - it keeps module load order free of a top-level cycle.

// Entity names treated as hostile for threat reporting and auto-defense. This is the
// canonical list; index.js keeps a byte-identical copy as HOSTILE_RE. NOTE: provision.js
// has a deliberately NARROWER SHELTER_HOSTILE (overworld-surface mobs only) - shelter
// decisions intentionally ignore nether/end/ocean mobs the combat reflex still fights.
const HOSTILE = /zombie|skeleton|spider|creeper|enderman|witch|husk|drowned|pillager|vindicator|ravager|slime|magma_cube|blaze|piglin|hoglin|phantom|zoglin|stray|silverfish|guardian|vex|wither|warden|ghast|shulker|illusioner|evoker|breeze|bogged/i

// Cardinal facing from yaw, so the brain knows which way "forward" is.
function facing (yaw) {
  const dirs = ['south', 'west', 'north', 'east']
  return dirs[(Math.round(yaw / (Math.PI / 2)) % 4 + 4) % 4]
}

function summariseEntities (bot, maxDist = 16) {
  const me = bot.entity.position
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue
    const d = e.position.distanceTo(me)
    if (d > maxDist) continue
    out.push({
      type: e.name || e.displayName || e.type,
      kind: e.type, // 'player' | 'mob' | 'object' | 'orb' ...
      dist: +d.toFixed(1),
      pos: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) }
    })
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, 12)
}

// Biome at a position. atFeet is usually air (whose biome can read blank), so
// prefer the solid block below; fall back to the world biome table by id.
function biomeName (bot, p) {
  try {
    const b = bot.blockAt(p.offset(0, -1, 0)) || bot.blockAt(p)
    if (b && b.biome && b.biome.name) return b.biome.name
    if (bot.world && typeof bot.world.getBiome === 'function') {
      const md = require('minecraft-data')(bot.version)
      const bio = md.biomes && md.biomes[bot.world.getBiome(p)]
      if (bio && bio.name) return bio.name
    }
  } catch { /* biome data not ready */ }
  return null
}

// Nearest hostile mob, so the brain can reason about danger (retreat / call for
// help / pick a safe fight) instead of relying only on the reflex auto-defend.
function nearestThreat (bot, maxDist = 16) {
  const me = bot.entity && bot.entity.position
  if (!me) return null
  let best = null; let bestD = maxDist
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
    if (!HOSTILE.test(e.name || '')) continue
    const d = e.position.distanceTo(me); if (d < bestD) { bestD = d; best = e }
  }
  return best ? { type: best.name, dist: +bestD.toFixed(1), flee: /creeper/.test(best.name || '') } : null
}

function nearbyPlayers (bot) {
  const me = bot.entity.position
  return Object.values(bot.players || {})
    .filter(p => p.entity && p.username !== bot.username)
    .map(p => ({
      name: p.username,
      dist: +p.entity.position.distanceTo(me).toFixed(1),
      pos: { x: Math.round(p.entity.position.x), y: Math.round(p.entity.position.y), z: Math.round(p.entity.position.z) }
    }))
    .sort((a, b) => a.dist - b.dist)
}

// The armor pieces the bot ACTUALLY has equipped, per slot (null if bare). Read
// straight from the armor inventory slots, so /state reflects worn gear and the
// brain can't claim to be wearing something it isn't (or re-wear what it has on).
function wornArmor (bot) {
  const out = { head: null, torso: null, legs: null, feet: null }
  try {
    for (const slot of ['head', 'torso', 'legs', 'feet']) {
      const it = bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
      if (it) out[slot] = it.name
    }
  } catch { /* not spawned / slots not ready */ }
  return out
}

// Does this block hold water at head height (so a submerged head = drowning)? True for
// a water source/flow, a bubble column, aquatic plants that only grow underwater
// (seagrass/kelp), and any WATERLOGGED block (waterlogged stairs/slabs/fences, coral,
// etc.). Property name varies by mineflayer version, so probe both shapes defensively.
function isWaterlogged (b) {
  if (!b) return false
  if (b.name === 'water' || b.name === 'bubble_column') return true
  if (/seagrass|kelp/.test(b.name)) return true
  try {
    const props = (typeof b.getProperties === 'function' ? b.getProperties() : b._properties) || {}
    if (props.waterlogged === true || props.waterlogged === 'true') return true
  } catch { /* no props */ }
  return false
}

// Immediate environmental dangers, so the brain can act (get out of the fire/lava,
// surface for air, dig up if trapped). Uses the same block/entity/physics reads the
// rest of state() uses; every field is best-effort and never throws.
function hazards (bot) {
  const ent = bot.entity
  const p = ent && ent.position
  let onFire = false
  let headWater = false
  try {
    const at = p && bot.blockAt(p)
    const head = p && bot.blockAt(p.offset(0, 1, 0))
    if ((at && /^(fire|soul_fire)$/.test(at.name)) || (head && /^(fire|soul_fire)$/.test(head.name))) onFire = true
    // entity "burning" flag (bit 0x01 of metadata index 0) - catches fire that clings
    // after we step off the flames. Best-effort: metadata shape varies by version.
    if (!onFire && ent && ent.metadata && (Number(ent.metadata[0]) & 0x01)) onFire = true
    // Drowning = HEAD block holds water (terrain truth). We do NOT use bot.oxygenLevel:
    // on a live 1.21 server it reads ~4 on DRY LAND (not the ~20 you'd expect), so an
    // `oxygen <= 6` test fires drowning=true everywhere and floods the brain with a false
    // "get out of the water" hazard. Head-block truth can't false-positive on land. Must
    // count WATERLOGGED blocks too - a real river bottom is seagrass/kelp (waterlogged,
    // NOT named "water"), so a bare /water/ name test would miss actual submersion.
    if (isWaterlogged(head)) headWater = true
  } catch { /* world/metadata not ready */ }
  return {
    underground: (() => { try { return require('./provision.js').hasSolidCeiling(bot, 45, { ignoreLeaves: true }) } catch { return false } })(),
    onFire,
    inLava: !!(ent && ent.isInLava),
    inWater: !!(ent && ent.isInWater),
    drowning: headWater,
    onGround: !!(ent && ent.onGround) // NAV P0 observability: the water-pocket wedge signature is inWater+underground+!onGround
  }
}

module.exports = { HOSTILE, facing, summariseEntities, biomeName, nearestThreat, nearbyPlayers, wornArmor, isWaterlogged, hazards }
