'use strict'
// CLAY - the long pole of a brick build (~310 blocks for the basilica). Clay lies in discs on the bottom of
// shallow water: rivers, lakes, swamps, beaches. A player finds it by looking (the client sees through water:
// findBlocks lists it), walks to the water's edge and digs it with a shovel from the bank or wading, head above
// the surface - or, where the clay lies under 2-4 blocks of water (the common case: bank digging reaches only
// the clay right beside the bank), by DIVING like a player: swim out over it, sink to the bed, dig every clay
// block in reach on one breath, swim straight up, and pick the balls off the surface where they bob up. The dive is
// a declared, bounded exception to the air reflex (reflex.startDive); every walk here still keeps the head in air
// (a surface swim has the feet in the top water cell, the head out). The pier causeway this replaced cost a day
// for four balls (2026-09-22: the planner would not step between submerged pier blocks; the balls floated off).
// One trip is a big batch (the walk costs more than the digging): up to ~64 blocks, 256 balls.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const gatherLib = () => require('./gather')
const craft = () => require('./craft')
const base = () => require('./base')

const CLAY_RE = /^clay$/
const SEARCH_RADIUS = 320 // from home: past that a trip is most of a day
const REACH = 4.3 // eye to block centre: act.dig's own reach (depth-2 clay one block off the bank is 4.24)
const MAX_DIVE_DEPTH = 4 // water over the bed: deeper, the way down and up eats the breath
const DIVE_MS = 8000 // back at the surface by 8s of the 15s of air (the reflex's own hard limit is 11s)
const AIR_FULL_MS = 14000 // a dive starts on a full breath (a quick surface does not refill the air)
const EXHAUSTED_AFTER = 18 // scouting legs without a single diggable clay block: nothing within range

function balls (bot) { return inv.count(bot, 'clay_ball') }
function home () { return mem.get().home }
function key (p) { return `${p.x},${p.y},${p.z}` }

// Never in the base or the build (their ground is not ours to dig), nor in the safehouse.
function outOfZones (p) { return !move.inZone(p, 3) && !move.insideHut(p) }

// Clay we may dig without harm:
//  - under water: the hole just fills with water, nothing spreads onto land
//  - dry, with no water touching it at its level: ordinary ground
// but never a dry block beside the water (the bank): opening it lets the water out over the path we stand on.
function diggable (bot, p) {
  const up = world.at(bot, p.x, p.y + 1, p.z)
  if (!up) return false
  if (world.isWaterBlock(up)) return true
  if (!world.isAirish(up)) return false // buried: not ours to tunnel for
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (world.isWaterBlock(world.at(bot, p.x + dx, p.y, p.z + dz))) return false
  }
  return true
}

// Can a player stand here and breathe? Solid floor, feet in air or shallow water, HEAD IN AIR, outside the zones.
// The rule for every cell this skill walks to (a swim goes to a surface cell: floatCell).
function breathStand (bot, x, y, z) {
  const floor = world.at(bot, x, y - 1, z); const feet = world.at(bot, x, y, z); const head = world.at(bot, x, y + 1, z)
  if (!floor || !feet || !head) return false
  if (!world.isSolid(floor) || world.DANGER_FLOOR_RE.test(floor.name)) return false
  if (!(world.isAirish(feet) || world.isWaterBlock(feet)) || !world.isAirish(head)) return false
  return outOfZones({ x, y, z })
}
function eyeDist (s, x, y, z) { const ex = s.x + 0.5 - x; const ey = s.y + 1.62 - y; const ez = s.z + 0.5 - z; return Math.sqrt(ex * ex + ey * ey + ez * ez) }
// From the stand `s`, is the block `p` within dig reach? Never in our own column: the block under the feet is our
// floor.
function digsFrom (s, p) { return !(s.x === p.x && s.z === p.z) && eyeDist(s, p.x + 0.5, p.y + 0.5, p.z + 0.5) <= REACH }

// A cell to dig `p` from: a breathing stand with the block's centre within reach of the eye. Dry feet first, then
// the nearest to us.
function standFor (bot, p) {
  const me = bot.entity.position
  let best = null
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let fy = p.y + 1; fy <= p.y + 4; fy++) {
    const x = p.x + dx; const z = p.z + dz
    if (!breathStand(bot, x, fy, z) || !digsFrom({ x, y: fy, z }, p)) continue
    const wet = world.isWaterBlock(world.at(bot, x, fy, z)) ? 3 : 0
    const d = Math.hypot(x + 0.5 - me.x, fy - me.y, z + 0.5 - me.z) + wet
    if (!best || d < best.d) best = { x, y: fy, z, d }
  }
  return best
}

