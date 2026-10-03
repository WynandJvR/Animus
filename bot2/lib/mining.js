'use strict'
// The mine: one staircase down from near home to a working level, then a serpentine 1x2 tunnel.
// Cobblestone, coal and iron all come out of the same tunnel. Every cell is checked for fluids
// before it is opened; ores visible in the walls are taken; torches keep the tunnel lit.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const base = () => require('./base')
const craft = () => require('./craft')

const LEG_LEN = 40
// the tunnel is 3 wide (openTunnelCell): a leg shifts 4 over, a wall of one between it and the last - shifted 3, the new
// leg ran against the old one and "walled up 3 cave openings" every step: our own tunnel, a third of the cobble put back
const SHIFT = 4
const WANT_ORES = /^(coal_ore|deepslate_coal_ore|iron_ore|deepslate_iron_ore|diamond_ore|deepslate_diamond_ore)$/ // what the bot uses: fuel/torches, iron gear, diamonds (copper/gold/redstone/lapis only filled the pack)
const DIRS = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }]

function V (p) { return new Vec3(p.x, p.y, p.z) }

function fluidAround (bot, p, skip) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz }
    if (skip && skip(q)) continue
    const b = world.at(bot, q.x, q.y, q.z)
    if (!b) return 'unknown'
    if (world.isLavaBlock(b)) return 'lava'
    if (world.isWaterBlock(b)) return 'water'
  }
  return null
}

