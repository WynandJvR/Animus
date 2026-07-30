'use strict'
// RECOVERY: what the bot does when it is losing. The R0-R5 degraded ladder, HP recovery,
// resting, sleeping, the bounded hold, spawn-anchor repair, walking home, and the
// deadlock reset. Split out of provision.js unchanged.
//
// THIS IS THE MOST LOAD-BEARING CODE IN THE REPO and none of it was rewritten. Every rung
// here came out of a real failure: a bot that starved at 1hp with food in a chest, a bot
// that respawned 380 blocks from home and died walking back, a bot that ratcheted itself
// weaker with every death. The ORDER of the ladder and the bounds on each rung are the
// fix - each rung is capped and names the condition that wakes the next, so the bot can
// never sit in an unnamed wait. Do not "simplify" a rung without reproducing the loop it
// closes.
//
// The deadlock reset (#58/#63) is the last resort: when hp and food are both floored and
// nothing has produced progress, it stashes what it carries and dies deliberately, because
// a clean respawn at the bed beats an unrecoverable crawl. It is heavily gated - fail
// counters, cooldown, and an explicit no-progress check - for obvious reasons.
//
// scheduler.js decides WHICH job owns the body; this module is what the survival jobs run.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const mining = require('./mining.js')        // PURE tool-durability model
const scaffold = require('./scaffold.js')    // temp-block registry + teardown
const scheduler = require('./scheduler.js')  // PURE tier/preemption decisions
const foodSec = require('./food.js')         // PURE food-security decisions
const reflexes = require('./reflexes.js')    // PLAN-one-runner S4: declared holds (a hold says it is alive; it does not fake progress)
const navigate = require('./navigate.js')
const provCore = require('./provision-core.js')
const { AIRISH, REPLACEABLE, countItem, inventoryCounts, toolForBlock, gotoWithTimeout,
  collectDrops, stepInto, placeAt, nearHostile, isNight, canBreakNaturally } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, saveWorldMem, listInfra, rememberInfra, recallInfra, knownBed,
  rememberBed, forgetBed, markBedUnusable, bedHeld, setSpawnSuspect, isSpawnSuspect,
  noteBedUnobtainable, clearBedUnobtainable } = worldMemory
const provHut = require('./provision-hut.js')
const { hutAnchor, insideOwnStructure, hasSolidCeiling, ownHutAt, onHutApron, maintainHome,
  ensureHutBed, stepOffApron, bedUsable, assertSpawnOn } = provHut
const provShelter = require('./provision-shelter.js')
const { isSheltering, shelterNeeded, nightStuck, nightRestWanted, digInForNight, underArmored,
  lowHpCalm, inWaterNow, ensureAshore, pickOpenSkyCell, shelterSite, _sheltering } = provShelter
const provMining = require('./provision-mining.js')
const { pillarUpTo } = provMining
const provFarm = require('./provision-farm.js')
const { tendWheatFarm, farmFootprintHas } = provFarm
const provFood = require('./provision-food.js')
const { hasFood, foodCount, needsFood, secureFood, eatBestFood, isSecuringFood, eatUp,
  eatFromPackToComfortable, huntForFood, cookRawMeat, bakeBreadFromWheat, bankFoodFirst,
  courierFoodToBank, RAW_COOKABLE, FOOD_ANIMALS } = provFood
const provBank = require('./provision-bank.js')
const { resolveBankCell, depositMaterials, withdrawItem, chestCounts } = provBank

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

const DEADLOCK_HP = Number(process.env.DEADLOCK_HP || 2)          // fire only at hp<=this

const DEADLOCK_MAX_NOFOOD = Number(process.env.DEADLOCK_MAX_NOFOOD || 5) // back off after N resets that gained no food

const DEADLOCK_FAILS = Number(process.env.DEADLOCK_FAILS || 4)    // K consecutive all-rungs-tried deadlock cycles

// #72 DEADLOCK_RESET_SOFT (default on): broaden the trigger to a persistently-degraded-and-not-
// recovering equilibrium (hp<=SOFT_HP AND food<=SOFT_FOOD AND no pack food AND K'>=SOFT_FAILS
// consecutive all-rungs-tried cycles), not just the exact hp<=2/food0 floor. The bot can sit at
// hp~4.8/food~7 - functionally deadlocked (can't reach food to climb to hp>=14, so #69/#71 never
// fire) but never at the hard floor because food drains too slowly while holding. The soft path
// requires MORE consecutive fails (6 vs 4) so a transient dip never resets; !hasPackFood + the
// higher fail bar keep a healthy/recovering bot (food climbing >SOFT_FOOD, hp climbing >SOFT_HP,
// or any pack food) from ever tripping it. DEADLOCK_RESET_SOFT=0 -> only the original hp<=2/food0
// trigger, byte-for-byte. It REUSES the same stash->die action, 10-min cooldown, noteDeadlockReset,
// and DEADLOCK_MAX_NOFOOD backoff - a broadened trigger must NOT cause a suicide-loop.
const DEADLOCK_RESET_SOFT = process.env.DEADLOCK_RESET_SOFT !== '0' // default on

const DEADLOCK_SOFT_HP = Number(process.env.DEADLOCK_SOFT_HP || 6)     // soft trigger: hp<=this

const DEADLOCK_SOFT_FOOD = Number(process.env.DEADLOCK_SOFT_FOOD || 8) // soft trigger: food<=this

const DEADLOCK_SOFT_FAILS = Number(process.env.DEADLOCK_SOFT_FAILS || 6) // soft trigger: K' consecutive fails (> hard's 4)

const DEADLOCK_RESET_COOLDOWN_MS = Number(process.env.DEADLOCK_RESET_COOLDOWN_MS || 600000) // hard anti-loop gap

const DEADLOCK_FALL_H = Number(process.env.DEADLOCK_FALL_H || 6)  // pillar height for the lethal fall

const SUICIDE_EXIT_OPEN_SKY = process.env.SUICIDE_EXIT_OPEN_SKY !== '0' // §A: reach open sky (ring at r8-12), not just a single 6-block step

const SUICIDE_FALLBACK_DEATH = process.env.SUICIDE_FALLBACK_DEATH !== '0' // §B: drown / pit-drop when pillar+fall can't be set up

const SUICIDE_DROWN = process.env.SUICIDE_DROWN !== '0' // §B.1 sub-guard: the deliberate-drown fallback (arms the navigate reflex latch)

const SUICIDE_PILLAR_WORKS = process.env.SUICIDE_PILLAR_WORKS !== '0' // #76: acquire filler after stash-all + climb past the open-sky break so the lethal pillar can actually be built AT open sky

let _deadlockFails = 0          // consecutive "all rungs tried" cycles observed AT the deadlock state

let _deadlockResetting = false  // re-entrancy guard while the stash+die runs

function _noteDeadlockProgress (bot) {
  const hp = bot.health != null ? bot.health : 20
  const food = bot.food != null ? bot.food : 20
  // Any genuine escape from the deadlock state clears the fail counter + the no-food streak. When
  // the soft trigger is on the escape bar rises to the SOFT thresholds (hp>SOFT_HP OR food>SOFT_FOOD
  // OR any pack food) - otherwise food>0 at the hp~4.8/food~7 equilibrium would reset the counter
  // every cycle and the soft failCount could never accumulate. DEADLOCK_RESET_SOFT=0 -> the original
  // hp>2 || food>0 || packfood escape bar, byte-for-byte.
  const escaped = DEADLOCK_RESET_SOFT
    ? (hp > DEADLOCK_SOFT_HP || food > DEADLOCK_SOFT_FOOD || foodCount(bot) >= 1)
    : (hp > DEADLOCK_HP || food > 0 || foodCount(bot) >= 1)
  if (escaped) {
    _deadlockFails = 0
    const m = loadWorldMem()
    if (m.deadlockReset && m.deadlockReset.count) { m.deadlockReset.count = 0; saveWorldMem() }
  }
}

function noteDeadlockReset () {
  const m = loadWorldMem()
  const d = m.deadlockReset = m.deadlockReset || { at: 0, count: 0 }
  d.at = Date.now(); d.count = (d.count || 0) + 1
  saveWorldMem()
  if (d.count >= Math.min(3, DEADLOCK_MAX_NOFOOD)) dbg('deadlock-reset: ' + d.count + ' resets with no food gained - the food SOURCE is still broken (no water / farm won\'t establish)')
}

function deadlockResetDue ({ hp, food, hasPackFood, failCount, sinceLastResetMs }, opts = {}) {
  if (opts.enabled === false) return false
  const HP = opts.hp != null ? opts.hp : DEADLOCK_HP
  const FAILS = opts.fails != null ? opts.fails : DEADLOCK_FAILS
  const COOLDOWN = opts.cooldownMs != null ? opts.cooldownMs : DEADLOCK_RESET_COOLDOWN_MS
  // Anti-loop + no-auto-eat guards are shared by BOTH triggers (commuting the AND leaves the hard
  // path byte-for-byte): edible pack food -> never suicide; the 10-min cooldown must have elapsed.
  if (hasPackFood) return false
  if (sinceLastResetMs < COOLDOWN) return false
  // HARD trigger (original #58): the exact hp<=2/food0 floor at the lower fail bar (K=4).
  if (hp <= HP && food === 0 && failCount >= FAILS) return true
  // SOFT trigger (#72, DEADLOCK_RESET_SOFT default on): a persistently-degraded-and-not-recovering
  // equilibrium - low hp AND low food AND no pack food AND MORE consecutive all-rungs-tried cycles
  // (K'=6 > 4) so a transient dip never resets. opts.soft===false (the DEADLOCK_RESET_SOFT=0 flag)
  // hard-disables it, leaving ONLY the hard path -> byte-for-byte.
  const softOn = opts.soft != null ? opts.soft : DEADLOCK_RESET_SOFT
  if (softOn) {
    const SHP = opts.softHp != null ? opts.softHp : DEADLOCK_SOFT_HP
    const SFOOD = opts.softFood != null ? opts.softFood : DEADLOCK_SOFT_FOOD
    const SFAILS = opts.softFails != null ? opts.softFails : DEADLOCK_SOFT_FAILS
    if (hp <= SHP && food <= SFOOD && failCount >= SFAILS) return true
  }
  return false
}

function deadlockResetState () { return loadWorldMem().deadlockReset || { at: 0, count: 0 } }

function sampleColumnForSky (bot, x, z, surfaceY, ceil) {
  const nameAt = (ax, ay, az) => { try { const b = bot.blockAt(new Vec3(ax, ay, az)); return b && b.name } catch { return null } }
  let foundY = null
  for (let dy = 3; dy >= -4; dy--) {
    const fy = surfaceY + dy
    const floor = nameAt(x, fy - 1, z); const feet = nameAt(x, fy, z); const head = nameAt(x, fy + 1, z)
    if (floor && !AIRISH(floor) && !/water|lava/.test(floor) && AIRISH(feet) && AIRISH(head)) { foundY = fy; break }
  }
  if (foundY == null) return { x, y: surfaceY, z, standable: false, solidCeiling: true }
  let solidCeiling = !!insideOwnStructure(bot, new Vec3(x, foundY, z))
  if (!solidCeiling) {
    for (let dy = 2; dy <= ceil; dy++) { const n = nameAt(x, foundY + dy, z); if (n && !AIRISH(n) && !/_leaves$/.test(n)) { solidCeiling = true; break } }
  }
  return { x, y: foundY, z, standable: true, solidCeiling }
}

async function reachOpenSky (bot, { isStopped = () => false, home = null, deadlineMs = 60000 } = {}) {
  const deadline = Date.now() + deadlineMs
  const CEIL = DEADLOCK_FALL_H + 2
  const openHere = () => !insideOwnStructure(bot) && !hasSolidCeiling(bot, CEIL, { ignoreLeaves: true })
  if (openHere()) return true
  const anchor = home || hutAnchor() || knownBed()
  if (!anchor) return openHere()
  const bearings = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  for (let r = 8; r <= 12 && Date.now() < deadline && !isStopped(); r += 2) {
    const surfaceY = Math.floor(bot.entity.position.y)
    const cands = []
    for (const [bx, bz] of bearings) {
      const len = Math.hypot(bx, bz) || 1
      const cx = Math.round(anchor.x + (bx / len) * r); const cz = Math.round(anchor.z + (bz / len) * r)
      cands.push(sampleColumnForSky(bot, cx, cz, surfaceY, CEIL))
    }
    const pick = pickOpenSkyCell(cands)
    if (!pick) continue
    dbg('deadlock-reset: walking out to open-sky cell ' + pick.x + ',' + pick.y + ',' + pick.z + ' (r=' + r + ')')
    try { await S().walkStaged(bot, pick.x, pick.z, { isStopped: () => isStopped() || Date.now() > deadline, range: 2, timeoutMs: Math.max(8000, Math.min(30000, deadline - Date.now())) }) } catch {}
    if (openHere()) return true
  }
  return openHere()
}

