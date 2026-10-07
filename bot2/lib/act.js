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

// A container opened a few ms after we closed one never opens: the server sends no window and the open times out 20s
// later (every chest-open failure of 2026-09-27/28: "5ms since the last window", reach, lid, sneak and cats ruled out).
// There is no ack for a close to wait on, so the condition is the next thing observable - two server ticks since the
// close event. It costs nothing unless a close was that recent. THE one way to open a chest or a furnace.
let lastClose = 0; const watching = new WeakSet()
async function settleAfterClose (bot) {
  if (!watching.has(bot)) { watching.add(bot); bot.on('windowClose', () => { lastClose = Date.now() }) }
  if (Date.now() - lastClose < 100) await bot.waitForTicks(2)
}
async function openSettled (bot, block, how = 'openContainer') {
  await settleAfterClose(bot)
  return bot[how](block)
}

function reach (bot, pos, r = 4.3) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  return eye.distanceTo(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)) <= r
}

// Finished cells of our builds (the hut, the schematic) are never broken by any dig: the check lives HERE,
// in the one dig primitive, not in each caller (the night's dig-in reflex went straight through a finished
// castle wall, 2026-09). `own` is the builder replacing a wrong block in its own cell - the only opt-out.
const refusedAt = new Map() // pos key -> last log time (a caller retrying a protected block logs once a minute)
function guarded (bot, b, own) {
  const foreign = move.inForeign(b.position) // (someone else's place: no `own` reaches into it - foreign.js)
  if (!foreign && (own || !move.isProtected(b, 'dig'))) return false
  const k = `${b.position.x},${b.position.y},${b.position.z}`
  if (Date.now() - (refusedAt.get(k) || 0) > 60000) { refusedAt.set(k, Date.now()); log('act', `won't dig ${b.name} at ${k} - ${foreign ? "someone else's place" : 'a finished block of a build'}`) }
  return true
}

// The raw dig for callers that must not wait or walk (the reflexes: act.dig waits for the reflex to clear,
// which inside a reflex is forever). Same protection. True when the block there changed.
async function digBlock (bot, b, { own = false } = {}) {
  if (!b || guarded(bot, b, own)) return false
  let acks = null
  try { await inv.equipFor(bot, b); acks = digAcks(bot); await bot.dig(b, true) } catch { if (acks) acks.stop(); return false }
  await acks.settle(acksFor(bot, b))
  const after = world.at(bot, b.position.x, b.position.y, b.position.z)
  return !after || after.name !== b.name
}
// THE SERVER'S WORD ON A DIG. mineflayer's dig resolves on its OWN write of air into the client's world (digging.js
// finishDigging -> _updateBlockState), before the server has said anything: a dig the server refuses comes back as the block
// itself, sent before the server acknowledges the action (block_changed_ack, at the end of the tick that handled it). Read
// at once, the world showed the client's guess: the ladder cap at -2289,130,-577 "taken out" from the ladder at 18:29, and
// the teardown's two digs of it and the cobblestone over it at 18:33-18:34 "done" - all three back in the world at 18:40,
// nothing ever placed there (2026-10-07). So a dig's re-read waits for the server's acknowledgements of its start and its
// finish (one, when both go out in the same tick) - or a deadline, then reads what is there.
function digAcks (bot) {
  const c = bot._client; let n = 0; let wake = null
  const on = () => { n++; if (wake) wake() }
  c.on('acknowledge_player_digging', on)
  const stop = () => { c.removeListener('acknowledge_player_digging', on); wake = null }
  return {
    stop,
    async settle (need, ms = 1500) {
      if (n < need) {
        await new Promise(resolve => {
          const t = setTimeout(() => resolve(), ms)
          wake = () => { if (n >= need) { clearTimeout(t); resolve() } }
        })
      }
      const ok = n >= need; stop(); return ok
    }
  }
}
// (a start and a finish a tick or more apart: two acknowledgements; an instant break sends both at once - one)
function acksFor (bot, b) { let ms = 0; try { ms = bot.digTime(b) } catch {} return ms >= 100 ? 2 : 1 }

