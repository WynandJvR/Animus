'use strict'
// THE SHEEP PEN: wool that grows back. Every wool was a kill until 2026-09-29 - one wool, the sheep gone - and the flocks
// round home were empty while the castle still wanted ~480. A player fences a few sheep in by the base, leads more in
// with wheat, breeds them, and shears them where they stand; the wool grows back when they eat the grass.
//   the site: a 5x5 paddock (7x7 with its fence ring) of grass 12-30 blocks from home, one level, open sky, clear of the
//             build's ground (+10), every protected zone, the door apron and the mine; the gate on the side facing home.
//             Registered as the 'pen' zone: nothing digs or places there, and walks go round it (a gate opened on the way
//             lets the flock out)
//   stock:    under STOCK_MIN sheep inside, wild ones are led in with wheat in hand (vanilla: a sheep follows a player
//             holding wheat within ~10 blocks), in short legs they keep up with
//   breed:    two adults inside and wheat - each fed once; a sheep fed stays out of love for 5 minutes (vanilla's own
//             rule, by entity id - not a timer on the bot), up to CAP
//   shear:    food.woolFor comes here first when a woolly sheep is inside
// Counted only from close by (SEE): farther off the server may not send the penned sheep, and an unseen pen is not an
// empty one - the last count seen is kept in memory (pen.seen).
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const craft = () => require('./craft')
const base = () => require('./base')
const food = () => require('./food')

const HALF = 2 // the paddock: centre +-2 (5x5); the ring one further out
const SITE_MIN = 12
const SITE_MAX = 30
// (then further out, only when the near ring has none: round home the only ground near level was the castle's own apron,
//  inside its margin - 22 centres - and the rest 5-20 high across the 7x7, 2026-09-29. A pen 60 off is a walk on the wool
//  trips, not a loss)
const SITE_FAR = 64
const BUILD_MARGIN = 10 // (past the build's own ring: underBuild's +8, the site region's +6)
// THE GROUNDWORK'S BUDGET: a player levels the handiest patch - blocks dug off the mounds and dirt put in the dips, two
// high at most (ground.prepare clears two over the floor and fills a hole two deep). "Six columns a block off, none two"
// found no site in the hills round home: 269 centres "not level" of 600, 2026-09-29
const LEVEL_MAX = 2
// (48: round home the 7x7s within two of level took 25-48 blocks - 21 of them - and every other centre was 5-20 high
//  from its lowest column to its highest, or trees; at 24, no site at all, 2026-09-29. A few minutes of spade work)
const LEVEL_BUDGET = 48 // blocks moved, the ring's columns with the paddock's
const STOCK_MIN = 2
const CAP = 8
const LOVE_MS = 5 * 60000 // vanilla: a sheep bred (or fed into love) takes no more wheat for 6000 ticks
const SEE = 40
// (a flock remembered farther from home than this is not led home. 96 at first: the flocks round home were killed for wool
//  before there were shears, and the nearest left were 238-277 out - the pen stood empty. Two led home once, then bred, is
//  the one long walk a player makes; it starts only with the daylight for it: leadTicks)
const LURE_REACH = 320
const leadTicks = d => Math.round(d * 30) + 1200 // (a sheep's pace with the waits, ~1.5s a block, and the walk out)
const FENCE_RE = /_fence$/
const GATE_RE = /_fence_gate$/

function pen () { return mem.get().pen || null }
function centreOf (p) { return { x: (p.box.x1 + p.box.x2) / 2, y: p.box.y, z: (p.box.z1 + p.box.z2) / 2 } }
function outline (p) { return { x1: p.box.x1 - 1, x2: p.box.x2 + 1, z1: p.box.z1 - 1, z2: p.box.z2 + 1, y1: p.box.y - 1, y2: p.box.y + 3 } }
function setZone () { const p = pen(); move.setZone('pen', p ? outline(p) : null) }
// The ring's cells at the paddock's level, the gate's among them.
function ringCells (p) {
  const out = []; const b = p.box
  for (let x = b.x1 - 1; x <= b.x2 + 1; x++) for (let z = b.z1 - 1; z <= b.z2 + 1; z++) {
    if (x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2) continue
    out.push({ x, y: b.y, z })
  }
  return out
}
const isGate = (p, c) => c.x === p.gate.x && c.z === p.gate.z
// Inside the paddock (an entity's position: its feet in one of the 25 cells)
function inPen (pos, p = pen()) {
  if (!p || !pos) return false
  const b = p.box
  return pos.x >= b.x1 && pos.x < b.x2 + 1 && pos.z >= b.z1 && pos.z < b.z2 + 1 && pos.y >= b.y - 1 && pos.y < b.y + 2
}
function outerStep (p) { return { x: p.gate.x + p.dir.x, y: p.box.y, z: p.gate.z + p.dir.z } }
function innerStep (p) { return { x: p.gate.x - p.dir.x, y: p.box.y, z: p.gate.z - p.dir.z } }

