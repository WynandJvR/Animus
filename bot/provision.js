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
const scaffold = require('./scaffold.js') // scaffold manager: temp-block registry, filler policy, teardown
const hutModel = require('./hut-model.js') // self-structure model: schema-correct wall/door/floor/interior/furniture classification
const mining = require('./mining.js') // pure mining strategy: depth model, descent-safety, branch-mine geometry
const shelterSite = require('./shelter.js') // pure shelter-siting: "can a safe pit be dug here" + nearest diggable dry cell
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

// ---- OWN-STRUCTURE AWARENESS ---------------------------------------------------
// The hut is 6x5x6 (hut.schem: anchor + 0..5 in x/z, + 0..4 in y). Being INSIDE it is
// not "underground": before this predicate the roofed interior tripped hasSolidCeiling,
// so climb-out dug through the bot's own roof, pit-escape pillared dirt onto the floor,
// and fishing/farming refused to run "in a cave" while the bot stood in its living room.
function ownHutAt (pos) {
  if (!pos) return null
  const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
  for (const h of listInfra('hut')) {
    if (x >= h.x && x <= h.x + 5 && z >= h.z && z <= h.z + 5 && y >= h.y && y <= h.y + 4) return h
  }
  return null
}
// Feet (or `pos`) inside one of the bot's own roofed structures. Returns the hut anchor
// entry or null - truthiness is the common use.
function insideOwnStructure (bot, pos) {
  const p = pos || (bot && bot.entity && bot.entity.position)
  return p ? ownHutAt(p) : null
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

// Heal a CREEPER CRATER around the home's exit - the wider cousin of ensureHutApron. A
// blast ate the terrain in front of the door into a multi-deep bowl (live: air down to
// y62 spanning ~x414-421 / z81-85, incl. an EAST pit at x419-420 the door lane misses);
// the pathfinder can't route ACROSS it, so the bot is trapped at its threshold AND falls
// into the far side and dies (live: fell into (419,62,84)). Fills the FULL footprint flush
// at floorY, bottom-up (each layer sits on the one below). Two modes:
//   reposition=false: place only what's reachable from WHERE THE BOT STANDS (the doorway,
//     mid-crossing) - a fast western-lane patch so the step-out lands solid.
//   reposition=true: also walk the rim (GoalNearXZ settles on reachable ground, never in
//     the pit - canDig=false) to reach the far EAST columns the doorway can't touch.
// Own-hut only (caller gates on ownHutAt) + survival place from the bot's own filler +
// skips solid cells => anti-grief and idempotent (0 places on a healthy apron). Returns
// cells placed. `at` = hut anchor.
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
  const targets = []
  for (let wz = Z1; wz >= Z0; wz--) for (let wx = X0; wx <= X1; wx++) {
    if (inFootprint(wx, wz)) continue
    if (!solidAt(wx, floorY, wz)) targets.push({ x: wx, z: wz })
  }
  const holes = targets.length
  if (!holes) return 0
  let filled = 0; let progress = true; let guard = 0
  while (targets.length && progress && guard++ < 80 && !isStopped()) {
    progress = false
    targets.sort((a, b) => bot.entity.position.distanceTo(new Vec3(a.x, floorY, a.z)) - bot.entity.position.distanceTo(new Vec3(b.x, floorY, b.z)))
    for (let i = 0; i < targets.length && !isStopped(); i++) {
      const t = targets[i]
      const sideN = N4.map(([dx, dz]) => ({ x: t.x + dx, z: t.z + dz })).filter(n => !inFootprint(n.x, n.z) && solidAt(n.x, floorY, n.z))
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

// Make sure the hut has a usable BED and our spawn is set on it. Runs every camp pass
// (decoupled from the bad>3 rebuild, where the only bed path used to live - so a recovered
// bed rode around unplaced forever, no spawn). If a bed already stands in the hut, (re)assert
// spawn on it once; else, if we're carrying one, walk inside (the apron is filled so entry
// works) and lay it on an interior floor cell clear of the furniture, then set spawn. Every
// place is verified (Fable's placedOK is live) - a fail just leaves the bed in the pack, no
// worse than before. Returns 'present' | 'placed' | 'none' | 'fail'. `at` = hut anchor.
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
    if (mineDanger(bot)) { dbg('  shaft: hostile close / hp low - bailing the descent to react'); break } // hand control back to the gather's survival reflex
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
  if (insideOwnStructure(bot)) { dbg('  staircase: inside my own hut - not cutting up through it'); return }
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
  if (insideOwnStructure(bot)) { dbg('  pillar: inside my own hut - not pillaring through the roof'); return }
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
          // the placeBlock wrapper (pathfix) verifies against the world - no exception
          // means the block is really there; register it as tower scaffold for teardown
          try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); scaffold.add(feet, 'pillar') } catch { await new Promise(r => setTimeout(r, 150)) }
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
    if (mineDanger(bot)) break // hostile close / hp low -> return control to the gather's survival reflex (don't stay locked in dig-awaits taking hits)
    const feet = bot.entity.position.floored()
    const ahead = feet.plus(dir)
    const aheadUp = ahead.offset(0, 1, 0)
    const floor = ahead.offset(0, -1, 0)
    const fB = bot.blockAt(floor)
    if ([ahead, aheadUp, floor].some(p => { const b = bot.blockAt(p); return b && DANGER.test(b.name) })) break
    if (!fB || AIRISH(fB.name)) break // drop/cave ahead -> stop (don't walk into a hole)
    // DON'T OPEN A CAVERN naked: if the cells one step BEYOND the face are already open
    // air, breaking in exposes us to whatever's in the dark cave (the zombie+skeleton
    // ambush that killed the gearup bot came from tunnelling into an open cave at y39).
    const beyond = ahead.plus(dir)
    const bBeyond = bot.blockAt(beyond); const bBeyondUp = bot.blockAt(beyond.offset(0, 1, 0))
    if ((bBeyond && AIRISH(bBeyond.name)) && (bBeyondUp && AIRISH(bBeyondUp.name))) break
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
    // TARGET-ORE BYCATCH: a straight tunnel only mines what's dead-ahead, so iron veins
    // exposed in the WALLS slid past un-mined - the reason deep tunnels still returned
    // got=0 (verified live). Actively grab the ore that yields what we came for (raw_iron
    // -> iron_ore, raw_copper -> copper_ore, ...) from the tunnel walls. Bounded per step.
    const oreWord = String(itemName).replace(/^raw_/, '')
    if (oreWord && oreWord !== itemName) { try { await grabNearbyOre(bot, new RegExp(oreWord + '_ore$'), 3, 5, { isStopped }) } catch {} }
    try { await gotoWithTimeout(bot, new goals.GoalBlock(ahead.x, ahead.y, ahead.z), 5000) } catch { break }
    if (!dugAny) break
  }
  return countItem(bot, itemName) - before
}

// ---- ORGANIZED BRANCH MINE (mining-strategy-design.md) ---------------------------------
// Place a torch on the floor beneath us if we carry one - lights the mine so mobs don't
// spawn in the fresh tunnels (a lightly-armored bot dies to a dark-cave ambush). Best-effort.
async function placeTorch (bot) {
  const torch = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'torch')
  if (!torch) return false
  const feet = bot.entity.position.floored()
  // place on the floor of an ADJACENT open cell (not under our own feet - we occupy that):
  // stand-in-tunnel, torch on the ground beside us. Best-effort across the 4 neighbours.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const side = feet.offset(dx, 0, dz)
    const cell = bot.blockAt(side); const floor = bot.blockAt(side.offset(0, -1, 0))
    if (cell && AIRISH(cell.name) && floor && floor.boundingBox === 'block' && !/lava|water/.test(floor.name)) {
      try { await bot.equip(torch, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)); return true } catch { /* try next side */ }
    }
  }
  return false
}

// Make a few torches so the mine can be lit: coal/charcoal (1) + stick (1) -> 4 torches, no
// table needed. Best-effort - the bot picks up coal as bycatch while tunnelling, and carries
// sticks from tool-crafting; if it has neither it just mines darker (the efba7bd reflex is
// the backstop). Never throws.
async function ensureTorches (bot, want = 8) {
  try {
    if (countItem(bot, 'torch') >= want) return
    const mcData = require('minecraft-data')(bot.version)
    const torch = mcData.itemsByName.torch
    if (!torch) return
    for (let i = 0; i < 4 && countItem(bot, 'torch') < want; i++) {
      const recipe = (bot.recipesFor(torch.id, null, 1, null) || [])[0] // inventory 2x2 crafting - no table
      if (!recipe) break
      try { await bot.craft(recipe, 1, null); await new Promise(r => setTimeout(r, 150)) } catch { break }
    }
    if (countItem(bot, 'torch') > 0) dbg('  mine: have ' + countItem(bot, 'torch') + ' torches to light the tunnels')
  } catch { /* best-effort */ }
}

// ---- SELF-SUFFICIENT tooling at depth -------------------------------------------------
// Pickaxes in the pack (stone-or-better - the tier that actually drops iron/stone), with
// their remaining uses. A deep mine wears these out; if none has uses left the bot can't
// mine and (before this) got dragged to a surface table -> stranded on cave terrain (live).
function miningPicks (bot) {
  return (bot.inventory ? bot.inventory.items() : [])
    .filter(i => /(stone|iron|diamond|netherite)_pickaxe$/.test(i.name))
    .map(i => ({ item: i, usesLeft: mining.pickUsesLeft(i.name, i.durabilityUsed || 0) }))
}
function bestPick (bot) { let b = null; for (const p of miningPicks(bot)) if (p.usesLeft > 0 && (!b || p.usesLeft > b.usesLeft)) b = p; return b }
function workingPickCount (bot) { return miningPicks(bot).filter(p => p.usesLeft > 0).length }
function workingMiningPick (bot) { return !!bestPick(bot) }
function carriedPickUsesLeft (bot) { return miningPicks(bot).reduce((s, p) => s + p.usesLeft, 0) }

// Craft ONE of `itemName` from carried ingredients at `tableBlock` (or the 2x2 grid when
// null). Best-effort, never throws. Returns whether one was made.
async function craftOneFromInv (bot, itemName, tableBlock = null) {
  const mcData = require('minecraft-data')(bot.version)
  const it = mcData.itemsByName[itemName]; if (!it) return false
  const rec = (bot.recipesFor(it.id, null, 1, tableBlock) || [])[0]
  if (!rec) return false
  const before = countItem(bot, itemName)
  try { await bot.craft(rec, 1, tableBlock || undefined); await new Promise(r => setTimeout(r, 150)) } catch { return false }
  return countItem(bot, itemName) > before
}

// Craft a stone pickaxe RIGHT HERE (surface OR depth) - LOCAL only, never walking to a
// remembered surface table (that walk is the stranding). Mines a little cobble with the
// still-working pick if short (why we re-tool BEFORE the pick breaks), tops up sticks from
// carried planks, places a carried/crafted table beside us, and crafts. Returns success.
async function craftStonePickHere (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  // 1) cobble: 3 per pick. Mine surrounding natural stone with the (still-working) pick -
  //    wider search than the tight bycatch radius so it can grab the last block or two at the
  //    surface too (the up-front kit reported "have 2" and provisioned nothing, live).
  if (countItem(bot, 'cobblestone') < 3 && workingMiningPick(bot)) {
    try { await grabNearbyOre(bot, /^(stone|cobblestone|deepslate|cobbled_deepslate|granite|diorite|andesite|tuff)$/, parseInt(process.env.MINE_COBBLE_RADIUS || '8', 10), 4, { isStopped }) } catch {}
  }
  if (countItem(bot, 'cobblestone') < 3) { dbg('  reTool: not enough cobble to craft a pick (have ' + countItem(bot, 'cobblestone') + ') - skipping, will re-tool at depth where stone is everywhere'); return false }
  // 2) sticks: 2 per pick. Cannot be mined - make from carried planks, else fail honestly.
  if (countItem(bot, 'stick') < 2) { await craftOneFromInv(bot, 'stick'); if (countItem(bot, 'stick') < 2) { dbg('  reTool: no sticks and no planks to make them - cannot re-tool here'); return false } }
  // 3) a table WITHIN REACH: reuse one placed nearby, else place a carried one, else craft
  //    one from carried planks. NEVER goto a far/remembered table (the stranding walk).
  let tb = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 })
  if (!tb) {
    if (countItem(bot, 'crafting_table') < 1) { if (!await craftOneFromInv(bot, 'crafting_table')) { dbg('  reTool: no crafting table and no planks to make one'); return false } }
    let pos = null
    try { pos = await placeFromInventory(bot, 'crafting_table') } catch {}
    tb = pos ? bot.blockAt(pos) : bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 })
  }
  if (!tb) { dbg('  reTool: could not place a table at depth'); return false }
  // 4) craft the pick at the local table
  const ok = await craftOneFromInv(bot, 'stone_pickaxe', tb)
  if (ok) dbg('  reTool: crafted a fresh stone pickaxe at depth (y=' + Math.floor(bot.entity.position.y) + ')')
  return ok && workingMiningPick(bot)
}

