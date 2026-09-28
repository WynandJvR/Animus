'use strict'
// Furnaces. smeltItem waits for a small batch; big batches are spread over several furnaces
// (loadFurnaces) and collected later (collectFurnaces) while the bot does something else.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const { log } = require('./log')

const craft = () => require('./craft')
const base = () => require('./base')

// (a lava bucket: a hundred smelts, and vanilla leaves the EMPTY BUCKET in the fuel slot when it is burnt - no fuel,
//  and it blocks the slot: clearBucket takes it back out at every open that feeds or collects, 2026-09-28)
const FUEL = [['coal', 8], ['charcoal', 8], ['coal_block', 80], ['blaze_rod', 12], ['dried_kelp_block', 20], ['lava_bucket', 100]]
// One lava bucket goes only into a furnace with this much queued: the fire burns on with no input and a bucket under
// a small batch is most of it thrown away. The loader fills a furnace to a stack when it is lava's (loadFurnaces).
const LAVA_MIN = 32
function fuelValue (name) {
  for (const [n, v] of FUEL) if (n === name) return v
  if (/_planks$/.test(name)) return 1.5
  if (/_(log|wood|stem)$/.test(name)) return 1.5
  if (name === 'stick') return 0.5
  return 0
}

function inputFor (bot, output, count = 1) {
  const src = craft().SMELT[output]
  if (src !== '#log') return src
  // any log burns to charcoal: the wood we hold (or bank) ENOUGH of for the batch, else the nearest tree's - one acacia
  // log in the pack sent the bot exploring 144 blocks out for three more acacia logs past oak and spruce (2026-09-24)
  const w = craft().preferredWood(bot, count * 4)
  return w + '_log'
}

function furnacesNear (bot, maxDist = 32) {
  return world.findBlocks(bot, /^furnace$/, { maxDistance: maxDist, count: 64 })
}
// THE home furnaces: every furnace round home out to the furnace bank's last ring (hut.furnaceSpots: ring k is 2k out
// from the room, six rings). One definition - three lookups with three radii and counts (16/24, 16/32, 48/12) left
// furnaces the loader never saw.
function homeFurnaces (bot) {
  const home = mem.get().home
  if (!home) return furnacesNear(bot, 32)
  const hp = mem.get().hutPlan
  const half = hp ? Math.max(hp.interior.x2 - hp.interior.x1, hp.interior.z2 - hp.interior.z1) / 2 + 1 : 3
  return world.findBlocks(bot, /^furnace$/, { maxDistance: Math.ceil((half + 2 * require('./hut').BANK_RINGS) * Math.SQRT2) + 1, count: 256, point: new Vec3(home.x, home.y, home.z) })
}

async function placeFurnace (bot) {
  if (!inv.has(bot, 'furnace')) { if (!await craft().ensure(bot, 'furnace', 1)) return null }
  const me = world.feetPos(bot)
  // at home: the hut's utility spots (side-wall slots, then a row along the outside walls)
  const home = mem.get().home
  if (home && world.dist3(me, home) < 24) {
    // the furnace bank round the safehouse first (as many as the build's smelting wants); the room and its first
    // ring are the chests' and the table's
    const hut = require('./hut')
    for (const s of hut.furnaceSpots(bot, 6).slice(0, 6).concat(hut.utilitySpots(bot).slice(0, 6))) {
      if (!move.utilitySpotOK(s)) continue
      if (await act.place(bot, s, 'furnace', { allowZones: ['base'] })) {
        mem.addUnique('furnaces', s)
        log('smelt', `placed a furnace at ${move.fmt(s)}`)
        return bot.blockAt(new Vec3(s.x, s.y, s.z))
      }
    }
    // no neat spot left at home: no furnace (the fallback put one beside the door step)
    return null
  }
  const spots = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, 1, -1]) {
    if (Math.abs(dx) + Math.abs(dz) < 2) continue
    const p = { x: me.x + dx, y: me.y + dy, z: me.z + dz }
    const c = world.at(bot, p.x, p.y, p.z); const b = world.at(bot, p.x, p.y - 1, p.z)
    if (c && world.isAirish(c) && b && world.isSolid(b) && move.utilitySpotOK(p)) spots.push(Object.assign(p, { d: Math.abs(dx) + Math.abs(dz) - (move.insideHut(p) ? 20 : 0) }))
  }
  spots.sort((a, b) => a.d - b.d)
  for (const s of spots.slice(0, 8)) {
    if (await act.place(bot, s, 'furnace')) {
      const home = mem.get().home
      if (home && world.dist3(s, home) < 48) mem.addUnique('furnaces', s)
      log('smelt', `placed a furnace at ${move.fmt(s)}`)
      return bot.blockAt(new Vec3(s.x, s.y, s.z))
    }
  }
  return null
}

