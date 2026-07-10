'use strict'
// Provisioning: turn a bill of materials into a gather/craft/smelt plan and
// execute it - the "self-sufficient builder" half of schematic building.
// The bot ACQUIRES everything like a real survival player: chop trees, mine
// natural blocks, craft chains (logs→planks→stairs), smelt (sand→glass).
// No /give, no creative - see NOTES §10 + the natural-player goal.
//
// planProvision() is pure (mcData + counts in, task list out) and offline-
// testable. run*() helpers execute against a live bot.

const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

// Movement profile for GATHERING: like a real player it may punch through
// LEAVES to reach a trunk - and nothing else. The pathfinder only has a global
// canDig + a denylist, so we enable digging and deny every non-leaf block.
// Anti-grief holds: it can never break through builds or terrain.
function gatherMovements (bot) {
  const m = new Movements(bot)
  const md = require('minecraft-data')(bot.version)
  // May PILLAR back up out of a dip/ledge so mining can never strand the bot below
  // ground (verified: chasing exposed stone into a ravine left it trapped at y48,
  // unable to climb to the surface for the next gather step). Scaffolds only with
  // cheap blocks it's likely to be holding while mining (dirt/cobble/stone family).
  m.allow1by1towers = true
  const SCAFFOLD = ['dirt', 'grass_block', 'cobblestone', 'cobbled_deepslate', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'stone']
  if ('scafoldingBlocks' in m) m.scafoldingBlocks = SCAFFOLD.map(n => md.itemsByName[n] && md.itemsByName[n].id).filter(x => x != null)
  m.canOpenDoors = true
  m.allowParkour = false // WALK between resources instead of sprint-hopping every gap - the
  // gather roams a lot and parkour made it jump constantly in the open (user report). It can
  // still climb ledges (auto-step) and pillar out of dips; it just won't leap around.
  m.maxDropDown = 8 // hop down ledges like a player would (plateau spawns; verified live: default 4 = "No path" to a tree below a cliff)
  m.canDig = true
  m.digCost = 10 // strongly prefer walking around over chewing through a canopy
  m.blocksCantBreak = new Set(
    Object.values(md.blocksByName).filter(b => !/_leaves$/.test(b.name)).map(b => b.id)
  )
  return m
}

// Blocks that mean "this is a STRUCTURE (village house / player build)", so a log
// next to them must NOT be chopped for wood - that's griefing. Natural trees have
// none of these around them.
const STRUCTURE_RE = /planks$|stairs$|_slab$|fence|_door$|trapdoor$|_wall$|glass|_bed$|torch|lantern|crafting_table|^furnace$|chest|barrel|bookshelf|ladder|_sign$|_carpet$|wool$|brick|cobblestone|_wood$|smooth_|polished_|composter|loom|^bell$|dirt_path|farmland|hay_block|stripped_/
// ANTI-GRIEF for EVERY dig primitive (strip-shaft, tunnel, staircase, pillar, shelter): the
// ONLY blocks any of them may break are NATURAL terrain/ore - never a player-placed build
// block. `canBreakNaturally` is the single gate; without it the climb-out/strip-mine punch
// straight through a base's floor/wall (bot.canDigBlock is a reach/harvest test, NOT a
// protection check). Note: `cobblestone` is deliberately EXCLUDED (it's a common player
// block) - the strip-mine digs `stone` and gets cobble as the drop.
const DIGGABLE_NATURAL = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|moss_block|stone|deepslate|granite|diorite|andesite|tuff|calcite|dripstone_block|pointed_dripstone|sand|red_sand|gravel|clay|mud|sandstone|red_sandstone|snow_block|snow|powder_snow|ice|packed_ice|blue_ice|frosted_ice|netherrack|soul_sand|soul_soil|magma_block|blackstone|basalt|end_stone)$|terracotta$|_ore$/
function canBreakNaturally (block) { return !!block && DIGGABLE_NATURAL.test(block.name) && !STRUCTURE_RE.test(block.name) }
// Is a player-built structure within `r` of pos? Reused by the shelter + gather filters so
// the bot never digs in / mines right next to someone's base.
function structureNearby (bot, pos, r) {
  for (let dx = -r; dx <= r; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -r; dz <= r; dz++) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (b && STRUCTURE_RE.test(b.name)) return true
  }
  return false
}
// Is this log a NATURAL tree (safe to chop) or part of a village/player build? A wild
// tree ALWAYS has leaves nearby; a structure log has crafted blocks around it. Reject
// on either signal so the wood-gatherer never strips a village or someone's cabin.
function isWildTreeLog (bot, pos) {
  for (let dy = -2; dy <= 3; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz))
        if (b && STRUCTURE_RE.test(b.name)) return false // a build is right here - leave it
      }
    }
  }
  for (let dy = -1; dy <= 6; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz))
        if (b && /_leaves$/.test(b.name)) return true // has a canopy -> real tree
      }
    }
  }
  return false // no leaves and no obvious structure -> be conservative, skip it
}

// Detect which WOOD is actually available nearby (nearest exposed log type), so a
// treeless-of-oak biome (savanna=acacia, taiga=spruce...) doesn't strand a gather that
// assumed oak. Returns the wood family (e.g. 'spruce') or null if no trees in range.
function detectWood (bot) {
  const md = require('minecraft-data')(bot.version)
  const woods = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak']
  let best = null; let bestD = Infinity
  for (const w of woods) {
    const def = md.blocksByName[`${w}_log`]
    if (!def) continue
    const b = bot.findBlock({ matching: def.id, maxDistance: 64 })
    if (b) { const d = b.position.distanceTo(bot.entity.position); if (d < bestD) { bestD = d; best = w } }
  }
  return best
}

// ---- what the bot knows how to obtain directly from the world --------------
// item name -> which BLOCKS to mine for it. Natural blocks only (anti-grief:
// same philosophy as the MINABLE allowlist in commands.js).
const GATHER_SOURCES = {
  cobblestone: ['stone'], // mine natural STONE (drops cobble); never target placed cobblestone (a common player block)
  dirt: ['dirt', 'grass_block'],
  sand: ['sand'],
  red_sand: ['red_sand'],
  gravel: ['gravel'],
  clay_ball: ['clay'],
  oak_log: ['oak_log'],
  spruce_log: ['spruce_log'],
  birch_log: ['birch_log'],
  jungle_log: ['jungle_log'],
  acacia_log: ['acacia_log'],
  dark_oak_log: ['dark_oak_log'],
  cherry_log: ['cherry_log'],
  mangrove_log: ['mangrove_log']
}

// gathers that REQUIRE a tool or drop nothing / can't be mined. Stone mined with
// bare hands drops NOTHING - a pickaxe is mandatory, not just faster.
const GATHER_TOOL = {
  cobblestone: 'wooden_pickaxe'
}

// smelt-only outputs: output item -> furnace input item (recursively provisioned)
const SMELT_MAP = {
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  brick: 'clay_ball',
  smooth_sandstone: 'sandstone',
  charcoal: 'oak_log'
}

// stripped logs aren't gathered or crafted - you strip a placed log with an axe.
// output -> base log to gather (1:1). (wood/hyphae variants left out for now.)
const STRIP_MAP = {}
for (const w of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak']) {
  STRIP_MAP[`stripped_${w}_log`] = `${w}_log`
}

// fuel: a plank smelts ~1.5 items. We fuel with planks (4x more efficient per log
// than burning raw logs). Value is exact for 1.21; we add a small buffer.
const ITEMS_PER_PLANK = 1.5

function isPlank (name) { return /_planks$/.test(name) }
function isTool (name) { return /_(pickaxe|axe|shovel|sword|hoe)$/.test(name) }
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak']
// the wood family of an item name, or null (dark_oak before oak so it wins)
function woodOf (name) { return ['dark_oak', ...WOODS.filter(w => w !== 'dark_oak')].find(w => name.startsWith(w + '_')) || null }

// ---- planner (pure, offline-testable) ---------------------------------------

// Count ingredient items in a recipe (handles shaped inShape + shapeless ingredients).
function recipeIngredients (recipe) {
  const counts = {}
  if (recipe.inShape) {
    for (const row of recipe.inShape) {
      for (const id of row) if (id !== null && id !== undefined && id !== -1) counts[id] = (counts[id] || 0) + 1
    }
  } else if (recipe.ingredients) {
    for (const id of recipe.ingredients) if (id !== null && id !== undefined && id !== -1) counts[id] = (counts[id] || 0) + 1
  }
  return counts
}

// A shaped recipe wider/taller than 2 needs a crafting table.
function recipeNeedsTable (recipe) {
  if (!recipe.inShape) return Object.keys(recipeIngredients(recipe)).length > 4
  return recipe.inShape.length > 2 || Math.max(...recipe.inShape.map(r => r.length)) > 2
}

