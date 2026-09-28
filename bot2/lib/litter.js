'use strict'
// LITTER: the blocks the bot put down to stand on outside any build - a tower's pillar to a tall trunk's top logs, the
// planner's stepping stones - in ONE ledger, taken down by ONE task. The chop's own teardown only works when the body
// ends on its pillar; left on the crown beside it, pillars of 3-5 cobblestone stood on the felled spruces' spots in both
// orchards and the orchard dropped them one by one ("cobblestone there now", 2026-09-28).
// (in memory, saved at most every 30s: a planner laying a bridge notes a block a tick - never a file write each)
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const world = require('./world')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const { log } = require('./log')

const MAX = 400
const RADIUS = 96 // (the ledger's reach round home - and the tidy's)
// A column the tidy could not reach, or reached and could not take, twice is given up on (kept in the ledger, out of the
// count): six 30s walks in a row to the same west-orchard blocks, and the tidy came back for them every run, the castle
// idle 40 minutes (2026-09-28)
const TRIES = 2
const COLUMNS_A_RUN = 12
const k = p => `${p.x},${p.y},${p.z}`
const ledger = new Map((mem.get().litter || []).map(q => [k(q), q]))
let savedAt = 0; let dirty = false
function save (now = false) { if (!dirty || (!now && Date.now() - savedAt < 30000)) return; savedAt = Date.now(); dirty = false; mem.set('litter', [...ledger.values()]) }
const filler = () => require('./build').FILLER_ITEMS // (THE scaffold list)

// the ledger forgets a block the moment it is no longer there - dug by the chop's own teardown, by us, by anyone
let listening = null
function listen (bot) {
  if (listening === bot) return
  listening = bot
  bot.on('blockUpdate', (o, n) => {
    if (!ledger.size) return
    const p = (n && n.position) || (o && o.position); if (!p) return
    const q = ledger.get(k(p)); if (q && (!n || n.name !== q.name)) { ledger.delete(k(p)); dirty = true; save() }
  })
}

// A block of ours put down to stand on, outside the build (the build's ledger and snapshot take its own).
// (placed: the item the placer held - its own word for the block, when the server's update has not landed yet: a
//  tower's body stood on the block while the client still read air, and the re-read refused it, audit 2026-09-28)
function note (bot, p, placed = null) {
  listen(bot)
  const b = world.at(bot, p.x, p.y, p.z)
  const name = b && filler().test(b.name) ? b.name : placed && filler().test(placed) && (!b || world.isAirish(b)) ? placed : null
  if (!name) return
  if (ours(p.x, p.y, p.z)) return
  // (round home only: a far trip's bridges are never walked back to - noted, they would push home's out of the ledger)
  const home = mem.get().home
  if (!home || world.dist3(p, home) > RADIUS) return
  ledger.set(k(p), { x: p.x, y: p.y, z: p.z, name, at: Date.now() })
  if (ledger.size > MAX) ledger.delete(ledger.keys().next().value)
  dirty = true; save()
}

// Cobble of ours placed ON PURPOSE, never litter: a light's post (a torch or lantern on or beside it), a water's edge or
// lid (the farm's, a spring's), and anything within 1 of the infrastructure memory knows (audit 2026-09-28).
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
function infraPoints () {
  const m = mem.get(); const pts = []
  for (const p of [m.home, m.bed, m.spawnSetAt, m.mine && m.mine.entrance, m.farm && m.farm.water]) if (p) pts.push(p)
  for (const l of [m.chests, m.furnaces, m.tables, m.farm && m.farm.cells, m.caps]) if (Array.isArray(l)) pts.push(...l) // (caps: the hole lids fillShaft laid - their top and the block under both within 1)
  return pts
}
function kept (bot, p, pts = infraPoints()) {
  for (const [dx, dy, dz] of SIX) {
    const b = world.at(bot, p.x + dx, p.y + dy, p.z + dz)
    if (b && (/torch|lantern/.test(b.name) || world.isWaterBlock(b))) return true
  }
  const hut = mem.get().hut
  if (hut && hut.box && p.x >= hut.box.x1 - 1 && p.x <= hut.box.x2 + 1 && p.z >= hut.box.z1 - 1 && p.z <= hut.box.z2 + 1 && p.y >= hut.box.y1 - 1 && p.y <= hut.box.y2 + 1) return true
  return pts.some(q => Math.abs(q.x - p.x) <= 1 && Math.abs(q.y - p.y) <= 1 && Math.abs(q.z - p.z) <= 1)
}

// A block with a drop under it that hurts is a lid - a hole's cap, a shaft's plug - not a pillar: a pillar's blocks stand
// on the next of them or on the ground. Taken out, the lid is a hole to fall down (the widened seed found 219, 69 of
// them lone blocks, 2026-09-28)
function capsADrop (bot, p) { return act.fallBelow(bot, p) > world.SAFE_DROP }

