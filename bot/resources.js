'use strict'
// RESOURCE MODEL: the single source of truth for "what do I actually own" -
// pack + every world-verified chest the bot remembers - and how to reconcile a
// bill of materials against it. The rule every consumer follows:
//   never GATHER what you can WITHDRAW, never WAIT for what you can CRAFT.
// Before this module each subsystem read only the carried pack, so the bot
// chopped trees while 111 logs sat in its bank, starved beside a chest of
// cooked food, and begged players for a door while holding 109 planks.
//
// Chests are BOT-OWNED only (the infra registry in world-memory) - this module
// never opens or counts a chest the bot didn't place/adopt itself, so the
// anti-grief line holds: the player's storage is invisible to it.
//
// Chest reads are cached and PERSISTED (chest-cache.json) so a failed open or a
// restart doesn't zero the bank tally (the "oak sawtooth": banked logs read as
// 0 after every death and the bot re-gathered wood it owned). The world is
// still the truth: every real open refreshes the cache, and chest entries
// pruned from infra memory (block gone) drop their cached counts with them.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const provision = require('./provision')

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[res] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// ---- persisted chest cache ----------------------------------------------------
// { "x,y,z": { counts: {item: n}, at: epochMs } } - last GOOD read of each chest.
const CACHE_FILE = process.env.CHEST_CACHE_FILE || path.join(__dirname, 'chest-cache.json')
let cache = null
function loadCache () {
  if (cache) return cache
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) } catch { cache = {} }
  return cache
}
function saveCache () {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(loadCache())) } catch {}
}
const cellKey = e => `${e.x},${e.y},${e.z}`

// ---- dead-chest tracking --------------------------------------------------------
// A chest that repeatedly fails to REACH or OPEN must stop being selected: overnight the
// bot hammered a broken underground chest (433,52,113) every ~12s for hours - reporting
// packFood=0 and starving - while the operator's food sat in the reachable hut chest.
// Consecutive reach/open failures earn a growing cooldown (2,4,8,...60 min, persisted
// with the cache); 5 in a row deregisters the chest from infra memory entirely. Cached
// COUNTS survive the cooldown (the stock is presumably still in there - only the WALK is
// suppressed), so the bank tally doesn't sawtooth. Any successful open clears the record.
const REACH_FAIL_RE = /goto timed out|window did not open|openBlock|no path|took too long|path ended short/i
function chestFailed (bot, e, err) {
  const msg = (err && err.message) || ''
  if (!REACH_FAIL_RE.test(msg)) return // a reflex stealing the goal is not the chest's fault
  // BLAME SCOPE: only count a failure the bot suffered NEAR the chest. A bot wedged in a
  // hole 30 blocks out fails to reach EVERYTHING - that poisoned the perfectly good hut
  // chest's record and deregistered it (live, 05:27). Far failure = the BOT's nav problem.
  try {
    if (bot && bot.entity && Math.hypot(e.x - bot.entity.position.x, e.y - bot.entity.position.y, e.z - bot.entity.position.z) > 12) {
      dbg('chest at ' + cellKey(e) + ' unreached from afar (' + msg + ') - not the chest\'s fault, no strike')
      return
    }
  } catch {}
  const c = loadCache()
  const k = cellKey(e)
  const ent = c[k] = c[k] || { counts: {}, at: 0 }
  ent.fails = (ent.fails || 0) + 1
  const mins = Math.min(60, 2 * Math.pow(2, ent.fails - 1)) // 2, 4, 8, 16, 32, 60
  ent.failUntil = Date.now() + mins * 60000
  saveCache()
  dbg('chest at ' + k + ' unreachable/unopenable ' + ent.fails + 'x (' + msg + ') - cooling it off ' + mins + ' min')
  if (ent.fails >= 5) {
    try {
      provision.forgetInfra('chest', e)
      dbg('chest at ' + k + ' DEREGISTERED after ' + ent.fails + ' straight failures - a dead chest must not block the bank')
    } catch (e2) { dbg('chest dereg failed: ' + e2.message) }
  }
}
function chestWorked (e) {
  const ent = loadCache()[cellKey(e)]
  if (ent && (ent.fails || ent.failUntil)) { delete ent.fails; delete ent.failUntil; saveCache() }
}
function chestCoolingOff (e) {
  const ent = loadCache()[cellKey(e)]
  return !!(ent && ent.failUntil && ent.failUntil > Date.now())
}

