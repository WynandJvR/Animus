'use strict'
// OFFLINE unit test for the self-structure model (bot/hut-model.js) - PURE, no bot.
// Builds a synthetic 6x6 hut over a Map and asserts the classification + free-cell +
// stray + station + registry-reconcile logic that the live cleanup/unstick rely on. A
// SECOND fixture stamps the REAL bot/schematics/hut.schem into a Map-world (offline) and
// asserts the model reads it correctly - the anti-divergence gate that stops hut-model
// ever silently drifting from the schematic's anchor convention again.
// Run:  cd bot && node hutmodeltest.js
//
// CANONICAL CONVENTION (see hut-model.js header): anchor.y is the FLOOR PLANK SLAB the bot
// stands ON; feet / door-lower / furniture at anchor.y+1; door-upper / head at anchor.y+2;
// interior air dy1..3; roof plank slab at anchor.y+4; natural grade outside ~anchor.y-1.

const assert = require('assert')
const H = require('./hut-model.js')

// ---- synthetic world (schematic-true) ------------------------------------------------
// anchor at (0, 65, 0). Natural dirt grade at y64; a FULL 6x6 plank floor slab at y65
// (=anchor.y); rim walls at y66..y68; a FULL plank roof slab at y69 (=anchor.y+4); door at
// the x=2,z=0 rim column (dy1..2 = y66,y67). Furniture stands at y66 (=anchor.y+1); stray
// dirt on the floor slab (y66) and head-height on the furnace (y67).
const A = { x: 0, y: 65, z: 0 }
const world = new Map()
const key = (x, y, z) => x + ',' + y + ',' + z
const set = (x, y, z, name, bb = 'block') => world.set(key(x, y, z), { name, boundingBox: bb })
const read = (x, y, z) => world.get(key(x, y, z)) || null // absent = null (air)

// natural grade: solid dirt at y64 across (and just around) the footprint
for (let x = -1; x <= 6; x++) for (let z = -1; z <= 6; z++) set(x, 64, z, 'dirt')
// FULL plank floor slab at y65 (=anchor.y) across the whole 6x6 footprint
for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) set(x, 65, z, 'oak_planks')
// rim walls: plank shell on the rim at y66..y68 (dy1..3)
for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) {
  const rim = x === 0 || x === 5 || z === 0 || z === 5
  if (!rim) continue
  for (let y = 66; y <= 68; y++) set(x, y, z, 'oak_planks')
}
// FULL plank roof slab at y69 (=anchor.y+4) across the whole footprint
for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) set(x, 69, z, 'oak_planks')
// door hole at x=2,z=0 (dy1..2 = y66,y67): clear the plank shell there + put a door block
world.delete(key(2, 66, 0)); world.delete(key(2, 67, 0))
set(2, 66, 0, 'oak_door'); set(2, 67, 0, 'oak_door')
// furniture inside at y66 (=anchor.y+1): ONE furnace at (1,66,1), TWO tables (dupe) at
// (4,66,3) and (3,66,4), a bed at (4,66,4)
set(1, 66, 1, 'furnace'); set(4, 66, 3, 'crafting_table'); set(3, 66, 4, 'crafting_table'); set(4, 66, 4, 'red_bed')
// STRAY dirt: on the floor slab at (1,66,3) and (2,66,3), and HEAD-HEIGHT on the furnace at (1,67,1)
set(1, 66, 3, 'dirt'); set(2, 66, 3, 'dirt'); set(1, 67, 1, 'dirt')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('geometry: interior is the 4x4 (dx/dz 1..4), not 3x3', () => {
  assert.strictEqual(H.interiorColumns(A).length, 16, 'a 6x6 hut has a 4x4=16 interior')
  assert.strictEqual(H.isInterior(A, 4, 4), true, 'dx4,dz4 is interior in a 6-wide hut (the off-by-one bug missed this)')
  assert.strictEqual(H.isRim(A, 0, 3), true)
  assert.strictEqual(H.isInterior(A, 0, 3), false)
})

t('box: floorY is the plank slab at anchor.y (not anchor.y-1)', () => {
  assert.strictEqual(H.box(A).floorY, A.y, 'the floor the bot stands on is the slab at anchor.y')
  assert.strictEqual(H.box(A).y1, A.y + H.DIMS.h - 1, 'the roof slab is anchor.y+4')
})

