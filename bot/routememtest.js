'use strict'
// OFFLINE unit test for the PURE route/wedge memory core (bot/route-mem.js) - no bot, no
// fs, no pathfinder. Proves the semantics the trek layer relies on: polyline thinning
// (cap + keep endpoints), endpoint matching (both orientations, tolerance boundary),
// forward-only cursor, wedge merge/decay/eviction, segment-clip geometry, and - the #1
// operator rule - own-infra suppression on BOTH the record and the recall side.
// Run:  cd bot && node routememtest.js

const assert = require('assert')
const rm = require('./route-mem.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

// ---- thinPolyline: cap 24 + keep endpoints -----------------------------------------
t('thinPolyline caps at 24 and preserves both endpoints', () => {
  // a 100-point zigzag (every point a corner) - pass-1 keeps them all, pass-2 must cap
  const pts = []
  for (let i = 0; i < 100; i++) pts.push({ x: i * 3, z: (i % 2) * 5 })
  const out = rm.thinPolyline(pts, 24, 12)
  assert(out.length <= 24, 'thinned to <=24, got ' + out.length)
  assert.deepStrictEqual(out[0], { x: 0, z: 0 }, 'first endpoint kept')
  assert.deepStrictEqual(out[out.length - 1], { x: 297, z: 5 }, 'last endpoint kept')
})

t('thinPolyline collapses a dense straight run by spacing (endpoints survive)', () => {
  const pts = []
  for (let i = 0; i <= 50; i++) pts.push({ x: i * 5, z: 0 }) // 250b straight, 5b spacing
  const out = rm.thinPolyline(pts, 24, 12)
  assert(out.length <= 24, 'straight run thinned, got ' + out.length)
  assert(out.length >= 2, 'at least the endpoints')
  assert.strictEqual(out[0].x, 0)
  assert.strictEqual(out[out.length - 1].x, 250)
})

t('thinPolyline passes short paths through untouched', () => {
  assert.deepStrictEqual(rm.thinPolyline([{ x: 1, z: 2 }, { x: 3, z: 4 }]), [{ x: 1, z: 2 }, { x: 3, z: 4 }])
})

// ---- canonEndpoints ----------------------------------------------------------------
t('canonEndpoints orders lexicographically (x then z)', () => {
  assert.deepStrictEqual(rm.canonEndpoints({ x: 5, z: 1 }, { x: 2, z: 9 }), [{ x: 2, z: 9 }, { x: 5, z: 1 }])
  assert.deepStrictEqual(rm.canonEndpoints({ x: 4, z: 8 }, { x: 4, z: 3 }), [{ x: 4, z: 3 }, { x: 4, z: 8 }], 'tie on x -> order by z')
})

// ---- matchRoute: tolerance boundary + both orientations ----------------------------
t('matchRoute: 23.9b matches, 24.1b rejects (both orientations)', () => {
  const routes = [{ a: { x: 0, z: 0 }, b: { x: 200, z: 0 }, pts: [], ok: 1, fail: 0, at: 0, len: 200 }]
  // forward: from near a, to near b, off by 23.9 each
  const fwd = rm.matchRoute(routes, { x: 23.9, z: 0 }, { x: 200 - 23.9, z: 0 }, 24)
  assert(fwd && !fwd.reversed, 'forward match within tol')
  // reversed: from near b, to near a
  const rev = rm.matchRoute(routes, { x: 200 - 23.9, z: 0 }, { x: 23.9, z: 0 }, 24)
  assert(rev && rev.reversed, 'reversed match within tol')
  // just past tol on one end -> no match
  assert.strictEqual(rm.matchRoute(routes, { x: 24.1, z: 0 }, { x: 200, z: 0 }, 24), null, '24.1b rejected')
})

// ---- routeCursor: forward-only -----------------------------------------------------
t('routeCursor never targets a point behind pos', () => {
  const pts = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }, { x: 30, z: 0 }, { x: 40, z: 0 }]
  // on segment [2,3] (x 20-30) -> aim its far end pt3 (x=30), never a passed point
  assert.strictEqual(rm.routeCursor(pts, { x: 21, z: 0 }), 3, 'on seg 2-3 -> aim pt3')
  // on segment [1,2] (x 10-20) -> aim its far end pt2 (x=20)
  assert.strictEqual(rm.routeCursor(pts, { x: 12, z: 0 }), 2, 'on seg 1-2 -> aim pt2')
  // near the start, on segment [0,1] -> aim pt1
  assert.strictEqual(rm.routeCursor(pts, { x: 1, z: 0 }), 1)
  // near the end -> last index
  assert.strictEqual(rm.routeCursor(pts, { x: 39, z: 0 }), 4)
  // MONOTONIC: cursor for a later pos is never less than for an earlier pos
  let prev = -1
  for (let x = 0; x <= 40; x += 2) { const c = rm.routeCursor(pts, { x, z: 0 }); assert(c >= prev, 'cursor went backwards at x=' + x); prev = c }
})

