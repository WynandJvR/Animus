'use strict'
// Home base: where it is, the chests there and what is in them, making room in the pack.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const { log } = require('./log')

const craft = () => require('./craft')

// What stays in the pack when the haul goes into the chests.
const KIT_KEEP = {
  torch: 32, crafting_table: 1, stick: 8, coal: 8, charcoal: 8, dirt: 24, bread: 32, cooked_beef: 32, cooked_porkchop: 32, cooked_mutton: 32, cooked_chicken: 32, cooked_cod: 16, cooked_salmon: 16, baked_potato: 16, apple: 16, golden_carrot: 32, white_bed: 1, shield: 1,
  // (the bow and its arrows are kit: deposited, the next round's tool check took them out again, every round)
  bow: 1, arrow: 64
}
function keepCount (bot, item) {
  if (/_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)$/.test(item.name)) return Infinity
  if (/_bed$/.test(item.name)) return 1
  if (/_boat$/.test(item.name)) return 1 // (the kit's boat: the water here needs one)
  if (KIT_KEEP[item.name] != null) return KIT_KEEP[item.name]
  return 0
}

function home () { return mem.get().home }
function setHome (pos) { mem.set('home', { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }); log('base', `home set at ${move.fmt(pos)}`) }
// 3D: a cave 19 blocks under the hut is not home (horizontal distance called it "arrived")
function distHome (bot) { const h = home(); return h && bot.entity ? world.dist3(bot.entity.position, h) : Infinity }

function chestCache () { const m = mem.get(); return m.chestContents || (m.chestContents = {}) }
function key (p) { return `${p.x},${p.y},${p.z}` }

function knownChests (bot) {
  // chests standing at home are ours even if the list lost them (a chest re-seated by tidying)
  const h = home()
  if (h && bot && bot.entity) {
    for (const b of world.findBlocks(bot, /^(chest|barrel)$/, { maxDistance: 10, count: 12, point: new Vec3(h.x, h.y, h.z) })) {
      const p = { x: b.position.x, y: b.position.y, z: b.position.z }
      if (!(mem.get().chests || []).some(q => q.x === p.x && q.y === p.y && q.z === p.z)) mem.addUnique('chests', p)
    }
  }
  return (mem.get().chests || []).slice().sort((a, b) => world.dist3(a, bot.entity.position) - world.dist3(b, bot.entity.position))
}
// The bank is the chests we know - a cache entry for a chest that is gone counted 264 bricks and 33 logs
// that did not exist, so the castle never went for logs and looped on "waiting on oak_log".
function liveCaches () {
  const known = new Set((mem.get().chests || []).map(key))
  const cache = chestCache()
  for (const k of Object.keys(cache)) if (!known.has(k)) delete cache[k]
  return Object.values(cache)
}
function bankCount (name) {
  let n = 0
  for (const c of liveCaches()) n += (c.items && c.items[name]) || 0
  return n
}
function bankCounts () {
  const out = {}
  for (const c of liveCaches()) for (const [k, v] of Object.entries(c.items || {})) out[k] = (out[k] || 0) + v
  return out
}

