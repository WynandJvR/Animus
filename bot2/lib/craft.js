'use strict'
// ensure(item, n): get N of an item by whatever route exists - withdraw from the base, craft
// from holdings, or gather/smelt/hunt the shortfall (recursively, tools included). Decisions
// are made per step against the live inventory, never from a stale up-front plan.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const { log } = require('./log')

const gather = () => require('./gather')
const smelt = () => require('./smelt')
const food = () => require('./food')
const base = () => require('./base')

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']

// Items with a direct world source. tier: minimum pickaxe tier (1 wood, 2 stone, 3 iron).
const GATHER = {
  cobblestone: { blocks: /^(stone|cobblestone)$/, tool: 'pickaxe', tier: 1 },
  // granite in veins through the stone: the mine's tunnels cut through it and take what shows in the walls
  granite: { blocks: /^granite$/, tool: 'pickaxe', tier: 1, ore: true },
  andesite: { blocks: /^andesite$/, tool: 'pickaxe', tier: 1, ore: true },
  diorite: { blocks: /^diorite$/, tool: 'pickaxe', tier: 1, ore: true },
  tuff: { blocks: /^tuff$/, tool: 'pickaxe', tier: 1, ore: true },
  cobbled_deepslate: { blocks: /^(deepslate|cobbled_deepslate)$/, tool: 'pickaxe', tier: 1 },
  coal: { blocks: /^(coal_ore|deepslate_coal_ore)$/, tool: 'pickaxe', tier: 1, ore: true },
  raw_iron: { blocks: /^(iron_ore|deepslate_iron_ore)$/, tool: 'pickaxe', tier: 2, ore: true },
  raw_copper: { blocks: /^(copper_ore|deepslate_copper_ore)$/, tool: 'pickaxe', tier: 2, ore: true },
  raw_gold: { blocks: /^(gold_ore|deepslate_gold_ore)$/, tool: 'pickaxe', tier: 3, ore: true },
  diamond: { blocks: /^(diamond_ore|deepslate_diamond_ore)$/, tool: 'pickaxe', tier: 3, ore: true },
  redstone: { blocks: /^(redstone_ore|deepslate_redstone_ore)$/, tool: 'pickaxe', tier: 3, ore: true },
  lapis_lazuli: { blocks: /^(lapis_ore|deepslate_lapis_ore)$/, tool: 'pickaxe', tier: 2, ore: true },
  dirt: { blocks: /^(dirt|grass_block|coarse_dirt|rooted_dirt)$/, tool: 'shovel', tier: 0 },
  sand: { blocks: /^sand$/, tool: 'shovel', tier: 0 },
  gravel: { blocks: /^gravel$/, tool: 'shovel', tier: 0 },
  // clay lies under water: its own skill (clay.js) - the surface-block digger never stands in water
  clay_ball: { blocks: /^clay$/, tool: 'shovel', tier: 0, clay: true },
  // red dye's flowers: picked by hand
  poppy: { blocks: /^poppy$/, tool: null, tier: 0, plant: true },
  red_tulip: { blocks: /^red_tulip$/, tool: null, tier: 0, plant: true },
  rose_bush: { blocks: /^rose_bush$/, tool: null, tier: 0, plant: true },
  flint: { blocks: /^gravel$/, tool: 'shovel', tier: 0 },
  sugar_cane: { blocks: /^sugar_cane$/, tool: null, tier: 0 },
  apple: { blocks: /^(oak_leaves|dark_oak_leaves)$/, tool: null, tier: 0 },
  // picked where they grow (forage.js keeps the trips and the searched-out memory; every other dye flower is read off
  // the recipe graph there). filter(bot, b): which of them to take. force: a plant act.dig's natural list lacks.
  pumpkin: { blocks: /^pumpkin$/, tool: 'axe', tier: 0, plant: true },
  // a cactus from the top down: a segment broken under another drops that one onto the cactus beside it, which burns it
  cactus: { blocks: /^cactus$/, tool: null, tier: 0, plant: true, filter: (bot, b) => { const up = bot.blockAt(b.position.offset(0, 1, 0)); return !up || up.name !== 'cactus' } },
  // bamboo from the foot: the whole stalk comes down with it
  bamboo: { blocks: /^bamboo$/, tool: null, tier: 0, plant: true, filter: (bot, b) => { const dn = bot.blockAt(b.position.offset(0, -1, 0)); return !dn || dn.name !== 'bamboo' } },
  // a ripe pod (age 2) gives three beans, a green one one
  cocoa_beans: { blocks: /^cocoa$/, block: 'cocoa', tool: 'axe', tier: 0, plant: true, force: true, filter: (bot, b) => { try { return Number(b.getProperties().age) >= 2 } catch { return false } } },
  // warm shallows only: a pickle within a step of the surface (never a dive for decoration)
  sea_pickle: { blocks: /^sea_pickle$/, tool: null, tier: 0, plant: true, force: true, filter: (bot, b) => { const up = bot.blockAt(b.position.offset(0, 2, 0)); return !!up && !/water/.test(up.name) } },
  red_mushroom: { blocks: /^red_mushroom$/, tool: null, tier: 0, plant: true },
  brown_mushroom: { blocks: /^brown_mushroom$/, tool: null, tier: 0, plant: true },
  azalea: { blocks: /^azalea$/, tool: null, tier: 0, plant: true, force: true },
  flowering_azalea: { blocks: /^flowering_azalea$/, tool: null, tier: 0, plant: true, force: true }
}
for (const w of WOODS) GATHER[w + '_log'] = { blocks: new RegExp('^' + w + '_log$'), tool: 'axe', tier: 0, log: true }
GATHER.crimson_stem = { blocks: /^crimson_stem$/, tool: 'axe', tier: 0, log: true }
GATHER.warped_stem = { blocks: /^warped_stem$/, tool: 'axe', tier: 0, log: true }

