'use strict'
// THE movement layer. Every walk in the bot goes through goTo/travel. One Movements profile,
// built per call from two switches (dig, place) plus the protected zones. Arrival is VERIFIED
// with goal.isEnd (pathfinder's own goto resolves "success" on an empty path).
const { Movements, goals } = require('mineflayer-pathfinder')
const world = require('./world')
const { log } = require('./log')
const control = require('./control')

let reflexRef = null // set by main: { active(): string|null }
function bindReflex (r) { reflexRef = r }
let botRef = null
// (a replan - the planner's own digs and places changed the ground - drops every movements' drop memo: audit #24)
let pathGen = 0
// (where a search's time goes - the planner ran ~1000 nodes a second after the exclusion memo; measured, not guessed: ms in
//  the exclusion rules (memo misses) and in the getBlock override, and the calls - read by the stall snapshot)
const searchProf = { exMs: 0, exCalls: 0, exMiss: 0, gbMs: 0, gbCalls: 0, reset () { this.exMs = 0; this.exCalls = 0; this.exMiss = 0; this.gbMs = 0; this.gbCalls = 0 } }
// (a throw inside the pathfinder's tick - caught by the patched wrapper, one path reset: counted, and said at most every
//  10s with its first stack line - the watchdog alarms on "path_error"; patch-mc262.js)
let pathErrors = 0; let pathErrSaid = 0
// (when each cell last changed: the planner's block cache asks it on every hit, so a block dug or placed mid-search is read
//  afresh - never a stale floor. Past 20000 cells the whole cache is dropped: changedEpoch)
const changedAt = new Map(); let changedEpoch = 0
function bindBot (b) {
  botRef = b
  try { b.on('path_reset', () => { pathGen++ }) } catch {}
  try { b.on('chunkColumnUnload', () => { changedEpoch++ }) } catch {} // (cells the world dropped: the cache with them; audit)
  try { b.on('blockUpdate', (o, n) => { const q = (n && n.position) || (o && o.position); if (!q) return; if (changedAt.size > 20000) { changedAt.clear(); changedEpoch++ } changedAt.set(q.x + ',' + q.y + ',' + q.z, performance.now()) }) } catch {}
  try { b.on('path_error', e => { pathErrors++; if (Date.now() - pathErrSaid > 10000) { pathErrSaid = Date.now(); require('./log').log('move', `path_error #${pathErrors}: ${e && e.message} ${((e && e.stack) || '').split(/\r?\n/)[1] || ''} - the path was reset`) } }) } catch {}
  // (a gate or door on the path refused its click - innocent once; a streak at one spot is the stuck retry the watchdog
  //  alarms on: "path_use_error at x,y,z")
  let useSaid = 0
  try { b.on('path_use_error', ({ pos, err } = {}) => { if (Date.now() - useSaid > 5000) { useSaid = Date.now(); const bk = pos && b.blockAt && b.blockAt(new (require('vec3').Vec3)(pos.x, pos.y, pos.z)); require('./log').log('move', `path_use_error at ${pos ? pos.x + ',' + pos.y + ',' + pos.z : '?'} (${bk ? bk.name : '?'}): ${err && err.message}`) } }) } catch {}
}
function reflexActive () { return reflexRef ? reflexRef.active() : null }

// Zones the bot must never dig/place in unless the caller says so (its own base, a build site).
// Each: {x1,y1,z1,x2,y2,z2,label}
const zones = []
function setZone (label, box) { setZones(label, box ? [box] : []) }
// Several boxes under one label (the orchard: a small box round each tree - one box round trees scattered on every
// side of home covered the base, the farm and the furnaces: nothing near home could be dug, levelled or placed)
function setZones (label, boxes) {
  for (let i = zones.length - 1; i >= 0; i--) if (zones[i].label === label) zones.splice(i, 1)
  for (const box of boxes) zones.push(Object.assign({ label }, box))
}
// The ground a build stands on: its footprint +8 in x/z, at any depth up to its top. No dig path goes through it but the
// builder's own (allowZones 'build') - an ore trip tunnelled under the castle's edge, stuck 98s and came up through the
// plaza, and a zone that starts at the build's floor never saw it (2026-09-27; the audit: one rule, not per caller)
function underBuild (p) {
  let j = null; try { j = require('./build').getJob() } catch {}
  if (!j || !j.box || !p) return false
  // (BELOW its floor - above it the build zone itself rules - and never another zone's ground: the safehouse and the farm
  //  stand within 8 of this castle's edge, and their own work must go on)
  if (!(p.x >= j.box.x1 - 8 && p.x <= j.box.x2 + 8 && p.z >= j.box.z1 - 8 && p.z <= j.box.z2 + 8 && p.y < j.box.y1)) return false
  const z = inZone(p, 1); return !z || z.label === 'build'
}
// A zone right overhead (its footprint, up to 48 below its floor): a hole there is a way up through it
function underZone (p, pad = 0) {
  return zones.find(z => z.y1 != null && p.y < z.y1 - pad && p.y >= z.y1 - 48 && p.x >= z.x1 - pad && p.x <= z.x2 + pad && p.z >= z.z1 - pad && p.z <= z.z2 + pad) || null
}
// (except: zone labels to look through - a zone's owner asking about its own ground)
function inZone (p, pad = 0, except = null) {
  for (const z of zones) {
    if (except && except.includes(z.label)) continue
    if (p.x >= z.x1 - pad && p.x <= z.x2 + pad && p.y >= (z.y1 == null ? -999 : z.y1 - pad) && p.y <= (z.y2 == null ? 999 : z.y2 + pad) && p.z >= z.z1 - pad && p.z <= z.z2 + pad) return z
  }
  return null
}

// May a utility block (table/furnace/chest/bed) go here? Not in a protected zone and not in the
// mine's walkway (a furnace on the staircase once sealed the mine face).
function utilitySpotOK (p, { temporary = false, except = null } = {}) {
  // furniture stands on the floor, never on other furniture (a furnace on a chest seals the chest shut)
  const below = botRef ? world.at(botRef, p.x, p.y - 1, p.z) : null
  if (below && /(chest|furnace|crafting_table|_bed|barrel|smoker|blast_furnace|anvil|enchanting_table)$/.test(below.name)) return false
  const z = inZone(p, 0, except)
  if (z && z.label !== 'base') return false // the base is exactly where tables/furnaces/chests belong
  // never block the safehouse doorway (furniture on the step inside the door locks us out)
  const plan = require('./memory').get().hutPlan
  if (plan && plan.door && Math.abs(p.x - plan.door.x) + Math.abs(p.z - plan.door.z) <= 1 && Math.abs(p.y - plan.home.y) <= 1) return false
  // (nor the 3x3 round the OUTSIDE door step - furnish's own "crowding the way in" rule: a chest placed there by the deposit
  //  was picked up by furnish at once, placed again, picked up - every few seconds, 2026-09-29. One rule for both)
  if (require('./hut').inDoorApron(p, plan)) return false
  // nor the room's walkway or the bed's cells (a furnace landed mid-walkway, the table before it)
  if (plan && botRef && Math.abs(p.y - plan.home.y) <= 1) {
    const lay = require('./hut').layout(botRef)
    if (lay) {
      const same = c => c && c.x === p.x && c.z === p.z
      if (lay.walkway.some(same) || (lay.bed && (same(lay.bed.head) || same(lay.bed.foot)))) return false
    }
  }
  const m = require('./memory').get().mine
  // (a table put down for one craft and picked up again may stand in the tunnel - in a 1-wide tunnel
  //  every cell is "the mine path", and a worn-out pickaxe could not be replaced)
  if (m && !temporary) {
    for (const q of [m.cursor, m.entrance]) if (q && Math.abs(q.x - p.x) <= 2 && Math.abs(q.z - p.z) <= 2 && Math.abs(q.y - p.y) <= 3) return false
    // anywhere along the staircase line between entrance and cursor (every level's: mining.mineBox, the mine's one extent)
    const bx = m.entrance && m.cursor && require('./mining').mineBox(m)
    if (bx) {
      if (p.x >= bx.x1 - 1 && p.x <= bx.x2 + 1 && p.z >= bx.z1 - 1 && p.z <= bx.z2 + 1 && p.y >= bx.y1 - 1 && p.y <= bx.y2 + 2) return false
    }
  }
  return true
}

// Finished blocks of our own builds (hut, castle) are never broken by ANY walk. build.js registers.
let protector = null
function setProtector (fn) { protector = fn }
// Is this block a finished cell of one of our builds? `purpose` 'walk' (the planner) or 'dig' (act.dig - the
// one dig primitive asks this for every dig, so no caller can forget it). A throw is "not protected": a
// broken protector must not freeze every walk.
// And every block of someone else's place (foreign.js): not one broken by a walk or a dig, whatever the caller's force.
function isProtected (block, purpose = 'walk') {
  if (!block || !block.position) return false
  // (a place of the planner's own blocks while climbing out over their wall - foreign.overTheWall - is the one exception)
  if (inForeign(block.position)) return !(purpose === 'fill' && climbingOutOfForeign())
  if (!protector) return false
  try { return !!protector(block, purpose) } catch { return false }
}

function inForeign (p) { try { return !!require('./foreign').covers(p) } catch { return false } }
function climbingOutOfForeign () { try { return require('./foreign').climbingOut() } catch { return false } }

// Inside the safehouse walls (interior cells only)?
function insideHut (p) {
  const h = require('./memory').get().hut
  if (!h || !h.box) return false
  const b = h.box
  return p.x > b.x1 && p.x < b.x2 && p.z > b.z1 && p.z < b.z2 && p.y >= b.y1 && p.y < b.y2
}

