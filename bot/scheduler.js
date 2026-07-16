'use strict'
// PROACTIVE-SURVIVAL SCHEDULER (slice S3): the PURE decision core that replaces the broken
// busy-gate + the deleted famine-hold. Two questions the old code could not answer cleanly:
//   (1) which ONE job may own the body right now, and
//   (2) is an incoming command allowed to preempt it.
// This module answers both from a plain-data SNAPSHOT (no bot, no pathfinder, no fs) so it is
// offline-testable exactly like arbiter.js. It is DORMANT until S4 wires it into index.js /
// provision.js - nothing requires it yet, so the live bot is byte-identical to today.
//
// It reuses the ONE survival authority (arbiter.jobSurvivalNeed) rather than re-deriving need
// precedence (one-way require: arbiter must never require scheduler - no cycle).
//
// The functions:
//   commandClass(line)             classify the real brain/operator vocabulary (never invents)
//   admissible(cls, snap)          survival-preemption verdict (I1: a body latch can't muzzle it)
//   pickJob(snap)                  the single owning-job selector (I3: near graves are survival)
//   needProducer(need)             map any "blocked on X" to the producer of X (I2: no busy-wait)
//   recoveryPlan(snap)             TOTAL ordered ladder R0..R5, every hold names a provable wake
//   watchdog(job, vitals, now)     danger-scaled forward-progress verdict
// Reason/dbg strings are kept human + greppable - they surface in /log as PREEMPT/held reasons.

const arbiter = require('./arbiter.js') // one-way: for jobSurvivalNeed (the single need authority)

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[sched] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// Injectable clock so watchdog/deadline math is deterministically unit-testable.
let nowFn = () => Date.now()
function _setNow (fn) { nowFn = fn || (() => Date.now()) }

// ---- JOB CLASSES ------------------------------------------------------------------------
// Ranks encode the preemption table (REDESIGN §3.2): survival preempts progress/maintain/idle;
// progress preempts maintain/idle; maintain preempts idle only; idle preempts nothing.
const JOB_CLASSES = {
  survival: { rank: 3, members: ['recoveryLadder', 'graveSweep', 'secureFood', 'recoverHp', 'nightShelter'] },
  progress: { rank: 2, members: ['build', 'gearup', 'mine', 'gather', 'travel'] },
  maintain: { rank: 1, members: ['maintenancePass'] },
  idle: { rank: 0, members: [] }
}
function classRank (cls) { return JOB_CLASSES[cls] ? JOB_CLASSES[cls].rank : -1 }

// ---- commandClass -----------------------------------------------------------------------
// PURE classifier of the REAL command vocabulary (grounded against commands.js's `switch (cmd)`
// and the index.js gate regexes; see DESIGN §2.2). Does NOT invent commands. First token is
// lowercased with a leading !// stripped, then matched exact against the ordered class tables.
// perception/chat -> ALWAYS admissible. survival -> admissible only if a need/grave exists.
// progress -> the busy-gate's problem, not survival's. Unknown/blank -> progress (most
// restricted: it gets held by the busy-gate rather than wrongly bypassing it).
// NOTE: operator-only CHEAT commands (setblock|fill|clear|tp|gamemode|clearinv|remember|
// savepoint|forget|cancelbuild|abandonbuild) are blocked before the gate (index.js CHEAT_CMDS)
// and never reach here on the brain path; they fall through to 'progress' harmlessly and are
// NOT part of the admissibility contract.
const COMMAND_CLASS_TABLE = [
  { cls: 'perception', names: ['state', 'scan', 'find', 'block', 'entities', 'inventory', 'look', 'turn', 'lookbehind', 'waypoints', 'places', 'help'] },
  { cls: 'chat', names: ['say'] },
  { cls: 'survival', names: ['recover', 'getstuff', 'eat', 'wear', 'equip', 'armor', 'armour', 'hold', 'armorup', 'gearup', 'planarmor', 'sleep', 'wake', 'wakeup', 'fish', 'getfood', 'securefood', 'feed', 'huntat', 'hunt', 'waterat'] },
  { cls: 'progress', names: ['come', 'goto', 'travel', 'follow', 'mine', 'break', 'dig', 'collect', 'pickup', 'plant', 'place', 'craft', 'gather', 'provision', 'build', 'house', 'wall', 'tower', 'schem', 'schematic', 'autobuild', 'resumebuild', 'resume-build', 'attack', 'defend', 'give', 'drop', 'toss', 'shove', 'nudge', 'stash', 'unstash', 'huttidy', 'tidyhut', 'cleanhut'] }
]
function commandClass (line) {
  const raw = (line == null ? '' : String(line)).trim()
  if (!raw) return 'progress'
  let tok = raw.split(/\s+/)[0].toLowerCase()
  tok = tok.replace(/^[!/]+/, '')
  for (const entry of COMMAND_CLASS_TABLE) {
    if (entry.names.indexOf(tok) !== -1) return entry.cls
  }
  return 'progress'
}

