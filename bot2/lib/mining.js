'use strict'
// The mine: one staircase down from near home to a working level, then a serpentine 1x2 tunnel.
// Cobblestone, coal and iron all come out of the same tunnel. Every cell is checked for fluids
// before it is opened; ores visible in the walls are taken; torches keep the tunnel lit.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const base = () => require('./base')
const craft = () => require('./craft')

const LEG_LEN = 40
// the tunnel is 3 wide (openTunnelCell): a leg shifts 4 over, a wall of one between it and the last - shifted 3, the new
// leg ran against the old one and "walled up 3 cave openings" every step: our own tunnel, a third of the cobble put back
const SHIFT = 4
const WANT_ORES = /^(coal_ore|deepslate_coal_ore|iron_ore|deepslate_iron_ore|diamond_ore|deepslate_diamond_ore)$/ // what the bot uses: fuel/torches, iron gear, diamonds (copper/gold/redstone/lapis only filled the pack)
const DIRS = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }]

function V (p) { return new Vec3(p.x, p.y, p.z) }

function fluidAround (bot, p, skip) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz }
    if (skip && skip(q)) continue
    const b = world.at(bot, q.x, q.y, q.z)
    if (!b) return 'unknown'
    if (world.isLavaBlock(b)) return 'lava'
    if (world.isWaterBlock(b)) return 'water'
  }
  return null
}

// Pick a mine entrance: dry, standable ground 10-30 blocks from home, outside protected zones.
// Would a staircase from p heading dir run near a place that has killed us underground, or under a
// protected build? (checked 70 blocks along the way)
function pathBad (p, dir) {
  const deaths = (mem.get().deaths || []).filter(d => d.cause !== 'void' && d.y < 60)
  for (let k = 0; k <= 70; k += 4) {
    const q = { x: p.x + dir.x * k, z: p.z + dir.z * k }
    if (deaths.some(d => world.dist2(d, q) < 24)) return true
    if (underOwnZone(q)) return true
  }
  return false
}
function chooseEntrance (bot, oreLv = null) {
  const home = mem.get().home || world.feetPos(bot)
  const levelFor = y => oreLv != null ? Math.min(oreLv, y - 8) : levelOf(y)
  // rings out to 64 blocks, every stair direction: the nearest spot whose staircase stays clear of known death
  // sites and protected builds (one direction from a 10-30 ring left "no safe spot" in cave country)
  let bestOre = null
  for (let r = 10; r <= 64; r += 6) {
    const found = []
    for (let a = 0; a < 16; a++) {
      const x = Math.round(home.x + Math.cos(a * Math.PI / 8) * r)
      const z = Math.round(home.z + Math.sin(a * Math.PI / 8) * r)
      const gy = world.groundY(bot, x, z, Math.floor(home.y) + 16)
      if (gy == null) continue
      const y = gy + 1
      if (!world.standable(bot, x, y, z)) continue
      // (nor on the home grounds: a stairwell by the farm was a hole in the yard, on the walk home, dug at night)
      if (move.inZone({ x, y, z }, 6) || underOwnZone({ x, z }) || require('./gather').onGrounds({ x, y, z })) continue
      if (world.waterNear(bot, { x, y, z }, 4, -3, 1) || world.lavaNear(bot, { x, y: y - 2, z }, 3)) continue
      if ((mem.get().badMines || []).some(bm => world.dist2(bm, { x, z }) < 12)) continue
      const away = Math.abs(x - home.x) > Math.abs(z - home.z) ? { x: Math.sign(x - home.x) || 1, z: 0 } : { x: 0, z: Math.sign(z - home.z) || 1 }
      // every open direction, the one whose covered stairs reach deepest (on a mountain top none reaches y16: the
      // tunnel runs inside the mountain at the depth the cover allows - stone is stone for cobble)
      let bestDir = null
      for (const dir of [away, { x: away.z, z: away.x }, { x: -away.z, z: -away.x }]) {
        if (pathBad({ x, z }, dir)) continue
        const lv = coveredLevel(bot, { x, y, z }, dir, levelFor(y))
        if (lv != null && (!bestDir || lv < bestDir.level)) bestDir = { dir, level: lv }
      }
      if (bestDir) found.push({ x, y, z, dir: bestDir.dir, level: bestDir.level })
    }
    // (for an ore: the spot whose tunnel works nearest the ore's band - out to the next ring when this one has none
    //  within 6; the nearest spot otherwise)
    if (oreLv != null && !found.length && bestOre && r + 6 > 64) found.push(bestOre)
    if (oreLv != null && found.length) {
      found.sort((a, b) => Math.abs(a.level - oreLv) - Math.abs(b.level - oreLv))
      if (!bestOre || Math.abs(found[0].level - oreLv) < Math.abs(bestOre.level - oreLv)) bestOre = found[0]
      if (Math.abs(bestOre.level - oreLv) > 6 && r + 6 <= 64) continue
      found.unshift(bestOre)
    }
    if (found.length) {
      const p = found[0]
      if (p.level > levelFor(p.y)) log('mine', `the stairs stay under cover only to y${p.level} here (a hillside) - tunnelling there`)
      return { entrance: { x: p.x, y: p.y, z: p.z }, dir: p.dir, cursor: { x: p.x, y: p.y, z: p.z }, level: p.level, stairsDone: false, leg: 0, legPos: 0, blocks: 0 }
    }
  }
  return null
}
function saveMine (m) { mem.set('mine', m) }
function levelOf (y) { return Math.max(12, Math.min(y - 20, 16)) }
// WHERE AN ORE IS: the tunnel's level for an ore trip - the 5-high band (the tunnel and the walls in reach of it) with
// the most of that ore in the rock round home. The mine always went to y12-16: on a mountain the iron is in the
// mountain, and a 110-block tunnel at y20 turned up none while veins sat in the rock 10 blocks from the door (2026-09-25).
// Only rock at least 8 under home's level (a tunnel under cover); null when no band holds enough to be worth a trip.
async function oreLevel (bot, itemName) {
  const g = craft().GATHER[itemName]
  const home = mem.get().home
  if (!g || !g.ore || !home) return null
  const ores = await world.scanBlocks(bot, g.blocks, { maxDistance: 64, count: 1500, point: home })
  const at = new Map()
  for (const b of ores) if (b.position.y <= home.y - 8) at.set(b.position.y, (at.get(b.position.y) || 0) + 1)
  let best = null
  for (const y of at.keys()) {
    let n = 0
    for (let dy = -1; dy <= 3; dy++) n += at.get(y + dy) || 0
    if (n >= 6 && (!best || n > best.n)) best = { y: y + 1, n }
  }
  return best
}
// Does a staircase from p heading dir stay under the ground all the way down to `level`? The stairs drop one a step; on
// a mountain the slope drops faster, and a staircase heading downhill came out of the hillside into open air at y86-103
// - "the stairs are blocked, far above the working depth" - four new mines in twelve minutes (2026-09-24). Each step
// past the first few needs the surface over it above the stair's own head room; unloaded ground is unknown (no).
// Returns the deepest level the stairs reach under cover (at most `level`), or null when they are out in the open
// before they are 8 below the entrance (no mine worth the name: a tunnel needs rock over it).
function coveredLevel (bot, p, dir, level) {
  let deepest = null
  for (let k = 4; k <= p.y - level; k++) {
    const x = p.x + dir.x * k; const z = p.z + dir.z * k
    const gy = world.groundY(bot, x, z, p.y + 8)
    if (gy == null || gy < p.y - k + 3) break
    deepest = p.y - k
  }
  // (the tunnel legs run level from there: its own run needs cover too - a few steps back up keeps it inside)
  if (deepest == null || p.y - deepest < 8) return null
  return Math.min(p.y - 8, deepest + 4)
}

