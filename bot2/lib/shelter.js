'use strict'
// Nights. Options, best first: sleep in our bed (skips the night / sets spawn), mine through the
// night underground, or dig a sealed bunker and wait. The director picks based on the world.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const craft = () => require('./craft')

const BED_RE = /_bed$/

function bedBlock (bot) {
  const b = mem.get().bed
  if (!b) return null
  const blk = bot.blockAt(new Vec3(b.x, b.y, b.z))
  if (blk && BED_RE.test(blk.name)) return blk
  if (blk) { // loaded and not a bed any more
    log('shelter', `my bed at ${move.fmt(b)} is gone`)
    mem.set('bed', null)
  }
  return null
}

function hasBedItem (bot) { return inv.items(bot).some(i => BED_RE.test(i.name)) }

// Craft a bed from 3 same-colour wool + planks (wool is hunted from sheep).
async function obtainBed (bot, ctx = {}) {
  if (hasBedItem(bot)) return true
  // a bed of ours still standing somewhere near home (left behind by a move): pick it up
  const home = mem.get().home
  const stray = world.findBlocks(bot, BED_RE, { maxDistance: 48, count: 4, point: home ? new Vec3(home.x, home.y, home.z) : undefined })
    .filter(b => !move.insideHut(b.position))[0]
  if (stray) {
    log('shelter', `picking up the bed standing at ${move.fmt(stray.position)}`)
    await act.dig(bot, stray.position, { force: true, allowZones: ['base', 'build'] })
    await act.collectDrops(bot, { radius: 6, maxMs: 6000 })
    if (hasBedItem(bot)) return true
  }
  // a bed lying on the ground near home (dropped when it was moved): pick it up
  const dropped = Object.values(bot.entities).find(e => {
    if (!e || e.name !== 'item' || !e.position || (home && world.dist3(e.position, home) > 48)) return false
    try { const it = e.getDroppedItem(); return it && BED_RE.test(it.name) } catch { return false }
  })
  if (dropped) {
    log('shelter', `picking up the bed lying at ${move.fmt(dropped.position)}`)
    await move.goTo(bot, new goals.GoalNear(dropped.position.x, dropped.position.y, dropped.position.z, 0.5), { timeoutMs: 30000, label: 'to dropped bed' })
    await act.collectDrops(bot, { radius: 4, maxMs: 4000 })
    if (hasBedItem(bot)) return true
  }
  const c = inv.counts(bot)
  const colour = Object.keys(c).find(n => /_wool$/.test(n) && c[n] >= 3)
  if (colour) return craft().ensure(bot, colour.replace('_wool', '_bed'), 1, ctx)
  // most sheep are white
  if (!await craft().ensure(bot, 'white_wool', 3, ctx)) return false
  return craft().ensure(bot, 'white_bed', 1, ctx)
}

// Place the bed near home in a spot with a roof or at least walls nearby.
async function placeBed (bot, near) {
  const item = inv.items(bot).find(i => BED_RE.test(i.name))
  if (!item) return false
  const c = near || world.feetPos(bot)
  const spots = []
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (const dy of [0, -1, 1]) {
    const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
    const floor = world.at(bot, p.x, p.y - 1, p.z); const cell = world.at(bot, p.x, p.y, p.z); const up = world.at(bot, p.x, p.y + 1, p.z)
    if (!floor || !world.isSolid(floor) || !cell || !world.isAirish(cell) || !up || !world.isAirish(up)) continue
    if (!move.utilitySpotOK(p)) continue
    // needs a free head cell beside it (beds are 2 long) in some direction
    let ok = false
    for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const f2 = world.at(bot, p.x + ex, p.y - 1, p.z + ez); const c2 = world.at(bot, p.x + ex, p.y, p.z + ez)
      if (f2 && world.isSolid(f2) && c2 && world.isAirish(c2)) ok = true
    }
    if (!ok) continue
    const roof = !world.openSky(bot, p)
    spots.push(Object.assign(p, { score: Math.abs(dx) + Math.abs(dz) - (roof ? 6 : 0) }))
  }
  spots.sort((a, b) => a.score - b.score)
  for (const s of spots.slice(0, 6)) {
    const r = await move.goTo(bot, new goals.GoalNear(s.x, s.y, s.z, 2), { timeoutMs: 20000, label: 'to bed spot', allowZones: ['base'] })
    if (!r.ok) continue
    if (await act.place(bot, s, item.name, { faceHint: [[0, -1, 0]], allowZones: ['base'], sneak: false })) {
      mem.set('bed', { x: s.x, y: s.y, z: s.z })
      log('shelter', `placed my bed at ${move.fmt(s)}`)
      return true
    }
    // a bed occupies two cells: the placed block may be the foot or head; search around
    const found = world.findBlocks(bot, BED_RE, { maxDistance: 3, count: 1, point: new Vec3(s.x, s.y, s.z) })[0]
    if (found) { mem.set('bed', { x: found.position.x, y: found.position.y, z: found.position.z }); log('shelter', `placed my bed at ${move.fmt(found.position)}`); return true }
  }
  return false
}