// Dig one block (walking into reach if needed). Refuses crafted blocks unless `force`, and finished build
// cells unless `own`. Returns true when the cell is verifiably no longer that block.
// Why dig would refuse a block (null: it would not) - the ONE list, asked by dig itself and by anything that queues digs
// ahead (the groundwork: a job it can never do loops for ever - audit #9, 2026-09-27)
function digRefusal (bot, b, { force = false, own = false, allowZones = [] } = {}) {
  if (move.inForeign(b.position)) return "someone else's place"
  if (!own && move.isProtected(b, 'dig')) return 'a finished cell of the build' // (pure: a scan asking must not log per cell)
  if (!force && !world.NATURAL_RE.test(b.name)) return `crafted ${b.name}`
  const z = move.inZone(b.position)
  if (z && !allowZones.includes(z.label) && !force) return `inside ${z.label}`
  if (b.hardness == null || b.hardness < 0) return 'unbreakable'
  // never open a block that holds back lava onto us - below too, and one further down: a dug block over lava is a hole we
  // drop into (the bot dug dirt for scaffold over a lava pocket at the castle and burned to death with its new iron gear)
  if (world.holdsBackLava(bot, b.position)) return 'lava beside or under it'
  return null
}
// (why the last dig() returned false - said by the callers that retry: a stray build block failed eight rounds unsaid; audit)
let lastDigWhy = null
async function dig (bot, pos, { force = false, own = false, allowZones = [], timeoutMs = 30000, noWalk = false, reachMax = 4.3 } = {}) {
  lastDigWhy = null
  let digErr = null // (what bot.dig last threw: said with the timeout - swallowed, a dig that never broke went unexplained)
  let b = world.at(bot, pos.x, pos.y, pos.z)
  // "done" means the cell holds nothing breakable. Grass/flowers have no collision box but they ARE
  // blocks: treating them as air made a seed-gathering loop spin on resolved promises and starve the
  // event loop for minutes (keep-alive timeout, 2026-09-14).
  // (liquid only: a waterlogged block - a sea pickle, a wet stair - IS a block; read as water, a wild pickle was "dug"
  //  without a swing, the route died and every reef sighting reopened it, 2026-09-27)
  const nothing = x => !x || /^(air|cave_air|void_air)$/.test(x.name) || world.isLiquidWater(x) || world.isLavaBlock(x)
  if (nothing(b)) return true
  if (guarded(bot, b, own)) { lastDigWhy = move.inForeign(b.position) ? "someone else's place" : 'a finished cell of the build'; return false } // (logs, rate-limited per cell)
  { const why = digRefusal(bot, b, { force, own, allowZones }); if (why) { lastDigWhy = why; if (why !== 'unbreakable') log('act', `won't dig ${b.name} at ${move.fmt(pos)} - ${why}`); return false } }
  const t0 = Date.now()
  const cancelled = control.token()
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (cancelled()) { lastDigWhy = 'stopped'; return false }
    await reflex.waitClear()
    b = world.at(bot, pos.x, pos.y, pos.z)
    if (nothing(b)) return true
    if (guarded(bot, b, own)) { lastDigWhy = 'a finished cell of the build'; return false } // (the cell may have been finished while we waited)
    const tm = Date.now()
    if (!reach(bot, pos, reachMax) && noWalk) { lastDigWhy = 'out of reach (no walk)'; return false }
    if (!reach(bot, pos, reachMax)) {
      // a block without a full hitbox (grass, flowers, crops) never satisfies the look-at raycast
      // goal - the walk ran its whole 20s timeout for every tuft of grass
      const goal = b.boundingBox === 'block' ? new goals.GoalLookAtBlock(b.position, bot.world, { reach: 4 }) : new goals.GoalNear(pos.x, pos.y, pos.z, 2)
      const r = await move.goTo(bot, goal, { timeoutMs: 20000, allowZones, label: 'reach ' + b.name })
      if (!r.ok && !reach(bot, pos, 5)) { lastDigWhy = `no way within reach (${r.why || 'walk failed'})`; return false }
    }
    // never the block we stand on over a drop that hurts: the builder dug the "wrong" block out of a plaza cell with the
    // bot standing on it, over the slope, and it fell 21 blocks (2026-09-24). Step off first; nowhere to step, no dig.
    if (holdsUsUp(bot, pos) && fallBelow(bot, pos) > world.SAFE_DROP) {
      const off = stepOff(bot, pos)
      if (!off) { lastDigWhy = 'I stand on it over a drop'; log('act', `won't dig ${b.name} at ${move.fmt(pos)} - I stand on it over a ${fallBelow(bot, pos)}-block drop`); return false }
      await move.goTo(bot, new goals.GoalBlock(off.x, off.y, off.z), { timeoutMs: 8000, dig: false, place: false, label: 'off the block' })
      if (holdsUsUp(bot, pos)) { lastDigWhy = 'I stand on it'; return false }
      continue
    }
    // ON THE GROUND FIRST: a dig begun in the air is timed at five times as long (vanilla's off-ground penalty - the client
    // times it once, at the start), and the walk into reach often ends in a jump: logs a stone axe takes in 0.75s took
    // 3.75s, every one after a walk, 2026-10-06. The landing is a few ticks; on a ladder, a vine or in water none comes
    // (a deadline on this dig, never a wait before thinking)
    { const tl = Date.now(); while (!grounded(bot) && !noLanding(bot) && Date.now() - tl < 800) await sleep(50) }
    // ON A LADDER OR A VINE, HELD: a body on one with no key down slides down it (0.15 b/t) through the whole dig - off the
    //  ground the dig is timed at five times as long, and a player crouches to stay put. Pressed for the dig only (the walk
    //  is done), let go after; the edge guard leaves a crouch it did not press alone (reflex.setGuardSneak)
    const hold = climbing(bot) && !(bot.controlState && bot.controlState.sneak)
    if (hold) bot.setControlState('sneak', true)
    const td = Date.now()
    let acks = null
    try {
      await inv.equipFor(bot, b)
      if (hold && !reach(bot, pos, reachMax)) { lastDigWhy = 'slid out of reach on the ladder'; continue } // (the walk again)
      acks = digAcks(bot)
      await bot.dig(b, true)
      await acks.settle(acksFor(bot, b))
    } catch (e) {
      if (acks) acks.stop()
      digErr = e && e.message
      if (reflex.active()) continue
      await sleep(200)
    } finally { if (hold) bot.setControlState('sneak', false) }
    const after = world.at(bot, pos.x, pos.y, pos.z)
    if (Date.now() - tm > 6000) log('act', `slow dig ${b.name} at ${move.fmt(pos)}: walk ${td - tm}ms, dig ${Date.now() - td}ms (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'})`)
    if (!after || after.name !== b.name) return true
    // (the server put it back: said, with where the body was - the evidence of why; the loop tries again while time is left)
    if (!digErr) { const me = bot.entity.position; const feet = world.at(bot, Math.floor(me.x), Math.floor(me.y), Math.floor(me.z)); digErr = `the server put it back - dug from ${move.fmt(me)}, ${world.dist3(me.offset(0, 1.62, 0), { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 }).toFixed(1)}b off, ${grounded(bot) ? 'standing' : 'off the ground'}${feet ? ' in ' + feet.name : ''}`; log('act', `dig ${b.name} at ${move.fmt(pos)}: ${digErr}`) }
  }
  lastDigWhy = `it would not break in time${digErr ? ' (' + digErr + ')' : ''}`
  return false
}
// STANDING ON SOMETHING, as the dig timing reads it: physics' onGround, or a full block right under the feet (onGround
// flickers on stairs and slab edges). THE one rule - bot.digTime (main.js) times a dig by it, act.dig waits for it.
// (never a LADDER under the feet: its box is a plate on the wall, nothing a body stands on - a body hanging on a ladder
//  column at a whole-block height read "standing" on the ladder below it and its digs were timed on the ground, five times
//  too fast for the server, which put the blocks back; 2026-10-07)
function grounded (bot) {
  if (bot.entity.onGround) return true
  const p = bot.entity.position
  const under = bot.blockAt(p.offset(0, -0.05, 0))
  return !!(under && under.boundingBox === 'block' && !CLIMB_RE.test(under.name) && p.y - Math.floor(p.y) < 0.05)
}
const CLIMB_RE = /^(ladder|vine|twisting_vines(_plant)?|weeping_vines(_plant)?|cave_vines(_plant)?)$/
// on a ladder or a vine and off the ground: hanging on it
function climbing (bot) {
  if (bot.vehicle || grounded(bot)) return false
  const p = bot.entity.position; const f = world.at(bot, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  return !!f && CLIMB_RE.test(f.name)
}
// where no landing comes: in water, on a ladder or a vine, in scaffolding, in a boat
function noLanding (bot) {
  if (bot.vehicle) return true
  const p = bot.entity.position; const f = world.at(bot, p.x, p.y, p.z)
  return world.isWaterBlock(f) || !!(f && /^(ladder|vine|scaffolding|twisting_vines(_plant)?|weeping_vines(_plant)?|cave_vines(_plant)?)$/.test(f.name))
}

// Would a block at `pos` leave the cell we stand in with no way out - every side shut at the feet or the head? (only a
// block beside us, at feet or head height, can do that; a way up needs blocks to climb on, so it doesn't count)
function sealsUsIn (bot, pos) {
  const f = bot.entity.position.floored()
  const beside = Math.abs(pos.x - f.x) + Math.abs(pos.z - f.z) === 1 && (pos.y === f.y || pos.y === f.y + 1)
  if (!beside) return false
  const shut = (x, y, z) => (x === pos.x && y === pos.y && z === pos.z) || world.isSolid(world.at(bot, x, y, z))
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => shut(f.x + dx, f.y, f.z + dz) || shut(f.x + dx, f.y + 1, f.z + dz))
}

