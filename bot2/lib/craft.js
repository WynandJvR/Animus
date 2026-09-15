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
  clay_ball: { blocks: /^clay$/, tool: 'shovel', tier: 0 },
  flint: { blocks: /^gravel$/, tool: 'shovel', tier: 0 },
  sugar_cane: { blocks: /^sugar_cane$/, tool: null, tier: 0 },
  apple: { blocks: /^(oak_leaves|dark_oak_leaves)$/, tool: null, tier: 0 }
}
for (const w of WOODS) GATHER[w + '_log'] = { blocks: new RegExp('^' + w + '_log$'), tool: 'axe', tier: 0, log: true }
GATHER.crimson_stem = { blocks: /^crimson_stem$/, tool: 'axe', tier: 0, log: true }
GATHER.warped_stem = { blocks: /^warped_stem$/, tool: 'axe', tier: 0, log: true }

const SMELT = { stone: 'cobblestone', glass: 'sand', iron_ingot: 'raw_iron', copper_ingot: 'raw_copper', gold_ingot: 'raw_gold', smooth_stone: 'stone', brick: 'clay_ball', charcoal: '#log', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_mutton: 'mutton', cooked_chicken: 'chicken', cooked_rabbit: 'rabbit', cooked_cod: 'cod', cooked_salmon: 'salmon', baked_potato: 'potato' }
const HUNT = { leather: /^(cow|mooshroom)$/, beef: /^(cow|mooshroom)$/, porkchop: /^pig$/, mutton: /^sheep$/, chicken: /^chicken$/, rabbit: /^rabbit$/, feather: /^chicken$/, string: /^(spider|cave_spider)$/ }
for (const c of ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']) HUNT[c + '_wool'] = /^sheep$/

function isLogName (n) { return /_(log|stem)$/.test(n) && !/^stripped_/.test(n) }
function logCount (bot) { return inv.count(bot, isLogName) }
function plankOfLog (n) { return n.replace(/_(log|stem)$/, '_planks') }

// ---- crafting table ---------------------------------------------------------------------
async function tableNear (bot, maxDist = 24) {
  const t = world.findBlocks(bot, /^crafting_table$/, { maxDistance: maxDist, count: 1 })[0]
  return t || null
}

async function getTable (bot, ctx) {
  // an existing table within a short walk beats placing one (and a tunnel has no room for one)
  let t = await tableNear(bot, 48)
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
  log('craft', 'nowhere to place a crafting table here')
  return null
}

// Pick up a table we placed away from home (saves 4 planks, leaves no litter).
const placedTables = new Set() // tables this runtime put down for a craft (the ones it may pick up)
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
function chooseRecipe (bot, itemName) {
  const md = world.data(bot)
  const item = md.itemsByName[itemName]
  if (!item) return null
  const rs = md.recipes[item.id]
  if (!rs || !rs.length) return null
  const have = inv.counts(bot)
  let best = null; let bestScore = -Infinity
  for (const r of rs) {
    const need = recipeIngredients(r)
    let score = 0
    for (const [id, n] of Object.entries(need)) {
      const nm = md.items[id] ? md.items[id].name : null
      if (!nm) { score -= 100; continue }
      const h = have[nm] || 0
      score += Math.min(h, n) * 10 - n
      // planks from a log we hold count as nearly-held
      if (/_planks$/.test(nm)) score += Math.min(n, (have[nm.replace('_planks', '_log')] || 0) * 4) * 5
      if (/_log$/.test(nm) && !GATHER[nm]) score -= 50
      // common over rare variants unless we already hold the rare one
      if (!h && /^(cobbled_deepslate|blackstone|crimson_planks|warped_planks|bamboo_planks|bamboo_block|pale_oak_planks|mangrove_planks|cherry_planks)$/.test(nm)) score -= 40
    }
    if (score > bestScore) { bestScore = score; best = r }
  }
  return best
}

// ---- ensure -------------------------------------------------------------------------------
// ctx: { depth, shouldStop, reason, noWithdraw }
async function ensure (bot, name, count, ctx = {}) {
  const depth = ctx.depth || 0
  if (depth > 12) { log('craft', `ensure ${name}: too deep`); return false }
  const c2 = Object.assign({}, ctx, { depth: depth + 1 })
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
    else if (HUNT[name]) ok = await food().huntFor(bot, name, short, c2)
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
  // not enough held: the wood that grows nearest (natural trees, outside protected zones)
  const t = world.findBlocks(bot, /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/, { maxDistance: 64, count: 8, filter: b => !move.inZone(b.position, 2) })[0]
  if (t) return t.name.replace('_log', '')
  return best || 'oak'
}

async function craftItem (bot, name, n, ctx) {
  const md = world.data(bot)
  const item = md.itemsByName[name]
  if (!item) { log('craft', `unknown item ${name}`); return false }
  const r = chooseRecipe(bot, name)
  if (!r) { log('craft', `no recipe and no source for ${name}`); return false }
  const perCraft = r.result.count || 1
  const crafts = Math.ceil(n / perCraft)
  const need = recipeIngredients(r)
  // a 3x3 recipe needs the table FIRST - making the table after the ingredients spends their planks
  if (recipeNeedsTable(r) && !(await tableNear(bot, 24)) && !inv.has(bot, 'crafting_table')) {
    if (!await ensure(bot, 'crafting_table', 1, ctx)) return false
  }
  // resolve "any planks" variants to the wood we hold. Repeated until every ingredient is present at
  // once: making one ingredient can eat another (sticks are crafted FROM the pickaxe's planks).
  for (let pass = 0; pass < 3; pass++) {
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
        if (!await ensure(bot, ing, total, ctx)) { log('craft', `can't get ${total} ${ing} for ${name}`); return false }
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
  if (table) await packUpTable(bot, table)
  return inv.count(bot, name) > before
}

module.exports = { ensure, craftItem, plankUp, getTable, chooseRecipe, GATHER, SMELT, HUNT, WOODS, isLogName, logCount, plankOfLog, preferredWood }