// UP-FRONT mining kit (surface, before the descent): carry enough pick durability for the
// excursion + a table + sticks so a break at depth is re-tooled IN PLACE, never a surface
// round-trip. Best-effort with carried materials (the bot already made its first stone pick,
// so it has cobble/planks/sticks around); depth re-tool + honest bail cover any shortfall.
async function ensureMiningKit (bot, depth, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  // a table to carry for depth re-tool
  if (countItem(bot, 'crafting_table') < 1) await craftOneFromInv(bot, 'crafting_table')
  // sticks buffer (can't be mined at depth): craft a handful from carried planks
  const wantSticks = parseInt(process.env.MINE_KIT_STICKS || '8', 10)
  for (let i = 0; i < 4 && countItem(bot, 'stick') < wantSticks && !isStopped(); i++) { if (!await craftOneFromInv(bot, 'stick')) break }
  // spare stone picks sized to the expected dig (bounded so we don't over-grind cobble)
  const estBlocks = mining.estExcursionBlocks(depth, { branches: parseInt(process.env.MINE_KIT_BRANCHES || '6', 10), branchLen: parseInt(process.env.MINE_BRANCH_LEN || '12', 10), spacing: parseInt(process.env.MINE_SPACING || '3', 10) })
  const maxPicks = parseInt(process.env.MINE_MAX_PICKS || '4', 10)
  const toCraft = Math.min(maxPicks, mining.picksToCraft(carriedPickUsesLeft(bot), estBlocks))
  for (let i = 0; i < toCraft && !isStopped(); i++) { if (!await craftStonePickHere(bot, { isStopped })) break }
  dbg('  ensureMiningKit: stone_picks=' + countItem(bot, 'stone_pickaxe') + ' pickUsesLeft=' + carriedPickUsesLeft(bot) + ' table=' + countItem(bot, 'crafting_table') + ' sticks=' + countItem(bot, 'stick') + ' (est ' + estBlocks + ' blocks, wanted ' + toCraft + ' spares)')
}

// Dig a single WALKABLE staircase DOWN to targetY (one entrance, back-out-able - the fix
// for N scattered vertical shafts). Each step clears the forward feet+head cells and the
// forward-down tread, then walks onto it. SAFETY: never step onto lava/water/void - probe
// the landing's floor first (mining.descentSafety). Returns { reached, reason, blocked }
// where `blocked` (lava/water/void) tells branchMine to relocate the entrance.
async function digStaircaseDown (bot, targetY, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const dirIdx = ((opts.dirIdx || 0) % 4 + 4) % 4
  const [ddx, ddz] = mining.DIRS[dirIdx]
  const dir = new Vec3(ddx, 0, ddz)
  let steps = 0
  while (Math.floor(bot.entity.position.y) > targetY && !isStopped() && steps < 96) {
    if (mineDanger(bot)) return { reached: false, reason: 'hostile/hp during descent', blocked: null }
    const feet = bot.entity.position.floored()
    const ahead = feet.plus(dir)            // forward at feet level
    const aheadUp = ahead.offset(0, 1, 0)   // forward head clearance
    const step = ahead.offset(0, -1, 0)     // the tread we descend onto
    const stepFloor = step.offset(0, -1, 0) // what our feet will stand on after stepping
    const stepFloor2 = step.offset(0, -2, 0)
    const fb = bot.blockAt(stepFloor); const fb2 = bot.blockAt(stepFloor2)
    const safety = mining.descentSafety(fb && fb.name, fb2 && fb2.name)
    if (safety !== 'ok') { dbg('  staircase: ' + safety + ' under the next tread at ' + step.toString() + ' - stopping this shaft'); return { reached: false, reason: safety + ' below', blocked: safety } }
    // don't break INTO an open cavern (dark mob ambush) - if the tread cell and its head are
    // already open air with more air beyond, hand back to relocate rather than crack it open.
    const dig = async (p) => {
      const b = bot.blockAt(p)
      if (!b || AIRISH(b.name)) return true
      if (/lava|water/.test(b.name)) return false
      if (!canBreakNaturally(b)) return false
      const tool = toolForBlock(bot, b.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(b)) return false
      try { await bot.dig(b) } catch { return false }
      return true
    }
    if (!(await dig(aheadUp)) || !(await dig(ahead)) || !(await dig(step))) { return { reached: false, reason: 'blocked face', blocked: 'void' } }
    await collectDrops(bot, 2)
    try { await gotoWithTimeout(bot, new goals.GoalBlock(step.x, step.y, step.z), 6000) } catch { return { reached: false, reason: 'could not step down', blocked: null } }
    steps++
    // opportunistic: light the descent every few steps
    if (steps % 4 === 0) await placeTorch(bot).catch(() => {})
  }
  return { reached: Math.floor(bot.entity.position.y) <= targetY + 1, reason: 'at level', blocked: null }
}

// ---- PERSISTENT MINE (world-memory 'mines'): remember a dug mine so the next excursion
// RE-ENTERS it instead of re-digging the descent (on cave terrain the descent ate the whole
// excursion, gathered:0 "out of time" - live). A mine record: entrance {x,z}+top (surface),
// level (mining Y), lx/lz (staircase bottom), dirIdx (corridor dir), tip {x,y,z} (corridor
// end - where to resume), branches (count done), at.
function loadMines () { const m = loadWorldMem(); return (m.mines = m.mines || []) }
function rememberMine (entry) {
  const mines = loadMines()
  const i = mines.findIndex(e => Math.hypot(e.x - entry.x, e.z - entry.z) <= 3)
  const rec = { ...(i >= 0 ? mines[i] : {}), ...entry, at: Date.now() }
  if (i >= 0) mines[i] = rec; else mines.push(rec)
  if (mines.length > 8) { mines.sort((a, b) => b.at - a.at); mines.length = 8 }
  saveWorldMem()
  return rec
}
function recallMine (bot, near, maxDist) {
  const now = Date.now()
  let best = null; let bd = Infinity
  for (const e of loadMines()) {
    if (!mining.mineReusable(e, near, { maxDist, now })) continue
    const d = Math.hypot(e.x - near.x, e.z - near.z); if (d < bd) { bd = d; best = e }
  }
  return best
}
function forgetMine (entry) {
  const m = loadWorldMem(); if (!m.mines) return
  m.mines = m.mines.filter(e => !(Math.abs(e.x - entry.x) <= 3 && Math.abs(e.z - entry.z) <= 3))
  saveWorldMem()
}
function updateMineProgress (entry, branches, tip) {
  const mines = loadMines()
  const i = mines.findIndex(e => Math.abs(e.x - entry.x) <= 3 && Math.abs(e.z - entry.z) <= 3)
  if (i >= 0) { mines[i].branches = branches; if (tip) mines[i].tip = { x: tip.x, y: tip.y, z: tip.z }; mines[i].at = Date.now(); saveWorldMem() }
}

// Walk to a remembered mine's entrance and descend the EXISTING staircase to the mining
// level, then to the corridor tip - NO re-digging (the whole point). VERIFIES on arrival
// (world-read: reached the level and it isn't flooded); returns false if the staircase is
// gone/blocked/flooded so branchMine digs fresh + re-persists.
async function enterExistingMine (bot, mine, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const here = bot.entity.position
  // 1) to the entrance XZ at the surface (staged trek for a far mine)
  if (Math.hypot(here.x - mine.x, here.z - mine.z) > 4) {
    try { await walkStaged(bot, mine.x, mine.z, { isStopped, range: 3, timeoutMs: 60000 }) } catch {}
    try { await gotoWithTimeout(bot, new goals.GoalNearXZ(mine.x, mine.z, 2), 20000) } catch {}
  }
  if (isStopped()) return false
  // 2) walk DOWN the open staircase to the mining level (no dig - it's already cut)
  const lx = mine.lx != null ? mine.lx : mine.x; const lz = mine.lz != null ? mine.lz : mine.z
  try { await gotoWithTimeout(bot, new goals.GoalNear(lx, mine.level, lz, 2), 40000) } catch {}
  if (Math.abs(Math.floor(bot.entity.position.y) - mine.level) > 3) {
    dbg('  reEnter: could not reach the mine level (y' + Math.floor(bot.entity.position.y) + ' vs ' + mine.level + ') - staircase gone/blocked, digging fresh')
    return false
  }
  if (inWaterNow(bot)) { dbg('  reEnter: mine is flooded - abandoning it'); return false }
  // 3) to the corridor tip so we mine FRESH stone, not re-walk the open corridor
  if (mine.tip) { try { await gotoWithTimeout(bot, new goals.GoalNear(mine.tip.x, mine.tip.y, mine.tip.z, 2), 30000) } catch {} }
  dbg('  reEnter: back in my mine at y' + Math.floor(bot.entity.position.y) + ' (level ' + mine.level + ', ' + (mine.branches || 0) + ' branches done) - MINING, not re-digging')
  return true
}

