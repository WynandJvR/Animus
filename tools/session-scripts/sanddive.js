// The clay dive end to end on a fake river with a fake body (physics on a fake clock) and the REAL reflex loop.
//   bank x<=0: ground top y62 (stand y63). River x=1..8, surface y62 (air over it).
//   |z|<=2: a clay shelf at x=1 (clay y61, dirt under: 1 deep - dug from the bank), clay on the bed at x=2..5 (y59,
//   3 deep - dived for). Elsewhere the bed is sand at y59. Far bank x>=9.
// Physics: in water with no jump the body sinks 0.1/tick to the bed (onGround there); jump rises 0.2/tick to float
// with the feet at 62.4 (head out); forward moves 0.05/tick along the look; a 1-high bank is climbed from the surface.
// A dug clay block drops 4 balls that rise 0.1/tick to bob at the surface (y62.9). oxygenLevel is stuck at 5 (live).
const { Vec3 } = require('vec3')
const LIB = 'C:/mc-bot-lab/bot2/lib/'
const logs = []
require.cache[require.resolve(LIB + 'log.js')] = { id: LIB + 'log.js', filename: LIB + 'log.js', loaded: true, exports: { log: (t, m) => { logs.push(`(${t}) ${m}`); if (process.env.V) console.log(`   [${((clock - T0) / 1000).toFixed(1)}] (${t}) ${m}`) }, tail: () => [], LOG_FILE: '' } }
const fakeMem = { home: { x: 0, y: 63, z: 0 }, claySpent: [] }
require.cache[require.resolve(LIB + 'memory.js')] = { id: LIB + 'memory.js', filename: LIB + 'memory.js', loaded: true, exports: { get: () => fakeMem, set: (k, v) => { fakeMem[k] = v }, update: fn => fn(fakeMem), save () {}, addUnique () {}, removePos () {}, bump () {}, FILE: '' } }
const T0 = 1e12; let clock = T0; Date.now = () => clock

const over = new Map()
function baseName (x, y, z) {
  if (x <= 0) return y <= 62 ? 'dirt' : 'air'
  if (x <= 8) {
    if (x === 1 && Math.abs(z) <= 2) { if (y <= 60) return 'dirt'; if (y === 61) return 'clay'; if (y === 62) return 'water'; return 'air' }
    if (y <= 56) return 'dirt'; if (y <= 59) return (y === 59 && x <= 5 && Math.abs(z) <= 2) ? 'clay' : 'sand'; if (y <= 62) return 'water'; return 'air'
  }
  return y <= 62 ? 'dirt' : 'air'
}
const nameAt = (x, y, z) => { const k = `${x},${y},${z}`; return over.has(k) ? over.get(k) : baseName(x, y, z) }
const md = require('minecraft-data')('26.2')
const ids = {}; for (const n of ['air', 'water', 'dirt', 'clay', 'sand']) ids[n] = md.blocksByName[n].id
function blockAt (p) {
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  const name = nameAt(x, y, z); const solid = !/^(air|water)$/.test(name)
  return { name, type: ids[name], position: new Vec3(x, y, z), boundingBox: solid ? 'block' : 'empty', hardness: name === 'clay' ? 0.6 : 0.5, getProperties: () => (name === 'water' ? { level: 0 } : {}) }
}
const solidAt = (x, y, z) => blockAt({ x, y, z }).boundingBox === 'block'
const waterAt = (x, y, z) => blockAt({ x, y, z }).name === 'water'
const controls = {}
const bot = {
  version: '26.2', blockAt, entities: {}, entity: { position: new Vec3(-1.5, 63, 0.5), onGround: true, yaw: 0 }, health: 20, food: 20, oxygenLevel: 5, thunderState: 0,
  time: { timeOfDay: 3000, isDay: true }, on () {}, heldItem: { name: 'stone_shovel' },
  setControlState (k, v) { controls[k] = v }, clearControlStates () { for (const k of Object.keys(controls)) controls[k] = false },
  look (yaw) { this.entity.yaw = yaw; return Promise.resolve() }, lookAt: () => Promise.resolve(),
  pathfinder: { setGoal () {}, setMovements () {} }, targetDigBlock: null, stopDigging () { digAbort = true },
  digTime: () => 1150 // stone shovel, eyes in water, on the ground (main.js installDigGuard)
}
require('C:/Users/wynan/AppData/Local/Temp/claude/C--mc-bot-lab/0518859d-60e0-4d4c-a3d1-8458eac1a78f/scratchpad/fakechunks.js')(bot, { minY: 48, height: 32, md }); const unusedFindBlocks = ({ matching, useExtraInfo, maxDistance, count, point }) => {
  const me = point || bot.entity.position; const out = []
  const ms = new Set(Array.isArray(matching) ? matching : [matching])
  for (let x = Math.floor(me.x - maxDistance); x <= me.x + maxDistance; x++) for (let z = Math.floor(me.z - maxDistance); z <= me.z + maxDistance; z++) for (let y = 55; y <= 66; y++) {
    const b = blockAt({ x, y, z })
    if (!ms.has(b.type)) continue
    if (b.position.distanceTo(me) > maxDistance) continue
    if (typeof useExtraInfo === 'function' && !useExtraInfo(b)) continue
    out.push(b.position)
  }
  return out.sort((a, b) => a.distanceTo(me) - b.distanceTo(me)).slice(0, count)
}

