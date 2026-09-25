'use strict'
// The safehouse: a stone hut generated around whatever stands at home (bed, chest, furnace,
// table), so it fits any site. Walls of any stone-like block the bot holds, a wooden door, a roof.
// The world is the progress record, as with every build.
const { Vec3 } = require('vec3')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')
const build = require('./build')

const craft = () => require('./craft')

const WALL_ALT = /^(cobblestone|mossy_cobblestone|stone|andesite|diorite|granite|tuff|cobbled_deepslate|stone_bricks|deepslate|polished_.*|.*_planks)$/
// junk stone first, then cobble (the castle wants cobble), planks last
const WALL_PREFER = ['andesite', 'diorite', 'granite', 'tuff', 'cobbled_deepslate', 'stone', 'cobblestone', 'mossy_cobblestone']
const UTIL_RE = /(_bed|^chest|^furnace|^crafting_table|^barrel)$/
const FOUNDATION_ALT = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mud|clay|gravel|sand|sandstone|stone|cobblestone|mossy_cobblestone|andesite|diorite|granite|tuff|calcite|deepslate|cobbled_deepslate|.*_ore|stone_bricks|polished_.*|.*_planks|terracotta|.*_terracotta)$/

let plan = null
// the doorway holds the door by day and a block at night (zombies break wooden doors on hard)
const SEAL_RE = /^(cobblestone|andesite|diorite|granite|tuff|cobbled_deepslate|stone|dirt|mossy_cobblestone)$/
const DOOR_OR_SEAL = /_door$|^(cobblestone|andesite|diorite|granite|tuff|cobbled_deepslate|stone|dirt|mossy_cobblestone)$/

function key (p) { return `${p.x},${p.y},${p.z}` }

// Interior = the box around home and the utility blocks within 4 of it, at least 3x3.
function makePlan (bot) {
  const home = mem.get().home
  if (!home) return null
  // the plan is decided ONCE per home and remembered: recomputing it from whatever stands around
  // home moved the door between restarts and a wall block ended up in the doorway
  const saved = mem.get().hutPlan
  if (saved && saved.home && saved.home.x === home.x && saved.home.y === home.y && saved.home.z === home.z) {
    return planFrom(bot, home, saved.interior, saved.door)
  }
  const y0 = home.y
  const pts = [{ x: home.x, z: home.z }]
  for (const b of world.findBlocks(bot, UTIL_RE, { maxDistance: 5, count: 12, point: new Vec3(home.x, home.y, home.z) })) {
    if (Math.abs(b.position.y - y0) <= 1) pts.push({ x: b.position.x, z: b.position.z })
  }
  let x1 = Math.min(...pts.map(p => p.x)); let x2 = Math.max(...pts.map(p => p.x))
  let z1 = Math.min(...pts.map(p => p.z)); let z2 = Math.max(...pts.map(p => p.z))
  while (x2 - x1 < 2) { if ((x2 - x1) % 2) x2++; else x1-- }
  while (z2 - z1 < 2) { if ((z2 - z1) % 2) z2++; else z1-- }
  if (x2 - x1 > 6 || z2 - z1 > 6) { x1 = home.x - 2; x2 = home.x + 2; z1 = home.z - 2; z2 = home.z + 2 }
  const X1 = x1 - 1; const X2 = x2 + 1; const Z1 = z1 - 1; const Z2 = z2 + 1
  // door in the middle of the side facing the build site (or south)
  const j = build.getJob()
  const target = j ? { x: (j.box.x1 + j.box.x2) / 2, z: (j.box.z1 + j.box.z2) / 2 } : { x: home.x, z: home.z + 100 }
  const cx = Math.round((X1 + X2) / 2); const cz = Math.round((Z1 + Z2) / 2)
  const sides = [
    { x: X1, z: cz, d: Math.hypot(X1 - target.x, cz - target.z) },
    { x: X2, z: cz, d: Math.hypot(X2 - target.x, cz - target.z) },
    { x: cx, z: Z1, d: Math.hypot(cx - target.x, Z1 - target.z) },
    { x: cx, z: Z2, d: Math.hypot(cx - target.x, Z2 - target.z) }
  ].sort((a, b) => a.d - b.d)
  const door = { x: sides[0].x, z: sides[0].z }
  mem.set('hutPlan', { home: { x: home.x, y: home.y, z: home.z }, interior: { x1, z1, x2, z2 }, door })
  return planFrom(bot, home, { x1, z1, x2, z2 }, door)
}

