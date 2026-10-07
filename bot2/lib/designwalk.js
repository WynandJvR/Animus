'use strict'
// THE FINISHED BUILD'S OWN WALKING SPACE - the walk graph of the build as its blueprint draws it, finished, over the site as it
// was: the stairs, the ladders, the corridors and floors a body walks once it stands. Its stands' feet and head cells are
// the design's walking space, and no block of ours (a stepping stone, a tower, a temporary support, a ring) may stand in
// one: the castle's own staircase and ladder to its upper story were built, and our own cobble capped the ladder's top and
// dirt sat in the hall's corridor to the stairs - the upper floor read "no stand" and every ring plan failed, 2026-10-07.
// PURE over a rooms.js world `w` (rooms.walkModel's own steps): the graph searched from every stand outside the build's
// footprint (the ground round it), yielding through tick() between slices - body first.
//   designGraph(w, box, region, { tick }) -> { parent: Map(key -> parent key | null), stands: number }
//   protectedOf(graph, box, isJob(x,y,z)) -> Set of keys: the feet and head cells of every reached stand inside the footprint
//     that are no cell of the build (a door, a carpet, a ladder in them is the build's own and placed by the builder)
//   routeTo(graph, k) -> [keys] from a source to k
const rooms = require('./rooms')
const world = require('./world')
const key = p => `${p.x},${p.y},${p.z}`
const parse = k => { const [x, y, z] = k.split(',').map(Number); return { x, y, z } }

