'use strict'
// Survival schematic builder. The world is the progress record: a cell is done when the block there IS
// the schematic block - material AND the state that makes its look (a stair's facing and half, a slab's
// type, a log's axis, a wall torch's facing, a hanging lantern) - so a restart, a death, a creeper or a
// griefer never confuses the count. Nothing about the build is latched: complete() is re-derived from
// the world every time it is asked (a "done" latch left a creeper hole in a finished castle for good).
// Order: clear what doesn't belong (top-down), then place bottom-up, nearest first; attached things
// (torches, lanterns, ladders, carpets, doors) once what they hang on stands.
// Scaffold is a DIFF against the site as it was before any work (a snapshot on disk), not a list of
// remembered placements: the planner's own towers and bridges were never recorded, and 467 filler blocks
// were left round a "finished" castle.
const fs = require('fs')
const path = require('path')
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

const SCHEM_DIRS = [path.join(__dirname, '..', 'schematics'), path.join(__dirname, '..', '..', 'bot', 'schematics')]
const SCAFFOLD_RE = /^(dirt|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|coarse_dirt)$/
// (granite is not filler: the basilica's brick course is polished granite, and scaffold spends it by the stack)
const FILLER_ITEMS = /^(dirt|andesite|diorite|tuff|cobbled_deepslate|netherrack|coarse_dirt)$/
// what the bot leaves standing about: placeSupport/pathfinder filler (+rooted_dirt, the planner's list), and
// the reflexes' plugs (cobblestone, stone, sand, gravel)
const STRAY_RE = /^(dirt|coarse_dirt|rooted_dirt|cobblestone|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|stone|sand|gravel)$/
// our furniture and lights are never scaffold, wherever they stand
const FURNITURE_RE = /(chest|furnace|crafting_table|_door|_bed|barrel|torch|lantern|smoker|anvil)$/
const SITE_PAD = 6 // the snapshot / scaffold region: the footprint +6 in x/z, y1-2 .. y2+6

let job = null // { name, origin, cells: [cell], box, index: Map key->cell }

// ---- materials ------------------------------------------------------------------------------------
// The operator chose local wood (2026-09-15: a birch forest, oak scarce, no spruce): a wood cell takes the
// same FORM in any species - planks for planks, stairs for stairs - the blueprint's own species first when
// we hold it. Stone forms stay exact (cobblestone_stairs is cobblestone_stairs).
const LOCAL_WOOD = true
const WOODS = 'oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped'
const LOG_ANY = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/
const PLANKS_ANY = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_planks$/
const WOOD_FORM_RE = new RegExp(`^(${WOODS})_(planks|log|stairs|slab|fence|fence_gate|door|trapdoor|pressure_plate|button)$`)
// grass needs silk touch to carry; dirt under open sky turns to grass by itself (and grass under a block
// turns to dirt): either satisfies either
const GROUND_ALT = /^(dirt|grass_block)$/
const woodAlts = {}
function woodForm (name) { const m = LOCAL_WOOD && WOOD_FORM_RE.exec(name); return m ? m[2] : null }
function woodAlt (form) { return form === 'log' ? LOG_ANY : (woodAlts[form] || (woodAlts[form] = new RegExp(`^(${WOODS})_${form}$`))) }
// (kept for the material side: truthy for every wood form - 'log', 'planks', 'stairs', ...)
function woodClass (name) { return woodForm(name) }
// The items that may stand in for `itemName` when placing (the material side counts stock with it).
// null = only the item itself.
function acceptsFor (itemName) {
  if (itemName === 'dirt' || itemName === 'grass_block') return GROUND_ALT
  const f = woodForm(itemName)
  return f ? woodAlt(f) : null
}

// ---- cells ----------------------------------------------------------------------------------------
// The props that define a block's look and how it was placed. Connections (a wall's/fence's/pane's
// north..up, a stair's shape) are the world's business, derived from the neighbours; waterlogged, powered,
// open, snowy and a door's hinge don't make it the wrong block either.
const KEY_PROPS = ['facing', 'half', 'type', 'axis', 'hanging']
const DIRS = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const ALL_FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
// mineflayer yaw: 0 looks north (-z), PI/2 west (-x), PI south, -PI/2 east (lookAt: yaw = atan2(-dx, -dz))
function yawOf (facing) { const d = DIRS[facing]; return d ? Math.atan2(-d[0], -d[2]) : null }
function facingOfYaw (yaw) {
  const dx = -Math.sin(yaw); const dz = -Math.cos(yaw)
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
}
// blocks whose facing is the direction the PLAYER looks when placing (vanilla getHorizontalDirection)
const LOOK_FACING_RE = /_stairs$|_door$/
// hung on the side of the block behind them: facing = the clicked face's normal (support = cell - facing)
const SIDE_ATTACHED_RE = /wall_torch$|^ladder$|_wall_sign$|_wall_banner$|_wall_hanging_sign$/
// stand on the block below
const BELOW_ATTACHED_RE = /^(torch|soul_torch|redstone_torch|copper_torch|flower_pot|rail|powered_rail|detector_rail|activator_rail|redstone_wire|repeater|comparator)$|_carpet$|_pressure_plate$|^potted_|_sapling$|_door$/

function wantOf (c) {
  if (c.want !== undefined) return c.want
  if (!c.props) return null
  const w = {}
  for (const k of KEY_PROPS) if (c.props[k] != null) w[k] = String(c.props[k])
  return Object.keys(w).length ? w : null
}
function nameOk (c, n) { return n === c.name || !!(c.alt && c.alt.test(n)) }
function key (p) { return `${p.x},${p.y},${p.z}` }

// The item that places this block (null: it is never placed on its own - a door's upper half comes with
// the lower). Grass cells are keyed as dirt: dirt is what a player without silk touch can carry.
function itemOf (c, md) {
  if (c.item !== undefined) return c.item
  return itemForBlock(c.name, c.props, md)
}
function itemForBlock (name, props, md) {
  if (/_door$/.test(name) && props && props.half === 'upper') return null
  if (name === 'grass_block') return 'dirt'
  if (!md) return name
  if (md.itemsByName[name]) return name
  const unwall = name.replace(/(^|_)wall_/, '$1') // wall_torch -> torch, soul_wall_torch -> soul_torch, oak_wall_sign -> oak_sign
  if (md.itemsByName[unwall]) return unwall
  if (/^potted_/.test(name)) return 'flower_pot'
  return null
}

// Everything the builder needs to know about one blueprint cell, decided once when the job is set.
function describe (cell, md) {
  const n = cell.name
  const w = wantOf(Object.assign({}, cell, { want: undefined }))
  cell.want = w
  cell.item = itemForBlock(n, cell.props, md)
  const f = woodForm(n)
  if (f) { cell.alt = woodAlt(f); cell.prefer = [n] }
  if (n === 'grass_block' || n === 'dirt') { cell.alt = GROUND_ALT; cell.prefer = n === 'grass_block' ? ['grass_block', 'dirt'] : ['dirt'] }
  cell.itemAlt = cell.item ? acceptsFor(cell.item) : null
  if (/_door$/.test(n)) {
    if (w && w.half === 'upper') { cell.doorUpper = true; cell.sup = { x: cell.x, y: cell.y - 1, z: cell.z } } else cell.doorLower = true
  }
  if (!cell.doorUpper) {
    if (SIDE_ATTACHED_RE.test(n) && w && DIRS[w.facing]) { const d = DIRS[w.facing]; cell.attach = 'side'; cell.sup = { x: cell.x - d[0], y: cell.y, z: cell.z - d[2] } } else if (/lantern$/.test(n)) { const up = w && w.hanging === 'true'; cell.attach = up ? 'above' : 'below'; cell.sup = { x: cell.x, y: cell.y + (up ? 1 : -1), z: cell.z } } else if (BELOW_ATTACHED_RE.test(n)) { cell.attach = 'below'; cell.sup = { x: cell.x, y: cell.y - 1, z: cell.z } }
  }
  return cell
}

