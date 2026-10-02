'use strict'
// SOMEONE ELSE'S PLACE IS NOT OURS TO DIG. Logged in at another player's base (the account's spawn there), the bot dug a
// bunker in the path by the door, felled the yard's oak, dug through the floor of a room beside its crafting table for
// cobble and walked into the tunnels under it - every dig rule judged blocks one at a time ("natural stone"), none asked
// whose ground it was (2026-10-02). A player knows a base when he sees one: beds, tables, furnaces, chests, doors, paths,
// torches together. Those found here that are not our own make a BOX round them - no block in it is broken (the one dig
// primitive and the planner ask move.isProtected), none placed (the place guard), nothing used, poured or taken (act,
// smelt, food), no target picked in it (gather, mining, clay), and a bot standing in one walks out before anything else
// (director: leaveForeign), on its legs alone. A lone torch or one chest is no base: the score needs a few signs
// together. Villages, igloos, a dungeon with two chests count - a player does not quarry those either.
const world = require('./world')
const mem = require('./memory')
const { log } = require('./log')

// the signs of a player's hand (weight 2), and light (weight 1: a lit cave alone is no base). Not moss carpet: lush caves
// and the pale garden lay it by the thousand (audit)
const MARK_RE = /^(.+_bed|crafting_table|furnace|smoker|blast_furnace|chest|trapped_chest|barrel|ender_chest|(?!iron_).+_door|(?!iron_).+_trapdoor|dirt_path|farmland|(.+_)?glass(_pane)?|tinted_glass|(?!(pale_)?moss_carpet$).+_carpet|.+_sign|lectern|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|flower_pot|cartography_table|smithing_table|fletching_table|loom|grindstone|stonecutter|bell|(soul_)?(wall_)?torch|redstone_(wall_)?torch|(soul_)?lantern)$/
const LIGHT_RE = /torch$|lantern$/
const LINK = 16 // signs this close (x, y and z) are one place
const SCORE = 4 // a place: two furnishings, or one and two lights...
const PAD = 8 // ...and the ground round it out to here, below it as deep
const ROOF = 12 // and above its top sign this far (a house's roof, the yard's trees - never a column to the sky over a cave)
const HOME_GROUNDS = 64 // round home: our own work (a base being set up there is judged by the strict rules below)
const SCAN_R = 64
const EVERY_MS = 8000
const FAR = 512 // a place this far from home and from us is forgotten (seen again, found again)

let bot = null
let timer = null
let scanning = false
let spawnedAt = 0 // the last spawn; a scan BEGUN after it and finished (doneFrom) is what lets the director decide again
let doneFrom = 0
let died = false

function boxes () { return mem.get().foreignBases || [] }

// Is this cell inside somebody else's place? (pure and cheap: the planner asks it for every node)
function covers (p) {
  if (!p) return null
  for (const b of boxes()) if (p.x >= b.x1 && p.x <= b.x2 && p.z >= b.z1 && p.z <= b.z2 && p.y >= b.y1 && p.y <= b.y2) return b
  return null
}
// Within r (x/z) of any place: no home is set there (a home beside their base would make it "home grounds", and theirs)
function near (p, r) {
  if (!p) return null
  return boxes().find(b => p.x >= b.x1 - r && p.x <= b.x2 + r && p.z >= b.z1 - r && p.z <= b.z2 + r) || null
}

// OUR OWN HAND, by record: inside our build, our zones, our mine, beside our own furniture and bunker
function oursByRecord (p) {
  const m = mem.get()
  const bb = buildBox()
  if (bb && p.x >= bb.x1 && p.x <= bb.x2 && p.z >= bb.z1 && p.z <= bb.z2) return true
  try { if (require('./move').inZone(p, 4)) return true } catch {}
  try { const b = require('./mining').mineBox(m.mine); if (b && p.x >= b.x1 - 4 && p.x <= b.x2 + 4 && p.z >= b.z1 - 4 && p.z <= b.z2 + 4 && p.y >= b.y1 - 4 && p.y <= b.y2 + 4) return true } catch {}
  const close = q => q && Math.abs(q.x - p.x) <= 3 && Math.abs(q.y - p.y) <= 3 && Math.abs(q.z - p.z) <= 3
  for (const k of ['tables', 'furnaces', 'chests']) if ((m[k] || []).some(close)) return true
  return !!(close(m.bed) || close(m.bunker))
}
function buildBox () { try { const j = require('./build').getJob(); const b = j && j.box; return b ? { x1: b.x1 - 8, x2: b.x2 + 8, z1: b.z1 - 8, z2: b.z2 + 8 } : null } catch { return null } }
function homeGrounds (p) { const h = mem.get().home; return !!h && Math.hypot(p.x - h.x, p.z - h.z) <= HOME_GROUNDS }
// Ours: by record always; round home too - but never a sign inside a place already known to be someone else's (a home
// set beside their base must not make their base ours; audit)
function ours (p, known = boxes()) {
  if (oursByRecord(p)) return true
  if (!homeGrounds(p)) return false
  return !known.some(b => inBox(p, b))
}
const inBox = (p, b) => p.x >= b.x1 && p.x <= b.x2 && p.z >= b.z1 && p.z <= b.z2 && p.y >= b.y1 && p.y <= b.y2