// Deposits dug out (or left with only clay no head-in-air cell reaches): not counted again.
function spent () { return mem.get().claySpent || [] }
function markSpent (p) { mem.update(m => { m.claySpent = (m.claySpent || []).concat([{ x: p.x, y: p.y, z: p.z }]).slice(-40) }); gatherLib().forgetResource('clay', p) }
function nearSpent (p) { return spent().some(s => world.dist3(s, p) < 12) }
function inRange (p) { const h = home(); return !h || world.dist2(p, h) <= SEARCH_RADIUS }

// The clay we can see from here that is worth a walk, nearest first.
// Clay (and the water it lies under) that is under the open sky - a river, a lake, a beach. Water in a cave
// has air over it too: 2026-09-22 the scout walked to "water" at y33, y-2 and y-28 in a cave system and the bot
// died to zombies at y29. The height test first: it is the cheap one, and it runs on every water block in range.
function nearSurface (p) { const h = home(); return !h || p.y >= h.y - 20 }
function underSky (bot, p) {
  let y = p.y + 1
  for (let i = 0; i < 6; i++, y++) { const b = world.at(bot, p.x, y, p.z); if (!b || !world.isWaterBlock(b)) break }
  const top = world.at(bot, p.x, y, p.z)
  return !!top && world.isAirish(top) && world.openSky(bot, { x: p.x, y: y - 1, z: p.z })
}
// (sky: false inside a deposit already chosen from the surface - a block under the bank's lip is still ours)
// THE rule for clay worth going to - the scan here and the explore's "found some" test both use it. With two rules
// the explore stopped at clay of a deposit already dug out (the scan skips those), the scan saw nothing, and the bot
// explored again every 8s with a findBlocks each tick until the event loop starved and the supervisor killed the
// process - it came back up in the river and drowned (2026-09-23).
function claySought (bot, p, { sky = true } = {}) {
  return nearSurface(p) && outOfZones(p) && inRange(p) && !nearSpent(p) && (!sky || underSky(bot, p)) && diggable(bot, p)
}
function visibleClay (bot, maxDistance = 128, point, { sky = true } = {}) {
  return world.findBlocks(bot, CLAY_RE, { maxDistance, count: 48, point: point ? new Vec3(point.x, point.y, point.z) : undefined, filter: b => claySought(bot, b.position, { sky }) })
}
function findDeposit (bot) {
  const seen = visibleClay(bot)[0]
  if (seen) return seen.position
  const known = gatherLib().knownResource('clay', bot.entity.position, { maxFromHome: SEARCH_RADIUS })
  return known && !nearSpent(known) ? known : null
}

// Ticks to walk home from here (a little over walking pace, for the detours).
function walkTicks (bot) { const h = home(); return h ? world.dist2(bot.entity.position, h) / 4.3 * 20 * 1.4 : 0 }
// Stop digging when the daylight left is only the walk home and a margin: the director wants the bot home
// before dusk, and a clay bank far from home is no place to meet the night.
function mustTurnBack (bot) { return world.phase(bot) !== 'day' || world.ticksUntilNight(bot) < walkTicks(bot) + 1800 }
// Worth setting out now? There and back plus a few minutes at the water, with daylight to spare.
function tripFits (bot) {
  const h = home() || bot.entity.position
  const dep = gatherLib().knownResource('clay', h, { maxFromHome: SEARCH_RADIUS })
  const d = dep ? world.dist2(dep, h) : 160
  // (and a body fit to dive: most clay here lies 2-3 deep, and a walk out to find the dive refused is a trip wasted)
  return world.phase(bot) === 'day' && world.ticksUntilNight(bot) > 2 * (d / 4.3 * 20 * 1.4) + 3600 && bot.health >= 14 && bot.food >= 6
}
// The whole reach round home was walked and no clay seen: bricks cannot be made here. Kept per home (a new
// home is new ground); only the operator can decide what stands in for bricks.
function exhausted () { const s = mem.get().claySearch; const h = home(); return !!(s && s.exhausted && h && world.dist2(s.home, h) < 16) }

async function ensureShovel (bot, ctx) {
  if (inv.bestTool(bot, 'shovel', 4)) return true
  for (const n of ['iron_shovel', 'stone_shovel']) if (base().bankCount(n) > 0) { await base().withdraw(bot, n, 1).catch(() => 0); if (inv.bestTool(bot, 'shovel', 4)) return true }
  // (the bank's cobblestone and sticks are fair game: noWithdraw here reached the whole recipe tree and sent the bot
  //  to dig stone for a shovel with a chest full of cobblestone, 2026-09-23 - the shovels were already looked for above)
  await craft().ensure(bot, 'stone_shovel', inv.count(bot, 'stone_shovel') + 1, Object.assign({}, ctx, { noWithdraw: false })).catch(() => false)
  return !!inv.bestTool(bot, 'shovel', 4)
}