// ---- which chests exist (world-verified) ---------------------------------------

// The bot's own chests near `near` (default: where it stands), nearest first.
// listInfra(bot) prunes entries whose loaded chunk no longer holds a chest, so a
// crept-up bank falls out of the model instead of haunting it; the pruned cell's
// cached counts are dropped too. DOUBLE chests are two remembered cells but ONE
// container - adjacent same-y pairs collapse to a single entry (counting both
// halves doubled the bank tally).
function verifiedChests (bot, near, maxDist = 32) {
  const all = provision.listInfra('chest', bot) || []
  const c = loadCache()
  const live = new Set(all.map(cellKey))
  let dropped = false
  for (const k of Object.keys(c)) { if (!live.has(k)) { delete c[k]; dropped = true } }
  if (dropped) saveCache()
  const anchor = near || (bot.entity ? bot.entity.position : null)
  if (!anchor) return []
  const inRange = all
    .map(e => ({ ...e, d: Math.hypot(e.x - anchor.x, e.z - anchor.z) }))
    .filter(e => e.d <= maxDist)
    .sort((a, b) => a.d - b.d)
  const kept = []
  for (const e of inRange) {
    if (kept.some(k => k.y === e.y && Math.abs(k.x - e.x) + Math.abs(k.z - e.z) === 1)) continue // other half of a double
    kept.push(e)
  }
  return kept
}

// Walk to + read one chest; refresh its cache. Falls back to the cached counts on a
// failed open (mob interruption / reach) instead of reporting the bank as empty.
async function readChest (bot, e) {
  const blk = bot.blockAt(new Vec3(e.x, e.y, e.z))
  if (!blk || !/chest/.test(blk.name)) return (loadCache()[cellKey(e)] || {}).counts || {}
  if (chestCoolingOff(e)) return (loadCache()[cellKey(e)] || {}).counts || {} // dead chest - don't walk, use the cache
  try {
    const counts = await provision.chestCounts(bot, blk)
    const ent = loadCache()[cellKey(e)] = loadCache()[cellKey(e)] || {}
    ent.counts = counts; ent.at = Date.now()
    saveCache()
    chestWorked(e)
    return counts
  } catch (err) {
    dbg('chest read failed at ' + cellKey(e) + ' (' + err.message + ') - using cached counts')
    chestFailed(bot, e, err)
    return (loadCache()[cellKey(e)] || {}).counts || {}
  }
}

function cachedChest (e) { return loadCache()[cellKey(e)] || null }

// ---- what do I own -------------------------------------------------------------

// {item: count} across pack + verified chests. Chest counts come from the cache
// when fresh (default 3 min); stale/unknown chests get a real walk-and-read unless
// opts.cachedOnly (cheap mode for reflexes that must not send the bot walking).
async function totalCounts (bot, opts = {}) {
  const out = { ...provision.inventoryCounts(bot) }
  const maxAge = opts.maxAgeMs != null ? opts.maxAgeMs : 180000
  for (const e of verifiedChests(bot, opts.near, opts.maxDist)) {
    const c = cachedChest(e)
    let counts
    if (c && c.counts && (Date.now() - c.at < maxAge)) counts = c.counts
    else if (opts.cachedOnly) counts = (c && c.counts) || {}
    else counts = await readChest(bot, e)
    for (const [n, k] of Object.entries(counts || {})) out[n] = (out[n] || 0) + k
  }
  return out
}

async function totalHave (bot, name, opts = {}) { return (await totalCounts(bot, opts))[name] || 0 }

// ---- moving items between pack and bank ------------------------------------------

