'use strict'
// OFFLINE unit test for the provision.js SPLIT - no bot, no world.
// Run: cd bot && node provsplittest.js
//
// WHY THIS EXISTS: the split introduced a failure mode the rest of the suite cannot see.
// provision.js is full of defensive `try {} catch {}` blocks that DEGRADE instead of
// failing, so a function moved into a new module that still references a binding left
// behind in provision.js throws a ReferenceError, gets swallowed, and quietly returns
// "nothing here". That happened twice for real during the split:
//
//   - ownInfraAnchors() referenced `buildZone` -> recordWedge/listWedges silently stopped
//     recording, i.e. the bot would have quietly forgotten every place it got stuck.
//   - planTrekRoute referenced NAV_WAYPOINT_GRAPH -> a working null return became a throw.
//
// Both were green on 35/35 the entire time. So this file does three things the other tests
// do not:
//   1. EXERCISES the swallowed paths and asserts they actually did the work (not just that
//      they returned without throwing).
//   2. Pins the FACADE contract - provision.js must keep re-exporting the same public
//      surface, and each re-export must BE the module's function, not a drifting copy.
//   3. Pins the __siblings bridge, which exists so leaves never widen the public API.

const path = require('path')
const os = require('os')
const fs = require('fs')

// Isolate persistence BEFORE anything loads - these modules read their file at require time.
const TMP = path.join(os.tmpdir(), 'provsplit-' + process.pid)
fs.mkdirSync(TMP, { recursive: true })
process.env.WORLD_MEM_FILE = path.join(TMP, 'world-memory.json')
process.env.DEATH_FILE = path.join(TMP, 'last-death.json')
process.env.RESUME_FILE = path.join(TMP, 'resume-job.json')

const provision = require('./provision.js')
const worldMemory = require('./world-memory.js')
const provCore = require('./provision-core.js')
const provHut = require('./provision-hut.js')
const provFarm = require('./provision-farm.js')
const provMining = require('./provision-mining.js')
const provBank = require('./provision-bank.js')
const provFood = require('./provision-food.js')

let failures = 0
function eq (got, want, label) {
  const ok = got === want
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}
function ok (cond, label) { eq(!!cond, true, label) }

// ---- 1. THE REGRESSION THAT WAS SILENT -----------------------------------------------------
// recordWedge -> listWedges is the exact path that broke. Assert the WORK happened, because
// the catch means a total failure still looks like a polite empty list.
{
  const before = worldMemory.listWedges().length
  worldMemory.recordWedge({ x: 5000, y: 64, z: 5000 })
  const after = worldMemory.listWedges()
  eq(after.length, before + 1, 'wedge: recordWedge actually RECORDS (the buildZone ReferenceError was swallowed here)')
  ok(after.some(w => Math.abs(w.x - 5000) < 24 && Math.abs(w.z - 5000) < 24), 'wedge: the recorded wedge is the one we asked for')

  // ownInfraAnchors is what threw. It must return an array, not explode into the catch.
  const anchors = worldMemory.ownInfraAnchors()
  ok(Array.isArray(anchors), 'anchors: ownInfraAnchors returns an array (it referenced a binding left behind)')

  // and it must still be reachable through the facade with the SAME result
  eq(JSON.stringify(provision.listWedges()), JSON.stringify(after), 'wedge: facade and module agree')
}

// planTrekRoute was the second silent break - a working null turned into a throw.
{
  let threw = null
  let r
  try { r = worldMemory.planTrekRoute({ x: 0, y: 64, z: 0 }, { x: 300, y: 64, z: 300 }) } catch (e) { threw = e.message }
  eq(threw, null, 'route: planTrekRoute does not throw (NAV_WAYPOINT_GRAPH was left behind)')
  ok(r === null || typeof r === 'object', 'route: planTrekRoute returns null or a route')
}

// buildZone must reach world-memory, or wedge suppression silently stops working.
{
  provision.setBuildZone({ x1: 6000, z1: 6000, x2: 6020, z2: 6020 })
  const before = worldMemory.listWedges().length
  worldMemory.recordWedge({ x: 6010, y: 64, z: 6010 }) // dead centre of the zone
  eq(worldMemory.listWedges().length, before, 'buildZone: a wedge inside the active build zone is SUPPRESSED (the mirror works)')
  provision.setBuildZone(null)
}