let broken = 0 // blocks the tunnel has broken - the mine loop's one sign of progress (a step through open cells breaks none)
async function openCell (bot, p) {
  for (let i = 0; i < 8; i++) {
    const b = world.at(bot, p.x, p.y, p.z)
    if (!b) return false
    if (world.isAirish(b)) return true
    if (world.isWaterBlock(b) || world.isLavaBlock(b)) return false
    if (/^(bedrock|chest|spawner|barrel)$/.test(b.name) || b.hardness < 0) return false
    if (!world.NATURAL_RE.test(b.name) && !/_planks$|rail|fence|cobweb/.test(b.name)) return false // don't dig through structures
    const ok = await act.dig(bot, p, { force: true, timeoutMs: 12000 })
    if (!ok) return false
    broken++
    await move.sleep(world.FALLING_RE.test(b.name) ? 700 : 60)
  }
  return world.isAirish(world.at(bot, p.x, p.y, p.z))
}

// Block to fill a hole with: stone the castle has no use for first, cobblestone (castle material) last.
const FILLER_ORDER = ['andesite', 'diorite', 'tuff', 'cobbled_deepslate', 'netherrack', 'dirt', 'cobblestone']
function fillerItem (bot) {
  for (const n of FILLER_ORDER) { const it = inv.items(bot).find(i => i.name === n); if (it) return it }
  return null
}

async function ensureFloor (bot, p) {
  const below = world.at(bot, p.x, p.y - 1, p.z)
  if (!below) return false
  if (world.isSolid(below)) return true
  if (world.isLavaBlock(below)) return false
  const filler = fillerItem(bot)
  if (!filler) return false
  return act.place(bot, { x: p.x, y: p.y - 1, z: p.z }, filler.name)
}

async function stepInto (bot, p) {
  // never step onto nothing: a floor that did not get placed turned the next step into a 19-block fall
  const floor = world.at(bot, p.x, p.y - 1, p.z)
  if (!floor || !world.isSolid(floor)) { log('mine', `no floor under ${move.fmt(p)} - not stepping`); return false }
  // one cell along the tunnel (level or a step down): walk it with the keys - a pathfinder plan per block
  // cost a second or two each and capped the mine at ~8 steps a minute
  const me = bot.entity.position
  const adjacent = Math.abs(Math.floor(me.x) - p.x) + Math.abs(Math.floor(me.z) - p.z) === 1 && (Math.floor(me.y) === p.y || Math.floor(me.y) - 1 === p.y)
  if (adjacent && !require('./reflex').active()) {
    const tx = p.x + 0.5; const tz = p.z + 0.5
    const t0 = Date.now()
    try {
      while (Date.now() - t0 < 1500) {
        const q = bot.entity.position
        if (Math.hypot(q.x - tx, q.z - tz) < 0.25 && Math.floor(q.y) === p.y) break
        await bot.look(Math.atan2(-(tx - q.x), -(tz - q.z)), 0, true).catch(() => {})
        bot.setControlState('forward', true)
        await move.sleep(50)
      }
    } finally { bot.setControlState('forward', false) }
    const q = bot.entity.position
    if (Math.floor(q.x) === p.x && Math.floor(q.z) === p.z && Math.floor(q.y) === p.y) return true
  }
  const r = await move.goTo(bot, new goals.GoalBlock(p.x, p.y, p.z), { timeoutMs: 8000, stuckMs: 4000, dig: false, place: false, label: 'mine step' })
  return r.ok
}