// the build's own ground (its zone, its cells) is the build's ledger's and snapshot's - never litter's (an orchard's area
// widened by 3 reaches into the castle's north edge)
// (and everything under the build's footprint at any depth: its foundation is below the build zone's floor, its cells are
//  the job's only once the builder has laid them out after a boot - 42 of the ledger's blocks stood there, y112-117)
function ours (x, y, z) {
  const zn = move.inZone({ x, y, z }); if ((zn && zn.label === 'build') || require('./build').isOpenCell({ x, y, z })) return true
  const j = require('./build').getJob(); const b = j && j.box
  return !!b && x >= b.x1 - 1 && x <= b.x2 + 1 && z >= b.z1 - 1 && z <= b.z2 + 1 && y <= b.y2 + 3
}

// The orchards' ground, spot clusters and all between - not the spots' own boxes: a pillar on a spot is why the orchard
// dropped that spot, so it stood outside every box left (four columns of 3-5 missed by the first seed, 2026-09-28).
// Clusters of spots 6 apart or less, each box widened by 3 (the two orchards apart: home between them is never swept).
function orchardAreas () {
  const spots = ((mem.get().orchard || {}).spots || []).slice()
  const boxes = []
  while (spots.length) {
    const c = [spots.pop()]
    for (let i = 0; i < c.length; i++) for (let j = spots.length - 1; j >= 0; j--) if (Math.abs(spots[j].x - c[i].x) <= 6 && Math.abs(spots[j].z - c[i].z) <= 6) c.push(spots.splice(j, 1)[0])
    const xs = c.map(q => q.x); const ys = c.map(q => q.y); const zs = c.map(q => q.z)
    boxes.push({ x1: Math.min(...xs) - 3, x2: Math.max(...xs) + 3, z1: Math.min(...zs) - 3, z2: Math.max(...zs) + 3, y1: Math.min(...ys) - 2, y2: Math.max(...ys) + 14 })
  }
  return boxes
}

// What was put down before the ledger: in an orchard (the only place a pillar of ours stands on a spot), cobblestone
// out in the open - it never lies on the surface there by itself - with nothing but air, leaves or more of it above.
function seed (bot) {
  listen(bot)
  let n = 0; const pts = infraPoints()
  for (const zb of orchardAreas()) {
    for (let x = zb.x1; x <= zb.x2; x++) for (let z = zb.z1; z <= zb.z2; z++) for (let y = zb.y1; y <= zb.y2; y++) {
      const b = world.at(bot, x, y, z)
      if (!b || b.name !== 'cobblestone' || ledger.has(k({ x, y, z }))) continue
      const up = world.at(bot, x, y + 1, z)
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const s = world.at(bot, x + dx, y, z + dz); return s && world.isAirish(s) })
      if (!open || !up || !(world.isAirish(up) || world.LEAF_RE.test(up.name) || up.name === 'cobblestone') || kept(bot, { x, y, z }, pts) || ours(x, y, z) || capsADrop(bot, { x, y, z })) continue
      ledger.set(k({ x, y, z }), { x, y, z, name: b.name, at: Date.now(), seeded: true }); n++
    }
  }
  if (n) { dirty = true; save(true); log('litter', `found ${n} cobblestone of ours standing in the orchard`) }
  return n
}

// The ledger's blocks still standing within `radius` of `from`.
function pending (bot, from, radius = RADIUS) {
  const out = []
  for (const q of ledger.values()) {
    if (from && world.dist3(q, from) > radius) continue
    const b = world.at(bot, q.x, q.y, q.z)
    if (b && b.name === q.name && (q.tries || 0) < TRIES && !ours(q.x, q.y, q.z)) out.push(q)
  }
  return out
}

// A cell to stand in beside a column, at its foot's level (a step up or down at most), off every column of ours, no drop
// beside it that hurts - the nearest to where the body is.
function standBeside (bot, low) {
  const me = bot.entity.position; let best = null; let bd = Infinity
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, -1, 1]) {
    if (!dx && !dz) continue
    const x = low.x + dx; const y = low.y + dy; const z = low.z + dz
    if (!world.standable(bot, x, y, z) || ledger.has(k({ x, y: y - 1, z }))) continue
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => world.dropAt(bot, x + ax + 0.5, y, z + az + 0.5) > world.SAFE_DROP)) continue
    const d = world.dist3({ x, y, z }, me)
    if (d < bd) { bd = d; best = { x, y, z } }
  }
  return best
}