function planFrom (bot, home, interior, door) {
  const y0 = home.y
  const { x1, z1, x2, z2 } = interior
  const X1 = x1 - 1; const X2 = x2 + 1; const Z1 = z1 - 1; const Z2 = z2 + 1
  const cells = []
  for (let y = y0; y <= y0 + 2; y++) {
    for (let x = X1; x <= X2; x++) for (let z = Z1; z <= Z2; z++) {
      const edge = x === X1 || x === X2 || z === Z1 || z === Z2
      if (!edge) continue
      if (x === door.x && z === door.z && y <= y0 + 1) {
        if (y === y0) cells.push({ x, y, z, name: 'oak_door', alt: DOOR_OR_SEAL, door: true })
        continue // the upper half comes with the lower
      }
      cells.push({ x, y, z, name: 'cobblestone', alt: WALL_ALT, prefer: WALL_PREFER })
    }
  }
  for (let x = X1; x <= X2; x++) for (let z = Z1; z <= Z2; z++) cells.push({ x, y: y0 + 3, z, name: 'cobblestone', alt: WALL_ALT, prefer: WALL_PREFER })
  // a real floor: stone over the whole interior (grass/dirt/holes/an old shaft top are not a floor)
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) cells.push({ x, y: y0 - 1, z, name: 'cobblestone', alt: WALL_ALT, prefer: WALL_PREFER, floor: true })
  // and under the walls, so nothing tunnels in beneath them
  for (let x = X1; x <= X2; x++) for (let z = Z1; z <= Z2; z++) {
    if (x === X1 || x === X2 || z === Z1 || z === Z2) cells.push({ x, y: y0 - 1, z, name: 'cobblestone', alt: WALL_ALT, prefer: WALL_PREFER, floor: true })
  }
  // the room itself must be empty: scaffold left from laying the roof, a stray block, a leaf - out.
  // (furniture on the floor is fine; see cellDone's clear handling in build.js)
  for (let y = y0; y <= y0 + 2; y++) for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) cells.push({ x, y, z, name: 'air', clear: true })
  // foundation: no hollow directly under the house (an old shaft or cave pocket is a mob spawner
  // under the bed). Any solid block counts; a hollow gets filled.
  for (let x = X1; x <= X2; x++) for (let z = Z1; z <= Z2; z++) cells.push({ x, y: y0 - 2, z, name: 'dirt', alt: FOUNDATION_ALT, prefer: ['dirt', 'andesite', 'diorite', 'granite', 'tuff', 'cobblestone'], foundation: true })
  const box = { x1: X1, y1: y0, z1: Z1, x2: X2, y2: y0 + 3, z2: Z2 }
  const p = { cells, box, door, index: new Map(cells.map(c => [key(c), c])), interior: { x1, z1, x2, z2, y: y0 } }
  build.registerJob('hut', p)
  return p
}

