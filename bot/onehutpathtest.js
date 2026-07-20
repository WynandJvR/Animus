'use strict'
// OFFLINE tests for #108 ONE_HUT_PATH (design-docs/DESIGN-grounded-truth-and-home-first.md §8,
// Root I - "one operation exists as many divergent copies, so fixes land in dead code").
// Run:  cd bot && node onehutpathtest.js
//
// THE BUG THIS PINS. "Rebuild the hut" existed TWICE - a default-ON path and a complete
// NONDESTRUCTIVE_REPAIR=0 copy "kept byte-for-byte for rollback". Fixes then landed on ONE side
// in BOTH directions: the self-gather fix (#101) went into the copy that never executed, while
// the treasury guard + verified-bank-empty abort went into the copy that did. So the "rollback"
// had silently become a treasury-loss path, and a shipped capability sat in dead code. The
// offline suite stayed green throughout, because it tested FUNCTIONS and FLAG REGIMES - never
// which call site the live topology actually reaches.
//
// Three things are asserted here:
//   1. CENSUS (permanent, the anti-recurrence rule): a fix may gate NEW behaviour on/off, but may
//      not preserve a SECOND LIVING IMPLEMENTATION of an operation. Rollback is `git revert`.
//   2. REFUSAL CONTRACT: a build entered STOPPED, or one that cannot get a single block down,
//      returns refused and claims NOTHING. Live evidence: a 109s "rebuild" made zero sourcing
//      calls and zero placement attempts (wedged, stop signal live at entry) and still printed
//      `hut rebuilt -> 0/94`, then wrote the hut into world memory as established.
//   3. SOURCING IS OWNED BY THE BUILD: with an EMPTY bank and no call-site options at all, the
//      build still runs the withdraw > craft > GATHER chain. An under-capable call site is now
//      unrepresentable because the fetch/gather options do not exist.
//
// AMBIENT-PROOF: every env var these modules read is set or deleted explicitly below. Nothing
// here inherits from the shell.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---- env isolation, BEFORE anything loads ---------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onehutpath-'))
process.env.WORLD_MEM_FILE = path.join(TMP, 'world-memory.json')
process.env.DEATH_FILE = path.join(TMP, 'last-death.json')
process.env.RESUME_FILE = path.join(TMP, 'resume-job.json')
process.env.CHEST_CACHE_FILE = path.join(TMP, 'chest-cache.json')
process.env.SCAFFOLD_FILE = path.join(TMP, 'scaffold-registry.json')
process.env.STATE_HISTORY_FILE = path.join(TMP, 'state-history.jsonl')
delete process.env.BUILD_DEBUG
delete process.env.SITE_CAMP
delete process.env.SITE_HUT
delete process.env.GROUNDED_OBS
// the flags this slice DELETES: driven to their old "rollback" value on purpose, to prove they
// are inert. If any of them still switches behaviour, a second implementation survived.
process.env.NONDESTRUCTIVE_REPAIR = '0'
process.env.CAMP_SELF_GATHER = '0'
process.env.VERIFY_SUCCESS_MSG = '0'
process.env.GRAVE_LOOT_VERIFY = '0'
process.env.FOOD_RESERVE_FIRST = '0'

const BOT_DIR = __dirname
let failures = 0
function t (name, fn) {
  try { const r = fn(); if (r && r.then) throw new Error('async test used the sync runner'); console.log('PASS ', name) } catch (e) { failures++; console.log('FAIL ', name); console.log('      ' + (e && e.message)) }
}
async function ta (name, fn) {
  try { await fn(); console.log('PASS ', name) } catch (e) { failures++; console.log('FAIL ', name); console.log('      ' + (e && e.message)) }
}

