'use strict'
// FORAGE - the gathering and the handwork beyond digging, chopping, mining and hunting: the plants of every dye, shears
// work (leaves, grass, vines, honeycomb), snow, pumpkins carved, logs stripped, concrete set at the water's edge, bone
// meal out of a composter, obsidian off a lava pool. The planner (materials.js) names these raws and handwork; this
// module is the ONE gatherer of each (gather) and the one worker of each piece of handwork (process).
// A source is searched for a bounded number of trips: not found round this home, it is marked EXHAUSTED - no route, so
// its cells wait and the planner takes another source of the same thing (materials.hasRoute / route()). A sighting of
// it (gather.survey watches for exactly the exhausted ones) or a new home opens it again - conditions, never a timer.
// A rare biome's block (sea pickles, cocoa, acacia leaves) therefore never holds a build: it costs three trips at most.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const craft = () => require('./craft')
const gather = () => require('./gather')
const mats = () => require('./materials')
const food = () => require('./food')
const base = () => require('./base')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const stopped = ctx => !!(ctx && ctx.shouldStop && ctx.shouldStop())
const key = p => `${p.x},${p.y},${p.z}`

// ---- which raws are ours -------------------------------------------------------------------------------
const LEAVES = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|azalea|flowering_azalea|pale_oak)_leaves$/
// cut with shears: the block itself drops (bare-handed a leaf gives a sapling at best, grass a seed)
const SHEARED = /^(short_grass|fern|vine|dead_bush)$/
// dug with a tool: snow gives snowballs to a shovel only
const DUG = {
  snowball: { blocks: /^(snow|snow_block)$/, tool: 'shovel' },
  moss_block: { blocks: /^moss_block$/, tool: null }
}
// picked by hand (craft.js GATHER holds their blocks, filters and drops: one definition - craft.ensure picks them too)
const PICKED = /^(pumpkin|cactus|bamboo|cocoa_beans|sea_pickle|red_mushroom|brown_mushroom|azalea|flowering_azalea)$/

// spec(raw): how the raw is got, or null when it is not ours
function spec (raw) {
  const f = /^(\w+)_flower$/.exec(raw)
  const plants = mats().DYE_PLANTS
  if (f && plants[f[1]]) {
    // (red: the director's own red_flower trip picks poppies, tulips and rose bushes - the class also counts beetroot)
    const ps = plants[f[1]]
    return { kind: 'plant', blocks: new RegExp(`^(${ps.join('|')})$`), drops: mats().CLASSES[raw] || new RegExp(`^(${ps.join('|')})$`) }
  }
  if (Object.values(plants).some(ps => ps.includes(raw))) return { kind: 'plant', blocks: new RegExp(`^${raw}$`), drops: raw }
  if (PICKED.test(raw)) { const g = craft().GATHER[raw]; if (g) return { kind: 'plant', blocks: g.blocks, drops: raw, filter: g.filter, force: g.force } }
  if (LEAVES.test(raw)) return { kind: 'shears', blocks: new RegExp(`^${raw}$`), drops: raw, leaves: true }
  if (SHEARED.test(raw)) return { kind: 'shears', blocks: new RegExp(`^${raw}$`), drops: raw }
  // compost: tufts of grass or ferns, whichever grows here
  if (raw === 'compostable') return { kind: 'shears', blocks: /^(short_grass|fern)$/, drops: mats().COMPOSTABLE }
  if (DUG[raw]) return Object.assign({ kind: 'dig', drops: raw }, DUG[raw])
  if (raw === 'honeycomb') return { kind: 'honey', drops: raw }
  if (raw === 'ink_sac') return { kind: 'hunt', drops: raw }
  if (raw === 'obsidian') return { kind: 'obsidian', drops: raw }
  // water carried in a bucket (a pour in a build): the empties filled at still water
  if (raw === 'water_bucket') return { kind: 'fill', drops: raw }
  // a place, not a thing: still water to set concrete in
  if (raw === 'water') return { kind: 'site' }
  return null
}
function handles (raw) { return !!spec(raw) }

// ---- the searched-out memory -----------------------------------------------------------------------------
// Per raw, per home: fruitless trips so far, and whether it is exhausted. Three trips, each exploring out in new
// directions (explore's rings turn every leg), is the bounded search; a trip that brings any back starts it over.
const SEARCH_TRIPS = 3
let gen = 0 // moves whenever a raw is marked exhausted or opened again: the planner chooses its routes afresh
function generation () { return gen }
function home () { return mem.get().home }
function sameHome (r) { const h = home(); return !!(r && r.home && h && world.dist2(r.home, h) < 16) }
function record (raw) { const f = mem.get().forage; return f ? f[raw] || null : null }
function exhausted (raw) { const r = record(raw); return !!(r && r.exhausted && sameHome(r)) }
function exhaustedKinds () { return Object.keys(mem.get().forage || {}).filter(exhausted) }
// A trip that brought none counts toward exhaustion only when it SEARCHED and found none (opts.searched): a trip cut
// short - dusk, danger, a full pack, the operator - says nothing about the source, and counted, three short trips shut
// dark oak round a forest of it (audit R7, 2026-09-27). Any gain opens the source again, however the trip ended.
// opts.now: shut at once - the source is there but has nothing to give (nests not full): the survey opens it when one is
// (a bare boolean for opts is `now`, the old call).
function noteTrip (raw, got, why, opts = {}) {
  if (typeof opts === 'boolean') opts = { now: opts, searched: true }
  const now = !!opts.now
  if (got <= 0 && !opts.searched && !now) { log('forage', `${raw}: none this trip, but it was cut short${why ? ' (' + why + ')' : ''} - not counted as searched`); return }
  let flip = null
  mem.update(m => {
    const f = m.forage = m.forage || {}
    let r = f[raw]
    if (!r || !sameHome(r)) r = f[raw] = { home: m.home ? { x: m.home.x, y: m.home.y, z: m.home.z } : null, fails: 0, exhausted: false }
    if (got > 0) { if (r.exhausted) flip = 'open'; r.fails = 0; r.exhausted = false; return }
    r.fails++
    if (!r.exhausted && (r.fails >= SEARCH_TRIPS || now)) { r.exhausted = true; flip = 'shut' }
  })
  if (flip) gen++
  const r = record(raw)
  if (flip === 'shut') log('forage', `NO ${raw} to be had round this home (${why || r.fails + ' trips searched'}) - its cells wait, and another source is used where there is one; ${sightsFor(raw) ? 'a sighting opens it again' : 'a new home opens it again'}`)
  else if (got <= 0) log('forage', `${raw}: a trip for nothing (${r.fails}/${SEARCH_TRIPS}${why ? ', ' + why : ''})`)
}
// One seen on a walk (gather.survey looks for exactly the exhausted ones): open again.
function seen (raws) {
  let opened = []
  mem.update(m => { for (const raw of raws) { const r = (m.forage || {})[raw]; if (r && r.exhausted) { r.exhausted = false; r.fails = 0; opened.push(raw) } } })
  if (opened.length) { gen++; log('forage', `seen ${opened.join(', ')} again - the route is open`) }
}
// What the survey watches for: the blocks whose sighting would open an exhausted raw, and the rule a sighting must pass
// (a nest full of honey, a pod ripe, leaves on a tree - not a hedge).
const SIGHT = [
  { raws: r => /_flower$/.test(r) ? mats().DYE_PLANTS[r.replace(/_flower$/, '')] || [] : null },
  { raws: r => r === 'honeycomb' ? ['bee_nest'] : null, ok: (bot, b) => honeyLevel(b) >= 5 },
  { raws: r => r === 'snowball' ? ['snow', 'snow_block'] : null },
  { raws: r => r === 'cocoa_beans' ? ['cocoa'] : null, ok: (bot, b) => age(b) >= 2 },
  // (a pool to quench, never obsidian itself: every portal frame in sight reopened the trip - audit 2026-09-27)
  { raws: r => r === 'obsidian' ? ['lava'] : null, ok: (bot, b) => quenchable(bot, b) },
  { raws: r => r === 'water' ? ['water'] : null, ok: (bot, b) => !!shoreAt(bot, b) },
  { raws: r => r === 'water_bucket' ? ['water'] : null, ok: (bot, b) => Number(props(b).level || 0) === 0 },
  { raws: r => LEAVES.test(r) ? [r] : null, ok: (bot, b) => !persistent(b) },
  // a species log (exact wood, shut by the director's trip - noteTrip): a wild tree of it, never a cabin's wall - the
  // chop's own rule (gather.treeOK + isNaturalTree). Without this row a shut species never opened again (audit R7)
  { raws: r => mats().LOG_ANY.test(r) ? [r] : null, ok: (bot, b) => gather().wildTree(bot, b) },
  { raws: r => r === 'compostable' ? ['short_grass', 'fern'] : null },
  { raws: r => (spec(r) || {}).kind === 'plant' || SHEARED.test(r) || r === 'moss_block' ? [(craft().GATHER[r] || {}).block || r] : null }
]
function sightsFor (raw) { for (const s of SIGHT) { const b = s.raws(raw); if (b && b.length) return { blocks: b, ok: s.ok } } return null }
function watch () {
  const blocks = {}
  for (const raw of exhaustedKinds()) { const s = sightsFor(raw); if (s) for (const b of s.blocks) (blocks[b] = blocks[b] || []).push({ raw, ok: s.ok }) }
  const names = Object.keys(blocks)
  return names.length ? { re: new RegExp(`^(${names.join('|')})$`), sighted: (bot, b) => (blocks[b.name] || []).filter(w => !w.ok || w.ok(bot, b)).map(w => w.raw) } : null
}

