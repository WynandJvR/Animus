'use strict'
// OFFLINE unit test for #117 HOME_IS_A_NEED (design-docs/DESIGN-grounded-truth-and-home-first.md
// §3.2 Root B, half B2). Proves the four things the slice claims:
//   1. HOME IS A VERDICT. bootstrapNeed gained 'spawn' (above 'armor') and 'shelter' (below it),
//      and #103's homeless=>null inversion is GONE - from the source, not just from behaviour.
//   2. IT CANNOT MASK A CRISIS. A starving bedless bot still gets 'food' first.
//   3. IT CANNOT LOOP. 'spawn' steps aside on a CONDITION (the acquire plan is exhausted this
//      life / the anchor cannot be confirmed until nightfall) - there is no timer anywhere in it.
//   4. IT HAS A PRODUCER OUTSIDE THE BUILD. maintenancePass runs ensureSpawnBed / ensureHomeShelter
//      off the verdict with no build job in sight - the whole point of the slice.
//
// AMBIENT-PROOF: every env var these subjects read is set EXPLICITLY below and restored after,
// and world-memory is redirected to a per-pid temp file so a run never touches live memory.
// Run:  cd bot && node homefirsttest.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ENV_KEYS = ['BOOTSTRAP_PRIORITY', 'BOOTSTRAP_HP', 'BOOTSTRAP_FED', 'FOOD_RESERVE_HP',
  'FOOD_RESERVE_TARGET', 'CAMP_FIRST', 'BUILD_DEBUG', 'WORLD_MEM_FILE', 'GROUNDED_OBS',
  'BOOTSTRAP_NEEDS_HOME', 'MAINT_SAFEKEEP', 'FOOD_TOPUP', 'FOOD_SUPPLY', 'BREAD_ENGINE']
const SAVED = {}
for (const k of ENV_KEYS) SAVED[k] = process.env[k]
process.env.BOOTSTRAP_PRIORITY = '1'
process.env.GROUNDED_OBS = '1'
delete process.env.BUILD_DEBUG
delete process.env.BOOTSTRAP_NEEDS_HOME // the flag is DELETED; an ambient value must not matter
delete process.env.BOOTSTRAP_HP
delete process.env.BOOTSTRAP_FED
delete process.env.FOOD_RESERVE_HP
delete process.env.FOOD_RESERVE_TARGET
delete process.env.CAMP_FIRST
const MEMFILE = path.join(require('os').tmpdir(), 'hf117-world-memory-' + process.pid + '.json')
process.env.WORLD_MEM_FILE = MEMFILE
try { fs.unlinkSync(MEMFILE) } catch {}

const S = require('./scheduler.js')
const provRecovery = require('./provision-recovery.js')
const provMaintain = require('./provision-maintain.js')
const worldMemory = require('./world-memory.js')
const pathfix = require('./pathfix.js')

let failures = 0
function t (name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => console.log('PASS  ' + name), e => { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message); return }
  console.log('PASS  ' + name)
}

// A snapshot with the HOME facts measured. Defaults describe the live bot on 2026-07-19: fed,
// healthy, a stocked bank so the food rung is satisfied, and NO spawn anchor of any kind.
function snap (over) {
  return Object.assign({
    hp: 20, food: 20, armorPieces: 0, bankFoodPts: 40,
    homeReachable: false, homeDist: null, hutExists: false, hutVerified: false,
    spawnAnchored: false, bedKnown: false, spawnSuspect: false, sleepableNow: false,
    bedUnobtainable: false, baseLit: null
  }, over || {})
}

// ---- 1. THE VERDICT ORDER ------------------------------------------------------------------

t('(#117) a FED, BEDLESS bot beds before it armors - "spawn" outranks "armor"', () => {
  assert.strictEqual(S.bootstrapNeed(snap()), 'spawn')
  // and the moment the anchor is real, armor is next in line (the order, not a muzzle)
  assert.strictEqual(S.bootstrapNeed(snap({ spawnAnchored: true, bedKnown: true })), 'armor')
})

