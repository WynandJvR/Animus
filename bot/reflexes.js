'use strict'
// ==== THE REFLEX REGISTRY - proposals, not actors =========================================
// ONE table that answers, for anything that can MOVE OR DIG the body: "what tier does it own
// the body at, when may it run, who executes it, and what does it declare while it waits?"
//
// WHY IT EXISTS (design-docs/PLAN-one-runner.md; AUDIT-2026-07-29 defect D5). index.js ran 28
// setInterval timers, roughly half of which could move the body, and they coordinated by each
// checking the others' latches. Measured distinct latch reads in index.js alone:
//
//   25  commands.isBusy()             12  commands.isEscaping()        7  provision.isMaintaining()
//   21  provision.isResting()         10  arbiter.maneuverActive()     7  navigate.isUnsticking()
//   19  provision.isSecuringFood()     9  navigate.isRecovering()      5  provision.isNight()
//
// That is O(n^2) coupling: every new body-moving behaviour had to be added to every existing
// one's guard list, and a MISSING guard was invisible until it killed the bot. It is also where
// decisions went to die - a silent `return` inside a timer is a second, unlogged decision-maker,
// and it is how 780 job decisions produced 82 executions on the 2026-07-20 tape.
//
// The two live failures this shape exists to make unrepresentable:
//   (a) the decision/dispatch gap - the chooser picks, a guard stack silently unmakes the pick;
//   (b) 2026-07-29 19:20-19:24 - the shelter correctly sealed a pit and sat still until dawn;
//       the forward-progress watchdog correctly saw no progress; NOBODY owned the arbitration,
//       so a correct hold looked exactly like a hang, it dug the bot out into the dark and a
//       creeper killed it. `holds` (below) is the structural answer to that one.
//
// THE ONE RULE THAT REPLACES THE GUARD STACKS. A proposal declares the TIER at which it owns
// the body; the runner asks ONE question - `mayTakeBody(proposal.tier, whoOwnsItNow)` - and a
// refusal is LOGGED with its blocker instead of being a silent return. Adding a behaviour is
// adding a row here, not editing every other behaviour's guard list.
//
// WHAT IS DELIBERATELY NOT HERE: the INSTANT class. Auto-eat, auto-equip-carried-armour and the
// gaze reflex never move the body, so they cannot conflict with anything and cannot be starved
// by an owner - they keep their own timers in index.js. Collapsing them would be churn for
// nothing. Everything that MOVES or DIGS is a proposal.
//
// PURITY CONTRACT (bot/reflexestest.js enforces all of it):
//   * top-level requires: arbiter.js ONLY (a leaf: zero requires of its own). Executors require
//     provision/commands LAZILY inside run(), so scheduler-core.js can require this file for the
//     pure half without dragging the world in, and an offline test can enumerate it.
//   * `when` and `refuse` are PURE over the tick snapshot + the runner's own state. No clock of
//     their own, no bot handle, no world reads.
//   * NO PROPOSAL READS ANOTHER'S LATCH. isBusy/isResting/isSecuringFood/isRecoveringDegraded/
//     maneuverActive et al. appear NOWHERE in this file. Arbitration is the runner's job, once,
//     centrally - which is the entire point.

const arbiter = require('./arbiter.js') // the ONE priority vocabulary (PRIORITY/priName). Zero requires of its own.
const provRecovery = () => require('./provision-recovery.js') // LAZY: provision-recovery.js top-requires this module, so an eager import here would be a real cycle
const provFood = () => require('./provision-food.js') // LAZY: provision-food.js top-requires this module, so an eager import here would be a real cycle
const provMaintain = () => require('./provision-maintain.js') // LAZY: provision-maintain.js top-requires this module, so an eager import here would be a real cycle

// ---- tiers ------------------------------------------------------------------------------
// The tier vocabulary IS arbiter.PRIORITY - re-exported, never copied, so there is no second
// scale to drift (PLAN §3.1). A tier answers "who owns the body", which is the arbiter's
// question, and it is the same scale a maneuver span is opened at.
const TIERS = arbiter.PRIORITY // { IDLE:0, PROGRESS:1, PRESERVE:2, SURVIVE:3 }
function tierRank (tier) { return Object.prototype.hasOwnProperty.call(TIERS, tier) ? TIERS[tier] : -1 }

// The scheduler's JOB CLASS for a tier. Two scales already existed and they disagree in the
// middle on purpose: arbiter.PRESERVE outranks PROGRESS (a retreat beats a walk), while
// scheduler.JOB_CLASSES ranks `progress` above `maintain` (a build beats chores). They are
// answering different questions - who may drive the body RIGHT NOW vs which JOB deserves it -
// so this is the ONE place the two are related, and nothing else maps between them.
const CLASS_OF_TIER = { SURVIVE: 'survival', PRESERVE: 'maintain', PROGRESS: 'progress', IDLE: 'idle' }
function classOf (tier) { return CLASS_OF_TIER[tier] || 'idle' }

// ---- body ownership ---------------------------------------------------------------------
// WHO can be holding the body, and at what tier. Data only: the runner owns the predicates
// (they need bot/commands/navigate handles) and consults them in THIS order, top down. That
// ordering plus `mayTakeBody` is the whole of what ~120 scattered latch checks used to say.
//
// A busy build sits at PROGRESS, so a SURVIVE proposal out-ranks it - which is correct and is
// exactly what AUDIT FIX 4 restored (a nightShelter that could never fire because the reflex
// checked isBusy()). Two flags qualify the plain ranking, and both are pre-existing rules given
// one definition instead of twelve:
//   hard        never yielded. An escape, a navigation recovery and the recovery ladder drive
//               the body themselves; every reflex in index.js already said "the ladder owns the
//               body between rungs" in its own guard list - the tick was the one place that did
//               not, so a shelter could start on top of a ladder rung that was sheltering.
//   crisisOnly  yielded only to a CRISIS-grade need. This is single-goal discipline: a build is
//               not interrupted to top up a buffer, and a bot already holed up for the night is
//               not pulled back out except by something strictly worse (#113).
//   owns        the PROPOSAL whose executor sets this latch. A proposal may never take the body
//               from itself, at any tier, crisis or not - it is already doing the thing. Found
//               live within 90 seconds of the runner going in: a build's own gather loop had
//               called secureFood (so the latch was set), food hit 9, and the crisis-grade rule
//               happily let secureFood preempt secureFood. The second one returned "not fed -
//               blocked on busy" instantly and armed the no-op latch, which would then have
//               suppressed the REAL food response. That is audit LOOP C in miniature.
//
// ==== A CLAIM IS A LEASE, RENEWED BY EVIDENCE (2026-08-25, structural review D2/§3.2) =======
// This table used to be a NAME TABLE and nothing more: the runner polled nine unrelated booleans
// and looked the winner's label up here. Every one of those booleans is raised before an await and
// lowered in a `finally` - which is sufficient only while the awaited work RESOLVES. The repo has
// now written that same sentence four times, for holds, for the dispatch slot, for the activity
// label and for commands' own build latches. The body-owner latches were the last exclusive claim
// with neither expiry nor heartbeat, and they are the OLDEST and the most powerful: a `hard` row
// refuses every proposal at every tier, crisis included.
//
// 2026-08-03 16:54:51. The recovery ladder's rung deadline ABANDONED a secureFood promise and
// advanced to the next rung. `_securingFood` was never lowered, because the abandoned promise
// never reached its `finally` and never will. For the next 3h15m - to process death at 20:10 -
// the foodRun row above answered every question about the body on behalf of a job that had not
// existed since lunchtime:
//   328 ownership refusals citing it ("a food run owns the body" x321, "a food run IS this job" x44)
//   110 `held (busy building+securing food)` lines - TWO owners of one body, at once
//   ladder rung R4 instantly `blockedOn:'busy'` against its own dead sibling's latch
// Not one of those lines was wrong about the latch. The latch was wrong about the world.
//
// So the table becomes the REGISTRY (below): the runner reports which latches it OBSERVES raised,
// a claim is opened for each, and a claim is only alive while EVIDENCE says the work behind it is
// moving - the item-1 work ledger, the same world-delta record the watchdog judges a job by. Two
// fields make the difference, and both already exist in this file's own vocabulary:
//   engine    the "latch" is engine state (a pathfinder goal, a dig target), not a promise's
//             boolean. mineflayer clears these itself, so there is nothing to expire and revoking
//             one means yanking the controls - the rescue path (review item 5), not this one.
//             Same distinction index.js's TICK_GATES already draws with its 'engine-state' owner.
//   owns      doubles as the job->claim map: it is how an advance is credited to the claim that
//             produced it instead of to whichever claim happens to sit on top of it.
const BODY_OWNERS = [
  { key: 'escape', tier: 'SURVIVE', hard: true, label: 'an escape' },
  { key: 'navRecovery', tier: 'SURVIVE', hard: true, label: 'a navigation recovery' },
  { key: 'ladder', tier: 'SURVIVE', hard: true, owns: 'recoveryLadder', label: 'the recovery ladder' },
  { key: 'foodRun', tier: 'SURVIVE', crisisOnly: true, owns: 'secureFood', label: 'a food run' },
  { key: 'shelter', tier: 'SURVIVE', crisisOnly: true, owns: 'nightShelter', label: 'the night shelter' },
  { key: 'maintain', tier: 'PROGRESS', owns: 'maintenancePass', label: 'a maintenance pass' },
  // `owns: 'build'` since review item 7. The `job` latch (commands.isBusy) is raised by every
  // commands-level activity, but exactly ONE of them is a proposal the chooser dispatches - the
  // build - and this is the line that says so. Two things follow from it, and item 2 named both
  // as the open ones: the build can no longer preempt itself, and an advance produced while the
  // build holds the dispatch slot is CREDITED to this claim instead of ageing it. That closes
  // item 2's watch note verbatim - "the `job` claim's 300s window can revoke a genuinely-running
  // autobuild's `building` latch if a dispatched job is the driver" - because with the build IN
  // the slot it IS the driver, and drivingClaim resolves it here.
  { key: 'job', tier: 'PROGRESS', crisisOnly: true, owns: 'build', label: 'a job' },
  { key: 'walk', tier: 'PROGRESS', engine: true, label: 'a walk already in progress' },
  { key: 'dig', tier: 'PROGRESS', engine: true, label: 'a dig in progress' } // aborting a dig resets its break progress - never for housekeeping
]
const ownerByKey = new Map(BODY_OWNERS.map(o => [o.key, o]))
function ownerInfo (key) { return ownerByKey.get(key) || null }
// The job->claim direction of `owns`. The dispatch slot names the job the chooser put on the body;
// this says which claim that job raises, so an advance can be credited to the right lease.
function claimOfJob (jobKey) {
  if (!jobKey) return null
  for (const o of BODY_OWNERS) if (o.owns === jobKey) return o.key
  return null
}

