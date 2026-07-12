'use strict'
// Provisioning: turn a bill of materials into a gather/craft/smelt plan and
// execute it - the "self-sufficient builder" half of schematic building.
// The bot ACQUIRES everything like a real survival player: chop trees, mine
// natural blocks, craft chains (logs→planks→stairs), smelt (sand→glass).
// No /give, no creative - see NOTES §10 + the natural-player goal.
//
// planProvision() is pure (mcData + counts in, task list out) and offline-
// testable. run*() helpers execute against a live bot.

const fs = require('fs')
const path = require('path')
const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const navigate = require('./navigate.js') // unified navigation (it lazy-requires us back for climb/pillar/water-hop)
// Visible, UNTHROTTLED build tracing to stdout (the say() progress goes through a 40s
// throttle that hides failures). Enable with BUILD_DEBUG=1 to see every plan/task/smelt step.
let dbgSink = null // injected by index.js: debug lines persist to logs/bot-events.log
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

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
  m.liquidCost = 4 // route AROUND lakes: water was priced like land, so A* happily swam
  // (slow, drowning risk, and the brain panics "get out of water" the whole time)
  m.blocksCantBreak = new Set(
    Object.values(md.blocksByName).filter(b => !/_leaves$/.test(b.name)).map(b => b.id)
  )
  return m
}

// MANUAL water escape: face the nearest bank cell (solid ground with headroom, up to +1
// higher) and hold jump+sprint+forward until we're standing on it. Bypasses the
// pathfinder entirely - in water it never registers "on ground", so its planned jumps
// never fire and it bobs in a puddle forever (library flaw, watched live for 8 minutes).
async function manualHopFromWater (bot) {
  const feet = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    for (const dy of [0, 1]) {
      const bank = bot.blockAt(feet.offset(dx, dy - 1, dz))   // the block we'd stand ON
      const space1 = bot.blockAt(feet.offset(dx, dy, dz))     // body space
      const space2 = bot.blockAt(feet.offset(dx, dy + 1, dz)) // head space
      if (!bank || bank.boundingBox !== 'block' || /water|lava/.test(bank.name)) continue
      if (!space1 || (!AIRISH(space1.name) && !/water/.test(space1.name))) continue
      if (!space2 || !AIRISH(space2.name)) continue
      try {
        bot.pathfinder.setGoal(null)
        await bot.lookAt(bank.position.offset(0.5, 1.2, 0.5), true)
        bot.setControlState('jump', true); bot.setControlState('forward', true); bot.setControlState('sprint', true)
        const t0 = Date.now()
        while (Date.now() - t0 < 2500) {
          await new Promise(r => setTimeout(r, 100))
          const f = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
          if (f && f.boundingBox === 'block' && !/water/.test(f.name) && bot.entity.onGround) { bot.clearControlStates(); dbg('  hopped out of the water onto ' + f.name); return true }
        }
      } finally { bot.clearControlStates() }
    }
  }
  dbg('  manual water hop found no bank - still wet')
  return false
}

// Long treks in ~48-block legs. A single 200-block GoalNearXZ makes the pathfinder chew
// an enormous search space in one solve - the operator watched the bot stand motionless
// at a lake for two minutes while it "thought". Short legs solve instantly, follow the
// terrain, and give stall detection something to measure. (commands.js's travelFar is the
// full-featured cousin with door-assist; this is the light provision-side version for
// memory/bed/grove treks that can't import it without a require cycle.)
async function walkStaged (bot, tx, tz, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const deadline = Date.now() + (opts.timeoutMs || 180000)
  let stalls = 0
  while (!isStopped() && Date.now() < deadline) {
    const p = bot.entity.position
    const d = Math.hypot(tx - p.x, tz - p.z)
    if (d <= (opts.range || 8)) return true
    const step = Math.min(48, d)
    const lx = p.x + ((tx - p.x) / d) * step
    const lz = p.z + ((tz - p.z) / d) * step
    const from = { x: p.x, z: p.z }
    // Each leg runs through the UNIFIED navigator (navigate.js): the water-hop, pit
    // pillar-out, cave climb-out and cliff-checked surface nudge that used to be an
    // inline ladder here now fire consistently for every caller.
    try {
      await navigate.navigateTo(bot, new goals.GoalNearXZ(lx, lz, 4), {
        timeoutMs: 30000, deadlineMs: 75000, isStopped, label: 'walkStaged',
        budgets: { water: 1, pit: 1, door: 1, climb: 1, nudge: 1 } // one rescue of each kind per leg - this loop retries legs
      })
    } catch {}
    const np = bot.entity.position
    if (Math.hypot(np.x - from.x, np.z - from.z) < 3) {
      stalls++
      if (stalls >= 3) { dbg('walkStaged: giving up wedged at ' + Math.round(np.x) + ',' + Math.round(np.z)); return false }
    } else stalls = 0
  }
  return false
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
  raw_iron: ['iron_ore', 'deepslate_iron_ore'], // iron armor bootstrap (pillager patrols eat naked bots)
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
  cobblestone: 'wooden_pickaxe',
  raw_iron: 'stone_pickaxe' // iron ore drops nothing below stone tier
}