// How a cell can be placed, best first: which neighbour to click (off), how high up a side face (cy), and
// the direction to face while clicking (yaw). Pure: the world decides later which of these are possible.
//   stairs/slabs: top half = click the underside of the block above, or high on a side face; bottom half =
//     the top of the block below, or low on a side face. Stairs and doors face where the player looks.
//   wall torch/ladder: the side face of the block behind (facing = that face's normal).
//   hanging lantern: the underside of the block above. Torch/carpet/plate/pot/door: the top of the block below.
//   logs: a face on the log's own axis.
function plansFor (c) {
  if (c.doorUpper) return []
  const w = wantOf(c) || {}
  const yaw = LOOK_FACING_RE.test(c.name) && w.facing ? yawOf(w.facing) : null
  const withYaw = p => (yaw != null ? Object.assign(p, { yaw }) : p)
  if (c.attach && c.sup) return [withYaw({ off: [c.sup.x - c.x, c.sup.y - c.y, c.sup.z - c.z] })]
  if (w.axis && !axisRelaxed(c) && failsOf(c) < 3) {
    if (w.axis === 'x') return [{ off: [1, 0, 0] }, { off: [-1, 0, 0] }]
    if (w.axis === 'z') return [{ off: [0, 0, 1] }, { off: [0, 0, -1] }]
    if (w.axis === 'y') return [{ off: [0, -1, 0] }, { off: [0, 1, 0] }]
  }
  const half = w.half === 'top' || w.half === 'bottom' ? w.half : (w.type === 'top' || w.type === 'bottom' ? w.type : null)
  if (half === 'top') return [withYaw({ off: [0, 1, 0] })].concat(SIDES.map(s => withYaw({ off: s, cy: 0.75 })))
  if (half === 'bottom') return [withYaw({ off: [0, -1, 0] })].concat(SIDES.map(s => withYaw({ off: s, cy: 0.25 })))
  return ALL_FACES.map(off => withYaw({ off }))
}
// What placing along `plan` makes, by the vanilla rules - for checking the rules offline, and for the log.
function predict (c, plan, playerYaw) {
  const face = plan.off.map(v => -v) // the clicked face's normal
  const out = {}
  const w = wantOf(c) || {}
  const clickY = face[1] === 1 ? 1 : face[1] === -1 ? 0 : (plan.cy != null ? plan.cy : 0.5)
  if (/_stairs$|_slab$/.test(c.name)) {
    const top = face[1] === -1 || (face[1] === 0 && clickY > 0.5)
    if (/_stairs$/.test(c.name)) out.half = top ? 'top' : 'bottom'; else out.type = top ? 'top' : 'bottom'
  }
  const yaw = plan.yaw != null ? plan.yaw : playerYaw
  if (LOOK_FACING_RE.test(c.name) && yaw != null) out.facing = facingOfYaw(yaw)
  if (SIDE_ATTACHED_RE.test(c.name)) out.facing = Object.keys(DIRS).find(k => DIRS[k].every((v, i) => v === face[i]))
  if (/lantern$/.test(c.name)) out.hanging = face[1] === -1 ? 'true' : 'false'
  if (w.axis) out.axis = face[0] ? 'x' : face[1] ? 'y' : 'z'
  return out
}

async function loadSchematic (name, version) {
  const { Schematic } = require('prismarine-schematic')
  let file = null
  for (const d of SCHEM_DIRS) { const f = path.join(d, name.endsWith('.schem') ? name : name + '.schem'); if (fs.existsSync(f)) { file = f; break } }
  if (!file) throw new Error('no schematic ' + name)
  return Schematic.read(fs.readFileSync(file), version)
}

async function setJob (bot, name, origin) {
  const s = await loadSchematic(name, bot.version)
  const md = world.data(bot)
  const st = s.start(); const en = s.end()
  const cells = []
  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const b = s.getBlock(new Vec3(x, y, z))
    if (!b || b.name === 'air') continue
    cells.push(describe({ x: origin.x + x - st.x, y: origin.y + y - st.y, z: origin.z + z - st.z, name: b.name, props: b.getProperties() }, md))
  }
  const box = { x1: origin.x, y1: origin.y, z1: origin.z, x2: origin.x + en.x - st.x, y2: origin.y + en.y - st.y, z2: origin.z + en.z - st.z }
  job = { name, origin, cells, box, index: new Map(cells.map(c => [key(c), c])) }
  surveyCache = null
  mem.set('build', { name, origin })
  move.setZone('build', { x1: box.x1 - 1, y1: box.y1 - 1, z1: box.z1 - 1, x2: box.x2 + 1, y2: box.y2 + 3, z2: box.z2 + 1 })
  log('build', `job "${name}" at ${move.fmt(origin)}: ${cells.length} blocks, box ${box.x1}..${box.x2} ${box.y1}..${box.y2} ${box.z1}..${box.z2}`)
  site = loadSite(job)
  if (!site) ensureSnapshot(bot) // at once when the chunks are here; else before any work starts
  return job
}

function cellDone (bot, c) {
  const b = world.at(bot, c.x, c.y, c.z)
  if (!b) return null // unloaded = unknown
  if (c.clear) return world.isAirish(b) || /(_bed|^chest|^furnace|^crafting_table|^barrel|torch|lantern|_carpet)$/.test(b.name)
  if (!nameOk(c, b.name)) return false
  const w = wantOf(c)
  if (!w) return true
  let p
  try { p = b.getProperties() } catch { return true }
  for (const k in w) {
    if (k === 'axis' && axisRelaxed(c)) continue
    if (p[k] != null && String(p[k]) !== w[k]) return false
  }
  return true
}
// Logs that could not be placed with the blueprint's axis (no block on that side to click, too high for a
// support pillar from the ground) go in with whatever axis works - remembered, so they count as done.
function axisRelaxed (c) { return ((mem.get().axisRelaxed || []).includes(key(c))) }
function relaxAxis (c) { mem.update(m => { m.axisRelaxed = m.axisRelaxed || []; if (!m.axisRelaxed.includes(key(c))) m.axisRelaxed.push(key(c)) }) }

// The block a cell hangs on / stands on is there (and, when that is a cell of the build, finished - a torch
// on the filler a wrong cell holds pops off when the builder replaces it).
function supportThere (bot, c) {
  if (!c.sup) return true
  const s = world.at(bot, c.sup.x, c.sup.y, c.sup.z)
  if (!s || !world.isSolid(s)) return false
  const sc = job && job.index.get(key(c.sup))
  return !sc || cellDone(bot, sc) === true
}
// The cell holds its material, only the wrong way round: digging it out hands the item back.
function rightMaterialThere (bot, c) { const b = world.at(bot, c.x, c.y, c.z); return !!b && nameOk(c, b.name) }

// The unfinished cells that hold the band up: attached cells (torches, lanterns...) and door upper halves
// never count as "the lowest unfinished" - they go in when what they hang on stands.
function lowestStructural (todo) {
  let m = Infinity
  for (const c of todo) if (!c.attach && !c.doorUpper && c.y < m) m = c.y
  return m
}

// Remaining work, from the world. Counts unknown (unloaded) cells as remaining. `need` is ITEMS still to
// place, keyed by the blueprint's own item (wall_torch -> torch, grass -> dirt, a door once).
function status (bot) {
  if (!job) return null
  let done = 0; let unknown = 0
  const md = world.data(bot)
  const need = {}
  for (const c of job.cells) {
    const d = cellDone(bot, c)
    if (d === true) { done++; continue }
    if (d === null) unknown++
    const it = itemOf(c, md)
    if (!it || (d === false && rightMaterialThere(bot, c))) continue
    need[it] = (need[it] || 0) + 1
  }
  return { name: job.name, total: job.cells.length, done, unknown, need }
}
// Items for the cells from the lowest unfinished layer up to `layers` above it (the window the builder
// works in), plus attached cells whose support already stands. Same keying as status().need.
function nextNeeds (bot, layers = 4) {
  if (!job) return {}
  const md = world.data(bot)
  const todo = job.cells.filter(c => !c.doorUpper && cellDone(bot, c) !== true)
  const minY = lowestStructural(todo)
  const out = {}
  for (const c of todo) {
    if (c.attach ? !(c.y <= minY + layers || supportThere(bot, c)) : c.y > minY + layers) continue
    const it = itemOf(c, md)
    if (!it || rightMaterialThere(bot, c)) continue
    out[it] = (out[it] || 0) + 1
  }
  return out
}
function cellsDone (bot) { if (!job) return false; for (const c of job.cells) if (cellDone(bot, c) !== true) return false; return true }

