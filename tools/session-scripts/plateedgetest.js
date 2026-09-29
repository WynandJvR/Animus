'use strict'
// plateedgetest.js - world.plateEdge (the ONE plate-edge model the planner and the way-out search share) against the
// game's own collision boxes: every state of every door (lower half) and trapdoor in the bot's registry, open, must give
// the edge its thin box touches; closed, null. A table that drifts from the data, or a data change, fails here.
// Run from bot2/: BOT2_LOG_FILE=<tmp> NODE_PATH=node_modules node ../tools/session-scripts/plateedgetest.js
const path = require('path')
const bot2 = path.join(__dirname, '..', '..', 'bot2')
const world = require(path.join(bot2, 'lib', 'world'))
const registry = require('prismarine-registry')('26.2')
const Block = require('prismarine-block')(registry)

// the edge a single thin box touches: [dx, dz], or null when it is no thin horizontal plate
function edgeOfShape (shapes) {
  if (!shapes || shapes.length !== 1) return null
  const [x0, , z0, x1, , z1] = shapes[0]
  const thin = 0.1875 + 1e-6
  if (x1 - x0 <= thin && z1 - z0 > thin) return x0 === 0 ? [-1, 0] : x1 === 1 ? [1, 0] : null
  if (z1 - z0 <= thin && x1 - x0 > thin) return z0 === 0 ? [0, -1] : z1 === 1 ? [0, 1] : null
  return null
}

let checked = 0; let bad = 0
for (const def of registry.blocksArray.filter(b => /_(trap)?door$/.test(b.name))) {
  for (let s = def.minStateId; s <= def.maxStateId; s++) {
    const b = Block.fromStateId(s, 0)
    const p = b.getProperties()
    if (/_door$/.test(def.name) && p.half !== 'lower') continue
    const open = p.open === true || p.open === 'true'
    const want = open ? edgeOfShape(b.shapes) : null
    const got = world.plateEdge(b)
    checked++
    if (JSON.stringify(want) !== JSON.stringify(got)) { bad++; if (bad <= 10) console.log(`FAIL ${def.name} ${JSON.stringify(p)} plateEdge ${JSON.stringify(got)} shape ${JSON.stringify(want)} ${JSON.stringify(b.shapes)}`) }
  }
}
console.log(`${checked} door/trapdoor states checked, ${bad} wrong`)
process.exit(bad ? 1 : 0)
