'use strict'
// movedeeptest.js: move.buried - a place inside the rock is the mine's (a walk there is a shaft dug down); a low place
// under the open sky is a walk. Offline: world.at stubbed. node movedeeptest.js [bot2 dir]
const path = require('path')
const dir = process.argv[2] || path.join(__dirname, '..', '..', 'bot2')
const world = require(path.join(dir, 'lib', 'world'))
const move = require(path.join(dir, 'lib', 'move'))
let col = () => ({ name: 'air', boundingBox: 'empty' })
world.at = (bot, x, y, z) => col(x, y, z)
const solid = n => ({ name: n, boundingBox: 'block' }); const air = { name: 'air', boundingBox: 'empty' }
let fails = 0
function check (name, got, want) { const ok = want === 'buried' ? got > 4 : got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got} (want ${want})`) }
// 1. river-bank clay at y63, a hilltop home at y119 far off: open sky over it - a walk
col = (x, y) => y <= 62 ? solid('dirt') : air
check('river bank y63 under open sky', move.buried({}, { x: 0, y: 63, z: 0 }), 0)
// 2. deepslate at y7 under a y119 surface: stone all the way up - the mine's
col = (x, y) => y <= 118 ? solid(y < 8 ? 'deepslate' : 'stone') : air
check('deepslate y7 under 110 of rock', move.buried({}, { x: 0, y: 7, z: 0 }), 'buried')
// 3. a column not loaded above: unknown, not refused yet
col = (x, y) => y > 60 ? null : solid('stone')
check('column not loaded', move.buried({}, { x: 0, y: 20, z: 0 }), null)
// 4. under a tree: logs and leaves over it are no rock
col = (x, y) => y <= 70 ? solid('dirt') : y <= 76 ? solid('oak_log') : y <= 80 ? solid('oak_leaves') : air
check('under a tree', move.buried({}, { x: 0, y: 71, z: 0 }), 0)
// 5. a lava pool in a cave mouth under a 3-block overhang: not buried
col = (x, y) => y <= 40 ? solid('stone') : y >= 45 && y <= 47 ? solid('stone') : air
check('cave mouth under a thin overhang', move.buried({}, { x: 0, y: 41, z: 0 }), 0)
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
