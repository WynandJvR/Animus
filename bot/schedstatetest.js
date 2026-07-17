'use strict'
// OFFLINE unit test for provision.schedulerState (S4, DESIGN §4) - the async snapshot builder that
// assembles the plain-data superset of survivalState(bot) the pure scheduler consumes. No live bot,
// no server: a MINIMAL stub bot + WORLD_MEM_FILE / DEATH_FILE / RESUME_FILE env isolation set BEFORE
// the requires (so provision/commands read the fixtures, never live memory). Run: cd bot && node schedstatetest.js

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')

// ---- ENV ISOLATION (set BEFORE requiring provision/commands - they read these at load time) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schedstate-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.DEATH_FILE = path.join(tmp, 'last-death.json')
process.env.RESUME_FILE = path.join(tmp, 'resume-job.json')
process.env.EPISODE_LOG = path.join(tmp, 'body-episodes.jsonl')
process.env.STATE_HISTORY_FILE = path.join(tmp, 'state-history.jsonl')

// a FRESH, unretrieved iron grave in the death ledger (loaded at commands require time). Placed so
// home (the bed at 110,100) is nearer than the bot (100,100) -> dist must resolve to min(bot,home).
const NOW = Date.now()
const GRAVE = { x: 112, y: 65, z: 100, at: NOW, dangerous: false, items: { notable: ['iron_pickaxe', 'iron_helmet'], count: 2 } }
fs.writeFileSync(process.env.DEATH_FILE, JSON.stringify({ deaths: [GRAVE] }))

const provision = require('./provision.js')
require('./commands.js') // required for its side-effect: loads the death-ledger fixture that schedulerState reads via gravesSnapshot

// ---- harness (async: schedulerState is async) ----
const tests = []
function t (name, fn) { tests.push([name, fn]) }

const VERSION = '1.21.11'
function stubBot ({ health = 20, food = 20, items = [], worn = {}, pos = new Vec3(100, 65, 100), timeOfDay = 6000 } = {}) {
  const slotIndex = { head: 5, torso: 6, legs: 7, feet: 8 }
  const slots = []
  for (const k of Object.keys(slotIndex)) if (worn[k]) slots[slotIndex[k]] = { name: worn[k] }
  return {
    version: VERSION,
    health, food,
    entity: { position: pos, height: 1.62, isInLava: false },
    entities: {},
    time: { timeOfDay },
    isSleeping: false,
    blockAt: () => null,
    getEquipmentDestSlot: (name) => slotIndex[name],
    inventory: { items: () => items.slice(), slots }
  }
}

// (a) survivalState fields are present (spread once, never re-scanned)
t('(a) survivalState fields present + hp/food passthrough', async () => {
  const s = await provision.schedulerState(stubBot({ health: 17, food: 13 }))
  for (const k of ['hp', 'food', 'threatDist', 'creeperDist', 'drowning', 'inLava', 'onFire', 'isNight', 'underArmored', 'nightStuck']) {
    assert.ok(k in s, 'field ' + k + ' present')
  }
  assert.strictEqual(s.hp, 17)
  assert.strictEqual(s.food, 13)
})

// (b) packFoodPts sums the tier<2 pack food only (tier gate excludes rotten_flesh)
t('(b) packFoodPts: bread x2 -> 10 pts; rotten_flesh (tier 2) excluded', async () => {
  const s = await provision.schedulerState(stubBot({ items: [{ name: 'bread', count: 2 }, { name: 'rotten_flesh', count: 5 }] }))
  assert.strictEqual(s.packFoodPts, 10, 'bread=5pts x2 = 10; rotten_flesh gated out, got ' + s.packFoodPts)
})

// (c) packArmorPieces counts an UNWORN iron_helmet; armorPieces counts worn (0 here)
t('(c) packArmorPieces counts an unworn iron_helmet; armorPieces 0', async () => {
  const s = await provision.schedulerState(stubBot({ items: [{ name: 'iron_helmet', count: 1 }, { name: 'cobblestone', count: 32 }] }))
  assert.strictEqual(s.packArmorPieces, 1, 'unworn iron_helmet counted, got ' + s.packArmorPieces)
  assert.strictEqual(s.armorPieces, 0, 'nothing worn')
})

