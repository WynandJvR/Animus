'use strict'
// BOATS - a player crosses open water in a boat. Swimming 1500 blocks of ocean drowned the bot twice and covered
// 55 blocks in ten minutes the third time (2026-09-23). move.travel asks decideLeg() at every leg; when the line
// ahead runs over open water it calls cross(): get a boat (pack, bank, craft), put it on the water by the shore,
// get in, steer for the target, step off onto land at the far shore and break the boat to carry it on.
//
// THE RIDE IS OURS TO SIMULATE. A boat with a player in it is moved by that player's CLIENT: the server stops
// ticking it and takes the client's `vehicle_move` packets as the truth, answering a refused one with its own
// `vehicle_move` (the correction). mineflayer switches its physics off on `mount` and its moveVehicle only sends
// player_input, which a boat ignores - so drive() is the boat's physics: accelerate along the heading, stop at
// anything solid, stay on the water level it was launched on, and send the position every tick.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const { log } = require('./log')
const control = require('./control')
const mem = require('./memory')

const BOAT_ITEM_RE = /_(boat|raft)$/ // (chest boats are boats too)
const BOAT_ENTITY_RE = /_(boat|raft)$/
const OPEN_WATER = 12 // a water run this long on the line ahead is a crossing, not a puddle to swim
const LAUNCH_NEAR = 5 // the water starts within this many blocks: launch here (further: walk to the shore first)
const SCAN = 64 // how far ahead a leg looks (loaded chunks only)
const HALF = 0.6875; const HEIGHT = 0.5625 // the boat's box (minecraft-data: 1.375 x 0.5625)
// vanilla on water: +0.04 a tick forward, x0.9 friction a tick -> ~0.36 b/tick (7 b/s)
const ACCEL = 0.04; const FRICTION = 0.9; const TURN = 0.12
const BIG_LAND = 8 // land ahead this deep along the line is a shore to land on, not an islet to steer round

const sleep = ms => new Promise(r => setTimeout(r, ms))
function fmt (p) { return p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?' }
function angDiff (a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d }
// mineflayer yaw: 0 faces -z, the direction of travel is (-sin, -cos)
function bearing (from, to) { return Math.atan2(-(to.x - from.x), -(to.z - from.z)) }

let riding = false // drive() owns the body (main.js keeps body.js's paralysis check off a boat)
let provisioning = false // ensureBoat is fetching one: the walks it makes are walks, not crossings
function driving () { return riding }
function busy () { return provisioning }
function swimming (bot) {
  if (bot.vehicle) return false
  const p = bot.entity.position
  return world.feetInWater(bot) && !world.isSolid(world.at(bot, p.x, p.y - 1, p.z))
}
function inBoat (bot) { return !!(bot.vehicle && BOAT_ENTITY_RE.test(bot.vehicle.name || '')) }

// ---- reading the way ahead -------------------------------------------------------------------
// The surface columns on the straight line from `from` toward `to`, one per block: 'w' water on top, 'l' land,
// '?' not loaded. Index 0 is one block ahead.
function scanLine (bot, from, to, maxDist = SCAN) {
  const d = Math.min(maxDist, Math.floor(world.dist2(from, to)))
  const ux = (to.x - from.x) / (world.dist2(from, to) || 1); const uz = (to.z - from.z) / (world.dist2(from, to) || 1)
  const refY = Math.floor(from.y) + 12
  let s = ''
  for (let k = 1; k <= d; k++) {
    const x = Math.floor(from.x + ux * k); const z = Math.floor(from.z + uz * k)
    const gy = world.groundY(bot, x, z, refY)
    if (gy == null) { s += '?'; continue }
    s += world.isWaterBlock(world.at(bot, x, gy, z)) ? 'w' : 'l'
  }
  return s
}

// PURE: walk this leg, or cross by boat? `kinds` is scanLine's string.
//   boat - open water starts right here (or we are already swimming in it)
//   walk with legLen - open water further on: walk to the shore (stop short of the water) and decide there
//   walk - no open water on the line
// Unloaded columns past the water's edge count as more water (an ocean runs on into chunks we do not have).
function decideLeg (kinds, { swimming = false, step = 40 } = {}) {
  const i = kinds.indexOf('w')
  if (i < 0) return { mode: 'walk', legLen: step }
  let run = 0; for (let k = i; k < kinds.length && kinds[k] !== 'l'; k++) run++
  if (run < OPEN_WATER) return { mode: 'walk', legLen: step, waterAt: i + 1, run }
  if (swimming || i + 1 <= LAUNCH_NEAR) return { mode: 'boat', waterAt: i + 1, run }
  return { mode: 'walk', legLen: Math.max(2, Math.min(step, i - 1)), waterAt: i + 1, run, toShore: true }
}

// PURE: from the boat's bow, is the land ahead a shore to step onto (true) or an islet to steer round (false)?
// Deep land along the line, or the target itself on it.
function bigLandAhead (kinds, distToTarget) {
  const i = kinds.indexOf('l')
  if (i < 0) return false
  if (distToTarget <= i + 1 + BIG_LAND) return true
  let run = 0; for (let k = i; k < kinds.length && kinds[k] !== 'w'; k++) run++
  return run >= BIG_LAND
}

// Open water to put a boat on: a surface water cell (air over it) whose 3x3 has nothing solid at the boat's
// height - a boat box touching the bank is refused. Near us, toward the target.
function openCell (bot, x, z, refY) {
  const gy = world.groundY(bot, x, z, refY)
  if (gy == null || !world.isWaterBlock(world.at(bot, x, gy, z))) return null
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const a = world.at(bot, x + dx, gy, z + dz); const b = world.at(bot, x + dx, gy + 1, z + dz)
    if (!a || !b || world.isSolid(a) || world.isSolid(b) || !world.isAirish(b)) return null
  }
  return { x, y: gy, z }
}
function chooseLaunch (bot, target, radius = 8) {
  const me = bot.entity.position
  const refY = Math.floor(me.y) + 6
  const direct = world.dist2(me, target)
  let best = null; let bs = Infinity
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const x = Math.floor(me.x) + dx; const z = Math.floor(me.z) + dz
    const c = openCell(bot, x, z, refY)
    if (!c) continue
    const p = { x: x + 0.5, z: z + 0.5 }
    if (world.dist2(me, p) < 1.5) continue // (not on top of ourselves: the boat would land on our head)
    const s = world.dist2(me, p) * 1.3 - (direct - world.dist2(p, target))
    if (s < bs) { bs = s; best = c }
  }
  return best
}

