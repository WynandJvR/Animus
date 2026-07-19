'use strict'
// OFFLINE unit test for #67 SECURE_BASE - the three PURE spawn-proofing helpers in
// hut-model.js, plus the flag-gated maintenancePass admission they feed. No bot / pathfinder
// / world-mem writes. Run:  cd bot && node securebasetest.js
//
// (a) baseTorchAnchors(hut, {radius, spacing}) -> the lattice columns to light: deterministic,
//     circular, spaced, and NEVER inside the 6x6 hut footprint.
// (b) secureBaseRemaining(anchors, torched, {coverRadius}) -> the anchors still owed a torch;
//     each anchor needs its OWN torch (coverRadius < spacing) and a blown/forgotten torch
//     re-opens its anchor -> convergence + self-heal.
// (c) secureBaseGate({hp, fed, day, atHome, crisisActive}, {safeHp}) -> only fire in a calm
//     window. BOTH flag regimes are modelled by the exact STEP 9b call-site branch:
//       admit iff  SECURE_BASE!=='0'  &&  secureBaseGate(state, opts)

const assert = require('assert')
const H = require('./hut-model.js')
const p = require('./provision.js') // pin the facade wiring (the split can drift a re-export)

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

const HUT = { x: 100, y: 65, z: 200 } // 6x6 box spans x100..105, z200..205

// ---- (a) baseTorchAnchors -----------------------------------------------------------
t('baseTorchAnchors: deterministic + spaced + inside the radius, never in the hut box', () => {
  const anchors = H.baseTorchAnchors(HUT, { radius: 18, spacing: 6 })
  assert.ok(anchors.length > 0, 'produced anchors')
  // deterministic: same call, same set
  const again = H.baseTorchAnchors(HUT, { radius: 18, spacing: 6 })
  assert.deepStrictEqual(anchors, again, 'same inputs -> same anchors (convergence needs this)')
  const cx = HUT.x + 2.5; const cz = HUT.z + 2.5
  for (const a of anchors) {
    // within the circular radius (+ rounding slack)
    assert.ok(Math.hypot(a.x - cx, a.z - cz) <= 18 + 1.5, 'anchor within radius: ' + JSON.stringify(a))
    // NEVER inside the 6x6 hut footprint
    assert.ok(!H.inBox(HUT, a.x, a.z), 'anchor not inside the hut box: ' + JSON.stringify(a))
  }
  // spacing: nearest-neighbour on the lattice is ~spacing apart (a torch every ~6 blocks)
  const step = new Set(anchors.map(a => a.x)).size > 1
  assert.ok(step, 'anchors span multiple columns (a real grid, not a line)')
})

t('baseTorchAnchors: no hut -> [] (no crash)', () => {
  assert.deepStrictEqual(H.baseTorchAnchors(null, {}), [])
})

// ---- (b) secureBaseRemaining --------------------------------------------------------
t('secureBaseRemaining: nothing torched -> everything owed; each anchor needs its OWN torch', () => {
  const anchors = H.baseTorchAnchors(HUT, { radius: 18, spacing: 6 })
  const cover = 3 // = floor(spacing/2)
  assert.strictEqual(H.secureBaseRemaining(anchors, [], { coverRadius: cover }).length, anchors.length, 'all owed when none placed')
  // a torch AT one anchor covers only that anchor, not its ~6-away neighbour
  const one = anchors[0]
  const rem = H.secureBaseRemaining(anchors, [{ x: one.x, y: HUT.y, z: one.z }], { coverRadius: cover })
  assert.strictEqual(rem.length, anchors.length - 1, 'one torch clears exactly one anchor')
  assert.ok(!rem.some(a => a.x === one.x && a.z === one.z), 'the torched anchor is no longer owed')
})

t('secureBaseRemaining: full ring -> converged (empty); a blown torch re-opens its anchor', () => {
  const anchors = H.baseTorchAnchors(HUT, { radius: 18, spacing: 6 })
  const cover = 3
  const torched = anchors.map(a => ({ x: a.x, y: HUT.y, z: a.z }))
  assert.strictEqual(H.secureBaseRemaining(anchors, torched, { coverRadius: cover }).length, 0, 'fully lit ring -> nothing owed (converged)')
  // self-heal: drop one torch (as the executor does on a failed world re-read) -> its anchor re-opens
  const minusOne = torched.slice(1)
  const reopened = H.secureBaseRemaining(anchors, minusOne, { coverRadius: cover })
  assert.strictEqual(reopened.length, 1, 'a blown torch re-opens exactly one anchor')
  assert.strictEqual(reopened[0].x, anchors[0].x)
  assert.strictEqual(reopened[0].z, anchors[0].z)
})

// ---- (c) secureBaseGate + the flag-gated STEP 9b admission --------------------------
const SAFE = { hp: 16, fed: true, day: true, atHome: true, crisisActive: false }
// exact mirror of the STEP 9b admission: env flag AND the pure gate.
const wouldAdmit = (flagOn, state, opts) => flagOn && H.secureBaseGate(state, opts)

t('secureBaseGate: all guards satisfied -> fire', () => {
  assert.strictEqual(H.secureBaseGate(SAFE, { safeHp: 14 }), true)
})

