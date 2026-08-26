'use strict'
// ==== CONTRACT TESTS FOR body.js (body liveness + re-arm) ==================================
// Run:  cd bot && node bodytest.js
//
// The pure half (simulatingAt / shouldRearm) is tested on plain numbers. The wired half is
// tested against a FAKE bot: an EventEmitter with a fake _client, so the exact mineflayer
// switch sequence can be replayed - mount, entityGone-dismount with no teleport, a respawn whose
// position sync never comes - and the module's re-arm is observed by what it WRITES and EMITS,
// never by what it intended (DESIGN-PRINCIPLES #10).

const assert = require('assert')
const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const body = require('./body.js')

let passed = 0
function t (name, fn) { fn(); passed++; console.log('  ok  ' + name) }

// ---- pure ----------------------------------------------------------------------------------
t('simulatingAt: never ticked -> not simulating', () => assert.strictEqual(body.simulatingAt(0, 10000), false))
t('simulatingAt: a tick 100ms ago -> simulating', () => assert.strictEqual(body.simulatingAt(9900, 10000), true))
t('simulatingAt: a tick SILENCE_MS ago -> not simulating', () => assert.strictEqual(body.simulatingAt(10000 - body.SILENCE_MS, 10000), false))

const base = { connected: true, alive: true, hasEntity: true, lastPositionAt: 1000, lastTickAt: 1500, deadSince: 2000, lastRearmAt: 0 }
const now = 2000 + body.SILENCE_MS
t('shouldRearm: the full set of facts -> re-arm', () => assert.strictEqual(body.shouldRearm(base, now), true))
t('shouldRearm: not connected -> no', () => assert.strictEqual(body.shouldRearm({ ...base, connected: false }, now), false))
t('shouldRearm: dead (isAlive false) -> no, the respawn path owns it', () => assert.strictEqual(body.shouldRearm({ ...base, alive: false }, now), false))
t('shouldRearm: no entity -> no', () => assert.strictEqual(body.shouldRearm({ ...base, hasEntity: false }, now), false))
t('shouldRearm: no server position yet this connection -> no (login path owns it)', () => assert.strictEqual(body.shouldRearm({ ...base, lastPositionAt: 0 }, now), false))
t('shouldRearm: still ticking -> no', () => assert.strictEqual(body.shouldRearm({ ...base, lastTickAt: now - 100 }, now), false))
t('shouldRearm: silent for less than SILENCE_MS -> no', () => assert.strictEqual(body.shouldRearm(base, 2000 + body.SILENCE_MS - 1), false))
t('shouldRearm: a position sync just arrived -> no (its delayed re-arm is pending)', () => assert.strictEqual(body.shouldRearm({ ...base, lastPositionAt: now - 500 }, now), false))
t('shouldRearm: re-armed a moment ago -> no (verdict first)', () => assert.strictEqual(body.shouldRearm({ ...base, lastRearmAt: now - 1000 }, now), false))

t('not installed (an offline harness, a bot before install) -> simulating() is TRUE: unmeasured is not paralysed', () => {
  body._reset()
  assert.strictEqual(body.simulating(), true)
  assert.strictEqual(body.offForMs(), 0)
  assert.strictEqual(body.info({}).measured, false)
})

// ---- wired: a fake bot --------------------------------------------------------------------
function fakeBot () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.writes = []
  bot._client.write = (name, p) => bot._client.writes.push({ name, p })
  bot.isAlive = true
  bot.vehicle = null
  bot.entity = { position: new Vec3(10.5, 64, -3.5), yaw: 1.2, pitch: 0.1 }
  bot.dismounts = 0
  bot.dismount = () => { bot.dismounts++ }
  return bot
}
const notes = []
body.setNoteSink(m => notes.push(m))

// Time is driven by a fake clock so SILENCE_MS is exercised without sleeping.
const realNow = Date.now
let clock = 100000
Date.now = () => clock

function freshBot () {
  body._reset(); notes.length = 0
  const bot = fakeBot()
  body.install(bot)
  bot.emit('login')
  bot._client.emit('position', { teleportId: 7, x: 10.5, y: 64, z: -3.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} })
  return bot
}
function tick (bot) { bot.emit('physicsTick') }