// §A #76: pillarUpTo needs a filler item in the pack, but deadlockSuicideReset stashes the ENTIRE
// pack into the bank first (the hard "die with an empty pack" safety), so the lethal pillar has
// nothing to place and rises 0 blocks - the fall-suicide is 0-for-4 live. Acquire up to `need` free
// dirt-class blocks AT the suicide cell so the pillar can actually go up. This DELIBERATELY relaxes
// the empty-pack invariant by <=need dirt: that invariant protects GEAR (the :401 leftover-check ran
// BEFORE this and still guards gear), and a few dirt blocks in the grave are free. Bounded by
// deadlineMs + isStopped; guards mirror pillarUpTo/pit-drop (never dig our own support column, the
// wheat-farm footprint, a registered build block, or a cell with water/lava directly above).
async function ensurePillarFiller (bot, { isStopped = () => false, need = DEADLOCK_FALL_H + 2, deadlineMs = 45000 } = {}) {
  if (scaffold.pickFiller(bot)) return true // already have filler - nothing to do
  if (!bot.entity) return false
  const deadline = Date.now() + deadlineMs
  const mcData = require('minecraft-data')(bot.version)
  const DIRT_RE = /^(grass_block|dirt|coarse_dirt|rooted_dirt)$/ // NO sand/gravel - they fall and would bury us
  const ids = ['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt'].map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(x => x != null)
  const feet = bot.entity.position.floored()
  const cands = (bot.findBlocks({ point: bot.entity.position, matching: ids, maxDistance: 6, count: 64 }) || [])
    .filter(p => Math.abs(p.y - feet.y) <= 3) // surface blocks within +-3y of the feet
    .sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
  let dug = 0
  for (const p of cands) {
    if (dug >= need || isStopped() || Date.now() > deadline) break
    if (p.x === feet.x && p.z === feet.z) continue // never dig our own support column
    const b = bot.blockAt(p)
    if (!b || !DIRT_RE.test(b.name)) continue
    if (scaffold.onFarmFootprint(p) || farmFootprintHas(p)) continue // never dig the wheat-farm footprint
    if (!canBreakNaturally(b)) continue // registered build / protected block
    if (bot.canDigBlock && !bot.canDigBlock(b)) continue
    const above = bot.blockAt(p.offset(0, 1, 0))
    if (above && /water|lava/.test(above.name)) continue // don't open a liquid flow onto ourselves
    const tool = toolForBlock(bot, b.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(b) } catch { continue }
    dug++
    try { await stepInto(bot, p, { isStopped }) } catch {} // step onto the dug cell so the dirt drop is picked up
    // pickFiller is truthy after ONE collected dirt, but the lethal pillar needs `need` placements -
    // only stop early once the pack holds enough filler for the whole tower.
    const fillerCount = (bot.inventory ? bot.inventory.items() : []).filter(i => scaffold.FILLER_RE.test(i.name)).reduce((a, i) => a + i.count, 0)
    if (fillerCount >= need) break // enough for the full lethal pillar - stop, don't strip more
  }
  try { await collectDrops(bot, 4) } catch {} // final sweep for any drop we walked past
  return !!scaffold.pickFiller(bot)
}

async function deadlockDieByFall (bot, { isStopped = () => false, home = null, say = () => {} } = {}) {
  if (!bot.entity) return false
  // #76b: the 30s budget predates ensurePillarFiller - walk-out + digging + pillaring consumed all
  // 30s live (00:39Z: both 'pillared +4b' and 'fall did not kill' logged the SAME millisecond - the
  // fall-wait loop never ran, the finally cleared controls, the bot never stepped off). Under the
  // flag give the whole sequence a real budget; flag off -> today's 30s exactly.
  const deadline = Date.now() + (SUICIDE_PILLAR_WORKS ? 90000 : 30000)
  // Clear our own roof/overhang: pillarUpTo no-ops inside our structure, so reach open sky first.
  if (SUICIDE_EXIT_OPEN_SKY) {
    if (insideOwnStructure(bot) || hasSolidCeiling(bot, DEADLOCK_FALL_H + 2, { ignoreLeaves: true })) {
      try { await reachOpenSky(bot, { isStopped, home, deadlineMs: 60000 }) } catch (e) { dbg('deadlock-reset: reachOpenSky threw (' + e.message + ')') }
    }
  } else if (insideOwnStructure(bot) || hasSolidCeiling(bot, 6, { ignoreLeaves: true })) {
    // legacy single 6-block step-out (byte-for-byte when SUICIDE_EXIT_OPEN_SKY=0)
    const h = home || hutAnchor() || knownBed()
    if (h && bot.entity) {
      const dx = bot.entity.position.x - h.x; const dz = bot.entity.position.z - h.z
      const len = Math.hypot(dx, dz) || 1
      const ox = Math.round(h.x + (dx / len) * 6); const oz = Math.round(h.z + (dz / len) * 6)
      try { await S().walkStaged(bot, ox, oz, { isStopped: () => isStopped() || Date.now() > deadline, range: 2, timeoutMs: 60000 }) } catch {}
    }
  }
  if (insideOwnStructure(bot)) {
    // Can't pillar-to-fall under our own roof. §B: try the fallback deaths before the honest abort.
    if (SUICIDE_FALLBACK_DEATH) {
      dbg('deadlock-reset: still under my own roof - trying fallback deaths (drown / pit-drop)')
      let fdied = false
      try { fdied = await deadlockFallbackDeath(bot, { isStopped, home, say }) } catch (e) { dbg('deadlock-reset: fallback death threw (' + e.message + ')') }
      if (fdied) { dbg('deadlock-reset: died on purpose (fallback) - respawn resets to full at the bed'); return true }
      dbg('deadlock-reset: fallback deaths could not kill - ABORTING to hold'); return false
    }
    dbg('deadlock-reset: still under my own roof - can\'t pillar to fall, ABORTING to hold'); return false
  }
  // §A #76: the stash-all emptied the pack, so pillarUpTo has no filler to place (rises 0b - 0-for-4
  // live). Under the flag, dig a few free dirt blocks HERE so the lethal pillar can be built. If none
  // can be dug here (all farm/build/liquid), skip the pillar entirely and chain into the fallbacks.
  if (SUICIDE_PILLAR_WORKS && !scaffold.pickFiller(bot)) {
    let gotFiller = false
    try { gotFiller = await ensurePillarFiller(bot, { isStopped: () => isStopped() || Date.now() > deadline, need: DEADLOCK_FALL_H + 2 }) } catch (e) { dbg('deadlock-reset: ensurePillarFiller threw (' + e.message + ')') }
    if (!gotFiller) {
      dbg('deadlock-reset: no filler for the lethal pillar (pack emptied, none diggable here) - trying fallback deaths')
      if (SUICIDE_FALLBACK_DEATH) {
        let fdied = false
        try { fdied = await deadlockFallbackDeath(bot, { isStopped, home, say }) } catch (e) { dbg('deadlock-reset: fallback death threw (' + e.message + ')') }
        if (fdied) { dbg('deadlock-reset: died on purpose (fallback) - respawn resets to full at the bed'); return true }
      }
      dbg('deadlock-reset: no filler and fallback deaths could not kill - ABORTING to hold'); return false
    }
  }
  const startY = Math.floor(bot.entity.position.y)
  const targetY = startY + Math.max(4, DEADLOCK_FALL_H)
  let died = false
  const onDeath = () => { died = true }
  bot.once('death', onDeath)
  try {
    say('resetting - climbing up to take a lethal fall')
    // §B #76: the suicide path pillars AT an open-sky cell, so pillarUpTo's open-sky early-break
    // would cap the tower at +1b (below the lethal minimum). Under the flag pass ignoreOpenSkyBreak
    // so it climbs to targetY. Flag off -> the opts object is byte-for-byte today's { isStopped }.
    const pillarOpts = { isStopped: () => isStopped() || died || Date.now() > deadline }
    if (SUICIDE_PILLAR_WORKS) pillarOpts.ignoreOpenSkyBreak = true
    try { await pillarUpTo(bot, targetY, pillarOpts) } catch (e) { dbg('deadlock-reset: pillar failed (' + e.message + ')') }
    if (died) { dbg('deadlock-reset: died on purpose - respawn resets to full at the bed'); return true }
    const gained = Math.floor(bot.entity.position.y) - startY
    // Fall damage (points) = fallBlocks - 3; hp is in points (20=full). To guarantee lethality we
    // need gained >= hp+3 (e.g. hp2 -> a 5-block fall = 2 dmg). Abort rather than step off a ledge
    // too short to kill - a survived fall would just waste the attempt (gear is already safe in the
    // bank). DEADLOCK_FALL_H (default 6) gives margin at the hp<=2 trigger.
    const lethalMin = (bot.health != null ? bot.health : DEADLOCK_HP) + 3
    if (gained < lethalMin) {
      // §C #76: a short pillar at open sky used to abort directly - the drown/pit fallbacks were only
      // ever tried from the under-own-roof branch. Under the flag, chain into them before the honest
      // abort. Flag off (or no fallback) -> the exact original single-line abort, byte-for-byte.
      if (SUICIDE_PILLAR_WORKS && SUICIDE_FALLBACK_DEATH) {
        dbg('deadlock-reset: pillar too short for a lethal fall (rose ' + gained + 'b, need ' + lethalMin + 'b at hp ' + (bot.health ?? '?') + ') - trying fallback deaths')
        let fdied = false
        try { fdied = await deadlockFallbackDeath(bot, { isStopped, home, say }) } catch (e) { dbg('deadlock-reset: fallback death threw (' + e.message + ')') }
        if (fdied) { dbg('deadlock-reset: died on purpose (fallback) - respawn resets to full at the bed'); return true }
        dbg('deadlock-reset: pillar too short and fallback deaths could not kill - ABORTING to hold'); return false
      }
      dbg('deadlock-reset: pillar too short for a lethal fall (rose ' + gained + 'b, need ' + lethalMin + 'b at hp ' + (bot.health ?? '?') + ') - ABORTING to hold'); return false
    }
    dbg('deadlock-reset: pillared +' + gained + 'b - stepping off the edge to fall')
    // #76c: FACE the side with the DEEPEST drop before walking off. The r=8 open-sky cell gets
    // reused across attempts, so a PRIOR attempt's leftover tower can stand adjacent and catch
    // the fall 2 blocks down (live 04:54: pillared +6, landed y68 on the old tower, hp1 survived).
    // If NO side offers a lethal drop, don't step at all - go straight to the fallback chain.
    if (SUICIDE_PILLAR_WORKS) {
      const feetNow = bot.entity.position.floored()
      let bestDir = null; let bestDrop = -1
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let drop = 0
        for (let dy = -1; dy >= -(DEADLOCK_FALL_H + 6); dy--) {
          const b = bot.blockAt(new Vec3(feetNow.x + dx, feetNow.y + dy, feetNow.z + dz))
          if (!b || AIRISH(b.name)) drop++
          else break
        }
        if (drop > bestDrop) { bestDrop = drop; bestDir = [dx, dz] }
      }
      if (bestDrop >= 0 && bestDrop < lethalMin) {
        dbg('deadlock-reset: no side of the pillar top drops ' + lethalMin + 'b (best ' + bestDrop + 'b - an old tower/terrain catches the fall) - skipping the step-off')
        if (SUICIDE_FALLBACK_DEATH) {
          let fdied = false
          try { fdied = await deadlockFallbackDeath(bot, { isStopped, home, say }) } catch (e) { dbg('deadlock-reset: fallback death threw (' + e.message + ')') }
          if (fdied) { dbg('deadlock-reset: died on purpose (fallback) - respawn resets to full at the bed'); return true }
        }
        dbg('deadlock-reset: no lethal drop and fallbacks could not kill - ABORTING to hold'); return false
      }
      if (bestDir) { try { await bot.lookAt(new Vec3(feetNow.x + bestDir[0] + 0.5, feetNow.y - 1, feetNow.z + bestDir[1] + 0.5), true) } catch {} }
    }
    bot.clearControlStates()
    bot.setControlState('forward', true)
    const t0 = Date.now()
    while (!died && Date.now() < deadline && Date.now() - t0 < 15000) {
      await new Promise(r => setTimeout(r, 100))
      if (Math.floor(bot.entity.position.y) < startY) bot.setControlState('forward', false) // dropped - stop walking, just fall
    }
    if (died) { dbg('deadlock-reset: died on purpose - respawn resets to full at the bed'); return true }
    // #76b: a survived/timed-out fall used to abort directly (only the SHORT-pillar path chained
    // fallbacks). Chain the drown/pit fallbacks here too before the honest abort; flag off -> the
    // exact original single-line abort.
    if (SUICIDE_PILLAR_WORKS && SUICIDE_FALLBACK_DEATH) {
      dbg('deadlock-reset: fall did not kill within bound (hp ' + (bot.health ?? '?') + ' at y' + Math.floor(bot.entity.position.y) + ') - trying fallback deaths')
      let fdied = false
      try { fdied = await deadlockFallbackDeath(bot, { isStopped, home, say }) } catch (e) { dbg('deadlock-reset: fallback death threw (' + e.message + ')') }
      if (fdied) { dbg('deadlock-reset: died on purpose (fallback) - respawn resets to full at the bed'); return true }
      dbg('deadlock-reset: fall + fallback deaths could not kill - ABORTING to hold'); return false
    }
    dbg('deadlock-reset: fall did not kill within bound - ABORTING to hold'); return false
  } finally { try { bot.removeListener('death', onDeath) } catch {}; bot.clearControlStates() }
}

