'use strict'
// OFFLINE unit test for #119 C-RECLAIM (design §3.3 + §9.3 C-side): the COMMITMENT LEDGER,
// the reclaim scheduler candidate, session-close teardown, and the anti-grief invariants that
// bound the only code in the project that FILLS terrain. No live server, no test server.
//
// What it proves (each maps to a coordinator-required assertion):
//  1. a debt whose world cell no longer matches the ledger is DROPPED, not re-filled
//     (the operator-cleared case: believe the world, never the record)
//  2. reclaim never touches a cell that is not on the ledger
//  3. reclaim never fills inside a registered build footprint
//  4. an UNKNOWN read fails CLOSED - the debt is kept and the column stops
//  5. a shaft is refilled strictly TOP-DOWN with a coarse material match
//  6. container contents are recorded write-ahead on commit and survive a death
//  7. the reclaim candidate loses to real work and beats idling
// Run:  cd bot && node ledgertest.js

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { Vec3 } = require('vec3')

// AMBIENT-PROOF: every env var the code under test reads is set EXPLICITLY. Nothing is
// inherited from the shell ([[build-agent-light-gate]] - ambient leakage has burned this repo).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.SCAFFOLD_FILE = path.join(tmp, 'scaffold-registry.json')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')
process.env.DEATH_FILE = path.join(tmp, 'last-death.json')
process.env.INFRA_CONSOLIDATE = '1'
process.env.SCAFFOLD_MAX_AGE_MS = String(72 * 3600 * 1000)
process.env.BUILD_DEBUG = ''
process.env.GRAVE_URGENT = '1'
process.env.GRAVE_NEAR = '16'
process.env.GRAVE_URGENT_DIST = '96'
process.env.DYNAMIC_CORE = '1'
process.env.FOOD_SURVIVAL = '1'
// The chooser-ranking assertions below are about the SHIPPING regime's priority stack, so the
// flags that shape bootstrapNeed's verdict are pinned here rather than inherited. Without this
// the "a naked bot does not tidy" test passes or fails depending on the shell: under
// BOOTSTRAP_PRIORITY=0 there is no bootstrap candidate at all, so reclaim wins an empty field
// and the assertion is measuring the flag, not the ranking.
process.env.BOOTSTRAP_PRIORITY = '1'
process.env.CAMP_FIRST = '1'
process.env.RESILIENT_RECOVERY = '1'
process.env.SHELTER_BED_FALLBACK = '1'

let failures = 0
const queue = []
function t (name, fn) { queue.push([name, fn]) }

const scaffold = require('./scaffold.js')
const ledger = require('./ledger.js')
const worldMem = require('./world-memory.js')
const reclaim = require('./reclaim.js')
const core = require('./scheduler-core.js')

// ---- fake world (same shape as surfaceclimbtest) -----------------------------------------
function fakeWorld (cells, loadedCols) {
  const loaded = new Set(loadedCols || Object.keys(cells).map(k => { const [x, , z] = k.split(',').map(Number); return x + ',' + z }))
  return (v) => {
    const ck = Math.floor(v.x) + ',' + Math.floor(v.z)
    if (!loaded.has(ck)) return null // chunk not loaded: NOT information
    const n = cells[Math.floor(v.x) + ',' + Math.floor(v.y) + ',' + Math.floor(v.z)] || 'air'
    return { name: n, position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)), boundingBox: n === 'air' ? 'empty' : 'block' }
  }
}
// A bot that records every PLACEMENT it is asked to make. placeAt is stubbed at the
// provision-core seam so the test observes intent without a server.
function fillBot (cells, pos, items) {
  return {
    game: { minY: -64, height: 384 },
    entity: { position: pos, height: 1.62, onGround: true },
    blockAt: fakeWorld(cells),
    heldItem: null,
    equip: async () => {},
    canDigBlock: () => true,
    inventory: { items: () => (items || []).map(n => ({ name: n, count: 64 })) },
    placed: []
  }
}
// Stub the two seams reclaim.healShafts reaches through: the verified placer and the
// build-footprint oracle. Restores itself.
function stubFill (bot, cells, { protectedCells = [] } = {}) {
  const coreMod = require('./provision-core.js')
  const origPlace = coreMod.placeAt
  const prot = new Set(protectedCells)
  coreMod.placeAt = async (b, target, match) => {
    const k = Math.floor(target.x) + ',' + Math.floor(target.y) + ',' + Math.floor(target.z)
    const item = (b.inventory.items() || []).find(i => match.test(i.name))
    if (!item) return false
    bot.placed.push({ k, name: item.name })
    cells[k] = item.name // the world now shows it - the post-read must agree
    return true
  }
  const origProt = reclaim.isProtected
  // module-level function: patch via the exports object the code calls through
  const restoreProt = (() => {
    const desc = Object.getOwnPropertyDescriptor(reclaim, 'isProtected')
    return () => Object.defineProperty(reclaim, 'isProtected', desc)
  })()
  void origProt; void restoreProt; void prot
  return () => { coreMod.placeAt = origPlace }
}