// Take ores visible from the tunnel (within reach, exposed to the tunnel air).
let alsoWant = null // a stone kind the build wants (granite): taken from the walls like an ore while mining for it
async function takeWallOres (bot) {
  const me = world.feetPos(bot)
  let took = 0
  for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
    const p = { x: me.x + dx, y: me.y + dy, z: me.z + dz }
    const b = world.at(bot, p.x, p.y, p.z)
    if (!b || !(WANT_ORES.test(b.name) || (alsoWant && alsoWant.test(b.name)))) continue
    if (!world.hasAirNeighbour(bot, p)) continue
    if (!inv.canHarvest(bot, b)) continue
    if (fluidAround(bot, p)) continue
    // only from where we stand: walking out to an ore in a cave wall walked the bot off a ledge from y16
    // to y2 (death, iron armour in the grave)
    if (!act.reach(bot, p, 4.3)) continue
    if (await act.dig(bot, p, { force: true, timeoutMs: 10000, noWalk: true })) took++
  }
  if (took) await act.collectDrops(bot, { radius: 5, maxMs: 6000 })
  return took
}

async function maybeTorch (bot, m) {
  if (m.blocks % 7 !== 0) return
  const torch = inv.items(bot).find(i => i.name === 'torch')
  if (!torch) {
    if (inv.count(bot, 'coal') + inv.count(bot, 'charcoal') >= 2 && inv.count(bot, 'stick') >= 2) await craft().ensure(bot, 'torch', 8, { noWithdraw: true }).catch(() => {})
    return
  }
  const me = world.feetPos(bot)
  // on the floor just behind us
  const back = { x: me.x - m.dir.x, y: me.y, z: me.z - m.dir.z }
  const cell = world.at(bot, back.x, back.y, back.z)
  if (cell && world.isAirish(cell)) await act.place(bot, back, 'torch', { faceHint: [[0, -1, 0]], sneak: false }).catch(() => {})
}

function mineShouldPause (bot, ctx) {
  if (ctx.shouldStop && ctx.shouldStop()) return 'stopped'
  if (bot.food <= 6 && !inv.foodItems(bot).length) return 'no food'
  // low health alone does not stop mining (without food it never regenerates, so that would be a
  // deadlock: no mining -> no tools -> no food); very low health, or hurt with a mob close, does
  if (bot.health <= 4) return 'hurt'
  if (bot.health <= 8 && require('./reflex').hostiles(10).length) return 'hurt and a mob is close'
  if (inv.toolTier(bot, 'pickaxe') < 1) return 'no pickaxe'
  return null
}

async function ensurePick (bot) { return craft().keepTool(bot, 'pickaxe', { noWithdraw: false }) } // (craft.keepTool: the one rule)

// Keep enough in the pack for the mine: a spare pickaxe's worth of sticks and a table.
let provisioning = false
async function provisionForMine (bot) {
  // never re-entered: a pickaxe that needs cobble that needs a mine that needs provisioning recursed
  // 7500 times in a second (2026-09-15)
  if (provisioning) return
  provisioning = true
  try { await provisionInner(bot) } finally { provisioning = false }
}
async function provisionInner (bot) {
  // sticks for every pickaxe the trip can wear out: a stone pick is ~131 blocks, and the pack's free room is the most a
  // trip digs. Four sticks were two picks: at the y20 face both wore out and the third could not be made (no wood
  // underground) - the bot climbed out digging stone by hand (2026-09-25).
  const sticks = Math.min(64, 2 * Math.ceil(inv.freeSlots(bot) * 64 / 131) + 2)
  if (inv.count(bot, 'stick') < sticks) await craft().ensure(bot, 'stick', sticks).catch(() => {})
  if (!inv.has(bot, 'crafting_table')) await craft().ensure(bot, 'crafting_table', 1).catch(() => {})
  // a spare pickaxe: one wearing out mid-tunnel ends the trip (stone picks last ~130 blocks)
  const picks = inv.items(bot).filter(i => /_pickaxe$/.test(i.name) && inv.tierOf(i.name) >= 2)
  // the spare from the chest first, else one made from banked cobble - withdrawals only, never mining for it
  // (a pickaxe worn out at y30 with no spare meant climbing out through stone by hand at 7.5s a block)
  const b = base()
  if (picks.length < 2 && b.bankCount('stone_pickaxe') > 0) await b.withdraw(bot, 'stone_pickaxe', 1).catch(() => 0)
  const picks2 = inv.items(bot).filter(i => /_pickaxe$/.test(i.name) && inv.tierOf(i.name) >= 2 && inv.durabilityLeft(bot, i) > 20)
  if (picks2.length < 2) {
    if (inv.count(bot, 'cobblestone') < 3 && b.bankCount('cobblestone') >= 3) await b.withdraw(bot, 'cobblestone', 3).catch(() => 0)
    if (inv.count(bot, 'cobblestone') >= 3) await craft().ensure(bot, 'stone_pickaxe', inv.count(bot, 'stone_pickaxe') + 1, { noWithdraw: true }).catch(() => {})
  }
  // a lit tunnel doesn't spawn mobs that wander up to the base: bring torches (charcoal from logs
  // when there is no coal)
  if (inv.count(bot, 'torch') < 8 && (inv.count(bot, 'coal') + inv.count(bot, 'charcoal') >= 2 || craft().logCount(bot) >= 4)) await craft().ensure(bot, 'torch', 16).catch(() => {})
}