// The signs in sight, grouped into places: [{x1..z2 (the box), sx1..sz2 (the signs' own extent), score, signs}]
// (pure: offline tests)
function cluster (marks) {
  const n = marks.length
  const parent = marks.map((_, i) => i)
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = marks[i]; const b = marks[j]
    if (Math.abs(a.x - b.x) <= LINK && Math.abs(a.z - b.z) <= LINK && Math.abs(a.y - b.y) <= LINK) parent[find(i)] = find(j)
  }
  const groups = new Map()
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(marks[i]) }
  const out = []
  for (const g of groups.values()) {
    const score = g.reduce((s, q) => s + (LIGHT_RE.test(q.name) ? 1 : 2), 0)
    if (score < SCORE) continue
    const xs = g.map(q => q.x); const ys = g.map(q => q.y); const zs = g.map(q => q.z)
    const s = { sx1: Math.min(...xs), sx2: Math.max(...xs), sy1: Math.min(...ys), sy2: Math.max(...ys), sz1: Math.min(...zs), sz2: Math.max(...zs) }
    out.push(Object.assign(boxOf(s), s, { score, signs: g.length }))
  }
  return out
}
const boxOf = s => ({ x1: s.sx1 - PAD, x2: s.sx2 + PAD, z1: s.sz1 - PAD, z2: s.sz2 + PAD, y1: s.sy1 - PAD, y2: s.sy2 + ROOF })
function overlap (a, b) { return a.x1 <= b.x2 && a.x2 >= b.x1 && a.z1 <= b.z2 && a.z2 >= b.z1 && a.y1 <= b.y2 && a.y2 >= b.y1 }
// two records of one place: the union (a base seen in part - its near half - never shrinks to that part; audit)
function union (a, b) {
  const s = { sx1: Math.min(a.sx1, b.sx1), sx2: Math.max(a.sx2, b.sx2), sy1: Math.min(a.sy1, b.sy1), sy2: Math.max(a.sy2, b.sy2), sz1: Math.min(a.sz1, b.sz1), sz2: Math.max(a.sz2, b.sz2) }
  return Object.assign(boxOf(s), s, { score: Math.max(a.score || 0, b.score || 0), signs: Math.max(a.signs || 0, b.signs || 0) })
}
// Every sign cell of a remembered place lies inside the sphere just scanned (3D: an underground room 35 below a scan from
// the surface was never "seen"; audit)
function seenWhole (b, me) {
  if (b.sx1 == null) return false
  for (const x of [b.sx1, b.sx2]) for (const y of [b.sy1, b.sy2]) for (const z of [b.sz1, b.sz2]) if (Math.hypot(x - me.x, y - me.y, z - me.z) > SCAN_R - 4) return false
  return true
}
// A box over our own work is no one else's: home inside it, or the build's ground under it
function overOurs (b) {
  const h = mem.get().home
  if (h && h.x >= b.x1 && h.x <= b.x2 && h.z >= b.z1 && h.z <= b.z2) return true
  const bb = buildBox()
  return !!bb && b.x1 <= bb.x2 && b.x2 >= bb.x1 && b.z1 <= bb.z2 && b.z2 >= bb.z1
}
const fmtBox = b => `${b.sx1 != null ? b.sx1 : b.x1}..${b.sx2 != null ? b.sx2 : b.x2}, ${b.sz1 != null ? b.sz1 : b.z1}..${b.sz2 != null ? b.sz2 : b.z2} (y ${b.sy1 != null ? b.sy1 : b.y1}..${b.sy2 != null ? b.sy2 : b.y2})`