const SMELT = { stone: 'cobblestone', glass: 'sand', iron_ingot: 'raw_iron', copper_ingot: 'raw_copper', gold_ingot: 'raw_gold', smooth_stone: 'stone', brick: 'clay_ball', cracked_stone_bricks: 'stone_bricks', charcoal: '#log', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_mutton: 'mutton', cooked_chicken: 'chicken', cooked_rabbit: 'rabbit', cooked_cod: 'cod', cooked_salmon: 'salmon', baked_potato: 'potato', green_dye: 'cactus', lime_dye: 'sea_pickle', terracotta: 'clay' }
const HUNT = { leather: /^(cow|mooshroom)$/, beef: /^(cow|mooshroom)$/, porkchop: /^pig$/, mutton: /^sheep$/, chicken: /^chicken$/, rabbit: /^rabbit$/, feather: /^chicken$/, string: /^(spider|cave_spider)$/, ink_sac: /^squid$/ }
for (const c of ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']) HUNT[c + '_wool'] = /^sheep$/

function isLogName (n) { return /_(log|stem)$/.test(n) && !/^stripped_/.test(n) }
function logCount (bot) { return inv.count(bot, isLogName) }
function plankOfLog (n) { return n.replace(/_(log|stem)$/, '_planks') }

// ---- crafting table ---------------------------------------------------------------------
async function tableNear (bot, maxDist = 24) {
  const t = world.findBlocks(bot, /^crafting_table$/, { maxDistance: maxDist, count: 1 })[0]
  return t || null
}

// A table this far off is used (walked to); further, one is made here. One number for the ingredient loop's "will a
// table be made?" and getTable's "is there one?".
const TABLE_WALK = 48
async function getTable (bot, ctx) {
  // an existing table within a short walk beats placing one (and a tunnel has no room for one)
  let t = await tableNear(bot, TABLE_WALK)
  if (t) return t
  if (!inv.has(bot, 'crafting_table')) {
    const ok = await ensure(bot, 'crafting_table', 1, ctx)
    if (!ok) return null
  }
  // place it on the ground next to us
  const me = bot.entity.position.floored()
  const home = mem.get().home
  const spots = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (Math.abs(dx) + Math.abs(dz) < 1) continue
    for (const dy of [0, -1, 1]) {
      const x = me.x + dx; const y = me.y + dy; const z = me.z + dz
      const cell = world.at(bot, x, y, z); const below = world.at(bot, x, y - 1, z)
      if (cell && world.isAirish(cell) && below && world.isSolid(below) && move.utilitySpotOK({ x, y, z }, { temporary: !home || world.dist3({ x, y, z }, home) > 12 })) spots.push({ x, y, z, d: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) - (move.insideHut({ x, y, z }) ? 20 : 0) })
    }
  }
  spots.sort((a, b) => a.d - b.d)
  for (const s of spots.slice(0, 6)) {
    if (await act.place(bot, s, 'crafting_table')) {
      t = bot.blockAt(new Vec3(s.x, s.y, s.z))
      placedTables.add(`${s.x},${s.y},${s.z}`)
      log('craft', `placed a crafting table at ${move.fmt(s)}`)
      return t
    }
  }
  // no open cell beside us (a night's dug-in hole is two cells, both ours): make one, as a player does - dig out the
  // quickest block beside us, on something solid, and put the table in the gap (at dawn the tools failed "nowhere to
  // place a crafting table here" and the bot walked off to dig stone bare-handed, 7.5s a block, 2026-09-27)
  const carve = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, 1]) {
      const p = { x: me.x + dx, y: me.y + dy, z: me.z + dz }
      const b = world.at(bot, p.x, p.y, p.z); const below = world.at(bot, p.x, p.y - 1, p.z)
      if (!b || world.isAirish(b) || !below || !world.isSolid(below) || !world.isSolid(b)) continue
      if (!move.utilitySpotOK(p, { temporary: !home || world.dist3(p, home) > 12 })) continue
      if (world.waterNear(bot, p, 1)) continue // (a wall of a sealed hole with water behind it: the gap floods it - audit #16)
      const ms = bot.digTime(b)
      if (Number.isFinite(ms) && ms < 4000) carve.push({ p, ms })
    }
  }
  carve.sort((a, b) => a.ms - b.ms)
  // (a carved table stays where it is: packing it up would open the wall again - at night, the hole's own wall)
  for (const { p } of carve.slice(0, 3)) {
    if (!await act.dig(bot, new Vec3(p.x, p.y, p.z)).catch(() => false)) continue
    if (await act.place(bot, p, 'crafting_table')) {
      t = bot.blockAt(new Vec3(p.x, p.y, p.z))
      log('craft', `placed a crafting table at ${move.fmt(p)} (dug a gap for it)`)
      return t
    }
    // the table would not go in: the gap is closed again (never a hole left in a shelter's wall) - with the drop picked up
    // first, and any block a wall takes (stone drops cobblestone, grass dirt: guessing from the dug block left it open; #16)
    await act.collectDrops(bot, { radius: 3, maxMs: 1500 }).catch(() => {})
    const fill = inv.shelterBlock ? inv.shelterBlock(bot) : null
    if (!fill || !await act.place(bot, p, fill.name || fill).catch(() => false)) log('craft', `the gap dug for a table at ${move.fmt(p)} is left OPEN - ${fill ? 'the block would not go back in' : 'nothing in the pack to close it with'}`)
  }
  log('craft', 'nowhere to place a crafting table here')
  return null
}