// A chest of ours: one we put down (mem.chestsPlaced - placeChest's spots may lie past the base's box: utilitySpotOK
// takes any unzoned cell), or one standing in the base's zone (the hut's room). A chest merely near home - every one
// within 10 is "known" for withdrawing - may be a player's.
function notePlacedChest (p) { mem.update(m => { const l = m.chestsPlaced = m.chestsPlaced || []; if (!l.some(q => q.x === p.x && q.y === p.y && q.z === p.z)) l.push({ x: p.x, y: p.y, z: p.z }); if (l.length > 64) l.splice(0, l.length - 64) }) }
function ourChest (p) {
  if ((mem.get().chestsPlaced || []).some(q => q.x === p.x && q.y === p.y && q.z === p.z)) return true
  const z = move.inZone(p, 0); return !!z && z.label === 'base'
}
// Does this block shut a chest's lid? A full, occluding cube only (a chest opens under glass, slabs, stairs, leaves,
// torches...). Transparent full cubes (glass, leaves, ice) still let it open.
const SEE_THROUGH_RE = /(glass|_leaves|^ice$|^frosted_ice$|^barrier$|^spawner$|^slime_block$|^honey_block$)/
function shutsLid (b) { return !!b && world.isSolid(b) && !SEE_THROUGH_RE.test(b.name) && !/(chest|_bed|_slab|_stairs|furnace|crafting_table)$/.test(b.name) }
const unreachable = new Map() // chest key -> time a walk to it failed
async function openChest (bot, p) {
  const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
  if (!b || !/chest|barrel/.test(b.name)) {
    if (b) { mem.removePos('chests', p); delete chestCache()[key(p)]; mem.save(); log('base', `chest at ${move.fmt(p)} is gone`) }
    return null
  }
  if (!act.reach(bot, p, 4)) {
    // a chest we just failed to reach is skipped a while (35s stuck walks, three per castle cycle)
    const bad = unreachable.get(key(p))
    if (bad && Date.now() - bad < 5 * 60000) return null
    const r = await move.goTo(bot, new goals.GoalNear(p.x, p.y, p.z, 2), { timeoutMs: 45000, label: 'to chest', allowZones: ['base'] })
    if (!r.ok) { unreachable.set(key(p), Date.now()); log('base', `can't reach the chest at ${move.fmt(p)} (${r.why}) - skipping it for a while`); return null }
  }
  { const bad = unreachable.get(key(p)); if (bad && Date.now() - bad < 5 * 60000) return null }
  unreachable.delete(key(p))
  // a chest with a full block on its lid won't open (a planner's stepping-stone of dirt: the deposit tried that chest
  // every 20 seconds for half an hour, 2026-09-27) - the block comes off first; a chest that still won't open is
  // skipped a while like one out of reach. Never forced (a forced dig took whatever sat there - a player's block on a
  // player's chest, since every chest near home is "known"; audit R6, 2026-09-27): only a chest of ours (in the base's
  // zone), only a block that really shuts a lid (a full, occluding cube - glass, slabs, stairs, leaves never do), and a
  // barrel never (it opens with anything on it). The stepping-stone itself is the planner's to stop (move.js).
  const lid = world.at(bot, p.x, p.y + 1, p.z)
  const cb = bot.blockAt(new Vec3(p.x, p.y, p.z))
  if (cb && /chest$/.test(cb.name) && ourChest(p) && shutsLid(lid)) {
    if (world.NATURAL_RE.test(lid.name) && await act.dig(bot, { x: p.x, y: p.y + 1, z: p.z }, { allowZones: ['base', 'build'], timeoutMs: 8000 })) log('base', `took the ${lid.name} off the lid of the chest at ${move.fmt(p)}`)
    else log('base', `the ${lid.name} on the lid of the chest at ${move.fmt(p)} stays (${world.NATURAL_RE.test(lid.name) ? 'the dig failed' : 'a crafted block is never dug for this'}) - the chest will not open until it is moved`)
  }
  try {
    const w = await bot.openContainer(bot.blockAt(new Vec3(p.x, p.y, p.z)))
    const items = {}
    for (const it of w.containerItems()) items[it.name] = (items[it.name] || 0) + it.count
    const slots = w.inventoryStart != null ? w.inventoryStart : 27
    chestCache()[key(p)] = { items, free: slots - w.containerItems().length, t: Date.now() }
    mem.save()
    return w
  } catch (e) { unreachable.set(key(p), Date.now()); log('base', `couldn't open chest at ${move.fmt(p)}: ${e.message} - skipping it for a while`); return null }
}
function refreshCache (w, p) {
  const items = {}
  for (const it of w.containerItems()) items[it.name] = (items[it.name] || 0) + it.count
  const slots = w.inventoryStart != null ? w.inventoryStart : 27
  chestCache()[key(p)] = { items, free: slots - w.containerItems().length, t: Date.now() }
  mem.save()
}

// Withdraw up to n of an item from the base chests - only when a chest is known to hold it (or
// has never been read) and the base is close enough to be worth the walk.
async function withdraw (bot, name, n, { maxWalk = 64 } = {}) {
  if (n <= 0) return 0
  let got = 0
  for (const p of knownChests(bot)) {
    if (world.dist3(p, bot.entity.position) > maxWalk) continue
    const c = chestCache()[key(p)]
    if (c && !(c.items && c.items[name])) continue
    const w = await openChest(bot, p)
    if (!w) continue
    try {
      const have = w.containerItems().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
      const k = Math.min(have, n - got)
      if (k > 0) {
        const t = w.containerItems().find(i => i.name === name)
        await w.withdraw(t.type, null, k)
        got += k
      }
      refreshCache(w, p)
    } catch (e) { log('base', `withdraw ${name} failed: ${e.message}`) } finally { try { w.close() } catch {} }
    if (got >= n) break
  }
  if (got) log('base', `took ${got} ${name} from the chests`)
  return got
}

async function placeChest (bot) {
  const h = home()
  if (!inv.has(bot, 'chest')) { if (!await craft().ensure(bot, 'chest', 1, { noWithdraw: true })) return null }
  // making the chest may have taken us to a tree: storage goes AT home
  if (h && world.dist2(bot.entity.position, h) > 6) await move.travel(bot, h, { range: 2, label: 'home with the chest' })
  const me = world.feetPos(bot)
  let spots = []
  // at home: the hut's neat utility spots (side-wall slots, then the row outside) - the old free-cell
  // search skipped the placement rules inside the base zone and stacked a chest on the bed
  if (h && mem.get().hutPlan) spots = require('./hut').utilitySpots(bot).filter(p => move.utilitySpotOK(p))
  if (!spots.length) {
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, -1, 1]) {
      const p = { x: me.x + dx, y: me.y + dy, z: me.z + dz }
      if (Math.abs(dx) + Math.abs(dz) < 2) continue
      const c = world.at(bot, p.x, p.y, p.z); const b = world.at(bot, p.x, p.y - 1, p.z); const up = world.at(bot, p.x, p.y + 1, p.z)
      if (!c || !world.isAirish(c) || !b || !world.isSolid(b) || !up || !world.isAirish(up)) continue
      if (move.inZone(p) && move.inZone(p).label !== 'base') continue
      if (!move.utilitySpotOK(p)) continue
      spots.push(Object.assign(p, { d: Math.abs(dx) + Math.abs(dz) + (h ? world.dist3(p, h) * 0.1 : 0) }))
    }
    spots.sort((a, b) => a.d - b.d)
  }
  for (const s of spots.slice(0, 8)) {
    let adj = false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nb = world.at(bot, s.x + dx, s.y, s.z + dz); if (nb && /chest/.test(nb.name)) adj = true }
    if (adj) continue
    if (await act.place(bot, s, 'chest', { allowZones: ['base'] })) {
      mem.addUnique('chests', s)
      notePlacedChest(s)
      log('base', `placed a chest at ${move.fmt(s)}`)
      return s
    }
  }
  return null
}