// The room's layout. A clear walkway runs from the door straight to the back wall; furniture stands
// only in the cells along the side walls; the bed lies along the back wall with its foot at the end
// of the walkway. (Placing furniture on "the first free cell" put the crafting table in the middle
// of the room, in the way of everything.)
//   walkway: door step .. back cell (the back cell is the bed's foot)
//   bed: { foot, head, stand } - stand is where the bot stands to place it facing foot->head
//   slots: side cells for chest/furnace/table, back-wall cells first, the bed's stand cell last
function layout (bot) {
  const hp = mem.get().hutPlan
  if (!hp || !hp.interior || !hp.door) return null
  const { x1, z1, x2, z2 } = hp.interior; const y = hp.home.y; const d = hp.door
  let dir
  if (d.x < x1) dir = { x: 1, z: 0 }; else if (d.x > x2) dir = { x: -1, z: 0 }; else if (d.z < z1) dir = { x: 0, z: 1 }; else dir = { x: 0, z: -1 }
  const inRoom = c => c.x >= x1 && c.x <= x2 && c.z >= z1 && c.z <= z2
  const walkway = []
  for (let s = 1; s < 16; s++) { const c = { x: d.x + dir.x * s, y, z: d.z + dir.z * s }; if (!inRoom(c)) break; walkway.push(c) }
  if (!walkway.length) return null
  const same = (a, b) => a && b && a.x === b.x && a.z === b.z
  const depth = c => Math.abs(dir.x ? c.x - d.x : c.z - d.z)
  const back = walkway[walkway.length - 1]
  const lat = dir.x ? { x: 0, z: 1 } : { x: 1, z: 0 }
  const beside = [{ x: back.x + lat.x, y, z: back.z + lat.z }, { x: back.x - lat.x, y, z: back.z - lat.z }].filter(inRoom)
  const freeFor = (c, re) => { const b = world.at(bot, c.x, c.y, c.z); return !b || world.isAirish(b) || /torch/.test(b.name) || re.test(b.name) }
  let bed = null
  if (beside.length === 2) {
    let side = hp.bedSide
    if (side == null) side = freeFor(beside[0], /_bed$/) ? 0 : (freeFor(beside[1], /_bed$/) ? 1 : 0)
    bed = { foot: back, head: beside[side], stand: beside[1 - side], side }
  }
  const slots = []
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
    const c = { x, y, z }
    if (walkway.some(w => same(w, c)) || (bed && same(bed.head, c))) continue
    slots.push(c)
  }
  slots.sort((a, b) => (bed && same(a, bed.stand)) - (bed && same(b, bed.stand)) || depth(b) - depth(a))
  return { walkway, back, bed, slots, dir }
}
// Where utility blocks (furnaces, extra chests) go at home, neatest first: free side-wall slots inside
// the room, then a row along the hut's outside walls - never the door approach.
function utilitySpots (bot) {
  const hp = mem.get().hutPlan
  const lay = layout(bot)
  if (!hp || !lay) return []
  const y = hp.home.y
  const free = c => { const b = world.at(bot, c.x, c.y, c.z); const f = world.at(bot, c.x, c.y - 1, c.z); return b && world.isAirish(b) && !/torch/.test(b.name) && f && world.isSolid(f) && !/(chest|furnace|crafting_table|_bed|barrel)$/.test(f.name) }
  const out = lay.slots.filter(c => !(lay.bed && lay.bed.stand && c.x === lay.bed.stand.x && c.z === lay.bed.stand.z)).filter(free)
  // outside: the ring one cell out from the walls, skipping the doorway side's middle three cells
  const { x1, z1, x2, z2 } = hp.interior
  const X1 = x1 - 2; const X2 = x2 + 2; const Z1 = z1 - 2; const Z2 = z2 + 2
  const d = hp.door
  const ring = []
  for (let x = X1; x <= X2; x++) for (let z = Z1; z <= Z2; z++) {
    if (!(x === X1 || x === X2 || z === Z1 || z === Z2)) continue
    if ((x === X1 || x === X2) && (z === Z1 || z === Z2)) continue // corners stay open to walk round
    if (Math.abs(x - d.x) + Math.abs(z - d.z) <= 2) continue
    ring.push({ x, y, z, back: Math.abs(x - d.x) + Math.abs(z - d.z) })
  }
  ring.sort((a, b) => b.back - a.back)
  return out.concat(ring.filter(free).map(c => ({ x: c.x, y: c.y, z: c.z })))
}
// THE FURNACE BANK: rings further out round the safehouse (every other ring, so a walkway runs between them), for as
// many furnaces as the build's smelting calls for. The first ring and the room stay the furniture's (chests, table,
// bed); the doorway's side keeps a 3-wide lane out. Ring k sits 2k cells out from the room. Returns the free spots,
// nearest ring first, at least `n` of them when the ground allows (rings are added until then).
const BANK_RINGS = 6 // the furnace bank's rings: ring k sits 2k out from the room (smelt.homeFurnaces, gather.onGrounds read it)
function furnaceSpots (bot, n) {
  const hp = mem.get().hutPlan
  if (!hp) return []
  const y = hp.home.y
  const { x1, z1, x2, z2 } = hp.interior
  const d = hp.door
  // the door's wall: the lane runs straight out from it
  const side = d.x < x1 ? 'W' : d.x > x2 ? 'E' : d.z < z1 ? 'N' : 'S'
  const inLane = (x, z) => (side === 'W' && x < x1 && Math.abs(z - d.z) <= 1) || (side === 'E' && x > x2 && Math.abs(z - d.z) <= 1) ||
    (side === 'N' && z < z1 && Math.abs(x - d.x) <= 1) || (side === 'S' && z > z2 && Math.abs(x - d.x) <= 1)
  const free = c => { const b = world.at(bot, c.x, c.y, c.z); const f = world.at(bot, c.x, c.y - 1, c.z); return b && world.isAirish(b) && f && world.isSolid(f) && !/(chest|furnace|crafting_table|_bed|barrel)$/.test(f.name) }
  const out = []
  // (out to the reach of the loaded ground round home: a ring past that is only unknown cells)
  for (let k = 2; k <= BANK_RINGS && out.length < n; k++) {
    const o = 2 * k
    const X1 = x1 - o; const X2 = x2 + o; const Z1 = z1 - o; const Z2 = z2 + o
    for (let x = X1; x <= X2; x++) for (let z = Z1; z <= Z2; z++) {
      if (!(x === X1 || x === X2 || z === Z1 || z === Z2)) continue
      if ((x === X1 || x === X2) && (z === Z1 || z === Z2)) continue // corners open, to walk from ring to ring
      if (inLane(x, z)) continue
      const c = { x, y, z }
      if (free(c)) out.push(c)
    }
  }
  return out
}
function rememberBedSide (side) { mem.update(m => { if (m.hutPlan) m.hutPlan.bedSide = side }) }