// smelt-only outputs: output item -> furnace input item (recursively provisioned)
const SMELT_MAP = {
  iron_ingot: 'raw_iron',
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

// How many furnaces a smelt of `count` items warrants: one per 16 items, capped at 4.
// ONE shared definition for the planner (cobble budget) and runtime (ensureFurnaces) -
// the previous parallel-furnace attempt failed partly because the runtime wanted
// furnaces the planner never budgeted 8 cobble each for.
function furnaceCountFor (count) { return Math.max(1, Math.min(4, Math.ceil(count / 16))) }

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
  // Track the portion of consumption satisfied by the CALLER'S inventory (vs craft
  // surplus credited back to avail mid-plan). When the inventory passed in is total
  // holdings (pack + chests), `used` is exactly what must be in the PACK before the
  // plan runs - i.e. what the resource model has to withdraw from the bank first.
  const stockLeft = { ...inventory }
  const used = {}
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
    const taken = Math.min(have, count)
    avail[name] = have - taken
    const fromStock = Math.min(taken, stockLeft[name] || 0)
    if (fromStock > 0) { stockLeft[name] = stockLeft[name] - fromStock; used[name] = (used[name] || 0) + fromStock }
    return count - taken
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

  // Furnace(s) + fuel, once, for all smelting.
  const smeltTotal = smelts.reduce((s, x) => s + x.count, 0)
  if (furnaceNeeded && smeltTotal > 0) {
    // PARALLEL FURNACES: big smelts run across up to 4 furnaces (N cook concurrently
    // server-side; the bot shuttles loads). Budget 8 cobble per furnace we don't already
    // have - `opts.furnacesNearby` = placed furnaces near the site (they're never dug up,
    // so batch 2+ reuses batch 1's). Furnace ITEMS in the pack are netted by take().
    const nWant = furnaceCountFor(smeltTotal)
    const nHave = Math.min(nWant, opts.furnacesNearby || 0)
    need('furnace', nWant - nHave, [])
    // FUEL: net out coal/charcoal we already have (coal smelts 8 items vs 1.5 for a plank),
    // so a coal vein hit while strip-mining kills most of the fuel-wood chopping. Each
    // furnace can waste up to a partial burn -> buffer scales with nWant.
    const coalUnits = ((avail.coal || 0) + (avail.charcoal || 0)) * 8 + (avail.coal_block || 0) * 80
    const uncovered = smeltTotal - coalUnits
    if (uncovered > 0) {
      const plankCounts = {}
      for (const n of craftOrder) if (isPlank(n)) plankCounts[n] = craftReq[n].crafts * craftReq[n].perCraft
      const fuelPlank = Object.entries(plankCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || `${opts.primaryWood || 'oak'}_planks`
      need(fuelPlank, Math.ceil(uncovered / ITEMS_PER_PLANK) + 2 + 2 * nWant, [])
    }
  }
  // Pickaxes for the cobble mine. A wooden pick survives ~59 blocks (breaks mid-run ->
  // re-plan churn), so craft enough FRESH ones - UNLESS we already hold a stone-or-better
  // pick (2x faster, 131 uses); then don't waste wood on redundant wooden picks.
  if (gathers.cobblestone) {
    const better = ['netherite', 'diamond', 'iron', 'stone'].some(m => (avail[m + '_pickaxe'] || 0) > 0)
    if (!better) {
      const want = Math.max(1, Math.ceil(gathers.cobblestone / 50))
      // Ignore possibly-WORN picks (a leftover broke after 4 cobble, verified) - but count
      // UNWORN ones the caller vouches for (opts.freshPickaxes), else every re-plan round
      // crafts 2 more picks and the pack fills with them (verified live: 11 picks).
      avail.wooden_pickaxe = opts.freshPickaxes || 0
      stockLeft.wooden_pickaxe = Math.min(stockLeft.wooden_pickaxe || 0, opts.freshPickaxes || 0)
      const planned = craftReq.wooden_pickaxe ? craftReq.wooden_pickaxe.crafts : 0
      if (want > planned) need('wooden_pickaxe', want - planned, [])
    }
  }
  if (needsTable) need('crafting_table', 1, [])

  // ---- assemble into tech-tree phases ----
  const gEntries = Object.entries(gathers)
  const logGathers = gEntries.filter(([n]) => /_log$/.test(n))
  const otherGathers = gEntries.filter(([n]) => !/_log$/.test(n))
  const basicPriority = n => (n === 'crafting_table' ? 1 : isPlank(n) ? 0 : n === 'stick' ? 2 : isTool(n) ? 3 : 99)
  // Only WOODEN tools are "basics" (craftable from the log phase alone). A stone/iron tool
  // needs a GATHERED (or smelted) ingredient, so it must come in `finals` AFTER the gather
  // phase - sorting stone_pickaxe as a basic put its craft BEFORE gather:cobblestone and it
  // failed with "no craftable recipe" every from-nothing run.
  const isBasic = n => n === 'crafting_table' || isPlank(n) || n === 'stick' || (isTool(n) && /^wooden_/.test(n))
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
  return { tasks, gathers, crafts: craftReq, smelts, strips, tools: [...toolsNeeded], unobtainable, needsTable, used }
}

// Current inventory as {itemName: count}.
function inventoryCounts (bot) {
  const out = {}
  for (const i of (bot.inventory ? bot.inventory.items() : [])) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

// ---- executors (live bot) ----------------------------------------------------

function countItem (bot, name) { return inventoryCounts(bot)[name] || 0 }

// pathfinder.goto with a deadline (goto can hang forever on an unreachable target).
// One shared implementation now - navigate.js.
function gotoWithTimeout (bot, goal, ms) {
  return navigate.gotoOnce(bot, goal, ms)
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
async function explore (bot, idx, home, maxRoam, isBad) {
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  const D = 48
  const p = bot.entity.position
  let tx; let tz
  // ROAM FENCE: if we have a home anchor, only step to a spot still within maxRoam of it -
  // else the rotating-compass walk drifts outward forever (one distant tree resets the
  // give-up counter). If no direction fits (we're at/over the fence), head 48 toward home.
  if (home && maxRoam) {
    const overFence = Math.hypot(p.x - home.x, p.z - home.z) >= maxRoam - 8
    if (overFence) {
      const back = Math.hypot(home.x - p.x, home.z - p.z) || 1
      tx = Math.round(p.x + ((home.x - p.x) / back) * D)
      tz = Math.round(p.z + ((home.z - p.z) / back) * D)
    } else {
      // ROOMBA: two passes over the compass - first prefer legs landing in UNSEARCHED
      // cells (isBad = negative memory), only then settle for any in-fence leg. Without
      // this the rotation re-swept the same barren ground round after round (live).
      let picked = null
      for (let pass = 0; pass < 2 && !picked; pass++) {
        for (let k = 0; k < 8 && !picked; k++) { // start at idx, rotate until one fits
          const [dx, dz] = dirs[(((idx + k) % 8) + 8) % 8]
          const n = Math.hypot(dx, dz) || 1
          const cx = Math.round(p.x + (dx / n) * D); const cz = Math.round(p.z + (dz / n) * D)
          if (Math.hypot(cx - home.x, cz - home.z) > maxRoam) continue
          if (pass === 0 && isBad && isBad(cx, cz)) continue
          picked = [cx, cz]
        }
      }
      const back = Math.hypot(home.x - p.x, home.z - p.z) || 1
      ;[tx, tz] = picked || [Math.round(p.x + ((home.x - p.x) / back) * D), Math.round(p.z + ((home.z - p.z) / back) * D)]
    }
  } else {
    const [dx, dz] = dirs[((idx % 8) + 8) % 8]
    const norm = Math.hypot(dx, dz) || 1
    tx = Math.round(p.x + (dx / norm) * D)
    tz = Math.round(p.z + (dz / norm) * D)
  }
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
// Is the bot standing on/next to a remembered HUT (footprint + a 2-block apron, so the
// doorway stays walkable)? Strip-mining must NOT open a shaft here - it dug a pit right
// in front of the door and the bot then struggled to get into its own safehouse (live).
function onHutApron (bot, pos) {
  const p = pos || bot.entity.position.floored()
  for (const h of listInfra('hut')) {
    if (p.x >= h.x - 2 && p.x <= h.x + 6 && p.z >= h.z - 2 && p.z <= h.z + 6) return h
  }
  return null
}

// After the hut builds, GUARANTEE a flush doorstep. The ground right in front of the door is
// often 1-2 blocks below the hut floor (median-surface snap + natural slope + gather shafts),
// so the bot steps straight out the door into a pit and then struggles to get back into its own
// safehouse ("hole at the front door", seen live repeatedly). onHutApron only STOPS new digging;
// this positively FILLS the exit lane up to floor level. Best-effort + idempotent: runs each camp
// pass and re-heals any hole a gather cycle re-opens. `at` = hut anchor; the schematic door sits
// at rel (2,*,0) on the z=0 wall, so it opens toward -z (outside = at.z - 1).
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

async function digShaftDown (bot, maxDepth, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const DANGER = /lava|water/
  // Never sink a shaft on the hut's doorstep. Step clear of the apron first (toward the
  // build site if we know it, else just off the apron) so the entrance stays intact.
  if (onHutApron(bot)) {
    const h = onHutApron(bot)
    const away = opts.home && (Math.abs(opts.home.x - h.x) > 8 || Math.abs(opts.home.z - h.z) > 8)
      ? new Vec3(opts.home.x, bot.entity.position.y, opts.home.z)
      : new Vec3(h.x + 12, bot.entity.position.y, h.z + 12)
    dbg('  shaft: on the hut apron - stepping clear to ' + Math.round(away.x) + ',' + Math.round(away.z) + ' before digging')
    try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 3), 20000) } catch {}
    if (onHutApron(bot)) { dbg('  shaft: still on apron - refusing to dig here'); return 0 }
  }
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
      const filler = scaffold.pickFiller(bot) // dirt-first, one policy for every scaffold placer
      if (filler) {
        await bot.equip(filler, 'hand').catch(() => {})
        const under = bot.blockAt(sFloor.offset(0, -1, 0))
        try { if (under && !AIRISH(under.name)) { await bot.placeBlock(under, new Vec3(0, 1, 0)); scaffold.add(sFloor, 'staircase') } } catch {}
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
    // The FEET cell must be empty to receive the placed block: a sapling/bush standing in
    // it silently blocks EVERY placement - the bot jump-placed on its own orchard sapling
    // forever (operator watched it live). Soft vegetation only; anything solid we ride.
    const inFeet = bot.blockAt(feet)
    if (inFeet && !AIRISH(inFeet.name) && /sapling|_propagule$|grass|fern|flower|dead_bush|snow|vine/.test(inFeet.name)) {
      try { await bot.dig(inFeet); await new Promise(r => setTimeout(r, 150)) } catch {}
    }
    // dirt FIRST: cobble towers in the orchard read as stone litter (operator), and the
    // leveler has to shave them - dirt pockets back into scaffold supply instead.
    const filler = scaffold.pickFiller(bot)
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
          try { await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch (e) {
            // Paper often doesn't echo the blockUpdate on a SUCCESSFUL place (same quirk
            // as placeAt/torches) - the "miss" made us jump again on top of a block that
            // was already there: the operator-reported bunny-hop. Check the world.
            if (/blockUpdate/.test(e.message)) { await new Promise(r => setTimeout(r, 250)) }
          }
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
    // COAL BYCATCH (operator: "while mining iron it might as well get coal if close"):
    // the furnace runs on coal, so grab any coal ore this tunnel exposes - cheap, bounded.
    try { await grabNearbyOre(bot, /coal_ore$/, 3, 2, { isStopped }) } catch {}
    try { await gotoWithTimeout(bot, new goals.GoalBlock(ahead.x, ahead.y, ahead.z), 5000) } catch { break }
    if (!dugAny) break
  }
  return countItem(bot, itemName) - before
}

// Mine up to `max` blocks matching `oreRe` within `r` of the bot - opportunistic bycatch
// while tunnelling (coal for the furnace, etc.). Only natural blocks; best-effort.
async function grabNearbyOre (bot, oreRe, r, max, { isStopped = () => false } = {}) {
  let got = 0
  const found = bot.findBlocks({ matching: b => b && oreRe.test(b.name), maxDistance: r, count: max }) || []
  for (const p of found) {
    if (isStopped() || got >= max) break
    const b = bot.blockAt(p)
    if (!b || !canBreakNaturally(b)) continue
    try {
      if (bot.entity.position.distanceTo(b.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 6000)
      const tool = toolForBlock(bot, b.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(b)) continue
      await bot.dig(b); await collectDrops(bot, 2); got++
    } catch { /* skip this one */ }
  }
  if (got) dbg('  bycatch: grabbed ' + got + ' ' + oreRe.source)
  return got
}

async function runGather (bot, item, count, opts = {}) {
  // Anchor to the PERSISTENT surface (homeY, from the build/provision run) if given, not
  // wherever we happen to be standing now - so a batch that starts underground (previous
  // climb-out fell short, or we fell in a cave) still knows where the real surface is and
  // won't sink deeper. Falls back to the current spot when there's no home reference.
  const surfaceY = opts.homeY != null ? opts.homeY : Math.floor(bot.entity.position.y)
  // XZ home anchor for the ROAM FENCE (keeps gathering from drifting away from the build).
  // Prefer an explicit home {x,z}; else the homeY-implied spot; else where we stand now.
  const home = opts.home || { x: Math.round(bot.entity.position.x), y: surfaceY, z: Math.round(bot.entity.position.z) }
  bot.pathfinder.setMovements(gatherMovements(bot)) // may punch through leaves + pillar up
  dbg('runGather', item, 'x' + count, 'surfaceY=' + surfaceY, 'home=' + home.x + ',' + home.z, 'at', bot.entity.position.floored().toString())
  try {
    return await gatherLoop(bot, item, count, { ...opts, surfaceY, home })
  } finally {
    // Back to the surface if we're below it (strip-mined down OR fell into a cave). Try
    // three ways, in order, until we're within a couple blocks of the top: a spiral
    // staircase up, a straight pillar-up, then a pathfinder dig-out. Any one that works
    // ends it - so a cave with awkward geometry can't strand us.
    try {
      const need = () => bot.entity && bot.entity.position.y < surfaceY - 2
      if (need()) {
        dbg('  runGather climb-out from y=' + Math.floor(bot.entity.position.y) + ' to surfaceY=' + surfaceY)
        bot.pathfinder.setGoal(null)
        for (const climb of [
          () => digStaircaseUp(bot, surfaceY, { isStopped: opts.isStopped }),
          () => pillarUpTo(bot, surfaceY, { isStopped: opts.isStopped }),
          () => { bot.pathfinder.setMovements(climbMovements(bot)); return gotoWithTimeout(bot, new goals.GoalY(surfaceY), 30000) }
        ]) { if (!need()) break; try { await climb() } catch {} }
        dbg('  runGather climb-out ended at y=' + Math.floor(bot.entity.position.y))
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
  const maxExplores = opts.maxExplores != null ? opts.maxExplores : 2 // don't roam far for armor
  const home = opts.home // roam fence anchor (build site), if given
  const maxRoam = opts.maxRoam || 48
  const leatherNow = () => countItem(bot, 'leather')
  const start = leatherNow()
  bot.pathfinder.setMovements(gatherMovements(bot)) // anti-grief while chasing
  let killed = 0
  let explores = 0
  try {
    while (leatherNow() - start < target && killed < maxKills && Date.now() < deadline && !isStopped()) {
      // nearest leather animal within the fence (never chase a cow beyond maxRoam of home)
      let tgt = null; let best = 32
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
        if (!LEATHER_ANIMALS.test((e.name || '').toLowerCase())) continue
        if (home && Math.hypot(e.position.x - home.x, e.position.z - home.z) > maxRoam) continue
        const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
      }
      if (!tgt) { // none in range - roam to find some, but only a couple times (armor is optional)
        if (explores++ >= maxExplores) break
        await explore(bot, explores, home, maxRoam)
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
// How many edible items it's carrying (for "stock up" decisions, not just "any food?").
function foodCount (bot) {
  const md = require('minecraft-data')(bot.version)
  const foods = (md && md.foodsByName) || {}
  return (bot.inventory ? bot.inventory.items() : []).reduce((n, i) => n + (foods[i.name] ? i.count : 0), 0)
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

// NEVER rest IN water. The night carousel drowned the bot in its own flooding pit
// (observed on test server, hp 20 -> death while every command was held): resting flows
// cycled dig attempts while it bobbed in a basin, and nothing ever LEFT the water.
// Every rest/shelter entry point gets ashore first; bounded, honest about failure.
function inWaterNow (bot) {
  if (!bot.entity) return false
  const f = bot.blockAt(bot.entity.position.floored())
  const h = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))
  return !!((f && /water/.test(f.name)) || (h && /water/.test(h.name)))
}
async function ensureAshore (bot, isStopped = () => false) {
  if (!inWaterNow(bot)) return true
  dbg('rest: in water - getting ashore before any resting')
  try { if (await navigate.swimToShore(bot, isStopped)) return true } catch {}
  try { await manualHopFromWater(bot) } catch {}
  return !inWaterNow(bot)
}
// Where a shelter pit last FLOODED - do not dig another hole next to the same aquifer
// for a while (the re-dig loop beside water is the entombment/drowning mechanism).
let lastFlood = null // {x, z, at}
function nearRecentFlood (bot) {
  if (!lastFlood || Date.now() - lastFlood.at > 600000 || !bot.entity) return false
  return Math.hypot(bot.entity.position.x - lastFlood.x, bot.entity.position.z - lastFlood.z) <= 6
}
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
// Fire night-rest whenever we're under-armored and DUSK is falling. This USED to also wait for
// a hostile within 12 blocks - which meant the bot wandered exposed all night and only started
// digging once a skeleton was already shooting it (verified live: 7 night deaths in one
// evening, several while "sheltering"). A naked player doesn't wait to be chased: at dusk they
// go to bed or hole up BEFORE the mobs arrive. Trigger at DUSK (12200), NOT mob-spawn (13000):
// a fresh pit takes ~15-20s to dig + seal, so starting after dark means a zombie walks straight
// into the open hole mid-dig (verified live: began the pit at timeOfDay 13618, a zombie walked
// in during the dig, died). The ~800-tick (~40s) head start lets the pit be sealed before any
// mob spawns. isNight (13000) stays the trigger for the ARMORED "wanted" cases below.
function shelterNeeded (bot) { return !!(bot.time && bot.time.timeOfDay >= 12200 && bot.time.timeOfDay < 23500) && underArmored(bot) }
// Rest is WANTED (not just needed) when night catches us with the bed close by - even in
// full armor a player sleeps if home is right there (operator rule: safer overall). Far
// from the bed and armored, keep working the night; the commute would cost more than the
// safety buys.
function nightRestWanted (bot) {
  if (shelterNeeded(bot)) return true
  if (!isNight(bot) || !bot.entity) return false
  if ((bot.health ?? 20) <= 8) return true // critically hurt at night: rest, armored or not (died at 1hp hunting in the dark)
  const bed = knownBed()
  return !!bed && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 100 // must COVER THE BUILD SITE: it died working the castle at night, 66 blocks from bed, 2 past the old radius
}
// (anti-grief helpers canBreakNaturally / structureNearby are defined up top, next to
// STRUCTURE_RE, and shared by every dig primitive + the shelter + the gather filter.)

// Place a block from inventory (name matching `match`) AT world position `target`, using any
// solid neighbouring face to place against. Best-effort; returns whether a block landed.
async function placeAt (bot, target, match) {
  placeAt.lastFail = null // observability: WHY the last placement failed (cap-fail debugging)
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => match.test(i.name))
  if (!item) { placeAt.lastFail = 'no matching item in inventory'; return false }
  await bot.equip(item, 'hand').catch(() => {})
  let sawRef = false
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const ref = bot.blockAt(target.offset(dx, dy, dz))
    if (ref && ref.boundingBox === 'block' && !AIRISH(ref.name)) {
      sawRef = true
      try { await bot.lookAt(target.offset(0.5, 0.5, 0.5), true) } catch {}
      try { await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)); return true } catch (e) {
        placeAt.lastFail = `place vs ${ref.name} face ${-dx},${-dy},${-dz}: ${e.message}`
        // Paper often doesn't echo the blockUpdate even when the block PLACED (same quirk
        // as the torch reflex, see NOTES.md) - check the world before calling it a miss.
        if (/blockUpdate/.test(e.message)) {
          await new Promise(r => setTimeout(r, 400))
          const b = bot.blockAt(target)
          if (b && !AIRISH(b.name)) return true
        }
      }
    }
  }
  if (!sawRef) placeAt.lastFail = 'no solid neighbour to place against'
  return false
}

// ACTIVE BUILD ZONE (set by autoBuild, cleared when it ends): the shelter must never dig
// its bunker inside the build footprint - a pit under the castle floor is a hole in the
// build (operator rule). Module-level so every shelter entry point respects it without
// threading a box through each caller.
let buildZone = null
function setBuildZone (box) { buildZone = box || null }
function inBuildZone (x, z) { return !!buildZone && x >= buildZone.x1 && x <= buildZone.x2 && z >= buildZone.z1 && z <= buildZone.z2 }

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
    // IN WATER? Get ashore FIRST - digging attempts from a water column all fail while
    // the bot drowns through the retry carousel (watched it die that way on the test
    // server). If we can't reach land, say so honestly instead of pretending to shelter.
    if (!(await ensureAshore(bot, isStopped))) { dbg('shelter: stuck in water - cannot dig in here'); return false }
    // Don't dig a fresh hole beside the aquifer that just flooded the last one - walk
    // clear of it first (re-digging at the same wet spot is the drowning loop).
    if (nearRecentFlood(bot)) {
      const away = { x: bot.entity.position.x + (bot.entity.position.x >= lastFlood.x ? 8 : -8), z: bot.entity.position.z + (bot.entity.position.z >= lastFlood.z ? 8 : -8) }
      dbg('shelter: too close to the pit that flooded - moving to ' + Math.round(away.x) + ',' + Math.round(away.z) + ' first')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 2), 15000) } catch {}
    }
    // NEVER dig the bunker inside the active build footprint - step just past the nearest
    // edge first (a pit under the castle floor is a hole in the build, operator rule).
    const p0 = bot.entity.position
    if (inBuildZone(p0.x, p0.z)) {
      const exits = [
        { x: buildZone.x1 - 5, z: p0.z }, { x: buildZone.x2 + 5, z: p0.z },
        { x: p0.x, z: buildZone.z1 - 5 }, { x: p0.x, z: buildZone.z2 + 5 }
      ].sort((a, b) => Math.hypot(a.x - p0.x, a.z - p0.z) - Math.hypot(b.x - p0.x, b.z - p0.z))
      dbg('shelter: inside the build footprint - stepping out to ' + Math.round(exits[0].x) + ',' + Math.round(exits[0].z) + ' before digging')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(exits[0].x, exits[0].z, 2), 20000) } catch (e) { dbg('shelter: footprint exit walk failed (' + e.message + ') - digging where i stand') }
    }
    // REUSE MY BUNKER: four nights of fresh digs at one spot, each side-sealing against
    // the previous night's holes, ENTOMBED the bot in a hillside (live - needed a rescue
    // agent). If a registered shelter is within 12, go sit in it and re-cap instead.
    const oldPit = recallInfra('shelter', bot.entity.position, 12)
    if (oldPit) {
      dbg('shelter: reusing my bunker at ' + oldPit.x + ',' + oldPit.y + ',' + oldPit.z)
      try { await gotoWithTimeout(bot, new goals.GoalBlock(oldPit.x, oldPit.y, oldPit.z), 15000) } catch {}
      const here = bot.entity.position.floored()
      if (Math.abs(here.x - oldPit.x) <= 1 && Math.abs(here.z - oldPit.z) <= 1 && here.y <= oldPit.y + 1) {
        // we're in the old hole - just seal the lid and wait like a normal night
        const capPos0 = bot.entity.position.floored().offset(0, 2, 0)
        const CAP0 = /terracotta|dirt|cobble|stone|gravel|sand|netherrack|deepslate|tuff|granite|diorite|andesite|clay|mud|_planks$|_log$|_concrete/
        let recapped = await placeAt(bot, capPos0, CAP0)
        if (!recapped) { await new Promise(r => setTimeout(r, 300)); recapped = await placeAt(bot, capPos0, CAP0) }
        dbg('shelter: bunker re-entered, lid ' + (recapped ? 'SEALED' : 'OPEN'))
        say(recapped ? 'back in my bunker for the night' : 'in my bunker (lid open)')
        const dl = Date.now() + (recapped ? 600000 : 120000)
        const hpX = bot.health || 20
        while (Date.now() < dl && !isStopped()) {
          if (!isNight(bot) && !nearHostile(bot, 10)) break
          if (!recapped && (bot.health || 20) < hpX - 3) { dbg('shelter: hit in the open bunker - bailing'); break }
          // same flooding bail as the fresh-pit wait: a reused bunker beside an aquifer
          // can flood too, and this loop had no way out (drowned sealed, test server)
          if (inWaterNow(bot)) {
            dbg('shelter: reused bunker is FLOODING - emergency exit')
            lastFlood = { x: bot.entity.position.x, z: bot.entity.position.z, at: Date.now() }
            break
          }
          await new Promise(r => setTimeout(r, 3000))
        }
        try {
          const cap = bot.blockAt(capPos0)
          if (cap && !AIRISH(cap.name) && (!bot.canDigBlock || bot.canDigBlock(cap))) { try { await bot.dig(cap) } catch {} }
          await collectDrops(bot, 3)
          await climbToSurface(bot, Math.floor(bot.entity.position.y) + 4, { isStopped })
        } catch {}
        return true
      }
      dbg('shelter: could not re-enter the bunker - digging fresh')
    }
    // ON A TREE CANOPY? The shelter can't dig leaves (not in DIGGABLE_NATURAL) and used to
    // NO-OP in a 5s loop all night (reproduced on test server, savanna oak). Leaves are
    // always natural: if the ground is close below, punch through and drop; if it's a tall
    // tree (jungle!), walk off to real ground instead - never a lethal fall.
    for (let i = 0; i < 8; i++) {
      const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!under || !/_leaves$/.test(under.name)) break
      let depth = 0 // how far we'd fall past this leaf layer
      for (let dy = 2; dy <= 8; dy++) { const b = bot.blockAt(bot.entity.position.floored().offset(0, -dy, 0)); if (b && !AIRISH(b.name) && !/_leaves$/.test(b.name)) break; depth++ }
      if (depth > 4) {
        dbg('shelter: on a TALL canopy (' + depth + '+ drop) - walking to ground instead of punching through')
        const mcData = require('minecraft-data')(bot.version)
        const gids = Object.values(mcData.blocksByName).filter(b => /^(grass_block|dirt|coarse_dirt|podzol|sand|red_sand|gravel|stone)$/.test(b.name)).map(b => b.id)
        const spots = (bot.findBlocks({ matching: gids, maxDistance: 16, count: 12 }) || [])
          .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); const a2 = bot.blockAt(p.offset(0, 2, 0)); return a && AIRISH(a.name) && a2 && AIRISH(a2.name) })
        if (spots.length) { try { await gotoWithTimeout(bot, new goals.GoalBlock(spots[0].x, spots[0].y + 1, spots[0].z), 12000) } catch (e) { dbg('shelter: walk-to-ground failed (' + e.message + ')') } }
        break
      }
      try { await bot.dig(under) } catch (e) { dbg('shelter: leaf-punch failed (' + e.message + ')'); break }
      await new Promise(r => setTimeout(r, 400)) // drop through
    }
    // CENTER on the feet cell. Digging from a cell edge (x.5/z.5 boundary) digs the
    // column under floored(feet) while the body stays supported by the NEIGHBOUR block -
    // the bot opens a perfect pit and stands beside it all night with the "cap" aimed at
    // thin air (root cause of every 'ducked into a hole' night death; reproduced on the
    // test server at x=-330.5: "cap failed - no solid neighbour to place against").
    try { const f0 = bot.entity.position.floored(); await gotoWithTimeout(bot, new goals.GoalBlock(f0.x, f0.y, f0.z), 4000) } catch {}
    const surfaceY = Math.floor(bot.entity.position.y)
    const shaft = bot.entity.position.floored() // the column we dig - we must END UP inside it
    // 1) dig straight down 2, keeping the blocks (need one to cap with). NEVER dig into a
    //    void/lava/water below, and ONLY natural terrain (never a player build block) - so
    //    sheltering can't punch through someone's floor.
    let dug = 0
    for (let i = 0; i < 2 && !isStopped(); i++) {
      const feet = bot.entity.position.floored()
      const below = bot.blockAt(feet.offset(0, -1, 0))
      const below2 = bot.blockAt(feet.offset(0, -2, 0))
      if (!below || AIRISH(below.name) || /lava|water/.test(below.name) || !canBreakNaturally(below)) { dbg('shelter: dig blocked at ' + i + ' (' + (below ? below.name : 'unloaded') + ')'); break }
      if (below2 && /lava|water/.test(below2.name)) { dbg('shelter: liquid 2 below - not digging'); break }
      // NEVER open a cell whose SIDE touches liquid - an aquifer beside the shaft floods
      // the pit the instant the wall drops (drowned at 4hp in its own sealed pit, live).
      let sideLiquid = null
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const s = bot.blockAt(below.position.offset(dx, 0, dz))
        if (s && /lava|water/.test(s.name)) { sideLiquid = s.name; break }
      }
      if (sideLiquid) { dbg('shelter: ' + sideLiquid + ' beside the next cell - not digging deeper'); break }
      const tool = toolForBlock(bot, below.name)
      if (tool) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(below)) { dbg('shelter: canDigBlock=false for ' + below.name); break }
      try { await bot.dig(below) } catch (e) { dbg('shelter: dig failed (' + e.message + ')'); break }
      await new Promise(r => setTimeout(r, 250)) // fall into the hole
      // VERIFY we dropped in - a straddling bot digs without falling. Steer into the shaft.
      if (Math.floor(bot.entity.position.y) > feet.y - 1) {
        try { await gotoWithTimeout(bot, new goals.GoalBlock(shaft.x, feet.y - 1, shaft.z), 3000) } catch {}
        await new Promise(r => setTimeout(r, 200))
      }
      dug++
    }
    if (dug < 1) { dbg('shelter: NO-OP (dug 0) - caller must do something else'); return false } // couldn't dig in (bedrock/protected/edge)
    if (Math.floor(bot.entity.position.y) >= surfaceY) { dbg('shelter: dug ' + dug + ' but NEVER FELL IN (still at surface) - aborting, not pretending'); return false }
    await collectDrops(bot, 3)
    // 2) cap the opening above the head with any spare block
    const capPos = bot.entity.position.floored().offset(0, 2, 0)
    // cap with ANY common terrain/building block we're holding (whatever the biome gave us
    // when we dug in - terracotta, deepslate, tuff, etc. all count, not just dirt/cobble).
    const CAP_RE = /terracotta|dirt|cobble|stone|gravel|sand|netherrack|deepslate|tuff|granite|diorite|andesite|clay|mud|_planks$|_log$|_concrete/
    let capped = await placeAt(bot, capPos, CAP_RE)
    if (!capped) dbg('shelter: cap attempt 1 failed - ' + (placeAt.lastFail || '?'))
    // VERIFY the cap landed (placement can miss from inside a 1x1 pit) and retry once -
    // an uncapped pit is a mob funnel: they fall in ON TOP of the bot (seen live).
    if (!capped || AIRISH((bot.blockAt(capPos) || {}).name || 'air')) {
      await new Promise(r => setTimeout(r, 300))
      capped = await placeAt(bot, capPos, CAP_RE)
      if (!capped) dbg('shelter: cap attempt 2 failed - ' + (placeAt.lastFail || '?'))
    }
    // Last resort: dig one deeper and try the cap one lower - a 3-deep shaft with a lid at
    // -2 still seals (head has a 1-block air gap under the cap). Geometry matters: from the
    // bottom of a 2-deep shaft the cap cell's solid neighbours sit at surface level, which
    // some placements reject; one deeper gives a wall ring at head+1 to place against.
    if (!capped || AIRISH((bot.blockAt(capPos) || {}).name || 'air')) {
      const feet = bot.entity.position.floored()
      const below = bot.blockAt(feet.offset(0, -1, 0))
      const below2 = bot.blockAt(feet.offset(0, -2, 0))
      if (below && !AIRISH(below.name) && !/lava|water/.test(below.name) && canBreakNaturally(below) &&
          !(below2 && /lava|water/.test(below2.name))) {
        try {
          await bot.dig(below); await new Promise(r => setTimeout(r, 300)); await collectDrops(bot, 3)
          const capPos2 = bot.entity.position.floored().offset(0, 2, 0)
          capped = await placeAt(bot, capPos2, CAP_RE)
          if (!capped) dbg('shelter: deep-cap attempt failed - ' + (placeAt.lastFail || '?'))
        } catch (e) { dbg('shelter: deeper dig failed (' + e.message + ')') }
      }
    }
    // SEAL THE SIDES TOO: digging beside a cave leaves a pit wall OPEN into it - a lid
    // over a doorway (operator caught it live: "open on one side, dug into a cave").
    // Wall off every airish horizontal neighbour of both body cells with spare blocks.
    let sideHoles = 0
    for (const dy of [0, 1]) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cell = bot.entity.position.floored().offset(dx, dy, dz)
        const b = bot.blockAt(cell)
        // liquid counts as a hole: AIRISH misses water, so an aquifer wall was silently
        // skipped and flooded the sealed pit (drowning death, live)
        if (b && (AIRISH(b.name) || /lava|water/.test(b.name))) {
          if (await placeAt(bot, cell, CAP_RE)) dbg('shelter: walled a side hole at ' + cell.toString())
          else { sideHoles++; dbg('shelter: side hole at ' + cell.toString() + ' UNSEALED (' + b.name + ') - ' + (placeAt.lastFail || '?')) }
        }
      }
    }
    dbg('shelter: pit ' + (capped ? 'SEALED' : 'OPEN (cap failed - mob funnel risk)') + (sideHoles ? ' with ' + sideHoles + ' open side(s)' : ''))
    say(capped ? 'holed up till it\'s safe' : 'ducked into a hole till it\'s safe')
    // 3) wait until DAY and no hostile near, or a hard timeout (~one full night). An OPEN
    // pit is NOT a shelter - don't squat in a mob funnel for 10 minutes: short deadline,
    // and bail immediately if we're taking hits down there (fight/flee reflexes resume).
    const fullySealed = capped && !sideHoles
    if (fullySealed) { try { rememberInfra('shelter', bot.entity.position.floored()) } catch {} } // bunkers are reusable knowledge
    const deadline = Date.now() + (fullySealed ? 600000 : 120000)
    const hp0 = bot.health || 20
    while (Date.now() < deadline && !isStopped()) {
      if (!isNight(bot) && !nearHostile(bot, 10)) break
      if (!fullySealed && (bot.health || 20) < hp0 - 3) { dbg('shelter: taking damage in a LEAKY pit - bailing out to fight/flee'); break }
      // DROWNING BAIL: water reaching the body cells means the pit is flooding - get out
      // NOW, sealed or not (a "sealed" pit beside an aquifer drowned the bot at 4hp, live)
      if (inWaterNow(bot)) {
        dbg('shelter: pit is FLOODING - emergency exit')
        // remember the spot so the next shelter attempt digs somewhere DRY, and drop the
        // registered bunker here - re-entering a flooded pit is not shelter
        lastFlood = { x: bot.entity.position.x, z: bot.entity.position.z, at: Date.now() }
        try { const reg = recallInfra('shelter', bot.entity.position, 3); if (reg) forgetInfra('shelter', listInfra('shelter').find(e => e.x === reg.x && e.z === reg.z)) } catch {}
        break
      }
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
      // a FLOODED pit defeats climbToSurface (its dig primitives refuse water) - swim out
      if (inWaterNow(bot)) await ensureAshore(bot, isStopped)
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

// ---- WORLD MEMORY (semantic map, layer 1: resources) --------------------------------
// Perception ends at loaded chunks (~64 blocks) and exploration was memoryless - every
// batch re-searched the world at random (verified live: chopped oak at ~570,30 twice,
// then wandered off southwest and forgot it). Like a player, the bot now REMEMBERS where
// it successfully gathered each resource (bot/world-memory.json), heads straight back
// next time, and forgets spots that dry up.
const WORLD_MEM_FILE = process.env.WORLD_MEM_FILE || path.join(__dirname, 'world-memory.json') // env-overridable so a TEST bot never treks to live-world coords / stomps live memory
let worldMem = null
let worldMemTimer = null
function loadWorldMem () {
  if (worldMem) return worldMem
  try { worldMem = JSON.parse(fs.readFileSync(WORLD_MEM_FILE, 'utf8')) } catch { worldMem = {} }
  return worldMem
}
function saveWorldMem () {
  clearTimeout(worldMemTimer)
  worldMemTimer = setTimeout(() => { try { fs.writeFileSync(WORLD_MEM_FILE, JSON.stringify(worldMem, null, 1)) } catch {} }, 2000)
  if (worldMemTimer.unref) worldMemTimer.unref()
}
function rememberSpot (item, pos) {
  const m = loadWorldMem()
  const list = m[item] = m[item] || []
  for (const sp of list) {
    if (Math.hypot(sp.x - pos.x, sp.z - pos.z) < 24) { sp.hits = (sp.hits || 1) + 1; sp.at = Date.now(); saveWorldMem(); return }
  }
  list.push({ x: Math.round(pos.x), z: Math.round(pos.z), at: Date.now(), hits: 1 })
  if (list.length > 20) { list.sort((a, b) => (b.hits - a.hits) || (b.at - a.at)); list.length = 20 }
  saveWorldMem()
}
function forgetSpot (item, spot, hard) {
  const list = loadWorldMem()[item] || []
  // hard: the spot was BONE-DRY on arrival after a deliberate trek - it's dead, remove it
  // now. Decrement-decay made a stale 4-hit spot cost four wasted 200-block round trips.
  spot.hits = hard ? 0 : (spot.hits || 1) - 1
  if (spot.hits <= 0) { const i = list.indexOf(spot); if (i >= 0) list.splice(i, 1) }
  saveWorldMem()
}
function recallSpot (item, pos, visited) {
  const list = loadWorldMem()[item] || []
  let best = null; let bd = Infinity
  for (const sp of list) {
    if (visited.has(sp.x + ',' + sp.z)) continue
    if (sp.rest && sp.rest > Date.now()) continue // growing grove on cooldown - let the trees grow
    const d = Math.hypot(sp.x - pos.x, sp.z - pos.z)
    if (d > 400 || d < 16) continue // too far to trek / already here
    if (d < bd) { bd = d; best = sp }
  }
  return best
}

// INFRASTRUCTURE MEMORY (operator-requested): remember our OWN tables/furnaces/chests and
// walk back to them instead of littering the landscape with a fresh crafting table every
// time the last one fell out of the loaded chunks or behind torn-up terrain.
function rememberInfra (kind, pos) {
  const m = loadWorldMem()
  const s = m.infra = m.infra || {}
  const list = s[kind] = s[kind] || []
  // EXACT-cell dedup: the old radius-2 merge collapsed adjacent blocks into ONE entry, so
  // a double chest (two adjacent) or a chest+table read as a single remembered thing and
  // the bot lost track of what it had placed (operator: duplicate table, table on chest).
  for (const e of list) { if (e.x === Math.floor(pos.x) && e.y === Math.floor(pos.y) && e.z === Math.floor(pos.z)) { e.at = Date.now(); saveWorldMem(); return } }
  list.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at: Date.now() })
  if (list.length > 12) { list.sort((a, b) => b.at - a.at); list.length = 12 }
  saveWorldMem()
}
function recallInfra (kind, pos, maxDist) {
  const list = (loadWorldMem().infra || {})[kind] || []
  let best = null; let bd = Infinity
  for (const e of list) { const d = Math.hypot(e.x - pos.x, e.z - pos.z); if (d <= maxDist && d < bd) { bd = d; best = e } }
  return best
}
function forgetInfra (kind, entry) {
  const list = (loadWorldMem().infra || {})[kind] || []
  const i = list.indexOf(entry); if (i >= 0) { list.splice(i, 1); saveWorldMem() }
}
// What block each infra kind IS in the world - lets memory be VERIFIED against reality
// (operator: "fix the memory completely so it applies to everything it needs memory for").
// Remembering a coordinate is worthless if the bot never checks the block is still there.
const INFRA_BLOCK = { table: /crafting_table$/, furnace: /furnace$/, chest: /chest$/, bed: /_bed$/ }
// List remembered infra of a kind. Pass `bot` to VERIFY against the world: any entry whose
// chunk is loaded but no longer holds the expected block is pruned (dead placement, someone
// broke it, a bad memory). Unloaded chunks (blockAt null) are kept - we can't disprove them.
function listInfra (kind, bot) {
  const list = (((loadWorldMem().infra || {})[kind]) || []).slice()
  const re = INFRA_BLOCK[kind]
  if (!bot || !re) return list
  const survivors = []; let changed = false
  for (const e of list) {
    const b = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (b == null) { survivors.push(e); continue } // chunk not loaded - can't verify, keep
    if (re.test(b.name)) survivors.push(e); else changed = true // gone/wrong -> prune
  }
  if (changed) { const m = loadWorldMem(); if (m.infra) { m.infra[kind] = survivors; saveWorldMem() } }
  return survivors
}
// Recall the nearest remembered infra of a kind, VERIFIED against the world when `bot` given.
function recallInfraVerified (bot, kind, pos, maxDist) {
  const list = listInfra(kind, bot)
  let best = null; let bd = Infinity
  for (const e of list) { const d = Math.hypot(e.x - pos.x, e.z - pos.z); if (d <= maxDist && d < bd) { bd = d; best = e } }
  return best
}
// Walk to REMEMBERED ones (up to 3 nearest) and verify each still stands; forget the dead.
// Trying only the single nearest made one stale entry cause a brand-new placement while a
// perfectly good chest stood 9 blocks further (live: three chests at one site).
async function recallAndReach (bot, kind, blockId, maxDist, reach) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const known = recallInfra(kind, bot.entity.position, maxDist)
    if (!known) return null
    dbg('  remembered ' + kind + ' at ' + known.x + ',' + known.y + ',' + known.z + ' - reusing it instead of placing a new one')
    await walkStaged(bot, known.x, known.z, { range: 10, timeoutMs: 60000 })
    const blk = bot.blockAt(new Vec3(known.x, known.y, known.z))
    if (!blk || blk.type !== blockId) { dbg('  remembered ' + kind + ' is gone - forgetting it'); forgetInfra(kind, known); continue }
    if (await reach(blk)) return blk
    return null // it stands but we can't reach it - placing fresh beats looping
  }
  return null
}

