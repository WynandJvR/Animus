'use strict'
// ringtest.js - the scaffold ring's planner (lib/ring.js planRing) on a fake world: a 7x7 room walled up to y104 on a floor
// at y100 (stands at y101), the wall's next layer (y105) still to place and no stand reaching it; outside the room the
// ground lies 10 lower. The ring goes INSIDE (outside its edge drops past SAFE_DROP), two under the layer (y103), up a
// tower from the floor, along the wall; never in a cell the rules refuse (a doorway), never in a build cell, and none at
// all when the floor is too deep for a safe edge.
// usage: node tools/session-scripts/ringtest.js
const path = require('path')
const ring = require(path.join(__dirname, '..', '..', 'bot2', 'lib', 'ring.js'))
const k = (x, y, z) => `${x},${y},${z}`

function makeWorld ({ floorY = 100, outsideY = 90, extraJob = [] } = {}) {
  const solid = new Set(); const job = new Set()
  for (let x = -6; x <= 12; x++) for (let z = -6; z <= 12; z++) {
    const inside = x >= 0 && x <= 6 && z >= 0 && z <= 6
    for (let y = 80; y <= (inside ? floorY : outsideY); y++) solid.add(k(x, y, z))
  }
  // the walls: the ring x=0/6, z=0/6, y floorY+1..104 placed; y105 still to place (a job cell, air)
  for (let x = 0; x <= 6; x++) for (let z = 0; z <= 6; z++) {
    if (x > 0 && x < 6 && z > 0 && z < 6) continue
    for (let y = floorY + 1; y <= 105; y++) { job.add(k(x, y, z)); if (y <= 104) solid.add(k(x, y, z)) }
  }
  for (const p of extraJob) job.add(k(p.x, p.y, p.z))
  const name = (x, y, z) => solid.has(k(x, y, z)) ? 'stone_bricks' : 'air'
  const w = {
    at: (x, y, z) => ({ name: name(x, y, z) }),
    isAirish: b => b.name === 'air',
    isSolid: b => b.name !== 'air',
    jobHas: (x, y, z) => job.has(k(x, y, z)),
    airDown: (x, y, z) => { for (let n = 0; n <= 32; n++) if (solid.has(k(x, y - n, z))) return n; return null },
    hot: () => false,
    SAFE_DROP: 3
  }
  // the walk reaches the room's floor (inside, feet at floorY+1)
  const stand = (x, y, z) => y === floorY + 1 && x > 0 && x < 6 && z > 0 && z < 6
  return { w, stand, job }
}

