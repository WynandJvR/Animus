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

// ---- N2: THE LEG MAY NOT WRITE ITS OWN REPORT CARD (rewritten 2026-08-25) ----------------
// N2's original fix was a stamp in navigate.recoverOnce: `if (ok) touchP('navRung:' + step.kind)`,
// so a leg grinding through nudge/stepout rungs told the supervisor it was alive. It worked, and
// then it killed the bot. 2026-08-03 16:54 -> 20:10, wedged one block from its own hut:
//   (watchdog) position FROZEN ~195s at (190,69,-100) - forcing an escape
//   [nav] recovery: step-out 2 cell(s) toward 192,-100  -> stepout -> MOVED
//   [nav] recovery: step-out 2 cell(s) toward 190,-100  -> stepout -> MOVED
//   (wd) NUDGE autobuild - no verified progress for ~121s - marking stalled
// The freeze watchdog fires at 195s and the job watchdog's fail rung is at 240s, so the rescue
// reset the job clock 45 SECONDS before it could fire - 32 times on an exact 4-minute period, zero
// FAIL-JOB in the last 4h15m, and the process died "continuing" a build that had not moved.
// The seam was never nav's patience; it was that ONE progress cell answered two questions. It no
// longer does (telemetry.js): the BODY clock takes any touch, the per-job WORK LEDGER takes only a
// world-state delta - production, or NEW GROUND. A leg that gets somewhere keeps its job alive
// through the ratchet, which is evidence the rescuer cannot manufacture; a leg shuttling inside a
// pocket keeps nothing alive, and being failed is the correct verdict for it.
t('THE STAMP IS GONE: nav may not touch the progress clock at all', () => {
  const nav = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
  assert(/async function recoverOnce/.test(nav), 'recoverOnce still exists')
  assert(!/^\s*if \(ok\) touchP\('navRung/m.test(nav), 'the rescue stamp is back - that is the 4-hour hang')
  assert(!/^\s*const touchP = /m.test(nav), 'no progress sink in navigate.js: a rescuer may not vouch for the job it is rescuing')
  assert(!/touchProgress/.test(nav.replace(/\/\/.*$/gm, '')), 'no live touchProgress call anywhere in nav (comments explaining the deletion are fine)')
  // AND STILL NOT A HOLD (the original N2 pin, unchanged). A declared hold would vouch for a DEAD
  // leg until its TTL and stand the whole watchdog down - index.js returns early on activeHold,
  // taking the cycle detector and the position-freeze watchdog with it.
  assert(!/beginHold\(/.test(nav), 'a nav leg must not declare a hold - stillness is not what it is doing')
})

t('THE RATCHET IS THE WITNESS NOW: new ground advances the ledger, re-tread does not', () => {
  telemetry._resetProgress()
  const p0 = telemetry.progressInfo()
  telemetry.touchProgress('newGround')
  assert.strictEqual(telemetry.progressInfo().advanceCount, p0.advanceCount + 1, 'new ground IS an advance')
  assert.strictEqual(telemetry.progressInfo().workCount, p0.workCount,
    'but it is not PRODUCTION - cycle-detect excludes on workCount and must still see a work-free shuttle')
})

t('ESCAPING IS NOT PRODUCING, AND IT IS NOT PROGRESS EITHER', () => {
  telemetry._resetProgress()
  const before = telemetry.progressInfo()
  telemetry.markStalled()
  assert.strictEqual(telemetry.progressInfo().stalled, true)
  telemetry.touchProgress('navRung:stepout') // the tag the deleted stamp used
  const p = telemetry.progressInfo()
  assert.strictEqual(p.by, 'navRung:stepout', 'the BODY clock still records WHAT moved it')
  assert.strictEqual(p.stalled, true, 'a rescue rung must NOT clear the nudge marker - that is what laundered the hang')
  assert.strictEqual(p.advanceCount, before.advanceCount, 'a rescue rung is not an advance')
  assert.strictEqual(p.workCount, before.workCount, 'nor production')
  // by contrast, real production is both
  telemetry.touchProgress('harvest')
  const q = telemetry.progressInfo()
  assert.strictEqual(q.workCount, before.workCount + 1, 'harvest is production')
  assert.strictEqual(q.advanceCount, before.advanceCount + 1, '...and therefore an advance')
  assert.strictEqual(q.stalled, false, '...and it clears the marker')
})

t('THE LEDGER IS PER JOB: a fresh key starts at its OWN startedAt, and only an advance moves it', () => {
  telemetry._resetProgress()
  const started = Date.now() - 60000
  const a = telemetry.jobProgress('autobuild@' + started, started)
  assert.strictEqual(a.at, started, 'a job entered without any stamp starts its clock at startedAt, not at "now"')
  telemetry.touchProgress('navRung:stepout')
  assert.strictEqual(telemetry.jobProgress('autobuild@' + started, started).at, started,
    'a rescue may not re-base the job it is rescuing - this is the 2026-08-03 hang, asserted')
  telemetry.touchProgress('placed')
  assert(telemetry.jobProgress('autobuild@' + started, started).at > started, 'a verified place does re-base it')
  // ...and the next job does not inherit it
  const later = Date.now()
  assert.strictEqual(telemetry.jobProgress('secureFood@', null).at <= later + 5, true, 'a different key gets its own entry')
})

t('A RE-DISPATCH IS A NEW JOB: the survival latches share one key, so the entry must be closed', () => {
  // 'secureFood@' is the same string on every dispatch (a latch job has no startedAt). Without the
  // close-on-idle below, run #2 would arrive holding run #1's exhausted clock and fail instantly -
  // which is what the deleted `zero-idle at t0` stamps were compensating for, from a global cell.
  telemetry._resetProgress()
  const first = telemetry.jobProgress('secureFood@', null).at
  telemetry.jobProgress(null, null) // activeJobInfo's no-job path: the run ended
  const second = telemetry.jobProgress('secureFood@', null).at
  assert(second >= first, 'the second dispatch gets its own clock, not the leftovers of the first run')
  // ...but while ONE run is live, re-reading it must NOT re-base (that would be a clock nobody could fail)
  const held = telemetry.jobProgress('secureFood@', null).at
  assert.strictEqual(held, second, 'reading the clock twice may not reset it')
})

t('THE ESCALATION CAN NOW REACH ITS FAIL RUNG: 240s of rescue-only motion IS a fail-job', () => {
  // The exact terminal arithmetic. A non-critical job nudges at 120s and fails at 240s; the freeze
  // watchdog's escape lands at 195s and "succeeds". Under the old clock that reset idle to 0 every
  // 4 minutes forever. Under the ledger the escape stamps nothing the supervisor reads.
  const started = 0
  const job = { name: 'autobuild', cls: 'progress', startedAt: started, lastProgressAt: started }
  assert.strictEqual(S.watchdog(job, { hp: 20, food: 20 }, 120000), 'nudge')
  assert.strictEqual(S.watchdog(job, { hp: 20, food: 20 }, 195000), 'nudge', 'the 195s escape must not de-escalate it')
  assert.strictEqual(S.watchdog(job, { hp: 20, food: 20 }, 240000), 'fail-job', 'and the fail rung is REACHABLE')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall leg-patience tests passed')
process.exit(fails ? 1 : 0)
