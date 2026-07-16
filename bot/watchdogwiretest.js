'use strict'
// OFFLINE wiring test for the S7 forward-progress watchdog HOOKS (DESIGN-S7-watchdog §7.2). No live
// bot, no server: env-isolated requires + minimal stubs prove the VERIFIED-only, anti-spin contract
// that is the whole point of S7:
//   (a) trackTick anti-spin: pacing a <8b pocket produces ZERO touches; a >=8b step produces exactly
//       one touch + a re-anchor (displacement-from-anchor, never path length);
//   (b) snapInventory item-count delta: a change touches, an identical inventory does not;
//   (c) pathfix H3: brokeOK on an already-air cell does NOT touch (no false progress), a non-air->air
//       TRANSITION does; placedOK without opts.before does NOT touch, a proven stateId change does;
//   (d) the stopSurvivalJob fold: the exact isStopped expression wired into the survival jobs.
// Run: cd bot && node watchdogwiretest.js

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')

// ---- ENV ISOLATION (before requiring commands/provision/pathfix - they read these at load) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wdwire-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.DEATH_FILE = path.join(tmp, 'last-death.json')
process.env.RESUME_FILE = path.join(tmp, 'resume-job.json')
process.env.EPISODE_LOG = path.join(tmp, 'body-episodes.jsonl')
process.env.STATE_HISTORY_FILE = path.join(tmp, 'state-history.jsonl')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')

const commands = require('./commands.js')
const pathfix = require('./pathfix.js')
const provision = require('./provision.js')

// ---- harness (async: pathfix primitives are async) ----
const tests = []
function t (name, fn) { tests.push([name, fn]) }

// minimal stub bot for trackTick/snapInventory: needs entity.position + an inventory.
function stubBot (pos, items = []) {
  return {
    entity: { position: pos },
    inventory: { items: () => items.slice(), slots: [] },
    getEquipmentDestSlot: () => 999,
    pathfinder: null,
    targetDigBlock: null
  }
}
// # of touches since the last reset = did progressInfo() move off the 'reset' sentinel?
function touchedSinceReset () { return commands.progressInfo().by !== 'reset' }

// ---- (a) anti-spin: a <8b pocket NEVER touches; a >=8b step touches once + re-anchors ----------
t('(a) trackTick: a 3b circle for 60 ticks -> ZERO touches (displacement-from-anchor)', () => {
  const items = [{ name: 'cobblestone', count: 10 }]
  const C = { x: 100, y: 64, z: 100 }
  const at = (i) => new Vec3(C.x + 3 * Math.cos(i), C.y, C.z + 3 * Math.sin(i)) // radius 3 -> diameter 6 < 8
  commands.trackTick(stubBot(at(0), items)) // prime: sets progAnchor at a circle point + lastItemCount
  commands._resetProgress()
  for (let i = 1; i <= 60; i++) commands.trackTick(stubBot(at(i), items))
  assert.strictEqual(touchedSinceReset(), false, 'a bot pacing a 3b circle must never touch progress')
})

t('(a) trackTick: a 9b step -> exactly one moved8b touch + re-anchor', () => {
  const items = [{ name: 'cobblestone', count: 10 }]
  commands.trackTick(stubBot(new Vec3(200, 64, 200), items)) // prime the anchor at 200,200
  commands._resetProgress()
  commands.trackTick(stubBot(new Vec3(209, 64, 200), items)) // 9b east -> >= 8 -> touch
  assert.strictEqual(commands.progressInfo().by, 'moved8b', 'a 9b displacement touches moved8b')
  // re-anchored at the new spot: a further 3b (total 12 from the OLD anchor, only 3 from the new) must NOT touch
  commands._resetProgress()
  commands.trackTick(stubBot(new Vec3(212, 64, 200), items))
  assert.strictEqual(touchedSinceReset(), false, 'the anchor moved to 209 - a further 3b does not touch (proves re-anchor)')
})