// Pick up the tables we placed away from home (saves 4 planks, leaves no litter) - once the task that wanted them is
// over, not after each craft: the dawn's pickaxe, axe and sword put down and picked up three tables in 20s (2026-09-27)
const placedTables = new Set() // tables this runtime put down for a craft (the ones it may pick up)
async function packUpTables (bot) {
  for (const k of [...placedTables]) {
    const [x, y, z] = k.split(',').map(Number)
    const t = bot.blockAt(new Vec3(x, y, z))
    if (!t || t.name !== 'crafting_table') { placedTables.delete(k); continue }
    if (world.dist3(t.position, bot.entity.position) > 8) continue // (walked off: it stays, a player's litter)
    await packUpTable(bot, t)
  }
}
async function packUpTable (bot, t) {
  const home = mem.get().home
  if (!t || !placedTables.has(`${t.position.x},${t.position.y},${t.position.z}`)) return
  if ((home && world.dist3(t.position, home) < 12) || move.insideHut(t.position)) return
  placedTables.delete(`${t.position.x},${t.position.y},${t.position.z}`)
  if (mem.get().tables.some(p => p.x === t.position.x && p.y === t.position.y && p.z === t.position.z)) return
  await act.dig(bot, t.position, { force: true })
  await act.collectDrops(bot, { radius: 5, maxMs: 4000 })
}

