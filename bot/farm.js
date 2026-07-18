'use strict'
// PURE wheat-farm geometry + crop-state decisions (offline-testable, no bot / no I/O -
// like shelter.js / hut-model.js / mining.js). provision.js wraps these with real world
// reads. Run: cd bot && node farmtest.js
//
// WHY THIS EXISTS (ground-truthed live): the farm "PLANTED at the pond" but for 2.5 HOURS
// every tend logged `harvested 0, wheat=0, bread=0` - it produced NOTHING. Two root causes
// this module encodes so the farm actually grows -> harvests -> makes bread:
//
//  1) FLOODING. The old ring tilled bank cells at dy 0/-1/+1 vs the waterline. A bank BELOW
//     the waterline (dy -1) puts its crop cell (bank.y+1) at the SAME level as the adjacent
//     water source, so the source washes the seed out the instant it's placed - the crop can
//     never stand. Standard MC geometry: crops must sit ABOVE the water surface, on farmland
//     the water hydrates but cannot flow OVER. Only a bank at/above the waterline qualifies;
//     only a bank LEVEL with the water is also hydrated (fast growth). bankUsable() encodes it.
//
//  2) FAITH. Planting counted placeBlock() calls, never a world re-read, so a silently-failed
//     (or immediately-flooded) placement still logged "PLANTED" and persisted a phantom farm
//     with no wheat blocks. cropCellState() classifies what a crop cell ACTUALLY holds so the
//     ensure/tend flows only ever trust a VERIFIED `wheat` block, and re-plant anything else.

// A bank cell (dirt/grass we will till) whose block sits at world-Y `bankY`, beside a water
// SOURCE block at `waterY`. The crop grows in the cell one above the farmland (bankY + 1).
//   bankY <  waterY  -> crop cell is at/below the water surface -> water floods it -> UNUSABLE.
//   bankY === waterY -> farmland level with the water (HYDRATED) and crop one block above the
//                       surface (safe, unwashable). the ideal farm cell.
//   bankY >  waterY  -> crop safely above the water, but farmland sits above the water line so
//                       it is NOT hydrated (grows slowly / can dry out). a usable FALLBACK.
function bankUsable (waterY, bankY) {
  if (bankY < waterY) return { usable: false, hydrated: false, safe: false }
  return { usable: true, hydrated: bankY === waterY, safe: true }
}

// Till offsets to try relative to the waterline, BEST-FIRST: level (hydrated + safe) then
// one-up (safe but dry). The old code also tried -1 (the flooding case) - deliberately gone.
const BANK_DYS = [0, 1]

// Classify the block currently occupying a crop cell (one above the farmland) from its name:
//   'wheat'   -> a crop stands here (leave it; harvest only when mature).
//   'gone'    -> air / replaceable veg -> (re)plant here.
//   'flooded' -> water/lava washed in -> a bad cell (re-tilling won't hold a seed).
//   'blocked' -> some other solid block -> not plantable.
function cropCellState (name) {
  if (name == null || name === 'air' || name === 'cave_air' || name === 'void_air') return 'gone'
  if (name === 'wheat') return 'wheat'
  if (/water|lava/.test(name)) return 'flooded'
  if (/^(short_grass|tall_grass|grass|fern|large_fern|dead_bush|snow|vine)$/.test(name)) return 'gone' // replaceable veg -> plant over it
  return 'blocked'
}

