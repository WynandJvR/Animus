'use strict'
// OFFLINE unit test for the self-structure model (bot/hut-model.js) - PURE, no bot.
// Builds a synthetic 6x6 hut over a Map and asserts the classification + free-cell +
// stray + station + registry-reconcile logic that the live cleanup/unstick rely on.
// Run:  cd bot && node hutmodeltest.js

const assert = require('assert')
const H = require('./hut-model.js')

// ---- synthetic world ----------------------------------------------------------------
// anchor at (0, 65, 0). 6x6 footprint, walls dy 0..4, floor terrain at y64, door at the
// x=2,z=0 rim column (dy 0..1 open). We place furniture + stray dirt to mirror the live hut.
const A = { x: 0, y: 65, z: 0 }
const world = new Map()
const key = (x, y, z) => x + ',' + y + ',' + z
const set = (x, y, z, name, bb = 'block') => world.set(key(x, y, z), { name, boundingBox: bb })
const read = (x, y, z) => world.get(key(x, y, z)) || null // absent = null (air)

// floor: solid dirt at y64 across the whole footprint
for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) set(x, 64, z, 'dirt')
// walls: plank shell on the rim, dy 0..4
for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) {
  const rim = x === 0 || x === 5 || z === 0 || z === 5
  if (!rim) continue
  for (let dy = 0; dy <= 4; dy++) set(x, 65 + dy, z, 'oak_planks')
}
// door hole at x=2,z=0 (dy 0..1 open): clear the plank shell there + put a door block
world.delete(key(2, 65, 0)); world.delete(key(2, 66, 0))
set(2, 65, 0, 'oak_door'); set(2, 66, 0, 'oak_door')
// furniture inside: ONE furnace at (1,65,1), TWO tables (dupe) at (4,65,3) and (3,65,4),
// a bed at (4,65,4)
set(1, 65, 1, 'furnace'); set(4, 65, 3, 'crafting_table'); set(3, 65, 4, 'crafting_table'); set(4, 65, 4, 'red_bed')
// STRAY dirt: on the floor at (1,65,3) and (2,65,3), and HEAD-HEIGHT on the furnace at (1,66,1)
set(1, 65, 3, 'dirt'); set(2, 65, 3, 'dirt'); set(1, 66, 1, 'dirt')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('geometry: interior is the 4x4 (dx/dz 1..4), not 3x3', () => {
  assert.strictEqual(H.interiorColumns(A).length, 16, 'a 6x6 hut has a 4x4=16 interior')
  assert.strictEqual(H.isInterior(A, 4, 4), true, 'dx4,dz4 is interior in a 6-wide hut (the off-by-one bug missed this)')
  assert.strictEqual(H.isRim(A, 0, 3), true)
  assert.strictEqual(H.isInterior(A, 0, 3), false)
})

t('doorway detected at the open rim column', () => {
  const d = H.doorwayColumn(A, read)
  assert.deepStrictEqual({ x: d.x, z: d.z }, { x: 2, z: 0 })
  const thr = H.thresholdCell(A, d)
  assert.deepStrictEqual({ x: thr.x, z: thr.z }, { x: 2, z: 1 }) // interior cell in front of the door
})

t('classify: wall / door / floor / furniture / stray / interior', () => {
  assert.strictEqual(H.classifyCell(A, read, 0, 66, 3).cls, 'wall')
  assert.strictEqual(H.classifyCell(A, read, 2, 65, 0).cls, 'door')
  assert.strictEqual(H.classifyCell(A, read, 1, 64, 1).cls, 'floor')
  const f = H.classifyCell(A, read, 1, 65, 1); assert.strictEqual(f.cls, 'furniture'); assert.strictEqual(f.kind, 'furnace')
  assert.strictEqual(H.classifyCell(A, read, 1, 65, 3).cls, 'stray')   // floor dirt
  assert.strictEqual(H.classifyCell(A, read, 1, 66, 1).cls, 'stray')   // dirt piled on the furnace
  assert.strictEqual(H.classifyCell(A, read, 3, 65, 3).cls, 'interior') // empty air interior cell
  assert.strictEqual(H.classifyCell(A, read, 9, 65, 9).cls, 'outside')
})