// ---- recipe choice ------------------------------------------------------------------------
function recipeIngredients (r) {
  const need = {}
  if (r.inShape) { for (const row of r.inShape) for (const id of row) if (id != null && id !== -1) { const k = typeof id === 'object' ? id.id : id; if (k != null && k !== -1) need[k] = (need[k] || 0) + 1 } } else if (r.ingredients) { for (const id of r.ingredients) { const k = typeof id === 'object' ? id.id : id; need[k] = (need[k] || 0) + 1 } }
  return need
}
function recipeNeedsTable (r) {
  if (r.inShape) return r.inShape.length > 2 || r.inShape.some(row => row.length > 2)
  if (r.ingredients) return r.ingredients.length > 4
  return false
}

// Choose the recipe variant we are closest to affording (wood variants: prefer the wood we hold).
// The recipe whose whole order costs least: what the n items need, less what the pack holds (planks count their logs),
// rare ingredients dear. Scored per ingredient held it picked bamboo sticks for 7 bamboo in the pack - and then 30 sticks
// for the mine's torches meant 60 bamboo and an exploring trip, where 16 planks of any tree would do (2026-09-27).
const RECOLOUR_RE = /(_bed|_wool|_carpet|_banner|_candle|_shulker_box|_concrete_powder|_terracotta|_stained_glass|_stained_glass_pane|_harness)$/
const RARE_ING = /^(bamboo|cobbled_deepslate|blackstone|crimson_planks|warped_planks|bamboo_planks|bamboo_block|pale_oak_planks|mangrove_planks|cherry_planks)$/
function chooseRecipe (bot, itemName, n = 1, stack = null) {
  const md = world.data(bot)
  const item = md.itemsByName[itemName]
  if (!item) return null
  const rs = md.recipes[item.id]
  if (!rs || !rs.length) return null
  const have = inv.counts(bot)
  // A short ingredient costs what the planner says getting one costs (materials: raw seconds a unit, crafts and smelts on
  // top) - a bed short is a bed's wool and planks, not "1"; a log of a wood that does not grow here is unobtainable. With
  // no planner (offline), the old hand rules: rare woods dear, a re-colouring (a bed of another bed) the last resort -
  // "brown bed of a black bed" asked for a black bed of a blue bed round and round with 4 brown wool in the pack, 2026-09-27.
  let planCost = null
  try { const m = require('./materials'); const pl = m.getPlanner(bot); planCost = nm0 => { const c = pl.cost(m.nodeOf(nm0)); return Number.isFinite(c) ? Math.max(1, c) : 1e6 } } catch {}
  const fam = nm0 => (nm0.match(RECOLOUR_RE) || [])[0]
  let pw = null; try { pw = preferredWoodHeld(bot) } catch {}
  const unitCost = nm0 => {
    if (nm0 !== itemName && fam(nm0) && fam(nm0) === fam(itemName)) return 1e4 // (a re-colouring: never the way to a first one)
    // (every plank ties as "planks": the wood in hand first, explicitly - RARE_ING was dead with a planner; the audit)
    if (planCost) return planCost(nm0) + (/_planks$/.test(nm0) && pw && nm0 !== pw + '_planks' ? 0.01 : 0)
    if (/_log$/.test(nm0) && !GATHER[nm0]) return 50
    return RARE_ING.test(nm0) ? 20 : 1
  }
  let best = null; let bestCost = Infinity
  for (const r of rs) {
    // (never a recipe of something already being made up the chain: that is the cycle, not a route)
    if (stack && Object.keys(recipeIngredients(r)).some(id => md.items[id] && md.items[id].name !== itemName && stack.has(md.items[id].name))) continue
    const crafts = Math.ceil(n / ((r.result && r.result.count) || 1))
    let cost = 0
    for (const [id, per] of Object.entries(recipeIngredients(r))) {
      const nm = md.items[id] ? md.items[id].name : null
      if (!nm) { cost += 1e6; continue }
      let h = have[nm] || 0
      if (/_planks$/.test(nm)) h += (have[nm.replace('_planks', '_log')] || 0) * 4
      const short = Math.max(0, per * crafts - h)
      cost += (short ? short * unitCost(nm) : 0) + per * crafts * 0.01 // (ties: the smaller order)
    }
    if (cost < bestCost) { bestCost = cost; best = r }
  }
  return best
}

