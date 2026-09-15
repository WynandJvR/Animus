'use strict'
// Primitive world actions with the world re-read after each one: dig, place, pick up drops.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const reflex = require('./reflex')
const { log } = require('./log')
const control = require('./control')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function reach (bot, pos, r = 4.3) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  return eye.distanceTo(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)) <= r
}

// Dig one block (walking into reach if needed). Refuses crafted blocks unless `force`.
// Returns true when the cell is verifiably no longer that block.
async function dig (bot, pos, { force = false, allowZones = [], timeoutMs = 30000, noWalk = false } = {}) {
  let b = world.at(bot, pos.x, pos.y, pos.z)
  // "done" means the cell holds nothing breakable. Grass/flowers have no collision box but they ARE
  // blocks: treating them as air made a seed-gathering loop spin on resolved promises and starve the
  // event loop for minutes (keep-alive timeout, 2026-09-14).
  const nothing = x => !x || /^(air|cave_air|void_air)$/.test(x.name) || world.isWaterBlock(x) || world.isLavaBlock(x)
  if (nothing(b)) return true
  if (!force && !world.NATURAL_RE.test(b.name)) { log('act', `refused to dig crafted ${b.name} at ${move.fmt(pos)}`); return false }
  const z = move.inZone(b.position)
  if (z && !allowZones.includes(z.label) && !force) { log('act', `refused to dig ${b.name} inside ${z.label}`); return false }
  if (b.hardness == null || b.hardness < 0) return false // bedrock etc
  // never open a block that holds back lava/water onto us
  // (below too, and one further down: a dug block over lava is a hole we drop into - the bot dug dirt for
  //  scaffold over a lava pocket at the castle and burned to death with its new iron gear)
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, -2, 0]]) {
    const nb = world.at(bot, pos.x + dx, pos.y + dy, pos.z + dz)
    if (nb && world.isLavaBlock(nb)) { log('act', `won't dig ${b.name} at ${move.fmt(pos)} - lava beside or under it`); return false }
  }
  const t0 = Date.now()
  const cancelled = control.token()
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (cancelled()) return false
    await reflex.waitClear()
    b = world.at(bot, pos.x, pos.y, pos.z)
    if (nothing(b)) return true
    const tm = Date.now()
    if (!reach(bot, pos) && noWalk) return false
    if (!reach(bot, pos)) {
      // a block without a full hitbox (grass, flowers, crops) never satisfies the look-at raycast
      // goal - the walk ran its whole 20s timeout for every tuft of grass
      const goal = b.boundingBox === 'block' ? new goals.GoalLookAtBlock(b.position, bot.world, { reach: 4 }) : new goals.GoalNear(pos.x, pos.y, pos.z, 2)
      const r = await move.goTo(bot, goal, { timeoutMs: 20000, allowZones, label: 'reach ' + b.name })
      if (!r.ok && !reach(bot, pos, 5)) return false
    }
    const td = Date.now()
    await inv.equipFor(bot, b)
    try {
      await bot.dig(b, true)
    } catch (e) {
      if (reflex.active()) continue
      await sleep(200)
    }
    const after = world.at(bot, pos.x, pos.y, pos.z)
    if (Date.now() - tm > 6000) log('act', `slow dig ${b.name} at ${move.fmt(pos)}: walk ${td - tm}ms, dig ${Date.now() - td}ms (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'})`)
    if (!after || after.name !== b.name) return true
  }
  return false
}