function getPlan (bot) {
  if (!plan || !mem.get().home) plan = makePlan(bot)
  return plan
}

function status (bot) {
  const p = getPlan(bot)
  if (!p) return null
  let done = 0
  for (const c of p.cells) if (build.cellDone(bot, c) === true) done++
  return { done, total: p.cells.length }
}

function complete (bot) { const s = status(bot); return !!s && s.done >= s.total }
// walls, roof, floor and door in place (it shelters) - tidying the room is not needed for that
function shellComplete (bot) {
  const p = getPlan(bot)
  if (!p) return false
  return p.cells.every(c => c.clear || build.cellDone(bot, c) === true)
}

async function buildHut (bot, { shouldStop } = {}) {
  const p = getPlan(bot)
  if (!p) return false
  mem.update(m => { m.hut = { box: p.box, door: p.door } })
  const need = p.cells.filter(c => !c.door && !c.clear && build.cellDone(bot, c) !== true).length
  const stoneHeld = inv.items(bot).filter(i => WALL_ALT.test(i.name) && !/_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (stoneHeld < need) {
    const got = await require('./base').withdraw(bot, 'cobblestone', need - stoneHeld).catch(() => 0)
    if (stoneHeld + got < need) {
      log('hut', `need ${need} wall blocks, holding ${stoneHeld + got} - getting cobblestone`)
      if (!await craft().ensure(bot, 'cobblestone', inv.count(bot, 'cobblestone') + (need - stoneHeld - got), { shouldStop, noWithdraw: true })) return false
    }
  }
  if (!inv.items(bot).some(i => /_door$/.test(i.name)) && p.cells.some(c => c.door && build.cellDone(bot, c) !== true)) {
    const w = craft().preferredWood(bot, 6)
    await craft().ensure(bot, w + '_door', 1, { shouldStop })
  }
  log('hut', `building the safehouse around home: ${status(bot).done}/${p.cells.length} in place`)
  const fails = new Map()
  const t0 = Date.now()
  while (Date.now() - t0 < 10 * 60000) {
    await new Promise(r => setImmediate(r))
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const todo = p.cells.filter(c => build.cellDone(bot, c) !== true && (fails.get(key(c)) || 0) < 3)
    if (!todo.length) break
    const me = bot.entity.position
    // floor first, then walls, roof; the door last (so we are not locked out while working), nearest first
    // (clearing the room comes after the roof: the scaffold inside is what the roof was laid from)
    const rank = c => (c.door ? 30 : 0) + (c.clear ? 1000 : 0) + c.y * 3 + world.dist3(c, me) * 0.3
    todo.sort((a, b) => rank(a) - rank(b))
    const c = todo[0]
    if (!c.clear && !inv.items(bot).some(i => i.name === c.name || (c.alt && c.alt.test(i.name)))) { log('hut', `out of ${c.name} for the hut`); break }
    if (c.door) {
      // a door needs its upper half free
      const up = world.at(bot, c.x, c.y + 1, c.z)
      if (up && !world.isAirish(up) && !/_door$/.test(up.name)) { log('hut', `clearing ${up.name} out of the doorway`); await act.dig(bot, { x: c.x, y: c.y + 1, z: c.z }, { force: true, allowZones: ['base', 'build'] }) }
    }
    const ok = await build.placeCell(bot, c, p)
    if (!ok) {
      const n = (fails.get(key(c)) || 0) + 1
      fails.set(key(c), n)
      // a hollow under a finished floor can't be reached: open the floor above, fill, re-lay it
      if (c.foundation && n >= 2) {
        const above = { x: c.x, y: c.y + 1, z: c.z }
        const ab = world.at(bot, above.x, above.y, above.z)
        if (ab && !world.isAirish(ab)) {
          log('hut', `opening the floor at ${move.fmt(above)} to fill the hollow under it`)
          await act.dig(bot, above, { force: true, own: true, allowZones: ['base', 'build'] }) // (our own finished floor: `own` past the build guard)
          fails.set(key(c), 0)
          fails.set(key(above), 0)
        }
      }
    }
  }
  const s = status(bot)
  log('hut', `safehouse ${s.done}/${s.total}`)
  // a light inside keeps mobs from spawning in it
  if (s.done >= s.total && inv.has(bot, 'torch')) {
    const it = p.interior
    for (let x = it.x1; x <= it.x2; x++) for (let z = it.z1; z <= it.z2; z++) {
      const cell = world.at(bot, x, it.y, z); const floor = world.at(bot, x, it.y - 1, z)
      if (cell && world.isAirish(cell) && floor && world.isSolid(floor) && !world.findBlocks(bot, /torch/, { maxDistance: 3, count: 1, point: new Vec3(x, it.y, z) }).length) {
        if (await act.place(bot, { x, y: it.y, z }, 'torch', { faceHint: [[0, -1, 0]], allowZones: ['base', 'build'], sneak: false })) break
      }
    }
  }
  return s.done >= s.total
}

// Does the safehouse (or where it would go) collide with the build footprint? A hut on the castle's
// wall line gets walled over - door included - so it has to stand clear of it.
function collidesWithBuild (bot, pad = 2) {
  const p = getPlan(bot)
  const j = build.getJob()
  if (!p || !j) return false
  const a = p.box; const b = j.box
  return a.x1 <= b.x2 + pad && a.x2 >= b.x1 - pad && a.z1 <= b.z2 + pad && a.z2 >= b.z1 - pad
}

// Move house: empty the chest into the pack, pick up bed/chest/furnace/table/torch/door, take the
// hut apart, forget the old home. The director then sites a new home clear of the build and
// rebuilds from what we carry.
async function relocate (bot, { shouldStop } = {}) {
  const p = getPlan(bot)
  const home = mem.get().home
  if (!p || !home) return false
  log('hut', `the safehouse at ${move.fmt(home)} overlaps the build - moving house`)
  const base = require('./base')
  // stone comes apart with a pickaxe, or not at all (bare hands take 10s a block and drop nothing)
  if (!inv.bestTool(bot, 'pickaxe', 1)) { if (!await craft().ensure(bot, 'stone_pickaxe', inv.count(bot, 'stone_pickaxe') + 1, { shouldStop })) { log('hut', 'no pickaxe - not taking the stone hut apart by hand'); return false } }
  // 1. everything out of the chests at home
  for (const c of (mem.get().chests || []).slice()) {
    const w = await base.openChest(bot, c)
    if (!w) continue
    try {
      for (const it of w.containerItems()) {
        if (inv.freeSlots(bot) < 2) break
        try { await w.withdraw(it.type, null, it.count) } catch {}
      }
    } finally { try { w.close() } catch {} }
  }
  if (inv.freeSlots(bot) < 4) await base.tossJunk(bot)
  // 2. furniture
  const furn = world.findBlocks(bot, /(_bed|^chest|^furnace|^crafting_table|^torch|_door)$/, { maxDistance: 7, count: 20, point: new Vec3(home.x, home.y, home.z) })
    .filter(b => b.position.x >= p.box.x1 - 1 && b.position.x <= p.box.x2 + 1 && b.position.z >= p.box.z1 - 1 && b.position.z <= p.box.z2 + 1)
  for (const b of furn) {
    if (shouldStop && shouldStop()) return false
    await act.dig(bot, b.position, { force: true, allowZones: ['base', 'build'], timeoutMs: 15000 })
  }
  await act.collectDrops(bot, { radius: 8, maxMs: 10000 })
  // 3. the shell (roof, walls, floor) - the stone comes back for the new one
  build.registerJob('hut', null)
  const shell = p.cells.filter(c => !c.foundation).sort((a, b) => b.y - a.y)
  let dug = 0
  for (const c of shell) {
    if (shouldStop && shouldStop()) return false
    const b = world.at(bot, c.x, c.y, c.z)
    if (!b || world.isAirish(b)) continue
    if (c.floor && /^(dirt|grass_block)$/.test(b.name)) continue
    if (b.harvestTools && !inv.canHarvest(bot, b)) {
      if (!await craft().ensure(bot, 'stone_pickaxe', inv.count(bot, 'stone_pickaxe') + 1, { shouldStop })) return false
    }
    if (await act.dig(bot, c, { force: true, allowZones: ['base', 'build'], timeoutMs: 12000 })) dug++
    // pick the stone up as we go: drops despawn after five minutes
    if (dug % 8 === 0) await act.collectDrops(bot, { radius: 8, maxMs: 6000 })
    if (inv.freeSlots(bot) < 2) await base.tossJunk(bot)
  }
  await act.collectDrops(bot, { radius: 10, maxMs: 12000 })
  // 3b. give the ground back: a dug-out floor leaves a row of holes that trips everything walking past
  await restoreGround(bot, p.box.x1, p.box.z1, p.box.x2, p.box.z2, p.box.y1 - 1)
  // 4. forget the old base
  mem.update(m => { m.home = null; m.bed = null; m.chests = []; m.chestContents = {}; m.furnaces = []; m.hut = null })
  move.setZone('base', null)
  plan = null
  log('hut', 'old base packed up - siting a new home clear of the build')
  return true
}

// Night: take the door down from inside and wall the doorway up (both halves). A zombie on hard
// breaks a wooden door; one walked in at dawn and killed the unarmoured bot at its own chest.
// The step just outside the door (at feet and head height).
function outerStep (pl) {
  const axisX = pl.door.x < pl.interior.x1 || pl.door.x > pl.interior.x2
  const y = pl.home.y
  if (axisX) return { x: pl.door.x < pl.interior.x1 ? pl.door.x - 1 : pl.door.x + 1, y, z: pl.door.z }
  return { x: pl.door.x, y, z: pl.door.z < pl.interior.z1 ? pl.door.z - 1 : pl.door.z + 1 }
}
function doorOpen (bot, d) { try { return !!world.at(bot, d.x, d.y, d.z).getProperties().open } catch { return false } }
async function setDoor (bot, d, open) {
  const b = world.at(bot, d.x, d.y, d.z)
  if (!b || !/_door$/.test(b.name) || doorOpen(bot, d) === open) return
  try { await bot.activateBlock(b); await move.sleep(250) } catch {}
}

// Night: the door stays hung; the step outside it is blocked (feet and head) from inside through the open
// door, then the door is shut. A zombie at the door meets stone. (Taking the door down every night and
// hanging it again every morning left it facing the wrong way, hung it on the step, or not at all.)
async function sealDoor (bot) {
  const pl = mem.get().hutPlan
  if (!pl || !pl.door) return false
  if (!move.insideHut(world.feetPos(bot))) return false
  const d = { x: pl.door.x, y: pl.home.y, z: pl.door.z }
  const out = outerStep(pl)
  const lo = world.at(bot, out.x, out.y, out.z); const hi = world.at(bot, out.x, out.y + 1, out.z)
  if (lo && SEAL_RE.test(lo.name) && hi && SEAL_RE.test(hi.name)) { await setDoor(bot, d, false); return true }
  const door = world.at(bot, d.x, d.y, d.z)
  if (!door || !/_door$/.test(door.name)) return false // no door hung: nothing to seal behind (the hut task hangs it)
  const have = inv.items(bot).filter(i => SEAL_RE.test(i.name)).reduce((n, i) => n + i.count, 0)
  if (have < 2) await require('./base').withdraw(bot, 'cobblestone', 2).catch(() => 0)
  const filler = () => inv.items(bot).find(i => SEAL_RE.test(i.name))
  if (!filler()) { log('hut', 'nothing to block the door step with'); return false }
  await setDoor(bot, d, true)
  for (const y of [out.y, out.y + 1]) {
    const c = world.at(bot, out.x, y, out.z)
    if (!c || SEAL_RE.test(c.name) || !world.isAirish(c)) continue
    const f = filler()
    if (!f) break
    await act.place(bot, { x: out.x, y, z: out.z }, f.name, { allowZones: ['base', 'build'], sneak: false, faceHint: [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] })
  }
  await setDoor(bot, d, false)
  const lo2 = world.at(bot, out.x, out.y, out.z); const hi2 = world.at(bot, out.x, out.y + 1, out.z)
  const ok = !!(lo2 && SEAL_RE.test(lo2.name) && hi2 && SEAL_RE.test(hi2.name))
  log('hut', ok ? 'blocked the door step for the night' : 'could not block the door step')
  return ok
}

// Morning (or whenever we need out): clear the blocked step (from either side), and - for a doorway walled up
// the old way - open it and hang the door.
async function unsealDoor (bot) {
  const pl = mem.get().hutPlan
  if (!pl || !pl.door) return false
  const d = { x: pl.door.x, y: pl.home.y, z: pl.door.z }
  if (world.dist3(world.feetPos(bot), d) > 5) return false
  const out = outerStep(pl)
  let did = false
  const stepBlocked = [out.y, out.y + 1].some(y => { const c = world.at(bot, out.x, y, out.z); return c && SEAL_RE.test(c.name) })
  if (stepBlocked) {
    log('hut', 'clearing the blocked door step')
    if (move.insideHut(world.feetPos(bot))) await setDoor(bot, d, true)
    for (const y of [out.y + 1, out.y]) {
      const c = world.at(bot, out.x, y, out.z)
      if (c && SEAL_RE.test(c.name)) await act.dig(bot, { x: out.x, y, z: out.z }, { force: true, allowZones: ['base', 'build'], timeoutMs: 8000 })
    }
    await act.collectDrops(bot, { radius: 3, maxMs: 1500 })
    did = true
  }
  const lo = world.at(bot, d.x, d.y, d.z)
  if (lo && SEAL_RE.test(lo.name)) { did = (await unsealOldDoorway(bot)) || did }
  return did
}

// The old night seal filled the doorway itself: open it and hang the door.
async function unsealOldDoorway (bot) {
  const pl = mem.get().hutPlan
  const d = { x: pl.door.x, y: pl.home.y, z: pl.door.z }
  log('hut', 'opening the walled-up doorway')
  for (const y of [d.y + 1, d.y]) {
    const c = world.at(bot, d.x, y, d.z)
    if (c && SEAL_RE.test(c.name)) await act.dig(bot, { x: d.x, y, z: d.z }, { force: true, allowZones: ['base', 'build'], timeoutMs: 8000 })
  }
  await act.collectDrops(bot, { radius: 3, maxMs: 2000 })
  let door = inv.items(bot).find(i => /_door$/.test(i.name) && !/iron/.test(i.name))
  if (!door) {
    const bank = require('./base').bankCounts()
    const name = Object.keys(bank).find(n => /_door$/.test(n) && !/iron/.test(n) && bank[n] > 0)
    if (name) await require('./base').withdraw(bot, name, 1).catch(() => 0)
    door = inv.items(bot).find(i => /_door$/.test(i.name) && !/iron/.test(i.name))
  }
  if (!door) { const w = craft().preferredWood(bot, 6); await craft().ensure(bot, w + '_door', 1, {}); door = inv.items(bot).find(i => /_door$/.test(i.name) && !/iron/.test(i.name)) }
  if (door) {
    // hang it from the step in line with the doorway so it faces through the wall, not along it
    const axisX = pl.door.x < pl.interior.x1 || pl.door.x > pl.interior.x2
    const steps = axisX ? [{ x: d.x + 1, y: d.y, z: d.z }, { x: d.x - 1, y: d.y, z: d.z }] : [{ x: d.x, y: d.y, z: d.z + 1 }, { x: d.x, y: d.y, z: d.z - 1 }]
    const me = world.feetPos(bot)
    const step = steps.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))[0]
    if (me.x !== step.x || me.z !== step.z) await move.goTo(bot, new move.goals.GoalBlock(step.x, step.y, step.z), { timeoutMs: 8000, dig: false, place: false, label: 'to the door step' }).catch(() => {})
    await act.place(bot, d, door.name, { faceHint: [[0, -1, 0]], allowZones: ['base', 'build'], sneak: false })
  }
  const now = world.at(bot, d.x, d.y, d.z)
  const ok = !!(now && /_door$/.test(now.name))
  log('hut', ok ? 'door hung again' : 'doorway open, no door to hang')
  return true
}

