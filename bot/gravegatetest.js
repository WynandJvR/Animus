'use strict'
// OFFLINE unit test for the pure respawn grave-chase survival gate
// (commands.shouldChaseGrave) - no bot, no world. Run: cd bot && node gravegatetest.js
//
// The live death-spiral it guards: on a far respawn (bed creeper-destroyed -> WORLD SPAWN
// ~380b from home) the handler sent a NAKED, empty-pack, food-draining bot on a long trek to
// chase dropped gear - it starved (food 20->0) + got beaten to death en route, respawned, and
// repeated, bleeding gear each loop. A FAR grave must DEFER when the bot is hungry, when a
// hostile is on it, when it's fleeing, or when the grave is far from BOTH the bot and home.
//
// S1 HOTFIX (the ratchet fix): the food gate used to run BEFORE distance, so a grave 3b away was
// deferred *because* the corpse-run had made the bot hungry - each death respawned strictly
// weaker. Now a non-dangerous, no-threat grave within GRAVE_NEAR (16b) is chased REGARDLESS of
// food/hp (at arm's reach the grave IS the survival move); the food gate only guards FAR treks.
const C = require('./commands.js')

let failures = 0
function eq (got, want, label) {
  const ok = got === want
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}

const home = { x: 416, y: 65, z: 87 }
const adjGrave = { x: 418, y: 65, z: 88 }   // ~2b from home (within GRAVE_NEAR)
const midGrave = { x: 456, y: 65, z: 87 }   // ~40b from home (beyond GRAVE_NEAR, within GRAVE_MAX_DIST)
const grave90 = { x: 506, y: 65, z: 87 }    // ~90b from home (within default GRAVE_MAX_DIST 96)
const farGrave = { x: 900, y: 71, z: 900 }  // far from BOTH world spawn and home

// ---- THE S1 RATCHET FIX: a NEAR grave is chased regardless of food/hp -----------------------
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: null, home }).chase, true,
  'food 0 + grave 3b + no threat -> CHASE (arm-reach grave IS the survival move; the ratchet fix)')
eq(C.shouldChaseGrave({ grave: adjGrave, pos: { x: 700, y: 65, z: 700 }, food: 0, threat: null, home }).chase, true,
  'food 0 + grave near HOME though far from the bot -> CHASE (min(bot,home) within GRAVE_NEAR)')
// ...but the near override must still respect ACTIVE hazards.
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: null, dangerous: true, home }).chase, false,
  'near grave in/over a hazard (dangerous) -> DEFER even at 3b')
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: { type: 'zombie', dist: 4 }, home }).chase, false,
  'near grave with a hostile on the bot (threat) -> DEFER even at 3b')

// ---- FAR grave keeps the fed+safe trek gate -------------------------------------------------
eq(C.shouldChaseGrave({ grave: grave90, pos: home, food: 0, threat: null, home }).chase, false,
  'food 0 + grave 90b -> DEFER (do not starve trekking for a far grave)')
eq(C.shouldChaseGrave({ grave: grave90, pos: home, food: 18, threat: null, home }).chase, true,
  'food 18 + grave 90b within GRAVE_MAX_DIST -> CHASE (fed bot fetches a reachable grave)')
eq(C.shouldChaseGrave({ grave: farGrave, pos: { x: 0, y: 65, z: 1 }, food: 20, threat: null, home }).chase, false,
  'grave far from BOTH bot and home -> DEFER (do not starve trekking for it)')
eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: 8, threat: null, home }).chase, false,
  'hungry (food 8 < 12) + FAR grave (~40b) -> DEFER until fed')
eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: null, threat: null, home }).chase, false,
  'food unknown (not spawned yet) + FAR grave -> DEFER')
eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: 12, threat: null, home }).chase, true,
  'food exactly at the 12 floor + FAR grave in reach -> CHASE')
// A grave far from the bot but NEAR home is still fine to fetch (min(dBot,dHome) <= max).
eq(C.shouldChaseGrave({ grave: midGrave, pos: { x: 300, y: 65, z: 300 }, food: 20, threat: null, home }).chase, true,
  'FAR grave far from bot but near HOME -> CHASE (min of bot/home distance)')

// ---- hostiles / fleeing -> DEFER regardless of hunger/distance ----------------------------
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 20, threat: { type: 'zombie', dist: 6 }, home }).chase, false,
  'hostile on the bot -> DEFER even fed + close')
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 20, threat: null, escaping: true, home }).chase, false,
  'fleeing/escaping a hazard -> DEFER')

// ---- SAFE + FED -> CHASE (genuine behaviour must survive) ----------------------------------
eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 20, threat: null, home }).chase, true,
  'safe + fed + near grave -> CHASE')

// ---- no grave / no position -> honest no-op ------------------------------------------------
eq(C.shouldChaseGrave({ grave: null, pos: home, food: 20, home }).chase, false, 'no grave -> no chase')
eq(C.shouldChaseGrave({ grave: adjGrave, pos: null, food: 20, home }).chase, false, 'no position -> no chase')

// ---- thresholds come from env when not passed ---------------------------------------------
{
  const savedFood = process.env.GRAVE_MIN_FOOD
  const savedDist = process.env.GRAVE_MAX_DIST
  const savedNear = process.env.GRAVE_NEAR
  process.env.GRAVE_MIN_FOOD = '18'
  eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: 15, threat: null, home }).chase, false,
    'GRAVE_MIN_FOOD=18 -> food 15 defers a FAR grave')
  delete process.env.GRAVE_MIN_FOOD
  process.env.GRAVE_MAX_DIST = '2000'
  eq(C.shouldChaseGrave({ grave: farGrave, pos: { x: 0, y: 65, z: 1 }, food: 20, threat: null, home }).chase, true,
    'GRAVE_MAX_DIST=2000 -> the far grave becomes reachable')
  delete process.env.GRAVE_MAX_DIST
  // GRAVE_NEAR shrinks the arm's-reach band: a 40b grave is no longer a near-override chase.
  process.env.GRAVE_NEAR = '4'
  eq(C.shouldChaseGrave({ grave: midGrave, pos: home, food: 0, threat: null, home }).chase, false,
    'GRAVE_NEAR=4 -> a 40b grave at food 0 is NOT a near override (falls to the food gate)')
  eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: null, home }).chase, true,
    'GRAVE_NEAR=4 -> a 2b grave at food 0 still overrides')
  delete process.env.GRAVE_NEAR
  if (savedFood != null) process.env.GRAVE_MIN_FOOD = savedFood
  if (savedDist != null) process.env.GRAVE_MAX_DIST = savedDist
  if (savedNear != null) process.env.GRAVE_NEAR = savedNear
}

// ---- ROLLBACK: S1_HOTFIX=0 restores the old food-gate-before-distance behavior --------------
{
  process.env.S1_HOTFIX = '0'
  eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 0, threat: null, home }).chase, false,
    'S1_HOTFIX=0 -> old behavior: food 0 defers even a 3b grave (near override disabled)')
  eq(C.shouldChaseGrave({ grave: adjGrave, pos: home, food: 20, threat: null, home }).chase, true,
    'S1_HOTFIX=0 -> fed bot still chases a near grave via the fed path')
  delete process.env.S1_HOTFIX
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
