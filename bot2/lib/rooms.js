'use strict'
// ROOMS - the walk's step model (ONE copy: the way-out search, the stands' regions, the room rule) and the doorway rule.
// Pure over a small world interface `w`, so it runs on the live bot and on a test's fake world alike:
//   w = { at(x,y,z), isAirish(b), isOpenTrapdoor(b), isSolid(b), standable(x,y,z), plateEdge(b), SAFE_DROP }

const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
const CCW = { east: 'north', south: 'east', west: 'south', north: 'west' }
const key = p => `${p.x},${p.y},${p.z}`
const CLIMB_RE = /^ladder$/ // (what the planner climbs - mineflayer-pathfinder's climbables: the ladder alone; audit)

// a door's panel edge: closed, the edge opposite its facing; open, swung to the hinge's side
function doorPanel (door) {
  let pr = {}; try { pr = door.getProperties() || {} } catch {}
  const f = pr.facing; if (!OPP[f]) return null
  const open = pr.open === true || pr.open === 'true'
  return !open ? OPP[f] : (pr.hinge === 'right' ? CW[f] : CCW[f])
}
function edgeOf (dx, dz) { return dx === 1 ? 'east' : dx === -1 ? 'west' : dz === 1 ? 'south' : 'north' }

// THE STEP MODEL: what a body standing at p may walk to next (no dig, no place). isC: cells taken as solid.
// (a door or a fence gate is a way through - the bot crosses them; counted solid, a room behind a door read as sealed and
//  every cell placed from inside it was held back, 2026-09-29) (and an OPEN trapdoor - an edge, not a wall: the planner's
//  rule. Counted solid, the room behind the castle's inner trapdoors read as sealed, 2026-09-29) (a door cell is stood in
//  on its floor and entered or left through any edge but its panel's - the physics decides; audit)
// opens: a door is a way through whatever its state - the walker opens it (move.crossDoor, the planner's door rule); for the
// question "can I get there", where a door shut behind me read as a wall and the castle beyond it as out of reach (audit)
// avoid(x,y,z): a cell the body may not stand in - never a floor, never a wall (the walk search's: a leg the body could not
// make, a cell the planner prices out). Passed as isC it was a SOLID cell, a floor for the cell over it: a leg end marked bad
// stood the search on air over it, 2026-10-06
function walkModel (w, isC = () => false, { opens = false, avoid = null } = {}) {
  const passable = b => (w.bodyPassable ? w.bodyPassable(b) : w.isAirish(b)) || w.isOpenTrapdoor(b) || (/_door$|_fence_gate$/.test(b.name) && !/^iron_door$/.test(b.name))
  const air = (x, y, z) => { if (isC(x, y, z)) return false; const b = w.at(x, y, z); return !!b && passable(b) }
  const climb = (x, y, z) => { if (isC(x, y, z)) return false; const b = w.at(x, y, z); return !!b && CLIMB_RE.test(b.name) }
  // (never ON or IN a fire - a campfire, magma: the planner's blocksToAvoid; the castle's 150 campfires read as floor here and
  //  a route over one was no route to the walker; audit 2026-10-03)
  const topAt = (x, y, z) => isC(x, y, z) ? y + 1 : w.floorTop ? w.floorTop(x, y, z) : y + 1 // (a floor's real top, absolute)
  const hot = (x, y, z) => { const b = w.at(x, y, z); return !!b && /^(soul_)?campfire$|^magma_block$|(^|_)fire$/.test(b.name) }
  const st = (x, y, z) => { if (hot(x, y - 1, z) || hot(x, y, z)) return false; if (!air(x, y, z) || !air(x, y + 1, z)) return false; if (avoid && avoid(x, y, z)) return false; if (isC(x, y - 1, z)) return true; const fb = w.at(x, y, z); if (fb && (/_door$/.test(fb.name) || w.isOpenTrapdoor(fb))) { const fl = w.at(x, y - 1, z); return !!fl && w.isSolid(fl) && !w.isOpenTrapdoor(fl) && !/_door$/.test(fl.name) && !(w.floorTop && w.floorTop(x, y - 1, z) > y - 1 + 1.01) } /* (never on a door nor a fence-high floor: world.standable's floor rule, the planner's) */ return w.standable(x, y, z) }
  // (an open door's or trapdoor's plate by plateEdge - the planner's own model; a CLOSED door by its panel here)
  // (opens: a CLOSED door is a way through - the crossing opens it; an OPEN one's plate is an edge, as the planner's own
  //  panel rule has it. Both were free here: a leg ran past an open door's plate to the ladder behind it, the planner
  //  refused that step and the leg timed out where it began, 2026-10-06)
  const panelOf = b => { if (!b) return null; const v = w.plateEdge(b); if (v) return edgeOf(v[0], v[1]); if (opens && /_door$/.test(b.name) && !/^iron_door$/.test(b.name)) return null; if (/_door$/.test(b.name)) return doorPanel(b); return null }
  const edgeShut = (x, y, z, dx, dz) => [w.at(x, y, z), w.at(x, y + 1, z)].some(b => panelOf(b) === edgeOf(dx, dz))
  // A PLATE CELL IS PASSED ALONG ITS PLATE: a cell with an open trapdoor's or door's plate at the feet or the head is entered
  // and left only parallel to the plate - never toward it nor away from it, so no turn inside it. Stepped into face-on and
  // turned in, the 0.6 body met the plate's end at the cell's corner: the closet of open shutters behind the south
  // courtyard's door was a way in to the search, the body wedged at its plates walk after walk, two break-outs and a trap,
  // 2026-10-07. (A doorway's open door hangs along the passage: walked through as before)
  const platesAt = (x, y, z) => { const out = []; for (const yy of [y, y + 1]) { if (isC(x, yy, z)) continue; const v = w.plateEdge(w.at(x, yy, z)); if (v) out.push(v) } return out }
  const along = (x, y, z, dx, dz) => platesAt(x, y, z).every(v => v[0] * dx + v[1] * dz === 0)
  const next = p => {
    const out = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.x + dx; const z = p.z + dz
      if (edgeShut(p.x, p.y, p.z, dx, dz)) continue
      if (edgeShut(x, p.y, z, -dx, -dz)) continue
      if (!along(p.x, p.y, p.z, dx, dz)) continue // (out of a plate cell: along its plate only)
      // (a drop the planner takes: its landing BLOCK within maxDropDown (SAFE_DROP) of the feet - the feet two lower at most;
      //  three lower was 280 of the castle's walk-model steps the planner refuses, legs that never left; castlewalktest.js)
      for (let dy = 1; dy >= -(w.SAFE_DROP - 1); dy--) {
        const y = p.y + dy
        if (dy === 1 && !air(p.x, p.y + 2, p.z)) continue // (a step up wants the head room to jump)
        if (dy < 0) { let open = true; for (let yy = y + 2; yy <= p.y + 1; yy++) if (!air(x, yy, z)) open = false; if (!open) break } // (a drop wants its column open)
        if (!st(x, y, z)) continue
        if (!along(x, y, z, dx, dz)) break // (into a plate cell: along its plate only - nor any lower cell of that column)
        // (and never a rise past a jump: floor top to floor top over 1.2 - onto a fence, a wall or a closed gate from the
        //  ground beside it: the body cannot, the planner does not; w.floorTop - the world's floorTop - absent: whole blocks)
        if (dy > -1 && topAt(x, y - 1, z) - (climb(p.x, p.y, p.z) ? p.y : topAt(p.x, p.y - 1, p.z)) > 1.2) continue // (1.2: the planner's own "too high to jump") // (on a ladder the climb lifts the body: its base is its own cell's)
        out.push({ x, y, z }); break
      }
    }
    // CLIMBING: a ladder column is gone up and down - the planner climbs it (mineflayer-pathfinder's climbables);
    // without it every floor served by the castle's ladders read as shut off (audit 2026-10-02)
    if (climb(p.x, p.y, p.z)) { // (a ladder at the feet - the planner's rule)
      const y = p.y + 1
      if ((climb(p.x, y, p.z) || air(p.x, y, p.z)) && (climb(p.x, y + 1, p.z) || air(p.x, y + 1, p.z)) && !(avoid && avoid(p.x, y, p.z))) out.push({ x: p.x, y, z: p.z })
    }
    if (climb(p.x, p.y - 1, p.z) && !(avoid && avoid(p.x, p.y - 1, p.z))) out.push({ x: p.x, y: p.y - 1, z: p.z })
    return out
  }
  return { air, st, next }
}

