'use strict'
// THE ORCHARD: a tree farm by home - wood and fuel that grow back. Wild trees round a site run out (sparse oaks gave
// ~20 logs an hour round Notre-Dame, 2026-09-24) and every log was a walk further out. A player plants the saplings
// the leaves drop, in a grid near the base, and cuts the grown trees on the way past.
//   size: every sapling we have goes in, up to the trees the build still needs (the director says how many) and the
//         open ground round home - it grows to the demand by itself (a tree's leaves give back more saplings than
//         the one it took) and stops there
//   spots: a 3-spaced grid of soil cells, open sky over them, 16+ blocks from home (past the furnace bank), outside
//          every protected zone; registered as the 'orchard' zone so nothing digs it up
const { Vec3 } = require('vec3')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const SAPLING_RE = /^(oak|spruce|birch|jungle|acacia|cherry)_sapling$/ // (dark oak needs four in a square: never alone)
const SOIL_RE = /^(grass_block|dirt|podzol|coarse_dirt|rooted_dirt|moss_block)$/
const GROW_ROOM = 7 // air a sapling needs over it to grow (vanilla: the trunk plus the crown)
const SPACING = 3 // one trunk every third cell: the crowns touch, the trunks stay walkable between

function orchard () { return mem.get().orchard || null }
// Nothing in the cell - a sapling included: it has no collision box, so "airish" took a planted spot for an empty one
// and the bot spent 15 minutes planting oak on top of birch saplings (2026-09-24)
function free (b) { return !!b && world.isAirish(b) && !SAPLING_RE.test(b.name) && !world.LOG_RE.test(b.name) }
// One small box per tree: its trunk cell and the ring round it, soil to crown (never one box round them all - spread
// round home, that box took in the base, the farm and the furnaces, 2026-09-24)
function boxOf (s) { return { x1: s.x - 1, x2: s.x + 1, z1: s.z - 1, z2: s.z + 1, y1: s.y - 1, y2: s.y + GROW_ROOM + 2 } }
function setZone () { const o = orchard(); move.setZones('orchard', o ? o.spots.map(boxOf) : []) }

// A cell a sapling can go in and grow: soil under, air (or a sapling / our own trunk) in it, open sky and room above.
function spotOK (bot, p) {
  const soil = world.at(bot, p.x, p.y - 1, p.z)
  if (!soil || !SOIL_RE.test(soil.name)) return false
  for (let dy = 0; dy <= GROW_ROOM; dy++) {
    const b = world.at(bot, p.x, p.y + dy, p.z)
    if (!b) return false
    if (dy === 0 && (SAPLING_RE.test(b.name) || world.LOG_RE.test(b.name))) continue
    if (!world.isAirish(b) && !(dy > 0 && world.LEAF_RE.test(b.name))) return false
  }
  return world.openSky(bot, { x: p.x, y: p.y + GROW_ROOM, z: p.z })
}

// New spots: the grid cells in rings out from home (16..48), nearest first, outside every protected zone and clear of
// the safehouse; `n` of them at most.
function newSpots (bot, n) {
  const home = mem.get().home
  if (!home || n <= 0) return []
  const have = (orchard() || { spots: [] }).spots
  const taken = new Set(have.map(s => `${s.x},${s.z}`))
  // the grid (every SPACING-th cell from home), 16..48 out, nearest first
  const cells = []
  for (let dx = -48; dx <= 48; dx += SPACING) for (let dz = -48; dz <= 48; dz += SPACING) {
    const r = Math.max(Math.abs(dx), Math.abs(dz))
    if (r < 16) continue
    cells.push({ x: home.x + dx, z: home.z + dz, d: Math.hypot(dx, dz) })
  }
  cells.sort((a, b) => a.d - b.d)
  const out = []
  for (const c of cells) {
    if (out.length >= n) break
    if (taken.has(`${c.x},${c.z}`)) continue
    const gy = world.groundY(bot, c.x, c.z, home.y + 12)
    if (gy == null || Math.abs(gy + 1 - home.y) > 8) continue // (a short walk from home, not down a cliff)
    const p = { x: c.x, y: gy + 1, z: c.z }
    // (clear of every other zone; the orchard's own trees are its grid neighbours, 3 apart - taken is the check there)
    if (move.inZone(p, 2, ['orchard']) || !spotOK(bot, p)) continue
    out.push(p)
  }
  return out
}

// Grown: a log where the sapling was.
function grown (bot) {
  const o = orchard()
  if (!o) return []
  return o.spots.filter(s => { const b = world.at(bot, s.x, s.y, s.z); return b && world.LOG_RE.test(b.name) })
}
function empty (bot) {
  const o = orchard()
  if (!o) return []
  return o.spots.filter(s => { const b = world.at(bot, s.x, s.y, s.z); return free(b) && spotOK(bot, s) })
}
function saplings (bot) { return inv.items(bot).filter(i => SAPLING_RE.test(i.name)) }
function saplingCount (bot) { return saplings(bot).reduce((a, i) => a + i.count, 0) }

