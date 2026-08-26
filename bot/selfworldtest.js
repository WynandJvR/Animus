'use strict'
// OFFLINE unit test for ONE SELF/WORLD TRUTH (structural review 2026-08-25, D5 / §3.4).
// No live server, no test server, no network. Run:  cd bot && node selfworldtest.js
//
// WHAT IT PROVES - that the three answers which used to contradict each other now agree:
//
//   1. self-world.js classifies a cell once: my fabric / my support / my crawlspace /
//      my apron / natural - and keeps FABRIC and SUPPORT apart (skipping the ground the
//      hut stands on would send every surface read to bedrock).
//   2. pathfix.surfaceYAt reads THROUGH the bot's own roof, walls, floor and scaffold to
//      the world's ground. The live defect: at the bot's own hut it returned the roof
//      course as "the surface", 4 blocks above where a player stands.
//   3. provision-hut.hasSolidCeiling stops calling the bot's own floor a cave roof, so a
//      bot in the crawlspace under its own house is no longer "stuck UNDERGROUND" - while
//      real stone overhead still reads as a real ceiling.
//   4. navigate.js's climb rung is NOT APPLICABLE where the one dig rule forbids cutting,
//      so it cannot repeat the 243 x `climb -> no progress` at the bot's own doorstep.
//   5. world-memory.recordWedge LEARNS wedges near home (tagged nearOwnInfra) instead of
//      refusing to record them 1,269 times - while listWedges still refuses to STEER
//      around home.

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { Vec3 } = require('vec3')

// AMBIENT-PROOF: point every registry at a fresh temp dir before anything loads them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selfworld-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.SCAFFOLD_FILE = path.join(tmp, 'scaffold-registry.json')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')
process.env.INFRA_CONSOLIDATE = '1'
process.env.GROUNDED_OBS = '1'
process.env.NAV_TERRAIN_PROFILE = '0'

const selfWorld = require('./self-world.js')
const worldMemory = require('./world-memory.js')
const scaffold = require('./scaffold.js')
const pathfix = require('./pathfix.js')
const provHut = require('./provision-hut.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('ok   ' + name) } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message) }
}

// ---- the fixture: the bot's own hut, on real grade -----------------------------------
// hut.schem is 6x5x6 and anchor.y is the FLOOR PLANK SLAB (hut-model DIMS note). Anchor
// (190,67,-104) => footprint x190..195 / z-104..-99, floor slab y67, feet y68, roof y71.
// Natural grade is grass at y66 over stone - i.e. THE SURFACE OF THIS COLUMN IS y66/67,
// never the roof at y71. These are the live coordinates from the 2026-08-03 terminal loop.
const HUT = { x: 190, y: 67, z: -104 }
const cells = {}
const put = (x, y, z, n) => { cells[x + ',' + y + ',' + z] = n }
for (let x = 187; x <= 198; x++) {
  for (let z = -107; z <= -96; z++) {
    for (let y = 40; y <= 65; y++) put(x, y, z, 'stone')
    put(x, 66, z, 'grass_block')
  }
}
for (let x = HUT.x; x <= HUT.x + 5; x++) {
  for (let z = HUT.z; z <= HUT.z + 5; z++) {
    put(x, 67, z, 'oak_planks')  // floor slab
    put(x, 71, z, 'oak_planks')  // roof slab
    const rim = (x === HUT.x || x === HUT.x + 5 || z === HUT.z || z === HUT.z + 5)
    if (rim) for (let y = 68; y <= 70; y++) put(x, y, z, 'oak_planks') // walls
  }
}
// carve the crawlspace the bot actually fell into: two cells dug out under the floor
put(192, 66, -102, 'air'); put(192, 65, -102, 'air')

function blockAt (v) {
  const x = Math.floor(v.x); const y = Math.floor(v.y); const z = Math.floor(v.z)
  if (x < 187 || x > 198 || z < -107 || z > -96) return null // unloaded: NOT information
  const n = cells[x + ',' + y + ',' + z] || 'air'
  return { name: n, position: new Vec3(x, y, z), boundingBox: /^(air|cave_air|void_air)$/.test(n) ? 'empty' : 'block' }
}
function botAt (x, y, z) {
  return { game: { minY: -64, height: 384 }, entity: { position: new Vec3(x, y, z), height: 1.62, onGround: true }, blockAt, inventory: { items: () => [] } }
}

worldMemory.rememberInfra('hut', HUT, {})

