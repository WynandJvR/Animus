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
eq(F.cropCellState(null), 'gone', 'null (unloaded-ish) -> gone')
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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall farm tests passed')
process.exit(failures ? 1 : 0)
