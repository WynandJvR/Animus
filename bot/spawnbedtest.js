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
    const grants = fakeRes._grant == null ? [] : (Array.isArray(fakeRes._grant) ? fakeRes._grant : [fakeRes._grant])
    if (grants.includes(name)) {
      bot.inventory._items.push({ name, count: Math.max(1, count || 1) })
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
    // #110: a real event channel, so assertSpawnOn's server-evidence gate is exercised for
    // real. opts.noSetSpawn reproduces the server REFUSING to move the spawn (night + mobs).
    _listeners: {},
    on (ev, fn) { (bot._listeners[ev] = bot._listeners[ev] || []).push(fn) },
    removeListener (ev, fn) { bot._listeners[ev] = (bot._listeners[ev] || []).filter(f => f !== fn) },
    emit (ev, msg) { for (const f of (bot._listeners[ev] || []).slice()) f(msg) },
    _ops: [], // the ORDER of world-touching operations - the swap invariant is an order claim
    async equip (item) { bot._equipped = item },
    async lookAt () {},
    async activateBlock (b) {
      bot._activated = b
      bot._ops.push({ op: 'activate', pos: b.position })
      if (!opts.noSetSpawn) bot.emit('message', { translate: 'block.minecraft.set_spawn' })
    },
    async placeBlock (ref, face) {
      const at = ref.position.offset(face.x, face.y, face.z)
      placed.push(at)
      bot._ops.push({ op: 'place', pos: at })
      const held = bot._equipped && bot.inventory._items.includes(bot._equipped) ? bot._equipped : bot.inventory._items.find(i => /_bed$/.test(i.name))
      if (!held) throw new Error('nothing placeable in hand')
      if (!/_bed$/.test(held.name)) { // a pad block: plain solid, one item consumed
        bot._override(at, held.name)
        held.count -= 1
        if (held.count <= 0) bot.inventory._items = bot.inventory._items.filter(i => i !== held)
        return
      }
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
      if (opts.onDig) opts.onDig(b)
      const fp = provHut.bedFootprint(bot, b.position)
      bot._ops.push({ op: 'dig', pos: b.position, name: b.name })
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

ta('placeBedNear: nowhere layable at all -> null rather than a bogus success', async () => {
  const bot = fakeBot({ items: [{ name: 'white_bed', count: 1 }] })
  // Bury the whole SEARCH VOLUME solid: #110 seeks the ground over near.y-4..near.y+2 and
  // across r<=8, so a single buried Y is no longer "nowhere" - a stone slab is a fine bed
  // site and the bot should use it. Genuinely nowhere = no air pair anywhere in the band.
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) for (let y = 58; y <= 70; y++) bot._override(new Vec3(100 + dx, y, 100 + dz), 'stone')
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
// found the foot, and reported success. Verify CONFORMANCE (the footprint the world actually
// produced), never a prediction of it.

t('bedFootprint: reads the REAL two cells from facing/part, not an assumption', () => {
  const bot = fakeBot({})
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'east' })
  bot._override(new Vec3(102, 64, 100), 'white_bed', { part: 'head', facing: 'east' })
  const fpF = provHut.bedFootprint(bot, new Vec3(101, 64, 100))
  const fpH = provHut.bedFootprint(bot, new Vec3(102, 64, 100)) // from the HEAD too
  assert.strictEqual(fpF.head.x, 102, 'head must be east of the foot, not +z')
  assert.strictEqual(fpH.foot.x, 101, 'resolving from the head must find the same foot')
})

ta('placeBedNear: server lays it EAST over a cliff -> bed is broken, never returned bad', async () => {
  const bot = fakeBot({ items: [{ name: 'white_bed', count: 1 }], serverFacing: 'east' })
  // A REAL cliff: everything from x=99 east is open air down through the search band, so an
  // EAST-facing head landing at x=99 has nothing under it however deep we look.
  for (let x = 99; x <= 115; x++) for (let z = 88; z <= 115; z++) for (let y = 52; y <= 63; y++) bot._override(new Vec3(x, y, z), 'air')
  const r = await provHut.placeBedNear(bot, { x: 99, y: 64, z: 100 }, {})
  assert.ok((bot._dug || 0) > 0, 'it must have reclaimed the badly-oriented bed it laid over the cliff')
  if (r) {
    const v = provHut.bedUsable(bot, r.position)
    assert.strictEqual(v.ok, true, 'any bed it RETURNS must be usable: ' + v.why)
  }
})

// ============================================================================================
// #110 THE ANCHOR-REPLACEMENT INVARIANT
//
// Live 2026-07-19 21:09 -> 2026-07-20 01:17. Two failures, one shape.
//   (1) ensureSpawnBed's STOOD rung consulted a QUALITY verdict on the standing anchor and, on
//       a bad one, dug the bed and forgot it BEFORE any replacement existed - fired from a 45s
//       background timer that discards failure verdicts. The bot spent the night respawning
//       235-350b from home. Destroy-then-create, on the one piece of infrastructure that
//       cannot be re-obtained from the place you land when you lose it.
//   (2) The predicate guarding placement (">=3 of the support's 4 neighbours solid") tested a
//       COSMETIC PROXY - "does the ground look continuous" - and rejected legitimate rough
//       ground everywhere near home. A bot holding a bed and 16 planks logged "found nowhere
//       near home to lay it", twice in the same second.
// The fixes: quality leaves the spawn-critical path (a standing anchor is 'stood', full stop),
// the proxy is DELETED and re-derived from the requirement, placement can PREPARE a site, and
// the only legal swap is achievability -> acquire -> create -> verify -> assert -> destroy LAST.
// ============================================================================================

// --- T3: bedUsable, derived from the requirement (P1 conformance, P2 support, P3 a place to
//     stand, P4 nothing lethal). Each case names the clause it is pinning.

t('T3a bedUsable: a bed whose REAL head hangs over air is rejected by P2 (support)', () => {
  const bot = fakeBot({})
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'east' })
  bot._override(new Vec3(102, 64, 100), 'white_bed', { part: 'head', facing: 'east' })
  bot._override(new Vec3(102, 63, 100), 'air') // nothing under the head
  const v = provHut.bedUsable(bot, new Vec3(101, 64, 100))
  assert.strictEqual(v.ok, false, 'an unsupported head must not pass')
  assert.ok(/no support/.test(v.why), 'why should name the missing support: ' + v.why)
})