// (d) homeDist: null on empty world-mem, numeric once a bed exists
t('(d) homeDist null with no home, ~10 with a bed 10b away', async () => {
  // the temp world-mem starts empty (no bed persisted yet) - so homeDist is null before rememberBed
  let s = await provision.schedulerState(stubBot({}))
  assert.strictEqual(s.homeDist, null, 'no hut + no bed -> homeDist null')
  provision.rememberBed({ x: 110, y: 65, z: 100 }) // 10b east of the bot at 100,100
  s = await provision.schedulerState(stubBot({}))
  assert.ok(typeof s.homeDist === 'number' && Math.abs(s.homeDist - 10) < 0.5, 'bed 10b away -> homeDist ~10, got ' + s.homeDist)
  assert.strictEqual(s.homeReachable, true, 'homeDist 10 <= 48 -> homeReachable')
})

// (e) graves passthrough via the ledger, dist = min(bot, home)
t('(e) graves from the ledger; dist = min(bot 12b, home 2b) = ~2', async () => {
  provision.rememberBed({ x: 110, y: 65, z: 100 }) // ensure home is the bed at 110,100
  const s = await provision.schedulerState(stubBot({}))
  assert.ok(Array.isArray(s.graves) && s.graves.length >= 1, 'the fixture grave is surfaced')
  const g = s.graves[0]
  assert.ok(Math.abs(g.dist - 2) < 0.5, 'dist = min(bot 12b, home 2b) = ~2, got ' + g.dist)
  assert.strictEqual(g.hasGear, true, 'iron notables -> hasGear:true')
  assert.ok(g.value > 0, 'grave has value')
  assert.ok(s.deathsRecent >= 1, 'a fresh death is counted in deathsRecent')
})

// (f) persistedBuild + maintainNeeded are booleans (real data, so pickJob is exercisable)
t('(f) persistedBuild + maintainNeeded are booleans', async () => {
  const s = await provision.schedulerState(stubBot({}))
  assert.strictEqual(typeof s.persistedBuild, 'boolean')
  assert.strictEqual(typeof s.maintainNeeded, 'boolean')
  assert.strictEqual(s.persistedBuild, false, 'no resume-job fixture -> no persisted build')
})

// (g) the partial-snapshot guarantee: a barely-populated stub still RESOLVES (no throw)
t('(g) a barely-populated stub resolves without throwing (partial snapshot)', async () => {
  const bare = { version: VERSION, entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null }
  const s = await provision.schedulerState(bare)
  assert.ok(s && typeof s === 'object', 'a partial snapshot object is returned')
  assert.strictEqual(typeof s.packFoodPts, 'number', 'packFoodPts defaulted to a number even with no inventory')
})

// (h) S6: the tools booleans are present + correctly shaped (pick/sparePick/axe/sword)
t('(h) s.tools booleans present + shaped; axe/sword name-scan excludes pickaxe', async () => {
  // a working stone pick + a stone axe, no sword, no spare pick.
  const s = await provision.schedulerState(stubBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_axe', count: 1 }] }))
  assert.ok(s.tools && typeof s.tools === 'object', 's.tools object present')
  for (const k of ['pick', 'sparePick', 'axe', 'sword']) assert.strictEqual(typeof s.tools[k], 'boolean', k + ' is boolean')
  assert.strictEqual(s.tools.pick, true, 'one working pick -> pick true')
  assert.strictEqual(s.tools.sparePick, false, 'only one pick -> no spare')
  assert.strictEqual(s.tools.axe, true, 'stone_axe -> axe true')
  assert.strictEqual(s.tools.sword, false, 'no sword (and pickaxe must NOT read as an axe)')
})

// (h2) FIX #20: wooden sword/axe + a working pick -> read as a NEED (up-tier to stone once cobble is mineable)
t('(h2) FIX #20: wooden axe/sword + a pick -> axe/sword NEED (tier upgrade)', async () => {
  const s = await provision.schedulerState(stubBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'wooden_axe', count: 1 }, { name: 'wooden_sword', count: 1 }] }))
  assert.strictEqual(s.tools.axe, false, 'wooden axe + a pick to mine cobble -> axe NEED (upgrade to stone)')
  assert.strictEqual(s.tools.sword, false, 'wooden sword + a pick -> sword NEED (upgrade to stone)')
})

// (h3) FIX #20: stone sword/axe are adequate (no spurious upgrade need)
t('(h3) FIX #20: stone axe/sword are adequate', async () => {
  const s = await provision.schedulerState(stubBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'stone_axe', count: 1 }, { name: 'stone_sword', count: 1 }] }))
  assert.strictEqual(s.tools.axe, true, 'stone axe adequate -> no need')
  assert.strictEqual(s.tools.sword, true, 'stone sword adequate -> no need')
})