let cantBreakIds = null
let scaffoldIds = null
let doorIds = null
//   dryHead: a node with the head under water is forbidden, not merely costly (the step weight passes the planner's
//            100 cut-off). On by default: at weight 40 the walk home from a clay bank still took the line under the
//            river, the air reflex took the body, and at night the bot drowned there (2026-09-22). A walk that must
//            dive says so (false) - none does today.
function movementsFor (bot, { dig = true, place = true, allowZones = [], sprint = true, dryHead = true, placeCost = 10, edgeCost = 0 } = {}) {
  // (the drop under a cell, once per plan: the step callbacks asked ~100 uncached blockAt per expanded node - audit #24)
  const drops = new Map(); let dropGen = pathGen
  const dropAt = (x, y, z, lim) => { if (dropGen !== pathGen || drops.size > 20000) { drops.clear(); dropGen = pathGen } const key = x + ',' + y + ',' + z + ',' + (lim || ''); let v = drops.get(key); if (v === undefined) { v = world.dropAt(bot, x, y, z, lim); drops.set(key, v) } return v }
  const md = world.data(bot)
  const m = new Movements(bot)
  if (!cantBreakIds) {
    cantBreakIds = new Set(Object.values(md.blocksByName).filter(b => !world.NATURAL_RE.test(b.name)).map(b => b.id))
    scaffoldIds = ['dirt', 'andesite', 'diorite', 'tuff', 'cobbled_deepslate', 'netherrack', 'coarse_dirt', 'rooted_dirt']
      .map(n => md.itemsByName[n]).filter(Boolean).map(i => i.id)
  }
  m.canDig = dig
  m.blocksCantBreak = new Set([...m.blocksCantBreak, ...cantBreakIds])
  m.digCost = 2
  // (a stepping stone's price is its whole life: the place, and the walk back one day to dig it out - never collected by the
  //  walk that laid it. At 2 - two steps - the planner laid one to save a couple of steps, and 106 single stones stood
  //  round home by evening, litter on every slope the operator walked, 2026-09-28. A player walks round. The builder's site
  //  walks pass their own, lower: their scaffold is tracked and taken down - audit)
  m.placeCost = placeCost
  m.allow1by1towers = place
  m.scafoldingBlocks = place ? scaffoldIds.slice() : []
  // scaffold short (under half the builder's 32 in reserve): cobblestone will do to tower or bridge out (the build's stone, but a player
  // walled into a one-wide shaft of its own cathedral wall with 137 cobble and one dirt climbs out on the cobble - the bot
  // stood there twenty minutes, 2026-09-25; stray cobble is scaffold to the teardown)
  if (place && bot.inventory.items().filter(i => scaffoldIds.includes(i.type)).reduce((a, i) => a + i.count, 0) < 16) { const cb = md.itemsByName.cobblestone; if (cb) m.scafoldingBlocks.push(cb.id) }
  m.allowParkour = false
  // walking costs no hunger, sprinting ~1 food point per 40 m: only sprint on a full belly
  m.allowSprinting = sprint === 'always' || (sprint && bot.food >= 18)
  m.maxDropDown = world.SAFE_DROP
  m.infiniteLiquidDropdownDistance = false
  m.liquidCost = 3
  m.canOpenDoors = true
  m.dontCreateFlow = true
  m.dontMineUnderFallingBlock = true
  for (const n of ['magma_block', 'powder_snow', 'sweet_berry_bush', 'cactus', 'campfire', 'soul_campfire', 'wither_rose', 'pointed_dripstone', 'fire', 'soul_fire']) {
    const b = md.blocksByName[n]; if (b) m.blocksToAvoid.add(b.id)
  }
  // DOORS are a way through. mineflayer-pathfinder opens fence gates only; a door is solid to it, open or shut, so
  // no plan ever went through one: the church's inside could not be reached at all and its nave scaffold stood for
  // days (2026-09-23). Planned as passable (a small toll so a door is used when it is the way); at the door the walk
  // stalls on the closed leaf and the stall recovery crosses it by hand (crossDoor), as a player opens a door.
  if (!doorIds) doorIds = new Set(Object.values(md.blocksByName).filter(b => /_door$/.test(b.name) && !/iron_door/.test(b.name)).map(b => b.id))
  const getBlock0 = m.getBlock.bind(m)
  // ONE BLOCK OBJECT A CELL, a search: the planner asked for the same cells over and over - 1.85 million block reads, 2.1s of a
  // 2.3s search, each a fresh Block built from the world - and the way round the pit by the mine was never found in its 8s,
  // 2026-10-03. Cached by the cell; a cell changed since (changedAt) is read afresh; an unloaded cell (no position) never
  // kept; dropped with a path reset, as the rule memos are
  const bcache = new Map(); let bgen = pathGen; let bep = changedEpoch
  m.getBlock = (pos, dx, dy, dz) => {
    const tg = performance.now(); searchProf.gbCalls++
    if (bgen !== pathGen || bep !== changedEpoch || bcache.size > 50000) { bcache.clear(); bgen = pathGen; bep = changedEpoch }
    const k = pos ? (pos.x + dx) + ',' + (pos.y + dy) + ',' + (pos.z + dz) : null
    const hit = k ? bcache.get(k) : null
    if (hit) { const c = changedAt.get(k); if (c === undefined || c < hit.t) { hit.b.height = hit.h; searchProf.gbMs += performance.now() - tg; return hit.b } } // (its height as read: the jump-up move adds 1 to a block it was handed - movements.js; audit)
    const b = getBlockAdj(pos, dx, dy, dz)
    if (k && b && b.position) bcache.set(k, { b, t: performance.now(), h: b.height })
    searchProf.gbMs += performance.now() - tg
    return b
  }
  function getBlockAdj (pos, dx, dy, dz) {
    const b = getBlock0(pos, dx, dy, dz)
    if (b && doorIds.has(b.type)) { b.safe = true; b.physical = false; b.replaceable = false; b.height = pos.y + dy }
    // (an IRON door standing OPEN - a plate holds it - is a way through while it stands open: the gate of a walled base;
    //  shut, it stays a wall - no hand opens it; foreign.byTheirGate, audit)
    else if (b && b.name === 'iron_door' && (() => { try { return b.getProperties().open === true } catch { return false } })()) { b.safe = true; b.physical = false; b.replaceable = false; b.height = pos.y + dy }
    // (an OPEN trapdoor is no floor: a plate on its edge - planned on as ground, the walk stepped into the hole it hangs
    //  in, 2026-09-29. It is an EDGE, not a wall: the cell itself is room for the body - the plate stops only a step
    //  ACROSS it (panelEdges below, on the neighbours). Refused whole, the castle's double door whose two oak trapdoors
    //  stand open just inside was a dead end: 17 walks "to the door" stuck in an hour, 2026-09-29. Walked through whole,
    //  the walk stood against the trapdoor rail - the edge rule is what both lacked)
    else if (b && b.physical && world.isOpenTrapdoor(b)) { b.safe = true; b.physical = false; b.replaceable = false; b.height = pos.y + dy }
    return b
  }
  m.exclusionAreasStep.push(block => (block && doorIds.has(block.type)) ? 4 : 0)
  // (NEVER A BREAK THAT OPENS A FALL: a block with open air - or lava - for 4 under it, dug, is a hole the body drops into. The
  //  planner's dig down at a web broke a cave's roof and the bot fell 37 to its death, 2026-10-05: maxDropDown prices planned
  //  drops, not the void found under a dug floor. Tunnels and ceilings keep their floor within 3; the odd cave roof is left as a
  //  player leaves it; audit)
  if (dig) m.exclusionAreasBreak.push(block => { if (!block || !block.position) return 0; const p = block.position; for (let k = 1; k <= world.SAFE_DROP + 1; k++) { const u = world.at(bot, p.x, p.y - k, p.z); if (!u) return 0; if (world.isLavaBlock(u)) return 100; if (u.boundingBox === 'block' || world.isWaterBlock(u)) return 0 } return 100 })
  // (a step BESIDE a lit campfire, magma or fire at the feet: never on it (blocksToAvoid), but the body brushed onto the
  //  castle's campfires from the cells beside them and burned twice, 2026-09-30. Walked round when there is a way round)
  const hotNear = new Map(); let hotGen = pathGen
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    if (hotGen !== pathGen || hotNear.size > 20000) { hotNear.clear(); hotGen = pathGen }
    const p = block.position; const key = p.x + ',' + p.y + ',' + p.z
    let v = hotNear.get(key)
    // (and never a step whose FLOOR is one: the feet cell's rule (blocksToAvoid) kept the campfire out of the feet, but its
    //  0.44 top passed the floor test - a walk planned to stand ON it, stepped up without a jump, and the bot burned twice;
    //  the same rule standable() holds; audit)
    if (v === undefined) { const f = world.at(bot, p.x, p.y - 1, p.z); v = (f && world.HOT_RE.test(f.name)) || world.HOT_RE.test(block.name) ? 100 : [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const b = world.at(bot, p.x + dx, p.y, p.z + dz); return !!b && world.HOT_RE.test(b.name) }) ? 30 : 0; hotNear.set(key, v) }
    return v
  })
  // (never a DIAGONAL step past a drop that hurts: the body's 0.6 hitbox sweeps the corner cell of a diagonal, and a
  //  shaft there takes it - 11 blocks, 8 hp by the orchard, a diagonal 0.7s after the lip reflex let go, 2026-09-29.
  //  Either cell it passes between with a hurting drop under it: no diagonal; the two straight steps remain; audit)
  const diagDrop = new Map(); let diagGen = pathGen
  const hurtsAt = (x, y, z) => {
    if (diagGen !== pathGen || diagDrop.size > 20000) { diagDrop.clear(); diagGen = pathGen }
    const k = x + ',' + y + ',' + z; let v = diagDrop.get(k)
    if (v === undefined) { v = world.dropAt(bot, x + 0.5, y, z + 0.5) > world.SAFE_DROP; diagDrop.set(k, v) }
    return v
  }
  // PANEL EDGES: an open trapdoor's plate, an open door's, stands on ONE edge of its cell (world.plateEdge - the one model
  //  the way-out search reads too); a step across that edge is refused, every other step through the cell stands. At the
  //  body's heights of both ends; a jump or a drop checks the whole span; a diagonal, all four edges it sweeps (memoised a
  //  plan). (An open door was air here and an edge to the search: the planner walked into a pocket past a door's plate
  //  and the escape dug out of it, 2026-09-29)
  const panelMemo = new Map(); let panelGen = pathGen
  const panelAt = (x, y, z) => {
    if (panelGen !== pathGen || panelMemo.size > 20000) { panelMemo.clear(); panelGen = pathGen }
    const k = x + ',' + y + ',' + z; let v = panelMemo.get(k)
    if (v === undefined) { v = world.plateEdge(world.at(bot, x, y, z)); panelMemo.set(k, v) }
    return v
  }
  const edgeShut = (x, z, dx, dz, y0, y1) => {
    for (let y = y0; y <= y1; y++) {
      const a = panelAt(x, y, z); if (a && a[0] === dx && a[1] === dz) return true
      const c = panelAt(x + dx, y, z + dz); if (c && c[0] === -dx && c[1] === -dz) return true
    }
    return false
  }
  const nb0 = m.getNeighbors.bind(m)
  m.getNeighbors = node => nb0(node).filter(mv => {
    const sx = Math.sign(mv.x - node.x); const sz = Math.sign(mv.z - node.z)
    if (!sx && !sz) return true
    const y0 = Math.min(node.y, mv.y); const y1 = Math.max(node.y, mv.y) + 1
    if (sx && sz) return !(edgeShut(node.x, node.z, sx, 0, y0, y1) || edgeShut(node.x, node.z, 0, sz, y0, y1) || edgeShut(node.x + sx, node.z, 0, sz, y0, y1) || edgeShut(node.x, node.z + sz, sx, 0, y0, y1))
    const n = Math.abs(mv.x - node.x) + Math.abs(mv.z - node.z)
    for (let i = 0; i < n; i++) if (edgeShut(node.x + sx * i, node.z + sz * i, sx, sz, y0, y1)) return false
    return true
  })
  const diag0 = m.getMoveDiagonal.bind(m)
  // (nor past a block that hurts to touch in either cell it sweeps, at the feet or the head: a lit campfire is slab-high -
  //  the body clipped its corner on a diagonal between two of the castle's, stepped up onto it and burned to death,
  //  2026-09-30; audit)
  const touchHurts = (x, y, z) => [0, 1].some(dy => { const b = world.at(bot, x, y + dy, z); return !!b && world.CONTACT_HURT_RE.test(b.name) })
  m.getMoveDiagonal = (node, dir, neighbors) => {
    if (hurtsAt(node.x, node.y, node.z + dir.z) || hurtsAt(node.x + dir.x, node.y, node.z)) return
    if (touchHurts(node.x, node.y, node.z + dir.z) || touchHurts(node.x + dir.x, node.y, node.z)) return
    return diag0(node, dir, neighbors)
  }
  // (a step whose FLOOR is a natural leaf: a tree's crown is no ground - felled, it rots from under the feet; the orchard's
  //  canopy walks ended in falls and a 40s tug between the leaf reflex and the planner, 2026-09-28. Over the crowns only
  //  when there is no way along the ground)
  // (memoised with the drops - one floor read per cell a plan; the properties only for a leaf)
  const leafFloor = new Map(); let leafGen = pathGen
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    if (leafGen !== pathGen || leafFloor.size > 20000) { leafFloor.clear(); leafGen = pathGen }
    const key = block.position.x + ',' + block.position.y + ',' + block.position.z
    let v = leafFloor.get(key)
    if (v === undefined) {
      const f = world.at(bot, block.position.x, block.position.y - 1, block.position.z)
      v = 0
      // (and one at distance 7 - no log within 6, rotting now - the last resort (70: 100 is a ban - the planner drops a step
      //  past it - and a bot already on a rotting crown would get no path at all; audit): the walk home from a felled mega spruce's top crossed
      //  its crown at y140, the leaves rotted under it and it fell 18 blocks, hp 20 -> 5, 2026-10-07 04:22)
      if (f && /_leaves$/.test(f.name)) { let pr = {}; try { pr = f.getProperties() || {} } catch {} if (pr.persistent === false || pr.persistent === 'false') v = Number(pr.distance) >= 7 ? 70 : 25 }
      leafFloor.set(key, v)
    }
    return v
  })
  // (a cell a 1.8 body does not fit: a closed BOTTOM trapdoor as the head cell over open feet, or a closed TOP trapdoor as
  //  the feet cell over a floor - 1.19 and 0.81 high. The planner walks trapdoors as passable and wedged the bot under a
  //  castle one, pinned by the server, back in the same cell after every relog, 2026-09-28. Refused, never opened: a
  //  castle cell's open state is the builder's)
  const tdMemo = new Map(); let tdGen = pathGen
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position || !/_trapdoor$/.test(block.name || '')) return 0
    if (tdGen !== pathGen || tdMemo.size > 20000) { tdMemo.clear(); tdGen = pathGen }
    const p = block.position; const k = p.x + ',' + p.y + ',' + p.z
    let v = tdMemo.get(k)
    if (v === undefined) {
      let pr = {}; try { const tb = world.at(bot, p.x, p.y, p.z); pr = (tb && tb.getProperties()) || {} } catch {}
      v = 0
      if (String(pr.open) === 'false') {
        const below = world.at(bot, p.x, p.y - 1, p.z); const solidBelow = !!below && world.isSolid(below)
        if (pr.half === 'bottom' && !solidBelow) v = 100 // (a head cell: the feet under it are open)
        if (pr.half === 'top' && solidBelow) v = 100 // (a feet cell: its floor under it)
      }
      tdMemo.set(k, v)
    }
    return v
  })
  // (a step UNDER THE CASTLE'S FLOOR - the hollow a column with a base cell over it: the rim and the floor wall it in as
  //  they rise, and the planner walked in through a gap still open, then spent fifteen minutes "stuck" getting out,
  //  2026-09-28. A cost, not a refusal: the way out is still a way; audit)
  const hollow = new Map(); let hollowGen = pathGen
  // (a walk that STARTS under the floor pays neither hollow cost: every way out is made of such steps, and at 40+60 a step
  //  the search spent its budget and handed back a partial path whose next node was the bot's own cell - "moving false,
  //  keys none", walk after walk in the south-west hollow, 2026-09-29. The costs keep walks from going IN)
  const startUnder = (() => { try { const j = require('./build').getJob(); const b = j && j.box; const f = bot.entity.position.floored(); return !!b && f.y < b.y1 && f.x >= b.x1 && f.x <= b.x2 && f.z >= b.z1 && f.z <= b.z2 } catch { return false } })()
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position || startUnder) return 0
    let j = null; try { j = require('./build').getJob() } catch {}
    const b0 = j && j.box; const p = block.position
    if (!b0 || p.y >= b0.y1 || p.x < b0.x1 || p.x > b0.x2 || p.z < b0.z1 || p.z > b0.z2) return 0
    if (hollowGen !== pathGen || hollow.size > 20000) { hollow.clear(); hollowGen = pathGen }
    const k = p.x + ',' + p.z
    let v = hollow.get(k)
    // (and a PIT inside the footprint with no floor cell over it - ground 3 or more under the floor's level: a hollow whose
    //  lid is not built, or never will be. The unbuilt corner's walks went down into one and every walk out failed,
    //  2026-09-29; audit)
    if (v === undefined) { const gy = world.groundY(bot, p.x, p.z, b0.y1); v = (j.index.has(`${p.x},${b0.y1},${p.z}`) || (gy != null && gy <= b0.y1 - 3)) ? 40 : 0; hollow.set(k, v) }
    return v
  })
  // (a remembered trap's cells: dear, not refused - a walk that starts inside one can still leave; noteTrap)
  let trapSet = null; let trapGen = -1
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    if (trapGen !== pathGen) { trapGen = pathGen; trapSet = new Set(); for (const t of (require('./memory').get().trapCells || [])) if (t.day != null && trapLive(bot, t)) trapSet.add(`${t.x},${t.y},${t.z}`) }
    const k = `${block.position.x},${block.position.y},${block.position.z}`
    // (and a door the crossing just refused - nowhere to stand on a side: dear for ten minutes, the walk plans round it; the
    //  stall retried one every 11s, five times, 2026-09-30)
    const rd = refusedDoors.get(k)
    if (rd) { if (rd.gen !== pathGen) { rd.gen = pathGen; rd.on = doorStillRefused(bot, rd) } if (rd.on) return 50; refusedDoors.delete(k) }
    return trapSet.size && trapSet.has(k) ? 50 : 0
  })
  // (a cell a fall began from - and its sides, at its height: dear, not refused; the list is reflex.js's fall record)
  let fallCells = null; let fallGen = -1
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    if (fallGen !== pathGen) {
      fallGen = pathGen; fallCells = new Set()
      for (const q of (require('./memory').get().fallHazards || [])) { if (Date.now() - q.at > 24 * 3600000) continue; for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) fallCells.add(`${q.x + dx},${q.y},${q.z + dz}`) }
    }
    return fallCells.size && fallCells.has(`${block.position.x},${block.position.y},${block.position.z}`) ? 60 : 0
  })
  // (a step into water with no air over it within two - a roofed pocket, a flooded cave: the planner stepped the bot
  //  down into one 170 blocks out and it drowned under a stone roof, 2026-09-28. Swimming at the surface costs nothing
  //  more; a way through a sealed pocket only when there is no other)
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position || !world.isWaterBlock(block)) return 0
    const p = block.position
    for (let dy = 1; dy <= 2; dy++) { const b = world.at(bot, p.x, p.y + dy, p.z); if (!b || world.isAirish(b)) return 0 }
    return 40
  })
  const allowed = new Set(allowZones)
  // (blocks in unloaded chunks reach these callbacks without a position: a throw here aborts A*)
  // (the farm never needs the planner's stepping stones or tunnels: the farm tasks' own walks paved the crops with
  //  dirt and cobble to cross them - a stepping stone cost 2 against 25 a step on farmland - and the levelling took
  //  them away again, 3-7 fixes a minute, 2026-09-26. Placing and digging there is refused for every walk.)
  m.exclusionAreasBreak.push(block => { if (!block || !block.position) return 0; const z = inZone(block.position); return z && z.label === 'farm' ? 101 : (z && !allowed.has(z.label)) ? 100 : 0 })
  m.exclusionAreasBreak.push(block => isProtected(block, 'walk') ? 100 : 0)
  m.exclusionAreasBreak.push(block => (block && block.position && !allowed.has('build') && underBuild(block.position)) ? 100 : 0) // (under the build: the builder's own digs only)
  // never a stepping stone on a chest's lid: it shuts the chest (audit R6, 2026-09-27)
  const lids = new Set((require('./memory').get().chests || []).map(c => `${c.x},${c.y + 1},${c.z}`))
  m.exclusionAreasPlace.push(block => (block && block.position && lids.has(`${block.position.x},${block.position.y},${block.position.z}`)) ? 100 : 0)
  // (never a stepping stone in a cell of the build, placed or not - the protector's 'fill' rule, the one the towers ask: the
  //  planner laid cobble into the castle's unbuilt cells, and a site clearing spent 176s taking 14 of them back out,
  //  2026-09-29)
  m.exclusionAreasPlace.push(block => isProtected(block, 'fill') ? 100 : 0)
  m.exclusionAreasPlace.push(block => {
    if (!block || !block.position) return 0
    const z = inZone(block.position); if (z && z.label === 'farm') return 101; if (z && !allowed.has(z.label)) return 100
    if (world.isWaterBlock(block)) return 100 // never build causeways into water
    // never a block with a fall under it that hurts: a player does not lay a one-wide bridge out into the air to reach
    // ground below a cliff. The planner, held to SAFE_DROP steps down, bridged 31 blocks north off the plaza at y124,
    // 60 over the valley, toward sand at y62 - and the bot fell off its end placing the next block (2026-09-25).
    // (A tower's block goes under our own feet, on ground; a gap a step wide has its floor within reach.)
    const p = block.position
    // (measured where the body stands to place it - the feet, one over the block - as the lip and edge guards measure: from
    //  the block's own height a 4-block pit read 3, the planner bridged it, the lip reflex pulled the body back off the
    //  edge, and the walk to the mine gave up "stuck x3" at the same pit a dozen times, 2026-10-03)
    return dropAt(p.x, p.y + 1, p.z) > world.SAFE_DROP ? 101 : 0
  })
  // A NODE WHOSE JUMP THE EDGE GUARD REFUSED is no way for a while: the planner planned the same jump past a 21-block drop
  //  again and again, the guard let go of it each time - four minutes at 66,66,9, "no jump toward a 21-block drop" every few
  //  seconds, 2026-10-04 (reflex.noteJump -> refuseNode)
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position || !refusedNodes.size) return 0
    const p = block.position; const t = refusedNodes.get(p.x + ',' + p.y + ',' + p.z)
    return t && Date.now() < t ? 100 : 0
  })
  // Swimming along a surface is fine (the feet in the top water cell, the head in air); a path node with the HEAD
  // under water is how bots drown.
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    const p = block.position
    const head = bot.blockAt(p.offset(0, 1, 0))
    return (head && world.isWaterBlock(head)) ? (dryHead ? 101 : 40) : 0
  })
  // A player keeps off a one-wide way over a drop: a step with a fall that hurts on two sides or more (a wall top, a
  // bridge, a ridge) costs heavily - a way round is taken when there is one. The bot walked home along its own sky
  // bridge 60 over the valley and stepped off its end, 58 blocks (2026-09-25). (Costly, not refused: the builder
  // still works from its own wall tops when nothing else reaches.)
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    const p = block.position
    let sides = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (dropAt(p.x + dx, p.y, p.z + dz, world.SAFE_DROP + 1) > world.SAFE_DROP) sides++
    // (edgeCost: a drop that hurts on ONE side - a wall top's outer face - a little dearer on the site's walks, so a top with
    //  a safe side is stood on from it; a preference, never a refusal; audit 2026-09-29)
    return sides >= 2 ? 30 : sides === 1 ? edgeCost : 0
  })
  // Never under the build: inside its footprint below its base the plaza overhangs the mountainside, a dark hollow
  // full of mobs - walks to the site routed through it, and a creeper there took the iron set with it (the blast
  // destroys what it drops), after a zombie and a skeleton there the night before (2026-09-27).
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    let j = null; try { j = require('./build').getJob() } catch {}
    if (!j || !j.box) return 0
    const p = block.position; const b = j.box
    // (from inside: a small toll, not none - "out soon" stays the preference and the search budget is not blown; audit)
    return (p.x >= b.x1 && p.x <= b.x2 && p.z >= b.z1 && p.z <= b.z2 && p.y < b.y1) ? (startUnder ? 3 : 60) : 0
  })
  // A player walks round a paddock: a walk through the sheep pen opens its gate on the way (the planner opens fence gates)
  // and never shuts it - the flock walks out. Dear, not refused: from inside, the way out is still a way (the pen's own
  // walks pass allowZones 'pen'; a walk that starts inside has the zone allowed by goTo)
  m.exclusionAreasStep.push(block => { if (!block || !block.position || allowed.has('pen')) return 0; const z = inZone(block.position); return z && z.label === 'pen' ? 50 : 0 })
  // A player walks round a field: stepping down onto farmland tramples it back to dirt. The plot sat a block below
  // the path from the safehouse to the furnaces and every trip undid the planting - "4/20 cells planted (1 just
  // now)" every two minutes for an hour (2026-09-23).
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    const below = bot.blockAt(block.position.offset(0, -1, 0))
    return (below && below.name === 'farmland') || /^(wheat|carrots|potatoes|beetroots)$/.test(block.name) ? 25 : 0
  })
  // ONE ANSWER A CELL, a search: the rules above are asked for every neighbour of every node, the same cell over and over -
  // drops scanned down, zones, the build's cells - and the planner ran 620 nodes a second: the way round the pit by the mine
  // (4958 nodes in its 8s) was never found, and every mine walk stood 40-80s at the spur pointing across it, 2026-10-03.
  // Kept for one search, as the rules' own memos are (pathGen: a path reset starts it afresh); the cell's block type is in
  // the key, so a cell that changes is asked anew
  for (const k of ['exclusionStep', 'exclusionBreak', 'exclusionPlace']) {
    const orig = m[k].bind(m); const memo = new Map(); let gen = pathGen
    m[k] = block => {
      if (!block || !block.position) return orig(block)
      if (gen !== pathGen || memo.size > 50000) { memo.clear(); gen = pathGen }
      const p = block.position; const key = p.x + ',' + p.y + ',' + p.z + ',' + (block.stateId != null ? block.stateId : block.type) // (the state: a trapdoor opened is the same type; audit)
      searchProf.exCalls++
      let v = memo.get(key); if (v === undefined) { const te = performance.now(); v = orig(block); searchProf.exMs += performance.now() - te; searchProf.exMiss++; memo.set(key, v) }
      return v
    }
  }
  return m
}

function stopMoving (bot) {
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
}

function goalDistance (bot, goal) {
  const p = bot.entity.position.floored()
  try { return goal.heuristic(p) } catch { return 0 }
}