function minePath (m) {
  const pts = []
  const drop = Math.max(0, m.entrance.y - m.level)
  const d0 = m.stairsDir || m.dir
  for (let k = 0; k <= drop; k += 2) pts.push({ x: m.entrance.x + d0.x * k, y: m.entrance.y - k, z: m.entrance.z + d0.z * k })
  if (m.cursor) pts.push(m.cursor)
  return pts
}
// Are we in our own mine - on its staircase or at its face?
function inOwnMine (bot) {
  const m = mem.get().mine
  if (!m || !m.entrance || !bot.entity) return false
  const me = bot.entity.position
  return minePath(m).some(p => world.dist2(p, me) < 8 && Math.abs(p.y - me.y) < 6)
}
function diedInMine (m) {
  // horizontal distance, a wide berth and a long memory: deaths 20 blocks straight below the tunnel (a ravine
  // under it) did not count in 3D and the bot fell into the same ravine again and again
  const recent = (mem.get().deaths || []).filter(d => Date.now() - d.t < 3 * 60 * 60000 && d.cause !== 'void')
  return recent.some(d => minePath(m).some(p => world.dist2(p, d) < 16))
}
function abandonMine (m) {
  mem.update(mm => { mm.badMines = (mm.badMines || []).concat([{ x: m.entrance.x, y: m.entrance.y, z: m.entrance.z }]).slice(-12); mm.mine = null })
}

// KNOWN ORE. Iron here is plentiful - 488 blocks within 64 of home, 4000+ within 128 - but a tenth of a percent of
// the rock: a blind 3x3 tunnel met a vein every few hundred blocks, and ore "in sight" (showing to daylit air) was 1
// block in 4000. The client sees every block through the stone: the bot tunnels straight to the nearest ore in solid
// rock, digs it and the rest of its vein as each block bares the next (operator 2026-09-26: efficiency over a
// player's blindness). Never an ore under the home grounds, never a tunnel begun from them (the mine's stairs first), never
// into a zone, never beside water or lava; the tunnel goes through solid rock, and a dark cave is only crossed where it
// happens to open one.
const underBuild = p => move.underBuild(p) // (move.js: the one rule for the ground under the build)
async function takeKnownOre (bot, itemName, target, ctx = {}) {
  const g = craft().GATHER[itemName]
  const home = mem.get().home || world.feetPos(bot)
  const gather = require('./gather')
  const refused = new Set()
  const k = p => `${p.x},${p.y},${p.z}`
  const t0 = Date.now()
  const start = inv.count(bot, itemName)
  let veins = 0
  // never a tunnel mouth in the yard or under the build: near home the trip STARTS only from inside our own mine (the
  // stairs take us down first; audit #27). Judged once, at the start - checked every turn, the first ore's tunnel led away
  // from the mine's recorded path and the trip ended after one vein, 13 iron in 40 minutes (2026-09-27)
  if (((mem.get().home && world.dist2(bot.entity.position, mem.get().home) < 48) || underBuild(world.feetPos(bot))) && !inOwnMine(bot)) { log('mine', 'known ore: not tunnelling from round home or the build - the mine first'); return false }
  while (inv.count(bot, itemName) < target) {
    if ((ctx.shouldStop && ctx.shouldStop()) || Date.now() - t0 > 20 * 60000) break
    await reflex.waitClear()
    // mid-trip, out under the sky round home or the build (a vein that broke into the yard): stop - the trip goes on
    // underground only
    if (world.openSky(bot, world.feetPos(bot)) && (gather.onGrounds(bot.entity.position) || underBuild(world.feetPos(bot)))) { log('mine', 'known ore: out under the sky round home - ending the ore trip'); break }
    if (!inv.bestTool(bot, 'pickaxe', 4) && !await ensurePick(bot)) break
    if (inv.freeSlots(bot) <= 2) await base().tossJunk(bot)
    // (ctx.near {point, radius}, ctx.oreFilter: a trip started at one outcrop works that outcrop - its vein and the rock-face
    //  coal round it - never the next-nearest ore anywhere in 64, a 40-block dig down from a hillside; audit 2026-09-28)
    const ores = await world.scanBlocks(bot, g.blocks, { maxDistance: ctx.near ? ctx.near.radius : 64, count: 60, point: ctx.near ? ctx.near.point : home, filter: b => !refused.has(k(b.position)) && inv.canHarvest(bot, b) && !fluidAround(bot, b.position) && !move.inZone(b.position, 2) && !gather.onGrounds(b.position) && !underBuild(b.position) && (!ctx.oreFilter || ctx.oreFilter(b)) })
    if (!ores.length) break
    const me = bot.entity.position
    const o = ores.sort((x, y) => world.dist3(x.position, me) - world.dist3(y.position, me))[0]
    // through the rock to it (the planner digs its own tunnel), then the block and its vein
    if (!act.reach(bot, o.position, 4.3)) {
      const r = await move.goTo(bot, new goals.GoalLookAtBlock(o.position, bot.world, { reach: 4 }), { timeoutMs: 120000, stuckMs: 15000, label: 'to the ore', shouldStop: ctx.shouldStop })
      if (!r.ok && !act.reach(bot, o.position, 4.5)) { refused.add(k(o.position)); continue }
    }
    if (!await act.dig(bot, o.position, { timeoutMs: 20000, noWalk: true })) { refused.add(k(o.position)); continue }
    veins++
    for (let i = 0; i < 6 && await takeWallOres(bot); i++) {}
    await act.collectDrops(bot, { radius: 5, maxMs: 6000 })
  }
  const got = inv.count(bot, itemName) - start
  if (got || veins) log('mine', `tunnelled to ${veins} ${itemName} ore vein(s): +${got} (${inv.count(bot, itemName)}/${target})`)
  return inv.count(bot, itemName) >= target
}

