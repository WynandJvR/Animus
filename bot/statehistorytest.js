'use strict'
// OFFLINE unit test for the state-history helper (bot/loghistory.js) - no bot, no
// server, no pathfinder. Proves the two pieces index.js relies on: the PURE snapshot
// -> compact-line mapper (field selection + best-effort null-safety), and the size
// rotation (append, cross-5MB rename to ONE .old generation, readSince spanning both).
// Run:  cd bot && node statehistorytest.js

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const lh = require('./loghistory.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)) }
}

// ---- compactSample: field mapping from a realistic /state snapshot -----------------
t('compactSample maps a full snapshot to the flat line', () => {
  const snap = {
    health: 18, food: 7, pos: { x: 477.4, y: 67, z: 116.2 },
    activity: { name: 'gather', detail: 'oak_log', forSec: 42 },
    checklist: { step: 'craft wooden_hoe', n: 3, of: 6 },
    stuck: { forSec: 12 },
    threat: { type: 'zombie', dist: 4.2, flee: false },
    moving: true, biome: 'plains', isDay: false,
    died: { x: 1, y: 2, z: 3, graves: 2 },
    lastResult: { action: 'gather', ok: true },
    // S4 survival-signature inputs (mapped from commands.state fields)
    wearing: { head: 'iron_helmet', torso: 'iron_chestplate', legs: null, feet: 'iron_boots' },
    inventory: ['bread x5', 'cobblestone x32', 'cooked_beef x2', 'rotten_flesh x9'],
    oxygen: 12,
    hazards: { inWater: true, underground: false, onGround: false, inLava: false, onFire: true, drowning: true },
    goal: 'GoalNearXZ'
  }
  const o = lh.compactSample(snap, 1000)
  assert.strictEqual(o.t, 1000)
  assert.strictEqual(o.hp, 18)
  assert.strictEqual(o.food, 7)
  assert.deepStrictEqual(o.pos, { x: 477.4, y: 67, z: 116.2 })
  assert.strictEqual(o.activity, 'gather')
  assert.strictEqual(o.job, 'craft wooden_hoe')
  assert.strictEqual(o.blockedOn, 'stuck 12s')  // stuck wins over lastResult
  assert.strictEqual(o.threat, 'zombie')
  assert.strictEqual(o.moving, true)
  assert.strictEqual(o.graves, 2)
  assert.strictEqual(o.biome, 'plains')
  assert.strictEqual(o.isDay, false)
  // S4 new fields
  assert.strictEqual(o.armor, 3, '3 of 4 armor slots worn (legs null)')
  assert.strictEqual(o.packFood, 7, 'bread x5 + cooked_beef x2 = 7; cobblestone not food, rotten_flesh excluded')
  assert.strictEqual(o.oxy, 12)
  assert.strictEqual(o.inWater, true)
  assert.strictEqual(o.underground, false)
  // NAV P0 fields
  assert.strictEqual(o.onGround, false)
  assert.strictEqual(o.inLava, false)
  assert.strictEqual(o.onFire, true)
  assert.strictEqual(o.drowning, true)
  assert.strictEqual(o.goal, 'GoalNearXZ')
  // backward-compat: every PRE-EXISTING field is byte-identical (the S4 diff is additions only)
  assert.deepStrictEqual(
    { t: o.t, hp: o.hp, food: o.food, pos: o.pos, activity: o.activity, job: o.job, blockedOn: o.blockedOn, threat: o.threat, moving: o.moving, graves: o.graves, biome: o.biome, isDay: o.isDay },
    { t: 1000, hp: 18, food: 7, pos: { x: 477.4, y: 67, z: 116.2 }, activity: 'gather', job: 'craft wooden_hoe', blockedOn: 'stuck 12s', threat: 'zombie', moving: true, graves: 2, biome: 'plains', isDay: false },
    'pre-existing fields unchanged'
  )
})

t('compactSample: blockedOn falls back to a failed lastResult when not stuck', () => {
  const o = lh.compactSample({ lastResult: { action: 'travel', ok: false } }, 5)
  assert.strictEqual(o.blockedOn, 'failed:travel')
})

