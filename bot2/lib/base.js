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
  torch: 32, crafting_table: 1, stick: 8, coal: 8, charcoal: 8, dirt: 24, cobblestone: 16, bread: 32, cooked_beef: 32, cooked_porkchop: 32, cooked_mutton: 32, cooked_chicken: 32, cooked_cod: 16, cooked_salmon: 16, baked_potato: 16, apple: 16, golden_carrot: 32, white_bed: 1, shield: 1,
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
let lastWindowAt = 0 // (when our last chest window closed - the open-timeout diagnostic)
// What can keep a lid shut, for the open-timeout line: the block over it, anything sitting on it (a cat on a chest keeps it
// shut and the server says nothing), and for a double chest the other half's lid too
function lidReport (bot, p) {
  const out = []
  try {
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); const pr = b && b.getProperties ? b.getProperties() : {}
    out.push(`above ${(world.at(bot, p.x, p.y + 1, p.z) || {}).name}`, `type ${pr.type || '?'}`)
    const on = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && Math.abs(e.position.x - (p.x + 0.5)) < 1 && Math.abs(e.position.z - (p.z + 0.5)) < 1 && e.position.y >= p.y + 0.5 && e.position.y < p.y + 2).map(e => e.name || e.type)
    out.push(`on top ${on.length ? on.join('+') : 'nothing'}`)
    if (pr.type && pr.type !== 'single') {
      // (the other half: left/right of the facing)
      const f = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[pr.facing] || [0, 0]
      const side = pr.type === 'left' ? [-f[1], f[0]] : [f[1], -f[0]]
      out.push(`other half above ${(world.at(bot, p.x + side[0], p.y + 1, p.z + side[1]) || {}).name}`)
    }
  } catch (e) { out.push('lid ? ' + e.message) }
  return out.join(', ')
}
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
    if (!r.ok) { if (move.isVerdict(r)) unreachable.set(key(p), Date.now()); log('base', `can't reach the chest at ${move.fmt(p)} (${r.why}) - skipping it for a while`); return null }
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
    const w = await act.openSettled(bot, bot.blockAt(new Vec3(p.x, p.y, p.z)))
    w.once('close', () => { lastWindowAt = Date.now() })
    const items = {}
    for (const it of w.containerItems()) items[it.name] = (items[it.name] || 0) + it.count
    const slots = w.inventoryStart != null ? w.inventoryStart : 27
    chestCache()[key(p)] = { items, free: slots - w.containerItems().length, t: Date.now() }
    mem.save()
    return w
  } catch (e) {
    unreachable.set(key(p), Date.now())
    // (why it would not open, for the next one: where we stood, how far, and whether a window was still up)
    const me = bot.entity.position
    log('base', `couldn't open chest at ${move.fmt(p)}: ${e.message} - skipping it for a while (from ${move.fmt(me.floored())}, ${world.dist3(me, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }).toFixed(1)}b, window ${bot.currentWindow ? bot.currentWindow.type || 'open' : 'none'}, sneak ${!!(bot.controlState && bot.controlState.sneak)}, holding ${bot.heldItem ? bot.heldItem.name : 'nothing'}, since the last window ${lastWindowAt ? Date.now() - lastWindowAt - 20000 : '?'}ms, ${lidReport(bot, p)})`)
    return null
  }
}
// The pack as the server has it: two ticks after a window shuts its inventory packets have landed (read at once, it
// swung by whole stacks and every deposit looked like a mismatch)
async function settle (bot) { try { await bot.waitForTicks(2) } catch {} }
// A window whose moves the pack does not bear out was showing stale contents: its reading of the chest is dropped, and
// the next open reads the chest afresh (audit 2026-09-28: the bank counted what was asked, the pack disagreed)
// (no save of its own - the next regular write carries the dropped reading: a save per mismatch turned a timing bug into
//  72 whole-file writes in 8s - and a line per chest a minute at most, enough to see drift; audit 2026-09-28)
const movesSaid = new Map()
function checkMoves (p, asked, moved, what) {
  if (asked === moved) return
  // (said, not acted on: the chest's reading came from the window as it closed and stands; dropping it on every
  //  mismatch - a deposit that ran a stack past its count, a chest that filled mid-deposit - hid half the bank (53
  //  kinds -> 26) until each chest was opened again, and "short" sent the bot gathering what it had; 2026-09-28)
  const k = key(p); if (Date.now() - (movesSaid.get(k) || 0) < 60000) return
  movesSaid.set(k, Date.now())
  log('base', `${what} at ${move.fmt(p)}: asked ${asked}, the pack moved ${moved}`)
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
// THE SPARE SET stays in the chest: one of each kit tool is the respawn's re-arm (director spareKit), taken only when the
// pack holds none of it. Withdrawn by anything else - the mine wanting a third pickaxe - it was made again every round,
// a pickaxe out and a pickaxe in, four times in an hour (2026-09-27)
// (the ONE definition of the spare set: director's spareKit makes it, the bank keeps it)
const SPARE_KIT = ['stone_pickaxe', 'stone_axe', 'stone_sword']
const BANK_RESERVE = Object.fromEntries(SPARE_KIT.map(t => [t, 1]))
async function withdraw (bot, name, n, { maxWalk = 64 } = {}) {
  if (n <= 0) return 0
  if (BANK_RESERVE[name] && inv.count(bot, name) > 0) n = Math.min(n, Math.max(0, bankCount(name) - BANK_RESERVE[name]))
  if (n <= 0) return 0
  // (what arrived in the pack, never what was asked of the window: a window opened on stale contents said "took 64"
  //  whatever the pack got - audit 2026-09-28)
  const start = inv.count(bot, name)
  let got = 0
  for (const p of knownChests(bot)) {
    if (world.dist3(p, bot.entity.position) > maxWalk) continue
    const c = chestCache()[key(p)]
    if (c && !(c.items && c.items[name])) continue
    const w = await openChest(bot, p)
    if (!w) continue
    const had = got; let k = 0
    try {
      const have = w.containerItems().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
      k = Math.min(have, n - got)
      if (k > 0) {
        const t = w.containerItems().find(i => i.name === name)
        await w.withdraw(t.type, null, k)
      }
      refreshCache(w, p)
    } catch (e) { log('base', `withdraw ${name} failed: ${e.message}`) } finally { try { w.close() } catch {} }
    // (counted after the close AND the server's resync: read the instant the window shut, the pack swung by whole stacks
    //  - "asked 3, the pack moved 150" - until the inventory packets two ticks on; 2026-09-28)
    await settle(bot)
    got = inv.count(bot, name) - start
    checkMoves(p, k, got - had, `withdrawing ${name}`)
    if (got >= n) break
  }
  if (got > 0) log('base', `took ${got} ${name} from the chests`)
  return got
}

async function placeChest (bot) {
  const h = home()
  if (!inv.has(bot, 'chest')) { if (!await craft().ensure(bot, 'chest', 1, { noWithdraw: true })) return null }
  // making the chest may have taken us to a tree: storage goes AT home
  if (h && world.dist2(bot.entity.position, h) > 6) await move.travel(bot, h, { range: 2, label: 'home with the chest' })
  const me = world.feetPos(bot)
  // at home: the hut's neat utility spots (side-wall slots, then the row outside) - the old free-cell
  // search skipped the placement rules inside the base zone and stacked a chest on the bed
  // (and when every one of those is taken, the free cells round home after them: the slots all held chests and every
  //  deposit said "no chest with room and could not place one", the pack full on every trip, 2026-09-29)
  const freeCells = () => {
    const out = []
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, -1, 1]) {
      const p = { x: me.x + dx, y: me.y + dy, z: me.z + dz }
      if (Math.abs(dx) + Math.abs(dz) < 2) continue
      const c = world.at(bot, p.x, p.y, p.z); const b = world.at(bot, p.x, p.y - 1, p.z); const up = world.at(bot, p.x, p.y + 1, p.z)
      if (!c || !world.isAirish(c) || !b || !world.isSolid(b) || !up || !world.isAirish(up)) continue
      if (move.inZone(p) && move.inZone(p).label !== 'base') continue
      if (!move.utilitySpotOK(p)) continue
      out.push(Object.assign(p, { d: Math.abs(dx) + Math.abs(dz) + (h ? world.dist3(p, h) * 0.1 : 0) }))
    }
    return out.sort((a, b) => a.d - b.d)
  }
  const hutSpots = h && mem.get().hutPlan ? require('./hut').utilitySpots(bot).filter(p => move.utilitySpotOK(p)) : []
  for (const spots of [hutSpots, freeCells()]) {
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
    let asked = 0; const before = inv.count(bot, name)
    try {
      for (const it of items) { if (asked >= n) break; const k = Math.min(it.count, n - asked); await w.deposit(it.type, it.metadata, k); asked += k }
      refreshCache(w, p)
    } catch (e) { log('base', `depositing ${name} failed: ${e.message}`) } finally { try { w.close() } catch {} }
    // (what left the pack, counted after the close and the resync - see withdraw)
    await settle(bot)
    const put = before - inv.count(bot, name)
    checkMoves(p, asked, put, `depositing ${name}`)
    if (put > 0) { log('base', `put ${put} ${name} in the chest as a spare`); return put }
  }
  return 0
}

