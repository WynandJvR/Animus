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
// Uses remaining on a pickaxe given its durabilityUsed (undefined/absent = brand new).
function pickUsesLeft (name, durabilityUsed) { const max = pickMaxUses(name); return max ? Math.max(0, max - (durabilityUsed || 0)) : 0 }

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

module.exports = { LAVA_RE, WATER_RE, AIRISH, DIRS, PICK_USES, perpendicular, targetMineY, worthMiningHere, mineableWhenBlocked, mineReusable, pickMaxUses, pickUsesLeft, estExcursionBlocks, picksToCraft, needReTool, descentSafety, faceHazard, digExposureHazard, branchLayout }
