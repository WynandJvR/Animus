'use strict'
// FOOD: keeping the bot fed. Eating what it carries, cooking, baking bread from the farm,
// fishing, hunting, gathering leather, and the escalating secureFood chain that runs when
// it is genuinely starving. Split out of provision.js unchanged.
//
// food.js holds the PURE decisions - food tiers, when a supply is worth building, the
// in-loop trigger. This is the executor that actually goes and gets fed.
//
// The secureFood chain is the survival core: eat pack -> withdraw bank -> cook -> hunt ->
// farm -> fish -> scout -> bounded hold. Each rung is bounded and names the wake condition
// for the next, which is what stops the hp1/food0 deadlocks this file exists to break. That
// ordering is load-bearing - it was tuned against real starvation loops - so it moved
// verbatim.
//
// Upward calls (walkStaged, boundedHold, explore, runCraft, runSmeltSingle, scoutForWater,
// gatherMovements, inWaterNow) resolve at CALL time through P()/S().

const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const foodSec = require('./food.js')   // PURE food-security decisions
const farm = require('./farm.js')      // PURE wheat geometry + crop state
const navigate = require('./navigate.js')
const provCore = require('./provision-core.js')
const { AIRISH, REPLACEABLE, canBreakNaturally, countItem, inventoryCounts, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt, nearHostile, isNight } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, saveWorldMem, listInfra, rememberInfra, recallInfra, rememberSpot,
  recallSpot, forgetSpot, markSearched, isSearchedDry, clearSearched,
  forgetInfra, recallInfraVerified, knownBed } = worldMemory
const provHut = require('./provision-hut.js')
const { hutAnchor, insideOwnStructure, hasSolidCeiling } = provHut
const provFarm = require('./provision-farm.js')
const { hasStandingFarm, tendWheatFarm, ensureWheatFarm, WHEAT_FARM_TARGET } = provFarm
const provShelter = require('./provision-shelter.js') // inWaterNow: don't fish from inside the pond
const { inWaterNow } = provShelter
const provBank = require('./provision-bank.js')
const { resolveBankCell, isBankStand, bankStandFor, chestCounts, withdrawItem, depositMaterials } = provBank

const P = () => require('./provision.js')
const S = () => require('./provision.js').__siblings
const touchP = tag => { try { require('./commands.js').touchProgress(tag) } catch {} }

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const RAW_COOKABLE = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon'
}

const FOOD_ANIMALS = /^(cow|mooshroom|pig|chicken|sheep|rabbit)$/

const LEATHER_ANIMALS = /^(cow|mooshroom)$/

const RISKY_EAT = /^(rotten_flesh|chicken|spider_eye|poisonous_potato|pufferfish)$/

const ROD_SPIDERS = /^(spider|cave_spider)$/

const DFOOD_DEEP = () => Number(process.env.DFOOD_DEEP_DEPTH || 8)   // >= this far below surface = "in a mine"

const DFOOD_FAR = () => Number(process.env.DFOOD_FAR_DIST || 48)     // > this from home = an excursion buffer

let _foodPlanHint = null

let _securingFood = false

let _foodFloorNoProgress = 0

function _foodFloorState () { return _foodFloorNoProgress }

function hasFood (bot) {
  const md = require('minecraft-data')(bot.version)
  const foods = (md && md.foodsByName) || {}
  return (bot.inventory ? bot.inventory.items() : []).some(i => foods[i.name])
}

function foodCount (bot) {
  const md = require('minecraft-data')(bot.version)
  const foods = (md && md.foodsByName) || {}
  return (bot.inventory ? bot.inventory.items() : []).reduce((n, i) => n + (foods[i.name] ? i.count : 0), 0)
}

function needsFood (bot) { return bot.food != null && bot.food <= 6 && !hasFood(bot) }

function nearestFoodAnimal (bot, maxDist = 40) {
  const me = bot.entity && bot.entity.position
  if (!me) return null
  let best = null; let bd = maxDist
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
    if (!FOOD_ANIMALS.test((e.name || '').toLowerCase())) continue
    const d = e.position.distanceTo(me); if (d < bd) { bd = d; best = { name: e.name, dist: d } }
  }
  return best
}

async function eatFromPackToComfortable (bot, isStopped = () => false) {
  try { if (bot.food != null && bot.food < 18 && Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped }) } catch {}
  try { await eatUp(bot) } catch {}
}

async function eatBestFood (bot) {
  if (bot.food != null && bot.food >= 20) return 'not hungry'
  const mcData = require('minecraft-data')(bot.version)
  const foods = (mcData && mcData.foodsByName) || {}
  const items = bot.inventory ? bot.inventory.items() : []
  const edible = items.filter(i => foods[i.name]).sort((a, b) => {
    const risk = (RISKY_EAT.test(a.name) ? 1 : 0) - (RISKY_EAT.test(b.name) ? 1 : 0)
    if (risk) return risk
    return (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0)
  })
  if (!edible.length) return 'no food in inventory'
  const food = edible[0]
  if (RISKY_EAT.test(food.name) && bot.food > 6 && !((bot.health ?? 20) <= 8 && bot.food < 18)) return 'only risky food left - holding out'
  await bot.equip(food, 'hand')
  await bot.consume()
  return `ate ${food.name} (food ${bot.food})`
}

async function eatUp (bot) {
  for (let i = 0; i < 6; i++) {
    if (bot.food == null || bot.food >= 18) return
    const r = await eatBestFood(bot).catch(() => 'err')
    if (!/^ate /.test(r)) return
  }
}

async function bakeBreadFromWheat (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const home = opts.home || null
  try {
    let wheatN = countItem(bot, 'wheat')
    // BREAD_ENGINE (default on): withdraw enough banked wheat to top the banked reserve up to
    // target (bounded to 33 wheat / 11 loaves per call), not a fixed 3. Reads the bank via the
    // cheap cachedOnly home-food pattern (never walks). BREAD_ENGINE=0 restores the old `3 - wheatN`.
    if (process.env.BREAD_ENGINE !== '0') {
      let bankWheat = 0, bankFoodPts = 0
      try {
        const t = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: home, maxDist: 64 })
        const mdB = require('minecraft-data')(bot.version); const foodsB = (mdB && mdB.foodsByName) || {}
        bankWheat = t.wheat || 0
        for (const [n, c] of Object.entries(t)) if (foodsB[n]) bankFoodPts += (foodsB[n].foodPoints || 0) * c
      } catch (e) { dbg('  bakeBread: bank read failed (' + e.message + ')') }
      const bankTargetPts = Number(process.env.MAINT_BANKFOOD_TARGET || Number(process.env.BREAD_BANK_TARGET || 80))
      const want = foodSec.wheatWithdrawForBake({ packWheat: wheatN, bankWheat, bankFoodPts, bankTargetPts })
      if (want > 0) {
        try { await require('./resources.js').withdrawItems(bot, 'wheat', want, { near: home, maxDist: 64 }) } catch (e) { dbg('  bakeBread: wheat withdraw failed (' + e.message + ')') }
        wheatN = countItem(bot, 'wheat')
      }
    } else if (wheatN < 3) {
      try { await require('./resources.js').withdrawItems(bot, 'wheat', 3 - wheatN, { near: home, maxDist: 64 }) } catch (e) { dbg('  bakeBread: wheat withdraw failed (' + e.message + ')') }
      wheatN = countItem(bot, 'wheat')
    }
    const loaves = foodSec.breadFromWheat(wheatN)
    if (loaves < 1) { dbg('  bakeBread: only ' + wheatN + ' wheat on hand - need 3 for a loaf'); return 0 }
    const made = await P().runCraft(bot, 'bread', loaves, true, { isStopped, home })
    dbg('  bakeBread: baked ' + made + ' bread from ' + wheatN + ' wheat')
    return made
  } catch (e) { dbg('  bakeBread: skipped (' + e.message + ')'); return 0 }
}