// THE ordering rule, and the whole of what ~120 scattered latch checks used to say.
// Returns null when the proposal may take the body, else the REASON it may not - because a
// refusal that does not name its blocker is the silent `return` this work exists to delete.
//
// Equal tiers do not preempt each other by default: two SURVIVE claimants alternating is the
// audit's LOOP C (net displacement ~0 while hp went 8 -> 5 -> 2 -> dead), and one of them is
// usually this very proposal, already running.
function bodyRefusal (tier, ownerKey, opts) {
  if (!ownerKey) return null
  const o = ownerInfo(ownerKey)
  if (!o) return null
  // NOTHING preempts itself. Checked before every other rule, including the crisis override:
  // "the crisis is real" is never a reason to start a second copy of the response to it.
  if (opts && opts.name && o.owns && o.owns === opts.name) return o.label + ' IS this job - it is already running'
  if (o.hard) return o.label + ' owns the body'
  const rank = tierRank(tier)
  const orank = tierRank(o.tier)
  if (rank > orank && !o.crisisOnly) return null
  if (o.crisisOnly && rank >= orank && rank === TIERS.SURVIVE) {
    return (opts && opts.crisis) ? null : 'body busy (' + o.label + ') and this is not crisis-grade - single-goal discipline'
  }
  if (rank > orank) return null
  return o.label + ' owns the body'
}
function mayTakeBody (tier, ownerKey, opts) { return bodyRefusal(tier, ownerKey, opts) == null }

// ---- declared holds ---------------------------------------------------------------------
// A hold is a proposal DELIBERATELY sitting still until a named condition (`wake`) occurs:
// sealed in a pit until dawn, asleep in a bed, waiting out a famine indoors. Stillness is the
// GOAL, so a forward-progress watchdog must not read it as a hang.
//
// Before this, each hold had to remember to fake progress on a heartbeat. digInForNight forgot,
// and on 2026-07-29 the watchdog dug the bot out of its own sealed shelter into the dark, where
// a creeper killed it. Heartbeating is also a lie in the log: nothing progressed.
//
// So a hold DECLARES itself, once, and is alive BY CONSTRUCTION for as long as it is declared.
// The TTL is the hold's own deadline: a crashed executor can never leave an eternal hold
// standing (the same bound arbiter.js puts on a maneuver span, for the same reason).
const holds = new Map() // token -> { label, wake, since, until }
let holdSeq = 0
let nowFn = () => Date.now()
function _setNow (fn) { nowFn = fn || (() => Date.now()) } // tests only

// A HOLD IS A CLAIM, AND A CLAIM NEEDS EVIDENCE (2026-07-31). A hold names a WAKE condition, and
// the watchdog trusts it completely - "stillness here is the goal, not a stall". That is only
// honest while the holder is ACTUALLY in the state it claims. It was not:
//   13:46:20 nightRest: bed remembered at 190,68,-102 (11 blocks) - heading there
//   13:46:20 (wd) nightShelter is a DECLARED hold waking on dawn - stillness here is the goal
//   13:46:27 recovery: stuck UNDERGROUND at (188,37,-111) - climbing to the surface y=66
// nightShelter declared "I am resting until dawn" while still ELEVEN BLOCKS AWAY and THIRTY-ONE
// BLOCKS UNDERGROUND, then failed to climb out. The hold suppressed the stall clock, the TTL was
// refreshed by every re-dispatch, and the bot sat in a mineshaft for half an hour "sheltering".
// So a hold may also name its PREMISE - the thing that must be true for its stillness to be
// deliberate. `premise(bot) === false` means the holder is not in the state it claims, and the
// hold stops suppressing (see activeHold). Holds with no premise behave exactly as before.
function beginHold (label, wake, ttlMs, opts = {}) {
  const token = 'h' + (++holdSeq)
  const now = nowFn()
  holds.set(token, {
    label: label || 'hold',
    wake: wake || 'unspecified',
    since: now,
    until: now + Math.max(1000, ttlMs || 60000),
    premise: typeof opts.premise === 'string' && opts.premise ? opts.premise : null
  })
  return token
}
function endHold (token) { return holds.delete(token) }
// The live hold, or null. Expired entries are dropped here (lazily, on read) so nothing has to
// run a sweeper timer - and an expired hold is NOT a hold: the watchdog gets the body back.
// `premiseOK(name) -> bool` is supplied BY THE RUNNER, which owns every body read; this file only
// ever knows the premise's NAME (invariant 2). Omit it and holds behave exactly as they always did.
function activeHold (premiseOK) {
  const now = nowFn()
  let best = null
  for (const [token, h] of holds) {
    if (h.until <= now) { holds.delete(token); continue }
    // A CONTRADICTED PREMISE IS NOT A HOLD. Not deleted - the holder may yet reach the state it
    // claims (it is usually still walking there) - it simply stops vouching for stillness until
    // then, so the watchdog can see a body that is STUCK rather than waiting. An unresolvable or
    // THROWING premise stays trusted: this must never be the thing that strands a bot that really
    // is sealed in, which is the case this whole mechanism exists for.
    if (h.premise && typeof premiseOK === 'function') {
      let ok = true
      try { ok = premiseOK(h.premise) !== false } catch { ok = true }
      if (!ok) continue
    }
    if (!best || h.since < best.since) best = h
  }
  return best
}
function _resetHolds () { holds.clear() }

