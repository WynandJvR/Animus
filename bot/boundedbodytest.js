'use strict'
// OFFLINE test for ROOT A (2026-08-02): BOUNDED BODY PRIMITIVES.
// No bot, no world, no server. Run:  cd bot && node boundedbodytest.js
//
// WHAT THIS PINS, and why it is worth ~11 seconds of wall clock:
// mineflayer's dig() ends in `await diggingTask.promise`, and that task settles ONLY via the
// per-position blockUpdate listener (digging.js:192, which returns early unless
// newBlock?.type === 0) or via stopDigging() (digging.js:165). On a chunk unload every
// blockUpdate listener is called with (null, null) - `null?.type !== 0` - so the task never
// settles; and by then finishDigging has nulled bot.targetDigBlock, which makes stopDigging()
// a NO-OP at digging.js:166. The await never returns. Every cooperative `isStopped()/deadline`
// loop in this codebase checks its latch at the TOP of the loop, so one such await freezes the
// executor forever, and (before ROOT E) the scheduler tick chain with it.
//
// The slow assertions below are the point: a 15-second race that must come back 'rejected'
// rather than 'HUNG' is the only honest way to prove the bound exists. Revert the bounding in
// pathfix.js and this file reports HUNG.

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const pathfix = require('./pathfix.js')