// The head is under water (knocked in, a current): the reflex brings it up - wait for that, never dig meanwhile.
async function breathe (bot) {
  const t0 = Date.now()
  while ((world.headInWater(bot) || reflex.active()) && Date.now() - t0 < 15000) { await reflex.waitClear(); await move.sleep(250) }
  return !world.headInWater(bot)
}

// Swimming (feet in water, nothing solid under them): a player holds jump to keep the head out - let go and the
// body sinks, and two seconds later the air reflex has it. Wading on a floor it holds nothing: a hop off the ground
// digs five times slower.
function swimming (bot) { const p = bot.entity.position; return world.feetInWater(bot) && !world.isSolid(world.at(bot, p.x, p.y - 1, p.z)) }
function float (bot) { if (swimming(bot) && !reflex.active()) bot.setControlState('jump', true) }
async function idle (bot, ms) { float(bot); await move.sleep(ms) }

// Walk to a breathing stand - or swim to a surface cell (c.float: feet in the top water cell, head in air) - never
// under the water on the way (dryHead: the planner may not route a node with the head submerged), digging and
// bridging nothing: the river bank is not ours to cut. A step that failed is not asked for again this session
// (`sess.noGo`): the same walk retried from the same spot looped "to the shore" seven times a minute for five
// minutes (2026-09-22); the caller picks another cell or gives the block a strike.
async function stepTo (bot, c, stop, label, sess) {
  const at = () => { const p = world.feetPos(bot); return p.x === c.x && p.z === c.z && Math.abs(p.y - c.y) <= 1 }
  if (at()) { float(bot); return true }
  if (sess && sess.noGo.has(key(c))) return false
  // (a swim ends over the column at whatever height the bobbing leaves the feet)
  const goal = c.float ? new goals.GoalNearXZ(c.x, c.z, 0) : new goals.GoalBlock(c.x, c.y, c.z)
  const r = await move.goTo(bot, goal, { timeoutMs: 30000, stuckMs: 8000, dig: false, place: false, dryHead: true, label, shouldStop: stop })
  const ok = r.ok || at()
  if (!ok && sess && r.why !== 'stopped') sess.noGo.add(key(c))
  float(bot)
  return ok
}

// Drops of `re` near us.
function dropsNear (bot, re, r = 12) {
  return Object.values(bot.entities).filter(e => {
    if (!e || e.name !== 'item' || !e.position || e.position.distanceTo(bot.entity.position) > r) return false
    try { return re.test(e.getDroppedItem().name) } catch { return false }
  })
}
function dropCount (e) { try { return e.getDroppedItem().count } catch { return 1 } }
// Still coming up: water over it too.
function rising (bot, e) { const p = e.position; return world.isWaterBlock(world.at(bot, p.x, p.y, p.z)) && world.isWaterBlock(world.at(bot, p.x, p.y + 1, p.z)) }
// A surface cell: the top water cell with air over it - a swimmer there has the head out.
function floatCell (bot, x, y, z) {
  return world.isWaterBlock(world.at(bot, x, y, z)) && world.isAirish(world.at(bot, x, y + 1, z)) && outOfZones({ x, y, z })
}
// A breathing stand or a surface cell from which the player takes a drop at `pos` (the server hands over an item
// within about a block of the hitbox: 1.0 out from its sides, 0.5 above and below), nearest to us. Never a cell
// under the water: a ball still on the bottom or rising is waited on, not dived for.
function pickupCell (bot, pos) {
  const me = bot.entity.position
  const bx = Math.floor(pos.x); const by = Math.floor(pos.y); const bz = Math.floor(pos.z)
  let best = null
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let fy = by - 2; fy <= by + 1; fy++) {
    const x = bx + dx; const z = bz + dz
    if (Math.abs(x + 0.5 - pos.x) > 1.2 || Math.abs(z + 0.5 - pos.z) > 1.2 || pos.y < fy - 0.4 || pos.y > fy + 2.2) continue
    const stand = breathStand(bot, x, fy, z)
    if (!stand && !floatCell(bot, x, fy, z)) continue
    const d = Math.hypot(x + 0.5 - me.x, fy - me.y, z + 0.5 - me.z)
    if (!best || d < best.d) best = { x, y: fy, z, d, float: !stand }
  }
  return best
}

// A dug block's balls start on the river bottom and float up (about a block a second): wait for the ones round
// it to reach the surface - beside our stand they are handed over there and then, before the current takes them.
async function settle (bot, p) {
  const re = /^clay_ball$/
  const t0 = Date.now()
  const here = () => dropsNear(bot, re).filter(e => world.dist3(e.position, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }) < 5)
  // (a moment for the drop to exist at all: the server spawns it with the block's break)
  while (Date.now() - t0 < 600 && !here().length) await move.sleep(100)
  while (Date.now() - t0 < 5000 && here().some(e => rising(bot, e))) await move.sleep(150)
}

