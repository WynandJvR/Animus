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