t('compactSample: null/empty snapshot yields nulls, never throws', () => {
  const o = lh.compactSample(null, 7)
  assert.strictEqual(o.t, 7)
  assert.strictEqual(o.hp, null)
  assert.strictEqual(o.food, null)
  assert.strictEqual(o.pos, null)
  assert.strictEqual(o.activity, null)
  assert.strictEqual(o.job, null)
  assert.strictEqual(o.blockedOn, null)
  assert.strictEqual(o.threat, null)
  assert.strictEqual(o.moving, false)
  assert.strictEqual(o.graves, 0)   // no grave info -> 0, not null
  assert.strictEqual(o.biome, null)
  assert.strictEqual(o.isDay, null)
  // S4 new fields: all null on an empty snapshot
  assert.strictEqual(o.armor, null)
  assert.strictEqual(o.packFood, null)
  assert.strictEqual(o.oxy, null)
  assert.strictEqual(o.inWater, null)
  assert.strictEqual(o.underground, null)
})

t('compactSample: NaN/undefined numerics coerce to null (json-safe)', () => {
  const o = lh.compactSample({ health: NaN, food: undefined }, 1)
  assert.strictEqual(o.hp, null)
  assert.strictEqual(o.food, null)
  // must serialize cleanly (NaN would have become null anyway, but prove no throw)
  assert.strictEqual(typeof JSON.stringify(o), 'string')
})

// ---- shouldRotate: pure size threshold ---------------------------------------------
t('shouldRotate compares byte size to cap', () => {
  assert.strictEqual(lh.shouldRotate(100, 200), false)
  assert.strictEqual(lh.shouldRotate(200, 200), false) // strictly greater
  assert.strictEqual(lh.shouldRotate(201, 200), true)
  assert.strictEqual(lh.shouldRotate('nope', 200), false)
})

// ---- appendSample + rotation + readSince round-trip (real tmp files) ---------------
t('appendSample writes lines, rotates at cap to one .old, readSince spans both', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statehist-'))
  const file = path.join(dir, 'state-history.jsonl')
  const cap = 300 // tiny cap so a few lines trip rotation
  try {
    // write enough lines to exceed the cap at least once
    for (let i = 0; i < 40; i++) {
      assert.strictEqual(lh.appendSample({ t: i, hp: 20, pos: { x: i, y: 64, z: 0 } }, { file, cap }), true)
    }
    // rotation must have happened -> a .old exists and the live file is under/around cap
    assert.ok(fs.existsSync(file + '.old'), '.old generation created')
    assert.ok(fs.statSync(file).size <= cap + 200, 'live file reset near/under cap after rotation')

    // readSince spans .old + live, chronological, filtered by t
    const all = lh.readSince(0, { file })
    assert.ok(all.length >= 1, 'reads back samples across both files')
    assert.strictEqual(all[all.length - 1].t, 39, 'newest sample last')
    const recent = lh.readSince(35, { file })
    assert.deepStrictEqual(recent.map(o => o.t), [35, 36, 37, 38, 39], 'since-filter works across rotation boundary')

    // only ONE generation is kept (no .old.old)
    assert.ok(!fs.existsSync(file + '.old.old'), 'only one rotated generation kept')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

t('readSince returns [] for a missing file (no throw)', () => {
  assert.deepStrictEqual(lh.readSince(0, { file: path.join(os.tmpdir(), 'nope-' + Date.now() + '.jsonl') }), [])
})

t('appendSample tolerates a bad target path without throwing (returns false)', () => {
  // an existing FILE used as the parent dir path forces both write attempts to fail
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statehist2-'))
  try {
    const blocker = path.join(dir, 'afile')
    fs.writeFileSync(blocker, 'x')
    const bad = path.join(blocker, 'sub', 'state.jsonl') // parent is a file -> mkdir + append fail
    assert.strictEqual(lh.appendSample({ t: 1 }, { file: bad }), false)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

console.log(failures ? ('\n' + failures + ' FAILED') : '\nALL PASS')
process.exit(failures ? 1 : 0)