// NEGATIVE MEMORY (roomba rule, operator-requested): remember 32-block cells that were
// SEARCHED AND EMPTY, and stop re-sweeping them - the blind compass kept walking the same
// barren ground round after round. A cell un-marks when we PLANT saplings there (that's a
// reason to come back) or after 2h (world changes - players build, trees grow).
const SEARCH_CELL = 32
function searchCellKey (x, z) { return Math.floor(x / SEARCH_CELL) + ',' + Math.floor(z / SEARCH_CELL) }
function markSearched (item, pos) {
  const m = loadWorldMem()
  const s = m.searched = m.searched || {}
  const l = s[item] = s[item] || {}
  l[searchCellKey(pos.x, pos.z)] = Date.now()
  const keys = Object.keys(l)
  if (keys.length > 300) { keys.sort((a, b) => l[a] - l[b]); for (const k of keys.slice(0, keys.length - 300)) delete l[k] }
  saveWorldMem()
}
function isSearchedDry (item, x, z) {
  const l = (loadWorldMem().searched || {})[item] || {}
  const t = l[searchCellKey(x, z)]
  return !!t && Date.now() - t < 2 * 3600 * 1000
}
function clearSearched (item, pos) {
  const l = (loadWorldMem().searched || {})[item]
  if (l && l[searchCellKey(pos.x, pos.z)]) { delete l[searchCellKey(pos.x, pos.z)]; saveWorldMem() }
}

// BED MEMORY: the server knows the bot's spawn bed but never tells the client, and the
// sleep command only scans 48 blocks around wherever the bot happens to stand - so at
// dusk 150 blocks out it "had no bed" and dug a pit instead (7 night deaths in one
// evening, live). Remember the bed like a player does: saved on every successful
// sleep/spawn-set, consulted first every night.
function rememberBed (pos) { const m = loadWorldMem(); m.bed = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), at: Date.now() }; saveWorldMem() }
function knownBed () { return loadWorldMem().bed || null }
function forgetBed () { const m = loadWorldMem(); delete m.bed; saveWorldMem() }

// Sleep in the remembered bed if we're standing near it. Returns true only if we actually
// slept through to daylight (or the night got skipped) - anything else falls back to the pit.
async function sleepInBedHere (bot, { say = () => {}, isStopped = () => false } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const bedIds = Object.values(mcData.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
  const bed = bot.findBlock({ matching: bedIds, maxDistance: 8 })
  if (!bed) {
    // Only forget the bed when we're actually STANDING at the remembered spot and it's
    // gone - a trek that fell short (death, blocked path) used to wipe the memory
    // permanently, and the bot pit-slept for hours with a perfectly good bed 76 blocks
    // away (live, 18:01). Fell-short = keep the memory, pit tonight, try again tomorrow.
    const kb = knownBed()
    const there = kb && Math.hypot(kb.x - bot.entity.position.x, kb.z - bot.entity.position.z) <= 4
    if (there) { dbg('nightRest: bed is GONE from ' + kb.x + ',' + kb.y + ',' + kb.z + ' - forgetting it'); forgetBed() }
    else dbg('nightRest: fell short of the bed - keeping the memory, pitting tonight')
    return false
  }
  for (let tries = 0; tries < 3 && !isStopped(); tries++) {
    try {
      if (bot.entity.position.distanceTo(bed.position) > 2.5) { try { await gotoWithTimeout(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 20000) } catch {} }
      await bot.sleep(bed)
      rememberBed(bed.position) // sleeping re-arms the spawn - keep the memory fresh
      say('sleeping till morning')
      dbg('nightRest: asleep in bed at ' + bed.position.toString())
      while (bot.isSleeping && isNight(bot) && !isStopped()) { await new Promise(r => setTimeout(r, 2000)) }
      if (!isNight(bot)) { try { await bot.wake() } catch {} ; dbg('nightRest: morning - up and about'); return true }
      dbg('nightRest: woken early (still night) - falling back to shelter')
      return false // kicked out of bed (attacked / player woke us)
    } catch (e) {
      dbg('nightRest: sleep failed (' + e.message + ')')
      if (/monster/i.test(e.message)) {
        // hostiles CLOSE while we're under-armored: don't stand at the bed taking hits
        // for 3 retries (verified on test server: hp 20 -> 17 doing exactly that) - seal
        // a pit right here and let the day burn them off.
        if (nearHostile(bot, 10) && underArmored(bot)) { dbg('nightRest: hostiles at the bed - pitting NOW instead of waiting'); return false }
        await new Promise(r => setTimeout(r, 6000)); continue // borderline-range mobs may wander off
      }
      return false
    }
  }
  return false
}

// Night survival, in a player's order of preference: WALK HOME AND SLEEP if the bed is in
// range, else seal a pit where we stand. Every digInForNight call site goes through this.
// _resting covers the WHOLE span (bed trek + sleep + pit): the brain's goto/attack commands
// were yanking the pathfinder out from under the shelter dig mid-carousel (test server:
// 14 deaths in 6 min with the brain fighting the body for control). index.js holds brain
// commands while isResting(), same as the build busy-guard.
let _resting = false
function isResting () { return _resting || _sheltering }
async function nightRest (bot, opts = {}) {
  _resting = true
  try { return await nightRestInner(bot, opts) } finally { _resting = false }
}
async function nightRestInner (bot, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  // dusk catches the bot swimming often enough (rivers everywhere) - get to land BEFORE
  // deciding bed-vs-pit, or the pit path dig-fails in a loop while it drowns
  await ensureAshore(bot, isStopped)
  const bed = knownBed()
  if (bed && bot.entity && !_sheltering) {
    const d = Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z)
    if (d <= (opts.bedRange || 200)) {
      dbg('nightRest: bed remembered at ' + bed.x + ',' + bed.y + ',' + bed.z + ' (' + Math.round(d) + ' blocks) - heading there')
      if (d > 4) {
        say('night time - heading home to sleep')
        if (!await walkStaged(bot, bed.x, bed.z, { isStopped, range: 6, timeoutMs: 150000 })) dbg('nightRest: staged trek to bed fell short')
        try { await gotoWithTimeout(bot, new goals.GoalNear(bed.x, bed.y, bed.z, 2), 20000) } catch (e) { dbg('nightRest: final approach to bed failed (' + e.message + ')') }
      }
      if (isStopped()) return false
      if (Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 8) {
        if (await sleepInBedHere(bot, { say, isStopped })) return true
      } else dbg('nightRest: never reached the bed - pitting where i stand')
    } else dbg('nightRest: bed too far (' + Math.round(d) + ' > ' + (opts.bedRange || 200) + ') - pitting here')
  }
  return digInForNight(bot, opts)
}

