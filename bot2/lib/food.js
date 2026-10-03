'use strict'
// Food: hunt animals (never the last two of a kind in sight), cook, keep a buffer in the pack.
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const craft = () => require('./craft')
const smelt = () => require('./smelt')
const base = () => require('./base')
const gather = () => require('./gather')
const pen = () => require('./pen')

const FOOD_ANIMALS = /^(cow|mooshroom|pig|sheep|chicken|rabbit)$/

// The animals out in the open: never a penned one - the sheep pen's flock is not game, nor a flock to walk to (a hunt for
// mutton or a wool kill would empty the pen the wool grows in; pen.js, 2026-09-29)
function animals (bot, re, maxDist = 48) {
  const me = bot.entity.position
  return Object.values(bot.entities).filter(e => e && e.name && re.test(e.name) && e.position && e.position.distanceTo(me) <= maxDist && !isBaby(bot, e) && !pen().inPen(e.position) && !move.inForeign(e.position) && !(Date.now() - (unreachable.get(e.id) || 0) < 3 * 60000))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}
// A baby: the ageable "baby" flag, read by name from the registry's metadata keys as the wool byte is (the index moves
// between versions). The old guess - any true flag and a body under 0.8 high - never held for a sheep (1.3 high in the
// registry, lamb or ewe); it stays the fallback where the registry has no key.
function isBaby (bot, e) {
  try {
    const keys = (world.data(bot).entitiesByName[e.name] || {}).metadataKeys || []
    const i = keys.indexOf('baby')
    if (i >= 0 && e.metadata && typeof e.metadata[i] === 'boolean') return e.metadata[i]
    const md = e.metadata || []; return md.some(v => v === true) && (e.height || 1) < 0.8
  } catch { return false }
}

// Sustainability: when only one or two of a kind are around, leave one to breed - unless food is
// critical. Wool and string are not about food, and sheep regrow nothing when dead anyway.
function huntable (bot, list, itemName) {
  const byKind = {}
  for (const e of list) byKind[e.name] = (byKind[e.name] || 0) + 1
  const critical = bot.food <= 8 && inv.foodPoints(bot) < 8
  const taken = {}
  return list.filter(e => {
    if (critical || /wool$/.test(itemName) || itemName === 'string') return true
    const n = byKind[e.name]
    const allowed = n >= 3 ? n - 2 : n - 1
    taken[e.name] = (taken[e.name] || 0) + 1
    return taken[e.name] <= allowed
  })
}

// Where animals were seen, by kind - noted as they come into view whatever the bot is doing (install), not only on a hunt:
// noted only while hunting, the 2300-block walk to the spawn hub passed every flock on the way and the bed's wool search
// had nothing to go on but three old spots, 2026-10-03. Written only when it says something new (a new spot, or one
// last confirmed 10+ minutes ago): the hunt loop noted every animal in sight on every pass, a memory save each time.
const SIGHT_REFRESH = 10 * 60000
function noteMob (e) {
  if (!e || !e.position || !e.name) return
  const p = e.position.floored()
  if (pen().inPen(p) || move.inForeign(p)) return // (a penned flock is not game; another's farm is not ours to hunt)
  const l = ((mem.get().mobs || {})[e.name]) || []
  const near = l.find(q => world.dist2(q, p) < 32)
  if (near && Date.now() - (near.t || 0) < SIGHT_REFRESH) return
  mem.update(m => {
    m.mobs = m.mobs || {}
    const k = m.mobs[e.name] || (m.mobs[e.name] = [])
    const q = k.find(q => world.dist2(q, p) < 32)
    if (q) Object.assign(q, { x: p.x, y: p.y, z: p.z, t: Date.now() })
    else {
      k.push({ x: p.x, y: p.y, z: p.z, t: Date.now() }); k.sort((a, b) => (a.t || 0) - (b.t || 0))
      // (full: the spot farthest from home goes - a long trip's sightings are no use to a search held round home, and the
      //  newest-16 rule let them push out the near ones; homeless, the oldest; audit 2026-10-03)
      if (k.length > 16) { const h = m.home; const i = h ? k.reduce((bi, q, j) => world.dist2(q, h) > world.dist2(k[bi], h) ? j : bi, 0) : 0; k.splice(i, 1) }
    }
  })
}
function install (bot) {
  bot.on('entitySpawn', e => { try { if (e && e.name && FOOD_ANIMALS.test(e.name) && !isBaby(bot, e)) noteMob(e) } catch {} })
}
// The tracked range: animals the client is shown at all - out to here they count as found (a search stopped only for one
// within 48 and walked past flocks in plain view)
const VIEW = 128
// a flock remembered at `spot`, walked to and not there: forgotten (kinds matching re)
function forgetAt (re, spot) {
  mem.update(m => { for (const k of Object.keys(m.mobs || {})) if (re.test(k)) m.mobs[k] = m.mobs[k].filter(q => world.dist2(q, spot) >= 32) })
}