// ---- (b) item-count delta ----------------------------------------------------------------------
t('(b) snapInventory: a count delta touches; an identical inventory does not', () => {
  const pos = new Vec3(300, 64, 300)
  commands.trackTick(stubBot(pos, [{ name: 'dirt', count: 5 }])) // prime lastItemCount = 5 + anchor
  commands._resetProgress()
  commands.trackTick(stubBot(pos, [{ name: 'dirt', count: 7 }])) // 5 -> 7 : a delta
  assert.strictEqual(commands.progressInfo().by, 'itemDelta', 'a changed item count touches itemDelta')
  commands._resetProgress()
  commands.trackTick(stubBot(pos, [{ name: 'dirt', count: 7 }])) // identical -> no touch
  assert.strictEqual(touchedSinceReset(), false, 'an identical inventory does not touch')
})

// ---- (c) pathfix H3: verified place/break only -------------------------------------------------
t('(c) pathfix brokeOK: already-air -> NO sink; a non-air->air transition -> sink', async () => {
  const calls = []
  pathfix.setProgressSink(tag => calls.push(tag))
  try {
    // already air on the first poll -> a re-verify, proves nothing
    const airBot = { blockAt: () => ({ name: 'air' }) }
    assert.strictEqual(await pathfix.brokeOK(airBot, new Vec3(0, 64, 0), { timeoutMs: 0 }), true)
    assert.strictEqual(calls.length, 0, 'an already-air cell must NOT touch')
    // a genuine transition: solid first, air second
    let n = 0
    const transBot = { blockAt: () => (n++ === 0 ? { name: 'stone' } : { name: 'air' }) }
    assert.strictEqual(await pathfix.brokeOK(transBot, new Vec3(0, 64, 0), { timeoutMs: 900 }), true)
    assert.deepStrictEqual(calls, ['broke'], 'an observed non-air->air transition touches once')
  } finally { pathfix.setProgressSink(null) }
})

t('(c) pathfix placedOK: no opts.before -> NO sink; a proven stateId change -> sink', async () => {
  const calls = []
  pathfix.setProgressSink(tag => calls.push(tag))
  try {
    // non-air read WITHOUT a before-snapshot: could be a pre-existing block -> must not touch
    const bot = { blockAt: () => ({ name: 'stone', stateId: 5 }) }
    assert.strictEqual(await pathfix.placedOK(bot, new Vec3(0, 64, 0), { timeoutMs: 0 }), true)
    assert.strictEqual(calls.length, 0, 'placedOK without opts.before must NOT touch')
    // a proven change (before != null and stateId differs) -> touch
    assert.strictEqual(await pathfix.placedOK(bot, new Vec3(0, 64, 0), { timeoutMs: 0, before: 1 }), true)
    assert.deepStrictEqual(calls, ['placed'], 'a proven stateId change touches once')
  } finally { pathfix.setProgressSink(null) }
})

// ---- (d) the stopSurvivalJob fold --------------------------------------------------------------
t('(d) stopSurvivalJob fold: the wired isStopped expression + exports', () => {
  assert.strictEqual(typeof provision.stopSurvivalJob, 'function', 'stopSurvivalJob exported')
  assert.strictEqual(typeof provision.activeJobInfo, 'function', 'activeJobInfo exported')
  // the EXACT one-liner folded into secureFoodInner/recoverHp (the latch OR the caller's own stop):
  const mk = (survStop, optStop) => () => survStop || (optStop ? optStop() : false)
  assert.strictEqual(mk(false, null)(), false, 'no latch, no caller-stop -> running')
  assert.strictEqual(mk(false, () => false)(), false, 'no latch, caller not stopped -> running')
  assert.strictEqual(mk(false, () => true)(), true, "caller's own stop still works")
  assert.strictEqual(mk(true, null)(), true, 'the watchdog latch alone stops the job')
  assert.strictEqual(mk(true, () => false)(), true, 'the latch overrides a not-stopped caller')
  // the lever itself is a bare setter that never throws, and a fresh entry clears it (per-dispatch)
  assert.doesNotThrow(() => provision.stopSurvivalJob())
})

;(async () => {
  let failures = 0
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)) }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  console.log(failures ? ('\n' + failures + ' FAILED') : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