// Drive one goal until reached / stuck / interrupted / timeout. Never trusts an empty path.
// A closed wooden door the body is up against (within ~1 block of its centre, feet or head level).
function closedDoorAt (bot) {
  const p = bot.entity.position
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const dy of [0, 1]) {
    if (!dx && !dz) continue
    const b = world.at(bot, p.x + dx, p.y + dy, p.z + dz)
    if (!b || !/_door$/.test(b.name) || /iron_door/.test(b.name)) continue
    let open = false; try { const o = b.getProperties().open; open = o === true || o === 'true' } catch {}
    if (open) continue
    if (Math.hypot(b.position.x + 0.5 - p.x, b.position.z + 0.5 - p.z) <= 1.15) return b
  }
  return null
}
function runGoal (bot, goal, { timeoutMs, stuckMs, movements }) {
  try { require('./reflex').resetPlannedPath() } catch {} // (this walk's own path only: a stale one read as "a door on the way"; audit)
  const cancelled = control.token()
  return new Promise(resolve => {
    let done = false
    let best = goalDistance(bot, goal)
    let bestAt = Date.now()
    let noPaths = 0
    const started = Date.now()
    let visited = null // (the planner's search size on a noPath: small = we are shut in, large = the goal is out of reach)
    // (the planner's own account of the stall, taken BEFORE the stop clears it: the give-up line read the body after
    //  stopMoving - "goal none, keys none" on every one of seven 40s stalls in an evening, nothing to go on, 2026-10-03)
    let replans = 0; let lastStatus = ''; let lastLen = 0; let snap = null
    // (and WHY the planner threw its paths away: 107 good paths in 10s, keys none, at the pit by the mine - something resets
    //  each one before a step, 2026-10-03. The pathfinder names its reason)
    let resets = {}
    let lastVisited = null; let lastMs = null; let statusSeen = {} // (the search itself: nodes and ms - a long way round the pit never found in 8s, 2026-10-03)
    const onReset = why => { resets[why] = (resets[why] || 0) + 1 }
    const snapshot = () => { try { const cs = bot.controlState || {}; const g = bot.pathfinder.goal; const me = bot.entity.position; const n = (() => { try { return require('./reflex').plannedNode() } catch { return null } })(); return `planner: goal ${g ? 'set' : 'none'}, moving ${bot.pathfinder.isMoving()}, keys ${Object.keys(cs).filter(k => cs[k]).join('+') || 'none'} (sneak ${!!cs.sneak}), at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} next ${n ? n.x + ',' + n.y + ',' + n.z : '-'}, onGround ${bot.entity.onGround}, ${replans} replans since the last progress, last ${lastStatus || '-'} ${lastLen} nodes, ${(goalDistance(bot, goal)).toFixed(1)} from the goal (best ${best.toFixed(1)}), resets ${JSON.stringify(resets)}, search ${lastVisited} nodes ${lastMs}ms, statuses ${JSON.stringify(statusSeen)}, prof exclusion ${Math.round(searchProf.exMs)}ms ${searchProf.exMiss}/${searchProf.exCalls} misses, getBlock ${Math.round(searchProf.gbMs)}ms x${searchProf.gbCalls}` } catch { return '' } }
    const finish = (ok, why) => {
      if (done) return
      done = true
      clearInterval(timer)
      bot.removeListener('goal_reached', onReached)
      bot.removeListener('path_update', onPath)
      bot.removeListener('death', onDeath)
      bot.removeListener('path_reset', onReset)
      if (!ok || why !== 'reached') stopMoving(bot)
      resolve(visited != null && why === 'noPath' ? { ok, why, visited } : snap ? { ok, why, snap } : { ok, why })
    }
    const onReached = () => { if (arrived(bot, goal)) finish(true, 'reached') }
    // NO PATH IS A VERDICT: the search ran out of options. The planner hands back a path to its closest node all the same,
    // and walked, it ended "stuck" 8-30s later - 302 stuck, 0 noPath in four days of castle walks, every caller unable to
    // tell "no way there" from "the body could not" (2026-10-02). Only a search cut short (partial) walks on; noPaths kept
    // for the empty-path case it always handled
    const onPath = r => {
      if (r.status === 'noPath') {
        visited = r.visitedNodes != null ? r.visitedNodes : null
        if (!arrived(bot, goal) && (r.path.length > 0 || ++noPaths >= 3)) finish(false, 'noPath')
        // (an EMPTY noPath is not asked again by the planner: it sat with the goal set, not moving, no further update, and the
        //  walk waited out the stall clock - 10s a try, three tries a give-up, 40s a walk at the pit by the mine, 2026-10-03.
        //  The three-empty-answers verdict above asks for itself: the same goal again, a moment on)
        else if (!r.path.length && !done) setTimeout(() => { if (!done && !arrived(bot, goal) && !cancelled() && !reflexActive() && bot.pathfinder.goal === goal) { try { bot.pathfinder.setGoal(goal) } catch {} } }, 400) // (only while the goal is still ours: a reflex's flight cleared it; audit)
      } else if (r.path.length) noPaths = 0
      replans++; lastStatus = r.status; lastLen = r.path.length
      if (r.visitedNodes != null) { lastVisited = r.visitedNodes; lastMs = r.time != null ? Math.round(r.time) : null; statusSeen[r.status] = (statusSeen[r.status] || 0) + 1 }
    }
    const onDeath = () => finish(false, 'died')
    let doorAt = 0
    const timer = setInterval(() => {
      if (!bot.entity) return finish(false, 'died')
      // walking into a closed door (the plan goes through doors now): open it, as a player does
      if (Date.now() - doorAt > 1200) { const dd = closedDoorAt(bot); if (dd) { doorAt = Date.now(); bot.activateBlock(dd).catch(() => {}) } }
      if (arrived(bot, goal)) return finish(true, 'reached')
      if (cancelled()) return finish(false, 'stopped')
      if (reflexActive()) return finish(false, 'interrupted')
      const d = goalDistance(bot, goal)
      const busy = bot.pathfinder.isMining() || bot.pathfinder.isBuilding()
      if (d < best - 0.9 || busy) { if (d < best) best = d; bestAt = Date.now(); replans = 0; resets = {}; statusSeen = {} }
      if (Date.now() - bestAt > stuckMs) { snap = snapshot(); return finish(false, 'stuck') }
      if (Date.now() - started > timeoutMs) return finish(false, 'timeout')
    }, 250)
    bot.on('goal_reached', onReached)
    bot.on('path_update', onPath)
    bot.on('death', onDeath)
    bot.on('path_reset', onReset)
    searchProf.reset()
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.setGoal(goal)
  })
}

async function waitReflex (bot, maxMs = 60000) {
  const t0 = Date.now()
  while (reflexActive() && Date.now() - t0 < maxMs) await sleep(250)
}
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }
// (arrived: the floored cell or the cell stood in over a slab or stair - the pathfinder's own two (index.js:593): judged
//  on the floored cell alone, a stand over a half block was never reached, 2026-10-03)
// (never for a goal of being OUT of somewhere - GoalInvert: "out of the stand OR out of the floored cell" read a body on a
//  carpet in the cell it must leave as out already, and the step aside before a place never walked; audit 2026-10-03)
function arrived (bot, goal) { const f = bot.entity.position.floored(); return goal instanceof goals.GoalInvert ? goal.isEnd(f) : (goal.isEnd(world.standCell(bot)) || goal.isEnd(f)) }

// Get out of a spot the planner keeps failing from: step back, jump, or tower one block.
// (only a way that is not over a drop: a random key and a jump at the castle's south rim - a strafe, which neither the jump
//  guard's heading nor the edge brake reads, and a brake that lets go in the air - fell 5 blocks twice, 2026-09-28. The
//  keys are the body's own frame: forward along the look, left and right across it. No safe way, no jiggle)
// (the keys a jiggle may press: each heading's next 1.6 blocks no drop past SAFE_DROP - THE rule the jiggle and the escape's
//  "stranded on our own blocks" both read)
function safeJiggles (bot) {
  const e = bot.entity; const p = e.position
  const fx = -Math.sin(e.yaw); const fz = -Math.cos(e.yaw)
  const vec = { forward: [fx, fz], back: [-fx, -fz], left: [fz, -fx], right: [-fz, fx] }
  const y = Math.floor(p.y + 0.01)
  return Object.keys(vec).filter(k => [0.8, 1.6].every(r => world.dropAt(bot, p.x + vec[k][0] * r, y, p.z + vec[k][1] * r) <= world.SAFE_DROP))
}
async function jiggle (bot) {
  const p = bot.entity.position
  const safe = safeJiggles(bot)
  if (!safe.length) { log('move', `stuck at ${fmt(p)} - no way to jiggle that is not over a drop`); await sleep(500); return }
  const d = safe[Math.floor(Math.random() * safe.length)]
  bot.setControlState(d, true); bot.setControlState('jump', true)
  await sleep(700)
  bot.clearControlStates()
  await sleep(200)
}