// Plan how to satisfy `bom` (item name -> count) given `inventory`. Emits tasks
// in survival TECH-TREE order (phases): gather wood -> craft basics+tools ->
// gather stone/other (now tooled) -> craft furnace -> smelt -> strip -> craft
// finals. Returns { tasks, gathers, crafts, smelts, strips, tools, unobtainable, needsTable }.
function planProvision (mcData, bom, inventory = {}, opts = {}) {
  const avail = { ...inventory }
  const gathers = {}            // item -> count
  const craftReq = {}           // item -> {crafts, perCraft, needsTable}
  const craftOrder = []         // craft item names, dependency order (leaf-first)
  const smelts = []             // {output, input, count}
  const strips = []             // {output, input, count}
  const toolsNeeded = new Set()
  const unobtainable = {}
  let needsTable = false
  let furnaceNeeded = false

  // The dominant wood in the BOM - used for all GENERIC wood needs (table,
  // sticks, tools, fuel) so we don't drag in a random third tree type for them
  // (those needs are resolved before the main build wood is registered).
  // The BOM's own wood wins (a spruce build makes spruce planks); otherwise use the
  // caller's biome hint (whatever wood is actually growing nearby); else oak. This is
  // what lets a stonebox (no wood in its BOM) craft ACACIA tools/fuel in a savanna
  // instead of stranding on oak that isn't there.
  const woodTally = {}
  for (const [n, c] of Object.entries(bom)) { const w = woodOf(n); if (w) woodTally[w] = (woodTally[w] || 0) + c }
  const primaryWood = Object.entries(woodTally).sort((a, b) => b[1] - a[1])[0]?.[0] || opts.primaryWood || 'oak'

  function take (name, count) {
    const have = avail[name] || 0
    const used = Math.min(have, count)
    avail[name] = have - used
    return count - used
  }
  function addGather (name, count) { gathers[name] = (gathers[name] || 0) + count }
  function ensureTool (tool, stack) {
    if (toolsNeeded.has(tool)) return
    toolsNeeded.add(tool)
    need(tool, 1, stack) // craft it (adds planks/sticks/table deps)
  }

  function need (name, count, stack) {
    if (count <= 0) return
    const remaining = take(name, count)
    if (remaining <= 0) return
    if (stack.includes(name)) { unobtainable[name] = (unobtainable[name] || 0) + remaining; return }

    // stripped logs: strip a placed base log with an axe (1:1)
    if (STRIP_MAP[name]) {
      ensureTool('wooden_axe', [...stack, name])
      need(STRIP_MAP[name], remaining, [...stack, name])
      strips.push({ output: name, input: STRIP_MAP[name], count: remaining })
      return
    }
    // gatherable from the world (maybe tool-gated)
    if (GATHER_SOURCES[name]) {
      if (GATHER_TOOL[name]) ensureTool(GATHER_TOOL[name], [...stack, name])
      addGather(name, remaining)
      return
    }
    // smeltable (needs a furnace + fuel, planned once globally below)
    if (SMELT_MAP[name]) {
      furnaceNeeded = true
      // charcoal's smelt input is a LOG - use the wood that's actually around (primaryWood),
      // not a hard-coded oak_log, or torches are unobtainable in a savanna/taiga/spruce site.
      const input = (name === 'charcoal') ? `${primaryWood}_log` : SMELT_MAP[name]
      need(input, remaining, [...stack, name])
      smelts.push({ output: name, input, count: remaining })
      return
    }
    // craftable - prefer a recipe variant whose ingredients we already stock/plan
    const item = mcData.itemsByName[name]
    const recipes = [...((item && mcData.recipes[item.id]) || [])].sort((a, b) => {
      // prefer variants (1) whose ingredients we already stock/plan, then (2) that
      // use the primary build wood - so generic wood needs converge on one tree.
      const obtainable = n => n && (GATHER_SOURCES[n] || SMELT_MAP[n] || STRIP_MAP[n] || (avail[n] || 0) > 0 || gathers[n] || craftReq[n] || (mcData.itemsByName[n] && (mcData.recipes[mcData.itemsByName[n].id] || []).length > 0))
      const score = r => {
        const names = Object.keys(recipeIngredients(r)).map(id => mcData.items[id] && mcData.items[id].name)
        // HARD penalty for a variant with an ingredient we can't get any way (e.g. the
        // furnace's cobbled_deepslate/blackstone variants) - else it can tie with and
        // beat the cobblestone one and the whole material gets marked unobtainable.
        const dead = names.some(n => !obtainable(n)) ? 8 : 0
        const planned = names.every(n => n && ((avail[n] || 0) > 0 || gathers[n] || craftReq[n])) ? 0 : 2
        // among wood-ingredient variants, REWARD the primary wood and penalise
        // any other specific wood; recipes with no wood ingredient are neutral.
        const usesWood = names.some(n => n && woodOf(n))
        const primary = !usesWood ? 0.5 : names.some(n => n && woodOf(n) === primaryWood) ? 0 : 1
        return dead + planned + primary
      }
      return score(a) - score(b)
    })
    for (const recipe of recipes) {
      const ing = recipeIngredients(recipe)
      const names = Object.keys(ing).map(id => mcData.items[id] && mcData.items[id].name)
      if (names.some(n => !n)) continue
      const perCraft = recipe.result.count || 1
      const craftsNeeded = Math.ceil(remaining / perCraft)
      const table = recipeNeedsTable(recipe)
      if (table) needsTable = true
      for (const [id, cnt] of Object.entries(ing)) need(mcData.items[id].name, cnt * craftsNeeded, [...stack, name])
      if (!craftReq[name]) { craftReq[name] = { crafts: 0, perCraft, needsTable: table }; craftOrder.push(name) }
      craftReq[name].crafts += craftsNeeded
      avail[name] = (avail[name] || 0) + craftsNeeded * perCraft - remaining
      return
    }
    unobtainable[name] = (unobtainable[name] || 0) + remaining
  }

  for (const [name, count] of Object.entries(bom)) need(name, count, [])

  // Furnace + fuel, once, for all smelting.
  const smeltTotal = smelts.reduce((s, x) => s + x.count, 0)
  if (furnaceNeeded && smeltTotal > 0) {
    need('furnace', 1, []) // 8 cobblestone (adds pickaxe dep) + furnace craft
    // fuel with the plank type we already make most of (else oak)
    const plankCounts = {}
    for (const n of craftOrder) if (isPlank(n)) plankCounts[n] = craftReq[n].crafts * craftReq[n].perCraft
    const fuelPlank = Object.entries(plankCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'oak_planks'
    const fuelCount = Math.ceil(smeltTotal / ITEMS_PER_PLANK) + 4 // small buffer
    need(fuelPlank, fuelCount, [])
  }
  // A wooden pickaxe only survives ~59 blocks - craft enough FRESH ones for all
  // the cobble. Don't count pickaxes already in inventory toward the budget: they
  // may be nearly worn out (verified live: a worn leftover pickaxe broke after 4
  // cobble because we assumed it was full and planned no spares).
  if (gathers.cobblestone) {
    const want = Math.max(1, Math.ceil(gathers.cobblestone / 50))
    avail.wooden_pickaxe = 0 // ignore possibly-worn ones - craft `want` fresh
    const planned = craftReq.wooden_pickaxe ? craftReq.wooden_pickaxe.crafts : 0
    if (want > planned) need('wooden_pickaxe', want - planned, [])
  }
  if (needsTable) need('crafting_table', 1, [])

  // ---- assemble into tech-tree phases ----
  const gEntries = Object.entries(gathers)
  const logGathers = gEntries.filter(([n]) => /_log$/.test(n))
  const otherGathers = gEntries.filter(([n]) => !/_log$/.test(n))
  const basicPriority = n => (n === 'crafting_table' ? 1 : isPlank(n) ? 0 : n === 'stick' ? 2 : isTool(n) ? 3 : 99)
  const isBasic = n => n === 'crafting_table' || isPlank(n) || n === 'stick' || isTool(n)
  const basics = craftOrder.filter(isBasic).sort((a, b) => basicPriority(a) - basicPriority(b))
  const finals = craftOrder.filter(n => !isBasic(n) && n !== 'furnace')
  const G = (n, c) => ({ type: 'gather', item: n, count: c, blocks: GATHER_SOURCES[n], tool: GATHER_TOOL[n] || null })
  const C = n => ({ type: 'craft', item: n, crafts: craftReq[n].crafts, perCraft: craftReq[n].perCraft, needsTable: craftReq[n].needsTable })

  const tasks = [
    ...logGathers.map(([n, c]) => G(n, c)),
    ...basics.map(C),
    ...otherGathers.map(([n, c]) => G(n, c)),
    ...(craftReq.furnace ? [C('furnace')] : []),
    ...smelts.map(s => ({ type: 'smelt', ...s })),
    ...strips.map(s => ({ type: 'strip', ...s })),
    ...finals.map(C)
  ]
  return { tasks, gathers, crafts: craftReq, smelts, strips, tools: [...toolsNeeded], unobtainable, needsTable }
}

// Current inventory as {itemName: count}.
function inventoryCounts (bot) {
  const out = {}
  for (const i of (bot.inventory ? bot.inventory.items() : [])) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

// ---- executors (live bot) ----------------------------------------------------

function countItem (bot, name) { return inventoryCounts(bot)[name] || 0 }

// pathfinder.goto with a deadline (same rationale as schematic.js: goto can hang).
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

// Walk onto nearby dropped items so they're picked up. Waits for drops to settle,
// then sweeps the nearest item repeatedly (walk ONTO it - range 0). More persistent
// than before because scattered drops on jagged terrain were being left behind.
async function collectDrops (bot, radius = 10) {
  await new Promise(r => setTimeout(r, 250)) // let freshly-broken drops settle/land
  for (let n = 0; n < 14; n++) {
    let target = null; let best = radius
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e.name !== 'item') continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < best) { best = d; target = e }
    }
    if (!target) return
    try { await gotoWithTimeout(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 0), 10000) } catch { return }
    await new Promise(r => setTimeout(r, 250))
  }
}

