'use strict'
// MINING STRATEGY (pure planning logic): the depth model, descent-safety classification,
// and branch-mine geometry that bot/provision.js's branchMine() drives. Kept PURE (block
// NAME strings + numbers in, decisions out - no bot, no I/O) so it is offline-testable
// (bot/miningtest.js), mirroring hut-model.js / planner.js.
//
// Why this exists (diagnosis, user-confirmed live):
//   - TOO SHALLOW: the old gather stopped at y30 (STRIP_FLOOR). Modern iron is a triangle
//     peaking ~y16 and common through the deepslate transition - y30 mines the sparse
//     upper tail (~1 iron in 7 min). We target ~y16.
//   - MOLE SCARRING: it sank up to 10 SEPARATE vertical shafts, each with its own climb-out
//     staircase, never backfilled - pockmarked terrain. A branch mine is ONE descent + a
//     corridor with perpendicular branches: far more ore per hole, back-out-able.
//
// The honest depth-vs-danger tradeoff (documented in docs/mining-strategy-design.md): deeper
// = more iron but more lava lakes + mob spawns for a lightly-armored bot - which is WHY it
// was capped shallow. y16 is the sweet spot: a big yield jump from y30 while sitting ABOVE
// the bulk of the deep lava lakes (mostly y<=-8). Going into deepslate (y0..-16) is a later,
// armor-gated slice. Mitigations here + in the driver: never dig into lava (probe below
// before each step), torch-light against spawns, and the deployed efba7bd mid-mine survival
// reflex (climb out / bail when a mob closes or hp crashes).

const LAVA_RE = /lava/
const WATER_RE = /water|seagrass|kelp|bubble_column/
const AIRISH = n => n === 'air' || n === 'cave_air' || n === 'void_air' || n == null

// Compass directions as [dx, dz]: 0=E, 1=S, 2=W, 3=N. A branch mine's left/right branches
// are the two directions PERPENDICULAR to the corridor.
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
function perpendicular (dirIdx) {
  const i = ((dirIdx % 4) + 4) % 4
  return [(i + 1) % 4, (i + 3) % 4] // [left, right]
}

// The Y to run the branch mine at. Target the iron-rich band (~y16 by default) but never
// below the hard safety floor (default y5 - well above the deep lava lakes) and never so
// high it wouldn't actually descend (must be at least 3 below where we start). Clamped, so
// a low-surface (mesa valley) start still returns a sane, reachable level.
function targetMineY (surfaceY, opts = {}) {
  const target = opts.targetY != null ? opts.targetY : 16
  const hardFloor = opts.hardFloor != null ? opts.hardFloor : 5
  const cap = Math.floor(surfaceY) - 3 // must descend at least 3 to be a mine, not a scrape
  return Math.max(hardFloor, Math.min(target, cap))
}

// ---- tool sufficiency at depth (self-sufficient mining) -------------------------------
// A deep branch mine WEARS OUT pickaxes (a stone pick = 131 uses). If a pick breaks at depth
// the planner would drag the bot ALL THE WAY back to the surface crafting table - and on
// cave/water terrain that climb-back strands it (live). So branchMine must guarantee tool
// sufficiency at depth: provision enough picks up front + re-tool AT DEPTH when one runs low.
const PICK_USES = { wooden: 59, golden: 32, stone: 131, iron: 250, diamond: 1561, netherite: 2031 }
function pickMaxUses (name) { const m = String(name || '').match(/^(wooden|golden|stone|iron|diamond|netherite)_pickaxe$/); return m ? PICK_USES[m[1]] : 0 }
// Uses remaining on ANY tool given its durabilityUsed - vanilla tool durability is per MATERIAL
// (wood 59, gold 32, stone 131, iron 250, diamond 1561, netherite 2031), the SAME table as
// pickaxes, so PICK_USES covers pickaxe/axe/sword/shovel/hoe alike. PURE; undefined/absent = new.
function toolMaxUses (name) { const m = String(name || '').match(/^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe)$/); return m ? PICK_USES[m[1]] : 0 }
function toolUsesLeft (name, durabilityUsed) { const max = toolMaxUses(name); return max ? Math.max(0, max - (durabilityUsed || 0)) : 0 }
// Uses remaining on a pickaxe given its durabilityUsed (undefined/absent = brand new). Delegates
// to toolUsesLeft but stays pickaxe-only (returns 0 for any non-pickaxe) - unchanged behavior.
function pickUsesLeft (name, durabilityUsed) { return pickMaxUses(name) ? toolUsesLeft(name, durabilityUsed) : 0 }

