'use strict'
// PURE nav-terrain policy core (NAV Phase 1, DESIGN-navP1-terrain-profile §4.1). Owns every
// decision the wild-terrain Movements profile makes so the whole policy is offline-testable
// (style of route-mem.js / mining.js / pocket-escape.js): the Movements-level type whitelist,
// the selector's scope gate, and the per-position break exclusion (the six-layer anti-grief
// positional gate + the registry-definitive own-scaffold permission).
//
// NO requires on bot modules (provision passes its regexes/predicates in - no cycle). This is
// PURE geometry + regex: the caller supplies the anchors array, the buildZone box, the block
// name/position, and the scaffold-registry lookup; this module never touches the world or the
// filesystem. The FLAG (NAV_TERRAIN_PROFILE) is the CALLER's concern - this module is inert
// data until the selector chooses to consult it.

// digCost 20: dig only when the walk-around is massively worse (precedent gatherMovements 10);
// liquidCost 4: route AROUND water (NAV-P0 / gatherMovements precedent); 16b positional break
// gate around own infra; 32b scope gate for switching the profile on at all.
const WILD_DIG_COST = 20
const WILD_LIQUID_COST = 4
const INFRA_BREAK_RADIUS = 16
const WILD_SCOPE_RADIUS = 32
// The two FILLER_RE members (scaffold.js:93) that are NOT already natural terrain in
// DIGGABLE_NATURAL - i.e. the only scaffold materials that need the per-position registry gate.
// Everything else in FILLER_RE (dirt/stone/gravel/andesite/...) is natural terrain, already
// whitelisted as such and breakable anywhere the positional gate permits.
const SCAFFOLD_BREAK_RE = /^(cobblestone|cobbled_deepslate)$/

// Movements-level TYPE whitelist for the wild profile. The first clause is byte-identical to
// canBreakNaturally's compound (provision.js:332) - cobble is admitted at the TYPE level ONLY
// via SCAFFOLD_BREAK_RE, and its per-position registry gate then lives in breakExclusion (c).
// No log permission here (isWildTreeLog is positional/contextual and stays in the per-block
// gather/wetbreach predicates that re-read every block at dig time).
function canWildBreakType (name, diggableRe, structureRe) {
  if (!name) return false
  return (diggableRe.test(name) && !structureRe.test(name)) || /_leaves$/.test(name) || SCAFFOLD_BREAK_RE.test(name)
}

// XZ distance from a pos {x,z} (or Vec3) to an anchor {x,z}.
function _dist (a, pos) { return Math.hypot(a.x - pos.x, a.z - pos.z) }
// Is pos inside the buildZone box grown by `pad` on every XZ side? (buildZone = {x1,x2,z1,z2}.)
function _inBuildZonePad (buildZone, pos, pad) {
  if (!buildZone) return false
  return pos.x >= buildZone.x1 - pad && pos.x <= buildZone.x2 + pad &&
         pos.z >= buildZone.z1 - pad && pos.z <= buildZone.z2 + pad
}

// The SELECTOR's scope gate: may the wild (dig-capable) profile be used at pos AT ALL?
// False (=> caller falls back to today's no-dig profile) if any anchor is within
// WILD_SCOPE_RADIUS XZ, or pos is inside buildZone grown by 32. Null buildZone tolerated.
function wildAllowedAt (anchorsXZ, buildZone, pos) {
  if (!pos) return false
  for (const a of (anchorsXZ || [])) { if (a && _dist(a, pos) <= WILD_SCOPE_RADIUS) return false }
  if (_inBuildZonePad(buildZone, pos, WILD_SCOPE_RADIUS)) return false
  return true
}

// The per-position break exclusion (fed to Movements.exclusionAreasBreak). Returns 100
// (=> library FORBIDS the break inside safeToBreak, movements.js:273) if:
//   (a) any anchor within INFRA_BREAK_RADIUS XZ of pos - TYPE-INDEPENDENT (near home even
//       natural dirt is planner-unbreakable: protects own permanent fabric that is plain dirt);
//   (b) buildZone non-null and pos inside buildZone grown by 16 - TYPE-INDEPENDENT;
//   (c) the block is a scaffold material (cobble/cobbled_deepslate) and the registry does NOT
//       prove the bot placed it as scaffold (the row-19 positive, expiring permission).
// Else 0. isScaffold is the registry lookup (pos -> bool), passed in by the caller.
function breakExclusion (anchorsXZ, buildZone, name, pos, isScaffold) {
  if (!pos) return 0
  for (const a of (anchorsXZ || [])) { if (a && _dist(a, pos) <= INFRA_BREAK_RADIUS) return 100 }
  if (_inBuildZonePad(buildZone, pos, INFRA_BREAK_RADIUS)) return 100
  if (SCAFFOLD_BREAK_RE.test(name) && !(isScaffold && isScaffold(pos))) return 100
  return 0
}

module.exports = {
  WILD_DIG_COST,
  WILD_LIQUID_COST,
  INFRA_BREAK_RADIUS,
  WILD_SCOPE_RADIUS,
  SCAFFOLD_BREAK_RE,
  canWildBreakType,
  wildAllowedAt,
  breakExclusion
}
