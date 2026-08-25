'use strict'
// ==== JOB-LEVEL VERDICTS (structural review 2026-08-25, D6 / PART 4 item 7) ================
// Run:  cd bot && node jobverdicttest.js
//
// THE DEFECT. The job layer had a chooser above it and an executor below it and nothing in
// between that could conclude anything about a PLAN. The castle's bootstrap step - "gathering 3x
// oak_log" - restarted every ~20 minutes for a whole day, each attempt identical, and zero builds
// completed in four days. Three things had to become true, and this file pins all three:
//
//   1. the build is a DISPATCHED job with a lease, not three private setInterval drivers;
//   2. its checklist step is the `step` half of attempt memory's (job, step, cell) key, so
//      "gathering failed here" is a different fact from "this whole build failed here";
//   3. N identical failures at one step produce a re-plan/abandon VERDICT that the chooser and
//      the brain can both see, and that actually stops the retry (#5 - a decision must act).
//
// Behaviour where it can be run offline (the pure verdict, the checklist ratchet, the hold
// reaching the chooser); source pins where index.js's require dials a server.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const scheduler = require('./scheduler.js')
const attempts = require('./attempts.js')
const reflexes = require('./reflexes.js')
const telemetry = require('./telemetry.js')

let pass = 0
let fail = 0
function t (name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)) }
}
const srcOf = f => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')

// A snapshot of a healthy bot with a saved build and nothing else owed: bootstrapNeed is null, so
// the ONLY thing that can hold the build here is the stand-down clause under test.
function ready (over) {
  return Object.assign({
    vitalsKnown: true, hp: 20, food: 20, armorPieces: 4, packFoodPts: 20, bankFoodPts: 60,
    persistedBuild: true, hutExists: true, spawnAnchored: true, bedKnown: true, litBase: true,
    homeDist: 10, homeReachable: true, maintainNeeded: true, graves: [], farm: { exists: true }
  }, over || {})
}

console.log('job-level verdicts (review item 7)')

// ---- 1. THE VERDICT LADDER ---------------------------------------------------------------

const N = scheduler.BUILD_VERDICT_N

t('1: the Nth failure, all of them in ONE cell, is a RE-PLAN - the ground is the suspect', () => {
  const v = scheduler.buildVerdict({ step: 'gather materials', cellN: N, planN: N })
  assert(v, 'the ' + N + 'th attempt must produce a verdict - this is the "20 times unexamined" defect')
  assert.strictEqual(v.verdict, 're-plan')
  assert.strictEqual(v.step, 'gather materials')
  assert(/achieved nothing here/.test(v.why), 'the verdict names the ground, because the ground is what it suspects')
})

t('1: the Nth failure spread ACROSS places is an ABANDON - the place is exonerated', () => {
  const v = scheduler.buildVerdict({ step: 'gather materials', cellN: 1, planN: N })
  assert(v && v.verdict === 'abandon', 'failures in different places cannot be blamed on one place')
  assert(/not the ground/.test(v.why), 'and it must say WHY it is a different verdict, not just a louder one')
})

t('1: RE-PLAN IS OFFERED ONCE - a stand-down that changed nothing escalates, it does not repeat', () => {
  // The pass right after a re-plan: same cell, same story, one higher count. Prescribing the
  // stand-down again forever is the 4-minute force-escape retry this review deleted.
  const again = scheduler.buildVerdict({ step: 'gather materials', cellN: N + 1, planN: N + 1 })
  assert.strictEqual(again.verdict, 'abandon')
  assert(/including after a stand-down/.test(again.why), 'and it must say that the remedy was already tried')
  for (let n = N + 1; n < N + 6; n++) {
    assert.strictEqual(scheduler.buildVerdict({ step: 's', cellN: n, planN: n }).verdict, 'abandon',
      'every crossing after the first is an escalation - there is no rung that re-offers itself')
  }
})

t('1: the TRIGGER is the plan counter, never the cell counter', () => {
  // The cell counter belongs to a record `futile` deletes whenever the world signature moves, and
  // live that happens within minutes (the hour bucket, the food bucket). A trigger built on it
  // would be unreachable - the same "the re-arm cannot be reached from the state that fired it"
  // defect item 3 removed, arriving from the other direction.
  assert.strictEqual(scheduler.buildVerdict({ step: 's', cellN: 99, planN: N - 1 }), null,
    'a huge cell count with a plan count under the threshold is NOT a verdict')
})

t('1: a step that has not yet crossed the threshold gets NO verdict', () => {
  for (let n = 0; n < N; n++) assert.strictEqual(scheduler.buildVerdict({ step: 's', cellN: n, planN: n }), null)
})

