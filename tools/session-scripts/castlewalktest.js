'use strict'
// castlewalktest.js - the walk model (rooms.walkModel over world.standable/floorTop/plateEdge - what walkReach and the
// stands read) against THE PLANNER that walks the legs (mineflayer-pathfinder's Movements, dig and place off), on a real
// castle site dumped block by block (castlewalk.fixture.json: every non-air block, relative to the dump's corner).
// Every walk-model step should be a step the planner can take: a step the model allows and the planner refuses is a leg
// that times out, a stand that is never reached, a region read open that the body cannot leave. Counted by geometry class.
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

// ---- the planner, as the legs' movementsFor sets it: no dig, no place, doors walked, open trapdoors passable, panel edges
const mv = new Movements(bot)
mv.canDig = false; mv.allow1by1towers = false; mv.scafoldingBlocks = []; mv.allowParkour = false; mv.allowSprinting = false; mv.maxDropDown = world.SAFE_DROP
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
// (the gate: no step the planner refuses, but a ladder's - the climbs are modelled on their own)
const hard = Object.entries(byClass).filter(([c]) => !/ladder/.test(c)).reduce((t, [, n]) => t + n, 0)
console.log(hard ? `FAIL ${hard} non-ladder steps the planner refuses` : 'PASS')
process.exit(hard ? 1 : 0)