t('(#117) a STARVING bedless bot still eats first - the anchor may never mask a food crisis', () => {
  // food-crisis rung: reachable home + fed + reserve under target. It sits ABOVE 'spawn'.
  assert.strictEqual(S.bootstrapNeed(snap({ homeReachable: true, homeDist: 10, bankFoodPts: 0 })), 'food')
  // and a bot too hungry to bootstrap AT ALL gets null, not 'spawn' (the healthy-window gate)
  assert.strictEqual(S.bootstrapNeed(snap({ food: 4 })), null, 'an unfed bot is the SURVIVAL tier\'s job, never bootstrap\'s')
  assert.strictEqual(S.bootstrapNeed(snap({ hp: 6 })), null, 'a degraded bot is the SURVIVAL tier\'s job, never bootstrap\'s')
})

t('(#117) a hut ON THE BOOKS that does not verify -> "shelter", ranked just after "armor"', () => {
  const armored = { spawnAnchored: true, bedKnown: true, armorPieces: 4 }
  assert.strictEqual(S.bootstrapNeed(snap({ ...armored, hutExists: true, hutVerified: false })), 'shelter')
  // armor still wins over shelter (a naked bot in a broken hut arms itself first)
  assert.strictEqual(S.bootstrapNeed(snap({ spawnAnchored: true, bedKnown: true, armorPieces: 0, hutExists: true, hutVerified: false })), 'armor')
  // a hut the bot has SEEN this life is not a need
  assert.strictEqual(S.bootstrapNeed(snap({ ...armored, hutExists: true, hutVerified: true, homeReachable: true, homeDist: 5, baseLit: true })), null)
})

t('(#117) the #103 muzzle is gone: a HOMELESS bot bootstraps something, never null', () => {
  // This is the exact snapshot #103 returned null for: homeReachable false, no hut, no homeDist.
  const homeless = snap({ homeReachable: false, homeDist: null, hutExists: false })
  assert.strictEqual(S.bootstrapNeed(homeless), 'spawn', 'homeless => the need IS home (spawn), not nothing')
  // ...and with an anchor already down it falls through to armor rather than to null.
  assert.strictEqual(S.bootstrapNeed(snap({ ...homeless, spawnAnchored: true, bedKnown: true })), 'armor')
})

t('(#117) UNMEASURED IS NOT UNMET: a snapshot that never measured home invents no need', () => {
  // Root A applied to this path. Every pre-#117 caller (and every fixture in schedulertest) builds
  // snapshots without these fields; they must behave exactly as they did before the slice.
  const unmeasured = { hp: 20, food: 20, armorPieces: 4, homeReachable: false, homeDist: 60, bankFoodPts: 40 }
  assert.strictEqual(S.bootstrapNeed(unmeasured), null, 'absent spawnAnchored/hutVerified => no verdict')
  assert.strictEqual(S.bootstrapNeed({ ...unmeasured, hutExists: true }), null, 'a hut with an UNMEASURED verdict is not a shelter need')
})

t('(BOOTSTRAP_PRIORITY=0) the whole tier is still off byte-for-byte, home verdicts included', () => {
  const old = process.env.BOOTSTRAP_PRIORITY
  process.env.BOOTSTRAP_PRIORITY = '0'
  try {
    assert.strictEqual(S.bootstrapNeed(snap()), null)
    assert.strictEqual(S.bootstrapNeed(snap({ hutExists: true, hutVerified: false })), null)
  } finally { process.env.BOOTSTRAP_PRIORITY = old }
})

// ---- 2. THE ANTI-LOOP CONDITION (design §5) ------------------------------------------------

