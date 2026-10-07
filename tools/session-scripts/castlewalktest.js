'use strict'
// castlewalktest.js - the walk model (rooms.walkModel over world.standable/floorTop/plateEdge - what walkReach and the
// stands read) against THE PLANNER that walks the legs (mineflayer-pathfinder's Movements, dig and place off), on a real
// castle site dumped block by block (castlewalk.fixture.json: every non-air block, relative to the dump's corner).
// Every walk-model step should be a step the planner can take: a step the model allows and the planner refuses is a leg
// that times out, a stand that is never reached, a region read open that the body cannot leave. Counted by geometry class.
// And where each search STARTS (the planner's start node for a body on each stand's floor = the stand = world.standCell),
// and the DEAD ENDS (stands the walk enters and the planner cannot leave) the model must read as dead ends too.
// Run from anywhere: node tools/session-scripts/castlewalktest.js [--list N]
const path = require('path')
const bot2 = path.join(__dirname, '..', '..', 'bot2')
const fromBot2 = m => require(require.resolve(m, { paths: [bot2] }))
const { Vec3 } = fromBot2('vec3')
const registry = fromBot2('prismarine-registry')('26.2')
const Block = fromBot2('prismarine-block')(registry)
const Movements = fromBot2('mineflayer-pathfinder').Movements
const world = require(path.join(bot2, 'lib', 'world'))
const rooms = require(path.join(bot2, 'lib', 'rooms'))
const fx = require(path.join(__dirname, 'castlewalk.fixture.json'))
const listN = (() => { const i = process.argv.indexOf('--list'); return i > 0 ? Number(process.argv[i + 1]) : 0 })()

// ---- the world: every dumped block a real prismarine Block (shapes, boundingBox), air elsewhere inside, nothing outside
const air = Block.fromProperties('air', {}, 0)
const cells = new Map()
for (const [k, v] of Object.entries(fx.blocks)) {
  const m = v.match(/^([a-z0-9_]+)(\{.*\})?$/); if (!m || !registry.blocksByName[m[1]]) continue
  const props = m[2] ? Object.fromEntries(Object.entries(JSON.parse(m[2])).map(([a, b]) => [a, String(b)])) : {}
  let b; try { b = Block.fromProperties(m[1], props, 0) } catch { continue }
  cells.set(k, b)
}
const S = fx.size
const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < S.x && y < S.y && z < S.z
const blockAt = p => { const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z); if (!inside(x, y, z)) return null; const b = cells.get(`${x},${y},${z}`) || air; b.position = new Vec3(x, y, z); return Object.assign(Object.create(Object.getPrototypeOf(b)), b, { position: new Vec3(x, y, z) }) }
const bot = { registry, blockAt, entity: { position: new Vec3(0, 0, 0), effects: [] }, entities: {}, game: { minY: -64, height: 384 }, inventory: { items: () => [] }, pathfinder: { bestHarvestTool: () => null } }

// ---- the walk model, as walkReach builds it (roomWorld)
const at = (x, y, z) => blockAt({ x, y, z })
const rw = { floorTop: (x, y, z) => y + world.floorTop(at(x, y, z)), at, isAirish: world.isAirish, bodyPassable: world.bodyPassable, isOpenTrapdoor: world.isOpenTrapdoor, isSolid: world.isSolid, standable: (x, y, z) => world.standable(bot, x, y, z), plateEdge: world.plateEdge, SAFE_DROP: world.SAFE_DROP }
const W = rooms.walkModel(rw, () => false, { opens: true })