async function cookRawMeat (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const raw = Object.keys(RAW_COOKABLE).filter(n => countItem(bot, n) > 0)
  if (!raw.length) return 0
  const furnaceId = mcData.blocksByName.furnace.id
  let blk = bot.findBlock({ matching: furnaceId, maxDistance: 12 })
  if (!blk) {
    // the camp furnace lives in the hut now - worth a short walk (operator: "now that
    // it has a furnace why is it eating raw food?"); cooked feeds ~3x raw.
    const known = recallInfraVerified(bot, 'furnace', bot.entity.position, hutAnchor() ? 48 : 32) // §8: the farm sits ~76b out; 48 walks a far cook pass home to the hut furnace (which also sets up the courier bank visit)
    if (known) {
      try { await gotoWithTimeout(bot, new goals.GoalNear(known.x, known.y, known.z, 2), 30000) } catch {}
      blk = bot.findBlock({ matching: furnaceId, maxDistance: 6 })
    }
  }
  if (!blk) return 0
  const hasFuel = (bot.inventory ? bot.inventory.items() : []).some(i =>
    i.name === 'coal' || i.name === 'charcoal' || i.name === 'coal_block' || /_planks$/.test(i.name))
  if (!hasFuel) return 0
  if (bot.entity.position.distanceTo(blk.position) > 2.5) {
    try { await gotoWithTimeout(bot, new goals.GoalNear(blk.position.x, blk.position.y, blk.position.z, 2), 15000) } catch { return 0 }
  }
  let cooked = 0
  dbg('cookRawMeat:', raw.map(n => countItem(bot, n) + 'x ' + n).join(', '))
  for (const name of raw.slice(0, 2)) { // bound the detour
    if (isStopped()) break
    const n = countItem(bot, name)
    // runSmeltSingle throws on a shortfall (e.g. fuel ran out mid-cook) - whatever DID
    // cook was already drained into the pack, so a partial pass is fine.
    try { cooked += await S().runSmeltSingle(bot, RAW_COOKABLE[name], name, n, opts) } catch { break }
  }
  return cooked
}

function fishingEnabled () { return foodSec.shouldFish(process.env) }

async function ensureFishingRod (bot, { isStopped = () => false, home } = {}) {
  const has = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'fishing_rod')
  if (has()) return true
  // FOOD_FLOOR F2: guarantee the rod. A naked post-death bot has 0 string (can't craft), so the
  // #40-maintained bank reserve (F3 tops it up) is the reliable source - WITHDRAW the reserved rod
  // before falling back to a craft. Bounded chest read (<=64b); a dry bank falls through to craft.
  // FOOD_FLOOR=0 -> skip straight to today's string/craft path (byte-for-byte).
  if (process.env.FOOD_FLOOR !== '0') {
    try { await require('./resources.js').withdrawItems(bot, 'fishing_rod', 1, { near: home, maxDist: 64 }) } catch (e) { dbg('  fishing: rod bank-withdraw failed (' + e.message + ')') }
    if (has()) { dbg('  fishing: withdrew a fishing_rod from the bank reserve'); return true }
  }
  // B-slice-1 (PLANNER_FOOD, default on): route the rod through the reconcile PLANNER (resources.acquire)
  // so it WITHDRAWS the string + sticks sitting in the BANK and crafts a rod. The hand path below only
  // ever read PACK string, so the bot starved with 3 string in its own chest. acquire recurses the
  // recipe (rod->string+sticks) against pack+bank holdings and crafts, and REFUSES to wander off and
  // gather (safe to run at a food crisis). reconcile structurally can't obtain string from the WORLD
  // (not gatherable), so a truly dry bank falls through to the spider hunt below. PLANNER_FOOD=0 ->
  // skip this block (today's hand string-check path, byte-for-byte).
  if (process.env.PLANNER_FOOD !== '0') {
    try {
      const res = require('./resources.js')
      if (await res.acquire(bot, 'fishing_rod', 1, { near: home, isStopped, say: m => dbg('  ' + m) }) && has()) {
        dbg('  fishing: got a rod via the planner (bank string -> craft)'); return true
      }
    } catch (e) { dbg('  fishing: planner rod acquire failed (' + e.message + ')') }
  }
  const inv = inventoryCounts(bot)
  let stringN = inv.string || 0
  // ROD_SUPPLY (M2): before deferring on <2 string, make the craft REACHABLE - a rod-less,
  // string-short bot finishes off a NEARBY spider for its string (bounded ONE pass; no-op if none
  // near), then re-reads. The F2 bank-withdraw already ran above (dry, or FOOD_FLOOR=0), so
  // bankRods=0 here. Still short -> today's honest defer. Flag off => byte-for-byte (no hunt/re-read).
  if (process.env.ROD_SUPPLY === '1' && foodSec.needStringForRod({ hasRod: false, packString: stringN, bankRods: 0 })) {
    dbg('  fishing: no rod + ' + stringN + ' string - one bounded spider-string hunt')
    try { await huntSpiderForString(bot, { isStopped }) } catch (e) { dbg('  fishing: spider-string hunt failed (' + e.message + ')') }
    stringN = inventoryCounts(bot).string || 0
  }
  if (stringN < 2) { dbg('  fishing: no rod and only ' + stringN + ' string - deferred'); return false }
  try { await P().runCraft(bot, 'fishing_rod', 1, true, { isStopped, home }) } catch (e) { dbg('  fishing: rod craft failed (' + e.message + ')'); return false }
  return !!has()
}

async function fishForFood (bot, { isStopped = () => false, say = () => {}, target = 6, home, scout = false, scoutRings } = {}) {
  // #61: the belt-and-suspenders gate at the machinery ENTRY - covers EVERY caller (incl. the manual
  // `!fish` command in commands.js) without touching them. Skip cleanly (return false, like "no
  // water") so callers fall through to their next food option. FISHING_ENABLED=1 -> pass through.
  if (!fishingEnabled()) { dbg('  fishing: disabled (0 catches on this version) - skipping (set FISHING_ENABLED=1 to re-enable)'); return false }
  if (hasSolidCeiling(bot, 12)) { dbg('  fishing: underground - not here'); return false }
  const mcData = require('minecraft-data')(bot.version)
  const edible = () => (bot.inventory ? bot.inventory.items() : []).filter(i => mcData.foodsByName && mcData.foodsByName[i.name] && !/rotten|spider_eye|poisonous/.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (!await ensureFishingRod(bot, { isStopped, home })) return false
  const waterId = mcData.blocksByName.water.id
  const findWaters = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 }) || []) // sample WIDE: the nearest N blocks of a lake are all submerged and fail the air-above filter
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
  let waters = findWaters()
  if (!waters.length) {
    // no water in sight - a REMEMBERED pond first (shared with the wheat farm), then, in a
    // real famine (opts.scout), a bounded scout for one. Water is the guaranteed food path.
    const known = recallInfra('water', bot.entity.position, 160)
    if (known && !isStopped()) {
      dbg('  fishing: walking to remembered water at ' + known.x + ',' + known.z)
      try { await S().walkStaged(bot, known.x, known.z, { isStopped, range: 6, timeoutMs: 120000 }) } catch {}
      waters = findWaters()
    }
    if (!waters.length && scout && !isStopped()) waters = await P().scoutForWater(bot, { isStopped, rings: scoutRings })
  }
  if (!waters.length) { dbg('  fishing: no surface water within 48' + (scout ? ' (scout came up dry too)' : '')); return false }
  // #52 FISH_FROM_BANK (default on): fish standing on a DRY SOLID BANK at the water's edge - never IN
  // the deep water (the pond drownings: GoalNear(water,3) is satisfied standing submerged). Iterate
  // candidate waters nearest-first; for each, walk to a verified-dry adjacent bank stand and cast from
  // there. FISH_FROM_BANK=0 -> the original waters[0] + GoalNear(water,3) path, byte-for-byte.
  let w
  if (process.env.FISH_FROM_BANK !== '0') {
    const nav = require('./navigate.js')
    let stood = false
    for (const cw of waters.slice(0, 8)) {
      if (isStopped()) return false
      const stand = bankStandFor(bot, cw)
      if (!stand) continue
      try { await nav.navigateTo(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 20000, deadlineMs: 40000, budgets: { water: 0, pit: 0, door: 1, nudge: 1, stepout: 1 }, label: 'fish-stand' }) } catch {}
      if (isStopped()) return false
      if (inWaterNow(bot)) { dbg('  fishing: arrived wet at the ' + cw.x + ',' + cw.z + ' bank - trying the next water'); continue }
      w = cw; stood = true; break // standing DRY on the bank - cast at this water
    }
    if (!stood) { dbg('  fishing: no dry bank at any nearby water - skipping (won\'t fish from in the water)'); return false }
    rememberInfra('water', { x: w.x, y: w.y, z: w.z }) // the farm + future famines trek straight back
  } else {
    w = waters[0]
    rememberInfra('water', { x: w.x, y: w.y, z: w.z }) // the farm + future famines trek straight back
    try { await gotoWithTimeout(bot, new goals.GoalNear(w.x, w.y + 1, w.z, 3), 45000) } catch {}
  }
  if (isStopped()) return false
  say('nothing to hunt around here - fishing for dinner instead')
  dbg('  fishing at the water near ' + w.x + ',' + w.z + ' (edible now: ' + edible() + ', target ' + target + ')')
  const deadline = Date.now() + 240000 // a real session, not forever
  let catches = 0
  while (edible() < target && Date.now() < deadline && !isStopped()) {
    if (nearHostile(bot, 12)) { dbg('  fishing: hostile closing - reeling out'); break }
    const rod = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'fishing_rod')
    if (!rod) break // rod broke
    try { await bot.equip(rod, 'hand') } catch { break }
    try { await bot.lookAt(new Vec3(w.x + 0.5, w.y, w.z + 0.5), true) } catch {}
    try {
      await Promise.race([bot.fish(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('cast timeout')), 45000))])
      catches++
    } catch (e) {
      try { bot.activateItem() } catch {} // reel a dangling line back in
      dbg('  fishing: cast failed (' + e.message + ')')
      await new Promise(r => setTimeout(r, 1500))
    }
    await collectDrops(bot, 4)
  }
  dbg('  fishing done: ' + catches + ' catches, edible=' + edible())
  if (catches > 0) say(`caught ${catches} fish - that'll do`)
  return edible() > 0
}

