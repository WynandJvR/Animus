'use strict'
// HOME: the bot's own hut - where it is, whether the bot is inside it, keeping it intact,
// and keeping it liveable. Split out of provision.js unchanged.
//
// This is the layer that answers "is this MY structure?" (ownHutAt / insideOwnStructure /
// onHutApron), the one that repairs and furnishes it (repairHutStructure, furnishHut,
// cleanupHutInterior, healHomeCrater), and the maintainHome chain the camp pass and the
// index.js home-repair reflex both drive.
//
// hut-model.js holds the PURE interior model (classifyCell, decideHutRepair); this file is
// the executor that reads the world through it and actually places blocks.
//
// LATE BINDING, and why: repairHutStructure / maintainHome / ensureHutBed legitimately call
// UP into the provisioning layer (runCraft, healBankDouble, consolidateBank, ensureSpawnBed,
// walkStaged, underArmored). Those are runtime calls, never module-load ones, so they go
// through a lazy require of provision.js - the same pattern provision.js already uses to
// reach commands.js. Threading six injected callbacks through this file instead would be
// noise, and a top-level require would be a genuine cycle.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const hutModel = require('./hut-model.js')   // PURE self-structure model + repair decision
const navigate = require('./navigate.js')    // unified navigation
const mining = require('./mining.js')        // PURE tool-durability model
const provCore = require('./provision-core.js')
const { AIRISH, REPLACEABLE, canBreakNaturally, countItem, inventoryCounts, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt, nearHostile, isNight } = provCore
const worldMemory = require('./world-memory.js')
const INFRA_BLOCK = { table: /crafting_table$/, furnace: /furnace$/, chest: /chest$/, bed: /_bed$/ } // refactor fix: the reconcileInfra consumer moved here but this const stayed (unexported) in world-memory.js -> ReferenceError
const { loadWorldMem, saveWorldMem, listInfra, rememberInfra, forgetInfra, recallInfra,
  recallInfraVerified, knownBed, rememberBed, forgetBed } = worldMemory

// The provisioning layer, resolved at CALL time (see the late-binding note above).
const P = () => require('./provision.js')
const S = () => require('./provision.js').__siblings // refactor fix: reach the __siblings-bridge walkStaged

let dbgSink = null // forwarded from provision.js's setDebugSink
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

let _hutSchemCache = null

const insideHutBox = (p, hut) => hutModel.inBox(hut, p.x, p.z)

function ownHutAt (pos) {
  if (!pos) return null
  const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
  for (const h of listInfra('hut')) {
    if (x >= h.x && x <= h.x + 5 && z >= h.z && z <= h.z + 5 && y >= h.y && y <= h.y + 4) return h
  }
  return null
}

function onHutApron (bot, pos) {
  const p = pos || bot.entity.position.floored()
  for (const h of listInfra('hut')) {
    if (p.x >= h.x - 2 && p.x <= h.x + 6 && p.z >= h.z - 2 && p.z <= h.z + 6) return h
  }
  return null
}

function insideOwnStructure (bot, pos) {
  const p = pos || (bot && bot.entity && bot.entity.position)
  return p ? ownHutAt(p) : null
}

function hasSolidCeiling (bot, upTo = 45, opts = {}) {
  if (!bot.entity) return false
  // Inside the bot's own hut: roofed, yes - underground, no. Without this the interior
  // read as a cave and every "buried" consumer (climb-out, travel surfacing, the fishing/
  // farming gates, /state hazards) misfired while the bot idled at home.
  if (insideOwnStructure(bot)) return false
  const base = bot.entity.position.floored()
  for (let dy = 2; dy <= upTo; dy++) {
    const b = bot.blockAt(base.offset(0, dy, 0))
    if (!b || AIRISH(b.name) || b.boundingBox !== 'block') continue
    // leaves have a 'block' bounding box but a canopy isn't a cave roof - so an
    // "underground" check (opts.ignoreLeaves) sees through a tree, while travelFar's
    // buried() check (default) still treats an overhang as cover.
    if (opts.ignoreLeaves && /_leaves$/.test(b.name)) continue
    return true
  }
  return false
}

function hutAnchor () { return (listInfra('hut')[0]) || null }

function hutReader (bot) { return (x, y, z) => bot.blockAt(new Vec3(x, y, z)) }

async function stepOffApron (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const h = onHutApron(bot)
  if (!h) return true // not on the apron - nothing to step off
  const tag = opts.tag || 'shaft'
  if (process.env.STONE_RELOCATE === '0') { // legacy one-shot: today's exact behavior
    const away = opts.home && (Math.abs(opts.home.x - h.x) > 8 || Math.abs(opts.home.z - h.z) > 8)
      ? new Vec3(opts.home.x, bot.entity.position.y, opts.home.z)
      : new Vec3(h.x + 12, bot.entity.position.y, h.z + 12)
    dbg('  ' + tag + ': on the hut apron - stepping clear to ' + Math.round(away.x) + ',' + Math.round(away.z) + ' before digging')
    // #80 APRON_DOOR_WALK: a raw goto has no door-assist, so from INSIDE the sealed hut every
    // step-off returned noPath instantly (live 03:22Z: all 4 dirs in <300ms, gathers starved).
    // walkStaged carries the door pre-flight + recovery rungs. =0 -> today's raw goto exactly.
    if (process.env.APRON_DOOR_WALK !== '0') { try { await S().walkStaged(bot, Math.round(away.x), Math.round(away.z), { isStopped, range: 3, timeoutMs: 20000 }) } catch {} } else { try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 3), 20000) } catch {} }
    return !onHutApron(bot)
  }
  // STONE_RELOCATE on: rotate the compass so a single wedged direction no longer sticks.
  const radius = opts.radius != null ? opts.radius : 12
  const tries = opts.tries != null ? opts.tries : 4
  for (let i = 0; i < tries && !isStopped(); i++) {
    const [dx, dz] = mining.DIRS[i % 4]
    const away = new Vec3(h.x + dx * radius, bot.entity.position.y, h.z + dz * radius)
    dbg('  ' + tag + ': on the hut apron - stepping clear (dir ' + i + ') to ' + Math.round(away.x) + ',' + Math.round(away.z))
    // #80 APRON_DOOR_WALK: same door-assist swap as the legacy path above (raw goto = instant
    // noPath from inside the sealed hut; walkStaged crosses the own-door first). =0 -> raw goto.
    if (process.env.APRON_DOOR_WALK !== '0') { try { await S().walkStaged(bot, Math.round(away.x), Math.round(away.z), { isStopped, range: 3, timeoutMs: 12000 }) } catch {} } else { try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 3), 12000) } catch {} }
    if (!onHutApron(bot) && !insideOwnStructure(bot)) return true
  }
  return !onHutApron(bot) && !insideOwnStructure(bot)
}

async function ensureHutApron (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const doorX = at.x + 2; const floorY = at.y; const outZ = at.z - 1
  // only bother if the door is actually there (its lower half sits at floorY+1)
  const dl = bot.blockAt(new Vec3(doorX, floorY + 1, at.z))
  if (!dl || !/_door$/.test(dl.name)) return 0
  // get within reach of the threshold
  try { await gotoWithTimeout(bot, new goals.GoalNearXZ(doorX, at.z, 2), 20000) } catch {}
  const DIRTLIKE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|tuff|gravel|netherrack)$/
  const ANYFILL = /(_planks|dirt|cobblestone|cobbled_deepslate|stone)$/
  const fillCell = async (wx, wy, wz) => {
    const b = bot.blockAt(new Vec3(wx, wy, wz))
    if (b && b.boundingBox === 'block' && !AIRISH(b.name)) return false // already solid
    let ok = await placeAt(bot, new Vec3(wx, wy, wz), DIRTLIKE) // cheap filler first (save planks)
    if (!ok) ok = await placeAt(bot, new Vec3(wx, wy, wz), ANYFILL)
    return ok
  }
  let filled = 0
  // door width +-1, the immediate step-out row. Fill support (floorY-1) THEN walk-surface (floorY),
  // bottom-up so each layer has a solid face beneath/beside to place against. A block at floorY tops
  // out flush with the inside floor -> a level walk through the door instead of a fall.
  for (let dx = -1; dx <= 1 && !isStopped(); dx++) {
    if (await fillCell(doorX + dx, floorY - 1, outZ)) filled++
    if (await fillCell(doorX + dx, floorY, outZ)) filled++
  }
  if (filled) { say(`sealed the doorstep - filled ${filled} apron cell(s) so the exit stays walkable`); dbg('  apron: filled ' + filled + ' doorstep cell(s) at ' + doorX + ',' + floorY + ',' + outZ) }
  return filled
}

