'use strict'
// SURVIVAL REFLEXES - a 200ms loop that owns the body whenever the body is in danger. While a
// reflex is active every skill pauses (move.goTo aborts and waits; skills call waitClear()).
// Order: air > lava/fire > creeper > melee/ranged threat > low-hp retreat > eat. A skill may hold a bounded DIVE
// (startDive/endDive): the one declared exception to the air reflex.
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const { log } = require('./log')

const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper', 'witch', 'slime', 'magma_cube', 'silverfish', 'endermite', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'phantom', 'zombie_villager', 'piglin_brute', 'hoglin', 'zoglin', 'blaze', 'ghast', 'wither_skeleton', 'guardian', 'elder_guardian', 'breeze', 'creaking'])
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'breeze'])
const NEVER_MELEE = new Set(['creeper', 'ghast', 'warden', 'wither', 'elder_guardian', 'ravager'])

let bot = null
let active = null // {kind, since, detail}
let busy = false // an async reflex action is running
let dressFailed = null // the better-armour key a wear attempt left unchanged (cleared when the inventory changes)
let submergedSince = 0
let lastAttackAt = 0
let lastHurtAt = 0
let lastHurtBy = null
let lastEatFail = 0
let enabled = true
let fleeTarget = null
let diedAt = 0
let lastLogKey = ''

// OUR air clock. bot.oxygenLevel is not trusted: on this server it was seen stuck at 5 on dry land. A player has
// 300 ticks (15s) of air; under water it runs down a tick a tick, in air it comes back four a tick.
const AIR_MS = 15000
let airMs = AIR_MS
let airAt = 0
function trackAir (now) {
  const under = world.headInWater(bot)
  if (under) { if (!submergedSince) submergedSince = now } else submergedSince = 0
  const dt = airAt ? now - airAt : 0; airAt = now
  airMs = under ? Math.max(0, airMs - dt) : Math.min(AIR_MS, airMs + 4 * dt)
}

// A DIVE: a skill's declared, bounded exception to the air reflex (clay.js goes down to dig a river bed). While
// it holds, a head under water is not an emergency - until the underwater time passes its budget (never past
// DIVE_HARD_MS), the air left runs under a reserve, the body is hurt, a hostile (a drowned) comes within 8, or
// another reflex takes the body. Then the dive is BROKEN for good and the air reflex surfaces us as it always
// does. Every other reflex keeps its priority; the skill ends the dive itself (endDive) once its head is out.
const DIVE_HARD_MS = 11000
const AIR_RESERVE_MS = 4000
let dive = null // { maxMs, hp, broken }
function startDive (maxMs = DIVE_HARD_MS) { dive = { maxMs: Math.min(maxMs, DIVE_HARD_MS), hp: bot.health, broken: null } }
function endDive () { const d = dive; dive = null; return d ? d.broken : null }
function diveBroken () { return dive ? dive.broken : null }
function diveHolds (now) {
  if (!dive || dive.broken) return false
  const under = submergedSince ? now - submergedSince : 0
  if (bot.health > dive.hp) dive.hp = bot.health // (regeneration raises the mark; only a loss counts)
  const h = hostiles(8)[0]
  const why = under >= dive.maxMs ? `under ${Math.round(under / 100) / 10}s` : submergedSince && airMs < AIR_RESERVE_MS ? `air low (${Math.round(airMs / 100) / 10}s left)`
    : bot.health <= dive.hp - 1 ? `hurt (hp ${Math.round(bot.health)})` : h ? `${h.e.name} ${h.d.toFixed(1)}b` : active && active.kind !== 'air' ? `${active.kind} reflex` : null
  if (!why) return true
  dive.broken = why
  log('reflex', `dive broken: ${why} - surfacing`)
  try { if (bot.targetDigBlock) bot.stopDigging() } catch {} // (the body is ours now: no dig left running under water)
  return false
}

function setActive (kind, detail) {
  if (!active || active.kind !== kind) {
    active = { kind, since: Date.now(), detail }
    const key = kind + ':' + (detail || '')
    if (key !== lastLogKey) { lastLogKey = key; log('reflex', `${kind}${detail ? ' - ' + detail : ''} (hp ${Math.round(bot.health)} food ${bot.food})`) }
  } else active.detail = detail
}
let blocking = false
function shieldUp () { if (!blocking) { try { bot.activateItem(true); blocking = true } catch {} } }
function shieldDown () { if (blocking) { try { bot.deactivateItem() } catch {} blocking = false } }
function clearActive () {
  shieldDown()
  riseY = null
  if (active) {
    log('reflex', `${active.kind} done after ${Math.round((Date.now() - active.since) / 100) / 10}s (hp ${Math.round(bot.health)})`)
    active = null; lastLogKey = ''
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  }
}

function hostiles (maxDist = 24) {
  const me = bot.entity.position
  const out = []
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !e.name) continue
    if (!HOSTILE.has(e.name)) continue
    const d = e.position.distanceTo(me)
    if (d <= maxDist) out.push({ e, d })
  }
  out.sort((a, b) => a.d - b.d)
  return out
}

