'use strict'
// ==== THE REFUSAL REGISTRY: EVERYTHING THAT MAY SAY "NO" TO A PROPOSAL, IN ONE TABLE ========
// M1 of design-docs/DESIGN-2026-08-25-deadlock-free-arbitration.md §2.1. This file is the ONLY
// place allowed to construct a `held (...)` / `PREEMPT (...)` / `BLOCKED (...)` verdict for a
// brain command; gatetest.js fails the build if that literal grows back anywhere else.
//
// WHY THIS FILE EXISTS. The bot had two arbiters. scheduler-core.js is one: total over its
// candidate set, feeding refusals back in-tick, with a terminal floor that cannot itself refuse.
// The other was a nine-branch if-stack in the /cmd handler (index.js:2676-2825 at 6823533),
// and it had neither a floor nor feedback - a refused brain command simply evaporated
// (`return send(res, 200, ...)`, no successor, nothing recorded, nothing re-chosen). Two total
// decision functions over disjoint proposal sets are NOT a total function over the union, which
// is why the machine could deadlock while every layer in it was working as designed.
//
// THE INCIDENT THAT NAMES THIS FILE (2026-08-25, the operator's real server, verified on the
// tape). The bot was naked, hp 20, food 20, sealed in a bunker it had dug itself, with a saved
// castle job on disk whose own bill of materials read `reconcile: ... gather:cobblestone,
// gather:raw_iron, ... craft:iron_boots`. A player sealed in a stone bunker at night mines from
// inside the bunker. The brain proposed exactly that, over and over:
//   19:35:57 (cmd) mine 23 64 -13 «need to get materials to craft armor»
//            -> held (a build job is waiting - one job at a time)              x21
//   21:53:44 (cmd) stop «gearup failed, need to reset»
//            -> held (a saved build job exists - the brain may not cancel it)
// The refusal was issued ON BEHALF OF a build whose gearup was FAIL-JOBing every 93 seconds,
// against a command that was on that build's own need list. It was not merely unhelpful; it was
// factually wrong under the refuser's own principal's plan - and no code path could know that,
// because the if-stack read `persistedResume()` and nothing else. Three and a half hours, three
// supervisor restarts, zero armor, zero deltas.
//
// WHAT M1 CHANGES: nothing. This is the extraction, and its whole value is that it is provably
// inert - gatetest.js sweeps the entire input space against a verbatim transcription of the
// if-stack it replaces, and replays every `held (...)`/`PREEMPT (...)` line in both event logs
// (~1600 of them) through the table. What it BUYS is that every refusal now has to declare, as
// data that a test can read:
//   principal  - whose interest it serves (and therefore whose evidence it lives on)
//   successor  - what happens INSTEAD, because a refusal that names no successor is a decision
//                that produces no action (#5), which is what evaporated 21 times that night
//   voidWhen   - the lease condition: a gate is only a refusal while its principal is actually
//                progressing. DECLARED HERE, EVALUATED IN M3 (except where noted per row).
//   escalation - for the two rows that guard the OPERATOR rather than a job: those never void
//                on the bot's own judgement, they escalate. ([[operator-stop-is-sacred]])
// M2 returns refusals to the brain as data; M3 lands `cmdServesNeed` + `voidWhen`, which is what
// actually makes the incident above inexpressible. Neither is here. Do not add them here early.
//
// SHAPE. Two halves, deliberately: the ROWS are PURE over (proposal, snapshot) - no clock, no
// bot, no require of anything heavy - and the SNAPSHOT is the impure half, assembled lazily from
// callbacks the caller injects. The laziness is not an optimisation: `bodyOwner()` REVOKES
// expired claims as a side effect, and the if-stack did not call it for a command the confinement
// or saved-build rows rejected. Fields are therefore materialised in exactly the order, and under
// exactly the conditions, the if-stack materialised them - see SCOPES below.

const access = require('./access.js')
const arbiter = require('./arbiter.js')

// ---- the verb vocabularies, moved verbatim from index.js at 6823533 ------------------------
// Pinned byte-for-byte by gatetest.js: these regexes ARE the behaviour, and a silently widened
// one is a new gate wearing the old one's name.
const CHEAT_RE = access.CHEAT_CMDS                 // index.js:2678 - one definition, already in access.js
const STOP_RE = /^stop\b/i                         // index.js:2698
const DEFENSE_RE = /^(attack|defend)\b/i           // index.js:2757
const SIDE_TRIP_RE = /^(goto|travel|explore|collect|gather|mine|chop|dig|follow|come|build)\b/i // index.js:2822

