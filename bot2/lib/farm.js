'use strict'
// A wheat farm at home: renewable bread that does not depend on animals. Needs natural water near
// home (farmland within 4 blocks of water stays hydrated). Seeds come from breaking grass.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const craft = () => require('./craft')

const PLOT_TARGET = 24
const OWN = ['farm'] // (the farm's own zone is its own ground: other zones still keep it out)

function farm () { return mem.get().farm || null }
// Is the saved farm next to the current home? (a move leaves the old plot behind)
function farmIsHome (bot) {
  const f = farm(); const home = mem.get().home
  if (!f || !home || !f.cells.length) return false
  if (world.dist2(f.cells[0], home) >= 40) return false
  // a plot sited before the safehouse moved can run through its walls: that plot is void
  return !f.cells.some(c => nearHut(c))
}
// Within 2 blocks of the safehouse walls (a crop there is dug up by the hut, or tramples its door).
function nearHut (p) {
  const hp = mem.get().hutPlan
  if (!hp || !hp.interior) return false
  const i = hp.interior
  return p.x >= i.x1 - 3 && p.x <= i.x2 + 3 && p.z >= i.z1 - 3 && p.z <= i.z2 + 3 && Math.abs(p.y - hp.home.y) <= 5
}
const farmHome = true

// Tillable cells: grass/dirt with air above, water within 4 horizontally at the same level or one
// below, outside protected zones, near home.
function findPlot (bot) {
  const home = mem.get().home
  if (!home) return null
  const waters = world.findBlocks(bot, /^water$/, { maxDistance: 64, count: 80, point: new Vec3(home.x, home.y, home.z) })
    .filter(w => Math.abs(w.position.y - home.y) <= 4 && world.openSky(bot, w.position))
  let best = null
  for (const w of waters) {
    const cells = []
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const p = { x: w.position.x + dx, y: w.position.y, z: w.position.z + dz }
      const b = world.at(bot, p.x, p.y, p.z); const up = world.at(bot, p.x, p.y + 1, p.z)
      if (!b || !up || !/^(grass_block|dirt)$/.test(b.name) || !world.isAirish(up)) continue
      if (move.inZone(p, 1, OWN) || nearHut(p) || !move.utilitySpotOK({ x: p.x, y: p.y + 1, z: p.z }, { except: OWN })) continue
      cells.push(p)
    }
    if (cells.length >= 8 && (!best || cells.length > best.cells.length || (cells.length === best.cells.length && world.dist2(w.position, home) < world.dist2(best.water, home)))) best = { water: w.position, cells }
  }
  if (!best) return dryPlot(bot, home)
  best.cells.sort((a, b) => world.dist2(a, best.water) - world.dist2(b, best.water))
  return { water: { x: best.water.x, y: best.water.y, z: best.water.z }, cells: best.cells.slice(0, PLOT_TARGET) }
}

// No water near home: crops still grow on dry farmland (slower), and planted farmland stays put.
// A flat grass patch 6-16 blocks from home, outside the protected zones.
function dryPlot (bot, home) {
  let best = null
  for (let r = 6; r <= 16; r += 2) {
    for (let a = 0; a < 16; a++) {
      const cx = Math.round(home.x + Math.cos(a * Math.PI / 8) * r); const cz = Math.round(home.z + Math.sin(a * Math.PI / 8) * r)
      const cells = []
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const x = cx + dx; const z = cz + dz
        const gy = world.groundY(bot, x, z, home.y + 6)
        if (gy == null || Math.abs(gy - (home.y - 1)) > 2) continue
        const b = world.at(bot, x, gy, z); const up = world.at(bot, x, gy + 1, z)
        if (!b || !up || !/^(grass_block|dirt)$/.test(b.name) || !world.isAirish(up)) continue
        const p = { x, y: gy, z }
        if (move.inZone(p, 1, OWN) || nearHut(p) || !move.utilitySpotOK({ x, y: gy + 1, z }, { except: OWN })) continue
        cells.push(p)
      }
      if (cells.length >= 16 && (!best || cells.length > best.cells.length)) best = { water: null, cells }
    }
    if (best) break
  }
  if (best) log('farm', `no water near home - a dry plot of ${best.cells.length} cells (crops grow slower without water)`)
  return best
}

