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
const { countItem, isNight, AIRISH, SHELTER_HOSTILE } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, recallInfra, knownBed, isSpawnSuspect, gearupState, bedUnobtainable, hutVerifiedNow } = worldMemory
const provHut = require('./provision-hut.js')
const { hutAnchor } = provHut
const provShelter = require('./provision-shelter.js')
const { nightStuck, underArmored, armorPieceCount } = provShelter
const provFood = require('./provision-food.js')
const { isSecuringFood, securingFoodSince, RAW_COOKABLE } = provFood
// hasStandingFarm is provision-farm's, not provision-food's. Destructured from the wrong
// module it read `undefined`, so s.farm.exists threw into its catch and the snapshot the
// PURE scheduler reads reported "no wheat farm" on every tick, however good the farm was.
const provFarm = require('./provision-farm.js')
const { hasStandingFarm } = provFarm
const provRecovery = require('./provision-recovery.js')
const { isRecoveringHp, isRecoveringDegraded, isResting, recoveringHpSince, recoveringDegradedSince, restingSince } = provRecovery
// NOTE: sleepableNow is reached via provRecovery.<name> at CALL time, not destructured here -
// provision-recovery requires this module's siblings, so a name captured at load time can be
// undefined (module-map's swallowed-ReferenceError trap).
const provMaintain = require('./provision-maintain.js')
const { isMaintaining, maintainingSince } = provMaintain
const provMining = require('./provision-mining.js')
const { workingPickCount } = provMining

const P = () => require('./provision.js')

// §4: one definition of the sink rule; this module still owns its own sink, forwarded from
// provision.js's setDebugSink.
const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[snap]')

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

// reads. This is the ONE place the scattered survival predicates are gathered; every progress
// job consults survivalNeed(bot)/mayDoProgress(bot) instead of its own food/hp/threat checks.
// opts.threats === false skips the entity/LOS scan and leaves threatDist/creeperDist null. That
// exists for ONE caller - excursionState below, which feeds the sync stop-poll of a running
// excursion and is asked many times a second by the nav loops. journeyAdmissible reads no threat
// field, so the scan buys that caller nothing and would buy it with event-loop budget (#8).
// Nothing else may pass it: a null threatDist elsewhere reads as "no mob", which is a lie.
// THE PANTRY, READ SYNC (2026-08-28 18:19): the food-need grade (arbiter.jobSurvivalNeed) is derived from
// pack, bank and animals in sight. The schematic builder asks survivalNeed(bot) every 5s mid-build
// with the SYNC state, which carried none of them - so "unmeasured" kept today's verdict and the
// hut pass paused at food 13 to "secure food" it had no source for. packFoodPts is an inventory
// read; the bank figure is the scheduler tick's last MEASUREMENT (stamped below), used while fresh.
let lastBankFood = { pts: null, at: 0 }
function packFoodPtsOf (bot) {
  try {
    const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
    let pts = 0
    for (const i of (bot.inventory ? bot.inventory.items() : [])) { if (foods[i.name] && foodSec.foodTier(i.name) < 2) pts += (foods[i.name].foodPoints || 0) * i.count }
    return pts
  } catch { return 0 }
}
function survivalState (bot, opts = {}) {
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
  if (me && opts.threats !== false) {
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
  // FOOD ANSWERS IN SIGHT (2026-08-28): animals within 32b - the world's own answer to a food need
  // (arbiter.jobSurvivalNeed: at food 7..13 with an empty pack and bank and nothing to hunt, food is a
  // chore the build outranks, not a crisis). Counted, not judged; an unloaded entity list reads 0.
  let animalsNear = 0
  try { if (me) for (const e of Object.values(bot.entities || {})) { if (e && e.position && e.type === 'animal' && e.position.distanceTo(me) <= 32) animalsNear++ } } catch { animalsNear = 0 }
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
    animalsNear,
    packFoodPts: packFoodPtsOf(bot),
    bankFoodPts: (Date.now() - lastBankFood.at < 60000) ? lastBankFood.pts : null,
    creeperDist,
    drowning,
    inLava: !!(bot.entity && bot.entity.isInLava),
    onFire: !!(bot.entity && bot.entity.metadata && (bot.entity.metadata[0] & 0x01)), // was hardcoded false - a literal claim nothing measured
    isNight: isNightV,
    underArmored: underArmoredV,
    nightStuck: nightStuckV // frozen/eternal night -> don't surface the "shelter" progress-block
  }
}

