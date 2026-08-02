'use strict'
// ==== #65 DYNAMIC_CORE Phase 1 - the CHOOSING layer =======================================
// ONE dynamic activity chooser that replaces the whack-a-mole pile (FOOD FLOOR / FARM FLOOR /
// harvest-first / bank-first / the fixed bootstrap order / the per-path night gates) with a single
// utility decision: assess the live snapshot, score each candidate activity, pick the max - EXCEPT
// a real survival crisis, which hard-dominates regardless of score (a guard, never a weight).
//
// This is DELIBERATELY behind the DYNAMIC_CORE flag and default OFF: index.js keeps calling the
// battle-tested scheduler.pickJob until the coordinator proves live parity, then flips the flag.
// So this file must be a faithful, PURE re-expression of the SAME decision the scheduler already
// makes - plus the two things the operator asked for that the branch pile could not do:
//   (1) dusk-recall EMERGES from risk x time-to-nightfall (never a per-path night gate);
//   (2) bootstrap-vs-build is a UTILITY trade-off (a naked bot bootstraps armor; a stocked one
//       builds), not a fixed hard-coded order.
//
// PURE by construction (plain snapshot in, a decision out) exactly like scheduler.js / arbiter.js:
//   - NO bot handle, NO world reads, NO fs.
//   - NO CLOCK. The one place time matters (hysteresis: give the active job a bounded bonus while it
//     is making verified progress) reads TWO timestamps the CALLER passes in (opts.now,
//     opts.lastProgressAt) and compares them. It NEVER reads a wall clock itself - there are zero
//     clock calls in this file (grep it). This is the operator's "no time-based holds in the core"
//     ([[no-blanket-time-holds]]): hysteresis is a progress-bonus, not a timer latch.
//
// It REUSES the existing authorities rather than re-deriving precedence (one-way requires, no cycle):
//   arbiter.jobSurvivalNeed   the single survival-need authority (the crisis guard)
//   scheduler.isDegraded      the compound-degraded signature -> the recovery ladder
//   scheduler.bootstrapNeed   the missing-survival-infra verdict (food-reserve > armor > base order)
//   scheduler.ironKeystoneActive / scheduler.needProducer / scheduler.JOB_CLASSES
// The grave/flee helpers below are tiny duplicates of scheduler.js internals (not exported there) -
// duplicated on purpose so this migration touches scheduler.js not at all, keeping the flag-OFF suite
// byte-for-byte.
//
// chooseActivity(snapshot, opts) -> { job, cls, reason, score, preempt, bootstrap[, standoff, refusals] }
//   opts.refused: (#114) a Map of candidate key -> why, for candidates whose EXECUTOR already declined
//            THIS tick; they score out and the tick re-selects. All-refused => standoff:true + refusals.
//   job    : an EXISTING dispatchable job name the S4 tick already knows how to run -
//            recoveryLadder | graveSweep | secureFood | recoverHp | nightShelter | maintenancePass
//            | 'flee' (reflex-owned, the tick no-ops it exactly as pickJob does) | null (build/idle
//            may proceed - the adapter hands null off to the existing build/resume/brain/idle tail).
//   cls    : survival | maintain | progress | idle (the preemption tier).
//   reason : PLAIN-LANGUAGE, greppable - the adapter logs `(core) chose <job>: <reason>`.
//   score  : the winning utility (a big sentinel for a hard-dominant survival guard).
//   preempt: true iff the chosen class out-ranks the active job's class (same test as pickJob).

const arbiter = require('./arbiter.js')      // one-way: the survival-need authority (no cycle: arbiter requires nobody here)
const scheduler = require('./scheduler.js')  // one-way, READ-ONLY reuse: isDegraded/bootstrapNeed/ironKeystoneActive/needProducer/JOB_CLASSES
const gravePolicy = require('./grave-policy.js') // one-way: PURE grave decisions (#112 salvageVerdict / net-of-risk scoring)
const reflexes = require('./reflexes.js')    // one-way: the proposal registry's PURE half (when/urgency); its executors require lazily