// ---- FARM_RESEED: barren-cell retirement + maxed un-latch (offline-testable) --------
// A persisted crop cell that never re-establishes (water-washed / obstructed) keeps the farm
// record "standing" forever and is silently skipped every tend pass - the farm produces 0 and
// the food loop starves. These two pure fns drive retirement (drop a cell from the record after
// N consecutive dead passes) and the maxed un-latch (re-admit the ensure ring so it can till+
// plant fresh ground) - all the world-write/tilling/planting stays in provision's verified
// primitives. See DESIGN-reseed-barren-farm.md.
//
// One tend-pass health step for one persisted cell.
//   state:     cropCellState result ('wheat'|'gone'|'flooded'|'blocked')
//   replantOk: for 'gone' cells, whether replantCropCell verified a wheat block (null otherwise)
//   deadRuns:  consecutive failed passes so far
//   threshold: consecutive dead passes before retirement (default 3)
// -> { deadRuns, retire }
//   'wheat'                -> reset (a crop stands here)
//   'gone' + replantOk     -> reset (we just re-established it)
//   'gone' + !replantOk    -> increment, retire at threshold (replant keeps failing)
//   'flooded' | 'blocked'  -> increment, retire at threshold (dead weight, not fixable here)
function cellHealthStep (state, replantOk, deadRuns, threshold) {
  if (threshold == null) threshold = 3
  const n = deadRuns || 0
  if (state === 'wheat') return { deadRuns: 0, retire: false }
  if (state === 'gone' && replantOk) return { deadRuns: 0, retire: false }
  const d = n + 1
  return { deadRuns: d, retire: d >= threshold }
}

// Post-pass plot audit: should the `maxed` latch clear so the ensure ring can plant new cells?
// -> true iff at least one cell was retired this pass AND the survivors are under target.
function plotShouldUnlatch (retiredCount, survivorCount, target) {
  return retiredCount > 0 && survivorCount < target
}

// A wheat block carries an `age` property 0..7; it is ready to harvest at age 7.
function matureForHarvest (age) { return age != null && age >= 7 }

// The farmland block a crop is (re)planted on must actually be tilled farmland.
function farmlandReady (name) { return name === 'farmland' }

// The block name a bank cell must have to be tillable directly (no dirt-swap needed).
function tillableBank (name) { return /^(grass_block|dirt|coarse_dirt|rooted_dirt|farmland)$/.test(name || '') }

// ---- FARM_EXPAND: bank-following growth + flat-site selection + honest maxed --------
// Five PURE decisions (offline-tested) that let the farm grow along a river bank, pick a flat
// near-home site instead of the first puddle, latch `maxed` only when the bank truly runs out,
// and relocate off a bad mound at most once per cooldown. All world I/O stays in provision.js.
// See DESIGN-river-farm-expansion.md.

// §4.3 maxed = "genuinely no more tillable bank at this site", never "one ring is full".
//   done (cells>=target) is NOT maxed (the ensure early-return owns it);
//   expand OFF -> today's rule exactly (planted 0);
//   expand ON -> latch only when a pass planted NOTHING and no eligible candidate remains untried.
function expansionMaxed ({ expand, planted, eligibleRemaining, cells, target }) {
  if (cells >= target) return false               // done is not maxed (the :3712 early-return owns it)
  if (!expand) return planted === 0               // today's rule exactly
  return planted === 0 && eligibleRemaining === 0 // nothing planted AND nothing left untried
}

// §4.2 barren-column memo step: one till/plant failure for one never-planted candidate column.
//   flooded|unfarmable -> +2 strikes (out immediately); any other fail -> +1 (one retry).
//   skip once strikes >= 2. The 128-key cap + eviction is provision's hygiene, not here.
function barrenStep (prevStrikes, failKind) {
  const add = (failKind === 'flooded' || failKind === 'unfarmable') ? 2 : 1
  const strikes = (prevStrikes || 0) + add
  return { strikes, skip: strikes >= 2 }
}

// §4.2 order bank candidates so the plot grows contiguously outward: nearest to the site anchor
// first (short hops), inner band (1) before outer band (2) on a tie. Returns a SORTED COPY; the
// input array is never mutated. Each candidate: { x, z, band, ... }.
function orderBankCandidates (cands, anchor) {
  return cands.slice().sort((a, b) => {
    const da = Math.hypot(a.x - anchor.x, a.z - anchor.z)
    const db = Math.hypot(b.x - anchor.x, b.z - anchor.z)
    if (da !== db) return da - db
    return (a.band || 0) - (b.band || 0) // tie: inner band (1) first
  })
}