// Animals we could not get to (another bank, behind a wall): skipped by animals() for a while. The chase drove the
// pathfinder itself, and from inside the safehouse the planner never routes through the door - 2026-09-22 the bot
// stood in the hut a whole morning "chasing" the same sheep, 30s at a time, with nothing logged.
const unreachable = new Map() // entity id -> when
async function killAnimal (bot, e, { maxMs = 30000 } = {}) {
  const t0 = Date.now()
  if (move.insideHut(bot.entity.position.floored())) await move.crossDoor(bot, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2)).catch(() => {})
  await inv.equipWeapon(bot)
  let lastHit = 0
  let best = Infinity; let bestAt = Date.now()
  while (e.isValid && Date.now() - t0 < maxMs) {
    if (reflex.active()) { await reflex.waitClear(); bestAt = Date.now(); continue }
    const d = e.position.distanceTo(bot.entity.position)
    // no closer in 10s: it can't be reached from here - leave it
    if (d < best - 0.5) { best = d; bestAt = Date.now() } else if (d > 3.3 && Date.now() - bestAt > 10000) { unreachable.set(e.id, Date.now()); log('food', `can't reach the ${e.name} ${Math.round(d)}b away - leaving it`); break }
    if (d > 3) {
      bot.pathfinder.setMovements(move.movementsFor(bot, { dig: false, place: false }))
      bot.pathfinder.setGoal(new goals.GoalFollow(e, 1.5), true)
    }
    if (d <= 3.3 && Date.now() - lastHit > 650) {
      await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.6, 0), true).catch(() => {})
      bot.attack(e); lastHit = Date.now()
    }
    await move.sleep(120)
  }
  try { bot.pathfinder.setGoal(null) } catch {}
  const dead = !e.isValid
  if (dead) await act.collectDrops(bot, { radius: 6, maxMs: 6000 })
  return dead
}

// Walk to an animal in view but past the hunt's reach; one we cannot get to is left alone a while (animals() skips it)
async function toInSight (bot, e, ctx) {
  log('food', `a ${e.name} in sight ${Math.round(e.position.distanceTo(bot.entity.position))}b off - going to it`)
  const at = e.position.clone()
  const r = await move.travel(bot, at, { range: 8, shouldStop: ctx.shouldStop, label: 'to the animals in sight', maxMs: 90000 })
  if (!r.ok && !(ctx.shouldStop && ctx.shouldStop()) && (!e.isValid || e.position.distanceTo(bot.entity.position) > 40)) unreachable.set(e.id, Date.now())
}