async function healHomeCrater (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const reposition = opts.reposition !== false
  const floorY = at.y; const doorX = at.x + 2
  const DIRTLIKE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|tuff|gravel|netherrack)$/
  const ANYFILL = /(_planks|dirt|cobblestone|cobbled_deepslate|stone)$/
  const X0 = doorX - 2; const X1 = doorX + 5    // 414..421 - FULL crater width incl. the east pit
  const Z1 = at.z - 1; const Z0 = at.z - 4      // 84..81 - out to the crater's north edge
  const solidAt = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!(b && b.boundingBox === 'block' && !AIRISH(b.name)) }
  const inFootprint = (x, z) => (z >= at.z) || !!ownHutAt(new Vec3(x, floorY, z)) // NEVER inside the hut
  // Restore the WALK SURFACE (y=floorY) across the crater by BRIDGING outward from solid
  // ground - not a bottom-up depth fill, which can't be reached: from the doorstep the
  // pathfinder can't route ACROSS the open pit to the far (east) cells (live: 'none
  // placeable'). Instead place the nearest surface hole that has a solid face, STEP ONTO
  // it, and reach the next - exactly how a player bridges a gap. A 1-thick dirt surface is
  // stable (only sand/gravel fall) and stops the fall-in death; the air below is harmless.
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  // A cell is a real crater ONLY if it's not already walkable at natural grade: intact
  // ground sits one block LOW (grade top at floorY-1, feet at floorY), so a cell that is
  // solid at floorY-1 is fine even though floorY itself is air - filling it would build a
  // waist-high dirt shelf across intact apron (live bug). Only air at BOTH floorY and
  // floorY-1 is an actual pit to bridge.
  const targets = []
  for (let wz = Z1; wz >= Z0; wz--) for (let wx = X0; wx <= X1; wx++) {
    if (inFootprint(wx, wz)) continue
    if (!solidAt(wx, floorY, wz) && !solidAt(wx, floorY - 1, wz)) targets.push({ x: wx, z: wz })
  }
  const holes = targets.length
  if (!holes) return 0
  let filled = 0; let progress = true; let guard = 0
  while (targets.length && progress && guard++ < 80 && !isStopped()) {
    progress = false
    targets.sort((a, b) => bot.entity.position.distanceTo(new Vec3(a.x, floorY, a.z)) - bot.entity.position.distanceTo(new Vec3(b.x, floorY, b.z)))
    for (let i = 0; i < targets.length && !isStopped(); i++) {
      const t = targets[i]
      const sideN = N4.map(([dx, dz]) => ({ x: t.x + dx, z: t.z + dz })).filter(n => !inFootprint(n.x, n.z) && (solidAt(n.x, floorY, n.z) || solidAt(n.x, floorY - 1, n.z)))
      const belowSolid = solidAt(t.x, floorY - 1, t.z)
      if (!sideN.length && !belowSolid) continue // no face to place against yet - a nearer cell bridges here first
      const tv = new Vec3(t.x, floorY, t.z)
      if (bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) > 4.3) {
        if (!reposition) continue // doorway quick-pass: only what's reachable without walking
        let ok = false
        for (const n of sideN) { // stand ON a solid neighbour (its top) to get in reach
          try { await gotoWithTimeout(bot, new goals.GoalBlock(n.x, floorY + 1, n.z), 6000) } catch {}
          if (bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) <= 4.6) { ok = true; break }
        }
        if (!ok && bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) > 4.6) continue
      }
      let ok = await placeAt(bot, tv, DIRTLIKE) // cheap filler first (save planks)
      if (!ok) ok = await placeAt(bot, tv, ANYFILL)
      if (ok) { filled++; targets.splice(i, 1); i--; progress = true }
    }
  }
  if (filled) { say(`patched the creeper crater at my door - bridged ${filled} block(s) so it's walkable`); dbg('  crater heal: bridged ' + filled + '/' + holes + ' surface hole(s), x' + X0 + '-' + X1 + ' z' + Z0 + '-' + Z1 + (targets.length ? ' (' + targets.length + ' left for a later pass)' : '')) }
  else dbg('  crater heal: ' + holes + ' surface hole(s), none bridgeable from here' + (reposition ? '' : ' (no-reposition pass)'))
  return filled
}

async function ensureHutBed (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  // 1) already a bed standing in the footprint? assert spawn once, then leave it be.
  for (let dy = 0; dy <= 3 && !isStopped(); dy++) for (let dz = 0; dz <= 5; dz++) for (let dx = 0; dx <= 5; dx++) {
    const b = bot.blockAt(new Vec3(at.x + dx, at.y + dy, at.z + dz))
    if (b && /_bed$/.test(b.name)) {
      const kb = knownBed()
      // opts.force = the server anchor is KNOWN wrong (spawn-suspect) - a matching memory
      // proves nothing then; walk over and genuinely re-activate the bed.
      if (!opts.force && kb && kb.x === b.position.x && kb.y === b.position.y && kb.z === b.position.z) return 'present' // spawn already set here - don't re-trek every pass
      try { await gotoWithTimeout(bot, new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2), 15000) } catch {}
      try { await bot.activateBlock(b); rememberBed(b.position) } catch {}
      return 'present'
    }
  }
  // 2) carrying a bed? lay it on an interior floor cell. foot (2,1,2) + head (2,1,3): both must
  //    be air over a solid floor. (chest 4,1,1/2, furnace 4,1,4, table 1,1,4 are all clear of this.)
  let bedItem = (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name))
  if (!bedItem) {
    // No bed in the pack: wool is operator-supplied here (no sheep), so a spare bed
    // BANKED in the hut chest is the only other source - withdraw > craft > gather.
    try {
      const res = require('./resources.js') // lazy - resources requires provision at load
      const near = { x: at.x + 2, y: at.y + 1, z: at.z + 2 }
      const totals = await res.totalCounts(bot, { near, maxDist: 24 })
      const banked = Object.keys(totals).find(n => /_bed$/.test(n) && totals[n] > 0)
      if (banked) {
        dbg('  ensureHutBed: no bed in the pack but a ' + banked + ' is banked - withdrawing it')
        await res.withdrawItems(bot, banked, 1, { near })
        bedItem = (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name))
      }
    } catch (e) { dbg('  ensureHutBed: bank bed check failed (' + e.message + ')') }
  }
  if (!bedItem) return 'none'
  const foot = new Vec3(at.x + 2, at.y + 1, at.z + 2)
  const head = new Vec3(at.x + 2, at.y + 1, at.z + 3)
  for (const c of [foot, head]) {
    const cb = bot.blockAt(c); const fl = bot.blockAt(c.offset(0, -1, 0))
    if (cb && !AIRISH(cb.name)) { dbg('  ensureHutBed: interior spot blocked by ' + cb.name); return 'fail' }
    if (!fl || fl.boundingBox !== 'block') { dbg('  ensureHutBed: no solid floor under the bed spot'); return 'fail' }
  }
  try { await gotoWithTimeout(bot, new goals.GoalNear(foot.x, foot.y, foot.z, 2), 15000) } catch {}
  try {
    await bot.equip(bedItem, 'hand')
    await bot.lookAt(head.offset(0.5, 0.0, 0.5), true) // face +z so the head lays toward (2,1,3)
    await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0)), new Vec3(0, 1, 0))
  } catch (e) { dbg('  ensureHutBed: place failed (' + e.message + ')'); return 'fail' }
  await new Promise(r => setTimeout(r, 400))
  for (let dz = 0; dz <= 5; dz++) for (let dx = 0; dx <= 5; dx++) { // verify a bed actually landed, then set spawn
    const b = bot.blockAt(new Vec3(at.x + dx, at.y + 1, at.z + dz))
    if (b && /_bed$/.test(b.name)) {
      try { await bot.activateBlock(b); rememberBed(b.position) } catch {}
      say('set my bed in the hut - spawn point secured')
      return 'placed'
    }
  }
  dbg('  ensureHutBed: placement did not verify - bed still in pack')
  return 'fail'
}

function freeInteriorCell (bot, hut, near) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const cells = hutModel.freeStandCells(hut, hutReader(bot))
  if (!cells.length) return null
  const p = near || bot.entity.position
  cells.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
  const c = cells[0]
  return new Vec3(c.x, c.y, c.z)
}

function findHutDoorway (bot, hut) {
  const d = hutModel.doorwayColumn(hut, hutReader(bot), { preferDoorBlock: process.env.DOOR_CROSS_GEOMETRIC !== '0' })
  return d ? new Vec3(d.x, hut.y + 1, d.z) : null
}

function hutFreeCells (bot, hut) {
  return hutModel.freeStandCells(hut, hutReader(bot)).map(c => new Vec3(c.x, c.y, c.z))
}

function furnitureInHut (bot, hut, itemRe) {
  const read = hutReader(bot)
  for (const [x, z] of hutModel.interiorColumns(hut)) for (let dy = 0; dy < hutModel.DIMS.h; dy++) {
    const b = read(x, hut.y + dy, z)
    if (b && itemRe.test(b.name)) return new Vec3(x, hut.y + dy, z)
  }
  return null
}