t('strayCells finds exactly the 3 loose dirts (incl. the head-height pile)', () => {
  const s = H.strayCells(A, read).map(c => c.x + ',' + c.y + ',' + c.z).sort()
  assert.deepStrictEqual(s, ['1,65,3', '1,66,1', '2,65,3'])
})

t('stationCells reports the REAL counts (2 tables, 1 furnace, 1 bed) - not the registry', () => {
  const st = H.stationCells(A, read)
  assert.strictEqual(st.table.length, 2, 'two duplicate tables physically inside')
  assert.strictEqual(st.furnace.length, 1)
  assert.strictEqual(st.bed.length, 1)
  assert.strictEqual(st.chest.length, 0)
})

t('freeStandCells: standable, excludes the threshold, none on stray/furniture floor', () => {
  const free = H.freeStandCells(A, read)
  const set2 = new Set(free.map(c => c.x + ',' + c.z))
  assert(free.length > 0, 'there must be free interior cells to unstick to')
  assert(!set2.has('2,1'), 'the doorway threshold is never offered as a free cell')
  assert(!set2.has('1,1'), 'the furnace column is occupied, not free')
  // a plain empty interior column IS free
  assert(set2.has('2,2') || set2.has('3,2'), 'an empty interior column should be free')
  // every returned cell has air feet+head and solid non-furniture floor below
  for (const c of free) {
    assert(read(c.x, c.y, c.z) == null, 'feet air at ' + JSON.stringify(c))
    assert(read(c.x, c.y + 1, c.z) == null, 'head air at ' + JSON.stringify(c))
    const below = read(c.x, c.y - 1, c.z)
    assert(below && below.boundingBox === 'block' && !H.FURNITURE_RE.test(below.name), 'solid non-furniture floor below ' + JSON.stringify(c))
  }
})

t('floorHoles: none here (solid floor); punch one and it is found', () => {
  assert.strictEqual(H.floorHoles(A, read).length, 0)
  world.delete(key(3, 64, 3)) // remove a floor block
  const holes = H.floorHoles(A, read)
  assert.deepStrictEqual(holes.map(h => h.x + ',' + h.z), ['3,3'])
  set(3, 64, 3, 'dirt') // restore
})

t('reconcileCells: dedupe exact + drop verified-gone, keep present + unknown', () => {
  // mirrors the live corruption: many entries, most gone, some duplicated, some unloaded
  const list = [
    { x: 4, y: 65, z: 3 }, // real table (present)
    { x: 4, y: 65, z: 3 }, // exact duplicate
    { x: 9, y: 65, z: 9 }, // loaded, block GONE
    { x: 1, y: 65, z: 1 }, // furnace cell - NOT a table -> gone for the 'table' kind
    { x: 200, y: 65, z: 200 } // unloaded/unknown - keep (can't disprove)
  ]
  const verify = e => {
    const b = read(e.x, e.y, e.z)
    if (e.x === 200) return null // unloaded
    return !!(b && /crafting_table$/.test(b.name))
  }
  const { keep, pruned } = H.reconcileCells(list, verify)
  const kk = keep.map(e => e.x + ',' + e.y + ',' + e.z)
  assert(kk.includes('4,65,3'), 'the real table survives')
  assert(kk.includes('200,65,200'), 'the unknown/unloaded entry is kept')
  assert.strictEqual(kk.filter(k => k === '4,65,3').length, 1, 'the exact duplicate collapsed')
  assert(!kk.includes('9,65,9') && !kk.includes('1,65,1'), 'verified-gone entries pruned')
  assert.strictEqual(keep.length, 2)
  assert.strictEqual(pruned.length, 3)
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall hut-model tests passed')
process.exit(failures ? 1 : 0)