// Collect what floated up. From breathing stands and surface cells only - a ball is swum after once it bobs at the
// surface, never while it is still on the bottom or rising: a walk aimed at a ball on the river bottom dove, the
// head went under and the air reflex took the body seven times in a minute (2026-09-22). A drop no such cell
// reaches is waited on while the current still carries it; once it lies still out of reach it is lost (the
// balls-per-block lines count it). Returns the count left in the water.
async function pickUp (bot, stop, sess) {
  const re = /^clay_ball$/
  const t0 = Date.now()
  while (!stop() && Date.now() - t0 < 6000 && dropsNear(bot, re).some(e => rising(bot, e))) await idle(bot, 250)
  const tries = new Map()
  let seen = new Map() // id -> where it was at the last look
  while (!stop() && Date.now() - t0 < 30000) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    await breathe(bot)
    const me = bot.entity.position
    const ds = dropsNear(bot, re).filter(e => (tries.get(e.id) || 0) < 2 && !rising(bot, e)).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    if (!ds.length) break
    let go = null
    for (const d of ds) { const c = pickupCell(bot, d.position); if (c) { go = { d, c }; break } }
    if (!go) {
      const drifting = ds.some(d => { const q = seen.get(d.id); return !q || q.distanceTo(d.position) > 0.2 })
      seen = new Map(ds.map(d => [d.id, d.position.clone()]))
      if (!drifting) break
      await idle(bot, 700)
      continue
    }
    tries.set(go.d.id, (tries.get(go.d.id) || 0) + 1)
    if (!await stepTo(bot, go.c, stop, 'clay pickup', sess)) continue
    // (handed over on the server's next ticks once we stand beside it)
    const t1 = Date.now()
    while (go.d.isValid && Date.now() - t1 < 1200) await idle(bot, 100)
  }
  return dropsNear(bot, re).reduce((s, e) => s + dropCount(e), 0)
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// ---- the dive ----
// Still water: a source cell (level 0) with no collision box (a waterlogged stair is "water" to isWaterBlock too).
// A current pushes a diver off the bed and carries the balls off; falling water pours down on the way up.
function stillWater (b) {
  if (!b || b.name !== 'water' || b.boundingBox !== 'empty') return false
  try { const l = b.getProperties().level; return l == null || Number(l) === 0 } catch { return true }
}
// A column a player can dive at (x,z) near height y: still water from the surface `s` (air over it) down to a solid
// bed `f`, 2..MAX_DIVE_DEPTH deep (1 deep is wading - a breathing stand reaches that), under the open sky: the way
// up must be straight up, whatever happens down there. Null when not.
function diveColumn (bot, x, z, y) {
  let s = null
  for (let k = y + MAX_DIVE_DEPTH + 1; k >= y; k--) {
    if (stillWater(world.at(bot, x, k, z)) && world.isAirish(world.at(bot, x, k + 1, z))) { s = k; break }
  }
  if (s == null) return null
  let f = s
  while (f > s - MAX_DIVE_DEPTH - 1 && stillWater(world.at(bot, x, f, z))) f--
  const bed = world.at(bot, x, f, z)
  const depth = s - f
  if (!bed || !world.isSolid(bed) || world.DANGER_FLOOR_RE.test(bed.name) || depth < 2 || depth > MAX_DIVE_DEPTH) return null
  if (!world.openSky(bot, { x, y: s - 1, z }) || !outOfZones({ x, y: f + 1, z })) return null
  return { x, z, s, f, depth, bed: bed.name }
}
// Nothing afloat or swimming in the column (a boat, a squid, another player): a lid on the way up.
function columnClear (bot, col) {
  return !Object.values(bot.entities).some(e => e && e !== bot.entity && e.name !== 'item' && e.position &&
    Math.abs(e.position.x - col.x - 0.5) < 1.3 && Math.abs(e.position.z - col.z - 0.5) < 1.3 && e.position.y > col.f && e.position.y < col.s + 3)
}
// Where to dive for the clay `cands` (positions): the bed cell with the most of them in dig reach of the eye standing
// there (never the bed under the feet), each with open water over it to the sky so its balls float up where they
// can be taken. Nearer breaks a tie, and a bed that is not clay itself goes first (standing on it keeps it).
function diveSpot (bot, cands, sess) {
  const me = bot.entity.position
  const seen = new Set(); const sky = new Map(); const spots = []
  const opens = p => { const k = key(p); if (!sky.has(k)) sky.set(k, underSky(bot, p)); return sky.get(k) }
  for (const p of cands) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const x = p.x + dx; const z = p.z + dz; const ck = `${x},${z}`
    if (seen.has(ck)) continue
    seen.add(ck)
    const col = diveColumn(bot, x, z, p.y)
    if (!col || sess.badCols.has(ck) || sess.noGo.has(key({ x, y: col.s, z }))) continue
    const feet = { x, y: col.f + 1, z }
    const targets = cands.filter(q => digsFrom(feet, q) && opens(q))
    if (!targets.length) continue
    spots.push({ col, targets, score: targets.length * 100 - Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) - (CLAY_RE.test(col.bed) ? 50 : 0) })
  }
  return spots.sort((a, b) => b.score - a.score).find(s => columnClear(bot, s.col)) || null
}
// The body fit to go under: day (the dark brings the drowned and hides the way), no thunderstorm, hp and food to
// spare (a drowned's hit down there must not be the last), nothing hostile within 16. Null when fit.
function bodyUnfit (bot) {
  if (world.phase(bot) !== 'day') return 'not day'
  if (bot.thunderState > 0) return 'thunderstorm'
  if (bot.health < 14) return `hp ${Math.round(bot.health)}`
  if (bot.food < 6) return `food ${bot.food}`
  const h = reflex.hostiles(16)[0]
  return h ? `${h.e.name} ${h.d.toFixed(0)}b away` : null
}
// Standing on the bed: on the ground (off it the dig is five times slower again, on top of the five under water),
// a solid block under the feet, the feet in water.
function onBed (bot) {
  const p = bot.entity.position
  return !!bot.entity.onGround && world.isSolid(world.at(bot, p.x, p.y - 0.2, p.z)) && world.feetInWater(bot)
}
// Steer toward the column's centre: holding jump at the surface, letting go to sink. Returns how far off it we are.
function steerOver (bot, col, jump) {
  const p = bot.entity.position; const dx = col.x + 0.5 - p.x; const dz = col.z + 0.5 - p.z
  const off = Math.hypot(dx, dz)
  if (off > 0.2) bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
  bot.setControlState('forward', off > 0.2)
  bot.setControlState('jump', jump)
  return off
}

