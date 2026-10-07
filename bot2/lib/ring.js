'use strict'
// THE SCAFFOLD RING - a walkway of our own filler along the inside of a wall, two under a layer whose cells have no stand
// the walk reaches and no pillar foot: every column beside a wall cell high up is the wall itself or the room's other build
// cells ("a build cell at the cell's height" led every stand plan at the castle's y129 band; 1 placed in 15 minutes,
// 2026-10-07 16:34). A player builds a ledge to stand on; so does the builder: the ring's top is a stand for the layer and
// the two over it, walked to like any floor, and taken down with the site's scaffold once the cells it serves are done.
// PURE: the plan only, over a small world interface - the live bot (build.js) and the tests read the same rules.
//   w = { at(x,y,z), isAirish(b), isSolid(b), jobHas(x,y,z), airDown(x,y,z) -> the air cells from (x,y,z) down to the first
//         solid (null: none within reach, or lava), hot(x,y,z), SAFE_DROP }
//   cells: the cells needing a stand (all at layers y0..y0+2), each { x, y, z }
//   opts: { stand(x,y,z) -> a stand the walk reaches (feet cell), refused(r) -> a reason the room rules give against a block
//           at r (closes a room, a doorway, a pocket, the last stand of a cell) - the dear question: asked only of the blocks
//           the walkway really takes, as it grows, never of every candidate; tick() -> a promise: the caller's slice (the
//           event loop back between dear questions - body first), maxBlocks }
// Returns (a promise of) null or { y, blocks: [{x,y,z}] in laying order, access: { kind: 'stand', from } | { kind: 'tower',
//   from, tower: [..] }, serves: [cells] }
const key = p => `${p.x},${p.y},${p.z}`
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// A ring block's own CHEAP rules: free now and none of the build's; its top a stand (two free cells over it, none the
// build's); no fire beside it. (Its edges - a step off them hurts no more than SAFE_DROP - once the other candidates are
// known: edgeOk; the room rules last, only for the blocks the walkway takes: refused)
function blockOk (w, r) {
  const b = w.at(r.x, r.y, r.z); if (!b || !w.isAirish(b) || w.jobHas(r.x, r.y, r.z)) return false
  for (const dy of [1, 2]) { const u = w.at(r.x, r.y + dy, r.z); if (!u || !w.isAirish(u) || w.jobHas(r.x, r.y + dy, r.z)) return false }
  if (w.hot(r.x, r.y + 1, r.z) || SIDES.some(([dx, dz]) => w.hot(r.x + dx, r.y + 1, r.z + dz))) return false
  return true
}
// THE EDGE RULE, one copy for the plan and the laying: off each open side of a top at y+1 - not a wall at the feet, not a
// block in `cover` (keys "x,y,z" of the walkway's tops at y) - the fall is SAFE_DROP at most
function edgeOkFor (w, r, y, cover) {
  return SIDES.every(([dx, dz]) => {
    const n = { x: r.x + dx, z: r.z + dz }
    if (cover.has(`${n.x},${y},${n.z}`)) return true
    const t = w.at(n.x, y + 1, n.z); if (t && !w.isAirish(t)) return true // (a wall at the feet: no edge there)
    const a = w.airDown(n.x, y + 1, n.z); return a != null && a - 1 <= w.SAFE_DROP
  })
}
// THE CLOSURE: blocks whose edges hold with only these blocks round them - dropped one at a time until none fails (a
// dropped block opens its neighbours' sides); the set kept
function edgeClosure (w, blocks, y, extra = []) {
  let keep = blocks.slice()
  for (let changed = true; changed;) {
    changed = false
    const cover = new Set(keep.concat(extra).map(key))
    const bad = keep.find(b => !edgeOkFor(w, b, y, cover))
    if (bad) { keep = keep.filter(b => b !== bad); changed = true }
  }
  return keep
}
// A WALKWAY AS LAID HOLDS: every laid block's edges with only the laid blocks (and the tower's top) round it, and the
// tower's top's own edges too - a top with two walkway neighbours, one of them never laid, faces that side's drop; audit
function walkwayHolds (w, laid, y, towerTop = []) {
  if (edgeClosure(w, laid, y, towerTop).length !== laid.length) return false
  return !towerTop.length || edgeOkFor(w, towerTop[0], y, new Set(laid.map(key)))
}
// something solid at the block's own height to place it against - a wall block, or a ring block laid before it
function clickable (w, r, laid) { return SIDES.some(([dx, dz]) => { const q = { x: r.x + dx, y: r.y, z: r.z + dz }; if (laid.has(key(q))) return true; const b = w.at(q.x, q.y, q.z); return !!b && w.isSolid(b) }) || (() => { const u = w.at(r.x, r.y - 1, r.z); return !!u && w.isSolid(u) })() }

