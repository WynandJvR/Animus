'use strict'
// MAINTENANCE: the chores the bot does when nothing more urgent is owed - couriering food to
// the bank, safekeeping valuables, banking spare kit, dumping junk, sweeping up scaffold, and
// the pass that sequences them. Split out of provision.js unchanged.
//
// maintain.js holds the PURE buffer model - which buffer is under its floor, and the
// hysteresis band that stops a chore re-firing. This is the executor that goes and does it.
//
// A maintain-class job can NEVER preempt progress (scheduler.js decides that), so everything
// here is interruptible and each step re-checks survivalNeed before continuing. That is why
// the pass is a sequence of small guarded steps rather than one long routine.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const maintain = require('./maintain.js')   // PURE buffer floors + hysteresis
const foodSec = require('./food.js')
const mining = require('./mining.js')
const scaffold = require('./scaffold.js')
const navigate = require('./navigate.js')
const provCore = require('./provision-core.js')
const { AIRISH, countItem, inventoryCounts, toolForBlock, gotoWithTimeout, collectDrops, nearHostile, isNight } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, saveWorldMem, listInfra, rememberInfra, recallInfra, knownBed,
  gearupState, proactiveGearupGate } = worldMemory
const provHut = require('./provision-hut.js')
const { hutAnchor, insideOwnStructure, ownHutAt, maintainHome, secureBase, secureBaseGate } = provHut
const provBank = require('./provision-bank.js')
const { resolveBankCell, depositMaterials, withdrawItem, chestCounts, consolidateBank,
  lonelyFurnace, consolidateFurnaces, litterPatrol } = provBank
const provMining = require('./provision-mining.js')
const { ensureTorches, miningPicks } = provMining
const provFarm = require('./provision-farm.js')
const { WHEAT_FARM_TARGET } = provFarm
const provFood = require('./provision-food.js')
const { hasFood, foodCount, courierFoodToBank, RAW_COOKABLE, cookRawMeat, eatUp,
  bakeBreadFromWheat, ensureFoodSupply } = provFood
const provShelter = require('./provision-shelter.js')
const { underArmored, nightStuck } = provShelter

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

const JUNK_RE = /^(rotten_flesh|spider_eye|poisonous_potato|flint|feather|egg|beetroot_seeds|melon_seeds|pumpkin_seeds|arrow|gunpowder|phantom_membrane|rabbit_hide|rabbit_foot|ink_sac|glow_ink_sac|slime_ball|fermented_spider_eye)$/ // string STAYS (fishing rods!); wheat_seeds stay (the farm)

let _maintaining = false

let _maintStop = false

const _maintState = {} // module-local per-step cadence (stepDue); NOT persisted - a restart re-allows all steps (every step is a no-op when its buffer is fine)

function isMaintaining () { return _maintaining }

function stopMaintenance () { _maintStop = true }

function _setMaintaining (v) { _maintaining = !!v }

async function cleanupScaffold (bot, around, { isStopped = () => false } = {}) {
  // Registry-driven (bot/scaffold.js) + the legacy trail for towers placed before the
  // registry existed. Away from builds only (alsoTrail sweeps ALL own placements).
  const removed = await scaffold.teardown(bot, around, { isStopped, radius: 10, max: 24, alsoTrail: true })
  if (removed) await collectDrops(bot, 6)
  return removed
}