// One breath: swim out over `plan.col`, fill the lungs, sink to the bed, dig every clay block in reach while the air
// left covers the dig and the way up, swim straight up, and take the balls off the surface. The reflex holds the
// breath's hard limit (startDive): past it, or hurt, or a hostile close, the dive is broken and the air reflex has
// the body - the dive never waits on the reflex (it holds the body; act.dig would wait on it forever).
async function dive (bot, plan, sess, stop) {
  const { col } = plan
  const res = { dug: 0, clean: false, end: null, broken: null, unfit: false, underMs: 0, balls: 0 }
  if (!await stepTo(bot, { x: col.x, y: col.s, z: col.z, float: true }, stop, 'over the clay', sess)) { res.end = 'could not swim there'; return res }
  const first = world.at(bot, plan.targets[0].x, plan.targets[0].y, plan.targets[0].z)
  if (first) await inv.equipFor(bot, first).catch(() => {}) // (the shovel in hand up here: the air is for digging)
  // afloat over the spot until the breath is full (a quick surface does not refill it) and we are over the column
  let best = Infinity; let bestAt = Date.now()
  for (;;) {
    if (stop()) { res.end = 'stopped'; return res }
    if (reflex.active()) { res.end = `${reflex.active()} reflex`; return res }
    const unfit = bodyUnfit(bot)
    if (unfit) { res.end = unfit; res.unfit = true; return res }
    const off = steerOver(bot, col, true)
    if (off < best - 0.05) { best = off; bestAt = Date.now() }
    const over = Math.floor(bot.entity.position.x) === col.x && Math.floor(bot.entity.position.z) === col.z
    if (reflex.airLeftMs() >= AIR_FULL_MS && !world.headInWater(bot) && (off < 0.3 || (over && Date.now() - bestAt > 1500))) break
    // pushed off and not steering back: a current the column check could not see
    if (!over && Date.now() - bestAt > 3000) { sess.badCols.add(`${col.x},${col.z}`); res.end = 'drifted off the spot'; return res }
    await move.sleep(50)
  }
  const before = balls(bot) // (a ball rising past us on the way up is handed over too)
  const riseMs = 500 + col.depth * 350
  let wentUnder = 0
  const under = () => wentUnder ? Date.now() - wentUnder : 0
  const broke = () => reflex.diveBroken() || (reflex.active() ? `${reflex.active()} reflex` : null)
  reflex.startDive(reflex.DIVE_HARD_MS)
  try {
    // DOWN: let go of jump and sink, keeping over the column
    let lastY = bot.entity.position.y; let fallAt = Date.now()
    while (!res.end) {
      await move.sleep(50)
      if (!wentUnder && world.headInWater(bot)) wentUnder = Date.now()
      const y = bot.entity.position.y
      if (y < lastY - 0.02) { lastY = y; fallAt = Date.now() }
      if (broke()) res.end = broke()
      else if (stop()) res.end = 'stopped'
      else if (onBed(bot)) break
      else if (under() + riseMs > DIVE_MS) res.end = 'no air left to reach the bed'
      else if (Date.now() - fallAt > 1500) res.end = 'stopped sinking short of the bed'
      else steerOver(bot, col, false)
    }
    if (!broke()) bot.clearControlStates()
    // DIG: nearest first, never the bed under the feet, each only while the air left covers its dig and the way up
    const skip = new Set()
    while (!res.end) {
      if (broke()) { res.end = broke(); break }
      if (stop()) { res.end = 'stopped'; break }
      if (!onBed(bot)) { if (under() + riseMs > DIVE_MS) res.end = 'knocked off the bed'; else await move.sleep(50); continue }
      const fp = world.feetPos(bot)
      const t = visibleClay(bot, 6, undefined, { sky: true }).find(b => !skip.has(key(b.position)) && !(b.position.x === fp.x && b.position.z === fp.z) && act.reach(bot, b.position, REACH))
      if (!t) { res.end = res.dug ? 'all in reach dug' : 'nothing in reach'; break }
      const digMs = typeof bot.digTime === 'function' ? bot.digTime(t) : 1500
      if (under() + digMs + riseMs > DIVE_MS) { res.end = 'breath'; break }
      if (await act.digBlock(bot, t)) res.dug++; else skip.add(key(t.position))
    }
    // UP: straight up - the column is open to the sky. The reflex's hard limit bounds this: past it the dive breaks
    // and the air reflex has the body.
    if (!broke()) {
      bot.clearControlStates(); bot.setControlState('jump', true)
      while (world.headInWater(bot) && !broke()) await move.sleep(50)
    }
    res.underMs = under()
  } finally {
    res.broken = reflex.endDive() || (reflex.active() ? `${reflex.active()} reflex` : null)
    res.clean = !res.broken && !world.headInWater(bot)
  }
  const where = `${col.x},${col.f + 1},${col.z}`
  sess.badDives = res.clean ? 0 : sess.badDives + 1
  if (!res.clean) {
    log('clay', `dive at ${where} did not surface cleanly (${res.broken || 'head still under'}; dug ${res.dug}, stopped digging: ${res.end}) - ${sess.badDives} in a row`)
    await breathe(bot)
    return res
  }
  const afloat = await pickUp(bot, stop, sess)
  res.balls = balls(bot) - before
  log('clay', `dive at ${where} (${col.depth} deep): dug ${res.dug} clay in ${(res.underMs / 1000).toFixed(1)}s under (${res.end}) -> +${res.balls} balls${res.dug ? ` (${(res.balls / res.dug).toFixed(1)} a block)` : ''}${afloat ? `, ${afloat} afloat out of reach` : ''}`)
  return res
}