// Walk ~48 blocks in a rotating compass direction to reach fresh, unexplored
// terrain (loads new chunks) when the current area is tapped out. Returns whether
// it moved. This is what lets gathering keep going instead of stalling with
// "no reachable X within 64 blocks".
async function explore (bot, idx) {
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  const [dx, dz] = dirs[((idx % 8) + 8) % 8]
  const norm = Math.hypot(dx, dz) || 1
  const D = 48
  const tx = Math.round(bot.entity.position.x + (dx / norm) * D)
  const tz = Math.round(bot.entity.position.z + (dz / norm) * D)
  const from = bot.entity.position.clone()
  try { await gotoWithTimeout(bot, new goals.GoalNearXZ(tx, tz, 6), 30000) } catch {}
  return bot.entity.position.distanceTo(from) > 8 // did we actually get somewhere?
}

// Gather `count` of `item` by mining its source blocks (chops whole trees for
// logs). opts: { say, isStopped, restoreMovements }. Returns {gathered, reason}.
const AIRISH = n => n === 'air' || n === 'cave_air' || n === 'void_air'

const FILLER_RE = /^(cobblestone|dirt|coarse_dirt|stone|gravel|andesite|diorite|granite|cobbled_deepslate|netherrack|tuff|deepslate)$/

// STRIP-MINE downward to reach buried stone (plains - it's all under dirt). Digs a SAFE
// vertical shaft: only break the block underfoot when the block TWO below is solid and
// non-dangerous, so we never drop into lava/water/a cave. One at a time, falling in,
// with the right tool. Returns how deep it dug. Climb back out via pillarUpTo.
async function digShaftDown (bot, maxDepth, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const DANGER = /lava|water/
  let dug = 0
  while (dug < maxDepth && !isStopped()) {
    const feet = bot.entity.position.floored()
    const below = bot.blockAt(feet.offset(0, -1, 0))
    const below2 = bot.blockAt(feet.offset(0, -2, 0))
    if (!below || AIRISH(below.name) || DANGER.test(below.name)) break
    if (!below2 || AIRISH(below2.name) || DANGER.test(below2.name)) break // drop/lava/cave beneath -> STOP
    if (!canBreakNaturally(below)) break // anti-grief: never dig a player-placed block
    const tool = toolForBlock(bot, below.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(below)) break
    try { await bot.dig(below) } catch { break }
    dug++
    await new Promise(r => setTimeout(r, 250))
  }
  return dug
}

// Classic pillar-up: rise to targetY by clearing the 2 blocks above and placing a
// filler block (cobble/dirt we carry) under our feet each hop. STOPS exactly at targetY
// - how a player climbs out of a mine, reliable where the pathfinder's dig-straight-up
// isn't. Out of filler -> stop (caller falls back to walking out).
// Climb back to the surface by digging a SPIRAL STAIRCASE UP (walkable, deterministic -
// scripted pillaring kept trapping the bot in the surface dirt). Each step rotates a
// quarter-turn and rises one: place a floor block if the next step is over air, dig the
// feet+head cells there and our own head clearance, then walk onto it. Stops at targetY.
async function digStaircaseUp (bot, targetY, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const DIRS = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]
  const digIf = async (p) => {
    const b = bot.blockAt(p)
    if (!b || AIRISH(b.name)) return true
    if (/lava|water/.test(b.name)) return false
    if (!canBreakNaturally(b)) return false // anti-grief: don't cut through a player build
    const tool = toolForBlock(bot, b.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) return false
    try { await bot.dig(b); return true } catch { return false }
  }
  const startY = Math.floor(bot.entity.position.y)
  let di = 0; let stuck = 0
  while (Math.floor(bot.entity.position.y) < targetY && !isStopped() && stuck < 8) {
    if (Math.floor(bot.entity.position.y) > startY && !hasSolidCeiling(bot, 20, { ignoreLeaves: true })) break // broke into open sky - done
    const y0 = Math.floor(bot.entity.position.y)
    const feet = bot.entity.position.floored()
    const dir = DIRS[di % 4]; di++
    const sFloor = feet.plus(dir)                 // block we'll stand on (same Y as feet)
    const sFeet = feet.plus(dir).offset(0, 1, 0)  // new feet cell
    const sHead = feet.plus(dir).offset(0, 2, 0)  // new head cell
    await digIf(feet.offset(0, 2, 0))             // our own head-clearance to move up
    const fb = bot.blockAt(sFloor)
    if (!fb || AIRISH(fb.name)) { // no floor for the step -> place one
      const filler = (bot.inventory ? bot.inventory.items() : []).find(i => FILLER_RE.test(i.name))
      if (filler) {
        await bot.equip(filler, 'hand').catch(() => {})
        const under = bot.blockAt(sFloor.offset(0, -1, 0))
        try { if (under && !AIRISH(under.name)) await bot.placeBlock(under, new Vec3(0, 1, 0)) } catch {}
      }
    }
    if (!(await digIf(sFeet)) || !(await digIf(sHead))) { stuck++; continue }
    try { await gotoWithTimeout(bot, new goals.GoalBlock(sFeet.x, sFeet.y, sFeet.z), 6000) } catch {}
    if (Math.floor(bot.entity.position.y) <= y0) stuck++; else stuck = 0
  }
}

// Movement profile for DIGGING OUR WAY BACK to the surface after strip-mining: it may
// break the overburden (canDig) and pillar up, so a stone ceiling can't trap us. Only
// used to escape a mine we dug ourselves - never near player builds.
function climbMovements (bot) {
  const m = new Movements(bot)
  m.canDig = true
  m.allow1by1towers = true    // pillar straight up through a stone ceiling...
  m.canOpenDoors = true
  m.allowParkour = true
  m.maxDropDown = 4
  m.digCost = 1
  // ...but only if it has blocks to pillar WITH - give the pathfinder our cheap filler
  // so allow1by1towers can actually place a tower (else it can't rise over a gap/void).
  try {
    const md = require('minecraft-data')(bot.version)
    const fill = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'gravel', 'andesite', 'granite', 'diorite', 'tuff']
    const ids = fill.map(n => md.itemsByName[n] && md.itemsByName[n].id).filter(x => x != null)
    if ('scafoldingBlocks' in m) m.scafoldingBlocks = ids
    // ANTI-GRIEF: canDig=true here would otherwise let the pathfinder cut THROUGH a player
    // build to climb out (bypassing the per-primitive canBreakNaturally guards). Deny every
    // structural block so the climb-out routes around a base, never through it.
    if (m.blocksCantBreak && typeof m.blocksCantBreak.add === 'function') {
      for (const b of Object.values(md.blocksByName || {})) { if (STRUCTURE_RE.test(b.name)) m.blocksCantBreak.add(b.id) }
    }
  } catch { /* mcData not ready */ }
  return m
}