// A cell to step off onto: standable ground within a stride of the boat, at the water's level or a block or two
// up; the nearest, then the one toward the target.
function landingCell (bot, pos, wy, target, reach = 2.6) {
  let best = null; let bs = Infinity
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const y of [wy + 1, wy + 2, wy + 3]) {
    const x = Math.floor(pos.x) + dx; const z = Math.floor(pos.z) + dz
    const d = Math.hypot(x + 0.5 - pos.x, z + 0.5 - pos.z)
    if (d > reach || !world.standable(bot, x, y, z)) continue
    const s = d + (y - wy - 1) * 0.5 + (target ? world.dist2({ x: x + 0.5, z: z + 0.5 }, target) * 0.01 : 0)
    if (s < bs) { bs = s; best = { x, y, z } }
  }
  return best
}

// The nearest dry ground to stand on (the director's "get out of the sea" at night). Loaded columns only.
function nearestLand (bot, radius = 48) {
  const me = bot.entity.position
  const refY = Math.floor(me.y) + 12
  for (let r = 1; r <= radius; r++) {
    let best = null; let bd = Infinity
    for (let dx = -r; dx <= r; dx++) for (const dz of (Math.abs(dx) === r ? rangeInt(-r, r) : [-r, r])) {
      const x = Math.floor(me.x) + dx; const z = Math.floor(me.z) + dz
      const gy = world.groundY(bot, x, z, refY)
      if (gy == null || !world.standable(bot, x, gy + 1, z)) continue
      const d = Math.hypot(dx, dz)
      if (d < bd) { bd = d; best = { x, y: gy + 1, z } }
    }
    if (best) return best
  }
  return null
}
function rangeInt (a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o }