// ---- who holds the body, for THIS gate (index.js:2721-2728, ROOT C + review D2) ------------
// The same four latches, in the same order, read ONCE - and each one has to still hold a LIVE
// claim, because a latch cannot say whether it is still alive. `held (busy building+securing
// food)` printed 110 times on 2026-08-03 on behalf of a food run abandoned at 16:54:51. The SET
// is unchanged (these four, in this order, and nothing else gates a brain command); it lives here
// now so the rows that refuse on its behalf can NAME it in their `principal` and a test can check
// that the name and the reading are the same list.
const BODY_HOLD_LATCHES = [
  ['busy building', 'job'],
  ['night-resting', 'shelter'],
  ['securing food', 'foodRun'],
  ['recovering-degraded', 'ladder']
]
const BODY_HOLD_PRINCIPALS = BODY_HOLD_LATCHES.map(([, key]) => key)
// The label shapes the sweep exercises, DERIVED from the table above. Re-typing a label here
// would be the second definition ROOT C deleted - 'night-resting' as an assumed else-branch
// printed 53 times about a bed that was never the problem.
const LABEL_SHAPES = ['unlabeled-hold', ...BODY_HOLD_LATCHES.map((_, i) => BODY_HOLD_LATCHES.slice(0, i + 1).map(([l]) => l).join('+'))]

// ---- the successor sinks -------------------------------------------------------------------
// A successor names what happens INSTEAD of the refused proposal. Most name a row in the reflex
// registry (the thing that will run). Two cannot, and both are terminal by construction - they
// are where the successor graph grounds out, and gatetest.js proves every path reaches one:
//   'self'      the proposal itself runs. This is what a PREEMPT arm's successor IS: the arm does
//               not refuse anything, it revokes a hold so the incoming command can own the body.
//   'operator'  a human does it. The only honest successor for the CHEAT confinement: world-edit
//               and admin verbs are performed by the operator in-game, never by the brain.
const SINKS = ['self', 'operator']

// ---- the snapshot's declared field list -----------------------------------------------------
// Every field a row may read, with the boundary values gatetest.js sweeps. A row that touches a
// field it did not declare in `reads` is a red test: enumeration is only feasible because the
// declared surface is small (3-5 fields a row), and it is only SOUND because the declaration is
// enforced rather than trusted.
const SNAPSHOT_FIELDS = {
  cheatsAllowed: [false, true],                    // BRAIN_ALLOW_CHEATS === '1'
  persistedBuild: [null, { name: 'castle', at: { x: 430, y: 67, z: 85 } }],
  bodyBusy: [false, true],
  holdLabel: LABEL_SHAPES,                         // derived below - never a re-typed label literal
  defendWhenHit: [false, true],                    // DEFEND_WHEN_HIT !== '0'
  beingHit: [false, true],
  postDeathLatch: [false, true],
  recoveryMoveCmd: [false, true],
  adm: [null, { allow: true, reason: 'hp 4 <= 8' }, { allow: false, reason: 'no survival need and no grave in reach - not interrupting the build' }],
  holdAdm: [{ ok: true, reason: 'no crisis' }, { ok: false, reason: 'threat (hostile 3.2b) outranks the shelter hold' }]
}
// Everything a row may read off the PROPOSAL. Classification is the caller's job (it already
// owns `commandClass`, and the class is read again after the gate) - the table's job is the
// verdict, not the vocabulary.
const PROPOSAL_FIELDS = {
  trimmed: ['stop', 'mine 23 64 -13', 'goto 100 64 100', 'attack zombie', 'recover', 'state', 'say hi', 'gamemode creative'],
  fromSupervisor: [false, true],
  readOnly: [false, true],
  survival: [false, true]
}