// ONE organized branch mine for a DEEP ore (iron/gold/copper/...). Descends a single
// staircase to the iron band (~y16, mining.targetMineY) - relocating the entrance on
// water/lava/void instead of stalling - then drives a central corridor with perpendicular
// branches (classic 2-3-spaced branch mine: far more ore per hole than the old scattered
// shafts), torch-lit, with ore-in-the-walls bycatch. RE-ENTERS a persisted mine when one
// exists (spend the budget mining, not re-descending). Danger (mob closes / hp crashes) ->
// climb out and bail to the deployed survival reflexes. Bounded by count + a wall-clock
// deadline + a branch cap. Returns { gathered, reason }.
async function branchMine (bot, item, count, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const start = countItem(bot, item)
  const got = () => countItem(bot, item) - start
  const surfaceY = opts.surfaceY != null ? opts.surfaceY : Math.floor(bot.entity.position.y)
  const targetY = mining.targetMineY(surfaceY, {
    targetY: parseInt(process.env.IRON_TARGET_Y || '16', 10),
    hardFloor: parseInt(process.env.MINE_HARD_FLOOR || '5', 10)
  })
  const deadline = Date.now() + (opts.deadlineMs || 300000)
  const oreRe = new RegExp(String(item).replace(/^raw_/, '') + '_ore$')
  // Any depth at/below this is a WORTHWHILE iron level - branch-mine there rather than
  // burning relocations chasing the ideal targetY through cave-riddled terrain (env-tunable).
  const minIronY = parseInt(process.env.MIN_IRON_Y || '40', 10)
  const goodEnough = () => mining.worthMiningHere(bot.entity.position.y, { minIronY })
  const pickLow = parseInt(process.env.MINE_PICK_LOW || '20', 10)
  dbg('  branchMine: item=' + item + ' need=' + count + ' surfaceY=' + surfaceY + ' targetY=' + targetY + ' minIronY=' + minIronY)

  // SELF-SUFFICIENT TOOLING: keep a working pickaxe at depth. Re-tool BEFORE the held pick
  // breaks (while it can still mine the cobble a new pick needs) and only when no spare
  // exists. Returns whether we still have a working pick after the attempt. Never walks to a
  // surface table (that round-trip is the stranding bug). Called each junction + after descent.
  const keepPickReady = async () => {
    const bp = bestPick(bot)
    const spares = workingPickCount(bot) - (bp ? 1 : 0)
    if (mining.needReTool(bp ? bp.usesLeft : 0, spares, { low: pickLow })) {
      dbg('  branchMine: pick low (' + (bp ? bp.usesLeft : 0) + ' uses, ' + spares + ' spare) - re-tooling AT DEPTH, not climbing out')
      if (opts.say && !bp) say('pick\'s worn out - making a fresh one down here')
      await craftStonePickHere(bot, { isStopped })
    }
    return workingMiningPick(bot)
  }

  const persist = process.env.MINE_PERSIST !== '0'
  let corridorDir = opts.dirIdx || 0
  let mineRec = null
  let startBranches = 0

  // 0) RE-ENTER a remembered mine instead of re-digging the descent - the whole point on
  // cave terrain (a fresh descent ate the entire excursion, gathered:0). If a reachable mine
  // exists, walk in and pick up mining where we left off; only dig fresh if it's gone/flooded.
  if (persist && Math.floor(bot.entity.position.y) > targetY + 1 && !isStopped()) {
    const remembered = recallMine(bot, bot.entity.position, parseInt(process.env.MINE_REUSE_DIST || '80', 10))
    if (remembered) {
      if (opts.say) say('heading back to my mine to keep digging')
      if (await enterExistingMine(bot, remembered, { isStopped })) {
        mineRec = remembered; corridorDir = remembered.dirIdx || 0; startBranches = remembered.branches || 0
      } else { forgetMine(remembered) }
    }
  }

  // 1) DESCEND ONCE (only if we didn't re-enter), sited off the hut apron so the camp doesn't
  // get riddled with holes.
  if (!mineRec && Math.floor(bot.entity.position.y) > targetY + 1) {
    if (onHutApron(bot)) {
      const h = onHutApron(bot)
      const away = new Vec3(h.x + 12, bot.entity.position.y, h.z + 12)
      dbg('  branchMine: stepping off the hut apron before sinking the entrance')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 3), 20000) } catch {}
      if (onHutApron(bot)) { dbg('  branchMine: still on apron - not mining the doorstep'); return { gathered: 0, reason: 'too close to home to dig here' } }
    }
    if (opts.say) say('digging down to the iron level (~y' + targetY + ')')
    // the entrance = the surface top of this staircase (persisted so we re-enter here)
    const entrance = { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z), top: Math.floor(bot.entity.position.y) }
    let reached = false
    for (let reloc = 0; reloc < 4 && !reached && !isStopped() && Date.now() < deadline; reloc++) {
      const r = await digStaircaseDown(bot, targetY, { isStopped, dirIdx: reloc })
      if (r.reached) { reached = true; break }
      if (mineDanger(bot)) break
      // pick wore out on the way down -> re-tool HERE and keep descending (don't relocate/bail)
      if (!workingMiningPick(bot)) { if (await keepPickReady()) { reloc--; continue } else { dbg('  branchMine: pick broke mid-descent and cannot re-tool - stopping the descent'); break } }
      // GOOD-ENOUGH DEPTH (the live gap): a cave/void/water blocked the last stretch, but we're
      // already at a worthwhile iron depth (e.g. y28) - STOP relocating and MINE HERE instead
      // of chasing y16 through cave-riddled ground and returning empty. The hit cave is an
      // opportunity: it exposes ore and the branch loop's wall-bycatch works it.
      if (goodEnough()) { dbg('  branchMine: descent stopped at y=' + Math.floor(bot.entity.position.y) + ' (' + r.reason + ') - a workable iron depth, mining HERE not chasing y' + targetY); break }
      // still too shallow: relocate the entrance (sidestep) and retry a fresh staircase.
      dbg('  branchMine: descent blocked (' + r.reason + ') and still shallow (y=' + Math.floor(bot.entity.position.y) + ') - relocating the entrance')
      const p = bot.entity.position; const [sx, sz] = mining.DIRS[(reloc + 1) % 4]
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(Math.round(p.x + sx * 4), Math.round(p.z + sz * 4), 2), 12000) } catch {}
    }
    // Only bail if we NEVER got meaningfully below the surface; otherwise fall through and
    // branch-mine at whatever depth we reached. THE LIVE GAP (16:45, live base): it bailed at
    // y46 - an iron-viable depth, and SHALLOWER than the old y30 strip - because y46 > minIronY
    // (40) so goodEnough() was false. Iron spawns from ~y72 down, so any real descent is worth
    // mining. mineableWhenBlocked is the permissive floor for the blocked case: mine here if we
    // descended a real distance (>=12) or are below the iron ceiling (y52), never return empty.
    const mineableNow = () => mining.mineableWhenBlocked(bot.entity.position.y, surfaceY)
    if (!reached && !goodEnough() && !mineableNow()) {
      return { gathered: got(), reason: 'could not get below the surface to any iron level (water/lava/blocked descent, stuck at y' + Math.floor(bot.entity.position.y) + ')' }
    }
    if (!reached && !goodEnough()) {
      dbg('  branchMine: blocked short of y' + targetY + ' but at y' + Math.floor(bot.entity.position.y) + ' (descended ' + (Math.floor(surfaceY) - Math.floor(bot.entity.position.y)) + ') - iron-viable, MINING HERE not returning empty')
      if (opts.say) say('couldn\'t get all the way down, but there\'s iron at this depth - mining here')
    }
    // PERSIST the fresh mine so the NEXT excursion re-enters here (AMORTIZE the descent): even
    // if THIS excursion runs out of time right after descending, the staircase is banked and
    // the next one picks up mining immediately - never re-descend to 0 excursion after excursion.
    if (persist && Math.floor(bot.entity.position.y) < surfaceY - 6) {
      mineRec = rememberMine({ x: entrance.x, z: entrance.z, top: entrance.top, level: Math.floor(bot.entity.position.y), lx: Math.round(bot.entity.position.x), lz: Math.round(bot.entity.position.z), dirIdx: corridorDir, branches: 0, tip: bot.entity.position.floored() })
      dbg('  branchMine: persisted mine entrance ' + entrance.x + ',' + entrance.z + ' level y' + mineRec.level + ' - next excursion re-enters, no re-dig')
    }
  }

  // 2) BRANCH MINE at level: corridor + perpendicular branches, torch-lit.
  // Provision the tool kit HERE (at depth, both fresh-descent and re-entry paths): stone is
  // everywhere down here, so it can actually gather the cobble for spare picks + a table +
  // sticks - fixing the up-front "provisioned 0 spares" (surface had no stone). Mid-descent
  // breaks were already covered by keepPickReady (the staircase dig yields cobble).
  if (Math.floor(bot.entity.position.y) < surfaceY - 4) {
    try { await ensureMiningKit(bot, Math.max(0, Math.floor(surfaceY) - Math.floor(bot.entity.position.y)), { isStopped }) } catch (e) { dbg('  ensureMiningKit failed (' + e.message + ') - relying on depth re-tool') }
  }
  await ensureTorches(bot, 12)
  const L = mining.branchLayout(corridorDir, {
    branchLen: parseInt(process.env.MINE_BRANCH_LEN || '12', 10),
    spacing: parseInt(process.env.MINE_SPACING || '3', 10)
  })
  let branches = startBranches
  const maxBranches = startBranches + (opts.maxBranches || 30)
  while (got() < count && Date.now() < deadline && !isStopped() && branches < maxBranches) {
    if (mineDanger(bot)) {
      dbg('  branchMine: threat/hp down here - climbing out and handing off to the survival reflex')
      if (opts.say && branches < 2) say('mob down here - breaking off the mine to get clear')
      try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch {}
      return { gathered: got(), reason: 'broke off to survive a mob / low hp underground' }
    }
    // KEEP A WORKING PICK: re-tool at depth before the pick breaks. If it's gone AND we can't
    // make one down here (no cobble/sticks/planks/table), climb out CLEANLY and bail honestly -
    // never wedge deep with a dead pick waiting on a surface craft-regroup (the stranding bug).
    if (!await keepPickReady()) {
      dbg('  branchMine: no working pickaxe and cannot re-tool at depth - climbing out cleanly (not stranded)')
      if (opts.say) say('out of picks down here and can\'t make one - heading back up')
      try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch {}
      return { gathered: got(), reason: 'pickaxe gone and could not re-tool at depth - climbed out' }
    }
    // advance the main corridor `spacing`, then a junction: torch + left branch + right branch
    await mineTunnel(bot, item, L.spacing, L.corridorIdx, { isStopped })
    const junc = bot.entity.position.floored()
    if (branches % L.torchEvery === 0) await placeTorch(bot).catch(() => {})
    await mineTunnel(bot, item, L.branchLen, L.leftIdx, { isStopped })
    try { await gotoWithTimeout(bot, new goals.GoalBlock(junc.x, junc.y, junc.z), 15000) } catch {}
    if (got() >= count || isStopped()) break
    await mineTunnel(bot, item, L.branchLen, L.rightIdx, { isStopped })
    try { await gotoWithTimeout(bot, new goals.GoalBlock(junc.x, junc.y, junc.z), 15000) } catch {}
    try { await grabNearbyOre(bot, oreRe, 4, 6, { isStopped }) } catch {} // ore exposed in the junction walls
    branches++
    // BANK PROGRESS: record the branch count + corridor tip so the next excursion resumes at
    // the fresh face, not the staircase bottom (which would re-walk the open corridor).
    if (persist && mineRec) { try { updateMineProgress(mineRec, branches, junc) } catch {} }
    dbg('  branchMine: junction ' + branches + '/' + maxBranches + ' got=' + got() + '/' + count + ' y=' + Math.floor(bot.entity.position.y))
  }
  return { gathered: got(), reason: got() >= count ? 'done' : (Date.now() >= deadline ? 'out of time' : 'worked the branches') }
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
  let tgt = null; let best = opts.range || 24
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

