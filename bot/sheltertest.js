'use strict'
// OFFLINE unit test for the pure shelter-siting logic (bot/shelter.js). No bot, no I/O.
// Run:  cd bot && node sheltertest.js

const assert = require('assert')
const S = require('./shelter.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('shelterDiggable: solid dry ground -> yes', () => {
  assert.strictEqual(S.shelterDiggable('dirt', 'stone', ['dirt', 'dirt', 'dirt', 'dirt']), true)
  assert.strictEqual(S.shelterDiggable('grass_block', 'dirt', ['stone', 'stone', 'stone', 'stone']), true)
})

t('shelterDiggable: the LIVE bug - water beside the shaft -> no (this is what looped)', () => {
  assert.strictEqual(S.shelterDiggable('dirt', 'stone', ['water', 'dirt', 'dirt', 'dirt']), false, 'aquifer beside the next cell floods the pit')
  assert.strictEqual(S.shelterDiggable('dirt', 'stone', ['dirt', 'seagrass', 'dirt', 'dirt']), false, 'waterlogged plant beside counts as water')
})

t('shelterDiggable: fluid at or under the dig -> no', () => {
  assert.strictEqual(S.shelterDiggable('water', 'dirt', []), false, 'digging into water')
  assert.strictEqual(S.shelterDiggable('lava', 'stone', []), false, 'digging into lava')
  assert.strictEqual(S.shelterDiggable('dirt', 'water', []), false, 'water one deeper floods')
  assert.strictEqual(S.shelterDiggable('dirt', 'lava', []), false, 'lava one deeper')
})

t('shelterDiggable: nothing to dig / undiggable -> no', () => {
  assert.strictEqual(S.shelterDiggable('air', 'dirt', []), false, 'already a hole')
  assert.strictEqual(S.shelterDiggable(null, 'dirt', []), false, 'unloaded/air')
  assert.strictEqual(S.shelterDiggable('bedrock', 'bedrock', []), false)
  assert.strictEqual(S.shelterDiggable('obsidian', 'stone', []), false)
})

t('shelterDiggable: void guard - thin shelf over a cave -> no (would fall in)', () => {
  // BOTH below2 and below3 airish = digging drops the bot >=2 blocks into an open cavern
  assert.strictEqual(S.shelterDiggable('dirt', 'air', ['dirt', 'dirt', 'dirt', 'dirt'], 'air'), false, 'air below2 + air below3 = cave under the shelf')
  assert.strictEqual(S.shelterDiggable('dirt', 'cave_air', [], 'cave_air'), false, 'cave_air counts as void')
  assert.strictEqual(S.shelterDiggable('dirt', 'air', [], null), false, 'air below2 + unloaded below3 = treat as void (conservative)')
})

t('shelterDiggable: air below2 over SOLID below3 stays allowed (legit 3-deep geometry)', () => {
  assert.strictEqual(S.shelterDiggable('dirt', 'air', ['dirt', 'dirt', 'dirt', 'dirt'], 'stone'), true, 'a 1-block air gap with solid floor beneath is fine')
  assert.strictEqual(S.shelterDiggable('grass_block', 'cave_air', [], 'deepslate'), true)
})

t('shelterDiggable: solid below2 - below3 irrelevant, still yes (non-regression)', () => {
  assert.strictEqual(S.shelterDiggable('dirt', 'stone', ['dirt', 'dirt', 'dirt', 'dirt'], 'air'), true, 'solid below2 supports the floor no matter what below3 is')
  assert.strictEqual(S.shelterDiggable('dirt', 'stone', ['dirt', 'dirt', 'dirt', 'dirt']), true, 'below3 defaulting undefined does not break the common case')
})

t('alcoveSafe: all faces solid -> yes; liquid/leaf/void face -> no', () => {
  assert.strictEqual(S.alcoveSafe(['stone', 'stone', 'dirt', 'stone', 'deepslate']), true, 'fully enclosed solid pocket')
  assert.strictEqual(S.alcoveSafe(['stone', 'water', 'dirt', 'stone', 'stone']), false, 'liquid face would flood the pocket')
  assert.strictEqual(S.alcoveSafe(['stone', 'lava', 'dirt', 'stone', 'stone']), false, 'lava face')
  assert.strictEqual(S.alcoveSafe(['stone', 'oak_leaves', 'dirt', 'stone', 'stone']), false, 'a leaf wall is not a real seal')
  assert.strictEqual(S.alcoveSafe(['stone', 'air', 'dirt', 'stone', 'stone']), false, 'air face = open hole')
  assert.strictEqual(S.alcoveSafe(['stone', null, 'dirt', 'stone', 'stone']), false, 'null/unloaded face -> not proven solid')
  assert.strictEqual(S.alcoveSafe([]), false, 'no faces = not safe')
})