// ---- WHEAT FARM (operator order: "make the wheat farm now so it stops starving").
// The Sonnet shepherd proved the region can run dry of animals - the bot worked at 1hp
// until death with no food fallback. Same pattern as the orchard: renewable supply at
// the camp. Water-edge plot, tilled with a crafted hoe, seeded from grass, bone-mealed
// when bones allow, harvested into bread.
async function boneMealBlock (bot, pos, times) {
  const mcData = require('minecraft-data')(bot.version)
  for (let u = 0; u < times; u++) {
    let meal = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone_meal')
    if (!meal) {
      const bone = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone')
      if (!bone) return
      try { const r = bot.recipesFor(mcData.itemsByName.bone_meal.id, null, 1, null)[0]; if (!r) return; await bot.craft(r, 1, null); meal = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone_meal') } catch { return }
      if (!meal) return
    }
    const b = bot.blockAt(pos)
    if (!b || (b.getProperties && (b.getProperties().age ?? 0) >= 7)) return
    try { await bot.equip(meal, 'hand'); await bot.activateBlock(b); await new Promise(r => setTimeout(r, 300)) } catch { return }
  }
}

async function ensureWheatFarm (bot, home, { isStopped = () => false, say = () => {}, avoid = null } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const m = loadWorldMem()
  if (m.wheatFarm && Math.hypot(m.wheatFarm.x - home.x, m.wheatFarm.z - home.z) <= 80) return true // one farm per site
  // BAD MOMENT guard: the last attempt ran while being chased INTO A CAVE - it searched
  // for grass from underground and found none. Farming is a peacetime surface job.
  if (hasSolidCeiling(bot, 12) || nearHostile(bot, 16) || isNight(bot)) { dbg('  wheat farm: bad moment (cave/hostiles/night) - deferred'); return false }
  // 1) surface water within reach of home - farmland must sit beside it
  const waterId = mcData.blocksByName.water.id
  // SURFACE water only: cave/ravine pools pass the air-above test but have stone banks
  // and no light for crops - "0 bank cells" at two remembered underground pools, live.
  const seesSky = p => {
    for (let dy = 1; dy <= 40; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false
    }
    return true
  }
  const findWaters = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 }) || [])
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
    .filter(p => !inAvoidBox(avoid, p.x, p.z))
    .filter(seesSky)
  let waters = findWaters()
  if (!waters.length) {
    // No pond in sight - but maybe we REMEMBER one. The camp runs this from the site,
    // where the nearest pond sits beyond 48 blocks: every camp farm attempt deferred
    // forever while the bot starved (live, all morning). Ponds seen during any earlier
    // attempt are in the infra registry - trek back to one.
    const known = recallInfra('water', bot.entity.position, 120)
    if (known && !isStopped()) {
      dbg('  wheat farm: no water in sight - walking to remembered pond at ' + known.x + ',' + known.z)
      try { await walkStaged(bot, known.x, known.z, { isStopped, range: 6, timeoutMs: 90000 }) } catch {}
      waters = findWaters()
      if (!waters.length) forgetInfra('water', listInfra('water').find(e => e.x === known.x && e.z === known.z))
    }
  }
  if (!waters.length) { dbg('  wheat farm: no surface water within 48 - deferred'); return false }
  const w = waters[0]
  rememberInfra('water', { x: w.x, y: w.y, z: w.z }) // future camp passes trek straight back
  // 2) a hoe (wooden: 2 planks + 2 sticks)
  let hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
  if (!hoe) {
    try { await runCraft(bot, 'wooden_hoe', 1, true, { isStopped, home }) } catch (e) { dbg('  wheat farm: no hoe and cannot craft one (' + e.message + ') - deferred'); return false }
    hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
    if (!hoe) return false
  }
  // 3) seeds - break grass near the water until we hold a handful
  const seedCount = () => countItem(bot, 'wheat_seeds')
  if (seedCount() < 6) {
    const grassIds = ['short_grass', 'tall_grass', 'grass'].map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(x => x != null)
    try { await gotoWithTimeout(bot, new goals.GoalNear(w.x, w.y, w.z, 4), 60000) } catch {}
    let broken = 0
    while (seedCount() < 6 && broken < 40 && !isStopped()) {
      let g = bot.findBlock({ matching: grassIds, maxDistance: 32 }) // 16 found nothing at the pond edge (live) - grass grows patchily
      if (!g) { // barren bank - one hop toward home usually lands in the meadow
        try { await gotoWithTimeout(bot, new goals.GoalNearXZ(home.x, home.z, 8), 30000) } catch {}
        g = bot.findBlock({ matching: grassIds, maxDistance: 32 })
      }
      if (!g) break
      try {
        if (bot.entity.position.distanceTo(g.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(g.position.x, g.position.y, g.position.z, 2), 10000)
        await bot.dig(g); broken++
      } catch { break }
      if (broken % 8 === 0) await collectDrops(bot, 6)
    }
    await collectDrops(bot, 8)
    dbg('  wheat farm: broke ' + broken + ' grass -> ' + seedCount() + ' seeds')
    if (seedCount() < 1) { dbg('  wheat farm: no seeds to be had here - deferred'); return false }
  }
  // 4) till + plant the water's bank: same-y neighbours of the waterline
  say('setting up a wheat farm by the water - no more starving')
  let planted = 0
  const ring = []
  const ringSeen = new Set()
  for (const wp of waters.slice(0, 8)) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const k = (wp.x + dx) + ',' + (wp.z + dz)
      if (ringSeen.has(k) || inAvoidBox(avoid, wp.x + dx, wp.z + dz)) continue
      ringSeen.add(k)
      // sand/gravel/clay banks welcome (untillable ones get swapped for carried dirt), and
      // the bank may sit level with, one below, or a step above the waterline - same-y
      // grass/dirt-only made the ring EMPTY at every pond here (live: "0 bank cells").
      for (const dy of [0, -1, 1]) {
        const gp = wp.offset(dx, dy, dz)
        const g = bot.blockAt(gp); const above = bot.blockAt(gp.offset(0, 1, 0))
        if (g && /^(grass_block|dirt|sand|red_sand|gravel|clay)$/.test(g.name) && above && REPLACEABLE.test(above.name)) { ring.push(g); break }
      }
    }
  }
  dbg('  wheat farm: ' + ring.length + ' bank cell(s) by the water at ' + w.x + ',' + w.z)
  for (let cell of ring.slice(0, 12)) {
    if (isStopped() || seedCount() < 1) break
    try {
      if (bot.entity.position.distanceTo(cell.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(cell.position.x, cell.position.y, cell.position.z, 2), 12000)
      const veg = bot.blockAt(cell.position.offset(0, 1, 0))
      if (veg && !AIRISH(veg.name)) { try { await bot.dig(veg) } catch {} }
      if (/sand|gravel|clay/.test(cell.name)) { // UNTILLABLE-BANK SWAP: dig it, lay owned dirt, till that
        const dirtItem = (bot.inventory ? bot.inventory.items() : []).find(i => /^dirt$/.test(i.name))
        if (!dirtItem) continue
        try { await bot.dig(cell) } catch { continue }
        if (!await placeAt(bot, cell.position, /^dirt$/)) { dbg('  wheat farm: dirt swap failed at ' + cell.position.toString()); continue }
        const swapped = bot.blockAt(cell.position)
        if (!swapped || !/^(dirt|grass_block)$/.test(swapped.name)) continue
        cell = swapped
      }
      await bot.equip((bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name)), 'hand')
      await bot.activateBlock(cell) // till to farmland
      await new Promise(r => setTimeout(r, 150))
      const tilled = bot.blockAt(cell.position)
      if (!tilled || tilled.name !== 'farmland') continue
      const seeds = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'wheat_seeds')
      if (!seeds) break
      await bot.equip(seeds, 'hand')
      await bot.placeBlock(tilled, new Vec3(0, 1, 0)) // plant
      planted++
      await boneMealBlock(bot, cell.position.offset(0, 1, 0), 2)
    } catch (e) { dbg('  wheat farm: cell failed (' + e.message + ')') }
  }
  if (planted) {
    m.wheatFarm = { x: w.x, y: w.y, z: w.z, at: Date.now() }
    saveWorldMem()
    dbg('  wheat farm: ' + planted + ' cells planted at the water near ' + w.x + ',' + w.z)
    say(`wheat farm planted (${planted} cells) - bread incoming`)
  } else dbg('  wheat farm: could not plant any cell')
  return planted > 0
}

// Visit the farm: harvest ripe wheat (age 7), replant, bone-meal what's still growing,
// and craft bread (3 wheat each) when the harvest allows. Called when hungry + huntless.
async function tendWheatFarm (bot, { isStopped = () => false, say = () => {} } = {}) {
  const m = loadWorldMem()
  if (!m.wheatFarm) return false
  const mcData = require('minecraft-data')(bot.version)
  const wheatId = mcData.blocksByName.wheat.id
  await walkStaged(bot, m.wheatFarm.x, m.wheatFarm.z, { isStopped, range: 6, timeoutMs: 120000 })
  const crops = (bot.findBlocks({ matching: wheatId, maxDistance: 16, count: 24 }) || [])
  let harvested = 0
  for (const p of crops) {
    if (isStopped()) break
    const b = bot.blockAt(p)
    if (!b) continue
    const age = b.getProperties ? b.getProperties().age : null
    if (age >= 7) {
      try {
        if (bot.entity.position.distanceTo(p) > 4) await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 10000)
        await bot.dig(b); harvested++
        await collectDrops(bot, 4)
        const farmland = bot.blockAt(p.offset(0, -1, 0))
        const seeds = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'wheat_seeds')
        if (farmland && farmland.name === 'farmland' && seeds) { await bot.equip(seeds, 'hand'); await bot.placeBlock(farmland, new Vec3(0, 1, 0)).catch(() => {}) }
      } catch (e) { dbg('  wheat harvest failed (' + e.message + ')') }
    } else if (age != null) {
      await boneMealBlock(bot, p, 2)
    }
  }
  const wheatN = countItem(bot, 'wheat')
  if (wheatN >= 3) { try { const made = await runCraft(bot, 'bread', Math.floor(wheatN / 3), true, { isStopped }); say('baked ' + made + ' bread - crisis over'); dbg('  baked ' + made + ' bread') } catch (e) { dbg('  bread craft failed (' + e.message + ')') } }
  dbg('  wheat farm tended: harvested ' + harvested + ', wheat=' + countItem(bot, 'wheat') + ', bread=' + countItem(bot, 'bread'))
  return harvested > 0 || countItem(bot, 'bread') > 0
}

// ---- FISHING: the food of last resort that works ANYWHERE with water (the guardian
// escort proved this region has no animals - one sheep in 40 minutes - and the bot
// starved through every other fallback). A rod is 3 sticks + 2 string; spiders pay the
// string; raw cod/salmon are safe food the auto-eat handles.
async function ensureFishingRod (bot, { isStopped = () => false, home } = {}) {
  const has = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'fishing_rod')
  if (has()) return true
  const inv = inventoryCounts(bot)
  if ((inv.string || 0) < 2) { dbg('  fishing: no rod and only ' + (inv.string || 0) + ' string - deferred'); return false }
  try { await runCraft(bot, 'fishing_rod', 1, true, { isStopped, home }) } catch (e) { dbg('  fishing: rod craft failed (' + e.message + ')'); return false }
  return !!has()
}

async function fishForFood (bot, { isStopped = () => false, say = () => {}, target = 6, home } = {}) {
  if (hasSolidCeiling(bot, 12)) { dbg('  fishing: underground - not here'); return false }
  const mcData = require('minecraft-data')(bot.version)
  const edible = () => (bot.inventory ? bot.inventory.items() : []).filter(i => mcData.foodsByName && mcData.foodsByName[i.name] && !/rotten|spider_eye|poisonous/.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (!await ensureFishingRod(bot, { isStopped, home })) return false
  const waterId = mcData.blocksByName.water.id
  const waters = (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 }) || []) // sample WIDE: the nearest N blocks of a lake are all submerged and fail the air-above filter
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
  if (!waters.length) { dbg('  fishing: no surface water within 48'); return false }
  const w = waters[0]
  try { await gotoWithTimeout(bot, new goals.GoalNear(w.x, w.y + 1, w.z, 3), 45000) } catch {}
  if (isStopped()) return false
  say('nothing to hunt around here - fishing for dinner instead')
  dbg('  fishing at the water near ' + w.x + ',' + w.z + ' (edible now: ' + edible() + ', target ' + target + ')')
  const deadline = Date.now() + 240000 // a real session, not forever
  let catches = 0
  while (edible() < target && Date.now() < deadline && !isStopped()) {
    if (nearHostile(bot, 12)) { dbg('  fishing: hostile closing - reeling out'); break }
    const rod = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'fishing_rod')
    if (!rod) break // rod broke
    try { await bot.equip(rod, 'hand') } catch { break }
    try { await bot.lookAt(new Vec3(w.x + 0.5, w.y, w.z + 0.5), true) } catch {}
    try {
      await Promise.race([bot.fish(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('cast timeout')), 45000))])
      catches++
    } catch (e) {
      try { bot.activateItem() } catch {} // reel a dangling line back in
      dbg('  fishing: cast failed (' + e.message + ')')
      await new Promise(r => setTimeout(r, 1500))
    }
    await collectDrops(bot, 4)
  }
  dbg('  fishing done: ' + catches + ' catches, edible=' + edible())
  if (catches > 0) say(`caught ${catches} fish - that'll do`)
  return edible() > 0
}

// ---- SCAFFOLD TEARDOWN: the pathfinder pillars up to tall canopies and abandons the
// dirt towers (operator: "a massive mess"). The patch layer remembers every self-placed
// block; after a harvest, ride the tower back down and pocket the dirt.
async function cleanupScaffold (bot, around, { isStopped = () => false } = {}) {
  let pf
  try { pf = require('./pathfix.js') } catch { return 0 }
  if (!pf.selfPlacedNear) return 0
  const spots = pf.selfPlacedNear(around, 10, 1800000) // 30-min window (5 min expired mid-harvest, orphaning towers)
  if (!spots.length) return 0
  spots.sort((a, b) => b.y - a.y) // top-down: digging under our own feet rides us down
  let removed = 0
  for (const p of spots.slice(0, 24)) {
    if (isStopped()) break
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (!b || !FILLER_RE.test(b.name)) continue // only our own filler blocks, never terrain
    if (bot.entity.position.distanceTo(b.position) > 4.5) {
      try { await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 3), 8000) } catch { continue }
    }
    const tool = toolForBlock(bot, b.name) // cobble dug bare/wrong-tool drops NOTHING (live: hoe-dug scaffold vanished)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(b); removed++; await new Promise(r => setTimeout(r, 150)) } catch {}
  }
  if (removed) { await collectDrops(bot, 6); dbg('  tore down ' + removed + ' scaffold blocks (dirt pocketed)') }
  return removed
}

// ---- INVENTORY HYGIENE: mob-drop junk (spider eyes, string, flint...) quietly eats the
// slots the build materials need (seen live: ~8 slots of trash mid-castle-provision).
// Toss what has no use; KEEP bones (they become bone meal for the tree farm) and a small
// rotten-flesh famine reserve (the risky-food ranking eats it only when starving).
const JUNK_RE = /^(rotten_flesh|spider_eye|poisonous_potato|flint|feather|egg|beetroot_seeds|melon_seeds|pumpkin_seeds|arrow|gunpowder|phantom_membrane|rabbit_hide|rabbit_foot|ink_sac|glow_ink_sac|slime_ball|fermented_spider_eye)$/ // string STAYS (fishing rods!); wheat_seeds stay (the farm)
async function dumpJunk (bot) {
  let tossed = 0
  for (const it of (bot.inventory ? bot.inventory.items() : [])) {
    if (!JUNK_RE.test(it.name)) continue
    const n = it.name === 'rotten_flesh' ? it.count - 3 : it.count
    if (n <= 0) continue
    try { await bot.toss(it.type, null, n); tossed += n; await new Promise(r => setTimeout(r, 250)) } catch {}
  }
  if (tossed) dbg('  dumped ' + tossed + ' junk items (slots free: ' + (bot.inventory ? bot.inventory.emptySlotCount() : '?') + ')')
  return tossed
}

// HOLD until the night is survived: a nightRest attempt returns false when another flow
// already holds the shelter lock (the idle reflex sealed a pit while a resume was booting)
// - and callers treated false as "carry on", walking straight back into the dark (died
// that way at 350,64,36). This BLOCKS until day/armored/stopped, re-attempting rest
// whenever nothing else is resting.
async function restUntilSafe (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  let waited = false
  while (isNight(bot) && underArmored(bot) && !isStopped() && bot.entity) {
    // HOLDING must never mean holding UNDERWATER - the 4s waits between failed rest
    // attempts are exactly where the bot drowned (test server, in its flooded basin)
    if (inWaterNow(bot)) { try { await ensureAshore(bot, isStopped) } catch {} }
    if (!isResting()) { try { if (await nightRest(bot, opts)) { waited = true; continue } } catch {} }
    if (!waited) { waited = true; dbg('restUntilSafe: HOLDING for the night (another rest active or rest failed - not working in the dark)') }
    await new Promise(r => setTimeout(r, 4000))
  }
  return true
}

// ---- TREE FARMING (user-approved): the castle region is chopped bare, so the bot keeps
// its own wood supply alive like a player would - replant after every chop, fish saplings
// out of the leaves when it has none, and when the land is truly dry, plant a grove near
// home and let it grow instead of wandering 300 blocks into the night.
const PLANTABLE_GROUND = /^(grass_block|dirt|podzol|coarse_dirt|rooted_dirt|mud|moss_block)$/
function saplingFor (logItem) { return logItem.replace(/_log$/, '_sapling') }
function saplingCount (bot, logItem) { return (bot.inventory ? bot.inventory.items() : []).filter(i => i.name === saplingFor(logItem)).reduce((s, i) => s + i.count, 0) }

// Is this XZ inside the current build's keep-out box? (footprint + canopy margin,
// threaded down from autoBuild) - NEVER plant a future tree inside the castle.
function inAvoidBox (avoid, x, z) { return !!avoid && x >= avoid.x1 && x <= avoid.x2 && z >= avoid.z1 && z <= avoid.z2 }

// Plant one sapling on open ground near `around` (a just-felled trunk or a grove cell).
async function plantSaplingNear (bot, around, logItem, opts = {}) {
  const sap = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === saplingFor(logItem))
  if (!sap) return false
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -3; dy <= 1; dy++) {
    const gp = new Vec3(Math.floor(around.x) + dx, Math.floor(around.y) + dy, Math.floor(around.z) + dz)
    if (inAvoidBox(opts.avoid, gp.x, gp.z)) continue // a tree here would grow into the build
    try { const pf = require('./pathfix.js'); if (pf.isSelfPlaced && pf.isSelfPlaced(gp)) continue } catch {} // own scaffold dirt is NOT ground (sapling on the tower, live)
    const ground = bot.blockAt(gp); const above = bot.blockAt(gp.offset(0, 1, 0))
    if (!ground || !PLANTABLE_GROUND.test(ground.name) || !above || !AIRISH(above.name)) continue
    if (bot.entity.position.distanceTo(gp) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(gp.x, gp.y, gp.z, 2), 10000) } catch { continue } }
    try {
      await bot.equip(sap, 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
      dbg('  replanted ' + saplingFor(logItem) + ' at ' + gp.offset(0, 1, 0).toString())
      clearSearched(logItem, gp) // roomba rule: planting here makes this cell worth revisiting
      rememberSpot(logItem, gp)  // ...and puts it back on the map as a future wood source
      await boneMealSapling(bot, gp.offset(0, 1, 0)) // bones -> bone meal -> instant tree (why we KEEP bones)
      return true
    } catch (e) { dbg('  replant failed at ' + gp.toString() + ' (' + e.message + ')') }
  }
  return false
}

// Bone-meal a planted sapling until it grows (or we run out) - turns the tree farm from
// "wait ~20 min per tree" into "instant tree" whenever skeletons have paid their dues.
// Crafts bone meal from bones on the fly (2x2 recipe, no table needed).
async function boneMealSapling (bot, sapPos) {
  const mcData = require('minecraft-data')(bot.version)
  const items = () => bot.inventory ? bot.inventory.items() : []
  for (let uses = 0; uses < 6; uses++) {
    const sapBlock = bot.blockAt(sapPos)
    if (!sapBlock || !/_sapling$/.test(sapBlock.name)) return uses > 0 // grew (or gone)
    let meal = items().find(i => i.name === 'bone_meal')
    if (!meal) {
      const bone = items().find(i => i.name === 'bone')
      if (!bone) return false
      try {
        const recipe = bot.recipesFor(mcData.itemsByName.bone_meal.id, null, 1, null)[0]
        if (!recipe) return false
        await bot.craft(recipe, 1, null)
        meal = items().find(i => i.name === 'bone_meal')
      } catch (e) { dbg('  bone meal craft failed (' + e.message + ')'); return false }
      if (!meal) return false
    }
    try {
      await bot.equip(meal, 'hand')
      await bot.activateBlock(sapBlock)
      await new Promise(r => setTimeout(r, 350))
    } catch (e) { dbg('  bone-mealing failed (' + e.message + ')'); return false }
  }
  return !/_sapling$/.test((bot.blockAt(sapPos) || {}).name || '')
}

// No saplings in the pack? Break a handful of this tree's leaves (natural only) and sweep
// the drops - oak leaves shed a sapling ~5% of the time, so 10-12 leaves is a fair shot.
async function fishSaplings (bot, around, logItem, { isStopped = () => false } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const leaf = mcData.blocksByName[logItem.replace(/_log$/, '_leaves')]
  if (!leaf) return
  let broken = 0
  while (broken < 16 && !isStopped() && saplingCount(bot, logItem) < 4) { // fish harder: the orchard wants stock
    const b = bot.findBlock({ matching: leaf.id, maxDistance: 4 })
    if (!b || !canBreakNaturally(b)) break
    try { await bot.dig(b) } catch { break }
    broken++
  }
  if (broken) { await collectDrops(bot, 6); dbg('  leaf-fished ' + broken + ' leaves -> ' + saplingCount(bot, logItem) + ' saplings') }
}

