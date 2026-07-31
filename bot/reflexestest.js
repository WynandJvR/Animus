'use strict'
// ==== CONTRACT TESTS FOR THE REFLEX REGISTRY (design-docs/PLAN-one-runner.md §5) ===========
// These are the durable part of the one-runner work. They do not sample behaviour; they
// ENUMERATE the registry against the things that must agree with it, so the next gap is a red
// test instead of a bot standing still (the bot/capabilitytest.js pattern, applied to who owns
// the body instead of to what the bot can make).
//
// The four contracts, verbatim from the plan:
//   1. Every registered proposal has a `tier` in arbiter.PRIORITY - no second vocabulary.
//   2. No body-moving proposal reads another's latch directly (a grep-assert on reflexes.js).
//   3. For every proposal, when() true + runner idle => it is dispatched, or a refusal is logged.
//   4. A declared hold is never counted as a stall by scheduler.watchdog.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const arbiter = require('./arbiter.js')
const reflexes = require('./reflexes.js')
const scheduler = require('./scheduler.js')
const core = require('./scheduler-core.js')

let pass = 0
let fail = 0
function t (name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)) }
}
const srcOf = f => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n') // CRLF-normalised: this repo checks out CRLF and it has burned two source-pinning tests

console.log('reflexes: the one-runner contract')

// ============ CONTRACT 1 - one tier vocabulary ============================================
t('1: every proposal declares a tier that IS an arbiter.PRIORITY name', () => {
  assert(reflexes.REFLEXES.length > 0, 'the registry is empty - this whole suite would be vacuous')
  for (const r of reflexes.REFLEXES) {
    assert(Object.prototype.hasOwnProperty.call(arbiter.PRIORITY, r.tier), `${r.name}: tier "${r.tier}" is not one of ${Object.keys(arbiter.PRIORITY).join('/')}`)
    assert.strictEqual(reflexes.tierRank(r.tier), arbiter.PRIORITY[r.tier], `${r.name}: tierRank disagrees with the arbiter`)
  }
})

t('1: the tier scale is the arbiter\'s OBJECT, not a copy of its values', () => {
  assert.strictEqual(reflexes.TIERS, arbiter.PRIORITY, 'TIERS must BE arbiter.PRIORITY - a copy is a second vocabulary waiting to drift')
})

t('1: every tier maps to exactly one scheduler job class, in one place', () => {
  const classes = new Set(Object.keys(scheduler.JOB_CLASSES))
  for (const tier of Object.keys(arbiter.PRIORITY)) {
    const cls = reflexes.classOf(tier)
    assert(classes.has(cls), `tier ${tier} maps to job class "${cls}", which scheduler.JOB_CLASSES does not have`)
  }
  // and the mapping is used, not merely present: a SURVIVE proposal must land in the survival class
  assert.strictEqual(reflexes.classOf('SURVIVE'), 'survival')
  assert.strictEqual(reflexes.classOf('IDLE'), 'idle')
})

// ============ CONTRACT 2 - a proposal never reads another's latch =========================
// This is the O(n^2) coupling the registry exists to remove. If a latch name ever appears in
// reflexes.js outside a comment, the guard stacks have started growing back.
t('2: no body latch is read anywhere in reflexes.js', () => {
  const src = srcOf('reflexes.js')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)) // drop comment-only lines; the header NAMES these latches on purpose
    .join('\n')
  const LATCHES = ['isBusy', 'isResting', 'isSecuringFood', 'isRecoveringDegraded', 'isRecoveringHp',
    'isMaintaining', 'isRecovering', 'isForceUnsticking', 'isNavigating', 'maneuverActive', 'isSheltering']
  const found = LATCHES.filter(l => new RegExp('\\b' + l + '\\s*\\(').test(src))
  assert.deepStrictEqual(found, [], 'reflexes.js reads body latches directly: ' + found.join(', ') + ' - arbitration belongs to the runner, once')
  // isEscaping is the ONE exception and it must stay a single, named use: reclaim passes it as
  // its isStopped so a long sweep unwinds when an escape takes the body. It is not a gate.
  const escaping = (src.match(/isEscaping/g) || []).length
  assert(escaping <= 2, 'isEscaping is only allowed as reclaim\'s isStopped handle (found ' + escaping + ' uses)')
})