// Place `itemName` into the empty cell `pos` against any solid neighbour. Verified by re-read.
async function place (bot, pos, itemName, { faceHint = null, allowZones = [], timeoutMs = 20000, sneak = true } = {}) {
  const target = new Vec3(pos.x, pos.y, pos.z)
  const cur = bot.blockAt(target)
  if (cur && cur.name === itemName) return true
  if (cur && !world.isAirish(cur) && !world.isWaterBlock(cur) && !/^(short_grass|tall_grass|fern|large_fern|snow|dead_bush|leaf_litter|vine|seagrass|short_dry_grass|tall_dry_grass|bush|firefly_bush|wildflowers|pink_petals|dandelion|poppy|.*_tulip|cornflower|azure_bluet|oxeye_daisy)$/.test(cur.name)) return false
  const item = inv.items(bot).find(i => i.name === itemName)
  if (!item) return false
  const faces = faceHint || [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  const t0 = Date.now()
  const cancelled = control.token()
  let lastErr = null; let tries = 0
  while (Date.now() - t0 < timeoutMs && tries < 4) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (cancelled()) return false
    await reflex.waitClear()
    { const now = bot.blockAt(target); if (now && now.name === itemName) return true }
    let ref = null; let face = null
    for (const [dx, dy, dz] of faces) {
      const nb = bot.blockAt(target.offset(dx, dy, dz))
      if (nb && world.isSolid(nb) && !/chest|furnace|crafting_table|_bed|_door|barrel|shulker/.test(nb.name)) { ref = nb; face = new Vec3(-dx, -dy, -dz); break }
    }
    if (!ref) { log('act', `place ${itemName} at ${move.fmt(pos)}: nothing solid to place against`); return false }
    // don't place into our own body
    const me = bot.entity.position
    if (Math.floor(me.x) === pos.x && Math.floor(me.z) === pos.z && (Math.floor(me.y) === pos.y || Math.floor(me.y + 1) === pos.y)) {
      await move.goTo(bot, new goals.GoalInvert(new goals.GoalBlock(pos.x, pos.y, pos.z)), { timeoutMs: 5000, dig: false, place: false })
    }
    if (!reach(bot, pos, 4.4)) {
      const r = await move.goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeoutMs: 20000, allowZones, label: 'reach to place' })
      if (!r.ok && !reach(bot, pos, 4.8)) return false
    }
    try {
      const held = inv.items(bot).find(i => i.name === itemName)
      if (!held) return false
      await bot.equip(held, 'hand')
      if (sneak) bot.setControlState('sneak', true)
      await bot.placeBlock(ref, face)
    } catch (e) {
      // placeBlock often times out waiting for the update even when it landed
      lastErr = e.message
    } finally { if (sneak) bot.setControlState('sneak', false) }
    for (let w = 0; w < 6; w++) {
      await sleep(150)
      const after = bot.blockAt(target)
      if (after && after.name === itemName) return true
    }
    tries++
  }
  log('act', `place ${itemName} at ${move.fmt(pos)} failed after ${tries} tries${lastErr ? ': ' + lastErr : ''}`)
  return false
}

function droppedItems (bot, radius) {
  const me = bot.entity.position
  return Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(me) <= radius)
}

// Walk over dropped items near here. Skips drops in water/lava or far below.
// drops we could not reach stay skipped for a while across calls (a log stuck in the leaves was walked
// at after every single log of a tree)
const unreachableDrops = new Map() // entity id -> time given up
async function collectDrops (bot, { radius = 8, maxMs = 15000 } = {}) {
  const t0 = Date.now()
  let picked = 0
  const tried = new Set()
  for (const [id, at] of unreachableDrops) if (Date.now() - at > 120000) unreachableDrops.delete(id)
  for (const id of unreachableDrops.keys()) tried.add(id)
  const cancelled = control.token()
  while (Date.now() - t0 < maxMs && !cancelled()) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    const me = bot.entity.position
    const drops = droppedItems(bot, radius).filter(e => !tried.has(e.id) && Math.abs(e.position.y - me.y) < 6)
    if (!drops.length) break
    drops.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    const d = drops[0]
    tried.add(d.id)
    const cell = world.at(bot, d.position.x, d.position.y, d.position.z)
    if (cell && (world.isLavaBlock(cell))) continue
    // a drop floating in deep water is not worth a drowning (it sank there in the old runtime twice)
    if (cell && world.isWaterBlock(cell) && world.isWaterBlock(world.at(bot, d.position.x, d.position.y - 1, d.position.z))) continue
    const before = inv.items(bot).reduce((s, i) => s + i.count, 0)
    await move.goTo(bot, new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5), { timeoutMs: 8000, stuckMs: 4000, label: 'pickup' })
    await sleep(250)
    if (inv.items(bot).reduce((s, i) => s + i.count, 0) > before) picked++
    else if (d.isValid) unreachableDrops.set(d.id, Date.now())
  }
  return picked
}

module.exports = { dig, place, collectDrops, droppedItems, reach, sleep }