function canSee (e) {
  try {
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const tgt = e.position.offset(0, (e.height || 1.6) * 0.8, 0)
    const dir = tgt.minus(eye)
    const len = dir.norm()
    if (len < 1) return true
    const step = dir.scaled(1 / len)
    for (let t = 0.5; t < len; t += 0.5) {
      const p = eye.plus(step.scaled(t))
      const b = bot.blockAt(p.floored())
      if (b && b.boundingBox === 'block') return false
    }
    return true
  } catch { return true }
}

// THE HURT LINE: the hp at which one more exchange can kill - two hits of this difficulty's zombie (vanilla 2 / 3 / 4.5
// on easy / normal / hard, the common melee; unknown difficulty counts as hard), after the worn armour's cut (vanilla:
// max(points/5, points - damage/2) out of 25). Unarmoured on hard that is 9, in full iron 4.4. The reflex breaks
// off a fight at it; the director ends a trip outside at it and heals (director.tooHurt). One number for both.
function hurtLine () {
  const hit = { peaceful: 0, easy: 2, normal: 3, hard: 4.5 }[bot && bot.game && bot.game.difficulty]
  const dmg = hit == null ? 4.5 : hit
  const pts = inv.armorPoints(bot)
  const cut = Math.min(20, Math.max(pts / 5, pts - dmg / 2)) / 25
  return 2 * dmg * (1 - cut)
}

function attackCooldownMs () {
  const h = bot.heldItem ? bot.heldItem.name : ''
  if (h.endsWith('_sword')) return 650
  if (h.endsWith('_axe')) return 1050
  return 400
}

async function doEat () {
  const food = inv.foodItems(bot, { desperate: bot.food <= 6 })[0]
  if (!food) return false
  busy = true
  setActive('eat', food.name)
  try {
    const before = bot.food
    await bot.equip(food, 'hand')
    await bot.consume()
    log('reflex', `ate ${food.name} -> food ${bot.food}`)
    // a consume that resolves without the hunger bar moving is a refused bite: back off, don't spin
    if (bot.food <= before) lastEatFail = Date.now()
    return true
  } catch (e) { lastEatFail = Date.now(); return false } finally { busy = false; clearActive() }
}

// Nearest cell reachable by swimming whose head space is air (a place to breathe), or dry land. With `landOnly`,
// dry land only: once the head is out, the cell we float in is always the nearest air - steering to it held the
// bot in place in a river for 12 minutes (2026-09-22) - so the way out is toward land, a step up at most preferred.
function findAir (landOnly = false, { aside = false } = {}) {
  const me = bot.entity.position.floored()
  let best = null; let bestD = Infinity
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let dy = -2; dy <= 6; dy++) {
    if (aside && Math.abs(dx) + Math.abs(dz) < 2) continue // (a way round what is over us: not our own column or the next)
    const x = me.x + dx; const y = me.y + dy; const z = me.z + dz
    const feet = world.at(bot, x, y, z); const head = world.at(bot, x, y + 1, z)
    if (!feet || !head) continue
    if (!(world.isAirish(head))) continue
    if (!(world.isAirish(feet) || world.isWaterBlock(feet))) continue
    const below = world.at(bot, x, y - 1, z)
    const land = below && world.isSolid(below) && world.isAirish(feet)
    if (landOnly && !land) continue
    const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 0.5 - (land ? 2 : 0) + (landOnly && dy > 1 ? 3 * (dy - 1) : 0)
    if (d < bestD) { bestD = d; best = { x, y, z, land } }
  }
  return best
}

// Block the line of fire: the cells beside us toward the shooter, feet and head height.
async function wallOff (e) {
  const me = bot.entity.position.floored()
  const dx = e.position.x - (me.x + 0.5); const dz = e.position.z - (me.z + 0.5)
  const step = Math.abs(dx) >= Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) }
  const filler = () => inv.shelterBlock(bot)
  const act = require('./act')
  let n = 0
  for (const dy of [0, 1]) {
    const p = { x: me.x + step.x, y: me.y + dy, z: me.z + step.z }
    const b = world.at(bot, p.x, p.y, p.z)
    const f = filler()
    if (!f || !b || !world.isAirish(b)) continue
    try { if (await act.place(bot, p, f.name, { sneak: false, fromReflex: true, faceHint: [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] })) n++ } catch {}
  }
  if (n) log('reflex', `walled off the ${e.name} (${n} block${n > 1 ? 's' : ''})`)
}

