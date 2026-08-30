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
// ==== UNKNOWN IS A STATE (2026-08-02) ====================================================
// `null` used to fold into 'gone'. A null here is `bot.blockAt(cell)` on an UNLOADED chunk -
// "I could not look" - and calling that "the crop is missing" is the exact error #10 forbids
// ("Unmeasured is not unmet"). It had teeth: an unread cell was replanted (pointlessly - the
// ground read is null too), then aged by cellHealthStep as a dead cell, and RETIRED off the
// farm record after 3 such passes. A farm can be deleted, cell by cell, by a chunk that was
// slow to load. 'unknown' is now its own arm and every caller must decide what to do with it;
// the tend loop skips those cells untouched and REPORTS the count.
function cropCellState (name) {
  if (name == null) return 'unknown'
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return 'gone'
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

// ==== A TEND PASS IS A WALK, NOT A ZIG-ZAG (2026-08-02) ==================================
// tendWheatFarm iterated m.wheatFarm.cells in PERSISTED INSERTION ORDER - the order the plot
// happened to be tilled in, which for the live 41-cell plot alternates between the band south
// of the hut and the band east of it: 190,-97 then 195,-102 then 191,-97 then 195,-103...
// Every consecutive pair is 5-8 blocks apart, so the harvest paid a full `gotoWithTimeout` per
// cell (the >4b gate) and crossed the hut's corner over and over. Nothing about that order is
// derived from anything; it is an accident of history that costs ~5x the walking, and the tend
// pass has to finish inside the supervisor's patience.
//
// Greedy nearest-neighbour from where the bot actually stands. PURE, O(n^2) on a few dozen
// cells (~1.7k distance tests for the live plot - nothing on the body's budget, [[body-first]]),
// returns a SORTED COPY, never mutates. Deterministic tie-break (x then z then y) so two runs
// over the same plot produce the same route.
function orderCellsNearest (cells, from) {
  const rest = (cells || []).slice()
  const out = []
  let cur = { x: (from && from.x) || 0, y: (from && from.y) || 0, z: (from && from.z) || 0 }
  while (rest.length) {
    let bi = 0; let bd = Infinity
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]
      const d = Math.hypot(c.x - cur.x, c.z - cur.z) + Math.abs((c.y || 0) - (cur.y || 0))
      if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && (c.x - rest[bi].x || c.z - rest[bi].z || (c.y || 0) - (rest[bi].y || 0)) < 0)) { bd = d; bi = i }
    }
    cur = rest[bi]
    out.push(rest.splice(bi, 1)[0])
  }
  return out
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
  // ==== AUDIT 2026-07-29 FIX 10: ENOUGH FLAT CELLS, NOT A FLAT RATIO =======================
  // The gate asked "is most of this area flat?" when the question a farm actually poses is "are
  // there enough flat cells to lay the plot?". Those differ whenever the scan is wide: a site with
  // 197 tillable cells of which 40 are level is a FINE home for a 33-cell farm, and it scored
  // 40/197 = 0.20 against a 0.35 floor and was rejected - "not acceptable - deferring to fallback"
  // x25 on the live tape, after which the fallback sited a 2-cell farm.
  // A ratio also punishes a site for being BIG, which is backwards.
  // So: acceptable when the ratio is good (a genuinely uniform site) OR when the absolute number
  // of level cells already covers the target. Nothing here picks a place - the caller still scores
  // every candidate and takes the best; this only stops a good candidate being thrown away.
  const flatCells = Math.round((flatFrac || 0) * (tillable || 0))
  const enoughFlat = target != null && flatCells >= target
  return {
    score: quality - distWeight * distHome,
    acceptable: tillable >= minTillable && ((flatFrac || 0) >= gate || enoughFlat),
    flatCells
  }
}