// (h4) FIX #20: no working pick -> wooden stays adequate (never demand an upgrade it can't afford)
t('(h4) FIX #20: no pick -> wooden tools stay adequate (unaffordable upgrade not demanded)', async () => {
  const s = await provision.schedulerState(stubBot({ items: [{ name: 'wooden_axe', count: 1 }, { name: 'wooden_sword', count: 1 }] }))
  assert.strictEqual(s.tools.axe, true, 'no pick -> cannot mine cobble -> wooden axe stays adequate')
  assert.strictEqual(s.tools.sword, true, 'no pick -> wooden sword stays adequate')
})

// (h5) FIX #20 rollback: TOOL_TIER_UPGRADE=0 restores existence-only (any axe/sword satisfies)
t('(h5) FIX #20 rollback: TOOL_TIER_UPGRADE=0 -> existence-only', async () => {
  process.env.TOOL_TIER_UPGRADE = '0'
  try {
    const s = await provision.schedulerState(stubBot({ items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'wooden_axe', count: 1 }, { name: 'wooden_sword', count: 1 }] }))
    assert.strictEqual(s.tools.axe, true, 'rollback: any axe satisfies')
    assert.strictEqual(s.tools.sword, true, 'rollback: any sword satisfies')
  } finally { delete process.env.TOOL_TIER_UPGRADE }
})

// (i) S6: activeJob synthesizes maintenancePass/maintain when the latch is set
t('(i) activeJob = maintenancePass/maintain when the maintain latch is set', async () => {
  try {
    provision._setMaintaining(true)
    const s = await provision.schedulerState(stubBot({}))
    assert.ok(s.activeJob && s.activeJob.name === 'maintenancePass', 'activeJob is the maintenance pass')
    assert.strictEqual(s.activeJob.cls, 'maintain', 'classified rank-1 maintain')
  } finally { provision._setMaintaining(false) }
  const s2 = await provision.schedulerState(stubBot({}))
  assert.ok(!s2.activeJob || s2.activeJob.name !== 'maintenancePass', 'latch cleared -> no synthetic maintain job')
})

// (j) S7: activeJob.lastProgressAt/blockedOn are now REAL (no more "null until S7") - the synthesis
// carries the verified-progress clock; markStalled surfaces blockedOn:'stalled'; a touch clears it.
t('(j) S7: activeJob carries the progress clock; markStalled -> blockedOn:stalled; touch clears', async () => {
  const commands = require('./commands.js')
  try {
    provision._setMaintaining(true)
    // a seeded touch is the job's progress clock -> lastProgressAt reflects it (not null)
    commands.touchProgress('seed')
    const at0 = commands.progressInfo().at
    let s = await provision.schedulerState(stubBot({}))
    assert.strictEqual(typeof s.activeJob.lastProgressAt, 'number', 'lastProgressAt is a real number (not null)')
    assert.ok(s.activeJob.lastProgressAt >= at0, 'lastProgressAt >= the seeded touch time')
    assert.strictEqual(s.activeJob.blockedOn, null, 'no stall -> blockedOn null')
    // markStalled surfaces the nudge marker
    commands.markStalled()
    s = await provision.schedulerState(stubBot({}))
    assert.strictEqual(s.activeJob.blockedOn, 'stalled', 'markStalled -> blockedOn:stalled')
    // any touch clears it
    commands.touchProgress('clear')
    s = await provision.schedulerState(stubBot({}))
    assert.strictEqual(s.activeJob.blockedOn, null, 'a touch clears the stalled marker')
  } finally { provision._setMaintaining(false); commands._resetProgress() }
})

// (k) S7: activeJobInfo is exported, sync, and returns null when no job/latch is active
t('(k) S7: activeJobInfo() sync + null when idle', () => {
  assert.strictEqual(typeof provision.activeJobInfo, 'function', 'activeJobInfo exported')
  assert.strictEqual(typeof provision.stopSurvivalJob, 'function', 'stopSurvivalJob exported')
  assert.strictEqual(provision.activeJobInfo(), null, 'no activity + no latch -> null (sync)')
})

;(async () => {
  let failures = 0
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)) }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  console.log(failures ? ('\n' + failures + ' FAILED') : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
