process.env.BOT2_LOG_FILE = 'C:/Users/wynan/AppData/Local/Temp/claude/C--mc-bot-lab/9671a8b2-a592-49be-bae9-509e44ba1444/scratchpad/test-events.log'
// B3: a skeleton 18 blocks off that sees us, hungry (food 12), no melee near: the cover flee must PERSIST (not flip each
// tick), and once the sight is lost the bot eats.
const { Vec3 } = require('vec3')
const LIB = 'C:/mc-bot-lab/bot2/lib/'
const md = require('minecraft-data')('26.2')
const world = require(LIB + 'world.js'); world.data = () => md
let wall = false // a wall at x=10 cuts the sight line once "true"
const solidAt = (x, y, z) => y < 63 || (wall && x === 10 && y >= 63 && y <= 66)
const blockAt = p => { const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z); const s = solidAt(x, y, z); const b = md.blocksByName[s ? 'stone' : 'air']; return { name: b.name, type: b.id, stateId: b.defaultState, position: new Vec3(x, y, z), boundingBox: s ? 'block' : 'empty', getProperties: () => ({}), transparent: !s } }
const handlers = {}; const cs = {}
const skel = { id: 7, name: 'skeleton', type: 'hostile', position: new Vec3(18.5, 63, 0.5), height: 1.99, isValid: true }
const food = { name: 'cooked_beef', count: 5, type: md.itemsByName.cooked_beef.id }
const bot = { blockAt, entity: { position: new Vec3(0.5, 63, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, height: 1.8 }, health: 3, food: 12, foodSaturation: 0, oxygenLevel: 20,
  entities: { 7: skel }, game: { difficulty: 'normal' }, heldItem: null, inventory: { items: () => [food], slots: [] }, players: {}, username: 'me',
  on (ev, f) { (handlers[ev] = handlers[ev] || []).push(f) }, once () {}, removeListener () {}, controlState: cs, setControlState (k, v) { cs[k] = v }, clearControlStates () { for (const k in cs) cs[k] = false },
  pathfinder: { isMoving: () => false, setGoal () {}, goal: null }, look: async () => {}, lookAt: async () => {}, equip: async () => {}, consume: async () => { eaten++ }, activateItem () {}, deactivateItem () {}, attack () {} }
let eaten = 0
const ints = []; const orig = global.setInterval; global.setInterval = (f) => { ints.push(f); return 0 }
const reflex = require(LIB + 'reflex.js'); reflex.install(bot); global.setInterval = orig
const tick = () => ints.forEach(f => { try { f() } catch (e) { console.log('tick threw', e.message) } })
let ok = true; const check = (c, w) => { console.log(`${c ? 'PASS' : 'FAIL'} ${w}`); if (!c) ok = false }
const kinds = []
for (let i = 0; i < 6; i++) { tick(); kinds.push(reflex.active() || '-') }
check(kinds.every(k => k === 'flee'), `in the skeleton's sight, hungry: the cover flee holds tick after tick (${kinds.join(',')})`)
check(eaten === 0, 'no eating while in its sight')
wall = true
for (let i = 0; i < 6; i++) tick()
check(reflex.active() !== 'flee', 'sight lost: the flee ends')
console.log('eat attempts after sight lost:', eaten)
console.log(ok ? 'ALL PASS' : 'SOME FAILED')
