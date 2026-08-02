'use strict'
// OFFLINE contract test for THE SUPERVISOR'S PATIENCE vs THE WORK IT SUPERVISES.
// Pure functions + source pins. No bot, no world, no timers.
//
// WHY THIS FILE EXISTS - the live tape, 2026-08-02, at hp 19 / food 2:
//   17:17:48 (wd) NUDGE secureFood - no verified progress for 23s (hp 19 food 2) - marking stalled
//   17:18:08 (wd) FAIL-JOB secureFood - no verified progress for 43s - setting its stop latch
//   17:18:46 [prov] farm health: inspected 10/41 cell(s) - SCAN CUT (stopped) after 10: wheat=8(mature 8) gone=2
// ...while one leg of that same job legitimately costs this much:
//   [nav] leg took 30.3s: attempt 6s, budget 24s, ceiling 90s, reflex-hold 0s, recoveries 2 in 26s
//   [nav] collect: leg took 46.4s: attempt 10s, budget 40s, ceiling 90s, reflex-hold 0s, recoveries 2 in 24s
//
// TWO defects, one seam:
//   (N1) the escalation was DANGER-SCALED ahead of everything else, so the hungrier the bot got
//        the LESS time its food job was given. The crisis made recovery structurally impossible,
//        and the stop latch cut the tend pass at cell 10 of 41 with eight ripe wheat standing.
//   (N2) a nav leg spent in recovery rungs moves the body two or three blocks, and telemetry's
//        witness re-anchors at EIGHT - so a leg doing exactly the right thing stamped nothing for
//        30-46s. The ladder had already re-read the world and knew it had MOVED; it threw the
//        proof away.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const S = require('./scheduler.js')
const telemetry = require('./telemetry.js')

let fails = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fails++ } }

const survivalJob = { startedAt: 0, lastProgressAt: 0, cls: 'survival' }
const CRISIS = { hp: 19, food: 2 } // the live vitals

// ---- N1: the crisis window must not cut the answer to the crisis -------------------------
t('THE INVERSION: at food 2 the survival job keeps its OWN window (45s/90s), not 20s/40s', () => {
  assert.strictEqual(S.watchdog(survivalJob, CRISIS, 23000), 'ok', 'the live NUDGE at 23s must not happen')
  assert.strictEqual(S.watchdog(survivalJob, CRISIS, 43000), 'ok', 'the live FAIL-JOB at 43s is what cut the farm pass')
  assert.strictEqual(S.watchdog(survivalJob, CRISIS, S.SURVIVAL_NUDGE_MS), 'nudge')
  assert.strictEqual(S.watchdog(survivalJob, CRISIS, S.SURVIVAL_FAIL_MS), 'fail-job')
})

t('...and the short window still does its real job: work that is NOT the answer is cut in seconds', () => {
  for (const cls of ['progress', 'maintain', 'idle']) {
    const job = { startedAt: 0, lastProgressAt: 0, cls }
    assert.strictEqual(S.watchdog(job, { hp: 6, food: 20 }, 20000), 'nudge', cls + ' at hp 6')
    assert.strictEqual(S.watchdog(job, { hp: 20, food: 2 }, 40000), 'fail-job', cls + ' at food 2')
  }
})

t('SWEEP: no combination of vitals shortens a survival job\'s leash - the number is ONE number', () => {
  let combos = 0
  for (let hp = 0; hp <= 20; hp++) {
    for (let food = 0; food <= 20; food++) {
      const v = { hp, food }
      combos++
      assert.notStrictEqual(S.watchdog(survivalJob, v, S.SURVIVAL_FAIL_MS - 1), 'fail-job',
        'survival job failed early at hp ' + hp + ' food ' + food)
      assert.strictEqual(S.watchdog(survivalJob, v, S.SURVIVAL_FAIL_MS), 'fail-job',
        'survival job must still fail at its own window (hp ' + hp + ' food ' + food + ')')
    }
  }
  assert.strictEqual(combos, 21 * 21, 'swept the full vitals grid: ' + combos)
})

