'use strict'
// OFFLINE unit test: TERRAIN HAS WIDTH; LITTER AND LEDGES DO NOT.
//
// The live defect (2026-08-26, spawn). The bot sat in a shallow crater at (0,61,-2) for hours,
// one step from open grass, with 19 recorded rescue failures in that one cell. Overhead hung a
// 1-wide, 3-long grass strip at y65 - abandoned litter in no registry. Both of the bot's column
// world-reads were fooled by it, in opposite directions:
//   provision-hut.hasSolidCeiling scanned UP, hit the strip, and said ROOFED
//     -> isUnderground() true -> secureFood deferred the wheat farm as a "real cave roof",
//        crafting/regroup gated off, and unstickPlan led every rescue with the climb rung
//        instead of nudge/stepout - the two rungs that would have walked it out in one step.
//   pathfix.surfaceYAt scanned DOWN, hit the strip, and called its top THE SURFACE
//     -> the climb was aimed at y66, a cell on top of a one-block ledge, so it could never
//        arrive, and climbToSurface's own need() stayed true forever.
//
// One shared world-read fixes both: pathfix.isNarrowSpan. Real ground and real cave roofs
// continue sideways; bridges, overhang lips, branches and our own litter are one block wide
// with air on both sides.
// Run:  cd bot && node narrowspantest.js

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { Vec3 } = require('vec3')

// AMBIENT-PROOF: nothing inherited from the shell.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narrowspan-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.SCAFFOLD_FILE = path.join(tmp, 'scaffold-registry.json')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')
process.env.BUILD_DEBUG = ''
process.env.CLIMB_DEBUG = ''

const pathfix = require('./pathfix.js')
const provHut = require('./provision-hut.js')
const navigate = require('./navigate.js')

let failures = 0
const queue = []
function t (name, fn) { queue.push([name, fn]) }

// ---- fake world ---------------------------------------------------------------------------
// "x,y,z" -> block name. Unlisted cells are AIR inside `loaded` columns, UNKNOWN outside them.
function fakeWorld (cells, loadedCols) {
  const loaded = new Set(loadedCols || Object.keys(cells).map(k => { const [x, , z] = k.split(',').map(Number); return x + ',' + z }))
  return (v) => {
    const ck = Math.floor(v.x) + ',' + Math.floor(v.z)
    if (!loaded.has(ck)) return null
    const n = cells[Math.floor(v.x) + ',' + Math.floor(v.y) + ',' + Math.floor(v.z)] || 'air'
    return {
      name: n,
      position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
      boundingBox: (n === 'air' || /_leaves$|^(vine|torch|tall_grass|water)$/.test(n)) ? 'empty' : 'block'
    }
  }
}
function fakeBot (blockAt, pos) {
  return {
    game: { minY: -64, height: 384 },
    entity: { position: pos, height: 1.62, onGround: true },
    blockAt,
    inventory: { items: () => [] }
  }
}
// A square patch of loaded columns so neighbour reads are INFORMATION, not unknown.
function patch (r, cx, cz) {
  const out = []
  for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) out.push(x + ',' + z)
  return out
}

// ---- 1. the predicate itself ---------------------------------------------------------------
t('isNarrowSpan: a 1-wide strip with air both sides in X is narrow', () => {
  const cells = { '0,65,-1': 'grass_block', '0,65,-2': 'grass_block', '0,65,-3': 'grass_block' }
  const b = fakeBot(fakeWorld(cells, patch(4, 0, -2)), new Vec3(0, 61, -2))
  assert.strictEqual(pathfix.isNarrowSpan(b, 0, 65, -2), true, '1 wide in X, 3 long in Z => narrow')
})

t('isNarrowSpan: broad terrain is NOT narrow', () => {
  const cells = {}
  for (let x = -4; x <= 4; x++) for (let z = -6; z <= 2; z++) cells[x + ',65,' + z] = 'stone'
  const b = fakeBot(fakeWorld(cells, patch(4, 0, -2)), new Vec3(0, 61, -2))
  assert.strictEqual(pathfix.isNarrowSpan(b, 0, 65, -2), false)
})

t('isNarrowSpan: UNKNOWN neighbours count as SOLID (fail closed - narrow is the permissive verdict)', () => {
  const b = fakeBot(fakeWorld({ '459,74,-91': 'grass_block' }), new Vec3(459, 50, -91)) // only that ONE column is loaded
  assert.strictEqual(pathfix.isNarrowSpan(b, 459, 74, -91), false, 'an unreadable neighbour must never be why we call something narrow')
})

// ---- 2. THE LIVE FIXTURE: the crater at spawn ----------------------------------------------
// Ground top y61 everywhere except a 3-cell dip at (0,-2)/(-1,-2)/(0,-1) whose top is y60.
// A 1-wide, 3-long grass strip floats at y65 over (0,-1),(0,-2),(0,-3). Bot feet at (0,61,-2).
function craterWorld () {
  const cells = {}
  for (let x = -5; x <= 5; x++) {
    for (let z = -7; z <= 3; z++) {
      for (let y = 50; y <= 60; y++) cells[x + ',' + y + ',' + z] = 'stone'
      const inDip = (x === 0 && z === -2) || (x === -1 && z === -2) || (x === 0 && z === -1)
      if (!inDip) cells[x + ',61,' + z] = 'grass_block'
    }
  }
  for (const z of [-1, -2, -3]) cells['0,65,' + z] = 'grass_block' // the floating strip
  return fakeBot(fakeWorld(cells, patch(5, 0, -2)), new Vec3(0.7, 61, -1.7))
}