// ---- the claim registry -----------------------------------------------------------------
// ONE record of who holds the body, written through by the runner's single observation of the
// nine latches (index.js bodyOwner). A claim is `{ key, takenAt, lastDeltaAt, revokedAt, why }`
// and it is a LEASE: alive only while the work behind it is producing world-state deltas.
//
// THE WINDOW IS NOT A NUMBER I CHOSE. "This work is hung" is a verdict this repo already owns and
// has already priced, in one place, twice-derived: scheduler.SURVIVAL_FAIL_MS is the instant the
// supervisor concludes a survival job has made no verified progress, and LATCH_GRACE_MS is how
// long its (cooperative) stop latch then gets to actually bite before "it did not bite" is an
// honest statement. Their sum is already navigate.js's leg ceiling and provision-recovery's
// RUNG_NOPROGRESS_MS. A claim is exactly the same question asked of an owner instead of a job, so
// it gets exactly the same number - a THIRD literal here would be the seam coming back
// ([[threshold-seams]]). Non-survival claims use the patient window the same watchdog uses, and
// since 2026-08-25 they scale with the vitals the same way it does (see claimStaleMs below).
// This is a deadline on an ATTEMPT (the work's attempt to move the world), not a delay before
// thinking (#6): every credited delta pushes it out again, so a claim that is doing anything at
// all never expires, and one that has done nothing since the supervisor gave up on it is gone.
const claims = new Map() // key -> claim
// THE WINDOW IS DANGER-SCALED, because the verdict it restates is (review 2026-08-25, item 5).
// It used to memoise a fixed pair - SURVIVAL_FAIL_MS + LATCH_GRACE_MS (150s) and PATIENT_FAIL_MS
// + LATCH_GRACE_MS (300s) - which is right for a calm bot and wrong for a dying one. The
// supervisor cuts a job that is NOT the answer to the crisis at 40s when hp <= 6 or food <= 2 and
// gives up on it ~100s in; a claim priced at a flat 300s therefore let a hung owner hold the body
// for 200 seconds AFTER the process had concluded its work was dead. The only thing covering that
// hole was the giveup rung's whole-body releaseBodyClaims, which §3.6 shrinks to a scoped lease
// revoke - so the hole has to be closed at the source, not compensated for downstream (#1).
// scheduler.failWindows is now the ONE definition of "how long before this is hung", asked here
// with the caller's vitals and by the job supervisor with the same ones. A claim whose row is
// SURVIVE keeps the full survival window whatever the vitals, exactly as the answer to a crisis
// keeps its own - the crisis window must never cut the response to the crisis (f247a87).
let sched = null // memoised MODULE handle (scheduler.js is required LAZILY - this file's load-order contract)
let schedTried = false
function claimStaleMs (row, vitals) {
  if (!schedTried) {
    schedTried = true
    try {
      const s = require('./scheduler.js') // lazy + PURE, exactly as recoveryLadder.refuse does below: numbers out, no bot, no cycle at load
      if (typeof s.failWindows === 'function' && Number.isFinite(s.LATCH_GRACE_MS)) sched = s
    } catch {}
  }
  const survive = row.tier === 'SURVIVE'
  if (!sched) return survive ? 150000 : 300000 // the same sums, for the impossible case where scheduler.js will not load
  return sched.failWindows(survive ? 'survival' : 'progress', vitals).failMs + sched.LATCH_GRACE_MS
}

// The ONE call the runner makes. `raised` = the owner keys whose latch it just observed true;
// `ev` = { driver, at, vitals } - which claim the work ledger's advances belong to, when that
// ledger last moved (or last had its stillness vouched for by a declared hold), and the live
// vitals, because how long 'no delta' is allowed to last depends on how close death is (item 5).
//
// WHY THE DRIVER AND NOT "anything that happened": while one job holds the ledger key, ANY advance
// in the process credits it - the honest gap item 1 left open and named. Crediting every live
// claim from the same stream would re-open the exact hole this exists to close: at 16:54 the build
// was the thing (not) moving and the dead food run was the thing on top, so a shared clock lets the
// corpse live on the build's evidence. The runner names ONE driver - the claim raised by the job in
// the dispatch slot, else the generic `job` claim a commands-level activity raises, else the top
// live claim, because nothing else could have produced the delta.
//
// Returns { owner, revoked }: the effective owner key (highest-ordered LIVE claim - a revoked claim
// is not an owner, exactly as an expired hold is not a hold) and the claims revoked on this call,
// for the runner to act on and log.
function syncClaims (raised, ev = {}) {
  const now = ev.now != null ? ev.now : nowFn()
  const up = new Set(raised || [])
  // A latch that has gone DOWN closes its claim: the `finally` ran, which is the normal path and
  // the one this whole mechanism is not about. It is also what un-revokes a key - the next raise of
  // a latch that actually came down is a NEW claim with a fresh window, while a revoked latch that
  // never came down stays the same claim and stays revoked (a corpse does not get a second lease).
  for (const key of Array.from(claims.keys())) if (!up.has(key)) claims.delete(key)
  for (const key of up) {
    if (!ownerByKey.has(key)) continue
    if (!claims.has(key)) claims.set(key, { key, takenAt: now, lastDeltaAt: now, revokedAt: 0, why: '' })
  }
  const d = ev.driver && claims.get(ev.driver)
  if (d && !d.revokedAt && ev.at != null && ev.at > d.lastDeltaAt) d.lastDeltaAt = ev.at
  const revoked = []
  // NO EVIDENCE, NO VERDICT (#10 - "unmeasured is not unmet"). A caller that cannot read the work
  // ledger has not shown that anything is stuck; it has shown that it cannot tell. Revoking on that
  // would make an unreadable telemetry cell take the body off every live owner at once.
  if (ev.at == null) return { owner: claimOwner(), revoked }
  for (const c of claims.values()) {
    const row = ownerByKey.get(c.key)
    if (!row || row.engine || c.revokedAt) continue
    const idle = now - c.lastDeltaAt
    const stale = claimStaleMs(row, ev.vitals)
    if (idle < stale) continue
    c.revokedAt = now
    c.why = 'no world delta credited to it for ' + Math.round(idle / 1000) + 's (>' + Math.round(stale / 1000) + 's), held ' + Math.round((now - c.takenAt) / 1000) + 's'
    revoked.push(c)
  }
  return { owner: claimOwner(), revoked }
}
// The effective owner: BODY_OWNERS order (highest tier first - the one a proposal has to out-rank),
// skipping revoked claims. This is the whole of what "a dead owner holds the body forever" cost.
function claimOwner () {
  for (const o of BODY_OWNERS) { const c = claims.get(o.key); if (c && !c.revokedAt) return o.key }
  return null
}
// The claim record, or null - so "the owner is stuck" is a readable fact rather than an inference
// (§3.2). `stalled` is the revocation itself: a claim that reached its window IS the stuck owner.
function claimInfo (key) {
  const c = claims.get(key)
  return c ? { key: c.key, takenAt: c.takenAt, lastDeltaAt: c.lastDeltaAt, stalled: !!c.revokedAt, why: c.why } : null
}
function claimsInfo () { return BODY_OWNERS.map(o => claimInfo(o.key)).filter(Boolean) }
function _resetClaims () { claims.clear() }