// Kill animals until `n` more of `itemName` are in the pack.
async function huntFor (bot, itemName, n, ctx = {}) {
  const re = craft().HUNT[itemName] || FOOD_ANIMALS
  const target = inv.count(bot, itemName) + n
  let empty = 0
  let wentTo = null // (the remembered herd walked to - forgotten if it is not there)
  const t0 = Date.now()
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return false
    if (Date.now() - t0 > 10 * 60000) return false
    await reflex.waitClear()
    const list = animals(bot, re)
    for (const e of list) noteMob(e)
    const pick = huntable(bot, list, itemName)[0]
    if (!pick) {
      // (forgotten only when none of the kind is there at all: a lone one spared by the last-two rule is still a herd)
      if (wentTo && world.dist2(wentTo, bot.entity.position) < 16 && !list.length) { forgetAt(re, wentTo); log('food', `no animals where they were seen at ${wentTo.x},${wentTo.z} - forgotten`) }
      wentTo = null
      if (++empty > 4) { log('food', `no ${re} to hunt nearby`); mem.set('lastHuntEmpty', Date.now()); return false }
      // a remembered herd is only worth the walk if it is near home (or near us when homeless)
      const anchor = mem.get().home || bot.entity.position
      const kinds = Object.keys(mem.get().mobs || {}).filter(k => re.test(k))
      const reach = bot.food <= 10 ? 260 : 160 // real hunger justifies a longer walk
      const known = kinds.flatMap(k => mem.get().mobs[k]).filter(p => world.dist2(p, anchor) < reach)
        .sort((a, b) => world.dist2(a, bot.entity.position) - world.dist2(b, bot.entity.position))[0]
      // walking off after a herd or exploring: fit, armed, daylight left - or not at all. Fit = above the reflex's own hurt
      // line, not a fixed 12: health only comes back on a full belly, and at hp 10 / food 13 the food that would heal it was
      // never looked for - the bot walked on hungry and hurt until drowned killed it (2026-09-27)
      const fit = bot.health > reflex.hurtLine() && !!inv.bestWeapon(bot) && world.phase(bot) === 'day' && world.tod(bot) < 9000
      if (!fit) { log('food', `no ${re} in sight and not fit to go looking (hp ${Math.round(bot.health)})`); return false }
      // (in view past the hunt's reach: a kind the hunt may take from, at an animal not already in the near list - the
      //  nearest "huntable" in view was the lone cow at 20 we already stood by, walked to five times while the herd at 100
      //  waited; audit 2026-10-03. The kill itself still goes through huntable() on the near list, last-two rule and all)
      const farGame = () => {
        const inView = animals(bot, re, VIEW)
        const game = new Set(huntable(bot, inView, itemName).map(e => e.name))
        return inView.find(e => !list.includes(e) && game.has(e.name))
      }
      const far = farGame()
      if (far) await toInSight(bot, far, ctx)
      else if (known && empty === 1 && world.dist2(known, bot.entity.position) > 40) {
        log('food', `heading to where i saw animals at ${move.fmt(known)}`)
        wentTo = { x: known.x, z: known.z }
        await move.travel(bot, known, { range: 10, shouldStop: ctx.shouldStop, label: 'to animals' })
      } else {
        await gather().explore(bot, () => false, { shouldStop: () => (ctx.shouldStop && ctx.shouldStop()) || !!farGame(), label: 'animals', legs: 2 })
      }
      continue
    }
    empty = 0
    // wool: shearing would be kinder but needs iron; a kill gives 1 wool
    await killAnimal(bot, pick)
  }
  return true
}

// ---- wool ----------------------------------------------------------------------------------------
// A sheep's "wool" byte: low nibble the colour, 0x10 set once shorn (until it eats grass again). Read by
// name from the registry's metadata keys - the index moves between versions.
// (the byte's colour index, vanilla order)
const WOOL_COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
function sheepWool (bot, e) {
  try {
    const keys = world.data(bot).entitiesByName.sheep.metadataKeys || []
    const i = keys.indexOf('wool')
    const v = i >= 0 && e.metadata ? e.metadata[i] : null
    return typeof v === 'number' ? { sheared: (v & 0x10) !== 0, colour: v & 0x0f } : null
  } catch { return null }
}
// (the day a shears make failed: day.js - in memory.json, a restart wiped it; mem.persistedMap's reason)
const shornTried = new Map() // sheep entity id -> shearing it gave nothing (its byte said woolly: it is not)

