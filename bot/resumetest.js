'use strict'
// OFFLINE unit test for build persistence (DESIGN-build-persistence.md). No live server,
// no network. Isolates via RESUME_FILE pointed at a scratch path BEFORE requiring
// commands.js (commands.js:2956 reads it at load). Run:  cd bot && node resumetest.js
//
// Proves the four load-bearing behaviors:
//   - plain `stop` KEEPS the file (adds pausedAt), reply names the build
//   - a 0/2350 all-skipped finish KEEPS the file (finishDisposition -> pause)
//   - a genuine finish CLEARS it
//   - `cancelbuild` from an OPERATOR archives it; from BRAIN / undefined source it can't
//   - STOP_KEEPS_BUILD=0 restores today's destructive stop (regression lock, child proc)

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const SCRATCH = path.join(os.tmpdir(), 'resumetest-' + process.pid + '.json')
const ARCHIVE = SCRATCH + '.cancelled'
process.env.RESUME_FILE = SCRATCH
process.env.RESUME_HOLD_MS = '900000' // deterministic 15min hold for the pure-fn tests
delete process.env.STOP_KEEPS_BUILD // default ON

const commands = require('./commands.js')
const access = require('./access.js')

let failures = 0
async function t (name, fn) {
  try { await fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + ((e && e.stack) || e.message)) }
}

function seed (obj) {
  fs.writeFileSync(SCRATCH, JSON.stringify(Object.assign(
    { name: 'castle', at: { x: 430, y: 67, z: 85 }, savedAt: new Date().toISOString() }, obj || {})))
}
function readFile () { return JSON.parse(fs.readFileSync(SCRATCH, 'utf8')) }
function exists (p) { try { fs.accessSync(p || SCRATCH); return true } catch { return false } }
function cleanup () { for (const p of [SCRATCH, ARCHIVE]) { try { fs.unlinkSync(p) } catch {} } }

// Minimal offline stub bot (DESIGN §9).
const stubBot = { pathfinder: { setGoal () {}, setMovements () {} }, chat () {}, inventory: null, entity: { position: { x: 0, y: 64, z: 0 } } }

