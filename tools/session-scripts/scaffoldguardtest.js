process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || require('path').join(__dirname, 'test-events.log') // (never the live log)
// THE PLACE GUARD FOLLOWS THE WALK'S OWN SCAFFOLD RULE: when something swapped the hand, the planner's stepping stone is the
// movements' own pick (move.movementsFor: the kinds above the build's claim, never the spared item) - never any of the old ten
const { Vec3 } = require('vec3')
const LIB = 'C:/mc-bot-lab/bot2/lib/'
const md = require('minecraft-data')('26.2')
const world = require(LIB + 'world.js'); world.data = () => md
const memory = require(LIB + 'memory.js'); memory.get = () => ({})
const plannerPlace = require('./fixtures/mineflayer-pathfinder/caller.js')
const it = (n, c) => ({ name: n, count: c, type: md.itemsByName[n].id })
const cobble = it('cobblestone', 40); const coarse = it('coarse_dirt', 1); const dirt = it('dirt', 20)
let pack = [cobble, coarse, dirt]
const equipped = []; let placed = 0
const bot = { blockAt: p => ({ name: 'air', boundingBox: 'empty', position: p }), entity: { position: new Vec3(0.5, 64, 0.5) }, heldItem: coarse, inventory: { items: () => pack, slots: [], on () {} },
  on () {}, once () {}, setControlState () {}, clearControlStates () {}, controlState: {},
  equip: async i => { equipped.push(i.name); bot.heldItem = i }, placeBlock: async () => { placed++ }, activateItem () {}, activateBlock: async () => {}, _client: { on () {} } }
// the walk's movements: dirt only (cobblestone is the build's claim, coarse_dirt the item the walk goes to place)
const movements = { scafoldingBlocks: [dirt.type], getScaffoldingItem () { return pack.find(i => this.scafoldingBlocks.includes(i.type)) || null } }
bot.pathfinder = { movements, setGoal () {}, goal: null, isMoving: () => false }
const ints = []; const orig = global.setInterval; global.setInterval = f => { ints.push(f); return 0 }
const reflex = require(LIB + 'reflex.js'); reflex.install(bot); global.setInterval = orig
let ok = true; const check = (c, w) => { console.log(`${c ? 'PASS' : 'FAIL'} ${w}`); if (!c) ok = false }
;(async () => {
  const ref = { position: new Vec3(0, 63, 0) }; const face = new Vec3(0, 1, 0)
  await plannerPlace(bot, ref, face)
  check(equipped[0] === 'dirt' && placed === 1, `the hand held the spared coarse_dirt: re-equipped the walk's own dirt, placed (${equipped.join(',')})`)
  bot.heldItem = cobble; equipped.length = 0
  await plannerPlace(bot, ref, face)
  check(equipped[0] === 'dirt', `the hand held the claimed cobblestone: the walk's dirt instead (${equipped.join(',')})`)
  pack = [cobble, coarse]; bot.heldItem = coarse; equipped.length = 0
  let threw = null; try { await plannerPlace(bot, ref, face) } catch (e) { threw = e.message }
  check(!!threw && !equipped.length, `none of the walk's kinds in the pack: no place, nothing else equipped (${threw})`)
  pack = [cobble, coarse, dirt]; bot.heldItem = dirt; equipped.length = 0; const p0 = placed
  await plannerPlace(bot, ref, face)
  check(!equipped.length && placed === p0 + 1, 'already holding the walk\'s own kind: placed as it is')
  console.log(ok ? 'ALL PASS' : 'SOME FAILED'); process.exit(ok ? 0 : 1)
})()
