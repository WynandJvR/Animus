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

const SAPLING_RE = /^(oak|spruce|birch|jungle|acacia|cherry)_sapling$/ // (the singles: dark oak needs four in a square, never alone)
// (any sapling, as a block standing in a spot or an item in the bank - dark oak's squares grow like spruce's: without it
//  a planted dark oak square read as a dead spot)
const ANY_SAP_RE = /^(oak|spruce|birch|jungle|acacia|cherry|dark_oak)_sapling$/
// THE SQUARES' SPECIES: four saplings of one in a 2x2 - dark oak (it grows no other way) before spruce (a single will do
// for it). A dark oak plot at home turns a 420-block walk each way into a few steps, renewable (audit 2026-09-29)
const QUAD_SAPS = ['dark_oak_sapling', 'spruce_sapling']
// THE SINGLES' SPECIES: never a square's. A spruce sapling in a square is a quarter of a 90-100 log tree that grows when
// the first of its four does; alone it is a 6-log tree (the orchard's own count: 6.4 a tree) at a quarter of the pace -
// the orchard put 45 spruce saplings in single spots, 2026-10-06
const SINGLE_SAP_RE = /^(oak|birch|jungle|acacia|cherry)_sapling$/
function quadSap (bot) { return QUAD_SAPS.find(n => inv.count(bot, n) >= 4) || null }
function quadCount (bot) { return Math.max(...QUAD_SAPS.map(n => inv.count(bot, n))) }
const SOIL_RE = /^(grass_block|dirt|podzol|coarse_dirt|rooted_dirt|moss_block)$/
const GROW_ROOM = 7 // air a sapling needs over it to grow (vanilla: the trunk plus the crown)
const SPACING = 3 // one trunk every third cell: the crowns touch, the trunks stay walkable between
// A MEGA SPRUCE: four spruce saplings in a 2x2 grow one tree of 30-60 logs against 6-10 for a single - the build's own
// wood, 700 logs short at 65 an hour from single trees (2026-09-28; audit). A quad spot is the square's low corner;
// quads on their own wider grid, with the crown and the height a mega tree takes.
const QUAD_SPACING = 6
const QUAD_ROOM = 14
const QUAD = [[0, 0], [1, 0], [0, 1], [1, 1]]
const cellsOf = s => s.quad ? QUAD.map(([dx, dz]) => ({ x: s.x + dx, y: s.y, z: s.z + dz })) : [s]

function orchard () { return mem.get().orchard || null }
// Nothing in the cell - a sapling included: it has no collision box, so "airish" took a planted spot for an empty one
// and the bot spent 15 minutes planting oak on top of birch saplings (2026-09-24)
function free (b) { return !!b && world.isAirish(b) && !ANY_SAP_RE.test(b.name) && !world.LOG_RE.test(b.name) }
// One small box per tree: its trunk cell and the ring round it, soil to crown (never one box round them all - spread
// round home, that box took in the base, the farm and the furnaces, 2026-09-24)
function boxOf (s) { return s.quad ? { x1: s.x - 2, x2: s.x + 3, z1: s.z - 2, z2: s.z + 3, y1: s.y - 1, y2: s.y + QUAD_ROOM + 2 } : { x1: s.x - 1, x2: s.x + 1, z1: s.z - 1, z2: s.z + 1, y1: s.y - 1, y2: s.y + GROW_ROOM + 2 } }
function setZone () { const o = orchard(); move.setZones('orchard', o ? o.spots.map(boxOf) : []) }

// A cell a sapling can go in and grow: soil under, air (or a sapling / our own trunk) in it, open sky and room above.
function spotOK (bot, p, room = GROW_ROOM) {
  if (p.quad) return cellsOf(p).every(c => spotOK(bot, c, QUAD_ROOM))
  const soil = world.at(bot, p.x, p.y - 1, p.z)
  if (!soil || !SOIL_RE.test(soil.name)) return false
  for (let dy = 0; dy <= room; dy++) {
    const b = world.at(bot, p.x, p.y + dy, p.z)
    if (!b) return false
    if (dy === 0 && (ANY_SAP_RE.test(b.name) || world.LOG_RE.test(b.name))) continue
    if (!world.isAirish(b) && !(dy > 0 && world.LEAF_RE.test(b.name))) return false
  }
  return world.openSky(bot, { x: p.x, y: p.y + room, z: p.z })
}

