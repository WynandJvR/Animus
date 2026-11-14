'use strict'
// THE CANE FARM: sugar cane that grows back by home. Wild cane is cut a player's way (the stalk's foot left - craft.GATHER),
// but its patches lie out along the shores, and the castle wants ~600 for its books. A player plants a row of cane at the
// water's edge by the base and cuts it as it grows (a block every ~18 minutes of a loaded day, three high).
//   spots: a soil block (grass, dirt, sand...) with water beside it at its own level, and air over it - the cane's cell -
//          within FARM_R of home, outside every protected zone, off the home grounds, never under or in the build, never
//          in someone else's place. Found by the bot's own look at the water round home, once a day (no operator spot).
//   size:  CANE_MAX stalks; each planted from the pack's cane (the bank's drawn), a few at a time, and a cut-down spot
//          (its cell empty) planted again.
//   cut:   by the cane trips themselves (pickPlants: a block with cane under it) - the farm's cane is cane like any.
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const FARM_R = 40
const CANE_MAX = 24
const PER_RUN = 8
const SOIL_RE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|sand|red_sand|mud|moss_block)$/

function farm () { return mem.get().caneFarm || { spots: [] } }
function key (p) { return `${p.x},${p.y},${p.z}` }
// (a cell the cane may stand in: air, with soil under it and water beside the soil at the soil's own level; ours to use)
function caneCellOK (bot, c) {
  const cell = world.at(bot, c.x, c.y, c.z); const soil = world.at(bot, c.x, c.y - 1, c.z)
  if (!cell || !soil || !SOIL_RE.test(soil.name)) return false
  if (!world.isAirish(cell) && cell.name !== 'sugar_cane') return false
  if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => world.isWaterBlock(world.at(bot, c.x + dx, c.y - 1, c.z + dz)))) return false
  if (move.inZone(c, 1) || move.inForeign(c) || move.underBuild(c)) return false
  try { if (require('./gather').onGrounds(c)) return false } catch {}
  return true
}
// WILD WATER ONLY (anti-grief): no solid block a hand made within 3 of the spot - our own cane and our own zones aside -
// and the water beside it open to the sky: a riverbank or a pond, never someone's moat, fountain, canal or garden by
// home (audit 2026-10-07). Asked of the day's candidates only (the scan's own pass).
const WILD_R = 3
function wildWater (bot, c) {
  for (let dx = -WILD_R; dx <= WILD_R; dx++) for (let dz = -WILD_R; dz <= WILD_R; dz++) for (let dy = -2; dy <= 2; dy++) {
    const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
    const b = world.at(bot, p.x, p.y, p.z)
    if (!b || !world.isSolid(b) || (world.NATURAL_RE.test(b.name) && !/^(mossy_)?cobblestone$|_log$|_wood$|_planks$/.test(b.name)) || b.name === 'sugar_cane') continue // (cobblestone and logs read as natural there: a walled moat is built; audit)
    if (move.inZone(p, 0)) continue // (our own: the farm's fence, the pen)
    return false
  }
  const water = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: c.x + dx, y: c.y - 1, z: c.z + dz })).filter(w => world.isWaterBlock(world.at(bot, w.x, w.y, w.z)))
  return water.some(w => world.openSky(bot, { x: w.x, y: w.y - 1, z: w.z }))
}
// NEW SPOTS: the water round home looked at once a game day - by the planting task itself (`scan`), never by a decision:
// decide() reads the day's list when there is one, and with none yet only says "maybe" (plantable)
let scanned = null // { day, list }
function scannedToday (bot) { return !!scanned && scanned.day === require('./day').dayNo(bot) }
function freshSpots (bot, { scan = false } = {}) {
  const day = require('./day').dayNo(bot)
  const home = mem.get().home
  if (!home) return []
  if (scanned && scanned.day === day) return scanned.list.filter(c => caneCellOK(bot, c) && !farm().spots.some(s => key(s) === key(c)))
  if (!scan) return []
  const list = []
  const seen = new Set()
  const water = world.findBlocks(bot, /^water$/, { maxDistance: FARM_R, count: 400, point: new (require('vec3').Vec3)(home.x, home.y, home.z) })
  for (const w of water) {
    if (Math.abs(w.position.y - home.y) > 10) continue // (by home, not down a cliff)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = { x: w.position.x + dx, y: w.position.y + 1, z: w.position.z + dz }
      if (seen.has(key(c))) continue
      seen.add(key(c))
      if (caneCellOK(bot, c)) list.push(c)
    }
  }
  list.sort((a, b) => world.dist3(a, home) - world.dist3(b, home))
  const wild = list.slice(0, 64).filter(c => wildWater(bot, c))
  scanned = { day, list: wild }
  log('cane', `the water by home looked at: ${wild.length} wild cane spot(s) of ${Math.min(list.length, 64)} by water`)
  return scanned.list.filter(c => !farm().spots.some(s => key(s) === key(c)))
}
// Spots with no cane in them now (cut to the ground, trampled) that can take it again
function emptySpots (bot) { return farm().spots.filter(s => { const b = world.at(bot, s.x, s.y, s.z); return b && world.isAirish(b) && caneCellOK(bot, s) }) }
// Would plant() put cane in the ground with `cane` to hand? (the director's trigger and the planter one rule)
function plantable (bot, cane) {
  if (cane <= 0) return false
  if (emptySpots(bot).length) return true
  if (farm().spots.length >= CANE_MAX) return false
  // (no look at the water yet today: maybe - the task looks, once; a day's look that found none says no)
  return scannedToday(bot) ? freshSpots(bot).length > 0 : true
}
async function plant (bot, { shouldStop } = {}) {
  // (forgotten: a spot whose soil or water is gone)
  const f = farm()
  const keep = f.spots.filter(s => { const b = world.at(bot, s.x, s.y, s.z); return !b || caneCellOK(bot, s) })
  if (keep.length !== f.spots.length) { log('cane', `forgot ${f.spots.length - keep.length} cane spot(s) - no soil or water there now`); mem.set('caneFarm', { spots: keep }) }
  const todo = emptySpots(bot).concat(freshSpots(bot, { scan: true }).slice(0, Math.max(0, CANE_MAX - farm().spots.length))).slice(0, PER_RUN)
  let planted = 0
  for (const c of todo) {
    if (shouldStop && shouldStop()) break
    if (!inv.count(bot, 'sugar_cane')) break
    await reflex.waitClear()
    if (!caneCellOK(bot, c)) continue
    if (!await act.place(bot, c, 'sugar_cane', { faceHint: [[0, -1, 0]] })) continue
    await new Promise(r => setTimeout(r, 300))
    const now = world.at(bot, c.x, c.y, c.z)
    if (now && now.name === 'sugar_cane') {
      planted++
      if (!farm().spots.some(s => key(s) === key(c))) mem.update(m => { m.caneFarm = m.caneFarm || { spots: [] }; m.caneFarm.spots.push({ x: c.x, y: c.y, z: c.z }) })
    }
  }
  if (planted) log('cane', `planted ${planted} sugar cane at the water by home (${farm().spots.length} of ${CANE_MAX} stalks)`)
  return planted
}
function info () { return { spots: farm().spots.length, max: CANE_MAX } }
module.exports = { plantable, plant, info, CANE_MAX, PER_RUN }