// Blocks inside the footprint (above the base layer) that are not part of the schematic.
function obstructions (bot, { maxY = Infinity } = {}) {
  const out = []
  const { box } = job
  for (let y = Math.min(box.y2 + 2, maxY); y >= box.y1 + 1; y--) for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) {
    if (job.index.has(key({ x, y, z }))) { // a schematic cell holding the wrong block
      const c = job.index.get(key({ x, y, z }))
      const b = world.at(bot, x, y, z)
      if (b && !world.isAirish(b) && !world.isWaterBlock(b) && !nameOk(c, b.name)) out.push(b)
      continue
    }
    const b = world.at(bot, x, y, z)
    if (!b || world.isAirish(b) || world.isWaterBlock(b) || world.isLavaBlock(b)) continue
    // above the ground layers a dirt/granite block outside the castle's cells is our own scaffold or a
    // pathfinder pillar - not an obstruction (each castle cycle tore down the supports the build then put back);
    // removeScaffold takes them away when the castle is done
    if (y >= box.y1 + 3 && SCAFFOLD_RE.test(b.name)) continue
    // and at any height, a block the snapshot says went where the site was open is our own scaffold (a pathfinder
    // foothold): the finish takes it down. Counted as an obstruction, the clearing dug it and the next walk put it
    // back - "clearing 3 blocks (321 obstructions)" round after round for 10 minutes (2026-09-23)
    if (site && isStray(bot, x, y, z)) continue
    out.push(b)
  }
  return out
}

function inBox (p, pad = 0) { const b = job.box; return p.x >= b.x1 - pad && p.x <= b.x2 + pad && p.z >= b.z1 - pad && p.z <= b.z2 + pad && p.y >= b.y1 - pad && p.y <= b.y2 + pad + 3 }

// Movements for work inside the site: may dig terrain and scaffold there, but never a block that
// already matches the schematic.
const GROUND_RE = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|gravel|sand|red_sand|sandstone|stone|granite|diorite|andesite|tuff|deepslate|calcite|dripstone_block|moss_block)$/
function siteMovements (bot, { place = true, dig = true } = {}) {
  // finished blocks of every build are protected by move's registered protector (one rule, all walks)
  const m = move.movementsFor(bot, { dig: !!dig, place, allowZones: ['build', 'base'] })
  // dig 'noGround' (a finished site): leaves and the like may still be cut (with no digging at all the bot was
  // trapped in the canopy beside the transept), but never the earth and rock the building stands on
  if (dig === 'noGround') { const md = world.data(bot); for (const b of Object.values(md.blocksByName)) if (GROUND_RE.test(b.name)) m.blocksCantBreak.add(b.id) }
  return m
}

// dig: false once every block stands - the finish walks tunnelled through the ground UNDER the nave floor to reach
// scaffold (the bot was found at y69 beneath its own church, 2026-09-23): a finished site is walked, not dug
async function goSite (bot, goal, label, { place = true, dig = (job && job.cells.every(c => cellDone(bot, c) === true)) ? 'noGround' : true, doors = true } = {}) {
  // move.goTo builds its own Movements; for site work use pathfinder directly through runGoal
  // leaving the safehouse first: the planner never routes through its door
  if (move.insideHut(bot.entity.position.floored())) await move.crossDoor(bot, goal).catch(e => log('build', `door crossing threw: ${e.message}`))
  const r = await move.runGoal(bot, goal, { timeoutMs: 30000, stuckMs: 8000, movements: siteMovements(bot, { place, dig }) })
  if (!r.ok && r.why === 'interrupted') { await reflex.waitClear(); return move.runGoal(bot, goal, { timeoutMs: 30000, stuckMs: 8000, movements: siteMovements(bot, { place, dig }) }) }
  if (doors && !r.ok && r.why !== 'died') { const d = await viaDoor(bot, goal, siteMovements(bot, { place, dig })); if (d) return d }
  return r
}

// The planner never walks through a door (mineflayer-pathfinder opens fence gates only; a door is solid to it, open or
// shut): the church's inside was unreachable, 45 scaffold blocks in the nave "stuck" day after day (2026-09-23). A
// player goes round to the door: walk to its near step, cross it by hand (move.crossDoor), then walk on.
async function viaDoor (bot, goal, movements) {
  if (!job) return null
  const gp = goal && goal.x != null ? { x: goal.x, y: goal.y, z: goal.z } : null
  if (!gp) return null
  const me = bot.entity.position
  const doors = job.cells.filter(c => /_door$/.test(c.name) && !c.doorUpper && c.props && /^(north|south|east|west)$/.test(c.props.facing) && cellDone(bot, c) === true)
    // the ground-floor entrances first (the way in a player takes), then the upper doors
    .sort((a, b) => ((a.y > job.box.y1 + 1) - (b.y > job.box.y1 + 1)) || (world.dist3(me, a) + world.dist3(a, gp)) - (world.dist3(me, b) + world.dist3(b, gp)))
  for (const d of doors.slice(0, 3)) {
    const alongZ = d.props.facing === 'north' || d.props.facing === 'south'
    const sides = alongZ ? [{ x: d.x, y: d.y, z: d.z - 1 }, { x: d.x, y: d.y, z: d.z + 1 }] : [{ x: d.x - 1, y: d.y, z: d.z }, { x: d.x + 1, y: d.y, z: d.z }]
    const near = sides.sort((a, b) => world.dist3(me, a) - world.dist3(me, b))[0]
    // (the bot's everyday walker, with its own recoveries: the site runGoal got "stuck" in the canopy every time)
    const r0 = await move.travel(bot, near, { range: 1, label: 'to the door', maxMs: 90000 })
    if (!r0.ok) { log('build', `couldn't get to the ${d.name.replace('_door', '')} door at ${move.fmt(d)} (${r0.why})`); continue }
    if (!await move.crossDoor(bot, goal).catch(() => false)) continue
    log('build', `went through the ${d.name.replace('_door', '')} door at ${move.fmt(d)} toward ${move.fmt(gp)}`)
    return move.runGoal(bot, goal, { timeoutMs: 30000, stuckMs: 8000, movements })
  }
  return null
}

// Obstructions we could not reach twice are left for the end (scaffold cleanup reaches from the
// finished walls) instead of stalling the whole site on a leaf 12 blocks up.
const clearFails = new Map()
function skippedObstruction (b) { return (clearFails.get(key(b.position)) || 0) >= 2 }
function unskippedObstructions (bot, opts) { return obstructions(bot, opts).filter(b => !skippedObstruction(b)) }