// Is `pos` the only thing under our feet? (the cells the hitbox rests on, one below the feet)
function holdsUsUp (bot, pos) {
  const p = bot.entity.position; const fy = Math.floor(p.y - 0.01) // (the block the feet rest on: a full block or a slab's cell)
  if (pos.y !== fy) return false
  const under = []
  for (const x of [Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)]) for (const z of [Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)]) {
    if (!under.some(c => c.x === x && c.z === z)) under.push({ x, z })
  }
  if (!under.some(c => c.x === pos.x && c.z === pos.z)) return false
  return !under.some(c => !(c.x === pos.x && c.z === pos.z) && world.isSolid(world.at(bot, c.x, fy, c.z)))
}
// How far we would fall with `pos` gone: the air under it down to the next floor.
function fallBelow (bot, pos) {
  let k = 1
  for (; k <= 64; k++) { const b = world.at(bot, pos.x, pos.y - k, pos.z); if (!b || world.isLavaBlock(b)) return Infinity; if (world.isWaterBlock(b)) return 0; if (b.boundingBox === 'block') break }
  return k
}
// A neighbouring cell to stand on that is not over `pos`.
function stepOff (bot, pos) {
  const fy = pos.y + 1
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    for (const dy of [0, 1, -1]) { const x = pos.x + dx; const y = fy + dy; const z = pos.z + dz; if (world.standable(bot, x, y, z)) return { x, y, z } }
  }
  return null
}

// Blocks never clicked as the thing to place against: clicking them opens/uses them (a note block retunes, a lectern
// opens, a composter takes the item) - except by an attached thing that has no other face, SNEAKING (a candle on a fence
// gate, a pot on a trapdoor: vanilla places instead of using when the player sneaks) -
const USE_REF_RE = /chest|furnace|crafting_table|_bed$|_door$|_trapdoor$|_fence_gate$|^barrel$|shulker_box$|^note_block$|^jukebox$|^composter$|^lectern$|^loom$|^smoker$|^grindstone$|^stonecutter$|anvil$|^enchanting_table$|cauldron$|^hopper$|^dispenser$|^dropper$|^beehive$|^bee_nest$|^bell$|^crafter$|^cartography_table$|^smithing_table$|^fletching_table$|campfire$|_sign$|^cake$|candle_cake$/
// - or they are no face to build on (carpet, pot, lantern, ladder, button, candle)
// (a lantern anchored: `lantern$` also matched jack_o_lantern and sea_lantern - full cubes - and no face of either was
//  ever clicked; the castle's 41 jack o'lantern cells had nothing to build against, 2026-09-27. The same rule as
//  build.js's LANTERN_RE - keep the two in step; a sea lantern is a full block too)
const NO_FACE_RE = new RegExp('_carpet$|^flower_pot$|^potted_|' + world.LANTERN_RE.source + '|^ladder$|_button$|^lever$|candle$|^sea_pickle$') // (lanterns: world.LANTERN_RE)
const NO_REF_RE = new RegExp(USE_REF_RE.source + '|' + NO_FACE_RE.source)
function refUsable (nb, sneaking = false) { return !!nb && world.isSolid(nb) && !NO_FACE_RE.test(nb.name) && (sneaking || !USE_REF_RE.test(nb.name)) }
// What a placing takes the place of (vanilla canBeReplaced): grass tufts, ferns, vines, a single snow layer. A flower is
// NOT one - the server keeps it and the placing fails.
const REPLACEABLE_RE = /^(short_grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|seagrass|tall_seagrass|leaf_litter|short_dry_grass|tall_dry_grass|bush|hanging_roots|snow)$/
// plants: they stand on soil (vanilla BushBlock mayPlaceOn: the dirt family; dry plants take sand and terracotta too)
const SOIL_PLANT_RE = /^(short_grass|fern|tall_grass|large_fern|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|pitcher_plant|sweet_berry_bush|pink_petals|wildflowers|bush|firefly_bush|open_eyeblossom|closed_eyeblossom|azalea|flowering_azalea|dead_bush|short_dry_grass|tall_dry_grass)$|_tulip$|_sapling$/
// What the server keeps in a cell a block is placed into - a torch, a flower, a sapling, a mushroom (only a tuft,
// REPLACEABLE_RE, gives way): off with it first, or every try "fails" ("the block is still dandelion" x4, 2026-10-03)
const clearsFirst = n => /(^|_)torch$/.test(n) || ((SOIL_PLANT_RE.test(n) || PLANT_RE.test(n) || /_mushroom$|_fungus$/.test(n)) && !REPLACEABLE_RE.test(n))
const PLANT_RE = /^(short_grass|tall_grass|fern|large_fern|snow|dead_bush|leaf_litter|vine|seagrass|short_dry_grass|tall_dry_grass|bush|firefly_bush|wildflowers|pink_petals|dandelion|poppy|.*_tulip|cornflower|azure_bluet|oxeye_daisy)$/