t('1: the verdict is PURE - same counters in, same verdict out, no clock and no bot', () => {
  const a = scheduler.buildVerdict({ step: 's', cellN: N, planN: N })
  const b = scheduler.buildVerdict({ step: 's', cellN: N, planN: N })
  assert.deepStrictEqual(a, b)
})

// ---- 2. THE STEP IS THE KEY --------------------------------------------------------------
// Item 3 shipped attempt memory with `step` hard-wired to '-' for every job and left the hook.
// This is what filling it in buys: two failures of DIFFERENT steps at the SAME spot are two
// records, so finishing one step re-arms the job even without moving an inch.

t('2: the build row publishes the CHECKLIST STEP as its attempt-memory step', () => {
  const row = reflexes.get('build')
  assert(row, 'the build must have a row in the registry at all - that is the whole of "joins the dispatch system"')
  assert.strictEqual(typeof row.step, 'function', 'index.js stepOf() looks for exactly this')
  telemetry.checklistBegin(telemetry.JOB_STEPS)
  telemetry.checklistStep('gather materials')
  assert.strictEqual(row.step(), 'gather materials')
})

t('2: ...and the step OUTLIVES the checklist, because the verdict is reached after the pass', () => {
  telemetry.checklistBegin(telemetry.JOB_STEPS)
  telemetry.checklistStep('armor up')
  telemetry.endActivity(false, 'pass ended') // does not clear it (not the autobuild label)
  telemetry.beginActivity('autobuild', 'resume')
  telemetry.endActivity(false, 'the build pass returned') // THIS clears jobList
  assert.strictEqual(telemetry.checklistInfo(), null, 'the list itself dies with the job, as it always has')
  assert.strictEqual(reflexes.get('build').step(), 'armor up',
    'but the step the plan stopped on must survive - otherwise every verdict is recorded against "-" and attempt memory is one bucket per job again')
})

t('2: two steps at ONE cell are two records - "this step failed here" != "this job failed here"', () => {
  attempts._reset()
  const cell = attempts.cellOf({ x: 61, y: 68, z: -60 })
  attempts.record('build', 'gather materials', cell, { sig: 'W', why: 'no logs in reach', now: 1 })
  assert(attempts.futile('build', 'gather materials', cell, 'W'), 'that step, here, achieved nothing')
  assert.strictEqual(attempts.futile('build', 'camp: safehouse hut', cell, 'W'), null,
    'the next step of the same job at the same spot is admissible - changing step is a re-arm')
})

// ---- 3. A CHECKLIST STEP IS PROGRESS - ONCE ----------------------------------------------
// The dangerous half. Crediting a step touch on RE-ENTRY would pay the castle's 20-minute
// restart loop eleven advances a lap and re-arm the watchdog it was meant to trip: D1 rebuilt.

t('3: reaching a NEW step credits the work ledger', () => {
  telemetry._resetProgress()
  telemetry.checklistBegin(telemetry.JOB_STEPS)
  const n0 = telemetry.progressInfo().workCount
  telemetry.checklistStep('travel to site')
  telemetry.checklistStep('survey the site')
  assert.strictEqual(telemetry.progressInfo().workCount, n0 + 2, 'two steps forward, two advances')
})

t('3: RE-ENTERING a step already reached credits NOTHING (the ratchet)', () => {
  telemetry._resetProgress()
  telemetry.checklistBegin(telemetry.JOB_STEPS)
  telemetry.checklistStep('travel to site')
  telemetry.checklistStep('survey the site')
  telemetry.checklistStep('gather materials')
  const n = telemetry.progressInfo().workCount
  for (let lap = 0; lap < 5; lap++) { // the castle loop: back to the top, every ~20 minutes, all day
    telemetry.checklistStep('travel to site')
    telemetry.checklistStep('survey the site')
    telemetry.checklistStep('basic tools')
    telemetry.checklistStep('gather materials')
  }
  assert.strictEqual(telemetry.progressInfo().workCount, n,
    'five laps of already-covered steps must be worth exactly zero - a job that re-runs its plan is not a job that is advancing')
})

t('3: jobStep IS a work tag (a checklist step is a world-state delta per §3.1)', () => {
  assert(telemetry.CYCLE_WORK_TAGS.has('jobStep'), 'or the ratchet above credits nothing at all and the test is vacuous')
})

// ---- 4. THE VERDICT REACHES THE CHOOSER --------------------------------------------------
// A verdict that the chooser cannot see is a log line. The stand-down hold has existed for
// months and had exactly ONE reader - the 120s resume re-arm timer item 7 deletes.