t("(#117 anti-loop) 'spawn' steps aside when the acquire plan is EXHAUSTED this life", () => {
  // No sheep, no wool, no bank bed: acquireBed exhausts and ensureSpawnBed records it. The verdict
  // must yield to armor so the bot gets on with its life - and this is a CONDITION, not a cooldown.
  assert.strictEqual(S.bootstrapNeed(snap({ bedUnobtainable: true })), 'armor')
  assert.strictEqual(S.bootstrapNeed(snap({ bedUnobtainable: true, armorPieces: 4, hutExists: true, hutVerified: false })), 'shelter')
  // it only ever gates the ACQUIRE rung: a bed that EXISTS and is suspect is still re-anchored.
  assert.strictEqual(S.bootstrapNeed(snap({ bedUnobtainable: true, bedKnown: true, spawnSuspect: true })), 'spawn')
})

t("(#117 anti-loop) a standing UNCONFIRMED bed re-asserts only when the world can grant a sleep", () => {
  const standing = { bedKnown: true, spawnAnchored: false, spawnSuspect: false }
  // Daylight: ensureSpawnBed has literally nothing to do but say "at nightfall". Firing here would
  // spin maintenancePass every tick and starve armor/base - so the verdict waits ON THE CONDITION.
  assert.strictEqual(S.bootstrapNeed(snap({ ...standing, sleepableNow: false })), 'armor')
  // Night (or thunder): a sleep can be granted, so the anchor is fixable NOW.
  assert.strictEqual(S.bootstrapNeed(snap({ ...standing, sleepableNow: true })), 'spawn')
})

t('(#117 anti-loop) the predicate is PURE and CLOCKLESS - no timer can hide in it', () => {
  // spawnBootstrapDue is exported precisely so this can be pinned. It gets no clock, no bot, no
  // env; the same snapshot must give the same answer forever.
  const s = snap({ bedKnown: true, sleepableNow: true })
  const a = S.spawnBootstrapDue(s)
  for (let i = 0; i < 50; i++) assert.strictEqual(S.spawnBootstrapDue(s), a)
  assert.strictEqual(a, true)
  // and it is total: every shape answers a boolean, including junk.
  for (const junk of [null, undefined, {}, { spawnAnchored: false }]) assert.strictEqual(typeof S.spawnBootstrapDue(junk), 'boolean')
})

// ---- 3. THE EPOCH-SCOPED CONDITION RECORD (world-memory) ------------------------------------

t('(#117) bedUnobtainable is scoped to THIS LIFE, not to a wall clock', () => {
  worldMemory.clearBedUnobtainable()
  assert.strictEqual(worldMemory.bedUnobtainable(), false, 'clean slate')
  worldMemory.noteBedUnobtainable()
  assert.strictEqual(worldMemory.bedUnobtainable(), true, 'recorded for this life')
  // A DEATH bumps the pathfix epoch. The bot respawns somewhere else entirely - usually near world
  // spawn - so "nothing here can make a bed" is an open question again, immediately and without
  // any elapsed time at all. THIS is the release condition; there is no other.
  pathfix.bumpEpoch()
  assert.strictEqual(worldMemory.bedUnobtainable(), false, 'a new life re-opens the question')
})

t('(#117) a bed record disproves "unobtainable" outright', () => {
  worldMemory.noteBedUnobtainable()
  assert.strictEqual(worldMemory.bedUnobtainable(), true)
  worldMemory.rememberBed({ x: 10, y: 64, z: 10 }, { confirmed: false })
  assert.strictEqual(worldMemory.bedUnobtainable(), false, 'a bed exists, so the plan was not exhausted after all')
  worldMemory.forgetBed()
})