async function furnishHut (bot, hut, { isStopped = () => false, say = () => {} } = {}) {
  const moved = []
  // MAINTENANCE, MODEL-DRIVEN: level the floor (fill real holes ONLY, never dump filler
  // into interior air), dig stray dirt/cobble (incl. head-height pillar remnants), remove
  // DUPLICATE stations, and reconcile the registry - all via the schema-correct 4x4 model
  // with a verified postcondition. This replaces the old hand-rolled floor/dedupe/declutter
  // passes that scanned a 3x3 (missing dx/dz 4) and could place filler at interior air.
  try { const r = await cleanupHutInterior(bot, hut, { isStopped, say }); if (r && (r.dug || r.removedDupes)) moved.push('tidy'); dbg('  furnish: interior maintained (' + JSON.stringify({ dug: r && r.dug, dupes: r && r.removedDupes, ok: r && r.ok }) + ')') } catch (e) { dbg('  furnish: interior maintenance failed (' + e.message + ')') }
  const grab = async (kind, nameRe) => { // dig a remembered outdoor one and pocket it
    if (furnitureInHut(bot, hut, nameRe)) return false // already have one inside - don't fetch another
    const e = listInfra(kind, bot).find(x => Math.hypot(x.x - hut.x, x.z - hut.z) <= 60 && !insideHutBox(x, hut))
    if (!e) return false
    const blk = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (!blk || !nameRe.test(blk.name)) { forgetInfra(kind, listInfra(kind).find(x => x.x === e.x && x.y === e.y && x.z === e.z)); return false }
    if (bot.entity.position.distanceTo(blk.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(e.x, e.y, e.z, 2), 30000) } catch { return false } }
    const tool = toolForBlock(bot, /furnace/.test(blk.name) ? 'stone' : 'oak_planks')
    if (tool) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(blk); await collectDrops(bot, 4) } catch (err) { dbg('  furnish: could not dig ' + kind + ' (' + err.message + ')'); return false }
    forgetInfra(kind, listInfra(kind).find(x => x.x === e.x && x.y === e.y && x.z === e.z))
    return true
  }
  const placeInside = async (kind, itemRe) => {
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => itemRe.test(i.name))) return false
    if (furnitureInHut(bot, hut, itemRe)) { dbg('  furnish: ' + kind + ' already inside - not duplicating'); return false }
    const cell = hutFreeCells(bot, hut)[0]
    if (!cell) { dbg('  furnish: no free cell for the ' + kind); return false }
    if (bot.entity.position.distanceTo(cell) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), 20000) } catch {} }
    if (!await placeAt(bot, cell, itemRe)) { dbg('  furnish: could not place ' + kind + ' - ' + (placeAt.lastFail || '?')); return false }
    rememberInfra(kind, cell); moved.push(kind)
    return true
  }
  try { if (await grab('furnace', /furnace/)) await placeInside('furnace', /^furnace$/) } catch (e) { dbg('  furnish: furnace move failed (' + e.message + ')') }
  try {
    let haveTable = (bot.inventory ? bot.inventory.items() : []).some(i => i.name === 'crafting_table')
    if (!haveTable) haveTable = await grab('table', /crafting_table/)
    if (haveTable) await placeInside('table', /^crafting_table$/)
  } catch (e) { dbg('  furnish: table move failed (' + e.message + ')') }
  // BED last and only when it's SAFE: digging the bed clears the spawn point until it's
  // re-placed and used - dying in that window means a world-spawn respawn far away.
  try {
    // A bed shoved into the doorway/threshold gets RELOCATED (operator: "it placed its
    // bed inside the door frame") - dig with pickup-verify; the placement below re-sites
    // it on the doorway-aware cells.
    const dw = findHutDoorway(bot, hut)
    if (dw) {
      const thr = new Vec3(dw.x + (dw.x === hut.x ? 1 : dw.x === hut.x + 4 ? -1 : 0), dw.y, dw.z + (dw.z === hut.z ? 1 : dw.z === hut.z + 4 ? -1 : 0))
      for (const p of [dw, thr]) {
        const b = bot.blockAt(p)
        if (b && /_bed$/.test(b.name)) {
          dbg('  furnish: bed is blocking the doorway - relocating it')
          if (bot.entity.position.distanceTo(p) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 20000) } catch {} }
          try {
            await bot.dig(b)
            for (let tries = 0; tries < 4 && !(bot.inventory ? bot.inventory.items() : []).some(i => /_bed$/.test(i.name)); tries++) { await collectDrops(bot, 6); await new Promise(r => setTimeout(r, 500)) }
            if ((bot.inventory ? bot.inventory.items() : []).some(i => /_bed$/.test(i.name))) forgetBed() // memory points at the dug spot
          } catch (e) { dbg('  furnish: doorway-bed dig failed (' + e.message + ')') }
          break
        }
      }
    }
    const kb = knownBed()
    if (kb && !insideHutBox(kb, hut) && Math.hypot(kb.x - hut.x, kb.z - hut.z) <= 150 && (bot.health || 20) >= 12 && !isNight(bot)) {
      await S().walkStaged(bot, kb.x, kb.z, { isStopped, range: 4, timeoutMs: 120000 })
      const bblk = bot.findBlock({ matching: b => /_bed$/.test(b.name), maxDistance: 6 })
      if (bblk) {
        try {
          await bot.dig(bblk)
          // VERIFY the bed ITEM is in the pack before moving on - a restart cut the
          // pickup off once and the bed despawned on the ground (spawn point lost, live).
          for (let tries = 0; tries < 4 && !(bot.inventory ? bot.inventory.items() : []).some(i => /_bed$/.test(i.name)); tries++) {
            await collectDrops(bot, 6)
            await new Promise(r => setTimeout(r, 500))
          }
          if ((bot.inventory ? bot.inventory.items() : []).some(i => /_bed$/.test(i.name))) forgetBed()
          else { say('i broke my bed and LOST it - i need a new one'); dbg('  furnish: bed item never landed in the pack') }
        } catch (e) { dbg('  furnish: bed dig failed (' + e.message + ')') }
      }
    }
    const bedItem = (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name))
    if (bedItem) {
      await S().walkStaged(bot, hut.x + 2, hut.z + 2, { isStopped, range: 4, timeoutMs: 120000 })
      // try up to 3 candidate pairs, VERIFYING the bed actually stands each time - a
      // phantom-swallowed placeBlock left the bed silently in the pack (live, no log line)
      const cells = hutFreeCells(bot, hut)
      let placedBed = false
      for (let attempt = 0; attempt < 3 && !placedBed && !isStopped(); attempt++) {
        let foot = null; let head = null
        for (const c of cells.slice(attempt)) { const n = cells.find(o => o.y === c.y && Math.abs(o.x - c.x) + Math.abs(o.z - c.z) === 1); if (n) { foot = c; head = n; break } }
        if (!foot) { dbg('  furnish: no 2-cell space for the bed'); break }
        // STAND OFF the bed's two cells before placing - the server rejects a bed placed
        // into the space the placer occupies (every attempt blockUpdate-timed-out, live)
        const stand = cells.find(c => !(c.x === foot.x && c.z === foot.z) && !(c.x === head.x && c.z === head.z) && Math.abs(c.x - foot.x) + Math.abs(c.z - foot.z) <= 3)
        if (stand) { try { await gotoWithTimeout(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), 12000) } catch {} }
        else if (bot.entity.position.distanceTo(foot) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(foot.x, foot.y, foot.z, 2), 15000) } catch {} }
        if (Math.floor(bot.entity.position.x) === foot.x && Math.floor(bot.entity.position.z) === foot.z) { dbg('  furnish: still standing on the bed cell - skipping this spot'); continue }
        const below = bot.blockAt(foot.offset(0, -1, 0))
        await bot.equip(bedItem, 'hand')
        try { await bot.lookAt(head.offset(0.5, 0.5, 0.5), true) } catch {}
        try { await bot.placeBlock(below, new Vec3(0, 1, 0)) } catch (e) { dbg('  furnish: bed place failed (' + e.message + ')') }
        await new Promise(r => setTimeout(r, 400))
        const nb = bot.blockAt(foot)
        if (nb && /_bed$/.test(nb.name)) {
          try { await bot.activateBlock(nb) } catch {} // day = sets spawn; night = sleeps
          rememberBed(foot); moved.push('bed'); placedBed = true
        } else dbg('  furnish: bed did not land at ' + foot.toString() + ' - trying another spot')
      }
    }
  } catch (e) { dbg('  furnish: bed move failed (' + e.message + ')') }
  // DOOR the doorway (operator: "no door on its hut so mobs and creepers can still
  // enter"): the shell schematic leaves a 2-high hole but owns no door block.
  try {
    let hasDoor = false
    for (let dx = 0; dx <= 4 && !hasDoor; dx++) {
      for (let dz = 0; dz <= 4 && !hasDoor; dz++) {
        for (let dy = 1; dy <= 2 && !hasDoor; dy++) {
          const b = bot.blockAt(new Vec3(hut.x + dx, hut.y + dy, hut.z + dz))
          if (b && /_door$/.test(b.name)) hasDoor = true
        }
      }
    }
    if (!hasDoor) {
      const doorway = (() => {
        const d = findHutDoorway(bot, hut)
        if (!d) return null
        const lo = bot.blockAt(d); const hi = bot.blockAt(d.offset(0, 1, 0)); const floor = bot.blockAt(d.offset(0, -1, 0))
        return (lo && AIRISH(lo.name) && hi && AIRISH(hi.name) && floor && floor.boundingBox === 'block') ? d : null
      })()
      if (doorway) {
        let door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name))
        if (!door) { try { await P().runCraft(bot, 'oak_door', 1, true, { isStopped, home: { x: hut.x, y: hut.y, z: hut.z } }) } catch (e) { dbg('  furnish: cannot craft a door (' + e.message + ')') } }
        door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name))
        if (door) {
          // stand OUTSIDE the gap facing the hut centre so the door hangs the right way
          const ox = doorway.x === hut.x ? -1 : doorway.x === hut.x + 4 ? 1 : 0
          const oz = doorway.z === hut.z ? -1 : doorway.z === hut.z + 4 ? 1 : 0
          try { await gotoWithTimeout(bot, new goals.GoalBlock(doorway.x + ox, doorway.y, doorway.z + oz), 15000) } catch {}
          try { await bot.lookAt(new Vec3(hut.x + 2.5, hut.y + 1.5, hut.z + 2.5), true) } catch {}
          const floor = bot.blockAt(doorway.offset(0, -1, 0))
          await bot.equip(door, 'hand')
          try { await bot.placeBlock(floor, new Vec3(0, 1, 0)); moved.push('door') } catch (e) { dbg('  furnish: door place failed (' + e.message + ')') }
        }
      } else dbg('  furnish: no doorway hole found to hang a door in')
    }
  } catch (e) { dbg('  furnish: door failed (' + e.message + ')') }
  // THRESHOLD APRON (operator: "hole in front of its door, it struggles entering"): the
  // 2 cells just outside the doorway get levelled to the door's floor so the bot walks
  // in and out flat. Runs every furnish, so a pit dug there later self-heals.
  try {
    const dwF = findHutDoorway(bot, hut)
    if (dwF) {
      const ox = dwF.x === hut.x ? -1 : dwF.x === hut.x + 4 ? 1 : 0
      const oz = dwF.z === hut.z ? -1 : dwF.z === hut.z + 4 ? 1 : 0
      const floorY = dwF.y - 1 // solid surface the door sits on
      // stand at the doorway (inside the door cell) so we can reach the apron pit from
      // above and build it up toward us - the bot can't stand IN the pit to fill it
      try { await gotoWithTimeout(bot, new goals.GoalBlock(dwF.x, dwF.y, dwF.z), 15000) } catch {}
      for (let step = 1; step <= 2 && !isStopped(); step++) {
        const ax = dwF.x + ox * step; const az = dwF.z + oz * step
        // clear anything blocking the 2-high walkway at floor level and above
        for (const dy of [0, 1]) {
          const b = bot.blockAt(new Vec3(ax, dwF.y + dy, az))
          if (b && !AIRISH(b.name) && canBreakNaturally(b)) {
            try {
              if (bot.entity.position.distanceTo(b.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(ax, dwF.y + dy, az, 2), 8000)
              const t = toolForBlock(bot, b.name); if (t) await bot.equip(t, 'hand').catch(() => {})
              await bot.dig(b); await collectDrops(bot, 2)
            } catch {}
          }
        }
        // fill the pit from the BOTTOM up to floor level (416,63 AND 416,64 were both air -
        // a single top placement had no support and failed, live). Find the lowest air
        // cell sitting on something solid and stack dirt upward.
        let guard = 7
        while (guard-- > 0 && !isStopped()) {
          const top = bot.blockAt(new Vec3(ax, floorY, az))
          if (top && !AIRISH(top.name) && !/water/.test(top.name)) break // walkway complete
          let py = floorY
          while (py > floorY - 6) {
            const here = bot.blockAt(new Vec3(ax, py, az)); const below = bot.blockAt(new Vec3(ax, py - 1, az))
            if (here && (AIRISH(here.name) || /water/.test(here.name)) && below && below.boundingBox === 'block') break
            py--
          }
          if (py <= floorY - 6) break // no solid base within reach - give up on this cell
          if (!await placeAt(bot, new Vec3(ax, py, az), /^(dirt|coarse_dirt|cobblestone)$/)) break
        }
      }
      dbg('  furnish: threshold apron levelled in front of the door')
    }
  } catch (e) { dbg('  furnish: threshold apron failed (' + e.message + ')') }
  if (moved.length) say('hut furnished - ' + moved.join(' + ') + ' moved indoors')
  return moved.length
}

