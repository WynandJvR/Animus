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

const FUEL = [['coal', 8], ['charcoal', 8], ['coal_block', 80], ['blaze_rod', 12], ['dried_kelp_block', 20]]
function fuelValue (name) {
  for (const [n, v] of FUEL) if (n === name) return v
  if (/_planks$/.test(name)) return 1.5
  if (/_(log|wood|stem)$/.test(name)) return 1.5
  if (name === 'stick') return 0.5
  return 0
}

function inputFor (bot, output) {
  const src = craft().SMELT[output]
  if (src !== '#log') return src
  const w = craft().preferredWood(bot)
  return w + '_log'
}

function furnacesNear (bot, maxDist = 32) {
  return world.findBlocks(bot, /^furnace$/, { maxDistance: maxDist, count: 12 })
}

async function placeFurnace (bot) {
  if (!inv.has(bot, 'furnace')) { if (!await craft().ensure(bot, 'furnace', 1)) return null }
  const me = world.feetPos(bot)
  // at home: the hut's utility spots (side-wall slots, then a row along the outside walls)
  const home = mem.get().home
  if (home && world.dist3(me, home) < 24) {
    for (const s of require('./hut').utilitySpots(bot).slice(0, 6)) {
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
  try { const st = require('./build').status(bot); return new Set(st ? Object.keys(st.need).filter(k => st.need[k] > 0) : []) } catch { return new Set() }
}

async function pickFuel (bot, itemsToSmelt, { allowWood = true, noCharcoal = false } = {}) {
  const need = Math.ceil(itemsToSmelt)
  let coal = inv.count(bot, 'coal') + inv.count(bot, 'charcoal')
  if (coal * 8 >= need) return true
  // bulk (a castle's worth of stone): no waiting on a charcoal batch - coal from the bank, then wood the
  // build does not need, as planks (charcoal-first stalled the whole brick pipeline behind one furnace)
  if (need > 24 && allowWood) {
    const b = base()
    if (b.bankCount('coal') + b.bankCount('charcoal') > 0) { await b.withdraw(bot, 'coal', Math.ceil(need / 8)).catch(() => 0); await b.withdraw(bot, 'charcoal', Math.ceil(need / 8)).catch(() => 0) }
    coal = inv.count(bot, 'coal') + inv.count(bot, 'charcoal')
    if (coal * 8 >= need) return true
    const needed = buildNeeds(bot)
    const surplus = woodSurplus(bot)
    // wood burns only out of the castle's surplus
    const woodOk = n => surplus > 0 && !needed.has(n) && !needed.has(n.replace(/_(log|planks)$/, '_log')) && !needed.has(n.replace(/_(log|planks)$/, '_planks'))
    const plankHeld = () => inv.items(bot).filter(i => /_planks$/.test(i.name) && woodOk(i.name)).reduce((t, i) => t + i.count, 0)
    const short = () => need - coal * 8 - plankHeld() * 1.5
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
    if (coal * 8 + plankHeld() * 1.5 > 0) return true // some fuel: smelt what it covers
  }
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
    const plankItems = inv.items(bot).filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0)
    if (coal * 8 + plankItems * 1.5 >= need) return true
    const logs = craft().logCount(bot)
    if (coal * 8 + (plankItems + logs * 4) * 1.5 >= need && logs > 0) {
      const w = inv.items(bot).find(i => craft().isLogName(i.name))
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

async function putFuel (bot, furnace, itemsToSmelt) {
  let remaining = itemsToSmelt
  const cur = furnace.fuelItem()
  if (cur) remaining -= cur.count * fuelValue(cur.name)
  if (remaining <= 0) return true
  const needed = buildNeeds(bot)
  const spare = woodSurplus(bot)
  const order = ['coal', 'charcoal'].concat(spare > 0 ? inv.items(bot).filter(i => /_planks$/.test(i.name) && !needed.has(i.name)).map(i => i.name) : [])
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

async function openAt (bot, block) {
  if (!act.reach(bot, block.position, 4)) {
    const r = await move.goTo(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), { timeoutMs: 30000, label: 'to furnace' })
    if (!r.ok) return null
  }
  try { return await bot.openFurnace(bot.blockAt(block.position)) } catch (e) { log('smelt', `can't open furnace: ${e.message}`); return null }
}

// Smelt `count` of `output` and wait for it. Uses up to `maxFurnaces` furnaces in parallel.
async function smeltItem (bot, output, count, ctx = {}) {
  const input = inputFor(bot, output)
  if (!input) return false
  const target = inv.count(bot, output) + count
  if (inv.count(bot, input) < count) {
    if (!await craft().ensure(bot, input, count, ctx)) return false
  }
  if (!await pickFuel(bot, count, { noCharcoal: output === 'charcoal' })) { log('smelt', `no fuel for ${count} ${output}`); return false }
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
  const lit = f => { try { return f.getProperties().lit ? 1 : 0 } catch { return 0 } }
  furns.sort((a, b) => lit(a) - lit(b) || (move.insideHut(b.position) ? 1 : 0) - (move.insideHut(a.position) ? 1 : 0))
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
      await putFuel(bot, f, left)
      const it = inv.items(bot).find(i => i.name === input)
      if (it) { await f.putInput(it.type, null, Math.min(left, it.count)); loaded += Math.min(left, it.count) }
    } catch (e) { log('smelt', `loading furnace failed: ${e.message}`) } finally { try { f.close() } catch {} }
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
      try { if (f.outputItem()) await f.takeOutput() } catch {} finally { try { f.close() } catch {} }
    }
  }
  return inv.count(bot, output) >= target
}