// ---- excursionState (2026-08-02) ---------------------------------------------------------
// SYNC. The JOURNEY view of the world: survivalState plus the only two facts a journey needs
// that a survival need does not - how far home is, and what time it is.
//
// It exists because scheduler.excursionAdmissible has to be askable from a running excursion's
// `isStopped` poll, which is synchronous; schedulerState is async (it awaits the bank read) and
// can never be asked there. Rather than let the poll hand-roll a snapshot - which is how you get
// a second, drifting definition of homeDist and timeOfDay - this IS where those two are computed,
// and schedulerState folds it in below. One definition of each, two consumers.
//
// WHAT IT DELIBERATELY DOES NOT READ, and what that means (#10 - the omissions are named, not
// silently defaulted). Both are async or costly, and both fail to the CAUTIOUS side here:
//   packFoodPts   absent -> journeyAdmissible's "food <6 with an empty pack" clause can refuse a
//                 >128b excursion while the pack actually holds bread. The bot aborts to the
//                 scheduler, which eats and re-picks: a false stop, never a false GO.
//   bank* holdings absent -> bankHasSpareKit reads false, so the daylight armour clause fires only
//                 on a near SAFE GRAVE with gear - which is a genuine "go get your own kit back"
//                 and not a reason to keep mining new iron.
// homeAnchor / journeyFacts / graveFacts: the reads BOTH snapshots make, extracted so they have
// one definition rather than one copy per snapshot (#4). Each caller still owns how it reports a
// failed read - schedulerState lists it in s.unknown, the poll logs it - because "could not
// measure" means something different to a tick than it does to a bot already out in the field.
function homeAnchor () { try { return hutAnchor() || knownBed() || null } catch { return null } }
// homeDist: XZ to the hut anchor else the bed; null if neither.
// timeOfDay: one property read off `bot.time`, and the reason it matters is out of all
// proportion to its size: scheduler-core.duskProximity is written to ramp 0 -> 1 across
// t=11000..13000, and that ramp is THE seed of the operator's "dusk-recall must EMERGE from
// risk x time-to-nightfall, never a per-path night gate" rule (#65 §1). Without this field it
// falls back to the boolean isNight (t>=13000), so for the whole life of the dynamic core the
// ramp has been dead code and the bot has started heading home at FULL DARK instead of at dusk -
// which is the two minutes that decide whether the walk home is survivable. It is also the
// DEADLINE half of scheduler.homeLeash: without it an excursion has no leash at all.
function journeyFacts (bot, home) {
  const me = (bot && bot.entity && bot.entity.position) || null
  const f = { homeDist: null, timeOfDay: undefined }
  try { f.homeDist = (me && home) ? Math.hypot(me.x - home.x, me.z - home.z) : null } catch { f.homeDist = null }
  try { f.timeOfDay = (bot.time && typeof bot.time.timeOfDay === 'number') ? bot.time.timeOfDay : undefined } catch { f.timeOfDay = undefined }
  return f
}
function graveFacts (pos, home) {
  try { const g = require('./commands.js').gravesSnapshot({ pos, home }); return { graves: g.graves, deathsRecent: g.deathsRecent, failed: null } }
  catch (e) { return { graves: [], deathsRecent: 0, failed: (e && e.message) || 'unknown' } }
}

function excursionState (bot) {
  const s = survivalState(bot, { threats: false })
  const home = homeAnchor()
  Object.assign(s, journeyFacts(bot, home))
  // The spiral clause inside journeyAdmissible is one of the reasons the crossing rule is worth
  // asking outbound at all, and it is blind without deathsRecent. NOT "I have never died": a
  // failed read says so rather than clearing the guard silently (#10).
  const g = graveFacts((bot && bot.entity && bot.entity.position) || null, home)
  s.graves = g.graves; s.deathsRecent = g.deathsRecent
  if (g.failed) dbg('excursionState: graves/deathsRecent read FAILED (' + g.failed + ') - the spiral guard is BLIND for this poll')
  return s
}

