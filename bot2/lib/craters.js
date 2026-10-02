'use strict'
// A BLAST'S HOLE IS PUT BACK. Creepers blew up round the bot again and again on the castle site and the holes stood:
// pits in the yard and the plaza the walks went round or fell into, and the site looked a wreck (the operator,
// 2026-10-02). A player who lets one go off fills the hole. Every explosion near home or the build is remembered by
// what it took - the server says where it went off (the explosion packet: centre, radius), and the block updates
// that follow say which blocks went and what each was - and a day task puts the ground back: bottom up, dirt for
// soil and stone, never into a cell of the build (the builder's own), never in someone else's place.
const world = require('./world')
const mem = require('./memory')
const move = require('./move')
const { log } = require('./log')

// natural ground: soil, sand, gravel, clay, stone and its kinds, ores - never cobble, logs or anything made
const GROUND_RE = /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|dirt_path|sand|red_sand|gravel|clay|stone|deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block|.*_ore|moss_block|snow_block|terracotta|.*_terracotta|sandstone|red_sandstone)$/
// the safehouse, the pen and the farm keep their own ground (the farm's planter re-hoes its plot)
function notOurs (q) {
  try { if (move.insideHut(q)) return true } catch {}
  const z = move.inZone(q, 1); return !!(z && /^(farm|pen|base)$/.test(z.label))
}
const NEAR = 64 // from home (or 24 round the build): our ground - a blast in a hillside 84 blocks out walked the bot there to fill it
// (2026-10-02); only blasts under the open sky: a cave's blast hole is no scar on the site
const MAX = 400 // cells remembered

function ourGround (p) {
  const h = mem.get().home
  if (h && Math.hypot(p.x - h.x, p.z - h.z) <= NEAR) return true
  try { const j = require('./build').getJob(); const b = j && j.box; if (b && p.x >= b.x1 - 24 && p.x <= b.x2 + 24 && p.z >= b.z1 - 24 && p.z <= b.z2 + 24) return true } catch {}
  return false
}

function install (bot) {
  botRef = bot
  let blast = null // { at, c, r, cells }
  bot._client.on('explosion', p => {
    const c = p.center || (p.x != null ? { x: p.x, y: p.y, z: p.z } : null)
    if (!c || !ourGround(c)) return
    try { if (!world.openSky(bot, { x: Math.floor(c.x), y: Math.floor(c.y) + 1, z: Math.floor(c.z) })) return } catch {}
    if (blast) finish()
    blast = { at: Date.now(), c, r: (p.radius || 3) + 1.5, cells: [] }
    setTimeout(finish, 1500)
  })
  bot.on('blockUpdate', (oldB, newB) => {
    if (!blast || !oldB || !newB || !oldB.position) return
    const q = oldB.position
    if (Math.hypot(q.x + 0.5 - blast.c.x, q.y + 0.5 - blast.c.y, q.z + 0.5 - blast.c.z) > blast.r) return
    if (!world.isSolid(oldB) || !world.isAirish(newB)) return
    // (the GROUND only, at or below the blast: what stood above it - a door, a wall, a chest, a scaffold post - is no hole
    //  in the ground, and dirt in its place would seal the safehouse door or raise a post nobody tracks; audit)
    if (!GROUND_RE.test(oldB.name) || q.y > Math.floor(blast.c.y)) return
    if (notOurs(q)) return
    blast.cells.push({ x: q.x, y: q.y, z: q.z, was: oldB.name })
  })
  function finish () {
    const b = blast; blast = null
    if (!b || !b.cells.length) return
    const cur = mem.get().craters || []
    const have = new Set(cur.map(k))
    const add = b.cells.filter(q => !have.has(k(q)))
    mem.set('craters', cur.concat(add).slice(-MAX))
    log('craters', `a blast at ${Math.round(b.c.x)},${Math.round(b.c.y)},${Math.round(b.c.z)} took ${b.cells.length} blocks (${summary(b.cells)}) - to be put back`)
  }
}
const k = q => `${q.x},${q.y},${q.z}`
function summary (cells) { const t = {}; for (const q of cells) t[q.was] = (t[q.was] || 0) + 1; return Object.entries(t).map(([n, v]) => v + ' ' + n).join(', ') }