t('T3b bedUsable: a one-wide wall crest with BOTH cells supported is rejected by P3 (no stand)', () => {
  const bot = fakeBot({})
  // The live shape: a bed on top of a tall one-wide wall. P2 is satisfied - there IS support
  // under both cells - so only the usability clause can catch this. The old 3/4-neighbour
  // proxy caught it by accident; P3 catches it for the real reason (you cannot get to it).
  for (let x = 98; x <= 104; x++) for (let z = 96; z <= 105; z++) for (let y = 55; y <= 67; y++) bot._override(new Vec3(x, y, z), 'air')
  bot._override(new Vec3(101, 64, 100), 'oak_planks') // the crest is exactly the bed's two cells
  bot._override(new Vec3(101, 64, 101), 'oak_planks')
  bot._override(new Vec3(101, 65, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 65, 101), 'white_bed', { part: 'head', facing: 'south' })
  const v = provHut.bedUsable(bot, new Vec3(101, 65, 100))
  assert.strictEqual(v.ok, false, 'a bed the bot cannot stand beside must not pass')
  assert.ok(/standable|ledge|crest/.test(v.why), 'why should name the missing footing: ' + v.why)
})

t('T3c bedUsable: THE TUNING PIN - rough, pit-pocked ground with ONE standable side PASSES', () => {
  const bot = fakeBot({})
  // This is the fixture the DELETED >=3/4-neighbour rule wrongly rejected, and it is exactly
  // the terrain the bot creates around its own hut. Both cells are supported and there is
  // somewhere to stand: the bed is usable, and no amount of pitting around it changes that.
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  for (const [x, z] of [[100, 100], [102, 100], [101, 99], [100, 101], [102, 101], [101, 102]]) bot._override(new Vec3(x, 63, z), 'air') // pits all round the supports
  const v = provHut.bedUsable(bot, new Vec3(101, 64, 100))
  assert.strictEqual(v.ok, true, 'rough-but-usable ground must pass: ' + v.why)
})

t('T3d bedUsable: lava beside the footprint is rejected by P4', () => {
  const bot = fakeBot({})
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  bot._override(new Vec3(100, 64, 100), 'lava')
  const v = provHut.bedUsable(bot, new Vec3(101, 64, 100))
  assert.strictEqual(v.ok, false, 'a bed next to lava must not pass')
  assert.ok(/lava/.test(v.why), 'why should name the hazard: ' + v.why)
})

t('T3e bedUsable: an unknown chunk is "cannot judge", never a silent pass or fail', () => {
  const bot = fakeBot({})
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  bot._override(new Vec3(101, 63, 101), null) // chunk not loaded under the head
  const v = provHut.bedUsable(bot, new Vec3(101, 64, 100))
  assert.strictEqual(v.ok, false, 'an unreadable cell must never pass')
  assert.ok(/unknown/.test(v.why), 'why must say it could not judge, not that it is bad: ' + v.why)
})

t('T3f bedUsable: THE LIVE BED - real footprint, real pad, real neighbours -> PASSES', () => {
  // The operator hand-built this on 2026-07-20 to break the death loop: foot (458,69,-138) +
  // head (459,69,-138) facing=east on an oak_planks pad at y=68 spanning (457,-140)-(461,-136),
  // with the terrain around it genuinely chewed (458,67/68/69,-138 all read AIR before the pad).
  // Spawn is asserted on it. If bedUsable rejected this bed, the predicate would be wrong.
  const bot = fakeBot({ x: 458.5, z: -138.5 })
  for (let x = 449; x <= 469; x++) for (let z = -148; z <= -128; z++) for (let y = 60; y <= 75; y++) bot._override(new Vec3(x, y, z), 'air') // chewed ground: nothing but the pad
  for (let x = 457; x <= 461; x++) for (let z = -140; z <= -136; z++) bot._override(new Vec3(x, 68, z), 'oak_planks')
  bot._override(new Vec3(458, 69, -138), 'white_bed', { part: 'foot', facing: 'east' })
  bot._override(new Vec3(459, 69, -138), 'white_bed', { part: 'head', facing: 'east' })
  const v = provHut.bedUsable(bot, new Vec3(458, 69, -138))
  assert.strictEqual(v.ok, true, 'the live anchor must be judged usable: ' + v.why)
})