async function huntForFood (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (!bot.entity) return false
  let tgt = null; let best = opts.range || 24
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
    if (!FOOD_ANIMALS.test((e.name || '').toLowerCase())) continue
    const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
  }
  if (!tgt) return false
  const items = bot.inventory ? bot.inventory.items() : []
  const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
  if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
  const killStart = Date.now()
  try {
    bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 2), true)
    while (tgt.isValid && Date.now() - killStart < 12000 && !isStopped()) {
      if (bot.entity.position.distanceTo(tgt.position) <= 3.5) {
        await bot.lookAt(tgt.position.offset(0, (tgt.height || 1) * 0.7, 0)).catch(() => {})
        bot.attack(tgt)
        await new Promise(r => setTimeout(r, 600))
      } else { await new Promise(r => setTimeout(r, 300)) }
    }
  } finally { bot.pathfinder.setGoal(null) }
  await collectDrops(bot, 8)
  return !tgt.isValid
}

async function huntSpiderForString (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (!bot.entity) return false
  let tgt = null; let best = opts.range || Number(process.env.ROD_SPIDER_RANGE || 16)
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
    if (!ROD_SPIDERS.test((e.name || '').toLowerCase())) continue
    const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
  }
  if (!tgt) return false
  const items = bot.inventory ? bot.inventory.items() : []
  const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
  if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
  const killStart = Date.now()
  try {
    bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 2), true)
    while (tgt.isValid && Date.now() - killStart < 12000 && !isStopped()) {
      if (bot.entity.position.distanceTo(tgt.position) <= 3.5) {
        await bot.lookAt(tgt.position.offset(0, (tgt.height || 1) * 0.7, 0)).catch(() => {})
        bot.attack(tgt)
        await new Promise(r => setTimeout(r, 600))
      } else { await new Promise(r => setTimeout(r, 300)) }
    }
  } finally { bot.pathfinder.setGoal(null) }
  await collectDrops(bot, 8)
  return !tgt.isValid
}

async function gatherLeather (bot, target, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const deadline = Date.now() + (opts.timeMs || 120000) // 2 min hard cap
  const maxKills = opts.maxKills || 16
  const maxExplores = opts.maxExplores != null ? opts.maxExplores : 2 // don't roam far for armor
  const home = opts.home // roam fence anchor (build site), if given
  const maxRoam = opts.maxRoam || 48
  const leatherNow = () => countItem(bot, 'leather')
  const start = leatherNow()
  bot.pathfinder.setMovements(S().gatherMovements(bot)) // anti-grief while chasing
  let killed = 0
  let explores = 0
  try {
    while (leatherNow() - start < target && killed < maxKills && Date.now() < deadline && !isStopped()) {
      // nearest leather animal within the fence (never chase a cow beyond maxRoam of home)
      let tgt = null; let best = 32
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
        if (!LEATHER_ANIMALS.test((e.name || '').toLowerCase())) continue
        if (home && Math.hypot(e.position.x - home.x, e.position.z - home.z) > maxRoam) continue
        const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
      }
      if (!tgt) { // none in range - roam to find some, but only a couple times (armor is optional)
        if (explores++ >= maxExplores) break
        await S().explore(bot, explores, home, maxRoam)
        continue
      }
      // wield the best melee we have (sword > axe > fist) and chase it down
      const items = bot.inventory ? bot.inventory.items() : []
      const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      const killStart = Date.now()
      bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 2), true)
      while (tgt.isValid && Date.now() - killStart < 15000 && !isStopped()) {
        if (bot.entity.position.distanceTo(tgt.position) <= 3.5) {
          await bot.lookAt(tgt.position.offset(0, (tgt.height || 1) * 0.7, 0)).catch(() => {})
          bot.attack(tgt)
          await new Promise(r => setTimeout(r, 600)) // attack-cooldown cadence
        } else {
          await new Promise(r => setTimeout(r, 300))
        }
      }
      bot.pathfinder.setGoal(null)
      if (!tgt.isValid) killed++
      await collectDrops(bot, 8) // grab the dropped leather (and beef)
    }
  } finally {
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements()
  }
  const got = leatherNow() - start
  if (got > 0) say(`got ${got} leather off ${killed} ${killed === 1 ? 'cow' : 'cows'}`)
  return { leather: got, killed }
}

async function ensureFoodSupply (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const anchor = opts.home || { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }
  const animalRange = parseInt(process.env.FOOD_ANIMAL_RANGE || '40', 10)
  // 0) EAT what we carry first (cook raw -> eat to comfortable) - never idle hungry with food.
  await eatFromPackToComfortable(bot, isStopped)
  // DECISION LOOP (foodSupplyAction): tend / buildFarm-at-known-water / huntNear / sweep. The
  // KEY fix - after a sweep discovers + remembers water, the NEXT iteration sees knownWater and
  // BUILDS THE FARM there instead of idling at the hut ("found it, did nothing"). Bounded.
  let sweeps = 0
  for (let step = 0; step < 4 && !isStopped(); step++) {
    if (hasStandingFarm()) {
      let tended = false
      try { tended = await tendWheatFarm(bot, { isStopped, say }) } catch (e) { dbg('  foodSupply: tend failed (' + e.message + ')') }
      // GROW a standing-but-undersized farm on the fed-idle pass too (same guard as secureFood):
      // tend returning true no longer blocks expansion - re-admit an under-target, un-maxed farm.
      const wf = loadWorldMem().wheatFarm
      const under = wf && (wf.cells || []).length > 0 && (wf.cells || []).length < WHEAT_FARM_TARGET && !wf.maxed
      if (!tended || under) {
        try { await ensureWheatFarm(bot, anchor, { isStopped, say }) } catch (e) { dbg('  foodSupply: expand failed (' + e.message + ')') }
      }
      return { ok: true, reason: 'wheat farm stands - tended it' }
    }
    const knownWater = recallInfra('water', bot.entity.position, 300)
    const nearAnimal = nearestFoodAnimal(bot, animalRange)
    const action = foodSec.foodSupplyAction(false, !!knownWater, !!nearAnimal)
    dbg('  ensureFoodSupply[step ' + step + ']: action=' + action +
        ' knownWater=' + (knownWater ? knownWater.x + ',' + knownWater.z : 'none') +
        ' nearAnimal=' + (nearAnimal ? nearAnimal.name + '@' + Math.round(nearAnimal.dist) + 'b' : 'none'))
    if (action === 'buildFarm') {
      // THE MISSING HANDOFF: WALK to the found/remembered pond first (ensureWheatFarm only
      // searches ~48 locally), VERIFY it's an open-sky pond ON ARRIVAL, then build there.
      say('found water at ' + knownWater.x + ',' + knownWater.z + ' - going there to build a wheat farm')
      dbg('  ensureFoodSupply: trekking to the pond at ' + knownWater.x + ',' + knownWater.z + ' to farm it')
      try { await S().walkStaged(bot, knownWater.x, knownWater.z, { isStopped, range: 6, timeoutMs: 150000 }) } catch {}
      // on arrival: is there OPEN-SKY water within reach? A remembered pond can be cave/covered
      // (older pre-seesSky memory) - drop it and try the NEXT remembered pond, don't loop on it.
      const md = require('minecraft-data')(bot.version)
      const seesSky = p => { for (let dy = 1; dy <= 40; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false } return true }
      const arrived = Math.hypot(bot.entity.position.x - knownWater.x, bot.entity.position.z - knownWater.z) <= 10
      const openWater = arrived && (bot.findBlocks({ matching: md.blocksByName.water.id, maxDistance: 24, count: 32 }) || []).some(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) && seesSky(p) })
      if (arrived && !openWater) {
        dbg('  ensureFoodSupply: remembered pond ' + knownWater.x + ',' + knownWater.z + ' is cave/covered on arrival - forgetting it, trying the next')
        try { forgetInfra('water', listInfra('water').find(e => e.x === knownWater.x && e.z === knownWater.z)) } catch {}
        continue // loop: next remembered pond, or sweep farther
      }
      if (!arrived) { dbg('  ensureFoodSupply: could not reach the pond (trek fell short) - keeping it, will retry'); return { ok: false, reason: 'could not reach the discovered pond - retry next pass' } }
      // we're AT an open-sky pond -> build the farm here (ensureWheatFarm finds water locally now)
      try { await ensureWheatFarm(bot, { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }, { isStopped, say, avoid: opts.avoid }) } catch (e) { dbg('  foodSupply: wheat farm setup error (' + e.message + ')') }
      if (hasStandingFarm()) { await eatFromPackToComfortable(bot, isStopped); return { ok: true, reason: 'wheat farm PLANTED at the discovered pond ' + knownWater.x + ',' + knownWater.z } }
      // at a good pond but the farm still deferred (hoe/seeds) - the pond is FINE, don't forget
      // it; the wheat-farm log names the reason (now the hoe is resource-model-crafted). Retry.
      dbg('  ensureFoodSupply: at the open-sky pond but farm setup deferred (hoe/seeds - see wheat-farm log)')
      return { ok: false, reason: 'at the pond but farm setup deferred (hoe/seeds) - retry next pass' }
    } else if (action === 'huntNear') {
      dbg('  ensureFoodSupply: ' + nearAnimal.name + ' ' + Math.round(nearAnimal.dist) + 'b away - hunting it')
      try { await huntForFood(bot, { isStopped, range: animalRange }) } catch {}
      if (foodCount(bot) > 0) { await eatFromPackToComfortable(bot, isStopped); return { ok: true, reason: 'hunted a nearby animal' } }
    } else { // 'sweep' - discover water/animals; widen the rings on later sweeps
      const rings = sweeps === 0 ? [48, 96] : [96, 144, 192]
      sweeps++
      dbg('  ensureFoodSupply: no known food source - SWEEPING (rings ' + rings.join('/') + ') to discover one')
      try {
        const r = await scoutForFood(bot, anchor, { isStopped, say, rings, maxMs: opts.scoutMs || 240000 })
        if (r && r.found === 'animals' && r.kills > 0) { await eatFromPackToComfortable(bot, isStopped); return { ok: true, reason: 'scouted out animals and hunted ' + r.kills } }
        // the sweep remembered water -> the NEXT loop iteration will pick 'buildFarm'
      } catch (e) { dbg('  foodSupply: scout failed (' + e.message + ')') }
    }
  }
  return { ok: hasStandingFarm() || foodCount(bot) > 0, reason: hasStandingFarm() ? 'wheat farm planted' : 'still looking for a farmable open-sky pond (swept, none tillable yet - will retry)' }
}