// Is there a solid ceiling overhead? i.e. are we in a cave/underground rather than out in
// the open under the sky. Scans the column above the head for a real (block-shaped) block.
// Lets travel tell "dropped into a cave" (climb out) apart from "walking through a valley"
// (fine - don't pointlessly pillar up in the open).
function hasSolidCeiling (bot, upTo = 45, opts = {}) {
  if (!bot.entity) return false
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

// Escape UPWARD when stranded underground (e.g. cross-country travel dropped us into a
// cave/ravine we can't path out of): dig a walkable staircase up to targetY with dig-
// capable climb movements, then restore the caller's movement profile. Anti-grief-safe:
// digStaircaseUp refuses lava/water and honours canDigBlock, so it cuts natural stone to
// surface but won't chew through protected/player blocks. Stops early once we break out
// into open sky even if that's below targetY (no point digging a hill from the inside).
async function climbToSurface (bot, targetY, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const prev = bot.pathfinder && bot.pathfinder.movements
  const need = () => bot.entity && Math.floor(bot.entity.position.y) < targetY - 1 &&
    hasSolidCeiling(bot) && !isStopped()
  try {
    // 1) SPIRAL STAIRCASE up - cuts a WALKABLE ramp to the surface (fast, and once up we
    //    can just walk on out). Proven to clear tens of blocks of solid overburden. The
    //    flee reflex is held off (escaping flag) so mobs can't drag us off it mid-climb.
    if (need()) {
      if (bot.pathfinder) bot.pathfinder.setMovements(climbMovements(bot))
      const y0 = bot.entity.position.y
      try { await digStaircaseUp(bot, targetY, { isStopped }) } catch (e) { if (process.env.CLIMB_DEBUG) console.error('[climb] staircase threw', e.message) }
      if (process.env.CLIMB_DEBUG) console.error(`[climb] staircase ${y0.toFixed(1)} -> ${bot.entity.position.y.toFixed(1)} (target ${targetY})`)
    }
    // 2) PILLAR STRAIGHT UP as a fallback - if the staircase stalls (awkward/open cavern
    //    geometry it can step off of), rise on a 1-wide column that can't be fallen off.
    if (need()) {
      const y0 = bot.entity.position.y
      try { await pillarUpTo(bot, targetY, { isStopped }) } catch (e) { if (process.env.CLIMB_DEBUG) console.error('[climb] pillar threw', e.message) }
      if (process.env.CLIMB_DEBUG) console.error(`[climb] pillar ${y0.toFixed(1)} -> ${bot.entity.position.y.toFixed(1)}`)
    }
  } finally {
    if (prev && bot.pathfinder) bot.pathfinder.setMovements(prev)
  }
}

// Pillar STRAIGHT UP to targetY: dig any block above the head, then jump and - at the top
// of the hop, once we've actually cleared a block - place a filler block underfoot. The
// mob-safest escape: you rise onto a 1-wide column above ground mobs and can't be walked
// back down into the pit. Stops on lava/water above, out of filler, or protected blocks.
async function pillarUpTo (bot, targetY, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const startY = Math.floor(bot.entity.position.y)
  let stuck = 0
  let equippedFiller = null
  while (Math.floor(bot.entity.position.y) < targetY && !isStopped() && stuck < 15) {
    // Stop the MOMENT we break into open sky (no ceiling) - keeping on to targetY builds a
    // useless 1x1 tower into the air and strands the bot on top (targetY is a rough surface
    // guess and overshoots in valleys). Once above where we started with clear sky, we're out.
    if (Math.floor(bot.entity.position.y) > startY && !hasSolidCeiling(bot, 20, { ignoreLeaves: true })) break
    const y0 = Math.floor(bot.entity.position.y)
    const feet = bot.entity.position.floored()
    // Clear TWO blocks above our head (y+2 and y+3): a full jump-up needs the head to pass
    // y+3, so clearing only y+2 caps the hop just short of a block and placements miss.
    for (const up of [2, 3]) {
      const above = bot.blockAt(feet.offset(0, up, 0))
      if (above && !AIRISH(above.name)) {
        if (/lava|water/.test(above.name)) { bot.clearControlStates(); return }
        if (!canBreakNaturally(above)) { bot.clearControlStates(); return } // anti-grief: don't pillar up through a build
        if (bot.canDigBlock && !bot.canDigBlock(above)) { bot.clearControlStates(); return }
        const tool = toolForBlock(bot, above.name)
        if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
        try { await bot.dig(above) } catch {}
        equippedFiller = null // we swapped to a tool
      }
    }
    const filler = (bot.inventory ? bot.inventory.items() : []).find(i => FILLER_RE.test(i.name))
    if (!filler) { bot.clearControlStates(); return } // nothing to pillar with
    if (equippedFiller !== filler.name) { await bot.equip(filler, 'hand').catch(() => {}); equippedFiller = filler.name }
    const ref = bot.blockAt(feet.offset(0, -1, 0)) // the block we're standing on
    if (ref && !AIRISH(ref.name)) {
      try { await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true) } catch {}
      bot.setControlState('jump', true)
      const t = Date.now()
      // wait until we've genuinely risen ~1 block, THEN place (fixed sleeps miss the apex)
      while (Date.now() - t < 1000 && !isStopped()) {
        await new Promise(r => setTimeout(r, 15))
        if (bot.entity.position.y - y0 >= 1.0) {
          try { await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch {}
          break
        }
      }
      bot.setControlState('jump', false)
    }
    await new Promise(r => setTimeout(r, 90)) // settle onto the new block
    if (Math.floor(bot.entity.position.y) <= y0) stuck++; else { stuck = 0 }
  }
  bot.clearControlStates()
}

// Mine a straight horizontal 1x2 TUNNEL forward, collecting drops at our feet so cobble
// isn't lost down a pit (the generic loop mined the floor and dropped it into the hole).
// Digs the two blocks ahead (feet + head level), sweeps drops, steps in, repeats. Safe:
// stops at lava/water or a missing floor (cave). Returns net `itemName` gained.
async function mineTunnel (bot, itemName, maxLen, dirIdx, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const DANGER = /lava|water/
  const DIRS = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]
  const dir = DIRS[((dirIdx % 4) + 4) % 4]
  const before = countItem(bot, itemName)
  for (let i = 0; i < maxLen && !isStopped(); i++) {
    const feet = bot.entity.position.floored()
    const ahead = feet.plus(dir)
    const aheadUp = ahead.offset(0, 1, 0)
    const floor = ahead.offset(0, -1, 0)
    const fB = bot.blockAt(floor)
    if ([ahead, aheadUp, floor].some(p => { const b = bot.blockAt(p); return b && DANGER.test(b.name) })) break
    if (!fB || AIRISH(fB.name)) break // drop/cave ahead -> stop (don't walk into a hole)
    let dugAny = false
    for (const p of [aheadUp, ahead]) {
      const b = bot.blockAt(p)
      if (!b || AIRISH(b.name)) continue
      if (!canBreakNaturally(b)) { return countItem(bot, itemName) - before } // anti-grief: hit a player block -> stop tunnelling
      const tool = toolForBlock(bot, b.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(b)) { return countItem(bot, itemName) - before }
      try { await bot.dig(b); dugAny = true } catch { return countItem(bot, itemName) - before }
    }
    await collectDrops(bot, 3)
    try { await gotoWithTimeout(bot, new goals.GoalBlock(ahead.x, ahead.y, ahead.z), 5000) } catch { break }
    if (!dugAny) break
  }
  return countItem(bot, itemName) - before
}

async function runGather (bot, item, count, opts = {}) {
  // Anchor to the PERSISTENT surface (homeY, from the build/provision run) if given, not
  // wherever we happen to be standing now - so a batch that starts underground (previous
  // climb-out fell short, or we fell in a cave) still knows where the real surface is and
  // won't sink deeper. Falls back to the current spot when there's no home reference.
  const surfaceY = opts.homeY != null ? opts.homeY : Math.floor(bot.entity.position.y)
  bot.pathfinder.setMovements(gatherMovements(bot)) // may punch through leaves + pillar up
  try {
    return await gatherLoop(bot, item, count, { ...opts, surfaceY })
  } finally {
    // Back to the surface if we're below it (strip-mined down OR fell into a cave). Try
    // three ways, in order, until we're within a couple blocks of the top: a spiral
    // staircase up, a straight pillar-up, then a pathfinder dig-out. Any one that works
    // ends it - so a cave with awkward geometry can't strand us.
    try {
      const need = () => bot.entity && bot.entity.position.y < surfaceY - 2
      if (need()) {
        bot.pathfinder.setGoal(null)
        for (const climb of [
          () => digStaircaseUp(bot, surfaceY, { isStopped: opts.isStopped }),
          () => pillarUpTo(bot, surfaceY, { isStopped: opts.isStopped }),
          () => { bot.pathfinder.setMovements(climbMovements(bot)); return gotoWithTimeout(bot, new goals.GoalY(surfaceY), 30000) }
        ]) { if (!need()) break; try { await climb() } catch {} }
      }
    } catch {}
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements() // back to the anti-grief profile
  }
}

// Animals that drop LEATHER when killed. Cows/mooshrooms are the reliable, common
// source (0-2 leather each); we hunt those, not horses/llamas. This is the raw
// material for leather armor - the "from nothing" armor tier (no mining/smelting).
const LEATHER_ANIMALS = /^(cow|mooshroom)$/

// Hunt nearby cows for LEATHER until we have `target` more in inventory, or we hit
// the bounds (max kills / time / no-animals-found). BOUNDED on purpose: a survival
// run must never HANG here when no cows are around - it returns whatever it got and
// the caller proceeds with a partial (or empty) armor set. Returns {leather, killed}.
// Same movement/anti-grief profile as gathering (can't tunnel through builds).
async function gatherLeather (bot, target, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const deadline = Date.now() + (opts.timeMs || 120000) // 2 min hard cap
  const maxKills = opts.maxKills || 16
  const leatherNow = () => countItem(bot, 'leather')
  const start = leatherNow()
  bot.pathfinder.setMovements(gatherMovements(bot)) // anti-grief while chasing
  let killed = 0
  let explores = 0
  try {
    while (leatherNow() - start < target && killed < maxKills && Date.now() < deadline && !isStopped()) {
      // nearest leather animal within a comfortable search radius
      let tgt = null; let best = 32
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
        if (!LEATHER_ANIMALS.test((e.name || '').toLowerCase())) continue
        const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
      }
      if (!tgt) { // none in range - roam to find some, but only a few times
        if (explores++ >= 4) break
        await explore(bot, explores)
        continue
      }
      // wield the best melee we have (sword > axe > fist) and chase it down
      const items = bot.inventory ? bot.inventory.items() : []
      const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      const killStart = Date.now()
      bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 2), true)
      while (tgt.isValid && Date.now() - killStart < 15000 && !isStopped()) {
        if (bot.entity.position.distanceTo(tgt.position) <= 3.5) {
          await bot.lookAt(tgt.position.offset(0, (tgt.height || 1) * 0.7, 0)).catch(() => {})
          bot.attack(tgt)
          await new Promise(r => setTimeout(r, 600)) // attack-cooldown cadence
        } else {
          await new Promise(r => setTimeout(r, 300))
        }
      }
      bot.pathfinder.setGoal(null)
      if (!tgt.isValid) killed++
      await collectDrops(bot, 8) // grab the dropped leather (and beef)
    }
  } finally {
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements()
  }
  const got = leatherNow() - start
  if (got > 0) say(`got ${got} leather off ${killed} ${killed === 1 ? 'cow' : 'cows'}`)
  return { leather: got, killed }
}