// A DEAD END: a cell the walk model has no step out of AND the planner that walks the legs has no move out of (no dig, no
// place) - plannerExits(p): true when it has one. A leg ending there never leaves (a 1x1 shaft over a lantern, every walk
// an instant noPath for 20 minutes, 2026-10-07). Both, never the model alone: the model is stricter on purpose in places
// (a plate cell left along its plate only, never onto a fire) and a cell it alone reads as closed is a cell the planner
// still walks out of - no reason to drop it (castlewalktest.js counts both)
function deadEnd (W, p, plannerExits) { return !W.next(p).length && !plannerExits(p) }

// A WALK REGION round p: out if it leaves the box (x/z) or runs past `cap` cells (no compartment); else closed, with its
// cells. NO sky exit - a region asks whether a walker gets IN or OUT on foot (over a roofless compartment's wall is a drop
// the walk refuses; audit). memo: key -> the region, filled for every cell seen.
// (opens: closed doors walked, as the bot crosses them - the walker's own way out; the room rule keeps them as walls)
// (ONE COPY, TWO PACES: the search is a generator - region() runs it through at once; a caller that must give the event
//  loop back (the ring's room rules, build.js) steps it and yields between steps - run(), runAsync())
const STEP_CELLS = 16
function run (g) { let n; do { n = g.next() } while (!n.done); return n.value }
async function runAsync (g, tick) { let n; do { n = g.next(); if (!n.done) await tick() } while (!n.done); return n.value }
function region (w, box, p, opts = {}) { return run(regionGen(w, box, p, opts)) }
function * regionGen (w, box, p, { memo = new Map(), isC = () => false, cap = 300, opens = false } = {}) {
  const k0 = key(p); const hit = memo.get(k0); if (hit) return hit
  const inBox = q => q.x >= box.x1 && q.x <= box.x2 && q.z >= box.z1 && q.z <= box.z2
  const W = walkModel(w, isC, { opens })
  const r = { out: false, cells: null }
  const seen = new Set([k0]); const q = [{ x: p.x, y: p.y, z: p.z }]; let i = 0
  while (i < q.length) {
    if (seen.size > cap) { r.out = true; break }
    const c = q[i++]
    if (!inBox(c)) { r.out = true; break }
    for (const n of W.next(c)) { const k = key(n); if (!seen.has(k)) { seen.add(k); q.push(n) } }
    if (i % STEP_CELLS === 0) yield
  }
  if (!r.out) r.cells = seen
  for (const k of seen) memo.set(k, r)
  return r
}