// ---- the site ------------------------------------------------------------------------------------
// The paddock centred on (cx,cz), or null. Pure over the world: every block read through world.at.
// (why a centre was refused, tallied by chooseSite for its "no site" line: the first live try found none and said nothing
//  of why, 2026-09-29)
const siteWhy = {}
const no = w => { siteWhy[w] = (siteWhy[w] || 0) + 1; return null }
function siteAt (bot, cx, cz, home) {
  const cols = []
  for (let dx = -HALF - 1; dx <= HALF + 1; dx++) for (let dz = -HALF - 1; dz <= HALF + 1; dz++) {
    const x = cx + dx; const z = cz + dz
    const gy = world.groundY(bot, x, z, home.y + 12)
    if (gy == null) return no('unloaded')
    const g = world.at(bot, x, gy, z)
    // (natural solid ground - water's surface is no ground, nor sand that falls from under a fence)
    if (!g || !world.isSolid(g) || !world.NATURAL_RE.test(g.name) || world.FALLING_RE.test(g.name) || world.LEAF_RE.test(g.name)) return no('ground not natural solid')
    // (feet and head clear: air, or a tuft or flower the groundwork takes - never a bush, a boulder, a trunk)
    for (let dy = 1; dy <= 2; dy++) { const b = world.at(bot, x, gy + dy, z); if (!b || !(world.isAirish(b) || act.PLANT_RE.test(b.name))) return no('something standing on it') }
    cols.push({ x, z, gy, g, inner: Math.abs(dx) <= HALF && Math.abs(dz) <= HALF })
  }
  // one level: the cheapest to level to (blocks dug and filled), none more than LEVEL_MAX off it, within the budget
  const cost = l => cols.reduce((a, c) => a + Math.abs(c.gy - l), 0)
  const levels = [...new Set(cols.map(c => c.gy))].filter(l => cols.every(c => Math.abs(c.gy - l) <= LEVEL_MAX))
  if (!levels.length) { const ys = cols.map(c => c.gy); return no(`not level (${Math.max(...ys) - Math.min(...ys)} high between the lowest and the highest)`) }
  const level = levels.sort((a, b) => cost(a) - cost(b))[0]
  const work = cost(level)
  if (work > LEVEL_BUDGET) return no(`not level (${work > 48 ? 'over 48' : work > 32 ? '33-48' : '25-32'} blocks of groundwork)`)
  // grass inside: a sheep grows its wool back by eating it
  if (cols.filter(c => c.inner && c.g.name === 'grass_block').length < 15) return no('too little grass')
  const y = level + 1
  if (Math.abs(y - home.y) > 6) return no('not at home height')
  for (const [dx, dz] of [[0, 0], [-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]) if (!world.openSky(bot, { x: cx + dx, y, z: cz + dz })) return no('no open sky')
  if (world.lavaNear(bot, { x: cx, y: level, z: cz }, 5) || world.waterNear(bot, { x: cx, y: level, z: cz }, 4, -1, 1)) return no('water or lava near')
  // clear of every zone, the door apron, the mine's way (utilitySpotOK), the safehouse, the build's ground
  let job = null; try { job = require('./build').getJob() } catch {}
  const jb = job && job.box
  const hb = mem.get().hut && mem.get().hut.box
  const near = (b, pad, x, z) => !!b && x >= b.x1 - pad && x <= b.x2 + pad && z >= b.z1 - pad && z <= b.z2 + pad
  for (const c of cols) {
    const p = { x: c.x, y, z: c.z }
    if (move.inZone(p, 1, ['pen']) || !move.utilitySpotOK(p, { except: ['pen'] }) || near(jb, BUILD_MARGIN, c.x, c.z) || near(hb, 3, c.x, c.z)) return no(near(jb, BUILD_MARGIN, c.x, c.z) ? 'the build' : 'a zone, the hut or its apron')
  }
  // the gate on the side facing home, and ground to stand on in front of it
  const hx = home.x - cx; const hz = home.z - cz
  const dir = Math.abs(hx) >= Math.abs(hz) ? { x: Math.sign(hx) || 1, z: 0 } : { x: 0, z: Math.sign(hz) || 1 }
  const gate = { x: cx + dir.x * (HALF + 1), y, z: cz + dir.z * (HALF + 1) }
  const out = { x: gate.x + dir.x, y, z: gate.z + dir.z }
  const og = world.groundY(bot, out.x, out.z, home.y + 12)
  if (og == null || Math.abs(og + 1 - y) > 1 || !world.isSolid(world.at(bot, out.x, og, out.z)) || move.inZone({ x: out.x, y: og + 1, z: out.z }, 0, ['pen'])) return no('no ground before the gate')
  return { box: { x1: cx - HALF, z1: cz - HALF, x2: cx + HALF, z2: cz + HALF, y }, gate, dir, work }
}

// The nearest paddock in the ring round home (12..30 out), or null. A step of 2 between centres; the scan yields between
// candidates (body first).
async function chooseSite (bot) {
  for (const k of Object.keys(siteWhy)) delete siteWhy[k]
  return (await siteIn(bot, SITE_MIN, SITE_MAX, 2)) || siteIn(bot, SITE_MAX, SITE_FAR, 3)
}
async function siteIn (bot, rMin, rMax, stepXZ) {
  const home = mem.get().home
  if (!home) return null
  const cands = []
  for (let dx = -rMax; dx <= rMax; dx += stepXZ) for (let dz = -rMax; dz <= rMax; dz += stepXZ) {
    const d = Math.hypot(dx, dz)
    if (d >= rMin && d <= rMax) cands.push({ x: home.x + dx, z: home.z + dz, d })
  }
  cands.sort((a, b) => a.d - b.d)
  // (the handiest: the least groundwork, a block of it worth two blocks of walk - not the first that passes)
  let best = null
  for (let i = 0; i < cands.length; i++) {
    if (i % 8 === 0) await new Promise(r => setImmediate(r))
    const s = siteAt(bot, cands[i].x, cands[i].z, home)
    if (s && (!best || s.work * 2 + cands[i].d < best.score)) best = { s, score: s.work * 2 + cands[i].d }
  }
  if (best) { const { work, ...site } = best.s; log('pen', `sheep pen site at ${site.box.x1},${site.box.z1} - ${work} blocks of groundwork`); return site }
  return null
}

// Ring cells with no fence (or gate) standing - only where the chunk is loaded: an unread cell is unknown, never missing.
function missing (bot, p = pen()) {
  if (!p) return []
  return ringCells(p).filter(c => { const b = world.at(bot, c.x, c.y, c.z); return b && !(isGate(p, c) ? GATE_RE : FENCE_RE).test(b.name) })
}

// ---- the flock -----------------------------------------------------------------------------------
function sheepIn (bot, p = pen()) {
  if (!p || !bot.entity || world.dist2(bot.entity.position, centreOf(p)) > SEE) return null
  return Object.values(bot.entities).filter(e => e && e.name === 'sheep' && e.position && inPen(e.position, p))
}
// The flock as last seen (the live count when close; memory otherwise): { n, woolly, adults, at } or null
function observe (bot) {
  const p = pen(); const list = sheepIn(bot, p)
  if (!list) return p ? p.seen || null : null
  const seen = { n: list.length, woolly: woolly(bot, list).length, adults: list.filter(e => !food().isBaby(bot, e)).length, at: Date.now() }
  const was = p.seen || {}
  if (was.n !== seen.n || was.woolly !== seen.woolly || was.adults !== seen.adults) mem.update(m => { if (m.pen) m.pen.seen = seen })
  return seen
}

// LOVE: the entity ids fed and when. Vanilla's own rule - a sheep fed wheat is in love, bred or not, and takes none again
// for 5 minutes; fed then, it keeps the wheat and nothing happens. Kept here, not in memory: an id is only good while
// the entity is loaded, and a restart sees new ids.
const fedAt = new Map()
function inLove (id, now = Date.now()) { const t = fedAt.get(id); return t != null && now - t < LOVE_MS }
function noteFed (id, now = Date.now()) { fedAt.set(id, now); for (const [k, t] of fedAt) if (now - t >= LOVE_MS) fedAt.delete(k) }
function breedable (bot, list) { return (list || []).filter(e => !food().isBaby(bot, e) && !inLove(e.id)) }

// Sheep out in the open: in sight, or a flock remembered near home.
function wildKnown (bot, reach = LURE_REACH) {
  if (food().animals(bot, /^sheep$/, 48).length) return true
  const home = mem.get().home || bot.entity.position
  // (a remembered flock only with the daylight to lead it home - a condition, not a failure: without it the task ran and
  //  refused, "did not succeed" every pass; audit rule)
  const p = pen()
  if (mem.get().leadFailDay === require('./day').dayNo(bot)) return false
  return ((mem.get().mobs || {}).sheep || []).some(q => world.dist2(q, home) < reach && (!p || world.ticksUntilNight(bot) >= leadTicks(world.dist2(q, centreOf(p)))))
}

// ---- what the pen wants now ----------------------------------------------------------------------
// ONE rule for the director's trigger and the task: { kind, why } or null.
//   woolWanted: wool the build still needs; wheat: wheat to spare for the pen (pack + bank, bread's share kept back)
function work (bot, { woolWanted = 0, wheat = 0 } = {}) {
  const p = pen()
  // (and only with a flock within the wool reach to lead into it - the morning went on a pen's fence wood 120 blocks out
  //  with the nearest sheep ~190 off, 2026-10-03)
  if (!p) return woolWanted > 0 && wheat >= STOCK_MIN && wildKnown(bot, food().WOOL_REACH) ? { kind: 'build', why: `${woolWanted} wool wanted and no sheep pen - building one by home` } : null
  const gap = missing(bot, p)
  // (an unfinished, empty pen is finished only on the same terms as one is begun: begun before the flock condition, the
  //  hub's pen drove fence-wood trips with no sheep to put in it; audit 2026-10-03)
  if (gap.length) return (woolWanted > 0 && wildKnown(bot, food().WOOL_REACH)) || (observe(bot) || { n: 0 }).n > 0 ? { kind: 'build', why: `the sheep pen's fence has ${gap.length} gap${gap.length > 1 ? 's' : ''}` } : null
  // an open gate, whoever opened it: shut before the flock walks out (audit)
  if (gateOpen(bot, p) && !inPen(bot.entity.position, p)) return { kind: 'gate', why: 'the sheep pen gate stands open' }
  const seen = observe(bot) || { n: 0 }
  if (seen.n < STOCK_MIN && wheat >= 1 && wildKnown(bot)) return { kind: 'stock', why: `${seen.n} sheep in the pen - leading more in with wheat` }
  // THE PEN SHORN BY ITS OWN TASK: woolFor's pen-first call is reached only through the wool trip, and a trip that found no
  // wild sheep is put off for the day - the pen's regrown wool would wait for tomorrow (audit). Out of sight, its last
  // count and the regrowth: a shorn sheep grows it back grazing, most within a few minutes
  if (woolWanted > 0 && (inv.has(bot, 'shears') || base().bankCount('shears') > 0) && woolReady(bot, p)) return { kind: 'shear', why: 'the penned sheep have wool - shearing' }
  const list = sheepIn(bot, p)
  const b = list ? breedable(bot, list).length : 0
  if (list && b >= 2 && list.length < CAP && wheat >= 2 && (woolWanted > 0 || list.length < 4)) return { kind: 'breed', why: `${b} sheep in the pen ready to breed (${list.length} of ${CAP})` }
  return null
}

// ---- the gate ------------------------------------------------------------------------------------
// The gate's state as the world has it (null: not loaded or not a gate)
function gateOpen (bot, p = pen()) {
  const b = p && world.at(bot, p.gate.x, p.gate.y, p.gate.z)
  if (!b || !GATE_RE.test(b.name)) return null
  try { return String(b.getProperties().open) === 'true' } catch { return null }
}
async function setGate (bot, open) {
  const p = pen()
  const ok = b => GATE_RE.test(b.name) && (() => { try { return String(b.getProperties().open) === String(open) } catch { return false } })()
  return act.useOn(bot, p.gate, null, { accept: ok, timeoutMs: 8000 })
}
// (the column, not the block: a step a block off the paddock's level is still the step)
// (from afar - the pen may stand 30-64 out, home the far side of it - the long walk's legs first, then the step: a 20s walk
//  from 100 blocks off failed every time; audit 2026-09-29)
const walk = async (bot, c, label, timeoutMs = 20000, shouldStop) => {
  if (world.dist2(bot.entity.position, c) > 24) await move.travel(bot, { x: c.x, y: c.y, z: c.z }, { range: 3, label, maxMs: 180000, shouldStop }).catch(() => null)
  return move.goTo(bot, new goals.GoalXZ(c.x, c.z), { timeoutMs, stuckMs: 6000, dig: false, place: false, allowZones: ['pen'], label, shouldStop })
}
// In through the gate, shut behind us. False (and the gate shut) when the way in failed.
async function enter (bot) {
  const p = pen()
  if (inPen(bot.entity.position, p)) return true
  if (bot.heldItem && bot.heldItem.name === 'wheat') await bot.unequip('hand').catch(() => {}) // (the flock crowds a gate opened with wheat in sight)
  if (!(await walk(bot, outerStep(p), 'to the pen gate')).ok) return false
  if (!await setGate(bot, true)) return false
  const r = await walk(bot, innerStep(p), 'into the pen', 8000)
  await setGate(bot, false)
  return r.ok
}
// Out through the gate, shut behind us. Wheat out of the hand first: the flock follows it.
async function leave (bot) {
  const p = pen()
  if (bot.heldItem && bot.heldItem.name === 'wheat') await bot.unequip('hand').catch(() => {})
  // (outside already - a lead that failed before the bot was in, a stop on the way: the gate it opened is shut all the
  //  same; left open, the flock walked out after it; audit)
  if (!inPen(bot.entity.position, p)) { if (gateOpen(bot, p)) await shutGate(bot); return true }
  await walk(bot, innerStep(p), 'to the pen gate', 10000)
  await setGate(bot, true)
  const r = await walk(bot, outerStep(p), 'out of the pen', 8000)
  await setGate(bot, false)
  return r.ok
}
// Shut an open gate from whichever side we are on - whoever opened it: our own walk (the planner opens fence gates and
// never shuts them), a failed lead, a player. One rule, work()'s first rung (audit)
async function shutGate (bot) {
  const p = pen()
  if (!gateOpen(bot, p)) return true
  if (!act.reach(bot, new Vec3(p.gate.x, p.gate.y, p.gate.z), 4.3)) await walk(bot, inPen(bot.entity.position, p) ? innerStep(p) : outerStep(p), 'to the open pen gate', 20000)
  const ok = await setGate(bot, false)
  if (ok) log('pen', 'shut the pen gate')
  return ok
}
async function haveWheat (bot, n) {
  if (inv.count(bot, 'wheat') < n) await base().withdraw(bot, 'wheat', Math.max(n, Math.min(16, n + 4)) - inv.count(bot, 'wheat')).catch(() => 0)
  return inv.count(bot, 'wheat') >= n
}
async function wheatInHand (bot, n) {
  if (!await haveWheat(bot, n)) return false
  const w = inv.items(bot).find(i => i.name === 'wheat')
  if (!w) return false
  try { await bot.equip(w, 'hand'); return true } catch { return false }
}

// ---- build ---------------------------------------------------------------------------------------
async function build (bot, { shouldStop } = {}) {
  let p = pen()
  if (!p) {
    const s = await chooseSite(bot)
    if (!s) { log('pen', `no site for a sheep pen ${SITE_MIN}-${SITE_FAR} blocks from home - ${Object.entries(siteWhy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(', ')}`); return false }
    s.wood = craft().preferredWood(bot, 44)
    mem.set('pen', s); p = s
    log('pen', `a sheep pen at ${move.fmt(centreOf(p))}, the gate at ${move.fmt(p.gate)} (${p.wood} fence)`)
  }
  setZone()
  const gap = missing(bot, p)
  if (!gap.length) return true
  const fence = `${p.wood}_fence`; const gateItem = `${p.wood}_fence_gate`
  const fences = gap.filter(c => !isGate(p, c)).length
  const gateGap = gap.some(c => isGate(p, c))
  // (any wood's fence already in the pack does: a fence is a fence)
  const held = () => inv.items(bot).filter(i => FENCE_RE.test(i.name)).reduce((a, i) => a + i.count, 0)
  if (held() < fences && !await craft().ensure(bot, fence, inv.count(bot, fence) + fences - held(), { shouldStop }).catch(() => false)) { log('pen', `no ${fence} for the ${fences} gaps`); return false }
  if (gateGap && !inv.items(bot).some(i => GATE_RE.test(i.name)) && !await craft().ensure(bot, gateItem, 1, { shouldStop }).catch(() => false)) { log('pen', `no ${gateItem}`); return false }
  if (shouldStop && shouldStop()) return false
  // the ground first: tufts and flowers off the ring, a bump taken down, a dip filled - natural blocks only (the groundwork
  // never takes a crafted one), the fences kept
  const o = outline(p)
  await require('./ground').prepare(bot, { x1: o.x1, z1: o.z1, x2: o.x2, z2: o.z2, groundY: p.box.y - 1, height: 2, allowZones: ['pen'], keep: b => FENCE_RE.test(b.name) || GATE_RE.test(b.name) }, { shouldStop, label: 'the sheep pen ground' }).catch(() => 0)
  let placed = 0
  // the gate first: whatever happens after, the ring has a way out of it
  gap.sort((a, b) => isGate(p, b) - isGate(p, a))
  for (const c of gap) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const gateCell = isGate(p, c)
    // placed from OUTSIDE the ring (the cell beyond it, a corner's diagonal): never fenced in by our own fence
    const ox = c.x < p.box.x1 ? -1 : c.x > p.box.x2 ? 1 : 0; const oz = c.z < p.box.z1 ? -1 : c.z > p.box.z2 ? 1 : 0
    const stand = { x: c.x + ox, y: c.y, z: c.z + oz }
    const me = world.feetPos(bot)
    if (me.x !== stand.x || me.z !== stand.z) await move.goTo(bot, new goals.GoalXZ(stand.x, stand.z), { timeoutMs: 15000, stuckMs: 6000, dig: false, place: false, label: 'round the pen' })
    const item = gateCell ? (inv.items(bot).find(i => GATE_RE.test(i.name)) || {}).name : (inv.items(bot).find(i => FENCE_RE.test(i.name)) || {}).name
    if (!item) break
    // the gate faces into the pen (its bar along the ring): placed looking in from the outer step
    const opts = gateCell
      ? { plans: [{ off: [0, -1, 0], yaw: Math.atan2(p.dir.x, p.dir.z) }], accept: b => GATE_RE.test(b.name), allowZones: ['pen'] }
      : { faceHint: [[0, -1, 0]], accept: b => FENCE_RE.test(b.name), allowZones: ['pen'] }
    if (await act.place(bot, c, item, opts)) placed++
  }
  const left = missing(bot, p).length
  log('pen', `placed ${placed} of ${gap.length} (${left ? left + ' gaps left' : 'the ring is whole'})`)
  if (inPen(bot.entity.position, p)) await leave(bot)
  return left === 0
}

