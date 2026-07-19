'use strict'
// OFFLINE unit test for #107 SPAWN_BED - the spawn-anchor ladder (provision-recovery.ensureSpawnBed)
// and the bed primitives it stands on (provision-hut: bedCandidates / acquireBed / placeBedNear).
// Run:  cd bot && node spawnbedtest.js
//
// THE BUG THIS PINS. On 2026-07-19 the bot died 23 times, every death respawning it 235-350
// blocks from home, because it had no bed. It could have had one: it was carrying 6 white_wool
// and a stack of oak LOGS. The camp step's gate was
//     woolName && (inv.oak_planks||0) + (inv.birch_planks||0) + (inv.spruce_planks||0) >= 3
// - it counted PLANKS in the pack, found zero, and skipped, then logged "no bed and no wool for
// one" while holding the wool. So the load-bearing assertion here is: LOGS AND NO PLANKS STILL
// YIELDS A BED. The second is that a bed already standing and asserted is never re-placed.
//
// AMBIENT-PROOF: every env var these modules read is set explicitly below. Three regressions in
// one day came from the shell's environment leaking into a test run - nothing here inherits.

const assert = require('assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

// ---- env isolation, BEFORE anything loads (these modules read their files at require time) ---
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnbed-'))
process.env.WORLD_MEM_FILE = path.join(TMP, 'world-memory.json')
process.env.DEATH_FILE = path.join(TMP, 'last-death.json')
process.env.RESUME_FILE = path.join(TMP, 'resume-job.json')
process.env.CHEST_CACHE_FILE = path.join(TMP, 'chest-cache.json')
process.env.SCAFFOLD_FILE = path.join(TMP, 'scaffold-registry.json')
process.env.STATE_HISTORY_FILE = path.join(TMP, 'state-history.jsonl')
delete process.env.BUILD_DEBUG // no ambient debug spew
delete process.env.SITE_CAMP
delete process.env.SITE_HUT
delete process.env.NONDESTRUCTIVE_REPAIR
delete process.env.GROUNDED_OBS

// ---- stub resources.js in the module cache BEFORE anyone requires it ------------------------
// acquireBed's whole contract is "ask the resource model, never count the pack yourself", so the
// resource model is exactly what this test replaces: we assert on WHAT IT WAS ASKED FOR.
const resPath = require.resolve('./resources.js')
const fakeRes = {
  _asked: [],           // every acquire(name) this run
  _totals: {},          // what totalCounts reports (pack + own chests)
  _grant: null,         // item name acquire is allowed to actually produce, or null
  _bot: null,
  async totalCounts () { return { ...fakeRes._totals } },
  async acquire (bot, name, count, opts) {
    fakeRes._asked.push(name)
    if (fakeRes._grant && name === fakeRes._grant) {
      bot.inventory._items.push({ name, count: 1 })
      return true
    }
    return false
  },
  async withdrawItems () { return 0 },
  async reconcile () { return { withdraws: [], plan: { tasks: [], gathers: {}, unobtainable: {} } } },
  async runReconciled () { return true },
  async ensureFood () { return false },
  async autoBank () { return 0 }
}
require.cache[resPath] = { id: resPath, filename: resPath, path: path.dirname(resPath), loaded: true, children: [], paths: [], exports: fakeRes }

const { Vec3 } = require('vec3')
const provision = require('./provision.js')
const provHut = require('./provision-hut.js')
const provRec = require('./provision-recovery.js')
const worldMemory = require('./world-memory.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) }
  catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + ((e && e.stack) || e)) }
}
// Async cases run STRICTLY IN ORDER: they share one resource-model stub, and running them
// concurrently let each case's holdings stomp the next one's (that cost a green-looking red run).
const queued = []
function ta (name, fn) { queued.push([name, fn]) }
async function runQueued () {
  for (const [name, fn] of queued) {
    try { await fn(); console.log('PASS  ' + name) }
    catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + ((e && e.stack) || e)) }
  }
}