// A WAY OUT ON FOOT, searched toward the nearest edge first: { out, seen } - out when a walk from p leaves the box's
// footprint, seen the cells it went through (keys). Best-first by the distance to the box's edge, so an open room finds its
// way out in tens of cells; a closed one explores all of itself, to `cap`. (wallsMeIn's question - a plain region search
// from inside the castle ran 700 cells for an answer the first doorway gives)
function exitReach (w, box, p, { isC = () => false, cap = 700, opens = true } = {}) {
  const W = walkModel(w, isC, { opens })
  const edge = q => Math.min(q.x - box.x1, box.x2 - q.x, q.z - box.z1, box.z2 - q.z)
  const buckets = []; const push = q => { const d = Math.max(0, edge(q)); (buckets[d] = buckets[d] || []).push(q) }
  const seen = new Set([key(p)]); push(p)
  for (let d = 0; d < buckets.length || buckets.some(Boolean);) {
    const b = buckets[d]; if (!b || !b.length) { d++; if (d >= buckets.length) break; continue }
    const c = b.pop()
    if (c.x < box.x1 || c.x > box.x2 || c.z < box.z1 || c.z > box.z2) return { out: true, seen }
    if (seen.size > cap) return { out: true, seen }
    for (const n of W.next(c)) { const k = key(n); if (!seen.has(k)) { seen.add(k); const nd = Math.max(0, edge(n)); push(n); if (nd < d) d = nd } }
  }
  return { out: false, seen }
}

