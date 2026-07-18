'use strict'
// OFFLINE unit test for the PURE behavioral cycle detector (bot/cycle-detect.js) - no bot, no fs,
// no clock. Proves the two predicates the S7 watchdog relies on + the false-positive guards that
// keep legitimate back-and-forth WORK immune:
//   - A<->B oscillation (net<8, gross>=48, two-anchor, zero work) -> flagged;
//   - the SAME trace with workCount advancing (chest<->build shuttle) -> NOT flagged;
//   - a farm-grid pass (many cells) -> NOT flagged; a straight trek (net>8) -> NOT flagged;
//   - a frozen bot (gross~0) -> NOT flagged (freeze watchdogs' domain, not ours);
//   - repeatFail tuple x3 -> flagged; x2 -> not; x3 with an interleaved success -> not;
//     x3 at 3 different cells -> not; digit-strip matches "door at 433,62,112" vs "431,62,110";
//   - step: fires once, cooldown holds 240s, work touch / cycleKey change resets;
//   - jobKey-churn regression: a constant job NAME still detects despite per-dispatch jobKey churn.
// Run:  cd bot && node cycledetecttest.js

const assert = require('assert')
const cd = require('./cycle-detect.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack : e.message)) }
}

// ---- helpers -------------------------------------------------------------------------------
// Build a position ring pacing between A=(0,64,0) and B=(0,64,12) - a 12b oscillation. `work`
// makes workCount advance each sample (the shuttle case). now = last sample's t.
function oscRing ({ samples = 40, dt = 5000, work = false, key = 'gather', ampZ = 12 } = {}) {
  const ring = []
  let wc = 0
  for (let i = 0; i < samples; i++) {
    const at = i % 2 === 0 ? { x: 0, z: 0 } : { x: 0, z: ampZ } // A, B, A, B ... (dwells 1 sample each)
    if (work) wc++ // every tick moves an item/block -> real progress
    ring.push({ t: i * dt, x: at.x, y: 64, z: at.z, cycleKey: key, workCount: wc })
  }
  return ring
}
const nowOf = ring => ring[ring.length - 1].t

// ---- (a) oscillation: the core positive -----------------------------------------------------
t('oscillation: A<->B 12b, ~3.5min, zero work -> cycling oscillation', () => {
  const ring = oscRing({ samples: 42 })
  const d = cd.detect(ring, [], nowOf(ring))
  assert.strictEqual(d.cycling, true, 'should flag')
  assert.strictEqual(d.kind, 'oscillation')
  assert.strictEqual(d.cycleKey, 'gather', 'carries cycleKey for the latch')
  assert.strictEqual(d.workCount, 0, 'zero work in the window')
})

// ---- FALSE-POSITIVE GUARD 1: the chest<->build shuttle (work touches) -----------------------
t('shuttle NOT flagged: identical A<->B trace but workCount advances', () => {
  const ring = oscRing({ samples: 42, work: true })
  const d = cd.detect(ring, [], nowOf(ring))
  assert.strictEqual(d.cycling, false, 'work touches must immunize the shuttle')
})

// ---- FALSE-POSITIVE GUARD 2: a farm-grid pass (many cells, coverage < 80%) -------------------
t('farm grid NOT flagged: 8 distinct 4b cells fail the two-anchor coverage', () => {
  const ring = []
  const cells = [0, 4, 8, 12, 16, 20, 24, 28] // 8 columns, revisited round-robin, net stays small-ish
  for (let i = 0; i < 40; i++) {
    const z = cells[i % cells.length]
    ring.push({ t: i * 5000, x: 0, y: 64, z, cycleKey: 'farm', workCount: 0 })
  }
  const d = cd.detect(ring, [], nowOf(ring))
  assert.strictEqual(d.cycling, false, '> 2 meaningfully-visited cells -> coverage fails')
})