// One look round
async function scan () {
  if (!bot || !bot.entity || scanning) return
  scanning = true
  const began = Date.now()
  let ok = false
  try {
    const me = bot.entity.position.floored()
    const before = boxes()
    const found = await world.scanBlocks(bot, MARK_RE, { maxDistance: SCAN_R, count: 1500 })
    const marks = found.filter(b => !ours(b.position, before)).map(b => ({ x: b.position.x, y: b.position.y, z: b.position.z, name: b.name }))
    await new Promise(r => setImmediate(r)) // (the event loop back between the filter and the clustering: body first)
    const fresh = cluster(marks).filter(f => !overOurs(f))
    let next = []
    for (const b of before) {
      // (far from home and from us: never walked again - dropped by distance, so covers() stays a short list; audit)
      const h = mem.get().home; const cxz = { x: (b.x1 + b.x2) / 2, z: (b.z1 + b.z2) / 2 }
      // (never a place we have respawned in: a bed of ours in their base - the one place that must be known at a respawn,
      //  before its chunks are even loaded; audit)
      const respawned = (mem.get().respawnedAt || []).some(q => q.x >= b.x1 - 16 && q.x <= b.x2 + 16 && q.z >= b.z1 - 16 && q.z <= b.z2 + 16)
      if (!respawned && Math.hypot(cxz.x - me.x, cxz.z - me.z) > FAR && (!h || Math.hypot(cxz.x - h.x, cxz.z - h.z) > FAR)) continue
      if (overOurs(b)) { log('foreign', `the place at ${fmtBox(b)} lies over my own home or build - not someone else's, forgotten`); continue }
      // (seen whole now and no sign left in it: gone - torn down, or never a base)
      if (seenWhole(b, me) && !fresh.some(f => overlap(f, b))) { log('foreign', `the place at ${fmtBox(b)} has no signs left - forgotten`); continue }
      next.push(b)
    }
    for (const f of fresh) {
      const olds = next.filter(b => overlap(f, b))
      if (!olds.length) log('foreign', `someone else's place at ${fmtBox(f)}: ${f.signs} signs of a player's hand, score ${f.score} - not a block of it broken or placed`)
      next = next.filter(b => !olds.includes(b))
      next.push(Object.assign(olds.reduce(union, f), { at: Date.now() }))
    }
    const key = bs => JSON.stringify(bs.map(b => [b.x1, b.y1, b.z1, b.x2, b.y2, b.z2]))
    if (key(next) !== key(before)) mem.set('foreignBases', next)
    ok = true
  } catch (e) { log('foreign', 'scan threw: ' + e.message) } finally { scanning = false; if (ok) doneFrom = Math.max(doneFrom, began) }
}

// Begun by the director once our own build and zones are known: before them, the castle's far side read as someone else's
function start (b) {
  bot = b
  if (timer) return
  // (records from before the signs' extent was kept: the extent read back off the box)
  const old = boxes()
  if (old.some(x => x.sx1 == null)) mem.set('foreignBases', old.map(x => x.sx1 != null ? x : Object.assign({}, x, { sx1: x.x1 + PAD, sx2: x.x2 - PAD, sz1: x.z1 + PAD, sz2: x.z2 - PAD, sy1: x.y1 + PAD, sy2: x.y1 + PAD, y2: x.y1 + PAD + ROOF })))
  const tick = async () => { await scan(); timer = setTimeout(tick, EVERY_MS) }
  timer = setTimeout(tick, EVERY_MS)
  // (at a spawn the chunks arrive over the first seconds: looked at early, then on the beat)
  // (a respawn far off: the chunks stream in for seconds - a scan of the empty ground there found nothing and let the
  //  director dig; the look waits for them (at most 10s), and the respawn spot is kept: see the prune; audit)
  bot.on('death', () => { died = true })
  bot.on('spawn', async () => {
    spawnedAt = Date.now()
    if (died && bot.entity) { died = false; const p = bot.entity.position.floored(); mem.set('respawnedAt', (mem.get().respawnedAt || []).filter(q => Math.hypot(q.x - p.x, q.z - p.z) > 16).concat([{ x: p.x, y: p.y, z: p.z }]).slice(-4)) }
    await Promise.race([bot.waitForChunksToLoad().catch(() => {}), new Promise(r => setTimeout(r, 10000))])
    await new Promise(r => setTimeout(r, 500))
    while (scanning) await new Promise(r => setTimeout(r, 100))
    await scan()
  })
}