function needFoodSupply (bot) {
  if (!bot.entity || bot.food == null) return false
  const safe = !nearHostile(bot, 12) && (bot.health ?? 20) >= 12 && !isNight(bot) && !hasSolidCeiling(bot, 12)
  return foodSec.needsFoodSupply(bot.food, hasStandingFarm(), foodCount(bot), 0, safe)
}

async function bankFoodFirst (bot, { home = null, isStopped = () => false, say = () => {} } = {}) {
  if (process.env.FOOD_BANK_FIRST === '0') return { fed: false }
  const comfortable = 18
  if (bot.food != null && bot.food >= comfortable) return { fed: true }
  if (isStopped()) return { fed: false }
  const anchor = home || hutAnchor() || knownBed()
  if (!anchor) return { fed: false }
  const res = require('./resources.js')
  let bankFoodPts = 0
  try {
    const t = await res.totalCounts(bot, { cachedOnly: true, near: anchor, maxDist: 64 })
    const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
    for (const [n, c] of Object.entries(t)) if (foods[n] && foodSec.foodTier(n) < 2) bankFoodPts += (foods[n].foodPoints || 0) * c
  } catch (e) { dbg('  bank-first: bank read failed (' + e.message + ')') }
  const safeFood = Number(process.env.FOOD_BANK_SAFE || 14)
  const want = foodSec.bankFoodWithdrawPts(bankFoodPts, bot.food, safeFood)
  if (want <= 0) return { fed: false } // bank holds no edible food worth pulling -> fall through to farm/hold
  dbg('secureFood: BANK FIRST - bank holds ~' + bankFoodPts + ' edible pts; withdrawing to reach food ' + safeFood + ' (reachable even at low hp, no far-farm trek)')
  say('grabbing food from my bank instead of trekking to the far farm')
  try {
    const got = await res.ensureFood(bot, { near: anchor, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true })
    if (got) {
      dbg('  bank-first: withdrew ' + got + ' food from the bank')
      try { if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped }) } catch {}
      await eatUp(bot)
    }
  } catch (e) { dbg('  bank-first: withdraw failed (' + e.message + ')') }
  return { fed: bot.food != null && bot.food >= comfortable }
}

async function courierFoodToBank (bot, { isStopped = () => false, say = () => {}, snap = null } = {}) {
  const res = require('./resources.js')
  const maintain = require('./maintain.js')
  const cell = resolveBankCell(bot)
  if (!cell) { dbg('  courier: no hut bank chest - skipping (home-repair owns making one)'); return 0 }
  const hut = hutAnchor()
  const anchor = hut || cell
  if (bot.entity && bot.entity.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) > 6) {
    try { await S().walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {}
  }
  if (isStopped()) return 0
  const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
  const packItems = []
  for (const i of (bot.inventory ? bot.inventory.items() : [])) {
    if (foods[i.name]) packItems.push({ name: i.name, count: i.count, foodPoints: foods[i.name].foodPoints || 0, tier: foodSec.foodTier(i.name) })
  }
  // BANK-only food points (a real read - we're standing at the chest): totalCounts would fold in
  // the pack surplus we're about to deposit and wrongly read the pantry as full.
  let bankFoodPts = 0; let bankRods = 0
  try { const counts = await res.readChest(bot, cell); for (const [n, c] of Object.entries(counts || {})) { if (foods[n]) bankFoodPts += (foods[n].foodPoints || 0) * c; if (n === 'fishing_rod') bankRods += c } } catch {}
  // #62 §B FOOD_BUFFER_STOCK (default on): with §A providing a reachable bank fallback, the bot no
  // longer needs to HOARD food on-pack - LOWER the courier's pack keep to a small reserve
  // (FOOD_PACK_RESERVE pts) so the harvest SURPLUS flows to the bank and a durable reserve
  // accumulates toward FOOD_BANK_TARGET loaves (which the next crisis withdraws via §A). Same
  // pure courierPlan machinery - just a lower keep + explicit bank target. FOOD_BUFFER_STOCK=0 ->
  // courierPlan's default keep/target (byte-for-byte).
  const courierOpts = {}
  if (process.env.FOOD_BUFFER_STOCK !== '0') {
    // #64 §B DYNAMIC_FOOD (default on): the pack KEEP is no longer a flat FOOD_PACK_RESERVE - it's
    // foodNeedForPlan(currentPlan), so the courier banks only food genuinely SURPLUS to what the bot
    // is about to do. At home idle -> ~DFOOD_HOME_PTS(8), banks the rest (today's behavior). Mid-/pre-
    // excursion (the _foodPlanHint set by branchMine/runGather, else the physical-state snapshot) ->
    // the trip-sized keep, so it does NOT strip food away before a deep mine (§C guard). DYNAMIC_FOOD=0
    // -> the flat FOOD_PACK_RESERVE (byte-for-byte #62).
    if (process.env.DYNAMIC_FOOD !== '0') {
      let s = snap
      if (!s) { try { s = await P().schedulerState(bot) } catch { s = {} } }
      const plan = _foodPlanHint || foodPlanNow(bot, s)
      courierOpts.packTarget = foodSec.foodNeedForPlan(plan)
    } else {
      courierOpts.packTarget = Number(process.env.FOOD_PACK_RESERVE || 8)
    }
    courierOpts.bankTarget = Number(process.env.FOOD_BANK_TARGET || 10) * 5 // FOOD_BANK_TARGET is in loaves; bread = 5 food pts
  }
  const plan = maintain.courierPlan(packItems, bankFoodPts, courierOpts)
  // FOOD_FLOOR F3: leave a spare fishing_rod in the reserve alongside the food, so the post-death
  // naked bot's floor can WITHDRAW a rod (F2) instead of scrambling for 0 string. Ships only a
  // TRUE dupe (keeps 1 rod on the bot); rodReserveTopUp bounds it. FOOD_FLOOR=0 -> no rod line.
  // ROD_SUPPLY (M4): also seed the reserve on the MAINTENANCE courier pass (this same call) so the
  // moment the bot EVER holds a spare rod (e.g. a fresh self-craft) it banks it - the reserve then
  // survives death and F2 pays out on every later crisis, independent of a successful fish trip.
  if (process.env.FOOD_FLOOR !== '0' || process.env.ROD_SUPPLY === '1') {
    const packRods = countItem(bot, 'fishing_rod')
    const shipRods = maintain.rodReserveTopUp(bankRods, packRods)
    if (shipRods > 0) plan.push({ name: 'fishing_rod', count: shipRods })
  }
  if (!plan.length) { dbg('  courier: pack keep met / pantry stocked (' + bankFoodPts + ' pts) - nothing to deposit'); return 0 }
  const blk = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
  if (!blk || !/chest/.test(blk.name)) { dbg('  courier: bank cell no longer a chest'); return 0 }
  let n = 0
  try { n = await depositMaterials(bot, blk, { deposits: plan }) } catch (e) { dbg('  courier: deposit failed (' + e.message + ')') }
  try { await res.readChest(bot, cell) } catch {} // refresh cache so bankFoodPts/maintainNeeded update next tick
  if (n) { dbg('  courier: banked ' + n + ' food item(s) into the pantry'); say('stocking the pantry - ' + n + ' food in the chest') }
  return n
}

