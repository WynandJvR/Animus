'use strict'
// PURE behavioral cycle / oscillation detector (task #34, DESIGN-oscillation-detector.md).
// No bot, no clock, no timer: two predicates over plain history buffers -> a verdict the S7
// watchdog turns into a fail-job. House pattern: route-mem.js / routememtest.js (a pure decision
// core; the impure wiring lives in index.js's existing 5s watchdog).
//
// The gap it closes: every EXISTING stall detector keys on ABSENCE OF MOVEMENT; a behavioral
// cycle (hut in/out, door-assist retry spam, hut<->farm ping-pong, "gather held x8") MOVES on
// every iteration (or re-dispatches) and so defeats all five by construction. These predicates
// key on REPETITION of behavior instead.
//
//   detect(posRing, outcomeRing, now) -> { cycling:false, cycleKey, workCount }
//                                      | { cycling:true, kind:'oscillation', cells, cycleKey, workCount }
//                                      | { cycling:true, kind:'repeatFail', tuple, cycleKey, workCount }
//   step(prev, detection, now)        -> latch reducer: act 'break' ONCE per detection, 240s cooldown.
//
// The result always carries {cycleKey, workCount} (the latest sample's) so `step` can reset its
// latch on any real work touch or a job change WITHOUT holding state of its own.

// ---- tunables (DESIGN §4.4) --------------------------------------------------------------
const OSC_WINDOW_MS = 180000   // 180s behavioral window (hut in/out laps run ~30-60s -> 3+ laps)
const OSC_MIN_SAMPLES = 30     // < this in-window -> not enough evidence (180s @ 5s ~= 36)
const OSC_NET_MAX = 8          // endpoint displacement < 8b == no net progress toward the goal
const OSC_GROSS_MIN = 48       // but >= 48b path length == real movement (separates us from freeze wds)
const CELL = 4                 // 4b cell quantization (matches route-mem's physical wedge-cell scale)
const OSC_COVERAGE = 0.80      // the two most-visited cells must cover >= 80% of the samples
const OSC_MIN_ALT = 4          // >= 4 A<->B alternations (a zigzag/farm pass touches many cells -> fails)
const FAIL_WINDOW_MS = 600000  // 600s repeat-fail window
const FAIL_K = 3               // K identical (action, failClass, cell) fails == a loop
const FAIL_CELL_MATCH = 8      // "same" cell == within 8b (digit-strip + cell keeps it honest)
const COOLDOWN_MS = 240000     // one break per detection, then a 240s latch (mirrors wdLastFire) so
                               // the detector can never itself become a tight loop (invariant 7).

function q (v) { return Math.floor(v / CELL) * CELL }
function cellKey (x, y, z) { return q(x) + ',' + q(y) + ',' + q(z) }
function dist3 (a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }
function keyOf (s) { return (s && s.cycleKey !== undefined) ? s.cycleKey : null } // null IS a key

// ---- (a) oscillation ---------------------------------------------------------------------
// Over the trailing 180s window, ALL of: constant cycleKey; endpoint net < 8b; gross path >= 48b;
// two 4b anchor cells cover >= 80% with >= 4 A<->B alternations; ZERO work touches. Returns
// { cells:[A,B] } or null.
function detectOscillation (posRing, now) {
  const win = []
  for (const s of posRing) { if (s && now - s.t <= OSC_WINDOW_MS) win.push(s) }
  if (win.length < OSC_MIN_SAMPLES) return null
  // 1. cycleKey constant across the window (a job change deserves a fresh window; null counts).
  const key = keyOf(win[0])
  for (const s of win) { if (keyOf(s) !== key) return null }
  // 5. zero work across the whole window (the chest<->build shuttle guard, invariant 2).
  let minW = Infinity, maxW = -Infinity
  for (const s of win) { const w = s.workCount || 0; if (w < minW) minW = w; if (w > maxW) maxW = w }
  if (maxW !== minW) return null
  // 2. no net progress (endpoint displacement).
  const first = win[0], last = win[win.length - 1]
  if (dist3(first, last) >= OSC_NET_MAX) return null
  // 3. but real movement (gross path length) - this is what excludes the freeze watchdogs' domain.
  let gross = 0
  for (let i = 1; i < win.length; i++) gross += dist3(win[i - 1], win[i])
  if (gross < OSC_GROSS_MIN) return null
  // 4. two-anchor shape: 4b-cell coverage + A<->B alternation.
  const counts = new Map()
  const seq = []
  for (const s of win) { const k = cellKey(s.x, s.y, s.z); counts.set(k, (counts.get(k) || 0) + 1); seq.push(k) }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (sorted.length < 2) return null // one cell only => a freeze, not this detector's domain
  const A = sorted[0][0], B = sorted[1][0]
  const coverage = (sorted[0][1] + sorted[1][1]) / win.length
  if (coverage < OSC_COVERAGE) return null // > 2 meaningfully-visited cells (zigzag / farm grid)
  let alt = 0, prev = null
  for (const k of seq) {
    if (k !== A && k !== B) continue
    if (prev !== null && k !== prev) alt++
    prev = k
  }
  if (alt < OSC_MIN_ALT) return null
  return { cells: [A, B] }
}

