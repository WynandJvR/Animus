'use strict'
// THE DIRECTOR - one loop, one decision at a time, re-read from the world every cycle.
// Survival reflexes preempt everything (reflex.js). Below that, the first task whose condition
// holds wins. No timers stand in for conditions; every decision logs why.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')
const craft = require('./craft')
const base = require('./base')
const food = require('./food')
const shelter = require('./shelter')
const smelt = require('./smelt')
const build = require('./build')
const mining = require('./mining')
const gather = require('./gather')
const graves = require('./graves')
const control = require('./control')
const farm = require('./farm')
const hut = require('./hut')
const lights = require('./lights')

// Hunt an animal that is right here when the pack is low on food - a player does not walk past a
// cow with nothing to eat. Bounded to animals within 20 blocks and ~25 seconds.
async function opportunisticHunt () {
  if (inv.foodPoints(bot) + inv.rawFoodCount(bot) * 6 >= 30) return
  if (world.isNight(bot) || reflex.active()) return
  const list = food.animals(bot, food.FOOD_ANIMALS, 20)
  const pick = food.huntable ? food.huntable(bot, list, 'beef')[0] : null
  if (!pick) return
  log('dir', `a ${pick.name} ${Math.round(pick.position.distanceTo(bot.entity.position))}b away and little food - hunting it`)
  await food.killAnimal(bot, pick, { maxMs: 25000 })
}

let bot = null
let paused = false
let current = null // {name, why, since}
let override = null // operator-forced task name
let lastDecisionKey = ''
let running = false
let lastInstantKey = ''
let instantRepeats = 0
const failures = {} // task -> {n, at} consecutive failures (a failed task yields to others)

function nightSoon () { return world.phase(bot) !== 'day' }
let taskCancelled = () => false
function dayStop () { return taskCancelled() || nightSoon() }
// heading home: keep walking through dusk; only real night (mobs) stops a trip that is still long
function homewardStop () { return taskCancelled() || (world.isNight(bot) && (!mem.get().home || world.dist2(bot.entity.position, mem.get().home) > 48)) }
function underground () {
  const p = world.feetPos(bot)
  return !world.openSky(bot, p) && p.y < (mem.get().home ? mem.get().home.y - 6 : 50)
}

function note (name, ok) {
  if (ok) delete failures[name]
  else { const f = failures[name] || (failures[name] = { n: 0, at: 0 }); f.n++; f.at = Date.now() }
}
// A task that just failed steps aside until the world changes (time passing is the change here:
// position, daylight, inventory differ after other work). Backoff grows with repeated failure.
function cooling (name) {
  const f = failures[name]
  if (!f) return false
  return Date.now() - f.at < Math.min(15 * 60000, 30000 * Math.pow(2, Math.min(f.n - 1, 5)))
}

const TOOL_KIT = ['stone_pickaxe', 'stone_axe', 'stone_sword']
const SPARE_KIT = TOOL_KIT

// Furniture we are carrying that belongs in the safehouse (none placed of that kind at home yet).
// Furniture stacked on furniture inside the safehouse (a furnace on the chest seals the chest).
function misplacedFurniture () {
  const p = mem.get().hutPlan
  if (!p) return []
  const out = []
  for (let x = p.interior.x1; x <= p.interior.x2; x++) for (let z = p.interior.z1; z <= p.interior.z2; z++) for (let y = p.home.y + 1; y <= p.home.y + 2; y++) {
    const b = world.at(bot, x, y, z); const under = world.at(bot, x, y - 1, z)
    if (b && under && /(chest|furnace|crafting_table|_bed|barrel)$/.test(b.name) && /(chest|furnace|crafting_table|_bed|barrel)$/.test(under.name)) out.push(b.position)
  }
  // a stray door beside the real one (a re-hang that landed a block off blocked the step outside)
  if (p.door) {
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue
      const b = world.at(bot, p.door.x + dx, p.home.y, p.door.z + dz)
      if (b && /_door$/.test(b.name) && !/iron/.test(b.name)) out.push(b.position)
    }
  }
  // utility blocks crowding the outside door step (the way in)
  if (p.door) {
    const axisX = p.door.x < p.interior.x1 || p.door.x > p.interior.x2
    const out1 = axisX ? { x: p.door.x < p.interior.x1 ? p.door.x - 1 : p.door.x + 1, z: p.door.z } : { x: p.door.x, z: p.door.z < p.interior.z1 ? p.door.z - 1 : p.door.z + 1 }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const dy of [-1, 0, 1]) {
      const b = world.at(bot, out1.x + dx, p.home.y + dy, out1.z + dz)
      if (b && /(chest|furnace|crafting_table|barrel)$/.test(b.name) && !(Math.abs(dx) + Math.abs(dz) === 0 && dy === -1)) out.push(b.position)
    }
  }
  // furniture standing in the walkway (a bed at the back of it is where the bed belongs)
  const lay = hut.layout(bot)
  if (lay) {
    for (const w of lay.walkway) {
      // at head height too: a chest hung over the door step leaves no room to stand there, and the door
      // could never be crossed
      for (const dy of [0, 1]) {
        const b = world.at(bot, w.x, w.y + dy, w.z)
        if (!b || !/(chest|furnace|crafting_table|barrel|_bed)$/.test(b.name)) continue
        if (dy === 0 && /_bed$/.test(b.name) && lay.bed && ((w.x === lay.bed.foot.x && w.z === lay.bed.foot.z) || (w.x === lay.bed.head.x && w.z === lay.bed.head.z))) continue
        out.push(b.position)
      }
    }
  }
  return out
}

function furnishingInPack () {
  const home = mem.get().home
  if (!home) return []
  if (misplacedFurniture().length) return ['(re-seat stacked furniture)']
  const out = []
  const near = re => world.findBlocks(bot, re, { maxDistance: 6, count: 1, point: new Vec3(home.x, home.y, home.z) }).length > 0
  if (inv.has(bot, 'chest') && !near(/^chest$/)) out.push('chest')
  if (inv.has(bot, 'furnace') && !near(/^furnace$/)) out.push('furnace')
  if (inv.has(bot, 'crafting_table') && !near(/^crafting_table$/)) out.push('crafting_table')
  if (shelter.hasBedItem(bot) && !near(/_bed$/)) out.push('bed')
  return out
}

// A bed is worth going for only when we can actually get one: carrying one, wool for one, a stray
// bed nearby, or sheep known close to home. Otherwise the safehouse is the night shelter.
function bedObtainable () {
  if (shelter.hasBedItem(bot)) return true
  if (Object.values(bot.entities).some(e => { try { return e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 48 && /_bed$/.test(e.getDroppedItem().name) } catch { return false } })) return true
  const c = inv.counts(bot)
  if (Object.keys(c).some(n => /_wool$/.test(n) && c[n] >= 3)) return true
  const home = mem.get().home
  if (world.findBlocks(bot, /_bed$/, { maxDistance: 48, count: 1, point: home ? new Vec3(home.x, home.y, home.z) : undefined }).length) return true
  const sheep = ((mem.get().mobs || {}).sheep || []).filter(p => home && world.dist2(p, home) < 160) // the hunt's own reach
  return sheep.length > 0 || food.animals(bot, /^sheep$/, 48).length > 0
}

