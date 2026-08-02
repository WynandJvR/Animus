'use strict'
// PROACTIVE-SURVIVAL SCHEDULER (slice S3): the PURE decision core that replaces the broken
// busy-gate + the deleted famine-hold. Two questions the old code could not answer cleanly:
//   (1) which ONE job may own the body right now, and
//   (2) is an incoming command allowed to preempt it.
// This module answers both from a plain-data SNAPSHOT (no bot, no pathfinder, no fs) so it is
// offline-testable exactly like arbiter.js. S4 is LIVE: index.js owns the scheduler tick + the
// busy-gate, provision.js classifies the active job through it, and commands.js gates
// build-resume on it. Editing this file changes live behaviour - it is not dormant.
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
const mining = require('./mining.js')   // one-way: PURE ironKeystone decision (mining requires nothing)
const gravePolicy = require('./grave-policy.js') // one-way: PURE grave decisions (#112 salvageVerdict / net-of-risk scoring)
const capabilities = require('./capabilities.js') // one-way: the PURE capability registry (requires nothing) - the ladder's action vocabulary
const foodSec = require('./food.js') // one-way: PURE food/hp predicates (food.js requires NOTHING) - the ONE hp-abort definition

// IRON_KEYSTONE: is this bot on the keystone-blocker grind - fully naked (0 armor) and short of a
// boots' worth of raw iron - so it MUST bank that first iron before ANY other progress? Reuses the
// PURE mining.ironKeystone. s.rawIron is pack+bank iron in ingot-equivalents (raw smelts 1:1); absent
// -> 0 (a snapshot that never measured it reads as "no iron", the conservative keystone-active side,
// but the guard also demands armorPieces===0 so an armored bot is never affected). Flag off -> false.
function ironKeystoneActive (s) {
  if (process.env.IRON_KEYSTONE === '0') return false
  return mining.ironKeystone(
    { armorPieces: (s && s.armorPieces) || 0, rawIron: (s && s.rawIron) || 0 },
    { enabled: true, bootsIron: Number(process.env.ARMOR_BOOTSTRAP_IRON || 4) }
  ).active
}

const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[sched]') // §4: one definition of the sink rule; this module still owns its own sink

// Injectable clock so watchdog/deadline math is deterministically unit-testable.
let nowFn = () => Date.now()
function _setNow (fn) { nowFn = fn || (() => Date.now()) }

// ---- JOB CLASSES ------------------------------------------------------------------------
// Ranks encode the preemption table (REDESIGN §3.2): survival preempts progress/maintain/idle;
// progress preempts maintain/idle; maintain preempts idle only; idle preempts nothing.
const JOB_CLASSES = {
  survival: { rank: 3, members: ['recoveryLadder', 'graveSweep', 'secureFood', 'recoverHp', 'nightShelter', 'homecoming'] },
  // 'acquire' is resources.acquire (withdraw > craft > gather) - the producer NEED_PRODUCERS names
  // for wood/planks/tool. It was named there and existed nowhere here, so the one question the
  // table exists to answer ("who makes this?") had an answer no layer could act on. (CAPABILITY
  // REGISTRY, capabilitytest.js item 3.)
  progress: { rank: 2, members: ['build', 'gearup', 'mine', 'gather', 'travel', 'acquire', 'brainJob'] },
  maintain: { rank: 1, members: ['maintenancePass', 'reclaim'] },
  idle: { rank: 0, members: [] }
}
// Producers that are NOT scheduler jobs because a REFLEX owns them: the arbiter/escape stack acts
// on lava/fire/drowning/threat/creeper within the tick, far faster than a job dispatch could. They
// are listed HERE rather than left implicit so "who performs this?" always has a named owner
// (DESIGN-PRINCIPLES §5) and so the contract test can tell a reflex from a wiring hole.
const REFLEX_OWNED = ['flee']
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
// Which of those producers SET OUT across open ground? The same question capabilities.RUNG_ACTIONS
// answers for ladder rungs, asked of producers, and governed by the SAME rule (outboundBlocked):
// "never forage or trek out un-armoured at night". It exists because the chooser may route a live
// need straight to its producer when the compound ladder is refused, and without this that route
// would happily send a naked bot foraging into the dark - the exact death rungFeasible bars.
const OUTBOUND_PRODUCERS = new Set(['secureFood', 'gearup', 'mine', 'acquire'])
const producerIsOutbound = p => OUTBOUND_PRODUCERS.has(p)
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
// task #18: an about-to-despawn grave (tier from commands.graveUrgency, carried on the snapshot) is
// urgency-graded. Reflects a widened reach band for urgent/critical graves.
function graveUrgent (g) { return !!g && (g.tier === 'urgent' || g.tier === 'critical') }
// PURE effective reach band for a grave (M2, task #18): safe graves keep `band`; urgent/critical
// graves widen to max(band, urgentBand). GRAVE_URGENT=0, no urgentBand, or a safe/untagged grave
// -> `band` unchanged (byte-equivalent to today). Callers that must NOT widen (admissible's near
// override) simply omit urgentBand.
function graveReachBand (g, band, urgentBand) {
  if (process.env.GRAVE_URGENT === '0' || urgentBand == null || !graveUrgent(g)) return band
  return Math.max(band, urgentBand)
}
// Is a worthwhile, non-dangerous grave within reach? (dist is already min(bot,home).) `band` is the
// SAFE-tier band; pass `urgentBand` to let urgent/critical graves reach further (M2). Omit it to
// keep every grave on `band` (admissibility != dispatch priority).
// #112 HAZARD_NOT_LURE: two changes, both Root E.
//   (1) a grave whose salvageVerdict says `go:false` is NOT a candidate. It is not "free gear";
//       it is a liability behind a precondition (the bot cannot yet survive the medium that
//       killed it there). The row stays on the books - it is filtered here, not forgotten.
//   (2) the pick is by DESIRE NET OF RISK, not by raw proximity: gravePolicy.graveScore is the
//       grave's value discounted by the deaths at its cell, over the trek. With equal value and
//       no hazard this is the old nearest-first pick; with a hazard, a rich grave in a cell that
//       keeps killing the bot now loses to a modest one in a safe cell.
function nearestReachGrave (s, band, urgentBand) {
  let best = null; let bs = -Infinity
  for (const g of gravesOf(s)) {
    if (!g || g.dangerous || !(g.value > 0)) continue
    if (gravePolicy.graveSalvageBlocked(g)) continue
    if (g.dist == null || g.dist > graveReachBand(g, band, urgentBand)) continue
    const sc = gravePolicy.graveScore(g)
    if (sc > bs) { bs = sc; best = g }
  }
  return best
}
// The compound-degraded signature (DESIGN §2.4 step 3 / §5 opening): a state bad enough that a
// single producer won't do - run the ladder, which sequences R0..R5 and re-plans.
// #79 DEGRADED_GRAVE_REACHABLE (default on): the naked+grave clause counts only a grave the
// ladder's R1 can actually FETCH (worthwhile, non-dangerous, within the ladder band). The raw
// graves.length pinned the ladder for 95min live (03:0xZ): a far/despawned-but-unretrieved
// LEDGER grave kept degraded true at hp20/food20/armor0, the ladder looped R2>R5 hold with no
// R1 planned (out of band), and every other job (farm/bootstrap/iron) starved. Naked with no
// reachable grave is bootstrapNeed('armor')'s job, not a compound-degraded state. Flag =0 ->
// today's raw-count clause byte-for-byte.
function isDegraded (s) {
  const graves = gravesOf(s)
  const graveHook = process.env.DEGRADED_GRAVE_REACHABLE !== '0'
    ? !!nearestReachGrave(s, Number(process.env.GRAVE_NEAR_LADDER || 32), Number(process.env.GRAVE_URGENT_DIST || 96))
    : graves.length > 0
  // #92 DEATH_RATCHET_DAY_RELEASE (default on): the deathsRecent>=2 hold exists to break death
  // CASCADES (marching back to the death spot at 32 deaths/day). With every outbound path now
  // night-gated (#41P3/#90/#91) and death spots route-costed (#85), a FULL-VITALS bot in DAYLIGHT
  // gains nothing from 20 minutes of sitting in the hut (operator: "it just wastes time") - the
  // ratchet pins only at night or when vitals are actually dented. Flag =0 -> the blanket hold.
  const ratchet = (s.deathsRecent || 0) >= 2 &&
    (process.env.DEATH_RATCHET_DAY_RELEASE === '0' ||
      (!!s.isNight || (s.hp != null && s.hp < 14) || (s.food != null && s.food < 14)))
  return (s.hp != null && s.hp <= 6) ||
         (s.food != null && s.food <= 6) ||
         (s.armorPieces === 0 && graveHook) ||
         ratchet
}

// ---- admissible -------------------------------------------------------------------------
// Replaces the busy-gate regex + survivalAdmissible(bot) (index.js survivalAdmissible). PURE. It ONLY
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

