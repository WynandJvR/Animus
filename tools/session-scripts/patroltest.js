process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || require('path').join(__dirname, 'test-events.log') // (never the live log)
// A PILLAGER PATROL (2026-10-07 13:33): four crossbows, the bot in an iron helmet + chestplate (8 points), a shield in the off
// hand, an iron sword. (1) the patrol OUTGUNS that kit, one pillager does not; (2) cornered, a fight holds its target when the
// patrol's nearest swaps (it flipped to cover and back every 0.5-1s); (3) the shield goes up in cover with no step and no wall;
// (4) hidden at hp 5 with two pillagers 8-10b off, the hold is NOT released back to work - at hp 20 it is.
const { Vec3 } = require('vec3')
const LIB = 'C:/mc-bot-lab/bot2/lib/'
const md = require('minecraft-data')('26.2')
const world = require(LIB + 'world.js'); world.data = () => md
const memory = require(LIB + 'memory.js'); memory.get = () => ({}) // (no live memory.json: no safehouse here)
let wall = false // a wall at x=4 (y 63-66) cuts every sight line once true
let slot = false // a 1-wide slot round the body (x<=0, z=0), open toward +x only, once true
const solidAt = (x, y, z) => y < 63 || (wall && x === 4 && y >= 63 && y <= 66) || (slot && y >= 63 && y <= 64 && x <= 0 && (z !== 0 || x < 0))
const blockAt = p => { const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z); const s = solidAt(x, y, z); const b = md.blocksByName[s ? 'stone' : 'air']; return { name: b.name, type: b.id, stateId: b.defaultState, position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty', getProperties: () => ({}), transparent: !s, hardness: s ? 1.5 : 0 } }
const handlers = {}; const cs = {}
const it = n => ({ name: n, count: 1, type: (md.itemsByName[n] || {}).id })
const slots = []; slots[5] = it('iron_helmet'); slots[6] = it('iron_chestplate'); slots[45] = it('shield')
const pack = [it('iron_sword'), Object.assign(it('bread'), { count: 10 })]
const pill = (id, x, z) => ({ id, name: 'pillager', type: 'hostile', position: new Vec3(x, 63, z), height: 1.95, isValid: true })
let shieldUses = 0; let attacks = []
const bot = { blockAt, entity: { id: 1, position: new Vec3(0.5, 63, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, height: 1.8, effects: {} }, health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20,
  entities: {}, game: { difficulty: 'normal' }, heldItem: pack[0], inventory: { items: () => pack, slots, on () {} }, players: {}, username: 'me', time: { isDay: true, timeOfDay: 6000 },
  getEquipmentDestSlot: s => ({ head: 5, torso: 6, legs: 7, feet: 8 })[s],
  on (ev, f) { (handlers[ev] = handlers[ev] || []).push(f) }, once () {}, removeListener () {}, controlState: cs, setControlState (k, v) { cs[k] = v }, clearControlStates () { for (const k in cs) cs[k] = false },
  pathfinder: { isMoving: () => false, setGoal () {}, setMovements () {}, goal: null }, look: async () => {}, lookAt: async () => {}, equip: async () => {}, consume: async () => {}, activateItem (off) { if (off) shieldUses++ }, deactivateItem () {}, attack (e) { attacks.push(e.id) }, stopDigging () {}, _client: { on () {} } }
bot.entity.position.floored = function () { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
const ints = []; const orig = global.setInterval; global.setInterval = (f) => { ints.push(f); return 0 }
const reflex = require(LIB + 'reflex.js'); reflex.install(bot); global.setInterval = orig
const tick = () => ints.forEach(f => { try { f() } catch (e) { console.log('tick threw', e.message) } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let ok = true; const check = (c, w) => { console.log(`${c ? 'PASS' : 'FAIL'} ${w}`); if (!c) ok = false }
const list = es => es.map(e => ({ e, d: e.position.distanceTo(bot.entity.position) }))

;(async () => {
  // (1) the arithmetic
  const four = [pill(11, 2.5, 0.5), pill(12, 6, 3), pill(13, 7, -3), pill(14, 9, 1)]
  check(reflex.outgunned(list(four), 20), 'four pillagers outgun an iron helmet + chestplate + shield + iron sword at hp 20')
  check(!reflex.outgunned(list([four[0]]), 20), 'one pillager in reach does not')
  check(!reflex.outgunned(list([]), 20), 'no shooter: not outgunned')
  // the long run's own exchange: 40b under four crossbows (8 points) is not taken; 40b under one pillager is; 25b is the short run's
  check(!reflex.runAffordable(40, four, 20), 'a 40b run under four pillagers (8 armour) leaves us under the hurt line: not taken')
  check(reflex.runAffordable(40, [four[0]], 20), 'a 40b run under one pillager is affordable')
  // the long run's gate: short runs always; past 28 only outgunned, cover gone and the run affordable
  check(reflex.longRunOk(20, { coverGone: false, isOutgunned: false, affordable: false }), 'a run within 28: always weighed in')
  check(!reflex.longRunOk(40, { coverGone: false, isOutgunned: true, affordable: true }), 'past 28 with cover still to be had: no run')
  check(!reflex.longRunOk(40, { coverGone: true, isOutgunned: true, affordable: false }), 'past 28, its exchange unaffordable: no run')
  check(reflex.longRunOk(40, { coverGone: true, isOutgunned: true, affordable: true }), 'past 28, outgunned, no cover, affordable: the run')
  // as the retreat closes the distance the run becomes affordable partway (four pillagers, 8 armour, hp 20)
  const firstOk = [48, 40, 32, 24, 16, 8].find(dd => reflex.runAffordable(dd, four, 20))
  check(firstOk != null && firstOk < 40, `retreating under four pillagers the run turns affordable partway (at ${firstOk}b)`)
  // the way home: a shooter between us and the door bars it; one behind us does not
  check(!reflex.wayClear({ x: 0, z: 0 }, { x: 30, z: 0 }, [new Vec3(15, 63, 2)]), 'a shooter on the line to the door: no way home')
  check(reflex.wayClear({ x: 0, z: 0 }, { x: 30, z: 0 }, [new Vec3(-6, 63, 1)]), 'a shooter behind us: the way home is clear')
  // no cover: the hole first when outgunned, then the retreat, then the shield
  check(reflex.noCoverAnswer({ isOutgunned: true, holeOk: true, retreat: true }) === 'hole', 'outgunned, a hole can be dug: the hole before the retreat')
  check(reflex.noCoverAnswer({ isOutgunned: true, holeOk: false, retreat: true }) === 'retreat', 'outgunned, no hole (no pickaxe/block, fluid, a build cell...): the retreat')
  check(reflex.noCoverAnswer({ isOutgunned: false, holeOk: true, retreat: true }) === 'retreat', 'not outgunned: no hole, the retreat')
  check(reflex.noCoverAnswer({ isOutgunned: true, holeOk: false, retreat: false }) === 'shield', 'neither: the shield and a step back')

  // (2) cornered by the patrol: no wall to put (no block in the pack), the body does not move - the cover flight pins, then
  // the fight; the patrol's nearest swaps and the fight holds its target
  for (const p of four) bot.entities[p.id] = p
  const kinds = []
  const t0 = Date.now()
  while (Date.now() - t0 < 2200) { tick(); kinds.push(reflex.active() || '-'); await sleep(200) }
  check(kinds.includes('flee'), `the patrol in sight: cover first (${kinds.join(',')})`)
  const cornered = reflex.info()
  check(cornered && cornered.kind === 'fight', `the cover flight stood 1.5s+ in sight: cornered - fight (${cornered ? cornered.kind + ' ' + cornered.detail : 'none'})`)
  // the next pillager steps in nearer than the one fought
  four[1].position = new Vec3(1.7, 63, 1.6)
  const after = []
  for (let i = 0; i < 8; i++) { tick(); after.push(reflex.active() || '-'); await sleep(200) }
  check(after.every(k => k === 'fight'), `the patrol's nearest swapped: the fight holds (${after.join(',')})`)
  check(attacks.length > 0 && attacks.every(id => id === 11), `the swings stay on the pillager fought first (${attacks.join(',')})`)

  // (4) hidden at hp 5, two pillagers 8-10b off behind the wall: held, not released to the task
  for (const k of Object.keys(bot.entities)) delete bot.entities[k]
  reflex.setEnabled(false); reflex.setEnabled(true)
  await sleep(3100) // (the cover pin of (2) runs out - its own 3s)
  wall = true
  const a = pill(21, 8.5, 0.5); const b = pill(22, 10.5, 2.5)
  bot.entities[21] = a; bot.entities[22] = b
  bot.health = 5
  const held = []
  for (let i = 0; i < 6; i++) { tick(); held.push(reflex.active() || '-'); await sleep(200) }
  check(held.every(k => k === 'flee'), `hp 5, hidden from two pillagers: held out of sight to heal, not back to work (${held.join(',')}) ${JSON.stringify(reflex.info())}`)
  bot.health = 20
  for (let i = 0; i < 3; i++) { tick(); await sleep(200) }
  check(!reflex.active(), `hp 20, hidden from both and a step any way stays hidden: back to work (${reflex.active()})`)
  // full health, unarmoured, three pillagers hidden behind the wall: one volley is past the hurt line even at hp 20 - never a hold
  const savedArmour = [slots[5], slots[6]]; slots[5] = null; slots[6] = null
  bot.entities[23] = pill(23, 9.5, -1.5)
  for (let i = 0; i < 4; i++) { tick(); await sleep(200) }
  check(!reflex.active(), `hp 20 (full), unarmoured, three pillagers hidden: no healing hold - healed is healed (${JSON.stringify(reflex.info())})`)
  slots[5] = savedArmour[0]; slots[6] = savedArmour[1]; delete bot.entities[23]

  // (3) the shield in cover with no step out of sight and no wall: up toward the nearest that sees us
  wall = false; bot.health = 4; bot.food = 20; shieldUses = 0
  reflex.setEnabled(false); reflex.setEnabled(true)
  // (hp 4, a pillager at 6b that hit us: cover; the flat open ground has steps but none hidden - and no block to wall with;
  //  the steps are taken away: the body stands in a 1-wide slot open toward the pillager only)
  for (const k of Object.keys(bot.entities)) delete bot.entities[k]
  slot = true
  const c = pill(31, 6.5, 0.5); bot.entities[31] = c
  for (const f of handlers.entityHurt || []) f(bot.entity, c)
  for (let i = 0; i < 3; i++) { tick(); await sleep(200) }
  const cv = reflex.info()
  check(cv && cv.kind === 'flee' && shieldUses > 0, `no step out of sight and no wall: cover with the shield up (${JSON.stringify(cv)}, raised ${shieldUses}x)`)
  console.log(ok ? 'ALL PASS' : 'SOME FAILED')
  process.exit(ok ? 0 : 1)
})()
