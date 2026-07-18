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

// NAV Phase B (NAV_HAZARD_LEGS): the lava-hazard STEP predicate. travelMovements/wildTerrain
// never priced lava at all (no liquidCost for it, and A* prices a lava-pool-edge cell like open
// ground) - so a surface trek could route a leg right to a pool edge. HAZARD_RE matches the two
// lava block names; HAZARD_STEP_COST is a HIGH but sub-forbid step surcharge: high enough that
// A* routes AROUND lava when any alternative exists, but < the library's cost>100 drop threshold
// (movements.js:388) so it degrades to a longer path rather than noPath when lava is unavoidable
// (worst case = today's route, never worse). HAZARD_OFFSETS are the cells sampled around a
// step-destination whose lava presence makes the destination a "pool edge": the standing/feet
// cell, the support block below, and the 4 horizontal neighbours at feet and support level.
const HAZARD_RE = /^(lava|flowing_lava)$/
const HAZARD_STEP_COST = 60
const HAZARD_OFFSETS = [
  [0, 0, 0], [0, -1, 0],
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]
]

// WATER_SAFE (task #45): the DEEP-water STEP predicate. liquidCost (=WILD_LIQUID_COST 4) already
// prices a water CROSSING cheaply - that keeps SHALLOW (1-deep, walkable) water free so the bot
// can still reach its river-farm / cast a fishing line (#24). What was unpriced is OVER-THE-HEAD
// water: a surface trek could route a leg straight into a pond aquifer and the bot drowned
// (live 2026-07-17 x2). WATER_STEP_COST is a soft, sub-100 surcharge (< lava's 60, > liquidCost 4):
// A* routes AROUND deep water when a dry alternative exists but degrades to the longer path
// (never noPath, movements.js cost>100 drop threshold) when deep water is unavoidable - so farm/
// fishing access is preserved. WATER_RE = the liquids that submerge (seagrass/kelp are decorations
// INSIDE water and don't change depth, so they're excluded here - only the water column matters).
const WATER_RE = /^(water|flowing_water|bubble_column)$/
const WATER_STEP_COST = 50

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

// The per-position STEP hazard exclusion (fed to Movements.exclusionAreasStep, style of
// cropExclusionStep). Returns HAZARD_STEP_COST if the step-destination `pos` is lava OR
// lava-adjacent (any HAZARD_OFFSETS neighbour is lava), else 0. PURE: the caller supplies
// `sampleName(x,y,z) -> blockName|null` (a live-world lookup at plan time); this module never
// touches the world. Bounded to HAZARD_OFFSETS.length reads per candidate cell.
function hazardExclusion (pos, sampleName) {
  if (!pos || typeof sampleName !== 'function') return 0
  for (const [dx, dy, dz] of HAZARD_OFFSETS) {
    const n = sampleName(pos.x + dx, pos.y + dy, pos.z + dz)
    if (n && HAZARD_RE.test(n)) return HAZARD_STEP_COST
  }
  return 0
}

// WATER_SAFE (task #45): the PURE deep-water STEP predicate. Returns WATER_STEP_COST iff STANDING
// at `pos` would put the head underwater or leave no floor to stand on (over-the-head DEEP water),
// else 0. Column-only (feet / head / below) - deliberately NOT neighbour-sampled like the lava
// HAZARD_OFFSETS: standing on the BANK BESIDE deep water is safe (and is exactly where the bot
// fishes / tends the river-farm), so an adjacent deep cell must never surcharge the dry bank cell.
// Lava surcharges neighbours because it flows/burns from adjacency; deep water only drowns you
// when you STAND in it. `sampleName(x,y,z) -> blockName|null` is the caller's live-world lookup.
//   feet not water          -> 0 (dry ground and bank cells stay free)
//   feet water + head water  -> DEEP (2+ deep, head submerged)
//   feet water + water below -> DEEP (no floor within stand reach - float/sink)
//   feet water + head air + solid floor below -> 0 (1-deep SHALLOW: walkable, stays cheap via liquidCost)
function deepWaterHazard (pos, sampleName) {
  if (!pos || typeof sampleName !== 'function') return 0
  if (!WATER_RE.test(sampleName(pos.x, pos.y, pos.z) || '')) return 0
  if (WATER_RE.test(sampleName(pos.x, pos.y + 1, pos.z) || '')) return WATER_STEP_COST
  if (WATER_RE.test(sampleName(pos.x, pos.y - 1, pos.z) || '')) return WATER_STEP_COST
  return 0
}