// Doors the planner will not open reliably on this server: open it, walk through toward the goal
// side, close it behind. Returns true if we ended up on the other side.
async function crossDoor (bot, goal) {
  // inside the safehouse the door is known: walk to the step in front of it first
  const hp = require('./memory').get().hutPlan
  // a door hung facing along the wall blocks the way when open: hang it right first
  if (hp && hp.door && hp.home && world.dist3(bot.entity.position, { x: hp.door.x, y: hp.home.y, z: hp.door.z }) < 5) {
    try { if (require('./hut').doorFacingWrong(bot)) await require('./hut').rehangDoor(bot) } catch (e) { log('move', 'rehang threw: ' + e.message) }
  }
  // the night's block on the door step (or an old walled-up doorway) comes out first
  if (hp && hp.door && hp.home && world.dist3(bot.entity.position, { x: hp.door.x, y: hp.home.y, z: hp.door.z }) < 5) {
    await require('./hut').unsealDoor(bot).catch(e => log('move', 'unseal threw: ' + e.message))
  }
  if (hp && hp.door && insideHut(bot.entity.position.floored())) {
    const d0 = hp.door
    const inner = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: d0.x + dx, y: hp.home.y, z: d0.z + dz })).find(c => insideHut(c))
    // (height counts: standing on the furnace beside the step is not standing on the step - that
    //  skipped the step and "door crossing did not get through" for minutes)
    if (inner && (Math.hypot(bot.entity.position.x - (inner.x + 0.5), bot.entity.position.z - (inner.z + 0.5)) > 0.6 || Math.abs(bot.entity.position.y - inner.y) > 0.4)) {
      await runGoal(bot, new goals.GoalBlock(inner.x, inner.y, inner.z), { timeoutMs: 6000, stuckMs: 3000, movements: movementsFor(bot, { dig: false, place: false }) })
    }
  }
  const me = bot.entity.position
  let door = null
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [-1, 0, 1]) {
    const b = world.at(bot, me.x + dx, me.y + dy, me.z + dz)
    if (b && /_door$/.test(b.name) && !/iron_door/.test(b.name)) {
      let lower = b
      try { if (b.getProperties().half === 'upper') lower = world.at(bot, b.position.x, b.position.y - 1, b.position.z) } catch {}
      if (lower && (!door || lower.position.distanceTo(me) < door.position.distanceTo(me))) door = lower
    }
  }
  if (!door) return false
  const d = door.position
  let facing = 'north'
  try { facing = door.getProperties().facing || 'north' } catch {}
  // the two cells either side of the door, along its facing axis - for the safehouse door the wall it sits
  // in decides (a door hung again after the night faced along the wall, and the "exit" was the wall itself)
  let axisX = facing === 'east' || facing === 'west'
  if (hp && hp.door && hp.interior && d.x === hp.door.x && d.z === hp.door.z) axisX = hp.door.x < hp.interior.x1 || hp.door.x > hp.interior.x2
  // (a side's step where a body stands - the door's level, else one up or one down: a room whose floor is not laid yet has
  //  its ground a block higher than the doorway, and the "step in front" at the door's level was solid grass - the walk
  //  to it failed every time, the night spent at that door, 2026-09-29)
  // (and FIRST: natural ground standing in a cell of the build at the doorway's level - the room's carpet cell full of
  //  grass - is an obstruction the builder clears anyway: dug, the doorway is level. A jump up a block under the door's
  //  lintel does not clear it; the step up stays for a floor the design raises; audit)
  const obstruction = (x, y, z) => {
    const b = world.at(bot, x, y, z); if (!b || !world.isSolid(b) || !world.NATURAL_RE.test(b.name)) return false
    const bj = require('./build'); const j = bj.getJob(); const c = j && j.index.get(`${x},${y},${z}`)
    // (and at a door OF OUR BUILD, natural ground on its doorstep in a cell with no entry: the design put a door here, so
    //  its steps must be clear - a door whose foot is level with the ground cannot be used otherwise. Never "no entry =
    //  design air" in general: the site clearing leaves the box's bottom layer as terrain on purpose. Grass at the castle
    //  door's level, a stair over it, "nowhere to stand" every 11s, 2026-09-30; audit)
    if (!c) { const dc = j && j.index.get(`${d.x},${d.y},${d.z}`); const bx = j && j.box; return !!dc && !dc.clear && !!bx && x >= bx.x1 && x <= bx.x2 && z >= bx.z1 && z <= bx.z2 }
    return !c.clear && !bj.partOk(c, b.name)
  }
  const act = require('./act')
  for (const [x, z] of axisX ? [[d.x - 1, d.z], [d.x + 1, d.z]] : [[d.x, d.z - 1], [d.x, d.z + 1]]) {
    for (const dy of [1, 0]) if (obstruction(x, d.y + dy, z)) { log('move', `the doorway at ${fmt(d)}: ${world.at(bot, x, d.y + dy, z).name} stands in a cell of the build at ${x},${d.y + dy},${z} - clearing it`); await act.dig(bot, { x, y: d.y + dy, z }, { allowZones: ['build', 'base'], timeoutMs: 8000 }).catch(() => false) }
  }
  // (a side stands by the walk's own model too - rooms.walkModel: a cell with an open trapdoor at the feet, its panel on
  //  a far edge, is a stand the planner and the way-out search both use; read by standable alone, a castle door beside one
  //  had "nowhere to stand" and was refused every walk, 2026-09-30. The step from the door cell into it must not cross a
  //  panel - next() holds the edge rules; audit)
  const wm = require('./build').walkModel(bot)
  const dCell = { x: d.x, y: d.y, z: d.z }
  const reachStand = p => wm.st(p.x, p.y, p.z) && wm.next(dCell).some(q => q.x === p.x && q.y === p.y && q.z === p.z) // (see stepAt)
  const standsAt = p => world.standable(bot, p.x, p.y, p.z) || reachStand(p)
  // (the side's step by the walk model's next() first - any drop it allows (to SAFE_DROP, column open): a room whose floor is
  //  not laid yet is a drop into its hollow, and the fixed dy 0/+1/-1 refused a door the planner rightly routed through,
  //  every 11s, 2026-09-30; audit)
  const doorNext = wm.next(dCell)
  const stepAt = (x, z) => { const q = doorNext.find(n => n.x === x && n.z === z); if (q) return q; for (const dy of [0, 1, -1]) if (standsAt({ x, y: d.y + dy, z })) return { x, y: d.y + dy, z }; return { x, y: d.y, z } }
  const sideA = axisX ? stepAt(d.x - 1, d.z) : stepAt(d.x, d.z - 1)
  const sideB = axisX ? stepAt(d.x + 1, d.z) : stepAt(d.x, d.z + 1)
  // (a door with no place to stand on one side - a castle door opening onto a rail of open trapdoors on edge - leads
  //  nowhere: 40s a try walking to a step that is not there, 2026-09-29. Not this door; the stall looks elsewhere)
  // (never the safehouse's own night seal - its step blocked on purpose, opened by unsealDoor above: exempt; audit)
  const sealed = p => ((require('./memory').get().doorSeal || {}).cells || []).some(c => c.x === p.x && c.z === p.z && (c.y === p.y || c.y === p.y + 1))
  { const noStep = [sideA, sideB].find(p => !standsAt(p) && !sealed(p)); if (noStep) { for (const dy of [0, 1]) refusedDoors.set(`${d.x},${d.y + dy},${d.z}`, { door: { x: d.x, y: d.y, z: d.z }, side: { x: noStep.x, z: noStep.z } }); log('move', `the door at ${fmt(d)} has nowhere to stand on its side at ${fmt(noStep)} - not through this one`); return false } }
  const gp = goal && goal.x != null ? { x: goal.x, z: goal.z } : null
  const distTo = (s, p) => Math.hypot(s.x + 0.5 - p.x, s.z + 0.5 - p.z)
  // the exit is the side toward the goal; without a goal, the side away from us
  const onA = distTo(sideA, me) < distTo(sideB, me)
  let exit = gp ? (distTo(sideA, gp) < distTo(sideB, gp) ? sideA : sideB) : (onA ? sideB : sideA)
  // the safehouse door: inside -> the exit is the outside step, whatever direction the goal lies in
  // (a goal east of a west-facing door picked the INSIDE step as the "exit" and never left);
  // outside with a goal inside -> the inside step
  const inA = insideHut(sideA); const inB = insideHut(sideB)
  if (inA !== inB) {
    const meIn = insideHut(me.floored())
    const goalIn = gp ? insideHut({ x: goal.x, y: goal.y != null ? goal.y : Math.floor(me.y), z: goal.z }) : false // (an x/z goal at our own height: audit)
    if (meIn) exit = inA ? sideB : sideA
    else if (goalIn) exit = inA ? sideA : sideB
    // (standing IN the doorway - the door cell is in the wall, neither inside nor out - with the door shut in front: the
    //  goal's side is the exit; read as "outside, goal outside" the crossing was refused and the walk stalled 33s at
    //  its own door twice a day, 2026-10-06)
    else if (Math.floor(me.x) === d.x && Math.floor(me.z) === d.z) exit = inA ? sideB : sideA
    // outside with the goal outside too: the hut is not on the way. (The "side toward the goal" of a west door
    // with the goal to the east is the INSIDE step: every stall beside the hut crossed in, the next walk crossed
    // out again - in/out for 90s on each trip east, 2026-09-22)
    else return false
  }
  if (distTo(exit, me) < 0.8) return false // already through: this stall is not about the door
  // not standing on the near-side step yet (coming at the hut from its side): walk to that step first
  const entry = exit === sideA ? sideB : sideA
  if (Math.hypot(me.x - (entry.x + 0.5), me.z - (entry.z + 0.5)) > 1.2 || Math.abs(me.y - entry.y) > 0.4) {
    let r0 = await runGoal(bot, new goals.GoalBlock(entry.x, entry.y, entry.z), { timeoutMs: 15000, stuckMs: 5000, movements: movementsFor(bot, { dig: false, place: false }) })
    // broken ground round the hut (holes, a stray block): allowed to step up or fill a hole the second time
    if (!r0.ok) r0 = await runGoal(bot, new goals.GoalBlock(entry.x, entry.y, entry.z), { timeoutMs: 20000, stuckMs: 6000, movements: movementsFor(bot, { dig: true, place: true, allowZones: ['base'] }) })
    if (!r0.ok) { log('move', `couldn't reach the step in front of the door at ${fmt(d)} (${r0.why})`); return false }
  }
  log('move', `crossing the door at ${fmt(d)} toward ${fmt(exit)}`)
  const isOpen = () => { try { return !!world.at(bot, d.x, d.y, d.z).getProperties().open } catch { return false } }
  if (!isOpen()) { try { await bot.activateBlock(world.at(bot, d.x, d.y, d.z)); await sleep(300) } catch {} }
  if (!isOpen()) { try { await bot.lookAt(d.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(world.at(bot, d.x, d.y, d.z)); await sleep(400) } catch {} }
  // walk: door cell centre, then the exit cell centre
  for (const t of [{ x: d.x, z: d.z }, exit]) {
    const t0 = Date.now()
    while (Date.now() - t0 < 2500) {
      const p = bot.entity.position
      const tx = t.x + 0.5; const tz = t.z + 0.5
      if (Math.hypot(p.x - tx, p.z - tz) < 0.3) break
      await bot.look(Math.atan2(-(tx - p.x), -(tz - p.z)), 0, true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('jump', t.y != null && t.y > Math.floor(p.y + 0.01)) // (a step up on the far side: the unfinished room's ground)
      await sleep(50)
    }
    bot.setControlState('forward', false); bot.setControlState('jump', false)
  }
  const passed = Math.hypot(bot.entity.position.x - (exit.x + 0.5), bot.entity.position.z - (exit.z + 0.5)) < 0.9
  if (passed && isOpen()) { try { await bot.activateBlock(world.at(bot, d.x, d.y, d.z)) } catch {} } // close it behind us
  log('move', `door crossing ${passed ? 'done' : 'did not get through'}`)
  lastCross = passed ? `${d.x},${d.y},${d.z}>${exit.x},${exit.z}` : null
  return passed
}
let lastCross = null // the last crossing that got through: door > exit (goTo counts repeats - a crossing is progress once)

// goTo(goal): the one way to walk somewhere nearby (<~100 blocks). Retries through reflex
// interruptions and short stalls. Returns {ok, why}.
// the same walk asked for again and again is a loop somewhere above us: say so (a bot pacing a
// tunnel for minutes logged nothing at all)
const recentWalks = new Map()
const labelWalks = new Map() // label -> walks this minute and their distinct targets (the coarse net)
function noteWalk (label, goal) {
  if (label === 'mine step' || label === 'to tree') return // one per block of tunnel / per tree felled: many a minute is the job
  const now = Date.now()
  // (a loop is the same walk to the SAME place again and again: keyed by label alone, thirteen walks to thirteen farm
  //  cells - the job - read as "looping", and the regression counts could not tell work from a stuck task; 2026-09-27)
  let at = ''
  try { at = goal.x != null ? `${Math.floor(goal.x)},${goal.y != null ? Math.floor(goal.y) : '-'},${Math.floor(goal.z)}` : (goal.pos ? fmt(goal.pos) : '') } catch {}
  // (and a coarse net per label: a livelock that picks a NEW place each time - the next refused ore, the next chest that
  //  will not open, a leg bent each try - never repeats a target; 30+ walks a minute says so, with how many distinct)
  const c = labelWalks.get(label) || { n: 0, since: now, warned: 0, at: new Set() }
  if (now - c.since > 60000) { c.n = 0; c.since = now; c.at = new Set() }
  c.n++; c.at.add(at); labelWalks.set(label, c)
  if (labelWalks.size > 100) for (const [kk, cc] of labelWalks) if (now - cc.since > 600000) labelWalks.delete(kk) // (template labels - one per area or job: idle ones go)
  if (c.n > 30 && now - c.warned > 60000) { c.warned = now; log('move', `busy or looping: "${label}" walked ${c.n} times in a minute to ${c.at.size} distinct places`) }
  const k = label + '@' + at
  const r = recentWalks.get(k) || { n: 0, since: now, warned: 0 }
  if (now - r.since > 60000) { r.n = 0; r.since = now }
  r.n++
  recentWalks.set(k, r)
  if (recentWalks.size > 300) for (const [kk, rr] of recentWalks) if (now - rr.since > 60000) recentWalks.delete(kk) // (a key per place: old ones go)
  if (r.n > 6 && now - r.warned > 60000) {
    r.warned = now
    let where = ''
    try { where = goal.x != null ? `${goal.x},${goal.y},${goal.z}` : (goal.pos ? fmt(goal.pos) : goal.constructor.name) } catch {}
    log('move', `walk "${label}" asked ${r.n} times in a minute (target ${where}) - something is looping`, new Error().stack.split(String.fromCharCode(10)).slice(2, 6).map(l => l.trim().replace(/^at /, '')).join(' <- '))
  }
}
async function goTo (bot, goal, opts = {}) {
  const { timeoutMs = 60000, stuckMs = 10000, dig = true, place = true, allowZones = [], label = 'go', shouldStop, dryHead = true } = opts
  noteWalk(label, goal)
  // the safehouse has one way in: a walk between inside and outside goes through the door first (the planner
  // never routes through it, and a walk to the chest from outside the back wall timed out for 46s a go)
  try {
    const gp = goal && goal.x != null && goal.z != null ? { x: Math.floor(goal.x), y: Math.floor(goal.y != null ? goal.y : bot.entity.position.y), z: Math.floor(goal.z) } : null
    const meIn = insideHut(bot.entity.position.floored())
    // deep under a goal that is up on the surface: climb out first - walks at the hut door from a cave 21
    // blocks below it timed out one after another for six minutes
    if (gp && gp.y - bot.entity.position.y > 8 && label !== 'surface' && label !== 'out of the mine' && label !== 'back to mine face' && label !== 'to mine face' && isUnderground(bot)) await surface(bot, { shouldStop: opts.shouldStop })
    if (gp && label !== 'to the safehouse door' && label !== 'beside the hole') {
      if (!meIn && insideHut(gp)) await require('./hut').enterHut(bot, { shouldStop: opts.shouldStop })
      else if (meIn && !insideHut(gp)) await crossDoor(bot, goal).catch(() => false)
    }
  } catch (e) { log('move', 'door routing threw: ' + e.message) }
  const t0 = Date.now()
  const r = await goToInner(bot, goal, opts, { timeoutMs, stuckMs, dig, place, allowZones, label, shouldStop, dryHead })
  const took = Date.now() - t0
  if (took > 30000) log('move', `${label}: ${r.ok ? 'arrived' : r.why} after ${Math.round(took / 1000)}s at ${fmt(bot.entity && bot.entity.position)}`)
  return r
}
const ENCLOSED_NODES = 400 // a search that visited more than this many cells was not shut in
async function goToInner (bot, goal, opts, a) {
  const start = bot.entity ? bot.entity.position.clone() : null
  const r = await goToInner2(bot, goal, opts, a)
  // a walk that ended where it began, stuck or out of time: a give-up from this cell (the pit under the farm held the
  // bot through walks that all ran out their time - "timeout" never counted, and it stood there another hour)
  // (below a build's floor inside its footprint ONE such walk is enough: the hollow's give-ups drift a cell each - -607,
  //  -606, -605 - the same-cell count never reached two, and the bot missed its bed and dug in under the castle, 2026-09-29)
  // (every give-up is recorded where it happened - the count by place is the evidence: "ended where it began" (< 2) missed
  //  the pocket's shuffle, a leg from -584 giving up at -582 by exactly 2, and the third give-up never reached the escape,
  //  2026-09-29. Below the floor, one is enough only where the walk began)
  // (a noPath whose search went wide is a verdict on the GOAL, not on this place: unreachable cells tried from one spot in
  //  the castle counted as give-ups here, and two of them would climb out or open our own wall; audit. A narrow search -
  //  the planner shut in - still counts)
  // (but never inside the build's footprint with no way out by the walk model: a big closed hall holds more than 400 cells, and
  //  the enclosed break-out was built for exactly that; audit)
  let goalOnly = r.why === 'noPath' && r.visited != null && r.visited > ENCLOSED_NODES
  if (goalOnly && bot.entity) {
    try {
      const bj = require('./build'); const j = bj.getJob(); const f0 = bot.entity.position.floored()
      const inFoot = j && f0.x >= j.box.x1 && f0.x <= j.box.x2 && f0.z >= j.box.z1 && f0.z <= j.box.z2
      if (inFoot && !bj.wayOut(bot, { x: NaN, y: NaN, z: NaN }, null, false)) goalOnly = false
    } catch {}
  }
  // THE PLACE, NOT THE GOALS: a walk that fails at once (instant noPath, three times over) is noted by where it stood and
  // where it went. Walks to TWO different goals failing at once from one place is the body stuck there - every chest, home,
  // the trees and explore "stuck ... (noPath)" every 2s from a scaffold top with gaps under it and from a ledge outside the
  // castle wall, the escape never asked, 2026-10-06 22:08 - and the escape runs whatever the search's width said
  const placeStuck = !r.ok && r.instant && bot.entity ? noteInstant(bot, goal) : 0
  if (placeStuck && !escaping) log('move', `every walk fails at once from ${fmt(bot.entity.position)} (${placeStuck} goals) - the place is stuck, not the goals: the escape`)
  if (!r.ok && start && bot.entity && /stuck|timeout|noPath/.test(r.why) && (!goalOnly || placeStuck)) {
    const again = stuckHereAgain(bot)
    if (again || placeStuck || (underBuildFloor(bot) && bot.entity.position.distanceTo(start) < 2)) await escapeUp(bot)
  }
  // (a walk that ARRIVED from here proves the spot no trap: its give-ups go - left on the books, the next ordinary give-up
  //  near a door the bot walked out of fine counted a trap and broke our wall; audit)
  // (only a walk that LEFT: the escape's own step aside arrives too - a clear there was the same loop again; and a walk
  //  that ends beside its start proves nothing; audit)
  if (r.ok && start && giveUps.length && !escaping && bot.entity && bot.entity.position.distanceTo(start) > GIVEUP_NEAR + 1) clearGiveUps(start.floored())
  // (and a remembered trap a walk just LEFT is no trap: forgotten - a false one, recorded before the search read trapdoors
  //  as edges, lay on the inner doorway's path, 50 a step and legs pushed round it for a day; audit)
  if (r.ok && start && !escaping && bot.entity && bot.entity.position.distanceTo(start) > GIVEUP_NEAR + 1) {
    // (only a walk that began IN it - the start on one of its cells, a step aside allowed: one that began BESIDE it and went
    //  on is the walk the trap's cost steers, and forgot a real one never entered; that trap's own cells only; audit)
    const s0 = start.floored(); const mm = require('./memory'); const l = mm.get().trapCells || []
    // (and not while a hole our escape opened out of it still stands open: the walk went out through it, not a real exit)
    const openStill = t => (t.opened || []).some(o => world.isAirish(world.at(bot, o.x, o.y, o.z)))
    const batches = new Set(l.filter(t => Math.abs(t.x - s0.x) <= 1 && Math.abs(t.y - s0.y) <= 1 && Math.abs(t.z - s0.z) <= 1 && !openStill(t)).map(t => t.batch != null ? t.batch : 'x' + t.x + ',' + t.y + ',' + t.z))
    if (batches.size) { mm.update(m => { m.trapCells = (m.trapCells || []).filter(t => !batches.has(t.batch != null ? t.batch : 'x' + t.x + ',' + t.y + ',' + t.z)) }); log('move', `walked out of the trap remembered at ${fmt(s0)} - forgotten`) }
  }
  return r
}
async function goToInner2 (bot, goal, opts, { timeoutMs, stuckMs, dig, place, allowZones, label, shouldStop, dryHead }) {
  // (time the reflexes hold the body is not the walk's time: a fight past the deadline turned into a "timeout" verdict on
  //  the goal - the deadline moves on by every wait; audit)
  // (bounded: at most twice the walk's own time added - a reflex that held on through every wait made one 30s walk forty
  //  minutes; audit)
  let deadline = Date.now() + timeoutMs
  let extraLeft = 2 * timeoutMs
  const waitR = async () => { const t = Date.now(); await waitReflex(bot); const w = Math.min(Date.now() - t, extraLeft); extraLeft -= w; deadline += w }
  const cancelled = control.token()
  let fails = 0
  const crossed = new Map() // door crossings this walk (see the stall branch)
  let interrupts = 0
  let instant = 0
  while (Date.now() < deadline) {
    // (a turn for the event loop every round: a plan that fails at once - 'interrupted' back to back, a goal with no way -
    //  went round on resolved promises and held the loop 10.9s picking up a boat; the stall watch named this loop, 2026-09-28)
    await new Promise(resolve => setImmediate(resolve))
    if (!bot.entity) return { ok: false, why: 'no body' }
    if (cancelled()) return { ok: false, why: 'stopped' }
    if (arrived(bot, goal)) return { ok: true, why: 'reached' }
    if (shouldStop && shouldStop()) return { ok: false, why: 'stopped' }
    await waitR()
    // you may always work your way out of where you stand: inside the castle walls a walk to the furnace
    // could not scaffold over them (the build zone was off limits) and timed out for minutes
    // (finished build blocks stay unbreakable - the protector guards them in every zone)
    // (and a zone right overhead: in a shaft under the castle's footprint, the way out runs up through the zone's first
    //  layers - forbidden, the bot went up and down its night hole for 10 minutes, 2026-09-27)
    const fp = bot.entity.position.floored()
    // (only when roofed in: under the footprint in the open - a mine far below, the yard - unlocks nothing; audit #42)
    const here = inZone(fp) || (!world.openSky(bot, fp) && underZone(fp)) || null
    const zonesOk = here && !allowZones.includes(here.label) ? allowZones.concat([here.label]) : allowZones
    const tRun = Date.now(); const pRun = bot.entity.position.clone()
    // (opts.movements: a walk with its own rules - the build site's - still gets every recovery here; build.goSite)
    const r = await runGoal(bot, goal, { timeoutMs: Math.max(2000, deadline - Date.now()), stuckMs, movements: opts.movements ? opts.movements() : movementsFor(bot, { dig, place, allowZones: zonesOk, dryHead }) })
    if (r.ok) return r
    // (a plan that failed at once, going nowhere, three times over from here: a verdict, not bad luck - said, not cycled
    //  to the deadline; audit 2026-09-28)
    // (an interruption is the reflex taking the body - a fight, the edge brake - never a verdict on the way: counted here
    //  one fight by a known tree read "noPath" and the tree was forgotten; audit 2026-09-28)
    if (r.why !== 'interrupted' && Date.now() - tRun < 120 && bot.entity.position.distanceTo(pRun) < 0.1) { if (++instant >= 3) return Object.assign({}, r, { ok: false, why: r.why || 'noPath', instant: true }) } else if (r.why !== 'interrupted') instant = 0
    if (r.why === 'died') return r
    if (r.why === 'interrupted') { if (++interrupts > 20) return { ok: false, why: 'interrupted' }; await waitR(); continue } // (the body is busy: wait for the reflex, then go on - "interrupted", never "blocked")
    if (r.why === 'timeout') return r
    fails++
    // a stall next to a door is a door the planner would not open: cross it by hand
    // (a crossing is progress ONCE: the same door crossed the same way again in one walk is the stall beyond it, not the door
    //  - "crossing done" every 12s for a minute at a castle door over a pit, the walk's fails reset each time, 2026-10-02)
    // (only a door ON the way: the planner's next steps go through it. Any door within three of a stall was crossed or walked
    //  to - "couldn't reach the step in front of the door" 11 times an evening, 10-25s each inside a 30s site walk, at doors
    //  the path never used; 2026-10-02 analysis)
    // (and a stall IN the doorway - the door's node already passed - or at the safehouse's own door, inside to out: audit)
    const onRoute = (() => { try { const isDoor = b => !!b && /_door$/.test(b.name) && !/iron_door/.test(b.name); const ps = (require('./reflex').plannedPath() || []).slice(0, 6); if (ps.some(n => isDoor(world.at(bot, Math.floor(n.x), Math.floor(n.y), Math.floor(n.z))))) return true; const f = bot.entity.position.floored(); for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const dy of [0, 1]) if (isDoor(world.at(bot, f.x + dx, f.y + dy, f.z + dz))) return true; return !!(goal && goal.x != null && insideHut(f) !== insideHut({ x: goal.x, y: goal.y, z: goal.z })) } catch { return true } })()
    if (onRoute && await crossDoor(bot, goal).catch(e => { log('move', `door crossing threw: ${e.message}`); return false })) {
      const n = (crossed.get(lastCross) || 0) + 1; crossed.set(lastCross, n)
      if (n === 1) { fails = 0; continue }
      if (n === 2) log('move', `${label}: through the door ${lastCross.split('>')[0]} the same way again - the stall is past it, not at it`)
    }
    // (a wide noPath - the goal is out of reach, not we shut in - is the same search from the same place again: the walk
    //  ends here once the door crossing had its chance; audit)
    if (r.why === 'noPath' && r.visited != null && r.visited > ENCLOSED_NODES) return r
    if (fails >= 3) {
      // (what the body was holding when it gave up - the goal, the planner, the keys, the reflex: sealed in the hollow, every
      //  walk "stuck x3" for five minutes and one pause/resume later the same walk went straight out; something was stale,
      //  and the lines said nothing of it, 2026-09-28)
      let why2 = ''
      try {
        const g = bot.pathfinder.goal; const cs = bot.controlState || {}
        const keys = Object.keys(cs).filter(k => cs[k]).join('+') || 'none'
        const rf = require('./reflex').info()
        // (and the step the planner meant next, with what stands at it - feet, head, floor: stuck walks at the castle's walls
        //  said nothing of what the body could not do, 2026-09-29)
        const rx = require('./reflex'); const n = rx.plannedNode && rx.plannedNode()
        const at = n ? ['feet', 'head', 'floor'].map((w, i) => { const b = world.at(bot, Math.floor(n.x), Math.floor(n.y) + [0, 1, -1][i], Math.floor(n.z)); return w + ' ' + (b ? b.name : '?') }).join(', ') : ''
        why2 = ` [goal ${g ? g.constructor.name + (g.x != null ? ' ' + g.x + ',' + g.y + ',' + g.z : '') : 'none'}, moving ${bot.pathfinder.isMoving()}, keys ${keys}, reflex ${rf ? rf.kind + ' ' + rf.forSec + 's' : 'none'}, onGround ${bot.entity.onGround}, sneak ${!!(bot.controlState && bot.controlState.sneak)};${rx.plannedStep ? rx.plannedStep() : ''}${at ? ' (' + at + ')' : ''}]`
      } catch {}
      log('move', `${label}: gave up (${r.why} x${fails}) at ${fmt(bot.entity.position)}${why2}${r.snap ? ' {' + r.snap + '}' : ''}`)
      return r
    }
    await jiggle(bot)
  }
  return { ok: false, why: 'timeout' }
}