// New spots: the grid cells in rings out from home (16..48), nearest first, outside every protected zone and clear of
// the safehouse; `n` of them at most.
function newSpots (bot, n, { quad = false } = {}) {
  const home = mem.get().home
  if (!home || n <= 0) return []
  const have = (orchard() || { spots: [] }).spots
  const taken = new Set(have.map(s => `${s.x},${s.z}`))
  // (a quad keeps clear of every spot round it: its crown is wide)
  const near = c => have.some(s => { const r = s.quad || quad ? 5 : 1; return Math.abs(s.x - c.x) < r && Math.abs(s.z - c.z) < r })
  // the grid (every SPACING-th cell from home), 16..48 out, nearest first
  const step = quad ? QUAD_SPACING : SPACING
  const cells = []
  for (let dx = -48; dx <= 48; dx += step) for (let dz = -48; dz <= 48; dz += step) {
    const r = Math.max(Math.abs(dx), Math.abs(dz))
    if (r < 16) continue
    cells.push({ x: home.x + dx, z: home.z + dz, d: Math.hypot(dx, dz) })
  }
  cells.sort((a, b) => a.d - b.d)
  const out = []
  for (const c of cells) {
    if (out.length >= n) break
    if (taken.has(`${c.x},${c.z}`) || near(c)) continue
    const gy = world.groundY(bot, c.x, c.z, home.y + 12)
    if (gy == null || Math.abs(gy + 1 - home.y) > 8) continue // (a short walk from home, not down a cliff)
    const p = quad ? { x: c.x, y: gy + 1, z: c.z, quad: true } : { x: c.x, y: gy + 1, z: c.z }
    if (quad && QUAD.some(([dx, dz]) => world.groundY(bot, c.x + dx, c.z + dz, home.y + 12) !== gy)) continue // (a level square)
    // (clear of every other zone; the orchard's own trees are its grid neighbours, 3 apart - taken is the check there)
    if (move.inZone(p, 2, ['orchard']) || !spotOK(bot, p)) continue
    out.push(p)
  }
  return out
}

// THE TREE IN A SPOT: a single's log where the sapling was; a square's lowest upright trunk log anywhere in its four
// columns - a felling that stopped part way leaves our pillar in one column and the rest of the tree standing over it
// (66-75 logs in each of four squares read as no tree, never cut and never replanted, 2026-09-29..10-06). Upright only: a
// neighbour's branch log lies across.
// (from the ground only - within the first four levels, where a stand beside it or a climb walled by its own trunks starts:
//  a square whose logs all hang higher is no harvest - the climb to them is a 1-wide pillar through open air; audit)
const SQUARE_FOOT = 3
function trunkLog (bot, s) {
  if (!s.quad) { const b = world.at(bot, s.x, s.y, s.z); return b && world.LOG_RE.test(b.name) ? b : null }
  for (let dy = 0; dy <= SQUARE_FOOT; dy++) {
    for (const c of cellsOf(s)) {
      const b = world.at(bot, c.x, c.y + dy, c.z)
      if (!b || !world.LOG_RE.test(b.name)) continue
      let axis = 'y'; try { axis = b.getProperties().axis || 'y' } catch {}
      if (axis === 'y') return b
    }
  }
  return null
}
function grown (bot) {
  const o = orchard()
  if (!o) return []
  return o.spots.filter(s => !!trunkLog(bot, s))
}
// A spot to plant: every cell free - a square's cells free or holding its saplings already, one free at least (a square
// planted part way was never "empty" and its last saplings never went in)
function empty (bot) {
  const o = orchard()
  if (!o) return []
  return o.spots.filter(s => {
    const bs = cellsOf(s).map(c => world.at(bot, c.x, c.y, c.z))
    if (!bs.every(b => free(b) || (s.quad && b && ANY_SAP_RE.test(b.name))) || !bs.some(b => free(b))) return false
    return spotOK(bot, s)
  })
}
function saplings (bot) { return inv.items(bot).filter(i => SAPLING_RE.test(i.name)) }
function saplingCount (bot) { return saplings(bot).reduce((a, i) => a + i.count, 0) }
// The saplings to hand: `n(name)` - pack and, with the bank's counts, the chests; `singleN` the singles' species.
function sapCounts (bot, bank = null) {
  const n = name => inv.count(bot, name) + (bank ? (bank[name] || 0) : 0)
  const names = new Set(inv.items(bot).map(i => i.name).concat(bank ? Object.keys(bank) : []))
  let singleN = 0; for (const name of names) if (SINGLE_SAP_RE.test(name)) singleN += n(name)
  return { n, singleN }
}

