'use strict'
// OFFLINE unit test for THE ONE RESCUE PATH (structural review 2026-08-25, D4 / §3.5, item 5).
// No bot, no server, no fs writes: unstickPlan is pure, and the accountability half is checked by
// reading the source of the layers that are supposed to be gone.
//
// This file REPLACES cycledetecttest.js. That test pinned cycle-detect.js, which is deleted with
// this item: it was the third detector in a circle of three, its oscillation predicate needed >=48
// blocks of gross path in 180s (so the 1.6-2.2b terminal shuttle was invisible to it by
// construction), it fired zero times after 04:09 on the day the bot died, and its own comment
// delegated slow oscillation back to the freeze watchdog - whose remedy was the stamp that reset
// the job clock. Its assertions were about a module whose whole job §3.1 gives to one stall test.
// What is worth testing instead is what replaced it, which is what follows.
//
// Run:  cd bot && node unsticktest.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const nav = require('./navigate.js')
const attempts = require('./attempts.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}
const srcOf = f => fs.readFileSync(path.join(__dirname, f), 'utf8')
const code = f => srcOf(f).replace(/^\s*\/\/.*$/gm, '') // strip comment-only lines: the tombstones QUOTE what was deleted

// ============ 1. THE PLAN IS CHOSEN FROM WHERE THE BODY IS ================================
// The terminal loop of 2026-08-03: at (190,69,-100), two blocks from its own bed, the log's only
// account of the bot was `stuck UNDERGROUND ... climbing to the surface y=72`, 243 times, every
// swing refused by the one dig rule. A rung that cannot succeed by construction is not an attempt.

t('INDOORS: the way out of my own house is the DOOR - never the roof, never a dirt pillar', () => {
  const plan = nav.unstickPlan({ indoors: true, home: true, roofed: true, pit: false, noDig: true, climb: true, cut: true })
  assert.deepStrictEqual(plan, ['indoor', 'door', 'stepout'], 'got ' + plan.join('>'))
  assert.ok(!plan.includes('climb'), 'the climb rung digs; inside my own structure every swing is refused')
  assert.ok(!plan.includes('drybreach'), 'and so is the last-resort breach')
  assert.ok(!plan.includes('pit'), 'no pillaring in the living room')
})

t('AT HOME but outside (apron/support/crawlspace): the door still comes first', () => {
  const plan = nav.unstickPlan({ indoors: false, home: true, roofed: true, climb: true, cut: false })
  assert.strictEqual(plan[0], 'door', 'got ' + plan.join('>'))
  assert.ok(!plan.includes('climb'), 'a bot on its own doorstep is not "buried underground"')
})

t('AT HOME in a crater: the pit rung is still offered, after the door', () => {
  const plan = nav.unstickPlan({ indoors: false, home: true, pit: true, climb: true })
  assert.deepStrictEqual(plan, ['door', 'pit', 'stepout', 'nudge'], 'got ' + plan.join('>'))
})

t('SUBMERGED: water first, and nothing else - drowning is measured in seconds', () => {
  const plan = nav.unstickPlan({ submerged: true, wet: true, roofed: true, cut: true, climb: true })
  assert.strictEqual(plan[0], 'water', 'got ' + plan.join('>'))
  assert.ok(!plan.includes('wetbreach'), 'a drowning bot is escapeWater\'s business, not a rival ladder (#116)')
})

t('WET UNDER A CEILING (a water pocket): water, then the bounded breach', () => {
  const plan = nav.unstickPlan({ wet: true, roofed: true, cut: true, climb: true })
  assert.deepStrictEqual(plan.slice(0, 2), ['water', 'wetbreach'], 'got ' + plan.join('>'))
  assert.ok(!plan.includes('drybreach'), 'the DRY breach may not run on a wet bot')
})

t('OPEN GROUND, buried, cutting allowed: pit/door/climb then the fast rungs then the breach', () => {
  const plan = nav.unstickPlan({ roofed: true, pit: true, door: true, climb: true, cut: true })
  assert.deepStrictEqual(plan, ['pit', 'door', 'climb', 'nudge', 'stepout', 'drybreach'], 'got ' + plan.join('>'))
})

t('THE ONE DIG RULE IS ASKED, NOT RE-STATED: a protected cell is offered no cutting rung', () => {
  const plan = nav.unstickPlan({ roofed: true, climb: true, cut: true, noDig: true })
  assert.ok(!plan.includes('climb') && !plan.includes('drybreach'), 'got ' + plan.join('>'))
  assert.ok(plan.includes('stepout'), 'the non-cutting rungs still apply - this narrows attempts, it grants nothing')
})

t('ESCALATION IS EVIDENCE: without it, no cutting rung is offered at all', () => {
  const armed = nav.unstickPlan({ roofed: true, climb: true, cut: true })
  const cold = nav.unstickPlan({ roofed: true, climb: true, cut: false })
  assert.ok(armed.includes('drybreach'), 'armed: ' + armed.join('>'))
  assert.ok(!cold.includes('drybreach'), 'cold: ' + cold.join('>'))
})

t('A LIGHT LEG (1.5s creeper fuse) runs no cutting or pillaring rung', () => {
  const plan = nav.unstickPlan({ roofed: true, pit: true, door: true, climb: true, cut: true, light: true })
  for (const slow of ['pit', 'climb', 'wetbreach', 'drybreach']) assert.ok(!plan.includes(slow), slow + ' survived a light leg: ' + plan.join('>'))
  assert.ok(plan.includes('stepout') && plan.includes('door'), 'the fast rungs still run: ' + plan.join('>'))
})

t('A PLAN NEVER REPEATS A RUNG - the bound inside one rescue is the plan itself', () => {
  for (const w of [{ wet: true, roofed: true, home: true, pit: true, door: true, climb: true, cut: true },
    { indoors: true, home: true, door: true }, { roofed: true, pit: true, door: true, climb: true, cut: true }]) {
    const plan = nav.unstickPlan(w)
    assert.strictEqual(new Set(plan).size, plan.length, 'duplicate rung in ' + plan.join('>'))
  }
})

// ============ 2. THE BOUND IS A PLACE, AND MOVING RE-ARMS IT ==============================
// The latch this replaces (runner.ladderBlock / recoverySignature) had a re-arm condition that was
// unreachable from a wedge, because POSITION IS NOT IN THE SIGNATURE. Escaping the cell is exactly
// what changes this key, so the rescue can never disqualify itself permanently.
t('ATTEMPT MEMORY: the rescue records against a CELL, and four blocks re-arms it', () => {
  attempts._reset()
  const here = attempts.cellOf({ x: 190, y: 69, z: -100 })
  attempts.record('unstick', 'stepout', here, { now: 1 })
  assert.ok(attempts.recall('unstick', 'stepout', here), 'the record is about this place')
  const away = attempts.cellOf({ x: 198, y: 69, z: -100 })
  assert.strictEqual(attempts.recall('unstick', 'stepout', away), null, 'and it stops being true 8 blocks away')
  attempts._reset()
})

t('ATTEMPT MEMORY: a full reset clears the rescue\'s records, so the floor re-arms everything', () => {
  attempts._reset()
  const here = attempts.cellOf({ x: 190, y: 69, z: -100 })
  attempts.record('unstick', 'exhausted', here, { now: 1 })
  attempts.record('unstick', 'drybreach', here, { now: 1 })
  const n = attempts.forgetAll({ except: 'terminalAction' })
  assert.strictEqual(n, 2, 'the terminal action clears them: the world they were recorded in is gone')
  assert.strictEqual(attempts.recall('unstick', 'exhausted', here), null)
  attempts._reset()
})

// ============ 3. WHAT MUST STAY DELETED ===================================================
// This item is judged on deletion. Every assertion below is a mutation check: put the layer back
// and it fails here rather than on the live server four hours into a hang.
t('DELETED: the freeze watchdog, its 195s trigger and its 4-minute retry', () => {
  const idx = code('index.js')
  assert.ok(!/position FROZEN/.test(idx), 'the `(watchdog) position FROZEN ~195s` line is gone')
  assert.ok(!/WEDGE_WATCHDOG/.test(idx), 'and the flag that gated it')
  assert.ok(!/wdFailStreak|wdLastFire|wdHist/.test(idx), 'and its same-cell streak / 4-min retry / position ring')
  assert.ok(!/DESPERATE escape/.test(idx), 'and the desperate re-run')
})

t('DELETED: cycle-detect.js and every trace of its wiring', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, 'cycle-detect.js')), 'the module is deleted, not orphaned')
  const idx = code('index.js')
  assert.ok(!/cycleDetect|cycRing|cycState/.test(idx), 'the ring and the latch are gone from the supervisor')
  assert.ok(!/CYCLE_DETECT_ON|CYCLE_SELFABORT_EXEMPT/.test(idx), 'and both of its flags (the dead side of a flag is debt)')
  assert.ok(!/\(wd\) CYCLE /.test(idx), 'and the synthetic fail-job verdict it merged into wdPhase')
})