// ---- a minimal fake world: solid ground at y<=63, air above -------------------------------
function fakeBot (opts = {}) {
  const overrides = new Map() // "x,y,z" -> block name
  const placed = []
  const propMap = new Map()
  const bot = {
    version: '1.21.1',
    time: { timeOfDay: opts.timeOfDay != null ? opts.timeOfDay : 1000 }, // day by default
    health: 20,
    food: 20,
    entity: { position: new Vec3(opts.x != null ? opts.x : 100.5, 64, opts.z != null ? opts.z : 100.5) },
    inventory: { _items: (opts.items || []).slice(), items () { return this._items } },
    _placed: placed,
    _override (v, name, props) { overrides.set(`${v.x},${v.y},${v.z}`, name); if (props) propMap.set(`${v.x},${v.y},${v.z}`, props) },
    blockAt (v) {
      if (!v) return null
      const key = `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`
      const name = overrides.has(key) ? overrides.get(key) : (Math.floor(v.y) <= 63 ? 'grass_block' : 'air')
      if (name === null) return null
      const solid = !/^(air|cave_air|void_air)$/.test(name)
      const props = propMap.get(key) || {}
      return { name, position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)), boundingBox: solid ? 'block' : 'empty', getProperties: () => props }
    },
    findBlock () { return null },
    async equip () {},
    async lookAt () {},
    async activateBlock (b) { bot._activated = b },
    async placeBlock (ref, face) {
      const at = ref.position.offset(face.x, face.y, face.z)
      placed.push(at)
      const held = bot.inventory._items.find(i => /_bed$/.test(i.name))
      if (!held) throw new Error('nothing bed-shaped in hand')
      // The SERVER picks the orientation from the placer's yaw - it is NOT ours to assume.
      // opts.serverFacing lets a test reproduce the live wall-perch: we validate a +z head
      // and the server lays the bed east instead.
      const facing = opts.serverFacing || 'south'
      const D = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }[facing]
      bot._override(at, held.name, { part: 'foot', facing })
      bot._override(at.offset(D[0], D[1], D[2]), held.name, { part: 'head', facing })
      bot.inventory._items = bot.inventory._items.filter(i => i !== held)
    },
    async dig (b) {
      const fp = provHut.bedFootprint(bot, b.position)
      for (const c of (fp ? [fp.foot, fp.head] : [b.position])) {
        overrides.set(`${c.x},${c.y},${c.z}`, 'air'); propMap.delete(`${c.x},${c.y},${c.z}`)
      }
      if (fp) bot.inventory._items.push({ name: b.name, count: 1 }) // breaking a bed drops it
      bot._dug = (bot._dug || 0) + 1
    }
  }
  return bot
}

function resetWorldMem () {
  try { fs.rmSync(process.env.WORLD_MEM_FILE, { force: true }) } catch {}
  const m = worldMemory.loadWorldMem()
  for (const k of Object.keys(m)) delete m[k]
  worldMemory.saveWorldMem()
}

// ============================================================================================
// 1. bedCandidates - the PURE decision that replaced the planks-in-pack gate
// ============================================================================================

t('bedCandidates: THE LIVE BUG - 6 wool and LOGS but ZERO planks still asks for a bed', () => {
  // This is the exact holdings tape from the 23-death day. The old gate required >=3 planks in
  // the pack and bailed; the resource model is the one allowed to know logs become planks.
  const totals = { white_wool: 6, oak_log: 22 }
  const c = provHut.bedCandidates(totals)
  assert.ok(c.includes('white_bed'), 'white_bed must be asked for: ' + JSON.stringify(c))
  assert.strictEqual(c[0], 'white_bed', 'the wool we hold picks the colour, planks are not consulted')
})

t('bedCandidates: a BANKED bed of any colour outranks crafting a new one', () => {
  const c = provHut.bedCandidates({ red_bed: 1, white_wool: 9 })
  assert.strictEqual(c[0], 'red_bed', 'withdraw beats craft: ' + JSON.stringify(c))
  assert.ok(c.includes('white_bed'), 'white_bed stays as the fallback')
})

t('bedCandidates: wool below a bed\'s worth is not proposed, white_bed still is', () => {
  const c = provHut.bedCandidates({ blue_wool: 2 })
  assert.ok(!c.includes('blue_bed'), '2 wool cannot make a bed')
  assert.deepStrictEqual(c, ['white_bed'], 'only the universal fallback remains')
})

t('bedCandidates: empty holdings still yields the white_bed fallback (never an empty plan)', () => {
  assert.deepStrictEqual(provHut.bedCandidates({}), ['white_bed'])
  assert.deepStrictEqual(provHut.bedCandidates(null), ['white_bed'])
})

t('bedCandidates: no duplicates when the banked bed and the wool agree on colour', () => {
  const c = provHut.bedCandidates({ white_bed: 1, white_wool: 6 })
  assert.strictEqual(new Set(c).size, c.length, 'duplicate asks waste a bank trip: ' + JSON.stringify(c))
})