async function mineFor (bot, itemName, target, ctx = {}) {
  alsoWant = /^(granite|diorite|andesite|tuff)$/.test(itemName) ? new RegExp('^' + itemName + '$') : null
  let m = mem.get().mine
  const home = mem.get().home
  // a mine belongs near home; one dug before home existed (or far from it) is left behind
  if (m && home && world.dist2(m.entrance, home) > 96) { log('mine', `the old mine at ${move.fmt(m.entrance)} is far from home - starting one here`); m = null }
  if (m && !home && world.dist2(m.cursor, bot.entity.position) > 96) m = null
  // a mine we died in lately has something living in it (a cave broke into it): leave it for good
  if (m && diedInMine(m)) { log('mine', `died in the mine at ${move.fmt(m.entrance)} lately - abandoning it for a new one`); abandonMine(m); m = null }
  // a "mine" working just under the surface is a trench under whatever stands there
  if (m && m.stairsDone && home && m.level > home.y - 20 && !m.ore) { log('mine', `the mine at ${move.fmt(m.entrance)} works at y${m.level}, too near the surface - abandoning it`); abandonMine(m); m = null }
  // an ore trip works where that ore is: a mine at another level is left (not a bad mine - cobble comes from it as well)
  // (coal is everywhere under the ground: the mine at hand is worked for it - its walls give it, with the cobble - never
  //  left for a new one at coal's richest band: the first coal trip threw the y39 cobble mine away for a hillside at y100
  //  and every cobble trip after would dig new stairs back down, 2026-09-28)
  const ore = itemName === 'coal' && m ? null : await oreLevel(bot, itemName).catch(() => null)
  // (a mine already made for this band keeps it: the best entrance may not reach it - y86 ground over y91 iron made a
  //  y78 mine, and every trip after called it the wrong level and made the same mine again)
  if (ore && m && Math.abs(m.level - ore.y) > 6 && !(m.oreY != null && Math.abs(m.oreY - ore.y) <= 6)) { log('mine', `${itemName} lies at y${ore.y} (${ore.n} in sight of the rock) - the mine at y${m.level} is the wrong level; a new one`); mem.set('mine', null); m = null }
  if (!m && !ore && !world.openSky(bot, world.feetPos(bot)) && bot.entity.position.y < ((home && home.y) || 64) - 8) {
    // already underground: tunnel from right here
    const me = world.feetPos(bot)
    let dir = DIRS[0]
    for (const d of DIRS) { const b = world.at(bot, me.x + d.x, me.y, me.z + d.z); if (b && world.isSolid(b) && !fluidAround(bot, { x: me.x + d.x, y: me.y, z: me.z + d.z })) { dir = d; break } }
    m = { entrance: me, dir, cursor: me, level: me.y, stairsDone: true, leg: 0, legPos: 0, blocks: 0 }
    saveMine(m)
    log('mine', `tunnelling from where i stand (${move.fmt(me)}) heading ${dir.x},${dir.z}`)
  }
  if (!m) {
    m = chooseEntrance(bot, ore && ore.y)
    if (!m) { log('mine', 'no safe spot for a mine entrance near home'); return false }
    if (ore) { m.ore = itemName; m.oreY = ore.y }
    m.stairsDir = { x: m.dir.x, z: m.dir.z }
    saveMine(m)
    log('mine', `new mine at ${move.fmt(m.entrance)} heading ${m.dir.x},${m.dir.z} to y${m.level}`)
  }
  await provisionForMine(bot)
  // an ore showing in a cave wall or a cliff first - and the vein behind it, each block dug bares the next
  if (craft().GATHER[itemName] && craft().GATHER[itemName].ore && await takeKnownOre(bot, itemName, target, ctx)) return true
  // get to the working face
  if (world.dist3(bot.entity.position, m.cursor) > 3) {
    // the way down is the mine's own - entrance, stairs, tunnel - unless we are already in it. Judged by distance on
    // the map alone, standing 40 blocks over the face counted as "near" and the planner took a way down through a cave
    // lake at night; Drowned killed the bot in it (2026-09-24).
    if (!inOwnMine(bot) && world.dist3(bot.entity.position, m.entrance) > 3) await move.travel(bot, m.entrance, { range: 3, shouldStop: ctx.shouldStop, label: 'to mine' })
    const r = await move.goTo(bot, new goals.GoalBlock(m.cursor.x, m.cursor.y, m.cursor.z), { timeoutMs: 120000, stuckMs: 15000, label: 'to mine face' })
    // (busy or stopped on the way is no verdict on the mine - a fight in the stairwell abandoned a whole mine for a new one)
    if (!r.ok && !move.isVerdict(r)) return false
    // (a real verdict once - a flooded step, a gravel fall - is no reason to throw away stairs, cursor and ore history:
    //  three trips that could not reach the face, then a new mine; reaching it clears the count - audit 2026-09-28)
    if (!r.ok) {
      m.faceFails = (m.faceFails || 0) + 1; saveMine(m)
      if (m.faceFails < 3) { log('mine', `can't reach the mine face at ${move.fmt(m.cursor)} (${r.why}) - ${m.faceFails} of 3 before a new mine`); return false }
    } else if (m.faceFails) { m.faceFails = 0; saveMine(m) }
    if (!r.ok) {
      log('mine', `can't reach the mine face at ${move.fmt(m.cursor)} (${r.why}) - three trips now; starting a new mine`)
      abandonMine(m)
      mem.set('mine', null)
      return false
    }
  }
  // down in the mine now: the known ore from here (from round home it waited for the stairs - #27)
  if (craft().GATHER[itemName] && craft().GATHER[itemName].ore && inOwnMine(bot) && await takeKnownOre(bot, itemName, target, ctx)) return true
  log('mine', `mining for ${itemName} (${inv.count(bot, itemName)}/${target}) at ${move.fmt(m.cursor)}`)
  if (ctx.seal) await sealBehind(bot, m)
  let lastSave = Date.now()
  let fails = 0
  // THE TURN: blocked ahead, left of the heading, then right - never back, the corridor we came down is spent by
  // definition - and both sides blocked is boxed in. Only a step that BROKE rock forgives: a step back through the
  // corridor already dug "succeeds" too, and with both turns at a leg's end blocked the loop ran the same 13 cells back
  // and forth, forgiving itself each run, 8 minutes and more with no stone (2026-09-28)
  let turnFrom = null; let turnSide = 0
  let spinAt = Date.now(); let spins = 0
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    // 30 passes in under a second is a loop with nothing happening in it (two such spins today): stop
    if (++spins >= 30) { if (Date.now() - spinAt < 1000) { log('mine', 'the mine loop is spinning without progress - stopping this trip'); saveMine(m); return false } spins = 0; spinAt = Date.now() }
    const why = mineShouldPause(bot, ctx)
    if (why === 'no pickaxe') { if (!await ensurePick(bot)) return false; continue }
    if (why) { log('mine', `pausing: ${why}`); saveMine(m); return inv.count(bot, itemName) >= target }
    await reflex.waitClear()
    if (!inv.bestTool(bot, 'pickaxe', 4)) { if (!await ensurePick(bot)) { saveMine(m); return false } }
    if (inv.freeSlots(bot) <= 2) {
      await base().tossJunk(bot)
      if (inv.freeSlots(bot) <= 2 && ctx.seal) {
        // never walk the haul up to the surface in the dark: wait in the sealed tunnel for morning
        saveMine(m)
        log('mine', 'pack full at night - waiting in the tunnel until morning')
        await sealBehind(bot, m)
        while (!(ctx.shouldStop && ctx.shouldStop())) await move.sleep(3000)
        return inv.count(bot, itemName) >= target
      }
      if (inv.freeSlots(bot) <= 2) {
        saveMine(m)
        log('mine', 'pack full - taking the haul home')
        await base().depositHaul(bot, { shouldStop: ctx.shouldStop })
        await provisionForMine(bot)
        const r = await move.goTo(bot, new goals.GoalBlock(m.cursor.x, m.cursor.y, m.cursor.z), { timeoutMs: 180000, stuckMs: 20000, label: 'back to mine face' })
        if (!r.ok) { log('mine', `couldn't get back to the face (${r.why})`); return false }
      }
    }
    // every step starts from the cursor: if we are not standing there (knocked back, climbed onto a
    // block), get back first - digging ahead of a cursor we are not at livelocked ("blocked - turning"
    // every 25s, zero cobble, for as long as it was left)
    const here = world.feetPos(bot)
    if (Math.abs(here.x - m.cursor.x) + Math.abs(here.z - m.cursor.z) > 1 || Math.abs(here.y - m.cursor.y) > 1) {
      const back = await move.goTo(bot, new goals.GoalBlock(m.cursor.x, m.cursor.y, m.cursor.z), { timeoutMs: 30000, stuckMs: 8000, label: 'back to mine face' })
      if (!back.ok) { log('mine', `lost the mine face at ${move.fmt(m.cursor)} (${back.why}) - abandoning this mine`); abandonMine(m); return false }
    }
    const b0 = broken
    const ok = m.stairsDone ? await tunnelStep(bot, m) : await stairStep(bot, m)
    if (!ok) {
      if (++fails >= 3) {
        if (turnSide >= 2) { log('mine', `boxed in at ${move.fmt(m.cursor)} - ahead, left and right all blocked - abandoning this mine`); abandonMine(m); return false }
        // stairs blocked (water, lava, a cave) well above the working depth: still under the rock, this is a depth like
        // any for cobble - tunnel here and keep the stairs already dug. On a cave-riddled mountain five new staircases
        // in an hour ended "blocked, far above the working depth" (2026-09-24). Only a staircase still near the surface
        // (under the castle, the hut) is no mine.
        if (!m.stairsDone && m.cursor.y > m.level + 12) {
          if (m.entrance.y - m.cursor.y < 8) { log('mine', `the stairs are blocked at y${m.cursor.y}, just under the surface - abandoning this mine`); abandonMine(m); return false }
          log('mine', `the stairs are blocked at y${m.cursor.y} - tunnelling at this depth`)
        }
        // hazard ahead: turn this leg
        log('mine', `blocked at ${move.fmt(m.cursor)} - turning`)
        if (!turnFrom) { turnFrom = { x: m.dir.x, z: m.dir.z }; turnSide = 1; m.dir = { x: -turnFrom.z, z: turnFrom.x } } else { turnSide = 2; m.dir = { x: turnFrom.z, z: -turnFrom.x } }
        m.legPos = 0
        fails = 0
        if (!m.stairsDone) { m.stairsDone = true; m.level = m.cursor.y }
      }
    } else { fails = 0; if (broken > b0) { turnFrom = null; turnSide = 0 } }
    if (Date.now() - lastSave > 15000) { saveMine(m); lastSave = Date.now() }
  }
  saveMine(m)
  return true
}

