'use strict'
// OFFLINE test for ROOT G (2026-08-02): the hut floor must stand on something.
// No bot, no world, no server. Run:  cd bot && node underfloortest.js
//
// THE TRAP, from live world probes: the hut at (188,67,-104) has its oak_planks floor at y67 and
// 16 of those planks have air directly beneath them, because the floor is snapped to one median
// height while the ground slopes (natural grade y66 west, y65 east). The bot walked into the
// resulting crawlspace and stood at (193,65,-102) - feet air, head air, ceiling its OWN floor,
// solid grade E and W - while the goal it was pursuing (the bank, INSIDE the hut) was unreachable
// from beneath the floor.
//
// It is a blind spot BETWEEN three predicates, not a missing check in one of them:
//   ownHutAt / inBox  stop AT the floor (y >= anchor.y), so the bot was geometrically "not in its
//                     hut" while standing under it - every own-structure guard read false.
//   inSupport         extends downward without bound and includes the 1-cell ring: right for a
//                     DIG-PERMISSION rule, wrong as a description of an enclosed space.
//   healHomeCrater    refuses the footprint by construction ("NEVER inside the hut").
// So the region gets named ONCE (hutModel.underFloor) and everything reads that name.

const assert = require('assert')
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')
const hutModel = require('./hut-model.js')
const provHut = require('./provision-hut.js')