// ---- wedge merge + decay -----------------------------------------------------------
t('mergeWedge: a hit within 3b bumps n, a far one adds a new entry', () => {
  const now = 1000000
  const wedges = []
  rm.mergeWedge(wedges, { x: 100, y: 64, z: 100 }, now)
  assert.strictEqual(wedges.length, 1)
  assert.strictEqual(wedges[0].n, 1)
  rm.mergeWedge(wedges, { x: 102, y: 64, z: 100 }, now + 1) // 2b away -> same obstacle
  assert.strictEqual(wedges.length, 1, 'merged, no new entry')
  assert.strictEqual(wedges[0].n, 2, 'n bumped')
  rm.mergeWedge(wedges, { x: 104, y: 64, z: 100 }, now + 2) // 4b from origin (>3) -> new
  assert.strictEqual(wedges.length, 2, 'far wedge is a new entry')
})

t('wedgeWeight: full <24h, half to 7d, 0 after 7d', () => {
  const now = 10 * 24 * 3600 * 1000
  assert.strictEqual(rm.wedgeWeight({ at: now - 3600 * 1000 }, now), 1, '1h old = full')
  assert.strictEqual(rm.wedgeWeight({ at: now - 3 * 24 * 3600 * 1000 }, now), 0.5, '3d old = half')
  assert.strictEqual(rm.wedgeWeight({ at: now - 8 * 24 * 3600 * 1000 }, now), 0, '8d old = dead')
})

t('mergeWedge prunes dead entries and caps at 24', () => {
  const now = 30 * 24 * 3600 * 1000
  const wedges = [{ x: -999, y: 64, z: -999, at: now - 8 * 24 * 3600 * 1000, n: 1 }] // dead (8d)
  rm.mergeWedge(wedges, { x: 0, y: 64, z: 0 }, now)
  assert.strictEqual(wedges.length, 1, 'dead entry pruned, one fresh remains')
  // overflow the cap
  const big = []
  for (let i = 0; i < 30; i++) rm.mergeWedge(big, { x: i * 10, y: 64, z: 0 }, now + i)
  assert.strictEqual(big.length, 24, 'capped at 24')
})

// ---- wedgeOnSegment: segment-clip geometry -----------------------------------------
t('wedgeOnSegment: within corridor clips, beyond does not', () => {
  const now = 1000
  const wedges = [{ x: 50, y: 64, z: 1, at: now, n: 1 }] // 1b off the z=0 line at x=50
  const hit = rm.wedgeOnSegment(wedges, { x: 0, z: 0 }, { x: 100, z: 0 }, 2, now)
  assert(hit, 'a wedge 1b off the segment (corridor 2) clips it')
  const far = [{ x: 50, y: 64, z: 3, at: now, n: 1 }] // 3b off -> outside corridor 2
  assert.strictEqual(rm.wedgeOnSegment(far, { x: 0, z: 0 }, { x: 100, z: 0 }, 2, now), null, '3b off does not clip')
  // a wedge beyond the segment endpoints (clamped) does not clip
  const past = [{ x: 130, y: 64, z: 0, at: now, n: 1 }]
  assert.strictEqual(rm.wedgeOnSegment(past, { x: 0, z: 0 }, { x: 100, z: 0 }, 2, now), null, 'past the endpoint -> no clip')
})

// ---- SUPPRESSION: the #1 operator rule (both sides) --------------------------------
t('suppressedNearAnchors: 11.9b rejected (suppressed), 12.1b accepted', () => {
  const anchors = [{ x: 0, z: 0 }]
  assert.strictEqual(rm.suppressedNearAnchors(anchors, { x: 11.9, z: 0 }, 12), true, '11.9b from home -> suppressed')
  assert.strictEqual(rm.suppressedNearAnchors(anchors, { x: 12.1, z: 0 }, 12), false, '12.1b from home -> allowed')
  assert.strictEqual(rm.suppressedNearAnchors([], { x: 0, z: 0 }, 12), false, 'no anchors -> nothing suppressed')
})

t('recall-side suppression retroactively kills a pre-existing wedge when an anchor appears', () => {
  const now = 1000
  // a wedge recorded earlier at 500,500 (say the bot died there BEFORE it built a hut there)
  const wedges = [{ x: 500, y: 64, z: 500, at: now, n: 3 }]
  // with no infra nearby it is a live, steer-eligible wedge
  assert.strictEqual(rm.activeWedges(wedges, [], now).length, 1, 'alive + unsuppressed when no infra near')
  // now a hut exists 6b away -> the same wedge must vanish from the steer-eligible list
  const anchors = [{ x: 506, z: 500 }]
  assert.strictEqual(rm.activeWedges(wedges, anchors, now).length, 0, 'infra appearing near a wedge neutralises it at recall time')
  // the stored entry itself is untouched (suppression is a read-time filter, not a delete)
  assert.strictEqual(wedges.length, 1, 'record retained, only filtered on read')
})

