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

// ==== A DIG COSTS WHAT IT COSTS: TIME (2026-08-26, live) =====================================
// mineflayer-pathfinder prices a dig as (1 + 3 * digSeconds) * digCost and REFUSES any move whose
// total cost passes 100 (movements.js `if (cost > 100) return`). digCost was 20 - "dig only when
// the walk-around is massively worse" - which read well and meant, in the library's arithmetic,
// that a bare-hand stone dig (7.5s) cost 470: not expensive, FORBIDDEN. So the planner could not
// carve one step out of a hole without a pickaxe, said `noPath` at spawn's crater, and 2,200 lines
// of hand-written rescue rungs took over and dug the bot sideways and deeper. Every pit deeper
// than one jump, entered with an empty pack, was a trap by pricing.
// The honest unit is the one the planner already uses: ONE = one block walked. A player walks
// WALK_BPS blocks per second, so t seconds of digging is worth WALK_BPS*t blocks of walking, and
// digCost = WALK_BPS/3 makes the library's formula read exactly that (plus its own ~1.4 fixed
// overhead per dig). Bare-hand dirt (0.75s) ~ 4.6 blocks; stone with a wooden pick (1.15s) ~ 6.4;
// bare-hand stone ~ 34 (a player will not punch stone to save thirty blocks, but WILL to leave a
// hole); obsidian (250s) ~ 1000, still impossible. Nothing here is tuned to a hole: A* weighs
// "carve" against "walk around" by the same clock in every geometry. Derived, not chosen.
// liquidCost 4: route AROUND water (NAV-P0 / gatherMovements precedent); 16b positional break
// gate around own infra; 32b scope gate for switching the profile on at all.
const WALK_BPS = 4.3 // a property of Minecraft (sprint-walk ~4.3 blocks/s), not a knob - the ONE definition
const WILD_DIG_COST = WALK_BPS / 3
const WILD_LIQUID_COST = 4
const INFRA_BREAK_RADIUS = 16
const WILD_SCOPE_RADIUS = 32
// The two FILLER_RE members (scaffold.js FILLER_RE) that are NOT already natural terrain in
// DIGGABLE_NATURAL - i.e. the only scaffold materials that need the per-position registry gate.
// Everything else in FILLER_RE (dirt/stone/gravel/andesite/...) is natural terrain, already
// whitelisted as such and breakable anywhere the positional gate permits.
const SCAFFOLD_BREAK_RE = /^(cobblestone|cobbled_deepslate)$/

// ==== AUDIT 2026-07-29: ONE DEFINITION OF "CAN I STAND IN THIS CELL" =====================
// Six places decided this independently and every one of them decided it slightly differently:
//   shelter.feetCellDry        strict, dry, checks the sides   (the most correct of the six)
//   pocket-escape.isBankCell   airish + solid below
//   navigate.fleeSteerTarget   `!solidAt(feet)` - and WATER IS NOT SOLID
//   navigate.swimToShore       accepts water as body space (deliberate: it is a swim target)
//   provision.manualHopFromWater  same as swimToShore
//   provision-shelter.findDiggableDryCell  delegates to feetCellDry
// ...on top of THREE different ideas of "airish": shelter.js counts `null` (an unknown/unloaded
// cell) as air, provision-core.js does not, pocket-escape.js uses a strict regex.
//
// What that cost, live on 2026-07-29: the bot fled a creeper straight into a lake and drowned.
// fleeSteerTarget asks `solidAt(feet) === false` to mean "clear", and a water cell is not solid -
// so a lake with a sand bottom reads as perfectly walkable. `liquidCost` cannot help, because a
// reactive flee drives the controls directly and never consults the pathfinder at all.
//
// This is that decision, once. The difference between "somewhere dry to stand" and "somewhere to
// swim toward" is now a NAMED ARGUMENT rather than six hand-written variants that each forgot
// something different.
//
// PURE: names + a solidity boolean in, a verdict out. `groundSolid` is the caller's boundingBox
// read (a block property, not a name) so this stays free of prismarine types.
const STAND_WATER_RE = /water|seagrass|kelp|bubble_column/
const STAND_LAVA_RE = /lava/
const STAND_AIR_RE = /^(air|cave_air|void_air)$/
function standable ({ groundSolid, ground, feet, head }, opts = {}) {
  const allowWater = !!opts.allowWater
  // UNKNOWN IS NEVER STANDABLE. shelter.js's AIRISH treats null as air, which is a fail-OPEN on an
  // unloaded cell - exactly the class of bug the grounded-claims work removed everywhere else.
  if (feet == null || head == null) return false
  if (groundSolid === false) return false
  if (ground != null && (STAND_WATER_RE.test(ground) || STAND_LAVA_RE.test(ground))) return false // no floor
  // Lava is never acceptable body space, whatever allowWater says.
  if (STAND_LAVA_RE.test(feet) || STAND_LAVA_RE.test(head)) return false
  const okBody = n => STAND_AIR_RE.test(n) || (allowWater && STAND_WATER_RE.test(n))
  return okBody(feet) && okBody(head)
}

