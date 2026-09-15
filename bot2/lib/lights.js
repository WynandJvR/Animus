'use strict'
// Light the ground around home. Hostile mobs spawn only in darkness (block light 0 since 1.18): a grid of
// torches around the safehouse stops the zombies and skeletons that spawned at its door every night - the
// ones that kept the bot from sleeping ("monsters nearby") and killed it on its doorstep.
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const { log } = require('./log')

const RADIUS = 16
const STEP = 6

// Grid points around home that still want a torch (no light block within 4 of the point). Cached a minute:
// the director asks every loop and this is dozens of block searches.
let cache = { at: 0, spots: [] }
const refused = new Set() // spots a torch would not go on (odd ground) - not tried again
function darkSpots (bot, { fresh = false } = {}) {
  if (!fresh && Date.now() - cache.at < 60000) return cache.spots
  cache = { at: Date.now(), spots: scanDark(bot) }
  return cache.spots
}
function scanDark (bot) {
  const home = mem.get().home
  if (!home) return []
  const farm = mem.get().farm
  const onFarm = p => farm && farm.cells.some(c => Math.abs(c.x - p.x) <= 1 && Math.abs(c.z - p.z) <= 1)
  const out = []
  for (let dx = -RADIUS; dx <= RADIUS; dx += STEP) for (let dz = -RADIUS; dz <= RADIUS; dz += STEP) {
    if (Math.abs(dx) + Math.abs(dz) < 4) continue // the hut itself has its light
    const x = home.x + dx; const z = home.z + dz
    const gy = world.groundY(bot, x, z, home.y + 8)
    if (gy == null || Math.abs(gy + 1 - home.y) > 6) continue
    const p = { x, y: gy + 1, z }
    const floor = world.at(bot, x, gy, z); const cell = world.at(bot, x, p.y, z)
    if (!floor || !world.isSolid(floor) || !cell || !world.isAirish(cell)) continue
    if (/(chest|furnace|crafting_table|_bed|_leaves|farmland)$/.test(floor.name)) continue
    if (move.inZone(p, 1) && move.inZone(p, 1).label !== 'base') continue
    if (move.insideHut(p) || onFarm(p) || !move.utilitySpotOK(p)) continue
    if (world.findBlocks(bot, /(torch|lantern|glowstone|campfire)$/, { maxDistance: 4, count: 1, point: new (require('vec3').Vec3)(x, p.y, z) }).length) continue
    if (refused.has(`${p.x},${p.y},${p.z}`)) continue
    out.push(p)
  }
  const me = bot.entity.position
  return out.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))
}

async function lightBase (bot, { shouldStop } = {}) {
  const spots = darkSpots(bot, { fresh: true })
  if (!spots.length) return true
  if (inv.count(bot, 'torch') < Math.min(spots.length, 8)) {
    await require('./base').withdraw(bot, 'torch', spots.length).catch(() => 0)
    if (inv.count(bot, 'torch') < Math.min(spots.length, 4)) {
      const have = inv.count(bot, 'coal') + inv.count(bot, 'charcoal') + require('./base').bankCount('coal') + require('./base').bankCount('charcoal')
      if (have > 0) await require('./craft').ensure(bot, 'torch', inv.count(bot, 'torch') + Math.min(spots.length, 16), { shouldStop }).catch(() => false)
    }
  }
  let placed = 0
  for (const p of spots) {
    if (shouldStop && shouldStop()) break
    if (!inv.has(bot, 'torch')) break
    if (await act.place(bot, p, 'torch', { faceHint: [[0, -1, 0]], allowZones: ['base'], sneak: false })) placed++
    else refused.add(`${p.x},${p.y},${p.z}`)
  }
  cache.at = 0
  if (placed) log('base', `lit ${placed} dark spot${placed > 1 ? 's' : ''} around home`)
  return placed > 0
}

module.exports = { darkSpots, lightBase }
