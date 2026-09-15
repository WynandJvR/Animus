'use strict'
// Survival schematic builder. The world is the progress record: a cell is done when the block
// there IS the schematic block, so a restart, a death or a griefer never confuses the count.
// Order: clear what doesn't belong (top-down), then place bottom-up, nearest first.
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
const FILLER_ITEMS = /^(dirt|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|coarse_dirt)$/

let job = null // { name, origin, cells: [{x,y,z,name,props}], size, box }
const LOCAL_WOOD = true
const LOG_ANY = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/
const PLANKS_ANY = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_planks$/
function woodClass (name) { return LOCAL_WOOD ? (/_log$/.test(name) ? 'log' : /_planks$/.test(name) ? 'planks' : null) : null }

async function loadSchematic (name, version) {
  const { Schematic } = require('prismarine-schematic')
  let file = null
  for (const d of SCHEM_DIRS) { const f = path.join(d, name.endsWith('.schem') ? name : name + '.schem'); if (fs.existsSync(f)) { file = f; break } }
  if (!file) throw new Error('no schematic ' + name)
  return Schematic.read(fs.readFileSync(file), version)
}

async function setJob (bot, name, origin) {
  const s = await loadSchematic(name, bot.version)
  const st = s.start(); const en = s.end()
  const cells = []
  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const b = s.getBlock(new Vec3(x, y, z))
    if (!b || b.name === 'air') continue
    const cell = { x: origin.x + x - st.x, y: origin.y + y - st.y, z: origin.z + z - st.z, name: b.name, props: b.getProperties() }
    // the operator chose local wood (2026-09-15: a birch forest, oak scarce, no spruce): a wood cell takes any
    // log / any planks, the blueprint's own wood first when we have it
    if (LOCAL_WOOD && /_log$/.test(b.name)) { cell.alt = LOG_ANY; cell.prefer = [b.name] }
    if (LOCAL_WOOD && /_planks$/.test(b.name)) { cell.alt = PLANKS_ANY; cell.prefer = [b.name] }
    cells.push(cell)
  }
  const box = { x1: origin.x, y1: origin.y, z1: origin.z, x2: origin.x + en.x - st.x, y2: origin.y + en.y - st.y, z2: origin.z + en.z - st.z }
  job = { name, origin, cells, box, index: new Map(cells.map(c => [key(c), c])) }
  mem.set('build', { name, origin })
  move.setZone('build', { x1: box.x1 - 1, y1: box.y1 - 1, z1: box.z1 - 1, x2: box.x2 + 1, y2: box.y2 + 3, z2: box.z2 + 1 })
  log('build', `job "${name}" at ${move.fmt(origin)}: ${cells.length} blocks, box ${box.x1}..${box.x2} ${box.y1}..${box.y2} ${box.z1}..${box.z2}`)
  return job
}
function key (p) { return `${p.x},${p.y},${p.z}` }

function cellDone (bot, c) {
  const b = world.at(bot, c.x, c.y, c.z)
  if (!b) return null // unloaded = unknown
  if (c.clear) return world.isAirish(b) || /(_bed|^chest|^furnace|^crafting_table|^barrel|torch|lantern|_carpet)$/.test(b.name)
  if (b.name !== c.name && !(c.alt && c.alt.test(b.name))) return false
  if (c.props && c.props.axis && !axisRelaxed(c)) { try { return b.getProperties().axis === c.props.axis } catch { return true } }
  return true
}
// Logs that could not be placed with the blueprint's axis (no block on that side to click, too high for a
// support pillar from the ground) go in with whatever axis works - remembered, so they count as done.
function axisRelaxed (c) { return ((mem.get().axisRelaxed || []).includes(key(c))) }
function relaxAxis (c) { mem.update(m => { m.axisRelaxed = m.axisRelaxed || []; if (!m.axisRelaxed.includes(key(c))) m.axisRelaxed.push(key(c)) }) }