t('4: a stood-down build is NOT ready, and buildReady says so with the reason and the override', () => {
  const r = scheduler.buildReady(ready({ buildHoldMs: 120000, buildPausedWhy: 're-plan: "gather materials" achieved nothing here 3 times running' }))
  assert.strictEqual(r.ok, false)
  assert(/stood down for 120s/.test(r.why), r.why)
  assert(/gather materials/.test(r.why), 'the refusal must carry the blocker, not just the fact of one (#7)')
  assert(/resumebuild/.test(r.why), 'and what would clear it')
})

t('4: ...and pickJob stops picking it, so maintain/idle are reachable again', () => {
  assert.strictEqual(scheduler.pickJob(ready({ buildHoldMs: 0 })).job, 'build', 'a live build is still the job')
  const held = scheduler.pickJob(ready({ buildHoldMs: 120000 }))
  assert(!held || held.job !== 'build',
    'a stood-down build must not shadow steps 5 and 6 - otherwise "abandon" means the bot stands still for fifteen minutes')
})

t('4: an unheld saved build is unaffected - this clause adds no new refusal of its own', () => {
  assert.strictEqual(scheduler.buildReady(ready({ buildHoldMs: 0 })).ok, true)
})

// ---- 5. THE WIRING (source pins - index.js dials a server on require) ---------------------

t('5: the build is DISPATCHED, and its three private drivers are gone', () => {
  const idx = srcOf('index.js')
  assert(!/AUTO_RESUME/.test(idx),
    'the boot auto-resume and the 120s re-arm interval are deleted - a timer that fires every two minutes is a retry, not a decision-maker')
  assert(!/commands\.resumeBuild && await commands\.resumeBuild\(bot\)/.test(idx),
    'and so is the respawn handler\'s own resume loop (the third driver)')
  // ONE remaining caller, inside the registry row, reached through the ONE dispatcher.
  const rfx = srcOf('reflexes.js')
  assert(/name: 'build'/.test(rfx) && /commands\.resumeBuild\(bot\)/.test(rfx),
    'the build must be a row with an executor, or "joins the dispatch/lease system" is a comment')
})

t('5: the build row is refused through the SAME readiness predicate as the chooser (#114)', () => {
  const rfx = srcOf('reflexes.js')
  const i = rfx.indexOf("name: 'build'")
  const row = rfx.slice(i, i + 2600)
  assert(/scheduler\.buildReady\(ctx\.s\)/.test(row),
    'a second readiness model is the 2026-07-19 standoff: the chooser picking a build the executor refuses, six times in 76 seconds')
})

t('5: the verdict PERFORMS something and tells the brain - it is not a log line', () => {
  const rfx = srcOf('reflexes.js')
  const i = rfx.indexOf("name: 'build'")
  const row = rfx.slice(i, i + 9000)
  assert(/commands\.markResumePaused\(/.test(row), 'the verdict stands the plan down through the ONE existing lever')
  assert(/commands\.noteJobVerdict\(/.test(row), 'and surfaces itself to the brain as a proposal')
  assert(/ctx\.note\('\(build\) ' \+ v\.verdict/.test(row), 'and says so in the log, once, greppable')
  const cmd = srcOf('commands.js')
  assert(/jobVerdict: jobVerdictInfo\(\)/.test(cmd),
    '/state is not gated by busy, which is why it is the channel that reaches a brain whose commands are suppressed')
})

t('5: the lease the build now holds is renewed by EVIDENCE, not by the clock', () => {
  const idx = srcOf('index.js')
  const i = idx.indexOf('function dispatchBusy ()')
  const fn = idx.slice(i, i + 900)
  assert(/adv \+ DISPATCH_LEASE_MS/.test(fn),
    'a flat 600s expiry would revoke a HEALTHY build - clearing its nav goal and its body claims - every ten minutes forever')
  assert(/schedJob\.until/.test(fn), 'and the floor is still the dispatch stamp, so a hung executor dies on exactly the old schedule')
})

t('5: the job claim names the build as its owner, which closes item 2\'s 300s watch note', () => {
  const row = reflexes.BODY_OWNERS.find(o => o.key === 'job')
  assert.strictEqual(row.owns, 'build',
    'without this, drivingClaim credits a dispatched job for the build\'s work and the build\'s own claim ages out from under it')
  assert.strictEqual(reflexes.claimOfJob('build'), 'job')
  // ...and the build can no longer preempt itself, which is what `owns` means everywhere else here.
  assert(/IS this job/.test(reflexes.bodyRefusal('PROGRESS', 'job', { name: 'build', crisis: true }) || ''))
})

console.log('\njob verdicts: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