// ---- fake time: sleeps resolve on the fake clock; one physics tick = 50ms, the reflex loop every 200ms
const sleepers = []
const fsleep = ms => new Promise(r => sleepers.push({ at: clock + ms, r }))
let reflexTick = null
const world = require(LIB + 'world.js')
const move = require(LIB + 'move.js'); move.bindBot(bot)
const act = require(LIB + 'act.js')
const inv = require(LIB + 'inventory.js')
const reflex = require(LIB + 'reflex.js')
const clay = require(LIB + 'clay.js')
move.sleep = fsleep
inv.bestWeapon = () => null; inv.armorPieces = () => 0; inv.foodItems = () => []; inv.offhandShield = () => null
let pack = { clay_ball: 0, sand: 0 }
inv.items = () => Object.entries(pack).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count }))
inv.count = (b, what) => { const t = typeof what === 'string' ? n => n === what : what; return Object.entries(pack).filter(([n]) => t(n)).reduce((s, [, c]) => s + c, 0) }
inv.freeSlots = () => 20
inv.equipFor = async () => {}
require(LIB + 'base.js').tossJunk = async () => 0
{ const orig = global.setInterval; global.setInterval = fn => { reflexTick = fn; return 0 }; reflex.install(bot); global.setInterval = orig }

// ---- the body
const stats = { underMax: 0, underSince: 0, airReflex: 0, digs: [], walks: [] }
function physics () {
  const e = bot.entity; let p = e.position
  const fx = Math.floor(p.x); const fz = Math.floor(p.z)
  const inWater = waterAt(fx, Math.floor(p.y), fz) || waterAt(fx, Math.floor(p.y + 0.4), fz)
  let y = p.y; let x = p.x; let z = p.z
  if (controls.forward) {
    const sp = inWater ? 0.05 : 0.2
    const nx = x - Math.sin(e.yaw) * sp; const nz = z - Math.cos(e.yaw) * sp
    const cx = Math.floor(nx); const cz = Math.floor(nz); const fy = Math.floor(y)
    if (!solidAt(cx, fy, cz) && !solidAt(cx, fy + 1, cz)) { x = nx; z = nz } else if (inWater && controls.jump && !solidAt(cx, fy + 1, cz) && !solidAt(cx, fy + 2, cz) && y >= 62.3) { x = nx; z = nz; y = fy + 1 } // climbing out
  }
  if (inWater) {
    if (controls.jump) y = Math.min(y + 0.2, 62.4)
    else y -= 0.1
  } else if (!solidAt(Math.floor(x), Math.floor(y - 0.01), Math.floor(z))) y -= 0.4
  if (solidAt(Math.floor(x), Math.floor(y), Math.floor(z))) y = Math.floor(y) + 1 // (landed: on top of the block)
  e.position = new Vec3(x, y, z)
  e.onGround = y === Math.floor(y) && solidAt(Math.floor(x), y - 1, Math.floor(z))
  // head under: how long, at most
  if (world.headInWater(bot)) { if (!stats.underSince) stats.underSince = clock; stats.underMax = Math.max(stats.underMax, clock - stats.underSince) } else stats.underSince = 0
  // balls rise to the surface; the server hands over what is within reach of the hitbox
  for (const [id, it] of Object.entries(bot.entities)) {
    if (it.name === 'item' && it.position.y < 62.9 && waterAt(Math.floor(it.position.x), Math.floor(it.position.y), Math.floor(it.position.z))) it.position = it.position.offset(0, 0.1, 0)
    if (it.position.y > 62.9) it.position = new Vec3(it.position.x, 62.9, it.position.z)
    const q = e.position
    if (it.name === 'item' && Math.abs(it.position.x - q.x) <= 1.3 && Math.abs(it.position.z - q.z) <= 1.3 && it.position.y >= q.y - 0.5 && it.position.y <= q.y + 2.3) { pack[it.item] = (pack[it.item] || 0) + it.count; it.isValid = false; delete bot.entities[id] }
  }
}
let tickN = 0; let running = true
function loop () {
  if (!running) return
  clock += 50; tickN++
  physics()
  if (tickN % 4 === 0) { reflexTick(); if (reflex.active() === 'air') stats.airReflex++ }
  for (let i = sleepers.length - 1; i >= 0; i--) if (sleepers[i].at <= clock) { sleepers[i].r(); sleepers.splice(i, 1) }
  setImmediate(loop)
}