// The highest UNMET survival need blocking progress, or null. opts.foodThreshold: 14 to START a
// progress job (default), 6 for a mid-activity CRITICAL bail. THE single authority.
function survivalNeed (bot, opts = {}) {
  if (!bot.entity) return null
  const foodThreshold = opts.foodThreshold != null ? opts.foodThreshold : parseInt(process.env.PROGRESS_FOOD_MIN || '14', 10)
  return arbiter.jobSurvivalNeed(survivalState(bot), { ...opts, foodThreshold })
}

// May a progress job (gearup/build/mine/gather) run RIGHT NOW? False when a SURVIVE need is
// unmet. Callers yield to the need (secure food / flee / shelter) and resume once it's met.
function mayDoProgress (bot, opts = {}) { return survivalNeed(bot, opts) == null }

// async. Every sub-read is individually try/catch-wrapped so a half-broken world yields a PARTIAL
// snapshot (an absent field = "not blocking" per the scheduler contract), never a throw. The bank
// read is cachedOnly (MANDATORY, REDESIGN §11: never walk the bot from a tick). SCHEDULER=0 never
// calls this.
// ACTIVE-JOB SYNTHESIS (S7 §3.3), factored out of schedulerState so BOTH the snapshot AND the 5s
// watchdog interval read ONE definition. SYNC + cheap (no bank reads, no awaits): commands' running
// activity first (classified), else the five survival latches - exactly as before.
//
// ==== lastProgressAt IS THE JOB'S LEDGER, NOT THE PROCESS'S PULSE (2026-08-25) =============
// It used to be `max(the ONE global progress clock, this job's startedAt)`, and that global cell
// was refreshed by ANY touchProgress from ANY subsystem - 8b of motion, a fresh dispatch, a label
// opening, a declared hold, and every nav recovery rung that moved the body at all. So the
// question "is THIS job advancing" was answered with "did anything at all happen to the body",
// and on 2026-08-03 the freeze watchdog's own 2-block rescue wound the clock of the build it was
// rescuing, 32 times, holding the fail rung 45s out of reach for four hours (review D1).
// Now it reads commands.jobProgress(key), the per-jobKey WORK LEDGER: it advances only on a
// world-state delta (production or new ground) and it re-bases on ITS OWN startedAt when the key
// changes - which is what the old `max(..., startedAt)` was reaching for and could not have,
// because a global cell has no idea whose job it is.
// `key` is published here so the watchdog's escalation reducer keys off the SAME string the
// ledger does (#4 - it used to build its own copy of this expression in index.js).
// blockedOn = the §6 nudge marker, now cleared by an ADVANCE rather than by any touch.
// Never throws.
// WHAT SURVIVAL WORK IS ACTUALLY RUNNING - a fact about the WORLD, not about whose body-claim
// happens to wrap it (2026-08-26). These latches are raised by the survival producers themselves,
// so they are true whether the run was dispatched as a SURVIVE-tier job or called from inside a
// PROGRESS one - and the build calls them constantly: resumeBuild's material chain runs secureFood,
// travelFar's inline block runs secureFood and nightRest mid-trek.
//
// activeJobInfo below returns on the FIRST match, and `activityInfo()` (the build) matches first -
// so when the build was running, these latches were never even consulted and the core concluded
// nobody was answering the crisis. It then fired the terminal action and killed the build, which
// was at that moment building a wheat farm TO ANSWER THAT CRISIS. Live 2026-08-26:
//   12:38:21 (build) fishing does nothing here - building the farm so i can actually eat
//   12:38:31 (core) chose terminalAction: TERMINAL: a crisis nobody will answer (secureFood: ...)
//   12:38:31 (sched) TERMINAL terminal - took the body from building(14s)
// index.js's survivalActor comment already states the intent - "what stops the terminal action from
// yanking the body out from under ... a food run that is genuinely feeding us" - it just asked the
// claim registry, which knows who holds the body, not what the body is doing. One definition, two
// callers (§4), and it answers from the latch rather than from the label (§10).
function survivalRunActive () {
  try {
    if (isRecoveringDegraded()) return { key: 'recoveryLadder', label: 'recoveryLadder', since: recoveringDegradedSince() || null }
    if (isSecuringFood()) return { key: 'secureFood', label: 'secureFood', since: securingFoodSince() || null }
    if (isRecoveringHp()) return { key: 'recoverHp', label: 'recoverHp', since: recoveringHpSince() || null }
    if (isResting()) return { key: 'nightShelter', label: 'nightShelter', since: restingSince() || null }
  } catch { /* a latch accessor is a plain boolean read; if it throws, claim nothing */ }
  return null
}

