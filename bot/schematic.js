'use strict'
// Schematic loading + SURVIVAL physical building.
//
// Philosophy (see NOTES §natural-player): the bot builds like a NORMAL SURVIVAL
// PLAYER — it places real blocks from its own inventory, one by one, by hand.
// NO /fill, /setblock, /give, creative spawn, tp or fly anywhere. The player
// supplies materials; when the bot runs short it PAUSES and asks for exactly
// what it needs, then resumes.
//
// Parsing: modern sites export Sponge Schematic v3 (blocks nested under
// `Blocks.{Palette,Data}`), which prismarine-schematic 1.3.0 can't read — so we
// carry a small v3 adapter here and fall back to the stock reader for v1/v2/mcedit.
// Planning: we reuse mineflayer-builder's `Build` class ONLY for action ordering
// and face/orientation math. Its own build loop is creative-only (spawns items
// via bot.creative), so the placement loop below is our own, survival version.
//
// STATUS: download + parse + bill-of-materials are VERIFIED offline against real
// files. The buildSurvival() executor is written but UNTESTED — it needs live
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

// Where local .schem files live (also the download cache). Gitignored — runtime data.
const SCHEM_DIR = path.join(__dirname, 'schematics')

const AIR = /(^|_)air$/

// ---- download --------------------------------------------------------------

// Fetch a DIRECT url to a .schem/.litematic/.nbt file. Works with sites that
// serve real file URLs (e.g. https://buildingguide.app/schematics/<name>.schem).
// Sites that gate downloads behind JS / Cloudflare "server actions"
// (e.g. mineschematic.com) are NOT supported — paste a direct file link instead.
async function download (url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Animus bot)' } })
  if (!r.ok) throw new Error(`download ${r.status} ${r.statusText}`)
  const buf = Buffer.from(await r.arrayBuffer())
  // sanity: schematics are gzip (1f 8b) or raw NBT (0a 00). Anything else (e.g. an
  // HTML error page) is rejected so we fail loudly instead of parsing garbage.
  const gzip = buf[0] === 0x1f && buf[1] === 0x8b
  const rawNbt = buf[0] === 0x0a
  if (!gzip && !rawNbt) throw new Error(`not a schematic file (got ${buf.slice(0, 16).toString('utf8').replace(/[^\x20-\x7e]/g, '.')}…) — is this a DIRECT file link?`)
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
    // v1/v2 (sponge) or mcedit — the stock reader handles these.
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
        if (!b || AIR.test(b.name)) continue
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

// ---- SURVIVAL build executor (UNTESTED — needs live tuning) -----------------

// Movement profile used ONLY while building. Preserves the anti-grief rule that
// matters — canDig stays false, so the bot NEVER breaks existing blocks to path —
// but permits the *placement* a survival player uses to gain height: pillar-up and
// bridging with real blocks pulled from inventory. Restored afterwards by caller.
function buildMovements (bot) {
  const m = new Movements(bot)
  m.canDig = false           // never destroy existing blocks (anti-grief preserved)
  m.allow1by1towers = true   // may pillar up to reach height (real blocks, survival)
  m.canOpenDoors = true
  m.allowParkour = true
  // Scaffolding/bridging consumes real inventory blocks — restrict to cheap fillers
  // the player is likely to hand over, so it never spends build materials to walk.
  const md = require('minecraft-data')(bot.version)
  const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite']
  const ids = SCAFFOLD.map(n => md.itemsByName[n] && md.itemsByName[n].id).filter(x => x != null)
  if ('scafoldingBlocks' in m) m.scafoldingBlocks = ids
  return m
}

function haveItem (bot, name) {
  return (bot.inventory ? bot.inventory.items() : []).find(i => i.name === name) || null
}

// Pause and ask the player for a material, polling inventory until it arrives.
// Re-announces every ~15s. Returns true once we have it, false if stopped/aborted.
async function waitForMaterial (bot, name, { say, isStopped }, needed) {
  let last = 0
  for (;;) {
    if (isStopped && isStopped()) return false
    if (haveItem(bot, name)) return true
    const now = Date.now()
    if (say && now - last > 15000) {
      say(`I need ${needed ? needed + ' ' : 'more '}${name} to keep building — drop some by me?`)
      last = now
    }
    await new Promise(r => setTimeout(r, 2000))
  }
}

// pathfinder.goto with a hard deadline. Verified live: an unresolvable
// GoalPlaceBlock can hang goto FOREVER (froze a 432-block build at 50 for 10+
// minutes) — so we race it against a timer and cancel the goal on timeout.
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
// transient failure (couldn't reach it yet / no valid face right now) — the
// caller leaves it in the queue for a later pass. Never removes the action.
async function tryPlace (bot, build, action, item) {
  // Geometry (reused from the Build planner): valid faces + orientation. These
  // depend on which neighbours already exist, so a block with no face NOW may
  // gain one after adjacent blocks are placed — hence retried, not dropped.
  const properties = build.properties[action.state]
  const half = properties.half ? properties.half : properties.type
  const faces = build.getPossibleDirections(action.state, action.pos)
  if (!faces.length) return false
  const { facing, is3D } = build.getFacing(action.state, properties.facing)
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

// Build `schem` with its origin at world position `at`. Places blocks physically
// from inventory in survival, in repeated passes so blocks that only become
// reachable/placeable after their neighbours exist get retried (a single pass
// leaves gaps — verified live). opts: { say(msg), isStopped(), restoreMovements() }.
// Returns { placed, total, skipped, stopped, passes }.
async function buildSurvival (bot, schem, at, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const build = new Build(schem, bot.world, at)
  const total = build.actions.filter(a => a.type === 'place').length
  let placed = 0; let stopped = false; let passes = 0

  const moves = buildMovements(bot)
  bot.pathfinder.setMovements(moves)
  const key = p => `${p.x},${p.y},${p.z}`
  const deferred = new Set() // positions that failed THIS round; retried after progress
  let placedSinceDrain = 0
  try {
    for (;;) {
      if (isStopped()) { stopped = true; break }
      // Re-compute placeable actions EVERY iteration (adaptive: a block becomes
      // placeable once its neighbours exist), excluding ones already deferred
      // this round. We never dig, so only 'place' actions.
      const avail = build.getAvailableActions()
        .filter(a => a.type === 'place' && !deferred.has(key(a.pos)))
      if (avail.length === 0) {
        // Drained what's reachable right now. If we placed something since the last
        // drain, the deferred blocks may be reachable now — clear and retry them.
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
      // Ensure we hold the material — pause and ask the player if we're out.
      if (!haveItem(bot, item.name)) {
        const got = await waitForMaterial(bot, item.name, { say, isStopped })
        if (!got) { stopped = true; break }
      }
      const ok = await tryPlace(bot, build, action, item)
      if (ok) {
        build.removeAction(action); deferred.delete(key(action.pos))
        placed++; placedSinceDrain++
        if (placed % 25 === 0) say(`…${placed}/${total} blocks placed`)
      } else {
        deferred.add(key(action.pos)) // couldn't reach/place now — retry after progress
      }
    }
  } finally {
    bot.setControlState('sneak', false)
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements() // back to the anti-grief profile
  }
  const skipped = build.actions.filter(a => a.type === 'place').length
  return { placed, total, skipped, stopped, passes }
}

module.exports = {
  SCHEM_DIR,
  download,
  saveLocal,
  nameFromUrl,
  readSchematic,
  loadFile,
  billOfMaterials,
  materialsSummary,
  buildSurvival
}