// Animals whose drops FEED you (raw meat is edible). Used by the survival-hunt so a long
// job in a food-poor area doesn't run the bot down to 0 food / 1 hp with nothing to eat.
const FOOD_ANIMALS = /^(cow|mooshroom|pig|chicken|sheep|rabbit)$/
function hasFood (bot) {
  const md = require('minecraft-data')(bot.version)
  const foods = (md && md.foodsByName) || {}
  return (bot.inventory ? bot.inventory.items() : []).some(i => foods[i.name])
}
// The ONLY time the bot must go hunt: it's hungry AND has nothing to eat. (With food on
// hand, auto-eat handles it; well-fed, no need.) food<=6 = hunger low enough that regen
// has stopped, so act before it hits 0 and gets pinned at 1 hp.
function needsFood (bot) { return bot.food != null && bot.food <= 6 && !hasFood(bot) }
// Kill the nearest food animal and collect the meat (auto-eat then eats it, raw is fine).
// Bounded: one animal within ~24 blocks, ~12s. Returns true if something died. Uses the
// movement profile already set (chasing needs no digging, so anti-grief holds). No-op if
// no animal is near - it can't conjure food from an empty field.
async function huntForFood (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (!bot.entity) return false
  let tgt = null; let best = 24
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
    if (!FOOD_ANIMALS.test((e.name || '').toLowerCase())) continue
    const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
  }
  if (!tgt) return false
  const items = bot.inventory ? bot.inventory.items() : []
  const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
  if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
  const killStart = Date.now()
  try {
    bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 2), true)
    while (tgt.isValid && Date.now() - killStart < 12000 && !isStopped()) {
      if (bot.entity.position.distanceTo(tgt.position) <= 3.5) {
        await bot.lookAt(tgt.position.offset(0, (tgt.height || 1) * 0.7, 0)).catch(() => {})
        bot.attack(tgt)
        await new Promise(r => setTimeout(r, 600))
      } else { await new Promise(r => setTimeout(r, 300)) }
    }
  } finally { bot.pathfinder.setGoal(null) }
  await collectDrops(bot, 8)
  return !tgt.isValid
}

// ---- night survival: dig-in shelter for a NAKED bot ------------------------------
const SHELTER_HOSTILE = /zombie|skeleton|spider|creeper|husk|drowned|witch|pillager|vindicator|stray|bogged|phantom|slime|enderman|silverfish|cave_spider|warden/
let _sheltering = false
function isSheltering () { return _sheltering } // reflexes (flee/defend) yield while true
function nearHostile (bot, r) {
  const me = bot.entity && bot.entity.position; if (!me) return false
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
    if (!SHELTER_HOSTILE.test((e.name || '').toLowerCase())) continue
    if (e.position.distanceTo(me) <= r) return true
  }
  return false
}
function underArmored (bot) {
  try { for (const s of ['head', 'torso', 'legs', 'feet']) { if (!(bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(s)])) return true } return false } catch { return true }
}
function isNight (bot) { return !!(bot.time && bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 23500) }
// Fire the shelter when it's genuinely dangerous: night, no full armor, and a hostile is
// closing. (Not every night - only when actually threatened, so it doesn't burrow for nothing.)
function shelterNeeded (bot) { return isNight(bot) && underArmored(bot) && nearHostile(bot, 12) }
// (anti-grief helpers canBreakNaturally / structureNearby are defined up top, next to
// STRUCTURE_RE, and shared by every dig primitive + the shelter + the gather filter.)

// Place a block from inventory (name matching `match`) AT world position `target`, using any
// solid neighbouring face to place against. Best-effort; returns whether a block landed.
async function placeAt (bot, target, match) {
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => match.test(i.name))
  if (!item) return false
  await bot.equip(item, 'hand').catch(() => {})
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const ref = bot.blockAt(target.offset(dx, dy, dz))
    if (ref && ref.boundingBox === 'block' && !AIRISH(ref.name)) {
      try { await bot.lookAt(target.offset(0.5, 0.5, 0.5), true) } catch {}
      try { await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)); return true } catch { /* try next face */ }
    }
  }
  return false
}

// Emergency night bunker for a NAKED bot: dig 2 down into solid ground, seal the opening with
// a block, and wait out the danger (until day AND no hostile near), then climb back out. A
// sealed pit survives a creeper - it can't reach you underground - where fleeing didn't.
// Deterministic + body-side (the brain is HELD during builds). Sets isSheltering() so the
// flee/defend reflexes stand down instead of dragging us off. Returns true if it sheltered.
async function digInForNight (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  if (!bot.entity || _sheltering) return false
  // ANTI-GRIEF is handled PER-DIG below (canBreakNaturally): the shelter can only cut natural
  // ground, never a placed block - so it can't punch through a base's floor, yet it CAN still
  // dig a bunker in natural dirt right next to a build (incl. the bot's OWN castle at the build
  // site, where it most needs to shelter). Standing ON a player floor -> the dig loop's natural
  // check fails immediately -> no hole, it just flees instead.
  _sheltering = true
  try {
    bot.pathfinder && bot.pathfinder.setGoal(null)
    const surfaceY = Math.floor(bot.entity.position.y)
    // 1) dig straight down 2, keeping the blocks (need one to cap with). NEVER dig into a
    //    void/lava/water below, and ONLY natural terrain (never a player build block) - so
    //    sheltering can't punch through someone's floor.
    let dug = 0
    for (let i = 0; i < 2 && !isStopped(); i++) {
      const feet = bot.entity.position.floored()
      const below = bot.blockAt(feet.offset(0, -1, 0))
      const below2 = bot.blockAt(feet.offset(0, -2, 0))
      if (!below || AIRISH(below.name) || /lava|water/.test(below.name) || !canBreakNaturally(below)) break
      if (below2 && /lava|water/.test(below2.name)) break
      const tool = toolForBlock(bot, below.name)
      if (tool) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(below)) break
      try { await bot.dig(below) } catch { break }
      await new Promise(r => setTimeout(r, 250)) // fall into the hole
      dug++
    }
    if (dug < 1) return false // couldn't dig in (bedrock/protected/edge) - the flee reflex covers it
    await collectDrops(bot, 3)
    // 2) cap the opening above the head with any spare block
    const capPos = bot.entity.position.floored().offset(0, 2, 0)
    // cap with ANY common terrain/building block we're holding (whatever the biome gave us
    // when we dug in - terracotta, deepslate, tuff, etc. all count, not just dirt/cobble).
    const capped = await placeAt(bot, capPos, /terracotta|dirt|cobble|stone|gravel|sand|netherrack|deepslate|tuff|granite|diorite|andesite|clay|mud|_planks$|_log$|_concrete/)
    say(capped ? 'holed up till it\'s safe' : 'ducked into a hole till it\'s safe')
    // 3) wait until DAY and no hostile near, or a hard timeout (~one full night)
    const deadline = Date.now() + 600000
    while (Date.now() < deadline && !isStopped()) {
      if (!isNight(bot) && !nearHostile(bot, 10)) break
      await new Promise(r => setTimeout(r, 3000))
    }
    // 4) break the cap and climb back to the surface. Use climbToSurface (staircase-up,
    //    which cuts steps and needs NO filler blocks) - pillarUpTo alone stranded the bot
    //    when it had no dirt left (deaths strip inventory), ratcheting it deeper each night.
    try {
      const cap = bot.blockAt(capPos)
      if (cap && !AIRISH(cap.name) && (!bot.canDigBlock || bot.canDigBlock(cap))) { try { await bot.dig(cap) } catch {} }
      await collectDrops(bot, 3) // recover the cap block as filler
      await climbToSurface(bot, surfaceY, { isStopped })
    } catch {}
    return true
  } finally { _sheltering = false; bot.clearControlStates && bot.clearControlStates() }
}

// Pick the right tool KIND in inventory for a block (pickaxe/axe/shovel), best
// material first. Returns the item or null (bare hands).
function toolForBlock (bot, blockName) {
  let kind = null
  if (/stone|cobble|ore|deepslate|granite|diorite|andesite|tuff|basalt|blackstone/.test(blockName)) kind = 'pickaxe'
  else if (/_log$|_wood$|_stem$/.test(blockName)) kind = 'axe'
  else if (/dirt|grass_block|sand|gravel|clay|mud/.test(blockName)) kind = 'shovel'
  if (!kind) return null
  const items = (bot.inventory ? bot.inventory.items() : []).filter(i => i.name.endsWith('_' + kind))
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
  for (const m of order) { const t = items.find(i => i.name.startsWith(m)); if (t) return t }
  return items[0] || null
}