// THE rule for a failed walk: a verdict on the way (forget the place, mark it unreachable) - or only busy? An interruption
// is the reflex taking the body, a stop is the caller's, a death is a death: none of them says anything about the place.
// One fight near a known tree erased it from memory (audit 2026-09-28); every store that forgets on a failed walk asks here.
function isVerdict (r) { return !!r && !r.ok && !/interrupt|stopped|died/.test(r.why || '') }
function fmt (p) { return p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?' }

// STUCK IN ONE PLACE: every walk giving up from the same cell, task after task. A hole under the farm, flowing water at
// the feet and the soil for a ceiling, held the bot for forty minutes - no walk could plan the way out and each gave
// up and the next task tried again (2026-09-25). The second give-up in five minutes from the same cell: climb straight
// out, the way a player does - dig what is over the head (never a finished build block: act.dig guards those) and
// tower up on whatever filler the pack holds, until there is open sky over us.
// (give-ups by PLACE, not by cell: a trapped bot steps aside a block after each, and keyed by its exact cell the count
//  spread over three cells and never reached two - nor did a step aside ever mean out: it wiped the count, give up,
//  step aside, give up, eleven times in a one-high crawlspace, 2026-09-29. Counted within 2 blocks over 5 minutes;
//  cleared only by a real way out - through our wall, or climbed out)
const giveUps = [] // [{ x, y, z, t }]
const GIVEUP_NEAR = 2
function giveUpsNear (p, now = Date.now()) { return giveUps.filter(g => now - g.t < 5 * 60000 && Math.abs(g.x - p.x) <= GIVEUP_NEAR && Math.abs(g.y - p.y) <= GIVEUP_NEAR && Math.abs(g.z - p.z) <= GIVEUP_NEAR).length }
// A TRAP REMEMBERED: where an escape had to break out or climb out, the give-ups round it are a pocket - a day's hazard,
// dear to walk through and never a leg's point (a player stuck in a crawlspace walks round it next time; audit)
// (its life is the game's day - day.js, as every day rule: the rest of today and tomorrow; audit)
const refusedDoors = new Map() // door cell key -> { door, side }: crossDoor's refusals - a cost to the walk while the side still fails
// (still failing = the walk model has no step from the door cell onto that side's column - re-read each plan, not a timer:
//  the room's floor laid, the cost goes with the next plan; audit)
function doorStillRefused (bot, e) {
  const wm = require('./build').walkModel(bot)
  if (wm.next(e.door).some(q => q.x === e.side.x && q.z === e.side.z)) return false
  for (const dy of [0, 1, -1]) if (world.standable(bot, e.side.x, e.door.y + dy, e.side.z)) return false
  return true
}
const trapLive = (bot, t) => { try { return require('./day').dayNo(bot) - t.day <= 1 } catch { return false } }
let legSaid = null
// (the cells an escape opened in our own wall, this escape: a walk out through them proves nothing of the trap - the
//  builder closes them on its next pass and the pocket catches the bot again; 2026-09-30 audit)
let escOpened = []
function noteTrap (bot, p) {
  const opened = escOpened.slice(); escOpened = []
  const cells = giveUps.filter(g => Math.abs(g.x - p.x) <= GIVEUP_NEAR && Math.abs(g.y - p.y) <= GIVEUP_NEAR && Math.abs(g.z - p.z) <= GIVEUP_NEAR).map(g => ({ x: g.x, y: g.y, z: g.z }))
  cells.push({ x: p.x, y: p.y, z: p.z })
  const day = require('./day').dayNo(bot); const batch = Date.now() // (the trap's cells together: forgotten together)
  require('./memory').update(m => { const l = (m.trapCells || []).filter(t => t.day != null && trapLive(bot, t)); for (const c of cells) if (!l.some(t => t.x === c.x && t.y === c.y && t.z === c.z)) l.push(Object.assign(c, { day, batch }, opened.length ? { opened } : {})); m.trapCells = l.slice(-200) })
  log('move', `a trap remembered at ${fmt(p)} (${cells.length} cells) - walked round for a day`)
}
function clearGiveUps (p) {
  for (let i = giveUps.length - 1; i >= 0; i--) { const g = giveUps[i]; if (Math.abs(g.x - p.x) <= GIVEUP_NEAR && Math.abs(g.y - p.y) <= GIVEUP_NEAR && Math.abs(g.z - p.z) <= GIVEUP_NEAR) giveUps.splice(i, 1) }
  // (the place's instant fails with them: out of it, it is no stuck place)
  for (let i = instantFails.length - 1; i >= 0; i--) { const g = instantFails[i]; if (Math.abs(g.x - p.x) <= GIVEUP_NEAR && Math.abs(g.y - p.y) <= GIVEUP_NEAR && Math.abs(g.z - p.z) <= GIVEUP_NEAR) instantFails.splice(i, 1) }
}
async function stepUpSide (bot) {
  const act = require('./act')
  const f = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = f.x + dx; const z = f.z + dz
    const step = world.at(bot, x, f.y, z)
    if (!step || !world.isSolid(step)) continue
    const c1 = world.at(bot, x, f.y + 1, z); const c2 = world.at(bot, x, f.y + 2, z)
    if (!c1 || !c2) continue
    let ok = true
    for (const c of [c2, c1]) {
      if (world.isAirish(c)) continue
      if (world.isWaterBlock(c) || world.isLavaBlock(c) || !world.NATURAL_RE.test(c.name)) { ok = false; break }
      if (!await act.dig(bot, c.position, { allowZones: ['farm', 'base', 'orchard'], timeoutMs: 8000, noWalk: true })) { ok = false; break }
    }
    if (!ok) continue
    const t0 = Date.now()
    while (Date.now() - t0 < 2500 && Math.floor(bot.entity.position.y) <= f.y) {
      await bot.look(Math.atan2(-(x + 0.5 - bot.entity.position.x), -(z + 0.5 - bot.entity.position.z)), 0, true).catch(() => {})
      bot.setControlState('forward', true); bot.setControlState('jump', true)
      await sleep(100)
    }
    bot.setControlState('forward', false); bot.setControlState('jump', false)
    if (Math.floor(bot.entity.position.y) > f.y) return true
  }
  return false
}
function underBuildFloor (bot) {
  const jb = require('./build').getJob(); const bb = jb && jb.box; const p = bot.entity.position.floored()
  return !!bb && p.x >= bb.x1 && p.x <= bb.x2 && p.z >= bb.z1 && p.z <= bb.z2 && p.y < bb.y1
}
function stuckHereAgain (bot) {
  const p = bot.entity.position.floored(); const now = Date.now()
  for (let i = giveUps.length - 1; i >= 0; i--) if (now - giveUps[i].t >= 5 * 60000) giveUps.splice(i, 1)
  giveUps.push({ x: p.x, y: p.y, z: p.z, t: now })
  return giveUpsNear(p, now) >= 2
}
let escaping = false // (its own walks give up too: never re-entered)
// INSTANT FAILS BY PLACE: { x, y, z, t, goal } - a walk that failed at once from here, and where it was going
const instantFails = []
const INSTANT_MS = 3 * 60000
function goalKey (g) { const p = g && (g.x != null ? g : g.pos || null); return g ? `${g.constructor && g.constructor.name}:${p ? Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z) : '?'}` : '?' }
function instantGoalsNear (p, now = Date.now()) { return new Set(instantFails.filter(f => now - f.t < INSTANT_MS && Math.abs(f.x - p.x) <= GIVEUP_NEAR && Math.abs(f.y - p.y) <= GIVEUP_NEAR && Math.abs(f.z - p.z) <= GIVEUP_NEAR).map(f => f.goal)).size }
// (noted; returns the distinct goals failing at once from here when that is two or more - a stuck place - else 0)
function noteInstant (bot, goal) {
  const p = bot.entity.position.floored(); const now = Date.now()
  instantFails.push({ x: p.x, y: p.y, z: p.z, t: now, goal: goalKey(goal) })
  while (instantFails.length > 64 || (instantFails.length && now - instantFails[0].t > INSTANT_MS)) instantFails.shift()
  const n = instantGoalsNear(p, now)
  return n >= 2 ? n : 0
}
// Is `p` (default: where the body stands) a place every walk fails from at once? THE rule base's chest marks ask: a
// chest is no verdict from a stuck place (all twelve chests "skipping it for a while" from a scaffold top, 2026-10-06)
function stuckPlace (bot, p = null) { const q = p || (bot && bot.entity ? bot.entity.position.floored() : null); return !!q && instantGoalsNear(q) >= 2 }
let openSaid = null // (the "not enclosed" line, once a spot)
async function escapeUp (bot) {
  if (escaping) return false
  escaping = true
  try { return await escapeUpInner(bot) } finally { escaping = false }
}
let finishedWait = null // (where and since when the escape has waited, shut in by finished cells of our build)
async function escapeUpInner (bot) {
  const act = require('./act'); const gather = require('./gather')
  const f0 = bot.entity.position.floored()
  // ON A PILLAR OF OUR OWN IN THE OPEN - every side a drop: down through it, the way it went up. The climb only rises: a
  // walk's escape towered 10 in the open by the castle's west wall, the bot stood on the top with a drop all round, every
  // walk gave up and each "climb out" climbed nothing ("from y129 to y129"), 2026-09-30. Our blocks by the ledger only
  // (or, round the build, the site's own snapshot diff: a walk's tower on the castle's rim is neither litter's (the rim is
  //  the build's) nor a step's pillar - stood on it, y124 over a 6-drop all round, hutNight/bunker gave up for 10 minutes
  //  at night, 2026-10-03)
  {
    const litter = require('./litter')
    // (or a LONE block of plain ground or filler with a drop on every side and nothing protected: the lower half of our own
    //  pillar dug away by the tidy left its top block off the ledger - the descent stopped one above it, 'no way to jiggle that is
    //  not over a drop' 52 times at dusk, 2026-10-04. The fall check below still holds the dig to a safe drop)
    // (never a cell of the build job, finished or not - an unfinished castle cell holding dirt read as a lone block; audit)
    const jobCell = u => { try { const j = require('./build').getJob(); return !!(j && j.index.has(`${u.x},${u.y},${u.z}`)) } catch { return true } }
    const lone = u => { const b = world.at(bot, u.x, u.y, u.z); return !!b && /^(dirt|grass_block|coarse_dirt|cobblestone|stone|cobbled_deepslate|andesite|diorite|granite|netherrack)$/.test(b.name) && !isProtected(b, 'dig') && !jobCell(u) }
    // (a lone block is ours only standing alone - a drop past SAFE_DROP on every side of it: never the ground under a
    //  stranded body, which would dig a shaft)
    const alone = u => [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => world.dropAt(bot, u.x + dx + 0.5, u.y + 1, u.z + dz + 0.5) > world.SAFE_DROP)
    const mine = u => litter.has(u) || require('./build').strayAt(bot, u) || (lone(u) && alone(u))
    // STRANDED ON BLOCKS OF OURS: every block the body stands on (gather.standingOn - the hitbox's, not only the cell under its
    // centre) is ours, and no way to step that is not over a drop (safeJiggles - the jiggle's own rule). Read off the centre
    // cell with a drop on all four sides, an L of three of our dirt blocks at y115 in a crown was no pillar: every side of
    // the centre was not a drop, the hitbox rested on the neighbour, and the bot stood there 7 minutes - "no way to jiggle",
    // "open above; no climb" - till the operator dug it down, 2026-10-06
    const onTop = () => { if (!bot.entity.onGround) return null; const s = gather.standingOn(bot); return s.length && s.every(mine) && !safeJiggles(bot).length ? s : null }
    // (no sky test: a canopy's leaves read as a roof, and the descent stopped after one block each escape; audit)
    // (the ground flag settles first: mineflayer reads onGround false a tick at a time while standing - "came down our pillar:
    //  from X to X" three times, 2026-10-03)
    await gather.landed(bot, 600)
    if (onTop()) {
      log('move', `stuck on blocks of ours at ${fmt(f0)} with no step that is not over a drop - digging down through them`)
      // (THE descent - gather.climbDownPillar: the block the body stands on while it is ours, each drop to the next solid
      //  within SAFE_DROP, never onto lava or into water; force: a seeded block here too - the body stands on it because a
      //  climb put it there, survival outranks inferred ownership, the grief plan's escape net; audit)
      const n = await gather.climbDownPillar(bot, mine, { allowZones: ['*'], force: true, max: 24 })
      // (nothing came down: said, and on to the ladder's other ways - never a 'came down' in place, 2026-10-03)
      if (!n) log('move', `our blocks at ${fmt(f0)} would not come down: ${gather.downWhy() || 'no reason given'}`)
      else {
        clearGiveUps(f0)
        await gather.landed(bot) // (said after landing)
        log('move', `came down our blocks: from ${fmt(f0)} to ${fmt(bot.entity.position)} (${n} dug)`)
        return true
      }
    }
  }
  // ENCLOSED BY THE BUILD - PROVEN, not guessed: no walk out of here even with every door taken as a
  // way through (build.wayOut). The climb-out takes our own blocks only in the hollow under the floor, a tower may not rise
  // in a build cell, and a room the builder closed round the bot left it walking for ever - at dusk, and the night walk
  // that followed killed it (2026-09-28 19:20). A player breaks out through the wall and puts the block back: a door's
  // lower half first (it comes back whole), else two wall cells that hold nothing up, toward open ground (audit)
  {
    const build = require('./build'); const j = build.getJob()
    const inFoot = j && f0.x >= j.box.x1 && f0.x <= j.box.x2 && f0.z >= j.box.z1 && f0.z <= j.box.z2
    // (below the floor too: a hollow the foundation rim closed all round has no way out for the walk to the exit or the
    //  climb to find - the rim is opened like any wall, toward safe ground past it; audit 2026-09-29)
    // (or PROVEN by the walks themselves: three give-ups on this one spot in five minutes. The search reads a way out the
    //  walk cannot take - a one-high gap between two built layers, cells of the layer between out of stock: the bot walked
    //  into it at the one open column and 'gave up (stuck x3)' eleven times, the search still finding "a way", 2026-09-29.
    //  The physics decides; audit)
    const proven = giveUpsNear(bot.entity.position.floored()) >= 3
    const searchOut = inFoot && build.wayOut(bot, { x: NaN, y: NaN, z: NaN }, null, false)
    // (the proof over-ruled the search: what it thought the way was - the search is fixed there, the proof stays; audit)
    if (inFoot && proven && searchOut) { const ex = build.wayOutPoint(bot); log('move', `stuck three times here though the way-out search finds an exit at ${ex ? fmt(ex) : '?'} - the walks prove it wrong: breaking out`) }
    if (inFoot && (proven || !searchOut)) {
      // (a door beside the bot is "a way" to wayOut, but crossDoor goes through a door only along its facing, from a step in
      //  front or behind: from its side - a one-cell pocket next to a double door - it never got through, and the log said
      //  "no way out" beside a door, 2026-09-29; audit)
      const doorBeside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const b = world.at(bot, f0.x + dx, f0.y, f0.z + dz); return !!b && /_door$/.test(b.name) })
      log('move', `enclosed by the build at ${fmt(f0)} - ${doorBeside ? 'the door beside me did not let me through' : 'no way out'}; opening our own wall beside me, the builder puts it back`)
      const cellAt = (x, y, z) => j.index.get(`${x},${y},${z}`)
      const holdsUp = (x, y, z) => j.cells.some(q => q.sup && q.sup.x === x && q.sup.y === y && q.sup.z === z && build.cellDone(bot, q) === true)
      const air = (x, y, z) => { const b = world.at(bot, x, y, z); return !!b && world.isAirish(b) }
      // (a cell of the pair: air already, or a cell of our build that holds nothing up)
      // (or, under the floor, the earth round the pocket: the slope's dirt and stone the ordinary dig takes anyway - a
      //  player digs out of a hole through the ground, not only through the build; never with sand or gravel over it,
      //  which falls into the tunnel; audit 2026-09-29)
      const earth = (x, y, z, b) => !cellAt(x, y, z) && !act.digRefusal(bot, b, { allowZones: ['build', 'base'] }) && !/sand$|gravel|concrete_powder/.test((world.at(bot, x, y + 1, z) || {}).name || '')
      const ours = (x, y, z) => { const b = world.at(bot, x, y, z); return !!b && (world.isAirish(b) || (!!cellAt(x, y, z) && !holdsUp(x, y, z) && !world.isLavaBlock(b) && !world.isWaterBlock(b)) || earth(x, y, z, b)) }
      // (safe ground past the wall: room for the body and a drop a fall does not hurt - the castle's outer walls stand over
      //  a 6-9 block drop, and air past them is a lip, not a way out; audit)
      const safe = (x, y, z) => air(x, y, z) && air(x, y + 1, z) && world.dropAt(bot, x, y, z) <= world.SAFE_DROP
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => {
        const door = [0, 1].some(dy => { const b = world.at(bot, f0.x + dx, f0.y + dy, f0.z + dz); return b && /_door$/.test(b.name) })
        return { dx, dz, door, ok: ours(f0.x + dx, f0.y, f0.z + dz) && ours(f0.x + dx, f0.y + 1, f0.z + dz), beyond: safe(f0.x + 2 * dx, f0.y, f0.z + 2 * dz) }
      }).filter(sd => sd.ok).sort((a, b) => (b.door - a.door) || (b.beyond - a.beyond))
      // A ROOM, NOT A POCKET: shut in a 140-cell room under the plaza, every side of the body was air - "ours or air" - and
      // the tunnel ran three steps across the open floor, dug nothing, and the walks gave up again, a loop of 6 minutes,
      // 2026-10-04. The room the body can walk (cells stood in, a step up or down), and its nearest WALL - a pair of cells
      // ours to open, safe ground past it that is not the room itself: walked to, then opened as before
      const kk = q => q.x + ',' + q.y + ',' + q.z
      const room = new Map() // key -> dist
      {
        const q = [{ x: f0.x, y: f0.y, z: f0.z, d: 0 }]; room.set(kk(f0), 0)
        while (q.length && room.size < 600) {
          const c = q.shift()
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (const dy of [0, 1, -1]) {
              const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
              if (room.has(kk(n)) || Math.abs(n.x - f0.x) > 20 || Math.abs(n.z - f0.z) > 20 || !world.standable(bot, n.x, n.y, n.z)) continue
              if (dy === 1 && !air(c.x, c.y + 2, c.z)) continue // (a step up wants head room over the cell left)
              room.set(kk(n), c.d + 1); q.push(Object.assign(n, { d: c.d + 1 }))
            }
          }
        }
      }
      // THE WAY OUT, IN ORDER (operator 2026-10-07): the region's own DOOR, crossed - opened, never dug; then a wall of cells
      // the builder has not finished (unplaced, filler, the wrong block) or plain ground; a FINISHED cell of the build only
      // last, and only when survival needs it - a closet of open trapdoors beside the castle's spruce door was broken out
      // through two finished oak trapdoors the builder had to put back, 2026-10-07 03:30
      const finished = (x, y, z) => { const c = cellAt(x, y, z); const b = world.at(bot, x, y, z); return !!c && !!b && !world.isAirish(b) && build.cellDone(bot, c) === true }
      const pairCost = (x, y, z) => [0, 1].reduce((t, dy) => t + (air(x, y + dy, z) ? 0 : finished(x, y + dy, z) ? 10 : 1), 0)
      // (and shut in by our own finished cells 2 min by day: one block of our own build, put back by the builder, beats a lost
      //  day - a closet with no door and finished walls only waited to dusk; audit 2026-10-07)
      if (!finishedWait || world.dist3(finishedWait.at, f0) > 3 || Date.now() - finishedWait.seen > 300000) finishedWait = { at: { x: f0.x, y: f0.y, z: f0.z }, t: Date.now() }
      finishedWait.seen = Date.now() // (a wait not seen for 5 min is over - the escape re-runs spaced out by back-offs; audit)
      const urgent = () => { const rf = require('./reflex'); return bot.health <= rf.hurtLine() || world.phase(bot) !== 'day' || rf.hostiles(16).some(h => h.e.name !== 'bat') || Date.now() - finishedWait.t > 120000 }
      // 1. the doors the room touches, nearest first: walked to, crossed (crossDoor opens a closed one)
      {
        const doors = []
        for (const [key, d] of room) {
          const [cx, cy, cz] = key.split(',').map(Number)
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (![0, 1].some(dy => { const b = world.at(bot, cx + dx, cy + dy, cz + dz); return !!b && /_door$/.test(b.name) && !/iron_door/.test(b.name) })) continue
            const past = { x: cx + 2 * dx, y: cy, z: cz + 2 * dz }
            if (room.has(kk(past)) || !world.standable(bot, past.x, past.y, past.z)) continue // (a door inside the room, or onto nothing)
            doors.push({ c: { x: cx, y: cy, z: cz }, past, d })
          }
        }
        for (const dr of doors.sort((a, b) => a.d - b.d).slice(0, 2)) {
          if (dr.d > 0) await goTo(bot, new goals.GoalBlock(dr.c.x, dr.c.y, dr.c.z), { timeoutMs: 15000, stuckMs: 5000, dig: false, place: false, label: 'to the door out' }).catch(() => null)
          const crossed = await crossDoor(bot, new goals.GoalBlock(dr.past.x, dr.past.y, dr.past.z)).catch(() => false)
          const now = bot.entity.position.floored()
          if (crossed && !room.has(kk(now))) { log('move', `enclosed at ${fmt(f0)} - out through the door beside ${fmt(dr.c)} to ${fmt(now)}`); clearGiveUps(f0); return true }
        }
        if (doors.length) log('move', `enclosed at ${fmt(f0)}: the room's door${doors.length > 1 ? 's' : ''} did not let me through - a wall next`)
      }
      // 2. the cheapest wall to open: no finished cell first, then nearest, then the fewest blocks
      let exit = null // { c, dx, dz, d, cost }
      for (const [key, d] of room) {
        const [cx, cy, cz] = key.split(',').map(Number)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const wx = cx + dx; const wz = cz + dz; const bx = cx + 2 * dx; const bz = cz + 2 * dz
          if (room.has(kk({ x: wx, y: cy, z: wz })) || (air(wx, cy, wz) && air(wx, cy + 1, wz))) continue // (not a wall)
          if (!ours(wx, cy, wz) || !ours(wx, cy + 1, wz) || !safe(bx, cy, bz) || room.has(kk({ x: bx, y: cy, z: bz }))) continue
          const cost = pairCost(wx, cy, wz)
          const cand = { c: { x: cx, y: cy, z: cz }, dx, dz, d, cost }
          const better = (a, b) => ((a.cost >= 10) - (b.cost >= 10)) || (a.d - b.d) || (a.cost - b.cost)
          if (!exit || better(cand, exit) < 0) exit = cand
        }
      }
      // (the sides beside the body, the same order)
      for (const sd0 of sides) sd0.cost = pairCost(f0.x + sd0.dx, f0.y, f0.z + sd0.dz)
      sides.sort((a, b) => ((a.cost >= 10) - (b.cost >= 10)) || (a.cost - b.cost))
      // 3. a finished cell only when it must be: hurt, the night, a threat about - otherwise the builder's walk model is
      //    asked again later (the closet reads as a way out once its trapdoors are read right) and the bot waits
      const best = exit || sides[0] || null
      if (best && best.cost >= 10) {
        if (!urgent()) { log('move', `enclosed at ${fmt(f0)}: the only way out is through a FINISHED cell of the build - not breaking it with no danger (hp ${Math.round(bot.health)}, ${world.phase(bot)}, no threat); waiting`); return false }
        log('move', `enclosed at ${fmt(f0)}: BREAKING A FINISHED CELL of the build to get out - hp ${Math.round(bot.health)}, ${world.phase(bot)}${require('./reflex').hostiles(16).some(h => h.e.name !== 'bat') ? ', a threat about' : ''} (the builder puts it back)`)
      }
      let sd = sides[0]
      let start = { x: f0.x, y: f0.y, z: f0.z }
      if (exit) {
        if (exit.d > 0) {
          log('move', `enclosed in a room of ${room.size} cells - its wall at ${fmt({ x: exit.c.x + exit.dx, y: exit.c.y, z: exit.c.z + exit.dz })} opens onto open ground: walking to it`)
          await goTo(bot, new goals.GoalBlock(exit.c.x, exit.c.y, exit.c.z), { timeoutMs: 15000, stuckMs: 5000, dig: false, place: false, label: 'to the wall to open' }).catch(() => null)
        }
        const here = bot.entity.position.floored()
        if (here.x === exit.c.x && here.y === exit.c.y && here.z === exit.c.z) { sd = { dx: exit.dx, dz: exit.dz }; start = here }
        // (not there: never the air side - the same no-op tunnel and the same loop; the trap and give-up rules decide; audit)
        else { log('move', `enclosed: couldn't reach the wall at ${fmt(exit.c)}`); sd = null }
      }
      if (sd) {
        // (a bounded tunnel along that side: a pair at a time - feet and head - stepping in and asking again after each;
        //  three at most, so a thick wall is got through and nothing longer is ever bored through the build; audit)
        let at = { x: start.x, y: start.y, z: start.z }
        for (let n = 0; n < 3; n++) {
          const p0 = { x: at.x + sd.dx, y: at.y, z: at.z + sd.dz }
          if (!ours(p0.x, p0.y, p0.z) || !ours(p0.x, p0.y + 1, p0.z)) break
          // (a finished cell further in, the same rule: only when survival needs it)
          if (pairCost(p0.x, p0.y, p0.z) >= 10 && !urgent()) { log('move', `enclosed: a finished cell of the build at ${fmt(p0)} next - not breaking it with no danger`); break }
          for (const dy of [1, 0]) {
            const b = world.at(bot, p0.x, p0.y + dy, p0.z)
            if (b && !world.isAirish(b)) { escOpened.push({ x: p0.x, y: p0.y + dy, z: p0.z }); log('move', `enclosed: taking our own ${b.name} at ${fmt({ x: p0.x, y: p0.y + dy, z: p0.z })}`); const mine = !!cellAt(p0.x, p0.y + dy, p0.z); await act.dig(bot, { x: p0.x, y: p0.y + dy, z: p0.z }, { own: mine, force: mine, noWalk: true, allowZones: ['build', 'base'], timeoutMs: 8000 }).catch(() => false) }
          }
          await act.collectDrops(bot, { radius: 4, maxMs: 3000 }).catch(() => {}) // (a door dug comes back whole: the builder re-places it)
          if (!safe(p0.x, p0.y, p0.z)) { log('move', `enclosed: the cell opened at ${fmt(p0)} stands over a drop - not stepping in`); break } // (room, and a drop a fall does not hurt)
          await goTo(bot, new goals.GoalBlock(p0.x, p0.y, p0.z), { timeoutMs: 6000, stuckMs: 3000, dig: false, place: false, label: 'out through our wall' }).catch(() => null)
          at = bot.entity.position.floored()
          if (build.wayOut(bot, { x: NaN, y: NaN, z: NaN }, null, false)) { log('move', `enclosed: a way out from ${fmt(at)}`); break }
        }
        noteTrap(bot, f0); clearGiveUps(f0)
        return true
      }
      log('move', `enclosed by the build at ${fmt(f0)} - no wall beside me to open (supports or no open ground past it)`)
    }
  }
  // on open ground under the sky there is nothing to climb out of: step to a free cell beside us and let the next walk
  // plan from there. Every walk from one spot on the cliff under the cathedral's north edge gave up for 20 minutes;
  // one step down the slope and the same walk went straight through (2026-09-26).
  if (bot.entity.onGround && !world.feetInWater(bot) && world.openSky(bot, { x: f0.x, y: f0.y, z: f0.z })) {
    const cells = []
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, -1, 1, -2]) {
      if (!dx && !dz) continue
      const x = f0.x + dx; const y = f0.y + dy; const z = f0.z + dz
      if (world.standable(bot, x, y, z) && world.dropAt(bot, x, y, z) === 0) cells.push({ x, y, z, d: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) })
    }
    for (const c of cells.sort((a, b) => a.d - b.d).slice(0, 4)) {
      const r = await goTo(bot, new goals.GoalBlock(c.x, c.y, c.z), { timeoutMs: 8000, stuckMs: 4000, dig: false, place: false, label: 'step aside' })
      if (r.ok) { log('move', `stuck at ${fmt(f0)} - stepped aside to ${fmt(c)}`); return true } // (a step aside is not out: the count stands)
    }
  }
  // (below the build's floor inside its footprint: to the way out first - a column outside, or the open-sky cell a tower
  //  rises from - then the climb. Climbing where it stood, under a floor or in a foundation cell it may not tower in, ended
  //  "no way up" in the closed south-west pocket, 2026-09-29; audit)
  {
    const build = require('./build'); const jb = build.getJob(); const bb = jb && jb.box
    if (bb && f0.x >= bb.x1 && f0.x <= bb.x2 && f0.z >= bb.z1 && f0.z <= bb.z2 && f0.y < bb.y1) {
      const ex = build.wayOutPoint(bot)
      if (ex && (ex.x !== f0.x || ex.z !== f0.z)) {
        log('move', `below the build's floor at ${fmt(f0)} - to the way out at ${fmt(ex)} first`)
        await goTo(bot, new goals.GoalBlock(ex.x, ex.y, ex.z), { timeoutMs: 20000, stuckMs: 6000, dig: false, place: false, label: 'to the way out' }).catch(() => null)
      }
    }
  }
  log('move', `stuck at ${fmt(f0)} walk after walk - climbing straight out`)
  let climbedAny = false
  for (let i = 0; i < 16; i++) {
    const f = bot.entity.position.floored()
    // (open sky is out - but not in a pit INSIDE the build's footprint below its floor: the unbuilt corner of the castle, a
    //  6-deep hole walled round by the walls above it, read "climbed out" without a block climbed, and every walk from its
    //  bottom failed, 2026-09-29. There, up to the floor's level first, then the walk)
    const jb = require('./build').getJob(); const bb = jb && jb.box
    const pit = !!bb && f.x >= bb.x1 && f.x <= bb.x2 && f.z >= bb.z1 && f.z <= bb.z2 && f.y < bb.y1
    // (open = no roof but a tree's: leaves and logs overhead are shade, nothing to climb out of - read as a roof, the climb
    //  towered 16 up through a canopy by the castle's west wall and stranded the bot on its top, 2026-09-30; audit)
    const openAbove = q => { for (let y = q.y + 2; y < q.y + 22; y++) { const b = world.at(bot, q.x, y, q.z); if (b && b.boundingBox === 'block' && !world.LEAF_RE.test(b.name) && !world.LOG_RE.test(b.name)) return false } return true }
    // (and a STEP OUT of it: open sky over a one-wide hole whose sides are a block too low to walk - a gap under the plaza's
    //  floor, the way out a two-block climb - read "not enclosed, no climb" and every walk from it gave up for half an hour,
    //  2026-10-04. Out = a cell beside stood in at our level, one up with head room over us, or a step down)
    const stepOut = q => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => world.standable(bot, q.x + dx, q.y, q.z + dz) || (world.standable(bot, q.x + dx, q.y + 1, q.z + dz) && world.isAirish(world.at(bot, q.x, q.y + 2, q.z))) || world.standable(bot, q.x + dx, q.y - 1, q.z + dz))
    // (and a hole is a couple of blocks deep: past three up under open sky this is no hole - a low canopy all round read no
    //  step out and would have climbed into the trees; audit)
    if (bot.entity.onGround && !world.feetInWater(bot) && openAbove(f) && !pit && (stepOut(f) || f.y >= f0.y + 3)) break
    climbedAny = true
    for (const dy of [2, 1]) {
      const b = world.at(bot, f.x, f.y + dy, f.z)
      // (a finished cell of OUR build over the head is ours to take and put back: sealed in the hollow under the castle's
      //  floor, every walk out failed and the climb refused the slab over the head - 5 minutes stuck, freed only by the
      //  operator's hand, 2026-09-28. The builder sees the cell undone and places it again)
      // (only in the hollow UNDER the build - feet inside its footprint, below its base - and never a block that holds up
      //  an attached cell of it: a lantern hung from a slab would drop; audit 2026-09-28)
      const j = require('./build').getJob()
      const bx = j && j.box
      const under = !!(bx && f.x >= bx.x1 && f.x <= bx.x2 && f.z >= bx.z1 && f.z <= bx.z2 && f.y < bx.y1)
      const bk = b ? `${b.position.x},${b.position.y},${b.position.z}` : ''
      const holdsUp = !!(b && j && j.cells.some(c => c.sup && `${c.sup.x},${c.sup.y},${c.sup.z}` === bk))
      const ours = !!(b && under && !holdsUp && j.index && j.index.has(bk))
      if (ours && !world.isAirish(b)) log('move', `climbing out: taking our own ${b.name} over my head at ${bk} - the builder puts it back`)
      if (b && !world.isAirish(b) && !world.isWaterBlock(b) && !await act.dig(bot, b.position, { own: ours, force: ours, allowZones: ['farm', 'base', 'orchard', 'build'], timeoutMs: 8000, noWalk: true })) { log('move', `climbing out: can't clear ${b.name} over my head at ${fmt(b.position)}`); return false }
    }
    // (the tower's cell an UNPLACED CELL OF THE BUILD - a hole left in the plaza's floor, the bot in it, sides a block too low:
    //  filler is refused there, and the climb ended "no way up" for half an hour, 2026-10-04. Its own block from the pack goes
    //  in - the builder's placing, from below - a full block only (a stair or slab from under is placed the wrong way))
    const tc = jb && jb.index && jb.index.get(f.x + ',' + f.y + ',' + f.z)
    // (the builder's own item for the cell and its stand-ins - the blueprint's name is not what is placed; and never an
    //  oriented block - a log on its side, a faced furnace - from below it goes in wrong and the builder digs it out; audit)
    const want = tc && !tc.clear ? require('./build').itemOf(tc, world.data(bot)) : null
    const pr = (tc && tc.props) || {}
    const oriented = Object.keys(pr).some(kk => kk === 'facing' || kk === 'rotation' || (kk === 'axis' && String(pr[kk]) !== 'y'))
    const have = want && !oriented && !/_(stairs|slab|wall|fence|fence_gate|door|trapdoor|pane|button|plate|carpet|torch|lantern)$|^(glass_pane|iron_bars|ladder|vine)$/.test(want) ? bot.inventory.items().find(i => i.name === want || (tc.itemAlt && tc.itemAlt.test(i.name))) : null
    const ownItem = have ? have.name : null
    if (ownItem) log('move', `climbing out: the cell I stand in at ${fmt(f)} is the build's ${ownItem} - putting it in from below`)
    if (await gather.towerUp(bot, ownItem ? { allowZones: ['*'], builder: true, item: ownItem } : { allowZones: ['*'] })) continue // (an escape: any zone, never a build cell but with its own block)
    // no towering here (in water a jump never clears a block; or nothing to place): a step cut into the side - the two
    // cells over a solid side block cleared, and up onto it
    if (!await stepUpSide(bot)) { log('move', `climbing out: no way up from ${fmt(bot.entity.position)} (no tower: ${gather.towerWhy() || 'refused'}; no side to cut a step in)`); return false }
  }
  // (nothing to climb out of - open above on the first pass: no "climbed out", no trap, the stuck evidence kept, so the
  //  caller goes on to the surface's own remedies and the count still builds; "from y129 to y129" looped a trap and wiped
  //  the give-ups every minute, 2026-09-30; audit)
  if (!climbedAny) {
    if (openSaid !== fmt(f0)) { openSaid = fmt(f0); log('move', `stuck at ${fmt(f0)} but not enclosed - open above; no climb`) }
    // THE LAST RUNG: no walk, no safe jiggle, nothing to climb - a controlled drop a little past the safe one (controlledDrop)
    if (await controlledDrop(bot)) { clearGiveUps(f0); return true }
    return false
  }
  noteTrap(bot, f0); clearGiveUps(f0)
  log('move', `climbed out: from ${fmt(f0)} to ${fmt(bot.entity.position)}`)
  return true
}