let failures = 0
const results = []
function ok (name) { results.push('PASS  ' + name) }
function bad (name, e) { failures++; results.push('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e)) }
function t (name, fn) { try { fn(); ok(name) } catch (e) { bad(name, e) } }
async function ta (name, fn) { try { await fn(); ok(name) } catch (e) { bad(name, e) } }

const HUT = { x: 188, y: 67, z: -104 } // the live registry entry

// ---- 1. hutModel.underFloor (PURE) -----------------------------------------------------
t('underFloor: the exact cell the bot was trapped in IS under its own floor', () => {
  assert.strictEqual(hutModel.underFloor(HUT, 193, 65, -102), true, 'feet cell, live')
  assert.strictEqual(hutModel.underFloor(HUT, 193, 66, -102), true, 'head cell, live')
})

t('underFloor: the floor plane and everything above it is NOT the crawlspace', () => {
  assert.strictEqual(hutModel.underFloor(HUT, 193, 67, -102), false, 'the plank itself')
  assert.strictEqual(hutModel.underFloor(HUT, 190, 68, -102), false,
    'the hut INTERIOR can never be a fill target - that is what makes "never fill inside" structural, not a check')
})

t('underFloor: FOOTPRINT only - a ring cell has no floor above it, so nothing can be trapped under one', () => {
  assert.strictEqual(hutModel.underFloor(HUT, 187, 66, -104), false, 'ring, west')
  assert.strictEqual(hutModel.underFloor(HUT, 194, 65, -102), false, 'ring, east - this is the solid grade the bot stands on')
  assert.strictEqual(hutModel.inSupport(HUT, 187, 66, -104), true,
    'and inSupport still covers it, because "do not dig here" and "this is an enclosed space" are different questions')
})

t('underFloor is PURE - derived from inBox and the anchor, no world reads', () => {
  const src = fs.readFileSync(path.join(__dirname, 'hut-model.js'), 'utf8')
  const i = src.indexOf('const underFloor =')
  const line = src.slice(i, src.indexOf('\n', i))
  assert.ok(/inBox\(a, x, z\) && y < a\.y/.test(line), 'footprint AND strictly below the floor: ' + line)
  assert.ok(!/bot\./.test(line) && !/blockAt/.test(line), 'no world reads')
})

t('floorColumns / ringColumns are the two column sets the underpin works from', () => {
  assert.strictEqual(hutModel.floorColumns(HUT).length, 36, '6x6 footprint - every column whose plank must stand on something')
  assert.strictEqual(hutModel.ringColumns(HUT).length, 28, '8x8 minus the 6x6 - the only place natural grade is still visible')
  assert.ok(hutModel.ringColumns(HUT).every(([x, z]) => !hutModel.inBox(HUT, x, z)), 'the ring never overlaps the footprint')
})

// ---- 2. the registry-side reader -------------------------------------------------------
function withHut (fn) {
  const wm = require('./world-memory.js')
  const mem = wm.loadWorldMem()
  const saved = mem.infra
  mem.infra = { hut: [{ x: HUT.x, y: HUT.y, z: HUT.z, verified: true }] }
  try { return fn() } finally { mem.infra = saved }
}

t('underOwnFloorAt reads the registry and answers for the live trap cell', () => {
  withHut(() => {
    assert.ok(provHut.underOwnFloorAt(new Vec3(193, 65, -102)), 'the bot WAS under its own floor')
    assert.strictEqual(provHut.underOwnFloorAt(new Vec3(193, 68, -102)), null, 'standing on the floor is not under it')
    assert.strictEqual(provHut.ownHutAt(new Vec3(193, 65, -102)), null,
      'and ownHutAt still says "not in the hut" at that cell - that disagreement IS the blind spot, ' +
      'and it is correct: the bot really was outside the hut box')
  })
})

// ---- 3. underpinHutFloor, against the live geometry (BEHAVIOURAL) -----------------------
// A synthetic world shaped like the live probe: floor planks over the whole 6x6 at y67; grade at
// y66 everywhere EXCEPT the (193,-102) column and its east ring neighbour, where grade is y65 -
// i.e. exactly one 2-deep crawlspace, the one the bot was standing in.
function makeWorld () {
  const solid = new Map()
  const key = (x, y, z) => x + ',' + y + ',' + z
  const set = (x, y, z, name) => solid.set(key(x, y, z), name)
  for (const [x, z] of hutModel.floorColumns(HUT)) set(x, HUT.y, z, 'oak_planks')
  for (const cols of [hutModel.floorColumns(HUT), hutModel.ringColumns(HUT)]) {
    for (const [x, z] of cols) {
      const low = (x === 193 || x === 194) && z === -102 // the sloped-away east strip
      if (!low) set(x, 66, z, 'grass_block')
      set(x, 65, z, low && x === 194 ? 'grass_block' : (low ? null : 'stone'))
      if (low && x === 193) solid.delete(key(x, 65, z)) // 2 deep: y65 AND y66 are air here
    }
  }
  return {
    solid,
    at (x, y, z) {
      const n = solid.get(key(x, y, z))
      if (n) return { name: n, boundingBox: 'block', position: new Vec3(x, y, z) }
      return { name: 'air', boundingBox: 'empty', position: new Vec3(x, y, z) }
    },
    place (x, y, z, n) { set(x, y, z, n) }
  }
}

function makeBot (world, feet, opts = {}) {
  const bot = {
    entity: { position: new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5), height: 1.62 },
    entities: opts.entities || {},
    inventory: { items: () => (opts.noFill ? [] : [{ name: 'dirt', count: 64, slot: 36 }]) },
    equip: async () => {},
    lookAt: async () => {},
    blockAt: (p) => world.at(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    placed: [],
    placeBlock: async (ref, face) => {
      const tgt = ref.position.plus(face)
      bot.placed.push(tgt.x + ',' + tgt.y + ',' + tgt.z)
      world.place(tgt.x, tgt.y, tgt.z, 'dirt')
    }
  }
  return bot
}

async function underpin () {
  await ta('underpin: fills exactly the crawlspace under the floor, bottom-up, and nothing else (MUTATION CHECK)', async () => {
    const world = makeWorld()
    const bot = makeBot(world, { x: 194, y: 66, z: -102 }) // standing on the east grade, beside the trap
    const said = []
    const r = await withHut(() => provHut.underpinHutFloor(bot, HUT, { say: m => said.push(m) }))
    assert.strictEqual(r.lowestY, 65, 'the fill floor is READ from the perimeter grade, not assumed')
    assert.strictEqual(r.holes, 2, 'exactly the two cells of the live trap: ' + JSON.stringify(bot.placed))
    assert.strictEqual(r.filled, 2, 'both placed (revert the underpin wiring and this is 0)')
    assert.deepStrictEqual(bot.placed, ['193,65,-102', '193,66,-102'],
      'bottom-up, so each cell has a solid face beneath it to place against (ensureHutApron already learned this)')
    assert.strictEqual(world.at(193, 65, -102).name, 'dirt', 'the cell the bot was trapped in no longer exists as a space')
    assert.ok(said.length === 1 && /shored up/.test(said[0]), 'and it says what it did, once')
  })

  await ta('underpin: NEVER the hut interior, and never a column whose grade is already flush', async () => {
    const world = makeWorld()
    const bot = makeBot(world, { x: 194, y: 66, z: -102 })
    await withHut(() => provHut.underpinHutFloor(bot, HUT, {}))
    for (const p of bot.placed) {
      const [, y] = p.split(',').map(Number)
      assert.ok(y < HUT.y, 'placed at y' + y + ' - the hut interior is above y' + HUT.y + ' and is unreachable by construction')
    }
    assert.strictEqual(bot.placed.filter(p => p.startsWith('188,')).length, 0,
      'the west columns sit on grade at y66 and get NO work - a fix that assumed every void was dug would fill natural slope here')
  })

  await ta('underpin: REFUSES while the bot is itself under the floor (MUTATION CHECK - this is the entombment guard)', async () => {
    const world = makeWorld()
    const bot = makeBot(world, { x: 193, y: 65, z: -102 }) // the live trap position
    const r = await withHut(() => provHut.underpinHutFloor(bot, HUT, {}))
    assert.strictEqual(r.skipped, 'under my own floor',
      'filling the crawlspace from inside it is exactly the 2026-08-01 sealed-hut shape; getting out comes first')
    assert.strictEqual(bot.placed.length, 0, 'and not one block was placed')
  })

  await ta('underpin: never fills a cell a body occupies', async () => {
    const world = makeWorld()
    // a body standing in cell z=-102 has position.z in [-102,-101) - Math.floor(-101.5) === -102
    const mob = { position: new Vec3(193.5, 65, -101.5), height: 1.9 }
    const bot = makeBot(world, { x: 194, y: 66, z: -102 }, { entities: { 7: mob } })
    const r = await withHut(() => provHut.underpinHutFloor(bot, HUT, {}))
    assert.ok(!bot.placed.includes('193,65,-102') && !bot.placed.includes('193,66,-102'),
      'a mob stands in both cells of that column (feet y65, head y66) - neither may be filled: ' + JSON.stringify(bot.placed))
    assert.strictEqual(r.filled, 0)
  })

  await ta('underpin: an unreadable perimeter refuses to decide how deep the floor should reach', async () => {
    const world = makeWorld()
    const bot = makeBot(world, { x: 194, y: 66, z: -102 })
    bot.blockAt = () => null // chunk not loaded: unknown is not "empty" (#10)
    const r = await withHut(() => provHut.underpinHutFloor(bot, HUT, {}))
    assert.strictEqual(r.skipped, 'grade unreadable')
    assert.strictEqual(bot.placed.length, 0)
  })

  await ta('underpin: no filler aboard is an honest skip, not a silent no-op', async () => {
    const world = makeWorld()
    const bot = makeBot(world, { x: 194, y: 66, z: -102 }, { noFill: true })
    const r = await withHut(() => provHut.underpinHutFloor(bot, HUT, {}))
    assert.strictEqual(r.skipped, 'no filler')
    assert.strictEqual(r.holes, 2, 'and it still REPORTS the holes it found, so the next pass knows there is work')
  })
}

// ---- 4. wiring + anti-grief shape ------------------------------------------------------
t('underpin runs inside maintainHome, right behind the door approach (MUTATION CHECK: unwire it and this fails)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  const i = src.indexOf('async function maintainHome')
  const fn = src.slice(i, src.indexOf('\n}', i))
  assert.ok(/underpinHutFloor\(bot, hutAt, \{ isStopped, say \}\)/.test(fn), 'maintainHome calls it')
  assert.ok(fn.indexOf('clearDoorApproach') < fn.indexOf('underpinHutFloor'), 'after the door approach...')
  assert.ok(fn.indexOf('underpinHutFloor') < fn.indexOf('ensureHutBed'), '...and before everything that assumes the bot can move around its home')
  assert.ok(!/setInterval|setTimeout\(/.test(fn), 'no new timer - it rides the maintenance pass that already exists')
})

t('underpin only PLACES - it consults no dig-permission rule, because there is no dig to permit', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  const i = src.indexOf('async function underpinHutFloor')
  const fn = src.slice(i, src.indexOf('\n// ---- BEDS', i))
  assert.ok(!/bot\.dig|digBlocked|canBreakNaturally/.test(fn),
    'filling is placing, not digging: it cannot interact with the digBlocked own-infra carve-out and so ' +
    'cannot re-create the 2026-08-01 entombment from the protection side')
  assert.ok(/placeAt\(bot, v, DIRTLIKE\)/.test(fn) && /placeAt\(bot, v, ANYFILL\)/.test(fn),
    'every placement goes through placeAt -> bot.placeBlock -> pathfix verifiedPlace/placedOK')
  assert.ok(/DIMS\.w \* hutModel\.DIMS\.l/.test(fn), 'the per-pass cap is one slab\'s worth, derived from the model, not invented')
  assert.ok(!/process\.env/.test(fn), 'ROOT G adds NO new env flag')
})

t('the two ground-fill material rules have ONE definition now (#4)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  assert.strictEqual((src.match(/const DIRTLIKE = /g) || []).length, 1, 'was re-declared in every filler; three copies drift')
  assert.strictEqual((src.match(/const ANYFILL = /g) || []).length, 1)
})

;(async () => {
  await underpin()
  for (const r of results) console.log(r)
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