let floatSince = 0
let riseY = null; let riseAt = 0 // the air reflex: where the body was when it last made headway upward
// Out of water over a bank too high to jump: dig the bank's lower blocks so there is a one-block step,
// or fill the water cell beside us to stand on.
async function climbOut () {
  const p = bot.entity.position.floored()
  const act = require('./act')
  const tryCol = async (x, z) => {
    for (const base of [p.y, p.y - 1]) {
      const floor = world.at(bot, x, base, z); const c1 = world.at(bot, x, base + 1, z); const c2 = world.at(bot, x, base + 2, z)
      if (!floor || !c1 || !c2 || !world.isSolid(floor)) continue
      if (base + 1 > p.y + 1) continue
      // clear the two cells a body needs on top of that floor
      for (const c of [c1, c2]) {
        if (world.isAirish(c)) continue
        if (!world.NATURAL_RE.test(c.name) || world.isWaterBlock(c) || world.isLavaBlock(c)) return false
        // (through act.digBlock: a finished build block is never cut into, reflex or not)
        if (!await act.digBlock(bot, c)) return false
      }
      const t0 = Date.now()
      while (Date.now() - t0 < 2500) {
        steerTo({ x, y: base + 1, z }, { jump: true })
        await new Promise(r => setTimeout(r, 100))
        if (!world.feetInWater(bot) && bot.entity.onGround) break
      }
      bot.clearControlStates()
      return !world.feetInWater(bot)
    }
    return false
  }
  // the bank nearest to where land is
  const t = findAir(true)
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  if (t) dirs.sort((a, b) => Math.hypot(p.x + a[0] - t.x, p.z + a[1] - t.z) - Math.hypot(p.x + b[0] - t.x, p.z + b[1] - t.z))
  for (const [dx, dz] of dirs) {
    if (await tryCol(p.x + dx, p.z + dz)) { log('reflex', `cut a step into the bank at ${p.x + dx},${p.z + dz} and climbed out`); return true }
  }
  // no diggable bank: stand on a block placed in the water beside us - only where the cell has a face to click
  // (open water all round has none: every direction answered "nothing solid to place against"), and then step onto
  // it (the block alone left the bot floating beside it for four more minutes)
  const filler = inv.shelterBlock(bot) // (sand placed in water sinks to the bed: nothing to stand on)
  if (!filler) return false
  const faced = c => [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([ox, oy, oz]) => world.isSolid(world.at(bot, c.x + ox, c.y + oy, c.z + oz)))
  for (const [dx, dz] of dirs) {
    const c = { x: p.x + dx, y: p.y, z: p.z + dz }
    const b = world.at(bot, c.x, c.y, c.z)
    if (!b || !world.isWaterBlock(b) || !faced(c) || !world.isAirish(world.at(bot, c.x, c.y + 1, c.z)) || !world.isAirish(world.at(bot, c.x, c.y + 2, c.z))) continue
    bot.clearControlStates() // (the tick's steering still held: the click must not drift)
    // (a body left still in deep water sinks - and while this runs the tick is not watching the air: give up at once
    //  if the head goes under, the tick takes it from there)
    if (world.headInWater(bot)) return false
    try { await act.place(bot, c, filler.name, { sneak: false, fromReflex: true, timeoutMs: 3000 }) } catch {}
    if (!world.isSolid(world.at(bot, c.x, c.y, c.z))) continue
    log('reflex', `placed a block in the water at ${c.x},${c.y},${c.z} to climb out`)
    const t0 = Date.now()
    while (Date.now() - t0 < 2500) {
      steerTo({ x: c.x, y: c.y + 1, z: c.z }, { jump: true })
      await new Promise(r => setTimeout(r, 100))
      if (!world.feetInWater(bot) && bot.entity.onGround) break
    }
    bot.clearControlStates()
    return !world.feetInWater(bot)
  }
  return false
}

function enclosed () {
  const p = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
    const b = world.at(bot, p.x + dx, p.y + dy, p.z + dz)
    if (!b || !world.isSolid(b)) return false
  }
  return true
}
function canDigInHere () {
  const p = bot.entity.position.floored()
  // not in our own ground: at home the safehouse IS the shelter. A dig-in on the door step at night (unarmed after a
  // respawn, a skeleton about) fought the director's walk to the door seven times in a minute, and the pit it left
  // was a 5-block drop in front of the door the edge guard rightly refused - two deaths outside it (2026-09-24)
  if (require('./move').inZone(p, 1)) return false
  for (const dy of [1, 2, 3, 4]) {
    const b = world.at(bot, p.x, p.y - dy, p.z)
    if (!b || world.isWaterBlock(b) || world.isLavaBlock(b)) return false
    if (dy <= 3 && (!world.isSolid(b) || !world.NATURAL_RE.test(b.name) || b.hardness < 0 || b.hardness > 3)) return false
    // never into a finished build: a castle floor of cobblestone is "natural" to the regex above, and the
    // dig-in went through the finished castle wall (2026-09, 275,71,-253). Ask here, before choosing to dig
    // in at all - act.digBlock refuses the block anyway, which would leave us in a half-dug hole.
    if (dy <= 3 && require('./move').isProtected(b, 'dig')) return false
  }
  return !world.waterNear(bot, { x: p.x, y: p.y - 2, z: p.z }, 1, -1, 1) && !world.lavaNear(bot, { x: p.x, y: p.y - 2, z: p.z }, 1)
}
async function digIn () {
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const p0 = bot.entity.position.floored()
  // centre on the cell so we drop in
  await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
  // three deep, so the plug goes in the ground layer with ground around it to place against
  for (const dy of [1, 2, 3]) {
    const b = world.at(bot, p0.x, p0.y - dy, p0.z)
    if (!b || world.isAirish(b)) continue
    // (through act.digBlock: it refuses a finished build block - canDigInHere already chose ground without one)
    await require('./act').digBlock(bot, b)
    const t0 = Date.now()
    while (Date.now() - t0 < 1500 && Math.floor(bot.entity.position.y) > p0.y - dy) {
      const pp = bot.entity.position
      bot.setControlState('forward', Math.hypot(pp.x - (p0.x + 0.5), pp.z - (p0.z + 0.5)) > 0.2)
      await bot.look(Math.atan2(-((p0.x + 0.5) - pp.x), -((p0.z + 0.5) - pp.z)), -Math.PI / 2, true).catch(() => {})
      await new Promise(r => setTimeout(r, 50))
    }
    bot.setControlState('forward', false)
  }
  // plug the hole above our head with whatever block we carry (the dirt we just dug)
  const top = { x: p0.x, y: Math.floor(bot.entity.position.y) + 2, z: p0.z }
  const filler = inv.shelterBlock(bot)
  if (filler) { try { await require('./act').place(bot, top, filler.name, { fromReflex: true, faceHint: [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] }) } catch {} }
  log('reflex', `dug in at ${p0.x},${p0.y - 3},${p0.z}${filler ? '' : ' (nothing to plug the hole with)'}`)
}