// Wood (in planks) beyond what the castle's wood cells still need - with local wood standing in for oak and
// spruce, every log is castle timber until the castle has enough.
function woodSurplus (bot) {
  const b = require('./build')
  const j = b.getJob()
  if (!j) return Infinity
  // reserve only the wood the next few layers need: reserving the whole castle's timber left every furnace
  // without fuel (72 sand and 60 cobble sitting cold) - trees are plentiful, fuel is a small share of them
  const todo = j.cells.filter(c => b.cellDone(bot, c) !== true)
  if (!todo.length) return Infinity
  const minY = Math.min(...todo.map(c => c.y))
  let need = 0
  for (const c of todo) { if (c.y > minY + 4) continue; const k = b.woodClass(c.name); if (k === 'log') need += 4; else if (k === 'planks') need += 1 }
  if (!need) return Infinity
  const counts = Object.assign({}, base().bankCounts())
  for (const [n, v] of Object.entries(inv.counts(bot))) counts[n] = (counts[n] || 0) + v
  let have = 0
  for (const [n, v] of Object.entries(counts)) { if (b.LOG_ANY.test(n)) have += v * 4; else if (b.PLANKS_ANY.test(n)) have += v }
  return have - need
}
// Materials the current build still needs (never burnt as fuel: the castle's oak planks are not firewood).
function buildNeeds (bot) {
  try { const st = require('./build').cachedStatus(bot); return new Set(st ? Object.keys(st.need).filter(k => st.need[k] > 0) : []) } catch { return new Set() }
}

// THE rule for what may burn. pickFuel promises fuel and putFuel loads it: with two rules they disagreed (pickFuel
// counted the build's oak planks, putFuel refused them) and raw meat sat in a cold furnace while the bot went hungry,
// 2026-09-22. Coal always; wood out of the build's surplus - unless the smelt is FOOD: a meal outranks a plank.
// ...built once per fuel decision: the surplus and the build's needs read the whole castle (13888 cells), and asked per
// item, per plank count, per loop turn they held the event loop 5.3s mid-castle (the stall watch named it: fuelOK <
// woodSurplus < cellDone, 2026-09-28). Read once when the first wood is judged, then answered from that.
function fuelRule (bot, { survival = false } = {}) {
  let surplus, needed, reserved, other
  // (any fuel that is not the build's own wood, in the pack or the bank)
  const otherFuel = () => {
    if (other !== undefined) return other
    const counts = Object.assign({}, base().bankCounts()); for (const [n, v] of Object.entries(inv.counts(bot))) counts[n] = (counts[n] || 0) + v
    const sp = n => require('./materials').speciesOf(n)
    other = Object.entries(counts).some(([n, v]) => v > 0 && (n === 'coal' || n === 'charcoal' || (/_(planks|log|stem)$/.test(n) && !/^stripped_/.test(n) && !reserved.has(sp(n)))))
    return other
  }
  return name => {
    if (name === 'coal' || name === 'charcoal') return true
    if (!/_(planks|log|stem)$/.test(name) || /^stripped_/.test(name)) return false
    // (the build's own species is never firewood, a meal or not: the build needs spruce SLABS by name, so "needed" never
    //  named the spruce planks and logs, and an expedition's haul was the next furnace sweep's fuel - audit 2026-09-28)
    if (reserved === undefined) { try { reserved = require('./materials').reservedSpecies(bot) } catch { reserved = new Set() } }
    // (...but a meal outranks a plank: a survival smelt burns the build's wood when nothing else will burn - coal or
    //  other wood, pack or bank; audit 2026-09-28)
    if (reserved.has(require('./materials').speciesOf(name))) { if (!survival || otherFuel()) return false }
    if (survival) return true
    if (surplus === undefined) { surplus = woodSurplus(bot); needed = buildNeeds(bot) }
    return surplus > 0 && !needed.has(name) && !needed.has(name.replace(/_(log|planks)$/, '_log')) && !needed.has(name.replace(/_(log|planks)$/, '_planks'))
  }
}

