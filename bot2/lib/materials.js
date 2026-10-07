'use strict'
// MATERIALS - one pipeline from "the build still needs N of X" to what to craft, smelt and gather.
// Every item's route comes from the recipe graph (minecraft-data), with a small table of preferred routes
// where the graph is ambiguous (dye recipes list ONE member of a tag - "black_wool" - and torches take coal
// OR charcoal) or where the world decides (clay is dug, bricks and glass come out of a furnace).
// plan() is pure: needs + stock in; crafts, smelts and raw shortfalls out. The director executes it, and the
// offline check prints it - one piece of arithmetic for both (craft counts use the whole recipe yield).

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
const LOG_ANY = new RegExp(`^(${WOODS.join('|')})_log$`)
const PLANKS_ANY = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_planks$/
// the wooden forms a build cell may take in any local wood (the operator's choice)
const WOOD_FORM = new RegExp(`^(${WOODS.join('|')})_(stairs|slab|fence|fence_gate|door|trapdoor|pressure_plate|button|sign)$`)
// WOOL: each colour is its own item - white the sheep's (raw), every other one DYED FROM WHITE, as a player dyes it
// (PREFER, below). Never a class: mapped to one, brown wool in the chest counted as purple - the plan asked for no dye and
// one purple cell held the castle's band a day; and "any wool" as the dye's ingredient counted the brown the brown carpets
// need, and dyed the cyan the cyan cells need into purple (2026-09-29; audit)
const FUEL_ANY = /^(coal|charcoal)$/
const RED_FLOWER = /^(poppy|red_tulip|rose_bush|beetroot)$/

// a recipe's "#wooden_slabs" / "#logs" slot names ONE member of the tag in the data (a barrel "of cherry slabs", a
// campfire "of stripped warped hyphae" - the castle's plan asked for 684 warped stems, 2026-09-27): any member will do
const WOOD_SLAB_ANY = new RegExp(`^(${WOODS.join('|')}|bamboo|crimson|warped)_slab$`)
const LOG_TAG = /^(stripped_)?\w+_(log|wood|stem|hyphae)$/
// EXACT WOOD (the job's rule - build.exactWood): the blueprint's species all the way down, spruce stairs of spruce planks
// of spruce logs; what takes any wood in vanilla (sticks, a table, a chest, charcoal) still takes any
const SPECIES_OF = new RegExp(`^(?:stripped_)?(${WOODS.join('|')})_`)
function speciesOf (n) { const m = SPECIES_OF.exec(n || ''); return m ? m[1] : null }
function exactWood () { try { return !!L.build.exactWood() } catch { return false } }
// The species the build places itself in exact wood (spruce, for a spruce castle), less `except`'s own: any-wood crafts
// (planks of the "planks" class, chests, sticks) keep off them while another wood will do - an expedition's 146 spruce
// logs became 33 chests and 288 sticks (2026-09-28). Empty when the wood rule is "any".
// ...and the one question every spender of wood asks of an item (planks, logs, stripped logs of a reserved species)
function isReservedWood (bot, name, except = null) { const sp = speciesOf(name); return !!sp && /_(planks|log|wood)$/.test(name) && reservedSpecies(bot, except).has(sp) }
function reservedSpecies (bot, except = null) {
  if (!exactWood()) return new Set()
  try {
    const st = L.build.cachedStatus ? L.build.cachedStatus(bot) : L.build.status(bot) // (cached: asked per recipe choice)
    const out = new Set(Object.keys((st && st.need) || {}).filter(k => st.need[k] > 0).map(speciesOf).filter(Boolean))
    const own = speciesOf(except); if (own) out.delete(own)
    return out
  } catch { return new Set() }
}
function ingClass (name, result) {
  if (exactWood() && speciesOf(result) && speciesOf(name) === speciesOf(result)) return name
  // (a log-family result - stripped wood, bark - is made of that exact log, not any)
  if (LOG_TAG.test(name) && !LOG_TAG.test(result || '')) return 'log'
  if (WOOD_SLAB_ANY.test(name)) return 'wood_slab'
  if (PLANKS_ANY.test(name)) return 'planks'
  return nodeOf(name)
}

// A stripped log is a log with an axe taken to it (forage.strip): made of any log, and - like any log for a log cell,
// the operator's local wood - any species of it stands in (woodFamilyAlt; the builder takes the same rule)
const STRIPPED_LOG = new RegExp(`^stripped_(${WOODS.join('|')})_log$`)
const WOOD_FAMILY = new RegExp(`^(stripped_)?(${WOODS.join('|')})_(log|wood)$`)
function woodFamilyAlt (name) {
  const m = WOOD_FAMILY.exec(name)
  if (!m || (!m[1] && m[3] === 'log')) return null // (plain logs: LOG_ANY)
  return new RegExp(`^${m[1] || ''}(${WOODS.join('|')})_${m[3]}$`)
}
// What goes into a composter that nothing else of ours wants: sheared tufts and sea grass (seeds feed the farm,
// saplings the orchard, leaves are build blocks). 30% a layer each - seven layers a bone meal.
const COMPOSTABLE = /^(short_grass|fern|kelp|seagrass)$/
const COMPOST_PER_MEAL = 21 // the first item always lands, the next six layers at 30%: 1 + 6/0.3