// ---- (b) repeatFail ----------------------------------------------------------------------
// The same (action, failClass, cell within 8b) with ok=false appearing K>=3 times in 600s, with
// NO interleaved ok=true for the same action between the first and last matching fail. Works even
// when each attempt moves the bot 30b (where the oscillation shape test would pass it).
function detectRepeatFail (outcomeRing, now) {
  const win = []
  for (const r of outcomeRing) { if (r && now - r.t <= FAIL_WINDOW_MS) win.push(r) }
  const fails = win.filter(r => !r.ok)
  for (const anchor of fails) {
    if (!anchor.cell) continue // no position -> can't cell-gate; skip (keeps 3-different-trees honest)
    const group = fails.filter(r => r.action === anchor.action && r.failClass === anchor.failClass &&
      r.cell && dist3(r.cell, anchor.cell) <= FAIL_CELL_MATCH)
    if (group.length < FAIL_K) continue
    let t0 = Infinity, t1 = -Infinity
    for (const r of group) { if (r.t < t0) t0 = r.t; if (r.t > t1) t1 = r.t }
    // a flaky action that eventually succeeds is NOT a cycle: an interleaved success resets it.
    const interleaved = win.some(r => r.ok && r.action === anchor.action && r.t >= t0 && r.t <= t1)
    if (interleaved) continue
    return { tuple: { action: anchor.action, failClass: anchor.failClass, cell: anchor.cell, count: group.length } }
  }
  return null
}

// ---- detect ------------------------------------------------------------------------------
function detect (posRing, outcomeRing, now) {
  const t = now != null ? now : Date.now()
  const pos = Array.isArray(posRing) ? posRing : []
  const out = Array.isArray(outcomeRing) ? outcomeRing : []
  const lastS = pos.length ? pos[pos.length - 1] : null
  const ctx = { cycleKey: keyOf(lastS), workCount: lastS ? (lastS.workCount || 0) : 0 }
  const osc = detectOscillation(pos, t)
  if (osc) return { cycling: true, kind: 'oscillation', cells: osc.cells, cycleKey: ctx.cycleKey, workCount: ctx.workCount }
  const rf = detectRepeatFail(out, t)
  if (rf) return { cycling: true, kind: 'repeatFail', tuple: rf.tuple, cycleKey: ctx.cycleKey, workCount: ctx.workCount }
  return { cycling: false, cycleKey: ctx.cycleKey, workCount: ctx.workCount }
}

// ---- step (latch reducer, mirrors scheduler.wdPhase) -------------------------------------
// Fires act:'break' exactly ONCE per detection, then cools down COOLDOWN_MS. Any work touch or
// cycleKey change (read off the detection's context) resets the latch to idle. Pure; clock passed.
function step (prev, det, now) {
  const t = now != null ? now : Date.now()
  const cycling = !!(det && det.cycling)
  const key = det ? (det.cycleKey === undefined ? null : det.cycleKey) : null
  const wc = det ? (det.workCount || 0) : 0
  let p = prev || { phase: 'idle', firedAt: -Infinity, cycleKey: key, workCount: wc }
  if (p.cycleKey === undefined) p = { phase: p.phase || 'idle', firedAt: p.firedAt != null ? p.firedAt : -Infinity, cycleKey: key, workCount: p.workCount || 0 }
  // RESET (invariant 7): a work touch or a job/cycleKey change clears any latch immediately.
  const progressed = (wc !== (p.workCount || 0)) || (key !== p.cycleKey)
  if (progressed) p = { phase: 'idle', firedAt: p.firedAt, cycleKey: key, workCount: wc }
  // cooldown expiry: a stale latch returns to idle so a persistent cycle re-fires at most every 240s.
  if (p.phase === 'latched' && t - p.firedAt >= COOLDOWN_MS) p = { phase: 'idle', firedAt: p.firedAt, cycleKey: key, workCount: wc }
  if (p.phase === 'latched') return { phase: 'latched', firedAt: p.firedAt, cycleKey: key, workCount: wc, act: 'none' }
  if (cycling) return { phase: 'latched', firedAt: t, cycleKey: key, workCount: wc, act: 'break' }
  return { phase: 'idle', firedAt: p.firedAt, cycleKey: key, workCount: wc, act: 'none' }
}

module.exports = {
  detect,
  step,
  detectOscillation,
  detectRepeatFail,
  _consts: { OSC_WINDOW_MS, OSC_MIN_SAMPLES, OSC_NET_MAX, OSC_GROSS_MIN, CELL, OSC_COVERAGE, OSC_MIN_ALT, FAIL_WINDOW_MS, FAIL_K, FAIL_CELL_MATCH, COOLDOWN_MS }
}