// --- T1: the destroy regression. A standing anchor is NEVER dug by the spawn-critical path.

ta('T1 ensureSpawnBed: an UGLY but standing anchor is kept, not reclaimed (zero digs)', async () => {
  resetWorldMem()
  fakeRes._asked = []; fakeRes._grant = null; fakeRes._totals = {}
  const bot = uglyAnchorWorld()
  assert.strictEqual(provHut.bedUsable(bot, new Vec3(101, 64, 100)).ok, false, 'fixture is not actually ugly')
  const r = await provRec.ensureSpawnBed(bot, {})
  assert.strictEqual(r.how, 'stood', 'an anchored, standing bed is stood - ugly beats absent. why: ' + r.why)
  assert.strictEqual(r.ok, true)
  assert.ok(!(bot._dug > 0), 'the spawn path DUG the anchor - that is the #107b regression')
  const kb = worldMemory.knownBed()
  assert.ok(kb && kb.x === 101 && kb.z === 100, 'the anchor memory was wiped')
})

// --- T9: THE 462-BLOCK LIE. Proven live 2026-07-20: the bot day-clicked a bed, announced
//     "i set my spawn at this bed", and 17 minutes later died and respawned at world origin
//     462 blocks from home. A standing bed is not a granted spawn, and an unprovable click
//     must never clear the evidence that says the anchor is wrong.

ta('T9a rememberBed: an UNCONFIRMED record never clears the spawn-suspect proof', async () => {
  resetWorldMem()
  worldMemory.setSpawnSuspect(true) // a real respawn landed far from home - that is evidence
  worldMemory.rememberBed({ x: 101, y: 64, z: 100 }, { confirmed: false })
  assert.strictEqual(worldMemory.isSpawnSuspect(), true, 'a click we cannot prove worked cleared the far-respawn proof')
  assert.ok(worldMemory.knownBed(), 'the bed location is still worth remembering')
  worldMemory.rememberBed({ x: 101, y: 64, z: 100 }, { confirmed: true })
  assert.strictEqual(worldMemory.isSpawnSuspect(), false, 'server evidence must clear the suspect flag')
})

ta('T9b ensureSpawnBed: a standing but UNCONFIRMED bed is reported honestly, not as an anchor', async () => {
  resetWorldMem()
  fakeRes._asked = []; fakeRes._grant = null; fakeRes._totals = {}
  const bot = fakeBot({ x: 101.5, z: 100.5 }) // daytime: nothing to retry, so it must not thrash
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  worldMemory.rememberBed({ x: 101, y: 64, z: 100 }, { confirmed: false })
  const r = await provRec.ensureSpawnBed(bot, {})
  assert.strictEqual(r.how, 'stood', 'the bed stands, so the rung is stood. why: ' + r.why)
  assert.strictEqual(r.confirmed, false, 'the verdict must NOT claim a spawn the server never granted')
  assert.ok(/never confirmed|nightfall/.test(r.why), 'the verdict must say so out loud: ' + r.why)
  assert.ok(!(bot._dug > 0) && bot._placed.length === 0, 'nothing to retry in daylight - it must not thrash')
})

ta('T9c ensureSpawnBed: once it IS sleepable, an unconfirmed bed gets re-asserted', async () => {
  resetWorldMem()
  fakeRes._asked = []; fakeRes._grant = null; fakeRes._totals = {}
  const bot = fakeBot({ x: 101.5, z: 100.5, timeOfDay: 13000 }) // night: the condition is open
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  worldMemory.rememberBed({ x: 101, y: 64, z: 100 }, { confirmed: false })
  bot._activated = null
  const r = await provRec.ensureSpawnBed(bot, {})
  assert.strictEqual(r.ok, true, 'why: ' + r.why)
  assert.ok(bot._activated, 'a sleepable window with an unconfirmed spawn must actually re-assert')
  assert.strictEqual(worldMemory.knownBed().confirmed, true, 'the re-assert produced server evidence and must record it')
})

ta('T9d ensureSpawnBed: a CONFIRMED standing anchor is a fast noop even at night', async () => {
  resetWorldMem()
  const bot = fakeBot({ x: 101.5, z: 100.5, timeOfDay: 13000 })
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  worldMemory.rememberBed({ x: 101, y: 64, z: 100 }, { confirmed: true })
  bot._activated = null
  const r = await provRec.ensureSpawnBed(bot, {})
  assert.strictEqual(r.how, 'stood'); assert.strictEqual(r.confirmed, true)
  assert.ok(!bot._activated, 'a confirmed anchor must not be re-clicked every pass')
})

t('SOURCE: the day-click "i set my spawn" claim is gone from the sleep command', () => {
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  assert.ok(!/activateBlock\(bed\); provision\.rememberBed/.test(src), 'the raw click-then-claim pair is back in the sleep command')
  assert.ok(!/it already handles day-use-sets-spawn/.test(src), 'the disproven day-use-sets-spawn claim is back')
})