// Mobs: a squid in view opens ink sacs again (the survey asks with what it sees round it)
const SIGHT_MOBS = { ink_sac: /^squid$/ }
function sightMobs (bot) {
  const want = exhaustedKinds().filter(r => SIGHT_MOBS[r])
  if (!want.length || !bot.entity) return
  const me = bot.entity.position
  const near = Object.values(bot.entities).filter(e => e && e.name && e.position && e.position.distanceTo(me) < 48)
  seen(want.filter(r => near.some(e => SIGHT_MOBS[r].test(e.name))))
}

// ---- block state -----------------------------------------------------------------------------------------
const props = b => { try { return b.getProperties() || {} } catch { return {} } }
function honeyLevel (b) { return Number(props(b).honey_level || 0) }
function age (b) { return Number(props(b).age || 0) }
function still (b) { return b && b.name === 'lava' && Number(props(b).level || 0) === 0 }
function persistent (b) { const p = props(b).persistent; return p === true || p === 'true' }

// ---- gather: one trip for one raw -------------------------------------------------------------------------
function counter (s) { return bot => inv.count(bot, s.drops) }
async function gatherRaw (bot, raw, n, ctx = {}) {
  const s = spec(raw)
  if (!s || s.kind === 'site') { log('forage', `no gatherer for ${raw}`); return false }
  if (exhausted(raw)) { log('forage', `${raw}: searched out round this home - not going again until one is seen`); return false }
  const count = counter(s)
  const before = count(bot)
  let r = false
  try {
    if (s.kind === 'plant') r = await gather().pickPlants(bot, s.blocks, s.drops, n, Object.assign({}, ctx, { filter: s.filter ? b => s.filter(bot, b) : null, force: !!s.force }))
    else if (s.kind === 'shears') r = await shearTrip(bot, s, n, ctx)
    else if (s.kind === 'dig') r = await digTrip(bot, raw, s, n, ctx)
    else if (s.kind === 'honey') r = await honeyTrip(bot, n, ctx)
    else if (s.kind === 'hunt') r = await food().huntFor(bot, raw, n, ctx)
    else if (s.kind === 'obsidian') r = await obsidianTrip(bot, n, ctx)
    else if (s.kind === 'fill') r = await fillTrip(bot, n, ctx)
  } catch (e) { log('forage', `${raw} trip threw: ${e.message}`) }
  const got = count(bot) - before
  // a trip cut short (dusk, the operator) or held up by its tool is no search: only a finished, empty one counts
  // ('cut': the trip itself ended early - a full pack - and is no search either)
  if (r === 'blocked' || (got <= 0 && (stopped(ctx) || r === 'cut'))) return false
  noteTrip(raw, got, r === 'waiting' ? 'none ready to take yet' : null, { now: r === 'waiting', searched: true })
  if (got > 0) log('forage', `${raw}: +${got} this trip`)
  return got > 0
}

// ---- tools -------------------------------------------------------------------------------------------------
function shearsHeld (bot) { return inv.items(bot).find(i => i.name === 'shears' && inv.durabilityLeft(bot, i) > 2) || null }
// shears: two iron ingots (the bank's first) - the one tool every job here but digging needs
async function ensureShears (bot, ctx) {
  if (shearsHeld(bot)) { if (mem.get().shearsWorn) mem.set('shearsWorn', false); return true }
  // (a pair at a time until a good one: the chest holds the worn pairs too, and the first out was the worn one - audit 2026-10-03)
  for (let i = 0; i < 4 && !shearsHeld(bot) && base().bankCount('shears') > 0; i++) { if (!await base().withdraw(bot, 'shears', 1).catch(() => 0)) break }
  // (the bank's pair, out and spent: no shears at all to the iron plan - the director makes a pair; audit)
  if (!shearsHeld(bot) && inv.has(bot, 'shears') && !mem.get().shearsWorn) { mem.set('shearsWorn', true); log('forage', 'the banked shears are worn out - a new pair wanted') }
  if (!shearsHeld(bot)) await craft().ensure(bot, 'shears', inv.count(bot, 'shears') + 1, Object.assign({}, ctx, { noWithdraw: false })).catch(() => false)
  if (!shearsHeld(bot)) { log('forage', 'no shears and none to be made (two iron ingots) - the shears work waits'); return false }
  return true
}
// a tool of a kind: held, banked, else a stone one made (wooden when there is no stone)
async function ensureTool (bot, kind, ctx) {
  if (inv.bestTool(bot, kind, 4)) return true
  for (const t of ['iron', 'stone', 'wooden']) { const n = t + '_' + kind; if (base().bankCount(n) > 0) { await base().withdraw(bot, n, 1).catch(() => 0); if (inv.bestTool(bot, kind, 4)) return true } }
  for (const t of ['stone', 'wooden']) { if (await craft().ensure(bot, t + '_' + kind, inv.count(bot, t + '_' + kind) + 1, Object.assign({}, ctx, { noWithdraw: false })).catch(() => false)) break }
  return !!inv.bestTool(bot, kind, 4)
}