// Find the nearest DIGGABLE DRY cell to shelter at - a standable surface cell whose column a
// safe night-pit can actually be dug into (solid ground, no lava/water below OR beside the
// shaft, and dry to stand on). ensureAshore gets us out of the water but often leaves us
// water-adjacent on every side, so every in-place pit hits the flooding guard and the shelter
// loops forever (live). This gives the flow somewhere to RELOCATE to. Returns a feet-cell
// Vec3 to walk to, or null when there's no diggable dry ground within `radius`.
async function findDiggableDryCell (bot, opts = {}) {
  const radius = opts.radius || 24
  if (!bot.entity) return null
  const mcData = require('minecraft-data')(bot.version)
  const GROUND_RE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mud|sand|red_sand|gravel|stone|deepslate|granite|diorite|andesite|tuff|clay|terracotta|netherrack|moss_block|snow_block|calcite)$/
  const ids = Object.values(mcData.blocksByName).filter(b => GROUND_RE.test(b.name)).map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 96 }) || []
  const nameAt = p => { const b = bot.blockAt(p); return b ? b.name : null }
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const cand = []
  for (const gp of found) {
    const feet = gp.offset(0, 1, 0); const head = gp.offset(0, 2, 0)
    // standable + dry to STAND on (no water in the feet/head cell or its horizontal neighbours)
    if (!shelterSite.feetCellDry(nameAt(feet), nameAt(head), SIDES.map(([dx, dz]) => nameAt(feet.offset(dx, 0, dz))))) continue
    // a safe pit can be dug straight down from here (solid, no fluid below/beside the shaft)
    const below = nameAt(gp); const below2 = nameAt(gp.offset(0, -1, 0))
    if (!shelterSite.shelterDiggable(below, below2, SIDES.map(([dx, dz]) => nameAt(gp.offset(dx, 0, dz))))) continue
    // must be real natural ground the anti-grief dig will actually break (not a player block)
    const gb = bot.blockAt(gp); if (gb && !canBreakNaturally(gb)) continue
    // never relocate the pit onto our own hut apron (defaces the doorstep)
    if (onHutApron(bot, feet)) continue
    cand.push({ x: feet.x, y: feet.y, z: feet.z })
  }
  const ranked = shelterSite.rankByDistance(cand, bot.entity.position)
  return ranked.length ? new Vec3(ranked[0].x, ranked[0].y, ranked[0].z) : null
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
// DANGER WHILE MINING: a cave hostile has closed to melee/bow range, or hp is crashing.
// The idle flee/defend reflexes can't help mid-dig (the bot is committed inside bot.dig()
// awaits, not the pathfinder), so the tight dig loops + the gather loop poll THIS and bail
// to a survival reaction. Naked deep gearup mining died at ~1hp three times (verified live:
// y39-40, zombie in melee + skeleton firing, flee:false) - this is the missing reflex.
function mineDanger (bot) { return nearHostile(bot, 6) || (bot.health ?? 20) < 12 }
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
    // MY HUT IS THE SHELTER: at the doorstep of the bot's own hut, step INSIDE (door-
    // assist) instead of digging a pit beside the walls; already inside, just wait the
    // night out - walls and roof beat any hole in the ground, and pitting here is how
    // the interior kept getting defaced (dirt piles, floor holes - live, repeatedly).
    if (!insideOwnStructure(bot)) {
      const hutNear = onHutApron(bot)
      if (hutNear) {
        try {
          const nav = require('./navigate.js') // lazy - navigate requires provision the same way
          await nav.navigateTo(bot, new goals.GoalNear(hutNear.x + 2, hutNear.y + 1, hutNear.z + 2, 1), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 0, water: 1, nudge: 1 }, label: 'shelter-home' })
        } catch (e) { dbg('shelter: could not get inside my hut (' + e.message + ')') }
      }
    }
    if (insideOwnStructure(bot)) {
      dbg('shelter: inside my own hut - waiting out the night, no digging')
      say('holed up at home for the night')
      const dl = Date.now() + 600000
      const hpIn = bot.health || 20
      let hurtInside = false
      while (Date.now() < dl && !isStopped()) {
        // hold through the DUSK HEAD-START too (shelterNeeded fires at 12200, isNight at
        // 13000): breaking on "!isNight" alone made this return success instantly at dusk,
        // so the 5s reflex re-entered forever - the "waiting out the night" log spam (live)
        if (!shelterNeeded(bot) && !isNight(bot) && !nearHostile(bot, 10)) break
        if ((bot.health || 20) < hpIn - 3) { dbg('shelter: taking damage INSIDE the hut - releasing shelter to FIGHT'); hurtInside = true; break }
        if (inWaterNow(bot)) { dbg('shelter: hut interior flooding - bailing'); hurtInside = true; break }
        await new Promise(r => setTimeout(r, 3000))
      }
      if (!hurtInside) return true
      // Hurt while holed up inside the hut (an enderman teleported in, a mob at the door):
      // do NOT abandon the walls to dig a pit - RELEASE the shelter so the now-ungated
      // flee/defend reflexes take over. Armored, inside its own walls, the bot wins the
      // fight; a creeper it flees. Standing still absorbing hits killed it (live: enderman
      // -> 'attack suppressed' -> dead). restUntilSafe re-shelters once the threat clears.
      if (inWaterNow(bot)) { /* flooding: fall through to relocate/pit below */ } else return false
    }
    // Near (but not in) the hut with no way inside: dig AWAY from the walls/apron, never
    // against them - same rule as the build footprint below.
    if (onHutApron(bot)) {
      const h = onHutApron(bot)
      const away = { x: h.x + 12, z: h.z + 12 }
      dbg('shelter: on my hut apron - stepping clear to ' + away.x + ',' + away.z + ' before digging')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 2), 15000) } catch {}
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
    // Dig the pit HERE; if the flooding/obstruction guard blocks it, RELOCATE to the nearest
    // diggable DRY cell and retry (bounded). ensureAshore only gets us OUT of the water - on a
    // river bank the bot can be ashore yet water-adjacent on every side, so an in-place-only
    // pit hits the side-liquid guard forever ("water beside the next cell" -> "NO-OP" every
    // ~4s, bricked the bot, live). Relocating to genuinely diggable dry ground is the fix.
    let dug = 0
    let surfaceY = Math.floor(bot.entity.position.y)
    let shaft = bot.entity.position.floored()
    const RELOCATE_TRIES = 3
    for (let attempt = 0; attempt <= RELOCATE_TRIES && dug < 1 && !isStopped(); attempt++) {
      // CENTER on the feet cell. Digging from a cell edge (x.5/z.5) digs the column under
      // floored(feet) while the body stays supported by the NEIGHBOUR block - the bot opens a
      // perfect pit and stands beside it with the "cap" aimed at thin air (every 'ducked into
      // a hole' night death; reproduced at x=-330.5: "no solid neighbour to place against").
      try { const f0 = bot.entity.position.floored(); await gotoWithTimeout(bot, new goals.GoalBlock(f0.x, f0.y, f0.z), 4000) } catch {}
      surfaceY = Math.floor(bot.entity.position.y)
      shaft = bot.entity.position.floored() // the column we dig - we must END UP inside it
      // 1) dig straight down 2, keeping the blocks (need one to cap with). NEVER dig into a
      //    void/lava/water below, and ONLY natural terrain (never a player build block).
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
      if (dug >= 1) break
      // Blocked in place (water-adjacent / obstruction). Walk to the nearest diggable dry cell
      // and try again - PROGRESS instead of the 4s NO-OP spin. Widen the search each retry.
      if (attempt < RELOCATE_TRIES) {
        const dry = await findDiggableDryCell(bot, { radius: 20 + attempt * 12 })
        if (!dry) { dbg('shelter: no diggable dry ground within reach - cannot pit'); break }
        dbg('shelter: cannot dig here (water/obstruction) - relocating to diggable dry ground at ' + dry.toString() + ' (try ' + (attempt + 1) + '/' + RELOCATE_TRIES + ')')
        if (opts.say && attempt === 0) opts.say('ground here is too wet to dig into - moving to dry ground to shelter')
        try { await gotoWithTimeout(bot, new goals.GoalBlock(dry.x, dry.y, dry.z), 20000) } catch (e) { dbg('shelter: relocate walk failed (' + e.message + ')') }
        if (inWaterNow(bot)) { try { await ensureAshore(bot, isStopped) } catch {} }
      }
    }
    if (dug < 1) { dbg('shelter: NO-OP (dug 0 after ' + RELOCATE_TRIES + ' relocation tries) - caller must do something else'); return false } // genuinely nowhere diggable+dry nearby
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
  let i = list.indexOf(entry)
  // callers hold COPIES (resources.js maps/spreads the entries), so reference identity
  // alone never matched for them - fall back to coordinate identity
  if (i < 0) i = list.findIndex(e => e.x === entry.x && e.y === entry.y && e.z === entry.z)
  if (i >= 0) { list.splice(i, 1); saveWorldMem() }
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
// ---- SELF-STRUCTURE integrity + declutter (self-structure-model-design.md) ----------
// The hut anchor entry (infra.hut[0]), or null. The model keys off this min corner.
function hutAnchor () { return (listInfra('hut')[0]) || null }
// A world-read closure for the hut-model's pure functions.
function hutReader (bot) { return (x, y, z) => bot.blockAt(new Vec3(x, y, z)) }

// A standable FREE interior cell (floor-level, schema-correct 4x4, threshold excluded),
// nearest to `near` (default: the bot). This is the ONLY sanctioned way to unstick INSIDE
// the hut - step here, NEVER pillar dirt through the roof. Returns a Vec3 or null.
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

// REGISTRY INTEGRITY: reconcile the infra registry against the WORLD so the bot's model of
// its own home matches reality. The live registry was garbage (12 crafting_table entries,
// 7 furnaces, 0 beds for a bed that exists) because nothing pruned dead/duplicate cells.
// For every kind: dedupe exact cells and DROP entries whose loaded cell no longer holds
// the block (unloaded/unknown kept). Then re-seed from what physically stands INSIDE the
// hut (the authoritative count) so the true stations are always registered - including the
// bed (also mirrored into m.bed / knownBed, the spawn anchor). Returns a summary.
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

// INTERIOR CLEANUP with a VERIFIED postcondition: dig every stray filler block in the
// interior (floor piles + head-height pillar remnants), remove DUPLICATE in-hut stations
// (keep one per kind), fill floor holes, and RE-RUN until a fresh world read confirms the
// interior is clean - not best-effort. Uses the self-structure model to know stray vs
// legit. Operator-triggerable (the `huttidy` command) to fix the current dirty hut.
// Returns { ok, passes, remaining, dug, removedDupes }.
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

// A station of `kind` physically standing in the hut interior (world scan, not the lying
// registry), or null. The authoritative "do I already have one inside" check.
function stationInHut (bot, kind, hut) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const cells = hutModel.stationCells(hut, hutReader(bot))[kind] || []
  return cells.length ? new Vec3(cells[0].x, cells[0].y, cells[0].z) : null
}

// Where to place a NEW station of `kind` inside the hut - a free interior FLOOR cell (Vec3),
// or null when `desired` of that kind already stand (never duplicate) or the interior is
// full. The placement guard the ensure*/furnish flows consult so they stop re-duplicating.
function stationSlot (bot, kind, desired = 1, hut) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const c = hutModel.stationSlot(hut, hutReader(bot), kind, desired)
  return c ? new Vec3(c.x, c.y, c.z) : null
}

// SELF-HEALING hut maintenance for the camp pass: reconcile the registry against the world,
// then tidy the interior IFF a cheap model scan says it's dirty (stray filler / duplicate
// station / floor hole) - an early no-op when the hut is already clean, so it's safe to run
// every pass. Returns { clean } or the cleanup result. Gated by the caller's isStopped.
async function maintainHut (bot, hut, opts = {}) {
  hut = hut || hutAnchor()
  if (!hut) return { skipped: 'no hut' }
  try { reconcileInfra(bot) } catch (e) { dbg('maintainHut: reconcile failed (' + e.message + ')') }
  const read = hutReader(bot)
  let strays, st, holes
  try { strays = hutModel.strayCells(hut, read); st = hutModel.stationCells(hut, read); holes = hutModel.floorHoles(hut, read) } catch (e) { dbg('maintainHut: scan failed (' + e.message + ')'); return { skipped: e.message } }
  const dirty = strays.length || (st.table.length > 1) || (st.furnace.length > 1) || holes.length
  if (!dirty) { dbg('maintainHut: interior already clean - no-op'); return { clean: true } }
  dbg('maintainHut: interior dirty (stray=' + strays.length + ' tables=' + st.table.length + ' furnaces=' + st.furnace.length + ' holes=' + holes.length + ') - tidying')
  return await cleanupHutInterior(bot, hut, opts)
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
// GEAR-UP CONVERGENCE (persisted): the iron/armor bootstrap must converge, not flail.
// Every fruitless attempt (no new piece worn, no net iron gained) widens a back-off
// window so the same death-march doesn't re-run on every resume pass; any real progress
// resets it. Survives restarts - the flailing was worst right after respawns.
function gearupState () { return loadWorldMem().gearup || { fails: 0, until: 0 } }
function gearupResult (progressed) {
  const m = loadWorldMem()
  const g = m.gearup = m.gearup || { fails: 0, until: 0 }
  if (progressed) { g.fails = 0; g.until = 0 } else { g.fails++; g.until = Date.now() + Math.min(45, g.fails * 10) * 60000 }
  saveWorldMem()
  if (!progressed) dbg('gearup: fruitless attempt #' + g.fails + ' - backing off ' + Math.min(45, g.fails * 10) + ' min')
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
// Every rememberBed call site follows an actual spawn-setting action (a sleep or a
// day bed-use), so it doubles as the "spawn last asserted" timestamp ensureSpawnBed
// keys off.
function rememberBed (pos) { const m = loadWorldMem(); m.bed = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), at: Date.now() }; m.bedAssertAt = Date.now(); delete m.spawnSuspect; saveWorldMem() }
function knownBed () { return loadWorldMem().bed || null }
function forgetBed () { const m = loadWorldMem(); delete m.bed; saveWorldMem() }

// SPAWN-SUSPECT flag, PERSISTED: a respawn landed far from the remembered bed, so the
// server-side anchor is wrong (bed broken/obstructed) - every death is a world-spawn
// carousel until a bed is re-asserted. The old flag lived in commands.js RAM and died
// with every restart/deploy mid-crisis (the overnight spiral straddled several). Cleared
// by rememberBed (every real spawn-setting action goes through it).
function setSpawnSuspect (v) { const m = loadWorldMem(); if (v) m.spawnSuspect = Date.now(); else delete m.spawnSuspect; saveWorldMem() }
function isSpawnSuspect () { return !!loadWorldMem().spawnSuspect }

// SPAWN GUARANTEE: make sure the respawn anchor really is the (hut) bed. USE the bed -
// sets the spawn even at day - whenever we're near it and haven't asserted it recently
// (opts.force skips the freshness check; a respawn far from the remembered bed means the
// server spawn is WRONG - bed broken/obstructed/moved - and every death becomes a world-
// spawn carousel until this runs). If the remembered bed is gone, scan close (rebuilds
// shift it a cell), else lay a fresh one in the hut. Bounded, honest return.
async function ensureSpawnBed (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (!bot.entity) return false
  const m = loadWorldMem()
  const bed = knownBed()
  const hut0 = listInfra('hut')[0]
  if (!bed) {
    // no bed memory at all - the hut path is the only play
    if (!hut0) return false
    const r = await ensureHutBed(bot, new Vec3(hut0.x, hut0.y, hut0.z), opts).catch(() => 'fail')
    return r === 'present' || r === 'placed'
  }
  if (!opts.force && m.bedAssertAt && Date.now() - m.bedAssertAt < 3600 * 1000) return true // asserted within the hour
  // PREFER THE HUT BED: a remembered bed far from the hut is a stale anchor (the overnight
  // carousel re-learned a bed at world spawn and kept "asserting" THERE) - never keep it
  // silently while a home hut exists. Re-anchor at the hut; the far bed is only an honest
  // fallback when the hut can't take a bed right now (no bed item - wool is operator-supplied).
  if (hut0 && Math.hypot(bed.x - (hut0.x + 2), bed.z - (hut0.z + 2)) > 24) {
    dbg('spawn: remembered bed ' + bed.x + ',' + bed.z + ' is far from my hut at ' + hut0.x + ',' + hut0.z + ' - re-anchoring at the hut instead')
    const r = await ensureHutBed(bot, new Vec3(hut0.x, hut0.y, hut0.z), opts).catch(() => 'fail')
    if (r === 'present' || r === 'placed') return true
    dbg('spawn: hut bed unavailable (' + r + ') - falling back to the FAR bed at ' + bed.x + ',' + bed.z + ' (better than world spawn)')
  }
  const d = Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z)
  if (d > (opts.maxTrek != null ? opts.maxTrek : 120)) { dbg('spawn: bed too far to assert from here (' + Math.round(d) + 'b)'); return false }
  if (d > 6) { try { await walkStaged(bot, bed.x, bed.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {} }
  let bb = bot.blockAt(new Vec3(bed.x, bed.y, bed.z))
  if (!bb || !/_bed$/.test(bb.name)) {
    const md = require('minecraft-data')(bot.version)
    const ids = Object.values(md.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
    const near = bot.findBlock({ matching: ids, maxDistance: 12 })
    if (near) { bb = near; dbg('spawn: remembered bed shifted - found one at ' + near.position.toString()) }
    else {
      dbg('spawn: remembered bed is GONE - laying a new one')
      forgetBed()
      const hut = listInfra('hut')[0]
      if (hut) { const r = await ensureHutBed(bot, new Vec3(hut.x, hut.y, hut.z), opts).catch(() => 'fail'); return r === 'present' || r === 'placed' }
      return false
    }
  }
  if (bot.entity.position.distanceTo(bb.position) > 2.5) {
    try {
      const nav = require('./navigate.js') // door-assist: the bed lives indoors
      await nav.navigateTo(bot, new goals.GoalNear(bb.position.x, bb.position.y, bb.position.z, 2), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 1, water: 1, nudge: 1 }, label: 'spawn-bed' })
    } catch (e) { dbg('spawn: cannot reach the bed (' + e.message + ')'); return false }
  }
  try {
    if (isNight(bot)) { if (await sleepInBedHere(bot, opts)) return true } // a real sleep sets it
    await bot.activateBlock(bb) // day: right-clicking the bed sets the respawn point
    rememberBed(bb.position)
    dbg('spawn: asserted at the bed ' + bb.position.toString())
    return true
  } catch (e) { dbg('spawn: bed use failed (' + e.message + ')'); return false }
}