// Wait n physics ticks: a look set with force goes to the server on the next tick, and the server takes the
// facing of a stair/door from the rotation it last heard - the click must not overtake the look.
function ticks (bot, n = 2) {
  return new Promise(resolve => {
    let left = n
    const done = () => { clearTimeout(t); bot.removeListener('physicsTick', on); resolve() }
    const on = () => { if (--left <= 0) done() }
    const t = setTimeout(done, 80 * n + 100)
    bot.on('physicsTick', on)
  })
}

// Does the player's hitbox (0.6 wide, 1.8 tall; a cell above too for a two-high thing) reach into the cell?
const CONNECTS_RE = /(_pane|_fence|_wall|iron_bars)$/
function inBody (bot, pos, tall = false) {
  const p = bot.entity.position; const e = 0.001
  const top = pos.y + (tall ? 2 : 1)
  return p.x + 0.3 > pos.x + e && p.x - 0.3 < pos.x + 1 - e && p.z + 0.3 > pos.z + e && p.z - 0.3 < pos.z + 1 - e && p.y + 1.8 > pos.y + e && p.y < top - e
}
// Step to the middle of the cell we stand in (off an edge that leans into the cell beside it).
async function centre (bot) {
  const c = bot.entity.position.floored()
  // (never onto a cell that is no stand - a fire, a fence top, air: centred over a lit campfire the body stood in it, 2026-10-07)
  if (!world.standable(bot, c.x, c.y, c.z)) return
  const t0 = Date.now()
  while (Date.now() - t0 < 1500) {
    const p = bot.entity.position
    const dx = c.x + 0.5 - p.x; const dz = c.z + 0.5 - p.z
    if (Math.hypot(dx, dz) < 0.12) break
    await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
    bot.setControlState('forward', true)
    await sleep(50)
  }
  bot.setControlState('forward', false)
}