// Rough block-count estimate for an excursion: the staircase down (≈3 blocks dug per step of
// depth) + `branches` junctions, each ≈ the corridor advance + two branches, 2 blocks
// (feet+head) dug per length. Deliberately generous so we DON'T under-provision picks. PURE.
function estExcursionBlocks (depth, opts = {}) {
  const branches = opts.branches != null ? opts.branches : 6
  const branchLen = opts.branchLen != null ? opts.branchLen : 12
  const spacing = opts.spacing != null ? opts.spacing : 3
  return Math.max(0, Math.floor(depth)) * 3 + branches * 2 * (spacing + 2 * branchLen)
}

// How many NEW stone picks to craft up front so carried pick durability covers `estBlocks`
// (plus a one-pick spare margin). `carriedUsesLeft` = total uses left across picks in the
// pack. PURE - the driver caps the result and supplies materials.
function picksToCraft (carriedUsesLeft, estBlocks, opts = {}) {
  const perPick = opts.perPick != null ? opts.perPick : PICK_USES.stone
  const spareUses = opts.spareUses != null ? opts.spareUses : perPick // one full pick of margin
  const deficit = (estBlocks + spareUses) - (carriedUsesLeft || 0)
  return deficit <= 0 ? 0 : Math.ceil(deficit / perPick)
}

// Should we re-tool at depth NOW? Yes when there is NO spare pick AND the best held pick is
// running low - re-tool BEFORE it breaks (while it still has uses to mine the 3 cobble a new
// pick needs), never after (a broken pick can't mine its own replacement). PURE.
function needReTool (bestPickUsesLeft, sparePicks, opts = {}) {
  const low = opts.low != null ? opts.low : 20
  return (sparePicks || 0) <= 0 && (bestPickUsesLeft || 0) <= low
}

// Is the depth we've ALREADY reached good enough to branch-mine iron here, rather than
// burning more entrance relocations chasing the ideal targetY? Modern terrain is
// cave/aquifer-riddled everywhere, so a clean shaft rarely reaches y16 - but anything at or
// below MIN_IRON_Y (~y40) is a perfectly worthwhile iron depth (the triangular iron
// distribution is well into its common band by y40 and richer below). Returns true = mine
// here; false = still too shallow, keep trying to get deeper. PURE.
function worthMiningHere (currentY, opts = {}) {
  const minIronY = opts.minIronY != null ? opts.minIronY : 40
  return Math.floor(currentY) <= minIronY
}

// When the descent is BLOCKED (can't get deeper after relocations), should we mine at the
// depth we reached, or bail? The HARD FLOOR: iron spawns from ~y72 down, and cave/aquifer
// terrain is everywhere, so ANY reasonably-below-surface depth is iron-viable and must NOT
// return empty. More permissive than worthMiningHere (which is the "great depth, stop
// chasing" early-break): mine here if we descended a meaningful distance OR are below the
// iron ceiling. Only "barely scratched the surface" bails. PURE.
function mineableWhenBlocked (currentY, surfaceY, opts = {}) {
  const minDescent = opts.minDescent != null ? opts.minDescent : 12  // blocks below surface = a real dig
  const ironCeiling = opts.ironCeiling != null ? opts.ironCeiling : 52 // at/below this Y iron is plentiful regardless
  const descended = Math.floor(surfaceY) - Math.floor(currentY)
  return descended >= minDescent || Math.floor(currentY) <= ironCeiling
}