// THE DEMAND, in each kind of spot: squares for the square species' logs (spruce, dark oak - a single gives none of the
// castle's spruce), singles for the class, the fuel and the single species'. Each counted by its OWN learnt yield: one
// number over both (6.4, singles mostly) asked for ~250 spots for 1000 spruce logs, and the planter filled them with oak
// and acacia (audit 2026-10-06).
const SQUARE_LOG_RE = /^(spruce|dark_oak)_log$/
const SINGLE_LOG_RE = /^(log|oak_log|birch_log|jungle_log|acacia_log|cherry_log)$/
// (a square's yield until our own squares have measured it: the three measured mega spruces held 83, 97 and 105 logs,
//  2026-09-29..10-02 - the low end)
const SQUARE_YIELD = 80
function yields () {
  const o = orchard() || {}
  return { square: o.quadCut ? Math.max(1, o.quadLogs / o.quadCut) : SQUARE_YIELD, single: o.singleCut ? Math.max(1, o.singleLogs / o.singleCut) : (o.perTree || 5) }
}
function demandFor (raw) {
  const y = yields()
  let sq = 0; let si = Math.ceil((raw.fuel || 0) * 8 / 7)
  for (const [r, n] of Object.entries(raw)) { if (SQUARE_LOG_RE.test(r)) sq += n; else if (SINGLE_LOG_RE.test(r)) si += n }
  return { squares: Math.ceil(sq / y.square), singles: Math.ceil(si / y.single) }
}
function spotCounts () { const sp = (orchard() || { spots: [] }).spots; const q = sp.filter(s => s.quad).length; return { squares: q, singles: sp.length - q } }
const NO_DEMAND = { squares: 0, singles: 0 }

// Saplings wanted - for the squares (in fours) or the singles, each to its own demand; `logName`: the tree being cut, whose
// leaves give its own species' saplings. The fell loop breaks leaves only while this is > 0.
function wantSaplings (bot, demand = NO_DEMAND, logName = null) {
  const c = spotCounts(); const e = empty(bot); const eq = e.filter(s => s.quad).length
  const wantQ = 4 * (Math.max(0, Math.min(demand.squares, 100) - c.squares) + eq) - quadCount(bot)
  const wantS = Math.max(0, Math.min(demand.singles, 400) - c.singles) + (e.length - eq) - sapCounts(bot).singleN
  if (logName) return Math.max(0, SQUARE_LOG_RE.test(logName) ? wantQ : wantS)
  return Math.max(0, wantQ) + Math.max(0, wantS)
}

// THE SQUARE'S SPECIES to fill it with, from `n(name)` saplings: the one its saplings already are (enough for its free
// cells), else one held four of; null - nothing to plant there. The trigger and the planter one rule: the trigger said yes
// on four spruce for a half-planted dark oak square, and the planter planted nothing (audit 2026-10-06).
function squareSpecies (bot, s, n) {
  const bs = cellsOf(s).map(c => world.at(bot, c.x, c.y, c.z))
  const have = bs.find(b => b && ANY_SAP_RE.test(b.name))
  const freeN = bs.filter(b => free(b)).length
  if (have) return n(have.name) >= freeN ? have.name : null
  return QUAD_SAPS.find(x => n(x) >= 4) || null
}
// SINGLES GO IN BY THE HANDFUL: four to hand, or once a day - a trickle of one sapling a tree called the planting rung over
// the build round after round (audit 2026-10-06)
const SINGLE_BATCH = 4
function singlesDue (bot, singleN) { return singleN >= SINGLE_BATCH || (orchard() || {}).singleDay !== require('./day').dayNo(bot) }