// ---- fightNotFlee -----------------------------------------------------------------------
// PURE predicate (#15 Piece B). While actively being hit AND pinned (no net movement) with the
// threat in melee reach, an unsatisfiable flee goal just shoves the wall forever - melee it
// instead. Never melees a creeper (NO_AUTO_MELEE - the caller bursts away instead). hp is NOT an
// input by design. flagOn=false (DEFEND_WHEN_HIT=0) reverts to today (always false).
function fightNotFlee ({ flagOn, beingHit, pinnedMs, threatDist, isCreeper }) {
  if (!flagOn || !beingHit) return false
  if (isCreeper) return false            // never melee a creeper (burst instead)
  return pinnedMs >= 4000 && threatDist <= 4
}

// ---- WATER_SAFE (task #45) fight/escape arbitration ------------------------------------------
// PURE. While the head is UNDERWATER the threat response must be RETREAT-TO-LAND, not fight: the
// bot drowned TWICE trading blows with a Drowned in place (`(flee) PINNED ... can't flee, fighting`
// while submerged). This suppresses the auto-defend/flee reflex so the SURVIVE-tier drown-escape
// owns the body and swims to the nearest bank (also away from the water mob). Fighting resumes the
// instant the head clears (on land / shallow) - the on-land ladder is unchanged. flagOn=false
// (WATER_SAFE=0) reverts to today (always false -> the bot fights while submerged).
function fightSuppressedWhenSubmerged ({ flagOn, submerged }) { return !!(flagOn && submerged) }

// PURE. WHEN is the drown-escape due? The old AUTO_SURFACE reflex waited for ~6s of submersion
// (wetHist>=3 ~= the `low oxygen` point) before acting and lost the race to the Drowned fight.
// In OVER-THE-HEAD (deep) water, escape on the FIRST confirmed submerged poll - don't bank air
// debt. oxygen is trusted ONLY when oxygenReliable (bot.oxygenLevel is unreliable on live, so the
// block-based `deep` flag is the primary trigger). Shallow head-dip / unreliable oxygen keeps
// today's ~6s persistence. flagOn=false (WATER_SAFE=0) -> always false (caller uses its wetHist>=3).
function submergedEscapeDue ({ flagOn, submerged, deep, wetHist, oxygen, oxygenReliable }) {
  if (!flagOn || !submerged) return false
  if (deep) return (wetHist || 0) >= 1
  if (oxygenReliable && oxygen != null && oxygen <= 12) return (wetHist || 0) >= 1
  return (wetHist || 0) >= 3
}

// ==== #65 BOOTSTRAP_PRIORITY (Phase 1 of DYNAMIC_CORE) - PURE decision ====================
// Flag BOOTSTRAP_PRIORITY (default on; =0 -> ALWAYS null = today byte-for-byte). THE frontier
// blocker: the bot survives everything but never THRIVES - it wastes its healthy windows (hp20/
// food20 after a reset) charging the castle build (ranging 76-88b for wood) instead of establishing
// the survival INFRASTRUCTURE it lacks, so it stays UNARMORED / foodless / in a dark base -> degrades
// back to hp1/food0 -> repeats. This returns the single highest-priority MISSING survival-infra need
// when the bot is in a HEALTHY window (hp>=BOOTSTRAP_HP & fed), so pickJob/resumeBuild can establish
// it BEFORE resuming the build. Order: FOOD RESERVE > SPAWN > ARMOR > SHELTER > BASE LIT (#117).
// It is PRIORITY, not new mechanics: the picked maintenancePass runs the EXISTING #60 proactiveArmor
// / #62 courier-bake / #69 secureBase steps plus the #117 home producers (ensureSpawnBed /
// ensureHomeShelter), which today only fire opportunistically, so they rarely run.
//
// Conservative by construction:
//  - only in a HEALTHY window (hp>=14 & fed) - a degraded/hungry bot is the SURVIVAL tier's job, never
//    bootstrap's, so it can NEVER mask a real crisis (pickJob steps 1-3 also run strictly before it);
//  - ARMOR needs no home (armorup mines its own iron via #71 + smelts boots via #60); FOOD RESERVE and
//    BASE LIT live at the home bank/hut, so they only count when home is REACHABLE (else the go-home/
//    recovery flow owns the bot, and blocking the build on an unreachable bank would livelock);
//  - BASE LIT only when measurable (s.baseLit === false: a hut exists but secureBase hasn't lit its
//    ring yet). Unknown (no hut / no read) never invents a need. secureBase persists its ring, so ONE
//    torch placement flips baseLit true and hands the build back (no dark-base livelock).
//
// #117 HOME_IS_A_NEED (design §3.2 Root B). Two things changed here and one was DELETED.
// DELETED: #103's `BOOTSTRAP_NEEDS_HOME` inversion - "no home at all => bootstrap NOTHING,
// the build's camp step owns establishment". It made home the one survival need the scheduler
// could not want, and the live cost was the whole of 2026-07-19: home was step 6/11 INSIDE the
// castle build job, so it only progressed if that job ran AND survived steps 1-5, which it
// never did - 23 deaths, each respawning the bot 380-490 blocks away with no anchor to come
// back to. The comment's fear (the armor branch stealing the body from establishment while
// food ran out) was itself a SYMPTOM of home not being a verdict; with 'spawn' outranking
// 'armor' the armor grind can no longer win that race, so the patch is removed, not layered on.
// ADDED: 'spawn' (no verified spawn anchor) above 'armor', and 'shelter' (a hut on the books
// that does not verify) just below it. Both are measured from world-memory v2 `verified` flags
// by the snapshot - no world reads on this path.
//
// UNMEASURED IS NOT UNMET (the Root A rule, applied here): a field that was never measured
// must never invent a need, so both verdicts fire on an explicit `=== false` exactly like
// baseLit does. A snapshot that carries neither field behaves precisely as before.
function bootstrapNeed (snapshot) {
  if (process.env.BOOTSTRAP_PRIORITY === '0') return null
  const s = snapshot || {}
  const hp = s.hp != null ? s.hp : 20
  const food = s.food != null ? s.food : 20
  const fed = food >= Number(process.env.BOOTSTRAP_FED || 14)
  const reserve = s.bankFoodPts != null ? s.bankFoodPts : 0
  // ==== #74 FOOD RESERVE FIRST (#108: the =0 leg is DELETED - the same 'food' verdict lived at
  // TWO positions of this one function, so the decision had two copies to drift; rollback = git) ==
  // The DURABLE bank bread reserve is the bootstrap ENABLER: with ~8 banked loaves, #62 §A withdraws
  // bread at the hut the moment a low-hp/food crisis hits -> the bot recovers -> sustains a window ->
  // and only THEN can the hp>=14 armor/base bootstraps EXECUTE. Without a reserve no degraded window
  // survives long enough for anything to bootstrap (the live hp1/food0 deadlock: #73 re-prioritised
  // to armor-first but could never reach hp14 to run it). So the food reserve is the TOP bootstrap
  // priority and fires at a LOWER hp gate (FOOD_RESERVE_HP, default 8) - stocking wheat->bread at the
  // farm/home is lower-risk than the deep iron-mine armor needs, and it is the very thing that lets a
  // degraded window climb back to hp14. It STILL requires being FED (enough to survive the far-farm
  // trek, guarded like #59 harvest-first) and a REACHABLE home (else the go-home/recovery flow owns
  // the bot - never livelock on an unreachable bank). It stocks toward FOOD_RESERVE_TARGET (~40 pts /
  // 8 loaves) via the EXISTING maintenancePass farm->bake->courier chain (#62 courier-bake, bounded &
  // survival-yielding), so a genuinely durable reserve accumulates. Armor/base keep BOOTSTRAP_HP(14).
  if (s.homeReachable && fed &&
      hp >= Number(process.env.FOOD_RESERVE_HP || 8) &&
      reserve < Number(process.env.FOOD_RESERVE_TARGET || 40)) return 'food'
  if (hp < Number(process.env.BOOTSTRAP_HP || 14)) return null
  if (!fed) return null
  // (1) SPAWN ANCHOR (#117) - a fed bot beds BEFORE it armors. The bed is the single biggest
  // death-cost reducer on the 23-death tape: without it every death is a 380-490b walk home
  // through the terrain that just killed the bot, naked, with the grave timing out behind it.
  // Armor reduces the CHANCE of a death; the anchor reduces the PRICE of every death that
  // still happens, and it costs one craft. Needs no home - ensureSpawnBed lays on open ground.
  if (spawnBootstrapDue(s)) return 'spawn'
  // (2) ARMOR - the biggest survivability multiplier; fires whenever fully naked (no home required).
  const armorPieces = s.armorPieces != null ? s.armorPieces : 0
  if (armorPieces === 0) return 'armor'
  // (3) SHELTER (#117) - a hut that is ON THE BOOKS but does not verify this life. That is the
  // phantom-hut state exactly (registry box, no structure), and its producer is the repair path
  // (ensureHomeShelter -> maintainHome), which is now runnable OUTSIDE the build job.
  // Deliberately NOT fired when no hut is registered at all: siting-and-raising a first hut has
  // exactly one implementation and it lives in the build's camp step, which buildReady's #102
  // noHut exemption already hands the body to. Claiming a need whose producer does not exist is
  // how a verdict becomes a livelock, so the homeless case stays with the camp step until that
  // implementation is extracted - and it is no longer reached by returning null for EVERYTHING.
  if (s.hutExists && s.hutVerified === false) return 'shelter'
  // The rest is home-bank/hut infra - only a bootstrap need when home is reachable enough for the
  // maintenancePass to actually establish it.
  if (s.homeReachable) {
    // (4) BASE LIT - spawn-proof the home (#69 secureBase). Only when provably not yet lit.
    if (s.baseLit === false) return 'base'
  }
  return null
}