function steerTo (p, { jump = true, sprint = false } = {}) {
  const me = bot.entity.position
  const yaw = Math.atan2(-(p.x + 0.5 - me.x), -(p.z + 0.5 - me.z))
  bot.look(yaw, 0, true).catch(() => {})
  bot.setControlState('forward', Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z) > 0.4)
  bot.setControlState('jump', jump)
  bot.setControlState('sprint', sprint)
}

// The best open heading away from a threat: of 16 directions within 100 degrees of straight away,
// the most direct one whose next 3 cells are walkable ground (a step up or a drop of <=2, no water or
// lava). Returns a target cell 3 blocks out.
function fleeHeading (t) {
  const me = bot.entity.position
  const away = Math.atan2(me.z - t.position.z, me.x - t.position.x)
  let best = null
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8
    let diff = Math.abs(((a - away) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)
    if (diff > Math.PI * 0.56) continue
    let y = Math.floor(me.y); let ok = true; let jump = false; let cell = null
    for (let s = 1; s <= 3 && ok; s++) {
      const x = Math.floor(me.x + Math.cos(a) * s); const z = Math.floor(me.z + Math.sin(a) * s)
      const dy = [0, 1, -1, -2].find(k => world.standable(bot, x, y + k, z))
      if (dy == null) { ok = false; break }
      if (dy === 1) jump = true
      y += dy
      const floor = world.at(bot, x, y - 1, z)
      if (!floor || world.isWaterBlock(floor) || world.lavaNear(bot, { x, y, z }, 1)) { ok = false; break }
      cell = { x, y, z }
    }
    if (!ok || !cell) continue
    if (!best || diff < best.diff) best = { x: cell.x, y: cell.y, z: cell.z, jump, diff }
  }
  return best
}

// TREADING WATER. A player in deep water holds jump whenever nothing else is steering - let go and the body sinks.
// The pathfinder holds it only while it has a path: every replan, every gap between legs and walks (clearControlStates)
// left the body still in the water, and the head went under for 2s+ at a time mid-ocean - the air reflex took the body
// again and again (2026-09-23). Not a reflex (nothing is preempted): while the body is afloat, unsteered, not diving,
// jump is held; it is let go as the body leaves the water.
let treading = false
function tread () {
  const p = bot.entity.position
  const afloat = !bot.vehicle && !bot.entity.onGround && (world.feetInWater(bot) || world.isWaterBlock(world.at(bot, p.x, p.y - 0.3, p.z))) &&
    !world.isSolid(world.at(bot, p.x, p.y - 1, p.z))
  const steered = bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()
  if (afloat && !active && !dive && !steered) {
    if (!treading || !bot.getControlState || !bot.getControlState('jump')) bot.setControlState('jump', true)
    treading = true
  } else if (treading) {
    treading = false
    if (!active && !steered) bot.setControlState('jump', false)
  }
}