// ---- the registry -------------------------------------------------------------------------
// Each row is DATA plus at most two functions, and NONE of them acts on its own:
//   name      the job name the chooser emits and the runner dispatches
//   tier      body-ownership tier (a key of TIERS)
//   why       one line: what this is FOR (read by a human at 3am, so keep it honest)
//   run       the executor: async (bot, ctx) -> a short result string the runner logs
//   owner     for a proposal EXECUTED BY ANOTHER JOB: the name of the job that performs it.
//             `run` or `owner` is MANDATORY - "a decision must produce an action, or name who
//             will" (DESIGN-PRINCIPLES §5), and the contract test enforces exactly that.
//   holds     { wake } - this proposal deliberately waits; see beginHold above
//   refuse    (ctx) -> reason string | null. The PERSISTENT conditions under which the executor
//             cannot run. These used to be silent `return`s in the dispatcher; as refusals they
//             re-enter selection in the same tick and are logged with their blocker.
//   terminal  this row is the arbiter's floor (§3.3): it may NOT carry a `refuse`, the runner
//             never gates it on body ownership or attempt memory, and it takes the body instead
//             of waiting for it. Exactly one row is terminal; reflexestest.js pins both halves.
//   run's result  a plain string (what happened, for the log) or { msg, noOp, noOpWhy }. `noOp`
//             is the executor's OWN verdict that it ran to completion and the world would not
//             budge, and `noOpWhy` is the blocker it names; the runner then records that as an
//             ATTEMPT AT THIS PLACE (attempts.js) and refuses the job until the bot moves, the
//             step changes or the world moves. It is never inferred from the prose: a regex on a
//             result string could not tell "I tried everything" from "someone stopped me
//             mid-sentence", and at hp 1 / food 0 it latched off the recovery ladder.
//   label     the executor name to log, when it differs from the job name.
//
// ctx (built ONCE per tick by the runner):
//   s               the tick's snapshot - ONE reality per decision, so a refusal and the choice
//                   it feeds back into can never disagree about the world
//   now             the tick's captured clock, for refuse(): pure comparisons, no clock read
//   nowMs()         the LIVE clock, for run() only - an executor can run for minutes, so a
//                   cooldown it sets must be stamped when it finishes, not when the tick began
//   foodThreshold   the busy-preempt food threshold (food.busyPreemptFood)
//   progressFoodMin the "may I do progress work" food floor (PROGRESS_FOOD_MIN)
//   knownBed, nearestGrave, pick, say, note   the tick's already-computed handles
//   runner          the runner's own mutable state (cooldowns, latches). Proposals READ it in
//                   refuse() and WRITE it in run(); they never read each other's BODY latches.
const REFLEXES = []
function def (entry) {
  REFLEXES.push(entry)
  return entry
}

// -- SURVIVE ------------------------------------------------------------------------------

// ==== THE TERMINAL ACTION: the arbiter is a TOTAL function ================================
// (structural review 2026-08-25, D3 / §3.3)
//
// THE OUTCOME THIS ROW EXISTS TO MAKE IMPOSSIBLE. In one HEAD-era day: 847 ticks in which a
// crisis was detected, every candidate response refused, and the chooser logged
//   (core) chose build/idle: CRISIS UNANSWERED (...) - doing what i can instead: continuing the
//   active build
// 63% of ALL decisions were that do-nothing fallback. Every individual refusal was honest and
// every one of them was logged - FIX 4 saw to that - and they still summed to zero action, which
// is principle #5 violated at the system level rather than at any one line. A detected crisis in
// which every candidate refuses is a BUG IN THE ARBITER, not a valid outcome.
//
// So the candidate list ends in an action that CANNOT refuse. This row has no `refuse` at all -
// not one that returns null, ABSENT - and reflexestest.js fails the build if a `terminal` row
// ever grows one. It needs no pathfinding to be useful, no other subsystem, and no free body: it
// TAKES the body (§3.2 - the claims are leases, and this is the lease-holder of last resort).
//
// What it does, in order, each step guaranteed executable and each one a real world action:
//   1. EAT WHAT IS IN THE PACK. The commonest crisis is hunger, the commonest absurdity is a
//      starving bot standing on food it owns. No walking, no furnace, no chest - pack only.
//   2. FREE THE BODY. Revoke every claim, drop the nav goal and the control states, and abandon
//      the active job through the EXISTING preempt lever (buildAbort only - persistedResume
//      survives, so the build pauses and never cancels). Then forget every attempt record but
//      this row's own: those records are what refused the crisis responses, the world they were
//      recorded in no longer exists, and a reset that leaves the refusals standing is not a reset.
//   3. GO SOMEWHERE SAFE. recoverHome is the EXISTING "walk to the verified anchor" and it owns
//      the one rule that must not be overridden here - crossingAdmissible, which is what stops a
//      naked bot night-marching 458 blocks to its death. "Everything allowed" (§3.3) does not
//      mean "the death is allowed". If the crossing is barred, the reset above still happened.
//
// The move matters for more than safety: leaving the cell is what re-arms attempt memory for
// every candidate that refused here (attempts.js), so the terminal does not have to know which
// refusals it is clearing - walking away clears them by construction.
//
// AND, SINCE ITEM 5, IT BREAKS THE WEDGE. This row used to stop short of that on purpose: the
// only tools available were the 4-minute freeze watchdog and forceUnstick's rung-pile, and giving
// the floor a dependency on a layer that was about to be deleted would have been the wrong wiring.
// navigate.unstick is that layer's replacement and it is accountable to this arbiter - it plans
// from where the body actually is, bounds itself on attempt memory, and RETURNS a verdict instead
// of re-arming a timer. So step 3 calls it, and only on the evidence that it is needed: a full
// reset has already run in THIS 4b cell and the body is still in it. That is exactly the
// HARD-WEDGED condition this row used to log and hand to nobody, and it is what closes the churn
// item 3 left open - the terminal fires, nothing physically changes, the re-armed responders no-op,
// the terminal fires again. Something now changes the world between those two ticks, or says why not.
const TERMINAL = 'terminalAction'
def({
  name: TERMINAL,
  label: 'terminal',
  tier: 'SURVIVE',
  terminal: true,
  why: 'a detected crisis that every candidate refused: eat, free the body, abandon the job, go somewhere safe',
  // NO `refuse`. BY CONTRACT. See above, and reflexestest.js.
  run: async (bot, ctx) => {
    const commands = require('./commands.js')
    const attempts = require('./attempts.js')
    const provFoodM = provFood()
    const did = []
    const pos = bot.entity && bot.entity.position
    const cell = attempts.cellOf(pos)
    // This row's OWN memory, kept across its own reset: "how many full resets have happened in
    // this cell". It gates nothing (a terminal action that could refuse itself would not be one)
    // - it is the escalation verdict item 5's rescue path will consume, and the number a human
    // greps for when the bot is hard-wedged.
    const prior = attempts.recall(TERMINAL, 'reset', cell)
    const pass = (prior ? prior.n : 0) + 1

    // 1. EAT FROM THE PACK -----------------------------------------------------------------
    try {
      if (bot.food != null && bot.food < 20) {
        const before = bot.food
        await provFoodM.eatUp(bot) // pack only: equip + consume. No nav, no furnace, no chest.
        if (bot.food > before) did.push('ate from the pack (food ' + before + ' -> ' + bot.food + ')')
      }
    } catch (e) { did.push('could not eat (' + e.message + ')') }

    // 2. FREE THE BODY ---------------------------------------------------------------------
    try { const freed = commands.releaseBodyClaims('terminal action: crisis unanswered' + (pass > 1 ? ' (reset #' + pass + ' in this cell)' : '')); if (freed) did.push('revoked the body claims: ' + freed) } catch (e) { did.push('claim revoke threw (' + e.message + ')') }
    try { if (commands.preemptForSurvival) { commands.preemptForSurvival(); did.push('abandoned the active job (its resume is persisted)') } } catch {}
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    const forgotten = attempts.forgetAll({ except: TERMINAL })
    if (forgotten) did.push('forgot ' + forgotten + ' attempt record(s) - every refused responder is admissible again')

    // 3. BREAK THE WEDGE, IF THIS CELL HAS ALREADY EATEN A RESET ---------------------------
    // Not on the first pass: a bot that merely lost its way is freed by steps 1-2 plus the walk
    // home below, and running escape maneuvers on a body that can walk is how the old ladder
    // became the main loop. `pass > 1` means a full reset already ran in this same 4b cell and
    // the body did not leave it - the only `prior` record this row keeps, and a condition, never
    // a timer. `force` because the floor may not refuse itself: the rungs this cell has already
    // failed are re-tried here, since the alternative is a terminal action that cannot break the
    // wedge it named. digOut/desperate ride the SAME escalation the deleted freeze watchdog used
    // to reach after two failed escapes at one cell - on stronger evidence (a reset apiece), and
    // with the dig permission rules (provision-core.digBlocked, scaffold.js) untouched.
    if (pass > 1) {
      try {
        const nav = require('./navigate.js') // lazily, like every executor here (invariant: nothing heavy at load)
        const r = await nav.unstick(bot, null, { force: true, digOut: pass >= 3, desperate: pass >= 4, holdOK: ctx.holdOK, why: 'terminal full reset #' + pass })
        did.push(r.moved
          ? 'BROKE THE WEDGE via ' + r.via + ' (' + r.plan.join('>') + ')'
          : (r.verdict === 'held'
              ? 'did NOT force an un-wedge - a declared hold vouches for this stillness'
              : 'could not break the wedge: ' + r.verdict + ' after trying ' + (r.tried.join(', ') || 'nothing applicable')))
      } catch (e) { did.push('the un-wedge threw (' + e.message + ')') }
    }

    // 4. GO SOMEWHERE SAFE -----------------------------------------------------------------
    let moved = ''
    try {
      const pr = commands.persistedResume && commands.persistedResume()
      // ONE THRESHOLD, NOT TWO ([[threshold-seams]]). recoverHome's default "far" is 64b - it was
      // written for a respawn on the other side of the world, and for that caller a bot 40b from
      // its door is already home. For the floor, "far" means "not AT the anchor", and this
      // function already owns a number for that: its arrival radius. Passing the same 8 to both
      // ends is what makes the walk happen at all in the case that matters most - a bot stuck a
      // short distance from its own door, where a 64b gate would return "not far" and move nothing.
      const rh = await provRecovery().recoverHome(bot, { say: ctx.say, resumeAt: pr && pr.at, dist: 8, arrive: 8 })
      if (rh.arrived) moved = 'reached the home anchor'
      else if (rh.stabilise) moved = 'did NOT cross to home (' + (rh.blockedOn || 'blocked') + ': ' + (rh.why || '') + ') - staying put is the safer half of the reset'
      // "not far" has TWO causes and they are not the same news (#7): standing at the anchor, and
      // having no anchor to stand at. The second one is the bot's whole predicament, not a success.
      else if (rh.far === false) moved = rh.anchor ? 'already at the home anchor' : 'no home anchor is remembered - there is nowhere safer to walk to'
      else moved = 'still ' + Math.round(rh.dist || 0) + 'b from home after this pass'
    } catch (e) { moved = 'the walk home threw (' + e.message + ')' }
    did.push(moved)

    const nowCell = attempts.cellOf(bot.entity && bot.entity.position)
    // Step 'reset', not '-', ON PURPOSE: the runner's generic bookkeeping forgets (jobKey, '-',
    // cell) for every job that did NOT return a no-op verdict, and this row never returns one. A
    // counter the generic path could erase would reset itself every pass and could never say
    // "third full reset in this cell", which is the one thing it is for.
    attempts.record(TERMINAL, 'reset', cell, { now: ctx.nowMs(), why: 'full reset ran here', sig: '' })
    if (pass > 1 && nowCell === cell) {
      // A statement of fact for the log: a full reset has now run N times in this same 4b cell,
      // the rescue above was asked to break it, and the body is STILL in it. This is the honest
      // end of the line - there is deliberately nothing below it that retries on a clock.
      ctx.note('(terminal) HARD-WEDGED: full reset #' + pass + ' in cell ' + cell + ' and the body did not leave it' +
        (pass > 1 ? ' - the rescue was forced and could not free it either' : ''))
    }
    return {
      msg: 'full reset #' + pass + ' - ' + did.join('; '),
      // NEVER a no-op verdict. A terminal action that could latch itself off is not terminal, and
      // the arbiter would be back to accepting "no" for an answer.
      noOp: false
    }
  }
})