async function getSeeds (bot, n, ctx = {}) {
  const t0 = Date.now()
  while (inv.count(bot, 'wheat_seeds') < n && Date.now() - t0 < 60000) {
    if (ctx.shouldStop && ctx.shouldStop()) return false
    await reflex.waitClear()
    const grass = world.findBlocks(bot, /^(short_grass|tall_grass|fern|large_fern)$/, { maxDistance: 64, count: 10, filter: b => !move.inZone(b.position) })
    if (!grass.length) { log('farm', 'no grass around for seeds'); return inv.count(bot, 'wheat_seeds') > 0 }
    for (const g of grass.slice(0, 8)) {
      await act.dig(bot, g.position, { timeoutMs: 6000 })
      if (inv.count(bot, 'wheat_seeds') >= n) break
    }
    await act.collectDrops(bot, { radius: 8, maxMs: 5000 })
    await move.sleep(100) // always yield to the event loop between rounds
  }
  return inv.count(bot, 'wheat_seeds') > 0
}

async function useOn (bot, pos, itemName) {
  const item = inv.items(bot).find(i => i.name === itemName || i.name.endsWith(itemName))
  if (!item) return false
  const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
  if (!b) return false
  if (!act.reach(bot, pos, 4)) {
    const r = await move.goTo(bot, new goals.GoalNear(pos.x, pos.y + 1, pos.z, 2), { timeoutMs: 20000, label: 'farm cell', dig: false })
    if (!r.ok) return false
  }
  try {
    await bot.equip(item, 'hand')
    await bot.lookAt(new Vec3(pos.x + 0.5, pos.y + 1, pos.z + 0.5), true)
    await bot.activateBlock(b, new Vec3(0, 1, 0))
  } catch { return false }
  await move.sleep(250)
  return true
}

// A water block hydrates farmland within 4 blocks (at its level or one below): the full 9x9 around it is
// 80 cells, four times the bread of the 5x5 the dry plot started as.
function fullPlot (bot, f) {
  if (!f || !f.water) return f ? f.cells : []
  const w = f.water
  const out = []
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    if (dx === 0 && dz === 0) continue
    for (const y of [w.y]) {
      const p = { x: w.x + dx, y, z: w.z + dz }
      const b = world.at(bot, p.x, p.y, p.z); const up = world.at(bot, p.x, p.y + 1, p.z)
      if (!b || !up) continue
      if (!/^(grass_block|dirt|farmland)$/.test(b.name)) continue
      if (!(world.isAirish(up) || up.name === 'wheat') || /torch/.test(up.name)) continue
      if (move.inZone(p, 1, OWN) || nearHut(p)) continue
      if (up.name !== 'wheat' && !move.utilitySpotOK({ x: p.x, y: p.y + 1, z: p.z }, { except: OWN })) continue
      out.push(p)
      break
    }
  }
  return out
}
function widen (bot) {
  const f = farm()
  if (!f || !f.water) return false
  const cells = fullPlot(bot, f)
  const key = c => `${c.x},${c.z}`
  const have = new Set(f.cells.map(key))
  const added = cells.filter(c => !have.has(key(c)))
  if (!added.length) return false
  f.cells = f.cells.concat(added)
  mem.set('farm', f)
  log('farm', `widened the farm to ${f.cells.length} cells around the water`)
  return true
}