// Pick a mine entrance: dry, standable ground 10-30 blocks from home, outside protected zones.
// Would a staircase from p heading dir run near a place that has killed us underground, or under a
// protected build? (checked 70 blocks along the way)
function pathBad (p, dir) {
  // (underground by home's own level, not a fixed y60: home at y119, the caves' deaths at y62-75 never counted and a site
  //  beside the skeleton's cave could be chosen once diedInMine stopped counting deaths before a mine; audit 2026-10-03)
  // (a day's deaths, not every one there ever was: thirty deaths over the weeks shut every route near home - the cave
  //  that killed is a cave of the last day, and diedInMine's own memory is three hours; 2026-10-03)
  const deaths = (mem.get().deaths || []).filter(d => d.cause !== 'void' && d.y < ((mem.get().home || {}).y ?? 64) - 8 && Date.now() - (d.t || 0) < 24 * 3600000)
  for (let k = 0; k <= 70; k += 4) {
    const q = { x: p.x + dir.x * k, z: p.z + dir.z * k }
    if (deaths.some(d => world.dist2(d, q) < 24)) return true
    if (underOwnZone(q)) return true
    // (nor through someone else's place, under it or into it: a tunnel at y15 ran into a player's lit strip mine 110 blocks
    //  east, the guard refused every block round it and the mine was "boxed in" and given up, 2026-10-03)
    if ((mem.get().foreignBases || []).some(b => q.x >= b.x1 - 8 && q.x <= b.x2 + 8 && q.z >= b.z1 - 8 && q.z <= b.z2 + 8)) return true
  }
  return false
}
// (the given-up sites that still count: danger for ever, the rest three days - an old record without a day is old,
//  unless a death lies within 16 of it: three of the twelve were mines it died in, recorded before danger was; audit)
function badMinesNow (bot) {
  let dn = null; try { dn = require('./day').dayNo(bot) } catch {}
  const deaths = (mem.get().deaths || []).filter(d => d && d.cause !== 'void' && d.x != null)
  return (mem.get().badMines || []).filter(bm => bm.danger || (bm.day != null ? dn != null && dn - bm.day < 3 : deaths.some(d => world.dist2(d, bm) < 16)))
}
const ENTRANCE_R = 96
function chooseEntrance (bot, oreLv = null) {
  const home = mem.get().home || world.feetPos(bot)
  const levelFor = y => oreLv != null ? Math.min(oreLv, y - 8) : levelOf(y)
  // rings out to 64 blocks, every stair direction: the nearest spot whose staircase stays clear of known death
  // sites and protected builds (one direction from a 10-30 ring left "no safe spot" in cave country)
  let bestOre = null
  // (out to 96 when nothing nearer will do: deaths, given-up sites and someone else's places round home left "no safe spot"
  //  within 64, and no iron at all, 2026-10-03)
  for (let r = 10; r <= ENTRANCE_R; r += 6) {
    const found = []
    for (let a = 0; a < 16; a++) {
      const x = Math.round(home.x + Math.cos(a * Math.PI / 8) * r)
      const z = Math.round(home.z + Math.sin(a * Math.PI / 8) * r)
      const gy = world.groundY(bot, x, z, Math.floor(home.y) + 16)
      if (gy == null) continue
      const y = gy + 1
      if (!world.standable(bot, x, y, z)) continue
      // (nor on the home grounds: a stairwell by the farm was a hole in the yard, on the walk home, dug at night)
      if (move.inZone({ x, y, z }, 6) || underOwnZone({ x, z }) || require('./gather').onGrounds({ x, y, z })) continue
      if (world.waterNear(bot, { x, y, z }, 4, -3, 1) || world.lavaNear(bot, { x, y: y - 2, z }, 3)) continue
      if (badMinesNow(bot).some(bm => world.dist2(bm, { x, z }) < 12)) continue
      const away = Math.abs(x - home.x) > Math.abs(z - home.z) ? { x: Math.sign(x - home.x) || 1, z: 0 } : { x: 0, z: Math.sign(z - home.z) || 1 }
      // every open direction, the one whose covered stairs reach deepest (on a mountain top none reaches y16: the
      // tunnel runs inside the mountain at the depth the cover allows - stone is stone for cobble)
      let bestDir = null
      for (const dir of [away, { x: away.z, z: away.x }, { x: -away.z, z: -away.x }]) {
        if (pathBad({ x, z }, dir)) continue
        const lv = coveredLevel(bot, { x, y, z }, dir, levelFor(y))
        if (lv != null && (!bestDir || lv < bestDir.level)) bestDir = { dir, level: lv }
      }
      if (bestDir) found.push({ x, y, z, dir: bestDir.dir, level: bestDir.level })
    }
    // (for an ore: the spot whose tunnel works nearest the ore's band - out to the next ring when this one has none
    //  within 6; the nearest spot otherwise)
    if (oreLv != null && !found.length && bestOre && r + 6 > ENTRANCE_R) found.push(bestOre)
    if (oreLv != null && found.length) {
      found.sort((a, b) => Math.abs(a.level - oreLv) - Math.abs(b.level - oreLv))
      if (!bestOre || Math.abs(found[0].level - oreLv) < Math.abs(bestOre.level - oreLv)) bestOre = found[0]
      if (Math.abs(bestOre.level - oreLv) > 6 && r + 6 <= ENTRANCE_R) continue
      found.unshift(bestOre)
    }
    if (found.length) {
      const p = found[0]
      if (p.level > levelFor(p.y)) log('mine', `the stairs stay under cover only to y${p.level} here (a hillside) - tunnelling there`)
      return { entrance: { x: p.x, y: p.y, z: p.z }, dir: p.dir, cursor: { x: p.x, y: p.y, z: p.z }, level: p.level, stairsDone: false, leg: 0, legPos: 0, blocks: 0 }
    }
  }
  return null
}
// THE MINE'S LEVELS. One record was one staircase: an ore trip at another depth threw it away and dug a new one from the
// surface - andesite at y97, iron at y108, deepslate under y8: four new entrances round home in one night (2026-09-30).
// Now the mine is one entrance and a chain of levels, each a flight down from the foot of the one before and its own
// tunnel. mem.mine's top-level fields are the ACTIVE level's view (every reader - gather, move, build, director, litter,
// reflex, commands, api - reads entrance/cursor/level as before); mem.mine.levels holds each level's own copy, and
// setActive/saveMine are the one place they are synced.
const LEVEL_FIELDS = ['stairTop', 'stairsEnd', 'stairsDir', 'dir', 'cursor', 'level', 'stairsDone', 'leg', 'legPos', 'shiftDir', 'blocks', 'oreY', 'faceFails', 'caveRun', 'farShift']
const clone = v => v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v))
function copyFields (from, to) { for (const f of LEVEL_FIELDS) { if (from[f] === undefined) delete to[f]; else to[f] = clone(from[f]) } return to }
// (a flight is straight: the stairs step one along and one down, and only a tunnel ever turns)
function flightAt (top, d, y) { const k = top.y - y; return { x: top.x + d.x * k, y, z: top.z + d.z * k } }
// an old one-staircase record becomes level 0 of its own chain (its foot, when its stairs are done, is where they end)
function ensureLevels (m) {
  if (!m || m.levels) return m
  if (!m.stairTop) m.stairTop = clone(m.entrance)
  if (m.stairsEnd === undefined) m.stairsEnd = m.stairsDone ? flightAt(m.stairTop, m.stairsDir || m.dir, m.level) : null
  m.levels = [copyFields(m, {})]; m.active = 0
  return m
}
// every level as it stands now - the active one as its view has it (pure: readers never change the record)
function levelsOf (m) {
  if (!m.levels) return ensureLevels(copyFields(m, { entrance: m.entrance })).levels
  return m.levels.map((L, i) => i === m.active ? copyFields(m, {}) : L)
}
// the view back into its level, level i into the view
function setActive (m, i) { ensureLevels(m); copyFields(m, m.levels[m.active]); copyFields(m.levels[i], m); m.active = i; return m }
function saveMine (m) {
  if (m) { ensureLevels(m); copyFields(m, m.levels[m.active]) }
  mem.set('mine', m)
  const s = mem.get().mine; const L = s && s.levels && s.levels[s.active]
  if (s && (!L || JSON.stringify([s.cursor, s.level, s.blocks]) !== JSON.stringify([L.cursor, L.level, L.blocks]))) log('mine', `MINE VIEW MISMATCH: the view says ${JSON.stringify([s.cursor, s.level, s.blocks])}, level ${s.active} says ${JSON.stringify(L && [L.cursor, L.level, L.blocks])}`)
}
// A level's stair cells, top to foot: to its foot when done, else to the level it is dug for (cells still to come count).
function flightCells (L) {
  const top = L.stairTop; const d = L.stairsDir || L.dir
  if (!top || !d) return []
  const endY = L.stairsEnd ? L.stairsEnd.y : Math.min(L.level, L.cursor ? L.cursor.y : L.level)
  const out = []
  for (let y = top.y; y >= endY; y--) out.push(flightAt(top, d, y))
  return out
}
// WHICH LEVEL for an ore at oreY: the level nearest it (its own band, or the band it was dug for - a y86 hillside over y91
// iron made a y78 level); within 6 it is worked. Deeper than the chain's foot: a new flight down from it. Otherwise (above
// every level, or between two by more than 6) the nearest level is worked - never a new entrance while a mine stands: its
// tunnel still gives stone and whatever shows in its walls. No band (cobble, coal): the active level, unless it works in
// the deepslate (under y8) and a level above it exists - cobble trips there came up with cobbled deepslate.
const DEEPSLATE_Y = 8
function chooseLevel (m, oreY) {
  const Ls = levelsOf(m); const act = m.levels ? m.active : 0
  if (oreY == null) {
    if (Ls[act].level >= DEEPSLATE_Y) return { use: act }
    const up = Ls.map((L, i) => i).filter(i => Ls[i].level >= DEEPSLATE_Y).sort((a, b) => Ls[a].level - Ls[b].level)
    return { use: up.length ? up[0] : act }
  }
  const dist = L => Math.min(Math.abs(L.level - oreY), L.oreY != null ? Math.abs(L.oreY - oreY) : Infinity)
  let best = 0
  Ls.forEach((L, i) => { if (dist(L) < dist(Ls[best])) best = i })
  if (dist(Ls[best]) <= 6) return { use: best }
  const last = Ls.length - 1 // (the chain's foot: every new level descends from the last one made)
  if (oreY < Math.min(...Ls.map(L => L.level))) return { descend: last, target: oreY, near: best }
  return { use: best, apart: true }
}
// WHERE A NEW FLIGHT STARTS: one cell out from the foot of level `fromIdx`'s stairs, heading away from its tunnel's legs
// (away from the side the legs shift to first, then back, then the shift side, then on). None of its first three cells may
// lie under any level's stairs with less than two blocks of rock between the new cut's roof and the old stair's floor
// (the flight is cut three high: a stair cell 0-5 above a new cell in its column): a flight dug under a flight takes the
// floor out from under it. Nor the start of a level we gave up on (m.badLevels), nor under a protected build.
function descentStart (m, fromIdx) {
  const Ls = levelsOf(m); const F = Ls[fromIdx]
  const foot = F.stairsEnd || F.cursor
  const head = F.stairsDir || F.dir
  const shift = F.shiftDir || { x: -head.z, z: head.x }
  const stairs = Ls.flatMap(flightCells)
  const bad = m.badLevels || []
  const seen = new Set()
  for (const dir of [{ x: -shift.x, z: -shift.z }, { x: -head.x, z: -head.z }, shift, head]) {
    const dk = dir.x + ',' + dir.z
    if (seen.has(dk)) continue
    seen.add(dk)
    const start = { x: foot.x + dir.x, y: foot.y, z: foot.z + dir.z }
    const cells = [0, 1, 2].map(k => ({ x: start.x + dir.x * k, y: start.y - k, z: start.z + dir.z * k }))
    if (cells.some(c => stairs.some(s => s.x === c.x && s.z === c.z && s.y - c.y >= 0 && s.y - c.y <= 5))) continue
    if (bad.some(b => b.x === start.x && b.z === start.z && Math.abs(b.y - start.y) <= 1)) continue
    if (cells.some(c => underOwnZone(c))) continue
    return { start, dir: { x: dir.x, z: dir.z } }
  }
  return null
}
function descend (m, fromIdx, target, oreY) {
  const s = descentStart(m, fromIdx)
  if (!s || target > s.start.y - 4) return false
  ensureLevels(m)
  const fromY = levelsOf(m)[fromIdx].level
  m.levels.push({ stairTop: clone(s.start), stairsEnd: null, stairsDir: clone(s.dir), dir: clone(s.dir), cursor: clone(s.start), level: target, stairsDone: false, legPos: 0, leg: 0, blocks: 0, oreY })
  setActive(m, m.levels.length - 1)
  log('mine', `a new level: stairs down from y${fromY} at ${move.fmt(s.start)} heading ${s.dir.x},${s.dir.z} to y${target} - no new entrance`)
  return true
}
const saidApart = new Set()
function pickLevel (m, ore, itemName) {
  ensureLevels(m)
  const c = chooseLevel(m, ore ? ore.y : null)
  const from = m.active
  if (c.descend != null && !descend(m, c.descend, c.target, ore.y)) { log('mine', `no way down from the level at y${levelsOf(m)[c.descend].level} clear of the stairs above - working the level at y${levelsOf(m)[c.near].level}`); c.use = c.near }
  if (c.use != null && c.use !== m.active) setActive(m, c.use)
  if (c.apart && !saidApart.has(itemName + ore.y)) { saidApart.add(itemName + ore.y); log('mine', `the ${itemName} band y${ore.y} is above or between the mine's levels - working level y${m.level}, no new entrance`) }
  if (m.active !== from) { if (c.descend == null) log('mine', `${itemName}: working the mine's level at y${m.level}`); saveMine(m) }
  return m
}
// The mine's extent, for what guards it (the build's scaffold rules, the table rule): the box over the entrance and every
// level's stair top, stair foot and face. (Asked per cell by the build's scans: no copies, a plain loop.)
function mineBox (m = mem.get().mine) {
  if (!m || !m.entrance) return null
  const b = { x1: m.entrance.x, y1: m.entrance.y, z1: m.entrance.z, x2: m.entrance.x, y2: m.entrance.y, z2: m.entrance.z }
  const add = p => { if (!p) return; if (p.x < b.x1) b.x1 = p.x; if (p.x > b.x2) b.x2 = p.x; if (p.y < b.y1) b.y1 = p.y; if (p.y > b.y2) b.y2 = p.y; if (p.z < b.z1) b.z1 = p.z; if (p.z > b.z2) b.z2 = p.z }
  add(m.stairTop); add(m.stairsEnd); add(m.cursor) // (the view: the active level as it stands)
  for (const L of m.levels || []) { add(L.stairTop); add(L.stairsEnd); add(L.cursor) }
  return b
}
function levelOf (y) { return Math.max(12, Math.min(y - 20, 16)) }
// WHERE AN ORE IS: the tunnel's level for an ore trip - the 5-high band (the tunnel and the walls in reach of it) with
// the most of that ore in the rock round home. The mine always went to y12-16: on a mountain the iron is in the
// mountain, and a 110-block tunnel at y20 turned up none while veins sat in the rock 10 blocks from the door (2026-09-25).
// Only rock at least 8 under home's level (a tunnel under cover); null when no band holds enough to be worth a trip.
async function oreLevel (bot, itemName) {
  const g = craft().GATHER[itemName]
  const home = mem.get().home
  if (!g || !g.ore || !home) return null
  // (the rock UNDER home at every depth: one sphere round home at y119 saw nothing under y55, so the only band it could find
  //  was the thin one at y79-87 - worked dry three times while iron's own band lay deeper, 2026-10-02; audit. Spheres down
  //  the column, the counts pick the band)
  const ores = []; const seenK = new Set()
  const floorY = (bot.game && bot.game.minY != null) ? bot.game.minY : -64
  for (let y = home.y; y > floorY; y -= 48) {
    for (const b of await world.scanBlocks(bot, g.blocks, { maxDistance: 64, count: 6000, point: new (require('vec3').Vec3)(home.x, y, home.z) })) { const k = b.position.x + ',' + b.position.y + ',' + b.position.z; if (!seenK.has(k)) { seenK.add(k); ores.push(b) } }
  }
  const at = new Map()
  for (const b of ores) if (b.position.y <= home.y - 8) at.set(b.position.y, (at.get(b.position.y) || 0) + 1)
  let best = null
  for (const y of at.keys()) {
    let n = 0
    for (let dy = -1; dy <= 3; dy++) n += at.get(y + dy) || 0
    if (n >= 6 && (!best || n > best.n)) best = { y: y + 1, n }
  }
  // (the bands as counted - the evidence for the level a trip goes to)
  { const top = [...at.keys()].map(y => { let n = 0; for (let dy = -1; dy <= 3; dy++) n += at.get(y + dy) || 0; return { y: y + 1, n } }).sort((p, q) => q.n - p.n).filter((b, i, l) => l.findIndex(o => Math.abs(o.y - b.y) < 5) === i).slice(0, 3); if (top.length) log('mine', `${itemName} in the rock under home by band: ${top.map(b => 'y' + b.y + ' ' + b.n).join(', ')}`) }
  // (none in the scan's 64 - deepslate 112 under a hilltop home: where we saw it ourselves, under home's depth, is its level)
  // (a remembered spot we can see now must still hold the item's own block - noted before a kind was narrowed, or dug
  //  since, it is no find)
  // (deepslate is solid rock only under y0: a remembered block at y5 is one in the stone's mixed band, and a level dug
  //  there for it came up with cobblestone; 2026-09-30)
  const still = p => { const b = world.at(bot, p.x, p.y, p.z); return !b || g.blocks.test(b.name) }
  if (!best) { const kn = require('./gather').knownResource(itemName, home, { maxFromHome: 96, filter: p => p.y <= home.y - 8 && still(p) }); if (kn) best = { y: (itemName === 'cobbled_deepslate' ? Math.min(kn.y, 0) : kn.y) + 1, n: 1 } }
  return best
}
// Does a staircase from p heading dir stay under the ground all the way down to `level`? The stairs drop one a step; on
// a mountain the slope drops faster, and a staircase heading downhill came out of the hillside into open air at y86-103
// - "the stairs are blocked, far above the working depth" - four new mines in twelve minutes (2026-09-24). Each step
// past the first few needs the surface over it above the stair's own head room; unloaded ground is unknown (no).
// Returns the deepest level the stairs reach under cover (at most `level`), or null when they are out in the open
// before they are 8 below the entrance (no mine worth the name: a tunnel needs rock over it).
function coveredLevel (bot, p, dir, level) {
  let deepest = null
  for (let k = 4; k <= p.y - level; k++) {
    const x = p.x + dir.x * k; const z = p.z + dir.z * k
    const gy = world.groundY(bot, x, z, p.y + 8)
    if (gy == null || gy < p.y - k + 3) break
    deepest = p.y - k
  }
  // (the tunnel legs run level from there: its own run needs cover too - a few steps back up keeps it inside)
  if (deepest == null || p.y - deepest < 8) return null
  return Math.min(p.y - 8, deepest + 4)
}

