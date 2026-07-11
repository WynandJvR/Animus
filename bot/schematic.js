'use strict'
// Schematic loading + SURVIVAL physical building.
//
// Philosophy (see NOTES §natural-player): the bot builds like a NORMAL SURVIVAL
// PLAYER - it places real blocks from its own inventory, one by one, by hand.
// NO /fill, /setblock, /give, creative spawn, tp or fly anywhere. The player
// supplies materials; when the bot runs short it PAUSES and asks for exactly
// what it needs, then resumes.
//
// Parsing: modern sites export Sponge Schematic v3 (blocks nested under
// `Blocks.{Palette,Data}`), which prismarine-schematic 1.3.0 can't read - so we
// carry a small v3 adapter here and fall back to the stock reader for v1/v2/mcedit.
// Planning: we reuse mineflayer-builder's `Build` class ONLY for action ordering
// and face/orientation math. Its own build loop is creative-only (spawns items
// via bot.creative), so the placement loop below is our own, survival version.
//
// STATUS: download + parse + bill-of-materials are VERIFIED offline against real
// files. The buildSurvival() executor is written but UNTESTED - it needs live
// tuning on the server (reach, timing, pillar-up, scaffold cleanup).

const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { Schematic } = require('prismarine-schematic')
const { parseBlockName, getStateId } = require('prismarine-schematic/lib/states')
const { goals, Movements } = require('mineflayer-pathfinder')
const Build = require('mineflayer-builder/lib/Build')
const interactable = require('mineflayer-builder/lib/interactable.json')
const provision = require('./provision.js') // night-shelter during builds (shelterNeeded/digInForNight)

// DURABLE crash guard (re-applied here so a future `npm install` can't lose it, like
// the digTime guard in index.js). Build.getPossibleDirections reads a NEIGHBOUR block's
// `.shapes` (Build.js:114) to test placement faces; when that neighbour is null (an
// unloaded chunk or a cell at the world edge) it throws "Cannot read properties of null
// (reading 'shapes')" and kills the whole build. Wrap it so any such error just yields
// "no placeable face this pass" - the action is deferred and retried once the chunk
// loads / a neighbour is placed, instead of aborting the build.
if (Build.prototype && !Build.prototype._gpdGuarded) {
  const _gpd = Build.prototype.getPossibleDirections
  Build.prototype.getPossibleDirections = function (stateId, pos) {
    try { return _gpd.call(this, stateId, pos) } catch { return [] }
  }
  Build.prototype._gpdGuarded = true
}

// Where local .schem files live (also the download cache). Gitignored - runtime data.
const SCHEM_DIR = path.join(__dirname, 'schematics')

const AIR = /(^|_)air$/

// ---- download --------------------------------------------------------------

// Fetch a DIRECT url to a .schem/.litematic/.nbt file. Works with sites that
// serve real file URLs (e.g. https://buildingguide.app/schematics/<name>.schem).
// Sites that gate downloads behind JS / Cloudflare "server actions"
// (e.g. mineschematic.com) are NOT supported - paste a direct file link instead.
async function download (url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Animus bot)' } })
  if (!r.ok) throw new Error(`download ${r.status} ${r.statusText}`)
  const buf = Buffer.from(await r.arrayBuffer())
  // sanity: schematics are gzip (1f 8b) or raw NBT (0a 00). Anything else (e.g. an
  // HTML error page) is rejected so we fail loudly instead of parsing garbage.
  const gzip = buf[0] === 0x1f && buf[1] === 0x8b
  const rawNbt = buf[0] === 0x0a
  if (!gzip && !rawNbt) throw new Error(`not a schematic file (got ${buf.slice(0, 16).toString('utf8').replace(/[^\x20-\x7e]/g, '.')}…) - is this a DIRECT file link?`)
  return buf
}