// ---- 1. the operator-cleared case: the world beats the ledger -----------------------------
t('a shaft debt whose cell is NO LONGER AIR is DROPPED, not re-filled (operator-cleared)', async () => {
  scaffold.oweShaft({ x: 700, y: 65, z: 700 }, 'grass_block')
  // ...but the world shows the cell already filled. Someone closed it - possibly the operator.
  const cells = { '700,65,700': 'stone' }
  const bot = fillBot(cells, new Vec3(700, 66, 700), ['dirt'])
  const restore = stubFill(bot, cells)
  let r
  try { r = await reclaim.healShafts(bot, scaffold.shaftDebts({ x: 700, z: 700 }, 4)) } finally { restore() }
  assert.strictEqual(bot.placed.length, 0, 'NOTHING was placed into a cell the world says is full')
  assert.strictEqual(r.settled, 1, 'the debt was settled on the world read')
  assert.strictEqual(scaffold.shaftDebts({ x: 700, z: 700 }, 4).length, 0, 'and dropped from the books')
})

// ---- 2. only ledger cells are ever touched -----------------------------------------------
t('reclaim never touches a cell that is not on the ledger', async () => {
  scaffold.oweShaft({ x: 710, y: 65, z: 710 }, 'dirt')
  const cells = {} // 710,65,710 is air (our debt); 711,65,710 is also air but NOT ours
  const bot = fillBot({ ...cells, '710,64,710': 'stone', '711,64,710': 'stone' }, new Vec3(710, 66, 710), ['dirt'])
  const world = { '710,64,710': 'stone', '711,64,710': 'stone' }
  bot.blockAt = fakeWorld(world)
  const restore = stubFill(bot, world)
  try { await reclaim.healShafts(bot, scaffold.shaftDebts({ x: 710, z: 710 }, 4)) } finally { restore() }
  const keys = bot.placed.map(p => p.k)
  assert.deepStrictEqual(keys, ['710,65,710'], 'exactly the one ledger cell, nothing beside it')
  // the neighbouring air cell was never a candidate because it was never on the books
  assert.ok(!keys.includes('711,65,710'))
})

// ---- 3. never inside a registered build footprint -----------------------------------------
t('reclaim never fills inside a registered build footprint', async () => {
  const prov = require('./provision.js')
  scaffold.oweShaft({ x: 720, y: 65, z: 720 }, 'stone')
  prov.setBuildZone({ x1: 715, x2: 725, z1: 715, z2: 725 })
  const world = { '720,64,720': 'stone' }
  const bot = fillBot(world, new Vec3(720, 66, 720), ['cobblestone'])
  bot.blockAt = fakeWorld(world)
  const restore = stubFill(bot, world)
  try { await reclaim.healShafts(bot, scaffold.shaftDebts({ x: 720, z: 720 }, 4)) } finally { restore(); prov.setBuildZone(null) }
  assert.strictEqual(bot.placed.length, 0, 'a build owns that ground - hands off')
  assert.strictEqual(scaffold.shaftDebts({ x: 720, z: 720 }, 4).length, 1, 'and the debt is KEPT, not silently dropped')
})

