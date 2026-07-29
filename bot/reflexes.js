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
//   21  provision.isResting()         10  arbiter.maneuverActive()     7  navigate.isForceUnsticking()
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

// ---- tiers ------------------------------------------------------------------------------
// The tier vocabulary IS arbiter.PRIORITY - re-exported, never copied, so there is no second
// scale to drift (PLAN §3.1). A tier answers "who owns the body", which is the arbiter's
// question, and it is the same scale a maneuver span is opened at.
const TIERS = arbiter.PRIORITY // { IDLE:0, PROGRESS:1, PRESERVE:2, SURVIVE:3 }
const TIER_NAMES = Object.keys(TIERS)
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
const BODY_OWNERS = [
  { key: 'escape', tier: 'SURVIVE', hard: true, label: 'an escape' },
  { key: 'navRecovery', tier: 'SURVIVE', hard: true, label: 'a navigation recovery' },
  { key: 'ladder', tier: 'SURVIVE', hard: true, owns: 'recoveryLadder', label: 'the recovery ladder' },
  { key: 'foodRun', tier: 'SURVIVE', crisisOnly: true, owns: 'secureFood', label: 'a food run' },
  { key: 'shelter', tier: 'SURVIVE', crisisOnly: true, owns: 'nightShelter', label: 'the night shelter' },
  { key: 'maintain', tier: 'PROGRESS', owns: 'maintenancePass', label: 'a maintenance pass' },
  { key: 'job', tier: 'PROGRESS', crisisOnly: true, label: 'a job' },
  { key: 'walk', tier: 'PROGRESS', label: 'a walk already in progress' },
  { key: 'dig', tier: 'PROGRESS', label: 'a dig in progress' } // aborting a dig resets its break progress - never for housekeeping
]
const ownerByKey = new Map(BODY_OWNERS.map(o => [o.key, o]))
function ownerInfo (key) { return ownerByKey.get(key) || null }

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

function beginHold (label, wake, ttlMs) {
  const token = 'h' + (++holdSeq)
  const now = nowFn()
  holds.set(token, { label: label || 'hold', wake: wake || 'unspecified', since: now, until: now + Math.max(1000, ttlMs || 60000) })
  return token
}
function endHold (token) { return holds.delete(token) }
// The live hold, or null. Expired entries are dropped here (lazily, on read) so nothing has to
// run a sweeper timer - and an expired hold is NOT a hold: the watchdog gets the body back.
function activeHold () {
  const now = nowFn()
  let best = null
  for (const [token, h] of holds) {
    if (h.until <= now) { holds.delete(token); continue }
    if (!best || h.since < best.since) best = h
  }
  return best
}
function _resetHolds () { holds.clear() }

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
//   run's result  a plain string (what happened, for the log) or { msg, noOp }. `noOp` is the
//             executor's OWN verdict that it ran to completion and the world would not budge -
//             the runner then refuses it until the world changes. It is never inferred from the
//             prose: a regex on a result string could not tell "I tried everything" from "someone
//             stopped me mid-sentence", and at hp 1 / food 0 it latched off the recovery ladder.
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

def({
  name: 'recoveryLadder',
  label: 'recoverFromDegraded',
  tier: 'SURVIVE',
  why: 'the compound-degraded state (naked/starving/hurt at once) runs the R0..R5 ladder',
  refuse: (ctx) => {
    // FIX 3's CONDITION gate. A pass that made NO PROGRESS is not retried until something it
    // depends on has changed: re-deriving an identical plan from an identical world cannot
    // produce a different result, and on 2026-07-20 it produced 41 identical `NOT recovered`
    // passes while the food bar drained. A condition, never a timer.
    const b = ctx.runner.ladderBlock
    if (!b) return null
    const scheduler = require('./scheduler.js') // lazy + PURE (a snapshot in, a string out): no bot, no clock, no cycle at load
    let sig = ''
    try { sig = scheduler.recoverySignature(ctx.s) } catch {}
    if (sig && sig === b.sig) return 'last pass made no progress and nothing has changed since - ' + scheduler.blockerText(b.blockedOn)
    ctx.runner.ladderBlock = null // the world moved: the ladder is live again
    return null
  },
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    const scheduler = require('./scheduler.js')
    const r = await provision.recoverFromDegraded(bot, { say: ctx.say })
    // An INTERRUPTED pass proves nothing about the world, so it must not latch the condition
    // gate either. 'busy'/'stopped'/'deadline' all mean the pass ended for reasons that have
    // nothing to do with whether its rungs could have worked - and on 2026-07-29 21:12 a
    // watchdog-stopped pass latched the ladder off at hp 1 / food 0 / naked, which is the
    // failure this whole gate exists to prevent, arriving from the other direction.
    const interrupted = r.reason === 'stopped' || r.reason === 'busy' || r.reason === 'deadline'
    if (!r.done && !interrupted && r.progressed === false && r.sig) {
      ctx.runner.ladderBlock = { sig: r.sig, blockedOn: r.blockedOn || 'blocked' }
      ctx.note('(sched) ladder BLOCKED on ' + ctx.runner.ladderBlock.blockedOn + ' - ' + scheduler.blockerText(ctx.runner.ladderBlock.blockedOn) + '; standing down until the situation changes')
    } else ctx.runner.ladderBlock = null
    return {
      msg: (r.done ? 'recovered' : 'NOT recovered (' + (r.reason || 'rungs exhausted') + (r.blockedOn ? ', blocked on ' + r.blockedOn : '') + ')') +
                  (r.rungs.length ? ' via ' + r.rungs.join(' > ') : ''),
      // NEVER the generic latch: the ladder's own condition gate (runner.ladderBlock, set above
      // from r.progressed/r.sig) is the authority, and it is set from real per-rung data rather
      // than from whether the pass happened to be interrupted. Two latches on one signature is
      // one rule with two definitions, and the weaker one latched a starving bot's recovery off.
      noOp: false
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
    const r = await provision.secureFood(bot, { home: ctx.knownBed, canHold: true, say: ctx.say })
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
    try { return await provision.recoverHp(bot, { say: ctx.say }) } finally {
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
  holds: { wake: 'dawn' },
  run: async (bot, ctx) => {
    const provision = require('./provision.js')
    const rested = await provision.nightRest(bot, { say: ctx.say })
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
    const rh = await provision.recoverHome(bot, { say: ctx.say, resumeAt: pr && pr.at })
    if (rh.arrived) return 'home' + (rh.bedOk ? ' - spawn re-anchored at the bed' : ' - bed could NOT be re-asserted')
    if (rh.stabilise) return 'stood down mid-crossing (' + (rh.blockedOn || 'blocked') + '): ' + (rh.why || '')
    return 'did not reach home this pass (' + Math.round(rh.dist || 0) + 'b out) - will pick it up again'
  }
})

// -- PROGRESS (chores and re-arming: they yield to a build, and to everything above) --------

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
    const r = await provision.maintenancePass(bot, { say: ctx.say, nightIndoorOnly: !!ctx.s.isNight, bootstrap: (ctx.pick && ctx.pick.bootstrap) || null })
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
    const n = await provision.cookRawMeat(bot, {})
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
  TIER_NAMES,
  tierRank,
  classOf,
  CLASS_OF_TIER,
  BODY_OWNERS,
  ownerInfo,
  bodyRefusal,
  mayTakeBody,
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