// COPPER AGES: exposed/weathered/oxidized copper is plain copper plus time, and wax only stops the clock. When the
// builder takes any stage of a shape, waxed or not (copperAlt - build.acceptsFor carries the same rule), the plan makes
// the plain form: no honeycomb, and no waiting days for a block to turn green.
const COPPER_NOT_AGED = /^(raw_copper|copper_ingot|copper_nugget|copper_ore|deepslate_copper_ore|raw_copper_block|copper_torch)$|^copper_(sword|shovel|pickaxe|axe|hoe|helmet|chestplate|leggings|boots|horse_armor|spear|nautilus_armor|golem_spawn_egg)$/
// (and the LIGHTNING ROD, copper with no "copper" in its name: it ages exposed -> weathered -> oxidized in place like the
//  rest - one read as "lost lightning_rod ... now exposed_lightning_rod", and the builder would dig and re-place it for
//  ever; "could not dig the oxidized_lightning_rod" round the castle's spires, 2026-10-07. The registry's only such family)
function copperBase (name) {
  if (!/copper|lightning_rod/.test(name) || COPPER_NOT_AGED.test(name)) return null
  const b = name.replace(/^(waxed_)?((exposed|weathered|oxidized)_)?/, '')
  return b === 'copper' ? 'copper_block' : b
}
function copperAlt (name) {
  const b = copperBase(name)
  if (!b) return null
  return b === 'copper_block' ? /^(waxed_)?(copper_block|(exposed|weathered|oxidized)_copper)$/ : new RegExp(`^(waxed_)?((exposed|weathered|oxidized)_)?${b}$`)
}

// Graph nodes that stand for a whole class of items (any member will do).
// (the dye plants' classes - yellow_flower, white_flower... - are added from the recipe graph: readDyes)
const CLASSES = { log: LOG_ANY, planks: PLANKS_ANY, fuel: FUEL_ANY, red_flower: RED_FLOWER, wood_slab: WOOD_SLAB_ANY, stripped_log: STRIPPED_LOG, compostable: COMPOSTABLE }
function nodeOf (name) {
  if (CLASSES[name]) return name
  if (exactWood() && (LOG_ANY.test(name) || STRIPPED_LOG.test(name) || PLANKS_ANY.test(name)) && speciesOf(name)) return name
  if (LOG_ANY.test(name)) return 'log'
  if (STRIPPED_LOG.test(name)) return 'stripped_log'
  if (PLANKS_ANY.test(name)) return 'planks'
  if (FUEL_ANY.test(name)) return 'fuel'
  if (RED_FLOWER.test(name)) return 'red_flower'
  return name
}

// Routes the graph cannot give, or gives wrongly for a survival player.
const PREFER = {
  // raw: what the world hands over (the gatherer for each is in the director's gatherFor)
  clay_ball: { raw: true }, // 4 from each clay block, dug from under shallow water (clay.js)
  cobblestone: { raw: true },
  granite: { raw: true }, // the basilica's brick course, in polished granite (clay too scarce round 531,-650): mined
  // the other stones in veins through the rock: mined like granite (the graph makes andesite of diorite, diorite
  // of nether quartz - 640 quartz for the castle's andesite, 2026-09-27)
  andesite: { raw: true },
  diorite: { raw: true },
  tuff: { raw: true },
  cobbled_deepslate: { raw: true },
  leather: { raw: true }, // cows (the graph's one recipe is four rabbit hides)
  raw_copper: { raw: true },
  copper_ingot: { smelt: 'raw_copper' }, // (the graph: nine nuggets - which are made of an ingot)
  sand: { raw: true },
  dirt: { raw: true },
  gravel: { raw: true },
  log: { raw: true },
  white_wool: { raw: true }, // sheep: shorn, or killed without shears (food.woolFor)
  red_flower: { raw: true }, // poppy / red tulip / rose bush / beetroot
  raw_iron: { raw: true },
  fuel: { raw: true }, // coal from the mine, charcoal from spare logs
  // furnace
  brick: { smelt: 'clay_ball' },
  stone: { smelt: 'cobblestone' },
  smooth_stone: { smelt: 'stone' },
  cracked_stone_bricks: { smelt: 'stone_bricks' },
  glass: { smelt: 'sand' },
  iron_ingot: { smelt: 'raw_iron' },
  gold_ingot: { smelt: 'raw_gold' },
  water_bucket: { raw: true }, // a bucket filled at still water (forage): the graph has no recipe for it
  terracotta: { smelt: 'clay' }, // a clay BLOCK fired (four balls a block)
  // worked by hand on a placed block (forage.process): an axe strips a log, shears carve a pumpkin, water sets concrete
  // powder - `by` names the work, `site` a place the world must have for it
  stripped_log: { craft: { log: 1 }, yield: 1, by: 'strip' },
  carved_pumpkin: { craft: { pumpkin: 1 }, yield: 1, by: 'carve' },
  // crafting where the graph is ambiguous
  planks: { craft: { log: 1 }, yield: 4 },
  wood_slab: { craft: { planks: 3 }, yield: 6 },
  stick: { craft: { planks: 2 }, yield: 4 },
  torch: { craft: { fuel: 1, stick: 1 }, yield: 4 },
  // (the dyes: readDyes, from the graph)
}
const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
// concrete: the powder set by water - placed at a water's edge and mined back up (forage.harden), the way a player does
// it at the pond: never water poured over a build
for (const c of COLOURS) PREFER[c + '_concrete'] = { craft: { [c + '_concrete_powder']: 1 }, yield: 1, by: 'harden', site: 'water' }
// the coloured wools: dyed from white, then made carpet - 1 dye per wool, 2 wool -> 3 carpet (dyeing carpets instead costs
// a dye a carpet; the graph's dye recipe names one member of the wool tag - "black_wool")
for (const c of COLOURS) {
  if (c !== 'white') PREFER[c + '_wool'] = { craft: { [c + '_dye']: 1, white_wool: 1 }, yield: 1 }
  PREFER[c + '_carpet'] = { craft: { [c + '_wool']: 2 }, yield: 3 }
}