t('2: reflexes.js requires nothing heavy at load - arbiter only', () => {
  const src = srcOf('reflexes.js')
  const top = src.split('\n').filter(l => /^const .*= require\(/.test(l))
  assert.deepStrictEqual(top.map(l => (l.match(/require\('([^']+)'\)/) || [])[1]), ['./arbiter.js'],
    'a top-level require here is a load-order cycle waiting to happen; executors require lazily inside run()')
})

// ============ CONTRACT 3 - a proposal is dispatched, or it refuses out loud ================
t('3: every proposal either RUNS or names an owner that runs', () => {
  const orphans = []
  for (const r of reflexes.REFLEXES) {
    if (typeof r.run === 'function') continue
    if (!r.owner) { orphans.push(r.name + ' (no run, no owner)'); continue }
    const owner = reflexes.get(r.owner)
    if (!owner || typeof owner.run !== 'function') orphans.push(r.name + ' -> ' + r.owner + ' (owner cannot run either)')
  }
  assert.deepStrictEqual(orphans, [], 'proposals that decide nothing can act on: ' + orphans.join(', '))
})

t('3: every job the CHOOSERS can emit is a registered proposal (or a declared reflex owner)', () => {
  // Enumerated, not sampled: drive both choosers over a spread of snapshots and collect every
  // job name they can produce. This is capabilitytest.js ITEM 2's question, asked of the
  // registry (data) instead of of a chain of `if`s in index.js (source).
  const jobs = new Set()
  const DIMS = {
    hp: [20, 8, 3], food: [20, 12, 2], armorPieces: [4, 0], isNight: [false, true],
    homeDist: [null, 10, 140, 460], underArmored: [false, true],
    persistedBuild: [false, true], postDeathRecovery: [false, true],
    maintainNeeded: [false, true], spawnAnchored: [false, true],
    graves: [[], [{ dist: 8, value: 30, tier: 'normal' }]],
    debt: [{ value: 0, n: 0, best: null }, { value: 200, n: 9, best: { dist: 12, n: 4, kind: 'shaft' } }]
  }
  const keys = Object.keys(DIMS)
  const total = keys.reduce((a, k) => a * DIMS[k].length, 1)
  for (let i = 0; i < total; i++) {
    const s = { vitalsKnown: true }
    let rest = i
    for (const k of keys) { const vals = DIMS[k]; s[k] = vals[rest % vals.length]; rest = Math.floor(rest / vals.length) }
    s.homeReachable = s.homeDist != null && s.homeDist <= 48
    for (const pick of [scheduler.pickJob(s), core.chooseActivity(s, {}), core.chooseActivity(s, { refused: new Map(reflexes.names().map(n => [n, 'x'])) })]) {
      if (pick && pick.job) jobs.add(pick.job)
    }
  }
  const known = new Set(reflexes.names())
  const reflexOwned = new Set(scheduler.REFLEX_OWNED)
  // The PROGRESS tail (build / resume / the brain's own job) is not the runner's to dispatch:
  // the body already owns that goal and the tick's non-survival arm hands it straight back.
  // Same exemption capabilitytest.js ITEM 2 makes, for the same reason.
  const TAIL_JOBS = new Set(['build', 'brainJob', 'autobuild'])
  const unknown = [...jobs].filter(j => !known.has(j) && !reflexOwned.has(j) && !TAIL_JOBS.has(j))
  assert.deepStrictEqual(unknown, [], 'jobs a chooser can emit with no row in the registry: ' + unknown.join(', '))
  // and the spread must actually reach the interesting ones, or the assertion above is vacuous
  for (const j of ['recoveryLadder', 'nightShelter', 'graveSweep', 'maintenancePass', 'homecoming', 'reclaim']) {
    assert(jobs.has(j), `the chooser spread never produced "${j}" - widen the dimensions or this test proves nothing`)
  }
})

t('3: a refusal is a REASON, never a bare true/false', () => {
  const ctx = {
    s: { isNight: true, homeDist: 400, hp: 20, food: 20, armorPieces: 4, vitalsKnown: true },
    now: 1000, nowMs: () => 1000, foodThreshold: 10, progressFoodMin: 14,
    runner: { graveCooldownUntil: 9e9, hpCooldownUntil: 9e9, maintainCooldownUntil: 9e9, ladderBlock: null }
  }
  let checked = 0
  for (const r of reflexes.REFLEXES) {
    if (typeof r.refuse !== 'function') continue
    const why = r.refuse(ctx)
    if (why == null) continue
    checked++
    assert.strictEqual(typeof why, 'string', r.name + ': a refusal must be a sentence naming the blocker')
    assert(why.length > 12, r.name + ': "' + why + '" does not name a blocker a log reader could act on')
  }
  assert(checked >= 3, 'the fixture must actually trip some refusals (tripped ' + checked + ')')
})

t('3: refuse() is pure - the same ctx twice gives the same answer, and nothing is mutated', () => {
  const mk = () => ({
    s: { isNight: true, homeDist: 400, hp: 20, food: 20, armorPieces: 4, vitalsKnown: true },
    now: 1000, nowMs: () => 1000, foodThreshold: 10, progressFoodMin: 14,
    runner: { graveCooldownUntil: 9e9, hpCooldownUntil: 9e9, maintainCooldownUntil: 9e9, ladderBlock: null }
  })
  for (const r of reflexes.REFLEXES) {
    if (typeof r.refuse !== 'function') continue
    const a = mk(); const b = mk()
    assert.strictEqual(r.refuse(a), r.refuse(b), r.name + ': refuse() is not deterministic')
    assert.deepStrictEqual(a.s, b.s, r.name + ': refuse() mutated the snapshot')
  }
})

// ============ the no-op verdict is the EXECUTOR's, never a regex on its prose ==============
// Live 2026-07-29 21:12, at hp 1 / food 0 / naked:
//   (sched) recoverFromDegraded -> NOT recovered (stopped, blocked on no-progress)
//   (sched) recoverFromDegraded achieved nothing - not re-dispatching it until the situation changes
//   (core) chose build/idle: CRISIS UNANSWERED (...) - doing what i can instead: resuming the build
// The ladder had been STOPPED by the watchdog's own fail-job lever. An interrupted pass proves
// NOTHING about the world, and the regex could not tell that from "I tried everything".
t('no-op: the runner latches on the executor\'s verdict, not on the shape of its sentence', () => {
  const src = srcOf('index.js')
  assert(!/NOOP_RE\s*=/.test(src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')), 'the prose regex is DELETED, not merely bypassed')
  assert(/if \(obj && r\.noOp === true\)/.test(src), 'the latch reads an explicit verdict off the result')
  assert(/runner\.noOp\.clear\(\)/.test(src), 'and crisis vitals clear it, like every other stale back-off')
})

t('no-op: an INTERRUPTED job never latches - not the ladder, not the food run', () => {
  // the two transient blockers, pinned by name in the executors that produce them
  const food = String(reflexes.get('secureFood').run)
  assert(/blockedOn === 'busy'/.test(food) && /blockedOn === 'stopped'/.test(food), 'secureFood must exempt busy/stopped')
  assert(/noOp: !r\.fed && !interrupted/.test(food), 'and latch only on a real world blocker')
  const ladder = String(reflexes.get('recoveryLadder').run)
  assert(/r\.reason === 'stopped'/.test(ladder), 'the ladder must exempt a stopped pass from its condition gate')
  assert(/noOp: false/.test(ladder), 'and never arm the generic latch - runner.ladderBlock is its authority')
})

t('no-op: every executor that CAN latch says so from data, not from a string it built', () => {
  for (const r of reflexes.dispatchable()) {
    const src = String(r.run)
    if (!/noOp/.test(src)) continue
    assert(!/noOp:\s*\/|noOp:\s*.*\.test\(/.test(src), r.name + ': a no-op verdict must not be computed by matching text')
  }
})

// ============ THE ORDERING RULE (what replaced the guard stacks) ==========================
t('ordering: a proposal takes the body only from a lower tier - and a crisis is the one exception', () => {
  const crisis = { crisis: true }
  assert(reflexes.mayTakeBody('SURVIVE', 'walk'), 'a survival need must be able to interrupt a bare walk')
  assert(reflexes.mayTakeBody('SURVIVE', 'maintain'), 'a survival need must be able to interrupt chores')
  assert(!reflexes.mayTakeBody('SURVIVE', 'job'), 'single-goal discipline: a build is not interrupted for non-crisis survival work')
  assert(reflexes.mayTakeBody('SURVIVE', 'job', crisis), '...but a CRISIS-grade need preempts the build')
  assert(!reflexes.mayTakeBody('SURVIVE', 'shelter'), 'two SURVIVE claimants must not alternate (audit LOOP C)')
  assert(reflexes.mayTakeBody('SURVIVE', 'shelter', crisis), '...unless something strictly worse is live (#113)')
  assert(!reflexes.mayTakeBody('SURVIVE', 'ladder'), 'the recovery ladder owns the body while it runs')
  assert(!reflexes.mayTakeBody('SURVIVE', 'ladder', crisis), 'and a hard owner is not yielded even to a crisis - it IS the crisis response')
  assert(!reflexes.mayTakeBody('PROGRESS', 'job'), 'chores yield to a running job (single-goal discipline)')
  assert(!reflexes.mayTakeBody('PROGRESS', 'shelter'), 'chores yield to sheltering')
  assert(!reflexes.mayTakeBody('PROGRESS', 'walk'), 'chores never yank an active walk')
  assert(!reflexes.mayTakeBody('IDLE', 'walk'), 'idle housekeeping never yanks an active walk')
  assert(reflexes.mayTakeBody('IDLE', null), 'an idle body is free for housekeeping')
  assert(reflexes.mayTakeBody('PROGRESS', null))
})

t('ordering: NOTHING preempts itself, crisis or not (found live, 90s after the runner went in)', () => {
  // A build's own gather loop had called secureFood, so the food-run latch was set; food hit 9,
  // the crisis-grade rule let secureFood preempt secureFood, the second copy returned instantly
  // and armed the no-op latch - which would then have suppressed the REAL food response.
  assert(!reflexes.mayTakeBody('SURVIVE', 'foodRun', { crisis: true, name: 'secureFood' }), 'secureFood must not preempt a running food run')
  assert(!reflexes.mayTakeBody('SURVIVE', 'shelter', { crisis: true, name: 'nightShelter' }), 'nightShelter must not preempt itself')
  assert(!reflexes.mayTakeBody('PROGRESS', 'maintain', { name: 'maintenancePass' }), 'the maintenance pass must not preempt itself')
  // ...and a DIFFERENT survival job still may, which is the whole point of the crisis override
  assert(reflexes.mayTakeBody('SURVIVE', 'foodRun', { crisis: true, name: 'recoverHp' }), 'a different crisis-grade job may still take the body')
  // every latch that a proposal's own executor sets must declare which proposal that is, or this
  // rule silently stops covering it
  for (const o of reflexes.BODY_OWNERS.filter(x => x.owns)) {
    assert(reflexes.get(o.owns), o.key + ': owns "' + o.owns + '", which is not a registered proposal')
  }
})

t('ordering: a body refusal always NAMES the owner it yielded to', () => {
  for (const o of reflexes.BODY_OWNERS) {
    const why = reflexes.bodyRefusal('IDLE', o.key)
    assert(typeof why === 'string' && why.includes(o.label), o.key + ': the refusal must print the owner (' + why + ')')
  }
  assert.strictEqual(reflexes.bodyRefusal('SURVIVE', null), null, 'an idle body refuses nothing')
  assert.strictEqual(reflexes.bodyRefusal('SURVIVE', 'nonsense'), null, 'an unknown owner must fail OPEN - a typo cannot immobilise the bot')
})

t('ordering: every BODY_OWNERS row has a tier the arbiter knows', () => {
  for (const o of reflexes.BODY_OWNERS) {
    assert(Object.prototype.hasOwnProperty.call(arbiter.PRIORITY, o.tier), o.key + ': unknown tier ' + o.tier)
    assert(o.label && o.label.length > 2, o.key + ': the label is what a refusal PRINTS - it must read as English')
  }
})

// ============ CONTRACT 4 - a declared hold is never a stall ===============================
t('4: a declared hold is live, and it expires on its own TTL', () => {
  reflexes._resetHolds()
  let now = 1000
  reflexes._setNow(() => now)
  assert.strictEqual(reflexes.activeHold(), null, 'nothing is held to begin with')
  const tok = reflexes.beginHold('nightShelter', 'dawn', 600000)
  const h = reflexes.activeHold()
  assert(h && h.wake === 'dawn' && h.label === 'nightShelter', 'the hold names itself and its wake')
  now += 599000
  assert(reflexes.activeHold(), 'still held inside its own deadline')
  now += 2000
  assert.strictEqual(reflexes.activeHold(), null, 'a hold past its TTL is NOT a hold - a crashed executor can never freeze the watchdog')
  reflexes.endHold(tok)
  reflexes._setNow(null)
  reflexes._resetHolds()
})

t('4: the watchdog would have failed the 2026-07-29 shelter; a declared hold is the reason it does not', () => {
  // The fixture is the real tape: a job with no verified progress for 195s. The PURE watchdog
  // still says stall - that is correct and unchanged. The runner is what must not act on it
  // while a hold is declared, so this pins BOTH halves: the verdict, and the exemption.
  const job = { name: 'recoveryLadder', cls: 'survival', startedAt: 0, lastProgressAt: 0 }
  const verdict = scheduler.watchdog(job, { hp: 20, food: 7 }, 195000)
  assert(verdict === 'fail-job' || verdict === 'nudge', 'the watchdog must still SEE the stillness (got ' + verdict + ')')
  reflexes._resetHolds()
  let now = 1000
  reflexes._setNow(() => now)
  reflexes.beginHold('nightShelter', 'dawn', 600000)
  assert(reflexes.activeHold(), 'and the runner has a hold to check before it acts on that verdict')
  reflexes._setNow(null)
  reflexes._resetHolds()
})

t('4: a proposal that declares a hold names the condition that releases it', () => {
  for (const r of reflexes.REFLEXES) {
    if (!r.holds) continue
    assert(r.holds.wake && typeof r.holds.wake === 'string', r.name + ': a hold with no named wake is a hang with better manners')
  }
  const shelter = reflexes.get('nightShelter')
  assert(shelter && shelter.holds && shelter.holds.wake === 'dawn', 'the night shelter is the hold the watchdog dug the bot out of - it must declare one')
})

// ============ S5 - the self-proposing (IDLE-tier) housekeeping =============================
// These four were 3s-45s timers. The whole point of moving them is that they can no longer
// interrupt anything: they are scored, and an IDLE tier loses to every owner there is.
t('S5: housekeeping is IDLE-tier and scores below a waiting build', () => {
  const selfProposing = reflexes.REFLEXES.filter(r => typeof r.when === 'function')
  assert(selfProposing.length >= 4, 'the housekeeping proposals are missing (found ' + selfProposing.length + ')')
  const W_RESUME = 0.2 // scheduler-core's weight for "a saved build is waiting"
  const housekeeping = selfProposing.filter(r => r.tier === 'IDLE')
  assert(housekeeping.length >= 4, 'expected at least the four migrated timers')
  for (const r of housekeeping) {
    assert(r.benefit != null && r.benefit < W_RESUME, r.name + ': benefit ' + r.benefit + ' would out-score a waiting build')
    assert(typeof r.run === 'function', r.name + ': a self-proposing reflex must be able to run itself')
  }
})

t('S5: a self-proposing reflex ABOVE idle tier has to earn it', () => {
  // spawnReassert is the one, and the bar is: it must out-rank a bootstrap chore and lose to
  // sheltering at dusk. A survival-tier self-proposer that scored like a crisis would smuggle a
  // hardcoded priority back in through the utility phase, which is what the core replaced.
  const W_SECURE_CHORE = 0.6 * 0.9 // scheduler-core: W_SECURE x the armour-bootstrap urgency
  const DUSK_SHELTER = 0.65 // W_SURVIVE x dusk x a typical exposure
  for (const r of reflexes.REFLEXES.filter(x => typeof x.when === 'function' && x.tier !== 'IDLE')) {
    assert.strictEqual(r.tier, 'SURVIVE', r.name + ': the only non-idle self-proposer we allow is survival work')
    assert(r.benefit > W_SECURE_CHORE, r.name + ': would lose to an ordinary chore (' + r.benefit + ')')
    assert(r.benefit < DUSK_SHELTER, r.name + ': would out-rank getting to shelter at dusk (' + r.benefit + ')')
    assert(typeof r.run === 'function', r.name + ': must be able to run itself')
  }
})

t('S5: a proposal candidate is only offered when its own condition holds', () => {
  const quiet = { dropDist: null, rawMeat: 0, furnaceDist: null, scaffoldDebtNear: 0, isNight: false, torches: 0 }
  assert.deepStrictEqual(reflexes.proposalCandidates(quiet, { risk: 0 }).map(c => c.job), [], 'nothing to do => no candidates')
  const busy = { dropDist: 3, rawMeat: 6, furnaceDist: 5, scaffoldDebtNear: 9, isNight: false, torches: 0 }
  const jobs = reflexes.proposalCandidates(busy, { risk: 0 }).map(c => c.job).sort()
  assert.deepStrictEqual(jobs, ['autoCollect', 'autoCook', 'scaffoldSweep'], 'got ' + jobs.join(','))
  for (const c of reflexes.proposalCandidates(busy, { risk: 0 })) {
    assert.strictEqual(c.cls, 'idle', c.job + ': a housekeeping candidate must be idle-class')
    assert(c.score > 0 && c.score < 0.2, c.job + ': score ' + c.score + ' is outside the housekeeping band')
  }
})

t('S5: urgency falls off with distance - a drop underfoot is worth more than one 8b away', () => {
  const near = reflexes.proposalCandidates({ dropDist: 1.5 }, { risk: 0 })[0]
  const far = reflexes.proposalCandidates({ dropDist: 7.5 }, { risk: 0 })[0]
  assert(near && far && near.score > far.score, 'a nearer drop must score higher')
  assert.deepStrictEqual(reflexes.proposalCandidates({ dropDist: 20 }, { risk: 0 }), [], 'and beyond the band there is no candidate at all')
})

t('S5: live risk docks housekeeping - a bot in danger does not stop to tidy up', () => {
  const calm = reflexes.proposalCandidates({ dropDist: 2 }, { risk: 0, riskWeight: 0.15 })[0]
  const risky = reflexes.proposalCandidates({ dropDist: 2 }, { risk: 1, riskWeight: 0.15 })[0]
  assert(calm.score > risky.score, 'the same drop must be worth less when the world is dangerous')
})

t('S5: a when() that throws is a proposal that does not run, never a crash', () => {
  const poison = { get dropDist () { throw new Error('unreadable') } }
  assert.doesNotThrow(() => reflexes.proposalCandidates(poison, { risk: 0 }))
})

// ============ the registry is the record of what the runner can do =========================
t('registry: names are unique and every executor is async', () => {
  const seen = new Set()
  for (const r of reflexes.REFLEXES) {
    assert(!seen.has(r.name), 'duplicate proposal name: ' + r.name)
    seen.add(r.name)
    assert(r.why && r.why.length > 20, r.name + ': `why` is what a human reads at 3am - one honest line, please')
    if (r.run) assert(r.run.constructor.name === 'AsyncFunction', r.name + ': an executor must be async (the runner awaits it)')
  }
})

t('registry: the six behaviours PLAN §S1 names are all present', () => {
  for (const n of ['nightShelter', 'secureFood', 'recoverHp', 'gearup', 'homeRepair', 'foodTopUp']) {
    assert(reflexes.get(n), 'missing proposal: ' + n)
  }
})

// ==== A HOLD IS A CLAIM, AND A CLAIM NEEDS EVIDENCE (live 2026-07-31) ========================
// nightShelter declared "I am resting until dawn" while still ELEVEN BLOCKS from its bed and
// THIRTY-ONE BLOCKS UNDERGROUND, then failed to climb out:
//   13:46:20 nightRest: bed remembered at 190,68,-102 (11 blocks) - heading there
//   13:46:20 (wd) nightShelter is a DECLARED hold waking on dawn - stillness here is the goal
//   13:46:27 recovery: stuck UNDERGROUND at (188,37,-111) - climbing to the surface y=66
// The hold suppressed the stall clock, its TTL was refreshed by every re-dispatch, and the bot
// sat in a mineshaft for half an hour "sheltering". A hold names WHEN it wakes; it must also be
// able to name what makes its stillness deliberate.
t('HOLD PREMISE: a contradicted premise stops vouching for stillness', () => {
  reflexes._resetHolds()
  let sheltered = false
  reflexes.beginHold('nightShelter', 'dawn', 600000, { premise: 'sheltered' })
  assert.strictEqual(reflexes.activeHold(() => sheltered), null,
    'THE MINESHAFT: not sheltered means the watchdog must still be able to see a stuck body')
  sheltered = true
  assert(reflexes.activeHold(() => sheltered), 'once it IS sheltered, stillness is the goal again')
})

t('HOLD PREMISE: it is not deleted - the holder may still be walking there', () => {
  reflexes._resetHolds()
  let sheltered = false
  reflexes.beginHold('nightShelter', 'dawn', 600000, { premise: 'sheltered' })
  assert.strictEqual(reflexes.activeHold(() => sheltered), null, 'contradicted now')
  sheltered = true
  assert(reflexes.activeHold(() => sheltered), 'and it recovers without needing a fresh dispatch')
})

t('HOLD PREMISE: a THROWING premise is trusted - never strand a sealed-in bot on a bad predicate', () => {
  reflexes._resetHolds()
  reflexes.beginHold('nightShelter', 'dawn', 600000, { premise: 'sheltered' })
  assert(reflexes.activeHold(() => sheltered), 'unknown must fail SAFE here - the sealed pit is the case this row exists for')
})

t('HOLD PREMISE: a hold with NO premise behaves exactly as before', () => {
  reflexes._resetHolds()
  reflexes.beginHold('someOtherJob', 'whatever', 600000)
  assert(reflexes.activeHold(() => sheltered), 'existing holders are unaffected')
})

t('HOLD PREMISE: the TTL still bites regardless of premise', () => {
  reflexes._resetHolds()
  reflexes.beginHold('nightShelter', 'dawn', 1000, { premise: 'sheltered' })
  reflexes._setNow(() => Date.now() + 5000)
  assert.strictEqual(reflexes.activeHold(() => true), null, 'an expired hold is not a hold, premise or not')
  reflexes._setNow(null)
})

console.log(`\nreflexes: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