def({
  name: 'recoveryLadder',
  label: 'recoverFromDegraded',
  tier: 'SURVIVE',
  why: 'the compound-degraded state (naked/starving/hurt at once) runs the R0..R5 ladder',
  // NO BESPOKE refuse ANY MORE (structural review §3.6). This row used to carry FIX 3's own
  // condition gate - `runner.ladderBlock`, a { sig, blockedOn } pair compared against
  // recoverySignature - and the comment right below it complained, correctly, that "two latches
  // on one signature is one rule with two definitions". It was: the generic job-identity latch
  // and this one, both keyed on the same fingerprint, and both unreachable from a wedge because
  // POSITION IS NOT IN THAT FINGERPRINT (651 x "last pass made no progress and nothing has
  // changed since" in a day, at a bot that could not move). The rule is now written ONCE, in
  // attempts.js, keyed by (job, step, cell) and asked by the runner for EVERY job - so the ladder
  // is refused when it has achieved nothing HERE, and re-armed by moving, by the world changing,
  // or by the terminal action's reset. The blocker text this row used to compute is carried on
  // the record instead (`noOpWhy` below), so the refusal still names what has to change (#7).
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    const scheduler = require('./scheduler.js')
    const r = await provRecovery().recoverFromDegraded(bot, { say: ctx.say })
    // An INTERRUPTED pass proves nothing about the world, so it must not record an attempt
    // either. 'busy'/'stopped'/'deadline' all mean the pass ended for reasons that have
    // nothing to do with whether its rungs could have worked - and on 2026-07-29 21:12 a
    // watchdog-stopped pass latched the ladder off at hp 1 / food 0 / naked, which is the
    // failure this whole gate exists to prevent, arriving from the other direction.
    const interrupted = r.reason === 'stopped' || r.reason === 'busy' || r.reason === 'deadline'
    const blocked = !r.done && !interrupted && r.progressed === false
    return {
      msg: (r.done ? 'recovered' : 'NOT recovered (' + (r.reason || 'rungs exhausted') + (r.blockedOn ? ', blocked on ' + r.blockedOn : '') + ')') +
                  (r.rungs.length ? ' via ' + r.rungs.join(' > ') : ''),
      // The SAME data-driven verdict as before (r.progressed / r.blockedOn, computed from real
      // per-rung facts), now spoken in the one vocabulary every other row uses. Never inferred
      // from the prose: a regex on a result string could not tell "I tried everything" from
      // "someone stopped me mid-sentence", and at hp 1 / food 0 it latched off the recovery ladder.
      noOp: blocked,
      noOpWhy: blocked ? scheduler.blockerText(r.blockedOn || 'blocked') : undefined
    }
  }
})

def({
  name: 'graveSweep',
  label: 'recover',
  tier: 'SURVIVE',
  why: 'a worthwhile grave at arm\'s reach IS the survival move - free gear, and often food',
  refuse: (ctx) => ctx.now < ctx.runner.graveCooldownUntil
    ? 'that grave just failed to open/reach - backing off before another attempt'
    : null,
  run: async (bot, ctx) => {
    const commands = require('./commands.js')
    const scheduler = require('./scheduler.js')
    // task #18 M4: a verdict-classed back-off instead of a blanket 300s - a stalled PARTIAL comes
    // straight back inside the despawn window. remainMs is the nearest grave's despawn budget.
    const graveUrgentOn = process.env.GRAVE_URGENT !== '0'
    const remainMs = graveUrgentOn && ctx.nearestGrave ? ctx.nearestGrave.remainMs : undefined
    try {
      const r = await commands.handle(bot, 'recover', { source: 'scheduler' })
      const cd = scheduler.graveCooldownMs(r, { remainMs, flagOn: graveUrgentOn })
      if (cd > 0) ctx.runner.graveCooldownUntil = ctx.nowMs() + cd
      return String(r || '').split('\n')[0] + (graveUrgentOn && cd > 0 ? ' (cooldown ' + Math.round(cd / 1000) + 's)' : '')
    } catch (e) {
      const cd = scheduler.graveCooldownMs('', { remainMs, flagOn: graveUrgentOn })
      if (cd > 0) ctx.runner.graveCooldownUntil = ctx.nowMs() + cd
      throw e
    }
  }
})

def({
  name: 'secureFood',
  tier: 'SURVIVE',
  why: 'the ONE food policy: eat -> bank -> cook -> hunt -> farm -> fish -> scout -> hold',
  // When this proposal is refused, THIS is what happens instead. A refusal must perform the
  // alternative it names or name the owner that will (DESIGN-PRINCIPLES §5) - the night-forage
  // guard printed "sheltering, not foraging" while nothing sheltered, and the audit's D2 is
  // exactly that class of comforting lie. As data, the promise is kept by the runner.
  alternative: 'nightShelter',
  refuse: (ctx) => {
    // NIGHT-FORAGE GUARD (#11 - a live death: creeper at the hut doorstep while foraging at
    // night un-armoured). This was a silent hold: the tick logged "sheltering, not foraging"
    // and returned, while NOTHING sheltered. As a refusal it hands the body to the nightShelter
    // candidate, which does shelter - the deferral finally names an action that happens.
    if (process.env.NIGHT_FORAGE_GUARD === '0') return null
    const sn = arbiter.jobSurvivalNeed(ctx.s, { foodThreshold: ctx.foodThreshold })
    return (sn && sn.need === 'shelter')
      ? 'un-armoured at night - foraging out into the dark is the death, not the hunger'
      : null
  },
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    const r = await provFood().secureFood(bot, { home: ctx.knownBed, canHold: true, say: ctx.say })
    // 'busy'/'stopped' mean SOMEONE ELSE ended this pass - it proves nothing about the world and
    // must never latch. 'night'/'food' are real conditions, and both are in the recovery
    // signature, so the latch clears the moment either moves.
    const interrupted = r.blockedOn === 'busy' || r.blockedOn === 'stopped'
    return {
      msg: r.fed ? 'fed (food ' + bot.food + ')' : 'not fed - blocked on ' + r.blockedOn,
      noOp: !r.fed && !interrupted
    }
  }
})