t('LIVE FIXTURE: a 1x3 floating strip is no longer a cave roof', () => {
  const b = craterWorld()
  assert.strictEqual(provHut.hasSolidCeiling(b, 12, { ignoreLeaves: true }), false,
    'the strip is one block wide - step sideways and you are under open sky')
  assert.strictEqual(provHut.isUnderground(b), false,
    'and so the bot is NOT underground: this is what deferred the wheat farm as a real cave roof')
})

t('LIVE FIXTURE: the surface of my column is the real ground, not the top of the ledge', () => {
  const b = craterWorld()
  const s = pathfix.surfaceYAt(b, 0, -2)
  assert.strictEqual(s.known, true)
  assert.strictEqual(s.groundY, 60, 'the crater floor - NOT the y65 strip')
  assert.strictEqual(s.y, 61, 'so the climb target is where the feet already are')
  assert.notStrictEqual(s.y, 66, 'y66 - the top of a one-block bridge - is what the climb chased for hours')
})

t('LIVE FIXTURE: the climb rung now DECLINES here and hands the attempt to the walking rungs', () => {
  // The plan ORDER is unchanged and stays unsticktest's business: a cell with wedge history still
  // offers climb first (the crater fix, 31beccc - a bowl is open to the sky and nudge/stepout do
  // not go up). What changed is that the rung can now tell this crater from a burial, so it costs
  // milliseconds instead of the whole ~35s maneuver.
  const b = craterWorld()
  const feetY = Math.floor(b.entity.position.y)
  const plan = navigate.unstickPlan({ indoors: false, home: false, wet: false, submerged: false, roofed: provHut.hasSolidCeiling(b, 12, { ignoreLeaves: true }), pit: false, trappedHere: true, door: false, noDig: false, climb: true, cut: false, light: false })
  assert.ok(plan.includes('nudge') && plan.includes('stepout'), 'the walk-out rungs are in the plan')
  // These are the exact three terms the climb rung declines on (navigate.js, kind:'climb'):
  //   targetY <= feet.y && !roofed && !inPit  ->  "nothing to climb to"
  // Before the fix targetY was 66 - the top of the floating strip - so it never declined, and
  // climbToSurface's need() (feet.y < targetY && hasSolidCeiling) stayed true until the maneuver
  // expired. Both terms are now false, so the rung returns immediately and nudge/stepout run.
  assert.ok(pathfix.surfaceYAt(b, 0, -2).y <= feetY, 'targetY is no longer above the bot')
  assert.strictEqual(provHut.hasSolidCeiling(b, 12, { ignoreLeaves: true }), false, 'and there is no roof')
  // ...while a REAL ceiling still gets the climb rung, because that is what it is for.
  const roofedPlan = navigate.unstickPlan({ indoors: false, home: false, wet: false, submerged: false, roofed: true, pit: false, trappedHere: false, door: false, noDig: false, climb: true, cut: false, light: false })
  assert.ok(roofedPlan.includes('climb'), 'a real ceiling still gets the climb rung')
})

// ---- 3. THE REGRESSION GUARD: a cave must stay a cave ---------------------------------------
t('a real cave roof is still a ceiling', () => {
  const cells = {}
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      for (let y = 35; y <= 70; y++) cells[x + ',' + y + ',' + z] = 'stone' // broad overburden
      cells[x + ',71,' + z] = 'grass_block'
      for (let y = 20; y <= 28; y++) cells[x + ',' + y + ',' + z] = 'stone' // cave floor
    }
  }
  const b = fakeBot(fakeWorld(cells, patch(4, 0, 0)), new Vec3(0, 29, 0))
  assert.strictEqual(provHut.hasSolidCeiling(b, 45, { ignoreLeaves: true }), true, 'thirty blocks of stone is a ceiling')
  assert.strictEqual(provHut.isUnderground(b), true)
  assert.strictEqual(pathfix.surfaceYAt(b, 0, 0).groundY, 71, 'and the surface is the real topsoil')
})

t('a NARROW RIB under real overburden still reads as roofed - skipping CONTINUES the scan', () => {
  const cells = {}
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      for (let y = 40; y <= 70; y++) cells[x + ',' + y + ',' + z] = 'stone'
      for (let y = 20; y <= 28; y++) cells[x + ',' + y + ',' + z] = 'stone'
    }
  }
  cells['0,33,0'] = 'stone' // a lone 1-wide rib hanging below the real roof, air all around it
  const b = fakeBot(fakeWorld(cells, patch(4, 0, 0)), new Vec3(0, 29, 0))
  assert.strictEqual(pathfix.isNarrowSpan(b, 0, 33, 0), true, 'the rib itself is narrow')
  assert.strictEqual(provHut.hasSolidCeiling(b, 45, { ignoreLeaves: true }), true,
    'but the broad stone above it is still found: a cave stays a cave')
})

t('a 1-wide bridge overhead does not make the bot underground', () => {
  const cells = {}
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      for (let y = 50; y <= 60; y++) cells[x + ',' + y + ',' + z] = 'stone'
      cells[x + ',61,' + z] = 'grass_block'
    }
  }
  for (let x = -5; x <= 5; x++) cells[x + ',66,0'] = 'oak_planks' // a 1-wide catwalk along X
  const b = fakeBot(fakeWorld(cells, patch(5, 0, 0)), new Vec3(0, 62, 0))
  assert.strictEqual(provHut.isUnderground(b), false, 'standing under a catwalk is not being in a cave')
  assert.strictEqual(pathfix.surfaceYAt(b, 0, 0).groundY, 61, 'and the ground is the ground, not the planks')
})

// ---- run ------------------------------------------------------------------------------------
;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('  ok  ' + name) } catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message) }
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall ' + queue.length + ' passed')
  process.exit(failures ? 1 : 0)
})()
