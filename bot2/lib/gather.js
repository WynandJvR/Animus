'use strict'
// Getting raw materials out of the world: chop trees, dig surface blocks, take exposed ores.
// Large stone/ore quantities go to the mine (mining.js). Only visible blocks are targeted -
// the bot does not x-ray ores through solid rock.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const mining = () => require('./mining')
const base = () => require('./base')

// Remember where resources were seen, so a later trip goes straight there.
function noteResource (kind, pos) {
  mem.update(m => {
    m.resources = m.resources || {}
    const list = m.resources[kind] || (m.resources[kind] = [])
    if (!list.some(p => world.dist2(p, pos) < 24)) { list.push({ x: pos.x, y: pos.y, z: pos.z, t: Date.now() }); if (list.length > 12) list.shift() }
  })
}
function forgetResource (kind, pos) {
  mem.update(m => { if (m.resources && m.resources[kind]) m.resources[kind] = m.resources[kind].filter(p => world.dist2(p, pos) >= 24) })
}
// maxFromHome: how far from home a remembered spot still counts (clay can lie 300 blocks out - trees do not)
function knownResource (kind, from, { maxFromHome = 200 } = {}) {
  const home = mem.get().home
  const list = ((mem.get().resources || {})[kind] || []).filter(p => !home || world.dist2(p, home) < maxFromHome)
  if (!list.length) return null
  const me = from || home || { x: 0, z: 0 }
  return list.slice().sort((a, b) => world.dist2(a, me) - world.dist2(b, me))[0]
}

// Not in a protected zone - and not in the ground under one either: stone under the basilica was picked, refused by
// the dig, and picked again every 20s for minutes (2026-09-23). A zone's columns are off limits to the depth.
function outOfZones (b) { return !move.inZone(b.position, 2) && !move.inZone({ x: b.position.x, y: b.position.y + 12, z: b.position.z }, 1) }

// ---- trees ------------------------------------------------------------------------------
function trunkBase (bot, b) {
  let p = b.position.clone()
  for (let i = 0; i < 20; i++) {
    const below = bot.blockAt(p.offset(0, -1, 0))
    if (!below || !world.LOG_RE.test(below.name)) break
    p = p.offset(0, -1, 0)
  }
  return p
}
function isNaturalTree (bot, basePos) {
  const soil = bot.blockAt(basePos.offset(0, -1, 0))
  if (!soil || !/^(dirt|grass_block|podzol|coarse_dirt|rooted_dirt|mud|moss_block|mycelium|snow_block)$/.test(soil.name)) return false
  // leaves somewhere above = a tree, not a log cabin
  for (let dy = 1; dy < 12; dy++) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const b = bot.blockAt(basePos.offset(dx, dy, dz)); if (b && world.LEAF_RE.test(b.name)) return true
    }
  }
  return false
}

async function chop (bot, re, n, ctx = {}) {
  const itemName = String(re).replace(/^\/\^|\$\/$/g, '')
  const target = inv.count(bot, itemName) + n
  let emptyScans = 0
  const t0 = Date.now()
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return false
    if (Date.now() - t0 > 20 * 60000) { log('gather', `chop ${itemName}: 20 min budget spent`); return false }
    await reflex.waitClear()
    if (inv.freeSlots(bot) <= 1) await base().makeRoom(bot, 3)
    const logs = world.findBlocks(bot, re, { maxDistance: 64, count: 40, filter: b => outOfZones(b) })
    let trunk = null
    for (const b of logs) {
      const bp = trunkBase(bot, b)
      if (Math.abs(bp.y - bot.entity.position.y) > 12) continue
      if (!isNaturalTree(bot, bp)) continue
      trunk = bp; break
    }
    if (!trunk) {
      if (++emptyScans > 4) { log('gather', `chop ${itemName}: no trees found after exploring`); return false }
      const known = knownResource(itemName, bot.entity.position)
      if (known && world.dist2(known, bot.entity.position) > 40 && emptyScans === 1) {
        log('gather', `no ${itemName} here - heading to where i saw some at ${move.fmt(known)}`)
        const r = await move.travel(bot, known, { range: 8, shouldStop: ctx.shouldStop, label: 'to trees' })
        if (!r.ok) forgetResource(itemName, known)
      } else {
        await explore(bot, b => re.test(b.name), { shouldStop: ctx.shouldStop, label: itemName, accept: b => outOfZones(b) && isNaturalTree(bot, trunkBase(bot, b)) })
      }
      continue
    }
    emptyScans = 0
    noteResource(itemName, trunk)
    const got = await fellTree(bot, trunk, re)
    if (!got) await move.sleep(300)
  }
  return true
}