function stationInHut (bot, kind, hut) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const cells = hutModel.stationCells(hut, hutReader(bot))[kind] || []
  return cells.length ? new Vec3(cells[0].x, cells[0].y, cells[0].z) : null
}

function stationSlot (bot, kind, desired = 1, hut) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const c = hutModel.stationSlot(hut, hutReader(bot), kind, desired)
  return c ? new Vec3(c.x, c.y, c.z) : null
}

async function loadHutSchem (version) {
  if (_hutSchemCache && _hutSchemCache.version === version) return _hutSchemCache.schem
  try {
    const schematic = require('./schematic.js') // lazy - schematic requires provision back
    const schem = await schematic.loadFile('hut.schem', version)
    _hutSchemCache = { version, schem }
    return schem
  } catch (e) { dbg('repairHut: schematic load failed (' + e.message + ')'); return null }
}

function reconcileInfra (bot) {
  const m = loadWorldMem()
  const infra = m.infra = m.infra || {}
  const summary = {}
  const hut = hutAnchor()
  const inHut = e => hut && hutModel.isInterior(hut, e.x, e.z) && e.y >= hut.y && e.y <= hut.y + hutModel.DIMS.h - 1
  for (const kind of ['table', 'furnace', 'chest', 'bed']) {
    const re = INFRA_BLOCK[kind]
    const list = (infra[kind] || []).slice()
    const verify = e => { const b = bot.blockAt(new Vec3(e.x, e.y, e.z)); if (b == null) return null; return re.test(b.name) }
    let { keep } = hutModel.reconcileCells(list, verify)
    summary[kind] = { was: list.length }
    // Re-seed the true in-hut stations (world scan) so real furniture is never lost from
    // memory, and phantom in-hut entries (cell now empty) are already gone from `keep`.
    if (hut) {
      const stations = hutModel.stationCells(hut, hutReader(bot))[kind] || []
      for (const s of stations) if (!keep.some(e => e.x === s.x && e.y === s.y && e.z === s.z)) keep.push({ x: s.x, y: s.y, z: s.z, at: Date.now() })
      // any KEEP entry that is inside the hut box but no longer a real station was already
      // dropped by verify; nothing more to do.
    }
    infra[kind] = keep
    summary[kind].now = keep.length
  }
  saveWorldMem()
  // Bed doubles as the spawn anchor - if one stands in the hut and m.bed is empty/stale,
  // point knownBed at it so ensureSpawnBed stops hunting a phantom.
  try {
    if (hut) {
      const beds = hutModel.stationCells(hut, hutReader(bot)).bed
      if (beds.length && (!m.bed || !bot.blockAt(new Vec3(m.bed.x, m.bed.y, m.bed.z)) || !/_bed$/.test((bot.blockAt(new Vec3(m.bed.x, m.bed.y, m.bed.z)) || {}).name || ''))) {
        rememberBed(new Vec3(beds[0].x, beds[0].y, beds[0].z))
        summary.bed.seededSpawn = true
      }
    }
  } catch (e) { dbg('reconcileInfra: bed/spawn reseed failed (' + e.message + ')') }
  dbg('reconcileInfra: ' + Object.entries(summary).map(([k, v]) => `${k} ${v.was}->${v.now}`).join(', '))
  return summary
}

async function cleanupHutInterior (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hut = hut || hutAnchor()
  if (!hut) return { ok: false, passes: 0, remaining: ['no hut registered'], dug: 0, removedDupes: 0 }
  const read = hutReader(bot)
  const maxPasses = opts.maxPasses || 4
  let dug = 0; let removedDupes = 0; let pass = 0
  const digAt = async (c) => {
    const p = new Vec3(c.x, c.y, c.z)
    const b = bot.blockAt(p)
    if (!b || AIRISH(b.name)) return false
    try {
      if (bot.entity.position.distanceTo(p) > 4) await navigate.gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 12000)
    } catch { /* dig test below still gates reach */ }
    const tool = toolForBlock(bot, b.name); if (tool) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) { dbg('  huttidy: cannot reach ' + b.name + ' at ' + p.toString() + ' this pass'); return false }
    try { await bot.dig(b); await collectDrops(bot, 3); return true } catch (e) { dbg('  huttidy: dig failed at ' + p.toString() + ' (' + e.message + ')'); return false }
  }
  for (pass = 1; pass <= maxPasses; pass++) {
    if (isStopped()) break
    // 1) stray filler (dig top-down so a pile clears cleanly)
    const strays = hutModel.strayCells(hut, read).sort((a, b) => b.y - a.y)
    for (const s of strays) { if (isStopped()) break; if (await digAt(s)) dug++ }
    // 2) duplicate stations: keep the FIRST of each kind, dig the rest (a second table
    //    boxes the bot in; only one is needed). Chests are exempt (a double chest is two
    //    legit adjacent cells) and so are beds (one bed, never dig the spawn anchor here).
    for (const kind of ['table', 'furnace']) {
      const cells = hutModel.stationCells(hut, read)[kind] || []
      for (let i = 1; i < cells.length; i++) {
        if (isStopped()) break
        if (await digAt(cells[i])) { removedDupes++; dbg('  huttidy: removed duplicate ' + kind + ' at ' + cells[i].x + ',' + cells[i].y + ',' + cells[i].z) }
      }
    }
    // 3) floor holes -> fill with carried filler (a hole wedges/traps; NOT a pillar - this
    //    is the floor level, anchor.y-1, the one place filling is legitimate indoors)
    for (const h of hutModel.floorHoles(hut, read)) {
      if (isStopped()) break
      try { await placeAt(bot, new Vec3(h.x, h.y, h.z), /^(dirt|coarse_dirt|cobblestone)$/) } catch {}
    }
    // VERIFY (fresh reads): clean iff no stray, <=1 table, <=1 furnace, no floor hole
    const strayLeft = hutModel.strayCells(hut, read)
    const st = hutModel.stationCells(hut, read)
    const holesLeft = hutModel.floorHoles(hut, read)
    const remaining = []
    if (strayLeft.length) remaining.push(strayLeft.length + ' stray')
    if (st.table.length > 1) remaining.push(st.table.length + ' tables')
    if (st.furnace.length > 1) remaining.push(st.furnace.length + ' furnaces')
    if (holesLeft.length) remaining.push(holesLeft.length + ' floor holes')
    dbg('  huttidy pass ' + pass + ': dug=' + dug + ' dupes=' + removedDupes + ' remaining=[' + remaining.join(', ') + ']')
    if (!remaining.length) { try { reconcileInfra(bot) } catch (e) { dbg('  huttidy: reconcile failed (' + e.message + ')') }; return { ok: true, passes: pass, remaining: [], dug, removedDupes } }
    if (pass === maxPasses) { try { reconcileInfra(bot) } catch {}; return { ok: false, passes: pass, remaining, dug, removedDupes } }
  }
  return { ok: false, passes: pass, remaining: ['stopped'], dug, removedDupes }
}