// --- T2: the lay-famine regression. Rough ground + a bed + filler = an anchor, via a pad.

ta('T2 ensureSpawnBed: chewed ground that starved the old search now yields a PADDED site', async () => {
  resetWorldMem()
  fakeRes._asked = []
  fakeRes._totals = { white_bed: 1, cobblestone: 64 }
  fakeRes._grant = ['white_bed', 'cobblestone']
  const bot = fakeBot({})
  // tonight's terrain in miniature: the ground near home sits a block LOWER than near.y and is
  // pocked with pit columns, so nothing at near.y has support and the old single-Y ring found
  // nothing at all. Ground-seeking + a <=2-block pad must convert this into an anchor.
  for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) bot._override(new Vec3(100 + dx, 63, 100 + dz), 'air')
  for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) if ((dx + dz) % 3 === 0) bot._override(new Vec3(100 + dx, 62, 100 + dz), 'air') // pits
  const r = await provRec.ensureSpawnBed(bot, { near: { x: 100, y: 64, z: 100 } })
  assert.strictEqual(r.ok, true, 'the bot must end this call with an anchor. why: ' + r.why)
  const kb = worldMemory.knownBed()
  assert.ok(kb, 'no bed was remembered')
  const v = provHut.bedUsable(bot, new Vec3(kb.x, kb.y, kb.z))
  assert.strictEqual(v.ok, true, 'the bed it laid must itself be usable: ' + v.why)
})

ta('T2b ensureBedSite: pad blocks are placed, bounded at 2, and NEVER scaffold-registered', async () => {
  const scaffold = require('./scaffold.js')
  fakeRes._asked = []; fakeRes._totals = { cobblestone: 64 }; fakeRes._grant = ['cobblestone']
  const bot = fakeBot({})
  // one pocket of missing support in otherwise flat ground: the cheapest site needs a pad
  for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) bot._override(new Vec3(100 + dx, 63, 100 + dz), 'air')
  const site = await provHut.ensureBedSite(bot, { x: 100, y: 64, z: 100 }, {})
  assert.ok(site, 'no site could be prepared on ground one step down')
  assert.ok(site.need <= 2, 'a pad may never exceed 2 blocks, got ' + site.need)
  for (const p of bot._placed) assert.ok(!scaffold.isScaffold(p), 'a pad block was scaffold-registered at ' + p.toString() + ' - the next teardown would drop the bed')
  assert.deepStrictEqual(fakeRes._asked.filter(n => n !== 'cobblestone'), [], 'pad filler must come from the resource model only: ' + JSON.stringify(fakeRes._asked))
})

ta('T5 ensureBedSite(plan): no filler obtainable -> null, and NOTHING is touched', async () => {
  fakeRes._asked = []; fakeRes._totals = {}; fakeRes._grant = null
  const bot = fakeBot({})
  for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) bot._override(new Vec3(100 + dx, 63, 100 + dz), 'air')
  for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) if ((dx + dz) % 2 === 0) bot._override(new Vec3(100 + dx, 62, 100 + dz), 'air')
  const plan = await provHut.ensureBedSite(bot, { x: 100, y: 64, z: 100 }, { plan: true })
  if (plan) assert.strictEqual(plan.need, 0, 'plan mode proposed a pad it cannot fund: ' + JSON.stringify(plan))
  assert.strictEqual(bot._placed.length, 0, 'plan mode must never write to the world')
  assert.ok(!(bot._dug > 0), 'plan mode must never dig')
})

// --- assertSpawnOn: evidence or no claim.

ta('T7a assertSpawnOn: the server confirms -> remembered as confirmed', async () => {
  resetWorldMem()
  const bot = fakeBot({})
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  const a = await provHut.assertSpawnOn(bot, bot.blockAt(new Vec3(101, 64, 100)), {})
  assert.strictEqual(a.ok, true, 'why: ' + a.why)
  assert.strictEqual(a.how, 'spawn_set')
  assert.strictEqual(worldMemory.knownBed().confirmed, true, 'a server-confirmed spawn must be recorded as confirmed')
})

ta('T7b assertSpawnOn: NO server evidence + allowUnconfirmed:false -> claims nothing at all', async () => {
  resetWorldMem()
  const bot = fakeBot({ noSetSpawn: true }) // the server refuses (night, hostiles) and says nothing
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  const a = await provHut.assertSpawnOn(bot, bot.blockAt(new Vec3(101, 64, 100)), { allowUnconfirmed: false })
  assert.strictEqual(a.ok, false, 'an unconfirmed click must not report success')
  assert.strictEqual(a.how, 'unconfirmed')
  assert.strictEqual(worldMemory.knownBed(), null, 'it recorded a spawn the server may never have set')
})

ta('T7c assertSpawnOn: allowUnconfirmed:true DOES remember - but honestly (confirmed:false)', async () => {
  resetWorldMem()
  const bot = fakeBot({ noSetSpawn: true })
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  const a = await provHut.assertSpawnOn(bot, bot.blockAt(new Vec3(101, 64, 100)), { allowUnconfirmed: true })
  assert.strictEqual(a.ok, true, 'recovery semantics: an unconfirmed bed beats none. why: ' + a.why)
  assert.strictEqual(a.how, 'unconfirmed')
  const kb = worldMemory.knownBed()
  assert.ok(kb, 'the recovery path must still record the bed')
  assert.strictEqual(kb.confirmed, false, 'it must NOT claim the spawn was confirmed')
})