def({
  name: 'recoverHp',
  tier: 'SURVIVE',
  why: 'hurt and still endangered: stop the job, get somewhere safe and heal',
  refuse: (ctx) => ctx.now < ctx.runner.hpCooldownUntil
    ? 'just tried to heal - letting regeneration have a window before trying again'
    : null,
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    try { return await provRecovery().recoverHp(bot, { say: ctx.say }) } finally {
      ctx.runner.hpCooldownUntil = ctx.nowMs() + 60000 // as the old hp-crisis reflex did: cool 60s after the attempt
    }
  }
})

def({
  name: 'nightShelter',
  tier: 'SURVIVE',
  why: 'dusk + exposure: a bed if there is one, a sealed pit if there is not',
  // A DECLARED HOLD. Sitting perfectly still until dawn is the goal, not a hang - and this is
  // the row that stops a watchdog digging the bot out of its own shelter (see beginHold).
  // ...and its PREMISE, DECLARED BY NAME: stillness here is deliberate only once the bot is
  // actually sheltered. This row states WHICH premise; the runner owns reading the body for it
  // (invariant 2 - no body latch is read in this file, arbitration belongs to the runner, once).
  holds: { wake: 'dawn', premise: 'sheltered' },
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    const rested = await provRecovery().nightRest(bot, { say: ctx.say })
    return {
      msg: rested ? 'sheltered for the night' : 'could not shelter (no bed, no diggable ground) - holding',
      noOp: !rested // no bed and no diggable ground here is a fact about THIS place: do not re-dig it every 15s
    }
  }
})

def({
  name: 'homecoming',
  tier: 'SURVIVE',
  why: 'displaced (usually by a death): cross back to base while the crossing is survivable',
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    const commands = require('./commands.js')
    const pr = commands.persistedResume && commands.persistedResume()
    // (this used to set a `recoveringHome` flag whose only readers were the gear-up and
    //  home-repair TIMERS - "go home outranks re-arming in the wild". Both are proposals now,
    //  and the tier ordering says the same thing without a flag: homecoming is SURVIVE and
    //  owns the body, so nothing at PROGRESS can start underneath it.)
    const rh = await provRecovery().recoverHome(bot, { say: ctx.say, resumeAt: pr && pr.at })
    if (rh.arrived) return 'home' + (rh.bedOk ? ' - spawn re-anchored at the bed' : ' - bed could NOT be re-asserted')
    if (rh.stabilise) return 'stood down mid-crossing (' + (rh.blockedOn || 'blocked') + '): ' + (rh.why || '')
    return 'did not reach home this pass (' + Math.round(rh.dist || 0) + 'b out) - will pick it up again'
  }
})

def({
  name: 'spawnReassert',
  tier: 'SURVIVE',
  why: 'the spawn anchor is KNOWN wrong - re-assert it at the bed before the next death costs 480 blocks',
  // A respawn that landed far from the remembered bed PROVED the anchor is not what the bot
  // thinks (provision.setSpawnSuspect). That is survival work: the difference between a death
  // costing 11 blocks and one costing a 480-block naked walk home is exactly this flag.
  // ONLY the `suspect` case, and that is the point. A merely UNCONFIRMED anchor is already
  // bootstrapNeed's 'spawn' verdict, dispatched through maintenancePass STEP H (#117) - so a
  // second row for it would be one rule with two definitions. What the old 45s timer uniquely
  // did was repair a PROVEN-WRONG anchor while the build ran, by overriding its own idle gate;
  // that is a survival-tier claim on the body, and expressing it as a tier is the whole point.
  when: (s) => !!s.spawnSuspect && !!s.bedKnown && s.bedDist != null && s.bedDist <= 24,
  // Ranks above a bootstrap chore (~0.54) and below sheltering at dusk (~0.65): fixing where you
  // wake up matters more than armour and less than not dying tonight.
  benefit: 0.62,
  urgency: () => 1,
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    const ok = (await provRecovery().ensureSpawnBed(bot, { force: true, maxTrek: 40 })).ok
    return { msg: ok ? 'suspect anchor re-asserted at the bed - back to normal' : 'could not re-assert the anchor here', noOp: !ok }
  }
})

// -- PROGRESS (chores and re-arming: they yield to a build, and to everything above) --------