// Get `n` more wool of `colour` (white: the rest are dyed from it). Shears when we have them (1-3 wool a sheep, and the
// sheep grows it back); without, a kill gives one. Shears are made only from iron nobody else is waiting on.
// (`colour`: the wool asked for, counted exactly - a brown sheep's wool is a bonus, never the white a trip was sent for:
//  counted as any, the trip returned "done" with white still short and the dry-day rule read it as found; audit)
async function woolFor (bot, n, ctx = {}, colour = 'white') {
  const woolCount = () => inv.count(bot, colour + '_wool')
  const target = woolCount() + n
  if (!inv.has(bot, 'shears') && base().bankCount('shears') > 0) await base().withdraw(bot, 'shears', 1).catch(() => 0)
  // a real surplus of iron (armour and tools come first - the iron task spends it on those); or wool wanted by the
  // dozen, worth a dig for two ingots: a kill a wool emptied the flocks round home and the trip explored 176 blocks out
  // for the castle's 33 purple wool, no iron banked at all (2026-09-29)
  // (a make that failed - no iron in reach, no pick for it - is not tried again until tomorrow: every wool leg paid the whole
  //  attempt again before the kill; a make cut short by a stop found nothing because it looked at nothing, and stays open; audit)
  if (!inv.has(bot, 'shears') && mem.get().shearsFailDay !== require('./day').dayNo(bot) && (inv.count(bot, 'iron_ingot') + base().bankCount('iron_ingot') >= 12 || n >= 8)) {
    const ok = await craft().ensure(bot, 'shears', 1, Object.assign({}, ctx, { depth: (ctx.depth || 0) + 1 })).catch(() => false)
    if (!ok && !inv.has(bot, 'shears') && !(ctx.shouldStop && ctx.shouldStop())) { mem.set('shearsFailDay', require('./day').dayNo(bot)); log('food', 'no shears to be made today - wool by the kill until tomorrow') }
  }
  // THE PEN FIRST: its sheep grow their wool back, and it is by home (pen.js). The open range after - never the pen's
  // flock killed: animals() leaves penned sheep out
  if (inv.has(bot, 'shears') && pen().hasWool(bot) && !(ctx.shouldStop && ctx.shouldStop())) await pen().shear(bot, { shouldStop: ctx.shouldStop }).catch(e => log('food', 'shearing the pen threw: ' + e.message))
  if (woolCount() >= target) return true
  const t0 = Date.now()
  let empty = 0
  let wentTo = null // (the remembered flock walked to this trip - forgotten if it is not there)
  let shornWalks = 0 // (walks past a shorn flock to a woolly sheep in view: bounded - empty resets on every pick)
  while (woolCount() < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return false
    if (Date.now() - t0 > 10 * 60000) return false
    await reflex.waitClear()
    const shears = inv.items(bot).find(i => i.name === 'shears')
    const list = animals(bot, /^sheep$/, 48)
    for (const e of list) noteMob(e)
    const woolly = e => { const w = sheepWool(bot, e); return !shornTried.has(e.id) && !(w && w.sheared) }
    const ofColour = e => { const w = sheepWool(bot, e); return !!w && WOOL_COLOURS[w.colour] === colour }
    // (a shorn sheep killed gives no wool: without shears only the woolly ones count - one was picked as readily as any)
    const unshorn = list.filter(e => { const w = sheepWool(bot, e); return !(w && w.sheared) })
    const pick = shears ? (list.find(e => woolly(e) && ofColour(e)) || list.find(woolly) || list[0]) : (unshorn.find(ofColour) || unshorn[0])
    if (!pick) {
      // (a remembered flock that is not there when we arrive is forgotten: four wool trips walked to the same spot - inside
      //  the castle's ground by then - found nothing, and went again, 2026-09-28)
      if (wentTo && world.dist2(wentTo, bot.entity.position) < 16 && !list.length) { // (no sheep there at all - a shorn one is still the flock)
        mem.update(m => { if (m.mobs && m.mobs.sheep) m.mobs.sheep = m.mobs.sheep.filter(q => world.dist2(q, wentTo) >= 32) })
        log('food', `no sheep where they were seen at ${wentTo.x},${wentTo.z} - forgotten`)
        wentTo = null
      }
      if (++empty > 4) { log('food', 'no sheep for wool nearby'); return false }
      const anchor = mem.get().home || bot.entity.position
      const known = (mem.get().mobs || {}).sheep ? mem.get().mobs.sheep.filter(p => world.dist2(p, anchor) < 200).sort((a, b) => world.dist2(a, bot.entity.position) - world.dist2(b, bot.entity.position))[0] : null
      const fit = bot.health >= 12 && world.phase(bot) === 'day'
      if (!fit) { log('food', `no sheep in sight and not fit to go looking (hp ${Math.round(bot.health)})`); return false }
      const woollyFar = e => { const w = sheepWool(bot, e); return !(w && w.sheared) && !list.includes(e) }
      const far = animals(bot, /^sheep$/, VIEW).find(woollyFar)
      if (far) await toInSight(bot, far, ctx)
      else if (known && empty === 1 && world.dist2(known, bot.entity.position) > 40) { wentTo = known; await move.travel(bot, known, { range: 10, shouldStop: ctx.shouldStop, label: 'to sheep' }) }
      else await gather().explore(bot, () => false, { shouldStop: () => (ctx.shouldStop && ctx.shouldStop()) || animals(bot, /^sheep$/, VIEW).some(woollyFar), label: 'animals', legs: 2 })
      continue
    }
    empty = 0
    if (shears && woolly(pick)) {
      const before = woolCount()
      const r = await move.goTo(bot, new goals.GoalFollow(pick, 2), { timeoutMs: 20000, stuckMs: 6000, dig: false, place: false, label: 'to sheep' })
      if (!r.ok && pick.position.distanceTo(bot.entity.position) > 3) { shornTried.set(pick.id, Date.now()); continue }
      try {
        await bot.equip(shears, 'hand')
        await bot.lookAt(pick.position.offset(0, 0.8, 0), true)
        bot.activateEntity(pick)
      } catch {}
      await move.sleep(600)
      await act.collectDrops(bot, { radius: 6, maxMs: 5000 })
      if (woolCount() <= before) shornTried.set(pick.id, Date.now())
      else log('food', `sheared a sheep: +${woolCount() - before} wool`)
      continue
    }
    // no shears (or every sheep here is shorn and we still have none to spare): a kill gives one
    if (shears) {
      // (every sheep near is shorn: a woolly one in view further off is walked to before giving up)
      const woollyFar = animals(bot, /^sheep$/, VIEW).find(e => !list.includes(e) && woolly(e))
      if (woollyFar && ++shornWalks <= 4) { await toInSight(bot, woollyFar, ctx); continue }
      log('food', 'every sheep in sight is shorn'); return woolCount() > target - n
    }
    await killAnimal(bot, pick)
  }
  return true
}