// ---- 1. the classifier keeps FABRIC and SUPPORT apart --------------------------------
t('classify: the hut roof slab is MY FABRIC (not terrain)', () => {
  assert.strictEqual(selfWorld.classifyCell({ x: 192, y: 71, z: -102 }), 'my-structure')
  assert.strictEqual(selfWorld.ownBlockAt({ x: 192, y: 71, z: -102 }), 'structure')
})
t('classify: the hut FLOOR slab is my fabric too - the cell every crawlspace bot looked up at', () => {
  assert.strictEqual(selfWorld.ownBlockAt({ x: 192, y: 67, z: -102 }), 'structure')
})
t('classify: the grade UNDER the hut is my SUPPORT - protected, but still the world\'s ground', () => {
  assert.strictEqual(selfWorld.classifyCell({ x: 192, y: 66, z: -102 }), 'my-support')
  assert.strictEqual(selfWorld.ownBlockAt({ x: 192, y: 66, z: -102 }), null,
    'support must NOT be skipped as fabric - a surface scan that reads through it never stops')
})
t('classify: a cell 40 blocks away is natural and outside the home volume', () => {
  assert.strictEqual(selfWorld.classifyCell({ x: 240, y: 66, z: -102 }), 'natural')
  assert.strictEqual(selfWorld.homeVolumeAt({ x: 240, y: 66, z: -102 }), null)
})
t('homeVolume: the crawlspace under my own floor is named, and named as home', () => {
  const h = selfWorld.homeVolumeAt({ x: 192, y: 65, z: -102 })
  assert.ok(h, 'under-floor is inside the home volume')
  assert.strictEqual(h.zone, 'under-floor')
})
// NOTE the ordering: a ring cell AT or BELOW floor level is SUPPORT (it holds the walls up),
// so 'apron' is what is left of the ring ABOVE the floor plane. That ordering is deliberate -
// the stronger claim wins, and support is the one with a dig rule attached.
t('homeVolume: the 2-cell apron is home; the hut interior is home', () => {
  assert.strictEqual(selfWorld.homeVolumeAt({ x: 196, y: 70, z: -102 }).zone, 'apron')
  assert.strictEqual(selfWorld.homeVolumeAt({ x: 196, y: 67, z: -102 }).zone, 'support')
  assert.strictEqual(selfWorld.homeVolumeAt({ x: 192, y: 69, z: -102 }).zone, 'structure')
})
t('registered scaffold is fabric wherever it stands', () => {
  scaffold.add({ x: 400, y: 80, z: 400 }, 'test')
  assert.strictEqual(selfWorld.ownBlockAt({ x: 400, y: 80, z: 400 }), 'scaffold')
  scaffold.forget({ x: 400, y: 80, z: 400 })
})

// ---- 2. provision-hut delegates - one definition, not a copy -------------------------
t('provision-hut: ownHutAt / ownInfraSupportAt / underOwnFloorAt / onHutApron all agree with the facade', () => {
  assert.ok(provHut.ownHutAt({ x: 192, y: 69, z: -102 }), 'interior is the hut box')
  assert.ok(!provHut.ownHutAt({ x: 192, y: 65, z: -102 }), 'the crawlspace is NOT the hut box (the 2026-08-02 gap)')
  assert.ok(provHut.ownInfraSupportAt({ x: 192, y: 66, z: -102 }), 'the grade under the floor is support')
  assert.ok(provHut.underOwnFloorAt({ x: 192, y: 65, z: -102 }), 'the crawlspace is named by underFloor')
  assert.ok(provHut.onHutApron(botAt(196, 67, -102)), 'the apron ring is the apron')
})

// ---- 3. surfaceYAt describes the WORLD, not the bot's masonry ------------------------
// column 193,-102 keeps its grade intact (192,-102 is the carved crawlspace below).
t('surfaceYAt: my own hut column reads the GRADE at y66, not the roof at y71', () => {
  const b = botAt(193, 68, -102)
  const s = pathfix.surfaceYAt(b, 193, -102)
  assert.strictEqual(s.known, true)
  assert.strictEqual(s.groundY, 66, 'the roof/wall/floor planks are mine - the ground is the grass beneath them')
  assert.strictEqual(s.y, 67)
})
t('surfaceYAt: an ordinary column beside the hut is untouched', () => {
  const s = pathfix.surfaceYAt(botAt(198, 67, -96), 198, -96)
  assert.strictEqual(s.groundY, 66)
})