// --- T4/T6/T8: the swap. Order is the invariant; every failure leaves the old anchor standing.

// THE LIVE UGLY ANCHOR: exactly the bed #107b produced - the server laid it EAST, so the real
// head at 102,64,100 hangs over open air (P2). It stands, it is asserted, and it is bad. Good
// flat ground sits all around it, so a replacement is genuinely achievable.
function uglyAnchorWorld (opts = {}) {
  const bot = fakeBot({ x: 101.5, z: 100.5, ...opts })
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'east' })
  bot._override(new Vec3(102, 64, 100), 'white_bed', { part: 'head', facing: 'east' })
  for (let y = 52; y <= 63; y++) bot._override(new Vec3(102, y, 100), 'air') // the head hangs over a void
  worldMemory.rememberBed({ x: 101, y: 64, z: 100 }, { confirmed: true })
  return bot
}
const swapWorld = uglyAnchorWorld

ta('T4 upgradeBedPlacement: create -> verify -> assert -> DESTROY LAST, and never anchor-less', async () => {
  resetWorldMem()
  fakeRes._asked = []; fakeRes._totals = { white_bed: 1, cobblestone: 64 }; fakeRes._grant = ['white_bed', 'cobblestone']
  let anchorAtOldDig = 'never dug'
  const bot = swapWorld({ onDig: b => { if (/_bed$/.test(b.name) && b.position.x === 101 && b.position.y === 64 && b.position.z === 100) anchorAtOldDig = worldMemory.knownBed() } })
  const r = await provHut.upgradeBedPlacement(bot, {})
  assert.strictEqual(r.how, 'swapped', 'the swap should have completed. why: ' + r.why)
  const ops = bot._ops
  const iPlace = ops.findIndex(o => o.op === 'place')
  const iAssert = ops.findIndex(o => o.op === 'activate')
  const iDigOld = ops.findIndex(o => o.op === 'dig' && /_bed$/.test(o.name || '') && o.pos.x === 101 && o.pos.y === 64 && o.pos.z === 100)
  assert.ok(iPlace >= 0 && iAssert >= 0 && iDigOld >= 0, 'expected place, assert and old-bed dig: ' + JSON.stringify(ops))
  assert.ok(iPlace < iAssert, 'the new bed must exist BEFORE spawn is asserted on it')
  assert.ok(iAssert < iDigOld, 'the old anchor was destroyed before the new one was asserted')
  assert.ok(anchorAtOldDig && !(anchorAtOldDig.x === 101 && anchorAtOldDig.z === 100), 'at the moment the old bed was dug, memory still pointed at it: ' + JSON.stringify(anchorAtOldDig))
  const kb = worldMemory.knownBed()
  assert.strictEqual(kb.confirmed, true, 'the swap must only commit a server-confirmed anchor')
  assert.strictEqual(provHut.bedUsable(bot, new Vec3(kb.x, kb.y, kb.z)).ok, true, 'the new anchor must be usable')
})

ta('T5b upgradeBedPlacement: no replacement obtainable -> kept, zero digs, memory intact', async () => {
  resetWorldMem()
  fakeRes._asked = []; fakeRes._totals = { cobblestone: 64 }; fakeRes._grant = null // no bed anywhere
  const bot = swapWorld()
  const r = await provHut.upgradeBedPlacement(bot, {})
  assert.strictEqual(r.how, 'kept', 'why: ' + r.why)
  assert.ok(!(bot._dug > 0), 'it dug something while it could not replace the bed')
  assert.strictEqual(bot._placed.length, 0, 'it touched the world before proving achievability')
  const kb = worldMemory.knownBed()
  assert.ok(kb && kb.x === 101 && kb.y === 64 && kb.z === 100, 'the old anchor must remain remembered')
  assert.ok(/_bed$/.test(bot.blockAt(new Vec3(101, 64, 100)).name), 'the old anchor must remain standing')
})

ta('T7d upgradeBedPlacement: spawn-set not confirmed -> new bed rolled back, old anchor intact', async () => {
  resetWorldMem()
  fakeRes._asked = []; fakeRes._totals = { white_bed: 1, cobblestone: 64 }; fakeRes._grant = ['white_bed', 'cobblestone']
  const bot = swapWorld({ noSetSpawn: true }) // the server never confirms the new spawn
  const r = await provHut.upgradeBedPlacement(bot, {})
  assert.strictEqual(r.how, 'kept', 'an unconfirmed assert must not move the anchor. why: ' + r.why)
  const kb = worldMemory.knownBed()
  assert.ok(kb && kb.x === 101 && kb.y === 64 && kb.z === 100, 'memory moved off the standing anchor: ' + JSON.stringify(kb))
  assert.ok(/_bed$/.test(bot.blockAt(new Vec3(101, 64, 100)).name), 'the old anchor was destroyed anyway')
})