// The bed in its layout spot: stand on `stand`, click the floor under `foot` - the bed's head goes
// the way the player faces, so it lies foot->head along the back wall.
async function placeBedAt (bot, { foot, head, stand }) {
  const item = inv.items(bot).find(i => BED_RE.test(i.name))
  if (!item) return false
  const r = await move.goTo(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 20000, dig: false, place: false, label: 'to bed stand', allowZones: ['base'] })
  if (!r.ok) { log('shelter', `couldn't stand at ${move.fmt(stand)} to lay the bed`); return false }
  bot.clearControlStates()
  await bot.lookAt(new Vec3(foot.x + 0.5, foot.y, foot.z + 0.5), true).catch(() => {})
  await act.place(bot, foot, item.name, { faceHint: [[0, -1, 0]], allowZones: ['base'], sneak: false })
  await move.sleep(300)
  const f = world.at(bot, foot.x, foot.y, foot.z); const h = world.at(bot, head.x, head.y, head.z)
  if (f && BED_RE.test(f.name) && h && BED_RE.test(h.name)) {
    mem.set('bed', { x: foot.x, y: foot.y, z: foot.z })
    log('shelter', `laid the bed along the back wall at ${move.fmt(foot)}`)
    return true
  }
  // landed the wrong way round: pick it up again rather than leave it across the room
  const stray = world.findBlocks(bot, BED_RE, { maxDistance: 3, count: 1, point: new Vec3(foot.x, foot.y, foot.z) })[0]
  if (stray) { await act.dig(bot, stray.position, { force: true, allowZones: ['base'] }); await act.collectDrops(bot, { radius: 4, maxMs: 3000 }) }
  log('shelter', 'the bed did not lie along the back wall - picked it up')
  return false
}

async function sleepInBed (bot, { shouldStop } = {}) {
  let bed = bedBlock(bot)
  if (!bed) return false
  // a bed in the safehouse is reached through its door (from outside the back wall it is "2 blocks away"
  // and unreachable - the walk stuck for a minute every dusk)
  if (move.insideHut(bed.position) && !move.insideHut(world.feetPos(bot))) {
    if (!await require('./hut').enterHut(bot, { shouldStop })) return false
  }
  const r = await move.goTo(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), { timeoutMs: 90000, label: 'to bed', allowZones: ['base', 'build'] })
  if (!r.ok) return false
  bed = bedBlock(bot)
  if (!bed) return false
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    if (shouldStop && shouldStop()) return false
    if (!world.canSleepNow(bot)) { await move.sleep(2000); if (world.isDay(bot)) return true; continue }
    await reflex.waitClear()
    try {
      await bot.sleep(bed)
      log('shelter', 'in bed')
      mem.update(m => { m.spawnSetAt = m.bed })
      break
    } catch (e) {
      log('shelter', `can't sleep yet: ${e.message}`)
      await move.sleep(3000)
    }
  }
  // stay in bed until morning (the server may not skip the night if others are awake)
  while (bot.isSleeping && !world.isDay(bot)) await move.sleep(2000)
  await move.sleep(500)
  return true
}

// Dig a 1x1 pit 2 deep where we stand (dry ground) and put a block over our head. Wait for day.
function enclosedHere (bot) {
  const me = world.feetPos(bot)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
    const b = world.at(bot, me.x + dx, me.y + dy, me.z + dz)
    if (!b || !world.isSolid(b)) return false
  }
  return true
}