// ---- stock: lead wild sheep in with wheat ---------------------------------------------------------
// The lead in legs: the path to the gate planned (half a second's search at most - the body's loop waits on it; a partial
// path is walked and planned on from its end), walked a few nodes at a time; after each leg the followers are
// waited for (within 4), a sheep more than 14 behind is let go. None left following: the lead is over.
// ONE LONG LEAD A DAY: a lead from a remembered flock (out of sight) that failed - a river, the laggards dropped, a fight -
// is not walked again today: each is ~10 minutes of the day away from the build, and the failure cooling was all that
// stood between it and the next (day.js, as the shears; audit)
// (leadFailDay: in memory.json - a restart wiped it; mem.persistedMap's reason)
async function stock (bot, opts = {}) {
  const ctx = { far: false }
  const ok = await stockInner(bot, opts, ctx)
  if (!ok && ctx.far && !(opts.shouldStop && opts.shouldStop())) { mem.set('leadFailDay', require('./day').dayNo(bot)); log('pen', 'the long lead failed - no more long leads today') }
  return ok
}
async function stockInner (bot, { shouldStop } = {}, ctx = {}) {
  const p = pen()
  if (!await wheatInHand(bot, 1)) { log('pen', 'no wheat to lead sheep with'); return false }
  const stop = () => !!(shouldStop && shouldStop())
  let wild = food().animals(bot, /^sheep$/, 48)
  if (!wild.length) {
    const home = mem.get().home || bot.entity.position
    const known = ((mem.get().mobs || {}).sheep || []).filter(q => world.dist2(q, home) < LURE_REACH).sort((a, b) => world.dist2(a, bot.entity.position) - world.dist2(b, bot.entity.position))[0]
    if (!known) { log('pen', 'no sheep in sight or remembered near home to lead in'); return false }
    const far = world.dist2(known, centreOf(p))
    if (world.ticksUntilNight(bot) < leadTicks(far)) { log('pen', `the nearest flock is ${Math.round(far)} blocks from the pen - not enough daylight left to lead it home today`); return false }
    ctx.far = true
    await move.travel(bot, known, { range: 8, shouldStop, label: 'to sheep' })
    wild = food().animals(bot, /^sheep$/, 48)
    if (!wild.length) {
      mem.update(m => { if (m.mobs && m.mobs.sheep) m.mobs.sheep = m.mobs.sheep.filter(q => world.dist2(q, known) >= 32) })
      log('pen', `no sheep where they were seen at ${known.x},${known.z} - forgotten`)
      ctx.far = false // (a stale memory is no failed lead: the next remembered flock may still be walked today; audit)
      return false
    }
  }
  if (stop()) return false
  // to within tempting range of the nearest, wheat in hand
  const first = wild[0]
  if (first.position.distanceTo(bot.entity.position) > 6) await move.goTo(bot, new goals.GoalNear(first.position.x, first.position.y, first.position.z, 5), { timeoutMs: 30000, stuckMs: 8000, dig: false, place: false, label: 'to sheep' })
  await wheatInHand(bot, 1)
  const room = CAP - ((observe(bot) || { n: 0 }).n || 0)
  const t1 = Date.now()
  while (Date.now() - t1 < 6000 && !stop()) { await move.sleep(400); if (food().animals(bot, /^sheep$/, 5).length) break }
  const followers = new Map(food().animals(bot, /^sheep$/, 8).slice(0, Math.max(1, room)).map(e => [e.id, e]))
  if (!followers.size) { log('pen', 'the sheep did not come to the wheat'); return false }
  const lag = () => { let far = 0; for (const [id, e] of followers) { const d = e.isValid === false ? Infinity : e.position.distanceTo(bot.entity.position); if (d > 14) followers.delete(id); else far = Math.max(far, d) } return far }
  const waitUp = async (within, ms) => { const t = Date.now(); while (Date.now() - t < ms && !stop()) { await wheatInHand(bot, 1); if (lag() <= within || !followers.size) return; await move.sleep(300) } }
  const out = outerStep(p)
  const deadline = Date.now() + Math.max(4 * 60000, world.dist2(bot.entity.position, out) * 1500) // (the lead's own length: a flock 250 out)
  let legs = 0
  while (world.dist2(bot.entity.position, out) > 1.5 && Date.now() < deadline && !stop()) {
    await reflex.waitClear()
    if (!followers.size) break
    // (a leg: 6 blocks along the line to the gate, planned by goTo as any walk is - a synchronous path search here held the
    //  event loop up to 500ms a leg, the reflexes with it, out in the open; audit - body first)
    const me = bot.entity.position; const dx = out.x + 0.5 - me.x; const dz = out.z + 0.5 - me.z; const d = Math.hypot(dx, dz)
    const node = d <= 6 ? out : { x: Math.floor(me.x + dx * 6 / d), z: Math.floor(me.z + dz * 6 / d) }
    await wheatInHand(bot, 1)
    const r = await move.goTo(bot, new goals.GoalNearXZ(node.x, node.z, 1), { timeoutMs: 10000, stuckMs: 5000, dig: false, place: false, label: 'leading sheep' })
    if (!r.ok && ++legs > 6) break
    await waitUp(4, 8000)
  }
  if (!followers.size || world.dist2(bot.entity.position, out) > 2) { log('pen', `lost the sheep on the way (${followers.size} still following, ${Math.round(world.dist2(bot.entity.position, out))}b from the gate)`); return false }
  await waitUp(3, 8000)
  const before = (sheepIn(bot, p) || []).length
  // in, to the far side, and the followers after us; out with the wheat stowed
  if (!await setGate(bot, true)) return false
  const far = { x: p.gate.x - p.dir.x * (2 * HALF), y: p.box.y, z: p.gate.z - p.dir.z * (2 * HALF) }
  await wheatInHand(bot, 1)
  await walk(bot, far, 'into the pen', 10000)
  const t2 = Date.now()
  while (Date.now() - t2 < 10000 && !stop()) { if ([...followers.values()].every(e => e.isValid === false || inPen(e.position, p))) break; await move.sleep(300) }
  await leave(bot)
  const now = (sheepIn(bot, p) || []).length
  observe(bot)
  log('pen', `led ${Math.max(0, now - before)} sheep in (${now} in the pen)`)
  return now > before
}

