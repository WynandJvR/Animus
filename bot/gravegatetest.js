'use strict'
// OFFLINE unit test for the pure respawn grave-chase survival gate
// (commands.shouldChaseGrave) - no bot, no world. Run: cd bot && node gravegatetest.js
//
// The live death-spiral it guards: on a far respawn (bed creeper-destroyed -> WORLD SPAWN
// ~380b from home) the handler sent a NAKED, empty-pack, food-draining bot on a long trek to
// chase dropped gear - it starved (food 20->0) + got beaten to death en route, respawned, and
// repeated, bleeding gear each loop. The gate must DEFER the chase when the bot is hungry, when
// a hostile is on it, when it's fleeing, or when the grave is far from BOTH the bot and home -
// and ALLOW it only when safe + fed + reasonably reachable.
const C = require('./commands.js')

let failures = 0
function eq (got, want, label) {
  const ok = got === want
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}

const home = { x: 416, y: 65, z: 87 }
const nearGrave = { x: 430, y: 64, z: 90 }  // ~15b from home
const farGrave = { x: 900, y: 71, z: 900 }  // far from BOTH world spawn and home

// ---- THE LIVE BUG: naked + starving after a far respawn -> DEFER (never trek) --------------
eq(C.shouldChaseGrave({ grave: farGrave, pos: { x: 0, y: 65, z: 1 }, food: 20, threat: null, home }).chase, false,
  'grave far from BOTH bot and home -> DEFER (do not starve trekking for it)')
eq(C.shouldChaseGrave({ grave: nearGrave, pos: home, food: 8, threat: null, home }).chase, false,
  'hungry (food 8 < 12) even at a NEAR grave -> DEFER until fed')
eq(C.shouldChaseGrave({ grave: nearGrave, pos: home, food: null, threat: null, home }).chase, false,
  'food unknown (not spawned yet) -> DEFER')

// ---- hostiles / fleeing -> DEFER regardless of hunger/distance ----------------------------
eq(C.shouldChaseGrave({ grave: nearGrave, pos: home, food: 20, threat: { type: 'zombie', dist: 6 }, home }).chase, false,
  'hostile on the bot -> DEFER even fed + close')
eq(C.shouldChaseGrave({ grave: nearGrave, pos: home, food: 20, threat: null, escaping: true, home }).chase, false,
  'fleeing/escaping a hazard -> DEFER')

// ---- SAFE + FED + reachable -> CHASE (genuine behaviour must survive) ----------------------
eq(C.shouldChaseGrave({ grave: nearGrave, pos: home, food: 20, threat: null, home }).chase, true,
  'safe + fed + near grave -> CHASE (armored fed bot near a close grave still recovers)')
eq(C.shouldChaseGrave({ grave: nearGrave, pos: home, food: 12, threat: null, home }).chase, true,
  'food exactly at the 12 floor -> CHASE')
// A grave far from the bot but NEAR home is still fine to fetch (min(dBot,dHome) <= max).
eq(C.shouldChaseGrave({ grave: nearGrave, pos: { x: 300, y: 65, z: 300 }, food: 20, threat: null, home }).chase, true,
  'grave far from bot but near HOME -> CHASE (min of bot/home distance)')

// ---- no grave / no position -> honest no-op ------------------------------------------------
eq(C.shouldChaseGrave({ grave: null, pos: home, food: 20, home }).chase, false, 'no grave -> no chase')
eq(C.shouldChaseGrave({ grave: nearGrave, pos: null, food: 20, home }).chase, false, 'no position -> no chase')

// ---- thresholds come from env when not passed ---------------------------------------------
{
  const savedFood = process.env.GRAVE_MIN_FOOD
  const savedDist = process.env.GRAVE_MAX_DIST
  process.env.GRAVE_MIN_FOOD = '18'
  eq(C.shouldChaseGrave({ grave: nearGrave, pos: home, food: 15, threat: null, home }).chase, false,
    'GRAVE_MIN_FOOD=18 -> food 15 defers')
  delete process.env.GRAVE_MIN_FOOD
  process.env.GRAVE_MAX_DIST = '2000'
  eq(C.shouldChaseGrave({ grave: farGrave, pos: { x: 0, y: 65, z: 1 }, food: 20, threat: null, home }).chase, true,
    'GRAVE_MAX_DIST=2000 -> the far grave becomes reachable')
  delete process.env.GRAVE_MAX_DIST
  if (savedFood != null) process.env.GRAVE_MIN_FOOD = savedFood
  if (savedDist != null) process.env.GRAVE_MAX_DIST = savedDist
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