let failures = 0
const results = []
function ok (name) { results.push('PASS  ' + name) }
function bad (name, e) { failures++; results.push('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e)) }
function t (name, fn) { try { fn(); ok(name) } catch (e) { bad(name, e) } }
async function ta (name, fn) { try { await fn(); ok(name) } catch (e) { bad(name, e) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const never = () => new Promise(() => {})

// ---- 1. the bounded() contract ---------------------------------------------------------
async function contract () {
  await ta('bounded: a promise that settles first passes its VALUE through untouched', async () => {
    assert.strictEqual(await pathfix.bounded('t', Promise.resolve(7), 50), 7)
  })

  await ta('bounded: a promise that REJECTS before the deadline passes its error through untouched', async () => {
    const e = new Error('real dig failure')
    let caught = null
    try { await pathfix.bounded('t', Promise.reject(e), 500) } catch (x) { caught = x }
    assert.strictEqual(caught, e, 'the original error object, not a wrapper')
  })

  await ta('bounded: a never-settling promise is CUT, settle() runs exactly once, and it throws', async () => {
    let settles = 0
    const t0 = Date.now()
    let caught = null
    try { await pathfix.bounded('t', never(), 80, () => { settles++ }) } catch (e) { caught = e }
    const elapsed = Date.now() - t0
    assert.ok(caught, 'a cut MUST throw - a timeout may never look like success to a caller')
    assert.ok(/cut after 80ms/.test(caught.message), 'the error names the bound with its number: ' + caught.message)
    assert.strictEqual(settles, 1, 'the force-settle is sent once, not per poll')
    assert.ok(elapsed < 1000, 'the cut returns control promptly (' + elapsed + 'ms)')
  })

  await ta('bounded: the contract is DETERMINISTIC - it throws even when the settle DID land', async () => {
    let resolve = null
    const p = new Promise(r => { resolve = r })
    let caught = null
    try { await pathfix.bounded('t', p, 60, () => resolve('landed')) } catch (e) { caught = e }
    assert.ok(caught && /cut after 60ms/.test(caught.message),
      'a caller must never have to branch on whether the force-settle won the race')
  })

  await ta('bounded: a LATE settle produces no unhandled rejection and no caller continuation', async () => {
    const traps = []
    const onUnhandled = (r) => traps.push(r)
    process.on('unhandledRejection', onUnhandled)
    let rejectLate = null
    const p = new Promise((_, rj) => { rejectLate = rj })
    let ran = false
    try {
      await pathfix.bounded('t', p.then(() => { ran = true }), 60)
    } catch {}
    rejectLate(new Error('settled into a dead context'))
    await sleep(120)
    process.removeListener('unhandledRejection', onUnhandled)
    assert.strictEqual(traps.length, 0, 'a late settle must not become an unhandled rejection')
    assert.strictEqual(ran, false, 'no caller code may run on a late settle - that is the second-body-mover hazard')
  })
}

// ---- a minimal fake bot, just enough for installPathfinderTuning ------------------------
function makeFakeBot (opts = {}) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0), height: 1.62 }
  bot.game = { minY: -64, height: 384 }
  bot.targetDigBlock = null // THE LIVE-HANG SHAPE: finishDigging already ran
  bot.stopDiggingCalls = 0
  bot.stopDigging = function () { bot.stopDiggingCalls++ } // digging.js:166 no-ops when targetDigBlock is null
  bot.digTime = () => (opts.digTime != null ? opts.digTime : 0)
  bot.blockAt = (p) => opts.blockAt(p)
  bot.dig = opts.dig || (() => never())
  bot.look = opts.look || (() => never())
  bot.lookAt = async (point, force) => bot.look(0, 0, force)
  bot._placeBlockWithOptions = async () => {}
  bot.placeBlock = async () => {}
  bot.openBlock = async () => ({})
  bot.openEntity = async () => ({})
  bot.clearControlStates = () => {}
  bot.canDigBlock = () => true
  return bot
}

// ---- 2. the dig wrapper is WIRED (the mutation check) ----------------------------------
async function digWiring () {
  const pos = new Vec3(10, 64, 10)
  const solid = { name: 'stone', position: pos, boundingBox: 'block', type: 1 }
  const emitted = []
  const bot = makeFakeBot({ digTime: 0, blockAt: () => solid, dig: () => never() })
  bot.on('blockUpdate:' + pos, (o, n) => emitted.push(n))
  pathfix.installPathfinderTuning(bot)

  const t0 = Date.now()
  const verdict = await Promise.race([
    bot.dig(solid).then(() => 'resolved', () => 'rejected'),
    sleep(25000).then(() => 'HUNG')
  ])
  const elapsed = Date.now() - t0

  await ta('dig wrapper: a never-settling mineflayer dig is CUT, not hung (MUTATION CHECK)', async () => {
    assert.strictEqual(verdict, 'rejected',
      "a hung dig must come back as a FAILURE through the failure path all 55 call sites already have " +
      "(got '" + verdict + "' after " + elapsed + "ms). 'HUNG' here means the bound in pathfix.js is gone.")
    // digTime 0 + DIG_GRACE_MS, plus the wrapper's own 150ms phantom-check pause
    assert.ok(elapsed < pathfix.DIG_GRACE_MS + 2000, 'cut near the physics-derived bound, not later (' + elapsed + 'ms)')
  })

  await ta('dig force-settle: with targetDigBlock already null, the per-position blockUpdate IS the settle', async () => {
    assert.ok(bot.stopDiggingCalls >= 1, 'path 1 (stopDigging) is still attempted first')
    assert.strictEqual(emitted.length, 1, 'path 2 fired exactly once')
    assert.strictEqual(emitted[0] && emitted[0].type, 0,
      'onBlockUpdate (digging.js:192) returns early unless newBlock.type === 0 - a settle that is not type 0 settles nothing')
  })
}

// ---- 3. the look wrapper ---------------------------------------------------------------
async function lookWiring () {
  let forced = 0
  const bot = makeFakeBot({
    blockAt: () => null,
    look: (yaw, pitch, force) => { if (force) { forced++; return Promise.resolve() } return never() }
  })
  pathfix.installPathfinderTuning(bot)

  const t0 = Date.now()
  const verdict = await Promise.race([
    bot.look(1.5, 0, false).then(() => 'resolved', e => 'rejected: ' + e.message),
    sleep(8000).then(() => 'HUNG')
  ])
  const elapsed = Date.now() - t0

  await ta('look wrapper: a stalled non-forced look is cut and completed as a FORCED look (MUTATION CHECK)', async () => {
    assert.strictEqual(verdict, 'resolved',
      "a cut look is a SUCCESS - the settle action performs the exact look that was requested, forced " +
      "(got '" + verdict + "'). 'HUNG' means the look bound in pathfix.js is gone.")
    assert.strictEqual(forced, 1, 'the settle called the underlying look ONCE with force=true')
    assert.ok(elapsed < pathfix.LOOK_BOUND_MS + 3000, 'resolved near the bound (' + elapsed + 'ms)')
  })

  await ta('look wrapper: an explicitly FORCED look is passed straight through (it cannot hang)', async () => {
    const before = forced
    await bot.look(0.2, 0, true)
    assert.strictEqual(forced, before + 1, 'no bounding machinery on the path the pathfinder ticks')
  })
}

// ---- 4. composition with the existing phantom-failure swallow --------------------------
async function composition () {
  const pos = new Vec3(-4, 40, 7)
  const solid = { name: 'stone', position: pos, boundingBox: 'block', type: 1 }
  const air = { name: 'air', position: pos, boundingBox: 'empty', type: 0 }
  let gone = false
  const bot = makeFakeBot({ digTime: 0, blockAt: () => (gone ? air : solid), dig: () => never() })
  bot.on('blockUpdate:' + pos, () => { gone = true }) // the world says the block really did break
  pathfix.installPathfinderTuning(bot)

  const verdict = await Promise.race([
    bot.dig(solid).then(() => 'resolved', () => 'rejected'),
    sleep(25000).then(() => 'HUNG')
  ])
  await ta('composition: a CUT dig whose block is actually gone still resolves as the success it was', async () => {
    assert.strictEqual(verdict, 'resolved',
      "the cut throws into the wrapper's existing catch, which re-reads the world via brokeOK - " +
      "so the phantom-failure swallow keeps working through the new path (got '" + verdict + "')")
  })
}

// ---- 5. the constants are plain, exported consts - NOT env flags -----------------------
function constants () {
  t('ROOT A adds NO new env flag: the bounds are plain exported consts', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'pathfix.js'), 'utf8')
    for (const n of ['DIG_GRACE_MS', 'LOOK_BOUND_MS', 'CUT_SETTLE_GRACE_MS']) {
      assert.strictEqual(typeof pathfix[n], 'number', n + ' is exported for tests')
      assert.ok(new RegExp('const ' + n + '\\s*=\\s*\\d').test(src), n + ' is a literal const, not read from process.env')
    }
    assert.ok(pathfix.DIG_GRACE_MS > 0 && pathfix.LOOK_BOUND_MS > 0 && pathfix.CUT_SETTLE_GRACE_MS > 0)
  })
}

;(async () => {
  constants()
  await contract()
  // the two slow wrapper races are independent - run them concurrently so the whole file is
  // one bound long, not three
  await Promise.all([digWiring(), lookWiring(), composition()])
  for (const r of results) console.log(r)
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