let broken = 0 // blocks the tunnel has broken - the mine loop's one sign of progress (a step through open cells breaks none)
async function openCell (bot, p) {
  for (let i = 0; i < 8; i++) {
    const b = world.at(bot, p.x, p.y, p.z)
    if (!b) return false
    if (world.isAirish(b)) return true
    if (world.isWaterBlock(b) || world.isLavaBlock(b)) return false
    if (/^(bedrock|chest|spawner|barrel)$/.test(b.name) || b.hardness < 0) return false
    if (!world.NATURAL_RE.test(b.name) && !/_planks$|rail|fence|cobweb/.test(b.name)) return false // don't dig through structures
    const ok = await act.dig(bot, p, { force: true, timeoutMs: 12000 })
    if (!ok) return false
    broken++
    await move.sleep(world.FALLING_RE.test(b.name) ? 700 : 60)
  }
  return world.isAirish(world.at(bot, p.x, p.y, p.z))
}

// Block to fill a hole with: stone the castle has no use for first, cobblestone (castle material) last.
// (least-needed first: the walls and floors spent andesite - the castle wants ~1,000 - and the cobble the trip was for;
//  cobblestone is the scaffold's, the foundation's and the stone's, andesite the castle's own; audit 2026-09-29)
const FILLER_ORDER = ['netherrack', 'tuff', 'cobbled_deepslate', 'dirt', 'diorite', 'cobblestone', 'andesite']
function fillerItem (bot) {
  for (const n of FILLER_ORDER) { const it = inv.items(bot).find(i => i.name === n); if (it) return it }
  return null
}

// (a floor of gravel or sand that rests on nothing - followed down through a stack of them: gravel on gravel over air falls
//  as one when a neighbour is dug; audit)
function fallingOverNothing (bot, x, y, z) {
  let b = world.at(bot, x, y, z); if (!b || !world.FALLING_RE.test(b.name)) return false
  for (let k = 1; k < 8; k++) { b = world.at(bot, x, y - k, z); if (!b || !world.isSolid(b)) return true; if (!world.FALLING_RE.test(b.name)) return false }
  return true
}
async function ensureFloor (bot, p) {
  let below = world.at(bot, p.x, p.y - 1, p.z)
  if (!below) return false
  // (gravel or sand with nothing under it is no floor: it falls the moment a neighbour is dug - a stair floor of gravel over
  //  a 12-deep cave dropped the bot 13 and the gravel came down on its head, suffocated at y9, 2026-10-03. Taken out, let
  //  fall, and stone put in its place)
  if (world.isSolid(below) && world.FALLING_RE.test(below.name)) {
    if (fallingOverNothing(bot, p.x, p.y - 1, p.z)) {
      log('mine', `${below.name} over nothing at ${move.fmt({ x: p.x, y: p.y - 1, z: p.z })} - taking it out for a floor of stone`)
      if (!await act.dig(bot, { x: p.x, y: p.y - 1, z: p.z }, { force: true, noWalk: true, timeoutMs: 8000 }).catch(() => false)) return false
      await move.sleep(700)
      below = world.at(bot, p.x, p.y - 1, p.z)
      if (!below) return false
      if (world.FALLING_RE.test(below.name)) return false // (more fell in: the step is blocked, the leg turns)
    }
  }
  if (world.isSolid(below)) return true
  if (world.isLavaBlock(below)) return false
  const filler = fillerItem(bot)
  if (!filler) return false
  return act.place(bot, { x: p.x, y: p.y - 1, z: p.z }, filler.name)
}

async function stepInto (bot, p) {
  // never step onto nothing: a floor that did not get placed turned the next step into a 19-block fall
  const floor = world.at(bot, p.x, p.y - 1, p.z)
  if (!floor || !world.isSolid(floor)) { log('mine', `no floor under ${move.fmt(p)} - not stepping`); return false }
  // one cell along the tunnel (level or a step down): walk it with the keys - a pathfinder plan per block
  // cost a second or two each and capped the mine at ~8 steps a minute
  const me = bot.entity.position
  const adjacent = Math.abs(Math.floor(me.x) - p.x) + Math.abs(Math.floor(me.z) - p.z) === 1 && (Math.floor(me.y) === p.y || Math.floor(me.y) - 1 === p.y)
  if (adjacent && !require('./reflex').active()) {
    const tx = p.x + 0.5; const tz = p.z + 0.5
    const t0 = Date.now()
    try {
      while (Date.now() - t0 < 1500) {
        const q = bot.entity.position
        if (Math.hypot(q.x - tx, q.z - tz) < 0.25 && Math.floor(q.y) === p.y) break
        await bot.look(Math.atan2(-(tx - q.x), -(tz - q.z)), 0, true).catch(() => {})
        bot.setControlState('forward', true)
        await move.sleep(50)
      }
    } finally { bot.setControlState('forward', false) }
    const q = bot.entity.position
    if (Math.floor(q.x) === p.x && Math.floor(q.z) === p.z && Math.floor(q.y) === p.y) return true
  }
  const r = await move.goTo(bot, new goals.GoalBlock(p.x, p.y, p.z), { timeoutMs: 8000, stuckMs: 4000, dig: false, place: false, label: 'mine step' })
  return r.ok
}

// Take ores visible from the tunnel (within reach, exposed to the tunnel air).
let alsoWant = null // a stone kind the build wants (granite): taken from the walls like an ore while mining for it
async function takeWallOres (bot) {
  const me = world.feetPos(bot)
  let took = 0
  for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
    const p = { x: me.x + dx, y: me.y + dy, z: me.z + dz }
    const b = world.at(bot, p.x, p.y, p.z)
    if (!b || !(WANT_ORES.test(b.name) || (alsoWant && alsoWant.test(b.name)))) continue
    if (!world.hasAirNeighbour(bot, p)) continue
    if (!inv.canHarvest(bot, b)) continue
    if (fluidAround(bot, p)) continue
    // only from where we stand: walking out to an ore in a cave wall walked the bot off a ledge from y16
    // to y2 (death, iron armour in the grave)
    if (!act.reach(bot, p, 4.3)) continue
    if (await act.dig(bot, p, { force: true, timeoutMs: 10000, noWalk: true })) took++
  }
  if (took) await act.collectDrops(bot, { radius: 5, maxMs: 6000 })
  return took
}