async function fellTree (bot, basePos, re) {
  const before = inv.count(bot, b => re.test(b))
  // stand next to the trunk
  const r = await move.goTo(bot, new goals.GoalNear(basePos.x, basePos.y, basePos.z, 2), { timeoutMs: 40000, label: 'to tree' })
  if (!r.ok) return false
  // the column, bottom up; then neighbouring trunks (2x2 trees)
  const column = []
  for (let dy = 0; dy < 24; dy++) {
    const b = bot.blockAt(basePos.offset(0, dy, 0))
    if (!b || !re.test(b.name)) { if (dy > 0) break; else continue }
    column.push(b.position)
  }
  for (const p of column) {
    if (p.y - bot.entity.position.y > 4.5) {
      // step into the stump column to reach higher logs
      const below = bot.blockAt(new Vec3(basePos.x, basePos.y, basePos.z))
      if (below && world.isAirish(below) && Math.floor(bot.entity.position.x) !== basePos.x) {
        await move.goTo(bot, new goals.GoalBlock(basePos.x, basePos.y, basePos.z), { timeoutMs: 8000, place: false, label: 'into stump' })
      }
      if (p.y - bot.entity.position.y > 5.2) {
        // tower one block under ourselves to reach
        if (!await towerUp(bot)) break
      }
    }
    await act.dig(bot, p, { timeoutMs: 15000 })
  }
  // come back down if we climbed
  await act.collectDrops(bot, { radius: 7, maxMs: 10000 })
  // replant
  const sap = inv.items(bot).find(i => i.name.endsWith('_sapling') && basePos && i.name.startsWith(String(re).replace(/^\/\^|_log\$\/$/g, '')))
  if (sap) {
    const soil = bot.blockAt(basePos.offset(0, -1, 0)); const cell = bot.blockAt(basePos)
    if (soil && /^(dirt|grass_block|podzol|coarse_dirt|rooted_dirt)$/.test(soil.name) && cell && world.isAirish(cell)) await act.place(bot, basePos, sap.name, { faceHint: [[0, -1, 0]] })
  }
  const got = inv.count(bot, b => re.test(b)) - before
  if (got > 0) log('gather', `felled a tree at ${move.fmt(basePos)}: +${got} logs`)
  return got > 0
}

// Jump and place a filler block under our feet.
async function towerUp (bot) {
  const filler = inv.items(bot).find(i => /^(dirt|cobblestone|andesite|diorite|tuff|cobbled_deepslate|netherrack)$/.test(i.name))
  if (!filler) return false
  const y0 = Math.floor(bot.entity.position.y)
  const above = world.at(bot, bot.entity.position.x, y0 + 2, bot.entity.position.z)
  if (!above || !world.isAirish(above)) return false
  try {
    await bot.equip(filler, 'hand')
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    bot.setControlState('jump', true)
    const t0 = Date.now()
    while (bot.entity.position.y < y0 + 1.05 && Date.now() - t0 < 800) await move.sleep(30)
    bot.setControlState('jump', false)
    const below = bot.blockAt(new Vec3(Math.floor(bot.entity.position.x), y0 - 1, Math.floor(bot.entity.position.z)))
    if (below) await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(() => {})
    await move.sleep(300)
    return Math.floor(bot.entity.position.y) >= y0 + 1
  } catch { bot.setControlState('jump', false); return false }
}