// noGather: the background smelt queue - fuel from the bank and the build's surplus wood only, never a walk to
// the trees or a wait on a charcoal batch (what it cannot cover, it does not load)
async function pickFuel (bot, itemsToSmelt, { allowWood = true, noCharcoal = false, noGather = false, survival = false } = {}) {
  const need = Math.ceil(itemsToSmelt)
  const burnable = fuelRule(bot, { survival })
  let coal = inv.count(bot, 'coal') + inv.count(bot, 'charcoal')
  // lava counts only for a batch big enough for putFuel to use it on (LAVA_MIN): promised for less, putFuel would not
  // load it and the furnace would stand cold behind a "yes"
  const lava = () => need >= LAVA_MIN ? inv.count(bot, 'lava_bucket') * 100 : 0
  if (coal * 8 + lava() >= need) return true
  // bulk (a castle's worth of stone): no waiting on a charcoal batch - coal from the bank, then wood the
  // build does not need, as planks (charcoal-first stalled the whole brick pipeline behind one furnace)
  if ((need > 24 || noGather) && allowWood) {
    const b = base()
    // (the bank's lava buckets first for a big batch: one is a hundred smelts)
    if (need >= LAVA_MIN && b.bankCount('lava_bucket') > 0) { const k = Math.ceil((need - coal * 8 - lava()) / 100); if (k > 0) await b.withdraw(bot, 'lava_bucket', k).catch(() => 0) }
    if (coal * 8 + lava() >= need) return true
    if (b.bankCount('coal') + b.bankCount('charcoal') > 0) { await b.withdraw(bot, 'coal', Math.ceil(need / 8)).catch(() => 0); await b.withdraw(bot, 'charcoal', Math.ceil(need / 8)).catch(() => 0) }
    coal = inv.count(bot, 'coal') + inv.count(bot, 'charcoal')
    if (coal * 8 + lava() >= need) return true
    const woodOk = burnable
    const plankHeld = () => inv.items(bot).filter(i => /_planks$/.test(i.name) && woodOk(i.name)).reduce((t, i) => t + i.count, 0)
    const short = () => need - coal * 8 - lava() - plankHeld() * 1.5
    const bank = b.bankCounts()
    for (const [n, c] of Object.entries(bank)) { if (short() <= 0) break; if (/_planks$/.test(n) && woodOk(n) && c > 0) await b.withdraw(bot, n, Math.min(c, Math.ceil(short() / 1.5))).catch(() => 0) }
    for (const [n, c] of Object.entries(bank)) { if (short() <= 0) break; if (craft().isLogName(n) && woodOk(n) && c > 0) await b.withdraw(bot, n, Math.min(c, Math.ceil(short() / 6))).catch(() => 0) }
    // planks from the logs in hand only - an ensure here fell through to gathering and sent the bot exploring
    // 108 blocks for dark oak to burn
    for (const it of inv.items(bot).filter(i => craft().isLogName(i.name) && woodOk(i.name))) {
      if (short() <= 0) break
      const k = Math.min(inv.count(bot, it.name), Math.ceil(short() / 6))
      if (k > 0) await craft().plankUp(bot, it.name, k).catch(() => false)
    }
    if (short() <= 0) return true
    if (coal * 8 + lava() + plankHeld() * 1.5 > 0) return true // some fuel: smelt what it covers
  }
  if (noGather) return false
  // a big batch: coal from the bank, else turn logs into charcoal first (a log burnt as planks
  // smelts 6 items; the same log as charcoal smelts 8 and a stack of it fits one slot)
  if (need > 24 && !noCharcoal) {
    const bankCoal = base().bankCount('coal') + base().bankCount('charcoal')
    if (bankCoal > 0) { await base().withdraw(bot, 'coal', Math.ceil(need / 8)).catch(() => 0); await base().withdraw(bot, 'charcoal', Math.ceil(need / 8)).catch(() => 0) }
    coal = inv.count(bot, 'coal') + inv.count(bot, 'charcoal')
    if (coal * 8 >= need) return true
    const logsHere = craft().logCount(bot) + (base().bankCounts ? Object.entries(base().bankCounts()).filter(([k]) => craft().isLogName(k)).reduce((s, [, v]) => s + v, 0) : 0)
    const wantCharcoal = Math.min(64, Math.ceil(need / 8) - coal)
    if (logsHere >= wantCharcoal + 2 && wantCharcoal > 0) {
      log('smelt', `making ${wantCharcoal} charcoal for a ${need}-item smelt`)
      await craft().ensure(bot, 'charcoal', inv.count(bot, 'charcoal') + wantCharcoal).catch(() => false)
      coal = inv.count(bot, 'coal') + inv.count(bot, 'charcoal')
      if (coal * 8 >= need) return true
    }
  }
  // planks burn 1.5 items each
  if (allowWood) {
    const plankItems = inv.items(bot).filter(i => /_planks$/.test(i.name) && burnable(i.name)).reduce((s, i) => s + i.count, 0)
    if (coal * 8 + plankItems * 1.5 >= need) return true
    const logs = inv.items(bot).filter(i => craft().isLogName(i.name) && burnable(i.name)).reduce((s, i) => s + i.count, 0)
    if (coal * 8 + (plankItems + logs * 4) * 1.5 >= need && logs > 0) {
      const w = inv.items(bot).find(i => craft().isLogName(i.name) && burnable(i.name))
      if (w) await craft().ensure(bot, craft().plankOfLog(w.name), Math.min(64, plankItems + Math.ceil((need - coal * 8) / 1.5)), { noWithdraw: true })
      return true
    }
  }
  // bank first, then the world: coal from the mine, else a few logs for planks
  await base().withdraw(bot, 'coal', Math.ceil(need / 8)).catch(() => 0)
  if ((inv.count(bot, 'coal') + inv.count(bot, 'charcoal')) * 8 >= need) return true
  if (allowWood) {
    const w = craft().preferredWood(bot)
    return craft().ensure(bot, w + '_planks', Math.min(64, Math.ceil(need / 1.5)))
  }
  return false
}

