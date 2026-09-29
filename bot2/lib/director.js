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
const day = require('./day')
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
const mats = require('./materials')
const clay = require('./clay')
const forage = require('./forage')
const boat = require('./boat')
const orchard = require('./orchard')
const pen = require('./pen')
const litter = require('./litter')
let litterSeeded = false // (the pillars from before the ledger: looked for once a run, once the orchard's zone is set)
const LITTER_BATCH = 8
let steerSaid = null // (the wait-without-raw line, once per item)
let siteTidyAsked = 0 // (when the site's scaffold was last counted for the day's teardown)
const LITTER_CAP = 48 // (our own blocks standing round home past which the tidy goes before the castle)

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
// Regeneration is on the cards: the food bar is there, or we carry food to put it there (the reflex eats when hurt).
// A mob on the surface - at or over the top ground of its column (leaves and logs are not ground): what can walk to
// the door or shoot at it. One in the caves under the mountain is not: cave skeletons 17-24 blocks off kept the bot
// in the safehouse a whole morning, in daylight, the build standing still (2026-09-26).
const onSurface = e => reflex.onSurface(e) // (one rule: reflex.js - the door seal asks the same question)
const BREAD_WANTED = 32
function breadStock () { return inv.count(bot, 'bread') + base.bankCount('bread') + Math.floor((inv.count(bot, 'wheat') + base.bankCount('wheat')) / 3) }
function canHeal () { return bot.food >= inv.REGEN_FOOD || inv.foodItems(bot, { hurt: true }).length > 0 }
// At the reflex's hurt line with a way to heal: whatever we are out doing ends here (two deaths on 2026-09-23 began
// with a trip started or carried on at hp 9-13, unarmoured, into a skeleton)
function tooHurt () { return bot.health <= reflex.hurtLine() && canHeal() }
// Home by dark: a day trip ends while the daylight left still covers the walk home (and the climb out of the mine) - the
// dusk stop alone ended mining trips 100 blocks out and 100 down at dusk and the walk home was in the dark: two skeleton
// deaths on the way in a night (2026-09-25). The same rule as clay's turn-back (world.walkTicks + HOME_MARGIN).
const DAYLIGHT_TICKS = 12000 // (tod 0..12000: the working day)
function homeByDark () {
  const h = mem.get().home
  if (!h || !bot.entity || world.phase(bot) !== 'day') return false
  const walk = world.walkTicks(bot.entity.position, h)
  // further out than half a day's walk is no day trip: the night is spent out whatever we do, the bunker covers it.
  // Respawned 2200 blocks out, every task stopped the moment it began - no tools, no food - and the bot walked the
  // whole way unarmed at half health into a river of drowned (2026-09-27)
  if (walk > DAYLIGHT_TICKS / 2) return false
  // (already home - a few steps off - there is no walk to be caught out on: the margin for the way home cut the day's last
  //  1800 ticks at the farm's own edge, and every chore chosen then stopped the moment it began - the farm, the yard,
  //  four times over, 2026-09-28. The dusk stop ends them when the evening comes)
  if (world.dist3(bot.entity.position, h) < 24) return false
  // (a short walk - the build site next door - needs no margin cut from the day: the dusk rule walks the bot to its bed from
  //  anywhere within 200. The margin's 1800 ticks are for the long ways home, a mine's climb: at the site 47b off they
  //  ended the castle's day 105s early, of a 600s working day, 2026-09-28)
  if (world.dist3(bot.entity.position, h) < 64) return false
  return world.ticksUntilNight(bot) < walk + world.HOME_MARGIN
}
let taskCancelled = () => false
function dayStop () { return taskCancelled() || nightSoon() || tooHurt() || homeByDark() }
// heading home: keep walking through dusk; only real night (mobs) stops a trip that is still long
// (and at the hurt line, when food would mend it or might be found: at hp 4 the trek walked on into a river and drowned,
//  2026-09-27 - the director heals or finds food first)
function hutNearlyUp () { const s = hut.status(bot); return !!s && s.done >= s.total * 0.9 }
function homewardStop () { return taskCancelled() || (world.isNight(bot) && (!mem.get().home || world.dist2(bot.entity.position, mem.get().home) > 48)) || tooHurt() } // (tooHurt: the one hurt rule - at hp 4 the trek walked on into a river and drowned, 2026-09-27)
// Deep under the ground HERE - eight blocks of rock over the head, as a mine or a cave is. Measured against home's height
// it called any roofed hole 2000 blocks from home at sea level "underground": the night's bunker (two deep) became a
// night mine, and the bot walked out into a creeper and three zombies in two minutes (2026-09-27).
function underground () {
  const p = world.feetPos(bot)
  if (world.openSky(bot, p)) return false
  let rock = 0
  for (let y = p.y + 2; y <= p.y + 40 && rock < 8; y++) { const b = world.at(bot, p.x, y, p.z); if (!b) return false; if (world.isSolid(b)) rock++ }
  return rock >= 8
}

function note (name, ok) {
  if (ok) delete failures[name]
  else { const f = failures[name] || (failures[name] = { n: 0, at: 0 }); f.n++; f.at = Date.now() }
}
// A task that just failed steps aside until the world changes (time passing is the change here:
// position, daylight, inventory differ after other work). Backoff grows with repeated failure.
// THE DAY'S CHORES run under dayStop: offered while that stop already holds, each began and refused at once - "did not
// succeed" four times over, the watchdog's alarm, a backoff for nothing (late in the day, 25-64 from home; audit
// 2026-09-28). One gate: a day chore whose stop holds waits, said once. (Survival - food, graves, tools, the bed - is
// never held here; the castle's step does its home work first and minds its own stop.)
const DAY_TASKS = new Set(['farm', 'harvest', 'hydrate', 'levelFarm', 'levelYard', 'fixWater', 'lightBase', 'plant', 'pen', 'spareKit', 'fillShaft', 'cook', 'ironTrip', 'tidy', 'siteTidy'])
const lateSaid = new Map()
// held(name): may decide() offer it now? Not while backing off from failures (cooling), nor a day chore once its stop holds.
// (cooling keeps its one meaning - "it failed recently": the recover rule reads cooling('food') as that evidence; audit)
function held (name) {
  if (DAY_TASKS.has(name) && dayStop()) {
    if (Date.now() - (lateSaid.get(name) || 0) > 10 * 60000) { lateSaid.set(name, Date.now()); log('dir', `late in the day - ${name} waits for the morning`) }
    return true
  }
  return cooling(name)
}
function cooling (name) {
  const f = failures[name]
  if (!f) return false
  return Date.now() - f.at < Math.min(15 * 60000, 30000 * Math.pow(2, Math.min(f.n - 1, 5)))
}