// Cast, watch our bobber, reel in when a fish yanks it under. (mineflayer's bot.fish() waits for a
// particle packet that never matched on this server: 7 minutes, 0 fish.)
async function castAndWait (bot, maxMs) {
  const mine = () => Object.values(bot.entities).filter(e => e && e.name === 'fishing_bobber' && e.position && e.position.distanceTo(bot.entity.position) < 32)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  bot.activateItem() // cast
  await move.sleep(3500) // fly out, splash down, settle
  let bob = mine()
  if (!bob) { try { bot.activateItem() } catch {} ; return false }
  let base = bob.position.y
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await move.sleep(100)
    if (!bot.entity) return false
    bob = mine()
    if (!bob) return false
    const y = bob.position.y
    // a bite yanks the bobber well under; waves move it a few hundredths
    if (y < base - 0.28) {
      bot.activateItem()
      await move.sleep(1400) // the catch flies to us
      return true
    }
    base = base * 0.85 + y * 0.15
  }
  bot.activateItem() // nothing bit: reel in
  await move.sleep(500)
  return false
}

// Fishing: renewable food that does not depend on animals. A rod is 3 sticks + 2 string.
async function fishFor (bot, n, ctx = {}) {
  const fishCount = () => inv.count(bot, 'cod') + inv.count(bot, 'salmon')
  const target = fishCount() + n
  if (!inv.has(bot, 'fishing_rod') && base().bankCount('fishing_rod') > 0) await base().withdraw(bot, 'fishing_rod', 1)
  if (!inv.has(bot, 'fishing_rod')) {
    if (inv.count(bot, 'string') < 2 && base().bankCount('string') >= 2) await base().withdraw(bot, 'string', 2)
    if (inv.count(bot, 'string') < 2) { log('food', 'no string for a fishing rod'); return false }
    if (!await craft().ensure(bot, 'fishing_rod', 1, ctx)) return false
  }
  const anchor = mem.get().home || bot.entity.position
  // open water with air above and dry standable ground beside it; prefer water 2+ deep (fish bite there)
  const waters = world.findBlocks(bot, /^water$/, { maxDistance: 64, count: 60, point: new (require('vec3').Vec3)(anchor.x, anchor.y, anchor.z) })
    .filter(w => world.isAirish(world.at(bot, w.position.x, w.position.y + 1, w.position.z)) && world.openSky(bot, w.position.offset(0, 1, 0)))
  let spot = null
  for (const w of waters) {
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
      const s = { x: w.position.x + dx, y: w.position.y + 1, z: w.position.z + dz }
      if (world.standable(bot, s.x, s.y, s.z) && !world.isWaterBlock(world.at(bot, s.x, s.y, s.z))) { spot = { stand: s, water: w.position }; break }
    }
    if (spot) break
  }
  if (!spot) { log('food', 'no fishing spot near home'); return false }
  const r = await move.goTo(bot, new goals.GoalBlock(spot.stand.x, spot.stand.y, spot.stand.z), { timeoutMs: 60000, label: 'to fishing spot', shouldStop: ctx.shouldStop })
  if (!r.ok) return false
  log('food', `fishing at ${move.fmt(spot.stand)}`)
  const t0 = Date.now()
  while (fishCount() < target && Date.now() - t0 < 6 * 60000) {
    await new Promise(res => setImmediate(res))
    if (!bot.entity || bot.health <= 0) return false
    if (ctx.shouldStop && ctx.shouldStop()) break
    if (reflex.active()) { await reflex.waitClear(); continue }
    const rod = inv.items(bot).find(i => i.name === 'fishing_rod')
    if (!rod) break
    try {
      await bot.equip(rod, 'hand')
      await bot.lookAt(spot.water.offset(0.5, 0.9, 0.5), true)
      const bit = await castAndWait(bot, 40000)
      if (bit) log('food', 'a bite - reeled in')
    } catch (e) { log('food', 'fishing cast failed: ' + e.message) }
    // the catch lands at our feet or in the shallows in front of us: pick it up
    const near = Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 5)
    for (const it of near) { await move.goTo(bot, new goals.GoalNear(it.position.x, it.position.y, it.position.z, 1), { timeoutMs: 4000, stuckMs: 2000, label: 'fish pickup' }) }
  }
  log('food', `caught ${fishCount()} fish`)
  return fishCount() >= target
}