t('DELETED: the recovery ladder\'s per-rung budget bookkeeping, at the definition AND at every caller', () => {
  const n = code('navigate.js')
  assert.ok(!/defaultBudgets/.test(n), 'the default table is gone')
  assert.ok(!/budgets\[/.test(n), 'and nothing indexes a budget table any more')
  for (const f of ['index.js', 'commands.js', 'provision.js', 'provision-bank.js', 'provision-food.js',
    'provision-shelter.js', 'provision-recovery.js']) {
    assert.ok(!/budgets:\s*\{/.test(code(f)), f + ' still hands navigateTo a private per-rung budget table')
  }
})

t('DELETED: forceUnstick - there is exactly ONE rescue entry point', () => {
  assert.strictEqual(typeof nav.unstick, 'function', 'unstick is the entry point')
  assert.strictEqual(nav.forceUnstick, undefined, 'and the old one is not still exported beside it')
  const n = code('navigate.js')
  assert.ok(!/function forceUnstick/.test(n) && !/forceUnsticking/.test(n), 'no second escape path, no latch named after it')
})

// ============ 4. FAILURE IS A VERDICT, NOT A RETRY ========================================
t('THE RESCUE REPORTS, IT DOES NOT RE-ARM: no timer is set on the failure path', () => {
  const n = code('navigate.js')
  const i = n.indexOf('async function unstick')
  assert.ok(i > 0, 'found unstick')
  const body = n.slice(i)
  assert.ok(!/setTimeout|setInterval/.test(body.slice(0, body.indexOf('\n}\n'))), 'a rescue that schedules itself is the 4-minute heartbeat coming back')
  assert.ok(/verdict: 'exhausted'/.test(body), 'it returns the verdict instead')
})

t('THE RESCUE MAY NOT WRITE THE REPORT CARD ON THE JOB IT IS RESCUING', () => {
  const n = code('navigate.js')
  assert.ok(!/touchProgress|touchP\(/.test(n), 'no progress sink anywhere in navigate.js - that stamp was the 4-hour hang (D1)')
  assert.ok(!/beginHold\(/.test(n), 'and a nav leg may not declare a hold either')
})

t('THE FLOOR CALLS IT, AND ONLY ON EVIDENCE: the terminal action breaks the wedge it names', () => {
  const r = srcOf('reflexes.js')
  assert.ok(/nav\.unstick\(bot, null, \{ force: true/.test(r), 'the terminal action forces a rescue (the floor may not refuse itself)')
  assert.ok(/if \(pass > 1\) \{/.test(r), 'and only after a full reset has already run in THIS cell - a condition, never a timer')
  assert.ok(/HARD-WEDGED/.test(r), 'the verdict line survives as the honest end of the line')
})

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall unstick (one rescue path) tests passed')
process.exit(failures ? 1 : 0)