// ---- tuning constants (the utility weights) ---------------------------------------------
// Benefit tiers encode the operator's goal stack: survive > sustain > secure > build. They are
// MULTIPLIED by a live urgency and feasibility and DOCKED a live risk, so a high-tier candidate
// with no urgency (e.g. shelter at noon) still loses to a lower-tier one that is actually due.
const W_SURVIVE = 1.0   // dusk-recall / go-home-to-shelter: protecting the body itself
const W_SECURE = 0.6    // maintenancePass: bootstrap missing infra (armor/food-reserve/lit base) + upkeep
const W_CONTINUE = 0.65 // build(null) baseline while a progress job is ALREADY running (single-goal discipline)
const W_RESUME = 0.2    // build(null) baseline when a saved build is waiting to resume (below any real bootstrap)
const W_IDLE = 0.1      // build(null) baseline when there is nothing to build (pure idle)
// #119 COMMITMENT_LEDGER: reclamation's benefit ceiling. Set BELOW W_RESUME (0.2) on purpose -
// at full saturation and zero distance a reclaim pass scores 0.18, so it beats pure idling
// (W_IDLE 0.1) and loses to a waiting build, an active build, and every bootstrap need. Root C
// asks for debt to COMPETE, not to win: a bot dying 23x/day manufactures litter faster than any
// sweeper cleans it, so prevention outranks the backlog (design §9.4). This is that ranking as
// one number instead of as a place in a hand-ordered list.
const W_RECLAIM = 0.18
// Risk (0..1) is a live-condition COST, per the directive's utility signature. It is docked hard from
// "keep exposing yourself to make progress" (build) and lightly from at-or-near-home upkeep; it is
// NOT docked from going home to shelter (that REDUCES risk). This is what makes a naked/exposed bot
// stop building and pull home without any per-path night gate.
const W_RISK_BUILD = 0.5
const W_RISK_MAINT = 0.15
// Hysteresis: a bounded bonus for the candidate that IS the active job, applied ONLY while the caller
// reports recent verified progress (opts.now - opts.lastProgressAt <= window). Small enough that a
// genuinely better activity still wins, big enough to damp thrash between two near-tied candidates.
const PROGRESS_BONUS = 0.15
const PROGRESS_BONUS_WINDOW_MS = 60000
const CRISIS_SCORE = 1000 // a survival guard's sentinel score - it hard-dominates every utility candidate
// #114 ONE_READINESS: the score of a candidate whose precondition says NO (buildReady) or whose
// executor already declined THIS tick. A sentinel, not a weight: it must sit strictly below every
// real candidate (which can go mildly negative under a full risk dock) so an infeasible job can
// never win on arithmetic - but the candidate stays in the list so an all-refused tick still has
// something honest to settle on and name.
const REFUSED_SCORE = -1000

// ---- grave / flee helpers (tiny duplicates of scheduler.js internals; see header) --------
function graveUrgent (g) { return !!g && (g.tier === 'urgent' || g.tier === 'critical') }
function graveReachBand (g, band, urgentBand) {
  if (process.env.GRAVE_URGENT === '0' || urgentBand == null || !graveUrgent(g)) return band
  return Math.max(band, urgentBand)
}
// The best worthwhile, non-dangerous, SALVAGEABLE grave within reach (dist is already
// min(bot,home)). Mirrors scheduler.nearestReachGrave so pickJob and the core agree on "a near
// grave IS the survival move" - INCLUDING #112's two Root-E clauses, which matter more here than
// anywhere: the line that killed the bot on 2026-07-19 was this function's caller printing
// "(core) chose graveSweep: near grave 10b - free gear" over a pocket that had drowned it seven
// minutes earlier. A grave whose salvageVerdict is go:false is not a candidate, and the pick is
// by desire NET OF RISK rather than raw proximity.
function nearestReachGrave (s, band, urgentBand) {
  let best = null; let bs = -Infinity
  for (const g of (Array.isArray(s.graves) ? s.graves : [])) {
    if (!g || g.dangerous || !(g.value > 0)) continue
    if (gravePolicy.graveSalvageBlocked(g)) continue
    if (g.dist == null || g.dist > graveReachBand(g, band, urgentBand)) continue
    const sc = gravePolicy.graveScore(g)
    if (sc > bs) { bs = sc; best = g }
  }
  return best
}
// An acute flee/danger is reflex-owned - a near grave waits until it clears (mirrors scheduler.fleeActive).
function fleeActive (s) {
  return (s.threatDist != null && s.threatDist <= 6) ||
         !!s.inLava || !!s.onFire || !!s.drowning ||
         (s.creeperDist != null && s.creeperDist <= 12)
}
function classRank (cls) { return scheduler.JOB_CLASSES[cls] ? scheduler.JOB_CLASSES[cls].rank : -1 }
const clamp = (x, lo, hi) => x < lo ? lo : (x > hi ? hi : x)
const pct = x => Math.round(clamp(x, 0, 1) * 100) + '%'

