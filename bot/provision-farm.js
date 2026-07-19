'use strict'
// FARMING: the wheat plot and the orchard - siting them, levelling them, tilling, seeding,
// torching, harvesting, replanting, and growing trees back. Split out of provision.js
// unchanged.
//
// This is the renewable-food half of the survival loop. The bot starved on a no-animal,
// water-rich site before a standing farm was a first-class goal, which is why so much of
// this file is about ESTABLISHING a plot (flat site, y-exclusion, flood check) rather than
// just working one.
//
// farm.js holds the PURE plot geometry and crop maturity rules; this is the executor over
// it. provision-core.js supplies the shared primitives.
//
// Calls that go UP into the provisioning layer (runGather, runCraft, detectWood,
// ensureTorches, walkStaged, resolveBankCell) resolve through a lazy require of
// provision.js at CALL time - the pattern used by provision-hut.js and, before that, by
// provision.js reaching commands.js. shelterFarmConflict deliberately STAYED in
// provision.js: it reads the shelter site, so it is the shelter/farm bridge, not farm.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const farm = require('./farm.js')             // PURE plot geometry + crop maturity
const scaffold = require('./scaffold.js')     // temp-block registry + teardown
const navigate = require('./navigate.js')
const provCore = require('./provision-core.js')
const { AIRISH, REPLACEABLE, canBreakNaturally, countItem, inventoryCounts, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt, nearHostile, isNight } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, saveWorldMem, listInfra, rememberInfra, forgetInfra, recallInfra,
  rememberSpot, clearSearched } = worldMemory
const provHut = require('./provision-hut.js')
const { hutAnchor, insideOwnStructure, hasSolidCeiling } = provHut

// The provisioning layer, resolved at CALL time (see the note above).
const P = () => require('./provision.js')
const S = () => require('./provision.js').__siblings // refactor fix: reach __siblings-bridge fns (walkStaged, resolveBankCell, ensureTorches)

let dbgSink = null // forwarded from provision.js's setDebugSink
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const PLANTABLE_GROUND = /^(grass_block|dirt|podzol|coarse_dirt|rooted_dirt|mud|moss_block)$/

const WHEAT_FARM_TARGET = Number(process.env.WHEAT_FARM_TARGET || (process.env.FARM_EXPAND !== '0' ? 33 : 20)) // §4.8: 33 (~11 bread/cycle, breaks the food death-spiral) when FARM_EXPAND on; 20 off. >=20 crop cells: 12 barely covered 0->full (10 wheat ~3 bread ~15 hunger); 20 -> ~6 bread -> 0->full + surplus/buffer (was 12/6)

function farmFootprintHas (pos) {
  if (!pos || process.env.FARM_EXCLUDE_YFIX === '0') return false
  try {
    const wf = loadWorldMem().wheatFarm
    const cells = wf && wf.cells
    if (!cells || !cells.length) return false
    return farm.footprintHasCell(cells, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
  } catch { return false }
}

function cropExclusionStep (bot) {
  if (process.env.FARM_NO_TRAMPLE === '0') return null
  let cells = null
  try { const wf = loadWorldMem().wheatFarm; cells = (wf && wf.cells) || null } catch { return null }
  if (!cells || !cells.length) return null
  // #56 FARM_EXCLUDE_YFIX: the old single-`cy` window (|p.y-cy|<=1 for the FIRST cell's y) only
  // protected ONE level, so multi-level cells (rough pond edges) were free to bridge over. Build a
  // per-(x,z) -> set-of-y (each cell's farmland y-1, crop y, block-above y+1) so EVERY crop cell is
  // protected at its OWN level. YFIX=0 restores the single-cy behavior byte-for-byte.
  const YFIX = process.env.FARM_EXCLUDE_YFIX !== '0'
  const cols = new Set()
  const colY = YFIX ? new Map() : null
  let cy = null
  for (const c of cells) {
    cols.add(c.x + ',' + c.z)
    if (cy == null) cy = c.y
    if (YFIX) { const k = c.x + ',' + c.z; let s = colY.get(k); if (!s) { s = new Set(); colY.set(k, s) } s.add(c.y - 1); s.add(c.y); s.add(c.y + 1) }
  }
  const COST = Number(process.env.MAINT_CROP_STEP_COST || 50)
  return (block) => {
    const p = block && block.position
    if (!p) return 0
    if (YFIX) { const s = colY.get(p.x + ',' + p.z); return (s && s.has(p.y)) ? COST : 0 }
    if (cy != null && Math.abs(p.y - cy) > 1) return 0
    return cols.has(p.x + ',' + p.z) ? COST : 0
  }
}

function cropPlaceExclusion (bot) {
  if (process.env.NO_PLACE_ON_FARM === '0') return null
  let cells = null
  try { const wf = loadWorldMem().wheatFarm; cells = (wf && wf.cells) || null } catch { return null }
  if (!cells || !cells.length) return null
  // #56 FARM_EXCLUDE_YFIX: per-(x,z) y-set so placement is forbidden on EVERY crop cell + its
  // farmland + the block above, at each cell's OWN level (not just the first cell's cy-window).
  const YFIX = process.env.FARM_EXCLUDE_YFIX !== '0'
  const cols = new Set()
  const colY = YFIX ? new Map() : null
  let cy = null
  for (const c of cells) {
    cols.add(c.x + ',' + c.z)
    if (cy == null) cy = c.y
    if (YFIX) { const k = c.x + ',' + c.z; let s = colY.get(k); if (!s) { s = new Set(); colY.set(k, s) } s.add(c.y - 1); s.add(c.y); s.add(c.y + 1) }
  }
  const COST = Number(process.env.NO_PLACE_ON_FARM_COST || 1000000) // effectively forbid: A* routes around unless the ONLY path (survival) crosses the farm
  return (block) => {
    const p = block && block.position
    if (!p) return 0
    if (YFIX) { const s = colY.get(p.x + ',' + p.z); return (s && s.has(p.y)) ? COST : 0 }
    if (cy != null && Math.abs(p.y - cy) > 1) return 0
    return cols.has(p.x + ',' + p.z) ? COST : 0
  }
}

function inAvoidBox (avoid, x, z) { return !!avoid && x >= avoid.x1 && x <= avoid.x2 && z >= avoid.z1 && z <= avoid.z2 }

async function boneMealBlock (bot, pos, times) {
  const mcData = require('minecraft-data')(bot.version)
  for (let u = 0; u < times; u++) {
    let meal = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone_meal')
    if (!meal) {
      const bone = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone')
      if (!bone) return
      try { const r = bot.recipesFor(mcData.itemsByName.bone_meal.id, null, 1, null)[0]; if (!r) return; await bot.craft(r, 1, null); meal = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone_meal') } catch { return }
      if (!meal) return
    }
    const b = bot.blockAt(pos)
    if (!b || (b.getProperties && (b.getProperties().age ?? 0) >= 7)) return
    try { await bot.equip(meal, 'hand'); await bot.activateBlock(b); await new Promise(r => setTimeout(r, 300)) } catch { return }
  }
}

async function tillCell (bot, cell) {
  const cropPos = cell.position.offset(0, 1, 0)
  let base = bot.blockAt(cell.position)
  if (base && farm.farmlandReady(base.name)) return 'farmland'
  if (!base || !farm.tillableBank(base.name)) return 'unfarmable'
  // Ensure the crop cell above is air, or the hoe silently no-ops.
  let above = bot.blockAt(cropPos)
  if (above && !AIRISH(above.name)) {
    if (/water|bubble_column|kelp|seagrass/.test(above.name)) {
      // Displace the water: drop a carried block into the cell, then break it. A lone source
      // is consumed (cell -> air); water still fed by a neighbour source reflows and we skip.
      const filler = (bot.inventory ? bot.inventory.items() : []).find(i => /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|netherrack|gravel)$/.test(i.name))
      if (filler) {
        try {
          if (await placeAt(bot, cropPos, new RegExp('^' + filler.name + '$'))) {
            const plug = bot.blockAt(cropPos)
            if (plug && plug.boundingBox === 'block') await bot.dig(plug)
          }
        } catch {}
      }
    } else if (REPLACEABLE.test(above.name)) {
      try { await bot.dig(above) } catch {}
    }
    await new Promise(r => setTimeout(r, 350)) // let any flow settle before re-reading
    above = bot.blockAt(cropPos)
    if (above && !AIRISH(above.name)) { dbg('  till: crop cell above ' + cropPos.toString() + " won't clear (" + above.name + ') - skipping (flood-prone)'); return 'flooded' }
  }
  const hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
  if (!hoe) return 'nohoe'
  await bot.equip(hoe, 'hand')
  base = bot.blockAt(cell.position) // re-read (position stable; name may have swapped)
  try { await bot.activateBlock(base) } catch (e) { dbg('  till: activateBlock threw (' + e.message + ')') }
  await new Promise(r => setTimeout(r, 200))
  const tilled = bot.blockAt(cell.position)
  return (tilled && farm.farmlandReady(tilled.name)) ? 'farmland' : false
}

async function withdrawSeedsFromBank (bot, want, { near = null, isStopped = () => false, say = () => {} } = {}) {
  if (process.env.FARM_SEED_BANK === '0') return countItem(bot, 'wheat_seeds')
  const have = countItem(bot, 'wheat_seeds')
  if (farm.seedBankWithdrawAmount(Infinity, have, want) <= 0) return have // pack already has `want`
  try {
    const anchor = near || S().resolveBankCell(bot) || hutAnchor() ||
      (bot.entity && bot.entity.position ? { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) } : null)
    // craft:false -> pure bank WITHDRAW only (wheat_seeds is not craftable; acquire would refuse to
    // gather anyway, but craft:false skips the reconcile/chest-read churn and can't throw outward).
    await require('./resources.js').acquire(bot, 'wheat_seeds', want, { near: anchor, craft: false, isStopped, say })
  } catch (e) { dbg('  seeds: bank withdraw failed (' + e.message + ') - falling back to grass') }
  const now = countItem(bot, 'wheat_seeds')
  if (now > have) dbg('  seeds: withdrew ' + (now - have) + ' wheat_seeds from the bank (bank-first, before grass)')
  return now
}

async function gatherSeedsNear (bot, want, { isStopped = () => false, near = null, say = () => {} } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const seedCount = () => countItem(bot, 'wheat_seeds')
  if (seedCount() >= want) return seedCount()
  if (process.env.FARM_SEED_BANK !== '0') { await withdrawSeedsFromBank(bot, want, { near, isStopped, say }); if (seedCount() >= want) return seedCount() }
  const grassIds = ['short_grass', 'tall_grass', 'grass', 'fern', 'large_fern'].map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(x => x != null)
  let broken = 0; let legs = 0
  const searchGrass = () => bot.findBlock({ matching: grassIds, maxDistance: 48 })
  while (seedCount() < want && broken < 60 && !isStopped()) {
    let g = searchGrass()
    if (!g && legs < 4) { // barren here - roam a compass leg toward likely meadow, then re-search
      legs++
      const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][legs % 4]
      const tx = Math.round(bot.entity.position.x + dir[0] * 32); const tz = Math.round(bot.entity.position.z + dir[1] * 32)
      dbg('  seeds: no grass in 48 - roaming a leg to ' + tx + ',' + tz + ' to find grass for seeds')
      try { await S().walkStaged(bot, tx, tz, { isStopped, range: 6, timeoutMs: 40000 }) } catch {}
      g = searchGrass()
    }
    if (!g) break
    try {
      if (bot.entity.position.distanceTo(g.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(g.position.x, g.position.y, g.position.z, 2), 10000)
      await bot.dig(g); broken++
    } catch { break }
    if (broken % 6 === 0) await collectDrops(bot, 6)
  }
  await collectDrops(bot, 8)
  dbg('  seeds: broke ' + broken + ' grass -> ' + seedCount() + ' seeds')
  return seedCount()
}