t('THE DERIVED CEILINGS ARE TRUE AGAIN: nav and the ladder budget to the number the supervisor uses', () => {
  // navigate.js caps ONE leg at scheduler.SURVIVAL_FAIL_MS ("give the caller an honest answer
  // BEFORE the supervisor draws a conclusion") and provision-recovery bounds a rung at
  // SURVIVAL_FAIL_MS + LATCH_GRACE_MS. Both promises were false while the crisis branch cut a
  // survival job at 40s: the inner layers budgeted to 90s against a supervisor with 40s of
  // patience. Two clocks for one rule is the seam this whole file is about.
  const nav = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
  assert(/function supervisorPatienceMs/.test(nav) && /s\.SURVIVAL_FAIL_MS/.test(nav),
    'the nav ceiling must still be DERIVED from the supervisor, never a second literal')
  const rec = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
  assert(/const RUNG_NOPROGRESS_MS = scheduler\.SURVIVAL_FAIL_MS \+ scheduler\.LATCH_GRACE_MS/.test(rec),
    'the rung deadline must still be derived from the same instant')
  // ...and the supervisor really does wait that long for survival work, whatever the vitals.
  for (const v of [{ hp: 1, food: 0 }, { hp: 6, food: 2 }, { hp: 20, food: 20 }]) {
    assert.strictEqual(S.watchdog(survivalJob, v, S.SURVIVAL_FAIL_MS - 1), 'nudge')
  }
})

// ---- N2: the leg reports the movement it already verified --------------------------------
t('THE LEG PROVED IT MOVED: the nav ladder stamps its OWN world verdict, once, and only on `ok`', () => {
  const nav = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
  const i = nav.indexOf('async function recoverOnce')
  assert(i > 0, 'recoverOnce exists')
  const body = nav.slice(i, nav.indexOf('\n// ---- THE entry point', i))
  assert(/if \(ok\) touchP\('navRung:' \+ step\.kind\)/.test(body),
    'the stamp must hang off the ladder\'s own verified verdict (`ok`), inside recoverOnce')
  assert.strictEqual((nav.match(/touchP\('navRung/g) || []).length, 1,
    'ONE definition: every escalator (navigateToInner / walkStaged / the freeze watchdog) runs this ladder')
  // A record written from an ATTEMPT instead of from EVIDENCE is the defect that blinded the
  // watchdog for 5.5 hours on 2026-07-31. There must be no unconditional stamp anywhere in nav.
  assert(!/^\s*touchP\('navRung/m.test(nav), 'an unconditional nav stamp would feed the witness while frozen')
  assert(/const touchP = tag => \{ try \{ require\('\.\/commands\.js'\)\.touchProgress\(tag\)/.test(nav),
    'the house touchP pattern - lazy + swallowed, so telemetry can never fail a navigation')
  // AND NOT A HOLD. A declared hold would vouch for a DEAD leg until its TTL and would stand the
  // whole watchdog down (index.js returns early on activeHold) - including the cycle detector and
  // the position-freeze watchdog. An event has no TTL to outlive the leg.
  assert(!/beginHold\(/.test(nav), 'a nav leg must not declare a hold - stillness is not what it is doing')
})

t('THE HANG IS STILL CAUGHT: a leg that verifies nothing ages exactly as before', () => {
  // The stamp is an event, so "alive" ends the instant the rungs stop verifying movement. Model
  // it on the pure watchdog: a job whose last stamp was at t0 is nudged and failed on schedule
  // no matter how long the leg claims to have been running.
  const hung = { startedAt: 0, lastProgressAt: 0, cls: 'survival' }
  assert.strictEqual(S.watchdog(hung, CRISIS, S.SURVIVAL_NUDGE_MS), 'nudge')
  assert.strictEqual(S.watchdog(hung, CRISIS, S.SURVIVAL_FAIL_MS), 'fail-job')
  // ...and a rung that verified movement 1ms ago re-bases it, which is the whole point.
  const alive = { startedAt: 0, lastProgressAt: S.SURVIVAL_FAIL_MS - 1, cls: 'survival' }
  assert.strictEqual(S.watchdog(alive, CRISIS, S.SURVIVAL_FAIL_MS), 'ok')
})

t('ESCAPING IS NOT PRODUCING: a nav stamp clears the stall clock but never bumps workCount', () => {
  telemetry._resetProgress()
  telemetry.touchProgress('begin:secureFood')
  const w0 = telemetry.progressInfo().workCount || 0
  telemetry.markStalled()
  assert.strictEqual(telemetry.progressInfo().stalled, true)
  telemetry.touchProgress('navRung:stepout')
  const p = telemetry.progressInfo()
  assert.strictEqual(p.by, 'navRung:stepout', 'the clock records WHAT moved it')
  assert.strictEqual(p.stalled, false, 'a verified rung means the body is not frozen')
  assert.strictEqual(p.workCount || 0, w0,
    'a recovery rung is escape work, not production - cycle-detect excludes on workCount and must still see an A<->B loop')
  // by contrast, real production does bump it (the tag family this deliberately stays out of)
  telemetry.touchProgress('harvest')
  assert.strictEqual(telemetry.progressInfo().workCount, w0 + 1, 'harvest is production')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall leg-patience tests passed')
process.exit(fails ? 1 : 0)