// Remaining work, from the world. Counts unknown (unloaded) cells as remaining.
function status (bot) {
  if (!job) return null
  let done = 0; let unknown = 0
  const need = {}
  for (const c of job.cells) {
    const d = cellDone(bot, c)
    if (d === true) done++
    else { if (d === null) unknown++; need[c.name] = (need[c.name] || 0) + 1 }
  }
  return { name: job.name, total: job.cells.length, done, unknown, need }
}

// Blocks inside the footprint (above the base layer) that are not part of the schematic.
function obstructions (bot, { maxY = Infinity } = {}) {
  const out = []
  const { box } = job
  for (let y = Math.min(box.y2 + 2, maxY); y >= box.y1 + 1; y--) for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) {
    if (job.index.has(key({ x, y, z }))) { // a schematic cell holding the wrong block
      const c = job.index.get(key({ x, y, z }))
      const b = world.at(bot, x, y, z)
      if (b && !world.isAirish(b) && !world.isWaterBlock(b) && b.name !== c.name && !(c.alt && c.alt.test(b.name))) out.push(b)
      continue
    }
    const b = world.at(bot, x, y, z)
    if (!b || world.isAirish(b) || world.isWaterBlock(b) || world.isLavaBlock(b)) continue
    // above the ground layers a dirt/granite block outside the castle's cells is our own scaffold or a
    // pathfinder pillar - not an obstruction (each castle cycle tore down the supports the build then put back);
    // removeScaffold takes them away when the castle is done
    if (y >= box.y1 + 3 && SCAFFOLD_RE.test(b.name)) continue
    out.push(b)
  }
  return out
}

function inBox (p, pad = 0) { const b = job.box; return p.x >= b.x1 - pad && p.x <= b.x2 + pad && p.z >= b.z1 - pad && p.z <= b.z2 + pad && p.y >= b.y1 - pad && p.y <= b.y2 + pad + 3 }

// Movements for work inside the site: may dig terrain and scaffold there, but never a block that
// already matches the schematic.
function siteMovements (bot) {
  // finished blocks of every build are protected by move's registered protector (one rule, all walks)
  return move.movementsFor(bot, { dig: true, place: true, allowZones: ['build', 'base'] })
}

async function goSite (bot, goal, label) {
  // move.goTo builds its own Movements; for site work use pathfinder directly through runGoal
  // leaving the safehouse first: the planner never routes through its door
  if (move.insideHut(bot.entity.position.floored())) await move.crossDoor(bot, goal).catch(e => log('build', `door crossing threw: ${e.message}`))
  const r = await move.runGoal(bot, goal, { timeoutMs: 30000, stuckMs: 8000, movements: siteMovements(bot) })
  if (!r.ok && r.why === 'interrupted') { await reflex.waitClear(); return move.runGoal(bot, goal, { timeoutMs: 30000, stuckMs: 8000, movements: siteMovements(bot) }) }
  return r
}

// Obstructions we could not reach twice are left for the end (scaffold cleanup reaches from the
// finished walls) instead of stalling the whole site on a leaf 12 blocks up.
const clearFails = new Map()
function skippedObstruction (b) { return (clearFails.get(key(b.position)) || 0) >= 2 }
function unskippedObstructions (bot, opts) { return obstructions(bot, opts).filter(b => !skippedObstruction(b)) }

async function clearSite (bot, { shouldStop, maxBlocks = 400, maxY = Infinity, finishing = false } = {}) {
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
        const r = await goSite(bot, new goals.GoalLookAtBlock(cur.position, bot.world, { reach: 4 }), 'clear')
        if (!r.ok && !act.reach(bot, cur.position, 5)) { clearFails.set(key(cur.position), (clearFails.get(key(cur.position)) || 0) + 1); continue }
      }
      if (await act.dig(bot, cur.position, { force: true, allowZones: ['build', 'base'], timeoutMs: 15000 })) cleared++
      else clearFails.set(key(cur.position), (clearFails.get(key(cur.position)) || 0) + 1)
      if (inv.freeSlots(bot) <= 1) await base().tossJunk(bot)
    }
    await act.collectDrops(bot, { radius: 10, maxMs: 8000 })
  }
  return cleared
}

