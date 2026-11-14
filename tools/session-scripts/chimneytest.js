process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || require('path').join(__dirname, 'test-events.log') // (never the live log)
// THE CASTLE'S CHIMNEY BESIDE A LIP (2026-10-07 15:38): lit campfires under shut bottom trapdoors on a ledge, a 5-block drop
// beside them. The hot row read the body on the trapdoor as "standing on campfire" and stepped it off onto the next chimney,
// the lip row put it back - two minutes of it at hp 20. One safe-stand predicate (safeStand / burnsAt) for every row's target:
//  - stood on a shut trapdoor over a lit campfire: nothing burns, no hot row
//  - stood ON a lit campfire: the hot row, and its step off is a safe stand (never a lip, never another fire)
//  - on the lip: back onto the nearest safe stand - never one with fire in it
const { Vec3 } = require('vec3')
const LIB = 'C:/mc-bot-lab/bot2/lib/'
const md = require('minecraft-data')('26.2')
const world = require(LIB + 'world.js'); world.data = () => md
const memory = require(LIB + 'memory.js'); memory.get = () => ({})
// The ledge, z = 0 row (and z = +-1 alike): floor y 61 stone everywhere x >= 1; the lip column x = 0 open down to y 56 (a 5-block
// drop). Cells: x=1 chimney (campfire y62 lit, shut trapdoor y63), x=2 chimney, x=3 stone y62 + fire in the feet cell y63 when
// `fire3`, x=4 stone y62 (plain ground at the feet level 63), x=5 wall.
let campfireAt1 = 'chimney' // 'chimney' | 'open' (no trapdoor: the campfire itself is the top)
let fire3 = true
// (and a row at z = 3 for the feet-cell boxes that do NOT hold the body: magma at y62 under a ladder (x=1), an open trapdoor
//  (x=2), and a shut one (x=3, which does hold it))
const cell = (x, y, z) => {
  if (z === 3 && x >= 1 && x <= 3) return y <= 61 ? 'stone' : y === 62 ? 'magma_block' : y === 63 ? (x === 1 ? 'ladder' : 'spruce_trapdoor') : 'air'
  if (y < 56) return 'stone'
  if (x <= 0) return y < 56 ? 'stone' : 'air'
  if (x >= 5) return y <= 65 ? 'stone' : 'air'
  if (y <= 61) return 'stone'
  if (x === 1 || x === 2) {
    if (y === 62) return x === 1 && campfireAt1 === 'open' ? 'stone' : 'campfire'
    if (y === 63) return x === 1 && campfireAt1 === 'open' ? 'campfire' : 'spruce_trapdoor'
    return 'air'
  }
  if (x === 3) return y === 62 ? 'stone' : (y === 63 && fire3 ? 'fire' : 'air')
  if (x === 4) return y === 62 ? 'stone' : 'air'
  return 'air'
}
const blockAt = p => {
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  const n = cell(x, y, z); const b = md.blocksByName[n]
  const solid = n !== 'air' && n !== 'fire'
  const open = n === 'spruce_trapdoor' && z === 3 && x === 2
  const props = n === 'campfire' ? { lit: true } : n === 'spruce_trapdoor' ? { open, half: 'bottom' } : {}
  const shapes = n === 'campfire' ? [[0, 0, 0, 1, 0.4375, 1]] : n === 'spruce_trapdoor' ? (open ? [[0, 0, 0.8125, 1, 1, 1]] : [[0, 0, 0, 1, 0.1875, 1]]) : n === 'ladder' ? [[0, 0, 0.8125, 1, 1, 1]] : solid ? [[0, 0, 0, 1, 1, 1]] : []
  return { name: n, type: b.id, stateId: b.defaultState, position: new Vec3(x, y, z), boundingBox: solid ? 'block' : 'empty', shapes, getProperties: () => props, transparent: !solid, hardness: solid ? 2 : 0 }
}
const handlers = {}; const cs = {}
const bot = { blockAt, entity: { id: 1, position: new Vec3(1.5, 63.1875, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, height: 1.8, effects: {} }, health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20,
  entities: {}, game: { difficulty: 'normal' }, heldItem: null, inventory: { items: () => [], slots: [], on () {} }, players: {}, username: 'me', time: { isDay: true, timeOfDay: 6000 },
  getEquipmentDestSlot: s => ({ head: 5, torso: 6, legs: 7, feet: 8 })[s],
  on (ev, f) { (handlers[ev] = handlers[ev] || []).push(f) }, once () {}, removeListener () {}, controlState: cs, setControlState (k, v) { cs[k] = v }, clearControlStates () { for (const k in cs) cs[k] = false },
  pathfinder: { isMoving: () => false, setGoal () {}, setMovements () {}, goal: null }, look: async () => {}, lookAt: async () => {}, equip: async () => {}, consume: async () => {}, activateItem () {}, deactivateItem () {}, attack () {}, stopDigging () {}, _client: { on () {} } }
const ints = []; const orig = global.setInterval; global.setInterval = (f) => { ints.push(f); return 0 }
const reflex = require(LIB + 'reflex.js'); reflex.install(bot); global.setInterval = orig
const tick = () => ints.forEach(f => { try { f() } catch (e) { console.log('tick threw', e.message) } })
let ok = true; const check = (c, w) => { console.log(`${c ? 'PASS' : 'FAIL'} ${w}`); if (!c) ok = false }
const logm = require(LIB + 'log.js')
const lines = { length: 0, find: f => logm.tail(6).find(f) } // (the lines just said - each step reads right after its tick)

// the predicate
check(reflex._safeStand(1, 64, 0), 'a shut trapdoor over a lit campfire: a safe stand (the chimney burns nothing)')
check(!reflex._burnsAt(1, 63, 0), 'the trapdoor cell itself: nothing burns the body on it')
check(!reflex._safeStand(3, 63, 0), 'a cell with fire in it: no safe stand')
check(reflex._safeStand(4, 63, 0), 'plain ground: a safe stand')
check(!reflex._safeStand(0, 63, 0), 'the lip column: no stand')

// boxes in the feet cell that do NOT hold the body: magma under them still burns (live feet on the magma's top: y 63.0)
check(!!reflex._burnsAt(1, 63, 3, 63.0), 'magma under a LADDER: it burns the body standing in the ladder cell')
check(!!reflex._burnsAt(2, 63, 3, 63.0), "magma under an OPEN trapdoor's plate: it burns")
check(!reflex._burnsAt(3, 63, 3, 63.1875), 'magma under a SHUT trapdoor, the body on the trapdoor: nothing burns')
check(!world.burnsAt(bot, 3, 63, 3) && !world.burnsAt(bot, 1, 63, 0), "the planner's node on a shut trapdoor (over magma, over a lit campfire): not priced as fire")
check(!!world.burnsAt(bot, 1, 63, 3) && !!world.burnsAt(bot, 2, 63, 3), "the planner's node in a ladder / open-trapdoor cell over magma: fire")

// 1. on the chimney's trapdoor: no hot row
for (let i = 0; i < 4; i++) tick()
check(reflex.active() !== 'hot', `stood on a shut trapdoor over a lit campfire: no "standing on campfire" (${reflex.active()})`)

// 2. on the lip beside the chimney and the fire: back onto a safe stand - the trapdoor (nearest), never the fire's cell
bot.entity.position = new Vec3(0.75, 63.1875, 0.5) // (centre over the x=0 drop, the hitbox's corner on the trapdoor)
lines.length = 0
tick()
const lip = lines.find(l => /on the lip/.test(l)) || ''
check(reflex.active() === 'lip' && /back onto 1,64,0/.test(lip), `on the lip: back onto the trapdoor stand 1,64,0 (${lip})`)
reflex.setEnabled(false); reflex.setEnabled(true)

// 3. stood ON a lit campfire (no trapdoor over it): the hot row; its step off is a safe stand - not the fire at x=3, not the lip
campfireAt1 = 'open'
bot.entity.position = new Vec3(1.5, 63.4375, 0.5)
lines.length = 0
tick()
const hotLine = lines.find(l => /standing on campfire/.test(l)) || ''
const to = (hotLine.match(/off to (-?\d+),(-?\d+),(-?\d+)/) || []).slice(1).map(Number)
check(reflex.active() === 'hot', `on a lit campfire: the hot row (${reflex.active()})`)
check(to.length === 3 && reflex._safeStand(to[0], to[1], to[2]), `its step off is a safe stand (${hotLine})`)
check(!(to[0] === 3), 'never the cell with the fire in it')
console.log(ok ? 'ALL PASS' : 'SOME FAILED')
process.exit(ok ? 0 : 1)