// ---- persistent, re-enterable mine -----------------------------------------------------
// A fresh descent through cave/aquifer terrain can eat a WHOLE excursion (live: ~95s
// re-descending 3 caves, 0s left to mine, gathered:0 "out of time"). So a mine is PERSISTED
// after a successful descent and RE-ENTERED next time - spend the budget MINING, not
// re-digging. This decides whether a remembered mine is worth re-entering: it exists, is a
// real dig (has a level), is close enough to walk to, and isn't stale. PURE (the driver does
// the world-read verification - staircase still open / not flooded - on arrival).
function mineReusable (mine, fromXZ, opts = {}) {
  if (!mine || mine.x == null || mine.z == null || mine.level == null) return false
  const maxDist = opts.maxDist != null ? opts.maxDist : 80
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : 6 * 3600 * 1000
  if (opts.now != null && mine.at != null && (opts.now - mine.at) > maxAgeMs) return false
  if (opts.maxLevelY != null && mine.level > opts.maxLevelY) return false // too shallow for this ore band
  return Math.hypot(mine.x - fromXZ.x, mine.z - fromXZ.z) <= maxDist
}

// Classify whether it is SAFE to descend one step onto the cell whose floor blocks are
// `below` (the block that becomes our feet-floor) and `below2` (one further down). Given
// block NAME strings (or null = unloaded/air). Returns:
//   'lava'  - lava at or just under the landing -> NEVER dig here (relocate the shaft)
//   'water' - water/aquifer -> wall off or relocate (don't drown)
//   'void'  - air/cave under the landing -> a drop/cavern, stop (don't fall in)
//   'ok'    - solid, breakable-looking floor -> safe to step down
function descentSafety (below, below2) {
  if (LAVA_RE.test(below || '') || LAVA_RE.test(below2 || '')) return 'lava'
  if (WATER_RE.test(below || '') || WATER_RE.test(below2 || '')) return 'water'
  if (AIRISH(below)) return 'void'   // nothing to stand on where we'd land
  if (AIRISH(below2)) return 'void'  // cave immediately beneath -> would break into it
  return 'ok'
}

// Whether a tunnel face is safe to break: lava/water in any of the three cells ahead
// (feet/head/floor) means STOP. Given the three block names. (The driver also has the
// don't-open-a-cavern guard in mineTunnel; this is the fluid guard.)
function faceHazard (aheadName, aheadUpName, floorName) {
  if ([aheadName, aheadUpName, floorName].some(n => LAVA_RE.test(n || ''))) return 'lava'
  if ([aheadName, aheadUpName, floorName].some(n => WATER_RE.test(n || ''))) return 'water'
  if (AIRISH(floorName)) return 'void' // no floor ahead -> a drop
  return 'ok'
}

// SHALLOW-DIG fluid probe (drowning prevention): given the NAME strings of a target block's
// 6 face-neighbours (E/W/N/S/up/DOWN - order irrelevant; the one BELOW matters too, it floods
// a hole just the same), is breaking it safe? A fluid in ANY neighbour drains into the space we
// open - which is exactly how the bot drowned mining ore beside a pond aquifer (the old gather
// filter only checked water ABOVE the target). Returns 'lava'|'water'|'ok'. PURE - reuses the
// same LAVA_RE/WATER_RE as descentSafety/faceHazard, so all three agree on "what is a fluid".
function digExposureHazard (neighborNames) {
  const ns = Array.isArray(neighborNames) ? neighborNames : []
  if (ns.some(n => LAVA_RE.test(n || ''))) return 'lava'
  if (ns.some(n => WATER_RE.test(n || ''))) return 'water'
  return 'ok'
}