// Withdraw up to `count` of `name` from the verified chests, nearest first.
// Returns how many actually came out. Refreshes each touched chest's cache.
async function withdrawItems (bot, name, count, opts = {}) {
  let got = 0
  for (const e of verifiedChests(bot, opts.near, opts.maxDist)) {
    if (got >= count) break
    if (chestCoolingOff(e) && !opts.includeCooling) continue // repeatedly unreachable - a working chest must get the walk instead
    const c = cachedChest(e)
    if (c && c.counts && !(c.counts[name] > 0) && Date.now() - c.at < 60000) continue // fresh read says empty - skip the walk
    const blk = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (!blk || !/chest/.test(blk.name)) continue
    try {
      const n = await provision.withdrawItem(bot, blk, name, count - got)
      got += n
      chestWorked(e)
      await readChest(bot, e) // we're standing here - refresh the cache with a real read
    } catch (err) {
      dbg('withdraw ' + name + ' failed at ' + cellKey(e) + ' (' + err.message + ')')
      chestFailed(bot, e, err)
    }
  }
  if (got > 0) dbg('withdrew ' + got + '/' + count + ' ' + name + ' from the bank')
  return got
}

// How many build-material items the pack still holds (KEEP_ON_BOT excluded) - drives the
// multi-chest spill: if materials remain after filling a chest, we need another.
function packMaterialCount (bot) {
  return (bot.inventory ? bot.inventory.items() : []).filter(i => !provision.KEEP_ON_BOT.test(i.name)).reduce((s, i) => s + i.count, 0)
}

// Deposit build materials (everything not KEEP_ON_BOT) into verified chests; with
// opts.mayCreate it crafts/places one when none is remembered nearby. MULTI-CHEST (item 5,
// castle scale ~2350 blocks): one chest holds ~1728 items, so when a chest FILLS and the pack
// still has materials, spill into the NEXT verified chest, and place a FRESH one when they're
// all full - a 2350-block BOM overflows a single bank. Bounded (maxChests per call). Returns
// total items deposited.
async function autoBank (bot, opts = {}) {
  const maxChests = opts.maxChests != null ? opts.maxChests : 6
  let total = 0
  const tried = new Set()
  for (let round = 0; round < maxChests; round++) {
    if (opts.isStopped && opts.isStopped()) break
    if (packMaterialCount(bot) <= (opts.keepDirt || 0)) break // nothing left to bank
    // pick the nearest verified chest we haven't already filled this call
    let blk = null; let cell = null
    for (const e of verifiedChests(bot, opts.near, opts.maxDist)) {
      const k = cellKey(e); if (tried.has(k) || chestCoolingOff(e)) continue
      const b = bot.blockAt(new Vec3(e.x, e.y, e.z))
      if (b && /chest/.test(b.name)) { blk = b; cell = e; break }
    }
    if (!blk && opts.mayCreate) {
      try { blk = await provision.ensureChest(bot, { isStopped: opts.isStopped, home: opts.near }) } catch (e) { dbg('autoBank: no chest and cannot make one (' + e.message + ')'); break }
      cell = blk && { x: blk.position.x, y: blk.position.y, z: blk.position.z }
    }
    if (!blk) break // no more chests and can't/won't make one
    tried.add(cellKey(cell))
    const before = packMaterialCount(bot)
    try {
      const n = await provision.depositMaterials(bot, blk, { keepDirt: opts.keepDirt || 0 })
      total += n || 0
      await readChest(bot, cell)
    } catch (e) { dbg('autoBank: deposit failed (' + e.message + ')') }
    // if the deposit moved NOTHING, this chest is full (or nothing fit) - try the next one /
    // make a new one. If it moved something and the pack is now clear, we're done (loop breaks).
    if (packMaterialCount(bot) >= before) { dbg('autoBank: chest at ' + cellKey(cell) + ' full - spilling to the next'); continue }
  }
  if (total > 0) dbg('banked ' + total + ' items' + (tried.size > 1 ? ' across ' + tried.size + ' chests' : ''))
  return total
}

// Make sure the pack has at least `minFree` empty slots BEFORE it deadlocks (a
// 36/36 pack cannot even craft a chest - no output slot). Junk first, then bank.
async function ensurePackRoom (bot, minFree = 4, opts = {}) {
  const free = () => (bot.inventory ? bot.inventory.emptySlotCount() : 36)
  if (free() >= minFree) return free()
  try { await provision.dumpJunk(bot) } catch {}
  if (free() < minFree) await autoBank(bot, opts)
  if (free() < minFree) dbg('pack still tight after junk+bank: ' + free() + ' slots free')
  return free()
}

// ---- reconcile a bill of materials against TOTAL holdings -------------------------