// Place `itemName` into the empty cell `pos` against a solid neighbour. Verified by re-read.
//   faceHint: neighbour offsets [dx,dy,dz] to try, in order (the block at pos+offset is clicked)
//   plans:    [{ off:[dx,dy,dz], cy?, yaw? }] instead - an oriented placement (build.js): `cy` is the click
//             height on a SIDE face (>0.5 = the upper half: top slabs, upside-down stairs), `yaw` the direction
//             the player faces when it clicks (stairs and doors take their facing from it). The rotation is
//             set first and the click sent with forceLook 'ignore', so the server records the facing we chose.
//   accept:   block => bool - what counts as placed (default: the item's own block name; a torch item
//             becomes a wall_torch, a birch plank stands in for oak). The caller verifies the block STATE.
//   tall:     the thing is two blocks high (a door): never with our body in the cell above either.
//   twin:     [dx,dy,dz] the second cell the thing fills (a door's top [0,1,0], a bed's head): never our body in it.
//   useRefs:  (sneaking) a block that is used when clicked may be clicked - an attached thing's only face.
//   plan.pitch: the pitch to click with (a barrel facing up is placed looking down, a floor button looking down).
//   noWalk:   place from where we stand or not at all (a walk at a river's edge may go under the water)
//   fromReflex: the caller IS a reflex (climbing out of water, walling off a shooter). The reflex holds the body
//             until its action returns, so waiting for the reflex to clear - or walking, which waits the same way -
//             is waiting on ourselves: each such place hung 120s (the bot floated in a river for 8 minutes,
//             2026-09-22). Implies noWalk.
// (never a burning block into the body's own cells: a campfire is slab-high and goes in where we stand, the body lifted
//  onto it - the builder placed the castle's campfire under its own feet high on the wall and the bot burned there,
//  2026-09-30)
function hotInOurCell (bot, pos, itemName) {
  if (!world.HOT_RE.test(itemName)) return false
  const p = bot.entity.position; const fx = Math.floor(p.x); const fz = Math.floor(p.z); const fy = Math.floor(p.y + 0.01)
  const xs = [fx, Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)]; const zs = [fz, Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)]
  return xs.includes(pos.x) && zs.includes(pos.z) && (pos.y === fy || pos.y === fy + 1 || pos.y === fy - 1)
}
async function place (bot, pos, itemName, { faceHint = null, plans = null, accept = null, allowZones = [], timeoutMs = 20000, sneak = true, tall = false, twin = null, useRefs = false, noWalk = false, fromReflex = false, keepExit = false, spare = [] } = {}) {
  if (fromReflex) noWalk = true
  if (tall && !twin) twin = [0, 1, 0]
  const target = new Vec3(pos.x, pos.y, pos.z)
  if (hotInOurCell(bot, pos, itemName)) { log('act', `won't place ${itemName} at ${move.fmt(pos)} - it would burn under my own feet`); return false }
  if (move.inForeign(pos)) { log('act', `won't place ${itemName} at ${move.fmt(pos)} - someone else's place`); return false }
  const placed = accept || (b => b.name === itemName)
  const cur = bot.blockAt(target)
  if (cur && placed(cur)) return true
  // (every refusal says why: a yard hole failed four times running, "0 of 1 fixes done", the reason unsaid - 2026-10-02)
  if (cur && !world.isAirish(cur) && !world.isLiquidWater(cur) && !PLANT_RE.test(cur.name) && !REPLACEABLE_RE.test(cur.name)) { log('act', `place ${itemName} at ${move.fmt(pos)}: ${cur.name} is there`); return false }
  const item = inv.items(bot).find(i => i.name === itemName)
  if (!item) { log('act', `place ${itemName} at ${move.fmt(pos)}: none in the pack`); return false }
  // a torch in the cell takes no block (the server keeps the torch): off with it first. The mine's floor fill tried its
  // own tunnel torch every few seconds for an hour - "the block is still torch", no cobble mined, 2026-09-27
  // (and a flower, a sapling: clearsFirst - here when in reach already, and again after the walk into reach below)
  if (cur && clearsFirst(cur.name) && reach(bot, target, 4.5)) { await digBlock(bot, cur).catch(() => false) }
  const list = plans || (faceHint || [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]).map(off => ({ off }))
  const t0 = Date.now()
  const cancelled = control.token()
  let lastErr = null; let tries = 0
  while (Date.now() - t0 < timeoutMs && tries < 4) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    // (every refusal says why - these two did not, and five "the place itself failed" at the castle's y129-130 in two minutes
    //  left nothing to go on, 2026-10-07 16:10)
    if (cancelled()) { log('act', `place ${itemName} at ${move.fmt(pos)}: stopped - the task was cancelled (control epoch ${control.current()})`); return false }
    if (!fromReflex) await reflex.waitClear()
    { const now = bot.blockAt(target); if (now && placed(now)) return true }
    let ref = null; let face = null; let plan = null
    for (const p of list) {
      const [dx, dy, dz] = p.off
      const nb = bot.blockAt(target.offset(dx, dy, dz))
      // (a carpet onto the string under it: the string's top is clicked, as a player floats a carpet - build.refOk's one exception)
      if (refUsable(nb, useRefs && sneak) || (dx === 0 && dy === -1 && dz === 0 && nb && nb.name === 'tripwire' && /_carpet$/.test(itemName))) { ref = nb; face = new Vec3(-dx, -dy, -dz); plan = p; break }
    }
    if (!ref) { log('act', `place ${itemName} at ${move.fmt(pos)}: nothing solid to place against`); return false }
    // don't place into our own body - the hitbox, not the cell our feet are counted in: a player at x=527.1 is
    // also in the cell at x=526, and the server refuses a block there ("the block is still water", 2026-09-22)
    // nor where a neighbour will GROW into us: a pane/fence/wall beside the new block reaches an arm across its own
    // cell toward it - a pane connected to its new log round the bot and the server pinned it there 10 minutes
    // (2026-09-23). Stand clear of those cells too.
    const grows = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => target.offset(dx, 0, dz)).filter(q => { const b = bot.blockAt(q); return b && CONNECTS_RE.test(b.name) })
    const second = twin && target.offset(twin[0], twin[1], twin[2])
    const clash = () => inBody(bot, pos) || (second && inBody(bot, second)) || grows.some(q => inBody(bot, q))
    if (clash()) {
      if (noWalk) return false
      // (STEP ASIDE ONTO A CHOSEN CELL: a stand the world's own rule calls standable - a floor, never a fire, a fence top or
      //  a door - in a column clear of the block's cells, the nearest. The old "anywhere but this cell" goal was met with
      //  the head in the cell, the body went to centre() over a lit campfire's column and burned to death, 2026-10-07)
      const clashCols = [pos].concat(second ? [second] : [], grows)
      const clear = q => !clashCols.some(c0 => c0.x === q.x && c0.z === q.z && q.y <= c0.y && q.y + 1 >= c0.y)
      const me = bot.entity.position.floored(); let st = null; let sd = Infinity
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
        const q = { x: me.x + dx, y: me.y + dy, z: me.z + dz }
        if (!clear(q) || !world.standable(bot, q.x, q.y, q.z)) continue
        { const fb = world.at(bot, q.x, q.y, q.z); if (fb && world.HOT_RE.test(fb.name)) continue } // (never fire at the feet - it does not block the body; audit) // (standable: a solid floor right under - no drop)
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy); if (d < sd) { sd = d; st = q }
      }
      if (st) await move.goTo(bot, new goals.GoalBlock(st.x, st.y, st.z), { timeoutMs: 5000, dig: false, place: false, label: 'step aside to place' })
      if (clash()) await centre(bot)
      if (clash()) { log('act', `place ${itemName} at ${move.fmt(pos)}: I stand where it (or a pane/fence beside it) would be`); return false }
    }
    // the builder (keepExit): never the block that shuts the last way out of the cell we stand in - it filled a
    // cathedral wall round its own feet and the bot stood walled into a one-wide shaft, sky four blocks up and nothing
    // to climb on, for twenty minutes (2026-09-25). The bunker, the wall-in, the mine's seal mean to shut us in.
    if (keepExit && sealsUsIn(bot, pos)) {
      if (noWalk) return false
      const f = bot.entity.position.floored()
      await move.goTo(bot, new goals.GoalInvert(new goals.GoalNear(f.x, f.y, f.z, 1)), { timeoutMs: 6000, dig: false, place: false, label: 'out of the pocket' })
      if (sealsUsIn(bot, pos)) { log('act', `place ${itemName} at ${move.fmt(pos)}: it would wall me in - left for later`); return false }
    }
    if (!reach(bot, pos, 4.4)) {
      if (noWalk) return false
      const r = await move.goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeoutMs: 20000, allowZones, label: 'reach to place', spare: [itemName].concat(spare || []) }) // (never the item it walks to place as a stepping stone: move.movementsFor - nor what the caller places next, spare)
      if (!r.ok && !reach(bot, pos, 4.8)) { log('act', `place ${itemName} at ${move.fmt(pos)}: could not get within reach (${r.why}) from ${move.fmt(bot.entity.position)}`); return false }
    }
    // (the flower out of the cell, now in reach - the walk came after the first look: a support placed from 6 blocks off
    //  never cleared its dandelion; audit R1)
    { const now = bot.blockAt(target); if (now && clearsFirst(now.name) && reach(bot, target, 4.8)) await digBlock(bot, now).catch(() => false) }
    // sneak:false is a promise the click goes out standing: held against the ledge crouch (reflex.holdNoSneak) - a chest
    // placed on a wall top went out sneaking and never paired with its twin (2026-09-27)
    const letGo = sneak ? () => {} : reflex.holdNoSneak()
    try {
      const held = inv.items(bot).find(i => i.name === itemName)
      if (!held) { log('act', `place ${itemName} at ${move.fmt(pos)}: none in the pack at the click - it was there before the walk into reach (${tries} tries so far)`); return false }
      // (in hand already - the next block of a run of the same: no equip round trip; ~0.5s a block went to placing, 2026-10-03)
      if (!bot.heldItem || bot.heldItem.name !== itemName) await bot.equip(held, 'hand')
      // (and a crouch some other holder pressed is let go too - the hold only stops the guard's own: audit #8)
      bot.setControlState('sneak', !!sneak)
      if (plan.yaw != null || plan.cy != null || plan.pitch != null) {
        // the cursor: the centre of the clicked face, or `cy` up a side face
        const delta = new Vec3(0.5 + face.x * 0.5, plan.cy != null && face.y === 0 ? plan.cy : 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
        const d = ref.position.plus(delta).minus(eye)
        const yaw = plan.yaw != null ? plan.yaw : Math.atan2(-d.x, -d.z)
        await bot.look(yaw, plan.pitch != null ? plan.pitch : Math.atan2(d.y, Math.hypot(d.x, d.z)), true)
        await ticks(bot, 2)
        await bot._placeBlockWithOptions(ref, face, { forceLook: 'ignore', delta, swingArm: 'right' })
      } else await bot.placeBlock(ref, face)
    } catch (e) {
      // placeBlock often times out waiting for the update even when it landed
      lastErr = e.message
    } finally { if (sneak) bot.setControlState('sneak', false); letGo() }
    // (read first, then wait: the place call has mostly seen the server's update already - a fixed 150ms before every look was
    //  most of a block's placing time; a block that lands late is still caught by the later reads)
    for (let w = 0; w < 7; w++) {
      const after = bot.blockAt(target)
      if (after && placed(after)) { try { const fg = require('./foreign'); fg.noteOwn(target, after.name); if (twin) { const t2 = target.offset(twin[0], twin[1], twin[2]); const b2 = bot.blockAt(t2); if (b2) fg.noteOwn(t2, b2.name) } } catch {} return true } // (our own hand, both halves of a door or a bed - foreign.noteOwn)
      if (w < 6) await sleep(150)
    }
    tries++
  }
  log('act', `place ${itemName} at ${move.fmt(pos)} failed after ${tries} tries${lastErr ? ': ' + lastErr : ''}`)
  return false
}