t('doorway detected at the open rim column', () => {
  const d = H.doorwayColumn(A, read)
  assert.deepStrictEqual({ x: d.x, z: d.z }, { x: 2, z: 0 })
  const thr = H.thresholdCell(A, d)
  assert.deepStrictEqual({ x: thr.x, z: thr.z }, { x: 2, z: 1 }) // interior cell in front of the door
  const out = H.outsideCell(A, d)
  assert.deepStrictEqual({ x: out.x, z: out.z }, { x: 2, z: -1 }) // stand-off cell OUTSIDE the door (opposite the threshold)
})

t('doorwayColumn: preferDoorBlock returns the REAL door even when a wall hole sorts first', () => {
  // punch a 2-high wall HOLE at rim column (1,0) - lower x than the door (2,0), so it sorts first
  world.delete(key(1, 66, 0)); world.delete(key(1, 67, 0))
  const dflt = H.doorwayColumn(A, read)
  assert.deepStrictEqual({ x: dflt.x, z: dflt.z }, { x: 1, z: 0 }, 'default (today) scan returns the first gap = the HOLE')
  const pref = H.doorwayColumn(A, read, { preferDoorBlock: true })
  assert.deepStrictEqual({ x: pref.x, z: pref.z }, { x: 2, z: 0 }, 'preferDoorBlock returns the actual hung door column (invariant to the hole)')
  set(1, 66, 0, 'oak_planks'); set(1, 67, 0, 'oak_planks') // restore the wall
})

t('doorwayColumn: preferDoorBlock treats null (unloaded) reads as UNKNOWN, never the doorway', () => {
  const nullRead = () => null // an unloaded chunk: every read is null
  assert(H.doorwayColumn(A, nullRead), 'default scan wrongly claims a doorway from null reads (the documented flap)')
  assert.strictEqual(H.doorwayColumn(A, nullRead, { preferDoorBlock: true }), null, 'preferDoorBlock: null reads never claim the doorway')
})

t('classify: wall / door / floor / furniture / stray / interior (schematic-true y)', () => {
  assert.strictEqual(H.classifyCell(A, read, 0, 66, 3).cls, 'wall')   // rim wall at feet level (anchor.y+1)
  assert.strictEqual(H.classifyCell(A, read, 3, 69, 3).cls, 'wall')   // roof plank slab (anchor.y+4)
  assert.strictEqual(H.classifyCell(A, read, 2, 66, 0).cls, 'door')   // door lower (anchor.y+1)
  assert.strictEqual(H.classifyCell(A, read, 2, 67, 0).cls, 'door')   // door upper (anchor.y+2)
  assert.strictEqual(H.classifyCell(A, read, 1, 65, 1).cls, 'floor')  // interior floor plank at anchor.y
  const f = H.classifyCell(A, read, 1, 66, 1); assert.strictEqual(f.cls, 'furniture'); assert.strictEqual(f.kind, 'furnace')
  assert.strictEqual(H.classifyCell(A, read, 1, 66, 3).cls, 'stray')  // floor-slab dirt
  assert.strictEqual(H.classifyCell(A, read, 1, 67, 1).cls, 'stray')  // dirt piled head-height on the furnace
  assert.strictEqual(H.classifyCell(A, read, 3, 66, 3).cls, 'interior') // empty air interior cell
  assert.strictEqual(H.classifyCell(A, read, 9, 66, 9).cls, 'outside')
  assert.strictEqual(H.classifyCell(A, read, 3, 64, 3).cls, 'outside')  // natural grade below the slab is OUTSIDE the box now
})

t('strayCells finds exactly the 3 loose dirts (incl. the head-height pile)', () => {
  const s = H.strayCells(A, read).map(c => c.x + ',' + c.y + ',' + c.z).sort()
  assert.deepStrictEqual(s, ['1,66,3', '1,67,1', '2,66,3'])
})

t('stationCells reports the REAL counts (2 tables, 1 furnace, 1 bed) - not the registry', () => {
  const st = H.stationCells(A, read)
  assert.strictEqual(st.table.length, 2, 'two duplicate tables physically inside')
  assert.strictEqual(st.furnace.length, 1)
  assert.strictEqual(st.bed.length, 1)
  assert.strictEqual(st.chest.length, 0)
})

