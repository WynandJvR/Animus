'use strict'
// SURVIVAL SNAPSHOT: the plain-data view of "how is the bot doing" that the pure decision
// cores consume. Split out of provision.js unchanged.
//
// This is not provisioning. scheduler.js (which job owns the body) and arbiter.js (survive
// over progress) are deliberately PURE - no bot handle, no world reads - so something has to
// walk the live world once per tick and hand them a snapshot. That is this file's whole job:
//   survivalState(bot)   hp/food/threat/shelter/graves/buffers as plain data
//   survivalNeed(bot)    the single most pressing need, via arbiter's authority
//   mayDoProgress(bot)   may a progress job run right now
//   activeJobInfo()      what is running, cheaply (no heavyweight state(bot) build)
//   schedulerState(bot)  the snapshot scheduler.pickJob reads
//
// It sits between the executors and the deciders and depends on both, which is why it moved
// last - every read it does (hasFood, underArmored, shelterNeeded, gravesSnapshot...) had to
// have a home first.
//
// Reads are cheap and side-effect free by design: this runs on the scheduler tick, and
// BODY FIRST means the snapshot must never buy its detail with event-loop budget.

const { Vec3 } = require('vec3')
const arbiter = require('./arbiter.js')     // PURE survival authority
const scheduler = require('./scheduler.js') // PURE tier/preemption decisions
const foodSec = require('./food.js')        // PURE food-security decisions
const maintain = require('./maintain.js')   // PURE buffer floors
const provCore = require('./provision-core.js')
const { countItem, inventoryCounts, isNight, nearHostile, AIRISH, SHELTER_HOSTILE } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, listInfra, knownBed, isSpawnSuspect, gearupState } = worldMemory
const provHut = require('./provision-hut.js')
const { hutAnchor, insideOwnStructure, hasSolidCeiling } = provHut
const provShelter = require('./provision-shelter.js')
const { isSheltering, shelterNeeded, nightStuck, nightRestWanted, underArmored, lowHpCalm,
  armorPieceCount, inWaterNow } = provShelter
const provFood = require('./provision-food.js')
const { hasFood, foodCount, needsFood, isSecuringFood, needFoodSupply, hasStandingFarm } = provFood
const provRecovery = require('./provision-recovery.js')
const { isRecoveringHp, isRecoveringDegraded, isResting, recoveryReadyNow, deadlockResetDue,
  deadlockResetState } = provRecovery
const provMaintain = require('./provision-maintain.js')
const { isMaintaining } = provMaintain
const provMining = require('./provision-mining.js')
const { workingPickCount } = provMining

const P = () => require('./provision.js')