// PREP one orchard cell at (cx, ~baseY, cz): find the ground, clear vegetation above it,
// shave natural bumps toward plot level, fill a shallow dip with dirt, and top non-soil
// with dirt. Returns the plantable ground block, or null.
async function prepOrchardCell (bot, cx, baseY, cz, { isStopped = () => false } = {}) {
  // find ground: first solid block scanning down from a bit above plot level
  let ground = null
  for (let y = baseY + 3; y >= baseY - 3; y--) {
    const b = bot.blockAt(new Vec3(cx, y, cz))
    const a = bot.blockAt(new Vec3(cx, y + 1, cz))
    if (b && b.boundingBox === 'block' && a && REPLACEABLE.test(a.name)) { ground = b; break }
  }
  if (!ground) return null
  // OPEN SKY, CLEAR COLUMN (operator rule: no caves, no obstructions): a sapling under a
  // cave ceiling or overhang never grows into a usable tree. The full growing column must
  // be free of solid blocks - vegetation gets cleared below, neighbour-crown leaves are OK.
  for (let dy = 1; dy <= 14; dy++) {
    const b = bot.blockAt(ground.position.offset(0, dy, 0))
    if (!b) break // above loaded height - open enough
    if (!AIRISH(b.name) && !/grass|fern|flower|dead_bush|snow|vine|_leaves$|_sapling$/.test(b.name)) return null
  }
  if (bot.entity.position.distanceTo(ground.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(cx, ground.position.y, cz, 3), 15000) } catch { return null } }
  // clear vegetation/soft cover above the cell (never crafted blocks)
  for (let dy = 1; dy <= 2 && !isStopped(); dy++) {
    const b = bot.blockAt(ground.position.offset(0, dy, 0))
    if (b && !AIRISH(b.name) && /grass|fern|flower|dead_bush|snow|vine|_leaves$/.test(b.name)) { try { await bot.dig(b) } catch {} }
  }
  // shave a bump: ground sticking up past plot level gets cut down (natural blocks only,
  // plus loose cobble - pathfinder bridging litters plots with scaffold cobblestone that
  // "natural-only" could never remove, operator review)
  let guard = 3
  while (ground.position.y > baseY && guard-- > 0 && !isStopped()) {
    const shaveable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (!shaveable || (bot.canDigBlock && !bot.canDigBlock(ground))) break
    const tool = toolForBlock(bot, ground.name) // stone shaved wrong-tool drops nothing
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(ground); await collectDrops(bot, 3) } catch { break }
    const nb = bot.blockAt(new Vec3(cx, ground.position.y - 1, cz))
    if (!nb || nb.boundingBox !== 'block') break
    ground = nb
  }
  // fill a shallow dip with dirt so the row stays level
  if (ground.position.y < baseY - 1) {
    if (await placeAt(bot, ground.position.offset(0, 1, 0), /^(dirt|grass_block)$/)) {
      const nb = bot.blockAt(ground.position.offset(0, 1, 0)); if (nb && nb.boundingBox === 'block') ground = nb
    }
  }
  // saplings need soil - top stone/sand with a dirt block if we carry one
  if (!PLANTABLE_GROUND.test(ground.name)) {
    if (!await placeAt(bot, ground.position.offset(0, 1, 0), /^dirt$/)) return null
    const nb = bot.blockAt(ground.position.offset(0, 1, 0))
    if (!nb || !PLANTABLE_GROUND.test(nb.name)) return null
    ground = nb
  }
  return ground
}

// Level ONE plot cell toward baseY: clear soft cover, shave a bump (<=2, natural only),
// fill a 1-deep dip with dirt. The whole-plot flattening pass (operator review: "very
// uneven terrain, not a clean flat area") - each call is cheap when the cell's already flat.
async function levelPlotCell (bot, cx, baseY, cz, { isStopped = () => false } = {}) {
  let ground = null
  for (let y = baseY + 3; y >= baseY - 2; y--) {
    const b = bot.blockAt(new Vec3(cx, y, cz)); const a = bot.blockAt(new Vec3(cx, y + 1, cz))
    if (b && b.boundingBox === 'block' && a && (AIRISH(a.name) || REPLACEABLE.test(a.name))) { ground = b; break }
  }
  if (!ground) return false
  if (ground.position.y === baseY && AIRISH((bot.blockAt(ground.position.offset(0, 1, 0)) || { name: 'air' }).name)) return true // already flat
  if (bot.entity.position.distanceTo(ground.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(cx, ground.position.y, cz, 3), 8000) } catch { return false } }
  for (let dy = 1; dy <= 2; dy++) { // soft cover off first
    const v = bot.blockAt(ground.position.offset(0, dy, 0))
    if (v && !AIRISH(v.name) && /grass|fern|flower|dead_bush|snow|vine/.test(v.name)) { try { await bot.dig(v) } catch {} }
  }
  let guard = 3
  while (ground.position.y > baseY && guard-- > 0 && !isStopped()) { // shave bump (incl. scaffold cobble litter)
    const shaveable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (!shaveable || (bot.canDigBlock && !bot.canDigBlock(ground))) break
    const tool = toolForBlock(bot, ground.name) // stone shaved wrong-tool drops nothing
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(ground); await collectDrops(bot, 3) } catch { break }
    const nb = bot.blockAt(new Vec3(cx, ground.position.y - 1, cz))
    if (!nb || nb.boundingBox !== 'block') break
    ground = nb
  }
  if (ground.position.y < baseY) { // fill the dip ALL the way up with dirt (operator: "flat ground floor with dirt")
    let fills = 4
    while (ground.position.y < baseY && fills-- > 0 && !isStopped()) {
      if (!await placeAt(bot, ground.position.offset(0, 1, 0), /^(dirt|coarse_dirt|grass_block)$/)) break
      const nb = bot.blockAt(ground.position.offset(0, 1, 0))
      if (!nb || nb.boundingBox !== 'block') break
      ground = nb
    }
  }
  // uniform DIRT surface: a stone/gravel/cobble top reads as mess even when level -
  // swap it for dirt (operator order: the plot is a flat DIRT floor, not mixed rubble)
  if (ground.position.y === baseY && !/^(grass_block|dirt|coarse_dirt|podzol|mycelium|farmland)$/.test(ground.name)) {
    const swappable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (swappable && (bot.inventory ? bot.inventory.items() : []).some(i => /^(dirt|coarse_dirt)$/.test(i.name))) {
      const tool = toolForBlock(bot, ground.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      try {
        await bot.dig(ground); await collectDrops(bot, 2)
        await placeAt(bot, ground.position, /^(dirt|coarse_dirt)$/)
      } catch {}
    }
  }
  return true
}

// Plant an ORCHARD: an even grid (5-block lanes) on prepped, level ground near - but
// never inside - the build's keep-out box. Operator spec: "a nice opening with flat
// ground, trees planted evenly so it's easy to navigate and use". Returns count planted.
async function plantGrove (bot, home, logItem, { isStopped = () => false, say = () => {}, avoid = null, max = 8 } = {}) {
  if (saplingCount(bot, logItem) < 1) return 0
  // anchor shifted +24 south of the original (pre-leveling) plot: the operator ordered
  // the messy first orchard torn down and future ones built on cleanly prepared ground
  const gx = Math.floor(avoid ? avoid.x2 + 8 : home.x + 18); const gz = Math.floor(home.z) + 24
  await walkStaged(bot, gx, gz, { isStopped, range: 6, timeoutMs: 90000 })
  if (isStopped()) return 0
  const baseY = Math.floor(bot.entity.position.y) - 1 // plot level = the ground we stand on
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(max))))
  // FLATTEN THE WHOLE PLOT first - lanes included (operator review: the per-cell-only
  // prep left "very uneven terrain, not a clean flat area"). Bounded: corrective work
  // is capped, flat cells cost one block-read each.
  {
    const w = cols * 5; const h = 4 * 5
    let ops = 0
    // STOCK DIRT first (operator order: flat DIRT floor): hole-fills and rubble-top
    // swaps both eat dirt, and running dry mid-plot left holes. Dirt digs fast anywhere.
    if (countItem(bot, 'dirt') < 48 && !isStopped()) {
      dbg('  orchard: stocking dirt for the leveling (' + countItem(bot, 'dirt') + ' on hand)')
      try { await runGather(bot, 'dirt', 64, { isStopped, restoreMovements: () => {}, home: { x: gx, z: gz }, avoid }) } catch (e) { dbg('  orchard: dirt stock-up failed (' + e.message + ') - leveling with what we have') }
    }
    say('leveling the orchard plot first')
    // MULTI-PASS until actually flat (operator review: one 60-cell pass left "holes and
    // a little bit of hill"). Each pass shaves deeper and fills another layer, so bumps
    // and dips CONVERGE; stop when a full sweep corrects nothing or the budget is spent.
    for (let pass = 0; pass < 4 && !isStopped() && ops < 240; pass++) {
      let fixed = 0
      outerLevel:
      for (let dz = -1; dz <= h && !isStopped(); dz++) {
        for (let dx = -1; dx <= w; dx++) {
          const cx = gx + dx; const cz = gz + dz
          if (inAvoidBox(avoid, cx, cz)) continue
          const g0 = bot.blockAt(new Vec3(cx, baseY, cz))
          const a0 = bot.blockAt(new Vec3(cx, baseY + 1, cz))
          if (g0 && g0.boundingBox === 'block' && a0 && AIRISH(a0.name)) continue // flat already - free
          try { if (await levelPlotCell(bot, cx, baseY, cz, { isStopped })) { ops++; fixed++ } } catch {}
          if (ops >= 240) { dbg('  orchard: leveling budget spent (' + ops + ' cells corrected) - planting on what we have'); break outerLevel }
        }
      }
      if (!fixed) break // converged: the whole sweep found nothing to correct
    }
    dbg('  orchard: plot leveled (' + ops + ' cells corrected)')
  }
  const sap = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === saplingFor(logItem))
  let planted = 0
  for (let r = 0; r < 4 && planted < max && !isStopped(); r++) {
    for (let c = 0; c < cols && planted < max && !isStopped(); c++) {
      if (!sap()) break
      const cx = gx + c * 5; const cz = gz + r * 5 // 5-block lanes: walkable + crowns don't merge
      if (inAvoidBox(avoid, cx, cz)) continue
      const ground = await prepOrchardCell(bot, cx, baseY, cz, { isStopped })
      if (!ground) { dbg('  orchard: cell ' + cx + ',' + cz + ' unusable - skipping'); continue }
      try {
        await bot.equip(sap(), 'hand')
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        planted++
        clearSearched(logItem, ground.position)
        dbg('  orchard: planted ' + saplingFor(logItem) + ' at ' + cx + ',' + (ground.position.y + 1) + ',' + cz + ' (' + planted + '/' + max + ')')
        await boneMealSapling(bot, ground.position.offset(0, 1, 0))
      } catch (e) { dbg('  orchard: plant failed at ' + cx + ',' + cz + ' (' + e.message + ')') }
    }
  }
  if (planted) {
    const m = loadWorldMem(); m.orchard = { x: gx, z: gz, at: Date.now() }; saveWorldMem() // dedup: one orchard per site per growth cycle
    rememberSpot(logItem, new Vec3(gx + 5, baseY, gz + 5)) // the plot is a wood source now
    // a torch in the plot: saplings keep growing through the night and mobs stay out
    try { await placeAt(bot, new Vec3(gx + 2, baseY + 1, gz + 2), /^torch$/) } catch {}
    say(`planted a ${planted}-tree orchard by the site - rows are straight, come have a look`)
    dbg('  orchard: ' + planted + ' planted in a ' + cols + '-wide grid at ' + gx + ',' + gz)
  }
  return planted
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
  const visitedMem = new Set() // remembered spots already tried this gather
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
  const MAX_EXPLORE = 20 // wander this many times before truly giving up (48-block hops; 20 spans a real trek to the next biome)
  // ROAM FENCE: stay within maxRoam (XZ) of the build anchor so gathering CONVERGES back to
  // the site instead of drifting 150 blocks off chasing one more tree/cow. Stone is under
  // every point (strip-mine), so it gets a tight fence; logs a looser one. Env-overridable.
  const home = opts.home || { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }
  const MAX_ROAM = parseInt(process.env.GATHER_MAX_ROAM || (reqTool ? '64' : (isLogGather ? '160' : '96')), 10) // logs 96->160: the castle site sits in a treeless pocket wider than the old leash
  // The fence is ADAPTIVE: when this site's resource is genuinely inaccessible inside it
  // (verified live: stone under the site was a flooded aquifer - every shaft/dive aborted
  // on water), a player walks FURTHER. waterAborts/failed shafts widen it in +32 steps.
  let maxRoam = MAX_ROAM
  let waterAborts = 0
  let firstLoop = true // first iteration extends the fence over a far continuation start
  let orchardPlanted = false // orchard mode fires at most once per gather run
  const widenFence = why => {
    if (maxRoam >= MAX_ROAM + 128) return
    maxRoam = Math.min(MAX_ROAM + 128, maxRoam + 32) // dry looks can ultimately reach ~288 blocks out
    dbg('  gather fence widened to', maxRoam, '(' + why + ')')
  }
  const distHome = () => Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z)
  // Wall-clock deadline: even a legit strip-mine run must end (bounded so the BUILD phase runs).
  const deadline = Date.now() + (opts.deadlineMs || Math.min(480000, 120000 + count * 4000))
  const timedOut = () => Date.now() > deadline
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
    bot.pathfinder.setGoal(null) // a lingering goal lets the pathfinder steer mid-dig and ABORT it (dig-restart loops, operator report)
    await bot.dig(blk)
    mined++
  }

  let lastBeat = 0 // throttled trace heartbeat - the LAST line before a hang names the branch
  while (countItem(bot, item) - start < count) {
    if (Date.now() - lastBeat > 5000) {
      lastBeat = Date.now()
      const p = bot.entity.position.floored()
      dbg('  gather', item, (countItem(bot, item) - start) + '/' + count, 'pos=' + p.x + ',' + p.y + ',' + p.z, 'mined=' + mined, 'dry=' + dryExplores, 'strip=' + stripDug, 'reachFails=' + reachFails, 'distHome=' + Math.round(distHome()))
    }
    if (isStopped()) return { gathered: countItem(bot, item) - start, reason: 'stopped' }
    if (timedOut()) return { gathered: countItem(bot, item) - start, reason: 'out of time - building with what i have' }
    // A round that CONTINUES far from home (autoBuild no longer forces the commute) begins
    // outside the fence BY DESIGN - cover the starting spot once, or the first iteration
    // walks halfway home and undoes the continuation (operator: "WHY the shuttling?????").
    if (firstLoop) { firstLoop = false; const d0 = distHome(); if (d0 + 48 > maxRoam) { maxRoam = Math.ceil(d0 + 48); dbg('  gather fence extended to ' + maxRoam + ' (round continues ' + Math.round(d0) + 'b out)') } }
    // ROAM FENCE: drifted too far from the build site -> walk back inside the fence before
    // scanning again, so the gather converges to the site instead of wandering off for good.
    if (distHome() > maxRoam) {
      dbg('  gather fence-return: distHome=' + Math.round(distHome()) + ' > ' + maxRoam)
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(home.x, home.z, Math.round(maxRoam * 0.5)), 30000) } catch {}
      dryExplores++
      if (dryExplores >= MAX_EXPLORE) return { gathered: countItem(bot, item) - start, reason: `gathered ${countItem(bot, item) - start}/${count} near the site` }
    }
    // SURVIVAL: starving with nothing to eat -> break off and hunt an animal for meat
    // (auto-eat feeds on it). Body-side because during a build the BRAIN is held and can't
    // do this; a long gather in a food-poor area otherwise runs the bot to 0 food / 1 hp
    // with no way back. Throttled so it doesn't chase every loop.
    // NEVER hunt when rest is due: roaming for animals in the dark at 1hp is how it died
    // at 479,67,85 (a sealed pit is safe at ANY hunger - starvation stops at half hearts;
    // a night hunt doesn't). The night-rest check below runs first via this guard.
    if (needsFood(bot) && !nightRestWanted(bot) && Date.now() - lastFoodHunt > 20000) {
      lastFoodHunt = Date.now()
      if (opts.say) opts.say('starving - hunting something to eat first')
      dbg('  gather food-hunt (food=' + bot.food + ')')
      // STOCK UP like a player: one kill (~3 raw hunger points) barely dents the deficit
      // and it's starving again minutes later (verified live: "starving - hunting" on
      // repeat). Keep hunting (bounded) until a few meals are in the pack - the cook
      // reflex turns the surplus into proper food at the next furnace.
      try { for (let k = 0; k < 4 && foodCount(bot) < 5 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped })) break } } catch { /* keep gathering regardless */ }
      dbg('  gather food-hunt done (foodItems=' + foodCount(bot) + ')')
      // COOK the pack whenever we're hungry and a furnace is in reach (incl. the hut's,
      // remembered) - eating raw wastes 2/3 of every catch (operator complaint).
      try { if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped }) } catch {}
      // NO ANIMALS ANYWHERE (Sonnet shepherd finding: it worked at 1hp until death with
      // no fallback): the wheat farm is the answer - harvest it, or plant it now.
      if (foodCount(bot) === 0 && !isStopped()) {
        try {
          if (!await tendWheatFarm(bot, { isStopped, say: opts.say })) {
            await ensureWheatFarm(bot, home, { isStopped, say: opts.say, avoid: opts.avoid })
          }
        } catch (e) { dbg('  wheat fallback failed (' + e.message + ')') }
        // FISHING: the last-resort food that works anywhere with water (guardian escort:
        // this region has no animals, and it starved to death through every fallback)
        if (foodCount(bot) === 0 && !isStopped()) {
          try { await fishForFood(bot, { isStopped, say: opts.say, home }) } catch (e) { dbg('  fishing fallback failed (' + e.message + ')') }
        }
      }
    }
    // OPPORTUNISTIC: a food animal is RIGHT THERE and the pack is light - take the free
    // meal before hunger ever forces a detour (operator ask). Close range only (<=12), so
    // it never wanders off-task chasing dinner; the reactive hunt above covers real need.
    // Threshold 15 (operator-set): keep a deep larder - the creeper death started at 0 food.
    if (!needsFood(bot) && foodCount(bot) < 15 && Date.now() - lastFoodHunt > 30000 && !isStopped()) {
      const snack = Object.values(bot.entities || {}).some(e => e && e.position &&
        /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test((e.name || '').toLowerCase()) &&
        e.position.distanceTo(bot.entity.position) <= 12)
      if (snack) {
        lastFoodHunt = Date.now()
        dbg('  gather opportunistic hunt (foodItems=' + foodCount(bot) + ')')
        // an EMPTY pantry needs a batch, not a bite - one raw kill gets eaten on the
        // spot and the larder never rebuilds (watched live: hand-to-mouth at 9hp)
        const kills = foodCount(bot) <= 2 ? 3 : 1
        try { for (let k = 0; k < kills && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped })) break } } catch { /* keep gathering */ }
        // cook the haul if a furnace is in reach - cooked meat feeds 3x raw
        try { if (foodCount(bot) >= 2) await cookRawMeat(bot, { isStopped }) } catch {}
      }
    }
    // SHELTER: naked at night with a hostile bearing down -> dig in and wait it out. A sealed
    // pit survives a creeper where fleeing didn't (it died to one, unarmed, mid-gather). Only
    // when actually threatened + under-armored, so it doesn't burrow every night for nothing.
    if (nightRestWanted(bot) && Date.now() - lastShelter > 15000) {
      lastShelter = Date.now()
      dbg('  gather night-rest (timeOfDay=' + (bot.time && bot.time.timeOfDay) + ')')
      // NAKED: this BLOCKS until day (rest failure must never mean "keep working in the
      // dark"). Armored near the bed: one sleep attempt, then work on if it can't.
      if (underArmored(bot)) { try { await restUntilSafe(bot, { isStopped, say: opts.say }) } catch {} }
      else { try { await nightRest(bot, { isStopped, say: opts.say }) } catch {} }
      dbg('  gather night-rest done (timeOfDay=' + (bot.time && bot.time.timeOfDay) + ')')
      continue // morning (or interrupted) - rescan from wherever the night left us
    }
    // INVENTORY HYGIENE: junk drops crowd out the material we're gathering - toss them
    // once slots run low (keeps bones for the tree farm + a rotten-flesh famine reserve).
    if (bot.inventory && bot.inventory.emptySlotCount() < 4) { try { await dumpJunk(bot) } catch {} }
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
      // ROAM FENCE: ignore targets outside the fence so a distant block can't lure the bot
      // out (findBlocks reaches ~64 past the bot). Strip-mining supplies stone inside the fence.
      .filter(p => Math.hypot(p.x - home.x, p.z - home.z) <= maxRoam + 8)
    // ORCHARD MODE (operator rule): grinding one tree per chunk wastes the day. Sparse
    // area (about one tree visible) + a real sapling stock + a big remaining need ->
    // plant a 16-tree orchard near the site RIGHT NOW (don't wait for total dryness) and
    // keep hunting while it grows; revisits bone-meal it into a mass harvest.
    if (isLogGather && !orchardPlanted && candidates.length > 0 && candidates.length < 8 &&
        (count - (countItem(bot, item) - start)) >= 24 && saplingCount(bot, item) >= 6 && !isStopped()) {
      orchardPlanted = true
      // ONE orchard per site per growth cycle: the flag resets each round, and every
      // round was re-walking the grid to plant into already-occupied cells (live, 3x).
      const orch = loadWorldMem().orchard
      if (orch && Math.hypot(orch.x - home.x, orch.z - home.z) <= 60 && Date.now() - orch.at < 40 * 60000) {
        dbg('  orchard already growing near home (planted ' + Math.round((Date.now() - orch.at) / 60000) + ' min ago) - not replanting')
        continue
      }
      dbg('  sparse woods (' + candidates.length + ' logs visible) + ' + saplingCount(bot, item) + ' saplings - planting an ORCHARD near home')
      if (opts.say) opts.say('these scattered trees are a waste of time - planting my own orchard by the site')
      try { await plantGrove(bot, home, item, { isStopped, say: opts.say, avoid: opts.avoid, max: 16 }) } catch (e) { dbg('  orchard failed (' + e.message + ')') }
      continue
    }
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
        dbg('  gather strip-shaft #' + stripDug + ' budget=' + stripBudget() + ' at y=' + Math.floor(bot.entity.position.y))
        const dug = await digShaftDown(bot, stripBudget(), { isStopped, home })
        dbg('  gather strip-shaft dug=' + dug)
        if (dug > 0) { const got = await mineTunnel(bot, item, 16, stripDug, { isStopped }); dbg('  gather tunnel got=' + got); stripDug++; dryExplores = 0; continue } // count only SUCCESSFUL shafts
        // Couldn't dig down here (water/void/lava underfoot - e.g. a riverbed at the fence
        // edge). Head back to the build SITE (dry ground the operator chose) and strip-mine
        // THERE, instead of wandering to more possibly-wet spots and never getting stone.
        if (distHome() > 6) { dbg('  gather shaft-failed: returning home to strip there (distHome=' + Math.round(distHome()) + ')'); try { await gotoWithTimeout(bot, new goals.GoalNearXZ(home.x, home.z, 4), 30000) } catch {}; continue }
        dbg('  gather shaft-failed AT home - falling through to wander')
        widenFence('cannot shaft down at home') // water/void right under the site - hunt further out
        // already at home and STILL can't dig down -> fall through to wandering
      } else if (canStrip && stripBudget() <= 0 && Math.floor(bot.entity.position.y) < surfaceY - 3) {
        // already at the depth cap but no reachable stone -> we're stuck deep (a cave
        // fall or tapped-out shaft). Bail so runGather's climb-out gets us back up.
        return { gathered: countItem(bot, item) - start, reason: 'mined out down here - climbing back up' }
      }
      // WANDER to fresh terrain.
      if (dryExplores >= MAX_EXPLORE) {
        // Wood truly dry out here? Don't just give up - bank what we hold as a GROVE near
        // home so the next round has trees growing where the bot already works. (This is
        // the tree farm's seed step; grown trees are found by the normal scan next visit.)
        if (isLogGather && saplingCount(bot, item) > 0 && !isStopped()) {
          try { await plantGrove(bot, home, item, { isStopped, say: opts.say, avoid: opts.avoid }) } catch (e) { dbg('  grove planting failed (' + e.message + ')') }
          return { gathered: countItem(bot, item) - start, reason: `no ${sources.join('/')} left standing nearby - planted a grove by the site, it needs time to grow` }
        }
        return { gathered: countItem(bot, item) - start, reason: `searched far and wide, no reachable ${sources.join('/')}` }
      }
      // WORLD MEMORY first: walk to a remembered source before wandering blind. Memory
      // deliberately overrides the roam fence - a known resource IS the reason to leave.
      const memSpot = recallSpot(item, bot.entity.position, visitedMem)
      if (memSpot) {
        visitedMem.add(memSpot.x + ',' + memSpot.z)
        if (opts.say && dryExplores === 0) opts.say(`i remember ${sources[0]} over by ${memSpot.x},${memSpot.z} - heading there`)
        dbg('  gather heading to remembered spot ' + memSpot.x + ',' + memSpot.z + ' (hits ' + (memSpot.hits || 1) + ')')
        // The memory doesn't just justify LEAVING the fence - it justifies WORKING out
        // there. Extend the fence to cover the spot, or the loop-top fence-return drags
        // us straight home on arrival and the next iteration treks out again (verified
        // live: castle<->340,256 ping-pong, 0 logs gained).
        const dSpot = Math.hypot(memSpot.x - home.x, memSpot.z - home.z)
        if (dSpot + 48 > maxRoam) { maxRoam = Math.ceil(dSpot + 48); dbg('  gather fence extended to ' + maxRoam + ' (covers remembered spot)') }
        await walkStaged(bot, memSpot.x, memSpot.z, { isStopped, range: 8, timeoutMs: 150000 })
        // Judge the spot by what the miner will actually TOUCH: village-house logs pass a
        // raw block scan but fail the wild-tree filter, so a chopped-out spot next to a
        // village never dropped and kept luring the bot back (verified live, 0-log tours).
        const minable = (bot.findBlocks({ matching: ids, maxDistance: 24, count: 8 }) || [])
          .some(p => !isLogGather || isWildTreeLog(bot, p))
        // A GROWING grove counts as alive: saplings we (or anyone) planted here are the
        // reason to return. Bone-meal them on the spot if we're carrying bones - that
        // turns a revisit into an instant harvest.
        let growing = []
        if (!minable && isLogGather) {
          const sapId = (mcData.blocksByName[saplingFor(item)] || {}).id
          growing = sapId != null ? (bot.findBlocks({ matching: sapId, maxDistance: 24, count: 6 }) || []) : []
          for (const sp of growing.slice(0, 4)) { if (isStopped()) break; try { await boneMealSapling(bot, sp) } catch {} }
          // Still just saplings (no bones to force them)? COOLDOWN the spot ~8 min - trees
          // need time, and re-touring a nursery every round was half the shuttling.
          const nowMinable = (bot.findBlocks({ matching: ids, maxDistance: 24, count: 4 }) || []).some(p => isWildTreeLog(bot, p))
          if (!nowMinable && growing.length) { memSpot.rest = Date.now() + 8 * 60000; saveWorldMem(); dbg('  remembered spot is a GROWING grove - resting it 8 min') }
        }
        if (!minable && !growing.length) {
          // Before deleting: the SPOT may be dry while the FOREST it marked continues
          // deeper in (verified live: it ate the edge of the big woods at 567,304, the
          // 24-block re-scan missed the mass 30 blocks deeper, and the hard-drop deleted
          // its only pointer to the forest). Probe wider and MIGRATE the spot inward.
          const deeper = (bot.findBlocks({ matching: ids, maxDistance: 48, count: 8 }) || [])
            .filter(p => !isLogGather || isWildTreeLog(bot, p))
          if (deeper.length) {
            memSpot.x = Math.round(deeper[0].x); memSpot.z = Math.round(deeper[0].z); memSpot.at = Date.now(); saveWorldMem()
            dbg('  remembered spot edge is eaten - MIGRATING it deeper to ' + memSpot.x + ',' + memSpot.z)
          } else { dbg('  remembered spot is DRY on arrival (no minable ' + item + ') - dropping it'); forgetSpot(item, memSpot, true) }
        }
        continue // rescan from here; not a dry look
      }
      if (opts.say && dryExplores === 0) opts.say(`looking further afield for ${sources[0]}...`)
      // The fence only widened for flooded STONE - a site picked clean of wood kept the
      // bot pacing a barren 96-block circle while whole forests sat just outside it
      // (verified live: every log round died in ~2 min of dry looks). Dry looks now
      // widen the fence for ANY resource, so it walks to the next forest like a player.
      if (dryExplores > 0 && dryExplores % 3 === 0) widenFence(dryExplores + ' dry looks for ' + sources[0])
      // ROOMBA: this cell was searched and found empty - remember that, and steer the
      // next leg toward ground we HAVEN'T swept (negative memory, cleared by replanting).
      markSearched(item, bot.entity.position)
      dbg('  gather explore #' + dryExplores)
      const moved = await explore(bot, exploreIdx++, home, maxRoam, (x, z) => isSearchedDry(item, x, z))
      dbg('  gather explore moved=' + moved)
      dryExplores++
      continue
    }
    dryExplores = 0 // found something within range

    const before = countItem(bot, item)
    try { await breakBlock(target) } catch (e) {
      failed.set(pkey(target.position), (failed.get(pkey(target.position)) || 0) + 1)
      reachFails++
      if (reachFails <= 3 || reachFails % 5 === 0) dbg('  gather breakBlock fail #' + reachFails + ' at ' + target.position.toString() + ': ' + e.message)
      if (/underwater/.test(e.message) && ++waterAborts >= 3) { widenFence('approaches flooded'); waterAborts = 0 }
      // Stone is FOUND but we keep failing to reach it -> it's buried (plains): the
      // path can't dig dirt to get there. Strip-mine straight down to it instead of
      // grinding through dozens of doomed gotos, then re-scan from inside the stone.
      if (canStrip && reachFails >= 3 && stripDug < MAX_STRIP && stripBudget() > 0) {
        if (opts.say && stripDug === 0) opts.say(`the ${sources[0]} is all buried - digging down to it`)
        dbg('  gather buried-strip #' + stripDug + ' budget=' + stripBudget() + ' at y=' + Math.floor(bot.entity.position.y))
        const dug = await digShaftDown(bot, stripBudget(), { isStopped, home })
        if (dug > 0) { const got = await mineTunnel(bot, item, 16, stripDug, { isStopped }); dbg('  gather buried-strip dug=' + dug + ' tunnel got=' + got) } else dbg('  gather buried-strip dug=0')
        stripDug++; reachFails = 0
      }
      continue
    }
    reachFails = 0 // reached one - reset the buried-stone counter
    rememberSpot(item, target.position) // world memory: this place yields this resource
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
    // TREE FARM: keep the forest alive - fish a sapling out of the leaves if the pack has
    // none, then put one back where the trunk stood. A player who replants never runs dry.
    if (isLogGather && n > 0 && !isStopped()) {
      try {
        if (saplingCount(bot, item) < 1) await fishSaplings(bot, target.position, item, { isStopped })
        await plantSaplingNear(bot, target.position, item, { avoid: opts.avoid })
        await cleanupScaffold(bot, target.position, { isStopped }) // no abandoned dirt towers (operator rule)
      } catch (e) { dbg('  replant skipped (' + e.message + ')') }
    }

    // Lost-drop detection: we broke blocks but gained NO items - drops are falling
    // into gaps/void here (verified live: mining a platform edge lost every cobble).
    // Blacklist this spot and relocate to fresh ground rather than grind it dry.
    if (countItem(bot, item) === before) {
      failed.set(pkey(target.position), 2)
      noYield += n + 1
      if (noYield >= NO_YIELD_LIMIT) { await explore(bot, exploreIdx++, home, maxRoam, (x, z) => isSearchedDry(item, x, z)); noYield = 0 }
    } else { noYield = 0 }
  }
  return { gathered: countItem(bot, item) - start, reason: 'done' }
}

