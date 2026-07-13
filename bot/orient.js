'use strict'
// ORIENTED-BLOCK placement (pure): map a schematic blockstate's orientation PROPERTIES
// (facing / axis / half / type) to a placement directive, so oriented blocks (stairs, doors,
// logs, slabs, observers, ...) go down FACING THE RIGHT WAY. mineflayer-builder's getFacing
// already does this for blocks in its facingData.json - but it THROWS for blocks missing from
// that stale table (newer 1.21 cherry/bamboo/copper/pale_oak stairs+doors), and tryPlace then
// falls back to an UNORIENTED placement (mis-rotated stairs = a wrong-looking castle). This
// derives the orientation straight from the blockstate's `facing` STRING (always present),
// independent of the lib's table. PURE (props in, directive out) so it is offline-testable.

// Minecraft `facing` = the direction the block's front points. Unit vectors [dx,dy,dz].
const FACING_VEC = {
  north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0]
}
function facingVec (facingStr) { return FACING_VEC[facingStr] ? FACING_VEC[facingStr].slice() : null }

// A facing-bearing block is "3D" (its facing can point up/down, e.g. an observer/dispenser)
// vs horizontal-only (stairs/doors face N/S/E/W). Matches mineflayer-builder's facing3D flag.
function isFacing3D (facingStr) { return facingStr === 'up' || facingStr === 'down' }

// log/pillar `axis` -> the block axis vector. y = upright (default), x/z = laid horizontal.
const AXIS_VEC = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
function axisVec (axis) { return AXIS_VEC[axis] ? AXIS_VEC[axis].slice() : null }

// Is this a TOP half/slab (place against the upper part of the reference face)? Covers slab
// `type: top` and stairs/trapdoor `half: top`.
function isTopHalf (props) {
  const p = props || {}
  return p.type === 'top' || p.half === 'top' || p.half === 'upper'
}

// Resolve the orientation directive from a blockstate's properties. Returns:
//   { facing: [dx,dy,dz], is3D, kind: 'facing'|'axis', top } or null when the block is
// unoriented (a full cube). `kind:'facing'` -> pass facing to GoalPlaceBlock; `kind:'axis'` ->
// the log axis (the driver clicks the perpendicular face). `top` -> upper-half placement.
function resolveOrientation (props) {
  const p = props || {}
  const top = isTopHalf(p)
  if (p.facing && FACING_VEC[p.facing]) return { facing: facingVec(p.facing), is3D: isFacing3D(p.facing), kind: 'facing', top }
  if (p.axis && AXIS_VEC[p.axis]) return { facing: axisVec(p.axis), is3D: p.axis !== 'y', kind: 'axis', top }
  if (top) return { facing: null, is3D: false, kind: 'half', top } // a top slab with no facing
  return null
}

// The axis ('x'|'y'|'z') of a face-direction vector (Vec3-like {x,y,z} OR [dx,dy,dz]), or null
// if not a unit axis vector. A log placed against a face takes THAT face's axis.
function axisOfVec (v) {
  if (!v) return null
  const x = Math.abs(v.x != null ? v.x : (v[0] || 0))
  const y = Math.abs(v.y != null ? v.y : (v[1] || 0))
  const z = Math.abs(v.z != null ? v.z : (v[2] || 0))
  if (x && !y && !z) return 'x'
  if (y && !x && !z) return 'y'
  if (z && !x && !y) return 'z'
  return null
}

// LOG/PILLAR AXIS: restrict the clickable faces to those whose axis matches the desired log
// axis, so mineflayer-builder clicks a face that lays the log the RIGHT way (getFacing gives
// logs no facing -> they placed upright/default). If NO matching-axis face is reachable right
// now, returns all faces unchanged (can't orient this pass - better to place than to stall;
// a later pass may expose the right face). PURE.
function facesForAxis (faces, axis) {
  if (!Array.isArray(faces) || !axis) return faces || []
  const kept = faces.filter(f => axisOfVec(f) === axis)
  return kept.length ? kept : faces
}

module.exports = { FACING_VEC, AXIS_VEC, facingVec, isFacing3D, axisVec, isTopHalf, resolveOrientation, axisOfVec, facesForAxis }