// ============================================================================================
// 2. acquireBed - goes through the resource model, never through inventoryCounts
// ============================================================================================

ta('acquireBed: logs-and-no-planks pack ends up HOLDING a bed (the fix, end to end)', async () => {
  resetWorldMem()
  fakeRes._asked = []
  fakeRes._totals = { white_wool: 6, oak_log: 22 } // no planks anywhere - the live tape
  fakeRes._grant = 'white_bed'
  const bot = fakeBot({ items: [{ name: 'white_wool', count: 6 }, { name: 'oak_log', count: 22 }] })
  const item = await provHut.acquireBed(bot, { near: { x: 100, y: 64, z: 100 } })
  assert.ok(item, 'acquireBed returned nothing while the holdings could make a bed')
  assert.strictEqual(item.name, 'white_bed')
  assert.deepStrictEqual(fakeRes._asked, ['white_bed'], 'it must ASK the resource model: ' + JSON.stringify(fakeRes._asked))
})

ta('acquireBed: a bed already in the pack is returned without asking for another', async () => {
  fakeRes._asked = []
  fakeRes._totals = { white_wool: 9 }
  fakeRes._grant = 'white_bed'
  const bot = fakeBot({ items: [{ name: 'red_bed', count: 1 }] })
  const item = await provHut.acquireBed(bot, { near: { x: 100, y: 64, z: 100 } })
  assert.strictEqual(item.name, 'red_bed')
  assert.deepStrictEqual(fakeRes._asked, [], 'no acquire call was needed')
})

ta('acquireBed: genuinely nothing to make a bed from -> null (honest, not a lie)', async () => {
  fakeRes._asked = []
  fakeRes._totals = { cobblestone: 64 }
  fakeRes._grant = null // the resource model cannot produce one
  const bot = fakeBot({ items: [{ name: 'cobblestone', count: 64 }] })
  const item = await provHut.acquireBed(bot, { near: { x: 100, y: 64, z: 100 } })
  assert.strictEqual(item, null)
  assert.deepStrictEqual(fakeRes._asked, ['white_bed'], 'it still TRIED before giving up')
})

// ============================================================================================
// 3. placeBedNear - open-ground fallback, verified by a world re-read
// ============================================================================================

ta('placeBedNear: lays a carried bed on flat ground and RE-READS it to prove it', async () => {
  const bot = fakeBot({ items: [{ name: 'white_bed', count: 1 }] })
  const b = await provHut.placeBedNear(bot, { x: 100, y: 64, z: 100 }, {})
  assert.ok(b, 'nothing was placed on perfectly flat ground')
  assert.ok(/_bed$/.test(b.name), 'returned block is not a bed: ' + b.name)
  assert.strictEqual(bot._placed.length, 1, 'exactly one placement attempt should have been needed')
})

ta('placeBedNear: no bed in the pack -> null, and it never touches the world', async () => {
  const bot = fakeBot({ items: [] })
  const b = await provHut.placeBedNear(bot, { x: 100, y: 64, z: 100 }, {})
  assert.strictEqual(b, null)
  assert.strictEqual(bot._placed.length, 0)
})

ta('placeBedNear: nowhere flat enough -> null rather than a bogus success', async () => {
  const bot = fakeBot({ items: [{ name: 'white_bed', count: 1 }] })
  // bury the whole ring: every candidate cell is solid, so no foot/head pair is air
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) bot._override(new Vec3(100 + dx, 64, 100 + dz), 'stone')
  const b = await provHut.placeBedNear(bot, { x: 100, y: 64, z: 100 }, {})
  assert.strictEqual(b, null)
  assert.strictEqual(bot._placed.length, 0, 'it must not place into an occupied cell')
})

// ============================================================================================
// 4. ensureSpawnBed - the ladder, and the verdicts it reports
// ============================================================================================