t('secureBaseGate: any single guard false -> defer', () => {
  assert.strictEqual(H.secureBaseGate({ ...SAFE, day: false }, {}), false, 'night defers')
  assert.strictEqual(H.secureBaseGate({ ...SAFE, atHome: false }, {}), false, 'away defers')
  assert.strictEqual(H.secureBaseGate({ ...SAFE, fed: false }, {}), false, 'hungry defers')
  assert.strictEqual(H.secureBaseGate({ ...SAFE, crisisActive: true }, {}), false, 'active crisis defers (yield to survival)')
  assert.strictEqual(H.secureBaseGate({ ...SAFE, hp: 10 }, { safeHp: 14 }), false, 'low hp defers')
  assert.strictEqual(H.secureBaseGate({ ...SAFE, hp: undefined }, {}), false, 'unknown hp defers')
})

t('BOTH regimes: flag OFF never admits (byte-for-byte); flag ON admits only in a calm window', () => {
  // flag OFF (=0): the step never runs regardless of how calm it is.
  assert.strictEqual(wouldAdmit(false, SAFE, { safeHp: 14 }), false, 'SECURE_BASE=0 -> never admit')
  assert.strictEqual(wouldAdmit(false, { ...SAFE, day: false }, {}), false)
  // flag ON: admit iff the gate passes.
  assert.strictEqual(wouldAdmit(true, SAFE, { safeHp: 14 }), true, 'calm window -> admit')
  assert.strictEqual(wouldAdmit(true, { ...SAFE, crisisActive: true }, {}), false, 'crisis -> defer even with the flag on')
})

// ---- (d) #89 sealDescentsGate - same calm-window shape, safeHp defaults to 12 --------
t('sealDescentsGate: all guards satisfied -> fire; default safeHp is 12 (NOT 14)', () => {
  assert.strictEqual(H.sealDescentsGate(SAFE, { safeHp: 12 }), true)
  // the whole point of the lower default: hp 12 fires WITHOUT an explicit opt (secureBase would defer)
  assert.strictEqual(H.sealDescentsGate({ ...SAFE, hp: 12 }), true, 'hp 12 admits at the 12 default')
  assert.strictEqual(H.sealDescentsGate({ ...SAFE, hp: 12 }, { safeHp: 14 }), false, 'the 14 override still defers hp 12')
  assert.strictEqual(H.secureBaseGate({ ...SAFE, hp: 12 }), false, 'secureBase (default 14) would NOT fire at hp 12 - the divergence this step needs')
})

t('sealDescentsGate: any single guard false -> defer (crisis/night/away/hungry/low-hp)', () => {
  assert.strictEqual(H.sealDescentsGate({ ...SAFE, day: false }, {}), false, 'night defers')
  assert.strictEqual(H.sealDescentsGate({ ...SAFE, atHome: false }, {}), false, 'away defers')
  assert.strictEqual(H.sealDescentsGate({ ...SAFE, fed: false }, {}), false, 'hungry defers')
  assert.strictEqual(H.sealDescentsGate({ ...SAFE, crisisActive: true }, {}), false, 'active crisis defers (yield to survival)')
  assert.strictEqual(H.sealDescentsGate({ ...SAFE, hp: 8 }, {}), false, 'hp below the 12 floor defers')
  assert.strictEqual(H.sealDescentsGate({ ...SAFE, hp: undefined }, {}), false, 'unknown hp defers')
})

t('BOTH regimes: SEAL_HOME_DESCENTS=0 never admits; ON admits only in a calm window', () => {
  const wouldSeal = (flagOn, state, opts) => flagOn && H.sealDescentsGate(state, opts)
  assert.strictEqual(wouldSeal(false, SAFE, { safeHp: 12 }), false, 'SEAL_HOME_DESCENTS=0 -> never admit')
  assert.strictEqual(wouldSeal(false, { ...SAFE, day: false }, {}), false)
  assert.strictEqual(wouldSeal(true, SAFE, { safeHp: 12 }), true, 'calm window -> admit')
  assert.strictEqual(wouldSeal(true, { ...SAFE, crisisActive: true }, {}), false, 'crisis -> defer even with the flag on')
})

// ---- facade wiring (the split can silently drop a re-export) -------------------------
t('facade: provision.js re-exports secureBase + secureBaseGate, and the gate IS the model fn', () => {
  assert.strictEqual(typeof p.secureBase, 'function', 'secureBase re-exported')
  assert.strictEqual(typeof p.secureBaseGate, 'function', 'secureBaseGate re-exported')
  assert.strictEqual(p.secureBaseGate, H.secureBaseGate, 're-export IS the model fn, not a drifting copy')
  // the pure gate behaves identically through the facade
  assert.strictEqual(p.secureBaseGate(SAFE, { safeHp: 14 }), true)
})

t('facade: provision.js re-exports sealHomeDescents + sealDescentsGate (#89), gate IS the model fn', () => {
  assert.strictEqual(typeof p.sealHomeDescents, 'function', 'sealHomeDescents re-exported')
  assert.strictEqual(typeof p.sealDescentsGate, 'function', 'sealDescentsGate re-exported')
  assert.strictEqual(p.sealDescentsGate, H.sealDescentsGate, 're-export IS the model fn, not a drifting copy')
  assert.strictEqual(p.sealDescentsGate(SAFE, { safeHp: 12 }), true)
})

console.log(failures ? ('\n' + failures + ' FAILED') : '\nALL PASS')
process.exit(failures ? 1 : 0)