async function suicideByDrown (bot, { isStopped = () => false, home = null, say = () => {} } = {}) {
  if (!bot.entity) return false
  const here = bot.entity.position.floored()
  const w = recallInfra('water', here, 300)
  if (!w) { dbg('deadlock-reset: no remembered water for the drown fallback'); return false }
  // Verify it is genuinely DEEP (>=2 water blocks stacked at/under the remembered surface cell).
  let depth = 0
  for (let dy = 0; dy < 6; dy++) { const b = bot.blockAt(new Vec3(w.x, w.y - dy, w.z)); if (b && b.name === 'water') depth++; else break }
  if (depth < 2) { dbg('deadlock-reset: remembered water at ' + w.x + ',' + w.z + ' is only ' + depth + ' deep - not drownable'); return false }
  const deadline = Date.now() + 90000
  say('resetting - no open sky to fall; drowning in the pond to reset')
  try { await S().walkStaged(bot, w.x, w.z, { isStopped: () => isStopped() || Date.now() > deadline, range: 2, timeoutMs: 45000 }) } catch {}
  if (isStopped()) return false
  let died = false
  const onDeath = () => { died = true }
  bot.once('death', onDeath)
  try {
    navigate.setDeliberateDrown(true) // arm the reflex latch: escapeWater/escapeToDryLand now no-op
    try { bot.pathfinder.setGoal(null) } catch {}
    // Drive toward the water centre until the head is submerged (jump OFF so buoyancy can't lift us),
    // then release and let the sink hold us under. Re-nudge if we drift out of the water.
    const centre = new Vec3(w.x + 0.5, w.y, w.z + 0.5)
    const submergeDl = Math.min(deadline, Date.now() + 25000)
    while (!died && Date.now() < submergeDl && !isStopped() && !navigate.headInWater(bot)) {
      try { await bot.lookAt(centre, true) } catch {}
      bot.setControlState('forward', true)
      bot.setControlState('jump', false)
      bot.setControlState('sneak', true) // hold position low; never swim up
      await new Promise(r => setTimeout(r, 150))
    }
    bot.clearControlStates()
    // Wait out the drowning (oxygen ~ a few seconds, then ~2 hp/s; lethal fast at the hp<=2 trigger).
    while (!died && Date.now() < deadline && !isStopped()) {
      if (!navigate.headInWater(bot) && !navigate.feetInWater(bot)) { dbg('deadlock-reset: drifted out of the water before drowning - drown fallback failed'); break }
      await new Promise(r => setTimeout(r, 250))
    }
    if (died) { dbg('deadlock-reset: drowned on purpose - respawn resets to full at the bed'); return true }
    dbg('deadlock-reset: drown did not kill within bound - ABORTING this fallback'); return false
  } finally { navigate.setDeliberateDrown(false); try { bot.removeListener('death', onDeath) } catch {}; try { bot.clearControlStates() } catch {} }
}

async function suicideByPitDrop (bot, { isStopped = () => false, home = null, say = () => {} } = {}) {
  if (!bot.entity) return false
  const deadline = Date.now() + 60000
  // Get clear of the hut apron + interior so we never dig the doorstep/footprint.
  try { await stepOffApron(bot, { isStopped, home, tag: 'suicide-pit' }) } catch {}
  if (insideOwnStructure(bot) || onHutApron(bot)) { dbg('deadlock-reset: could not step clear of the hut for a pit - ABORTING this fallback'); return false }
  const feet = bot.entity.position.floored()
  // Pick the first of the 4 compass directions whose forward column is diggable natural terrain and
  // NOT on the wheat-farm footprint, from feet level down 6.
  const DEPTH = Math.max(6, DEADLOCK_FALL_H)
  let dir = null
  for (const [dx, dz] of mining.DIRS) {
    const fx = feet.x + dx; const fz = feet.z + dz
    let ok = true
    for (let dy = -1; dy >= -DEPTH; dy--) {
      const cell = new Vec3(fx, feet.y + dy, fz)
      if (scaffold.onFarmFootprint(cell) || farmFootprintHas(cell) || ownHutAt(cell)) { ok = false; break } // #115: exclusions use the geometric predicate - they must fail PROTECTIVE
      const b = bot.blockAt(cell)
      if (b && /water|lava/.test(b.name)) { ok = false; break }
      if (b && !AIRISH(b.name) && !canBreakNaturally(b)) { ok = false; break } // protected/build block in the shaft
    }
    if (ok) { dir = { dx, dz, fx, fz }; break }
  }
  if (!dir) { dbg('deadlock-reset: no diggable pit column beside the hut - ABORTING this fallback'); return false }
  const digAt = async (v) => {
    const b = bot.blockAt(v)
    if (!b || AIRISH(b.name)) return true
    if (/water|lava/.test(b.name) || !canBreakNaturally(b)) return false
    if (bot.canDigBlock && !bot.canDigBlock(b)) return false
    const tool = toolForBlock(bot, b.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(b) } catch { return false }
    return true
  }
  say('resetting - digging a pit to drop into')
  // Stage A: dig the reachable top of the front shaft (feet-1 .. feet-3).
  for (let dy = -1; dy >= -3 && Date.now() < deadline; dy--) { if (!(await digAt(new Vec3(dir.fx, feet.y + dy, dir.fz)))) { dbg('deadlock-reset: pit stage A blocked - ABORTING this fallback'); return false } }
  // Descend ONE into our own cell to regain reach for the lower shaft.
  const under = new Vec3(feet.x, feet.y - 1, feet.z)
  if (!(scaffold.onFarmFootprint(under) || farmFootprintHas(under) || ownHutAt(under))) { await digAt(under) } // #115: geometric exclusion (fail protective)
  try { await stepInto(bot, under, { isStopped }) } catch {}
  const lowY = Math.floor(bot.entity.position.y)
  // Stage B: from the lower stance, dig the front shaft deeper (down to feet.y-DEPTH).
  for (let y = lowY - 1; y >= feet.y - DEPTH && Date.now() < deadline; y--) { if (!(await digAt(new Vec3(dir.fx, y, dir.fz)))) break }
  // Climb the ONE block back to rim level so the step-off falls the full shaft depth.
  if (Math.floor(bot.entity.position.y) < feet.y) { try { await pillarUpTo(bot, feet.y, { isStopped: () => isStopped() || Date.now() > deadline }) } catch {} }
  // Measure the achieved open drop in the front column from the rim.
  let drop = 0
  for (let dy = -1; dy >= -(DEPTH + 1); dy--) { const b = bot.blockAt(new Vec3(dir.fx, feet.y + dy, dir.fz)); if (!b || AIRISH(b.name)) drop++; else break }
  const lethalMin = (bot.health != null ? bot.health : DEADLOCK_HP) + 3
  if (drop < lethalMin || Math.floor(bot.entity.position.y) < feet.y) { dbg('deadlock-reset: pit only ' + drop + 'b deep (need ' + lethalMin + ') or not at rim - ABORTING this fallback'); return false }
  // Step off the rim into the shaft and fall.
  let died = false
  const onDeath = () => { died = true }
  bot.once('death', onDeath)
  try {
    dbg('deadlock-reset: pit ' + drop + 'b deep at ' + dir.fx + ',' + dir.fz + ' - stepping in to fall')
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    try { await bot.lookAt(new Vec3(dir.fx + 0.5, feet.y - 1, dir.fz + 0.5), true) } catch {}
    bot.setControlState('forward', true)
    const t0 = Date.now()
    while (!died && Date.now() < deadline && Date.now() - t0 < 12000) {
      await new Promise(r => setTimeout(r, 100))
      if (Math.floor(bot.entity.position.y) < feet.y) bot.setControlState('forward', false) // dropped - just fall
    }
    if (died) { dbg('deadlock-reset: pit-dropped on purpose - respawn resets to full at the bed'); return true }
    dbg('deadlock-reset: pit fall did not kill within bound - ABORTING this fallback'); return false
  } finally { try { bot.removeListener('death', onDeath) } catch {}; try { bot.clearControlStates() } catch {} }
}

async function deadlockFallbackDeath (bot, { isStopped = () => false, home = null, say = () => {} } = {}) {
  if (SUICIDE_DROWN) {
    try { if (await suicideByDrown(bot, { isStopped, home, say })) return true } catch (e) { dbg('deadlock-reset: drown fallback threw (' + e.message + ')') }
  }
  try { if (await suicideByPitDrop(bot, { isStopped, home, say })) return true } catch (e) { dbg('deadlock-reset: pit-drop fallback threw (' + e.message + ')') }
  return false
}

async function deadlockSuicideReset (bot, { isStopped = () => false, say = () => {} } = {}) {
  if (_deadlockResetting) return false
  _deadlockResetting = true
  try {
    const home = (() => { try { return hutAnchor() || knownBed() || null } catch { return null } })()
    // 1) STASH ALL. The bank must be reachable - if not, ABORT (holding is strictly safer than
    //    dying with everything and losing it to a far grave). "Reachable" = resolveBankCell finds
    //    a chest, we can walk to it, and we end up standing at a real chest block.
    const cell = resolveBankCell(bot)
    if (!cell) { dbg('deadlock-reset: no hut bank chest - ABORTING (won\'t suicide holding gear)'); return false }
    const anchor = hutAnchor() || cell
    if (bot.entity && bot.entity.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) > 6) {
      try { await S().walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 4, timeoutMs: 180000 }) } catch {}
    }
    if (isStopped()) { dbg('deadlock-reset: stopped before stash - aborting'); return false }
    const blk = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
    if (!blk || !/chest/.test(blk.name)) { dbg('deadlock-reset: bank cell is not a chest - ABORTING'); return false }
    if (bot.entity && bot.entity.position.distanceTo(new Vec3(cell.x, cell.y, cell.z)) > 5) { dbg('deadlock-reset: could not reach the bank chest - ABORTING'); return false }
    const total = (bot.inventory ? bot.inventory.items() : []).reduce((a, i) => a + i.count, 0)
    if (total > 0) {
      const packAll = (bot.inventory ? bot.inventory.items() : []).map(i => ({ name: i.name, count: i.count }))
      dbg('deadlock-reset: stashing ' + total + ' items then dying to reset')
      say('genuinely deadlocked with no food - stashing everything in the bank, then resetting by dying')
      try { await depositMaterials(bot, blk, { deposits: packAll }) } catch (e) { dbg('deadlock-reset: deposit failed (' + e.message + ')') }
      try { await require('./resources.js').readChest(bot, cell) } catch {}
    }
    // HARD SAFETY: the pack MUST be empty before we die. If ANYTHING failed to stash (chest full,
    // slot race), ABORT - dropping it to a grave is exactly what this whole mechanism avoids.
    const leftover = (bot.inventory ? bot.inventory.items() : []).reduce((a, i) => a + i.count, 0)
    if (leftover > 0) { dbg('deadlock-reset: ' + leftover + ' item(s) would NOT stash (chest full?) - ABORTING (won\'t drop gear to a grave)'); return false }
    dbg('deadlock-reset: pack empty (grave will be empty) - proceeding to die by fall')
    // 2) DIE by fall damage (bounded ~30s). Never wedge - abort to holding if it can't die.
    return await deadlockDieByFall(bot, { isStopped, home, say })
  } finally { _deadlockResetting = false }
}