// ---- shears work: leaves, grass, ferns, vines --------------------------------------------------------------
// The same protection as every dig (a finished build block is never cut), with the shears in hand - act.dig picks the
// "best tool" for leaves, a hoe, and a hoe's leaves drop saplings, not leaves.
async function shearBlock (bot, b) {
  if (!b || move.isProtected(b, 'dig')) return false
  const sh = shearsHeld(bot)
  if (!sh) return false
  try {
    if (!bot.heldItem || bot.heldItem.name !== 'shears') await bot.equip(sh, 'hand')
    await bot.dig(b, true)
  } catch { return false }
  const after = world.at(bot, b.position.x, b.position.y, b.position.z)
  return !after || after.name !== b.name
}
// A leaf a player standing on the ground can reach: ground to stand on within a step of its column, up to four below it
// (the crown of a tall tree is not walked at - the pathfinder climbed toward it and gave up, 20s a leaf)
function fromGround (bot, p) {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy <= 4; dy++) if (world.standable(bot, p.x + dx, p.y - dy, p.z + dz)) return true
  return false
}
// THE CROWN, A PLAYER'S WAY: leaves are mostly out of reach from the ground - a crown is 40-60 leaves and the ground sees
// the bottom layer: two oak_leaves trips brought 69 and 2 toward a build that wants 1934 (2026-09-29..10-03). Up the
// tree's own trunk column instead - the bottom log dug, stepped into, a filler under the feet each level (towerUp, the
// chop's own climb), every natural leaf of the kind in reach sheared at each level BEFORE the log over the head is dug
// (the logs above keep the crown from decaying while we work), then down our own pillar from the top and the drops picked
// up. The trunk's logs come home too. Returns the leaves got, or -1 when the tree could not be got to.
const LEAF_LOG = { azalea: 'oak', flowering_azalea: 'oak' } // (an azalea tree's trunk is oak)
const logNameFor = s => (LEAF_LOG[s.drops.replace(/_leaves$/, '')] || s.drops.replace(/_leaves$/, '')) + '_log'
const logReFor = s => new RegExp('^' + logNameFor(s) + '$')
function crownLeaves (bot, top, re) {
  return world.findBlocks(bot, re, { maxDistance: 3.6, count: 80, point: top, filter: b => !persistent(b) }).length
}
async function shearCrown (bot, basePos, s, target, ctx = {}) {
  const leafRe = s.blocks; const logRe = logReFor(s)
  const before = inv.count(bot, s.drops)
  // the column: the trunk's logs, bottom up
  let topY = basePos.y
  for (let dy = 1; dy < 16; dy++) { const b = world.at(bot, basePos.x, basePos.y + dy, basePos.z); if (b && logRe.test(b.name)) topY = basePos.y + dy; else break }
  const r = await move.goTo(bot, new goals.GoalNear(basePos.x, basePos.y, basePos.z, 2), { timeoutMs: 40000, place: false, label: 'to the tree', shouldStop: ctx.shouldStop })
  if (!r.ok && !act.reach(bot, basePos, 4.5)) return -1
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  const shearHere = async () => {
    const here = world.findBlocks(bot, leafRe, { maxDistance: 4.5, count: 60, point: eye(), filter: b => !persistent(b) && gather().outOfZones(b) })
    for (const b of here) {
      if (inv.count(bot, s.drops) >= target || stopped(ctx) || inv.freeSlots(bot) < 1) return // (a full pack: the leaves would fall to the ground; audit B3)
      if (act.reach(bot, b.position, 4.5)) await shearBlock(bot, b)
    }
  }
  await shearHere()
  // into the stump column: the bottom log dug, stepped into
  const pillar = []
  if (inv.count(bot, s.drops) < target && !stopped(ctx) && topY - basePos.y >= 1) {
    const b0 = world.at(bot, basePos.x, basePos.y, basePos.z)
    if (b0 && logRe.test(b0.name)) await act.dig(bot, basePos, { timeoutMs: 15000 }).catch(() => false)
    const c0 = world.at(bot, basePos.x, basePos.y, basePos.z)
    if (c0 && world.isAirish(c0)) await move.goTo(bot, new goals.GoalBlock(basePos.x, basePos.y, basePos.z), { timeoutMs: 8000, place: false, label: 'into the stump' })
    const f = bot.entity.position.floored()
    if (f.x === basePos.x && f.z === basePos.z) {
      // up: the head's cells cleared (a log dug, a leaf sheared), a filler under the feet, the crown sheared at each level
      for (let i = 0; i < 12 && inv.count(bot, s.drops) < target && !stopped(ctx) && inv.freeSlots(bot) >= 1; i++) {
        // (a hostile about: down at once, the descent's way - aloft in an open column is no place to meet it)
        if (reflex.hostiles(12).some(h => h.e.name !== 'bat')) break
        const y0 = Math.floor(bot.entity.position.y)
        if (y0 + 2 >= topY) break // (the top log stays over the head - it holds the crown up for the last shear, dug after it; the crown's top layer is still in reach; audit B1)
        for (const dy of [1, 2]) {
          const h = world.at(bot, basePos.x, y0 + dy, basePos.z)
          if (h && logRe.test(h.name)) await act.dig(bot, new Vec3(basePos.x, y0 + dy, basePos.z), { timeoutMs: 15000, noWalk: true }).catch(() => false)
          else if (h && world.LEAF_RE.test(h.name) && !persistent(h)) await shearBlock(bot, h) // (any leaf: another tree's ends the climb otherwise; audit B4)
        }
        if (!await gather().towerUp(bot, { onPlaced: c => pillar.push(c) })) break
        await shearHere()
      }
      await shearHere()
      // the trunk's last logs over the head, now the crown is in the pack
      for (let y = Math.floor(bot.entity.position.y) + 1; y <= topY; y++) { const h = world.at(bot, basePos.x, y, basePos.z); if (h && logRe.test(h.name) && act.reach(bot, h.position, 4.5)) await act.dig(bot, h.position, { timeoutMs: 15000, noWalk: true }).catch(() => false) }
      // down our own pillar, from the top (the chop's way: never a drop beside the body)
      // (THE TRUNK COLUMN IS OURS - fellTree's rule: it held this tree's logs a minute ago, so filler in it now is our pillar
      //  whatever the ledger missed - a lost block left the bot stranded up an open column; audit B2)
      const FILL = require('./build').FILLER_ITEMS
      const ours = c => pillar.some(q => q.x === c.x && q.y === c.y && q.z === c.z) ||
        (c.x === basePos.x && c.z === basePos.z && c.y >= basePos.y && c.y <= topY && (b => !!b && FILL.test(b.name))(world.at(bot, c.x, c.y, c.z)))
      for (let guard = 0; guard < 20; guard++) {
        const me = bot.entity.position; const under = { x: Math.floor(me.x), y: Math.floor(me.y - 0.01), z: Math.floor(me.z) }
        if (!ours(under)) break
        if (!await act.dig(bot, new Vec3(under.x, under.y, under.z), { timeoutMs: 6000, noWalk: true }).catch(() => false)) break
        const t0 = Date.now(); while (!bot.entity.onGround && Date.now() - t0 < 1500) await move.sleep(50)
        const pi = pillar.findIndex(q => q.x === under.x && q.y === under.y && q.z === under.z); if (pi >= 0) pillar.splice(pi, 1)
      }
      if (pillar.length) log('forage', `${pillar.length} pillar block(s) left in the trunk column at ${basePos.x},${basePos.z}`)
    }
  }
  await act.collectDrops(bot, { radius: 7, maxMs: 8000 })
  const got = inv.count(bot, s.drops) - before
  log('forage', `sheared the crown of the tree at ${move.fmt(basePos)}: +${got} ${s.drops}`)
  return got
}
// The nearest wild tree of the leaves' kind with a crown worth the climb (a dozen of its leaves round the trunk's top)
function crownTree (bot, s, skip) {
  const logRe = logReFor(s)
  const me = bot.entity.position; const seen = new Set()
  const logs = world.findBlocks(bot, logRe, { maxDistance: 64, count: 60, filter: b => gather().outOfZones(b) }) // (wild trees only: the orchard's are grown for logs, and its zone refuses the climb's digs)
  const out = []
  for (const b of logs) {
    const bp = gather().trunkBase(bot, b); const k = key(bp)
    if (seen.has(k) || skip.has(k)) continue
    seen.add(k)
    if (Math.abs(bp.y - me.y) > 12 || !gather().isNaturalTree(bot, bp)) continue
    let top = bp; for (let dy = 1; dy < 16; dy++) { const t = world.at(bot, bp.x, bp.y + dy, bp.z); if (t && logRe.test(t.name)) top = t.position; else break }
    if (crownLeaves(bot, top, s.blocks) < 12) continue
    out.push(bp)
  }
  return out.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))[0] || null
}
// Walk to the nearest, cut everything in reach from there, pick up, again. Leaves: a tree's own (never persistent -
// placed leaves are someone's hedge): the crown climbed (shearCrown) while a tree with one is in sight; else from the ground.
async function shearTrip (bot, s, n, ctx = {}) {
  if (!await ensureShears(bot, ctx)) return 'blocked'
  const label = typeof s.drops === 'string' ? s.drops : 'grass'
  const target = inv.count(bot, s.drops) + n
  const skip = new Set()
  const t0 = Date.now(); let empty = 0; let lastKnown = null
  const crownSkip = new Set() // (trees climbed, or that could not be got to: once a trip)
  let noCrown = false
  const ok = b => gather().outOfZones(b) && !skip.has(key(b.position)) && !world.isWaterBlock(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) && (!s.leaves || (!persistent(b) && fromGround(bot, b.position)))
  while (inv.count(bot, s.drops) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (stopped(ctx)) return false
    if (Date.now() - t0 > 15 * 60000) { log('forage', `shearing ${label}: 15 min budget spent`); break }
    await reflex.waitClear()
    if (inv.freeSlots(bot) <= 1) { await base().makeRoom(bot, 3); if (inv.freeSlots(bot) <= 1) return inv.count(bot, s.drops) >= target || 'cut' }
    if (!shearsHeld(bot) && !await ensureShears(bot, ctx)) return inv.count(bot, s.drops) >= target || 'cut'
    if (s.leaves && !noCrown) {
      const tree = crownTree(bot, s, crownSkip)
      if (!tree) noCrown = true // (the scan is dear: once none, the ground's way for the rest of the trip; audit B5)
      else { crownSkip.add(key(tree)); empty = 0; if (await shearCrown(bot, tree, s, target, ctx) > 0) gather().noteResource(label, tree); continue } // (a grove that gave leaves: the next trip's lead)
    }
    const cands = world.findBlocks(bot, s.blocks, { maxDistance: 40, count: 48, filter: ok })
    if (!cands.length) {
      if (++empty > 3) { log('forage', `no ${label} to shear around here`); break }
      noCrown = false // (a walk to new ground: its trees looked at again)
      // (leaves grow on the trees remembered: a leaf spot is noted only once sheared, and the trip with none noted round this
      //  home explored across a lake and came back empty - "a trip for nothing" - with eight oaks remembered 80-130b off,
      //  2026-10-03. The nearest remembered tree of the kind, then the explore)
      const known = gather().knownResource(label, bot.entity.position) || (s.leaves ? gather().knownResource(logNameFor(s), bot.entity.position, { filter: p => !move.inZone(p, 2) }) : null) // (never the orchard's: the crown climb leaves zone trees alone; audit)
      if (known && known !== lastKnown && world.dist2(known, bot.entity.position) > 40) { lastKnown = known; await move.travel(bot, known, { range: 8, shouldStop: ctx.shouldStop, label: 'to ' + label }) } else await gather().explore(bot, x => s.blocks.test(x.name), { shouldStop: ctx.shouldStop, label, legs: 2, accept: b => ok(b) })
      continue
    }
    empty = 0
    const b0 = cands[0]
    gather().noteResource(label, b0.position)
    if (!act.reach(bot, b0.position, 4.4)) {
      const goal = b0.boundingBox === 'block' ? new goals.GoalLookAtBlock(b0.position, bot.world, { reach: 4 }) : new goals.GoalNear(b0.position.x, b0.position.y, b0.position.z, 2)
      const r = await move.goTo(bot, goal, { timeoutMs: 20000, place: false, label: 'to ' + label })
      if (!r.ok && !act.reach(bot, b0.position, 4.6)) { skip.add(key(b0.position)); continue }
    }
    // everything in reach from here, nearest first
    const here = world.findBlocks(bot, s.blocks, { maxDistance: 4.5, count: 40, point: bot.entity.position.offset(0, 1.6, 0), filter: ok })
    let cut = 0
    for (const b of here) {
      if (inv.count(bot, s.drops) + cut >= target || stopped(ctx)) break
      if (!act.reach(bot, b.position, 4.5)) continue
      if (await shearBlock(bot, b)) cut++; else skip.add(key(b.position))
    }
    if (!cut) skip.add(key(b0.position))
    await act.collectDrops(bot, { radius: 6, maxMs: 6000 })
  }
  return inv.count(bot, s.drops) >= target
}