// Set up (or extend) the plot: till and plant. Returns true when crops are in the ground.
async function establish (bot, ctx = {}) {
  let f = farm()
  if (f && !farmIsHome(bot)) { log('farm', 'the old farm plot is far from home - siting a new one'); mem.set('farm', null); f = null }
  // a cell whose soil is gone (dug for dirt) or buried is no field any more: drop it; too few left, site a new plot
  // (a remembered plot of holes and buried cells planted "0 just now" for an hour, 2026-09-23)
  if (f) {
    const live = f.cells.filter(c => { const b = world.at(bot, c.x, c.y, c.z); const up = world.at(bot, c.x, c.y + 1, c.z); return !b || !up || (/^(grass_block|dirt|farmland)$/.test(b.name) && (world.isAirish(up) || /^(wheat|carrots|potatoes|beetroots)$/.test(up.name))) })
    if (live.length < f.cells.length) { log('farm', `${f.cells.length - live.length} farm cells lost their soil - dropped`); f.cells = live; mem.set('farm', f) }
    if (live.length < 8) { log('farm', 'too little of the field left - siting a new one'); mem.set('farm', null); f = null }
  }
  if (!f) {
    const plot = findPlot(bot)
    if (!plot) { log('farm', 'no water with tillable ground near home - no farm here yet'); return false }
    f = { water: plot.water, cells: plot.cells, plantedAt: 0 }
    mem.set('farm', f)
    log('farm', `farm plot of ${plot.cells.length} cells ${plot.water ? 'beside water at ' + move.fmt(plot.water) : 'on dry ground at ' + move.fmt(plot.cells[0])}`)
  }
  if (f.water && f.cells.length < 60 && farmLevel(bot)) widen(bot)
  if (!inv.bestTool(bot, 'hoe', 1)) { if (!await craft().ensure(bot, 'wooden_hoe', inv.count(bot, 'wooden_hoe') + 1, ctx)) return false }
  // start small: 8 seeds get the farm going and every harvest returns more seeds than it used
  const wantSeeds = Math.min(64, Math.max(8, unplantedCount(bot)))
  if (inv.count(bot, 'wheat_seeds') < wantSeeds) await require('./base').withdraw(bot, 'wheat_seeds', wantSeeds - inv.count(bot, 'wheat_seeds')).catch(() => 0)
  if (inv.count(bot, 'wheat_seeds') < 8) await getSeeds(bot, 8, ctx)
  let planted = 0; let newly = 0
  for (const c of f.cells) {
    if (ctx.shouldStop && ctx.shouldStop()) break
    await reflex.waitClear()
    const b = world.at(bot, c.x, c.y, c.z); const up = world.at(bot, c.x, c.y + 1, c.z)
    if (!b || !up) continue
    if (up.name === 'wheat') { planted++; continue }
    if (world.isWaterBlock(up)) continue // water over the cell washes seeds straight off
    // a hoe tills only under open AIR: leaf litter, grass or a flower on the cell has an empty hitbox (so it reads as
    // "airish") but blocks the tilling - 16 of 20 cells under leaf litter stayed grass for an hour (2026-09-23)
    if (/^(grass_block|dirt)$/.test(b.name) && up.name !== 'air' && world.isAirish(up)) {
      await require('./act').dig(bot, up.position, { timeoutMs: 5000, allowZones: ['farm'] }).catch(() => false)
    }
    if (/^(grass_block|dirt)$/.test(b.name) && world.isAirish(up)) {
      // a wooden hoe tills ~60 cells: a big plot wears one out part way
      if (!inv.items(bot).some(i => /_hoe$/.test(i.name))) await craft().ensure(bot, 'wooden_hoe', 1, ctx).catch(() => false)
      await useOn(bot, c, '_hoe')
    }
    const b2 = world.at(bot, c.x, c.y, c.z)
    if (b2 && b2.name === 'farmland' && inv.has(bot, 'wheat_seeds')) {
      await useOn(bot, c, 'wheat_seeds')
      const now = world.at(bot, c.x, c.y + 1, c.z)
      if (now && now.name === 'wheat') { planted++; newly++ } // counted only if the crop is really there
    }
  }
  f.plantedAt = f.plantedAt || Date.now()
  mem.set('farm', f)
  log('farm', `${planted}/${f.cells.length} cells planted (${newly} just now)`)
  return newly > 0
}