async function dumpJunk (bot) {
  let tossed = 0
  for (const it of (bot.inventory ? bot.inventory.items() : [])) {
    if (!JUNK_RE.test(it.name)) continue
    const n = it.name === 'rotten_flesh' ? it.count - 3 : it.count
    if (n <= 0) continue
    try { await bot.toss(it.type, null, n); tossed += n; await new Promise(r => setTimeout(r, 250)) } catch {}
  }
  // INV_TOOLJUNK: durability-aware TOOL pass - toss worn/obsolete tools, NEVER the last working
  // of a kind (toolIsJunk enforces it). This makes every dumpJunk caller durability-aware for free.
  if (process.env.INV_DISCIPLINE !== '0' && process.env.INV_TOOLJUNK !== '0') {
    try {
      const maintain = require('./maintain.js')
      const junkMinUses = Number(process.env.INV_JUNK_MIN_USES || 10)
      const KIND_RE = [/_pickaxe$/, /_axe$/, /_sword$/, /_shovel$/, /_hoe$/]
      for (const re of KIND_RE) {
        const units = (bot.inventory ? bot.inventory.items() : []).filter(i => re.test(i.name))
          .map(i => ({ item: i, name: i.name, usesLeft: mining.toolUsesLeft(i.name, i.durabilityUsed || 0) }))
        if (units.length <= 1) continue // never risk the last of a kind
        const working = units.filter(u => u.usesLeft >= junkMinUses)
        const bestWorkingTier = working.reduce((t, u) => Math.max(t, maintain.toolTier(u.name)), 0)
        for (const u of units) {
          const workingSameKind = working.filter(w => w.item !== u.item).length
          if (!maintain.toolIsJunk({ name: u.name, usesLeft: u.usesLeft }, { workingSameKind, bestSameKindTier: bestWorkingTier, junkMinUses })) continue
          // belt-and-braces I2: never toss the only working unit of a kind
          if (u.usesLeft >= junkMinUses && working.length <= 1) continue
          try { await bot.toss(u.item.type, null, u.item.count); tossed += u.item.count; await new Promise(r => setTimeout(r, 250)) } catch {}
        }
      }
    } catch {}
  }
  if (tossed) dbg('  dumped ' + tossed + ' junk items (slots free: ' + (bot.inventory ? bot.inventory.emptySlotCount() : '?') + ')')
  return tossed
}

async function safekeepSweep (bot, { isStopped = () => false, say = () => {}, duringBuildOk = false } = {}) {
  if (process.env.MAINT_SAFEKEEP === '0') return 0
  try {
    const commands = require('./commands.js')
    // INV_SHED: a mere persistedResume() (the castle resume persists essentially always since
    // commit 4a4638d) no longer blocks the sweep - only ACTIVE placement does (the activityInfo
    // guard below stays, I3). Flag off => today's saved-build guard.
    const invShed = process.env.INV_DISCIPLINE !== '0' && process.env.INV_SHED !== '0'
    if (!invShed && !duringBuildOk && commands.persistedResume && commands.persistedResume()) { dbg('  safekeep: a saved build exists - not sweeping'); return 0 }
    const a = commands.activityInfo && commands.activityInfo()
    if (a && a.name && /build|schem|wall|tower|house|castle/i.test(a.name)) { dbg('  safekeep: build placement running - not sweeping'); return 0 }
  } catch {}
  const res = require('./resources.js')
  const maintain = require('./maintain.js')
  const cell = resolveBankCell(bot)
  if (!cell) { dbg('  safekeep: no hut bank chest - skipping'); return 0 }
  const hut = hutAnchor()
  const anchor = hut || cell
  if (bot.entity && bot.entity.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) > 6) {
    try { await S().walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {}
  }
  if (isStopped()) return 0
  // INV_TOOLJUNK: toss worn/obsolete tools FIRST so safekeep only ever BANKS good surplus.
  if (process.env.INV_DISCIPLINE !== '0' && process.env.INV_TOOLJUNK !== '0') { try { await dumpJunk(bot) } catch {} }
  // usesLeft per tool. INV_SHED uses the GENERAL helper (covers wooden picks too, so safekeepPlan
  // ranks/ships them correctly); flag off => today's miningPicks (stone+ only).
  const invShedUses = process.env.INV_DISCIPLINE !== '0' && process.env.INV_SHED !== '0'
  const usesByItem = new Map()
  if (invShedUses) {
    for (const it of (bot.inventory ? bot.inventory.items() : [])) {
      if (/_(pickaxe|axe|sword|shovel|hoe)$/.test(it.name)) usesByItem.set(it, mining.toolUsesLeft(it.name, it.durabilityUsed || 0))
    }
  } else {
    for (const p of miningPicks(bot)) usesByItem.set(p.item, p.usesLeft)
  }
  const packItems = (bot.inventory ? bot.inventory.items() : []).map(i => ({ name: i.name, count: i.count, usesLeft: usesByItem.has(i) ? usesByItem.get(i) : undefined }))
  const plan = maintain.safekeepPlan(packItems, {})
  if (!plan.length) { dbg('  safekeep: nothing surplus to stash'); return 0 }
  const blk = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
  if (!blk || !/chest/.test(blk.name)) { dbg('  safekeep: bank cell no longer a chest'); return 0 }
  let n = 0
  try { n = await depositMaterials(bot, blk, { deposits: plan }) } catch (e) { dbg('  safekeep: deposit failed (' + e.message + ')') }
  try { await res.readChest(bot, cell) } catch {}
  if (n) { dbg('  safekeep: stashed ' + n + ' surplus item(s) - departing light'); say('stashing spare kit in the bank before i head out') }
  return n
}