// Save a downloaded buffer under schematics/ with a safe name; returns the path.
function saveLocal (name, buf) {
  if (!fs.existsSync(SCHEM_DIR)) fs.mkdirSync(SCHEM_DIR, { recursive: true })
  const safe = String(name).replace(/[^a-z0-9._-]/gi, '_').replace(/^_+/, '') || 'schematic'
  const file = path.join(SCHEM_DIR, safe.endsWith('.schem') ? safe : safe + '.schem')
  fs.writeFileSync(file, buf)
  return file
}

// Derive a filename from a URL's last path segment.
function nameFromUrl (url) {
  try { return path.basename(new URL(url).pathname) || 'schematic' } catch { return 'schematic' }
}

// ---- read (Sponge v3 adapter + stock fallback) -----------------------------

function byteArrayToVarintArray (byteArray) {
  const out = []
  let i = 0
  while (i < byteArray.length) {
    let value = 0; let len = 0
    while (true) {
      value |= (byteArray[i] & 127) << (len++ * 7)
      if (len > 5) throw new Error('VarInt too big (corrupted schematic data)')
      if ((byteArray[i++] & 128) !== 128) break
    }
    out.push(value)
  }
  return out
}

function parsePalette (mcData, palette) {
  const out = []
  for (const [str, id] of Object.entries(palette)) {
    const { name, properties } = parseBlockName(str)
    out[id] = getStateId(mcData, name, properties)
  }
  return out
}

// Read a schematic buffer into a prismarine-schematic Schematic, resolving block
// states against `version` (the SERVER version, so stateIds match what we build
// on). Handles Sponge v3 locally; delegates v1/v2/mcedit to the stock reader.
async function readSchematic (buffer, version) {
  const { parsed } = await nbt.parse(buffer)
  const s = nbt.simplify(parsed)
  const root = s.Schematic || s // v3 wraps everything under a "Schematic" compound
  const isV3 = root && root.Version === 3 && root.Blocks && root.Blocks.Data
  if (!isV3) {
    // v1/v2 (sponge) or mcedit - the stock reader handles these.
    return Schematic.read(buffer, version)
  }
  const mcData = require('minecraft-data')(version)
  const palette = parsePalette(mcData, root.Blocks.Palette)
  const size = new Vec3(root.Width, root.Height, root.Length)
  const off = root.Offset
  const offset = Array.isArray(off) ? new Vec3(off[0], off[1], off[2]) : new Vec3(0, 0, 0)
  const blocks = byteArrayToVarintArray(root.Blocks.Data)
  return new Schematic(version, size, offset, palette, blocks)
}

// Load from a local file path (absolute, or a bare name under schematics/).
async function loadFile (nameOrPath, version) {
  const p = fs.existsSync(nameOrPath)
    ? nameOrPath
    : path.join(SCHEM_DIR, nameOrPath.endsWith('.schem') ? nameOrPath : nameOrPath + '.schem')
  if (!fs.existsSync(p)) throw new Error(`no schematic file "${nameOrPath}" (looked in ${SCHEM_DIR})`)
  return readSchematic(fs.readFileSync(p), version)
}

// List the base names of every local .schem (no extension). Powers the
// natural-language "build <name>" lookup and the "I have: ..." feedback.
function listLocal () {
  try {
    return fs.readdirSync(SCHEM_DIR)
      .filter(f => /\.schem$/i.test(f))
      .map(f => f.replace(/\.schem$/i, ''))
  } catch { return [] } // dir doesn't exist yet -> no schematics
}

// Resolve a spoken schematic name ("my castle") to a saved file's base name.
// Match is fuzzy: compare on a normalized core (lowercase, alphanumeric only) so
// "big castle" finds big_castle.schem. Exact core first, then either-contains.
// Returns the base name (loadFile-ready) or null.
function findLocal (query) {
  const files = listLocal()
  if (!files.length) return null
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '')
  const q = norm(query)
  if (!q) return null
  let hit = files.find(f => norm(f) === q)
  if (hit) return hit
  hit = files.find(f => { const n = norm(f); return n && (n.includes(q) || q.includes(n)) })
  return hit || null
}

// ---- bill of materials -----------------------------------------------------