t('freeStandCells: feet at anchor.y+1, excludes the threshold, none on stray/furniture floor', () => {
  const free = H.freeStandCells(A, read)
  const set2 = new Set(free.map(c => c.x + ',' + c.z))
  assert(free.length > 0, 'there must be free interior cells to unstick to')
  assert(free.every(c => c.y === A.y + 1), 'feet stand on the plank slab -> y = anchor.y+1')
  assert(!set2.has('2,1'), 'the doorway threshold is never offered as a free cell')
  assert(!set2.has('1,1'), 'the furnace column is occupied, not free')
  // a plain empty interior column IS free
  assert(set2.has('2,2') || set2.has('3,2'), 'an empty interior column should be free')
  // every returned cell has air feet+head and solid non-furniture plank floor below
  for (const c of free) {
    assert(read(c.x, c.y, c.z) == null, 'feet air at ' + JSON.stringify(c))
    assert(read(c.x, c.y + 1, c.z) == null, 'head air at ' + JSON.stringify(c))
    const below = read(c.x, c.y - 1, c.z)
    assert(below && below.boundingBox === 'block' && !H.FURNITURE_RE.test(below.name), 'solid non-furniture floor below ' + JSON.stringify(c))
  }
})

t('floorHoles: none here (solid plank slab); punch one and it is found at anchor.y', () => {
  assert.strictEqual(H.floorHoles(A, read).length, 0)
  world.delete(key(3, 65, 3)) // remove a floor PLANK cell (anchor.y), not the dirt under it
  const holes = H.floorHoles(A, read)
  assert.deepStrictEqual(holes.map(h => h.x + ',' + h.y + ',' + h.z), ['3,65,3'])
  set(3, 65, 3, 'oak_planks') // restore
})

t('stationSlot: SKIP when the kind already stands (no duplicate), PLACE into a free cell', () => {
  // table already stands twice -> never place another (desired 1)
  assert.strictEqual(H.stationSlot(A, read, 'table', 1), null, 'a table exists -> skip (no duplicate)')
  // furnace stands once, desired 1 -> skip
  assert.strictEqual(H.stationSlot(A, read, 'furnace', 1), null, 'a furnace exists -> skip')
  // no chest anywhere -> place into a free floor cell (never wall/door/threshold/occupied)
  const slot = H.stationSlot(A, read, 'chest', 1)
  assert(slot, 'no chest -> a free cell is offered')
  assert.strictEqual(H.isInterior(A, slot.x, slot.z), true, 'the slot is an interior cell')
  assert.strictEqual(slot.y, A.y + 1, 'the slot is feet-level (anchor.y+1), never on the floor slab or head height')
  assert(read(slot.x, slot.y, slot.z) == null, 'the slot is empty (not onto furniture)')
  const d = H.doorwayColumn(A, read); const thr = H.thresholdCell(A, d)
  assert(!(slot.x === thr.x && slot.z === thr.z), 'the slot is never the doorway threshold')
})

t('reconcileCells: dedupe exact + drop verified-gone, keep present + unknown', () => {
  // mirrors the live corruption: many entries, most gone, some duplicated, some unloaded
  const list = [
    { x: 4, y: 66, z: 3 }, // real table (present)
    { x: 4, y: 66, z: 3 }, // exact duplicate
    { x: 9, y: 66, z: 9 }, // loaded, block GONE
    { x: 1, y: 66, z: 1 }, // furnace cell - NOT a table -> gone for the 'table' kind
    { x: 200, y: 66, z: 200 } // unloaded/unknown - keep (can't disprove)
  ]
  const verify = e => {
    const b = read(e.x, e.y, e.z)
    if (e.x === 200) return null // unloaded
    return !!(b && /crafting_table$/.test(b.name))
  }
  const { keep, pruned } = H.reconcileCells(list, verify)
  const kk = keep.map(e => e.x + ',' + e.y + ',' + e.z)
  assert(kk.includes('4,66,3'), 'the real table survives')
  assert(kk.includes('200,66,200'), 'the unknown/unloaded entry is kept')
  assert.strictEqual(kk.filter(k => k === '4,66,3').length, 1, 'the exact duplicate collapsed')
  assert(!kk.includes('9,66,9') && !kk.includes('1,66,1'), 'verified-gone entries pruned')
  assert.strictEqual(keep.length, 2)
  assert.strictEqual(pruned.length, 3)
})