// Ripe crops anywhere near home (our farm, an old plot, a village field): harvest, bake, replant.
async function harvestCrops (bot, ctx = {}) {
  const home = mem.get().home || bot.entity.position
  const ripe = world.findBlocks(bot, /^(wheat|carrots|potatoes|beetroots)$/, { maxDistance: 96, count: 40, point: new (require('vec3').Vec3)(home.x, home.y, home.z) })
    .filter(b => { try { const p = b.getProperties(); return Number(p.age) >= (b.name === 'beetroots' ? 3 : 7) } catch { return false } })
    // not where we have drowned before: a couple of wheat is not worth that pond again
    .filter(b => !(mem.get().deaths || []).some(d => (d.place === 'water' || d.cause === 'water' || d.cause === 'drown') && world.dist3(d, b.position) < 20))
  if (!ripe.length) return 0
  log('food', `harvesting ${ripe.length} ripe crops`)
  let got = 0
  ripe.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  for (const b of ripe) {
    if (ctx.shouldStop && ctx.shouldStop()) break
    await reflex.waitClear()
    if (!bot.entity) break
    const pos = b.position
    if (await act.dig(bot, pos, { timeoutMs: 8000, force: true })) got++ // crops are not "natural terrain" to the dig guard
    await act.collectDrops(bot, { radius: 4, maxMs: 2500 })
    // replant on the same farmland
    const soil = world.at(bot, pos.x, pos.y - 1, pos.z)
    const seed = b.name === 'wheat' ? 'wheat_seeds' : b.name === 'carrots' ? 'carrot' : b.name === 'potatoes' ? 'potato' : 'beetroot_seeds'
    if (soil && soil.name === 'farmland' && inv.has(bot, seed)) {
      try { await bot.equip(inv.items(bot).find(i => i.name === seed), 'hand'); await bot.activateBlock(soil, new (require('vec3').Vec3)(0, 1, 0)) } catch {}
    }
  }
  const loaves = Math.floor(inv.count(bot, 'wheat') / 3)
  if (loaves > 0) await craft().ensure(bot, 'bread', inv.count(bot, 'bread') + loaves, { noWithdraw: true }).catch(() => false)
  log('food', `harvested ${got} crops -> bread ${inv.count(bot, 'bread')}, carrots ${inv.count(bot, 'carrot')}, potatoes ${inv.count(bot, 'potato')}`)
  return got
}