// Can the boat's box stand at (x,y,z)? true / false (something solid, or no water under it - aground or over a
// drop) / null (not loaded: unknown is never "clear").
function boxClear (bot, x, y, z, wy) {
  for (let cx = Math.floor(x - HALF); cx <= Math.floor(x + HALF); cx++) {
    for (let cz = Math.floor(z - HALF); cz <= Math.floor(z + HALF); cz++) {
      for (let cy = Math.floor(y); cy <= Math.floor(y + HEIGHT); cy++) {
        const b = world.at(bot, cx, cy, cz)
        if (!b) return null
        if (world.isSolid(b)) return false
      }
    }
  }
  const w = world.at(bot, x, wy, z)
  if (!w) return null
  return world.isWaterBlock(w)
}
// (every quarter block from the bow on: a boat already alongside a bank must not "see" open water two blocks out
//  through the corner it is touching - it never moved, pressed against an islet)
function aheadClear (bot, pos, yaw, wy, dist = 3) {
  for (let k = 0.25; k <= dist; k += 0.25) {
    const c = boxClear(bot, pos.x - Math.sin(yaw) * k, pos.y, pos.z - Math.cos(yaw) * k, wy)
    if (c !== true) return c
  }
  return true
}

// Where to point the bow: the target's bearing, else the smallest turn off it with open water ahead. An islet on
// the line is steered round; deep land (bigLandAhead) or nothing open at all is the shore.
// (out to square across and a little back: alongside a bank the only way off it is sideways)
const OFFSETS = [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2, 1.57, -1.57, 2.0, -2.0]
function heading (bot, pos, wy, target) {
  const b = bearing(pos, target)
  const straight = aheadClear(bot, pos, b, wy)
  if (straight === true) return { yaw: b }
  if (straight === null) return { unknown: true }
  if (bigLandAhead(scanLine(bot, pos, target, 32), world.dist2(pos, target))) return { shore: true, yaw: b }
  for (const o of OFFSETS.slice(1)) if (aheadClear(bot, pos, b + o, wy) === true) return { yaw: b + o, round: true }
  return { shore: true, yaw: b }
}

// ---- getting a boat ------------------------------------------------------------------------------
function boatItem (bot) { return inv.items(bot).find(i => BOAT_ITEM_RE.test(i.name)) || null }
async function ensureBoat (bot, { shouldStop } = {}) {
  if (boatItem(bot)) return true
  // a boat takes a crafting table, and a table takes ground: in the water there is no making one
  if (swimming(bot) || !bot.entity.onGround) return false
  const craft = require('./craft')
  const w = craft.preferredWood(bot, 5)
  const name = world.data(bot).itemsByName[w + '_boat'] ? w + '_boat' : 'oak_boat'
  const start = bot.entity.position.clone()
  log('move', `boat: getting a ${name} for the crossing`)
  provisioning = true
  try {
    // (the bank within a short walk, else planks from the pack or the nearest trees - never a trek back home)
    await craft.ensure(bot, name, 1, { shouldStop: () => (shouldStop && shouldStop()) || world.dist2(bot.entity.position, start) > 80 })
  } catch (e) { log('move', `boat: getting one threw: ${e.message}`) } finally { provisioning = false }
  return !!boatItem(bot)
}