// ---- breed ---------------------------------------------------------------------------------------
async function breed (bot, { shouldStop } = {}) {
  const p = pen()
  const list = sheepIn(bot, p) || []
  const pairs = Math.min(Math.floor(breedable(bot, list).length / 2), CAP - list.length)
  if (pairs < 1) return false
  if (!await haveWheat(bot, pairs * 2)) { log('pen', 'no wheat to breed with'); return false }
  if (!await enter(bot)) { log('pen', 'could not get into the pen'); return false }
  let fed = 0
  for (const e of breedable(bot, sheepIn(bot, p) || []).slice(0, pairs * 2)) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    if (e.isValid === false) continue
    if (e.position.distanceTo(bot.entity.position) > 2.5) await move.goTo(bot, new goals.GoalFollow(e, 1.5), { timeoutMs: 8000, stuckMs: 4000, dig: false, place: false, allowZones: ['pen'], label: 'to a sheep' })
    if (!await wheatInHand(bot, 1)) break
    const w0 = inv.count(bot, 'wheat')
    try { await bot.lookAt(e.position.offset(0, 0.8, 0), true); bot.activateEntity(e) } catch {}
    await move.sleep(400)
    // (fed or not, it is in love or in its cooldown now - vanilla keeps the wheat of one that cannot breed)
    noteFed(e.id)
    if (inv.count(bot, 'wheat') < w0) fed++
  }
  await move.sleep(1500) // (the pairs find each other)
  await leave(bot)
  observe(bot)
  log('pen', `fed wheat to ${fed} sheep (${(sheepIn(bot, p) || []).length} in the pen)`)
  return fed > 0
}