// Night mining: plug the passage behind us so nothing follows us down. The pathfinder digs back
// through the plug (dirt/cobble are natural) in the morning.
async function sealBehind (bot, m) {
  const me = world.feetPos(bot)
  const back = { x: me.x - m.dir.x, z: me.z - m.dir.z }
  const up = m.stairsDone ? 0 : 1 // on the stairs the cell behind is one step up
  const filler = () => fillerItem(bot)
  let placed = 0
  for (const dy of [0, 1, 2]) {
    const p = { x: back.x, y: me.y + up + dy - (up ? 0 : 0), z: back.z }
    if (!m.stairsDone && dy === 2) continue
    if (m.stairsDone && dy === 2) continue
    const c = world.at(bot, p.x, p.y, p.z)
    const f = filler()
    if (c && world.isAirish(c) && f && await act.place(bot, p, f.name)) placed++
  }
  if (placed) log('mine', `sealed the passage behind me (${placed} blocks)`)
}

// A tunnel that breaks into a cave is a door for every mob in that cave (a zombie and a skeleton came in
// through one and killed the bot on its own stairs). Wall up any opening beside the new cells: the
// side walls (across the direction of travel) and the ceiling over the top cell.
async function plugOpenings (bot, cells, along) {
  const filler = () => fillerItem(bot)
  const side = { x: -along.z, z: along.x }
  // the outside of the face only: a side neighbour that is not itself one of the new cells, and the cell over each
  // column's top (with a three-wide face the cells beside the middle column are tunnel, not cave)
  const isCell = p => cells.some(o => o.x === p.x && o.y === p.y && o.z === p.z)
  const holes = []
  for (const c of cells) {
    for (const k of [1, -1]) { const h = { x: c.x + side.x * k, y: c.y, z: c.z + side.z * k }; if (!isCell(h)) holes.push(h) }
    const up = { x: c.x, y: c.y + 1, z: c.z }
    if (!isCell(up)) holes.push(up)
  }
  let n = 0
  for (const h of holes) {
    const b = world.at(bot, h.x, h.y, h.z)
    if (!b || !(world.isAirish(b) || world.isWaterBlock(b))) continue
    if (/torch/.test(b.name)) continue
    const f = filler()
    if (!f) break
    if (await act.place(bot, h, f.name, { sneak: false }).catch(() => false)) n++
  }
  if (n) log('mine', `walled up ${n} cave opening${n > 1 ? 's' : ''} beside the tunnel`)
  return n
}

