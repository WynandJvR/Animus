'use strict'
// OFFLINE unit test for the PURE leg-planning core (bot/nav-leg.js) - no bot, no pathfinder, no
// world. Proves the NAV Phase B Y-band semantics a SURFACE trek's leg goal relies on
// (DESIGN-nav-overhaul.md §3 Phase B): a leg can NOT be satisfied K+ blocks below the trek's
// reference surface (so A* can't ride a cave mouth 45b DOWN to lava at the target XZ - #41), the
// heuristic penalizes depth so the search stays near the surface, and above the band the goal
// behaves exactly like GoalNearXZ (XZ-only). Run:  cd bot && node navlegtest.js
//
// This is the plan-time half of the #41 lava-walk-in fix; a red suite means a surface trek could
// again "arrive" deep underground on a lava-pool edge.

const assert = require('assert')
const leg = require('./nav-leg.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

const SURFACE = 70
const K = leg.DEFAULT_MAX_DROP // 18
const R = 4
const rangeSq = R * R

// ---- depthBelowBand: the band-floor math ----------------------------------------------------
t('depthBelowBand: on/above the floor => 0, below => blocks-below-floor', () => {
  assert.strictEqual(leg.depthBelowBand(SURFACE, SURFACE, K), 0, 'at surface: 0')
  assert.strictEqual(leg.depthBelowBand(SURFACE - K, SURFACE, K), 0, 'exactly at the floor: 0')
  assert.strictEqual(leg.depthBelowBand(SURFACE - K - 1, SURFACE, K), 1, '1 below the floor: 1')
  assert.strictEqual(leg.depthBelowBand(SURFACE - 45, SURFACE, K), 45 - K, '45 below surface: 45-K below floor')
  assert.strictEqual(leg.depthBelowBand(SURFACE + 5, SURFACE, K), 0, 'above surface (hill) still 0')
})

// ---- bandedIsEnd: XZ range AND not sunk below the band --------------------------------------
t('bandedIsEnd: at the XZ target on the surface => arrived', () => {
  assert.strictEqual(leg.bandedIsEnd({ x: 10, y: SURFACE, z: 10 }, 10, 10, rangeSq, SURFACE, K), true)
})
t('bandedIsEnd: at the XZ target but 45b DOWN a cave => NOT arrived (the #41 rejection)', () => {
  assert.strictEqual(leg.bandedIsEnd({ x: 10, y: SURFACE - 45, z: 10 }, 10, 10, rangeSq, SURFACE, K), false)
})
t('bandedIsEnd: within XZ range at the band floor => arrived; one below the floor => not', () => {
  assert.strictEqual(leg.bandedIsEnd({ x: 12, y: SURFACE - K, z: 10 }, 10, 10, rangeSq, SURFACE, K), true, 'floor, within range 4')
  assert.strictEqual(leg.bandedIsEnd({ x: 12, y: SURFACE - K - 1, z: 10 }, 10, 10, rangeSq, SURFACE, K), false, 'one below floor rejected even at target XZ')
})
t('bandedIsEnd: out of XZ range => not arrived even on the surface', () => {
  assert.strictEqual(leg.bandedIsEnd({ x: 20, y: SURFACE, z: 10 }, 10, 10, rangeSq, SURFACE, K), false, '10b off in X (>range 4)')
})
t('bandedIsEnd: a legitimately-lower-but-in-band cell (moderate downhill) still arrives', () => {
  assert.strictEqual(leg.bandedIsEnd({ x: 10, y: SURFACE - 10, z: 10 }, 10, 10, rangeSq, SURFACE, K), true, '10b downhill < K=18 tolerated')
})

// ---- bandedHeuristic: XZ distance above band, + depth surcharge below -----------------------
t('bandedHeuristic: above the band == pure octile XZ distance (GoalNearXZ parity)', () => {
  const node = { x: 0, y: SURFACE, z: 0 }
  assert.strictEqual(leg.bandedHeuristic(node, 10, 0, SURFACE, K), leg.distanceXZ(10, 0), 'no penalty above band')
})
t('bandedHeuristic: a deep node costs XZ + DEPTH_PENALTY per block below the floor', () => {
  const node = { x: 0, y: SURFACE - K - 3, z: 0 } // 3 below the floor
  const expect = leg.distanceXZ(10, 0) + leg.DEPTH_PENALTY * 3
  assert.strictEqual(leg.bandedHeuristic(node, 10, 0, SURFACE, K), expect)
})
t('bandedHeuristic: a deep node at the same XZ is far costlier than a surface node farther away', () => {
  const deepClose = leg.bandedHeuristic({ x: 8, y: SURFACE - 45, z: 0 }, 10, 0, SURFACE, K) // 2b XZ but 45 down
  const surfaceFar = leg.bandedHeuristic({ x: -30, y: SURFACE, z: 0 }, 10, 0, SURFACE, K)    // 40b XZ, on surface
  assert(deepClose > surfaceFar, 'the cave descent is deprioritized vs a longer surface route')
})

// ---- the injected Goal class (drop-in for goals.GoalNearXZ) ---------------------------------
t('makeGoalNearXZBanded: builds a Goal-subclass with Y-aware isEnd/heuristic and floored coords', () => {
  class FakeGoal { heuristic () { return 0 } isEnd () { return true } }
  const G = leg.makeGoalNearXZBanded(FakeGoal)
  const g = new G(10.7, 10.2, R, SURFACE + 0.9)
  assert(g instanceof FakeGoal, 'extends the injected base')
  assert.strictEqual(g.x, 10, 'x floored'); assert.strictEqual(g.z, 10, 'z floored'); assert.strictEqual(g.surfaceRef, 70, 'surfaceRef floored')
  assert.strictEqual(g.maxDrop, K, 'defaults to DEFAULT_MAX_DROP')
  assert.strictEqual(g.isEnd({ x: 10, y: SURFACE, z: 10 }), true, 'arrives on surface at target')
  assert.strictEqual(g.isEnd({ x: 10, y: SURFACE - 45, z: 10 }), false, 'rejects deep')
  assert.strictEqual(g.heuristic({ x: 0, y: SURFACE, z: 10 }), leg.distanceXZ(10, 0), 'heuristic delegates to bandedHeuristic')
})

// ---- LEG-PROBE candidate policy (NAV_LEG_PROBE, Phase C / §5-P2) -----------------------------
t('legCandidates: direct bearing FIRST (deg 0, full step), then the ±60/±120 rotations (shorter step)', () => {
  const cands = leg.legCandidates({ x: 0, z: 0 }, 1, 0, 100, 48, 24) // heading +x
  assert.strictEqual(cands.length, 5, 'direct + 4 rotations')
  assert.strictEqual(cands[0].deg, 0, 'direct bearing is index 0')
  assert(Math.abs(cands[0].x - 48) < 1e-9 && Math.abs(cands[0].z) < 1e-9, 'direct at full step along +x')
  assert.deepStrictEqual(cands.slice(1).map(c => c.deg), leg.PROBE_ROTATIONS, 'rotations follow in order')
  for (const c of cands.slice(1)) assert(Math.hypot(c.x, c.z) <= 24 + 1e-9, 'rotations use the shorter step')
})

t('legCandidates: step is capped at the remaining distance d', () => {
  const cands = leg.legCandidates({ x: 0, z: 0 }, 1, 0, 10, 48, 24) // only 10b left
  assert(Math.abs(cands[0].x - 10) < 1e-9, 'direct step capped to d=10')
})

t('chooseProbedLeg: a reachable DIRECT bearing is taken immediately (one probe, no rotation)', () => {
  const cands = leg.legCandidates({ x: 0, z: 0 }, 1, 0, 100, 48, 24)
  let probes = 0
  const pick = leg.chooseProbedLeg(cands, () => { probes++; return 'success' })
  assert.strictEqual(pick.index, 0, 'took the direct bearing')
  assert.strictEqual(pick.rotated, false)
  assert.strictEqual(probes, 1, 'short-circuits after the first non-noPath probe')
})

t('chooseProbedLeg: direct noPath -> takes the FIRST non-noPath rotation', () => {
  const cands = leg.legCandidates({ x: 0, z: 0 }, 1, 0, 100, 48, 24)
  // direct (deg 0) + first rotation (deg 60) noPath; second rotation (deg -60, index 2) reachable
  const verdict = (c) => (c.deg === 0 || c.deg === 60) ? 'noPath' : 'success'
  const pick = leg.chooseProbedLeg(cands, verdict)
  assert.strictEqual(pick.cand.deg, -60, 'skipped the two noPath candidates')
  assert.strictEqual(pick.rotated, true)
  assert.strictEqual(pick.index, 2)
})

t('chooseProbedLeg: EVERY candidate noPath -> SOFT fallback to the direct bearing (never a wall)', () => {
  const cands = leg.legCandidates({ x: 0, z: 0 }, 1, 0, 100, 48, 24)
  const pick = leg.chooseProbedLeg(cands, () => 'noPath')
  assert.strictEqual(pick.index, 0, 'falls back to the direct bearing')
  assert.strictEqual(pick.verdict, 'noPath')
  assert.strictEqual(pick.rotated, false)
})

t('chooseProbedLeg: only `noPath` is a veto - partial/timeout/unknown are GREEN (design §4-D)', () => {
  const cands = leg.legCandidates({ x: 0, z: 0 }, 1, 0, 100, 48, 24)
  for (const v of ['timeout', 'partial', 'anything']) {
    const pick = leg.chooseProbedLeg(cands, () => v)
    assert.strictEqual(pick.index, 0, v + ' is not a veto -> keep the direct bearing')
  }
})

t('chooseProbedLeg: a throwing verdict is treated as non-veto (unknown), not a crash', () => {
  const cands = leg.legCandidates({ x: 0, z: 0 }, 1, 0, 100, 48, 24)
  const pick = leg.chooseProbedLeg(cands, () => { throw new Error('probe boom') })
  assert.strictEqual(pick.index, 0, 'a probe error keeps the direct bearing (SOFT)')
})

t('chooseProbedLeg: empty candidate list => null (defensive)', () => {
  assert.strictEqual(leg.chooseProbedLeg([], () => 'success'), null)
  assert.strictEqual(leg.chooseProbedLeg(null, () => 'success'), null)
})

console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nALL PASS')
process.exit(failures ? 1 : 0)