// ---- ensure -------------------------------------------------------------------------------
// ctx: { depth, shouldStop, reason, noWithdraw }
// ctx.stack: the items being made further up this chain - a recipe cycle (a brown bed of a black bed of a blue bed..., a
// storage block of its ingots of the block) is refused at once instead of running to "too deep" (audit, 2026-09-27)
async function ensure (bot, name, count, ctx = {}) {
  const depth = ctx.depth || 0
  if (depth > 12) { log('craft', `ensure ${name}: too deep`); return false }
  if (ctx.stack && ctx.stack.has(name)) { log('craft', `ensure ${name}: already being made further up this chain (a recipe cycle) - not again`); return false }
  const c2 = Object.assign({}, ctx, { depth: depth + 1, stack: new Set([...(ctx.stack || []), name]) })
  let tries = 0
  while (inv.count(bot, name) < count) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return false
    if (++tries > 6) { log('craft', `ensure ${name}: giving up at ${inv.count(bot, name)}/${count}`); return false }
    const short = count - inv.count(bot, name)
    log('craft', `${'  '.repeat(depth)}ensure ${name} x${count} (have ${inv.count(bot, name)}, try ${tries})`)
    // 1) bank
    if (!ctx.noWithdraw) {
      const got = await base().withdraw(bot, name, short).catch(() => 0)
      if (got > 0) continue
    }
    // 2) route
    let ok = false
    if (/_planks$/.test(name)) ok = await makePlanks(bot, name, short, c2)
    else if (GATHER[name] && !craftableCheaper(bot, name)) ok = await gatherItem(bot, name, short, c2)
    else if (SMELT[name]) ok = await smelt().smeltItem(bot, name, short, c2)
    // wool: shorn when there are shears (any colour counts - it is dyed), killed for otherwise
    else if (HUNT[name]) ok = /_wool$/.test(name) ? await food().woolFor(bot, short, c2) : await food().huntFor(bot, name, short, c2)
    else ok = await craftItem(bot, name, short, c2)
    if (!ok) return inv.count(bot, name) >= count
  }
  return true
}

function craftableCheaper (bot, name) { return false }

async function gatherItem (bot, name, n, ctx) {
  const g = GATHER[name]
  log('craft', `gather ${n} ${name} (pickaxe tier ${inv.toolTier(bot, 'pickaxe')}, needs ${g.tier})`)
  if (g.tool === 'pickaxe' && inv.toolTier(bot, 'pickaxe') < g.tier) {
    const pick = g.tier >= 3 ? 'iron_pickaxe' : g.tier === 2 ? 'stone_pickaxe' : 'wooden_pickaxe'
    // prefer a stone pickaxe whenever a wooden one would do - it pays for itself in 20 blocks
    const want = pick === 'wooden_pickaxe' && inv.count(bot, 'cobblestone') >= 3 ? 'stone_pickaxe' : pick
    if (!await ensure(bot, want, 1, ctx)) { if (want === pick || !await ensure(bot, pick, 1, ctx)) return false }
  }
  if (g.log) return gather().chop(bot, g.blocks, n, ctx)
  if (g.clay) return require('./clay').gather(bot, n, ctx)
  if (g.plant) return gather().pickPlants(bot, g.blocks, name, n, Object.assign({}, ctx, { filter: g.filter ? b => g.filter(bot, b) : null, force: !!g.force }))
  return gather().mine(bot, name, g, n, ctx)
}