// ---- 4. hasSolidCeiling: my roof is not a cave roof; stone still is -------------------
t('hasSolidCeiling: UNDER MY OWN FLOOR is not underground (the 243x climb loop)', () => {
  assert.strictEqual(provHut.hasSolidCeiling(botAt(192, 65, -102), 12, { ignoreLeaves: true }), false,
    'the first solid block overhead is my own floor slab - skip it and the sky is open')
})
t('hasSolidCeiling: real stone overhead is STILL a ceiling, even under my own footprint', () => {
  assert.strictEqual(provHut.hasSolidCeiling(botAt(192, 50, -102), 12, { ignoreLeaves: true }), true,
    'support is protected terrain, not fabric - a mine under the house must still read as buried')
})
t('hasSolidCeiling: inside the hut is roofed-not-buried (unchanged)', () => {
  assert.strictEqual(provHut.hasSolidCeiling(botAt(192, 68, -102), 12, { ignoreLeaves: true }), false)
})

// ---- 5. THE THREE TRUTHS AGREE -------------------------------------------------------
// The single sentence the 2026-08-03 tape could not produce: at home, "buried" and "the
// surface is above me" must both be FALSE, and the bot must be told it is at home.
t('the three truths agree: in the crawlspace, nothing claims a climb is needed', () => {
  const b = botAt(192, 65, -102)
  const feet = b.entity.position.floored()
  const buried = provHut.hasSolidCeiling(b, 12, { ignoreLeaves: true })
  const surf = pathfix.surfaceYAt(b, feet.x, feet.z)
  const home = selfWorld.homeVolumeAt(feet)
  assert.strictEqual(buried, false, 'terrain model: not underground')
  assert.ok(home && home.zone === 'under-floor', 'self model: at home, under my own floor')
  assert.ok(surf.known && surf.y <= 67, 'surface locator: the way up is 2 blocks, not 7 - and it is my own floor')
  assert.ok(selfWorld.noDigAt(feet), 'dig rule: this cell is protected, so no cutting rescue can work here')
})

// ---- 6. the climb rung is gated by the one dig rule ----------------------------------
{
  const navSrc = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
  // (the climb rung was deleted with the rescue ladder on 2026-08-26)
  t('recoverOnce says WHERE it is before naming a rung', () => {
    assert.ok(/homeVolumeAt/.test(navSrc) && /I am AT HOME/.test(navSrc), 'the log names the home volume')
  })
}

// ---- 7. wedges near home are LEARNED, not refused ------------------------------------
t('recordWedge: a wedge at my own front door is RECORDED and tagged nearOwnInfra', () => {
  worldMemory.rememberInfra('chest', { x: 192, y: 68, z: -102 }, {})
  const before = (worldMemory.loadWorldMem().wedges || []).length
  worldMemory.recordWedge({ x: 193, y: 68, z: -101 })
  const wedges = worldMemory.loadWorldMem().wedges || []
  assert.strictEqual(wedges.length, before + 1, 'the 12b record-side blind spot is gone')
  const w = wedges.find(e => Math.abs(e.x - 193) <= 3 && Math.abs(e.z + 101) <= 3)
  assert.ok(w, 'the wedge we asked for is on the books')
  assert.strictEqual(w.nearOwnInfra, true, 'and it is TAGGED as being at home')
})
t('listWedges: a nearOwnInfra wedge still never steers the bot away from its own home', () => {
  const steerable = worldMemory.listWedges()
  assert.ok(!steerable.some(w => Math.abs(w.x - 193) <= 3 && Math.abs(w.z + 101) <= 3),
    'the recall-side rule is untouched - learning a wedge is not avoiding a place')
})
t('recordWedge: a wedge far from home carries no tag and IS steerable', () => {
  worldMemory.recordWedge({ x: 5000, y: 64, z: 5000 })
  const w = (worldMemory.loadWorldMem().wedges || []).find(e => Math.abs(e.x - 5000) <= 3)
  assert.ok(w && w.nearOwnInfra === undefined, 'no tag away from my stuff')
  assert.ok(worldMemory.listWedges().some(e => Math.abs(e.x - 5000) <= 3), 'and it may steer')
})
t('the deliberate blindness is DELETED from the source', () => {
  const wm = fs.readFileSync(path.join(__dirname, 'world-memory.js'), 'utf8')
  const live = wm.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  assert.ok(!/not recording - within 12b of own infra/.test(live), 'the 1,269-firings refusal must not exist in live code')
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