// ==== THE BUILD IS A JOB LIKE ANY OTHER (structural review 2026-08-25, D6 / item 7) =========
//
// WHAT WAS HERE BEFORE: nothing. The build had no row, because it had no dispatcher. It was
// driven by THREE private timers in index.js - a 25s boot one-shot, a 120s re-arm interval and
// a loop in the respawn handler - each of which called commands.resumeBuild directly, took the
// body without a lease, and answered to nobody. The review's D6 states the consequence: "the
// noOp latch tracks SURVIVAL jobs only, and autobuild runs inline outside the dispatch/lease
// system entirely", so item 3's attempt memory could not remember a build's failures, item 2's
// claim registry could not tell whose work an advance was, and the watchdog's last rung found
// "no dispatch slot" and stood down. The castle's bootstrap step - gather 3 oak logs - restarted
// every twenty minutes for a whole day, identically, and zero builds completed in four days.
//
// It is one row now. The chooser weighs it, ONE dispatcher runs it, it holds the lease while it
// runs, the watchdog can revoke it, and every failure is remembered against (job, step, cell).
//
// THE STEP HALF OF THAT KEY IS THIS ROW'S REAL CONTRIBUTION. `step()` is what index.js's stepOf
// has been looking for since item 3 shipped with a placeholder: until now every job's step was
// '-', so "gathering failed at the site" and "the whole build failed at the site" were the same
// record and neither could escalate. The checklist has published the step all along (telemetry
// JOB_STEPS); nothing read it.
//
// NOT `refuse`-free and not terminal: a build is the most interruptible thing the bot does.
const buildRow = def({
  name: 'build',      // the CHOOSER's name for it (scheduler.pickJob emits this)
  label: 'autobuild', // the EXECUTOR's name, for the log - the same split recoveryLadder uses
  tier: 'PROGRESS',
  why: 'the saved operator build: work the checklist, step by step, and reach a verdict when a step will not move',
  // PURE-ish by the same rule `when`/`refuse` follow: it reads the telemetry checklist and
  // nothing else - no bot handle, no world read, no body latch.
  step: () => { try { return require('./telemetry.js').checklistStepName() } catch { return '-' } },
  refuse: (ctx) => {
    const scheduler = require('./scheduler.js') // lazy + PURE (numbers out, no bot) - same shape claimStaleMs uses
    if (!ctx.s.persistedBuild) return 'there is no saved build to resume'
    // #114 ONE_READINESS, unchanged and now asked from a third place with the SAME function:
    // the chooser's feasibility term, commands.resumeBuild's own gate, and this refusal are one
    // predicate. The stand-down hold the verdict below sets is inside it (buildReady clause 4),
    // so the abandon verdict actually stops the chooser re-picking the build - which is the
    // difference between a verdict and a log line (#5).
    let r = null
    try { r = scheduler.buildReady(ctx.s) } catch { return null }
    return (r && !r.ok) ? r.why + (r.need ? ' (needs ' + r.need + ')' : '') : null
  },
  run: async (bot, ctx) => {
    const commands = require('./commands.js')
    const scheduler = require('./scheduler.js')
    const attempts = require('./attempts.js')
    const r = await commands.resumeBuild(bot)
    const step = buildRow.step()
    const placed = (r && Number(r.placed)) || 0
    // WHAT COUNTS AS "THIS ACHIEVED NOTHING", and it is the executor's data, never a regex on
    // its prose (the rule this file already states for the ladder and the food run):
    //   aborted     somebody else ended the pass (the stop latch, a preempt, a death). An
    //               interrupted pass proves NOTHING about the world and must not be remembered -
    //               2026-07-29 21:12 latched the recovery ladder off at hp1/food0 exactly this way.
    //   deferred    a precondition held it; the refusal above owns that, not this memory.
    //   unreachable three full travel attempts and the site is still out of reach. That IS the
    //               world's answer to the 'travel to site' step, in this place.
    //   placed 0    it ran the whole way through and moved not one block.
    const interrupted = !!(r && (r.aborted || r.deferred))
    const noOp = !!r && !interrupted && (r.unreachable === true || placed === 0)
    const msg = !r
      ? 'nothing to resume'
      : (r.deferred
          ? 'held: ' + (r.why || 'precondition')
          : (r.unreachable
              ? 'the site is out of reach'
              : (placed === 0 && r.why
                  ? r.why
                  : placed + '/' + (r.total || 0) + ' placed' + (r.skipped ? ', ' + r.skipped + ' skipped' : '') + (r.stopped ? ' (stopped)' : ''))))
    if (!noOp) {
      // The plan moved. Forget what this step owes at plan level, so a build that gets going
      // again does not carry a two-thirds-full abandon counter into its next bad patch.
      try { attempts.forget('build', step, 'plan') } catch {}
      try { attempts.forget('build', step, 'plan@' + attempts.cellOf(bot.entity && bot.entity.position)) } catch {}
      return { msg, noOp: false }
    }
    // ---- THE VERDICT ---------------------------------------------------------------------
    // The runner records THIS pass's (build, step, cell) attempt after we return, so the count
    // it is about to write is prior+1 - the same arithmetic the terminal row does for its own
    // reset counter, for the same reason (a row cannot read a record that does not exist yet).
    const cell = attempts.cellOf(bot.entity && bot.entity.position)
    const why = (r && r.unreachable) ? 'could not reach the site' : ((r && r.why) || 'the pass placed nothing')
    // ---- THE JOB LAYER'S OWN COUNTERS ----------------------------------------------------
    // Both live in attempt memory under SYNTHETIC cells - the idiom the terminal row already
    // uses for its synthetic 'reset' step - and both are written with an EMPTY signature, which
    // is what makes them counters rather than gates: attempts.futile only ever clears a record
    // whose signature has moved, and an empty one never has.
    //
    // WHY THEY CANNOT BE THE RECORD THE RUNNER WRITES. That one is a GATE, and it is correctly
    // volatile: a changed world deserves a fresh attempt, so `futile` deletes it on read and its
    // count restarts at 1. Live, the recovery signature moves within minutes (the hour bucket,
    // the food bucket), so a counter built on it could never reach three and the verdict would
    // be unreachable - the same "the re-arm is unreachable from the state the latch fired in"
    // shape, arriving from the opposite direction. These two are never read by `futile`; they are
    // cleared by a pass that WORKED, by the abandon verdict, and by the terminal full reset.
    //   planN  this step has achieved nothing N times running, anywhere - the TRIGGER.
    //   hereN  ...and how many of those were in THIS 4b cell - the DISCRIMINATOR that tells
    //          "the ground is bad" (re-plan) from "the step is impossible" (abandon).
    const planN = attempts.record('build', step, 'plan', { now: ctx.nowMs(), why, sig: '' }).n
    const hereN = attempts.record('build', step, 'plan@' + cell, { now: ctx.nowMs(), why, sig: '' }).n
    const v = scheduler.buildVerdict({ step, cellN: hereN, planN })
    if (!v) return { msg, noOp: true, noOpWhy: why }
    // Both rungs stand the plan down through the ONE existing lever - markResumePaused. It is
    // not a delete: the job stays on disk, "resumebuild" overrides it, and the operator's intent
    // survives (giving up used to clearPersistedResume and it erased a castle live). What differs
    // between the rungs is how long the bot is asked to leave it alone, and how loudly it says so.
    const abandon = v.verdict === 'abandon'
    // The counter has done its job once the plan is SET DOWN: a fresh start (the hold lapsing, or
    // an operator "resumebuild") deserves a clean slate, or the very first failure after it would
    // abandon again on a count nobody earned. A RE-PLAN keeps counting on purpose - it is the
    // lighter verdict, and a re-plan that changes nothing must escalate rather than repeat.
    if (abandon) try { attempts.forget('build', step, 'plan'); attempts.forget('build', step, 'plan@' + cell) } catch {}
    const holdMs = abandon ? undefined : Number(process.env.BUILD_REPLAN_HOLD_MS || 120000) // undefined -> resumeHoldRemaining's own RESUME_HOLD_MS (15 min)
    try { commands.markResumePaused((abandon ? 'abandon: ' : 're-plan: ') + v.why, holdMs) } catch {}
    ctx.note('(build) ' + v.verdict + ': ' + v.why + ' [step "' + step + '", cell ' + cell + ', ' + why + '] - the plan is stood down' + (abandon ? '; "resumebuild" restarts it, "cancelbuild" drops it' : ' for ' + Math.round(holdMs / 1000) + 's'))
    try { commands.recordOutcome('build:' + v.verdict, false, v.why) } catch {}
    try { commands.noteJobVerdict({ job: 'build', step, verdict: v.verdict, why: v.why }) } catch {}
    if (abandon) try { ctx.say('i can\'t get past "' + step + '" - setting that build down for now') } catch {}
    return { msg: msg + ' -> ' + v.verdict, noOp: true, noOpWhy: why }
  }
})

def({
  name: 'maintenancePass',
  tier: 'PROGRESS',
  why: 'establish the missing survival infra (spawn/armor/food-reserve/lit base), then upkeep',
  refuse: (ctx) => {
    if (ctx.now < ctx.runner.maintainCooldownUntil) return 'cooling off after the last maintenance pass'
    // At night the pass is indoor-only, so being far from home makes it UNDISPATCHABLE, not
    // merely delayed - the chooser must see that or it keeps picking a job that cannot run
    // (measured 2026-07-29 14:44-14:49: `bootstrap spawn` picked 7x, dispatched 0x, silently).
    if (ctx.s.isNight && (ctx.s.homeDist == null || ctx.s.homeDist > 48)) {
      return 'night chores are indoor-only and home is ' + (ctx.s.homeDist == null ? 'unknown' : Math.round(ctx.s.homeDist) + 'b') + ' away'
    }
    const n = arbiter.jobSurvivalNeed(ctx.s, { foodThreshold: ctx.progressFoodMin })
    if (n) return 'survival first: ' + (n.reason || n.need)
    return null
  },
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    // #117 HOME_IS_A_NEED: the chooser's bootstrap verdict is HANDED TO the executor, so
    // 'spawn'/'shelter' reach their producers instead of being computed, logged and dropped.
    const r = await provMaintain().maintenancePass(bot, { say: ctx.say, nightIndoorOnly: !!ctx.s.isNight, bootstrap: (ctx.pick && ctx.pick.bootstrap) || null })
    const worked = !!(r && r.steps && r.steps.length && !/^bail/.test(r.reason || ''))
    ctx.runner.maintainCooldownUntil = ctx.nowMs() + (worked ? 600000 : 300000) // 10 min after a real pass, 5 after a no-op/bail
    return r && r.steps && r.steps.length ? r.steps.join('+') : (r && r.reason) || 'nothing due'
  }
})

def({
  name: 'reclaim',
  tier: 'PROGRESS',
  why: 'pay down what the bot owes the world (#119) - it competes for the body, it never wins it',
  refuse: (ctx) => {
    // Never at night: reclamation is cosmetic work and the dark is where the deaths are. A
    // CONDITION, not a cooldown - it clears the moment the sun does.
    if (ctx.s.isNight) return 'tidying up is daytime work - the dark is where the deaths are'
    const n = arbiter.jobSurvivalNeed(ctx.s, { foodThreshold: ctx.progressFoodMin })
    if (n) return 'survival first: ' + (n.reason || n.need)
    return null
  },
  run: async (bot, ctx) => {
    const commands = require('./commands.js')
    const r = await require('./reclaim.js').reclaimPass(bot, { isStopped: () => !!(commands.isEscaping && commands.isEscaping()) })
    return { msg: (r && r.reason) || 'nothing owed', noOp: !(r && r.reclaimed > 0) }
  }
})