// Get the pack to a comfortable food buffer: bank -> cook raw -> hunt+cook.
const RAW_BANK = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato']
async function stockFood (bot, { targetPoints = 40, ctx = {} } = {}) {
  if (inv.foodPoints(bot) >= targetPoints) return true
  // 0) THE BANK FIRST, wherever we stand: food in the chests (cooked, wheat for bread, meat to cook) is home's - walked to
  //    when home is in reach. 250 blocks out, the food task passed 92 banked wheat and 15 banked meat by and went fishing,
  //    then hunting (2026-10-02). Withdraw > craft > gather, from where the bank is
  {
    const COOKED = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'bread', 'cooked_chicken', 'baked_potato', 'cooked_salmon', 'cooked_cod', 'golden_carrot', 'apple', 'carrot']
    const banked = COOKED.reduce((s, n) => s + base().bankCount(n) * 5, 0) + Math.floor(base().bankCount('wheat') / 3) * 5 + RAW_BANK.reduce((s, n) => s + base().bankCount(n) * 5, 0)
    const home = mem.get().home
    const d = home ? world.dist2(home, bot.entity.position) : Infinity
    if (banked >= 10 && d > 48 && d < 600) {
      log('food', `${banked} food pts in the bank at home, ${Math.round(d)}b off - home for it first`)
      await base().goHome(bot, { shouldStop: ctx.shouldStop }).catch(() => null)
    }
  }
  // 1) cooked food from the chests
  for (const n of ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'bread', 'cooked_chicken', 'baked_potato', 'cooked_salmon', 'cooked_cod', 'golden_carrot', 'apple', 'carrot']) {
    if (inv.foodPoints(bot) >= targetPoints) return true
    if (base().bankCount(n) > 0) await base().withdraw(bot, n, 16)
  }
  // 1b) wheat in the bank is bread three steps away (a 310-block animal hunt set off past 15 banked wheat)
  if (inv.foodPoints(bot) < targetPoints && inv.count(bot, 'wheat') + base().bankCount('wheat') >= 3) {
    const want = Math.min(base().bankCount('wheat'), Math.ceil((targetPoints - inv.foodPoints(bot)) / 5) * 3)
    if (want > 0) await base().withdraw(bot, 'wheat', want).catch(() => 0)
    const loaves = Math.floor(inv.count(bot, 'wheat') / 3)
    if (loaves > 0) await craft().ensure(bot, 'bread', inv.count(bot, 'bread') + loaves, { noWithdraw: true }).catch(() => false)
    if (inv.foodPoints(bot) >= targetPoints) return true
  }
  // 2) cook what we carry - and the bank's raw meat with it (the home furnaces stand beside it)
  for (const n of RAW_BANK) {
    if (inv.foodPoints(bot) + inv.rawFoodCount(bot) * 6 >= targetPoints) break
    if (base().bankCount(n) > 0) await base().withdraw(bot, n, 16).catch(() => 0)
  }
  if (inv.rawFoodCount(bot) > 0) await cookAll(bot, ctx)
  if (inv.foodPoints(bot) >= targetPoints) return true
  // 2b) ripe crops near home - no animals needed
  await harvestCrops(bot, ctx).catch(e => log('food', 'harvest threw: ' + e.message))
  if (inv.foodPoints(bot) >= Math.min(targetPoints, 20)) return true
  // 3) hunt - unless the last hunt found nothing: then fish first (a hunted-out area stays empty)
  const before = inv.rawFoodCount(bot)
  const want = Math.ceil((targetPoints - inv.foodPoints(bot)) / 7)
  const canFishNow = inv.has(bot, 'fishing_rod') || base().bankCount('fishing_rod') > 0 || inv.count(bot, 'string') + base().bankCount('string') >= 2
  if (canFishNow && Date.now() - (mem.get().lastHuntEmpty || 0) < 30 * 60000) {
    await fishFor(bot, Math.min(want, 8), ctx).catch(e => log('food', 'fishing threw: ' + e.message))
    if (inv.rawFoodCount(bot) > 0) await cookAll(bot, ctx)
    if (inv.foodPoints(bot) + inv.rawFoodCount(bot) * 5 >= 12) return inv.foodPoints(bot) >= Math.min(targetPoints, 20)
  }
  for (const item of ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit']) {
    const re = craft().HUNT[item]
    if (!animals(bot, re, 40).length) continue
    await huntFor(bot, item, Math.min(want, 6), ctx)
    if (inv.rawFoodCount(bot) >= want) break
  }
  if (inv.rawFoodCount(bot) === before) {
    // no animals around: fish (when we can make a rod), else roam for any food animal
    const canFish = inv.has(bot, 'fishing_rod') || base().bankCount('fishing_rod') > 0 || inv.count(bot, 'string') + base().bankCount('string') >= 2
    if (canFish) await fishFor(bot, Math.min(want, 8), ctx).catch(e => log('food', 'fishing threw: ' + e.message))
    // roaming far for animals is a trip into the unknown: only fit, armed, with daylight left (at hp 4
    // with no sword it walked 400 blocks out at dusk)
    const fit = bot.health > reflex.hurtLine() && !!inv.bestWeapon(bot) && world.phase(bot) === 'day' && world.tod(bot) < 9000
    // a roam that found nothing an hour ago will find nothing now (animals here do not come back): a whole
    // day went on 300 blocks of empty exploring - the farm is the food
    const huntedOut = Date.now() - (mem.get().lastHuntEmpty || 0) < 60 * 60000
    if (inv.rawFoodCount(bot) === before && fit && !huntedOut) await huntFor(bot, 'beef', Math.min(want, 4), ctx).catch(() => false)
    else if (inv.rawFoodCount(bot) === before) log('food', `not roaming for animals (hp ${Math.round(bot.health)}, ${inv.bestWeapon(bot) ? 'armed' : 'unarmed'}, tod ${world.tod(bot)})`)
  }
  if (inv.rawFoodCount(bot) > 0) await cookAll(bot, ctx)
  return inv.foodPoints(bot) >= Math.min(targetPoints, 20)
}

async function cookAll (bot, ctx = {}) {
  for (const it of inv.items(bot)) {
    const cooked = inv.COOKED_OF[it.name]
    if (!cooked) continue
    const n = inv.count(bot, it.name)
    if (n <= 0) continue
    const ok = await smelt().smeltItem(bot, cooked, n, Object.assign({}, ctx, { noWithdraw: true }))
    log('food', `cooked ${n} ${it.name} -> ${ok ? 'ok' : 'partly'}`)
  }
}

module.exports = { install, noteMob, huntFor, woolFor, sheepWool, isBaby, stockFood, cookAll, animals, killAnimal, huntable, fishFor, harvestCrops, FOOD_ANIMALS }