// ---- Root F (§3.6): home-anchored site selection BY COMPARISON --------------------------
// What this DELETES: `if (recallInfra('water', MY FEET, 300)) return 'buildFarm'` - a first-truthy
// ladder in which any remembered water, however bad, suppressed discovery outright, anchored on
// wherever the body happened to be standing when the food timer fired. Live cost: a 140-block trek
// south past a pond 50 blocks from the hut, to cave water at y48 the record itself described.
// A wheat farm is tended for the rest of the bot's life, so its value is dominated by tend-distance
// from HOME - which is why a slightly worse pond near home beats a better pond far away, and why
// remembered and freshly discovered candidates have to sit in ONE array where either can lose.
//
// QUALIFICATION (Root A): a candidate whose farmable properties were never established is not a
// bad candidate, it is an UNVERIFIED one. It cannot win - and, the part the ladder got wrong, it
// cannot suppress a verified rival either. openSky !== true (cave water, or nobody ever looked)
// or no tillable count => not a candidate at all.
// PURE: candidates in, one winner or null out. No bot, no I/O, no clock, no env-dependent anchor.
function farmSiteQualified (c) {
  return !!c && c.openSky === true && Number.isFinite(c.tillable)
}
// The winner among `cands`, scored on lifetime tend-cost from `home`, or null when nothing
// qualifies/passes the acceptability floor (the caller's hunt/sweep fallbacks then proceed).
// NO HOME, NO SITE: permanent infrastructure is sited from home or not at all - siting it from a
// transient body position is the defect, so a homeless bot gets null here and establishes home
// first (Root B). Deterministic: the same candidate array yields the same winner no matter where
// the body stands, because the body is not an input.
function rankFarmSites (cands, { home, target = 33, distWeight, minTillable, minFlatFrac } = {}) {
  if (!home || !Number.isFinite(home.x) || !Number.isFinite(home.z)) return null
  let best = null
  for (const c of (cands || [])) {
    if (!farmSiteQualified(c)) continue
    const distHome = Math.hypot(c.x - home.x, c.z - home.z)
    const sc = scoreFarmSite({ tillable: c.tillable, flatFrac: c.flat, distHome, target },
      { distWeight, minTillable, minFlatFrac })
    if (!sc.acceptable) continue
    if (!best || sc.score > best.score) {
      best = { x: c.x, y: c.y, z: c.z, score: sc.score, dist: distHome, source: c.source || 'memory' }
    }
  }
  return best
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

// #59 §A FARM_SEED_BANK (PURE): how many wheat_seeds to withdraw from the bank, BANK-FIRST, before
// any grass-breaking. The shortfall `want - packSeeds` (floored at 0), capped by what the bank holds
// (`bankSeeds`; pass Infinity when the bank stock is unknown and the caller lets the withdraw itself
// cap). >0 means "raid the bank before touching grass"; 0 means the pack already has enough (or the
// bank is empty -> fall through to the grass fallback). Offline-testable, no bot / no I/O.
function seedBankWithdrawAmount (bankSeeds, packSeeds, want) {
  const need = Math.max(0, (want || 0) - (packSeeds || 0))
  return Math.max(0, Math.min(bankSeeds == null ? need : bankSeeds, need))
}

// #87 DRY_HOME_FARM (PURE): should the hut-adjacent DRY establishment mode run this pass, and in
// which sub-mode? Fires only under the flag with a hut anchor. 'establish' when NO standing farm sits
// within DRY_FARM_NEAR of the hut (the first plot, OR superseding a far water farm - the near check is
// the caller's, so a 60b water farm still reads as "none near"); 'expand' when the standing near-hut
// farm IS a dry plot still under target and not maxed; 'off' otherwise (incl. flag off -> today
// byte-for-byte, and a genuine near-hut water farm we must NOT disturb). PURE, no bot / no I/O.
function dryHomeFarmMode ({ flag = true, hutExists = false, standingNearHut = false, farmIsDry = false, cells = 0, target = 33, maxed = false, standingUnsafe = false } = {}) {
  if (!flag || !hutExists) return 'off'
  if (!standingNearHut) return 'establish'
  // A STANDING FARM WHOSE GROUND FAILS THE SURFACE SURVEY IS NOT A FARM TO KEEP (2026-08-30): the pond-lip
  // plot at 217,-244 had 135 fall-in rescues and 5 drownings in one day. "Near the hut" used to protect it
  // from the dry re-site unconditionally; a measured-unsafe surface now re-sites it.
  if (!farmIsDry && standingUnsafe) return 'establish'
  if (farmIsDry && cells < target && !maxed) return 'expand'
  return 'off'
}

// ==== A NEAT FLAT FARM (2026-08-30, operator: "a neat flat area so it is safe and easy to harvest/plant") ==
// The plot is a RECTANGLE at ONE height with a ONE-BLOCK WALKWAY around it, and the whole of that is one
// surface: every plot cell exactly at baseY, every walkway cell within one step of it, no water and no drop
// anywhere in it. It is surveyed from the world, leveled until the survey passes, and only then planted.
// PURE: the survey samples come from the caller; nothing here reads the world.
function plotRect (anchor, w, l) { return { x1: anchor.x, z1: anchor.z, x2: anchor.x + w - 1, z2: anchor.z + l - 1 } }
function inRect (rect, x, z, margin = 0) { return !!rect && x >= rect.x1 - margin && x <= rect.x2 + margin && z >= rect.z1 - margin && z <= rect.z2 + margin }
function rectCells (rect, margin = 0) {
  const out = []
  if (!rect) return out
  for (let x = rect.x1 - margin; x <= rect.x2 + margin; x++) for (let z = rect.z1 - margin; z <= rect.z2 + margin; z++) out.push({ x, z, plot: inRect(rect, x, z, 0) })
  return out
}
// samples: [{ x, z, groundY|null, water: bool }] for rect + margin. Returns the verdict and the work left.
function plotSurfaceVerdict (samples, baseY, rect) {
  const v = { ok: false, unknown: 0, water: 0, dips: 0, bumps: 0, drops: 0, off: 0, work: 0, cells: 0 }
  for (const s of (samples || [])) {
    v.cells++
    const plot = inRect(rect, s.x, s.z, 0)
    if (s.water) { v.water++; continue }
    if (s.groundY == null) { v.unknown++; continue }
    const dy = s.groundY - baseY
    if (plot) {
      if (dy < 0) { v.dips++; v.work += -dy } else if (dy > 0) { v.bumps++; v.work += dy }
    } else {
      // the walkway: one step up or down is walkable; deeper is a drop the body falls into
      if (dy < -1) { v.drops++; v.work += -dy - 1 } else if (dy > 1) { v.off++; v.work += dy - 1 }
    }
  }
  v.ok = v.water === 0 && v.unknown === 0 && v.dips === 0 && v.bumps === 0 && v.drops === 0 && v.off === 0
  return v
}
// The base height of a candidate plot: the median ground height of its plot cells (least earth to move),
// or null when the plot cannot be read. `near` (the hut floor) bounds how far the plot may sit from home
// grade so the walk from the door stays a walk.
function plotBaseY (samples, rect, near, maxOff = 2) {
  const ys = (samples || []).filter(s => inRect(rect, s.x, s.z, 0) && s.groundY != null && !s.water).map(s => s.groundY).sort((a, b) => a - b)
  if (!ys.length) return null
  const med = ys[Math.floor(ys.length / 2)]
  if (near != null && Math.abs(med - near) > maxOff) return null
  return med
}
// Lower is better: the earth to move, plus distance from the hut; water or an unreadable cell disqualifies.
function scorePlotSite (verdict, distHut) {
  if (!verdict || verdict.water > 0 || verdict.unknown > 0) return null
  return verdict.work + 0.5 * (distHut || 0)
}
// Footprint protection for the walkway (the cells themselves are covered by footprintHasCell).
function rectHasCell (rect, baseY, x, y, z, margin = 1) { return !!rect && baseY != null && inRect(rect, x, z, margin) && Math.abs(y - baseY) <= 1 }

// #59 §B FARM_HARVEST_FIRST (PURE): on a food crisis, harvest the STANDING farm before establishing a
// new plot at the nearest (often stale) water. Returns 'harvest-standing' when a farm already stands
// AND food is below the crisis threshold AND the flag is on; else 'establish' (today's behavior /
// no farm). Offline-testable, no bot / no I/O.
function foodCrisisFarmAction ({ hasStandingFarm = false, food = 20, harvestFirst = true, foodThreshold = 14 } = {}) {
  if (harvestFirst && hasStandingFarm && food < foodThreshold) return 'harvest-standing'
  return 'establish'
}

module.exports = { plotRect, inRect, rectCells, plotSurfaceVerdict, plotBaseY, scorePlotSite, rectHasCell, bankUsable, BANK_DYS, cropCellState, cellHealthStep, plotShouldUnlatch, matureForHarvest, farmlandReady, tillableBank, expansionMaxed, barrenStep, orderBankCandidates, orderCellsNearest, scoreFarmSite, farmSiteQualified, rankFarmSites, shouldResite, plotCollectRadius, footprintHasCell, seedBankWithdrawAmount, foodCrisisFarmAction, dryHomeFarmMode }