// -- PROGRESS, executed by another job ------------------------------------------------------
// These three used to be standalone 60s/20s/45s timers with their own guard stacks. They are
// STEPS of the maintenance pass now (steps 1, 6 and 9), so the registry records them as
// proposals with a NAMED OWNER rather than as executors that would double-drive the body.
// This is DESIGN-PRINCIPLES §5 as data: a proposal that does not perform its own action must
// name the one that does, and bot/reflexestest.js checks that the owner really exists.

def({
  name: 'foodTopUp',
  tier: 'PROGRESS',
  owner: 'maintenancePass',
  why: 'top the pack food buffer up from the bank BEFORE hunger becomes a crisis (maintain step 1)'
})

def({
  name: 'gearup',
  tier: 'PROGRESS',
  owner: 'maintenancePass',
  why: 'an under-armoured bot re-arms itself: wear what it has, else the iron bootstrap (maintain step 6)'
})

def({
  name: 'homeRepair',
  tier: 'PROGRESS',
  owner: 'maintenancePass',
  why: 'creeper damage to the base is repaired from home, never trekked to (maintain step 9)'
})

// -- IDLE: housekeeping (PLAN-one-runner S5) -------------------------------------------------
// These four were 3s/30s/45s timers, each with its own private "am I allowed to move?" stack.
// They are the clearest case for the registry, because none of them is ever URGENT and all four
// used to be able to yank the body the instant a latch happened to read false.
//
// They are SELF-PROPOSING: unlike the survival jobs (whose candidate the utility core builds from
// the survival need), the registry is the only place that knows a drop is on the ground or that
// there is raw meat to cook, so each carries its own `when` and `benefit`. scheduler-core scores
// them alongside everything else - benefit x urgency - risk - and that is the entire reason they
// stop being able to interrupt anything: an IDLE-tier proposal loses to every owner, and its
// score sits below a waiting build (W_RESUME 0.2) and above pure idling (W_IDLE 0.1).
//
// `when` is PURE over the snapshot. The facts it reads are the cheap ones survival-snapshot.js
// already assembles from in-memory state (the entity list, the pack, the infra registry, the
// scaffold ledger) - no new world scan, because the tick is the body's own event loop
// ([[body-first-priority]]).

def({
  name: 'autoCollect',
  tier: 'IDLE',
  why: 'walk over a dropped item and pick it up, the way a player tidies up after a chop',
  when: (s) => s.dropDist != null && s.dropDist <= 8,
  benefit: 0.16,
  // a drop underfoot is nearly free; one 8b away is a walk. Never NEVER dive for it: items sunk
  // in water lured the idle bot to the river bottom and it drowned reclaiming its own death-drops
  // (the snapshot excludes submerged drops for exactly that reason).
  urgency: (s) => Math.max(0, 1 - (s.dropDist || 0) / 8),
  run: async (bot, ctx) => {
    const { goals } = require('mineflayer-pathfinder')
    const me = bot.entity && bot.entity.position
    let best = null; let bestD = 8
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e.name !== 'item') continue
      const d = e.position.distanceTo(me)
      if (d > 1.3 && d < bestD) { bestD = d; best = e }
    }
    if (!best) return 'nothing on the ground any more'
    // range 0: actually walk ONTO the item's block - range 1 can count as "arrived" a block
    // short, so the bot never touches the drop and never picks it up.
    await bot.pathfinder.goto(new goals.GoalNear(best.position.x, best.position.y, best.position.z, 0))
    return 'picked up a drop ' + Math.round(bestD) + 'b away'
  }
})

def({
  name: 'autoCook',
  tier: 'IDLE',
  why: 'raw meat in the pack and a furnace on the map: cook it while there is nothing better to do',
  when: (s) => (s.rawMeat || 0) > 0 && s.furnaceDist != null && s.furnaceDist <= 24,
  benefit: 0.18,
  urgency: (s) => Math.min(1, (s.rawMeat || 0) / 8) * Math.max(0.2, 1 - (s.furnaceDist || 0) / 24),
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    const n = await provFood().cookRawMeat(bot, {})
    return { msg: n > 0 ? 'cooked ' + n + ' raw meat at the furnace' : 'nothing cooked', noOp: !(n > 0) }
  }
})

def({
  name: 'scaffoldSweep',
  tier: 'IDLE',
  why: 'tear down the orphaned towers a death or a restart left standing in the forest',
  when: (s) => (s.scaffoldDebtNear || 0) > 0,
  benefit: 0.12,
  urgency: (s) => Math.min(1, (s.scaffoldDebtNear || 0) / 12),
  run: async (bot, ctx) => {
    const scaffold = require('./scaffold.js')
    const n = await scaffold.teardown(bot, bot.entity.position, { radius: 20, max: 12 })
    return { msg: n ? 'tore down ' + n + ' orphaned scaffold block(s)' : 'nothing reachable to tear down', noOp: !n }
  }
})

def({
  name: 'autoTorch',
  tier: 'IDLE',
  why: 'light the way at night like a companion would - opt-in, because it is an autonomous placer',
  when: (s) => process.env.AUTO_TORCH === '1' && !!s.isNight && (s.torches || 0) > 0,
  benefit: 0.13,
  urgency: () => 0.6,
  run: async (bot, ctx) => {
    const commands = require('./commands.js')
    // the "already lit nearby" check stays here: it is a world read, and `when` is pure.
    try {
      const md = require('minecraft-data')(bot.version)
      const ids = Object.values(md.blocksByName).filter(b => /torch|lantern/.test(b.name)).map(b => b.id)
      if (ids.length && bot.findBlock({ matching: ids, maxDistance: 6 })) return 'nothing to light - there is already a torch here'
    } catch { /* mcData not ready: fall through, placeTorchNearby is idempotent enough */ }
    return await commands.placeTorchNearby(bot)
  }
})

// ---- self-proposing candidates -------------------------------------------------------------
// The candidates scheduler-core merges into its own list. Same shape its Phase-B candidates use
// (job/cls/key/order/score/reason), and the same utility signature: benefit x urgency - risk.
// The RISK is passed in rather than re-derived, so there is exactly one definition of it.
function proposalCandidates (s, opts) {
  const risk = (opts && typeof opts.risk === 'number') ? opts.risk : 0
  const riskWeight = (opts && typeof opts.riskWeight === 'number') ? opts.riskWeight : 0.15
  const out = []
  for (const r of REFLEXES) {
    if (typeof r.when !== 'function') continue
    let ok = false
    try { ok = !!r.when(s) } catch { ok = false }
    if (!ok) continue
    let u = 1
    try { u = typeof r.urgency === 'function' ? r.urgency(s) : 1 } catch { u = 1 }
    const score = (r.benefit || 0.1) * Math.max(0, Math.min(1, u)) - riskWeight * risk
    out.push({ job: r.name, cls: classOf(r.tier), key: r.name, order: 4, score, reason: r.why })
  }
  return out
}

// ---- lookups ------------------------------------------------------------------------------
const byName = new Map(REFLEXES.map(r => [r.name, r]))
function get (name) { return byName.get(name) || null }
function names () { return REFLEXES.map(r => r.name) }
// Every proposal that can actually be DISPATCHED (it has an executor of its own).
function dispatchable () { return REFLEXES.filter(r => typeof r.run === 'function') }

module.exports = {
  TIERS,
  TERMINAL, // the ONE name of the terminal action - scheduler-core chooses it, index.js dispatches it, one definition (#4)
  tierRank,
  classOf,
  BODY_OWNERS,
  ownerInfo,
  claimOfJob,
  bodyRefusal,
  mayTakeBody,
  syncClaims,
  claimOwner,
  claimInfo,
  claimsInfo,
  _resetClaims,
  REFLEXES,
  get,
  names,
  dispatchable,
  proposalCandidates,
  beginHold,
  endHold,
  activeHold,
  _resetHolds,
  _setNow
}