function activeJobInfo () {
  const commands = require('./commands.js')
  const mk = (name, cls, startedAt) => {
    const key = name + '@' + (startedAt || '')
    const prog = (() => { try { return commands.jobProgress(key, startedAt) } catch { return { at: startedAt || 0, stalled: false } } })()
    return {
      name,
      cls,
      key,
      startedAt: startedAt != null ? startedAt : null,
      lastProgressAt: prog.at,
      blockedOn: prog.stalled ? 'stalled' : null
    }
  }
  const a = commands.activityInfo && commands.activityInfo()
  if (a && a.name) return mk(a.name, scheduler.commandClass(a.name), a.startedAt)
  // ...each with the instant ITS OWN LATCH WENT UP as startedAt (2026-08-25, review item 2). These
  // five used to pass null, so the key was 'secureFood@' - the same string on every dispatch - and
  // run #2 of a job inherited run #1's exhausted clock. Only the module that raises a latch knows
  // when it was raised, so that is where the stamp lives (provFood.securingFoodSince et al); a
  // whole-body force-release clears it with the latch, so a released ghost cannot leave one behind.
  const sr = survivalRunActive()
  if (sr) return mk(sr.key, 'survival', sr.since)
  if (isMaintaining()) return mk('maintenancePass', 'maintain', maintainingSince() || null)
  // NO JOB. Close the ledger entry, so the NEXT job of the same name is a NEW job. Filing it
  // HERE keeps one reconciliation point: activeJobInfo is the only caller of jobProgress, and it
  // calls it on every path, with a key or with null.
  try { commands.jobProgress(null, null) } catch {}
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
  {
    const g = graveFacts(me, home)
    s.graves = g.graves; s.deathsRecent = g.deathsRecent
    // NOT "I have never died": deathsRecent 0 clears the death-spiral guard (spiralActive,
    // the anti-spiral rung gate, the death ratchet). Say so instead of asserting it.
    if (g.failed) {
      s.unknown.push('graves')
      dbg('read FAILED: graves/deathsRecent (' + g.failed + ') - the spiral guard is BLIND this tick')
    }
  }
  // homeDist + timeOfDay, through the SAME reads the sync excursion poll makes (journeyFacts).
  Object.assign(s, journeyFacts(bot, home))
  // bankFoodPts: cachedOnly chest counts near home -> foodPoints sum (the live HOME-FOOD-FIRST
  // pattern). cachedOnly is MANDATORY so the tick never walks the bot to open a chest.
  try {
    let totals = {}
    // ==== AN UNREAD CHEST IS NOT AN EMPTY BANK (2026-08-02) =============================
    // Every bank field below is a LOWER BOUND, because a chest nobody has ever managed to
    // open contributes nothing to the tally. Until now that was indistinguishable from a
    // chest opened and found bare, and the difference is not cosmetic: with the bank chest
    // sealed by a block dropped on its lid, `bankFoodPts` read 0 forever, bootstrapNeed held
    // the castle on 'food', and the recovery ladder skipped its rearmFromBank rung and went
    // mining for iron the bank already held. `bankUnknownChests` is the field that makes the
    // difference sayable - and #10 puts the burden on the CONSUMER: a field that was never
    // measured must never invent a need. The cachedOnly contract is untouched (the tick still
    // never walks the bot); the answer to an unread bank is to REPORT the uncertainty and let
    // an owner that already walks - maintenancePass, the ladder's rearmFromBank - go and look.
    let det = { chests: 0, read: 0, unknown: 0 }
    if (home) { det = await require('./resources.js').totalCountsDetailed(bot, { cachedOnly: true, near: home, maxDist: 64 }); totals = det.counts }
    s.bankChests = det.chests
    s.bankUnknownChests = det.unknown
    if (det.unknown > 0) {
      s.unknown.push('bank')
      dbg('bank PARTIAL: ' + det.unknown + '/' + det.chests + ' chest(s) near home have never been read - every bank* field below is a LOWER BOUND, not a measurement')
    }
    const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
    let pts = 0
    for (const [n, c] of Object.entries(totals)) if (foods[n]) pts += (foods[n].foodPoints || 0) * c
    s.bankFoodPts = pts
    lastBankFood = { pts, at: Date.now() }
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
    // ...and now it is unknown to the CONSUMERS too, not only to the log. `1` is a floor, not a
    // count: the read threw before it could enumerate anything, so all we can honestly say is
    // "at least one chest went unread". Every consumer tests `> 0`, so an absent field (an old
    // or hand-built snapshot) keeps today's behaviour exactly - the field only ever ADDS doubt.
    s.bankUnknownChests = 1
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
  // Published so a responder can GATE on being buried. The state API has reported this every tick
  // for months and the chooser never saw it, which is why nothing owned "go up" (provision-hut.isUnderground).
  try { s.underground = provHut.isUnderground(bot) } catch { s.underground = false }
  // Published SEPARATELY from activeJob on purpose: activeJob names who owns the body, this names
  // what survival work is in flight. When the build owns the body and is running the food chain
  // inside itself, those two are different answers and the core needs the second one.
  try { s.survivalRun = survivalRunActive() } catch { s.survivalRun = null }
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
    // THE STOOD-DOWN HOLD, WHERE THE CHOOSER CAN SEE IT (review item 7). This number is not new -
    // markResumePaused has stamped it since the shortfall/give-up work - but its only reader was
    // the 2-minute resume re-arm timer in index.js, and item 7 deletes that timer along with the
    // rest of the build's private drive train. The caller owns the clock (this file), exactly as
    // it does for recentDeathCells, so scheduler.buildReady/pickJob stay pure.
    s.buildHoldMs = saved ? commands.resumeHoldRemaining(saved, Date.now()) : 0
    s.buildPausedWhy = (saved && saved.pausedWhy) || null
  } catch { s.persistedBuild = false; s.buildSite = null; s.postDeathRecovery = false; s.buildHoldMs = 0; s.buildPausedWhy = null }
  // recentDeathCells: the P5c spiral window, computed HERE (the caller owns the clock) so
  // buildReady stays pure/clockless. Same 20-min window the old inline gate used.
  try {
    const now = Date.now()
    s.recentDeathCells = require('./grave.js').ledger()
      .filter(d => d && now - (d.at || 0) < 20 * 60000)
      .map(d => ({ x: d.x, z: d.z }))
    // deathsAway: the recent deaths that happened somewhere ELSE - farther than 32b from where the
    // body stands now. A bot at spawn counting its spawn-night deaths against a daylight crossing
    // is judging the road by what happened at the door (journeyAdmissible's spiral clause).
    s.deathsAway = me ? s.recentDeathCells.filter(c => Math.hypot(c.x - me.x, c.z - me.z) > 32).length : s.recentDeathCells.length
  } catch { s.recentDeathCells = []; s.deathsAway = 0 }
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
    // XZ to the bed itself (NOT homeDist, which anchors on the hut): the spawn-reassert proposal
    // is a NEAR-BED claim - repairing an anchor you cannot reach is not a repair.
    s.bedDist = (kb && me) ? Math.hypot(kb.x - me.x, kb.z - me.z) : null
    s.spawnSuspect = !!suspect
    s.spawnAnchored = !!(kb && kb.confirmed === true && !suspect)
    // A STALE "NO BED" LATCH MUST YIELD TO WOOL IN THE PACK (2026-08-28). bedUnobtainable was set when
    // the bot had 0 wool and persisted (epoch-scoped) - so when the operator handed it wool it still
    // read "no bed obtainable" and the spawn bootstrap stayed suppressed, sending it to grind armour
    // instead of making the bed. A bed is only unobtainable if the latch holds AND none is craftable
    // from what is held NOW: a bed item, or >=3 of one wool colour + >=3 planks.
    s.bedUnobtainable = bedUnobtainable() && !(() => {
      try {
        const items = bot.inventory ? bot.inventory.items() : []
        if (items.some(i => /_bed$/.test(i.name))) return true
        const wool = {}; let planks = 0
        for (const i of items) { if (/_wool$/.test(i.name)) wool[i.name] = (wool[i.name] || 0) + i.count; if (/_planks$/.test(i.name)) planks += i.count }
        return planks >= 3 && Object.values(wool).some(n => n >= 3)
      } catch { return false }
    })()
  } catch { s.bedKnown = false; s.bedDist = null; s.spawnSuspect = false; s.spawnAnchored = false; s.bedUnobtainable = false }
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
  // (timeOfDay was read here. It is read in journeyFacts now, alongside homeDist and folded in
  //  above, because scheduler.homeLeash needs BOTH from the SYNC excursion poll as well as from
  //  this tick - and two snapshots reading the clock two ways is exactly the drift #4 forbids.)
  // ==== PLAN-one-runner S5: the HOUSEKEEPING facts ==========================================
  // The four idle-tier proposals (autoCollect / autoCook / scaffoldSweep / autoTorch) were 3s-45s
  // timers that each scanned for their own trigger and then moved the body if a handful of latches
  // happened to read false. As proposals their trigger has to be on the snapshot, so the chooser
  // can weigh them against everything else - which is what makes them unable to interrupt anything.
  //
  // CHEAP BY CONTRACT ([[body-first-priority]]): the entity list is already in memory (the threat
  // scan above walks it), the pack is in memory, and furnaces/scaffold come from the infra registry
  // and the scaffold ledger - both in-memory. The ONLY world reads are two blockAt lookups per
  // dropped item, which the 3s auto-collect timer was doing twenty times more often than this.
  try {
    let dropDist = null
    if (me) {
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || e.name !== 'item') continue
        const d = e.position.distanceTo(me)
        if (d <= 1.3 || d > 8 || (dropDist != null && d >= dropDist)) continue
        // NEVER dive for drops: items sunk in water lured the idle bot to the river bottom and it
        // drowned reclaiming its own death-drops (test server, verified by the server log).
        const at = bot.blockAt(e.position.floored())
        const above = bot.blockAt(e.position.floored().offset(0, 1, 0))
        if ((at && /water/.test(at.name)) || (above && /water/.test(above.name))) continue
        dropDist = d
      }
    }
    s.dropDist = dropDist
  } catch { s.dropDist = null }
  try {
    s.rawMeat = (bot.inventory ? bot.inventory.items() : []).filter(i => RAW_COOKABLE.test(i.name)).reduce((n, i) => n + i.count, 0)
  } catch { s.rawMeat = 0 }
  try {
    const f = me ? recallInfra('furnace', me, 24) : null
    s.furnaceDist = (f && me) ? Math.hypot(f.x - me.x, f.z - me.z) : null
  } catch { s.furnaceDist = null }
  try {
    // only registry entries older than 2 min - never yank scaffold a flow just placed
    const scaffold = require('./scaffold.js')
    s.scaffoldDebtNear = me ? scaffold.near(me, 20).filter(e => Date.now() - e.t > 120000).length : 0
  } catch { s.scaffoldDebtNear = 0 }
  // maintainNeeded computed LAST on the fully-assembled base snapshot (pure, no cycle). S4 never
  // dispatches maintain; the field exists so pickJob is exercised with real data (S6 = one-line enable).
  try { const maintain = require('./maintain.js'); s.maintainNeeded = maintain.needs(s).length > 0 } catch { s.maintainNeeded = false }
  return s
}

module.exports = { survivalState, excursionState, survivalNeed, mayDoProgress, activeJobInfo, survivalRunActive, schedulerState, setDebugSink }
