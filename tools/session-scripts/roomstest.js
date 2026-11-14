'use strict'
// roomstest.js - the doorway rule (lib/rooms.js closesRoom) on a fake world: a 5x5 room walled 3 high with a 3-wide,
// 2-high gap in its west wall and one cell of the build still to place in the middle. The gap is filled a column at a
// time: the first two go in; the last foot is held (and its lintel), since the room would close with work inside. No work
// inside: nothing held. A door in the gap: never held. A room with a second way in: nothing held.
// usage (from bot2/): node ../tools/session-scripts/roomstest.js
const path = require('path')
const rooms = require(path.join(__dirname, '..', '..', 'bot2', 'lib', 'rooms.js'))

function makeWorld () {
  const solid = new Set() // placed blocks above the floor
  const k = (x, y, z) => `${x},${y},${z}`
  // the room: walls x=0..6, z=0..6 (ring), y65..67; the gap: x=0, z=2..4, y65..66 (y67 stays - the lintel line)
  for (let x = 0; x <= 6; x++) for (let z = 0; z <= 6; z++) {
    if (x > 0 && x < 6 && z > 0 && z < 6) continue
    for (let y = 65; y <= 67; y++) if (!(x === 0 && z >= 2 && z <= 4 && y <= 66)) solid.add(k(x, y, z))
  }
  const name = (x, y, z) => (y <= 64 ? 'stone' : solid.has(k(x, y, z)) ? 'stone_bricks' : 'air')
  const at = (x, y, z) => ({ name: name(x, y, z), getProperties: () => ({}) })
  const w = {
    at,
    isAirish: b => b.name === 'air',
    isOpenTrapdoor: () => false,
    isSolid: b => b.name !== 'air',
    standable: (x, y, z) => name(x, y, z) === 'air' && name(x, y + 1, z) === 'air' && name(x, y - 1, z) !== 'air',
    plateEdge: () => null,
    SAFE_DROP: 3
  }
  return { w, solid, k }
}

let ok = true; const check = (c, what) => { console.log(`${c ? 'PASS' : 'FAIL'} ${what}`); if (!c) ok = false }

function scenario ({ work = true, doorName = null, doorOpen = null, backDoor = false }) {
  const { w, solid, k } = makeWorld()
  if (backDoor) { solid.delete(k(6, 65, 3)); solid.delete(k(6, 66, 3)) } // (a second way in, east wall)
  const box = { x1: -5, x2: 11, z1: -5, z2: 11 }
  const q = { x: 3, y: 65, z: 3, name: 'crafting_table' } // (the room's middle, still to place)
  const gap = []; for (const z of [2, 3, 4]) for (const y of [65, 66]) gap.push({ x: 0, y, z, name: 'stone_bricks' })
  const unbuilt = new Set(gap.map(c => k(c.x, c.y, c.z))); if (work) unbuilt.add(k(q.x, q.y, q.z))
  const jobUnbuilt = (x, y, z) => unbuilt.has(k(x, y, z))
  const W = rooms.walkModel(w)
  const standsOf = c => { const out = []; for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 0; dy++) { const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }; if (W.st(p.x, p.y, p.z) && Math.hypot(dx, dz) <= 4.2) out.push(p) } return out }
  const verdicts = []
  for (const c of gap) {
    if (doorName && c.z === 4) { c.name = doorName; if (doorOpen != null) c.want = { open: String(doorOpen) } }
    const work0 = work ? [q] : []
    const held = rooms.closesRoom(w, c, { box, jobUnbuilt, work: work0, standsOf })
    verdicts.push({ c, held: !!held })
    if (!held) { solid.add(k(c.x, c.y, c.z)); unbuilt.delete(k(c.x, c.y, c.z)) }
  }
  return verdicts
}