// Count every non-air block by name. Returns { counts: {name:n}, solid, types }.
function billOfMaterials (schem) {
  const counts = {}
  let solid = 0
  const st = schem.start(); const en = schem.end()
  for (let y = st.y; y <= en.y; y++) {
    for (let z = st.z; z <= en.z; z++) {
      for (let x = st.x; x <= en.x; x++) {
        const b = schem.getBlock(new Vec3(x, y, z))
        if (!b || !b.name || AIR.test(b.name)) continue // skip air / unresolved states
        counts[b.name] = (counts[b.name] || 0) + 1
        solid++
      }
    }
  }
  return { counts, solid, types: Object.keys(counts).length }
}

// Human-readable materials list, biggest first.
function materialsSummary (schem) {
  const { counts, solid, types } = billOfMaterials(schem)
  const lines = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c}x ${n}`)
  return { text: `${solid} blocks, ${types} types: ${lines.join(', ')}`, counts, solid, types }
}

// ---- SURVIVAL build executor -----------------------------------------------

// Cheap filler blocks the bot may pillar/bridge with (and which we clean up after).
const SCAFFOLD_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite']
// Natural obstructions we may clear from the build footprint before building
// (vegetation + soft terrain). NEVER crafted blocks - anti-grief holds.
// NOTE: matches plant blocks only. Use short_grass|tall_grass (NOT bare "grass"),
// or it also matches grass_block - which made prepSite strip the ground the build
// sits on (and dig it bare-handed). snow_layer, not snow_block, for the same reason.
const CLEARABLE = /short_grass|tall_grass|fern|flower|dandelion|poppy|tulip|orchid|allium|bluet|daisy|cornflower|lily|rose|sunflower|lilac|peony|snow_layer|leaves|vine|mushroom|sapling|dead_bush|sugar_cane|bamboo|sweet_berry|seagrass|moss_carpet|_carpet$|sprouts|roots|dripleaf|azalea/

// Movement profile used ONLY while building. Preserves the anti-grief rule that
// matters - canDig stays false, so the bot NEVER breaks existing blocks to path -
// but permits the *placement* a survival player uses to gain height: pillar-up and
// bridging with real blocks pulled from inventory. Restored afterwards by caller.
function buildMovements (bot) {
  const m = new Movements(bot)
  m.canDig = false           // never destroy existing blocks (anti-grief preserved)
  m.allow1by1towers = true   // may pillar up to reach height (real blocks, survival)
  m.canOpenDoors = true
  m.allowParkour = false     // WALK between placements instead of hopping every gap
                             // (build jumping was mostly parkour; pillaring for height stays)
  // Scaffolding/bridging consumes real inventory blocks - restrict to cheap fillers
  // the player is likely to hand over, so it never spends build materials to walk.
  const md = require('minecraft-data')(bot.version)
  const ids = SCAFFOLD_BLOCKS.map(n => md.itemsByName[n] && md.itemsByName[n].id).filter(x => x != null)
  if ('scafoldingBlocks' in m) m.scafoldingBlocks = ids
  return m
}

// World-position set of the schematic's SOLID cells, "x,y,z" keys.
function solidCellSet (schem, at) {
  const set = new Set()
  const st = schem.start(); const en = schem.end()
  for (let y = st.y; y <= en.y; y++) {
    for (let z = st.z; z <= en.z; z++) {
      for (let x = st.x; x <= en.x; x++) {
        const b = schem.getBlock(new Vec3(x, y, z))
        if (b && !AIR.test(b.name)) set.add(`${at.x + x},${at.y + y},${at.z + z}`)
      }
    }
  }
  return set
}

// Clear NATURAL obstructions (grass/flowers/leaves/snow…) inside the build
// footprint so vegetation/soft cover doesn't block placements or poke through.
// Only clearable blocks; never crafted ones. Best-effort.
async function prepSite (bot, schem, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const st = schem.start(); const en = schem.end()
  let cleared = 0
  for (let y = at.y + st.y; y <= at.y + en.y && !isStopped(); y++) {
    for (let z = at.z + st.z; z <= at.z + en.z; z++) {
      for (let x = at.x + st.x; x <= at.x + en.x; x++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b || AIR.test(b.name) || !CLEARABLE.test(b.name)) continue
        try {
          if (bot.entity.position.distanceTo(b.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(x, y, z, 3), 12000)
          if (bot.canDigBlock && bot.canDigBlock(b)) { await equipToolFor(bot, b.name); await bot.dig(b); cleared++ }
        } catch {}
      }
    }
  }
  return cleared
}

// Remove scaffold blocks the bot placed to gain height. We can't see what the
// pathfinder placed, so we diff: any block now present in the footprint (+margin)
// that WASN'T there before, isn't a schematic cell, and is a scaffold material.
async function cleanupScaffold (bot, schem, at, beforeSet, solidSet, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const md = require('minecraft-data')(bot.version)
  const scaffoldNames = new Set(SCAFFOLD_BLOCKS)
  const st = schem.start(); const en = schem.end()
  const M = 2 // horizontal margin (bridging can step just outside)
  let removed = 0
  for (let y = at.y + en.y; y >= at.y + st.y && !isStopped(); y--) { // top-down so towers unstack safely
    for (let z = at.z + st.z - M; z <= at.z + en.z + M; z++) {
      for (let x = at.x + st.x - M; x <= at.x + en.x + M; x++) {
        const key = `${x},${y},${z}`
        if (solidSet.has(key) || beforeSet.has(key)) continue // part of the build, or pre-existing
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b || AIR.test(b.name) || !scaffoldNames.has(b.name)) continue
        try {
          if (bot.entity.position.distanceTo(b.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(x, y, z, 3), 12000)
          if (bot.canDigBlock && bot.canDigBlock(b)) { await equipToolFor(bot, b.name); await bot.dig(b); removed++ }
        } catch {}
      }
    }
  }
  return removed
}

// Snapshot non-air blocks in the footprint (+margin) - the baseline for scaffold
// cleanup (so we only remove blocks WE added).
function snapshotRegion (bot, schem, at) {
  const set = new Set()
  const st = schem.start(); const en = schem.end()
  const M = 2
  for (let y = at.y + st.y; y <= at.y + en.y; y++) {
    for (let z = at.z + st.z - M; z <= at.z + en.z + M; z++) {
      for (let x = at.x + st.x - M; x <= at.x + en.x + M; x++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && !AIR.test(b.name)) set.add(`${x},${y},${z}`)
      }
    }
  }
  return set
}

function haveItem (bot, name) {
  return (bot.inventory ? bot.inventory.items() : []).find(i => i.name === name) || null
}

// Get a material we've run out of. FIRST try opts.fetch (e.g. withdraw a batch
// from the build's chest); only if that can't supply it do we fall back to asking
// the player and polling. Returns true once we have it, false if stopped/aborted.
// Returns: true = have it now; false = operator stopped; null = gave up after the deadline
// (caller should SKIP this material, not hang). The deadline is what stops an unattended
// from-nothing run from begging chat FOREVER for a material it can never obtain (iron_bars,
// wool, ...) - the old unbounded loop = a permanent stall / death-loop.
async function waitForMaterial (bot, name, { say, isStopped, fetch, deadlineMs = 240000 }, needed) {
  if (haveItem(bot, name)) return true
  // Try our own stash (chest) first, so a self-provisioned build never begs.
  if (fetch) {
    try { await fetch(name) } catch { /* chest gone / empty - fall through to asking */ }
    if (haveItem(bot, name)) return true
  }
  const start = Date.now()
  let last = 0
  for (;;) {
    if (isStopped && isStopped()) return false
    if (haveItem(bot, name)) return true
    // retry the stash occasionally too (more may have been produced/stored)
    if (fetch) { try { await fetch(name) } catch {} ; if (haveItem(bot, name)) return true }
    if (Date.now() - start > deadlineMs) return null // gave up - skip this material and move on
    const now = Date.now()
    if (say && now - last > 15000) {
      say(`I need ${needed ? needed + ' ' : 'more '}${name} to keep building - drop some by me? (skipping it soon if not)`)
      last = now
    }
    await new Promise(r => setTimeout(r, 2000))
  }
}

// pathfinder.goto with a hard deadline. Verified live: an unresolvable
// GoalPlaceBlock can hang goto FOREVER (froze a 432-block build at 50 for 10+
// minutes) - so we race it against a timer and cancel the goal on timeout.
function gotoWithTimeout (bot, goal, ms) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { bot.pathfinder.setGoal(null) } catch {}
      reject(new Error('goto timed out'))
    }, ms)
    bot.pathfinder.goto(goal).then(
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } },
      e => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } }
    )
  })
}

// Attempt ONE placement. Returns true if the block was placed, false on a
// transient failure (couldn't reach it yet / no valid face right now) - the
// caller leaves it in the queue for a later pass. Never removes the action.
async function tryPlace (bot, build, action, item) {
  // Geometry (reused from the Build planner): valid faces + orientation. These
  // depend on which neighbours already exist, so a block with no face NOW may
  // gain one after adjacent blocks are placed - hence retried, not dropped.
  const properties = build.properties[action.state]
  const half = properties.half ? properties.half : properties.type
  const faces = build.getPossibleDirections(action.state, action.pos)
  if (!faces.length) return false
  // getFacing throws on any facing-bearing block missing from mineflayer-builder's stale
  // facingData.json (newer 1.21 stairs/doors: cherry/bamboo/copper/pale_oak...). Unguarded
  // that crash aborts the ENTIRE build (and clears the resume). Fall back to an unoriented
  // placement - the block still goes down, at worst mis-rotated - never crash the build.
  let facing, is3D
  try { ({ facing, is3D } = build.getFacing(action.state, properties.facing)) } catch { facing = undefined; is3D = false }
  const goal = new goals.GoalPlaceBlock(action.pos, bot.world, { faces, facing, facing3D: is3D, half })

  if (!goal.isEnd(bot.entity.position.floored())) {
    try { await gotoWithTimeout(bot, goal, 20000) } catch (e) { return false } // can't reach yet
  }
  await bot.equip(haveItem(bot, item.name), 'hand').catch(() => {})

  const faceAndRef = goal.getFaceAndRef(bot.entity.position.floored().offset(0.5, 1.6, 0.5))
  if (!faceAndRef) return false
  await bot.lookAt(faceAndRef.to, true).catch(() => {})
  const refBlock = bot.blockAt(faceAndRef.ref)
  const sneak = refBlock && interactable.indexOf(refBlock.name) > 0 // sneak so we don't OPEN a chest/door instead of placing on it
  const delta = faceAndRef.to.minus(faceAndRef.ref)
  if (sneak) bot.setControlState('sneak', true)
  try {
    await bot._placeBlockWithOptions(refBlock, faceAndRef.face.scaled(-1), { half, delta })
    await new Promise(r => setTimeout(r, 120)) // let the block-update settle (Paper) + natural pacing
    return true
  } catch (e) {
    return false
  } finally {
    if (sneak) bot.setControlState('sneak', false)
  }
}

// Equip the best available tool for a block KIND (pickaxe/shovel/axe) so clearing
// is fast; barehanded if we own no matching tool. Never fails the caller.
async function equipToolFor (bot, blockName) {
  let kind = null
  if (/stone|cobble|ore|deepslate|granite|diorite|andesite|tuff|basalt|blackstone|furnace|obsidian|brick|concrete|terracotta/.test(blockName)) kind = 'pickaxe'
  else if (/dirt|grass|sand|gravel|clay|soul|podzol|mycelium|farmland|_path|mud|snow/.test(blockName)) kind = 'shovel'
  else if (/log|_wood|plank|leaves|fence|_door|slab|stairs|planks/.test(blockName)) kind = 'axe'
  if (!kind) return
  const tool = (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_' + kind))
  if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
}

// CLEAR the schematic's whole volume down to air, so a build can go up on unflat
// ground (the placer skips digs, so terrain intruding into the box otherwise
// permanently blocks those cells - the cause of low placement rates on slopes).
// Removes every breakable solid in the [start..end] box, top-down, in a few
// passes (some blocks only become reachable after those above them are gone).
// Scoped to the build footprint the operator chose - it never touches anything
// outside the box. Returns the number of blocks removed.
async function clearVolume (bot, schem, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const st = schem.start(); const en = schem.end()
  bot.pathfinder.setMovements(buildMovements(bot)) // may pillar/bridge to reach; we dig manually
  let removed = 0
  try {
    for (let pass = 0; pass < 4; pass++) {
      let did = 0
      for (let y = at.y + en.y; y >= at.y + st.y && !isStopped(); y--) {
        for (let z = at.z + st.z; z <= at.z + en.z; z++) {
          for (let x = at.x + st.x; x <= at.x + en.x; x++) {
            const b = bot.blockAt(new Vec3(x, y, z))
            if (!b || AIR.test(b.name)) continue
            // Don't destroy a cell that ALREADY matches the schematic - it's part of
            // the finished build (the Build planner skips such cells, so clearing them
            // just punches permanent holes; seen live: stone box on stone terrain).
            const want = schem.getBlock(new Vec3(x - at.x, y - at.y, z - at.z))
            if (want && !AIR.test(want.name) && want.name === b.name) continue
            try {
              // WALK to the block first - canDigBlock includes a REACH check, so
              // testing it before approaching would skip every out-of-reach block.
              if (bot.entity.position.distanceTo(b.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(x, y, z, 3), 12000)
              if (bot.canDigBlock && bot.canDigBlock(b)) { // now in range: bedrock/liquid still false
                await equipToolFor(bot, b.name)
                await bot.dig(b); removed++; did++
              }
            } catch { /* unreachable this pass - retried next pass */ }
          }
        }
      }
      if (!did) break // nothing left reachable -> done
    }
  } finally { bot.pathfinder.setGoal(null) }
  return removed
}

// Build `schem` with its origin at world position `at`. Places blocks physically
// from inventory in survival, in repeated passes so blocks that only become
// reachable/placeable after their neighbours exist get retried (a single pass
// leaves gaps - verified live). opts: { say(msg), isStopped(), restoreMovements(),
// clear(bool) - flatten the footprint first }.
// Returns { placed, total, skipped, stopped, passes }.
async function buildSurvival (bot, schem, at, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const build = new Build(schem, bot.world, at)
  const total = build.actions.filter(a => a.type === 'place').length
  let placed = 0; let stopped = false; let passes = 0; let matSkipped = 0

  const moves = buildMovements(bot)
  bot.pathfinder.setMovements(moves)
  const key = p => `${p.x},${p.y},${p.z}`
  const deferred = new Set() // positions that failed THIS round; retried after progress
  let placedSinceDrain = 0
  let cleared = 0; let clearedSolids = 0; let scaffoldRemoved = 0
  // The schematic's own solid cells (never scaffold-cleaned).
  const solidSet = solidCellSet(schem, at)
  let beforeSet
  try {
    // Optional: flatten the site by emptying the whole build box first, so builds
    // on unflat ground still complete (terrain intruding into the box would else
    // permanently block those cells). Then snapshot the (now-cleared) region as
    // the scaffold-cleanup baseline.
    if (opts.clear) {
      try { clearedSolids = await clearVolume(bot, schem, at, { isStopped }) } catch {}
      if (clearedSolids) say(`cleared ${clearedSolids} block(s) to flatten the site`)
      bot.pathfinder.setMovements(moves) // clearVolume reset movements; restore build profile
    }
    beforeSet = snapshotRegion(bot, schem, at)
    // Clear natural cover (grass/flowers/leaves…) from the footprint first.
    if (opts.prep !== false) { try { cleared = await prepSite(bot, schem, at, { isStopped }) } catch {} }
    if (cleared) say(`cleared ${cleared} bit(s) of vegetation`)
    let lastShelter = 0
    for (;;) {
      if (isStopped()) { stopped = true; break }
      // NIGHT SHELTER (same as gatherLoop/runSmelt): a naked bot placing blocks at night is
      // a stationary target - it died at 29/44 to night mobs (verified live). Dig in, wait
      // it out, then carry on building.
      if (provision.shelterNeeded(bot) && Date.now() - lastShelter > 15000) {
        lastShelter = Date.now()
        say('mobs out and no armor - digging in till it\'s safe')
        try { await provision.digInForNight(bot, { isStopped, say }) } catch {}
        bot.pathfinder.setMovements(moves) // the shelter reset movements - restore the build profile
        continue
      }
      // Re-compute placeable actions EVERY iteration (adaptive: a block becomes
      // placeable once its neighbours exist), excluding ones already deferred
      // this round. We never dig, so only 'place' actions.
      const avail = build.getAvailableActions()
        .filter(a => a.type === 'place' && !deferred.has(key(a.pos)))
      if (avail.length === 0) {
        // Drained what's reachable right now. If we placed something since the last
        // drain, the deferred blocks may be reachable now - clear and retry them.
        if (deferred.size && placedSinceDrain > 0) { deferred.clear(); placedSinceDrain = 0; passes++; continue }
        break // nothing reachable and no progress -> the rest is genuinely blocked
      }
      // Nearest to the bot's CURRENT position (adaptive ordering as it moves).
      avail.sort((a, b) =>
        a.pos.offset(0.5, 0.5, 0.5).distanceSquared(bot.entity.position) -
        b.pos.offset(0.5, 0.5, 0.5).distanceSquared(bot.entity.position))
      const action = avail[0]

      const item = build.getItemForState(action.state)
      if (!item) { build.removeAction(action); continue } // truly unplaceable (tech block)
      // Ensure we hold the material - pull from our chest (opts.fetch) if we have one, else
      // pause and ask the player. Materials the provisioner already flagged UNOBTAINABLE (or
      // gave up on) are in opts.skip: don't even wait - drop those placements so the build
      // finishes with what it CAN make instead of hanging forever on the first iron_bar.
      if (!haveItem(bot, item.name)) {
        if (opts.skip && opts.skip.has(item.name)) { build.removeAction(action); matSkipped++; continue }
        const got = await waitForMaterial(bot, item.name, { say, isStopped, fetch: opts.fetch, deadlineMs: opts.materialDeadlineMs }, action.count)
        if (got === false) { stopped = true; break }        // operator stopped
        if (got === null) { // gave up after the deadline - skip this material everywhere
          if (opts.skip) opts.skip.add(item.name)
          say(`can't get ${item.name} - skipping it and finishing the rest`)
          build.removeAction(action); matSkipped++; continue
        }
      }
      const ok = await tryPlace(bot, build, action, item)
      if (ok) {
        build.removeAction(action); deferred.delete(key(action.pos))
        placed++; placedSinceDrain++
        if (placed % 25 === 0) say(`…${placed}/${total} blocks placed`)
      } else {
        deferred.add(key(action.pos)) // couldn't reach/place now - retry after progress
      }
    }
    // Tidy up: pull down the scaffold blocks we placed to gain height.
    if (opts.cleanup !== false && !isStopped()) {
      try { scaffoldRemoved = await cleanupScaffold(bot, schem, at, beforeSet, solidSet, { isStopped }) } catch {}
      if (scaffoldRemoved) say(`removed ${scaffoldRemoved} scaffold block(s)`)
    }
  } finally {
    bot.setControlState('sneak', false)
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements() // back to the anti-grief profile
  }
  const skipped = build.actions.filter(a => a.type === 'place').length + matSkipped
  return { placed, total, skipped, stopped, passes, cleared, scaffoldRemoved }
}

module.exports = {
  SCHEM_DIR,
  download,
  saveLocal,
  nameFromUrl,
  readSchematic,
  loadFile,
  listLocal,
  findLocal,
  billOfMaterials,
  materialsSummary,
  buildSurvival,
  clearVolume
}