async function maybeTorch (bot, m) {
  if (m.blocks % 7 !== 0) return
  const torch = inv.items(bot).find(i => i.name === 'torch')
  if (!torch) {
    if (inv.count(bot, 'coal') + inv.count(bot, 'charcoal') >= 2 && inv.count(bot, 'stick') >= 2) await craft().ensure(bot, 'torch', 8, { noWithdraw: true }).catch(() => {})
    return
  }
  const me = world.feetPos(bot)
  // on the floor just behind us
  const back = { x: me.x - m.dir.x, y: me.y, z: me.z - m.dir.z }
  const cell = world.at(bot, back.x, back.y, back.z)
  if (cell && world.isAirish(cell)) await act.place(bot, back, 'torch', { faceHint: [[0, -1, 0]], sneak: false }).catch(() => {})
}

function mineShouldPause (bot, ctx) {
  if (ctx.shouldStop && ctx.shouldStop()) return 'stopped'
  if (bot.food <= 6 && !inv.foodItems(bot).length) return 'no food'
  // low health alone does not stop mining (without food it never regenerates, so that would be a
  // deadlock: no mining -> no tools -> no food); very low health, or hurt with a mob close, does
  if (bot.health <= 4) return 'hurt'
  if (bot.health <= 8 && require('./reflex').hostiles(10).length) return 'hurt and a mob is close'
  if (inv.toolTier(bot, 'pickaxe') < 1) return 'no pickaxe'
  return null
}

// (craft.keepTool: the one rule. The table it put down for the pick comes back into the pack at once: the mine moves on,
//  and a table left in the tunnel at y37 was "missing" from the tools two minutes later - the rung that makes one pulled
//  the bot out of the mine up 100 blocks of stairs for it, 2026-09-29. The task's end sweep only takes tables within 8)
async function ensurePick (bot) { const ok = await craft().keepTool(bot, 'pickaxe', { noWithdraw: false }); await craft().packUpTables(bot).catch(() => {}); return ok }

// Keep enough in the pack for the mine: a spare pickaxe's worth of sticks and a table.
let provisioning = false
async function provisionForMine (bot) {
  // never re-entered: a pickaxe that needs cobble that needs a mine that needs provisioning recursed
  // 7500 times in a second (2026-09-15)
  if (provisioning) return
  provisioning = true
  try { await provisionInner(bot) } finally { provisioning = false }
}
async function provisionInner (bot) {
  // sticks for every pickaxe the trip can wear out: a stone pick is ~131 blocks, and the pack's free room is the most a
  // trip digs. Four sticks were two picks: at the y20 face both wore out and the third could not be made (no wood
  // underground) - the bot climbed out digging stone by hand (2026-09-25).
  const sticks = Math.min(64, 2 * Math.ceil(inv.freeSlots(bot) * 64 / 131) + 2)
  if (inv.count(bot, 'stick') < sticks) await craft().ensure(bot, 'stick', sticks).catch(() => {})
  if (!inv.has(bot, 'crafting_table')) await craft().ensure(bot, 'crafting_table', 1).catch(() => {})
  // a spare pickaxe: one wearing out mid-tunnel ends the trip (stone picks last ~130 blocks)
  const picks = inv.items(bot).filter(i => /_pickaxe$/.test(i.name) && inv.tierOf(i.name) >= 2)
  // the spare from the chest first, else one made from banked cobble - withdrawals only, never mining for it
  // (a pickaxe worn out at y30 with no spare meant climbing out through stone by hand at 7.5s a block)
  const b = base()
  if (picks.length < 2 && b.bankCount('stone_pickaxe') > 0) await b.withdraw(bot, 'stone_pickaxe', 1).catch(() => 0)
  const picks2 = inv.items(bot).filter(i => /_pickaxe$/.test(i.name) && inv.tierOf(i.name) >= 2 && inv.durabilityLeft(bot, i) > 20)
  if (picks2.length < 2) {
    if (inv.count(bot, 'cobblestone') < 3 && b.bankCount('cobblestone') >= 3) await b.withdraw(bot, 'cobblestone', 3).catch(() => 0)
    if (inv.count(bot, 'cobblestone') >= 3) await craft().ensure(bot, 'stone_pickaxe', inv.count(bot, 'stone_pickaxe') + 1, { noWithdraw: true }).catch(() => {})
  }
  // a lit tunnel doesn't spawn mobs that wander up to the base: bring torches (charcoal from logs
  // when there is no coal)
  if (inv.count(bot, 'torch') < 8 && (inv.count(bot, 'coal') + inv.count(bot, 'charcoal') >= 2 || craft().logCount(bot) >= 4)) await craft().ensure(bot, 'torch', 16).catch(() => {})
}

// The way in, as points every 2 steps, each tagged with its level (lv): level 0's stairs from the entrance, then for each
// level down to the active one the step from its parent's foot to its top and its own stairs (to the face while they are
// still being dug), then the face.
function minePath (m) {
  const Ls = levelsOf(m); const act = m.levels ? m.active : 0
  const pts = []
  for (let i = 0; i <= act && i < Ls.length; i++) {
    const L = Ls[i]; const d = L.stairsDir || L.dir; const top = L.stairTop || m.entrance
    if (i > 0) { const pf = Ls[i - 1].stairsEnd || Ls[i - 1].cursor; if (pf) pts.push({ x: pf.x, y: pf.y, z: pf.z, lv: i }) }
    const endY = L.stairsEnd ? L.stairsEnd.y : L.cursor ? L.cursor.y : L.level
    for (let k = 0; k <= top.y - endY; k += 2) pts.push(Object.assign(flightAt(top, d, top.y - k), { lv: i }))
    if (top.y - endY > 0 && (top.y - endY) % 2) pts.push(Object.assign(flightAt(top, d, endY), { lv: i }))
  }
  if (m.cursor) pts.push({ x: m.cursor.x, y: m.cursor.y, z: m.cursor.z, lv: act })
  return pts
}
// Are we in our own mine - on its staircase or at its face?
function inOwnMine (bot) {
  const m = mem.get().mine
  if (!m || !m.entrance || !bot.entity) return false
  const me = bot.entity.position
  return minePath(m).some(p => world.dist2(p, me) < 8 && Math.abs(p.y - me.y) < 6)
}
function diedInMine (m) {
  // horizontal distance, a wide berth and a long memory: deaths 20 blocks straight below the tunnel (a ravine
  // under it) did not count in 3D and the bot fell into the same ravine again and again
  // (the level it happened on - the shallowest the death lies by: a death on level 0's stairs is the whole mine's, one in a
  //  deeper level's tunnel that level's and the ones under it; -1 none)
  // (and only deaths since the mine was begun: one chosen beside an older death was given up on the next trip as "died in
  //  the mine lately" - four new staircases in a morning, no iron, the castle waiting, 2026-10-03. The death keeps a site
  //  from being chosen by chooseEntrance's own rules; it says nothing of a mine dug after it)
  const recent = (mem.get().deaths || []).filter(d => Date.now() - d.t < 3 * 60 * 60000 && d.cause !== 'void' && d.t > (m.born || 0))
  const hit = minePath(m).filter(p => recent.some(d => world.dist2(p, d) < 16)).map(p => p.lv)
  return hit.length ? Math.min(...hit) : -1
}
// Give up on level i (the active one by default) and every level under it - their way in is its stairs - back to the
// deepest level left (i-1); level 0 is the whole mine: its entrance joins the bad mines, a new one is chosen. Returns what
// is left of the mine.
function abandonMine (m, i = m && m.levels ? m.active : 0, danger = false) {
  if (i > 0 && m.levels && i < m.levels.length) {
    const L = levelsOf(m)[i]
    m.badLevels = (m.badLevels || []).concat([clone(L.stairTop)]).slice(-8)
    // (a deeper level than the active one: the active level stays as it is; else the view was a dropped level's - not
    //  written back)
    m.levels.splice(i)
    if (m.active >= i) { copyFields(m.levels[i - 1], m); m.active = i - 1 }
    log('mine', `giving up the mine's level at y${L.level} (stairs from ${move.fmt(L.stairTop)}) - back to the level at y${m.level}`)
    saveMine(m)
    return m
  }
  // (with its day and whether it was danger - water, lava: a site given up for a walk's timeout is no worse a site in three
  //  days; kept for ever, twelve such round home left "no safe spot for a mine entrance" and no iron at all, 2026-10-03)
  const dn = (mem.get().dayNo || {}).n ?? null // (day.js's own count, kept in memory)
  // (every danger site kept, the rest the last twelve: a cap of twelve in all pushed out the deaths first; audit)
  mem.update(mm => { const all = (mm.badMines || []).concat([{ x: m.entrance.x, y: m.entrance.y, z: m.entrance.z, day: dn, danger: !!danger }]); mm.badMines = [...all.filter(b => b.danger), ...all.filter(b => !b.danger).slice(-12)]; mm.mine = null })
  return null
}

