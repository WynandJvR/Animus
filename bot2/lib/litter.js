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
function note (bot, p) {
  listen(bot)
  const b = world.at(bot, p.x, p.y, p.z)
  if (!b || !filler().test(b.name)) return
  const z = move.inZone(p)
  if ((z && z.label === 'build') || require('./build').isOpenCell(p)) return
  // (round home only: a far trip's bridges are never walked back to - noted, they would push home's out of the ledger)
  const home = mem.get().home
  if (!home || world.dist3(p, home) > RADIUS) return
  ledger.set(k(p), { x: p.x, y: p.y, z: p.z, name: b.name, at: Date.now() })
  if (ledger.size > MAX) ledger.delete(ledger.keys().next().value)
  dirty = true; save()
}

// Cobble of ours placed ON PURPOSE, never litter: a light's post (a torch or lantern on or beside it), a water's edge or
// lid (the farm's, a spring's), and anything within 1 of the infrastructure memory knows (audit 2026-09-28).
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
function infraPoints () {
  const m = mem.get(); const pts = []
  for (const p of [m.home, m.bed, m.spawnSetAt, m.mine && m.mine.entrance, m.farm && m.farm.water]) if (p) pts.push(p)
  for (const l of [m.chests, m.furnaces, m.tables, m.farm && m.farm.cells]) if (Array.isArray(l)) pts.push(...l)
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

// What was put down before the ledger: in an orchard (the only place a pillar of ours stands on a spot), cobblestone
// out in the open - it never lies on the surface there by itself - with nothing but air, leaves or more of it above.
function seed (bot) {
  listen(bot)
  let n = 0; const pts = infraPoints()
  for (const zb of move.zones.filter(z => z.label === 'orchard')) {
    for (let x = zb.x1; x <= zb.x2; x++) for (let z = zb.z1; z <= zb.z2; z++) for (let y = zb.y1; y <= zb.y2; y++) {
      const b = world.at(bot, x, y, z)
      if (!b || b.name !== 'cobblestone' || ledger.has(k({ x, y, z }))) continue
      const up = world.at(bot, x, y + 1, z)
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const s = world.at(bot, x + dx, y, z + dz); return s && world.isAirish(s) })
      if (!open || !up || !(world.isAirish(up) || world.LEAF_RE.test(up.name) || up.name === 'cobblestone') || kept(bot, { x, y, z }, pts)) continue
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
    if (b && b.name === q.name) out.push(q)
  }
  return out
}

// Take them down: the nearest column first, top-down, from the ground beside it (the highest a stand reaches). A block
// out of reach from the ground stays in the ledger and is said.
async function tidy (bot, { from, radius = RADIUS, shouldStop } = {}) {
  listen(bot)
  let removed = 0; let left = 0
  const done = new Set()
  for (let guard = 0; guard < 60; guard++) {
    if (shouldStop && shouldStop()) break
    const me = bot.entity.position
    const todo = pending(bot, from || me, radius).filter(q => !done.has(`${q.x},${q.z}`))
    if (!todo.length) break
    todo.sort((a, b) => world.dist3(a, me) - world.dist3(b, me))
    const t = todo[0]
    done.add(`${t.x},${t.z}`)
    const col = todo.filter(q => q.x === t.x && q.z === t.z).sort((a, b) => b.y - a.y)
    const low = col[col.length - 1]
    const r = await move.goTo(bot, new goals.GoalNear(low.x, low.y, low.z, 2), { timeoutMs: 30000, allowZones: ['orchard', 'base', 'farm'], label: 'to litter' })
    if (!r.ok && !act.reach(bot, low, 4.5)) { left += col.length; continue }
    for (const q of col) {
      if (!act.reach(bot, q, 4.5)) { left++; continue }
      if (await act.dig(bot, new Vec3(q.x, q.y, q.z), { noWalk: true, timeoutMs: 8000, allowZones: ['orchard', 'base', 'farm'] }).catch(() => false)) removed++; else left++
    }
    await act.collectDrops(bot, { radius: 5, maxMs: 3000 }).catch(() => {})
  }
  save(true)
  if (removed || left) log('litter', `took down ${removed} block${removed === 1 ? '' : 's'} of ours${left ? `, ${left} left (out of reach from the ground)` : ''}`)
  return removed
}

module.exports = { note, seed, pending, tidy, size: () => ledger.size }