async function depositAll (bot, { keep = keepCount } = {}) {
  const want = () => inv.items(bot).filter(i => i.count > 0 && inv.count(bot, i.name) > keep(bot, i))
  let rounds = 0; const skipped = new Set(); let depErr = null
  while (want().length && rounds++ < 6) {
    let target = knownChests(bot).find(p => !skipped.has(key(p)) && (() => { const c = chestCache()[key(p)]; return !c || c.free > 2 })())
    // (a new chest only when every chest here was read FULL: one that merely would not open is no reason - a new chest a
    //  deposit, all through a spell of timeouts, is a yard of chests; the deposit waits instead - audit 2026-09-28)
    if ((!target || world.dist3(target, bot.entity.position) > 48) && skipped.size) {
      log('base', `the chest${skipped.size > 1 ? 's' : ''} at ${[...skipped].join(' / ')} won't open - the deposit waits (${want().reduce((n, i) => n + i.count, 0)} items)`)
      return false
    }
    if (!target || world.dist3(target, bot.entity.position) > 48) {
      const placed = await placeChest(bot)
      if (!placed) { log('base', 'no chest with room and could not place one'); return false }
      target = placed
    }
    const before = {}; let asked = 0; const askedBy = {}
    for (const it of inv.items(bot)) before[it.name] = (before[it.name] || 0) + it.count
    const w = await openChest(bot, target)
    // (a chest that would not open this time is skipped this round, never forgotten: a 20s open timeout erased the chest
    //  holding the castle's stone from the list, its contents from the bank, and the build waited on stock it had -
    //  2026-09-28. openChest itself forgets one that is really gone)
    if (!w) { skipped.add(key(target)); continue }
    try {
      // (by NAME, the excess over the keep once - deposit by type spans the stacks: per stack, each read the same stale
      //  total and two stacks of torches went in below the kit's keep, to be taken out again - audit 2026-09-28)
      const firsts = new Map(); for (const it of want()) if (!firsts.has(it.name)) firsts.set(it.name, it)
      for (const it of firsts.values()) {
        const k = inv.count(bot, it.name) - Math.min(inv.count(bot, it.name), keep(bot, it))
        if (k <= 0) continue
        try { await w.deposit(it.type, null, k); asked += k; askedBy[it.name] = (askedBy[it.name] || 0) + k } catch (e) { if (!depErr) depErr = `${it.name} x${k}: ${e.message}`; if (/full/i.test(e.message)) break }
      }
      refreshCache(w, target)
    } finally { try { w.close() } catch {} }
    // (what left the pack, counted after the close and the resync - see withdraw)
    await settle(bot)
    let moved = 0; const off = []
    for (const [name, c] of Object.entries(before)) { const m = Math.max(0, c - inv.count(bot, name)); moved += m; if (m !== (askedBy[name] || 0)) off.push(`${name} ${askedBy[name] || 0}->${m}`) }
    // (which items did not move as asked - an overshoot, or a pack change of its own on the walk to the chest)
    checkMoves(target, asked, moved, 'depositing the haul' + (off.length ? ` [${off.slice(0, 6).join(', ')}]` : ''))
    // (a round that put nothing in is no round to repeat: every deposit threw, one item moved each time, and the loop and
    //  the director's retries went round 72 times in 8s, each writing memory - 2026-09-28. Say why and stop.)
    // (a chest that FILLED is no failure: it is full - marked so, and the next round takes another or places one; only a
    //  round that put nothing in for any other reason stops. The first cut stopped on "destination full" too, and a
    //  home whose two chests had filled never got a third, 2026-09-28)
    if (depErr && /full/i.test(depErr)) { const c = chestCache()[key(target)] || { items: {}, t: Date.now() }; c.free = 0; chestCache()[key(target)] = c; depErr = null; continue }
    if (asked === 0) { log('base', `depositing at ${move.fmt(target)} put nothing in${depErr ? ' (' + depErr + ')' : ''} - stopping`); return false }
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

module.exports = { SPARE_KIT, home, setHome, distHome, withdraw, depositItem, depositAll, depositHaul, goHome, tossJunk, makeRoom, bankCount, bankCounts, knownChests, placeChest, notePlacedChest, ourChest, openChest, keepCount }
