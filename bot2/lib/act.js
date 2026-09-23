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

// Finished cells of our builds (the hut, the schematic) are never broken by any dig: the check lives HERE,
// in the one dig primitive, not in each caller (the night's dig-in reflex went straight through a finished
// castle wall, 2026-09). `own` is the builder replacing a wrong block in its own cell - the only opt-out.
const refusedAt = new Map() // pos key -> last log time (a caller retrying a protected block logs once a minute)
function guarded (bot, b, own) {
  if (own || !move.isProtected(b, 'dig')) return false
  const k = `${b.position.x},${b.position.y},${b.position.z}`
  if (Date.now() - (refusedAt.get(k) || 0) > 60000) { refusedAt.set(k, Date.now()); log('act', `won't dig ${b.name} at ${k} - a finished block of a build`) }
  return true
}

// The raw dig for callers that must not wait or walk (the reflexes: act.dig waits for the reflex to clear,
// which inside a reflex is forever). Same protection. True when the block there changed.
async function digBlock (bot, b, { own = false } = {}) {
  if (!b || guarded(bot, b, own)) return false
  try { await inv.equipFor(bot, b); await bot.dig(b, true) } catch { return false }
  const after = world.at(bot, b.position.x, b.position.y, b.position.z)
  return !after || after.name !== b.name
}

// Dig one block (walking into reach if needed). Refuses crafted blocks unless `force`, and finished build
// cells unless `own`. Returns true when the cell is verifiably no longer that block.
async function dig (bot, pos, { force = false, own = false, allowZones = [], timeoutMs = 30000, noWalk = false, reachMax = 4.3 } = {}) {
  let b = world.at(bot, pos.x, pos.y, pos.z)
  // "done" means the cell holds nothing breakable. Grass/flowers have no collision box but they ARE
  // blocks: treating them as air made a seed-gathering loop spin on resolved promises and starve the
  // event loop for minutes (keep-alive timeout, 2026-09-14).
  const nothing = x => !x || /^(air|cave_air|void_air)$/.test(x.name) || world.isWaterBlock(x) || world.isLavaBlock(x)
  if (nothing(b)) return true
  if (guarded(bot, b, own)) return false
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
    if (guarded(bot, b, own)) return false // (the cell may have been finished while we waited)
    const tm = Date.now()
    if (!reach(bot, pos, reachMax) && noWalk) return false
    if (!reach(bot, pos, reachMax)) {
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

// Blocks never clicked as the thing to place against: clicking them opens/uses them, or (carpet, pot,
// lantern, ladder) they are no face to build on
const NO_REF_RE = /chest|furnace|crafting_table|_bed|_door|_trapdoor|_fence_gate|barrel|shulker|_carpet$|^flower_pot$|^potted_|lantern$|^ladder$|_button$|^lever$/
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
//   noWalk:   place from where we stand or not at all (a walk at a river's edge may go under the water)
//   fromReflex: the caller IS a reflex (climbing out of water, walling off a shooter). The reflex holds the body
//             until its action returns, so waiting for the reflex to clear - or walking, which waits the same way -
//             is waiting on ourselves: each such place hung 120s (the bot floated in a river for 8 minutes,
//             2026-09-22). Implies noWalk.
async function place (bot, pos, itemName, { faceHint = null, plans = null, accept = null, allowZones = [], timeoutMs = 20000, sneak = true, tall = false, noWalk = false, fromReflex = false } = {}) {
  if (fromReflex) noWalk = true
  const target = new Vec3(pos.x, pos.y, pos.z)
  const placed = accept || (b => b.name === itemName)
  const cur = bot.blockAt(target)
  if (cur && placed(cur)) return true
  if (cur && !world.isAirish(cur) && !world.isWaterBlock(cur) && !PLANT_RE.test(cur.name)) return false
  const item = inv.items(bot).find(i => i.name === itemName)
  if (!item) return false
  const list = plans || (faceHint || [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]).map(off => ({ off }))
  const t0 = Date.now()
  const cancelled = control.token()
  let lastErr = null; let tries = 0
  while (Date.now() - t0 < timeoutMs && tries < 4) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (cancelled()) return false
    if (!fromReflex) await reflex.waitClear()
    { const now = bot.blockAt(target); if (now && placed(now)) return true }
    let ref = null; let face = null; let plan = null
    for (const p of list) {
      const [dx, dy, dz] = p.off
      const nb = bot.blockAt(target.offset(dx, dy, dz))
      if (nb && world.isSolid(nb) && !NO_REF_RE.test(nb.name)) { ref = nb; face = new Vec3(-dx, -dy, -dz); plan = p; break }
    }
    if (!ref) { log('act', `place ${itemName} at ${move.fmt(pos)}: nothing solid to place against`); return false }
    // don't place into our own body - the hitbox, not the cell our feet are counted in: a player at x=527.1 is
    // also in the cell at x=526, and the server refuses a block there ("the block is still water", 2026-09-22)
    // nor where a neighbour will GROW into us: a pane/fence/wall beside the new block reaches an arm across its own
    // cell toward it - a pane connected to its new log round the bot and the server pinned it there 10 minutes
    // (2026-09-23). Stand clear of those cells too.
    const grows = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => target.offset(dx, 0, dz)).filter(q => { const b = bot.blockAt(q); return b && CONNECTS_RE.test(b.name) })
    const clash = () => inBody(bot, pos, tall) || grows.some(q => inBody(bot, q))
    if (clash()) {
      if (noWalk) return false
      await move.goTo(bot, new goals.GoalInvert(grows.length ? new goals.GoalNear(pos.x, pos.y, pos.z, 1.8) : new goals.GoalBlock(pos.x, pos.y, pos.z)), { timeoutMs: 5000, dig: false, place: false })
      if (clash()) await centre(bot)
      if (clash()) { log('act', `place ${itemName} at ${move.fmt(pos)}: I stand where it (or a pane/fence beside it) would be`); return false }
    }
    if (!reach(bot, pos, 4.4)) {
      if (noWalk) return false
      const r = await move.goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeoutMs: 20000, allowZones, label: 'reach to place' })
      if (!r.ok && !reach(bot, pos, 4.8)) return false
    }
    try {
      const held = inv.items(bot).find(i => i.name === itemName)
      if (!held) return false
      await bot.equip(held, 'hand')
      if (sneak) bot.setControlState('sneak', true)
      if (plan.yaw != null || plan.cy != null) {
        // the cursor: the centre of the clicked face, or `cy` up a side face
        const delta = new Vec3(0.5 + face.x * 0.5, plan.cy != null && face.y === 0 ? plan.cy : 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
        const d = ref.position.plus(delta).minus(eye)
        const yaw = plan.yaw != null ? plan.yaw : Math.atan2(-d.x, -d.z)
        await bot.look(yaw, Math.atan2(d.y, Math.hypot(d.x, d.z)), true)
        await ticks(bot, 2)
        await bot._placeBlockWithOptions(ref, face, { forceLook: 'ignore', delta, swingArm: 'right' })
      } else await bot.placeBlock(ref, face)
    } catch (e) {
      // placeBlock often times out waiting for the update even when it landed
      lastErr = e.message
    } finally { if (sneak) bot.setControlState('sneak', false) }
    for (let w = 0; w < 6; w++) {
      await sleep(150)
      const after = bot.blockAt(target)
      if (after && placed(after)) return true
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

module.exports = { dig, digBlock, place, collectDrops, droppedItems, reach, inBody, sleep, ticks, PLANT_RE, NO_REF_RE }