ta('T8 upgradeBedPlacement: night, and out-of-reach, are noop/kept with ZERO world writes', async () => {
  resetWorldMem()
  fakeRes._totals = { white_bed: 1, cobblestone: 64 }; fakeRes._grant = ['white_bed', 'cobblestone']
  const night = swapWorld({ timeOfDay: 15000 })
  const rn = await provHut.upgradeBedPlacement(night, {})
  assert.strictEqual(rn.how, 'kept', 'a bot in the dark keeps its ugly bed. why: ' + rn.why)
  assert.strictEqual(night._placed.length, 0); assert.ok(!(night._dug > 0))

  resetWorldMem()
  const far = swapWorld({ x: 300.5, z: 300.5 })
  const rf = await provHut.upgradeBedPlacement(far, {})
  assert.strictEqual(rf.how, 'noop', 'a bed 200b away is not maintenance\'s business. why: ' + rf.why)
  assert.strictEqual(far._placed.length, 0); assert.ok(!(far._dug > 0))
})

ta('upgradeBedPlacement: a USABLE anchor is an immediate noop (idempotent, no world writes)', async () => {
  resetWorldMem()
  const bot = fakeBot({ x: 101.5, z: 100.5 })
  bot._override(new Vec3(101, 64, 100), 'white_bed', { part: 'foot', facing: 'south' })
  bot._override(new Vec3(101, 64, 101), 'white_bed', { part: 'head', facing: 'south' })
  worldMemory.rememberBed({ x: 101, y: 64, z: 100 }, { confirmed: true })
  const r = await provHut.upgradeBedPlacement(bot, {})
  assert.strictEqual(r.how, 'noop')
  assert.strictEqual(bot._placed.length, 0); assert.ok(!(bot._dug > 0))
})

// --- Source assertions: the shapes that must not come back.

t('SOURCE: the spawn-critical path contains no dig at all', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
  const fn = src.slice(src.indexOf('async function ensureSpawnBed'), src.indexOf('async function recoverSpawnAnchor'))
  assert.ok(!/\.dig\(/.test(fn), 'ensureSpawnBed digs again - the anchor is not its to destroy')
  assert.ok(!/bedWellPlaced/.test(src), 'the deleted quality predicate is back in the spawn path')
})

t('SOURCE: THE TUNING-RESURRECTION PIN - no neighbour-count rule anywhere in provision-hut.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  // The >=3/4-neighbour rule was DELETED, not tuned. Tuning 3 down to 2 is the same mistake:
  // the requirement is support + a place to stand, and ground continuity is not evidence of
  // either. Any counter over the support's horizontal neighbours fails this test.
  assert.ok(!/solid\s*<\s*\d/.test(src), 'a solid-neighbour count rule is back in provision-hut.js')
  assert.ok(!/bedWellPlaced/.test(src), 'bedWellPlaced is back - the name claimed aesthetics, not the requirement')
  assert.ok(!/ledge \/ wall crest \/ pillar top/.test(src), 'the deleted pre-screen is back')
})

t('SOURCE: furnishHut is gone, and with it three destroy-before-create paths', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  assert.ok(!/function furnishHut/.test(src), 'furnishHut is back in provision-hut.js')
  assert.ok(!/furnishHut/.test(fs.readFileSync(path.join(__dirname, 'provision.js'), 'utf8').split('module.exports')[1] || ''), 'furnishHut is back on the facade')
})

t('SOURCE: only assertSpawnOn may claim a spawn, and the swap never forgets a bed', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  // Every rememberBed in this file is either inside assertSpawnOn, or an explicit
  // confirmed:false RECONCILIATION write (reconcileInfra pointing memory at a standing bed).
  const claims = src.split('\n').filter(l => /rememberBed\(/.test(l) && !/^\s*\/\//.test(l) && !/{ confirmed: false }/.test(l) && !/rememberBed \}|rememberBed,/.test(l))
  for (const l of claims) assert.ok(/rememberBed\(pos, \{ confirmed \}\)/.test(l), 'a spawn claim outside assertSpawnOn: ' + l.trim())
  assert.ok(!/activateBlock\(b\); rememberBed/.test(src), 'the raw click-then-claim pair is back')
  const up = src.slice(src.indexOf('async function upgradeBedPlacement'), src.indexOf('function bedObtainable'))
  assert.ok(!/forgetBed/.test(up), 'the swap forgets a bed - forgetBed is reconciliation only, never a plan step')
})

t('SOURCE: the swap holds no blanket time window (condition gates only)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-hut.js'), 'utf8')
  const up = src.slice(src.indexOf('async function upgradeBedPlacement'), src.indexOf('function bedObtainable'))
  assert.ok(!/Date\.now\(\)/.test(up), 'a time comparison is back in the swap gates')
})