t('feetCellDry: standable + dry vs water-adjacent', () => {
  assert.strictEqual(S.feetCellDry('air', 'air', ['dirt', 'dirt', 'dirt', 'dirt']), true)
  assert.strictEqual(S.feetCellDry('air', 'air', ['water', 'dirt', 'dirt', 'dirt']), false, 'water beside the standing cell -> not dry')
  assert.strictEqual(S.feetCellDry('water', 'air', []), false, 'standing in water')
  assert.strictEqual(S.feetCellDry('air', 'stone', []), false, 'no head clearance')
  assert.strictEqual(S.feetCellDry('dirt', 'air', []), false, 'feet blocked')
})

t('rankByDistance: nearest safe cell first (shortest relocate)', () => {
  const cells = [{ x: 10, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }]
  const ranked = S.rankByDistance(cells, { x: 0, z: 0 })
  assert.deepStrictEqual(ranked.map(c => c.x), [2, 5, 10])
  // pure - does not mutate the input
  assert.strictEqual(cells[0].x, 10)
})

// ---- fix #14: sleep-failure classifier + bed-hold policy (pure, shelter.js) ---------------
t('sleepFailKind: exact mineflayer bed.js strings map correctly', () => {
  // unusable - the bed can't be clicked/reached/used right now (bed.js:82,86,93,109,115,131 + waitUntilSleep:159)
  assert.strictEqual(S.sleepFailKind('cant click the bed'), 'unusable')
  // #77: 'too far' is a POSITION failure (retryable) - default flag ON classes it 'toofar';
  // with SLEEP_RETRY_TOOFAR=0 it falls back to 'unusable' exactly as before. Drive BOTH env
  // regimes explicitly here (not via ambient) so this passes whichever way the suite is run,
  // and restore the ambient value after.
  {
    const prev = process.env.SLEEP_RETRY_TOOFAR
    delete process.env.SLEEP_RETRY_TOOFAR // default (flag ON)
    assert.strictEqual(S.sleepFailKind('the bed is too far'), 'toofar')
    process.env.SLEEP_RETRY_TOOFAR = '0'  // flag OFF -> byte-for-byte today's mapping
    assert.strictEqual(S.sleepFailKind('the bed is too far'), 'unusable')
    if (prev === undefined) delete process.env.SLEEP_RETRY_TOOFAR; else process.env.SLEEP_RETRY_TOOFAR = prev
  }
  assert.strictEqual(S.sleepFailKind('the bed is occupied'), 'unusable')
  assert.strictEqual(S.sleepFailKind("there's only half bed"), 'unusable')
  assert.strictEqual(S.sleepFailKind('wrong block : not a bed block'), 'unusable')
  assert.strictEqual(S.sleepFailKind('bot is not sleeping'), 'unusable', 'waitUntilSleep 3s timeout')
  // monsters - vanilla's monster-box refusal (bed.js:143)
  assert.strictEqual(S.sleepFailKind('there are monsters nearby'), 'monsters')
  // transient - not a real bed problem; never hold (bed.js:69,82,84)
  assert.strictEqual(S.sleepFailKind("it's not night and it's not a thunderstorm"), 'transient')
  assert.strictEqual(S.sleepFailKind('already sleeping'), 'transient')
  assert.strictEqual(S.sleepFailKind('already awake'), 'transient')
})

t('sleepFailKind: unknown / empty defaults to unusable (a repeating unknown error is a loop)', () => {
  assert.strictEqual(S.sleepFailKind('some brand new mineflayer error'), 'unusable')
  assert.strictEqual(S.sleepFailKind(''), 'unusable')
  assert.strictEqual(S.sleepFailKind(null), 'unusable')
  assert.strictEqual(S.sleepFailKind(undefined), 'unusable')
})

t('bedHoldMs: policy table (transient=0, monsters=short, unusable=night)', () => {
  assert.strictEqual(S.bedHoldMs('transient'), 0, 'never hold a transient failure')
  assert.strictEqual(S.bedHoldMs('monsters'), S.BED_HOLD_MONSTER_MS)
  assert.strictEqual(S.bedHoldMs('unusable'), S.BED_HOLD_MS)
  assert.strictEqual(S.bedHoldMs('anything-else'), S.BED_HOLD_MS, 'unknown kind holds as unusable')
  assert.ok(S.BED_HOLD_MONSTER_MS < S.BED_HOLD_MS, 'monsters hold is shorter than unusable')
  assert.ok(S.BED_HOLD_MS > 0 && S.BED_HOLD_MONSTER_MS > 0 && S.BED_HOLD_FELLSHORT_MS > 0)
})

// ---- fix #30: SHELTER_AVOID_FARM - never bunker into our own wheat farm --------------------
t('farmConflict: within r of the anchor -> true, clear of it -> false', () => {
  const anchor = { x: 100, y: 64, z: 200 }
  assert.strictEqual(S.farmConflict(anchor, [], { x: 103, z: 200 }, 7), true, '3b from the anchor is inside the buffer')
  assert.strictEqual(S.farmConflict(anchor, [], { x: 120, z: 200 }, 7), false, '20b away is clear')
})

