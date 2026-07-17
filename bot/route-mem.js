'use strict'
// SEMANTIC WORLD-MAP slice 1 - ROUTE-REUSE + WEDGE-MEMORY (pure geometry core).
//
// This module is PURE: no fs, no bot, no pathfinder - just the math the trek layer
// (walkStaged / travelFar) needs to (a) replay a proven home<->X route instead of
// blind-planning into the same wedge every trip, and (b) soft-steer a fresh bearing
// leg around a spot it physically got stuck. Persistence + bot wiring live in
// provision.js (the ONE world-memory writer); traversal wiring lives in the trek loops.
//
// HONEST SCOPE: this REDUCES getting-stuck, it does NOT cure it. The root cause - a
// blind static straight-line planner that recomputes each leg from scratch - is still
// there. Route replay only helps when a good route was already learned; wedge steer is
// a SOFT nudge (it always falls back to the direct bearing, never walls a path off).
//
// Offline tests: bot/routememtest.js.

// ---- CONSTANTS ---------------------------------------------------------------------
const ROUTE_CAP = 16          // most routes we keep (home<->timber, home<->water, ...)
const WEDGE_CAP = 24          // most stuck-spots we keep
const WEDGE_MERGE_R = 3       // two wedges within 3b are the same obstacle -> bump n
const ROUTE_MIN_LEN = 64      // don't record a route shorter than this (nothing to reuse)
const ROUTE_LEN_SANITY = 1.6  // reject a "route" whose polyline is >1.6x the straight line
const ROUTE_MATCH_TOL = 24    // endpoints within 24b (either orientation) = the same route
const WEDGE_STEER_CORRIDOR = 2 // a wedge within 2b of a leg segment clips it
const INFRA_SUPPRESS_R = 12   // NEVER record/steer a wedge within 12b of our own infra
const H24 = 24 * 3600 * 1000
const D7 = 7 * 24 * 3600 * 1000

// ---- small geometry helpers (XZ plane) ---------------------------------------------
function dist (a, b) { return Math.hypot(a.x - b.x, a.z - b.z) }

// Perpendicular distance of point p from the segment a->b (XZ). Clamped to the segment,
// so an endpoint-nearby point reports its true (endpoint) distance, not the infinite line.
function pointToSegDist (p, a, b) {
  const abx = b.x - a.x; const abz = b.z - a.z
  const seg2 = abx * abx + abz * abz
  if (seg2 === 0) return dist(p, a)
  let t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / seg2
  if (t < 0) t = 0; else if (t > 1) t = 1
  const cx = a.x + t * abx; const cz = a.z + t * abz
  return Math.hypot(p.x - cx, p.z - cz)
}

// Turn angle (radians) at b for the path a->b->c: 0 = straight through, pi = doubles back.
function turnAngle (a, b, c) {
  const v1x = b.x - a.x; const v1z = b.z - a.z
  const v2x = c.x - b.x; const v2z = c.z - b.z
  const m1 = Math.hypot(v1x, v1z); const m2 = Math.hypot(v2x, v2z)
  if (m1 === 0 || m2 === 0) return 0
  let cos = (v1x * v2x + v1z * v2z) / (m1 * m2)
  if (cos > 1) cos = 1; else if (cos < -1) cos = -1
  return Math.acos(cos)
}

function polylineLength (pts) {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i])
  return L
}

// ---- thinPolyline: radial thinning, keep endpoints + corners -----------------------
// Two passes: (1) keep a point if it is >=minSpacing from the last kept point OR it is a
// corner (a real bearing change); (2) if still over maxN, drop the least-significant
// interior points (smallest perpendicular deviation from their neighbours) until it fits.
// Endpoints are ALWAYS preserved.
function thinPolyline (pts, maxN = 24, minSpacing = 12) {
  if (!Array.isArray(pts)) return []
  const p = pts.filter(q => q && typeof q.x === 'number' && typeof q.z === 'number').map(q => ({ x: q.x, z: q.z }))
  if (p.length <= 2) return p
  const CORNER = 25 * Math.PI / 180
  const kept = [p[0]]
  for (let i = 1; i < p.length - 1; i++) {
    const cur = p[i]
    const last = kept[kept.length - 1]
    const spacedFar = dist(cur, last) >= minSpacing
    const isCorner = turnAngle(last, cur, p[i + 1]) > CORNER
    if (spacedFar || isCorner) kept.push(cur)
  }
  kept.push(p[p.length - 1])
  // pass 2: Douglas-Peucker-style importance eviction down to the cap
  while (kept.length > maxN) {
    let bestI = -1; let bestDev = Infinity
    for (let i = 1; i < kept.length - 1; i++) {
      const dev = pointToSegDist(kept[i], kept[i - 1], kept[i + 1])
      if (dev < bestDev) { bestDev = dev; bestI = i }
    }
    if (bestI < 0) break
    kept.splice(bestI, 1)
  }
  return kept
}