// ---- #37 non-destructive hut repair: decision predicate + tolerant classifier ----------
t('decideHutRepair: bad<=3 -> none (liveability chain still runs every pass)', () => {
  assert.strictEqual(H.decideHutRepair({ bad: 0, solidTotal: 135 }), 'none')
  assert.strictEqual(H.decideHutRepair({ bad: 3, solidTotal: 135 }), 'none')
})
t('decideHutRepair: 4..threshold-1 -> patch (the default, non-destructive)', () => {
  assert.strictEqual(H.decideHutRepair({ bad: 4, solidTotal: 135 }), 'patch')
  // threshold = max(REBUILD_MIN=24, ceil(0.5*135)=68) = 68 -> 67 still patches
  assert.strictEqual(H.decideHutRepair({ bad: 67, solidTotal: 135 }), 'patch')
  // small schematic: the REBUILD_MIN=24 floor beats ceil(0.5*30)=15, so 20 still patches
  assert.strictEqual(H.decideHutRepair({ bad: 20, solidTotal: 30 }), 'patch')
})
t('decideHutRepair: >=threshold -> rebuild (fresh episode, no latch)', () => {
  assert.strictEqual(H.decideHutRepair({ bad: 68, solidTotal: 135 }), 'rebuild')
  assert.strictEqual(H.decideHutRepair({ bad: 100, solidTotal: 135 }), 'rebuild')
  // the REBUILD_MIN=24 floor is the threshold when 50% is smaller
  assert.strictEqual(H.decideHutRepair({ bad: 24, solidTotal: 30 }), 'rebuild')
})
t('decideHutRepair: rebuild LOCKED OUT when lastBad did not improve (kills the re-empty loop)', () => {
  // catastrophic, but the previous pass already acted and bad did NOT decrease -> patch
  assert.strictEqual(H.decideHutRepair({ bad: 70, solidTotal: 135, lastBad: 70, lastAction: 'rebuild' }), 'patch')
  // got strictly worse -> still locked (never destroy again without measured progress)
  assert.strictEqual(H.decideHutRepair({ bad: 72, solidTotal: 135, lastBad: 70, lastAction: 'rebuild' }), 'patch')
  // measured improvement re-permits the escalation
  assert.strictEqual(H.decideHutRepair({ bad: 70, solidTotal: 135, lastBad: 80, lastAction: 'rebuild' }), 'rebuild')
  // a prior PATCH that didn't help also locks the destructive path down to patch
  assert.strictEqual(H.decideHutRepair({ bad: 70, solidTotal: 135, lastBad: 70, lastAction: 'patch' }), 'patch')
})
t('cellMismatch: tolerant by class (planks / chest / furnace / table / door / air)', () => {
  assert.strictEqual(H.cellMismatch('oak_planks', 'birch_planks'), false, 'any plank satisfies a plank cell')
  assert.strictEqual(H.cellMismatch('chest', 'trapped_chest'), false, 'a trapped_chest satisfies a chest cell')
  assert.strictEqual(H.cellMismatch('furnace', 'smoker'), false, 'a smoker satisfies a furnace cell')
  assert.strictEqual(H.cellMismatch('oak_door', 'spruce_door'), false, 'any door satisfies a door cell')
  assert.strictEqual(H.cellMismatch('crafting_table', 'crafting_table'), false, 'exact table matches')
  assert.strictEqual(H.cellMismatch('air', 'cave_air'), false, 'air variants all read as air')
  assert.strictEqual(H.cellMismatch('air', 'dirt'), true, 'dirt where air is wanted is a mismatch')
  assert.strictEqual(H.cellMismatch('oak_planks', 'air'), true, 'air where a plank is wanted is a mismatch')
  assert.strictEqual(H.cellMismatch(undefined, 'oak_planks'), true, 'undefined want = air; a plank is a mismatch')
  assert.strictEqual(H.cellMismatch('white_bed', 'crafting_table'), true, 'unrelated blocks mismatch')
})

// ---- F3 door-cross ledger core (pure crossVerdict, from navigate.js) -------------------
// The cross-nav loop-breaker: 3 failed crossings of a (hut,dir) in a 90s window -> a 120s
// cooldown; a success clears the entry. navigate.js keeps only the Map + the clock; the
// transition is this pure function.
const nav = require('./navigate.js')
t('crossVerdict: success returns a null entry (a working door never cools down)', () => {
  const r = nav.crossVerdict({ fails: 2, firstAt: 1000, coolUntil: 0 }, 5000, true)
  assert.strictEqual(r.entry, null)
  assert.strictEqual(r.cooled, false)
})
t('crossVerdict: 3 fails inside the 90s window trip a 120s cooldown', () => {
  let r = nav.crossVerdict(null, 1000, false)
  assert.strictEqual(r.entry.fails, 1); assert.strictEqual(r.cooled, false); assert.strictEqual(r.entry.coolUntil, 0)
  r = nav.crossVerdict(r.entry, 2000, false)
  assert.strictEqual(r.entry.fails, 2); assert.strictEqual(r.cooled, false); assert.strictEqual(r.entry.coolUntil, 0)
  r = nav.crossVerdict(r.entry, 3000, false)
  assert.strictEqual(r.entry.fails, 3); assert.strictEqual(r.cooled, true); assert.strictEqual(r.entry.coolUntil, 3000 + 120000)
})
t('crossVerdict: a fail past the 90s window resets the count to 1', () => {
  const r = nav.crossVerdict({ fails: 2, firstAt: 1000, coolUntil: 0 }, 1000 + 90001, false)
  assert.strictEqual(r.entry.fails, 1, 'window elapsed -> fresh count')
  assert.strictEqual(r.entry.firstAt, 1000 + 90001)
  assert.strictEqual(r.cooled, false)
})
t('crossVerdict: a success after failures clears the entry (restores normal door behavior)', () => {
  const r = nav.crossVerdict({ fails: 3, firstAt: 1000, coolUntil: 200000 }, 5000, true)
  assert.strictEqual(r.entry, null)
})