async function makePlanks (bot, name, n, ctx) {
  const md = world.data(bot)
  const crafts = Math.ceil(n / 4)
  // which log? the exact one for this plank type
  const logName = name.replace('_planks', name.startsWith('crimson') || name.startsWith('warped') ? '_stem' : '_log')
  if (inv.count(bot, logName) < crafts) {
    if (!await ensure(bot, logName, crafts, ctx)) return false
  }
  const item = md.itemsByName[name]
  // one craft per call (a batched 2x2 craft on Paper consumed the logs and the planks never arrived: "crafted 8
  // birch_planks - have 0" six times over), verified by the inventory
  const before = inv.count(bot, name)
  for (let i = 0; i < crafts; i++) {
    const r = bot.recipesFor(item.id, null, 1, null)[0]
    if (!r) break
    try { await bot.craft(r, 1, null) } catch (e) { log('craft', `planks craft failed: ${e.message}`); await move.sleep(400); break }
    await move.sleep(80)
  }
  for (let i = 0; i < 8 && inv.count(bot, name) <= before; i++) await move.sleep(100)
  const made = inv.count(bot, name) - before
  if (made > 0) log('craft', `crafted ${made} ${name}`)
  return made > 0
}

// Planks from logs already in the pack - never gathers.
async function plankUp (bot, logName, crafts) {
  const md = world.data(bot)
  const name = plankOfLog(logName)
  const item = md.itemsByName[name]
  const k = Math.min(crafts, inv.count(bot, logName))
  if (!item || k <= 0) return false
  const r = bot.recipesFor(item.id, null, 1, null)[0]
  if (!r) return false
  const before = inv.count(bot, name)
  try { for (let i = 0; i < k; i++) { await bot.craft(r, 1, null); await move.sleep(80) } } catch (e) { log('craft', `planks craft failed: ${e.message}`) }
  for (let i = 0; i < 8 && inv.count(bot, name) <= before; i++) await move.sleep(100)
  return inv.count(bot, name) > before
}

// Which plank type to use when a recipe accepts any: the one we can make from held logs, else
// the nearest tree's.
// the wood held most of (planks + logs), no search - a tie-break, not a trip
function preferredWoodHeld (bot) { const c = inv.counts(bot); let best = null; let bn = 0; for (const w of WOODS) { const n = (c[w + '_planks'] || 0) + (c[w + '_log'] || 0) * 4; if (n > bn) { bn = n; best = w } } return best }
function preferredWood (bot, needPlanks = 1) {
  const c = inv.counts(bot)
  let best = null; let bn = 0
  for (const w of WOODS) { const n = (c[w + '_planks'] || 0) + (c[w + '_log'] || 0) * 4; if (n > bn) { bn = n; best = w } }
  if (best && bn >= needPlanks) return best
  // the bank counts too: a chest of birch beats a walk to find oak
  const bank = base().bankCounts ? base().bankCounts() : {}
  let bestB = null; let bnB = 0
  for (const w of WOODS) { const n = (c[w + '_planks'] || 0) + (c[w + '_log'] || 0) * 4 + (bank[w + '_planks'] || 0) + (bank[w + '_log'] || 0) * 4; if (n > bnB) { bnB = n; bestB = w } }
  if (bestB && bnB >= needPlanks) return bestB
  // not quite enough: top up the wood already in hand when it grows in sight or where we saw it - 12 birch planks held,
  // 14 wanted, and the bot dug down through the mountain after a jungle tree below the site (2026-09-27)
  const g0 = require('./gather')
  if (best && (world.findBlocks(bot, new RegExp('^' + best + '_log$'), { maxDistance: 64, count: 1, filter: b => g0.treeOK(b) })[0] || g0.knownResource(best + '_log', bot.entity.position))) return best
  // not enough held: the wood that grows nearest (natural trees, outside protected zones)
  const t = world.findBlocks(bot, /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/, { maxDistance: 64, count: 8, filter: b => require('./gather').treeOK(b) })[0] // (the orchard's trees count as wood that grows here)
  if (t) return t.name.replace('_log', '')
  // none in sight: the nearest forest we remember (seen on a walk, felled before, or pointed out by the operator)
  const g = require('./gather')
  let near = null
  for (const w of WOODS) { const k = g.knownResource(w + '_log', bot.entity.position); if (k && (!near || world.dist2(k, bot.entity.position) < world.dist2(near.p, bot.entity.position))) near = { w, p: k } }
  if (near) return near.w
  return best || 'oak'
}