// CLIMB-STEP safety (the digStaircaseUp lava-death fix, #41): compose the two existing probes
// so a single call decides whether the NEXT up-staircase step is safe. Given the two blocks
// UNDER the tread (floorName/floor2Name - where the filler will rest / what we stand on) and
// the NAME strings of every cell the step OPENS or ENTERS **plus their face-neighbours**
// (`openCellNeighborNames` - own head-clearance, the new feet/head cells, the tread cell,
// deduped ~12-16 reads), returns 'lava'|'water'|'void'|'ok':
//   - descentSafety(floorName, floor2Name): lava/water UNDER the tread, or void (no support to
//     place a tread on -> try another direction). 'void' is a real "can't build here" signal,
//     not a fluid, but the caller rotates off it exactly like the other hazards.
//   - else digExposureHazard(openCellNeighborNames): lava/water AT or beside any opened cell
//     (a lava tread walked onto, or a pocket one block past the cell we crack open).
// Widened beyond fluids to the fire/magma death-danger class (index.js grave classifier) via a
// local regex only - LAVA_RE/WATER_RE are UNTOUCHED so descentSafety/faceHazard/digExposureHazard
// keep their exact meaning for every other caller. PURE (names + numbers in, decision out).
const CLIMB_HAZARD_RE = /magma_block|fire/
function climbStepSafety (floorName, floor2Name, openCellNeighborNames) {
  const d = descentSafety(floorName, floor2Name)
  if (d !== 'ok') return d
  const ns = Array.isArray(openCellNeighborNames) ? openCellNeighborNames : []
  if ([floorName, floor2Name].concat(ns).some(n => CLIMB_HAZARD_RE.test(n || ''))) return 'lava'
  return digExposureHazard(ns)
}

// EXPOSURE probe (THE mining-throughput root fix): given a target block's 6 face-neighbour
// NAME strings, is at least ONE face open to air? Ore EMBEDDED in solid rock (all 6 neighbours
// solid) is NOT reachable by the anti-grief mining movement profile (canDig, but every
// non-leaf block is blocksCantBreak), so goto'ing at it stands still until a silent timeout -
// the ~1-block-per-50s churn. Requiring an exposed face means only ore we can actually walk up
// to and mine becomes a breakBlock target; embedded ore falls through to the branch mine.
// Only true air counts (unloaded/null is NOT treated as exposed, so embedded ore stays
// filtered at a chunk edge). PURE - same AIRISH vocabulary as descentSafety/faceHazard.
function faceExposed (neighborNames) {
  const ns = Array.isArray(neighborNames) ? neighborNames : []
  return ns.some(n => n === 'air' || n === 'cave_air' || n === 'void_air')
}

// PURE (IRON_GATHER_FIX): is a DETECTED-but-unreachable ore close enough to justify tunnelling a
// direct path to it? The dig-to-ore step (provision.js) only fires within a bounded vertical band
// and horizontal reach - chasing ore far above/below, or across a wide gap, risks digging the bot
// off into terrain it can't get back from. Given |dy| to the ore and its horizontal distance,
// returns whether a bounded direct tunnel is in-range. PURE (numbers in, bool out).
function digToOreInReach (dyAbs, horizDist, opts = {}) {
  const vband = opts.vband != null ? opts.vband : 4
  const maxHoriz = opts.maxHoriz != null ? opts.maxHoriz : 8
  if (!(dyAbs >= 0) || !(horizDist >= 0)) return false
  return dyAbs <= vband && horizDist <= maxHoriz + 1
}

// At depth, is it worth SCRATCH-PATHING to an exposed candidate, or should we go back to the
// organized branch mine? When we're already down a mine (feetY <= surfaceY - deepBelow) and
// EVERY exposed candidate is farther than maxScratch (~16b), the pathfinder burns the budget
// crawling cave walls it mostly can't reach - re-entering branchMine (which continues its
// persisted corridor) yields far more ore. Near the surface (not at depth) scratching is always
// fine. Nothing exposed at depth -> also back to the mine. PURE.
function scratchWorthy (feetY, surfaceY, candidateDists, opts = {}) {
  const deepBelow = opts.deepBelow != null ? opts.deepBelow : 8
  const maxScratch = opts.maxScratch != null ? opts.maxScratch : 16
  const atDepth = Math.floor(feetY) <= Math.floor(surfaceY) - deepBelow
  if (!atDepth) return true                      // near surface -> scratch exposed ore as usual
  const ds = Array.isArray(candidateDists) ? candidateDists : []
  if (!ds.length) return false                   // nothing exposed at depth -> back to branchMine
  return ds.some(d => d <= maxScratch)           // a near candidate exists -> worth the scratch
}