async function repairHutStructure (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hut = hut || hutAnchor()
  if (!hut) return { skipped: 'no hut' }
  if (process.env.HUT_REPAIR === '0') return { skipped: 'disabled' }
  // repairing under attack means standing still placing blocks while a mob hits us - defer.
  if (nearHostile(bot, 10) && P().underArmored(bot)) return { skipped: 'hostiles near' }
  const schem = await loadHutSchem(bot.version)
  if (!schem) return { skipped: 'no schematic' }
  const st = schem.start(); const en = schem.end()
  const AIRRE = /^(air|cave_air|void_air)$/
  const missPlank = []                 // world coords wanting a plank the world lacks
  let doorLower = null                  // world coord of the door's LOWER cell (place the item once)
  let doorPresent = false
  const missFurn = []                   // { pos, kind, item, re }
  const FURN = {
    chest: { item: 'chest', re: /chest$/ },
    furnace: { item: 'furnace', re: /^furnace$/ },
    crafting_table: { item: 'crafting_table', re: /^crafting_table$/ }
  }
  // 1) scan the schematic, block-read each cell, classify what's MISSING.
  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const w = schem.getBlock(new Vec3(x, y, z))
    if (!w || !w.name || AIRRE.test(w.name)) continue // schema wants air/interior - never fill
    const wp = new Vec3(hut.x + (x - st.x), hut.y + (y - st.y), hut.z + (z - st.z))
    const g = bot.blockAt(wp)
    if (!g) continue // unloaded chunk - skip this pass
    if (/_planks$/.test(w.name)) { if (!/_planks$/.test(g.name)) missPlank.push(wp) }
    else if (/_door$/.test(w.name)) {
      if (/_door$/.test(g.name)) { doorPresent = true } else if (!doorLower || wp.y < doorLower.y) doorLower = wp // lowest door cell = where the item goes
    } else if (/crafting_table$/.test(w.name)) { if (!FURN.crafting_table.re.test(g.name)) missFurn.push({ pos: wp, kind: 'table', item: 'crafting_table', re: FURN.crafting_table.re }) } else if (/^furnace$|furnace$/.test(w.name)) { if (!FURN.furnace.re.test(g.name)) missFurn.push({ pos: wp, kind: 'furnace', item: 'furnace', re: FURN.furnace.re }) } else if (/chest$/.test(w.name)) { if (!FURN.chest.re.test(g.name)) missFurn.push({ pos: wp, kind: 'chest', item: 'chest', re: FURN.chest.re }) }
  }
  const wantDoor = !!doorLower && !doorPresent
  const missing = missPlank.length + (wantDoor ? 1 : 0) + missFurn.length
  if (!missing) { dbg('repairHut: intact - no-op'); return { planks: 0, doors: 0, furniture: 0, missing: 0 } }
  dbg('repairHut: ' + missing + ' cell(s) off (planks ' + missPlank.length + ', door ' + (wantDoor ? 1 : 0) + ', furniture ' + missFurn.length + ') - patching')
  say('creeper damage on my hut - patching ' + missing + ' block(s)')
  const res = require('./resources.js')
  const near = { x: hut.x + 2, y: hut.y + 1, z: hut.z + 2 }
  // helper: dig a natural intruder occupying a cell we need (dirt washed in / grass), never a build block
  const clearCell = async (wp, keepRe) => {
    const b = bot.blockAt(wp)
    if (b && !AIRRE.test(b.name) && !keepRe.test(b.name) && canBreakNaturally(b)) {
      try { if (bot.entity.position.distanceTo(wp) > 4) await navigate.gotoOnce(bot, new goals.GoalNear(wp.x, wp.y, wp.z, 2), 8000); const t = toolForBlock(bot, b.name); if (t) await bot.equip(t, 'hand').catch(() => {}); await bot.dig(b) } catch {}
    }
  }
  // 2) SHELL PLANKS - acquire in one batch, place BOTTOM-UP (each course/roof cell then has a
  //    solid neighbour below/beside to place against). oak to match the schematic (any plank
  //    still works structurally, but matching keeps the camp's mismatch count quiet).
  let plankDone = 0
  if (missPlank.length) {
    try { await res.acquire(bot, 'oak_planks', Math.min(missPlank.length, 128), { near, batch: 64, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: plank acquire failed (' + e.message + ')') }
    for (const wp of missPlank.sort((a, b) => a.y - b.y)) {
      if (isStopped()) break
      const g = bot.blockAt(wp); if (g && /_planks$/.test(g.name)) { plankDone++; continue }
      if (!(bot.inventory ? bot.inventory.items() : []).some(i => /_planks$/.test(i.name))) { dbg('repairHut: out of planks - ' + (missPlank.length - plankDone) + ' wall cell(s) left'); break }
      await clearCell(wp, /_planks$/)
      if (bot.entity.position.distanceTo(wp) > 4) { try { await navigate.gotoOnce(bot, new goals.GoalNear(wp.x, wp.y, wp.z, 2), 12000) } catch {} }
      if (await placeAt(bot, wp, /_planks$/)) plankDone++
      else dbg('repairHut: could not place plank at ' + wp.toString() + ' (' + placeAt.lastFail + ')')
    }
  }
  // 3) DOOR - one item hangs the whole 2-tall door. Stand OUTSIDE facing the hut centre so it
  //    opens the right way (schematic door on the z0 wall opens toward -z).
  let doorDone = 0
  if (wantDoor) {
    let door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name))
    if (!door) { try { await res.acquire(bot, 'oak_door', 1, { near, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: door acquire failed (' + e.message + ')') } ; door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name)) }
    const floor = bot.blockAt(doorLower.offset(0, -1, 0))
    if (door && floor && floor.boundingBox === 'block') {
      const ox = doorLower.x === hut.x ? -1 : doorLower.x === hut.x + hutModel.DIMS.w - 1 ? 1 : 0
      const oz = doorLower.z === hut.z ? -1 : doorLower.z === hut.z + hutModel.DIMS.l - 1 ? 1 : 0
      try { await navigate.gotoOnce(bot, new goals.GoalBlock(doorLower.x + ox, doorLower.y, doorLower.z + oz), 12000) } catch {}
      try { await bot.lookAt(new Vec3(hut.x + 2.5, hut.y + 1.5, hut.z + 2.5), true) } catch {}
      try { await bot.equip(door, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)); doorDone++ } catch (e) { dbg('repairHut: door place failed (' + e.message + ')') }
    } else if (!door) dbg('repairHut: no door and could not craft one')
  }
  // 4) FURNITURE - place each missing chest/furnace/table at its exact cell (the schematic's
  //    two adjacent chests auto-merge into the double bank). Re-register so the infra registry
  //    knows the rebuilt station.
  let furnDone = 0
  for (const f of missFurn) {
    if (isStopped()) break
    const g = bot.blockAt(f.pos); if (g && f.re.test(g.name)) { furnDone++; continue }
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name === f.item)) {
      try { await res.acquire(bot, f.item, 1, { near, batch: 1, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: ' + f.item + ' acquire failed (' + e.message + ')') }
    }
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name === f.item)) { dbg('repairHut: no ' + f.item + ' to place (kept a wall/door open? gather short)'); continue }
    await clearCell(f.pos, f.re)
    if (bot.entity.position.distanceTo(f.pos) > 3) { try { await navigate.gotoOnce(bot, new goals.GoalNear(f.pos.x, f.pos.y, f.pos.z, 2), 12000) } catch {} }
    if (await placeAt(bot, f.pos, f.re)) { furnDone++; rememberInfra(f.kind === 'table' ? 'table' : f.kind, f.pos); dbg('repairHut: re-placed ' + f.kind + ' at ' + f.pos.toString()) } else dbg('repairHut: could not place ' + f.kind + ' at ' + f.pos.toString() + ' (' + placeAt.lastFail + ')')
  }
  try { reconcileInfra(bot) } catch {}
  const done = plankDone + doorDone + furnDone
  if (done) say('hut repaired - ' + [plankDone && plankDone + ' wall', doorDone && 'door', furnDone && furnDone + ' station'].filter(Boolean).join(' + ') + ' back')
  dbg('repairHut: patched planks ' + plankDone + '/' + missPlank.length + ', door ' + doorDone + '/' + (wantDoor ? 1 : 0) + ', furniture ' + furnDone + '/' + missFurn.length)
  return { planks: plankDone, doors: doorDone, furniture: furnDone, missing }
}

async function recallAndReach (bot, kind, blockId, maxDist, reach) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const known = recallInfra(kind, bot.entity.position, maxDist)
    if (!known) return null
    dbg('  remembered ' + kind + ' at ' + known.x + ',' + known.y + ',' + known.z + ' - reusing it instead of placing a new one')
    await S().walkStaged(bot, known.x, known.z, { range: 10, timeoutMs: 60000 })
    const blk = bot.blockAt(new Vec3(known.x, known.y, known.z))
    if (!blk || blk.type !== blockId) { dbg('  remembered ' + kind + ' is gone - forgetting it'); forgetInfra(kind, known); continue }
    if (await reach(blk)) return blk
    return null // it stands but we can't reach it - placing fresh beats looping
  }
  return null
}

async function maintainHut (bot, hut, opts = {}) {
  hut = hut || hutAnchor()
  if (!hut) return { skipped: 'no hut' }
  try { reconcileInfra(bot) } catch (e) { dbg('maintainHut: reconcile failed (' + e.message + ')') }
  // STRUCTURAL REPAIR first: a hole in the shell lets mobs in and the bank chest may be gone
  // (live: a creeper flattened the door, west wall, bank chest, furnace + bed). Idempotent.
  let repair = null
  try { repair = await repairHutStructure(bot, hut, opts) } catch (e) { dbg('maintainHut: structural repair failed (' + e.message + ')') }
  const read = hutReader(bot)
  let strays, st, holes
  try { strays = hutModel.strayCells(hut, read); st = hutModel.stationCells(hut, read); holes = hutModel.floorHoles(hut, read) } catch (e) { dbg('maintainHut: scan failed (' + e.message + ')'); return { skipped: e.message, repair } }
  const dirty = strays.length || (st.table.length > 1) || (st.furnace.length > 1) || holes.length
  if (!dirty) { dbg('maintainHut: interior already clean - no-op'); return { clean: !repair || !repair.missing, repair } }
  dbg('maintainHut: interior dirty (stray=' + strays.length + ' tables=' + st.table.length + ' furnaces=' + st.furnace.length + ' holes=' + holes.length + ') - tidying')
  const r = await cleanupHutInterior(bot, hut, opts)
  return { ...r, repair }
}

async function maintainHome (bot, hutAt, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hutAt = hutAt || hutAnchor()
  const out = { bed: null, chestFixed: false, repair: null, consolidated: 0, damaged: false }
  if (!hutAt) return out
  try { await ensureHutApron(bot, hutAt, { isStopped, say }) } catch (e) { dbg('camp: apron fill failed (' + e.message + ')') }
  // rebuild/verify the bed. Anything but 'present' means a bed was missing/placed/unplaceable
  // = the home needed work.
  try { const bs = await ensureHutBed(bot, hutAt, { isStopped, say }); out.bed = bs; dbg('camp: hut bed -> ' + bs); if (bs !== 'present') out.damaged = true } catch (e) { dbg('camp: hut bed failed (' + e.message + ')') }
  // BANK DOUBLE-CHEST HEAL (liveability, every pass): a rebuild that left the bank as two
  // mismatched single chests gets re-faced into one connected double. Idempotent: a merged
  // pair is a fast no-op (returns false).
  try { if (await P().healBankDouble(bot, { x: hutAt.x, y: hutAt.y, z: hutAt.z }, { isStopped, say })) { out.chestFixed = true; out.damaged = true; say('fixed the bank - one proper double chest again') } } catch (e) { dbg('camp: bank double-heal failed (' + e.message + ')') }
  // SPAWN re-assert (hourly no-op): a bed standing in the hut is worthless if the server
  // anchor drifted - use it again so every death keeps coming home.
  try { await P().ensureSpawnBed(bot, { isStopped, say }) } catch (e) { dbg('camp: spawn assert failed (' + e.message + ')') }
  // SELF-HEALING structure + interior (liveability, every pass): reconcile the registry, REPAIR
  // creeper damage (missing wall/door/furniture cells), then tidy the interior. Early no-op when
  // already clean+intact. repair.missing (0 = intact) is the cheap structural-damage signal.
  try { const mr = await maintainHut(bot, hutAt, { isStopped, say }); if (mr) { out.repair = mr.repair || null; if (mr.repair && mr.repair.missing) out.damaged = true; if (!mr.clean && !mr.skipped) { out.damaged = true; dbg('camp: hut self-heal -> ' + JSON.stringify({ ok: mr.ok, dug: mr.dug, dupes: mr.removedDupes, passes: mr.passes })) } } } catch (e) { dbg('camp: hut self-heal failed (' + e.message + ')') }
  // HOME BANK (operator promise): the hut chest is the ONE treasury - ferry every loose field
  // chest within 64 into it and pack the empties up. Idempotent.
  try { const nc = await P().consolidateBank(bot, hutAt, { isStopped, say }); if (nc) { out.consolidated = nc; out.damaged = true; dbg('camp: consolidated ' + nc + ' field chest(s) into the bank') } } catch (e) { dbg('camp: bank consolidation failed (' + e.message + ')') }
  return out
}