async function placeFarmTorches (bot, cells, { isStopped = () => false } = {}) {
  if (!cells || !cells.length) return 0
  if (countItem(bot, 'torch') < 1) { try { await S().ensureTorches(bot, 4) } catch {} } // craft a few if coal+stick on hand; best-effort
  if (countItem(bot, 'torch') < 1) { dbg('  wheat farm: no torches on hand (skipping lighting - establishment not blocked)'); return 0 }
  const cropCols = new Set(cells.map(c => c.x + ',' + c.z))
  // spaced anchors (~6b apart) so torches cover perimeter + interior without clustering.
  const anchors = []
  for (const c of cells) { if (!anchors.some(a => Math.hypot(a.x - c.x, a.z - c.z) < 6)) anchors.push(c) }
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
  let placed = 0
  for (const c of anchors) {
    if (isStopped() || countItem(bot, 'torch') < 1) break
    for (const [dx, dz] of NB) { // a dry, NON-crop neighbour column to stand the torch on
      const gx = c.x + dx; const gz = c.z + dz
      if (cropCols.has(gx + ',' + gz)) continue
      const ground = bot.blockAt(new Vec3(gx, c.y - 1, gz)) // block the torch sits ON (farmland level)
      const cell = bot.blockAt(new Vec3(gx, c.y, gz)) // the cell the torch occupies (crop level)
      if (!ground || ground.boundingBox !== 'block' || /water|lava|farmland/.test(ground.name)) continue
      if (!cell || !AIRISH(cell.name)) continue
      const tpos = new Vec3(gx, c.y, gz)
      if (bot.entity.position.distanceTo(tpos) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(gx, c.y, gz, 3), 8000) } catch {} }
      try { if (await placeAt(bot, tpos, /^torch$/)) { placed++; break } } catch {}
    }
  }
  if (placed) dbg('  wheat farm: placed ' + placed + ' torch(es) around the plot (growth + mob suppression)')
  return placed
}

async function levelPlotCell (bot, cx, baseY, cz, { isStopped = () => false } = {}) {
  let ground = null
  for (let y = baseY + 3; y >= baseY - 2; y--) {
    const b = bot.blockAt(new Vec3(cx, y, cz)); const a = bot.blockAt(new Vec3(cx, y + 1, cz))
    if (b && b.boundingBox === 'block' && a && (AIRISH(a.name) || REPLACEABLE.test(a.name))) { ground = b; break }
  }
  if (!ground) return false
  if (ground.position.y === baseY && AIRISH((bot.blockAt(ground.position.offset(0, 1, 0)) || { name: 'air' }).name)) return true // already flat
  if (bot.entity.position.distanceTo(ground.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(cx, ground.position.y, cz, 3), 8000) } catch { return false } }
  for (let dy = 1; dy <= 2; dy++) { // soft cover off first
    const v = bot.blockAt(ground.position.offset(0, dy, 0))
    if (v && !AIRISH(v.name) && /grass|fern|flower|dead_bush|snow|vine/.test(v.name)) { try { await bot.dig(v) } catch {} }
  }
  let guard = 3
  while (ground.position.y > baseY && guard-- > 0 && !isStopped()) { // shave bump (incl. scaffold cobble litter)
    const shaveable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (!shaveable || (bot.canDigBlock && !bot.canDigBlock(ground))) break
    const tool = toolForBlock(bot, ground.name) // stone shaved wrong-tool drops nothing
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(ground); await collectDrops(bot, 3) } catch { break }
    const nb = bot.blockAt(new Vec3(cx, ground.position.y - 1, cz))
    if (!nb || nb.boundingBox !== 'block') break
    ground = nb
  }
  if (ground.position.y < baseY) { // fill the dip ALL the way up with dirt (operator: "flat ground floor with dirt")
    let fills = 4
    while (ground.position.y < baseY && fills-- > 0 && !isStopped()) {
      if (!await placeAt(bot, ground.position.offset(0, 1, 0), /^(dirt|coarse_dirt|grass_block)$/)) break
      const nb = bot.blockAt(ground.position.offset(0, 1, 0))
      if (!nb || nb.boundingBox !== 'block') break
      ground = nb
    }
  }
  // uniform DIRT surface: a stone/gravel/cobble top reads as mess even when level -
  // swap it for dirt (operator order: the plot is a flat DIRT floor, not mixed rubble)
  if (ground.position.y === baseY && !/^(grass_block|dirt|coarse_dirt|podzol|mycelium|farmland)$/.test(ground.name)) {
    const swappable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (swappable && (bot.inventory ? bot.inventory.items() : []).some(i => /^(dirt|coarse_dirt)$/.test(i.name))) {
      const tool = toolForBlock(bot, ground.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      try {
        await bot.dig(ground); await collectDrops(bot, 2)
        await placeAt(bot, ground.position, /^(dirt|coarse_dirt)$/)
      } catch {}
    }
  }
  return true
}

// #87 DRY_HOME_FARM: establish/expand a hut-adjacent DRY farmland plot (no water, no bucket, no iron -
// crops grow on dry farmland at ~half speed, and a PLANTED cell never reverts to dirt). Sited 6-14b off
// the hut anchor, clear of the apron, on NATURAL flat grass/dirt only (anti-grief; tillableBank keeps it
// to grass/dirt/coarse/rooted so we never dig/place inside the structure). Registered in the SAME
// wheatFarm schema with `dry:true`, so tendWheatFarm/collect/exclusions all just work on it. Called ONLY
// from ensureWheatFarm under the flag (flag off -> never invoked -> today byte-for-byte). No hydration/
// water-within-4 gate exists to skip: the only water requirement is ensureWheatFarm's own `!waters.length`
// defer, which this path is injected BEFORE. Returns true when the plot stands (established/expanded),
// false to defer to the caller's fallback.
async function ensureDryHomeFarm (bot, home, hut, { isStopped = () => false, say = () => {}, avoid = null, expand = false } = {}) {
  if (!hut) return false
  const m = loadWorldMem()
  const NEAR_MIN = Number(process.env.DRY_FARM_NEAR_MIN || 6)
  const NEAR_MAX = Number(process.env.DRY_FARM_NEAR_MAX || 14)
  const FLAT_SITE = process.env.FARM_FLAT_SITE !== '0'
  const FLAT_MIN = Number(process.env.FARM_FLAT_MIN || 0.6)
  const MIN_TILLABLE = Number(process.env.FARM_MIN_TILLABLE || 6)
  const DIST_WEIGHT = Number(process.env.FARM_DIST_WEIGHT || 0.75)
  const LEVEL = process.env.FARM_LEVEL !== '0'
  const TORCH = process.env.FARM_TORCH !== '0'
  const floorY = hut.y // the hut infra y is the floor level - crops sit level with the home floor
  const cx = hut.x + 2; const cz = hut.z + 2 // hut centre (6x6): the plot anchor + tend/collect centre
  const existingLen = (expand && m.wheatFarm && m.wheatFarm.cells && m.wheatFarm.cells.length) || 0
  const onApron = (x, z) => x >= hut.x - 2 && x <= hut.x + 6 && z >= hut.z - 2 && z <= hut.z + 6 // == onHutApron box
  // annulus 6-14b off the hut corner, off the apron, on NATURAL tillable ground (grass/dirt) with a
  // replaceable/air cell above - NO water-adjacency requirement (dry mode). tillableBank keeps it to
  // grass/dirt/coarse/rooted so tillCell takes directly (no sand/dirt-swap) and we never touch the hut.
  const scanDry = () => {
    const out = []; const seen = new Set()
    for (let dx = -NEAR_MAX; dx <= NEAR_MAX; dx++) for (let dz = -NEAR_MAX; dz <= NEAR_MAX; dz++) {
      const dist = Math.hypot(dx, dz)
      if (dist < NEAR_MIN || dist > NEAR_MAX) continue
      const gx = hut.x + dx; const gz = hut.z + dz; const k = gx + ',' + gz
      if (seen.has(k) || onApron(gx, gz) || inAvoidBox(avoid, gx, gz)) continue
      seen.add(k)
      let ground = null
      for (let y = floorY + 3; y >= floorY - 3; y--) {
        const b = bot.blockAt(new Vec3(gx, y, gz)); const a = bot.blockAt(new Vec3(gx, y + 1, gz))
        if (b && b.boundingBox === 'block' && a && (AIRISH(a.name) || REPLACEABLE.test(a.name))) { ground = b; break }
      }
      if (!ground || !farm.tillableBank(ground.name)) continue
      if (insideOwnStructure(bot, ground.position)) continue // never the hut structure itself (anti-grief)
      out.push({ x: gx, z: gz, y: ground.position.y, flat: ground.position.y === floorY, block: ground })
    }
    return out
  }
  let cands = scanDry()
  const tillable = cands.length
  const flatFrac = tillable ? cands.filter(c => c.flat).length / tillable : 0
  // fresh establish gates on the SAME flat-site scorer as the water path (only water-adjacency dropped):
  // a rough/obstructed annulus is rejected so the caller can fall back to the legacy path. Expansion
  // skips the gate (the plot already stands) and just adds whatever flat cells remain.
  if (!expand) {
    const sc = farm.scoreFarmSite({ tillable, flatFrac, distHome: 0, target: WHEAT_FARM_TARGET }, { distWeight: DIST_WEIGHT, minTillable: MIN_TILLABLE, minFlatFrac: FLAT_SITE ? FLAT_MIN : 0 })
    if (!sc.acceptable) { dbg('  wheat farm [dry]: annulus ' + NEAR_MIN + '-' + NEAR_MAX + 'b off the hut not acceptable (tillable ' + tillable + ', flat ' + flatFrac.toFixed(2) + ') - deferring to fallback'); return false }
  }
  const ownedCols = new Set(((m.wheatFarm && m.wheatFarm.cells) || []).map(c => c.x + ',' + c.z))
  cands = farm.orderBankCandidates(cands.filter(c => !ownedCols.has(c.x + ',' + c.z)), { x: cx, z: cz }) // grow contiguously outward from the hut
  if (!cands.length) { dbg('  wheat farm [dry]: no un-owned flat cells left off the hut'); return existingLen > 0 }
  // 1) a hoe - acquired via the resource model exactly as the water path (withdraw > craft > gather wood)
  let hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
  if (!hoe) {
    try {
      const res = require('./resources.js')
      const rec = await res.reconcile(bot, { wooden_hoe: 1 }, { near: hut, maxAgeMs: 0, planOpts: { primaryWood: P().detectWood(bot) || 'oak' } })
      dbg('  wheat farm [dry]: acquiring a wooden hoe (' + (rec.plan.tasks.map(t => `${t.type}:${t.item || t.output}`).join(' > ') || (rec.withdraws.length ? 'from bank' : 'from hand')) + ')')
      if (rec.withdraws.length || rec.plan.tasks.length) await res.runReconciled(bot, rec, { isStopped, say, home: hut })
    } catch (e) { dbg('  wheat farm [dry]: hoe acquisition failed (' + e.message + ')') }
    hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
    if (!hoe) { dbg('  wheat farm [dry]: still no hoe - deferred'); return existingLen > 0 }
  }
  // 2) seeds - bank-first then grass, same as the water path
  const seedCount = () => countItem(bot, 'wheat_seeds')
  const seedWant = process.env.FARM_SEED_TOPUP === '0' ? 3 : Math.max(3, Math.min(12, WHEAT_FARM_TARGET - existingLen))
  if (seedCount() < seedWant) {
    try { await S().walkStaged(bot, cx, cz, { isStopped, range: 6, timeoutMs: 60000 }) } catch {}
    await gatherSeedsNear(bot, seedWant, { isStopped, near: hut, say })
    if (seedCount() < 1) { dbg('  wheat farm [dry]: no seeds (bank + grass empty) - deferred'); return existingLen > 0 }
  }
  say(expand ? 'expanding the home wheat plot - dry farmland, no commute' : 'planting a wheat plot right by the hut - dry farmland, no more food runs')
  // 3) level the target cells to the hut floor Y (one baseY) so tills take + the plot is tidy - the
  // orchard/water-farm levelPlotCell primitive, bounded. FARM_LEVEL=0 keeps today's no-level behavior.
  const baseY = floorY
  if (LEVEL && !isStopped()) {
    if (countItem(bot, 'dirt') < 12 && !isStopped()) { try { await P().runGather(bot, 'dirt', 24, { isStopped, restoreMovements: () => {}, home: { x: cx, z: cz }, avoid }) } catch (e) { dbg('  wheat farm [dry]: dirt stock-up failed (' + e.message + ')') } }
    const LB = Number(process.env.FARM_LEVEL_BUDGET || 48); const LM = Number(process.env.FARM_LEVEL_MS || 60000)
    const t0 = Date.now(); let leveled = 0; let tried = 0
    for (const c of cands.slice(0, 12)) {
      if (isStopped() || tried >= LB || Date.now() - t0 > LM) break
      tried++
      try { if (await levelPlotCell(bot, c.x, baseY, c.z, { isStopped })) leveled++ } catch {}
    }
    dbg('  wheat farm [dry]: leveled ' + leveled + '/' + tried + ' cell(s) to baseY ' + baseY)
    cands = farm.orderBankCandidates(scanDry().filter(c => !ownedCols.has(c.x + ',' + c.z)), { x: cx, z: cz }) // re-read the now-flat ground
  }
  // 4) till + plant (block-verified, exactly like the water path minus the sand/dirt-swap - we
  // restricted to tillableBank ground). No hydration gate: dry farmland grows crops just fine.
  let planted = 0; let attempted = 0; const plantedCells = []
  for (const cell of cands.slice(0, 12).map(c => c.block)) {
    if (isStopped() || seedCount() < 1) break
    attempted++
    try {
      if (bot.entity.position.distanceTo(cell.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(cell.position.x, cell.position.y, cell.position.z, 2), 12000)
      const veg = bot.blockAt(cell.position.offset(0, 1, 0))
      if (veg && !AIRISH(veg.name)) { try { await bot.dig(veg) } catch {} }
      const tr = await tillCell(bot, cell)
      if (tr === 'nohoe') { dbg('  wheat farm [dry]: hoe vanished mid-pass - aborting'); break }
      if (tr !== 'farmland') { dbg('  wheat farm [dry]: till did not take at ' + cell.position.toString() + ' (' + tr + ', got ' + ((bot.blockAt(cell.position) || {}).name || '?') + ')'); continue }
      const tilled = bot.blockAt(cell.position)
      const seeds = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'wheat_seeds')
      if (!seeds) break
      await bot.equip(seeds, 'hand')
      const cropPos = cell.position.offset(0, 1, 0)
      try { await bot.placeBlock(tilled, new Vec3(0, 1, 0)) } catch (e) { dbg('  wheat farm [dry]: seed place threw (' + e.message + ')') }
      await new Promise(r => setTimeout(r, 200))
      const crop = bot.blockAt(cropPos)
      if (crop && crop.name === 'wheat') { planted++; plantedCells.push({ x: cropPos.x, y: cropPos.y, z: cropPos.z }); await boneMealBlock(bot, cropPos, 2) }
      else dbg('  wheat farm [dry]: seed did NOT take at ' + cropPos.x + ',' + cropPos.y + ',' + cropPos.z + ' (got ' + ((crop && crop.name) || '?') + ')')
    } catch (e) { dbg('  wheat farm [dry]: cell failed (' + e.message + ')') }
  }
  // 5) merge with the standing dry plot (expansion) + persist under the SAME schema + dry:true. On a
  // fresh establish this SUPERSEDES a far water farm (its record is dropped here; its pond stays in the
  // infra registry via rememberInfra for a future bucket-hydration upgrade). Only overwrite on success,
  // so a failed pass never strands the bot farm-less.
  const prior = expand ? ((m.wheatFarm && m.wheatFarm.cells) || []) : []
  const byKey = new Map()
  for (const c of prior) byKey.set(c.x + ',' + c.y + ',' + c.z, { x: c.x, y: c.y, z: c.z })
  for (const c of plantedCells) byKey.set(c.x + ',' + c.y + ',' + c.z, c)
  const merged = [...byKey.values()]
  if (!merged.length) { dbg('  wheat farm [dry]: could not plant any cell (none verified as wheat) - leaving any existing farm intact'); return false }
  const eligibleRemaining = Math.max(0, cands.length - attempted)
  const maxed = farm.expansionMaxed({ expand: true, planted, eligibleRemaining, cells: merged.length, target: WHEAT_FARM_TARGET })
  const prevHealth = expand && m.wheatFarm ? m.wheatFarm.cellHealth : undefined // carry the tend cell-health ledger across an expansion
  m.wheatFarm = { x: cx, y: baseY, z: cz, cells: merged, at: Date.now(), maxed, dry: true }
  if (prevHealth) m.wheatFarm.cellHealth = prevHealth
  saveWorldMem()
  dbg('  wheat farm [dry]: ' + planted + ' new cell(s), ' + merged.length + ' total at the hut (' + cx + ',' + cz + ')' + (maxed ? ' [site maxed - ' + eligibleRemaining + ' eligible left]' : ''))
  if (planted) say(`home wheat plot ${expand ? 'expanded' : 'planted'} (${merged.length} cells) by the hut - dry farmland, bread without the commute`)
  if (TORCH) { try { await placeFarmTorches(bot, merged, { isStopped }) } catch (e) { dbg('  wheat farm [dry]: torch pass failed (' + e.message + ')') } }
  return true
}