ta('ensureSpawnBed: a standing, asserted bed is NOT re-placed (how=stood)', async () => {
  resetWorldMem()
  fakeRes._asked = []
  fakeRes._grant = 'white_bed'
  const bot = fakeBot({ items: [{ name: 'white_bed', count: 1 }] }) // carrying a spare on purpose
  bot._override(new Vec3(102, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(102, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  worldMemory.rememberBed({ x: 102, y: 64, z: 100 }) // also stamps bedAssertAt
  const r = await provRec.ensureSpawnBed(bot, {})
  assert.strictEqual(r.ok, true, 'why: ' + r.why)
  assert.strictEqual(r.how, 'stood')
  assert.strictEqual(bot._placed.length, 0, 'it placed a second bed beside a perfectly good one')
  assert.deepStrictEqual(fakeRes._asked, [], 'it went shopping for a bed it already has')
})

ta('ensureSpawnBed: the anchored bed is GONE -> it does not report stood', async () => {
  resetWorldMem()
  fakeRes._asked = []
  fakeRes._grant = null
  fakeRes._totals = {}
  const bot = fakeBot({ items: [] })
  worldMemory.rememberBed({ x: 102, y: 64, z: 100 }) // memory says bed; the world says grass
  const r = await provRec.ensureSpawnBed(bot, {})
  assert.notStrictEqual(r.how, 'stood', 'a broken bed must never read as an anchored one')
  assert.strictEqual(r.ok, false, 'nothing to make a bed from, so this run honestly fails')
  assert.ok(/craftable|acquired|nowhere/.test(r.why), 'the reason must name the real problem, got: ' + r.why)
})

ta('ensureSpawnBed: THE LIVE FAILURE - no bed, no hut, logs+wool -> how=acquired', async () => {
  resetWorldMem()
  fakeRes._asked = []
  fakeRes._totals = { white_wool: 6, oak_log: 22 } // zero planks, exactly as it was live
  fakeRes._grant = 'white_bed'
  const bot = fakeBot({ items: [{ name: 'white_wool', count: 6 }, { name: 'oak_log', count: 22 }] })
  const r = await provRec.ensureSpawnBed(bot, { near: { x: 100, y: 64, z: 100 } })
  assert.strictEqual(r.ok, true, 'the bot must end this call with a bed. why: ' + r.why)
  assert.strictEqual(r.how, 'acquired')
  assert.strictEqual(bot._placed.length, 1, 'the acquired bed was never laid down')
  assert.ok(bot._activated, 'the bed was laid but spawn was never asserted on it')
  const kb = worldMemory.knownBed()
  assert.ok(kb, 'the new bed was not remembered, so the next pass would hunt for it again')
})

ta('ensureSpawnBed: truly bedless and broke -> ok:false with an honest why', async () => {
  resetWorldMem()
  fakeRes._asked = []
  fakeRes._totals = { cobblestone: 64 }
  fakeRes._grant = null
  const bot = fakeBot({ items: [{ name: 'cobblestone', count: 64 }] })
  const r = await provRec.ensureSpawnBed(bot, { near: { x: 100, y: 64, z: 100 } })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.how, 'failed')
  assert.ok(r.why && r.why.length > 8, 'a failure must say why, got: ' + JSON.stringify(r.why))
  // and it must NOT claim there is no wool - that sentence is what made the live log a lie
  assert.ok(!/no wool/.test(r.why), 'do not reintroduce the "no wool" claim: ' + r.why)
})

ta('ensureSpawnBed: force re-asserts even on a standing, remembered bed', async () => {
  resetWorldMem()
  const bot = fakeBot({ items: [] })
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  worldMemory.rememberBed({ x: 101, y: 64, z: 100 })
  bot._activated = null
  const r = await provRec.ensureSpawnBed(bot, { force: true })
  assert.strictEqual(r.ok, true, 'why: ' + r.why)
  assert.ok(bot._activated, 'force must actually re-activate the bed (spawn-suspect repair depends on it)')
})

ta('ensureSpawnBed: returns a verdict OBJECT, never a bare boolean', async () => {
  resetWorldMem()
  const bot = fakeBot({ items: [] })
  const r = await provRec.ensureSpawnBed(bot, {})
  assert.strictEqual(typeof r, 'object')
  for (const k of ['ok', 'how', 'why']) assert.ok(k in r, 'verdict is missing ' + k)
  assert.ok(['stood', 'placed', 'acquired', 'failed'].includes(r.how), 'unknown how: ' + r.how)
})

// ============================================================================================
// 5. the DELETED camp gate must not come back
// ============================================================================================

t('regression: commands.js no longer counts planks to decide it cannot have a bed', () => {
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  assert.ok(!/bed hunt is v2/.test(src), 'the "bed hunt is v2" message is back')
  assert.ok(!/no bed and no wool/.test(src), 'the false "no bed and no wool" log is back')
  assert.ok(!/oak_planks \|\| 0\) \+ \(inv\.birch_planks/.test(src), 'the planks-in-pack bed gate is back')
  assert.ok(/ensureSpawnBed/.test(src), 'the camp step must call ensureSpawnBed')
})

t('regression: the spawn ladder holds no blanket time window', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
  const fn = src.slice(src.indexOf('async function ensureSpawnBed'), src.indexOf('async function recoverSpawnAnchor'))
  assert.ok(!/3600 \* 1000/.test(fn), 'the hourly assert window is back - condition gates only')
  assert.ok(!/Date\.now\(\) - m\.bedAssertAt/.test(fn), 'a time-since-assert comparison is back')
})


// ---- #107b THE WALL-PERCH REGRESSION -------------------------------------------------
// Live 2026-07-19 16:32: placeBedNear validated foot + head-at-+z, then bot.placeBlock let
// the SERVER orient the bed EAST. The real head landed one cell east - never validated, and
// with nothing beneath it. The old post-place check looked for "a bed at either ASSUMED cell",
// found the foot, and reported success. Result: a bed perched on the hut wall crest with its
// head over open air. Verify CONFORMANCE (the footprint the world actually produced), never
// a prediction of it.

t('bedWellPlaced: a bed whose real head hangs over air is REJECTED', () => {
  const bot = fakeBot({})
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'east' })
  bot._override(new Vec3(102, 64, 100), 'white_bed', { part: 'head', facing: 'east' })
  bot._override(new Vec3(102, 63, 100), 'air') // nothing under the head
  const v = provHut.bedWellPlaced(bot, new Vec3(101, 64, 100))
  assert.strictEqual(v.ok, false, 'an unsupported head must not pass')
  assert.ok(/no support/.test(v.why), 'why should name the missing support: ' + v.why)
})

