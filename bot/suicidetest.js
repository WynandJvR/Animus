'use strict'
// OFFLINE unit test for the PURE bits of #63 SUICIDE_DIES (make the suicide-reset actually die):
//   - provision.pickOpenSkyCell  (§A open-sky-cell picker)
//   - navigate.drownReflexSkips + setDeliberateDrown/isDeliberateDrown  (§B.1 drown latch/guard)
// No bot, no I/O. Run:  cd bot && node suicidetest.js
//
// Covers BOTH flag regimes: the reflex guard is byte-for-byte (escapes) when no deliberate drown is
// in progress, and skips (stays submerged) only while the latch is set - and the picker returns the
// first genuinely open-sky, stand-able candidate, or null.

const assert = require('assert')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

async function ta (name, fn) { try { await fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

let P, N, R
try { P = require('./provision.js') } catch (e) { console.log('FAIL  provision.js not loadable offline: ' + e.message); process.exit(1) }
try { N = require('./navigate.js') } catch (e) { console.log('FAIL  navigate.js not loadable offline: ' + e.message); process.exit(1) }
try { R = require('./provision-recovery.js') } catch (e) { console.log('FAIL  provision-recovery.js not loadable offline: ' + e.message); process.exit(1) }

// ---- §A: pickOpenSkyCell ---------------------------------------------------------------
const pick = P.pickOpenSkyCell

t('picks the FIRST open-sky stand-able cell', () => {
  const cells = [
    { x: 1, solidCeiling: true, standable: true },   // roofed
    { x: 2, solidCeiling: false, standable: false },  // open but not standable
    { x: 3, solidCeiling: false, standable: true },   // <- the winner
    { x: 4, solidCeiling: false, standable: true }
  ]
  const r = pick(cells)
  assert.ok(r && r.x === 3, 'returns the first genuinely open + standable cell')
})

t('returns null when EVERY cell is roofed or un-standable', () => {
  assert.strictEqual(pick([
    { solidCeiling: true, standable: true },
    { solidCeiling: false, standable: false },
    { solidCeiling: true, standable: false }
  ]), null, 'no open+standable -> null (caller falls through to §B)')
})

t('a roofed-but-standable cell is NOT open sky (the live bug: under the hut roof)', () => {
  assert.strictEqual(pick([{ solidCeiling: true, standable: true }]), null, 'solid ceiling disqualifies even if standable')
})

t('an open-air cell you cannot stand in is NOT a fall spot', () => {
  assert.strictEqual(pick([{ solidCeiling: false, standable: false }]), null, 'must be standable to pillar from')
})

t('empty / non-array input -> null (never throws)', () => {
  assert.strictEqual(pick([]), null, 'empty list')
  assert.strictEqual(pick(null), null, 'null')
  assert.strictEqual(pick(undefined), null, 'undefined')
})

// ---- §B.1: drown reflex guard ---------------------------------------------------------
const skips = N.drownReflexSkips

t('FLAG-OFF regime: no deliberate drown -> reflex ESCAPES (byte-for-byte today)', () => {
  assert.strictEqual(skips(false), false, 'deliberate=false -> do NOT skip (escape as today)')
  assert.strictEqual(skips(undefined), false, 'unset -> escape')
  assert.strictEqual(skips(0), false, 'falsy -> escape')
})

t('FLAG-ON regime: a deliberate drown is in progress -> reflex SKIPS (stays submerged)', () => {
  assert.strictEqual(skips(true), true, 'deliberate=true -> skip escaping, let it drown')
})

t('setDeliberateDrown / isDeliberateDrown round-trips and CLEARS (normal escape restored)', () => {
  assert.strictEqual(N.isDeliberateDrown(), false, 'latch OFF by default')
  N.setDeliberateDrown(true)
  assert.strictEqual(N.isDeliberateDrown(), true, 'armed')
  assert.strictEqual(skips(N.isDeliberateDrown()), true, 'while armed the reflex skips')
  N.setDeliberateDrown(false)
  assert.strictEqual(N.isDeliberateDrown(), false, 'cleared (the finally-clear that guarantees accidental water still escapes)')
  assert.strictEqual(skips(N.isDeliberateDrown()), false, 'after clear the reflex escapes again')
})

t('setDeliberateDrown coerces to a real boolean (no truthy leak)', () => {
  N.setDeliberateDrown(1)
  assert.strictEqual(N.isDeliberateDrown(), true, 'truthy -> true')
  N.setDeliberateDrown(0)
  assert.strictEqual(N.isDeliberateDrown(), false, 'falsy -> false')
})

// ---- #76 SUICIDE_PILLAR_WORKS -----------------------------------------------------------
t('SUICIDE_PILLAR_WORKS flag const tracks process.env (default ON, =0 -> off)', () => {
  const expected = process.env.SUICIDE_PILLAR_WORKS !== '0'
  assert.strictEqual(R.SUICIDE_PILLAR_WORKS, expected, 'const captured from env at require time')
})

t('#76 §B: pillarUpTo\'s open-sky break is guarded by opts.ignoreOpenSkyBreak (default unset -> unchanged)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'provision-mining.js'), 'utf8')
  // the break line must be gated on !opts.ignoreOpenSkyBreak so the default (all existing callers,
  // opt unset) still breaks at open sky exactly as before, and ONLY the flagged suicide caller skips it.
  assert.ok(/if\s*\(\s*!opts\.ignoreOpenSkyBreak\s*&&\s*Math\.floor\(bot\.entity\.position\.y\)\s*>\s*startY\s*&&\s*!hasSolidCeiling/.test(src),
    ':230 open-sky break is additively guarded by !opts.ignoreOpenSkyBreak')
})

// ==== THE LAST RESORT MUST NOT BE VETOED BY THE THING TRAPPING IT (live 2026-08-01) =========
// A single cobblestone at HEAD height one step outside the door (190,69,-106) sealed the bot in.
// Every exit went with it: no food (bare farm, empty pantry), no way out to fix that, and no way
// to die and reset - because the pit fallback ABORTS when it cannot step clear of the hut:
//   deadlock-reset: could not step clear of the hut for a pit - ABORTING this fallback
//   deadlock-reset: fallback deaths could not kill - ABORTING to hold
// ...at hp 1, indefinitely. Never digging your own doorstep is right in general; letting that
// guard defeat the LAST RESORT is not. The floor is repairable (repairHutStructure re-places
// missing plank cells); the deadlock is not.
t('THE SEALED HUT: when trapped, the pit may be dug where it stands', () => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
  const i = src.indexOf('async function suicideByPitDrop')
  assert(i > 0, 'the pit fallback still exists')
  const fn = src.slice(i, src.indexOf('async function deadlockFallbackDeath')) // whole function - never a guessed byte window
  assert(!/if \(insideOwnStructure\(bot\) \|\| onHutApron\(bot\)\) \{ dbg\('deadlock-reset: could not step clear/.test(fn),
    'the unconditional abort is back - that is the sealed-hut deadlock')
  assert(/const trapped = insideOwnStructure\(bot\) \|\| onHutApron\(bot\)/.test(fn), 'it must still DETECT being trapped')

  // ONE predicate. The first fix lifted only the GEOMETRIC guard (ownHutAt) and the MATERIAL one
  // (canBreakNaturally -> STRUCTURE_RE matches oak_planks) still vetoed all four hut-floor columns:
  //   deadlock-reset: no diggable pit column beside the hut - ABORTING this fallback
  // Two copies of "do not dig the hut" is how a half-lifted concession looks. There must be one.
  assert(/const pitBlocked = \(cell, b, allowOwnHut\) =>/.test(fn), 'the exclusions live in ONE predicate')
  assert(/if \(ownHutAt\(cell\)\) return allowOwnHut \? null : 'own-hut'/.test(fn),
    'own-hut must be the ONE exclusion the concession lifts - geometric and material together')
  assert(/if \(pitBlocked\(v, b, spendFloor\)\) return false/.test(fn),
    'the DIG consults the same predicate - not a second hand-written copy of the list')
  assert(!/if \(\/water\|lava\/\.test\(b\.name\) \|\| !canBreakNaturally\(b\)\) return false/.test(fn),
    'the old duplicated guard inside digAt is gone (that was the second copy)')

  // ...and every other exclusion stays unconditional, trapped or not
  assert(/if \(scaffold\.onFarmFootprint\(cell\) \|\| farmFootprintHas\(cell\)\) return 'farm'/.test(fn), 'the farm footprint is never dug')
  assert(/if \(\/water\|lava\/\.test\(b\.name\)\) return 'fluid'/.test(fn), 'the water/lava guard stays')
  assert(/if \(!canBreakNaturally\(b\)\) return 'build'/.test(fn), "someone else's build is never dug")

  // cheapest sufficient escape: a column that costs the hut nothing is always preferred
  assert(/let dir = scan\(false\)[\s\S]*const spendFloor = !dir && trapped[\s\S]*dir = scan\(true\)/.test(fn),
    'it must try the free columns FIRST and spend a floor cell only when trapped with no alternative')
})

// The reset STASHES the pack before it dies, so by the time the pit is dug there is no filler.
// Stage B used to descend one block to regain reach and then pillar back to the rim - with an
// empty pack that pillar is a no-op, and the bot ends up BELOW the rim it must step off:
//   deadlock-reset: pit only 0b deep (need 4) or not at rim - ABORTING this fallback
t('THE SEALED HUT: the descent is taken only when it is needed AND reversible', () => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
  const i = src.indexOf('async function suicideByPitDrop')
  const fn = src.slice(i, src.indexOf('async function deadlockFallbackDeath'))
  const gate = fn.indexOf('if (openDrop() < lethalMin')
  const descend = fn.indexOf('await stepInto(bot, under')
  assert(gate > 0 && descend > gate, 'the descent must sit INSIDE the needed-and-reversible gate')
  assert(/const canReturn = await ensurePillarFiller\(bot/.test(fn), 'it must secure the filler that buys the climb back BEFORE descending')
  assert(/if \(!canReturn\) dbg\([\s\S]{0,120}not descending/.test(fn), 'no filler -> it must NOT descend (stay at the rim) rather than descend and strand itself')
  assert(fn.indexOf('const canReturn') < descend, 'the check must precede the step, not follow it')
  // lethality is still read from the WORLD, never inferred from what we believe we dug
  assert(/const openDrop = \(\) => \{[\s\S]{0,200}bot\.blockAt/.test(fn), 'the drop is measured by re-reading the column')
  assert(/const drop = openDrop\(\)/.test(fn), 'the final verdict re-measures rather than reusing a stale count')
})

// stepOffApron walks a trapped bot into its own walls for the full 60s. The deadline was stamped
// BEFORE it, so every `Date.now() < deadline` guard downstream was already false: stage A never
// ran, the descent gate never ran, and the abort blamed depth for a pit that was never dug.
//   15:35:21 remembered water at 184,-73 is only 1 deep - not drownable
//   15:36:24 TRAPPED under my own roof ...            <- 63s inside stepOffApron
//   15:36:24 pit only 0b deep (need 4) or not at rim  <- 2ms later, having dug nothing
t('THE SEALED HUT: setup cannot spend the dig budget, and running out of time says so', () => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
  const i = src.indexOf('async function suicideByPitDrop')
  const fn = src.slice(i, src.indexOf('async function deadlockFallbackDeath'))

  // the dig's clock starts AFTER the walking, so setup can never charge its time to the work
  const step = fn.indexOf('await stepOffApron(bot')
  const dl = fn.indexOf('const deadline = Date.now()')
  assert(step > 0 && dl > step, 'the dig deadline must be stamped AFTER stepOffApron, not before it')
  assert(/setupDeadline/.test(fn) && fn.indexOf('const setupDeadline') < step, 'the step-off gets its own bounded slice')
  assert(/stepOffApron\(bot, \{ isStopped: \(\) => isStopped\(\) \|\| Date\.now\(\) > setupDeadline/.test(fn),
    'that slice must actually be enforced on stepOffApron, not merely declared')

  // an expired budget is a named outcome, not a loop condition that silently skips the work
  assert(/const outOfTime = \(\) => Date\.now\(\) >= deadline/.test(fn), 'time exhaustion is a named predicate')
  assert(!/for \(let dy = -1; dy >= -3 && Date\.now\(\) < deadline; dy--\)/.test(fn),
    'stage A must not hide exhaustion in its loop condition - that is how "0b deep" got reported for a pit never dug')
  assert(/out of time in pit stage A/.test(fn), 'stage A reports running out of time as itself')
  assert(/out of time before the deepening descent/.test(fn), 'the descent gate reports running out of time as itself')

  // and the two terminal failures stop sharing one message
  assert(!/if \(drop < lethalMin \|\| Math\.floor\(bot\.entity\.position\.y\) < feet\.y\)/.test(fn),
    'depth and rim must not be reported by a single ambiguous message')
  assert(/pit only ' \+ drop \+ 'b deep/.test(fn) && /below the rim at y/.test(fn), 'each terminal failure names itself')
})

// ==== THE GIVE-UP COUNTER COUNTED ATTEMPTS, NOT RESETS (live 2026-08-01) ===================
// `at` (anti-loop gap) and `count` (give-up cap) were stamped together BEFORE the attempt, so
// every ABORT was recorded as a completed reset. Five aborts later the persisted state read
// {"at":...,"count":5} against DEADLOCK_MAX_NOFOOD=5 and the last resort had permanently disabled
// itself over five deaths that never happened - the bot had not died once.
t('THE SEALED HUT: only a death counts as a reset; an attempt only stamps the cooldown', () => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')

  // the two jobs are separate functions: one touches `at` only, the other bumps `count`
  const att = src.slice(src.indexOf('function noteDeadlockAttempt'), src.indexOf('function noteDeadlockReset'))
  assert(att.length > 0, 'noteDeadlockAttempt exists')
  assert(/d\.at = Date\.now\(\)/.test(att), 'the attempt stamps the anti-loop gap')
  assert(!/d\.count/.test(att), 'the attempt must NOT touch the give-up count - that is what made aborts look like resets')
  const res = src.slice(src.indexOf('function noteDeadlockReset'), src.indexOf('function migrateDeadlockCounter'))
  assert(/d\.count = \(d\.count \|\| 0\) \+ 1/.test(res), 'only the completed-reset path bumps the count')

  // every call site: attempt before, reset only when the suicide actually returned true
  const sites = src.split('deadlockSuicideReset(bot')
  assert(sites.length === 3, 'both suicide call sites are covered by this pin (update it if a third appears)')
  for (const before of sites.slice(0, -1)) {
    assert(/noteDeadlockAttempt\(\)[\s\S]{0,400}$/.test(before), 'the cooldown is stamped before the attempt')
    assert(!/noteDeadlockReset\(\)[\s\S]{0,400}$/.test(before), 'the count must NOT be bumped before the attempt')
  }
  for (const after of sites.slice(1)) {
    assert(/if \(ok\) noteDeadlockReset\(\)/.test(after.slice(0, 400)), 'the count is bumped only when the reset actually died')
  }

  // a count written under the old meaning is phantom and must be migrated, not left to disable the bot
  assert(/if \(!d \|\| d\.counts === 'deaths'\) return/.test(src), 'the migration is idempotent and marks the new meaning')
  assert(/deadlockResetState \(\) \{ migrateDeadlockCounter\(\)/.test(src), 'every read migrates first, so a stale count cannot keep vetoing')
  const R2 = require('./provision-recovery.js')
  const st = R2.deadlockResetState()
  assert.strictEqual(st.counts, 'deaths', 'reading the state stamps the new meaning')
  assert.strictEqual(st.count, 0, 'the five phantom resets are gone')
})

async function main () {
  // (a) ensurePillarFiller returns true IMMEDIATELY when the pack already has filler (stub bot).
  //     The stub has NO entity: if the early pickFiller short-circuit failed, the `!bot.entity`
  //     guard would return false and this test would catch it.
  await ta('#76 §A: ensurePillarFiller returns true immediately when pickFiller already finds filler', async () => {
    const botWithFiller = { inventory: { items: () => [{ name: 'dirt', count: 5 }] } }
    const got = await R.ensurePillarFiller(botWithFiller, { isStopped: () => false })
    assert.strictEqual(got, true, 'filler already present -> true without touching the world')
  })

  if (failures) { console.log('\n' + failures + ' FAILED'); process.exit(1) }
  console.log('\nALL PASS')
}
main()