// WATER_ESCAPE (task #48): a nearest-REACHABLE-DRY-LAND finder (PURE). Where deepWaterHazard's
// name-only sampler answers "am I in deep water", this answers "where is the nearest cell I can
// STAND on, DRY, that I can actually swim/step to, biased toward the goal". It replaces the blind
// nearest-bank pickers (swimToShore/manualHopFromWater) that lock onto the geometrically-nearest
// solid-topped cell over 8 fixed rays - IGNORING the goal, and never checking that the water
// between the bot and that cell is swimmable - so they hold controls into a walled bank and the
// bot burns 15s "still wet" (design §2a). Two fixes at the source:
//   1. FLOOD-FILL through WATER from the bot's feet cell (6-connected) instead of 8 blind rays: a
//      solid wall (not water) blocks the fill, so a bank behind terrain is NEVER returned - only a
//      cell with a real swim corridor is (design §2a-1 / test b).
//   2. a GENUINELY-DRY, CLIMBABLE test (mirrors swimToShore's bank test navigate.js:134-139, but
//      DRY not merely "not water"):
//        - floor (ny-1) is a full solid block, not water/lava   [opts.solidAt if given, else a
//          name heuristic so the fn stays pure/unit-testable like deepWaterHazard];
//        - feet (ny) AND head (ny+1) are AIR - a 1-deep shelf where feet=water is REJECTED, closing
//          the "declare victory in the surf" hole (design §2b/§3a / test c);
//        - CLIMBABLE: the stand cell sits at Δy in {0,+1} above a reachable SURFACE water cell
//          (a step up of at most one). An unclimbable 2-b lip is skipped (design §3a / test d),
//          a reachable +1 lip is returned (test e).
// Ties are broken by PROJECTION onto goalDir (leave the pond on the side TOWARD the build - this
// is what stops the §2c south-drift at the source, test a), then by distance. Bounded: XZ within
// maxR, Y within +-ySpan of the seed, and a hard visited cap. Returns the best {x,y,z,dir} or null.
const AIR_RE = /^(air|cave_air|void_air)$/
// Names that read as "not air/water/lava" but are NOT a full standable floor block. Only consulted
// in the pure/name-heuristic path (tests + no-solidAt callers); the live wrapper passes opts.solidAt
// = a real boundingBox check, which is authoritative.
const DRY_FLOOR_NONSOLID_RE = /sapling|_propagule$|grass$|short_grass|tall_grass|fern|flower|dead_bush|vine|kelp|seagrass|lily_pad|torch|_sign$|button|lever|rail$|carpet$|^snow$|pressure_plate|tripwire|_bed$|banner|sea_pickle|cobweb|sea_grass|bubble_column/
function _isSolidName (n) {
  if (!n) return false
  if (AIR_RE.test(n)) return false
  if (WATER_RE.test(n)) return false
  if (/lava/.test(n)) return false
  if (DRY_FLOOR_NONSOLID_RE.test(n)) return false
  return true
}
function _norm2 (v) {
  if (!v) return null
  const n = Math.hypot(v.x || 0, v.z || 0)
  if (!n) return null
  return { x: (v.x || 0) / n, z: (v.z || 0) / n }
}
const DRY_EXIT_YSPAN = 6
function findDryLandExit (feet, sampleName, opts = {}) {
  if (!feet || typeof sampleName !== 'function') return null
  const maxR = opts.maxR || 16
  const ySpan = opts.ySpan || DRY_EXIT_YSPAN
  const goalDir = _norm2(opts.goalDir)
  const solidAt = (typeof opts.solidAt === 'function') ? opts.solidAt : (x, y, z) => _isSolidName(sampleName(x, y, z))
  const isWater = (x, y, z) => WATER_RE.test(sampleName(x, y, z) || '')
  const isAir = (x, y, z) => AIR_RE.test(sampleName(x, y, z) || '')
  // Seed the swim-corridor fill from a water cell at/near the feet (a treading bot may bob with its
  // feet momentarily in the air just above the surface, so scan a little down/up). No water => the
  // bot isn't in a pond and there is nothing to escape.
  let seed = null
  for (const dy of [0, -1, 1, -2]) { if (isWater(feet.x, feet.y + dy, feet.z)) { seed = { x: feet.x, y: feet.y + dy, z: feet.z }; break } }
  if (!seed) return null
  const key = (x, y, z) => x + ',' + y + ',' + z
  const seen = new Set([key(seed.x, seed.y, seed.z)])
  const q = [seed]
  let budget = opts.maxVisited || 6000
  let best = null
  const consider = (nx, ny, nz) => {
    if (!solidAt(nx, ny - 1, nz)) return               // floor must be a full solid block (not water/lava)
    if (!isAir(nx, ny, nz) || !isAir(nx, ny + 1, nz)) return // genuinely DRY: feet + head both air (rejects a 1-deep shelf)
    const dxg = (nx + 0.5) - (feet.x + 0.5); const dzg = (nz + 0.5) - (feet.z + 0.5)
    const dist = Math.hypot(dxg, dzg)
    const proj = goalDir ? (dxg * goalDir.x + dzg * goalDir.z) : 0
    const cand = { x: nx, y: ny, z: nz, dist, proj }
    const wins = !best
      ? true
      : (goalDir ? (cand.proj > best.proj || (cand.proj === best.proj && cand.dist < best.dist)) : (cand.dist < best.dist))
    if (wins) best = cand
  }
  const NB = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]
  const HOR = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  while (q.length && budget-- > 0) {
    const w = q.shift()
    // A SURFACE water cell (air, not water, directly above) is one the bot can float to and step
    // out of. From it, a horizontal neighbour column at Δy in {0,+1} is a candidate dry-land exit.
    if (!isWater(w.x, w.y + 1, w.z)) {
      for (const [dx, dz] of HOR) for (const dy of [0, 1]) consider(w.x + dx, w.y + dy, w.z + dz)
    }
    for (const [dx, dy, dz] of NB) {
      const nx = w.x + dx; const ny = w.y + dy; const nz = w.z + dz
      if (Math.abs(nx - seed.x) > maxR || Math.abs(nz - seed.z) > maxR || Math.abs(ny - seed.y) > ySpan) continue
      const k = key(nx, ny, nz)
      if (seen.has(k)) continue
      if (!isWater(nx, ny, nz)) continue // the fill only crosses WATER - a wall/terrain blocks it (corridor guarantee)
      seen.add(k); q.push({ x: nx, y: ny, z: nz })
    }
  }
  if (!best) return null
  const bdist = best.dist || 1
  return { x: best.x, y: best.y, z: best.z, dir: { x: ((best.x + 0.5) - (feet.x + 0.5)) / bdist, z: ((best.z + 0.5) - (feet.z + 0.5)) / bdist } }
}

module.exports = {
  WILD_DIG_COST,
  HAZARD_RE,
  HAZARD_STEP_COST,
  hazardExclusion,
  WATER_RE,
  WATER_STEP_COST,
  deepWaterHazard,
  findDryLandExit,
  WILD_LIQUID_COST,
  INFRA_BREAK_RADIUS,
  WILD_SCOPE_RADIUS,
  SCAFFOLD_BREAK_RE,
  canWildBreakType,
  wildAllowedAt,
  breakExclusion
}