// ---- the planner, as the legs' movementsFor sets it: no dig, no place, doors walked, open trapdoors passable, panel edges,
//      fence gates opened on the way (canOpenDoors - movementsFor's; the library default is off)
const mv = new Movements(bot)
mv.canDig = false; mv.canOpenDoors = true; mv.allow1by1towers = false; mv.scafoldingBlocks = []; mv.allowParkour = false; mv.allowSprinting = false; mv.maxDropDown = world.SAFE_DROP
for (const n of ['magma_block', 'powder_snow', 'sweet_berry_bush', 'cactus', 'campfire', 'soul_campfire', 'wither_rose', 'pointed_dripstone', 'fire', 'soul_fire']) { const b = registry.blocksByName[n]; if (b) mv.blocksToAvoid.add(b.id) }
const doorIds = new Set(registry.blocksArray.filter(b => /_door$/.test(b.name) && !/iron_door/.test(b.name)).map(b => b.id))
const gb0 = mv.getBlock.bind(mv)
mv.getBlock = (pos, dx, dy, dz) => {
  const b = gb0(pos, dx, dy, dz)
  if (b && (doorIds.has(b.type) || (b.physical && world.isOpenTrapdoor(b)))) { b.safe = true; b.physical = false; b.replaceable = false; b.height = pos.y + dy }
  return b
}
const edgeShut = (x, z, dx, dz, y0, y1) => { for (let y = y0; y <= y1; y++) { const a = world.plateEdge(at(x, y, z)); if (a && a[0] === dx && a[1] === dz) return true; const c = world.plateEdge(at(x + dx, y, z + dz)); if (c && c[0] === -dx && c[1] === -dz) return true } return false }
const plannerNext = p => mv.getNeighbors({ x: p.x, y: p.y, z: p.z, remainingBlocks: 0 }).filter(m => m.cost <= 100 && !(m.toBreak && m.toBreak.length) && !(m.toPlace && m.toPlace.length)).filter(m => { const sx = Math.sign(m.x - p.x); const sz = Math.sign(m.z - p.z); if (!sx && !sz) return true; const y0 = Math.min(p.y, m.y); const y1 = Math.max(p.y, m.y) + 1; if (sx && sz) return false; return !edgeShut(p.x, p.z, sx, sz, y0, y1) })