// SECURE_BASE (#67, default ON): spawn-proof the home. A base with only ~4 tunnel torches
// stays DARK, so mobs spawn all around every night and daylight-proof creepers/spiders linger
// to harass the bot AT HOME (nightRest: "no armor, mobs about"). A real player lights the
// perimeter + seals the shell. secureBase does both, as a bounded CALM-window step:
//   1) TORCH SUPPLY  - top up torches (ensureTorches; withdraw coal+stick from the bank if short).
//   2) LIGHT THE RING - place torches on solid ground on a spacing lattice around the hut (pure
//      baseTorchAnchors), targeting cells not yet lit; PERSIST each placed torch (world-mem
//      baseLight, keyed to the hut) so it converges across visits and self-heals a blown torch.
//   3) SEAL THE HUT  - reuse repairHutStructure to close wall/roof/door gaps mobs path through.
// Bounded (<=maxPlace torches/visit) and YIELDS to survival (isStopped). Never lights the crops
// (scaffold.onFarmFootprint) or inside the hut box. SECURE_BASE=0 -> the maintenance step never
// calls this (byte-for-byte); a direct call still early-returns here as a belt-and-braces guard.
async function secureBase (bot, opts = {}) {
  if (process.env.SECURE_BASE === '0') return { skipped: 'disabled', placed: 0 }
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const hut = opts.hut || hutAnchor()
  if (!hut) return { skipped: 'no hut', placed: 0 }

  const radius = Math.max(8, Math.min(32, Number(process.env.SECURE_BASE_RADIUS || 18)))
  const spacing = Math.max(4, Math.min(7, Number(process.env.SECURE_BASE_SPACING || 6)))
  const maxPlace = Math.max(1, Number(process.env.SECURE_BASE_MAX || 6))
  const darkTh = Number(process.env.SECURE_BASE_DARK || 8)
  const coverRadius = Math.max(2, Math.floor(spacing / 2))
  const want = Math.max(Number(process.env.SECURE_BASE_TORCHES || 12), maxPlace)

  // Persisted torched cells (world-mem), keyed to THIS hut so a relocated base starts fresh.
  const mem = loadWorldMem()
  let bl = mem.baseLight
  if (!bl || !bl.hut || bl.hut.x !== hut.x || bl.hut.z !== hut.z) { bl = mem.baseLight = { hut: { x: hut.x, z: hut.z }, torched: [] } }
  bl.torched = bl.torched || []
  // SELF-HEAL: forget any persisted torch the world no longer shows (a creeper blew it) so its
  // anchor re-opens and it gets re-lit. Keep entries whose chunk is unloaded (blockAt null).
  const beforeLen = bl.torched.length
  bl.torched = bl.torched.filter(t => { const b = bot.blockAt(new Vec3(t.x, t.y, t.z)); return !b || /torch/.test(b.name) })
  const healed = bl.torched.length !== beforeLen

  const anchors = hutModel.baseTorchAnchors(hut, { radius, spacing })
  let remaining = hutModel.secureBaseRemaining(anchors, bl.torched, { coverRadius })
  // Nearest-first: a bounded visit lights the closest dark ground, converging outward.
  const here = (bot.entity && bot.entity.position) || new Vec3(hut.x + 2, hut.y, hut.z + 2)
  remaining.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))

  // 1) TORCH SUPPLY - top up (never BLOCK on it; place what we have). Coal/stick from the bank
  //    (the #66 fuel path) then craft via the shared ensureTorches (bridge - mining owns it).
  if (remaining.length && countItem(bot, 'torch') < Math.min(want, remaining.length)) {
    try {
      const res = require('./resources.js')
      if (countItem(bot, 'coal') + countItem(bot, 'charcoal') < 1) { try { await res.withdrawItems(bot, 'coal', 8, { near: hut, maxDist: 64 }) } catch {} }
      if (countItem(bot, 'stick') < 1) { try { await res.withdrawItems(bot, 'stick', 4, { near: hut, maxDist: 64 }) } catch {} }
      await S().ensureTorches(bot, want)
    } catch (e) { dbg('  secureBase: torch supply failed (' + e.message + ')') }
  }

  // 2) LIGHT THE PERIMETER - bounded, survival-yielding. Reuse placeAt(/^torch$/) (the same
  //    primitive placeFarmTorches uses) at a solid, non-crop ground cell at/near each anchor.
  const scaffoldMod = (() => { try { return require('./scaffold.js') } catch { return null } })()
  const onFarm = (x, y, z) => { try { return !!(scaffoldMod && scaffoldMod.onFarmFootprint(new Vec3(x, y, z))) } catch { return false } }
  const NB = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
  let placed = 0
  for (const a of remaining) {
    if (isStopped() || placed >= maxPlace) break
    if (countItem(bot, 'torch') < 1) { dbg('  secureBase: out of torches - ' + (remaining.length - placed) + ' ring cell(s) still dark (resume next visit)'); break }
    let handled = false
    for (const [dx, dz] of NB) {
      if (handled) break
      const gx = a.x + dx; const gz = a.z + dz
      if (hutModel.inBox(hut, gx, gz)) continue // never inside the hut box
      for (let gy = hut.y + 3; gy >= hut.y - 3; gy--) { // scan a small Y band for the surface (grade isn't flat)
        const ground = bot.blockAt(new Vec3(gx, gy, gz))
        const air = bot.blockAt(new Vec3(gx, gy + 1, gz))
        if (!ground || ground.boundingBox !== 'block' || AIRISH(ground.name)) continue
        if (/water|lava|farmland/.test(ground.name)) continue
        if (!air || !AIRISH(air.name)) continue
        if (onFarm(gx, gy + 1, gz) || onFarm(gx, gy, gz)) { handled = true; break } // respect crops
        // LIGHT SKIP (best-effort; block-light is sparse on some servers): already bright enough?
        // defer without spending a torch. Not persisted, so it's cheaply re-checked next visit.
        try { const lv = air.light; if (typeof lv === 'number' && lv >= darkTh) { handled = true; break } } catch {}
        const cell = new Vec3(gx, gy + 1, gz)
        if (bot.entity && bot.entity.position.distanceTo(cell) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(gx, gy + 1, gz, 3), 8000) } catch {} }
        if (await placeAt(bot, cell, /^torch$/)) { placed++; bl.torched.push({ x: cell.x, y: cell.y, z: cell.z }); handled = true }
        break // this column's surface handled (placed or not); try the next neighbour column
      }
    }
  }
  if (placed || healed) { try { saveWorldMem() } catch {} }

  // 3) SEAL THE HUT - reuse the structural sealer (closes missing wall/roof/door cells so mobs
  //    can't path in). Idempotent no-op when the shell is intact.
  let sealed = null
  if (!isStopped()) { try { sealed = await repairHutStructure(bot, hut, { isStopped, say }) } catch (e) { dbg('  secureBase: seal failed (' + e.message + ')') } }

  if (placed) { dbg('  secureBase: lit ' + placed + ' perimeter cell(s) (ring ' + bl.torched.length + '/' + anchors.length + ' anchors)'); say('spawn-proofing home - lit ' + placed + ' dark spot(s) around the base') }
  return { placed, ringTorches: bl.torched.length, anchors: anchors.length, remaining: Math.max(0, remaining.length - placed), sealed }
}