const TOOL_KIT = ['stone_pickaxe', 'stone_axe', 'stone_sword']
const SPARE_KIT = base.SPARE_KIT // (base.js: the one definition - the bank reserves exactly these)

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
  const out1 = hut.doorApronStep(p) // (the door apron: hut.js's one rule, the placer's too)
  if (out1) {
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
  // a crafting table rides in the pack: a pickaxe worn out at y78 with 251 cobblestone and 21 sticks in the pack could not
  // be replaced - no wood down there for a table - and the bot dug 10 blocks up by hand, 7.5s each (2026-09-27)
  if (!inv.has(bot, 'crafting_table')) out.push('crafting_table')
  // a stack of filler: the tower out of a pit, the planner's step up, the wall against a shooter - all of them survival, and
  // nothing put it back once the foundation and the scaffold had spent it: trapped in a shaft with none, 2026-09-28; audit
  // (at home only - before the bot goes out: at the site the builder keeps its own stock of the same filler, and a kit rule
  //  firing mid-castle walked it home for a top-up; audit)
  if (base.distHome(bot) < 24 && inv.items(bot).filter(i => build.FILLER_ITEMS.test(i.name)).reduce((n, i) => n + i.count, 0) < 16) out.push('filler')
  // a boat, once the land here has been found to need one (stood at the water with none, and swam: drowned killed it
  // swimming to the sand on an islet, 2026-09-23) - made at home with the tools, carried like them
  if (mem.get().wantBoat && !require('./boat').boatItem(bot)) out.push(craft.preferredWood(bot, 5) + '_boat')
  // the bow and its arrows, when the chest holds them: shooters are shot back, not walked into (two bows and fifteen
  // arrows sat in the chest while a pillager patrol camped the safehouse, 2026-09-25)
  // (only within the chest's reach: far out, "missing" a bow at home beat the walk home ten times over, audit #23)
  const bankNear = mem.get().home && bot.entity && world.dist2(bot.entity.position, mem.get().home) <= 64
  if (bankNear && !inv.has(bot, 'bow') && base.bankCount('bow') > 0) out.push('bow')
  if (bankNear && inv.count(bot, 'arrow') < 16 && base.bankCount('arrow') > 0) out.push('arrow')
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
  // (and a farm whose water is lost: without a bucket it can't be put back - the plot dried to grass, 2026-09-26)
  if (f && (!f.water || farm.waterNeedsFixing(bot)) && !inv.has(bot, 'bucket') && !inv.has(bot, 'water_bucket') && base.bankCount('bucket') === 0 && base.bankCount('water_bucket') === 0) out.push('bucket')
  if (rank(w.torso) < 4) out.push('iron_chestplate')
  if (rank(w.legs) < 4) out.push('iron_leggings')
  if (rank(w.head) < 4) out.push('iron_helmet')
  if (rank(w.feet) < 4) out.push('iron_boots')
  if (inv.toolTier(bot, 'pickaxe') < 3) out.push('iron_pickaxe')
  if (inv.toolTier(bot, 'sword') < 3) out.push('iron_sword')
  // shears last, after the body's gear: two ingots, and wool is shorn (1-3 a sheep, grown back) not killed for (1, and the
  // flock gone) - the castle's wool trips killed the sheep round home and explored 176 blocks out for more, 2026-09-29.
  // Never a reason for an ore trip (not ARMOUR_GEAR); leaves cut with them too
  if (!inv.has(bot, 'shears') && base.bankCount('shears') === 0) out.push('shears')
  return out
}
const IRON_COST = { shield: 1, bucket: 3, iron_chestplate: 8, iron_leggings: 7, iron_helmet: 5, iron_boots: 4, iron_pickaxe: 3, iron_sword: 2, shears: 2 }
// the pieces that stand between the body and a mob (a trip is made for these; tools and the bucket wait for iron)
const ORE_METHOD = 'vein'
const ARMOUR_GEAR = new Set(['shield', 'bucket', 'iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots'])
function ironStock () { return inv.count(bot, 'iron_ingot') + base.bankCount('iron_ingot') + inv.count(bot, 'raw_iron') + base.bankCount('raw_iron') }
function gearIronShort () {
  const need = ironWanted().filter(n => ARMOUR_GEAR.has(n)).reduce((a, n) => a + IRON_COST[n], 0)
  const have = inv.count(bot, 'iron_ingot') + base.bankCount('iron_ingot') + inv.count(bot, 'raw_iron') + base.bankCount('raw_iron')
  return Math.max(0, need - have)
}

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
  // the field is ours too: dirt for scaffold was dug out of it - cells gone to air, others buried, "0 just now"
  // planted for an hour (2026-09-23). Gathering keeps out of zones; the farm's own digs pass allowZones farm.
  // (a watered farm owns all the ground its water hydrates - farm.area, the square levelling works on - not the box
  //  round the cells planted today: the soil just outside that box was dug for scaffold dirt and walked through, the
  //  cells over it dropped, the box shrank and the next ring went - 21 cells down to 12 round a pocked pond by
  //  Notre-Dame, 2026-09-24)
  const f = mem.get().farm
  const a = f && farm.area ? farm.area(f) : null
  if (a) move.setZone('farm', a)
  else if (f && f.cells && f.cells.length) {
    const xs = f.cells.map(c => c.x); const ys = f.cells.map(c => c.y); const zs = f.cells.map(c => c.z)
    move.setZone('farm', { x1: Math.min(...xs), y1: Math.min(...ys) - 1, z1: Math.min(...zs), x2: Math.max(...xs), y2: Math.max(...ys) + 2, z2: Math.max(...zs) })
  } else move.setZone('farm', null)
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
  const around = reflex.hostiles(20).filter(h => h.e.name !== 'bat' && Math.abs(h.e.position.y - bot.entity.position.y) < 6 && onSurface(h.e))
  const dim = world.phase(bot) !== 'day' || world.tod(bot) >= 23000 || world.tod(bot) < 1500
  // (by day too when shooters stand round home and the body can't take their arrows - no shield, little armour: a
  //  pillager patrol and two skeletons shot the bot four times in two minutes, each respawn walking back out to the
  //  grave, the farm, the tool chest, 2026-09-25)
  const outgunned = around.some(h => reflex.RANGED.has(h.e.name)) && !inv.offhandShield(bot) && inv.armorPoints(bot) < 8 && !reflex.bowReady()
  if (around.length && home && dHome < 48 && hut.shellComplete(bot) && (dim || outgunned || bot.health <= reflex.hurtLine()) && !held('hideout')) {
    return { name: 'hideout', why: `${around.length} hostile${around.length > 1 ? 's' : ''} around home (${around.slice(0, 3).map(h => h.e.name).join(', ')}) - waiting inside` }
  }
  // evening: be home before dusk, not at it - a 100-block walk begun at dusk arrives in the dark (a zombie
  // met the bot at its own door at hp 10)
  // (never on an expedition out: the nights are camped - walked home each evening, it never got past a day's walk out;
  //  audit 2026-09-28)
  if (home && world.phase(bot) === 'day' && world.tod(bot) >= 10500 && world.tod(bot) < 12000 && dHome > 32 && hut.shellComplete(bot) && !tooHurt() && !(expedition() && expedition().phase === 'out') && !held('goHome')) {
    return { name: 'goHome', why: `evening - home is ${Math.round(dHome)}b away, back before dark` }
  }
  // a grave right here (died in the safehouse, or beside it): pick it up whatever the hour - it
  // despawns, and it is a few steps - but not into the mob that put it there
  {
    const g0 = graves.bestGrave(bot)
    if (g0 && world.dist3(g0, bot.entity.position) < 10 && !around.some(h => h.d < 16) && !held('grave')) return { name: 'grave', why: `my grave is ${Math.round(world.dist3(g0, bot.entity.position))}b away - ${g0.items} items` }
  }

  // 1. night
  if (night || dusk) {
    // at dusk walk to the bed from anywhere near; once it is dark only if the bed is a few steps away
    // (a night walk home from the mine ended in a skeleton fight and a death 12 blocks from the bed)
    // (ONE night walk limit, for the bed and the mine alike: a 43b walk to the mine in the dark - the bed unreachable, the
    //  builder's walls round it - met two creepers, a witch and a skeleton, and died with an iron pickaxe, 2026-09-28)
    const nightWalk = dusk ? Infinity : 32
    if (bed && world.dist2(bed, bot.entity.position) < (dusk ? 200 : 32) && !held('sleep')) return { name: 'sleep', why: `${night ? 'night' : 'dusk'} - my bed is ${Math.round(world.dist2(bed, bot.entity.position))}b away` }
    // a working mine next to home turns the night into mining time: go down at dusk (a short walk)
    {
      const mm = mem.get().mine
      const mineReady = mm && mm.entrance && home && world.dist2(mm.entrance, home) < 48 && inv.bestTool(bot, 'pickaxe', 8) && (packFood >= 10 || bot.food >= 18)
      if (mineReady && (dusk || !move.insideHut(world.feetPos(bot))) && world.dist2(bot.entity.position, mm.entrance) < Math.min(64, nightWalk) && !held('nightMine')) return { name: 'nightMine', why: `${night ? 'night' : 'dusk'} - mining through the night in the mine next to home` }
    }
    // inside the safehouse with furniture in the pack: set it up (the bed means sleeping, not waiting)
    if (move.insideHut(world.feetPos(bot)) && furnishingInPack().length && !held('furnish')) return { name: 'furnish', why: `night in the safehouse - putting ${furnishingInPack().join(', ')} down` }
    // no bed placed but the safehouse stands: spend the night inside it
    if (home && dHome < 160 && hut.shellComplete(bot) && !shelter.hasBedItem(bot) && !held('hutNight')) return { name: 'hutNight', why: `${night ? 'night' : 'dusk'} - sheltering in the safehouse` }
    // carrying a bed (travelling, moving house): put it down and sleep - it skips the night
    if (shelter.hasBedItem(bot) && !held('sleepHere')) return { name: 'sleepHere', why: `${night ? 'night' : 'dusk'} - sleeping in the bed i carry` }
    // dusk and home (or the site that will be home) is within a short walk: get there, dig in there
    if (dusk) {
      const j = build.getJob()
      if (!home && j && world.dist2(bot.entity.position, j.origin) < 220 && world.dist2(bot.entity.position, j.origin) > 40 && !held('setHome')) return { name: 'setHome', why: `dusk - the build site is ${Math.round(world.dist2(bot.entity.position, j.origin))}b away, getting there before dark` }
      if (home && dHome > 24 && dHome < 220 && !tooHurt() && !held('goHome')) return { name: 'goHome', why: `dusk - home is ${Math.round(dHome)}b away` }
    }
    const m = mem.get().mine
    const mineHere = m && (!home || world.dist2(m.entrance, home) <= 96)
    if (mineHere && inv.bestTool(bot, 'pickaxe', 4) && (packFood >= 10 || bot.food >= 16) && world.dist2(m.cursor, bot.entity.position) < 150 && (dusk || underground() || world.dist2(m.entrance, bot.entity.position) < nightWalk) && !held('nightMine')) return { name: 'nightMine', why: 'night - working the mine underground' }
    if (underground() && inv.bestTool(bot, 'pickaxe', 4) && !held('nightMine')) return { name: 'nightMine', why: 'night and already underground' }
    // afloat at night (a walk that ended in the sea): no bunker is dug in water and "staying put" there is treading
    // water until something drowns us - make for land (by boat when it is far)
    if ((boat.swimming(bot) || boat.inBoat(bot)) && !held('ashore')) return { name: 'ashore', why: 'night and afloat - making for land' }
    if (!held('bunker')) return { name: 'bunker', why: 'night, no bed in reach - digging in' }
    return { name: 'idle', why: 'night and no shelter worked - staying put, reflexes on guard' }
  }

  // 1b. hurt: heal before going anywhere. At home a player tops up before heading out (regeneration: a point every
  //     4s on a full bar - a minute in the safehouse, not a trip at hp 13 into a skeleton); away, a trip that has
  //     reached the hurt line stops and heals (home, when it is near).
  // (and out on an expedition, whole before going on: healed to just past the hurt line, it walked on at hp 7 with a
  //  pillager shooting, 700b from home - 2026-09-28)
  if (bot.health < 20 && canHeal() && (dHome < 24 || tooHurt() || (expedition() && bot.health < EXPEDITION_HP)) && !held('heal')) return { name: 'heal', why: `hp ${Math.round(bot.health)}${tooHurt() ? ' (at the hurt line ' + Math.round(reflex.hurtLine() * 10) / 10 + ')' : ''} - healing before going on` }

  // 2. graves worth going back for
  const g = graves.bestGrave(bot)
  // going back for a grave empty-handed walks into whatever killed us: re-arm first (tools come next)
  // (not back into what killed us: a shooter covering the grave or a creeper at it is still there - the second walk into the
  //  skeleton valley fell 13 blocks and fought at hp 11, 2026-09-28; the grave waits for the ground to clear; audit)
  const graveCovered = g0 => Object.values(bot.entities).some(e => e && e.position && ((reflex.RANGED.has(e.name) && e.position.distanceTo(g0) < 20) || (e.name === 'creeper' && e.position.distanceTo(g0) < 12)))
  if (g && !held('grave') && (inv.bestWeapon(bot) || world.dist3(g, bot.entity.position) < 10) && !graveCovered(g)) return { name: 'grave', why: `grave ${Math.round(world.dist2(g, bot.entity.position))}b away with ${g.items} items` }

  // 2b. carrying the base's furniture while standing at a finished safehouse: seconds of work that
  //     anchor spawn (a bed) and store the haul - before anything that is not an emergency
  if (home && dHome < 48 && bot.food > 8 && hut.shellComplete(bot) && furnishingInPack().length && !held('furnish')) return { name: 'furnish', why: `putting ${furnishingInPack().join(', ')} in the safehouse` }

  // 2c. seeds and no farm at this home: plant first (a minute of work; the food that never runs out)
  if (home && dHome < 64 && bot.food > 6 && (farm.farm() === null || !farm.farmIsHome(bot)) && (inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds')) >= 4 && !held('farm')) return { name: 'farm', why: 'seeds on hand and no farm at this home - planting before anything else' }

  // 3. hunger with nothing to eat (a full belly and an empty pack is not an emergency - animals met
  //    along the way top the pack up, and the farm feeds us long-term)
  if (packFood < 6 && bot.food <= 10 && !held('food')) return { name: 'food', why: `hungry (food ${bot.food}, pack ${packFood} pts)` }
  // health only comes back on a full belly (hunger >= 18): hurt + not full = food is the medicine
  if (bot.health < 12 && bot.food < inv.REGEN_FOOD && packFood < 6 && !held('food')) return { name: 'food', why: `hurt (hp ${Math.round(bot.health)}) and hunger ${bot.food} - need food to heal` }
  // badly hurt, nothing to eat and the food search came back empty: don't wander about at 4 hp - wait
  // it out walled into the safehouse, stepping out only for crops as they ripen
  if (bot.health <= 8 && bot.food < inv.REGEN_FOOD && packFood < 6 && cooling('food') && home && dHome < 220 && hut.shellComplete(bot) && !held('recover')) return { name: 'recover', why: `hp ${Math.round(bot.health)}, no food to be had - resting in the safehouse until crops ripen` }

  // 4. basic tools
  const kit = missingKit()
  if (kit.length && !held('tools')) return { name: 'tools', why: 'missing ' + kit.join(', ') }
  // a bed to CARRY first (shelter first still holds: it goes down in the safehouse once the shell stands; till then it is
  // slept in where the night finds us - sleepHere). Without one every death respawned 2200 blocks away at world spawn,
  // three treks back in a day (2026-09-27)
  if (!bed && !shelter.hasBedItem(bot) && world.phase(bot) === 'day' && bedObtainable() && !held('bed')) return { name: 'bed', why: 'no bed - getting one to carry (spawn is where i sleep)' }

  // 5. home
  if (!home) return { name: 'setHome', why: 'no home yet' }
  if (dHome < 160 && hut.siteGone(bot) && !held('abandonHome')) return { name: 'abandonHome', why: `the ground under the home at ${move.fmt(home)} is gone - choosing a new home` }
  // (in our own mine is at work, not astray: a staircase from y113 to y16 runs ~100 blocks out, and the face 116 blocks
  //  from home sent the bot home every time a mining task returned - a pickaxe worn out, a batch done - 2026-09-24)
  // (dawn out there: the night's mobs are not burning yet - home's hideout rule keeps the bot walled in till full light,
  //  and 700b out it dug out of the bunker at the first day tick into whatever stood round the hole: the same wait -
  //  audit 2026-09-28)
  // (only when really dug in - walled round and roofed; caught in the open, it digs in now: idling at the rim under a
  //  "dug in" label would be a lie - audit 2026-09-28)
  if (expedition() && dim && around.length) {
    const me = world.feetPos(bot); const roof = world.at(bot, me.x, me.y + 2, me.z)
    const dugIn = shelter.enclosedHere(bot) && !!roof && world.isSolid(roof)
    if (dugIn) return { name: 'idle', why: `dawn at camp with ${around.length} hostile${around.length > 1 ? 's' : ''} about (${around.slice(0, 3).map(h => h.e.name).join(', ')}) - staying dug in till full light` }
    if (!held('bunker')) return { name: 'bunker', why: `dawn in the open with ${around.length} hostile${around.length > 1 ? 's' : ''} about - digging in till full light` }
  }
  { const e = expedition(); if (e && world.phase(bot) === 'day' && !tooHurt() && (bot.health >= EXPEDITION_HP || !canHeal()) && !held('expedition')) return { name: 'expedition', why: e.phase === 'back' ? `back from the ${e.raw} expedition (${e.why}) - ${Math.round(dHome)}b to home` : `on an expedition for ${e.raw}${e.to ? ' toward the ' + e.to.biome : ''} - night ${e.nights + 1} of ${MAX_NIGHTS} at most` } }
  if (dHome > 96 && !expedition() && !mining.inOwnMine(bot) && !tooHurt() && !held('goHome')) return { name: 'goHome', why: `${Math.round(dHome)}b from home` }

  // 5b. at home with a haul in the pack: put it in the chest (a player empties their pockets at home)
  if (dHome < 24 && (mem.get().chests || []).length && haulSize() >= 64 && !held('deposit')) return { name: 'deposit', why: `home with ${haulSize()} items to store` }

  // 5c. plant first (a minute of work, renewable food), then top up the food buffer while it is easy -
  //     starving first and searching second killed the bot twice
  if (dHome < 64 && (farm.farm() === null || !farm.farmIsHome(bot)) && (inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds')) >= 4 && !held('farm')) return { name: 'farm', why: 'seeds in hand and no farm at this home' }
  if (packFood < 12 && bot.food <= 12 && !held('food')) return { name: 'food', why: `food buffer low (pack ${packFood} pts, hunger ${bot.food})` }

  // FIRST THING IN THE DAY: a far trip refused for want of daylight goes before the day's rounds - asked at the end of a
  //  castle round, the dark oak trip came each day with 2300 ticks left and was "not today" three days running, the castle
  //  standing on it (2026-09-28). An expedition from here: it camps where the night finds it
  { const ft = mem.get().farTrip
    if (ft && world.phase(bot) === 'day' && world.ticksUntilNight(bot) > 2400 && !expedition() && !held('farTrip')) return { name: 'farTrip', why: `${ft.raw} - the far trip, first thing in the day` } }
  // 6. food: cook what we carry; harvest a ripe farm
  if (inv.rawFoodCount(bot) >= 3 && dHome < 64 && !held('cook')) return { name: 'cook', why: `${inv.rawFoodCount(bot)} raw food to cook` }
  // saplings on hand and room for them in the orchard (empty spots, or fewer trees than the build still needs)
  {
    const saps = orchard.saplingCount(bot) + inv.count(bot, 'dark_oak_sapling') + Object.entries(base.bankCounts()).filter(([n]) => orchard.ANY_SAP_RE.test(n)).reduce((a, [, c]) => a + c, 0)
    const spruceSaps = Math.max(...['spruce_sapling', 'dark_oak_sapling'].map(n => inv.count(bot, n) + base.bankCount(n))) // (the squares' saplings)
    const o = orchard.orchard()
    if (dHome < 64 && world.phase(bot) === 'day' && saps > 0 && orchard.plantable(bot, spruceSaps, saps, demandTrees) && !held('plant')) return { name: 'plant', why: `${saps} saplings for the orchard (${o ? o.spots.length : 0} spots, ${demandTrees} trees wanted)` }
  }
  // the sheep pen: built while the build wants wool, then stocked and bred (pen.work: the one rule for this and the task)
  if (dHome < 64 && world.phase(bot) === 'day' && !held('pen')) { const w = pen.work(bot, penArgs()); if (w) return { name: 'pen', why: w.why } }
  // (the harvest when the bread runs low, not every morning: the crop keeps on the stalk, and harvesting and
  //  replanting 71 cells took two minutes of every ten-minute day with 31 bread in the pack, 2026-09-26)
  if (farm.farm() && dHome < 64 && farm.ripeCount(bot) >= 8 && breadStock() < BREAD_WANTED && !held('harvest')) return { name: 'harvest', why: `${farm.ripeCount(bot)} wheat ripe` }

  // 7. base infrastructure - SHELTER FIRST: nothing of value (bed, bank) sits in the open, so the
  //    safehouse goes up before the bed and the chest go down inside it
  if (dHome < 64) {
    if (hut.collidesWithBuild(bot) && !held('relocate')) return { name: 'relocate', why: 'the safehouse stands on the build footprint - moving house' }
    if (!hut.complete(bot) && !held('hut')) { const s = hut.status(bot); return { name: 'hut', why: `the safehouse is ${s ? s.done + '/' + s.total : 'not started'}` } }
    if (hut.shellComplete(bot) && furnishingInPack().length && !held('furnish')) return { name: 'furnish', why: `putting ${furnishingInPack().join(', ')} in the safehouse` }
    if (!(mem.get().chests || []).length && !held('chest')) return { name: 'chest', why: 'no storage at home' }
    if (farm.farm() && farm.farmHome && !farm.farmIsHome(bot) && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 4 && !held('farm')) return { name: 'farm', why: 'the farm belongs to the old home - planting one here' }
    if (!bed && bedObtainable() && !held('bed')) return { name: 'bed', why: 'no bed - spawn is not anchored at home' }
    // a spare stone kit in the chest: a death respawns us beside it instead of sending us 100 blocks for logs
    if (dHome < 32 && SPARE_KIT.some(t => base.bankCount(t) < 1) && stock('cobblestone') >= 10 && !held('spareKit')) return { name: 'spareKit', why: 'no spare tools in the chest - making a set' }
    // light the ground around home: no mobs spawning at the door means nights asleep, not on guard
    if (dHome < 32 && world.phase(bot) === 'day' && world.tod(bot) < 10000 && !held('lightBase') && (inv.count(bot, 'torch') + base.bankCount('torch') >= 4 || inv.count(bot, 'coal') + base.bankCount('coal') + inv.count(bot, 'charcoal') >= 1)) {
      const dark = lights.darkSpots(bot).length
      if (dark >= 3) return { name: 'lightBase', why: `${dark} dark spots around home where mobs spawn` }
    }
    // a dry farm starves us: water it as soon as there is iron for a bucket
    if (farm.farmIsHome(bot) && farm.canHydrate(bot) && !held('hydrate')) return { name: 'hydrate', why: 'the farm is dry - bringing water to it' }
    if (farm.farmIsHome(bot) && farm.waterNeedsFixing(bot) && !held('fixWater')) return { name: 'fixWater', why: 'water is running over the crops - putting it back in its hole' }
    if (!farm.farm() && !held('farm')) return { name: 'farm', why: 'no farm - bread does not run out like animals do' }
    // a farm to walk: one soil level, nothing but crops on it (the operator asked for it clean and flat)
    if (farm.farm() && farm.farmIsHome(bot) && farm.farm().water && !farm.waterNeedsFixing(bot) && world.phase(bot) === 'day' && !farm.farmLevel(bot) && !held('levelFarm')) return { name: 'levelFarm', why: `the farm is uneven or cluttered (${farm.levelWork(bot).length} fixes)` }
    // the yard round the safehouse: holes filled, stray blocks down (a pit by the door stood for days)
    // (a stray shaft on the grounds that someone fell into: capped flush, before anything else here - see reflex's fall line)
    if (world.phase(bot) === 'day' && (mem.get().shaftsToFill || []).length && !held('fillShaft')) return { name: 'fillShaft', why: `${mem.get().shaftsToFill.length} hole${mem.get().shaftsToFill.length > 1 ? 's' : ''} on the grounds that I fell into - capping ${mem.get().shaftsToFill.length > 1 ? 'them' : 'it'}` }
    if (world.phase(bot) === 'day' && hut.complete(bot) && !held('levelYard')) { const n = hut.yardWork(bot).length; if (n) return { name: 'levelYard', why: `the yard has ${n} holes or stray blocks` } }
    // a watered plot still at its starting size: widen it to everything the water reaches
    if (farm.farm() && farm.farmIsHome(bot) && farm.farm().water && farm.farm().cells.length < 60 && farm.farmLevel(bot) && farm.fullPlot(bot, farm.farm()).length > farm.farm().cells.length && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 8 && !held('farm')) return { name: 'farm', why: `the farm is ${farm.farm().cells.length} cells - widening it to all the water reaches` }
    if (farm.farm() && farm.farmIsHome(bot) && !farm.waterNeedsFixing(bot) && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 4 && (farm.unplantedCount(bot) >= 8 || (farm.unplantedCount(bot) > 0 && breadStock() < BREAD_WANTED)) && !held('farm')) return { name: 'farm', why: `${farm.unplantedCount(bot)} farm cells unplanted and ${inv.count(bot, 'wheat_seeds')} seeds in hand` }
  }

  // 8. iron gear when the iron is on hand
  const iron = inv.count(bot, 'iron_ingot') + base.bankCount('iron_ingot')
  const raw = inv.count(bot, 'raw_iron') + base.bankCount('raw_iron')
  const wanted = ironWanted()
  if (wanted.length && !held('iron')) {
    const cheapest = wanted.map(n => IRON_COST[n]).sort((a, b) => a - b)[0]
    if (iron + raw >= cheapest) return { name: 'iron', why: `${iron} ingots + ${raw} raw iron - making ${wanted[0]}` }
  }
  // 8b. no iron for the gear the body lacks: go and dig it. Iron gear used to wait for iron "on hand" - and iron only
  // came as the build's own share, turned up whenever its layers got to it. Unarmoured and shieldless, the bot lost
  // four skeleton trades in an hour building (2026-09-25). The shield and armour's iron before the build's blocks.
  const gearShort = gearIronShort()
  // (a trip that came back with no iron is not made again until iron turns up some other way - the build's own cobble
  //  tunnel takes the ore in its walls: then there is iron to be found. A timed backoff let dry trips win every
  //  morning, four hours without a block placed; clearing it on any placement still spent a trip a day, 2026-09-25)
  const dry = mem.get().ironTripDry
  // (a dry trip under another way of mining says nothing about this one: tunnelling to known veins since 2026-09-26)
  // (the mark clears on iron GAINED since: a death or a craft that spent iron lowers the baseline, else the old count was
  //  never reached again and no trip ever went - audit #41)
  if (dry && dry !== true && dry.method === ORE_METHOD && ironStock() < dry.stock) mem.set('ironTripDry', Object.assign({}, dry, { stock: ironStock() }))
  if (dry && (dry === true || dry.method !== ORE_METHOD || ironStock() > mem.get().ironTripDry.stock)) mem.set('ironTripDry', null)
  if (gearShort > 0 && !mem.get().ironTripDry && world.phase(bot) === 'day' && world.ticksUntilNight(bot) > 2400 && !held('ironTrip')) return { name: 'ironTrip', why: `${gearShort} iron short for ${wanted.filter(n => ARMOUR_GEAR.has(n)).join(', ')} - mining for it` }

  // 9. the build
  // (with its own backoff: a castle step failing in 30ms was retried 26 times in a second)
  // (derived from the world, never a latch: a finished build that loses blocks - a creeper - is work again)
  // (not in the day's last minutes: a round that can only be cut short at once spun - castle, placed 0, deposit, castle
  //  - every three seconds at dusk once a dusk-cut round stopped counting as a failure, 2026-09-27)
  // (a debt cap on our own litter: in the castle's gaps only, it never came - the castle always has work - and 211 pillars
  //  and stepping stones stood round home by the evening, cobble towers on the treetops the operator asked about,
  //  2026-09-28. Past LITTER_CAP it goes before the castle: one walk takes down dozens)
  // (once a day at most ahead of the castle - twice took 623s of a 25-minute day, the castle 248s, 2026-09-28: from 211 pending, a run of 12 columns at a time would take most of a day - the
  //  backlog drains over days, the stepping stones' price stops it growing; audit)
  // (a new day the way watchNights reads one - a night seen, or the clock wrapped past dawn in a bed - never bot.time.day)
  // (kept in memory: a module variable was reset by every restart, and a deploy day ran the tidy ahead three times)
  const tidyFirst = mem.get().tidyFirst || { day: null, n: 0 }
  { const d = day.dayNo(bot); if (tidyFirst.day !== d) { tidyFirst.day = d; tidyFirst.n = 0; mem.set('tidyFirst', tidyFirst) } } // (a new day: day.js)
  if (tidyFirst.n < 1 && dHome < 64 && world.phase(bot) === 'day' && !nightSoon() && !held('tidy')) {
    const n = litter.pending(bot, mem.get().home, 96).length
    if (n >= LITTER_CAP) { tidyFirst.n++; mem.set('tidyFirst', tidyFirst) }
    if (n >= LITTER_CAP) return { name: 'tidy', why: `${n} blocks of ours left standing round home (pillars, stepping stones) - past ${LITTER_CAP}, before the castle` }
  }
  // (the site's old scaffold, once a day ahead of the castle - build.siteScaffoldTeardown; the same day as the tidy's)
  if (dHome < 64 && world.phase(bot) === 'day' && !nightSoon() && !held('siteTidy') && build.getJob()) {
    const sd = mem.get().siteTidy || { day: null, done: false }
    { const d = day.dayNo(bot); if (sd.day !== d) { sd.day = d; sd.done = false; mem.set('siteTidy', sd) } } // (a new day: day.js)
    // (the site diff is a pass over the box: asked every 5 minutes at most, never every decision - body first)
    if (!sd.done && Date.now() - siteTidyAsked > 300000) {
      siteTidyAsked = Date.now()
      // (what the teardown would TAKE, not all that stands: the builder's own from the band up are kept, and counted they
      //  fired the teardown every game day - 4 minutes for ~25 blocks, 2026-09-29)
      const n = build.siteScaffoldTakeable(bot)
      if (n >= 20) { sd.done = true; mem.set('siteTidy', sd); return { name: 'siteTidy', why: `${n} scaffold blocks of ours to take down round the site - the day's teardown, before the castle` } }
    }
  }
  if (mem.get().build && build.getJob() && build.needsWork(bot) && !nightSoon() && !homeByDark() && !held('castle')) {
    return { name: 'castle', why: 'working on ' + mem.get().build.name }
  }
  // 10. our own pillars and stepping stones left standing round home (a batch: one walk takes down many - LITTER_BATCH) -
  //  in the castle's gaps only (held, waiting, the day's end): tidying ahead of it took 40 minutes of a morning, the
  //  castle idle (single goal: the build; audit 2026-09-28)
  if (dHome < 64 && world.phase(bot) === 'day' && !held('tidy')) {
    if (!litterSeeded && orchard.orchard()) { litterSeeded = true; litter.seed(bot) }
    const n = litter.pending(bot, mem.get().home, 96).length
    if (n >= LITTER_BATCH) return { name: 'tidy', why: `${n} blocks of ours left standing round home (pillars, stepping stones)` }
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
      // the bed's drop, walked to until it is in the pack: one dug in the mine at y16 was left lying there and the next
      // day went to a 20-minute sheep hunt for a new one (2026-09-24)
      for (let i = 0; i < 3 && !shelter.hasBedItem(bot); i++) {
        const drop = Object.values(bot.entities).find(e => { if (!e || e.name !== 'item' || !e.position || world.dist3(e.position, placed) > 8) return false; try { const it = e.getDroppedItem(); return it && /_bed$/.test(it.name) } catch { return false } })
        if (!drop) break
        await move.goTo(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5), { timeoutMs: 15000, label: 'to my bed' })
        await act.collectDrops(bot, { radius: 4, maxMs: 4000 })
      }
      if (!shelter.hasBedItem(bot)) log('dir', `took the bed down at ${move.fmt(placed)} but it is not in the pack`)
      mem.set('bed', before && world.at(bot, before.x, before.y, before.z) && /_bed$/.test(world.at(bot, before.x, before.y, before.z).name) ? before : null)
    }
    return ok
  },
  async nightMine () {
    // (the night's digging goes to the fuel first when the furnaces wait on it - coal from the mine's walls, with its
    //  cobble - then to the cobble: the day's coal trip was cut short at dusk every time, 2026-09-28)
    const stop = () => taskCancelled() || world.isDay(bot)
    const st = build.cachedStatus(bot)
    const fuelShort = st && (mats.planFor(bot, st.need).raw.fuel || 0) > 0 && inv.count(bot, 'coal') + inv.count(bot, 'charcoal') + base.bankCount('coal') + base.bankCount('charcoal') < 32
    if (fuelShort) {
      const c0 = inv.count(bot, 'coal')
      await mining.mineFor(bot, 'coal', c0 + 32, { seal: true, shouldStop: stop }).catch(() => false)
      log('dir', `the night's coal: +${inv.count(bot, 'coal') - c0}`)
      if (stop()) return inv.count(bot, 'coal') > c0
    }
    const want = 'cobblestone'
    const target = inv.count(bot, want) + 256
    return mining.mineFor(bot, want, target, { seal: true, shouldStop: stop })
  },
  async bunker () {
    return shelter.bunker(bot, { shouldStop: () => taskCancelled() })
  },
  async hideout () {
    const t0 = Date.now()
    if (!await hut.enterHut(bot, { shouldStop: () => taskCancelled() })) return false
    await hut.sealDoor(bot).catch(() => false)
    // the bow off the chest in here: with it the camp outside is shot at, not waited out (pillagers never burn - a
    // patrol camped the door, 2026-09-25)
    if (!reflex.bowReady() && base.bankCount('bow') > 0 && base.bankCount('arrow') > 0) {
      if (!inv.has(bot, 'bow')) await base.withdraw(bot, 'bow', 1).catch(() => 0)
      await base.withdraw(bot, 'arrow', 64).catch(() => 0)
      // out only to shoot what can be shot: daylight, a shooter on the surface at our height, and above the hurt line - the
      // door was opened for 'dim' at night with mobs round it, and the log said "going out to shoot" (audit #21)
      if (reflex.bowReady()) {
        const dim = world.phase(bot) !== 'day' || world.tod(bot) >= 23000 || world.tod(bot) < 1500
        const shooters = reflex.hostiles(20).filter(h => reflex.RANGED.has(h.e.name) && Math.abs(h.e.position.y - bot.entity.position.y) < 6 && onSurface(h.e))
        if (!dim && shooters.length && bot.health > reflex.hurtLine()) { log('dir', `took the bow and ${inv.count(bot, 'arrow')} arrows - going out to shoot ${shooters.length} shooter(s)`); await hut.unsealDoor(bot).catch(() => false); return true }
        log('dir', `took the bow and ${inv.count(bot, 'arrow')} arrows - staying in (${dim ? 'dim' : !shooters.length ? 'no shooter on the surface' : 'hp ' + Math.round(bot.health)})`)
      }
    }
    // hurt with nothing to eat: the chests are in here (cooked first, then the raw meats that do no harm)
    if (bot.health < 20 && bot.food < inv.REGEN_FOOD && !inv.foodItems(bot, { hurt: true }).length) {
      const bank = base.bankCounts()
      for (const n of ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'baked_potato', 'cooked_chicken', 'cooked_salmon', 'cooked_cod'].concat(inv.SAFE_RAW)) {
        if ((bank[n] || 0) > 0) { await base.withdraw(bot, n, Math.min(8, bank[n])).catch(() => 0); if (inv.foodItems(bot, { hurt: true }).length) break }
      }
    }
    log('dir', `waiting inside while mobs are about (hp ${Math.round(bot.health)})`)
    while (!taskCancelled() && Date.now() - t0 < 4 * 60000) {
      const left = reflex.hostiles(20).filter(h => h.e.name !== 'bat' && Math.abs(h.e.position.y - bot.entity.position.y) < 6 && onSurface(h.e))
      const dim = world.phase(bot) !== 'day' || world.tod(bot) >= 23000 || world.tod(bot) < 1500
      const outgunned = left.some(h => reflex.RANGED.has(h.e.name)) && !inv.offhandShield(bot) && inv.armorPoints(bot) < 8 && !reflex.bowReady()
      if (!left.length || (!dim && !outgunned && bot.health > reflex.hurtLine())) break // (the hurt line, as entry and heal use: R11)
      // a bed right here: sleeping skips the rest of the night (the server refuses while monsters are
      // close - keep trying, walled in they drift off)
      const bedB = shelter.bedBlock(bot)
      if (bedB && world.isNight(bot) && world.dist3(bedB.position, bot.entity.position) < 4 && !bot.isSleeping) {
        try { await bot.sleep(bedB); log('dir', 'asleep in the safehouse'); while (bot.isSleeping && !world.isDay(bot)) await move.sleep(2000) } catch {}
      }
      await hut.sealDoor(bot).catch(() => false) // (sealed once the door is clear - the first try may have met a mob at it)
      await move.sleep(5000)
    }
    return true
  },
  async heal () {
    const home = mem.get().home
    // at the hurt line (or out of daylight) with home near and the safehouse up: rest walled in; a scratch by day at
    // home rests where it stands, the reflexes on guard (no door and seal for a point of hp)
    if ((tooHurt() || world.phase(bot) !== 'day') && home && hut.shellComplete(bot) && world.dist2(bot.entity.position, home) < 96) {
      if (!await hut.enterHut(bot, { shouldStop: () => taskCancelled() })) return false
      await hut.sealDoor(bot).catch(() => false)
    }
    const hp0 = bot.health; const t0 = Date.now()
    let best = bot.health; let bestAt = Date.now()
    while (!taskCancelled() && bot.health < 20 && canHeal() && !reflex.hostiles(8).some(h => h.e.name !== 'bat')) {
      if (bot.health > best) { best = bot.health; bestAt = Date.now() }
      // regeneration gives a point every 4s on a full bar: five of those without one is not healing (poison, a food
      // bar that will not stay up) - hand back and let the chooser look again
      if (Date.now() - bestAt > 5 * 4000 && bot.food >= inv.REGEN_FOOD) { log('dir', `not healing (hp ${Math.round(bot.health)}, food ${bot.food}) - giving up the rest`); return false }
      await move.sleep(1000)
    }
    log('dir', `healed ${Math.round(hp0)} -> ${Math.round(bot.health)} hp in ${Math.round((Date.now() - t0) / 1000)}s`)
    return bot.health > hp0 || bot.health >= 20
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
  async farm () { const ok = await farm.establish(bot, { shouldStop: dayStop }); baseZone(); return ok },
  // (not through the night from a bare start: the hut's own shelter is the reason to work on at dusk - at 56/149, no walls,
  //  the task walked the night after birch for torch sticks and a creeper killed it, 2026-09-27; nearly done, it finishes)
  async hut () { return hut.buildHut(bot, { shouldStop: () => homewardStop() || (world.phase(bot) === 'night' && !hutNearlyUp()) }) },
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
          const f = await act.openSettled(bot, bot.blockAt(new Vec3(pos.x, pos.y, pos.z)), 'openFurnace')
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
            if (what === 'chest') { mem.addUnique('chests', c); base.notePlacedChest(c) }
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
  async fillShaft () {
    const l = (mem.get().shaftsToFill || []).slice()
    let done = 0
    for (const c of l) {
      if (dayStop()) break
      // (the cap: the cell at ground level and the one under it, flush with the ground round it - never a clear)
      await require('./ground').prepare(bot, { x1: c.x, x2: c.x, z1: c.z, z2: c.z, groundY: c.y, height: 0, allowZones: ['base', 'orchard', 'farm'] }, { shouldStop: dayStop, label: 'hole cap' }).catch(() => 0)
      const top = world.at(bot, c.x, c.y, c.z)
      // (the cap remembered: a lid is ours on purpose, never litter - its top block stands on the lower one and passes for a
      //  pillar's; litter.kept asks this list, audit 2026-09-28)
      if (top && world.isSolid(top)) { done++; mem.update(m => { m.shaftsToFill = (m.shaftsToFill || []).filter(q => !(q.x === c.x && q.z === c.z)); m.caps = (m.caps || []).concat([{ x: c.x, y: c.y, z: c.z }]).slice(-200) }); log('dir', `capped the hole at ${c.x},${c.y},${c.z}`) }
    }
    return done > 0
  },
  async farTrip () { const ft = mem.get().farTrip; mem.set('farTrip', null); return ft ? startExpedition(ft.raw, ft.land) : false },
  async siteTidy () { return (await build.siteScaffoldTeardown(bot, { shouldStop: dayStop })) > 0 },
  async tidy () { return (await litter.tidy(bot, { from: mem.get().home, radius: 96, shouldStop: dayStop })) > 0 },
  async levelYard () { return (await hut.levelYard(bot, { shouldStop: dayStop })) > 0 },
  async fixWater () { return farm.fixWater(bot, { shouldStop: dayStop }) },
  async harvest () { return farm.harvest(bot, { shouldStop: dayStop }) },
  async pen () { const w = pen.work(bot, penArgs()); return w ? pen.run(bot, w.kind, { shouldStop: dayStop }) : true },
  async plant () {
    for (const [n, c] of Object.entries(base.bankCounts())) if (orchard.ANY_SAP_RE.test(n) && c > 0) await base.withdraw(bot, n, c).catch(() => 0)
    return (await orchard.plant(bot, { demandTrees, shouldStop: dayStop })) > 0
  },
  async tools () {
    for (const t of missingKit()) {
      // (the bow and arrows come out of the chest: nothing here makes them)
      if (t === 'filler') {
        // (the ONE filler getter - the scaffold's: the bank, then cobble from the mine, surface dirt last; a kit's own dirt dig
        //  was the chain that walked the bot 104 blocks out to drown, 03:54 - it must not drift from the scaffold's; audit)
        await build.ensureScaffold(bot, 24, { shouldStop: dayStop }).catch(() => false)
        if (inv.items(bot).filter(i => build.FILLER_ITEMS.test(i.name)).reduce((k, i) => k + i.count, 0) < 16) { log('dir', 'no filler to be had for the kit'); return false }
        continue
      }
      if (t === 'bow' || t === 'arrow') { const got = await base.withdraw(bot, t, t === 'bow' ? 1 : 64).catch(() => 0); if (!got) { log('dir', `couldn't take the ${t} from the chest`); return false } continue }
      // a worn-out tool still counts as "held": ask for one more than we have
      const ok = await craft.ensure(bot, t, inv.count(bot, t) + 1, { shouldStop: dayStop })
      if (!ok) { log('dir', `couldn't make ${t}`); return false }
    }
    return true
  },
  // the home's ground is gone (hut.siteGone): everything remembered there went with it - chests, furnaces, bed, farm,
  // the mine's stairs. Forgotten; setHome sites a new one (by the build) and the base is built again from the pack.
  async abandonHome () {
    const h = mem.get().home
    log('dir', `abandoning the home at ${move.fmt(h)}: its ground is gone`)
    mem.update(m => { m.home = null; m.bed = null; m.hutPlan = null; m.hut = null; m.chests = []; m.chestContents = {}; m.furnaces = []; m.tables = []; m.farm = null; m.orchard = null; m.pen = null; m.mine = null; m.bunker = null })
    pen.setZone() // (the old pen's ground is no zone any more)
    try { hut.resetPlan() } catch {}
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
    if (!hut.shellComplete(bot)) return true // (carried until the safehouse stands - shelter first)
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
  async ironTrip () {
    const short = gearIronShort()
    if (short <= 0) return true
    const before = inv.count(bot, 'raw_iron')
    await gatherFor('raw_iron', short)
    const got = inv.count(bot, 'raw_iron') - before
    if (got > 0) log('dir', `ironTrip: dug ${got} raw iron for the gear`)
    // (a trip cut short - dusk, danger, a stop - found nothing because it looked at nothing: it marks no dryness. At dusk
    //  the trip was stopped with 0/28 before a block was dug and "no more trips" shut iron off for good, 2026-09-27)
    else if (dayStop() || taskCancelled()) log('dir', 'ironTrip: cut short before any iron - trying again another day')
    else { mem.set('ironTripDry', { stock: ironStock(), method: ORE_METHOD }); log('dir', 'ironTrip: no iron this trip - no more trips until iron turns up in the build mining') }
    return got > 0
  },
  async expedition () {
    const e = expedition(); if (!e) return false
    const stop = () => taskCancelled() || nightSoon() || tooHurt()
    if (e.phase === 'back') {
      const r = await base.goHome(bot, { shouldStop: stop })
      if (r.ok && base.distHome(bot) < 24) { mem.set('expedition', null); log('dir', `expedition for ${e.raw}: home with ${inv.count(bot, e.raw)} ${e.raw}`) }
      return r.ok
    }
    if (!e.packed && base.distHome(bot) < 64) {
      if (inv.count(bot, 'cobblestone') < COBBLE_OUT) await base.withdraw(bot, 'cobblestone', COBBLE_OUT - inv.count(bot, 'cobblestone')).catch(() => 0)
      e.packed = true; mem.set('expedition', e)
    }
    if (inv.foodPoints(bot) < FOOD_BACK) { endExpedition(`food down to ${inv.foodPoints(bot)} pts`); return true }
    const before = inv.count(bot, e.raw)
    const room = tripRoom()
    if (room < 64) { endExpedition('the pack is full'); return true }
    await gather.chop(bot, new RegExp(`^${e.raw}$`), room, { shouldStop: stop, leaves: true, expedition: true })
    const o = gather.lastChopOutcome()
    const got = inv.count(bot, e.raw) - before
    if (got > 0) forage.noteTrip(e.raw, got, 'expedition')
    // (a dark oak felled: its crowns decay over the next half minute, a sapling in twenty leaves - a player waits and picks
    //  them up. Home they plant a square in the orchard, and dark oak grows a few steps from the build instead of a 420-block
    //  walk away. The first two trips brought 92 logs and not one sapling, 2026-09-29)
    if (got > 0 && /^dark_oak_log$/.test(e.raw) && inv.count(bot, 'dark_oak_sapling') < 8) {
      // (the crown BROKEN, not waited on: decay runs on random ticks - minutes a crown - and a leaf broken by hand drops a
      //  sapling as often as one that decays. Every natural dark oak leaf in reach, then the drops, then one short pass for
      //  what still falls; audit)
      const s0 = inv.count(bot, 'dark_oak_sapling')
      const lv = world.findBlocks(bot, /^dark_oak_leaves$/, { maxDistance: 4.5, count: 100, point: bot.entity.position.offset(0, 1.6, 0),
        filter: b => { try { const pr = b.getProperties(); return pr.persistent === false || pr.persistent === 'false' } catch { return false } } })
      let broke = 0
      for (const b of lv) { if (stop()) break; if (act.reach(bot, b.position, 4.5) && await act.dig(bot, b.position, { timeoutMs: 3000, noWalk: true }).catch(() => false)) broke++ }
      await act.collectDrops(bot, { radius: 10, maxMs: 8000 }).catch(() => {})
      if (!stop()) { await move.sleep(5000); await act.collectDrops(bot, { radius: 10, maxMs: 5000 }).catch(() => {}) }
      const s1 = inv.count(bot, 'dark_oak_sapling')
      log('dir', `expedition: broke ${broke} dark oak leaves - ${s1 - s0} sapling${s1 - s0 === 1 ? '' : 's'} picked up (${s1} in the pack)`)
    }
    if (tripRoom() < 64) endExpedition('the pack is full')
    else if (o && o.outcome === 'none-found' && got <= 0) { e.dry++; mem.set('expedition', e); if (e.dry >= 2) { forage.noteTrip(e.raw, 0, 'none found on the expedition', { searched: true }); endExpedition('no more of it to be found') } }
    return got > 0 || (o && (o.outcome === 'lead' || o.outcome === 'stopped'))
  },
  async castle () { return castleWork() },
  async idle () { await move.sleep(5000); return true },
  async ashore () {
    // the nearest ground in sight; none loaded: on toward the site (or home) - the crossing lands on the way there
    const j = build.getJob()
    const land = boat.nearestLand(bot, 48) || (j && j.origin) || mem.get().home
    if (!land) return false
    const r = await move.travel(bot, land, { range: 2, shouldStop: () => taskCancelled() || (!boat.swimming(bot) && !boat.inBoat(bot)), label: 'ashore' })
    return r.ok || (!boat.swimming(bot) && !boat.inBoat(bot))
  }
}

// ---- the castle ---------------------------------------------------------------------------
// Materials go through ONE pipeline (materials.js): the recipe graph says how each item is made, plan() nets
// it against the stock, and the director executes the plan here - the crafts for the builder's window, a
// smelt queue for the whole build, and one raw material gathered at a time (window first, then the long pole).
// (the castle-only table of stone bricks, oak/spruce planks and glass it replaces could not make a brick)
// HOW MANY FURNACES: scaled to the build. As many as there are stacks left to smelt (a house with two stacks of glass
// gets two), never more than one trip home can fill - a full pack is the most a visit brings, a stack a furnace. Six
// fixed furnaces made Notre-Dame's ~30,000 smelts a queue of 80+ furnace-hours while the builder waited on slabs.
function packStacks () { try { return bot.inventory.inventoryEnd - bot.inventory.inventoryStart } catch { return 36 } }
function furnaceTarget (tot) { return Math.max(1, Math.min(Math.ceil(tot.smeltTotal / 64), packStacks())) }
// What one trip can carry home of a material, beyond a couple of slots for what the trip turns up on the way (ores in
// the tunnel walls, a sapling): a player goes back when the pack is full, not after two stacks. Fixed caps (160 cobble,
// 64 logs, 32 fuel logs) made a 33,000-cobble job 200 walks to the mine.
function tripRoom () { return Math.max(1, inv.freeSlots(bot) - 2) * 64 }
// Trees the build still needs: its logs and its fuel as charcoal (8/7 logs a unit), over the logs a tree gives (what the
// orchard's own harvests have given, 5 - the wild oaks round Notre-Dame - until it has any). Updated whenever the
// materials plan is made at home; the orchard grows to it and no further.
let demandTrees = 0
// Wool the build still needs (its plan's raw wool), with demandTrees: the sheep pen is built for it.
let demandWool = 0
const cellCost = new Map() // item -> { raws, c }: one cell's raw cost by its recipe (stock-free) - pickRaw's order
let cellCostPlanner = null // (the planner the memo was priced by: a new one - reset, new routes, new home - clears it; audit)
// The pen's arguments: the wool wanted, and the wheat it may have - pack and bank, bread's share (three loaves) kept back
// while the bread is short
function penArgs () {
  const wheat = inv.count(bot, 'wheat') + base.bankCount('wheat')
  return { woolWanted: demandWool, wheat: Math.max(0, wheat - (breadStock() < BREAD_WANTED ? 9 : 0)) }
}
function treesFor (tot) {
  const logs = (tot.raw.log || 0) + Math.ceil((tot.raw.fuel || 0) * 8 / 7)
  const per = (mem.get().orchard && mem.get().orchard.perTree) || 5
  return Math.ceil(logs / per)
}
const WINDOW_LAYERS = 4 // the layers above the lowest unfinished one the builder works in (build.nextNeeds)

function stock (name) { return inv.count(bot, name) + base.bankCount(name) }
// a build cell takes whatever may stand in for its item (any wood of the form, dirt for grass): by pool
function stockOf (name) { return mats.stock(bot, name) }
async function withdrawOf (name, want) { return mats.withdrawPool(bot, name, want) }
// The window's blocks out of the chest while two slots stay free (the pickups on the way): a stack of every kind first -
// the one-offs (a button, a flower) often anchor the band's lowest cells, and four stacks of stone taken first left no
// room for them (audit 2026-09-27) - then the big kinds topped up to four stacks
async function withdrawWindow (needs) {
  for (const cap of [64, 64 * 4]) {
    for (const [name, n] of Object.entries(needs)) {
      if (inv.freeSlots(bot) < 2) return
      const want = Math.min(n, cap) - countOf(name)
      if (want > 0) await withdrawOf(name, want)
    }
  }
}
function countOf (name) { return mats.held(bot, name) }
function windowNeeds () { return typeof build.nextNeeds === 'function' ? build.nextNeeds(bot, WINDOW_LAYERS) : {} }
// the nearest natural wood growing around here (what the castle's wood cells will be made of)
function nearestWood () {
  // (not the build's own species - wood for fuel is any other tree; preferredWood keeps the same rule)
  const res = mats.reservedSpecies(bot)
  const t = world.findBlocks(bot, build.LOG_ANY, { maxDistance: 64, count: 8, filter: b => !move.inZone(b.position, 2) && !move.insideHut(b.position) && !res.has(b.name.replace('_log', '')) })[0]
  return t ? t.name.replace('_log', '') : craft.preferredWood(bot, 1)
}

// Smelt `n` of `input` in the background: into the pack from the chest, fuel the coal/charcoal/spare wood
// covers (never a walk to the trees from here - a fuel shortfall is gathered like any raw), loaded across the
// home furnaces and collected on a later pass (waiting at the furnace cost minutes a batch).
async function loadSmelt (input, n) {
  const room = Math.max(0, inv.freeSlots(bot) - 3) * 64
  if (inv.count(bot, input) < n) await base.withdraw(bot, input, Math.min(n - inv.count(bot, input), room)).catch(() => 0)
  const k = Math.min(n, inv.count(bot, input))
  if (k <= 0) return 0
  if (!await smelt.pickFuel(bot, k, { noGather: true })) { log('dir', `no fuel on hand for ${k} ${input} - it waits in the chest`); return 0 }
  return smelt.loadFurnaces(bot, input, k)
}

// At home between building and gathering: the furnaces emptied, refuelled and fed from the chest, and the
// crafts made. The SMELT QUEUE is the whole build's (clay->brick, cobble->stone->smooth stone, stone bricks->
// cracked, sand->glass: what the chest holds goes in, the window's first); the CRAFTS are the window's only,
// with the whole recipe yield - never all the bricks turned into stairs.
async function processAtHome () {
  const home = mem.get().home
  const st = build.cachedStatus(bot)
  if (!st) return
  phase('home: furnaces collect+refuel')
  await smelt.collectFurnaces(bot)
  await smelt.refuelFurnaces(bot)
  phase('home: planning')
  const winNeeds = windowNeeds()
  const win = mats.planFor(bot, winNeeds)
  let tot = mats.planFor(bot, st.need)
  demandTrees = treesFor(tot)
  demandWool = tot.raw.white_wool || 0 // (the sheep's white: every coloured wool is dyed from it - materials PREFER)
  if (tot.unknown.length) log('dir', `no route known for ${tot.unknown.join(', ')} - gathering them as they are`)
  // furnaces for the volume, counted around HOME (counted around the bot at the site it found too few and
  // built six more)
  phase('home: furnace building')
  if (tot.smeltTotal > 0) {
    const furns = smelt.homeFurnaces(bot)
    const want = furnaceTarget(tot)
    if (furns.length < want) log('dir', `${furns.length} furnaces for ${tot.smeltTotal} smelts - building up to ${want}`)
    // (the cobble for all of them in one trip to the chest: 8 at a time was a walk in through the door per furnace)
    const need = 8 * Math.max(0, want - furns.length)
    if (need && inv.count(bot, 'cobblestone') < need) await base.withdraw(bot, 'cobblestone', need - inv.count(bot, 'cobblestone')).catch(() => 0)
    for (let i = furns.length; i < want && inv.count(bot, 'cobblestone') >= 8; i++) {
      if (!await smelt.placeFurnace(bot)) break
    }
  }
  // fuel for the queue: charcoal from logs beyond the ones the next layers build with (one log smelts eight;
  // the brick line stalled on fuel with cobble waiting in the chest)
  phase('home: charcoal')
  if (tot.raw.fuel > 0 && stock('coal') + stock('charcoal') < 32) {
    const spareLogs = Math.floor(smelt.woodSurplus(bot) / 4)
    // (never the build's own species: the most-stocked log was the orchard's spruce, and 31 of it went into the furnaces)
    const logName = Object.keys(Object.assign({}, inv.counts(bot), base.bankCounts())).filter(n => mats.LOG_ANY.test(n) && stock(n) > 0 && !mats.isReservedWood(bot, n)).sort((a, b) => stock(b) - stock(a))[0]
    if (logName && spareLogs >= 4) {
      const n = Math.min(32, spareLogs, stock(logName))
      if (inv.count(bot, logName) < n) await base.withdraw(bot, logName, n - inv.count(bot, logName))
      const loaded = await smelt.loadFurnaces(bot, logName, Math.min(n, inv.count(bot, logName)))
      if (loaded) log('dir', `burning ${loaded} ${logName} into charcoal for the smelting`)
    }
  }
  // the crafts that feed a furnace (stone -> stone bricks, to crack) are the queue's, the whole build's
  phase('home: feed crafts')
  const feed = tot.crafts.filter(c => mats.SMELT_INPUTS.has(c.item))
  if (feed.length) { await mats.makeCrafts(bot, feed, { keep: win.top, shouldStop: dayStop }); tot = mats.planFor(bot, st.need) }
  // the queue: what the window waits on first; an input the window also places itself (cobblestone) goes in
  // only beyond the window's own share
  phase('home: smelt queue')
  const winOut = new Set(win.smelts.map(s => s.output))
  for (const s of tot.smelts.slice().sort((a, b) => winOut.has(b.output) - winOut.has(a.output))) {
    if (dayStop()) break
    // (and a scaffold's worth of cobblestone kept back: the furnaces took the last of it for stone, and the build step went
    //  straight to the mine for 31 to stand on - a mine trip a round, 2026-09-28)
    // (one number with the builder's: what the other filler held or banked does not already cover)
    const keepBack = s.input === 'cobblestone' ? Math.max(0, build.SCAFFOLD_WANT - Object.keys(Object.assign({}, inv.counts(bot), base.bankCounts())).filter(n0 => n0 !== 'cobblestone' && build.FILLER_ITEMS.test(n0)).reduce((t, n0) => t + stock(n0), 0)) : 0
    const n = Math.min(s.n, stock(s.input) - (win.top[s.input] || 0) - keepBack, 64 * Math.max(1, smelt.homeFurnaces(bot).length))
    if (n < 1) continue
    const k = await loadSmelt(s.input, n)
    if (k) log('dir', `smelting ${k} ${s.input} -> ${s.output} (${s.n} more ${s.output} wanted for the ${st.name})`)
  }
  // the window's crafts, ingredients first (planks before stairs, bricks before brick stairs)
  phase('home: window crafts')
  const win2 = mats.planFor(bot, winNeeds)
  if (win2.crafts.length) {
    const made = await mats.makeCrafts(bot, win2.crafts, { keep: win2.top, shouldStop: dayStop })
    if (made) log('dir', `${made} crafts for the next layers (planned ${win2.crafts.map(c => c.crafts + 'x ' + c.item).join(', ')})`)
  }
}

// WHERE A CASTLE ROUND'S TIME GOES, by phase (one line a round): 248s of castle in a day placed one block, and nothing said
// whether it went to the home jobs, the withdraws, the site clearing or the step's walks (2026-09-28)
let roundPh = null
function phase (name) { if (!roundPh) return; const now = Date.now(); roundPh.acc[roundPh.cur] = (roundPh.acc[roundPh.cur] || 0) + now - roundPh.at; roundPh.cur = name; roundPh.at = now }
async function castleWork () {
  roundPh = { acc: {}, cur: 'start', at: Date.now(), t0: Date.now() }
  const d0 = (build.cachedStatus(bot) || {}).done
  try { return await castleWorkInner() } finally {
    phase('end')
    const tot = Date.now() - roundPh.t0; const d1 = (build.cachedStatus(bot) || {}).done
    if (tot > 5000) log('dir', `castle round: ${Math.round(tot / 1000)}s, placed ${roundPh.placed != null ? roundPh.placed : d1 != null && d0 != null ? d1 - d0 : '?'} - ${Object.entries(roundPh.acc).filter(([, v]) => v >= 500).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + Math.round(v / 1000) + 's').join(', ')}`)
    roundPh = null
  }
}
async function castleWorkInner () {
  const j = build.getJob()
  const st = build.cachedStatus(bot)
  // every block stands: the finishing round (scaffold down, holes filled). No latch - build.needsWork asks the
  // world again next time; nothing changed = a failure, so the chooser backs off (leftovers rest till tomorrow)
  if (st.done >= st.total) return build.finish(bot, { shouldStop: dayStop })
  const home = mem.get().home
  if (world.dist2(bot.entity.position, j.origin) > 64) {
    const r = await move.travel(bot, home || j.origin, { range: 4, shouldStop: homewardStop, label: 'to site' })
    if (!r.ok) return false
  }
  // HOME JOBS FIRST, while at home: the furnaces, the crafts, the window's blocks out of the chest, scaffold - then one
  // walk to the site. Clearing the site first sent the bot there for one leaf, home again for the furnaces and chests,
  // and back: two 60-block crossings and three minutes of every ten-minute day before a block went in (2026-09-26).
  phase('home jobs')
  await processAtHome()
  phase('scaffold+withdraw')
  // the scaffold first, then the window's blocks while two slots stay free: the other way round the window filled every
  // slot, the filler's withdraw failed "inventory full", and the cells over a drop at the site went unplaced for want
  // of a block to stand on (2026-09-27) - and each withdraw into a full pack was still a walk to a chest
  await build.ensureScaffold(bot, build.SCAFFOLD_WANT, { shouldStop: dayStop })
  await withdrawWindow(windowNeeds())
  // what does the next stretch of building need?
  const lowest = j.cells.filter(c => build.cellDone(bot, c) !== true)
  const minY = Math.min(...lowest.map(c => c.y))
  // site prep for the band being built only (next 3 layers + headroom): the rest of the footprint
  // is cleared as the walls rise, from the walls - never a whole day on a canopy 12 blocks up.
  // Leaves don't block building unless they sit in a cell; walking cuts through them.
  phase('site clearing')
  const bandTop = minY + 4
  const obs = build.unskippedObstructions(bot, { maxY: bandTop }).filter(b => !world.LEAF_RE.test(b.name) || j.index.has(build.key(b.position))).length
  if (obs > 0) {
    await build.ensureScaffold(bot, build.SCAFFOLD_WANT, { shouldStop: dayStop })
    const n = await build.clearSite(bot, { shouldStop: dayStop, maxBlocks: 200, maxY: bandTop })
    // (cleared: on to the building in the same round - ending it here sent the next round home for its home jobs)
    // nothing clearable right now: get on with materials meanwhile
  }
  // the build's own blocks laid where no cell wants them (the planner's stepping stones): taken back up
  phase('strays')
  {
    const strays = await build.strayBuildBlocks(bot)
    if (strays.length) {
      let n = 0
      for (const s of strays.slice(0, 30)) { if (dayStop()) break; if (await act.dig(bot, s, { force: true, allowZones: ['build', 'base'], timeoutMs: 30000 })) n++ }
      await act.collectDrops(bot, { radius: 8, maxMs: 5000 })
      log('dir', `took up ${n} of ${strays.length} build blocks standing where no cell wants them (${strays.slice(0, 6).map(s => s.name + '@' + s.x + ',' + s.y + ',' + s.z).join(' ')})`)
      if (n) return true
    }
  }
  // THE BOTTLENECK FIRST: the last step found the lowest layers waiting on a material (glass: its sand) - fetch it now,
  // while the day is young, before another step on the scattered cells the wait leaves. Built first, the sand trip was
  // judged at the day's end, never fit the daylight left, and 2 fuel was fetched instead - every day, 50 glass cells
  // holding the whole cathedral (2026-09-26).
  // (kept in memory: a module variable was wiped by every reload, and the morning's first round started blank)
  phase('bottleneck trip')
  if (mem.get().buildWaiting) {
    const want = mem.get().buildWaiting; mem.set('buildWaiting', null)
    const win0 = mats.planFor(bot, windowNeeds())
    const chain0 = Object.keys(mats.getPlanner(bot).plan({ [want]: 1 }).raw)
    // (fuel first when the furnaces have none: the chain's other raw is often in the chest already, waiting on it - 92 clay
    //  balls sat there while every morning went to more clay, and the fuel trip came at dusk, too late for a coal seam,
    //  2026-09-28)
    // (the test is the bottleneck itself - the planner's own: the window's smelts, stone from its cobble and bricks from
    //  its clay among them, less the coal and charcoal held and in the furnaces. One number, not a hand count; audit)
    const noFuel = (win0.raw.fuel || 0) > 0
    const raw0 = (noFuel && chain0.includes('fuel') ? 'fuel' : null) || chain0.find(r => r !== 'fuel' && win0.raw[r] > 0) || chain0.find(r => win0.raw[r] > 0)
    const fits = r => r !== 'clay_ball' && r !== 'sand' ? world.ticksUntilNight(bot) > 2400 : (r === 'sand' ? !clay.exhausted('sand') && clay.tripFits(bot, 'sand') : !clay.exhausted() && clay.tripFits(bot))
    if (raw0 && fits(raw0)) {
      log('dir', `the build waits on ${want} - ${win0.raw[raw0]} ${raw0} first, while the day is young`)
      // (a packful - see the round's gather below: the whole build's shortfall, from the cached castle status)
      let whole = 0; try { const cs = build.cachedStatus(bot); whole = cs ? (mats.planFor(bot, cs.need).raw[raw0] || 0) : 0 } catch {}
      const ok0 = await gatherFor(raw0, Math.max(win0.raw[raw0], Math.min(whole, tripRoom())))
      if (inv.freeSlots(bot) < 8 || ok0) await base.depositHaul(bot, { shouldStop: dayStop })
      if (ok0) return true
    }
  }
  // the same window the builder works in (it builds past a missing material, so the bricks for those layers
  // must come out of the chest too - with glass short, nothing was withdrawn and nothing built)
  phase('window')
  const next = windowNeeds()
  // withdraw what we have for it (anything that stands in: birch stairs for jungle stairs)
  await build.ensureScaffold(bot, build.SCAFFOLD_WANT, { shouldStop: dayStop })
  await withdrawWindow(next)
  let carrying = 0
  for (const name of Object.keys(next)) carrying += countOf(name)
  let blockedOn = null
  // (starved of stone: straight to the mine, not a build step over the few cells in hand - eight minutes placed one
  //  block 58 away while the next layers were 1900 cobblestone short, and the mine got the last three, 2026-09-27)
  const winShort = mats.planFor(bot, next).raw.cobblestone || 0
  if (winShort > 512 && countOf('cobblestone') < 64) { log('dir', `${winShort} cobblestone short with ${countOf('cobblestone')} in hand - mining first`); carrying = 0 }
  if (carrying > 0) {
    phase('build step')
    const r = await build.buildStep(bot, { shouldStop: dayStop, maxMs: 8 * 60000 })
    phase('after step')
    if (roundPh) roundPh.placed = (roundPh.placed || 0) + (r.placed || 0) // (the step's own count: the cached status lags)
    log('dir', `build step: placed ${r.placed}${r.blockedOn ? (r.blockedHolds ? ', waiting on ' + r.blockedOn : `, ${r.blockedOn} missing (detached - holding nothing)`) : ''}`) // (a wait nobody is in is not named as one: "waiting on oak_trapdoor" for two hours held nothing, 2026-09-29; audit)
    blockedOn = r.blockedHolds ? r.blockedOn : null // (what the round steers by: only what holds the band)
    // (infill - glass, bars, lanterns - waited on while the structure still rises is no morning's errand: the sand
    //  for 50 windows took every morning's best hours while 30k blocks of wall could go up; it comes last)
    // (and only an item that holds the band: one with none in stock is named when nothing else is missing, and its trip
    //  first thing in the day - 31 fuel for one coal block - was the day's building time, 2026-09-28)
    mem.set('buildWaiting', r.blockedOn && r.blockedHolds && !build.infillItem(r.blockedOn) ? r.blockedOn : null)
    if (r.placed > 0 && !blockedOn) return true
    // every cell still missing has failed, with the blocks in hand: our own scaffold may be what is in the way. Two
    // wall torches in a room whose floor was full of scaffold (a 1-high gap left under the ceiling, nowhere to stand)
    // waited on a teardown that waited on them - 718/720 for good (2026-09-24). Take the scaffold down now.
    if (r.stalled && build.scaffoldList(bot).length) {
      log('dir', `the last ${st.total - st.done} blocks all failed - taking the scaffold down, it may be in their way`)
      const n = await build.removeScaffold(bot, { shouldStop: dayStop })
      return n > 0
    }
  }
  // gather ONE raw material. The window's own shortfall first (the one the builder is blocked on at its head);
  // a supplied window - or one only waiting on the furnaces - spends the daylight on the long pole of the whole
  // build (clay, for a brick build: its trips start as soon as nothing nearer blocks the builder)
  const win = mats.planFor(bot, next)
  const tot = mats.planFor(bot, build.cachedStatus(bot).need)
  // (infill - glass - named as the wait never steers the gathering while the structure's own blocks are short: with no
  //  cobblestone left at all the builder "waited on glass" and every trip went looking for sand, 2026-09-27)
  const steer = blockedOn && build.infillItem(blockedOn) && Object.keys(mats.planFor(bot, windowNeeds()).raw).some(r => r === 'cobblestone') ? null : blockedOn
  const chain = steer ? Object.keys(mats.getPlanner(bot).plan({ [steer]: 1 }).raw) : []
  const blockedRaw = chain.find(r => r !== 'fuel' && win.raw[r] > 0) || chain.find(r => win.raw[r] > 0) || null
  // (the builder waits on an item whose raw the next layers' shortfall does not hold: said, with both sides - the band
  //  waited on oak_trapdoor for two hours while the rounds gathered leather and wool, 2026-09-29)
  if (steer && !blockedRaw && steerSaid !== steer) { steerSaid = steer; log('dir', `the builder waits on ${steer} (its raw: ${chain.join(', ') || 'none - in stock or craftable from stock'}), but the next layers' shortfall has none of it: ${Object.keys(win.raw).map(r => win.raw[r] + ' ' + r).join(', ') || 'nothing'}`) }
  // a trip needs a working day ahead of it: close to dusk only what is gathered round home (a walk to the mine
  // face that arrived as dusk fell was a minute and a half for nothing; a clay bank is further still)
  const nearDusk = world.ticksUntilNight(bot) < 2400
  const feasible = r => {
    if (!mats.hasRoute(r)) return false // (no skill for it yet: its cells wait, never a trip)
    if (r === 'clay_ball') return !clay.exhausted() && clay.tripFits(bot)
    if (r === 'sand') return !clay.exhausted('sand') && clay.tripFits(bot, 'sand')
    if (nearDusk && /^(cobblestone|granite|raw_iron|wool|red_flower)$/.test(r)) return false
    return true
  }
  // an input already in the chest that only lacks fuel (66 clay balls "waiting in the chest" while the bot went
  // for more clay, 2026-09-23): the fire is the bottleneck, not the input
  // (only when what the builder waits on is smelted - or it waits on nothing: blocked on plain cobblestone, "fuel
  //  first" sent every day to cut logs for charcoal while the walls stood still for want of stone, 2026-09-26)
  const fuelBound = (!blockedOn || chain.includes('fuel')) && (win.raw.fuel || tot.raw.fuel || 0) > 0 && win.smelts.concat(tot.smelts).some(sm => sm.input && sm.input !== '#log' && mats.stock(bot, sm.input) > 0)
  // (the cost of ONE cell for each item of the next layers not covered by stock, per raw the cheapest: pickRaw's order after
  //  the band's own bottleneck - cheapest cells first, the bookshelves' long chain last; a plan an item, yielded between)
  // (priced by the RECIPE, never the pantry: planned against the stock, a raw the chest half covers - 10 of 47 cobblestone -
  //  priced nothing and sorted LAST, behind the chains with nothing banked; audit. A cell's cost is the job's constant:
  //  memoized an item)
  const perCell = {}
  { const pl = mats.getPlanner(bot); if (pl !== cellCostPlanner) { cellCost.clear(); cellCostPlanner = pl } }
  for (const item of Object.keys(next)) {
    let m = cellCost.get(item)
    if (!m) {
      let r = null; try { r = mats.getPlanner(bot).plan({ [item]: 1 }) } catch {}
      const raws = Object.entries((r && r.raw) || {}).filter(([, v]) => v > 0)
      m = { raws: raws.map(([k]) => k), c: raws.reduce((a, [k, v]) => a + v * mats.rawCost(k), 0) }
      cellCost.set(item, m)
    }
    for (const k of m.raws) perCell[k] = Math.min(perCell[k] != null ? perCell[k] : Infinity, m.c)
  }
  const pick = mats.pickRaw(fuelBound && !win.raw.fuel ? Object.assign({ fuel: tot.raw.fuel }, win.raw) : win.raw, tot.raw, { blockedRaw: fuelBound ? 'fuel' : blockedRaw, feasible, perCell })
  if (!pick) {
    buildFocus = { at: Date.now(), gathering: null, builderWaitsOn: blockedOn || null, waitingOnFurnaces: win.smelts.map(s => s.n + ' ' + s.output), shortInAll: Object.fromEntries(Object.entries(tot.raw).sort((a, b) => b[1] - a[1]).slice(0, 8)) }
    const waiting = win.smelts.length ? `the furnaces (${win.smelts.map(s => s.n + ' ' + s.output).join(', ')})` : 'nothing'
    if (Object.keys(tot.raw).length) log('dir', `nothing to gather now (${Object.keys(tot.raw).map(r => tot.raw[r] + ' ' + r).join(', ')} still short, none fits the hour${clay.exhausted() ? '; no clay in range' : ''}) - waiting on ${waiting}`)
    return nearDusk ? false : !!win.smelts.length
  }
  log('dir', `${st.name} needs ${pick.short} more ${pick.raw} - ${pick.why}${pick.raw === blockedRaw ? ` (the builder waits on ${blockedOn})` : ''}; still short in all: ${Object.keys(tot.raw).map(r => tot.raw[r] + ' ' + r).join(', ')}`)
  buildFocus = { at: Date.now(), gathering: pick.raw, short: pick.short, why: pick.why, builderWaitsOn: blockedOn || null, shortInAll: Object.fromEntries(Object.entries(tot.raw).sort((a, b) => b[1] - a[1]).slice(0, 8)) }
  // (a PACKFUL, not the next few layers: gathering the window's want, building it, and going back out for the next
  //  window's was most of the castle's time - 26 of 119 minutes placing, the rest fetching in small trips, 2026-09-28.
  //  The whole build's shortfall, up to the room in the pack; the day's stop still ends the trip in time)
  const ok = await gatherFor(pick.raw, Math.max(pick.short, Math.min(tot.raw[pick.raw] || 0, tripRoom())))
  if (inv.freeSlots(bot) < 8 || ok) await base.depositHaul(bot, { shouldStop: dayStop })
  // (a round the dusk cut short is no failure: counted as one, the backoff held the next morning's castle round
  //  minutes - "castle did not succeed (4 in a row)" after a step that placed 24, 2026-09-27)
  return ok || (dayStop() && !taskCancelled())
}

// One trip for one RAW material of the plan (materials.js names them): the batch a trip is worth.
// A trip too far for what is left of today waits for the next dawn: without the mark the director asked again at once,
// the chop answered "too far" at once, and the castle loop spun through it twice a second (2026-09-28)
// (cleared on a phase edge - a night seen, then day - never on a size: a mark set just after dawn, the likeliest one,
//  could never see more daylight left than that and stayed put till a restart - audit 2026-09-28)
const notToday = new Map() // raw -> { day } (the day it was put off - open again on a later one: day.js)
// (a night slept through passes inside the sleep task, often from dusk before the loop ever sees "night": the clock
//  wrapping back past dawn counts as one too - audit 2026-09-28)
function watchNights () { day.dayNo(bot) } // (THE day is read every tick - day.js - so no edge is missed between its readers)
// AN EXPEDITION: a wood whose country lies beyond any day's round trip (even one started at dawn) is fetched the way a
// player would - out for days, the nights camped (the carried bed, else dug in: the night rules do that wherever we
// are), leads followed from wherever the bot stands, a pack of logs and the saplings for the orchard at home carried
// back. Without it the frontier passed 600b and the castle's 535 spruce logs could never be reached (2026-09-28).
// Only fed, whole and armed; home again on a full pack, a searched-out country, a death, or MAX_NIGHTS out.
const DAWN_TICKS = 12900 // (the most daylight a day holds: ticksUntilNight at sunrise)
const MAX_NIGHTS = 3
// (three nights and the walk back is days of a working body - and a taiga is thin on animals: a full pack of food out,
//  and home when it runs low rather than a forage trip 900b from the farm - audit 2026-09-28)
const FOOD_OUT = 50; const FOOD_BACK = 10
const EXPEDITION_HP = 14 // (out there the walk goes on only this whole: no help, no grave run, the next mob unseen)
// (an axe a stack of logs: 535 of spruce wear out four stone axes - cobblestone in the pack, and the kit's table and the
//  tools rule make the next one out there, never a wooden one of the planks - audit 2026-09-28)
const COBBLE_OUT = 6
async function startExpedition (raw, land) {
  if (expedition()) return true // (one at a time: the castle loop's second ask found it already set out)
  // packed from the bank while home is a short walk (the castle loop asks from the site): the food first - the pack's
  // own food only ever rises to the food rule's line, so a gate on it alone waited every day for ever - and the
  // cobblestone for the axes (audit 2026-09-28)
  let packed = false
  if (base.distHome(bot) < 64) {
    for (const name of inv.GOOD_FOOD) {
      if (inv.foodPoints(bot) >= FOOD_OUT) break
      if (base.bankCount(name) > 0) await base.withdraw(bot, name, Math.min(16, base.bankCount(name))).catch(() => 0)
    }
    if (inv.count(bot, 'cobblestone') < COBBLE_OUT) await base.withdraw(bot, 'cobblestone', COBBLE_OUT - inv.count(bot, 'cobblestone')).catch(() => 0)
    packed = true
  }
  const food = inv.foodPoints(bot)
  // (and armour - 8 points - or a shield worn: out for nights on a naked body after the day's deaths is a grave far out; audit)
  const guarded = inv.armorPoints(bot) >= 8 || inv.offhandShield(bot)
  if (food < FOOD_OUT || bot.health < 16 || !inv.bestWeapon(bot) || !inv.bestTool(bot, 'axe', 1) || !guarded) { log('dir', `${raw}: its country is past a day's walk - an expedition waits on ${food < FOOD_OUT ? 'food (' + food + ' pts packed' + (packed ? ', the bank included' : ' (the bank not reached from here)') + ', ' + FOOD_OUT + ' wanted - cooking and the farm make the rest)' : bot.health < 16 ? 'health' : !guarded ? 'armour (8 points) or a shield - the iron gear first' : 'a weapon and an axe'}`); return false }
  mem.set('expedition', { raw, to: land ? { x: land.x, z: land.z, biome: land.biome } : null, phase: 'out', at: Date.now(), nights: 0, day: day.dayNo(bot), dry: 0, packed })
  log('dir', `${raw}: its country is past a day's walk - setting out on an expedition${land ? ' toward the ' + land.biome : ''} (${food} food pts, nights camped on the way)`)
  return true
}
function expedition () { return mem.get().expedition || null }
function endExpedition (why) { const e = expedition(); if (!e) return; if (e.phase !== 'back') { e.phase = 'back'; e.why = why; mem.set('expedition', e); log('dir', `expedition for ${e.raw}: ${why} - heading home`) } }
// (nights out: the same phase edge as notToday - night seen, or the clock wrapping past dawn in a bed)
function watchExpedition () {
  const e = expedition(); if (!e) return
  const dn = day.dayNo(bot)
  if (e.day == null) { e.day = dn; mem.set('expedition', e) }
  if (dn > e.day) {
    e.nights += dn - e.day; mem.set('expedition', Object.assign(e, { day: dn })) // (a new day: day.js)
    log('dir', `expedition for ${e.raw}: dawn after night ${e.nights} - ${inv.count(bot, e.raw)} ${e.raw} in the pack, ${inv.foodPoints(bot)} food pts, ${Math.round(base.distHome(bot))}b from home`)
    // (the nights are for finding it: its country found at the end - a grove sighted on the third evening, 1300b out -
    //  gets one more day to fill the pack, not a turn for home empty-handed with the trees in view; 2026-09-28)
    if (e.phase === 'out' && e.nights >= MAX_NIGHTS) {
      const land = gather.speciesLand(e.raw, bot.entity.position)
      if (land && land.d < 300 && !e.extended && inv.foodPoints(bot) >= FOOD_OUT / 2) { e.extended = true; mem.set('expedition', e); log('dir', `expedition for ${e.raw}: ${e.nights} nights out, but its country (the ${land.biome}) is ${Math.round(land.d)}b off - one more day to fill the pack`) } else endExpedition(`${e.nights} nights out`)
    }
  }
  // (nearly died out there - down to the hurt line: a player 600b from home in pillager country goes home, healed first,
  //  not on to the next lead into the same danger - audit 2026-09-28)
  if (e.phase === 'out' && bot.health > 0 && bot.health <= reflex.hurtLine()) endExpedition(`nearly died - hp ${Math.round(bot.health)}`)
  // (died out there: respawned at home - not walked straight back out; the graves and the next dawn decide)
  const d = (mem.get().deaths || []).slice(-1)[0]
  if (d && d.t > e.at) { mem.set('expedition', null); log('dir', `expedition for ${e.raw}: died on it - called off`) }
}
// AN ANIMAL TRIP THAT FOUND NONE is not made again today: animals round home never respawn, and a wool trip that found no
// sheep 144-240 out went again every round - five minutes each, nothing placed, all afternoon (2026-09-29). A trip cut
// short by a stop found nothing because it looked at nothing, and stays open. Open again the next day (notToday, day.js)
const ANIMAL_RAW = /^(wool|white_wool|leather|feather)$/
async function gatherFor (raw, short) {
  reflex.setCautious(true) // (an optional trip does not fight: cover over a charge - reflex.setCautious)
  let ok = false
  // (pack and bank: the trip's own start empties the pack into the chests)
  const re = new RegExp(`^${raw}$`)
  const got = () => inv.count(bot, re) + Object.entries(base.bankCounts()).filter(([n]) => re.test(n)).reduce((a, [, c]) => a + c, 0)
  const had = got()
  try { ok = await gatherForInner(raw, short); return ok } finally {
    reflex.setCautious(false)
    // (none at all: a trip that got some fell short, and found where they are)
    if (!ok && got() <= had && ANIMAL_RAW.test(raw) && !notToday.has(raw) && !dayStop()) { notToday.set(raw, { day: day.dayNo(bot) }); log('dir', `${raw}: the trip found none - not again today`) }
  }
}
async function gatherForInner (raw, short) {
  const put = notToday.get(raw)
  if (put) { if (!(day.dayNo(bot) > put.day) || world.isNight(bot)) return false; notToday.delete(raw); log('dir', `${raw}: a new day - the trip is open again`) }
  // AN EMPTY PACK FOR THE TRIP: a trip is sized by the room in the pack, and the pack left home with what the builder
  // had drawn out and the last trips brought - 300-400 items stored only after the walk back ("home with 405 items to
  // store", 2026-09-28). At home, the haul goes in first: the same line as the deposit's own (haulSize >= 64)
  if (base.distHome(bot) < 24 && (mem.get().chests || []).length && haulSize() >= 64) {
    const before = inv.freeSlots(bot)
    // (never the trip's own footing: filler stays for the planner's steps and a tower out of a pit - audit)
    // (SCAFFOLD_WANT of ANY filler, the most plentiful first: with no cobble but a stack of andesite, the andesite stays)
    const fill = {}; let need = build.SCAFFOLD_WANT
    for (const [n, c] of Object.entries(inv.counts(bot)).filter(([n]) => build.FILLER_ITEMS.test(n)).sort((a, b) => b[1] - a[1])) { const t = Math.min(c, need); if (t > 0) { fill[n] = t; need -= t } }
    await base.depositAll(bot, { keep: (b, i) => Math.max(base.keepCount(b, i), fill[i.name] || 0) }).catch(() => false)
    log('dir', `emptied the pack for the ${raw} trip: ${before} -> ${inv.freeSlots(bot)} free slots`)
  }
  const batch = Math.min(short, tripRoom())
  const ctx = { shouldStop: dayStop }
  switch (raw) {
    // clay: a big batch - the walk to the water costs more than the digging (up to 64 blocks, 256 balls)
    case 'clay_ball': return clay.gather(bot, Math.min(short, 256), ctx)
    // sand: nearly all of it lies on the sea and lake beds here - the clay skill's wading and diving takes it (the
    // dry-land gather brought 5-23 a trip toward 2300 glass, 2026-09-25); a pack-full batch, the walk is long
    case 'sand': return clay.gather(bot, batch, ctx, 'sand')
    // cobble; the furnaces make stone of it in the background
    case 'cobblestone': return mining.mineFor(bot, 'cobblestone', inv.count(bot, 'cobblestone') + batch, ctx)
    case 'log': {
      // the orchard's grown trees first (a short walk, and the spot replanted); then wild wood
      if (await orchard.harvest(bot, { logs: batch, demandTrees, shouldStop: dayStop }) >= Math.min(batch, 16)) return true
      // whatever wood grows nearest (every wood cell and wooden form takes local wood)
      const w = nearestWood() + '_log'
      return craft.ensure(bot, w, inv.count(bot, w) + batch, Object.assign({ noWithdraw: true, leaves: orchard.wantSaplings(bot, demandTrees) > 0 }, ctx))
    }
    case 'fuel': {
      // LAVA BEFORE COAL: a lava bucket is a hundred smelts, a coal eight - and the coal trips brought five a go while the
      // castle's bricks and stone waited (2026-09-28). Only with an empty bucket to hand (pack, bank, or made of three
      // ingots already smelted - no iron trip for it) and a pool known or in sight that is safe to fill from (the rules
      // are forage.lavaStands'); the buckets asked for are what the shortfall needs, a hundred smelts each. Filled, they
      // go home and into the cold furnaces at once (refuelFurnaces - putFuel takes a lava bucket for a big batch); the
      // rest wait as fuel the loader draws on. None filled: the coal below, as before.
      if (forage.bucketsAvailable(bot) > 0 && await forage.lavaKnown(bot)) {
        const want = Math.max(1, Math.min(Math.ceil(short * 8 / 100), forage.bucketsAvailable(bot)))
        log('dir', `short of ${short} fuel for the furnaces - ${want} lava bucket${want > 1 ? 's' : ''} first (a hundred smelts each)`)
        const got = await forage.lavaFuel(bot, want, ctx).catch(e => { log('dir', `the lava trip threw: ${e.message}`); return 0 })
        if (got > 0) {
          const r = await base.goHome(bot, { shouldStop: dayStop })
          if (r.ok) await smelt.refuelFurnaces(bot).catch(() => 0)
          return true
        }
      }
      // COAL FIRST: the orchard is the build's own species (never burnt), the other trees round home are cut out - 65
      // "cutting logs for charcoal" in two days and not one log into the furnaces since the morning, the clay and the
      // cobble waiting in the chest (2026-09-28). A coal seam at the mine's depth is 8 smelts an ore, and the trip brings
      // the build's cobble back with it. Charcoal from logs stays the way when no coal comes.
      // (by DAY from the outcrops - coal peaks near y96, and the hills round home show it in the rock face: 268 in sight at
      //  y~100 while the y39 mine's walls give it thinly; a walk out past the grounds, then the vein. Started only with the
      //  day to finish it: the first trip began at dusk and came home with 0 of 8; audit 2026-09-28)
      if (world.ticksUntilNight(bot) > 2400) {
        const c0 = inv.count(bot, 'coal')
        const want = Math.min(Math.ceil(short / 8), Math.max(8, Math.floor(tripRoom() / 2)))
        const home = mem.get().home
        // (exposed to the SKY: air beside it that sees the sky - a cave wall's coal has air beside it too, and the walk there
        //  is a day walk into the dark; audit)
        const skyFace = b => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => { const q = { x: b.position.x + dx, y: b.position.y + dy, z: b.position.z + dz }; const a = world.at(bot, q.x, q.y, q.z); return a && world.isAirish(a) && world.openSky(bot, q) })
        // (outcrop after outcrop while the day holds and the count is short: one vein gave 5 of 17 and the trip went home,
        //  2026-09-28. Each a fresh sky-face pick past the ones worked, the trip's work kept local to each; four at most)
        const worked = []
        let tried = 0
        // (a site a shooter covers, or a creeper walks, is no coal site: the valley under the outcrop had both, and the bot
        //  died there with 250 items, 2026-09-28; audit)
        const unsafe = pos => Object.values(bot.entities).some(e => e && e.position && ((reflex.RANGED.has(e.name) && e.position.distanceTo(pos) < 20) || (e.name === 'creeper' && e.position.distanceTo(pos) < 12)))
        const pick = async () => {
          const seen = home ? await world.scanBlocks(bot, /^(coal_ore|deepslate_coal_ore)$/, { maxDistance: 96, count: 200, point: home, filter: b => world.dist2(b.position, home) > 48 && !move.inZone(b.position, 2) && !gather.onGrounds(b.position) && skyFace(b) && !worked.some(w => world.dist3(w, b.position) <= 8) && !unsafe(b.position) }).catch(() => []) : []
          const me = bot.entity.position
          return seen.sort((a, b) => world.dist3(a.position, me) - world.dist3(b.position, me))[0]
        }
        let o = await pick()
        if (o) {
          while (o && tried < 4 && inv.count(bot, 'coal') - c0 < want && world.ticksUntilNight(bot) > 2400 && !dayStop()) {
            tried++
            log('dir', `short of ${short} fuel for the furnaces - ${want - (inv.count(bot, 'coal') - c0)} coal from the outcrop at ${move.fmt(o.position)}`)
            worked.push(o.position)
            // (to the open air in front of the rock face, not the ore block: aimed at the block at y96, the walk dug down under
            //  the castle toward it, 2026-09-28 - the cell that sees the sky is reached over the ground)
            const face = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => ({ x: o.position.x + dx, y: o.position.y + dy, z: o.position.z + dz })).find(q => { const a = world.at(bot, q.x, q.y, q.z); return a && world.isAirish(a) && world.openSky(bot, q) }) || o.position
            const r = await move.travel(bot, face, { range: 2, shouldStop: dayStop, label: 'to the coal' })
            if (r.ok) await mining.takeKnownOre(bot, 'coal', c0 + want, Object.assign({}, ctx, { near: { point: o.position, radius: 8 }, oreFilter: b => world.dist3(b.position, o.position) <= 3 || skyFace(b) })).catch(() => false)
            o = await pick()
          }
          // (the outcrops round home spent and the count still short: the mine's walls for the rest while the day holds - one
          //  hillside gave 5 of 11 and the trip went to logs, 2026-09-28)
          if (inv.count(bot, 'coal') - c0 < want && world.ticksUntilNight(bot) > 2400 && !dayStop()) {
            log('dir', `the outcrops round home are worked - the mine's walls for ${want - (inv.count(bot, 'coal') - c0)} more coal`)
            await mining.mineFor(bot, 'coal', c0 + want, ctx).catch(() => false)
          }
        } else {
          log('dir', `short of ${short} fuel for the furnaces - no coal in sight past the grounds, the mine's walls for ${want}`)
          await mining.mineFor(bot, 'coal', c0 + want, ctx).catch(() => false)
        }
        const got = inv.count(bot, 'coal') - c0
        log('dir', `the coal trip brought ${got} of ${want} coal${got < want ? " - the rest as charcoal from logs" : ""}`)
        if (got > 0) return true
      }
      log('dir', `short of ${short} fuel for the furnaces - cutting logs for charcoal`)
      // the orchard's grown trees first: they burn as well as any
      const fromOrchard = await orchard.harvest(bot, { logs: Math.ceil(short * 8 / 7), demandTrees, shouldStop: dayStop })
      if (fromOrchard >= 8) {
        const r0 = await base.goHome(bot, { shouldStop: dayStop })
        // (only what the orchard just gave - the build's own logs in the pack are not fuel)
        if (r0.ok) { let left = fromOrchard; let burnt = 0; for (const [n, c] of Object.entries(inv.counts(bot))) { if (left <= 0) break; if (mats.LOG_ANY.test(n) && c > 0) { const k = Math.min(c, left); left -= k; burnt += await smelt.burnForCharcoal(bot, n, k) } } if (burnt > 0) return true }
      }
      const w = nearestWood() + '_log'
      const before = inv.count(bot, w)
      // (a log's charcoal smelts 8 and burning it costs an eighth: 8/7 logs a unit of fuel)
      const ok = await craft.ensure(bot, w, before + Math.min(tripRoom(), Math.max(8, Math.ceil(short * 8 / 7))), Object.assign({ noWithdraw: true, leaves: orchard.wantSaplings(bot, demandTrees) > 0 }, ctx))
      const cut = inv.count(bot, w) - before
      // these logs are the fuel: straight into the furnaces as charcoal (never into the build's wood pool)
      if (cut >= 2) { const r = await base.goHome(bot, { shouldStop: dayStop }); if (r.ok) return (await smelt.burnForCharcoal(bot, w, cut)) > 0 }
      return ok
    }
    case 'wool': case 'white_wool': return food.woolFor(bot, Math.min(short, 16), ctx)
    case 'red_flower': return gather.pickPlants(bot, /^(poppy|red_tulip|rose_bush)$/, /^(poppy|red_tulip|rose_bush)$/, Math.min(short, 16), ctx)
    default:
      // forage skills: one gatherer each; a source searched out round home is marked (its cells wait, another is used)
      if (forage.handles(raw)) return forage.gather(bot, raw, batch, ctx)
      // sand, dirt, gravel, raw iron: the generic route (surface digging, the mine)
      {
        const before = inv.count(bot, raw)
        const t0 = Date.now()
        const ok = await craft.ensure(bot, raw, before + batch, ctx)
        // a species log (exact wood) that no trip finds is searched out round this home like any forage source: its cells
        // wait instead of a daily trip for dark oak that does not grow here (audit #14) - but only a real search counts: a
        // trip cut short by dusk, danger or a full pack is not "none here" (R7, 2026-09-27)
        if (mats.LOG_ANY.test(raw) && !taskCancelled()) {
          const o = gather.lastChopOutcome()
          const searched = !!o && o.item === raw && o.at >= t0 && o.outcome === 'none-found'
          if (o && o.item === raw && o.at >= t0 && o.outcome === 'too-far') {
            // (past the daylight left - the day's round trip, or a whole day's - it sets out anyway while a real stretch of the day
            //  is left, and camps where the night finds it: waited for a dawn start, the 424b dark oak trip was "not today" every
            //  afternoon and the castle stood on it (the operator, 2026-09-28))
            if ((o.trip > DAWN_TICKS || world.ticksUntilNight(bot) > 2400) && await startExpedition(raw, o.land)) { /* (logged there) */ } else { notToday.set(raw, { day: day.dayNo(bot) }); mem.set('farTrip', { raw, land: o.land || null }); log('dir', `${raw}: not today - too far for the daylight left - first thing tomorrow`) }
          }
          forage.noteTrip(raw, inv.count(bot, raw) - before, searched ? 'no trees of it found' : `cut short (${o && o.at >= t0 ? o.outcome : 'no chop ran'})`, { searched })
        }
        return ok
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
      watchNights(); watchExpedition()
      const d = decide()
      const k = d.name + '|' + d.why
      if (k !== lastDecisionKey) { lastDecisionKey = k; log('dir', `-> ${d.name}: ${d.why}`); recentDecisions.push({ at: Date.now(), name: d.name, why: d.why }); if (recentDecisions.length > 8) recentDecisions.shift() }
      current = { name: d.name, why: d.why, since: Date.now() }
      const fn = TASKS[d.name]
      let ok = false
      const scope = control.begin() // (the task's scope: an abort cancels everything it still begins - control.js)
      taskCancelled = scope.cancelled
      running = true
      try { ok = await scope.run(fn) } catch (e) { log('dir', `${d.name} threw: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message}`) }
      if (!taskCancelled()) { try { await craft.packUpTables(bot) } catch {} } // (the task's field tables, once it is over - never after an operator stop, audit #40)
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

// what the bot has been doing lately, for whoever asks (the brain answers "what are you up to" from it)
const recentDecisions = []
// the build's material picture as last judged - what the brain says when asked how the build is going
let buildFocus = null
// (in players' words: the planner's node names - log, fuel, clay_ball, red_flower - parroted in chat read like a bot; the audit)
const SAY_NAME = { log: 'logs (any wood)', planks: 'planks (any wood)', fuel: 'coal or charcoal', clay_ball: 'clay', red_flower: 'red flowers', wool: 'wool', wood_slab: 'wooden slabs', stripped_log: 'stripped logs' }
const sayName = n => SAY_NAME[n] || String(n).replace(/!$/, '').replace(/^(\w+)_flower$/, '$1 flowers').replace(/_/g, ' ')
const sayCounts = o => o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [sayName(k), v])) : o
function focus () {
  if (!buildFocus) return null
  const f = Object.assign({ judgedMinutesAgo: Math.round((Date.now() - buildFocus.at) / 60000) }, buildFocus)
  if (f.gathering) f.gathering = sayName(f.gathering)
  f.shortInAll = sayCounts(f.shortInAll)
  return f
}
function recent () { const now = Date.now(); return recentDecisions.map(r => `${Math.round((now - r.at) / 60000)}m ago: ${r.name} - ${r.why}`) }
async function start (b) {
  bot = b
  // the planner exists from the start: until the first plan, unsourced() answered "sourced" for everything (audit #36)
  try { mats.getPlanner(bot) } catch {}
  // respawned inside the safehouse: the door shut before anything else (a door left open under a patrol was a window
  // for their arrows at every respawn, 2026-09-26)
  bot.on('spawn', () => { setTimeout(() => { try { if (bot.entity && move.insideHut(world.feetPos(bot))) hut.shutDoor(bot).catch(() => {}) } catch {} }, 1500) })
  baseZone()
  orchard.setZone()
  pen.setZone()
  const bj = mem.get().build
  if (bj) { try { await build.setJob(bot, bj.name, bj.origin, { exactWood: bj.exactWood === true }) } catch (e) { log('dir', `couldn't load build ${bj.name}: ${e.message}`) } } // (jobs saved before the wood rule: any wood, as they were built)
  loop()
}

function info () { return current ? { name: current.name, detail: current.why, forSec: Math.round((Date.now() - current.since) / 1000) } : null }
function setPaused (p) { const was = paused; paused = !!p; if (paused) { control.abort(); move.stopMoving(bot) } if (was !== paused) log('dir', paused ? 'paused' : 'resumed') }
async function waitIdle (maxMs = 30000) { const t0 = Date.now(); while (running && Date.now() - t0 < maxMs) await move.sleep(200) }
function forceTask (name) { if (!TASKS[name]) return false; override = name; control.abort(); return true }

module.exports = { focus, recent, start, info, setPaused, forceTask, decide, TASKS, waitIdle, isPaused: () => paused }