// ALTERNATIVE ROUTES, the cheapest sourceable one taken (route()): the dyes (readDyes) and bone meal - three bone meal
// from a bone (a skeleton's, when one turns up), else the composter, which grass anywhere feeds.
const ALTS = {
  bone_meal: [{ craft: { bone: 1 }, yield: 3 }, { craft: { compostable: COMPOST_PER_MEAL }, yield: 1, by: 'compost' }]
}
ALTS.bone_meal.cheapest = true

// DYES, read off the recipe graph: a dye from the plant that gives it (a class of plants: yellow_flower is dandelion or
// sunflower or wildflowers - any of them), from an item (bone meal, lapis, ink sac, cocoa beans), from the furnace
// (cactus, sea pickle - not in the crafting data), or mixed of other dyes (gray = black + white). route() takes the
// cheapest whose raws all have a route - a world with no swamp makes light blue of lapis and bone meal, and a flower
// searched for and not found (forage's exhausted memory) hands its dye to the next source.
// Plants no player finds in the wild: the sniffer's two, and the Wither's rose.
const UNWILD = /^(torchflower|pitcher_plant|wither_rose)$/
const DYE_SMELT = { green_dye: 'cactus', lime_dye: 'sea_pickle' }
const DYE_PLANTS = {} // colour -> the plants that give its dye
function recipeNames (md, r) {
  const out = []
  const add = id => { const k = id && typeof id === 'object' ? id.id : id; if (k == null || k === -1) return; const it = md.items[k]; if (it) out.push(it.name) }
  if (r.inShape) r.inShape.forEach(row => row.forEach(add)); else if (r.ingredients) r.ingredients.forEach(add)
  return out
}
function readDyes (md) {
  if (Object.keys(DYE_PLANTS).length) return
  for (const c of COLOURS) {
    const dye = md.itemsByName[c + '_dye']
    if (!dye) continue
    const routes = []; const plants = []
    for (const r of md.recipes[dye.id] || []) {
      const names = recipeNames(md, r); const yld = (r.result && r.result.count) || 1
      if (names.length === 1) {
        const n = names[0]
        if (UNWILD.test(n)) continue
        // a plant: a block nothing crafts (a golden dandelion is placed too, but made of gold - not picked)
        const it = md.itemsByName[n]
        if (md.blocksByName[n] && it && !(md.recipes[it.id] || []).length) plants.push(n)
        else routes.push({ craft: { [n]: 1 }, yield: yld })
      } else if (names.every(n => /_dye$/.test(n))) {
        const per = {}; for (const n of names) per[n] = (per[n] || 0) + 1
        routes.push({ craft: per, yield: yld })
      }
    }
    if (plants.length) {
      DYE_PLANTS[c] = plants
      if (!CLASSES[c + '_flower']) CLASSES[c + '_flower'] = new RegExp(`^(${plants.join('|')})$`)
      // (a sunflower or a rose bush gives two: counted as one - the plan never comes up short)
      routes.unshift({ craft: { [c + '_flower']: 1 }, yield: 1 })
    }
    if (DYE_SMELT[c + '_dye']) routes.push({ smelt: DYE_SMELT[c + '_dye'] })
    routes.cheapest = true
    ALTS[c + '_dye'] = routes
  }
}
// the dye class a plant belongs to ('yellow_flower' for a dandelion)
function flowerClassOf (plant) { for (const [c, ps] of Object.entries(DYE_PLANTS)) if (ps.includes(plant)) return c + '_flower'; return null }

// what goes into a furnace: PREFER's smelts and the dyes' (cactus, sea pickle)
const SMELT_INPUTS = new Set(Object.values(PREFER).filter(r => r.smelt).map(r => r.smelt).concat(Object.values(DYE_SMELT)))