// KNOWN ORE. Iron here is plentiful - 488 blocks within 64 of home, 4000+ within 128 - but a tenth of a percent of
// the rock: a blind 3x3 tunnel met a vein every few hundred blocks, and ore "in sight" (showing to daylit air) was 1
// block in 4000. The client sees every block through the stone: the bot tunnels straight to the nearest ore in solid
// rock, digs it and the rest of its vein as each block bares the next (operator 2026-09-26: efficiency over a
// player's blindness). Never an ore under the home grounds, never a tunnel begun from them (the mine's stairs first), never
// into a zone, never beside water or lava; the tunnel goes through solid rock, and a dark cave is only crossed where it
// happens to open one.
const underBuild = p => move.underBuild(p) // (move.js: the one rule for the ground under the build)
async function takeKnownOre (bot, itemName, target, ctx = {}) {
  const g = craft().GATHER[itemName]
  const home = mem.get().home || world.feetPos(bot)
  const gather = require('./gather')
  const refused = new Set()
  const k = p => `${p.x},${p.y},${p.z}`
  const t0 = Date.now()
  const start = inv.count(bot, itemName)
  const mouth = world.feetPos(bot) // (the stand the trip began from: where it walks back to)
  let veins = 0
  // never a tunnel mouth in the yard or under the build: near home the trip STARTS only from inside our own mine (the
  // stairs take us down first; audit #27). Judged once, at the start - checked every turn, the first ore's tunnel led away
  // from the mine's recorded path and the trip ended after one vein, 13 iron in 40 minutes (2026-09-27)
  if (((mem.get().home && world.dist2(bot.entity.position, mem.get().home) < 48) || underBuild(world.feetPos(bot))) && !inOwnMine(bot)) { log('mine', 'known ore: not tunnelling from round home or the build - the mine first'); return false }
  while (inv.count(bot, itemName) < target) {
    if ((ctx.shouldStop && ctx.shouldStop()) || Date.now() - t0 > 20 * 60000) break
    await reflex.waitClear()
    // mid-trip, out under the sky round home or the build (a vein that broke into the yard): stop - the trip goes on
    // underground only
    if (world.openSky(bot, world.feetPos(bot)) && (gather.onGrounds(bot.entity.position) || underBuild(world.feetPos(bot)))) { log('mine', 'known ore: out under the sky round home - ending the ore trip'); break }
    if (!inv.bestTool(bot, 'pickaxe', 4) && !await ensurePick(bot)) break
    if (inv.freeSlots(bot) <= 2) await base().tossJunk(bot)
    // (ctx.near {point, radius}, ctx.oreFilter: a trip started at one outcrop works that outcrop - its vein and the rock-face
    //  coal round it - never the next-nearest ore anywhere in 64, a 40-block dig down from a hillside; audit 2026-09-28)
    const ores = await world.scanBlocks(bot, g.blocks, { maxDistance: ctx.near ? ctx.near.radius : 64, count: 60, point: ctx.near ? ctx.near.point : home, filter: b => !refused.has(k(b.position)) && !move.inForeign(b.position) && inv.canHarvest(bot, b) && !fluidAround(bot, b.position) && !move.inZone(b.position, 2) && !gather.onGrounds(b.position) && !underBuild(b.position) && (!ctx.oreFilter || ctx.oreFilter(b)) })
    if (!ores.length) break
    const me = bot.entity.position
    const o = ores.sort((x, y) => world.dist3(x.position, me) - world.dist3(y.position, me))[0]
    // through the rock to it (the planner digs its own tunnel), then the block and its vein
    if (!act.reach(bot, o.position, 4.3)) {
      const r = await move.goTo(bot, new goals.GoalLookAtBlock(o.position, bot.world, { reach: 4 }), { timeoutMs: 120000, stuckMs: 15000, label: 'to the ore', shouldStop: ctx.shouldStop })
      if (!r.ok && !act.reach(bot, o.position, 4.5)) { refused.add(k(o.position)); continue }
    }
    if (!await act.dig(bot, o.position, { timeoutMs: 20000, noWalk: true })) { refused.add(k(o.position)); continue }
    veins++
    for (let i = 0; i < 6 && await takeWallOres(bot); i++) {}
    await act.collectDrops(bot, { radius: 5, maxMs: 6000 })
  }
  const got = inv.count(bot, itemName) - start
  if (got || veins) log('mine', `tunnelled to ${veins} ${itemName} ore vein(s): +${got} (${inv.count(bot, itemName)}/${target})`)
  // BACK THE WAY IT CAME: the tunnel is open behind us to the stand the trip began from (the mine's own path, near home) -
  // walked, nothing dug or placed. Left where the last vein ended, the way out climbed straight up there, or tunnelled to
  // the entrance and pillared it 40 high (2026-09-28). Failing that, the surfacing rules as before; audit
  if (veins && world.dist3(bot.entity.position, mouth) > 4 && !(ctx.shouldStop && ctx.shouldStop())) {
    const r = await move.goTo(bot, new goals.GoalBlock(mouth.x, mouth.y, mouth.z), { timeoutMs: 90000, stuckMs: 12000, dig: false, place: false, label: 'back along the ore tunnel', shouldStop: ctx.shouldStop })
    if (!r.ok) log('mine', `could not walk back along the ore tunnel to ${move.fmt(mouth)} (${r.why}) - surfacing from here`)
  }
  return inv.count(bot, itemName) >= target
}

// THE WAY DOWN: the entrance (unless we are in the mine already), then down the chain - each level's foot and the next
// level's stair top beside it - to the active one: the mine's own stairs, WALKED (nothing dug, nothing placed). A flight
// blocked by fallen gravel, a stray block or water is a blocked way, never the planner's own way down: with digging
// allowed a walk to a stair top 20-80 below is a shaft dug straight down it, the death this whole mine exists to avoid
// (reviewer 2026-09-30). A level not yet begun has its first cell in solid rock: opened by the mine's own guarded step
// (fluid, lava, floor), never the planner's. Returns { ok, why } - why 'stopped', 'blocked' (a verdict: the caller counts
// it as a trip that could not reach the face) or 'gone' (the level given up).
async function downTheMine (bot, m, ctx = {}) {
  if (!inOwnMine(bot) && world.dist3(bot.entity.position, m.entrance) > 3) await move.travel(bot, m.entrance, { range: 3, shouldStop: ctx.shouldStop, label: 'to mine', underground: true })
  const Ls = levelsOf(m)
  // (the time a walk gets is its length's: a flight from the entrance to y15 is ~95 down - near 200 cells of stairs - and
  //  a flat 60s ran out at y70 every time, "blocked (timeout)" twice in a day on stairs that were open, one try from a new
  //  mine, 2026-10-03. A real block is the stuck check's - 12s - never the length's)
  const walkTo = p => { const q = bot.entity.position; const len = 2 * Math.abs(q.y - p.y) + Math.hypot(q.x - p.x, q.z - p.z); return { timeoutMs: Math.min(240000, Math.max(60000, len * 400)), stuckMs: 12000, dig: false, place: false, label: 'to mine face', shouldStop: ctx.shouldStop } }
  for (let i = 1; i <= m.active; i++) {
    const P = Ls[i - 1]; const foot = P.stairsEnd || P.cursor; const t = Ls[i].stairTop
    for (const [p, first] of [[foot, false], [t, i === m.active]]) {
      if (Math.floor(bot.entity.position.y) < p.y) continue // (already below this point of the chain)
      if (ctx.shouldStop && ctx.shouldStop()) return { ok: false, why: 'stopped' }
      if (world.dist3(world.feetPos(bot), p) < 0.5) continue
      const open = [0, 1].every(dy => { const b = world.at(bot, p.x, p.y + dy, p.z); return b && world.isAirish(b) })
      if (first && !open) {
        // (the new level's first step, from the foot beside it: the stairs' own dig)
        const f = fluidAround(bot, t) || fluidAround(bot, { x: t.x, y: t.y + 1, z: t.z })
        if (f && f !== 'unknown') { log('mine', `${f} beside the new level's first step at ${move.fmt(t)}`); abandonMine(m, undefined, true); return { ok: false, why: 'gone' } }
        if (world.dist3(world.feetPos(bot), foot) >= 0.5 || !await digStep(bot, m, foot, t)) { log('mine', `the stairs to y${Ls[i].level} are blocked at ${move.fmt(t)} (the first step would not open)`); return { ok: false, why: 'blocked' } }
        continue
      }
      const r = await move.goTo(bot, new goals.GoalBlock(p.x, p.y, p.z), walkTo(p))
      if (!r.ok) {
        if (!move.isVerdict(r)) return { ok: false, why: r.why }
        log('mine', `the stairs to y${Ls[i].level} are blocked at ${move.fmt(p)} (${r.why})`)
        return { ok: false, why: 'blocked' }
      }
    }
  }
  // (and the active level's OWN flight to its foot, walked the same way: the face walk after this digs, and from a stair
  //  top it would dig its own way down a blocked flight - 20-100 blocks on a deep level; from the foot it is the level's
  //  floor, flat work. A flight not yet done is being cut by the stairs themselves; reviewer 2026-09-30)
  const A = Ls[m.active || 0]
  if (A && A.stairsDone && A.stairsEnd && Math.floor(bot.entity.position.y) > A.stairsEnd.y && world.dist3(world.feetPos(bot), A.stairsEnd) >= 0.5) {
    if (ctx.shouldStop && ctx.shouldStop()) return { ok: false, why: 'stopped' }
    const r = await move.goTo(bot, new goals.GoalBlock(A.stairsEnd.x, A.stairsEnd.y, A.stairsEnd.z), walkTo(A.stairsEnd))
    if (!r.ok) {
      if (!move.isVerdict(r)) return { ok: false, why: r.why }
      log('mine', `the stairs to y${A.level} are blocked on the way to their foot at ${move.fmt(A.stairsEnd)} (${r.why})`)
      return { ok: false, why: 'blocked' }
    }
  }
  return { ok: true }
}