// A DOORWAY FOOT: an empty cell with room for a head over it (air, or an unbuilt cell of the build), walkable on two
// opposite sides and shut on the other two (a wall, or an unbuilt cell of the build - it will be one). The axis through it
// [dx, dz], or null. jobUnbuilt(x,y,z): a cell of the build still to place.
function doorwayAxis (w, jobUnbuilt, f) {
  const W = walkModel(w)
  const empty = (x, y, z) => { const b = w.at(x, y, z); return !!b && w.isAirish(b) }
  if (!empty(f.x, f.y, f.z) || !(empty(f.x, f.y + 1, f.z) || jobUnbuilt(f.x, f.y + 1, f.z))) return null
  const shut = (x, y, z) => { const b = w.at(x, y, z); return !b || w.isSolid(b) || jobUnbuilt(x, y, z) }
  for (const [dx, dz] of [[1, 0], [0, 1]]) {
    const open = W.st(f.x + dx, f.y, f.z + dz) && W.st(f.x - dx, f.y, f.z - dz)
    const sides = shut(f.x + dz, f.y, f.z + dx) && shut(f.x - dz, f.y, f.z - dx)
    if (open && sides) return [dx, dz]
  }
  return null
}

// WOULD PLACING c CLOSE A ROOM WITH WORK STILL INSIDE? - a player leaves the doorway open until the room is done
// (0 of 6 placed, stands in compartments the builder had closed on their own interior, 2026-09-29; audit):
//   - only a doorway's cells: c itself as the doorway's foot, or c the head cell over one (a lintel closes it the same)
//   - a door or a gate never closes a room (the walk goes through it); a trapdoor only when the cell wants it OPEN - a
//     closed shutter seals a doorway like a block: the castle's low room was closed with a top-half trapdoor on its own
//     interior, the bot inside, three escapes out through the walls, 2026-09-30; audit
//   - with c solid, each side's walk region: closed (not out), holding a cell of the build still to place whose EVERY
//     stand lies inside it (placeable only from within) - then c waits. A cell placeable from outside needs no doorway.
// opts: { box, jobUnbuilt(x,y,z), work: [cells still to place, near], standsOf(q) -> [{x,y,z}] }
function closesRoom (w, c, { box, jobUnbuilt, work, standsOf }) {
  if (/_door$|_fence_gate$/.test(c.name || '')) return null
  if (/_trapdoor$/.test(c.name || '') && ((c.want && String(c.want.open) === 'true') || (c.props && String(c.props.open) === 'true'))) return null
  let f = null; let axis = doorwayAxis(w, jobUnbuilt, c)
  if (axis) f = c
  else { const below = { x: c.x, y: c.y - 1, z: c.z }; axis = doorwayAxis(w, jobUnbuilt, below); if (axis) f = below }
  if (!f) return null
  const isC = (x, y, z) => x === c.x && y === c.y && z === c.z
  const memo = new Map()
  for (const s of [{ x: f.x + axis[0], y: f.y, z: f.z + axis[1] }, { x: f.x - axis[0], y: f.y, z: f.z - axis[1] }]) {
    // (its own cap: a hall of more than 300 walkable cells read as open, its doorway closable on it - this runs only for a
    //  doorway at placement; audit)
    const r = region(w, box, s, { memo, isC, cap: 1500 })
    if (r.out) continue
    // (only a cell within a stand's reach of the room can have every stand in it: the room's bounds, 3 out; audit) - exact
    //  for build.js standsOf's window (dx, dz -3..3, dy -4..1 round the cell): WIDEN THIS WITH IT if that window grows
    let x1 = Infinity; let x2 = -Infinity; let y1 = Infinity; let y2 = -Infinity; let z1 = Infinity; let z2 = -Infinity
    for (const k of r.cells) { const [x, y, z] = k.split(',').map(Number); if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; if (z < z1) z1 = z; if (z > z2) z2 = z }
    for (const q of work) {
      if (q.x < x1 - 3 || q.x > x2 + 3 || q.z < z1 - 3 || q.z > z2 + 3 || q.y < y1 - 1 || q.y > y2 + 4) continue
      if (q.x === c.x && q.y === c.y && q.z === c.z) continue
      // (a stand ON c, or with its head in c, is no stand once c is placed - the doorway's own cell read as "a stand outside")
      const stands = standsOf(q).filter(p => !isC(p.x, p.y, p.z) && !isC(p.x, p.y + 1, p.z))
      if (stands.length && stands.every(p => r.cells.has(key(p)))) return { side: s, cell: q, size: r.cells.size }
    }
  }
  return null
}