t('a ticking body is simulating and check() re-arms nothing', () => {
  const bot = freshBot()
  for (let i = 0; i < 5; i++) { clock += 50; tick(bot) }
  clock += 1000; body.check(bot)
  assert.strictEqual(body.simulating(), true)
  assert.strictEqual(body.info(bot).rearms, 0)
  assert.strictEqual(bot._client.listenerCount('position') > 0, true)
})

t('a mount then an entityGone-dismount (no teleport) is re-armed by a synthesized position sync', () => {
  const bot = freshBot()
  clock += 3500 // past the login sync's own window
  for (let i = 0; i < 3; i++) { clock += 50; tick(bot) }
  // GSit-style: the server seats us (physics OFF in mineflayer) and later removes the seat.
  bot.vehicle = { id: 99, name: 'armor_stand' }; bot.emit('mount')
  bot.vehicle = null; bot.emit('dismount', { id: 99, name: 'armor_stand' })
  // ...and nothing ticks any more. Walk the 1s check() cadence.
  let synthesized = null
  bot._client.on('position', p => { synthesized = p })
  for (let s = 0; s < 6 && !synthesized; s++) { clock += 1000; body.check(bot) }
  assert.ok(synthesized, 'a position sync was synthesized')
  assert.strictEqual(synthesized.x, 10.5); assert.strictEqual(synthesized.y, 64); assert.strictEqual(synthesized.z, -3.5)
  assert.strictEqual(synthesized.teleportId, 7, 'confirms the LAST REAL teleport id, never an invented one')
  assert.deepStrictEqual(synthesized.flags, { x: false, y: false, z: false, yaw: false, pitch: false }, 'absolute, so the position does not move')
  assert.ok(notes.some(n => /SIMULATION OFF/.test(n) && /dismount\(armor_stand#99\)/.test(n)), 'the OFF line names the event that preceded it: ' + notes.join(' | '))
  assert.strictEqual(body.info(bot).rearms, 1)
  // the library's handler would resume ticks; simulate that and the verdict is logged as success
  clock += 100; tick(bot); clock += 1000; body.check(bot)
  assert.ok(notes.some(n => /re-armed via position-sync/.test(n) && /ticking again/.test(n)), notes.join(' | '))
})

t('a still-mounted body is re-armed by DISMOUNTING, not by a position sync', () => {
  const bot = freshBot()
  clock += 3500
  for (let i = 0; i < 3; i++) { clock += 50; tick(bot) }
  bot.vehicle = { id: 5, name: 'boat' }; bot.emit('mount')
  let synthesized = false
  bot._client.on('position', () => { synthesized = true })
  for (let s = 0; s < 6 && bot.dismounts === 0; s++) { clock += 1000; body.check(bot) }
  assert.strictEqual(bot.dismounts, 1, 'dismount was requested')
  assert.strictEqual(synthesized, false, 'no synthesized sync while mounted - the server teleports us on dismount')
})

t('a respawn whose position sync never arrives is re-armed after SILENCE_MS, not inside the library\'s own 1.5s window', () => {
  const bot = freshBot()
  clock += 3500
  for (let i = 0; i < 3; i++) { clock += 50; tick(bot) }
  bot.isAlive = false; bot.emit('death'); bot.emit('respawn')
  bot.isAlive = true; bot.emit('spawn')
  let synthAt = 0
  bot._client.on('position', () => { synthAt = clock })
  const t0 = clock
  for (let s = 0; s < 8 && !synthAt; s++) { clock += 1000; body.check(bot) }
  assert.ok(synthAt, 'a sync was synthesized')
  assert.ok(synthAt - t0 >= body.SILENCE_MS, 'waited at least SILENCE_MS (' + (synthAt - t0) + 'ms)')
})

t('while DEAD (isAlive false) nothing is re-armed, however long the silence', () => {
  const bot = freshBot()
  clock += 3500
  for (let i = 0; i < 3; i++) { clock += 50; tick(bot) }
  bot.isAlive = false; bot.emit('death')
  let synthesized = false
  bot._client.on('position', () => { synthesized = true })
  for (let s = 0; s < 30; s++) { clock += 1000; body.check(bot) }
  assert.strictEqual(synthesized, false)
  assert.strictEqual(body.info(bot).rearms, 0)
})

t('a fresh login with NO server position yet is left to the library (no re-arm at 0,0,0)', () => {
  body._reset(); notes.length = 0
  const bot = fakeBot(); bot.entity.position = new Vec3(0, 0, 0)
  body.install(bot)
  bot.emit('login')
  let synthesized = false
  bot._client.on('position', () => { synthesized = true })
  for (let s = 0; s < 30; s++) { clock += 1000; body.check(bot) }
  assert.strictEqual(synthesized, false)
})

t('a failed re-arm is reported as such and not repeated inside REARM_GAP_MS', () => {
  const bot = freshBot()
  clock += 3500
  for (let i = 0; i < 3; i++) { clock += 50; tick(bot) }
  bot.emit('mount'); bot.emit('dismount', null)
  let syncs = 0
  bot._client.on('position', () => { syncs++ })
  for (let s = 0; s < 10; s++) { clock += 1000; body.check(bot) } // no ticks ever resume (silence is measured from the LAST TICK, so 3 of these are still 'simulating')
  assert.strictEqual(syncs, 1, 'exactly one re-arm inside the gap (' + syncs + ')')
  assert.ok(notes.some(n => /did NOT restore ticks/.test(n)), notes.join(' | '))
  assert.strictEqual(body.info(bot).rearmsFailed, 1)
  assert.strictEqual(body.info(bot).simulating, false)
  assert.ok(body.offForMs() >= body.SILENCE_MS)
})

t('info() is honest: off -> hz 0 and offForSec counts; disconnect clears the silence', () => {
  const bot = freshBot()
  clock += 3500
  for (let i = 0; i < 3; i++) { clock += 50; tick(bot) }
  bot.emit('mount'); bot.emit('dismount', null)
  for (let s = 0; s < 8; s++) { clock += 1000; body.check(bot) }
  const i1 = body.info(bot)
  assert.strictEqual(i1.simulating, false); assert.strictEqual(i1.hz, 0); assert.ok(i1.offForSec >= 3)
  bot.emit('end', 'socketClosed')
  clock += 1000; body.check(bot)
  assert.strictEqual(body.offForMs(), 0)
})

t('ground flag: a position packet claiming onGround=false while standing on a full block is corrected to true; mid-air stays false', () => {
  body._reset(); notes.length = 0
  const bot = fakeBot()
  const sent = []
  bot._client.write = (name, p) => { sent.push({ name, p }) }
  const solid = { boundingBox: 'block', name: 'grass_block', shapes: [[0, 0, 0, 1, 1, 1]] }
  bot.blockAt = (v) => (v.y === 63 ? solid : { boundingBox: 'empty', name: 'air', shapes: [] })
  bot.entity.velocity = { x: 0, y: -0.08, z: 0 }
  body.install(bot)
  bot._client.write('position_look', { x: 10.5, y: 64, z: -3.5, yaw: 0, pitch: 0, onGround: false, flags: { onGround: false, hasHorizontalCollision: undefined } })
  assert.strictEqual(sent[0].p.onGround, true, 'standing on grass at y=64 -> true')
  assert.strictEqual(sent[0].p.flags.onGround, true)
  assert.strictEqual(body.info(bot).groundFixes, 1)
  bot.entity.position = new Vec3(10.5, 64.42, -3.5) // mid-jump: nothing under the feet at 64.41
  bot._client.write('position', { x: 10.5, y: 64.42, z: -3.5, onGround: false, flags: { onGround: false } })
  assert.strictEqual(sent[1].p.onGround, false, 'mid-air stays false')
  bot.entity.position = new Vec3(10.5, 64, -3.5); bot.entity.velocity = { x: 0, y: 0.42, z: 0 } // first frame of a jump, still at ground height
  bot._client.write('position', { x: 10.5, y: 64, z: -3.5, onGround: false, flags: { onGround: false } })
  assert.strictEqual(sent[2].p.onGround, false, 'rising -> not on ground')
  bot.entity.velocity = { x: 0, y: 0, z: 0 }
  bot._client.write('position', { x: 10.5, y: 64, z: -3.5, onGround: true, flags: { onGround: true } })
  assert.strictEqual(body.info(bot).groundFixes, 1, 'an honest true is passed through untouched')
  assert.strictEqual(sent[3].p.onGround, true)
  assert.ok(notes.some(n => /ground flag corrected/.test(n)), notes.join(' | '))
})

Date.now = realNow
console.log('bodytest: ' + passed + ' passed')