// ---- duskProximity ----------------------------------------------------------------------
// PURE 0..1 "how close is nightfall". This is the SEED of the operator's dusk-recall-must-EMERGE
// rule: no per-path night gate, just a rising urgency as the sun goes down. Minecraft timeOfDay:
// 0 dawn, 6000 noon, ~12000 dusk begins, ~13000 night, 18000 midnight, ~23000 back to dawn. Ramps
// from 0 at t<=11000 to 1 at t>=13000, and stays 1 through the night. When timeOfDay is not on the
// snapshot yet (live wiring is the coordinator's flag-flip step), fall back to the boolean isNight
// so the core still degrades to today's night/day distinction. isDusk is an optional explicit hint.
function duskProximity (s) {
  if (typeof s.timeOfDay === 'number') {
    const t = ((s.timeOfDay % 24000) + 24000) % 24000
    if (t >= 13000 && t < 23000) return 1        // full night
    if (t >= 11000 && t < 13000) return clamp((t - 11000) / 2000, 0, 1) // dusk ramp
    return 0                                      // day / morning
  }
  if (s.isDusk) return 0.75
  return s.isNight ? 1 : 0
}

// ---- shelterExposure --------------------------------------------------------------------
// PURE 0.3..1 "how badly does the bot want to be home when the dark comes". A naked bot far from home
// is desperate to shelter; an armored bot at the door barely cares. This is the risk-side multiplier
// on the dusk-recall candidate (kept SEPARATE from riskLevel, which docks the build candidate).
function shelterExposure (s) {
  const naked = s.armorPieces === 0 || !!s.underArmored
  const distHome = s.homeDist != null ? s.homeDist : 0
  return clamp(0.3 + (naked ? 0.35 : 0) + clamp(distHome / 128, 0, 1) * 0.35, 0, 1)
}

// ---- riskLevel --------------------------------------------------------------------------
// PURE 0..1 live danger of STAYING OUT to keep working: naked, night, a (LOS-discounted, already on
// the snapshot) hostile/creeper in the 16b band, distance from a safe home, a nearby recent death
// spot. This is the utility signature's `risk` term; footprint (Phase 2) is a separate stubbed 0.
function riskLevel (s) {
  let r = 0
  if (s.armorPieces === 0 || s.underArmored) r += 0.3
  if (s.isNight && !s.nightStuck) r += 0.3
  if (s.threatDist != null && s.threatDist <= 16) r += 0.4 * (1 - s.threatDist / 16)   // sub-crisis mob (crisis is the guard)
  if (s.creeperDist != null && s.creeperDist <= 16) r += 0.4 * (1 - s.creeperDist / 16)
  if (s.homeDist != null) r += clamp(s.homeDist / 256, 0, 0.2)
  if (s.nearDeathSpot) r += 0.1   // death-spot proximity (optional snapshot hint; grave-policy.deathSpotCost precedent)
  return clamp(r, 0, 1)
}
// Phase 2 hook: cleanup debt for a place/dig-heavy candidate. Stubbed 0 in Phase 1 (the term exists in
// the utility so Phase 2's tidy-home footprint cost slots in without reshaping the math).
function footprintCost (/* candidate, s */) { return 0 }

// Map an active-job NAME to the candidate "bonus key" it competes under, so the hysteresis bonus lands
// on the right utility candidate. Progress/idle build names all fold onto the build(null) candidate.
function bonusKeyFor (activeName) {
  if (activeName === 'maintenancePass') return 'maintenancePass'
  if (activeName === 'homecoming') return 'homecoming'
  if (activeName === 'reclaim') return 'reclaim'
  if (activeName === 'nightShelter') return 'nightShelter'
  if (activeName === 'secureFood') return 'secureFood'
  return activeName ? 'build' : null // build/autobuild/gather/travel/mine/brainJob... all continue as "build"
}