// ---- needProducer -----------------------------------------------------------------------
// PURE lookup (I2): every "blocked on X" maps to the job that PRODUCES X, so there is never a
// busy-wait. The map is a DAG (secureFood->acquire; gearup->mine->acquire) - any would-be cycle
// (food needs a trek, trek needs heal, heal needs food) is broken by recoveryPlan's R0
// (consume-what-exists) / R1 (nearest win) / R5 (one bounded dawn-hold), never an unnamed wait.
// lava/fire/drowning/threat/creeper are REFLEX-owned; the scheduler never schedules them as jobs
// (they map to 'flee' so a blockedOn tag resolves, but pickJob routes danger through arbiter).
const NEED_PRODUCERS = {
  food: 'secureFood',
  heal: 'recoverHp',
  shelter: 'nightShelter',
  gear: 'gearup',
  iron: 'mine',
  wood: 'acquire',
  planks: 'acquire',
  tool: 'acquire',
  lava: 'flee',
  fire: 'flee',
  drowning: 'flee',
  threat: 'flee',
  creeper: 'flee'
}
function needProducer (need) {
  if (need == null) return null
  return Object.prototype.hasOwnProperty.call(NEED_PRODUCERS, need) ? NEED_PRODUCERS[need] : null
}

// ---- snapshot helpers -------------------------------------------------------------------
function gravesOf (s) { return Array.isArray(s.graves) ? s.graves : [] }
// An acute flee/danger is owned by the reflex stack - graves/gear wait until it clears.
function fleeActive (s) {
  return (s.threatDist != null && s.threatDist <= 6) ||
         !!s.inLava || !!s.onFire || !!s.drowning ||
         (s.creeperDist != null && s.creeperDist <= 12)
}
// Is a worthwhile, non-dangerous grave within `band` blocks? (dist is already min(bot,home).)
function nearestReachGrave (s, band) {
  let best = null
  for (const g of gravesOf(s)) {
    if (!g || g.dangerous || !(g.value > 0)) continue
    if (g.dist == null || g.dist > band) continue
    if (!best || g.dist < best.dist) best = g
  }
  return best
}
// The compound-degraded signature (DESIGN §2.4 step 3 / §5 opening): a state bad enough that a
// single producer won't do - run the ladder, which sequences R0..R5 and re-plans.
function isDegraded (s) {
  const graves = gravesOf(s)
  return (s.hp != null && s.hp <= 6) ||
         (s.food != null && s.food <= 6) ||
         (s.armorPieces === 0 && graves.length > 0) ||
         ((s.deathsRecent || 0) >= 2)
}

