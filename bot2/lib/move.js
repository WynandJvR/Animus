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
function bindBot (b) { botRef = b }
function reflexActive () { return reflexRef ? reflexRef.active() : null }

// Zones the bot must never dig/place in unless the caller says so (its own base, a build site).
// Each: {x1,y1,z1,x2,y2,z2,label}
const zones = []
function setZone (label, box) {
  const i = zones.findIndex(z => z.label === label)
  if (i >= 0) zones.splice(i, 1)
  if (box) zones.push(Object.assign({ label }, box))
}
function inZone (p, pad = 0) {
  for (const z of zones) {
    if (p.x >= z.x1 - pad && p.x <= z.x2 + pad && p.y >= (z.y1 == null ? -999 : z.y1 - pad) && p.y <= (z.y2 == null ? 999 : z.y2 + pad) && p.z >= z.z1 - pad && p.z <= z.z2 + pad) return z
  }
  return null
}

// May a utility block (table/furnace/chest/bed) go here? Not in a protected zone and not in the
// mine's walkway (a furnace on the staircase once sealed the mine face).
function utilitySpotOK (p, { temporary = false } = {}) {
  // furniture stands on the floor, never on other furniture (a furnace on a chest seals the chest shut)
  const below = botRef ? world.at(botRef, p.x, p.y - 1, p.z) : null
  if (below && /(chest|furnace|crafting_table|_bed|barrel|smoker|blast_furnace|anvil|enchanting_table)$/.test(below.name)) return false
  const z = inZone(p)
  if (z && z.label !== 'base') return false // the base is exactly where tables/furnaces/chests belong
  // never block the safehouse doorway (furniture on the step inside the door locks us out)
  const plan = require('./memory').get().hutPlan
  if (plan && plan.door && Math.abs(p.x - plan.door.x) + Math.abs(p.z - plan.door.z) <= 1 && Math.abs(p.y - plan.home.y) <= 1) return false
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
function movementsFor (bot, { dig = true, place = true, allowZones = [], sprint = true, dryHead = true } = {}) {
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
  m.placeCost = 2
  m.allow1by1towers = place
  m.scafoldingBlocks = place ? scaffoldIds.slice() : []
  m.allowParkour = false
  // walking costs no hunger, sprinting ~1 food point per 40 m: only sprint on a full belly
  m.allowSprinting = sprint === 'always' || (sprint && bot.food >= 18)
  m.maxDropDown = 3
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
    return b
  }
  m.exclusionAreasStep.push(block => (block && doorIds.has(block.type)) ? 4 : 0)
  const allowed = new Set(allowZones)
  // (blocks in unloaded chunks reach these callbacks without a position: a throw here aborts A*)
  m.exclusionAreasBreak.push(block => { if (!block || !block.position) return 0; const z = inZone(block.position); return (z && !allowed.has(z.label)) ? 100 : 0 })
  m.exclusionAreasBreak.push(block => isProtected(block, 'walk') ? 100 : 0)
  m.exclusionAreasPlace.push(block => {
    if (!block || !block.position) return 0
    const z = inZone(block.position); if (z && !allowed.has(z.label)) return 100
    return world.isWaterBlock(block) ? 100 : 0 // never build causeways into water
  })
  // Swimming along a surface is fine (the feet in the top water cell, the head in air); a path node with the HEAD
  // under water is how bots drown.
  m.exclusionAreasStep.push(block => {
    if (!block || !block.position) return 0
    const p = block.position
    const head = bot.blockAt(p.offset(0, 1, 0))
    return (head && world.isWaterBlock(head)) ? (dryHead ? 101 : 40) : 0
  })
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
async function jiggle (bot) {
  const dirs = ['back', 'left', 'right', 'forward']
  const d = dirs[Math.floor(Math.random() * dirs.length)]
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
  const sideA = axisX ? { x: d.x - 1, y: d.y, z: d.z } : { x: d.x, y: d.y, z: d.z - 1 }
  const sideB = axisX ? { x: d.x + 1, y: d.y, z: d.z } : { x: d.x, y: d.y, z: d.z + 1 }
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
      await sleep(50)
    }
    bot.setControlState('forward', false)
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
function noteWalk (label, goal) {
  if (label === 'mine step' || label === 'to tree') return // one per block of tunnel / per tree felled: many a minute is the job
  const now = Date.now()
  const k = label
  const r = recentWalks.get(k) || { n: 0, since: now, warned: 0 }
  if (now - r.since > 60000) { r.n = 0; r.since = now }
  r.n++
  recentWalks.set(k, r)
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
async function goToInner (bot, goal, opts, { timeoutMs, stuckMs, dig, place, allowZones, label, shouldStop, dryHead }) {
  const deadline = Date.now() + timeoutMs
  const cancelled = control.token()
  let fails = 0
  let interrupts = 0
  while (Date.now() < deadline) {
    if (!bot.entity) return { ok: false, why: 'no body' }
    if (cancelled()) return { ok: false, why: 'stopped' }
    if (goal.isEnd(bot.entity.position.floored())) return { ok: true, why: 'reached' }
    if (shouldStop && shouldStop()) return { ok: false, why: 'stopped' }
    await waitReflex(bot)
    // you may always work your way out of where you stand: inside the castle walls a walk to the furnace
    // could not scaffold over them (the build zone was off limits) and timed out for minutes
    // (finished build blocks stay unbreakable - the protector guards them in every zone)
    const here = inZone(bot.entity.position.floored())
    const zonesOk = here && !allowZones.includes(here.label) ? allowZones.concat([here.label]) : allowZones
    const r = await runGoal(bot, goal, { timeoutMs: Math.max(2000, deadline - Date.now()), stuckMs, movements: movementsFor(bot, { dig, place, allowZones: zonesOk, dryHead }) })
    if (r.ok) return r
    if (r.why === 'died') return r
    if (r.why === 'interrupted') { if (++interrupts > 20) return { ok: false, why: 'interrupted too often' }; continue }
    if (r.why === 'timeout') return r
    fails++
    // a stall next to a door is a door the planner would not open: cross it by hand
    if (await crossDoor(bot, goal).catch(e => { log('move', `door crossing threw: ${e.message}`); return false })) { fails = 0; continue }
    if (fails >= 3) { log('move', `${label}: gave up (${r.why} x${fails}) at ${fmt(bot.entity.position)}`); return r }
    await jiggle(bot)
  }
  return { ok: false, why: 'timeout' }
}

function fmt (p) { return p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?' }

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
    if (!await require('./gather').towerUp(bot)) break
  }
  if (!isUnderground(bot)) { log('move', `surfaced at y${Math.floor(bot.entity.position.y)} (climbed ${Math.floor(bot.entity.position.y) - y0})`); return true }
  const r = await goTo(bot, new goals.GoalY(surfaceYHere(bot) || s), { timeoutMs: 60000, stuckMs: 12000, label: 'surface', shouldStop })
  return r.ok || !isUnderground(bot)
}

// A crossing that got us somewhere clears the boat's record; a failed one - or a "crossing" of a few blocks, which is
// land and water taking turns at one spot (launch, bump, land, launch...) - counts against it. Three and travel swims.
function boatScore (r, fails) {
  if (r.why === 'no boat') return 3
  if (!r.ok || (r.travelled || 0) < 8) return fails + 1
  return 0
}

// Long distance: legs of ~40 blocks toward the target so A* never searches unloaded space.
// A failed leg bends left/right before giving up. Open water on the line is crossed by boat (boat.js).
async function travel (bot, target, opts = {}) {
  const { range = 3, shouldStop: stop0, label = 'travel', maxMs = 15 * 60000 } = opts
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
    if (surfaceTries === 0 && isUnderground(bot) && mine && mine.entrance && mine.cursor && world.dist3(me, mine.cursor) < 90 && world.dist3(me, mine.entrance) > 4 && !(target.y < me.y - 4)) {
      surfaceTries++
      const out = await goTo(bot, new goals.GoalBlock(mine.entrance.x, mine.entrance.y, mine.entrance.z), { timeoutMs: 120000, stuckMs: 15000, label: 'out of the mine', shouldStop })
      if (out.ok) continue
    }
    if (dxz <= Math.max(range, 24)) {
      if (target.y - me.y > 4 && isUnderground(bot) && surfaceTries < 3) { surfaceTries++; await surface(bot, { shouldStop }); continue }
      const r = await goTo(bot, new goals.GoalNear(target.x, target.y, target.z, range), { timeoutMs: 60000, label, shouldStop })
      return r
    }
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log('move', `${label}: ${Math.round(dxz)}b to ${fmt(target)} from ${fmt(me)}`) }
    // long walks happen on the surface, never as a tunnel through rock
    if (dxz > 48 && surfaceTries < 3 && isUnderground(bot) && !(target.y < me.y - 4)) { surfaceTries++; await surface(bot, { shouldStop }); continue }
    let step = Math.min(40, dxz)
    // open water on the line ahead: at its edge, cross by boat; before it, walk only as far as the shore
    // (a leg aimed into the sea swam out to its end). No boat to be had / launches failing: swim, as before.
    if (legFails === 0 && boatFails < 3 && !boat.busy()) {
      const plan = boat.decideLeg(boat.scanLine(bot, me, target), { swimming: boat.swimming(bot), step })
      if (plan.mode === 'boat') {
        log('move', `${label}: open water ahead (${plan.run}b+ from ${plan.waterAt}b out) - crossing by boat`)
        const r = await boat.cross(bot, target, { range, shouldStop })
        if (r.why === 'stopped') return { ok: false, why: 'stopped' }
        boatFails = boatScore(r, boatFails)
        continue
      }
      if (plan.toShore) step = plan.legLen
    }
    const ang = Math.atan2(target.z - me.z, target.x - me.x) + (legFails === 0 ? 0 : (legFails % 2 ? 1 : -1) * 0.6 * Math.ceil(legFails / 2))
    const lx = Math.round(me.x + Math.cos(ang) * step)
    const lz = Math.round(me.z + Math.sin(ang) * step)
    // aim at the SURFACE of the leg point when we can see it: an x/z-only goal lets the planner route
    // through caves and come up under the destination
    const gy = world.groundY(bot, lx, lz, Math.floor(me.y) + 30)
    const legGoal = (gy != null && !world.isWaterBlock(world.at(bot, lx, gy, lz))) ? new goals.GoalNear(lx, gy + 1, lz, 4) : new goals.GoalNearXZ(lx, lz, 4)
    const r = await goTo(bot, legGoal, { timeoutMs: 45000, stuckMs: 10000, label: label + ' leg', shouldStop })
    if (r.ok) { legFails = 0; continue }
    if (r.why === 'died' || r.why === 'stopped') return r
    const moved = world.dist2(bot.entity.position, me)
    if (moved > 8) { legFails = 0; continue } // partial progress is progress
    if (++legFails >= 6) { log('move', `${label}: stuck ${Math.round(dxz)}b short at ${fmt(bot.entity.position)} (${r.why})`); return { ok: false, why: 'stuck: ' + r.why } }
  }
  return { ok: false, why: 'timeout' }
}

module.exports = { crossDoor, goals, bindReflex, bindBot, setZone, inZone, zones, utilitySpotOK, insideHut, setProtector, isProtected, surface, isUnderground, surfaceYHere, movementsFor, goTo, goNear, travel, stopMoving, runGoal, sleep, fmt, waitReflex }