let _recoveringHp = false

async function recoverHp (bot, opts = {}) {
  const isStopped = () => S().isSurvStopped() || (opts.isStopped ? opts.isStopped() : false) // S7: fold the watchdog latch into the abort poll
  const say = opts.say || (() => {})
  const resumeHp = opts.resumeHp != null ? opts.resumeHp : 16
  if (_recoveringHp) return false
  _recoveringHp = true
  S().clearSurvStop(); touchP('recoverHp') // S7 H5c: per-dispatch latch clear + zero-idle at t0
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    // regen needs food>=18 - eat FIRST so the hold below actually heals.
    await eatFromPackToComfortable(bot, isStopped)
    // Get behind cover if it's dark or a mob is near. bedRange 32: sleep in a nearby bed if home
    // is right there, but don't trek 200b through the dark - pit where we stand past that.
    if (isNight(bot) || nearHostile(bot, 16)) { try { await nightRest(bot, { isStopped, say, bedRange: 32 }) } catch {} }
    await eatFromPackToComfortable(bot, isStopped)
    const dl = Date.now() + 180000
    const hp0 = bot.health ?? 20
    let hpPrev = bot.health ?? 20 // S7 H6: a rising hp between 2s passes is the world verifiably healing the bot
    while (!isStopped() && Date.now() < dl) {
      const hp = bot.health ?? 20
      if (hp > hpPrev) touchP('regen') // without this, a legit heal-hold at hp<=6 would trip the 20s/40s crisis window
      hpPrev = hp
      if (hp >= resumeHp) return true
      if (nightStuck(bot)) return false                              // frozen night: hand back, act (re-arm, don't hide)
      if ((bot.food ?? 20) < provFood.REGEN_FOOD_MIN && !hasFood(bot)) return false // can't regen with no food - the food chain owns acquisition (R4 now asks AT this threshold)
      if (hp < hp0 - 2) return false                                 // still taking damage while 'recovering' - release to flee/defend
      await new Promise(r => setTimeout(r, 2000))
    }
    return (bot.health ?? 20) >= resumeHp
  } finally { _recoveringHp = false }
}

function isRecoveringHp () { return _recoveringHp }

let _resting = false

async function restUntilSafe (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const maxFails = opts.maxShelterFails || 4
  let waited = false; let fails = 0
  while ((isNight(bot) || shelterNeeded(bot)) && underArmored(bot) && !nightStuck(bot) && !isStopped() && bot.entity) {
    // FROZEN/ETERNAL NIGHT: stop HOLDING for a dawn that won't come - hand back so the job
    // resumes careful night work (it re-arms first via gearup). Otherwise this loop pinned
    // any job that hit night on a doDaylightCycle-off server for the whole session (live).
    // HOLDING must never mean holding UNDERWATER - the 4s waits between failed rest
    // attempts are exactly where the bot drowned (test server, in its flooded basin)
    if (inWaterNow(bot)) { try { await ensureAshore(bot, isStopped) } catch {} }
    if (!isResting()) {
      let ok = false
      try { ok = await nightRest(bot, opts) } catch {}
      if (ok) { waited = true; fails = 0; continue }
      // nightRest FAILED to shelter (couldn't dig even after relocating, and no reachable
      // bed). Do NOT spin in place forever (the live 4s NO-OP loop): after maxFails, hand
      // back HONESTLY so the CALLER relocates the whole job somewhere it CAN shelter, rather
      // than re-digging the same wet spot. Bounded progress beats an unbounded hold.
      if (++fails >= maxFails) { dbg('restUntilSafe: could not shelter after ' + fails + ' tries (no diggable dry ground / no bed reachable) - handing back so the caller can relocate'); return false }
    }
    if (!waited) { waited = true; dbg('restUntilSafe: HOLDING for the night (another rest active or rest failed - not working in the dark)') }
    await new Promise(r => setTimeout(r, 4000))
  }
  return true
}

function isResting () { return _resting || _sheltering }

// Can the server grant a sleep RIGHT NOW? A pure world-condition read (the same window
// sleepInBedHere enforces) - the condition gate the unconfirmed-spawn re-assert waits on.
function sleepableNow (bot) {
  return ((bot.thunderState || 0) > 0) || !!(bot.time && bot.time.timeOfDay >= 12542 && bot.time.timeOfDay <= 23458)
}

async function sleepInBedHere (bot, { say = () => {}, isStopped = () => false } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const bedIds = Object.values(mcData.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
  const bed = bot.findBlock({ matching: bedIds, maxDistance: 8 })
  if (!bed) {
    // Only forget the bed when we're actually STANDING at the remembered spot and it's
    // gone - a trek that fell short (death, blocked path) used to wipe the memory
    // permanently, and the bot pit-slept for hours with a perfectly good bed 76 blocks
    // away (live, 18:01). Fell-short = keep the memory, pit tonight, try again tomorrow.
    const kb = knownBed()
    const there = kb && Math.hypot(kb.x - bot.entity.position.x, kb.z - bot.entity.position.z) <= 4
    if (there) { dbg('nightRest: bed is GONE from ' + kb.x + ',' + kb.y + ',' + kb.z + ' - forgetting it'); forgetBed() }
    else { dbg('nightRest: fell short of the bed - keeping the memory, pitting tonight'); if (kb) markBedUnusable(kb, shelterSite.BED_HOLD_FELLSHORT_MS, 'fell short of the bed') }
    return false
  }
  // SLEEP-VIABILITY GATE (the "sleep failed (it's not night and it's not a thunderstorm)"
  // spam, live 07-13): bot.sleep only works from timeOfDay ~12542 (or in a thunderstorm),
  // but the shelter reflex fires at the 12200 dusk head-start - so every attempt in that
  // window failed LOUDLY on the reflex's 5s cadence, night after night. Wait QUIETLY at
  // the bed for the sleepable window instead of hammering the server; and plain daytime
  // rain (no thunder) can never become sleepable soon - bail once, silently.
  const canSleepNow = () => ((bot.thunderState || 0) > 0) || (bot.time && bot.time.timeOfDay >= 12542 && bot.time.timeOfDay <= 23458)
  if (!canSleepNow()) {
    const tod = bot.time ? bot.time.timeOfDay : -1
    if (tod >= 11800 && tod < 12542) {
      dbg('nightRest: at the bed ahead of sleep-time (timeOfDay ' + tod + ') - waiting quietly for nightfall')
      if (bot.entity.position.distanceTo(bed.position) > 2.5) { try { await gotoWithTimeout(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 20000) } catch {} }
      const dl = Date.now() + 90000
      while (!canSleepNow() && Date.now() < dl && !isStopped()) {
        if (nearHostile(bot, 10) && underArmored(bot)) { dbg('nightRest: hostiles closing during the dusk wait - pitting instead'); return false }
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    if (!canSleepNow()) { dbg('nightRest: bed here but sleep is impossible right now (timeOfDay ' + (bot.time ? bot.time.timeOfDay : '?') + ', no thunder) - not hammering it'); return false }
  }
  // MOB-BLOCKS-SLEEP PRE-GATE (fix #14): vanilla's monster box is +-8 around the bed head
  // (bed.js) and would refuse anyway - but today a wedge's 'cant click the bed' fires FIRST
  // and masks the monster error entirely, so the /monster/ retry never runs and we loop. A
  // naked bot with a hostile in the wake-radius can't sleep here: hold the bed briefly and pit.
  if (nearHostile(bot, 8) && underArmored(bot)) {
    dbg('nightRest: hostile in the bed wake-radius while under-armored - pitting instead of clicking the bed')
    markBedUnusable(bed.position, shelterSite.BED_HOLD_MONSTER_MS, 'hostile in the wake-radius')
    return false
  }
  let tooFarFails = 0 // #77: only the exhausted case (3 genuine too-far failures) marks the bed
  for (let tries = 0; tries < 3 && !isStopped(); tries++) {
    try {
      if (bot.entity.position.distanceTo(bed.position) > 2.5) { try { await gotoWithTimeout(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 20000) } catch {} }
      await bot.sleep(bed)
      rememberBed(bed.position, { confirmed: true }) // a GRANTED sleep is server evidence: the spawn really moved here
      say('sleeping till morning')
      dbg('nightRest: asleep in bed at ' + bed.position.toString())
      while (bot.isSleeping && isNight(bot) && !isStopped()) { await new Promise(r => setTimeout(r, 2000)) }
      if (!isNight(bot)) { try { await bot.wake() } catch {} ; dbg('nightRest: morning - up and about'); return true }
      dbg('nightRest: woken early (still night) - falling back to shelter')
      return false // kicked out of bed (attacked / player woke us)
    } catch (e) {
      dbg('nightRest: sleep failed (' + e.message + ')')
      const kind = shelterSite.sleepFailKind(e.message) // fix #14: classify so an unusable bed is held, not re-tried forever
      if (kind === 'monsters') {
        // hostiles CLOSE while we're under-armored: don't stand at the bed taking hits
        // for 3 retries (verified on test server: hp 20 -> 17 doing exactly that) - seal
        // a pit right here and let the day burn them off.
        if (nearHostile(bot, 10) && underArmored(bot)) { dbg('nightRest: hostiles at the bed - pitting NOW instead of waiting'); markBedUnusable(bed.position, shelterSite.BED_HOLD_MONSTER_MS, e.message); return false }
        await new Promise(r => setTimeout(r, 6000)); continue // borderline-range mobs may wander off
      }
      if (kind === 'toofar') {
        // #77: 'too far' is a POSITION failure - a competing goal (the concurrent farm goto)
        // dragged us off mid-approach. Kill that goal, re-approach ADJACENT (GoalGetToBlock, not a
        // GoalNear ring - the range-1 ring around a bed block is mostly bed-hitbox/wall cells, so
        // the ring goto no-oped and all 3 clicks re-fired from the same too-far spot, live 00:00Z;
        // mineflayer's ~3b click limit is 3D from EYE height, so standing truly beside the bed is
        // what passes it), then retry via the loop rather than holding this good bed off all night.
        tooFarFails++
        try { bot.pathfinder.setGoal(null) } catch {} // drop the competing goal that dragged us off
        dbg('nightRest: too far from the bed (attempt ' + tooFarFails + '/3) - re-approaching adjacent and retrying')
        try { await gotoWithTimeout(bot, new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z), 15000) } catch {}
        await new Promise(r => setTimeout(r, 300)) // settle before the re-click
        dbg('nightRest: re-approach done - ' + (bot.entity ? bot.entity.position.distanceTo(bed.position).toFixed(1) : '?') + 'b from the bed block (eye-3D is what the click checks)')
        continue
      }
      if (kind === 'unusable') markBedUnusable(bed.position, shelterSite.BED_HOLD_MS, e.message)
      return false // 'transient' keeps today's bare bail (no mark)
    }
  }
  // #77: exhausted all 3 too-far retries - the competing goal kept winning the race. Hold the
  // bed off for the SHORT fell-short span (120s), NOT the 480s night-long unusable hold, and pit
  // tonight. Guarded by flag-on + counter===3 so the flag-off path never marks here (byte-for-byte).
  if (process.env.SLEEP_RETRY_TOOFAR !== '0' && tooFarFails === 3) markBedUnusable(bed.position, shelterSite.BED_HOLD_FELLSHORT_MS, 'too far x3')
  return false
}

async function nightRest (bot, opts = {}) {
  _resting = true
  try { return await nightRestInner(bot, opts) } finally { _resting = false }
}

async function nightRestInner (bot, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  // dusk catches the bot swimming often enough (rivers everywhere) - get to land BEFORE
  // deciding bed-vs-pit, or the pit path dig-fails in a loop while it drowns
  await ensureAshore(bot, isStopped)
  const bed = knownBed()
  // THE CHOKE POINT (fix #14): a bed on an unusable-hold falls straight to the pit with ZERO
  // bed prefix (no ~40s doomed 2x20s goto) - de-looping EVERY nightRest caller without touching
  // a signature. Within the hold window the bed attempt provably can't succeed (position-
  // deterministic reach), so skipping it loses nothing; the bed is never forgotten (retried on
  // hold expiry / next night).
  // BED_HELD_OVERRIDE (default on): the unusable-hold is a reach-failure guard measured from a
  // FARTHER position. If the bot is now RIGHT NEXT to the bed (<=4b, clickable), that stale hold no
  // longer applies - use the bed instead of digging a hole beside it (the live "bed 3 blocks away,
  // on a 2s hold -> pitting instead" dumbness). sleepInBedHere still bails/pits on a real monster or
  // sleep-timing block, so this only recovers the reachable-bed case. =0 -> today's byte-for-byte.
  const bedClickable = bed && bot.entity && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 4
  const bedOk = bed && bot.entity && !_sheltering && (!bedHeld(bed) || (process.env.BED_HELD_OVERRIDE !== '0' && bedClickable))
  if (bedOk) {
    const d = Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z)
    if (d <= (opts.bedRange || 200)) {
      dbg('nightRest: bed remembered at ' + bed.x + ',' + bed.y + ',' + bed.z + ' (' + Math.round(d) + ' blocks) - heading there')
      if (d > 4) {
        say('night time - heading home to sleep')
        if (!await S().walkStaged(bot, bed.x, bed.z, { isStopped, range: 6, timeoutMs: 150000 })) dbg('nightRest: staged trek to bed fell short')
        try { await gotoWithTimeout(bot, new goals.GoalNear(bed.x, bed.y, bed.z, 2), 20000) } catch (e) { dbg('nightRest: final approach to bed failed (' + e.message + ')') }
      }
      if (isStopped()) return false
      if (Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 8) {
        if (await sleepInBedHere(bot, { say, isStopped })) return true
      } else { dbg('nightRest: never reached the bed - pitting where i stand'); markBedUnusable(bed, shelterSite.BED_HOLD_FELLSHORT_MS, 'never reached the bed') }
    } else dbg('nightRest: bed too far (' + Math.round(d) + ' > ' + (opts.bedRange || 200) + ') - pitting here')
  } else if (bed && bedHeld(bed)) {
    dbg('nightRest: bed at ' + bed.x + ',' + bed.y + ',' + bed.z + ' is on an unusable-hold (' + Math.max(0, Math.round((worldMemory.bedHoldUntil() - Date.now()) / 1000)) + 's left) - pitting instead')
  }
  return digInForNight(bot, opts)
}

async function boundedHold (bot, { isStopped = () => false, say = () => {}, deadlineMs = Number(process.env.BOUNDED_HOLD_MS || 90000) } = {}) {
  if (nightStuck(bot)) return { held: false, wake: 'nightStuck' } // eternal night: act, don't wait for a dawn that won't come
  const hut = listInfra('hut')[0] || null
  const bed = knownBed()
  const target = hut ? { x: hut.x + 2, y: hut.y + 1, z: hut.z + 2 } : bed
  if (target && bot.entity) {
    const d = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
    if (d > 4 && d < 250) {
      say("i'm starving and the land is bare - heading home to hole up")
      try { await S().walkStaged(bot, target.x, target.z, { isStopped, range: 6, timeoutMs: 180000 }) } catch {}
    }
    if (hut && !insideOwnStructure(bot) && Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z) <= 12) {
      try {
        const nav = require('./navigate.js')
        await nav.navigateTo(bot, new goals.GoalNear(target.x, target.y, target.z, 1), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 1, water: 1, nudge: 1 }, label: 'famine-home' })
      } catch (e) { dbg('boundedHold: could not get indoors (' + e.message + ')') }
    }
  }
  const indoors = !!insideOwnStructure(bot)
  dbg('boundedHold: holding ' + (indoors ? 'inside my hut' : 'where i am') + ' (food=' + bot.food + ')')
  say('waiting it out at home - too weak to work safely')
  const dl = Date.now() + deadlineMs
  const near = (bot.entity && bot.entity.position) || target || bed
  let sealedPit = false
  // PLAN-one-runner S4: this hold DECLARES itself rather than heartbeating. Same idea S7 H7 had,
  // minus the lie - `touchP('boundedHold')` claimed forward progress every 5s while the bot was
  // deliberately doing nothing. It now names its wakes and its deadline ONCE, both watchdogs read
  // that single declaration (index.js), and the TTL means a crashed executor can never leave an
  // eternal hold standing. The loop body is still the validity check: every named wake below is
  // re-read each pass, so declaring a hold cannot mask a real hang.
  const holdToken = reflexes.beginHold('boundedHold', 'foodInPack|grave|animal<=24|dawn|deadline', deadlineMs + 5000)
  try {
  while (Date.now() < dl && !isStopped()) {
    if (foodCount(bot) > 0 || (bot.food ?? 0) > 4) return { held: true, wake: 'foodInPack' }
    // RE-CHECK THE BANK each pass (FORCE a fresh chest read): banked food a stale cache hid - or
    // food an operator/courier just restocked - is the fastest exit from the hold. Then eat it.
    try { const got = await require('./resources.js').ensureFood(bot, { near, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true }); if (got) await eatUp(bot) } catch (e) { dbg('boundedHold: bank re-check failed (' + e.message + ')') }
    if (foodCount(bot) > 0 || (bot.food ?? 0) > 4) return { held: true, wake: 'foodInPack' }
    // a fresh grave appeared -> release; the ladder's next pass runs R1 (free gear at arm's reach)
    try { const commands = require('./commands.js'); if (commands.worthwhileGrave && commands.worthwhileGrave()) return { held: true, wake: 'grave' } } catch {}
    // an animal wandered into range -> release the hold, the chain re-runs
    if (Object.values(bot.entities || {}).some(e => e && e.position && FOOD_ANIMALS.test((e.name || '').toLowerCase()) && e.position.distanceTo(bot.entity.position) <= 24)) return { held: true, wake: 'animal<=24' }
    // NIGHT -> sleep to dawn (a NAMED wake that provably occurs; starvation stops at half a heart
    // indoors so a slept night at low food survives). Bed within 8b -> sleep it. Otherwise, if
    // EXPOSED (not inside own structure), seal a pit ONCE (digInForNight carries its own dawn wake
    // + hazard bails; the 90s deadline governs only the un-sheltered portions - the I5 intent).
    if (isNight(bot) && bed && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 8) { try { await sleepInBedHere(bot, { say, isStopped }) } catch {} }
    else if (isNight(bot) && !insideOwnStructure(bot) && !sealedPit) { sealedPit = true; try { await digInForNight(bot, { isStopped, say }) } catch (e) { dbg('boundedHold: seal-pit failed (' + e.message + ')') } }
    await new Promise(r => setTimeout(r, 5000))
  }
  } finally { reflexes.endHold(holdToken); touchP('boundedHold:released') } // ONE honest stamp on the way out, so standing up again is not instantly "stale"
  const fed = foodCount(bot) > 0
  return { held: fed, wake: fed ? 'foodInPack' : 'deadline' }
}

