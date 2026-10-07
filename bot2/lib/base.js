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
// THE HANDS' TOOLS BY NEED, NOT BY NAME: one of a kind - the best the pack holds that still works (inventory.bestTool, what
// the hands take) - and nothing under it. Kept by name, every tool stayed: four stone swords beside the iron one, a second
// shovel and pickaxe, back from a grave run, and the band's two kinds found no slot ("no room for dark_oak_stairs ... 3 slots
// free", the round off on a trip, 2026-10-07 11:51). The rest is haul: the bank's spares (SPARE_KIT, one of each banked,
// spareKit's own count) come from it. ENOUGH FOR A JOB (inv.TOOL_JOB_USES, the largest ask of any tool check): the hands'
// tool with fewer uses left than that keeps a spare beside it - one that meets it if the pack has one, the highest tier and
// the most uses else - or an iron pick at 4 uses went down a mine with its stone spare banked, and a fresh copy made for the
// check went to the bank instead of the worn one (audit). Which copies go: the most worn first (depositByWear). A kind with
// no working tool keeps what it has
const TOOL_KIND_RE = /_(pickaxe|axe|shovel|sword|hoe)$/
function toolsKept (bot, kind) {
  const uses = i => inv.durabilityLeft(bot, i)
  const all = inv.items(bot).filter(i => i.name.endsWith('_' + kind) && uses(i) > 2) // (bestTool's "works")
  if (!all.length) return null
  const top = Math.max(...all.map(i => inv.tierOf(i.name)))
  const main = all.filter(i => inv.tierOf(i.name) === top).sort((a, b) => uses(b) - uses(a))[0] // (the hands' tool: its best copy)
  const kept = [main]
  if (uses(main) < inv.TOOL_JOB_USES) {
    const J = inv.TOOL_JOB_USES
    const spare = all.filter(i => i !== main).sort((a, b) => ((uses(b) >= J) - (uses(a) >= J)) || (inv.tierOf(b.name) - inv.tierOf(a.name)) || (uses(b) - uses(a)))[0]
    if (spare) kept.push(spare)
  }
  return kept
}
function toolKeep (bot, name) {
  const kept = toolsKept(bot, name.match(TOOL_KIND_RE)[1])
  if (!kept) return Infinity
  return kept.filter(i => i.name === name).length
}
function keepCount (bot, item) {
  if (TOOL_KIND_RE.test(item.name)) return toolKeep(bot, item.name)
  if (/_(helmet|chestplate|leggings|boots)$/.test(item.name)) return Infinity
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
const unreachable = new Map() // chest key -> { at, from }: when a walk to it failed, and where the walk began
// (a mark made where EVERY walk fails at once - move.stuckPlace - is the place's verdict, not the chest's: dropped when read.
//  From a scaffold top with gaps under it all twelve chests were "skipping it for a while", 2026-10-06 22:08)
function badChest (p) {
  const b = unreachable.get(key(p))
  if (!b) return false
  if (Date.now() - b.at >= 5 * 60000 || (b.from && move.stuckPlace(null, b.from))) { unreachable.delete(key(p)); return false }
  return true
}
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
let chestWalkSaidAt = 0
async function openChest (bot, p) {
  const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
  if (!b || !/chest|barrel/.test(b.name)) {
    if (b) { mem.removePos('chests', p); delete chestCache()[key(p)]; mem.save(); log('base', `chest at ${move.fmt(p)} is gone`) }
    return null
  }
  if (!act.reach(bot, p, 4)) {
    // a chest we just failed to reach is skipped a while (35s stuck walks, three per castle cycle)
    if (badChest(p)) return null
    // (by travel - its legs go OUT of the build first: from inside the castle a bare planner walk to the chests timed out
    //  45s at a time, five in a row in one build step (each chest skipped in turn, none of them the problem - where the bot
    //  stood was), 2026-09-30)
    // (WHO sent the walk, said once a minute: mid-step walks of 50b for 1-9 cobblestone, seven in seven minutes, with no
    //  caller named - 2026-10-04)
    if (Date.now() - chestWalkSaidAt > 60000) { chestWalkSaidAt = Date.now(); log('base', 'chest walk for: ' + String(new Error().stack).split('\n').slice(2, 7).map(l => l.trim().replace(/^at /, '')).join(' <- ')) }
    const r = await move.travel(bot, p, { range: 2, label: 'to chest', maxMs: 90000 })
    if (!r.ok) {
      const from = bot.entity.position.floored()
      const placeStuck = move.stuckPlace(bot, from) // (every walk fails at once from here: the place, not this chest)
      if (move.isVerdict(r) && !placeStuck) unreachable.set(key(p), { at: Date.now(), from: { x: from.x, y: from.y, z: from.z } })
      log('base', `can't reach the chest at ${move.fmt(p)} (${r.why}) - ${placeStuck ? 'every walk fails from ' + move.fmt(from) + ': the place is stuck, not the chest' : 'skipping it for a while'}`)
      return null
    }
  }
  if (badChest(p)) return null
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
    unreachable.set(key(p), { at: Date.now(), from: null }) // (it would not open: the chest's own, wherever we stood)
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
// THE SAFEHOUSE'S OWN STOCK: food, arrows, a blade and a shield in the chests INSIDE it (whichever stand inside the hut box),
// so a camp outside - a witch, a skeleton - never leaves the hideout unfed or without a bow load: the chests at the door
// are a walk out, and the hideout fetches indoors only while mobs are near (2026-10-07). Filled from what a home deposit is
// putting away anyway (no walk of its own), drawn on last by every other withdraw. None of it is a build block
const SAFE_STOCK = { food: 16, arrow: 16, sword: 1, shield: 1 }
function safeKind (name) { return inv.GOOD_FOOD.includes(name) ? 'food' : name === 'arrow' ? 'arrow' : name === 'shield' ? 'shield' : /_sword$/.test(name) ? 'sword' : null }
function indoorChests (bot) { return knownChests(bot).filter(p => move.insideHut(p)) }
function indoorCount (bot, kind) { let n = 0; for (const p of indoorChests(bot)) { const c = chestCache()[key(p)]; if (c && c.items) for (const [nm, k] of Object.entries(c.items)) if (safeKind(nm) === kind) n += k } return n }
// what the safehouse's stock still lacks of `name`'s kind (0: full, or no chest inside)
function safeShort (bot, name) { const k = safeKind(name); return k && indoorChests(bot).length ? Math.max(0, SAFE_STOCK[k] - indoorCount(bot, k)) : 0 }
// (`only(p)`: the chests the caller may walk to - the hideout's indoor chests while mobs are about; the rest are skipped unopened)
async function withdraw (bot, name, n, { maxWalk = 64, only = null } = {}) {
  if (n <= 0) return 0
  if (BANK_RESERVE[name] && inv.count(bot, name) > 0) n = Math.min(n, Math.max(0, bankCount(name) - BANK_RESERVE[name]))
  if (n <= 0) return 0
  // (what arrived in the pack, never what was asked of the window: a window opened on stale contents said "took 64"
  //  whatever the pack got - audit 2026-09-28)
  const start = inv.count(bot, name)
  // (A FULL PACK takes nothing: no free slot and no stack of it with room - the junk out first, and with still no room, said
  //  once and stopped. Each chest was opened in turn, "inventory is full" fifteen times over in 30s, and the trip after it
  //  went mining with no room to pick up the cobble its next pickaxe needed, 2026-10-02)
  const room = () => inv.freeSlots(bot) > 0 || inv.items(bot).some(i => i.name === name && i.count < (i.stackSize || 64))
  if (!room()) { await tossJunk(bot).catch(() => {}); if (!room()) { log('base', `the pack is full - no ${name} taken`); return 0 } }
  let got = 0; let full = false
  // (the safehouse's stock is drawn on last - the kit's arrows or bread from the nearest chest emptied it first; audit)
  const order = safeKind(name) && !only ? knownChests(bot).sort((a, b) => (move.insideHut(a) ? 1 : 0) - (move.insideHut(b) ? 1 : 0)) : knownChests(bot)
  for (const p of order) {
    if (world.dist3(p, bot.entity.position) > maxWalk) continue
    if (only && !only(p)) continue
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
    } catch (e) { log('base', `withdraw ${name} failed: ${e.message}`); if (/inventory is full/i.test(e.message || '')) full = true } finally { try { w.close() } catch {} }
    // (counted after the close AND the server's resync: read the instant the window shut, the pack swung by whole stacks
    //  - "asked 3, the pack moved 150" - until the inventory packets two ticks on; 2026-09-28)
    await settle(bot)
    got = inv.count(bot, name) - start
    checkMoves(p, k, got - had, `withdrawing ${name}`)
    if (got >= n || full) break // (full: the next chest will not change that)
  }
  if (got > 0) log('base', `took ${got} ${name} from the chests`)
  return got
}

// MANY KINDS, ONE OPENING A CHEST: `list` [[name, n], ...] in the caller's order, each chest opened once for every kind it
// holds, until each is had or the pack is down to `keepFree` slots. Kind by kind (withdraw), a round's window opened the
// chests 20 times over for 20 kinds - "scaffold+withdraw 52s", 2026-10-07. Exact names only (a stand-in is the caller's).
// Returns { name: got }
async function withdrawMany (bot, list, { keepFree = 2, maxWalk = 64 } = {}) {
  const want = new Map(); for (const [nm, n] of list) if (n > 0) want.set(nm, (want.get(nm) || 0) + n)
  const goal = new Map(want); const start = {}; for (const nm of want.keys()) start[nm] = inv.count(bot, nm)
  const got = {}; let opened = 0
  for (const p of knownChests(bot)) {
    if (!want.size || inv.freeSlots(bot) <= keepFree) break
    if (world.dist3(p, bot.entity.position) > maxWalk) continue
    const c = chestCache()[key(p)]
    if (c && c.items && ![...want.keys()].some(nm => c.items[nm])) continue
    const w = await openChest(bot, p)
    if (!w) continue
    opened++
    // (the slots this opening may fill, counted from before it - the pack's own count is the window's while it is open)
    let slots = inv.freeSlots(bot) - keepFree
    try {
      for (const [nm, n] of [...want]) {
        if (slots <= 0) break
        const its = w.containerItems().filter(i => i.name === nm); const have = its.reduce((s, i) => s + i.count, 0)
        const stack = (its[0] && its[0].stackSize) || 64
        const k = Math.min(have, n, slots * stack)
        if (k <= 0) continue
        try { await w.withdraw(its[0].type, null, k); slots -= Math.ceil(k / stack) } catch (e) { log('base', `withdraw ${nm} failed: ${e.message}`); if (/inventory is full/i.test(e.message || '')) break }
      }
      refreshCache(w, p)
    } finally { try { w.close() } catch {} }
    await settle(bot) // (counted after the close and the resync - see withdraw)
    for (const nm of [...want.keys()]) { const g = inv.count(bot, nm) - start[nm]; got[nm] = g; if (g >= goal.get(nm)) want.delete(nm); else want.set(nm, goal.get(nm) - g) }
  }
  const took = Object.entries(got).filter(([, g]) => g > 0)
  if (took.length) log('base', `took ${took.map(([nm, g]) => g + ' ' + nm).join(', ')} from the chests (${took.length} kinds, ${opened} chest opening${opened === 1 ? '' : 's'})`)
  return got
}

// (never re-entered: a full pack made the chest's own log gather deposit, the deposit wanted a new chest, the chest's craft
//  gathered a log... - 2,829 lines in ten minutes, a loop with no wait in it, 2026-09-29. Nested, it says no)
let placingChest = false
async function placeChest (bot) {
  if (placingChest) return null
  placingChest = true
  try { await new Promise(r => setImmediate(r)); return await placeChestInner(bot) } finally { placingChest = false }
}
async function placeChestInner (bot) {
  const h = home()
  // (a chest made by day only, and stopped at the evening: its wood can be a walk - 116 blocks and a boat at tod 11200 for a
  //  deposit, back through a spider, creepers, a zombie and a skeleton in the dark, dead with 155 items, 2026-10-04. Late,
  //  the haul stays in the pack until the morning)
  const late = () => world.phase(bot) !== 'day' || world.ticksUntilNight(bot) < 2400
  if (!inv.has(bot, 'chest')) {
    // (the pack's own wood is no walk - a chest and a table of it are made at home whatever the hour; audit)
    const packWood = inv.items(bot).reduce((n, i) => n + (/_planks$/.test(i.name) ? i.count : craft().isLogName(i.name) ? 4 * i.count : 0), 0)
    if (late() && packWood < 12) { log('base', 'the chests are full and no chest in the pack - one made in the morning; the haul stays with me'); return null }
    // (THE CHEST'S WOOD FROM THE BANK, of a wood the build does not place: at home, two logs out of the chests are no walk.
    //  Without them the craft chose the build's spruce and explored 192 blocks out for 2 logs - a 6-minute "window" phase
    //  for a chest, 2026-10-07 09:55. preferredWood: never the build's own species while another is held or banked)
    if (packWood < 8) {
      const w = craft().preferredWood(bot, 8)
      let res = new Set(); try { res = require('./materials').reservedSpecies(bot) } catch {}
      if (w && !res.has(w)) {
        if (bankCount(w + '_planks') >= 8) await withdraw(bot, w + '_planks', 8).catch(() => 0)
        else if (bankCount(w + '_log') >= 2) await withdraw(bot, w + '_log', 2).catch(() => 0)
      }
    }
    if (!await craft().ensure(bot, 'chest', 1, { noWithdraw: true, shouldStop: packWood >= 12 ? undefined : late })) return null
  }
  // making the chest may have taken us to a tree: storage goes AT home
  if (h && world.dist2(bot.entity.position, h) > 6) await move.travel(bot, h, { range: 2, label: 'home with the chest' })
  const me = world.feetPos(bot)
  // at home: the hut's neat utility spots (side-wall slots, then the row outside) - the old free-cell
  // search skipped the placement rules inside the base zone and stacked a chest on the bed
  // (and when every one of those is taken, the free cells round home after them: the slots all held chests and every
  //  deposit said "no chest with room and could not place one", the pack full on every trip, 2026-09-29)
  const freeCells = () => {
    const out = []
    // (out to 8, nearest first: within 3 every cell held a chest or stood beside one by the castle's second night - "no chest
    //  with room and could not place one" with a chest in the pack, the trips leaving with 4 free slots, 2026-09-30)
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (const dy of [0, -1, 1]) {
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
    // (a spot beside a chest is none - filtered before the eight tries, never inside them: a yard of chests filled the
    //  nearest eight with such spots and the wider search behind them was never reached)
    const besideChest = s => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const nb = world.at(bot, s.x + dx, s.y, s.z + dz); return !!nb && /chest/.test(nb.name) })
    for (const s of spots.filter(q => !besideChest(q)).slice(0, 8)) {
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

// `k` copies of a WORN item (a tool, armour) into the open chest, BY SLOT: the most worn first (the haul), or the freshest (a
// spare for the bank). w.deposit takes the first slot of the type it finds - the fresh pick the check had just made went to
// the bank, the worn one stayed (audit 2026-10-07). Stackables go as before. The count put in
async function depositByWear (bot, w, type, k, { freshest = false } = {}) {
  const md = world.data(bot); const def = md.items[type]
  if (!def || !def.maxDurability) { await w.deposit(type, null, k); return k }
  const slots = w.slots.slice(w.inventoryStart, w.inventoryEnd).filter(s => s && s.type === type)
    .sort((a, b) => (inv.durabilityLeft(bot, a) - inv.durabilityLeft(bot, b)) * (freshest ? -1 : 1))
  let n = 0
  for (const s of slots) {
    if (n >= k) break
    await bot.transfer({ window: w, itemType: s.type, metadata: s.metadata, count: s.count, sourceStart: s.slot, sourceEnd: s.slot + 1, destStart: 0, destEnd: w.inventoryStart })
    n += s.count
  }
  return n
}
// Put everything but the kit into the chests at home.
// Put `n` of one item into a home chest (the freshest tool of the kind, for a spare kit).
async function depositItem (bot, name, n = 1) {
  const items = inv.items(bot).filter(i => i.name === name).sort((a, b) => inv.durabilityLeft(bot, b) - inv.durabilityLeft(bot, a))
  if (!items.length) return 0
  // (the safehouse's stock first while it lacks this kind - the spare sword is its blade)
  const order = safeShort(bot, name) > 0 ? knownChests(bot).sort((a, b) => (move.insideHut(b) ? 1 : 0) - (move.insideHut(a) ? 1 : 0)) : knownChests(bot)
  for (const p of order) {
    const c = chestCache()[key(p)]
    if (c && c.free <= 0) continue
    const w = await openChest(bot, p)
    if (!w) continue
    let asked = 0; const before = inv.count(bot, name)
    try {
      asked += await depositByWear(bot, w, items[0].type, n, { freshest: true })
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

// THE DEPOSITS' ONE KEEP: the kit's (keepCount) and what the build has registered - the window's blocks, and the band's
// waited and anchor items whole (Infinity). Each deposit kept by its own rule: a craft's room-making banked the 16 dark oak
// planks just taken out for the band's anchor, the step found "dark_oak_planks (not in hand)" and the round was lost,
// 2026-10-07. (A trip's own pre-deposit - nothing but the kit goes - passes its own keep, as before)
let keepHook = null
function setDepositKeep (fn) { keepHook = fn }
function depositKeepOf (bot, it) {
  const k = keepCount(bot, it)
  if (k === Infinity || !keepHook) return k
  let h = 0; try { h = keepHook(it) || 0 } catch {}
  return Math.max(k, h)
}
// The safehouse's stock topped up at a home deposit: one indoor chest opened, only when it lacks something the pack can spare
async function topUpSafeStock (bot, keep) {
  const plan = new Map()
  // (from the haul, and from the kit's own food and arrows down to half their keep - the arrows ride 64 in the pack and are
  //  never haul: a bow load indoors costs the pack a quarter of its quiver; a sword or shield only as haul or a spare)
  for (const it of inv.items(bot)) {
    if (plan.has(it.name) || !safeKind(it.name)) continue
    const short = safeShort(bot, it.name); if (short <= 0) continue
    const kp = keep(bot, it); const floor = kp === Infinity ? Infinity : /^(food|arrow)$/.test(safeKind(it.name)) ? Math.ceil(kp / 2) : kp
    if (floor !== Infinity) plan.set(it.name, Math.min(short, inv.count(bot, it.name) - floor))
  }
  for (const [nm, k] of [...plan]) if (k <= 0) plan.delete(nm)
  if (!plan.size) return 0
  const target = indoorChests(bot).find(p => { const c = chestCache()[key(p)]; return !c || c.free > 0 })
  if (!target) return 0
  const before = {}; for (const nm of plan.keys()) before[nm] = inv.count(bot, nm)
  const w = await openChest(bot, target); if (!w) return 0
  // (per KIND: two foods each counted against the same 16 would fill it twice over)
  const left = {}; for (const kd of Object.keys(SAFE_STOCK)) left[kd] = Math.max(0, SAFE_STOCK[kd] - indoorCount(bot, kd))
  try {
    for (const [nm, k0] of plan) {
      const kd = safeKind(nm); const k = Math.min(k0, left[kd]); if (k <= 0) continue
      const it = inv.items(bot).find(i => i.name === nm); if (!it) continue
      try { await w.deposit(it.type, null, k); left[kd] -= k } catch (e) { log('base', `safehouse stock: ${nm} x${k} would not go in (${e.message})`); if (/full/i.test(e.message)) break }
    }
    refreshCache(w, target)
  } finally { try { w.close() } catch {} }
  await settle(bot)
  const put = Object.entries(before).map(([nm, b]) => [nm, b - inv.count(bot, nm)]).filter(([, m]) => m > 0)
  if (put.length) log('base', `the safehouse's own stock topped up at ${move.fmt(target)}: ${put.map(([nm, m]) => `${m} ${nm}`).join(', ')} (food ${indoorCount(bot, 'food')}/${SAFE_STOCK.food}, arrows ${indoorCount(bot, 'arrow')}/${SAFE_STOCK.arrow}, sword ${indoorCount(bot, 'sword')}, shield ${indoorCount(bot, 'shield')})`)
  return put.reduce((a, [, m]) => a + m, 0)
}
async function depositAll (bot, { keep = depositKeepOf } = {}) {
  const want = () => inv.items(bot).filter(i => i.count > 0 && inv.count(bot, i.name) > keep(bot, i))
  await topUpSafeStock(bot, keep).catch(e => log('base', `safehouse stock top-up threw: ${e.message}`))
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
    const before = {}; let asked = 0; const askedBy = {}; let tried = 0 // (tried: asked, thrown or not - the line's count; asked: what went in)
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
        // (asked BEFORE the await: a deposit that threw "full" half way had moved its items all the same, and counted only on
        //  success the line read "asked 0, the pack moved 230", 2026-10-06 - the accounting's, never a stray move)
        tried += k; askedBy[it.name] = (askedBy[it.name] || 0) + k
        try { asked += await depositByWear(bot, w, it.type, k) } catch (e) { if (!depErr) depErr = `${it.name} x${k}: ${e.message}`; if (/full/i.test(e.message)) break }
      }
      refreshCache(w, target)
    } finally { try { w.close() } catch {} }
    // (what left the pack, counted after the close and the resync - see withdraw)
    await settle(bot)
    let moved = 0; const off = []
    for (const [name, c] of Object.entries(before)) { const m = Math.max(0, c - inv.count(bot, name)); moved += m; if (m !== (askedBy[name] || 0)) off.push(`${name} ${askedBy[name] || 0}->${m}`) }
    // (which items did not move as asked - an overshoot, or a pack change of its own on the walk to the chest)
    checkMoves(target, tried, moved, 'depositing the haul' + (off.length ? ` [${off.slice(0, 6).join(', ')}]` : ''))
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

// how many of an item the build still has to place (0 with no build)
function buildNeed (bot, name) { try { const st = require('./build').cachedStatus(bot); return (st && st.need && st.need[name]) || 0 } catch { return 0 } }
async function tossJunk (bot) {
  let tossed = 0
  let want = null // (worked out once, only if a junk stack turns up)
  for (const it of inv.items(bot)) {
    let k = 0
    // never what a build still wants (the list holds flowers, vines, bone - the forage trips' own takings), nor the kit
    // (arrows and feathers are in the list, and the kit keeps 64 arrows: the next makeRoom tossed them, audit #7)
    if (inv.JUNK.test(it.name) && keepCount(bot, it) === 0 && !(want || (want = require('./materials').wantedSet(bot)))(it.name)) k = it.count
    // (never below what the build still places of it: the hub's ground cells want dirt, and the clearing's dirt over 64 was
    //  tossed, walked over, picked up and tossed again - 66 tosses in three minutes of building, 2026-10-03)
    else if (it.name === 'dirt' && inv.count(bot, 'dirt') > Math.max(64, buildNeed(bot, 'dirt'))) k = Math.min(it.count, inv.count(bot, 'dirt') - Math.max(64, buildNeed(bot, 'dirt')))
    else if (it.name === 'gravel' && inv.count(bot, 'gravel') > Math.max(16, buildNeed(bot, 'gravel'))) k = Math.min(it.count, inv.count(bot, 'gravel') - Math.max(16, buildNeed(bot, 'gravel')))
    if (k > 0) { try { await bot.toss(it.type, null, k); tossed += k } catch {} }
  }
  if (tossed) log('base', `tossed ${tossed} junk items`)
  return tossed
}

async function makeRoom (bot, slots = 3) {
  if (inv.freeSlots(bot) >= slots) return true
  await tossJunk(bot)
  if (inv.freeSlots(bot) >= slots) return true
  if (distHome(bot) < 48) {
    await depositAll(bot)
    // (still short: the window's blocks go too, only the kit and the band's waited items stay - they come back with the next
    //  withdraw; a pack full of window blocks freed nothing; audit)
    if (inv.freeSlots(bot) < slots && keepHook) await depositAll(bot, { keep: (b, i) => { let w = false; try { w = keepHook(i) === Infinity } catch {} return w ? Infinity : keepCount(b, i) } })
    return inv.freeSlots(bot) >= slots
  }
  return false
}

// A slot for a craft's result (craft.slotForResult; keep = the chain's ingredients, never stored or dropped). With a chest by
// home: the surplus into it - with chests known a full pack crafted nothing and the bot built unarmoured (2026-10-03); the
// caller walks back to its table. With no chest at all (a new base): a player drops a cheap stack - the blocks found
// everywhere again, ones no build wants first, then the smallest. Far from home with chests: nothing (as before).
const CHEAP_RE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|gravel|sand|andesite|diorite|granite|tuff|netherrack)$/
async function roomToCraft (bot, keep = new Set()) {
  if (inv.freeSlots(bot) > 0) return true
  await tossJunk(bot)
  if (inv.freeSlots(bot) > 0) return true
  // (a chest by home: the surplus into it, never the recipe's own - with chests known a full pack crafted nothing: the iron
  //  chestplate's 11 ingots sat in the pack, "the server did not hand over the result", and the bot built and died
  //  unarmoured, 2026-10-03. The caller walks back to its table after: craft.slotForResult)
  if (knownChests(bot).length) {
    if (distHome(bot) >= 48) return false
    // (the shared keep first - the window's blocks stay; still no slot, only the recipe's own and the band's waited items do)
    await depositAll(bot, { keep: (b, it) => keep.has(it.name) ? Infinity : depositKeepOf(b, it) }).catch(() => false)
    if (inv.freeSlots(bot) > 0) return true
    const waited = it => { if (!keepHook) return false; try { return keepHook(it) === Infinity } catch { return false } }
    await depositAll(bot, { keep: (b, it) => keep.has(it.name) || waited(it) ? Infinity : keepCount(b, it) }).catch(() => false)
    return inv.freeSlots(bot) > 0
  }
  const want = require('./materials').wantedSet(bot)
  const stacks = inv.items(bot).filter(i => CHEAP_RE.test(i.name) && !keep.has(i.name))
    .sort((x, y) => (want(x.name) ? 1 : 0) - (want(y.name) ? 1 : 0) || x.count - y.count)
  for (const it of stacks) {
    if (inv.freeSlots(bot) > 0) break
    // (tossStack: that exact slot - toss(type, n) takes from the lowest slot of the type first, across stacks, and
    //  "the smallest" freed nothing - audit 2026-10-03)
    try { await bot.tossStack(it); log('base', `pack full with nowhere to store it - dropped ${it.name} x${it.count} to craft`) } catch {}
  }
  return inv.freeSlots(bot) > 0
}

module.exports = { SPARE_KIT, toolsKept, depositByWear, home, setHome, distHome, withdraw, withdrawMany, depositItem, depositAll, setDepositKeep, depositKeepOf, depositHaul, goHome, tossJunk, makeRoom, roomToCraft, bankCount, bankCounts, knownChests, placeChest, notePlacedChest, ourChest, openChest, keepCount }