t('bedWellPlaced: a bed on a one-wide wall crest is REJECTED', () => {
  const bot = fakeBot({})
  // a bed sitting on top of a N-S wall: support exists under both cells, but the ground
  // either side of that support is air - a crest, not ground.
  bot._override(new Vec3(101, 65, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 65, 101), 'white_bed', { part: 'head', facing: 'south' })
  for (const z of [99, 100, 101, 102]) bot._override(new Vec3(101, 64, z), 'oak_planks')
  for (const z of [99, 100, 101, 102]) { bot._override(new Vec3(100, 64, z), 'air'); bot._override(new Vec3(102, 64, z), 'air') }
  const v = provHut.bedWellPlaced(bot, new Vec3(101, 65, 100))
  assert.strictEqual(v.ok, false, 'a wall crest must not pass as ground')
  assert.ok(/crest|ledge/.test(v.why), 'why should name the crest: ' + v.why)
})

t('bedWellPlaced: a bed flat on real ground PASSES', () => {
  const bot = fakeBot({})
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  const v = provHut.bedWellPlaced(bot, new Vec3(101, 64, 100))
  assert.strictEqual(v.ok, true, 'flat ground must pass: ' + v.why)
})

t('bedFootprint: reads the REAL two cells from facing/part, not an assumption', () => {
  const bot = fakeBot({})
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'east' })
  bot._override(new Vec3(102, 64, 100), 'white_bed', { part: 'head', facing: 'east' })
  const fpF = provHut.bedFootprint(bot, new Vec3(101, 64, 100))
  const fpH = provHut.bedFootprint(bot, new Vec3(102, 64, 100)) // from the HEAD too
  assert.strictEqual(fpF.head.x, 102, 'head must be east of the foot, not +z')
  assert.strictEqual(fpH.foot.x, 101, 'resolving from the head must find the same foot')
})

t('placeBedNear: server lays it EAST over a cliff -> bed is broken, then re-laid safely', async () => {
  const bot = fakeBot({ items: [{ name: 'white_bed', count: 1 }], serverFacing: 'east' })
  // a clean cliff: solid ground west of x=99, open air from x=99 east. A foot at x=98 looks
  // perfectly good (3/4 neighbours solid) but an EAST-facing head lands at x=99, over nothing.
  for (let x = 99; x <= 112; x++) for (let z = 90; z <= 112; z++) bot._override(new Vec3(x, 63, z), 'air')
  const r = await provHut.placeBedNear(bot, { x: 99, y: 64, z: 100 }, {})
  assert.ok((bot._dug || 0) > 0, 'it must have reclaimed the badly-oriented bed it laid over the cliff')
  if (r) {
    const v = provHut.bedWellPlaced(bot, r.position)
    assert.strictEqual(v.ok, true, 'any bed it RETURNS must be well placed: ' + v.why)
  }
})

runQueued().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})