// Plan how to satisfy `bom` from everything the bot owns: returns
//   { withdraws: [{item, count}], plan, holdings, chestTotals }
// where `plan` is a planProvision result computed against pack+bank (so it only
// gathers/crafts what the bot truly lacks) and `withdraws` is what must move
// bank->pack before the plan runs (plan.used = stock the plan consumes).
// opts.hide: item names to EXCLUDE from holdings (the material loop plans "get me
// N more X" where N already nets out everything owned - crediting X again would
// produce an empty plan).
// opts.credit: {item: n} phantom stock to vouch for (e.g. a bed the rebuild will
// recover from the old hut) - never withdrawn, just trusted.
async function reconcile (bot, bom, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const pack = provision.inventoryCounts(bot)
  const chestTotals = {}
  for (const e of verifiedChests(bot, opts.near, opts.maxDist)) {
    const c = cachedChest(e)
    const counts = (c && c.counts && (Date.now() - c.at < (opts.maxAgeMs != null ? opts.maxAgeMs : 180000))) ? c.counts : await readChest(bot, e)
    for (const [n, k] of Object.entries(counts || {})) chestTotals[n] = (chestTotals[n] || 0) + k
  }
  const holdings = { ...pack }
  for (const [n, k] of Object.entries(chestTotals)) holdings[n] = (holdings[n] || 0) + k
  for (const [n, k] of Object.entries(opts.credit || {})) holdings[n] = (holdings[n] || 0) + k
  for (const h of (opts.hide || [])) delete holdings[h]
  const plan = provision.planProvision(mcData, bom, holdings, opts.planOpts || {})
  const withdraws = []
  for (const [name, cnt] of Object.entries(plan.used || {})) {
    if (opts.hide && opts.hide.includes(name)) continue
    const short = cnt - (pack[name] || 0) - ((opts.credit || {})[name] || 0)
    if (short > 0 && (chestTotals[name] || 0) > 0) withdraws.push({ item: name, count: Math.min(short, chestTotals[name]) })
  }
  if (withdraws.length || plan.tasks.length) {
    dbg('reconcile: withdraw [' + withdraws.map(w => w.count + ' ' + w.item).join(', ') + '] then ' +
      (plan.tasks.map(t => `${t.type}:${t.item || t.output}`).join(',') || '(nothing)'))
  }
  return { withdraws, plan, holdings, chestTotals }
}

// Execute a reconcile result: withdrawals first (bank -> pack), then the plan
// (gather/craft/smelt). Same return shape as runPlan, with withdraw steps prepended.
async function runReconciled (bot, rec, opts = {}) {
  const results = []
  if (rec.withdraws.length) await ensurePackRoom(bot, Math.min(8, rec.withdraws.length + 2), { near: opts.near || opts.home, isStopped: opts.isStopped })
  for (const w of rec.withdraws) {
    if (opts.isStopped && opts.isStopped()) break
    const got = await withdrawItems(bot, w.item, w.count, { near: opts.near || opts.home })
    results.push({ task: { type: 'withdraw', item: w.item, count: w.count }, ok: got >= w.count, note: `withdrew ${got}/${w.count} ${w.item}` })
  }
  if (rec.plan.tasks.length) results.push(...await provision.runPlan(bot, rec.plan, opts))
  return results
}

// ---- on-demand acquisition for a RUNNING build ------------------------------------

// The builder ran out of `name` mid-placement. Withdraw it from the bank; if the
// bank hasn't got it but the holdings can CRAFT it (a door from carried planks -
// the bot once begged players for a door while holding 109 planks and a table),
// craft/smelt it now. Never wanders off to gather mid-build - that is the material
// loop's job; we only do work that stays at/near the site. Returns true when the
// pack now holds at least `count` (or gained any, for count>1 partials).
async function acquire (bot, name, count = 1, opts = {}) {
  const packHas = () => provision.inventoryCounts(bot)[name] || 0
  const before = packHas()
  if (before >= count) return true
  // withdraw a BATCH (fewer bank trips for bulk blocks) but only ever CRAFT the shortfall
  await withdrawItems(bot, name, Math.max(count, opts.batch || 0) - packHas(), { near: opts.near })
  if (packHas() >= count) return true
  if (opts.craft === false) return packHas() > before
  const rec = await reconcile(bot, { [name]: count - packHas() }, { near: opts.near, planOpts: opts.planOpts })
  const gathersNeeded = Object.keys(rec.plan.gathers || {}).length
  const unobtainable = Object.keys(rec.plan.unobtainable || {}).length
  if (gathersNeeded || unobtainable) {
    dbg('acquire ' + name + ': not craftable from holdings (' +
      (gathersNeeded ? 'needs gathering ' + Object.keys(rec.plan.gathers).join(',') : 'unobtainable ' + Object.keys(rec.plan.unobtainable).join(',')) + ')')
    return packHas() > before
  }
  try { await runReconciled(bot, rec, { say: opts.say || (() => {}), isStopped: opts.isStopped, home: opts.near }) } catch (e) { dbg('acquire ' + name + ': craft chain failed (' + e.message + ')') }
  return packHas() >= count || packHas() > before
}