async function ensureWheatFarm (bot, home, { isStopped = () => false, say = () => {}, avoid = null } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const m = loadWorldMem()
  // FARM_EXPAND (river farm expansion): bank-following growth, flat-site selection, honest maxed,
  // 33-cell target. All EXPAND-gated; FARM_EXPAND=0 = today byte-for-byte (8 cols, 32-merge around
  // w, old maxed expr, target 20, no survey/memory-meta/crossing-note/re-site). See DESIGN-river-
  // farm-expansion.md.
  const EXPAND = process.env.FARM_EXPAND !== '0'
  const SITE_RADIUS = Number(process.env.FARM_SITE_RADIUS || (EXPAND ? 40 : 32))
  const WATER_COLS = Number(process.env.FARM_WATER_COLS || (EXPAND ? 32 : 8))
  const DIST_WEIGHT = Number(process.env.FARM_DIST_WEIGHT || 0.75)
  const MIN_TILLABLE = Number(process.env.FARM_MIN_TILLABLE || 6)
  const NEAR_HOME = Number(process.env.FARM_NEAR_HOME || 112)
  const RESITE = EXPAND && process.env.FARM_RESITE !== '0'
  const RESITE_SLACK = Number(process.env.FARM_RESITE_SLACK || 16)
  const RESITE_MARGIN = Number(process.env.FARM_RESITE_MARGIN || 8)
  const RESITE_COOLDOWN_MS = Number(process.env.FARM_RESITE_COOLDOWN_MS || 6 * 3600 * 1000)
  // #56 FARM_REAL (the farm has NEVER grown - ensureWheatFarm did ZERO leveling). A: level the plot
  // to one baseY so tills take. B: pick flat + dry ground. C: torch the plot. D: y-set exclusion.
  // Each flag =0 restores today byte-for-byte. See DESIGN-farm-actually-grows.md.
  const LEVEL = process.env.FARM_LEVEL !== '0'
  const FLAT_SITE = process.env.FARM_FLAT_SITE !== '0'
  const FLAT_MIN = Number(process.env.FARM_FLAT_MIN || 0.6)
  const TORCH = process.env.FARM_TORCH !== '0'
  // Hydration (MC mechanics): farmland is hydrated within 4b horizontally (Chebyshev) of a water
  // source at the SAME Y (or water 1 above) - one source feeds a 9x9. Today's ring is only r∈{1,2}
  // (a thin, tiny farm). Leveling (A) makes cells out to the full 4b range usable, so widen the ring
  // toward 4 when FARM_LEVEL is on; every cell stays inside the source's hydration reach. =0 keeps 2.
  const RING_MAX = Math.max(1, Math.min(4, Number(process.env.FARM_RING_MAX || (LEVEL ? 4 : 2))))
  // one farm per site - but only once it's BIG ENOUGH. A stale/pre-schema record with 0 cells
  // (live: a farm record at 382,38 with cells:[]) used to block re-planting forever while tend
  // had nothing to tend - a dead-farm deadlock. 0 live cells = no farm, rebuild. AND a 1-cell
  // farm (live: a pond that offered only 1 bank cell) yields 1 wheat/cycle - never the 3 needed
  // for bread. So DON'T early-return at 1 cell: keep coming back to EXPAND until we hit the
  // target (>=6 cells -> >=3 wheat -> bread), or until the site can't grow any further (`maxed`).
  const existingLen = (m.wheatFarm && m.wheatFarm.cells && m.wheatFarm.cells.length) || 0
  const nearExisting = m.wheatFarm && Math.hypot(m.wheatFarm.x - home.x, m.wheatFarm.z - home.z) <= 80
  // §4.6 re-site eligibility: a maxed + demonstrably-tiny farm may relocate ONCE per cooldown.
  // When eligible we SKIP the early-return so the pass can survey a better bank (the ONLY new code
  // reachable while `maxed` is latched); the actual move still needs shouldResite to pass below.
  const tinyMaxed = !!(m.wheatFarm && m.wheatFarm.maxed && existingLen > 0 && existingLen < Math.ceil(WHEAT_FARM_TARGET / 2))
  const resiteEligible = RESITE && nearExisting && tinyMaxed && (Date.now() - (m.farmResiteAt || 0) > RESITE_COOLDOWN_MS)
  // #87 DRY_HOME_FARM: a hut-adjacent DRY farmland plot kills the food commute (crops grow on dry
  // farmland at ~half speed; a PLANTED cell never reverts - no water/bucket/iron needed). Fires only
  // with the flag + a hut anchor + no standing farm within DRY_FARM_NEAR of it (establish/supersede a
  // far water farm), or to expand a standing dry home plot. dryHomeFarmMode is the PURE gate.
  // DRY_HOME_FARM=0 -> dryMode always 'off' -> every branch below is skipped (today byte-for-byte).
  const DRY_HOME_FARM = process.env.DRY_HOME_FARM !== '0'
  const DRY_FARM_NEAR = Number(process.env.DRY_FARM_NEAR || 24)
  const hutA = hutAnchor()
  const standingNearHut = !!(m.wheatFarm && m.wheatFarm.cells && m.wheatFarm.cells.length > 0 && hutA &&
    Math.hypot(m.wheatFarm.x - hutA.x, m.wheatFarm.z - hutA.z) <= DRY_FARM_NEAR)
  const dryMode = DRY_HOME_FARM
    ? farm.dryHomeFarmMode({ flag: true, hutExists: !!hutA, standingNearHut, farmIsDry: !!(m.wheatFarm && m.wheatFarm.dry), cells: existingLen, target: WHEAT_FARM_TARGET, maxed: !!(m.wheatFarm && m.wheatFarm.maxed) })
    : 'off'
  // ...but a far, maxed/at-target water farm must NOT early-return when dry mode wants to SUPERSEDE it
  // (dryMode 'establish' means no standing farm is near the hut, so the far one may be replaced).
  if (nearExisting && (existingLen >= WHEAT_FARM_TARGET || (existingLen > 0 && m.wheatFarm.maxed)) && !resiteEligible && dryMode !== 'establish') return true
  // BAD MOMENT guard: the last attempt ran while being chased INTO A CAVE - it searched
  // for grass from underground and found none. Farming is a peacetime surface job.
  // FIX #39: farming is a peacetime SURFACE job - defer if we're truly caved-in, hunted, or it's
  // night. Fix A (FARM_CAVE_STRICT): a LEAF CANOPY is not a cave roof. hasSolidCeiling counts any
  // 'block'-bounding-box block above, so tree leaves / an overhang within 12b read as a ceiling and
  // farming was skipped in broad daylight (verified: isDay + no threat still deferred). ignoreLeaves
  // makes the ceiling check require a real opaque (non-leaf) block. FARM_CAVE_STRICT=0 = legacy.
  // Fix B: split the lumped message so the log names WHICH condition fired (this vagueness
  // misdiagnosed the defer twice) - pure observability, always on.
  const ceilStrict = process.env.FARM_CAVE_STRICT !== '0'
  const ceiling = hasSolidCeiling(bot, 12, { ignoreLeaves: ceilStrict })
  const hostile = nearHostile(bot, 16)
  const night = isNight(bot)
  if (ceiling || hostile || night) {
    const why = ceiling ? 'solid ceiling <=12b (real cave roof)' : hostile ? 'hostile within 16b' : 'night'
    dbg('  wheat farm: bad moment - ' + why + ' - deferred')
    return false
  }
  // #87 DRY_HOME_FARM: dry-first. Establish/expand the hut-adjacent dry plot BEFORE the water search
  // (dry mode needs no water). On a non-establish miss it falls back to the legacy water path so a
  // farmless bot is never stranded. This whole block is unreachable when DRY_HOME_FARM=0 (dryMode
  // pins to 'off'), so flag off is byte-for-byte today.
  if (DRY_HOME_FARM && dryMode !== 'off' && !isStopped()) {
    const established = await ensureDryHomeFarm(bot, home, hutA, { isStopped, say, avoid, expand: dryMode === 'expand' })
    if (established) return true
    if (dryMode === 'expand') return true // the standing dry plot still stands (this pass just deferred adds)
    if (existingLen > 0) return false // a far farm still stands + is tended; retry dry next pass (don't build a 2nd farm)
    dbg('  wheat farm: dry-home found no flat home site and no farm yet - falling back to the legacy water path')
  }
  // 1) surface water within reach of home - farmland must sit beside it
  const waterId = mcData.blocksByName.water.id
  // SURFACE water only: cave/ravine pools pass the air-above test but have stone banks
  // and no light for crops - "0 bank cells" at two remembered underground pools, live.
  const seesSky = p => {
    for (let dy = 1; dy <= 40; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false
    }
    return true
  }
  const findWaters = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 }) || [])
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
    .filter(p => !inAvoidBox(avoid, p.x, p.z))
    .filter(seesSky)
  let waters = findWaters()
  if (!waters.length) {
    // No pond in sight - but maybe we REMEMBER one. The camp runs this from the site,
    // where the nearest pond sits beyond 48 blocks: every camp farm attempt deferred
    // forever while the bot starved (live, all morning). Ponds seen during any earlier
    // attempt are in the infra registry - trek back to one.
    const known = recallInfra('water', bot.entity.position, 250) // the discovered pond can be >120 out (sweep ring 96/144)
    if (known && !isStopped()) {
      dbg('  wheat farm: no water in sight - walking to remembered pond at ' + known.x + ',' + known.z)
      try { await S().walkStaged(bot, known.x, known.z, { isStopped, range: 6, timeoutMs: 150000 }) } catch {}
      waters = findWaters()
      // ONLY forget the remembered pond if we actually ARRIVED near it and it's genuinely
      // gone - a trek that fell short (blocked path) must NOT erase a good remembered pond
      // (that's how the bot lost its one water and could never farm again).
      // #59 §C FARM_FORGET_DRY_WATER (default on): walkStaged stops within nav RANGE (6), so the
      // exact-coord hypot lands ~6-9b out and the old strict <=8 gate FREQUENTLY failed to forget a
      // genuinely-dry phantom (the 444,35 pond re-picked every crisis). Widen the "arrived" radius so
      // a reached-but-dry water is forgotten; still guarded by !waters.length (nothing farmable in 48b).
      // =0 -> the strict <=8 (byte-for-byte).
      const arriveR = process.env.FARM_FORGET_DRY_WATER === '0' ? 8 : Number(process.env.FARM_FORGET_ARRIVE || 12)
      if (!waters.length && Math.hypot(bot.entity.position.x - known.x, bot.entity.position.z - known.z) <= arriveR) {
        dbg('  wheat farm: arrived at remembered pond ' + known.x + ',' + known.z + ' but no open-sky water there anymore - forgetting it')
        forgetInfra('water', listInfra('water').find(e => e.x === known.x && e.z === known.z))
      } else if (!waters.length) dbg('  wheat farm: could not reach remembered pond ' + known.x + ',' + known.z + ' (trek fell short) - keeping it for next time')
    }
  }
  if (!waters.length) { dbg('  wheat farm: no surface water within 48 - deferred'); return false }
  const w = waters[0]
  rememberInfra('water', { x: w.x, y: w.y, z: w.z }) // future camp passes trek straight back
  // ---- FARM_EXPAND site selection + anchor pinning (§4.1/4.2/4.4/4.6) -----------------
  const homeXZ = hutAnchor() || home
  // scanBank(siteVec): the ring build's OWN predicate as a reusable closure - the exact bands,
  // BANK_DYS, base regex, REPLACEABLE-above test and cross-band dedup as the legacy loop. Returns
  // { block, x, z, band, flat } candidates. The survey uses it to PREDICT a site (no new block
  // semantics); the plant loop uses it to build the actual ring. flag OFF: cols = waters.slice(0,8)
  // with no radius filter -> byte-identical ring.
  // #56 FARM_FLAT_SITE dryness: a candidate whose crop cell has a horizontally-adjacent water
  // source at crop level will be washed out the instant the seed is placed - skip it (only when
  // FLAT_SITE is on; off = today's accept-any-tillable). Cheap: 4 block reads per accepted cell.
  const floodsAt = (cropPos) => {
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nb = bot.blockAt(cropPos.offset(ax, 0, az))
      if (nb && /water/.test(nb.name)) return true
    }
    return false
  }
  const scanBank = (siteVec) => {
    const out = []; const seen = new Set()
    const cols = (EXPAND ? waters.filter(wp => Math.hypot(wp.x - siteVec.x, wp.z - siteVec.z) <= SITE_RADIUS) : waters).slice(0, WATER_COLS)
    for (let r = 1; r <= RING_MAX; r++) { // #56: r∈{1,2} today; up to 4 (full hydration range) with FARM_LEVEL on
      const offs = []
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { if (Math.max(Math.abs(dx), Math.abs(dz)) === r) offs.push([dx, dz]) }
      for (const wp of cols) {
        for (const [dx, dz] of offs) {
          const k = (wp.x + dx) + ',' + (wp.z + dz)
          if (seen.has(k) || inAvoidBox(avoid, wp.x + dx, wp.z + dz)) continue
          seen.add(k)
          for (const dy of farm.BANK_DYS) {
            const gp = wp.offset(dx, dy, dz)
            const g = bot.blockAt(gp); const above = bot.blockAt(gp.offset(0, 1, 0))
            if (g && /^(grass_block|dirt|sand|red_sand|gravel|clay)$/.test(g.name) && above && REPLACEABLE.test(above.name)) {
              if (FLAT_SITE && floodsAt(gp.offset(0, 1, 0))) continue // #56 dryness: adjacent water at crop level would flood -> try a higher dy / skip
              out.push({ block: g, x: wp.x + dx, z: wp.z + dz, band: r, flat: dy === 0 }); break
            }
          }
        }
      }
    }
    return out
  }
  // surveyAt(col): count tillable / flatFrac / distHome for a candidate anchor (cheap block reads).
  const surveyAt = (col) => {
    const cs = scanBank(new Vec3(col.x, col.y, col.z))
    const tillable = cs.length
    const flatFrac = tillable ? cs.filter(c => c.flat).length / tillable : 0
    const distHome = homeXZ ? Math.hypot(col.x - homeXZ.x, col.z - homeXZ.z) : 0
    return { tillable, flatFrac, distHome }
  }
  // pickBestSite(exclude): score up to 4 near-home candidate columns (nearest first, spaced >=16
  // apart) and return { col, score, dist } of the highest ACCEPTABLE one, else null. Remembers the
  // survey meta on each (§4.5.1). `exclude` (the current site on a re-site) is skipped.
  const pickBestSite = (exclude) => {
    const byHome = waters.slice().sort((a, b) => (homeXZ ? Math.hypot(a.x - homeXZ.x, a.z - homeXZ.z) - Math.hypot(b.x - homeXZ.x, b.z - homeXZ.z) : 0))
    const picks = []
    for (const c of byHome) {
      if (homeXZ && Math.hypot(c.x - homeXZ.x, c.z - homeXZ.z) > NEAR_HOME) continue
      if (exclude && Math.hypot(c.x - exclude.x, c.z - exclude.z) <= SITE_RADIUS) continue
      if (picks.some(p => Math.hypot(p.x - c.x, p.z - c.z) < 16)) continue
      picks.push(c); if (picks.length >= 4) break
    }
    let best = null
    for (const c of picks) {
      const sv = surveyAt(c)
      const sc = farm.scoreFarmSite({ tillable: sv.tillable, flatFrac: sv.flatFrac, distHome: sv.distHome, target: WHEAT_FARM_TARGET }, { distWeight: DIST_WEIGHT, minTillable: MIN_TILLABLE, minFlatFrac: FLAT_SITE ? FLAT_MIN : 0 })
      rememberInfra('water', { x: c.x, y: c.y, z: c.z }, { tillable: sv.tillable, flat: sv.flatFrac, surveyedAt: Date.now() })
      if (sc.acceptable && (!best || sc.score > best.score)) best = { col: c, score: sc.score, dist: sv.distHome }
    }
    return best
  }
  // §4.1 pin the anchor: an existing farm within SITE_RADIUS keeps its anchor FOREVER (no drift,
  // no per-pass re-scoring, no dropped cells). Fresh siting (or post-re-site) scores a flat bank.
  let priorFarm = (EXPAND && m.wheatFarm && m.wheatFarm.cells && m.wheatFarm.cells.length &&
                   Math.hypot(m.wheatFarm.x - w.x, m.wheatFarm.z - w.z) <= SITE_RADIUS) ? m.wheatFarm : null
  let resiting = false
  let resiteSite = null
  // A maxed farm only reaches here via resiteEligible (else the early-return fired). If we can't
  // pin it as priorFarm (the bot is standing at a DIFFERENT water than the record), we must NOT
  // clobber it with a competing fresh farm - re-site is only evaluable from the farm's own site.
  if (resiteEligible && !priorFarm) return true
  // §4.6 re-site: a maxed + tiny farm relocates to a clearly-better, no-farther bank (once/cooldown).
  if (resiteEligible && priorFarm) {
    const curDist = homeXZ ? Math.hypot(m.wheatFarm.x - homeXZ.x, m.wheatFarm.z - homeXZ.z) : 0
    const curSv = surveyAt({ x: m.wheatFarm.x, y: m.wheatFarm.y, z: m.wheatFarm.z })
    const curScore = farm.scoreFarmSite({ tillable: curSv.tillable, flatFrac: curSv.flatFrac, distHome: curSv.distHome, target: WHEAT_FARM_TARGET }, { distWeight: DIST_WEIGHT, minTillable: MIN_TILLABLE, minFlatFrac: FLAT_SITE ? FLAT_MIN : 0 }).score
    const best = pickBestSite({ x: m.wheatFarm.x, z: m.wheatFarm.z })
    if (best && farm.shouldResite({ curCells: existingLen, curMaxed: true, curScore, curDist, bestScore: best.score, bestDist: best.dist, target: WHEAT_FARM_TARGET }, { margin: RESITE_MARGIN, nearHome: NEAR_HOME, slack: RESITE_SLACK, minCellsFrac: 0.5 })) {
      dbg('  wheat farm: RE-SITE ' + m.wheatFarm.x + ',' + m.wheatFarm.z + ' (' + existingLen + ' cells, score ' + curScore.toFixed(1) + ' @' + curDist.toFixed(0) + 'b) -> ' + best.col.x + ',' + best.col.z + ' (score ' + best.score.toFixed(1) + ' @' + best.dist.toFixed(0) + 'b)')
      m.wheatFarmOld = Object.assign({}, m.wheatFarm, { retiredAt: Date.now() })
      m.farmResiteAt = Date.now()
      delete m.wheatFarm
      saveWorldMem()
      resiting = true; priorFarm = null
      resiteSite = new Vec3(best.col.x, best.col.y, best.col.z)
      w.x = best.col.x; w.y = best.col.y; w.z = best.col.z // seed-gather + logs point at the new bank
    } else {
      m.farmResiteAt = Date.now() // cooldown consumed even on a failed attempt (no thrash)
      saveWorldMem()
      dbg('  wheat farm: re-site declined (no clearly-better near-home bank) - keeping the ' + existingLen + '-cell farm')
      return true
    }
  }
  const site = !EXPAND ? new Vec3(w.x, w.y, w.z)
    : resiteSite ? resiteSite
    : priorFarm ? new Vec3(priorFarm.x, priorFarm.y, priorFarm.z)
    : (() => { const b = pickBestSite(null); return b ? new Vec3(b.col.x, b.col.y, b.col.z) : new Vec3(w.x, w.y, w.z) })()
  // 2) a hoe (wooden: 2 planks + 2 sticks). ACQUIRE IT VIA THE RESOURCE MODEL, never a bare
  // runCraft: runCraft crafts only from what's ON HAND and THROWS "cannot craft" when
  // planks/sticks aren't already held - the exact live blocker ("no hoe and cannot craft one")
  // even though the bot had logs. reconcile withdraws banked planks/sticks/hoe if any, else
  // plans wooden_hoe <- (planks + sticks) <- planks <- logs and GATHERS wood if short; a bot
  // that can reach one log can make a hoe. runReconciled executes withdraw+gather+craft.
  let hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
  if (!hoe) {
    try {
      const res = require('./resources.js') // lazy (resources requires provision at load)
      // maxAgeMs:0 forces a REAL chest open before concluding wood must be gathered: operator-
      // added / freshly-banked wood inside the 180s cache window otherwise reads stale-empty and
      // the bot treks for wood it already owns (withdraw > gather). Mirrors ensureFood's forceFresh.
      const rec = await res.reconcile(bot, { wooden_hoe: 1 }, { near: home, maxAgeMs: 0, planOpts: { primaryWood: P().detectWood(bot) || 'oak' } })
      dbg('  wheat farm: acquiring a wooden hoe (' + (rec.plan.tasks.map(t => `${t.type}:${t.item || t.output}`).join(' > ') || (rec.withdraws.length ? 'from bank' : 'from hand')) + ')')
      if (rec.withdraws.length || rec.plan.tasks.length) await res.runReconciled(bot, rec, { isStopped, say, home })
    } catch (e) { dbg('  wheat farm: hoe acquisition failed (' + e.message + ')') }
    hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
    if (!hoe) { dbg('  wheat farm: still no hoe (no reachable wood/planks/sticks or no table) - deferred'); return false }
    dbg('  wheat farm: got a ' + hoe.name)
  }
  // 3) seeds - break tall grass/ferns to get wheat_seeds. ACQUIRE them (search WIDE + roam a
  // few compass legs if the pond bank is barren) rather than deferring - grass grows patchily
  // and the pond edge often has none, but a meadow is usually within a short walk.
  const seedCount = () => countItem(bot, 'wheat_seeds')
  // FARM_SEED_TOPUP: gather enough seeds for what THIS expansion pass can plant (up to the
  // 12-cell per-pass cap), so a 20-cell target actually accumulates seeds instead of planting 3
  // and deferring. FARM_SEED_TOPUP=0 restores the hardcoded-3 goal byte-for-byte.
  const seedWant = process.env.FARM_SEED_TOPUP === '0' ? 3 : Math.max(3, Math.min(12, WHEAT_FARM_TARGET - existingLen))
  if (seedCount() < seedWant) {
    try { await gotoWithTimeout(bot, new goals.GoalNear(w.x, w.y, w.z, 4), 60000) } catch {}
    await gatherSeedsNear(bot, seedWant, { isStopped, near: home, say })
    // #59 §A: gatherSeedsNear now raids the bank BEFORE grass, so a <1 result means BOTH the bank
    // AND the grass came up empty - only THEN is it "genuinely no seeds". FARM_SEED_BANK=0 keeps the
    // original grass-only wording byte-for-byte.
    if (seedCount() < 1) { dbg('  wheat farm: ' + (process.env.FARM_SEED_BANK !== '0' ? 'bank empty of seeds AND no grass anywhere within reach' : 'no grass anywhere within reach') + ' - genuinely no seeds here, deferred'); return false }
  }
  // 4) till + plant the water's bank: same-y neighbours of the waterline
  say('setting up a wheat farm by the water - no more starving')
  let planted = 0
  // BANK BAND (§4.2): the ring build's exact predicate via scanBank - Chebyshev 1 then 2,
  // farm.BANK_DYS, base regex, REPLACEABLE-above, cross-band dedup. flag OFF -> byte-identical.
  // flag ON: candidates around the PINNED site (not the drifting waters[0]), spread along the
  // bank (WATER_COLS cols within SITE_RADIUS), minus owned + barren columns, ordered outward.
  // #56 FARM_LEVEL (§A, the keystone): the farm has NEVER grown because ensureWheatFarm did ZERO
  // leveling - it tilled water-adjacent columns at dy 0/1, so crop cells landed at 2-3 Y-levels,
  // tills failed and no cell verified. Level the candidate ring to ONE baseY = the chosen water's
  // surface (w.y) BEFORE tilling, reusing the orchard's levelPlotCell primitive: farmland then sits
  // LEVEL with the water (hydrated) and the crop one block above the surface (unwashable). Bounded
  // by a cell + wall-clock budget (skip a cell it can't level; never loop). FARM_LEVEL=0 = today.
  if (LEVEL && !isStopped()) {
    const baseY = w.y // farmland top == water surface Y -> hydrated (farm.bankUsable: bankY===waterY)
    // level-target columns: the SAME ring geometry scanBank uses (Chebyshev 1..RING_MAX around each
    // near-site water column), deduped, minus water columns / avoid box. RING_MAX<=4 keeps every
    // cell inside its water source's 4b hydration reach, so a leveled cell actually grows crops.
    const lcols = (EXPAND ? waters.filter(wp => Math.hypot(wp.x - site.x, wp.z - site.z) <= SITE_RADIUS) : waters).slice(0, WATER_COLS)
    const waterKeys = new Set(lcols.map(wp => wp.x + ',' + wp.z))
    const targets = []; const seenT = new Set()
    for (const wp of lcols) {
      for (let dx = -RING_MAX; dx <= RING_MAX; dx++) for (let dz = -RING_MAX; dz <= RING_MAX; dz++) {
        const cheb = Math.max(Math.abs(dx), Math.abs(dz))
        if (cheb < 1 || cheb > RING_MAX) continue
        const tx = wp.x + dx; const tz = wp.z + dz; const k = tx + ',' + tz
        if (seenT.has(k) || waterKeys.has(k) || inAvoidBox(avoid, tx, tz)) continue
        seenT.add(k); targets.push({ x: tx, z: tz })
      }
    }
    targets.sort((a, b) => Math.hypot(a.x - site.x, a.z - site.z) - Math.hypot(b.x - site.x, b.z - site.z)) // level contiguously outward from the anchor
    // leveling fills dips + swaps rubble tops with dirt (operator: a flat DIRT floor) - stock a
    // little first (best-effort, bounded) so mid-plot holes don't stay open. levelPlotCell degrades
    // gracefully if the stock-up falls short (a cell it can't make work is skipped, not retried).
    if (countItem(bot, 'dirt') < 16 && !isStopped()) {
      dbg('  wheat farm: stocking a little dirt for leveling (' + countItem(bot, 'dirt') + ' on hand)')
      try { await P().runGather(bot, 'dirt', 32, { isStopped, restoreMovements: () => {}, home: { x: site.x, z: site.z }, avoid }) } catch (e) { dbg('  wheat farm: dirt stock-up failed (' + e.message + ') - leveling with what we have') }
    }
    const LEVEL_BUDGET = Number(process.env.FARM_LEVEL_BUDGET || 48) // cell cap - a bad site can never loop forever
    const LEVEL_MS = Number(process.env.FARM_LEVEL_MS || 60000) // wall-clock cap
    say('leveling the farm plot to one height first - so the crops actually grow')
    const t0 = Date.now(); let leveled = 0; let tried = 0
    for (const t of targets) {
      if (isStopped() || tried >= LEVEL_BUDGET || Date.now() - t0 > LEVEL_MS) break
      tried++
      try { if (await levelPlotCell(bot, t.x, baseY, t.z, { isStopped })) leveled++ } catch {}
    }
    dbg('  wheat farm: leveled ' + leveled + '/' + tried + ' plot cell(s) to baseY ' + baseY + ' (water surface) within ' + RING_MAX + 'b hydration range' + (tried >= LEVEL_BUDGET ? ' [cell budget]' : Date.now() - t0 > LEVEL_MS ? ' [time budget]' : ''))
  }
  const bankBarren = EXPAND ? Object.assign({}, (priorFarm && priorFarm.bankBarren) || {}) : null
  let cands = scanBank(site) // re-reads the now-flat ground -> picks up the leveled cells at dy0 (flat)
  if (EXPAND) {
    const ownedCols = new Set(((m.wheatFarm && m.wheatFarm.cells) || []).map(c => c.x + ',' + c.z))
    cands = cands.filter(c => !ownedCols.has(c.x + ',' + c.z) && (bankBarren[c.x + ',' + c.z] || 0) < 2) // skip owned + struck-out (§4.2)
    cands = farm.orderBankCandidates(cands, site) // grow contiguously outward (§4.2)
  }
  const ring = cands.map(c => c.block)
  // §4.2 barren memo: a till/plant failure on a never-planted column earns strikes so it stops
  // shadowing candidates 13+ forever. Capped at 128 keys (evict oldest by insertion order).
  const addStrike = (colKey, failKind) => {
    if (!EXPAND) return
    bankBarren[colKey] = farm.barrenStep(bankBarren[colKey] || 0, failKind).strikes
    const keys = Object.keys(bankBarren)
    if (keys.length > 128) delete bankBarren[keys[0]]
  }
  dbg('  wheat farm: ' + ring.length + ' bank cell(s) by the water at ' + w.x + ',' + w.z + (EXPAND ? ' (site ' + site.x + ',' + site.z + ')' : ''))
  const plantedCells = [] // EXACT crop-cell coords, persisted so tend reads the real cells
  let attempted = 0
  for (let cell of ring.slice(0, 12)) {
    if (isStopped() || seedCount() < 1) break
    attempted++
    const colKey = cell.position.x + ',' + cell.position.z
    try {
      if (bot.entity.position.distanceTo(cell.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(cell.position.x, cell.position.y, cell.position.z, 2), 12000)
      const veg = bot.blockAt(cell.position.offset(0, 1, 0))
      if (veg && !AIRISH(veg.name)) { try { await bot.dig(veg) } catch {} }
      if (/sand|gravel|clay/.test(cell.name)) { // UNTILLABLE-BANK SWAP: dig it, lay owned dirt, till that
        const dirtItem = (bot.inventory ? bot.inventory.items() : []).find(i => /^dirt$/.test(i.name))
        if (!dirtItem) continue
        try { await bot.dig(cell) } catch { continue }
        if (!await placeAt(bot, cell.position, /^dirt$/)) { dbg('  wheat farm: dirt swap failed at ' + cell.position.toString()); continue }
        const swapped = bot.blockAt(cell.position)
        if (!swapped || !/^(dirt|grass_block)$/.test(swapped.name)) continue
        cell = swapped
      }
      // TILL to farmland - tillCell guarantees the crop cell above is air first (a watered
      // crop cell makes the hoe a silent no-op: the live "till did not take (got dirt)" bug).
      const tr = await tillCell(bot, cell)
      if (tr === 'nohoe') { dbg('  wheat farm: hoe vanished mid-pass - aborting (no strike)'); break } // transient, not a barren column (§4.2)
      if (tr !== 'farmland') { addStrike(colKey, (tr === 'flooded' || tr === 'unfarmable') ? tr : 'other'); dbg('  wheat farm: till did not take at ' + cell.position.toString() + ' (' + tr + ', got ' + ((bot.blockAt(cell.position) || {}).name || '?') + ')'); continue }
      const tilled = bot.blockAt(cell.position)
      const seeds = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'wheat_seeds')
      if (!seeds) break
      await bot.equip(seeds, 'hand')
      const cropPos = cell.position.offset(0, 1, 0)
      try { await bot.placeBlock(tilled, new Vec3(0, 1, 0)) } catch (e) { dbg('  wheat farm: seed place threw (' + e.message + ')') }
      await new Promise(r => setTimeout(r, 200))
      // BLOCK-READ the plant: the OLD bug counted placeBlock() calls, so a silently-failed or
      // instantly-flooded seed still logged "PLANTED" and persisted a phantom farm with 0 wheat
      // (live: 2.5h of `harvested 0`). Only a VERIFIED `wheat` block counts + gets persisted.
      const crop = bot.blockAt(cropPos)
      if (crop && crop.name === 'wheat') {
        planted++
        plantedCells.push({ x: cropPos.x, y: cropPos.y, z: cropPos.z })
        await boneMealBlock(bot, cropPos, 2)
      } else { addStrike(colKey, 'other'); dbg('  wheat farm: seed did NOT take at ' + cropPos.x + ',' + cropPos.y + ',' + cropPos.z + ' (got ' + ((crop && crop.name) || '?') + ') - not counting it') } // +1 strike (§4.2)
    } catch (e) { dbg('  wheat farm: cell failed (' + e.message + ')') }
  }
  const eligibleRemaining = Math.max(0, ring.length - attempted) // §4.3: candidates left untried this pass
  // MERGE with any cells already registered at THIS site (expansion pass) so we grow the plot
  // instead of clobbering it. §4.1: keep prior cells within SITE_RADIUS of the PINNED site anchor
  // (flag off: <=32 around w) - fixes the 2e clobber where a drifting waters[0] silently dropped
  // cells; union with the newly-verified cells, de-duped by coord.
  const priorSame = ((m.wheatFarm && m.wheatFarm.cells) || []).filter(c => Math.hypot(c.x - site.x, c.z - site.z) <= SITE_RADIUS)
  const byKey = new Map()
  for (const c of priorSame) byKey.set(c.x + ',' + c.y + ',' + c.z, { x: c.x, y: c.y, z: c.z })
  for (const c of plantedCells) byKey.set(c.x + ',' + c.y + ',' + c.z, c)
  const merged = [...byKey.values()]
  if (merged.length) {
    // Persist the EXACT crop cells (block-verified above) alongside the PINNED site anchor, so
    // tendWheatFarm reads THESE cells (harvest/replant) instead of blind-scanning for wheat.
    // §4.3 honest maxed: latch only when a pass planted NOTHING and no eligible candidate remains.
    const maxed = farm.expansionMaxed({ expand: EXPAND, planted, eligibleRemaining, cells: merged.length, target: WHEAT_FARM_TARGET })
    m.wheatFarm = { x: site.x, y: site.y, z: site.z, cells: merged, at: Date.now(), maxed }
    if (EXPAND) m.wheatFarm.bankBarren = bankBarren // §4.2 persist the barren-column memo
    saveWorldMem()
    dbg('  wheat farm: ' + planted + ' new cell(s) planted, ' + merged.length + ' total VERIFIED cell(s) at ' + site.x + ',' + site.z + (maxed ? ' (site maxed - ' + eligibleRemaining + ' eligible left)' : ''))
    if (planted) say(`wheat farm ${priorSame.length ? 'expanded' : 'planted'} (${merged.length} cells) - bread incoming`)
    // #56 FARM_TORCH (§C, operator request): light the plot (light>=9 lets wheat grow through the
    // night + suppresses mob spawns so tending is safe). Best-effort AFTER establishment persists -
    // never blocks the farm on missing torches. FARM_TORCH=0 = no torches (today).
    if (TORCH) { try { await placeFarmTorches(bot, merged, { isStopped }) } catch (e) { dbg('  wheat farm: torch pass failed (' + e.message + ')') } }
  } else {
    // §4.6 restore-on-failure: a re-site that persisted 0 cells must never leave the bot farm-less.
    if (resiting && m.wheatFarmOld) { m.wheatFarm = m.wheatFarmOld; delete m.wheatFarmOld; saveWorldMem(); dbg('  wheat farm: re-site built 0 cells - restored the old ' + (m.wheatFarm.cells || []).length + '-cell farm (cooldown stays consumed)') }
    else dbg('  wheat farm: could not plant any cell (none verified as wheat)')
  }
  return merged.length > 0
}