// Water let in by the cells just dug: plug it at once, the way a player slaps a block on a leak. Returns false
// when it can't be plugged (retreat - a flooding staircase drowned the bot twice).
async function plugWater (bot, cells) {
  const seen = new Set()
  for (const c of cells) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
      const k = `${p.x},${p.y},${p.z}`
      if (seen.has(k) || cells.some(o => o.x === p.x && o.y === p.y && o.z === p.z)) continue
      seen.add(k)
      const b = world.at(bot, p.x, p.y, p.z)
      if (!b || !world.isWaterBlock(b)) continue
      const f = fillerItem(bot)
      if (!f || !await act.place(bot, p, f.name, { sneak: false }).catch(() => false)) { log('mine', `water breaking in at ${move.fmt(p)} and nothing to stop it - backing out`); return false }
      log('mine', `plugged water at ${move.fmt(p)}`)
    }
  }
  // water already in the cells themselves (it flowed in before the plug): fill them and give this way up
  for (const c of cells) { const b = world.at(bot, c.x, c.y, c.z); if (b && world.isWaterBlock(b)) { log('mine', 'the tunnel is flooding - backing out'); return false } }
  return true
}

// Under the footprint of a protected zone (the castle, the base)? Mines never dig there, at any depth.
// (and the ground under the build, the one rule of move.underBuild - its footprint +8: the mine's own stairs and face kept
//  only +2 off it, a cursor could tunnel inside the margin under the castle; the audit, 2026-09-27. A column with no y is
//  judged below the build's floor, where the mine always is)
function underOwnZone (p) {
  return move.zones.some(z => p.x >= z.x1 - 2 && p.x <= z.x2 + 2 && p.z >= z.z1 - 2 && p.z <= z.z2 + 2) || move.underBuild({ x: p.x, y: p.y != null ? p.y : -64, z: p.z })
}