// Rough seconds of gathering per raw unit, trips included - how the look-ahead weighs one shortfall against
// another, and how route() picks between sources. Clay is the long pole of a brick build: far water, and a trip per
// ~250 balls. A biome's own things cost the walk to that biome (blue orchids: swamps; cocoa: jungles).
const RAW_COST = {
  clay_ball: 2.5, log: 3, cobblestone: 1, granite: 4, andesite: 4, diorite: 4, tuff: 4, cobbled_deepslate: 2, sand: 1, dirt: 0.5, gravel: 1, fuel: 3, white_wool: 25, red_flower: 8, raw_iron: 20, raw_copper: 10, leather: 30,
  string: 20, sugar_cane: 3, lapis_lazuli: 15, diamond: 120, raw_gold: 30, ink_sac: 25, cocoa_beans: 12, cactus: 12, sea_pickle: 30, pumpkin: 15,
  bamboo: 3, vine: 5, snowball: 2, moss_block: 40, honeycomb: 60, obsidian: 90, short_grass: 1.5, fern: 3, compostable: 1.5,
  beetroot: 20, dead_bush: 6, red_mushroom: 10, brown_mushroom: 10, azalea: 30, flowering_azalea: 30, water_bucket: 8
}
// the plants: a common flower of the plains and forests, or one biome's
const PLANT_COST = { blue_orchid: 20, lily_of_the_valley: 12, allium: 12, open_eyeblossom: 40, closed_eyeblossom: 40, cactus_flower: 25, wildflowers: 10, pink_petals: 10 }
const LEAVES_COST = { oak: 1.5, birch: 1.5, spruce: 1.5, dark_oak: 2, jungle: 3, acacia: 3, cherry: 5, mangrove: 5, azalea: 10, flowering_azalea: 12, pale_oak: 12 }
function rawCost (raw) {
  if (raw in RAW_COST) return RAW_COST[raw]
  if (LOG_ANY.test(raw)) return RAW_COST.log // (a species log - exact wood - costs what any log costs)
  const f = /^(\w+)_flower$/.exec(raw)
  if (f && DYE_PLANTS[f[1]]) return Math.min(...DYE_PLANTS[f[1]].map(p => PLANT_COST[p] || 8))
  if (PLANT_COST[raw]) return PLANT_COST[raw]
  const l = /^(\w+)_leaves$/.exec(raw)
  if (l) return LEAVES_COST[l[1]] || 3
  return 5
}