// A safehouse door hung facing along its wall blocks the doorway when open and blocks nothing when shut:
// take it down and hang it again from the step in line with the doorway.
function doorFacingWrong (bot) {
  const pl = mem.get().hutPlan
  if (!pl || !pl.door) return false
  const b = world.at(bot, pl.door.x, pl.home.y, pl.door.z)
  if (!b || !/_door$/.test(b.name)) return false
  let facing = null
  try { facing = b.getProperties().facing } catch {}
  if (!facing) return false
  const axisX = pl.door.x < pl.interior.x1 || pl.door.x > pl.interior.x2
  return axisX ? (facing === 'north' || facing === 'south') : (facing === 'east' || facing === 'west')
}
async function rehangDoor (bot) {
  const pl = mem.get().hutPlan
  const d = { x: pl.door.x, y: pl.home.y, z: pl.door.z }
  const axisX = pl.door.x < pl.interior.x1 || pl.door.x > pl.interior.x2
  const steps = axisX ? [{ x: d.x + 1, y: d.y, z: d.z }, { x: d.x - 1, y: d.y, z: d.z }] : [{ x: d.x, y: d.y, z: d.z + 1 }, { x: d.x, y: d.y, z: d.z - 1 }]
  const me = world.feetPos(bot)
  const step = steps.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))[0]
  log('hut', 'the door hangs the wrong way - hanging it again')
  await act.dig(bot, d, { force: true, allowZones: ['base', 'build'], timeoutMs: 8000 })
  await act.collectDrops(bot, { radius: 4, maxMs: 3000 })
  if (me.x !== step.x || me.z !== step.z) await move.goTo(bot, new move.goals.GoalBlock(step.x, step.y, step.z), { timeoutMs: 8000, dig: false, place: false, label: 'to the door step' }).catch(() => {})
  const door = inv.items(bot).find(i => /_door$/.test(i.name) && !/iron/.test(i.name))
  if (!door) return false
  await bot.lookAt(new (require('vec3').Vec3)(d.x + 0.5, d.y, d.z + 0.5), true).catch(() => {})
  await act.place(bot, d, door.name, { faceHint: [[0, -1, 0]], allowZones: ['base', 'build'], sneak: false })
  // a door that landed anywhere but the doorway comes straight back down
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (dx === 0 && dz === 0) continue
    const b = world.at(bot, d.x + dx, d.y, d.z + dz)
    if (b && /_door$/.test(b.name) && !/iron/.test(b.name)) { await act.dig(bot, b.position, { force: true, allowZones: ['base', 'build'] }); await act.collectDrops(bot, { radius: 4, maxMs: 2000 }) }
  }
  return !doorFacingWrong(bot)
}