// ---- shear (for food.woolFor) ---------------------------------------------------------------------
// (a lamb has no wool to shear - vanilla's readyForShearing)
function woolly (bot, list) { return (list || []).filter(e => { const w = food().sheepWool(bot, e); return !!w && !w.sheared && !food().isBaby(bot, e) }) }
// Would a trip to the pen find wool? Seen from here, or the last count seen.
const REGROW_MS = 3 * 60000
function woolReady (bot, p = pen()) {
  const list = sheepIn(bot, p)
  if (list) return woolly(bot, list).length > 0
  const s = p && p.seen
  return !!s && s.adults > 0 && (s.woolly > 0 || Date.now() - (s.at || 0) > REGROW_MS)
}
function hasWool (bot) {
  const p = pen(); if (!p) return false
  const list = sheepIn(bot, p)
  if (list) return woolly(bot, list).length > 0
  return !!(p.seen && p.seen.woolly > 0)
}
async function shear (bot, { shouldStop } = {}) {
  const p = pen()
  if (!p || !inv.has(bot, 'shears')) return 0
  const wool = () => inv.count(bot, /_wool$/)
  const w0 = wool()
  if (!sheepIn(bot, p)) await walk(bot, outerStep(p), 'to the sheep pen', 20000, shouldStop)
  if (!woolly(bot, sheepIn(bot, p)).length) { observe(bot); return 0 }
  if (!await enter(bot)) { log('pen', 'could not get into the pen to shear'); return 0 }
  const tried = new Set() // (one try a sheep: one the shears did not take stays skipped this visit)
  for (let i = 0; i < CAP * 2; i++) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    const e = woolly(bot, sheepIn(bot, p)).filter(q => !tried.has(q.id)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!e) break
    if (e.position.distanceTo(bot.entity.position) > 2.5) await move.goTo(bot, new goals.GoalFollow(e, 1.5), { timeoutMs: 8000, stuckMs: 4000, dig: false, place: false, allowZones: ['pen'], label: 'to a sheep' })
    const s = inv.items(bot).find(it => it.name === 'shears')
    if (!s) break
    try { await bot.equip(s, 'hand'); await bot.lookAt(e.position.offset(0, 0.8, 0), true); bot.activateEntity(e) } catch {}
    tried.add(e.id)
    await move.sleep(600)
  }
  // the wool that fell inside, each drop walked at once (never a chase out through the gate)
  const walked = new Set()
  for (let i = 0; i < 16; i++) {
    const d = act.droppedItems(bot, 8).filter(it => !walked.has(it.id) && inPen(it.position, p)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!d) break
    walked.add(d.id)
    await move.goTo(bot, new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5), { timeoutMs: 4000, stuckMs: 2000, dig: false, place: false, allowZones: ['pen'], label: 'pickup' })
    await move.sleep(250)
  }
  await leave(bot)
  observe(bot)
  const got = wool() - w0
  log('pen', `sheared the pen: +${got} wool`)
  return got
}

async function run (bot, kind, opts = {}) {
  if (kind === 'build') return build(bot, opts)
  if (kind === 'stock') return stock(bot, opts)
  if (kind === 'gate') return shutGate(bot)
  if (kind === 'breed') return breed(bot, opts)
  if (kind === 'shear') {
    if (!inv.has(bot, 'shears')) await base().withdraw(bot, 'shears', 1).catch(() => 0)
    const got = await shear(bot, opts)
    observe(bot); if (!got) mem.update(m => { if (m.pen && m.pen.seen) m.pen.seen.at = Date.now() }) // (none to take: the regrowth clock starts again)
    return got > 0
  }
  return false
}

module.exports = { pen, setZone, inPen, siteAt, chooseSite, missing, sheepIn, observe, inLove, noteFed, breedable, work, run, build, stock, breed, shear, hasWool, ringCells, STOCK_MIN, CAP, LOVE_MS }