function makePlanner (md, { accepts = () => null, sourceable = () => true, generation = () => 0 } = {}) {
  readDyes(md)
  // a route choice and a cost hold until what is sourceable changes (forage marks a source searched out, or a sighting
  // clears that): generation() moves then, and everything is chosen afresh
  let cache = {}; let costs = {}; let gen = generation()
  const fresh = () => { const g = generation(); if (g !== gen) { gen = g; cache = {}; costs = {} } }
  const ingNames = r => recipeNames(md, r)
  // Every route the graph gives an item, its tag slots folded into classes. A storage block's unpacking is no route:
  // nine diamonds "made of" a diamond block made of nine diamonds - the plan lost the enchanting table's diamonds in
  // that cycle (2026-09-27). Unpacking is one item in, many out; packing (hay of nine wheat) stays, and so do nuggets
  // of an ingot (an ingot is made of more than its nuggets).
  function graphRoutes (name) {
    const it = md.itemsByName[name]
    const rs = it ? md.recipes[it.id] : null
    if (!rs || !rs.length) return []
    // the plain recipes: not a dye-over-a-tag variant (its data names one member of the tag)
    const plain = rs.filter(r => !ingNames(r).some(n => /_dye$/.test(n)))
    const out = []; const seen = new Set()
    for (const r of (plain.length ? plain : rs.slice(0, 1))) {
      const names = ingNames(r)
      const kinds = [...new Set(names)]
      if (names.length === 1 && kinds[0] !== name) {
        const back = md.itemsByName[kinds[0]] ? (md.recipes[md.itemsByName[kinds[0]].id] || []) : []
        if (back.length && back.every(r2 => { const k2 = new Set(ingNames(r2)); return k2.size === 1 && k2.has(name) })) continue
      }
      const per = {}
      for (const n of names) { const k = ingClass(n, name); per[k] = (per[k] || 0) + 1 }
      const key = JSON.stringify(Object.entries(per).sort())
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ craft: per, yield: (r.result && r.result.count) || 1 })
    }
    return out
  }
  function candidates (node) {
    if (PREFER[node]) return [PREFER[node]]
    // (an exact stripped log: its own species stripped)
    if (STRIPPED_LOG.test(node)) return [{ craft: { [node.replace(/^stripped_/, '')]: 1 }, yield: 1, by: 'strip' }]
    if (ALTS[node]) return ALTS[node]
    if (CLASSES[node]) return [{ raw: true }]
    return graphRoutes(node)
  }
  // ROUTE CHOICE. One route: that one. Several: the graph's first recipe while every raw under it has a route (what the
  // plan always made - nothing that works changes), else the cheapest that has; the dyes and bone meal (ALTS) always
  // the cheapest. Nothing sourceable: the first, so the plan still names what is missing.
  const routing = new Set(); const costing = new Set()
  function route (node) {
    if (cache[node]) return cache[node]
    const list = candidates(node)
    if (!list.length) return (cache[node] = { raw: true, unknown: true })
    if (list.length === 1) return (cache[node] = list[0])
    if (routing.has(node)) return list[0] // (asked again inside its own choice - a cycle: its first route, uncached)
    routing.add(node)
    let best = list[0]
    const c0 = routeCost(list[0])
    if (list.cheapest || !isFinite(c0)) {
      let bc = list.cheapest ? c0 : Infinity
      for (const r of list) { const c = routeCost(r); if (c < bc) { bc = c; best = r } }
    }
    routing.delete(node)
    if (!routing.size && !costing.size) cache[node] = best
    return best
  }
  // seconds of gathering for one unit of a node by its chosen route; Infinity when a raw under it has no route
  function cost (node) {
    if (node in costs) return costs[node]
    if (costing.has(node) || routing.has(node)) return Infinity
    costing.add(node)
    const r = route(node)
    const c = r.raw ? (sourceable(node) ? rawCost(node) : Infinity) : routeCost(r)
    costing.delete(node)
    if (!costing.size && !routing.size) costs[node] = c // (a cost met inside a cycle is that path's, not the item's)
    return c
  }
  function routeCost (r) {
    if (r.raw) return Infinity // (a raw is priced as its node, in cost())
    if (r.site && !sourceable(r.site)) return Infinity
    if (r.smelt) return cost(r.smelt) + cost('fuel') / 8
    let s = 0
    for (const [ing, per] of Object.entries(r.craft)) s += per * cost(ing)
    return s / (r.yield || 1)
  }
  const edges = node => { const r = route(node); return r.smelt ? [r.smelt, 'fuel'] : r.craft ? Object.keys(r.craft) : [] }
  // Items that stand in for each other share one stock (jungle/spruce/oak stairs are all "wooden stairs")
  function poolKey (node) {
    if (CLASSES[node]) return node
    const re = accepts(node)
    return re ? 'pool:' + re.source : node
  }

  // needs {item: n} -> { crafts (ingredients first), smelts, raw, demand, top, smeltTotal }
  // stock(node) / inFlight(node): what is held + banked / cooking. Stock is spoken for once (a ledger), and a
  // node is expanded only after every consumer added its demand - so a batch covers all of them at once
  // (the bricks for the brick cells, the brick stairs and the brick slabs are one count of brick crafts).
  // an aged copper need made as its plain form, when the builder takes either (copperAlt)
  function standIn (name) {
    const b = copperBase(name)
    if (!b || b === name) return name
    const re = accepts(name)
    return re && re.test(b) ? b : name
  }
  // (fuelCredit: fuel in coals that only a SMELT may take - lava buckets: never a torch's coal; audit 2026-09-28)
  function plan (needs, { stock = () => 0, inFlight = () => 0, fuelCredit = 0 } = {}) {
    let smeltFuel = 0
    fresh()
    const demand = {}; const top = {}
    for (const [n, c] of Object.entries(needs || {})) {
      if (!(c > 0)) continue
      const k = nodeOf(standIn(n))
      demand[k] = (demand[k] || 0) + c; top[k] = (top[k] || 0) + c
    }
    // consumers before ingredients (reverse post-order of a DFS; a cycle is cut where it closes)
    const post = []; const seen = new Set(); const onStack = new Set()
    const visit = n => {
      if (seen.has(n)) return
      seen.add(n); onStack.add(n)
      for (const e of edges(n)) if (!onStack.has(e)) visit(e)
      onStack.delete(n); post.push(n)
    }
    Object.keys(demand).forEach(visit)
    const order = post.reverse()
    const left = {}
    const take = (node, n) => {
      const k = poolKey(node)
      if (!(k in left)) left[k] = Math.max(0, (stock(node) || 0) + (inFlight(node) || 0))
      const t = Math.min(n, left[k]); left[k] -= t; return t
    }
    // sites: the places the plan's handwork needs the world to have (water to set concrete)
    const out = { crafts: [], smelts: [], raw: {}, demand: {}, top, smeltTotal: 0, unknown: [], sites: [] }
    for (const node of order) {
      const want = node === 'fuel' ? Math.ceil(Math.max(0, (demand[node] || 0) - Math.min(fuelCredit, smeltFuel))) : (demand[node] || 0)
      if (!(want > 0)) continue
      out.demand[node] = want
      const short = want - take(node, want)
      if (short <= 0) continue
      const r = route(node)
      if (r.smelt) {
        out.smelts.push({ output: node, input: r.smelt, n: short })
        out.smeltTotal += short
        demand[r.smelt] = (demand[r.smelt] || 0) + short
        demand.fuel = (demand.fuel || 0) + short / 8 // one coal smelts eight
        smeltFuel += short / 8
      } else if (r.craft) {
        const crafts = Math.ceil(short / r.yield)
        out.crafts.push({ item: node, crafts, yield: r.yield, per: r.craft, spare: crafts * r.yield - short, by: r.by || null })
        if (r.site && !out.sites.includes(r.site)) out.sites.push(r.site)
        for (const [ing, per] of Object.entries(r.craft)) demand[ing] = (demand[ing] || 0) + per * crafts
      } else {
        out.raw[node] = (out.raw[node] || 0) + short
        if (r.unknown && !sourceable(node)) out.unknown.push(node) // (a raw nothing fetches, not merely one with no price - audit #14)
      }
    }
    out.crafts.reverse() // ingredients first: that is the order they are made in
    return out
  }
  return { plan, route: node => { fresh(); return route(node) }, cost: node => { fresh(); return cost(node) }, poolKey, nodeOf, standIn }
}

// ---- in the world ------------------------------------------------------------------------------------
// (required lazily: the planner above is loaded offline without a bot)
const L = {
  get world () { return require('./world') }, get inv () { return require('./inventory') }, get base () { return require('./base') },
  get build () { return require('./build') }, get craft () { return require('./craft') }, get smelt () { return require('./smelt') }, get log () { return require('./log').log },
  get forage () { return require('./forage') }
}

