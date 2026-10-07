'use strict'
// kittest.js: base.keepCount for tools (toolKeep) - one tool of a kind by need, a spare beside one with fewer uses left than
// inv.TOOL_JOB_USES; and base's deposit order by wear. Offline: a fake pack, the real registry, a fake memory, the log to a
// temp file. node kittest.js [bot2 dir]
const path = require('path')
const dir = process.argv[2] || path.join(__dirname, '..', '..', 'bot2')
process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || path.join(require('os').tmpdir(), 'kittest.log')
const mem = require(path.join(dir, 'lib', 'memory'))
const fakeMem = { stats: {} }
mem.get = () => fakeMem; mem.set = (k, v) => { fakeMem[k] = v; return v }; mem.update = fn => fn(fakeMem); mem.save = () => {}
const registry = require(require.resolve('prismarine-registry', { paths: [dir] }))('26.2')
const world = require(path.join(dir, 'lib', 'world'))
world.data = () => registry
const inv = require(path.join(dir, 'lib', 'inventory'))
const base = require(path.join(dir, 'lib', 'base'))

const max = n => registry.itemsByName[n].maxDurability
const tool = (name, left = null) => ({ name, count: 1, type: registry.itemsByName[name].id, durabilityUsed: left == null ? 0 : max(name) - left })
let pack = []
const bot = { registry, inventory: { items: () => pack } }
const keep = n => base.keepCount(bot, { name: n })
let fails = 0
function check (what, got, want) { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got} (want ${want})`) }

// 1. the 11:55 pack: an iron sword and four stone ones, two stone shovels, an iron pickaxe and two stone ones, a stone axe, a hoe
pack = [tool('iron_sword'), tool('stone_sword'), tool('stone_sword'), tool('stone_sword'), tool('stone_sword'), tool('stone_shovel'), tool('stone_shovel', 40),
  tool('iron_pickaxe'), tool('stone_pickaxe'), tool('stone_pickaxe'), tool('stone_axe'), tool('wooden_hoe'), { name: 'torch', count: 13, type: registry.itemsByName.torch.id }]
check('11:55 iron_sword', keep('iron_sword'), 1)
check('11:55 stone_sword (four, an iron one held)', keep('stone_sword'), 0)
check('11:55 stone_shovel (two)', keep('stone_shovel'), 1)
check('11:55 iron_pickaxe', keep('iron_pickaxe'), 1)
check('11:55 stone_pickaxe (two, an iron one held)', keep('stone_pickaxe'), 0)
check('11:55 stone_axe', keep('stone_axe'), 1)
check('11:55 wooden_hoe', keep('wooden_hoe'), 1)
check('11:55 torch (the kit)', keep('torch'), 32)
// 2. an iron pick with 20 uses, a fresh one the check made: one kept - the fresh one (the worn goes first: depositByWear)
pack = [tool('iron_pickaxe', 20), tool('iron_pickaxe')]
check('two iron picks, one at 20 uses: one kept', keep('iron_pickaxe'), 1)
check('...and that one is the fresh copy', base.toolsKept(bot, 'pickaxe')[0].durabilityUsed, 0)
// 3. an iron pick at 4 uses and a stone spare: both kept - the spare finishes the job
pack = [tool('iron_pickaxe', 4), tool('stone_pickaxe')]
check('iron at 4 uses: the iron kept', keep('iron_pickaxe'), 1)
check('iron at 4 uses: the stone spare kept', keep('stone_pickaxe'), 1)
// 4. an iron pick at 200 uses and a stone one: the stone goes
pack = [tool('iron_pickaxe', 200), tool('stone_pickaxe')]
check('iron with enough uses: the stone banked', keep('stone_pickaxe'), 0)
// 5. a worn iron pick, two stone spares, one at 10 and one fresh: the fresh spare (meets the job) kept, the 10 not
pack = [tool('iron_pickaxe', 5), tool('stone_pickaxe', 10), tool('stone_pickaxe')]
check('two stone spares beside a worn iron: one kept', keep('stone_pickaxe'), 1)
check('...the fresh one', base.toolsKept(bot, 'pickaxe')[1].durabilityUsed, 0)
// 6. nothing of the kind that works: kept whatever it is
pack = [tool('stone_axe', 1)]
check('only a worn-out axe: kept', keep('stone_axe'), Infinity)
// 7. the job's number is the largest ask: gather's pickaxe check reads it
check('TOOL_JOB_USES is the largest ask (32)', inv.TOOL_JOB_USES, 32)
// 9. ONE WITHDRAW PLAN ACROSS THE CHESTS (base.withdrawPlan): the band's kinds lead the list; a near chest holding only the
// window's signs and doors gives nothing while the band's stairs and logs lie in a far one and the pack has 2 slots for them
{
  const bank = { dark_oak_stairs: 18, stripped_spruce_log: 55, dark_oak_sign: 3, spruce_door: 3 }
  const wants = [['dark_oak_stairs', 18], ['stripped_spruce_log', 55], ['dark_oak_sign', 3], ['spruce_door', 3]]
  const near = { dark_oak_sign: 3, spruce_door: 3 }; const far = { dark_oak_stairs: 18, stripped_spruce_log: 55 }
  const fmt = pl => pl.map(([n, k]) => k + ' ' + n).join(', ') || 'nothing'
  check('2 slots, the near chest (signs, doors): nothing taken', fmt(base.withdrawPlan(bot, wants, nm => near[nm] || 0, 2, nm => bank[nm] || 0)), 'nothing')
  check('2 slots, the far chest: the band kinds', fmt(base.withdrawPlan(bot, wants, nm => far[nm] || 0, 2, nm => bank[nm] || 0)), '18 dark_oak_stairs, 55 stripped_spruce_log')
  check('4 slots, the near chest: the signs and doors into the 2 left over', fmt(base.withdrawPlan(bot, wants, nm => near[nm] || 0, 4, nm => bank[nm] || 0)), '3 dark_oak_sign, 3 spruce_door')
  const banked = nm => (nm === 'dark_oak_stairs' || nm === 'stripped_spruce_log') ? 0 : (bank[nm] || 0)
  check('band kinds in no chest reserve nothing', fmt(base.withdrawPlan(bot, wants, nm => near[nm] || 0, 2, banked)), '3 dark_oak_sign, 3 spruce_door')
}
// 10. ROOM FOR THE BAND (base.roomPlan): the haul and the higher layers' blocks go back and are not taken again this round;
// a band layer's own kind banked whole for the room is NOT kept out - the withdraw's priority gives the heads their slots first
{
  const needs = { dark_oak_sign: 3, spruce_planks: 128, stone_bricks: 200 }
  const lowY = { dark_oak_sign: 131, spruce_planks: 127, stone_bricks: 127 }
  const stacks = { oak_sapling: 1, dark_oak_sign: 1, spruce_planks: 1, stone_bricks: 4 }
  const r = base.roomPlan({ names: Object.keys(stacks), needs, y: nm => lowY[nm] != null ? lowY[nm] : Infinity, lowHead: 127, slotsOf: nm => stacks[nm], keep: () => 0, free: 0, room: 7 })
  check('put back: the haul, the upper sign, the band spares, a whole band kind', [...r.back.keys()].join(','), 'oak_sapling,dark_oak_sign,stone_bricks,spruce_planks')
  check('not taken again this round: the haul and the upper sign only', [...r.noRetake].sort().join(','), 'dark_oak_sign,oak_sapling')
}
// 8. the deposit takes the most worn copies first (the haul), the freshest for a spare - by slot, never the type's first slot
{
  const mkw = () => { const sl = []; sl[9] = Object.assign(tool('iron_pickaxe'), { slot: 9 }); sl[10] = Object.assign(tool('iron_pickaxe', 20), { slot: 10 }); sl[11] = Object.assign(tool('iron_pickaxe', 100), { slot: 11 }); return { slots: sl, inventoryStart: 9, inventoryEnd: 45, deposit: async () => { throw new Error('by type') } } }
  const moved = []; const tb = Object.assign({}, bot, { transfer: async o => { moved.push(o.sourceStart) } })
  ;(async () => {
    let w = mkw(); await base.depositByWear(tb, w, registry.itemsByName.iron_pickaxe.id, 2)
    check('the haul: the two most worn (slots 10, 11)', moved.join(','), '10,11')
    moved.length = 0; w = mkw(); await base.depositByWear(tb, w, registry.itemsByName.iron_pickaxe.id, 1, { freshest: true })
    check('a spare: the freshest (slot 9)', moved.join(','), '9')
    console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
  })().catch(e => { console.log('FAIL threw: ' + e.message); process.exit(1) })
}