// SEAL_HOME_DESCENTS (#89, default ON): CAP the cave/shaft mouths that funnel mobs up into the hut.
// secureBase (#67) only torches the SURFACE ring - nothing closes the UNDERGROUND routes. The bot's
// own abandoned mining descents (staircase entrances, failed shaft starts) are open ramps from the
// mob-filled cave straight up to the bed (live 08:17-08:20Z: 5 spawn-camp deaths in 4 min; and
// vanilla refuses sleep whenever a monster loiters in the bed's 8x5 box, walls notwithstanding).
// This bounded CALM-window step caps those openings within SEAL_RADIUS of home:
//   1) MINE-REGISTRY entrances (world-mem mines {x,z,top}): if the entrance column is an OPEN mouth
//      (airish cells leading down), place a solid filler cap at the entrance cell (x,top,z). The mine
//      record is KEPT (a future armored run may deliberately re-open it). The SINGLE most-recent
//      (active) mine is SKIPPED: enterExistingMine re-enters under gatherMovements, whose
//      blocksCantBreak denies every non-leaf block, so it can NOT dig through a cap - capping the
//      active mine would only orphan it (it forgets the record and re-digs elsewhere). Dormant older
//      mines are safe to seal (a later run re-opens them from scratch anyway).
//   2) DEATH-CLUSTER columns (grave ledger, last-48h, unretrieved, within SEAL_RADIUS): probe the
//      surface column above each death spot; an open hole (>=3 consecutive airish cells from the
//      local surface down) gets capped at its surface cell.
// Anti-grief (HARD): fills ONLY airish cells; NEVER on/inside the hut or its apron, the wheat-farm
// footprint, registered scaffold, or the castle build zone; every cap goes through the verified
// placeAt wrapper (world re-read). Bounded (<=SEAL_MAX_PER_PASS caps, SEAL_DEADLINE_MS deadline) and
// YIELDS to survival (isStopped re-checked before each cap). Material: FILLER_RE from the pack, else
// withdraw <=8 cobble from the bank (best-effort), else skip honestly. SEAL_HOME_DESCENTS=0 -> the
// maintenance step never calls this (byte-for-byte); a direct call still early-returns here.
async function sealHomeDescents (bot, opts = {}) {
  if (process.env.SEAL_HOME_DESCENTS === '0') return { skipped: 'disabled', capped: 0 }
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const hut = opts.hut || hutAnchor()
  if (!hut) return { skipped: 'no hut', capped: 0 }

  const radius = Math.max(8, Math.min(64, Number(process.env.SEAL_RADIUS || 32)))
  const maxCaps = Math.max(1, Number(process.env.SEAL_MAX_PER_PASS || 4))
  const deadline = Date.now() + Number(process.env.SEAL_DEADLINE_MS || 90000)

  const scaffoldMod = (() => { try { return require('./scaffold.js') } catch { return null } })()
  const FILLER_RE = (scaffoldMod && scaffoldMod.FILLER_RE) || /^(cobblestone|dirt|coarse_dirt|stone|gravel|andesite|diorite|granite|cobbled_deepslate|netherrack|tuff|deepslate)$/
  const haveFiller = () => (bot.inventory ? bot.inventory.items() : []).some(i => FILLER_RE.test(i.name))
  // MATERIAL: cobble/dirt from the pack; top up from the bank if bare (never BLOCK on it). Honest skip if none.
  if (!haveFiller()) {
    try { const res = require('./resources.js'); await res.withdrawItems(bot, 'cobblestone', 8, { near: hut, maxDist: 64 }) } catch {}
  }
  if (!haveFiller()) { dbg('  seal: no filler aboard and none banked - skipping this pass'); return { skipped: 'no filler', capped: 0 } }

  // anti-grief: cells we must NEVER cap. onHutApron covers the hut box + a 2-block apron ring (XZ).
  const onFarm = (x, y, z) => { try { return !!(scaffoldMod && scaffoldMod.onFarmFootprint(new Vec3(x, y, z))) } catch { return false } }
  const isScaffold = (x, y, z) => { try { return !!(scaffoldMod && scaffoldMod.isScaffold({ x, y, z })) } catch { return false } }
  const inBuild = (x, z) => { try { return !!P().inBuildZone(x, z) } catch { return false } }
  const protectedCell = (x, y, z) =>
    !!onHutApron(bot, new Vec3(x, y, z)) ||
    onFarm(x, y, z) || onFarm(x, y - 1, z) ||
    isScaffold(x, y, z) ||
    inBuild(x, z)

  // an OPEN descent mouth worth capping: the cap cell itself is airish (never replace a solid) AND
  // the shaft below leads down (>=3 consecutive airish cells from the cap cell going down).
  const openMouth = (x, capY, z) => {
    let run = 0
    for (let dy = 0; dy <= 3; dy++) {
      const b = bot.blockAt(new Vec3(x, capY - dy, z))
      if (b && AIRISH(b.name)) run++
      else break
    }
    return run >= 3
  }
  // death-hole surface cell: feet-level air over the highest intact NEIGHBOUR ground (matches the
  // mine 'top' = feet-Y semantics). null when no intact neighbour surface is loaded around it.
  const deathCapY = (x, z) => {
    let top = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let y = hut.y + 5; y >= hut.y - 8; y--) {
        const g = bot.blockAt(new Vec3(x + dx, y, z + dz)); const air = bot.blockAt(new Vec3(x + dx, y + 1, z + dz))
        if (g && g.boundingBox === 'block' && !AIRISH(g.name) && air && AIRISH(air.name)) { if (top == null || y + 1 > top) top = y + 1; break }
      }
    }
    return top
  }

  // 1) MINE ENTRANCES - skip the single most-recent (active) mine; only dormant older ones.
  const mines = (() => { try { return worldMemory.loadMines() } catch { return [] } })()
  const active = mines.length ? mines.reduce((a, b) => ((b.at || 0) > (a.at || 0) ? b : a)) : null
  const caps = []
  for (const m of mines) {
    if (m === active) continue
    if (m.top == null) continue
    if (Math.hypot(m.x - hut.x, m.z - hut.z) > radius) continue
    caps.push({ x: m.x, y: m.top, z: m.z, kind: 'mine-entrance' })
  }
  // 2) DEATH-CLUSTER HOLES - last-48h, unretrieved, within radius.
  const now = Date.now()
  const ledger = (() => { try { return require('./grave.js').ledger() } catch { return [] } })()
  for (const d of ledger) {
    if (!d || d.x == null || d.retrieved) continue
    if (now - (d.at || 0) >= 48 * 3600 * 1000) continue
    if (Math.hypot(d.x - hut.x, d.z - hut.z) > radius) continue
    const cy = deathCapY(Math.floor(d.x), Math.floor(d.z))
    if (cy != null) caps.push({ x: Math.floor(d.x), y: cy, z: Math.floor(d.z), kind: 'death-hole' })
  }

  // nearest-first so a bounded visit seals the closest ramps; place the verified caps.
  const here = (bot.entity && bot.entity.position) || new Vec3(hut.x + 2, hut.y, hut.z + 2)
  caps.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))
  let capped = 0
  for (const c of caps) {
    if (isStopped() || Date.now() > deadline || capped >= maxCaps) break
    const { x, y, z, kind } = c
    if (protectedCell(x, y, z)) continue
    if (!haveFiller()) { dbg('  seal: out of filler - ' + (caps.length - capped) + ' descent(s) still open (resume next visit)'); break }
    if (!openMouth(x, y, z)) continue
    const cell = new Vec3(x, y, z)
    if (bot.entity && bot.entity.position.distanceTo(cell) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(x, y, z, 3), 10000) } catch {} }
    // re-read after the walk (chunk may have (un)loaded / the world moved): re-gate before placing.
    if (protectedCell(x, y, z) || !openMouth(x, y, z)) continue
    if (await placeAt(bot, cell, FILLER_RE)) { capped++; dbg('  seal: capped descent at ' + x + ',' + y + ',' + z + ' (' + kind + ')') } else dbg('  seal: could not cap ' + kind + ' at ' + x + ',' + y + ',' + z + ' (' + placeAt.lastFail + ')')
  }
  if (capped) say('sealed ' + capped + ' open cave/shaft mouth(s) near home so mobs stop funnelling up to the hut')
  return { capped, candidates: caps.length }
}