// Walk around to the door, step in, close it. (The planner will not route through a door on this
// server, so "go to the middle of the hut" from the far side never finds a path.)
async function enterHut (bot, { shouldStop } = {}) {
  const pl = mem.get().hutPlan
  if (!pl || !pl.door) return false
  if (move.insideHut(world.feetPos(bot))) return true
  const d = pl.door
  const y = pl.home.y
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: d.x + dx, y, z: d.z + dz }))
  const outside = sides.find(c => !move.insideHut(c) && !(c.x >= pl.interior.x1 - 1 && c.x <= pl.interior.x2 + 1 && c.z >= pl.interior.z1 - 1 && c.z <= pl.interior.z2 + 1))
  const inside = sides.find(c => move.insideHut(c))
  if (!outside || !inside) return false
  const r = await move.goTo(bot, new move.goals.GoalBlock(outside.x, outside.y, outside.z), { timeoutMs: 60000, label: 'to the safehouse door', shouldStop })
  if (!r.ok) { log('hut', `couldn't reach the door step at ${move.fmt(outside)} (${r.why})`); return false }
  const crossed = await move.crossDoor(bot, { x: inside.x + 0.5, y: inside.y, z: inside.z + 0.5 })
  return crossed || move.insideHut(world.feetPos(bot))
}

// Clear leftover blocks standing on ground level y and fill holes AT ground level with dirt, in a box.
async function restoreGround (bot, x1, z1, x2, z2, groundY) {
  // the shared groundwork (ground.js); trees and leaves around the area stay
  return require('./ground').prepare(bot, { x1, z1, x2, z2, groundY, keep: b => world.LOG_RE.test(b.name) || world.LEAF_RE.test(b.name) }, { label: `ground around ${x1},${z1}..${x2},${z2}` })
}

function resetPlan () { plan = null; build.registerJob('hut', null) }

module.exports = { restoreGround, enterHut, buildHut, status, complete, shellComplete, getPlan, collidesWithBuild, relocate, resetPlan, layout, rememberBedSide, sealDoor, unsealDoor, utilitySpots, furnaceSpots, BANK_RINGS, doorFacingWrong, rehangDoor }