// ---- canonEndpoints: lexicographic (x then z) order --------------------------------
// A route is undirected: home->timber and timber->home are the same line. Store it in a
// canonical endpoint order so a lookup finds it regardless of which way it was walked.
function canonEndpoints (a, b) {
  const A = { x: a.x, z: a.z }; const B = { x: b.x, z: b.z }
  if (A.x < B.x || (A.x === B.x && A.z <= B.z)) return [A, B]
  return [B, A]
}

// ---- matchRoute: both ends within tol, either orientation --------------------------
// Returns { route, reversed } or null. reversed=true means walk route.pts BACKWARDS
// (the caller is going b->a while the stored polyline runs a->b).
function matchRoute (routes, from, to, tol = ROUTE_MATCH_TOL) {
  if (!Array.isArray(routes)) return null
  for (const r of routes) {
    if (!r || !r.a || !r.b) continue
    if (dist(r.a, from) <= tol && dist(r.b, to) <= tol) return { route: r, reversed: false }
    if (dist(r.a, to) <= tol && dist(r.b, from) <= tol) return { route: r, reversed: true }
  }
  return null
}

// ---- routeCursor: index of the point AHEAD of pos (never backwards) ----------------
// Finds the polyline SEGMENT pos lies nearest (perpendicular, clamped), then aims at that
// segment's FAR endpoint - i.e. the next point along the direction of travel. Because it
// keys off which segment we're on rather than which vertex is nearest, re-solving the
// cursor each leg only ever moves FORWARD (it can never hand back a point already passed).
function routeCursor (pts, pos) {
  if (!Array.isArray(pts) || pts.length === 0) return 0
  if (pts.length === 1) return 0
  let bestSeg = 0; let bestDev = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const dev = pointToSegDist(pos, pts[i], pts[i + 1])
    if (dev < bestDev) { bestDev = dev; bestSeg = i }
  }
  return Math.min(bestSeg + 1, pts.length - 1)
}

// ---- route sanity + fail-decay -----------------------------------------------------
function routeLenOk (route) {
  if (!route || !route.a || !route.b) return false
  const straight = dist(route.a, route.b)
  if (straight <= 0) return false
  return (route.len || straight) <= ROUTE_LEN_SANITY * straight
}
// A route is worth replaying if it has net successes and passes the length sanity check.
function routeUsable (route) {
  return !!route && ((route.ok || 0) - (route.fail || 0)) > 0 && routeLenOk(route)
}
// 2 CONSECUTIVE fails evict (fail is zeroed on every success, so it only counts the run
// since the last time the route actually worked).
function routeShouldEvict (route) { return !!route && (route.fail || 0) >= 2 }

// ---- mergeRoute: add or refresh a route, capped -----------------------------------
// entry: { a, b, pts, len, at }. On a match (same endpoints, either orientation) the
// existing record is REFRESHED (fresh crumbs, ok++, fail reset, at bumped). Otherwise a
// new record is pushed; over the cap the least-valuable (lowest ok-fail, then oldest) is
// evicted.
function mergeRoute (routes, entry, cap = ROUTE_CAP) {
  const [a, b] = canonEndpoints(entry.a, entry.b)
  const m = matchRoute(routes, a, b, ROUTE_MATCH_TOL)
  if (m) {
    const r = m.route
    r.a = a; r.b = b
    r.pts = entry.pts
    r.len = entry.len
    r.ok = (r.ok || 0) + 1
    r.fail = 0
    r.at = entry.at
    return r
  }
  const rec = { a, b, pts: entry.pts, ok: 1, fail: 0, at: entry.at, len: entry.len }
  routes.push(rec)
  if (routes.length > cap) {
    routes.sort((x, y) => ((y.ok - y.fail) - (x.ok - x.fail)) || (y.at - x.at))
    routes.length = cap
  }
  return rec
}

// ---- wedge age-weight + merge/evict ------------------------------------------------
// Confidence decays with age: full inside 24h, half out to 7d, gone after (a place that
// wedged us a week ago may well be passable now - terrain, mobs, our own gear changed).
function wedgeWeight (w, now = Date.now()) {
  const age = now - (w.at || 0)
  if (age < H24) return 1
  if (age < D7) return 0.5
  return 0
}

