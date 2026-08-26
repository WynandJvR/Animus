'use strict'
// ==== CONTRACT TESTS FOR navigate.gotoOnce's deadline (progress-based, caller-capped) =========
// Run:  cd bot && node gototest.js
// `ms` = how long an attempt may go WITHOUT PROGRESS (a dig, or new ground >= 1b in XZ);
// `gopts.hardMs` = the absolute cap the caller owns; omitted => cap = ms (the old wall clock).
const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gototest-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.SCAFFOLD_FILE = path.join(tmp, 'scaffold-registry.json')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')
process.env.NAV_TERRAIN_PROFILE = '0'
const nav = require('./navigate.js')

function fakeBot () {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  bot.inventory = { items: () => [] }
  bot.blockAt = () => null
  bot.pathfinder = { goal: null, setGoal (g) { this.goal = g }, goto () { return new Promise(() => {}) } } // never arrives
  return bot
}
const now = () => Date.now()
let passed = 0
async function t (name, fn) { await fn(); passed++; console.log('  ok  ' + name) }

;(async () => {
  await t('no progress at all -> rejects at ~ms with the load-bearing prefix', async () => {
    const bot = fakeBot(); const t0 = now()
    await assert.rejects(nav.gotoOnce(bot, {}, 600), { message: /^goto timed out/ })
    const took = now() - t0
    assert(took >= 550 && took < 1200, 'took ' + took)
  })
  await t('hardMs omitted -> the cap is ms even while progressing (old wall clock)', async () => {
    const bot = fakeBot(); const t0 = now()
    const dig = setInterval(() => bot.emit('diggingCompleted', {}), 150)
    await assert.rejects(nav.gotoOnce(bot, {}, 600), { message: /^goto timed out/ })
    clearInterval(dig)
    const took = now() - t0
    assert(took >= 550 && took < 1200, 'took ' + took)
  })
  await t('digs are progress: keeps going past ms, stops at the hard cap and says so', async () => {
    const bot = fakeBot(); const t0 = now()
    const dig = setInterval(() => bot.emit('diggingCompleted', {}), 200)
    await assert.rejects(nav.gotoOnce(bot, {}, 600, { hardMs: 1600 }), { message: /^goto timed out \(hard cap 2s reached while still progressing, \d+ dig\(s\)\)/ })
    clearInterval(dig)
    const took = now() - t0
    assert(took >= 1500 && took < 2300, 'took ' + took)
  })
  await t('new ground in XZ is progress; bobbing in Y is not', async () => {
    const bot = fakeBot(); const t0 = now()
    const walk = setInterval(() => { bot.entity.position = bot.entity.position.offset(1.1, 0, 0) }, 200)
    await assert.rejects(nav.gotoOnce(bot, {}, 600, { hardMs: 1400 }), { message: /hard cap/ })
    clearInterval(walk)
    assert(now() - t0 >= 1300, 'walking kept it alive to the cap')
    const bot2 = fakeBot(); const t1 = now()
    const bob = setInterval(() => { bot2.entity.position = bot2.entity.position.offset(0, bot2.entity.position.y > 64 ? -1.2 : 1.2, 0) }, 200)
    await assert.rejects(nav.gotoOnce(bot2, {}, 600, { hardMs: 3000 }), { message: /^goto timed out$/ })
    clearInterval(bob)
    const took = now() - t1
    assert(took < 1200, 'bobbing did not count as progress: ' + took)
  })
  await t('progress then silence -> cut ms after the LAST progress, with the numbers', async () => {
    const bot = fakeBot(); const t0 = now()
    let n = 0
    const dig = setInterval(() => { if (++n <= 3) bot.emit('diggingCompleted', {}) }, 200)
    await assert.rejects(nav.gotoOnce(bot, {}, 600, { hardMs: 5000 }), { message: /^goto timed out \(no progress for 1s after 1s, 3 dig\(s\)\)/ })
    clearInterval(dig)
    const took = now() - t0
    assert(took >= 1150 && took < 1700, 'took ' + took)
  })
  await t('arrival resolves immediately and clears the watch (no timer leak)', async () => {
    const bot = fakeBot()
    bot.pathfinder.goto = () => Promise.resolve()
    await nav.gotoOnce(bot, {}, 600, { hardMs: 5000 })
    assert.strictEqual(bot.listenerCount('diggingCompleted'), 0)
  })
  await t('truncatePartialPlan: a partial plan is cut before its first dig/place; a complete one is untouched', async () => {
    const pf = require('./pathfix.js')
    const mk = (n, brk, plc) => ({ x: n, y: 0, z: 0, toBreak: brk ? [{ x: n, y: 1, z: 0 }] : [], toPlace: plc ? [{ x: n, y: -1, z: 0 }] : [] })
    const p1 = [mk(1), mk(2), mk(3, true), mk(4), mk(5, false, true)]
    assert.strictEqual(pf.truncatePartialPlan(p1, 'partial'), 3); assert.strictEqual(p1.length, 2)
    const p2 = [mk(1), mk(2, true)]
    assert.strictEqual(pf.truncatePartialPlan(p2, 'success'), 0); assert.strictEqual(p2.length, 2)
    const p3 = [mk(1), mk(2)]
    assert.strictEqual(pf.truncatePartialPlan(p3, 'partial'), 0); assert.strictEqual(p3.length, 2)
    const p4 = [mk(1, true)]
    assert.strictEqual(pf.truncatePartialPlan(p4, 'partial'), 1); assert.strictEqual(p4.length, 0)
  })
  console.log('gototest: ' + passed + ' passed')
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