// A CONTROLLED DROP: stranded with every walk failing and no jiggle that is not over a drop - a ledge outside the castle's
// south wall with a 4-block drop, every walk an instant noPath for minutes, 2026-10-06 22:10 - the way a player gets down:
// step off where the fall is SAFE_DROP+1 or +2 onto solid ground that hurts nothing more than the fall (no lava, water,
// powder snow, magma, cactus, a campfire, a berry bush, dripstone; no hostile there), only with the health to spare
// (DROP_HP; the fall costs drop-3). The lowest such drop; faced, walked off with the edge brake and the ledge crouch
// standing aside for that one column (reflex.chooseDrop). One rule, logged either way.
const DROP_HAZARD = /^(magma_block|cactus|campfire|soul_campfire|powder_snow|pointed_dripstone|sweet_berry_bush|wither_rose|fire|soul_fire|cobweb|lava|water)$/
const DROP_HP = 16
// (one a while: a drop that lands somewhere stuck again is no reason for the next - a chain of drops is a descent nobody
//  chose; audit 2026-10-06)
const DROP_EVERY_MS = 10 * 60000
let lastDropAt = 0 // (a drop that happened)
let dropTries = [] // (the attempts: three in DROP_EVERY_MS - one that "did not go" leaves the slot open, the tries bound it)
// WHERE A BODY STEPPING INTO COLUMN c AT FEET LEVEL fy LANDS: the first solid under it, the fall's cells free of hazards,
// the landing standable, nothing hazardous beside it (a berry bush, a cactus) and no hostile within 4. null: no safe landing
// (or none within SAFE_DROP+2). A wall in the column at the start - feet or head level - is no landing but a bump: `wall`.
function dropLanding (bot, c, fy) {
  if ([0, 1].some(dy => { const b = world.at(bot, c.x, fy + dy, c.z); return !!b && world.isSolid(b) })) return { wall: true }
  if (![0, 1].every(dy => { const b = world.at(bot, c.x, fy + dy, c.z); return !!b && world.isAirish(b) && !DROP_HAZARD.test(b.name) })) return null
  let k = 1; let land = null
  for (; k <= world.SAFE_DROP + 3; k++) {
    const b = world.at(bot, c.x, fy - k, c.z)
    if (!b || DROP_HAZARD.test(b.name) || world.isWaterBlock(b) || world.isLavaBlock(b)) return null
    if (b.boundingBox === 'block') { land = b; break }
  }
  const drop = k - 1
  if (!land || drop > world.SAFE_DROP + 2) return null
  const feet = { x: c.x, y: fy - k + 1, z: c.z }
  if (!world.standable(bot, feet.x, feet.y, feet.z)) return null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) { const b = world.at(bot, feet.x + dx, feet.y + dy, feet.z + dz); if (b && DROP_HAZARD.test(b.name)) return null }
  const reflex = require('./reflex')
  if (reflex.hostiles(24).some(h => h.e.position && world.dist3(h.e.position, { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }) < 4)) return null
  return { drop, feet, land: land.name }
}
// WHERE A DRIFT INTO THE COLUMN PAST IT ENDS (c2): the fall carries the body on ~1.5 blocks below the ledge, so c2 is a
// wall only solid at EVERY level from the landing's feet (feetY) up to the ledge (fy) - an overhang at ledge height with air under
// it lets the body drift in lower down, onto a floor nobody checked (audit R4). Else its first open level at or below fy
// down to its floor: the cells free of hazards, the drop counted from fy within SAFE_DROP+2, standable, nothing hazardous
// beside, no hostile. null: no safe drift.
function driftLanding (bot, c2, fy, feetY) {
  // (scanned from fy down: the falling body enters c2 only below the ledge - its first open level there is where the drift
  //  goes; c2 open only at fy+1, the head's level at the start, is still a wall to a body whose feet are under fy)
  let open = null
  for (let y = fy; y >= feetY; y--) { const b = world.at(bot, c2.x, y, c2.z); if (!b) return null; if (!world.isSolid(b)) { open = y; break } }
  if (open == null) return { wall: true }
  let y = open
  for (; y > fy - (world.SAFE_DROP + 4); y--) {
    const b = world.at(bot, c2.x, y, c2.z)
    if (!b || DROP_HAZARD.test(b.name) || world.isWaterBlock(b) || world.isLavaBlock(b)) return null
    if (world.isSolid(b)) break
  }
  const feet = { x: c2.x, y: y + 1, z: c2.z }
  if (fy - feet.y > world.SAFE_DROP + 2 || !world.standable(bot, feet.x, feet.y, feet.z)) return null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) { const b = world.at(bot, feet.x + dx, feet.y + dy, feet.z + dz); if (b && DROP_HAZARD.test(b.name)) return null }
  if (require('./reflex').hostiles(24).some(h => h.e.position && world.dist3(h.e.position, { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }) < 4)) return null
  return { drop: fy - feet.y, feet }
}
// A STEP ON from a landing: a neighbour (not back toward the wall) the body can stand in at its level, one up with head room,
// or down within SAFE_DROP - a landing with none is a new trap
function stepOnFrom (bot, feet, back) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (dx === back[0] && dz === back[1]) continue
    const x = feet.x + dx; const z = feet.z + dz
    if (world.standable(bot, x, feet.y + 1, z) && world.isAirish(world.at(bot, feet.x, feet.y + 2, feet.z))) return true
    for (let dy = 0; dy >= -world.SAFE_DROP; dy--) if (world.standable(bot, x, feet.y + dy, z)) return true
  }
  return false
}
async function controlledDrop (bot) {
  const reflex = require('./reflex'); const gather = require('./gather')
  await gather.landed(bot, 600)
  if (!bot.entity.onGround || bot.vehicle || world.feetInWater(bot)) return false
  if (safeJiggles(bot).length) return false
  if (bot.health < DROP_HP) { log('move', `no controlled drop from ${fmt(bot.entity.position)}: hp ${Math.round(bot.health)} under ${DROP_HP}`); return false }
  if (Date.now() - lastDropAt < DROP_EVERY_MS) { log('move', `no controlled drop from ${fmt(bot.entity.position)}: one ${Math.round((Date.now() - lastDropAt) / 1000)}s ago (one in ${DROP_EVERY_MS / 60000} min)`); return false }
  dropTries = dropTries.filter(t => Date.now() - t < DROP_EVERY_MS)
  if (dropTries.length >= 3) { log('move', `no controlled drop from ${fmt(bot.entity.position)}: ${dropTries.length} tries in ${DROP_EVERY_MS / 60000} min`); return false }
  const p = bot.entity.position; const f = { x: Math.floor(p.x), y: Math.floor(p.y + 0.01), z: Math.floor(p.z) }
  let best = null; const why = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const c = { x: f.x + dx, z: f.z + dz }
    const L = dropLanding(bot, c, f.y)
    if (!L || L.wall || L.drop <= world.SAFE_DROP) continue
    if (bot.health - (L.drop - world.SAFE_DROP) < DROP_HP - 2) { why.push(`${c.x},${c.z}: the fall costs too much`); continue }
    // (the drift: a 4-5 fall carries the body on ~1.5 blocks - the column past it is a wall it bumps, or a landing as safe)
    const c2 = { x: c.x + dx, z: c.z + dz }
    const L2 = driftLanding(bot, c2, f.y, L.feet.y)
    if (!L2) { why.push(`${c.x},${c.z}: the column past it is no safe landing`); continue }
    // (an onward step from where it lands - no new trap)
    if (!stepOnFrom(bot, L.feet, [-dx, -dz])) { why.push(`${c.x},${c.z}: no step on from the landing`); continue }
    if (!best || L.drop < best.drop) best = Object.assign({ drop: L.drop, land: L.land, c, c2, dir: [dx, dz] }, L.feet)
  }
  if (!best) { log('move', `no controlled drop from ${fmt(f)}: no side with a ${world.SAFE_DROP + 1}-${world.SAFE_DROP + 2}-block fall onto safe ground${why.length ? ' (' + why.join('; ') + ')' : ''}`); return false }
  dropTries.push(Date.now())
  log('move', `stuck at ${fmt(f)} with no walk and no safe step - a controlled ${best.drop}-block drop onto the ${best.land} at ${fmt(best)} (hp ${Math.round(bot.health)})`)
  const release = reflex.chooseDrop(best.c, { from: f, beyond: best.c2 })
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.setControlState('sneak', false)
    // (along the pure heading: no sideways part carries the body into a diagonal column - the perpendicular stays f's, c's)
    const [hx, hz] = best.dir
    await bot.look(Math.atan2(-hx, -hz), 0, true).catch(() => {})
    // forward only until the centre is over the chosen column - then let go for good, and a tick back against the drift
    // (how far the centre is into c along the heading: forward held till 0.35 in - at the boundary the hitbox still rested on
    //  the ledge and the step "did not go"; audit R5)
    const into = () => { const q = bot.entity.position; return hx ? (hx > 0 ? q.x - best.c.x : best.c.x + 1 - q.x) : (hz > 0 ? q.z - best.c.z : best.c.z + 1 - q.z) }
    const inC = () => into() >= 0.35
    const t0 = Date.now()
    bot.setControlState('forward', true)
    while (Date.now() - t0 < 2000 && !inC() && Math.floor(bot.entity.position.y + 0.01) >= f.y) await sleep(25)
    bot.setControlState('forward', false)
    // (a tick back against the drift, only once in the air - on the lip it walked the body back onto the ledge)
    { const t1 = Date.now(); while (bot.entity.onGround && Date.now() - t1 < 400) await sleep(25) }
    if (!bot.entity.onGround) { bot.setControlState('back', true); await sleep(50); bot.setControlState('back', false) }
    await gather.landed(bot, 2500)
  } finally { release(); bot.setControlState('forward', false); bot.setControlState('back', false) }
  const down = Math.floor(bot.entity.position.y + 0.01) < f.y
  if (down) lastDropAt = Date.now()
  log('move', down ? `dropped: from ${fmt(f)} to ${fmt(bot.entity.position)} (hp ${Math.round(bot.health)})` : `the controlled drop from ${fmt(f)} did not go: still at ${fmt(bot.entity.position)}`)
  return down
}