// Faces to click for a cell (the neighbour we place against, as an offset from the cell).
function facesFor (c) {
  const axis = c.props && c.props.axis
  if (axis === 'x') return [[1, 0, 0], [-1, 0, 0]]
  if (axis === 'z') return [[0, 0, 1], [0, 0, -1]]
  if (axis === 'y') return [[0, -1, 0], [0, 1, 0]]
  return [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
}

// Other build jobs (the hut) register here so site movement never breaks their finished blocks.
const extraJobs = new Map()
function registerJob (name, j) { if (j) extraJobs.set(name, j); else extraJobs.delete(name) }
function allJobs () { const out = [...extraJobs.values()]; if (job) out.push(job); return out }
move.setProtector(block => {
  for (const j of allJobs()) {
    const c = j.index.get(key(block.position))
    if (c && (block.name === c.name || (c.alt && c.alt.test(block.name)))) return true
  }
  return false
})

// The item to place for a cell: its exact block, or the first held alternative (in preference order).
function pickItem (bot, c) {
  const items = inv.items(bot)
  const exact = items.find(i => i.name === c.name)
  if (exact || !c.alt) return exact || null
  if (c.prefer) for (const n of c.prefer) { const it = items.find(i => i.name === n); if (it) return it }
  return items.find(i => c.alt.test(i.name)) || null
}

// A support block for a cell that has nothing to be clicked against. In mid-air a single filler has
// nothing to attach to either (an x-axis log in a wall needs a neighbour on its x side, where there is
// only air): stand a thin pillar up from the ground to it. Every block is scaffold, removed at the end.
async function placeSupport (bot, sp, j) {
  const fillerName = () => { const f = inv.items(bot).find(i => FILLER_ITEMS.test(i.name)); return f && f.name }
  if (!fillerName()) return false
  const record = p => mem.update(m => { m.scaffold.push(p) })
  // 1) straight on: any solid neighbour of the support cell will do (usually the wall we are building)
  const hasNeighbour = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => { const nb = world.at(bot, sp.x + dx, sp.y + dy, sp.z + dz); return nb && world.isSolid(nb) })
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

async function placeCell (bot, c, j = job) {
  const pos = new Vec3(c.x, c.y, c.z)
  if (c.clear) {
    // a cell that must be empty: dig out whatever is in it
    if (cellDone(bot, c)) return true
    return act.dig(bot, pos, { force: true, allowZones: ['build', 'base'], timeoutMs: 15000 })
  }
  let cur = bot.blockAt(pos)
  if (!cur) return false
  if (cellDone(bot, c)) return true
  if (!world.isAirish(cur) && !world.isWaterBlock(cur) && !/^(short_grass|tall_grass|fern|snow|leaf_litter|dead_bush)$/.test(cur.name)) {
    if (!await act.dig(bot, pos, { force: true, allowZones: ['build', 'base'] })) return false
    cur = bot.blockAt(pos)
  }
  // after three failures with its own axis, a log takes any face
  const faces = (c.props && c.props.axis && (axisRelaxed(c) || (cellFails.get(key(c)) || { n: 0 }).n >= 3)) ? [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] : facesFor(c)
  if (c.props && c.props.axis && !axisRelaxed(c) && (cellFails.get(key(c)) || { n: 0 }).n >= 3) { relaxAxis(c); log('build', `${c.name} at ${move.fmt(c)} goes in with any axis (nothing to place it against on its own side)`) }
  // is there something to click?
  let ref = null
  for (const f of faces) { const nb = bot.blockAt(pos.offset(...f)); if (nb && world.isSolid(nb)) { ref = f; break } }
  if (!ref) {
    // temporary support on any face the cell can be clicked from: not a cell of the build, not where we
    // stand (only ever trying the first face put the support into the bot's own head, 4 minutes of
    // "blockUpdate did not fire")
    const filler = inv.items(bot).find(i => FILLER_ITEMS.test(i.name))
    if (!filler) return false
    const me = bot.entity.position.floored()
    let supported = false
    for (const f of faces) {
      const sp = { x: c.x + f[0], y: c.y + f[1], z: c.z + f[2] }
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
  if (!act.reach(bot, pos, 4.3)) {
    const r = await goSite(bot, new goals.GoalPlaceBlock(pos, bot.world, { range: 4, faces: faces.map(f => new Vec3(f[0], f[1], f[2])), LOS: true }), 'place')
    if (!r.ok && !act.reach(bot, pos, 4.8)) return false
  }
  const ok = await act.place(bot, c, item.name, { faceHint: faces, allowZones: ['build', 'base'], sneak: !/_door$/.test(item.name) })
  if (ok && c.props && c.props.axis && !axisRelaxed(c)) {
    const b = bot.blockAt(pos)
    try {
      if (b.getProperties().axis !== c.props.axis) {
        log('build', `log at ${move.fmt(c)} came out axis ${b.getProperties().axis}, redoing`)
        await act.dig(bot, pos, { force: true, allowZones: ['build', 'base'] })
        return false
      }
    } catch {}
  }
  return ok
}

// Place as much as the pack allows. Returns {placed, blockedOn: material|null, done}.
// cells that keep failing rest a while - across build steps (a fresh map per step retried the same
// unplaceable cell every call)
const cellFails = new Map() // key -> {n, at}
async function buildStep (bot, { shouldStop, maxMs = 10 * 60000 } = {}) {
  const t0 = Date.now()
  let placed = 0
  const failed = { get: k => { const f = cellFails.get(k); return f && Date.now() - f.at < 5 * 60000 ? f.n : 0 }, set: (k, n) => cellFails.set(k, { n, at: Date.now() }) }
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const todo = job.cells.filter(c => cellDone(bot, c) !== true && (failed.get(key(c)) || 0) < 3)
    if (!todo.length) {
      const st = status(bot)
      return { placed, blockedOn: null, done: st.done >= st.total }
    }
    const have = inv.counts(bot)
    const lowestAll = Math.min(...todo.map(c => c.y))
    // the lowest two layers of what we HAVE the blocks for: 24 missing glass panes in a wall no longer hold up
    // every brick above them (the windows go in when the glass comes)
    const withMat = todo.filter(c => (have[c.name] || 0) > 0 || (c.alt && Object.keys(have).some(n => c.alt.test(n))))
    if (!withMat.length) {
      const missing = todo.filter(c => c.y <= lowestAll + 1).find(c => !(have[c.name] > 0))
      return { placed, blockedOn: missing ? missing.name : null, done: false }
    }
    const minY = Math.min(...withMat.map(c => c.y))
    // no more than 3 layers above the lowest unfinished cell: walls rise together, nothing floats far up
    if (minY > lowestAll + 3) {
      const missing = todo.filter(c => c.y <= lowestAll + 1).find(c => !(have[c.name] > 0))
      return { placed, blockedOn: missing ? missing.name : null, done: false }
    }
    const doable = withMat.filter(c => c.y <= minY + 1)
    const me = bot.entity.position
    // cells that can be clicked right now first; one whose every face is another unbuilt cell of this
    // build waits for its neighbours (trying it costs ~20s of failed placing, and a wall of x-axis logs
    // placed out of order was nothing but failures)
    const ALL_FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
    const facesNow = c => (c.props && c.props.axis && (axisRelaxed(c) || (cellFails.get(key(c)) || { n: 0 }).n >= 3)) ? ALL_FACES : facesFor(c)
    const clickable = c => facesNow(c).some(f => { const nb = world.at(bot, c.x + f[0], c.y + f[1], c.z + f[2]); return nb && world.isSolid(nb) })
    const supportable = c => facesNow(c).some(f => !job.index.has(key({ x: c.x + f[0], y: c.y + f[1], z: c.z + f[2] })))
    const ready = doable.filter(c => clickable(c) || supportable(c))
    if (!ready.length) return { placed, blockedOn: null, done: false }
    ready.sort((a, b) => (clickable(b) - clickable(a)) * 100 + (a.y - b.y) * 4 + world.dist3(a, me) - world.dist3(b, me))
    const c = ready[0]
    const ok = await placeCell(bot, c)
    if (ok) { placed++; cellFails.delete(key(c)); if (placed % 25 === 0) { const st = status(bot); log('build', `${st.done}/${st.total} placed`) } } else { failed.set(key(c), (failed.get(key(c)) || 0) + 1); if (failed.get(key(c)) >= 3) log('build', `${c.name} at ${move.fmt(c)} won't place - leaving it for later`) }
  }
  return { placed, blockedOn: null, done: false }
}

// The finish round the outside: within 4 blocks of the walls take down every scaffold block and pathfinder
// pillar (any height) and fill holes left in the ground, so the castle stands on clean, level ground.
// Never inside the base zone (the hut, its furnaces and the farm).
async function finishSite (bot, { shouldStop } = {}) {
  if (!job) return 0
  const bx = job.box
  const gy = bx.y1 - 1
  // the shared groundwork round the outside: only scaffold comes down (trees, the hut and its things stay),
  // holes in the ground get filled; the castle footprint and the base zone are left alone
  const fixed = await require('./ground').prepare(bot, {
    x1: bx.x1 - 4, z1: bx.z1 - 4, x2: bx.x2 + 4, z2: bx.z2 + 4, groundY: gy, height: bx.y2 + 3 - gy,
    keep: b => !SCAFFOLD_RE.test(b.name),
    skip: (x, z) => (x >= bx.x1 && x <= bx.x2 && z >= bx.z1 && z <= bx.z2) || (move.inZone({ x, y: gy, z }) || {}).label === 'base'
  }, { shouldStop, label: `finishing round the ${job.name}` })
  log('build', `finished the ground round the ${job.name}: ${fixed} blocks tidied`)
  return fixed
}

async function removeScaffold (bot) {
  const list = (mem.get().scaffold || []).slice()
  let removed = 0
  for (const p of list) {
    const b = world.at(bot, p.x, p.y, p.z)
    if (b && SCAFFOLD_RE.test(b.name) && !job.index.has(key(p))) {
      if (await act.dig(bot, p, { force: true, allowZones: ['build', 'base'] })) removed++
    }
    mem.update(m => { m.scaffold = m.scaffold.filter(q => !(q.x === p.x && q.y === p.y && q.z === p.z)) })
  }
  // pathfinder pillars: filler blocks standing in the footprint above the ground layer
  if (job) {
    // (scanned directly: obstructions() no longer lists scaffold above the ground layers)
    const bx = job.box
    for (let y = bx.y2 + 2; y > bx.y1; y--) for (let z = bx.z1 - 1; z <= bx.z2 + 1; z++) for (let x = bx.x1 - 1; x <= bx.x2 + 1; x++) {
      if (job.index.has(key({ x, y, z }))) continue
      const b = world.at(bot, x, y, z)
      if (b && SCAFFOLD_RE.test(b.name)) { if (await act.dig(bot, b.position, { force: true, allowZones: ['build', 'base'] })) removed++ }
    }
  }
  if (removed) log('build', `removed ${removed} scaffold blocks`)
  return removed
}

function getJob () { return job }

// Filler blocks to stand on while building high (the planner towers with them).
async function ensureScaffold (bot, n = 32) {
  const held = inv.items(bot).filter(i => FILLER_ITEMS.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (held >= n / 2) return true
  const base = require('./base')
  for (const name of ['andesite', 'diorite', 'granite', 'tuff', 'dirt', 'cobbled_deepslate']) {
    const have = inv.items(bot).filter(i => FILLER_ITEMS.test(i.name)).reduce((s, i) => s + i.count, 0)
    if (have >= n) return true
    if (base.bankCount(name) > 0) await base.withdraw(bot, name, n - have).catch(() => 0)
  }
  const have = inv.items(bot).filter(i => FILLER_ITEMS.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (have < n / 2) { log('build', `getting ${n - have} dirt to scaffold with`); await require('./craft').ensure(bot, 'dirt', inv.count(bot, 'dirt') + (n - have), { noWithdraw: true }).catch(() => false) }
  return true
}

module.exports = { finishSite, woodClass, LOG_ANY, PLANKS_ANY, ensureScaffold, unskippedObstructions, setJob, getJob, status, buildStep, clearSite, obstructions, removeScaffold, loadSchematic, cellDone, inBox, placeCell, registerJob, key }