// Walk out of the place we stand in: on our legs alone - no block broken, none placed. Toward home first.
async function leave (bot, { shouldStop } = {}) {
  const move = require('./move')
  const { goals } = require('mineflayer-pathfinder')
  const here = () => covers(world.feetPos(bot))
  if (!here()) return true
  const toward = mem.get().home || bot.entity.position
  const exitsOf = b => {
    const cx = (b.x1 + b.x2) / 2; const cz = (b.z1 + b.z2) / 2
    return [[b.x1 - 4, cz], [b.x2 + 4, cz], [cx, b.z1 - 4], [cx, b.z2 + 4], [b.x1 - 4, b.z1 - 4], [b.x1 - 4, b.z2 + 4], [b.x2 + 4, b.z1 - 4], [b.x2 + 4, b.z2 + 4]].map(([x, z]) => ({ x: Math.round(x), z: Math.round(z) }))
      .sort((a, q) => Math.hypot(a.x - toward.x, a.z - toward.z) - Math.hypot(q.x - toward.x, q.z - toward.z))
  }
  log('foreign', `standing in someone else's place at ${move.fmt(bot.entity.position)} - walking out (no block broken or placed)`)
  // (the place AS IT STANDS at each try: walked through, its unseen parts - their lit tunnels - joined it, and an exit
  //  picked at the start lay inside it; the walk chased it 380 blocks, 2026-10-02. An exit tried once is not tried again)
  const tried = []
  for (let i = 0; i < 8; i++) {
    if (shouldStop && shouldStop()) return false
    const b = here()
    if (!b) break
    const o = exitsOf(b).find(q => !tried.some(t => Math.hypot(t.x - q.x, t.z - q.z) < 24))
    if (!o) break
    tried.push(o)
    // (the ground there, looked for from above the place's top: a goal on the surface, never a tunnel under it)
    const gy = world.groundY(bot, o.x, o.z, Math.max(Math.floor(bot.entity.position.y), b.y2) + 8)
    if (gy != null && covers({ x: o.x, y: gy + 1, z: o.z })) continue // (another place's ground: not out)
    const goal = gy != null ? new goals.GoalNear(o.x, gy + 1, o.z, 3) : new goals.GoalNearXZ(o.x, o.z, 3)
    await move.goTo(bot, goal, { timeoutMs: 60000, stuckMs: 12000, dig: false, place: false, label: 'out of their place', shouldStop })
  }
  if (!here()) { log('foreign', `out of their place at ${move.fmt(bot.entity.position)}`); return true }
  const b1 = here()
  // (no open way: the way out its owner left - a plate or a button by the wall)
  if (await byTheirGate(bot, b1, here, shouldStop)) return true
  // (none: over the wall on blocks of our own - never one taken from their place - each one left said; the operator's
  //  leave, 2026-10-02: "it can use dirt and build its way out")
  if (await overTheWall(bot, b1, exitsOf(b1), here, shouldStop)) return true
  log('foreign', `no way out of their place from ${move.fmt(bot.entity.position)} without breaking a block (no gate that opened, ${scaffoldCount(bot)} blocks of my own to climb out on) - waiting`)
  return false
}