// ---- 4. UNKNOWN fails closed ---------------------------------------------------------------
t('an UNKNOWN read keeps the debt and stops the column (a null is not "empty")', async () => {
  scaffold.oweShaft({ x: 730, y: 65, z: 730 }, 'dirt')
  scaffold.oweShaft({ x: 730, y: 64, z: 730 }, 'dirt')
  // NOTHING is loaded at 730,730 - every read there is null
  const bot = fillBot({}, new Vec3(0, 66, 0), ['dirt'])
  bot.blockAt = fakeWorld({ '0,64,0': 'stone' }, ['0,0'])
  const world = {}
  const restore = stubFill(bot, world)
  let r
  try { r = await reclaim.healShafts(bot, scaffold.shaftDebts({ x: 730, z: 730 }, 4)) } finally { restore() }
  assert.strictEqual(bot.placed.length, 0, 'nothing placed into a chunk we cannot see')
  assert.strictEqual(r.settled, 0, 'and nothing settled either - UNKNOWN proves nothing in EITHER direction')
  assert.strictEqual(scaffold.shaftDebts({ x: 730, z: 730 }, 4).length, 2, 'both cells still owed')
})

// ---- 5. top-down, coarse material match ----------------------------------------------------
t('a shaft is refilled strictly TOP-DOWN with a coarse material match', async () => {
  for (let y = 67; y <= 71; y++) scaffold.oweShaft({ x: 459, y, z: -91 }, y >= 70 ? 'grass_block' : 'dirt')
  // the real 459,-91 fixture: y66 cobblestone floor, y67-71 the void, y72+ the floating plug
  const world = { '459,66,-91': 'cobblestone', '459,72,-91': 'dirt', '459,73,-91': 'dirt', '459,74,-91': 'grass_block' }
  const bot = fillBot(world, new Vec3(459, 67, -91), ['dirt', 'cobblestone'])
  bot.blockAt = fakeWorld(world)
  const restore = stubFill(bot, world)
  try { await reclaim.healShafts(bot, scaffold.shaftDebts({ x: 459, z: -91 }, 2)) } finally { restore() }
  const ys = bot.placed.map(p => Number(p.k.split(',')[1]))
  assert.deepStrictEqual(ys, [71, 70, 69, 68, 67], 'strictly descending - an interrupted pass leaves the plug SUPPORTED')
  assert.ok(bot.placed.every(p => p.name === 'dirt'), 'dirt-family holes take dirt-family fill, not cobblestone (got ' + JSON.stringify(bot.placed.map(p => p.name)) + ')')
  assert.strictEqual(scaffold.shaftDebts({ x: 459, z: -91 }, 2).length, 0, 'the whole column is settled')
})

t('material family: a stone-family hole refuses dirt and takes cobblestone', () => {
  assert.strictEqual(reclaim.familyOf('grass_block'), 'dirt')
  assert.strictEqual(reclaim.familyOf('deepslate'), 'stone')
  assert.strictEqual(reclaim.familyOf('oak_planks'), null, 'a built block has NO family - never guessed at')
})

// ---- 6. container contents: write-ahead, and durable across a death ------------------------
t('container contents are recorded on commit and survive a death', () => {
  // the 2026-07-19 15:39 case: 20 beef go into the remote furnace at 429,70,-119
  worldMem.noteContainer('furnace', { x: 429, y: 70, z: -119 }, { beef: 20, coal: 11 })
  const d = worldMem.containerDebts({ x: 429, z: -119 }, 8)
  assert.strictEqual(d.length, 1, 'the debt exists at all - which it could not before')
  assert.deepStrictEqual(d[0].items, { beef: 20, coal: 11 })
  assert.ok(d[0].value > 20, 'valued above a pile of dirt so it can outscore scaffold litter')

  // DURABILITY: noteContainer flushes SYNCHRONOUSLY, so the record is on disk before the
  // risky window - the whole point of a write-ahead log. Simulate the death by dropping the
  // in-process cache and re-reading the file the way a fresh module load would.
  const onDisk = JSON.parse(fs.readFileSync(process.env.WORLD_MEM_FILE, 'utf8'))
  const rec = (onDisk.infra.furnace || []).find(e => e.x === 429 && e.z === -119)
  assert.ok(rec && rec.contents && rec.contents.beef === 20, 'the beef is on DISK, not just in memory')

  // and a verified-empty read settles it
  worldMem.settleContainer('furnace', { x: 429, y: 70, z: -119 })
  assert.strictEqual(worldMem.containerDebts({ x: 429, z: -119 }, 8).length, 0, 'settled on an empty read')
})