t('farmConflict: near a far-flung CELL even when the anchor is distant -> true', () => {
  const anchor = { x: 100, y: 64, z: 200 }
  const cells = [{ x: 140, y: 64, z: 240 }] // a strip cell well away from the anchor
  assert.strictEqual(S.farmConflict(anchor, cells, { x: 142, z: 241 }, 7), true, 'a pit beside a farm CELL floods it too')
  assert.strictEqual(S.farmConflict(anchor, cells, { x: 160, z: 260 }, 7), false, 'clear of both anchor and cells')
})

t('farmConflict: guards - no pos, r<=0, no farm -> false (never blocks)', () => {
  assert.strictEqual(S.farmConflict({ x: 0, z: 0 }, [], null, 7), false, 'no position')
  assert.strictEqual(S.farmConflict({ x: 0, z: 0 }, [], { x: 0, z: 0 }, 0), false, 'r<=0 never conflicts')
  assert.strictEqual(S.farmConflict(null, [], { x: 0, z: 0 }, 7), false, 'no farm -> no conflict')
})

// ---- fix #14: the now-injectable bed-hold state helpers (provision.js) --------------------
// markBedUnusable/bedHeld are pure w.r.t. their `now` arg (no world I/O), so table-test them
// here. WORLD_MEM_FILE is redirected to scratch so requiring provision.js never touches live
// world memory (rememberBed's clear path does a debounced, unref'd write).
process.env.WORLD_MEM_FILE = require('path').join(require('os').tmpdir(), 'sheltertest-worldmem.json')
process.env.SHELTER_BED_FALLBACK = '' // ensure the fix is ARMED for these cases (default-on)
const P = require('./provision.js')

t('bedHeld: mark then held within the window, expires after it', () => {
  const bed = { x: 417, y: 66, z: 89 }
  const t0 = 1000000
  P.markBedUnusable(bed, 480000, 'cant click the bed', t0)
  assert.strictEqual(P.bedHeld(bed, t0 + 1000), true, 'held right after the mark')
  assert.strictEqual(P.bedHeld(bed, t0 + 479000), true, 'still held just inside the window')
  assert.strictEqual(P.bedHeld(bed, t0 + 480001), false, 'released once the window elapses')
})

t('bedHeld: a DIFFERENT bed position is never held by this bed hold', () => {
  const bed = { x: 417, y: 66, z: 89 }
  const t0 = 2000000
  P.markBedUnusable(bed, 480000, 'cant click the bed', t0)
  assert.strictEqual(P.bedHeld({ x: 10, y: 66, z: 20 }, t0 + 1000), false, 'other bed not held')
  assert.strictEqual(P.bedHeld({ x: 418, y: 66, z: 89 }, t0 + 1000), false, 'even one block off is a different key')
  assert.strictEqual(P.bedHeld(bed, t0 + 1000), true, 'the marked bed is still held')
})

t('markBedUnusable: rounds the key and ms<=0 / no pos is a no-op', () => {
  const t0 = 3000000
  P.markBedUnusable({ x: 417.4, y: 65.6, z: 88.7 }, 90000, 'hostile in the wake-radius', t0)
  assert.strictEqual(P.bedHeld({ x: 417, y: 66, z: 89 }, t0 + 1000), true, 'position rounded to key')
  // ms<=0 does not overwrite/clear an existing hold, and null pos is a no-op
  P.markBedUnusable({ x: 417, y: 66, z: 89 }, 0, 'zero', t0 + 2000)
  assert.strictEqual(P.bedHeld({ x: 417, y: 66, z: 89 }, t0 + 3000), true, 'ms<=0 was a no-op, prior hold survives')
  P.markBedUnusable(null, 90000, 'nopos', t0 + 4000)
  assert.strictEqual(P.bedHeld({ x: 417, y: 66, z: 89 }, t0 + 5000), true, 'null pos was a no-op')
})

t('bedHeld: a REAL sleep (rememberBed) clears the hold', () => {
  const bed = { x: 417, y: 66, z: 89 }
  const t0 = 4000000
  P.markBedUnusable(bed, 480000, 'cant click the bed', t0)
  assert.strictEqual(P.bedHeld(bed, t0 + 1000), true)
  P.rememberBed(bed) // actually sleeping re-arms the spawn AND clears the unusable-hold
  assert.strictEqual(P.bedHeld(bed, t0 + 1000), false, 'sleeping clears the hold so the bed is usable again')
})

t('markBedUnusable: SHELTER_BED_FALLBACK=0 is a no-op (rollback = never holds)', () => {
  const bed = { x: 500, y: 70, z: 500 }
  const t0 = 5000000
  const prev = process.env.SHELTER_BED_FALLBACK
  process.env.SHELTER_BED_FALLBACK = '0'
  P.markBedUnusable(bed, 480000, 'cant click the bed', t0)
  assert.strictEqual(P.bedHeld(bed, t0 + 1000), false, 'no hold is ever set when the flag is off')
  process.env.SHELTER_BED_FALLBACK = prev
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall shelter-siting tests passed')
process.exit(failures ? 1 : 0)