// THE LAST OPENING, ANY CELL: closesRoom's rule without its doorway shape - placing c turns a walk region that leads out
// into one that does not (c the last opening: a gap in a wall, a hole in a floor, a step's head room), and that region holds
// a cell of the build placeable only from within. The room rule asked it of doorway feet and lintels alone; the castle's
// upper rooms were closed by a wall cell, a floor slab, a stair, and 84 cells waited "for a way in", 2026-10-07. The sides:
// every cell a body stands in beside c, above or below its level by one, and the cell over c (c its floor). Small rooms
// only (cap): a big hall is no pocket. { side, cell, size } or null
function closesPocket (w, c, opts) { return run(closesPocketGen(w, c, opts)) }
async function closesPocketAsync (w, c, opts, tick) { return runAsync(closesPocketGen(w, c, opts), tick) }
function * closesPocketGen (w, c, { box, work, standsOf, cap = 300 }) {
  if (/_door$|_fence_gate$/.test(c.name || '')) return null
  if (/_trapdoor$/.test(c.name || '') && ((c.want && String(c.want.open) === 'true') || (c.props && String(c.props.open) === 'true'))) return null
  const isC = (x, y, z) => x === c.x && y === c.y && z === c.z
  const W = walkModel(w, isC)
  const sides = [{ x: c.x, y: c.y + 1, z: c.z }]
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -1, 1]) sides.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz })
  const memo = new Map(); const memo0 = new Map()
  for (const s of sides) {
    if (!W.st(s.x, s.y, s.z)) continue
    const r = yield * regionGen(w, box, s, { memo, isC, cap })
    if (r.out) continue
    // (closed already without c: c is not its last opening - holding it opens nothing)
    if (!(yield * regionGen(w, box, s, { memo: memo0, cap })).out) continue
    let x1 = Infinity; let x2 = -Infinity; let y1 = Infinity; let y2 = -Infinity; let z1 = Infinity; let z2 = -Infinity
    for (const k of r.cells) { const [x, y, z] = k.split(',').map(Number); if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; if (z < z1) z1 = z; if (z > z2) z2 = z }
    for (const q of work) {
      if (q.x < x1 - 3 || q.x > x2 + 3 || q.z < z1 - 3 || q.z > z2 + 3 || q.y < y1 - 1 || q.y > y2 + 4) continue
      if (isC(q.x, q.y, q.z)) continue
      const stands = standsOf(q).filter(p => !isC(p.x, p.y, p.z) && !isC(p.x, p.y + 1, p.z))
      if (stands.length && stands.every(p => r.cells.has(key(p)))) return { side: s, cell: q, size: r.cells.size }
      yield // (a stand search a work cell)
    }
  }
  return null
}

module.exports = { walkModel, deadEnd, region, regionGen, exitReach, doorwayAxis, closesRoom, closesPocket, closesPocketAsync, doorPanel, edgeOf, OPP, CW, CCW }
