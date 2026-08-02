'use strict'
// OFFLINE test for ROOT F (2026-08-02): bot.craft is BOUNDED.
// No bot, no world, no server. Run:  cd bot && node craftboundtest.js
//
// WHAT THIS PINS, and the correction it encodes:
// The brief said craft.js:40's `await once(bot,'windowOpen')` has NO timeout. It does:
// `once(emitter, event, timeout = 20000)` (mineflayer/lib/promise_utils.js:75) and
// onceWithCleanup removes the listener when that fires (:70). provision.js:2872's
// `if (!/windowOpen/.test(e.message))` retry is the live proof - that error is reachable.
//
// The real defect is that EVERY window round-trip in a craft carries its own 20s allowance: the
// open, each grid click via waitForWindowUpdate -> once(window,'updateSlot:0')
// (inventory.js:456-459), and putAway's once(window,'updateSlot:N') (:650). A 3x3 recipe is up to
// 20 of them, so one craft can hold the body for minutes. Live 2026-08-02: the recovery ladder ran
// `craft:crafting_table > craft:stick > craft:wooden_hoe` from the crawlspace under the hut floor
// where no table could be reached, and the watchdog measured `no verified progress for 154s`
// before revoking the slot - then the ladder re-dispatched and did it again.
//
// The bound is 2 x mineflayer's own WINDOW_TIMEOUT (inventory.js:16) per craftOnce, x count -
// deliberately HALF `once`'s 20s default so it wins deterministically instead of racing it.

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')
const pathfix = require('./pathfix.js')