async function craftItem (bot, name, n, ctx) {
  const md = world.data(bot)
  const item = md.itemsByName[name]
  if (!item) { log('craft', `unknown item ${name}`); return false }
  const r = chooseRecipe(bot, name, n, ctx && ctx.stack)
  if (!r) { log('craft', `no recipe and no source for ${name}`); return false }
  const perCraft = r.result.count || 1
  const crafts = Math.ceil(n / perCraft)
  const need = recipeIngredients(r)
  // resolve "any planks" variants to the wood we hold. Repeated until every ingredient is present at
  // once: making one ingredient can eat another (sticks are crafted FROM the pickaxe's planks).
  for (let pass = 0; pass < 3; pass++) {
    // a 3x3 recipe needs the table FIRST - making the table after the ingredients spends their planks. Asked on every
    // pass, from where we stand now: getting an ingredient can walk us away from the table we meant to use (the
    // chest's planks came from a tree 60 blocks from home; the table made there ate 4 of the 8, 2026-09-24)
    if (recipeNeedsTable(r) && !(await tableNear(bot, TABLE_WALK)) && !inv.has(bot, 'crafting_table')) {
      if (!await ensure(bot, 'crafting_table', 1, ctx)) return false
    }
    let short = false
    for (const [id, per] of Object.entries(need)) {
      let ing = md.items[id].name
      const total = per * crafts + (/_planks$/.test(ing) && Object.keys(need).some(k => md.items[k].name === 'stick') && inv.count(bot, 'stick') < need[md.itemsByName.stick.id] * crafts ? 2 : 0)
      if (/_planks$/.test(ing) && inv.count(bot, ing) < total) {
        const w = preferredWood(bot, total)
        const alt = md.recipes[item.id].find(rr => { const nn = recipeIngredients(rr); return Object.keys(nn).some(k => md.items[k].name === w + '_planks') })
        if (alt) ing = w + '_planks'
      }
      if (inv.count(bot, ing) < per * crafts) {
        short = true
        if (!await ensure(bot, ing, total, ctx)) {
          // a wood that doesn't grow here (chosen for a log or two in the pack): any planks do, so the wood that does
          // grow here - "chop acacia_log: no trees found" with oaks all round, two sticks never made (2026-09-24)
          const alt = /_planks$/.test(ing) && world.findBlocks(bot, /_log$/, { maxDistance: 64, count: 4, filter: b => require('./gather').treeOK(b) })[0]
          const ing2 = alt ? alt.name.replace(/_log$/, '_planks') : null
          const takes = ing2 && ing2 !== ing && md.recipes[item.id].some(rr => Object.keys(recipeIngredients(rr)).some(k => md.items[k].name === ing2))
          if (!takes || !await ensure(bot, ing2, total, ctx)) { log('craft', `can't get ${total} ${ing} for ${name}`); return false }
        }
      }
    }
    if (!short) break
  }
  let table = null
  if (recipeNeedsTable(r)) {
    table = await getTable(bot, ctx)
    if (!table) return false
    if (!act.reach(bot, table.position, 4)) {
      const g = await move.goTo(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), { timeoutMs: 30000, label: 'to table' })
      if (!g.ok) return false
      table = bot.blockAt(table.position)
    }
  }
  const real = bot.recipesFor(item.id, null, 1, table)[0]
  if (!real) { log('craft', `recipe for ${name} not craftable with what I hold`); return false }
  // craft what the pack affords right now (a smelt that returned 3 of 4 charcoal is not a failure):
  // ensure's loop comes back for the rest
  const have = inv.counts(bot)
  let afford = crafts
  for (const [id, per] of Object.entries(recipeIngredients(real))) { const nm = md.items[id] && md.items[id].name; if (nm) afford = Math.min(afford, Math.floor((have[nm] || 0) / per)) }
  const doCrafts = Math.max(1, afford)
  const before = inv.count(bot, name)
  // one craft per call: a batched craft on Paper races the server's slot updates and the client's
  // view of the grid goes stale after the first result ("missing ingredient", results on the cursor
  // dropped when the window closes)
  for (let i = 0; i < doCrafts; i++) {
    const r1 = bot.recipesFor(item.id, null, 1, table)[0]
    if (!r1) break
    try {
      await bot.craft(r1, 1, table)
      await move.sleep(120)
    } catch (e) {
      // the craft may still have happened server-side: let the sync land, close the window (the
      // server resyncs the inventory), pick up anything that fell, and judge by what we hold
      await move.sleep(500)
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
      await move.sleep(500)
      await act.collectDrops(bot, { radius: 4, maxMs: 2500 })
      if (inv.count(bot, name) > before) { log('craft', `craft ${name} reported "${e.message}" after ${inv.count(bot, name) - before} made - keeping those`); break }
      log('craft', `craft ${name} failed: ${e.message}`)
      if (inv.freeSlots(bot) === 0) await base().makeRoom(bot, 2).catch(() => {})
      return false
    }
  }
  // the server is the authority on what was crafted: give its inventory sync a moment
  for (let i = 0; i < 10 && inv.count(bot, name) <= before; i++) await move.sleep(150)
  await move.sleep(300)
  const made = inv.count(bot, name) - before
  if (made > 0) log('craft', `crafted ${made} ${name}`)
  else { log('craft', `craft ${name}: the server did not hand over the result - picking up anything that fell`); await act.collectDrops(bot, { radius: 4, maxMs: 3000 }) }
  return inv.count(bot, name) > before
}

