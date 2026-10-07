'use strict'
// escapesteptest.js - the enclosed escape opens a pair of cells only for a step the walk model can take once they are dug
// (build.walkModelOver: the cells read as air). The case of 2026-10-07 18:50 at -2284,126,-610: the body's own column held
// two OPEN spruce trapdoors facing west at head height and over it - their panels on the column's east edge - and the escape
// broke the two finished cells east of it: no walk could step through. Here: the same column, the pair east opened in the
// model -> no step; the same without the trapdoors -> a step; the pair opened live (a block up, the step up onto the planks)
// -> no step with the trapdoors, a step without.
// Run: NODE_PATH=bot2/node_modules node tools/session-scripts/escapesteptest.js
const path = require('path')
const bot2 = path.join(__dirname, '..', '..', 'bot2')
process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || path.join(require('os').tmpdir(), 'escapesteptest.log')
const memory = require(path.join(bot2, 'lib', 'memory')); const fakeMem = { stats: {} }; memory.get = () => fakeMem; memory.set = (k, v) => { fakeMem[k] = v; return v }; memory.update = f => f(fakeMem); memory.save = () => {}
const { Vec3 } = require(require.resolve('vec3', { paths: [bot2] }))
const registry = require(require.resolve('prismarine-registry', { paths: [bot2] }))('26.2')
const Block = require(require.resolve('prismarine-block', { paths: [bot2] }))(registry)
const build = require(path.join(bot2, 'lib', 'build'))

let ok = true; const check = (c, what) => { console.log(`${c ? 'PASS' : 'FAIL'} ${what}`); if (!c) ok = false }
function world (trapdoors) {
  const cells = new Map(); const set = (x, y, z, n, p = {}) => cells.set(`${x},${y},${z}`, Block.fromProperties(n, p, 0))
  for (let x = -3; x <= 4; x++) for (let z = -2; z <= 2; z++) set(x, 120, z, 'stone') // (the ground, 5 under the body's floor west)
  set(0, 125, 0, 'cobblestone') // (the body's floor)
  for (const z of [-1, 1]) for (let y = 126; y <= 129; y++) set(0, y, z, 'stone') // (north and south: walls)
  set(1, 125, 0, 'stone'); set(1, 126, 0, 'oak_planks'); set(1, 127, 0, 'stripped_oak_wood', { axis: 'z' }); set(1, 128, 0, 'stripped_oak_wood', { axis: 'z' })
  for (const z of [-1, 1]) for (let y = 126; y <= 129; y++) set(1, y, z, 'stone')
  for (let y = 121; y <= 126; y++) set(2, y, 0, 'stone') // (past the wall: a floor at the body's level)
  if (trapdoors) { set(0, 127, 0, 'spruce_trapdoor', { facing: 'west', half: 'top', open: true }); set(0, 128, 0, 'spruce_trapdoor', { facing: 'west', half: 'bottom', open: true }) }
  const air = Block.fromProperties('air', {}, 0)
  return { registry, blockAt: v => { const x = Math.floor(v.x); const y = Math.floor(v.y); const z = Math.floor(v.z); const b = cells.get(`${x},${y},${z}`) || air; return Object.assign(Object.create(b), { position: new Vec3(x, y, z) }) } }
}
const me = { x: 0, y: 126, z: 0 }
const steps = (bot, pair) => build.walkModelOver(bot, new Set(pair)).next(me).some(n => n.x === 1 && n.z === 0)
check(!steps(world(true), ['1,126,0', '1,127,0']), 'open trapdoors on the column\'s east edge: the pair east opened gives no step')
check(steps(world(false), ['1,126,0', '1,127,0']), 'no trapdoors: the same pair opened is a step east')
check(!steps(world(true), ['1,127,0', '1,128,0']), 'the pair the escape opened live (127/128, read mid-jump): the step up onto the planks has a panel at its side and over its head - no step')
check(steps(world(false), ['1,127,0', '1,128,0']), 'the same pair with no trapdoors: the step up onto the planks')
check(!build.walkModelOver(world(true), new Set()).next(me).some(n => n.x === 1), 'nothing opened: no step east (the trap as found)')
console.log(ok ? 'ALL PASS' : 'SOME FAILED')
process.exit(ok ? 0 : 1)