t('activeWedges also drops dead (aged-out) wedges', () => {
  const now = 30 * 24 * 3600 * 1000
  const wedges = [{ x: 500, y: 64, z: 500, at: now - 8 * 24 * 3600 * 1000, n: 1 }]
  assert.strictEqual(rm.activeWedges(wedges, [], now).length, 0, 'an 8d-old wedge is not steer-eligible')
})

// ---- mergeRoute: eviction order + refresh ------------------------------------------
t('mergeRoute refreshes a matching route (ok++, fail reset, fresh pts)', () => {
  const routes = []
  rm.mergeRoute(routes, { a: { x: 0, z: 0 }, b: { x: 200, z: 0 }, pts: [{ x: 0, z: 0 }], len: 200, at: 1 })
  routes[0].fail = 1
  const r = rm.mergeRoute(routes, { a: { x: 5, z: 0 }, b: { x: 205, z: 0 }, pts: [{ x: 0, z: 0 }, { x: 100, z: 0 }], len: 205, at: 9 })
  assert.strictEqual(routes.length, 1, 'endpoints within tol -> merged, not duplicated')
  assert.strictEqual(r.ok, 2, 'ok bumped')
  assert.strictEqual(r.fail, 0, 'fail reset on success')
  assert.strictEqual(r.at, 9, 'timestamp refreshed')
  assert.strictEqual(r.pts.length, 2, 'fresh crumbs stored')
})

t('mergeRoute caps at 16 and evicts the least-valuable (lowest ok-fail)', () => {
  const routes = []
  // 16 distinct routes, each ok=5
  for (let i = 0; i < 16; i++) routes.push({ a: { x: i * 100, z: 0 }, b: { x: i * 100, z: 300 }, pts: [], ok: 5, fail: 0, at: 100 + i, len: 300 })
  // make ONE of them a loser
  routes[7].ok = 1; routes[7].fail = 1 // net 0
  const loserA = routes[7].a
  // add a 17th good route -> the loser (net 0) must be the one evicted
  rm.mergeRoute(routes, { a: { x: 9999, z: 0 }, b: { x: 9999, z: 300 }, pts: [], len: 300, at: 999 })
  assert.strictEqual(routes.length, 16, 'still capped at 16')
  assert(!routes.some(r => r.a.x === loserA.x && r.a.z === loserA.z), 'the net-0 loser was evicted')
  assert(routes.some(r => r.a.x === 9999), 'the new route was kept')
})

// ---- route sanity + fail-decay -----------------------------------------------------
t('routeLenOk: rejects a polyline >1.6x the straight-line', () => {
  assert.strictEqual(rm.routeLenOk({ a: { x: 0, z: 0 }, b: { x: 100, z: 0 }, len: 150 }), true, '1.5x is fine')
  assert.strictEqual(rm.routeLenOk({ a: { x: 0, z: 0 }, b: { x: 100, z: 0 }, len: 170 }), false, '1.7x is a detour, reject')
})

t('routeUsable: needs net successes AND length sanity', () => {
  assert.strictEqual(rm.routeUsable({ a: { x: 0, z: 0 }, b: { x: 100, z: 0 }, ok: 2, fail: 1, len: 110 }), true)
  assert.strictEqual(rm.routeUsable({ a: { x: 0, z: 0 }, b: { x: 100, z: 0 }, ok: 1, fail: 1, len: 110 }), false, 'net 0 -> not usable')
  assert.strictEqual(rm.routeUsable({ a: { x: 0, z: 0 }, b: { x: 100, z: 0 }, ok: 5, fail: 0, len: 999 }), false, 'fails len sanity')
})

t('routeShouldEvict: 2 consecutive fails evict', () => {
  const r = { ok: 3, fail: 0 }
  r.fail++
  assert.strictEqual(rm.routeShouldEvict(r), false, 'one fail is survivable')
  r.fail++
  assert.strictEqual(rm.routeShouldEvict(r), true, 'two consecutive fails -> evict')
})

// ---- wedgeNearXZ: gather target-selection guard ------------------------------------
t('wedgeNearXZ: a fresh wedge within 8b hits, a far one misses', () => {
  const now = 1000000000000
  const wedges = [{ x: 100, z: 200, at: now, n: 1 }]
  assert.strictEqual(rm.wedgeNearXZ(wedges, { x: 104, z: 203 }, 8, now), true, '~5b away -> on the wedge')
  assert.strictEqual(rm.wedgeNearXZ(wedges, { x: 130, z: 200 }, 8, now), false, '30b away -> clear')
})

t('wedgeNearXZ: a wedge aged past its decay window (weight 0) misses', () => {
  const now = 1000000000000
  const old = now - 8 * 24 * 3600 * 1000 // >7d -> wedgeWeight 0, ages back into eligibility
  const wedges = [{ x: 100, z: 200, at: old, n: 1 }]
  assert.strictEqual(rm.wedgeNearXZ(wedges, { x: 100, z: 200 }, 8, now), false, 'decayed wedge no longer blocks')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall route-mem tests passed')
process.exit(failures ? 1 : 0)