// WRONG-ANCHOR RECOVERY, survival tier: the server respawn anchor is lost or far (the
// world-spawn carousel - every death dropped the bot ~430 blocks from home, and it could
// never re-assert because the re-assert only ran "when home"). Getting home and re-
// asserting the hut bed IS the goal here, above build/gather/gear: long-legged trek
// straight to the remembered bed (or the hut), then a FORCED ensureSpawnBed. No 120-block
// maxTrek cop-out - this is exactly the "too far" case. Honest return; the caller retries
// on the next respawn (the persisted spawn-suspect flag survives deaths and restarts).
async function recoverSpawnAnchor (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const bed = knownBed()
  const hut = listInfra('hut')[0]
  // aim at the hut when it exists (the bed we want to anchor); a lone far bed otherwise
  const tx = hut ? hut.x + 2 : (bed ? bed.x : null)
  const tz = hut ? hut.z + 2 : (bed ? bed.z : null)
  if (tx == null) { dbg('spawn-recovery: no hut or bed remembered - nowhere to anchor'); return false }
  const dist = () => Math.hypot(tx - bot.entity.position.x, tz - bot.entity.position.z)
  if (dist() > 6) {
    say(`my spawn point is wrong - heading home (${Math.round(dist())}b) to fix it before anything else`)
    dbg('spawn-recovery: trekking home ' + Math.round(dist()) + 'b to re-anchor the spawn')
    for (let leg = 0; leg < 3 && dist() > 6 && !isStopped(); leg++) {
      try { await walkStaged(bot, tx, tz, { isStopped, range: 5, timeoutMs: 300000 }) } catch (e) { dbg('spawn-recovery: trek leg failed (' + e.message + ')') }
    }
  }
  if (dist() > 12) { dbg('spawn-recovery: could not get home (still ' + Math.round(dist()) + 'b out) - will retry next respawn'); return false }
  const ok = await ensureSpawnBed(bot, { ...opts, force: true, maxTrek: 1e9 })
  dbg('spawn-recovery: ' + (ok ? 'anchor RESTORED at the bed' : 'home but could NOT re-anchor (no usable bed)'))
  return ok
}

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
  // SLEEP-VIABILITY GATE (the "sleep failed (it's not night and it's not a thunderstorm)"
  // spam, live 07-13): bot.sleep only works from timeOfDay ~12542 (or in a thunderstorm),
  // but the shelter reflex fires at the 12200 dusk head-start - so every attempt in that
  // window failed LOUDLY on the reflex's 5s cadence, night after night. Wait QUIETLY at
  // the bed for the sleepable window instead of hammering the server; and plain daytime
  // rain (no thunder) can never become sleepable soon - bail once, silently.
  const canSleepNow = () => ((bot.thunderState || 0) > 0) || (bot.time && bot.time.timeOfDay >= 12542 && bot.time.timeOfDay <= 23458)
  if (!canSleepNow()) {
    const tod = bot.time ? bot.time.timeOfDay : -1
    if (tod >= 11800 && tod < 12542) {
      dbg('nightRest: at the bed ahead of sleep-time (timeOfDay ' + tod + ') - waiting quietly for nightfall')
      if (bot.entity.position.distanceTo(bed.position) > 2.5) { try { await gotoWithTimeout(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 20000) } catch {} }
      const dl = Date.now() + 90000
      while (!canSleepNow() && Date.now() < dl && !isStopped()) {
        if (nearHostile(bot, 10) && underArmored(bot)) { dbg('nightRest: hostiles closing during the dusk wait - pitting instead'); return false }
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    if (!canSleepNow()) { dbg('nightRest: bed here but sleep is impossible right now (timeOfDay ' + (bot.time ? bot.time.timeOfDay : '?') + ', no thunder) - not hammering it'); return false }
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

async function fishForFood (bot, { isStopped = () => false, say = () => {}, target = 6, home, scout = false } = {}) {
  if (hasSolidCeiling(bot, 12)) { dbg('  fishing: underground - not here'); return false }
  const mcData = require('minecraft-data')(bot.version)
  const edible = () => (bot.inventory ? bot.inventory.items() : []).filter(i => mcData.foodsByName && mcData.foodsByName[i.name] && !/rotten|spider_eye|poisonous/.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (!await ensureFishingRod(bot, { isStopped, home })) return false
  const waterId = mcData.blocksByName.water.id
  const findWaters = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 }) || []) // sample WIDE: the nearest N blocks of a lake are all submerged and fail the air-above filter
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
  let waters = findWaters()
  if (!waters.length) {
    // no water in sight - a REMEMBERED pond first (shared with the wheat farm), then, in a
    // real famine (opts.scout), a bounded scout for one. Water is the guaranteed food path.
    const known = recallInfra('water', bot.entity.position, 160)
    if (known && !isStopped()) {
      dbg('  fishing: walking to remembered water at ' + known.x + ',' + known.z)
      try { await walkStaged(bot, known.x, known.z, { isStopped, range: 6, timeoutMs: 120000 }) } catch {}
      waters = findWaters()
    }
    if (!waters.length && scout && !isStopped()) waters = await scoutForWater(bot, { isStopped })
  }
  if (!waters.length) { dbg('  fishing: no surface water within 48' + (scout ? ' (scout came up dry too)' : '')); return false }
  const w = waters[0]
  rememberInfra('water', { x: w.x, y: w.y, z: w.z }) // the farm + future famines trek straight back
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

// ---- SECURE FOOD: the ONE "get me fed" routine -------------------------------------
// Every starving flow funnels here (gather loop, travel legs, smelt rotations, material
// rounds, and the body's food-crisis reflex). A player's order of ops: eat what you
// carry -> raid the pantry (bank) -> cook -> hunt what's visible -> harvest the farm ->
// fish -> go LOOKING for animals -> and if the land is truly barren, hole up at home
// instead of working on at 1hp. Starvation itself stops at half a heart - every actual
// starve-death was chip damage taken while it kept working (verified live, repeatedly).
const RISKY_EAT = /^(rotten_flesh|chicken|spider_eye|poisonous_potato|pufferfish)$/
// One EATING policy (commands.eatFood delegates here): most filling SAFE food first;
// risky food only when starving (<=6) or critically hurt with hunger already low.
async function eatBestFood (bot) {
  if (bot.food != null && bot.food >= 20) return 'not hungry'
  const mcData = require('minecraft-data')(bot.version)
  const foods = (mcData && mcData.foodsByName) || {}
  const items = bot.inventory ? bot.inventory.items() : []
  const edible = items.filter(i => foods[i.name]).sort((a, b) => {
    const risk = (RISKY_EAT.test(a.name) ? 1 : 0) - (RISKY_EAT.test(b.name) ? 1 : 0)
    if (risk) return risk
    return (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0)
  })
  if (!edible.length) return 'no food in inventory'
  const food = edible[0]
  if (RISKY_EAT.test(food.name) && bot.food > 6 && !((bot.health ?? 20) <= 8 && bot.food < 18)) return 'only risky food left - holding out'
  await bot.equip(food, 'hand')
  await bot.consume()
  return `ate ${food.name} (food ${bot.food})`
}

// Eat down the pack until reasonably full or out of (safe) food - one bite of the chain's
// hard-won meat doesn't stop the next starve 10 minutes later.
async function eatUp (bot) {
  for (let i = 0; i < 6; i++) {
    if (bot.food == null || bot.food >= 18) return
    const r = await eatBestFood(bot).catch(() => 'err')
    if (!/^ate /.test(r)) return
  }
}

let _securingFood = false
function isSecuringFood () { return _securingFood }
async function secureFood (bot, opts = {}) {
  if (_securingFood) return false
  _securingFood = true
  try { return await secureFoodInner(bot, opts) } finally { _securingFood = false }
}
async function secureFoodInner (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const home = opts.home || null
  const cookIfRaw = async () => { try { if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped }) } catch {} }
  const fedEnough = () => (bot.food != null && bot.food > (opts.threshold != null ? opts.threshold : 12)) || foodCount(bot) >= 3
  if (fedEnough()) return true
  dbg('secureFood: food=' + bot.food + ' packFood=' + foodCount(bot))
  // 0) eat what we carry
  await eatUp(bot)
  if (fedEnough()) return true
  // 1) the pantry: withdraw banked food (lazy require - resources requires provision at load)
  try {
    const got = await require('./resources.js').ensureFood(bot, { near: home, threshold: 20, minPack: 1, maxDist: 64 })
    if (got) { dbg('secureFood: withdrew ' + got + ' food from the bank'); await eatUp(bot) }
  } catch (e) { dbg('secureFood: bank check failed (' + e.message + ')') }
  if (fedEnough()) return true
  // 2) raw meat in the pack + a furnace in reach -> cook (3x the food value of raw)
  await cookIfRaw(); await eatUp(bot)
  if (fedEnough()) return true
  // 3) hunt what's visible (batch - one kill barely dents the deficit)
  try { for (let k = 0; k < 4 && foodCount(bot) < 5 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped, range: 32 })) break } } catch {}
  await cookIfRaw(); await eatUp(bot)
  if (fedEnough() || isStopped()) return fedEnough()
  // 4) the farm (harvest what's ripe / plant one by remembered water)
  try {
    if (!await tendWheatFarm(bot, { isStopped, say })) {
      if (home) await ensureWheatFarm(bot, home, { isStopped, say, avoid: opts.avoid })
    }
  } catch (e) { dbg('secureFood: farm fallback failed (' + e.message + ')') }
  await eatUp(bot)
  if (fedEnough()) return true
  // 5) fish - works anywhere with surface water (scouts for a pond in a real crisis)
  try { await fishForFood(bot, { isStopped, say, home, scout: bot.food <= 4 }) } catch (e) { dbg('secureFood: fishing failed (' + e.message + ')') }
  await eatUp(bot)
  if (fedEnough()) return true
  // 6) crisis: go LOOKING for animals - the ground right here is eaten bare
  if (bot.food <= 4 && !isStopped() && opts.scoutHunt !== false && !isNight(bot)) {
    try { await scoutHunt(bot, { isStopped, say, maxMs: opts.scoutMs || 180000 }) } catch (e) { dbg('secureFood: scout-hunt failed (' + e.message + ')') }
    await cookIfRaw(); await eatUp(bot)
    if (fedEnough()) return true
  }
  // 7) famine hold: NOTHING panned out - get home/indoors and sit it out (bounded; the
  // caller or the crisis reflex re-runs the whole chain later).
  if (opts.canHold && (bot.food ?? 20) <= 1 && !isStopped()) { try { await famineHold(bot, { isStopped, say }) } catch {} }
  return foodCount(bot) > 0
}

// Walk expanding legs looking for food animals. Remembers where it finds them
// ('pasture' infra) so the next famine treks straight back instead of re-searching.
async function scoutHunt (bot, { isStopped = () => false, say = () => {}, maxMs = 180000 } = {}) {
  const start = bot.entity.position.clone()
  const deadline = Date.now() + maxMs
  const seesFood = () => Object.values(bot.entities || {}).some(e => e && e.position && FOOD_ANIMALS.test((e.name || '').toLowerCase()))
  const legs = []
  const known = recallInfra('pasture', start, 200)
  if (known) legs.push({ x: known.x, z: known.z })
  for (const r of [40, 80, 120]) for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) legs.push({ x: start.x + dx * r, z: start.z + dz * r })
  say('nothing to eat around here - going to find animals')
  dbg('scoutHunt: searching from ' + Math.round(start.x) + ',' + Math.round(start.z) + (known ? ' (remembered pasture first)' : ''))
  for (const leg of legs) {
    if (isStopped() || Date.now() > deadline) break
    if (isNight(bot)) { dbg('scoutHunt: night fell - not roaming the dark for dinner'); break }
    try { await walkStaged(bot, leg.x, leg.z, { isStopped, range: 8, timeoutMs: 60000 }) } catch {}
    if (seesFood()) {
      rememberInfra('pasture', bot.entity.position)
      dbg('scoutHunt: animals near ' + Math.round(bot.entity.position.x) + ',' + Math.round(bot.entity.position.z) + ' - remembered as pasture')
      let kills = 0
      try { for (let k = 0; k < 4 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped, range: 32 })) break; kills++ } } catch {}
      if (kills > 0) return true
    }
  }
  dbg('scoutHunt: no animals found (searched ~120 blocks out)')
  return false
}