// ---- surface blocks and exposed ores ------------------------------------------------------
async function mine (bot, itemName, g, n, ctx = {}) {
  const target = inv.count(bot, itemName) + n
  // big stone/ore orders go underground
  if ((itemName === 'cobblestone' && n > 24) || g.ore) {
    const r = await mining().mineFor(bot, itemName, target, ctx)
    if (r || !g.ore) return inv.count(bot, itemName) >= target || r
  }
  let emptyScans = 0
  const t0 = Date.now()
  const refused = new Set() // blocks that would not dig this call: never the same one twice
  // THE rule for a block worth going to - the scan here, the far look and the explore's "found some" test all use it.
  // With the explore on a looser rule (any sand in sight: the waterline, buried) every leg ended at once on sand this
  // scan refuses, and "no reachable sand around" left the glass panes - and the house - waiting (2026-09-23).
  const takeable = b => outOfZones(b) && world.hasAirNeighbour(bot, b.position) &&
        (!/^(dirt|grass_block|sand|gravel)$/.test(b.name) || (world.isAirish(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) && !world.lavaNear(bot, b.position, 2))) &&
        // (sand, gravel and clay live beside water: for them the rule is dry standing ground, not dry neighbours)
        // (no block with water beside or over it - sand included: a sand pit dug under the water line at the river filled
        //  with falling water and the bot drowned in it, 2026-09-23; clay has its own skill)
        // (refined: water beside it at its own level is only the shore - taking the beach's top layer leaves a puddle;
        //  water over it or beside it a level up is what pours into the hole. The strict rule left no sand on any beach)
        !world.waterNear(bot, b.position, 1, 1, 1) && !world.isWaterBlock(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) &&
        (!world.waterNear(bot, b.position, 1, 0, 0) || /^(sand|gravel|red_sand)$/.test(b.name)) && !world.lavaNear(bot, b.position, 1) && standableNear(bot, b.position)
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return false
    if (Date.now() - t0 > 15 * 60000) return false
    await reflex.waitClear()
    if (inv.freeSlots(bot) <= 1) await base().makeRoom(bot, 3)
    const me = bot.entity.position
    const cands = world.findBlocks(bot, g.blocks, {
      maxDistance: 40,
      // loose ground is mostly buried: the nearest 30 dirt blocks were all underground and the surface never
      // came up - look at more of them
      count: /^(dirt|sand|gravel|clay_ball)$/.test(itemName) ? 160 : 30,
      // (surface blocks at or above our feet: digging down into pits found a lava pocket under the castle)
      // (loose ground blocks only with their top open to the sky-side air - the surface, not the bottom of a pit -
      //  and no lava within 2: a pit dug toward a lava pocket killed the bot. Judged by the block, never by our
      //  own height: standing on the castle wall the old rule rejected every dirt block on the ground)
      filter: b => takeable(b) && Math.abs(b.position.y - me.y) < 20
    })
    if (!cands.length) {
      log('gather', `no exposed ${itemName} within reach of standable ground nearby`)
      if (itemName === 'cobblestone' || g.ore) return mining().mineFor(bot, itemName, target, ctx)
      // some further out (explore stops as soon as any is in sight, the scan above only looks 40 blocks):
      // walk over to the nearest and look again from there
      const far = world.findBlocks(bot, g.blocks, { maxDistance: 128, count: 12, filter: b => takeable(b) })
        .sort((a, b) => world.dist3(a.position, me) - world.dist3(b.position, me))[0]
      if (far && world.dist3(far.position, me) > 30 && emptyScans < 3) {
        emptyScans++
        log('gather', `${itemName} at ${move.fmt(far.position)} - going there`)
        await move.travel(bot, far.position, { range: 6, shouldStop: ctx.shouldStop, label: 'to ' + itemName })
        continue
      }
      if (++emptyScans > 4) { log('gather', `no reachable ${itemName} around`); return false }
      // sand and gravel lie where water meets land (beaches, river banks): a player walks to the shore to look, not in
      // rings - 150 blocks of forest round the Nordic site had none, the rings never reached the coast (2026-09-23)
      if (/^(sand|gravel)$/.test(itemName) && await toShore(bot, itemName, ctx)) continue
      await explore(bot, b => g.blocks.test(b.name), { shouldStop: ctx.shouldStop, label: itemName, accept: b => takeable(b) })
      continue
    }
    emptyScans = 0
    const b = cands.find(c => !refused.has(`${c.position.x},${c.position.y},${c.position.z}`))
    if (!b) { log('gather', `every ${itemName} in reach refused to dig`); return false }
    noteResource(itemName, b.position)
    if (!inv.canHarvest(bot, b)) { log('gather', `can't harvest ${b.name} with my tools`); return false }
    const ok = await act.dig(bot, b.position, { timeoutMs: 20000 })
    if (ok) await act.collectDrops(bot, { radius: 5, maxMs: 5000 })
    else { refused.add(`${b.position.x},${b.position.y},${b.position.z}`); log('gather', `couldn't dig ${b.name} at ${move.fmt(b.position)}`) }
  }
  return true
}

// Flowers and the like: walk up, break, pick up. `itemName` is what the plant drops (counted in the pack; a
// RegExp when any of several will do - poppy, red tulip or rose bush for red dye).
async function pickPlants (bot, re, itemName, n, ctx = {}) {
  const label = typeof itemName === 'string' ? itemName : 'red flowers'
  const target = inv.count(bot, itemName) + n
  let empty = 0
  const skip = new Set()
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return false
    await reflex.waitClear()
    const b = world.findBlocks(bot, re, { maxDistance: 48, count: 24, filter: x => outOfZones(x) && !skip.has(x.position.toString()) && !world.isWaterBlock(x) })[0]
    if (!b) {
      if (++empty > 3) { log('gather', `no ${label} to pick around here`); return false }
      const known = knownResource(label, bot.entity.position)
      if (known && empty === 1 && world.dist2(known, bot.entity.position) > 40) await move.travel(bot, known, { range: 8, shouldStop: ctx.shouldStop, label: 'to ' + label })
      else await explore(bot, x => re.test(x.name), { shouldStop: ctx.shouldStop, label, legs: 2, accept: outOfZones })
      continue
    }
    empty = 0
    noteResource(label, b.position)
    const before = inv.count(bot, itemName)
    if (await act.dig(bot, b.position, { timeoutMs: 15000 })) await act.collectDrops(bot, { radius: 4, maxMs: 4000 })
    if (inv.count(bot, itemName) <= before) skip.add(b.position.toString())
  }
  return true
}