// A dry plot grows wheat several times slower than hydrated farmland, and the bot starves waiting.
// One water block in the middle of the plot hydrates every cell within 4: fill a bucket at the
// nearest still water and pour it into the plot's centre cell.
function canHydrate (bot) {
  const f = farm()
  if (!f || f.water || !f.cells.length) return false
  const b = require('./base')
  const iron = inv.count(bot, 'iron_ingot') + b.bankCount('iron_ingot')
  // (iron still sitting in a furnace's output is collected by hydrate itself; it needs the ingots known)
  return inv.has(bot, 'water_bucket') || inv.has(bot, 'bucket') || b.bankCount('bucket') > 0 || iron >= 3
}
async function hydrate (bot, ctx = {}) {
  const f = farm()
  if (!f || f.water) return false
  const base = require('./base')
  if (!inv.has(bot, 'water_bucket')) {
    if (!inv.has(bot, 'bucket')) {
      await require('./smelt').collectFurnaces(bot).catch(() => 0)
      if (base.bankCount('bucket') > 0) await base.withdraw(bot, 'bucket', 1).catch(() => 0)
      if (!inv.has(bot, 'bucket') && inv.count(bot, 'iron_ingot') + base.bankCount('iron_ingot') >= 3) await craft().ensure(bot, 'bucket', 1, ctx)
      if (!inv.has(bot, 'bucket')) { log('farm', 'no bucket for watering the farm (needs 3 iron)'); return false }
    }
    // still water: a source block (level 0) that is not in a zone
    const home = mem.get().home
    const srcs = (await world.scanBlocks(bot, /^water$/, { maxDistance: 96, count: 40, point: home ? new Vec3(home.x, home.y, home.z) : undefined, filter: b => { try { return Number(b.getProperties().level) === 0 && !move.inZone(b.position) } catch { return false } } }))
      .filter(b => { const up = world.at(bot, b.position.x, b.position.y + 1, b.position.z); return up && world.isAirish(up) })
    // fill it from dry land at the edge - never by wading in (that pond has drowned the bot once)
    let src = null; let land = null
    for (const w of srcs) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [1, 0]) {
          const x = w.position.x + dx; const y = w.position.y + dy; const z = w.position.z + dz
          if (world.standable(bot, x, y, z) && !world.isWaterBlock(world.at(bot, x, y - 1, z))) { src = w; land = { x, y, z }; break }
        }
        if (src) break
      }
      if (src) break
    }
    if (!src) { log('farm', 'no still water with dry ground beside it to fill a bucket from'); return false }
    const r = await move.travel(bot, land, { range: 1, shouldStop: ctx.shouldStop, label: 'to water edge' })
    if (!r.ok && world.dist3(bot.entity.position, land) > 1.5) return false
    try {
      await bot.equip(inv.items(bot).find(i => i.name === 'bucket'), 'hand')
      await bot.lookAt(new Vec3(src.position.x + 0.5, src.position.y + 0.8, src.position.z + 0.5), true)
      bot.activateItem()
      await move.sleep(600)
      bot.deactivateItem()
    } catch (e) { log('farm', 'filling the bucket failed: ' + e.message) }
    if (!inv.has(bot, 'water_bucket')) { log('farm', 'the bucket did not fill'); return false }
  }
  // the plot's middle cell
  const cx = f.cells.reduce((s, c) => s + c.x, 0) / f.cells.length; const cz = f.cells.reduce((s, c) => s + c.z, 0) / f.cells.length
  const mid = f.cells.slice().sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0]
  const r2 = await move.travel(bot, { x: mid.x, y: mid.y + 1, z: mid.z }, { range: 3, shouldStop: ctx.shouldStop, label: 'to the farm' })
  if (!r2.ok && world.dist3(bot.entity.position, mid) > 5) return false
  // take out the crop and the soil at the middle cell, pour the water into the hole
  const crop = world.at(bot, mid.x, mid.y + 1, mid.z)
  if (crop && !world.isAirish(crop) && !world.isWaterBlock(crop)) await act.dig(bot, { x: mid.x, y: mid.y + 1, z: mid.z }, { force: true, timeoutMs: 6000 })
  const soil = world.at(bot, mid.x, mid.y, mid.z)
  if (soil && !world.isAirish(soil) && !world.isWaterBlock(soil)) await act.dig(bot, mid, { force: true, timeoutMs: 8000 })
  const hole = world.at(bot, mid.x, mid.y, mid.z)
  if (!hole || !(world.isAirish(hole) || world.isWaterBlock(hole))) { log('farm', 'could not open the middle of the plot for water'); return false }
  if (!await pourInto(bot, mid, f)) { log('farm', 'the water would not sit in the middle of the plot'); return false }
  f.water = { x: mid.x, y: mid.y, z: mid.z }
  f.cells = f.cells.filter(c => !(c.x === mid.x && c.z === mid.z))
  mem.set('farm', f)
  log('farm', `watered the farm: a water block at ${move.fmt(mid)} hydrates the plot`)
  return true
}