// #107 SPAWN_BED. THE single entry point for "the bot has a bed and the server knows it",
// and the one place allowed to decide it cannot have one. Ladder, each rung grounded in a
// real block read, no time windows anywhere:
//
//   stood    - a bed we already asserted still physically stands: nothing to do
//   placed   - a bed exists (or we carry/bank one): lay it in the hut bed cell if a hut
//              stands, else on open ground near home, then activate it to set spawn
//   acquired - we hold no bed at all but the resource model can make one, so we make one
//              and lay it (this rung did not exist - it is the whole point of the change)
//   failed   - honest, and says WHY
//
// The rung that was missing cost 23 deaths in one day: with no bed every death respawned the
// bot 235-350 blocks away and it walked back for ~10 minutes. The old camp step could have
// made a bed - it was carrying 6 wool and a stack of logs - but it counted PLANKS in the pack,
// found none, and logged "no bed and no wool for one" while holding the wool. Nothing below
// counts inventory to make that decision; provision-hut's acquireBed asks the resource model.
async function ensureSpawnBed (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const R = (ok, how, why) => { dbg('spawn: [' + how + '] ' + (why || '')); return { ok, how, why: why || '' } }
  if (!bot.entity) return R(false, 'failed', 'no body yet')
  const m = loadWorldMem()
  const bed = knownBed()
  const hut0 = listInfra('hut')[0]
  const near = opts.near || (hut0 ? { x: hut0.x + 2, y: hut0.y + 1, z: hut0.z + 2 } : bot.entity.position)

  // rung STOOD - CONDITION-gated, never a time window. The old gate was "asserted within the
  // hour", which both re-trekked a perfectly good anchor after 60 minutes and blindly trusted
  // a broken one for 59. What actually matters: we asserted, the anchor is not suspect, and
  // the bed we asserted on still READS as a bed. A null read means the chunk is not loaded -
  // that disproves nothing, so only a far bed gets the benefit of the doubt.
  if (!opts.force && bed && m.bedAssertAt && !isSpawnSuspect()) {
    const bb0 = bot.blockAt(new Vec3(bed.x, bed.y, bed.z))
    const d0 = Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z)
    if (bb0 && /_bed$/.test(bb0.name)) {
      // #110: a standing anchored bed is NEVER touched here - UGLY BEATS ABSENT. This rung
      // answers a SAFETY question ("do I have a working anchor?"), and the quality judgment
      // that used to live here turned an aesthetic defect into a survival action: dig ->
      // forget -> hope to re-lay, executed from a 45s background timer whose caller ignores
      // failure verdicts. It traded a working anchor for none (live 2026-07-19 21:09) and the
      // bot spent the night respawning hundreds of blocks away. Quality is maintenance's
      // business now (provision-hut.upgradeBedPlacement), and only via a COMPLETED swap.
      const v0 = bedUsable(bot, new Vec3(bed.x, bed.y, bed.z)) // pure reads, log-only
      if (!v0.ok) dbg('spawn: the anchor at ' + bed.x + ',' + bed.z + ' is ugly (' + v0.why + ') - KEEPING it; maintenance swaps it when a full swap can complete')
      // A STANDING BED IS NOT A GRANTED SPAWN. Proven live 2026-07-20: a day-clicked bed
      // reported "i set my spawn at this bed" and the next death respawned the bot 462b away
      // at world origin - day-clicking sets nothing on this server, only a granted sleep does.
      // So when the record is unconfirmed we re-assert AT THE NEXT LEGAL OPPORTUNITY. The gate
      // is the world's own sleepability condition (night or thunder), never a timer: in
      // daylight there is nothing to retry, so we say so honestly and wait for the condition.
      if (!bed.confirmed && sleepableNow(bot)) {
        dbg('spawn: the bed at ' + bed.x + ',' + bed.z + ' stands but the server never confirmed the spawn - it is sleepable NOW, re-asserting')
      } else {
        const r0 = R(true, 'stood', 'the bed still stands at ' + bed.x + ',' + bed.z + (bed.confirmed ? ' and the server confirmed the spawn' : ' but the server never confirmed the spawn - re-asserting at nightfall'))
        r0.confirmed = !!bed.confirmed
        return r0
      }
    }
    if (!bb0 && d0 > 48) return R(true, 'stood', 'anchor set; the bed is ' + Math.round(d0) + 'b off, out of read range')
    dbg('spawn: the bed we anchored on no longer reads as a bed - re-anchoring')
  }

  // rung PLACED (hut) - the hut bed cell is the home anchor we WANT. ensureHutBed now runs
  // acquireBed itself, so "no bed in the pack" is no longer the end of this rung.
  const hutRung = async (why) => {
    dbg('spawn: ' + why)
    const r = await ensureHutBed(bot, new Vec3(hut0.x, hut0.y, hut0.z), opts).catch(() => 'fail')
    if (r === 'present') return R(true, 'stood', 'the hut bed is standing and asserted')
    if (r === 'placed') return R(true, 'placed', 'laid the bed in the hut and set spawn on it')
    return null // 'none' / 'fail' -> fall through to the open-ground + acquire rungs
  }

  if (!bed && hut0) {
    const r = await hutRung('no bed remembered at all - the hut bed cell is the play')
    if (r) return r
  } else if (bed && hut0 && Math.hypot(bed.x - (hut0.x + 2), bed.z - (hut0.z + 2)) > 24) {
    // PREFER THE HUT BED: a remembered bed far from the hut is a stale anchor (the overnight
    // carousel re-learned a bed at world spawn and kept "asserting" THERE) - never keep it
    // silently while a home hut exists. The far bed stays an honest fallback below.
    const r = await hutRung('remembered bed ' + bed.x + ',' + bed.z + ' is far from my hut at ' + hut0.x + ',' + hut0.z + ' - re-anchoring at the hut')
    if (r) return r
    dbg('spawn: hut bed unavailable - falling back to the FAR bed at ' + bed.x + ',' + bed.z + ' (better than world spawn)')
  }

  // rung STOOD/PLACED (remembered bed) - walk to the bed we know about and assert on it.
  let bb = null
  if (bed) {
    const d = Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z)
    const maxTrek = opts.maxTrek != null ? opts.maxTrek : 120
    if (d <= maxTrek) {
      if (d > 6) { try { await S().walkStaged(bot, bed.x, bed.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {} }
      bb = bot.blockAt(new Vec3(bed.x, bed.y, bed.z))
      if (!bb || !/_bed$/.test(bb.name)) {
        const md = require('minecraft-data')(bot.version)
        const ids = Object.values(md.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
        const shifted = bot.findBlock({ matching: ids, maxDistance: 12 })
        if (shifted) { bb = shifted; dbg('spawn: remembered bed shifted - found one at ' + shifted.position.toString()) }
        else { dbg('spawn: remembered bed is GONE - laying a new one'); forgetBed(); bb = null }
      }
    } else dbg('spawn: remembered bed too far to assert from here (' + Math.round(d) + 'b)')
  }

  // rung ACQUIRED - no bed block anywhere we can reach. Get one (withdraw > craft) and lay it.
  let how = bb ? 'stood' : null
  if (!bb && !isStopped()) {
    const item = await P().acquireBed(bot, { near, isStopped, say: opts.say }).catch(() => null)
    if (!item) {
      // #117: RECORD THE EXHAUSTED PLAN, so the 'spawn' bootstrap verdict can step aside for
      // armor/base/build instead of re-picking a producer that has nothing left to try. This is
      // an observation scoped to THIS LIFE (world-memory epoch), never a cooldown - a death, or
      // a bed arriving by any route, clears it and the want comes straight back.
      if (!isStopped()) { try { noteBedUnobtainable() } catch {} }
      return R(false, 'failed', 'no bed standing, none banked, and none craftable from what we hold')
    }
    try { clearBedUnobtainable() } catch {}
    how = 'acquired'
    if (hut0) {
      const r = await ensureHutBed(bot, new Vec3(hut0.x, hut0.y, hut0.z), opts).catch(() => 'fail')
      if (r === 'present' || r === 'placed') return R(true, 'acquired', 'made a ' + item.name + ' and set spawn on it in the hut')
      dbg('spawn: hut cell would not take the bed (' + r + ') - laying it on open ground instead')
    }
    bb = await P().placeBedNear(bot, near, { isStopped, say: opts.say }).catch(() => null)
    if (!bb) return R(false, 'failed', 'holding a ' + item.name + ' but found nowhere near home to lay it')
  }
  if (!bb) return R(false, 'failed', 'no bed to anchor on and nothing could be acquired')

  // ASSERT. "On this server a day-time right-click sets it too" was believed for months and is
  // FALSE - disproven live 2026-07-20 (day-click, "i set my spawn at this bed", then a death
  // respawning 462b away at world origin). Only a granted SLEEP or the server's own set_spawn
  // message is evidence, so assertSpawnOn decides, not us. We still click in daylight: it costs
  // nothing, and the bed is worth recording even when the spawn did not move.
  if (bot.entity.position.distanceTo(bb.position) > 2.5) {
    try {
      const nav = require('./navigate.js') // door-assist: the bed lives indoors
      await nav.navigateTo(bot, new goals.GoalNear(bb.position.x, bb.position.y, bb.position.z, 2), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 1, water: 1, nudge: 1 }, label: 'spawn-bed' })
    } catch (e) { return R(false, 'failed', 'cannot reach the bed (' + e.message + ')') }
  }
  try {
    if (isNight(bot) && await sleepInBedHere(bot, opts)) return R(true, how || 'stood', 'slept in the bed - spawn set at ' + bb.position.toString())
    // #110: activateBlock RESOLVING proves the click, not that the server set anything.
    // assertSpawnOn is the one primitive allowed to write the claim, and it writes what it
    // can prove. allowUnconfirmed here because this rung runs exactly when no working anchor
    // is proven - an unconfirmed bed beats none, provided memory says so honestly.
    const a = await assertSpawnOn(bot, bb, { allowUnconfirmed: true, say: opts.say })
    if (!a.ok) return R(false, 'failed', 'could not set spawn on the bed at ' + bb.position.toString() + ' (' + a.why + ')')
    const confirmed = a.how !== 'unconfirmed'
    const r1 = R(true, how || 'stood', confirmed
      ? 'spawn asserted at the bed ' + bb.position.toString() + ' (' + a.how + ')'
      : 'the bed at ' + bb.position.toString() + ' is mine and standing, but the server did NOT confirm a spawn (day-clicking sets nothing here) - re-asserting at nightfall')
    r1.confirmed = confirmed
    return r1
  } catch (e) { return R(false, 'failed', 'bed use failed (' + e.message + ')') }
}

