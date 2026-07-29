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
const { loadWorldMem, listInfra, knownBed, isSpawnSuspect, gearupState, bedUnobtainable,
  hutVerifiedNow } = worldMemory
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
// NOTE: sleepableNow is reached via provRecovery.<name> at CALL time, not destructured here -
// provision-recovery requires this module's siblings, so a name captured at load time can be
// undefined (module-map's swallowed-ReferenceError trap).
const provMaintain = require('./provision-maintain.js')
const { isMaintaining } = provMaintain
const provMining = require('./provision-mining.js')
const { workingPickCount } = provMining

const P = () => require('./provision.js')

let dbgSink = null // forwarded from provision.js's setDebugSink (see setDebugSink below)
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[snap] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// ==== AUDIT 2026-07-29 FIX 5: A FAILED READ IS NOT A FACT ==================================
// Every field below used to be wrapped in `try { ... } catch { s.X = <safe-looking default> }`,
// SILENTLY. So a read that failed was recorded as a confident value and nothing anywhere could
// tell the difference between "measured, and it is zero" and "could not measure":
//   catch { s.bankFoodPts = 0; s.bankArmorPieces = 0; ... }  -> "the bank is empty"
//   catch { s.graves = []; s.deathsRecent = 0 }              -> "I have never died"
// Downstream those are not inert: an "empty" bank flips hasLadderReArm, which unblocks the
// outbound treks that rungFeasible exists to gate; "never died" clears the death-spiral guard.
//
// `read` records the failure instead of hiding it: the field is set to the SAME fallback (so no
// consumer changes behaviour on a healthy read), the failure is LOGGED with the field name and
// the error, and the field is listed in `s.unknown` so anything that cares can tell the
// difference. Design principle 10: unmeasured is not unmet - and it is not "fine" either.
function reader (s) {
  s.unknown = []
  return function read (field, fn, fallback) {
    try {
      const v = fn()
      return v
    } catch (e) {
      s.unknown.push(field)
      dbg('read FAILED: ' + field + ' (' + (e && e.message) + ') - recorded as UNKNOWN, using ' + JSON.stringify(fallback))
      return fallback
    }
  }
}