// The empty bucket a burnt lava bucket leaves in the fuel slot, back into the pack: no fuel, and while it sits there
// nothing else goes in (putFuel's "a different fuel in the slot" stop) - the furnace stands cold with input and "fuel".
// mineflayer's furnace.takeFuel moves the fuel slot's stack into the pack (bot.putAway); a full pack throws, and the
// bucket waits for the next open. True when one came out.
async function clearBucket (bot, furnace) {
  let f = null
  try { f = furnace.fuelItem() } catch {}
  if (!f || f.name !== 'bucket') return false
  // (room first: with a full pack the take throws and the bucket sits on in the slot, the furnace stalled for good; audit)
  if (inv.freeSlots(bot) < 1 && !inv.items(bot).some(i => i.name === 'bucket' && i.count < 16)) await base().tossJunk(bot).catch(() => 0)
  if (inv.freeSlots(bot) < 1 && !inv.items(bot).some(i => i.name === 'bucket' && i.count < 16)) { log('smelt', 'no room in the pack for the empty bucket in a fuel slot - that furnace waits'); return false }
  try { await furnace.takeFuel(); return true } catch (e) { log('smelt', `could not take the empty bucket out of the fuel slot: ${e.message}`); return false }
}
async function putFuel (bot, furnace, itemsToSmelt, { survival = false } = {}) {
  await clearBucket(bot, furnace)
  let remaining = itemsToSmelt
  const cur = furnace.fuelItem()
  if (cur) remaining -= cur.count * fuelValue(cur.name)
  if (remaining <= 0) return true
  // lava first for a big batch: one bucket (it does not stack), into an empty slot only
  if (!cur && remaining >= LAVA_MIN) {
    const lb = inv.items(bot).find(i => i.name === 'lava_bucket')
    if (lb) { try { await furnace.putFuel(lb.type, null, 1); remaining -= fuelValue('lava_bucket') } catch (e) { log('smelt', `putFuel lava_bucket failed: ${e.message}`) } }
    if (remaining <= 0) return true
  }
  const burnable = fuelRule(bot, { survival })
  const order = ['coal', 'charcoal'].concat(inv.items(bot).filter(i => /_planks$/.test(i.name) && burnable(i.name)).map(i => i.name))
  for (const n of [...new Set(order)]) {
    // one stack at a time, looked up fresh each time (a remembered item object went stale after the withdraws:
    // "Can't find birch_planks in slots", "reading 'type' of null")
    for (let guard = 0; guard < 4 && remaining > 0; guard++) {
      const fuelNow = furnace.fuelItem()
      if (fuelNow && fuelNow.name !== n) break
      if (fuelNow && fuelNow.count >= 64) break
      const it = inv.items(bot).find(i => i.name === n)
      if (!it) break
      const k = Math.min(it.count, Math.ceil(remaining / fuelValue(n)), 64 - (fuelNow ? fuelNow.count : 0))
      if (k <= 0) break
      try { await furnace.putFuel(it.type, null, k); remaining -= k * fuelValue(n) } catch (e) { log('smelt', `putFuel failed: ${e.message}`); break }
    }
    if (remaining <= 0) break
  }
  return remaining <= 0
}

