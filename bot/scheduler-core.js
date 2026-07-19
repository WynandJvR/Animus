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
// chooseActivity(snapshot, opts) -> { job, cls, reason, score, preempt, bootstrap }
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

// ---- tuning constants (the utility weights) ---------------------------------------------
// Benefit tiers encode the operator's goal stack: survive > sustain > secure > build. They are
// MULTIPLIED by a live urgency and feasibility and DOCKED a live risk, so a high-tier candidate
// with no urgency (e.g. shelter at noon) still loses to a lower-tier one that is actually due.
const W_SURVIVE = 1.0   // dusk-recall / go-home-to-shelter: protecting the body itself
const W_SECURE = 0.6    // maintenancePass: bootstrap missing infra (armor/food-reserve/lit base) + upkeep
const W_CONTINUE = 0.65 // build(null) baseline while a progress job is ALREADY running (single-goal discipline)
const W_RESUME = 0.2    // build(null) baseline when a saved build is waiting to resume (below any real bootstrap)
const W_IDLE = 0.1      // build(null) baseline when there is nothing to build (pure idle)
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

// ---- grave / flee helpers (tiny duplicates of scheduler.js internals; see header) --------
function graveUrgent (g) { return !!g && (g.tier === 'urgent' || g.tier === 'critical') }
function graveReachBand (g, band, urgentBand) {
  if (process.env.GRAVE_URGENT === '0' || urgentBand == null || !graveUrgent(g)) return band
  return Math.max(band, urgentBand)
}
// The nearest worthwhile, non-dangerous grave within reach (dist is already min(bot,home)). Mirrors
// scheduler.nearestReachGrave so pickJob and the core agree on "a near grave IS the survival move".
function nearestReachGrave (s, band, urgentBand) {
  let best = null
  for (const g of (Array.isArray(s.graves) ? s.graves : [])) {
    if (!g || g.dangerous || !(g.value > 0)) continue
    if (g.dist == null || g.dist > graveReachBand(g, band, urgentBand)) continue
    if (!best || g.dist < best.dist) best = g
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

  // ==== PHASE A: SURVIVAL HARD-DOMINANCE GUARD ===========================================
  // A real crisis wins regardless of every utility score. This mirrors scheduler.pickJob steps 1-3
  // EXACTLY (so flag-on is parity on the survival tier), just framed as a guard the way the directive
  // asks: encode survival dominance as a branch, never as a weight that a big build score could beat.
  const need = arbiter.jobSurvivalNeed(s)
  const degraded = scheduler.isDegraded(s)
  // 1. immediate vitals/danger need. A COMPOUND degraded state runs the ladder (R0..R5 re-plan); a
  //    single clean need routes to its producer. `flee` is reflex-owned - the tick no-ops it (as today).
  if (need) {
    if (degraded) return mk('recoveryLadder', 'survival', 'crisis: degraded - running the recovery ladder (' + (need.reason || need.need) + ')', CRISIS_SCORE)
    const job = scheduler.needProducer(need.need) || 'recoverHp'
    return mk(job, 'survival', 'crisis: ' + (need.reason || need.need), CRISIS_SCORE)
  }
  // 2. a near worthwhile grave is a first-class survival move (free gear at arm's reach), unless an
  //    acute flee is owed. Above the degraded-signature and everything discretionary (I3, as pickJob).
  const GRAVE_NEAR = Number(process.env.GRAVE_NEAR || 16)
  const GRAVE_URGENT_DIST = Number(process.env.GRAVE_URGENT_DIST || 96)
  if (!fleeActive(s)) {
    const g = nearestReachGrave(s, GRAVE_NEAR, GRAVE_URGENT_DIST)
    if (g) return mk('graveSweep', 'survival', 'near grave ' + Math.round(g.dist) + 'b' + (graveUrgent(g) ? ' (' + g.tier + ' - despawning)' : '') + ' - free gear', CRISIS_SCORE)
  }
  // 3. the compound-degraded signature with no single clean need (e.g. naked with a far-but-in-band
  //    grave) -> the ladder.
  if (degraded) return mk('recoveryLadder', 'survival', 'crisis: degraded - running the recovery ladder', CRISIS_SCORE)

  // ==== PHASE B: UTILITY CHOICE among the calm-window activities ==========================
  // No crisis is owed. Now it is a genuine trade-off: shelter before dark, bootstrap missing infra,
  // or press the build. Score each live candidate, damp thrash with the active-job progress bonus,
  // pick the max. This is the layer that replaces the fixed FOOD/FARM/bootstrap ORDER with reasoning.
  const cands = []

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
  let bn = scheduler.bootstrapNeed(s)
  let keystone = false
  if (!bn && s.persistedBuild && scheduler.ironKeystoneActive(s)) { bn = 'armor'; keystone = true }
  const upkeep = !bn && !!s.maintainNeeded
  if (bn || upkeep) {
    // urgency by kind: armor is the biggest survivability multiplier; food-reserve the enabler; base
    // spawn-proofing next; a plain buffer top-up lowest.
    const urgency = bn === 'armor' ? 0.9 : bn === 'food' ? 0.7 : bn === 'base' ? 0.5 : 0.4
    // feasibility: armor needs no home (armorup mines its own iron), the home-infra needs a reachable
    // home (else the go-home/recovery flow owns the bot - never block the build on an unreachable bank).
    const feas = bn === 'armor' ? 1 : (s.homeReachable ? 1 : 0)
    const score = W_SECURE * urgency * feas - W_RISK_MAINT * riskLevel(s) - footprintCost('maintenancePass', s)
    const label = bn ? ('bootstrap ' + bn + (keystone ? ' (iron keystone)' : '')) : 'topping up low buffers'
    cands.push({ job: 'maintenancePass', cls: 'maintain', key: 'maintenancePass', order: 1, score, bootstrap: bn || undefined,
      reason: label + (feas ? '' : ' [home unreachable - deferring]') + ' - establishing survival infra before the build' })
  }

  // (B3) BUILD / IDLE proceeds (null job). The baseline progress candidate, DOCKED live risk so an
  //      exposed bot never "just keeps building" - that dock is what pulls it home instead. When a
  //      progress job is already running it carries the single-goal-discipline continue weight.
  const activeProgress = activeCls === 'progress'
  const base = activeProgress ? W_CONTINUE : ((s.persistedBuild || s.brainJobPending) ? W_RESUME : W_IDLE)
  const buildCls = (activeProgress || s.persistedBuild || s.brainJobPending) ? 'progress' : 'idle'
  const buildScore = base - W_RISK_BUILD * riskLevel(s)
  cands.push({ job: null, cls: buildCls, key: 'build', order: 2, score: buildScore,
    reason: activeProgress ? 'continuing the active build (single-goal, safe window)'
      : (s.persistedBuild ? 'resuming the saved build - infra is in order' : (s.brainJobPending ? 'starting the queued brain job' : 'idle - nothing pressing')) })

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
  return mk(best.job, best.cls, best.reason + (bonused ? ' [holding - making progress]' : ''), best.effective, best.bootstrap ? { bootstrap: best.bootstrap } : null)
}

module.exports = {
  chooseActivity,
  // exported for offline testing / reuse
  duskProximity,
  shelterExposure,
  riskLevel,
  footprintCost,
  nearestReachGrave,
  fleeActive
}