async function clearSite (bot, { shouldStop, maxBlocks = 400, maxY = Infinity, finishing = false, leaves: takeLeaves = true } = {}) {
  // the snapshot of the untouched site comes first: after the first dig it can't be had any more
  if (!ensureSnapshot(bot)) return 0
  let cleared = 0
  for (let pass = 0; pass < 3; pass++) {
    const all = unskippedObstructions(bot, { maxY })
    if (!all.length) break
    // trees first: cut the trunks and the leaves decay by themselves; leaves are dug by hand only
    // when they are still there well after the last trunk came down
    const logs = all.filter(b => world.LOG_RE.test(b.name))
    // a leaf only matters where a block goes (walking cuts through the rest; stragglers are tidied
    // when the build is finished)
    const leaves = all.filter(b => world.LEAF_RE.test(b.name) && (finishing || job.index.has(key(b.position))))
    const rest = all.filter(b => !world.LOG_RE.test(b.name) && !world.LEAF_RE.test(b.name))
    let obs
    if (logs.length) { obs = logs.sort((a, b) => a.position.y - b.position.y); mem.set('siteLogsAt', Date.now()) } else if (rest.length) obs = rest
    else if (!takeLeaves) return cleared
    else if (Date.now() - (mem.get().siteLogsAt || 0) > 4 * 60000) obs = leaves
    else { log('build', `${leaves.length} leaves left on the site - letting them decay`); return cleared }
    if (!obs.length) break
    log('build', `clearing ${obs.length} ${logs.length ? 'logs' : (rest.length ? 'blocks' : 'leftover leaves')} from the site (${all.length} obstructions in all)`)
    for (const b of obs) {
      if (shouldStop && shouldStop()) return cleared
      if (cleared >= maxBlocks) return cleared
      await reflex.waitClear()
      const cur = world.at(bot, b.position.x, b.position.y, b.position.z)
      if (!cur || world.isAirish(cur) || world.isWaterBlock(cur)) continue
      if (!act.reach(bot, cur.position, 4.3)) {
        // a leaf is taken only from where a walk gets us: towering up into a canopy for leaves put up more dirt
        // than the finish could take down (scaffold 148 -> 172 while "clearing 331 leftover leaves", 2026-09-23)
        const r = await goSite(bot, new goals.GoalLookAtBlock(cur.position, bot.world, { reach: 4 }), 'clear', { place: !world.LEAF_RE.test(cur.name) })
        if (!r.ok && !act.reach(bot, cur.position, 5)) { clearFails.set(key(cur.position), (clearFails.get(key(cur.position)) || 0) + 1); continue }
      }
      // (a wrong block in one of our cells is ours to take out; `own` lets it past the finished-block guard
      //  when it is the right material the wrong way round)
      if (await act.dig(bot, cur.position, { force: true, own: job.index.has(key(cur.position)), allowZones: ['build', 'base'], timeoutMs: 15000 })) cleared++
      else clearFails.set(key(cur.position), (clearFails.get(key(cur.position)) || 0) + 1)
      if (inv.freeSlots(bot) <= 1) await base().tossJunk(bot)
    }
    await act.collectDrops(bot, { radius: 10, maxMs: 8000 })
  }
  if (cleared) surveyCache = null
  return cleared
}

// Other build jobs (the hut) register here so site movement never breaks their finished blocks.
const extraJobs = new Map()
function registerJob (name, j) { if (j) extraJobs.set(name, j); else extraJobs.delete(name) }
function allJobs () { const out = [...extraJobs.values()]; if (job) out.push(job); return out }
// A finished block of any build (the right material in its cell) is never broken: not by a walk, not by
// any dig (act.dig asks this). One exception for digs: the safehouse's door cell is opened and sealed
// every day (its seal block, a rehung door) - it stays protected from walks only.
move.setProtector((block, purpose) => {
  for (const j of allJobs()) {
    const c = j.index.get(key(block.position))
    if (!c || c.clear) continue
    if (purpose === 'dig' && c.door && j !== job) continue
    if (nameOk(c, block.name)) return true
  }
  return false
})

// The item to place for a cell: its exact item, the preferred species, or any held stand-in.
function pickItem (bot, c, items = inv.items(bot)) {
  const want = c.item !== undefined ? c.item : c.name
  if (!want) return null
  const exact = items.find(i => i.name === want)
  if (exact) return exact
  if (c.prefer) for (const n of c.prefer) { const it = items.find(i => i.name === n); if (it) return it }
  const alt = c.item !== undefined ? c.itemAlt : c.alt
  return alt ? (items.find(i => alt.test(i.name)) || null) : null
}

// A support block for a cell that has nothing to be clicked against. In mid-air a single filler has
// nothing to attach to either (an x-axis log in a wall needs a neighbour on its x side, where there is
// only air): stand a thin pillar up from the ground to it. Every block is scaffold: the snapshot diff
// finds it at the end (mem.scaffold is only a hint).
async function placeSupport (bot, sp, j) {
  const fillerName = () => { const f = inv.items(bot).find(i => FILLER_ITEMS.test(i.name)); return f && f.name }
  if (!fillerName()) return false
  const record = p => mem.update(m => { m.scaffold = m.scaffold || []; m.scaffold.push({ x: p.x, y: p.y, z: p.z }) })
  // 1) straight on: any solid neighbour of the support cell will do (usually the wall we are building)
  const hasNeighbour = ALL_FACES.some(([dx, dy, dz]) => { const nb = world.at(bot, sp.x + dx, sp.y + dy, sp.z + dz); return nb && world.isSolid(nb) })
  if (hasNeighbour) {
    if (await act.place(bot, sp, fillerName(), { allowZones: ['build', 'base'] })) { record(sp); return true }
  }
  // 2) nothing to hang it on: a thin pillar up from whatever is below, however far that is (a fixed cap left
  //    the upper logs with no support at all). 30 is only a guard against building into open void.
  const column = [sp]
  let grounded = false
  for (let y = sp.y - 1; y > sp.y - 30; y--) {
    const b = world.at(bot, sp.x, y, sp.z)
    if (!b) return false
    if (world.isSolid(b)) { grounded = true; break }
    if (j.index.has(key({ x: sp.x, y, z: sp.z }))) return false // a build cell below: that goes in first
    column.unshift({ x: sp.x, y, z: sp.z })
  }
  if (!grounded) return false
  for (const p of column) {
    const cur = world.at(bot, p.x, p.y, p.z)
    if (cur && world.isSolid(cur)) continue
    const n = fillerName()
    if (!n) return false
    if (!await act.place(bot, p, n, { allowZones: ['build', 'base'], faceHint: [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] })) return false
    record(p)
  }
  return true
}

// Can this plan be clicked now (a solid, clickable block where it says)?
function refOk (bot, c, p) {
  const nb = world.at(bot, c.x + p.off[0], c.y + p.off[1], c.z + p.off[2])
  return !!nb && world.isSolid(nb) && !act.NO_REF_RE.test(nb.name)
}
function stateOf (b) { try { const p = b.getProperties(); const s = KEY_PROPS.filter(k => p[k] != null).map(k => `${k}=${p[k]}`).join(','); return b.name + (s ? `[${s}]` : '') } catch { return b.name } }