(async () => {
let ok = true; const check = (c, what) => { console.log(`${c ? 'PASS' : 'FAIL'} ${what}`); if (!c) ok = false }
// the needy cells: the west wall's next layer, x=0, z=1..5, y105
const needy = [1, 2, 3, 4, 5].map(z => ({ x: 0, y: 105, z }))

{
  const { w, stand } = makeWorld()
  const p = await ring.planRing(w, needy, { stand })
  check(!!p, 'a ring is planned for the wall layer with no stand')
  if (p) {
    check(p.y === 103, `two under the layer (y${p.y})`)
    check(p.blocks.every(b => b.x === 1), `inside the wall only (x=1: ${p.blocks.map(b => b.x + ',' + b.z).join(' ')})`)
    check(p.access.kind === 'tower' && p.access.tower[0].y === 101 && p.access.tower[p.access.tower.length - 1].y === 103, 'up a tower from the floor to the walkway')
    check(p.serves.length === needy.length, `serves every cell (${p.serves.length}/${needy.length})`)
  }
}
{
  // a doorway at x=1,z=3 (the refusal the room rules would give): that block is never laid
  const { w, stand } = makeWorld()
  const p = await ring.planRing(w, needy, { stand, refused: r => r.x === 1 && r.z === 3 })
  check(!!p && !p.blocks.some(b => b.x === 1 && b.z === 3), 'a refused cell (a doorway) never gets a ring block')
}
{
  // a build cell at the ring's height inside: never a ring block there
  const { w, stand } = makeWorld({ extraJob: [{ x: 1, y: 103, z: 2 }] })
  const p = await ring.planRing(w, needy, { stand })
  check(!!p && !p.blocks.some(b => b.x === 1 && b.z === 2), 'never in a build cell')
}
{
  // the room's floor 8 under the walkway: every edge a hurting drop - no ring
  const { w } = makeWorld({ floorY: 95 })
  const stand = (x, y, z) => y === 96 && x > 0 && x < 6 && z > 0 && z < 6
  const p = await ring.planRing(w, needy, { stand })
  check(!p, 'no ring over a drop past SAFE_DROP')
}
{
  // a middle block refused (a doorway) with a deep drop beside the walkway: the planned walkway is only what holds its edges
  // on its own - no laid block may have an open side over a drop past SAFE_DROP (the candidate beside it no cover); audit
  const { w, stand } = makeWorld()
  // a pit under the refused block's own column (x=1, z=3: the floor dug to y90) - a candidate in the first pass, so its
  // neighbours (1,2) and (1,4) counted it as cover; refused, it is no cover, and their side over it drops 13
  const at0 = w.at; const airDown0 = w.airDown
  w.at = (x, y, z) => (x === 1 && z === 3 && y <= 100 && y > 90) ? { name: 'air' } : at0(x, y, z)
  w.airDown = (x, y, z) => (x === 1 && z === 3) ? (y - 90) : airDown0(x, y, z)
  const p = await ring.planRing(w, needy, { stand, refused: r => r.x === 1 && r.z === 3 })
  const cover = new Set((p ? p.blocks : []).map(b => `${b.x},${b.y},${b.z}`))
  const open = p ? p.blocks.filter(b => !ring.edgeOkFor(w, b, p.y, cover)) : []
  check(!p || open.length === 0, `every laid block holds its edges on the walkway alone (${p ? p.blocks.map(b => b.x + ',' + b.z).join(' ') : 'no plan'}; open: ${open.length})`)
  check(!p || !p.blocks.some(b => b.x === 1 && (b.z === 2 || b.z === 4)), 'the blocks beside the refused one over the pit are not laid')
}
{
  // a tower top between two walkway blocks, one of them never laid, over a deep drop on that side: the laid walkway does not
  // hold (walkwayHolds asks the tower's top too); with both laid it does; audit
  const { w } = makeWorld()
  const at0 = w.at; const airDown0 = w.airDown
  // the unlaid side of the tower top (3,2) is the column (3,1) - dug out to y90
  w.at = (x, y, z) => (x === 3 && z === 1 && y <= 100 && y > 90) ? { name: 'air' } : at0(x, y, z)
  w.airDown = (x, y, z) => (x === 3 && z === 1) ? (y - 90) : airDown0(x, y, z)
  const top = { x: 3, y: 103, z: 2 }
  const half = [{ x: 3, y: 103, z: 3 }]; const both = [{ x: 3, y: 103, z: 3 }, { x: 3, y: 103, z: 1 }]
  check(!ring.walkwayHolds(w, half, 103, [top]), 'a tower top with its walkway half laid over a drop: does not hold')
  check(ring.edgeOkFor(w, top, 103, new Set(both.map(b => `${b.x},${b.y},${b.z}`))), 'with both sides laid the tower top holds its own edges')
}
{
  // A TALL ROOM: its floor a block deeper (stands at y100) - two under the layer the walkway's open side drops 4, past
  // SAFE_DROP; the ring goes one lower (y102), its eye still on the layer (2026-10-07 17:16: "none" at every y130 cluster)
  const { w } = makeWorld({ floorY: 99 })
  const stand = (x, y, z) => y === 100 && x > 0 && x < 6 && z > 0 && z < 6
  const stats = []
  const p = await ring.planRing(w, needy, { stand, stats })
  check(!!p && p.y === 102, `a tall room: the ring one lower, where its edges hold (y${p ? p.y : '-'}; tried ${stats.map(st => 'y' + st.y + ' edges ' + st.edges).join(', ')})`)
  check(!!p && p.serves.length === needy.length, `...and its eye still reaches the layer (${p ? p.serves.length : 0}/${needy.length})`)
  const cover = new Set((p ? p.blocks : []).map(b => `${b.x},${b.y},${b.z}`))
  check(!!p && p.blocks.every(b => ring.edgeOkFor(w, b, p.y, cover)), '...every edge of it within SAFE_DROP')
}
{
  // no way up at all (nothing the walk reaches): no ring
  const { w } = makeWorld()
  check(!(await ring.planRing(w, needy, { stand: () => false })), 'no ring without a stand to start from')
}
console.log(ok ? 'ALL PASS' : 'SOME FAILED')
process.exit(ok ? 0 : 1)
})()