// Dig the deposit round `center` until `target` balls are held, the deposit gives out, or it is time to go home.
// Returns 'done' | 'spent' (nothing left a stand or a dive reaches) | 'stuck' (walks/dives kept failing)
// | 'unfit' (the body or the day is not fit to dive: the deep clay waits) | 'stopped'.
async function digDeposit (bot, center, target, stop) {
  // where we came in dry-shod: the walk home starts from there, and so the session ends there - never afloat (a
  // session that ended in the river beside a steep bank could not walk out, and the night found the bot there)
  const ashore = dryCellNear(bot)
  const sess = { noGo: new Set(), badCols: new Set(), badDives: 0 }
  try { return await digDepositInner(bot, center, target, stop, ashore, sess) } finally {
    await breathe(bot).catch(() => false)
    if (ashore && !await stepTo(bot, ashore, () => false, 'up the bank').catch(() => false)) log('clay', `couldn't get back up the bank to ${move.fmt(ashore)} - at ${move.fmt(bot.entity.position)}`)
  }
}
// The nearest dry standing cell (feet and head in air) round us - the bank we walked in on.
function dryCellNear (bot) {
  const p = world.feetPos(bot)
  let best = null
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -2; dy <= 2; dy++) {
    const x = p.x + dx; const y = p.y + dy; const z = p.z + dz
    if (!world.standable(bot, x, y, z) || !outOfZones({ x, y, z })) continue
    const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy)
    if (!best || d < best.d) best = { x, y, z, d }
  }
  return best
}
// Standing in the water, the step back toward the bank is the neighbouring stand nearer to it: its floor is not dug
// from here (the bot would be left with deep water between it and the shore).
function wayBack (bot, feet, ashore, p) {
  if (!ashore || !world.isWaterBlock(world.at(bot, feet.x, feet.y, feet.z))) return false
  const here = Math.abs(feet.x - ashore.x) + Math.abs(feet.z - ashore.z)
  for (const [dx, dz] of DIRS) {
    const x = feet.x + dx; const z = feet.z + dz
    if (p.x !== x || p.z !== z || p.y !== feet.y - 1) continue
    if (Math.abs(x - ashore.x) + Math.abs(z - ashore.z) < here) return true
  }
  return false
}
async function digDepositInner (bot, center, target, stop, ashore, sess) {
  const bad = new Set() // blocks no stand and no dive reaches: their geometry, for this visit
  const misses = new Map() // block -> failed tries (a walk the reflex interrupted is no verdict: two strikes)
  const strike = p => { const k = key(p); misses.set(k, (misses.get(k) || 0) + 1); if (misses.get(k) >= 2) bad.add(k) }
  const start = balls(bot); let digs = 0; let dives = 0; let stopped = false; let unfit = null
  log('clay', `${visibleClay(bot, 20, center, { sky: false }).length} diggable clay block(s) in sight round ${move.fmt(center)}`)
  while (balls(bot) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (stop()) { stopped = true; break }
    if (inv.freeSlots(bot) <= 1) { await base().tossJunk(bot); if (inv.freeSlots(bot) <= 1) { stopped = true; break } }
    await breathe(bot)
    const cands = visibleClay(bot, 20, center, { sky: false }).filter(b => !bad.has(key(b.position)))
    if (!cands.length) break
    // the nearest one that has somewhere to stand, head in air (the bank, or wading)
    let pick = null; let stand = null
    const near = cands.sort((a, c) => a.position.distanceTo(bot.entity.position) - c.position.distanceTo(bot.entity.position)).slice(0, 10)
    for (const b of near) {
      const s = standFor(bot, b.position)
      if (s && !sess.noGo.has(key(s))) { pick = b; stand = s; break }
    }
    if (pick) {
      if (!await stepTo(bot, stand, stop, 'to the clay', sess)) { strike(pick.position); continue }
      // everything diggable within reach from this spot (a disc is two or three stands' worth), never our own column
      const feet = world.feetPos(bot)
      const reachable = visibleClay(bot, 6, undefined, { sky: false }).filter(b => digsFrom(feet, b.position) && !wayBack(bot, feet, ashore, b.position))
      let here = 0
      for (const b of reachable) {
        if (stop() || balls(bot) >= target || inv.freeSlots(bot) <= 1) break
        if (!await breathe(bot)) break
        if (!diggable(bot, b.position)) continue // the one before it changed the water round it
        if (await act.dig(bot, b.position, { noWalk: true, timeoutMs: 8000 })) { here++; digs++; await settle(bot, b.position) }
      }
      if (!here) strike(pick.position)
      else await pickUp(bot, stop, sess)
      continue
    }
    // nothing a breathing stand reaches: dive for it
    if (sess.badDives >= 2) { unfit = 'two dives in a row did not surface cleanly'; break }
    unfit = bodyUnfit(bot)
    if (unfit) break
    const plan = diveSpot(bot, cands.map(b => b.position), sess)
    if (!plan) { for (const b of cands) bad.add(key(b.position)); continue }
    const r = await dive(bot, plan, sess, stop)
    dives++; digs += r.dug
    if (r.unfit) { unfit = r.end; break }
    if (!r.dug) for (const q of plan.targets) strike(q)
  }
  // (not with the body unfit to be out there: a drowned about, the dusk)
  const afloat = unfit ? 0 : await pickUp(bot, stop, sess)
  const got = balls(bot) - start
  const left = visibleClay(bot, 20, center, { sky: false })
  const unreached = left.filter(b => bad.has(key(b.position))).length
  // four balls a block: what the current took is the difference
  if (digs) log('clay', `dug ${digs} clay at ${move.fmt(center)}${dives ? ` (${dives} dive(s))` : ''} -> ${got} balls (${(got / digs).toFixed(1)} a block; ${Math.max(0, digs * 4 - got)} lost to the water, ${afloat} of them seen afloat out of reach) - holding ${balls(bot)}; ${left.length} left in sight, ${unreached} out of reach`)
  if (stopped || stop()) return 'stopped'
  if (balls(bot) >= target) return 'done'
  if (unfit) { log('clay', `not diving now: ${unfit} - the deep clay at ${move.fmt(center)} waits`); return 'unfit' }
  if (left.some(b => (misses.get(key(b.position)) || 0) >= 2)) return 'stuck'
  return 'spent'
}