// Items in the pack beyond the kit we keep on us.
function haulSize () {
  let n = 0
  for (const it of inv.items(bot)) { const keep = base.keepCount(bot, it); if (keep !== Infinity) n += Math.max(0, it.count - keep) }
  return n
}

function missingKit () {
  const out = []
  if (inv.toolTier(bot, 'pickaxe') < 2) out.push('stone_pickaxe')
  if (inv.toolTier(bot, 'axe') < 2) out.push('stone_axe')
  if (inv.toolTier(bot, 'sword') < 2) out.push('stone_sword')
  return out
}

function ironWanted () {
  const w = inv.wornArmor(bot)
  const out = []
  const rank = it => it ? ({ leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }[it.name.split('_')[0]] || 0) : 0
  // a shield first: one ingot, and it stops the arrows an unarmoured bot loses every skeleton trade to
  if (!inv.hasShield(bot)) out.push('shield')
  // a dry farm grows a fraction of the wheat: the bucket that waters it comes before armour
  const f = farm.farm()
  if (f && !f.water && !inv.has(bot, 'bucket') && !inv.has(bot, 'water_bucket') && base.bankCount('bucket') === 0) out.push('bucket')
  if (rank(w.torso) < 4) out.push('iron_chestplate')
  if (rank(w.legs) < 4) out.push('iron_leggings')
  if (rank(w.head) < 4) out.push('iron_helmet')
  if (rank(w.feet) < 4) out.push('iron_boots')
  if (inv.toolTier(bot, 'pickaxe') < 3) out.push('iron_pickaxe')
  if (inv.toolTier(bot, 'sword') < 3) out.push('iron_sword')
  return out
}
const IRON_COST = { shield: 1, bucket: 3, iron_chestplate: 8, iron_leggings: 7, iron_helmet: 5, iron_boots: 4, iron_pickaxe: 3, iron_sword: 2 }

// Choose a home next to the build site (or where we stand): dry open ground just outside it.
// Score ground for a base: standable, dry (no water within 4), flat around (a base needs room),
// not inside the build footprint. Needs the chunks loaded - returns null if the site isn't.
function siteScore (x, z, refY) {
  const gy = world.groundY(bot, x, z, refY + 12)
  if (gy == null) return null
  const y = gy + 1
  if (!world.standable(bot, x, y, z)) return null
  if (world.waterNear(bot, { x, y, z }, 4, -2, 1) || world.lavaNear(bot, { x, y, z }, 4)) return null
  let flat = 0
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const g2 = world.groundY(bot, x + dx, z + dz, refY + 12)
    if (g2 != null && Math.abs(g2 - gy) <= 1 && !world.isWaterBlock(world.at(bot, x + dx, g2, z + dz))) flat++
  }
  return { x, y, z, flat, dy: Math.abs(y - refY) }
}

function chooseHome () {
  const b = mem.get().build
  const j = build.getJob()
  if (b && j) {
    const box = j.box
    const cx = (box.x1 + box.x2) / 2; const cz = (box.z1 + box.z2) / 2
    const half = Math.max(box.x2 - box.x1, box.z2 - box.z1) / 2
    const cands = []
    for (let r = half + 9; r <= half + 22; r += 2) {
      for (let a = 0; a < 32; a++) {
        const x = Math.round(cx + Math.cos(a * Math.PI / 16) * r); const z = Math.round(cz + Math.sin(a * Math.PI / 16) * r)
        // the hut (home +-3) must stand at least 4 blocks clear of the footprint: home >= 8 outside it
        if (x >= box.x1 - 8 && x <= box.x2 + 8 && z >= box.z1 - 8 && z <= box.z2 + 8) continue
        const s = siteScore(x, z, box.y1)
        if (s) cands.push(Object.assign(s, { score: s.flat * 2 - s.dy * 3 - (r - half) * 0.5 }))
      }
    }
    cands.sort((p, q) => q.score - p.score)
    if (cands.length) { log('dir', `home site picked at ${move.fmt(cands[0])} (flat ${cands[0].flat}/49, ${cands.length} candidates)`); return cands[0] }
    return null // site not loaded yet - go there first
  }
  const me = world.feetPos(bot)
  return siteScore(me.x, me.z, me.y) || me
}

// Chests already standing around home are ours to use (the base's storage from before).
function adoptChests () {
  const h = mem.get().home
  if (!h) return
  const found = world.findBlocks(bot, /^(chest|barrel)$/, { maxDistance: 16, count: 12, point: new Vec3(h.x, h.y, h.z) })
  for (const c of found) mem.addUnique('chests', c.position)
  if (found.length) log('base', `adopted ${found.length} chest(s) around home`)
}

function baseZone () {
  const h = mem.get().home
  if (!h) return
  move.setZone('base', { x1: h.x - 5, y1: h.y - 3, z1: h.z - 5, x2: h.x + 5, y2: h.y + 6, z2: h.z + 5 })
}