function foodPlanNow (bot, snap, override) {
  const s = snap || {}
  let home = null
  try { home = hutAnchor() || knownBed() || null } catch {}
  const pos = (bot && bot.entity && bot.entity.position) || null
  let distHome = s.homeDist
  if (distHome == null && pos && home) { try { distHome = Math.hypot(pos.x - home.x, pos.z - home.z) } catch {} }
  distHome = distHome != null ? distHome : 0
  const homeReachable = s.homeReachable != null ? s.homeReachable : (distHome <= DFOOD_FAR())
  const surfaceY = (home && home.y != null) ? home.y : (pos ? pos.y : 64)
  const depth = pos ? Math.max(0, surfaceY - pos.y) : 0
  let activity
  if (depth >= DFOOD_DEEP()) activity = 'deep-mine'          // physically underground = the biggest ration
  else if (distHome > DFOOD_FAR()) activity = 'far-trek'     // physically far from the bank = distance buffer
  else activity = 'idle'                                     // at home/surface: the bank is a few steps away
  const plan = { activity, distHome, depth, homeReachable }
  return override ? Object.assign(plan, override) : plan     // an explicit caller plan wins (knows its target)
}

async function topUpFoodForPlan (bot, plan, { home = null, isStopped = () => false } = {}) {
  try {
    const needPts = foodSec.foodNeedForPlan(plan)
    const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
    let packPts = 0
    for (const i of (bot.inventory ? bot.inventory.items() : [])) {
      if (foods[i.name] && foodSec.foodTier(i.name) < 2) packPts += (foods[i.name].foodPoints || 0) * i.count
    }
    if (packPts >= needPts) return 0                        // already carrying the trip ration
    const loavesToAdd = Math.ceil((needPts - packPts) / 5)  // bread = 5 pts; round up to cover the shortfall
    if (loavesToAdd <= 0) return 0
    const haveBread = countItem(bot, 'bread')
    const before = haveBread
    // acquire(craft:false) = a BANK-FIRST, withdraw-only top-up to the target bread count. It no-ops
    // gracefully when the bank has no bread / is out of range (the job then proceeds with what it has).
    try { await require('./resources.js').acquire(bot, 'bread', haveBread + loavesToAdd, { near: home, craft: false, isStopped }) } catch (e) { dbg('  topUpFood: withdraw failed (' + e.message + ')') }
    const got = countItem(bot, 'bread') - before
    if (got > 0) dbg('  DYNAMIC_FOOD: pre-trip top-up +' + got + ' bread (' + plan.activity + ', need ' + needPts + 'pts, had ' + packPts + 'pts)')
    return Math.max(0, got)
  } catch (e) { dbg('  topUpFood: ' + e.message); return 0 }
}

function _setFoodPlanHint (p) { const prev = _foodPlanHint; _foodPlanHint = p || null; return prev }

function isSecuringFood () { return _securingFood }

function escalateFoodFloor () { if (process.env.FOOD_FLOOR !== '0') _foodFloorNoProgress = foodSec.foodFloorEscalation(_foodFloorNoProgress, false) }

async function secureFood (bot, opts = {}) {
  if (_securingFood) return { fed: false, blockedOn: 'busy' }
  _securingFood = true
  S().isSurvStopped() = false; touchP('secureFood') // S7 H5c: per-dispatch latch clear + zero-idle at t0
  try { return await secureFoodInner(bot, opts) } finally { _securingFood = false }
}

