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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall farm tests passed')
process.exit(failures ? 1 : 0)