// ============ THE TABLE ======================================================================
// ORDER IS BEHAVIOUR. The rows are evaluated top to bottom within their scope and the FIRST that
// applies wins, which is how the if-stack's `else if` chain read. Do not reorder without a live
// tape that says why.
const ROWS = [
  // ---- scope: pre-body. Decided before the body registry is read at all. -------------------
  {
    key: 'cheatConfinement',
    scope: 'pre-body',
    verdict: 'block',
    guards: 'operator-intent',
    principal: 'operator',
    // BRAIN CONFINEMENT (index.js:2676-2681): block world-editing/admin commands on the API path
    // so the autonomous brain can't grief or dupe. Operators use in-game !commands. The
    // supervisor header does NOT get past this one - defense in depth, deliberately.
    reads: ['trimmed', 'cheatsAllowed'],
    applies: (p, s) => !s.cheatsAllowed && CHEAT_RE.test(p.trimmed),
    refusal: 'world-edit/admin is operator-only',
    reply: 'blocked: world-editing/admin commands are operator-only',
    successor: 'operator',
    // §2.3: an operator-intent gate never voids on the bot's own judgement. This one never
    // escalates either - there is no stage of desperation at which the brain may run `give`.
    escalation: 'never'
  },
  {
    key: 'stopSavedBuild',
    scope: 'pre-body',
    verdict: 'refuse',
    guards: 'operator-intent',
    principal: 'operator',
    // THE BUSY-GAP LOOPHOLE (index.js:2694-2701): between build phases isBusy() is briefly false,
    // and the brain's `stop` slipped through and CLEARED the persisted castle job ("can't recover,
    // stuck in maze" -> stopped, live). While a saved build job exists on disk the brain's stop is
    // always suppressed - that file is operator intent. A real OPERATOR's "stop" still works: it
    // comes through the bot.on('chat') directCommand path and never reaches this table at all.
    reads: ['trimmed', 'fromSupervisor', 'persistedBuild'],
    applies: (p, s) => !p.fromSupervisor && STOP_RE.test(p.trimmed) && !!s.persistedBuild,
    refusal: 'a saved build job exists - the brain may not cancel it',
    reply: "held: there's a build to finish - i shouldn't stop it",
    // What happens instead of stopping: the saved build resumes. That is a real, named owner.
    successor: 'build',
    // §2.3: PARK, never delete - the same semantics the supervisor stop already has ("castle stays
    // saved ... resumebuild to continue"). Declared here; the ratchet that fires it is M5 and needs
    // the operator's sign-off. NOT implemented.
    escalation: 'park'
  },

  // ---- scope: body-hold. The four PREEMPT arms and the two holds. ---------------------------
  // Reached only when a live claim holds the body and the command is neither read-only nor from
  // the supervisor - see SCOPES. The arms do not refuse; they revoke the hold so the proposal can
  // run. They are in the table because "who may override a refusal" is exactly as much a part of
  // the arbitration as the refusal, and it drifted for months while it was four `else if`s.
  {
    key: 'defendUnderAttack',
    scope: 'body-hold',
    verdict: 'preempt',
    guards: 'survival-floor',
    principal: 'self',
    // fix #15 Piece D (index.js:2751-2758): being actively DAMAGED is a survival situation. The
    // 18:27 death is a tape of every attack/defend logging `held (night-resting)` while a zombie
    // beat the bot. Checked BEFORE the survival-class check. The 8s beingHitNow() window bounds it.
    // attack/defend stay 'progress' class in scheduler.js - no reclassify.
    reads: ['trimmed', 'defendWhenHit', 'beingHit', 'holdLabel'],
    applies: (p, s) => s.defendWhenHit && DEFENSE_RE.test(p.trimmed) && s.beingHit,
    refusal: 'under attack',
    tail: (p, s) => ` - defense outranks the ${s.holdLabel} hold`,
    preempt: true,
    successor: 'self'
  },
  {
    key: 'postDeathRecoveryMove',
    scope: 'body-hold',
    verdict: 'preempt',
    guards: 'survival-floor',
    principal: 'self',
    // #41 P0.4 (index.js:2759-2765): while the post-death recovery latch is set, recovery-class
    // commands are NOT muzzled by the busy-gate. RC-A: `goto home` / `recover` / `retreat` were all
    // held "busy building" while the build dragged the naked bot back across the map.
    reads: ['postDeathLatch', 'recoveryMoveCmd', 'holdLabel'],
    applies: (p, s) => s.postDeathLatch && s.recoveryMoveCmd,
    refusal: 'post-death recovery',
    tail: (p, s) => ` - recovery outranks the ${s.holdLabel} hold`,
    preempt: true,
    successor: 'self'
  },
  {
    key: 'survivalOutranksHold',
    scope: 'body-hold',
    verdict: 'preempt',
    guards: 'survival-floor',
    principal: 'self',
    // S1 HOTFIX / S4 (index.js:2738-2750, 2768): survival-class commands preempt the body's own
    // hold. The live freeze it bought: `recover`/`eat`/`wear` suppressed for 8+ minutes at 1hp and
    // food 0 while the famine-hold sat inside `_securingFood` with iron in a grave 3 blocks away.
    // `adm` still requires a REAL need or a near grave, so a whimsical gearup at full health while
    // a build runs is still HELD - by noSurvivalNeed below, with the scheduler's greppable reason.
    reads: ['survival', 'adm'],
    applies: (p, s) => p.survival && s.adm.allow,
    refusal: (p, s) => s.adm.reason,
    tail: ' - survival outranks the current hold',
    preempt: true,
    successor: 'self'
  },
  {
    key: 'crisisOutranksHold',
    scope: 'body-hold',
    verdict: 'preempt',
    guards: 'survival-floor',
    principal: 'self',
    // #113 CRISIS_OUTRANKS_PEACETIME (index.js:2792-2801): the only thing that reaches here is a
    // command the verb/label machinery above was about to suppress. It may not be suppressed while
    // a strictly-worse crisis is live - the 15:51 tape is four `goto hut «get out of water»`
    // answered `held (securing food)` and then a corpse. Admissibility comes from the arbiter's
    // live need tier, never from the verb or the label, so lava/fire/critical-hp/threat are all
    // covered identically and there is no water special case.
    reads: ['holdAdm'],
    applies: (p, s) => !s.holdAdm.ok,
    refusal: 'crisis',
    tail: (p, s) => ` - ${s.holdAdm.reason}`,
    preempt: true,
    successor: 'self'
  },
  {
    key: 'noSurvivalNeed',
    scope: 'body-hold',
    verdict: 'refuse',
    guards: 'principal',
    // The principal is whichever of the four latches above holds a LIVE claim; holdLabel names it
    // in the log line. Declared as the set because the gate reads the set - naming one of them
    // statically would be a second, drifting definition of who this refusal serves.
    principal: BODY_HOLD_PRINCIPALS,
    // index.js:2803, the survivalCmd half of the else. A survival-class command that the scheduler
    // says is NOT admissible right now: no real need, no grave in reach.
    reads: ['survival', 'adm'],
    applies: (p, s) => p.survival,
    refusal: (p, s) => 'no survival need: ' + s.adm.reason,
    tail: ' - brain command suppressed',
    reply: "busy building right now - I'll hold until it's done",
    busyReply: true,
    // What happens instead: the claim that holds the body carries on with its work. It is a SET
    // for the same reason the principal is - the gate is held by whichever of the four latches
    // is live, and holdLabel names it in the line. A single static name here would be a lie in
    // three cases out of four, which is exactly the class of thing #7 forbids.
    successor: BODY_HOLD_PRINCIPALS,
    // ALREADY LIVE for this row, unlike oneJobAtATime below: `bodyBusy` is computed from
    // claimInfo(key) && !c.stalled (review D2), so a hold whose lease has expired is not a hold and
    // this row never fires for it. Declared so the schema check can see one definition of the rule.
    voidWhen: 'principalStalled'
  },
  {
    key: 'bodyHold',
    scope: 'body-hold',
    verdict: 'refuse',
    guards: 'principal',
    principal: BODY_HOLD_PRINCIPALS,
    // index.js:2803, the non-survival half of the else - the plain progress-class suppression, and
    // the floor of this scope: together with noSurvivalNeed it partitions the scope on p.survival,
    // so the body-hold scope is TOTAL. Every command that reaches it gets a verdict.
    reads: ['survival', 'holdLabel'],
    applies: (p, s) => !p.survival,
    refusal: (p, s) => s.holdLabel,
    tail: ' - brain command suppressed',
    reply: "busy building right now - I'll hold until it's done",
    busyReply: true,
    successor: BODY_HOLD_PRINCIPALS, // as above: the live hold, not a guess at which one
    voidWhen: 'principalStalled'
  },

  // ---- scope: idle. The body is free but a job is saved. -------------------------------------
  {
    key: 'oneJobAtATime',
    scope: 'idle',
    verdict: 'refuse',
    guards: 'principal',
    principal: 'build',
    // ONE JOB AT A TIME (index.js:2817-2825, operator order): while a saved build job exists the
    // brain may not wander the body off on side-trips in the idle gap before the resume re-arms -
    // it walked 240 blocks from the site that way, live. Survival, perception and chat stay
    // allowed; everything that MOVES is held.
    //
    // AND THIS IS THE ROW THAT FIRED 21 TIMES ON 2026-08-25 AGAINST THE BUILD'S OWN SHOPPING LIST.
    // Read the header. The fix is M3's `cmdServesNeed` (a proposal whose product is on the active
    // job's reconcile list IS the job, not a competitor) plus `voidWhen` actually being evaluated
    // (a build that is FAIL-JOBing every 93s is not a principal in good standing). NEITHER IS HERE.
    // M1 changes nothing about when this row fires; it only makes the row say, in data, what it is
    // refusing on behalf of and what it expects to happen instead - which is what makes the lie
    // checkable.
    reads: ['trimmed', 'persistedBuild'],
    applies: (p, s) => !!s.persistedBuild && SIDE_TRIP_RE.test(p.trimmed),
    refusal: 'a build job is waiting - one job at a time',
    reply: 'held: i have a build to get back to - no side trips',
    successor: 'build',
    // DECLARED, NOT EVALUATED (M3). Written down now so the gap between what this row claims to be
    // and what it does is a thing the next reader can see rather than infer.
    voidWhen: 'principalStalled'
  }
]