async function spareKitToBank (bot, { isStopped = () => false, say = () => {} } = {}) {
  if (process.env.RESILIENT_RECOVERY === '0' || process.env.SPAREKIT === '0') return 0
  const res = require('./resources.js')
  const maintain = require('./maintain.js')
  const cell = resolveBankCell(bot)
  if (!cell) { dbg('  spareKit: no hut bank chest - skipping'); return 0 }
  const hut = hutAnchor()
  const anchor = hut || cell
  if (bot.entity && bot.entity.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) > 6) {
    try { await S().walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {}
  }
  if (isStopped()) return 0
  // what the bank already holds toward the spare (a REAL read - we're standing at the chest).
  const bankKit = { armorPieces: 0, hasPick: false, hasSword: false }
  try {
    const counts = await res.readChest(bot, cell)
    bankKit.armorPieces = Object.entries(counts || {}).filter(([n]) => /_(helmet|chestplate|leggings|boots)$/.test(n)).reduce((a, [, c]) => a + c, 0)
    bankKit.hasPick = Object.keys(counts || {}).some(n => /_pickaxe$/.test(n))
    bankKit.hasSword = Object.keys(counts || {}).some(n => /_sword$/.test(n))
  } catch {}
  // pack items with usesLeft for tools so the plan keeps the best WORKING pick/sword on the bot.
  const usesByItem = new Map()
  for (const it of (bot.inventory ? bot.inventory.items() : [])) { if (/_(pickaxe|sword)$/.test(it.name)) usesByItem.set(it, mining.toolUsesLeft(it.name, it.durabilityUsed || 0)) }
  const packItems = (bot.inventory ? bot.inventory.items() : []).map(i => ({ name: i.name, count: i.count, usesLeft: usesByItem.has(i) ? usesByItem.get(i) : undefined }))
  const plan = maintain.spareKitCourierPlan(packItems, bankKit, {})
  if (!plan.length) { dbg('  spareKit: bank spare complete / no dupe to donate'); return 0 }
  const blk = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
  if (!blk || !/chest/.test(blk.name)) { dbg('  spareKit: bank cell no longer a chest'); return 0 }
  let n = 0
  try { n = await depositMaterials(bot, blk, { deposits: plan }) } catch (e) { dbg('  spareKit: deposit failed (' + e.message + ')') }
  try { await res.readChest(bot, cell) } catch {}
  if (n) { dbg('  spareKit: banked ' + n + ' spare-kit item(s) - a re-arm floor for the next death'); say('stashing a spare kit in the bank - re-arm insurance') }
  return n
}