// (rock tunnelled this trip: a trip that never reached its face is no verdict on the ore - audit)
let tunnelled = 0
function lastTripTunnelled () { return tunnelled }
function resetTripTunnelled () { tunnelled = 0 } // (by the trip's owner - one trip may call mineFor more than once; audit)
async function mineFor (bot, itemName, target, ctx = {}) {
  alsoWant = /^(granite|diorite|andesite|tuff)$/.test(itemName) ? new RegExp('^' + itemName + '$') : null
  let m = mem.get().mine
  const home = mem.get().home
  // a mine belongs near home; one dug before home existed (or far from it) is left behind
  if (m && home && world.dist2(m.entrance, home) > 96) { log('mine', `the old mine at ${move.fmt(m.entrance)} is far from home - starting one here`); m = null }
  if (m && !home && world.dist2(m.cursor, bot.entity.position) > 96) m = null
  // a mine we died in lately has something living in it (a cave broke into it): leave it for good
  // (a death in a deeper level's tunnel is that level's: it goes, the levels over it stay)
  ensureLevels(m)
  const dl = m ? diedInMine(m) : -1
  if (dl === 0) log('mine', `died in the mine at ${move.fmt(m.entrance)} lately - abandoning it for a new one`)
  if (dl >= 0) m = abandonMine(m, dl, true) // (a death is danger: given up for good; audit)
  // a "mine" working just under the surface is a trench under whatever stands there
  if (m && m.stairsDone && home && m.level > home.y - 20 && !m.ore) { log('mine', `the mine at ${move.fmt(m.entrance)} works at y${m.level}, too near the surface - abandoning it`); m = abandonMine(m) }
  // an ore trip works where that ore is: the mine's level nearest it, or a new level down from the deepest (pickLevel)
  // (coal is everywhere under the ground: the mine at hand is worked for it - its walls give it, with the cobble - never
  //  left for a new one at coal's richest band: the first coal trip threw the y39 cobble mine away for a hillside at y100
  //  and every cobble trip after would dig new stairs back down, 2026-09-28)
  const ore = itemName === 'coal' && m ? null : await oreLevel(bot, itemName).catch(() => null)
  // (never a new mine for "the wrong level": the mine was thrown away for one and a new staircase dug from the surface -
  //  four entrances round home in one night for andesite, iron and deepslate, 2026-09-30)
  if (m) m = pickLevel(m, ore, itemName)
  if (!m && !ore && !world.openSky(bot, world.feetPos(bot)) && bot.entity.position.y < ((home && home.y) || 64) - 8) {
    // already underground: tunnel from right here
    const me = world.feetPos(bot)
    let dir = DIRS[0]
    for (const d of DIRS) { const b = world.at(bot, me.x + d.x, me.y, me.z + d.z); if (b && world.isSolid(b) && !fluidAround(bot, { x: me.x + d.x, y: me.y, z: me.z + d.z })) { dir = d; break } }
    m = { entrance: me, dir, cursor: me, level: me.y, stairsDone: true, leg: 0, legPos: 0, blocks: 0 }
    saveMine(m)
    log('mine', `tunnelling from where i stand (${move.fmt(me)}) heading ${dir.x},${dir.z}`)
  }
  if (!m) {
    m = chooseEntrance(bot, ore && ore.y)
    if (!m) { log('mine', 'no safe spot for a mine entrance near home'); return false }
    if (ore) { m.ore = itemName; m.oreY = ore.y }
    m.stairsDir = { x: m.dir.x, z: m.dir.z }
    m.born = Date.now() // (deaths before it are no deaths in it - diedInMine)
    saveMine(m)
    log('mine', `new mine at ${move.fmt(m.entrance)} heading ${m.dir.x},${m.dir.z} to y${m.level}`)
  }
  // (room before the walk, at home: a trip set out with a full pack reached the face, said "pack full - taking the haul
  //  home" at 0 of 11 and walked back - two 60-block crossings for nothing, 2026-10-03)
  { const h = mem.get().home; if (inv.freeSlots(bot) <= 4 && h && world.dist3(bot.entity.position, h) < 24) { log('mine', `pack nearly full (${inv.freeSlots(bot)} free) - the haul in the chest before the walk to the mine`); const B = base(); const g = await B.goHome(bot, { shouldStop: ctx.shouldStop }).catch(() => null); if (g && g.ok) await B.depositAll(bot, { keep: (b, i) => i.name === itemName ? Infinity : B.keepCount(b, i) }).catch(() => {}) } } // (what the trip digs stays in the pack: banked, a cobblestone trip dug its own count again; audit)
  await provisionForMine(bot)
  // an ore showing in a cave wall or a cliff first - and the vein behind it, each block dug bares the next
  if (craft().GATHER[itemName] && craft().GATHER[itemName].ore && await takeKnownOre(bot, itemName, target, ctx)) return true
  // get to the working face
  if (world.dist3(bot.entity.position, m.cursor) > 3) {
    // the way down is the mine's own - entrance, stairs, tunnel - unless we are already in it. Judged by distance on
    // the map alone, standing 40 blocks over the face counted as "near" and the planner took a way down through a cave
    // lake at night; Drowned killed the bot in it (2026-09-24).
    // (the stairs blocked on the way down is a trip that could not reach the face - counted below - and no face walk from
    //  wherever the walk stopped: that walk digs)
    const down = await downTheMine(bot, m, ctx)
    if (down.why === 'gone') return false
    const r = down.ok ? await move.goTo(bot, new goals.GoalBlock(m.cursor.x, m.cursor.y, m.cursor.z), { timeoutMs: 120000, stuckMs: 15000, label: 'to mine face' }) : down
    // (busy or stopped on the way is no verdict on the mine - a fight in the stairwell abandoned a whole mine for a new one)
    if (!r.ok && !move.isVerdict(r)) return false
    // (a real verdict once - a flooded step, a gravel fall - is no reason to throw away stairs, cursor and ore history:
    //  three trips that could not reach the face, then a new mine; reaching it clears the count - audit 2026-09-28)
    if (!r.ok) {
      m.faceFails = (m.faceFails || 0) + 1; saveMine(m)
      if (m.faceFails < 3) { log('mine', `can't reach the mine face at ${move.fmt(m.cursor)} (${r.why}) - ${m.faceFails} of 3 before a new mine`); return false }
    } else if (m.faceFails) { m.faceFails = 0; saveMine(m) }
    if (!r.ok) {
      log('mine', `can't reach the mine face at ${move.fmt(m.cursor)} (${r.why}) - three trips now; ${m.active ? 'giving up this level' : 'starting a new mine'}`)
      abandonMine(m)
      return false
    }
  }
  // down in the mine now: the known ore from here (from round home it waited for the stairs - #27)
  if (craft().GATHER[itemName] && craft().GATHER[itemName].ore && inOwnMine(bot) && await takeKnownOre(bot, itemName, target, ctx)) return true
  log('mine', `mining for ${itemName} (${inv.count(bot, itemName)}/${target}) at ${move.fmt(m.cursor)}`)
  if (ctx.seal) await sealBehind(bot, m)
  let lastSave = Date.now()
  let fails = 0
  // THE TURN: blocked ahead, left of the heading, then right - never back, the corridor we came down is spent by
  // definition - and both sides blocked is boxed in. Only a step that BROKE rock forgives: a step back through the
  // corridor already dug "succeeds" too, and with both turns at a leg's end blocked the loop ran the same 13 cells back
  // and forth, forgiving itself each run, 8 minutes and more with no stone (2026-09-28)
  let turnFrom = null; let turnSide = 0
  let spinAt = Date.now(); let spins = 0
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    // 30 passes in under a second is a loop with nothing happening in it (two such spins today): stop
    if (++spins >= 30) { if (Date.now() - spinAt < 1000) { log('mine', 'the mine loop is spinning without progress - stopping this trip'); saveMine(m); return false } spins = 0; spinAt = Date.now() }
    const why = mineShouldPause(bot, ctx)
    if (why === 'no pickaxe') { if (!await ensurePick(bot)) return false; continue }
    if (why) { log('mine', `pausing: ${why}`); saveMine(m); return inv.count(bot, itemName) >= target }
    await reflex.waitClear()
    if (!inv.bestTool(bot, 'pickaxe', 4)) { if (!await ensurePick(bot)) { saveMine(m); return false } }
    if (inv.freeSlots(bot) <= 2) {
      await base().tossJunk(bot)
      if (inv.freeSlots(bot) <= 2 && ctx.seal) {
        // never walk the haul up to the surface in the dark: wait in the sealed tunnel for morning
        saveMine(m)
        log('mine', 'pack full at night - waiting in the tunnel until morning')
        await sealBehind(bot, m)
        while (!(ctx.shouldStop && ctx.shouldStop())) await move.sleep(3000)
        return inv.count(bot, itemName) >= target
      }
      if (inv.freeSlots(bot) <= 2) {
        saveMine(m)
        log('mine', 'pack full - taking the haul home')
        await base().depositHaul(bot, { shouldStop: ctx.shouldStop })
        await provisionForMine(bot)
        const down = await downTheMine(bot, m, ctx)
        if (!down.ok) { log('mine', `couldn't get back down to the face (${down.why})`); return false }
        const r = await move.goTo(bot, new goals.GoalBlock(m.cursor.x, m.cursor.y, m.cursor.z), { timeoutMs: 180000, stuckMs: 20000, label: 'back to mine face' })
        if (!r.ok) { log('mine', `couldn't get back to the face (${r.why})`); return false }
      }
    }
    // every step starts from the cursor: if we are not standing there (knocked back, climbed onto a
    // block), get back first - digging ahead of a cursor we are not at livelocked ("blocked - turning"
    // every 25s, zero cobble, for as long as it was left)
    const here = world.feetPos(bot)
    if (Math.abs(here.x - m.cursor.x) + Math.abs(here.z - m.cursor.z) > 1 || Math.abs(here.y - m.cursor.y) > 1) {
      const back = await move.goTo(bot, new goals.GoalBlock(m.cursor.x, m.cursor.y, m.cursor.z), { timeoutMs: 30000, stuckMs: 8000, label: 'back to mine face' })
      // (one lost walk back is a strike, the stairs' three - not the mine: a knock-back by a fight and one 30s walk threw away
      //  a mine an hour old, 2026-10-03)
      if (!back.ok && !move.isVerdict(back)) { log('mine', `back to the mine face at ${move.fmt(m.cursor)}: ${back.why} - no strike, the next trip goes on`); return false } // (a reflex's interruption is no fault of the mine: 'interrupted' counted a strike, 2026-10-03)
      if (!back.ok) { m.faceFails = (m.faceFails || 0) + 1; saveMine(m); if (m.faceFails < 3) { log('mine', `lost the mine face at ${move.fmt(m.cursor)} (${back.why}) - ${m.faceFails} of 3 before a new mine`); return false } log('mine', `lost the mine face at ${move.fmt(m.cursor)} (${back.why}) - three times now, abandoning this mine`); abandonMine(m); return false }
    }
    const b0 = broken
    const ok = m.stairsDone ? await tunnelStep(bot, m) : await stairStep(bot, m)
    if (!ok) {
      if (++fails >= 3) {
        if (turnSide >= 2) { log('mine', `boxed in at ${move.fmt(m.cursor)} - ahead, left and right all blocked - abandoning this mine`); abandonMine(m); return false }
        // stairs blocked (water, lava, a cave) well above the working depth: still under the rock, this is a depth like
        // any for cobble - tunnel here and keep the stairs already dug. On a cave-riddled mountain five new staircases
        // in an hour ended "blocked, far above the working depth" (2026-09-24). Only a staircase still near the surface
        // (under the castle, the hut) is no mine.
        if (!m.stairsDone && m.cursor.y > m.level + 12) {
          // (the ACTIVE level's stairs: a deeper level blocked within 8 of its top is dropped, not the mine)
          if (m.stairTop.y - m.cursor.y < 8) { log('mine', `the stairs are blocked at y${m.cursor.y}, ${m.active ? 'just under the level above' : 'just under the surface'} - abandoning ${m.active ? 'this level' : 'this mine'}`); abandonMine(m); return false }
          log('mine', `the stairs are blocked at y${m.cursor.y} - tunnelling at this depth`)
          m.oreY = m.cursor.y // (the band this level works is the one it reached - never the one it was dug for: audit)
        }
        // hazard ahead: turn this leg
        log('mine', `blocked at ${move.fmt(m.cursor)} - turning`)
        if (!turnFrom) { turnFrom = { x: m.dir.x, z: m.dir.z }; turnSide = 1; m.dir = { x: -turnFrom.z, z: turnFrom.x } } else { turnSide = 2; m.dir = { x: turnFrom.z, z: -turnFrom.x } }
        m.legPos = 0
        fails = 0
        if (!m.stairsDone) { m.stairsDone = true; m.level = m.cursor.y; m.stairsEnd = { x: m.cursor.x, y: m.cursor.y, z: m.cursor.z } }
      }
    } else { fails = 0; if (broken > b0) { turnFrom = null; turnSide = 0 } }
    if (Date.now() - lastSave > 15000) { saveMine(m); lastSave = Date.now() }
  }
  saveMine(m)
  return true
}