// ---- launching ----------------------------------------------------------------------------------
function boatNear (bot, p, r, exclude) {
  let best = null; let bd = Infinity
  for (const e of Object.values(bot.entities)) {
    if (!e || !e.position || !BOAT_ENTITY_RE.test(e.name || '') || exclude.has(e.id)) continue
    const d = Math.hypot(e.position.x - p.x, e.position.z - p.z)
    if (d <= r && d < bd) { bd = d; best = e }
  }
  return best
}
async function mount (bot, e) {
  for (let i = 0; i < 3 && bot.vehicle !== e; i++) {
    if (!e.isValid && !bot.entities[e.id]) return false
    const d = bot.entity.position.distanceTo(e.position)
    if (d > 2.8) await require('./move').goTo(bot, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 1), { timeoutMs: 8000, stuckMs: 4000, dig: false, place: false, label: 'to the boat' })
    try { bot.setControlState('sneak', false) } catch {}
    await bot.lookAt(e.position.offset(0, 0.3, 0), true).catch(() => {})
    try { bot.mount(e) } catch {}
    for (let k = 0; k < 20 && bot.vehicle !== e; k++) await sleep(100)
  }
  return bot.vehicle === e
}
// Put the boat on the water and get in. Returns the boat entity, or null with the reason logged.
async function launch (bot, target, { shouldStop } = {}) {
  const move = require('./move')
  let c = chooseLaunch(bot, target)
  if (!c) { log('move', `boat: no open water to launch on near ${fmt(bot.entity.position)}`); return null }
  const aim = () => new Vec3(c.x + 0.5, c.y + 0.85, c.z + 0.5) // (the top face of the water: source water is 8/9 high)
  const eyeTo = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(aim())
  if (eyeTo() > 4) {
    await move.goTo(bot, new goals.GoalNear(c.x, c.y + 1, c.z, 2), { timeoutMs: 20000, stuckMs: 6000, dig: false, place: false, label: 'to the water\'s edge', shouldStop })
    c = (eyeTo() > 4 && chooseLaunch(bot, target, 4)) || c
    if (eyeTo() > 4.3) { log('move', `boat: couldn't get within reach of the water at ${fmt(c)}`); return null }
  }
  const it = boatItem(bot)
  if (!it) return null
  const before = new Set(Object.values(bot.entities).filter(e => e && BOAT_ENTITY_RE.test(e.name || '')).map(e => e.id))
  try { await bot.equip(it, 'hand') } catch (e) { log('move', `boat: couldn't hold the ${it.name}: ${e.message}`); return null }
  move.stopMoving(bot)
  await bot.lookAt(aim(), true).catch(() => {})
  await sleep(150) // (the look goes out on the next physics tick; use_item carries it too, belt and braces)
  bot.activateItem()
  let e = null
  for (let k = 0; k < 25 && !e; k++) { await sleep(100); e = boatNear(bot, aim(), 3, before) }
  try { bot.deactivateItem() } catch {}
  if (!e) { log('move', `boat: placed the ${it.name} at ${fmt(c)} but no boat appeared`); return null }
  await sleep(400) // (let it settle on the surface before stepping in)
  if (!await mount(bot, e)) { log('move', `boat: couldn't get into the boat at ${fmt(e.position)}`); await pickUp(bot, e); return null }
  log('move', `boat: launched at ${fmt(e.position)} (${Math.round(world.dist2(e.position, target))}b to ${fmt(target)})`)
  return e
}