// WORLD_TIDY (#94, default ON): actively RECLAIM orphaned litter near own infra. The scaffold
// registry is empty (interrupted ops + restarts + unregistered placements), so scaffold teardown
// alone cannot help - the world holds ~2 days of leveling/pillar scraps, cobble on the hut,
// floating dirt in the farm, and duplicate-torch clusters. This bounded CALM-window step SCANS
// within TIDY_RADIUS of each own infra anchor (hut, wheat-farm, orchard), classifies each
// filler/torch cell through the PURE hutModel.litterSignature, and digs up to TIDY_MAX verified
// digs/pass, collecting the drops and depositing the reclaimed filler to the bank (best-effort).
// Anti-grief (HARD): only filler-class or torch blocks; only within TIDY_RADIUS of OWN infra;
// NEVER in the castle build zone (P().inBuildZone), on a registered station/chest/bed cell, on
// schema-matching hut fabric, or on crops/farmland/saplings/trees; every dig RE-READS the world
// (re-classify + canDigBlock reach) before breaking. Bounded (<=TIDY_MAX digs, a scan cap, and
// isStopped-yielding). WORLD_TIDY=0 -> the maintenance step never calls this (byte-for-byte); a
// direct call still early-returns here as a belt-and-braces guard.
async function worldTidy (bot, opts = {}) {
  if (process.env.WORLD_TIDY === '0') return { skipped: 'disabled', reclaimed: 0 }
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const R = Math.max(8, Math.min(48, Number(process.env.TIDY_RADIUS || 24)))
  const MAX = Math.max(1, Number(process.env.TIDY_MAX || 24))
  const yBand = Math.max(2, Number(process.env.TIDY_Y_BAND || 6))
  const scanCap = Math.max(1000, Number(process.env.TIDY_SCAN_CAP || 40000)) // safety ceiling; near-first order + periodic yields keep it responsive
  const farmBand = Math.max(1, Number(process.env.TIDY_FARM_BAND || 3))
  const CROP_RE = /(wheat|carrots|potatoes|beetroots|_stem|pumpkin|melon|nether_wart|sweet_berry|cocoa)$/
  const TREE_RE = /(_sapling|_log|_wood|_leaves|mushroom|_stem)$/

  // --- own infra anchors + plot footprints --------------------------------------------
  const m = loadWorldMem()
  const anchors = []
  for (const h of listInfra('hut')) anchors.push({ x: h.x + 2, y: h.y, z: h.z + 2, hut: h })
  const plots = []
  const addPlot = (cells) => {
    if (!cells || !cells.length) return
    let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity; let cy = null
    for (const c of cells) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); z0 = Math.min(z0, c.z); z1 = Math.max(z1, c.z); if (c.y != null) cy = cy == null ? c.y : Math.min(cy, c.y) }
    if (cy == null) return
    plots.push({ x0, x1, z0, z1, loY: cy, hiY: cy + farmBand - 1 }) // cy = crop/sapling level; the ground below (cy-1) is never in-band
  }
  const wf = m.wheatFarm
  if (wf && wf.cells && wf.cells.length) { anchors.push({ x: wf.x, y: (wf.y != null ? wf.y : wf.cells[0].y), z: wf.z }); addPlot(wf.cells) }
  const orch = m.orchard
  if (orch && orch.cells && orch.cells.length) { anchors.push({ x: orch.x, y: orch.cells[0].y - 1, z: orch.z }); addPlot(orch.cells) }
  else if (orch && orch.x != null && orch.z != null) anchors.push({ x: orch.x, y: (bot.entity ? Math.floor(bot.entity.position.y) : 64), z: orch.z })
  if (!anchors.length) return { skipped: 'no infra', reclaimed: 0 }

  const huts = listInfra('hut')
  const DIMS = hutModel.DIMS
  // A cell on the hut wall-face/roof exterior layer (ABOVE the floor slab, so the doorstep apron
  // walk-surface at ground level is never touched). Returns the containing hut, else null.
  const hutExteriorOf = (x, y, z) => {
    for (const h of huts) {
      const x0 = h.x; const x1 = h.x + DIMS.w - 1; const z0 = h.z; const z1 = h.z + DIMS.l - 1; const y0 = h.y; const y1 = h.y + DIMS.h - 1
      if (y === y1 + 1 && x >= x0 && x <= x1 && z >= z0 && z <= z1) return h // resting on the roof
      if (y >= y0 + 1 && y <= y1) {
        const withinZ = z >= z0 && z <= z1; const withinX = x >= x0 && x <= x1
        if ((withinZ && (x === x0 - 1 || x === x1 + 1)) || (withinX && (z === z0 - 1 || z === z1 + 1))) return h // stuck to a wall face
      }
    }
    return null
  }
  const hutContaining = (x, z) => huts.find(h => hutModel.inBox(h, x, z)) || null
  const inFarmPlot = (x, y, z) => plots.some(p => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && y >= p.loY && y <= p.hiY)
  const inBuild = (x, z) => { try { return !!P().inBuildZone(x, z) } catch { return false } }
  const infraCells = []
  for (const kind of ['table', 'furnace', 'chest', 'bed']) for (const e of listInfra(kind)) infraCells.push(e)
  const kb = (() => { try { return knownBed() } catch { return null } })()
  if (kb) infraCells.push(kb)
  const isRegistered = (x, y, z) => infraCells.some(e => e.x === x && e.y === y && e.z === z)

  const read = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const airish = b => !b || AIRISH(b.name)
  const airFacesAt = (x, y, z) => {
    let n = 0
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (airish(read(x + dx, y + dy, z + dz))) n++
    return n
  }
  const sidesAirAt = (x, y, z) => {
    let n = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (airish(read(x + dx, y, z + dz))) n++
    return n
  }
  const towerRunAt = (x, y, z) => {
    let run = 1
    for (let dy = 1; dy <= 8; dy++) { const b = read(x, y + dy, z); if (b && hutModel.isTidyFiller(b.name)) run++; else break }
    for (let dy = 1; dy <= 8; dy++) { const b = read(x, y - dy, z); if (b && hutModel.isTidyFiller(b.name)) run++; else break }
    return run
  }
  const torchClusterAt = (x, y, z) => {
    const out = []
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const b = read(x + dx, y + dy, z + dz)
      if (b && hutModel.isTidyTorch(b.name)) out.push({ x: x + dx, y: y + dy, z: z + dz })
    }
    return out
  }
  // Build the per-cell ctx and classify. Cheap early-out: non-litter cells never do neighbour reads.
  const classifyAt = (x, y, z) => {
    const b = read(x, y, z)
    if (!b) return null
    const torch = hutModel.isTidyTorch(b.name)
    const filler = hutModel.isTidyFiller(b.name)
    if (!torch && !filler) return null // not a litter class - skip without any neighbour reads
    const hut = hutContaining(x, z)
    let hutSchemaFabric = false
    if (hut && y >= hut.y && y <= hut.y + DIMS.h - 1) { try { const c = hutModel.classifyCell(hut, hutReader(bot), x, y, z); hutSchemaFabric = c && (c.cls === 'wall' || c.cls === 'door' || c.cls === 'floor' || c.cls === 'furniture') } catch {} }
    const ctx = {
      name: b.name,
      self: { x, y, z },
      hutSchemaFabric,
      isFarmland: /farmland$/.test(b.name),
      isCrop: CROP_RE.test(b.name),
      isTree: TREE_RE.test(b.name),
      onHutExterior: !!hutExteriorOf(x, y, z),
      inFarmPlot: inFarmPlot(x, y, z),
      airFaces: torch ? 0 : airFacesAt(x, y, z),
      sidesAir: torch ? 0 : sidesAirAt(x, y, z),
      towerRun: torch ? 0 : towerRunAt(x, y, z),
      torchCluster: torch ? torchClusterAt(x, y, z) : null
    }
    return { b, ctx, res: hutModel.litterSignature(ctx) }
  }

  // --- SCAN: bounded box per anchor, NEAREST-COLUMN first so the examined budget is always spent
  // on the cells closest to home (litter clusters at the base) and a clean far world can't crowd
  // out near litter. Cheap early-out on non-litter cells (no neighbour reads). Yields the event
  // loop periodically so a large clean-world sweep never hitches the body ([[body-first-priority]]).
  const columns = []
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) { const d = Math.hypot(dx, dz); if (d <= R) columns.push({ dx, dz, d }) }
  columns.sort((a, b) => a.d - b.d)
  const seen = new Set()
  const candidates = []
  let examined = 0
  const candCap = MAX * 3
  scan:
  for (const a of anchors) {
    const ay = Math.floor(a.y)
    const yHi = ay + Math.max(yBand, DIMS.h + 2)
    for (const col of columns) {
      if (isStopped()) break scan
      const x = a.x + col.dx; const z = a.z + col.dz
      for (let y = ay - yBand; y <= yHi; y++) {
        const k = x + ',' + y + ',' + z
        if (seen.has(k)) continue
        seen.add(k)
        if (++examined > scanCap) break scan
        if ((examined & 4095) === 0) { if (isStopped()) break scan; await new Promise(r => setImmediate(r)) } // breathe
        const c = classifyAt(x, y, z)
        if (!c || c.res.decision !== 'dig') continue
        if (inBuild(x, z) || isRegistered(x, y, z)) continue // executor belt-and-braces
        candidates.push({ x, y, z, sig: c.res.sig, name: c.b.name })
        if (candidates.length >= candCap) break scan
      }
    }
  }
  if (!candidates.length) { dbg('  worldTidy: nothing to reclaim (examined ' + examined + ' cell(s) near ' + anchors.length + ' anchor(s))'); return { reclaimed: 0, candidates: 0, examined } }

  // nearest-first so a bounded visit clears the closest mess; verified digs up to MAX.
  const here = (bot.entity && bot.entity.position) || new Vec3(anchors[0].x, anchors[0].y, anchors[0].z)
  candidates.sort((p, q) => Math.hypot(p.x - here.x, p.z - here.z) - Math.hypot(q.x - here.x, q.z - here.z))
  let reclaimed = 0
  for (const c of candidates) {
    if (isStopped() || reclaimed >= MAX) break
    const p = new Vec3(c.x, c.y, c.z)
    if (bot.entity && bot.entity.position.distanceTo(p) > 4) { try { await navigate.gotoOnce(bot, new goals.GoalNear(c.x, c.y, c.z, 2), 10000) } catch {} }
    // RE-READ + re-classify after the walk (chunk (un)loaded / world moved / an earlier dig changed
    // the neighbourhood): re-gate before breaking, exactly the verified-dig contract.
    const re = classifyAt(c.x, c.y, c.z)
    if (!re || re.res.decision !== 'dig') continue
    if (inBuild(c.x, c.z) || isRegistered(c.x, c.y, c.z)) continue
    const b = re.b
    const tool = toolForBlock(bot, b.name); if (tool) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) { dbg('  worldTidy: cannot reach ' + b.name + ' at ' + p.toString() + ' this pass'); continue }
    try {
      await bot.dig(b)
      await collectDrops(bot, 3)
      const after = bot.blockAt(p)
      if (after && !AIRISH(after.name) && after.name === b.name) { dbg('  worldTidy: dig did not clear ' + b.name + ' at ' + p.toString()); continue }
      reclaimed++
      dbg('  tidy: reclaimed ' + c.name + ' at ' + c.x + ',' + c.y + ',' + c.z + ' (' + c.sig + ')')
    } catch (e) { dbg('  worldTidy: dig failed at ' + p.toString() + ' (' + e.message + ')') }
  }

  // BEST-EFFORT: deposit the reclaimed filler surplus to the bank (keep a small working buffer so
  // the sealer/scaffold still has filler on hand). Never blocks the pass; any failure is swallowed.
  if (reclaimed) {
    try {
      const bank = S().resolveBankCell(bot) // #94 fix: resolveBankCell lives on the __siblings bridge, not the facade (caught by the core builder's bridge audit)
      if (bank) {
        const keepEach = Math.max(0, Number(process.env.TIDY_KEEP_FILLER || 64))
        const deposits = []
        for (const it of (bot.inventory ? bot.inventory.items() : [])) {
          if (!hutModel.isTidyFiller(it.name)) continue
          const drop = it.count - keepEach
          if (drop > 0) deposits.push({ name: it.name, count: drop })
        }
        if (deposits.length) {
          const chestBlock = bot.blockAt(new Vec3(bank.x, bank.y, bank.z))
          if (chestBlock && /chest$/.test(chestBlock.name)) await P().depositMaterials(bot, chestBlock, { deposits })
        }
      }
    } catch (e) { dbg('  worldTidy: bank deposit failed (' + e.message + ')') }
    say('tidied up around home - reclaimed ' + reclaimed + ' bit(s) of litter')
    dbg('  worldTidy: reclaimed ' + reclaimed + ' litter block(s) of ' + candidates.length + ' candidate(s) (examined ' + examined + ')')
  }
  return { reclaimed, candidates: candidates.length, examined }
}

module.exports = {
  setDebugSink, insideHutBox,
  insideHutBox, ownHutAt, onHutApron, insideOwnStructure, hasSolidCeiling, hutAnchor, hutReader, stepOffApron, ensureHutApron, healHomeCrater, ensureHutBed, freeInteriorCell, findHutDoorway, hutFreeCells, furnitureInHut, furnishHut, stationInHut, stationSlot, loadHutSchem, reconcileInfra, cleanupHutInterior, repairHutStructure, recallAndReach, maintainHut, maintainHome,
  secureBase, secureBaseGate: hutModel.secureBaseGate,
  sealHomeDescents, sealDescentsGate: hutModel.sealDescentsGate,
  worldTidy, litterSignature: hutModel.litterSignature
}