async function secureFoodInner (bot, opts = {}) {
  const isStopped = () => S().isSurvStopped() || (opts.isStopped ? opts.isStopped() : false) // S7: fold the watchdog latch into the existing abort poll
  const say = opts.say || (() => {})
  const home = opts.home || null
  const cookIfRaw = async () => { try { if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped }) } catch {} }
  // EAT TO COMFORTABLE, not just "stopped starving" (live: it cooked beef then wandered off to
  // mine at food=10 and died). "Fed" = the food bar is COMFORTABLE (>=18) - the surplus food
  // left in the pack after eating up to 18 IS the carried buffer. The old release at food>12
  // OR "3 food items" is exactly what let it leave hungry with cooked meat in the pack.
  const comfortable = opts.comfortable != null ? opts.comfortable : 18
  const fedEnough = () => bot.food != null && bot.food >= comfortable
  let triedHomeFood = false // HOME FOOD FIRST: at most ONE home trek per call (loop-safe)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // EATING MUST WIN over a stalled brain goal: the bot idled at food=0 stuck in a stalled
  // item-recovery `travel` while food sat in its chest (live). Drop any lingering goal so the
  // eat -> withdraw -> cook steps below own the body and can walk to the bank/furnace.
  try { if (bot.pathfinder && bot.pathfinder.goal) bot.pathfinder.setGoal(null) } catch {}
  dbg('secureFood: food=' + bot.food + ' packFood=' + foodCount(bot))
  // 0) eat what we carry. COOK-BEFORE-EAT: if the pack's only non-bad food is RAW meat (tier 1
  // and NO ready-to-eat tier-0 food), cook it first (mirror eatFromPackToComfortable) so it
  // doesn't scarf raw mutton at 1/3 value next to a furnace. GUARDED to "no tier-0 in pack" so
  // a genuine crisis holding bread doesn't detour to a furnace before eating it.
  try {
    const md0 = require('minecraft-data')(bot.version); const f0 = (md0 && md0.foodsByName) || {}
    const packFoods = (bot.inventory ? bot.inventory.items() : []).filter(i => f0[i.name])
    const hasReady = packFoods.some(i => foodSec.foodTier(i.name) === 0)
    const hasRaw = packFoods.some(i => foodSec.foodTier(i.name) === 1)
    if (!hasReady && hasRaw) await cookIfRaw()
  } catch {}
  await eatUp(bot)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // 1) the pantry: withdraw banked food. FORCE A FRESH chest read (opts.forceFresh) - a stale
  // cache reported the bank empty for 11h and the bot starved AT its own chest without ever
  // re-opening it (live). A hungry bot near its bank must really open it before giving up.
  try {
    const got = await require('./resources.js').ensureFood(bot, { near: home, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true })
    // COOK RAW BEFORE EATING: the bank holds raw mutton/porkchop + some cooked; if we pulled
    // raw and a furnace is in reach, cook it first (raw is poor food) - eat raw only as the
    // last-resort starving fallback (eatBestFood already gates raw meat to food<=6).
    if (got) { dbg('secureFood: withdrew ' + got + ' food from the bank'); await cookIfRaw(); await eatUp(bot) }
  } catch (e) { dbg('secureFood: bank check failed (' + e.message + ')') }
  if (fedEnough()) return { fed: true, blockedOn: null }
  // 2) raw meat in the pack + a furnace in reach -> cook (3x the food value of raw)
  await cookIfRaw(); await eatUp(bot)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // CHEAP food (pack/bank/cook) is drained. Only GENUINE hunger (<= the acquire trigger)
  // justifies the EXPENSIVE discovery below (hunt/farm/fish/scout) - a moderately-fed bot
  // (e.g. food 15) must not go farming every planner round for the last few points. It eats
  // to comfortable from ready food when it can, and only truly hungry does it go get more.
  const acquireTrigger = opts.threshold != null ? opts.threshold : 12
  if ((bot.food ?? 20) > acquireTrigger) { dbg('secureFood: food=' + bot.food + ' > acquire-trigger ' + acquireTrigger + ' and ready food drained - not hunting/farming for the last points'); return { fed: true, blockedOn: null } }
  // #62 §A FOOD_BANK_FIRST (default on): BEFORE any farm trek / fishing / hold, if the hut BANK
  // holds edible food, withdraw enough to reach a safe food level and eat it - reachable even at
  // hp1 (the bank is at the hut), so it breaks the "far farm unreachable when weak" deadlock without
  // a 100b trek. Bounded (maxDist 64, never forces a far trek) + guarded (a dry/unreachable bank
  // falls through with nothing lost). FOOD_BANK_FIRST=0 -> the whole branch is skipped (byte-for-byte).
  if (process.env.FOOD_BANK_FIRST !== '0') {
    try { await bankFoodFirst(bot, { home, isStopped, say }) } catch (e) { dbg('secureFood: bank-first failed (' + e.message + ')') }
    if (fedEnough()) return { fed: true, blockedOn: null }
  }
  // 2.5) HOME FOOD FIRST (HOME_FOOD_FIRST=0 restores today's behavior). Step 1's bank withdraw
  // is RANGE-BOUNDED (maxDist 64): once the bot has drifted beyond it, that read silently
  // no-ops and the chain below marches OUTWARD (scout) hunting NEW food while the bot's own
  // bank + farm sit at home (live: starved 110b out with 5 wheat + a farm at the hut). Before
  // any outward discovery, if we're beyond withdraw range of home AND home holds USABLE food
  // (real banked food, or >=3 bakeable wheat, or a standing farm), trek BACK and use what we
  // own: re-run the in-range pantry, BAKE the raw banked wheat (the actual live rescue), then
  // tend/harvest the farm. ONCE per call + fully guarded: a failed trek or a dry home falls
  // straight through to today's exact chain (hunt/fish/scout) with nothing lost.
  if (process.env.HOME_FOOD_FIRST !== '0' && !triedHomeFood) {
    triedHomeFood = true
    const anchor = home || hutAnchor() || knownBed()
    if (anchor && bot.entity && bot.entity.position) {
      const range = Number(process.env.HOME_FOOD_RANGE || 48)
      const pos = bot.entity.position
      const distHome = Math.hypot(pos.x - anchor.x, pos.z - anchor.z)
      let totals = {}
      try { totals = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: anchor, maxDist: 64 }) } catch {}
      const mdH = require('minecraft-data')(bot.version); const foodsH = (mdH && mdH.foodsByName) || {}
      let bankFoodPts = 0
      for (const [n, c] of Object.entries(totals)) if (foodsH[n]) bankFoodPts += (foodsH[n].foodPoints || 0) * c
      const wheatCount = totals.wheat || 0
      const snap = { distHome, bankFoodPts, wheatCount, hasFarm: hasStandingFarm() }
      if (foodSec.shouldTrekHomeForFood(snap, { range })) {
        say('starving out here - heading home to eat from my own stores')
        dbg('secureFood: HOME FOOD FIRST - ' + Math.round(distHome) + 'b out (range ' + range + '), bankFoodPts=' + bankFoodPts + ' wheat=' + wheatCount + ' farm=' + snap.hasFarm + ' -> trekking home')
        try { await S().walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 6, timeoutMs: 180000 }) } catch (e) { dbg('  home-food: trek home failed (' + e.message + ')') }
        // re-run the in-range pantry now that we should be home (fresh chest read)
        try {
          const got = await require('./resources.js').ensureFood(bot, { near: anchor, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true })
          if (got) { dbg('  home-food: withdrew ' + got + ' food from the bank'); await cookIfRaw(); await eatUp(bot) }
        } catch (e) { dbg('  home-food: pantry failed (' + e.message + ')') }
        if (fedEnough()) return { fed: true, blockedOn: null }
        // still hungry: BAKE the banked wheat (it's raw/inedible - the live rescue)
        if (snap.wheatCount >= 3 || countItem(bot, 'wheat') >= 3) {
          try { await bakeBreadFromWheat(bot, { isStopped, home: anchor }); await eatUp(bot) } catch (e) { dbg('  home-food: bake failed (' + e.message + ')') }
          if (fedEnough()) return { fed: true, blockedOn: null }
        }
        // last home resort: tend/harvest the farm, then eat what came off it
        try { await tendWheatFarm(bot, { isStopped, say }); await eatUp(bot) } catch (e) { dbg('  home-food: farm tend failed (' + e.message + ')') }
        if (fedEnough()) return { fed: true, blockedOn: null }
        // home came up dry - fall through to today's exact chain below (nothing lost)
      }
    }
  }
  // 3) hunt what's visible (batch - one kill barely dents the deficit)
  try { for (let k = 0; k < 4 && foodCount(bot) < 5 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped, range: 32 })) break } } catch {}
  await cookIfRaw(); await eatUp(bot)
  // F1' FOOD FLOOR (FOOD_FLOOR, default on): the DEDICATED starvation floor - runs BEFORE the
  // isStopped short-circuit below so the ONE reliable acquisition (fishing at remembered / farm-
  // pond / scouted open-sky water) FIRES even when an hp-abort or a stopped latch would otherwise
  // return here with ZERO food (the 3.5h hp1/food0 livelock, §2.2/§2.0). Only at genuine starvation
  // (food<=floorFood) with a dry pack (the bank was already tried at step 1). Rod is guaranteed by
  // ensureFishingRod (bank-withdraw then craft, F2); bounded by fishForFood's 240s cap + hostile
  // reel-out. The floor only fires at food<=floorFood, which IS the §4 spiral exception, so it is
  // never spiral-suppressed. FOOD_FLOOR=0 -> the whole branch is skipped (byte-for-byte).
  // #61 SKIP_DEAD_FISHING: compute the floor trigger ONCE; the fishing floor only ENTERS when fishing
  // is enabled. Disabled (default) -> log a clean skip and fall straight through to the #59 harvest-
  // first / FARM FLOOR / famine-hold path below (NO ensureFishingRod trek, NO walk-to-water, NO cast).
  const floorTriggered = process.env.FOOD_FLOOR !== '0' && !fedEnough() && foodSec.foodFloorTriggered({ hp: bot.health, food: bot.food, hasPackFood: foodCount(bot) >= 1 })
  if (floorTriggered && !fishingEnabled()) dbg('secureFood: FOOD FLOOR - fishing: disabled (0 catches on this version) - skipping the fishing floor -> farm-harvest/farm-floor/hold')
  let floorFished = false
  if (floorTriggered && fishingEnabled()) {
    const escalate = foodSec.foodFloorEscalated(_foodFloorNoProgress)
    const foodBefore = bot.food ?? 0
    dbg('secureFood: FOOD FLOOR - food=' + bot.food + ' hp=' + bot.health + ' pack dry -> fishing floor' + (escalate ? ' (ESCALATED - widening the water scout)' : ''))
    say('starving - going fishing, it\'s the one food source that always works')
    try {
      if (await ensureFishingRod(bot, { isStopped, home })) {
        await fishForFood(bot, { isStopped, say, home, scout: true, scoutRings: escalate ? [48, 96, 144] : undefined })
      } else dbg('  FOOD FLOOR: no rod obtainable (bank reserve dry + can\'t craft) - cannot fish (honest fallback: hold)')
    } catch (e) { dbg('  FOOD FLOOR: fishing floor failed (' + e.message + ')') }
    await cookIfRaw(); await eatUp(bot)
    floorFished = true
    const gained = (bot.food ?? 0) > foodBefore || foodCount(bot) > 0
    _foodFloorNoProgress = foodSec.foodFloorEscalation(_foodFloorNoProgress, gained)
    if (fedEnough()) {
      // F3: a SUCCESSFUL floor session restocks the bank reserve (surplus fish + a spare rod) so R2
      // gotoHome+ensureFood pays out instantly next crisis. Reuses the #40 courier (bounded).
      if (process.env.MAINTAIN !== '0') { try { await courierFoodToBank(bot, { isStopped, say }) } catch {} }
      return { fed: true, blockedOn: null }
    }
  }
  if (fedEnough() || isStopped()) return { fed: fedEnough(), blockedOn: fedEnough() ? null : (isStopped() ? 'stopped' : 'food') }
  // #59 §B FARM_HARVEST_FIRST (default on): the farm GROWS but the bot never EATS from it - the crisis
  // path establishes a NEW plot at the nearest (often STALE) water instead of routing to the STANDING
  // farm. When a farm already stands in world-mem and we're in a real food crisis, TREK TO IT and
  // tend/harvest (mature wheat -> bake bread -> eat) BEFORE any establish. The standing farm can be
  // ~100b out (beyond FARM FLOOR's nearHome gate), so this treks farther - but ONLY when it's safe
  // (day, no hostile within 12, hp above the floor), exactly the surrounding safety discipline. A
  // single harvest yields BOTH bread (food) and seeds (replant) -> self-sustaining. Bounded by
  // walkStaged/tendWheatFarm + isStopped. FARM_HARVEST_FIRST=0 -> skip (today's establish-first).
  if (farm.foodCrisisFarmAction({ hasStandingFarm: hasStandingFarm(), food: bot.food ?? 20, harvestFirst: process.env.FARM_HARVEST_FIRST !== '0' }) === 'harvest-standing' &&
      !fedEnough() && foodCount(bot) < 1 && !isStopped()) {
    const wf = loadWorldMem().wheatFarm
    const hp = bot.health ?? 20
    const safe = hp > Number(process.env.FARM_HARVEST_HP || 10) && !isNight(bot) && !nearHostile(bot, 12)
    if (wf && safe) {
      dbg('secureFood: HARVEST-FIRST - standing farm at ' + wf.x + ',' + wf.z + ' (food=' + bot.food + ' hp=' + hp + ') -> trekking to harvest it before establishing anew')
      say('i have a farm - harvesting it instead of starving next to it')
      try { await S().walkStaged(bot, wf.x, wf.z, { isStopped, range: 6, timeoutMs: 180000 }) } catch (e) { dbg('  harvest-first: trek to farm failed (' + e.message + ')') }
      try { await tendWheatFarm(bot, { isStopped, say }); await bakeBreadFromWheat(bot, { isStopped, home: wf }); await cookIfRaw(); await eatUp(bot) } catch (e) { dbg('  harvest-first: tend/bake/eat failed (' + e.message + ')') }
      if (fedEnough()) {
        // #62 §B FOOD_BUFFER_STOCK: now that the crisis is over (fed), bank the harvest SURPLUS so a
        // durable reserve accumulates for the next crisis (§A withdraws it). Bounded + isStopped-aware
        // inside courierFoodToBank; only after we're safely fed. =0 -> just return (byte-for-byte).
        if (process.env.FOOD_BUFFER_STOCK !== '0') { try { await courierFoodToBank(bot, { isStopped, say }) } catch (e) { dbg('  harvest-first: courier surplus failed (' + e.message + ')') } }
        return { fed: true, blockedOn: null }
      }
    } else if (wf) dbg('secureFood: HARVEST-FIRST - standing farm at ' + wf.x + ',' + wf.z + ' but unsafe to trek (hp=' + hp + ' night=' + isNight(bot) + ' hostile=' + nearHostile(bot, 12) + ') - deferring to the local floor')
  }
  // #40 F4.2: a STARVING bot (food<=4) that just trekked home and found the pantry dry must NOT
  // then march OUT to farm/fish/scout - those excursions are what get a 1-hp bot killed. Skip the
  // outward legs and hold indoors (bounded); the caller / crisis reflex re-runs the whole chain
  // later. Only when it can hold and only after HOME-FOOD-FIRST was tried; food>4 (or no-hold
  // callers like the mid-trek chain) keep today's exact hunt/farm/fish/scout ordering.
  // #57 FARM FLOOR (FARM_FLOOR, default on): fishing is dead/unreliable here, so the FARM is the
  // ONLY renewable food - but ensureWheatFarm (establish + LEVEL the plot, #56) sits AFTER the
  // famine-hold below, so a starving bot at low hp holds indoors and NEVER establishes it (the live
  // hp1/food0 deadlock: unarmored -> degraded -> recovery owns the body -> never builds -> the farm
  // never gets leveled -> can't ever eat). When the pack is dry and a farm site is NEAR home (not a
  // far/deadly trek), ESTABLISH + LEVEL + plant the farm NOW - it IS the food source, exactly like
  // the fishing floor above, and it's reachable at low hp because it's next to home. Then tend +
  // eat in case a cell is already ripe. Bounded by ensureWheatFarm's own cell/time budget + isStopped
  // (survival preempts). It won't feed INSTANTLY (wheat must grow) but it PLANTS the source that the
  // next crisis harvests - breaking the deadlock. FARM_FLOOR=0 -> skip (today's hold-and-starve).
  if (process.env.FARM_FLOOR !== '0' && !fedEnough() && foodCount(bot) < 1 && !isStopped()) {
    const fh = home || hutAnchor() || knownBed()
    const nearHome = !!(fh && bot.entity && Math.hypot(bot.entity.position.x - fh.x, bot.entity.position.z - fh.z) <= Number(process.env.FARM_FLOOR_RANGE || 80))
    if (nearHome) {
      dbg('secureFood: FARM FLOOR - food=' + bot.food + ' hp=' + (bot.health ?? 20) + ' fishing dry -> establishing/leveling the farm (the real food source)')
      say('fishing does nothing here - building the farm so i can actually eat')
      try { await ensureWheatFarm(bot, fh, { isStopped, say, avoid: opts.avoid }) } catch (e) { dbg('  FARM FLOOR: ensureWheatFarm failed (' + e.message + ')') }
      try { await tendWheatFarm(bot, { isStopped, say }); await cookIfRaw(); await eatUp(bot) } catch (e) { dbg('  FARM FLOOR: tend/eat failed (' + e.message + ')') }
      if (fedEnough()) return { fed: true, blockedOn: null }
    }
  }
  // #54 FAMINE_FORAGE_SAFE (default on): the famine-hold (food<=4) is meant to stop a bot from
  // marching out to DIE on a fishing trip - but at hp OK + DAY + no mob near, foraging is SAFE, and
  // holding indoors here just FREEZES the bot forever (food pinned at 4 while perfectly still ->
  // never drains to the food<=2 crisis floor -> never fishes -> zero progress, the live 06:1x stuck).
  // When it's genuinely safe, SKIP the hold so execution reaches the farm-rebuild (5358) + the
  // unconditional fishing leg (5382, fish-from-bank #52) + the scout (5387) and the bot FEEDS itself.
  // Night / mob-near / hp<=floor still holds (the #40 death-march stays fixed). =0 -> today byte-for-byte.
  const safeToForage = process.env.FAMINE_FORAGE_SAFE !== '0' &&
    (bot.health ?? 20) > Number(process.env.FAMINE_FORAGE_HP || 10) && !isNight(bot) && !nearHostile(bot, 12)
  if (opts.canHold && triedHomeFood && foodSec.famineHoldFood(bot.food) && !safeToForage && !isStopped()) {
    dbg('secureFood: famine-hold - food=' + bot.food + ' and home stores dry - holding indoors, not trekking out to fish/scout')
    say('nothing to eat out here and home is dry - holing up rather than starving on a fishing trip')
    try { await P().boundedHold(bot, { isStopped, say }) } catch {}
    const fedH = foodCount(bot) > 0
    return { fed: fedH, blockedOn: fedH ? null : (isStopped() ? 'stopped' : (isNight(bot) ? 'night' : 'food')) }
  }
  // 4) the farm (harvest what's ripe / plant one by remembered water)
  try {
    // EXPAND, don't just tend: a standing-but-undersized farm (tend returns true after
    // harvesting) never used to grow because ensureWheatFarm only ran when tend returned FALSE.
    // Re-admit an under-target, un-maxed farm so it keeps expanding toward WHEAT_FARM_TARGET.
    const tended = await tendWheatFarm(bot, { isStopped, say })
    const wf = loadWorldMem().wheatFarm
    const under = wf && (wf.cells || []).length > 0 && (wf.cells || []).length < WHEAT_FARM_TARGET && !wf.maxed
    if (!tended || under) {
      // REBUILD the farm even when the BED is gone: a creeper-destroyed bed makes knownBed()->
      // home null, and the old `if (home)` guard then SILENTLY skipped the rebuild - so a bot with
      // no bed + a dead 0-cell farm looped at food 10 forever, never re-planting (live 00:3x, food
      // 10 < 14 gearup-hold, `wheat farm tended: harvested 0` every 20s, ensureWheatFarm never
      // called). Anchor on the hut, else where we STAND (we reach here standing at the pond), so
      // the till-fixed builder actually re-establishes the plot.
      const farmHome = home || (bot.entity && bot.entity.position) || hutAnchor()
      if (farmHome) await ensureWheatFarm(bot, farmHome, { isStopped, say, avoid: opts.avoid })
    }
  } catch (e) { dbg('secureFood: farm fallback failed (' + e.message + ')') }
  await eatUp(bot)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // 5) fish - works anywhere with surface water (scouts for a pond in a real crisis). Skip when the
  // F1' floor already ran the fishing leg this call (no double 240s session); FOOD_FLOOR=0 ->
  // floorFished is always false -> today's unconditional fishing (byte-for-byte).
  // #61 SKIP_DEAD_FISHING: gate the unconditional fishing leg. Disabled (default) -> skip cleanly to
  // the scout (6) / famine-hold (7) below; NO walk-to-water, NO cast. =1 -> today's leg byte-for-byte.
  if (!fishingEnabled()) dbg('secureFood: fishing: disabled (0 catches on this version) - skipping the unconditional fishing leg -> scout/hold')
  try { if (!floorFished && fishingEnabled()) await fishForFood(bot, { isStopped, say, home, scout: bot.food <= 4 }) } catch (e) { dbg('secureFood: fishing failed (' + e.message + ')') }
  await eatUp(bot)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // 6) crisis: SYSTEMATICALLY sweep unexplored ground for animals + water (not the old
  // re-tread-stale-pastures scoutHunt) - the SW/NW food the bot never found was here.
  if (bot.food <= 4 && !isStopped() && opts.scoutHunt !== false && !isNight(bot)) {
    try { await scoutForFood(bot, home || undefined, { isStopped, say, maxMs: opts.scoutMs || 180000 }) } catch (e) { dbg('secureFood: scout failed (' + e.message + ')') }
    await cookIfRaw(); await eatUp(bot)
    if (fedEnough()) return { fed: true, blockedOn: null }
  }
  // 7) famine hold: NOTHING panned out - get home/indoors and sit it out (bounded; the
  // caller or the crisis reflex re-runs the whole chain later).
  if (opts.canHold && (bot.food ?? 20) <= 1 && !isStopped()) { try { await P().boundedHold(bot, { isStopped, say }) } catch {} }
  const fed = foodCount(bot) > 0
  return { fed, blockedOn: fed ? null : (isStopped() ? 'stopped' : (isNight(bot) ? 'night' : 'food')) }
}