async function maintenancePass (bot, opts = {}) {
  if (_maintaining) return { ok: false, steps: [], reason: 'busy' }
  _maintaining = true; _maintStop = false
  touchP('maintenancePass') // S7 H5c: zero-idle at t0
  const say = opts.say || (() => {})
  const nightIndoorOnly = !!opts.nightIndoorOnly
  const opportunistic = !!opts.opportunistic // at-hut window during the build era: home-anchored steps only, and the safekeep build-guard is lifted (the caller paused the build and stands at the bank)
  const steps = []
  const stepDone = (label) => { steps[steps.length] = label; touchP('maintStep') } // S7 H5b: each completed chore sub-step is verified progress (steps[...]= avoids a literal .push so the sweep below leaves this line alone)
  const deadline = Date.now() + Number(process.env.MAINT_PASS_MAX_MS || 600000)
  const crisisFood = Number(process.env.SCHED_CRISIS_FOOD || 6)
  // isStopped: crisis-grade survival probe (unwinds within one executor poll) + the deadline.
  const isStopped = () => {
    if (_maintStop || (opts.isStopped && opts.isStopped()) || Date.now() > deadline) return true
    try { return P().survivalNeed(bot, { foodThreshold: crisisFood }) != null } catch { return false }
  }
  // between steps: the fuller survivalNeed (default threshold 14) - bail honestly to the tick.
  const between = () => { if (isStopped()) return true; try { return P().survivalNeed(bot) != null } catch { return false } }
  const maintain = require('./maintain.js')
  const home = (() => { try { return hutAnchor() || knownBed() || null } catch { return null } })()
  const atHome = () => { try { return !!(home && bot.entity && Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z) <= 24) } catch { return false } }
  const day = () => !isNight(bot)
  const due = (key, ms) => maintain.stepDue(_maintState, key, ms, Date.now()).due
  try {
    let snap = {}
    try { snap = await P().schedulerState(bot) } catch {}
    // the needs list, once (cheap, pure), so each step gate reads the same authority as the tick.
    let needList = []
    try { needList = maintain.needs(snap) } catch {}
    const has = k => needList.some(x => x.key === k)
    const farmUnderTarget = () => { try { const wf = loadWorldMem().wheatFarm; return !!(wf && (wf.cells || []).length > 0 && (wf.cells || []).length < WHEAT_FARM_TARGET && !wf.maxed) } catch { return false } }
    const orchardReady = () => { try { const o = loadWorldMem().orchard; return !!(o && o.harvestReadyAt != null && Date.now() >= o.harvestReadyAt) } catch { return false } }
    const woodLow = async () => { try { const t = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: home, maxDist: 64 }); let n = 0; for (const [k, v] of Object.entries(t)) if (/_planks$|_log$/.test(k)) n += v; return n < 32 } catch { return false } }
    const packTarget = Number(process.env.MAINT_PACKFOOD_TARGET || 24)
    // BREAD_ENGINE: one cheap cachedOnly home-food read per pass (never walks), reused by the
    // STEP 4 bake gate and the STEP 5 reserve observability line. Off = legacy (no read, no gate change).
    const breadEngine = process.env.BREAD_ENGINE !== '0'
    const bankTargetPts = Number(process.env.MAINT_BANKFOOD_TARGET || (breadEngine ? Number(process.env.BREAD_BANK_TARGET || 80) : 40))
    let cachedBankWheat = 0, cachedBankFoodPts = 0
    if (breadEngine) {
      try {
        const t = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: home, maxDist: 64 })
        const mdM = require('minecraft-data')(bot.version); const foodsM = (mdM && mdM.foodsByName) || {}
        cachedBankWheat = t.wheat || 0
        for (const [n, c] of Object.entries(t)) if (foodsM[n]) cachedBankFoodPts += (foodsM[n].foodPoints || 0) * c
      } catch {}
    }

    // STEP 0: safekeep-out - stash spare kit BEFORE any outbound trek leaves the hut.
    if (process.env.MAINT_SAFEKEEP !== '0' && !nightIndoorOnly && atHome()) {
      const outboundDue = (process.env.FOOD_SUPPLY !== '0' && (has('bankFood') || has('packFood') || farmUnderTarget())) ||
                          orchardReady() ||
                          (process.env.GEAR_REFLEX !== '0' && has('armor'))
      if (outboundDue && due('safekeep', 600000)) {
        try { const n = await safekeepSweep(bot, { isStopped, say, duringBuildOk: opportunistic }); if (n) stepDone('safekeep-out(' + n + ')') } catch (e) { dbg('  maint: safekeep-out failed (' + e.message + ')') }
      }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 1: packFood - top the carried buffer up (R2 pattern) + cook/bake + eat.
    if (process.env.FOOD_TOPUP !== '0' && has('packFood') && due('packFood', 600000)) {
      try {
        await require('./resources.js').ensureFood(bot, { near: home, threshold: 20, minPack: 1, maxDist: 64 })
        if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped })
        await bakeBreadFromWheat(bot, { isStopped, home })
        await eatUp(bot)
        stepDone('packFood')
      } catch (e) { dbg('  maint: packFood failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 2: farm - tend + under-target expansion (with the seed top-up). Daylight only.
    // #62 §C FARM_EXPAND_PROACTIVE: ALSO admit the farm step in a SAFE window (under target + hp>=SAFE_HP
    // + fed + day + at/near the farm + no survival crisis), off the 20-min throttle and independent of
    // the maintain need-list, so a CALM bot grows the plot toward WHEAT_FARM_TARGET (33) - it's stuck at
    // ~7 cells because it's only ever crisis-tended. Mirrors #60's proactiveArmor: the pure farmExpandGate
    // owns the guards; ensureFoodSupply's own cell/time budget + isStopped/between bail keep it bounded and
    // YIELD to survival. Held to the same !opportunistic/!nightIndoorOnly envelope (no mid-build/night
    // treks). FARM_EXPAND_PROACTIVE=0 -> proactiveExpand is false (short-circuit) -> byte-for-byte.
    const proactiveExpand = process.env.FARM_EXPAND_PROACTIVE !== '0' && !nightIndoorOnly && !opportunistic && day() && (() => {
      try {
        return foodSec.farmExpandGate({
          underTarget: farmUnderTarget(),
          crisisActive: (() => { try { return P().survivalNeed(bot, { foodThreshold: crisisFood }) != null } catch { return false } })(),
          hp: bot.health,
          fed: (bot.food != null ? bot.food : 20) >= Number(process.env.FARM_EXPAND_FED_MIN || 14),
          day: day(),
          nearFarm: !!(snap.farm && snap.farm.exists && snap.farm.dist != null && snap.farm.dist <= Number(process.env.FARM_EXPAND_NEAR || 48))
        }, { safeHp: Number(process.env.FARM_EXPAND_SAFE_HP || 14) })
      } catch { return false }
    })()
    if ((process.env.FOOD_SUPPLY !== '0' && !nightIndoorOnly && day() && (has('bankFood') || has('packFood') || farmUnderTarget()) && (!opportunistic || (snap.farm && snap.farm.exists && snap.farm.dist != null && snap.farm.dist <= Number(process.env.BREAD_FARM_DIST || (process.env.BREAD_ENGINE !== '0' ? 48 : 32)))) && due('farm', 1200000)) || proactiveExpand) {
      try { await ensureFoodSupply(bot, { home, say, isStopped }); stepDone('farm') } catch (e) { dbg('  maint: farm failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 3: orchard - harvest our OWN grove when ripe AND wood is low. Daylight only.
    if (!nightIndoorOnly && !opportunistic && day() && orchardReady() && await woodLow() && due('orchard', 900000)) {
      try { await P().runGather(bot, (P().detectWood(bot) || 'oak') + '_log', 16, { home, isStopped, say }); stepDone('orchard') } catch (e) { dbg('  maint: orchard failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 4: cook + bake at the (reused hut) furnace.
    if ((Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0) || countItem(bot, 'wheat') >= 3 || (breadEngine && cachedBankFoodPts < bankTargetPts && cachedBankWheat >= 3)) && due('cook', 600000)) {
      try { await cookRawMeat(bot, { isStopped }); await bakeBreadFromWheat(bot, { isStopped, home }); stepDone('cook') } catch (e) { dbg('  maint: cook failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 5: THE COURIER - deposit the food surplus into the bed-adjacent bank.
    if ((has('bankFood') || (snap.packFoodPts || 0) > packTarget) && snap.homeReachable && due('courier', 600000)) {
      try { const n = await courierFoodToBank(bot, { isStopped, say, snap }); if (n) stepDone('courier(' + n + ')') } catch (e) { dbg('  maint: courier failed (' + e.message + ')') }
    }
    if (breadEngine) dbg('  (bread-engine) reserve ' + cachedBankFoodPts + '/' + bankTargetPts + ' pts')
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 5b: safekeep-home - same bank visit as the courier (shares the 'safekeep' window).
    if (process.env.MAINT_SAFEKEEP !== '0' && atHome() && due('safekeep', 600000)) {
      try { const n = await safekeepSweep(bot, { isStopped, say, duringBuildOk: opportunistic }); if (n) stepDone('safekeep(' + n + ')') } catch (e) { dbg('  maint: safekeep failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 5c: spare-kit courier (#41) - bank a SURPLUS spare set (post-death re-arm floor), same
    // bank visit. Deposits only dupes (never the bot's only kit); no-op unless flagged + a surplus.
    if (process.env.RESILIENT_RECOVERY !== '0' && process.env.SPAREKIT !== '0' && has('spareKit') && atHome() && due('spareKit', 600000)) {
      try { const n = await spareKitToBank(bot, { isStopped, say }); if (n) stepDone('spareKit(' + n + ')') } catch (e) { dbg('  maint: spareKit failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // INV_SHED survival hook: a NAKED bot with a cluttered pack frees working room BEFORE gearing
    // up (ensurePackRoom's shed step moves the plank/furnace/spare-tool pile to the bank so STEP 6/7
    // have slots to craft/equip). No new machinery - one existing ensurePackRoom call.
    if (process.env.INV_DISCIPLINE !== '0' && process.env.INV_SHED !== '0' && (snap.armorPieces || 0) < 4 && bot.inventory && bot.inventory.emptySlotCount() < 6) {
      try { const f = await require('./resources.js').ensurePackRoom(bot, 6, { near: home, isStopped }); if (f >= 6) stepDone('shedroom') } catch (e) { dbg('  maint: shedroom failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 6: armor - the GEAR_REFLEX executor, same back-off + nightStuck exception. Outbound.
    // #60 GEARUP_PROACTIVE: ALSO admit this step in a SAFE window (iron on hand + hp>=SAFE_HP + fed +
    // day + at home + no back-off), off the 15-min throttle and independent of the maintain need-list,
    // so the calm-window smelt->craft->equip turns the dead pack iron into worn armor BEFORE a crisis
    // forces the preempt-able attempt the bot kept self-penalizing on. The gate demands iron ON HAND
    // (the fast home smelt, no naked mining excursion) and armorup/gearUp still yield to survival via
    // buildAbort mid-smelt. Held to the same !opportunistic/!nightIndoorOnly envelope as the reactive
    // step (no mid-build/night treks). GEARUP_PROACTIVE=0 -> proactiveArmor is false (short-circuit,
    // the IIFE never runs) -> the admission is byte-for-byte the reactive-only step.
    const proactiveArmor = process.env.GEARUP_PROACTIVE !== '0' && !nightIndoorOnly && !opportunistic && (() => {
      try {
        const gbp = gearupState()
        return proactiveGearupGate({
          armored: (snap.armorPieces != null ? snap.armorPieces : 4) >= 4,
          hasIron: (countItem(bot, 'raw_iron') + countItem(bot, 'iron_ingot')) >= 4,
          hp: bot.health,
          fed: (bot.food != null ? bot.food : 20) >= Number(process.env.GEARUP_FED_MIN || 14),
          day: day(),
          atHome: atHome(),
          backoffActive: !!(gbp && gbp.until > Date.now())
        }, { safeHp: Number(process.env.GEARUP_SAFE_HP || 14) })
      } catch { return false }
    })()
    if ((process.env.GEAR_REFLEX !== '0' && !nightIndoorOnly && !opportunistic && has('armor') && (day() || nightStuck(bot)) && due('armor', 900000)) || proactiveArmor) {
      const gb = gearupState()
      if (!(gb && gb.until > Date.now())) {
        try { const r = await require('./commands.js').handle(bot, 'armorup'); stepDone('armor'); dbg('  maint armor -> ' + String(r || '').split('\n')[0]) } catch (e) { dbg('  maint: armor failed (' + e.message + ')') }
      }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 7: tools - ONE missing tool per pass via the resource model (withdraw > craft > gather).
    if (has('tools') && !nightIndoorOnly && !opportunistic && due('tools', 900000)) {
      const t = snap.tools || {}
      try {
        const res = require('./resources.js')
        if (!t.pick || !t.sparePick) await res.acquire(bot, 'stone_pickaxe', 1, { near: home, isStopped, say })
        else if (!t.axe) await res.acquire(bot, 'stone_axe', 1, { near: home, isStopped, say })
        else if (!t.sword) await res.acquire(bot, process.env.TOOL_TIER_UPGRADE !== '0' ? 'stone_sword' : 'wooden_sword', 1, { near: home, isStopped, say })
        stepDone('tools')
      } catch (e) { dbg('  maint: tools failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 8: torches - withdraw coal+sticks if short, then craft from carried coal+stick.
    if (has('torches') && !nightIndoorOnly && due('torches', 900000)) {
      try {
        const torchTarget = Number(process.env.MAINT_TORCH_TARGET || 8)
        const res = require('./resources.js')
        if (countItem(bot, 'coal') + countItem(bot, 'charcoal') < 1) { try { await res.withdrawItems(bot, 'coal', 8, { near: home, maxDist: 64 }) } catch {} }
        if (countItem(bot, 'stick') < 1) { try { await res.withdrawItems(bot, 'stick', 4, { near: home, maxDist: 64 }) } catch {} }
        await ensureTorches(bot, torchTarget)
        stepDone('torches')
      } catch (e) { dbg('  maint: torches failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 9: homeRepair - the HOME_REPAIR chain when already home (5-min floor via stepDue).
    if (process.env.HOME_REPAIR !== '0' && atHome() && due('homeRepair', 300000)) {
      try { const r = await maintainHome(bot, hutAnchor(), { isStopped, say }); if (r && r.damaged) stepDone('homeRepair') } catch (e) { dbg('  maint: homeRepair failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 9b: SECURE_BASE (#67) - spawn-proof the home in a CALM window. The base had no
    // perimeter light (only mine/farm torches), so it stayed DARK -> mobs spawned all around
    // every night and daylight-proof creepers/spiders lingered to harass the bot AT HOME. This
    // step lights a spawn-proof torch ring around the hut (persisted world-mem cells -> converges
    // across visits, self-heals a blown torch) and re-seals the shell (repairHutStructure). Same
    // admission shape as #60's proactiveArmor: the PURE secureBaseGate owns the guards (day + at
    // home + hp>=SAFE_HP + fed + no crisis); secureBase's own maxPlace budget + isStopped/between
    // keep it BOUNDED and YIELD to survival. Held to the !opportunistic/!nightIndoorOnly envelope
    // (no mid-build/night work). The whole block (step AND its between-guard) is inside the flag
    // gate, so SECURE_BASE=0 -> nothing here runs and no _maintState is touched (byte-for-byte).
    if (process.env.SECURE_BASE !== '0') {
      const secureBaseDue = !nightIndoorOnly && !opportunistic && (() => {
        try {
          return secureBaseGate({
            hp: bot.health,
            fed: (bot.food != null ? bot.food : 20) >= Number(process.env.SECURE_BASE_FED_MIN || 14),
            day: day(),
            atHome: atHome(),
            crisisActive: (() => { try { return P().survivalNeed(bot, { foodThreshold: crisisFood }) != null } catch { return false } })()
          }, { safeHp: Number(process.env.SECURE_BASE_SAFE_HP || 14) })
        } catch { return false }
      })()
      if (secureBaseDue && hutAnchor() && due('secureBase', Number(process.env.SECURE_BASE_EVERY_MS || 1200000))) {
        try { const r = await secureBase(bot, { hut: hutAnchor(), isStopped, say }); if (r && r.placed) stepDone('secureBase(' + r.placed + ')') } catch (e) { dbg('  maint: secureBase failed (' + e.message + ')') }
      }
      if (between()) return { ok: true, steps, reason: 'bail:survival' }
    }

    // STEP 10: furnace consolidation (fix #13 Part A) - reclaim scattered field furnaces
    // (>32 and <=96 from the hut, <=2/pass) via the proven grab() primitive: re-verify the
    // block IS a furnace at dig time + own-tagged/lonely, else skip+forget (NEVER dig a
    // non-furnace or a furnace near anything player-built). Hourly, daytime, at-hut.
    if (process.env.INFRA_CONSOLIDATE !== '0' && !nightIndoorOnly && !opportunistic && day() && hutAnchor() && due('furnaceConsol', 3600000)) {
      try { const n = await consolidateFurnaces(bot, { isStopped, say }); if (n) stepDone('furnaceConsol(' + n + ')') } catch (e) { dbg('  maint: furnaceConsol failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 11: scaffold litter patrol (fix #13 Part B) - walk to ONE far registered scaffold
    // cluster within 64 of home and teardownVerified it (registry-only, FILLER_RE re-read,
    // hut box excluded). Every dig is a cell the bot registered itself. Half-hourly, daytime.
    if (process.env.INFRA_CONSOLIDATE !== '0' && !nightIndoorOnly && !opportunistic && day() && home && due('litterPatrol', 1800000)) {
      try { const n = await litterPatrol(bot, home, { isStopped, say }); if (n) stepDone('litter(' + n + ')') } catch (e) { dbg('  maint: litterPatrol failed (' + e.message + ')') }
    }
    return { ok: true, steps, reason: steps.length ? steps.join('+') : 'nothing due' }
  } finally { _maintaining = false }
}

module.exports = {
  setDebugSink,
  JUNK_RE, _maintaining, _maintStop, _maintState, isMaintaining, stopMaintenance, _setMaintaining, cleanupScaffold, dumpJunk, safekeepSweep, spareKitToBank, maintenancePass
}