function isSource (b) { try { return !!b && b.name === 'water' && Number(b.getProperties().level) === 0 } catch { return false } }
// Water sources standing on the crop layer (a pour that hits the wrong face floods the wheat, and every
// seed planted there washes off - 27 seeds went that way).
function straySources (bot, f) {
  if (!f || !f.cells.length) return []
  const xs = f.cells.map(c => c.x); const zs = f.cells.map(c => c.z)
  // the soil level is the hole's level (one low cell made the lowest-cell rule call the hole's own
  // source "stray", and the fix scooped the farm dry)
  const y = f.water ? f.water.y : Math.min(...f.cells.map(c => c.y))
  const out = []
  for (let x = Math.min(...xs) - 2; x <= Math.max(...xs) + 2; x++) for (let z = Math.min(...zs) - 2; z <= Math.max(...zs) + 2; z++) for (let dy = 1; dy <= 3; dy++) {
    if (f.water && x === f.water.x && z === f.water.z && y + dy === f.water.y) continue
    const b = world.at(bot, x, y + dy, z)
    if (isSource(b)) out.push({ x, y: y + dy, z })
  }
  return out
}
async function useBucketAt (bot, itemName, point, standNear) {
  const it = inv.items(bot).find(i => i.name === itemName)
  if (!it) return false
  if (standNear && world.dist3(bot.entity.position, standNear) > 3.5) await move.goTo(bot, new goals.GoalNear(standNear.x, standNear.y, standNear.z, 2), { timeoutMs: 15000, label: 'to the water', dig: false })
  try {
    await bot.equip(it, 'hand')
    await bot.lookAt(new Vec3(point.x, point.y, point.z), true)
    bot.activateItem()
    await move.sleep(500)
    bot.deactivateItem()
  } catch (e) { log('farm', `bucket use failed: ${e.message}`); return false }
  await move.sleep(300)
  return true
}
async function scoopStrays (bot, f) {
  let n = 0
  for (const p of straySources(bot, f)) {
    if (!inv.has(bot, 'bucket')) break
    await useBucketAt(bot, 'bucket', { x: p.x + 0.5, y: p.y + 0.4, z: p.z + 0.5 }, p)
    if (!isSource(world.at(bot, p.x, p.y, p.z))) n++
  }
  if (n) log('farm', `scooped ${n} stray water source${n > 1 ? 's' : ''} off the crops`)
  return n
}
// Pour the bucket into `cell` (an open hole at soil level) from a cell right beside it, looking into the
// hole, and check a SOURCE sits there (falling water counted as success before).
async function pourInto (bot, cell, f) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isSource(world.at(bot, cell.x, cell.y, cell.z))) return true
    if (!inv.has(bot, 'water_bucket')) {
      // an empty bucket: take a stray source back first, that is our water
      if (inv.has(bot, 'bucket') && straySources(bot, f).length) await scoopStrays(bot, f)
      if (!inv.has(bot, 'water_bucket')) return false
    }
    const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: cell.x + dx, y: cell.y + 1, z: cell.z + dz }))
      .find(p => world.standable(bot, p.x, p.y, p.z))
    if (beside) await move.goTo(bot, new goals.GoalBlock(beside.x, beside.y, beside.z), { timeoutMs: 15000, label: 'beside the hole', dig: false })
    await useBucketAt(bot, 'water_bucket', { x: cell.x + 0.5, y: cell.y + 0.02, z: cell.z + 0.5 })
    if (isSource(world.at(bot, cell.x, cell.y, cell.z))) { if (straySources(bot, f).length && inv.has(bot, 'bucket')) await scoopStrays(bot, f); return true }
    if (inv.has(bot, 'bucket')) await scoopStrays(bot, f)
  }
  return isSource(world.at(bot, cell.x, cell.y, cell.z))
}
// A watered farm whose water went wrong (a stray source on the crops, or the hole's source gone).
function waterNeedsFixing (bot) {
  const f = farm()
  if (!f || !f.water) return false
  const w = world.at(bot, f.water.x, f.water.y, f.water.z)
  if (!w) return false
  return !isSource(w) || straySources(bot, f).length > 0
}
async function fixWater (bot, ctx = {}) {
  const f = farm()
  if (!f || !f.water) return false
  const b = require('./base')
  // (a full bucket put away by a deposit is the farm's water - fetch either kind)
  if (!inv.has(bot, 'bucket') && !inv.has(bot, 'water_bucket') && b.bankCount('water_bucket') > 0) await b.withdraw(bot, 'water_bucket', 1).catch(() => 0)
  if (!inv.has(bot, 'bucket') && !inv.has(bot, 'water_bucket') && b.bankCount('bucket') > 0) await b.withdraw(bot, 'bucket', 1).catch(() => 0)
  if (!inv.has(bot, 'bucket') && !inv.has(bot, 'water_bucket')) return false
  await scoopStrays(bot, f)
  if (!inv.has(bot, 'water_bucket')) {
    // nothing to put back: the water is gone - fill up again the way hydrate does
    // (the hole goes back into the plot so hydrate picks the same middle cell, not a fresh hole beside it)
    const was = f.water; f.water = null
    if (!f.cells.some(c => c.x === was.x && c.z === was.z)) f.cells.push({ x: was.x, y: was.y, z: was.z })
    mem.set('farm', f)
    const ok2 = await hydrate(bot, ctx)
    if (!ok2) { f.water = was; mem.set('farm', f) }
    return ok2
  }
  const ok = await pourInto(bot, f.water, f)
  log('farm', ok ? 'the farm water is back in its hole' : 'could not set the farm water right')
  return ok
}