async function scoutForFood (bot, home, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const explore = require('./explore.js')
  const mcData = require('minecraft-data')(bot.version)
  const anchor = home || { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }
  const rings = opts.rings || [48, 96, 144]
  const m = loadWorldMem()
  const scouted = m.scouted = m.scouted || {}
  const now = Date.now()
  const decayMs = opts.decayMs || 30 * 60000 // a swept sector re-opens after 30 min (mobs wander back)
  const searched = new Set(Object.keys(scouted).filter(k => now - (scouted[k] || 0) < decayMs))
  const waypoints = explore.octantSweep(anchor, { rings })
  const deadline = now + (opts.maxMs || 240000)
  const seesFood = () => Object.values(bot.entities || {}).some(e => e && e.position && FOOD_ANIMALS.test((e.name || '').toLowerCase()))
  // Remember only OPEN-SKY water the wheat farm can actually use (the DISCOVERY<->ACTION
  // mismatch fix): the sweep used to remember ANY air-topped water incl. cave/ravine pools that
  // ensureWheatFarm then REJECTS (seesSky), so "found water" led to a farm that never built.
  const seesSky = p => { for (let dy = 1; dy <= 40; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false } return true }
  const rememberWaterNear = () => {
    try {
      const w = (bot.findBlocks({ matching: mcData.blocksByName.water.id, maxDistance: 32, count: 32 }) || [])
        .find(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) && seesSky(p) })
      if (w) { rememberInfra('water', { x: w.x, y: w.y, z: w.z }); dbg('  scoutForFood: remembered OPEN-SKY water at ' + w.x + ',' + w.z + ' (farmable)'); return true }
    } catch {}
    return false
  }
  say('scouting the area for food - sweeping ground i haven\'t checked')
  dbg('scoutForFood: sweeping from ' + anchor.x + ',' + anchor.z + ' (rings ' + rings.join('/') + ', ' + searched.size + ' sectors already swept)')
  let visited = 0; let foundWater = false
  while (Date.now() < deadline && !isStopped() && visited < (opts.maxLegs || 8)) {
    if (isNight(bot)) { dbg('  scoutForFood: night - not roaming the dark'); break }
    const wp = explore.firstUnswept(waypoints, searched)
    if (!wp) { dbg('  scoutForFood: every sector swept recently - nothing new to check'); break }
    dbg('  scoutForFood: sweeping octant ' + wp.name + ' ring ' + wp.ring + ' -> walking to ' + wp.x + ',' + wp.z + ' (leg ' + (visited + 1) + '/' + (opts.maxLegs || 8) + ')')
    if (say && visited === 0) say('scouting ' + wp.name + ' for food')
    try { await S().walkStaged(bot, wp.x, wp.z, { isStopped, range: 8, timeoutMs: 100000 }) } catch {}
    // credit the sector we ACTUALLY reached (a trek that fell short shouldn't mark the far one)
    const hereKey = explore.sectorKeyAt(bot.entity.position.x, bot.entity.position.z, anchor, { rings })
    if (hereKey) { searched.add(hereKey); scouted[hereKey] = Date.now() }
    searched.add(wp.key); scouted[wp.key] = Date.now(); saveWorldMem()
    visited++
    if (rememberWaterNear()) foundWater = true
    if (seesFood()) {
      rememberInfra('pasture', bot.entity.position)
      say('found animals - hunting')
      let kills = 0
      try { for (let k = 0; k < 5 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped, range: 40 })) break; kills++ } } catch {}
      if (kills > 0) { dbg('  scoutForFood: hunted ' + kills + ' at ' + Math.round(bot.entity.position.x) + ',' + Math.round(bot.entity.position.z)); return { found: 'animals', kills } }
    }
  }
  return { found: seesFood() ? 'animals' : (foundWater ? 'water' : null), kills: 0 }
}