// Whether plant() would put a sapling in the ground with these saplings to hand (`sc`: sapCounts, the bank's included) -
// the director's trigger and the planter's plan one rule. A trigger on "any sapling, any empty spot" picked plant again and
// again for nothing (4 in a row, 2026-09-28).
function plantable (bot, sc, demand = NO_DEMAND) {
  const c = spotCounts(); const fill = empty(bot)
  const used = {}; const left = x => sc.n(x) - (used[x] || 0)
  for (const s of fill.filter(q => q.quad)) { const sp = squareSpecies(bot, s, left); if (sp) return true }
  if (c.squares < demand.squares && QUAD_SAPS.some(x => left(x) >= 4)) return true // (a fresh square)
  if (!singlesDue(bot, sc.singleN)) return false
  const fs = fill.length - fill.filter(q => q.quad).length
  if (fs > 0 && sc.singleN > 0) return true // (an empty single spot)
  return sc.singleN - fs > 0 && c.singles < demand.singles // (new single spots)
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
    const bs = cellsOf(s).map(c => world.at(bot, c.x, c.y, c.z))
    if (bs.some(b => !b)) continue // (unloaded: unknown, kept)
    if (bs.some(b => ANY_SAP_RE.test(b.name) || world.LOG_RE.test(b.name))) continue // (growing, or a trunk still there)
    if (s.quad && trunkLog(bot, s)) continue // (a square's tree standing over our pillar: the harvest's, not a dead spot)
    // (dead by what stands IN it, or the soil gone from under it - never by a crown over it: a felled tree's leaves rot in a
    //  minute and a neighbour's shade passes, and 4-8 spots were dropped for "no room" after each harvest, 72 -> 56 spots,
    //  2026-10-02..06. A spot shaded now waits: empty() plants it once spotOK holds)
    if (!spotOK(bot, s)) {
      const bad = bs.find(b => !free(b))
      const soil = cellsOf(s).map(c => world.at(bot, c.x, c.y - 1, c.z)).find(u => u && !SOIL_RE.test(u.name))
      if (bad || soil) dropSpot(s, bad ? `${bad.name} there now` : `${soil.name} under it now`)
    }
  }
}

async function plant (bot, { demand = NO_DEMAND, shouldStop } = {}) {
  let o = orchard()
  if (!o) { o = { spots: [] }; mem.set('orchard', o) }
  pruneDead(bot)
  const fill = empty(bot)
  const have = name => inv.count(bot, name)
  let planted = 0
  // one spot's saplings in: a square's all of `qs`, a single's one of the singles' species
  const fillSpot = async (s, qs) => {
    for (const c of cellsOf(s)) {
      const sap = s.quad ? inv.items(bot).find(i => i.name === qs) : inv.items(bot).find(i => SINGLE_SAP_RE.test(i.name))
      if (!sap) break
      const b = world.at(bot, c.x, c.y, c.z)
      if (!free(b)) continue
      if (!await act.place(bot, c, sap.name, { faceHint: [[0, -1, 0]], allowZones: ['orchard'] })) continue
      // it must stay there: a sapling that pops off at once came back as "planted" eleven times in 2s (2026-09-24)
      await new Promise(r => setTimeout(r, 300))
      const now = world.at(bot, c.x, c.y, c.z)
      if (now && ANY_SAP_RE.test(now.name)) planted++
      else { dropSpot(s, `the sapling did not stay (${now ? now.name : '?'} there)`); break }
    }
  }
  // THE SQUARES FIRST (a single spot planted first took the square's saplings, 2026-10-06): the empty ones, by the one rule
  // (squareSpecies), then fresh ones of what is left, up to the squares' demand
  for (const s of fill.filter(q => q.quad)) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const qs = squareSpecies(bot, s, have)
    if (qs) await fillSpot(s, qs)
  }
  const freshN = Math.max(0, Math.min(QUAD_SAPS.reduce((a, x) => a + Math.floor(have(x) / 4), 0), demand.squares - spotCounts().squares))
  const freshQuads = newSpots(bot, freshN, { quad: true })
  if (freshQuads.length) { mem.update(m => { m.orchard.spots = m.orchard.spots.concat(freshQuads) }); setZone() }
  for (const s of freshQuads) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const qs = squareSpecies(bot, s, have)
    if (qs) await fillSpot(s, qs)
  }
  // THE SINGLES: the singles' species only, by the handful (singlesDue)
  const singleN = sapCounts(bot).singleN
  if (singleN > 0 && singlesDue(bot, singleN) && !(shouldStop && shouldStop())) {
    const before = planted
    const fillS = fill.filter(q => !q.quad)
    const more = Math.max(0, Math.min(singleN - fillS.length, demand.singles - spotCounts().singles))
    const fresh = newSpots(bot, more)
    if (fresh.length) { mem.update(m => { m.orchard.spots = m.orchard.spots.concat(fresh) }); setZone() }
    for (const s of fillS.concat(fresh)) {
      if (shouldStop && shouldStop()) break
      await reflex.waitClear()
      await fillSpot(s, null)
    }
    if (planted > before) { const d = require('./day').dayNo(bot); mem.update(m => { m.orchard.singleDay = d }) }
  }
  setZone()
  if (planted) log('orchard', `planted ${planted} sapling${planted > 1 ? 's' : ''} (${orchard().spots.length} spots, ${grown(bot).length} grown; ${demand.squares} squares and ${demand.singles} singles wanted)`)
  return planted
}

