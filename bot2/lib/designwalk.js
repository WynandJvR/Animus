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
    if (c) return blockOf(c.name, /_trapdoor$/.test(c.name) && !/^iron_/.test(c.name) ? Object.assign({}, c.props, { open: 'true' }) : c.props)
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
function routeBlockers (graph, d, { reachHas, at, isOurs, isProtected, route: given = null }) {
  const route = given || routeTo(graph, typeof d === 'string' ? d : key(d))
  let from = -1; for (let i = route.length - 1; i >= 0; i--) if (near(reachHas, route[i])) { from = i; break }
  if (from < 0) return { strays: [], blocked: 'no stand of its route in my walk' }
  const open = b => !!b && (world.bodyPassable(b) || world.isOpenTrapdoor(b) || /_door$|_fence_gate$|_carpet$|^ladder$|_trapdoor$/.test(b.name))
  const strays = []
  for (const k of route.slice(from + 1)) {
    const s = parse(k)
    const fl = at(s.x, s.y - 1, s.z); const ft = at(s.x, s.y, s.z)
    // (a floor: solid, or a ladder - the stand itself in a ladder; or, its own thin floor not laid yet (a carpet's cell open),
    //  the block under that: the body stands one lower, as the walk would)
    const fl2 = at(s.x, s.y - 2, s.z)
    const floorOk = (ft && /^ladder$/.test(ft.name)) || (fl && (world.isSolid(fl) || /^ladder$/.test(fl.name))) || (fl && world.isAirish(fl) && fl2 && world.isSolid(fl2))
    if (!floorOk) return { strays, blocked: `no floor yet under ${k}` }
    for (const dy of [0, 1]) {
      const q = { x: s.x, y: s.y + dy, z: s.z }; const b = at(q.x, q.y, q.z)
      if (open(b)) continue
      if (b && isProtected(q) && isOurs(q)) { if (!strays.some(o => key(o) === key(q))) strays.push(q); continue }
      return { strays, blocked: `${b ? b.name : '?'} at ${key(q)} - not ours` }
    }
  }
  return { strays, blocked: null }
}
module.exports = { designWorld, designGraph, protectedOf, routeTo, routeFrom, routeBlockers, parse, key }