// Use `itemName` on the block at `pos` - a plant into a flower pot, a water bucket into a cauldron, one more candle onto
// candles (the server's use-item-on-block). Never sneaking: a sneaking use is a plain placing beside it. `accept` says
// when the block there has taken it. Verified by re-read.
// `face` 'up' or 'down': the face clicked (a top slab takes its second half on its underside).
// itemName null: the block itself is used, whatever is in hand (a full composter emptied of its bone meal).
// The one right-click on a block for every caller: a raw activateBlock while the edge guard held sneak was a sneaking
// click - shears on a pumpkin or a nest and a composter's layer came to "+0" (2026-09-27).
async function useOn (bot, pos, itemName, { accept, face = 'up', allowZones = [], timeoutMs = 15000, noWalk = false, yaw = null } = {}) {
  if (move.inForeign(pos)) { log('act', `won't use ${itemName} on ${move.fmt(pos)} - someone else's place`); return false } // (their composter, their bee nest: foreign.js)
  const target = new Vec3(pos.x, pos.y, pos.z)
  const t0 = Date.now()
  const cancelled = control.token()
  let lastErr = null; let tries = 0
  while (Date.now() - t0 < timeoutMs && tries < 3) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (cancelled()) return false
    await reflex.waitClear()
    const b = bot.blockAt(target)
    if (!b) return false
    if (accept(b)) return true
    if (!reach(bot, pos, 4.4)) {
      if (noWalk) { log('act', `use ${itemName || '(hand)'} on the block at ${move.fmt(pos)}: out of reach (and not to walk)`); return false }
      const r = await move.goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeoutMs: 20000, allowZones, label: 'reach to use' })
      if (!r.ok && !reach(bot, pos, 4.8)) { log('act', `use ${itemName || '(hand)'} on the block at ${move.fmt(pos)}: could not get within reach (${r.why})`); return false }
    }
    const held = itemName ? inv.items(bot).find(i => i.name === itemName) : null
    if (itemName && !held) { log('act', `use ${itemName} on the block at ${move.fmt(pos)}: none in the pack`); return false }
    // (a use with no item is the block's own - never with a full bucket in the hand: a lava bucket held turns the click
    //  into a placing; audit 2026-09-28)
    if (!itemName && bot.heldItem && /_bucket$/.test(bot.heldItem.name)) await bot.unequip('hand').catch(() => {})
    // (the hold: the ledge crouch presses sneak again otherwise, between this let-go and the click - reflex.holdNoSneak)
    const letGo = reflex.holdNoSneak()
    // (an axe with a shield worn: the server reads an unsneaking axe click as the shield's raise and strips nothing -
    //  vanilla AxeItem's blocking-intent rule; 634 dead clicks 2026-09-28. A player shift-clicks, and so do we. Only the
    //  axe: a sneaking click skips the block's own use, which is what shears on a pumpkin and a composter's layer are)
    const secondary = !!itemName && /_axe$/.test(itemName) && inv.offhandShield(bot)
    try {
      if (held) await bot.equip(held, 'hand')
      bot.setControlState('sneak', secondary)
      const up = face !== 'down'
      // (`yaw`: the look the use takes its direction from - a fence gate opened turns to it - else straight at the face)
      const aim = target.offset(0.5, up ? 1 : 0, 0.5)
      if (yaw != null) { const e = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0); const d = aim.minus(e); await bot.look(yaw, Math.atan2(d.y, Math.hypot(d.x, d.z)), true) } else await bot.lookAt(aim, true)
      await ticks(bot, 2)
      await bot.activateBlock(b, new Vec3(0, up ? 1 : -1, 0), new Vec3(0.5, up ? 1 : 0, 0.5))
    } catch (e) { lastErr = e.message } finally { if (secondary) bot.setControlState('sneak', false); letGo() }
    for (let w = 0; w < 6; w++) {
      await sleep(150)
      const after = bot.blockAt(target)
      if (after && accept(after)) return true
    }
    tries++
  }
  log('act', `use ${itemName || '(hand)'} on the block at ${move.fmt(pos)} failed after ${tries} tries${lastErr ? ': ' + lastErr : ''}`)
  return false
}