// ---- chooseActivity ---------------------------------------------------------------------
function chooseActivity (snapshot, opts) {
  const s = snapshot || {}
  const o = opts || {}
  const activeCls = o.activeCls || (s.activeJob && s.activeJob.cls) || null
  const preemptFor = cls => activeCls ? (classRank(cls) > classRank(activeCls)) : false
  const mk = (job, cls, reason, score, extra) => Object.assign({ job, cls, reason, score, preempt: preemptFor(cls) }, extra || {})

  // AUDIT 2026-07-29 FIX 4. The refusal map is consulted in PHASE A TOO, not only in Phase B.
  //
  // Before this, a survival verdict returned from Phase A unconditionally - so when its executor
  // could not actually run (the ladder blocked on a condition nothing had changed; secureFood held
  // because foraging out at night is what kills the bot), the tick logged the pick, hit a silent
  // `return` in the dispatcher and did NOTHING. 780 decisions produced 82 executions on the
  // 2026-07-20 tape. Falling through to the next admissible option is strictly better than idling:
  // the crisis is still real, we simply do the best thing we CAN do about it.
  const refusedMap = o.refused instanceof Map ? o.refused : null
  const isRefused = k => !!(refusedMap && refusedMap.has(k))
  const refusalOf = k => (refusedMap && refusedMap.get(k)) || 'declined'

  // ==== PHASE A: SURVIVAL HARD-DOMINANCE GUARD ===========================================
  // A real crisis wins regardless of every utility score. This mirrors scheduler.pickJob steps 1-3
  // EXACTLY (so flag-on is parity on the survival tier), just framed as a guard the way the directive
  // asks: encode survival dominance as a branch, never as a weight that a big build score could beat.
  const need = arbiter.jobSurvivalNeed(s)
  const degraded = scheduler.isDegraded(s)
  // 1. immediate vitals/danger need. A COMPOUND degraded state runs the ladder (R0..R5 re-plan); a
  //    single clean need routes to its producer. `flee` is reflex-owned - the tick no-ops it (as today).
  if (need) {
    const producer = scheduler.needProducer(need.need) || 'recoverHp'
    const job = degraded ? 'recoveryLadder' : producer
    const why = degraded
      ? 'crisis: degraded - running the recovery ladder (' + (need.reason || need.need) + ')'
      : 'crisis: ' + (need.reason || need.need)
    if (!isRefused(job)) return mk(job, 'survival', why, CRISIS_SCORE)
    // THE COMPOUND ROUTE IS NOT THE ONLY ROUTE (found live 2026-07-29 22:15, hp 3.17, food 17):
    //   (core) recoveryLadder REFUSED: last pass made no progress and nothing has changed since
    //   (core) maintenancePass REFUSED: survival first: hp 3.1666 <= 6
    //   (core) reclaim REFUSED: survival first: hp 3.1666 <= 6
    //   (core) build/idle REFUSED: post-death recovery in progress
    // ...for minutes, at three hearts, with a full food bar. Every candidate refused and the bot
    // stood still - because a DEGRADED state routes to the ladder, and when the ladder is refused
    // this clause fell straight through to the utility phase, where `recoverHp` is not a candidate
    // at ALL. The need was 'heal', its producer exists, works, and carries its own cooldown, and
    // nothing could reach it. FIX 4 taught Phase A to see refusals; this is the half it missed -
    // seeing a refusal has to mean trying the next thing that can help, not giving up on the tier.
    // ...but ONLY to a producer that does not have to set out. The ladder is usually refused
    // BECAUSE the world is not survivable to walk in (blocked on 'dawn'), and routing round it to
    // secureFood would send a naked bot foraging into exactly the dark that killed it - the death
    // rungFeasible exists to bar. `outboundBlocked` is that one rule and this asks it, so the
    // fallback can reach recoverHp (heal where you stand) and can never reach an outbound trek.
    // Caught by deathlooptest's LOOP B fixture before it ever ran live.
    // ...and it asked only the ARMOUR/DARK half of that question. It now asks the WHOLE of it
    // (scheduler.outboundAdmissible: the same outboundBlocked, plus the hp abort that used to be
    // reachable only from a ladder rung). MEASURED, and stated because the finding matters more
    // than the change: the hp half is INERT on this path today - arbiter.jobSurvivalNeed returns
    // 'heal' for every state at hp<=6, so `producer` here is recoverHp and never an outbound one.
    // The route was already closed, by a precedence in another module. Asking the one composed
    // rule costs nothing and closes it by construction instead, so a future re-ordering of that
    // precedence cannot silently re-open a door onto a trek at two hearts.
    const outbound = scheduler.producerIsOutbound(producer) && !scheduler.outboundAdmissible(s).ok
    if (degraded && producer !== job && !outbound && !isRefused(producer)) {
      return mk(producer, 'survival', why + ' [the ladder is refused - running the need\'s own producer instead]', CRISIS_SCORE)
    }
  }
  // 2. a near worthwhile grave is a first-class survival move (free gear at arm's reach), unless an
  //    acute flee is owed. Above the degraded-signature and everything discretionary (I3, as pickJob).
  const GRAVE_NEAR = Number(process.env.GRAVE_NEAR || 16)
  const GRAVE_URGENT_DIST = Number(process.env.GRAVE_URGENT_DIST || 96)
  if (!fleeActive(s) && !isRefused('graveSweep')) {
    const g = nearestReachGrave(s, GRAVE_NEAR, GRAVE_URGENT_DIST)
    if (g) return mk('graveSweep', 'survival', 'near grave ' + Math.round(g.dist) + 'b' + (graveUrgent(g) ? ' (' + g.tier + ' - despawning)' : '') + ' - free gear', CRISIS_SCORE)
  }
  // 3. the compound-degraded signature with no single clean need (e.g. naked with a far-but-in-band
  //    grave) -> the ladder.
  if (degraded && !isRefused('recoveryLadder')) return mk('recoveryLadder', 'survival', 'crisis: degraded - running the recovery ladder', CRISIS_SCORE)
  // Every crisis response we would have chosen has been refused by its own executor. Say so once,
  // loudly, and carry on into the utility phase - the bot must still do the best thing it can.
  const crisisRefused = !!((need || degraded) && (isRefused('recoveryLadder') || isRefused('secureFood') || isRefused('recoverHp') || isRefused('nightShelter')))

  // ==== PHASE B: UTILITY CHOICE among the calm-window activities ==========================
  // No crisis is owed. Now it is a genuine trade-off: shelter before dark, bootstrap missing infra,
  // or press the build. Score each live candidate, damp thrash with the active-job progress bonus,
  // pick the max. This is the layer that replaces the fixed FOOD/FARM/bootstrap ORDER with reasoning.
  const cands = []

  // #114 ONE_READINESS: the build's precondition, evaluated ONCE per tick by the SAME function the
  // executor enforces (scheduler.buildReady). This is the chooser's feasibility term for the build
  // candidate AND the source of its reason string - the old hardcoded "infra is in order" label was
  // a claim nothing had checked, and it disagreed with the executor for 90s at a time.
  const br = scheduler.buildReady(s)

  // (B1) NIGHT SHELTER / go-home - EMERGES from dusk-proximity x exposure (never a per-path gate).
  //      Far + naked + dusk => this dominates; home + armored + noon => it never even appears.
  const dusk = duskProximity(s)
  if (dusk > 0) {
    const exposure = shelterExposure(s)
    const score = W_SURVIVE * dusk * exposure - footprintCost('nightShelter', s)
    cands.push({ job: 'nightShelter', cls: 'survival', key: 'nightShelter', order: 0, score,
      reason: 'dusk approaching (' + pct(dusk) + ') + exposed (' + pct(exposure) + ') - heading home to shelter before dark' })
  }

  // (B2) MAINTENANCE PASS - bootstrap the missing survival infra (or top up buffers) in this calm
  //      window. REUSES scheduler.bootstrapNeed's verdict (which already encodes the food-reserve >
  //      armor > base priority the operator tuned) + the iron-keystone hold, so the WHAT is unchanged;
  //      the core only changes WHEN (it can now lose to a more urgent shelter, or to an active build).
  // The build's OWN score (pre-feasibility) is computed first so an infeasible build can hand its
  // motivation to the work that would make it feasible (need-inheritance, below).
  const activeProgress = activeCls === 'progress'
  const base = activeProgress ? W_CONTINUE : ((s.persistedBuild || s.brainJobPending) ? W_RESUME : W_IDLE)
  const buildCls = (activeProgress || s.persistedBuild || s.brainJobPending) ? 'progress' : 'idle'
  const buildWant = base - W_RISK_BUILD * riskLevel(s)

  let bn = scheduler.bootstrapNeed(s)
  let keystone = false
  if (!bn && s.persistedBuild && scheduler.ironKeystoneActive(s)) { bn = 'armor'; keystone = true }
  const upkeep = !bn && !!s.maintainNeeded
  if (bn || upkeep) {
    // urgency by kind: armor is the biggest survivability multiplier; food-reserve the enabler; base
    // spawn-proofing next; a plain buffer top-up lowest.
    // #117: 'spawn' and 'shelter' rank HERE the way they rank in bootstrapNeed - the two readiness
    // models must not drift (that is Root G, and this file exists because they did). The anchor is
    // top: it does not reduce the chance of a death, it reduces the price of every death that still
    // happens, which on the 23-death tape was a 380-490b naked walk home.
    const urgency = bn === 'spawn' ? 0.95 : bn === 'armor' ? 0.9 : bn === 'food' ? 0.7 : bn === 'shelter' ? 0.6 : bn === 'base' ? 0.5 : 0.4
    // feasibility: armor needs no home (armorup mines its own iron); the home-infra normally wants a
    // reachable home, because that dock exists for ONE reason - to yield the body to the build rather
    // than livelock on an unreachable bank (see the original comment). #114: it may not yield to a
    // build that is ITSELF refusing. On 2026-07-19 16:04 (home 140b) this filter vetoed the food work
    // while the executor vetoed the build on that very food need - a three-way standoff in which each
    // side blocked the other's remedy and the body did nothing for 90s at a stretch. The dock is now
    // CONDITIONED on the build actually being an available alternative: no alternative, no dock.
    // #117: 'spawn' joins 'armor' in needing NO home - ensureSpawnBed's whole point is that a
    // homeless bot can lay an anchor on open ground. Docking it on an unreachable bank would
    // re-create, for the one need that fixes homelessness, the livelock the dock exists to prevent.
    const feas = (bn === 'armor' || bn === 'spawn') ? 1 : ((s.homeReachable || !br.ok) ? 1 : 0)
    const yielded = !feas
    let score = W_SECURE * urgency * feas - W_RISK_MAINT * riskLevel(s) - footprintCost('maintenancePass', s)
    // NEED-INHERITANCE (§3.7): when the build is blocked ON THIS WORK, the work inherits the build's
    // motivation - the tick picks the enabling job INSTEAD of the build, this tick, rather than
    // selecting a job that will refuse and idling to the watchdog.
    const inherits = !br.ok && br.need != null && br.need === bn
    if (inherits && score < buildWant) score = buildWant
    const label = bn ? ('bootstrap ' + bn + (keystone ? ' (iron keystone)' : '')) : 'topping up low buffers'
    cands.push({ job: 'maintenancePass', cls: 'maintain', key: 'maintenancePass', order: 1, score, bootstrap: bn || undefined,
      reason: label + (yielded ? ' [home unreachable - deferring]' : '') + (inherits ? ' [the build is waiting on exactly this]' : '') + ' - establishing survival infra before the build' })
  }

  // (B1b) HOMECOMING - cross back to base after being DISPLACED (AUDIT 2026-07-29 FIX 2).
  //
  // This walk used to be step 1 of a hardcoded post-respawn sequence that ran unconditionally, and
  // it was the single largest killer on the 2026-07-20 tape: 458-489 blocks, naked, in the dark,
  // eight times in seven minutes. As a hardcoded step it could not be weighed against anything -
  // not the hour, not the armour, not the eight corpses already on that route.
  //
  // As a CANDIDATE it is weighed like everything else, and its feasibility is the same
  // journeyAdmissible every recovery rung uses. When the crossing is not survivable it scores
  // REFUSED and the bot shelters/eats/gears instead - and it comes back on its own the moment the
  // blocking condition clears, which is what makes the stand-down safe rather than a strand.
  //
  // It exists only when the bot is DISPLACED: after a death (the recovery latch), or idle with no
  // build to be far away FOR. A bot that is 460b out because its build site is there is not
  // displaced, and must never be walked home off its own job.
  const homeDist = s.homeDist
  const displacedByDeath = !!s.postDeathRecovery
  const idleFarFromHome = !activeProgress && !s.persistedBuild && !s.brainJobPending
  if (homeDist != null && homeDist > Number(process.env.RECOVER_HOME_DIST || 64) && (displacedByDeath || idleFarFromHome)) {
    const adm = scheduler.journeyAdmissible(s, homeDist)
    const away = clamp(homeDist / 256, 0, 1)
    // Being home is worth more when the spawn anchor is broken (home is where it gets fixed) and
    // more the further out we are - a 460b displacement is a different problem from a 70b one.
    const urgency = clamp(0.4 + 0.35 * away + ((s.spawnAnchored === false || s.spawnSuspect === true) ? 0.2 : 0), 0, 1)
    cands.push({
      job: 'homecoming',
      cls: 'survival',
      key: 'homecoming',
      order: 0,
      score: adm.ok ? (W_SURVIVE * urgency - W_RISK_MAINT * riskLevel(s)) : REFUSED_SCORE,
      reason: adm.ok
        ? 'displaced ' + Math.round(homeDist) + 'b from base' + (displacedByDeath ? ' by a death' : '') + ' - crossing back while it is safe to'
        : 'not crossing the ' + Math.round(homeDist) + 'b home: ' + adm.why + ' (waiting on ' + adm.blockedOn + ')'
    })
  }

  // (B2b) RECLAIM - pay down what the bot owes the world (#119 COMMITMENT_LEDGER, design §3.3).
  //      Root C's whole point: reclamation used to be a side effect of IDLENESS, so an always-busy
  //      bot reclaimed nothing and the registry grew 199 -> 272 in one session while sweeps ran.
  //      Making it a CANDIDATE is the structural fix - debt now competes for the body on the same
  //      utility terms as everything else, and therefore gets it exactly when it deserves it.
  //
  //      The scoring is deliberately weak, and that is the design, not timidity:
  //        value      saturates (a 400-block backlog is not 400x more urgent than 4; it is just
  //                   "a lot", and the difference between them is a day of sweeping either way)
  //        proximity  is the feasibility term - a debt at arm's reach is nearly free to pay, one
  //                   200b away costs a trip and had better be worth it
  //      So: three dirt blocks 200b away never win the body; a 20-beef furnace 40b away can beat
  //      resuming a build. That is the example §3.3 gives, and it falls out of the arithmetic
  //      rather than out of a threshold anyone tuned.
  //
  //      It sits in the W_SECURE band but at a fraction of a real bootstrap need, so it loses to
  //      every genuine need and to an actively-progressing build, and beats idling. It is docked
  //      the same live risk as other maintain work - a naked bot at dusk does not tidy.
  const debt = s.debt || null
  if (debt && debt.best && debt.value > 0) {
    const value = clamp(debt.value / 120, 0, 1)          // saturating: 120 points of debt is "a lot"
    const d = debt.best.dist != null ? debt.best.dist : 256
    const proximity = clamp(1 - d / 128, 0, 1)           // feasibility: 0 beyond 128b, 1 underfoot
    const score = W_RECLAIM * value * proximity - W_RISK_MAINT * riskLevel(s)
    cands.push({ job: 'reclaim', cls: 'maintain', key: 'reclaim', order: 3, score,
      reason: 'paying down ' + debt.n + ' outstanding commitment(s) - nearest is ' + debt.best.n + ' ' +
        debt.best.kind + ' cell(s) ' + Math.round(d) + 'b away' })
  }

  // (B2c) HOUSEKEEPING - the IDLE-tier proposals from the reflex registry (PLAN-one-runner S5).
  //      autoCollect / autoCook / scaffoldSweep / autoTorch used to be 3s-45s timers that moved
  //      the body whenever a handful of latches happened to read false. As candidates they are
  //      weighed like everything else, on the same benefit x urgency - risk signature, with the
  //      SAME risk this function computed once - so a naked bot at dusk does not stop to pick up
  //      a stick, and an idle one in daylight does exactly what a player would.
  //      Their weights sit below W_RESUME (a waiting build wins) and above W_IDLE (beats idling).
  for (const c of reflexes.proposalCandidates(s, { risk: riskLevel(s), riskWeight: W_RISK_MAINT })) cands.push(c)

  // (B3) BUILD / IDLE proceeds (null job). The baseline progress candidate, DOCKED live risk so an
  //      exposed bot never "just keeps building" - that dock is what pulls it home instead. When a
  //      progress job is already running it carries the single-goal-discipline continue weight.
  //      #114: gated by buildReady - the SAME predicate the executor enforces. An unready build sinks
  //      to REFUSED_SCORE so it can never out-score real work, but the candidate STAYS in the list so
  //      an all-refused tick still settles on an honest, greppable pick instead of spinning.
  cands.push({ job: null, cls: buildCls, key: 'build', order: 2, score: br.ok ? buildWant : REFUSED_SCORE,
    reason: !br.ok ? ('build not ready: ' + br.why + (br.need ? ' (needs ' + br.need + ')' : ''))
      : (activeProgress ? 'continuing the active build (single-goal, safe window)'
        : (s.persistedBuild ? 'resuming the saved build - ' + br.why : (s.brainJobPending ? 'starting the queued brain job' : 'idle - nothing pressing'))) })

  // REFUSAL FEEDBACK (§3.7): a candidate whose EXECUTOR declined earlier in THIS tick is scored
  // REFUSED_SCORE with its own stated reason, so the re-selection picks something else immediately
  // instead of the tick idling to the 90s watchdog. `refused` is caller-owned and MONOTONE within a
  // tick (a key is added, never removed), which is what bounds the re-selection: at most one pass per
  // candidate. Condition-scoped, not time-scoped - the map is rebuilt from scratch each tick, so the
  // moment the refusal's condition stops holding the candidate is live again ([[no-blanket-time-holds]]).
  const refused = o.refused instanceof Map ? o.refused : null
  if (refused && refused.size) {
    for (const c of cands) {
      if (!refused.has(c.key)) continue
      c.score = REFUSED_SCORE
      c.reason = 'refused this tick: ' + refused.get(c.key)
    }
  }

  // ---- HYSTERESIS: bonus the active job WHILE it is making verified progress (no clock read) -------
  // progressing is a comparison of two CALLER-provided timestamps - the pure fn holds no clock. This
  // is the anti-thrash damper AND the operator's "hysteresis = progress-bonus, never a timer" rule:
  // the instant progress stalls (lastProgressAt goes stale) the bonus evaporates and the core is free
  // to switch - it can never latch onto a stuck job the way a fixed cooldown would.
  const progressing = o.lastProgressAt != null && o.now != null && (o.now - o.lastProgressAt) <= PROGRESS_BONUS_WINDOW_MS
  const activeKey = bonusKeyFor(o.activeJob)
  for (const c of cands) c.effective = c.score + (progressing && c.key === activeKey ? PROGRESS_BONUS : 0)

  // deterministic pick: highest effective utility; ties broken by tier (survival > maintain >
  // progress > idle) then by a stable candidate order, so identical inputs ALWAYS give one answer.
  cands.sort((a, b) => (b.effective - a.effective) || (classRank(b.cls) - classRank(a.cls)) || (a.order - b.order))
  const best = cands[0]
  const bonused = progressing && best.key === activeKey
  // STANDOFF (§3.7): every live candidate said no. The tick settles on the best-available one
  // DELIBERATELY and says so - a greppable invariant violation naming both sides, instead of the
  // silent "chose build/idle" x6 that preceded 90s of standing still. `standoff` is data on the
  // verdict, so the caller can stop re-selecting on a condition rather than on a timer.
  const standoff = best.score <= REFUSED_SCORE
  const extra = Object.assign({}, best.bootstrap ? { bootstrap: best.bootstrap } : null, standoff ? { standoff: true, refusals: cands.filter(c => c.score <= REFUSED_SCORE).map(c => c.key + ': ' + c.reason) } : null,
    crisisRefused ? { crisisRefused: true } : null)
  const reason = (standoff ? 'standoff - every candidate refused; settling on ' + (best.job || 'build/idle') + ': ' : '') +
    // FIX 4: name it when a real crisis is live but its own producer said it cannot run. This is the
    // single most important line in the log when the bot is dying and looks idle.
    (crisisRefused ? 'CRISIS UNANSWERED (' + [...(refusedMap ? refusedMap.entries() : [])].map(([k, v]) => k + ': ' + v).join('; ') + ') - doing what i can instead: ' : '') +
    best.reason + (bonused ? ' [holding - making progress]' : '')
  return mk(best.job, best.cls, reason, best.effective, Object.keys(extra).length ? extra : null)
}