async function placeCell (bot, c, j = job) {
  const pos = new Vec3(c.x, c.y, c.z)
  const own = { force: true, own: true, allowZones: ['build', 'base'], timeoutMs: 15000 }
  if (c.clear) {
    // a cell that must be empty: dig out whatever is in it
    if (cellDone(bot, c)) return true
    return act.dig(bot, pos, own)
  }
  // a door's upper half comes with its lower half - never placed on its own
  if (c.doorUpper) return cellDone(bot, c) === true
  let cur = bot.blockAt(pos)
  if (!cur) return false
  if (cellDone(bot, c)) return true
  // attached things wait for what they hang on (not a failure - buildStep doesn't pick them until then)
  if (c.attach && !supportThere(bot, c)) return false
  // whatever is in our cell that isn't the finished block comes out - a wrong block, or the right one the
  // wrong way round (our own cell: the one dig allowed past the finished-block guard)
  if (!world.isAirish(cur) && !world.isWaterBlock(cur) && !act.PLANT_RE.test(cur.name)) {
    if (!await act.dig(bot, pos, own)) return false
    cur = bot.blockAt(pos)
  }
  // a door needs its upper cell clear (a scaffold block in it, a leaf)
  if (c.doorLower) {
    const up = world.at(bot, c.x, c.y + 1, c.z)
    if (up && !world.isAirish(up) && !world.isWaterBlock(up)) { if (!await act.dig(bot, up.position, own)) return false }
  }
  // after three failures with its own axis, a log takes any face
  if (c.want && c.want.axis && !axisRelaxed(c) && failsOf(c) >= 3) { relaxAxis(c); log('build', `${c.name} at ${move.fmt(c)} goes in with any axis (nothing to place it against on its own side)`) }
  const plans = plansFor(c)
  if (!plans.length) return false
  // is there something to click?
  if (!plans.some(p => refOk(bot, c, p))) {
    if (c.attach) return false
    // temporary support on any face the cell can be clicked from: not a cell of the build, not where we
    // stand (only ever trying the first face put the support into the bot's own head, 4 minutes of
    // "blockUpdate did not fire")
    const filler = inv.items(bot).find(i => FILLER_ITEMS.test(i.name))
    if (!filler) return false
    const me = bot.entity.position.floored()
    let supported = false
    for (const p of plans) {
      const sp = { x: c.x + p.off[0], y: c.y + p.off[1], z: c.z + p.off[2] }
      if (j.index.has(key(sp))) continue
      if (sp.x === me.x && sp.z === me.z && (sp.y === me.y || sp.y === me.y + 1)) continue
      const spb = world.at(bot, sp.x, sp.y, sp.z)
      if (!spb || !(world.isAirish(spb) || world.isWaterBlock(spb))) continue
      if (await placeSupport(bot, sp, j)) { supported = true; break }
    }
    if (!supported) return false
  }
  const item = pickItem(bot, c)
  if (!item) return false
  const usable = plans.filter(p => refOk(bot, c, p))
  if (!act.reach(bot, pos, 4.3)) {
    const r = await goSite(bot, new goals.GoalPlaceBlock(pos, bot.world, { range: 4, faces: usable.map(p => new Vec3(p.off[0], p.off[1], p.off[2])), LOS: true }), 'place')
    if (!r.ok && !act.reach(bot, pos, 4.8)) return false
  }
  const ok = await act.place(bot, c, item.name, { plans: usable.length ? usable : plans, accept: b => nameOk(c, b.name), allowZones: ['build', 'base'], sneak: !c.doorLower && !/_door$/.test(item.name), tall: !!c.doorLower })
  if (!ok) return false
  surveyCache = null
  if (cellDone(bot, c) === true) return true
  // placed, but not what the blueprint shows: out again (our own cell), and the failure counts
  const b = bot.blockAt(pos)
  log('build', `${c.name} at ${move.fmt(c)} came out ${b ? stateOf(b) : '?'} (want ${JSON.stringify(c.want || wantOf(c))}) - taking it out again`)
  await act.dig(bot, pos, own)
  return false
}

// Place as much as the pack allows. Returns {placed, blockedOn: item|null, done}.
// cells that keep failing rest a while - across build steps (a fresh map per step retried the same
// unplaceable cell every call)
const cellFails = new Map() // key -> {n, at}
function failsOf (c) { const f = cellFails.get(key(c)); return f ? f.n : 0 }
async function buildStep (bot, { shouldStop, maxMs = 10 * 60000 } = {}) {
  const t0 = Date.now()
  let placed = 0
  if (!ensureSnapshot(bot)) return { placed, blockedOn: null, done: false }
  const md = world.data(bot)
  const failed = { get: k => { const f = cellFails.get(k); return f && Date.now() - f.at < 5 * 60000 ? f.n : 0 }, set: (k, n) => cellFails.set(k, { n, at: Date.now() }) }
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const todo = job.cells.filter(c => !c.doorUpper && cellDone(bot, c) !== true && (failed.get(key(c)) || 0) < 3)
    if (!todo.length) return { placed, blockedOn: null, done: cellsDone(bot) }
    // the band: attached cells and door tops never hold it down (a lantern under a roof slab waits for the
    // roof; the walls below it must not wait for the lantern)
    const lowestAll = lowestStructural(todo)
    const items = inv.items(bot)
    const has = c => !!pickItem(bot, c, items)
    // what the band is really held up by: a structural cell of the lowest layers first. A carpet or a pot holds
    // nothing up - reported first, the director chased unreachable sheep for "red_carpet" while two granite stairs
    // and twelve panes (sand) were what kept the walls from rising (2026-09-23)
    const missingItem = () => {
      const low = todo.filter(c => !c.attach && !c.doorUpper && c.y <= lowestAll + 1).find(c => !has(c))
      const m = low || todo.filter(c => c.attach && supportThere(bot, c)).find(c => !has(c))
      return m ? itemOf(m, md) : null
    }
    // the lowest two layers of what we HAVE the blocks for: 24 missing glass panes in a wall no longer hold up
    // every brick above them (the windows go in when the glass comes)
    const structural = todo.filter(c => !c.attach && has(c))
    const attached = todo.filter(c => c.attach && has(c) && supportThere(bot, c))
    const minY = structural.length ? Math.min(...structural.map(c => c.y)) : Infinity
    // no more than 3 layers above the lowest unfinished cell: walls rise together, nothing floats far up
    let doable = minY <= lowestAll + 3 ? structural.filter(c => c.y <= minY + 1) : []
    // a door goes in once its floor stands (and its own two cells are ours to clear)
    doable = doable.filter(c => !c.doorLower || supportThere(bot, c)).concat(attached)
    if (!doable.length) return { placed, blockedOn: missingItem(), done: false }
    const me = bot.entity.position
    // cells that can be clicked right now first; one whose every face is another unbuilt cell of this
    // build waits for its neighbours (trying it costs ~20s of failed placing, and a wall of x-axis logs
    // placed out of order was nothing but failures)
    const clickable = c => plansFor(c).some(p => refOk(bot, c, p))
    const supportable = c => !c.attach && !c.doorLower && plansFor(c).some(p => !job.index.has(key({ x: c.x + p.off[0], y: c.y + p.off[1], z: c.z + p.off[2] })))
    const ready = doable.filter(c => clickable(c) || supportable(c))
    if (!ready.length) return { placed, blockedOn: null, done: false }
    ready.sort((a, b) => (clickable(b) - clickable(a)) * 100 + (a.y - b.y) * 4 + world.dist3(a, me) - world.dist3(b, me))
    const c = ready[0]
    const ok = await placeCell(bot, c)
    if (ok) { placed++; cellFails.delete(key(c)); if (placed % 25 === 0) { const st = status(bot); log('build', `${st.done}/${st.total} placed`) } } else { failed.set(key(c), (failed.get(key(c)) || 0) + 1); if (failed.get(key(c)) >= 3) log('build', `${c.name} at ${move.fmt(c)} won't place - leaving it for later`) }
  }
  return { placed, blockedOn: null, done: false }
}