function survivalState (bot) {
  const me = bot.entity && bot.entity.position
  let threatDist = null
  let creeperDist = null // tracked SEPARATELY: a creeper triggers avoidance at a longer range
  if (me) {
    // LOS/reachability gate: a hostile walled off behind solid rock (deep in a cave, on the
    // far side of a shaft wall) is NOT a live progress-block - discount it so a fully-enclosed
    // mob doesn't freeze mining/build forever. Close floor (<=5b) ALWAYS counts (may be right
    // above/below or breaking through); the raycast only runs in the 5..16.5b band so far-mob
    // values stay bit-identical to before. THREAT_LOS=0 disables (blocked stays false).
    const losOn = process.env.THREAT_LOS !== '0'
    const losFloor = parseInt(process.env.THREAT_LOS_FLOOR || '5', 10)
    let los = null
    const eye = me.offset(0, (bot.entity && bot.entity.height) || 1.62, 0)
    const isSolid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!(b && b.boundingBox === 'block' && !AIRISH(b.name)) }
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
      const name = (e.name || '').toLowerCase()
      const d = e.position.distanceTo(me)
      // occlusion: BOTH feet-center and head rays must be blocked to discount (conservative
      // vs 1-block gaps). FAIL-OPEN: any error leaves blocked=false so the mob counts.
      let blocked = false
      if (losOn && d > losFloor && d <= 16.5) {
        try {
          if (!los) los = require('./los.js')
          const feet = los.lineBlocked(eye, e.position.offset(0, 0.5, 0), isSolid)
          const head = feet ? los.lineBlocked(eye, e.position.offset(0, (e.height || 1.6) - 0.1, 0), isSolid) : false
          blocked = feet && head
        } catch { blocked = false }
      }
      if (!arbiter.hostileThreatens(d, blocked, { floor: losFloor })) continue
      if (/creeper/.test(name) && (creeperDist == null || d < creeperDist)) creeperDist = d
      if (!SHELTER_HOSTILE.test(name)) continue
      if (threatDist == null || d < threatDist) threatDist = d
    }
  }
  let drowning = false
  try { const h = me && bot.blockAt(me.floored().offset(0, 1, 0)); drowning = !!(h && /water|seagrass|kelp|bubble_column/.test(h.name)) } catch {}
  return {
    food: bot.food,
    hp: bot.health,
    threatDist,
    creeperDist,
    drowning,
    inLava: !!(bot.entity && bot.entity.isInLava),
    onFire: false, // the auto-defend/hazard reflexes own fire; not a progress-gate need here
    isNight: isNight(bot),
    underArmored: underArmored(bot),
    nightStuck: nightStuck(bot) // frozen/eternal night -> don't surface the "shelter" progress-block
  }
}

function survivalNeed (bot, opts = {}) {
  if (!bot.entity) return null
  const foodThreshold = opts.foodThreshold != null ? opts.foodThreshold : parseInt(process.env.PROGRESS_FOOD_MIN || '14', 10)
  return arbiter.jobSurvivalNeed(survivalState(bot), { ...opts, foodThreshold })
}

function mayDoProgress (bot, opts = {}) { return survivalNeed(bot, opts) == null }

function activeJobInfo () {
  const commands = require('./commands.js')
  const prog = (() => { try { return commands.progressInfo() } catch { return { at: 0, stalled: false } } })()
  const mk = (name, cls, startedAt) => ({
    name,
    cls,
    startedAt: startedAt != null ? startedAt : null,
    lastProgressAt: Math.max(prog.at || 0, startedAt || 0),
    blockedOn: prog.stalled ? 'stalled' : null
  })
  const a = commands.activityInfo && commands.activityInfo()
  if (a && a.name) return mk(a.name, scheduler.commandClass(a.name), a.startedAt)
  if (isRecoveringDegraded()) return mk('recoveryLadder', 'survival', null)
  if (isSecuringFood()) return mk('secureFood', 'survival', null)
  if (isRecoveringHp()) return mk('recoverHp', 'survival', null)
  if (isResting()) return mk('nightShelter', 'survival', null)
  if (isMaintaining()) return mk('maintenancePass', 'maintain', null)
  return null
}