// Background smelting for bulk jobs: load every furnace at home with `input`, return at once.
async function loadFurnaces (bot, input, maxItems) {
  const home = mem.get().home
  let furns = home ? world.findBlocks(bot, /^furnace$/, { maxDistance: 16, count: 24, point: new Vec3(home.x, home.y, home.z) }) : furnacesNear(bot, 32)
  // the furnace inside the safehouse stays free for charcoal (torches) and cooking when there are others
  if (furns.length >= 3) furns = furns.filter(f => !move.insideHut(f.position))
  let loaded = 0
  // spread evenly: filling each furnace to 64 in turn put 130 cobble in two furnaces while twelve sat idle
  // (10 seconds an item per furnace - even spread is the whole speed-up)
  const perFurnace = Math.max(8, Math.ceil(Math.min(maxItems, inv.count(bot, input)) / Math.max(1, furns.length)))
  for (const fb of furns) {
    if (loaded >= maxItems) break
    const have = Math.min(inv.count(bot, input), perFurnace)
    if (!have) break
    const f = await openAt(bot, fb)
    if (!f) continue
    try {
      if (f.outputItem()) await f.takeOutput().catch(() => {})
      const cur = f.inputItem()
      if (cur && cur.name !== input) continue
      const room = 64 - (cur ? cur.count : 0)
      const k = Math.min(room, have, maxItems - loaded)
      if (k <= 0) continue
      const fuelled = await putFuel(bot, f, k + (cur ? cur.count : 0))
      if (!fuelled && !f.fuelItem()) continue
      const it = inv.items(bot).find(i => i.name === input)
      await f.putInput(it.type, null, k)
      loaded += k
    } catch (e) { log('smelt', `load failed: ${e.message}`) } finally { try { f.close() } catch {} }
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
const SMELTS_TO = { sand: 'glass', red_sand: 'glass', cobblestone: 'stone', raw_iron: 'iron_ingot' }
// items of `output` still cooking in the home furnaces (from loads this session, until they should be done)
function inFlight (output) {
  const now = Date.now()
  for (let i = inFlightLoads.length - 1; i >= 0; i--) if (inFlightLoads[i].until < now) inFlightLoads.splice(i, 1)
  return inFlightLoads.filter(l => SMELTS_TO[l.input] === output).reduce((t, l) => t + l.n, 0)
}
// collected output is stock now, no longer in flight
function landed (output, n) {
  for (const l of inFlightLoads) {
    if (n <= 0) break
    if (SMELTS_TO[l.input] !== output) continue
    const k = Math.min(n, l.n); l.n -= k; n -= k
  }
  for (let i = inFlightLoads.length - 1; i >= 0; i--) if (inFlightLoads[i].n <= 0) inFlightLoads.splice(i, 1)
}

// Furnaces holding input with no fuel left (cold, their batch stalled): feed them.
async function refuelFurnaces (bot) {
  const home = mem.get().home
  if (!home) return 0
  let fed = 0
  for (const fb of world.findBlocks(bot, /^furnace$/, { maxDistance: 16, count: 24, point: new Vec3(home.x, home.y, home.z) })) {
    let lit = false
    try { lit = !!fb.getProperties().lit } catch {}
    if (lit) continue
    const f = await openAt(bot, fb)
    if (!f) continue
    try {
      if (f.outputItem()) await f.takeOutput().catch(() => {})
      const input = f.inputItem()
      if (input && !f.fuelItem()) {
        if (!await pickFuel(bot, input.count)) { log('smelt', 'no fuel for the cold furnaces'); break }
        if (await putFuel(bot, f, input.count)) fed++
      }
    } catch (e) { log('smelt', `refuel failed: ${e.message}`) } finally { try { f.close() } catch {} }
  }
  if (fed) log('smelt', `refuelled ${fed} cold furnace${fed > 1 ? 's' : ''}`)
  return fed
}

async function collectFurnaces (bot) {
  const home = mem.get().home
  const furns = furnacesNear(bot, 32).filter(f => !home || world.dist3(f.position, home) < 48)
  let got = 0
  for (const fb of furns) {
    const f = await openAt(bot, fb)
    if (!f) continue
    try { const o = f.outputItem(); if (o) { await f.takeOutput(); got += o.count; landed(o.name, o.count) } } catch {} finally { try { f.close() } catch {} }
    if (inv.freeSlots(bot) <= 1) break
  }
  if (got) log('smelt', `collected ${got} items from the furnaces`)
  return got
}

module.exports = { inFlight, woodSurplus, smeltItem, loadFurnaces, collectFurnaces, refuelFurnaces, placeFurnace, furnacesNear, pickFuel, fuelValue, buildNeeds }