// Pour a bucket (`itemName`: water_bucket, lava_bucket) into the empty cell `pos`: a bucket is no block item - the
// server casts its own ray from the player's look and fills the cell in front of the face it hits (vanilla
// BucketItem.use), so the look goes to the centre of a solid neighbour's face toward the cell and the item is used.
// `plans` as place(); `accept` block => bool. Verified by re-read.
// The eye must be on the cell's side of that face: from behind it the ray meets another face first and the water lands
// somewhere else - inside the build, on the crops (2026-09-27). A face we stand behind is no plan.
async function pour (bot, pos, itemName, { plans, accept, allowZones = [], timeoutMs = 15000, noWalk = false, asAir = [], probe = false } = {}) {
  if (move.inForeign(pos)) { log('act', `won't pour ${itemName} at ${move.fmt(pos)} - someone else's place`); return false }
  const target = new Vec3(pos.x, pos.y, pos.z)
  const t0 = Date.now()
  const cancelled = control.token()
  let tries = 0
  // (NEVER A WATERLOGGABLE FACE: a bucket used on a wall, a fence, a slab fills THAT block - the water goes into it, not
  //  the cell beside it. The hub's well was poured against its own rim walls: each pour waterlogged a wall, the leak fix dug
  //  it out, the next pour did it again - every bucket spent, the well still dry, the walls redone, 2026-10-04)
  const loggable = b => { try { return b && Object.prototype.hasOwnProperty.call(b.getProperties() || {}, 'waterlogged') } catch { return false } }
  const refs = () => (plans || []).map(p => {
    const nb = bot.blockAt(target.offset(p.off[0], p.off[1], p.off[2]))
    return refUsable(nb) && !loggable(nb) ? { ref: nb, face: new Vec3(-p.off[0], -p.off[1], -p.off[2]) } : null
  }).filter(Boolean)
  const faceCentre = ({ ref, face }) => ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
  // the eye past the face's plane, on the cell's side
  const eyeAt = p => (p || bot.entity.position).offset(0, bot.entity.eyeHeight || 1.62, 0)
  const faced = (r, eye = eyeAt()) => {
    const c = faceCentre(r)
    return (eye.x - c.x) * r.face.x + (eye.y - c.y) * r.face.y + (eye.z - c.z) * r.face.z > 0.05
  }
  // THE RAY CLEAR to the face: the server's bucket ray stops at the first block it meets - a rim wall between the eye and the
  // well's floor took the water (waterlogged), twice a morning, every bucket spent and the well still dry, 2026-10-05. The
  // line from the eye to the face's centre, sampled: through air (or water) only, but the cell itself and the block clicked
  const clear = (r, eye = eyeAt()) => {
    const c = faceCentre(r); const d = c.minus(eye); const len = d.norm(); if (len < 0.01) return true
    const tk = k => k.x + ',' + k.y + ',' + k.z
    const ok = new Set([tk(target), tk(r.ref.position), ...asAir])
    for (let t = 0.05; t < len - 0.05; t += 0.05) { // (every 0.05: a corner the line clips is the server's hit; audit)
      const q = eye.plus(d.scaled(t / len)).floored(); if (ok.has(tk(q))) continue
      const b = bot.blockAt(q); if (b && !(b.boundingBox === 'empty' || /water/.test(b.name))) return false
    }
    return true
  }
  // (no clear line from here: a stand near the cell that has one - walked to, nothing dug or placed; none, no pour at all and
  //  the bucket kept)
  // (the eye stands on the floor's own top: a slab's is half a block down; a wall's or a fence's 1.5 is no stand a walk ever
  //  steps up onto - the top of the well's rim wall was picked, "could not reach the stand ... (timeout)", 2026-10-05.
  //  Nearest first, a few of them: the caller walks to the next when one cannot be reached)
  const floorTop = world.floorTop // (the one rule: world.floorTop)
  const clearStands = () => {
    const me = bot.entity.position.floored(); const out = []
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -2; dy <= 3; dy++) {
      const st = new Vec3(target.x + dx, target.y + dy, target.z + dz)
      if (st.equals(target) || !world.standable(bot, st.x, st.y, st.z)) continue
      const top = floorTop(bot.blockAt(st.offset(0, -1, 0))); if (top > 1.01) continue
      const eye = st.offset(0.5, top - 1 + (bot.entity.eyeHeight || 1.62), 0.5)
      if (eye.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4.4) continue
      if (!refs().some(r => faced(r, eye) && clear(r, eye))) continue
      out.push({ st, d: st.distanceTo(me) })
    }
    return out.sort((a, b) => a.d - b.d).slice(0, 3).map(o => o.st)
  }
  const clearStand = () => clearStands()[0] || null
  // (the PROBE: a stand with a clear line exists - with the cells in asAir taken as opened? build.placeCell asks before it opens a
  //  wall of the build for a pour boxed in by its own rim; nothing walked, nothing poured)
  if (probe) return !!(refs().find(r => faced(r) && clear(r)) || clearStand())
  while (Date.now() - t0 < timeoutMs && tries < 3) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (cancelled()) return false
    await reflex.waitClear()
    const cur = bot.blockAt(target)
    if (cur && accept(cur)) return true
    if (!inv.items(bot).some(i => i.name === itemName)) { log('act', `pour ${itemName} at ${move.fmt(pos)}: no ${itemName} in the pack - the bucket is empty`); return false }
    if (!refs().length) { log('act', `pour ${itemName} at ${move.fmt(pos)}: nothing solid to pour against`); return false }
    if (!reach(bot, pos, 4.4)) {
      if (noWalk) return false
      const r = await move.goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeoutMs: 20000, allowZones, label: 'reach to pour' })
      if (!r.ok && !reach(bot, pos, 4.8)) return false
    }
    // (never from inside the cell: the ray starts in it)
    if (inBody(bot, pos)) { log('act', `pour ${itemName} at ${move.fmt(pos)}: I stand in the cell`); return false }
    let pick = refs().find(r => faced(r) && clear(r))
    if (!pick) {
      const sts = noWalk ? [] : clearStands()
      if (!sts.length) { log('act', `pour ${itemName} at ${move.fmt(pos)}: no stand near it with a clear line to a face to pour against - the bucket kept`); return false }
      for (const st of sts) {
        if (cancelled()) return false
        const r = await move.goTo(bot, new goals.GoalBlock(st.x, st.y, st.z), { timeoutMs: 15000, stuckMs: 6000, dig: false, place: false, allowZones, label: 'to a clear line to pour' })
        if (!r.ok) { log('act', `pour ${itemName} at ${move.fmt(pos)}: could not reach the stand ${move.fmt(st)} with a clear line (${r.why})`); continue }
        pick = refs().find(r2 => faced(r2) && clear(r2))
        if (pick) break
        log('act', `pour ${itemName} at ${move.fmt(pos)}: at ${move.fmt(st)} and still no clear line`)
      }
      if (!pick) { log('act', `pour ${itemName} at ${move.fmt(pos)}: none of ${sts.length} stand(s) with a clear line reached - the bucket kept`); return false }
    }
    const held = inv.items(bot).find(i => i.name === itemName)
    if (!held) { log('act', `pour ${itemName} at ${move.fmt(pos)}: the bucket is empty`); return false }
    const letGo = reflex.holdNoSneak() // (no crouch during the use: reflex.holdNoSneak)
    try {
      await reflex.pouring(async () => { // (the one click a full bucket is for: reflex's guard lets it through)
        await bot.equip(held, 'hand')
        bot.setControlState('sneak', false)
        await bot.lookAt(faceCentre(pick), true)
        await ticks(bot, 2)
        bot.activateItem()
        await sleep(100)
        bot.deactivateItem()
      })
    } catch {} finally { letGo() }
    for (let w = 0; w < 6; w++) {
      await sleep(150)
      const after = bot.blockAt(target)
      if (after && accept(after)) return true
    }
    tries++
  }
  log('act', `pour ${itemName} at ${move.fmt(pos)} failed after ${tries} tries`)
  return false
}