// THE FINISHED BUILD AS A WORLD (rooms.js's interface): a cell of the build -> its block (cellAt: { name, props } or null);
// open air inside the footprint over the base; the site as it was (snapName) everywhere else, ground under the base
function designWorld (registry, cellAt, box, snapName) {
  const Block = require('prismarine-block')(registry)
  const cache = new Map()
  const blockOf = (name, props) => { const k = name + JSON.stringify(props || {}); let b = cache.get(k); if (!b) { try { b = Block.fromProperties(name, Object.fromEntries(Object.entries(props || {}).map(([a, v]) => [a, String(v)])), 0) } catch { b = Block.fromProperties(name, {}, 0) } cache.set(k, b) } return b }
  const air = blockOf('air', {})
  const at = (x, y, z) => {
    const c = cellAt(x, y, z)
    // (a wooden trapdoor as a body meets it: opened - a hatch over a ladder is a way up to a player, shut it read as a lid and
    //  every floor over one as unreachable)
    // (and a wooden DOOR as the body leaves it: open - its panel swung to the side its hinge gives, the passage straight through
    //  it. Read shut, the design walked into the castle's double door at -2275,120,-579/-580 from the west and turned inside it
    //  for the stairs north and south - a turn the open panels shut: 62 of 68 design routes "open" by the cell-by-cell follow
    //  were refused by the live walk there, 2026-10-07 19:50)
    if (c) return blockOf(c.name, /_trapdoor$|_door$/.test(c.name) && !/^iron_/.test(c.name) ? Object.assign({}, c.props, { open: 'true' }) : c.props)
    if (x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2 && y >= box.y1) return air
    const n = snapName(x, y, z)
    return n ? blockOf(n, {}) : (y < box.y1 ? blockOf('stone', {}) : air)
  }
  const fake = { blockAt: v => at(v.x, v.y, v.z), registry }
  return { floorTop: (x, y, z) => y + world.floorTop(at(x, y, z)), at, isAirish: world.isAirish, bodyPassable: world.bodyPassable, isOpenTrapdoor: world.isOpenTrapdoor, isSolid: world.isSolid, standable: (x, y, z) => world.standable(fake, x, y, z), plateEdge: world.plateEdge, SAFE_DROP: world.SAFE_DROP }
}
async function designGraph (w, box, region, { tick = async () => {}, cap = 200000 } = {}) {
  const W = rooms.walkModel(w, () => false, { opens: true })
  const inFoot = p => p.x >= box.x1 && p.x <= box.x2 && p.z >= box.z1 && p.z <= box.z2
  const inRegion = p => p.x >= region.x1 && p.x <= region.x2 && p.z >= region.z1 && p.z <= region.z2 && p.y >= region.y1 && p.y <= region.y2
  // sources: every stand on the ground round the footprint (inside the region, outside the box)
  const parent = new Map(); const q = []
  for (let x = region.x1; x <= region.x2; x++) {
    for (let z = region.z1; z <= region.z2; z++) {
      if (inFoot({ x, z })) continue
      for (let y = region.y1 + 1; y <= Math.min(region.y2, box.y1 + 3); y++) if (W.st(x, y, z)) { const s = { x, y, z }; if (!parent.has(key(s))) { parent.set(key(s), null); q.push(s) } }
    }
    await tick()
  }
  for (let i = 0; i < q.length && parent.size < cap; i++) {
    const c = q[i]
    for (const n of W.next(c)) { if (!inRegion(n)) continue; const k = key(n); if (!parent.has(k)) { parent.set(k, key(c)); q.push(n) } }
    if (i % 32 === 0) await tick()
  }
  return { parent, stands: parent.size }
}
function protectedOf (graph, box, isJob) {
  const out = new Set()
  for (const k of graph.parent.keys()) {
    const s = parse(k)
    if (s.x < box.x1 || s.x > box.x2 || s.z < box.z1 || s.z > box.z2) continue
    for (const dy of [0, 1]) { const c = { x: s.x, y: s.y + dy, z: s.z }; if (!isJob(c.x, c.y, c.z)) out.add(key(c)) }
  }
  return out
}
function routeTo (graph, k) {
  const out = []; let cur = k; let guard = 0
  while (cur != null && guard++ < 100000) { out.push(cur); cur = graph.parent.get(cur) }
  return out.reverse()
}
// WHAT BLOCKS THE BUILD'S OWN WAY TO d, AS THE WORLD STANDS: its route in the design graph, from the last of its stands the
// walk already reaches (reachHas), every stand after it: a floor under it (solid, or a ladder - or the stand itself in a
// ladder), and its feet and head cells open or OUR strays in the walking space (isOurs: the snapshot diff, at(x,y,z): the
// live world). -> { strays: [{x,y,z}], blocked: reason | null }. Only a route blocked by nothing but our strays is ours to open
// (A ROUTE STAND IS MET ONE UP OR DOWN: the design stands on its own finished floor - a carpet, a slab - and the walk on the
//  floor as it is now, a block lower or higher in the same column. Matched on its own height only, no stand of any route was
//  ever "in my walk": every walk-back began at the route's far start, on the site's old ground outside, and every route was
//  declined there - "grass_block at -2299,118,-585 - not ours", 32 times, the ladder cap left standing, 2026-10-07 18:04-18:14)
const near = (has, k) => { const s = parse(k); return [0, -1, 1].some(dy => has(`${s.x},${s.y + dy},${s.z}`)) }
// THE DESIGN'S ROUTE TO d FROM WHERE THE WALK ALREADY GOES: a search in the finished build's own steps (w, its world) from
// every design stand the walk reaches (reachHas, met one up or down) to d - the shortest way in from the body's side, never
// the graph's one route from the ground outside (whose far start the site's levelling had moved). -> [keys] or null
async function routeFrom (w, graph, reachHas, d, { tick = async () => {}, cap = 20000 } = {}) {
  const W = rooms.walkModel(w, () => false, { opens: true })
  const dk = typeof d === 'string' ? d : key(d)
  const prev = new Map(); const q = []
  for (const k of graph.parent.keys()) if (near(reachHas, k)) { prev.set(k, null); q.push(parse(k)) }
  if (prev.has(dk)) return [dk]
  for (let i = 0; i < q.length && prev.size < cap; i++) {
    for (const n of W.next(q[i])) { const k = key(n); if (prev.has(k)) continue; prev.set(k, key(q[i])); if (k === dk) { const out = []; let cur = k; while (cur != null) { out.push(cur); cur = prev.get(cur) } return out.reverse() } q.push(n) }
    if (i % 32 === 0) await tick()
  }
  return null
}
// THE DESIGN'S ROUTES TO MANY STANDS AT ONCE - routeFrom's one search for a set of targets: from every design stand the walk
//  reaches (met one up or down) through the finished build's own steps; -> Map(target key -> [keys from the walk's side to it])
//  for each target found. (access-first placement: the cells that make these routes are the floor's way up)
async function routesFrom (w, graph, reachHas, targets, { tick = async () => {}, cap = 20000 } = {}) {
  const W = rooms.walkModel(w, () => false, { opens: true })
  const want = new Set(targets); const prev = new Map(); const q = []
  for (const k of graph.parent.keys()) if (near(reachHas, k)) { prev.set(k, null); q.push(parse(k)) }
  let left = 0; for (const k of want) if (!prev.has(k)) left++
  for (let i = 0; i < q.length && prev.size < cap && left > 0; i++) {
    for (const n of W.next(q[i])) { const k = key(n); if (prev.has(k)) continue; prev.set(k, key(q[i])); if (want.has(k)) left--; q.push(n) }
    if (i % 8 === 0) await tick()
  }
  const out = new Map()
  for (const t of want) {
    if (!prev.has(t)) continue
    const r = []; let cur = t; let guard = 0
    while (cur != null && guard++ < 100000) { r.push(cur); cur = prev.get(cur) }
    out.set(t, r.reverse())
  }
  return out
}
// ACCESS FIRST - the cells of the build that make the finished build's own way to where the work is: for each cell still to place
//  (cells) with no stand of the walk (reachHas) in an eye's reach - NEEDY - the design's stands that would reach it, the routes
//  the design walks to them from the walk's side (routesFrom), and on each route past the walk the cells of the build that
//  make its stands: the floor under a stand (a stair, a floor block, a slab) and a ladder or thin floor in its feet, still to
//  place (isTodo). The castle's upper story: its stairs and ladder built, its floors not, and 3 of 16 upper groups reached -
//  every upper cell "no stand", a ring plan a cell, 2026-10-07. Built first, the floor's way up comes before its walls.
//  -> { cells: Map(key -> needy cells served), needy, targets, routed }. PURE; eyeReaches(stand, cell) by cell centres
// (ONLY A CELL WHOSE ABSENCE BREAKS THE STAND, as the world stands (at): a floor cell with nothing solid in it now, a ladder not
//  hung yet. A floor cell still to place but full of the old ground - coarse dirt over the site's grass - already bears the
//  stand: "coarse_dirt@-2282,119,-593 for 188" topped the list with grass_block standing there, 2026-10-07 19:36. And what
//  else keeps the routes' stands out of the walk, counted by reason (routeBlockers': the walk's stand a step at a time) - why)
async function accessPlan (w, graph, { reachHas, cells, isTodo, eyeReaches, at = null, isOurs = () => false, isProtected = () => false, tick = async () => {}, maxNeedy = 400 }) {
  const has = k => near(reachHas, k)
  const ctr = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })
  const needy = []; const serves = new Map() // target stand -> [needy keys]
  let n = 0
  for (const c of cells) {
    if (++n % 8 === 0) await tick()
    let reached = false; const ds = []
    for (let dx = -4; dx <= 4 && !reached; dx++) for (let dz = -4; dz <= 4 && !reached; dz++) for (let dy = -5; dy <= 1; dy++) {
      const st = { x: c.x + dx, y: c.y + dy, z: c.z + dz }; const k = key(st)
      if (!eyeReaches(ctr(st), ctr(c))) continue
      if (reachHas(k)) { reached = true; break }
      if (graph.parent.has(k) && !has(k)) ds.push(k)
    }
    if (reached || !ds.length) continue
    needy.push(c); for (const k of ds) { const l = serves.get(k); if (l) l.push(key(c)); else serves.set(k, [key(c)]) }
    if (needy.length >= maxNeedy) break
  }
  const routes = serves.size ? await routesFrom(w, graph, reachHas, [...serves.keys()], { tick }) : new Map()
  const out = new Map() // job cell key -> Set of needy keys
  for (const [t, r] of routes) {
    await tick()
    let from = -1; for (let i = r.length - 1; i >= 0; i--) if (has(r[i])) { from = i; break }
    for (const k of r.slice(from + 1)) {
      const s0 = parse(k)
      for (const dy of [-1, 0]) {
        const q = { x: s0.x, y: s0.y + dy, z: s0.z }
        if (!isTodo(q.x, q.y, q.z)) continue
        if (at) {
          const lb = at(q.x, q.y, q.z); const db = w.at(q.x, q.y, q.z)
          if (dy === -1 && lb && world.isSolid(lb) && !world.isOpenTrapdoor(lb)) continue // (a floor there already)
          if (dy === 0 && !(db && /^(ladder|vine)$/.test(db.name) && !(lb && lb.name === db.name))) continue // (its feet: only a ladder not hung)
        }
        const kk = key(q); let set = out.get(kk); if (!set) out.set(kk, (set = new Set()))
        for (const nk of serves.get(t)) set.add(nk)
      }
    }
  }
  // (what keeps each routed stand out of the walk: its route followed from the walk's side, the first stand the world does not
  //  give - routeBlockers' reason, the numbers taken out; one example cell each)
  const why = {}
  if (at) {
    let m = 0
    for (const [t, r] of routes) {
      await tick() // (a route at a time: routeBlockers walks the whole route)
      const rb = routeBlockers(graph, t, { route: r, reachHas, at, isOurs, isProtected })
      const reason = rb.blocked ? rb.blocked.replace(/-?\d+,-?\d+,-?\d+/g, 'X') : rb.strays.length ? 'only our strays' : 'open (a walk the live search does not take)'
      const e = why[reason] || (why[reason] = { n: 0, eg: rb.blocked ? (rb.blocked.match(/-?\d+,-?\d+,-?\d+/) || [t])[0] : t }); e.n++
    }
  }
  return { cells: new Map([...out].map(([k, v]) => [k, v.size])), needy: needy.length, targets: serves.size, routed: routes.size, why }
}
function routeBlockers (graph, d, { reachHas, at, isOurs, isProtected, route: given = null }) {
  const route = given || routeTo(graph, typeof d === 'string' ? d : key(d))
  let from = -1; for (let i = route.length - 1; i >= 0; i--) if (near(reachHas, route[i])) { from = i; break }
  if (from < 0) return { strays: [], blocked: 'no stand of its route in my walk' }
  const open = b => !!b && (world.bodyPassable(b) || world.isOpenTrapdoor(b) || /_door$|_fence_gate$|_carpet$|^ladder$|_trapdoor$/.test(b.name))
  const ladder = b => !!b && /^ladder$/.test(b.name)
  // (a floor: solid, or a ladder - the stand itself in a ladder)
  // (and leaves: a floor the walk stands on - "no floor yet under -2290,120,-588" over the yard's oak leaves; a box of its own)
  const floorAt = (x, y, z) => { const fl = at(x, y - 1, z); return ladder(at(x, y, z)) || (!!fl && (world.isSolid(fl) || ladder(fl) || (fl.boundingBox === 'block' && world.LEAF_RE.test(fl.name)))) }
  // THE BODY'S STAND IN EACH COLUMN OF THE ROUTE, AS THE WORLD STANDS: the design's own height, one lower (its own thin floor -
  //  a carpet - not laid yet), or one higher (the old ground raised under it since the snapshot: the site's levelling, a block
  //  of ours or not - walked over, never in the way), a step from the last one. At the design's height only, the castle's
  //  west yard (the snapshot's dips at y118, the ground in them since) declined every route there: "grass_block at
  //  -2299,118,-585 - not ours", 2026-10-07 18:25. Feet and head open, or open but for OUR strays in the walking space
  //  (taken out); a stand needing none first. (One lower only where the design's floor cell is still air, one higher only over
  //  a block in the design's feet cell: a ladder's stands shifted a rung down and the cap's cobblestone over it was never
  //  selected - castlewalktest)
  // (the walk's own stand where it meets the route - one up or down of the design's: from there, that column itself too - the
  //  ladder's rung under the cap met the walk a rung lower, and the cap was past it; castlewalktest)
  const s0 = parse(route[from]); let last = { x: s0.x, y: [0, -1, 1].map(dy => s0.y + dy).find(y => reachHas(`${s0.x},${y},${s0.z}`)), z: s0.z }
  let prevY = last.y
  const strays = []
  for (let i = last.y === s0.y ? from + 1 : from; i < route.length; i++) {
    const s = parse(route[i])
    let pick = null
    const lowOk = world.isAirish(at(s.x, s.y - 1, s.z) || { name: 'stone' }); const highOk = !open(at(s.x, s.y, s.z))
    for (const y of [s.y, s.y - 1, s.y + 1]) {
      if ((y < s.y && !lowOk) || (y > s.y && !highOk)) continue
      if (prevY != null && Math.abs(y - prevY) > 1) continue
      if (!floorAt(s.x, y, s.z)) continue
      const ours = []; let ok = true
      for (const dy of [0, 1]) {
        const q = { x: s.x, y: y + dy, z: s.z }; const b = at(q.x, q.y, q.z)
        if (open(b)) continue
        if (b && isProtected(q) && isOurs(q)) { ours.push(q); continue }
        ok = false; break
      }
      if (!ok) continue
      if (!ours.length) { pick = { y, ours }; break }
      if (!pick) pick = { y, ours }
    }
    if (!pick) {
      // (said at the design's own height: what stands where the finished build walks)
      if (!floorAt(s.x, s.y, s.z)) return { strays, blocked: `no floor yet under ${route[i]}` }
      for (const dy of [0, 1]) { const q = { x: s.x, y: s.y + dy, z: s.z }; const b = at(q.x, q.y, q.z); if (!open(b) && !(b && isProtected(q) && isOurs(q))) return { strays, blocked: `${b ? b.name : '?'} at ${key(q)} - not ours` } }
      return { strays, blocked: `no step to ${route[i]} from ${s.x},${prevY},${s.z}` }
    }
    // (each stray with the stand it is dug from: the route's stand before it, as the body will stand there - THE clear's own
    //  stand, the body on the ladder under the cap; a GoalNear 3 of the cap left it at -2289,126,-577 and the cobblestone
    //  over the cap was never reached, 2026-10-07 18:29)
    const stand = last
    for (const q of pick.ours) if (!strays.some(o => key(o) === key(q))) strays.push(Object.assign(q, { stand }))
    prevY = pick.y; last = { x: s.x, y: pick.y, z: s.z }
  }
  return { strays, blocked: null }
}
// (the design's rules' version: in the cache's hash - a change here recomputes the walk)
const DESIGN_RULES = 'doors-open-1'
module.exports = { DESIGN_RULES, designWorld, designGraph, protectedOf, routeTo, routeFrom, routesFrom, accessPlan, routeBlockers, parse, key }