// ---- dug: snow (a shovel's snowballs), moss --------------------------------------------------------------
async function digTrip (bot, raw, s, n, ctx) {
  if (s.tool && !await ensureTool(bot, s.tool, ctx)) { log('forage', `${raw}: no ${s.tool} to be had`); return 'blocked' }
  return gather().mine(bot, raw, { blocks: s.blocks, tool: s.tool, tier: 0 }, n, ctx)
}

// ---- honeycomb ---------------------------------------------------------------------------------------------
// A wild bee nest full of honey (level 5 - the bees fill it over a day of flowers), shears on it, and a campfire under it
// first so the bees stay calm: a player's way, and the one that does not end in a swarm stinging us to poison. The
// campfire stays - the nest is a honey source for the next trip too. Only wild nests: a beehive is someone's.
async function honeyTrip (bot, n, ctx = {}) {
  if (!await ensureShears(bot, ctx)) return 'blocked'
  const target = inv.count(bot, 'honeycomb') + n
  const skip = new Set()
  let looked = 0; let unripe = 0
  while (inv.count(bot, 'honeycomb') < target && looked < 4) {
    if (stopped(ctx)) return false
    await reflex.waitClear()
    const nests = (await world.scanBlocks(bot, /^bee_nest$/, { maxDistance: world.sightReach(bot), count: 24, filter: b => gather().outOfZones(b) && !skip.has(key(b.position)) }))
      .sort((a, b) => world.dist3(a.position, bot.entity.position) - world.dist3(b.position, bot.entity.position))
    const full = nests.filter(b => honeyLevel(b) >= 5)
    if (nests.length) gather().noteResource('bee_nest', nests[0].position)
    if (!full.length) {
      looked++
      if (nests.length) { unripe = nests.length; break }
      const known = gather().knownResource('bee_nest', bot.entity.position)
      if (known && looked === 1 && world.dist2(known, bot.entity.position) > 40) await move.travel(bot, known, { range: 8, shouldStop: ctx.shouldStop, label: 'to the bee nest' })
      else await gather().explore(bot, x => x.name === 'bee_nest', { shouldStop: ctx.shouldStop, label: 'bee nests', legs: 2, accept: b => gather().outOfZones(b) })
      continue
    }
    const nest = full[0]
    if (!await harvestNest(bot, nest, ctx)) skip.add(key(nest.position))
  }
  if (inv.count(bot, 'honeycomb') >= target) return true
  // nests, none full yet: nothing to take today - shut until one is seen full (the survey watches the nests)
  if (unripe) { log('forage', `${unripe} bee nest(s) in sight, none full of honey yet`); return 'waiting' }
  return false
}
async function harvestNest (bot, nest, ctx) {
  if (!await smokeUnder(bot, nest, ctx)) { log('forage', `no room for a campfire under the bee nest at ${move.fmt(nest.position)} - left alone (the bees would swarm)`); return false }
  const r = await move.goTo(bot, new goals.GoalLookAtBlock(nest.position, bot.world, { reach: 4 }), { timeoutMs: 30000, place: false, label: 'to the bee nest' })
  if (!r.ok && !act.reach(bot, nest.position, 4.5)) return false
  const sh = shearsHeld(bot)
  if (!sh) return false
  const before = inv.count(bot, 'honeycomb')
  // (act.useOn: the one right-click on a block - never sneaking, verified by the nest's honey level)
  if (!await act.useOn(bot, nest.position, 'shears', { accept: b => honeyLevel(b) < 5, noWalk: true, timeoutMs: 6000 })) log('forage', `the shears did not take the honey off the nest at ${move.fmt(nest.position)}`)
  await act.collectDrops(bot, { radius: 5, maxMs: 5000 })
  const got = inv.count(bot, 'honeycomb') - before
  log('forage', `sheared the bee nest at ${move.fmt(nest.position)}: +${got} honeycomb`)
  return got > 0
}
// A lit campfire within five blocks under the nest, the air between clear (a leaf stops the smoke): there already,
// or put down on the ground below.
async function smokeUnder (bot, nest, ctx) {
  const p = nest.position
  let ground = null
  for (let dy = 1; dy <= 6; dy++) {
    const b = world.at(bot, p.x, p.y - dy, p.z)
    if (!b) return false
    if (/campfire$/.test(b.name)) return dy <= 5
    if (world.isAirish(b)) continue
    if (dy >= 2 && world.isSolid(b)) ground = { x: p.x, y: p.y - dy + 1, z: p.z }
    break
  }
  if (!ground || p.y - ground.y > 5 || move.inZone(ground, 1)) return false
  if (!inv.has(bot, 'campfire') && !await craft().ensure(bot, 'campfire', 1, Object.assign({}, ctx, { noWithdraw: false })).catch(() => false)) return false
  const ok = await act.place(bot, ground, 'campfire', { faceHint: [[0, -1, 0]] })
  if (ok) log('forage', `campfire under the bee nest at ${move.fmt(p)} (the smoke keeps the bees calm)`)
  return ok
}