async function gatherLoop (bot, item, count, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const sources = GATHER_SOURCES[item]
  if (!sources) return { gathered: 0, reason: `don't know how to gather ${item}` }
  // some blocks drop NOTHING without the right tool - fail loudly, don't spin
  const reqTool = GATHER_TOOL[item] // e.g. cobblestone needs a pickaxe
  if (reqTool) {
    const kind = reqTool.split('_').pop() // 'pickaxe'
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name.endsWith('_' + kind))) {
      return { gathered: 0, reason: `need a ${kind} to mine ${sources[0]} (mining it bare-handed drops nothing)` }
    }
  }
  const ids = sources.map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(x => x != null)
  const toolKind = reqTool ? reqTool.split('_').pop() : null
  const haveReqTool = () => !toolKind || (bot.inventory ? bot.inventory.items() : []).some(i => i.name.endsWith('_' + toolKind))
  const start = countItem(bot, item)
  // Per-position failure blacklist. Without it a findable-but-unreachable block
  // (e.g. a trunk boxed in by leaves the pathfinder won't break) loops FOREVER:
  // find it -> can't path -> find the same block again. Verified live.
  const failed = new Map()
  const pkey = p => `${p.x},${p.y},${p.z}`
  let mined = 0
  let exploreIdx = 0
  let dryExplores = 0 // consecutive explores that turned up nothing new
  let noYield = 0     // blocks mined lately with NO item gain (drops lost to gaps)
  let stripDug = 0    // times we've strip-mined DOWN this gather (bounded)
  let reachFails = 0  // consecutive "found stone but couldn't reach it" (buried -> strip-mine)
  let lastFoodHunt = 0 // throttle the survival-hunt so it doesn't chase every loop
  let lastShelter = 0  // throttle the night-shelter check
  const isLogGather = /_log$/.test(item) // logs get the natural-tree-only anti-grief filter
  const MAX_EXPLORE = 12 // wander this many times before truly giving up
  // Whether this resource can be reached by digging DOWN (stone/ore under the surface).
  // Plains/grassland have none exposed, so instead of wandering forever we mine a shaft.
  const canStrip = sources.some(s => /stone|deepslate|cobble|granite|diorite|andesite|tuff|_ore$|ancient_debris/.test(s))
  const MAX_STRIP = 5 // shafts per gather before giving up
  const NO_YIELD_LIMIT = 10 // mine-with-no-pickup before relocating to better ground
  const cap = count * 4 + 80 // ultimate backstop against grinding forever
  // Depth cap for MINING (tool-required) gathers: chasing exposed stone down into a
  // cave/ravine strands the bot (can't climb ~30 blocks back). Track the highest
  // ground we've stood on and never target stone/ore more than MAX_MINE_DEPTH below
  // it, so mining stays near the surface. Surface resources (logs/dirt) are exempt.
  // Anchor to the PERSISTENT surface (passed from the build/provision run) if we have
  // it, NOT the current position - else each batch re-anchors to wherever we ended up
  // (often already deep from a failed climb-out) and the depth cap slides down with us,
  // ratcheting the bot toward lava (verified live: sank to y4 on deepslate). Only ever
  // moves UP (Math.max), never down.
  let surfaceY = opts.surfaceY != null ? opts.surfaceY : bot.entity.position.y
  // Generous enough to reach hillside/plateau-edge stone, tight enough to refuse the
  // 30+ block dive into a cave/ravine that stranded the bot.
  const MAX_MINE_DEPTH = parseInt(process.env.GATHER_MAX_DEPTH || '16', 10)
  // ABSOLUTE floor: never mine/dig below this Y, so a runaway descent can't reach the
  // deep lava layer no matter what. Well above 1.21 lava pockets.
  const STRIP_FLOOR = parseInt(process.env.STRIP_FLOOR_Y || '30', 10)
  const belowCap = y => (reqTool && y < surfaceY - MAX_MINE_DEPTH) || y <= STRIP_FLOOR
  // How far we may still safely dig DOWN from here before hitting the depth cap or the
  // absolute floor. <=0 means "already deep enough - do NOT dig, climb out instead".
  // This is what stops the ratchet: even a failed climb-out can't make it sink further.
  const stripBudget = () => {
    const y = Math.floor(bot.entity.position.y)
    return Math.min(6, y - (surfaceY - MAX_MINE_DEPTH), y - STRIP_FLOOR)
  }

  // Surface to breathe when air runs low - mining near/into water otherwise drowns
  // us (verified live: the bot drowned mid-cobble-run in cratered savanna, losing
  // the whole provisioning run). Jumping swims us upward toward air.
  async function breathe () {
    if ((bot.oxygenLevel ?? 20) >= 8) return
    const deadline = Date.now() + 8000
    try {
      while ((bot.oxygenLevel ?? 20) < 16 && Date.now() < deadline && !isStopped()) {
        bot.setControlState('jump', true)
        await new Promise(r => setTimeout(r, 200))
      }
    } finally { bot.setControlState('jump', false) }
  }

  // Break one block: walk in reach, equip the right tool, dig. Returns true/throws.
  async function breakBlock (blk) {
    await breathe()
    if ((bot.oxygenLevel ?? 20) < 4) throw new Error('too deep underwater - surfacing') // never drown for a block
    if (bot.entity.position.distanceTo(blk.position) > 4.2) {
      await gotoWithTimeout(bot, new goals.GoalNear(blk.position.x, blk.position.y, blk.position.z, 2), 15000)
    }
    if (bot.entity.position.distanceTo(blk.position) > 5.5) throw new Error('out of reach')
    const tool = toolForBlock(bot, blk.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(blk)) throw new Error('cannot dig from here')
    await bot.dig(blk)
    mined++
  }

  while (countItem(bot, item) - start < count) {
    if (isStopped()) return { gathered: countItem(bot, item) - start, reason: 'stopped' }
    // SURVIVAL: starving with nothing to eat -> break off and hunt an animal for meat
    // (auto-eat feeds on it). Body-side because during a build the BRAIN is held and can't
    // do this; a long gather in a food-poor area otherwise runs the bot to 0 food / 1 hp
    // with no way back. Throttled so it doesn't chase every loop.
    if (needsFood(bot) && Date.now() - lastFoodHunt > 20000) {
      lastFoodHunt = Date.now()
      if (opts.say) opts.say('starving - hunting something to eat first')
      try { await huntForFood(bot, { isStopped }) } catch { /* keep gathering regardless */ }
    }
    // SHELTER: naked at night with a hostile bearing down -> dig in and wait it out. A sealed
    // pit survives a creeper where fleeing didn't (it died to one, unarmed, mid-gather). Only
    // when actually threatened + under-armored, so it doesn't burrow every night for nothing.
    if (shelterNeeded(bot) && Date.now() - lastShelter > 15000) {
      lastShelter = Date.now()
      if (opts.say) opts.say('mobs out and no armor - digging in till it\'s safe')
      try { await digInForNight(bot, { isStopped, say: opts.say }) } catch { /* keep going */ }
    }
    if (!haveReqTool()) return { gathered: countItem(bot, item) - start, reason: `my ${toolKind} broke` } // ran out mid-job
    if (mined >= cap) { await collectDrops(bot, 12); if (countItem(bot, item) - start < count) return { gathered: countItem(bot, item) - start, reason: `mined ${mined} blocks but couldn't collect enough (drops lost?)` } }

    surfaceY = Math.max(surfaceY, bot.entity.position.y) // highest ground we've stood on
    const feetY = Math.floor(bot.entity.position.y)
    let candidates = bot.findBlocks({ matching: ids, maxDistance: 64, count: 32 })
      .filter(p => (failed.get(pkey(p)) || 0) < 2)
      // Skip SUBMERGED targets (water on top): mining into water is how we drowned.
      .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return !(a && /water/i.test(a.name)) })
      // Don't chase stone/ore deep below the surface (cave-descent stranding).
      .filter(p => !belowCap(p.y))
      // ANTI-GRIEF: logs must be NATURAL trees (never a village house / log build); every
      // OTHER gather (stone/dirt/sand/...) must not be right next to a player structure, so a
      // cobble/dirt run near a base can't dismantle a wall or crater a yard.
      .filter(p => isLogGather ? isWildTreeLog(bot, p) : !structureNearby(bot, p, 3))
    // Underground (we strip-mined down), mine HORIZONTALLY, not straight down: a block
    // AT foot/head level drops cobble at our feet to auto-collect; mining the floor
    // drops it into the pit below and loses it (verified: got 1 cobble in 90s digging
    // down). Prefer targets at/above feet; only fall to lower ones if there are none.
    if (feetY < surfaceY - 1) {
      const level = candidates.filter(p => p.y >= feetY && p.y <= feetY + 2)
      if (level.length) candidates = level
    }
    const target = candidates[0] && bot.blockAt(candidates[0])
    if (!target) {
      // Nothing reachable here - grab any nearby drops first.
      await collectDrops(bot, 12)
      // STRIP-MINE: for stone/ore, there may be none EXPOSED (plains) - dig our own
      // shaft down to the stone layer instead of wandering, then re-scan (the shaft
      // walls are now reachable stone). Bounded, and only while safely above bedrock.
      if (canStrip && stripDug < MAX_STRIP && stripBudget() > 0) {
        if (opts.say && stripDug === 0) opts.say(`no ${sources[0]} up here - digging down to reach it`)
        const dug = await digShaftDown(bot, stripBudget(), { isStopped })
        if (dug > 0) await mineTunnel(bot, item, 16, stripDug, { isStopped }) // mine a drop-safe tunnel
        stripDug++
        if (dug > 0) { dryExplores = 0; continue }
        // couldn't dig down (bedrock/void/lava underfoot) -> fall through to wandering
      } else if (canStrip && stripBudget() <= 0 && Math.floor(bot.entity.position.y) < surfaceY - 3) {
        // already at the depth cap but no reachable stone -> we're stuck deep (a cave
        // fall or tapped-out shaft). Bail so runGather's climb-out gets us back up.
        return { gathered: countItem(bot, item) - start, reason: 'mined out down here - climbing back up' }
      }
      // WANDER to fresh terrain.
      if (dryExplores >= MAX_EXPLORE) return { gathered: countItem(bot, item) - start, reason: `searched far and wide, no reachable ${sources.join('/')}` }
      if (opts.say && dryExplores === 0) opts.say(`looking further afield for ${sources[0]}...`)
      await explore(bot, exploreIdx++)
      dryExplores++
      continue
    }
    dryExplores = 0 // found something within range

    const before = countItem(bot, item)
    try { await breakBlock(target) } catch (e) {
      failed.set(pkey(target.position), (failed.get(pkey(target.position)) || 0) + 1)
      reachFails++
      // Stone is FOUND but we keep failing to reach it -> it's buried (plains): the
      // path can't dig dirt to get there. Strip-mine straight down to it instead of
      // grinding through dozens of doomed gotos, then re-scan from inside the stone.
      if (canStrip && reachFails >= 3 && stripDug < MAX_STRIP && stripBudget() > 0) {
        if (opts.say && stripDug === 0) opts.say(`the ${sources[0]} is all buried - digging down to it`)
        const dug = await digShaftDown(bot, stripBudget(), { isStopped })
        if (dug > 0) await mineTunnel(bot, item, 16, stripDug, { isStopped }) // mine a drop-safe tunnel
        stripDug++; reachFails = 0
      }
      continue
    }
    reachFails = 0 // reached one - reset the buried-stone counter
    // Mine the LOCAL cluster (adjacent same-type blocks) so we stay put and drops
    // land at our feet for proximity pickup - works for both trees and stone.
    let cur = bot.findBlock({ matching: ids, maxDistance: 4 })
    if (cur && belowCap(cur.position.y)) cur = null // don't descend via the cluster either
    let n = 0
    while (cur && n < 8 && countItem(bot, item) - start < count && haveReqTool()) {
      if (isStopped()) break
      try { await breakBlock(cur) } catch { failed.set(pkey(cur.position), (failed.get(pkey(cur.position)) || 0) + 1); break }
      n++
      cur = bot.findBlock({ matching: ids, maxDistance: 4 })
      if (cur && belowCap(cur.position.y)) cur = null
    }
    await collectDrops(bot, 8) // sweep up what the cluster dropped

    // Lost-drop detection: we broke blocks but gained NO items - drops are falling
    // into gaps/void here (verified live: mining a platform edge lost every cobble).
    // Blacklist this spot and relocate to fresh ground rather than grind it dry.
    if (countItem(bot, item) === before) {
      failed.set(pkey(target.position), 2)
      noYield += n + 1
      if (noYield >= NO_YIELD_LIMIT) { await explore(bot, exploreIdx++); noYield = 0 }
    } else { noYield = 0 }
  }
  return { gathered: countItem(bot, item) - start, reason: 'done' }
}