// ---- walks: the planner, faked - a teleport, but ONLY to a breathing stand or a surface cell (head in air)
move.goTo = async (b, goal, opts) => {
  const g = { x: goal.x, y: goal.y, z: goal.z }
  let cell = null
  if (g.y == null) { for (let y = 66; y >= 55; y--) if (clay.floatCell(bot, g.x, y, g.z) || clay.breathStand(bot, g.x, y, g.z)) { cell = { x: g.x, y, z: g.z }; break } } else if (clay.breathStand(bot, g.x, g.y, g.z) || clay.floatCell(bot, g.x, g.y, g.z)) cell = g
  stats.walks.push({ label: opts.label, g, ok: !!cell, dryHead: opts.dryHead })
  if (!cell) return { ok: false, why: 'noPath' }
  await fsleep(500)
  bot.clearControlStates()
  bot.entity.position = new Vec3(cell.x + 0.5, waterAt(cell.x, cell.y, cell.z) && !solidAt(cell.x, cell.y - 1, cell.z) ? 62.4 : cell.y, cell.z + 0.5)
  return { ok: true, why: 'reached' }
}
// digging: the raw dig (a dive) and the walking dig (the bank) - within reach, taking digTime, a clay block's 4 balls
let digAbort = false; let nextId = 1
async function fakeDig (pos, how) {
  const b = blockAt(pos)
  if (b.name !== 'clay' && b.name !== 'sand') return false
  if (bot.entity.position.offset(0, 1.62, 0).distanceTo(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)) > 4.5) return false
  const p = bot.entity.position
  stats.digs.push({ how, pos, onGround: bot.entity.onGround, headUnder: world.headInWater(bot), feet: p.floored(), floorSolid: solidAt(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)) })
  bot.targetDigBlock = b; digAbort = false
  const t0 = clock
  while (clock - t0 < bot.digTime(b)) { await fsleep(50); if (digAbort) { bot.targetDigBlock = null; return false } }
  bot.targetDigBlock = null
  over.set(`${pos.x},${pos.y},${pos.z}`, 'water')
  const e = { id: nextId++, name: 'item', item: b.name === 'clay' ? 'clay_ball' : 'sand', count: b.name === 'clay' ? 4 : 1, isValid: true, position: new Vec3(pos.x + 0.5, pos.y + 0.3, pos.z + 0.5), getDroppedItem () { return { name: this.item, count: this.count } } }
  bot.entities['i' + e.id] = e
  return true
}
act.digBlock = async (b, blk) => fakeDig(blk.position, 'dive')
act.dig = async (b, pos) => { if (world.headInWater(bot)) throw new Error('bank dig with the head under'); return fakeDig(pos, 'bank') }

let ok = true
const check = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) ok = false }
;(async () => {
  loop()
  console.log('--- SAND off the river bed (3 layers, 1 sand a block): wading and diving')
  const ret = await clay._digDeposit(bot, { x: 6, y: 59, z: 0 }, 40, () => false, 'sand')
  logs.filter(l => /^\(sand\)|dive broken|\(reflex\) air/.test(l)).forEach(l => console.log('    ' + l))
  const dives = stats.digs.filter(d => d.how === 'dive'); const bank = stats.digs.filter(d => d.how === 'bank')
  console.log(`    -> ${ret}; ${bank.length} bank digs, ${dives.length} dive digs; ${pack.sand} sand, ${pack.clay_ball} clay balls; longest under ${(stats.underMax / 1000).toFixed(1)}s`)
  check(pack.sand >= 40 && ret === 'done', `40 sand taken (${pack.sand}) -> ${ret}`)
  check(pack.clay_ball === 0, 'no clay dug on a sand trip')
  check(dives.every(d => d.onGround && d.headUnder && d.floorSolid), 'every dive dig from the bed')
  check(stats.airReflex === 0 && !logs.some(l => /dive broken/.test(l)), `the air reflex never took the body (${stats.airReflex})`)
  check(stats.underMax <= 8000, `back up by 8s (${stats.underMax}ms)`)
  check(logs.some(l => /^\(sand\) dive at .* dug \d+ sand .* sand/.test(l)), 'dives logged as sand')
  const f = bot.entity.position.floored()
  check(world.standable(bot, f.x, f.y, f.z), `ended on dry ground (${f})`)
  console.log('--- the clay rule unchanged by a sand trip: claySought still sees clay')
  check(clay.claySought(bot, new Vec3(2, 59, 0), { sky: false }) === true || nameAt(2, 59, 0) !== 'clay', 'claySought on bed clay')
  running = false
  console.log(ok ? 'ALL PASS' : 'SOME FAILED')
  process.exit(ok ? 0 : 1)
})().catch(e => { console.error(e); process.exit(2) })
