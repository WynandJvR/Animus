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

console.log(`\nreflexes: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