// Fill an empty bucket at the still water `pos` (a source: vanilla's empty bucket takes SOURCE fluid only), looking at
// the water's surface. True when the pack holds one more water bucket than before - the one fill every gatherer uses
// (the forager's own right-click never checked it had filled, 2026-09-27).
// `liquid`: 'water' (the default) or 'lava' - a lava source fills the same way and the pack must show a lava bucket
// (the furnaces' fuel: one bucket smelts a hundred, 2026-09-28). The walk here is water's only: lava is never walked up
// to by this - its gatherer stands the bot on its own chosen ground first and passes noWalk.
async function fill (bot, pos, { allowZones = [], timeoutMs = 12000, noWalk = false, liquid = 'water' } = {}) {
  if (liquid !== 'water' && liquid !== 'lava') throw new Error(`fill: no bucket of ${liquid}`)
  if (move.inForeign(pos)) { log('act', `won't take the ${liquid} at ${move.fmt(pos)} - someone else's place`); return false }
  const full = liquid + '_bucket'
  if (liquid === 'lava') noWalk = true
  const target = new Vec3(pos.x, pos.y, pos.z)
  const t0 = Date.now()
  const cancelled = control.token()
  let tries = 0
  const still = w => { try { return !!w && w.name === liquid && Number((w.getProperties() || {}).level || 0) === 0 } catch { return false } }
  while (Date.now() - t0 < timeoutMs && tries < 3) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (cancelled()) return false
    await reflex.waitClear()
    if (!still(bot.blockAt(target))) { log('act', `fill a bucket at ${move.fmt(pos)}: no still ${liquid} there`); return false }
    const empty = inv.items(bot).find(i => i.name === 'bucket')
    if (!empty) { log('act', `fill a bucket at ${move.fmt(pos)}: no empty bucket in the pack`); return false }
    if (!reach(bot, pos, 4.4)) {
      if (noWalk) return false
      const r = await move.goTo(bot, new goals.GoalNear(pos.x, pos.y + 1, pos.z, 2), { timeoutMs: 20000, allowZones, label: 'reach the water' })
      if (!r.ok && !reach(bot, pos, 4.8)) return false
    }
    const had = inv.count(bot, full)
    const letGo = reflex.holdNoSneak() // (no crouch during the use: reflex.holdNoSneak)
    try {
      await bot.equip(empty, 'hand')
      bot.setControlState('sneak', false)
      await bot.lookAt(target.offset(0.5, 0.85, 0.5), true)
      await ticks(bot, 2)
      bot.activateItem()
      await sleep(100)
      bot.deactivateItem()
    } catch {} finally { letGo() }
    for (let k = 0; k < 6; k++) { await sleep(150); if (inv.count(bot, full) > had) return true }
    tries++
  }
  log('act', `fill a bucket at ${move.fmt(pos)} failed after ${tries} tries`)
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
async function collectDrops (bot, { radius = 8, maxMs = 15000, only = null } = {}) {
  const t0 = Date.now()
  let picked = 0
  const tried = new Set()
  for (const [id, at] of unreachableDrops) if (Date.now() - at > 120000) unreachableDrops.delete(id)
  for (const id of unreachableDrops.keys()) tried.add(id)
  const cancelled = control.token()
  while (Date.now() - t0 < maxMs && !cancelled()) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    const me = bot.entity.position
    const drops = droppedItems(bot, radius).filter(e => !tried.has(e.id) && Math.abs(e.position.y - me.y) < 6 && (!only || only(e))) // (only: the drops asked for)
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

module.exports = { skippedDrop: id => unreachableDrops.has(id), SOIL_PLANT_RE, clearsFirst, lastDigWhy: () => lastDigWhy, grounded, settleAfterClose, openSettled, digRefusal, sealsUsIn, holdsUsUp, fallBelow, stepOff, dig, digBlock, place, useOn, pour, fill, collectDrops, droppedItems, reach, inBody, sleep, ticks, refUsable, PLANT_RE, NO_REF_RE, USE_REF_RE, NO_FACE_RE, REPLACEABLE_RE }