// the eye on a top at feet y (a whole block's top under it) within a player's reach of the cell's middle
const REACH = 4.2
function eyeReaches (stand, c) { const ey = stand.y + 1.62; return (c.x - stand.x) ** 2 + (c.y + 0.5 - ey) ** 2 + (c.z - stand.z) ** 2 <= REACH * REACH }

// THE RING, AT THE HEIGHT WHERE ITS EDGES HOLD: two under the layer first (the layer and the two over it in reach); where a
// tall room's floor lies more than SAFE_DROP under that top - every candidate's open side a hurting drop - one lower, then
// two (the reach taller, the cells served those its eye still reaches). The castle's upper rooms: "40 cells without a stand,
// none" every time at y130, 2026-10-07 17:16. opts.stats (an array) gets one line of counts a height tried
async function planRing (w, cells, opts = {}) {
  if (!cells.length) return null
  const y0 = Math.min(...cells.map(c => c.y))
  for (const y of [y0 - 2, y0 - 3, y0 - 4]) {
    const st = { y }
    const plan = await planRingAt(w, cells, opts, y, st)
    if (opts.stats) opts.stats.push(st)
    if (plan && plan.serves.length) return plan
  }
  return null
}
async function planRingAt (w, cells, opts, y, st) {
  const maxBlocks = opts.maxBlocks || 40
  const tick = opts.tick || (async () => {})
  let refusals = 0
  const refused = async r => { if (!opts.refused) return false; const v = await opts.refused(r); await tick(); if (v) refusals++; return !!v }
  // candidates: the columns beside each cell's column, at the ring's height - the cheap rules only
  const cand = new Map(); const tried = new Set()
  for (const c of cells) for (const [dx, dz] of SIDES) {
    const r = { x: c.x + dx, y, z: c.z + dz }
    tried.add(key(r))
    if (cand.has(key(r))) { cand.get(key(r)).serves.push(c); continue }
    if (!blockOk(w, r)) continue
    cand.set(key(r), Object.assign(r, { serves: [c] }))
  }
  st.columns = tried.size; st.free = cand.size
  // EDGES: off each open side of the top - not the wall, not another block of the walkway - the fall is SAFE_DROP at most
  // (the feet at y+1 land on the first solid under that column), so a step off the ring hurts nothing and the edge reflex
  // has no lip to hold
  const edgeOk = r => edgeOkFor(w, r, y, new Set(cand.keys()))
  for (let changed = true; changed;) { changed = false; for (const [k, r] of [...cand]) if (!edgeOk(r)) { cand.delete(k); changed = true } } // (a dropped block opens its neighbours' edges: until none changes)
  st.edges = cand.size
  if (!cand.size) return null
  // ACCESS: a candidate the walk reaches the top of - a stand beside it at the top's level (y+1), one under (y: a step up
  // of one) or one over (y+2: a step down of one) - the walk model's own steps; the room rules asked of that block only
  const nbr = r => SIDES.map(([dx, dz]) => ({ x: r.x + dx, z: r.z + dz }))
  let access = null; let start = null
  const firstStand = r => { for (const n of nbr(r)) for (const dy of [1, 0, 2]) if (opts.stand && opts.stand(n.x, y + dy, n.z)) return { x: n.x, y: y + dy, z: n.z }; return null }
  for (const r of cand.values()) {
    const from = firstStand(r); if (!from) continue
    if (await refused(r)) continue
    access = { kind: 'stand', from }; start = r; break
  }
  if (!access && opts.stand) {
    // the tower: a stand on the floor beside a candidate, its column free up to the top's head room, none of it the build's
    for (const r of cand.values()) {
      for (const n of nbr(r)) {
        let fy = null
        for (let yy = y; yy >= y - 6; yy--) if (opts.stand(n.x, yy, n.z)) { fy = yy; break }
        if (fy == null || fy > y) continue
        let free = true
        for (let yy = fy; yy <= y + 2 && free; yy++) { const b = w.at(n.x, yy, n.z); if (!b || !w.isAirish(b) || w.jobHas(n.x, yy, n.z)) free = false }
        if (!free) continue
        const tower = []; for (let yy = fy; yy <= y; yy++) tower.push({ x: n.x, y: yy, z: n.z })
        let bad = false; for (const t of tower.concat([r])) if (await refused(t)) { bad = true; break }
        if (bad) continue
        access = { kind: 'tower', from: { x: n.x, y: fy, z: n.z }, tower }; start = r; break
      }
      if (access) break
    }
  }
  st.access = access ? access.kind : 'none'; st.refused = refusals
  if (!access) return null
  // THE WALKWAY: from the access, along candidates that touch (a walk from top to top), each clickable when its turn comes
  // and passing the room rules then (start passed them already)
  const laid = new Set(access.kind === 'tower' ? access.tower.map(key) : [])
  const blocks = []; const seen = new Set([key(start)]); const q = [start]
  while (q.length && blocks.length < maxBlocks) {
    const r = q.shift()
    if (!clickable(w, r, laid)) continue
    if (r !== start && await refused(r)) continue
    blocks.push({ x: r.x, y: r.y, z: r.z }); laid.add(key(r))
    for (const n of nbr(r)) { const k = `${n.x},${y},${n.z}`; if (!seen.has(k) && cand.has(k)) { seen.add(k); q.push(cand.get(k)) } }
  }
  // (the edges once more, on the walkway really taken: the candidates counted as cover above may be refused, unclickable,
  //  past maxBlocks or unconnected - a laid block with an open side over a deep drop would be a walked floor with a lip.
  //  The tower's top is cover too; a walkway that loses its first block has lost its way up: no plan; audit)
  const towerTop = access.kind === 'tower' ? [access.tower[access.tower.length - 1]] : []
  const kept = new Set(edgeClosure(w, blocks, y, towerTop).map(key))
  st.walkway = kept.size
  if (!kept.has(key(start))) return null
  const order = []; { const seen2 = new Set([key(start)]); const q2 = [start]; while (q2.length) { const r = q2.shift(); order.push({ x: r.x, y: r.y, z: r.z }); for (const n of nbr(r)) { const k = `${n.x},${y},${n.z}`; if (!seen2.has(k) && kept.has(k)) { seen2.add(k); q2.push({ x: n.x, y, z: n.z }) } } } }
  blocks.length = 0; blocks.push(...order)
  // (the tower's own top over its floor: its sides with the walkway round it)
  if (towerTop.length && !edgeOkFor(w, towerTop[0], y, new Set(blocks.map(key)))) return null
  // (served: the cells an eye on one of the tops reaches - all of them two under the layer, fewer from lower)
  const serves = cells.filter(c => blocks.some(b => eyeReaches({ x: b.x + 0.5, y: y + 1, z: b.z + 0.5 }, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 })))
  st.serves = serves.length; st.refused = refusals
  return { y, blocks, access, serves }
}

module.exports = { planRing, blockOk, edgeOkFor, edgeClosure, walkwayHolds, eyeReaches }