// ---- obsidian ---------------------------------------------------------------------------------------------
// Only a diamond pickaxe takes it. A still lava pool's top is quenched: water poured on the rim beside it (never on us),
// the bucket filled again, and the obsidian THAT POUR made taken - cells remembered (mem.obsidianMade), nothing else.
// "Any obsidian in the open" was a player's nether portal frame too (the portal block has no hitbox, so the frame shows
// air beside it) - one dig breaks a portal, and every frame in sight reopened the trip (audit, 2026-09-27). Natural
// obsidian cannot be told from placed obsidian by the block alone, so none is taken. The obsidian with lava beside or
// under it waits (act.dig refuses it too - the hole it leaves must not drain the pool onto us).
// A pool is SHALLOW (solid ground under the lava) and under the open sky: over a deep pool the new obsidian has lava
// under it and act.dig never takes it - the ledger filled with cells no trip could take, and the same lake reopened the
// trip every sighting (audit R4); a cave's lava lake has air over it too, and the bot walked into caves for it (R5,
// 2026-09-27). Only a cell act.dig will take (world.holdsBackLava - its own rule) goes in the ledger; it is dug with
// force (obsidian is not natural terrain - world.NATURAL_RE - but the ledger proves this cell ours) from a solid
// neighbour, never standing on it.
const cellKey = p => `${p.x},${p.y},${p.z}`
// (aged out after a day - an unloaded pool's cells lived for ever - and never a cell inside a zone: our pour made it, but
//  a zone that came later is someone's ground now; audit #10)
const MADE_TTL_MS = 24 * 3600000
function madeCells () { const now = Date.now(); return (mem.get().obsidianMade || []).filter(p => (p.at && now - p.at < MADE_TTL_MS) && !move.inZone(p, 1)) }
function noteMade (cells) { if (cells.length) mem.update(m => { m.obsidianMade = (m.obsidianMade || []).filter(p => p.at && Date.now() - p.at < MADE_TTL_MS).concat(cells.map(p => ({ x: p.x, y: p.y, z: p.z, at: Date.now() }))).slice(-64) }) }
function forgetMade (gone) { const ks = new Set(gone.map(cellKey)); if (ks.size) mem.update(m => { m.obsidianMade = (m.obsidianMade || []).filter(p => !ks.has(cellKey(p))) }) }
// still, shallow lava under the open sky, outside every zone: a pool our pour can set and we can take
function quenchable (bot, b) {
  const p = b.position
  return still(b) && gather().outOfZones(b) && world.isAirish(world.at(bot, p.x, p.y + 1, p.z)) && world.isSolid(world.at(bot, p.x, p.y - 1, p.z)) && world.openSky(bot, p)
}
// obsidian of ours act.dig will take: nothing held back (lava beside, over, or one or two under)
function obsidianTakeable (bot, p) { return !world.holdsBackLava(bot, p) }
// Where to stand to dig p: beside it (feet level with it, or on the neighbour block with feet one up), a floor that is
// not p, no lava within a step - nearest first.
function digStand (bot, p) {
  const me = bot.entity.position
  const out = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
    const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz }
    if (world.standable(bot, q.x, q.y, q.z) && !world.lavaNear(bot, q, 1)) out.push(q)
  }
  return out.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))[0] || null
}
function standsOn (bot, p) { const f = world.feetPos(bot); return f.x === p.x && f.z === p.z && f.y - 1 === p.y }
async function digObsidian (bot, p, ctx) {
  const st = digStand(bot, p)
  if (!st) { log('forage', `obsidian at ${move.fmt(p)}: no solid ground beside it to dig it from`); return false }
  const f = world.feetPos(bot)
  if (f.x !== st.x || f.y !== st.y || f.z !== st.z) {
    const g = await move.goTo(bot, new goals.GoalBlock(st.x, st.y, st.z), { timeoutMs: 30000, shouldStop: ctx.shouldStop, label: 'beside the obsidian' })
    if (!g.ok) return false
  }
  if (standsOn(bot, p) || !act.reach(bot, p, 4.3)) return false
  return act.dig(bot, p, { force: true, noWalk: true, timeoutMs: 40000 })
}
async function obsidianTrip (bot, n, ctx = {}) {
  if (inv.toolTier(bot, 'pickaxe') < 4 && !await craft().ensure(bot, 'diamond_pickaxe', 1, Object.assign({}, ctx, { noWithdraw: false })).catch(() => false)) { log('forage', 'obsidian: no diamond pickaxe to be had'); return 'blocked' }
  const target = inv.count(bot, 'obsidian') + n
  for (let round = 0; round < 3 && inv.count(bot, 'obsidian') < target; round++) {
    if (stopped(ctx)) return false
    // ours no longer there (taken, or someone else's pick): forgotten; an unloaded one waits
    const cells = madeCells().map(p => ({ p, b: world.at(bot, p.x, p.y, p.z) }))
    forgetMade(cells.filter(c => c.b && c.b.name !== 'obsidian').map(c => c.p))
    const me = bot.entity.position
    const ready = cells.filter(c => c.b && c.b.name === 'obsidian' && obsidianTakeable(bot, c.p)).map(c => c.p).sort((a, b) => world.dist3(a, me) - world.dist3(b, me))
    for (const p of ready) {
      if (inv.count(bot, 'obsidian') >= target || stopped(ctx)) break
      if (await digObsidian(bot, p, ctx)) { forgetMade([p]); await act.collectDrops(bot, { radius: 4, maxMs: 4000 }) }
    }
    if (inv.count(bot, 'obsidian') >= target) break
    if (!await quench(bot, ctx)) break
  }
  return inv.count(bot, 'obsidian') >= target
}
// Still lava cells round a pool cell: the snapshot a pour is judged against (a cell of it obsidian afterwards is ours).
function stillLavaAround (bot, L, r = 4) {
  const out = []
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [0, -1]) {
    const b = world.at(bot, L.x + dx, L.y + dy, L.z + dz)
    if (b && still(b)) out.push({ x: L.x + dx, y: L.y + dy, z: L.z + dz })
  }
  return out
}
async function quench (bot, ctx) {
  if (!inv.has(bot, 'water_bucket')) {
    if (!inv.has(bot, 'bucket') && !await craft().ensure(bot, 'bucket', 1, Object.assign({}, ctx, { noWithdraw: false })).catch(() => false)) { log('forage', 'obsidian: no bucket to carry water to the lava'); return false }
    if (!await fillBucket(bot, ctx)) return false
  }
  // (one deadline on the whole attempt: six pools, four rims each, at 40s a walk was 16 minutes at worst - R5)
  const deadline = Date.now() + 4 * 60000
  // a still lava cell open to the air, and beside it a solid rim block with air over it that we can stand back from
  const pools = (await world.scanBlocks(bot, /^lava$/, { maxDistance: world.sightReach(bot), count: 40, filter: b => quenchable(bot, b) }))
    .sort((a, b) => world.dist3(a.position, bot.entity.position) - world.dist3(b.position, bot.entity.position))
  const triedPools = Math.min(6, pools.length)
  for (const L of pools.slice(0, 6)) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (stopped(ctx)) return false
      if (deadline - Date.now() < 5000) { log('forage', 'obsidian: 4 minutes at the lava pools and none quenched - giving up this trip'); return false }
      const rim = { x: L.position.x + dx, y: L.position.y, z: L.position.z + dz }
      const rb = world.at(bot, rim.x, rim.y, rim.z); const over = world.at(bot, rim.x, rim.y + 1, rim.z)
      if (!rb || !world.isSolid(rb) || !over || !world.isAirish(over)) continue
      // where we stand: two out from the rim, on the ground, no lava within two - and the cells between us and the rim
      // open (stray water there runs back at us and over the pour; a block there takes the pour itself)
      const st = { x: rim.x + dx * 2, y: rim.y + 1, z: rim.z + dz * 2 }
      if (!world.standable(bot, st.x, st.y, st.z) || world.lavaNear(bot, st, 2)) continue
      if (![1, 2].every(dy => world.isAirish(world.at(bot, rim.x + dx, rim.y + dy, rim.z + dz)))) continue
      const g = await move.goTo(bot, new goals.GoalBlock(st.x, st.y, st.z), { timeoutMs: Math.min(40000, deadline - Date.now()), shouldStop: ctx.shouldStop, label: 'beside the lava pool' })
      if (!g.ok) continue
      const src = { x: rim.x, y: rim.y + 1, z: rim.z }
      const before = stillLavaAround(bot, L.position)
      if (!await act.pour(bot, src, 'water_bucket', { plans: [{ off: [0, -1, 0] }], accept: b => world.isLiquidWater(b), noWalk: true })) { log('forage', `could not pour the water on the rim of the lava pool at ${move.fmt(L.position)}`); continue }
      // the water runs over the pool: the pool cell turning to obsidian is the sign, a deadline on the wait
      const Lp = L.position
      for (const t0 = Date.now(); Date.now() - t0 < 6000;) { const b = world.at(bot, Lp.x, Lp.y, Lp.z); if (b && b.name === 'obsidian') break; await sleep(250) }
      // the water back (a still source left there floods the pit we dig)
      const back = await act.fill(bot, src, { noWalk: true })
      const made = before.filter(p => { const b = world.at(bot, p.x, p.y, p.z); return b && b.name === 'obsidian' })
      // (only what act.dig will take is ours to count: a cell over the deeper lava is obsidian nobody can take)
      const mine = made.filter(p => obsidianTakeable(bot, p))
      noteMade(mine)
      log('forage', `${made.length ? `quenched the lava pool at ${move.fmt(Lp)}: ${made.length} obsidian made, ${mine.length} of it takeable` : `poured water by the lava pool at ${move.fmt(Lp)} but none of it set`}${back ? '' : ` - the water source at ${move.fmt(src)} could not be taken back up`}`)
      if (mine.length) return true
      if (!inv.has(bot, 'water_bucket')) return false // (the water is left where it ran: no second pour to try with)
    }
  }
  // (which of the two it was: no pool at all, or pools whose every rim failed - one line said "none in sight" for both)
  log('forage', triedPools ? `${triedPools} lava pool(s) in sight but no rim of them worked (standing room, an open way to the rim, or the walk)` : 'no lava pool in sight to quench (still, shallow lava under the open sky, a solid rim with room to stand back)')
  return false
}
// Water buckets: the empty buckets held, filled. A few are carried, not one and not seven: with the only still water
// down in the mine a trip is ~5 minutes, and one bucket a trip was six trips for the castle's six water cells, 2026-09-29.
// Up to three (the bank's first, then made - 3 iron each, kept for good: the pour empties them back for the next trip).
const FILL_BUCKETS = 3
async function fillTrip (bot, n, ctx = {}) {
  const want = Math.max(1, Math.min(n, FILL_BUCKETS))
  if (inv.count(bot, 'bucket') < want && base().bankCount('bucket') > 0) await base().withdraw(bot, 'bucket', want - inv.count(bot, 'bucket')).catch(() => 0)
  // (the first is made whatever it takes; the spares only of ingots already held - never the iron the kit's shield or the
  //  armour is waiting on, and no mining for a convenience; audit)
  if (!inv.has(bot, 'bucket')) await craft().ensure(bot, 'bucket', 1, Object.assign({}, ctx, { noWithdraw: false })).catch(() => false)
  while (inv.count(bot, 'bucket') < want && inv.count(bot, 'iron_ingot') >= 3) { if (!await craft().ensure(bot, 'bucket', inv.count(bot, 'bucket') + 1, Object.assign({}, ctx, { noWithdraw: true })).catch(() => false)) break }
  if (!inv.has(bot, 'bucket')) { log('forage', 'no bucket and none to be made (three iron ingots)'); return 'blocked' }
  let filled = 0
  while (filled < n && inv.has(bot, 'bucket')) {
    if (stopped(ctx) || !await fillBucket(bot, ctx)) break
    filled++
  }
  return filled > 0
}
async function fillBucket (bot, ctx) {
  const scan = async () => (await world.scanBlocks(bot, /^water$/, { maxDistance: world.sightReach(bot), count: 20, filter: b => Number(props(b).level || 0) === 0 && gather().outOfZones(b) && world.isAirish(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) && world.openSky(bot, { x: b.position.x, y: b.position.y + 1, z: b.position.z }) })) // (open sky only: the flooded shaft in the mine meant a 17-19 block dive and a swim up enclosed water - the geometry of the 03:54 drowning; audit)
    .sort((a, b) => world.dist3(a.position, bot.entity.position) - world.dist3(b.position, bot.entity.position))[0]
  let w = await scan()
  // (none in sight - the trip began at the mine's mouth: the nearest REMEMBERED open water, then look again - the lava's and
  //  the trees' way; the band waited on water_bucket for want of it; audit)
  if (!w) {
    const k = gather().knownResource('open_water', bot.entity.position)
    if (k) { log('forage', `no open water in sight - to the one I know at ${move.fmt(k)}`); await move.travel(bot, k, { range: 6, label: 'to open water', maxMs: 120000, shouldStop: ctx.shouldStop }).catch(() => null); w = await scan() }
  }
  if (!w) { log('forage', 'no still water in sight to fill a bucket at'); return false }
  gather().noteResource('open_water', w.position)
  const g = await move.goTo(bot, new goals.GoalNear(w.position.x, w.position.y + 1, w.position.z, 2), { timeoutMs: 40000, label: 'to water' })
  if (!g.ok && !act.reach(bot, w.position, 4)) return false
  // (act.fill: the one bucket fill, true only when the pack holds the water)
  return act.fill(bot, w.position, { noWalk: true })
}