// Cut the grown trees (logs up to `logs`), leaves too while saplings are wanted, and replant each spot.
// (`skip(logName)`: trees of a wood the caller must not cut - the build's own species on a trip for any wood or for fuel)
async function harvest (bot, { logs = Infinity, demand = NO_DEMAND, shouldStop, species = null, skip = null } = {}) {
  const trees = grown(bot)
  if (!trees.length) return 0
  // (a species' trip with none of its trees grown: back at once - the walk out to plant is the planting rung's, not a trip's)
  if (species && !trees.some(t => { const b = trunkLog(bot, t); return b && b.name === species })) return 0
  // (a species' trip counts only its own logs: pickups can take up other wood lying in the orchard)
  const cnt = () => species ? inv.count(bot, species) : inv.count(bot, n => world.LOG_RE.test(n))
  const gather = require('./gather')
  const me = bot.entity.position
  trees.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))
  let got = 0
  let axeFailed = false
  const per = { quad: { logs: 0, cut: 0 }, single: { logs: 0, cut: 0 } } // (each kind's yield learnt apart: yields)
  for (const t of trees) {
    if (got >= logs || (shouldStop && shouldStop())) break
    await reflex.waitClear()
    const b = trunkLog(bot, t)
    if (!b) continue
    if (species && b.name !== species) continue // (a species' trip: its own trees only - an exact-wood build)
    if (skip && skip(b.name)) continue
    const re = new RegExp('^' + b.name + '$')
    const before = cnt()
    if (!axeFailed && !await gather.keepAxe(bot, { shouldStop })) axeFailed = true // (gather.keepAxe: the chop's rule)
    // (a mega tree is four trunks, felled from inside - gather.fellMega; a single one as ever. The spot is replanted below,
    //  by the planter's rule - never the felling's: a spruce back in a single spot)
    const leaves = wantSaplings(bot, demand, b.name) > 0 // (its own species' saplings wanted)
    let stranded = false
    if (t.quad) stranded = (await gather.fellMega(bot, t, re, { allowZones: ['orchard'], shouldStop, leaves })).stranded
    else await gather.fellTree(bot, new Vec3(t.x, t.y, t.z), re, { leaves, allowZones: ['orchard'], replant: false })
    const k = per[t.quad ? 'quad' : 'single']; const g = cnt() - before
    got += g; k.logs += g; if (!trunkLog(bot, t)) k.cut++
    // (left up a tree with no way down: no walk on to the next tree from up there - the reflexes' escape owns the body now)
    if (stranded) { log('orchard', `the harvest stops - stranded up the square at ${move.fmt(t)}`); return got }
  }
  if (got) {
    const cut = per.quad.cut + per.single.cut || 1
    // (logs a tree gives, learnt from our own trees, each kind apart - the demand is counted in squares and singles)
    mem.update(m => {
      const o = m.orchard; o.cut = (o.cut || 0) + cut; o.logs = (o.logs || 0) + got; o.perTree = Math.max(1, o.logs / o.cut)
      o.quadLogs = (o.quadLogs || 0) + per.quad.logs; o.quadCut = (o.quadCut || 0) + per.quad.cut
      o.singleLogs = (o.singleLogs || 0) + per.single.logs; o.singleCut = (o.singleCut || 0) + per.single.cut
    })
    log('orchard', `harvested ${got} logs from ${cut} grown tree${cut > 1 ? 's' : ''} (squares ${per.quad.logs} logs/${per.quad.cut} cut, singles ${per.single.logs}/${per.single.cut})`)
  }
  await plant(bot, { demand, shouldStop })
  return got
}

// THE ORCHARD'S COMING WOOD of a species: its growing spots (a sapling of that species standing) at their own learnt yield -
// a square's, a single's. What a wild trip for the same logs would race (director's feasible)
function expectedLogs (bot, logName) {
  const sap = logName.replace(/_log$/, '_sapling'); const y = yields(); const o = orchard()
  if (!o) return 0
  let n = 0
  for (const s of o.spots) { const b = world.at(bot, s.x, s.y, s.z); if (b && b.name === sap && !trunkLog(bot, s)) n += s.quad ? y.square : y.single }
  return Math.round(n)
}
function info (bot) { const o = orchard(); return o ? { spots: o.spots.length, grown: grown(bot).length, empty: empty(bot).length } : null }

module.exports = { ANY_SAP_RE, SINGLE_SAP_RE, sapCounts, trunkLog, demandFor, yields, expectedLogs, squareSpecies, quadSap, plantable, orchard, setZone, plant, harvest, grown, empty, wantSaplings, saplingCount, newSpots, spotOK, info, SAPLING_RE }