// Walk toward water not looked at yet (clay sits under it); with no water in sight, the widening explore
// rings, out to ~300 blocks. The client only knows loaded chunks: finding more means walking.
async function scout (bot, stop) {
  const h = home() || bot.entity.position
  const scouted = mem.get().clayScouted || []
  const fresh = p => !scouted.some(s => world.dist2(s, p) < 48)
  // (surface water only - see underSky; and a smaller scan: 128 blocks x 200 hits over a sea stalled the event loop 10s)
  const water = world.findBlocks(bot, /^water$/, { maxDistance: 96, count: 60, filter: b => nearSurface(b.position) && world.isAirish(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) && world.openSky(bot, b.position) && inRange(b.position) && outOfZones(b.position) && fresh(b.position) })
    .filter(b => world.dist2(b.position, bot.entity.position) > 48) // water close by is already in view
  const noteScouted = () => { const p = world.feetPos(bot); mem.update(m => { m.clayScouted = (m.clayScouted || []).concat([{ x: p.x, y: p.y, z: p.z }]).slice(-60) }) }
  if (water.length) {
    const w = water[0].position
    log('clay', `no clay in sight - heading to the water at ${move.fmt(w)} to look`)
    await move.travel(bot, w, { range: 8, shouldStop: () => stop() || visibleClay(bot, 64).length > 0, label: 'to water for clay' })
  } else {
    await gatherLib().explore(bot, b => CLAY_RE.test(b.name), { shouldStop: stop, label: 'clay', rings: 9, accept: b => claySought(bot, b.position) })
  }
  noteScouted()
  const found = visibleClay(bot).length > 0
  if (!found) {
    mem.update(m => {
      const s = m.claySearch && m.claySearch.home && world.dist2(m.claySearch.home, h) < 16 ? m.claySearch : { home: { x: h.x, y: h.y, z: h.z }, legs: 0 }
      s.legs++
      if (s.legs >= EXHAUSTED_AFTER) s.exhausted = true
      m.claySearch = s
    })
    if (exhausted()) log('clay', `NO CLAY within ${SEARCH_RADIUS} blocks of home after ${mem.get().claySearch.legs} scouting legs - bricks, brick slabs/stairs and flower pots cannot be made here; the operator must choose what stands in for them`)
  } else mem.update(m => { if (m.claySearch) m.claySearch.legs = 0 })
  return found
}