// #117 - PURE. Is the 'spawn' verdict due, i.e. is the bot unanchored AND does its producer
// (provision.ensureSpawnBed) have a rung that can make progress RIGHT NOW? Every clause is a
// CONDITION on the world or on this life's observations; there is no clock and no cooldown
// anywhere in it, and there must never be one (memory: no-blanket-time-holds).
//
// The anti-loop cases this closes, both named in design §5:
//  - NO SHEEP / NO WOOL ANYWHERE: acquireBed exhausts its plan and ensureSpawnBed records
//    `bedUnobtainable` FOR THIS LIFE (epoch-scoped, cleared by a bed arriving or by a death
//    bumping the epoch). The verdict then steps aside so armor/base/build can proceed, and it
//    comes back by itself the moment the condition changes - not when a timer says so.
//  - A STANDING BUT UNCONFIRMED BED: day-clicking sets no spawn on this server (proven live
//    2026-07-20 - "i set my spawn at this bed", then a respawn 462b away at world origin), so
//    only a granted SLEEP confirms it. In daylight ensureSpawnBed has nothing to do but say so,
//    and a verdict that fires anyway would spin maintenancePass every tick and starve armor.
//    The gate is the world's own sleepability condition, which the snapshot already carries.
function spawnBootstrapDue (s) {
  if (!s || s.spawnAnchored !== false) return false // anchored, or never measured -> no invented need
  if (!s.bedKnown) return s.bedUnobtainable !== true // no bed at all -> acquire one, unless that plan is exhausted
  if (s.spawnSuspect === true) return true          // a respawn disproved the anchor -> re-anchor
  return s.sleepableNow === true                    // standing but unconfirmed: only a sleep can fix it
}

// ==== #114 ONE_READINESS - THE single build-readiness predicate ===========================
// Root G (design-docs/DESIGN-grounded-truth-and-home-first.md §3.7). "Can the build run?" used to
// be answered TWICE by two predicates that never met: the chooser's feasibility term
// (scheduler-core.js, which consulted NO readiness at all and labelled its pick "infra is in
// order") and the executor's inline gate (commands.js resumeBuild). They drifted the day they were
// written, and on 2026-07-19 16:02-16:06 the drift stood the bot still: the chooser picked the
// build six times in 76s ("infra is in order") while the executor refused it every time
// ("bootstrap needed (food)"), and the refusal - already a structured return value - was dropped.
// Nothing ran until the 90s watchdog re-armed the tick.
//
// This function IS the gate. The executor's inline block is DELETED; the chooser's feasibility
// term and reason string are DERIVED from here. Same function object for both consumers, so
// divergence is unrepresentable rather than merely discouraged.
//
// PURE: snapshot in, verdict out. No clock, no bot handle, no world read (it runs on the hot
// scheduler path - [[body-first-priority]]). Everything time-shaped is supplied BY THE CALLER on
// the snapshot (recentDeathCells is already windowed; recoveryReady may be supplied by the
// executor, which can afford the impure live re-check the pure term cannot).
//
// Snapshot fields consumed: postDeathRecovery, recoveryReady (optional bool override), hutExists,
// persistedBuild, buildSite, recentDeathCells - plus everything bootstrapNeed reads.
// Returns { ok, why, need, exempt } where `need` names the WORK that would clear the refusal
// ('food'|'armor'|'base'|'recovery'|null) - that is what lets the chooser pick the enabling job
// INSTEAD of idling (need-inheritance, scheduler-core.js).
function buildReady (snapshot) {
  const s = snapshot || {}
  // (1) #41 P0.1 - after a death, RECOVERY owns the bot and OUTRANKS build-resume. The build waits,
  //     kept on disk, never driving the naked bot back into the death cell.
  if (s.postDeathRecovery) {
    const ready = typeof s.recoveryReady === 'boolean' ? s.recoveryReady : recoveryReady(s).ready
    if (resumeGate({ postDeathRecovery: true, ready }) === 'wait') {
      return { ok: false, why: 'post-death recovery in progress', need: 'recovery', exempt: false }
    }
  }
  // (2) #65 BOOTSTRAP_PRIORITY - establish the MISSING survival infra (food reserve / armor / lit
  //     base) before resuming, with #102 CAMP_FIRST's exemption: while NO hut stands, the build's
  //     own CAMP steps ARE the missing infra, so the job is let through to establish shelter.
  if (process.env.BOOTSTRAP_PRIORITY !== '0') {
    const bn = bootstrapNeed(s)
    const noHut = process.env.CAMP_FIRST !== '0' && !s.hutExists
    if (bn && !noHut) return { ok: false, why: 'bootstrap needed (' + bn + ')', need: bn, exempt: false }
    if (bn && noHut) return { ok: true, why: 'bootstrap ' + bn + ' pending but NO HUT stands - the camp step establishes shelter first (#102)', need: null, exempt: true }
  }
  // (3) #41 P5c anti-spiral - during a death SPIRAL don't march the build back into a recent death
  //     cluster. recentDeathCells is the caller's already-windowed list (this fn holds no clock).
  if (process.env.RESILIENT_RECOVERY !== '0' && s.persistedBuild && s.buildSite) {
    const cells = Array.isArray(s.recentDeathCells) ? s.recentDeathCells : []
    if (cells.length >= Number(process.env.SPIRAL_N || 3) && withinDeathZone(s.buildSite, cells)) {
      return { ok: false, why: 'death spiral + the build site sits in a recent death cluster', need: 'recovery', exempt: false }
    }
  }
  return { ok: true, why: 'survival infra in order', need: null, exempt: false }
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
  //    where step 1's need was null). Below immediate-danger, above everything else. task #18: an
  //    URGENT/critical (about-to-despawn) grave widens the band to GRAVE_URGENT_DIST (closing the
  //    old 33-96b dead zone exactly when the despawn timer matters); a safe grave keeps GRAVE_NEAR.
  const GRAVE_NEAR = Number(process.env.GRAVE_NEAR || 16)
  const GRAVE_URGENT_DIST = Number(process.env.GRAVE_URGENT_DIST || 96)
  if (!fleeActive(s)) {
    const g = nearestReachGrave(s, GRAVE_NEAR, GRAVE_URGENT_DIST)
    if (g) return { job: 'graveSweep', cls: 'survival', reason: `grave ${Math.round(g.dist)}b${graveUrgent(g) ? ' (' + g.tier + ' - despawning)' : ''} - free gear`, preempt: preemptFor('survival') }
  }

  // 3. DEGRADED SIGNATURE -> recovery ladder (need was null-but-degraded, e.g. naked with a
  //    far grave and food 12).
  if (degraded) return { job: 'recoveryLadder', cls: 'survival', reason: 'degraded - running the ladder', preempt: preemptFor('survival') }

  // 4. ACTIVE PROGRESS job continues (single-goal discipline). An ALREADY-running progress job is
  //    never preempted here (bootstrap is below crisis-survival but above only the build-RESUME tier).
  if (s.activeJob && s.activeJob.cls === 'progress') return { job: s.activeJob.name, cls: 'progress', reason: 'continuing the active job (single-goal)', preempt: false }

  // 4b. BOOTSTRAP tier (#65): before RESUMING a saved build, establish the MISSING survival infra in a
  //     healthy window (armor -> food reserve -> lit base). Below crisis-survival (steps 1-3 already
  //     returned) and above the build-resume tier: a healthy naked bot mines iron for armor instead of
  //     ranging for build-wood. Reuses maintenancePass (its #60/#62/#69 steps do the work; maintain
  //     rank 1 can't preempt a busy build - the build is held at resumeBuild's bootstrap gate meanwhile).
  //     BOOTSTRAP_PRIORITY=0 -> bootstrapNeed is always null -> the build resumes exactly as today.
  const bn = bootstrapNeed(s)
  if (bn) return { job: 'maintenancePass', cls: 'maintain', reason: 'bootstrap: ' + bn + ' before resuming the build', preempt: false, bootstrap: bn }

  // IRON_KEYSTONE COMMIT (anti-thrash): a fully-naked bot short of its first boots' worth of iron must
  // NOT resume the build and range for wood - that thrash (iron at the bed <-> oak at the far site every
  // ~19s) is why it never finishes the descent. Hold the build and keep it on the armor bootstrap until
  // it banks the iron (or a real crisis takes over - pickJob steps 1-3 already ran, so a genuine survival
  // need still outranks this). Fires only when we'd otherwise resume the build (bn was null): bootstrap's
  // #65/#74 ordering above is untouched. Flag off -> ironKeystoneActive false -> the build resumes as
  // today, byte-for-byte.
  if (s.persistedBuild && ironKeystoneActive(s)) {
    return { job: 'maintenancePass', cls: 'maintain', reason: 'iron keystone: banking first armor iron before resuming the build (no naked thrash)', preempt: false, bootstrap: 'armor' }
  }
  if (s.persistedBuild) return { job: 'build', cls: 'progress', reason: 'resuming a saved operator build', preempt: false }
  if (s.brainJobPending) return { job: 'brainJob', cls: 'progress', reason: 'brain job queued', preempt: false }

  // 5. MAINTAIN (only when NO progress job, NO survival need, buffers unmet). maintain rank 1 <
  //    progress rank 2 -> it can NEVER preempt a progress job (§3.2).
  if (s.maintainNeeded) return { job: 'maintenancePass', cls: 'maintain', reason: 'buffers low - topping up', preempt: false }

  // 6. idle
  return null
}