// ---- crossingAdmissible (AUDIT 2026-07-29 FIX 2) ----------------------------------------
// May the bot set out across `dist` blocks right now? Asks the ONE rule (scheduler.journeyAdmissible,
// which shares outboundBlocked with every recovery rung) against a live snapshot.
//
// Both long walks in this file - the homecoming and the spawn re-anchor - used to be unconditional:
// they computed a distance and started walking, whatever the hour, the armour, or how many corpses
// the bot had already left on that route. That is audit LOOP A, and it was the single largest
// killer on the 2026-07-20 tape. This is the probe they now both consult, including BETWEEN LEGS -
// a 470-block crossing takes minutes, and the sun sets during it.
async function crossingAdmissible (bot, dist) {
  try {
    const s = await P().schedulerState(bot)
    return scheduler.journeyAdmissible(s, dist)
  } catch (e) {
    dbg('crossingAdmissible: snapshot failed (' + e.message + ') - allowing the crossing')
    return { ok: true, blockedOn: null, why: 'snapshot unavailable' } // fail OPEN: never strand the bot on a broken read
  }
}

async function recoverSpawnAnchor (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const bed = knownBed()
  const hut = listInfra('hut')[0]
  // aim at the hut when it exists (the bed we want to anchor); a lone far bed otherwise
  const tx = hut ? hut.x + 2 : (bed ? bed.x : null)
  const tz = hut ? hut.z + 2 : (bed ? bed.z : null)
  if (tx == null) { dbg('spawn-recovery: no hut or bed remembered - nowhere to anchor'); return false }
  const dist = () => Math.hypot(tx - bot.entity.position.x, tz - bot.entity.position.z)
  if (dist() > 6) {
    // FIX 2: a wrong spawn anchor is worth a long walk only if the walk is survivable. On the
    // 2026-07-20 tape this was the SECOND unconditional 436b night crossing per respawn, stacked
    // straight after recoverHome's - two chances to die per death.
    const adm = await crossingAdmissible(bot, dist())
    if (!adm.ok) {
      dbg('spawn-recovery: NOT crossing ' + Math.round(dist()) + 'b to re-anchor - ' + adm.why + ' (blocked on ' + adm.blockedOn + ')')
      say(`my spawn is wrong, but ${adm.why} - fixing it once i can cross safely`)
      return false
    }
    say(`my spawn point is wrong - heading home (${Math.round(dist())}b) to fix it before anything else`)
    dbg('spawn-recovery: trekking home ' + Math.round(dist()) + 'b to re-anchor the spawn')
    for (let leg = 0; leg < 3 && dist() > 6 && !isStopped(); leg++) {
      if (leg > 0) {
        const mid = await crossingAdmissible(bot, dist())
        if (!mid.ok) { dbg('spawn-recovery: aborting the crossing mid-way - ' + mid.why); return false }
      }
      try { await S().walkStaged(bot, tx, tz, { isStopped, range: 5, timeoutMs: 300000 }) } catch (e) { dbg('spawn-recovery: trek leg failed (' + e.message + ')') }
    }
  }
  if (dist() > 12) { dbg('spawn-recovery: could not get home (still ' + Math.round(dist()) + 'b out) - will retry next respawn'); return false }
  const ok = (await ensureSpawnBed(bot, { ...opts, force: true, maxTrek: 1e9 })).ok
  dbg('spawn-recovery: ' + (ok ? 'anchor RESTORED at the bed' : 'home but could NOT re-anchor (no usable bed)'))
  return ok
}

function homeRecoveryDecision ({ hut, bed, resumeAt, pos, dist } = {}) {
  const D = dist != null ? dist : Number(process.env.RECOVER_HOME_DIST || 64)
  // Anchor priority: the HUT is true home (its bed is the spawn we want back). A lone
  // remembered bed is next. The persisted build site is a last resort - still far better
  // than stranding at world spawn. Stand-point is +2,+2 into the hut footprint so the trek
  // ends INSIDE (where ensureHutBed lays the bed), not against an outer wall.
  let anchor = null; let source = null
  if (hut) { anchor = { x: hut.x + 2, y: hut.y, z: hut.z + 2 }; source = 'hut' }
  else if (bed) { anchor = { x: bed.x, y: bed.y, z: bed.z }; source = 'bed' }
  else if (resumeAt) { anchor = { x: resumeAt.x, y: resumeAt.y, z: resumeAt.z }; source = 'resume' }
  if (!anchor || !pos) return { anchor, source, dist: null, far: false }
  const d = Math.hypot(anchor.x - pos.x, anchor.z - pos.z)
  return { anchor, source, dist: d, far: d > D }
}