// Should a deep-ore gather go STRAIGHT to the branch mine instead of scratching exposed
// candidates? YES when at/near surface and all visible ore is in the sparse tail (above
// ironCeiling ~y52). Already deep (down a mine) or a rich-depth candidate exists -> mine
// what's exposed. PURE.
function preferBranchMine (item, feetY, surfaceY, candidateYs, opts = {}) {
  if (!/^raw_iron$/.test(item)) return false            // iron only (copper is a SURFACE ore)
  const ironCeiling = opts.ironCeiling != null ? opts.ironCeiling : 52
  const deepBelow = opts.deepBelow != null ? opts.deepBelow : 8
  if (Math.floor(feetY) <= Math.floor(surfaceY) - deepBelow) return false  // already down a mine
  const ys = candidateYs || []
  if (!ys.length) return true                            // nothing exposed -> descend
  return ys.every(y => y > ironCeiling)                  // only sparse-tail visible -> descend
}

// Should a STONE (cobble-family) gather DESCEND to the stone layer instead of scratching the
// surface / standing still? Mirrors preferBranchMine's shape but for the stone family (no ore
// band): YES when the gather is for stone/cobble, the bot is at/near the surface, and NOTHING is
// exposed to mine. Already down a dig (>=deepBelow below surface) -> false: the loop-top
// level-preference mines the exposed staircase walls there, we don't re-descend. This is what
// routes a cobble gather to digStaircaseDown instead of the blind wander when the surface around
// the hut is dirt/grass. `item` is the gather item (cobblestone, not 'stone'). PURE.
const STONE_ITEM_RE = /^(cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|tuff)$/
function preferStoneDescend (item, feetY, surfaceY, candidateYs, opts = {}) {
  if (!STONE_ITEM_RE.test(String(item || ''))) return false // stone/cobble family only (iron etc. -> preferBranchMine)
  const deepBelow = opts.deepBelow != null ? opts.deepBelow : 8
  if (Math.floor(feetY) <= Math.floor(surfaceY) - deepBelow) return false // already down a dig -> mine the walls
  const ys = candidateYs || []
  return !ys.length                                       // only descend when nothing is exposed here
}

// The SHALLOW descent target for a stone scrape: `depth` (default 12) below the surface -
// comfortably through any normal soil blanket (fixes the 6-block strip that bottomed out in
// dirt) while never approaching the iron/lava excursion depths. Reuses targetMineY's clamps so
// it never sinks below the strip hard-floor and never sits so high it isn't a descent
// (<= surfaceY-3). This is a scrape for 3 cobble, not a mine. PURE (delegates to targetMineY).
function stoneDescendTargetY (surfaceY, opts = {}) {
  const depth = opts.depth != null ? opts.depth : 12
  const hardFloor = opts.hardFloor != null ? opts.hardFloor : 30
  return targetMineY(surfaceY, { targetY: Math.floor(surfaceY) - depth, hardFloor })
}

// Depth/effort profile for a deep branch mine, MODULATED by how much armor we're wearing.
// A NAKED bot (0 pieces) commits to the SAME deep excursion as an armored one today and dies
// down there (naked-deep deaths, live) - so an unarmored dig stays shallower, shorter, and
// carries fewer torches. NEVER blocks (iron armor needs iron): it only tunes the plan.
// targetY still passes through targetMineY clamping in the driver. PURE.
function deepMinePlan (armorPieces, opts = {}) {
  if ((armorPieces || 0) <= 0) return { targetY: opts.nakedY != null ? opts.nakedY : 28, maxBranches: 8, wantTorches: 8, naked: true }
  return { targetY: opts.targetY != null ? opts.targetY : 16, maxBranches: 30, wantTorches: 12, naked: false }
}