// Nothing edible anywhere: retreat home and WAIT instead of dying to chip damage at 1hp.
// Inside the own hut = mob-safe indefinitely. Bounded so the food chain gets retried.
async function famineHold (bot, { isStopped = () => false, say = () => {} } = {}) {
  const hut = listInfra('hut')[0] || null
  const bed = knownBed()
  const target = hut ? { x: hut.x + 2, y: hut.y + 1, z: hut.z + 2 } : bed
  if (target && bot.entity) {
    const d = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
    if (d > 4 && d < 250) {
      say("i'm starving and the land is bare - heading home to hole up")
      try { await walkStaged(bot, target.x, target.z, { isStopped, range: 6, timeoutMs: 180000 }) } catch {}
    }
    if (hut && !insideOwnStructure(bot) && Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z) <= 12) {
      try {
        const nav = require('./navigate.js')
        await nav.navigateTo(bot, new goals.GoalNear(target.x, target.y, target.z, 1), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 1, water: 1, nudge: 1 }, label: 'famine-home' })
      } catch (e) { dbg('famineHold: could not get indoors (' + e.message + ')') }
    }
  }
  const indoors = !!insideOwnStructure(bot)
  dbg('famineHold: holding ' + (indoors ? 'inside my hut' : 'where i am') + ' (food=' + bot.food + ')')
  say('waiting it out at home - too weak to work safely')
  const dl = Date.now() + (indoors ? 480000 : 180000)
  while (Date.now() < dl && !isStopped()) {
    if (foodCount(bot) > 0 || (bot.food ?? 0) > 4) break
    // an animal wandered into range -> release the hold, the chain re-runs
    if (Object.values(bot.entities || {}).some(e => e && e.position && FOOD_ANIMALS.test((e.name || '').toLowerCase()) && e.position.distanceTo(bot.entity.position) <= 24)) break
    if (isNight(bot) && bed && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 8) { try { await sleepInBedHere(bot, { say, isStopped }) } catch {} }
    await new Promise(r => setTimeout(r, 5000))
  }
  return foodCount(bot) > 0
}

// Bounded water scout: 4 cardinal legs x expanding radius, scanning for surface water at
// each stop. Feeds BOTH fishing and the wheat farm (found ponds land in 'water' memory).
async function scoutForWater (bot, { isStopped = () => false, maxMs = 150000 } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const waterId = mcData.blocksByName.water.id
  const start = bot.entity.position.clone()
  const deadline = Date.now() + maxMs
  const surface = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 32 }) || [])
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
  for (const r of [48, 96]) {
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      if (isStopped() || Date.now() > deadline) return []
      try { await walkStaged(bot, start.x + dx * r, start.z + dz * r, { isStopped, range: 10, timeoutMs: 45000 }) } catch {}
      const w = surface()
      if (w.length) { rememberInfra('water', { x: w[0].x, y: w[0].y, z: w[0].z }); dbg('  water scout: surface water at ' + w[0].x + ',' + w[0].z); return w }
    }
  }
  dbg('  water scout: no surface water within ~96 blocks')
  return []
}