// Put everything but the kit into the chests at home.
// Put `n` of one item into a home chest (the freshest tool of the kind, for a spare kit).
async function depositItem (bot, name, n = 1) {
  const items = inv.items(bot).filter(i => i.name === name).sort((a, b) => inv.durabilityLeft(bot, b) - inv.durabilityLeft(bot, a))
  if (!items.length) return 0
  for (const p of knownChests(bot)) {
    const c = chestCache()[key(p)]
    if (c && c.free <= 0) continue
    const w = await openChest(bot, p)
    if (!w) continue
    let put = 0
    try {
      for (const it of items) { if (put >= n) break; await w.deposit(it.type, it.metadata, Math.min(it.count, n - put)); put += Math.min(it.count, n - put) }
      refreshCache(w, p)
    } catch (e) { log('base', `depositing ${name} failed: ${e.message}`) } finally { try { w.close() } catch {} }
    if (put) { log('base', `put ${put} ${name} in the chest as a spare`); return put }
  }
  return 0
}

async function depositAll (bot, { keep = keepCount } = {}) {
  const want = () => inv.items(bot).filter(i => i.count > 0 && inv.count(bot, i.name) > keep(bot, i))
  let rounds = 0
  while (want().length && rounds++ < 6) {
    let target = knownChests(bot).find(p => { const c = chestCache()[key(p)]; return !c || c.free > 2 })
    if (!target || world.dist3(target, bot.entity.position) > 48) {
      const placed = await placeChest(bot)
      if (!placed) { log('base', 'no chest with room and could not place one'); return false }
      target = placed
    }
    const w = await openChest(bot, target)
    if (!w) { mem.removePos('chests', target); continue }
    try {
      for (const it of want()) {
        const total = inv.count(bot, it.name)
        const k = Math.min(it.count, total - Math.min(total, keep(bot, it)))
        if (k <= 0) continue
        try { await w.deposit(it.type, null, k) } catch (e) { if (/full/i.test(e.message)) break }
      }
      refreshCache(w, target)
    } finally { try { w.close() } catch {} }
  }
  log('base', `deposited the haul (bank now ${Object.keys(bankCounts()).length} kinds)`)
  return true
}

async function goHome (bot, { shouldStop } = {}) {
  const h = home()
  if (!h) return { ok: false, why: 'no home' }
  if (distHome(bot) < 6) return { ok: true }
  return move.travel(bot, h, { range: 3, shouldStop, label: 'home' })
}

async function depositHaul (bot, opts = {}) {
  const r = await goHome(bot, opts)
  if (!r.ok) { log('base', `couldn't get home to deposit (${r.why})`); await tossJunk(bot); return false }
  return depositAll(bot)
}

async function tossJunk (bot) {
  let tossed = 0
  let want = null // (worked out once, only if a junk stack turns up)
  for (const it of inv.items(bot)) {
    let k = 0
    // never what a build still wants (the list holds flowers, vines, bone - the forage trips' own takings), nor the kit
    // (arrows and feathers are in the list, and the kit keeps 64 arrows: the next makeRoom tossed them, audit #7)
    if (inv.JUNK.test(it.name) && keepCount(bot, it) === 0 && !(want || (want = require('./materials').wantedSet(bot)))(it.name)) k = it.count
    else if (it.name === 'dirt' && inv.count(bot, 'dirt') > 64) k = Math.min(it.count, inv.count(bot, 'dirt') - 64)
    else if (it.name === 'gravel' && inv.count(bot, 'gravel') > 16) k = it.count
    if (k > 0) { try { await bot.toss(it.type, null, k); tossed += k } catch {} }
  }
  if (tossed) log('base', `tossed ${tossed} junk items`)
  return tossed
}

async function makeRoom (bot, slots = 3) {
  if (inv.freeSlots(bot) >= slots) return true
  await tossJunk(bot)
  if (inv.freeSlots(bot) >= slots) return true
  if (distHome(bot) < 48) { await depositAll(bot); return inv.freeSlots(bot) >= slots }
  return false
}

module.exports = { home, setHome, distHome, withdraw, depositItem, depositAll, depositHaul, goHome, tossJunk, makeRoom, bankCount, bankCounts, knownChests, placeChest, notePlacedChest, ourChest, openChest, keepCount }
