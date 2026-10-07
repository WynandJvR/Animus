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
const foreign = require('./foreign')
let litterSeeded = false // (the pillars from before the ledger: looked for once a run, once the orchard's zone is set)
// (before EITHER tidy rung counts: called from the castle's-gap rung only, it never ran - the castle always has work, and
//  the tidies came from the before-the-castle rung; the stairs the operator asked about stood on, forgotten, 2026-09-30)
function seedLitter () { if (!litterSeeded && orchard.orchard()) { litterSeeded = true; litter.seed(bot) } }
const LITTER_BATCH = 8
let steerSaid = null // (the wait-without-raw line, once per item)
const strayMiss = mem.persistedMap('strayMiss') // (a stray build block that would not come up: key -> { n, day })
let siteTidyAsked = 0 // (when the site's scaffold was last counted for the day's teardown)
let idleTidyAsked = 0 // (and for an idle hour's: the same 5-minute bound on the site diff)
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
let bootReady = false // (the boot's build load and base heal done: a movebase before it raced the load, 2026-10-06 audit)
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
// THE FOOD STOCK: every good food in the pack and the bank, in food points, the wheat as the bread it makes - the one measure
// the farm's work is judged by. Counted in bread alone, 130 points of cooked food in the pack read as "bread short": the farm
// re-planted ONE cell a round, four times in three minutes, a 2-minute seed walk for one cell, and harvested 0-3 plants,
// a chore a round in the build's daylight, 2026-10-07. (32 bread's worth, as before)
const FOOD_WANTED = 32 * 5
function foodStock () {
  const md = world.data(bot); const pts = n => { const f = md.foodsByName && md.foodsByName[n]; return f ? f.foodPoints : 3 }
  let p = 0; for (const n of inv.GOOD_FOOD) { const k = inv.count(bot, n) + base.bankCount(n); if (k) p += k * pts(n) }
  return p + Math.floor((inv.count(bot, 'wheat') + base.bankCount('wheat')) / 3) * pts('bread')
}
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
// (at the hurt line a day trip stops whether or not food is at hand: tooHurt's "and can heal" let an iron trip walk on at hp 5
//  with nothing to eat into the skeletons at the mine's mouth - dead, 2026-10-02. With no food, the director's food rule
//  is the answer, never the trip)
// the day's last stretch: the walk home starts here, and at home the build's prep (one number for both)
const EVENING = 10500
// (a hostile about home on the surface, as the hideout reads it - bats aside: the evening's prep stops for it)
function prepThreat () { return reflex.hostiles(16).some(h => h.e.name !== 'bat' && Math.abs(h.e.position.y - bot.entity.position.y) < 6) }
// the pen's jobs done at home in a minute (pen.work kinds); the rest are trips
const PEN_SHORT = new Set(['gate', 'shear', 'breed'])
// the build's band itself waits on wool (or a carpet or bed made of it): the pen's trips are the build's then
function woolHolds () { const w = mem.get().buildWaiting; return !!w && /_wool$|_carpet$|_bed$/.test(w) }
// the next layers short of cobblestone (raw, through the planner: stone, smooth stone, bricks all come from it) - a stack
function stoneShort () { try { return (mats.planFor(bot, windowNeeds()).raw.cobblestone || 0) >= 64 } catch { return false } }
function dayStop () { return taskCancelled() || nightSoon() || bot.health <= reflex.hurtLine() || homeByDark() }
// A TRIP FITS THE DAY when the walk to its source, the walk home from there and a minute's work all end before the rule
// that calls the bot in: the evening rule (EVENING, a source past the grounds) or the dusk (a source round home). A
// source not yet known is a 96-block search. Every trip the castle round picked at the day's end was ended at once by
// those rules - the pack emptied and the shears taken for an oak_leaves trip four evenings running, the sleep the next
// thing; a 208-block dark oak walk begun at tod 10500 and called home 8s in (2026-10-03)
const TRIP_WORK = 1200
function tripFitsDay (raw) {
  if (world.phase(bot) !== 'day' || dayStop()) return false
  const me = bot.entity.position; const home = mem.get().home || me
  // (the mine next to home is the stone and ore's source - unknown, a cobble trip read as a 96-block search; audit A5)
  const m = mem.get().mine
  const src = (/^(cobblestone|cobbled_deepslate|raw_iron|coal|granite|diorite|andesite|tuff)$/.test(raw) && m && (m.cursor || m.entrance)) || gather.knownResource(raw, me, /_log$/.test(raw) ? { maxFromHome: 5000 } : forage.handles(raw) ? { maxFromHome: 1200 } : undefined) ||
    (/_leaves$/.test(raw) ? gather.knownResource(raw.replace(/^(flowering_)?azalea_leaves$/, 'oak_leaves').replace(/_leaves$/, '_log'), me, { filter: p => !move.inZone(p, 2) }) : null) || // (leaves grow on the trees remembered - the trip's own lead; audit)
    (forage.exhausted(raw) ? forage.landLead(raw) : null) // (a plant searched out round home goes to its own land: the day's fit is that walk; audit)
  const walk = src ? world.walkTicks(me, src) + world.walkTicks(src, home) : world.walkTicks(me, home) + 2 * world.walkTicks({ x: 0, y: 0, z: 0 }, { x: 96, y: 0, z: 0 })
  const roundHome = !!src && world.dist2(src, home) <= 32 && world.dist2(me, home) <= 32
  // (a species log known past half a day's walk is an expedition's - the chop's too-far starts it; the day's fit is not the
  //  question, only a real stretch of the day left, as the expedition start asks; audit)
  if (/_log$/.test(raw) && src && world.walkTicks(me, src) > DAYLIGHT_TICKS / 2) return world.ticksUntilNight(bot) > 2400
  let t = world.tod(bot); if (t >= 23000) t -= 24000
  return (roundHome ? 12000 : EVENING) - t > walk + TRIP_WORK
}
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
  else { const f = failures[name] || (failures[name] = { n: 0, at: 0 }); f.n++; f.at = Date.now(); f.day = day.dayNo(bot) }
}
// A task that just failed steps aside until the world changes (time passing is the change here:
// position, daylight, inventory differ after other work). Backoff grows with repeated failure.
// THE DAY'S CHORES run under dayStop: offered while that stop already holds, each began and refused at once - "did not
// succeed" four times over, the watchdog's alarm, a backoff for nothing (late in the day, 25-64 from home; audit
// 2026-09-28). One gate: a day chore whose stop holds waits, said once. (Survival - food, graves, tools, the bed - is
// never held here; the castle's step does its home work first and minds its own stop.)
const DAY_TASKS = new Set(['fillCraters', 'fillFreshCraters', 'farm', 'harvest', 'hydrate', 'levelFarm', 'levelYard', 'fixWater', 'lightBase', 'plant', 'pen', 'spareKit', 'fillShaft', 'cook', 'ironTrip', 'tidy', 'siteTidy'])
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
// (A NEW DAY is the world changed: a failure of the evening before - the castle round at dusk with nothing that fits the
//  hour, "did not succeed" - kept the castle cooling into the dawn after the night was slept through, an iron trip for
//  the bot's own leggings took the whole morning and the dark oak trip never ran, 2026-10-04. Cleared at the day's turn)
function cooling (name) {
  const f = failures[name]
  if (!f) return false
  if (f.day != null && day.dayNo(bot) > f.day) { delete failures[name]; return false }
  return Date.now() - f.at < Math.min(15 * 60000, 30000 * Math.pow(2, Math.min(f.n - 1, 5)))
}

const TOOL_KIT = ['stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel']
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
// THE DAY'S SHEEP SEARCH: no bed and no flock known - once a game day, with the day well ahead, a capped look round
// (WOOL_SEARCH_MS) on the search's own trail (gather.explore: new ground each time). A bed skips every night after it
const WOOL_SEARCH_MS = 4 * 60000
function woolSearchDue () {
  // (not while a sheep stands in our pen: its wool grows back and the pen's shearing brings the bed's - the day's search
  //  went 208 blocks out with a sheep penned at home, 2026-10-03)
  // (only a pen that can give it: with no shears it gives nothing, and the search off for good was no bed ever; audit)
  if (pen.pen() && (inv.has(bot, 'shears') || base.bankCount('shears') > 0) && (pen.observe(bot) || { n: 0 }).n > 0) return false
  return !shelter.hasBedItem(bot) && mem.get().woolSearchDay !== day.dayNo(bot) && world.phase(bot) === 'day' && world.ticksUntilNight(bot) > 6000
}
function bedObtainable () {
  if (shelter.hasBedItem(bot)) return true
  if (Object.values(bot.entities).some(e => { try { return e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 48 && /_bed$/.test(e.getDroppedItem().name) } catch { return false } })) return true
  const c = Object.assign({}, inv.counts(bot)); for (const [n, k] of Object.entries(base.bankCounts())) c[n] = (c[n] || 0) + k // (the chests' too)
  if (Object.keys(c).some(n => /_wool$/.test(n) && c[n] >= 3)) return true
  const home = mem.get().home
  if (world.findBlocks(bot, /_bed$/, { maxDistance: 48, count: 1, point: home ? new Vec3(home.x, home.y, home.z) : undefined }).length) return true
  const sheep = ((mem.get().mobs || {}).sheep || []).filter(p => home && world.dist2(p, home) < food.WOOL_REACH) // the wool search's own reach (food.js)
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
  // (a shovel: a build's ground cells are dug out of grass and dirt before the paving goes in - by hand that clearing was
  //  593ms of every block's 1.3s on the spawn hub's first layers, 2026-10-03; a stone shovel is a cobblestone and two sticks)
  if (inv.toolTier(bot, 'shovel') < 2) out.push('stone_shovel')
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
  // (and MADE when the chest has none: a bow in the pack and no arrow anywhere through a pillager patrol, the arrows of the
  //  morning's skeleton spent and nothing that made more - the flint and feathers that make them were tossed as junk,
  //  2026-10-06. From flint and feathers on hand - kept now, never a trip for them: a chicken or a gravel dig brings them)
  if (inv.count(bot, 'arrow') < 16 && (inv.has(bot, 'bow') || (bankNear && base.bankCount('bow') > 0)) && ((bankNear && base.bankCount('arrow') > 0) || arrowCrafts(bankNear) > 0)) out.push('arrow')
  // ARMOUR WITH NO IRON FOR IT: the head and the chest - the fights' pieces - in leather from the chest's hides while that slot
  // is bare and the iron for it is not on hand (iron goes on over it when it comes: ironWanted still asks, rank 1 < 4). A
  // few hides of the build's - survival before the build's books; chainmail is never made, only worn when found (the dress row)
  for (const [slot, piece, cost] of [['torso', 'leather_chestplate', 8], ['head', 'leather_helmet', 5]]) {
    if (inv.wornArmor(bot)[slot] || inv.items(bot).some(i => i.name.endsWith('_' + inv.ARMOR_SLOTS[slot]))) continue // (a piece for it in the pack: the dress row's)
    const iron = 'iron_' + piece.split('_')[1]
    if (inv.count(bot, 'iron_ingot') + inv.count(bot, 'raw_iron') + (bankNear ? base.bankCount('iron_ingot') + base.bankCount('raw_iron') : 0) >= IRON_COST[iron]) continue
    if (inv.count(bot, 'leather') + (bankNear ? base.bankCount('leather') : 0) >= cost) out.push(piece)
  }
  return out
}
// how many crafts of four arrows the flint, feathers and sticks' wood to hand allow (the bank's too when it is near)
function arrowCrafts (bankNear) {
  const has = n => inv.count(bot, n) + (bankNear ? base.bankCount(n) : 0)
  return Math.min(16, has('flint'), has('feather'))
}