// ---- 2. THE FACADE CONTRACT ----------------------------------------------------------------
// Every importer (index.js, commands.js, scheduler.js, resources.js) calls provision.js.
// The split is only safe while that surface is unchanged AND not a stale copy.
{
  const pub = Object.keys(provision).filter(k => k !== '__siblings')
  eq(pub.length, 159, 'facade: provision.js still exports exactly 159 public names') // +2: secureBase, secureBaseGate (#67 SECURE_BASE); +2: ironGrindMinedReal, resetIronGrindMined (IRON_KEYSTONE); +1: deathSpotExclusion (#85 DEATH_SPOT_COST)

  const moved = [
    [worldMemory, ['listInfra', 'rememberInfra', 'forgetInfra', 'recordWedge', 'listWedges', 'ownInfraAnchors',
      'rememberRoute', 'recallRoute', 'planTrekRoute', 'dementRoute', 'knownBed', 'rememberBed',
      'markBedUnusable', 'bedHeld', 'setSpawnSuspect', 'isSpawnSuspect', 'gearupState', 'gearupResult']],
    [provCore, ['inventoryCounts', 'toolForBlock', 'collectDrops', 'isNight', 'canBreakNaturally']],
    [provHut, ['hutAnchor', 'ownHutAt', 'onHutApron', 'insideOwnStructure', 'hasSolidCeiling',
      'maintainHome', 'maintainHut', 'repairHutStructure', 'furnishHut', 'ensureHutApron', 'ensureHutBed']],
    [provFarm, ['ensureWheatFarm', 'tendWheatFarm', 'hasStandingFarm', 'WHEAT_FARM_TARGET']],
    [provMining, ['branchMine', 'digStaircaseDown', 'climbToSurface', 'pillarUpTo']],
    [provBank, ['ensureChest', 'depositMaterials', 'withdrawItem', 'chestCounts', 'consolidateBank',
      'healBankDouble', 'migrateChestInto', 'lonelyFurnace', 'consolidateFurnaces', 'litterPatrol']],
    [provFood, ['hasFood', 'foodCount', 'needsFood', 'secureFood', 'fishForFood', 'huntForFood',
      'ensureFoodSupply', 'eatBestFood', 'cookRawMeat', 'scoutForFood', 'RAW_COOKABLE']]
  ]
  let checked = 0
  for (const [mod, names] of moved) {
    for (const n of names) {
      ok(provision[n] !== undefined, 'facade: provision.' + n + ' is still exported')
      eq(provision[n], mod[n], 'facade: provision.' + n + ' IS the module\'s binding (no drifting copy)')
      checked++
    }
  }
  ok(checked >= 50, 'facade: checked ' + checked + ' moved names')
}

// ---- 3. THE __siblings BRIDGE --------------------------------------------------------------
// It exists so a leaf can reach provisioning internals WITHOUT widening the public API.
// If a getter silently returns undefined, the caller fails at runtime inside a catch.
{
  const s = provision.__siblings
  ok(s && typeof s === 'object', 'bridge: __siblings exists')
  // shelterSite left the bridge when provision-shelter was extracted: bank and food now
  // import it directly (no cycle in that direction). inWaterNow STAYS because provision-mining
  // cannot import provision-shelter - shelter already requires mining, so it would be a real
  // cycle. That asymmetry is the point: the bridge should hold only what genuinely cannot be
  // a direct import.
  const expected = ['foodPlanNow', 'topUpFoodForPlan', '_setFoodPlanHint', 'armorPieceCount',
    'inWaterNow', 'placeFromInventory', 'scaffoldDigOK', 'walkStaged', 'KEEP_WHEN_ALL',
    'explore', 'isSurvStopped']
  for (const n of expected) ok(s[n] !== undefined, 'bridge: __siblings.' + n + ' resolves (not undefined)')
  ok(!Object.keys(provision).includes('walkStaged'), 'bridge: internals stay OFF the public surface')
  ok(provision.__siblings.shelterSite === undefined, 'bridge: shelterSite LEFT the bridge (bank/food import it directly)')
  ok(require('./provision-shelter.js').shelterSite !== undefined, 'shelter: owns shelterSite now')
}

// ---- 4. DEBUG SINK FORWARDING --------------------------------------------------------------
// provision.setDebugSink must reach every split module, or their dbg() output vanishes from
// logs/bot-events.log - an observability regression that nothing else would notice.
{
  const seen = []
  provision.setDebugSink(line => seen.push(line))
  for (const [name, mod] of [['world-memory', worldMemory], ['core', provCore], ['hut', provHut],
    ['farm', provFarm], ['mining', provMining], ['bank', provBank], ['food', provFood]]) {
    ok(typeof mod.setDebugSink === 'function', 'sink: ' + name + ' exposes setDebugSink')
  }
  // world-memory logs on a suppressed wedge - use it as a live end-to-end check of forwarding
  provision.setBuildZone({ x1: 7000, z1: 7000, x2: 7020, z2: 7020 })
  worldMemory.recordWedge({ x: 7010, y: 64, z: 7010 })
  provision.setBuildZone(null)
  ok(seen.some(l => /wedge/.test(l)), 'sink: a world-memory dbg line reached the sink provision.js was given')
  provision.setDebugSink(null)
}