// THE FURNACE LEDGER: which furnaces hold something of ours (loaded, or found with an input or an output). Collecting
// and refuelling visit those - and any showing lit - never every furnace: with the bank grown to 35 furnaces each visit
// home opened all 35 to find them empty, 26 minutes of walks in two and a half hours (2026-09-24). No ledger yet (the
// first visit after it came in): every furnace once, to fill it.
function fkey (p) { return `${p.x},${p.y},${p.z}` }
function markFurnace (p, what) { mem.update(m => { m.furnaceUse = m.furnaceUse || {}; if (what) m.furnaceUse[fkey(p)] = what; else delete m.furnaceUse[fkey(p)] }) }
// Is the furnace burning? The block state may come as a boolean or as the string 'true'/'false': `!!'false'` read every
// cold furnace as lit - never refuelled, never skipped as stalled (audit #26, 2026-09-27). Read like world.holdsWater.
function isLit (b) { try { const v = b.getProperties().lit; return v === true || v === 'true' } catch { return false } }
function note (fb, f, bot) {
  let inp = null; let out = null; let fuel = null
  try { inp = f.inputItem(); out = f.outputItem(); fuel = f.fuelItem() } catch {}
  // (fuel = coal in the slot OR the fire still burning: the last coal leaves the slot empty while it smelts on - taken for
  //  "stalled", that furnace was skipped and its ingots never collected; audit #26)
  const lit = isLit(bot ? bot.blockAt(fb.position) : fb)
  // (an empty bucket left by a burnt lava bucket is no fuel: counted as fuel, a cold furnace behind it never read stalled)
  const fuelled = !!fuel && fuelValue(fuel.name) > 0
  markFurnace(fb.position, inp || out ? { input: inp ? inp.name : null, output: out ? out.name : null, inN: inp ? inp.count : 0, outN: out ? out.count : 0, fuel: fuelled || lit, at: Date.now() } : null)
}
function busyFurnaces (bot) {
  const all = homeFurnaces(bot)
  const use = mem.get().furnaceUse
  if (!use) return all
  return all.filter(b => use[fkey(b.position)] || isLit(b))
}

async function openAt (bot, block) {
  if (!act.reach(bot, block.position, 4)) {
    const r = await move.goTo(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), { timeoutMs: 30000, label: 'to furnace' })
    if (!r.ok) return null
  }
  try { return await act.openSettled(bot, bot.blockAt(block.position), 'openFurnace') } catch (e) { log('smelt', `can't open furnace: ${e.message}`); return null }
}