async function main () {
  cleanup()

  // ---- pure functions -----------------------------------------------------
  await t('finishDisposition: clear ONLY on a genuine finish; shortfall/aborted/errored KEEP', () => {
    assert.strictEqual(commands.finishDisposition(null), 'keep', 'errored/undefined -> never delete on a throw')
    assert.strictEqual(commands.finishDisposition({ deferred: true }), 'keep')
    assert.strictEqual(commands.finishDisposition({ stopped: true }), 'keep', 'aborted, not finished')
    assert.strictEqual(commands.finishDisposition({ stopped: false, skipped: 5, placed: 0, total: 2350 }), 'pause', 'the live killer: 0/2350 all-skipped')
    assert.strictEqual(commands.finishDisposition({ stopped: false, skipped: 0, placed: 5, total: 5 }), 'clear', 'placed everything -> real finish')
    assert.strictEqual(commands.finishDisposition({ stopped: false, skipped: 0, placed: 0, total: 0 }), 'clear', 'already-standing resume -> real finish')
  })

  await t('resumeHoldRemaining: no file / no pausedAt -> 0; fresh -> >0; expired/malformed -> 0', () => {
    const now = 1_700_000_000_000
    assert.strictEqual(commands.resumeHoldRemaining(null, now), 0, 'no file -> resume')
    assert.strictEqual(commands.resumeHoldRemaining({ name: 'castle' }, now), 0, 'no pausedAt -> resume')
    assert.ok(commands.resumeHoldRemaining({ pausedAt: now }, now) > 0, 'fresh pause -> held')
    assert.strictEqual(commands.resumeHoldRemaining({ pausedAt: now - 2_000_000 }, now), 0, '> hold elapsed -> resume')
    assert.strictEqual(commands.resumeHoldRemaining({ pausedAt: 'garbage' }, now), 0, 'malformed pausedAt -> fail open to resume')
    // per-pause hold (supervisor unstick): a short pauseHoldMs overrides the 15min default
    assert.strictEqual(commands.resumeHoldRemaining({ pausedAt: now - 120_000, pauseHoldMs: 60_000 }, now), 0, 'short supervisor hold elapsed -> resume (not held for 15min)')
    assert.ok(commands.resumeHoldRemaining({ pausedAt: now - 120_000 }, now) > 0, 'same age with the DEFAULT 15min hold -> still held (proves pauseHoldMs shortened it)')
    assert.ok(commands.resumeHoldRemaining({ pausedAt: now, pauseHoldMs: 60_000 }, now) > 0, 'fresh short-hold pause -> still held briefly')
  })

  // ---- stop = pause (flag ON) ---------------------------------------------
  await t('stop (flag on, operator): file KEPT, pausedAt stamped, reply names the build', async () => {
    seed()
    const r = await commands.handle(stubBot, 'stop', { source: 'operator' })
    assert.ok(exists(), 'file survives a stop')
    assert.ok(readFile().pausedAt, 'pausedAt stamped')
    assert.strictEqual(readFile().pausedWhy, 'operator stop')
    assert.match(r, /castle/, 'reply names the build')
    assert.match(r, /stays saved/, 'reply explains it is kept')
  })

  await t('stop with NO saved file: reply "stopped", no file created', async () => {
    cleanup()
    const r = await commands.handle(stubBot, 'stop', { source: 'operator' })
    assert.strictEqual(r, 'stopped', 'today\'s reply when nothing is saved')
    assert.ok(!exists(), 'no file conjured')
  })

  await t('a 0/2350 all-skipped finish PAUSES via finishDisposition (does not clear)', () => {
    // The exact live-killer result shape; the disposition is what gates the clear at both settle sites.
    assert.strictEqual(commands.finishDisposition({ stopped: false, skipped: 2350, placed: 0, total: 2350 }), 'pause')
    // and markResumePaused keeps the file with a stamp (proves the pause branch keeps intent on disk)
    seed()
    commands.markResumePaused('shortfall: 0/2350 placed, 2350 skipped')
    assert.ok(exists(), 'shortfall keeps the file')
    assert.ok(readFile().pausedAt, 'shortfall stamps a hold')
  })

  await t('a genuine finish CLEARS (finishDisposition -> clear, mirrors the settle-site gate)', () => {
    assert.strictEqual(commands.finishDisposition({ stopped: false, skipped: 0, placed: 2350, total: 2350 }), 'clear')
  })

  // ---- cancelbuild: operator-only, two-step, archive ----------------------
  await t('cancelbuild from BRAIN / undefined source is REFUSED, file intact', async () => {
    seed()
    const rb = await commands.handle(stubBot, 'cancelbuild confirm', { source: 'brain' })
    assert.match(rb, /operator-only/, 'brain source refused')
    assert.ok(exists(), 'file intact after brain cancel')
    const ru = await commands.handle(stubBot, 'cancelbuild confirm') // undefined source (2-arg call)
    assert.match(ru, /operator-only/, 'undefined source fails closed')
    assert.ok(exists(), 'file intact after undefined-source cancel')
  })

  await t('cancelbuild operator: arm -> confirm ARCHIVES (rename, not unlink)', async () => {
    seed(); try { fs.unlinkSync(ARCHIVE) } catch {}
    const arm = await commands.handle(stubBot, 'cancelbuild', { source: 'operator' })
    assert.match(arm, /cancelbuild confirm/, 'unarmed -> arm message')
    assert.match(arm, /castle/, 'arm names the build')
    assert.ok(exists() && !exists(ARCHIVE), 'arming changes nothing on disk')
    const conf = await commands.handle(stubBot, 'cancelbuild confirm', { source: 'operator' })
    assert.match(conf, /archived/, 'confirm -> archived reply')
    assert.ok(!exists(), 'original removed')
    assert.ok(exists(ARCHIVE), 'archived to .cancelled (recoverable, not unlinked)')
  })

  await t('cancelbuild confirm with NO fresh arm re-arms (stale window), file intact', async () => {
    seed() // cancelArmedAt is 0 after the prior archive -> a confirm now is "stale"
    const stale = await commands.handle(stubBot, 'cancelbuild confirm', { source: 'operator' })
    assert.match(stale, /within 60s/, 'stale confirm re-arms instead of deleting')
    assert.ok(exists(), 'file intact after a stale confirm')
  })

  await t('cancelbuild with no saved build: "no saved build to cancel"', async () => {
    cleanup()
    const r = await commands.handle(stubBot, 'cancelbuild confirm', { source: 'operator' })
    assert.match(r, /no saved build/, 'nothing to cancel')
  })

  // ---- CHEAT_CMDS double-gate --------------------------------------------
  await t('CHEAT_CMDS blocks cancelbuild/abandonbuild on the /cmd path; stop still passes', () => {
    assert.strictEqual(access.CHEAT_CMDS.test('cancelbuild confirm'), true, 'cancelbuild is a cheat cmd')
    assert.strictEqual(access.CHEAT_CMDS.test('abandonbuild'), true, 'abandonbuild alias blocked too')
    assert.strictEqual(access.CHEAT_CMDS.test('stop'), false, 'stop must stay available to the brain path')
  })

  // ---- resumebuild clears the pause hold ----------------------------------
  await t('resumebuild removes pausedAt (explicit resume clears the hold)', async () => {
    // guaranteed-missing schematic name: loadFile throws (no network), but the pausedAt-clear
    // runs BEFORE the load, so the file is left un-paused.
    seed({ name: '__resumetest_nope__', pausedAt: Date.now(), pausedWhy: 'operator stop' })
    await commands.handle(stubBot, 'resumebuild', { source: 'operator' })
    assert.ok(exists(), 'file kept')
    assert.strictEqual(readFile().pausedAt, undefined, 'pausedAt cleared')
    assert.strictEqual(readFile().name, '__resumetest_nope__', 'name/at preserved')
  })

  // ---- rollback: STOP_KEEPS_BUILD=0 restores today's destructive stop ------
  await t('STOP_KEEPS_BUILD=0: plain stop DELETES the file (regression lock)', () => {
    const child = SCRATCH + '.rollback.json'
    fs.writeFileSync(child, JSON.stringify({ name: 'castle', at: { x: 1, y: 2, z: 3 }, savedAt: 'x' }))
    const script = 'const c=require(' + JSON.stringify(path.join(__dirname, 'commands.js')) + ');' +
      'const b={pathfinder:{setGoal(){},setMovements(){}},chat(){},inventory:null,entity:{position:{x:0,y:64,z:0}}};' +
      'c.handle(b,"stop",{source:"operator"}).then(r=>{console.log("REPLY:"+r)});'
    const out = execFileSync(process.execPath, ['-e', script], {
      env: Object.assign({}, process.env, { STOP_KEEPS_BUILD: '0', RESUME_FILE: child }), encoding: 'utf8'
    })
    assert.match(out, /REPLY:stopped/, 'rollback reply is the plain "stopped"')
    assert.ok(!exists(child), 'rollback stop unlinks the file (today\'s behavior verbatim)')
    try { fs.unlinkSync(child) } catch {}
  })

  cleanup()
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'))
  process.exit(failures ? 1 : 0)
}

main()