// ---- the ride ------------------------------------------------------------------------------------
function sendRide (bot, pos, yaw, v) {
  const conv = require('mineflayer/lib/conversions')
  const y = conv.toNotchianYaw(yaw)
  try {
    bot._client.write('vehicle_move', { x: pos.x, y: pos.y, z: pos.z, yaw: y, pitch: 0, onGround: false })
    bot._client.write('look', { yaw: y, pitch: 0, flags: { onGround: false, hasHorizontalCollision: false } })
    bot._client.write('steer_boat', { leftPaddle: v > 0.02, rightPaddle: v > 0.02 }) // (the paddles others see)
  } catch {}
}
// Steer for the target until the shore (or the target) is reached. Returns { ok, why, pos, wy }:
//   ok  'shore' (land ahead to step onto) / 'arrived'
//   !ok 'stopped' / 'thrown out' / 'no headway' / 'unloaded' / 'server refuses' / 'not on water'
async function drive (bot, target, { range = 3, cancelled = () => false } = {}) {
  const e = bot.vehicle
  const pos = e.position.clone()
  let wy = Math.floor(pos.y - 0.2)
  if (!world.isWaterBlock(world.at(bot, pos.x, wy, pos.z))) wy--
  if (!world.isWaterBlock(world.at(bot, pos.x, wy, pos.z))) return { ok: false, why: 'not on water', pos, wy }
  let yaw = bearing(pos, target); let v = 0
  const start = pos.clone(); const t0 = Date.now()
  let best = world.dist2(pos, target); let bestAt = t0; let unknownSince = 0; let lastLog = t0
  let fixes = []
  const onFix = p => { pos.set(p.x, p.y, p.z); fixes.push(Date.now()) } // the server put the boat back
  bot._client.on('vehicle_move', onFix)
  riding = true
  const done = (ok, why) => ({ ok, why, pos: pos.clone(), wy, travelled: Math.round(world.dist2(start, pos)) })
  try {
    for (;;) {
      await sleep(50)
      const now = Date.now()
      if (bot.vehicle !== e) return done(false, 'thrown out')
      if (cancelled()) { sendRide(bot, pos, yaw, 0); return done(false, 'stopped') }
      const d = world.dist2(pos, target)
      if (d < best - 1) { best = d; bestAt = now }
      if (d <= range) return done(true, 'arrived')
      if (now - bestAt > 20000) return done(false, 'no headway')
      fixes = fixes.filter(t => now - t < 5000)
      if (fixes.length > 20) return done(false, 'server refuses')
      const h = heading(bot, pos, wy, target)
      if (h.unknown) {
        // chunks ahead not here yet: wait for them, as a player does
        v = 0; bestAt = now; if (!unknownSince) unknownSince = now // (waiting is not a lack of headway)
        if (now - unknownSince > 20000) return done(false, 'unloaded')
        sendRide(bot, pos, yaw, 0); continue
      }
      unknownSince = 0
      if (h.shore) {
        // deep land ahead: close in until the bow touches or a step-off cell is right alongside (the boat is picked
        // up from the bank after)
        if (landingCell(bot, pos, wy, target, 1.6) || boxClear(bot, pos.x - Math.sin(h.yaw) * 0.3, pos.y, pos.z - Math.cos(h.yaw) * 0.3, wy) !== true) return done(true, 'shore')
      }
      const turn = angDiff(h.yaw, yaw)
      yaw += Math.max(-TURN, Math.min(TURN, turn))
      v = (v + (Math.abs(turn) < 0.6 ? ACCEL : ACCEL / 4)) * FRICTION
      if (h.shore) v = Math.min(v, 0.1)
      const nx = pos.x - Math.sin(yaw) * v; const nz = pos.z - Math.cos(yaw) * v
      if (boxClear(bot, nx, pos.y, nz, wy) === true) pos.set(nx, pos.y, nz); else v = 0
      sendRide(bot, pos, yaw, v)
      e.position.set(pos.x, pos.y, pos.z)
      bot.entity.position.set(pos.x, pos.y, pos.z)
      bot.entity.yaw = yaw
      if (now - lastLog > 30000) { lastLog = now; log('move', `boat: ${Math.round(d)}b to go, at ${fmt(pos)}${h.round ? ' (steering round land)' : ''}`) }
    }
  } finally {
    bot._client.removeListener('vehicle_move', onFix)
    riding = false
  }
}

// Step off toward `cell` (the server puts a dismounting rider on the side it faces, if there is room there).
async function dismount (bot, cell) {
  const conv = require('mineflayer/lib/conversions')
  const e = bot.vehicle
  if (!e) return true
  riding = true // (still ours until the server lets go)
  try {
    if (cell) {
      const y = conv.toNotchianYaw(bearing(e.position, { x: cell.x + 0.5, z: cell.z + 0.5 }))
      try { bot._client.write('look', { yaw: y, pitch: 0, flags: { onGround: false, hasHorizontalCollision: false } }) } catch {}
    }
    // 1.21.6+: getting out is the sneak key (player_input shift); mineflayer's dismount() still sends jump
    for (let i = 0; i < 3 && bot.vehicle; i++) {
      try { bot._client.write('player_input', { inputs: { shift: true } }) } catch {}
      for (let k = 0; k < 15 && bot.vehicle; k++) await sleep(100)
      try { bot._client.write('player_input', { inputs: { shift: false } }) } catch {}
    }
  } finally { riding = false }
  if (bot.vehicle) return false
  // the server's teleport switches mineflayer's physics back on; give it a moment to land us
  for (let k = 0; k < 20 && !bot.entity.onGround; k++) await sleep(100)
  return true
}