// Smelt `count` of `output` and wait for it. Uses up to `maxFurnaces` furnaces in parallel.
async function smeltItem (bot, output, count, ctx = {}) {
  const input = inputFor(bot, output, count)
  if (!input) return false
  const target = inv.count(bot, output) + count
  if (inv.count(bot, input) < count) {
    if (!await craft().ensure(bot, input, count, ctx)) return false
  }
  const survival = Object.values(inv.COOKED_OF).includes(output) // cooking a meal may burn the build's wood
  if (!await pickFuel(bot, count, { noCharcoal: output === 'charcoal', survival })) { log('smelt', `no fuel for ${count} ${output}`); return false }
  const nFurn = Math.max(1, Math.min(4, Math.ceil(count / 16)))
  let furns = furnacesNear(bot, 48)
  // furnaces live at home: away from it, walk back rather than leave a trail of furnaces across the map
  const home = mem.get().home
  if (home && world.dist3(bot.entity.position, home) > 32 && !furns.some(f => world.dist3(f.position, home) < 32)) {
    const r = await require('./base').goHome(bot, { shouldStop: ctx.shouldStop })
    if (!r.ok) return false
    furns = furnacesNear(bot, 48)
  }
  while (furns.length < nFurn) {
    if (!await placeFurnace(bot)) break
    furns = furnacesNear(bot, 48)
  }
  if (!furns.length) return false
  // idle (unlit) furnaces first: a lit one is busy with another batch
  furns.sort((a, b) => isLit(a) - isLit(b) || (move.insideHut(b.position) ? 1 : 0) - (move.insideHut(a.position) ? 1 : 0))
  furns = furns.slice(0, nFurn)
  const per = Math.ceil(count / furns.length)
  let loaded = 0
  for (const fb of furns) {
    const left = Math.min(per, count - loaded, inv.count(bot, input))
    if (left <= 0) break
    const f = await openAt(bot, fb)
    if (!f) continue
    try {
      if (f.outputItem()) await f.takeOutput().catch(() => {})
      const inItem = f.inputItem()
      if (inItem && inItem.name !== input) { f.close(); continue }
      if (!await putFuel(bot, f, left, { survival }) && !f.fuelItem()) { log('smelt', `no fuel that may burn for ${output}`); continue }
      const it = inv.items(bot).find(i => i.name === input)
      if (it) { await f.putInput(it.type, null, Math.min(left, it.count)); loaded += Math.min(left, it.count); markFurnace(fb.position, { input, at: Date.now() }) }
    } catch (e) { log('smelt', `loading furnace failed: ${e.message}`) } finally { try { note(fb, f, bot) } catch {} try { f.close() } catch {} }
  }
  if (!loaded) {
    // every furnace is busy with something else (the stone batch): one more furnace, not a stall
    // ("can't get 4 charcoal for torch" for hours while six furnaces cooked cobble)
    if (!ctx._extraFurnace && (inv.has(bot, 'furnace') || inv.count(bot, 'cobblestone') >= 8)) {
      const nf = await placeFurnace(bot)
      if (nf) return smeltItem(bot, output, count, Object.assign({}, ctx, { _extraFurnace: true }))
    }
    return false
  }
  log('smelt', `smelting ${loaded} ${input} -> ${output} in ${furns.length} furnace(s)`)
  // wait, collecting as it comes
  const t0 = Date.now()
  const maxWait = (Math.ceil(loaded / furns.length) * 10 + 20) * 1000
  while (inv.count(bot, output) < target && Date.now() - t0 < maxWait) {
    await move.sleep(Math.min(10000, Math.max(3000, maxWait / 10)))
    if (ctx.shouldStop && ctx.shouldStop()) break
    for (const fb of furns) {
      const f = await openAt(bot, fb)
      if (!f) continue
      // (noted like every other open: the wait's takes left the ledger saying "output waiting" - audit #26, 2026-09-27)
      try { if (f.outputItem()) await f.takeOutput() } catch {} finally { try { note(fb, f, bot) } catch {} try { f.close() } catch {} }
    }
  }
  return inv.count(bot, output) >= target
}