// ---- source census helpers ------------------------------------------------------------------
// Comments are STRIPPED before scanning: a deleted flag may be NAMED in a changelog comment
// ("#108: the =0 leg is deleted") - what must not survive is a live read of it.
function stripComments (src) {
  // CRLF-PROOF: `.` never matches \r (it is a line terminator in JS regex), so a trailing \r made
  // the line-comment strip silently no-op on a CRLF checkout and this whole census then reported
  // false positives on its own changelog comments. A test must never depend on line endings.
  return src
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
}
const SOURCE_FILES = fs.readdirSync(BOT_DIR)
  .filter(f => f.endsWith('.js') && !/test\.js$/.test(f) && !/^_/.test(f))
  .map(f => ({ file: f, code: stripComments(fs.readFileSync(path.join(BOT_DIR, f), 'utf8')) }))

// =============================================================================================
// 1. THE CENSUS TEST (permanent repo convention - §8.4(6))
// =============================================================================================

t('census: the DELETED flags have no live reader anywhere in bot/ (rollback is git revert, not a second copy)', () => {
  const dead = ['NONDESTRUCTIVE_REPAIR', 'CAMP_SELF_GATHER', 'VERIFY_SUCCESS_MSG', 'GRAVE_LOOT_VERIFY', 'FOOD_RESERVE_FIRST', 'BUILD_SELF_GATHER']
  const hits = []
  for (const { file, code } of SOURCE_FILES) {
    for (const flag of dead) if (code.includes(flag)) hits.push(file + ' -> ' + flag)
  }
  assert.deepStrictEqual(hits, [], 'a deleted flag is still read in live code:\n  ' + hits.join('\n  '))
})

t('census: no call site may assemble buildSurvival sourcing (fetch:/gather: options do not exist)', () => {
  const hits = []
  for (const { file, code } of SOURCE_FILES) {
    // scan the option object of every buildSurvival( call - it may span lines
    const re = /buildSurvival\s*\(([\s\S]{0,600}?)\)\s*(?:\.|;|$|\})/gm
    let m
    while ((m = re.exec(code))) {
      if (/\bfetch\s*:/.test(m[1]) || /\bgather\s*:/.test(m[1])) hits.push(file)
    }
  }
  assert.deepStrictEqual([...new Set(hits)], [], 'buildSurvival call site still assembles its own sourcing: ' + hits.join(', '))
})

t('census: buildSurvival itself never reads opts.fetch / opts.gather (the parameters are gone)', () => {
  const code = SOURCE_FILES.find(f => f.file === 'schematic.js').code
  assert(!/opts\.fetch/.test(code), 'schematic.js still reads opts.fetch')
  assert(!/opts\.gather\b/.test(code), 'schematic.js still reads opts.gather')
  assert(/makeSourcer/.test(code), 'schematic.js must own its sourcer')
})