async function schedulerState (bot) {
  const s = {}
  try { Object.assign(s, survivalState(bot)) } catch {} // spread the base survival threat/vitals scan ONCE
  const me = (bot && bot.entity && bot.entity.position) || null
  const home = (() => { try { return hutAnchor() || knownBed() || null } catch { return null } })()
  // packFoodPts: the exact bank foodPoints sum (below), applied to the pack; foodTier<2 gates out
  // rotten/poisonous (BAD_FOOD = tier 2).
  try {
    const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
    let pts = 0
    for (const i of (bot.inventory ? bot.inventory.items() : [])) {
      if (foods[i.name] && foodSec.foodTier(i.name) < 2) pts += (foods[i.name].foodPoints || 0) * i.count
    }
    s.packFoodPts = pts
  } catch { s.packFoodPts = 0 }
  try { s.armorPieces = armorPieceCount(bot) } catch {}
  // rawIron (IRON_KEYSTONE): pack iron in ingot-equivalents (raw smelts 1:1). The bank share is added
  // below from the same cachedOnly totals read. scheduler.ironKeystoneActive reads it to hold the build
  // while a fully-naked bot banks its first boots' worth of iron. Pack-only here; bank folded in later.
  try { s.rawIron = countItem(bot, 'raw_iron') + countItem(bot, 'iron_ingot') } catch { s.rawIron = 0 }
  // packArmorPieces: unworn armor carried in the pack (recoveryPlan R0 wears it). Same armor-name
  // regex the grave notables use (commands.js).
  try {
    s.packArmorPieces = (bot.inventory ? bot.inventory.items() : [])
      .filter(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  } catch { s.packArmorPieces = 0 }
  // #41: a spare (2nd+) sword carried in the pack is a donatable dupe for the banked spare-kit need.
  try { s.spareSwordInPack = (bot.inventory ? bot.inventory.items() : []).filter(i => /_sword$/.test(i.name)).reduce((n, i) => n + i.count, 0) >= 2 } catch { s.spareSwordInPack = false }
  // graves + deathsRecent from the death ledger. LAZY require: commands already requires provision,
  // so a top-level require would be a cycle (established pattern - cf. the inline resources require).
  try {
    const commands = require('./commands.js')
    const g = commands.gravesSnapshot({ pos: me, home })
    s.graves = g.graves; s.deathsRecent = g.deathsRecent
  } catch { s.graves = []; s.deathsRecent = 0 }
  // homeDist: XZ to the hut anchor else the bed; null if neither.
  try { s.homeDist = (me && home) ? Math.hypot(me.x - home.x, me.z - home.z) : null } catch { s.homeDist = null }
  // bankFoodPts: cachedOnly chest counts near home -> foodPoints sum (the live HOME-FOOD-FIRST
  // pattern). cachedOnly is MANDATORY so the tick never walks the bot to open a chest.
  try {
    let totals = {}
    if (home) totals = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: home, maxDist: 64 })
    const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
    let pts = 0
    for (const [n, c] of Object.entries(totals)) if (foods[n]) pts += (foods[n].foodPoints || 0) * c
    s.bankFoodPts = pts
    // #41 RESILIENT_RECOVERY: what the bank holds toward ONE spare set (same cachedOnly read as
    // bankFoodPts - never walks). Feeds maintain.needs(spareKit), scheduler.recoveryReady, and the
    // rearmFromBank rung gate. Absent -> maintain treats spareKit as "not measured" (no spurious need).
    s.bankArmorPieces = Object.entries(totals).filter(([n]) => /_(helmet|chestplate|leggings|boots)$/.test(n)).reduce((a, [, c]) => a + c, 0)
    // IRON_KEYSTONE: fold the banked iron (raw + ingots, 1:1) into rawIron so the keystone reads TOTAL
    // holdings - a bot with 4 iron already banked is NOT on the keystone grind (it can smelt boots now).
    s.rawIron = (s.rawIron || 0) + (totals.raw_iron || 0) + (totals.iron_ingot || 0)
    s.bankHasPick = Object.keys(totals).some(n => /_pickaxe$/.test(n))
    s.bankHasSword = Object.keys(totals).some(n => /_sword$/.test(n))
  } catch { s.bankFoodPts = 0; s.bankArmorPieces = 0; s.bankHasPick = false; s.bankHasSword = false }
  // farm: standing wheat farm + XZ distance to its water anchor.
  try {
    const wf = loadWorldMem().wheatFarm
    s.farm = { exists: hasStandingFarm(), dist: (wf && me) ? Math.hypot(me.x - wf.x, me.z - wf.z) : null }
  } catch { s.farm = { exists: false, dist: null } }
  // orchard: XZ distance + when the grove is next harvestable.
  try {
    const o = loadWorldMem().orchard
    s.orchard = o ? { dist: me ? Math.hypot(me.x - o.x, me.z - o.z) : null, readyAt: o.harvestReadyAt != null ? o.harvestReadyAt : null } : {}
  } catch { s.orchard = {} }
  try { s.gearupBackoffUntil = (gearupState() || {}).until || 0 } catch { s.gearupBackoffUntil = 0 }
  // activeJob: the running activity/survival-latch synthesis (S7: factored into activeJobInfo so the
  // snapshot and the 5s watchdog share ONE definition; lastProgressAt/blockedOn are now REAL data).
  try { s.activeJob = activeJobInfo() } catch { s.activeJob = null }
  try { const commands = require('./commands.js'); s.persistedBuild = !!(commands.persistedResume && commands.persistedResume()) } catch { s.persistedBuild = false }
  // maintain.needs inputs.
  try { s.torches = countItem(bot, 'torch') } catch { s.torches = 0 }
  // tools booleans (S6): pick/sparePick via workingPickCount (>=1/>=2 usable picks); axe/sword
  // via an inventory name scan (/_axe$/ does NOT match /_pickaxe$/). Feeds maintain.needs' tools.
  try {
    const pc = workingPickCount(bot)
    const inv = (bot.inventory ? bot.inventory.items() : [])
    // FIX #20 (TOOL_TIER_UPGRADE, default on): a sword/axe is "adequate" only at STONE tier+ ONCE
    // the bot can mine cobble (has a working pick). A wooden-only sword/axe with a pick in hand
    // reads as a NEED so maintain STEP 7 up-tiers it (wooden->stone) - before, mere existence
    // satisfied it, so a bot that mined cobble carried a wooden sword forever. Never demands an
    // upgrade it can't afford: with NO working pick, wooden stays adequate (can't gather cobble
    // yet) and STEP 7 acquires the pick first anyway. TOOL_TIER_UPGRADE=0 -> existence-only.
    const TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }
    const bestTier = re => inv.filter(i => re.test(i.name)).reduce((m, i) => { const g = /^(wooden|golden|stone|iron|diamond|netherite)_/.exec(i.name); return Math.max(m, g ? (TIER[g[1]] || 0) : 0) }, 0)
    const tierUp = process.env.TOOL_TIER_UPGRADE !== '0'
    const adequate = re => { const bt = bestTier(re); if (bt <= 0) return false; if (!tierUp) return true; return bt >= 2 || pc < 1 }
    s.tools = { pick: pc >= 1, sparePick: pc >= 2, axe: adequate(/_axe$/), sword: adequate(/_sword$/) }
  } catch { s.tools = { pick: false, sparePick: false, axe: false, sword: false } }
  s.homeReachable = s.homeDist != null && s.homeDist <= 48
  // baseLit (#65 BOOTSTRAP_PRIORITY / #69 secureBase): has the home been spawn-proofed yet? A cheap
  // world-mem read (no block scan): true once secureBase has placed its perimeter ring for THIS hut
  // (baseLight.torched), false when a hut exists but the ring is empty, null when there's no hut to
  // secure (not measurable). Only bootstrapNeed reads it, and only when BOOTSTRAP_PRIORITY is on -
  // an extra data field nothing branches on otherwise, so the snapshot stays behaviorally identical.
  try {
    const hut = hutAnchor()
    if (!hut) s.baseLit = null
    else {
      const bl = loadWorldMem().baseLight
      s.baseLit = !!(bl && bl.hut && bl.hut.x === hut.x && bl.hut.z === hut.z && (bl.torched || []).length > 0)
    }
  } catch { s.baseLit = null }
  // maintainNeeded computed LAST on the fully-assembled base snapshot (pure, no cycle). S4 never
  // dispatches maintain; the field exists so pickJob is exercised with real data (S6 = one-line enable).
  try { const maintain = require('./maintain.js'); s.maintainNeeded = maintain.needs(s).length > 0 } catch { s.maintainNeeded = false }
  return s
}

module.exports = { survivalState, survivalNeed, mayDoProgress, activeJobInfo, schedulerState }