async function scoutHunt (bot, { isStopped = () => false, say = () => {}, maxMs = 180000 } = {}) {
  const start = bot.entity.position.clone()
  const deadline = Date.now() + maxMs
  const seesFood = () => Object.values(bot.entities || {}).some(e => e && e.position && FOOD_ANIMALS.test((e.name || '').toLowerCase()))
  const legs = []
  const known = recallInfra('pasture', start, 200)
  if (known) legs.push({ x: known.x, z: known.z })
  for (const r of [40, 80, 120]) for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) legs.push({ x: start.x + dx * r, z: start.z + dz * r })
  say('nothing to eat around here - going to find animals')
  dbg('scoutHunt: searching from ' + Math.round(start.x) + ',' + Math.round(start.z) + (known ? ' (remembered pasture first)' : ''))
  for (const leg of legs) {
    if (isStopped() || Date.now() > deadline) break
    if (isNight(bot)) { dbg('scoutHunt: night fell - not roaming the dark for dinner'); break }
    try { await S().walkStaged(bot, leg.x, leg.z, { isStopped, range: 8, timeoutMs: 60000 }) } catch {}
    if (seesFood()) {
      rememberInfra('pasture', bot.entity.position)
      dbg('scoutHunt: animals near ' + Math.round(bot.entity.position.x) + ',' + Math.round(bot.entity.position.z) + ' - remembered as pasture')
      let kills = 0
      try { for (let k = 0; k < 4 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped, range: 32 })) break; kills++ } } catch {}
      if (kills > 0) return true
    }
  }
  dbg('scoutHunt: no animals found (searched ~120 blocks out)')
  return false
}

module.exports = {
  setDebugSink,
  RAW_COOKABLE, FOOD_ANIMALS, LEATHER_ANIMALS, RISKY_EAT, ROD_SPIDERS, DFOOD_DEEP, DFOOD_FAR, _foodPlanHint, _securingFood, _foodFloorNoProgress, _foodFloorState, hasFood, foodCount, needsFood, nearestFoodAnimal, eatFromPackToComfortable, eatBestFood, eatUp, bakeBreadFromWheat, cookRawMeat, fishingEnabled, ensureFishingRod, fishForFood, huntForFood, huntSpiderForString, gatherLeather, ensureFoodSupply, needFoodSupply, bankFoodFirst, courierFoodToBank, foodPlanNow, topUpFoodForPlan, _setFoodPlanHint, isSecuringFood, escalateFoodFloor, secureFood, secureFoodInner, scoutForFood, scoutHunt
}