// Background smelting for bulk jobs: load every furnace at home with `input`, return at once.
async function loadFurnaces (bot, input, maxItems, { anyWood = false } = {}) {
  // (the one door every log goes through to become charcoal: never the build's own species - a stripped or spruce log
  //  smelted is a castle cell short; 31 spruce logs went in this way, 2026-09-28)
  try { if (/_(log|wood)$/.test(input) && require('./materials').isReservedWood(bot, input)) { log('smelt', `not smelting ${input} - the build's own wood`); return 0 } } catch {}
  const home = mem.get().home
  let furns = homeFurnaces(bot)
  // the furnace inside the safehouse stays free for charcoal (torches) and cooking when there are others
  if (furns.length >= 3) furns = furns.filter(f => !move.insideHut(f.position))
  let loaded = 0
  // spread evenly: filling each furnace to 64 in turn put 130 cobble in two furnaces while twelve sat idle
  // (10 seconds an item per furnace - even spread is the whole speed-up)
  const perFurnace = Math.max(8, Math.ceil(Math.min(maxItems, inv.count(bot, input)) / Math.max(1, furns.length)))
  // (a furnace fed a lava bucket takes a full stack: a hundred smelts under the even spread's 17 was a bucket burnt for
  //  17 - LAVA_MIN; so while lava is held, a furnace with its fuel slot free is filled to 64 and burns it, 2026-09-28)
  const lavaHeld = () => inv.count(bot, 'lava_bucket') > 0
  for (const fb of furns) {
    if (loaded >= maxItems) break
    if (!inv.count(bot, input)) break
    const f = await openAt(bot, fb)
    if (!f) continue
    try {
      if (f.outputItem()) await f.takeOutput().catch(() => {})
      await clearBucket(bot, f)
      const cur = f.inputItem()
      if (cur && cur.name !== input) continue
      const have = Math.min(inv.count(bot, input), lavaHeld() && !f.fuelItem() ? 64 : perFurnace)
      const room = 64 - (cur ? cur.count : 0)
      const k = Math.min(room, have, maxItems - loaded)
      if (k <= 0) continue
      const fuelled = await putFuel(bot, f, k + (cur ? cur.count : 0), { survival: anyWood })
      if (!fuelled && !f.fuelItem()) continue
      const it = inv.items(bot).find(i => i.name === input)
      await f.putInput(it.type, null, k)
      markFurnace(fb.position, { input, at: Date.now() })
      loaded += k
    } catch (e) { log('smelt', `load failed: ${e.message}`) } finally { try { note(fb, f, bot) } catch {} try { f.close() } catch {} }
  }
  if (loaded) {
    log('smelt', `loaded ${loaded} ${input} into the furnaces`)
    // remembered as work in flight: what's cooking is not a shortage to go gathering for again
    const eta = Date.now() + Math.ceil(loaded / Math.max(1, furns.length)) * 10000 + 120000
    inFlightLoads.push({ input, n: loaded, until: eta })
  }
  return loaded
}
const inFlightLoads = []

// Charcoal from logs cut FOR fuel. They were gathered to burn, so the build's wood reservation does not apply:
// counted against it, 32 fresh logs were "the next layers' wood", nothing was ever spare, and 66 clay balls waited
// in the chest for a fire that never came (2026-09-23). One log in seven, as planks, lights the rest (a log's planks
// smelt 6); the charcoal then keeps the kiln going. Loaded in the background like any bulk smelt.
async function burnForCharcoal (bot, logName, n) {
  // (never the build's own wood: the fuel task harvested the orchard - spruce now - and burnt 31 spruce logs into charcoal
  //  while the castle waited on spruce slabs, 2026-09-28. The one rule at the one burner)
  try { if (require('./materials').isReservedWood(bot, logName)) { log('smelt', `not burning ${n} ${logName} - the build's own wood`); return 0 } } catch {}
  const k = Math.min(n, inv.count(bot, logName))
  if (k < 2) return 0
  const lighters = Math.max(1, Math.ceil(k / 7))
  if (!(inv.count(bot, 'coal') + inv.count(bot, 'charcoal'))) await craft().plankUp(bot, logName, lighters).catch(() => false)
  const loaded = await loadFurnaces(bot, logName, inv.count(bot, logName), { anyWood: true })
  if (loaded) log('smelt', `burning ${loaded} ${logName} into charcoal (cut for fuel)`)
  return loaded
}
// what an input comes out of the furnace as: the one smelting table (craft.SMELT, output -> input) read backwards
// (a second hand-kept table here knew four inputs, so bricks and cracked bricks never counted as cooking)
function smeltsTo (input) {
  if (input === 'red_sand') return 'glass'
  if (craft().isLogName(input)) return 'charcoal'
  for (const [out, inp] of Object.entries(craft().SMELT)) if (inp === input) return out
  return null
}
// items of `output` still cooking in the home furnaces (from loads this session, until they should be done)
function inFlight (output) {
  const now = Date.now()
  for (let i = inFlightLoads.length - 1; i >= 0; i--) if (inFlightLoads[i].until < now) inFlightLoads.splice(i, 1)
  return inFlightLoads.filter(l => smeltsTo(l.input) === output).reduce((t, l) => t + l.n, 0)
}
// collected output is stock now, no longer in flight
function landed (output, n) {
  for (const l of inFlightLoads) {
    if (n <= 0) break
    if (smeltsTo(l.input) !== output) continue
    const k = Math.min(n, l.n); l.n -= k; n -= k
  }
  for (let i = inFlightLoads.length - 1; i >= 0; i--) if (inFlightLoads[i].n <= 0) inFlightLoads.splice(i, 1)
}