// ============ SCOPES: the if-stack's three landings, as data ==================================
// The if-stack had three levels and each level's ENTRY CONDITION was arbitration too. Written once
// here rather than repeated in seven `applies`:
//   pre-body   everything, before the body registry has been touched at all
//   body-hold  `if (bodyBusy && !readOnly && !fromSupervisor)`   (index.js:2737 at 6823533)
//   idle       `if (!bodyBusy && ...)`                           (index.js:2821 at 6823533)
// `guard` reading `s.bodyBusy` first is load-bearing: touching that field is what runs bodyOwner()
// (which revokes expired claims and logs), and the if-stack ran it there - after the confinement
// and saved-build rows, before everything else.
const SCOPES = [
  { key: 'pre-body', reads: [], guard: () => true },
  {
    key: 'body-hold',
    reads: ['bodyBusy', 'readOnly', 'fromSupervisor'],
    guard: (p, s) => s.bodyBusy && !p.readOnly && !p.fromSupervisor,
    // The if-stack computed `adm` and `holdAdm` EAGERLY at the top of the block, before it tested
    // any arm - so `await provision.schedulerState(bot)` and `provision.survivalNeed(bot)` ran for
    // every command that reached it, including ones a PREEMPT arm above then won. Materialising
    // them lazily would silently delete those reads for those commands. This is the ONE place that
    // knows they are eager, and it is the field's own definition (`survivalCmd ? ... : null`), not
    // a second copy of any row's condition.
    enter: async (p, s) => { if (p.survival) await s.loadAdm(); s.materialise('holdAdm') }
  },
  { key: 'idle', reads: ['bodyBusy'], guard: (p, s) => !s.bodyBusy }
]