// Walk to surface water not looked at yet for `kind` (open sky over it, near the home's height): the shore is where
// sand and gravel show. Remembered per kind so each trip looks somewhere new. False when there is no such water.
async function toShore (bot, kind, ctx = {}) {
  const home = mem.get().home || bot.entity.position
  const key = 'shoreScouted_' + kind
  const seen = mem.get()[key] || []
  let next = 0
  const water = world.findBlocks(bot, /^water$/, { maxDistance: 128, count: 40, filter: b => {
    if (b.position.y < home.y - 30 || (++next & 3)) return false // cheap first: height, and every 4th hit only
    return world.isAirish(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) && world.openSky(bot, b.position) && outOfZones(b) && !seen.some(q => world.dist2(q, b.position) < 40)
  } }).filter(b => world.dist2(b.position, bot.entity.position) > 24)
  // nothing new in view (a coast 160 blocks off is out of the loaded chunks from home): go back to the shore looked at
  // longest ago - what it holds may be takeable now (the dig rule changed, a day's growth, other light)
  let w = water.length ? water[0].position : null
  if (!w && seen.length) { w = seen[0]; mem.update(m => { m[key] = (m[key] || []).slice(1) }) }
  if (!w) return false
  mem.update(m => { m[key] = (m[key] || []).concat([{ x: w.x, y: w.y, z: w.z }]).slice(-30) })
  log('gather', `no ${kind} in sight - heading to the water's edge at ${move.fmt(w)} to look`)
  await move.travel(bot, w, { range: 6, shouldStop: ctx.shouldStop, label: 'to the shore', maxMs: 3 * 60000 })
  return true
}

function standableNear (bot, p) {
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 1; dy++) {
    if (world.standable(bot, p.x + dx, p.y + dy, p.z + dz)) return true
  }
  return false
}

// Walk outward in a widening square from home (or here) until a matching block shows up.
async function explore (bot, match, { shouldStop, label = 'resources', legs = 4, accept = null, rings = null } = {}) {
  const home = mem.get().home || bot.entity.position
  mem.update(m => { m.exploreStep = (m.exploreStep || 0) + 1 })
  const step = mem.get().exploreStep
  // stay within ~150b of home (far trips cost more than they find) - animals in a hunted-out area are
  // the exception: they never respawn, so the search has to go wider; so is clay (rings: 9, out to ~300b)
  const radius = 48 + 32 * (step % (rings || (label === 'animals' ? 7 : 4)))
  const ang = step * 2.4
  const dest = { x: Math.round(home.x + Math.cos(ang) * radius), y: Math.round(bot.entity.position.y), z: Math.round(home.z + Math.sin(ang) * radius) }
  log('gather', `exploring for ${label} toward ${move.fmt(dest)} (radius ${radius})`)
  const t0 = Date.now()
  // (the scan at most every 2s: the walk polls stop() constantly, and a findBlocks a poll starved the event loop)
  let scannedAt = 0; let seen = null
  const sighted = () => { if (Date.now() - scannedAt > 2000) { scannedAt = Date.now(); seen = findMatching(bot, match, accept) } return seen }
  const stop = () => (shouldStop && shouldStop()) || Date.now() - t0 > 3 * 60000 || !!sighted()
  for (let i = 0; i < legs; i++) {
    const found = findMatching(bot, match, accept)
    if (found) return found
    const r = await move.travel(bot, dest, { range: 10, shouldStop: stop, label: 'explore', maxMs: 90000 })
    if (r.ok || r.why === 'stopped') break
  }
  return findMatching(bot, match, accept)
}
function findMatching (bot, match, accept) {
  const ids = Object.values(world.data(bot).blocksByName).filter(b => match({ name: b.name })).map(b => b.id)
  if (!ids.length) return null
  if (!accept) return bot.findBlock({ matching: ids, maxDistance: 64 }) || null
  // only what the caller would actually take (the castle's own oak logs "found" a tree and ended every search)
  const ps = bot.findBlocks({ matching: ids, maxDistance: 64, count: 24 })
  for (const p of ps) { const b = bot.blockAt(p); if (b && accept(b)) return b }
  return null
}

module.exports = { chop, mine, explore, towerUp, noteResource, forgetResource, knownResource, fellTree, pickPlants }