// PURE (#71 ARMOR_BOOTSTRAP): the keystone-blocker fix. A FULLY-NAKED bot (0 armor) must
// accumulate its FIRST boots' worth of raw iron SAFELY before it can smelt any armor (the
// chicken-and-egg: needs armor to mine iron, needs iron to make armor). While naked AND still
// short of `bootsIron`, the miner (a) targets a SHALLOW band [ymin..ymax] - near-surface iron,
// far fewer skeletons/creepers than the y<40 deep zone that keeps killing it - and (b) retreats
// from ANY hostile within `retreatDist` (wider than the 6b mineDanger gate). Once it wears a
// piece OR banks bootsIron raw iron, `active` goes false and the normal deep plan resumes.
// enabled:false (ARMOR_BOOTSTRAP=0) -> always inactive => today's mining, byte-for-byte. PURE.
function armorBootstrapMining (armorPieces, rawIronHave, opts = {}) {
  const enabled = opts.enabled !== false
  const bootsIron = opts.bootsIron != null ? opts.bootsIron : 4
  const ymin = opts.ymin != null ? opts.ymin : 45
  const ymax = opts.ymax != null ? opts.ymax : 58
  const retreatDist = opts.retreatDist != null ? opts.retreatDist : 10
  // #84 SHALLOW_UNTIL_ARMORED (default on): keep the safe shallow band (and the #83 mine-recall
  // privileges that key off `active`) until FULLY armored - the moment the first boots went on,
  // active flipped false and the helmet-phase gather reverted to the deep y16 target + strict
  // recall gates it cannot execute (live 04:28Z: every descent 'stuck at y6x' again). A 1/4-armored
  // bot at y16 is barely safer than a naked one; y45-58 has proven iron yield here. =0 -> naked-only.
  const underCap = process.env.SHALLOW_UNTIL_ARMORED !== '0' ? 4 : 1
  const active = enabled && (armorPieces || 0) < underCap && (rawIronHave || 0) < bootsIron
  // targetY = the DEEPEST end of the safe band: the descent stops at ymin, so the branch mine
  // works the whole [ymin..ymax] near-surface iron band (the staircase passes through ymax->ymin).
  return { active, targetY: ymin, ymin, ymax, retreatDist, bootsIron }
}

// PURE (IRON_KEYSTONE): the keystone-blocker COMMITMENT decision, layered on top of #71's shallow
// band. A fully-naked bot must bank its FIRST boots' worth of raw iron before ANY armor can exist
// (the chicken-and-egg: needs armor to mine iron safely, needs iron to make armor). While naked AND
// still short of `bootsIron` raw iron, the iron gather MUST:
//   descend - route STRAIGHT to the organized shallow branch mine (#71's y45-58 band), never scan
//             the surface and quit (the live "stays at y66, mines 0" bug); and
//   commit  - HOLD that grind against the build / oak-gather / any non-crisis, yielding ONLY to a
//             real survival crisis (the existing reflexes) - the single-goal discipline it violates
//             by thrashing iron<->oak every ~19s and never finishing the descent.
// Once a piece is worn OR bootsIron raw iron is banked, active=false and normal routing/preemption
// resume. enabled:false (IRON_KEYSTONE=0) -> always inactive => today byte-for-byte. PURE.
function ironKeystone (state, opts = {}) {
  const s = state || {}
  const enabled = opts.enabled !== false
  const bootsIron = opts.bootsIron != null ? opts.bootsIron : 4
  const active = enabled && (s.armorPieces || 0) <= 0 && (s.rawIron || 0) < bootsIron
  return { active, descend: active, commit: active, bootsIron }
}

