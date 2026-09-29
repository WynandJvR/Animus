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
function bindBot (b) { botRef = b; try { b.on('path_reset', () => { pathGen++ }) } catch {} }
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
    // anywhere along the staircase line between entrance and cursor
    if (m.entrance && m.cursor) {
      const minx = Math.min(m.entrance.x, m.cursor.x) - 1; const maxx = Math.max(m.entrance.x, m.cursor.x) + 1
      const minz = Math.min(m.entrance.z, m.cursor.z) - 1; const maxz = Math.max(m.entrance.z, m.cursor.z) + 1
      const miny = Math.min(m.entrance.y, m.cursor.y) - 1; const maxy = Math.max(m.entrance.y, m.cursor.y) + 2
      if (p.x >= minx && p.x <= maxx && p.z >= minz && p.z <= maxz && p.y >= miny && p.y <= maxy) return false
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
function isProtected (block, purpose = 'walk') {
  if (!protector || !block || !block.position) return false
  try { return !!protector(block, purpose) } catch { return false }
}

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
  m.getBlock = (pos, dx, dy, dz) => {
    const b = getBlock0(pos, dx, dy, dz)
    if (b && doorIds.has(b.type)) { b.safe = true; b.physical = false; b.replaceable = false; b.height = pos.y + dy }
    // (an OPEN trapdoor is no floor: a plate on its edge - planned on as ground, the walk stepped into the hole it hangs
    //  in, 2026-09-29. Nor a passage: the plate stops the body, and planned as one the walk stood 2 minutes against the
    //  castle's trapdoor rail, 2026-09-29. Neither - not stood on, not walked through, no landing)
    else if (b && b.physical && world.isOpenTrapdoor(b)) { b.safe = false; b.physical = false; b.replaceable = false; b.height = pos.y + dy }
    return b
  }
  m.exclusionAreasStep.push(block => (block && doorIds.has(block.type)) ? 4 : 0)
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
  const diag0 = m.getMoveDiagonal.bind(m)
  m.getMoveDiagonal = (node, dir, neighbors) => {
    if (hurtsAt(node.x, node.y, node.z + dir.z) || hurtsAt(node.x + dir.x, node.y, node.z)) return
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
      if (f && /_leaves$/.test(f.name)) { let pr = {}; try { pr = f.getProperties() || {} } catch {} if (pr.persistent === false || pr.persistent === 'false') v = 25 }
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
    return dropAt(p.x, p.y, p.z) > world.SAFE_DROP ? 101 : 0
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
  const cancelled = control.token()
  return new Promise(resolve => {
    let done = false
    let best = goalDistance(bot, goal)
    let bestAt = Date.now()
    let noPaths = 0
    const started = Date.now()
    const finish = (ok, why) => {
      if (done) return
      done = true
      clearInterval(timer)
      bot.removeListener('goal_reached', onReached)
      bot.removeListener('path_update', onPath)
      bot.removeListener('death', onDeath)
      if (!ok || why !== 'reached') stopMoving(bot)
      resolve({ ok, why })
    }
    const onReached = () => { if (goal.isEnd(bot.entity.position.floored())) finish(true, 'reached') }
    const onPath = r => {
      if (r.status === 'noPath' && r.path.length === 0) {
        if (++noPaths >= 3 && !goal.isEnd(bot.entity.position.floored())) finish(false, 'noPath')
      } else if (r.path.length) noPaths = 0
    }
    const onDeath = () => finish(false, 'died')
    let doorAt = 0
    const timer = setInterval(() => {
      if (!bot.entity) return finish(false, 'died')
      // walking into a closed door (the plan goes through doors now): open it, as a player does
      if (Date.now() - doorAt > 1200) { const dd = closedDoorAt(bot); if (dd) { doorAt = Date.now(); bot.activateBlock(dd).catch(() => {}) } }
      if (goal.isEnd(bot.entity.position.floored())) return finish(true, 'reached')
      if (cancelled()) return finish(false, 'stopped')
      if (reflexActive()) return finish(false, 'interrupted')
      const d = goalDistance(bot, goal)
      const busy = bot.pathfinder.isMining() || bot.pathfinder.isBuilding()
      if (d < best - 0.9 || busy) { if (d < best) best = d; bestAt = Date.now() }
      if (Date.now() - bestAt > stuckMs) return finish(false, 'stuck')
      if (Date.now() - started > timeoutMs) return finish(false, 'timeout')
    }, 250)
    bot.on('goal_reached', onReached)
    bot.on('path_update', onPath)
    bot.on('death', onDeath)
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.setGoal(goal)
  })
}

async function waitReflex (bot, maxMs = 60000) {
  const t0 = Date.now()
  while (reflexActive() && Date.now() - t0 < maxMs) await sleep(250)
}
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

// Get out of a spot the planner keeps failing from: step back, jump, or tower one block.
// (only a way that is not over a drop: a random key and a jump at the castle's south rim - a strafe, which neither the jump
//  guard's heading nor the edge brake reads, and a brake that lets go in the air - fell 5 blocks twice, 2026-09-28. The
//  keys are the body's own frame: forward along the look, left and right across it. No safe way, no jiggle)
async function jiggle (bot) {
  const e = bot.entity; const p = e.position
  const fx = -Math.sin(e.yaw); const fz = -Math.cos(e.yaw)
  const vec = { forward: [fx, fz], back: [-fx, -fz], left: [fz, -fx], right: [-fz, fx] }
  const y = Math.floor(p.y + 0.01)
  const safe = Object.keys(vec).filter(k => [0.8, 1.6].every(r => world.dropAt(bot, p.x + vec[k][0] * r, y, p.z + vec[k][1] * r) <= world.SAFE_DROP))
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
    return !!c && !c.clear && !bj.partOk(c, b.name)
  }
  const act = require('./act')
  for (const [x, z] of axisX ? [[d.x - 1, d.z], [d.x + 1, d.z]] : [[d.x, d.z - 1], [d.x, d.z + 1]]) {
    for (const dy of [1, 0]) if (obstruction(x, d.y + dy, z)) { log('move', `the doorway at ${fmt(d)}: ${world.at(bot, x, d.y + dy, z).name} stands in a cell of the build at ${x},${d.y + dy},${z} - clearing it`); await act.dig(bot, { x, y: d.y + dy, z }, { allowZones: ['build', 'base'], timeoutMs: 8000 }).catch(() => false) }
  }
  const stepAt = (x, z) => { for (const dy of [0, 1, -1]) if (world.standable(bot, x, d.y + dy, z)) return { x, y: d.y + dy, z }; return { x, y: d.y, z } }
  const sideA = axisX ? stepAt(d.x - 1, d.z) : stepAt(d.x, d.z - 1)
  const sideB = axisX ? stepAt(d.x + 1, d.z) : stepAt(d.x, d.z + 1)
  // (a door with no place to stand on one side - a castle door opening onto a rail of open trapdoors on edge - leads
  //  nowhere: 40s a try walking to a step that is not there, 2026-09-29. Not this door; the stall looks elsewhere)
  // (never the safehouse's own night seal - its step blocked on purpose, opened by unsealDoor above: exempt; audit)
  const sealed = p => ((require('./memory').get().doorSeal || {}).cells || []).some(c => c.x === p.x && c.z === p.z && (c.y === p.y || c.y === p.y + 1))
  { const noStep = [sideA, sideB].find(p => !world.standable(bot, p.x, p.y, p.z) && !sealed(p)); if (noStep) { log('move', `the door at ${fmt(d)} has nowhere to stand on its side at ${fmt(noStep)} - not through this one`); return false } }
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
    const goalIn = gp && goal.y != null ? insideHut({ x: goal.x, y: goal.y, z: goal.z }) : false
    if (meIn) exit = inA ? sideB : sideA
    else if (goalIn) exit = inA ? sideA : sideB
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
  return passed
}

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
async function goToInner (bot, goal, opts, a) {
  const start = bot.entity ? bot.entity.position.clone() : null
  const r = await goToInner2(bot, goal, opts, a)
  // a walk that ended where it began, stuck or out of time: a give-up from this cell (the pit under the farm held the
  // bot through walks that all ran out their time - "timeout" never counted, and it stood there another hour)
  // (below a build's floor inside its footprint ONE such walk is enough: the hollow's give-ups drift a cell each - -607,
  //  -606, -605 - the same-cell count never reached two, and the bot missed its bed and dug in under the castle, 2026-09-29)
  if (!r.ok && start && bot.entity && /stuck|timeout|noPath/.test(r.why) && bot.entity.position.distanceTo(start) < 2 && (stuckHereAgain(bot) || underBuildFloor(bot))) await escapeUp(bot)
  return r
}
async function goToInner2 (bot, goal, opts, { timeoutMs, stuckMs, dig, place, allowZones, label, shouldStop, dryHead }) {
  const deadline = Date.now() + timeoutMs
  const cancelled = control.token()
  let fails = 0
  let interrupts = 0
  let instant = 0
  while (Date.now() < deadline) {
    // (a turn for the event loop every round: a plan that fails at once - 'interrupted' back to back, a goal with no way -
    //  went round on resolved promises and held the loop 10.9s picking up a boat; the stall watch named this loop, 2026-09-28)
    await new Promise(resolve => setImmediate(resolve))
    if (!bot.entity) return { ok: false, why: 'no body' }
    if (cancelled()) return { ok: false, why: 'stopped' }
    if (goal.isEnd(bot.entity.position.floored())) return { ok: true, why: 'reached' }
    if (shouldStop && shouldStop()) return { ok: false, why: 'stopped' }
    await waitReflex(bot)
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
    const r = await runGoal(bot, goal, { timeoutMs: Math.max(2000, deadline - Date.now()), stuckMs, movements: movementsFor(bot, { dig, place, allowZones: zonesOk, dryHead }) })
    if (r.ok) return r
    // (a plan that failed at once, going nowhere, three times over from here: a verdict, not bad luck - said, not cycled
    //  to the deadline; audit 2026-09-28)
    // (an interruption is the reflex taking the body - a fight, the edge brake - never a verdict on the way: counted here
    //  one fight by a known tree read "noPath" and the tree was forgotten; audit 2026-09-28)
    if (r.why !== 'interrupted' && Date.now() - tRun < 120 && bot.entity.position.distanceTo(pRun) < 0.1) { if (++instant >= 3) return { ok: false, why: r.why || 'noPath' } } else if (r.why !== 'interrupted') instant = 0
    if (r.why === 'died') return r
    if (r.why === 'interrupted') { if (++interrupts > 20) return { ok: false, why: 'interrupted' }; await waitReflex(bot); continue } // (the body is busy: wait for the reflex, then go on - "interrupted", never "blocked")
    if (r.why === 'timeout') return r
    fails++
    // a stall next to a door is a door the planner would not open: cross it by hand
    if (await crossDoor(bot, goal).catch(e => { log('move', `door crossing threw: ${e.message}`); return false })) { fails = 0; continue }
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
      log('move', `${label}: gave up (${r.why} x${fails}) at ${fmt(bot.entity.position)}${why2}`)
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
const giveUps = new Map() // cell -> [times]
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
  const k = fmt(bot.entity.position); const now = Date.now()
  const t = (giveUps.get(k) || []).filter(x => now - x < 5 * 60000); t.push(now); giveUps.set(k, t)
  return t.length >= 2
}
let escaping = false // (its own walks give up too: never re-entered)
async function escapeUp (bot) {
  if (escaping) return false
  escaping = true
  try { return await escapeUpInner(bot) } finally { escaping = false }
}
async function escapeUpInner (bot) {
  const act = require('./act'); const gather = require('./gather')
  const f0 = bot.entity.position.floored()
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
    if (inFoot && !build.wayOut(bot, { x: NaN, y: NaN, z: NaN }, null, false)) {
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
      const sd = sides[0]
      if (sd) {
        // (a bounded tunnel along that side: a pair at a time - feet and head - stepping in and asking again after each;
        //  three at most, so a thick wall is got through and nothing longer is ever bored through the build; audit)
        let at = { x: f0.x, y: f0.y, z: f0.z }
        for (let n = 0; n < 3; n++) {
          const p0 = { x: at.x + sd.dx, y: at.y, z: at.z + sd.dz }
          if (!ours(p0.x, p0.y, p0.z) || !ours(p0.x, p0.y + 1, p0.z)) break
          for (const dy of [1, 0]) {
            const b = world.at(bot, p0.x, p0.y + dy, p0.z)
            if (b && !world.isAirish(b)) { log('move', `enclosed: taking our own ${b.name} at ${fmt({ x: p0.x, y: p0.y + dy, z: p0.z })}`); const mine = !!cellAt(p0.x, p0.y + dy, p0.z); await act.dig(bot, { x: p0.x, y: p0.y + dy, z: p0.z }, { own: mine, force: mine, noWalk: true, allowZones: ['build', 'base'], timeoutMs: 8000 }).catch(() => false) }
          }
          await act.collectDrops(bot, { radius: 4, maxMs: 3000 }).catch(() => {}) // (a door dug comes back whole: the builder re-places it)
          if (!safe(p0.x, p0.y, p0.z)) { log('move', `enclosed: the cell opened at ${fmt(p0)} stands over a drop - not stepping in`); break } // (room, and a drop a fall does not hurt)
          await goTo(bot, new goals.GoalBlock(p0.x, p0.y, p0.z), { timeoutMs: 6000, stuckMs: 3000, dig: false, place: false, label: 'out through our wall' }).catch(() => null)
          at = bot.entity.position.floored()
          if (build.wayOut(bot, { x: NaN, y: NaN, z: NaN }, null, false)) { log('move', `enclosed: a way out from ${fmt(at)}`); break }
        }
        giveUps.delete(fmt(f0))
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
      if (r.ok) { giveUps.delete(fmt(f0)); log('move', `stuck at ${fmt(f0)} - stepped aside to ${fmt(c)}`); return true }
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
  for (let i = 0; i < 16; i++) {
    const f = bot.entity.position.floored()
    // (open sky is out - but not in a pit INSIDE the build's footprint below its floor: the unbuilt corner of the castle, a
    //  6-deep hole walled round by the walls above it, read "climbed out" without a block climbed, and every walk from its
    //  bottom failed, 2026-09-29. There, up to the floor's level first, then the walk)
    const jb = require('./build').getJob(); const bb = jb && jb.box
    const pit = !!bb && f.x >= bb.x1 && f.x <= bb.x2 && f.z >= bb.z1 && f.z <= bb.z2 && f.y < bb.y1
    if (bot.entity.onGround && !world.feetInWater(bot) && world.openSky(bot, { x: f.x, y: f.y, z: f.z }) && !pit) break
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
    if (await gather.towerUp(bot, { allowZones: ['*'] })) continue // (an escape: any zone, never a build cell)
    // no towering here (in water a jump never clears a block; or nothing to place): a step cut into the side - the two
    // cells over a solid side block cleared, and up onto it
    if (!await stepUpSide(bot)) { log('move', `climbing out: no way up from ${fmt(bot.entity.position)} (no tower, no side to cut a step in)`); return false }
  }
  giveUps.delete(fmt(f0))
  log('move', `climbed out: from ${fmt(f0)} to ${fmt(bot.entity.position)}`)
  return true
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
// A roof of planks (a hut) or leaves is not being underground: it takes 3+ natural rock/earth
// blocks overhead.
function isUnderground (bot) {
  const me = bot.entity.position.floored()
  const s = surfaceYHere(bot)
  if (s == null || s - me.y < 4) return false
  let rock = 0
  for (let y = me.y + 2; y < s; y++) {
    const b = world.at(bot, me.x, y, me.z)
    if (b && b.boundingBox === 'block' && world.NATURAL_RE.test(b.name) && !world.LEAF_RE.test(b.name) && !world.LOG_RE.test(b.name)) rock++
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
    if (!await require('./gather').towerUp(bot, { allowZones: ['*'] })) break
  }
  if (!isUnderground(bot)) { log('move', `surfaced at y${Math.floor(bot.entity.position.y)} (climbed ${Math.floor(bot.entity.position.y) - y0})`); return true }
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
async function travel (bot, target, opts = {}) {
  // (anyY: a place on the map, not a block - the ground there at whatever height it is. An explore leg aimed at its own
  //  start height over a valley 50 lower; the planner towered up out of the valley toward it and the bot fell 28
  //  blocks off the pillar, 2026-09-26)
  const { range = 3, shouldStop: stop0, label = 'travel', maxMs = 15 * 60000, anyY = false } = opts
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
  while (Date.now() - t0 < maxMs) {
    if (!bot.entity) return { ok: false, why: 'no body' }
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
      const out = await goTo(bot, new goals.GoalBlock(mine.entrance.x, mine.entrance.y, mine.entrance.z), { timeoutMs: 120000, stuckMs: 15000, label: 'out of the mine', shouldStop })
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
    // aim at the SURFACE of the leg point when we can see it: an x/z-only goal lets the planner route
    // through caves and come up under the destination
    const gy = world.groundY(bot, lx, lz, Math.floor(me.y) + 30)
    const legGoal = (gy != null && !world.isWaterBlock(world.at(bot, lx, gy, lz))) ? new goals.GoalNear(lx, gy + 1, lz, 4) : new goals.GoalNearXZ(lx, lz, 4)
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

module.exports = { escapeUp, isVerdict, underBuild, underZone, crossDoor, goals, bindReflex, bindBot, setZone, setZones, inZone, zones, utilitySpotOK, insideHut, setProtector, isProtected, surface, isUnderground, surfaceYHere, movementsFor, goTo, goNear, travel, stopMoving, runGoal, sleep, fmt, waitReflex }