// Shelter lasts until MORNING - dusk is not day (a bunker entered at dusk used to end at once)
// Time to come out: day, and either the sun is well up or nothing hostile is about. Dawn (the first
// ~40s of 'day') still has skeletons and zombies that don't burn yet - one shot the bot dead as it
// climbed out unarmed.
function morning (bot) {
  if (world.phase(bot) !== 'day') return false
  const t = world.tod(bot)
  const early = t >= 23000 || t < 1000
  if (!early) return true
  return require('./reflex').hostiles(20).length === 0
}
async function waitForDay (bot, shouldStop) {
  while (!morning(bot) && !(shouldStop && shouldStop())) {
    await move.sleep(3000)
    if (bot.health <= 0) return false
  }
  return true
}

// Surface shelter: blocks on all four sides at feet and head level, and one overhead.
async function encloseHere (bot, { shouldStop } = {}) {
  const me = world.feetPos(bot)
  const cells = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) cells.push({ x: me.x + dx, y: me.y + dy, z: me.z + dz })
  cells.push({ x: me.x, y: me.y + 2, z: me.z })
  let placed = 0
  for (const c of cells) {
    const b = world.at(bot, c.x, c.y, c.z)
    if (b && world.isSolid(b)) { placed++; continue }
    const f = inv.shelterBlock(bot, { wood: true })
    if (!f) break
    if (await act.place(bot, c, f.name, { allowZones: ['base', 'build'] })) placed++
  }
  if (placed < cells.length) { log('shelter', `could only wall in ${placed}/${cells.length} sides`); return false }
  log('shelter', `walled in for the night at ${move.fmt(me)}`)
  mem.update(m => { m.bunker = { x: me.x, y: me.y, z: me.z, walls: cells } })
  const ok = await waitForDay(bot, shouldStop)
  // morning: take the walls down again (they are ours and would otherwise litter the landscape)
  for (const c of cells) {
    const b = world.at(bot, c.x, c.y, c.z)
    if (b && /^(dirt|cobblestone|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|sand|gravel|.*_planks|.*_log)$/.test(b.name)) await act.dig(bot, c, { force: true, allowZones: ['base', 'build'], timeoutMs: 8000 })
  }
  await act.collectDrops(bot, { radius: 4, maxMs: 4000 })
  return ok
}