// ---- FALSE-POSITIVE GUARD 3: a straight trek (net displacement grows) ------------------------
t('straight trek NOT flagged: net displacement > 8b within the window', () => {
  const ring = []
  for (let i = 0; i < 40; i++) ring.push({ t: i * 5000, x: i * 3, y: 64, z: 0, cycleKey: 'travel', workCount: 0 })
  const d = cd.detect(ring, [], nowOf(ring))
  assert.strictEqual(d.cycling, false, 'net far > 8b -> not an oscillation')
})

// ---- FALSE-POSITIVE GUARD 4: a frozen bot (gross ~ 0) is the freeze watchdogs' domain --------
t('frozen bot NOT flagged: gross path ~0 (< 48b)', () => {
  const ring = []
  for (let i = 0; i < 40; i++) ring.push({ t: i * 5000, x: 0.1 * (i % 2), y: 64, z: 0, cycleKey: 'gather', workCount: 0 })
  const d = cd.detect(ring, [], nowOf(ring))
  assert.strictEqual(d.cycling, false, 'gross < 48b -> freeze class, not this detector')
})

// ---- too few samples ------------------------------------------------------------------------
t('too few in-window samples -> not flagged', () => {
  const ring = oscRing({ samples: 20 })
  assert.strictEqual(cd.detect(ring, [], nowOf(ring)).cycling, false)
})

// ---- jobKey-churn REGRESSION (root cause 2b) ------------------------------------------------
// The sample cycleKey is the job NAME ('gather'), NOT the per-dispatch name@startedAt jobKey that
// resets wdPhase every re-dispatch. A constant NAME across the window must still detect even though
// the real dispatcher minted a fresh jobKey every 30s.
t('jobKey churn regression: constant job NAME detects despite per-dispatch jobKey churn', () => {
  const ring = oscRing({ samples: 42, key: 'gather' }) // name constant; the churny jobKey is never sampled
  const d = cd.detect(ring, [], nowOf(ring))
  assert.strictEqual(d.cycling, true, 'name-keyed window catches what per-dispatch keying misses')
  assert.strictEqual(d.kind, 'oscillation')
})

// a cycleKey (job NAME) change mid-window resets the window -> no detection
t('a job NAME change within the window resets it -> not flagged', () => {
  const ring = oscRing({ samples: 42 })
  ring[20].cycleKey = 'build' // one different key breaks constancy
  assert.strictEqual(cd.detect(ring, [], nowOf(ring)).cycling, false)
})