t('census: exactly ONE hut rebuild implementation - no second buildSurvival call on the hut schematic', () => {
  const code = SOURCE_FILES.find(f => f.file === 'commands.js').code
  const n = (code.match(/buildSurvival\s*\(\s*bot\s*,\s*hutSchem/g) || []).length
  assert.strictEqual(n, 1, 'the hut is built from ' + n + ' places - it must be exactly one')
})

t('census: the hut rebuild may not record infra / claim / latch from a REFUSED or UNVERIFIED build', () => {
  const code = SOURCE_FILES.find(f => f.file === 'commands.js').code
  // #115 STRENGTHENED. The old lock demanded rememberInfra('hut') sit behind
  // `!hr.refused && hr.placed > 0`. That guard was necessary and NOT sufficient: a build that
  // placed blocks is not evidence that a hut STANDS, and the live tape proved it - the write
  // fired after a pass that "rebuilt" a hut nobody could see. The write now lives in the
  // post-verify's builtClean branch and must carry the survey as its proof.
  const all = (code.match(/rememberInfra\s*\(\s*'hut'/g) || []).length
  assert.strictEqual(all, 1, "there must be exactly ONE rememberInfra('hut') write site, found " + all)
  const remember = code.indexOf("rememberInfra('hut'")
  assert(remember > 0, "rememberInfra('hut') not found")
  const call = code.slice(remember, remember + 220)
  assert(/proof\s*:/.test(call), "rememberInfra('hut') must pass a proof - an unproven write is how the phantom hut got in")
  // and it must be downstream of the verify that earned it
  const clean = code.indexOf('const builtClean')
  assert(clean > 0 && clean < remember, "rememberInfra('hut') must sit AFTER the post-build survey, inside its clean branch")
  const guard = code.slice(clean, remember)
  assert(/builtClean/.test(guard), "rememberInfra('hut') must be gated on builtClean")
})

t('census/anti-grief: a REFUSED hut rebuild still latches the UNIMPROVED damage count', () => {
  // By the time a rebuild can refuse, the bank has been emptied and clearVolume has already torn
  // the site down. decideHutRepair only declines a second destructive pass when the latch says the
  // last attempt improved nothing (stalled = lastAction != null && !improved). So a refused pass
  // must record lastBad = the PRE-build `bad` (never 0, never absent) or the bot re-clears the hut
  // site on every single camp pass forever. Latching the truth is not claiming success.
  const code = SOURCE_FILES.find(f => f.file === 'commands.js').code
  const i = code.indexOf('hut rebuild REFUSED')
  assert(i > 0, 'the refusal branch of the hut rebuild was not found')
  const window = code.slice(Math.max(0, i - 500), i + 200)
  assert(/hutRepairLatch\s*=\s*\{\s*lastBad:\s*bad\s*,/.test(window),
    'a refused rebuild must latch lastBad = bad (the unimproved pre-build count) so the next pass patches')
  assert(!/hutRepairLatch\s*=\s*\{\s*lastBad:\s*0/.test(window), 'a refused rebuild may never latch lastBad: 0 (that is a success record)')
})

// =============================================================================================
// 2. THE REFUSAL CONTRACT
// =============================================================================================

// Stubbed siblings, installed in the module cache BEFORE schematic.js loads. provision's live
// survival/night hooks are consulted every loop iteration and are not the subject here; the
// resource model is stubbed so we can assert exactly WHAT THE BUILD ASKED FOR.
const acquireCalls = []
const reconcileCalls = []
const runReconciledCalls = []
let bankHas = {} // the "bank": what acquire is allowed to deliver

const provPath = require.resolve('./provision.js')
const inv = {} // item -> count, the fake pack
require.cache[provPath] = {
  id: provPath,
  filename: provPath,
  loaded: true,
  exports: {
    survivalNeed: () => null,
    survivalState: () => null,
    nightRestWanted: () => false,
    nightRest: async () => {},
    secureFood: async () => {},
    isResting: () => false,
    inventoryCounts: () => ({ ...inv }),
    placeChestOriented: async () => false,
    setDebugSink: () => {}
  }
}

const resPath = require.resolve('./resources.js')
require.cache[resPath] = {
  id: resPath,
  filename: resPath,
  loaded: true,
  exports: {
    acquire: async (bot, name, count, opts) => {
      acquireCalls.push({ name, count, opts })
      const got = Math.min(count, bankHas[name] || 0)
      if (got > 0) { bankHas[name] -= got; inv[name] = (inv[name] || 0) + got }
      return (inv[name] || 0) >= count
    },
    reconcile: async (bot, bom, opts) => {
      reconcileCalls.push({ bom, opts })
      const name = Object.keys(bom)[0]
      // 'unobtainable' only for the things the fake world genuinely cannot produce
      if (/iron_bars|wool|bed$/.test(name)) return { plan: { unobtainable: { [name]: 1 }, tasks: [] }, withdraws: [] }
      return { plan: { unobtainable: {}, tasks: [{ type: 'gather', item: name }] }, withdraws: [] }
    },
    runReconciled: async (bot, rec, opts) => {
      runReconciledCalls.push({ rec, opts })
      const name = Object.keys(rec.plan.unobtainable || {})[0] || (rec.plan.tasks[0] && rec.plan.tasks[0].item)
      if (name) inv[name] = (inv[name] || 0) + 8 // the gather rung succeeds
      return []
    },
    restockFromBank: async () => 0,
    verifiedChests: () => []
  }
}

// navigate.js: every approach fails (the scripted noPath fixture). Stubbed so no offline test can
// reach a real pathfinder.
const navPath = require.resolve('./navigate.js')
require.cache[navPath] = {
  id: navPath,
  filename: navPath,
  loaded: true,
  exports: {
    gotoOnce: async () => { throw new Error('No path to the goal!') },
    navigateTo: async () => { throw new Error('No path to the goal!') },
    setDebugSink: () => {}
  }
}

const schematic = require('./schematic.js')
const { Vec3 } = require('vec3')
const V = '1.21.1'
const mcData = require('minecraft-data')(V)
const Block = require('prismarine-block')(V)
const AIR_BLOCK = Block.fromStateId(0, 0)

// A bot with a world of pure air: no neighbour offers a placement face, so EVERY placement
// approach fails without a single block going down. That is the wedged/unworkable-site fixture,
// grounded in the same code path the live builder uses (Build.getPossibleDirections).
const STONE_ID = mcData.blocksByName.stone.defaultState
const STONE_BLOCK = Block.fromStateId(STONE_ID, 0)
// `groundY`: everything strictly below it is solid stone, everything at/above is air. With no
// ground at all NO cell has a placement face (the unworkable-site fixture); with ground, the
// bottom schematic layer is placeable and the loop reaches its MATERIAL sourcing step.
function fakeBot (groundY = null) {
  const solid = p => groundY != null && p && p.y < groundY
  return {
    version: V,
    registry: mcData,
    entity: { position: new Vec3(0.5, 65, 0.5), velocity: new Vec3(0, 0, 0) },
    world: { getBlockStateId: p => (solid(p) ? STONE_ID : 0), getBlock: p => (solid(p) ? STONE_BLOCK : AIR_BLOCK), raycast: () => null },
    inventory: { items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: (mcData.itemsByName[name] || {}).id, metadata: 0 })), emptySlotCount: () => 36 },
    heldItem: null,
    entities: {},
    blockAt: p => (solid(p) ? STONE_BLOCK : AIR_BLOCK),
    findBlock: () => null,
    findBlocks: () => [],
    pathfinder: { setMovements () {}, setGoal () {} },
    setControlState () {},
    equip: async () => {},
    lookAt: async () => {}
  }
}
function resetFixture () {
  acquireCalls.length = 0; reconcileCalls.length = 0; runReconciledCalls.length = 0
  for (const k of Object.keys(inv)) delete inv[k]
  bankHas = {}
}

let hutSchem = null

async function main () {
  hutSchem = await schematic.loadFile('hut.schem', V)

  await ta('refusal: a build ENTERED STOPPED returns refused:"stopped", places nothing, touches nothing', async () => {
    resetFixture()
    const bot = fakeBot()
    let clearedAnything = false
    bot.pathfinder.setMovements = () => { clearedAnything = true } // any world/body work at all
    const r = await schematic.buildSurvival(bot, hutSchem, new Vec3(0, 65, 0), {
      isStopped: () => true, clear: true, clearFurniture: true
    })
    assert.strictEqual(r.refused, 'stopped', 'must refuse')
    assert.strictEqual(r.placed, 0, 'nothing placed')
    assert.strictEqual(r.stopped, true)
    assert.strictEqual(clearedAnything, false, 'a refused build must not touch the body at all (no clearVolume, no movements)')
    assert.strictEqual(acquireCalls.length, 0, 'no sourcing from a refused build')
    // the caller-visible success gate must be FALSE: this is the exact expression the camp uses
    assert.strictEqual(!!(r.total && r.placed >= r.total), false, '"built clean" must be unreachable from a refusal')
  })

  await ta('refusal: an UNWORKABLE site returns refused:"unreachable" after K grounded failures, having placed nothing', async () => {
    resetFixture()
    const bot = fakeBot()
    // pack fully stocked, so nothing can be blamed on materials: this is purely "cannot place"
    for (const [name, count] of Object.entries(schematic.billOfMaterials(hutSchem).counts)) inv[name] = count + 8
    const r = await schematic.buildSurvival(bot, hutSchem, new Vec3(0, 65, 0), {
      isStopped: () => false, prep: false, cleanup: false
    })
    assert.strictEqual(r.placed, 0, 'the air world offers no placement face - nothing can land')
    assert.strictEqual(r.refused, 'unreachable', 'must refuse as unreachable, not report a 0/N success')
    assert(r.total > 0, 'the build genuinely had work to do (' + r.total + ' cells)')
  })

  await ta('refusal: fail CLOSED - "placed 0 of N" is never a non-refusal, whatever the reason', async () => {
    resetFixture()
    const bot = fakeBot()
    // no materials AND no bank AND an unplaceable site: still refused, never a quiet 0/N success
    const r = await schematic.buildSurvival(bot, hutSchem, new Vec3(0, 65, 0), { isStopped: () => false, prep: false, cleanup: false })
    assert.strictEqual(r.placed, 0)
    assert(r.refused, 'a build that placed nothing must always carry a refusal')
  })

  // =============================================================================================
  // 3. SOURCING IS OWNED BY THE BUILD
  // =============================================================================================

  await ta('sourcing: an EMPTY bank still drives withdraw > craft > GATHER, with NO call-site options', async () => {
    resetFixture()
    const bot = fakeBot(65) // solid ground under the footprint: cells ARE placeable
    bankHas = {} // the live 16:13 fixture: bank empty
    const r = await schematic.buildSurvival(bot, hutSchem, new Vec3(0, 65, 0), {
      isStopped: () => false, prep: false, cleanup: false, planOpts: { primaryWood: 'oak' }
    })
    assert(acquireCalls.length > 0, 'the build must try the bank/craft rung itself (no fetch option exists)')
    assert(reconcileCalls.length > 0, 'the build must fall through to the GATHER rung on an empty bank - this is the capability that lived in dead code')
    assert(runReconciledCalls.length > 0, 'the gather round must actually run')
    assert.strictEqual(acquireCalls[0].opts.planOpts.primaryWood, 'oak', 'the wood policy must reach the sourcer')
    void r
  })

  await ta('sourcing: planOpts may be a FUNCTION and is re-resolved per round (live cost hints stay current)', async () => {
    resetFixture()
    const bot = fakeBot(65)
    let n = 0
    await schematic.buildSurvival(bot, hutSchem, new Vec3(0, 65, 0), {
      isStopped: () => false, prep: false, cleanup: false, planOpts: () => ({ primaryWood: 'oak', freshPickaxes: ++n })
    })
    assert(n >= 2, 'planOpts must be invoked per USE (withdraw/craft rung and gather rung both) - saw ' + n)
    assert(acquireCalls.length >= 1 && reconcileCalls.length >= 1, 'both sourcing rungs must have run')
    // captured-once would make these identical; per-use resolution makes them differ
    assert.notStrictEqual(acquireCalls[0].opts.planOpts.freshPickaxes, reconcileCalls[0].opts.planOpts.freshPickaxes,
      'planOpts was captured once instead of re-resolved at each use')
  })

  await ta('sourcing: an UNOBTAINABLE material is skipped immediately - no dead wait', async () => {
    resetFixture()
    const bot = fakeBot(65)
    const started = Date.now()
    const r = await schematic.buildSurvival(bot, hutSchem, new Vec3(0, 65, 0), { isStopped: () => false, prep: false, cleanup: false })
    // white_bed is unobtainable in this fixture; the old code burned 240s PER material waiting.
    assert(Date.now() - started < 30000, 'the deleted 240s/material dead-wait must not be back')
    assert(r.skipped >= 0)
  })

  console.log('')
  if (failures) { console.log(failures + ' FAILURE(S)'); process.exit(1) }
  console.log('all one-hut-path (#108) tests passed')
}

main().catch(e => { console.error(e); process.exit(1) })