// Ensure a crafting table is reachable: use a nearby one (WALKING to it - a found-but-
// unpathable table is useless), or craft + place one right here. A roamy strip-mine
// routinely ends 20-40 blocks from the plan's own table across torn-up ground the
// anti-grief profile can't path ("No path to the goal!" killed the furnace craft twice,
// live) - so reach failures fall through to building a FRESH table where we stand.
async function ensureTable (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const tableId = mcData.blocksByName.crafting_table.id
  const reach = async (t) => {
    if (bot.entity.position.distanceTo(t.position) <= 3) return true
    try { await gotoWithTimeout(bot, new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2), 30000); return true } catch (e) { dbg('  ensureTable: cannot reach table at', t.position.toString(), '-', e.message); return false }
  }
  let table = bot.findBlock({ matching: tableId, maxDistance: 16 }) // `let`: the place path below reassigns it
  if (table && await reach(table)) { rememberInfra('table', table.position); return table }
  if (!table) { // none close - check further out (the plan's table from before the roam)
    const far = bot.findBlock({ matching: tableId, maxDistance: 48 })
    if (far && await reach(far)) { rememberInfra('table', far.position); return far }
  }
  // Beyond loaded chunks: a table we REMEMBER placing may be a short walk away - reuse it
  // rather than littering a new one every roam (operator complaint: tables everywhere).
  const known = await recallAndReach(bot, 'table', tableId, 64, reach)
  if (known) { rememberInfra('table', known.position); return known }
  // No reachable table -> place/craft a fresh one HERE (pack table, or 4 planks).
  if (countItem(bot, 'crafting_table') === 0) {
    const def = mcData.itemsByName.crafting_table
    const recipe = bot.recipesFor(def.id, null, 1, null)[0]
    if (!recipe) throw new Error('cannot craft a crafting table (need 4 planks)')
    await bot.craft(recipe, 1, null)
  }
  // place it on solid ground next to us
  const findSpot = () => {
    const b = bot.entity.position.floored()
    for (let r = 1; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx === 0 && dz === 0) continue
          for (const dy of [0, -1, 1]) { // slope-tolerant: a hillside ring has no cell at OUR exact y
            const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1 + dy, b.z + dz))
            const above = bot.blockAt(new Vec3(b.x + dx, b.y + dy, b.z + dz))
            if (ground && ground.boundingBox === 'block' && above && REPLACEABLE.test(above.name)) return ground
          }
        }
      }
    }
    return null
  }
  let ref = findSpot()
  if (!ref && opts.home) {
    // Nowhere here (e.g. up in a jungle canopy - leaves aren't placeable-into). Walk back
    // to the home anchor (the build site is cleared, real ground) and look again there.
    dbg('  ensureTable: no spot here (y=' + Math.floor(bot.entity.position.y) + ') - heading home to place')
    try { await gotoWithTimeout(bot, new goals.GoalNearXZ(opts.home.x, opts.home.z, 4), 30000) } catch {}
    ref = findSpot()
  }
  if (!ref) throw new Error('nowhere to place a crafting table')
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'crafting_table')
  await bot.equip(item, 'hand')
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
  await bot.placeBlock(ref, new Vec3(0, 1, 0))
  table = bot.findBlock({ matching: tableId, maxDistance: 8 })
  if (!table) throw new Error('placed a table but cannot find it')
  rememberInfra('table', table.position) // it's OURS now - future crafts come back here
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
    try { await bot.craft(recipe, 1, table) } catch (e) {
      if (!/windowOpen/.test(e.message || '')) throw e
      // Paper sometimes never opens the table window (same transient as openFurnace) -
      // re-approach and retry once before failing the whole craft (live: camp chest)
      dbg('  craft windowOpen timeout - re-approaching the table for one retry')
      if (table) { try { await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 15000) } catch {} }
      await bot.craft(recipe, 1, table)
    }
    await new Promise(r => setTimeout(r, 250)) // let the server's slot updates land
  }
  const made = countItem(bot, item) - before
  if (made < count) throw new Error(`crafting stalled: made ${made}/${count} ${item}`)
  // TAKE YOUR TABLE WITH YOU: a field-craft far from home leaves a table in the middle
  // of nowhere (operator complaint). If this table is OURS (infra registry) and we're
  // far from the home anchor, break it and pocket it - next field craft places it from
  // the pack. The home-area table stays put (it's the workshop).
  if (table && opts.home && Math.hypot(table.position.x - opts.home.x, table.position.z - opts.home.z) > 64) {
    const ours = recallInfra('table', table.position, 3)
    if (ours) {
      try {
        const tool = toolForBlock(bot, 'oak_planks') // any axe speeds it; bare hand works
        if (tool) await bot.equip(tool, 'hand').catch(() => {})
        await bot.dig(bot.blockAt(table.position))
        await collectDrops(bot, 4)
        forgetInfra('table', ours)
        dbg('  packed up my field crafting table (' + table.position.toString() + ')')
      } catch (e) { dbg('  could not pack up field table (' + e.message + ')') }
    }
  }
  return made
}

// Place one block of `itemName` from inventory on solid ground nearby.
// Returns the Vec3 where the new block landed.
// A cell counts as OPEN if it's air OR replaceable vegetation (placing into grass
// replaces it, like a player does) - requiring exactly 'air' made every table/furnace/
// chest placement fail in grassy savanna ("nowhere to place a crafting table").
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass)$/
async function placeFromInventory (bot, itemName) {
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === itemName)
  if (!item) throw new Error(`no ${itemName} to place`)
  const b = bot.entity.position.floored()
  let ref = null
  for (let r = 1; r <= 4 && !ref; r++) {
    for (let dx = -r; dx <= r && !ref; dx++) {
      for (let dz = -r; dz <= r && !ref; dz++) {
        if (dx === 0 && dz === 0) continue
        for (const dy of [0, -1, 1]) { // slope-tolerant (same rationale as ensureTable's findSpot)
          const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1 + dy, b.z + dz))
          const above = bot.blockAt(new Vec3(b.x + dx, b.y + dy, b.z + dz))
          if (ground && ground.boundingBox === 'block' && above && REPLACEABLE.test(above.name)) { ref = ground; break }
        }
      }
    }
  }
  if (!ref) throw new Error('no open ground to place on')
  await bot.equip(item, 'hand')
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
  await bot.placeBlock(ref, new Vec3(0, 1, 0))
  return ref.position.offset(0, 1, 0)
}

