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
// wool to dye red: any colour but red itself (red wool IS the product, counted on its own)
const WOOL_TO_DYE = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|black)_wool$/
const FUEL_ANY = /^(coal|charcoal)$/
const RED_FLOWER = /^(poppy|red_tulip|rose_bush|beetroot)$/

// Graph nodes that stand for a whole class of items (any member will do).
const CLASSES = { log: LOG_ANY, planks: PLANKS_ANY, wool: WOOL_TO_DYE, fuel: FUEL_ANY, red_flower: RED_FLOWER }
function nodeOf (name) {
  if (CLASSES[name]) return name
  if (LOG_ANY.test(name)) return 'log'
  if (PLANKS_ANY.test(name)) return 'planks'
  if (WOOL_TO_DYE.test(name)) return 'wool'
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
  sand: { raw: true },
  dirt: { raw: true },
  gravel: { raw: true },
  log: { raw: true },
  wool: { raw: true }, // sheep: shorn, or killed without shears (food.woolFor)
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
  // crafting where the graph is ambiguous
  planks: { craft: { log: 1 }, yield: 4 },
  stick: { craft: { planks: 2 }, yield: 4 },
  torch: { craft: { fuel: 1, stick: 1 }, yield: 4 },
  red_dye: { craft: { red_flower: 1 }, yield: 1 },
  // red wool is dyed, then made carpet: 1 dye per wool, 2 wool -> 3 carpet (dyeing the carpets instead costs a
  // dye per carpet)
  red_wool: { craft: { red_dye: 1, wool: 1 }, yield: 1 },
  red_carpet: { craft: { red_wool: 2 }, yield: 3 }
}
const SMELT_INPUTS = new Set(Object.values(PREFER).filter(r => r.smelt).map(r => r.smelt))

// Rough seconds of gathering per raw unit, trips included - how the look-ahead weighs one shortfall against
// another. Clay is the long pole of a brick build: far water, and a trip per ~250 balls.
const RAW_COST = { clay_ball: 2.5, log: 3, cobblestone: 1, granite: 4, sand: 1, dirt: 0.5, gravel: 1, fuel: 3, wool: 25, red_flower: 8, raw_iron: 20 }