// ---- ANTI-DIVERGENCE: stamp the REAL hut.schem and assert the model reads it -----------
// This is the gate that stops hut-model silently drifting from the schematic's anchor
// convention. Loads bot/schematics/hut.schem OFFLINE (no bot), stamps every non-air block
// into a Map-world at anchor (414,65,85) - the live hut - then asserts the model's reads.
async function stampTest () {
  const schematic = require('./schematic.js')
  const { Vec3 } = require('vec3')
  const SA = { x: 414, y: 65, z: 85 }
  let schem = null
  for (const ver of ['1.21.11', '1.21.1', '1.21', '1.20.4', '1.20.1']) {
    try { schem = await schematic.loadFile('hut.schem', ver); break } catch {}
  }
  assert(schem, 'hut.schem must load for the stamp test (tried 1.21.x / 1.20.x)')
  const sw = new Map()
  const skey = (x, y, z) => x + ',' + y + ',' + z
  const sread = (x, y, z) => sw.get(skey(x, y, z)) || null
  const st = schem.start(); const en = schem.end()
  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const b = schem.getBlock(new Vec3(x, y, z))
    if (!b || !b.name || /air$/.test(b.name)) continue // air / interior - leave absent
    const wx = SA.x + (x - st.x); const wy = SA.y + (y - st.y); const wz = SA.z + (z - st.z)
    sw.set(skey(wx, wy, wz), { name: b.name, boundingBox: b.boundingBox || 'block' })
  }
  // grade dirt one below the slab (realism; not required by any assertion)
  for (let x = SA.x - 1; x <= SA.x + 6; x++) for (let z = SA.z - 1; z <= SA.z + 6; z++) if (!sread(x, SA.y - 1, z)) sw.set(skey(x, SA.y - 1, z), { name: 'dirt', boundingBox: 'block' })

  t('STAMP hut.schem: doorwayColumn reads the real door column (416,85)', () => {
    const d = H.doorwayColumn(SA, sread)
    assert(d, 'a doorway must be found in the real schematic')
    assert.deepStrictEqual({ x: d.x, z: d.z }, { x: 416, z: 85 })
  })

  t('STAMP hut.schem: freeStandCells non-empty, every feet at y===66 (anchor.y+1)', () => {
    const free = H.freeStandCells(SA, sread)
    assert(free.length > 0, 'the real hut has standable interior cells')
    assert(free.every(c => c.y === 66), 'every free feet cell is anchor.y+1 = 66')
  })

  t('STAMP hut.schem: stationCells reports the real furniture (2 chests, 1 table, 1 furnace)', () => {
    const s = H.stationCells(SA, sread)
    assert.strictEqual(s.chest.length, 2, 'two chests in the schematic')
    assert.strictEqual(s.table.length, 1, 'one crafting table')
    assert.strictEqual(s.furnace.length, 1, 'one furnace')
    assert(s.chest.every(c => c.y === 66) && s.table.every(c => c.y === 66) && s.furnace.every(c => c.y === 66), 'furniture stands at anchor.y+1')
  })

  t('STAMP hut.schem: floorHoles=0 intact, =1 after deleting a floor plank at anchor.y', () => {
    assert.strictEqual(H.floorHoles(SA, sread).length, 0, 'the schematic floor slab is intact')
    sw.delete(skey(415, 65, 86)) // remove an interior floor plank at anchor.y (rel 1,0,1)
    const holes = H.floorHoles(SA, sread)
    assert.strictEqual(holes.length, 1, 'exactly one floor hole after deleting one plank')
    assert.deepStrictEqual(holes.map(h => h.x + ',' + h.y + ',' + h.z), ['415,65,86'])
  })
}

stampTest().then(() => {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall hut-model tests passed')
  process.exit(failures ? 1 : 0)
}).catch(e => {
  console.log('FAIL  stamp test threw\n      ' + e.stack)
  process.exit(1)
})