// Get `n` more clay balls: find a deposit (in sight, remembered, or scouted for), walk there, dig from the bank
// and dive for the rest.
async function gather (bot, n, ctx = {}) {
  const start = balls(bot); const target = start + n
  if (exhausted()) { log('clay', `no clay within ${SEARCH_RADIUS} blocks of home (searched) - not looking again for this home`); return false }
  if (!await ensureShovel(bot, ctx)) { log('clay', 'no shovel and could not make one'); return false }
  // room for the haul before the walk (the builder's window may be sitting in the pack): empty it at home
  const slots = Math.ceil(n / 64) + 3
  if (inv.freeSlots(bot) < slots && base().distHome(bot) < 32) await base().depositAll(bot).catch(() => false)
  const stop = () => (ctx.shouldStop && ctx.shouldStop()) || mustTurnBack(bot)
  for (let round = 0; round < 8 && balls(bot) < target; round++) {
    if (stop()) break
    await reflex.waitClear()
    const dep = findDeposit(bot)
    if (!dep) { if (!await scout(bot, stop) && exhausted()) break; continue }
    if (world.dist2(bot.entity.position, dep) > 12) {
      log('clay', `clay at ${move.fmt(dep)} (${Math.round(world.dist2(dep, home() || bot.entity.position))}b from home) - going to dig ${target - balls(bot)} balls`)
      const r = await move.travel(bot, dep, { range: 6, shouldStop: stop, label: 'to clay' })
      if (!r.ok && world.dist2(bot.entity.position, dep) > 16) { if (r.why !== 'stopped') markSpent(dep); continue }
    }
    gatherLib().noteResource('clay', dep)
    const why = await digDeposit(bot, dep, target, stop)
    if (why === 'spent') { log('clay', `the clay at ${move.fmt(dep)} is dug out, or none left that a stand or a dive reaches`); markSpent(dep) }
    else if (why === 'unfit' || why === 'stuck') break // (not spent: another hour, or another day, reaches it)
  }
  const got = balls(bot) - start
  log('clay', `clay trip: +${got} balls (${balls(bot)} held)${stop() && got < n ? ' - heading home before dark' : ''}`)
  return got > 0
}

module.exports = { gather, tripFits, exhausted, diggable, standFor, _digDeposit: digDeposit, _dive: dive, pickupCell, floatCell, breathStand, pickUp, digsFrom, diveColumn, diveSpot, bodyUnfit, onBed, mustTurnBack }