// ---- oppMaintain (OPPORTUNISTIC MAINTENANCE) ---------------------------------------------
// PURE. May a bounded maintenance window open RIGHT NOW, given that the build era normally
// starves maintain (pickJob:194-201)? Flag-gated at the CALL SITE (index OPP_ON); this
// predicate is total and side-effect-free so it unit-tests offline.
// opts.checkupDue: caller-computed "no window for OPP_CHECKUP_MS" bit - lets homeRepair/
// safekeep run even when maintain.needs() is empty (hut damage + pack surplus are not
// snapshot buffers). Returns { ok, preempt, reason }.
function oppMaintain (snapshot, opts) {
  const s = snapshot || {}
  const o = opts || {}
  const dist = Number(process.env.OPP_MAINTAIN_DIST || 24)
  if (!(s.homeDist != null && s.homeDist <= dist)) return { ok: false, reason: 'not at the hut (' + (s.homeDist == null ? '?' : Math.round(s.homeDist)) + 'b)' }
  if (arbiter.jobSurvivalNeed(s)) return { ok: false, reason: 'survival need first' }
  if (fleeActive(s) || isDegraded(s)) return { ok: false, reason: 'danger/degraded - not chore time' }
  const aj = s.activeJob
  const buildRunning = !!(aj && aj.cls === 'progress' && aj.name === 'autobuild')
  const idleWithSaved = !aj && !!s.persistedBuild
  if (!buildRunning && !idleWithSaved) return { ok: false, reason: 'no build era to be opportunistic inside' }
  if (!(s.maintainNeeded || o.checkupDue)) return { ok: false, reason: 'buffers fine + checkup not due' }
  return { ok: true, preempt: buildRunning, reason: buildRunning ? 'at the hut mid-build - chores while i\'m here' : 'at the hut in a resume gap - chores while i\'m here' }
}