let failures = 0
const results = []
function ok (name) { results.push('PASS  ' + name) }
function bad (name, e) { failures++; results.push('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e)) }
function t (name, fn) { try { fn(); ok(name) } catch (e) { bad(name, e) } }
async function ta (name, fn) { try { await fn(); ok(name) } catch (e) { bad(name, e) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const never = () => new Promise(() => {})

function makeFakeBot (opts = {}) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0), height: 1.62 }
  bot.game = { minY: -64, height: 384 }
  bot.targetDigBlock = null
  bot.stopDigging = () => {}
  bot.digTime = () => 0
  bot.blockAt = () => null
  bot.dig = () => never()
  bot.look = () => never()
  bot.lookAt = async () => {}
  bot._placeBlockWithOptions = async () => {}
  bot.placeBlock = async () => {}
  bot.openBlock = async () => ({})
  bot.openEntity = async () => ({})
  bot.clearControlStates = () => {}
  bot.canDigBlock = () => true
  bot.registry = { items: { 7: { name: 'wooden_hoe' } } }
  bot.closedWindows = []
  bot.currentWindow = opts.window || null
  bot.closeWindow = (w) => { bot.closedWindows.push(w && w.type); if (bot.currentWindow === w) bot.currentWindow = null }
  bot.craft = opts.craft || (() => never())
  return bot
}
const HOE = { result: { id: 7, count: 1 }, requiresTable: true }
const TABLE = { position: new Vec3(1, 64, 0), name: 'crafting_table' }

// ---- 1. the hang case, and the mutation check ------------------------------------------
async function cutCase () {
  // the LIVE shape: craft parks on `once(bot,'windowOpen')` and never comes back in time.
  const bot = makeFakeBot({
    window: { type: 'minecraft:crafting_table', id: 3 },
    craft: function () { bot.addListener('windowOpen', bot.__craftWait = () => {}); return never() }
  })
  const preExisting = () => {}
  bot.addListener('windowOpen', preExisting) // somebody else's open, in flight
  pathfix.installPathfinderTuning(bot)

  const t0 = Date.now()
  const verdict = await Promise.race([
    bot.craft(HOE, 1, TABLE).then(() => 'resolved', e => ({ rejected: e.message })),
    sleep(pathfix.CRAFT_BOUND_MS + 15000).then(() => 'HUNG')
  ])
  const elapsed = Date.now() - t0

  await ta('craft wrapper: a craft that will not complete is CUT, not left holding the body (MUTATION CHECK)', async () => {
    assert.notStrictEqual(verdict, 'HUNG',
      'a craft that outlives its bound must come back as a FAILURE through the failure path every ' +
      'call site already has. HUNG here means the craft bound in pathfix.js is gone.')
    assert.ok(verdict && verdict.rejected, 'a cut craft is a FAILURE - crafting did not happen, and no caller may read it as success')
    assert.ok(/cut after 10000ms/.test(verdict.rejected), 'the error names the bound with its number: ' + verdict.rejected)
    assert.ok(elapsed < pathfix.CRAFT_BOUND_MS + 3000, 'cut near the bound, not later (' + elapsed + 'ms)')
  })

  await ta('craft force-settle: THIS craft\'s pending windowOpen wait is unhooked, nobody else\'s is', async () => {
    const left = bot.listeners('windowOpen')
    assert.ok(!left.includes(bot.__craftWait),
      'left in place it is a live one-shot listener: the next window ANY job opens resolves the abandoned ' +
      'craft, which reads a chest as its table, throws, and craft()\'s catch CLOSES THAT WINDOW under the ' +
      'job that opened it (craft.js:28-31) - a second body-mover, minutes late')
    assert.ok(left.includes(preExisting), 'a concurrent opener\'s listener is never touched')
  })

  await ta('craft force-settle: our own crafting window is closed - the library\'s own error-path cleanup', async () => {
    assert.deepStrictEqual(bot.closedWindows, ['minecraft:crafting_table'],
      'craft() closes the table window on ANY error (craft.js:28-31); while its promise is pending that ' +
      'path is unreachable, so the settle performs it')
  })
}

async function foreignWindowCase () {
  const bot = makeFakeBot({ window: { type: 'minecraft:generic_9x3', id: 4 }, craft: () => never() })
  pathfix.installPathfinderTuning(bot)
  // raced, not awaited bare: with the bound removed this await never returns, and a test that
  // hangs is a test that reports nothing - the mutation check has to be able to SAY it failed.
  const verdict = await Promise.race([
    bot.craft(HOE, 1, TABLE).then(() => 'resolved', () => 'rejected'),
    sleep(pathfix.CRAFT_BOUND_MS + 15000).then(() => 'HUNG')
  ])
  await ta('craft force-settle: a CHEST window is somebody else\'s and is never closed', async () => {
    assert.notStrictEqual(verdict, 'HUNG', 'the bound must have cut this craft')
    assert.deepStrictEqual(bot.closedWindows, [],
      'the settle is narrow on purpose - closing a container another job is reading is exactly the ' +
      'failure the unhooking above exists to prevent')
  })
}

// ---- 2. passthrough: the bound must be invisible to a healthy craft ---------------------
async function passthrough () {
  await ta('craft wrapper: a craft that completes passes straight through', async () => {
    const bot = makeFakeBot({ craft: async () => 'made it' })
    pathfix.installPathfinderTuning(bot)
    assert.strictEqual(await bot.craft(HOE, 1, TABLE), 'made it')
    assert.deepStrictEqual(bot.closedWindows, [], 'no settle runs when nothing was cut')
  })
  await ta('craft wrapper: a real craft ERROR passes through untouched (missing ingredient, etc.)', async () => {
    const boom = new Error('missing ingredient')
    const bot = makeFakeBot({ craft: async () => { throw boom } })
    pathfix.installPathfinderTuning(bot)
    let caught = null
    try { await bot.craft(HOE, 1, TABLE) } catch (e) { caught = e }
    assert.strictEqual(caught, boom, 'the original error object, not a wrapper - callers match on its text')
  })
}

// ---- 3. the bound is derived, scales with count, and is not an env flag -----------------
function shape () {
  const src = fs.readFileSync(path.join(__dirname, 'pathfix.js'), 'utf8')

  t('the bound is derived from mineflayer\'s own WINDOW_TIMEOUT, not an invented round number', () => {
    assert.strictEqual(pathfix.WINDOW_TIMEOUT_MS, 5000, "mineflayer's WINDOW_TIMEOUT (inventory.js:16), restated")
    assert.strictEqual(pathfix.CRAFT_BOUND_MS, 10000)
    assert.ok(/const CRAFT_BOUND_MS = WINDOW_TIMEOUT_MS \* 2/.test(src),
      'the number must be spelled as its derivation, so the reasoning cannot drift away from the value')
    assert.ok(pathfix.CRAFT_BOUND_MS * 2 <= 20000,
      "and it must stay at or below once()'s 20s default, or our bound races the engine's own timeout")
  })

  t('the bound scales with `count` - bot.craft loops craftOnce that many times (craft.js:19-21)', () => {
    assert.ok(/CRAFT_BOUND_MS \* n/.test(src), 'a per-craft budget, not a per-call one')
  })

  t('ROOT F adds NO new env flag: the bounds are plain exported consts', () => {
    for (const n of ['WINDOW_TIMEOUT_MS', 'CRAFT_BOUND_MS']) {
      assert.strictEqual(typeof pathfix[n], 'number', n + ' is exported for tests')
      assert.ok(new RegExp('const ' + n + '\\s*=\\s*[^p]').test(src), n + ' is a literal const, not read from process.env')
    }
    const i = src.indexOf('const origCraft =')
    assert.ok(i > 0 && !/process\.env/.test(src.slice(i, i + 1200)), 'no flag on the craft wrapper either')
  })

  t('the craft wrapper lives in installPathfinderTuning, beside dig and look - zero call sites migrate', () => {
    const i = src.indexOf('function installPathfinderTuning')
    const fn = src.slice(i)
    assert.ok(/bot\.craft = async function \(recipe, count, craftingTable\)/.test(fn), 'wrapped at install time')
    assert.ok(/bounded\('craft /.test(fn), 'through the SAME bounded() primitive as dig and look, not a parallel one')
  })

  t('EVERY bot.craft( call site in bot/ is awaited, so a cut is seen as the failure it is', () => {
    const sites = []
    for (const f of fs.readdirSync(__dirname)) {
      if (!f.endsWith('.js') || /test/.test(f)) continue
      const txt = fs.readFileSync(path.join(__dirname, f), 'utf8')
      txt.split(/\r?\n/).forEach((line, n) => { // CRLF in this repo - splitting on \n alone leaves a \r that defeats `$`
        const code = line.replace(/\/\/.*$/, '') // a prose mention of bot.craft( is not a call site
        if (/\bbot\.craft\(/.test(code)) sites.push({ f, n: n + 1, line: code.trim() })
      })
    }
    assert.ok(sites.length >= 12, 'expected the 12 known call sites, found ' + sites.length)
    const unawaited = sites.filter(s => !/await bot\.craft\(/.test(s.line))
    assert.deepStrictEqual(unawaited.map(s => s.f + ':' + s.n), [],
      'an un-awaited craft would turn a bounded cut into an unhandled rejection instead of a failure')
  })
}

;(async () => {
  shape()
  await Promise.all([cutCase(), foreignWindowCase(), passthrough()])
  for (const r of results) console.log(r)
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