// PURE (IRON_KEYSTONE): should a FINISHED keystone iron grind that netted no iron ARM the naked
// gear-up back-off? Only a grind that GENUINELY descended and mined the band and STILL found no iron
// is a material failure (fruitless). A grind cut short before a real mining attempt - preempted by a
// survival crisis / stop (isStopped), or reclaimed by the build before it ever reached the band
// (minedReal=false) - is NOT fruitless: arming it is exactly the #60-class bug that locks the bot out
// of its ONLY armor source for ~42 min while it stays permanently naked. Not keystone-active ->
// 'defer' so the caller keeps today's gearupShouldArmBackoff verdict byte-for-byte. PURE.
//   state: active (keystone on this run), progressed (wore a piece / netted iron), interrupted
//          (survival/stop preempt, #60), minedReal (actually descended + mined the band this run)
function ironKeystoneFruitless (state) {
  const s = state || {}
  if (!s.active) return 'defer'      // flag off / armored / has boots' iron -> today's accounting
  if (s.progressed) return false     // progress never arms (caller resets instead)
  if (s.interrupted) return false    // #60: survival/stop took the body - not a material failure
  if (!s.minedReal) return false     // never reached the band (build reclaim) - not a failure either
  return true                        // descended, mined the band, found no iron -> honest fruitless
}

// PURE (#71): the retreat-when-unarmored decision, split out so both mine loops share ONE test-
// able predicate. A bootstrapping (naked, first-iron) bot yields the moment a hostile is within
// retreatDist - EARLIER/WIDER than mineDanger's 6b - so a skeleton can't whittle it down before
// it climbs out. inactive (armored / flag off / has boots' iron) -> false => unchanged. PURE.
function armorBootstrapRetreat (active, hostileDist, retreatDist) {
  if (!active) return false
  if (hostileDist == null) return false
  return hostileDist <= (retreatDist != null ? retreatDist : 10)
}

// Batched-harvest cadence for the mining loops (the mine-one-pause-one fix): sweep drops on
// every Nth step instead of every step. stepIdx is 0-based; a sweep is due when the step
// COUNT (stepIdx+1) is a multiple of `every`. every=1 -> every step (the MINE_FLUID=0 legacy
// cadence). Trivial by design - it exists so the cadence is unit-testable and shared. PURE.
function sweepDue (stepIdx, every) { return (stepIdx + 1) % every === 0 }

// Branch-mine geometry constants for the driver. corridorIdx picks the main-corridor
// direction; left/right branches go off it perpendicular, `spacing` apart. Pure - just
// resolves the direction indices + returns the tunables so the driver stays declarative.
function branchLayout (corridorIdx, opts = {}) {
  const [left, right] = perpendicular(corridorIdx)
  return {
    corridorIdx: ((corridorIdx % 4) + 4) % 4,
    leftIdx: left,
    rightIdx: right,
    spacing: opts.spacing != null ? opts.spacing : 3,      // blocks of corridor between branch pairs (2-3 = classic)
    branchLen: opts.branchLen != null ? opts.branchLen : 12, // how far each branch reaches
    torchEvery: opts.torchEvery != null ? opts.torchEvery : 1 // torch at every Nth junction
  }
}

module.exports = { LAVA_RE, WATER_RE, AIRISH, DIRS, PICK_USES, perpendicular, targetMineY, worthMiningHere, mineableWhenBlocked, mineReusable, pickMaxUses, pickUsesLeft, toolMaxUses, toolUsesLeft, estExcursionBlocks, picksToCraft, needReTool, descentSafety, faceHazard, digExposureHazard, climbStepSafety, faceExposed, digToOreInReach, scratchWorthy, branchLayout, preferBranchMine, preferStoneDescend, stoneDescendTargetY, deepMinePlan, armorBootstrapMining, armorBootstrapRetreat, ironKeystone, ironKeystoneFruitless, sweepDue }