// ==== A BED IN THE WRONG ROOM IS NOT A MISSING BED (live 2026-07-30) =========================
// The hut stood registered at 188,67,-104 with its interior bed cells free and floored, and the
// bot's own white_bed stood at 185,68,-103/-102, outside the west wall. It could not reach it
// through the wall - `4.7b from the bed block` / `sleep failed (the bed is too far)` x3 /
// `pitting instead` - so it dug a hole to sleep in, every night, beside its own finished house.
// Root: the system had no MOVE. ensureHutBed -> acquireBed and upgradeBedPlacement both ask the
// resource model "do I have a bed?", which reads pack + chests; a bed STANDING IN THE WORLD is
// invisible to it. So it owned a bed, needed a bed, and was told to go find wool.
function relocWorld (opts = {}) {
  const bot = fakeBot({ items: [] })
  const hut = { x: 0, y: 65, z: 0 } // 6x6, interior bed cells (2,66,2)+(2,66,3)
  // the real bot WALKS to the bed before breaking it; stand where that walk ends unless a test
  // is specifically reproducing the failed-goto that started all this.
  bot.entity.position = new Vec3(opts.at ? opts.at[0] : -2.5, opts.at ? opts.at[1] : 66, opts.at ? opts.at[2] : 0.5)
  for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) bot._override(new Vec3(x, 65, z), 'oak_planks')
  bot._override(new Vec3(-3, 65, 0), 'grass_block')
  bot._override(new Vec3(-3, 65, 1), 'grass_block')
  if (opts.bedInside) {
    bot.entity.position = new Vec3(2.5, 66, 2.5)
    bot._override(new Vec3(2, 66, 2), 'white_bed', { part: 'foot', facing: 'south' })
    bot._override(new Vec3(2, 66, 3), 'white_bed', { part: 'head', facing: 'south' })
    worldMemory.rememberBed({ x: 2, y: 66, z: 2 })
  } else {
    // opts.orphanHead reproduces the half-broken bed the ungrounded first version left behind:
    // the foot cell air, the HEAD still standing, and memory still pointing at it.
    if (!opts.orphanHead) bot._override(new Vec3(-3, 66, 0), 'white_bed', { part: 'foot', facing: 'south' })
    bot._override(new Vec3(-3, 66, 1), 'white_bed', { part: 'head', facing: 'south' })
    worldMemory.rememberBed({ x: -3, y: 66, z: opts.orphanHead ? 1 : 0 })
  }
  return { bot, hut }
}

ta('RELOCATE: a bed OUTSIDE a registered hut is MOVED in - never re-sourced from wool', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld()
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'moved', r.why)
  assert.ok(/_bed$/.test(bot.blockAt(new Vec3(2, 66, 2)).name), 'the bed now stands in the hut interior')
  assert.strictEqual(bot.blockAt(new Vec3(-3, 66, 0)).name, 'air', 'and no longer outside the wall')
})

ta('RELOCATE SAFETY: a BLOCKED interior site refuses - the standing bed is never broken', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld()
  bot._override(new Vec3(2, 66, 2), 'cobblestone')
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'blocked', r.why)
  assert.ok(!bot._ops.some(o => o.op === 'dig'), 'NOTHING may be dug until the destination is proven')
  assert.ok(/_bed$/.test(bot.blockAt(new Vec3(-3, 66, 0)).name), 'the old anchor still stands')
})

ta('RELOCATE SAFETY: an UNLOADED interior site refuses - absence of observation is not a free cell', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld()
  bot._override(new Vec3(2, 66, 2), null) // never sent that chunk
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'noop', r.why)
  assert.ok(!bot._ops.some(o => o.op === 'dig'), 'a bed must never be broken toward a cell we cannot see')
})

ta('RELOCATE: already inside is a NO-OP - it must not re-lay the anchor every pass', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld({ bedInside: true })
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'noop', r.why)
  assert.ok(!bot._ops.some(o => o.op === 'dig'))
})

ta('RELOCATE ROLLBACK: if it cannot lay inside, the bed goes BACK where it was', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld()
  const origPlace = bot.placeBlock.bind(bot)
  let n = 0
  bot.placeBlock = async (ref, face) => { n++; if (n === 1) throw new Error('server refused the placement'); return origPlace(ref, face) }
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'rolled-back', r.why)
  assert.ok(/_bed$/.test(bot.blockAt(new Vec3(-3, 66, 0)).name), 'the anchor is standing again where it started')
  assert.strictEqual(bot.blockAt(new Vec3(2, 66, 2)).name, 'air', 'and nothing was left half-done inside')
})

// ==== dig() RESOLVING IS NOT EVIDENCE (live 2026-07-30, the FIRST run of relocateBedInto) =====
// A goto lost a fight with the hut doorway and left the bot at (190,70,-105) - six blocks and a
// wall from the bed. dig() resolved anyway, and the code announced `BROKE the bed and did not
// recover the item - no anchor now`. The world said otherwise: foot cell air, HEAD STILL STANDING
// at 185,68,-102. A half-broken bed, and a false report of having lost it.
ta('RECLAIM GROUNDED: out of reach after a failed goto -> KEPT, and nothing is swung at', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld({ at: [8.5, 70, 8.5] }) // where the failed goto actually left it
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'kept', r.why)
  assert.ok(/within reach/.test(r.why), 'and it must say so: ' + r.why)
  assert.ok(!bot._ops.some(o => o.op === 'dig'), 'a bed 8 blocks away must never be dug at')
  assert.ok(/_bed$/.test(bot.blockAt(new Vec3(-3, 66, 0)).name), 'the anchor still stands')
})

ta('RECLAIM GROUNDED: the server refusing the break is KEPT, never "I lost my bed"', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld()
  bot.dig = async () => { bot._ops.push({ op: 'dig' }) } // swing lands, block does NOT go away
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'kept', r.why)
  assert.ok(/did not remove/.test(r.why), 'the verdict must come from a world RE-READ: ' + r.why)
  assert.ok(/_bed$/.test(bot.blockAt(new Vec3(-3, 66, 0)).name), 'and the bed is still there, because it is')
})