// THE EDGE. The body never walks toward a drop that hurts - whoever drives (the pathfinder's own maxDropDown is the same
// SAFE_DROP, so it never plans one; this catches its overshoots too). Two deaths on 2026-09-23 (y16 -> y-14 in a cave, y78 -> y55 into a ravine) began
// mid creeper-flee: the flee steers by hand, and with no open heading it held 'back' without looking. A veto on the
// keys, not a steering rule: whatever pressed forward/back (a reflex, a door crossing, a skill's nudge), the step is
// judged against the ground it leads onto, every physics tick, and cut - with sneak held to brake the momentum (the
// physics stops a sneaking body at an edge) - before the body goes over.
let edgeHeld = null // { x, z, drop } while the guard is braking
function edgeGuard () {
  if (!bot.entity || bot.vehicle || bot.health <= 0) return
  // (the pathfinder too: every step it plans drops SAFE_DROP at most, so a bigger drop ahead of it is an overshoot - it
  //  walked the bot off the unrailed edge of the Notre-Dame plaza, 21 blocks, 2026-09-24. Cut, and it replans.)
  const steered = bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()
  const c = bot.controlState || {}
  const p = bot.entity.position
  const v = bot.entity.velocity
  const dir = c.forward ? 1 : c.back ? -1 : 0
  const speed = Math.hypot(v.x, v.z)
  if (world.feetInWater(bot) || !bot.entity.onGround || (!dir && speed < 0.05)) { release(); return }
  // where the body is headed: the keys it holds, else the way it is sliding
  let hx, hz
  if (dir) { hx = -Math.sin(bot.entity.yaw) * dir; hz = -Math.cos(bot.entity.yaw) * dir } else { hx = v.x / speed; hz = v.z / speed }
  // far enough ahead to cover this tick's motion and the slide after the keys let go (~3 ticks of it)
  const reach = 0.45 + Math.max(speed, 0.15) * 3
  const y = Math.floor(p.y + 0.01)
  const here = world.dropAt(bot, p.x, y, p.z)
  if (steered) {
    // The pathfinder only overshoots: cut when, a few ticks on at this speed, NO part of the hitbox would still rest on
    // ground and the fall there hurts. A probe along the heading clipped the corner of a stairwell beside a diagonal
    // path and stopped the walk home ten times in a night (the bed 21 blocks off, the bot left in the open); looking a
    // stride ahead past a ledge it stepped down onto cut a sound way down 111 times (2026-09-25).
    // (one tick on: three ticks ahead ran past a one-block ledge the planner was stepping onto to turn - the bot stood
    //  trapped in a pocket of the cathedral wall for ten minutes, 2026-09-25. The sneak brake holds a real overshoot at
    //  the lip; a tick at sprint is ~0.28 of a block)
    const t = 1; const nx = p.x + v.x * t; const nz = p.z + v.z * t
    const hull = (cx, cz) => Math.min(...[[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]].map(([dx, dz]) => world.dropAt(bot, Math.floor(cx + dx), y, Math.floor(cz + dz))))
    // supported now (some corner over ground), and a tick on nothing under the hitbox but a fall that hurts
    const least = hull(nx, nz)
    if (least > world.SAFE_DROP && hull(p.x, p.z) <= world.SAFE_DROP) {
      for (const k of ['forward', 'back', 'sprint', 'jump']) if (c[k]) bot.setControlState(k, false)
      bot.setControlState('sneak', true)
      const cell = { x: Math.floor(nx), z: Math.floor(nz), drop: least }
      if (!edgeHeld || edgeHeld.x !== cell.x || edgeHeld.z !== cell.z) log('reflex', `edge: stopped short of a ${least === Infinity ? 'bottomless' : least + '-block'} drop at ${cell.x},${y},${cell.z} (the pathfinder ran on)`)
      edgeHeld = cell
      return
    }
    release()
    return
  }
  for (const r of [0.45, reach]) {
    const x = p.x + hx * r; const z = p.z + hz * r
    if (Math.floor(x) === Math.floor(p.x) && Math.floor(z) === Math.floor(p.z)) continue
    const drop = world.dropAt(bot, x, y, z)
    // (a column no deeper than the one we stand over is no new edge - a ledge walked along is not a cliff stepped off)
    if (drop <= world.SAFE_DROP || drop <= here) continue
    for (const k of ['forward', 'back', 'sprint', 'jump']) if (c[k]) bot.setControlState(k, false)
    bot.setControlState('sneak', true)
    const cell = { x: Math.floor(x), z: Math.floor(z), drop }
    if (!edgeHeld || edgeHeld.x !== cell.x || edgeHeld.z !== cell.z) log('reflex', `edge: stopped short of a ${drop === Infinity ? 'bottomless' : drop + '-block'} drop at ${cell.x},${y},${cell.z}${active ? ' (' + active.kind + ')' : ''}`)
    edgeHeld = cell
    return
  }
  release()
}
function release () { if (edgeHeld) { edgeHeld = null; try { bot.setControlState('sneak', false) } catch {} } }
function edgeAhead () { return edgeHeld }