// ---- 5. THE MOVED REGISTRIES STILL ROUND-TRIP ----------------------------------------------
{
  worldMemory.rememberInfra('chest', { x: 8000, y: 64, z: 8000 }, {})
  eq(worldMemory.listInfra('chest').filter(e => e.x === 8000).length, 1, 'infra: remembered a chest')
  ok(!!worldMemory.recallInfra('chest', { x: 8002, y: 64, z: 8002 }, 8), 'infra: recall finds it nearby')
  ok(!worldMemory.recallInfra('chest', { x: 9999, y: 64, z: 9999 }, 8), 'infra: recall misses when far')

  worldMemory.rememberBed({ x: 8100, y: 64, z: 8100 })
  const bed = worldMemory.knownBed()
  eq(bed && bed.x, 8100, 'bed: remembered')
  eq(worldMemory.bedHeld({ x: 8100, y: 64, z: 8100 }, 1000), false, 'bed: not held by default')
  worldMemory.markBedUnusable({ x: 8100, y: 64, z: 8100 }, 60000, 'test', 1000)
  eq(worldMemory.bedHeld({ x: 8100, y: 64, z: 8100 }, 2000), true, 'bed: unusable-hold applies')
  eq(worldMemory.bedHeld({ x: 8100, y: 64, z: 8100 }, 999999), false, 'bed: hold expires')

  eq(worldMemory.gearupState().fails, 0, 'gearup: starts at zero fails')
  worldMemory.gearupResult(false, {})
  eq(worldMemory.gearupState().fails, 1, 'gearup: a failure increments')
  worldMemory.gearupResult(true, {})
  eq(worldMemory.gearupState().fails, 0, 'gearup: progress resets')
}

// ---- 6. CORE PRIMITIVES --------------------------------------------------------------------
{
  const bot = { inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }, { name: 'stone_axe', count: 1 }, { name: 'dirt', count: 5 }] } }
  eq(JSON.stringify(provCore.inventoryCounts(bot)), JSON.stringify({ iron_pickaxe: 1, stone_axe: 1, dirt: 5 }), 'core: inventoryCounts tallies')
  eq(provCore.countItem(bot, 'dirt'), 5, 'core: countItem')
  eq(provCore.countItem(bot, 'gold_ingot'), 0, 'core: countItem missing -> 0')
  eq(provCore.toolForBlock(bot, 'stone').name, 'iron_pickaxe', 'core: pickaxe for stone')
  eq(provCore.toolForBlock(bot, 'oak_log').name, 'stone_axe', 'core: axe for logs')
  eq(provCore.toolForBlock(bot, 'white_wool'), null, 'core: no tool kind -> null')
  eq(provCore.isNight({ time: { timeOfDay: 15000 } }), true, 'core: isNight at 15000')
  eq(provCore.isNight({ time: { timeOfDay: 1000 } }), false, 'core: day at 1000')
  eq(provCore.AIRISH('cave_air'), true, 'core: AIRISH cave_air')
  eq(provCore.AIRISH('stone'), false, 'core: AIRISH rejects stone')
  eq(provCore.canBreakNaturally({ name: 'stone' }), true, 'core: stone is natural terrain')
  eq(provCore.canBreakNaturally({ name: 'oak_planks' }), false, 'core: planks are a STRUCTURE, never dug')
  eq(provCore.canBreakNaturally(null), false, 'core: null block is not breakable')
}

// ---- 7. LEAF MODULES EXPOSE WHAT THE FACADE PROMISES ----------------------------------------
{
  for (const [label, mod, names] of [
    ['hut', provHut, ['hutAnchor', 'ownHutAt', 'insideOwnStructure', 'maintainHome', 'repairHutStructure']],
    ['farm', provFarm, ['ensureWheatFarm', 'tendWheatFarm', 'hasStandingFarm', 'saplingFor']],
    ['mining', provMining, ['branchMine', 'digStaircaseDown', 'climbToSurface', 'ensureMiningKit']],
    ['bank', provBank, ['ensureChest', 'depositMaterials', 'withdrawItem', 'consolidateBank']],
    ['food', provFood, ['secureFood', 'fishForFood', 'hasFood', 'eatBestFood']]
  ]) {
    for (const n of names) ok(typeof mod[n] === 'function', label + ': exports ' + n)
  }
  eq(provFarm.saplingFor('oak_log'), 'oak_sapling', 'farm: saplingFor maps log -> sapling')
  eq(provFarm.inAvoidBox({ x1: 0, z1: 0, x2: 10, z2: 10 }, 5, 5), true, 'farm: inAvoidBox inside')
  eq(provFarm.inAvoidBox({ x1: 0, z1: 0, x2: 10, z2: 10 }, 50, 50), false, 'farm: inAvoidBox outside')
  eq(provFarm.inAvoidBox(null, 5, 5), false, 'farm: inAvoidBox with no box')
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