// Ensure a furnace is reachable: find a nearby one (WALKING to it - same rationale as
// ensureTable: found-but-unpathable is useless), or craft (8 cobblestone at a table) +
// place one. Returns the furnace block.
async function ensureFurnace (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const furnaceId = mcData.blocksByName.furnace.id
  const reach = async (f) => {
    if (bot.entity.position.distanceTo(f.position) <= 3) return true
    try { await gotoWithTimeout(bot, new goals.GoalNear(f.position.x, f.position.y, f.position.z, 2), 30000); return true } catch (e) { dbg('  ensureFurnace: cannot reach furnace at', f.position.toString(), '-', e.message); return false }
  }
  let furnace = bot.findBlock({ matching: furnaceId, maxDistance: 12 })
  if (furnace && await reach(furnace)) { rememberInfra('furnace', furnace.position); return furnace }
  // Reuse a furnace we REMEMBER before smelting 8 more cobble into a new one.
  const knownF = await recallAndReach(bot, 'furnace', furnaceId, 64, reach)
  if (knownF) { rememberInfra('furnace', knownF.position); return knownF }
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
  rememberInfra('furnace', furnace.position)
  return furnace
}

// How many distinct furnace BLOCKS stand near the bot (for planProvision's
// opts.furnacesNearby - placed furnaces are reused, never re-bought as 8 cobble).
function countFurnacesNear (bot, maxDistance = 16) {
  try {
    const md = require('minecraft-data')(bot.version)
    const id = md.blocksByName.furnace.id
    const seen = new Set()
    for (const p of bot.findBlocks({ matching: id, maxDistance, count: 8 }) || []) seen.add(`${p.x},${p.y},${p.z}`)
    return seen.size
  } catch { return 0 }
}

// Ensure up to `n` furnaces near us (find existing, craft+place the deficit). Returns
// 1..n POSITIONS (Vec3 - Block objects go stale across window opens; re-resolve with
// blockAt at each visit). Never throws for a deficit - degrades to what it achieved;
// throws only if ZERO furnaces are possible (via the proven ensureFurnace fallback).
// The old version failed silently (no dbg, break-on-everything, re-scan races) and
// built 0 furnaces live - every exit here is logged and placements are VERIFIED.
async function ensureFurnaces (bot, n, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const furnaceId = mcData.blocksByName.furnace.id
  const found = []
  const seen = new Set()
  for (const p of bot.findBlocks({ matching: furnaceId, maxDistance: 12, count: 8 }) || []) {
    const k = `${p.x},${p.y},${p.z}`
    if (!seen.has(k) && found.length < n) { seen.add(k); found.push(p.clone ? p.clone() : new Vec3(p.x, p.y, p.z)) }
  }
  dbg('  ensureFurnaces want=' + n + ' found=' + found.length + ' furnaceItems=' + countItem(bot, 'furnace'))
  let attempts = 0
  while (found.length < n && attempts++ < n * 2 + 2 && !isStopped()) {
    // 1) a furnace ITEM in the pack, crafting one if needed (8 cobble at a table)
    if (countItem(bot, 'furnace') === 0) {
      let table
      try { table = await ensureTable(bot, opts) } catch (e) { dbg('  ensureFurnaces: no table (' + e.message + ') - stopping at ' + found.length); break }
      if (bot.entity.position.distanceTo(table.position) > 3) await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000).catch(() => {})
      const recipe = bot.recipesFor(mcData.itemsByName.furnace.id, null, 1, table)[0]
      if (!recipe) { dbg('  ensureFurnaces: no cobble for furnace #' + (found.length + 1) + ' - stopping at ' + found.length); break }
      try { await bot.craft(recipe, 1, table) } catch (e) { dbg('  ensureFurnaces: craft failed (' + e.message + ') - stopping at ' + found.length); break }
      await new Promise(r => setTimeout(r, 250))
    }
    // 2) place it, with SPOT RECOVERY: the ring around a stationary bot fills up
    //    (table + furnaces already placed) - step to fresh ground and retry.
    let pos = null
    const dirs = [[4, 0], [0, 4], [-4, 0], [0, -4]]
    for (let step = 0; step <= 3 && !pos; step++) {
      try { pos = await placeFromInventory(bot, 'furnace') } catch (e) {
        dbg('  ensureFurnaces place fail (' + e.message + ') - stepping to fresh ground')
        const p = bot.entity.position
        await gotoWithTimeout(bot, new goals.GoalNearXZ(Math.round(p.x + dirs[step % 4][0]), Math.round(p.z + dirs[step % 4][1]), 1), 10000).catch(() => {})
      }
    }
    if (!pos) { dbg('  ensureFurnaces: nowhere to place - stopping at ' + found.length); break }
    // 3) VERIFY the block landed (block updates lag placement by 50-250ms) - never
    //    count an unverified spot (the old helper's re-scan race counted ghosts).
    let ok = false
    for (let i = 0; i < 8 && !ok; i++) {
      await new Promise(r => setTimeout(r, 250))
      const b = bot.blockAt(pos)
      if (b && b.name === 'furnace') ok = true
    }
    if (ok) { found.push(pos); dbg('  ensureFurnaces: placed #' + found.length + ' at ' + pos.toString()) } else dbg('  ensureFurnaces: placed but never saw a furnace block at ' + pos.toString())
  }
  if (!found.length) found.push((await ensureFurnace(bot, opts)).position) // proven fallback; may throw -> task fails loudly
  return found
}

// Smelt `count` of `input` into `output`. Dispatcher: big smelts (per furnaceCountFor)
// run across N furnaces in parallel when >=2 furnaces actually materialize; everything
// else takes the PROVEN single-furnace path. Returns number produced. opts: {say,isStopped}.
async function runSmelt (bot, output, input, count, opts = {}) {
  const N = furnaceCountFor(count)
  if (N < 2) return runSmeltSingle(bot, output, input, count, opts)
  let positions = null
  try { positions = await ensureFurnaces(bot, N, opts) } catch (e) { dbg('runSmelt: ensureFurnaces threw (' + e.message + ')') }
  if (!positions || positions.length < 2) {
    dbg('runSmelt: parallel not possible (' + (positions ? positions.length : 0) + ' furnaces) - single path')
    return runSmeltSingle(bot, output, input, count, opts)
  }
  return runSmeltMulti(bot, output, input, count, positions, opts)
}

// The PROVEN single-furnace smelt loop (night-shelter + slot-6/stale-inventory handling).
async function runSmeltSingle (bot, output, input, count, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const inItem = mcData.itemsByName[input]
  dbg('runSmelt', output, 'x' + count, 'from', input, '- ensuring furnace... (have', countItem(bot, input), input + ',', countItem(bot, 'coal'), 'coal,', countItem(bot, 'furnace'), 'furnace item)')
  const furnaceBlock = await ensureFurnace(bot, opts)
  dbg('  furnace at', furnaceBlock.position.toString())
  if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
    await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000)
  }
  const isFuel = i => /_planks$/.test(i.name) || i.name === 'coal' || i.name === 'charcoal' || i.name === 'coal_block' || /_log$/.test(i.name) || i.name === 'stick'
  // openFurnace can time out when a mob is whacking the bot mid-open (verified live at
  // hp 2) - re-approach and retry once before giving the task up to the re-plan loop.
  let furnace
  try { furnace = await bot.openFurnace(furnaceBlock) } catch (e) {
    dbg('  openFurnace failed (' + e.message + ') - retrying once')
    await new Promise(r => setTimeout(r, 2000))
    await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000).catch(() => {})
    furnace = await bot.openFurnace(furnaceBlock)
  }
  dbg('  furnace window open')
  // (closures read the `furnace` BINDING, so they follow the reopen-after-shelter reassignment)
  const slotSum = name => (furnace.slots || []).filter(s => s && s.name === name).reduce((a, s) => a + s.count, 0)
  const outSum = () => slotSum(output)
  const inInv = name => {
    let n = 0; const sl = furnace.slots || []
    for (let i = 3; i < sl.length; i++) if (sl[i] && sl[i].name === name) n += sl[i].count
    return n
  }
  let before = outSum()
  let made = 0
  let stall = 0; let lastMade = 0; let lastSay = 0; let lastShelter = 0
  try {
    while (made < count) {
      if (isStopped()) break
      // NIGHT SHELTER (mirrors gatherLoop): while the furnace window is open the bot is
      // AFK for minutes - naked at night with a hostile closing, it just stood there and
      // DIED at the furnace (verified live, 26/44). Close the window, dig in, reopen.
      // Output keeps cooking while sheltered and is collected on reopen. (Shelter digging
      // can only yield terrain blocks / smelt INPUT, never the OUTPUT, so `made` is safe.)
      if (nightRestWanted(bot) && Date.now() - lastShelter > 15000) {
        lastShelter = Date.now()
        say('night time - closing the furnace till it\'s safe')
        dbg('  smelt night-rest at', made + '/' + count, 'timeOfDay=' + (bot.time && bot.time.timeOfDay))
        try { furnace.close() } catch {}
        try { await nightRest(bot, { isStopped, say }) } catch {}
        if (isStopped()) break // death/stop while sheltered - unwind now (window already closed)
        if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
          await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000).catch(() => {})
        }
        furnace = await bot.openFurnace(furnaceBlock) // throws if destroyed -> task fails, autoBuild re-plans
        before = outSum() - made // rebase: shelter-time cooking counts as fresh progress next tick
        stall = 0 // shelter time must NOT count toward the 90s stall break
        dbg('  smelt reopened after shelter, rebased at made=' + made)
        continue
      }
      try { await furnace.takeOutput() } catch {}
      made = outSum() - before
      const stillNeed = count - made
      const cooking = furnace.inputItem() ? furnace.inputItem().count : 0
      if (!furnace.inputItem() && stillNeed > 0 && inInv(input) > 0) {
        try { await furnace.putInput(inItem.id, null, Math.min(stillNeed, inInv(input), 64)) } catch {}
      }
      if (!furnace.fuelItem() && stillNeed > 0 && (cooking > 0 || inInv(input) > 0)) {
        const fuelName = ['coal', 'charcoal'].find(n => inInv(n) > 0) || (furnace.slots || []).slice(3).find(s => s && isFuel(s))?.name
        if (fuelName) {
          const fid = mcData.itemsByName[fuelName].id
          const want = /_planks$/.test(fuelName) ? Math.max(2, Math.ceil(stillNeed / ITEMS_PER_PLANK) + 1) : 8
          try { await furnace.putFuel(fid, null, Math.min(inInv(fuelName), want)) } catch {}
        }
      }
      if (made > lastMade) { lastMade = made; stall = 0; dbg('  smelt progress', made + '/' + count) } else stall++
      const noFuel = !furnace.fuelItem() && !(furnace.slots || []).slice(3).some(s => s && isFuel(s))
      const noInput = !furnace.inputItem() && inInv(input) === 0
      if ((noFuel || noInput) && !furnace.outputItem() && cooking === 0) { dbg('  smelt BREAK: noFuel=' + noFuel + ' noInput=' + noInput + ' (made ' + made + '/' + count + ', fuelItem=' + !!furnace.fuelItem() + ' inputItem=' + !!furnace.inputItem() + ' invInput=' + inInv(input) + ' invCoal=' + inInv('coal') + ')'); break }
      if (stall > 90) { dbg('  smelt BREAK: stalled 90s at', made + '/' + count); break }
      if (made > 0 && Date.now() - lastSay > 20000) { say(`smelting… ${made}/${count} ${output}`); lastSay = Date.now() }
      await new Promise(r => setTimeout(r, 1000))
    }
    for (let i = 0; i < 4; i++) { try { await furnace.takeOutput() } catch {} await new Promise(r => setTimeout(r, 200)) }
    var madeFinal = outSum() - before
  } finally { try { furnace.close() } catch {} }
  await new Promise(r => setTimeout(r, 300))
  if ((madeFinal || 0) < count) throw new Error(`smelting stalled: ${madeFinal || 0}/${count} ${output} (out of fuel or input?)`)
  return madeFinal
}

// PARALLEL smelt across N furnace positions: load each furnace its share of input+fuel
// (they cook concurrently server-side), then rotate collecting/topping-up every ~10s.
// Only one window can be open at a time - the bot shuttles. All counts obey the furnace
// gotchas: read the OPEN window's slots (bot.inventory is stale while open; output lands
// in window slot 6 on 1.21.11). Same throw contract as the single path.
async function runSmeltMulti (bot, output, input, count, positions, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const inItem = mcData.itemsByName[input]
  const isFuel = i => /_planks$/.test(i.name) || i.name === 'coal' || i.name === 'charcoal' || i.name === 'coal_block' || /_log$/.test(i.name) || i.name === 'stick'
  const unitsOf = n => (n === 'coal' || n === 'charcoal') ? 8 : n === 'coal_block' ? 80 : /_log$/.test(n) ? 1.5 : ITEMS_PER_PLANK
  const F = positions.map(pos => ({ pos, loaded: 0, dead: 0, inputEmpty: false, outputResidue: false }))
  const alive = () => F.filter(f => f.dead < 3)
  let made = 0
  let invOut0 = null // player-inventory output baseline, set at the FIRST window open
  let lastMade = 0
  let lastProgressAt = Date.now()
  let lastSay = 0
  const hardDeadline = Date.now() + 60000 + count * 12000 // generously above single-furnace pace
  dbg('runSmeltMulti', output, 'x' + count, 'across', F.length, 'furnaces')

  const totalLoaded = () => F.reduce((s, f) => s + f.loaded, 0)
  // One visit: open, drain output, top up input to this furnace's fair share, refuel
  // against ITS pending input (proportional fuel is emergent - no furnace can hoard).
  async function service (f, i) {
    const blk = bot.blockAt(f.pos)
    if (!blk || blk.name !== 'furnace') { f.dead = 3; dbg('  multi: furnace', i, 'gone at', f.pos.toString()); return }
    if (bot.entity.position.distanceTo(f.pos) > 2.5) {
      try { await gotoWithTimeout(bot, new goals.GoalNear(f.pos.x, f.pos.y, f.pos.z, 2), 15000) } catch (e) { f.dead++; dbg('  multi: visit', i, 'goto fail (' + e.message + ')'); return }
    }
    let w
    try { w = await bot.openFurnace(blk) } catch {
      await new Promise(r => setTimeout(r, 500))
      try { w = await bot.openFurnace(blk) } catch (e2) { f.dead++; dbg('  multi: visit', i, 'open fail (' + e2.message + ')'); return }
    }
    f.dead = 0
    try {
      const inInv = name => { let n = 0; const sl = w.slots || []; for (let k = 3; k < sl.length; k++) if (sl[k] && sl[k].name === name) n += sl[k].count; return n }
      if (invOut0 === null) invOut0 = inInv(output) // baseline BEFORE any drain
      for (let k = 0; k < 4; k++) { try { await w.takeOutput() } catch {} await new Promise(r => setTimeout(r, 200)) }
      made = inInv(output) - invOut0 // exact: only window ops change inventory output
      if (made > lastMade) { lastMade = made; lastProgressAt = Date.now(); dbg('  multi: collect furnace', i, '->', made + '/' + count) }
      // top up input toward this furnace's share of what's still unloaded
      const curIn = w.inputItem() ? w.inputItem().count : 0
      const share = Math.ceil(Math.max(0, count - totalLoaded()) / Math.max(1, alive().length))
      const put = Math.min(share, inInv(input), 64 - curIn)
      if (put > 0) {
        try { await w.putInput(inItem.id, null, put); f.loaded += put; dbg('  multi: load furnace', i, '+' + put, input, '(loaded ' + f.loaded + ', total ' + totalLoaded() + ')') } catch (e) { dbg('  multi: load fail furnace', i, e.message) }
      }
      // refuel against THIS furnace's pending input
      const pending = (w.inputItem() ? w.inputItem().count : 0)
      const fuelItem = w.fuelItem()
      const fuelUnits = fuelItem ? fuelItem.count * unitsOf(fuelItem.name) : 0
      if (pending > 0 && fuelUnits < pending) {
        const fuelName = ['coal', 'charcoal'].find(n => inInv(n) > 0) || (w.slots || []).slice(3).find(s => s && isFuel(s))?.name
        if (fuelName) {
          const needUnits = pending - fuelUnits
          const n = Math.min(inInv(fuelName), Math.max(1, Math.ceil(needUnits / unitsOf(fuelName))))
          try { await w.putFuel(mcData.itemsByName[fuelName].id, null, n); dbg('  multi: fuel furnace', i, '+' + n, fuelName) } catch (e) { dbg('  multi: fuel fail furnace', i, e.message) }
        }
      }
      f.inputEmpty = !w.inputItem()
      f.outputResidue = ((w.slots || []).slice(0, 3).some(s => s && s.name === output))
      f.noFuelLeft = !w.fuelItem() && !(w.slots || []).slice(3).some(s => s && isFuel(s))
      f.noInputLeft = inInv(input) === 0
    } finally { try { w.close() } catch {} }
    await new Promise(r => setTimeout(r, 300)) // stale-inventory hygiene after close
  }

  // LOAD ROUND then COLLECT ROUNDS
  for (let i = 0; i < F.length; i++) { if (isStopped()) break; await service(F[i], i) }
  dbg('  multi: load round done, totalLoaded=' + totalLoaded())
  let idleRounds = 0
  while (made < count && !isStopped() && Date.now() < hardDeadline) {
    // NIGHT SHELTER between rotations (windows are all closed here)
    if (nightRestWanted(bot)) {
      dbg('  multi: night-rest at', made + '/' + count)
      try { await nightRest(bot, { isStopped, say }) } catch {}
      lastProgressAt = Date.now() // shelter time is not a stall
    }
    await new Promise(r => setTimeout(r, 10000)) // ~1 item cooks per 10s; faster rotation is wasted walking
    for (let i = 0; i < F.length; i++) { if (isStopped()) break; if (F[i].dead < 3) await service(F[i], i) }
    if (made >= count) break
    const live = alive()
    if (!live.length) { dbg('  multi BREAK: all furnaces dead at ' + made + '/' + count); break }
    const allIdle = live.every(f => f.inputEmpty && !f.outputResidue)
    const exhausted = live.every(f => f.noInputLeft) || live.every(f => f.noFuelLeft)
    if (allIdle && exhausted) { if (++idleRounds >= 2) { dbg('  multi BREAK: exhausted at ' + made + '/' + count); break } } else idleRounds = 0
    if (Date.now() - lastProgressAt > 90000) { dbg('  multi BREAK: stalled 90s at ' + made + '/' + count); break }
    if (made > 0 && Date.now() - lastSay > 20000) { say(`smelting… ${made}/${count} ${output} (${live.length} furnaces)`); lastSay = Date.now() }
  }
  // final drain rotation
  for (let i = 0; i < F.length; i++) { if (F[i].dead < 3) await service(F[i], i).catch(() => {}) }
  if (made < count) throw new Error(`smelting stalled: ${made}/${count} ${output} (out of fuel or input?)`)
  return made
}

// Raw meats a furnace can cook, and what they become. Fish included - the bot eats those too.
const RAW_COOKABLE = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon'
}