// A farm you can walk: every soil cell at the water's level, nothing standing on the crop layer but crops,
// and a flat walkway ring round the plot. (The first plot mixed two soil levels and collected stray scaffold,
// a log and flowers - the operator asked for it clean and flat.)
// The ground a watered farm owns: every cell its water hydrates (vanilla: 4 blocks round the source), from the soil
// layer up through the crops. The zone the rest of the bot keeps out of (director.baseZone) - null for a dry plot.
const HYDRATE = 4
function area (f) {
  if (!f || !f.water) return null
  const w = f.water
  return { x1: w.x - HYDRATE, z1: w.z - HYDRATE, x2: w.x + HYDRATE, z2: w.z + HYDRATE, y1: w.y - 1, y2: w.y + 2 }
}
// The columns levelling works on: the farm's ground only - a plot cell, farmland, or a hole at the soil level (a
// dropped cell to win back). Not the natural rise round it: levelled flat to the water, the terrace up to the
// safehouse (2 higher) became a cliff, every walk home stood a dirt step on it and every levelling took it away again
// (10, 5, 2, 1, 2, 1 fixes in two minutes, round and round - 2026-09-24).
function farmArea (f, bot) {
  const w = f.water
  const cells = new Set((f.cells || []).map(c => `${c.x},${c.z}`))
  const farmGround = (x, z) => {
    if (cells.has(`${x},${z}`)) return true
    if (!bot) return false
    const g = world.at(bot, x, w.y, z)
    return !!g && (g.name === 'farmland' || (!world.isSolid(g) && !world.isWaterBlock(g)))
  }
  return {
    x1: w.x - 5, z1: w.z - 5, x2: w.x + 5, z2: w.z + 5, groundY: w.y, height: 2,
    keep: b => /^(wheat|torch|wall_torch)$/.test(b.name) || (b.position.x === w.x && b.position.z === w.z),
    skip: (x, z) => (x === w.x && z === w.z) || nearHut({ x, y: w.y, z }) || !!move.inZone({ x, y: w.y, z }, 1, OWN) || !farmGround(x, z)
  }
}
function levelWork (bot) {
  const f = farm()
  if (!f || !f.water) return []
  return require('./ground').work(bot, farmArea(f, bot))
}
function farmLevel (bot) { return levelWork(bot).length === 0 }
async function level (bot, ctx = {}) {
  const f = farm()
  if (!f || !f.water) return false
  const done = await require('./ground').prepare(bot, farmArea(f, bot), { shouldStop: ctx.shouldStop, label: 'levelling the farm' })
  // one level now: rebuild the cell list from it
  f.cells = fullPlot(bot, f)
  mem.set('farm', f)
  log('farm', `farm levelled - ${f.cells.length} cells at y${f.water.y}`)
  return done > 0
}