t('a container debt is UNREPRESENTABLE no longer - the ledger reports it as one kind', () => {
  worldMem.noteContainer('furnace', { x: 800, y: 70, z: 800 }, { cooked_beef: 20 })
  const ds = ledger.debts({ near: { x: 800, y: 70, z: 800 }, maxDist: 16 })
  const c = ds.find(d => d.kind === 'container')
  assert.ok(c, 'the container class is in the ONE ledger read')
  assert.strictEqual(c.items.cooked_beef, 20)
  worldMem.settleContainer('furnace', { x: 800, y: 70, z: 800 })
})

// ---- 7. the reclaim candidate competes honestly --------------------------------------------
// A snapshot with no crisis, no bootstrap need, daytime, safe - so the ONLY contest is
// reclaim vs. the build/idle baseline.
function calmSnapshot (extra) {
  return Object.assign({
    hp: 20, food: 20, packFoodPts: 40, bankFoodPts: 40, armorPieces: 4, underArmored: false,
    isNight: false, timeOfDay: 6000, graves: [], deathsRecent: 0, homeDist: 10, homeReachable: true,
    threatDist: null, creeperDist: null, rawIron: 20, bankArmorPieces: 4, bankHasPick: true,
    bankHasSword: true, farm: { exists: true, dist: 10 }, orchard: {}, hutExists: true,
    spawnAnchored: true, hutVerified: true, maintainNeeded: false, persistedBuild: false,
    brainJobPending: false, postDeathRecovery: false, recentDeathCells: [], buildSite: null,
    debt: { value: 0, n: 0, best: null }
  }, extra || {})
}

t('reclaim BEATS idling: a real backlog underfoot outscores doing nothing', () => {
  const idle = core.chooseActivity(calmSnapshot(), {})
  assert.strictEqual(idle.job, null, 'with no debt the bot idles/builds')
  const withDebt = core.chooseActivity(calmSnapshot({
    debt: { value: 200, n: 40, best: { kind: 'scaffold', x: 10, y: 64, z: 10, dist: 2, n: 12, value: 12 } }
  }), {})
  assert.strictEqual(withDebt.job, 'reclaim', 'debt at arm-s reach wins an otherwise empty tick')
  assert.strictEqual(withDebt.cls, 'maintain')
})

t('reclaim LOSES to real work: an active build keeps the body', () => {
  const c = core.chooseActivity(calmSnapshot({
    persistedBuild: true,
    debt: { value: 400, n: 200, best: { kind: 'scaffold', x: 10, y: 64, z: 10, dist: 0, n: 40, value: 40 } }
  }), { activeCls: 'progress', activeJob: 'autobuild' })
  assert.notStrictEqual(c.job, 'reclaim', 'a running build is real work and outranks tidying (chose ' + c.job + ')')
})

t('reclaim LOSES to a bootstrap need: survival infra outranks the backlog', () => {
  // (2026-08-29) the need pinned here is the SPAWN ANCHOR: a naked bot with a confirmed bed is free to
  // work (armour no longer gates while a death is cheap), so nakedness alone is not a bootstrap need
  // any more - an unanchored bot still has one, and it must beat the backlog.
  const c = core.chooseActivity(calmSnapshot({
    armorPieces: 0, underArmored: true, rawIron: 0, bankArmorPieces: 0, spawnAnchored: false, bedKnown: false,
    debt: { value: 400, n: 200, best: { kind: 'scaffold', x: 10, y: 64, z: 10, dist: 0, n: 40, value: 40 } }
  }), {})
  assert.notStrictEqual(c.job, 'reclaim', 'chose ' + c.job + ' - a bot without a spawn anchor does not tidy')
})

t('a far, cheap debt never wins the body (proximity IS the feasibility term)', () => {
  const c = core.chooseActivity(calmSnapshot({
    debt: { value: 3, n: 3, best: { kind: 'scaffold', x: 300, y: 64, z: 300, dist: 200, n: 3, value: 3 } }
  }), {})
  assert.notStrictEqual(c.job, 'reclaim', 'three dirt blocks 200b away are not worth a trip (chose ' + c.job + ')')
})