ta('RECLAIM: the ORPHAN half left by the ungrounded run is reclaimed, not stepped over', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld({ orphanHead: true }) // foot air, head standing
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'moved', r.why)
  assert.ok(/_bed$/.test(bot.blockAt(new Vec3(2, 66, 2)).name), 'the salvaged half is a whole bed indoors again')
  assert.strictEqual(bot.blockAt(new Vec3(-3, 66, 1)).name, 'air', 'and the orphan is gone from outside')
})

ta('RELOCATE: hostiles nearby DEFER it - not a thing to do standing outside with a mob on us', async () => {
  resetWorldMem()
  const { bot, hut } = relocWorld()
  bot.entities = { 1: { id: 1, type: 'mob', name: 'zombie', position: new Vec3(4, 66, 4) } }
  const r = await provHut.relocateBedInto(bot, hut, {})
  assert.strictEqual(r.how, 'deferred', r.why)
  assert.ok(!bot._ops.some(o => o.op === 'dig'), 'and it did not break the bed first')
})

// ==== THE HUT MUST BE ENTERABLE (live 2026-07-30) ============================================
// The anchor drift built the drifted frame's rim wall one block north of the real hut, including
// BOTH halves of an oak_door at 190,68/69,-105 - directly in front of the real door at
// 190,68,-104. The bot could not path in: 116 door-assist failures, `crossOwnDoor(in): still on
// the wrong side`, so it slept outdoors and died to mobs three times in forty minutes. The hut
// survey read 0 bad of 180 throughout, because all of it sits OUTSIDE the hut box.
function doorApproachWorld (opts = {}) {
  const bot = fakeBot({ items: [] })
  const hut = { x: 0, y: 65, z: 0 }
  bot.entity.position = new Vec3(2.5, 66, -1.5) // on its own doorstep
  for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) {
    bot._override(new Vec3(x, 65, z), 'oak_planks')
    bot._override(new Vec3(x, 69, z), 'oak_planks')
    if (x === 0 || x === 5 || z === 0 || z === 5) for (let y = 66; y <= 68; y++) bot._override(new Vec3(x, y, z), 'oak_planks')
  }
  bot._override(new Vec3(2, 66, 0), 'oak_door', { part: 'lower', facing: 'north' }) // the REAL door
  bot._override(new Vec3(2, 67, 0), 'oak_door', { part: 'upper', facing: 'north' })
  bot._override(new Vec3(2, 65, -1), 'oak_planks')
  if (opts.ghost === 'unloaded') bot._override(new Vec3(2, 66, -1), null)
  else if (opts.ghost) {
    bot._override(new Vec3(2, 66, -1), opts.ghost, { part: 'lower', facing: 'east' })
    if (opts.ghost === 'oak_door') bot._override(new Vec3(2, 67, -1), 'oak_door', { part: 'upper', facing: 'east' })
  }
  return { bot, hut }
}

ta('APPROACH: the ghost door standing in its own doorway is RECLAIMED', async () => {
  resetWorldMem()
  const { bot, hut } = doorApproachWorld({ ghost: 'oak_door' })
  const r = await provHut.clearDoorApproach(bot, hut, {})
  assert.strictEqual(r.how, 'cleared', r.why)
  assert.strictEqual(bot.blockAt(new Vec3(2, 66, -1)).name, 'air', 'the doorstep is walkable again')
  assert.strictEqual(bot.blockAt(new Vec3(2, 67, -1)).name, 'air', 'both halves, not just the one it tripped over')
  assert.ok(/_door$/.test(bot.blockAt(new Vec3(2, 66, 0)).name), 'and the REAL door is untouched')
})

ta('APPROACH ANTI-GRIEF: a chest on the doorstep is NOT mine to clear', async () => {
  resetWorldMem()
  const { bot, hut } = doorApproachWorld({ ghost: 'chest' })
  const r = await provHut.clearDoorApproach(bot, hut, {})
  assert.strictEqual(r.how, 'blocked', r.why)
  assert.ok(!bot._ops.some(o => o.op === 'dig'), 'furniture is never litter, whatever it is standing in')
  assert.strictEqual(bot.blockAt(new Vec3(2, 66, -1)).name, 'chest')
})

ta('APPROACH: an UNLOADED doorstep claims nothing and digs nothing', async () => {
  resetWorldMem()
  const { bot, hut } = doorApproachWorld({ ghost: 'unloaded' })
  const r = await provHut.clearDoorApproach(bot, hut, {})
  assert.strictEqual(r.how, 'unknown', r.why)
  assert.ok(!bot._ops.some(o => o.op === 'dig'))
})

ta('APPROACH: an already-walkable doorstep is a fast no-op', async () => {
  resetWorldMem()
  const { bot, hut } = doorApproachWorld()
  const r = await provHut.clearDoorApproach(bot, hut, {})
  assert.strictEqual(r.how, 'clear', r.why)
  assert.ok(!bot._ops.some(o => o.op === 'dig'))
})

runQueued().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})