// ---- lava for the furnaces ----------------------------------------------------------------------------------
// A lava bucket burns for a hundred smelts - a coal for eight - and the coal trips brought five a go while the castle's
// bricks and stone sat cold in the chest (2026-09-28). An empty bucket is filled at a still lava SOURCE and carried home
// to the furnaces (smelt.putFuel takes it; the empty bucket comes back out of the fuel slot). Nothing here ever pours
// or places lava: the only use of the bucket is the fill.
// WHERE TO FILL FROM, the obsidian quench's rules: a solid RIM beside the source at the lava's own level, two air cells
// over the rim (the look at the lava passes over it), and the stand one further out - on the rim's level, never on the
// rim itself and never lower than the lava's surface (a stand below the surface is a stand the lava can run down to).
// The stand is standable, has no lava within one, and sees the sky (no walk into a cave for fuel - the obsidian trip's
// lesson, R5). None of the source, the rim or the stand in a zone, under a zone, or under the build: the pool under
// the base or the castle is never touched (taking its source can open a flow nobody is watching).
// Pure over world.at (no walking, no awaits): the offline test drives it with a fake world.
const LAVA_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
function offLimits (p) { return !!(move.inZone(p, 2) || move.underZone(p, 2) || move.underBuild(p)) }
function lavaSource (bot, b) {
  if (!b || !still(b)) return false
  const p = b.position
  return !offLimits(p) && world.isAirish(world.at(bot, p.x, p.y + 1, p.z))
}
function lavaStands (bot, L) {
  const out = []
  for (const [dx, dz] of LAVA_DIRS) {
    const rim = { x: L.x + dx, y: L.y, z: L.z + dz }
    if (!world.isSolid(world.at(bot, rim.x, rim.y, rim.z))) continue
    if (![1, 2].every(dy => world.isAirish(world.at(bot, rim.x, rim.y + dy, rim.z)))) continue
    const stand = { x: rim.x + dx, y: L.y + 1, z: rim.z + dz }
    if (!world.standable(bot, stand.x, stand.y, stand.z) || world.lavaNear(bot, stand, 1) || !world.openSky(bot, stand)) continue
    if (offLimits(rim) || offLimits(stand)) continue
    out.push({ rim, stand })
  }
  return out
}
// Sources whose stand the walk could not reach: not tried again this run (else every fuel decision re-walked at them
// and spent its four minutes before the coal).
const lavaUnreached = new Set()
// Every fill site in sight: { lava, rim, stand, sky }, the open-sky pools first, then the nearest stand.
async function lavaSites (bot, skip = new Set()) {
  const me = bot.entity.position
  const found = await world.scanBlocks(bot, /^lava$/, { maxDistance: world.sightReach(bot), count: 60, filter: b => !skip.has(key(b.position)) && !lavaUnreached.has(key(b.position)) && lavaSource(bot, b) }).catch(() => [])
  const out = []
  for (const b of found) {
    const L = { x: b.position.x, y: b.position.y, z: b.position.z }
    const sky = world.openSky(bot, L)
    for (const s of lavaStands(bot, L)) out.push(Object.assign({ lava: L, sky }, s))
  }
  return out.sort((a, b) => (b.sky - a.sky) || world.dist3(a.stand, me) - world.dist3(b.stand, me))
}
// Empty buckets in the pack, up to `want`: the bank's first, else ONE made from iron already smelted (three ingots, pack
// or bank) - never an iron trip for it; the fuel trip is not worth one.
async function emptyBuckets (bot, want, ctx = {}) {
  if (inv.count(bot, 'bucket') < want && base().bankCount('bucket') > 0) await base().withdraw(bot, 'bucket', want - inv.count(bot, 'bucket')).catch(() => 0)
  if (!inv.has(bot, 'bucket') && inv.count(bot, 'iron_ingot') + base().bankCount('iron_ingot') >= 3) await craft().ensure(bot, 'bucket', 1, Object.assign({}, ctx, { noWithdraw: false })).catch(() => false)
  return Math.min(want, inv.count(bot, 'bucket'))
}
// (how far from home a remembered pool is still a fuel trip: a hundred smelts a bucket is worth a longer walk than
//  coal's five - the pools round this home lie about 200 out; 2026-09-28)
const LAVA_FROM_HOME = 240
// Could a lava trip go now: an empty bucket held, banked or makeable from smelted iron (no walk, no scan).
function bucketsAvailable (bot) {
  const n = inv.count(bot, 'bucket') + base().bankCount('bucket')
  return n > 0 ? n : (inv.count(bot, 'iron_ingot') + base().bankCount('iron_ingot') >= 3 ? 1 : 0)
}
// A pool in sight now, or one remembered from before (gather's resource memory, near home).
async function lavaKnown (bot) {
  if (gather().knownResource('lava_pool', bot.entity.position, { maxFromHome: LAVA_FROM_HOME })) return true
  const s = (await lavaSites(bot))[0]
  if (s) gather().noteResource('lava_pool', s.lava)
  return !!s
}
// Fill up to `buckets` empty buckets with lava. Returns the lava buckets gained. One deadline on the whole trip (the
// quench's four minutes); each walk to a stand bounded by it; each fill verified by the lava bucket in the pack.
async function lavaFuel (bot, buckets, ctx = {}) {
  const had = inv.count(bot, 'lava_bucket')
  const got = () => inv.count(bot, 'lava_bucket') - had
  const n = await emptyBuckets(bot, Math.max(1, buckets), ctx)
  if (!n) { log('forage', 'lava for the furnaces: no empty bucket and none to be made (three iron ingots)'); return 0 }
  const deadline = Date.now() + 4 * 60000
  const skip = new Set()
  let travelled = false
  let why = null
  while (got() < n) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (stopped(ctx)) { why = 'stopped'; break }
    if (deadline - Date.now() < 5000) { why = '4 minutes spent'; break }
    if (!inv.has(bot, 'bucket')) { why = 'no empty bucket left'; break }
    await reflex.waitClear()
    const sites = await lavaSites(bot, skip)
    if (!sites.length) {
      // none in sight: the pool remembered, once (the walk bounded by the trip's own deadline)
      const known = !travelled && gather().knownResource('lava_pool', bot.entity.position, { maxFromHome: LAVA_FROM_HOME })
      if (known && world.dist2(known, bot.entity.position) > 24) {
        travelled = true
        await move.travel(bot, known, { range: 8, shouldStop: ctx.shouldStop, label: 'to the lava pool', maxMs: Math.max(5000, deadline - Date.now() - 60000) })
        continue
      }
      if (known && !got()) gather().forgetResource('lava_pool', known)
      why = 'no still lava in sight with safe ground to fill from'
      break
    }
    const s = sites[0]
    skip.add(key(s.lava)) // (one try a source: filled it is gone, refused it is not tried again this trip)
    gather().noteResource('lava_pool', s.lava)
    const f = world.feetPos(bot)
    if (f.x !== s.stand.x || f.y !== s.stand.y || f.z !== s.stand.z) {
      const g = await move.goTo(bot, new goals.GoalBlock(s.stand.x, s.stand.y, s.stand.z), { timeoutMs: Math.max(3000, Math.min(40000, deadline - Date.now())), shouldStop: ctx.shouldStop, dig: false, place: false, label: 'beside the lava' }) // (no dig, no bridge near a lava pool: a planner step there can open a flow or set the body over it - a pool on open ground is walked to, or skipped; audit)
      if (!g.ok) { if (!stopped(ctx)) lavaUnreached.add(key(s.lava)); log('forage', `lava for the furnaces: could not reach the stand at ${move.fmt(s.stand)} (${g.why})`); continue }
    }
    // (the ground re-read on arrival: the walk may have changed it, or lava come near the stand since the scan)
    if (world.lavaNear(bot, world.feetPos(bot), 1) || !still(world.at(bot, s.lava.x, s.lava.y, s.lava.z))) { log('forage', `lava for the furnaces: the source at ${move.fmt(s.lava)} is no longer safe to fill from`); continue }
    const before = inv.count(bot, 'lava_bucket')
    const ok = await act.fill(bot, s.lava, { liquid: 'lava', noWalk: true })
    // (the lava bucket out of the hand at once: held, any click on a plain face places it - audit)
    if (ok) { const t = inv.bestTool(bot, 'pickaxe', 1) || inv.bestWeapon(bot) || inv.items(bot).find(i => !/bucket$/.test(i.name)); if (t) await bot.equip(t, 'hand').catch(() => {}); else await bot.unequip('hand').catch(() => {}) }
    if (ok && inv.count(bot, 'lava_bucket') > before) log('forage', `filled a lava bucket at ${move.fmt(s.lava)} (${got()} of ${n})`)
    else log('forage', `lava for the furnaces: the bucket did not fill at ${move.fmt(s.lava)}`)
  }
  log('forage', `lava for the furnaces: ${got()} of ${n} bucket(s) filled${why && got() < n ? ' - ' + why : ''}`)
  return Math.max(0, got())
}