// A GRAVE STILL COVERED by what killed us: a shooter in tracking range of it; a shooter's own grave for its first three minutes
// (the patrol is still there - unseen from 80 blocks; the death record says who: d.by); a creeper at it; and by night any
// grave not a few steps off. The second pillager death of 2026-10-02 was the walk back, at dusk, into the same patrol
function coveredGrave (g0) {
  if (!g0 || !bot.entity) return false
  const steps = world.dist3(g0, bot.entity.position) < 10
  if (!steps && g0.by && reflex.RANGED.has(g0.by) && Date.now() - (g0.t || 0) < 3 * 60000) return true
  if (!steps && world.phase(bot) === 'night') return true
  return Object.values(bot.entities).some(e => e && e.position && ((reflex.RANGED.has(e.name) && e.position.distanceTo(g0) < 20) || (e.name === 'creeper' && e.position.distanceTo(g0) < 12)))
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
  if (rank(w.head) < 4) out.push('iron_helmet')
  // (the shears' two ingots before the legs and the feet: shield, chest and head carry the fights; 319 leaf cells of the build
  //  waited behind 13 more ingots of leggings and boots, 0 placed a round, 2026-10-02)
  //  (shears: wool shorn, never the flock killed - 2026-09-29; a WORN banked pair is none - forage.ensureShears marks it)
  if (shearsWanted()) out.push('shears')
  if (rank(w.legs) < 4) out.push('iron_leggings')
  if (rank(w.feet) < 4) out.push('iron_boots')
  if (inv.toolTier(bot, 'pickaxe') < 3) out.push('iron_pickaxe')
  if (inv.toolTier(bot, 'sword') < 3) out.push('iron_sword')
  return out
}
// (a good pair in hand ends the worn verdict: latched when a worn pair came out of the chest, it cleared only on a shearing
//  trip - every new pair was banked at the next deposit, and the iron plan made another, three pairs in 20 minutes, 2026-10-03)
function shearsWanted () { if (forage.shearsHeld(bot)) { if (mem.get().shearsWorn) mem.set('shearsWorn', false); return false } return base.bankCount('shears') === 0 || !!mem.get().shearsWorn }
const IRON_COST = { shield: 1, bucket: 3, iron_chestplate: 8, iron_leggings: 7, iron_helmet: 5, iron_boots: 4, iron_pickaxe: 3, iron_sword: 2, shears: 2 }
// the pieces that stand between the body and a mob (a trip is made for these; tools and the bucket wait for iron)
// (the way of mining a dry verdict was reached under - a new way, a new chance: 'levels' since the mine became a chain of
//  levels at every ore's depth, 2026-09-30. Left at 'vein', a dry trip of 09-29 under the old single staircase blocked every
//  iron trip for three days - no shears, 318 leaves waiting, no armour after a death, 2026-10-02)
const ORE_METHOD = 'depths' // ('depths': the ore found by spheres down the column under home, 2026-10-02)
const ARMOUR_GEAR = new Set(['shield', 'bucket', 'iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots'])
// (THE iron we have: pack, bank AND the furnaces' raw in and ingots out - smelt.furnaceCount; one count for the trip, the
//  task and the reserve)
function ironIngots () { return inv.count(bot, 'iron_ingot') + base.bankCount('iron_ingot') + smelt.furnaceCount(bot, 'iron_ingot') + smelt.furnaceCount(bot, 'raw_iron') }
function ironRaw () { return inv.count(bot, 'raw_iron') + base.bankCount('raw_iron') }
function ironStock () { return ironIngots() + ironRaw() }
// (core: the gear that carries the fights - shield, chest, head (and the bucket, the shears) - not the legs and the feet)
const LOW_GEAR = new Set(['iron_leggings', 'iron_boots'])
let ironTripCore = false // (the trip decide() chose: the core's ingots only, or the whole set - audit)
function gearIronShort (core = false) {
  // (and the shears' two when they are wanted: the build's leaves wait on them, and no other trip brings iron - audit)
  const need = ironWanted().filter(n => (ARMOUR_GEAR.has(n) || n === 'shears') && !(core && LOW_GEAR.has(n))).reduce((a, n) => a + IRON_COST[n], 0)
  return Math.max(0, need - ironStock())
}
// THE GEAR'S IRON KEPT FROM THE BUILD'S CRAFTS: the armour's pieces first - the 14 ingots smelted for the shield, chest and
// helmet came out of the furnaces at dusk and the window's crafts made two cauldrons of them, the iron trip to start over,
// 2026-10-06 23:54. Ingots first, then raw; only what the gear still wants, never more than there is.
function gearIronKeep () {
  const need = ironWanted().filter(n => ARMOUR_GEAR.has(n) || n === 'shears').reduce((a, n) => a + IRON_COST[n], 0)
  const ingots = Math.min(need, inv.count(bot, 'iron_ingot') + base.bankCount('iron_ingot'))
  return { iron_ingot: ingots, raw_iron: Math.min(need - ingots, ironRaw()) }
}
function withGearKeep (keep) { const g = gearIronKeep(); const k = Object.assign({}, keep); for (const [n, v] of Object.entries(g)) if (v > 0) k[n] = (k[n] || 0) + v; return k }

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
    // (someone else's place round the site: the ring widens past it rather than finding no home at all - audit)
    let skipped = 0
    for (let r = half + 9; r <= half + 22 || (!cands.length && skipped && r <= half + 120); r += 2) {
      for (let a = 0; a < 32; a++) {
        const x = Math.round(cx + Math.cos(a * Math.PI / 16) * r); const z = Math.round(cz + Math.sin(a * Math.PI / 16) * r)
        // the hut (home +-3) must stand at least 4 blocks clear of the footprint: home >= 8 outside it
        if (x >= box.x1 - 8 && x <= box.x2 + 8 && z >= box.z1 - 8 && z <= box.z2 + 8) continue
        if (foreign.near({ x, z }, foreign.HOME_GROUNDS + foreign.PAD)) { skipped++; continue } // (never beside someone else's place: foreign.js)
        const s = siteScore(x, z, box.y1)
        if (s) cands.push(Object.assign(s, { score: s.flat * 2 - s.dy * 3 - (r - half) * 0.5 }))
      }
    }
    cands.sort((p, q) => q.score - p.score)
    if (cands.length) { log('dir', `home site picked at ${move.fmt(cands[0])} (flat ${cands[0].flat}/49, ${cands.length} candidates)`); return cands[0] }
    return null // site not loaded yet - go there first
  }
  const me = world.feetPos(bot)
  // (a home beside someone else's place makes their base "home grounds" - and their chests ours: not here; audit)
  if (foreign.near(me, foreign.HOME_GROUNDS + foreign.PAD)) { log('dir', `no home here - someone else's place is within ${foreign.HOME_GROUNDS} blocks`); return null }
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
// a dropped item within 10 (a few steps, the grave rule's reach) on our level that the build still wants: its name, or null.
// The build's plan is asked only when something lies there (wantedSet works the whole plan out)
let wantedTest = null
function wantedDropOf (e) { try { const it = e.getDroppedItem(); return !!it && !!wantedTest && wantedTest(it.name) } catch { return false } }
function wantedDrop () {
  const near = act.droppedItems(bot, 10).filter(e => Math.abs(e.position.y - bot.entity.position.y) < 4 && !act.skippedDrop(e.id)) // (one the pickup gave up on is not offered again; audit)
  if (!near.length || !build.getJob()) return null
  wantedTest = mats.wantedSet(bot, { failOpen: true }); if (!wantedTest) return null // (no plan: nothing is wanted - never "everything"; audit)
  const e = near.find(wantedDropOf); if (!e) return null
  try { return e.getDroppedItem().name } catch { return null }
}
// A SPIDER NIGHT: string comes from spiders, and they are on the surface only at night - by day the hunt found them all deep
// in the rock, and a slept night spawns none: the hub's 23 carpets waited on string for good, 2026-10-04. While the build is
// short of it, a fit, armed bot stays up by its own door for them instead of the bed - spiders only: anything else about,
// or hurt, and it is the hideout's as ever (and creepers drawn to the door are 20 from the build, not on it)
const SPIDER_RE = /^(spider|cave_spider)$/
function stringShort () { try { const need = (build.cachedStatus(bot).need || {}).string || 0; return need > 0 && inv.count(bot, 'string') + base.bankCount('string') < need } catch { return false } }
// (never a third night up - phantoms come for a player 3 days unslept; and never with another player online: their bed skips the
//  night only if every player sleeps, and a bot on guard at its door kept the operator's night from passing; audit)
function spiderNightRested () { const d = mem.get().sleptDay; return d != null && day.dayNo(bot) - d < 2 }
function othersOnline () { try { return Object.values(bot.players).some(p => p && p.username && p.username !== bot.username) } catch { return true } }
function spiderNightFit () { return spiderNightRested() && !othersOnline() && bot.health >= 18 && !!inv.bestWeapon(bot) && (inv.armorPoints(bot) >= 8 || !!inv.offhandShield(bot)) && inv.foodPoints(bot) >= 10 && !!hut.doorApronStep() && hut.shellComplete(bot) }
function decide () {
  const night = world.phase(bot) === 'night'
  const dusk = world.phase(bot) === 'dusk'
  const home = mem.get().home
  const dHome = home ? world.dist2(bot.entity.position, home) : Infinity
  const packFood = inv.foodPoints(bot)
  // FED ENOUGH FOR A NIGHT IN THE MINE: ONE bar for both mine rules (18 and 16). A night underground costs a few hunger
  // points; with hunger 13-17 and an empty pack neither the food rule (hunger <= 12) nor the mine fired, and the hub's
  // cobble waited out whole nights in the safehouse (2026-10-03). Above the food rule's own line, so the two never gap
  const nightFed = () => packFood >= 10 || bot.food > 12
  const bed = mem.get().bed

  if (override) return { name: override, why: 'operator' }

  // standing in someone else's place (a respawn at a bed of theirs, a walk that wandered in): out of it before anything
  // else, on our legs alone - and with no such way out, nothing at all: every other task digs, fells or builds (foreign.js)
  if (foreign.covers(world.feetPos(bot))) {
    if (!held('leaveForeign')) return { name: 'leaveForeign', why: "inside someone else's place - walking out, nothing broken or placed" }
    return { name: 'idle', why: "inside someone else's place and no way out that breaks nothing - waiting" }
  }

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
  // (and not one boxed into a pit it cannot walk out of - walls two high on all four sides - that cannot see us: four
  //  pillagers fell into the hole the bot died in, 11 blocks from the door, and the hideout waited on them 40 minutes and on,
  //  2026-10-04. One that sees us is the reflex's at once, as ever)
  const pitted = e => { const f = e.position.floored(); return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => [0, 1].every(dy => { const b = world.at(bot, f.x + dx, f.y + dy, f.z + dz); return !!b && world.isSolid(b) })) && !reflex.canSee(e) }
  const aroundAll = reflex.hostiles(20).filter(h => h.e.name !== 'bat' && Math.abs(h.e.position.y - bot.entity.position.y) < 6 && onSurface(h.e))
  const around = aroundAll.filter(h => !pitted(h.e))
  const dim = world.phase(bot) !== 'day' || world.tod(bot) >= 23000 || world.tod(bot) < 1500
  // (by day too when shooters stand round home and the body can't take their arrows - no shield, little armour: a
  //  pillager patrol and two skeletons shot the bot four times in two minutes, each respawn walking back out to the
  //  grave, the farm, the tool chest, 2026-09-25)
  const outgunned = around.some(h => reflex.RANGED.has(h.e.name)) && !inv.offhandShield(bot) && inv.armorPoints(bot) < 8 && !reflex.bowReady()
  // (from dusk: the bed takes the dusk, and a night slept from dusk never came - the first evening went to bed at 19:58)
  // (the bed's own reach - 200 at dusk, 32 at night: it stands in for the bed wherever the bed would be chosen; held to 24 of home,
  //  the second evening went to bed from 41b out, 2026-10-04)
  const spiderNightOn = world.phase(bot) !== 'day' && !!home && dHome < (world.phase(bot) === 'dusk' ? 200 : 32) && stringShort() && spiderNightFit() && !held('spiderNight')
  const spidersOnly = around.length > 0 && around.every(h => SPIDER_RE.test(h.e.name)) // (the spider night's own game: no hideout from it)
  if (around.length && home && dHome < 48 && hut.shellComplete(bot) && (dim || outgunned || bot.health <= reflex.hurtLine()) && !(spiderNightOn && spidersOnly) && !held('hideout')) {
    return { name: 'hideout', why: `${around.length} hostile${around.length > 1 ? 's' : ''} around home (${around.slice(0, 3).map(h => h.e.name).join(', ')}) - waiting inside` }
  }
  // evening: be home before dusk, not at it - a 100-block walk begun at dusk arrives in the dark (a zombie
  // met the bot at its own door at hp 10)
  // (never on an expedition out: the nights are camped - walked home each evening, it never got past a day's walk out;
  //  audit 2026-09-28)
  if (home && world.phase(bot) === 'day' && world.tod(bot) >= EVENING && world.tod(bot) < 12000 && dHome > 32 && hut.shellComplete(bot) && !tooHurt() && !(expedition() && expedition().phase === 'out') && !held('goHome')) {
    return { name: 'goHome', why: `evening - home is ${Math.round(dHome)}b away, back before dark` }
  }
  // a grave right here (died in the safehouse, or beside it): pick it up whatever the hour - it
  // despawns, and it is a few steps - but not into the mob that put it there
  {
    const g0 = graves.bestGrave(bot)
    // (the whole list here, and the grave's cover: a pit's shooters see a body passing its rim - a grave beside the hole is in their line; audit)
    if (g0 && world.dist3(g0, bot.entity.position) < 10 && !aroundAll.some(h => h.d < 16) && !coveredGrave(g0) && !held('grave')) return { name: 'grave', why: `my grave is ${Math.round(world.dist3(g0, bot.entity.position))}b away - ${g0.items} items` }
  }
  // WHAT A FIGHT DROPPED THAT THE BUILD WANTS - a spider's string - picked up as the grave is: whatever the hour, a few steps
  // off, never into a mob. Left lying, the night's spider kills by the door gave nothing, and the day's hunt found spiders only
  // deep in the rock: 21 string the hub's carpets wait on, "2 trips found none", 2026-10-04
  {
    const loot = wantedDrop()
    // (never out of the safehouse after dark for it, and never below the hurt line - this row is before the heal; audit)
    if (loot && !aroundAll.some(h => h.d < 16) && !((night || dusk) && move.insideHut(world.feetPos(bot))) && bot.health > reflex.hurtLine() && !held('loot')) return { name: 'loot', why: `${loot} on the ground beside me - the build wants it` }
  }

  // 1. night
  if (night || dusk) {
    // at dusk walk to the bed from anywhere near; once it is dark only if the bed is a few steps away
    // (a night walk home from the mine ended in a skeleton fight and a death 12 blocks from the bed)
    // (ONE night walk limit, for the bed and the mine alike: a 43b walk to the mine in the dark - the bed unreachable, the
    //  builder's walls round it - met two creepers, a witch and a skeleton, and died with an iron pickaxe, 2026-09-28)
    const nightWalk = dusk ? Infinity : 32
    // (the night is free time for the mine when the build waits on stone: a bed skips it, and the mining then came out of
    //  the building daylight - the hub at 2659 waiting on smooth stone with 9 cobblestone to smelt, 2026-10-03. Short of
    //  stone for the next layers and a mine to work (or none yet: the dusk rule below starts one): mined, not slept)
    // (only when a mine rule below can take the night - the existing mine near enough, or none so the dusk rule starts one;
    //  else the bed as before: skipped with no mine rule able to fire, the bot dug a bunker beside its own bed; audit)
    const mm0 = mem.get().mine
    const mineCan = !held('nightMine') && (mm0 ? !!(mm0.entrance && world.dist2(mm0.entrance, home) < 48 && world.dist2(bot.entity.position, mm0.entrance) < (dusk ? 64 : 32) && (dusk || !move.insideHut(world.feetPos(bot)))) : dusk) // (the rules below exactly: night needs the night walk and the open air, a new mine dusk; audit)
    // (dusk finds the bot at the site, 40-60 blocks out: "within 32 of home" never held, and the rule never fired; at night,
    //  from home only - the dark walk; audit 2026-10-03)
    const mineTheNight = (dusk ? dHome < 96 : dHome < 16) && home && mineCan && build.getJob() && build.needsWork(bot) && nightFed() && inv.bestTool(bot, 'pickaxe', 8) && stoneShort() && !held('nightMine') // (a night mine just failed is no reason to refuse the bed; audit)
    // (the night mine chosen at dusk and failed - its walk refused - keeps the dusk's walk to the bed a minute and a half: the
    //  dusk is ~45s, the failure took 30, and night's 32-block limit left the bed 48b off - a bunker dug at the site and the
    //  night waited out, ~9 minutes a bed would have skipped, 2026-10-04)
    const mineFellThrough = !!failures.nightMine && Date.now() - failures.nightMine.at < 90000
    if (spiderNightOn && !mineTheNight) return { name: 'spiderNight', why: 'night - the build is short of string: up by the door for the spiders, not the bed' }
    if (bed && world.dist2(bed, bot.entity.position) < (dusk || mineFellThrough ? 200 : 32) && !mineTheNight && !held('sleep')) return { name: 'sleep', why: `${night ? 'night' : 'dusk'} - my bed is ${Math.round(world.dist2(bed, bot.entity.position))}b away` }
    // a working mine next to home turns the night into mining time: go down at dusk (a short walk)
    {
      const mm = mem.get().mine
      const mineReady = mm && mm.entrance && home && world.dist2(mm.entrance, home) < 48 && inv.bestTool(bot, 'pickaxe', 8) && nightFed()
      if (mineReady && (dusk || !move.insideHut(world.feetPos(bot))) && world.dist2(bot.entity.position, mm.entrance) < Math.min(64, nightWalk) && !held('nightMine')) return { name: 'nightMine', why: `${night ? 'night' : 'dusk'} - mining through the night in the mine next to home` }
      // NO MINE AT ALL (the last one abandoned - boxed in, blocked stairs): at dusk, at home, a new one - mining.mineFor sites it
      // (HOME_CLEAR..96 from home). Only an existing mine was ever worked at night, and after an abandon every night was
      // waited out in the safehouse with the build short of cobblestone (2026-10-03)
      if (!mm && dusk && home && dHome < 96 && inv.bestTool(bot, 'pickaxe', 8) && nightFed() && !held('nightMine')) return { name: 'nightMine', why: 'dusk - no mine left, starting a new one next to home for the night' }
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
    if (mineHere && inv.bestTool(bot, 'pickaxe', 4) && nightFed() && world.dist2(m.cursor, bot.entity.position) < 150 && (dusk || underground() || world.dist2(m.entrance, bot.entity.position) < nightWalk) && !held('nightMine')) return { name: 'nightMine', why: 'night - working the mine underground' }
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
  const graveCovered = g0 => coveredGrave(g0)
  // (the GRAVE IS THE RE-ARM when the weapon is in it and none is in the chests: re-armed first, the tools task walked 140
  //  blocks out for acacia to make a wooden pickaxe while the 187-item grave's twelve minutes ran out 60 blocks from home,
  //  2026-10-03. By day, uncovered, the trip's caution on - the reflex's cover and flight as on any trip)
  const graveArms = gg => !!gg && !!mem.get().home && world.dist2(gg, mem.get().home) < 96 && (gg.valuable || []).some(n => /_(sword|axe)$/.test(n)) && !Object.keys(base.bankCounts()).some(n => /_(sword|axe)$/.test(n)) && world.phase(bot) === 'day'
  if (g && !held('grave') && (inv.bestWeapon(bot) || world.dist3(g, bot.entity.position) < 10 || graveArms(g)) && !graveCovered(g)) return { name: 'grave', why: `grave ${Math.round(world.dist2(g, bot.entity.position))}b away with ${g.items} items` }

  // 2a. our bed is not our spawn (another player slept on the account; the bed was moved): used by day, at once - a death
  //     sent the bot to someone else's base 1500 blocks from its grave while it waited for night (2026-10-02)
  {
    const b = mem.get().bed; const s = mem.get().spawnSetAt
    if (b && !(s && s.x === b.x && s.y === b.y && s.z === b.z) && world.dist2(b, bot.entity.position) < 96 && !tooHurt() && !held('setSpawn')) return { name: 'setSpawn', why: 'my respawn point is not at my bed - setting it there' }
  }

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
  // (only while a death would respawn far off: at a base by the world spawn it bought nothing ahead of the safehouse - two
  //  five-minute sheep hunts with the shell at 52/149, 2026-10-03; the bed still comes once the shell stands, below.
  //  0,0,0 is the client's default before the server says - unknown, so the bed first as before)
  const sp = bot.spawnPoint; const spawnFar = !(sp && (sp.x || sp.y || sp.z)) || world.dist2(sp, home || bot.entity.position) > 128
  if (!bed && !shelter.hasBedItem(bot) && spawnFar && world.phase(bot) === 'day' && bedObtainable() && !held('bed')) return { name: 'bed', why: 'no bed - getting one to carry (spawn is where i sleep)' }

  // 5. home
  // (no home: setHome, or - while it cools after a failure - nothing; every task below assumes a home; audit)
  if (!home) return held('setHome') ? { name: 'idle', why: 'no home yet - choosing one again shortly' } : { name: 'setHome', why: 'no home yet' }
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
  if (dHome < 24 && (mem.get().chests || []).length && depositHaulSize() >= 64 && !held('deposit')) return { name: 'deposit', why: `home with ${depositHaulSize()} items to store` }

  // 5c. plant first (a minute of work, renewable food), then top up the food buffer while it is easy -
  //     starving first and searching second killed the bot twice
  if (dHome < 64 && (farm.farm() === null || !farm.farmIsHome(bot)) && (inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds')) >= 4 && !held('farm')) return { name: 'farm', why: 'seeds in hand and no farm at this home' }
  if (packFood < 12 && bot.food <= 12 && !held('food')) return { name: 'food', why: `food buffer low (pack ${packFood} pts, hunger ${bot.food})` }
  // THE EVENING AT HOME, THE BUILD'S PREP: the furnaces collected and loaded, the charcoal, the crafts for the next layers -
  // in a castle round they were its first minutes (135s, 0 placed, 2026-10-03); done at home in the day's last minutes they
  // take the place of the next round's own, and the furnaces smelt through the night. Below survival (food, graves, tools). Once a day, stopped by dusk, a hostile near, or a hurt
  // body at the next furnace (operator: never build at night; "it can mine and maybe do other stuff at night thats safe")
  if (home && world.phase(bot) === 'day' && world.tod(bot) >= EVENING && world.tod(bot) < 12000 && dHome <= 32 && build.getJob() && build.needsWork(bot) && mem.get().eveningPrepDay !== day.dayNo(bot) && bot.health > reflex.hurtLine() && !prepThreat() && !held('eveningPrep')) return { name: 'eveningPrep', why: "evening at home - the build's smelting and crafts before dark" }

  // FIRST THING IN THE DAY: a far trip refused for want of daylight goes before the day's rounds - asked at the end of a
  //  castle round, the dark oak trip came each day with 2300 ticks left and was "not today" three days running, the castle
  //  standing on it (2026-09-28). An expedition from here: it camps where the night finds it
  // (its food first: the expedition goes with FOOD_OUT packed, and nothing else ever packs it - the food rules keep a 12-point
  //  buffer, so "waits on food (10 pts packed, 50 wanted)" put the spruce off every morning and the trip was dropped,
  //  2026-10-04. The food task's target is FOOD_OUT then: one number for the gate and its producer - threshold seams)
  { let ft = mem.get().farTrip
    if (ft && ft.day == null) { ft = Object.assign({}, ft, { day: day.dayNo(bot) }); mem.set('farTrip', ft) } // (one saved before the day was kept; audit)
    if (ft && day.dayNo(bot) > ft.day + 1) { mem.set('farTrip', null); ft = null } // (put off at dusk, run the next day - a day later it is stale)
    // (only when the food is all it waits on: the gear first - the iron and tools rules answer that, no packing, no retries)
    const fit = ft && world.phase(bot) === 'day' && world.ticksUntilNight(bot) > 2400 && !expedition() && expeditionReadyBarFood()
    if (fit && packFood < FOOD_OUT && !held('food') && !held('farTrip')) return { name: 'food', why: `${ft.raw}: the far trip waits on food - packing ${FOOD_OUT} pts (${packFood} now)` }
    if (fit && !held('farTrip')) return { name: 'farTrip', why: `${ft.raw} - the far trip, first thing in the day` } }
  // 6. food: cook what we carry; harvest a ripe farm
  if (inv.rawFoodCount(bot) >= 3 && dHome < 64 && !held('cook')) return { name: 'cook', why: `${inv.rawFoodCount(bot)} raw food to cook` }
  // saplings on hand and room for them in the orchard (empty spots, or fewer trees than the build still needs)
  {
    const saps = orchard.saplingCount(bot) + inv.count(bot, 'dark_oak_sapling') + Object.entries(base.bankCounts()).filter(([n]) => orchard.ANY_SAP_RE.test(n)).reduce((a, [, c]) => a + c, 0)
    const sc = orchard.sapCounts(bot, base.bankCounts()) // (the saplings to hand, the bank's included: the planter's own rule)
    const o = orchard.orchard()
    if (dHome < 64 && world.phase(bot) === 'day' && saps > 0 && orchard.plantable(bot, sc, demandTrees) && !held('plant')) return { name: 'plant', why: `${saps} saplings for the orchard (${o ? o.spots.length : 0} spots; ${demandTrees.squares} squares and ${demandTrees.singles} singles wanted)` }
  }
  // the sheep pen: built while the build wants wool, then stocked and bred (pen.work: the one rule for this and the task)
  // (a gap in a stocked pen's fence is the gate's errand - the flock walks out; audit)
  // (ahead of the build only the pen's short jobs at home - a gate, the shearing, the breeding - or anything when the build's
  //  band itself waits on wool; the long ones, a flock led in from 180 blocks out, a new pen's fence wood, go in the build's
  //  gaps (9c): the hub's 23 carpets - decoration, holding nothing up - cost two mornings of sheep trips, 2026-10-03)
  if (dHome < 64 && world.phase(bot) === 'day' && !held('pen')) { const w = pen.work(bot, penArgs()); if (w && (PEN_SHORT.has(w.kind) || (w.kind === 'build' && pen.pen() && (pen.observe(bot) || { n: 0 }).n > 0) || woolHolds())) return { name: 'pen', why: w.why } }
  // (the harvest when the bread runs low, not every morning: the crop keeps on the stalk, and harvesting and
  //  replanting 71 cells took two minutes of every ten-minute day with 31 bread in the pack, 2026-09-26)
  if (farm.farm() && dHome < 64 && farm.ripeCount(bot) >= 8 && foodStock() < FOOD_WANTED && !held('harvest')) return { name: 'harvest', why: `${farm.ripeCount(bot)} wheat ripe` }

  // 7. base infrastructure - SHELTER FIRST: nothing of value (bed, bank) sits in the open, so the
  //    safehouse goes up before the bed and the chest go down inside it
  if (dHome < 64) {
    if (hut.collidesWithBuild(bot) && !held('relocate')) return { name: 'relocate', why: 'the safehouse stands on the build footprint - moving house' }
    if (!hut.complete(bot) && !held('hut')) { const s = hut.status(bot); return { name: 'hut', why: `the safehouse is ${s ? s.done + '/' + s.total : 'not started'}` } }
    if (hut.shellComplete(bot) && furnishingInPack().length && !held('furnish')) return { name: 'furnish', why: `putting ${furnishingInPack().join(', ')} in the safehouse` }
    if (!(mem.get().chests || []).length && !held('chest')) return { name: 'chest', why: 'no storage at home' }
    if (farm.farm() && farm.farmHome && !farm.farmIsHome(bot) && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 4 && !held('farm')) return { name: 'farm', why: 'the farm belongs to the old home - planting one here' }
    if (!bed && bedObtainable() && !held('bed')) return { name: 'bed', why: 'no bed - spawn is not anchored at home' }
    // no sheep known: one short search a day (woolSearchDue) - with no flock in memory the rule above never fired, and every
    // night at the spawn hub was 7 of 20 minutes waited out in the safehouse, the build standing (2026-10-03)
    if (!bed && !held('bed') && woolSearchDue()) return { name: 'bed', why: "no bed and no sheep known - the day's sheep search (a bed skips the night)" }
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
    // (a stray shaft on the grounds that someone fell into: capped flush, before anything else here - see reflex's fall line)
    if (world.phase(bot) === 'day' && (mem.get().shaftsToFill || []).length && !held('fillShaft')) return { name: 'fillShaft', why: `${mem.get().shaftsToFill.length} hole${mem.get().shaftsToFill.length > 1 ? 's' : ''} on the grounds that I fell into - capping ${mem.get().shaftsToFill.length > 1 ? 'them' : 'it'}` }
    // a watered plot still at its starting size: widen it to everything the water reaches
    if (farm.farm() && farm.farmIsHome(bot) && farm.farm().water && farm.farm().cells.length < 60 && farm.farmLevel(bot) && farm.fullPlot(bot, farm.farm()).length > farm.farm().cells.length && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 8 && !held('farm')) return { name: 'farm', why: `the farm is ${farm.farm().cells.length} cells - widening it to all the water reaches` }
    if (farm.farm() && farm.farmIsHome(bot) && !farm.waterNeedsFixing(bot) && inv.count(bot, 'wheat_seeds') + base.bankCount('wheat_seeds') >= 4 && farm.unplantedCount(bot) >= 8 && !held('farm')) return { name: 'farm', why: `${farm.unplantedCount(bot)} farm cells unplanted and ${inv.count(bot, 'wheat_seeds')} seeds in hand` }
  }

  // 8. iron gear when the iron is on hand
  const iron = ironIngots() // (the furnaces' batch counted: the task collects it - iron())
  const raw = ironRaw()
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
  // (the daylight for a deep trip: stairs down and the walk back up - two minutes' margin sent the bot up 95 blocks of rock in
  //  the dark, 2026-10-02; audit)
  // (ahead of the build only for the gear that carries the fights: the legs and the feet's 13 ingots took 46% of a morning
  //  after a death, the castle 2%, 2026-10-03 - they go in the castle's gaps, below)
  // (not with a fresh grave of ours waiting - covered, it waits for the ground to clear, and a trip away from it outlives the
  //  server's grave: 447 items and the armour the trip went to replace, nearly lost to an iron trip, 2026-10-03)
  const ironTripOk = () => gearShort > 0 && !graves.bestGrave(bot) && !mem.get().ironTripDry && world.phase(bot) === 'day' && world.ticksUntilNight(bot) > 6000 && !held('ironTrip')
  if (gearIronShort(true) > 0 && ironTripOk()) { ironTripCore = true; return { name: 'ironTrip', why: `${gearIronShort(true)} iron short for ${wanted.filter(n => (ARMOUR_GEAR.has(n) || n === 'shears') && !LOW_GEAR.has(n)).join(', ')} - mining for it` } }

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
    seedLitter()
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
  // A FRESH CRATER is put back before the build, while it is a hole in the walks: the operator, 2026-10-04 - holes about the
  // place make the walking harder (a natural pit by the mine cost 40-80s a mine walk all evening). A blast's cells within
  // the half hour; older scars wait for the build's gaps (9c below - a new base once spent its first hour on them)
  if (world.phase(bot) === 'day' && dHome < 96 && !nightSoon() && !held('fillFreshCraters')) { const cr = require('./craters'); const n = cr.open(bot).filter(cr.fresh).length; if (n) return { name: 'fillFreshCraters', why: `${n} cells a blast just took round home and the site - put back before the build` } }
  if (mem.get().build && build.getJob() && build.needsWork(bot) && !nightSoon() && !homeByDark() && !held('castle')) {
    return { name: 'castle', why: 'working on ' + mem.get().build.name }
  }
  // 9b. the rest of the iron gear - legs and feet - in the castle's gaps (held, waiting, between rounds)
  if (ironTripOk()) { ironTripCore = false; return { name: 'ironTrip', why: `${gearShort} iron short for ${wanted.filter(n => ARMOUR_GEAR.has(n)).join(', ')} - mining for it (the castle has nothing for me now)` } }
  // 9c. the grounds made good - a blast's craters put back (craters.js), the yard's holes filled and stray blocks down - in
  //  the build's gaps: ahead of it, a new base by the world spawn spent its first hour on lighting, craters and the yard
  //  with the hub not begun (2026-10-03); the operator: cleaning up after the build is fine. (A shaft someone can fall
  //  into is still capped first, above.)
  if (world.phase(bot) === 'day' && dHome < 96 && !nightSoon() && !held('fillCraters')) { const n = require('./craters').open(bot).length; if (n) return { name: 'fillCraters', why: `${n} cells a blast took round home and the site - putting the ground back` } }
  if (dHome < 64 && world.phase(bot) === 'day' && !nightSoon() && hut.complete(bot) && !held('levelYard')) { const n = hut.yardWork(bot).length; if (n) return { name: 'levelYard', why: `the yard has ${n} holes or stray blocks` } }
  // (the pen's long jobs: see the pen rule above)
  if (dHome < 64 && world.phase(bot) === 'day' && !nightSoon() && !held('pen')) { const w = pen.work(bot, penArgs()); if (w) return { name: 'pen', why: w.why + ' (the build has nothing ready)' } }
  // 10. our own pillars and stepping stones left standing round home (a batch: one walk takes down many - LITTER_BATCH) -
  //  in the castle's gaps only (held, waiting, the day's end): tidying ahead of it took 40 minutes of a morning, the
  //  castle idle (single goal: the build; audit 2026-09-28)
  if (dHome < 64 && world.phase(bot) === 'day' && !held('tidy')) {
    seedLitter()
    const n = litter.pending(bot, mem.get().home, 96).length
    if (n >= LITTER_BATCH) return { name: 'tidy', why: `${n} blocks of ours left standing round home (pillars, stepping stones)` }
  }
  // NOTHING ELSE TO DO BY DAY: the site's old scaffold comes down - waited on supply in the endgame, the bot stood idle at
  // home for whole days with ~1300 blocks of it still standing for the finish, 2026-10-04. The day's 4 minutes a time, as often
  // as the hours stay idle (the count throttled as the day's is)
  if (world.phase(bot) === 'day' && build.getJob() && !held('siteTidy') && Date.now() - idleTidyAsked > 300000) {
    idleTidyAsked = Date.now()
    const n = build.siteScaffoldTakeable(bot)
    if (n >= 1) return { name: 'siteTidy', why: `nothing else to do - ${n} scaffold blocks of ours to take down round the site` }
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
  async eveningPrep () {
    mem.set('eveningPrepDay', day.dayNo(bot)) // (once a day, done or cut short)
    const t0 = Date.now()
    const stop = () => taskCancelled() || world.phase(bot) !== 'day' || bot.health <= reflex.hurtLine() || prepThreat()
    await processAtHome(stop)
    const why = taskCancelled() ? 'cancelled' : world.phase(bot) !== 'day' ? 'dusk' : bot.health <= reflex.hurtLine() ? 'hurt' : prepThreat() ? 'a hostile near' : 'done'
    log('dir', `evening prep: ${Math.round((Date.now() - t0) / 1000)}s (${why})`)
    return true
  },
  async nightMine () {
    // (the night's digging goes to the fuel first when the furnaces wait on it - coal from the mine's walls, with its
    //  cobble - then to the cobble: the day's coal trip was cut short at dusk every time, 2026-09-28)
    // (past dawn while the next layers are still stone-short: the night a sleeper skipped ended the trip 90s in - it carries
    //  on as the day's cobble trip, home by dark; audit 2026-10-03)
    // (one day at most: once into the day it ends by the evening, never on into the next night; audit)
    const intoDay = stoneShort(); let sawDay = false
    const stop = () => {
      const d = world.isDay(bot); if (d) sawDay = true
      return taskCancelled() || (bot.food <= 6 && !inv.foodItems(bot).length) || (d ? (!intoDay || homeByDark() || world.tod(bot) >= EVENING) : sawDay)
    }
    // (sealed in only by night: by day a full pack goes home and the trip comes back down - sealed, it waited out the day; audit)
    const mctx = { get seal () { return !world.isDay(bot) }, shouldStop: stop } // (starving with nothing to eat: out of the mine, not mining on into the night unable to heal)
    const st = build.cachedStatus(bot)
    const fuelShort = st && (mats.planFor(bot, st.need).raw.fuel || 0) > 0 && inv.count(bot, 'coal') + inv.count(bot, 'charcoal') + base.bankCount('coal') + base.bankCount('charcoal') < 32
    if (fuelShort) {
      const c0 = inv.count(bot, 'coal')
      await mining.mineFor(bot, 'coal', c0 + 32, mctx).catch(() => false)
      log('dir', `the night's coal: +${inv.count(bot, 'coal') - c0}`)
      if (stop()) return inv.count(bot, 'coal') > c0
    }
    const want = 'cobblestone'
    const target = inv.count(bot, want) + 256
    return mining.mineFor(bot, want, target, mctx)
  },
  async bunker () {
    return shelter.bunker(bot, { shouldStop: () => taskCancelled() })
  },
  async spiderNight () {
    const home = mem.get().home; const ap = hut.doorApronStep(); if (!home || !ap) return false
    const t0 = Date.now(); let kills = 0; const s0 = inv.count(bot, 'string')
    const stand = { x: ap.x, y: home.y, z: ap.z }
    // (the ground round home is lit - nothing spawns at the door: the spiders come out past it. The first night stood 3 minutes
    //  by the door with a spider on the surface 34b off and no hostile within 24, 2026-10-04. Out to 40 of home for them; and
    //  the others measured from the BODY - the hideout's own 20, a creeper's 32 - not from home)
    const SPIDER_REACH = 40
    const onHomeGround = h => Math.abs(h.e.position.y - home.y) < 8 && onSurface(h.e)
    // (what sends it in: a hostile close to the body (the hideout's 20), a creeper within 32, a shooter that sees it within 28 -
    //  one 12s follow walks into its range; checked every tick of the chase too, not between passes; audit)
    const threat = h => h.e.name !== 'bat' && !SPIDER_RE.test(h.e.name) && onHomeGround(h) && (h.d < 20 || (h.e.name === 'creeper' && h.d < 32) || (reflex.RANGED.has(h.e.name) && h.d < 28 && reflex.canSee(h.e)))
    const danger = () => reflex.hostiles(32).some(threat)
    // (and never a chase onto the build: a creeper drawn to the body blows where the body is - the box and 8 round it; audit)
    const bx = (build.getJob() || {}).box
    const nearBuild = p => !!bx && p.x >= bx.x1 - 8 && p.x <= bx.x2 + 8 && p.z >= bx.z1 - 8 && p.z <= bx.z2 + 8
    // (from out at dusk - the bed's reach: home to the door first, one walk)
    if (world.dist2(bot.entity.position, stand) > 8) { const r = await move.travel(bot, stand, { range: 1, shouldStop: () => taskCancelled(), label: 'to the door' }).catch(() => null); if (!r || !r.ok) return false }
    log('dir', `a spider night: ${(build.cachedStatus(bot).need || {}).string} string short - by the door for spiders (hp ${Math.round(bot.health)}, armour ${inv.armorPoints(bot)})`)
    while (!taskCancelled() && world.phase(bot) !== 'day' && Date.now() - t0 < 3 * 60000) {
      await reflex.waitClear()
      // (out of it: hurt past a few points, or anything but a spider close - the hideout's then)
      if (bot.health < 16 || !stringShort()) break
      const hs = reflex.hostiles(SPIDER_REACH + 8).filter(h => h.e.name !== 'bat' && onHomeGround(h))
      const other = hs.find(threat)
      // (a threat about: in and WAIT IT OUT, then out again - ended there, the next decision was the bed 4b off and the night
      //  was slept away after one spider, 2026-10-04. Still there after 90s: the hideout's, as before)
      if (other) {
        // (a door-breaker - a zombie kind on hard, a vindicator always - is no wait behind a door: the hideout seals the doorway; audit)
        const diff = bot.game && bot.game.difficulty
        if (other.e.name === 'vindicator' || (/^(zombie|husk|zombie_villager)$/.test(other.e.name) && (!diff || diff === 'hard'))) { log('dir', `spider night: a ${other.e.name} - in for good (it breaks doors)`); break }
        log('dir', `spider night: a ${other.e.name} about - waiting it out inside`)
        if (!await hut.enterHut(bot, { shouldStop: () => taskCancelled() })) break
        const tw = Date.now()
        const still = () => reflex.hostiles(32).some(threat)
        while (!taskCancelled() && world.phase(bot) !== 'day' && Date.now() - tw < 90000 && still()) await move.sleep(2000)
        if (still() || taskCancelled() || world.phase(bot) === 'day') { log('dir', 'spider night: it is still about - in for good'); break }
        log('dir', `spider night: clear after ${Math.round((Date.now() - tw) / 1000)}s - back out`)
        continue
      }
      const sp = hs.filter(h => SPIDER_RE.test(h.e.name) && world.dist2(h.e.position, home) < SPIDER_REACH && !nearBuild(h.e.position)).sort((a, b) => a.d - b.d)[0]
      if (sp) await move.goTo(bot, new goals.GoalFollow(sp.e, 1.5), { timeoutMs: 12000, stuckMs: 4000, dig: false, place: false, label: 'to the spider', shouldStop: () => taskCancelled() || danger() || nearBuild(sp.e.position) }).catch(() => null)
      else if (world.dist2(bot.entity.position, stand) > 2) await move.goTo(bot, new goals.GoalNear(stand.x, stand.y, stand.z, 1), { timeoutMs: 15000, stuckMs: 5000, dig: false, place: false, label: 'to the door' }).catch(() => null)
      else await move.sleep(1000)
      if (sp && !sp.e.isValid) kills++
      await act.collectDrops(bot, { radius: 8, maxMs: 4000, only: e => { try { return e.getDroppedItem().name === 'string' } catch { return false } } })
    }
    log('dir', `spider night over: ${kills} spider${kills === 1 ? '' : 's'} killed, +${inv.count(bot, 'string') - s0} string (hp ${Math.round(bot.health)})`)
    return inv.count(bot, 'string') > s0 || kills > 0 || Date.now() - t0 >= 3 * 60000
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
  async loot () { return (await act.collectDrops(bot, { radius: 10, maxMs: 15000, only: wantedDropOf })) > 0 },
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
    // (asked again all the way there: from 80 blocks the shooters round the grave were out of tracking range - the check
    //  passed blind and the walk went back into the patrol, 2026-10-02; audit)
    const ok = await graves.recover(bot, g, { shouldStop: near ? () => taskCancelled() : () => dayStop() || (!!g && coveredGrave(g)) })
    // a grave down in a cave: climb straight up before anything else sends us wandering through it (the next
    // task travelled 56 blocks through the cave from y-7 and died)
    if (move.isUnderground(bot)) await move.surface(bot).catch(() => false)
    return ok
  },
  async food () {
    return food.stockFood(bot, { targetPoints: mem.get().farTrip ? FOOD_OUT : 48, ctx: { shouldStop: dayStop } }) // (the far trip's own line: decide's farTrip rule)
  },
  async cook () { await food.cookAll(bot, { shouldStop: dayStop }); return inv.rawFoodCount(bot) < 3 },
  async farm () { const ok = await farm.establish(bot, { shouldStop: dayStop }); baseZone(); return ok },
  // (not through the night from a bare start: the hut's own shelter is the reason to work on at dusk - at 56/149, no walls,
  //  the task walked the night after birch for torch sticks and a creeper killed it, 2026-09-27; nearly done, it finishes)
  async hut () { return hut.buildHut(bot, { shouldStop: () => homewardStop() || (world.phase(bot) === 'night' && !hutNearlyUp()) }) },
  async deposit () { return base.depositAll(bot, { keep: depositKeep }) },
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
      // (a cap that did not take, twice: off the list - a deep hole under the grounds is a cave walk every day, into what hurt
      //  the bot there; audit 2026-10-02)
      if (!(top && world.isSolid(top)) && !dayStop()) mem.update(m => { const q = (m.shaftsToFill || []).find(x => x.x === c.x && x.z === c.z); if (q) { q.tries = (q.tries || 0) + 1; if (q.tries >= 2) { m.shaftsToFill = m.shaftsToFill.filter(x => x !== q); log('dir', `the hole at ${c.x},${c.y},${c.z} would not take a cap twice - left`) } } })
      if (top && world.isSolid(top)) { done++; mem.update(m => { m.shaftsToFill = (m.shaftsToFill || []).filter(q => !(q.x === c.x && q.z === c.z)); m.caps = (m.caps || []).concat([{ x: c.x, y: c.y, z: c.z }]).slice(-200) }); log('dir', `capped the hole at ${c.x},${c.y},${c.z}`) }
    }
    return done > 0
  },
  // (kept until it sets out or the day ends: cleared before the start, one refusal for food dropped it, and the packing
  //  that answers the refusal had nothing left to pack for; a new day drops it - the castle round asks again)
  async farTrip () { const ft = mem.get().farTrip; if (!ft) return false; const ok = await startExpedition(ft.raw, ft.land); if (ok) mem.set('farTrip', null); return ok },
  async siteTidy () { return (await build.siteScaffoldTeardown(bot, { shouldStop: dayStop })) > 0 },
  async tidy () { return (await litter.tidy(bot, { from: mem.get().home, radius: 96, shouldStop: dayStop })) > 0 },
  async levelYard () { return (await hut.levelYard(bot, { shouldStop: dayStop })) > 0 },
  async fixWater () { return farm.fixWater(bot, { shouldStop: dayStop }) },
  async harvest () { return farm.harvest(bot, { shouldStop: dayStop }) },
  async pen () { const w = pen.work(bot, penArgs()); return w ? pen.run(bot, w.kind, { shouldStop: dayStop }) : true },
  async plant () {
    for (const [n, c] of Object.entries(base.bankCounts())) if (orchard.ANY_SAP_RE.test(n) && c > 0) await base.withdraw(bot, n, c).catch(() => 0)
    return (await orchard.plant(bot, { demand: demandTrees, shouldStop: dayStop })) > 0
  },
  async tools () {
    // (room first: a full pack takes nothing from the chest and keeps no craft's result - "the server did not hand over the
    //  result" for a stone axe twice in a row with the deposit due the decision after, 2026-10-03; makeRoom tosses junk and,
    //  at home, banks the haul)
    if (inv.freeSlots(bot) < 2) await base.makeRoom(bot, 3).catch(() => false)
    for (const t of missingKit()) {
      // (the bow and arrows come out of the chest: nothing here makes them)
      if (t === 'filler') {
        // (the ONE filler getter - the scaffold's: the bank, then cobble from the mine, surface dirt last; a kit's own dirt dig
        //  was the chain that walked the bot 104 blocks out to drown, 03:54 - it must not drift from the scaffold's; audit)
        await build.ensureScaffold(bot, 24, { shouldStop: dayStop }).catch(() => false)
        if (inv.items(bot).filter(i => build.FILLER_ITEMS.test(i.name)).reduce((k, i) => k + i.count, 0) < 16) { log('dir', 'no filler to be had for the kit'); return false }
        continue
      }
      if (t === 'bow' || (t === 'arrow' && base.bankCount('arrow') > 0 && base.distHome(bot) <= 64)) { const got = await base.withdraw(bot, t, t === 'bow' ? 1 : 64).catch(() => 0); if (!got) { log('dir', `couldn't take the ${t} from the chest`); return false } continue }
      if (t === 'arrow') {
        // (made: the flint and feathers out of the chest first, as many crafts as both allow - never a gather for them)
        const near = base.distHome(bot) <= 64
        const n = arrowCrafts(near)
        for (const m of ['flint', 'feather']) if (near && inv.count(bot, m) < n) await base.withdraw(bot, m, n - inv.count(bot, m)).catch(() => 0)
        const k = Math.min(n, inv.count(bot, 'flint'), inv.count(bot, 'feather'))
        const a0 = inv.count(bot, 'arrow')
        if (k < 1 || !await craft.ensure(bot, 'arrow', a0 + 4 * k, { shouldStop: dayStop })) { log('dir', `couldn't make arrows (${inv.count(bot, 'flint')} flint, ${inv.count(bot, 'feather')} feathers in the pack)`); return false }
        log('dir', `made ${inv.count(bot, 'arrow') - a0} arrows - ${inv.count(bot, 'arrow')} for the bow`)
        continue
      }
      // a worn-out tool still counts as "held": ask for one more than we have
      const ok = await craft.ensure(bot, t, inv.count(bot, t) + 1, { shouldStop: dayStop })
      if (!ok) { log('dir', `couldn't make ${t}`); return false }
      if (/^leather_/.test(t)) { await inv.wearBestArmor(bot).catch(() => 0); log('dir', `made and wore a ${t} - no iron for that slot yet (armour ${inv.armorPoints(bot)})`) }
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
    let h = chooseHome()
    // no build to go to and someone else's place too near to settle: walk away from it, out past its grounds, and look there
    // (refused in place, the bot stood beside a village retrying for ever; audit)
    const fb = !h && !j && foreign.near(world.feetPos(bot), foreign.HOME_GROUNDS + foreign.PAD)
    if (fb) {
      const me = bot.entity.position
      const cx = (fb.x1 + fb.x2) / 2; const cz = (fb.z1 + fb.z2) / 2
      const ang = Math.atan2(me.z - cz, me.x - cx)
      const out = Math.max(fb.x2 - fb.x1, fb.z2 - fb.z1) / 2 + foreign.HOME_GROUNDS + foreign.PAD + 16
      const to = { x: Math.round(cx + Math.cos(ang) * out), y: Math.floor(me.y), z: Math.round(cz + Math.sin(ang) * out) }
      log('dir', `no home beside someone else's place - walking out past its grounds to ${to.x},${to.z}`)
      const r = await move.travel(bot, to, { range: 8, anyY: true, shouldStop: homewardStop, label: 'away from their place' })
      if (!r.ok) return false
      h = chooseHome()
    }
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
      // (the day's search, not a known flock: once today and capped - the rest of the day is the build's)
      const search = !bedObtainable()
      if (search) mem.set('woolSearchDay', day.dayNo(bot))
      const t0 = Date.now()
      const ok = await shelter.obtainBed(bot, { shouldStop: () => dayStop() || (search && Date.now() - t0 > WOOL_SEARCH_MS), searchLegs: search ? 24 : undefined })
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
    // (THE GEAR'S SHARE, not the bank's every raw iron: 64 raw withdrawn and smelted for one 3-ingot pickaxe - the build's own raw
    //  iron (raw iron blocks; its iron cells' ingots) and the fuel spent with it. The pieces asked for, their cost, first and no more)
    const coreShort = gearIronShort(true) > 0
    const need = ironWanted().filter(n => !(LOW_GEAR.has(n) && coreShort)).reduce((a, n) => a + IRON_COST[n], 0)
    // (the furnaces' iron first - a batch loaded before a restart or a dusk: taken, waited for while it smelts)
    if (inv.count(bot, 'iron_ingot') < need && smelt.furnaceCount(bot, 'iron_ingot') + smelt.furnaceCount(bot, 'raw_iron') > 0) await smelt.collectOf(bot, 'iron_ingot', { shouldStop: dayStop }).catch(() => 0)
    if (inv.count(bot, 'iron_ingot') < need && base.bankCount('iron_ingot') > 0) await base.withdraw(bot, 'iron_ingot', need - inv.count(bot, 'iron_ingot'))
    const rawWant = Math.max(0, need - inv.count(bot, 'iron_ingot'))
    if (inv.count(bot, 'raw_iron') < rawWant && base.bankCount('raw_iron') > 0) await base.withdraw(bot, 'raw_iron', rawWant - inv.count(bot, 'raw_iron'))
    const raw = Math.min(inv.count(bot, 'raw_iron'), rawWant)
    if (raw > 0) await smelt.smeltItem(bot, 'iron_ingot', raw, { noWithdraw: true })
    let made = 0
    for (const n of ironWanted()) {
      // shield and bucket come first: don't spend their ingots on something cheaper further down the list
      // (the legs and the feet only once the core is in hand: 7 ingots with the chestplate (8) still missing made leggings,
      //  and the core's shortfall sent the next trip out ahead of the castle again; audit)
      if (LOW_GEAR.has(n) && gearIronShort(true) > 0) continue
      if (inv.count(bot, 'iron_ingot') < IRON_COST[n]) { if (n === 'shield' || n === 'bucket') break; continue }
      if (await craft.ensure(bot, n, 1, { noWithdraw: true })) { made++; await inv.wearBestArmor(bot) }
    }
    return made > 0
  },
  async ironTrip () {
    let short = gearIronShort(ironTripCore)
    if (short <= 0) return true
    // THE SHIELD'S INGOT ON A TRIP OF ITS OWN: no shield and not the one ingot for it - the trip goes for that and comes home,
    // the shield is made (the iron decision), and the next trip goes down with it in hand. Three deaths in 1.7 hours went down
    // for all 14 of shield, chest and helmet in golden leggings and iron boots - a skeleton in the mine's caves, an enderman,
    // 2026-10-07; the arrows of a cave are what a shield stops
    if (!inv.hasShield(bot) && ironStock() < IRON_COST.shield) { short = Math.min(short, IRON_COST.shield - ironStock()); log('dir', `ironTrip: the shield's ${short} iron first - home with it before the rest`) }
    const before = inv.count(bot, 'raw_iron')
    mining.resetTripTunnelled()
    await gatherFor('raw_iron', short)
    const got = inv.count(bot, 'raw_iron') - before
    if (got > 0) log('dir', `ironTrip: dug ${got} raw iron for the gear`)
    // (a trip cut short - dusk, danger, a stop - found nothing because it looked at nothing: it marks no dryness. At dusk
    //  the trip was stopped with 0/28 before a block was dug and "no more trips" shut iron off for good, 2026-09-27)
    else if (dayStop() || taskCancelled()) log('dir', 'ironTrip: cut short before any iron - trying again another day')
    // (dry only after real tunnelling: a trip that never reached its face - blocked stairs, no pickaxe, a level given up - says
    //  nothing of the ore; audit)
    else if (mining.lastTripTunnelled() < 20) log('dir', `ironTrip: back with no iron after only ${mining.lastTripTunnelled()} blocks of tunnel - not a verdict on the ore`)
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
    // (ENOUGH FOR THE BUILD ends it as a full pack does: 25 spruce short, the third expedition held 62 and chopped on to fill
    //  the pack - another day and night 2400 blocks out, where a witch had killed the bot the day before, 2026-10-04. Asked
    //  only with a build job, of the whole build's shortfall against the stock the pack holds)
    let shortNow = null
    // (and only a raw the build uses: a key missing from the shortfall is also one never wanted - an orchard's run keeps its own
    //  endings; audit)
    const buildsIt = (() => { try { return mats.reservedSpecies(bot).has(mats.speciesOf(e.raw)) } catch { return false } })()
    if (build.getJob() && buildsIt) { try { const cs = build.cachedStatus(bot); shortNow = cs ? (mats.planFor(bot, cs.need).raw[e.raw] || 0) : null } catch {} }
    if (tripRoom() < 64) endExpedition('the pack is full')
    else if (shortNow === 0 && got > 0) endExpedition(`${inv.count(bot, e.raw)} ${e.raw} - enough for the build`)
    else if (o && o.outcome === 'none-found' && got <= 0) { e.dry++; mem.set('expedition', e); if (e.dry >= 2) { forage.noteTrip(e.raw, 0, 'none found on the expedition', { searched: true }); endExpedition('no more of it to be found') } }
    return got > 0 || (o && (o.outcome === 'lead' || o.outcome === 'stopped'))
  },
  async castle () { return castleWork() },
  async idle () { await move.sleep(5000); return true },
  async fillFreshCraters () { return (await require('./craters').fill(bot, { shouldStop: dayStop, onlyFresh: true })) > 0 },
  async fillCraters () { return (await require('./craters').fill(bot, { shouldStop: dayStop })) > 0 },
  async setSpawn () { return shelter.setSpawnAtBed(bot, { shouldStop: () => taskCancelled() }) },
  async leaveForeign () { return foreign.leave(bot, { shouldStop: () => taskCancelled() }) },
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
let demandTrees = { squares: 0, singles: 0 } // (orchard.demandFor: the squares and the singles the build's wood still wants)
// Wool the build still needs (its plan's raw wool), with demandTrees: the sheep pen is built for it.
let demandWool = 0
const cellCost = new Map() // item -> { raws, c }: one cell's raw cost by its recipe (stock-free) - pickRaw's order
let cellCostPlanner = null // (the planner the memo was priced by: a new one - reset, new routes, new home - clears it; audit)
// The pen's arguments: the wool wanted, and the wheat it may have - pack and bank, bread's share (three loaves) kept back
// while the bread is short
function penArgs () {
  const wheat = inv.count(bot, 'wheat') + base.bankCount('wheat')
  // (the bed's 3 when there is none: with the build's wool skipped the pen would never be sheared for it)
  const bedWool = mem.get().bed || shelter.hasBedItem(bot) ? 0 : 3
  return { woolWanted: demandWool + bedWool, wheat: Math.max(0, wheat - (foodStock() < FOOD_WANTED ? 9 : 0)) }
}
// (every log the orchard can grow, the class and each species - an exact-wood build asks for spruce_log and oak_log, never
//  'log': the castle 1000 spruce logs short sized its orchard to 23 trees, 2026-10-06. In squares and singles apart, each by
//  its own yield: orchard.demandFor)
function treesFor (tot) { return orchard.demandFor(tot.raw) }
const WINDOW_LAYERS = 4 // the layers above the lowest unfinished one the builder works in (build.nextNeeds)

function stock (name) { return inv.count(bot, name) + base.bankCount(name) }
// a build cell takes whatever may stand in for its item (any wood of the form, dirt for grass): by pool
function stockOf (name) { return mats.stock(bot, name) }
async function withdrawOf (name, want) { return mats.withdrawPool(bot, name, want) }
// The window's blocks out of the chest while two slots stay free (the pickups on the way): a stack of every kind first -
// the one-offs (a button, a flower) often anchor the band's lowest cells, and four stacks of stone taken first left no
// room for them (audit 2026-09-27) - then the big kinds topped up to four stacks
async function withdrawWindow (needs, lowY = {}) {
  // (the item the band waits on first: taken in the window's own order, the pack filled with trapdoors, signs, stairs and
  //  a grindstone before it came to stone_bricks - the band "waited on stone_bricks" for an hour with 875 in the chest,
  //  2026-09-30)
  // (and the rest in band order - each item by the lowest layer it goes in, the most first on a tie: lanterns and a
  //  grindstone for the upper floors come last, never the next layer's stone; audit)
  // (EVERY item the band's anchors miss goes first, the one named first of them: one named a round, the band anchored by two
  //  - a birch fence gate and dark oak stairs - got one each round and the stairs never fitted, 2026-10-03)
  const firsts = [...new Set([mem.get().buildWaiting, ...(typeof build.missingAnchors === 'function' ? build.missingAnchors() : [])].filter(nm => nm && needs[nm] != null))]
  const rank = nm => { const i = firsts.indexOf(nm); return i < 0 ? Infinity : i }
  const y = it => lowY[it] != null ? lowY[it] : Infinity
  const order = Object.entries(needs).sort((a, b) => (rank(a[0]) - rank(b[0])) || (y(a[0]) - y(b[0])) || (b[1] - a[1]))
  // ROOM FOR THE BAND'S OWN FIRST: a pack full of the window's upper-layer blocks (chests, grindstones, lightning rods,
  // doors - 31 kinds) took nothing, the "two slots free" rule returned at once, and the y125 band waited on dark oak stairs
  // with 182 in the chest, round after round (2026-10-03). Window blocks whose lowest layer is above the band's missing ones
  // go back to the chest, the highest first, until they all fit - only what is over the kit's keep and the scaffold stock
  // (a castle's torches, dirt and cobblestone are window needs too, and the kit's light went first; audit), and only for
  // the ones in the chest to take (else every round put the upper blocks back and took them out again; audit)
  // (THE HAUL FIRST: a round begun with the pack full of a trip's haul - spruce logs, saplings, wheat - had 2 slots for the
  //  window, took a handful of one-offs and never came to the band's own stone: "band anchored by stone (not in hand)", the
  //  step 1s, the round over to fetch 16 from the chest - 10 of 13 rounds placed nothing, 2026-10-07. What the window places
  //  none of goes to the chests first, by the deposit task's own rule (depositKeep), at home where the withdraw is anyway)
  if (inv.freeSlots(bot) < Math.min(Object.keys(needs).length + 2, 12) && depositHaulSize() > 0) await base.depositAll(bot, { keep: (b, i) => Math.max(depositKeep(b, i), build.FILLER_ITEMS.test(i.name) ? build.SCAFFOLD_WANT : 0) }).catch(() => false) // (the scaffold's stock stays: ensureScaffold just took it)
  const heads = firsts.filter(nm => countOf(nm) === 0 && stockOf(nm) > 0)
  await roomForBand(heads, firsts, needs, y, Math.min(heads.length + 1, 6))
  for (const cap of [64, 64 * 4]) {
    for (const [name, n] of order) {
      if (inv.freeSlots(bot) < 2) return
      const want = Math.min(n, cap) - countOf(name)
      if (want > 0) await withdrawOf(name, want)
    }
  }
}
// ROOM FOR WHAT THE BAND WAITS ON - one rule for the round's withdraw and the step's wait: the window's withdraw fills the
// pack by design (four stacks a kind, two slots left), the step's clearing and pickups take the rest, and the item the band
// then waits on found no slot - "the pack is full - no stripped_oak_wood taken", "0 taken out of the chests, back to the
// build", and the round went off on a trip instead, 2026-10-06. What goes back, in one deposit: first what the window places
// none of (a trip's haul, the clearing's logs and saplings), then the window's blocks for higher layers than the band's,
// highest first - never the kit's keep or the scaffold stock, never the waited items themselves
async function roomForBand (heads, waited, needs, y, room) {
  if (!heads.length || inv.freeSlots(bot) >= room) return
  const keep = nm => Math.max(base.keepCount(bot, { name: nm }), build.FILLER_ITEMS.test(nm) ? build.SCAFFOLD_WANT : 0)
  const lowHead = Math.min(...heads.map(y))
  const slotsOf = nm => inv.items(bot).filter(i => i.name === nm).length - Math.ceil(keep(nm) / 64)
  const names = [...new Set(inv.items(bot).map(i => i.name))].filter(nm => !waited.includes(nm) && keep(nm) !== Infinity && inv.count(bot, nm) > keep(nm))
  // (never the hands' own: shears, a bucket, flint and steel, food - the next leaf trip or pour wanted them back; and the haul
  //  by the slots it frees, the most first - a pair of shears went before a stack of logs; audit)
  const md = bot.registry || {}
  const haul = names.filter(nm => needs[nm] == null && !/^shears$|bucket$|^flint_and_steel$/.test(nm) && !(md.foodsByName && md.foodsByName[nm])).sort((a, b) => slotsOf(b) - slotsOf(a))
  const upper = names.filter(nm => needs[nm] != null && y(nm) > lowHead).sort((a, b) => y(b) - y(a))
  const back = new Map(); let free = inv.freeSlots(bot)
  for (const nm of haul.concat(upper)) { if (free >= room) break; const s = slotsOf(nm); if (s > 0) { back.set(nm, keep(nm)); free += s } }
  if (back.size) await base.depositAll(bot, { keep: (b, i) => back.has(i.name) ? back.get(i.name) : Infinity }).catch(() => false)
  log('dir', `no room for ${heads.join(', ')} (the band's) - put back ${back.size ? [...back.keys()].join(', ') : 'nothing'} (the haul, then window blocks for higher layers); ${inv.freeSlots(bot)} slots free`)
}
function countOf (name) { return mats.held(bot, name) }
function windowNeeds () { return typeof build.nextNeeds === 'function' ? build.nextNeeds(bot, WINDOW_LAYERS) : {} }
// THE BUILD'S OWN DRAW is no haul: the castle round withdrew the window's blocks and the deposit rule banked them straight back
// - "16 oak_leaves taken out ... back to the build", then "home with 66 items to store", then 64 taken out again, a minute a
// round, 2026-10-04. The window's needs (cached 30s - nextNeeds is a pass over the box) are kept by the deposit
let winKeepMemo = { at: 0, v: {} }
function windowKeep () { if (Date.now() - winKeepMemo.at > 30000) { let v = {}; try { v = build.getJob() ? windowNeeds() : {} } catch {} winKeepMemo = { at: Date.now(), v } } return winKeepMemo.v }
function depositKeep (b, i) { return Math.max(base.keepCount(b, i), windowKeep()[i.name] || 0) }
function depositHaulSize () { let n = 0; const seen = new Set(); for (const it of inv.items(bot)) { if (seen.has(it.name)) continue; seen.add(it.name); const k = depositKeep(bot, it); if (k !== Infinity) n += Math.max(0, inv.count(bot, it.name) - k) } return n }
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
async function loadSmelt (input, n, stop = null) {
  const room = Math.max(0, inv.freeSlots(bot) - 3) * 64
  if (inv.count(bot, input) < n) await base.withdraw(bot, input, Math.min(n - inv.count(bot, input), room)).catch(() => 0)
  const k = Math.min(n, inv.count(bot, input))
  if (k <= 0) return 0
  if (!await smelt.pickFuel(bot, k, { noGather: true })) { log('dir', `no fuel on hand for ${k} ${input} - it waits in the chest`); return 0 }
  return smelt.loadFurnaces(bot, input, k, { shouldStop: stop })
}

// At home between building and gathering: the furnaces emptied, refuelled and fed from the chest, and the
// crafts made. The SMELT QUEUE is the whole build's (clay->brick, cobble->stone->smooth stone, stone bricks->
// cracked, sand->glass: what the chest holds goes in, the window's first); the CRAFTS are the window's only,
// with the whole recipe yield - never all the bricks turned into stairs.
async function processAtHome (stop = dayStop) {
  const home = mem.get().home
  const st = build.cachedStatus(bot)
  if (!st) return
  phase('home: furnaces collect+refuel')
  await smelt.collectFurnaces(bot, { shouldStop: stop })
  if (stop()) return
  await smelt.refuelFurnaces(bot, { shouldStop: stop })
  if (stop()) return
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
  if (stop()) return
  if (tot.smeltTotal > 0) {
    const furns = smelt.homeFurnaces(bot)
    const want = furnaceTarget(tot)
    if (furns.length < want) log('dir', `${furns.length} furnaces for ${tot.smeltTotal} smelts - building up to ${want}`)
    // (the cobble for all of them in one trip to the chest: 8 at a time was a walk in through the door per furnace)
    const need = 8 * Math.max(0, want - furns.length)
    if (need && inv.count(bot, 'cobblestone') < need) await base.withdraw(bot, 'cobblestone', need - inv.count(bot, 'cobblestone')).catch(() => 0)
    for (let i = furns.length; i < want && inv.count(bot, 'cobblestone') >= 8; i++) {
      if (stop() || !await smelt.placeFurnace(bot)) break
    }
  }
  // fuel for the queue: charcoal from logs beyond the ones the next layers build with (one log smelts eight;
  // the brick line stalled on fuel with cobble waiting in the chest)
  phase('home: charcoal')
  if (stop()) return
  if (tot.raw.fuel > 0 && stock('coal') + stock('charcoal') < 32) {
    const spareLogs = Math.floor(smelt.woodSurplus(bot) / 4)
    // (never the build's own species: the most-stocked log was the orchard's spruce, and 31 of it went into the furnaces)
    const logName = Object.keys(Object.assign({}, inv.counts(bot), base.bankCounts())).filter(n => mats.LOG_ANY.test(n) && stock(n) > 0 && !mats.isReservedWood(bot, n)).sort((a, b) => stock(b) - stock(a))[0]
    if (logName && spareLogs >= 4) {
      const n = Math.min(32, spareLogs, stock(logName))
      if (inv.count(bot, logName) < n) await base.withdraw(bot, logName, n - inv.count(bot, logName))
      const loaded = await smelt.loadFurnaces(bot, logName, Math.min(n, inv.count(bot, logName)), { shouldStop: stop })
      if (loaded) log('dir', `burning ${loaded} ${logName} into charcoal for the smelting`)
    }
  }
  // the crafts that feed a furnace (stone -> stone bricks, to crack) are the queue's, the whole build's
  // the queue: what the BAND waits on first (its chain - smooth stone waits on stone waits on cobble), then the window's;
  // an input the window also places itself (cobblestone) goes in only beyond the window's own share - except for the band's
  // own chain. Before the feed crafts: they turned the stone the band's smooth_stone needed into stone bricks, and the
  // smooth stone got 1-2 a visit for an hour, 2026-10-03 (audit)
  phase('home: smelt queue')
  const winOut = new Set(win.smelts.map(s => s.output))
  const waitOn = mem.get().buildWaiting
  const bandChain = new Set(); if (waitOn) { try { for (const sm of mats.planFor(bot, { [waitOn]: 1 }).smelts) { bandChain.add(sm.output); bandChain.add(sm.input) } } catch {} bandChain.add(waitOn) }
  const rank = sm => (bandChain.has(sm.output) ? 2 : 0) + (winOut.has(sm.output) ? 1 : 0)
  for (const s of tot.smelts.slice().sort((a, b) => rank(b) - rank(a))) {
    if (stop()) break
    // (and a scaffold's worth of cobblestone kept back: the furnaces took the last of it for stone, and the build step went
    //  straight to the mine for 31 to stand on - a mine trip a round, 2026-09-28)
    // (one number with the builder's: what the other filler held or banked does not already cover)
    // (and only the OTHER filler the build does not place itself: the castle's andesite, tuff and coarse dirt counted as the
    //  scaffold's, every cobblestone went to stone, and the towers took the castle's own andesite a block at a time - "took 1
    //  andesite" on a 42b walk mid-step, 2026-10-06)
    const keepBack = s.input === 'cobblestone' ? Math.max(0, build.SCAFFOLD_WANT - Object.keys(Object.assign({}, inv.counts(bot), base.bankCounts())).filter(n0 => n0 !== 'cobblestone' && build.FILLER_ITEMS.test(n0)).reduce((t, n0) => t + Math.max(0, stock(n0) - (st.need[n0] || 0)), 0)) : 0
    const n = Math.min(s.n, stock(s.input) - (s.output === waitOn ? 0 : (win.top[s.input] || 0)) - keepBack, 64 * Math.max(1, smelt.homeFurnaces(bot).length))
    if (n < 1) continue
    const k = await loadSmelt(s.input, n, stop)
    if (k) log('dir', `smelting ${k} ${s.input} -> ${s.output} (${s.n} more ${s.output} wanted for the ${st.name})`)
  }
  // the crafts that feed a furnace (stone -> stone bricks, to crack) are the queue's, the whole build's - after it
  phase('home: feed crafts')
  const feed = tot.crafts.filter(c => mats.SMELT_INPUTS.has(c.item))
  if (feed.length) { await mats.makeCrafts(bot, feed, { keep: withGearKeep(win.top), shouldStop: stop }); tot = mats.planFor(bot, st.need) }
  // the window's crafts, ingredients first (planks before stairs, bricks before brick stairs)
  phase('home: window crafts')
  const win2 = mats.planFor(bot, winNeeds)
  if (win2.crafts.length) {
    const made = await mats.makeCrafts(bot, win2.crafts, { keep: withGearKeep(win2.top), shouldStop: stop })
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
  { const lowY = {}; await withdrawWindow(build.nextNeeds(bot, WINDOW_LAYERS, lowY), lowY) } // (one pass: the needs and each one's lowest layer)
  // what does the next stretch of building need?
  const lowest = j.cells.filter(c => build.cellDone(bot, c) !== true)
  const minY = Math.min(...lowest.map(c => c.y))
  // site prep for the band being built only (next 3 layers + headroom): the rest of the footprint
  // is cleared as the walls rise, from the walls - never a whole day on a canopy 12 blocks up.
  // Leaves don't block building unless they sit in a cell; walking cuts through them.
  phase('site clearing')
  const bandTop = minY + 4
  const obs = build.unskippedObstructions(bot, { maxY: bandTop, floatingLogs: true }).filter(b => !world.LEAF_RE.test(b.name) || j.index.has(build.key(b.position))).length
  if (obs > 0) {
    await build.ensureScaffold(bot, build.SCAFFOLD_WANT, { shouldStop: dayStop })
    const n = await build.clearSite(bot, { shouldStop: dayStop, maxBlocks: 200, maxY: bandTop })
    // (cleared: on to the building in the same round - ending it here sent the next round home for its home jobs)
    // nothing clearable right now: get on with materials meanwhile
  }
  // the build's own blocks laid where no cell wants them (the planner's stepping stones): taken back up
  phase('strays')
  {
    // (a stray that would not come up twice rests the day: one dark_oak_slab was tried and failed every round for an hour -
    //  eight rounds, ~30s each - and taken at the ninth, 2026-09-30; the day's rest as the tidy's and the misses' go)
    const today = day.dayNo(bot); const sk = p => p.x + ',' + p.y + ',' + p.z
    // (and the rest GROWS: its count kept across days - two misses rest a day, then 2, 4, up to 8: one stone brick no walk got
    //  to "would not come up: no way within reach (timeout)" every round, 20-30s of each, 2026-10-06)
    const strays = (await build.strayBuildBlocks(bot)).filter(p => { const m = strayMiss.get(sk(p)); return !m || m.n < 2 || today - m.day >= Math.min(8, Math.pow(2, m.n - 2)) })
    if (strays.length) {
      let n = 0
      // (THE WALK SEARCH FIRST, as the clearing's: a stray with no stand the search reaches within a player's reach is a miss
      //  with no walk - the dig's own look-at walk ran its 20s out at two spruce planks in the castle every round, 127s of the
      //  evening's rounds, 2026-10-06. The search no answer (capped, from home): the dig's walk as before)
      const noStand = async s => { if (act.reach(bot, new Vec3(s.x, s.y, s.z), 4.3)) return false; await build.walkReach(bot).catch(() => null); return build.reachStandFor(bot, s) === false }
      for (const s of strays.slice(0, 30)) { if (dayStop()) break; const ns = await noStand(s); if (!ns && await act.dig(bot, s, { force: true, allowZones: ['build', 'base'], timeoutMs: 30000 })) { n++; strayMiss.delete(sk(s)) } else { log('dir', `stray ${s.name || 'block'} at ${sk(s)} would not come up: ${ns ? 'no stand the walk search reaches - no walk' : act.lastDigWhy() || 'unknown'}`); const m = strayMiss.get(sk(s)); strayMiss.set(sk(s), { n: (m ? m.n : 0) + 1, day: today }) } }
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
  // (not when what the band waits on is in stock: 26 campfires sat in the chest while the round went off for 118 logs "first",
  //  and the step that would have placed them never ran, 2026-10-02 analysis - the step withdraws it)
  if (mem.get().buildWaiting && inv.count(bot, mem.get().buildWaiting) + base.bankCount(mem.get().buildWaiting) > 0) { log('dir', `the build waits on ${mem.get().buildWaiting} - in stock, the step takes it`); mem.set('buildWaiting', null) }
  if (mem.get().buildWaiting) {
    // (cleared only when a trip goes for it: cleared here with nothing short - the planks' logs in stock - the withdraw just
    //  below never saw what the band waited on, filled the pack with trapdoors and signs, and the band waited on
    //  dark_oak_planks with them in the chest, 2026-09-30)
    const want = mem.get().buildWaiting
    const win0 = mats.planFor(bot, windowNeeds())
    const chain0 = Object.keys(mats.getPlanner(bot).plan({ [want]: 1 }).raw)
    // (fuel first when the furnaces have none: the chain's other raw is often in the chest already, waiting on it - 92 clay
    //  balls sat there while every morning went to more clay, and the fuel trip came at dusk, too late for a coal seam,
    //  2026-09-28)
    // (the test is the bottleneck itself - the planner's own: the window's smelts, stone from its cobble and bricks from
    //  its clay among them, less the coal and charcoal held and in the furnaces. One number, not a hand count; audit)
    const noFuel = (win0.raw.fuel || 0) > 0
    const raw0 = (noFuel && chain0.includes('fuel') ? 'fuel' : null) || chain0.find(r => r !== 'fuel' && win0.raw[r] > 0) || chain0.find(r => win0.raw[r] > 0)
    const fits = r => r !== 'clay_ball' && r !== 'sand' ? tripFitsDay(r) : (r === 'sand' ? !clay.exhausted('sand') && clay.tripFits(bot, 'sand') : !clay.exhausted() && clay.tripFits(bot))
    if (raw0 && fits(raw0)) {
      log('dir', `the build waits on ${want} - ${win0.raw[raw0]} ${raw0} first, while the day is young`)
      // (a packful - see the round's gather below: the whole build's shortfall, from the cached castle status)
      let whole = 0; try { const cs = build.cachedStatus(bot); whole = cs ? (mats.planFor(bot, cs.need).raw[raw0] || 0) : 0 } catch {}
      mem.set('buildWaiting', null)
      const ok0 = await gatherFor(raw0, Math.max(win0.raw[raw0], Math.min(whole, tripRoom())))
      if (inv.freeSlots(bot) < 8 || ok0) await base.depositHaul(bot, { shouldStop: dayStop })
      if (ok0) return true
    }
  }
  // the same window the builder works in (it builds past a missing material, so the bricks for those layers
  // must come out of the chest too - with glass short, nothing was withdrawn and nothing built)
  phase('window')
  const nextLow = {}; const next = build.nextNeeds(bot, WINDOW_LAYERS, nextLow)
  // withdraw what we have for it (anything that stands in: birch stairs for jungle stairs)
  await build.ensureScaffold(bot, build.SCAFFOLD_WANT, { shouldStop: dayStop })
  await withdrawWindow(next, nextLow)
  let carrying = 0
  for (const name of Object.keys(next)) carrying += countOf(name)
  let blockedOn = null
  // (starved of stone: straight to the mine, not a build step over the few cells in hand - eight minutes placed one
  //  block 58 away while the next layers were 1900 cobblestone short, and the mine got the last three, 2026-09-27)
  const winShort = mats.planFor(bot, next).raw.cobblestone || 0
  // (only when there is little to place: with 256 stone bricks, 192 planks and the stairs in hand for the spawn hub, two
  //  whole days went to coal and cobble for the layers after them, 0 placed - 523s and 412s rounds, 2026-10-03. What is in
  //  hand goes in first; the step's own wait then steers the gathering)
  if (winShort > 512 && countOf('cobblestone') < 64 && carrying < 64) { log('dir', `${winShort} cobblestone short with ${countOf('cobblestone')} in hand and ${carrying} blocks for the next layers - mining first`); carrying = 0 }
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
  // (the item the band waits on lies in the chests: out with it and back to the build - not a trip for the next thing on
  //  the list. 63 dirt banked while the round went for gravel, 208s, into someone else's place, 2026-10-03)
  if (steer && !blockedRaw && base.bankCount(steer) > 0) {
    { const yl = it => nextLow[it] != null ? nextLow[it] : Infinity; await roomForBand(countOf(steer) === 0 ? [steer] : [], [steer], next, yl, 2) } // (a slot for it first: roomForBand)
    const n = Math.min(base.bankCount(steer), Math.max(16, (next[steer] || 0) - inv.count(bot, steer)))
    const got = await base.withdraw(bot, steer, n).catch(() => 0)
    log('dir', `the builder waits on ${steer} - ${got} taken out of the chests, back to the build`)
    if (got > 0) return true
  }
  // a trip needs a working day ahead of it: close to dusk only what is gathered round home (a walk to the mine
  // face that arrived as dusk fell was a minute and a half for nothing; a clay bank is further still)
  const nearDusk = world.ticksUntilNight(bot) < 2400
  const feasible = r => {
    if (!mats.hasRoute(r)) return false // (no skill for it yet: its cells wait, never a trip)
    // (put off for today - gatherFor refuses it at once: picked anyway, the spruce put off for food took the pick every
    //  round and the dark oak 245b off never got one, 2026-10-04)
    { const put = notToday.get(r); if (put && !(day.dayNo(bot) > put.day)) return false }
    if (r === 'clay_ball') return !clay.exhausted() && clay.tripFits(bot)
    if (r === 'sand') return !clay.exhausted('sand') && clay.tripFits(bot, 'sand')
    return tripFitsDay(r)
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
// (kept in memory.json - mem.persistedMap: a restart wiped it, and the deepslate trips' count never reached two)
const notToday = mem.persistedMap('notToday') // raw -> { day } (the day it was put off - open again on a later one: day.js)
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
// (and armour - 8 points - or a shield worn: out for nights on a naked body after the day's deaths is a grave far out; audit)
function expeditionGuarded () { return inv.armorPoints(bot) >= 8 || !!inv.offhandShield(bot) }
// EVERYTHING AN EXPEDITION WAITS ON BUT THE FOOD - one test for startExpedition and decide's packing rule: packed for a trip
// that waited on armour, the food was hunted for again every time it was eaten below the line, all day (audit)
function expeditionReadyBarFood () { return bot.health >= 16 && !!inv.bestWeapon(bot) && !!inv.bestTool(bot, 'axe', 1) && expeditionGuarded() }
async function startExpedition (raw, land) {
  if (expedition()) return true // (one at a time: the castle loop's second ask found it already set out)
  // packed from the bank while home is a short walk (the castle loop asks from the site): the food first - the pack's
  // own food only ever rises to the food rule's line, so a gate on it alone waited every day for ever - and the
  // cobblestone for the axes (audit 2026-09-28)
  let packed = false
  if (base.distHome(bot) < 64) {
    // (NOTHING BUT THE KIT GOES: days out, a death is a grave thousands of blocks off. The trip's pre-deposit runs only on a
    //  64-item haul, and the build window's blocks stay by the routine rule - the third spruce expedition set out with 3 iron
    //  blocks (27 iron), dark oak slabs and planks, gravel, seeds; the second died to a witch with 130 items. Tools, armour,
    //  food, the boat, torches and the scaffold's footing stay - base.keepCount and SCAFFOLD_WANT, 2026-10-04)
    if ((mem.get().chests || []).length) {
      const fill = {}; let need = build.SCAFFOLD_WANT
      for (const [n, c] of Object.entries(inv.counts(bot)).filter(([n]) => build.FILLER_ITEMS.test(n)).sort((a, b) => b[1] - a[1])) { const t = Math.min(c, need); if (t > 0) { fill[n] = t; need -= t } }
      await base.depositAll(bot, { keep: (b, i) => Math.max(base.keepCount(b, i), fill[i.name] || 0) }).catch(() => false)
    }
    for (const name of inv.GOOD_FOOD) {
      if (inv.foodPoints(bot) >= FOOD_OUT) break
      if (base.bankCount(name) > 0) await base.withdraw(bot, name, Math.min(16, base.bankCount(name))).catch(() => 0)
    }
    if (inv.count(bot, 'cobblestone') < COBBLE_OUT) await base.withdraw(bot, 'cobblestone', COBBLE_OUT - inv.count(bot, 'cobblestone')).catch(() => 0)
    packed = true
  }
  const food = inv.foodPoints(bot)
  const guarded = expeditionGuarded()
  if (food < FOOD_OUT || !expeditionReadyBarFood()) { log('dir', `${raw}: its country is past a day's walk - an expedition waits on ${food < FOOD_OUT ? 'food (' + food + ' pts packed' + (packed ? ', the bank included' : ' (the bank not reached from here)') + ', ' + FOOD_OUT + ' wanted - cooking and the farm make the rest)' : bot.health < 16 ? 'health' : !guarded ? 'armour (8 points) or a shield - the iron gear first' : 'a weapon and an axe'}`); return false }
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
// (ANY raw whose trips bring back none, twice in a day: the same rest. Six deepslate trips down a mine whose stairs stop at
//  y12, over deepslate's band, came back 0/17 every time - five minutes a round, all night, 2026-09-30. Once for an
//  animal (they never respawn round home), twice for the rest (a vein can be missed once))
const emptyTrips = mem.persistedMap('emptyTrips') // raw -> { day, n }
const noneStreak = mem.persistedMap('noneStreak') // raw -> { until, n }: days running a raw's trips found none
// (the build's backbone takes four: an empty trip can be a failed walk, a full pack, a creeper's hold - two of those and
//  the castle's main raw would be off for the day, a bigger stall than the one this stops; audit)
const CORE_RAW = /(_log|^log|^cobblestone|^sand|^clay_ball|^fuel|^coal|^stone|^dirt|^gravel)$/
async function gatherFor (raw, short) {
  reflex.setCautious(true) // (an optional trip does not fight: cover over a charge - reflex.setCautious)
  let ok = false
  // (pack and bank: the trip's own start empties the pack into the chests)
  const re = new RegExp(`^${raw}$`)
  const got = () => inv.count(bot, re) + Object.entries(base.bankCounts()).filter(([n]) => re.test(n)).reduce((a, [, c]) => a + c, 0)
  const had = got(); const t0 = Date.now()
  try { ok = await gatherForInner(raw, short); return ok } finally {
    reflex.setCautious(false)
    // (none at all: a trip that got some fell short, and found where they are)
    // (a trip the dusk cut short counts too once it had looked - two minutes and more: the deepslate trips mined 0/17 for
    //  six minutes each and ended "stopped" at dusk, so none ever counted and the next day's round went again)
    if (got() > had) noneStreak.delete(raw) // (found some: the streak is over)
    if (!ok && got() <= had && !notToday.has(raw) && (!dayStop() || Date.now() - t0 > 120000) && !forage.tripWasCut(raw, t0)) {
      const d = day.dayNo(bot); const e = emptyTrips.get(raw); const n = e && e.day === d ? e.n + 1 : 1
      emptyTrips.set(raw, { day: d, n })
      // (DAY AFTER DAY none: the hold grows a day a time (to four) - flowers round home picked out, the dandelion and bluet
      //  trips took each morning's first hours and came back empty, and pumpkin and wool, never tried, waited for a morning
      //  that never came, 2026-10-04. The streak breaks on any day the raw was found or not put off)
      if (ANIMAL_RAW.test(raw) || n >= (CORE_RAW.test(raw) ? 4 : 2)) {
        const sk = noneStreak.get(raw); const streak = sk && d - sk.until <= 1 ? sk.n + 1 : 1
        const hold = CORE_RAW.test(raw) ? 0 : Math.min(streak - 1, 3) // (never the backbone: its empty trips are often a broken path or a full pack; audit)
        noneStreak.set(raw, { until: d + hold, n: streak })
        notToday.set(raw, { day: d + hold })
        log('dir', `${raw}: ${n > 1 ? n + ' trips' : 'the trip'} found none - not again ${hold ? 'for ' + (hold + 1) + ' days (' + streak + ' days running)' : 'today'}`)
      }
    }
  }
}
async function gatherForInner (raw, short) {
  if (dayStop()) return false
  const put = notToday.get(raw)
  if (put) { if (!(day.dayNo(bot) > put.day) || world.isNight(bot)) return false; notToday.delete(raw); log('dir', `${raw}: a new day - the trip is open again`) }
  // AN EMPTY PACK FOR THE TRIP: a trip is sized by the room in the pack, and the pack left home with what the builder
  // had drawn out and the last trips brought - 300-400 items stored only after the walk back ("home with 405 items to
  // store", 2026-09-28). At home, the haul goes in first: the same line as the deposit's own (haulSize >= 64)
  // (a cobble trip from the site: home first - the mine is by home - so the pack holds the haul, not the window's blocks:
  //  "pack full - taking the haul home" two minutes into a trip, the walk home and back, then dusk; audit 2026-10-03)
  // (ANY trip, not only cobble: an oak_leaves trip set out from the site with the window's blocks in the pack - "the pack is
  //  full - no oak_planks taken", the shears' sticks never made, a birch felled 79b out for nothing, 2026-10-03)
  if (base.distHome(bot) >= 24 && (mem.get().chests || []).length && (haulSize() >= 64 || inv.freeSlots(bot) < 4)) await base.goHome(bot, { shouldStop: dayStop }).catch(() => null)
  if (base.distHome(bot) < 24 && (mem.get().chests || []).length && (haulSize() >= 64 || inv.freeSlots(bot) < 4)) {
    const before = inv.freeSlots(bot)
    // (never the trip's own footing: filler stays for the planner's steps and a tower out of a pit - audit)
    // (SCAFFOLD_WANT of ANY filler, the most plentiful first: with no cobble but a stack of andesite, the andesite stays)
    const fill = {}; let need = build.SCAFFOLD_WANT
    for (const [n, c] of Object.entries(inv.counts(bot)).filter(([n]) => build.FILLER_ITEMS.test(n)).sort((a, b) => b[1] - a[1])) { const t = Math.min(c, need); if (t > 0) { fill[n] = t; need -= t } }
    await base.depositAll(bot, { keep: (b, i) => Math.max(base.keepCount(b, i), fill[i.name] || 0) }).catch(() => false)
    log('dir', `emptied the pack for the ${raw} trip: ${before} -> ${inv.freeSlots(bot)} free slots`)
  }
  const batch = Math.min(short, tripRoom())
  // (ironKeep: the gear's ingots - gearIronKeep - for a trip's own crafts to leave alone: the spare shears; audit)
  const ctx = { shouldStop: dayStop, ironKeep: () => gearIronKeep().iron_ingot }
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
      // (never the build's own species here - the class takes any wood, and a mega spruce cut for campfires is the castle's
      //  spruce gone to the class: mats.isReservedWood)
      if (await orchard.harvest(bot, { logs: batch, demand: demandTrees, shouldStop: dayStop, skip: n => mats.isReservedWood(bot, n) }) >= Math.min(batch, 16)) return true
      // whatever wood grows nearest (every wood cell and wooden form takes local wood)
      const w = nearestWood() + '_log'
      return craft.ensure(bot, w, inv.count(bot, w) + batch, Object.assign({ noWithdraw: true, leaves: orchard.wantSaplings(bot, demandTrees, w) > 0 }, ctx))
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
        const want = Math.min(short, Math.max(8, Math.floor(tripRoom() / 2))) // (short is in COALS already - the planner adds 1/8 a smelt; /8 again fetched an eighth: 24 fuel rounds, 2026-10-03; audit)
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
      // (never the build's own species: a mega spruce burnt to charcoal is a hundred of the castle's logs - mats.isReservedWood)
      const fromOrchard = await orchard.harvest(bot, { logs: Math.ceil(short * 8 / 7), demand: demandTrees, shouldStop: dayStop, skip: n => mats.isReservedWood(bot, n) })
      if (fromOrchard >= 8) {
        const r0 = await base.goHome(bot, { shouldStop: dayStop })
        // (only what the orchard just gave - the build's own logs in the pack are not fuel)
        if (r0.ok) { let left = fromOrchard; let burnt = 0; for (const [n, c] of Object.entries(inv.counts(bot))) { if (left <= 0) break; if (mats.LOG_ANY.test(n) && !mats.isReservedWood(bot, n) && c > 0) { const k = Math.min(c, left); left -= k; burnt += await smelt.burnForCharcoal(bot, n, k) } } if (burnt > 0) return true }
      }
      const w = nearestWood() + '_log'
      const before = inv.count(bot, w)
      // (a log's charcoal smelts 8 and burning it costs an eighth: 8/7 logs a unit of fuel)
      const ok = await craft.ensure(bot, w, before + Math.min(tripRoom(), Math.max(8, Math.ceil(short * 8 / 7))), Object.assign({ noWithdraw: true, leaves: orchard.wantSaplings(bot, demandTrees, w) > 0 }, ctx))
      const cut = inv.count(bot, w) - before
      // these logs are the fuel: straight into the furnaces as charcoal (never into the build's wood pool)
      if (cut >= 2) { const r = await base.goHome(bot, { shouldStop: dayStop }); if (r.ok) return (await smelt.burnForCharcoal(bot, w, cut)) > 0 }
      return ok
    }
    case 'wool': case 'white_wool': return food.woolFor(bot, Math.min(short, 16), ctx)
    case 'red_flower': return gather.pickPlants(bot, /^(poppy|red_tulip|rose_bush)$/, /^(poppy|red_tulip|rose_bush)$/, Math.min(short, 16), ctx)
    default:
      // A SPECIES' LOGS (an exact-wood build asks for spruce_log, not 'log'): the orchard's grown trees of THAT species first
      // - a mega spruce is 30-60 logs twenty blocks from home. Routed straight to the wild chop, the spruce trip cut one
      // tree and explored 176-208 blocks out past two grown mega spruces in the orchard, 2026-09-29
      if (/_log$/.test(raw) && raw !== 'log') { const got = await orchard.harvest(bot, { logs: batch, demand: demandTrees, species: raw, shouldStop: dayStop }); if (got >= Math.min(batch, 16)) return true }
      // forage skills: one gatherer each; a source searched out round home is marked (its cells wait, another is used)
      if (forage.handles(raw)) return forage.gather(bot, raw, batch, ctx)
      // sand, dirt, gravel, raw iron: the generic route (surface digging, the mine)
      {
        const before = inv.count(bot, raw)
        const t0 = Date.now()
        const ok = await craft.ensure(bot, raw, before + batch, raw === 'string' ? Object.assign({ web: true }, ctx) : ctx) // (the build's string: the mineshaft's webs are this trip's, never a craft's)
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
            if ((o.trip > DAWN_TICKS || world.ticksUntilNight(bot) > 2400) && await startExpedition(raw, o.land)) { /* (logged there) */ } else { notToday.set(raw, { day: day.dayNo(bot) }); mem.set('farTrip', { raw, land: o.land || null, day: day.dayNo(bot) }); log('dir', `${raw}: not today - too far for the daylight left - first thing tomorrow`) }
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
      if (!foreign.looked()) { await move.sleep(300); continue } // (a spawn: someone else's place round us known first - foreign.js)
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
  bot.on('sleep', () => { try { mem.set('sleptDay', day.dayNo(bot)) } catch {} }) // (the spider night's phantom limit: the last night slept)
  try { if (mem.get().sleptDay == null) mem.set('sleptDay', day.dayNo(bot)) } catch {} // (none on record: counted from now, never an unlimited run)
  bot.on('spawn', () => { setTimeout(() => { try { if (bot.entity && move.insideHut(world.feetPos(bot))) hut.shutDoor(bot).catch(() => {}) } catch {} }, 1500) })
  baseZone()
  orchard.setZone()
  pen.setZone()
  const bj = mem.get().build
  if (bj) { try { await build.setJob(bot, bj.name, bj.origin, { exactWood: bj.exactWood === true }) } catch (e) { log('dir', `couldn't load build ${bj.name}: ${e.message}`) } }
  // a saved base with no box on record gets it from its build (saved while the job was still loading: our own hub read as
  // someone else's place, 2026-10-06) - before the foreign start, whose prune then forgets the wrong record
  for (const [k, r] of Object.entries(mem.get().bases || {})) {
    if (!r || r.box || !r.build || !r.build.name || !r.build.origin) continue
    const same = q => q && !q.box && q.build && q.build.name === r.build.name && q.build.origin && q.build.origin.x === r.build.origin.x && q.build.origin.y === r.build.origin.y && q.build.origin.z === r.build.origin.z
    try { const box = await build.boxFor(bot, r.build.name, r.build.origin, r.build.prefs); mem.update(mm => { const cur = mm.bases && mm.bases[k]; if (same(cur)) cur.box = box }); log('base', `base "${k}" box from its build: ${box.x1}..${box.x2} ${box.z1}..${box.z2}`) } catch (e) { log('base', `base "${k}" box: ${e.message}`) }
  }
  bootReady = true
  // someone else's place round us, known before the first decision - judged once our own build and zones are known (before
  // them, the castle's far side read as someone else's; audit). Then on its own beat
  try { foreign.start(bot); await foreign.scan() } catch (e) { log('foreign', 'start threw: ' + e.message) } // (jobs saved before the wood rule: any wood, as they were built)
  loop()
}

function info () { return current ? { name: current.name, detail: current.why, forSec: Math.round((Date.now() - current.since) / 1000) } : null }
function setPaused (p) { const was = paused; paused = !!p; if (paused) { control.abort(); move.stopMoving(bot) } if (was !== paused) log('dir', paused ? 'paused' : 'resumed') }
async function waitIdle (maxMs = 30000) { const t0 = Date.now(); while (running && Date.now() - t0 < maxMs) await move.sleep(200) }
function forceTask (name) { if (!TASKS[name]) return false; override = name; control.abort(); return true }

module.exports = { focus, recent, start, info, setPaused, forceTask, decide, TASKS, waitIdle, isPaused: () => paused, isReady: () => bootReady }