// ---- admissible -------------------------------------------------------------------------
// Replaces the busy-gate regex + survivalAdmissible(bot) (index.js:1573). PURE. It ONLY
// adjudicates survival preemption - it does NOT re-implement the "progress held while busy"
// hold (that stays at the S4 call site). perception/chat are always allowed; progress always
// returns allow:true here ("no survival objection", busy-gate still applies); survival is
// allowed iff a real vitals need exists OR a worthwhile, non-dangerous grave is within reach
// and no melee hostile is on us. (I1: no body latch can muzzle a real survival need.)
function admissible (cmdClass, snapshot) {
  const s = snapshot || {}
  if (cmdClass === 'perception' || cmdClass === 'chat') return { allow: true, reason: 'read-only/chat always allowed' }
  if (cmdClass === 'survival') {
    const need = arbiter.jobSurvivalNeed(s)
    if (need) return { allow: true, reason: need.reason || need.need }
    // near-grave override (I1/I3): free gear at arm's reach IS the survival move, even with no
    // vitals need - unless a melee hostile is in range (then the grave waits; mirrors
    // survivalAdmissible !st.threat + shouldChaseGrave's defer-on-threat).
    const GRAVE_NEAR = Number(process.env.GRAVE_NEAR || 16)
    const meleeThreat = s.threatDist != null && s.threatDist <= 6
    if (!meleeThreat) {
      const g = nearestReachGrave(s, GRAVE_NEAR)
      if (g) return { allow: true, reason: `grave ${Math.round(g.dist)}b away - free gear at arm's reach` }
    }
    return { allow: false, reason: 'no survival need and no grave in reach - not interrupting the build' }
  }
  // progress (and anything unclassified): survival raises no objection; the busy-gate decides.
  return { allow: true, reason: "progress admissibility is the busy-gate's job, not survival" }
}

// ---- pickJob ----------------------------------------------------------------------------
// The single owning-job selector (I3, §3.2, §5 entry). null => idle. `preempt` is true only
// when there IS an active victim whose class rank the returned job exceeds (the S4 dispatcher
// then sets the victim's stop latch). First match wins.
function pickJob (snapshot) {
  const s = snapshot || {}
  const activeCls = s.activeJob && s.activeJob.cls
  const preemptFor = cls => (s.activeJob ? classRank(cls) > classRank(activeCls) : false)
  const degraded = isDegraded(s)

  // 1. IMMEDIATE-DANGER / vitals survival need (arbiter is the authority).
  const need = arbiter.jobSurvivalNeed(s)
  if (need) {
    const preempt = preemptFor('survival')
    // a COMPOUND degraded state runs the ladder (R0..R5 + re-plan); a single clean need -> its
    // single producer.
    if (degraded) {
      dbg('pickJob -> recoveryLadder (degraded)', need.need)
      return { job: 'recoveryLadder', cls: 'survival', reason: 'degraded - running the ladder (' + (need.reason || need.need) + ')', preempt }
    }
    const job = needProducer(need.need) || 'recoverHp'
    return { job, cls: 'survival', reason: need.reason || need.need, preempt }
  }

  // 2. NEARBY GRAVE as first-class survival (I3) - even at food0/hp1 (the fed-but-naked case
  //    where step 1's need was null). Below immediate-danger, above everything else.
  const GRAVE_NEAR = Number(process.env.GRAVE_NEAR || 16)
  if (!fleeActive(s)) {
    const g = nearestReachGrave(s, GRAVE_NEAR)
    if (g) return { job: 'graveSweep', cls: 'survival', reason: `grave ${Math.round(g.dist)}b - free gear, zero trek`, preempt: preemptFor('survival') }
  }

  // 3. DEGRADED SIGNATURE -> recovery ladder (need was null-but-degraded, e.g. naked with a
  //    far grave and food 12).
  if (degraded) return { job: 'recoveryLadder', cls: 'survival', reason: 'degraded - running the ladder', preempt: preemptFor('survival') }

  // 4. ACTIVE PROGRESS job continues (single-goal discipline).
  if (s.activeJob && s.activeJob.cls === 'progress') return { job: s.activeJob.name, cls: 'progress', reason: 'continuing the active job (single-goal)', preempt: false }
  if (s.persistedBuild) return { job: 'build', cls: 'progress', reason: 'resuming a saved operator build', preempt: false }
  if (s.brainJobPending) return { job: 'brainJob', cls: 'progress', reason: 'brain job queued', preempt: false }

  // 5. MAINTAIN (only when NO progress job, NO survival need, buffers unmet). maintain rank 1 <
  //    progress rank 2 -> it can NEVER preempt a progress job (§3.2).
  if (s.maintainNeeded) return { job: 'maintenancePass', cls: 'maintain', reason: 'buffers low - topping up', preempt: false }

  // 6. idle
  return null
}