// Furnaces holding input with no fuel left (cold, their batch stalled): feed them.
async function refuelFurnaces (bot) {
  const home = mem.get().home
  if (!home) return 0
  let fed = 0
  // (no fuel anywhere: no walk round the cold furnaces to find that out again)
  if (!inv.items(bot).some(i => fuelValue(i.name) > 0) && !Object.entries(require('./base').bankCounts()).some(([n, c]) => c > 0 && fuelValue(n) > 0)) return 0
  for (const fb of busyFurnaces(bot)) {
    if (isLit(fb)) continue
    const f = await openAt(bot, fb)
    if (!f) continue
    try {
      if (f.outputItem()) await f.takeOutput().catch(() => {})
      await clearBucket(bot, f)
      const input = f.inputItem()
      if (input && !f.fuelItem()) {
        const survival = !!inv.COOKED_OF[input.name] // raw food waiting in a cold furnace is a meal, not the build's
        if (!await pickFuel(bot, input.count, { survival })) { log('smelt', 'no fuel for the cold furnaces'); break }
        if (await putFuel(bot, f, input.count, { survival })) fed++
      }
    } catch (e) { log('smelt', `refuel failed: ${e.message}`) } finally { try { note(fb, f, bot) } catch {} try { f.close() } catch {} }
  }
  if (fed) log('smelt', `refuelled ${fed} cold furnace${fed > 1 ? 's' : ''}`)
  return fed
}

async function collectFurnaces (bot) {
  const home = mem.get().home
  const furns = home ? busyFurnaces(bot) : furnacesNear(bot, 32)
  const first = !mem.get().furnaceUse
  if (first) mem.set('furnaceUse', {})
  let got = 0; let buckets = 0
  // (a cold furnace last seen with input, no output and no fuel has made nothing since: not walked to - seven stalled
  //  furnaces were opened every round, three minutes of every ten-minute day, 2026-09-27)
  const use = mem.get().furnaceUse || {}
  const stalled = fb => { if (isLit(fb)) return false; const u = use[fkey(fb.position)]; return !!(u && u.input && !u.output && u.fuel === false) }
  // (worth the walk: a furnace still smelting with under 8 made since it was last seen waits for the next round - 10s an
  //  item from the ledger's own counts. 48 furnaces opened every round for a few items each: 30-63s of every castle round,
  //  2026-09-28)
  const worth = fb => { const u = use[fkey(fb.position)]; if (!u || u.inN == null || !u.inN) return true; const made = Math.floor((Date.now() - u.at) / 10000); return made >= u.inN || (u.outN || 0) + made >= 8 } // (all its input done: always)
  for (const fb of furns) {
    if (stalled(fb) || !worth(fb)) continue
    const f = await openAt(bot, fb)
    if (!f) continue
    // (the ledger noted in finally: a takeOutput that threw skipped it, and the furnace kept its stale entry)
    // (and the empty bucket a burnt lava bucket left in the fuel slot - it blocks the slot, and it is the next lava trip's)
    try { const o = f.outputItem(); if (o) { await f.takeOutput(); got += o.count; landed(o.name, o.count) } if (await clearBucket(bot, f)) buckets++ } catch {} finally { try { note(fb, f, bot) } catch {} try { f.close() } catch {} }
    if (inv.freeSlots(bot) <= 1) break
  }
  if (got) log('smelt', `collected ${got} items from the furnaces`)
  if (buckets) log('smelt', `took ${buckets} empty bucket${buckets > 1 ? 's' : ''} back out of the fuel slots`)
  return got
}

module.exports = { burnForCharcoal, inFlight, smeltsTo, woodSurplus, smeltItem, loadFurnaces, collectFurnaces, refuelFurnaces, placeFurnace, furnacesNear, homeFurnaces, pickFuel, putFuel, fuelValue, clearBucket, LAVA_MIN, buildNeeds }