// ---- handwork on a placed block -----------------------------------------------------------------------------
// A cell by us to work a block in: open, on solid ground, not ours to keep clear (the door step, the bed, the
// mine's stairs - move.utilitySpotOK), in reach from where we stand.
function benchSpot (bot) {
  const me = bot.entity.position.floored()
  const spots = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, -1, 1]) {
    if (Math.abs(dx) + Math.abs(dz) < 1) continue
    const p = { x: me.x + dx, y: me.y + dy, z: me.z + dz }
    const c = world.at(bot, p.x, p.y, p.z); const below = world.at(bot, p.x, p.y - 1, p.z)
    if (!c || !world.isAirish(c) || !below || !world.isSolid(below) || act.inBody(bot, p) || !act.reach(bot, p, 4)) continue
    if (!move.utilitySpotOK(p, { temporary: true })) continue
    spots.push(Object.assign(p, { d: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) }))
  }
  return spots.sort((a, b) => a.d - b.d)[0] || null
}
// Place the input, use the tool on it, take it back up - n times at one spot. The inventory says what came of it.
// A click that changed nothing twice running on a fresh block is the click itself not working here (2026-09-28: an
// axe under a worn shield, 634 clicks over seven hours) - the run stops, and the same work under the same conditions
// (tool, off-hand) is not tried again; any change of them (another tool, the off-hand emptied, a restart) opens it.
const deadWork = new Map() // label -> conditions key
function stoppedWork () { return [...deadWork.entries()].map(([label, key]) => ({ work: label, stoppedWith: key })) }
function workKey (bot, t) { const o = bot.inventory && bot.inventory.slots[45]; return (t ? t.name : '-') + '|' + (o ? o.name : '-') }
async function workBlocks (bot, { input, tool, becomes, out, n, shouldStop, label }) {
  const t0 = await tool()
  if (deadWork.has(label) && deadWork.get(label) === workKey(bot, t0)) return 0
  deadWork.delete(label)
  let dead = 0
  const spot = benchSpot(bot)
  if (!spot) { log('forage', `${label}: no open ground by me to work on`); return 0 }
  const zone = move.inZone(spot, 0)
  const before = inv.count(bot, out)
  let tries = 0
  for (let i = 0; i < n && tries < n + 3; i++, tries++) {
    if (shouldStop && shouldStop()) break
    const it = inv.items(bot).filter(x => input(x.name)).sort((a, b) => b.count - a.count)[0]
    if (!it) break
    const cur = bot.blockAt(new Vec3(spot.x, spot.y, spot.z))
    if (!cur || !world.isAirish(cur)) break
    if (!await act.place(bot, spot, it.name, { faceHint: [[0, -1, 0]], noWalk: true })) break
    const t = await tool()
    let ok = false
    // (act.useOn: never sneaking - a raw click while the edge guard held sneak carved nothing, "+0", 2026-09-27)
    if (t) ok = await act.useOn(bot, spot, t.name, { accept: b => becomes.test(b.name), noWalk: true, timeoutMs: 4000 })
    // taken back up either way: our own block never stays standing in the yard
    if (!await act.dig(bot, spot, { force: true, noWalk: true, allowZones: zone ? [zone.label] : [] })) { log('forage', `${label}: could not take the block back up at ${move.fmt(spot)}`); break }
    if (!ok) {
      log('forage', `${label}: the ${it.name} did not change`); i--
      if (!t) break
      if (++dead >= 2) { deadWork.set(label, workKey(bot, t)); log('forage', `${label}: ${dead} clicks running changed nothing - the ${t.name} does not work here; not tried again until the tool or the off-hand changes`); break }
    } else dead = 0
  }
  await act.collectDrops(bot, { radius: 4, maxMs: 4000 })
  const made = inv.count(bot, out) - before
  if (made > 0) log('forage', `${label}: ${made} ${typeof out === 'string' ? out : 'made'}`)
  return Math.max(0, made)
}
// An axe on a log strips it (any species - the builder takes any: materials.woodFamilyAlt)
// (exact wood: only the node's own species - stripped_spruce_log of spruce logs)
async function strip (bot, n, { shouldStop, node } = {}) {
  const axe = () => inv.bestTool(bot, 'axe', 1)
  if (!axe() && !await ensureTool(bot, 'axe', { shouldStop })) { log('forage', 'strip: no axe'); return 0 }
  const exact = node && mats().exactWood() && mats().speciesOf(node)
  const input = exact ? nm => nm === exact + '_log' : nm => mats().LOG_ANY.test(nm)
  const out = exact ? new RegExp('^stripped_' + exact + '_log$') : mats().STRIPPED_LOG
  return workBlocks(bot, { input, tool: async () => axe(), becomes: /^stripped_/, out, n, shouldStop, label: 'stripping logs' })
}
// Shears on a pumpkin carve a face in it (and drop its seeds)
async function carve (bot, n, { shouldStop } = {}) {
  if (!await ensureShears(bot, { shouldStop })) return 0
  return workBlocks(bot, { input: nm => nm === 'pumpkin', tool: async () => shearsHeld(bot), becomes: /^carved_pumpkin$/, out: 'carved_pumpkin', n, shouldStop, label: 'carving pumpkins' })
}