// ---- recoveryPlan -----------------------------------------------------------------------
// Returns a NON-EMPTY ordered rung list for EVERY snapshot (S6 totality). Distance NEVER
// removes a rung - it only sequences it. Every hold-type action names a provable `wake`
// (I5). Build R0->R5, appending each rung whose precondition could apply, then ALWAYS append
// R5 so the list is never empty.
const WAKE_SET = ['dawn', 'foodInPack', 'grave', 'animal<=24']
function recoveryPlan (snapshot) {
  const s = snapshot || {}
  const plan = []
  const graves = gravesOf(s)
  const packFoodPts = s.packFoodPts || 0
  const armorPieces = s.armorPieces != null ? s.armorPieces : 0
  const packArmorPieces = s.packArmorPieces || 0 // armor carried in the pack, wearable by R0
  const homeDist = s.homeDist != null ? s.homeDist : null
  const isNight = !!s.isNight
  const nightStuck = !!s.nightStuck
  const deathRatchet = (s.deathsRecent || 0) >= 2
  const GRAVE_NEAR_LADDER = Number(process.env.GRAVE_NEAR_LADDER || 32)
  const homeReachable = homeDist != null && homeDist <= 48

  // R0 consume what we already carry (drowning/inLava/threat are reflex-owned & outrank - noted,
  // not a rung here).
  if (packFoodPts > 0 || (armorPieces < 4 && packArmorPieces > 0)) {
    plan.push({ rung: 'R0', action: 'eatPack+wearFromPack' })
  }

  // R1 nearest non-dangerous worthwhile grave within the ladder's wider band (32).
  const g = nearestReachGrave(s, GRAVE_NEAR_LADDER)
  if (g) plan.push({ rung: 'R1', action: 'recoverGrave', graveDist: g.dist })

  // R2 shelter + home food cache.
  if (homeReachable) {
    plan.push({ rung: 'R2', action: 'gotoHome+ensureFood(forceFresh)+cook+eat' })
    if (isNight) plan.push({ rung: 'R2', action: 'sleepInBed', wake: 'dawn' })
  } else if (isNight) {
    plan.push({ rung: 'R2', action: 'digInForNight', wake: 'dawn' })
  }

  // R3 owned supply at ANY distance (distance changes duration, not inclusion).
  if (s.farm && s.farm.exists) {
    const e = { rung: 'R3', action: 'trekFarm+tend+harvest+courierHome' }
    if (deathRatchet) e.dayGated = true
    plan.push(e)
  }
  if (s.orchard && s.orchard.dist != null) {
    const e = { rung: 'R3', action: 'trekOrchard+harvest+courierHome' }
    if (deathRatchet) e.dayGated = true
    plan.push(e)
  }

  // R4 acquire NEW supply (secureFood hunt->fish->scout). Always available.
  {
    const e = { rung: 'R4', action: 'secureFood(hunt->fish->scout)' }
    if (deathRatchet) e.dayGated = true
    plan.push(e)
  }

  // R5 the ONLY hold - appended ALWAYS so the list is never empty (totality). Eternal night is
  // non-terminating, so nightStuck must NOT hold for dawn.
  if (nightStuck) {
    plan.push({ rung: 'R5', action: 'rerunLadderByNight' })
  } else if (isNight && homeReachable) {
    plan.push({ rung: 'R5', action: 'boundedHold:sleep', wake: 'dawn', deadlineMs: 90000 })
  } else {
    plan.push({ rung: 'R5', action: 'boundedHold:sealPit', wake: 'dawn|foodInPack|grave|animal<=24', deadlineMs: 90000 })
  }

  return plan
}