async function recoverHome (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  if (!bot.entity) return { far: false }
  const decision = homeRecoveryDecision({
    hut: hutAnchor(), bed: knownBed(), resumeAt: opts.resumeAt,
    pos: bot.entity.position, dist: opts.dist
  })
  if (!decision.far) { dbg('recoverHome: ' + (decision.anchor ? 'within ' + Math.round(decision.dist) + 'b of the ' + decision.source + ' - already home, nothing to do' : 'no home anchor remembered - nothing to trek to')); return { ...decision, arrived: false } }
  const { anchor } = decision
  // ---- AUDIT 2026-07-29 FIX 2: recovery targets a STATE, not a PLACE ----------------------
  // This walk used to be unconditional and FIRST: whatever the distance, hour, armour or threat,
  // step 1 after every respawn was "trek back before anything else". On 2026-07-20 that walked a
  // naked bot 458-489 blocks through the dark eight times in seven minutes and it died every
  // time - and because the walk owns the body (recoveringHome), the night-shelter reflex it
  // needed was suppressed for the entire loop. The crossing was the death.
  //
  // Nothing is added here to compensate: the walk simply does not start when it is not
  // survivable. The recovery ladder already plans exactly the right thing for a naked bot far
  // from home at night (R0 eat+wear -> R2 digInForNight -> R5 hold, scheduler.recoveryPlan), and
  // the respawn handler already hands it the body. It never got a turn because this function was
  // holding it. Standing down IS the fix.
  const adm = await crossingAdmissible(bot, decision.dist)
  if (!adm.ok) {
    dbg('recoverHome: NOT crossing ' + Math.round(decision.dist) + 'b - ' + adm.why + ' (blocked on ' + adm.blockedOn + ')')
    say(`${Math.round(decision.dist)} blocks from home, but ${adm.why} - getting safe where i stand instead; i'll cross when that clears`)
    return { ...decision, arrived: false, stabilise: true, blockedOn: adm.blockedOn, why: adm.why }
  }
  // The exact line a live watcher greps for.
  say(`landed ${Math.round(decision.dist)} blocks from home - trekking back before anything else`)
  dbg('recoverHome: ' + Math.round(decision.dist) + 'b from the ' + decision.source + ' at ' + anchor.x + ',' + anchor.z + ' - going home before gear-up/gather')
  const distNow = () => Math.hypot(anchor.x - bot.entity.position.x, anchor.z - bot.entity.position.z)
  const arrive = opts.arrive != null ? opts.arrive : 8
  const maxLegs = opts.maxLegs != null ? opts.maxLegs : 12 // bounded so an unreachable home can't wedge us here forever
  // FOOD SURVIVAL EN ROUTE: on a far respawn the pack is EMPTY - respawn only refills the food
  // BAR to 20, which then drains over a long trek (this is exactly what starved the bot to death
  // mid-carousel). Before each leg, if we're getting hungry with nothing to eat, HOLD the trek
  // and secure food (hunt a nearby animal - raw is fine, auto-eat then eats it) rather than push
  // blindly to food 0. Bounded (one animal, ~12s); if the field is empty we press on but at least
  // tried. FOOD_HOLD is generous (<=10) because the remaining trek only burns more.
  const foodHold = Number(process.env.RECOVER_HOME_FOOD_HOLD || 10)
  for (let leg = 0; leg < maxLegs && distNow() > arrive && !isStopped(); leg++) {
    // FIX 2, per leg: a 470b crossing takes minutes and the sun sets during it. Re-ask the same
    // rule before every leg after the first, so a walk that started legal in daylight does not
    // finish as a naked night march (which is precisely how the 08:42 cluster played out).
    if (leg > 0) {
      const mid = await crossingAdmissible(bot, distNow())
      if (!mid.ok) {
        dbg('recoverHome: aborting the crossing at leg ' + leg + ' (' + Math.round(distNow()) + 'b out) - ' + mid.why)
        say(`stopping the walk home - ${mid.why}`)
        return { ...decision, arrived: false, stabilise: true, blockedOn: mid.blockedOn, why: mid.why }
      }
    }
    if (bot.food != null && bot.food <= foodHold && !hasFood(bot)) {
      dbg('recoverHome: hungry en route (food ' + bot.food + ', empty pack) - securing food before pushing on')
      try { const got = await huntForFood(bot, { isStopped }); if (got) { await eatUp(bot).catch(() => {}) ; dbg('recoverHome: hunted + ate en route (food now ' + bot.food + ')') } else dbg('recoverHome: no food animal near the route - pressing on carefully') } catch (e) { dbg('recoverHome: en-route food secure failed (' + e.message + ')') }
    }
    const before = distNow()
    try { await S().walkStaged(bot, anchor.x, anchor.z, { isStopped, range: arrive, timeoutMs: 300000 }) } catch (e) { dbg('recoverHome: trek leg ' + leg + ' failed (' + e.message + ')') }
    if (before - distNow() < 4 && distNow() > arrive) dbg('recoverHome: leg ' + leg + ' made no headway (still ' + Math.round(distNow()) + 'b out)')
  }
  const arrived = distNow() <= Math.max(arrive, 16)
  if (!arrived) { dbg('recoverHome: still ' + Math.round(distNow()) + 'b out after ' + maxLegs + ' legs - giving up honestly, will retry on the next respawn'); return { ...decision, arrived: false } }
  // Home: rebuild the bed if a creeper took it, then FORCE-re-assert the spawn so the NEXT
  // death lands here, not at world spawn. ensureSpawnBed also rebuilds via ensureHutBed, but
  // call ensureHutBed first so the bed physically exists before we try to sleep-anchor on it.
  let bedOk = false
  try {
    const hut = hutAnchor()
    if (hut) await ensureHutBed(bot, new Vec3(hut.x, hut.y, hut.z), { isStopped, say }).catch(() => 'fail')
    bedOk = await ensureSpawnBed(bot, { isStopped, say, force: true, maxTrek: 1e9 }).then(r => !!(r && r.ok)).catch(() => false)
  } catch (e) { dbg('recoverHome: bed re-assert failed (' + e.message + ')') }
  dbg('recoverHome: home - spawn ' + (bedOk ? 're-asserted at the bed (future deaths return here)' : 'could NOT be re-asserted (no usable bed - will retry next respawn)'))
  return { ...decision, arrived: true, bedOk }
}

const RUNG_EXECUTORS = {
  // R0: eat what we carry, then wear every carried piece (bare `wear` = wantAll; never downgrades)
  'eatPack+wearFromPack': async (bot, o) => { await eatUp(bot); try { await require('./commands.js').handle(bot, 'wear') } catch (e) { o.dbg('(ladder) wear failed: ' + e.message) } },
  // R1: fetch the nearest worthwhile grave (recover has its OWN night-shelter-first gate)
  'recoverGrave': async (bot, o) => { await require('./commands.js').handle(bot, 'recover') },
  // R2: get home, eat the cache (forceFresh - the stale-cache fix), cook, eat, bake surplus wheat
  'gotoHome+ensureFood(forceFresh)+cook+eat': async (bot, o) => {
    const home = o.home
    if (home && bot.entity) { try { await S().walkStaged(bot, home.x, home.z, { isStopped: o.isStopped, range: 6, timeoutMs: 180000 }) } catch (e) { o.dbg('(ladder) R2 home trek failed: ' + e.message) } }
    // #62 §A FOOD_BANK_FIRST: hut-anchored bank-cooked-food-first withdraw+eat (the pure-gated
    // deadlock-breaker) BEFORE the generic ensureFood/cook/eat below. FOOD_BANK_FIRST=0 -> skipped.
    if (process.env.FOOD_BANK_FIRST !== '0') { try { await bankFoodFirst(bot, { home, isStopped: o.isStopped, say: o.say }) } catch (e) { o.dbg('(ladder) R2 bank-first failed: ' + e.message) } }
    try { await require('./resources.js').ensureFood(bot, { near: home, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true }) } catch (e) { o.dbg('(ladder) R2 ensureFood failed: ' + e.message) }
    try { if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped: o.isStopped }) } catch {}
    await eatUp(bot)
    if (countItem(bot, 'wheat') >= 3) { try { await bakeBreadFromWheat(bot, { isStopped: o.isStopped, home }); await eatUp(bot) } catch (e) { o.dbg('(ladder) R2 bake failed: ' + e.message) } }
  },
  // R1.5 (#41 RESILIENT_RECOVERY): re-arm from the banked spare set. Walk HOME, withdraw a spare set
  // (fill each bare armor slot + a pick + a sword, best material available), equip the armor (#19).
  // WALK + chest-window + equip ONLY - no dig/place path (anti-grief untouched). Decouples re-arm
  // from a lost/lethal grave (RC-C).
  'rearmFromBank': async (bot, o) => {
    const home = o.home
    const res = require('./resources.js')
    if (home && bot.entity) { try { await S().walkStaged(bot, home.x, home.z, { isStopped: o.isStopped, range: 6, timeoutMs: 180000 }) } catch (e) { o.dbg('(ladder) R1.5 home trek failed: ' + e.message) } }
    if (o.isStopped()) return
    let totals = {}
    try { totals = await res.totalCounts(bot, { near: home, maxDist: 64 }) } catch {}
    const MAT = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']
    const bestArmorName = (slotRe) => { for (const m of MAT) { const nm = Object.keys(totals).find(n => n.startsWith(m + '_') && slotRe.test(n) && totals[n] > 0); if (nm) return nm } return null }
    for (const re of [/helmet$/, /chestplate$/, /leggings$/, /boots$/]) {
      if (o.isStopped()) break
      const nm = bestArmorName(re)
      if (nm) { try { await res.withdrawItems(bot, nm, 1, { near: home, maxDist: 64 }) } catch (e) { o.dbg('(ladder) rearm withdraw ' + nm + ' failed: ' + e.message) } }
    }
    const TOOLMAT = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
    const bestTool = (suffix) => { for (const m of TOOLMAT) { const nm = m + '_' + suffix; if (totals[nm] > 0) return nm } return null }
    for (const suffix of ['pickaxe', 'sword']) {
      if (o.isStopped()) break
      const nm = bestTool(suffix)
      if (nm) { try { await res.withdrawItems(bot, nm, 1, { near: home, maxDist: 64 }) } catch (e) { o.dbg('(ladder) rearm withdraw ' + nm + ' failed: ' + e.message) } }
    }
    try { const wore = await require('./commands.js').equipCarriedArmor(bot); if (wore && wore.length) o.dbg('(ladder) rearm equipped ' + wore.join(',')) } catch (e) { o.dbg('(ladder) rearm equip failed: ' + e.message) }
  },
  // R2 night: sleep to dawn (self-releases at morning) / dig a sealed pit to dawn
  'sleepInBed': async (bot, o) => { await nightRest(bot, { isStopped: o.isStopped, say: o.say }) },
  'digInForNight': async (bot, o) => { await digInForNight(bot, { isStopped: o.isStopped, say: o.say }) },
  // R3: tend/harvest the owned farm (hoe-aware), eat what came off it. courierHome = S6, logged-skip.
  'trekFarm+tend+harvest+courierHome': async (bot, o) => {
    await tendWheatFarm(bot, { isStopped: o.isStopped, say: o.say })
    // #62 §B FOOD_BUFFER_STOCK: BAKE all harvested wheat into bread before eating/couriering, so the
    // harvest actually becomes bankable food (tend alone leaves wheat raw+unshippable). =0 -> skipped.
    if (process.env.FOOD_BUFFER_STOCK !== '0') { try { await bakeBreadFromWheat(bot, { isStopped: o.isStopped, home: o.home }) } catch (e) { o.dbg('(ladder) R3 bake failed: ' + e.message) } }
    await eatUp(bot)
    // S6: courier the food surplus home so a famine recovery restocks the pantry on its way out
    // (the §4.2-step-4 promise). Behind MAINTAIN; MAINTAIN=0 keeps the old logged-skip.
    if (process.env.MAINTAIN !== '0') { try { await courierFoodToBank(bot, { isStopped: o.isStopped, say: o.say }) } catch (e) { o.dbg('(ladder) courier failed: ' + e.message) } }
    else o.dbg('(ladder) courier deferred (MAINTAIN=0)')
  },
  // R3 orchard: harvest the OWN grove (AUDIT 2026-07-29 FIX 9). recoveryPlan has planned this rung
  // since S5 and there has never been an executor for it, so `if (!RUNG_EXECUTORS[r.action]) continue`
  // silently skipped it on EVERY pass - a food source the bot owns, plants and remembers, that the
  // recovery ladder was structurally incapable of eating from. That is why "orchard" appears 9 times
  // in a 13,824-line session. Mirrors the farm rung: go, take what is ripe, eat, courier the rest.
  'trekOrchard+harvest+courierHome': async (bot, o) => {
    const m = (() => { try { return require('./world-memory.js').loadWorldMem() } catch { return {} } })()
    const orch = m && m.orchard
    if (!orch || orch.x == null) { o.dbg('(ladder) R3 orchard: nothing planted/remembered'); return }
    try { await S().walkStaged(bot, orch.x, orch.z, { isStopped: o.isStopped, range: 6, timeoutMs: 180000 }) } catch (e) { o.dbg('(ladder) R3 orchard trek failed: ' + e.message) }
    if (o.isStopped()) return
    // The grove is APPLES + logs: chopping our own trees is the harvest, and gatherLoop's
    // orchard-first path already knows how to take a grown grove and replant it.
    try { await S().gatherLoop(bot, 'oak_log', 8, { isStopped: o.isStopped, say: o.say, home: o.home }) } catch (e) { o.dbg('(ladder) R3 orchard harvest failed: ' + e.message) }
    await eatUp(bot)
    if (process.env.MAINTAIN !== '0') { try { await courierFoodToBank(bot, { isStopped: o.isStopped, say: o.say }) } catch (e) { o.dbg('(ladder) R3 orchard courier failed: ' + e.message) } }
  },
  // R4: acquire NEW supply (hunt->fish->scout). canHold:false - the ladder owns holding (R5).
  // THE HEALING DEAD BAND (2026-07-30): this rung runs because the bot is DEGRADED - it wants food
  // in order to REGENERATE, not merely to keep working. Without an explicit threshold it inherited
  // secureFood's progress default (PROGRESS_FOOD_MIN 14) while recoverHp needs REGEN_FOOD_MIN (18),
  // so 15..17 was a band where the ladder asked for food, the producer said "you have enough", and
  // the bot could not heal. Live: hp 3.17 / food 16, CRISIS UNANSWERED, 20+ minutes.
  // Say WHY we want the food, and the producer answers the right question.
  'secureFood(hunt->fish->scout)': async (bot, o) => { await secureFood(bot, { home: o.home, canHold: false, isStopped: o.isStopped, say: o.say, threshold: provFood.REGEN_FOOD_MIN }) },
  // R5: the one bounded hold (bed-sleep -> hut -> pit; its own preference order covers both variants)
  'boundedHold:sleep': async (bot, o) => { await boundedHold(bot, { isStopped: o.isStopped, say: o.say }) },
  'boundedHold:sealPit': async (bot, o) => { await boundedHold(bot, { isStopped: o.isStopped, say: o.say }) },
  // R5 eternal night: no hold - the no-op just re-loops so R3/R4 run by night (rungFeasible lifts
  // the night gates under nightStuck; the executors carry their own shelter discipline).
  'rerunLadderByNight': async (bot, o) => { o.dbg('(ladder) rerun by night - re-planning') }
}