// The cells still open that are ours to fill: air now, not a cell of the build, not someone else's place
function open (bot) {
  const j = (() => { try { return require('./build').getJob() } catch { return null } })()
  return (mem.get().craters || []).filter(q => {
    const b = world.at(bot, q.x, q.y, q.z)
    if (!b) return false // (not loaded: owed, but not a task from here; audit)
    if (!ourGround(q)) return false // (our ground by today's rule - cells recorded under a wider one are not walked to)
    { const h = mem.get().home; if (h && q.y < h.y - 12) return false } // (a hole under the ground is no scar on it: a y55 cell 64 under home was walked for, 2026-10-02)
    if (gaveUp(q)) return false
    if (!world.isAirish(b) && !world.isLiquidWater(b)) return false
    if (j && j.index.has(k(q))) return false
    return !move.inForeign(q)
  })
}
// a cell that will not take a block (something always standing there, no face): two tries a day, then let go (litter's
// rule; audit)
const TRIES = 2
function gaveUp (q) { const d = require('./day').dayNo(botRef); return q.day === d && (q.tries || 0) >= TRIES }
let botRef = null
// forget what is filled (or the builder's / not ours any more); loaded cells only
function prune (bot) {
  const j = (() => { try { return require('./build').getJob() } catch { return null } })()
  const keep = (mem.get().craters || []).filter(q => { if (!ourGround(q)) return false; const b = world.at(bot, q.x, q.y, q.z); return !b || ((world.isAirish(b) || world.isLiquidWater(b)) && !(j && j.index.has(k(q))) && !move.inForeign(q)) })
  if (keep.length !== (mem.get().craters || []).length) mem.set('craters', keep)
  return keep
}

const FILL_RE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff)$/
function filler (bot, was) {
  const its = bot.inventory.items()
  const soil = /dirt|grass|mud|podzol|mycelium|farmland|path|sand|gravel|clay/.test(was || '')
  const pref = soil ? /^(dirt|coarse_dirt)$/ : FILL_RE
  return its.find(i => pref.test(i.name)) || its.find(i => FILL_RE.test(i.name)) || null
}

async function fill (bot, { shouldStop } = {}) {
  const act = require('./act')
  const cells = prune(bot).filter(q => world.at(bot, q.x, q.y, q.z) && !gaveUp(q))
  if (!cells.length) return 0
  const need = cells.length
  const have = bot.inventory.items().filter(i => FILL_RE.test(i.name)).reduce((s, i) => s + i.count, 0)
  // (from the bank - its dirt, and the mine's andesite, diorite, granite, tuff - never dug from the grounds: a new pit for
  //  each old one; what is in hand fills what it can; audit)
  for (const n of ['dirt', 'coarse_dirt', 'andesite', 'diorite', 'granite', 'tuff', 'cobbled_deepslate']) { // (never the castle's cobblestone; audit)
    const now = bot.inventory.items().filter(i => FILL_RE.test(i.name)).reduce((s, i) => s + i.count, 0)
    if (now >= need) break
    if (require('./base').bankCount(n) > 0) await require('./base').withdraw(bot, n, need - now).catch(() => 0)
  }
  // bottom up, nearest first within a layer: each block stands on the one before it
  const me = bot.entity.position
  cells.sort((a, b) => a.y - b.y || world.dist3(a, me) - world.dist3(b, me))
  let done = 0
  const d = require('./day').dayNo(bot)
  for (const q of cells) {
    if (shouldStop && shouldStop()) break
    // (never the cell we stand in or the one over our head: filled from the rim, never into the crater with us in it -
    //  that one waits for the next round, from wherever we stand then; audit)
    const f = world.feetPos(bot)
    if (q.x === f.x && q.z === f.z && q.y >= f.y - 1 && q.y <= f.y + 1) continue
    const it = filler(bot, q.was)
    if (!it) { log('craters', `out of dirt and stone with ${cells.length - done} blast cells still open`); break }
    if (await act.place(bot, q, it.name, { allowZones: ['base', 'build', 'orchard'], sneak: false }).catch(() => false)) done++
    else mem.update(m => { const x = (m.craters || []).find(c => c.x === q.x && c.y === q.y && c.z === q.z); if (x) { if (x.day !== d) { x.day = d; x.tries = 0 } x.tries = (x.tries || 0) + 1 } })
  }
  prune(bot)
  if (done) log('craters', `put back ${done} of ${cells.length} blast cells`)
  return done
}
const inv = () => require('./inventory')

module.exports = { install, open, prune, fill }