// ---- session-close coupling -----------------------------------------------------------------
t('endSession(bot) flags what the session placed as OWED and queues it for closeOut', () => {
  scaffold.beginSession('goto')
  scaffold.onPlaced({ x: 900, y: 64, z: 900 })
  scaffold.onPlaced({ x: 900, y: 65, z: 900 })
  const bot = fillBot({}, new Vec3(900, 66, 900), [])
  const n = scaffold.endSession(bot)
  assert.strictEqual(n, 2, 'the frame knew what it placed')
  assert.strictEqual(scaffold.pendingCloseOutCount(), 2, 'both queued for the on-route pass')
  assert.ok(scaffold.near({ x: 900, y: 64, z: 900 }, 4).every(p => p.owed), 'and marked owed on the registry')
})

t('endSession() with no bot still works (back-compat: inSession and the old callers)', () => {
  scaffold.beginSession('goto')
  scaffold.onPlaced({ x: 910, y: 64, z: 910 })
  assert.strictEqual(scaffold.endSession(), 0, 'no bot => nothing queued, no throw')
})

t('closeOut digs ONLY queued, in-reach, filler cells - and never below a standing cell', async () => {
  // drain whatever earlier tests queued
  await scaffold.closeOut(null, {})
  scaffold.beginSession('goto')
  scaffold.onPlaced({ x: 920, y: 64, z: 920 })
  scaffold.onPlaced({ x: 920, y: 65, z: 920 })
  const world = { '920,64,920': 'dirt', '920,65,920': 'dirt', '921,64,920': 'dirt' } // 921 is NOT ours
  const dug = []
  const bot = {
    entity: { position: new Vec3(920, 66, 920) },
    blockAt: fakeWorld(world),
    heldItem: null,
    equip: async () => {},
    canDigBlock: () => true,
    inventory: { items: () => [] },
    dig: async (b) => { dug.push(b.position.x + ',' + b.position.y + ',' + b.position.z); delete world[b.position.x + ',' + b.position.y + ',' + b.position.z] }
  }
  scaffold.endSession(bot)
  const removed = await scaffold.closeOut(bot, {})
  assert.strictEqual(removed, 2, 'both of ours came out (dug ' + JSON.stringify(dug) + ')')
  assert.deepStrictEqual(dug, ['920,65,920', '920,64,920'], 'strictly top-down - the base is never amputated first')
  assert.ok(!dug.some(d => d.startsWith('921,')), 'the neighbouring block was never ours and was never touched')
})

t('closeOut refuses an UNKNOWN cell and refuses to walk for an out-of-reach one', async () => {
  await scaffold.closeOut(null, {})
  scaffold.beginSession('goto')
  scaffold.onPlaced({ x: 930, y: 64, z: 930 }) // in an UNLOADED column
  scaffold.onPlaced({ x: 940, y: 64, z: 940 }) // loaded, ours, but 14b away
  const world = { '940,64,940': 'dirt', '999,64,999': 'stone' }
  const dug = []
  const bot = {
    entity: { position: new Vec3(999, 65, 999) },
    blockAt: fakeWorld(world, ['940,940', '999,999']),
    heldItem: null,
    equip: async () => {},
    canDigBlock: () => true,
    inventory: { items: () => [] },
    dig: async (b) => { dug.push(b.position.toString()) }
  }
  scaffold.endSession(bot)
  const removed = await scaffold.closeOut(bot, {})
  assert.strictEqual(removed, 0, 'nothing dug')
  assert.strictEqual(dug.length, 0)
  assert.strictEqual(scaffold.near({ x: 930, y: 64, z: 930 }, 2).length, 1, 'the UNKNOWN cell is still owed - fail closed')
  assert.strictEqual(scaffold.near({ x: 940, y: 64, z: 940 }, 2).length, 1, 'the far cell is still owed - closeOut never walks')
})

// ---- ledger view sanity ----------------------------------------------------------------------
t('debts() is ONE read over all four commitment classes, sorted worth-first', () => {
  const near = { x: 1000, y: 64, z: 1000 }
  scaffold.add({ x: 1000, y: 64, z: 1000 }, 'pillar')
  scaffold.oweShaft({ x: 1001, y: 64, z: 1000 }, 'stone')
  worldMem.noteContainer('furnace', { x: 1002, y: 64, z: 1000 }, { cooked_beef: 20 })
  const ds = ledger.debts({ near, maxDist: 32 })
  const kinds = new Set(ds.map(d => d.kind))
  assert.ok(kinds.has('scaffold') && kinds.has('shaft') && kinds.has('container'), 'all three live classes present: ' + [...kinds])
  assert.strictEqual(ds[0].kind, 'container', 'the 20 cooked beef are the most valuable thing owed')
  const sum = ledger.summary({ near, maxDist: 32 })
  assert.ok(sum.value > 0 && sum.n >= 3 && sum.best, 'summary carries what the snapshot needs')
  assert.ok(!ds.some(d => d.kind === 'grave' && d.value == null))
  worldMem.settleContainer('furnace', { x: 1002, y: 64, z: 1000 })
})