// ---- SCAFFOLD TEARDOWN: the pathfinder pillars up to tall canopies and abandons the
// dirt towers (operator: "a massive mess"). The patch layer remembers every self-placed
// block; after a harvest, ride the tower back down and pocket the dirt.
async function cleanupScaffold (bot, around, { isStopped = () => false } = {}) {
  // Registry-driven (bot/scaffold.js) + the legacy trail for towers placed before the
  // registry existed. Away from builds only (alsoTrail sweeps ALL own placements).
  const removed = await scaffold.teardown(bot, around, { isStopped, radius: 10, max: 24, alsoTrail: true })
  if (removed) await collectDrops(bot, 6)
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
  const maxFails = opts.maxShelterFails || 4
  let waited = false; let fails = 0
  while ((isNight(bot) || shelterNeeded(bot)) && underArmored(bot) && !isStopped() && bot.entity) {
    // HOLDING must never mean holding UNDERWATER - the 4s waits between failed rest
    // attempts are exactly where the bot drowned (test server, in its flooded basin)
    if (inWaterNow(bot)) { try { await ensureAshore(bot, isStopped) } catch {} }
    if (!isResting()) {
      let ok = false
      try { ok = await nightRest(bot, opts) } catch {}
      if (ok) { waited = true; fails = 0; continue }
      // nightRest FAILED to shelter (couldn't dig even after relocating, and no reachable
      // bed). Do NOT spin in place forever (the live 4s NO-OP loop): after maxFails, hand
      // back HONESTLY so the CALLER relocates the whole job somewhere it CAN shelter, rather
      // than re-digging the same wet spot. Bounded progress beats an unbounded hold.
      if (++fails >= maxFails) { dbg('restUntilSafe: could not shelter after ' + fails + ' tries (no diggable dry ground / no bed reachable) - handing back so the caller can relocate'); return false }
    }
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
    if (scaffold.isScaffold(gp)) continue // registry outlives the 30-min trail (6h) - old towers aren't ground either
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
  // Is the roam anchor sitting ON the bot's own hut? Then it's UN-diggable (the apron/
  // structure no-dig guard refuses every shaft there). A strip gather anchored at the hut
  // used to bounce forever: strip out 28b -> shaft fails -> "return home to strip" -> hut
  // apron refuses -> wander out -> repeat, minutes of walking, mined=0 (verified live).
  // Knowing the anchor is un-diggable up front, we NEVER trek back to it to strip - we work
  // the ore field where we are instead.
  const homeUndiggable = listInfra('hut').some(h => Math.hypot(h.x - home.x, h.z - home.z) <= 6)
  if (homeUndiggable) dbg('  gather: anchor is on my hut (no-dig) - will strip the ore field, not trek back home')
  // Wall-clock deadline: even a legit strip-mine run must end (bounded so the BUILD phase runs).
  const deadline = Date.now() + (opts.deadlineMs || Math.min(480000, 120000 + count * 4000))
  const timedOut = () => Date.now() > deadline
  // Whether this resource can be reached by digging DOWN (stone/ore under the surface).
  // Plains/grassland have none exposed, so instead of wandering forever we mine a shaft.
  const canStrip = sources.some(s => /stone|deepslate|cobble|granite|diorite|andesite|tuff|_ore$|ancient_debris/.test(s))
  // ORE gather (iron/gold/copper/redstone/...): the target ore is DEEP, not at the
  // stone-just-under-grass layer. Iron in 1.18+ follows a triangular distribution that's
  // sparse above ~y48 and common toward y30; a 16-block depth cap floored strips at y50
  // where 16-block tunnels struck ZERO iron (verified live: 3 gearups, mined=0 across
  // y54-60). Ore gathers therefore dig DEEPER (down to the STRIP_FLOOR, still the hard
  // safety floor), run more shafts, and cut longer tunnels so a vein is actually hit.
  const deepOre = sources.some(s => /_ore$/.test(s)) || /^raw_(iron|gold|copper)$|^(redstone|lapis_lazuli|diamond|emerald)$/.test(item)
  const MAX_STRIP = deepOre ? 10 : 5 // shafts per gather before giving up (ore needs several to reach + work the deep levels)
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
  // ABSOLUTE floor: never mine/dig below this Y, so a runaway descent can't reach the
  // deep lava layer no matter what. Well above 1.21 lava pockets. (Defined before the
  // depth cap so ore gathers can key their reach off it.)
  const STRIP_FLOOR = parseInt(process.env.STRIP_FLOOR_Y || '30', 10)
  // Ore digs to the STRIP_FLOOR (iron territory); everything else stays near the surface.
  const MAX_MINE_DEPTH = deepOre
    ? Math.max(16, Math.floor(surfaceY) - STRIP_FLOOR)
    : parseInt(process.env.GATHER_MAX_DEPTH || '16', 10)
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

  // MID-MINE COMBAT SURVIVAL: the ONE reaction to a hostile that closes (or hp crashing)
  // while mining. The dig loops bail to here; the gather loop polls it first each pass. Deep
  // underground -> RETREAT UP to the surface (climbToSurface: bounded, walls a staircase as
  // it goes, the only mob-safe escape from a shaft). Already at/near the surface, or hp
  // critical -> BAIL the whole gather so isBusy clears and the full flee/defend/shelter
  // reflexes (which are useless mid-dig) take over. Returns 'bail' | 'up' | false.
  let threatReacts = 0
  async function surviveMiningThreat () {
    if (!mineDanger(bot)) return false
    threatReacts++
    const hp = bot.health ?? 20
    const feetY = Math.floor(bot.entity.position.y)
    const deep = feetY < Math.floor(surfaceY) - 3 && hasSolidCeiling(bot, 12, { ignoreLeaves: true })
    dbg('  gather THREAT while mining #' + threatReacts + ' (hp=' + hp.toFixed(1) + ', hostile<=6=' + nearHostile(bot, 6) + ', deep=' + deep + ') - reacting')
    if (opts.say && threatReacts <= 2) opts.say('mob on me down here - breaking off to get clear')
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
    // DEEP: retreat UP (the staircase walls behind us as we climb, shedding the chasers) -
    // this is the mob-safe escape and the ONLY thing that reliably gets us out of a shaft.
    // Each climb is awaited (no busy-spin). After a few scares this run the spot is a
    // deathtrap - stop climbing and bail. SHALLOW (near/at surface): bail straight away so
    // the un-gated flee/defend/shelter reflexes (useless mid-dig) finally take over.
    if (deep && threatReacts <= 4) {
      try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch (e) { dbg('  gather threat: climb-out failed (' + e.message + ')') }
      return 'up'
    }
    return 'bail'
  }

  let lastBeat = 0 // throttled trace heartbeat - the LAST line before a hang names the branch
  while (countItem(bot, item) - start < count) {
    // SURVIVAL FIRST: a cave mob closing (or hp crashing) mid-mine gets reacted to BEFORE
    // any more digging - the death-carousel was naked gearup mining standing in a shaft at
    // 1hp because it never broke off. Deep -> climb out; surface/critical -> yield the gather.
    {
      const react = await surviveMiningThreat()
      if (react === 'bail') return { gathered: countItem(bot, item) - start, reason: 'broke off mining to survive a mob / low hp - getting to safety' }
      if (react) continue
    }
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
      if (opts.say) opts.say('starving - sorting out food before i keep working')
      dbg('  gather food (food=' + bot.food + ') -> secureFood')
      // The ONE food chain: eat -> bank -> cook -> hunt -> farm -> fish -> scout -> hold.
      // (This replaces the old inline hunt/farm/fish copy - one policy, one owner.)
      try { await secureFood(bot, { isStopped, say: opts.say || (() => {}), home, avoid: opts.avoid, canHold: true }) } catch (e) { dbg('  secureFood failed (' + e.message + ')') }
      dbg('  gather food done (foodItems=' + foodCount(bot) + ', food=' + bot.food + ')')
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
      const useBranch = deepOre && process.env.BRANCH_MINE !== '0'
      if (canStrip && stripDug < MAX_STRIP && (stripBudget() > 0 || useBranch)) {
        if (useBranch) {
          // ORGANIZED BRANCH MINE for deep ore: ONE descent to the iron band (~y16) + a
          // torch-lit corridor with perpendicular branches - far more ore per hole than the
          // old scattered N-shaft "mole" strip, and back-out-able. Owns its own descent/depth
          // (not gated by stripBudget/belowCap). Falls through to relocate/wander if it can't
          // even sink an entrance (apron/water/lava). BRANCH_MINE=0 restores the old strip.
          const need = count - (countItem(bot, item) - start)
          const r = await branchMine(bot, item, need, { isStopped, home, surfaceY, say: opts.say, avoid: opts.avoid, dirIdx: stripDug, deadlineMs: Math.max(20000, deadline - Date.now()) })
          dbg('  gather branchMine -> ' + JSON.stringify(r)); stripDug++
          if (r.gathered > 0) { dryExplores = 0; noYield = 0; continue }
        } else {
          if (opts.say && stripDug === 0) opts.say(`no ${sources[0]} up here - digging down to reach it`)
          dbg('  gather strip-shaft #' + stripDug + ' budget=' + stripBudget() + ' at y=' + Math.floor(bot.entity.position.y))
          const dug = await digShaftDown(bot, stripBudget(), { isStopped, home })
          dbg('  gather strip-shaft dug=' + dug)
          if (dug > 0) { const got = await mineTunnel(bot, item, deepOre ? 24 : 16, stripDug, { isStopped }); dbg('  gather tunnel got=' + got); stripDug++; dryExplores = 0; continue } // count only SUCCESSFUL shafts
        }
        // Couldn't dig down here (water/void/lava underfoot - e.g. a riverbed at the fence
        // edge). Normally head back to the build SITE (dry ground the operator chose) and
        // strip-mine THERE. BUT if the anchor is our own hut (un-diggable), trekking back
        // just bounces off the apron guard - sidestep to fresh ground and strip here instead.
        if (homeUndiggable && distHome() > 6) {
          const off = { x: bot.entity.position.x + (bot.entity.position.x >= home.x ? 6 : -6), z: bot.entity.position.z + (bot.entity.position.z >= home.z ? 6 : -6) }
          dbg('  gather shaft-failed off-home (hut anchor no-dig) - sidestepping to ' + Math.round(off.x) + ',' + Math.round(off.z) + ' to strip here, not trekking back')
          try { await gotoWithTimeout(bot, new goals.GoalNearXZ(off.x, off.z, 2), 12000) } catch {}
          continue
        }
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
        // APRON GUARD: on our own hut apron digShaftDown always returns 0. The old code
        // then did stripDug++ ANYWAY, so buried ore near the hut burned the whole shaft
        // budget in seconds (verified live: stripDug 0->10 in 6s, all dug=0, then stranded
        // deep with a spent budget). Step to diggable ground first, and DON'T charge it.
        if (onHutApron(bot) || insideOwnStructure(bot)) {
          const off = { x: bot.entity.position.x + (bot.entity.position.x >= home.x ? 10 : -10), z: bot.entity.position.z + (bot.entity.position.z >= home.z ? 10 : -10) }
          dbg('  gather buried-strip on my hut apron - sidestepping to ' + Math.round(off.x) + ',' + Math.round(off.z) + ' (not burning shaft budget)')
          try { await gotoWithTimeout(bot, new goals.GoalNearXZ(off.x, off.z, 2), 12000) } catch {}
          reachFails = 0; continue
        }
        // Deep ore: run the ORGANIZED BRANCH MINE (one descent + branches) here too, so a
        // buried-ore trigger doesn't fall back to the scattered-shaft mole pattern either.
        if (deepOre && process.env.BRANCH_MINE !== '0') {
          const need = count - (countItem(bot, item) - start)
          const r = await branchMine(bot, item, need, { isStopped, home, surfaceY, say: opts.say, avoid: opts.avoid, dirIdx: stripDug, deadlineMs: Math.max(20000, deadline - Date.now()) })
          dbg('  gather buried branchMine -> ' + JSON.stringify(r)); stripDug++
          reachFails = 0; continue
        }
        const dug = await digShaftDown(bot, stripBudget(), { isStopped, home })
        // COUNT ONLY SUCCESSFUL SHAFTS (mirrors the strip-shaft path): a dug=0 shaft made
        // no descent, so charging it against MAX_STRIP just exhausts the budget uselessly.
        if (dug > 0) { const got = await mineTunnel(bot, item, deepOre ? 24 : 16, stripDug, { isStopped }); dbg('  gather buried-strip dug=' + dug + ' tunnel got=' + got); stripDug++ }
        else { dbg('  gather buried-strip dug=0 - fresh ground'); const off = { x: bot.entity.position.x + 6, z: bot.entity.position.z + 6 }; try { await gotoWithTimeout(bot, new goals.GoalNearXZ(off.x, off.z, 2), 10000) } catch {} }
        reachFails = 0
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
      if (isStopped() || mineDanger(bot)) break // a mob closed mid-cluster -> back to the survival check at the loop top
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
          if (ownHutAt({ x: b.x + dx, y: b.y + dy, z: b.z + dz })) continue // never clutter the hut interior (3 furnaces on the bedroom floor, live)
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
  // SMELT BANK PLACEMENT: extra furnaces are utility clutter - never in the hut. If we're
  // standing in/at the hut, work from a spot clear of the walls first (live: 3 furnaces
  // crammed onto the hut floor next to the bed, "nowhere to place - stopping").
  if (found.length < n && (insideOwnStructure(bot) || onHutApron(bot))) {
    const h = insideOwnStructure(bot) || onHutApron(bot)
    dbg('  ensureFurnaces: at my hut - stepping to the utility spot before placing')
    try {
      const nav = require('./navigate.js') // door-assist: a plain goto can't route out through the hut door
      await nav.navigateTo(bot, new goals.GoalNearXZ(h.x + 9, h.z + 9, 2), { timeoutMs: 20000, deadlineMs: 40000, isStopped, climb: false, budgets: { door: 2, pit: 0, water: 1, nudge: 1 }, label: 'utility-spot' })
    } catch (e) { dbg('  ensureFurnaces: utility-spot walk failed (' + e.message + ') - placing where i can') }
  }
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
      // STARVING at the furnace: the smelt loop is minutes of AFK - it stood here at 0
      // food / 1hp for 20 minutes (live). Close the window, run the food chain, reopen
      // (same shape as the night-shelter below; cooking continues while we're away).
      if (needsFood(bot) && !isSecuringFood() && Date.now() - lastShelter > 30000) {
        lastShelter = Date.now()
        dbg('  smelt food break at', made + '/' + count, '(food=' + bot.food + ')')
        try { furnace.close() } catch {}
        try { await secureFood(bot, { isStopped, say, canHold: false, scoutHunt: false }) } catch {}
        if (isStopped()) break
        if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
          await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000).catch(() => {})
        }
        furnace = await bot.openFurnace(furnaceBlock)
        before = outSum() - made
        stall = 0
        continue
      }
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
    // STARVING between rotations: same deal as the single-furnace loop - feed first.
    if (needsFood(bot) && !isSecuringFood()) {
      dbg('  multi: food break at', made + '/' + count, '(food=' + bot.food + ')')
      try { await secureFood(bot, { isStopped, say, canHold: false, scoutHunt: false }) } catch {}
      lastProgressAt = Date.now()
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

// ---- ORIENTED chest placement + double-chest heal -----------------------------------
// The hut bank must be ONE connected double chest. After the creeper rebuild the camp
// placed two mismatched singles (418,66,86 facing east + 418,66,87 facing north, live) -
// they never merge, the bank reads as two small chests. Two mechanics matter: a chest's
// facing follows the PLACER (it faces whoever placed it - yaw at placement), and sneak-
// placing (which the schematic builder does whenever the reference block is a chest, to
// avoid opening it) SUPPRESSES merging. So chests are placed deliberately: stand on the
// wanted-facing side, click the TOP of the FLOOR block (never the partner chest), no
// sneak, verify the facing landed - with one side-flip retry in case the convention is
// inverted. A wrong-facing chest is dug back up (fresh + empty + our own block).
const FACING_OFF = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
async function placeChestOriented (bot, target, want, opts = {}) {
  const off = FACING_OFF[want]
  const item = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  if (!off || !item()) return false
  const floor = bot.blockAt(target.offset(0, -1, 0))
  if (!floor || floor.boundingBox !== 'block' || /chest/.test(floor.name)) return false
  for (const sign of [1, -1]) { // stand on the facing side; one flip retry
    if (!item()) return false
    const stand = target.offset(off[0] * sign, 0, off[1] * sign)
    const clear = b => b && b.boundingBox !== 'block'
    const f = bot.blockAt(stand); const h = bot.blockAt(stand.offset(0, 1, 0)); const g = bot.blockAt(stand.offset(0, -1, 0))
    if (!(clear(f) && clear(h) && g && g.boundingBox === 'block')) { dbg('  orientedChest: no standing room ' + want + (sign < 0 ? '-flipped' : '') + ' of ' + target); continue }
    try {
      // door-assist approach: the stand cell is INSIDE the hut and a raw goto can't plan
      // through the closed door (live: the heal's re-place silently failed from outside)
      const nav = require('./navigate.js')
      await nav.navigateTo(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 0, water: 0, nudge: 1, stepout: 1 }, label: 'chest-stand' })
    } catch (e) { dbg('  orientedChest: cannot reach the stand cell ' + stand + ' (' + e.message + ')'); continue }
    const cur = bot.blockAt(target)
    if (cur && /chest/.test(cur.name)) return false // filled meanwhile
    try {
      await bot.equip(item(), 'hand')
      await bot.lookAt(target.offset(0.5, -0.4, 0.5), true) // down through the target cell at the floor
      await bot.placeBlock(floor, new Vec3(0, 1, 0))
    } catch (e) { dbg('  orientedChest: place failed (' + e.message + ')'); return false }
    await new Promise(r => setTimeout(r, 350))
    const b = bot.blockAt(target)
    if (!b || !/chest/.test(b.name)) return false
    let got = null; try { got = (b.getProperties() || {}).facing } catch {}
    if (got === want) return true
    dbg('  orientedChest: landed facing ' + got + ' (wanted ' + want + ') - taking it back, flipping sides')
    try { await bot.dig(b); await collectDrops(bot, 3) } catch { return false }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

// Detect two ADJACENT own single chests in the hut and re-place them with ONE shared
// perpendicular facing so they merge into a double. Contents move one chest at a time
// (the pack never holds the whole treasury); a chest is only dug once it READS empty.
// Returns true when the pair reads as a connected double afterwards.
async function healBankDouble (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const list = listInfra('chest', bot).filter(e => insideHutBox(e, hut))
  if (!list.length) return false
  const blkOf = e => bot.blockAt(new Vec3(e.x, e.y, e.z))
  const prop = (b, k) => { try { return (b.getProperties() || {})[k] } catch { return null } }
  let pair = null
  for (const a of list) {
    const b = list.find(o => o !== a && o.y === a.y && Math.abs(o.x - a.x) + Math.abs(o.z - a.z) === 1)
    if (b) { pair = [a, b]; break }
  }
  if (!pair) {
    // The other half STANDS in the world but fell out of infra memory (the schematic
    // rebuild registers only ONE chest cell; an aborted heal forgets the half it dug,
    // live: 418,66,87 west stood unregistered while the model saw a lone single). An
    // adjacent standing chest inside the bot's own hut IS the bank's other half - adopt
    // it back into the registry.
    for (const a of list) {
      for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const cell = { x: a.x + dx, y: a.y, z: a.z + dz }
        if (!insideHutBox(cell, hut)) continue
        const cb = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
        if (cb && /chest$/.test(cb.name)) {
          rememberInfra('chest', new Vec3(cell.x, cell.y, cell.z))
          dbg('bank heal: adopted the unregistered half at ' + cell.x + ',' + cell.y + ',' + cell.z + ' back into the registry')
          pair = [a, cell]; break
        }
      }
      if (pair) break
    }
  }
  if (!pair && list.length === 1 && (bot.inventory ? bot.inventory.items() : []).some(i => i.name === 'chest')) {
    // HALF THE BANK IS IN THE PACK (an aborted heal dug it and could not re-place, live
    // 05:44): adopt the free adjacent interior cell as the missing half - the loop below
    // places it oriented and re-registers it.
    const a = list[0]
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const cell = { x: a.x + dx, y: a.y, z: a.z + dz }
      if (!insideHutBox(cell, hut)) continue
      const cb = bot.blockAt(new Vec3(cell.x, cell.y, cell.z)); const fl = bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z))
      if (cb && AIRISH(cb.name) && fl && fl.boundingBox === 'block') { pair = [a, cell]; dbg('bank heal: missing half is in my pack - restoring it at ' + cell.x + ',' + cell.y + ',' + cell.z); break }
    }
  }
  if (!pair) return false
  const [A, B] = pair.map(blkOf)
  const chestish = b => b && /chest$/.test(b.name)
  const airish = b => !b || AIRISH(b.name)
  if (!(chestish(A) || airish(A)) || !(chestish(B) || airish(B))) return false
  if (chestish(A) && chestish(B) && (prop(A, 'type') !== 'single' || prop(B, 'type') !== 'single')) return false // already merged
  // shared facing PERPENDICULAR to the pair axis, on a side with interior standing room
  const axisZ = pair[0].x === pair[1].x
  let want = null
  for (const w of (axisZ ? ['west', 'east'] : ['north', 'south'])) {
    const off = FACING_OFF[w]
    const ok = pair.every(e => {
      const s = new Vec3(e.x + off[0], e.y, e.z + off[1])
      const f = bot.blockAt(s); const g = bot.blockAt(s.offset(0, -1, 0))
      return f && f.boundingBox !== 'block' && g && g.boundingBox === 'block'
    })
    if (ok) { want = w; break }
  }
  if (!want) { dbg('bank heal: no standable shared facing side - leaving the pair as-is'); return false }
  dbg('bank heal: two SINGLE chests at ' + pair.map(e => e.x + ',' + e.y + ',' + e.z).join(' + ') + ' - re-facing both ' + want + ' to merge them')
  for (const e of pair) {
    if (isStopped()) return false
    let b = blkOf(e)
    const missing = airish(b) // this half is in the pack (aborted earlier heal) - just place it
    if (!missing && !/chest$/.test(b.name)) return false
    if (!missing && prop(b, 'facing') === want) continue // this half is already right
    if (!missing) {
      // 1a) SHUTTLE the bulk into the OTHER half first - the pack alone can't hold a
      //     full bank (live: 871 items in one half), and the treasury must never sit
      //     in a dropped pile. withdraw -> deposit trips, bounded.
      const other = pair.find(o => o !== e)
      const otherBlk = () => { const ob = other && blkOf(other); return ob && /chest$/.test(ob.name) ? ob : null }
      if (otherBlk()) {
        for (let trip = 0; trip < 8; trip++) {
          let counts = {}
          try { counts = await chestCounts(bot, blkOf(e)) } catch { break }
          const names = Object.keys(counts)
          if (!names.length) break
          for (const n of names) {
            if ((bot.inventory ? bot.inventory.emptySlotCount() : 0) < 3) break
            try { await withdrawItem(bot, blkOf(e), n, counts[n]) } catch {}
          }
          if (!otherBlk()) break
          try { await depositMaterials(bot, otherBlk(), { all: true, keepDirt: 0 }) } catch (err) { dbg('bank heal: shuttle deposit failed (' + err.message + ')'); break }
        }
      }
      // 1b) empty the remainder into the pack (verified) - never dig a chest with anything inside
      try {
        const counts = await chestCounts(bot, b)
        for (const n of Object.keys(counts)) { await withdrawItem(bot, blkOf(e), n, counts[n]) }
      } catch (err) { dbg('bank heal: empty failed (' + err.message + ') - aborting'); return false }
      let left = {}
      try { left = await chestCounts(bot, blkOf(e)) } catch { left = { unknown: 1 } }
      if (Object.keys(left).length) {
        dbg('bank heal: chest still holds ' + Object.keys(left).join(',') + ' (pack full?) - aborting, nothing lost')
        return false
      }
      // 2) dig + re-place oriented + re-register
      forgetInfra('chest', listInfra('chest').find(x => x.x === e.x && x.y === e.y && x.z === e.z))
      try { await bot.dig(blkOf(e)); await collectDrops(bot, 3) } catch (err) { dbg('bank heal: dig failed (' + err.message + ')'); return false }
    }
    if (!await placeChestOriented(bot, new Vec3(e.x, e.y, e.z), want, opts)) {
      dbg('bank heal: oriented re-place failed - putting a chest back plainly so the bank cell is not lost')
      try { await placeAt(bot, new Vec3(e.x, e.y, e.z), /^chest$/) } catch {}
    }
    const nb = blkOf(e)
    if (!nb || !/chest$/.test(nb.name)) { dbg('bank heal: chest did not go back at ' + e.x + ',' + e.y + ',' + e.z + ' - it is in my pack, next camp pass retries'); return false }
    rememberInfra('chest', new Vec3(e.x, e.y, e.z))
    // 3) put the goods back (working set stays on the bot as usual)
    try { await depositMaterials(bot, nb, { keepDirt: 8 }) } catch (err) { dbg('bank heal: redeposit failed (' + err.message + ') - items safe in my pack') }
  }
  const [A2, B2] = pair.map(blkOf)
  const merged = A2 && B2 && /chest$/.test(A2.name) && /chest$/.test(B2.name) &&
    prop(A2, 'type') !== 'single' && prop(B2, 'type') !== 'single'
  dbg('bank heal: pair now reads ' + (merged ? 'CONNECTED DOUBLE (' + prop(A2, 'type') + '/' + prop(B2, 'type') + ')' : 'still not merged'))
  return !!merged
}