// ---- concrete: the powder set in water ----------------------------------------------------------------------
// A still, one-deep water cell by the shore: the powder placed INTO it (against the shore block beside it) sets at
// once; mined back up, it drops in water a step deep, and the pond fills the cell again. Near home first.
function shoreAt (bot, b) {
  if (!b || b.name !== 'water' || Number(props(b).level || 0) !== 0) return null
  const p = b.position
  if (!gather().outOfZones(b) || !world.isAirish(world.at(bot, p.x, p.y + 1, p.z)) || !world.isSolid(world.at(bot, p.x, p.y - 1, p.z))) return null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const s = world.at(bot, p.x + dx, p.y, p.z + dz)
    if (s && world.isSolid(s) && world.standable(bot, p.x + dx, p.y + 1, p.z + dz)) return { water: { x: p.x, y: p.y, z: p.z }, off: [dx, 0, dz] }
  }
  return null
}
async function harden (bot, node, n, { shouldStop } = {}) {
  const powder = node + '_powder'
  if (!inv.count(bot, powder)) return 0
  if (inv.toolTier(bot, 'pickaxe') < 1 && !await ensureTool(bot, 'pickaxe', { shouldStop })) { log('forage', 'concrete: no pickaxe to mine it back up'); return 0 }
  const h = home() || bot.entity.position
  const found = (await world.scanBlocks(bot, /^water$/, { maxDistance: world.sightReach(bot), count: 60, filter: b => !!shoreAt(bot, b) }))
    .sort((a, b) => world.dist3(a.position, h) - world.dist3(b.position, h))[0]
  if (!found) { noteTrip('water', 0, 'no still shallow water by a shore in sight', { searched: true }); return 0 }
  noteTrip('water', 1); gather().noteResource('open_water', found.position) // (a shore's water is open water: remembered for the bucket fills)
  const w = shoreAt(bot, found)
  const cell = w.water
  if (world.dist3(bot.entity.position, cell) > 5) {
    const r = await move.travel(bot, { x: cell.x + w.off[0], y: cell.y + 1, z: cell.z + w.off[2] }, { range: 2, shouldStop, label: 'to the water' })
    if (!r.ok && world.dist3(bot.entity.position, cell) > 5) return 0
  }
  const before = inv.count(bot, node)
  let set = 0
  for (let i = 0; i < n; i++) {
    if (shouldStop && shouldStop()) break
    if (!inv.count(bot, powder)) break
    const placed = await act.place(bot, cell, powder, { faceHint: [w.off], accept: b => b.name === node || b.name === powder })
    if (!placed) break
    let b = null
    for (let k = 0; k < 8; k++) { b = bot.blockAt(new Vec3(cell.x, cell.y, cell.z)); if (b && b.name === node) break; await sleep(100) }
    const hard = !!b && b.name === node
    if (!await act.dig(bot, cell, { force: true })) break
    if (!hard) { log('forage', `the ${powder} did not set at ${move.fmt(cell)} - the water there is gone`); break }
    set++
    await sleep(400) // (the pond runs back into the cell)
  }
  await act.collectDrops(bot, { radius: 6, maxMs: 8000 })
  const made = inv.count(bot, node) - before
  log('forage', `set ${set} ${node} at the water at ${move.fmt(cell)}, ${made} in the pack`)
  return Math.max(0, made)
}

// ---- bone meal: the composter ---------------------------------------------------------------------------
// Bones first (a skeleton's, picked up at night: three meal each), then OUR composter (mem.composter): the tufts in one
// at a time until the seventh layer, a moment for it to set, and the meal out. Only the one we put down: "any composter
// within 24" was a player's, or a cell of a build (audit, 2026-09-27). Nothing to compost, nothing made or put down.
async function compost (bot, n, { shouldStop } = {}) {
  const before = inv.count(bot, 'bone_meal')
  const bones = inv.count(bot, 'bone')
  if (bones > 0) await craft().craftTimes(bot, 'bone_meal', Math.min(bones, Math.ceil(n / 3)), { shouldStop })
  const got = () => inv.count(bot, 'bone_meal') - before
  if (got() >= n) return got()
  const levelOf = b => Number(props(b).level || 0)
  const mine = mem.get().composter
  let bin = mine ? bot.blockAt(new Vec3(mine.x, mine.y, mine.z)) : null
  if (bin && bin.name !== 'composter') { bin = null; mem.set('composter', null) }
  const stuff = () => inv.items(bot).find(i => mats().COMPOSTABLE.test(i.name))
  if (!stuff() && !(bin && levelOf(bin) >= 7)) { log('forage', 'composter: nothing in the pack to compost (sheared grass, ferns, kelp, sea grass) - no bone meal from it'); return got() }
  if (!bin) {
    if (!inv.has(bot, 'composter') && !await craft().ensure(bot, 'composter', 1, { shouldStop }).catch(() => false)) { log('forage', 'no composter and none made'); return got() }
    const spot = benchSpot(bot)
    if (!spot || !await act.place(bot, spot, 'composter', { faceHint: [[0, -1, 0]], noWalk: true })) { log('forage', 'nowhere to put the composter'); return got() }
    bin = bot.blockAt(new Vec3(spot.x, spot.y, spot.z))
    mem.set('composter', { x: spot.x, y: spot.y, z: spot.z })
    log('forage', `composter put down at ${move.fmt(spot)}`)
  }
  const pos = bin.position
  if (!act.reach(bot, pos, 4)) {
    const r = await move.goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), { timeoutMs: 30000, label: 'to the composter' })
    if (!r.ok) { log('forage', `composter: could not get to it at ${move.fmt(pos)}`); return got() }
  }
  const levelAt = () => levelOf(bot.blockAt(pos))
  // the meal out: the composter used (with whatever is in hand), verified by its level dropping
  const empty = async () => { const ok = await act.useOn(bot, pos, null, { accept: b => levelOf(b) < 8, noWalk: true, timeoutMs: 3000 }); await act.collectDrops(bot, { radius: 3, maxMs: 3000 }); return ok }
  let why = null
  // (level 7 sets to 8 a second later - vanilla schedules it 20 ticks on: waited for as a condition with a deadline, not
  //  a 2000-turn guard that let a stuck composter hold the trip ~8 minutes - audit R17b, 2026-09-27)
  let sevenAt = 0
  for (let guard = 0; got() < n && guard < 2000; guard++) {
    if (shouldStop && shouldStop()) { why = 'stopped'; break }
    const lv = levelAt()
    // (one failed emptying ends the trip: out of reach or refused, the loop retried it 2000 times - audit #5)
    if (lv >= 8) { sevenAt = 0; if (!await empty()) { why = `could not empty it at ${move.fmt(pos)}`; break } continue }
    if (lv === 7) {
      if (!sevenAt) sevenAt = Date.now()
      if (Date.now() - sevenAt > 5000) { why = 'it stood at level 7 for 5s and never set'; break }
      await sleep(250); continue
    }
    sevenAt = 0
    const it = stuff()
    if (!it) { why = 'nothing left to compost'; break }
    const had = inv.count(bot, it.name)
    // (act.useOn: never sneaking - a sneaking click is no use, and the layers came to "+0", 2026-09-27)
    if (!await act.useOn(bot, pos, it.name, { accept: () => inv.count(bot, it.name) < had, noWalk: true, timeoutMs: 3000 })) { why = `the composter would not take the ${it.name}`; break }
  }
  if (levelAt() >= 8 && !/could not empty/.test(why || '')) await empty() // (not a second failed click after one)
  log('forage', `composter: ${got()} bone meal (level ${levelAt()} left in it${why ? '; ' + why : ''})`)
  return Math.max(0, got())
}

// The planner's handwork (materials PREFER/ALTS `by`), for makeCrafts: returns the crafts made (units / the yield).
const HANDWORK = {
  strip: (bot, node, n, opts) => strip(bot, n, Object.assign({ node }, opts)),
  carve: (bot, node, n, opts) => carve(bot, n, opts),
  harden: (bot, node, n, opts) => harden(bot, node, n, opts),
  compost: (bot, node, n, opts) => compost(bot, n, opts)
}
async function process (bot, by, node, n, opts = {}) {
  const work = HANDWORK[by]
  if (!work) { log('forage', `no handwork "${by}" for ${node}`); return 0 }
  try { return await work(bot, node, n, opts) } catch (e) { log('forage', `${by} ${node} threw: ${e.message}`); return 0 }
}

module.exports = { stoppedWork, lavaFuel, lavaSites, lavaSource, lavaStands, lavaKnown, bucketsAvailable, handles, spec, gather: gatherRaw, process, exhausted, exhaustedKinds, generation, seen, watch, sightMobs, noteTrip, strip, carve, harden, compost, shearBlock, ensureShears, shearsHeld, benchSpot, shoreAt, SEARCH_TRIPS }