t('summary() excludes graves so the same debt cannot be counted into two competing jobs', () => {
  const s = ledger.summary({ near: { x: 0, y: 64, z: 0 }, maxDist: 8 })
  assert.ok(!('grave' in (s.best || {})), 'graves stay graveSweep-s, at the survival tier')
})

// ==== #119b THE DEBT ONLY HOUSEKEEPING COULD PAY (live 2026-07-30) ==========================
// #119 made "my items are inside a container over there" REPRESENTABLE, and gave it exactly ONE
// payer: `reclaim`, a TIDINESS candidate that defers on "tidying up is daytime work". A smelt
// interrupted at 16:42 left 3 beef in the hut furnace at 185,67,-106. At 21:01 the bot was at
// food 0, hp 0.48, SEVEN BLOCKS AWAY, logging `secureFood: FARM FLOOR ... fishing dry ->
// establishing/leveling the farm` while re-reading that furnace's record and never opening it.
// It starved beside its own dinner. Cooked meat in my own furnace is FOOD, not housekeeping.
t('food: meat owed in my OWN furnace is drained by the FOOD chain, and the debt settles on the read', async () => {
  const provFood = require('./provision-food.js')
  const F = { x: 185, y: 67, z: -106 }
  worldMem.rememberInfra('hut', { x: 188, y: 67, z: -104 }, { proof: { verdict: 'OK', epoch: require('./pathfix.js').epoch() } })
  worldMem.noteContainer('furnace', F, { beef: 3, oak_planks: 3 }) // recorded RAW, now cooked in the window
  assert.strictEqual(worldMem.containerDebts({ x: 188, z: -104 }, 32).filter(d => d.x === F.x).length, 1, 'the debt is on the books')
  const out = { name: 'cooked_beef', count: 3 }
  const fur = {
    outputItem: () => (out.count ? { name: out.name, count: out.count } : null),
    inputItem: () => null,
    fuelItem: () => null,
    takeOutput: async () => { const r = { name: out.name, count: out.count }; out.count = 0; return r },
    takeInput: async () => null,
    close () {}
  }
  const bot = {
    version: '1.21.11',
    entity: { position: new Vec3(F.x + 0.5, F.y, F.z + 0.5) },
    inventory: { items: () => [] },
    blockAt: p => ({ name: 'furnace', position: p, boundingBox: 'block' }),
    openFurnace: async () => fur
  }
  const got = await provFood.drainOwnFurnaceFood(bot, { home: { x: 188, y: 67, z: -104 } })
  assert.strictEqual(got, 3, 'it must actually take the cooked meat out')
  assert.strictEqual(out.count, 0, 'the furnace output slot is emptied')
  assert.strictEqual(worldMem.containerDebts({ x: 188, z: -104 }, 32).filter(d => d.x === F.x).length, 0,
    'and the debt SETTLES on the grounded window read - not on an assumption')
})

t('food: the own-furnace pantry runs in secureFood BEFORE hunting/fishing/farming', async () => {
  // A rung that exists but is only reachable after the outward legs is the #119 defect again.
  const src = fs.readFileSync(path.join(__dirname, 'provision-food.js'), 'utf8')
  const i = src.indexOf('drainOwnFurnaceFood(bot, { home, isStopped, say })')
  assert.ok(i > 0, 'secureFood must call the own-furnace pantry')
  const bank = src.indexOf('bankFoodFirst(bot, { home, isStopped, say })')
  const hunt = src.indexOf('huntForFood(bot, { isStopped, range: 32 })')
  assert.ok(bank > 0 && hunt > 0, 'the bank and hunt legs must still exist')
  assert.ok(i < bank, 'the furnace is NEARER than the bank and invisible to it - it goes first')
  assert.ok(i < hunt, 'food I already own must outrank going hunting')
})

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
  }
  console.log(failures ? ('\n' + failures + ' FAILED') : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
