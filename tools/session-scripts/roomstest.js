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
console.log(ok ? 'ALL PASS' : 'SOME FAILED')
process.exit(ok ? 0 : 1)