// ==== "AFTER I TAKE THIS BLOCK, CAN I CLIMB OUT OF THE CELL I JUST MADE?" (2026-08-02) ====
// The bot died of a FALL at (190,64,-103) into one of its own holes. The dig that makes those
// holes (provision-recovery.ensurePillarFiller, the filler dig that feeds a pillar-out) asked a
// weaker question - "is the block BELOW my candidate solid?" - which is true of every block on a
// hillside. At (202,65,-103) y64 was solid, so the guard passed; but the rim around the emptied
// cell stands two blocks up on a slope, so ONE legal dig leaves a pocket the bot cannot step out
// of. It then walks into it (the dig steps onto the cell to collect the drop), and the pit rung,
// the pillar and eventually a fall get to pay for it.
//
// The right question is the one a player asks before digging down: where do I end up, and can I
// get out? Answering it as a RESCUE (widen detectPit, pillar out) is a second copy of the escape
// rule and only pays after the bot is already stuck; PREVENTION is the root (#1).
//
// PURE, and it reuses `standable` above rather than inventing a seventh idea of "can I stand
// here" - the whole reason that function exists. `sample(x,y,z) -> { name, solid } | null` is the
// caller's world read, and the caller is expected to report cells IT HAS ALREADY REMOVED THIS
// PASS as air, so a chain of legal digs cannot quietly excavate a trench.
//
// Verdicts (null = the dig is safe; a string = the reason it is refused, for the log):
//   'nofloor'  the cell below the candidate is not solid (or unreadable): removing the block
//              drops me FURTHER than I dug. This is the old guard's question, kept as one arm.
//   'boxed'    I could stand in the emptied cell, and none of its 4 neighbours is standable at
//              the same level or one step up - a pocket with no rim to climb.
//   'unknown'  an unreadable (unloaded) cell in the answer. Fails CLOSED, exactly as `standable`
//              treats an unknown cell: never dig on a guess.
//   null       either the emptied cell is a NICHE the body cannot occupy at all (a solid block
//              above it: no pit is created), or it has a climbable rim.
const RIM_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const STEP_UP = 1 // vanilla step height - a rim one block up is walkable, two blocks up is a wall
function digEscapeVerdict (cell, sample) {
  if (!cell || typeof sample !== 'function') return 'unknown'
  const at = (x, y, z) => { try { return sample(x, y, z) || null } catch { return null } }
  const floor = at(cell.x, cell.y - 1, cell.z)
  if (!floor) return 'unknown'
  if (!floor.solid) return 'nofloor'
  const head = at(cell.x, cell.y + 1, cell.z)
  if (!head) return 'unknown'
  if (head.solid) return null // a niche in a wall: the body cannot occupy it, so it is not a pit
  for (const [dx, dz] of RIM_DIRS) {
    for (let dy = 0; dy <= STEP_UP; dy++) {
      const x = cell.x + dx; const y = cell.y + dy; const z = cell.z + dz
      const g = at(x, y - 1, z); const f = at(x, y, z); const h = at(x, y + 1, z)
      if (standable({
        groundSolid: g ? g.solid : false,
        ground: g ? g.name : null,
        feet: f ? f.name : null,
        head: h ? h.name : null
      })) return null
    }
  }
  return 'boxed'
}