// Night mining: plug the passage behind us so nothing follows us down. The pathfinder digs back
// through the plug (dirt/cobble are natural) in the morning.
async function sealBehind (bot, m) {
  const me = world.feetPos(bot)
  const back = { x: me.x - m.dir.x, z: me.z - m.dir.z }
  const up = m.stairsDone ? 0 : 1 // on the stairs the cell behind is one step up
  const filler = () => fillerItem(bot)
  let placed = 0
  for (const dy of [0, 1, 2]) {
    const p = { x: back.x, y: me.y + up + dy - (up ? 0 : 0), z: back.z }
    if (!m.stairsDone && dy === 2) continue
    if (m.stairsDone && dy === 2) continue
    const c = world.at(bot, p.x, p.y, p.z)
    const f = filler()
    if (c && world.isAirish(c) && f && await act.place(bot, p, f.name)) placed++
  }
  if (placed) log('mine', `sealed the passage behind me (${placed} blocks)`)
}

// A tunnel that breaks into a cave is a door for every mob in that cave (a zombie and a skeleton came in
// through one and killed the bot on its own stairs). Wall up any opening beside the new cells: the
// side walls (across the direction of travel) and the ceiling over the top cell.
async function plugOpenings (bot, cells, along) {
  const filler = () => fillerItem(bot)
  const side = { x: -along.z, z: along.x }
  // the outside of the face only: a side neighbour that is not itself one of the new cells, and the cell over each
  // column's top (with a three-wide face the cells beside the middle column are tunnel, not cave)
  const isCell = p => cells.some(o => o.x === p.x && o.y === p.y && o.z === p.z)
  const holes = []
  for (const c of cells) {
    for (const k of [1, -1]) { const h = { x: c.x + side.x * k, y: c.y, z: c.z + side.z * k }; if (!isCell(h)) holes.push(h) }
    const up = { x: c.x, y: c.y + 1, z: c.z }
    if (!isCell(up)) holes.push(up)
  }
  let n = 0
  for (const h of holes) {
    const b = world.at(bot, h.x, h.y, h.z)
    if (!b || !(world.isAirish(b) || world.isWaterBlock(b))) continue
    if (/torch/.test(b.name)) continue
    const f = filler()
    if (!f) break
    if (await act.place(bot, h, f.name, { sneak: false }).catch(() => false)) n++
  }
  if (n) log('mine', `walled up ${n} cave opening${n > 1 ? 's' : ''} beside the tunnel`)
  lastPlugs = n
  return n
}

// Water let in by the cells just dug: plug it at once, the way a player slaps a block on a leak. Returns false
// when it can't be plugged (retreat - a flooding staircase drowned the bot twice).
async function plugWater (bot, cells) {
  const seen = new Set()
  for (const c of cells) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
      const k = `${p.x},${p.y},${p.z}`
      if (seen.has(k) || cells.some(o => o.x === p.x && o.y === p.y && o.z === p.z)) continue
      seen.add(k)
      const b = world.at(bot, p.x, p.y, p.z)
      if (!b || !world.isWaterBlock(b)) continue
      const f = fillerItem(bot)
      if (!f || !await act.place(bot, p, f.name, { sneak: false }).catch(() => false)) { log('mine', `water breaking in at ${move.fmt(p)} and nothing to stop it - backing out`); return false }
      log('mine', `plugged water at ${move.fmt(p)}`)
    }
  }
  // water already in the cells themselves (it flowed in before the plug): fill them and give this way up
  for (const c of cells) { const b = world.at(bot, c.x, c.y, c.z); if (b && world.isWaterBlock(b)) { log('mine', 'the tunnel is flooding - backing out'); return false } }
  return true
}