// ---- food is a resource too --------------------------------------------------------

const RISKY_FOOD = /rotten_flesh|spider_eye|poisonous_potato|pufferfish|^chicken$|^porkchop$|^beef$|^mutton$|^rabbit$|^cod$|^salmon$/
// Hungry with an empty pantry but food IN THE BANK? Withdraw a meal instead of
// starving next to it (the bot died at 1hp with cooked chicken in its chest, live).
// Cheap by design: cached chest counts only decide whether a walk happens at all.
async function ensureFood (bot, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 12
  if (!bot.entity || bot.food == null || bot.food > threshold) return 0
  const md = require('minecraft-data')(bot.version)
  const foods = (md && md.foodsByName) || {}
  const packFood = (bot.inventory ? bot.inventory.items() : []).filter(i => foods[i.name]).reduce((s, i) => s + i.count, 0)
  if (packFood >= (opts.minPack != null ? opts.minPack : 1)) return 0
  const chests = verifiedChests(bot, opts.near, opts.maxDist != null ? opts.maxDist : 48)
  let target = null; let bestFood = null
  // two passes: working chests first; a cooling-off (repeatedly dead) chest is only ever
  // a LAST resort when it's the sole cached food source - never while a good chest holds
  // food (the bot starved beside the stocked hut chest hammering a dead one, live).
  // STALE-CACHE STARVATION FIX (live: cache was 11h old showing empty; the operator added
  // food and the bot never re-read, starving AT its own bank). When HUNGRY, a stale cache
  // (older than freshMs, default 60s) or opts.forceFresh forces a REAL open of a reachable
  // chest before concluding it's empty - never starve on a stale "empty".
  const freshMs = opts.freshMs != null ? opts.freshMs : 60000
  for (const allowCooling of [false, true]) {
    for (const e of chests) {
      if (chestCoolingOff(e) !== allowCooling) continue
      const c = cachedChest(e)
      const fresh = c && c.counts && (Date.now() - (c.at || 0) < freshMs)
      let counts
      if (chestCoolingOff(e)) counts = (c && c.counts) || {}                 // dead chest: don't walk, use whatever we cached
      else if (opts.forceFresh || !fresh) counts = await readChest(bot, e)   // hungry + stale/forced -> real open (the fix)
      else counts = c.counts
      const names = Object.keys(counts).filter(n => foods[n] && counts[n] > 0)
        .sort((a, b) => (RISKY_FOOD.test(a) ? 1 : 0) - (RISKY_FOOD.test(b) ? 1 : 0) || (foods[b].foodPoints || 0) - (foods[a].foodPoints || 0))
      if (names.length) { target = e; bestFood = names[0]; break }
    }
    if (target) break
  }
  if (!target) return 0
  dbg('hungry (' + bot.food + ') with no pack food - withdrawing ' + bestFood + ' from the bank at ' + cellKey(target) + (chestCoolingOff(target) ? ' (dead-chest LAST RESORT)' : ''))
  const got = await withdrawItems(bot, bestFood, opts.wantCount != null ? opts.wantCount : 8, { near: opts.near, includeCooling: chestCoolingOff(target) })
  return got
}

module.exports = {
  verifiedChests,
  readChest,
  totalCounts,
  totalHave,
  withdrawItems,
  autoBank,
  ensurePackRoom,
  reconcile,
  runReconciled,
  acquire,
  ensureFood,
  setDebugSink
}