// Saplings wanted: spots to fill now, up to the demand. The fell loop breaks leaves only while this is > 0.
function wantSaplings (bot, demandTrees) {
  const o = orchard()
  const spots = o ? o.spots.length : 0
  const room = Math.max(0, Math.min(demandTrees, 400) - spots) + empty(bot).length
  return Math.max(0, room - saplingCount(bot))
}

// Plant the saplings in the pack: empty spots first, then new spots up to the demand.
// A spot is dead when its cell holds something a sapling can't grow through (a dirt pillar went up on one, grass took
// another, 2026-09-24): dropped, so fresh spots take its place.
function dropSpot (s, why) {
  mem.update(m => { m.orchard.spots = m.orchard.spots.filter(q => !(q.x === s.x && q.y === s.y && q.z === s.z)) })
  log('orchard', `dropped the spot at ${move.fmt(s)} (${why})`)
}
function pruneDead (bot) {
  const o = orchard()
  if (!o) return
  for (const s of o.spots.slice()) {
    const b = world.at(bot, s.x, s.y, s.z)
    if (!b) continue // (unloaded: unknown, kept)
    if (SAPLING_RE.test(b.name) || world.LOG_RE.test(b.name)) continue
    if (!spotOK(bot, s)) dropSpot(s, `${b.name} there now`)
  }
}

async function plant (bot, { demandTrees = 0, shouldStop } = {}) {
  let o = orchard()
  if (!o) { o = { spots: [] }; mem.set('orchard', o) }
  pruneDead(bot)
  const fill = empty(bot)
  const more = Math.max(0, Math.min(saplingCount(bot) - fill.length, demandTrees - o.spots.length))
  const fresh = newSpots(bot, more)
  if (fresh.length) { mem.update(m => { m.orchard.spots = m.orchard.spots.concat(fresh) }); setZone() }
  let planted = 0
  for (const s of fill.concat(fresh)) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const sap = saplings(bot)[0]
    if (!sap) break
    const b = world.at(bot, s.x, s.y, s.z)
    if (!free(b)) continue
    if (!await act.place(bot, s, sap.name, { faceHint: [[0, -1, 0]], allowZones: ['orchard'] })) continue
    // it must stay there: a sapling that pops off at once came back as "planted" eleven times in 2s (2026-09-24)
    await new Promise(r => setTimeout(r, 300))
    const now = world.at(bot, s.x, s.y, s.z)
    if (now && SAPLING_RE.test(now.name)) planted++
    else dropSpot(s, `the sapling did not stay (${now ? now.name : '?'} there)`)
  }
  setZone()
  if (planted) log('orchard', `planted ${planted} sapling${planted > 1 ? 's' : ''} (${orchard().spots.length} spots, ${grown(bot).length} grown)`)
  return planted
}

// Cut the grown trees (logs up to `logs`), leaves too while saplings are wanted, and replant each spot.
async function harvest (bot, { logs = Infinity, demandTrees = 0, shouldStop } = {}) {
  const trees = grown(bot)
  if (!trees.length) return 0
  const gather = require('./gather')
  const me = bot.entity.position
  trees.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))
  let got = 0
  for (const t of trees) {
    if (got >= logs || (shouldStop && shouldStop())) break
    await reflex.waitClear()
    const b = world.at(bot, t.x, t.y, t.z)
    if (!b || !world.LOG_RE.test(b.name)) continue
    const re = new RegExp('^' + b.name + '$')
    const before = inv.count(bot, n => world.LOG_RE.test(n))
    await gather.fellTree(bot, new Vec3(t.x, t.y, t.z), re, { leaves: wantSaplings(bot, demandTrees) > 0, allowZones: ['orchard'] })
    got += inv.count(bot, n => world.LOG_RE.test(n)) - before
  }
  if (got) {
    const cut = trees.filter(t => { const b = world.at(bot, t.x, t.y, t.z); return !b || !world.LOG_RE.test(b.name) }).length || 1
    // (logs a tree gives, learnt from our own trees: the demand is counted in trees)
    mem.update(m => { const o = m.orchard; o.cut = (o.cut || 0) + cut; o.logs = (o.logs || 0) + got; o.perTree = Math.max(1, o.logs / o.cut) })
    log('orchard', `harvested ${got} logs from ${cut} grown tree${cut > 1 ? 's' : ''}`)
  }
  await plant(bot, { demandTrees, shouldStop })
  return got
}

function info (bot) { const o = orchard(); return o ? { spots: o.spots.length, grown: grown(bot).length, empty: empty(bot).length } : null }

module.exports = { orchard, setZone, plant, harvest, grown, empty, wantSaplings, saplingCount, newSpots, spotOK, info, SAPLING_RE }