// Under the footprint of a protected zone (the castle, the base)? Mines never dig there, at any depth.
// (and the ground under the build, the one rule of move.underBuild - its footprint +8: the mine's own stairs and face kept
//  only +2 off it, a cursor could tunnel inside the margin under the castle; the audit, 2026-09-27. A column with no y is
//  judged below the build's floor, where the mine always is)
function underOwnZone (p) {
  return move.zones.some(z => p.x >= z.x1 - 2 && p.x <= z.x2 + 2 && p.z >= z.z1 - 2 && p.z <= z.z2 + 2) || move.underBuild({ x: p.x, y: p.y != null ? p.y : -64, z: p.z })
}

// ONE STAIR STEP from c into q (three high), the stairs' guarded dig: never under a build, never beside fluid, never onto
// lava or water, the leaks plugged, the openings walled, a floor under it, then stepped into. (A new level's first cell
// is one of these from the foot beside it - never the planner's dig; reviewer 2026-09-30)
async function digStep (bot, m, c, q) {
  // (never a dig beside a floor of ours that rests on nothing: the step's own cell is level with the cursor's floor, and
  //  taking it dropped the gravel under the bot into a 12-deep cave - 13 down and buried, 2026-10-03; the leg turns)
  if (fallingOverNothing(bot, c.x, c.y - 1, c.z)) { log('mine', `my floor at ${move.fmt({ x: c.x, y: c.y - 1, z: c.z })} is ${world.at(bot, c.x, c.y - 1, c.z).name} over nothing - not digging beside it`); return false }
  if (underOwnZone(q)) { log('mine', `the stairs would run under a protected build at ${move.fmt(q)}`); return false }
  { const h = mem.get().home; if (h && Math.hypot(q.x - h.x, q.z - h.z) < 24) { log('mine', `the stairs would run under home's grounds at ${move.fmt(q)}`); return false } } // (the tunnels' own rule)
  const cells = [{ x: q.x, y: q.y + 2, z: q.z }, { x: q.x, y: q.y + 1, z: q.z }, q]
  for (const cell of cells) {
    const f = fluidAround(bot, cell, p => cells.some(o => o.x === p.x && o.y === p.y && o.z === p.z) || (p.x === c.x && p.z === c.z))
    if (f) { log('mine', `${f} next to the stairs at ${move.fmt(cell)}`); return false }
  }
  const below = world.at(bot, q.x, q.y - 1, q.z)
  if (!below || world.isLavaBlock(below) || world.isWaterBlock(below)) return false
  for (const cell of cells) if (!await openCell(bot, cell)) return false
  if (!await plugWater(bot, cells)) return false
  await plugOpenings(bot, cells, { x: q.x - c.x, z: q.z - c.z })
  if (!await ensureFloor(bot, q)) return false
  return stepInto(bot, q)
}
async function stairStep (bot, m) {
  const c = m.cursor
  if (c.y <= m.level) { m.stairsDone = true; m.stairsEnd = { x: c.x, y: c.y, z: c.z }; m.legPos = 0; log('mine', `stairs reached y${c.y} - tunnelling`); return true }
  const q = { x: c.x + m.dir.x, y: c.y - 1, z: c.z + m.dir.z }
  if (!await digStep(bot, m, c, q)) return false
  m.cursor = q; m.blocks++
  await takeWallOres(bot)
  await maybeTorch(bot, m)
  return true
}

// CAVE-RIDDLED ROCK: a leg that walls up openings step after step puts back most of what it digs - 2-3 cobble a step
// against 2-3 mined, a 256-cobble trip netted almost nothing by dusk, 2026-09-29. A running count of the walling; past
// its mark the leg ends and the next one shifts three times as far, out of the cave's reach
let lastPlugs = 0
const CAVE_MARK = 4
async function tunnelStep (bot, m) {
  const c = m.cursor
  if (m.legPos > 0 && (m.caveRun || 0) >= CAVE_MARK && m.legPos < LEG_LEN) { log('mine', `the leg runs through caves (walling ~${Math.round(m.caveRun * 0.3)} a step) - ending it and shifting clear`); m.legPos = LEG_LEN; m.farShift = true }
  if (m.legPos >= LEG_LEN) {
    // shift sideways and come back the other way (serpentine keeps the mine compact). The sideways
    // direction is fixed for the whole mine: derived from the flipping heading it alternated, and every leg
    // after the second ran back through an already-dug corridor - no new stone at all
    if (!m.shiftDir) m.shiftDir = { x: -m.dir.z, z: m.dir.x }
    const side = m.shiftDir
    const shift = m.farShift ? SHIFT * 3 : SHIFT
    for (let i = 0; i < shift; i++) {
      const q = { x: m.cursor.x + side.x, y: m.cursor.y, z: m.cursor.z + side.z }
      if (!await openTunnelCell(bot, m, m.cursor, q)) return false
    }
    m.dir = { x: -m.dir.x, z: -m.dir.z }
    m.legPos = 0; m.farShift = false; m.caveRun = 0
    m.leg++
    return true
  }
  const q = { x: c.x + m.dir.x, y: c.y, z: c.z + m.dir.z }
  lastPlugs = 0
  if (!await openTunnelCell(bot, m, c, q)) return false
  m.caveRun = (m.caveRun || 0) * 0.7 + lastPlugs // (a running sum: steady walling of ~1.2 a step reaches the mark)
  m.legPos++
  return true
}

// (m: the mine record the step works on - its cursor and count are written HERE, never through mem.get().mine: a second
//  writer round saveMine, the record the loop holds and the one in memory could part; 2026-09-30)
async function openTunnelCell (bot, m, from, q) {
  if (fallingOverNothing(bot, from.x, from.y - 1, from.z)) { log('mine', `my floor at ${move.fmt({ x: from.x, y: from.y - 1, z: from.z })} is ${world.at(bot, from.x, from.y - 1, from.z).name} over nothing - not digging beside it`); return false } // (the stairs' rule; audit)
  if (underOwnZone(q)) return false // never under the castle or the base
  // (nor under home's grounds at any depth: the y79 legs turned and turned again until they ran 10 blocks from the bed, into
  //  the rock round an old shaft - the night's climb out came up beside it and a zombie knocked the bot down it, 2026-10-02)
  { const h = mem.get().home; if (h && Math.hypot(q.x - h.x, q.z - h.z) < 24) return false }
  // rock over the tunnel: the surface at least two above its three-high roof. A level tunnel on a hillside ran out
  // into the open slope and walled up the "cave openings" - the sky - with cobble and torches: a cut across the hill
  // that looked like a building (2026-09-24). Open ground ahead is a blocked step: the leg turns back into the hill.
  const gy = world.groundY(bot, q.x, q.z, q.y + 48)
  if (gy == null || gy < q.y + 4) return false
  // three high AND three wide: 9 cobble a step for the same walk and checks as 3. The step's fixed work (stepping in,
  // checking for water, walling up cave openings, the floor, the wall ores, a torch) was ~5s against ~1.8s of digging,
  // 0.45 cobble a second for a 33,000-cobble build (2026-09-24). The middle column is the tunnel; the side columns are
  // taken when they can be (fluid beside one or a block that won't come out skips that column, never the step).
  const along = { x: q.x - from.x, z: q.z - from.z }
  const side = { x: -along.z, z: along.x }
  const column = k => [2, 1, 0].map(dy => ({ x: q.x + side.x * k, y: q.y + dy, z: q.z + side.z * k }))
  const mid = column(0)
  const sides = [column(1), column(-1)].filter(col => !underOwnZone(col[0]))
  // (open already: the column we stand in and the face we dug last step)
  const behind = p => [-1, 0, 1].some(k => p.x === from.x + side.x * k && p.z === from.z + side.z * k)
  const inFace = p => mid.concat(...sides).some(o => o.x === p.x && o.y === p.y && o.z === p.z)
  for (const cell of mid) {
    const f = fluidAround(bot, cell, p => behind(p) || inFace(p))
    if (f) { log('mine', `${f} beside the tunnel at ${move.fmt(cell)}`); return false }
  }
  for (const cell of mid) if (!await openCell(bot, cell)) return false
  const opened = mid.slice()
  for (const col of sides) {
    if (col.some(cell => fluidAround(bot, cell, p => behind(p) || inFace(p)))) continue
    let ok = true
    for (const cell of col) if (!await openCell(bot, cell)) { ok = false; break }
    if (ok) opened.push(...col)
  }
  const cells = opened
  if (!await plugWater(bot, cells)) return false
  await plugOpenings(bot, cells, { x: q.x - from.x, z: q.z - from.z })
  if (!await ensureFloor(bot, q)) return false
  if (!await stepInto(bot, q)) return false
  m.cursor = { x: q.x, y: q.y, z: q.z }; m.blocks = (m.blocks || 0) + cells.length; tunnelled += cells.length
  await takeWallOres(bot)
  await maybeTorch(bot, m)
  return true
}

module.exports = { lastTripTunnelled, resetTripTunnelled, mineFor, chooseEntrance, takeWallOres, takeKnownOre, inOwnMine, oreLevel, mineBox, minePath, ensureLevels, levelsOf, setActive, saveMine, chooseLevel, pickLevel, descentStart, flightCells, abandonMine, downTheMine }