// ==== AUDIT 2026-07-29: ONE DEFINITION OF "HOW THIS BOT ENTERS WATER" ====================
// FIX 23 (commit b7bd94b) gave the DEFAULT profile a liquidCost because it was the only one of
// FOUR that swam for free. That was the wrong shape of fix: there are SIX Movements profiles, not
// four, and water policy is hand-copied into each one. So each profile forgot a DIFFERENT half:
//
//   profile                            liquidCost   infiniteLiquidDropdownDistance
//   travelMovements   commands.js       4            false
//   setupMovements    commands.js       4 (FIX 23)   *** library default: true ***
//   gatherMovements   provision.js      4            *** library default: true ***
//   trekMovements     provision.js      4            false
//   climbMovements    provision-mining  *** 1 ***    *** true ***
//   buildMovements    schematic.js      *** 1 ***    *** true ***
//
// Both defaults are drowning vectors, and the second is the nastier one: with
// infiniteLiquidDropdownDistance true the pathfinder deliberately plans a drop of ANY height into
// water (movements.js getMoveDropDown:487 only bounds the fall when the flag is false). The bot
// does not stumble into the pond - A* aims it off the cliff.
//
// Patching the four missing cells would be the fifth round of the same whack-a-mole. This is the
// structural fix: ONE function that stamps water policy onto ANY Movements instance, called at
// every `new Movements` site, with a source-scanning ANTI-DRIFT pin in standabletest.js so a
// SEVENTH profile cannot be added without it.
//
// Deliberately NARROW: this owns only "what does water cost, and may we fall into it". maxDropDown,
// canDig, parkour and pillaring legitimately differ per profile and are NOT unified here - a stamp
// that flattened those would break the climb/build profiles it is meant to protect.
// Both settings are COST-ONLY or fall-bounding, never a forbid: shallow crossings, the river farm
// and the fishing spot all stay reachable.
function waterPolicy (m) {
  if (!m) return m
  m.liquidCost = WILD_LIQUID_COST
  // Guarded `in` checks: older pathfinder builds lack the field, and blind assignment would add a
  // dead property that reads as configured. Absent field => the library cannot bound the drop and
  // there is nothing to set; present => bound it to maxDropDown, whatever this profile set that to.
  if ('infiniteLiquidDropdownDistance' in m) m.infiniteLiquidDropdownDistance = false
  return m
}

// ==== ONE DEFINITION OF "IS THE ESCAPE ACTUALLY FINISHED?" (2026-07-30) ==================
// TWO DEATHS, ten minutes apart, both preceded by the escape announcing success:
//   10:34:33 [nav] drown-escape: out of the water at (-8, 62, 117)   <- claimed, maneuver ENDED
//   10:34:43 (death) at -8,62,115 (drowning - Drowned, via message)
//   10:35:50 (death) at -9,62,110 (drowning - Drowned, via message)
// `rung rise` swims UP the water column until the HEAD clears. escapeWater's loop condition was
// `headInWater(bot)`, so a bot bobbing at the surface satisfied it: the ladder stopped, the maneuver
// ENDED and released the body, and a bot that is treading water with nothing underfoot SINKS. It
// drowned holding a success claim. Meanwhile its caller (index.js, WATER_ESCAPE=1) judged by the
// FEET and said "still wet" 1ms later - two predicates for one question, and the escape could not
// satisfy its own caller by construction.
//
// The two questions are genuinely different and BOTH stay:
//   "am I in danger?" -> the HEAD and air. Unchanged; still what TRIGGERS the reflex.
//   "am I done?"      -> do I have a FLOOR. That is this predicate.
// Treading water is head-clear-with-no-floor - precisely the state the old test called success.
//
// The log contains the proof this is right: at 10:35:27, when `rise` was REVOKED instead of
// believed, the ladder escalated - "bank is 1.3b away - hopping" - and the bot got out and lived.
// The ladder HAS a working rung; the false success stopped it from ever reaching it. Escalating is
// what saves the bot; releasing the body early is what kills it.
//
// PURE: names + the caller's boundingBox read. UNKNOWN fails CLOSED (keep working the bounded
// ladder) - the same rule standable() uses, for the same reason.
function escapeComplete ({ head, groundSolid }) {
  if (head == null) return false
  if (STAND_WATER_RE.test(head) || STAND_LAVA_RE.test(head)) return false // still submerged
  return groundSolid === true                                            // no floor => afloat => not out
}

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
// canBreakNaturally's compound (provision.js canBreakNaturally) - cobble is admitted at the TYPE level ONLY
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
//   2. a GENUINELY-DRY, CLIMBABLE test (mirrors swimToShore's bank test in navigate.js swimToShore, but
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
  standable,
  digEscapeVerdict,
  escapeComplete,
  waterPolicy,
  WILD_LIQUID_COST,
  WILD_DIG_COST,
  WALK_BPS,
  HAZARD_STEP_COST,
  hazardExclusion,
  WATER_RE,
  WATER_STEP_COST,
  deepWaterHazard,
  findDryLandExit,
  INFRA_BREAK_RADIUS,
  WILD_SCOPE_RADIUS,
  SCAFFOLD_BREAK_RE,
  canWildBreakType,
  wildAllowedAt,
  breakExclusion
}