// What may stand in for an item: the builder's own rule (any wood of the form, dirt for grass), the graph's
// classes, else the exact item only.
// SPARE WOOL as the dye's base: vanilla dyes ANY wool, not white only - the pen's flock is brown, 35 sheared, while "11 white_wool
// short" held 17 light gray carpets, 2026-10-05. Spare = a colour the build places nowhere, as wool or carpet (the wool a
// carpet is made of). Only when the build places no white wool itself - then white is the dye's base alone. Memo per job
let spareMemo = { job: null, re: null }
function spareWool () {
  const j = L.build.getJob ? L.build.getJob() : null
  if (!j) return null
  if (spareMemo.job === j) return spareMemo.re
  const used = new Set()
  for (const c of j.cells) { const m = /^(\w+?)_(wool|carpet)$/.exec(c.name); if (m) used.add(m[1]) }
  spareMemo = { job: j, re: used.has('white') ? null : new RegExp('^(?!(' + ['white', ...used].join('|') + ')_wool$)[a-z_]+_wool$') }
  return spareMemo.re
}
function accepts (name) {
  if (name === 'white_wool') { const sw = spareWool(); if (sw) return new RegExp('^white_wool$|' + sw.source) }
  if (exactWood() && speciesOf(name) && /_(log|wood|planks|stairs|slab|fence|fence_gate|door|trapdoor|pressure_plate|button|sign|hanging_sign)$/.test(name)) return null
  const b = L.build
  if (typeof b.acceptsFor === 'function') { const re = b.acceptsFor(name); if (re) return re }
  if (LOG_ANY.test(name)) return LOG_ANY
  if (PLANKS_ANY.test(name)) return PLANKS_ANY
  const m = name.match(WOOD_FORM)
  if (m) return new RegExp(`^(${WOODS.join('|')})_${m[2]}$`)
  if (name === 'dirt') return /^(dirt|grass_block)$/
  return woodFamilyAlt(name)
}
function poolRe (name) { return CLASSES[name] || accepts(name) || null }
const matches = name => { const re = poolRe(name); return n => n === name || (!!re && re.test(n)) }
function held (bot, name) { return L.inv.count(bot, matches(name)) }
function banked (name) { const t = matches(name); let n = 0; for (const [k, v] of Object.entries(L.base.bankCounts())) if (t(k)) n += v; return n }
function stock (bot, name) { return held(bot, name) + banked(name) }

// Take up to `want` more of an item (or anything standing in for it) out of the chests: the exact item first,
// then the most plentiful stand-in.
async function withdrawPool (bot, name, want) {
  if (want <= 0) return 0
  const t = matches(name)
  const bank = L.base.bankCounts()
  const names = Object.keys(bank).filter(n => t(n) && bank[n] > 0).sort((a, b) => (b === name) - (a === name) || bank[b] - bank[a])
  let got = 0
  for (const n of names) {
    if (got >= want) break
    got += await L.base.withdraw(bot, n, Math.min(want - got, bank[n])).catch(() => 0)
  }
  return got
}

let planner = null
// (the wood rule changed - a new job, `wood exact|any`: every route and memo chosen afresh)
function resetPlanner () { planner = null; unsourcedMemo.clear() }
let plannerBot = null
function getPlanner (bot) {
  if (bot && bot.entity !== undefined) plannerBot = bot
  if (!planner) planner = makePlanner(L.world.data(bot), { accepts, sourceable: hasRoute, generation: () => L.forage.generation() })
  return planner
}

// A raw the director has a trip for: its own skills (director gatherFor) and the generic routes (craft.js GATHER - dug,
// mined, picked - and HUNT). An item is unsourced while any raw of its plan has none: the builder leaves its cells for
// last and the gatherer never chases it (a trip for rabbit hide, or 400 cherry leaves, is a loop that burns a day).
// forage.js adds the rest (plants and dye flowers, shears work, honey, snow, obsidian...) and the places handwork needs
// (water for concrete). A source searched for round this home and not found (forage.exhausted) has no route until a
// sighting or a new home says otherwise - its cells wait, and another source of the same thing is taken (route()).
const OWN_TRIPS = new Set(['clay_ball', 'sand', 'cobblestone', 'log', 'fuel', 'white_wool', 'red_flower'])
function hasRoute (raw) {
  const c = L.craft; const f = L.forage
  if (f.exhausted(raw) && !(f.landLead && f.landLead(raw))) return false // (a plant searched out round home still has its own land to go to - forage.landLead)
  return OWN_TRIPS.has(raw) || !!c.GATHER[raw] || !!c.HUNT[raw] || f.handles(raw)
}
const unsourcedMemo = new Map(); let memoGen = null
function unsourced (item) {
  // (right after a reset the planner is rebuilt here, not answered "sourced" until someone else asks for a plan - audit #36)
  if (!planner && plannerBot) getPlanner(plannerBot)
  if (!planner) return false
  const g = L.forage.generation()
  if (g !== memoGen) { unsourcedMemo.clear(); memoGen = g }
  if (!unsourcedMemo.has(item)) {
    const p = planner.plan({ [item]: 1 })
    unsourcedMemo.set(item, Object.keys(p.raw).some(r => !hasRoute(r)) || p.sites.some(s => !hasRoute(s)))
  }
  return unsourcedMemo.get(item)
}
// Does the build still want this item (itself, or an ingredient of what it still needs)? What a static junk list
// would toss - flowers, grass, vines, ink sacs, raw copper - is a build material the moment a blueprint needs it: the
// pack-clearing asks here first (base.tossJunk).
// What the build still wants, as one predicate: the whole-build status and plan worked out ONCE for a pass over the pack
// (per stack it was a 14-42k-cell status and a full plan each - ten stacks, ten passes mid-trip; audit #8, 2026-09-27).
// Fails closed: when the plan cannot be made, everything counts as wanted (a throw tossed build material before).
function wantedSet (bot, { failOpen = false } = {}) {
  try {
    const st = L.build.cachedStatus ? L.build.cachedStatus(bot) : L.build.status(bot)
    if (!st || !st.need) return () => false
    const tests = Object.keys(planFor(bot, st.need).demand).map(node => matches(node))
    return name => tests.some(t => t(name))
  } catch { return failOpen ? null : () => true } // (failOpen: a caller that only TAKES what is wanted gets null - nothing is; audit)
}
function wanted (bot, name) { return wantedSet(bot)(name) }
// a plan against the live stock (pack + chests + what is cooking)
// (`noInFlight`: the stock alone - nothing credited for what sits in a furnace; the builder's "the plan says covered and none
//  came" verdict, which a batch of bricks still smelting is not; audit)
function planFor (bot, needs, { noInFlight = false } = {}) {
  const inFlight = noInFlight ? () => 0 : n => n === 'fuel' ? L.smelt.inFlight('charcoal') : L.smelt.inFlight(n)
  // (fuel is counted in coals - eight smelts each; a lava bucket, pack or bank, is a hundred smelts: twelve coals. Only
  //  the planner's count - never the 'fuel' class itself, or a torch would be crafted of a lava bucket; 2026-09-28)
  const lava = () => L.inv.count(bot, 'lava_bucket') + ((L.base.bankCounts() || {}).lava_bucket || 0)
  return getPlanner(bot).plan(needs, { stock: n => stock(bot, n), inFlight, fuelCredit: lava() * 12 })
}