// A pillar of our own up to a block above the reach (at most 4), and back down from on top after (climbDown). Its blocks
// are litter like any tower's (towerUp notes them): a pillar the teardown missed is the next run's work, never lost.
let climbed = []
async function climbTo (bot, q, shouldStop) {
  const gather = require('./gather')
  // (4 at most: a block higher on a canopy stands on no spot, no path, no farm - a taller tower costs more than it; said as
  //  left, audit 2026-09-28)
  for (let i = 0; i < 4 && !act.reach(bot, q, 4.5) && bot.entity.position.y < q.y; i++) {
    if (shouldStop && shouldStop()) break
    if (!await gather.towerUp(bot, { allowZones: ['orchard', 'base', 'farm'], onPlaced: c => climbed.push(c) })) break
  }
}
async function climbDown (bot) {
  const ours = c => climbed.some(p => p.x === c.x && p.y === c.y && p.z === c.z)
  for (let guard = 0; guard < 12 && climbed.length; guard++) {
    const me = bot.entity.position; const under = { x: Math.floor(me.x), y: Math.floor(me.y - 0.01), z: Math.floor(me.z) }
    if (!ours(under)) break
    if (!await act.dig(bot, new Vec3(under.x, under.y, under.z), { noWalk: true, timeoutMs: 6000, allowZones: ['orchard', 'base', 'farm'] }).catch(() => false)) break
    const t0 = Date.now(); while (!bot.entity.onGround && Date.now() - t0 < 1500) await new Promise(r => setTimeout(r, 50))
    climbed = climbed.filter(p => !(p.x === under.x && p.y === under.y && p.z === under.z))
  }
  climbed = []
}

// Take them down: the nearest column first, top-down, from the ground beside it (the highest a stand reaches). A block
// out of reach from the ground stays in the ledger and is said.
async function tidy (bot, { from, radius = RADIUS, shouldStop } = {}) {
  listen(bot)
  let removed = 0; let left = 0
  const done = new Set()
  // (a run is a batch of COLUMNS, not the whole backlog: a 116-column seed would eat whole days - the rest next gap)
  for (let guard = 0; guard < COLUMNS_A_RUN; guard++) {
    if (shouldStop && shouldStop()) break
    const me = bot.entity.position
    const todo = pending(bot, from || me, radius).filter(q => !done.has(`${q.x},${q.z}`))
    if (!todo.length) break
    todo.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))
    const t = todo[0]
    done.add(`${t.x},${t.z}`)
    const col = todo.filter(q => q.x === t.x && q.z === t.z).sort((a, b) => b.y - a.y)
    const low = col[col.length - 1]
    // (no stepping stones of its own on the way: each one was litter for the next run - 19 pending became 26 taken down)
    // (a stand on the column's own ground, beside it: GoalNear let the planner stop on the ledge above it, a 4-block drop at
    //  the lip, and the bot slipped off twice digging from there - audit 2026-09-28. None such: near it, as before)
    const stand = standBeside(bot, low)
    const r = await move.goTo(bot, stand ? new goals.GoalBlock(stand.x, stand.y, stand.z) : new goals.GoalNear(low.x, low.y, low.z, 2), { timeoutMs: 30000, place: false, allowZones: ['orchard', 'base', 'farm'], label: 'to litter' })
    const miss = () => { for (const q of col) q.tries = (q.tries || 0) + 1; dirty = true }
    // (only a verdict counts against a column: a walk cut by dusk, a creeper or the operator says nothing of it - audit)
    if (!r.ok && !act.reach(bot, low, 4.5)) { left += col.length; if (move.isVerdict(r)) miss(); continue }
    const leftBefore = left
    const pts = infraPoints()
    for (const q of col) {
      // (a pickaxe in hand for every block, the one rule - craft.keepTool: with it worn out mid-tidy, cobble went by hand,
      //  10-50s a block and nothing dropped, 2026-09-28. None to be had: the tidy stops, the tools come first)
      if (!await require('./craft').keepTool(bot, 'pickaxe', { shouldStop })) { log('litter', 'no pickaxe - the tidy waits for one'); save(true); return removed }
      // (a stepping stone can become a light's post or a water's edge after it was noted: asked again at the dig, and let go)
      if (kept(bot, q, pts) || capsADrop(bot, q)) { ledger.delete(k(q)); dirty = true; continue }
      // (above the reach from the ground - a stand of ours left on a tree's crown, 8 up: up to it the way a player does, a
      //  pillar of our own beside it, then that pillar down from on top. From the ground only, such blocks stood for good -
      //  the cobble on the spruce tops the operator asked about, 2026-09-28)
      if (!act.reach(bot, q, 4.5) && q.y > bot.entity.position.y) await climbTo(bot, q, shouldStop)
      if (!act.reach(bot, q, 4.5)) { left++; continue }
      if (await act.dig(bot, new Vec3(q.x, q.y, q.z), { noWalk: true, timeoutMs: 8000, allowZones: ['orchard', 'base', 'farm'] }).catch(() => false)) removed++; else left++
    }
    await climbDown(bot)
    if (left > leftBefore) miss()
    await act.collectDrops(bot, { radius: 5, maxMs: 3000 }).catch(() => {})
  }
  save(true)
  const gaveUp = [...ledger.values()].filter(q => (q.tries || 0) >= TRIES).length
  if (gaveUp) log('litter', `${gaveUp} block${gaveUp > 1 ? 's' : ''} of ours given up on (out of reach twice)`)
  if (removed || left) log('litter', `took down ${removed} block${removed === 1 ? '' : 's'} of ours${left ? `, ${left} left (out of reach from the ground)` : ''}`)
  return removed
}

module.exports = { note, seed, pending, tidy, size: () => ledger.size }