// ---- (b) repeatFail -------------------------------------------------------------------------
function fail (t, action, detail, cell) { return { t, action, ok: false, failClass: String(detail).toLowerCase().replace(/-?\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim(), cell } }
function ok (t, action) { return { t, action, ok: true, failClass: '', cell: { x: 0, y: 64, z: 0 } } }
const C = { x: 432, y: 60, z: 112 }

t('repeatFail: same (action, failClass, cell) x3 in 600s -> flagged', () => {
  const out = [fail(0, 'crossDoor', 'crossing failed at door 433,62,112', C), fail(30000, 'crossDoor', 'crossing failed at door 433,62,112', C), fail(60000, 'crossDoor', 'crossing failed at door 433,62,112', C)]
  const d = cd.detect([], out, 61000)
  assert.strictEqual(d.cycling, true)
  assert.strictEqual(d.kind, 'repeatFail')
  assert.strictEqual(d.tuple.count, 3)
})

t('repeatFail: x2 is NOT enough', () => {
  const out = [fail(0, 'crossDoor', 'x', C), fail(30000, 'crossDoor', 'x', C)]
  assert.strictEqual(cd.detect([], out, 31000).cycling, false)
})

t('repeatFail: x3 with an interleaved SUCCESS for the same action -> not flagged', () => {
  const out = [fail(0, 'crossDoor', 'x', C), fail(30000, 'crossDoor', 'x', C), ok(40000, 'crossDoor'), fail(60000, 'crossDoor', 'x', C)]
  assert.strictEqual(cd.detect([], out, 61000).cycling, false, 'a flaky-but-eventually-ok action is not a cycle')
})

t('repeatFail: x3 at 3 DIFFERENT cells (> 8b apart) -> not flagged', () => {
  const out = [fail(0, 'chop', 'no tree', { x: 0, y: 64, z: 0 }), fail(30000, 'chop', 'no tree', { x: 40, y: 64, z: 0 }), fail(60000, 'chop', 'no tree', { x: 80, y: 64, z: 0 })]
  assert.strictEqual(cd.detect([], out, 61000).cycling, false, 'three failures at three different trees is not a loop')
})

t('repeatFail: digit-strip + 8b cell match "door at 433,62,112" vs "431,62,110"', () => {
  // different literal coords in the message AND slightly different position, but SAME 8b cell + same
  // digit-stripped class -> the three must be recognized as the same failure.
  const cA = { x: 432, y: 60, z: 112 } // 433 floored/4
  const cB = { x: 428, y: 60, z: 108 } // 431/110 floored/4 - within 8b of cA
  const out = [
    fail(0, 'crossDoor', 'cannot reach door at 433,62,112', cA),
    fail(30000, 'crossDoor', 'cannot reach door at 431,62,110', cB),
    fail(60000, 'crossDoor', 'cannot reach door at 433,62,112', cA)
  ]
  const d = cd.detect([], out, 61000)
  assert.strictEqual(d.cycling, true, 'digit-stripped class + within-8b cell make these one failure')
  assert.strictEqual(d.kind, 'repeatFail')
})

t('repeatFail: stale fails outside the 600s window are ignored', () => {
  const out = [fail(0, 'crossDoor', 'x', C), fail(30000, 'crossDoor', 'x', C), fail(700000, 'crossDoor', 'x', C)]
  assert.strictEqual(cd.detect([], out, 700001).cycling, false, 'only 1 fail inside 600s of now')
})

// ---- (b') #49 CYCLE_SELFABORT_EXEMPT: watchdog/preempt self-aborts must NOT latch repeatFail ---
// The index.js filter (CYCLE_SELFABORT_EXEMPT on) drops self-abort FAILS before detect() reads the
// ring: outRing.filter(r => !(r.selfAbort && !r.ok)). Mirror that exact filter here at the detect
// boundary; the fix lives in the wiring, cycle-detect.js stays pure.
const selfAbortExempt = ring => ring.filter(r => !(r.selfAbort && !r.ok))
function sfail (t, action, detail, cell, selfAbort) { return { t, action, ok: false, failClass: String(detail).toLowerCase().replace(/-?\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim(), cell, selfAbort: !!selfAbort } }
const SITE = { x: 430, y: 67, z: 85 } // wall quantized 4b in the real ring; use a raw cell here (detect only cell-gates within 8b)

t('#49 self-abort cascade: 4x "(stopped)" self-aborts -> NOT flagged after the exempt filter (bug fixed)', () => {
  const out = [
    sfail(0, 'autobuild resume @ 430,67,85', '0/0 placed (stopped)', SITE, true),
    sfail(150000, 'autobuild resume @ 430,67,85', '0/0 placed (stopped)', SITE, true),
    sfail(300000, 'autobuild resume @ 430,67,85', '0/0 placed (stopped)', SITE, true),
    sfail(450000, 'autobuild resume @ 430,67,85', '0/0 placed (stopped)', SITE, true)
  ]
  const filtered = selfAbortExempt(out)
  const d = cd.detect([], filtered, 450000)
  assert.strictEqual(d.cycling, false, 'self-abort fails are exempt -> no repeatFail cycle')
})

t('#49 flag OFF reproduces todays bug: the SAME 4x self-abort cascade DOES latch repeatFail without the filter', () => {
  const out = [
    sfail(0, 'autobuild resume @ 430,67,85', '0/0 placed (stopped)', SITE, true),
    sfail(150000, 'autobuild resume @ 430,67,85', '0/0 placed (stopped)', SITE, true),
    sfail(300000, 'autobuild resume @ 430,67,85', '0/0 placed (stopped)', SITE, true),
    sfail(450000, 'autobuild resume @ 430,67,85', '0/0 placed (stopped)', SITE, true)
  ]
  const d = cd.detect([], out, 450000) // no filter == CYCLE_SELFABORT_EXEMPT=0
  assert.strictEqual(d.cycling, true, 'unfiltered, the self-abort cascade latches (the false positive)')
  assert.strictEqual(d.kind, 'repeatFail')
})

t('#49 genuine repeatFail STILL latches: 3x real place-fail (selfAbort:false) survives the filter', () => {
  const cell = { x: 1, y: 2, z: 3 }
  const out = [
    sfail(0, 'place', 'cannot place at', cell, false),
    sfail(30000, 'place', 'cannot place at', cell, false),
    sfail(60000, 'place', 'cannot place at', cell, false)
  ]
  const filtered = selfAbortExempt(out)
  const d = cd.detect([], filtered, 61000)
  assert.strictEqual(d.cycling, true, 'genuine fails are not exempt -> still a cycle')
  assert.strictEqual(d.kind, 'repeatFail')
  assert.strictEqual(d.tuple.count, 3)
})

t('#49 interleaved success still resets: genuine fails with an ok:true between -> null', () => {
  const cell = { x: 1, y: 2, z: 3 }
  const out = [
    sfail(0, 'place', 'cannot place at', cell, false),
    sfail(30000, 'place', 'cannot place at', cell, false),
    ok(40000, 'place'),
    sfail(60000, 'place', 'cannot place at', cell, false)
  ]
  const filtered = selfAbortExempt(out)
  assert.strictEqual(cd.detect([], filtered, 61000).cycling, false, 'an interleaved success resets the streak')
})

// ---- step latch reducer ---------------------------------------------------------------------
t('step: fires break ONCE, then cooldown holds for 240s', () => {
  const det = { cycling: true, kind: 'oscillation', cycleKey: 'gather', workCount: 0 }
  let s = cd.step(null, det, 0)
  assert.strictEqual(s.act, 'break', 'first detection fires')
  assert.strictEqual(s.phase, 'latched')
  s = cd.step(s, det, 5000)
  assert.strictEqual(s.act, 'none', 'still cooling down 5s later -> no re-fire')
  s = cd.step(s, det, 239000)
  assert.strictEqual(s.act, 'none', 'still inside the 240s cooldown')
  s = cd.step(s, det, 240001)
  assert.strictEqual(s.act, 'break', 'after 240s a persistent cycle may fire again (bounded, never a tight loop)')
})

t('step: a WORK touch resets the latch to idle', () => {
  const cyc = { cycling: true, cycleKey: 'gather', workCount: 0 }
  let s = cd.step(null, cyc, 0)
  assert.strictEqual(s.act, 'break')
  // work happened: detect now returns cycling:false with an advanced workCount
  s = cd.step(s, { cycling: false, cycleKey: 'gather', workCount: 1 }, 5000)
  assert.strictEqual(s.phase, 'idle', 'work touch clears the latch')
  assert.strictEqual(s.act, 'none')
})

t('step: a cycleKey (job) change resets the latch to idle', () => {
  const cyc = { cycling: true, cycleKey: 'gather', workCount: 0 }
  let s = cd.step(null, cyc, 0)
  assert.strictEqual(s.act, 'break')
  s = cd.step(s, { cycling: false, cycleKey: 'build', workCount: 0 }, 5000)
  assert.strictEqual(s.phase, 'idle', 'a fresh job clears the latch')
  assert.strictEqual(s.act, 'none')
})

t('step: no detection -> stays idle, act none', () => {
  const s = cd.step(null, { cycling: false, cycleKey: null, workCount: 0 }, 0)
  assert.strictEqual(s.act, 'none')
  assert.strictEqual(s.phase, 'idle')
})

console.log('\n' + (failures ? ('FAILED ' + failures) : 'ALL PASS'))
process.exit(failures ? 1 : 0)