// The species to craft a wooden form in: the wood we hold the most of (any wood stands in).
function formFor (bot, name, species) {
  const m = name.match(WOOD_FORM)
  if (!m || exactWood()) return name
  const w = species || L.craft.preferredWood(bot)
  const alt = w + '_' + m[2]
  const re = accepts(name)
  return L.world.data(bot).itemsByName[alt] && (!re || re.test(alt)) ? alt : name
}

// Make the crafts of a plan from what the pack and chests hold - never gathers (a shortfall is the gatherer's
// job, chosen by the director). `keep`: counts of ingredients the build places itself in this window (logs for
// log cells, bricks for brick cells): a craft never eats those. Returns the number of crafts made.
async function makeCrafts (bot, crafts, { keep = {}, shouldStop } = {}) {
  let made = 0
  for (const c of crafts) {
    if (shouldStop && shouldStop()) break
    // how many crafts the ingredients allow, the build's own share of them left alone
    let n = c.crafts
    for (const [ing, per] of Object.entries(c.per)) n = Math.min(n, Math.floor(Math.max(0, stock(bot, ing) - (keep[ing] || 0)) / per))
    if (n <= 0) continue
    for (const [ing, per] of Object.entries(c.per)) {
      const short = per * n - held(bot, ing)
      if (short > 0) await withdrawPool(bot, ing, short)
    }
    for (const [ing, per] of Object.entries(c.per)) n = Math.min(n, Math.floor(Math.max(0, held(bot, ing) - Math.max(0, (keep[ing] || 0) - banked(ing))) / per))
    if (n <= 0) continue
    made += await craftNode(bot, c.item, n, c.per, { shouldStop, keep })
  }
  return made
}

