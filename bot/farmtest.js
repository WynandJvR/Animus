'use strict'
// OFFLINE unit test for the pure wheat-farm decision logic (bot/farm.js) - no bot.
// Run: cd bot && node farmtest.js
const F = require('./farm.js')

let failures = 0
function eq (got, want, label) {
  const g = JSON.stringify(got); const w = JSON.stringify(want)
  const ok = g === w
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${g} want ${w}`))
}

// ---- bankUsable: the flooding fix -------------------------------------------------
// Bank BELOW the waterline -> crop at water level -> floods -> unusable (the old dy -1 bug).
eq(F.bankUsable(62, 61), { usable: false, hydrated: false, safe: false }, 'bank 1 below water: floods, unusable')
eq(F.bankUsable(62, 60), { usable: false, hydrated: false, safe: false }, 'bank 2 below water: floods, unusable')
// Bank LEVEL with the water: hydrated AND crop above the surface -> the ideal cell.
eq(F.bankUsable(62, 62), { usable: true, hydrated: true, safe: true }, 'bank level with water: hydrated + safe (ideal)')
// Bank ABOVE the water: safe (crop well above surface) but dry (not hydrated) -> fallback.
eq(F.bankUsable(62, 63), { usable: true, hydrated: false, safe: true }, 'bank 1 above water: safe but dry (fallback)')

// BANK_DYS must never include the flooding -1 offset.
eq(F.BANK_DYS.includes(-1), false, 'BANK_DYS excludes the flooding -1 offset')
eq(F.BANK_DYS, [0, 1], 'BANK_DYS is [level, one-up]')

// ---- cropCellState: only a real wheat block counts (the "faith" fix) --------------
eq(F.cropCellState('wheat'), 'wheat', 'a wheat block counts as a standing crop')
eq(F.cropCellState('air'), 'gone', 'air -> gone (replant)')
// UNKNOWN IS A STATE (2026-08-02). null = `bot.blockAt` on an unloaded chunk = "I could not
// look". Folding it into 'gone' made the tend loop replant a cell it cannot read and then age it
// toward RETIREMENT - a farm deletable, cell by cell, by slow chunk loading (#10: unmeasured is
// not unmet). It must never again read as an empty cell.
eq(F.cropCellState(null), 'unknown', 'null (chunk not loaded) -> unknown, NOT gone')
eq(F.cropCellState(undefined), 'unknown', 'an unreadable cell is unknown however it arrives')
eq(F.cropCellState(null) === F.cropCellState('air'), false, 'unreadable and empty must be distinguishable')
eq(F.cropCellState('cave_air'), 'gone', 'cave_air -> gone')
eq(F.cropCellState('short_grass'), 'gone', 'grass over the cell -> gone (plant over it)')
eq(F.cropCellState('water'), 'flooded', 'water washed in -> flooded')
eq(F.cropCellState('lava'), 'flooded', 'lava -> flooded')
eq(F.cropCellState('dirt'), 'blocked', 'bare dirt (no seed) -> blocked, not a crop')
eq(F.cropCellState('farmland'), 'blocked', 'empty farmland -> blocked, not a crop')
eq(F.cropCellState('cobblestone'), 'blocked', 'solid block -> blocked')

// ---- maturity + farmland gates ----------------------------------------------------
eq(F.matureForHarvest(7), true, 'age 7 is harvest-ready')
eq(F.matureForHarvest(6), false, 'age 6 not ready')
eq(F.matureForHarvest(0), false, 'age 0 not ready')
eq(F.matureForHarvest(null), false, 'no age -> not ready')
eq(F.farmlandReady('farmland'), true, 'farmland is plantable')
eq(F.farmlandReady('dirt'), false, 'untilled dirt is not plantable')
eq(F.tillableBank('grass_block'), true, 'grass_block tillable')
eq(F.tillableBank('dirt'), true, 'dirt tillable')
eq(F.tillableBank('sand'), false, 'sand not directly tillable (needs dirt swap)')
eq(F.tillableBank('water'), false, 'water not tillable')

// ---- cellHealthStep: barren-cell retirement (FARM_RESEED) --------------------------
// A standing crop resets the counter regardless of prior deadRuns.
eq(F.cellHealthStep('wheat', null, 0, 3), { deadRuns: 0, retire: false }, 'wheat resets deadRuns to 0')
eq(F.cellHealthStep('wheat', null, 2, 3), { deadRuns: 0, retire: false }, 'wheat resets even at deadRuns 2')
// A 'gone' cell that replantCropCell re-established (verified wheat) resets.
eq(F.cellHealthStep('gone', true, 2, 3), { deadRuns: 0, retire: false }, 'gone + replantOk resets to 0')
// A 'gone' cell whose replant failed ages toward retirement.
eq(F.cellHealthStep('gone', false, 0, 3), { deadRuns: 1, retire: false }, 'gone + replant fail increments 0->1')
eq(F.cellHealthStep('gone', false, 1, 3), { deadRuns: 2, retire: false }, 'gone + replant fail increments 1->2')
eq(F.cellHealthStep('gone', null, 0, 3), { deadRuns: 1, retire: false }, 'gone + null replant (not verified) increments')
// flooded/blocked always age toward retirement.
eq(F.cellHealthStep('flooded', null, 0, 3), { deadRuns: 1, retire: false }, 'flooded increments 0->1')
eq(F.cellHealthStep('blocked', null, 1, 3), { deadRuns: 2, retire: false }, 'blocked increments 1->2')
// Retire EXACTLY at threshold (the 3rd consecutive dead pass), not before.
eq(F.cellHealthStep('flooded', null, 2, 3), { deadRuns: 3, retire: true }, 'flooded retires exactly at threshold 3')
eq(F.cellHealthStep('blocked', null, 2, 3), { deadRuns: 3, retire: true }, 'blocked retires exactly at threshold 3')
eq(F.cellHealthStep('gone', false, 2, 3), { deadRuns: 3, retire: true }, 'gone+fail retires exactly at threshold 3')
// Default threshold is 3 when omitted.
eq(F.cellHealthStep('flooded', null, 2), { deadRuns: 3, retire: true }, 'default threshold 3 retires at 3rd pass')
eq(F.cellHealthStep('flooded', null, 1), { deadRuns: 2, retire: false }, 'default threshold 3: not retired at 2')
// threshold=1 edge: one dead pass retires immediately; a live pass still never retires.
eq(F.cellHealthStep('flooded', null, 0, 1), { deadRuns: 1, retire: true }, 'threshold 1: retires on first dead pass')
eq(F.cellHealthStep('wheat', null, 0, 1), { deadRuns: 0, retire: false }, 'threshold 1: wheat never retires')

// ---- plotShouldUnlatch: clear the maxed latch after retirement ---------------------
eq(F.plotShouldUnlatch(1, 5, 20), true, 'retired>0 & survivors under target -> unlatch')
eq(F.plotShouldUnlatch(3, 0, 20), true, 'all retired (0 survivors) under target -> unlatch')
eq(F.plotShouldUnlatch(0, 5, 20), false, 'nothing retired -> no unlatch')
eq(F.plotShouldUnlatch(2, 20, 20), false, 'survivors AT target -> no unlatch')
eq(F.plotShouldUnlatch(2, 25, 20), false, 'survivors OVER target -> no unlatch')

// ---- FARM_EXPAND (river farm expansion) pure decisions ----------------------------
// expansionMaxed: honest maxed = "no more tillable bank", never "one ring is full".
eq(F.expansionMaxed({ expand: false, planted: 0, eligibleRemaining: 5, cells: 5, target: 20 }), true, 'expand OFF: planted 0 -> maxed (today\'s rule)')
eq(F.expansionMaxed({ expand: false, planted: 2, eligibleRemaining: 5, cells: 5, target: 20 }), false, 'expand OFF: planted>0 -> not maxed')
eq(F.expansionMaxed({ expand: false, planted: 0, eligibleRemaining: 0, cells: 20, target: 20 }), false, 'expand OFF: at target -> not maxed (early-return owns it)')
eq(F.expansionMaxed({ expand: true, planted: 12, eligibleRemaining: 20, cells: 12, target: 33 }), false, 'river: planted 12 -> not maxed')
eq(F.expansionMaxed({ expand: true, planted: 0, eligibleRemaining: 5, cells: 8, target: 33 }), false, 'river: planted 0 but 5 eligible left -> not maxed')
eq(F.expansionMaxed({ expand: true, planted: 0, eligibleRemaining: 0, cells: 6, target: 33 }), true, 'pond: planted 0 + 0 eligible + under target -> maxed')
eq(F.expansionMaxed({ expand: true, planted: 0, eligibleRemaining: 0, cells: 33, target: 33 }), false, 'expand ON: at target -> not maxed')

// barrenStep: flooded/unfarmable strike out immediately; other fails get one retry.
eq(F.barrenStep(0, 'flooded'), { strikes: 2, skip: true }, 'flooded +2 -> skip immediately')
eq(F.barrenStep(0, 'unfarmable'), { strikes: 2, skip: true }, 'unfarmable +2 -> skip immediately')
eq(F.barrenStep(0, 'other'), { strikes: 1, skip: false }, 'other fail +1 -> one retry')
eq(F.barrenStep(1, 'other'), { strikes: 2, skip: true }, 'second other fail -> skip')
eq(F.barrenStep(1, 'flooded'), { strikes: 3, skip: true }, 'strikes accumulate on top of prior')
eq(F.barrenStep(undefined, 'other'), { strikes: 1, skip: false }, 'undefined prior -> treated as 0')

// orderBankCandidates: nearest-to-anchor first, inner band tiebreak, no mutation.
{
  const cands = [{ x: 10, z: 0, band: 2 }, { x: 2, z: 0, band: 1 }, { x: 5, z: 0, band: 2 }]
  const before = JSON.stringify(cands)
  const out = F.orderBankCandidates(cands, { x: 0, z: 0 })
  eq(out.map(c => c.x), [2, 5, 10], 'orderBankCandidates: sorted by XZ distance to anchor')
  eq(JSON.stringify(cands), before, 'orderBankCandidates: input array not mutated')
  const tie = F.orderBankCandidates([{ x: 0, z: 3, band: 2 }, { x: 3, z: 0, band: 1 }], { x: 0, z: 0 })
  eq(tie.map(c => c.band), [1, 2], 'orderBankCandidates: equal distance -> inner band (1) first')
}

// scoreFarmSite: the live-calibrated examples (mound 77b vs flat river bank 40b).
{
  const opt = { distWeight: 0.75, minTillable: 6 }
  const mound = F.scoreFarmSite({ tillable: 10, flatFrac: 0.3, distHome: 77, target: 33 }, opt)
  const bank40 = F.scoreFarmSite({ tillable: 33, flatFrac: 1.0, distHome: 40, target: 33 }, opt)
  const bank150 = F.scoreFarmSite({ tillable: 33, flatFrac: 1.0, distHome: 150, target: 33 }, opt)
  const bank61 = F.scoreFarmSite({ tillable: 33, flatFrac: 1.0, distHome: 61, target: 33 }, opt)
  eq(Math.round(mound.score * 100) / 100, -46.55, 'scoreFarmSite: mound (10 cells, flat 0.3, 77b) = -46.55')
  eq(Math.round(bank40.score * 100) / 100, 7, 'scoreFarmSite: flat bank (33 cells, flat 1.0, 40b) = +7')
  eq(bank40.score > mound.score, true, 'flat 33-cell bank @40b BEATS the 10-cell mound @77b (closer AND flatter)')
  eq(bank150.score < mound.score, true, 'same perfect bank @150b scores BELOW the mound (distance dominates)')
  eq(bank40.score > bank61.score, true, 'two acceptable banks: the nearer (40b) wins over 61b')
  // quality caps at target: a 100-cell shore is no better than a target-cell one (same flat/dist).
  const big = F.scoreFarmSite({ tillable: 100, flatFrac: 0, distHome: 40, target: 33 }, opt)
  const exact = F.scoreFarmSite({ tillable: 33, flatFrac: 0, distHome: 40, target: 33 }, opt)
  eq(big.score, exact.score, 'scoreFarmSite: quality caps at target (100 cells == 33 cells)')
  // acceptable floor at minTillable.
  eq(F.scoreFarmSite({ tillable: 5, flatFrac: 1, distHome: 10, target: 33 }, opt).acceptable, false, 'tillable 5 < minTillable 6 -> not acceptable')
  eq(F.scoreFarmSite({ tillable: 6, flatFrac: 1, distHome: 10, target: 33 }, opt).acceptable, true, 'tillable 6 == minTillable -> acceptable')
  // distWeight 0 degenerates to pure quality.
  eq(F.scoreFarmSite({ tillable: 10, flatFrac: 0.5, distHome: 999, target: 33 }, { distWeight: 0, minTillable: 6 }).score, 12, 'distWeight 0 -> pure quality (10 + 4*0.5), distance ignored')
  // default opts (distWeight 0.75, minTillable 6) when omitted.
  eq(Math.round(F.scoreFarmSite({ tillable: 33, flatFrac: 1.0, distHome: 40, target: 33 }).score * 100) / 100, 7, 'scoreFarmSite: default opts match distWeight 0.75')
}

// ---- #56 FARM_FLAT_SITE: flatFrac floor on `acceptable` (reject rough/wet pond edges) ----
{
  // minFlatFrac opt injects the floor (testable/gated): a tillable-but-ROUGH site is NOT acceptable.
  const rough = F.scoreFarmSite({ tillable: 33, flatFrac: 0.3, distHome: 40, target: 33 }, { minFlatFrac: 0.6 })
  eq(rough.acceptable, false, 'FARM_FLAT_SITE: flatFrac 0.3 < floor 0.6 -> NOT acceptable (even with 33 tillable)')
  // exactly at the floor -> acceptable.
  eq(F.scoreFarmSite({ tillable: 33, flatFrac: 0.6, distHome: 40, target: 33 }, { minFlatFrac: 0.6 }).acceptable, true, 'FARM_FLAT_SITE: flatFrac 0.6 == floor -> acceptable')
  eq(F.scoreFarmSite({ tillable: 33, flatFrac: 1.0, distHome: 40, target: 33 }, { minFlatFrac: 0.6 }).acceptable, true, 'FARM_FLAT_SITE: a flat site (1.0) -> acceptable')
  // the floor still needs the tillable floor too (both must pass).
  eq(F.scoreFarmSite({ tillable: 5, flatFrac: 1.0, distHome: 40, target: 33 }, { minFlatFrac: 0.6 }).acceptable, false, 'FARM_FLAT_SITE: flat but tillable 5 < 6 -> still NOT acceptable')
  // FLAG/OPT OFF (minFlatFrac 0) matches today: tillable-only gate, rough sites accepted.
  eq(F.scoreFarmSite({ tillable: 33, flatFrac: 0.3, distHome: 40, target: 33 }, { minFlatFrac: 0 }).acceptable, true, 'FARM_FLAT_SITE=0 (minFlatFrac 0): rough site accepted (today)')
  eq(F.scoreFarmSite({ tillable: 6, flatFrac: 0, distHome: 10, target: 33 }, { minFlatFrac: 0 }).acceptable, true, 'FARM_FLAT_SITE=0: tillable 6, flat 0 -> acceptable (today)')
  // the score term is UNCHANGED by the gate (still quality - distWeight*dist, quality += 4*flat).
  eq(F.scoreFarmSite({ tillable: 33, flatFrac: 0.3, distHome: 40, target: 33 }, { minFlatFrac: 0.6 }).score,
     F.scoreFarmSite({ tillable: 33, flatFrac: 0.3, distHome: 40, target: 33 }, { minFlatFrac: 0 }).score, 'FARM_FLAT_SITE: gate never changes the score, only acceptable')
  // env fallback (no opt): FARM_FLAT_SITE=0 disables the floor; default floor 0.6 otherwise.
  const savedSite = process.env.FARM_FLAT_SITE; const savedMin = process.env.FARM_FLAT_MIN
  delete process.env.FARM_FLAT_SITE; delete process.env.FARM_FLAT_MIN
  eq(F.scoreFarmSite({ tillable: 33, flatFrac: 0.3, distHome: 40, target: 33 }).acceptable, false, 'FARM_FLAT_SITE env default: floor 0.6 -> rough site NOT acceptable')
  eq(F.scoreFarmSite({ tillable: 33, flatFrac: 0.7, distHome: 40, target: 33 }).acceptable, true, 'FARM_FLAT_SITE env default: flat 0.7 -> acceptable')
  process.env.FARM_FLAT_SITE = '0'
  eq(F.scoreFarmSite({ tillable: 33, flatFrac: 0.3, distHome: 40, target: 33 }).acceptable, true, 'FARM_FLAT_SITE=0 env: floor disabled -> rough site accepted (today)')
  if (savedSite === undefined) delete process.env.FARM_FLAT_SITE; else process.env.FARM_FLAT_SITE = savedSite
  if (savedMin === undefined) delete process.env.FARM_FLAT_MIN; else process.env.FARM_FLAT_MIN = savedMin
}

// ---- #56 FARM_EXCLUDE_YFIX: per-cell crop-footprint membership (offline predicate) --------
{
  // A multi-LEVEL plot (the exact bug: cells at different Y) - every cell must be protected at its
  // OWN level, plus the farmland below (y-1) and the block above (y+1).
  const cells = [{ x: 10, y: 64, z: 20 }, { x: 11, y: 66, z: 20 }] // two crop cells, 2 Y apart
  eq(F.footprintHasCell(cells, 10, 64, 20), true, 'YFIX: crop cell itself excluded')
  eq(F.footprintHasCell(cells, 10, 63, 20), true, 'YFIX: farmland under the crop (y-1) excluded')
  eq(F.footprintHasCell(cells, 10, 65, 20), true, 'YFIX: block above the crop (y+1) excluded')
  eq(F.footprintHasCell(cells, 11, 66, 20), true, 'YFIX: the SECOND cell at a DIFFERENT Y is excluded at its own level (the multi-level fix)')
  eq(F.footprintHasCell(cells, 11, 65, 20), true, 'YFIX: farmland under the second cell excluded')
  // Outside the footprint: a different column, or too far in Y, is NOT excluded.
  eq(F.footprintHasCell(cells, 12, 64, 20), false, 'YFIX: neighbouring column (not a cell) not excluded')
  eq(F.footprintHasCell(cells, 10, 62, 20), false, 'YFIX: y-2 below a crop cell not excluded (outside +-1)')
  eq(F.footprintHasCell(cells, 10, 66, 20), false, 'YFIX: y+2 above a crop cell not excluded')
  eq(F.footprintHasCell(cells, 10, 64, 21), false, 'YFIX: same x/y, different z not excluded')
  // Empty / null footprint is never excluded.
  eq(F.footprintHasCell([], 10, 64, 20), false, 'YFIX: empty plot -> nothing excluded')
  eq(F.footprintHasCell(null, 10, 64, 20), false, 'YFIX: null cells -> nothing excluded')
}

// shouldResite: the full live case true + every false gate.
{
  const opt = { margin: 8, nearHome: 112, slack: 16, minCellsFrac: 0.5 }
  // Full live case: maxed 10-cell mound @77b (score -46.55) vs clearly-better flat bank @40b (score 7).
  eq(F.shouldResite({ curCells: 10, curMaxed: true, curScore: -46.55, curDist: 77, bestScore: 7, bestDist: 40, target: 33 }, opt), true, 'shouldResite: maxed tiny mound @77b -> flat bank @40b => TRUE')
  // producing/near-target farm is NEVER abandoned (cells >= target*0.5 = 16.5).
  eq(F.shouldResite({ curCells: 20, curMaxed: true, curScore: -46.55, curDist: 77, bestScore: 7, bestDist: 40, target: 33 }, opt), false, 'shouldResite: producing farm (cells>=target/2) => FALSE always')
  // not maxed -> never move.
  eq(F.shouldResite({ curCells: 10, curMaxed: false, curScore: -46.55, curDist: 77, bestScore: 7, bestDist: 40, target: 33 }, opt), false, 'shouldResite: not maxed => FALSE')
  // margin unmet (bestScore < curScore + margin).
  eq(F.shouldResite({ curCells: 10, curMaxed: true, curScore: 0, curDist: 77, bestScore: 7, bestDist: 40, target: 33 }, opt), false, 'shouldResite: quality gain < margin => FALSE')
  // bestDist beyond nearHome (112).
  eq(F.shouldResite({ curCells: 10, curMaxed: true, curScore: -46.55, curDist: 200, bestScore: 7, bestDist: 120, target: 33 }, opt), false, 'shouldResite: bestDist 120 > nearHome 112 => FALSE')
  // bestDist farther than curDist + slack (95b vs the 77b farm; +16 slack = 93b cap).
  eq(F.shouldResite({ curCells: 10, curMaxed: true, curScore: -46.55, curDist: 77, bestScore: 7, bestDist: 95, target: 33 }, opt), false, 'shouldResite: bestDist 95 > curDist 77 + slack 16 => FALSE (never farther out)')
  // default opts.
  eq(F.shouldResite({ curCells: 10, curMaxed: true, curScore: -46.55, curDist: 77, bestScore: 7, bestDist: 40, target: 33 }), true, 'shouldResite: default opts match the live-calibrated gates')
}

// ---- plotCollectRadius: FIX #38 whole-plot collect sweep --------------------------
{
  const anchor = { x: 446, z: 31 }
  // No cells / no anchor -> today's radius (base 6).
  eq(F.plotCollectRadius([], anchor), 6, 'plotCollectRadius: empty plot -> base radius 6')
  eq(F.plotCollectRadius(null, anchor), 6, 'plotCollectRadius: null cells -> base 6')
  eq(F.plotCollectRadius([{ x: 446, z: 31 }], null), 6, 'plotCollectRadius: no anchor -> base 6')
  // A tight plot within radius 6 stays at the base (never shrinks below today's sweep).
  eq(F.plotCollectRadius([{ x: 447, z: 32 }, { x: 445, z: 30 }], anchor), 6, 'plotCollectRadius: tight plot -> stays at base 6')
  // A wide plot: farthest cell ~7.07b from anchor -> ceil(7.07)+4 = 12.
  eq(F.plotCollectRadius([{ x: 451, z: 36 }, { x: 441, z: 26 }], anchor), 12, 'plotCollectRadius: 5x5-corner plot -> maxD(~7)+margin = 12')
  // Cap: a runaway/foreign-cell distance is clamped so the sweep never wanders off-plot.
  eq(F.plotCollectRadius([{ x: 446 + 100, z: 31 }], anchor), 24, 'plotCollectRadius: far outlier clamped to cap 24')
  // margin/cap/base overridable.
  eq(F.plotCollectRadius([{ x: 456, z: 31 }], anchor, { margin: 2, cap: 50 }), 12, 'plotCollectRadius: custom margin (10+2)')
}

// ---- #59 §A FARM_SEED_BANK: bank-first seed withdraw amount ------------------------
{
  // The decision the real path embodies: withdraw the shortfall (want - packSeeds), floored at 0,
  // capped by what the bank actually holds. >0 means "raid the bank BEFORE any grass".
  eq(F.seedBankWithdrawAmount(64, 0, 12), 12, 'seedBank: full bank, empty pack -> withdraw the full want (bank-first, before gather)')
  eq(F.seedBankWithdrawAmount(64, 5, 12), 7, 'seedBank: pack has 5, want 12 -> withdraw only the 7 shortfall')
  eq(F.seedBankWithdrawAmount(3, 0, 12), 3, 'seedBank: bank short (3) -> withdraw all 3, THEN grass covers the rest')
  eq(F.seedBankWithdrawAmount(0, 0, 12), 0, 'seedBank: empty bank -> 0 (fall through to the grass fallback)')
  eq(F.seedBankWithdrawAmount(64, 12, 12), 0, 'seedBank: pack already has want -> 0 (no bank trip)')
  eq(F.seedBankWithdrawAmount(64, 20, 12), 0, 'seedBank: pack over want -> 0, never negative')
  // Bank stock unknown at call time (provision passes Infinity; the withdraw itself caps to reality).
  eq(F.seedBankWithdrawAmount(Infinity, 5, 12), 7, 'seedBank: unknown bank stock -> request the full shortfall (7)')
  eq(F.seedBankWithdrawAmount(Infinity, 12, 12), 0, 'seedBank: unknown bank + pack full -> 0')
  // FLAG REGIME: FARM_SEED_BANK=0 is enforced at the call site (provision.withdrawSeedsFromBank
  // early-returns), never in this PURE amount fn. The amount math is identical both regimes; only
  // whether provision CALLS it differs - asserted here for completeness.
  eq(F.seedBankWithdrawAmount(64, 0, 12), 12, 'seedBank: pure amount is flag-independent (gate lives in provision)')
}

// ---- #59 §B FARM_HARVEST_FIRST: harvest-standing vs establish decision -------------
{
  // Flag ON (default): a standing farm + food below the crisis threshold -> harvest the STANDING
  // farm before establishing a redundant new plot at stale water.
  eq(F.foodCrisisFarmAction({ hasStandingFarm: true, food: 8, harvestFirst: true }), 'harvest-standing', 'harvestFirst ON: standing farm + food<14 -> harvest-standing')
  eq(F.foodCrisisFarmAction({ hasStandingFarm: true, food: 13, harvestFirst: true }), 'harvest-standing', 'harvestFirst ON: standing farm + food 13 (<14) -> harvest-standing')
  eq(F.foodCrisisFarmAction({ hasStandingFarm: true, food: 14, harvestFirst: true }), 'establish', 'harvestFirst ON: food 14 (not <14) -> not a crisis, establish path')
  eq(F.foodCrisisFarmAction({ hasStandingFarm: false, food: 8, harvestFirst: true }), 'establish', 'harvestFirst ON: NO standing farm -> establish (nothing to harvest)')
  // Flag OFF (FARM_HARVEST_FIRST=0): ALWAYS establish (today's establish-first behavior), even with
  // a standing farm at food 8 - byte-for-byte the pre-#59 decision.
  eq(F.foodCrisisFarmAction({ hasStandingFarm: true, food: 8, harvestFirst: false }), 'establish', 'harvestFirst OFF: standing farm + food<14 STILL establishes (today byte-for-byte)')
  eq(F.foodCrisisFarmAction({ hasStandingFarm: false, food: 8, harvestFirst: false }), 'establish', 'harvestFirst OFF: no farm -> establish')
  // Threshold + defaults.
  eq(F.foodCrisisFarmAction({ hasStandingFarm: true, food: 8 }), 'harvest-standing', 'default harvestFirst=true -> harvest-standing')
  eq(F.foodCrisisFarmAction({ hasStandingFarm: true, food: 8, harvestFirst: true, foodThreshold: 6 }), 'establish', 'threshold tunable: food 8 not < 6 -> establish')
}

// ---- #87 DRY_HOME_FARM: hut-adjacent dry-plot gate (dryHomeFarmMode) ----------------
{
  // Flag ON, hut exists, NO standing farm near the hut -> establish (the first plot, OR supersede a
  // far water farm: the "near" test is the caller's, so a 60b farm still reads as none-near).
  eq(F.dryHomeFarmMode({ flag: true, hutExists: true, standingNearHut: false }), 'establish', 'dry: flag on + hut + no near farm -> establish (dry site accepted; no water needed)')
  eq(F.dryHomeFarmMode({ flag: true, hutExists: true, standingNearHut: false, farmIsDry: false, cells: 33, target: 33, maxed: true }), 'establish', 'dry: a far maxed WATER farm (not near the hut) is still superseded -> establish')
  // Flag OFF -> always off (water requirement intact; today byte-for-byte).
  eq(F.dryHomeFarmMode({ flag: false, hutExists: true, standingNearHut: false }), 'off', 'dry: FLAG OFF -> off (legacy water-anchored path, requirement intact)')
  // No hut anchor -> off (a dry plot needs a home to sit beside).
  eq(F.dryHomeFarmMode({ flag: true, hutExists: false, standingNearHut: false }), 'off', 'dry: no hut anchor -> off')
  // A standing DRY home plot under target and not maxed -> expand.
  eq(F.dryHomeFarmMode({ flag: true, hutExists: true, standingNearHut: true, farmIsDry: true, cells: 9, target: 33, maxed: false }), 'expand', 'dry: standing dry plot under target, not maxed -> expand')
  eq(F.dryHomeFarmMode({ flag: true, hutExists: true, standingNearHut: true, farmIsDry: true, cells: 33, target: 33, maxed: false }), 'off', 'dry: dry plot AT target -> off (nothing to add)')
  eq(F.dryHomeFarmMode({ flag: true, hutExists: true, standingNearHut: true, farmIsDry: true, cells: 12, target: 33, maxed: true }), 'off', 'dry: dry plot maxed (annulus exhausted) -> off (leave it, tend un-latches on retire)')
  // A GENUINE near-hut WATER farm (not dry) must NOT be disturbed -> off.
  eq(F.dryHomeFarmMode({ flag: true, hutExists: true, standingNearHut: true, farmIsDry: false, cells: 10, target: 33, maxed: false }), 'off', 'dry: a real near-hut water farm is left alone -> off (never clobbered)')
  // Defaults: flag defaults on, but no hut -> off.
  eq(F.dryHomeFarmMode({}), 'off', 'dry: defaults (no hut) -> off')
}

// ---- NEAT FLAT FARM (2026-08-30): rectangle + walkway = one surface, or it is not a farm ----------
{
  const rect = F.plotRect({ x: 10, z: 20 }, 3, 2) // x10-12, z20-21
  eq(F.rectCells(rect, 0).length, 6, 'plot: 3x2 rect has 6 plot cells')
  eq(F.rectCells(rect, 1).length, 20, 'plot: 3x2 rect + 1 walkway = 5x4 = 20 cells')
  eq(F.rectCells(rect, 1).filter(c => c.plot).length, 6, 'plot: walkway cells are flagged plot:false')
  const flat = F.rectCells(rect, 1).map(c => ({ x: c.x, z: c.z, groundY: 64, water: false }))
  const v0 = F.plotSurfaceVerdict(flat, 64, rect)
  eq(v0.ok, true, 'plot: a flat rect+walkway at baseY is ok')
  eq(v0.work, 0, 'plot: no work on a flat surface')
  const dip = flat.map(s => (s.x === 11 && s.z === 20) ? { ...s, groundY: 62 } : s)
  const v1 = F.plotSurfaceVerdict(dip, 64, rect)
  eq(v1.ok, false, 'plot: a 2-deep dip in the plot fails')
  eq(v1.dips, 1, 'plot: ...counted as a dip'); eq(v1.work, 2, 'plot: ...two blocks of fill')
  const step = flat.map(s => (s.x === 9 && s.z === 19) ? { ...s, groundY: 65 } : s)
  eq(F.plotSurfaceVerdict(step, 64, rect).ok, true, 'plot: a one-step-up walkway cell is walkable -> ok')
  const hole = flat.map(s => (s.x === 9 && s.z === 19) ? { ...s, groundY: 62 } : s)
  const v2 = F.plotSurfaceVerdict(hole, 64, rect)
  eq(v2.ok, false, 'plot: a 2-deep hole in the walkway is a drop -> fails'); eq(v2.drops, 1, 'plot: ...counted as a drop')
  const wet = flat.map(s => (s.x === 13 && s.z === 21) ? { ...s, water: true } : s)
  const v3 = F.plotSurfaceVerdict(wet, 64, rect)
  eq(v3.ok, false, 'plot: water beside the plot fails'); eq(F.scorePlotSite(v3, 5), null, 'plot: ...and the site is disqualified')
  const unk = flat.map(s => (s.x === 10 && s.z === 20) ? { ...s, groundY: null } : s)
  eq(F.plotSurfaceVerdict(unk, 64, rect).unknown, 1, 'plot: an unreadable cell is unknown, not flat (#10)')
  eq(F.plotBaseY(flat, rect, 64), 64, 'plot: baseY is the median plot ground')
  eq(F.plotBaseY(flat.map(s => ({ ...s, groundY: 60 })), rect, 64), null, 'plot: a plot 4 below home grade is too far from the door')
  eq(F.scorePlotSite(v1, 10) > F.scorePlotSite(v0, 10), true, 'plot: more earth to move scores worse')
  eq(F.rectHasCell(rect, 64, 9, 64, 19), true, 'plot: the walkway is part of the protected footprint')
  eq(F.rectHasCell(rect, 64, 8, 64, 19), false, 'plot: two blocks out is not')
  eq(F.dryHomeFarmMode({ flag: true, hutExists: true, standingNearHut: true, farmIsDry: false, cells: 21, target: 33, maxed: false, standingUnsafe: true }), 'establish', 'dry: a near water farm whose surface FAILS the survey is re-sited')
  eq(F.dryHomeFarmMode({ flag: true, hutExists: true, standingNearHut: true, farmIsDry: false, cells: 21, target: 33, maxed: false, standingUnsafe: false }), 'off', 'dry: ...a safe one is kept')
}

// ---- FIX 10 (audit 2026-07-29): enough flat CELLS, not a flat RATIO ----------------------
// Live: "annulus off the hut not acceptable (tillable 197, flat 0.01) - deferring to fallback" x25,
// after which the fallback sited a 2-cell farm. The ratio gate punishes a site for being BIG.
{
  const sc = (tillable, flatFrac, target = 33) => F.scoreFarmSite({ tillable, flatFrac, distHome: 10, target }, { minFlatFrac: 0.35 })
  eq(sc(197, 0.20).acceptable, true, 'FIX10: 39 level cells covers a 33-cell target -> acceptable even at 20%')
  eq(sc(197, 0.20).flatCells, 39, 'FIX10: the absolute count is reported, not just the ratio')
  eq(sc(197, 0.01).acceptable, false, 'FIX10: 2 level cells is genuinely too rough - still rejected')
  eq(sc(40, 0.90).acceptable, true, 'FIX10: a small uniform site is unchanged')
  eq(F.scoreFarmSite({ tillable: 4, flatFrac: 1, distHome: 10, target: 33 }, { minFlatFrac: 0.35, minTillable: 6 }).acceptable, false,
    'FIX10: the minTillable floor still applies')
  // The gate must not become unconditional: with no target supplied, only the ratio can accept.
  eq(F.scoreFarmSite({ tillable: 197, flatFrac: 0.2, distHome: 10 }, { minFlatFrac: 0.35 }).acceptable, false,
    'FIX10: without a target the absolute-count escape cannot fire')
}

// ==== A HARVEST MUST REPORT ITSELF AS PROGRESS (live 2026-08-01) =============================
// The only automatic progress signal for tending is `itemDelta`, which fires on a change in TOTAL
// ITEM COUNT. A tend cell harvests a crop and REPLANTS it - gaining a wheat plus seeds, then
// spending seeds - so the net count barely moves and real work looked exactly like idling:
//   13:48:14 farm health: wheat=17(mature 15)      <- fifteen ripe cells, four blocks away
//   13:47:58 (wd) FAIL-JOB secureFood - no verified progress for 46s
//   13:48:58 (wd) REVOKED the dispatch slot from secureFood
//   13:49:09 wheat farm tended: harvested 1, replanted 2   -> food 0, famine hold, starving
// The sweep was killed after ONE cell every time. The witness measured the wrong thing.
{
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, 'provision-farm.js'), 'utf8')
  const i = src.indexOf('await bot.dig(b); harvested++')
  eq(i > 0, true, 'progress: the harvest site still exists')
  const after = src.slice(i, i + 1600)
  eq(/touchProgress\('harvest'\)/.test(after), true, "progress: a harvested crop must stamp the clock - itemDelta cannot see a harvest+replant cell")
  eq(/touchProgress\('replant'\)/.test(src), true, 'progress: a replanted cell is a real world change too')
  const tel = fs.readFileSync(path.join(__dirname, 'telemetry.js'), 'utf8')
  const tags = (tel.match(/const CYCLE_WORK_TAGS = new Set\(\[[^\]]*\]/) || [''])[0]
  eq(/'harvest'/.test(tags) && /'replant'/.test(tags), true, 'progress: both count as WORK, or the cycle detector still reads a tend as idling')
}

// ---- the tend scan must report what it SAW, not what it assumed (2026-08-02) --------------
// `farm health: wheat=0(mature 0) gone=0 flooded=0 blocked=0` printed nine times in six minutes
// for a plot holding 24 crops (17 mature). All five counters zero for a 41-cell plot cannot mean
// "41 bare cells" - bare reads as `gone` - it means the loop tallied NOTHING, because the
// isStopped() break fired on the first cell. It read as farm loss and sent the investigation the
// wrong way. These guard the honest line and the untouched-unknown rule.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'provision-farm.js'), 'utf8')
  eq(/farm health: inspected ' \+ cSeen \+ '\/' \+ cells\.length/.test(src), true,
    'scan: the health line must say how many of the plot\'s cells were actually inspected')
  eq(/SCAN CUT \(stopped\)/.test(src), true, 'scan: a scan cut short must SAY it was cut - never report a partial pass as a complete one')
  eq(/if \(state === 'unknown'\) \{ cUnknown\+\+; continue \}/.test(src), true,
    'scan: an unreadable cell is skipped untouched - never replanted, never aged toward retirement')
  eq(/if \(isStopped\(\)\) \{ cut = true; break \}/.test(src), true, 'scan: the stop that ends the pass is what the line reports')
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall farm tests passed')
process.exit(failures ? 1 : 0)
