'use strict'
// minetest.js: the mine's levels (mining.js) - which level an ore trip works (never a new entrance while a mine stands),
// the view <-> levels sync, where a new flight down may start, the way in through the chain, the mine's box.
// Offline: memory stubbed (nothing written), no bot. node minetest.js [bot2 dir]
const path = require('path')
const os = require('os')
process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || path.join(os.tmpdir(), 'minetest-bot2-events.log')
const dir = process.argv[2] || path.join(__dirname, '..', '..', 'bot2')
const mem = require(path.join(dir, 'lib', 'memory'))
let store = { mine: null, deaths: [] }
mem.get = () => store
mem.set = (k, v) => { store[k] = v; return v }
mem.update = f => f(store)
const mining = require(path.join(dir, 'lib', 'mining'))
const { tail } = require(path.join(dir, 'lib', 'log'))
let fails = 0
function check (name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`) }
const P = (x, y, z) => ({ x, y, z })
// an old one-staircase record: entrance y100 heading +x, stairs done at y40, tunnel face 20 on
const oldMine = () => ({ entrance: P(0, 100, 0), dir: { x: 1, z: 0 }, stairsDir: { x: 1, z: 0 }, cursor: P(80, 40, 0), level: 40, stairsDone: true, leg: 1, legPos: 20, blocks: 900, shiftDir: { x: 0, z: 1 } })

// 1. migration: level 0 is the old record, its foot where a straight flight from the entrance meets y40
let m = mining.ensureLevels(oldMine())
check('migrated: one level, active 0', [m.levels.length, m.active], [1, 0])
check('level 0 stairTop = entrance, stairsEnd = foot', [m.levels[0].stairTop, m.levels[0].stairsEnd], [P(0, 100, 0), P(60, 40, 0)])

// 2. chooseLevel (a): ore deeper than the deepest level by > 6 -> a new level down; within 6 -> that level; shallower
//    than every level -> the nearest level (never a new entrance)
check('ore y8 under a y40 mine: descend from level 0', mining.chooseLevel(m, 8), { descend: 0, target: 8, near: 0 })
check('ore y44 by a y40 mine: that level', mining.chooseLevel(m, 44), { use: 0 })
check('ore y97 over a y40 mine: the nearest level, apart', mining.chooseLevel(m, 97), { use: 0, apart: true })
check('no band (cobble): the active level', mining.chooseLevel(m, null), { use: 0 })

// 3. pickLevel end to end: iron at y8 -> a new level from level 0's foot, heading away from its legs (shift was +z)
store = { mine: mining.ensureLevels(oldMine()), deaths: [] }
m = mining.pickLevel(store.mine, { y: 8, n: 20 }, 'raw_iron')
check('descended: two levels, level 1 active', [m.levels.length, m.active], [2, 1])
check('level 1 starts one out from the foot, heading -z', [m.levels[1].stairTop, m.levels[1].stairsDir], [P(60, 40, -1), { x: 0, z: -1 }])
check('the view is level 1', [m.cursor, m.level, m.stairsDone, m.blocks, m.entrance], [P(60, 40, -1), 8, false, 0, P(0, 100, 0)])
check('level 0 kept its face and count', [m.levels[0].cursor, m.levels[0].blocks, m.levels[0].legPos, m.levels[0].shiftDir], [P(80, 40, 0), 900, 20, { x: 0, z: 1 }])
check('saved as the mine record', store.mine === m, true)
// andesite at y97 next: level 0 is nearest (57 off) - worked there, the mine and its entrance stay
m = mining.pickLevel(m, { y: 97, n: 30 }, 'andesite')
check('andesite y97: back to level 0, no new entrance', [m.active, m.level, m.levels.length, m.entrance], [0, 40, 2, P(0, 100, 0)])
check('no band under a deepslate level: back above y8', (() => { const t = JSON.parse(JSON.stringify(m)); mining.setActive(t, 1); t.level = 1; return mining.chooseLevel(t, null) })(), { use: 0 })

// 4. setActive round trip (b): the view goes back into its level and the new level into the view, nothing lost
m = mining.ensureLevels(oldMine())
m.levels.push({ stairTop: P(60, 40, -1), stairsEnd: null, stairsDir: { x: 0, z: -1 }, dir: { x: 0, z: -1 }, cursor: P(60, 35, -6), level: 8, stairsDone: false, legPos: 0, leg: 0, blocks: 15, oreY: 8 })
m.cursor = P(82, 40, 0); m.blocks = 918; m.caveRun = 2.5 // (work on level 0 in the view, not yet written back)
mining.setActive(m, 1)
check('level 0 got the view back', [m.levels[0].cursor, m.levels[0].blocks, m.levels[0].caveRun, m.levels[0].shiftDir], [P(82, 40, 0), 918, 2.5, { x: 0, z: 1 }])
check('view = level 1 (no field of level 0 left over)', [m.cursor, m.blocks, m.level, m.oreY, 'shiftDir' in m, 'caveRun' in m, m.stairsDir], [P(60, 35, -6), 15, 8, 8, false, false, { x: 0, z: -1 }])
m.cursor = P(60, 30, -11); m.blocks = 30
mining.setActive(m, 0)
check('level 1 got its work back', [m.levels[1].cursor, m.levels[1].blocks], [P(60, 30, -11), 30])
check('view = level 0 again', [m.cursor, m.blocks, m.caveRun], [P(82, 40, 0), 918, 2.5])
// saveMine: the view written into its level, one record, no MISMATCH
store = { mine: null, deaths: [] }
mining.setActive(m, 1); m.cursor = P(60, 29, -12); m.blocks = 33
mining.saveMine(m)
const L1 = store.mine.levels[store.mine.active]
check('saveMine: levels[active] = view', [L1.cursor, L1.level, L1.blocks], [P(60, 29, -12), 8, 33])
check('saveMine: no MISMATCH logged', tail(50).filter(l => /MINE VIEW MISMATCH/.test(String(l.msg || l))).length, 0)
check('saveMine: a copy, not the view object', L1.cursor !== m.cursor, true)

// 5. the descent start guard (c): a new flight's first 3 cells may not run under any level's stairs with < 2 of rock
//    between the cut and the stair's floor. Level 0 heads +x from (0,100,0) to its foot (60,40,0); a second mine-level's
//    flight runs down -z over the foot's -z side from (60,46,-7) down to... we add one whose cells sit over (60,40,-1)
const g = mining.ensureLevels(oldMine())
check('guard: the flight heads -z, away from the +z legs', mining.descentStart(g, 0).dir, { x: 0, z: -1 })
// a flight from (60,44,-1) heading -z: stair cells (60,44,-1),(60,43,-2),(60,42,-3)... over the -z start (60,40,-1), 4 up
g.levels.push({ stairTop: P(60, 44, -1), stairsEnd: P(60, 41, -4), stairsDir: { x: 0, z: -1 }, dir: { x: 0, z: -1 }, cursor: P(60, 41, -4), level: 41, stairsDone: true })
const s2 = mining.descentStart(g, 0)
check('guard: -z refused under a flight 4 up; back (-x) is under level 0\'s own stairs; +z it is', s2 && s2.dir, { x: 0, z: 1 })
// and a flight 7 up (2+ of rock over the three-high cut plus its floor): no bar
g.levels[1] = Object.assign({}, g.levels[1], { stairTop: P(60, 47, -1), stairsEnd: P(60, 44, -4), cursor: P(60, 44, -4), level: 44 })
check('guard: a flight 7 up leaves the -z start free', mining.descentStart(g, 0).dir, { x: 0, z: -1 })
// every way refused: null (the caller works the nearest level)
g.levels[1] = Object.assign({}, g.levels[1], { stairTop: P(60, 44, -1), stairsEnd: P(60, 41, -4), cursor: P(60, 41, -4), level: 41 })
g.levels.push({ stairTop: P(60, 44, 1), stairsEnd: P(60, 41, 4), stairsDir: { x: 0, z: 1 }, dir: { x: 0, z: 1 }, cursor: P(60, 41, 4), level: 41, stairsDone: true })
g.levels.push({ stairTop: P(61, 44, 0), stairsEnd: P(64, 41, 0), stairsDir: { x: 1, z: 0 }, dir: { x: 1, z: 0 }, cursor: P(64, 41, 0), level: 41, stairsDone: true })
check('guard: boxed in by flights on every side -> null', mining.descentStart(g, 0), null)

// 6. minePath (d): level 0's stairs, the step from its foot to level 1's top, level 1's stairs, the face
m = mining.ensureLevels(oldMine())
m.levels.push({ stairTop: P(60, 40, -1), stairsEnd: P(60, 30, -11), stairsDir: { x: 0, z: -1 }, dir: { x: 1, z: 0 }, cursor: P(70, 30, -11), level: 30, stairsDone: true, legPos: 10, leg: 0, blocks: 99 })
mining.setActive(m, 1)
const path0 = mining.minePath(m)
const has = (p, lv) => path0.some(q => q.x === p.x && q.y === p.y && q.z === p.z && (lv == null || q.lv === lv))
check('path: the entrance and level 0\'s stairs', [has(P(0, 100, 0), 0), has(P(30, 70, 0), 0), has(P(60, 40, 0), 0)], [true, true, true])
check('path: the connector (level 0 foot, as level 1)', has(P(60, 40, 0), 1), true)
check('path: level 1\'s stairs to its foot', [has(P(60, 40, -1), 1), has(P(60, 34, -7), 1), has(P(60, 30, -11), 1)], [true, true, true])
check('path: the face last', path0[path0.length - 1], { x: 70, y: 30, z: -11, lv: 1 })
check('path: no level 0 tunnel face while level 1 works', has(P(80, 40, 0)), false)
// a death at level 1's face: that level (1) is the one it lies by
check('path levels: a point by the face is level 1', path0.filter(p => Math.hypot(p.x - 70, p.z + 11) < 4).map(p => p.lv), [1])

// 7. mineBox: the union over every level's top, foot and face
check('mineBox', mining.mineBox(m), { x1: 0, y1: 30, z1: -11, x2: 80, y2: 100, z2: 0 })

// 8. abandonMine per level: level 1 goes, level 0 stays active; level 0 abandoned = the whole mine
store = { mine: m, deaths: [] }
const left = mining.abandonMine(m)
check('abandon level 1: level 0 left, active', [left && left.levels.length, left && left.active, left && left.level, store.mine === left], [1, 0, 40, true])
check('abandon level 1: its start remembered', left.badLevels, [P(60, 40, -1)])
check('abandon level 0: no mine, entrance a bad mine', [mining.abandonMine(left), store.mine, store.badMines], [null, null, [P(0, 100, 0)]])

console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