async function replantCropCell (bot, cropPos, { isStopped = () => false } = {}) {
  const seeds = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'wheat_seeds')
  if (!seeds) return false
  const basePos = cropPos.offset(0, -1, 0)
  let base = bot.blockAt(basePos)
  if (!base) return false
  if (bot.entity.position.distanceTo(cropPos) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(cropPos.x, cropPos.y, cropPos.z, 2), 10000) } catch {} }
  // clear anything sitting IN the crop cell (loose veg) so the seed has room
  const occ = bot.blockAt(cropPos)
  if (occ && !AIRISH(occ.name) && REPLACEABLE.test(occ.name)) { try { await bot.dig(occ) } catch {} }
  if (!farm.farmlandReady(base.name)) {
    if (!farm.tillableBank(base.name)) { dbg('  wheat replant: base at ' + basePos.toString() + ' is ' + base.name + ' - cannot till here'); return false }
    if (!(bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))) { dbg('  wheat replant: cell needs tilling but no hoe on hand'); return false }
    // tillCell clears any water in the crop cell first (the silent-no-op till bug), then fires.
    const tr = await tillCell(bot, { position: basePos, name: base.name })
    if (tr !== 'farmland') { dbg('  wheat replant: till did not take at ' + basePos.toString() + ' (' + tr + ')'); return false }
    base = bot.blockAt(basePos)
    if (!base || !farm.farmlandReady(base.name)) return false
  }
  try { await bot.equip(seeds, 'hand'); await bot.placeBlock(base, new Vec3(0, 1, 0)) } catch (e) { dbg('  wheat replant: seed place failed (' + e.message + ')') }
  await new Promise(r => setTimeout(r, 150))
  const crop = bot.blockAt(cropPos)
  return !!(crop && crop.name === 'wheat')
}