async function goNear (bot, pos, range = 2, opts = {}) {
  return goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), opts)
}

// Underground = a solid roof overhead and the surface of this column well above us.
function surfaceYHere (bot) {
  const me = bot.entity.position.floored()
  for (let y = Math.min(me.y + 80, 318); y > me.y + 1; y--) {
    const b = world.at(bot, me.x, y, me.z)
    if (b && b.boundingBox === 'block' && !world.LEAF_RE.test(b.name) && !world.LOG_RE.test(b.name)) return y + 1
  }
  return null
}
// How much natural rock stands over a place (a count past 4 = buried, the mine's), 0 when open, null when its column is
// not all loaded (unknown yet). Pure over world.at (movedeeptest).
function buried (bot, p) {
  const x = Math.floor(p.x); const z = Math.floor(p.z); let n = 0
  for (let y = Math.floor(p.y) + 2; y < Math.floor(p.y) + 90 && y < 320; y++) {
    const b = world.at(bot, x, y, z)
    if (!b) return null
    if (b.boundingBox === 'block' && world.NATURAL_RE.test(b.name) && !world.LEAF_RE.test(b.name) && !world.LOG_RE.test(b.name)) n++
  }
  return n > 4 ? n : 0
}
// A roof of planks (a hut) or leaves is not being underground: it takes 3+ natural rock/earth
// blocks overhead.
function buildCell (p) { try { const j = require('./build').getJob(); return !!(j && j.index.has(`${p.x},${p.y},${p.z}`)) } catch { return false } }
function isUnderground (bot) {
  const me = bot.entity.position.floored()
  const s = surfaceYHere(bot)
  if (s == null || s - me.y < 4) return false
  let rock = 0
  for (let y = me.y + 2; y < s; y++) {
    const b = world.at(bot, me.x, y, me.z)
    // (never a cell of our build: the castle's stone floors over a ground-floor room are not rock - a walk up to the next floor
    //  read "underground" and went to surface by digging out from under it; audit)
    if (b && b.boundingBox === 'block' && world.NATURAL_RE.test(b.name) && !world.LEAF_RE.test(b.name) && !world.LOG_RE.test(b.name) && !buildCell(b.position)) rock++
  }
  return rock >= 3
}

// Get to open air: let the planner find a way up, else dig straight up and pillar.
async function surface (bot, { shouldStop } = {}) {
  const s = surfaceYHere(bot)
  if (s == null) return true
  const me = bot.entity.position.floored()
  log('move', `underground at y${me.y} (surface ~y${s}) - heading up first`)
  // never climb up through a protected zone (the safehouse floor, the castle): under one, tunnel sideways
  // to a clear column first (a bot in a cave under the hut pillared toward its own floor)
  const columnBlocked = (x, z) => { for (let y = me.y + 1; y <= s + 1; y++) { const q = { x, y, z }; if (inZone(q, 1) || insideHut(q)) return true } return false }
  if (columnBlocked(me.x, me.z)) {
    let best = null
    for (let r = 2; r <= 16 && !best; r++) {
      for (let dx = -r; dx <= r && !best; dx++) for (const dz of [-r, r]) { if (!columnBlocked(me.x + dx, me.z + dz)) { best = { x: me.x + dx, z: me.z + dz }; break } }
      for (let dz = -r + 1; dz <= r - 1 && !best; dz++) for (const dx of [-r, r]) { if (!columnBlocked(me.x + dx, me.z + dz)) { best = { x: me.x + dx, z: me.z + dz }; break } }
    }
    if (best) {
      log('move', `a protected build is overhead - moving to ${best.x},${best.z} to climb out`)
      await goTo(bot, new goals.GoalNearXZ(best.x, best.z, 0), { timeoutMs: 60000, stuckMs: 12000, label: 'out from under', shouldStop })
    }
  }
  // (at the foot of a shaft - our own, dug down - but beside it: into it first. A tower beside a shaft rises with the
  //  shaft's drop open next to it; at y45 the planner stepped off the tower's top into it and the bot fell 20, dead,
  //  2026-09-29 (audit). In the shaft, rock stands on every side of the tower)
  {
    const f = bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = f.x + dx; const z = f.z + dz
      let open = 0; for (let y = f.y; y < f.y + 6; y++) { if (world.isAirish(world.at(bot, x, y, z))) open++; else break }
      if (open >= 6 && world.standable(bot, x, f.y, z)) { log('move', `a shaft beside me at ${x},${z} - climbing out inside it`); await goTo(bot, new goals.GoalBlock(x, f.y, z), { timeoutMs: 8000, stuckMs: 4000, label: 'into the shaft', shouldStop, place: false, dig: false }).catch(() => null); break }
    }
  }
  // straight up is the fastest way out of rock: dig the two cells above, jump, place under us
  const act = require('./act')
  const inv = require('./inventory')
  const y0 = me.y
  for (let i = 0; i < 90 && isUnderground(bot); i++) {
    if (shouldStop && shouldStop()) return false
    const p = bot.entity.position.floored()
    let blocked = false
    for (const dy of [2, 3]) {
      for (let k = 0; k < 6; k++) { // falling sand/gravel refills the cell
        const b = world.at(bot, p.x, p.y + dy, p.z)
        if (!b) { blocked = true; break }
        if (world.isLavaBlock(b) || world.isWaterBlock(b) || world.lavaNear(bot, { x: p.x, y: p.y + dy, z: p.z }, 1)) { blocked = true; break }
        if (world.isAirish(b)) break
        if (!await act.dig(bot, { x: p.x, y: p.y + dy, z: p.z }, { force: true, timeoutMs: 12000 })) { blocked = true; break }
        await sleep(world.FALLING_RE.test(b.name) ? 600 : 50)
      }
      if (blocked) break
    }
    if (blocked) break
    const filler = inv.items(bot).find(it => /^(dirt|cobblestone|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|stone)$/.test(it.name))
    if (!filler) break
    // (never a tower beside an open drop: the next step off its top is the fall - see the shaft below)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = { x: p.x + dx, y: p.y, z: p.z + dz }
      const qb = world.at(bot, q.x, q.y, q.z)
      // (never in a zone - the build's cells, a hole's last face, the base - nor a protected block: placeSupport's rule; audit)
      if (!qb || !world.isAirish(qb) || inZone(q, 1) || isProtected(qb, 'fill') || world.dropAt(bot, q.x + 0.5, q.y, q.z + 0.5) <= world.SAFE_DROP) continue
      if (await act.place(bot, q, filler.name, { noWalk: true, allowZones: ['*'] }).catch(() => false)) require('./litter').note(bot, q, filler.name)
    }
    if (!await require('./gather').towerUp(bot, { allowZones: ['*'] })) break
  }
  if (!isUnderground(bot)) { log('move', `surfaced at y${Math.floor(bot.entity.position.y)} (climbed ${Math.floor(bot.entity.position.y) - y0})`); return true }
  // (a stair dug up through the rock first - rock both sides, no open column top to step off; a tower only if that fails. The
  //  planner's own tower beside a shaft was the fatal step, 2026-09-29; audit)
  const r0 = await goTo(bot, new goals.GoalY(surfaceYHere(bot) || s), { timeoutMs: 60000, stuckMs: 12000, label: 'surface by a stair', shouldStop, dig: true, place: false })
  if (r0.ok || !isUnderground(bot)) return true
  const r = await goTo(bot, new goals.GoalY(surfaceYHere(bot) || s), { timeoutMs: 60000, stuckMs: 12000, label: 'surface', shouldStop })
  return r.ok || !isUnderground(bot)
}