function tick () {
  if (!bot || !bot.entity || bot.health <= 0) return
  const now = Date.now()
  trackAir(now) // (always: an async reflex or a disabled loop still spends air)
  if (!enabled || busy) return
  const me = bot.entity.position
  tread()

  // 1. AIR
  const underFor = submergedSince ? now - submergedSince : 0
  const diving = dive ? diveHolds(now) : false
  const broken = !!(dive && dive.broken && submergedSince)
  // (short of air = our own clock under 70% of a breath; bot.oxygenLevel stuck at 5 fired this the instant the
  //  head dipped - a bob while swimming at the surface was an emergency)
  if (!diving && (underFor > 2000 || broken || (submergedSince && airMs < AIR_MS * 0.7) || (active && active.kind === 'air'))) {
    if (!submergedSince && active && active.kind === 'air') {
      // head is out: finish standing on something - dry land, or a solid floor under shallow water (a clay pier one
      // below the surface, a river's shelf): the head is out and the body can't sink. Only floating is unfinished.
      const under = world.at(bot, me.x, me.y - 0.2, me.z)
      if (bot.entity.onGround && under && world.isSolid(under)) { floatSince = 0; return clearActive() }
      if (!floatSince) floatSince = now
      // open water - no bank within a few strokes to climb onto: the emergency ended when the head came out. Holding
      // the body afloat here for the full 60s froze an ocean crossing (55 blocks in ten minutes, night fell mid-sea,
      // 2026-09-23); the walk that was interrupted swims on (or boats), and tread() keeps the head up meanwhile.
      const shore = findAir(true)
      if (!shore || Math.abs(shore.x - Math.floor(me.x)) + Math.abs(shore.z - Math.floor(me.z)) > 4) {
        bot.setControlState('jump', true); bot.setControlState('forward', false)
        if (now - floatSince > 1000) { floatSince = 0; return clearActive() }
        return
      }
      // floating for 3s without making land: the bank is too high to climb from the water (a pond
      // with 2-high sides drowned the bot at 4 hp) - cut a step into it
      if (now - floatSince > 3000 && !busy) {
        busy = true
        climbOut().finally(() => { busy = false; floatSince = now })
        return
      }
      if (now - active.since > 60000) { floatSince = 0; return clearActive() }
      steerTo(shore, { jump: true })
      return
    }
    setActive('air', `under ${Math.round(underFor / 100) / 10}s air ${Math.round(airMs / 100) / 10}s`)
    try { bot.pathfinder.setGoal(null) } catch {}
    // straight up to open air (water then air within 6)? Then only UP: steering toward the nearest air cell - the air
    // over the bank - pressed the bot into the bank under water; it drifted sideways and down and drowned in 30s with
    // open water overhead (2026-09-23). Sideways only when something blocks the way up.
    let open = false
    for (let dy = 2; dy <= 7; dy++) { const b = world.at(bot, me.x, me.y + dy, me.z); if (!b || (!world.isWaterBlock(b) && !world.isAirish(b))) break; if (world.isAirish(b)) { open = true; break } }
    // ...unless UP makes no headway: falling water in a one-wide pit (dug for sand under the water line) pushes a
    // swimmer down, and jumping in place drowned the bot a step from dry sand (2026-09-23). After 1.5s without
    // rising, climb out sideways to land.
    if (riseY == null || me.y > riseY + 0.25) { riseY = me.y; riseAt = now }
    const stalled = now - riseAt > 1500
    const land = open && stalled ? findAir(true) : null
    // ...and with no land in reach, an entity over the column (our own boat: a paused bot floating under it drowned
    // jumping into its hull, 2026-09-23) is swum round: open air a couple of strokes to the side
    const aside = open && stalled && !land ? findAir(false, { aside: true }) : null
    if (aside) {
      steerTo(aside, { jump: true })
    } else if (open && !land) {
      bot.setControlState('jump', true)
      for (const k of ['forward', 'back', 'left', 'right', 'sneak']) bot.setControlState(k, false)
    } else if (land) {
      steerTo(land, { jump: true })
    } else {
      const t = findAir()
      if (t) steerTo(t, { jump: true }); else { bot.setControlState('jump', true); bot.setControlState('back', true) }
    }
    return
  }

  // 2. LAVA / FIRE
  if (world.inLava(bot)) {
    setActive('lava')
    try { bot.pathfinder.setGoal(null) } catch {}
    let best = null; let bd = Infinity
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -1; dy <= 2; dy++) {
      const x = Math.floor(me.x) + dx; const y = Math.floor(me.y) + dy; const z = Math.floor(me.z) + dz
      if (!world.standable(bot, x, y, z) || world.lavaNear(bot, { x, y, z }, 0)) continue
      const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy)
      if (d < bd) { bd = d; best = { x, y, z } }
    }
    if (best) steerTo(best, { jump: true, sprint: true }); else { bot.setControlState('jump', true); bot.setControlState('back', true) }
    return
  } else if (active && active.kind === 'lava') return clearActive()

  const hs = hostiles(24)
  const hp = bot.health
  const armed = !!inv.bestWeapon(bot)
  const armor = inv.armorPieces(bot)

  // 3. CREEPER - run straight away, steering by hand. A creeper tracks a player out to 16 blocks,
  // so the run lasts until it is past that; the pathfinder's invert-goal replans too slowly (two
  // deaths: flee "done" at 11b, the creeper closed again, boom). Behind walls it is not a threat.
  // (only one we can see, or one right beside us: a creeper beyond rock can't reach us, and fleeing it every 2s
  //  froze a whole night of mining)
  // a creeper lights its fuse within 3 blocks and gives up beyond 7: keep out of that ring, no further - running
  // until 16 let one creeper drag the bot 60 blocks across the map, a flee every few seconds
  const creeper = hs.find(h => h.e.name === 'creeper' && h.d < 5 && (canSee(h.e) || h.d < 3))
  const stillRunning = active && active.kind === 'creeper' && fleeTarget && fleeTarget.isValid && fleeTarget.position.distanceTo(me) < 9 && now - active.since < 30000
  if (creeper || stillRunning) {
    const t = creeper ? creeper.e : fleeTarget
    fleeTarget = t
    const d = t.position.distanceTo(me)
    setActive('creeper', `${d.toFixed(1)}b`)
    shieldDown()
    try { bot.pathfinder.setGoal(null) } catch {}
    // too close to outrun the fuse: knock it back first (knockback pushes it out of blast range)
    if (d < 3.2 && inv.bestWeapon(bot) && now - lastAttackAt > 500 && canSee(t)) {
      bot.lookAt(t.position.offset(0, 1.2, 0), true).catch(() => {})
      bot.attack(t); lastAttackAt = now
      return
    }
    const h = fleeHeading(t)
    if (h) { bot.setControlState('back', false); steerTo(h, { jump: h.jump, sprint: bot.food > 6 }) }
    else { bot.setControlState('forward', false); bot.setControlState('back', true); bot.setControlState('sprint', false) }
    return
  } else if (active && active.kind === 'creeper') return clearActive()

  // 4. THREAT - fight what can be fought, flee what cannot
  const melee = hs.filter(h => !NEVER_MELEE.has(h.e.name))
  // only what we can actually see (a mob behind the bunker wall is not a fight)
  const close = melee.find(h => h.d < 4.5 && (h.e.name !== 'spider' || !bot.time.isDay || h.d < 3) && canSee(h.e))
  const shooter = melee.find(h => RANGED.has(h.e.name) && h.d < 14 && canSee(h.e))
  const recentlyHurt = now - lastHurtAt < 3000
  const hurtByMelee = recentlyHurt && lastHurtBy && lastHurtBy.isValid && !NEVER_MELEE.has(lastHurtBy.name) && lastHurtBy.position.distanceTo(me) < 6 ? lastHurtBy : null
  let target = close ? close.e : (hurtByMelee || null)
  // charge a shooter only with a shield or armour to take the arrows, or when it is already close - an
  // unarmoured run at a skeleton 11b away lost 9 hp before the first swing, and the next one killed the bot
  if (!target && shooter && armed && hp >= 12 && (inv.offhandShield(bot) || armor >= 2 || shooter.d < 5)) target = shooter.e
  if (!target && shooter && recentlyHurt) {
    // being shot and not going to fight it: out of its line of sight
    fleeTarget = shooter.e
    setActive('flee', `cover from ${shooter.e.name} ${shooter.d.toFixed(1)}b`)
    try { bot.pathfinder.setGoal(null) } catch {}
    const h = fleeHeading(shooter.e)
    if (h) { bot.setControlState('back', false); steerTo(h, { jump: h.jump, sprint: bot.food > 6 }) }
    else if (!busy) {
      // nowhere to run (a tunnel): put a wall between us - a skeleton down a straight corridor shot the bot
      // from 13 blocks while "cover" had no side to step to
      busy = true
      wallOff(shooter.e).finally(() => { busy = false })
    }
    return
  }
  // bare fists do 1 damage against 20 hp: without a weapon, back off (and let the shelter logic dig
  // in) unless it is a weak mob we can finish or we have nowhere to go
  // (the hurt line: two hits from death - without armour a zombie on hard takes 4.5 a hit)
  const weak = hp <= hurtLine() || (!armed && !(target && /^(silverfish|endermite)$/.test(target.name)))
  // at night, unable to fight: running across open ground in the dark gets you surrounded - dig
  // straight down on the spot and plug the hole (a player's respawn-at-night move)
  const nightThreat = !armed && world.phase(bot) !== 'day' ? hs.find(h => h.d < 16 && h.e.name !== 'creeper') : null
  // digging in takes seconds: never with a mob about to hit us, never through the safehouse floor
  const nearest = hs.length ? hs[0].d : Infinity
  const inHut = require('./move').insideHut(bot.entity.position.floored())
  if (((target && weak) || nightThreat) && world.phase(bot) !== 'day' && nearest >= 6 && !inHut && !enclosed() && canDigInHere()) {
    busy = true
    const t = target || nightThreat.e
    setActive('dig-in', `${t.name} ${t.position.distanceTo(me).toFixed(1)}b, can't fight`)
    digIn().finally(() => { busy = false; clearActive() })
    return
  }
  if (target && weak && hs.filter(h => h.d < 10).length) {
    fleeTarget = target
    setActive('flee', `hp ${Math.round(hp)} - ${target.name}`)
    shieldDown()
    try { bot.pathfinder.setGoal(null) } catch {}
    const h = fleeHeading(target)
    if (h) { bot.setControlState('back', false); steerTo(h, { jump: h.jump, sprint: bot.food > 6 }) }
    else { bot.setControlState('forward', false); bot.setControlState('back', true) }
    return
  }
  if (target && target.isValid) {
    const d = target.position.distanceTo(me)
    const why = target === (close && close.e) ? 'close' : target === hurtByMelee ? 'hit me' : 'shooter'
    // whatever picked it: never chase a shooter across open ground without a shield or armour
    if (RANGED.has(target.name) && d > 5 && !inv.offhandShield(bot) && armor < 2) {
      fleeTarget = target
      setActive('flee', `cover from ${target.name} ${d.toFixed(1)}b (${why})`)
      shieldDown()
      try { bot.pathfinder.setGoal(null) } catch {}
      const h = fleeHeading(target)
      if (h) { bot.setControlState('back', false); steerTo(h, { jump: h.jump, sprint: bot.food > 6 }) }
      return
    }
    setActive('fight', `${target.name} ${d.toFixed(1)}b (${why})`)
    if (armed && (!bot.heldItem || !/_(sword|axe)$/.test(bot.heldItem.name))) { busy = true; inv.equipWeapon(bot).finally(() => { busy = false }); return }
    if (d > 2.8) {
      bot.pathfinder.setMovements(require('./move').movementsFor(bot, { dig: false, place: false }))
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true)
    } else {
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    bot.lookAt(target.position.offset(0, (target.height || 1.6) * 0.85, 0), true).catch(() => {})
    const swingReady = d < 3.4 && now - lastAttackAt > attackCooldownMs() && canSee(target)
    if (inv.offhandShield(bot)) {
      // shield up between swings (arrows and zombie hits land on it); down for the swing itself
      if (swingReady) { shieldDown(); bot.attack(target); lastAttackAt = now } else if (now - lastAttackAt > 150) shieldUp()
    } else if (swingReady) { bot.attack(target); lastAttackAt = now }
    return
  }
  if (active && (active.kind === 'fight' || active.kind === 'flee')) {
    // hold the fight a moment after the last target vanishes, then release
    if (!hs.some(h => h.d < 8)) return clearActive()
    if (active.kind === 'flee' && (!fleeTarget || !fleeTarget.isValid || fleeTarget.position.distanceTo(me) > 14)) return clearActive()
    if (active.kind === 'fight') return clearActive()
    // a shooter that can't see us any more is escaped
    if (fleeTarget && RANGED.has(fleeTarget.name) && !canSee(fleeTarget)) return clearActive()
    // still running: keep steering (held controls alone would carry us off a cliff)
    const h = fleeHeading(fleeTarget)
    if (h) steerTo(h, { jump: h.jump, sprint: bot.food > 6 }); else return clearActive()
    return
  }

  // 5. EAT - when hungry and nothing is attacking
  // (hurt: eat up to the food bar regeneration needs - below it the hp never comes back)
  const hungry = bot.food <= 14 || (hp < 20 && bot.food < inv.REGEN_FOOD)
  // (not while swimming - a bite lets go of the stroke - but a boat is a seat: eat in it)
  if (hungry && !hs.some(h => h.d < 8) && now - lastEatFail > 10000 && (!world.feetInWater(bot) || bot.vehicle)) {
    if (inv.foodItems(bot, { desperate: bot.food <= 6 }).length) { doEat(); return }
  }

  // 6. DRESS - armour in the pack better than what is worn goes on, whoever put it there (a grave, a chest, a pickup).
  // Wearing used to follow only a craft or a grave recovery: an iron helmet rode in the pack while skeletons shot the
  // bare-headed bot dead four times in an hour (2026-09-25). (Not with a window open; a piece the server refused
  // waits for the inventory to change.)
  if (!bot.currentWindow && !hs.some(h => h.d < 8)) {
    const k = inv.betterArmorInPack(bot)
    if (k && k !== dressFailed) {
      busy = true
      inv.wearBestArmor(bot).then(() => { if (inv.betterArmorInPack(bot) === k) dressFailed = k }).catch(() => { dressFailed = k }).finally(() => { busy = false })
    }
  }
}