// ---- recoveryPlan -----------------------------------------------------------------------
// Returns a NON-EMPTY ordered rung list for EVERY snapshot (S6 totality). Distance NEVER
// removes a rung - it only sequences it. Every hold-type action names a provable `wake`
// (I5). Build R0->R5, appending each rung whose precondition could apply, then ALWAYS append
// R5 so the list is never empty.
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

  // R1 nearest non-dangerous worthwhile grave within the ladder's wider band (32), widened again to
  // GRAVE_URGENT_DIST for an about-to-despawn grave (task #18 M2 - same as pickJob step 2).
  const g = nearestReachGrave(s, GRAVE_NEAR_LADDER, Number(process.env.GRAVE_URGENT_DIST || 96))
  if (g) plan.push({ rung: 'R1', action: 'recoverGrave', graveDist: g.dist })

  // R1.5 rearmFromBank (#41 RESILIENT_RECOVERY): re-arm from a banked spare set - decouples re-arm
  // from a lost/lethal grave (RC-C). AFTER R0/R1, BEFORE any outbound R3/R4. Needs home reachable +
  // a bank that can fill the deficit + a naked/toolless bot. NOT an OUTBOUND rung (walks HOME), so
  // rungFeasible never day/night/spiral-gates it. RESILIENT_RECOVERY=0 -> the rung is never planned.
  if (process.env.RESILIENT_RECOVERY !== '0') {
    const underArmored = armorPieces < 4
    const toolless = !(s.tools && s.tools.pick && s.tools.sword)
    const bankHelpsArmor = underArmored && (s.bankArmorPieces || 0) >= 1
    const bankHelpsTools = toolless && (!!s.bankHasPick || !!s.bankHasSword)
    if (homeReachable && (bankHelpsArmor || bankHelpsTools)) plan.push({ rung: 'R1.5', action: 'rearmFromBank' })
  }

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
// WHICH actions set out has ONE definition: the `outbound` flag in the capability registry
// (bot/capabilities.js RUNG_ACTIONS). OUTBOUND_RE is DERIVED from it so the regex can never
// drift from the table the ladder is planned out of - the previous hand-written
// /^(trekFarm|trekOrchard|secureFood)/ was a second copy of a rule that lives elsewhere.
const OUTBOUND_RE = new RegExp('^(' + capabilities.rungActionNames().filter(a => capabilities.isOutboundAction(a))
  .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$')

// ---- outboundBlocked (AUDIT 2026-07-29, defect: ONE RULE, TWO PATHS) --------------------
// "Never set out un-armoured at night" is the single most load-bearing survival rule in this
// codebase. It was written INSIDE rungFeasible, so it governed the recovery ladder's treks and
// nothing else - and the one journey that is not a ladder rung, the post-respawn walk home, was
// therefore exempt from it. On 2026-07-20 that exemption walked a naked bot 470 blocks through
// the dark eight times in seven minutes, and it died every time (§1 LOOP A of the audit).
//
// The rule now has ONE definition, and every journey - rung or not - asks THIS function. Extracted
// verbatim from rungFeasible's body: same clauses, same flags, same order, so the ladder's
// behaviour is unchanged by the extraction and the homecoming inherits the rule it was missing.
//
// Returns the BLOCKING CONDITION as a string (what must change before setting out), or null when
// the journey may proceed. A condition, never a timer - each one is provably re-checkable and
// two of the three ('dawn', 'armor') have producers the scheduler already knows.
function outboundBlocked (snapshot) {
  const s = snapshot || {}
  const night = !!s.isNight
  const stuck = !!s.nightStuck
  if (stuck) return null // eternal night: hiding is not a survivable resolution - go, carefully
  if (!s.underArmored) return null // an armoured bot may work the night (today's behaviour)
  if (process.env.RESILIENT_RECOVERY === '0') return night ? 'dawn' : null // today: night-only
  // Night keeps the headline rule unconditionally. By day the block requires a re-arm source the
  // ladder can ACTUALLY reach (#86 LADDER_REARM_REAL) - without that clause a bot with no bank kit
  // and no grave would be permanently barred from the very treks that feed it.
  if (night) return 'dawn'
  const reArm = process.env.LADDER_REARM_REAL !== '0' ? hasLadderReArm(s) : reArmSourceAvailable(s)
  return reArm ? 'armor' : null
}

// ---- outboundAdmissible (AUDIT 2026-08-02, defect: ONE RULE, THREE PATHS) ---------------
// "Am I fit to be out there right now?" has exactly two clauses, and they had three copies:
//
//   the ARMOUR/DARK clause - outboundBlocked(), above. Extracted on 2026-07-29 and genuinely
//                            shared since (rungFeasible + journeyAdmissible + the producer route).
//   the HP clause          - written TWICE, with two env names and the same default of 6:
//                            food.outboundRungAdmissible (LADDER_HP_ABORT), reachable from exactly
//                            ONE call site - the recovery ladder's per-rung isStopped - and a
//                            hand-written `hp <= JOURNEY_HP_FLOOR` inside journeyAdmissible, which
//                            only long crossings ask.
//
// So every journey that is neither a ladder rung nor a homecoming asked NEITHER. That is the same
// exemption outboundBlocked's own comment describes, arriving from the other direction, and it was
// measured on 2026-08-02 18:43-18:47 local: `activity=gearup`, armor 0, isNight TRUE, four deaths
// in four minutes at 254,-161 / 216,-150 / 203,-72 / 141,-78 (70-170b from home at 188,-104), hp
// 20 -> 0 each time. `gearup` is BY DEFINITION the journey an unarmoured bot makes to find armour,
// and it is a COMMAND (commands.js armorup) rather than a rung or a scheduler dispatch - so no
// layer in the system had a rule to ask about it.
//
// This is the ONE composed verdict, and every journey asks THIS. The hp clause DELEGATES to
// food.outboundRungAdmissible rather than re-stating it, so the FOOD_FLOOR carve-outs (the one
// bounded fishing rung may run at 1 hp when the bot is genuinely starving) keep their single
// definition too. `opts` is the CALLER's decision about whether that carve-out applies - it is
// deliberately narrow (the ladder passes food ONLY for the secureFood rung), and passing nothing
// gives the plain hp<=6 abort, which is what every non-food journey wants.
//
// Returns the same {ok, blockedOn, why} shape journeyAdmissible returns, so a caller can feed
// `blockedOn` straight to needProducer and get the job that clears it (#5: name the owner).
function outboundAdmissible (snapshot, opts = {}) {
  const s = snapshot || {}
  if (!foodSec.outboundRungAdmissible(s.hp, opts)) {
    return { ok: false, blockedOn: 'heal', why: 'hp ' + s.hp + ' - too hurt to be out in the open' }
  }
  const ob = outboundBlocked(s)
  if (ob) return { ok: false, blockedOn: ob, why: ob === 'dawn' ? 'un-armoured at night - the dark is what keeps killing me' : 'un-armoured with a re-arm i can reach - re-arm before travelling' }
  return { ok: true, blockedOn: null, why: 'fit to be out' }
}

// ---- journeyAdmissible (AUDIT FIX 2) ----------------------------------------------------
// PURE. May the bot set out on a journey of `dist` blocks RIGHT NOW? This is outboundBlocked
// plus the two things a rung never had to think about and a 470-block homecoming does: how far
// the walk is, and whether the last few attempts at it ended in a corpse.
//
// The short-hop exemption is what keeps this from becoming a trap: a bot may ALWAYS move locally
// (to a bed, out of a pit, to the animal it can see), so no condition here can ever leave it
// unable to act. Only genuinely long, exposed journeys are gated.
const SHORT_HOP = 32
function journeyAdmissible (snapshot, dist, opts = {}) {
  const s = snapshot || {}
  const d = dist != null ? dist : 0
  const shortHop = opts.shortHop != null ? opts.shortHop : SHORT_HOP
  if (d <= shortHop) return { ok: true, blockedOn: null, why: 'short hop - always allowed' }
  // FIX 5: a bot that cannot read its own vitals must not set out across open ground. Every
  // predicate here defaults a missing vital to 20, so without this a BLIND snapshot reads as a
  // perfectly healthy one and a 500-block crossing comes back `clear to travel` (demonstrated
  // 2026-07-29). Short hops stay allowed above, so this can never immobilise the bot.
  if (s.vitalsKnown === false || s.hp == null || s.food == null) {
    return { ok: false, blockedOn: 'vitals', why: 'cannot read my own hp/food - not crossing open ground blind' }
  }
  if (s.nightStuck) return { ok: true, blockedOn: null, why: 'eternal night - waiting resolves nothing' }
  // Immediate danger is the reflex stack's, not a travel decision - but do not START a long walk in it.
  if (s.inLava || s.onFire || s.drowning) return { ok: false, blockedOn: 'danger', why: 'in immediate danger - not setting out' }
  // THE TWO CLAUSES, through their ONE definition. This used to be a hand-written `hp <=
  // JOURNEY_HP_FLOOR` (a second name for LADDER_HP_ABORT, same default 6, same meaning) followed
  // by the shared outboundBlocked. JOURNEY_HP_FLOOR is DELETED, not renamed - it was a duplicate
  // of a rule that already had an owner, and a flag no deployment sets (#4, and the flag-debt
  // habit: prefer deleting a dead flag to adding one). No opts: the FOOD_FLOOR fishing carve-out
  // is a RUNG-level decision and must never admit a 400-block crossing at 3 hp.
  const adm = outboundAdmissible(s)
  if (!adm.ok) return { ok: false, blockedOn: adm.blockedOn, why: adm.why }
  // THE SPIRAL CLAUSE. A bot that has died repeatedly and is still under-armoured must stop
  // attempting the long crossing that is killing it, EVEN BY DAY. deathsRecent is a 20-minute
  // window (grave.js), so this releases itself by condition - a bot that survives 20 minutes may
  // try again. This is the clause that ends the treadmill: attempt 3 does not become attempt 8.
  const far = Number(process.env.JOURNEY_FAR || 128)
  if (d > far && (s.deathsRecent || 0) >= Number(process.env.SPIRAL_N || 3) && s.underArmored) {
    return { ok: false, blockedOn: 'anchor', why: `${s.deathsRecent} deaths in the last 20 min and ${Math.round(d)}b to cross un-armoured - this crossing is what is killing me` }
  }
  const food = s.food != null ? s.food : 20
  if (d > far && food < 6 && !(s.packFoodPts > 0)) return { ok: false, blockedOn: 'food', why: 'food ' + food + ' with an empty pack - would starve before arriving' }
  return { ok: true, blockedOn: null, why: 'clear to travel' }
}

// ---- homecomingPlan (AUDIT FIX 2) -------------------------------------------------------
// PURE. The post-respawn decision, as a VERDICT rather than an unconditional walk.
//   'stay'      already home (or nowhere to go) - nothing to do
//   'travel'    the crossing is survivable - go
//   'stabilise' it is not - become safe HERE, and travel when `blockedOn` has cleared
// `stabilise` is the whole point of the fix: recovery is reaching a survivable STATE, and the bot
// must be able to reach one anywhere in the world, not only on one remembered coordinate.
function homecomingPlan (snapshot, opts = {}) {
  const s = snapshot || {}
  const dist = s.homeDist
  const homeDist = opts.homeDist != null ? opts.homeDist : dist
  if (homeDist == null) return { action: 'stay', why: 'no home anchor remembered', blockedOn: null }
  const far = opts.far != null ? opts.far : Number(process.env.RECOVER_HOME_DIST || 64)
  if (homeDist <= far) return { action: 'stay', why: 'already home (' + Math.round(homeDist) + 'b)', blockedOn: null }
  const j = journeyAdmissible(s, homeDist, opts)
  if (j.ok) return { action: 'travel', why: 'clear to cross ' + Math.round(homeDist) + 'b home', blockedOn: null }
  return { action: 'stabilise', why: j.why, blockedOn: j.blockedOn }
}

function rungFeasible (rung, snapshot) {
  const r = rung || {}
  const s = snapshot || {}
  const night = !!s.isNight
  const stuck = !!s.nightStuck
  if (r.dayGated && night && !stuck) return false
  // P5 anti-spiral: during a death spiral, seal near the hut - no grave chase (R1), no outbound trek
  // (R3/R4). rearmFromBank (walks HOME) + R0/R2/R5 stay admissible so the bot re-arms + holds, not
  // marches back into the death cluster. RESILIENT_RECOVERY=0 -> spiralActive() is always false.
  if (spiralActive(s) && !stuck && (r.rung === 'R1' || OUTBOUND_RE.test(r.action || ''))) return false
  // P3 / #86 LADDER_REARM_REAL: the "never set out un-armoured" rule. Its definition now lives in
  // outboundBlocked() above, because the post-respawn homecoming needs the SAME rule and used to
  // have none (audit §1 LOOP A). Same clauses, same flags - one copy.
  if (OUTBOUND_RE.test(r.action || '') && outboundBlocked(s)) return false
  return true
}

// ---- recoverySignature (AUDIT 2026-07-29 FIX 3) -----------------------------------------
// PURE. A compact string of EVERYTHING the recovery ladder's plan and feasibility depend on.
//
// The livelock it exists to end (audit §1 LOOP B): recoverFromDegraded keeps its `tried` set per
// CALL, so a pass that achieved nothing returns `all rungs tried`, the tick waits 60s, calls it
// again with a fresh `tried` set against an unchanged world, and derives the identical plan with
// the identical two no-op rungs. Forever - while the food bar drains. On 2026-07-20 the ladder was
// chosen 300+ times and reported `NOT recovered` 41 times; the bot never left the loop under its
// own power.
//
// Re-running a plan whose INPUTS have not changed cannot produce a different result. So a ladder
// pass that made no progress is not retried until this signature changes - a CONDITION gate, never
// a timer (design principle 6). Everything that could make a previously-infeasible rung feasible is
// in here: the hour, the gear, the vitals, the graves, whether home/farm/bank can help.
//
// Vitals are bucketed deliberately. Exact values would change on every regen tick and re-open the
// spin; buckets change when something MEANINGFUL happened. A bucket boundary crossing downward
// (getting worse) is exactly when a fresh attempt is warranted, which is the behaviour we want.
function recoverySignature (snapshot) {
  const s = snapshot || {}
  const bucket = (v, size) => (v == null ? 'x' : Math.floor(v / size))
  const graves = gravesOf(s)
  const near = graves.reduce((m, g) => (g && g.dist != null && g.dist < m ? g.dist : m), Infinity)
  return [
    'n' + (s.isNight ? 1 : 0) + (s.nightStuck ? 's' : ''),
    'a' + (s.armorPieces != null ? s.armorPieces : 'x') + (s.underArmored ? 'u' : ''),
    'h' + bucket(s.hp, 4),
    'f' + bucket(s.food, 4),
    'p' + (s.packFoodPts > 0 ? 1 : 0),
    'b' + (s.bankFoodPts > 0 ? 1 : 0),
    'g' + graves.length + (isFinite(near) ? ':' + Math.round(near / 16) : ''),
    'H' + (s.homeDist == null ? 'x' : Math.round(s.homeDist / 32)),
    'F' + (s.farm && s.farm.exists ? 1 : 0),
    'k' + (bankHasSpareKit(s) ? 1 : 0),
    'd' + (s.deathsRecent || 0),
    't' + ((s.tools && s.tools.pick) ? 1 : 0) + ((s.tools && s.tools.sword) ? 1 : 0)
  ].join('|')
}

// ---- ladderBlocker (AUDIT 2026-07-29 FIX 3) ---------------------------------------------
// PURE. When a ladder pass achieved nothing, WHY? Names the condition that has to change before
// another pass could do better - so the log says something actionable and the tick has a condition
// to wait on instead of a 60-second timer.
//
// The rungs that can actually IMPROVE the bot's state (fetch gear, fetch food) are the productive
// ones; R2's walk-home and R5's hold cannot move the ladder's exit condition by themselves, which
// is exactly why a plan of only-R2-and-R5 spun forever on 2026-07-20 while food fell 9 -> 7.
const PRODUCTIVE_RUNG_RE = /^(recoverGrave|rearmFromBank|trekFarm|trekOrchard|secureFood)/
function ladderBlocker (snapshot) {
  const s = snapshot || {}
  const plan = recoveryPlan(s)
  const productive = plan.filter(r => PRODUCTIVE_RUNG_RE.test(r.action || ''))
  if (!productive.length) return 'no-producer' // nothing in the known world can supply what we lack
  const feasible = productive.filter(r => rungFeasible(r, s))
  if (!feasible.length) {
    if (spiralActive(s) && !s.nightStuck) return 'spiral'
    return outboundBlocked(s) || (s.isNight ? 'dawn' : 'blocked')
  }
  return 'no-progress' // a productive rung was allowed to run and still nothing improved
}

// PURE. The plain-language half of the same verdict - what the operator reads in the log.
const BLOCKER_TEXT = {
  dawn: 'un-armoured at night: every food/gear run is barred until morning',
  armor: 're-arm first: there is gear i can reach and i should not forage without it',
  spiral: 'death spiral: staying sealed near home instead of walking back into it',
  'no-producer': 'nothing in the world i know of can supply this - no reachable grave, farm or forage',
  'no-progress': 'the rungs that could have helped ran and produced nothing',
  blocked: 'no rung that could help is admissible right now'
}
function blockerText (b) { return BLOCKER_TEXT[b] || String(b || 'unknown') }

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

// ==== RESILIENT RECOVERY (#41) - PURE predicates ==========================================
// Flag RESILIENT_RECOVERY (default on; =0 restores today). These are all side-effect-free and
// read the flag/knobs LIVE (per call) so they unit-test in both regimes and honor operator
// overrides without a restart. The impure wiring (latch state, snapshot build, the ladder loop)
// lives in index.js / provision.js / commands.js and consults these.

// bankHasSpareKit(s) -> is a full spare set banked? (4 armor + a pick + a sword.) Reads the
// cachedOnly snapshot fields set by schedulerState (bankArmorPieces/bankHasPick/bankHasSword).
function bankHasSpareKit (s) {
  return (s.bankArmorPieces || 0) >= 4 && !!s.bankHasPick && !!s.bankHasSword
}
// A SAFE, reachable grave that actually holds gear (a re-arm source competing with the bank).
function hasSafeGraveWithGear (s) {
  const band = Number(process.env.GRAVE_NEAR_LADDER || 32)
  return gravesOf(s).some(g => g && !g.dangerous && g.hasGear && g.dist != null && g.dist <= band && !gravePolicy.graveSalvageBlocked(g)) // #112: a grave the bot cannot survive reaching is not a re-arm source
}
// Is there ANY way to re-arm right now? bank spare, a safe grave with gear, or gearup off back-off.
function reArmSourceAvailable (s) {
  return bankHasSpareKit(s) || hasSafeGraveWithGear(s) || (s.gearupBackoffUntil || 0) <= nowFn()
}
// The re-arm sources the recovery LADDER can actually reach: a banked spare kit (the rearmFromBank
// rung) or a safe grave with gear (the recoverGrave rung). Gearup is deliberately EXCLUDED - it is
// not a recovery rung and does not run while the post-death latch owns the body (index GEAR_REFLEX
// stands down for isRecoveringDegraded), so its back-off never arms during the hold. So a bot with
// no bank kit and no grave has NOTHING the recovery ladder can gear it up with. (cf.
// reArmSourceAvailable, which also counts gearup-off-back-off = "gearup could be tried later".)
function hasLadderReArm (s) {
  return bankHasSpareKit(s) || hasSafeGraveWithGear(s)
}

// ==== RECOVERY_UNBLOCK (#64) - release the build when gear-up is genuinely UNACHIEVABLE ====
// Flag RECOVERY_UNBLOCK (default on; =0 -> these return false = today byte-for-byte). The live
// stall: after a death the bot respawns naked with an empty pack, no grave, and an empty bank, so
// recoveryReady can NEVER reach its full-gear exit (no pick/sword, armor fuel-blocked, no bank kit,
// no obtainable re-arm) - the post-death latch holds the build forever and the bot cycles in place.
// The operator's rule: "the goal isn't that the bot never dies, it's that it doesn't spiral and not
// get progress done." So when the bot is SURVIVABLE but cannot make progress toward gear, RELEASE
// the build (unarmored + resuming beats frozen; resuming also frees GEAR_REFLEX to run the iron
// grind that the latch was suppressing). A REAL survival need (low hp/food) still holds - the
// SURVIVABLE floor (RECOVERY_UNBLOCK_HP~16 / RECOVERY_UNBLOCK_FOOD~14) is the anti-spiral guard.

// gearUpUnachievable(s) -> bool. The PROMPT (clockless) release, folded into recoveryReady. Fires
// when the bot is survivable AND there is NO re-arm source left AT ALL (no bank kit, no safe grave,
// AND gearup is on back-off) - i.e. gearup has provably been tried and failed. Conservative by
// design: while gearup is still off back-off it reads as "gear obtainable" and does NOT release, so
// this never short-circuits a bot that could still gear up. =0 -> false.
function gearUpUnachievable (s) {
  if (process.env.RECOVERY_UNBLOCK === '0') return false
  const ss = s || {}
  const hp = ss.hp != null ? ss.hp : 20
  const food = ss.food != null ? ss.food : 20
  const survivable = hp >= Number(process.env.RECOVERY_UNBLOCK_HP || 16) && food >= Number(process.env.RECOVERY_UNBLOCK_FOOD || 14)
  return survivable && !reArmSourceAvailable(ss)
}

// recoveryStuckRelease({ hp, food, ladderReArm, sinceDeathMs }) -> bool. The TIME-BOUNDED release,
// consulted by the impure recoveryReadyNow (which owns the P0 latch clock). Fires when the bot is
// survivable, the recovery ladder has NO re-arm it can reach (no bank kit, no safe grave), and the
// latch has held for >= RECOVERY_STUCK_MS. This is the one that breaks the live stall: gearup never
// gets a turn under the latch, so its back-off never arms and gearUpUnachievable can't fire - after
// RECOVERY_STUCK_MS with nothing the ladder can do, holding longer is pure loss. RECOVERY_MAX_MS
// remains the ultimate ceiling above this (a survivable bot never holds longer than that). =0 ->
// false (the RECOVERY_MAX_MS-only backstop stands, byte-for-byte).
function recoveryStuckRelease ({ hp, food, ladderReArm, sinceDeathMs } = {}) {
  if (process.env.RECOVERY_UNBLOCK === '0') return false
  const h = hp != null ? hp : 20
  const f = food != null ? food : 20
  const survivable = h >= Number(process.env.RECOVERY_UNBLOCK_HP || 16) && f >= Number(process.env.RECOVERY_UNBLOCK_FOOD || 14)
  if (!survivable || ladderReArm) return false
  return (sinceDeathMs || 0) >= Number(process.env.RECOVERY_STUCK_MS || 120000)
}

// recoveryReady(snapshot) -> { ready, maxCaution, reason }. Replaces ladderDone's naked-tolerant
// exit (RC-D): a bot is "recovered" only at hp>=HP_OK(18) AND food>=14 AND 4 armor AND pick&&sword.
// Deadlock escape (P4, honest boundedness): if armor is short but the WORLD affords no re-arm
// (no bank spare AND no safe grave AND gearup on back-off), accept "best-affordable" -> ready WITH
// maxCaution raised (P5). Vitals + core tools are ALWAYS required (a toolless bot is never ready;
// the RECOVERY_MAX_MS ceiling in the impure wrapper is the ultimate never-hides-forever backstop).
function recoveryReady (snapshot) {
  const s = snapshot || {}
  const HP_OK = Number(process.env.HP_OK || 18)
  const hp = s.hp != null ? s.hp : 20
  const food = s.food != null ? s.food : 20
  const armorPieces = s.armorPieces != null ? s.armorPieces : 0
  const tools = s.tools || {}
  const coreTools = !!tools.pick && !!tools.sword
  const vitalsOk = hp >= HP_OK && food >= 14
  // RECOVERY_UNBLOCK (#64): a survivable bot with NO re-arm source left (gearup provably exhausted)
  // releases the build here - even naked/toolless - instead of being trapped by the coreTools/vitals
  // gates below forever. Reuses the best-affordable path (ready WITH maxCaution). Conservative: only
  // fires when reArmSourceAvailable is false (gearup on back-off), so a bot that could still gear up
  // keeps recovering. =0 -> gearUpUnachievable is always false, so the rest is byte-for-byte.
  // FIX 5: "recovered" is a claim about vitals, so it may not be made from vitals nobody read.
  // Without this, a snapshot whose vitals read failed defaults to hp 20 / food 20 and the bot
  // declares itself recovered, clears the post-death latch and resumes the build.
  if (s.vitalsKnown === false || s.hp == null || s.food == null) return { ready: false, maxCaution: true, reason: 'cannot read my own vitals - not calling myself recovered' }
  if (gearUpUnachievable(s)) return { ready: true, maxCaution: true, reason: 'gear-up unachievable (survivable, no re-arm source) - releasing the build, max caution' }
  if (!coreTools) return { ready: false, maxCaution: false, reason: 'missing core tools (pick/sword)' }
  if (!vitalsOk) return { ready: false, maxCaution: false, reason: 'vitals not restored (hp>=' + HP_OK + ' food>=14)' }
  if (armorPieces >= 4) return { ready: true, maxCaution: false, reason: 'fully recovered' }
  // armor short: ready ONLY if there is no re-arm source left (else keep recovering -> re-arm first).
  if (!reArmSourceAvailable(s)) return { ready: true, maxCaution: true, reason: 'best-affordable (no armor source; gearup on back-off) - resuming with max caution' }
  return { ready: false, maxCaution: false, reason: 'under-armored with a re-arm source available' }
}

// resumeGate({ postDeathRecovery, ready }) -> 'wait' | 'proceed'. The P0 latch gate the build-
// resume consults: while the post-death latch is set and recovery is not yet ready, the build WAITS
// (kept on disk, does not drive the bot). Pure so the center-of-the-design invariant is offline-tested.
function resumeGate ({ postDeathRecovery, ready } = {}) {
  return (postDeathRecovery && !ready) ? 'wait' : 'proceed'
}

// preemptCrisisGrade({ name, deathsRecent, postDeathRecovery }) -> bool. The busy-gate preempt
// verdict for a survival job over a busy build. `recover` is always crisis-grade. recoverFromDegraded
// is crisis-grade at deathsRecent>=2 (today) OR, under the P0 latch, UNCONDITIONALLY (so recovery
// preempts on the FIRST death, not the third). RESILIENT_RECOVERY=0 -> the >=2 gate byte-for-byte.
function preemptCrisisGrade ({ name, deathsRecent, postDeathRecovery } = {}) {
  if (name === 'recover') return true
  if (name === 'recoverFromDegraded') {
    if (process.env.RESILIENT_RECOVERY !== '0' && postDeathRecovery) return true
    return (deathsRecent || 0) >= 2
  }
  return false
}

// admissibleUnderLatch(cmdClass, line, snapshot, postDeathRecovery) -> { allow, reason }. P0.4:
// while the post-death recovery latch is set, recovery-class commands are NOT muzzled by the busy-
// gate - survival commands and explicit recovery moves (recover/getstuff/retreat/goto-home) pass so
// the bot can retreat + re-arm. Otherwise defers to admissible() (today's verdict). Pure.
function isRecoveryMove (line) {
  const l = String(line == null ? '' : line).trim()
  return /^[!/]*(recover|getstuff|retreat)\b/i.test(l) || /^[!/]*(goto|travel|come)\s+home\b/i.test(l)
}
function admissibleUnderLatch (cmdClass, line, snapshot, postDeathRecovery) {
  if (postDeathRecovery && process.env.RESILIENT_RECOVERY !== '0') {
    if (cmdClass === 'survival') return { allow: true, reason: 'post-death recovery - survival command owns the body' }
    if (isRecoveryMove(line)) return { allow: true, reason: 'post-death recovery - recovery move allowed' }
  }
  return admissible(cmdClass, snapshot)
}

// spiralActive(snapshot) -> bool. P5 anti-spiral: deathsRecent >= SPIRAL_N(3) within the 20-min
// window = MAX-CAUTION (no grave chase, no outbound trek; stay sealed near the hut until recovered).
// RESILIENT_RECOVERY=0 -> always false (today).
function spiralActive (s) {
  if (process.env.RESILIENT_RECOVERY === '0') return false
  return ((s && s.deathsRecent) || 0) >= Number(process.env.SPIRAL_N || 3)
}

// withinDeathZone(target, deathCells, r) -> bool. P5c: is a leg's target within DEATH_ZONE_R(24) of
// any recent death cell? Used to DEFER marching back into a death cluster during a spiral. XZ only
// (respawn Y varies). Pure.
function withinDeathZone (target, deathCells, r) {
  if (!target || !Array.isArray(deathCells)) return false
  const R = r != null ? r : Number(process.env.DEATH_ZONE_R || 24)
  return deathCells.some(c => c && Math.hypot(c.x - target.x, c.z - target.z) <= R)
}

// ---- tickDelayMs (AUDIT 2026-07-29 FIX 19) ----------------------------------------------
// PURE. How soon must the next decision be made?
//
// The scheduler tick rescheduled itself at a flat 15s ± 3s, whatever was happening. That is a
// sampling rate chosen for a calm bot, applied to a dying one. Live, 2026-07-29 18:40: the bot
// fell to hp 1 and died to a second fall ELEVEN SECONDS later, having made no deliberate decision
// in between - its next one was up to 18 seconds away. The 8-second HP_CRISIS reflex that used to
// cover this was switched off when the scheduler took over survival dispatch
// (`if (SCHED_ON) return`), so the migration traded response time for central control and nobody
// measured the cost.
//
// This is not a "blanket timer" of the kind the design principles forbid - those are *holds*, gates
// on elapsed time. This is a SAMPLING RATE, and the rule is that it must be proportional to how
// fast the situation can turn lethal. At hp 1 the world can end in under two seconds, so that is
// how often the bot must be allowed to think.
//
// Caller adds jitter (only meaningful on the calm cadence; a crisis should not be de-synchronised).
const TICK_CALM_MS = 15000
const TICK_ALERT_MS = 6000
const TICK_CRISIS_MS = 2000
function tickDelayMs (vitals = {}, opts = {}) {
  const calm = opts.calmMs != null ? opts.calmMs : TICK_CALM_MS
  const alert = opts.alertMs != null ? opts.alertMs : TICK_ALERT_MS
  const crisis = opts.crisisMs != null ? opts.crisisMs : TICK_CRISIS_MS
  const hp = vitals.hp
  const food = vitals.food
  // CRISIS - death is seconds away regardless of what the bot is doing. Mirrors mortalDanger's
  // class (lava/fire/drowning/critical hp) plus a starving-to-death floor.
  if (vitals.inLava || vitals.onFire || vitals.drowning) return crisis
  if (hp != null && hp <= (opts.hpCritical != null ? opts.hpCritical : 6)) return crisis
  if (food != null && food <= 2) return crisis
  // ALERT - hurt, or something is on us. Not lethal this second, but the situation is moving.
  if (hp != null && hp <= (opts.hpLow != null ? opts.hpLow : 10)) return alert
  if (vitals.threatDist != null && vitals.threatDist <= 6) return alert
  if (vitals.creeperDist != null && vitals.creeperDist <= 12) return alert
  return calm
}

// ---- watchdog ---------------------------------------------------------------------------
// PURE danger-scaled forward-progress verdict (§6). Windows are additive thresholds on the SAME
// idleMs (nudge at [nudgeMs, failMs), fail at >= failMs); failMs = 2*nudgeMs gives the
// "second consecutive window -> fail" damping without per-call state. `now` defaults to nowFn().
// NOTE: uses `!= null` (not `||`) to read the timestamps so an epoch-0 lastProgressAt/startedAt
// is honored rather than treated as "unset" (the `||` in the design pseudocode would misread 0).

// The survival job's forward-progress windows, named because a SECOND reader needs them:
// provision-recovery's rung deadline is derived from SURVIVAL_FAIL_MS + LATCH_GRACE_MS, i.e.
// from the exact instant this supervisor concludes a survival job is hung and its stop latch
// has provably failed to bite. Extracted, not copied (#4) - the literals used to live only
// inside watchdog() below, so any second reader would have been a drifting duplicate.
const SURVIVAL_NUDGE_MS = 45000
const SURVIVAL_FAIL_MS = 90000

// ==== THE CRISIS WINDOW MUST NOT CUT THE JOB THAT ENDS THE CRISIS (2026-08-02) ============
// The critical-vitals window (20s/40s) used to be tested FIRST, so it applied to every job -
// including the survival job dispatched precisely to answer that crisis. The hungrier the bot
// got, the LESS time its food run was given, which inverts the whole point of the escalation:
//   17:17:48 (wd) NUDGE secureFood - no verified progress for 23s (hp 19 food 2) - marking stalled
//   17:18:08 (wd) FAIL-JOB secureFood - no verified progress for 43s - setting its stop latch
//   17:18:46 [prov] farm health: inspected 10/41 cell(s) - SCAN CUT (stopped) after 10: wheat=8(mature 8)
// The stop latch cut the tend pass at cell 10 of 41 with EIGHT MATURE WHEAT standing in the
// field, and the bot went on oscillating food 20->0 for hours. Cutting the answer to a crisis
// does not produce a better alternative: the chooser re-picks the same job (it is still the
// need), which restarts from zero and throws away the walk it had already paid for.
//
// What the short window is FOR is the other case - work that is NOT the answer (a build, a
// chore, a trek) must be taken off the body fast when death is seconds away, so the chooser can
// hand the body to survival. So the window is selected by the JOB'S OWN CLASS, which already
// exists and is already what the snapshot reports (survival-snapshot.activeJobInfo -> cls, from
// commandClass / the survival latches). No job is named here: `secureFood` is not special, the
// SURVIVAL CLASS is - single-goal discipline (#11) says the chooser already decided this job is
// the response, and the supervisor's job is to give that response its window, not to second-
// guess it 20 seconds in.
//
// It also makes the two DERIVED ceilings true again. navigate.supervisorPatienceMs() and
// provision-recovery.RUNG_NOPROGRESS_MS both restate SURVIVAL_FAIL_MS as "the instant the
// supervisor concludes this survival job is hung" - a promise the crisis branch quietly broke,
// leaving the inner layers budgeting to 90s while the supervisor was cutting at 40s. One rule,
// one number ([[threshold-seams]]).
function watchdog (activeJob, vitals, now) {
  if (!activeJob) return 'ok'
  const t = now != null ? now : nowFn()
  const v = vitals || {}
  const base = activeJob.lastProgressAt != null ? activeJob.lastProgressAt
    : (activeJob.startedAt != null ? activeJob.startedAt : t)
  const idleMs = t - base
  let nudgeMs, failMs
  const critical = (v.hp != null && v.hp <= 6) || (v.food != null && v.food <= 2)
  if (activeJob.cls === 'survival') { nudgeMs = SURVIVAL_NUDGE_MS; failMs = SURVIVAL_FAIL_MS } // the answer to the crisis keeps its window AT the crisis
  else if (critical) { nudgeMs = 20000; failMs = 40000 } // critical, and this work is not the answer: seconds
  else { nudgeMs = 120000; failMs = 240000 } // patient when cheap
  if (idleMs >= failMs) return 'fail-job'
  if (idleMs >= nudgeMs) return 'nudge'
  return 'ok'
}

// ---- wdPhase (S7 §3.4b) -----------------------------------------------------------------
// PURE escalation reducer over the `watchdog` verdict STREAM for the CURRENT job. Latches a phase
// so each escalation fires exactly ONCE, and returns the ACT the index applies (it holds no clock,
// no bot - all side effects live in index.js). Phases: ok -> nudged -> failed -> gaveup.
//   act 'none'   - do nothing
//   act 'nudge'  - loud log + markStalled (the FIRST nudge while phase ok; the job's own recovery
//                  and the other watchdogs get first crack - a log line + a flag fight nothing)
//   act 'fail'   - set the job's EXISTING stop latch + recordOutcome (the FIRST fail-job)
//   act 'giveup' - log once + stand down for this jobKey (a fail-job STILL arriving AFTER the fail
//                  was applied => the stop latch provably didn't bite: a hung promise, layer d's class)
// A jobKey change resets to `ok` (a fresh job's clock starts clean); an `ok` verdict resets. The
// giveup lands on the next fail-job observation after the fail (>=5s / one watchdog pass later - the
// bounded reading of "still failing after the fail was applied"; the exact failMs delay is not
// safety-critical, this branch only hands a latch-immune hang to the supervisor).
// How long a stop latch gets to BITE before "it did not bite" is an honest conclusion. Every
// latch in the lever map is COOPERATIVE - a job only observes it when it next polls isStopped(),
// which it cannot do while parked in an await. The hang that produced this was a 20s windowOpen
// timeout with one retry, so a cooperative job needs ~40s of room; 60s gives it that.
// This is a DEADLINE ON AN ATTEMPT (the latch's attempt to stop the job), not a delay before
// thinking: the fail rung still fires instantly, and the ladder still escalates - it just has to
// wait for the evidence it claims to have.
const LATCH_GRACE_MS = 60000

function wdPhase (prev, verdict, jobKey, now, opts = {}) {
  const p = prev || {}
  if (jobKey == null) return { phase: 'ok', jobKey: null, act: 'none' }
  const phase = (p.jobKey === jobKey) ? (p.phase || 'ok') : 'ok' // a new job resets the ladder
  if (verdict === 'ok') return { phase: 'ok', jobKey, act: 'none' }
  if (verdict === 'nudge') {
    if (phase === 'ok') return { phase: 'nudged', jobKey, act: 'nudge', failedAt: p.failedAt }
    return { phase, jobKey, act: 'none', failedAt: p.failedAt } // already escalated - a nudge never de-escalates
  }
  if (verdict === 'fail-job') {
    if (phase === 'ok' || phase === 'nudged') return { phase: 'failed', jobKey, act: 'fail', failedAt: now }
    if (phase === 'failed') {
      // ==== GIVEUP IS A VERDICT ABOUT THE LATCH, SO IT NEEDS EVIDENCE (2026-07-30) ==========
      // This used to escalate on the NEXT fail-job verdict, unconditionally. The watchdog ticks
      // every 5s and the verdict is derived from lastProgressAt - which of course has not moved
      // 5s later - so `failed -> gaveup` was not an inference, it was a countdown. Live, every
      // giveup on autobuild landed EXACTLY 5.0s after its FAIL-JOB, twelve times in five hours:
      //   18:14:38 (wd) FAIL-JOB autobuild - no verified progress for 245s - setting its stop latch
      //   18:14:43 (wd) stop latch ineffective on autobuild - a hung promise; taking the body back
      //   18:14:43 (wd) autobuild holds no dispatch slot - releasing the controls instead
      // ...and 10s later `chose build/idle: continuing the active build [holding - making
      // progress]`. The job was slow, not hung, and the terminal rung yanked its controls.
      // "The latch did not bite" is a claim about the latch; it may only be made once the latch
      // has actually had the chance. A missing clock is UNKNOWN, and the destructive rung fails
      // CLOSED on unknown - it waits rather than seizing the body.
      const grace = opts.latchGraceMs != null ? opts.latchGraceMs : LATCH_GRACE_MS
      const since = (now != null && p.failedAt != null) ? now - p.failedAt : null
      if (since == null || since < grace) return { phase: 'failed', jobKey, act: 'none', failedAt: p.failedAt }
      return { phase: 'gaveup', jobKey, act: 'giveup', failedAt: p.failedAt, latchIdleMs: since }
    }
    return { phase: 'gaveup', jobKey, act: 'none', failedAt: p.failedAt } // already gave up - silence for this jobKey
  }
  return { phase, jobKey, act: 'none', failedAt: p.failedAt }
}

// ---- graveCooldownMs (task #18 M4) ------------------------------------------------------
// PURE verdict-classed re-dispatch back-off, derived from doRecover's RESULT STRING (the same
// string-match contract the index recover dispatch uses for `retrieved`). Replaces the blanket
// 300s-on-any-non-retrieval so a stalled PARTIAL comes straight back inside the despawn window
// instead of losing the remaining items. flagOn=false (GRAVE_URGENT=0) -> today's single 300s
// branch, byte-equivalent. remainMs = the grave's despawn budget (Infinity/unset -> the 300s
// ceiling). Returns milliseconds; 0 = no cooldown (retrieved/gone - the grave leaves the snapshot).
//   retrieved / gone                                  -> 0
//   partial ("still has the rest") / capacity ("full")-> GRAVE_COOLDOWN_HOT_MS (floor 15s)
//   won't open (unopened / loose-only)                -> 120s
//   travel failure ("couldn't get back") / throw ('') -> min(300s, max(60s, remainMs/2))
function graveCooldownMs (result, { remainMs, flagOn, hotMs, blanketMs } = {}) {
  const r = String(result || '')
  const blanket = blanketMs != null ? blanketMs : Number(process.env.SCHED_GRAVE_COOLDOWN_MS || 300000)
  if (/got my stuff back|nothing left where i died/i.test(r)) return 0
  if (!flagOn) return blanket // GRAVE_URGENT=0: today's single 300s branch on any non-retrieval
  const HOT = Math.max(15000, hotMs != null ? hotMs : Number(process.env.GRAVE_COOLDOWN_HOT_MS || 30000))
  if (/the grave still has the rest|pack's full/i.test(r)) return HOT
  if (/won't open/i.test(r)) return 120000
  const rem = (remainMs != null && isFinite(remainMs)) ? remainMs : Infinity
  return Math.min(blanket, Math.max(60000, isFinite(rem) ? rem / 2 : blanket))
}

module.exports = {
  pickJob,
  bootstrapNeed,
  spawnBootstrapDue,
  buildReady,
  ironKeystoneActive,
  oppMaintain,
  graveCooldownMs,
  recoveryPlan,
  rungFeasible,
  outboundBlocked,
  outboundAdmissible,
  journeyAdmissible,
  homecomingPlan,
  recoverySignature,
  tickDelayMs,
  TICK_CALM_MS,
  TICK_ALERT_MS,
  TICK_CRISIS_MS,
  ladderBlocker,
  blockerText,
  OUTBOUND_RE,
  isOutboundAction: capabilities.isOutboundAction, // the ONE definition; OUTBOUND_RE is derived from it
  REFLEX_OWNED,
  producerIsOutbound,
  ladderDone,
  recoveryReady,
  resumeGate,
  preemptCrisisGrade,
  admissibleUnderLatch,
  isRecoveryMove,
  spiralActive,
  withinDeathZone,
  bankHasSpareKit,
  reArmSourceAvailable,
  hasLadderReArm,
  gearUpUnachievable,
  recoveryStuckRelease,
  isDegraded,
  commandClass,
  admissible,
  fightNotFlee,
  fightSuppressedWhenSubmerged,
  submergedEscapeDue,
  needProducer,
  NEED_PRODUCERS, // exported so the capability contract test can ENUMERATE it, not sample it
  watchdog,
  wdPhase,
  SURVIVAL_NUDGE_MS,
  SURVIVAL_FAIL_MS,
  LATCH_GRACE_MS,
  JOB_CLASSES,
  _setNow,
  setDebugSink,
  _reset: () => { nowFn = () => Date.now() } // test hygiene (module is near-stateless)
}