function makePlanner (md, { accepts = () => null } = {}) {
  const cache = {}
  const ingNames = r => {
    const out = []
    const add = id => { const k = id && typeof id === 'object' ? id.id : id; if (k == null || k === -1) return; const it = md.items[k]; if (it) out.push(it.name) }
    if (r.inShape) r.inShape.forEach(row => row.forEach(add)); else if (r.ingredients) r.ingredients.forEach(add)
    return out
  }
  function fromGraph (name) {
    const it = md.itemsByName[name]
    const rs = it ? md.recipes[it.id] : null
    if (!rs || !rs.length) return { raw: true, unknown: true }
    // the plain recipe: not a dye-over-a-tag variant (its data names one member of the tag)
    const plain = rs.filter(r => !ingNames(r).some(n => /_dye$/.test(n)))
    const r = plain[0] || rs[0]
    const per = {}
    for (const n of ingNames(r)) { const k = nodeOf(n); per[k] = (per[k] || 0) + 1 }
    return { craft: per, yield: (r.result && r.result.count) || 1 }
  }
  function route (node) {
    if (!cache[node]) cache[node] = PREFER[node] || fromGraph(node)
    return cache[node]
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
  function plan (needs, { stock = () => 0, inFlight = () => 0 } = {}) {
    const demand = {}; const top = {}
    for (const [n, c] of Object.entries(needs || {})) {
      if (!(c > 0)) continue
      const k = nodeOf(n)
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
    const out = { crafts: [], smelts: [], raw: {}, demand: {}, top, smeltTotal: 0, unknown: [] }
    for (const node of order) {
      const want = node === 'fuel' ? Math.ceil(demand[node] || 0) : (demand[node] || 0)
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
      } else if (r.craft) {
        const crafts = Math.ceil(short / r.yield)
        out.crafts.push({ item: node, crafts, yield: r.yield, per: r.craft, spare: crafts * r.yield - short })
        for (const [ing, per] of Object.entries(r.craft)) demand[ing] = (demand[ing] || 0) + per * crafts
      } else {
        out.raw[node] = (out.raw[node] || 0) + short
        if (r.unknown && !RAW_COST[node]) out.unknown.push(node)
      }
    }
    out.crafts.reverse() // ingredients first: that is the order they are made in
    return out
  }
  return { plan, route, poolKey, nodeOf }
}

// ---- in the world ------------------------------------------------------------------------------------
// (required lazily: the planner above is loaded offline without a bot)
const L = {
  get world () { return require('./world') }, get inv () { return require('./inventory') }, get base () { return require('./base') },
  get build () { return require('./build') }, get craft () { return require('./craft') }, get smelt () { return require('./smelt') }, get log () { return require('./log').log }
}

// What may stand in for an item: the builder's own rule (any wood of the form, dirt for grass), the graph's
// classes, else the exact item only.
function accepts (name) {
  const b = L.build
  if (typeof b.acceptsFor === 'function') { const re = b.acceptsFor(name); if (re) return re }
  if (LOG_ANY.test(name)) return LOG_ANY
  if (PLANKS_ANY.test(name)) return PLANKS_ANY
  const m = name.match(WOOD_FORM)
  if (m) return new RegExp(`^(${WOODS.join('|')})_${m[2]}$`)
  if (name === 'dirt') return /^(dirt|grass_block)$/
  return null
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
function getPlanner (bot) { if (!planner) planner = makePlanner(L.world.data(bot), { accepts }); return planner }
// a plan against the live stock (pack + chests + what is cooking)
function planFor (bot, needs) {
  const inFlight = n => n === 'fuel' ? L.smelt.inFlight('charcoal') : L.smelt.inFlight(n)
  return getPlanner(bot).plan(needs, { stock: n => stock(bot, n), inFlight })
}

// The species to craft a wooden form in: the wood we hold the most of (any wood stands in).
function formFor (bot, name, species) {
  const m = name.match(WOOD_FORM)
  if (!m) return name
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
    made += await craftNode(bot, c.item, n, c.per, { shouldStop })
  }
  return made
}

// One plan node crafted n times from the pack. Classes resolve to real items here: planks from whichever logs
// are held, a wooden form in whichever planks are held (one species at a time: a recipe takes one kind).
async function craftNode (bot, node, n, per, { shouldStop } = {}) {
  const craft = L.craft; const inv = L.inv
  let done = 0
  if (node === 'planks') {
    for (const it of inv.items(bot).filter(i => LOG_ANY.test(i.name)).sort((a, b) => b.count - a.count)) {
      if (done >= n) break
      const k = Math.min(n - done, inv.count(bot, it.name))
      const before = inv.count(bot, craft.plankOfLog(it.name))
      if (k > 0 && await craft.plankUp(bot, it.name, k)) done += Math.round((inv.count(bot, craft.plankOfLog(it.name)) - before) / 4)
    }
    return done
  }
  if (WOOD_FORM.test(node)) {
    const plankNeed = per.planks || 1
    for (let guard = 0; guard < 6 && done < n; guard++) {
      if (shouldStop && shouldStop()) break
      const species = inv.items(bot).filter(i => PLANKS_ANY.test(i.name)).map(i => i.name).sort((a, b) => inv.count(bot, b) - inv.count(bot, a))[0]
      if (!species || inv.count(bot, species) < plankNeed) break
      const form = formFor(bot, node, species.replace(/_planks$/, ''))
      const k = Math.min(n - done, Math.floor(inv.count(bot, species) / plankNeed))
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
function pickRaw (winRaw, totRaw, { blockedRaw = null, feasible = () => true } = {}) {
  const cost = r => (totRaw[r] || winRaw[r] || 0) * (RAW_COST[r] || 5)
  const cands = (list, first) => Object.keys(list).filter(r => list[r] > 0 && feasible(r)).sort((a, b) => (first ? (b === first) - (a === first) : 0) || cost(b) - cost(a))
  const w = cands(winRaw, blockedRaw)
  if (w.length) return { raw: w[0], short: winRaw[w[0]], why: 'the next layers' }
  const t = cands(totRaw)
  if (t.length) return { raw: t[0], short: totRaw[t[0]], why: 'look-ahead (the longest pole of the whole build)' }
  return null
}

module.exports = {
  makePlanner, nodeOf, PREFER, RAW_COST, SMELT_INPUTS, CLASSES, WOODS, LOG_ANY, PLANKS_ANY, WOOL_TO_DYE, FUEL_ANY, RED_FLOWER, WOOD_FORM,
  accepts, poolRe, held, banked, stock, withdrawPool, planFor, getPlanner, formFor, makeCrafts, craftNode, pickRaw
}