// Cells of the plot with no crop on them (loaded cells only).
function unplantedCount (bot) {
  const f = farm()
  if (!f) return 0
  let n = 0
  for (const c of f.cells) {
    const up = world.at(bot, c.x, c.y + 1, c.z)
    if (up && up.name !== 'wheat') n++
  }
  return n
}

function ripeCount (bot) {
  const f = farm()
  if (!f) return 0
  let n = 0
  for (const c of f.cells) {
    const w = world.at(bot, c.x, c.y + 1, c.z)
    try { if (w && w.name === 'wheat' && w.getProperties().age >= 7) n++ } catch {}
  }
  return n
}

async function harvest (bot, ctx = {}) {
  const f = farm()
  if (!f) return false
  let got = 0
  const isRipe = c => { const w = world.at(bot, c.x, c.y + 1, c.z); try { return !!w && w.name === 'wheat' && Number(w.getProperties().age) >= 7 } catch { return false } }
  // everything in reach first, then a short walk to the nearest ripe cell - walking to each crop in list
  // order cost 12-20 seconds a plant
  const skip = new Set() // cells we could not get to this round (the farm itself is not changed)
  for (let guard = 0; guard < 200; guard++) {
    if (ctx.shouldStop && ctx.shouldStop()) break
    await reflex.waitClear()
    const ripe = f.cells.filter(c => !skip.has(c) && isRipe(c))
    if (!ripe.length) break
    const inReach = ripe.filter(c => act.reach(bot, { x: c.x, y: c.y + 1, z: c.z }, 4.3))
    if (!inReach.length) {
      const me = bot.entity.position
      const next = ripe.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))[0]
      const r = await move.goTo(bot, new goals.GoalNear(next.x, next.y + 1, next.z, 2), { timeoutMs: 15000, label: 'to the crops', dig: false })
      if (!r.ok && !act.reach(bot, { x: next.x, y: next.y + 1, z: next.z }, 4.8)) skip.add(next)
      continue
    }
    for (const c of inReach) {
      if (await act.dig(bot, { x: c.x, y: c.y + 1, z: c.z }, { timeoutMs: 4000, force: true, noWalk: true })) got++
      const soil = world.at(bot, c.x, c.y, c.z)
      if (soil && soil.name === 'farmland' && inv.has(bot, 'wheat_seeds')) {
        try { await bot.equip(inv.items(bot).find(i => i.name === 'wheat_seeds'), 'hand'); await bot.activateBlock(soil, new Vec3(0, 1, 0)) } catch {}
      }
    }
    await act.collectDrops(bot, { radius: 4, maxMs: 1500 })
  }
  await act.collectDrops(bot, { radius: 8, maxMs: 6000 })
  const bread = Math.floor(inv.count(bot, 'wheat') / 3)
  if (bread > 0) await craft().ensure(bot, 'bread', inv.count(bot, 'bread') + bread, { noWithdraw: true })
  log('farm', `harvested ${got} wheat plants -> bread ${inv.count(bot, 'bread')}`)
  return got > 0
}

module.exports = { area, farm, farmIsHome, farmHome, establish, harvest, ripeCount, unplantedCount, findPlot, canHydrate, hydrate, waterNeedsFixing, fixWater, widen, fullPlot, farmLevel, level, levelWork }