// A dyed wool from any other wool: the recipe data lists one member of the wool tag (black_wool), so
// recipesFor never matches the white wool a sheep gives - the server takes any, so the grid gets what we hold.
function dyedRecipe (bot, name, table) {
  const m = name.match(/^(.+)_wool$/)
  if (!m) return null
  const md = world.data(bot)
  const dye = inv.items(bot).find(i => i.name === m[1] + '_dye')
  const wool = inv.items(bot).find(i => /_wool$/.test(i.name) && i.name !== name)
  const out = md.itemsByName[name]
  if (!dye || !wool || !out) return null
  const { Recipe } = require('prismarine-recipe')(bot.registry)
  const r = new Recipe({ ingredients: [dye.type, wool.type], result: { id: out.id, count: 1 } })
  return r
}

// Craft `name` up to `crafts` times from what the pack holds - never withdraws or gathers (the caller put the
// ingredients in the pack). One craft per call, the table only when the recipe needs it, verified by the
// inventory. Returns the number of crafts that happened.
async function craftTimes (bot, name, crafts, { shouldStop } = {}) {
  const md = world.data(bot)
  const item = md.itemsByName[name]
  if (!item || crafts <= 0) return 0
  const any = bot.recipesFor(item.id, null, 1, true)[0] || dyedRecipe(bot, name, true)
  if (!any) { log('craft', `can't craft ${name} from what i hold`); return 0 }
  let table = null
  if (any.requiresTable) {
    table = await getTable(bot, { noWithdraw: true, shouldStop })
    if (!table) return 0
    if (!act.reach(bot, table.position, 4)) {
      const g = await move.goTo(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), { timeoutMs: 30000, label: 'to table' })
      if (!g.ok) return 0
      table = bot.blockAt(table.position)
    }
  }
  const perCraft = (any.result && any.result.count) || 1
  const before = inv.count(bot, name)
  let i = 0
  for (; i < crafts; i++) {
    if (shouldStop && shouldStop()) break
    const r1 = bot.recipesFor(item.id, null, 1, table)[0] || dyedRecipe(bot, name, table)
    if (!r1) break
    try {
      await bot.craft(r1, 1, table)
      await move.sleep(120)
    } catch (e) {
      // as craftItem: the craft may have landed server-side - resync, pick up what fell, judge by the pack
      await move.sleep(500)
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
      await move.sleep(500)
      await act.collectDrops(bot, { radius: 4, maxMs: 2500 })
      log('craft', `craft ${name} failed after ${i}: ${e.message}`)
      if (inv.freeSlots(bot) === 0) await base().makeRoom(bot, 2).catch(() => {})
      break
    }
  }
  for (let k = 0; k < 10 && inv.count(bot, name) < before + i * perCraft; k++) await move.sleep(150)
  const made = inv.count(bot, name) - before
  if (made > 0) log('craft', `crafted ${made} ${name} (${Math.ceil(made / perCraft)} craft${made > perCraft ? 's' : ''})`)
  return Math.round(made / perCraft)
}

module.exports = { packUpTables, ensure, craftItem, craftTimes, plankUp, getTable, chooseRecipe, GATHER, SMELT, HUNT, WOODS, isLogName, logCount, plankOfLog, preferredWood }