// ============ THE SNAPSHOT: the impure half ===================================================
// Lazy and memoised, per field. Every reader is injected - this file requires nothing that can
// see the bot, so the table is testable with a plain object and the evaluator has no way to grow
// a hidden world read.
function snapshot (p, ctx) {
  const cell = {}
  const s = {}
  const lazy = (name, read) => Object.defineProperty(s, name, {
    enumerable: true,
    get () { if (!(name in cell)) cell[name] = read(); return cell[name] }
  })

  lazy('cheatsAllowed', () => !!ctx.cheatsAllowed())
  lazy('persistedBuild', () => { try { return ctx.persistedResume() || null } catch { return null } })
  // ONE read of the four latches, through the claim registry, with the write-through first
  // (index.js:2720-2728). bodyBusy and holdLabel derive from the SAME reading, so the label can
  // only ever name a latch that is actually set AND still holds a live claim.
  lazy('_hold', () => {
    try { ctx.syncClaims() } catch { /* the registry itself failing must never immobilise the bot */ }
    return BODY_HOLD_LATCHES
      .filter(([, key]) => { try { const c = ctx.claimInfo(key); return !!c && !c.stalled } catch { return false } })
      .map(([label]) => label)
  })
  lazy('bodyBusy', () => s._hold.length > 0)
  lazy('holdLabel', () => s._hold.join('+') || 'unlabeled-hold')
  lazy('defendWhenHit', () => !!ctx.defendWhenHit())
  lazy('beingHit', () => !!ctx.beingHit())
  lazy('postDeathLatch', () => !!ctx.postDeathLatch())
  lazy('recoveryMoveCmd', () => !!ctx.recoveryMoveCmd(p.trimmed))
  // The arbiter's answer to "may this hold keep the body while THAT is happening": the most urgent
  // need any of the three survival latches is serving, against the live crisis. A hold that serves
  // no survival need (a build/gather) is deliberately absent from the list - it ranks as null.
  lazy('holdAdm', () => {
    const need = ctx.holdNeeds().sort((a, b) => arbiter.needRank(a) - arbiter.needRank(b))[0] || null
    const crisis = (() => { try { return ctx.liveCrisis() } catch { return null } })()
    return arbiter.holdAdmissible(crisis, need)
  })
  // The one ASYNC field. `null` unless the scope's enter() materialised it, which mirrors the
  // if-stack's `const adm = survivalCmd ? ... : null` exactly.
  cell.adm = null
  Object.defineProperty(s, 'adm', { enumerable: true, get () { return cell.adm } })
  s.loadAdm = async () => { cell.adm = await ctx.admissible(p.trimmed, s.postDeathLatch) }
  // Force a lazy field now rather than at first read. Only a scope's enter() uses this, and
  // only for the two fields the if-stack computed eagerly - see SCOPES.
  s.materialise = name => s[name]
  return s
}