async function stairStep (bot, m) {
  const c = m.cursor
  if (c.y <= m.level) { m.stairsDone = true; m.legPos = 0; log('mine', `stairs reached y${c.y} - tunnelling`); return true }
  const q = { x: c.x + m.dir.x, y: c.y - 1, z: c.z + m.dir.z }
  if (underOwnZone(q)) { log('mine', `the stairs would run under a protected build at ${move.fmt(q)}`); return false }
  const cells = [{ x: q.x, y: q.y + 2, z: q.z }, { x: q.x, y: q.y + 1, z: q.z }, q]
  for (const cell of cells) {
    const f = fluidAround(bot, cell, p => cells.some(o => o.x === p.x && o.y === p.y && o.z === p.z) || (p.x === c.x && p.z === c.z))
    if (f) { log('mine', `${f} next to the stairs at ${move.fmt(cell)}`); return false }
  }
  const below = world.at(bot, q.x, q.y - 1, q.z)
  if (!below || world.isLavaBlock(below) || world.isWaterBlock(below)) return false
  for (const cell of cells) if (!await openCell(bot, cell)) return false
  if (!await plugWater(bot, cells)) return false
  await plugOpenings(bot, cells, m.dir)
  if (!await ensureFloor(bot, q)) return false
  if (!await stepInto(bot, q)) return false
  m.cursor = q; m.blocks++
  await takeWallOres(bot)
  await maybeTorch(bot, m)
  return true
}

async function tunnelStep (bot, m) {
  const c = m.cursor
  if (m.legPos >= LEG_LEN) {
    // shift sideways and come back the other way (serpentine keeps the mine compact). The sideways
    // direction is fixed for the whole mine: derived from the flipping heading it alternated, and every leg
    // after the second ran back through an already-dug corridor - no new stone at all
    if (!m.shiftDir) m.shiftDir = { x: -m.dir.z, z: m.dir.x }
    const side = m.shiftDir
    for (let i = 0; i < SHIFT; i++) {
      const q = { x: m.cursor.x + side.x, y: m.cursor.y, z: m.cursor.z + side.z }
      if (!await openTunnelCell(bot, m.cursor, q)) return false
    }
    m.dir = { x: -m.dir.x, z: -m.dir.z }
    m.legPos = 0
    m.leg++
    return true
  }
  const q = { x: c.x + m.dir.x, y: c.y, z: c.z + m.dir.z }
  if (!await openTunnelCell(bot, c, q)) return false
  m.legPos++
  return true
}

async function openTunnelCell (bot, from, q) {
  if (underOwnZone(q)) return false // never under the castle or the base
  // rock over the tunnel: the surface at least two above its three-high roof. A level tunnel on a hillside ran out
  // into the open slope and walled up the "cave openings" - the sky - with cobble and torches: a cut across the hill
  // that looked like a building (2026-09-24). Open ground ahead is a blocked step: the leg turns back into the hill.
  const gy = world.groundY(bot, q.x, q.z, q.y + 48)
  if (gy == null || gy < q.y + 4) return false
  // three high AND three wide: 9 cobble a step for the same walk and checks as 3. The step's fixed work (stepping in,
  // checking for water, walling up cave openings, the floor, the wall ores, a torch) was ~5s against ~1.8s of digging,
  // 0.45 cobble a second for a 33,000-cobble build (2026-09-24). The middle column is the tunnel; the side columns are
  // taken when they can be (fluid beside one or a block that won't come out skips that column, never the step).
  const along = { x: q.x - from.x, z: q.z - from.z }
  const side = { x: -along.z, z: along.x }
  const column = k => [2, 1, 0].map(dy => ({ x: q.x + side.x * k, y: q.y + dy, z: q.z + side.z * k }))
  const mid = column(0)
  const sides = [column(1), column(-1)].filter(col => !underOwnZone(col[0]))
  // (open already: the column we stand in and the face we dug last step)
  const behind = p => [-1, 0, 1].some(k => p.x === from.x + side.x * k && p.z === from.z + side.z * k)
  const inFace = p => mid.concat(...sides).some(o => o.x === p.x && o.y === p.y && o.z === p.z)
  for (const cell of mid) {
    const f = fluidAround(bot, cell, p => behind(p) || inFace(p))
    if (f) { log('mine', `${f} beside the tunnel at ${move.fmt(cell)}`); return false }
  }
  for (const cell of mid) if (!await openCell(bot, cell)) return false
  const opened = mid.slice()
  for (const col of sides) {
    if (col.some(cell => fluidAround(bot, cell, p => behind(p) || inFace(p)))) continue
    let ok = true
    for (const cell of col) if (!await openCell(bot, cell)) { ok = false; break }
    if (ok) opened.push(...col)
  }
  const cells = opened
  if (!await plugWater(bot, cells)) return false
  await plugOpenings(bot, cells, { x: q.x - from.x, z: q.z - from.z })
  if (!await ensureFloor(bot, q)) return false
  if (!await stepInto(bot, q)) return false
  const m = mem.get().mine
  if (m) { m.cursor = { x: q.x, y: q.y, z: q.z }; m.blocks = (m.blocks || 0) + cells.length }
  await takeWallOres(bot)
  if (m) await maybeTorch(bot, m)
  return true
}

module.exports = { mineFor, chooseEntrance, takeWallOres, takeKnownOre, inOwnMine, oreLevel }