// ---- rungFeasible (S5) ------------------------------------------------------------------
// PURE right-now admission for ONE recoveryPlan rung (the plan is ORDERED; the ladder takes the
// first feasible rung that has an executor and hasn't been tried). Two gates, §7 layers 1-2:
//  - a dayGated rung (deathsRecent>=2) is inadmissible at night, UNLESS nightStuck (eternal night
//    can't wait for a day that won't come);
//  - the OUTBOUND rungs (trekFarm / trekOrchard / secureFood) are inadmissible while
//    isNight && underArmored && !nightStuck - the headline "never forage/trek OUT un-armored at
//    night" gate (mirrors shelterNeeded / arbiter shelter need). An ARMORED bot may still work the
//    night (today's behavior). nightStuck lifts BOTH gates (arbiter.js:145-149; R5 rerunLadderByNight).
// Everything else runs by night by design: R0 eat, R1 grave (its own night gate), R2 shelter, R5 hold.
const OUTBOUND_RE = /^(trekFarm|trekOrchard|secureFood)/
function rungFeasible (rung, snapshot) {
  const r = rung || {}
  const s = snapshot || {}
  const night = !!s.isNight
  const stuck = !!s.nightStuck
  if (r.dayGated && night && !stuck) return false
  if (OUTBOUND_RE.test(r.action || '') && night && !!s.underArmored && !stuck) return false
  return true
}

// ---- ladderDone (S5) --------------------------------------------------------------------
// PURE exit predicate for recoverFromDegraded: vitals + gear restored. Uses the START food bar
// (14 = arbiter default / PROGRESS_FOOD_MIN) so the ladder hands back a bot that mayDoProgress
// actually clears. DELIBERATELY excludes deathsRecent (it biases *sequencing* via dayGated, never
// termination - a fully-recovered bot must not re-run the ladder for 20 min after its 2nd death).
function ladderDone (snapshot) {
  const s = snapshot || {}
  const graves = gravesOf(s)
  return (s.hp == null || s.hp > 6) &&
         (s.food == null || s.food >= 14) &&
         !(s.armorPieces === 0 && graves.length > 0)
}

// ---- watchdog ---------------------------------------------------------------------------
// PURE danger-scaled forward-progress verdict (§6). Windows are additive thresholds on the SAME
// idleMs (nudge at [nudgeMs, failMs), fail at >= failMs); failMs = 2*nudgeMs gives the
// "second consecutive window -> fail" damping without per-call state. `now` defaults to nowFn().
// NOTE: uses `!= null` (not `||`) to read the timestamps so an epoch-0 lastProgressAt/startedAt
// is honored rather than treated as "unset" (the `||` in the design pseudocode would misread 0).
function watchdog (activeJob, vitals, now) {
  if (!activeJob) return 'ok'
  const t = now != null ? now : nowFn()
  const v = vitals || {}
  const base = activeJob.lastProgressAt != null ? activeJob.lastProgressAt
    : (activeJob.startedAt != null ? activeJob.startedAt : t)
  const idleMs = t - base
  let nudgeMs, failMs
  if ((v.hp != null && v.hp <= 6) || (v.food != null && v.food <= 2)) { nudgeMs = 20000; failMs = 40000 } // critical: seconds
  else if (activeJob.cls === 'survival') { nudgeMs = 45000; failMs = 90000 }
  else { nudgeMs = 120000; failMs = 240000 } // patient when cheap
  if (idleMs >= failMs) return 'fail-job'
  if (idleMs >= nudgeMs) return 'nudge'
  return 'ok'
}

module.exports = {
  pickJob,
  recoveryPlan,
  rungFeasible,
  ladderDone,
  isDegraded,
  commandClass,
  admissible,
  needProducer,
  watchdog,
  JOB_CLASSES,
  WAKE_SET,
  _setNow,
  setDebugSink,
  _reset: () => { nowFn = () => Date.now() } // test hygiene (module is near-stateless)
}