async function tendWheatFarm (bot, { isStopped = () => false, say = () => {} } = {}) {
  const m = loadWorldMem()
  if (!m.wheatFarm) return false
  // FARM-DEGRADATION FIX (REDESIGN §4.2/§11): a hoe-less bot can re-till nothing, so trampled/
  // reverted cells stay bare dirt and the plot shrinks ("needs tilling but no hoe on hand" -
  // observed live at food 0 with 53 planks in hand). Ensure a hoe BEFORE tending, reconciled
  // exactly as ensureWheatFarm does (withdraw banked > craft wooden_hoe from planks+sticks >
  // gather wood). Best-effort: if none can be made, tend still harvests ripe wheat + replants
  // intact farmland (no hoe needed there) - only re-tilling a reverted cell defers, as today.
  // FARM_TEND_HOE=0 rolls back to the old bail-on-no-hoe behavior.
  if (process.env.FARM_TEND_HOE !== '0' && !(bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))) {
    try {
      const res = require('./resources.js') // lazy (resources requires provision at load)
      const near = hutAnchor() || { x: m.wheatFarm.x, y: Math.floor(bot.entity.position.y), z: m.wheatFarm.z }
      const rec = await res.reconcile(bot, { wooden_hoe: 1 }, { near, maxAgeMs: 0, planOpts: { primaryWood: P().detectWood(bot) || 'oak' } })
      if (rec.withdraws.length || rec.plan.tasks.length) {
        dbg('  wheat tend: acquiring a hoe to re-till (' + (rec.plan.tasks.map(t => `${t.type}:${t.item || t.output}`).join(' > ') || 'from bank') + ')')
        await res.runReconciled(bot, rec, { isStopped, say, home: near })
      }
    } catch (e) { dbg('  wheat tend: hoe acquisition failed (' + e.message + ') - tending without re-till') }
  }
  const mcData = require('minecraft-data')(bot.version)
  const wheatId = mcData.blocksByName.wheat.id
  await S().walkStaged(bot, m.wheatFarm.x, m.wheatFarm.z, { isStopped, range: 6, timeoutMs: 120000 })
  // TEND-SIDE SEED TOP-UP (FARM_SEED_TOPUP, §5.4): replantCropCell bails seedless, so a seed-
  // starved plot decays. Count the cells that need (re)seeding - 'gone' cells + the under-target
  // shortfall - and if the pack is short, gather from the grass beside the plot BEFORE the
  // harvest/replant loop. A producing farm is seed-self-sufficient; this matters for the
  // seed-starved bootstrap. FARM_SEED_TOPUP=0 skips it (no tend-side gathering, as before).
  if (process.env.FARM_SEED_TOPUP !== '0') {
    try {
      const cellsArr = (m.wheatFarm.cells || [])
      let gone = 0
      for (const c of cellsArr) { const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (farm.cropCellState(b && b.name) === 'gone') gone++ }
      const missing = gone + Math.max(0, WHEAT_FARM_TARGET - cellsArr.length)
      if (missing > 0 && countItem(bot, 'wheat_seeds') < missing) {
        dbg('  wheat tend: seed-starved (' + countItem(bot, 'wheat_seeds') + ' seeds, ' + missing + ' cells need seeding) - ' + (process.env.FARM_SEED_BANK !== '0' ? 'raiding the bank then the grass' : 'gathering from the grass'))
        await gatherSeedsNear(bot, Math.min(missing, 12), { isStopped, near: hutAnchor() || { x: m.wheatFarm.x, z: m.wheatFarm.z }, say })
      }
    } catch (e) { dbg('  wheat tend: seed top-up failed (' + e.message + ')') }
  }
  // AUTHORITATIVE cell list: the exact crop cells persisted at plant time (block-verified).
  // Fall back to a live scan only for a legacy farm saved before cells were persisted, and
  // ALWAYS also fold in any wheat visible nearby (a growing cell not in the list).
  let cells = (m.wheatFarm.cells || []).map(c => new Vec3(c.x, c.y, c.z))
  const seen = new Set(cells.map(c => c.x + ',' + c.y + ',' + c.z))
  // Fold in wheat visible nearby (a growing cell not in the list) - but ONLY wheat that belongs
  // to OUR plot. The bot spawns next to a village wheat field within 16 blocks; the old blanket
  // findBlocks(16) pulled that foreign field in, so tend wandered off-plot to harvest someone
  // else's wheat (drops landing in the village pond, out of reach -> `harvested N, wheat=0`).
  // Own = within 2 blocks (x/z) of a persisted cell, or within 6 of the farm's water anchor.
  const ownCells = (m.wheatFarm.cells || [])
  const anchor = m.wheatFarm
  const isOurs = q => ownCells.some(c => Math.abs(c.x - q.x) <= 2 && Math.abs(c.z - q.z) <= 2) ||
                      Math.hypot(q.x - anchor.x, q.z - anchor.z) <= 6
  for (const p of (bot.findBlocks({ matching: wheatId, maxDistance: 16, count: 24 }) || [])) {
    const k = p.x + ',' + p.y + ',' + p.z
    if (seen.has(k)) continue
    if (ownCells.length && !isOurs(p)) continue // don't wander into a foreign/village field
    seen.add(k); cells.push(new Vec3(p.x, p.y, p.z))
  }
  let harvested = 0; let replanted = 0
  // FARM_RESEED (§4.2): a cell-health ledger that retires cells the field can no longer hold
  // (water-washed / obstructed) so the record stops "standing" dead and the maxed latch can
  // clear -> the existing ensure ring replants fresh ground. All new statements are gated; with
  // FARM_RESEED=0 this is today's path exactly (the cellHealth field, if present, stays inert).
  const RESEED = process.env.FARM_RESEED !== '0'
  const DEAD_PASSES = Number(process.env.FARM_RESEED_DEAD_PASSES || 3)
  const persistedKeys = new Set((m.wheatFarm.cells || []).map(c => c.x + ',' + c.y + ',' + c.z)) // only PERSISTED cells are ledgered/retired - never the foldin scan wheat
  if (RESEED && !m.wheatFarm.cellHealth) m.wheatFarm.cellHealth = {}
  const cellHealth = RESEED ? m.wheatFarm.cellHealth : null
  const retired = [] // keys retired THIS pass
  let cWheat = 0; let cMature = 0; let cGone = 0; let cFlooded = 0; let cBlocked = 0
  for (const p of cells) {
    if (isStopped()) break
    const b = bot.blockAt(p)
    const state = farm.cropCellState(b && b.name)
    let replantOk = null // captured for the 'gone' branch -> cellHealthStep
    if (state === 'wheat') {
      const age = b.getProperties ? b.getProperties().age : null
      if (farm.matureForHarvest(age)) {
        try {
          if (bot.entity.position.distanceTo(p) > 4) await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 10000)
          await bot.dig(b); harvested++
          // STAND ON THE DROP, then collect wider + patiently. A wheat drop from a cell against
          // the pond bounces toward the water edge and takes a beat to settle; walking onto the
          // crop cell (where the wheat stood, on top of the farmland) puts the pickup box over
          // it, and the wider/patient collect grabs one that drifted a block onto land/water.
          // This is the core "harvested N -> wheat=0" fix.
          try { await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 0), 6000) } catch {}
          await collectDrops(bot, 6, { patience: 5 })
          if (await replantCropCell(bot, p, { isStopped })) replanted++ // reseed the cell we just cleared
        } catch (e) { dbg('  wheat harvest failed (' + e.message + ')') }
      } else if (age != null) {
        await boneMealBlock(bot, p, 2) // still growing - speed it up if bones allow
      }
    } else if (state === 'gone') {
      // SELF-HEAL: creeper/trample/failed plant left this cell empty - re-establish it so the
      // farm converges back to full instead of decaying to zero (ensureWheatFarm won't re-run
      // once a farm is registered, so tend is the ONLY repair path).
      replantOk = await replantCropCell(bot, p, { isStopped })
      if (replantOk) replanted++
    } // 'flooded'/'blocked': leave it - not fixable from here (retirement below handles a persistent one)
    // FARM_RESEED: tally + age the health of PERSISTED cells only (foldins aren't in the ledger).
    // #87 DRY_HOME_FARM §B verified: a slow-growing dry cell is a `wheat` block at ANY age (0..7), so
    // cropCellState -> 'wheat' -> cellHealthStep resets deadRuns and NEVER retires it. Only a truly
    // empty/washed/blocked cell ('gone'/'flooded'/'blocked') ages toward retirement - unchanged by dry
    // mode. bankBarren likewise only strikes tilling/planting FAILURES, not a healthy growing crop. No
    // code change needed for dry patience.
    if (RESEED && persistedKeys.has(p.x + ',' + p.y + ',' + p.z)) {
      const key = p.x + ',' + p.y + ',' + p.z
      if (state === 'wheat') { cWheat++; if (farm.matureForHarvest(b.getProperties ? b.getProperties().age : null)) cMature++ } else if (state === 'gone') cGone++
      else if (state === 'flooded') cFlooded++
      else cBlocked++
      const step = farm.cellHealthStep(state, replantOk, cellHealth[key] || 0, DEAD_PASSES)
      if (step.retire) retired.push(key)
      else if (step.deadRuns > 0) cellHealth[key] = step.deadRuns
      else delete cellHealth[key]
    }
  }
  // FARM_RESEED (§4.2): retire the dead cells, un-latch maxed, and reseed while standing here.
  if (RESEED) {
    if (retired.length) {
      const retiredSet = new Set(retired)
      const survivors = (m.wheatFarm.cells || []).filter(c => !retiredSet.has(c.x + ',' + c.y + ',' + c.z))
      m.wheatFarm.cells = survivors
      for (const key of retired) delete cellHealth[key]
      // §4.9 (#28 handshake): FARM_EXPAND on -> a cell #28 retired must not be the widened ring's
      // first re-till candidate (retire->re-till->wash->retire churn). Column key its "x,z" into
      // bankBarren at 2 strikes (out) before the ensure ring re-scans.
      if (process.env.FARM_EXPAND !== '0') {
        m.wheatFarm.bankBarren = m.wheatFarm.bankBarren || {}
        for (const key of retired) { const parts = key.split(','); m.wheatFarm.bankBarren[parts[0] + ',' + parts[2]] = 2 }
      }
      const unlatch = farm.plotShouldUnlatch(retired.length, survivors.length, WHEAT_FARM_TARGET)
      if (unlatch) m.wheatFarm.maxed = false
      saveWorldMem()
      dbg('  farm reseed: retired ' + retired.length + ' dead cell(s), ' + survivors.length + ' live remain' + (unlatch ? ', maxed cleared' : ''))
    }
    dbg('  farm health: wheat=' + cWheat + '(mature ' + cMature + ') gone=' + cGone + ' flooded=' + cFlooded + ' blocked=' + cBlocked + ' retired-total=' + retired.length)
    // Immediate reseed while standing at the pond: retirement freed the maxed latch, so let the
    // EXISTING ensure ring till+plant fresh cells with the seeds on hand (bounded, block-verified;
    // water is within 48 by construction so no trek in the normal case). One attempt per pass;
    // if ensure defers (night/hostiles/no bank) the durable un-latched maxed lets later callers retry.
    if (retired.length && !m.wheatFarm.maxed && !isStopped() && countItem(bot, 'wheat_seeds') > 0) {
      try { await ensureWheatFarm(bot, { x: m.wheatFarm.x, z: m.wheatFarm.z }, { isStopped, say }) } catch (e) { dbg('  farm reseed: inline ensure failed (' + e.message + ')') }
    }
  }
  // FIX #38: WHOLE-PLOT collect sweep. A big plot (live: 22 cells at 446,31) spans past radius 6,
  // so the old fixed-6 sweep left drops at far cells on the ground ("harvested 8 -> wheat=1"). Center
  // on the plot (the water anchor) and collect out to a radius that covers its bounding box, so every
  // cell's drop is in range. Bounded: one sweep, radius capped (farm.plotCollectRadius). Off-plot
  // drops stay out via the cap. FARM_COLLECT_PLOT=0 restores today's radius-6 sweep.
  if (harvested) {
    if (process.env.FARM_COLLECT_PLOT !== '0') {
      const pcells = m.wheatFarm.cells || []
      const rad = farm.plotCollectRadius(pcells, { x: m.wheatFarm.x, z: m.wheatFarm.z })
      const cy = (pcells[0] && pcells[0].y) || Math.floor(bot.entity.position.y)
      try { await gotoWithTimeout(bot, new goals.GoalNear(m.wheatFarm.x, cy, m.wheatFarm.z, 2), 12000) } catch {}
      await collectDrops(bot, rad, { patience: 3 })
    } else {
      await collectDrops(bot, 6, { patience: 3 }) // legacy: tight radius sweep at the current spot
    }
  }
  const wheatN = countItem(bot, 'wheat')
  if (wheatN >= 3) { try { const made = await P().runCraft(bot, 'bread', Math.floor(wheatN / 3), true, { isStopped }); say('baked ' + made + ' bread - crisis over'); dbg('  baked ' + made + ' bread') } catch (e) { dbg('  bread craft failed (' + e.message + ')') } }
  dbg('  wheat farm tended: harvested ' + harvested + ', replanted ' + replanted + ', wheat=' + countItem(bot, 'wheat') + ', bread=' + countItem(bot, 'bread'))
  return harvested > 0 || replanted > 0 || countItem(bot, 'bread') > 0
}