// Ensure a crafting table is reachable: use a nearby one, or craft + place one.
async function ensureTable (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const tableId = mcData.blocksByName.crafting_table.id
  let table = bot.findBlock({ matching: tableId, maxDistance: 16 })
  if (table) return table
  if (countItem(bot, 'crafting_table') === 0) {
    const def = mcData.itemsByName.crafting_table
    const recipe = bot.recipesFor(def.id, null, 1, null)[0]
    if (!recipe) throw new Error('cannot craft a crafting table (need 4 planks)')
    await bot.craft(recipe, 1, null)
  }
  // place it on solid ground next to us
  const b = bot.entity.position.floored()
  let ref = null
  for (let r = 1; r <= 3 && !ref; r++) {
    for (let dx = -r; dx <= r && !ref; dx++) {
      for (let dz = -r; dz <= r && !ref; dz++) {
        if (dx === 0 && dz === 0) continue
        const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1, b.z + dz))
        const above = bot.blockAt(new Vec3(b.x + dx, b.y, b.z + dz))
        if (ground && ground.boundingBox === 'block' && above && above.name === 'air') ref = ground
      }
    }
  }
  if (!ref) throw new Error('nowhere to place a crafting table')
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'crafting_table')
  await bot.equip(item, 'hand')
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
  await bot.placeBlock(ref, new Vec3(0, 1, 0))
  table = bot.findBlock({ matching: tableId, maxDistance: 8 })
  if (!table) throw new Error('placed a table but cannot find it')
  return table
}

// Craft `count` result items of `item` (walks to / places a table when needed).
async function runCraft (bot, item, count, needsTable, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const def = mcData.itemsByName[item]
  if (!def) throw new Error(`unknown item ${item}`)
  let table = null
  if (needsTable) {
    table = await ensureTable(bot, opts)
    if (bot.entity.position.distanceTo(table.position) > 3) {
      await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000)
    }
  }
  const before = countItem(bot, item)
  // Craft ONE recipe per call with a settle delay. Batching (craft(recipe, 11))
  // desyncs the client inventory - verified live: 11 logs "became" 96 planks of
  // which most were GHOSTS that vanished on the next real server slot-update.
  let guard = count * 2 + 8 // hard stop so a non-converging count can't loop forever
  while (countItem(bot, item) - before < count && guard-- > 0) {
    const recipe = bot.recipesFor(def.id, null, 1, table)[0]
    if (!recipe) throw new Error(`no craftable recipe for ${item} (missing ingredients?)`)
    await bot.craft(recipe, 1, table)
    await new Promise(r => setTimeout(r, 250)) // let the server's slot updates land
  }
  const made = countItem(bot, item) - before
  if (made < count) throw new Error(`crafting stalled: made ${made}/${count} ${item}`)
  return made
}

// Place one block of `itemName` from inventory on solid ground nearby.
// Returns the Vec3 where the new block landed.
async function placeFromInventory (bot, itemName) {
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === itemName)
  if (!item) throw new Error(`no ${itemName} to place`)
  const b = bot.entity.position.floored()
  let ref = null
  for (let r = 1; r <= 3 && !ref; r++) {
    for (let dx = -r; dx <= r && !ref; dx++) {
      for (let dz = -r; dz <= r && !ref; dz++) {
        if (dx === 0 && dz === 0) continue
        const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1, b.z + dz))
        const above = bot.blockAt(new Vec3(b.x + dx, b.y, b.z + dz))
        if (ground && ground.boundingBox === 'block' && above && above.name === 'air') ref = ground
      }
    }
  }
  if (!ref) throw new Error('no open ground to place on')
  await bot.equip(item, 'hand')
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
  await bot.placeBlock(ref, new Vec3(0, 1, 0))
  return ref.position.offset(0, 1, 0)
}

// Ensure a furnace is reachable: find a nearby one, or craft (8 cobblestone at a
// table) + place one. Returns the furnace block.
async function ensureFurnace (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const furnaceId = mcData.blocksByName.furnace.id
  let furnace = bot.findBlock({ matching: furnaceId, maxDistance: 12 })
  if (furnace) return furnace
  if (countItem(bot, 'furnace') === 0) {
    const table = await ensureTable(bot, opts)
    if (bot.entity.position.distanceTo(table.position) > 3) await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000)
    const recipe = bot.recipesFor(mcData.itemsByName.furnace.id, null, 1, table)[0]
    if (!recipe) throw new Error('cannot craft a furnace (need 8 cobblestone)')
    await bot.craft(recipe, 1, table)
    await new Promise(r => setTimeout(r, 250))
  }
  await placeFromInventory(bot, 'furnace')
  furnace = bot.findBlock({ matching: furnaceId, maxDistance: 8 })
  if (!furnace) throw new Error('placed a furnace but cannot find it')
  return furnace
}