// A crossing that got us somewhere clears the boat's record; a failed one - or a "crossing" of a few blocks, which is
// land and water taking turns at one spot (launch, bump, land, launch...) - counts against it. Three and travel swims.
const SWIM_MAX = 40 // (blocks of open water swum without a boat: a river, not a sea)
const SWIM_LAST_RESORT = 120 // (stranded with no way to a boat: the most open water swum rather than stay for ever)
// refusals at the same spot (within 8 blocks), counted: three in a row with no tree near is "stranded"
let stranded = { at: null, n: 0 }
function noteStranded (bot) { const p = bot.entity.position; if (stranded.at && world.dist2(stranded.at, p) < 8) stranded.n++; else stranded = { at: p.clone(), n: 1 } }
function strandedAt (bot) { return stranded.at && world.dist2(stranded.at, bot.entity.position) < 8 ? stranded.n : 0 }
function boatScore (r, fails) {
  if (r.why === 'no boat') return 3
  if (!r.ok || (r.travelled || 0) < 8) return fails + 1
  return 0
}

// Long distance: legs of ~40 blocks toward the target so A* never searches unloaded space.
// A failed leg bends left/right before giving up. Open water on the line is crossed by boat (boat.js).
// A LEG'S POINT, never inside the build nor a remembered trap - a player walks round his own building site: a castle
// going up is rooms, crawlspaces and floors half laid, and a leg point on a straight line through it was a coin toss;
// one landed in a one-high crawlspace, the bot broke out and the next leg walked it straight back in, 2026-09-29 (audit).
// Unless the target itself is inside: from outside, the corner of the box (2 out) that makes the way round shortest;
// from inside, the first point outside along the heading - the planner walks the last stretch. Pure (offline tests).
function legPoint (me, lx, lz, target, box, traps = []) {
  const inBox = (x, z, pad) => !!box && x >= box.x1 - pad && x <= box.x2 + pad && z >= box.z1 - pad && z <= box.z2 + pad
  const trapAt = (x, z) => traps.some(t => Math.abs(t.x - x) <= 2 && Math.abs(t.z - z) <= 2)
  const targetIn = inBox(target.x, target.z, 1)
  if ((targetIn || !inBox(lx, lz, 1)) && !trapAt(lx, lz)) return { x: lx, z: lz, moved: null }
  if (!targetIn && box && inBox(me.x, me.z, 1)) {
    // (inside: out first, along the heading to the target)
    const ang = Math.atan2(target.z - me.z, target.x - me.x)
    for (let k = 1; k < 200; k++) { const x = Math.round(me.x + Math.cos(ang) * k); const z = Math.round(me.z + Math.sin(ang) * k); if (!inBox(x, z, 2) && !trapAt(x, z)) return { x, z, moved: 'out of the build' } }
  }
  if (!targetIn && box) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
    const cs = [[box.x1 - 3, box.z1 - 3], [box.x1 - 3, box.z2 + 3], [box.x2 + 3, box.z1 - 3], [box.x2 + 3, box.z2 + 3]].map(([x, z]) => ({ x, z })).filter(c => !trapAt(c.x, c.z))
    // (a corner we stand at already is no leg: the next one toward the target)
    const far = cs.filter(c => d(me, c) > 4)
    const best = (far.length ? far : cs).sort((a, b) => (d(me, a) + d(a, target)) - (d(me, b) + d(b, target)))[0]
    if (best) return { x: best.x, z: best.z, moved: 'round the build' }
  }
  // (a trap outside any build: the leg drawn back along the line to the last point clear of it)
  const ang = Math.atan2(lz - me.z, lx - me.x); const n = Math.hypot(lx - me.x, lz - me.z)
  for (let k = Math.floor(n); k >= 2; k--) { const x = Math.round(me.x + Math.cos(ang) * k); const z = Math.round(me.z + Math.sin(ang) * k); if (!trapAt(x, z)) return { x, z, moved: 'short of a trap' } }
  return { x: lx, z: lz, moved: null }
}
async function travel (bot, target, opts = {}) {
  // (anyY: a place on the map, not a block - the ground there at whatever height it is. An explore leg aimed at its own
  //  start height over a valley 50 lower; the planner towered up out of the valley toward it and the bot fell 28
  //  blocks off the pillar, 2026-09-26)
  const { range = 3, shouldStop: stop0, label = 'travel', maxMs = 15 * 60000, anyY = false, underground = false } = opts
  const boat = require('./boat')
  // A stop asked for over open water waits for land: the night rule stopped a walk mid-ocean and the bot trod
  // water "staying put" until it drowned (2026-09-23). Only the operator's stop (control) ends a trip afloat.
  const shouldStop = stop0 ? () => stop0() && !bot.vehicle && !boat.swimming(bot) : null
  const t0 = Date.now()
  const cancelled = control.token()
  let legFails = 0
  let surfaceTries = 0
  let lastLog = 0
  let boatFails = 0
  let buriedSaid = false
  while (Date.now() - t0 < maxMs) {
    if (!bot.entity) return { ok: false, why: 'no body' }
    // A PLACE INSIDE THE ROCK is no walk: the planner's way there is a shaft dug straight down - a remembered deepslate
    // 112 under home ("9b" away, counted flat) was walked to, the pick wore out at y28 and the bot fell 20 down its own
    // shaft climbing out, dead (2026-09-29). Judged by the target's column, not its height - a river bank 56 under a
    // hilltop home is open sky, a walk (audit). Asked every leg: known once its column is loaded. The mine's stairs go
    // down; the walks that must go there say so (underground: a grave, the operator's goto, the mine's own)
    if (!underground && !anyY && target && target.y != null && !buriedSaid) {
      const bd = buried(bot, target)
      if (bd) { buriedSaid = true; log('move', `${label}: ${fmt(target)} is inside the rock (${bd} blocks of it overhead) - a mine's way down, never a shaft`); return { ok: false, why: 'underground - a mine way down, never a shaft' } }
    }
    if (cancelled()) return { ok: false, why: 'stopped' }
    if (shouldStop && shouldStop()) return { ok: false, why: 'stopped' }
    // afloat in a boat (a crossing broken off, or a restart put us back in it): carry on by boat - or, when the
    // boat keeps failing out here, get out and swim
    if (boat.inBoat(bot)) {
      if (boatFails >= 3) { log('move', `${label}: the boat keeps failing here - getting out to swim`); await boat.leave(bot); continue }
      const r = await boat.cross(bot, target, { range, shouldStop })
      if (r.why === 'stopped') return { ok: false, why: 'stopped' }
      boatFails = boatScore(r, boatFails)
      continue
    }
    const me = bot.entity.position
    const dxz = world.dist2(me, target)
    // in our own mine: walk out the way we came (tunnel and stairs) rather than pillar up through rock -
    // without a pickaxe that is 7.5s a block
    const mine = require('./memory').get().mine
    // (IN it - on the mine's own path: 90 of the cursor counted an ore dug 50 across and 40 below as "in the mine", and the walk
    //  to the entrance tunnelled across and pillared the entrance column 40 high where the climb straight up was shorter,
    //  2026-09-28)
    if (surfaceTries === 0 && isUnderground(bot) && mine && mine.entrance && mine.cursor && require('./mining').inOwnMine(bot) && world.dist3(me, mine.entrance) > 4 && !(target.y < me.y - 4)) {
      surfaceTries++
      // (the time the way out takes: a flight from y16 is 110+ stair cells - 120s fell short and the bot dug up through the
      //  rock instead; audit 2026-10-02)
      const out = await goTo(bot, new goals.GoalBlock(mine.entrance.x, mine.entrance.y, mine.entrance.z), { timeoutMs: Math.max(120000, Math.min(480000, world.dist3(me, mine.entrance) * 2500)), stuckMs: 15000, label: 'out of the mine', shouldStop })
      if (out.ok) continue
    }
    if (dxz <= Math.max(range, 24)) {
      if (target.y - me.y > 4 && isUnderground(bot) && surfaceTries < 3) { surfaceTries++; await surface(bot, { shouldStop }); continue }
      const r = await goTo(bot, anyY ? new goals.GoalNearXZ(target.x, target.z, range) : new goals.GoalNear(target.x, target.y, target.z, range), { timeoutMs: 60000, label, shouldStop })
      return r
    }
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log('move', `${label}: ${Math.round(dxz)}b to ${fmt(target)} from ${fmt(me)}`) }
    // long walks happen on the surface, never as a tunnel through rock
    if (dxz > 48 && surfaceTries < 3 && isUnderground(bot) && !(target.y < me.y - 4)) { surfaceTries++; await surface(bot, { shouldStop }); continue }
    let step = Math.min(40, dxz)
    // open water on the line ahead: at its edge, cross by boat; before it, walk only as far as the shore (a leg aimed into
    // the sea swam out to its end). No boat that works: a short stretch is swum, a long one is not started.
    // the leg's own heading (a failed leg bends it): the water on THAT line is what this leg would swim - judged every
    // leg, not only on a straight one (a bent 40-block leg aimed out over the sea, swam, and the "no boat" guard never ran
    // because by then the bot was swimming; audit R2, 2026-09-27)
    const ang = Math.atan2(target.z - me.z, target.x - me.x) + (legFails === 0 ? 0 : (legFails % 2 ? 1 : -1) * 0.6 * Math.ceil(legFails / 2))
    let strandedSwim = false
    {
      const along = { x: me.x + Math.cos(ang) * dxz, y: me.y, z: me.z + Math.sin(ang) * dxz }
      const kinds = boat.scanLine(bot, me, along)
      const plan = boat.decideLeg(kinds, { swimming: boat.swimming(bot), step })
      // (while a boat is being made - a walk to the trees inside ensureBoat - only the launch waits: the swim refusal and
      //  the walk to the shore still hold; audit #4)
      if (plan.mode === 'boat' && boatFails < 3 && !boat.busy()) {
        log('move', `${label}: open water ahead (${plan.run}b+ from ${plan.waterAt}b out) - crossing by boat`)
        const r = await boat.cross(bot, target, { range, shouldStop })
        if (r.why === 'stopped') return { ok: false, why: 'stopped' }
        boatFails = boatScore(r, boatFails)
        continue
      }
      // no boat (or none that launches) and more water on this heading than a swim: never start swimming it from land -
      // the walk ends here and says why; with no boat the kit wants one (wantBoat) and the tools task makes it (audit #31, R3)
      // (the refusal is not for ever: on a treeless islet no boat can ever be made, and "not swimming it" came back each
      //  leg - the third refusal here in a row, with no tree in sight, swims after all, up to SWIM_LAST_RESORT; audit R3)
      // ...only to a far shore SEEN on the line (the water run ends in land inside the scan, no unloaded column in it), in
      // daylight with the crossing's time left, above the hurt line and fed - never into sea of unknown width at night
      // (the scan stops at 64, so a length cap alone capped nothing; audit A)
      const w0 = plan.waterAt ? plan.waterAt - 1 : -1; const run = w0 < 0 ? '' : kinds.slice(w0).split('l')[0] // (the run decideLeg judged: one rule)
      const shoreSeen = w0 >= 0 && kinds.indexOf('l', w0) > w0 && !run.includes('?')
      const fit = world.phase(bot) === 'day' && world.ticksUntilNight(bot) > run.length * 20 + 1200 && bot.health > (reflexRef && reflexRef.hurtLine ? reflexRef.hurtLine() : 9) && bot.food > 6
      const stranded = plan.mode === 'boat' && boatFails >= 3 && shoreSeen && fit && strandedAt(bot) >= 2 && !world.findBlocks(bot, /_log$/, { maxDistance: 32, count: 1 }).length
      strandedSwim = stranded
      if (stranded) log('move', `${label}: no boat and no tree to make one here - swimming the ${plan.run}b+ to the far shore as the last resort`)
      if (!stranded && plan.mode === 'boat' && boatFails >= 3 && plan.run > SWIM_MAX && !boat.swimming(bot)) {
        noteStranded(bot)
        const noBoat = !boat.boatItem(bot) // (boat.js's one rule: a bamboo raft is a boat too - audit #7)
        log('move', `${label}: ${plan.run}b+ of open water on this heading and ${noBoat ? 'no boat' : 'the boat keeps failing to launch here'} - not swimming it`)
        if (noBoat) require('./memory').set('wantBoat', true)
        return { ok: false, why: noBoat ? 'no boat for open water' : 'boat launches failing' }
      }
      if (plan.toShore) step = plan.legLen // (walk only as far as the shore either way)
    }
    let lx = Math.round(me.x + Math.cos(ang) * step)
    let lz = Math.round(me.z + Math.sin(ang) * step)
    // from land a leg never ENDS in water: the end is drawn back along the heading to the last land (the backstop under
    // decideLeg - a leg end over the sea is a swim goal; audit B1)
    if (!boat.swimming(bot) && !bot.vehicle && !strandedSwim) { // (the last-resort swim is the one leg that ends in water: B)
      for (let k = Math.round(step); k >= 2; k--) {
        const x = Math.round(me.x + Math.cos(ang) * k); const z = Math.round(me.z + Math.sin(ang) * k)
        const g0 = world.groundY(bot, x, z, Math.floor(me.y) + 30)
        if (g0 == null || !world.isWaterBlock(world.at(bot, x, g0, z))) { lx = x; lz = z; break }
      }
    }
    // (never inside the build or a remembered trap: legPoint)
    { let box = null; try { const j = require('./build').getJob(); box = j && j.box } catch {}
      const traps = (require('./memory').get().trapCells || []).filter(t => t.day != null && trapLive(bot, t))
      const lp = legPoint(me, lx, lz, target, box, traps)
      if (lp.moved) { if (legSaid !== lp.moved + lp.x + lp.z) { legSaid = lp.moved + lp.x + lp.z; log('move', `${label}: the leg goes ${lp.moved} - to ${lp.x},${lp.z}`) } lx = lp.x; lz = lp.z } }
    // aim at the SURFACE of the leg point when we can see it: an x/z-only goal lets the planner route
    // through caves and come up under the destination
    const gy = world.groundY(bot, lx, lz, Math.floor(me.y) + 30)
    // (a leg ending at the target's own column aims at the target: its "surface" there can be a roof over it - home's leg
    //  aimed at the safehouse roof, the planner climbed at the shut door and the walk stalled 45s on the step, 2026-10-06)
    const atTarget = !anyY && target.y != null && Math.hypot(lx - target.x, lz - target.z) <= 4
    const legGoal = atTarget ? new goals.GoalNear(target.x, target.y, target.z, range) : (gy != null && !world.isWaterBlock(world.at(bot, lx, gy, lz))) ? new goals.GoalNear(lx, gy + 1, lz, 4) : new goals.GoalNearXZ(lx, lz, 4)
    const edges0 = reflexRef && reflexRef.edgeStops ? reflexRef.edgeStops() : 0
    const r = await goTo(bot, legGoal, { timeoutMs: 45000, stuckMs: 10000, label: label + ' leg', shouldStop })
    const edged = !!(reflexRef && reflexRef.edgeStops) && reflexRef.edgeStops() > edges0
    // (new ground in view: note the sand, gravel and clay along the way - in the background)
    try { require('./gather').survey(bot) } catch {}
    const moved = world.dist2(bot.entity.position, me)
    // (a leg that "arrived" without moving is no progress: at a shore the leg shrank to the water's edge 3 blocks off,
    //  already inside its goal - "arrived" twelve times a minute, legFails never rose, no swim or other heading was
    //  tried, and the loop starved the process into a restart, 2026-09-26)
    if (r.ok && moved >= 2) { legFails = 0; stranded = { at: null, n: 0 }; continue } // (a leg that got somewhere: not stranded)
    if (r.ok) { if (++legFails >= 6) { log('move', `${label}: no headway ${Math.round(dxz)}b short at ${fmt(bot.entity.position)}`); return { ok: false, why: 'stuck: no headway' } } continue }
    if (r.why === 'died' || r.why === 'stopped') return r
    // (a leg that failed against a drop the edge guard refused: the ground says not this way - bend the heading, even
    //  after progress. "Partial progress" reset the count and the next leg went at the same cliff; the bot fell 17
    //  blocks 1.2s into it, 2026-09-28)
    if (edged) {
      if (++legFails >= 6) { log('move', `${label}: stuck ${Math.round(dxz)}b short at ${fmt(bot.entity.position)} (drops every way)`); return { ok: false, why: 'stuck: drops' } }
      log('move', `${label}: the way on ends at a drop - bending the heading`)
      continue
    }
    if (moved > 8) { legFails = 0; continue } // partial progress is progress
    // (a leg failed from inside a build's footprint below its floor - the hollow, a pit: the planner never plans the tower
    //  out, and leg after leg from cells a step apart never trips the same-cell climb; circled three minutes under the
    //  castle, 2026-09-29. The climb straight out, then the legs go on; audit)
    if (isVerdict(r)) {
      const jb = require('./build').getJob(); const bb = jb && jb.box; const fp = bot.entity.position.floored()
      if (bb && fp.x >= bb.x1 && fp.x <= bb.x2 && fp.z >= bb.z1 && fp.z <= bb.z2 && fp.y < bb.y1) { log('move', `${label}: no walk out from below the build's floor - climbing out`); await escapeUp(bot).catch(() => false) } // (and the failed leg still counts: six and the walk ends)
    }
    if (++legFails >= 6) { log('move', `${label}: stuck ${Math.round(dxz)}b short at ${fmt(bot.entity.position)} (${r.why})`); return { ok: false, why: 'stuck: ' + r.why } }
  }
  return { ok: false, why: 'timeout' }
}

const refusedNodes = new Map() // "x,y,z" -> until: path nodes whose jump the edge guard refused (reflex.noteJump)
function refuseNode (n, ms = 120000) {
  if (!n || n.x == null) return
  const k = Math.floor(n.x) + ',' + Math.floor(n.y) + ',' + Math.floor(n.z)
  if (refusedNodes.size > 200) { const now = Date.now(); for (const [kk, t] of refusedNodes) if (t < now) refusedNodes.delete(kk) }
  refusedNodes.set(k, Date.now() + ms)
}
module.exports = { refuseNode, closedDoorAt, buried, legPoint, escapeUp, isVerdict, stuckPlace, underBuild, underZone, inForeign, crossDoor, goals, bindReflex, bindBot, setZone, setZones, inZone, zones, utilitySpotOK, insideHut, setProtector, isProtected, surface, isUnderground, surfaceYHere, movementsFor, goTo, goNear, travel, stopMoving, runGoal, sleep, fmt, waitReflex }