// ---- selectWithRefusals ------------------------------------------------------------------
// #114 ONE_READINESS - REFUSAL FEEDS BACK IN-TICK (design §3.7). PURE (no clock, no bot, no I/O):
// the caller supplies `refusalOf(verdict, snapshot) -> { key, why } | null`, a CHEAP precondition
// probe for the chosen candidate. A refusal re-enters selection IMMEDIATELY with that candidate
// scored out, so the tick picks the enabling work instead of committing to a job its own executor
// will decline and then standing still until the 90s watchdog (the 2026-07-19 16:02-16:06 defect).
//
// BOUNDED BY CONDITION, NEVER BY A TIMER ([[no-blanket-time-holds]]): `refused` only GROWS, and a
// key already present is never re-added, so each candidate refuses at most ONCE and the loop runs
// at most MAX_RESELECT times before settling on the honest best-available pick (which chooseActivity
// labels `standoff:` and names the refusals of). The map is per-CALL - it is discarded when the tick
// ends, so nothing is held past the condition that caused it; the next tick starts clean.
const MAX_RESELECT = 4 // one pass per candidate key: nightShelter | maintenancePass | build (+ slack)
function selectWithRefusals (snapshot, opts, refusalOf, onRefuse) {
  const o = opts || {}
  const refused = new Map()
  let c = chooseActivity(snapshot, Object.assign({}, o, { refused }))
  for (let i = 0; i < MAX_RESELECT; i++) {
    let rf = null
    try { rf = refusalOf ? refusalOf(c, snapshot) : null } catch { rf = null }
    if (!rf || !rf.key || refused.has(rf.key)) break // no refusal, or this candidate already had its one turn
    refused.set(rf.key, rf.why || 'declined')
    if (onRefuse) { try { onRefuse(c, rf) } catch {} }
    c = chooseActivity(snapshot, Object.assign({}, o, { refused }))
  }
  return c
}

module.exports = {
  chooseActivity,
  selectWithRefusals,
  MAX_RESELECT,
  // exported for offline testing / reuse
  duskProximity,
  riskLevel,
  nearestReachGrave,
  fleeActive
}