// One plan node crafted n times from the pack. Classes resolve to real items here: planks from whichever logs
// are held, a wooden form in whichever planks are held (one species at a time: a recipe takes one kind).
async function craftNode (bot, node, n, per, { shouldStop, keep = {} } = {}) {
  const craft = L.craft; const inv = L.inv
  let done = 0
  if (node === 'planks') {
    // (the class: of a wood the build does not place itself first - its own species last, only if nothing else is held)
    const res = reservedSpecies(bot)
    const mine = i => res.has(speciesOf(i.name)) ? 1 : 0
    for (const it of inv.items(bot).filter(i => LOG_ANY.test(i.name)).sort((a, b) => mine(a) - mine(b) || b.count - a.count)) {
      if (mine(it) && inv.items(bot).some(i => LOG_ANY.test(i.name) && !mine(i))) continue
      if (done >= n) break
      const k = Math.min(n - done, inv.count(bot, it.name))
      const before = inv.count(bot, craft.plankOfLog(it.name))
      if (k > 0 && await craft.plankUp(bot, it.name, k)) done += Math.round((inv.count(bot, craft.plankOfLog(it.name)) - before) / 4)
    }
    return done
  }
  // handwork on a placed block (strip, carve, set concrete, compost): forage does it, and counts what came of it
  const r = getPlanner(bot).route(node)
  if (r.by) return L.forage.process(bot, r.by, node, n, { shouldStop })
  // stripped wood (or bark) in the species of the stripped logs (logs) held: four of one kind a craft
  const sw = /^(stripped_)?(\w+)_wood$/.exec(node)
  if (sw && WOODS.includes(sw[2])) {
    const src = exactWood() ? new RegExp('^' + (sw[1] || '') + sw[2] + '_log$') : sw[1] ? STRIPPED_LOG : LOG_ANY
    for (let guard = 0; guard < 6 && done < n; guard++) {
      if (shouldStop && shouldStop()) break
      const logN = inv.items(bot).filter(i => src.test(i.name)).map(i => i.name).sort((a, b) => inv.count(bot, b) - inv.count(bot, a))[0]
      if (!logN || inv.count(bot, logN) < 4) break
      const form = logN.replace(/_log$/, '_wood')
      const got = await craft.craftTimes(bot, form, Math.min(n - done, Math.floor(inv.count(bot, logN) / 4)), { shouldStop })
      if (!got) break
      done += got
    }
    return done
  }
  // the class (a barrel's "#wooden_slabs"): slabs of whichever planks are held - named here, never through formFor, whose
  // exact-wood rule kept it oak_slab and made nothing of spruce planks (audit #1, 2026-09-27)
  const slabClass = node === 'wood_slab'
  if (slabClass) node = 'oak_slab'
  else if (exactWood() && speciesOf(node)) return craft.craftTimes(bot, node, n, { shouldStop }) // (its own species' planks)
  if (WOOD_FORM.test(node)) {
    const plankNeed = per.planks || 1
    for (let guard = 0; guard < 6 && done < n; guard++) {
      if (shouldStop && shouldStop()) break
      // the planks to spend: the most SPARE of any species - the build's own share of each held back (in exact wood the
      // keep is by species: a barrel's slabs ate the spruce planks set aside for the wall cells; audit #1)
      const spare = n0 => inv.count(bot, n0) - (keep[n0] || 0)
      const species = inv.items(bot).filter(i => PLANKS_ANY.test(i.name)).map(i => i.name).sort((a, b) => spare(b) - spare(a))[0]
      if (!species || spare(species) < plankNeed) break
      const form = slabClass ? species.replace(/_planks$/, '_slab') : formFor(bot, node, species.replace(/_planks$/, ''))
      const k = Math.min(n - done, Math.floor(spare(species) / plankNeed))
      const got = await craft.craftTimes(bot, form, k, { shouldStop })
      if (!got) break
      done += got
    }
    return done
  }
  return craft.craftTimes(bot, node, n, { shouldStop })
}

// The raw shortfall to go after next. The window's own shortfall first (what the builder is blocked on at the
// head of it); when the window is supplied - or only waiting on the furnaces - the raw with the largest
// remaining cost (shortfall x seconds per unit) for the whole build: the long pole gets the spare daylight.
// (`perCell`: raw -> the cheapest cost of ONE cell of the window's that needs it. After the band's own bottleneck, the next
//  layers' raws go cheapest-cell first - many blocks for a little gathering - and the long chains last: the bookshelves'
//  books (sugar cane, leather: ~30 a cell) waited behind nothing, the "longest pole" sending the day after the cows
//  while a wall's stone was a trip away. Gathering is one trip at a time: the total is the same, the blocks come sooner,
//  and a chain that proves impossible is found with the rest built; operator 2026-09-29)
// A TRIP'S OWN PRICE, before its first unit: the walk out and back, the search, the tools (in rawCost's units - a cobblestone
// is 1). Ranked by one cell's cost alone, 2 birch leaves (1.5 a cell) beat 481 spruce logs: the round banked its haul, took
// the shears and walked off for two decor cells while the band waited, 2026-10-06
const TRIP_COST = 60
function pickRaw (winRaw, totRaw, { blockedRaw = null, feasible = () => true, perCell = null } = {}) {
  const cost = r => (totRaw[r] || winRaw[r] || 0) * rawCost(r)
  const per = r => (perCell && perCell[r] != null ? perCell[r] : Infinity)
  // (CELLS A TRIP BUYS PER EFFORT: the cells its shortfall stands for, over the trip's price plus the units' - the cheapest
  //  cells still come first, but a handful of them is worth a trip only as much as it unlocks)
  const rate = (list, r) => { const units = list[r] * rawCost(r); const cells = Number.isFinite(per(r)) && per(r) > 0 ? Math.max(1, units / per(r)) : list[r]; return cells / (TRIP_COST + units) }
  const cands = (list, first, byCell) => Object.keys(list).filter(r => list[r] > 0 && feasible(r)).sort((a, b) => (first ? (b === first) - (a === first) : 0) || (byCell ? rate(list, b) - rate(list, a) : 0) || cost(b) - cost(a))
  const w = cands(winRaw, blockedRaw, true)
  if (w.length) return { raw: w[0], short: winRaw[w[0]], why: 'the next layers' }
  const t = cands(totRaw)
  if (t.length) return { raw: t[0], short: totRaw[t[0]], why: 'look-ahead (the longest pole of the whole build)' }
  return null
}

module.exports = { spareWool, reservedSpecies, isReservedWood,
  makePlanner, nodeOf, PREFER, RAW_COST, SMELT_INPUTS, CLASSES, WOODS, LOG_ANY, PLANKS_ANY, FUEL_ANY, RED_FLOWER, WOOD_FORM,
  accepts, poolRe, hasRoute, unsourced, held, banked, stock, withdrawPool, planFor, getPlanner, formFor, makeCrafts, craftNode, pickRaw,
  resetPlanner, exactWood, speciesOf, wanted, wantedSet, rawCost, copperAlt, copperBase, woodFamilyAlt, flowerClassOf, DYE_PLANTS, COMPOSTABLE, COMPOST_PER_MEAL, STRIPPED_LOG, COLOURS
}