// Cook whatever raw meat we're carrying in a NEARBY furnace - the player-like tidy-up
// ("standing at the furnace anyway? toss the porkchops in"). Opportunistic on purpose:
// never crafts/places a furnace for this, needs fuel already in the pack, bounded to two
// meat types per pass. Returns how many items came out cooked (0 = nothing to do).
async function cookRawMeat (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const raw = Object.keys(RAW_COOKABLE).filter(n => countItem(bot, n) > 0)
  if (!raw.length) return 0
  const furnaceId = mcData.blocksByName.furnace.id
  let blk = bot.findBlock({ matching: furnaceId, maxDistance: 12 })
  if (!blk) {
    // the camp furnace lives in the hut now - worth a short walk (operator: "now that
    // it has a furnace why is it eating raw food?"); cooked feeds ~3x raw.
    const known = recallInfraVerified(bot, 'furnace', bot.entity.position, 32)
    if (known) {
      try { await gotoWithTimeout(bot, new goals.GoalNear(known.x, known.y, known.z, 2), 30000) } catch {}
      blk = bot.findBlock({ matching: furnaceId, maxDistance: 6 })
    }
  }
  if (!blk) return 0
  const hasFuel = (bot.inventory ? bot.inventory.items() : []).some(i =>
    i.name === 'coal' || i.name === 'charcoal' || i.name === 'coal_block' || /_planks$/.test(i.name))
  if (!hasFuel) return 0
  if (bot.entity.position.distanceTo(blk.position) > 2.5) {
    try { await gotoWithTimeout(bot, new goals.GoalNear(blk.position.x, blk.position.y, blk.position.z, 2), 15000) } catch { return 0 }
  }
  let cooked = 0
  dbg('cookRawMeat:', raw.map(n => countItem(bot, n) + 'x ' + n).join(', '))
  for (const name of raw.slice(0, 2)) { // bound the detour
    if (isStopped()) break
    const n = countItem(bot, name)
    // runSmeltSingle throws on a shortfall (e.g. fuel ran out mid-cook) - whatever DID
    // cook was already drained into the pack, so a partial pass is fine.
    try { cooked += await runSmeltSingle(bot, RAW_COOKABLE[name], name, n, opts) } catch { break }
  }
  return cooked
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
  dbg('runPlan:', plan.tasks.map(t => `${t.type}:${t.item || t.output}x${t.count || t.crafts || ''}`).join(' > '))
  for (const task of plan.tasks) {
    if (isStopped()) { results.push({ task, ok: false, note: 'stopped' }); break }
    dbg('  task START', task.type, task.item || task.output)
    try {
      if (task.type === 'gather') {
        say(`gathering ${task.count}x ${task.item}...`)
        const r = await runGather(bot, task.item, task.count, opts)
        results.push({ task, ok: r.gathered >= task.count, note: `${r.gathered}/${task.count} (${r.reason})` })
        // A partial gather only DOOMS downstream when it's a tool-gated material (cobble/ore
        // whose smelt/craft can't run short) or we got nothing. A short LOG haul (fuel/planks
        // headroom) is fine - runSmelt burns whatever wood exists and autoBuild re-plans the
        // shortfall - so continue instead of aborting the whole plan (which left builds with 0
        // cobble because one fuel-wood gather came up short).
        if (r.gathered < task.count && (GATHER_TOOL[task.item] || r.gathered === 0)) break
      } else if (task.type === 'craft') {
        say(`crafting ${task.crafts * task.perCraft}x ${task.item}...`)
        const made = await runCraft(bot, task.item, task.crafts * task.perCraft, task.needsTable, opts)
        results.push({ task, ok: true, note: `made ${made}` })
      } else if (task.type === 'smelt') {
        say(`smelting ${task.count}x ${task.output}...`)
        const made = await runSmelt(bot, task.output, task.input, task.count, opts)
        results.push({ task, ok: made >= task.count, note: `smelted ${made}` })
        // Standing at a hot furnace anyway - cook any raw meat from the survival hunts
        // before moving on, like a player would. Best-effort, never fails the plan.
        try { const c = await cookRawMeat(bot, opts); if (c > 0) dbg('  cooked', c, 'raw meat after the smelt') } catch {}
        if (made < task.count) break
      } else if (task.type === 'strip') {
        say(`stripping ${task.count}x ${task.output}...`)
        const made = await runStrip(bot, task.output, task.input, task.count, opts)
        results.push({ task, ok: made >= task.count, note: `stripped ${made}` })
        if (made < task.count) break
      }
    } catch (e) {
      dbg('  task ERROR', task.type, task.item || task.output, '->', e.message)
      results.push({ task, ok: false, note: e.message })
      break
    }
    dbg('  task done', task.type, task.item || task.output, '->', results[results.length - 1]?.note)
  }
  return results
}

// ---- chest storage (for builds too big to hold in 36 slots) ------------------

// Items the bot KEEPS on itself and never stashes: tools, weapons, armor, food,
// utility blocks, and a little scaffold dirt. Everything else is build material
// that goes into the chest.
const KEEP_ON_BOT = /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|^shears$|_helmet$|_chestplate$|_leggings$|_boots$|^cooked_|_apple$|^bread$|^carrot$|^potato$|beef|porkchop|mutton|chicken|^cod$|^salmon$|^torch$|flint_and_steel|_bucket$|^bucket$|^crafting_table$|^furnace$|^chest$|^coal$|^charcoal$|_planks$|^stick$/

// Find a chest within range, or craft (8 planks) + place one next to us. Returns
// the chest Block. Reuses the table/furnace placement pattern.
async function ensureChest (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const chestId = mcData.blocksByName.chest.id
  let chest = bot.findBlock({ matching: chestId, maxDistance: 8 })
  if (chest) { rememberInfra('chest', chest.position); return chest }
  // Reuse the site chest we REMEMBER (tight radius - the stash chest belongs at the site).
  const knownC = await recallAndReach(bot, 'chest', chestId, 24, async () => true)
  if (knownC) { rememberInfra('chest', knownC.position); return knownC }
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
  rememberInfra('chest', chest.position)
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

// ---- CHEST MIGRATION (operator promise): the banking chest lived in the open - one
// creeper by the treasury loses the economy. Once the safehouse stands, the bank moves
// INSIDE. Item-safe order: the new chest exists and is verified before anything leaves
// the old one; the old chest is only dug up once it reads EMPTY.
async function migrateChestInto (bot, oldPos, hut, { isStopped = () => false, say = () => {} } = {}) {
  // WALL-HUGGING interior cells (operator: "why did it place its chest in the middle") -
  // the centre [2,2] stays walkable; corners/edges first. Collect free cells, then find
  // an adjacent PAIR for a DOUBLE chest (operator: "make it a double chest for more space").
  const interior = []
  const order = [[1, 1], [1, 3], [3, 1], [3, 3], [1, 2], [2, 1], [2, 3], [3, 2]] // corners then edges, NEVER [2,2]
  for (const [dx, dz] of order) {
    for (let dy = 0; dy <= 3; dy++) {
      const p = new Vec3(hut.x + dx, hut.y + dy, hut.z + dz)
      const b = bot.blockAt(p); const below = bot.blockAt(p.offset(0, -1, 0)); const above = bot.blockAt(p.offset(0, 1, 0))
      if (b && AIRISH(b.name) && below && below.boundingBox === 'block' && above && AIRISH(above.name)) { interior.push(p); break }
    }
  }
  if (!interior.length) { dbg('  chest migration: no free interior cell in the hut'); return false }
  let target = interior[0]; let target2 = null
  for (const a of interior) { // a same-y neighbour makes the two chests merge into a double
    const n = interior.find(o => o.y === a.y && Math.abs(o.x - a.x) + Math.abs(o.z - a.z) === 1)
    if (n) { target = a; target2 = n; break }
  }
  let chestItem = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  const chestCount = () => countItem(bot, 'chest')
  if (chestCount() < 2) { // want TWO for the double chest
    try { await runCraft(bot, 'chest', 2 - chestCount(), true, { isStopped, home: { x: hut.x, y: hut.y, z: hut.z } }) } catch (e) { dbg('  chest migration: cannot craft chests (' + e.message + ')') }
    chestItem = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  }
  if (!chestItem) { dbg('  chest migration: no chest to place'); return false }
  if (bot.entity.position.distanceTo(target) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(target.x, target.y, target.z, 2), 20000) } catch {} }
  if (!await placeAt(bot, target, /^chest$/)) { dbg('  chest migration: could not place inside - ' + (placeAt.lastFail || '?')); return false }
  const newBlk = bot.blockAt(target)
  if (!newBlk || !/chest/.test(newBlk.name)) return false
  rememberInfra('chest', target)
  // second half of the double chest, if we have a pair-cell and a spare chest
  if (target2 && chestCount() >= 1) {
    if (bot.entity.position.distanceTo(target2) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(target2.x, target2.y, target2.z, 2), 15000) } catch {} }
    if (await placeAt(bot, target2, /^chest$/)) { const b2 = bot.blockAt(target2); if (b2 && /chest/.test(b2.name)) { rememberInfra('chest', target2); dbg('  chest migration: double chest placed') } }
  }
  say('moving the bank into the hut where creepers cannot audit it')
  let trips = 0
  while (!isStopped() && trips++ < 6) {
    const oldBlk = bot.blockAt(new Vec3(oldPos.x, oldPos.y, oldPos.z))
    if (!oldBlk || !/chest/.test(oldBlk.name)) break
    let counts
    try { counts = await chestCounts(bot, oldBlk) } catch (e) { dbg('  chest migration: old chest read failed (' + e.message + ')'); break }
    const names = Object.keys(counts)
    if (!names.length) break
    for (const n of names) {
      if ((bot.inventory ? bot.inventory.emptySlotCount() : 36) < 2) break
      try { await withdrawItem(bot, oldBlk, n, counts[n]) } catch {}
    }
    try { await depositMaterials(bot, bot.blockAt(target), { keepDirt: 8 }) } catch (e) { dbg('  chest migration: deposit failed (' + e.message + ')') }
  }
  const oldBlk2 = bot.blockAt(new Vec3(oldPos.x, oldPos.y, oldPos.z))
  let left = {}
  if (oldBlk2 && /chest/.test(oldBlk2.name)) { try { left = await chestCounts(bot, oldBlk2) } catch { left = { unknown: 1 } } }
  if (oldBlk2 && /chest/.test(oldBlk2.name) && !Object.keys(left).length) {
    try {
      const tool = toolForBlock(bot, 'oak_planks')
      if (tool) await bot.equip(tool, 'hand').catch(() => {})
      await bot.dig(oldBlk2); await collectDrops(bot, 4)
      const entry = listInfra('chest').find(e => e.x === Math.floor(oldPos.x) && e.y === Math.floor(oldPos.y) && e.z === Math.floor(oldPos.z))
      if (entry) forgetInfra('chest', entry)
      say('bank moved - old chest packed up')
    } catch (e) { dbg('  chest migration: old chest pickup failed (' + e.message + ')') }
  } else if (Object.keys(left).length) dbg('  chest migration: old chest NOT empty after trips - leaving it standing')
  return true
}

// ---- FURNISH THE HUT (operator: "wheres the bed crafting table and furnace?"): the
// camp's loose infra moves indoors with the bank. Furnace and table get dug up and
// re-placed inside; the remembered bed is relocated and re-activated (spawn re-set).
const insideHutBox = (p, hut) => p.x >= hut.x && p.x <= hut.x + 4 && p.z >= hut.z && p.z <= hut.z + 4
// The doorway = the non-corner rim column whose two wall cells are NOT solid wall
// (air, or a bed/door mistakenly shoved into it - detection must survive clutter).
function findHutDoorway (bot, hut) {
  // hut.schem has NO floor layer: walls start AT origin.y, so the door hole is at
  // dy 0..1 (scanning 1..2 found "no doorway" while the gap sat one block lower, live)
  for (let dx = 0; dx <= 4; dx++) {
    for (let dz = 0; dz <= 4; dz++) {
      const onRim = dx === 0 || dx === 4 || dz === 0 || dz === 4
      const corner = (dx === 0 || dx === 4) && (dz === 0 || dz === 4)
      if (!onRim || corner) continue
      const lo = bot.blockAt(new Vec3(hut.x + dx, hut.y, hut.z + dz))
      const hi = bot.blockAt(new Vec3(hut.x + dx, hut.y + 1, hut.z + dz))
      if (lo && hi && !/_planks$/.test(lo.name) && !/_planks$/.test(hi.name)) return new Vec3(hut.x + dx, hut.y, hut.z + dz)
    }
  }
  return null
}
function hutFreeCells (bot, hut) {
  const doorway = findHutDoorway(bot, hut)
  // the interior cell in FRONT of the doorway stays clear - the bed got placed in the
  // entrance (operator: "it placed its bed inside the door frame")
  const threshold = doorway ? new Vec3(doorway.x + (doorway.x === hut.x ? 1 : doorway.x === hut.x + 4 ? -1 : 0), doorway.y, doorway.z + (doorway.z === hut.z ? 1 : doorway.z === hut.z + 4 ? -1 : 0)) : null
  const out = []
  for (const [dx, dz] of [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [1, 3], [2, 3], [3, 3]]) {
    for (let dy = 0; dy <= 3; dy++) {
      const p = new Vec3(hut.x + dx, hut.y + dy, hut.z + dz)
      if (threshold && p.x === threshold.x && p.z === threshold.z) break // keep the entrance walkable
      const b = bot.blockAt(p); const below = bot.blockAt(p.offset(0, -1, 0)); const above = bot.blockAt(p.offset(0, 1, 0))
      // the floor below must be a real BLOCK, not other furniture - a chest counts as
      // "solid" so a table landed ON TOP of the chest (operator caught it live)
      const belowIsFloor = below && below.boundingBox === 'block' && !HUT_FURNITURE.test(below.name)
      if (b && AIRISH(b.name) && belowIsFloor && above && AIRISH(above.name)) { out.push(p); break }
    }
  }
  if (doorway) out.sort((a, b) => b.distanceTo(doorway) - a.distanceTo(doorway)) // furthest from the entrance first
  return out
}
const HUT_FURNITURE = /chest$|barrel$|furnace$|smoker$|crafting_table$|_bed$|_door$/
// Is a block of kind `itemRe` already standing inside the hut interior?
function furnitureInHut (bot, hut, itemRe) {
  for (let dx = 1; dx <= 3; dx++) for (let dz = 1; dz <= 3; dz++) for (let dy = 0; dy <= 3; dy++) {
    const b = bot.blockAt(new Vec3(hut.x + dx, hut.y + dy, hut.z + dz))
    if (b && itemRe.test(b.name)) return new Vec3(hut.x + dx, hut.y + dy, hut.z + dz)
  }
  return null
}
async function furnishHut (bot, hut, { isStopped = () => false, say = () => {} } = {}) {
  const moved = []
  // EVEN FLOOR first (operator: "half of the hut is in a hole so the floor isnt even"):
  // the schematic has no floor layer, so the interior is raw terrain. Level each of the
  // 9 interior columns to hut.y-1: shave natural bumps, fill holes with carried dirt.
  // Columns carrying furniture are left alone.
  const INFRA_RE = /chest$|barrel$|furnace$|smoker$|_bed$|^torch$|_torch$|crafting_table$|_door$/
  try {
    for (const [dx, dz] of [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [1, 3], [2, 3], [3, 3]]) {
      if (isStopped()) break
      const colBusy = [0, 1].some(dy => { const b = bot.blockAt(new Vec3(hut.x + dx, hut.y + dy, hut.z + dz)); return b && INFRA_RE.test(b.name) })
      if (colBusy) continue
      for (const dy of [1, 0]) { // shave terrain poking above floor level (top-down)
        const b = bot.blockAt(new Vec3(hut.x + dx, hut.y + dy, hut.z + dz))
        if (b && !AIRISH(b.name) && canBreakNaturally(b)) {
          if (bot.entity.position.distanceTo(b.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2), 12000) } catch { break } }
          const tool = toolForBlock(bot, b.name)
          if (tool) await bot.equip(tool, 'hand').catch(() => {})
          try { await bot.dig(b); await collectDrops(bot, 3) } catch {}
        }
      }
      const fl = bot.blockAt(new Vec3(hut.x + dx, hut.y - 1, hut.z + dz))
      if (fl && (AIRISH(fl.name) || /water/.test(fl.name))) { // fill a floor hole
        if (await placeAt(bot, fl.position, /^(dirt|coarse_dirt|cobblestone)$/)) moved.includes('floor') || moved.push('floor')
      }
    }
  } catch (e) { dbg('  furnish: floor pass failed (' + e.message + ')') }
  // DEDUPE furniture (operator: two tables; a table ON the chest blocked it from opening):
  // keep one table + one furnace, dig any extra, and dig anything stacked on a CHEST -
  // only a chest needs clear air above to open. A table on a FURNACE is fine (operator:
  // "valid") - furnaces open by right-click regardless, and it's a tidy space-saver.
  try {
    const seen = {}
    for (let dx = 1; dx <= 3; dx++) for (let dz = 1; dz <= 3; dz++) for (let dy = 3; dy >= 0; dy--) { // top-down
      const p = new Vec3(hut.x + dx, hut.y + dy, hut.z + dz)
      const b = bot.blockAt(p)
      if (!b || !/crafting_table$|furnace$/.test(b.name)) continue
      const below = bot.blockAt(p.offset(0, -1, 0))
      const onChest = below && /chest$/.test(below.name) // blocks the chest lid; furnace-below is fine
      const dupe = seen[b.name.replace(/^.*_/, '')]
      if (onChest || dupe) {
        try {
          if (bot.entity.position.distanceTo(p) > 4) await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 10000)
          const t = toolForBlock(bot, b.name); if (t) await bot.equip(t, 'hand').catch(() => {})
          await bot.dig(b); await collectDrops(bot, 2)
          const entry = listInfra(/table/.test(b.name) ? 'table' : 'furnace').find(x => x.x === p.x && x.y === p.y && x.z === p.z)
          if (entry) forgetInfra(/table/.test(b.name) ? 'table' : 'furnace', entry)
          dbg('  furnish: removed a stray ' + b.name + (onChest ? ' (was blocking the chest)' : ' (duplicate)'))
        } catch {}
      } else seen[b.name.replace(/^.*_/, '')] = true
    }
  } catch (e) { dbg('  furnish: dedupe pass failed (' + e.message + ')') }
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
      await walkStaged(bot, kb.x, kb.z, { isStopped, range: 4, timeoutMs: 120000 })
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
      await walkStaged(bot, hut.x + 2, hut.z + 2, { isStopped, range: 4, timeoutMs: 120000 })
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
        if (!door) { try { await runCraft(bot, 'oak_door', 1, true, { isStopped, home: { x: hut.x, y: hut.y, z: hut.z } }) } catch (e) { dbg('  furnish: cannot craft a door (' + e.message + ')') } }
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

// Read chest contents as { name: count } (build materials the chest is holding).
async function chestCounts (bot, chestBlock) {
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  const out = {}
  try { for (const i of chest.containerItems()) out[i.name] = (out[i.name] || 0) + i.count } finally { chest.close() }
  return out
}

module.exports = { GATHER_SOURCES, GATHER_TOOL, SMELT_MAP, STRIP_MAP, planProvision, inventoryCounts, runGather, runCraft, runSmelt, runStrip, runPlan, ensureTable, ensureFurnace, ensureChest, depositMaterials, withdrawItem, chestCounts, detectWood, KEEP_ON_BOT, climbToSurface, pillarUpTo, manualHopFromWater, toolForBlock, migrateChestInto, furnishHut, hasSolidCeiling, gatherLeather, huntForFood, hasFood, needsFood, digInForNight, nightRest, nightRestWanted, restUntilSafe, isResting, rememberBed, knownBed, isSheltering, shelterNeeded, isNight, underArmored, furnaceCountFor, countFurnacesNear, ensureFurnaces, cookRawMeat, dumpJunk, listInfra, rememberInfra, ensureWheatFarm, tendWheatFarm, fishForFood, ensureHutApron, setBuildZone, setDebugSink }