// ============ THE EVALUATOR ===================================================================
// `text` is the whole verdict as it reaches the log: `<verb> (<refusal>)<tail>`. The verb is
// derived from the row's declared verdict, never re-typed per row.
const VERBS = { block: 'BLOCKED', refuse: 'held', preempt: 'PREEMPT' }
const call = (v, p, s) => (typeof v === 'function' ? v(p, s) : v)

function render (row, p, s) {
  return {
    key: row.key,
    row,
    verdict: row.verdict,
    text: `${VERBS[row.verdict]} (${call(row.refusal, p, s)})${call(row.tail, p, s) || ''}`,
    reply: row.reply == null ? null : row.reply,
    preempt: !!row.preempt,
    busyReply: !!row.busyReply,
    successor: row.successor
  }
}

// PURE over an already-materialised snapshot: the first row of `scope` that applies, or null.
// Exported so the offline sweep can drive the table without a bot.
function evaluate (p, s, scopeKey) {
  for (const row of ROWS) {
    if (row.scope !== scopeKey) continue
    if (row.applies(p, s)) return render(row, p, s)
  }
  return null
}

// THE ONE ENTRY POINT. Returns a verdict, or null when nothing refuses and the command runs.
// The caller owns the EFFECTS (log the text, preempt, answer the HTTP request) - this owns the
// decision. That split is the point: an effect is easy to read, a decision buried in an effect is
// what took nine branches and three post-mortems to find.
async function decide (p, ctx) {
  const s = snapshot(p, ctx)
  for (const scope of SCOPES) {
    if (!scope.guard(p, s)) continue
    if (scope.enter) await scope.enter(p, s)
    const v = evaluate(p, s, scope.key)
    if (v) return v
  }
  return null
}

module.exports = {
  ROWS,
  SCOPES,
  SINKS,
  SNAPSHOT_FIELDS,
  PROPOSAL_FIELDS,
  BODY_HOLD_LATCHES,
  BODY_HOLD_PRINCIPALS,
  CHEAT_RE,
  STOP_RE,
  DEFENSE_RE,
  SIDE_TRIP_RE,
  snapshot,
  evaluate,
  decide
}
