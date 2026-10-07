'use strict'
// littertest.js: litter.capsADrop - a lid set in the ground is kept; a block of ours standing in the air is litter
// (offline: world.at stubbed with a small column world). node littertest.js [bot2 dir]
// And litter.markStuck: a column proven out of reach leaves the count until the ground round it changes
const path = require('path')
const dir = process.argv[2] || path.join(__dirname, '..', '..', 'bot2')
// (offline: the log to a temp file, the memory a fake one - never the live bot's files)
process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || path.join(require('os').tmpdir(), 'littertest.log')
const mem = require(path.join(dir, 'lib', 'memory'))
const fakeMem = { home: { x: 0, y: 100, z: 0 }, stats: {}, litter: [105, 106, 107].map(y => ({ x: 5, y, z: 5, name: 'cobblestone', at: 0 })) }
mem.get = () => fakeMem; mem.set = (kk, v) => { fakeMem[kk] = v; return v }; mem.update = fn => fn(fakeMem); mem.save = () => {}
const world = require(path.join(dir, 'lib', 'world'))
const litter = require(path.join(dir, 'lib', 'litter'))
require(path.join(dir, 'lib', 'day')).dayNo = () => 1
world.openSky = () => true
let cells = new Map()
const key = (x, y, z) => `${x},${y},${z}`
const solid = n => ({ name: n, boundingBox: 'block' })
world.at = (bot, x, y, z) => cells.get(key(x, y, z)) || { name: 'air', boundingBox: 'empty' }
function groundAt (y0, r = 4) { for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) for (let y = y0 - 3; y <= y0; y++) cells.set(key(x, y, z), solid('stone')) }
let fails = 0
function check (name, got, want) { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got} (want ${want})`) }
const bot = {}
// 1. a stair of ours 5 up in the open air: litter, not a lid
cells = new Map(); groundAt(100); cells.set(key(0, 105, 0), solid('cobblestone'))
check('floating stair 5 up', litter.capsADrop(bot, { x: 0, y: 105, z: 0 }), false)
// 2. a lid over a 1x1 shaft 6 deep, ground round it at its level: kept
cells = new Map(); groundAt(100); for (let y = 94; y <= 99; y++) cells.delete(key(0, y, 0)); cells.set(key(0, 100, 0), solid('cobblestone'))
for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = 90; y < 97; y++) if (x || z) cells.set(key(x, y, z), solid('stone'))
cells.set(key(0, 93, 0), solid('stone'))
check('lid over a shaft', litter.capsADrop(bot, { x: 0, y: 100, z: 0 }), true)
// 3. a pillar's block 2 up (on the next of it): no drop, not a lid
cells = new Map(); groundAt(100); cells.set(key(0, 101, 0), solid('cobblestone')); cells.set(key(0, 102, 0), solid('cobblestone'))
check('pillar block', litter.capsADrop(bot, { x: 0, y: 102, z: 0 }), false)
// 4. a stand of ours in a crown: leaves beside it, 6 up - litter
cells = new Map(); groundAt(100); cells.set(key(0, 106, 0), solid('cobblestone')); cells.set(key(1, 106, 0), solid('oak_leaves')); cells.set(key(-1, 106, 0), solid('oak_leaves'))
check('stand in a crown', litter.capsADrop(bot, { x: 0, y: 106, z: 0 }), false)
// 5. a block of ours floating beside a castle wall (stone_bricks at its level): no ground, not a lid
cells = new Map(); groundAt(100); cells.set(key(0, 110, 0), solid('dirt')); cells.set(key(1, 110, 0), solid('stone_bricks'))
check('stuck to a build wall', litter.capsADrop(bot, { x: 0, y: 110, z: 0 }), false)
// 6-10. A COLUMN PROVEN OUT OF REACH (markStuck): out of the count while the ground round it is unchanged - an update in
// its box that changes nothing keeps it out, a change far off is not read, a real change round it counts it again
{
  const EventEmitter = require('events')
  const eb = new EventEmitter()
  cells = new Map(); groundAt(100, 8); for (const y of [105, 106, 107]) cells.set(key(5, y, 5), solid('cobblestone'))
  check('the column counts', litter.pending(eb, fakeMem.home, 96).length, 3)
  litter.markStuck(eb, litter.pending(eb, fakeMem.home, 96), 'a test: open air beside the tower')
  check('marked: out of the count', litter.pending(eb, fakeMem.home, 96).length, 0)
  const upd = (x, y, z) => { const b = world.at(eb, x, y, z); eb.emit('blockUpdate', null, Object.assign({}, b, { position: { x, y, z } })) }
  upd(6, 103, 5) // (inside the box, nothing changed: re-read, the same ground)
  check('an update round it with no change: still out', litter.pending(eb, fakeMem.home, 96).length, 0)
  cells.set(key(20, 101, 20), solid('stone')); upd(20, 101, 20) // (far off)
  check('a change far off: still out', litter.pending(eb, fakeMem.home, 96).length, 0)
  cells.set(key(6, 105, 5), solid('stone')); upd(6, 105, 5) // (a wall beside the column now)
  check('a block round it changed: counted again', litter.pending(eb, fakeMem.home, 96).length, 3)
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