// ---- every model step, checked against the planner from the same cell
const key = p => `${p.x},${p.y},${p.z}`
function classOf (p, n) {
  const fl = at(n.x, n.y - 1, n.z); const ft = at(n.x, n.y, n.z); const pf = at(p.x, p.y - 1, p.z)
  const tags = []
  const nm = b => (b && b.name) || ''
  if (/_fence$|_wall$|_fence_gate$/.test(nm(fl))) tags.push('high floor (fence/wall/gate)')
  if (/_carpet$/.test(nm(ft)) || /_carpet$/.test(nm(fl))) tags.push('carpet')
  if (/_slab$|_stairs$/.test(nm(fl)) || /_slab$|_stairs$/.test(nm(pf))) tags.push('slab/stair floor')
  if (world.plateEdge(ft) || world.plateEdge(at(n.x, n.y + 1, n.z)) || world.plateEdge(at(p.x, p.y, p.z))) tags.push('plate')
  if (/_door$/.test(nm(ft))) tags.push('door')
  if (/ladder/.test(nm(ft)) || /ladder/.test(nm(at(p.x, p.y, p.z))) || /ladder/.test(nm(fl))) tags.push('ladder')
  if (n.y > p.y) tags.push('step up'); if (n.y < p.y) tags.push('drop')
  return tags.length ? tags.join(' + ') : 'plain'
}
let modelEdges = 0; let mismatched = 0; const byClass = {}; const examples = []
const stands = []
for (let x = 0; x < S.x; x++) for (let y = 1; y < S.y - 2; y++) for (let z = 0; z < S.z; z++) if (W.st(x, y, z)) stands.push({ x, y, z })
for (const p of stands) {
  const pn = new Set(plannerNext(p).map(key))
  for (const n of W.next(p)) {
    modelEdges++
    if (pn.has(key(n))) continue
    // (a ladder climb is the planner's getMoveUp/getMoveDown - counted, not judged: the model's ladder rule is its own)
    mismatched++
    const c = classOf(p, n); byClass[c] = (byClass[c] || 0) + 1
    if (examples.length < listN) examples.push(`${key(p)} -> ${key(n)} [${c}]`)
  }
}
// (the other way, for the record: cardinal steps the planner takes and the model does not - the model may be stricter
//  (the plate rule, its own drop column test); a stricter model loses ways, never strands a leg)
let missing = 0; const missBy = {}
for (const p of stands) {
  const wn = new Set(W.next(p).map(key))
  for (const m of plannerNext(p)) { if (m.x !== p.x && m.z !== p.z) continue; if (m.x === p.x && m.z === p.z) continue; if (wn.has(key(m))) continue; missing++; const c = classOf(p, m); missBy[c] = (missBy[c] || 0) + 1 }
}
console.log(`${stands.length} stands, ${modelEdges} walk-model steps, ${mismatched} the planner refuses; ${missing} planner steps the model leaves out (${Object.entries(missBy).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => n + ' ' + c).join(', ')})`)
for (const [c, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${c}`)
for (const e of examples) console.log('   ' + e)
// THE START: where the planner starts a body standing on each stand's floor (index.js getPathFromTo: the floored feet, a cell
// up when the feet are inside a non-empty block - a lantern, a slab, a carpet) must be that stand, and world.standCell (every
// walk-model search's start) must say the same. Read from the floored feet, the searches started a cell under the planner on
// every low floor: the way out "found" at the lantern's own level while the body, its head two over it, had none - 20 minutes
// on a lantern in a 1x1 shaft, 2026-10-07. (the low-floor stands counted: the class a floored start reads wrong)
let startWrong = 0; let lowFloor = 0; const startEx = []
bot.entity.onGround = true
for (const p of stands) {
  const t = world.floorTop(at(p.x, p.y - 1, p.z)); const pos = new Vec3(p.x + 0.5, p.y - 1 + t, p.z + 0.5)
  bot.entity.position = pos
  const f = pos.floored(); const b = blockAt(f); const plannerStart = { x: f.x, y: f.y + ((b && pos.y - f.y > 0.001 && bot.entity.onGround && !mv.emptyBlocks.has(b.type)) ? 1 : 0), z: f.z }
  const sc = world.standCell(bot)
  if (f.y !== p.y) lowFloor++
  if (key(plannerStart) !== key(p) || key(sc) !== key(p)) { startWrong++; if (startEx.length < Math.max(listN, 3)) startEx.push(`${key(p)}: planner starts ${key(plannerStart)}, standCell ${key(sc)}`) }
}
console.log(`${lowFloor} stands on a low floor (feet inside the floor's cell); ${startWrong} where the planner's start or standCell is not the stand`)
for (const e of startEx.slice(0, startWrong ? 3 : 0)) console.log('   ' + e)
// DEAD ENDS: a stand the walk steps into and the planner has no move out of (no dig, no place) - a leg ending there never
// leaves, so walkReach drops it (rooms.deadEnd: no model step AND no planner move). Gated both ways: a dead end the model
// reads as open (a leg's end the body never leaves), and a stand the rule drops that the planner CAN leave (a stand lost for
// nothing). The model's own closed cells the planner leaves - its deliberate strictness, the plate and fire rules - counted
const plannerOut = q => plannerNext(q).filter(m => m.x !== q.x || m.z !== q.z || m.y !== q.y)
const entered = new Set(); for (const p of stands) for (const n of W.next(p)) entered.add(key(n))
let deadEnds = 0; let deadMissed = 0; let dropped = 0; let droppedLeavable = 0; let modelOnly = 0; const modelOnlyBy = {}
for (const p of stands) {
  if (!entered.has(key(p))) continue
  const out = plannerOut(p)
  if (!out.length) { deadEnds++; if (W.next(p).length) deadMissed++ }
  if (rooms.deadEnd(W, p, q => plannerOut(q).length > 0)) { dropped++; if (out.length) droppedLeavable++ }
  if (!W.next(p).length && out.length) { modelOnly++; const c = classOf(p, out[0]); modelOnlyBy[c] = (modelOnlyBy[c] || 0) + 1 }
}
console.log(`${deadEnds} dead ends the walk steps into (no planner move out); ${deadMissed} the walk model reads as open; ${dropped} dropped by rooms.deadEnd, ${droppedLeavable} of them leavable`)
console.log(`${modelOnly} stands the model alone reads as closed, kept (${Object.entries(modelOnlyBy).map(([c, n]) => n + ' ' + c).join(', ')})`)
// WAYPOINTS ON WHAT THE BODY WALKS THROUGH: the pathfinder's postProcessPath stands each node on top of its feet cell's block
// (getPositionOnTopOf, read raw from the world). For an open trapdoor or a door - non-physical to the leg movements - that
// was a waypoint a block over the floor, pulled toward the plate: the body jumped into the plate for it, "stuck x3, next
// node -2265.703125,125,-576.5", 2026-10-07. bot2's patch (patch-mc262.js): a feet block the movements call non-physical
// is no floor - the block under it is. Every model step into such a cell: its waypoint by the patched rule must be the
// stand's real standing point (on the floor under it, as upstream stands any node on its floor); the unpatched misses counted
function onTopOf (block) { // (index.js getPositionOnTopOf, verbatim in effect)
  if (!block || !block.shapes || block.shapes.length === 0) return null
  const q = { x: 0.5, y: 0, z: 0.5 }; let n = 1
  for (const sh of block.shapes) { const h = sh[4]; if (h === q.y) { q.x += (sh[0] + sh[3]) / 2; q.z += (sh[2] + sh[5]) / 2; n++ } else if (h > q.y) { n = 2; q.x = 0.5 + (sh[0] + sh[3]) / 2; q.y = h; q.z = 0.5 + (sh[2] + sh[5]) / 2 } }
  return { x: block.position.x + q.x / n, y: block.position.y + q.y, z: block.position.z + q.z / n }
}
function waypoint (n, patched) {
  const b = blockAt({ x: n.x, y: n.y, z: n.z })
  let np = (patched && b && b.shapes && b.shapes.length && mv.getBlock({ x: n.x, y: n.y, z: n.z }, 0, 0, 0).physical === false) ? null : onTopOf(b)
  if (np === null) np = onTopOf(blockAt({ x: n.x, y: n.y - 1, z: n.z }))
  return np || { x: n.x + 0.5, y: n.y - 1, z: n.z + 0.5 }
}
let wpSteps = 0; let wpOff = 0; let wpOff0 = 0; const wpBy = {}
for (const p of stands) for (const n of W.next(p)) {
  const ft = at(n.x, n.y, n.z)
  if (!ft || !ft.shapes || !ft.shapes.length || /ladder|vine/.test(ft.name)) continue // (a climb's node: its own branch upstream)
  if (mv.getBlock({ x: n.x, y: n.y, z: n.z }, 0, 0, 0).physical !== false) continue
  wpSteps++
  const fp = onTopOf(blockAt({ x: n.x, y: n.y - 1, z: n.z })) // (the real floor's own standing point: a stair floor's is toward its step)
  const want = { x: fp ? fp.x : n.x + 0.5, y: n.y - 1 + world.floorTop(at(n.x, n.y - 1, n.z)), z: fp ? fp.z : n.z + 0.5 }
  const off = w => Math.abs(w.x - want.x) > 0.01 || Math.abs(w.y - want.y) > 0.01 || Math.abs(w.z - want.z) > 0.01
  if (off(waypoint(n, false))) { wpOff0++; const c = ft.name.replace(/^[a-z]+_(?=(trap)?door$)|^dark_oak_|^pale_oak_/, '') + (world.isOpenTrapdoor(ft) ? ' (open)' : ''); wpBy[c] = (wpBy[c] || 0) + 1 }
  if (off(waypoint(n, true))) wpOff++
}
console.log(`${wpSteps} steps into a cell the legs walk through (a door, an open trapdoor): ${wpOff0} waypoints off the floor unpatched (${Object.entries(wpBy).map(([c, k]) => k + ' ' + c).join(', ')}), ${wpOff} with bot2's patch`)
// WEDGE CELLS: a floor, the feet free, and a block with a box in the HEAD cell that does not fill it - a closed gate, a fence,
// a wall, a shut trapdoor, a campfire over the head. A body can stand in such a cell beside the block (0.3 wide, the block a
// plane), and the planner's steps out of it are checked on the cells they go to, never on the one they leave: the first step
// east ran through a gate's plane at head height, "stuck x3" for 3 minutes, 2026-10-07 13:19. The model must never call
// one a stand (the walker seats the body out of one first: move.seatBody); the planner's moves out of them are counted
let wedges = 0; let wedgeStands = 0; let wedgeMoves = 0
for (let x = 0; x < S.x; x++) for (let y = 1; y < S.y - 2; y++) for (let z = 0; z < S.z; z++) {
  const fl = at(x, y - 1, z); const ft = at(x, y, z); const hd = at(x, y + 1, z)
  if (!fl || !world.isSolid(fl) || !ft || !world.bodyPassable(ft) || !hd || hd.boundingBox !== 'block' || world.isOpenTrapdoor(hd) || /_door$|ladder/.test(hd.name)) continue
  const full = (hd.shapes || []).some(q => q[0] <= 0 && q[1] <= 0 && q[2] <= 0 && q[3] >= 1 && q[4] >= 1 && q[5] >= 1)
  if (full) continue
  wedges++; if (W.st(x, y, z)) wedgeStands++
  wedgeMoves += plannerNext({ x, y, z }).filter(m => m.x !== x || m.z !== z).length
}
console.log(`${wedges} wedge cells (a part block at the head over a floor); ${wedgeStands} the model calls a stand; the planner offers ${wedgeMoves} steps out of them through their own block`)
// (the gate: no step the planner refuses, but a ladder's - the climbs are modelled on their own)
// THE SCAFFOLD RING (ring.js) ON THE REAL SITE: upper wall cells no stand the walk reaches has in reach - the next layer over
// a wall top - get a ring planned the way the live builder plans it, laid into this world, and then: every cell it serves has
// a stand the walk reaches within a player's reach, and every walk-model step on and off the ring is a step the planner
// takes (the first gate, over the new stands)
const ringMod = require(path.join(bot2, 'lib', 'ring'))
const reachSet = from => { const seen = new Set([key(from)]); const q = [from]; for (let i = 0; i < q.length && seen.size < 30000; i++) for (const n of W.next(q[i])) if (!seen.has(key(n))) { seen.add(key(n)); q.push(n) } return seen }
const eyeOk = (st, c) => { const t = world.floorTop(at(st.x, st.y - 1, st.z)); const ey = st.y - 1 + t + 1.62; return (c.x - st.x) ** 2 + (c.y + 0.5 - ey) ** 2 + (c.z - st.z) ** 2 <= 4.2 * 4.2 }
const solidKeys = [...cells.keys()].map(k0 => k0.split(',').map(Number)).filter(([x, y, z]) => world.isSolid(at(x, y, z)))
const minStand = stands.reduce((a, b) => (b.y < a.y ? b : a), stands[0])
let reached = reachSet(minStand); for (const st of stands) if (!reached.has(key(st)) && st.y <= minStand.y + 1) { const r2 = reachSet(st); if (r2.size > reached.size) reached = r2 }
const reachedList = [...reached].map(k0 => { const [x, y, z] = k0.split(',').map(Number); return { x, y, z } })
const stood = c => reachedList.some(st => Math.abs(st.x - c.x) <= 4 && Math.abs(st.z - c.z) <= 4 && eyeOk(st, c))
// the next layer over each wall top high up (y >= 9 of the dump): air, with no reached stand in reach
const tops = solidKeys.filter(([x, y, z]) => y >= 9 && y < S.y - 3 && world.isAirish(at(x, y + 1, z)) && /brick|stone|andesite|planks|log|wood/.test(at(x, y, z).name)).map(([x, y, z]) => ({ x, y: y + 1, z }))
const unstood = tops.filter(c => !stood(c)).length // (this dump's upper walls mostly have a stand in reach already: the ring is planned over them all the same - its geometry is what is checked)
const jobAt = new Set(tops.map(key))
const rw0 = { at, isAirish: world.isAirish, isSolid: b => world.isSolid(b) && !world.isOpenTrapdoor(b), jobHas: (x, y, z) => jobAt.has(`${x},${y},${z}`) || (inside(x, y, z) && !world.isAirish(at(x, y, z)) && false), airDown: (x, y, z) => { for (let n = 0; n <= 32; n++) { const b = at(x, y - n, z); if (!b) return null; if (!world.isAirish(b)) return n } return null }, hot: (x, y, z) => { const b = at(x, y, z); const u = at(x, y - 1, z); return !!(b && /campfire|fire|magma/.test(b.name)) || !!(u && /campfire|fire|magma/.test(u.name)) }, SAFE_DROP: world.SAFE_DROP }
const roomsMod = require(path.join(bot2, 'lib', 'rooms'))
;(async () => {
// THE LIVE REFUSAL'S COST, measured: the room rules on this world (rooms.doorwayAxis, closesRoom, closesPocket over the work
// near the block, the last-stand check) - build.js ringRefusal's questions, here with the fixture's walk model; the slice is
// the event loop's: planRing yields between questions as the live builder does (ringTicker)
let slice = Date.now(); let longest = 0; let refusals = 0; let planMs = 0
const tick = async () => { const d = Date.now() - slice; if (d > longest) longest = d; if (d > 8) { await new Promise(r => setImmediate(r)); slice = Date.now() } }
const standsOfF = q => { const out = []; for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -4; dy <= 1; dy++) { const st = { x: q.x + dx, y: q.y + dy, z: q.z + dz }; if (W.st(st.x, st.y, st.z) && eyeOk(st, q)) out.push(st) } return out }
const refusedF = (work, memo) => async r => {
  refusals++
  const jobUnbuilt = (x, y, z) => jobAt.has(`${x},${y},${z}`)
  const stOf = q => { const k0 = key(q); let v = memo.get(k0); if (!v) { v = standsOfF(q); memo.set(k0, v) } return v }
  if (roomsMod.doorwayAxis(rw, jobUnbuilt, r) || roomsMod.doorwayAxis(rw, jobUnbuilt, { x: r.x, y: r.y - 1, z: r.z })) return 'a doorway'
  const c = { x: r.x, y: r.y, z: r.z, name: 'cobblestone' }; const box = { x1: 3, x2: S.x - 4, z1: 3, z2: S.z - 4 }
  const near = work.filter(q => Math.abs(q.x - r.x) <= 6 && Math.abs(q.z - r.z) <= 6 && Math.abs(q.y - r.y) <= 4)
  if (roomsMod.closesRoom(rw, c, { box, jobUnbuilt, work: near, standsOf: stOf })) return 'closes a room'
  if (near.length && await roomsMod.closesPocketAsync(rw, c, { box, work: near, standsOf: stOf }, tick)) return 'closes a pocket'
  for (const q of near) { if (Math.abs(q.x - r.x) > 3 || Math.abs(q.z - r.z) > 3 || r.y - q.y > 2 || q.y - r.y > 5) continue; const st = stOf(q); if (st.length && st.every(p0 => p0.x === r.x && p0.z === r.z && (p0.y === r.y || p0.y + 1 === r.y))) return 'last stand'; await tick() }
  return null
}
let ringsLaid = 0; let ringServed = 0; let ringUnserved = 0; let ringBlocks = 0; const ringEx = []
const usedTops = new Set()
for (const c0 of tops) {
  if (ringsLaid >= 3 || usedTops.has(key(c0))) continue
  const cluster = tops.filter(q => q.y === c0.y && Math.abs(q.x - c0.x) <= 4 && Math.abs(q.z - c0.z) <= 4)
  if (cluster.length < 3) continue
  const work = tops.filter(q => Math.abs(q.x - c0.x) <= 12 && Math.abs(q.z - c0.z) <= 12)
  const t0 = Date.now(); slice = Date.now()
  const plan = await ringMod.planRing(rw0, cluster, { stand: (x, y, z) => reached.has(`${x},${y},${z}`), refused: refusedF(work, new Map()), tick })
  planMs += Date.now() - t0; { const d = Date.now() - slice; if (d > longest) longest = d }
  for (const q of cluster) usedTops.add(key(q))
  if (!plan) continue
  const put = (plan.access.kind === 'tower' ? plan.access.tower : []).concat(plan.blocks)
  for (const b of put) cells.set(key(b), Block.fromProperties('cobblestone', {}, 0))
  ringsLaid++; ringBlocks += put.length
  const after = reachSet(plan.access.from); const afterList = [...after].map(k0 => { const [x, y, z] = k0.split(',').map(Number); return { x, y, z } })
  for (const c of plan.serves) { if (afterList.some(st => eyeOk(st, c))) ringServed++; else { ringUnserved++; if (ringEx.length < 3) ringEx.push(key(c)) } }
  // the new stands' steps, against the planner
  for (const b of plan.blocks) { const st = { x: b.x, y: b.y + 1, z: b.z }; if (!W.st(st.x, st.y, st.z)) continue; const pn = new Set(plannerNext(st).map(key)); for (const n of W.next(st)) { modelEdges++; if (!pn.has(key(n))) { mismatched++; const c = 'ring top'; byClass[c] = (byClass[c] || 0) + 1 } } }
}
console.log(`ring: ${tops.length} upper wall-top cells (${unstood} with no stand in reach); ${ringsLaid} rings planned (${ringBlocks} blocks); ${ringServed} cells served with a reachable stand in reach, ${ringUnserved} not${ringEx.length ? ' (' + ringEx.join(' ') + ')' : ''}; planning ${planMs}ms for ${refusals} room-rule questions, longest slice ${longest}ms`)
const hard = Object.entries(byClass).filter(([c]) => !/ladder/.test(c)).reduce((t, [, n]) => t + n, 0)
const fails = [hard && `${hard} non-ladder steps the planner refuses`, startWrong && `${startWrong} stands the planner starts elsewhere`, deadMissed && `${deadMissed} dead ends the model reads as open`, wedgeStands && `${wedgeStands} wedge cells the model calls a stand`, wpOff && `${wpOff} waypoints off the floor in cells the legs walk through`, longest > 25 && `the ring plan held the loop ${longest}ms in one slice`, ringUnserved && `${ringUnserved} cells a ring was planned for still without a stand`, !ringsLaid && tops.length >= 3 && 'no ring planned on the site', droppedLeavable && `${droppedLeavable} stands dropped as dead ends the planner leaves`].filter(Boolean)
console.log(fails.length ? `FAIL ${fails.join('; ')}` : 'PASS')
process.exit(fails.length ? 1 : 0)
})()