function hasStandingFarm () { const wf = loadWorldMem().wheatFarm; return !!(wf && wf.cells && wf.cells.length > 0) }

function saplingFor (logItem) { return logItem.replace(/_log$/, '_sapling') }

function saplingCount (bot, logItem) { return (bot.inventory ? bot.inventory.items() : []).filter(i => i.name === saplingFor(logItem)).reduce((s, i) => s + i.count, 0) }

async function plantSaplingNear (bot, around, logItem, opts = {}) {
  const sap = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === saplingFor(logItem))
  if (!sap) return false
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -3; dy <= 1; dy++) {
    const gp = new Vec3(Math.floor(around.x) + dx, Math.floor(around.y) + dy, Math.floor(around.z) + dz)
    if (inAvoidBox(opts.avoid, gp.x, gp.z)) continue // a tree here would grow into the build
    try { const pf = require('./pathfix.js'); if (pf.isSelfPlaced && pf.isSelfPlaced(gp)) continue } catch {} // own scaffold dirt is NOT ground (sapling on the tower, live)
    if (scaffold.isScaffold(gp)) continue // registry outlives the 30-min trail (6h) - old towers aren't ground either
    const ground = bot.blockAt(gp); const above = bot.blockAt(gp.offset(0, 1, 0))
    if (!ground || !PLANTABLE_GROUND.test(ground.name) || !above || !AIRISH(above.name)) continue
    if (bot.entity.position.distanceTo(gp) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(gp.x, gp.y, gp.z, 2), 10000) } catch { continue } }
    try {
      await bot.equip(sap, 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
      dbg('  replanted ' + saplingFor(logItem) + ' at ' + gp.offset(0, 1, 0).toString())
      clearSearched(logItem, gp) // roomba rule: planting here makes this cell worth revisiting
      rememberSpot(logItem, gp)  // ...and puts it back on the map as a future wood source
      await boneMealSapling(bot, gp.offset(0, 1, 0)) // bones -> bone meal -> instant tree (why we KEEP bones)
      return true
    } catch (e) { dbg('  replant failed at ' + gp.toString() + ' (' + e.message + ')') }
  }
  return false
}