async function recoveryReadyNow (bot) {
  if (process.env.RESILIENT_RECOVERY === '0') return true
  const commands = require('./commands.js')
  const heldMs = (() => { try { return commands.postDeathRecoveryHeldMs ? commands.postDeathRecoveryHeldMs() : 0 } catch { return 0 } })()
  // HARD CEILING (never hides forever): a bot held longer than RECOVERY_MAX_MS releases the build
  // unconditionally. Unchanged - the ultimate backstop above every other release path.
  if (heldMs > Number(process.env.RECOVERY_MAX_MS || 900000)) { try { commands.clearPostDeathRecovery() } catch {} return true }
  let s = null
  try { s = await P().schedulerState(bot) } catch { s = null }
  // RECOVERY_UNBLOCK (#64): the gear-up-unachievable TIME release. When the bot is SURVIVABLE but the
  // recovery ladder has NO re-arm it can reach (no bank spare kit, no safe grave) and the latch has
  // held for RECOVERY_STUCK_MS, release the build well before the full RECOVERY_MAX_MS ceiling - this
  // is the live post-death stall (naked, empty pack, empty bank, no grave; gearup never gets a turn
  // under the latch so its back-off never arms). Releasing lets the build resume AND frees GEAR_REFLEX
  // to run the iron grind. =0 -> recoveryStuckRelease is false, so only the ceiling above applies.
  if (s) {
    try {
      if (scheduler.recoveryStuckRelease({ hp: s.hp, food: s.food, ladderReArm: scheduler.hasLadderReArm(s), sinceDeathMs: heldMs })) {
        try { commands.clearPostDeathRecovery() } catch {}
        return true
      }
    } catch {}
  }
  let ready = true
  if (s) { try { ready = scheduler.recoveryReady(s).ready } catch { ready = true } }
  if (ready) { try { commands.clearPostDeathRecovery() } catch {} }
  return ready
}

let _recoveringDegraded = false

async function recoverFromDegraded (bot, { isStopped = () => false, say = () => {}, maxMs = Number(process.env.RECOVERY_MAX_MS || 900000), reason } = {}) {
  if (_recoveringDegraded) return { done: false, rungs: [], reason: 'busy' }
  _recoveringDegraded = true
  S().clearSurvStop(); touchP('recoverFromDegraded') // S7 H5c: per-dispatch latch clear + zero-idle at t0
  const rungs = []
  const tried = new Set()
  const deadline = Date.now() + maxMs
  const home = (() => { try { return hutAnchor() || knownBed() || null } catch { return null } })()
  // AUDIT FIX 3: a pass must be able to tell "ran and achieved nothing" from "ran and recovered".
  // It could not, so `NOT recovered (all rungs tried)` was re-dispatched every 60s against an
  // unchanged world, forever (audit §1 LOOP B). `gained` is the honest measure; `blockedOn` is the
  // condition that has to change before another pass could do better; `sig` is what the tick
  // compares to decide whether anything relevant HAS changed.
  let entry = null
  const gainOf = (a, b) => !a || !b ? true : (
    (b.food || 0) > (a.food || 0) || (b.hp || 0) > (a.hp || 0) ||
    (b.armorPieces || 0) > (a.armorPieces || 0) || (b.packFoodPts || 0) > (a.packFoodPts || 0) ||
    (!!(b.tools && b.tools.pick) && !(a.tools && a.tools.pick)) ||
    (!!(b.tools && b.tools.sword) && !(a.tools && a.tools.sword)))
  const stalled = (s) => {
    let blockedOn = 'blocked'
    try { blockedOn = scheduler.ladderBlocker(s) } catch {}
    let sig = ''
    try { sig = scheduler.recoverySignature(s) } catch {}
    const progressed = gainOf(entry, s)
    if (!progressed) dbg('(ladder) NO PROGRESS this pass - blocked on ' + blockedOn + ': ' + scheduler.blockerText(blockedOn))
    return { progressed, blockedOn, sig }
  }
  try {
    while (true) {
      const s = await P().schedulerState(bot)
      if (!entry) entry = s
      _noteDeadlockProgress(bot) // #58: any food/hp gain this cycle clears the deadlock fail counter + no-food streak
      // P4: exit on recoveryReady (hp>=18, food>=14, 4 armor, pick&&sword; best-affordable escape) -
      // NOT the naked-tolerant ladderDone (RC-D). Clearing the exit clears the P0 latch so the build
      // may resume. RESILIENT_RECOVERY=0 restores ladderDone byte-for-byte.
      if (process.env.RESILIENT_RECOVERY !== '0') {
        const rr = scheduler.recoveryReady(s)
        if (rr.ready) { _deadlockFails = 0; try { require('./commands.js').clearPostDeathRecovery() } catch {} return { done: true, rungs, reason: reason || (rr.maxCaution ? 'recovered (best-affordable)' : 'recovered'), maxCaution: rr.maxCaution } }
      } else if (scheduler.ladderDone(s)) { _deadlockFails = 0; return { done: true, rungs, reason: reason || 'recovered' } }
      if (isStopped() || S().isSurvStopped()) return { done: false, rungs, reason: 'stopped', ...stalled(s) } // S7: watchdog fail-job lever folded in
      if (Date.now() > deadline) return { done: false, rungs, reason: 'deadline', ...stalled(s) }
      const plan = scheduler.recoveryPlan(s)
      let chosen = null
      for (const r of plan) {
        if (!scheduler.rungFeasible(r, s)) continue
        if (tried.has(r.action)) continue
        // A planned rung with no executor is a WIRING BUG, not a decision. This line used to be a
        // bare `continue` with the comment "no executor (e.g. trekOrchard) - skip", and that is
        // exactly how the orchard rung was planned on every pass for months while the bot starved
        // next to its own grove. bot/capabilitytest.js now enumerates every action recoveryPlan can
        // emit against this map, in both directions, so reaching here means the contract broke at
        // runtime - which must be the loudest line in the log, not the quietest.
        if (!RUNG_EXECUTORS[r.action]) {
          dbg('(ladder) WIRING BUG: rung ' + r.rung + ':' + r.action + ' was planned and has NO executor - skipping it (capabilitytest.js should have caught this)')
          continue
        }
        chosen = r; break
      }
      // recoveryPlan is TOTAL (>=1 rung, R5 always appended); if every feasible rung is tried,
      // hand back honestly - the tick re-dispatches after its 60s cooldown (the outer retry).
      if (!chosen) {
        // #58 DEADLOCK_RESET: this IS the "NOT recovered (all rungs tried)" point. Bump the deadlock
        // fail counter ONLY when we're genuinely at the deadlock state (hp<=HP & food0 & no pack
        // food); any other state resets it (a normal recoverable crisis must never accumulate). Then
        // the PURE detector decides if a genuine multi-cycle deadlock warrants the last-resort
        // suicide-reset (stash all -> die -> respawn full). Runs LAST, after every ladder rung failed.
        const hp = bot.health != null ? bot.health : 20
        const food = bot.food != null ? bot.food : 20
        // Accumulate the fail counter while genuinely stuck: the HARD floor (hp<=2/food0/no-pack) or,
        // when the soft trigger is on, the broader SOFT equilibrium (hp<=SOFT_HP/food<=SOFT_FOOD/
        // no-pack). Any other state resets it (a normal recoverable crisis must never accumulate).
        // DEADLOCK_RESET_SOFT=0 -> only the hard gate, byte-for-byte.
        const hasPack = foodCount(bot) >= 1
        const inHardDeadlock = hp <= DEADLOCK_HP && food === 0 && !hasPack
        const inSoftDeadlock = DEADLOCK_RESET_SOFT && hp <= DEADLOCK_SOFT_HP && food <= DEADLOCK_SOFT_FOOD && !hasPack
        const inDeadlock = inHardDeadlock || inSoftDeadlock
        if (inDeadlock) _deadlockFails++; else _deadlockFails = 0
        const dstate = deadlockResetState()
        const due = deadlockResetDue(
          { hp, food, hasPackFood: foodCount(bot) >= 1, failCount: _deadlockFails, sinceLastResetMs: Date.now() - (dstate.at || 0) },
          { enabled: process.env.DEADLOCK_RESET !== '0' })
        if (due && (dstate.count || 0) >= DEADLOCK_MAX_NOFOOD) {
          dbg('deadlock-reset: ' + dstate.count + ' resets with no food gained - the food SOURCE is still broken (no water / farm won\'t establish); holding, not spinning suicides')
        } else if (due && !isStopped()) {
          noteDeadlockReset() // stamp the cooldown + no-food streak BEFORE the attempt (an abort still holds off re-firing)
          let ok = false
          try { ok = await deadlockSuicideReset(bot, { isStopped, say }) } catch (e) { dbg('deadlock-reset: threw (' + e.message + ')') }
          return { done: false, rungs, reason: ok ? 'deadlock-reset: died to reset' : 'deadlock-reset aborted (held)', ...stalled(s) }
        }
        return { done: false, rungs, reason: 'all rungs tried', ...stalled(s) }
      }
      tried.add(chosen.action)
      const label = chosen.rung + ':' + chosen.action
      dbg('(ladder) ' + label + ' -> executing')
      // #40 F4.1: on an OUTBOUND rung (trek/tend/secureFood) compose isStopped with an hp-abort so
      // a bot burned to <=6 hp mid-trek/tend/seed-gather BAILS to the next rung (-> R5 bounded hold)
      // instead of farming grass at 1 hp for minutes. Non-outbound rungs (eat/grave/shelter/hold)
      // keep plain isStopped. FOOD_SURVIVAL=0 -> outboundRungAdmissible is always true (today).
      const outbound = process.env.FOOD_SURVIVAL !== '0' && scheduler.OUTBOUND_RE.test(chosen.action || '')
      // FOOD_FLOOR (default on): the hp-abort must NOT forbid the ONE bounded acquisition that ends
      // the starvation (secureFood->fishing) - so at food<=floorFood admit the SECUREFOOD rung
      // regardless of hp. RUNG-AWARE guardrail: pass bot.food ONLY for the secureFood rung; the
      // long trekFarm/trekOrchard trek gets {} -> today's pure hp<=6 abort (the §5 invariant: the
      // farm trek still aborts, only the fishing leg is admitted). FOOD_FLOOR=0 -> {} for all.
      const foodAcqRung = process.env.FOOD_FLOOR !== '0' && /^secureFood/.test(chosen.action || '')
      const rungStopped = outbound
        ? () => isStopped() || !foodSec.outboundRungAdmissible(bot.health, foodAcqRung ? { food: bot.food } : {})
        : isStopped
      try { await RUNG_EXECUTORS[chosen.action](bot, { isStopped: rungStopped, say, home, dbg }) }
      catch (e) { dbg('(ladder) ' + label + ' failed: ' + e.message) }
      rungs.push(label)
      touchP('ladderRung') // S7 H5a: a bounded, live-verified rung completed
    }
  } finally { _recoveringDegraded = false }
}

function isRecoveringDegraded () { return _recoveringDegraded }

module.exports = {
  setDebugSink,
  DEADLOCK_HP, DEADLOCK_MAX_NOFOOD, DEADLOCK_FAILS, DEADLOCK_RESET_SOFT, DEADLOCK_SOFT_HP, DEADLOCK_SOFT_FOOD, DEADLOCK_SOFT_FAILS, DEADLOCK_RESET_COOLDOWN_MS, DEADLOCK_FALL_H, SUICIDE_EXIT_OPEN_SKY, SUICIDE_FALLBACK_DEATH, SUICIDE_DROWN, SUICIDE_PILLAR_WORKS, _deadlockFails, _deadlockResetting, _noteDeadlockProgress, noteDeadlockReset, deadlockResetDue, deadlockResetState, sampleColumnForSky, reachOpenSky, ensurePillarFiller, deadlockDieByFall, suicideByDrown, suicideByPitDrop, deadlockFallbackDeath, deadlockSuicideReset, _recoveringHp, recoverHp, isRecoveringHp, _resting, restUntilSafe, isResting, sleepInBedHere, nightRest, nightRestInner, boundedHold, sleepableNow, ensureSpawnBed, recoverSpawnAnchor, homeRecoveryDecision, recoverHome, RUNG_EXECUTORS, recoveryReadyNow, _recoveringDegraded, recoverFromDegraded, isRecoveringDegraded
}
