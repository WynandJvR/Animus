'use strict'
// PURE leg-planning core (NAV Phase B, DESIGN-nav-overhaul.md §3 Phase B). Owns the Y-band
// decision a SURFACE trek's leg goal makes so the whole policy is offline-testable (style of
// nav-profile.js / route-mem.js): given a pathfinder node {x,y,z}, the leg's XZ target, the
// trek's reference surface Y and a max-drop K, decide whether the node has ARRIVED (isEnd) and
// how much to PENALIZE it for sinking below the surface band (heuristic).
//
// WHY: GoalNearXZ ignores Y entirely - its isEnd is satisfied by ANY Y at the target XZ, so A*
// was free to ride a cave mouth ~45b DOWN and call the leg "arrived" on a lava-pool edge (#41,
// two lava deaths). The Y-band folds the intent of the reactive #41 depth-guard into the leg
// GOAL at PLAN time: a leg can no longer be satisfied K+ blocks below the surface it set off
// from, and A* is steered to keep the whole route near the surface. This does NOT block final
// trek arrival (walkStaged/travelFar arrive on an independent XZ check) and does NOT touch
// mining descents (branchMine goes deep on its own, never through a walkStaged/travelFar leg).
//
// NO requires on bot modules or the world: the caller supplies the node + surfaceRef; the Goal
// class is built by injecting the pathfinder's Goal base (makeGoalNearXZBanded) so this module
// stays a pure, dependency-free policy. The FLAG (NAV_HAZARD_LEGS) is the CALLER's concern -
// with it off the caller builds a plain GoalNearXZ and this module is never consulted.

const DEFAULT_MAX_DROP = 18   // K: a leg may satisfy at most this many blocks below surfaceRef (matches the #41 depth-guard's 18b band, folded in at plan time)
const DEPTH_PENALTY = 100     // heuristic surcharge PER block below the band floor - dwarfs the octile XZ term (legs <= 48b) so A* keeps the leg near the surface

// pathfinder's octile XZ distance (goals.js distanceXZ), reproduced so the heuristic is on the
// same scale as GoalNearXZ's (the term A* would otherwise use unmodified above the band).
function distanceXZ (dx, dz) {
  dx = Math.abs(dx); dz = Math.abs(dz)
  return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2
}

// How many blocks is `y` below the band floor (surfaceRef - maxDrop)? 0 if on/above the floor.
function depthBelowBand (y, surfaceRef, maxDrop) {
  const floor = surfaceRef - maxDrop
  return y < floor ? (floor - y) : 0
}

// isEnd for a Y-banded XZ leg goal: within the XZ range AND not sunk below the band. Rejecting
// a deep cell is exactly what stops A* from "arriving" 45b down a cave at the target's XZ.
function bandedIsEnd (node, x, z, rangeSq, surfaceRef, maxDrop) {
  const dx = x - node.x, dz = z - node.z
  if ((dx * dx + dz * dz) > rangeSq) return false
  return depthBelowBand(node.y, surfaceRef, maxDrop) === 0
}

// heuristic for the Y-banded goal: octile XZ distance (identical to GoalNearXZ above the band)
// + a per-block surcharge for every block below the band floor, so A* explores surface routes
// first and only dives when nothing shallower reaches the XZ target. Inadmissible on purpose
// (we WANT the search biased away from depth); the library tolerates a non-admissible heuristic.
function bandedHeuristic (node, x, z, surfaceRef, maxDrop) {
  return distanceXZ(x - node.x, z - node.z) + DEPTH_PENALTY * depthBelowBand(node.y, surfaceRef, maxDrop)
}

// Build a Y-banded GoalNearXZ by injecting the pathfinder's Goal base class (keeps THIS module
// dependency-free / offline-testable). The returned class is a drop-in for goals.GoalNearXZ
// with two extra ctor args (surfaceRef, maxDrop) and Y-aware isEnd/heuristic.
function makeGoalNearXZBanded (GoalBase) {
  return class GoalNearXZBanded extends GoalBase {
    constructor (x, z, range, surfaceRef, maxDrop = DEFAULT_MAX_DROP) {
      super()
      this.x = Math.floor(x)
      this.z = Math.floor(z)
      this.rangeSq = range * range
      this.surfaceRef = Math.floor(surfaceRef)
      this.maxDrop = maxDrop
    }

    heuristic (node) { return bandedHeuristic(node, this.x, this.z, this.surfaceRef, this.maxDrop) }
    isEnd (node) { return bandedIsEnd(node, this.x, this.z, this.rangeSq, this.surfaceRef, this.maxDrop) }
  }
}

module.exports = {
  DEFAULT_MAX_DROP,
  DEPTH_PENALTY,
  distanceXZ,
  depthBelowBand,
  bandedIsEnd,
  bandedHeuristic,
  makeGoalNearXZBanded
}