function survivalState (bot) {
  // VITALS FIRST, and outside every try/catch that could take them down with it.
  // survival-snapshot.js:133 wraps this whole function in a swallowing try, so before this an
  // exception anywhere in the threat scan below erased hp, food, isNight, underArmored and
  // nightStuck TOGETHER - and a snapshot with no vitals reads, to every pure decider, as
  // "hp 20, food 20, no threat, daylight, armoured" (they all default a missing vital to 20).
  // Verified: with vitals absent, jobSurvivalNeed returns null, isDegraded is false and a
  // 500-block crossing is admissible. A blind bot must never believe it is a healthy one.
  const vitals = {
    food: bot.food,
    hp: bot.health,
    vitalsKnown: bot.food != null && bot.health != null
  }
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
  // The world-memory-backed flags each get their OWN guard: before, one of them throwing took the
  // vitals with it. They fail to their conservative side and say so.
  let isNightV = false; let underArmoredV = false; let nightStuckV = false
  try { isNightV = isNight(bot) } catch (e) { dbg('read FAILED: isNight (' + e.message + ')') }
  try { underArmoredV = underArmored(bot) } catch (e) { underArmoredV = true; dbg('read FAILED: underArmored (' + e.message + ') - assuming UNDER-ARMOURED (the cautious side)') }
  try { nightStuckV = nightStuck(bot) } catch (e) { dbg('read FAILED: nightStuck (' + e.message + ')') }
  return {
    ...vitals,
    threatDist,
    creeperDist,
    drowning,
    inLava: !!(bot.entity && bot.entity.isInLava),
    onFire: !!(bot.entity && bot.entity.metadata && (bot.entity.metadata[0] & 0x01)), // was hardcoded false - a literal claim nothing measured
    isNight: isNightV,
    underArmored: underArmoredV,
    nightStuck: nightStuckV // frozen/eternal night -> don't surface the "shelter" progress-block
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
  const read = reader(s)
  // The base scan. If it throws, the vitals are re-read DIRECTLY from the body rather than being
  // lost - `bot.health`/`bot.food` are plain numbers that cannot throw, and every pure decider
  // treats a missing vital as full health (scheduler.js:289 etc.), so losing them is the single
  // most dangerous thing this snapshot can do.
  try { Object.assign(s, survivalState(bot)) } catch (e) {
    s.unknown.push('survivalState')
    s.hp = bot.health; s.food = bot.food
    s.vitalsKnown = bot.health != null && bot.food != null
    s.underArmored = true // the cautious side while the scan is broken
    dbg('read FAILED: survivalState (' + e.message + ') - vitals re-read direct from the body; threat/night UNKNOWN this tick')
  }
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
  } catch (e) {
    // NOT "I have never died": deathsRecent 0 clears the death-spiral guard (spiralActive,
    // the anti-spiral rung gate, the death ratchet). Say so instead of asserting it.
    s.unknown.push('graves')
    s.graves = []; s.deathsRecent = 0
    dbg('read FAILED: graves/deathsRecent (' + e.message + ') - the spiral guard is BLIND this tick')
  }
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
  } catch (e) {
    // NOT "the bank is empty". An empty-reading bank flips hasLadderReArm/reArmSourceAvailable to
    // false, which UNBLOCKS the outbound treks rungFeasible exists to gate and lets recoveryReady
    // declare "best-affordable - resuming with max caution". A chest-cache miss must not quietly
    // change survival policy, so the failure is named and the field is flagged unknown.
    s.unknown.push('bank')
    s.bankFoodPts = 0; s.bankArmorPieces = 0; s.bankHasPick = false; s.bankHasSword = false
    dbg('read FAILED: bank totals (' + e.message + ') - reading as empty, but it is UNKNOWN (re-arm/food verdicts are unreliable this tick)')
  }
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
  // #114 ONE_READINESS: the inputs scheduler.buildReady needs, so the CHOOSER can evaluate the
  // build's precondition with the same data the EXECUTOR does (one predicate, one snapshot).
  // All cheap: two in-memory reads that were already on this path (persistedResume, grave ledger)
  // plus the hut-anchor read `home` above already performed. No world scan ([[body-first-priority]]).
  try {
    const commands = require('./commands.js')
    const saved = commands.persistedResume && commands.persistedResume()
    s.persistedBuild = !!saved
    s.buildSite = (saved && saved.at) ? { x: saved.at.x, y: saved.at.y, z: saved.at.z } : null
    s.postDeathRecovery = !!(commands.isPostDeathRecovery && commands.isPostDeathRecovery())
  } catch { s.persistedBuild = false; s.buildSite = null; s.postDeathRecovery = false }
  // recentDeathCells: the P5c spiral window, computed HERE (the caller owns the clock) so
  // buildReady stays pure/clockless. Same 20-min window the old inline gate used.
  try {
    const now = Date.now()
    s.recentDeathCells = require('./grave.js').ledger()
      .filter(d => d && now - (d.at || 0) < 20 * 60000)
      .map(d => ({ x: d.x, z: d.z }))
  } catch { s.recentDeathCells = [] }
  // hutExists: does a hut anchor stand in memory? (#102 CAMP_FIRST's noHut exemption reads this;
  // bootstrapNeed's #103 clause already referenced the field but nothing ever set it.)
  try { s.hutExists = !!hutAnchor() } catch { s.hutExists = false }
  // #119 COMMITMENT_LEDGER (design §3.3): what the bot owes the world, as a number the chooser
  // can score. Anchored on the BODY (falling back to home) because the reclaim candidate's
  // feasibility term IS "how far would I have to walk to pay this".
  // CHEAP BY CONTRACT ([[body-first-priority]]): ledger.summary reads an in-memory Map (the
  // scaffold registry), a cached JSON object (world memory) and an in-memory array (graves).
  // Zero world reads, zero fs, zero awaits - same bar as every other field on this snapshot.
  try {
    s.debt = require('./ledger.js').summary({ near: me || home || { x: 0, y: 0, z: 0 }, maxDist: 256 })
  } catch { s.debt = { value: 0, n: 0, best: null } }
  // ==== #117 HOME_IS_A_NEED (design §3.2 B2) - the HOME facts bootstrapNeed reasons over. ======
  // Every one of these is an in-memory read of a world-memory v2 provenance flag or of bot.time.
  // NOT ONE of them touches a chunk, and that is a requirement, not an accident: this runs on the
  // scheduler tick and BODY FIRST forbids buying snapshot detail with event-loop budget.
  //
  // spawnAnchored is deliberately strict. A bed STANDING is not a spawn the server GRANTED -
  // proven live 2026-07-20, when a day-clicked bed reported "i set my spawn at this bed" and the
  // next death respawned the bot 462 blocks away at world origin. So only a `confirmed` record (a
  // granted sleep, or the server's own set_spawn message, via assertSpawnOn) counts, and a
  // spawnSuspect flag - a respawn that PROVED the anchor wrong - overrides it outright.
  // The remaining fields are what the pure verdict needs to know whether ensureSpawnBed has a rung
  // that can make progress right now, so 'spawn' can never spin on a producer with nothing to do.
  try {
    const kb = knownBed()
    const suspect = isSpawnSuspect()
    s.bedKnown = !!kb
    s.spawnSuspect = !!suspect
    s.spawnAnchored = !!(kb && kb.confirmed === true && !suspect)
    s.bedUnobtainable = bedUnobtainable()
  } catch { s.bedKnown = false; s.spawnSuspect = false; s.spawnAnchored = false; s.bedUnobtainable = false }
  // sleepableNow: can the server grant a sleep RIGHT NOW (night or thunder)? The condition gate
  // the unconfirmed-anchor re-assert waits on - ONE definition, provision-recovery's, reused here.
  try { s.sleepableNow = !!provRecovery.sleepableNow(bot) } catch { s.sleepableNow = false }
  // hutVerified: is the registry hut a structure the bot has SEEN this life, or just a box of
  // coordinates? False is the phantom-hut state the 'shelter' verdict exists to resolve.
  try { s.hutVerified = hutVerifiedNow() } catch { s.hutVerified = false }
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

module.exports = { survivalState, survivalNeed, mayDoProgress, activeJobInfo, schedulerState, setDebugSink }