async function boneMealSapling (bot, sapPos) {
  const mcData = require('minecraft-data')(bot.version)
  const items = () => bot.inventory ? bot.inventory.items() : []
  for (let uses = 0; uses < 6; uses++) {
    const sapBlock = bot.blockAt(sapPos)
    if (!sapBlock || !/_sapling$/.test(sapBlock.name)) return uses > 0 // grew (or gone)
    let meal = items().find(i => i.name === 'bone_meal')
    if (!meal) {
      const bone = items().find(i => i.name === 'bone')
      if (!bone) return false
      try {
        const recipe = bot.recipesFor(mcData.itemsByName.bone_meal.id, null, 1, null)[0]
        if (!recipe) return false
        await bot.craft(recipe, 1, null)
        meal = items().find(i => i.name === 'bone_meal')
      } catch (e) { dbg('  bone meal craft failed (' + e.message + ')'); return false }
      if (!meal) return false
    }
    try {
      await bot.equip(meal, 'hand')
      await bot.activateBlock(sapBlock)
      await new Promise(r => setTimeout(r, 350))
    } catch (e) { dbg('  bone-mealing failed (' + e.message + ')'); return false }
  }
  return !/_sapling$/.test((bot.blockAt(sapPos) || {}).name || '')
}

async function fishSaplings (bot, around, logItem, { isStopped = () => false } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const leaf = mcData.blocksByName[logItem.replace(/_log$/, '_leaves')]
  if (!leaf) return
  let broken = 0
  while (broken < 16 && !isStopped() && saplingCount(bot, logItem) < 4) { // fish harder: the orchard wants stock
    const b = bot.findBlock({ matching: leaf.id, maxDistance: 4 })
    if (!b || !canBreakNaturally(b)) break
    try { await bot.dig(b) } catch { break }
    broken++
  }
  if (broken) { await collectDrops(bot, 6); dbg('  leaf-fished ' + broken + ' leaves -> ' + saplingCount(bot, logItem) + ' saplings') }
}