// Break the boat we left (a boat hit enough drops itself) and pick it up.
async function pickUp (bot, e) {
  const move = require('./move')
  const act = require('./act')
  const had = inv.count(bot, n => BOAT_ITEM_RE.test(n))
  const t0 = Date.now()
  let last = e.position.clone()
  await inv.equipWeapon(bot).catch(() => {})
  while (Date.now() - t0 < 12000 && bot.entities[e.id]) {
    last = e.position.clone()
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(e.position) > 3.4) { // (reach is to the boat's box, 0.7 round its middle)
      await move.goTo(bot, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), { timeoutMs: 6000, stuckMs: 3000, dig: false, place: false, label: 'to the boat' })
      continue
    }
    await bot.lookAt(e.position.offset(0, 0.3, 0), true).catch(() => {})
    bot.attack(e)
    await sleep(350)
  }
  if (bot.entities[e.id]) { log('move', `boat: couldn't break the boat at ${fmt(last)} - left it`); return false }
  // the boat item floats where the boat was and DRIFTS (twice on 2026-09-24 it floated off while the walk aimed at the
  // spot the boat had been): follow the boat item itself, wherever it has got to, for a few tries
  const boatDrop = () => act.droppedItems(bot, 10).filter(d => { try { return BOAT_ITEM_RE.test(d.getDroppedItem().name) } catch { return false } })
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  for (let k = 0; k < 6 && inv.count(bot, n => BOAT_ITEM_RE.test(n)) <= had; k++) {
    const drop = boatDrop()
    if (!drop) { await sleep(400); continue }
    await move.goTo(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5), { timeoutMs: 6000, stuckMs: 3000, dig: false, place: false, label: 'pickup' })
    await sleep(300)
  }
  const ok = inv.count(bot, n => BOAT_ITEM_RE.test(n)) > had
  log('move', ok ? 'boat: picked the boat back up' : `boat: broke the boat but didn't get it back (at ${fmt(last)})`)
  return ok
}

// ---- the crossing -----------------------------------------------------------------------------------
// Launch (unless already afloat), ride to the far shore, step off, take the boat. `cancelled` is the operator's
// stop only: a crossing is never abandoned mid-water for anything else (night on open water in a boat is safer
// than any shore we could reach by swimming). Returns { ok, why }.
async function cross (bot, target, { range = 3, shouldStop } = {}) {
  const cancelled = control.token()
  if (!inBoat(bot)) {
    if (!await ensureBoat(bot, { shouldStop })) { log('move', `boat: none to be had here (${fmt(bot.entity.position)}) - one goes in the kit from now on`); mem.set('wantBoat', true); return { ok: false, why: 'no boat' } }
    if (cancelled()) return { ok: false, why: 'stopped' }
    const e0 = await launch(bot, target, { shouldStop })
    if (!e0) return { ok: false, why: 'launch failed' }
  }
  const e = bot.vehicle
  const r = await drive(bot, target, { range, cancelled })
  if (r.why === 'stopped') { log('move', `boat: stopped afloat at ${fmt(r.pos)}`); return { ok: false, why: 'stopped' } }
  if (r.why === 'thrown out') { log('move', `boat: out of the boat at ${fmt(bot.entity.position)} (+${r.travelled} blocks)`); return { ok: false, why: 'thrown out' } }
  const cell = landingCell(bot, r.pos, r.wy, target)
  if (!r.ok) log('move', `boat: ${r.why} at ${fmt(r.pos)} after +${r.travelled} blocks${cell ? ' - stepping ashore' : ''}`)
  if (!r.ok && !cell) return { ok: false, why: r.why, travelled: r.travelled } // (afloat: travel decides - another heading, or swim)
  if (!await dismount(bot, cell)) { log('move', `boat: couldn't get out at ${fmt(r.pos)}`); return { ok: false, why: 'stuck in the boat' } }
  if (cell && !world.standable(bot, Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z))) {
    await require('./move').goTo(bot, new goals.GoalBlock(cell.x, cell.y, cell.z), { timeoutMs: 10000, stuckMs: 4000, dig: false, place: false, label: 'ashore' })
  }
  log('move', `boat: +${r.travelled} blocks, landed at ${fmt(bot.entity.position)} (${r.why})`)
  await pickUp(bot, e)
  return { ok: true, why: r.why, travelled: r.travelled }
}

// Out of the boat wherever we are (travel giving up on it): swim from here.
async function leave (bot) {
  const e = bot.vehicle
  if (!e) return true
  const ok = await dismount(bot, null)
  if (ok) await pickUp(bot, e)
  return ok
}

module.exports = { scanLine, decideLeg, bigLandAhead, chooseLaunch, landingCell, nearestLand, boxClear, heading, ensureBoat, launch, drive, dismount, pickUp, cross, leave, swimming, inBoat, driving, busy, OPEN_WATER, LAUNCH_NEAR }
