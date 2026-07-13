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

// A wheat block carries an `age` property 0..7; it is ready to harvest at age 7.
function matureForHarvest (age) { return age != null && age >= 7 }

// The farmland block a crop is (re)planted on must actually be tilled farmland.
function farmlandReady (name) { return name === 'farmland' }

// The block name a bank cell must have to be tillable directly (no dirt-swap needed).
function tillableBank (name) { return /^(grass_block|dirt|coarse_dirt|rooted_dirt|farmland)$/.test(name || '') }

module.exports = { bankUsable, BANK_DYS, cropCellState, matureForHarvest, farmlandReady, tillableBank }