// ---- the decision -------------------------------------------------------------------------
function decide () {
  const night = world.phase(bot) === 'night'
  const dusk = world.phase(bot) === 'dusk'
  const home = mem.get().home
  const dHome = home ? world.dist2(bot.entity.position, home) : Infinity
  const packFood = inv.foodPoints(bot)
  const bed = mem.get().bed

  if (override) return { name: override, why: 'operator' }

  // a bed standing in the safehouse is our bed, whoever put it there
  if (!bed && mem.get().hutPlan) {
    const hp = mem.get().hutPlan
    const inHut = world.findBlocks(bot, /_bed$/, { maxDistance: 6, count: 2, point: new Vec3(hp.home.x, hp.home.y, hp.home.z) }).find(b => move.insideHut(b.position))
    if (inHut) { mem.set('bed', { x: inHut.position.x, y: inHut.position.y, z: inHut.position.z }); log('dir', `the bed at ${move.fmt(inHut.position)} is mine`) }
  }

  // 0. mobs around home in the dim hours (or while badly hurt): wait them out walled into the safehouse.
  //    Every task below walks outside; at dawn the skeletons are not burning yet (three deaths at the
  //    doorstep in one morning: grave run, harvest, grave run)
  // (at the surface around us - a zombie in a cave under home is not at the door)
  const around = reflex.hostiles(20).filter(h => h.e.name !== 'bat' && Math.abs(h.e.position.y - bot.entity.position.y) < 6)
  const dim = world.phase(bot) !== 'day' || world.tod(bot) >= 23000 || world.tod(bot) < 1500
  if (around.length && home && dHome < 48 && hut.shellComplete(bot) && (dim || bot.health <= 10) && !cooling('hideout')) {
    return { name: 'hideout', why: `${around.length} hostile${around.length > 1 ? 's' : ''} around home (${around.slice(0, 3).map(h => h.e.name).join(', ')}) - waiting inside` }
  }
  // evening: be home before dusk, not at it - a 100-block walk begun at dusk arrives in the dark (a zombie
  // met the bot at its own door at hp 10)
  if (home && world.phase(bot) === 'day' && world.tod(bot) >= 10500 && world.tod(bot) < 12000 && dHome > 32 && hut.shellComplete(bot) && !cooling('goHome')) {
    return { name: 'goHome', why: `evening - home is ${Math.round(dHome)}b away, back before dark` }
  }
  // a grave right here (died in the safehouse, or beside it): pick it up whatever the hour - it
  // despawns, and it is a few steps - but not into the mob that put it there
  {
    const g0 = graves.bestGrave(bot)
    if (g0 && world.dist3(g0, bot.entity.position) < 10 && !around.some(h => h.d < 16) && !cooling('grave')) return { name: 'grave', why: `my grave is ${Math.round(world.dist3(g0, bot.entity.position))}b away - ${g0.items} items` }
  }

  // 1. night
  if (night || dusk) {
    // at dusk walk to the bed from anywhere near; once it is dark only if the bed is a few steps away
    // (a night walk home from the mine ended in a skeleton fight and a death 12 blocks from the bed)
    if (bed && world.dist2(bed, bot.entity.position) < (dusk ? 200 : 32) && !cooling('sleep')) return { name: 'sleep', why: `${night ? 'night' : 'dusk'} - my bed is ${Math.round(world.dist2(bed, bot.entity.position))}b away` }
    // a working mine next to home turns the night into mining time: go down at dusk (a short walk)
    {
      const mm = mem.get().mine
      const mineReady = mm && mm.entrance && home && world.dist2(mm.entrance, home) < 48 && inv.bestTool(bot, 'pickaxe', 8) && (packFood >= 10 || bot.food >= 18)
      if (mineReady && (dusk || !move.insideHut(world.feetPos(bot))) && world.dist2(bot.entity.position, mm.entrance) < 64 && !cooling('nightMine')) return { name: 'nightMine', why: `${night ? 'night' : 'dusk'} - mining through the night in the mine next to home` }
    }
    // inside the safehouse with furniture in the pack: set it up (the bed means sleeping, not waiting)
    if (move.insideHut(world.feetPos(bot)) && furnishingInPack().length && !cooling('furnish')) return { name: 'furnish', why: `night in the safehouse - putting ${furnishingInPack().join(', ')} down` }
    // no bed placed but the safehouse stands: spend the night inside it
    if (home && dHome < 160 && hut.shellComplete(bot) && !shelter.hasBedItem(bot) && !cooling('hutNight')) return { name: 'hutNight', why: `${night ? 'night' : 'dusk'} - sheltering in the safehouse` }
    // carrying a bed (travelling, moving house): put it down and sleep - it skips the night
    if (shelter.hasBedItem(bot) && !cooling('sleepHere')) return { name: 'sleepHere', why: `${night ? 'night' : 'dusk'} - sleeping in the bed i carry` }
    // dusk and home (or the site that will be home) is within a short walk: get there, dig in there
    if (dusk) {
      const j = build.getJob()
      if (!home && j && world.dist2(bot.entity.position, j.origin) < 220 && world.dist2(bot.entity.position, j.origin) > 40 && !cooling('setHome')) return { name: 'setHome', why: `dusk - the build site is ${Math.round(world.dist2(bot.entity.position, j.origin))}b away, getting there before dark` }
      if (home && dHome > 24 && dHome < 220 && !cooling('goHome')) return { name: 'goHome', why: `dusk - home is ${Math.round(dHome)}b away` }
    }
    const m = mem.get().mine
    const mineHere = m && (!home || world.dist2(m.entrance, home) <= 96)
    if (mineHere && inv.bestTool(bot, 'pickaxe', 4) && (packFood >= 10 || bot.food >= 16) && world.dist2(m.cursor, bot.entity.position) < 150 && !cooling('nightMine')) return { name: 'nightMine', why: 'night - working the mine underground' }
    if (underground() && inv.bestTool(bot, 'pickaxe', 4) && !cooling('nightMine')) return { name: 'nightMine', why: 'night and already underground' }
    if (!cooling('bunker')) return { name: 'bunker', why: 'night, no bed in reach - digging in' }
    return { name: 'idle', why: 'night and no shelter worked - staying put, reflexes on guard' }
  }

  // 2. graves worth going back for
  const g = graves.bestGrave(bot)
  // going back for a grave empty-handed walks into whatever killed us: re-arm first (tools come next)
  if (g && !cooling('grave') && (inv.bestWeapon(bot) || world.dist3(g, bot.entity.position) < 10)) return { name: 'grave', why: `grave ${Math.round(world.dist2(g, bot.entity.position))}b away with ${g.items} items` }

  // 2b. carrying the base's furniture while standing at a finished safehouse: seconds of work that
  //     anchor spawn (a bed) and store the haul - before anything that is not an emergency
  if (home && dHome < 48 && bot.food > 8 && hut.shellComplete(bot) && furnishingInPack().length && !cooling('furnish')) return { name: 'furnish', why: `putting ${furnishingInPack().join(', ')} in the safehouse` }

  // 2c. seeds and no farm at this home: plant first (a minute of work; the food that never runs out)
  if (home && dHome < 64 && bot.food > 6 && (farm.farm() === null || !farm.farmIsHome(bot)) && (inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds')) >= 4 && !cooling('farm')) return { name: 'farm', why: 'seeds on hand and no farm at this home - planting before anything else' }

  // 3. hunger with nothing to eat (a full belly and an empty pack is not an emergency - animals met
  //    along the way top the pack up, and the farm feeds us long-term)
  if (packFood < 6 && bot.food <= 10 && !cooling('food')) return { name: 'food', why: `hungry (food ${bot.food}, pack ${packFood} pts)` }
  // health only comes back on a full belly (hunger >= 18): hurt + not full = food is the medicine
  if (bot.health < 12 && bot.food < 18 && packFood < 6 && !cooling('food')) return { name: 'food', why: `hurt (hp ${Math.round(bot.health)}) and hunger ${bot.food} - need food to heal` }
  // badly hurt, nothing to eat and the food search came back empty: don't wander about at 4 hp - wait
  // it out walled into the safehouse, stepping out only for crops as they ripen
  if (bot.health <= 8 && bot.food < 18 && packFood < 6 && cooling('food') && home && dHome < 220 && hut.shellComplete(bot) && !cooling('recover')) return { name: 'recover', why: `hp ${Math.round(bot.health)}, no food to be had - resting in the safehouse until crops ripen` }

  // 4. basic tools
  const kit = missingKit()
  if (kit.length && !cooling('tools')) return { name: 'tools', why: 'missing ' + kit.join(', ') }

  // 5. home
  if (!home) return { name: 'setHome', why: 'no home yet' }
  if (dHome > 96 && !cooling('goHome')) return { name: 'goHome', why: `${Math.round(dHome)}b from home` }

  // 5b. at home with a haul in the pack: put it in the chest (a player empties their pockets at home)
  if (dHome < 24 && (mem.get().chests || []).length && haulSize() >= 64 && !cooling('deposit')) return { name: 'deposit', why: `home with ${haulSize()} items to store` }

  // 5c. plant first (a minute of work, renewable food), then top up the food buffer while it is easy -
  //     starving first and searching second killed the bot twice
  if (dHome < 64 && (farm.farm() === null || !farm.farmIsHome(bot)) && (inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds')) >= 4 && !cooling('farm')) return { name: 'farm', why: 'seeds in hand and no farm at this home' }
  if (packFood < 12 && bot.food <= 12 && !cooling('food')) return { name: 'food', why: `food buffer low (pack ${packFood} pts, hunger ${bot.food})` }

  // 6. food: cook what we carry; harvest a ripe farm
  if (inv.rawFoodCount(bot) >= 3 && dHome < 64 && !cooling('cook')) return { name: 'cook', why: `${inv.rawFoodCount(bot)} raw food to cook` }
  if (farm.farm() && dHome < 64 && farm.ripeCount(bot) >= 8 && !cooling('harvest')) return { name: 'harvest', why: `${farm.ripeCount(bot)} wheat ripe` }

  // 7. base infrastructure - SHELTER FIRST: nothing of value (bed, bank) sits in the open, so the
  //    safehouse goes up before the bed and the chest go down inside it
  if (dHome < 64) {
    if (hut.collidesWithBuild(bot) && !cooling('relocate')) return { name: 'relocate', why: 'the safehouse stands on the build footprint - moving house' }
    if (!hut.complete(bot) && !cooling('hut')) { const s = hut.status(bot); return { name: 'hut', why: `the safehouse is ${s ? s.done + '/' + s.total : 'not started'}` } }
    if (hut.shellComplete(bot) && furnishingInPack().length && !cooling('furnish')) return { name: 'furnish', why: `putting ${furnishingInPack().join(', ')} in the safehouse` }
    if (!(mem.get().chests || []).length && !cooling('chest')) return { name: 'chest', why: 'no storage at home' }
    if (farm.farm() && farm.farmHome && !farm.farmIsHome(bot) && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 4 && !cooling('farm')) return { name: 'farm', why: 'the farm belongs to the old home - planting one here' }
    if (!bed && bedObtainable() && !cooling('bed')) return { name: 'bed', why: 'no bed - spawn is not anchored at home' }
    // a spare stone kit in the chest: a death respawns us beside it instead of sending us 100 blocks for logs
    if (dHome < 32 && SPARE_KIT.some(t => base.bankCount(t) < 1) && stock('cobblestone') >= 10 && !cooling('spareKit')) return { name: 'spareKit', why: 'no spare tools in the chest - making a set' }
    // light the ground around home: no mobs spawning at the door means nights asleep, not on guard
    if (dHome < 32 && world.phase(bot) === 'day' && world.tod(bot) < 10000 && !cooling('lightBase') && (inv.count(bot, 'torch') + base.bankCount('torch') >= 4 || inv.count(bot, 'coal') + base.bankCount('coal') + inv.count(bot, 'charcoal') >= 1)) {
      const dark = lights.darkSpots(bot).length
      if (dark >= 3) return { name: 'lightBase', why: `${dark} dark spots around home where mobs spawn` }
    }
    // a dry farm starves us: water it as soon as there is iron for a bucket
    if (farm.farmIsHome(bot) && farm.canHydrate(bot) && !cooling('hydrate')) return { name: 'hydrate', why: 'the farm is dry - bringing water to it' }
    if (farm.farmIsHome(bot) && farm.waterNeedsFixing(bot) && !cooling('fixWater')) return { name: 'fixWater', why: 'water is running over the crops - putting it back in its hole' }
    if (!farm.farm() && !cooling('farm')) return { name: 'farm', why: 'no farm - bread does not run out like animals do' }
    // a farm to walk: one soil level, nothing but crops on it (the operator asked for it clean and flat)
    if (farm.farm() && farm.farmIsHome(bot) && farm.farm().water && !farm.waterNeedsFixing(bot) && world.phase(bot) === 'day' && !farm.farmLevel(bot) && !cooling('levelFarm')) return { name: 'levelFarm', why: `the farm is uneven or cluttered (${farm.levelWork(bot).length} fixes)` }
    // a watered plot still at its starting size: widen it to everything the water reaches
    if (farm.farm() && farm.farmIsHome(bot) && farm.farm().water && farm.farm().cells.length < 60 && farm.farmLevel(bot) && farm.fullPlot(bot, farm.farm()).length > farm.farm().cells.length && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 8 && !cooling('farm')) return { name: 'farm', why: `the farm is ${farm.farm().cells.length} cells - widening it to all the water reaches` }
    if (farm.farm() && farm.farmIsHome(bot) && !farm.waterNeedsFixing(bot) && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 4 && farm.unplantedCount(bot) > 0 && !cooling('farm')) return { name: 'farm', why: `${farm.unplantedCount(bot)} farm cells unplanted and ${inv.count(bot, 'wheat_seeds')} seeds in hand` }
  }

  // 8. iron gear when the iron is on hand
  const iron = inv.count(bot, 'iron_ingot') + base.bankCount('iron_ingot')
  const raw = inv.count(bot, 'raw_iron') + base.bankCount('raw_iron')
  const wanted = ironWanted()
  if (wanted.length && !cooling('iron')) {
    const cheapest = wanted.map(n => IRON_COST[n]).sort((a, b) => a - b)[0]
    if (iron + raw >= cheapest) return { name: 'iron', why: `${iron} ingots + ${raw} raw iron - making ${wanted[0]}` }
  }

  // 9. the build
  // (with its own backoff: a castle step failing in 30ms was retried 26 times in a second)
  if (mem.get().build && build.getJob() && !mem.get().buildDone && !cooling('castle')) {
    return { name: 'castle', why: 'working on ' + mem.get().build.name }
  }
  return { name: 'idle', why: 'nothing to do' }
}

// ---- tasks --------------------------------------------------------------------------------
const TASKS = {
  async sleep () {
    // walled in before lying down: mobs at the door both stop the sleep and walk in while we try
    const bb = shelter.bedBlock(bot)
    if (bb && move.insideHut(bb.position)) {
      if (!move.insideHut(world.feetPos(bot))) await hut.enterHut(bot, { shouldStop: () => taskCancelled() })
      if (move.insideHut(world.feetPos(bot))) await hut.sealDoor(bot).catch(() => false)
    }
    const ok = await shelter.sleepInBed(bot, { shouldStop: () => taskCancelled() })
    if (!ok) log('dir', 'could not sleep in my bed')
    return ok
  },
  async hutNight () {
    const p = hut.getPlan(bot)
    if (!p) return false
    if (!await hut.enterHut(bot, { shouldStop: () => taskCancelled() })) { log('dir', "couldn't get inside the safehouse"); return false }
    // close the door behind us
    const d = world.at(bot, p.door.x, p.box.y1, p.door.z)
    try { if (d && /_door$/.test(d.name) && d.getProperties().open) await bot.activateBlock(d) } catch {}
    log('dir', 'inside the safehouse for the night')
    // a night indoors is the time to set the room straight
    if (furnishingInPack().length) { await TASKS.furnish().catch(e => log('dir', 'furnish threw: ' + e.message)) }
    // and the doorway walled up: a zombie on hard breaks the door
    if (move.insideHut(world.feetPos(bot))) await hut.sealDoor(bot).catch(e => log('dir', 'seal threw: ' + e.message))
    while (!shelter.morning(bot) && !taskCancelled()) {
      // the bed is in this room: keep trying to sleep (mobs close by make the server refuse for a while)
      const bedB = shelter.bedBlock(bot)
      if (bedB && world.isNight(bot) && !bot.isSleeping && world.dist3(bedB.position, bot.entity.position) < 5) {
        try { await bot.sleep(bedB); log('dir', 'asleep in the safehouse'); while (bot.isSleeping && !world.isDay(bot)) await move.sleep(2000) } catch {}
      }
      await move.sleep(4000)
    }
    return true
  },
  async sleepHere () {
    const before = mem.get().bed
    if (!await shelter.placeBed(bot, world.feetPos(bot))) return false
    const placed = mem.get().bed
    const ok = await shelter.sleepInBed(bot, { shouldStop: () => taskCancelled() })
    // morning: take the bed along unless this spot is home
    const home = mem.get().home
    if (placed && (!home || world.dist2(placed, home) > 12 || hut.collidesWithBuild(bot))) {
      await act.dig(bot, placed, { force: true, allowZones: ['base', 'build'] })
      await act.collectDrops(bot, { radius: 5, maxMs: 5000 })
      mem.set('bed', before && world.at(bot, before.x, before.y, before.z) && /_bed$/.test(world.at(bot, before.x, before.y, before.z).name) ? before : null)
    }
    return ok
  },
  async nightMine () {
    const st = build.status(bot)
    const want = st && st.need.stone_bricks ? 'cobblestone' : 'cobblestone'
    const target = inv.count(bot, want) + 256
    return mining.mineFor(bot, want, target, { seal: true, shouldStop: () => taskCancelled() || world.isDay(bot) })
  },
  async bunker () {
    return shelter.bunker(bot, { shouldStop: () => taskCancelled() })
  },
  async hideout () {
    const t0 = Date.now()
    if (!await hut.enterHut(bot, { shouldStop: () => taskCancelled() })) return false
    await hut.sealDoor(bot).catch(() => false)
    log('dir', `waiting inside while mobs are about (hp ${Math.round(bot.health)})`)
    while (!taskCancelled() && Date.now() - t0 < 4 * 60000) {
      const left = reflex.hostiles(20).filter(h => h.e.name !== 'bat' && Math.abs(h.e.position.y - bot.entity.position.y) < 6)
      const dim = world.phase(bot) !== 'day' || world.tod(bot) >= 23000 || world.tod(bot) < 1500
      if (!left.length || (!dim && bot.health > 10)) break
      // a bed right here: sleeping skips the rest of the night (the server refuses while monsters are
      // close - keep trying, walled in they drift off)
      const bedB = shelter.bedBlock(bot)
      if (bedB && world.isNight(bot) && world.dist3(bedB.position, bot.entity.position) < 4 && !bot.isSleeping) {
        try { await bot.sleep(bedB); log('dir', 'asleep in the safehouse'); while (bot.isSleeping && !world.isDay(bot)) await move.sleep(2000) } catch {}
      }
      await move.sleep(5000)
    }
    return true
  },
  async recover () {
    const t0 = Date.now()
    if (!await hut.enterHut(bot, { shouldStop: () => taskCancelled() })) return false
    await hut.sealDoor(bot).catch(() => false)
    log('dir', `resting in the safehouse (hp ${Math.round(bot.health)}, food ${bot.food})`)
    while (!taskCancelled() && Date.now() - t0 < 10 * 60000) {
      if (inv.foodPoints(bot) >= 6 || bot.food >= 18 || bot.health > 12) return true
      const ripe = farm.farm() ? farm.ripeCount(bot) : 0
      if (ripe >= 2 && world.phase(bot) === 'day' && !reflex.hostiles(16).length) {
        log('dir', `${ripe} wheat ripe - out to harvest it`)
        await farm.harvest(bot, { shouldStop: () => taskCancelled() })
        return true
      }
      await move.sleep(15000)
    }
    return true
  },
  async grave () {
    const g = graves.bestGrave(bot)
    const near = g && world.dist3(g, bot.entity.position) < 10
    const ok = await graves.recover(bot, g, { shouldStop: near ? () => taskCancelled() : dayStop })
    // a grave down in a cave: climb straight up before anything else sends us wandering through it (the next
    // task travelled 56 blocks through the cave from y-7 and died)
    if (move.isUnderground(bot)) await move.surface(bot).catch(() => false)
    return ok
  },
  async food () {
    return food.stockFood(bot, { targetPoints: 48, ctx: { shouldStop: dayStop } })
  },
  async cook () { await food.cookAll(bot, { shouldStop: dayStop }); return inv.rawFoodCount(bot) < 3 },
  async farm () { return farm.establish(bot, { shouldStop: dayStop }) },
  async hut () { return hut.buildHut(bot, { shouldStop: homewardStop }) },
  async deposit () { return base.depositAll(bot) },
  async furnish () {
    const home = mem.get().home
    const r = await base.goHome(bot, { shouldStop: homewardStop })
    if (!r.ok) return false
    let placed = 0
    for (const pos of misplacedFurniture()) {
      const b = world.at(bot, pos.x, pos.y, pos.z)
      log('dir', `picking up the ${b.name} at ${move.fmt(pos)} - it is in the way (walkway or stacked)`)
      if (/chest$/.test(b.name)) {
        // a chest spills its contents when broken: carry them, then put them back in the new spot
        const w = await base.openChest(bot, pos)
        if (w) { try { for (const it of w.containerItems()) { if (inv.freeSlots(bot) < 2) break; try { await w.withdraw(it.type, null, it.count) } catch {} } } finally { try { w.close() } catch {} } }
      }
      if (/furnace$/.test(b.name)) {
        // a furnace spills its input, fuel and output when broken: take them out first
        try {
          const f = await bot.openFurnace(bot.blockAt(new Vec3(pos.x, pos.y, pos.z)))
          try { if (f.outputItem()) await f.takeOutput() } catch {}
          try { if (f.inputItem()) await f.takeInput() } catch {}
          try { if (f.fuelItem()) await f.takeFuel() } catch {}
          f.close()
        } catch {}
      }
      await act.dig(bot, pos, { force: true, allowZones: ['base'] })
      await act.collectDrops(bot, { radius: 6, maxMs: 6000 })
      if (/_bed$/.test(b.name) && !shelter.hasBedItem(bot)) log('dir', 'the bed did not come back into the pack - looking for it')
      for (const k of ['chests', 'furnaces', 'tables']) mem.removePos(k, pos)
      if (/_bed$/.test(b.name)) mem.set('bed', null)
      placed++
    }
    const lay = hut.layout(bot)
    for (const what of furnishingInPack()) {
      if (what === 'bed') {
        const ok = lay && lay.bed ? await shelter.placeBedAt(bot, lay.bed) : await shelter.placeBed(bot, home)
        if (ok) { placed++; if (lay && lay.bed) hut.rememberBedSide(lay.bed.side) }
        continue
      }
      if (!/^(chest|furnace|crafting_table)$/.test(what)) continue
      // a side-wall slot of the room: never the walkway, never the bed's cells
      let done = false
      if (lay) {
        for (const c of lay.slots) {
          if (done) break
          const cell = world.at(bot, c.x, c.y, c.z); const up = world.at(bot, c.x, c.y + 1, c.z); const floor = world.at(bot, c.x, c.y - 1, c.z)
          if (!cell || !world.isAirish(cell) || /torch/.test(cell.name) || !up || !world.isAirish(up) || !floor || !world.isSolid(floor)) continue
          // the bed's stand cell stays free while a bed is still to come
          if (lay.bed && c.x === lay.bed.stand.x && c.z === lay.bed.stand.z && !shelter.bedBlock(bot) && lay.slots.some(s => s !== c && world.isAirish(world.at(bot, s.x, s.y, s.z) || { name: 'stone' }))) continue
          const me = world.feetPos(bot)
          if (me.x === c.x && me.z === c.z) {
            // step onto the walkway to place it
            await move.goTo(bot, new goals.GoalBlock(lay.walkway[0].x, lay.walkway[0].y, lay.walkway[0].z), { timeoutMs: 8000, dig: false, place: false })
          }
          if (await act.place(bot, c, what, { allowZones: ['base'] })) {
            done = true; placed++
            if (what === 'chest') mem.addUnique('chests', c)
            if (what === 'furnace') mem.addUnique('furnaces', c)
            if (what === 'crafting_table') mem.addUnique('tables', c)
            log('dir', `put the ${what} in the safehouse at ${move.fmt(c)}`)
          }
        }
      }
      if (!done) log('dir', `no free floor in the safehouse for the ${what}`)
    }
    return placed > 0
  },
  async relocate () { const ok = await hut.relocate(bot, { shouldStop: () => taskCancelled() }); if (ok) baseZone(); return ok },
  async spareKit () {
    for (const t of SPARE_KIT) {
      if (base.bankCount(t) >= 1) continue
      if (inv.count(bot, 'cobblestone') < 3) await base.withdraw(bot, 'cobblestone', 8)
      if (!await craft.ensure(bot, t, inv.count(bot, t) + 1, { noWithdraw: true, shouldStop: dayStop })) return false
      if (!await base.depositItem(bot, t, 1)) return false
    }
    return true
  },
  async lightBase () { return lights.lightBase(bot, { shouldStop: dayStop }) },
  async hydrate () { return farm.hydrate(bot, { shouldStop: dayStop }) },
  async levelFarm () { return farm.level(bot, { shouldStop: dayStop }) },
  async fixWater () { return farm.fixWater(bot, { shouldStop: dayStop }) },
  async harvest () { return farm.harvest(bot, { shouldStop: dayStop }) },
  async tools () {
    for (const t of missingKit()) {
      // a worn-out tool still counts as "held": ask for one more than we have
      const ok = await craft.ensure(bot, t, inv.count(bot, t) + 1, { shouldStop: dayStop })
      if (!ok) { log('dir', `couldn't make ${t}`); return false }
    }
    return true
  },
  async setHome () {
    const j = build.getJob()
    if (j && world.dist2(bot.entity.position, j.origin) > 64) {
      // the site has to be loaded to judge the ground: walk over first
      const r = await move.travel(bot, { x: j.origin.x - 8, y: j.origin.y, z: j.origin.z - 8 }, { range: 12, shouldStop: homewardStop, label: 'to build site' })
      if (!r.ok) return false
    }
    const h = chooseHome()
    if (!h) return false
    base.setHome(h)
    baseZone()
    adoptChests()
    return true
  },
  async goHome () {
    const r = await base.goHome(bot, { shouldStop: homewardStop })
    return r.ok
  },
  async chest () {
    const r = await base.goHome(bot, { shouldStop: homewardStop })
    if (!r.ok) return false
    return !!(await base.placeChest(bot))
  },
  async bed () {
    if (!shelter.hasBedItem(bot)) {
      const ok = await shelter.obtainBed(bot, { shouldStop: dayStop })
      if (!ok) return false
    }
    await base.goHome(bot, { shouldStop: homewardStop })
    // in the room's bed spot (the old free-spot placement put it in the walkway, where tidying
    // picked it straight back up)
    const lay = hut.layout(bot)
    if (lay && lay.bed && hut.shellComplete(bot)) {
      const ok = await shelter.placeBedAt(bot, lay.bed)
      if (ok) hut.rememberBedSide(lay.bed.side)
      return ok
    }
    return shelter.placeBed(bot, mem.get().home)
  },
  async iron () {
    // smelt raw iron, then craft the most valuable missing piece we can afford
    if (base.bankCount('raw_iron') > 0) await base.withdraw(bot, 'raw_iron', 64)
    if (base.bankCount('iron_ingot') > 0) await base.withdraw(bot, 'iron_ingot', 64)
    const raw = inv.count(bot, 'raw_iron')
    if (raw > 0) await smelt.smeltItem(bot, 'iron_ingot', raw, { noWithdraw: true })
    let made = 0
    for (const n of ironWanted()) {
      // shield and bucket come first: don't spend their ingots on something cheaper further down the list
      if (inv.count(bot, 'iron_ingot') < IRON_COST[n]) { if (n === 'shield' || n === 'bucket') break; continue }
      if (await craft.ensure(bot, n, 1, { noWithdraw: true })) { made++; await inv.wearBestArmor(bot) }
    }
    return made > 0
  },
  async castle () { return castleWork() },
  async idle () { await move.sleep(5000); return true }
}

// ---- the castle ---------------------------------------------------------------------------
const BULK_SOURCE = {
  stone_bricks: ['stone', 4], // 4 stone -> 4 bricks
  oak_planks: ['oak_log', 4],
  spruce_planks: ['spruce_log', 4],
  glass: ['sand', 1],
  stone: ['cobblestone', 1]
}

function stock (name) { return inv.count(bot, name) + base.bankCount(name) }
// a castle wood cell takes any wood of its kind (the operator's choice): stock/withdraw by class
function woodNamesHeld (cls) {
  const re = cls === 'log' ? build.LOG_ANY : build.PLANKS_ANY
  return [...new Set(Object.keys(inv.counts(bot)).concat(Object.keys(base.bankCounts())))].filter(n => re.test(n))
}
function stockOf (name) {
  const cls = build.woodClass(name)
  return cls ? woodNamesHeld(cls).reduce((t, n) => t + stock(n), 0) : stock(name)
}
async function withdrawOf (name, want) {
  const cls = build.woodClass(name)
  if (!cls) return base.bankCount(name) > 0 ? base.withdraw(bot, name, Math.min(want, base.bankCount(name))) : 0
  let got = 0
  for (const n of woodNamesHeld(cls).sort((a, b) => (b === name) - (a === name) || base.bankCount(b) - base.bankCount(a))) {
    if (got >= want) break
    if (base.bankCount(n) > 0) got += await base.withdraw(bot, n, Math.min(want - got, base.bankCount(n)))
  }
  return got
}
function countOf (name) { const cls = build.woodClass(name); return cls ? woodNamesHeld(cls).reduce((t, n) => t + inv.count(bot, n), 0) : inv.count(bot, name) }
// the nearest natural wood growing around here (what the castle's wood cells will be made of)
function nearestWood () {
  const t = world.findBlocks(bot, build.LOG_ANY, { maxDistance: 64, count: 8, filter: b => !move.inZone(b.position, 2) && !move.insideHut(b.position) })[0]
  return t ? t.name.replace('_log', '') : craft.preferredWood(bot, 1)
}

async function processAtHome () {
  // collect finished smelting, turn stone into bricks, keep the furnaces fed with cobble
  const home = mem.get().home
  const st = build.status(bot)
  if (!st) return
  await smelt.collectFurnaces(bot)
  await smelt.refuelFurnaces(bot)
  const bricksNeeded = st.need.stone_bricks || 0
  // fuel for the stone: charcoal made in the background from spare logs (one log smelts eight; the brick line
  // was stalling on fuel with cobble waiting in the chest)
  if (bricksNeeded > 0 && stock('coal') + stock('charcoal') < 32) {
    const spareLogs = Math.floor(smelt.woodSurplus(bot) / 4)
    const logName = woodNamesHeld('log').filter(n => stock(n) > 0).sort((a, b) => stock(b) - stock(a))[0]
    if (logName && spareLogs >= 4) {
      const n = Math.min(32, spareLogs, stock(logName))
      if (inv.count(bot, logName) < n) await base.withdraw(bot, logName, n - inv.count(bot, logName))
      const loaded = await smelt.loadFurnaces(bot, logName, Math.min(n, inv.count(bot, logName)))
      if (loaded) log('dir', `burning ${loaded} ${logName} into charcoal for the stone`)
    }
  }
  if (bricksNeeded > 0) {
    const stone = stock('stone')
    const bricksHave = stock('stone_bricks')
    const toMake = Math.min(bricksNeeded - bricksHave, stone)
    if (toMake >= 4) {
      if (inv.count(bot, 'stone') < toMake) await base.withdraw(bot, 'stone', toMake - inv.count(bot, 'stone'))
      const n = Math.floor(inv.count(bot, 'stone') / 4) * 4
      if (n >= 4) await craft.ensure(bot, 'stone_bricks', inv.count(bot, 'stone_bricks') + n, { noWithdraw: true })
    }
    // feed the furnaces: cobble beyond what the castle itself needs becomes stone
    const stoneShort = bricksNeeded - stock('stone_bricks') - stock('stone')
    const cobbleSpare = stock('cobblestone') - (st.need.cobblestone || 0) - 16
    const load = Math.min(stoneShort, cobbleSpare)
    // a row of six furnaces while bricks are still wanted: one furnace is 3.6 hours of stone for this castle
    {
      // counted around HOME (counted around the bot at the castle site it found too few and built six more)
      const furns = home ? world.findBlocks(bot, /^furnace$/, { maxDistance: 16, count: 32, point: new Vec3(home.x, home.y, home.z) }) : smelt.furnacesNear(bot, 32)
      for (let i = furns.length; i < 6 && stock('cobblestone') >= 8; i++) {
        if (inv.count(bot, 'cobblestone') < 8) await base.withdraw(bot, 'cobblestone', 8)
        if (!await smelt.placeFurnace(bot)) break
      }
    }
    if (load > 0) {
      if (inv.count(bot, 'cobblestone') < load) await base.withdraw(bot, 'cobblestone', Math.min(load, 64 * 6) - inv.count(bot, 'cobblestone'))
      const fuelNeed = Math.min(load, inv.count(bot, 'cobblestone'))
      await smelt.pickFuel(bot, fuelNeed)
      await smelt.loadFurnaces(bot, 'cobblestone', Math.min(load, inv.count(bot, 'cobblestone')))
    }
  }
  // glass the same way: banked sand into the furnaces, collected on a later pass (waiting at the furnace for
  // it cost minutes, then the castle turn "failed" and the bot stood idle through its cooldown)
  {
    const glassShort = (st.need.glass || 0) - stock('glass') - smelt.inFlight('glass')
    const sand = Math.min(glassShort, stock('sand'))
    if (sand > 0) {
      if (inv.count(bot, 'sand') < sand) await base.withdraw(bot, 'sand', sand - inv.count(bot, 'sand'))
      const k = Math.min(sand, inv.count(bot, 'sand'))
      if (k > 0 && await smelt.pickFuel(bot, k)) await smelt.loadFurnaces(bot, 'sand', k)
    }
  }
  // planks from logs (only what the castle still needs). Logs are held back only for the log cells of the
  // next few layers - reserving every log the whole castle will ever need meant no planks were ever made
  const j = build.getJob()
  const lowest = j.cells.filter(c => build.cellDone(bot, c) !== true)
  const minY = lowest.length ? Math.min(...lowest.map(c => c.y)) : 0
  const logsSoon = lowest.filter(c => c.y <= minY + 3 && build.woodClass(c.name) === 'log').length
  // planks for the castle's plank cells from any logs beyond the log cells coming up (local wood)
  {
    const planksNeed = Object.entries(st.need).filter(([n]) => build.woodClass(n) === 'planks').reduce((t, [, v]) => t + v, 0) - stockOf('oak_planks')
    const logsSpare = stockOf('oak_log') - logsSoon
    const crafts = Math.min(Math.ceil(planksNeed / 4), logsSpare)
    if (crafts > 0) {
      let left = crafts
      for (const n of woodNamesHeld('log').sort((x, y) => stock(y) - stock(x))) {
        if (left <= 0) break
        if (inv.count(bot, n) < Math.min(left, stock(n))) await base.withdraw(bot, n, Math.min(left, stock(n)) - inv.count(bot, n))
        const k = Math.min(left, inv.count(bot, n))
        if (k > 0 && await craft.plankUp(bot, n, k)) left -= k
      }
    }
  }

}

async function castleWork () {
  const j = build.getJob()
  const st = build.status(bot)
  if (st.done >= st.total) { log('dir', `castle complete: ${st.done}/${st.total}`); await build.clearSite(bot, { finishing: true, shouldStop: dayStop }); await build.removeScaffold(bot); await build.ensureScaffold(bot, 32).catch(() => {}); await build.finishSite(bot, { shouldStop: dayStop }); mem.update(m => { m.buildDone = true }); return true }
  const home = mem.get().home
  if (world.dist2(bot.entity.position, j.origin) > 64) {
    const r = await move.travel(bot, home || j.origin, { range: 4, shouldStop: homewardStop, label: 'to site' })
    if (!r.ok) return false
  }
  // what does the next stretch of building need?
  const lowest = j.cells.filter(c => build.cellDone(bot, c) !== true)
  const minY = Math.min(...lowest.map(c => c.y))
  // site prep for the band being built only (next 3 layers + headroom): the rest of the footprint
  // is cleared as the walls rise, from the walls - never a whole day on a canopy 12 blocks up.
  // Leaves don't block building unless they sit in a cell; walking cuts through them.
  const bandTop = minY + 4
  const obs = build.unskippedObstructions(bot, { maxY: bandTop }).filter(b => !world.LEAF_RE.test(b.name) || j.index.has(build.key(b.position))).length
  if (obs > 0) {
    await build.ensureScaffold(bot, 32)
    const n = await build.clearSite(bot, { shouldStop: dayStop, maxBlocks: 200, maxY: bandTop })
    if (n > 0) { if (inv.freeSlots(bot) < 10) await base.depositAll(bot); return true }
    // nothing clearable right now: get on with materials meanwhile
  }
  await processAtHome()
  const next = {}
  // the same window the builder works in (it builds up to 3 layers past a missing material, so the bricks for
  // those layers must come out of the chest too - with glass short, nothing was withdrawn and nothing built)
  for (const c of lowest) if (c.y <= minY + 4) next[c.name] = (next[c.name] || 0) + 1
  // withdraw what we have for it
  let carrying = 0
  for (const [name, n] of Object.entries(next)) {
    const want = Math.min(n, 64 * 4) - countOf(name)
    if (want > 0) carrying += await withdrawOf(name, want)
    carrying += countOf(name)
  }
  let blockedOn = null
  if (carrying > 0) {
    await build.ensureScaffold(bot, 32)
    const r = await build.buildStep(bot, { shouldStop: dayStop, maxMs: 8 * 60000 })
    log('dir', `build step: placed ${r.placed}${r.blockedOn ? ', waiting on ' + r.blockedOn : ''}`)
    blockedOn = r.blockedOn
    if (r.placed > 0 && !r.blockedOn) return true
  }
  // gather: the material the builder is blocked on first, else the scarcest of the next stretch
  // what's cooking in the furnaces is on its way - go after the next shortage meanwhile
  const deficits = Object.entries(next).map(([name, n]) => ({ name, short: n - stockOf(name) - smelt.inFlight(name) })).filter(d => d.short > 0)
  if (!deficits.length) return true
  deficits.sort((a, b) => (b.name === blockedOn) - (a.name === blockedOn) || b.short - a.short)
  // a mine trip needs a working day ahead of it: close to dusk, gather something near home instead (a walk
  // to the mine face that arrived as dusk fell was a minute and a half for nothing)
  const nearDusk = world.ticksUntilNight(bot) < 2400
  const isMining = n => /^(stone_bricks|stone|cobblestone)$/.test(n)
  const d = nearDusk ? deficits.find(x => !isMining(x.name)) : deficits[0]
  if (!d) { log('dir', 'dusk is close - no mine trip now'); return false }
  log('dir', `castle needs ${d.short} more ${d.name} for the next layers (stock ${stockOf(d.name)})`)
  const ok = await gatherFor(d.name, d.short)
  if (inv.freeSlots(bot) < 8 || ok) await base.depositHaul(bot, { shouldStop: dayStop })
  return ok
}

async function gatherFor (name, short) {
  const batch = Math.min(short, 128)
  switch (name) {
    case 'stone_bricks':
    case 'stone': {
      // no fuel and no spare wood to make it from: logs first (trees are a short walk, the mine is not)
      if (stock('coal') + stock('charcoal') < 8 && smelt.woodSurplus(bot) < 32) {
        const w = nearestWood() + '_log'
        log('dir', 'no fuel for the stone - cutting logs for charcoal first')
        await craft.ensure(bot, w, inv.count(bot, w) + 24, { shouldStop: dayStop, noWithdraw: true })
        return true
      }
      // cobble now; the furnaces make it stone in the background
      const r = await mining.mineFor(bot, 'cobblestone', inv.count(bot, 'cobblestone') + Math.min(256, batch + 32), { shouldStop: dayStop })
      return r
    }
    case 'cobblestone': return mining.mineFor(bot, 'cobblestone', inv.count(bot, 'cobblestone') + batch, { shouldStop: dayStop })
    default:
      if (build.woodClass(name)) {
        // whatever wood grows nearest (the castle's oak/spruce cells take local wood)
        const w = nearestWood() + '_log'
        const logs = build.woodClass(name) === 'log' ? Math.min(batch, 64) : Math.min(Math.ceil(batch / 4), 64)
        return craft.ensure(bot, w, inv.count(bot, w) + logs, { shouldStop: dayStop, noWithdraw: true })
      }
      return craft.ensure(bot, name, inv.count(bot, name) + Math.min(batch, 64), { shouldStop: dayStop })
    case 'glass': {
      // sand is the gathering; the furnaces turn it into glass in the background (processAtHome)
      const sandShort = Math.min(batch, 48) - stock('sand')
      if (sandShort <= 0) { await processAtHome(); return smelt.inFlight('glass') > 0 }
      return craft.ensure(bot, 'sand', inv.count(bot, 'sand') + sandShort, { shouldStop: dayStop })
    }
  }
}

// ---- loop ---------------------------------------------------------------------------------
async function loop () {
  for (;;) {
    try {
      if (!bot.entity || bot.health <= 0 || paused) { current = null; await move.sleep(1000); continue }
      await reflex.waitClear()
      try { await opportunisticHunt() } catch (e) { log('dir', 'hunt threw: ' + e.message) }
      const d = decide()
      const k = d.name + '|' + d.why
      if (k !== lastDecisionKey) { lastDecisionKey = k; log('dir', `-> ${d.name}: ${d.why}`) }
      current = { name: d.name, why: d.why, since: Date.now() }
      const fn = TASKS[d.name]
      let ok = false
      taskCancelled = control.token()
      running = true
      try { ok = await fn() } catch (e) { log('dir', `${d.name} threw: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message}`) }
      running = false
      if (taskCancelled()) { current = null; continue }
      // A task that "succeeds" instantly while the same decision keeps coming back did nothing: a
      // decision must produce an action. Count it as a failure so the chooser moves on.
      const took = Date.now() - current.since
      if (ok && took < 800 && k === lastInstantKey) instantRepeats++
      else { instantRepeats = 0; lastInstantKey = ok && took < 800 ? k : '' }
      if (instantRepeats >= 10) { log('dir', `${d.name} keeps returning at once without changing anything - backing off it`); ok = false; instantRepeats = 0 }
      note(d.name, !!ok)
      if (override === d.name) override = null
      if (!ok) { log('dir', `${d.name} did not succeed (${failures[d.name] ? failures[d.name].n : 0} in a row)`); await move.sleep(1500) }
      await move.sleep(150)
    } catch (e) {
      log('dir', 'loop error: ' + e.message)
      await move.sleep(3000)
    }
  }
}

async function start (b) {
  bot = b
  baseZone()
  const bj = mem.get().build
  if (bj) { try { await build.setJob(bot, bj.name, bj.origin) } catch (e) { log('dir', `couldn't load build ${bj.name}: ${e.message}`) } }
  loop()
}

function info () { return current ? { name: current.name, detail: current.why, forSec: Math.round((Date.now() - current.since) / 1000) } : null }
function setPaused (p) { const was = paused; paused = !!p; if (paused) { control.abort(); move.stopMoving(bot) } if (was !== paused) log('dir', paused ? 'paused' : 'resumed') }
async function waitIdle (maxMs = 30000) { const t0 = Date.now(); while (running && Date.now() - t0 < maxMs) await move.sleep(200) }
function forceTask (name) { if (!TASKS[name]) return false; override = name; control.abort(); return true }

module.exports = { start, info, setPaused, forceTask, decide, TASKS, waitIdle, isPaused: () => paused }