// ---- the site as it was: snapshot, scaffold, holes -------------------------------------------------
// Before the first block is dug or placed, the region round the footprint is recorded to a file next to
// memory (once - it survives restarts). Afterwards scaffold is whatever the bot left standing where the
// site was open, and a hole is ground the site work took away.
let site = null // { name, origin, region, palette: [names], layers: [string per y, one char per (z,x)] }
function siteRegion (j) { const b = j.box; return { x1: b.x1 - SITE_PAD, x2: b.x2 + SITE_PAD, z1: b.z1 - SITE_PAD, z2: b.z2 + SITE_PAD, y1: b.y1 - 2, y2: b.y2 + SITE_PAD } }
function siteFile (j) { return path.join(path.dirname(mem.FILE), `site-${String(j.name).replace(/[^A-Za-z0-9_-]/g, '_')}-${j.origin.x}_${j.origin.y}_${j.origin.z}.json`) }
function loadSite (j) {
  try {
    const s = JSON.parse(fs.readFileSync(siteFile(j), 'utf8'))
    const r = siteRegion(j)
    if (s && s.region && ['x1', 'x2', 'y1', 'y2', 'z1', 'z2'].every(k => s.region[k] === r[k])) return s
  } catch {}
  return null
}
// The region is ~45k blocks: scans read the state id straight from the chunk (no Block object per cell),
// so a look at the whole site costs a few ms, not a tick. null = chunk not loaded.
function kindAt (bot, x, y, z) {
  const w = bot.world
  if (!w || !w.getColumnAt || !w.getBlockStateId) { const b = world.at(bot, x, y, z); return b ? { name: b.name, boundingBox: b.boundingBox } : null }
  const v = new Vec3(x, y, z)
  if (!w.getColumnAt(v)) return null
  return world.data(bot).blocksByStateId[w.getBlockStateId(v)] || null
}
let snapWaitLog = 0
function ensureSnapshot (bot) {
  if (!job) return false
  if (site) return true
  const r = siteRegion(job)
  const palette = []; const pidx = new Map(); const layers = []
  for (let y = r.y1; y <= r.y2; y++) {
    let row = ''
    for (let z = r.z1; z <= r.z2; z++) {
      for (let x = r.x1; x <= r.x2; x++) {
        const b = kindAt(bot, x, y, z)
        if (!b) {
          // every chunk of the region, or none of it: a half snapshot would call real terrain scaffold
          if (Date.now() - snapWaitLog > 60000) { snapWaitLog = Date.now(); log('build', `site snapshot waits: ${x},${y},${z} not loaded - no site work until it is`) }
          return false
        }
        let i = pidx.get(b.name)
        if (i === undefined) { i = palette.length; palette.push(b.name); pidx.set(b.name, i) }
        row += String.fromCharCode(48 + i)
      }
    }
    layers.push(row)
  }
  site = { name: job.name, origin: job.origin, region: r, palette, layers, at: new Date().toISOString() }
  try { fs.writeFileSync(siteFile(job), JSON.stringify(site)) } catch (e) { log('build', `couldn't write the site snapshot: ${e.message}`) }
  log('build', `site snapshot taken: ${(r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1) * (r.z2 - r.z1 + 1)} blocks, ${palette.length} kinds -> ${path.basename(siteFile(job))}`)
  return true
}
function snapName (x, y, z) {
  if (!site) return undefined
  const r = site.region
  if (x < r.x1 || x > r.x2 || y < r.y1 || y > r.y2 || z < r.z1 || z > r.z2) return undefined
  return site.palette[site.layers[y - r.y1].charCodeAt((z - r.z1) * (r.x2 - r.x1 + 1) + (x - r.x1)) - 48]
}
// open before the work: nothing solid there (air, plants, water), or a tree - the site work took those away
function wasOpen (bot, name) {
  if (name == null) return false
  const b = world.data(bot).blocksByName[name]
  return !b || b.boundingBox !== 'block' || world.LEAF_RE.test(name) || world.LOG_RE.test(name) || world.WATER_RE.test(name) || world.LAVA_RE.test(name)
}
// ground before the work: solid natural earth/rock (not a tree)
function wasGround (bot, name) {
  if (name == null) return false
  const b = world.data(bot).blocksByName[name]
  return !!b && b.boundingBox === 'block' && world.NATURAL_RE.test(name) && !world.LEAF_RE.test(name) && !world.LOG_RE.test(name)
}
// Places that belong to someone else's work and are never scaffold or holes: the base (hut, furniture), the
// farm plot, any other build's cells, the mine's stairs.
function othersWork (p) {
  const z = move.inZone(p, 1)
  if (z && z.label === 'base') return true
  for (const [, j] of extraJobs) if (j.index.has(key(p)) || (j.box && p.x >= j.box.x1 - 1 && p.x <= j.box.x2 + 1 && p.z >= j.box.z1 - 1 && p.z <= j.box.z2 + 1 && p.y >= j.box.y1 - 2 && p.y <= j.box.y2 + 1)) return true
  const m = mem.get()
  const f = m.farm && m.farm.water
  if (f && Math.abs(p.x - f.x) <= 5 && Math.abs(p.z - f.z) <= 5 && p.y >= f.y - 1 && p.y <= f.y + 2) return true
  const mine = m.mine
  if (mine && mine.entrance) {
    const a = mine.entrance; const b = mine.cursor || a
    if (p.x >= Math.min(a.x, b.x) - 2 && p.x <= Math.max(a.x, b.x) + 2 && p.z >= Math.min(a.z, b.z) - 2 && p.z <= Math.max(a.z, b.z) + 2 && p.y >= Math.min(a.y, b.y) - 1 && p.y <= Math.max(a.y, b.y) + 3) return true
  }
  return false
}
// Scaffold = in the region, not a cell of the build, not someone else's work, where the site was open, and
// now a block the bot stands on / props with (filler) or anything crafted. Natural terrain that was there is
// never touched; a filler block where there was ground is ground given back (a filled hole), not scaffold.
function isStray (bot, x, y, z, k = kindAt(bot, x, y, z)) {
  if (!k) return false
  const n = k.name
  if (/air$/.test(n) || world.WATER_RE.test(n) || world.LAVA_RE.test(n) || FURNITURE_RE.test(n)) return false
  if (!(STRAY_RE.test(n) || (!world.NATURAL_RE.test(n) && k.boundingBox === 'block'))) return false
  const p = { x, y, z }
  if (job.index.has(key(p))) return false
  const was = snapName(x, y, z)
  return was !== n && wasOpen(bot, was) && !othersWork(p)
}
function scaffoldList (bot) {
  if (!job || !site) return []
  const r = site.region; const out = []
  for (let y = r.y2; y >= r.y1; y--) for (let z = r.z1; z <= r.z2; z++) for (let x = r.x1; x <= r.x2; x++) {
    const k = kindAt(bot, x, y, z)
    if (isStray(bot, x, y, z, k)) out.push({ x, y, z, name: k.name, was: snapName(x, y, z) })
  }
  return out
}
// Holes: ground the site work took away, outside the blueprint's own space (inside the footprint at and
// above its base layer the blueprint says what goes where).
function holesList (bot) {
  if (!job || !site) return []
  const r = site.region; const bx = job.box; const out = []
  for (let y = r.y1; y <= r.y2; y++) for (let z = r.z1; z <= r.z2; z++) for (let x = r.x1; x <= r.x2; x++) {
    if (y >= bx.y1 && x >= bx.x1 && x <= bx.x2 && z >= bx.z1 && z <= bx.z2) continue
    // under the floor the building stands on: sealed in, out of sight, and only reachable by breaking the floor
    // ("filled 0 of 73 holes" - the ground dug out from under the nave before the gatherer kept off it, 2026-09-23)
    if (x >= bx.x1 && x <= bx.x2 && z >= bx.z1 && z <= bx.z2 && job.index.has(key({ x, y: bx.y1, z }))) continue
    const k = kindAt(bot, x, y, z)
    if (!k || (k.boundingBox === 'block' && !world.WATER_RE.test(k.name)) || world.LAVA_RE.test(k.name)) continue
    const was = snapName(x, y, z)
    if (!wasGround(bot, was) || othersWork({ x, y, z })) continue
    out.push({ x, y, z, was })
  }
  return out
}

// Leftovers that failed three times today rest until tomorrow (a Minecraft day): the site is not declared
// finished with them - the director comes back for them the next day.
const leftovers = new Map() // key -> { n, day }
function today (bot) { return (bot.time && typeof bot.time.day === 'number') ? bot.time.day : Math.floor(Date.now() / 1200000) }
function resting (bot, p) { const l = leftovers.get(key(p)); return !!l && l.n >= 3 && l.day === today(bot) }
function failLeftover (bot, p) { const l = leftovers.get(key(p)); const d = today(bot); leftovers.set(key(p), { n: l && l.day === d ? l.n + 1 : 1, day: d }) }