function install (b) {
  bot = b
  bot.inventory.on('updateSlot', () => { dressFailed = null })
  bot.on('entityHurt', (e, source) => {
    if (e !== bot.entity) return
    lastHurtAt = Date.now()
    // the server names who hurt us (damage_event's source entity - the skeleton, not its arrow); none for a fall,
    // drowning, a cactus. (It used to be the nearest hostile: a fall beside a zombie was "hit by the zombie".)
    lastHurtBy = source && source !== bot.entity ? source : null
  })
  bot.on('death', () => { active = null; busy = false; blocking = false; floatSince = 0; submergedSince = 0; airMs = AIR_MS; if (dive) dive.broken = 'died'; fleeTarget = null; diedAt = Date.now() })
  // respawned into the dark: dig in on the spot before anything finds us
  bot.on('spawn', () => {
    if (!diedAt || Date.now() - diedAt > 15000) return
    diedAt = 0
    setTimeout(() => {
      try {
        // respawning at our bed means respawning in the safehouse: that IS the shelter - no hole in its floor
        if (!bot.entity || busy || world.phase(bot) === 'day' || enclosed() || require('./move').insideHut(bot.entity.position.floored()) || !canDigInHere()) return
        busy = true
        setActive('dig-in', 'respawned at night')
        digIn().finally(() => { busy = false; clearActive() })
      } catch {}
    }, 1500)
  })
  setInterval(() => { try { tick() } catch (e) { log('reflex', 'tick error: ' + e.message) } }, 200)
  bot.on('physicsTick', () => { try { edgeGuard() } catch (e) { log('reflex', 'edge guard error: ' + e.message) } })
}

function isActive () { return active ? active.kind : null }
function info () { return active ? { kind: active.kind, detail: active.detail, forSec: Math.round((Date.now() - active.since) / 1000) } : null }
function lastHurt () { return lastHurtAt ? { at: lastHurtAt, by: lastHurtBy ? lastHurtBy.name || lastHurtBy.type : null } : null }
function nearestThreat () {
  if (!bot || !bot.entity) return null
  const h = hostiles(16)[0]
  return h ? { type: h.e.name, dist: Math.round(h.d * 10) / 10 } : null
}
async function waitClear (maxMs = 120000) {
  const t0 = Date.now()
  while (active && Date.now() - t0 < maxMs) await new Promise(r => setTimeout(r, 250))
}
function setEnabled (on) { enabled = !!on; if (!on) clearActive() }

// The skill's view of the air clock: time with the head under (since the last breath) and the air left.
function underMs () { return submergedSince ? Date.now() - submergedSince : 0 }
function airLeftMs () { return airMs }

module.exports = { install, active: isActive, info, nearestThreat, lastHurt, hurtLine, edgeAhead, hostiles, waitClear, setEnabled, findAir, HOSTILE, startDive, endDive, diveBroken, underMs, airLeftMs, AIR_MS, DIVE_HARD_MS }