{
  const v = scenario({ work: true })
  const heldCells = v.filter(x => x.held).map(x => `${x.c.z}/${x.c.y}`)
  check(v.filter(x => x.c.z < 4).every(x => !x.held), 'work inside: the first two gap columns go in')
  check(v.some(x => x.c.z === 4 && x.c.y === 65 && x.held), 'work inside: the last doorway foot (z4, y65) is held')
  check(v.some(x => x.c.z === 4 && x.c.y === 66 && x.held), 'work inside: its lintel (z4, y66) is held too')
  console.log('   held:', heldCells.join(' '))
}
check(scenario({ work: false }).every(x => !x.held), 'no work inside: nothing held, the room closes')
check(scenario({ work: true, doorName: 'oak_door' }).filter(x => x.c.z === 4).every(x => !x.held), 'a door in the last gap: never held')
check(scenario({ work: true, doorName: 'spruce_trapdoor', doorOpen: true }).filter(x => x.c.z === 4).every(x => !x.held), 'an OPEN trapdoor in the last gap: never held')
check(scenario({ work: true, doorName: 'spruce_trapdoor', doorOpen: false }).some(x => x.c.z === 4 && x.c.y === 65 && x.held), 'a CLOSED trapdoor in the last gap: held like a block')
check(scenario({ work: true, backDoor: true }).every(x => !x.held), 'a second way in: nothing held')
// ONE-WAY POCKETS (rooms.oneWay - walkReach's sinks): a flat floor at y64 with a 2x2 pit 2 deep (a drop the walk takes) and no
// way back up; and a second pit with a step-stair out. The walk from the floor reaches both pits; the first is one way only,
// the second is not - the chimney nest the walk dropped into, 2026-10-07 18:47
;(async () => {
  const k = (x, y, z) => `${x},${y},${z}`
  const pitA = (x, z) => x >= 4 && x <= 5 && z >= 4 && z <= 5
  const pitB = (x, z) => x >= 10 && x <= 11 && z >= 4 && z <= 5
  const name = (x, y, z) => {
    if (y <= 61) return 'stone' // (the pits' floors: feet at y62, two under the floor's y64 - a drop the walk takes)
    if (x === 11 && z === 5 && y === 62) return 'stone' // (pit B's stair: a block a step up, then the floor)
    if (pitA(x, z) || pitB(x, z)) return 'air'
    return y <= 63 ? 'stone' : 'air'
  }
  const at = (x, y, z) => ({ name: name(x, y, z), getProperties: () => ({}) })
  const w = { at, isAirish: b => b.name === 'air', isOpenTrapdoor: () => false, isSolid: b => b.name !== 'air', standable: (x, y, z) => name(x, y, z) === 'air' && name(x, y + 1, z) === 'air' && name(x, y - 1, z) !== 'air', plateEdge: () => null, SAFE_DROP: 3 }
  const W = rooms.walkModel(w)
  const start = { x: 0, y: 64, z: 0 }; const inArea = q => q.x >= -2 && q.x <= 16 && q.z >= -2 && q.z <= 10
  const cells = new Set([k(0, 64, 0)]); const back = new Map(); const q = [start]; const leaves = []
  for (let i = 0; i < q.length; i++) {
    const c = q[i]; if (!inArea(c)) { leaves.push(k(c.x, c.y, c.z)); continue }
    for (const n of W.next(c)) { const nk = k(n.x, n.y, n.z); const bl = back.get(nk); if (bl) bl.push(k(c.x, c.y, c.z)); else back.set(nk, [k(c.x, c.y, c.z)]); if (!cells.has(nk)) { cells.add(nk); q.push(n) } }
  }
  const sinks = await rooms.oneWay(cells, back, [k(0, 64, 0), ...leaves])
  check(cells.has(k(4, 62, 4)) && sinks.has(k(4, 62, 4)) && sinks.has(k(5, 62, 5)), 'a pit the walk drops into with no way back up: one way only')
  check(cells.has(k(10, 62, 4)) && !sinks.has(k(10, 62, 4)), 'a pit with a stair out: not one way')
  check(![...sinks].some(kk => kk.split(',')[1] === '64'), 'the floor itself: never one way')
  console.log(ok ? 'ALL PASS' : 'SOME FAILED')
  process.exit(ok ? 0 : 1)
})()