// Take down every scaffold block, top-down. A block out of reach is walked to with the planner allowed to
// tower (its tower is new scaffold, found by the next pass); standing on a pillar, the pillar is dug from
// under our own feet a block at a time (how a player takes one down). Bounded: 4 passes, 3 tries per
// block a day; what is left is logged with coordinates.
async function removeScaffold (bot, { shouldStop, maxPasses = 4 } = {}) {
  if (!job) return 0
  let removed = 0
  const dig = (p, noWalk = false) => act.dig(bot, p, { force: true, allowZones: ['build', 'base'], timeoutMs: 10000, noWalk, reachMax: noWalk ? 5 : 4.3 })
  if (!site) {
    // no snapshot (a job set before snapshots): the remembered placements and filler in the footprint
    for (const p of (mem.get().scaffold || []).slice()) {
      const b = world.at(bot, p.x, p.y, p.z)
      if (b && SCAFFOLD_RE.test(b.name) && !job.index.has(key(p)) && await act.dig(bot, p, { force: true, allowZones: ['build', 'base'] })) removed++
    }
    mem.update(m => { m.scaffold = [] })
    if (removed) log('build', `removed ${removed} scaffold blocks (no site snapshot - remembered ones only)`)
    return removed
  }
  const isScaf = p => isStray(bot, p.x, p.y, p.z)
  for (let pass = 0; pass < maxPasses; pass++) {
    const list = scaffoldList(bot).filter(p => !resting(bot, p))
    if (!list.length) break
    const me0 = bot.entity.position
    // nearest first (top-down within a column): highest-first sent the bot towering up the outside of the transept
    // for one block at y77 and it stuck there in the canopy, pass after pass (2026-09-23)
    list.sort((a, b) => (a.x === b.x && a.z === b.z) ? b.y - a.y : world.dist3(a, me0) - world.dist3(b, me0))
    if (pass === 0) log('build', `taking down ${list.length} scaffold blocks`)
    let got = 0
    const queue = list.slice()
    while (queue.length) {
      await new Promise(r => setImmediate(r))
      if (shouldStop && shouldStop()) return removed
      await reflex.waitClear()
      // standing on scaffold: that block first, from under our own feet (a drop of one)
      const feet = bot.entity.position.floored()
      const under = { x: feet.x, y: feet.y - 1, z: feet.z }
      if (bot.entity.onGround && isScaf(under) && !resting(bot, under) && safeDrop(bot, under)) {
        if (await dig(under, true)) { removed++; got++; await landed(bot) } else failLeftover(bot, under)
        continue
      }
      const p = queue.shift()
      if (!isScaf(p) || resting(bot, p)) continue
      if (!act.reach(bot, p, 4.3)) {
        // (near enough, not look-at: the look-at raycast through pews and pillars "stuck" at 5-6b; the server checks distance)
        // a short walk first; then the pillar from the ground beside it; the church door only for what is inside
        let r = await goSite(bot, new goals.GoalNear(p.x, p.y, p.z, 3), 'scaffold', { doors: false })
        if (!r.ok && !act.reach(bot, p, 4.8)) {
          if (await reachByPillar(bot, p, { shouldStop })) { removed++; got++; continue }
          r = (await viaDoor(bot, new goals.GoalNear(p.x, p.y, p.z, 3), siteMovements(bot, { dig: 'noGround' }))) || r
        }
        if (!r.ok && !act.reach(bot, p, 4.8)) {
          log('build', `scaffold ${move.fmt(p)}: couldn't get within reach (${r.why}, ${world.dist3(bot.entity.position, p).toFixed(1)}b off, from ${move.fmt(bot.entity.position)})`); failLeftover(bot, p); continue
        }
      }
      // within a player's reach after the walk: dig from here (act.dig's stricter 4.3 walked again, 20s a block)
      if (await dig(p, act.reach(bot, p, 5))) { removed++; got++ } else { log('build', `scaffold ${move.fmt(p)}: the dig failed (${world.dist3(bot.entity.position, p).toFixed(1)}b off)`); failLeftover(bot, p) }
      if (inv.freeSlots(bot) <= 1) await base().tossJunk(bot)
    }
    await act.collectDrops(bot, { radius: 10, maxMs: 8000 })
    if (!got) break
  }
  // the hint list only ever shrinks to what is still standing
  mem.update(m => { m.scaffold = (m.scaffold || []).filter(p => { const b = world.at(bot, p.x, p.y, p.z); return !b || (!world.isAirish(b) && SCAFFOLD_RE.test(b.name)) }) })
  surveyCache = null
  const left = scaffoldList(bot)
  if (removed) log('build', `removed ${removed} scaffold blocks`)
  if (left.length) log('build', `${left.length} scaffold blocks still standing (tried again tomorrow if they failed 3x): ${left.slice(0, 20).map(p => `${p.name}@${p.x},${p.y},${p.z}`).join(' ')}`)
  return removed
}
// Digging the block under us drops us to the next solid block: only while that is a short, dry fall.
// A stray block high on the building that no walk gets near: stand on solid ground within two blocks of it, pillar
// straight up until it is in reach, dig it, then dig the pillar back down from the top - the player's way, with no
// route over the roofs (the planner towered onto the transept roof and stuck in the canopy pass after pass, 48
// blocks left standing, 2026-09-23). Returns true if the block is gone.
async function reachByPillar (bot, p, { shouldStop } = {}) {
  const me = bot.entity.position
  const cands = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (!dx && !dz) continue
    const x = p.x + dx; const z = p.z + dz
    for (let y = p.y; y >= p.y - 8; y--) {
      if (!world.standable(bot, x, y, z)) continue
      let clear = true // the column we will stand in, from our feet up past the target's height
      for (let yy = y; yy <= p.y + 1; yy++) { const b = world.at(bot, x, yy, z); if (!b || !world.isAirish(b)) { clear = false; break } }
      if (clear) cands.push({ x, y, z, d: world.dist3(me, { x, y, z }) + (p.y - y) * 2 })
      break
    }
  }
  cands.sort((a, b) => a.d - b.d)
  for (const c of cands.slice(0, 3)) {
    if (shouldStop && shouldStop()) return false
    const r = await move.travel(bot, c, { range: 0, label: 'under the scaffold', maxMs: 90000 })
    const f = bot.entity.position.floored()
    if (!r.ok && !(f.x === c.x && f.z === c.z && f.y === c.y)) continue
    if (!inv.items(bot).some(i => FILLER_ITEMS.test(i.name))) await ensureScaffold(bot, 16).catch(() => {})
    const base = bot.entity.position.floored().y
    for (let i = 0; i < 9 && !act.reach(bot, p, 4.3); i++) { if (!await require('./gather').towerUp(bot)) break }
    let gone = act.reach(bot, p, 5) && await act.dig(bot, p, { force: true, allowZones: ['build', 'base'], timeoutMs: 10000, noWalk: true, reachMax: 5 })
    // down again: our own pillar, dug from the top
    for (let i = 0; i < 12 && bot.entity.position.floored().y > base; i++) {
      const u = bot.entity.position.floored().offset(0, -1, 0)
      const ub = world.at(bot, u.x, u.y, u.z)
      if (!ub || !FILLER_ITEMS.test(ub.name) || job.index.has(key(u)) || !safeDrop(bot, u)) break
      if (!await act.dig(bot, u, { force: true, allowZones: ['build', 'base'], timeoutMs: 6000, noWalk: true })) break
      await landed(bot)
    }
    gone = gone || !isStray(bot, p.x, p.y, p.z)
    if (gone) { log('build', `took down the scaffold at ${move.fmt(p)} from a pillar at ${c.x},${c.z}`); return true }
  }
  return false
}
function safeDrop (bot, under) {
  for (let y = under.y - 1; y >= under.y - 4; y--) {
    const b = world.at(bot, under.x, y, under.z)
    if (!b || world.isLavaBlock(b)) return false
    if (world.isSolid(b)) return under.y - y <= 3
    if (world.isWaterBlock(b)) return false
  }
  return false
}
async function landed (bot) { const t0 = Date.now(); await act.sleep(150); while (!bot.entity.onGround && Date.now() - t0 < 2000) await act.sleep(50) }