// Record a wedge: merge into an existing one within WEDGE_MERGE_R (bump n, refresh at),
// else push. Dead (weight 0) entries are pruned first; over the cap the oldest is dropped.
function mergeWedge (wedges, pos, now = Date.now(), cap = WEDGE_CAP, mergeR = WEDGE_MERGE_R) {
  for (let i = wedges.length - 1; i >= 0; i--) if (wedgeWeight(wedges[i], now) <= 0) wedges.splice(i, 1)
  for (const w of wedges) {
    if (Math.hypot(w.x - pos.x, w.z - pos.z) <= mergeR) {
      w.n = (w.n || 1) + 1; w.at = now
      if (pos.y != null) w.y = Math.round(pos.y)
      return w
    }
  }
  const rec = { x: Math.round(pos.x), y: Math.round(pos.y != null ? pos.y : 0), z: Math.round(pos.z), at: now, n: 1 }
  wedges.push(rec)
  if (wedges.length > cap) { wedges.sort((a, b) => (b.at - a.at)); wedges.length = cap }
  return rec
}

// ---- wedgeOnSegment: any ACTIVE wedge within `corridor` of the leg p->q ------------
// Returns the offending wedge or null. Caller passes an already suppression-filtered,
// age-weighted list (see activeWedges); this only does the corridor geometry.
function wedgeOnSegment (wedges, p, q, corridor = WEDGE_STEER_CORRIDOR, now = Date.now()) {
  if (!Array.isArray(wedges)) return null
  for (const w of wedges) {
    if (wedgeWeight(w, now) <= 0) continue
    if (pointToSegDist(w, p, q) <= corridor) return w
  }
  return null
}

// ---- own-infra suppression (BOTH record + recall side) -----------------------------
// The #1 rule: the bot must NEVER avoid its own hut/build/bank, even if it wedged there.
// suppressedNearAnchors is the single predicate used on BOTH sides: at record time a pos
// this close to any anchor is not stored; at recall time every wedge is re-checked against
// the CURRENT anchor list before it may steer (so a hut built after a wedge, or a stale
// anchor, retroactively neutralises it).
function suppressedNearAnchors (anchors, pos, r = INFRA_SUPPRESS_R) {
  if (!Array.isArray(anchors)) return false
  for (const a of anchors) { if (Math.hypot(a.x - pos.x, a.z - pos.z) <= r) return true }
  return false
}

// Is any ACTIVE wedge within `r` (XZ) of point p? Used by gather target-selection to skip a
// site that just wedged us. Reuses wedgeWeight's age-decay - a wedge past its window weighs 0
// and no longer counts, so a re-grown/re-passable spot ages back in automatically (no
// permanent bans). Caller passes an already own-infra-suppressed list (listWedges).
function wedgeNearXZ (wedges, p, r = 8, now = Date.now()) {
  if (!Array.isArray(wedges) || !p) return false
  for (const w of wedges) {
    if (wedgeWeight(w, now) <= 0) continue
    if (Math.hypot(w.x - p.x, w.z - p.z) <= r) return true
  }
  return false
}

// The steer-eligible wedge list: alive (weight>0) AND not currently suppressed by infra.
function activeWedges (wedges, anchors, now = Date.now(), r = INFRA_SUPPRESS_R) {
  if (!Array.isArray(wedges)) return []
  return wedges.filter(w => wedgeWeight(w, now) > 0 && !suppressedNearAnchors(anchors, w, r))
}

// ---- WAYPOINT GRAPH (NAV_WAYPOINT_GRAPH, DESIGN-navigation-redesign §5 Phase 3) ----
// Promote the stored polylines (which matchRoute/routeCursor already replay whole) into a
// GRAPH so the Nth trek can COMPOSE proven segments from DIFFERENT routes instead of
// blind-planning: "these two half-routes share a river crossing". Nodes = thinned polyline
// points (+ infra anchors), junction-MERGED within GRAPH_JUNCTION_R (routes that pass close
// become one node -> a real junction); edges = consecutive polyline segments, each carrying
// its source route's ok/fail so a demented route makes its edges costlier; planOverGraph =
// Dijkstra from nearest-node(start) to nearest-node(goal). PURE math (no bot, no world, no fs)
// - offline-testable exactly like matchRoute/thinPolyline. The graph is READ-ONLY over route
// memory: it never mutates routes; dement/evict stays in the route records via their own replay
// (a composed edge whose route goes bad drops out of the graph automatically once routeUsable
// turns false). The FLAG is the CALLER's concern - it decides whether to build/consult a graph.
const GRAPH_JUNCTION_R = 12   // two waypoints within 12b are the SAME node (a shared corridor) - mirrors the 12b junction radius in the design
const GRAPH_MAX_NODES = 256   // HARD cap on graph size (bounded growth): routes are capped at 16, thinned <=24 pts each; extra points past the cap are dropped
const GRAPH_ENDPOINT_TOL = 24 // start/goal must snap to a graph node within 24b to plan over it (mirrors ROUTE_MATCH_TOL)