t('(#117) hutVerifiedNow reads v2 provenance only - a registry BOX is not a verified hut', () => {
  const mem = worldMemory.loadWorldMem()
  mem.infra = mem.infra || {}
  // the phantom: a hut written with NO proof (the pre-#115 unconditional write)
  mem.infra.hut = [{ x: 456, y: 68, z: -142, at: Date.now(), verified: false }]
  assert.strictEqual(worldMemory.hutVerifiedNow(), false, 'an unproven record is a hint, never a hut')
  // verified, but in a PREVIOUS life: the structure was seen by a bot that no longer exists
  mem.infra.hut = [{ x: 456, y: 68, z: -142, at: Date.now(), verified: true, epoch: pathfix.epoch() - 1 }]
  assert.strictEqual(worldMemory.hutVerifiedNow(), false, 'a stale-epoch proof does not carry into this life')
  // seen, this life
  mem.infra.hut = [{ x: 456, y: 68, z: -142, at: Date.now(), verified: true, epoch: pathfix.epoch() }]
  assert.strictEqual(worldMemory.hutVerifiedNow(), true)
  delete mem.infra.hut
})

// ---- 4. THE SOURCE PINS --------------------------------------------------------------------
// CRLF-SAFE BY CONSTRUCTION. The repo checks out CRLF, and the classic comment-stripper
// (`.replace(/(^|[^:])\/\/.*$/, '$1')` per line) is a SILENT NO-OP on it - `.` never matches the
// trailing `\r` and bare `$` wants the true end of string. Two builders have been burned. So:
// normalise line endings FIRST, delimit the region by LANDMARKS rather than offsets, and
// MUTATION-VERIFY every pin below against a deliberately-broken copy of the same text.
function srcOf (file) { return fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n') }
// The BODY of a top-level function: from its signature to the first column-0 '}'. No comments
// above it, so a tombstone comment can never satisfy a pin (the #115b failure mode, verbatim).
function bodyOf (code, signature) {
  const i = code.indexOf(signature)
  if (i < 0) throw new Error('signature not found: ' + signature)
  const j = code.indexOf('\n}', i)
  if (j < 0) throw new Error('unterminated function: ' + signature)
  return code.slice(i, j + 2)
}
// Comments OUT. A pin for "no clock in this code" that reads the prose explaining why there is no
// clock is the #115b failure exactly, in reverse. Line-based and only sound because the input is
// already CRLF-normalised - which the self-test below proves, on both endings.
function codeOf (text) {
  return text.replace(/\r\n/g, '\n').split('\n')
    .map(l => { const i = l.search(/(^|[^:])\/\//); return i < 0 ? l : l.slice(0, l.indexOf('//', i)) })
    .join('\n')
}

t('(#117 pin) SELF-TEST: the region extractor works on LF *and* CRLF, and catches a mutation', () => {
  const lf = 'function f (a) {\n  return 1 // x\n}\ntail'
  const crlf = lf.replace(/\n/g, '\r\n')
  const want = 'function f (a) {\n  return 1 // x\n}'
  assert.strictEqual(bodyOf(lf, 'function f (a) {'), want, 'LF')
  assert.strictEqual(bodyOf(crlf.replace(/\r\n/g, '\n'), 'function f (a) {'), want, 'CRLF normalised')
  // MUTATION: a re-added flag read inside the body MUST be visible to the pin.
  const mutated = lf.replace('return 1', 'if (process.env.BOOTSTRAP_NEEDS_HOME !== \'0\') return null\n  return 1')
  assert(/process\.env\.BOOTSTRAP_NEEDS_HOME/.test(bodyOf(mutated, 'function f (a) {')), 'the pin would catch a re-added flag read')
  assert(!/process\.env\.BOOTSTRAP_NEEDS_HOME/.test(bodyOf(lf, 'function f (a) {')), 'and does not fire on the clean copy')
  // codeOf must ACTUALLY strip - on CRLF too. This is the exact no-op that burned two builders:
  // with a trailing \r left in place, `.` never reaches the line end and the comment survives.
  assert.strictEqual(codeOf('const a = 1 // Date.now()').trim(), 'const a = 1', 'LF comment survived the stripper')
  assert.strictEqual(codeOf('const a = 1 // Date.now()\r\nconst b = 2\r\n').split('\n')[0].trim(), 'const a = 1', 'CRLF comment survived the stripper')
  assert(!/Date\.now/.test(codeOf('x() // Date.now\r\n')), 'the stripper is a no-op on CRLF - the whole clock pin would be worthless')
  assert(/Date\.now/.test(codeOf('x(Date.now()) // fine\r\n')), 'the stripper ate real code')
  assert(/https:\/\/x/.test(codeOf('const u = "https://x" // c')), 'the stripper mangled a URL')
})

t('(#117 pin) the #103 homeless=>null return is DELETED from the tree, not merely bypassed', () => {
  // The flag read is gone from EVERY file - scheduler.js's included. Pinned on `process.env.X`
  // rather than the bare name so the tombstone comment that explains the deletion cannot satisfy
  // it (a pin that greps its own tombstone is not a pin).
  for (const f of ['scheduler.js', 'scheduler-core.js', 'survival-snapshot.js', 'index.js']) {
    assert(!/process\.env\.BOOTSTRAP_NEEDS_HOME/.test(srcOf(f)), f + ' still reads the deleted BOOTSTRAP_NEEDS_HOME flag')
  }
  const body = bodyOf(srcOf('scheduler.js'), 'function bootstrapNeed (snapshot) {')
  assert(!/BOOTSTRAP_NEEDS_HOME/.test(body), 'bootstrapNeed still mentions the deleted flag in its body')
  assert(!/homeReachable\s*&&\s*!\(s\.hutExists/.test(body), 'the homeless guard clause is still present')
})

t('(#117 pin) the verdict ORDER is in the source: food > spawn > armor > shelter > base', () => {
  const body = bodyOf(srcOf('scheduler.js'), 'function bootstrapNeed (snapshot) {')
  const at = re => { const m = re.exec(body); assert(m, 'not found in bootstrapNeed: ' + re); return m.index }
  const food = at(/return 'food'/)
  const spawn = at(/return 'spawn'/)
  const armor = at(/return 'armor'/)
  const shelter = at(/return 'shelter'/)
  const base = at(/return 'base'/)
  assert(food < spawn, 'the food crisis must outrank the spawn anchor')
  assert(spawn < armor, 'a fed bot beds BEFORE it armors - this is the whole slice')
  assert(armor < shelter, 'shelter ranks just after armor')
  assert(shelter < base, 'a lit base is the last of the home rungs')
})

t('(#117 pin) no time-based hold anywhere in the new decision path', () => {
  // memory: no-blanket-time-holds, ABSOLUTE. Neither the verdict nor its gate may consult a clock.
  const CLOCK = /Date\.now|setTimeout|Date\.parse|performance\.now|\w+Until\b|\w*[Cc]ooldown\w*|_MS\b/
  for (const sig of ['function bootstrapNeed (snapshot) {', 'function spawnBootstrapDue (s) {']) {
    const code = codeOf(bodyOf(srcOf('scheduler.js'), sig))
    assert(!CLOCK.test(code), sig + ' consults a clock - the tier is condition-gated ONLY')
  }
  // MUTATION-VERIFY the pin itself: a hold sneaked into either body must be caught.
  const poisoned = codeOf(bodyOf(srcOf('scheduler.js'), 'function spawnBootstrapDue (s) {')) + '\nif (Date.now() < spawnCooldownUntil) return false\n'
  assert(CLOCK.test(poisoned), 'the clock pin does not actually detect a clock')
})

// ---- 5. THE PRODUCER RUNS WITH NO BUILD JOB ------------------------------------------------
// The claim under test is the reason the slice exists: on 2026-07-19 the ONLY route to a bed was
// step ~5 of an 11-step castle build. maintenancePass must now reach both producers on its own.

const provision = require('./provision.js')

function fakeBot () {
  return {
    entity: { position: { x: 0, y: 64, z: 0 }, height: 1.62 },
    health: 20, food: 20, version: '1.21.1', entities: {}, time: { timeOfDay: 1000 },
    inventory: { items: () => [], emptySlotCount: () => 36 },
    blockAt: () => null, on () {}, removeListener () {}
  }
}

// Drive maintenancePass for exactly one step: stub the producer, then make the very next
// between() report a survival need so the pass bails honestly instead of running the whole chore
// chain against a fake world.
async function runOnePass (bootstrap) {
  const realSpawn = provRecovery.ensureSpawnBed
  const realShelter = provision.ensureHomeShelter
  const realNeed = provision.survivalNeed
  const realState = provision.schedulerState
  const calls = []
  let done = false
  provRecovery.ensureSpawnBed = async () => { calls.push('ensureSpawnBed'); done = true; return { ok: true, how: 'acquired', why: 'test' } }
  provision.ensureHomeShelter = async () => { calls.push('ensureHomeShelter'); done = true; return { ok: true, how: 'repaired', why: 'test' } }
  provision.survivalNeed = () => (done ? { need: 'test-bail' } : null)
  provision.schedulerState = async () => ({ homeReachable: false, armorPieces: 4, tools: {}, packFoodPts: 0 })
  try {
    const r = await provMaintain.maintenancePass(fakeBot(), { bootstrap, say: () => {} })
    return { calls, steps: (r && r.steps) || [] }
  } finally {
    provRecovery.ensureSpawnBed = realSpawn; provision.ensureHomeShelter = realShelter
    provision.survivalNeed = realNeed; provision.schedulerState = realState
  }
}

async function main () {
  await t("(#117) maintenancePass establishes the SPAWN ANCHOR with no build job running", async () => {
    const { calls, steps } = await runOnePass('spawn')
    assert(calls.includes('ensureSpawnBed'), 'bootstrap "spawn" never reached ensureSpawnBed (calls: ' + calls.join(',') + ')')
    assert(!calls.includes('ensureHomeShelter'), 'the spawn verdict must not run the shelter producer too (single-goal)')
    assert(steps.some(x => /^spawn\(/.test(x)), 'the pass did not report the step it ran: ' + JSON.stringify(steps))
  })

  await t('(#117) maintenancePass repairs the SAFEHOUSE with no build job running', async () => {
    const { calls, steps } = await runOnePass('shelter')
    assert(calls.includes('ensureHomeShelter'), 'bootstrap "shelter" never reached ensureHomeShelter (calls: ' + calls.join(',') + ')')
    assert(!calls.includes('ensureSpawnBed'), 'the shelter verdict must not run the spawn producer too (single-goal)')
    assert(steps.some(x => /^shelter\(/.test(x)), 'the pass did not report the step it ran: ' + JSON.stringify(steps))
  })

  await t('(#117) a pass dispatched for anything ELSE runs neither home producer', async () => {
    const { calls } = await runOnePass(null)
    assert.deepStrictEqual(calls, [], 'the home producers fired without a home verdict: ' + calls.join(','))
  })

  await t("(#117) the 'shelter' producer refuses to invent a hut it has no implementation for", async () => {
    // ensureHomeShelter never sites or raises a FIRST hut - that has exactly one implementation and
    // it is the build's camp step (§8.2). With nothing on the books it says so; it does not guess.
    const mem = worldMemory.loadWorldMem(); if (mem.infra) delete mem.infra.hut
    const r = await provision.ensureHomeShelter(fakeBot(), {})
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.how, 'no-hut', 'expected an honest no-hut verdict, got ' + JSON.stringify(r))
  })

  for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k] }
  try { fs.unlinkSync(MEMFILE) } catch {}
  if (failures) { console.log('\n' + failures + ' home-first test(s) FAILED'); process.exit(1) }
  console.log('\nall #117 HOME_IS_A_NEED tests passed')
}

main()