async function bunker (bot, { shouldStop } = {}) {
  const me = world.feetPos(bot)
  // already in a hole with walls (last night's bunker, a tunnel): cap it and wait - never dig deeper
  if (enclosedHere(bot)) {
    const cap = { x: me.x, y: me.y + 2, z: me.z }
    const c = world.at(bot, cap.x, cap.y, cap.z)
    const filler = inv.shelterBlock(bot)
    if (c && !world.isSolid(c) && filler) {
      const ok = await act.place(bot, cap, filler.name, { faceHint: [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] })
      // a cap cell with nothing beside it (a shallow pit in open ground): go one deeper and plug the
      // old head cell, which has walls
      const below = world.at(bot, me.x, me.y - 1, me.z); const below2 = world.at(bot, me.x, me.y - 2, me.z)
      if (!ok && below && below2 && world.isSolid(below) && world.isSolid(below2) && world.NATURAL_RE.test(below.name) && !world.lavaNear(bot, { x: me.x, y: me.y - 1, z: me.z }, 1) && !world.waterNear(bot, { x: me.x, y: me.y - 1, z: me.z }, 1, -1, 1)) {
        if (await act.dig(bot, { x: me.x, y: me.y - 1, z: me.z }, { timeoutMs: 10000 })) {
          await move.sleep(600)
          const f2 = inv.shelterBlock(bot)
          if (f2) await act.place(bot, { x: me.x, y: me.y + 1, z: me.z }, f2.name, { faceHint: [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] })
        }
      }
    }
    log('shelter', `sheltering in the enclosed spot at ${move.fmt(me)}`)
    return waitForDay(bot, shouldStop)
  }
  let spot = null
  for (let r = 0; r <= 6 && !spot; r++) {
    for (let dx = -r; dx <= r && !spot; dx++) for (let dz = -r; dz <= r && !spot; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
      const x = me.x + dx; const z = me.z + dz
      const gy = world.groundY(bot, x, z, me.y + 3)
      if (gy == null) continue
      const y = gy + 1
      if (!world.standable(bot, x, y, z)) continue
      if (world.waterNear(bot, { x, y: y - 2, z }, 2, -2, 2) || world.lavaNear(bot, { x, y: y - 2, z }, 2)) continue
      // three deep: the cap then goes in the ground layer, with ground on every side to place against
      // (a two-deep pit's cap sits in open air at surface level and can't be placed)
      const b1 = world.at(bot, x, y - 1, z); const b2 = world.at(bot, x, y - 2, z); const b3 = world.at(bot, x, y - 3, z); const b4 = world.at(bot, x, y - 4, z)
      if (!b1 || !b2 || !b3 || !b4 || !world.isSolid(b1) || !world.isSolid(b2) || !world.isSolid(b3) || !world.isSolid(b4)) continue
      if (!world.NATURAL_RE.test(b1.name) || !world.NATURAL_RE.test(b2.name) || !world.NATURAL_RE.test(b3.name) || /gravel|sand/.test(b1.name)) continue
      if (move.inZone({ x, y, z }, 1)) continue
      spot = { x, y, z }
    }
  }
  if (!spot) {
    log('shelter', 'no dry diggable ground for a bunker here - walling in on the surface instead')
    return encloseHere(bot, { shouldStop })
  }
  const r = await move.goTo(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), { timeoutMs: 20000, label: 'to bunker spot' })
  if (!r.ok) return false
  log('shelter', `digging in for the night at ${move.fmt(spot)}`)
  for (const dy of [1, 2, 3]) {
    const p = { x: spot.x, y: spot.y - dy, z: spot.z }
    bot.clearControlStates()
    if (!await act.dig(bot, p, { timeoutMs: 15000 })) return false
    await move.sleep(400)
  }
  // standing off-centre, the hitbox rests on the edge of the next block and never drops in: step to
  // the middle of the cell so we fall into the pit
  for (let i = 0; i < 3 && Math.floor(bot.entity.position.y) > spot.y - 3; i++) {
    const tx = spot.x + 0.5; const tz = spot.z + 0.5
    const p = bot.entity.position
    await bot.lookAt(new Vec3(tx, p.y, tz), true).catch(() => {})
    bot.setControlState('forward', true)
    const t0 = Date.now()
    while (Date.now() - t0 < 600 && Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz) > 0.15) await move.sleep(25)
    bot.setControlState('forward', false)
    await move.sleep(500)
  }
  if (Math.floor(bot.entity.position.y) > spot.y - 3) log('shelter', `didn't drop into the pit (at y${Math.floor(bot.entity.position.y)})`)
  // in the pit; walls are the natural sides. Cap the top.
  const filler = inv.shelterBlock(bot)
  const pit = world.feetPos(bot)
  const cap = { x: pit.x, y: pit.y + 2, z: pit.z }
  if (filler) {
    let capped = false
    for (let i = 0; i < 3 && !capped; i++) capped = await act.place(bot, cap, filler.name, { faceHint: [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] })
    if (!capped) log('shelter', 'could not cap the bunker - waiting it out anyway')
  }
  // seal any side opening at feet/head level
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
    const c = world.at(bot, pit.x + dx, pit.y + dy, pit.z + dz)
    const f = inv.shelterBlock(bot)
    if (c && !world.isSolid(c) && f) await act.place(bot, { x: pit.x + dx, y: pit.y + dy, z: pit.z + dz }, f.name).catch(() => {})
  }
  mem.update(m => { m.bunker = { x: pit.x, y: pit.y, z: pit.z } })
  while (!morning(bot) && !(shouldStop && shouldStop())) {
    await move.sleep(3000)
    if (bot.health <= 0) return false
  }
  log('shelter', 'morning - leaving the bunker')
  // climb out: dig the cap and step out, then fill the pit behind us - a player doesn't leave a
  // two-deep hole in the ground for the next person (or itself) to fall into
  await act.dig(bot, cap, { timeoutMs: 8000, force: true })
  const out = await move.goTo(bot, new goals.GoalNear(pit.x, pit.y + 3, pit.z, 2), { timeoutMs: 20000, label: 'out of the bunker' })
  if (out.ok && Math.floor(bot.entity.position.y) >= pit.y + 3) {
    for (const dy of [0, 1, 2]) {
      const p = { x: pit.x, y: pit.y + dy, z: pit.z }
      const f = inv.shelterBlock(bot)
      const c = world.at(bot, p.x, p.y, p.z)
      if (f && c && world.isAirish(c)) await act.place(bot, p, f.name).catch(() => {})
    }
  }
  return true
}

module.exports = { bedBlock, hasBedItem, obtainBed, placeBed, placeBedAt, sleepInBed, bunker, morning, waitForDay }