// §4.4 score a candidate water edge, DISTANCE-DOMINANT. Nearest ACCEPTABLE site wins. quality is
// capped at target (a 100-cell shore is no better than a `target`-cell one) and distance is
// subtracted INSIDE the score so it dominates small quality differences: at distWeight 0.75, a
// site 20b farther needs +15 more reachable cells to win. acceptable = the site can at least feed
// a bread cycle (tillable >= minTillable).
function scoreFarmSite ({ tillable, flatFrac, distHome, target }, { distWeight = 0.75, minTillable = 6, minFlatFrac } = {}) {
  const quality = Math.min(tillable, target) + 4 * (flatFrac || 0)
  // #56 FARM_FLAT_SITE: a site must ALSO be flat enough to level + till cheaply (rough/wet pond
  // edges land crop cells at 2-3 Y-levels -> tills fail -> nothing grows). `minFlatFrac` opt wins
  // (testable); else env (FARM_FLAT_SITE=0 -> no floor = today's tillable-only gate; FARM_FLAT_MIN
  // sets the floor, default 0.6). The +4*flatFrac score term is unchanged.
  const gate = minFlatFrac != null ? minFlatFrac
    : (process.env.FARM_FLAT_SITE === '0' ? 0 : Number(process.env.FARM_FLAT_MIN || 0.6))
  return { score: quality - distWeight * distHome, acceptable: tillable >= minTillable && (flatFrac || 0) >= gate }
}

// §4.6 should the farm relocate off its current site? Clearly better AND near home AND NEVER
// farther out than the farm already is (+slack). Never abandons a producing/near-target farm
// (curCells >= target*minCellsFrac), never moves without maxed, never for a small quality gain
// (< margin), never past nearHome, never farther than curDist + slack.
function shouldResite ({ curCells, curMaxed, curScore, curDist, bestScore, bestDist, target },
                       { margin = 8, nearHome = 112, slack = 16, minCellsFrac = 0.5 } = {}) {
  if (!curMaxed || curCells >= target * minCellsFrac) return false
  if (bestDist > nearHome || bestDist > curDist + slack) return false
  return bestScore >= curScore + margin
}

// FIX #38: collect-radius that covers the WHOLE plot. A big plot (live: 22 cells at 446,31)
// spans well past the fixed radius-6 final sweep, so drops at far cells were left on the ground
// ("harvested 8 -> wheat=1"). From the plot center (the water anchor) the farthest cell is `maxD`
// away; collect out to that plus a small margin so every cell's drop is in range. Bounded: never
// below `base` (today's radius), never above `cap` (don't wander off-plot after foreign drops).
function plotCollectRadius (cells, anchor, { base = 6, margin = 4, cap = 24 } = {}) {
  if (!cells || !cells.length || !anchor) return base
  let maxD = 0
  for (const c of cells) { const d = Math.hypot(c.x - anchor.x, c.z - anchor.z); if (d > maxD) maxD = d }
  return Math.max(base, Math.min(cap, Math.ceil(maxD) + margin))
}

// §D FARM_EXCLUDE_YFIX: is (x,y,z) inside the persisted crop-cell footprint - i.e. does ANY cell
// share the (x,z) column and sit within 1 Y of it (its farmland y-1, the crop y, or the block above
// y+1)? PURE, per-cell (each cell protected at its OWN level, never one global cy), offline-testable.
// The movement exclusions (cropExclusionStep/cropPlaceExclusion) build the same predicate inline as
// a per-(x,z)->y-set map (A*-hot path); provision.farmFootprintHas (the manual-placer guard) uses THIS.
function footprintHasCell (cells, x, y, z) {
  if (!cells || !cells.length) return false
  for (const c of cells) { if (c.x === x && c.z === z && Math.abs(y - c.y) <= 1) return true }
  return false
}

module.exports = { bankUsable, BANK_DYS, cropCellState, cellHealthStep, plotShouldUnlatch, matureForHarvest, farmlandReady, tillableBank, expansionMaxed, barrenStep, orderBankCandidates, scoreFarmSite, shouldResite, plotCollectRadius, footprintHasCell }