// THE WAY OUT A PLAYER LEFT. A walled base opens by a pressure plate or a button - a piston gate, an iron door: to the
// planner it is a wall like any other, and the bot stood inside the operator's walls "no way out" (2026-10-02). A player
// looks for the plates and buttons by the wall and tries them. Both spring back by themselves - nothing of theirs is left
// changed (never a lever: that one stays where its owner set it). Nearest the place's edge first (a gate is in its wall);
// standing on it (or pressed), the way out past the nearest edge, at once, while it stands open.
const GATE_RE = /_pressure_plate$|_button$/
async function byTheirGate (bot, b0, here, shouldStop) {
  const move = require('./move')
  const { goals } = require('mineflayer-pathfinder')
  const edge = p => Math.min(p.x - b0.x1, b0.x2 - p.x, p.z - b0.z1, b0.z2 - p.z)
  // (a button only beside the gate's own works - a piston or an iron door within 3: in someone's base a button may fire a
  //  dispenser, flush a farm or light TNT; a plate is made to be stepped on; audit)
  const works = p => world.findBlocks(bot, /^(piston|sticky_piston|iron_door)$/, { maxDistance: 3, count: 1, point: p }).length > 0
  const gates = world.findBlocks(bot, GATE_RE, { maxDistance: 128, count: 60 }).filter(a => inBox(a.position, b0) && (/pressure_plate$/.test(a.name) || works(a.position))).sort((a, b) => edge(a.position) - edge(b.position))
  const tried = new Set()
  for (const a of gates) {
    if (tried.size >= 4) break // (four gates a round: one failed leave stays minutes, not half an hour; audit)
    if (shouldStop && shouldStop()) return false
    const p = a.position
    if ([...tried].some(k => { const [x, z] = k.split(',').map(Number); return Math.abs(x - p.x) <= 3 && Math.abs(z - p.z) <= 3 })) continue // (one gate, one try: its twin plates)
    tried.add(p.x + ',' + p.z)
    const plate = /pressure_plate$/.test(a.name)
    const r = await move.goTo(bot, plate ? new goals.GoalBlock(p.x, p.y, p.z) : new goals.GoalNear(p.x, p.y, p.z, 2), { timeoutMs: 45000, stuckMs: 10000, dig: false, place: false, label: 'to their gate', shouldStop })
    if (!r.ok) continue
    log('foreign', `trying their ${a.name} at ${move.fmt(p)} - the way out its owner left`)
    if (!plate) { try { await bot.activateBlock(world.at(bot, p.x, p.y, p.z)) } catch {} }
    await move.sleep(600) // (the pistons' stroke)
    // the way out past the edge nearest the gate, while it stands open
    const ds = [[p.x - b0.x1, b0.x1 - 4, p.z], [b0.x2 - p.x, b0.x2 + 4, p.z], [p.z - b0.z1, p.x, b0.z1 - 4], [b0.z2 - p.z, p.x, b0.z2 + 4]].sort((u, v) => u[0] - v[0])
    for (const [, x, z] of ds.slice(0, 2)) {
      const gy = world.groundY(bot, x, z, Math.max(Math.floor(bot.entity.position.y), b0.y2) + 8)
      const goal = gy != null ? new goals.GoalNear(x, gy + 1, z, 3) : new goals.GoalNearXZ(x, z, 3)
      await move.goTo(bot, goal, { timeoutMs: 30000, stuckMs: 6000, dig: false, place: false, label: 'out through their gate', shouldStop })
      if (!here()) { log('foreign', `out through their gate at ${move.fmt(p)} - now at ${move.fmt(bot.entity.position)}`); return true }
      if (plate) await move.goTo(bot, new goals.GoalBlock(p.x, p.y, p.z), { timeoutMs: 15000, stuckMs: 5000, dig: false, place: false, label: 'back on the plate', shouldStop }).catch(() => null)
      else { try { await bot.activateBlock(world.at(bot, p.x, p.y, p.z)) } catch {} }
    }
  }
  return false
}

// OVER THE WALL on our own blocks: the planner may place (never dig), our scaffold only, and each block left in their place
// is said. Only with blocks in the pack - none are taken from their ground to do it.
const SCAFFOLD_RE = /^(dirt|coarse_dirt|rooted_dirt|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff|netherrack)$/
function scaffoldCount (bot) { return bot.inventory.items().filter(i => SCAFFOLD_RE.test(i.name)).reduce((a, i) => a + i.count, 0) }
let climbing = false
function climbingOut () { return climbing }
async function overTheWall (bot, b0, outs, here, shouldStop) {
  if (scaffoldCount(bot) < 8) return false
  const move = require('./move')
  const { goals } = require('mineflayer-pathfinder')
  const left = []
  const onPlace = (pos) => left.push(pos)
  climbing = true; placedHook = onPlace
  try {
    log('foreign', `no gate opened - climbing out over the wall on my own ${scaffoldCount(bot)} blocks (nothing of theirs broken)`)
    for (const o of outs.slice(0, 3)) {
      if (shouldStop && shouldStop()) break
      await move.goTo(bot, new goals.GoalNearXZ(o.x, o.z, 3), { timeoutMs: 90000, stuckMs: 15000, dig: false, place: true, label: 'over their wall', shouldStop })
      if (!here()) break
    }
  } finally { climbing = false; placedHook = null }
  if (left.length) log('foreign', `left ${left.length} of my blocks in their place climbing out: ${left.slice(0, 20).map(q => q.x + ',' + q.y + ',' + q.z).join(' ')}`)
  if (!here()) { log('foreign', `out over their wall at ${move.fmt(bot.entity.position)}`); return true }
  return false
}
let placedHook = null
function notePlaced (pos) { if (placedHook) placedHook(pos) }

// Has the ground round us been looked at since we last spawned? (a respawn at a bed in someone else's base: no decision
// before the look - a far place was forgotten by distance, and the first task dug before the scan ran; 10s at most)
function looked () { return doneFrom > spawnedAt || Date.now() - spawnedAt > 15000 }

module.exports = { climbingOut, notePlaced, looked, start, scan, covers, near, ours, cluster, union, seenWhole, leave, MARK_RE, PAD, HOME_GROUNDS }