async function gotoChest (bot, chestBlock) {
  // BANKING REACH: a single 15s goto times out on a far bank ("chest read failed (goto
  // timed out)", live at 80b out) and the treasury reads as unreachable. Staged legs
  // first when far, then the precise approach - through the hut door if need be.
  const d = bot.entity.position.distanceTo(chestBlock.position)
  if (d > 40) { try { await walkStaged(bot, chestBlock.position.x, chestBlock.position.z, { range: 8, timeoutMs: 120000 }) } catch {} }
  if (bot.entity.position.distanceTo(chestBlock.position) > 3) {
    try {
      await gotoWithTimeout(bot, new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 15000)
    } catch (e) {
      // the bank lives INSIDE the hut now - a plain goto can't plan through the door
      const nav = require('./navigate.js')
      await nav.navigateTo(bot, new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 1, water: 1, nudge: 1 }, label: 'bank' })
    }
  }
}

// Deposit all BUILD MATERIALS (everything not in KEEP_ON_BOT) into the chest, so
// the pack doesn't overflow mid-provision. Keeps `keepDirt` dirt for bridging.
// Returns the number of items deposited.
// opts.all: deposit EVERYTHING except active gear/food (tools, weapons, armor, torches,
// rod, a bite to eat) - for treasury refills and bank consolidation. The default keeps
// the usual working set (KEEP_ON_BOT). NOTE: the camp rebuild always passed all:true;
// it was silently ignored until now, leaving planks/coal stuck in the pack.
const KEEP_WHEN_ALL = /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|^shears$|_helmet$|_chestplate$|_leggings$|_boots$|^torch$|flint_and_steel|_bucket$|^bucket$|^fishing_rod$|^cooked_|^bread$|_apple$/
async function depositMaterials (bot, chestBlock, opts = {}) {
  const keepDirt = opts.keepDirt || 0
  const keepRe = opts.all ? KEEP_WHEN_ALL : KEEP_ON_BOT
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  let n = 0
  try {
    for (const it of bot.inventory.items()) {
      if (keepRe.test(it.name)) continue
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

// ---- HOME BANK CONSOLIDATION (operator promise): ONE canonical treasury - the chest
// inside the hut. Every other remembered chest within `radius` gets ferried into it and
// dug up (item-safe: withdraw -> deposit round trips; the old chest is only removed once
// it reads EMPTY). Field stashes from old camps stop rotting in the open where one
// creeper audit loses the economy. Idempotent - runs every camp pass, fast no-op when
// the bank is the only chest. Returns how many field chests were fully consolidated.
async function consolidateBank (bot, hut, { isStopped = () => false, say = () => {}, radius = 64 } = {}) {
  const chests = listInfra('chest', bot)
  const bank = chests.find(e => ownHutAt({ x: e.x, y: e.y, z: e.z }))
  if (!bank) { dbg('  consolidate: no bank chest inside the hut yet'); return 0 }
  const bankBlk = () => bot.blockAt(new Vec3(bank.x, bank.y, bank.z))
  const bb0 = bankBlk()
  if (!bb0 || !/chest/.test(bb0.name)) { dbg('  consolidate: bank cell does not hold a chest'); return 0 }
  let consolidated = 0
  for (const e of chests) {
    if (isStopped()) break
    if (ownHutAt({ x: e.x, y: e.y, z: e.z })) continue // the bank itself / its double half
    if (Math.hypot(e.x - hut.x, e.z - hut.z) > radius) continue
    const blk = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (!blk || !/chest/.test(blk.name)) continue // unloaded or pruned - a later pass gets it
    dbg('  consolidate: ferrying field chest at ' + e.x + ',' + e.y + ',' + e.z + ' into the bank')
    say('moving a field chest into the bank')
    let trips = 0
    while (!isStopped() && trips++ < 6) {
      const ob = bot.blockAt(new Vec3(e.x, e.y, e.z))
      if (!ob || !/chest/.test(ob.name)) break
      let counts
      try { counts = await chestCounts(bot, ob) } catch (err) { dbg('  consolidate: field chest read failed (' + err.message + ')'); break }
      if (!Object.keys(counts).length) break
      for (const n of Object.keys(counts)) {
        if ((bot.inventory ? bot.inventory.emptySlotCount() : 36) < 2) break
        try { await withdrawItem(bot, ob, n, counts[n]) } catch {}
      }
      const bb = bankBlk()
      if (!bb || !/chest/.test(bb.name)) { dbg('  consolidate: bank vanished mid-ferry - stopping'); return consolidated }
      try { await depositMaterials(bot, bb, { keepDirt: 8, all: true }) } catch (err) { dbg('  consolidate: bank deposit failed (' + err.message + ')') }
    }
    // remove the old chest only once it verifies EMPTY (world re-read is the arbiter)
    const ob2 = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (ob2 && /chest/.test(ob2.name)) {
      let left = { unknown: 1 }
      try { left = await chestCounts(bot, ob2) } catch {}
      if (!Object.keys(left).length) {
        try {
          await bot.dig(ob2); await collectDrops(bot, 4)
          forgetInfra('chest', e)
          consolidated++
          dbg('  consolidate: field chest at ' + e.x + ',' + e.z + ' emptied + packed up')
        } catch (err) { dbg('  consolidate: empty chest pickup failed (' + err.message + ')') }
      } else dbg('  consolidate: field chest not empty after trips - leaving it standing (pack full?)')
    } else { forgetInfra('chest', e); consolidated++ }
    // bank whatever the ferry left in the pack before moving to the next chest
    try { const bb = bankBlk(); if (bb && /chest/.test(bb.name)) await depositMaterials(bot, bb, { keepDirt: 8, all: true }) } catch {}
  }
  if (consolidated) say(`bank consolidated - ${consolidated} field chest(s) moved into the hut`)
  return consolidated
}

// ---- FURNISH THE HUT (operator: "wheres the bed crafting table and furnace?"): the
// camp's loose infra moves indoors with the bank. Furnace and table get dug up and
// re-placed inside; the remembered bed is relocated and re-activated (spawn re-set).
// 6-wide footprint (via the model), not the old +4 (5-wide) box that misclassified the
// far wall row - used to tell an IN-hut station/chest from a field one.
const insideHutBox = (p, hut) => hutModel.inBox(hut, p.x, p.z)
// The doorway rim column, as a Vec3 at floor level (or null) - now derived from the
// self-structure model (schema-correct 6-wide rim, not the old 5-wide dx/dz 0..4 scan).
function findHutDoorway (bot, hut) {
  const d = hutModel.doorwayColumn(hut, hutReader(bot))
  return d ? new Vec3(d.x, hut.y, d.z) : null
}
// Standable FREE interior cells (Vec3s), from the model: the CORRECT 4x4 interior (dx/dz
// 1..4), floor-level only, threshold excluded, sorted furthest-from-door. The old scan was
// a 3x3 (dx/dz 1..3) that missed the very cells the bot wedged in, and could return a cell
// perched on a furniture/dirt pile.
function hutFreeCells (bot, hut) {
  return hutModel.freeStandCells(hut, hutReader(bot)).map(c => new Vec3(c.x, c.y, c.z))
}
const HUT_FURNITURE = /chest$|barrel$|furnace$|smoker$|crafting_table$|_bed$|_door$/
// Is a block of kind `itemRe` already standing inside the hut interior? Scans the correct
// 4x4x(5) interior via the model, so a duplicate at dx/dz 4 (missed by the old 3x3) is seen.
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

module.exports = { GATHER_SOURCES, GATHER_TOOL, SMELT_MAP, STRIP_MAP, planProvision, inventoryCounts, runGather, runCraft, runSmelt, runStrip, runPlan, branchMine, digStaircaseDown, ensureTable, ensureFurnace, ensureChest, depositMaterials, withdrawItem, chestCounts, detectWood, KEEP_ON_BOT, climbToSurface, pillarUpTo, manualHopFromWater, toolForBlock, migrateChestInto, consolidateBank, furnishHut, placeChestOriented, healBankDouble, hasSolidCeiling, insideOwnStructure, ownHutAt, onHutApron, healHomeCrater, gatherLeather, freeInteriorCell, reconcileInfra, cleanupHutInterior, stationInHut, stationSlot, maintainHut, huntForFood, hasFood, needsFood, secureFood, isSecuringFood, eatBestFood, scoutForWater, digInForNight, nightRest, nightRestWanted, restUntilSafe, isResting, rememberBed, knownBed, ensureSpawnBed, recoverSpawnAnchor, setSpawnSuspect, isSpawnSuspect, gearupState, gearupResult, isSheltering, shelterNeeded, isNight, underArmored, furnaceCountFor, countFurnacesNear, ensureFurnaces, cookRawMeat, dumpJunk, listInfra, rememberInfra, forgetInfra, ensureWheatFarm, tendWheatFarm, fishForFood, ensureHutApron, ensureHutBed, setBuildZone, setDebugSink }