// Build the waypoint graph from usable route polylines + infra anchors. Returns { nodes, adj }
// where nodes[i] = {x,z} and adj[i] = Map(j -> { w, ok, fail }) (undirected, stored both ways).
// Junction-merge: a point within `junctionR` of an existing node REUSES that node (so two routes
// crossing near each other share the crossing node). Bounded to `maxNodes` (over-cap points are
// dropped, their edges skipped). Only routeUsable routes contribute (net successes, length-sane).
function buildGraph (routes, anchors, opts = {}) {
  const jr = opts.junctionR != null ? opts.junctionR : GRAPH_JUNCTION_R
  const cap = opts.maxNodes != null ? opts.maxNodes : GRAPH_MAX_NODES
  const nodes = []
  const adj = []
  const nodeIdAt = (p) => {
    for (let i = 0; i < nodes.length; i++) if (Math.hypot(nodes[i].x - p.x, nodes[i].z - p.z) <= jr) return i
    if (nodes.length >= cap) return -1
    nodes.push({ x: p.x, z: p.z }); adj.push(new Map())
    return nodes.length - 1
  }
  const addEdge = (i, j, route) => {
    if (i < 0 || j < 0 || i === j) return
    const w = dist(nodes[i], nodes[j])
    const ok = (route && route.ok) || 1
    const fail = (route && route.fail) || 0
    const cur = adj[i].get(j)
    if (!cur || w < cur.w) { const stat = { w, ok, fail }; adj[i].set(j, stat); adj[j].set(i, stat) }
  }
  for (const r of (routes || [])) {
    if (!routeUsable(r) || !Array.isArray(r.pts) || r.pts.length < 2) continue
    let prev = nodeIdAt(r.pts[0])
    for (let k = 1; k < r.pts.length; k++) {
      const cur = nodeIdAt(r.pts[k])
      addEdge(prev, cur, r)
      prev = cur
    }
  }
  for (const a of (anchors || [])) { if (a && typeof a.x === 'number' && typeof a.z === 'number') nodeIdAt(a) }
  return { nodes, adj }
}

// Index of the graph node nearest to p within `tol`, else -1.
function nearestNode (graph, p, tol = GRAPH_ENDPOINT_TOL) {
  if (!graph || !Array.isArray(graph.nodes) || !p) return -1
  let best = -1; let bestD = Infinity
  for (let i = 0; i < graph.nodes.length; i++) {
    const d = dist(graph.nodes[i], p)
    if (d < bestD) { bestD = d; best = i }
  }
  return (best >= 0 && bestD <= tol) ? best : -1
}

// Dijkstra over the graph from nearest-node(from) to nearest-node(goal). Edge cost = geometric
// length inflated by the edge's fail count (a demented segment is avoided when an alternative
// exists), so the plan prefers proven corridors. Returns the ordered {x,z} node list [start..goal]
// (length >= 2), or null if either endpoint has no node within `tol` or the two are disconnected.
function planOverGraph (graph, from, to, opts = {}) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length < 2) return null
  const tol = opts.endpointTol != null ? opts.endpointTol : GRAPH_ENDPOINT_TOL
  const s = nearestNode(graph, from, tol)
  const g = nearestNode(graph, to, tol)
  if (s < 0 || g < 0 || s === g) return null
  const n = graph.nodes.length
  const distTo = new Array(n).fill(Infinity)
  const prev = new Array(n).fill(-1)
  const done = new Array(n).fill(false)
  distTo[s] = 0
  for (;;) {
    let u = -1; let ud = Infinity
    for (let i = 0; i < n; i++) if (!done[i] && distTo[i] < ud) { ud = distTo[i]; u = i }
    if (u < 0 || u === g) break
    done[u] = true
    for (const [v, e] of graph.adj[u]) {
      const w = e.w * (1 + 2 * (e.fail || 0)) // a demented (fail>0) edge is inflated so A* routes around it
      if (distTo[u] + w < distTo[v]) { distTo[v] = distTo[u] + w; prev[v] = u }
    }
  }
  if (distTo[g] === Infinity) return null
  const path = []
  for (let u = g; u >= 0; u = prev[u]) path.push({ x: graph.nodes[u].x, z: graph.nodes[u].z })
  path.reverse()
  return path.length >= 2 ? path : null
}

module.exports = {
  ROUTE_CAP, WEDGE_CAP, WEDGE_MERGE_R, ROUTE_MIN_LEN, ROUTE_LEN_SANITY, ROUTE_MATCH_TOL,
  WEDGE_STEER_CORRIDOR, INFRA_SUPPRESS_R,
  GRAPH_JUNCTION_R, GRAPH_MAX_NODES, GRAPH_ENDPOINT_TOL,
  dist, pointToSegDist, turnAngle, polylineLength,
  thinPolyline, canonEndpoints, matchRoute, routeCursor,
  routeLenOk, routeUsable, routeShouldEvict, mergeRoute,
  wedgeWeight, mergeWedge, wedgeOnSegment, wedgeNearXZ,
  suppressedNearAnchors, activeWedges,
  buildGraph, nearestNode, planOverGraph
}