async function prepOrchardCell (bot, cx, baseY, cz, { isStopped = () => false } = {}) {
  // find ground: first solid block scanning down from a bit above plot level
  let ground = null
  for (let y = baseY + 3; y >= baseY - 3; y--) {
    const b = bot.blockAt(new Vec3(cx, y, cz))
    const a = bot.blockAt(new Vec3(cx, y + 1, cz))
    if (b && b.boundingBox === 'block' && a && REPLACEABLE.test(a.name)) { ground = b; break }
  }
  if (!ground) return null
  // OPEN SKY, CLEAR COLUMN (operator rule: no caves, no obstructions): a sapling under a
  // cave ceiling or overhang never grows into a usable tree. The full growing column must
  // be free of solid blocks - vegetation gets cleared below, neighbour-crown leaves are OK.
  for (let dy = 1; dy <= 14; dy++) {
    const b = bot.blockAt(ground.position.offset(0, dy, 0))
    if (!b) break // above loaded height - open enough
    if (!AIRISH(b.name) && !/grass|fern|flower|dead_bush|snow|vine|_leaves$|_sapling$/.test(b.name)) return null
  }
  if (bot.entity.position.distanceTo(ground.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(cx, ground.position.y, cz, 3), 15000) } catch { return null } }
  // clear vegetation/soft cover above the cell (never crafted blocks)
  for (let dy = 1; dy <= 2 && !isStopped(); dy++) {
    const b = bot.blockAt(ground.position.offset(0, dy, 0))
    if (b && !AIRISH(b.name) && /grass|fern|flower|dead_bush|snow|vine|_leaves$/.test(b.name)) { try { await bot.dig(b) } catch {} }
  }
  // shave a bump: ground sticking up past plot level gets cut down (natural blocks only,
  // plus loose cobble - pathfinder bridging litters plots with scaffold cobblestone that
  // "natural-only" could never remove, operator review)
  let guard = 3
  while (ground.position.y > baseY && guard-- > 0 && !isStopped()) {
    const shaveable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (!shaveable || (bot.canDigBlock && !bot.canDigBlock(ground))) break
    const tool = toolForBlock(bot, ground.name) // stone shaved wrong-tool drops nothing
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(ground); await collectDrops(bot, 3) } catch { break }
    const nb = bot.blockAt(new Vec3(cx, ground.position.y - 1, cz))
    if (!nb || nb.boundingBox !== 'block') break
    ground = nb
  }
  // fill a shallow dip with dirt so the row stays level
  if (ground.position.y < baseY - 1) {
    if (await placeAt(bot, ground.position.offset(0, 1, 0), /^(dirt|grass_block)$/)) {
      const nb = bot.blockAt(ground.position.offset(0, 1, 0)); if (nb && nb.boundingBox === 'block') ground = nb
    }
  }
  // saplings need soil - top stone/sand with a dirt block if we carry one
  if (!PLANTABLE_GROUND.test(ground.name)) {
    if (!await placeAt(bot, ground.position.offset(0, 1, 0), /^dirt$/)) return null
    const nb = bot.blockAt(ground.position.offset(0, 1, 0))
    if (!nb || !PLANTABLE_GROUND.test(nb.name)) return null
    ground = nb
  }
  return ground
}

async function plantGrove (bot, home, logItem, { isStopped = () => false, say = () => {}, avoid = null, max = 8 } = {}) {
  if (saplingCount(bot, logItem) < 1) return 0
  // anchor shifted +24 south of the original (pre-leveling) plot: the operator ordered
  // the messy first orchard torn down and future ones built on cleanly prepared ground
  const gx = Math.floor(avoid ? avoid.x2 + 8 : home.x + 18); const gz = Math.floor(home.z) + 24
  await S().walkStaged(bot, gx, gz, { isStopped, range: 6, timeoutMs: 90000 })
  if (isStopped()) return 0
  const baseY = Math.floor(bot.entity.position.y) - 1 // plot level = the ground we stand on
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(max))))
  // FLATTEN THE WHOLE PLOT first - lanes included (operator review: the per-cell-only
  // prep left "very uneven terrain, not a clean flat area"). Bounded: corrective work
  // is capped, flat cells cost one block-read each.
  {
    const w = cols * 5; const h = 4 * 5
    let ops = 0
    // STOCK DIRT first (operator order: flat DIRT floor): hole-fills and rubble-top
    // swaps both eat dirt, and running dry mid-plot left holes. Dirt digs fast anywhere.
    if (countItem(bot, 'dirt') < 48 && !isStopped()) {
      dbg('  orchard: stocking dirt for the leveling (' + countItem(bot, 'dirt') + ' on hand)')
      try { await P().runGather(bot, 'dirt', 64, { isStopped, restoreMovements: () => {}, home: { x: gx, z: gz }, avoid }) } catch (e) { dbg('  orchard: dirt stock-up failed (' + e.message + ') - leveling with what we have') }
    }
    say('leveling the orchard plot first')
    // MULTI-PASS until actually flat (operator review: one 60-cell pass left "holes and
    // a little bit of hill"). Each pass shaves deeper and fills another layer, so bumps
    // and dips CONVERGE; stop when a full sweep corrects nothing or the budget is spent.
    for (let pass = 0; pass < 4 && !isStopped() && ops < 240; pass++) {
      let fixed = 0
      outerLevel:
      for (let dz = -1; dz <= h && !isStopped(); dz++) {
        for (let dx = -1; dx <= w; dx++) {
          const cx = gx + dx; const cz = gz + dz
          if (inAvoidBox(avoid, cx, cz)) continue
          const g0 = bot.blockAt(new Vec3(cx, baseY, cz))
          const a0 = bot.blockAt(new Vec3(cx, baseY + 1, cz))
          if (g0 && g0.boundingBox === 'block' && a0 && AIRISH(a0.name)) continue // flat already - free
          try { if (await levelPlotCell(bot, cx, baseY, cz, { isStopped })) { ops++; fixed++ } } catch {}
          if (ops >= 240) { dbg('  orchard: leveling budget spent (' + ops + ' cells corrected) - planting on what we have'); break outerLevel }
        }
      }
      if (!fixed) break // converged: the whole sweep found nothing to correct
    }
    dbg('  orchard: plot leveled (' + ops + ' cells corrected)')
  }
  const sap = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === saplingFor(logItem))
  const LW = process.env.LOCAL_WOOD !== '0'
  const cells = [] // LOCAL_WOOD: per-tree state - only cells where a sapling was VERIFIED placed
  let planted = 0
  for (let r = 0; r < 4 && planted < max && !isStopped(); r++) {
    for (let c = 0; c < cols && planted < max && !isStopped(); c++) {
      if (!sap()) break
      const cx = gx + c * 5; const cz = gz + r * 5 // 5-block lanes: walkable + crowns don't merge
      if (inAvoidBox(avoid, cx, cz)) continue
      const ground = await prepOrchardCell(bot, cx, baseY, cz, { isStopped })
      if (!ground) { dbg('  orchard: cell ' + cx + ',' + cz + ' unusable - skipping'); continue }
      try {
        await bot.equip(sap(), 'hand')
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        planted++
        clearSearched(logItem, ground.position)
        // VERIFY a sapling actually sits there before we mark this tree planted (the #50
        // latch-bug pattern: never record state on faith). This runs BEFORE bone-mealing,
        // so the block is still a sapling when we check it.
        const sapPos = ground.position.offset(0, 1, 0)
        const pb = bot.blockAt(sapPos)
        if (pb && /_sapling$/.test(pb.name)) cells.push({ x: cx, y: sapPos.y, z: cz })
        dbg('  orchard: planted ' + saplingFor(logItem) + ' at ' + cx + ',' + (ground.position.y + 1) + ',' + cz + ' (' + planted + '/' + max + ')')
        await boneMealSapling(bot, sapPos)
      } catch (e) { dbg('  orchard: plant failed at ' + cx + ',' + cz + ' (' + e.message + ')') }
    }
  }
  if (planted) {
    // dedup: one orchard per site per growth cycle. Growth fields (planted/harvestReadyAt) let
    // the gather loop treat the grove as a RENEWABLE first-stop once it has had time to mature.
    const GROW_MS = parseInt(process.env.ORCHARD_GROW_MS || String(10 * 60000), 10)
    // LOCAL_WOOD: record `planted` as the VERIFIED sapling count and persist per-tree cells
    // so revisits CONVERGE (harvest/top-up the real trees, don't re-derive the plot blindly).
    // LW off -> the object shape is byte-for-byte today's { x, z, at, planted, harvestReadyAt }.
    const m = loadWorldMem()
    m.orchard = { x: gx, z: gz, at: Date.now(), planted: LW ? cells.length : planted, harvestReadyAt: Date.now() + GROW_MS }
    if (LW) m.orchard.cells = cells
    saveWorldMem()
    rememberSpot(logItem, new Vec3(gx + 5, baseY, gz + 5), { orchard: true }) // the plot is a renewable wood source now (never hard-deleted)
    // a torch in the plot: saplings keep growing through the night and mobs stay out
    try { await placeAt(bot, new Vec3(gx + 2, baseY + 1, gz + 2), /^torch$/) } catch {}
    say(`planted a ${planted}-tree orchard by the site - rows are straight, come have a look`)
    dbg('  orchard: ' + planted + ' planted in a ' + cols + '-wide grid at ' + gx + ',' + gz)
  }
  return planted
}

module.exports = {
  setDebugSink,
  PLANTABLE_GROUND, WHEAT_FARM_TARGET, farmFootprintHas, cropExclusionStep, cropPlaceExclusion, inAvoidBox, boneMealBlock, tillCell, withdrawSeedsFromBank, gatherSeedsNear, placeFarmTorches, levelPlotCell, ensureWheatFarm, replantCropCell, tendWheatFarm, hasStandingFarm, saplingFor, saplingCount, plantSaplingNear, boneMealSapling, fishSaplings, prepOrchardCell, plantGrove
}