// Smelt `count` of `input` into `output` in a furnace, fueling with planks/coal.
// Returns number produced. opts: { say, isStopped }.
async function runSmelt (bot, output, input, count, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const inItem = mcData.itemsByName[input]
  const furnaceBlock = await ensureFurnace(bot, opts)
  if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
    await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000)
  }
  const isFuel = i => /_planks$/.test(i.name) || i.name === 'coal' || i.name === 'charcoal' || i.name === 'coal_block' || /_log$/.test(i.name) || i.name === 'stick'
  const furnace = await bot.openFurnace(furnaceBlock)
  // While the furnace window is OPEN, bot.inventory is STALE - count everything
  // from the live window slots instead (verified live: smelted output landed in
  // window slot 6, invisible to countItem/outputItem() which read slot 2).
  const slotSum = name => (furnace.slots || []).filter(s => s && s.name === name).reduce((a, s) => a + s.count, 0)
  const outSum = () => slotSum(output)
  const inInv = name => { // window slots 3+ are the player inventory portion
    let n = 0; const sl = furnace.slots || []
    for (let i = 3; i < sl.length; i++) if (sl[i] && sl[i].name === name) n += sl[i].count
    return n
  }
  const before = outSum()
  let stall = 0; let lastMade = 0; let lastSay = 0; let tick = 0
  try {
    while (outSum() - before < count) {
      if (isStopped()) break
      try { await furnace.takeOutput() } catch {} // harmless if slot-2 output is empty
      const made = outSum() - before
      const stillNeed = count - made
      const cooking = furnace.inputItem() ? furnace.inputItem().count : 0
      if (!furnace.inputItem() && stillNeed > 0 && inInv(input) > 0) {
        try { await furnace.putInput(inItem.id, null, Math.min(stillNeed, inInv(input), 64)) } catch {}
      }
      // Refuel whenever there's anything to smelt (already loaded as `cooking`, OR
      // still sitting in our pack) and the furnace has no active fuel. The old
      // condition (stillNeed - cooking > 0) stopped fueling once ALL the input was
      // loaded, so the furnace burned one item then sat idle full of cobble.
      if (!furnace.fuelItem() && stillNeed > 0 && (cooking > 0 || inInv(input) > 0)) {
        const fuelName = ['coal', 'charcoal'].find(n => inInv(n) > 0) || (furnace.slots || []).slice(3).find(s => s && isFuel(s))?.name
        if (fuelName) {
          const fid = mcData.itemsByName[fuelName].id
          const want = /_planks$/.test(fuelName) ? Math.max(2, Math.ceil(stillNeed / ITEMS_PER_PLANK) + 1) : 8
          try { await furnace.putFuel(fid, null, Math.min(inInv(fuelName), want)) } catch {}
        }
      }
      if (made > lastMade) { lastMade = made; stall = 0 } else stall++
      const noFuel = !furnace.fuelItem() && !(furnace.slots || []).slice(3).some(s => s && isFuel(s))
      const noInput = !furnace.inputItem() && inInv(input) === 0
      if ((noFuel || noInput) && !furnace.outputItem() && cooking === 0) break
      if (stall > 90) break
      if (made > 0 && Date.now() - lastSay > 20000) { say(`smelting… ${made}/${count} ${output}`); lastSay = Date.now() }
      tick++
      await new Promise(r => setTimeout(r, 1000))
    }
    for (let i = 0; i < 4; i++) { try { await furnace.takeOutput() } catch {} await new Promise(r => setTimeout(r, 200)) }
    var madeFinal = outSum() - before
  } finally { try { furnace.close() } catch {} }
  await new Promise(r => setTimeout(r, 300)) // let inventory re-sync after close
  if ((madeFinal || 0) < count) throw new Error(`smelting stalled: ${madeFinal || 0}/${count} ${output} (out of fuel or input?)`)
  return madeFinal
}

// Strip `count` base logs into stripped logs: place a log, right-click with an
// axe to strip it in-world, then mine it back. Returns number produced.
async function runStrip (bot, output, input, count, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const before = countItem(bot, output)
  bot.pathfinder.setMovements(gatherMovements(bot))
  try {
    let guard = count * 3 + 8
    while (countItem(bot, output) - before < count && guard-- > 0) {
      if (isStopped()) break
      if (countItem(bot, input) === 0) throw new Error(`out of ${input} to strip`)
      const pos = await placeFromInventory(bot, input) // place a base log
      const axe = (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_axe'))
      if (!axe) throw new Error('no axe to strip with')
      await bot.equip(axe, 'hand').catch(() => {})
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true).catch(() => {})
      const block = bot.blockAt(pos)
      try { await bot.activateBlock(block) } catch {} // right-click strips it
      await new Promise(r => setTimeout(r, 150))
      const stripped = bot.blockAt(pos) // should now be stripped_*
      try { await bot.dig(stripped) } catch {}
      await collectDrops(bot)
    }
  } finally {
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements()
  }
  const made = countItem(bot, output) - before
  if (made < count) throw new Error(`stripping stalled: ${made}/${count} ${output}`)
  return made
}

// Execute a plan task-by-task: gather -> craft -> smelt -> strip, in order.
async function runPlan (bot, plan, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const results = []
  for (const task of plan.tasks) {
    if (isStopped()) { results.push({ task, ok: false, note: 'stopped' }); break }
    try {
      if (task.type === 'gather') {
        say(`gathering ${task.count}x ${task.item}...`)
        const r = await runGather(bot, task.item, task.count, opts)
        results.push({ task, ok: r.gathered >= task.count, note: `${r.gathered}/${task.count} (${r.reason})` })
        if (r.gathered < task.count) break // downstream crafts would fail anyway
      } else if (task.type === 'craft') {
        say(`crafting ${task.crafts * task.perCraft}x ${task.item}...`)
        const made = await runCraft(bot, task.item, task.crafts * task.perCraft, task.needsTable, opts)
        results.push({ task, ok: true, note: `made ${made}` })
      } else if (task.type === 'smelt') {
        say(`smelting ${task.count}x ${task.output}...`)
        const made = await runSmelt(bot, task.output, task.input, task.count, opts)
        results.push({ task, ok: made >= task.count, note: `smelted ${made}` })
        if (made < task.count) break
      } else if (task.type === 'strip') {
        say(`stripping ${task.count}x ${task.output}...`)
        const made = await runStrip(bot, task.output, task.input, task.count, opts)
        results.push({ task, ok: made >= task.count, note: `stripped ${made}` })
        if (made < task.count) break
      }
    } catch (e) {
      results.push({ task, ok: false, note: e.message })
      break
    }
  }
  return results
}

// ---- chest storage (for builds too big to hold in 36 slots) ------------------

// Items the bot KEEPS on itself and never stashes: tools, weapons, armor, food,
// utility blocks, and a little scaffold dirt. Everything else is build material
// that goes into the chest.
const KEEP_ON_BOT = /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|^shears$|_helmet$|_chestplate$|_leggings$|_boots$|^cooked_|_apple$|^bread$|^carrot$|^potato$|beef|porkchop|mutton|chicken|^cod$|^salmon$|^torch$|flint_and_steel|_bucket$|^bucket$|^crafting_table$|^furnace$|^chest$|^coal$|^charcoal$/

// Find a chest within range, or craft (8 planks) + place one next to us. Returns
// the chest Block. Reuses the table/furnace placement pattern.
async function ensureChest (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const chestId = mcData.blocksByName.chest.id
  let chest = bot.findBlock({ matching: chestId, maxDistance: 8 })
  if (chest) return chest
  if (countItem(bot, 'chest') === 0) {
    const table = await ensureTable(bot, opts)
    if (bot.entity.position.distanceTo(table.position) > 3) await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000)
    const recipe = bot.recipesFor(mcData.itemsByName.chest.id, null, 1, table)[0]
    if (!recipe) throw new Error('cannot craft a chest (need 8 planks)')
    await bot.craft(recipe, 1, table)
    await new Promise(r => setTimeout(r, 250))
  }
  await placeFromInventory(bot, 'chest')
  chest = bot.findBlock({ matching: chestId, maxDistance: 6 })
  if (!chest) throw new Error('placed a chest but cannot find it')
  return chest
}

async function gotoChest (bot, chestBlock) {
  if (bot.entity.position.distanceTo(chestBlock.position) > 3) {
    await gotoWithTimeout(bot, new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 15000)
  }
}

// Deposit all BUILD MATERIALS (everything not in KEEP_ON_BOT) into the chest, so
// the pack doesn't overflow mid-provision. Keeps `keepDirt` dirt for bridging.
// Returns the number of items deposited.
async function depositMaterials (bot, chestBlock, opts = {}) {
  const keepDirt = opts.keepDirt || 0
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  let n = 0
  try {
    for (const it of bot.inventory.items()) {
      if (KEEP_ON_BOT.test(it.name)) continue
      let count = it.count
      if (it.name === 'dirt' && keepDirt) count = Math.max(0, it.count - keepDirt)
      if (count <= 0) continue
      try { await chest.deposit(it.type, null, count); n += count } catch { /* chest full / slot race */ }
    }
  } finally { chest.close() }
  return n
}

// Withdraw up to `count` of `itemName` from the chest. Returns how many came out.
async function withdrawItem (bot, chestBlock, itemName, count) {
  const mcData = require('minecraft-data')(bot.version)
  const def = mcData.itemsByName[itemName]
  if (!def || count <= 0) return 0
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  let got = 0
  try {
    const have = chest.containerItems().filter(i => i.name === itemName).reduce((a, b) => a + b.count, 0)
    const take = Math.min(count, have)
    if (take > 0) { await chest.withdraw(def.id, null, take); got = take }
  } finally { chest.close() }
  return got
}

// Read chest contents as { name: count } (build materials the chest is holding).
async function chestCounts (bot, chestBlock) {
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  const out = {}
  try { for (const i of chest.containerItems()) out[i.name] = (out[i.name] || 0) + i.count } finally { chest.close() }
  return out
}

module.exports = { GATHER_SOURCES, GATHER_TOOL, SMELT_MAP, STRIP_MAP, planProvision, inventoryCounts, runGather, runCraft, runSmelt, runStrip, runPlan, ensureTable, ensureFurnace, ensureChest, depositMaterials, withdrawItem, chestCounts, detectWood, KEEP_ON_BOT, climbToSurface, hasSolidCeiling, gatherLeather, huntForFood, hasFood, needsFood, digInForNight, isSheltering, shelterNeeded }