// Holes the site work left in the ground (the snapshot says there was earth or rock) are filled with dirt,
// lowest first. Without a snapshot, the old groundwork round the outside.
async function finishSite (bot, { shouldStop } = {}) {
  if (!job) return 0
  const bx = job.box
  if (!site) {
    const gy = bx.y1 - 1
    const fixed = await require('./ground').prepare(bot, {
      x1: bx.x1 - 4, z1: bx.z1 - 4, x2: bx.x2 + 4, z2: bx.z2 + 4, groundY: gy, height: bx.y2 + 3 - gy,
      keep: b => !SCAFFOLD_RE.test(b.name),
      skip: (x, z) => (x >= bx.x1 && x <= bx.x2 && z >= bx.z1 && z <= bx.z2) || (move.inZone({ x, y: gy, z }) || {}).label === 'base'
    }, { shouldStop, label: `finishing round the ${job.name}` })
    log('build', `finished the ground round the ${job.name}: ${fixed} blocks tidied`)
    return fixed
  }
  const holes = holesList(bot).filter(p => !resting(bot, p))
  if (!holes.length) return 0
  if (inv.count(bot, 'dirt') < holes.length + 2) {
    await base().withdraw(bot, 'dirt', holes.length + 2 - inv.count(bot, 'dirt')).catch(() => 0)
    if (inv.count(bot, 'dirt') < holes.length) await require('./craft').ensure(bot, 'dirt', Math.min(holes.length + 2, 128), { noWithdraw: true, shouldStop }).catch(() => false)
  }
  log('build', `filling ${holes.length} holes the site work left in the ground`)
  const me0 = bot.entity.position
  holes.sort((a, b) => a.y - b.y || world.dist3(a, me0) - world.dist3(b, me0))
  let fixed = 0
  for (const h of holes) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const cur = world.at(bot, h.x, h.y, h.z)
    if (!cur || world.isSolid(cur)) continue
    const filler = inv.items(bot).find(i => /^(dirt|coarse_dirt)$/.test(i.name))
    if (!filler) { log('build', 'out of dirt to fill holes with'); break }
    if (!world.isAirish(cur) && !world.isWaterBlock(cur)) await act.dig(bot, h, { force: true, allowZones: ['build', 'base'], timeoutMs: 4000 })
    if (!act.reach(bot, h, 4.3)) {
      const r = await goSite(bot, new goals.GoalNear(h.x, h.y + 1, h.z, 3), 'fill')
      if (!r.ok && !act.reach(bot, h, 4.8)) { failLeftover(bot, h); continue }
    }
    if (await act.place(bot, h, filler.name, { allowZones: ['build', 'base'], sneak: false })) fixed++
    else failLeftover(bot, h)
  }
  surveyCache = null
  log('build', `filled ${fixed} of ${holes.length} holes round the ${job.name}`)
  return fixed
}

// ---- completion: derived from the world, never latched --------------------------------------------
let surveyCache = null // { at, v }
// (scaffold and holes are only looked for once every cell stands - until then there is building to do anyway;
//  `full` asks for them regardless)
function survey (bot, maxAgeMs = 0, { full = false } = {}) {
  if (!job) return null
  if (surveyCache && Date.now() - surveyCache.at <= maxAgeMs && (!full || surveyCache.v.full)) return surveyCache.v
  const st = status(bot)
  const look = site && (full || st.done === st.total)
  const v = { cellsLeft: st.total - st.done, unknown: st.unknown, snapshot: !!site, full: !!look, scaffold: look ? scaffoldList(bot) : [], holes: look ? holesList(bot) : [] }
  surveyCache = { at: Date.now(), v }
  return v
}
// Every cell stands (in loaded chunks - unloaded counts as not known, so not complete), no scaffold is
// left and no hole in the ground.
function complete (bot) {
  const s = survey(bot)
  return !!s && s.cellsLeft === 0 && s.snapshot && !s.scaffold.length && !s.holes.length
}
function siteLoaded (bot) {
  if (!job) return false
  const r = siteRegion(job)
  for (const [x, z] of [[r.x1, r.z1], [r.x2, r.z1], [r.x1, r.z2], [r.x2, r.z2]]) if (!world.at(bot, x, job.box.y1, z)) return false
  return true
}
// Does the site want the builder? Near it: anything left (a missing cell - a creeper hole is a repair -,
// scaffold, a hole) that isn't resting until tomorrow. Away from it: the last look said so, or the last
// look is a Minecraft day old (go and see - cheap upkeep, never a spin: at most one check a day when done).
let lastCheckWrite = 0
function needsWork (bot) {
  if (!job) return false
  if (!siteLoaded(bot)) {
    const m = mem.get().siteCheck
    return !m || !m.complete || Date.now() - m.at > 20 * 60000
  }
  ensureSnapshot(bot)
  const s = survey(bot, 15000)
  const done = s.cellsLeft === 0 && s.snapshot && !s.scaffold.length && !s.holes.length
  const m = mem.get().siteCheck
  if (!m || m.complete !== done || Date.now() - lastCheckWrite > 5 * 60000) { lastCheckWrite = Date.now(); mem.set('siteCheck', { at: Date.now(), complete: done }) }
  if (done) return false
  if (s.cellsLeft > 0 || !s.snapshot) return true
  return s.scaffold.some(p => !resting(bot, p)) || s.holes.some(p => !resting(bot, p))
}
// Every cell stands: the finishing round - leftover obstructions, scaffold down, holes filled. Returns
// true when it changed something (nothing changed = the director backs off).
async function finish (bot, { shouldStop } = {}) {
  if (!job) return false
  if (!ensureSnapshot(bot)) return false
  // from afar every walk to a scaffold block would time out and count against it: be there first
  const bx = job.box; const mid = { x: Math.round((bx.x1 + bx.x2) / 2), y: bx.y1, z: Math.round((bx.z1 + bx.z2) / 2) }
  if (world.dist2(bot.entity.position, mid) > 40) {
    const r = await move.travel(bot, mid, { range: 8, shouldStop, label: 'to site' })
    if (!r.ok) return false
  }
  const s0 = survey(bot)
  log('build', `${job.name}: every block stands - finishing (${s0.scaffold.length} scaffold, ${s0.holes.length} holes in the ground)`)
  // what matters first: stray blocks, then our scaffold down, then the ground; the leftover canopy leaves last (a
  // day of leaf-clearing walks left the scaffold standing, 2026-09-23 - and leaves are taken without towering)
  let did = await clearSite(bot, { finishing: true, shouldStop, leaves: false })
  if (s0.scaffold.length || s0.holes.length) await ensureScaffold(bot, 32).catch(() => {})
  // the ground first - a minute's work, and behind the day-long teardown it never got a turn before dusk
  did += await finishSite(bot, { shouldStop })
  did += await removeScaffold(bot, { shouldStop })
  did += await clearSite(bot, { finishing: true, shouldStop })
  surveyCache = null
  if (complete(bot)) { log('build', `${job.name} complete: every block in place, no scaffold, the ground made good`); mem.set('siteCheck', { at: Date.now(), complete: true }) }
  return did > 0
}

function getJob () { return job }
function snapshotInfo (bot) {
  if (!job) return null
  const r = siteRegion(job)
  return { taken: !!site, at: site && site.at, file: siteFile(job), region: r, kinds: site ? site.palette.length : 0, loaded: siteLoaded(bot) }
}

// Filler blocks to stand on while building high (the planner towers with them).
async function ensureScaffold (bot, n = 32) {
  const held = inv.items(bot).filter(i => FILLER_ITEMS.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (held >= n / 2) return true
  const base = require('./base')
  for (const name of ['andesite', 'diorite', 'tuff', 'dirt', 'cobbled_deepslate']) {
    const have = inv.items(bot).filter(i => FILLER_ITEMS.test(i.name)).reduce((s, i) => s + i.count, 0)
    if (have >= n) return true
    if (base.bankCount(name) > 0) await base.withdraw(bot, name, n - have).catch(() => 0)
  }
  const have = inv.items(bot).filter(i => FILLER_ITEMS.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (have < n / 2) { log('build', `getting ${n - have} dirt to scaffold with`); await require('./craft').ensure(bot, 'dirt', inv.count(bot, 'dirt') + (n - have), { noWithdraw: true }).catch(() => false) }
  return true
}

module.exports = {
  finishSite, woodClass, woodForm, acceptsFor, itemOf, LOG_ANY, PLANKS_ANY, ensureScaffold, unskippedObstructions, setJob, getJob, status, nextNeeds,
  buildStep, clearSite, obstructions, removeScaffold, loadSchematic, cellDone, cellsDone, inBox, placeCell, registerJob, key,
  complete, needsWork, finish, survey, scaffoldList, holesList, ensureSnapshot, snapshotInfo, snapName,
  // pure helpers (offline checks)
  describe, plansFor, predict, yawOf, facingOfYaw, wantOf, nameOk, itemForBlock, KEY_PROPS
}
