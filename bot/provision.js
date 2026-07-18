'use strict'
// Provisioning: turn a bill of materials into a gather/craft/smelt plan and
// execute it - the "self-sufficient builder" half of schematic building.
// The bot ACQUIRES everything like a real survival player: chop trees, mine
// natural blocks, craft chains (logs→planks→stairs), smelt (sand→glass).
// No /give, no creative - see NOTES §10 + the natural-player goal.
//
// planProvision() is pure (mcData + counts in, task list out) and offline-
// testable. run*() helpers execute against a live bot.

const fs = require('fs')
const path = require('path')
const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const navigate = require('./navigate.js') // unified navigation (it lazy-requires us back for climb/pillar/water-hop)
const scaffold = require('./scaffold.js') // scaffold manager: temp-block registry, filler policy, teardown
const hutModel = require('./hut-model.js') // self-structure model: schema-correct wall/door/floor/interior/furniture classification
const mining = require('./mining.js') // pure mining strategy: depth model, descent-safety, branch-mine geometry
// (shelterSite moved to provision-shelter.js)
const foodSec = require('./food.js') // pure food-security decisions: when to proactively build a fishing supply
const farm = require('./farm.js') // pure wheat-farm geometry (flood-safe bank pick) + crop-state (VERIFIED wheat, never faith)
const arbiter = require('./arbiter.js') // JOB-LEVEL arbitration: survive > progress authority (jobSurvivalNeed/jobMayProgress)
const scheduler = require('./scheduler.js') // PURE survival-tier decision core; top-level-safe (scheduler requires only arbiter - no cycle back to provision). Used by schedulerState to classify the active job.
const routeMem = require('./route-mem.js') // PURE route/wedge geometry: replay proven treks + soft-steer around learned wedges (semantic-world-map slice 1)
const worldMemory = require('./world-memory.js') // the semantic map + world-memory.json persistence (split out of this file)
const provCore = require('./provision-core.js') // shared low-level primitives (inventory, tool pick, goto-with-deadline, collect, place)
const provHut = require('./provision-hut.js') // the bot's own hut: ownership tests, repair, furnish, the maintainHome chain
const provFarm = require('./provision-farm.js') // wheat plot + orchard: site, level, till, seed, torch, harvest, replant
const provMining = require('./provision-mining.js') // shafts, staircases, the branch mine, pick self-sufficiency, vertical escape
const provBank = require('./provision-bank.js') // the chests: place, orient, deposit, withdraw, consolidate, litter patrol
const provFood = require('./provision-food.js') // eat, cook, bake, fish, hunt, and the escalating secureFood chain
const provShelter = require('./provision-shelter.js') // night shelter, dig-in, water safety, the is-it-safe-out-here reads
const provRecovery = require('./provision-recovery.js') // R0-R5 degraded ladder, hp/rest/sleep, spawn repair, deadlock reset
const provMaintain = require('./provision-maintain.js') // the chores: courier, safekeep, spare kit, junk, scaffold sweep
const survivalSnapshot = require('./survival-snapshot.js') // the plain-data view the PURE scheduler/arbiter consume
const { survivalState, survivalNeed, mayDoProgress, activeJobInfo, schedulerState } = survivalSnapshot
const { JUNK_RE, _maintaining, _maintStop, _maintState, isMaintaining, stopMaintenance, _setMaintaining, cleanupScaffold, dumpJunk, safekeepSweep, spareKitToBank, maintenancePass } = provMaintain
const { DEADLOCK_HP, DEADLOCK_MAX_NOFOOD, DEADLOCK_FAILS, DEADLOCK_RESET_COOLDOWN_MS, DEADLOCK_FALL_H, SUICIDE_EXIT_OPEN_SKY, SUICIDE_FALLBACK_DEATH, SUICIDE_DROWN, _deadlockFails, _deadlockResetting, _noteDeadlockProgress, noteDeadlockReset, deadlockResetDue, deadlockResetState, sampleColumnForSky, reachOpenSky, deadlockDieByFall, suicideByDrown, suicideByPitDrop, deadlockFallbackDeath, deadlockSuicideReset, _recoveringHp, recoverHp, isRecoveringHp, _resting, restUntilSafe, isResting, sleepInBedHere, nightRest, nightRestInner, boundedHold, ensureSpawnBed, recoverSpawnAnchor, homeRecoveryDecision, recoverHome, RUNG_EXECUTORS, recoveryReadyNow, _recoveringDegraded, recoverFromDegraded, isRecoveringDegraded } = provRecovery
const { DEFEND_WHEN_HIT_ON, NIGHT_FROZEN_MS, NIGHT_OVERLONG_MS, _nightStart, _todSeen, lastFlood, _sheltering, isSheltering, shelterSite, SHELTER_FARM_R, shelterFarmConflict, inWaterNow, ensureAshore, nearRecentFlood, findDiggableDryCell, scoutForWater, armorPieceCount, underArmored, lowHpCalm, shelterNeeded, nightStuck, nightRestWanted, sealShaft, digTorchAlcove, digInForNight, pickOpenSkyCell } = provShelter
const { _foodFloorState, RAW_COOKABLE, FOOD_ANIMALS, LEATHER_ANIMALS, RISKY_EAT, ROD_SPIDERS, DFOOD_DEEP, DFOOD_FAR, hasFood, foodCount, needsFood, nearestFoodAnimal, eatFromPackToComfortable, eatBestFood, eatUp, bakeBreadFromWheat, cookRawMeat, fishingEnabled, ensureFishingRod, fishForFood, huntForFood, huntSpiderForString, gatherLeather, ensureFoodSupply, needFoodSupply, bankFoodFirst, courierFoodToBank, foodPlanNow, topUpFoodForPlan, isSecuringFood, escalateFoodFloor, secureFood, secureFoodInner, scoutForFood, scoutHunt } = provFood
const { FACING_OFF, resolveBankCell, isBankStand, bankStandFor, gotoChest, placeStationInInterior, ensureChest, placeChestOriented, healBankDouble, chestCounts, depositMaterials, withdrawItem, migrateChestInto, consolidateBank, ownInfraCells, lonelyFurnace, consolidateFurnaces, litterPatrol } = provBank
const { digShaftDown, digStaircaseUp, climbMovements, climbToSurface, pillarUpTo, mineTunnel, placeTorch, ensureTorches, miningPicks, bestPick, workingPickCount, workingMiningPick, carriedPickUsesLeft, craftOneFromInv, craftStonePickHere, ensureMiningKit, digStaircaseDown, enterExistingMine, branchMine, grabNearbyOre, mineDanger } = provMining
const { PLANTABLE_GROUND, WHEAT_FARM_TARGET, farmFootprintHas, cropExclusionStep, cropPlaceExclusion, inAvoidBox, boneMealBlock, tillCell, withdrawSeedsFromBank, gatherSeedsNear, placeFarmTorches, levelPlotCell, ensureWheatFarm, replantCropCell, tendWheatFarm, hasStandingFarm, saplingFor, saplingCount, plantSaplingNear, boneMealSapling, fishSaplings, prepOrchardCell, plantGrove } = provFarm
const { ownHutAt, onHutApron, insideOwnStructure, hasSolidCeiling, stepOffApron, ensureHutApron, healHomeCrater, ensureHutBed, hutAnchor, hutReader, freeInteriorCell, reconcileInfra, cleanupHutInterior, stationInHut, stationSlot, loadHutSchem, repairHutStructure, maintainHut, maintainHome, recallAndReach, findHutDoorway, hutFreeCells, furnitureInHut, furnishHut, insideHutBox } = provHut
const { AIRISH, REPLACEABLE, SHELTER_HOSTILE, STRUCTURE_RE, DIGGABLE_NATURAL, canBreakNaturally,
  inventoryCounts, countItem, isNight, nearHostile,
  toolForBlock, gotoWithTimeout, collectDrops, stepInto, placeAt } = provCore
const { loadWorldMem, saveWorldMem, ownInfraAnchors, rememberRoute, recallRoute, planTrekRoute, dementRoute,
  recordWedge, listWedges, rememberSpot, forgetSpot, recallSpot,
  rememberInfra, recallInfra, forgetInfra, listInfra, recallInfraVerified, WORLD_MEM_FILE,
  loadMines, rememberMine, recallMine, forgetMine, updateMineProgress,
  markSearched, isSearchedDry, clearSearched, gearupState, gearupResult,
  gearupShouldArmBackoff, proactiveGearupGate,
  rememberBed, knownBed, forgetBed, markBedUnusable, bedHeld, setSpawnSuspect, isSpawnSuspect } = worldMemory
const pocketEscape = require('./pocket-escape.js') // PURE pocket-breach geometry: plan a bounded dig out of a flooded, roofed pocket (water-wedge escape)
const navProfile = require('./nav-profile.js') // PURE nav-terrain policy: wild-profile type whitelist, scope gate, per-position break exclusion (NAV Phase 1)
const navLeg = require('./nav-leg.js') // PURE leg-planning core (NAV Phase B): Y-banded surface-trek leg goal (isEnd/heuristic) so A* can't ride a leg 45b down a cave to lava
const GoalNearXZBanded = navLeg.makeGoalNearXZBanded(goals.Goal) // Y-aware drop-in for goals.GoalNearXZ (NAV_HAZARD_LEGS)
const NAV_HAZARD_LEGS = process.env.NAV_HAZARD_LEGS !== '0' // NAV Phase B (default ON): Y-band the trek leg goal + price lava in the trek Movements profile; =0 => today's Y-blind GoalNearXZ + no lava cost, byte-for-byte
const WATER_SAFE = process.env.WATER_SAFE !== '0' // task #45 (default ON): price OVER-THE-HEAD water in the trek Movements profile so legs route around a pond aquifer (shallow water stays free -> farm/fishing reachable); =0 => no water cost, byte-for-byte
const WATER_ESCAPE = process.env.WATER_ESCAPE === '1' // task #48 (DEFAULT OFF): water-stuck livelock fix. ON => walkStaged stops re-aiming a leg back into the pond while a water-escape maneuver owns the body (the recovery `water` rung / drown reflex is swimming the bot OUT); =1 also arms escapeToDryLand in navigate. =0 => byte-for-byte today.
// ---- NAV Phase C flags (DESIGN-nav-overhaul.md §3 Phase C = DESIGN-navigation-redesign §5 P2-4) ----
const NAV_LEG_PROBE = process.env.NAV_LEG_PROBE !== '0' // Phase C / §5-P2 (default ON): pre-flight getPathTo probe of a bearing leg; noPath => rotate through ±60/±120 and take the first reachable (SOFT). =0 => no probe, today byte-for-byte
const NAV_WAYPOINT_GRAPH = process.env.NAV_WAYPOINT_GRAPH !== '0' // Phase C / §5-P3 (default ON): compose proven route segments over a waypoint graph before falling back to whole-route replay / bearing. =0 => graph unused, today byte-for-byte
// Phase C / §5-P4 NAV_LADDER_DIET: DEFAULT OFF (unset/!=='1'). The design gates the measured
// retirement of the now-superseded rotate-detour + wedge soft-steer on a >=1 WEEK live soak +
// log fire-rate analysis (§5 Phase 4) - so this ships as a reversible gate the operator flips ON
// only after that soak; unset => today byte-for-byte (both paths run, harmlessly, alongside the
// probe/graph that supersede them). NEVER zeroes a survival recovery-rung budget.
const NAV_LADDER_DIET = process.env.NAV_LADDER_DIET === '1'
const PROBE_MS = Math.max(200, parseInt(process.env.NAV_PROBE_MS || '1000', 10)) // bounded getPathTo budget per candidate (success/noPath resolve fast; only a far `timeout` costs the full budget)
// Visible, UNTHROTTLED build tracing to stdout (the say() progress goes through a 40s
// throttle that hides failures). Enable with BUILD_DEBUG=1 to see every plan/task/smelt step.
let dbgSink = null // injected by index.js: debug lines persist to logs/bot-events.log
function setDebugSink (fn) { dbgSink = fn; worldMemory.setDebugSink(fn); provCore.setDebugSink(fn); provHut.setDebugSink(fn); provFarm.setDebugSink(fn); provMining.setDebugSink(fn); provBank.setDebugSink(fn); provFood.setDebugSink(fn); provShelter.setDebugSink(fn); provRecovery.setDebugSink(fn); provMaintain.setDebugSink(fn) } // forward: world-memory + core log through the same sink
// fix #15 Piece C (flag DEFEND_WHEN_HIT, default ON, read once at module load - mirrors index.js):
// a sealed shelter that is nonetheless TAKING DAMAGE (breached/leaky seal, mob fell in before the
// cap) must bail out to fight/flee instead of holding _sheltering for up to 600s while hits land.
// =0 reverts both pit waits to their old `!fullySealed`/`!recapped`-only damage bails.
// (DEFEND_WHEN_HIT_ON moved to provision-shelter.js)
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

// S7 (DESIGN-S7-watchdog): the verified-progress heartbeat hook + the survival-job fail-job latch.
// touchP is the cycle-safe lazy hook (commands requires provision, so a top-level require would
// cycle - the established pattern). _survStop mirrors _maintStop/stopMaintenance: the watchdog's
// fail-job lever for the latch jobs (secureFood/recoverHp/recoverFromDegraded), set by
// stopSurvivalJob, cleared at each survival-job entry, folded into their isStopped chains.
const touchP = tag => { try { require('./commands.js').touchProgress(tag) } catch {} }
let _survStop = false
function stopSurvivalJob () { _survStop = true } // the running survival job unwinds at its next isStopped poll

// Movement profile for GATHERING: like a real player it may punch through
// LEAVES to reach a trunk - and nothing else. The pathfinder only has a global
// canDig + a denylist, so we enable digging and deny every non-leaf block.
// Anti-grief holds: it can never break through builds or terrain.
function gatherMovements (bot) {
  const m = new Movements(bot)
  const md = require('minecraft-data')(bot.version)
  // May PILLAR back up out of a dip/ledge so mining can never strand the bot below
  // ground (verified: chasing exposed stone into a ravine left it trapped at y48,
  // unable to climb to the surface for the next gather step). Scaffolds only with
  // cheap blocks it's likely to be holding while mining (dirt/cobble/stone family).
  m.allow1by1towers = true
  const SCAFFOLD = ['dirt', 'grass_block', 'cobblestone', 'cobbled_deepslate', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'stone']
  if ('scafoldingBlocks' in m) m.scafoldingBlocks = SCAFFOLD.map(n => md.itemsByName[n] && md.itemsByName[n].id).filter(x => x != null)
  m.canOpenDoors = true
  m.allowParkour = false // WALK between resources instead of sprint-hopping every gap - the
  // gather roams a lot and parkour made it jump constantly in the open (user report). It can
  // still climb ledges (auto-step) and pillar out of dips; it just won't leap around.
  m.maxDropDown = 8 // hop down ledges like a player would (plateau spawns; verified live: default 4 = "No path" to a tree below a cliff)
  m.canDig = true
  m.digCost = 10 // strongly prefer walking around over chewing through a canopy
  m.liquidCost = 4 // route AROUND lakes: water was priced like land, so A* happily swam
  // (slow, drowning risk, and the brain panics "get out of water" the whole time)
  m.blocksCantBreak = new Set(
    Object.values(md.blocksByName).filter(b => !/_leaves$/.test(b.name)).map(b => b.id)
  )
  try { const ex = cropExclusionStep(bot); if (ex && Array.isArray(m.exclusionAreasStep)) m.exclusionAreasStep.push(ex) } catch {} // FARM_NO_TRAMPLE: route AROUND our crop cells (cost-only)
  try { const px = cropPlaceExclusion(bot); if (px && Array.isArray(m.exclusionAreasPlace)) m.exclusionAreasPlace.push(px) } catch {} // NO_PLACE_ON_FARM (fix #17): never bridge/place on our own farmland
  return m
}

// ANTI-TRAMPLING (FARM_NO_TRAMPLE, §5.5): a SOFT additive per-block cost on our OWN persisted
// wheat cells (+ the farmland under them + the hop-over cell) so travel/gather/climb routes bend
// AROUND the plot instead of jumping across it (a jump-landing is what reverts farmland). It is
// COST ONLY - never a wall, never a dig; position-keyed to our exact cells so reverted (dirt)
// cells stay protected and FOREIGN village farmland is never avoided. Returns fn(block)->0|COST,
// or null (flag off / no farm). Built ONCE per movements construction (A*-hot path).
// (cropExclusionStep moved to provision-farm.js)

// NAV Phase B (NAV_HAZARD_LEGS): the lava-hazard STEP exclusion closure for a trek Movements
// profile. Wraps the PURE navProfile.hazardExclusion with a live-world block-name sampler so A*
// pays HAZARD_STEP_COST to step onto a lava / lava-adjacent (pool-edge) cell and routes around
// it. Shared by wildTerrainMovements (here) and commands.travelMovements (exported). Cost-only,
// never a forbid; bounded to a handful of blockAt reads per candidate cell.
function hazardStepExclusion (bot) {
  const sample = (x, y, z) => { try { const b = bot.blockAt(new Vec3(x, y, z)); return b && b.name } catch { return null } }
  return (block) => { const p = block && block.position; return p ? navProfile.hazardExclusion(p, sample) : 0 }
}

// WATER_SAFE (task #45): the DEEP-water STEP exclusion closure - sibling of hazardStepExclusion,
// wrapping the PURE navProfile.deepWaterHazard with the same live block-name sampler. A* pays
// WATER_STEP_COST to step into OVER-THE-HEAD water so trek legs route AROUND a pond aquifer when a
// dry route exists (the walk-in that drowned the bot twice), but SHALLOW water stays free (cost 0)
// so the river-farm / fishing spots remain reachable at liquidCost. Cost-only, never a forbid.
// Shared by wildTerrainMovements (here) and commands.travelMovements (exported).
function waterStepExclusion (bot) {
  const sample = (x, y, z) => { try { const b = bot.blockAt(new Vec3(x, y, z)); return b && b.name } catch { return null } }
  return (block) => { const p = block && block.position; return p ? navProfile.deepWaterHazard(p, sample) : 0 }
}

// WATER_SAFE (task #45): is the bot RIGHT NOW standing in over-the-head DEEP water? The bot-facing
// wrapper the AUTO_SURFACE reflex uses for its `deep` flag - runs the same PURE deepWaterHazard on
// the bot's own feet cell (block-based, NOT bot.oxygenLevel which is unreliable on live).
function deepWaterUnderfoot (bot) {
  try {
    if (!bot.entity) return false
    const f = bot.entity.position.floored()
    const sample = (x, y, z) => { try { const b = bot.blockAt(new Vec3(x, y, z)); return b && b.name } catch { return null } }
    return navProfile.deepWaterHazard({ x: f.x, y: f.y, z: f.z }, sample) > 0
  } catch { return false }
}

// NO_PLACE_ON_FARM (fix #17): a per-block PLACEMENT exclusion (fed to Movements.exclusionAreasPlace)
// that FORBIDS the pathfinder from bridging/scaffolding a block onto our OWN farmland or the crop
// cell just above it - placing cobble there destroys the farmland/crop and floods it (#28/#31).
// cropExclusionStep already makes those cells high-COST to STEP on; this makes PLACEMENT on them
// effectively forbidden (a huge additive cost - the exact idiom the break exclusion uses). Same
// column set + y-window (cy-1..cy+1) as cropExclusionStep; only our own wheatFarm, never foreign
// village farmland. Returns fn(block)->0|COST, or null (flag off / no farm).
// (cropPlaceExclusion moved to provision-farm.js)

// #56 FARM_EXCLUDE_YFIX (defense-in-depth): does the wheat-farm footprint (any crop cell, its
// farmland, or the block just above one - the ±1 y-window at each cell's OWN level) contain `pos`?
// Movement-flag-INDEPENDENT (unlike cropPlaceExclusion which the pathfinder owns) so MANUAL placers
// (scaffold.js / pillarUpTo) can refuse to brick over the farm. Returns false on any error / no
// farm / FARM_EXCLUDE_YFIX=0 (byte-equivalent to no check).
// (farmFootprintHas moved to provision-farm.js)

// WILD-TERRAIN travel profile (NAV Phase 1, DESIGN-navP1-terrain-profile §4.2b). Like a
// survival player, this profile may DIG through wild terrain (and its OWN registry-proven
// scaffold cobble) to route past a sealed dip / pocket / pit-rim - but NEVER a player build
// or its own permanent fabric. Six independent anti-grief layers hold (§6):
//  1. TYPE whitelist = canBreakNaturally's exact compound (DIGGABLE_NATURAL && !STRUCTURE_RE)
//     + _leaves$ + cobble/cobbled_deepslate; everything else sits in blocksCantBreak.
//  2. POSITIONAL gate (exclusionAreasBreak): forbid (100) ANY break - dirt included - within
//     16b XZ of own infra or the active buildZone+16 (enforced INSIDE the library safeToBreak).
//  4. COST gate: digCost 20 - A* digs only when the walk-around is massively worse.
//  5. cobble is breakable ONLY on an exact scaffold.isScaffold(pos) registry hit.
// Layer 3 (scope) lives in trekMovements; layer 6 (execution) is pathfix + canDigBlock, pre-
// existing. Built in gatherMovements' style; reuses S6 cropExclusionStep + NAV-P0 liquidCost.
function wildTerrainMovements (bot) {
  const m = new Movements(bot)
  const md = require('minecraft-data')(bot.version)
  m.canDig = true
  m.digCost = navProfile.WILD_DIG_COST // 20: dig only when the walk-around is massively worse
  m.liquidCost = navProfile.WILD_LIQUID_COST // 4: route AROUND water, don't swim (NAV-P0 parity)
  m.allow1by1towers = true
  m.canOpenDoors = true
  m.allowParkour = true
  m.maxDropDown = 4 // don't plunge into caves/ravines chasing the target's XZ (travelMovements parity)
  if ('infiniteLiquidDropdownDistance' in m) m.infiniteLiquidDropdownDistance = false
  if ('allowSprinting' in m) m.allowSprinting = true
  // Bridge gaps/ravines with cheap carried blocks (travelMovements' bridge families).
  try {
    const bridge = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'gravel', 'dirt_path', 'andesite', 'granite', 'diorite']
    const ids = bridge.map(n => md.itemsByName[n] && md.itemsByName[n].id).filter(x => x != null)
    if ('scafoldingBlocks' in m) m.scafoldingBlocks = ids
  } catch { /* mcData not ready */ }
  // LAYER 1: the type whitelist inverted into the library's denylist (built exactly like
  // gatherMovements at provision.js:68-70). Any block whose NAME fails canWildBreakType is
  // un-breakable regardless of position - planks/logs/torches/chests/beds/glass/bricks/... .
  m.blocksCantBreak = new Set(
    Object.values(md.blocksByName)
      .filter(b => !navProfile.canWildBreakType(b.name, DIGGABLE_NATURAL, STRUCTURE_RE))
      .map(b => b.id)
  )
  // LAYER 2 + 5: the positional break exclusion. PUSH (never assign - the array is
  // library-initialized, movements.js:104). Anchors snapshotted once at construction (the
  // selector rebuilds the profile per goto attempt, so staleness is bounded to one attempt).
  const anchors = ownInfraAnchors()
  const zone = buildZone
  m.exclusionAreasBreak.push(block => {
    try { return navProfile.breakExclusion(anchors, zone, block && block.name, block && block.position, p => scaffold.isScaffold(p)) } catch { return 100 }
  })
  // S6 FARM_NO_TRAMPLE parity (provision.js:71 pattern) - route AROUND our crop cells (cost-only).
  try { const ex = cropExclusionStep(bot); if (ex && Array.isArray(m.exclusionAreasStep)) m.exclusionAreasStep.push(ex) } catch {}
  // NAV Phase B: price lava (+lava-adjacent pool edges) so A* routes AROUND it (cost-only, never
  // a forbid). Additive to exclusionAreasStep; flag-gated so =0 is byte-for-byte today.
  try { if (NAV_HAZARD_LEGS && Array.isArray(m.exclusionAreasStep)) m.exclusionAreasStep.push(hazardStepExclusion(bot)) } catch {}
  // WATER_SAFE (task #45): price DEEP (over-the-head) water so a trek routes AROUND a pond aquifer;
  // shallow/1-deep water stays free (liquidCost) so the river-farm/fishing spots stay reachable.
  try { if (WATER_SAFE && Array.isArray(m.exclusionAreasStep)) m.exclusionAreasStep.push(waterStepExclusion(bot)) } catch {}
  try { const px = cropPlaceExclusion(bot); if (px && Array.isArray(m.exclusionAreasPlace)) m.exclusionAreasPlace.push(px) } catch {} // NO_PLACE_ON_FARM (fix #17): never bridge/place on our own farmland
  return m
}

// The SELECTOR (DESIGN §4.2c): returns the wild dig-capable profile ONLY when the flag is on
// AND the bot stands outside the 32b home/build scope (layer 3); otherwise TODAY's no-dig
// profile via safeThunk(). DEFAULT OFF: with NAV_TERRAIN_PROFILE unset/!=='1' this ALWAYS
// returns safeThunk() and the wild profile/exclusion/registry hooks never construct. Whole
// body try/catch -> safeThunk (a policy error degrades to today's no-dig, never a throw
// mid-leg). navigateToInner re-runs this thunk before EVERY attempt (navigate.js navigateToInner), so the
// profile demotes to safe automatically as a leg carries the bot inside the 32b home radius.
function trekMovements (bot, safeThunk) {
  try {
    if (process.env.NAV_TERRAIN_PROFILE !== '1') return safeThunk()
    const pos = bot.entity && bot.entity.position
    if (!pos) return safeThunk()
    if (!navProfile.wildAllowedAt(ownInfraAnchors(), buildZone, pos)) return safeThunk()
    return wildTerrainMovements(bot)
  } catch { return safeThunk() }
}

// MANUAL water escape: face the nearest bank cell (solid ground with headroom, up to +1
// higher) and hold jump+sprint+forward until we're standing on it. Bypasses the
// pathfinder entirely - in water it never registers "on ground", so its planned jumps
// never fire and it bobs in a puddle forever (library flaw, watched live for 8 minutes).
async function manualHopFromWater (bot) {
  const feet = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    for (const dy of [0, 1]) {
      const bank = bot.blockAt(feet.offset(dx, dy - 1, dz))   // the block we'd stand ON
      const space1 = bot.blockAt(feet.offset(dx, dy, dz))     // body space
      const space2 = bot.blockAt(feet.offset(dx, dy + 1, dz)) // head space
      if (!bank || bank.boundingBox !== 'block' || /water|lava/.test(bank.name)) continue
      if (!space1 || (!AIRISH(space1.name) && !/water/.test(space1.name))) continue
      if (!space2 || !AIRISH(space2.name)) continue
      try {
        bot.pathfinder.setGoal(null)
        await bot.lookAt(bank.position.offset(0.5, 1.2, 0.5), true)
        bot.setControlState('jump', true); bot.setControlState('forward', true); bot.setControlState('sprint', true)
        const t0 = Date.now()
        while (Date.now() - t0 < 2500) {
          await new Promise(r => setTimeout(r, 100))
          const f = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
          if (f && f.boundingBox === 'block' && !/water/.test(f.name) && bot.entity.onGround) { bot.clearControlStates(); dbg('  hopped out of the water onto ' + f.name); return true }
        }
      } finally { bot.clearControlStates() }
    }
  }
  dbg('  manual water hop found no bank - still wet')
  return false
}

// BREACH a flooded pocket (water-wedge escape): boxed in a 1-block water pocket under a
// solid ceiling (a waterlogged tree), the swim/hop rungs have already failed and there is
// no "dig sideways one block and walk out" rung. Plan a BOUNDED dig to the nearest air/bank
// (horizontal-first, vertical overhead fallback - geometry from the pure pocket-escape
// module) and execute it dig-only. Sibling of manualHopFromWater; driven by navigate's
// `wetbreach` recovery rung. ANTI-GRIEF is the SAME test the wood gather uses: natural
// terrain/ore (canBreakNaturally) OR natural leaves OR wild-tree logs away from own infra,
// honouring canDigBlock per block and RE-READING every cell at dig time. Never places a
// block (no scaffold litter in the water); never re-opens water (fluid/unknown cells reject
// the plan). Returns an honest moved/dry bool.
// THE shared escape-dig whitelist for BOTH wedge-breach rungs (wetbreach + drybreach),
// factored into ONE helper so the two executors' anti-grief predicates can NEVER drift.
// Extends dig permission - FOR THESE RUNGS ONLY - to natural terrain/ore (canBreakNaturally),
// natural leaves, own registry-proven scaffold (scaffoldDigOK), and wild-tree logs away from
// own infra: the operator-approved widened escape whitelist, and NOTHING else. Player builds
// and the bot's own hut/farm/fence/planks/doors/foreign cobble (all STRUCTURE_RE) are rejected.
// Re-reads the live block each call and honours canDigBlock. `feet` = the bot's feet cell;
// `anchors` = ownInfraAnchors() (for the wild-log suppression check).
function escapeDiggable (bot, feet, anchors) {
  return (name, dx, dy, dz) => {
    const pos = feet.offset(dx, dy, dz)
    const block = bot.blockAt(pos)
    if (!block || block.name !== name) return false
    let ok = canBreakNaturally(block) || /_leaves$/.test(name) || scaffoldDigOK(block)
    if (!ok && /_log$/.test(name)) {
      ok = isWildTreeLog(bot, pos) && !routeMem.suppressedNearAnchors(anchors, pos)
    }
    if (!ok) return false
    if (bot.canDigBlock && !bot.canDigBlock(block)) return false
    return true
  }
}

async function breachWaterPocket (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const wide = !!opts.wide
  const navigate = require('./navigate.js')
  // GUARDS (order matters): never dig indoors; must actually be in water; hand a drowning
  // bot back to escapeWater / the drown reflex instead of digging while it suffocates.
  if (insideOwnStructure(bot)) { dbg('  breach: inside my own structure - not digging'); return false }
  const feet = bot.entity.position.floored()
  const feetBlock = bot.blockAt(feet)
  if (!feetBlock || !/water/.test(feetBlock.name)) { dbg('  breach: not standing in water - skipping'); return false }
  if ((bot.oxygenLevel ?? 20) < 6) { dbg('  breach: low oxygen - handing back to the drown reflex'); return false }
  // THE anti-grief whitelist, passed to the pure planner. Extends dig permission to natural
  // tree blocks FOR THIS RUNG ONLY - the exact permission the wood gather already exercises.
  const anchors = ownInfraAnchors()
  const diggable = escapeDiggable(bot, feet, anchors)
  const read = (dx, dy, dz) => { const b = bot.blockAt(feet.offset(dx, dy, dz)); return b ? b.name : null }
  const plan = pocketEscape.planPocketBreach(read, diggable, wide ? { march: 4, maxDigs: 8 } : { march: 3, maxDigs: 6 })
  if (!plan) { dbg('  breach: no bounded escape plan from ' + feet + (wide ? ' (wide)' : '') + ' - honestly stuck'); return false }
  dbg('  breach: ' + plan.kind + ' plan, ' + plan.digs.length + ' dig(s) toward ' + plan.exit.dx + ',' + plan.exit.dy + ',' + plan.exit.dz)
  if (opts.say) opts.say('boxed in a flooded hole - digging myself out')
  // EXECUTE - dig-only, bounded ~25s, RE-READ every block (world may have changed since
  // planning; a cell that turned to fluid or no longer passes the whitelist aborts the whole
  // attempt), oxygen re-checked between digs.
  const t0 = Date.now()
  for (const d of plan.digs) {
    if (isStopped()) { dbg('  breach: stopped mid-dig'); return false }
    if (Date.now() - t0 > 25000) { dbg('  breach: 25s cap reached'); break }
    if ((bot.oxygenLevel ?? 20) < 6) { dbg('  breach: oxygen dropped mid-dig - aborting to the drown reflex'); return false }
    const pos = feet.offset(d.dx, d.dy, d.dz)
    const block = bot.blockAt(pos)
    if (!block || AIRISH(block.name)) continue // already open (drop-through / stale plan cell)
    if (/water|lava/.test(block.name)) { dbg('  breach: a dig cell turned to fluid - aborting (never re-open water)'); return false }
    if (!diggable(block.name, d.dx, d.dy, d.dz)) { dbg('  breach: a dig cell no longer passes the whitelist - aborting'); return false }
    const tool = toolForBlock(bot, block.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(block) } catch (e) { dbg('  breach: dig failed (' + e.message + ') - aborting'); return false }
  }
  // WALK OUT: a vertical breach opened the column overhead - rise it; then hop onto the now-
  // adjacent bank (horizontal) or float to shore (still wet).
  const stillWet = () => { const b = bot.blockAt(bot.entity.position.floored()); return !!b && /water/.test(b.name) }
  if (plan.kind === 'vertical') { try { await navigate.jumpForAir(bot, 6000, isStopped) } catch {} }
  let out = false
  try { out = await manualHopFromWater(bot) } catch {}
  if (!out && stillWet()) { try { out = await navigate.swimToShore(bot, isStopped) } catch {} }
  return out || !stillWet()
}

// DRY-WEDGE ESCAPE (DIGOUT_ESCAPE): a near-clone of breachWaterPocket for a bot hard-wedged
// on DRY land - boxed in a surface hole / narrow pocket where feet are NOT in water, so the
// wetbreach rung refuses and every geometry-narrow rung falls through (§2c of the design):
// the bot freezes until it starves. Plan a BOUNDED sideways-and-walk-out dig (horizontal-
// first, vertical ceiling breach fallback - the SAME pure pocket-escape geometry) through the
// SAME escapeDiggable anti-grief whitelist the wetbreach rung uses, and walk out. Driven ONLY
// by navigate's `drybreach` rung, which is armed ONLY by the watchdog's proven hard-wedge
// (opts.digOut). Never places a block except pillarUpTo's own registered filler on the
// vertical fallback. Returns an honest moved bool.
async function breachDryPocket (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const wide = !!opts.wide
  const p0 = bot.entity.position.clone()
  // GUARDS (order matters, invariants §3/§6): never carve the living room; hand a wet pocket
  // back to wetbreach; and NEVER dig while a hostile is within 6b - defense/flee own the body
  // (nearHostile, deliberately NOT mineDanger: low HP alone must NOT block the escape - the
  // live wedge sat at hp 1, which is exactly when it's needed).
  if (insideOwnStructure(bot)) { dbg('  drybreach: inside my own structure - not digging'); return false }
  const feet = bot.entity.position.floored()
  const feetBlock = bot.blockAt(feet)
  if (feetBlock && /water/.test(feetBlock.name)) { dbg('  drybreach: feet in water - handing to wetbreach'); return false }
  if (nearHostile(bot, 6)) { dbg('  drybreach: hostile within 6b - handing back to defense/flee'); return false }
  // THE shared escape whitelist (identical to wetbreach - factored so they can't drift).
  const anchors = ownInfraAnchors()
  const diggable = escapeDiggable(bot, feet, anchors)
  const read = (dx, dy, dz) => { const b = bot.blockAt(feet.offset(dx, dy, dz)); return b ? b.name : null }
  const plan = pocketEscape.planPocketBreach(read, diggable, wide ? { march: 6, maxDigs: 12 } : { march: 4, maxDigs: 8 })
  if (!plan) { dbg('  drybreach: no bounded escape plan from ' + feet + (wide ? ' (wide)' : '') + ' - honestly stuck'); return false }
  // A vertical ceiling breach opens an exit overhead we can only REACH with pillar filler;
  // no filler -> the opened column is useless, so decline (honestly stuck) rather than dig.
  if (plan.kind === 'vertical' && !scaffold.pickFiller(bot)) { dbg('  drybreach: vertical breach needs filler I do not have - honestly stuck'); return false }
  dbg('  drybreach: ' + plan.kind + ' plan, ' + plan.digs.length + ' dig(s) toward ' + plan.exit.dx + ',' + plan.exit.dy + ',' + plan.exit.dz)
  if (opts.say) opts.say('boxed in a dry hole - digging myself out')
  // EXECUTE - dig-only, bounded ~25s, RE-READ every block (world may have changed since
  // planning; a cell that turned to fluid or no longer passes the whitelist aborts the whole
  // attempt), nearHostile re-checked between digs (replaces the water executor's oxygen check).
  const t0 = Date.now()
  for (const d of plan.digs) {
    if (isStopped()) { dbg('  drybreach: stopped mid-dig'); return false }
    if (Date.now() - t0 > 25000) { dbg('  drybreach: 25s cap reached'); break }
    if (nearHostile(bot, 6)) { dbg('  drybreach: hostile closed in mid-dig - aborting to defense/flee'); return false }
    const pos = feet.offset(d.dx, d.dy, d.dz)
    const block = bot.blockAt(pos)
    if (!block || AIRISH(block.name)) continue // already open (drop-through / stale plan cell)
    if (/water|lava/.test(block.name)) { dbg('  drybreach: a dig cell turned to fluid - aborting (never open water/lava)'); return false }
    if (!diggable(block.name, d.dx, d.dy, d.dz)) { dbg('  drybreach: a dig cell no longer passes the whitelist - aborting'); return false }
    const tool = toolForBlock(bot, block.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(block) } catch (e) { dbg('  drybreach: dig failed (' + e.message + ') - aborting'); return false }
  }
  // WALK OUT: horizontal -> hop once (clears the block-clip that keeps onGround:false), face
  // the exit cell and step onto it (exactly the stepout walk pattern). Vertical -> pillarUpTo
  // rises the freshly-opened column (brings its own anti-grief, filler policy + scaffold add).
  if (plan.kind === 'vertical') {
    try { await pillarUpTo(bot, feet.y + plan.exit.dy, { isStopped }) } catch (e) { dbg('  drybreach: pillar-out failed (' + e.message + ')') }
  } else {
    const tx = feet.x + 0.5 + plan.exit.dx
    const tz = feet.z + 0.5 + plan.exit.dz
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    try { bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 260)) } catch {} finally { bot.setControlState('jump', false) }
    await new Promise(r => setTimeout(r, 300)) // land
    try {
      await bot.lookAt(new Vec3(tx, bot.entity.position.y + 1.2, tz), true)
      bot.setControlState('forward', true)
      const tw = Date.now()
      while (Date.now() - tw < 3000 && !isStopped()) {
        await new Promise(r => setTimeout(r, 100))
        if (Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz) < 0.4) break
        if (Date.now() - tw > 600 && bot.entity.position.distanceTo(p0) < 0.3) { // bumped - hop once
          bot.setControlState('jump', true); await new Promise(r => setTimeout(r, 150)); bot.setControlState('jump', false)
        }
      }
    } catch {} finally { bot.clearControlStates() }
  }
  const p1 = bot.entity.position
  return Math.hypot(p1.x - p0.x, p1.z - p0.z) >= 1.0 || Math.floor(p1.y) > Math.floor(p0.y)
}

// Long treks in ~48-block legs. A single 200-block GoalNearXZ makes the pathfinder chew
// an enormous search space in one solve - the operator watched the bot stand motionless
// at a lake for two minutes while it "thought". Short legs solve instantly, follow the
// terrain, and give stall detection something to measure. (commands.js's travelFar is the
// full-featured cousin with door-assist; this is the light provision-side version for
// memory/bed/grove treks that can't import it without a require cycle.)
async function walkStaged (bot, tx, tz, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const budgetMs = opts.timeoutMs || 180000
  const startTime = Date.now()
  const deadline = startTime + budgetMs
  // A mid-trek wedge used to make this loop RE-AIM at the same bearing and re-hammer the
  // identical failing leg up to 3x at ~75s each (~195-225s frozen -> death at night). Now:
  // on a MEASURED <3b stall we (a) rotate the next leg off the blocked bearing to DETOUR
  // around the obstacle, and (b) after the first retry still wedged, escalate ONCE to the
  // aggressive manual escape (navigate.forceUnstick - the same ladder the 150s watchdog
  // uses) so the freeze breaks in tens of seconds, not minutes. The escape logic lives in
  // navigate.js; this loop only picks waypoints and asks for the escape.
  let stalls = 0
  let unstuck = false
  // ROUTE-REUSE + WEDGE-MEMORY (semantic-world-map slice 1): learn/replay treks so the Nth
  // home->timber run doesn't blind-plan into the 1st run's wedge. Waypoint choice ONLY - the
  // recovery ladder / forceUnstick / reflexes below are untouched.
  const startPos = { x: bot.entity.position.x, z: bot.entity.position.z }
  const LAVA_SAFE = process.env.LAVA_SAFE !== '0' // #41 §2a: a surface trek's XZ-blind GoalNearXZ can thread a cave mouth 45b DOWN to lava - climb out before it parks on a pool edge
  const surfaceRef = opts.surfaceY != null ? opts.surfaceY : Math.floor(bot.entity.position.y) // trek's reference surface (gather plumbs surfaceY; else where we set off from)
  const d0 = Math.hypot(tx - startPos.x, tz - startPos.z) // straight-line trek length (for the >=64b record gate)
  const crumbs = [{ x: startPos.x, z: startPos.z }]
  let lastCrumb = crumbs[0]
  const pushCrumb = q => { if (Math.hypot(q.x - lastCrumb.x, q.z - lastCrumb.z) >= 8) { lastCrumb = { x: q.x, z: q.z }; crumbs.push(lastCrumb) } }
  // REPLAY a proven route (if one exists between here and the goal): walk its thinned points
  // as the leg targets instead of a blind bearing. A measured stall mid-replay dements the
  // route and FALLS THROUGH to today's bearing/rotate/forceUnstick from the current position.
  // NAV Phase C leg-target source (priority: graph plan > whole-route replay > bearing+probe).
  // The GRAPH composes segments from >=2 proven routes (a shared corridor recallRoute can't
  // stitch); a single matching route still goes through recallRoute below.
  let graphPlan = planTrekRoute(startPos, { x: tx, z: tz })
  if (graphPlan) dbg('walkStaged: composed a ' + graphPlan.pts.length + '-node graph route to ' + Math.round(tx) + ',' + Math.round(tz))
  let replay = graphPlan ? null : recallRoute(startPos, { x: tx, z: tz })
  if (replay) dbg('walkStaged: replaying a proven ' + replay.pts.length + '-pt route to ' + Math.round(tx) + ',' + Math.round(tz))
  while (!isStopped() && Date.now() < deadline) {
    const p = bot.entity.position
    const d = Math.hypot(tx - p.x, tz - p.z)
    if (d <= (opts.range || 8)) {
      // Arrived: record this trek as a reusable route (long trips only; short hops aren't
      // worth replaying). rememberRoute merges into any existing route (ok++, fresh crumbs).
      if (d0 >= routeMem.ROUTE_MIN_LEN) { pushCrumb({ x: p.x, z: p.z }); rememberRoute(startPos, { x: tx, z: tz }, crumbs) }
      return true
    }
    // TREK ANTI-FIGHT (WATER_ESCAPE, task #48): don't let this trek compose a leg BACK INTO the pond
    // while a water-escape maneuver is swimming the bot OUT - nav (out) and trek (in) otherwise cancel
    // each other every ~15s (design §2c). (a) While an escape actively OWNS the body, yield a beat and
    // re-read instead of composing a concurrent leg - bounded, escapingWater clears when the escape
    // resolves and the trek deadline caps the wait. (b) While the bot is itself feetInWater, DROP any
    // proven graph/replay route for this cycle so it can't re-aim the memorized leg north into the
    // water; fall through to the bearing+probe leg, whose recovery `water` rung runs the goal-biased
    // escapeToDryLand and relocates the body first. Flag OFF => neither branch runs (byte-for-byte).
    if (WATER_ESCAPE) {
      if (navigate.isEscapingWater()) { await new Promise(r => setTimeout(r, 300)); continue }
      if ((graphPlan || replay) && navigate.feetInWater(bot)) { graphPlan = null; replay = null; dbg('walkStaged: feet in water - suppressing proven-route replay this cycle (WATER_ESCAPE anti-fight)') }
    }
    // Self-abandon a stale replay/graph plan that has burned >60% of the trek deadline (worst
    // case = today's blind trek + a short failed prefix).
    if (graphPlan && Date.now() - startTime > 0.6 * budgetMs) { dbg('walkStaged: abandoning graph route - >60% of the deadline burned'); graphPlan = null }
    if (replay && Date.now() - startTime > 0.6 * budgetMs) { dbg('walkStaged: abandoning route replay - >60% of the deadline burned'); replay = null }
    // Leg target: graph node > replay point > blind bearing (stalls 0, wedge soft-steered + probed) > rotate detour.
    const ux = (tx - p.x) / d
    const uz = (tz - p.z) / d
    let lx, lz
    let replayLeg = false
    let graphLeg = false
    if (graphPlan) {
      const cur = routeMem.routeCursor(graphPlan.pts, p)
      const pt = graphPlan.pts[cur]
      lx = pt.x; lz = pt.z; graphLeg = true
    } else if (replay) {
      const cur = routeMem.routeCursor(replay.pts, p)
      const pt = replay.pts[cur]
      lx = pt.x; lz = pt.z; replayLeg = true
    } else if (stalls === 0) {
      const step = Math.min(48, d)
      lx = p.x + ux * step; lz = p.z + uz * step
      // WEDGE SOFT-STEER (bearing mode only; proven routes are NOT wedge-checked): if the
      // straight leg clips a learned, still-active, non-suppressed wedge, try the same
      // rotation angles at a shorter leg and take the first clear one. If none clear, take
      // the DIRECT bearing anyway - SOFT, never a wall (the blind planner still owns it).
      // NAV_LADDER_DIET (Phase C / §5-P4, default OFF): the probe+graph supersede this soft-steer;
      // with the diet enabled it's skipped (retired). Default keeps it (byte-for-byte) pending soak.
      if (!NAV_LADDER_DIET) {
        const wedges = listWedges()
        if (wedges.length && routeMem.wedgeOnSegment(wedges, p, { x: lx, z: lz })) {
          const sstep = Math.min(24, d)
          for (const deg of [60, -60, 120, -120]) {
            const th = deg * Math.PI / 180
            const rx = ux * Math.cos(th) - uz * Math.sin(th)
            const rz = ux * Math.sin(th) + uz * Math.cos(th)
            const cx = p.x + rx * sstep; const cz = p.z + rz * sstep
            if (!routeMem.wedgeOnSegment(wedges, p, { x: cx, z: cz })) { lx = cx; lz = cz; dbg('walkStaged: soft-steering ' + deg + 'deg around a learned wedge'); break }
          }
        }
      }
      // NAV_LEG_PROBE (Phase C / §5-P2): pre-flight the bearing leg with a bounded getPathTo; a
      // `noPath` verdict rotates through ±60/±120 (probing each) and takes the first reachable, else
      // keeps the direct bearing (SOFT). success/partial/timeout => walk it. Bearing legs ONLY
      // (graph/replay are proven). Cheap: a reachable direct bearing costs one fast probe.
      if (NAV_LEG_PROBE) {
        try {
          const dirx = lx - p.x; const dirz = lz - p.z; const dn = Math.hypot(dirx, dirz) || 1
          const pm = trekMovements(bot, () => require('./commands.js').travelMovements(bot))
          try { bot.pathfinder.setMovements(pm) } catch {}
          const cands = navLeg.legCandidates({ x: p.x, z: p.z }, dirx / dn, dirz / dn, dn, dn, Math.min(24, d))
          const verdict = (c) => { try { const r = bot.pathfinder.getPathTo(pm, new goals.GoalNearXZ(Math.floor(c.x), Math.floor(c.z), 4), PROBE_MS); return (r && r.status === 'noPath') ? 'noPath' : ((r && r.status) || 'unknown') } catch { return 'unknown' } }
          const pick = navLeg.chooseProbedLeg(cands, verdict)
          if (pick) { lx = pick.cand.x; lz = pick.cand.z; if (pick.rotated) dbg('walkStaged: probe noPath at bearing - took ' + pick.cand.deg + 'deg (' + pick.verdict + ')') }
        } catch (e) { dbg('walkStaged: leg probe skipped - ' + e.message) }
      }
    } else if (NAV_LADDER_DIET) {
      // NAV_LADDER_DIET (Phase C / §5-P4): the reactive rotate-detour retires (the leg probe now
      // rotates PREEMPTIVELY at selection time, before a leg is committed). On a stall just re-aim
      // the direct bearing; repeated failure degrades to forceUnstick/watchdog as before.
      const step = Math.min(24, d)
      lx = p.x + ux * step; lz = p.z + uz * step
    } else {
      const degs = [60, -60, 120, -120]
      const th = (degs[stalls - 1] || 0) * Math.PI / 180
      const rx = ux * Math.cos(th) - uz * Math.sin(th) // rotate the bearing in the XZ plane
      const rz = ux * Math.sin(th) + uz * Math.cos(th)
      const step = Math.min(24, d)
      lx = p.x + rx * step; lz = p.z + rz * step
    }
    const legDeadline = stalls === 0 ? 75000 : 30000
    const legTimeout = stalls === 0 ? 30000 : 12000
    const legStart = { x: p.x, z: p.z }
    // Each leg runs through the UNIFIED navigator (navigate.js): the water-hop, pit
    // pillar-out, cave climb-out and cliff-checked surface nudge fire consistently.
    let navRes, navErr
    // NAV Phase B leg goal: Y-BANDED to surfaceRef so A* can't satisfy this leg 45b DOWN a cave
    // at the target's XZ (#41). Folds the intent of the reactive #41 depth-guard (below) into the
    // GOAL at plan time; the guard stays as a cheap post-leg backstop. NAV_HAZARD_LEGS=0 =>
    // today's Y-blind GoalNearXZ, byte-for-byte. Final trek arrival is the independent XZ check
    // at the loop top, so the band never blocks completion, and mining descents (branchMine) run
    // their own deep logic - not through this surface-trek leg - so they are untouched.
    const legGoal = NAV_HAZARD_LEGS
      ? new GoalNearXZBanded(lx, lz, 4, surfaceRef)
      : new goals.GoalNearXZ(lx, lz, 4)
    try {
      navRes = await navigate.navigateTo(bot, legGoal, {
        timeoutMs: legTimeout, deadlineMs: legDeadline, isStopped, label: 'walkStaged',
        budgets: { water: 1, pit: 1, door: 1, climb: 1, nudge: 1 }, // one rescue of each kind per leg - this loop retries legs
        escalate: false, doorPreflight: false, // THIS loop owns the measured-stall forceUnstick; a near-home leg must not spuriously cross a door
        // Pin the leg profile (NAV-P0 remainder + NAV Phase 1). Flag OFF => trekMovements returns
        // travelMovements(bot) - the no-dig profile walkStaged was always meant to trek under
        // (its legs otherwise inherit whatever ambient profile is set, often the wedge-prone
        // setupMovements). Flag ON + >32b from home => the wild dig-capable profile. Lazy require
        // (cycle-safe, the touchP pattern); navigateToInner re-runs this thunk per attempt.
        movements: () => trekMovements(bot, () => require('./commands.js').travelMovements(bot))
      })
    } catch (e) { navErr = e }
    const np = bot.entity.position
    const moved = Math.hypot(np.x - legStart.x, np.z - legStart.z)
    // A leg that spent most of its clock PARKED for a survival reflex (creeper standoff,
    // flee-yield) is NOT a wedge - reflexWaitMs (from the nav's success return or its
    // honest error) tells us the body was held, not blocked. Never count that as a stall
    // and never force-unstick it (the #1 regression guard: don't fight the survival hold).
    const reflexWaitMs = (navRes && navRes.reflexWaitMs) || (navErr && navErr.nav && navErr.nav.reflexWaitMs) || 0
    const reflexDominated = reflexWaitMs > legDeadline / 2
    pushCrumb({ x: np.x, z: np.z }) // record the trek shape for the reusable route
    // #41 §2a DEPTH GUARD: a surface trek that has sunk >18b below its reference surface UNDER A
    // ROOF is threading a cave downward toward the lava band. Climb out proactively (now via the
    // lava-safe climbToSurface) BEFORE the pathfinder walks it to y20 and parks it on a pool edge.
    // Bounded: climbToSurface raises y, so the guard self-clears; worst case bounded by the deadline.
    if (LAVA_SAFE && hasSolidCeiling(bot, 12, { ignoreLeaves: true }) && Math.floor(np.y) < surfaceRef - 18) {
      dbg('walkStaged: surface trek sank ' + (surfaceRef - Math.floor(np.y)) + 'b under a roof at ' + np.floored().toString() + ' - climbing out before lava depth')
      try { await climbToSurface(bot, Math.min(surfaceRef, Math.floor(np.y) + 20), { isStopped }) } catch {}
      continue
    }
    if (moved < 3 && !reflexDominated) {
      // MEASURED stall on a composed GRAPH leg -> this stitched corridor doesn't hold here.
      // Abandon the graph plan for THIS trek and fall through to whole-route replay / bearing from
      // the current position (the underlying routes still dement through their own replay - the
      // graph is read-only over route memory, so nothing is corrupted).
      if (graphLeg) { graphPlan = null; dbg('walkStaged: graph route stalled - abandoning, falling back to replay/bearing'); replay = recallRoute({ x: np.x, z: np.z }, { x: tx, z: tz }); continue }
      // MEASURED stall mid-replay -> the proven route is stale here. Dement it (fail++, 2
      // consecutive fails evict) and abandon the cursor; the next leg falls through to
      // today's blind bearing/rotate/forceUnstick from the current position, UNCHANGED.
      if (replayLeg) { dementRoute(replay.route); replay = null; dbg('walkStaged: route replay stalled - demented, falling back to blind bearing'); continue }
      stalls++
      // After ONE failed retry still wedged, break the freeze with the aggressive manual
      // escape - at most once per walkStaged call. Gated like the watchdog (never while
      // asleep or mid-dig). A truly immovable bot then degrades to an honest give-up +
      // the 150s watchdog backstop, never a manual-controls loop.
      if (stalls === 2 && !unstuck && !bot.isSleeping && !bot.targetDigBlock) {
        unstuck = true
        dbg('walkStaged: wedged after retry at ' + Math.round(np.x) + ',' + Math.round(np.z) + ' - forceUnstick')
        try { await navigate.forceUnstick(bot, { isStopped }) } catch {}
        continue
      }
      if (stalls >= 4) { dbg('walkStaged: giving up wedged at ' + Math.round(np.x) + ',' + Math.round(np.z)); return false }
    } else stalls = 0
  }
  return false
}

// Blocks that mean "this is a STRUCTURE (village house / player build)", so a log
// next to them must NOT be chopped for wood - that's griefing. Natural trees have
// none of these around them.
// (STRUCTURE_RE moved to provision-core.js)
// ANTI-GRIEF for EVERY dig primitive (strip-shaft, tunnel, staircase, pillar, shelter): the
// ONLY blocks any of them may break are NATURAL terrain/ore - never a player-placed build
// block. `canBreakNaturally` is the single gate; without it the climb-out/strip-mine punch
// straight through a base's floor/wall (bot.canDigBlock is a reach/harvest test, NOT a
// protection check). Note: `cobblestone` is deliberately EXCLUDED (it's a common player
// block) - the strip-mine digs `stone` and gets cobble as the drop.
// (DIGGABLE_NATURAL moved to provision-core.js)
// (canBreakNaturally moved to provision-core.js)
// NAV Phase 1 (DESIGN §4.3e): a PRECISE, expiring positive permission for the bot's OWN
// registry-proven scaffold (cobble pillar/staircase/fill it placed itself). Flag-gated
// (DEFAULT OFF - unset/!=='1' => always false, byte-identical to today). Never a regex
// loosening: an exact scaffold.isScaffold(pos) hit only. Widens the three dig-capable RESCUE
// predicates (breachWaterPocket/digStaircaseUp/pillarUpTo) so a bot boxed by its own tower
// can dig out - the mining/shelter dig primitives are deliberately NOT widened.
const scaffoldDigOK = (block) => process.env.NAV_TERRAIN_PROFILE === '1' && !!block && scaffold.isScaffold(block.position)
// Is a player-built structure within `r` of pos? Reused by the shelter + gather filters so
// the bot never digs in / mines right next to someone's base.
function structureNearby (bot, pos, r) {
  for (let dx = -r; dx <= r; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -r; dz <= r; dz++) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (b && STRUCTURE_RE.test(b.name)) return true
  }
  return false
}
// Is this log a NATURAL tree (safe to chop) or part of a village/player build? A wild
// tree ALWAYS has leaves nearby; a structure log has crafted blocks around it. Reject
// on either signal so the wood-gatherer never strips a village or someone's cabin.
function isWildTreeLog (bot, pos) {
  for (let dy = -2; dy <= 3; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz))
        if (b && STRUCTURE_RE.test(b.name)) return false // a build is right here - leave it
      }
    }
  }
  for (let dy = -1; dy <= 6; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz))
        if (b && /_leaves$/.test(b.name)) return true // has a canopy -> real tree
      }
    }
  }
  return false // no leaves and no obvious structure -> be conservative, skip it
}

// Detect which WOOD is actually available nearby (nearest exposed log type), so a
// treeless-of-oak biome (savanna=acacia, taiga=spruce...) doesn't strand a gather that
// assumed oak. Returns the wood family (e.g. 'spruce') or null if no trees in range.
function detectWood (bot) {
  const md = require('minecraft-data')(bot.version)
  const woods = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak']
  let best = null; let bestD = Infinity
  for (const w of woods) {
    const def = md.blocksByName[`${w}_log`]
    if (!def) continue
    const b = bot.findBlock({ matching: def.id, maxDistance: 64 })
    if (b) { const d = b.position.distanceTo(bot.entity.position); if (d < bestD) { bestD = d; best = w } }
  }
  return best
}

// ---- what the bot knows how to obtain directly from the world --------------
// item name -> which BLOCKS to mine for it. Natural blocks only (anti-grief:
// same philosophy as the MINABLE allowlist in commands.js).
const GATHER_SOURCES = {
  cobblestone: ['stone'], // mine natural STONE (drops cobble); never target placed cobblestone (a common player block)
  raw_iron: ['iron_ore', 'deepslate_iron_ore'], // iron armor bootstrap (pillager patrols eat naked bots)
  dirt: ['dirt', 'grass_block'],
  sand: ['sand'],
  red_sand: ['red_sand'],
  gravel: ['gravel'],
  clay_ball: ['clay'],
  oak_log: ['oak_log'],
  spruce_log: ['spruce_log'],
  birch_log: ['birch_log'],
  jungle_log: ['jungle_log'],
  acacia_log: ['acacia_log'],
  dark_oak_log: ['dark_oak_log'],
  cherry_log: ['cherry_log'],
  mangrove_log: ['mangrove_log']
}

// gathers that REQUIRE a tool or drop nothing / can't be mined. Stone mined with
// bare hands drops NOTHING - a pickaxe is mandatory, not just faster.
const GATHER_TOOL = {
  cobblestone: 'wooden_pickaxe',
  raw_iron: 'stone_pickaxe' // iron ore drops nothing below stone tier
}

// smelt-only outputs: output item -> furnace input item (recursively provisioned)
const SMELT_MAP = {
  iron_ingot: 'raw_iron',
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  brick: 'clay_ball',
  smooth_sandstone: 'sandstone',
  charcoal: 'oak_log'
}

// stripped logs aren't gathered or crafted - you strip a placed log with an axe.
// output -> base log to gather (1:1). (wood/hyphae variants left out for now.)
const STRIP_MAP = {}
for (const w of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak']) {
  STRIP_MAP[`stripped_${w}_log`] = `${w}_log`
}

// fuel: a plank smelts ~1.5 items. We fuel with planks (4x more efficient per log
// than burning raw logs). Value is exact for 1.21; we add a small buffer.
const ITEMS_PER_PLANK = 1.5

// How many furnaces a smelt of `count` items warrants: one per 16 items, capped at 4.
// ONE shared definition for the planner (cobble budget) and runtime (ensureFurnaces) -
// the previous parallel-furnace attempt failed partly because the runtime wanted
// furnaces the planner never budgeted 8 cobble each for.
function furnaceCountFor (count) { return Math.max(1, Math.min(4, Math.ceil(count / 16))) }

// SMART SMELT FUEL (task #26). Default ON (same pattern as BRANCH_MINE/MINE_FLUID). Flag off
// => today's plank-fuel planning + permissive runtime picker + no smelt preflight, byte-for-byte.
const SMELT_FUEL_SMART = process.env.SMELT_FUEL_SMART !== '0'
// Items one unit of a fuel smelts (vanilla 1.21 burn values). ONE copy shared by both smelt
// loops and the smelt preflight (previously duplicated inside runSmeltMulti). Non-fuel/unknown
// names fall through to a plank's value, matching the old runSmeltMulti local exactly.
const unitsOf = n => (n === 'coal' || n === 'charcoal') ? 8 : n === 'coal_block' ? 80 : /_log$/.test(n) ? 1.5 : ITEMS_PER_PLANK

// PURE fuel-strategy decision for a smelt of `count` items given coal-family holdings.
// coal/charcoal smelt 8 items each, coal_block 80. When SMART and the uncovered remainder is
// worth a two-stage smelt (> charcoalMin), MAKE charcoal (log->charcoal, ~8 items/piece) for it
// and size a small plank bootstrap for the charcoal smelt itself; below that floor, or with
// SMART off, cover the whole remainder with planks exactly as today. Offline-testable.
//   count      : total items to smelt (smeltTotal)
//   holdings   : { coal, charcoal, coal_block } already aboard (planner's netted `avail`)
//   opts       : { smart, nWant, itemsPerPlank, charcoalMin }
// returns { useCoal, makeCharcoal, charcoalPlanks, needPlanks }
function smeltFuelPlan (count, holdings = {}, opts = {}) {
  const smart = opts.smart !== false
  const perPlank = opts.itemsPerPlank || ITEMS_PER_PLANK
  const nWant = opts.nWant || 1
  const charcoalMin = opts.charcoalMin != null ? opts.charcoalMin : 12
  const coalUnits = ((holdings.coal || 0) + (holdings.charcoal || 0)) * 8 + (holdings.coal_block || 0) * 80
  const uncovered = count - coalUnits
  if (uncovered <= 0) return { useCoal: coalUnits > 0, makeCharcoal: 0, charcoalPlanks: 0, needPlanks: 0 }
  if (smart && uncovered > charcoalMin) {
    const makeCharcoal = Math.min(64, Math.ceil(uncovered / 8) + 1)          // one stack cap bounds the wood cost
    const charcoalPlanks = Math.ceil(makeCharcoal / perPlank) + 2            // bootstrap fuel for the charcoal smelt only
    return { useCoal: coalUnits > 0, makeCharcoal, charcoalPlanks, needPlanks: 0 }
  }
  // legacy / small-smelt: cover the whole remainder with planks (byte-for-byte with today)
  const needPlanks = Math.ceil(uncovered / perPlank) + 2 + 2 * nWant
  return { useCoal: coalUnits > 0, makeCharcoal: 0, charcoalPlanks: 0, needPlanks }
}

function isPlank (name) { return /_planks$/.test(name) }
function isTool (name) { return /_(pickaxe|axe|shovel|sword|hoe)$/.test(name) }
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak']
// the wood family of an item name, or null (dark_oak before oak so it wins)
function woodOf (name) { return ['dark_oak', ...WOODS.filter(w => w !== 'dark_oak')].find(w => name.startsWith(w + '_')) || null }

// ---- planner (pure, offline-testable) ---------------------------------------

// Count ingredient items in a recipe (handles shaped inShape + shapeless ingredients).
function recipeIngredients (recipe) {
  const counts = {}
  if (recipe.inShape) {
    for (const row of recipe.inShape) {
      for (const id of row) if (id !== null && id !== undefined && id !== -1) counts[id] = (counts[id] || 0) + 1
    }
  } else if (recipe.ingredients) {
    for (const id of recipe.ingredients) if (id !== null && id !== undefined && id !== -1) counts[id] = (counts[id] || 0) + 1
  }
  return counts
}

// A shaped recipe wider/taller than 2 needs a crafting table.
function recipeNeedsTable (recipe) {
  if (!recipe.inShape) return Object.keys(recipeIngredients(recipe)).length > 4
  return recipe.inShape.length > 2 || Math.max(...recipe.inShape.map(r => r.length)) > 2
}

// Plan how to satisfy `bom` (item name -> count) given `inventory`. Emits tasks
// in survival TECH-TREE order (phases): gather wood -> craft basics+tools ->
// gather stone/other (now tooled) -> craft furnace -> smelt -> strip -> craft
// finals. Returns { tasks, gathers, crafts, smelts, strips, tools, unobtainable, needsTable }.
function planProvision (mcData, bom, inventory = {}, opts = {}) {
  const avail = { ...inventory }
  // Track the portion of consumption satisfied by the CALLER'S inventory (vs craft
  // surplus credited back to avail mid-plan). When the inventory passed in is total
  // holdings (pack + chests), `used` is exactly what must be in the PACK before the
  // plan runs - i.e. what the resource model has to withdraw from the bank first.
  const stockLeft = { ...inventory }
  const used = {}
  const gathers = {}            // item -> count
  const craftReq = {}           // item -> {crafts, perCraft, needsTable}
  const craftOrder = []         // craft item names, dependency order (leaf-first)
  const smelts = []             // {output, input, count}
  const strips = []             // {output, input, count}
  const toolsNeeded = new Set()
  const unobtainable = {}
  let needsTable = false
  let furnaceNeeded = false

  // The dominant wood in the BOM - used for all GENERIC wood needs (table,
  // sticks, tools, fuel) so we don't drag in a random third tree type for them
  // (those needs are resolved before the main build wood is registered).
  // The BOM's own wood wins (a spruce build makes spruce planks); otherwise use the
  // caller's biome hint (whatever wood is actually growing nearby); else oak. This is
  // what lets a stonebox (no wood in its BOM) craft ACACIA tools/fuel in a savanna
  // instead of stranding on oak that isn't there.
  const woodTally = {}
  for (const [n, c] of Object.entries(bom)) { const w = woodOf(n); if (w) woodTally[w] = (woodTally[w] || 0) + c }
  const primaryWood = Object.entries(woodTally).sort((a, b) => b[1] - a[1])[0]?.[0] || opts.primaryWood || 'oak'

  function take (name, count) {
    const have = avail[name] || 0
    const taken = Math.min(have, count)
    avail[name] = have - taken
    const fromStock = Math.min(taken, stockLeft[name] || 0)
    if (fromStock > 0) { stockLeft[name] = stockLeft[name] - fromStock; used[name] = (used[name] || 0) + fromStock }
    return count - taken
  }
  function addGather (name, count) { gathers[name] = (gathers[name] || 0) + count }
  function ensureTool (tool, stack) {
    if (toolsNeeded.has(tool)) return
    toolsNeeded.add(tool)
    need(tool, 1, stack) // craft it (adds planks/sticks/table deps)
  }

  function need (name, count, stack) {
    if (count <= 0) return
    const remaining = take(name, count)
    if (remaining <= 0) return
    if (stack.includes(name)) { unobtainable[name] = (unobtainable[name] || 0) + remaining; return }

    // stripped logs: strip a placed base log with an axe (1:1)
    if (STRIP_MAP[name]) {
      ensureTool('wooden_axe', [...stack, name])
      need(STRIP_MAP[name], remaining, [...stack, name])
      strips.push({ output: name, input: STRIP_MAP[name], count: remaining })
      return
    }
    // gatherable from the world (maybe tool-gated)
    if (GATHER_SOURCES[name]) {
      if (GATHER_TOOL[name]) ensureTool(GATHER_TOOL[name], [...stack, name])
      addGather(name, remaining)
      return
    }
    // smeltable (needs a furnace + fuel, planned once globally below)
    if (SMELT_MAP[name]) {
      furnaceNeeded = true
      // charcoal's smelt input is a LOG - use the wood that's actually around (primaryWood),
      // not a hard-coded oak_log, or torches are unobtainable in a savanna/taiga/spruce site.
      const input = (name === 'charcoal') ? `${primaryWood}_log` : SMELT_MAP[name]
      need(input, remaining, [...stack, name])
      smelts.push({ output: name, input, count: remaining })
      return
    }
    // craftable - prefer a recipe variant whose ingredients we already stock/plan
    const item = mcData.itemsByName[name]
    const recipes = [...((item && mcData.recipes[item.id]) || [])].sort((a, b) => {
      // prefer variants (1) whose ingredients we already stock/plan, then (2) that
      // use the primary build wood - so generic wood needs converge on one tree.
      const obtainable = n => n && (GATHER_SOURCES[n] || SMELT_MAP[n] || STRIP_MAP[n] || (avail[n] || 0) > 0 || gathers[n] || craftReq[n] || (mcData.itemsByName[n] && (mcData.recipes[mcData.itemsByName[n].id] || []).length > 0))
      const score = r => {
        const names = Object.keys(recipeIngredients(r)).map(id => mcData.items[id] && mcData.items[id].name)
        // HARD penalty for a variant with an ingredient we can't get any way (e.g. the
        // furnace's cobbled_deepslate/blackstone variants) - else it can tie with and
        // beat the cobblestone one and the whole material gets marked unobtainable.
        const dead = names.some(n => !obtainable(n)) ? 8 : 0
        const planned = names.every(n => n && ((avail[n] || 0) > 0 || gathers[n] || craftReq[n])) ? 0 : 2
        // among wood-ingredient variants, REWARD the primary wood and penalise
        // any other specific wood; recipes with no wood ingredient are neutral.
        const usesWood = names.some(n => n && woodOf(n))
        const primary = !usesWood ? 0.5 : names.some(n => n && woodOf(n) === primaryWood) ? 0 : 1
        return dead + planned + primary
      }
      return score(a) - score(b)
    })
    for (const recipe of recipes) {
      const ing = recipeIngredients(recipe)
      const names = Object.keys(ing).map(id => mcData.items[id] && mcData.items[id].name)
      if (names.some(n => !n)) continue
      const perCraft = recipe.result.count || 1
      const craftsNeeded = Math.ceil(remaining / perCraft)
      const table = recipeNeedsTable(recipe)
      if (table) needsTable = true
      for (const [id, cnt] of Object.entries(ing)) need(mcData.items[id].name, cnt * craftsNeeded, [...stack, name])
      if (!craftReq[name]) { craftReq[name] = { crafts: 0, perCraft, needsTable: table }; craftOrder.push(name) }
      craftReq[name].crafts += craftsNeeded
      avail[name] = (avail[name] || 0) + craftsNeeded * perCraft - remaining
      return
    }
    unobtainable[name] = (unobtainable[name] || 0) + remaining
  }

  for (const [name, count] of Object.entries(bom)) need(name, count, [])

  // Furnace(s) + fuel, once, for all smelting.
  const smeltTotal = smelts.reduce((s, x) => s + x.count, 0)
  if (furnaceNeeded && smeltTotal > 0) {
    // PARALLEL FURNACES: big smelts run across up to 4 furnaces (N cook concurrently
    // server-side; the bot shuttles loads). Budget 8 cobble per furnace we don't already
    // have - `opts.furnacesNearby` = placed furnaces near the site (they're never dug up,
    // so batch 2+ reuses batch 1's). Furnace ITEMS in the pack are netted by take().
    const nWant = furnaceCountFor(smeltTotal)
    const nHave = Math.min(nWant, opts.furnacesNearby || 0)
    need('furnace', nWant - nHave, [])
    // FUEL: net out coal/charcoal we already have (coal smelts 8 items vs 1.5 for a plank),
    // so a coal vein hit while strip-mining kills most of the fuel-wood chopping. Each
    // furnace can waste up to a partial burn -> buffer scales with nWant.
    const coalUnits = ((avail.coal || 0) + (avail.charcoal || 0)) * 8 + (avail.coal_block || 0) * 80
    const uncovered = smeltTotal - coalUnits
    if (uncovered > 0) {
      const plankCounts = {}
      for (const n of craftOrder) if (isPlank(n)) plankCounts[n] = craftReq[n].crafts * craftReq[n].perCraft
      const fuelPlank = Object.entries(plankCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || `${opts.primaryWood || 'oak'}_planks`
      // #26: CHARCOAL-FIRST fuel. smeltFuelPlan decides charcoal-vs-planks; `need('charcoal', n)`
      // rides the existing SMELT_MAP recursion (-> gather:<primaryWood>_log + smelt:charcoal),
      // with a small plank bootstrap for the charcoal smelt. SMART off => the else-branch is the
      // old `need(fuelPlank, ceil(uncovered/1.5)+2+2*nWant)` byte-for-byte.
      const fp = smeltFuelPlan(smeltTotal, avail, { smart: SMELT_FUEL_SMART, nWant })
      if (fp.makeCharcoal > 0) {
        need('charcoal', fp.makeCharcoal, [])
        need(fuelPlank, fp.charcoalPlanks, [])
      } else {
        need(fuelPlank, fp.needPlanks, [])
      }
    }
  }
  // Pickaxes for the cobble mine. A wooden pick survives ~59 blocks (breaks mid-run ->
  // re-plan churn), so craft enough FRESH ones - UNLESS we already hold a stone-or-better
  // pick (2x faster, 131 uses); then don't waste wood on redundant wooden picks.
  if (gathers.cobblestone) {
    const better = ['netherite', 'diamond', 'iron', 'stone'].some(m => (avail[m + '_pickaxe'] || 0) > 0)
    if (!better) {
      const want = Math.max(1, Math.ceil(gathers.cobblestone / 50))
      // Ignore possibly-WORN picks (a leftover broke after 4 cobble, verified) - but count
      // UNWORN ones the caller vouches for (opts.freshPickaxes), else every re-plan round
      // crafts 2 more picks and the pack fills with them (verified live: 11 picks).
      // INV_TOOLBANK: also vouch for BANKED picks (opts.bankPickaxes, reconcile-supplied) so the
      // planner WITHDRAWS a banked pick before crafting a new one. bankPickaxes absent/0 (flag off,
      // or empty bank) => usable+banked == freshPickaxes and Math.min(holdings,...) == today.
      const usable = opts.freshPickaxes || 0            // usable PACK picks (caller-vouched)
      const banked = opts.bankPickaxes || 0             // picks in the bank (reconcile-vouched)
      avail.wooden_pickaxe = Math.min(avail.wooden_pickaxe || 0, usable + banked)
      stockLeft.wooden_pickaxe = Math.min(stockLeft.wooden_pickaxe || 0, usable + banked)
      const planned = craftReq.wooden_pickaxe ? craftReq.wooden_pickaxe.crafts : 0
      if (want > planned) need('wooden_pickaxe', want - planned, [])
    }
  }
  if (needsTable) need('crafting_table', 1, [])

  // ---- assemble into tech-tree phases ----
  const gEntries = Object.entries(gathers)
  const logGathers = gEntries.filter(([n]) => /_log$/.test(n))
  const otherGathers = gEntries.filter(([n]) => !/_log$/.test(n))
  const basicPriority = n => (n === 'crafting_table' ? 1 : isPlank(n) ? 0 : n === 'stick' ? 2 : isTool(n) ? 3 : 99)
  // Only WOODEN tools are "basics" (craftable from the log phase alone). A stone/iron tool
  // needs a GATHERED (or smelted) ingredient, so it must come in `finals` AFTER the gather
  // phase - sorting stone_pickaxe as a basic put its craft BEFORE gather:cobblestone and it
  // failed with "no craftable recipe" every from-nothing run.
  const isBasic = n => n === 'crafting_table' || isPlank(n) || n === 'stick' || (isTool(n) && /^wooden_/.test(n))
  const basics = craftOrder.filter(isBasic).sort((a, b) => basicPriority(a) - basicPriority(b))
  const finals = craftOrder.filter(n => !isBasic(n) && n !== 'furnace')
  const G = (n, c) => ({ type: 'gather', item: n, count: c, blocks: GATHER_SOURCES[n], tool: GATHER_TOOL[n] || null })
  const C = n => ({ type: 'craft', item: n, crafts: craftReq[n].crafts, perCraft: craftReq[n].perCraft, needsTable: craftReq[n].needsTable })
  // #26: charcoal is produced by its OWN smelt task and BURNED by the main smelt, so it must
  // run first. Recursion pushes it last -> stable-sort charcoal smelts to the front (SMART only;
  // off => same array reference, byte-for-byte task order).
  const smeltsOrdered = SMELT_FUEL_SMART
    ? [...smelts].sort((a, b) => (a.output === 'charcoal' ? 0 : 1) - (b.output === 'charcoal' ? 0 : 1))
    : smelts

  const tasks = [
    ...logGathers.map(([n, c]) => G(n, c)),
    ...basics.map(C),
    ...otherGathers.map(([n, c]) => G(n, c)),
    ...(craftReq.furnace ? [C('furnace')] : []),
    ...smeltsOrdered.map(s => ({ type: 'smelt', ...s })),
    ...strips.map(s => ({ type: 'strip', ...s })),
    ...finals.map(C)
  ]
  return { tasks, gathers, crafts: craftReq, smelts, strips, tools: [...toolsNeeded], unobtainable, needsTable, used }
}

// Current inventory as {itemName: count}.
// (inventoryCounts moved to provision-core.js)

// ---- executors (live bot) ----------------------------------------------------

// (countItem moved to provision-core.js)

// pathfinder.goto with a deadline (goto can hang forever on an unreachable target).
// One shared implementation now - navigate.js.
// (gotoWithTimeout moved to provision-core.js)

// Walk onto nearby dropped items so they're picked up. Waits for drops to settle,
// then sweeps the nearest item repeatedly (walk ONTO it - range 0). More persistent
// than before because scattered drops on jagged terrain were being left behind.
// (collectDrops moved to provision-core.js)

// Walk ~48 blocks in a rotating compass direction to reach fresh, unexplored
// terrain (loads new chunks) when the current area is tapped out. Returns whether
// it moved. This is what lets gathering keep going instead of stalling with
// "no reachable X within 64 blocks".
async function explore (bot, idx, home, maxRoam, isBad) {
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  const D = 48
  const p = bot.entity.position
  let tx; let tz
  // ROAM FENCE: if we have a home anchor, only step to a spot still within maxRoam of it -
  // else the rotating-compass walk drifts outward forever (one distant tree resets the
  // give-up counter). If no direction fits (we're at/over the fence), head 48 toward home.
  if (home && maxRoam) {
    const overFence = Math.hypot(p.x - home.x, p.z - home.z) >= maxRoam - 8
    if (overFence) {
      const back = Math.hypot(home.x - p.x, home.z - p.z) || 1
      tx = Math.round(p.x + ((home.x - p.x) / back) * D)
      tz = Math.round(p.z + ((home.z - p.z) / back) * D)
    } else {
      // ROOMBA: two passes over the compass - first prefer legs landing in UNSEARCHED
      // cells (isBad = negative memory), only then settle for any in-fence leg. Without
      // this the rotation re-swept the same barren ground round after round (live).
      let picked = null
      for (let pass = 0; pass < 2 && !picked; pass++) {
        for (let k = 0; k < 8 && !picked; k++) { // start at idx, rotate until one fits
          const [dx, dz] = dirs[(((idx + k) % 8) + 8) % 8]
          const n = Math.hypot(dx, dz) || 1
          const cx = Math.round(p.x + (dx / n) * D); const cz = Math.round(p.z + (dz / n) * D)
          if (Math.hypot(cx - home.x, cz - home.z) > maxRoam) continue
          if (pass === 0 && isBad && isBad(cx, cz)) continue
          picked = [cx, cz]
        }
      }
      const back = Math.hypot(home.x - p.x, home.z - p.z) || 1
      ;[tx, tz] = picked || [Math.round(p.x + ((home.x - p.x) / back) * D), Math.round(p.z + ((home.z - p.z) / back) * D)]
    }
  } else {
    const [dx, dz] = dirs[((idx % 8) + 8) % 8]
    const norm = Math.hypot(dx, dz) || 1
    tx = Math.round(p.x + (dx / norm) * D)
    tz = Math.round(p.z + (dz / norm) * D)
  }
  const from = bot.entity.position.clone()
  try { await gotoWithTimeout(bot, new goals.GoalNearXZ(tx, tz, 6), 30000) } catch {}
  return bot.entity.position.distanceTo(from) > 8 // did we actually get somewhere?
}

// Gather `count` of `item` by mining its source blocks (chops whole trees for
// logs). opts: { say, isStopped, restoreMovements }. Returns {gathered, reason}.
// (AIRISH moved to provision-core.js)

const FILLER_RE = scaffold.FILLER_RE // ONE filler list - scaffold.js owns it (this was a byte-identical redeclaration)

// STRIP-MINE downward to reach buried stone (plains - it's all under dirt). Digs a SAFE
// vertical shaft: only break the block underfoot when the block TWO below is solid and
// non-dangerous, so we never drop into lava/water/a cave. One at a time, falling in,
// with the right tool. Returns how deep it dug. Climb back out via pillarUpTo.
// Is the bot standing on/next to a remembered HUT (footprint + a 2-block apron, so the
// doorway stays walkable)? Strip-mining must NOT open a shaft here - it dug a pit right
// in front of the door and the bot then struggled to get into its own safehouse (live).
// (onHutApron moved to provision-hut.js)

// ---- OWN-STRUCTURE AWARENESS ---------------------------------------------------
// The hut is 6x5x6 (hut.schem: anchor + 0..5 in x/z, + 0..4 in y). Being INSIDE it is
// not "underground": before this predicate the roofed interior tripped hasSolidCeiling,
// so climb-out dug through the bot's own roof, pit-escape pillared dirt onto the floor,
// and fishing/farming refused to run "in a cave" while the bot stood in its living room.
// (ownHutAt moved to provision-hut.js)
// Feet (or `pos`) inside one of the bot's own roofed structures. Returns the hut anchor
// entry or null - truthiness is the common use.
// (insideOwnStructure moved to provision-hut.js)

// STEP OFF THE HUT APRON before sinking a shaft/staircase, so the doorstep itself is never dug
// (the onHutApron refusal is KEPT) but "just off the apron" is actually reachable. The old
// step-off tried ONE fixed target (home if far, else the +12,+12 diagonal) with one goto - if
// that single direction was wedged/cratered/watered it returned 0 forever, so a stone gather at
// a dirt-surface hut never got underground (task #22, R2). With STONE_RELOCATE on we rotate the 4
// mining.DIRS at `radius` blocks (exactly branchMine's entrance-relocation pattern) and stop at
// the first cell clear of the apron AND the hut interior. STONE_RELOCATE=0 restores today's
// one-shot target (byte-for-byte movement). NEVER digs. Returns true if we ended clear of the
// apron; the caller keeps its own refuse-and-return on false.
// (stepOffApron moved to provision-hut.js)

// After the hut builds, GUARANTEE a flush doorstep. The ground right in front of the door is
// often 1-2 blocks below the hut floor (median-surface snap + natural slope + gather shafts),
// so the bot steps straight out the door into a pit and then struggles to get back into its own
// safehouse ("hole at the front door", seen live repeatedly). onHutApron only STOPS new digging;
// this positively FILLS the exit lane up to floor level. Best-effort + idempotent: runs each camp
// pass and re-heals any hole a gather cycle re-opens. `at` = hut anchor; the schematic door sits
// at rel (2,*,0) on the z=0 wall, so it opens toward -z (outside = at.z - 1).
// (ensureHutApron moved to provision-hut.js)

// Heal a CREEPER CRATER around the home's exit - the wider cousin of ensureHutApron. A
// blast ate the terrain in front of the door into a multi-deep bowl (live: air down to
// y62 spanning ~x414-421 / z81-85, incl. an EAST pit at x419-420 the door lane misses);
// the pathfinder can't route ACROSS it, so the bot is trapped at its threshold AND falls
// into the far side and dies (live: fell into (419,62,84)). Fills the FULL footprint flush
// at floorY, bottom-up (each layer sits on the one below). Two modes:
//   reposition=false: place only what's reachable from WHERE THE BOT STANDS (the doorway,
//     mid-crossing) - a fast western-lane patch so the step-out lands solid.
//   reposition=true: also walk the rim (GoalNearXZ settles on reachable ground, never in
//     the pit - canDig=false) to reach the far EAST columns the doorway can't touch.
// Own-hut only (caller gates on ownHutAt) + survival place from the bot's own filler +
// skips solid cells => anti-grief and idempotent (0 places on a healthy apron). Returns
// cells placed. `at` = hut anchor.
// (healHomeCrater moved to provision-hut.js)

// Make sure the hut has a usable BED and our spawn is set on it. Runs every camp pass
// (decoupled from the bad>3 rebuild, where the only bed path used to live - so a recovered
// bed rode around unplaced forever, no spawn). If a bed already stands in the hut, (re)assert
// spawn on it once; else, if we're carrying one, walk inside (the apron is filled so entry
// works) and lay it on an interior floor cell clear of the furniture, then set spawn. Every
// place is verified (Fable's placedOK is live) - a fail just leaves the bed in the pack, no
// worse than before. Returns 'present' | 'placed' | 'none' | 'fail'. `at` = hut anchor.
// (ensureHutBed moved to provision-hut.js)

// (digShaftDown moved to provision-mining.js)

// Classic pillar-up: rise to targetY by clearing the 2 blocks above and placing a
// filler block (cobble/dirt we carry) under our feet each hop. STOPS exactly at targetY
// - how a player climbs out of a mine, reliable where the pathfinder's dig-straight-up
// isn't. Out of filler -> stop (caller falls back to walking out).
// Climb back to the surface by digging a SPIRAL STAIRCASE UP (walkable, deterministic -
// scripted pillaring kept trapping the bot in the surface dirt). Each step rotates a
// quarter-turn and rises one: place a floor block if the next step is over air, dig the
// feet+head cells there and our own head clearance, then walk onto it. Stops at targetY.
// (digStaircaseUp moved to provision-mining.js)

// Movement profile for DIGGING OUR WAY BACK to the surface after strip-mining: it may
// break the overburden (canDig) and pillar up, so a stone ceiling can't trap us. Only
// used to escape a mine we dug ourselves - never near player builds.
// (climbMovements moved to provision-mining.js)

// Is there a solid ceiling overhead? i.e. are we in a cave/underground rather than out in
// the open under the sky. Scans the column above the head for a real (block-shaped) block.
// Lets travel tell "dropped into a cave" (climb out) apart from "walking through a valley"
// (fine - don't pointlessly pillar up in the open).
// (hasSolidCeiling moved to provision-hut.js)

// Escape UPWARD when stranded underground (e.g. cross-country travel dropped us into a
// cave/ravine we can't path out of): dig a walkable staircase up to targetY with dig-
// capable climb movements, then restore the caller's movement profile. Anti-grief-safe:
// digStaircaseUp refuses lava/water and honours canDigBlock, so it cuts natural stone to
// surface but won't chew through protected/player blocks. Stops early once we break out
// into open sky even if that's below targetY (no point digging a hill from the inside).
// (climbToSurface moved to provision-mining.js)

// Pillar STRAIGHT UP to targetY: dig any block above the head, then jump and - at the top
// of the hop, once we've actually cleared a block - place a filler block underfoot. The
// mob-safest escape: you rise onto a 1-wide column above ground mobs and can't be walked
// back down into the pit. Stops on lava/water above, out of filler, or protected blocks.
// (pillarUpTo moved to provision-mining.js)

// Cheap ADJACENT step for the mining loops (the mine-one-pause-one fix): walk ONE block into
// a cell the dig loop just cleared and floor-verified, driving controls directly instead of
// re-issuing a full pathfinder goto per block. Look at the cell centre at ~eye height, hold
// forward (+ a jump when stepping UP), poll ~20ms until our floored position is the cell (or
// we're within 0.35b of its centre horizontally), hard-capped by `ms`. ALWAYS clears controls
// in `finally` so a survival flee/defend reflex firing after the loop breaks gets clean
// controls (same discipline as pillarUpTo). Returns whether we arrived. Never digs or places.
// (stepInto moved to provision-core.js)

// Mine a straight horizontal 1x2 TUNNEL forward, collecting drops at our feet so cobble
// isn't lost down a pit (the generic loop mined the floor and dropped it into the hole).
// Digs the two blocks ahead (feet + head level), sweeps drops, steps in, repeats. Safe:
// stops at lava/water or a missing floor (cave). Returns net `itemName` gained.
// (mineTunnel moved to provision-mining.js)

// ---- ORGANIZED BRANCH MINE (mining-strategy-design.md) ---------------------------------
// Place a torch on the floor beneath us if we carry one - lights the mine so mobs don't
// spawn in the fresh tunnels (a lightly-armored bot dies to a dark-cave ambush). Best-effort.
// (placeTorch moved to provision-mining.js)

// Make a few torches so the mine can be lit: coal/charcoal (1) + stick (1) -> 4 torches, no
// table needed. Best-effort - the bot picks up coal as bycatch while tunnelling, and carries
// sticks from tool-crafting; if it has neither it just mines darker (the efba7bd reflex is
// the backstop). Never throws.
// (ensureTorches moved to provision-mining.js)

// ---- SELF-SUFFICIENT tooling at depth -------------------------------------------------
// Pickaxes in the pack (stone-or-better - the tier that actually drops iron/stone), with
// their remaining uses. A deep mine wears these out; if none has uses left the bot can't
// mine and (before this) got dragged to a surface table -> stranded on cave terrain (live).
// (miningPicks moved to provision-mining.js)
// (bestPick moved to provision-mining.js)
// (workingPickCount moved to provision-mining.js)
// (workingMiningPick moved to provision-mining.js)
// (carriedPickUsesLeft moved to provision-mining.js)

// Craft ONE of `itemName` from carried ingredients at `tableBlock` (or the 2x2 grid when
// null). Best-effort, never throws. Returns whether one was made.
// (craftOneFromInv moved to provision-mining.js)

// Craft a stone pickaxe RIGHT HERE (surface OR depth) - LOCAL only, never walking to a
// remembered surface table (that walk is the stranding). Mines a little cobble with the
// still-working pick if short (why we re-tool BEFORE the pick breaks), tops up sticks from
// carried planks, places a carried/crafted table beside us, and crafts. Returns success.
// (craftStonePickHere moved to provision-mining.js)

// UP-FRONT mining kit (surface, before the descent): carry enough pick durability for the
// excursion + a table + sticks so a break at depth is re-tooled IN PLACE, never a surface
// round-trip. Best-effort with carried materials (the bot already made its first stone pick,
// so it has cobble/planks/sticks around); depth re-tool + honest bail cover any shortfall.
// (ensureMiningKit moved to provision-mining.js)

// Dig a single WALKABLE staircase DOWN to targetY (one entrance, back-out-able - the fix
// for N scattered vertical shafts). Each step clears the forward feet+head cells and the
// forward-down tread, then walks onto it. SAFETY: never step onto lava/water/void - probe
// the landing's floor first (mining.descentSafety). Returns { reached, reason, blocked }
// where `blocked` (lava/water/void) tells branchMine to relocate the entrance.
// (digStaircaseDown moved to provision-mining.js)

// ---- PERSISTENT MINE (world-memory 'mines'): remember a dug mine so the next excursion
// RE-ENTERS it instead of re-digging the descent (on cave terrain the descent ate the whole
// excursion, gathered:0 "out of time" - live). A mine record: entrance {x,z}+top (surface),
// level (mining Y), lx/lz (staircase bottom), dirIdx (corridor dir), tip {x,y,z} (corridor
// (mine registry moved to world-memory.js)
// level, then to the corridor tip - NO re-digging (the whole point). VERIFIES on arrival
// (world-read: reached the level and it isn't flooded); returns false if the staircase is
// gone/blocked/flooded so branchMine digs fresh + re-persists.
// (enterExistingMine moved to provision-mining.js)

// ONE organized branch mine for a DEEP ore (iron/gold/copper/...). Descends a single
// staircase to the iron band (~y16, mining.targetMineY) - relocating the entrance on
// water/lava/void instead of stalling - then drives a central corridor with perpendicular
// branches (classic 2-3-spaced branch mine: far more ore per hole than the old scattered
// shafts), torch-lit, with ore-in-the-walls bycatch. RE-ENTERS a persisted mine when one
// exists (spend the budget mining, not re-descending). Danger (mob closes / hp crashes) ->
// climb out and bail to the deployed survival reflexes. Bounded by count + a wall-clock
// deadline + a branch cap. Returns { gathered, reason }.
// (branchMine moved to provision-mining.js)

// Mine up to `max` blocks matching `oreRe` within `r` of the bot - opportunistic bycatch
// while tunnelling (coal for the furnace, etc.). Only natural blocks; best-effort.
// (grabNearbyOre moved to provision-mining.js)

async function runGather (bot, item, count, opts = {}) {
  // Anchor to the PERSISTENT surface (homeY, from the build/provision run) if given, not
  // wherever we happen to be standing now - so a batch that starts underground (previous
  // climb-out fell short, or we fell in a cave) still knows where the real surface is and
  // won't sink deeper. Falls back to the current spot when there's no home reference.
  const surfaceY = opts.homeY != null ? opts.homeY : Math.floor(bot.entity.position.y)
  // XZ home anchor for the ROAM FENCE (keeps gathering from drifting away from the build).
  // Prefer an explicit home {x,z}; else the homeY-implied spot; else where we stand now.
  const home = opts.home || { x: Math.round(bot.entity.position.x), y: surfaceY, z: Math.round(bot.entity.position.z) }
  bot.pathfinder.setMovements(gatherMovements(bot)) // may punch through leaves + pillar up
  dbg('runGather', item, 'x' + count, 'surfaceY=' + surfaceY, 'home=' + home.x + ',' + home.z, 'at', bot.entity.position.floored().toString())
  // #64 §C DYNAMIC_FOOD: before a (possibly far) gather excursion, top up food to what the plan needs
  // (physical-state read: a gather that starts far from the hut sizes up; a near-home gather stays at
  // the home baseline - a no-op when already stocked). Mark the excursion (_foodPlanHint) so any
  // secureFood->courier inside the gather loop keeps the trip ration rather than banking it away. Both
  // bounded + fail-safe; restored in the finally so the hint never leaks. DYNAMIC_FOOD=0 -> inert.
  const _dynFood = process.env.DYNAMIC_FOOD !== '0'
  let _gatherHintPrev = null
  if (_dynFood) {
    const gatherPlan = foodPlanNow(bot, null)
    _gatherHintPrev = _setFoodPlanHint(gatherPlan)
    if (!(opts.isStopped && opts.isStopped())) { try { await topUpFoodForPlan(bot, gatherPlan, { home, isStopped: opts.isStopped }) } catch {} }
  }
  try {
    return await gatherLoop(bot, item, count, { ...opts, surfaceY, home })
  } finally {
    if (_dynFood) _setFoodPlanHint(_gatherHintPrev)
    // Back to the surface if we're below it (strip-mined down OR fell into a cave). Try
    // three ways, in order, until we're within a couple blocks of the top: a spiral
    // staircase up, a straight pillar-up, then a pathfinder dig-out. Any one that works
    // ends it - so a cave with awkward geometry can't strand us.
    try {
      const need = () => bot.entity && bot.entity.position.y < surfaceY - 2
      if (need()) {
        dbg('  runGather climb-out from y=' + Math.floor(bot.entity.position.y) + ' to surfaceY=' + surfaceY)
        bot.pathfinder.setGoal(null)
        for (const climb of [
          () => digStaircaseUp(bot, surfaceY, { isStopped: opts.isStopped }),
          () => pillarUpTo(bot, surfaceY, { isStopped: opts.isStopped }),
          () => { bot.pathfinder.setMovements(climbMovements(bot)); return gotoWithTimeout(bot, new goals.GoalY(surfaceY), 30000) }
        ]) { if (!need()) break; try { await climb() } catch {} }
        dbg('  runGather climb-out ended at y=' + Math.floor(bot.entity.position.y))
      }
    } catch {}
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements() // back to the anti-grief profile
  }
}

// Animals that drop LEATHER when killed. Cows/mooshrooms are the reliable, common
// source (0-2 leather each); we hunt those, not horses/llamas. This is the raw
// material for leather armor - the "from nothing" armor tier (no mining/smelting).
// (LEATHER_ANIMALS moved to provision-food.js)

// Hunt nearby cows for LEATHER until we have `target` more in inventory, or we hit
// the bounds (max kills / time / no-animals-found). BOUNDED on purpose: a survival
// run must never HANG here when no cows are around - it returns whatever it got and
// the caller proceeds with a partial (or empty) armor set. Returns {leather, killed}.
// Same movement/anti-grief profile as gathering (can't tunnel through builds).
// (gatherLeather moved to provision-food.js)

// Animals whose drops FEED you (raw meat is edible). Used by the survival-hunt so a long
// job in a food-poor area doesn't run the bot down to 0 food / 1 hp with nothing to eat.
// (FOOD_ANIMALS moved to provision-food.js)
// (hasFood moved to provision-food.js)
// How many edible items it's carrying (for "stock up" decisions, not just "any food?").
// (foodCount moved to provision-food.js)
// The ONLY time the bot must go hunt: it's hungry AND has nothing to eat. (With food on
// hand, auto-eat handles it; well-fed, no need.) food<=6 = hunger low enough that regen
// has stopped, so act before it hits 0 and gets pinned at 1 hp.
// (needsFood moved to provision-food.js)
// Kill the nearest food animal and collect the meat (auto-eat then eats it, raw is fine).
// Bounded: one animal within ~24 blocks, ~12s. Returns true if something died. Uses the
// movement profile already set (chasing needs no digging, so anti-grief holds). No-op if
// no animal is near - it can't conjure food from an empty field.
// (huntForFood moved to provision-food.js)

// ROD_SUPPLY (M2): a bounded near-clone of huntForFood that finishes off a NEARBY spider for its
// STRING drop (a rod = 3 sticks + 2 string, and on this no-animal site spiders-at-night are the
// only realistic string source). Same GoalFollow/attack/collect shape + ~12s cap as huntForFood,
// but targets spider|cave_spider within `range` (default 16b) - NEVER a hunt across the map, never
// a creeper/skeleton. No-op if no spider is near (honest, like huntForFood on an empty field).
// BOUNDED: ONE pass, no loop; the string need + flag gate live at the ensureFishingRod call site.
// Returns true if a spider died. Uses the movement profile already set (chasing needs no digging,
// so anti-grief holds).
// (ROD_SPIDERS moved to provision-food.js)
// (huntSpiderForString moved to provision-food.js)

// ---- night survival: dig-in shelter for a NAKED bot ------------------------------
// (SHELTER_HOSTILE moved to provision-core.js)
// (_sheltering moved to provision-shelter.js)
// (isSheltering moved to provision-shelter.js) // reflexes (flee/defend) yield while true

// NEVER rest IN water. The night carousel drowned the bot in its own flooding pit
// (observed on test server, hp 20 -> death while every command was held): resting flows
// cycled dig attempts while it bobbed in a basin, and nothing ever LEFT the water.
// Every rest/shelter entry point gets ashore first; bounded, honest about failure.
// (inWaterNow moved to provision-shelter.js)
// (ensureAshore moved to provision-shelter.js)

// Find the nearest DIGGABLE DRY cell to shelter at - a standable surface cell whose column a
// safe night-pit can actually be dug into (solid ground, no lava/water below OR beside the
// shaft, and dry to stand on). ensureAshore gets us out of the water but often leaves us
// water-adjacent on every side, so every in-place pit hits the flooding guard and the shelter
// loops forever (live). This gives the flow somewhere to RELOCATE to. Returns a feet-cell
// Vec3 to walk to, or null when there's no diggable dry ground within `radius`.
// SHELTER_AVOID_FARM (fix #30): returns our wheat-farm anchor {x,y,z} when `pos` sits within
// SHELTER_FARM_R blocks (anchor or any cell), else null. The night-bunker driver never sites a
// pit there - a pit at the farm waterline floods and WRECKS the crop (#28's physical cause).
// Reuses the pure shelterSite.farmConflict predicate. Flag off (=0) restores today (never null-
// gates), so the bot can bunker anywhere it could before.
// (SHELTER_FARM_R moved to provision-shelter.js)
// (shelterFarmConflict moved to provision-shelter.js)

// (findDiggableDryCell moved to provision-shelter.js)
// Where a shelter pit last FLOODED - do not dig another hole next to the same aquifer
// for a while (the re-dig loop beside water is the entombment/drowning mechanism).
// (lastFlood moved to provision-shelter.js)
// (nearRecentFlood moved to provision-shelter.js)
// (nearHostile moved to provision-core.js)
// DANGER WHILE MINING: a cave hostile has closed to melee/bow range, or hp is crashing.
// The idle flee/defend reflexes can't help mid-dig (the bot is committed inside bot.dig()
// awaits, not the pathfinder), so the tight dig loops + the gather loop poll THIS and bail
// to a survival reaction. Naked deep gearup mining died at ~1hp three times (verified live:
// y39-40, zombie in melee + skeleton firing, flee:false) - this is the missing reflex.
// (mineDanger moved to provision-mining.js) // #41: in-lava/on-fire is a dig-abort for every mining primitive (isInLava/onFire are reliable entity flags; oxygenLevel is not)
// LOW-HP-BUT-CALM: hurt below the mine-danger arm with NOTHING attacking - the livelock state
// (hp<12, no hostile) that the arbiter heal/food needs both miss (heal fires at hp<=6 or hp<=10
// only while endangered; food at food<14). The material-round heal entry widens on THIS so the
// bank-side recover gets a second chance. Flag-gated with the gather recover path (GATHER_HP_RECOVER).
// (lowHpCalm moved to provision-shelter.js)
// (underArmored moved to provision-shelter.js)
// How many armor slots are actually worn (0-4). Modulates the deep-mine plan (deepMinePlan):
// a naked bot digs shallower/shorter so it doesn't die on the same deep excursion an armored
// bot survives (naked-deep deaths, live). Complements underArmored (which is a boolean gate).
// (armorPieceCount moved to provision-shelter.js)
// (isNight moved to provision-core.js)
// Fire night-rest whenever we're under-armored and DUSK is falling. This USED to also wait for
// a hostile within 12 blocks - which meant the bot wandered exposed all night and only started
// digging once a skeleton was already shooting it (verified live: 7 night deaths in one
// evening, several while "sheltering"). A naked player doesn't wait to be chased: at dusk they
// go to bed or hole up BEFORE the mobs arrive. Trigger at DUSK (12200), NOT mob-spawn (13000):
// a fresh pit takes ~15-20s to dig + seal, so starting after dark means a zombie walks straight
// into the open hole mid-dig (verified live: began the pit at timeOfDay 13618, a zombie walked
// in during the dig, died). The ~800-tick (~40s) head start lets the pit be sealed before any
// mob spawns. isNight (13000) stays the trigger for the ARMORED "wanted" cases below.
// (shelterNeeded moved to provision-shelter.js)
// FROZEN / ETERNAL NIGHT: on the live server doDaylightCycle is off - timeOfDay is pinned in the
// night band and DAWN NEVER COMES (grounded live: tod stuck ~15438, delta 0 over 45s). Left to
// the normal rhythm the bot shelters forever: underArmored -> shelterNeeded -> it re-seals its
// bunker every cycle, and gearup is night-gated so it never re-arms - the exact "no armor, mobs
// about" hole it never climbed out of (live 379,62,40, pinned 25+ min). Detect a night that will
// not end so the reflexes can shelter BRIEFLY, then resume careful progress (gear up first). On a
// NORMAL server timeOfDay always advances, so this never trips and nights end at dawn as before.
// (NIGHT_FROZEN_MS moved to provision-shelter.js)
// (NIGHT_OVERLONG_MS moved to provision-shelter.js)
// (_todSeen moved to provision-shelter.js)
// (_nightStart moved to provision-shelter.js)
// (nightStuck moved to provision-shelter.js)
// Rest is WANTED (not just needed) when night catches us with the bed close by - even in
// full armor a player sleeps if home is right there (operator rule: safer overall). Far
// from the bed and armored, keep working the night; the commute would cost more than the
// safety buys.
// (nightRestWanted moved to provision-shelter.js)
// (anti-grief helpers canBreakNaturally / structureNearby are defined up top, next to
// STRUCTURE_RE, and shared by every dig primitive + the shelter + the gather filter.)

// Place a block from inventory (name matching `match`) AT world position `target`, using any
// solid neighbouring face to place against. Best-effort; returns whether a block landed.
// (placeAt moved to provision-core.js)

// ACTIVE BUILD ZONE (set by autoBuild, cleared when it ends): the shelter must never dig
// its bunker inside the build footprint - a pit under the castle floor is a hole in the
// build (operator rule). Module-level so every shelter entry point respects it without
// threading a box through each caller.
let buildZone = null
function setBuildZone (box) { buildZone = box || null; worldMemory.setBuildZone(box); provShelter.setBuildZone(box) } // mirror into world-memory: ownInfraAnchors reads it
function inBuildZone (x, z) { return !!buildZone && x >= buildZone.x1 && x <= buildZone.x2 && z >= buildZone.z1 && z <= buildZone.z2 }

// Emergency night bunker for a NAKED bot: dig 2 down into solid ground, seal the opening with
// a block, and wait out the danger (until day AND no hostile near), then climb back out. A
// sealed pit survives a creeper - it can't reach you underground - where fleeing didn't.
// Deterministic + body-side (the brain is HELD during builds). Sets isSheltering() so the
// flee/defend reflexes stand down instead of dragging us off. Returns true if it sheltered.
// Seal a dug night-pit into a mob-TIGHT box. WALLS FIRST, then the cap - the order is the
// whole fix: in open-cave geometry the cap cell is mid-air (all neighbours air) so a cap-first
// placeAt fails "no solid neighbour" and the bot squats in an OPEN hole. Building the head ring
// FIRST gives the cap solid faces to place against. Used by BOTH the fresh-dig and bunker-reuse
// paths so a reused pit is RE-WALLED, not merely re-lidded. `interior` = { feet, head,
// alcoveCell } - cells to KEEP OPEN (never wall them, or the torch alcove gets bricked back in).
// Returns { capped, sideHoles, capPos } (capPos = the cell we actually capped, for breakout).
// (sealShaft moved to provision-shelter.js)

// Widen ONE floor-level neighbour of `feet` into a torch alcove so a sealed pit can be LIT.
// PROBE everything first (world re-reads): the candidate must be natural + breakable, and its
// floor, far wall, both side faces AND ceiling must all be solid non-liquid (alcoveSafe) with no
// liquid on any of its 6 faces - so cutting the one cell keeps the box a complete seal. ONE
// attempt, first candidate that passes; returns the dug cell Vec3 or null. The ONLY new dig in
// the shelter flow, gated by canBreakNaturally (anti-grief) + the liquid probes.
// (digTorchAlcove moved to provision-shelter.js)

// (digInForNight moved to provision-shelter.js)

// Pick the right tool KIND in inventory for a block (pickaxe/axe/shovel), best
// material first. Returns the item or null (bare hands).
// (toolForBlock moved to provision-core.js)

// ---- WORLD MEMORY lives in world-memory.js ------------------------------------------
// The semantic map (resource spots, own-infra registry, proven routes, learned wedges)
// and its world-memory.json persistence moved there; the names are destructured at the
// top of this file so provision.js's export surface is unchanged. noteWaterCrossing
// STAYED below - it reads hutAnchor(), which belongs to the hut/infra layer, not the map.
// FARM_EXPAND (§4.5.3): PASSIVE crossing note. The bot swims across the river daily but that
// water was never remembered. When it is standing IN open-sky water near home and no water entry
// is already within 24 XZ, remember this column so a later farm pass can survey/expand onto it.
// O(1), self-throttled (<=1 check/60s), NEVER navigates. Wired from the index.js food/farm poll.
let _lastWaterNote = 0
function noteWaterCrossing (bot) {
  if (process.env.FARM_EXPAND === '0') return
  if (!bot || !bot.entity) return
  const now = Date.now()
  if (now - _lastWaterNote < 60000) return // <=1 CHECK/60s regardless of outcome (O(1)/min)
  _lastWaterNote = now
  try {
    const p = bot.entity.position
    const feet = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
    if (!feet || feet.name !== 'water') return // only when actually crossing/swimming
    const hut = hutAnchor()
    if (!hut) return
    const near = Number(process.env.FARM_NEAR_HOME || 112) + Number(process.env.FARM_SITE_RADIUS || 40)
    if (Math.hypot(feet.position.x - hut.x, feet.position.z - hut.z) > near) return
    const known = ((loadWorldMem().infra || {}).water) || []
    if (known.some(e => Math.hypot(e.x - feet.position.x, e.z - feet.position.z) <= 24)) return // already remembered nearby
    for (let dy = 1; dy <= 40; dy++) { const b = bot.blockAt(feet.position.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return } // open-sky only
    rememberInfra('water', { x: feet.position.x, y: feet.position.y, z: feet.position.z })
    dbg('  farm: noted a water crossing at ' + feet.position.x + ',' + feet.position.z + ' (later surveyable)')
  } catch { /* passive - never harm the bot */ }
}

// ---- SELF-STRUCTURE integrity + declutter (self-structure-model-design.md) ----------
// The hut anchor entry (infra.hut[0]), or null. The model keys off this min corner.
// (hutAnchor moved to provision-hut.js)
// A world-read closure for the hut-model's pure functions.
// (hutReader moved to provision-hut.js)

// A standable FREE interior cell (floor-level, schema-correct 4x4, threshold excluded),
// nearest to `near` (default: the bot). This is the ONLY sanctioned way to unstick INSIDE
// the hut - step here, NEVER pillar dirt through the roof. Returns a Vec3 or null.
// (freeInteriorCell moved to provision-hut.js)

// REGISTRY INTEGRITY: reconcile the infra registry against the WORLD so the bot's model of
// its own home matches reality. The live registry was garbage (12 crafting_table entries,
// 7 furnaces, 0 beds for a bed that exists) because nothing pruned dead/duplicate cells.
// For every kind: dedupe exact cells and DROP entries whose loaded cell no longer holds
// the block (unloaded/unknown kept). Then re-seed from what physically stands INSIDE the
// hut (the authoritative count) so the true stations are always registered - including the
// bed (also mirrored into m.bed / knownBed, the spawn anchor). Returns a summary.
// (reconcileInfra moved to provision-hut.js)

// INTERIOR CLEANUP with a VERIFIED postcondition: dig every stray filler block in the
// interior (floor piles + head-height pillar remnants), remove DUPLICATE in-hut stations
// (keep one per kind), fill floor holes, and RE-RUN until a fresh world read confirms the
// interior is clean - not best-effort. Uses the self-structure model to know stray vs
// legit. Operator-triggerable (the `huttidy` command) to fix the current dirty hut.
// Returns { ok, passes, remaining, dug, removedDupes }.
// (cleanupHutInterior moved to provision-hut.js)

// A station of `kind` physically standing in the hut interior (world scan, not the lying
// registry), or null. The authoritative "do I already have one inside" check.
// (stationInHut moved to provision-hut.js)

// Where to place a NEW station of `kind` inside the hut - a free interior FLOOR cell (Vec3),
// or null when `desired` of that kind already stand (never duplicate) or the interior is
// full. The placement guard the ensure*/furnish flows consult so they stop re-duplicating.
// (stationSlot moved to provision-hut.js)

// STRUCTURAL REPAIR (creeper damage): compare the hut SCHEMATIC to the world and rebuild any
// missing shell block (wall/floor/roof plank + door) and any missing furniture (chest/furnace/
// table), placing each at its EXACT schematic cell. This is the targeted, idempotent cousin of
// the camp's all-or-nothing `bad>3` full rebuild (which empties+rebuilds the whole hut and so
// never fires for a small blast, leaving a blown door or a lost bank chest un-repaired). A
// creeper that ate a wall + the bank chest gets patched cell-by-cell, no bank teardown. Missing
// items are acquired via the resource model (withdraw>craft>gather). The BED is NOT in the
// schematic - ensureHutBed owns it. Grounds every decision in a live block-read, never faith.
// Best-effort + bounded; returns { planks, doors, furniture, missing } (or {skipped}).
// `hut` = the hut anchor (min corner = schematic origin; floor at anchor.y, walls anchor.y+1..).
// (_hutSchemCache moved to provision-hut.js)
// (loadHutSchem moved to provision-hut.js)
// (repairHutStructure moved to provision-hut.js)

// SELF-HEALING hut maintenance for the camp pass: reconcile the registry against the world,
// REPAIR structural creeper damage (missing wall/door/floor/roof + chest/furnace/table), then
// tidy the interior IFF a cheap model scan says it's dirty (stray filler / duplicate station /
// floor hole) - an early no-op when the hut is already clean+intact, so it's safe to run every
// pass. Returns { clean/cleanup..., repair }. Gated by the caller's isStopped.
// (maintainHut moved to provision-hut.js)

// SURVIVAL-REFLEX home upkeep, shared with the camp pass (commands.js) so there is ONE code
// path. Runs the SAME liveability chain the camp pass always ran - apron -> bed -> bank
// double-heal -> spawn re-assert -> structural repair + interior tidy -> consolidate field
// chests - each step in its own try/catch with the SAME 'camp:' dbg lines. Extracted so a
// creeper-damaged base self-heals during ordinary idle survival too, not only inside a full
// camp job (which gates on a ~>=500-block BOM). Each underlying step already no-ops fast when
// its piece is intact, so this is cheap to run when nothing is broken - no forced rebuilds.
// Returns { bed, chestFixed, repair, consolidated, damaged }; `damaged` is true when any step
// actually did work, so the reflex can log/back off meaningfully when the home was intact.
// (maintainHome moved to provision-hut.js)

// Walk to REMEMBERED ones (up to 3 nearest) and verify each still stands; forget the dead.
// Trying only the single nearest made one stale entry cause a brand-new placement while a
// perfectly good chest stood 9 blocks further (live: three chests at one site).
// (recallAndReach moved to provision-hut.js)

// (searched-cell + gearup memory moved to world-memory.js)
// (bed + spawn-suspect memory moved to world-memory.js)
// SPAWN GUARANTEE: make sure the respawn anchor really is the (hut) bed. USE the bed -
// sets the spawn even at day - whenever we're near it and haven't asserted it recently
// (opts.force skips the freshness check; a respawn far from the remembered bed means the
// server spawn is WRONG - bed broken/obstructed/moved - and every death becomes a world-
// spawn carousel until this runs). If the remembered bed is gone, scan close (rebuilds
// shift it a cell), else lay a fresh one in the hut. Bounded, honest return.
// (ensureSpawnBed moved to provision-recovery.js)

// WRONG-ANCHOR RECOVERY, survival tier: the server respawn anchor is lost or far (the
// world-spawn carousel - every death dropped the bot ~430 blocks from home, and it could
// never re-assert because the re-assert only ran "when home"). Getting home and re-
// asserting the hut bed IS the goal here, above build/gather/gear: long-legged trek
// straight to the remembered bed (or the hut), then a FORCED ensureSpawnBed. No 120-block
// maxTrek cop-out - this is exactly the "too far" case. Honest return; the caller retries
// on the next respawn (the persisted spawn-suspect flag survives deaths and restarts).
// (recoverSpawnAnchor moved to provision-recovery.js)

// GO-HOME-FIRST decision (PURE, offline-testable): the bot's hut BED got creeper-destroyed,
// so the server respawn fell back to WORLD SPAWN ~570 blocks from base - and live it then
// just GEARED UP out in the wilderness, abandoning its hut/farm/chest and re-doing everything
// from scratch far away. A bot 500 blocks from home should WALK HOME, not re-build its life in
// the wild. This picks the home anchor (hut > remembered bed > persisted build site) and
// decides whether we landed far enough to trek home BEFORE any gear-up/local gathering. XZ
// distance only - respawn Y varies, and "far" is a horizontal concept. No bot handle, just
// data, so the "am I far from home -> go home" logic is unit-tested without a world.
// (homeRecoveryDecision moved to provision-recovery.js)

// GO-HOME-FIRST recovery, survival tier (outranks gear-up/gather): if we respawned FAR from
// home, trek back BEFORE resuming any local work, then rebuild the bed + re-assert the spawn
// so future deaths return HOME instead of world spawn - closing the "abandon base at world
// spawn" loop. Bounded (maxLegs) + honest: an unreachable home fails loudly and the caller
// retries on the next respawn rather than wedging forever. Food/threat survival still applies
// en route (auto-eat + nav's water/pit/climb recovery run through walkStaged). Distinct from
// recoverSpawnAnchor (which is gated on the spawn-suspect flag AND no build to resume): this
// fires purely on DISTANCE, considers the build site as a fallback anchor, and explicitly
// rebuilds the bed. RECOVER_HOME=0 disables it at the caller.
// (recoverHome moved to provision-recovery.js)

// Sleep in the remembered bed if we're standing near it. Returns true only if we actually
// slept through to daylight (or the night got skipped) - anything else falls back to the pit.
// (sleepInBedHere moved to provision-recovery.js)

// Night survival, in a player's order of preference: WALK HOME AND SLEEP if the bed is in
// range, else seal a pit where we stand. Every digInForNight call site goes through this.
// _resting covers the WHOLE span (bed trek + sleep + pit): the brain's goto/attack commands
// were yanking the pathfinder out from under the shelter dig mid-carousel (test server:
// 14 deaths in 6 min with the brain fighting the body for control). index.js holds brain
// commands while isResting(), same as the build busy-guard.
// (_resting moved to provision-recovery.js)
// (isResting moved to provision-recovery.js)
// (nightRest moved to provision-recovery.js)
// (nightRestInner moved to provision-recovery.js)

// ---- WHEAT FARM (operator order: "make the wheat farm now so it stops starving").
// The Sonnet shepherd proved the region can run dry of animals - the bot worked at 1hp
// until death with no food fallback. Same pattern as the orchard: renewable supply at
// the camp. Water-edge plot, tilled with a crafted hoe, seeded from grass, bone-mealed
// when bones allow, harvested into bread.
// (boneMealBlock moved to provision-farm.js)

// Till a bank block (dirt/grass) to farmland, VERIFIED by a world re-read. Returns:
//   'farmland' - the cell is farmland now (already was, or the hoe took)
//   'flooded'  - the crop cell above holds water that won't clear (unfarmable here)
//   'unfarmable' | 'nohoe' | false - couldn't till (bad base / no hoe / hoe was a no-op)
// ROOT CAUSE of the live "till did not take (got dirt)": MC only converts dirt->farmland
// when the block DIRECTLY ABOVE is air (HoeItem checks pos.above().isAir()). If water has
// flowed into the crop cell (a bank at the waterline, or flow opened by digging the veg),
// the hoe is a SILENT no-op and the block stays dirt - reproduced live + on the test server.
// Equip/reach/look are all fine (a clean dry cell tills first try); the ONLY blocker is a
// non-air crop cell. So: guarantee the crop cell is air (clear veg/water, let flow settle,
// re-read) BEFORE firing the hoe - then the till takes. A cell that keeps re-flooding is
// genuinely unfarmable (water would wash the seed out too) and is honestly reported 'flooded'.
// (tillCell moved to provision-farm.js)

// (WHEAT_FARM_TARGET moved to provision-farm.js)

// #59 §A FARM_SEED_BANK (default on): WITHDRAW wheat_seeds from the hut bank BEFORE breaking any
// grass - a chest full of seeds was invisible to the farm (the loop-open bug: "seed-starved ...
// deferred" while 1.5 stacks sat banked). Resource-model correct (withdraw > gather). Bounded +
// NEVER throws the food path (bank unreachable / no chest -> quietly returns, caller falls through
// to the grass fallback). FARM_SEED_BANK=0 -> no-op (grass-only, byte-for-byte). Returns the seed
// count on hand after the attempt.
// (withdrawSeedsFromBank moved to provision-farm.js)

// SEED GATHERING (extracted from ensureWheatFarm step 3, §5.4): break tall grass/ferns for
// wheat_seeds up to `want`, roaming a few compass legs if the immediate area is barren. Same
// grassIds / roam legs / budgets as before (behavior identical when want=3). Now also reusable
// by the tend path so a seed-starved plot self-fills. Returns the seed count on hand.
// #59 §A FARM_SEED_BANK: raid the bank FIRST (all three seed sites route through here), then this
// grass loop is the FALLBACK for whatever the bank couldn't supply. =0 -> straight to grass.
// (gatherSeedsNear moved to provision-farm.js)

// #56 FARM_TORCH (§C): light the plot for growth (light>=9) + mob suppression. Torches go on DRY,
// NON-crop ground just outside/between the crop cells (never on farmland - a torch can't sit on it,
// and never on a crop cell - that would kill the wheat), spaced ~6b so they don't cluster. Only
// places torches the bot HAS (ensureTorches crafts from coal+stick if cheap, else we place what we
// carry) - it NEVER blocks farm establishment on missing torches. Mirrors the orchard's placeAt(..,
// /^torch$/) + ensureTorches. Returns how many were placed.
// (placeFarmTorches moved to provision-farm.js)

// (ensureWheatFarm moved to provision-farm.js)

// (Re)establish ONE crop cell: till the farmland if needed, then plant a seed - VERIFIED by
// a world re-read (returns true only if a `wheat` block actually stands after). This is the
// self-heal primitive tend uses to re-plant cells a creeper/trample/failed-plant emptied.
// `cropPos` = the crop cell (one above the farmland). Needs a seed; tills only if a hoe is on
// hand and the base is real dirt/grass (never water/air/stone).
// (replantCropCell moved to provision-farm.js)

// Visit the farm: harvest ripe wheat (age 7), replant harvested cells, RE-PLANT any cell the
// world says is empty/destroyed (creeper/trample/failed plant), bone-meal what's still growing,
// and craft bread (3 wheat each). Called when hungry + huntless AND proactively by the food
// supply pass. GROUNDED: reads the EXACT persisted crop cells and block-reads each - the old
// blind `findBlocks(wheat)` scan returned nothing when planting had faith-failed, so tend
// logged `harvested 0` forever. Robust to partial destruction: re-plants missing cells.
// (tendWheatFarm moved to provision-farm.js)

// ---- FISHING: the food of last resort that works ANYWHERE with water (the guardian
// escort proved this region has no animals - one sheep in 40 minutes - and the bot
// starved through every other fallback). A rod is 3 sticks + 2 string; spiders pay the
// string; raw cod/salmon are safe food the auto-eat handles.
// (ensureFishingRod moved to provision-food.js)

// A standing wheat farm (planted + remembered) = the renewable food source.
// (hasStandingFarm moved to provision-farm.js) // a 0-cell (stale/failed) record is NOT a standing farm - else the food system thinks farming is handled when there's no plot

// PROACTIVE FOOD SUPPLY (base-setup goal, like the hut): while FED + SAFE, ESTABLISH the wheat
// farm at the REMEMBERED open-sky pond so the next hunger crisis never happens - the farm is
// planted and GROWN by the time hunger arrives (reactive secureFood then just harvests it).
// The reliable renewable on a no-animal site: grass seeds + a hoe + a tilled dirt bank beside
// the remembered water (sand banks swapped for carried dirt) -> wheat -> bread. Secondary: an
// OPPORTUNISTIC hunt only if an animal is actually visible (never depended on - ~none here).
// Best-effort + bounded; returns { ok, reason }.
// Nearest food animal within `maxDist` blocks (DISTANCE-BOUNDED, actually reachable), or null.
// The old unbounded seesAnimal() scanned every loaded entity server-wide - a cow loaded 200
// blocks away made the bot think it "had animals" and SKIP the exploration sweep (the live bug
// - it never swept SW toward the actual food). Returns { name, dist } | null.
// (nearestFoodAnimal moved to provision-food.js)

// Eat what's in the pack up to comfortable - cook raw meat FIRST (raw is poor food), then eat.
// Fixes "idled at food=13 holding beef" - never sit hungry with food in hand.
// (eatFromPackToComfortable moved to provision-food.js)

// (ensureFoodSupply moved to provision-food.js)

// Cheap check (NO bank walk): should a fed, idle, safe bot proactively establish its food
// supply now? The index reflex gates on this. Renewable = a standing wheat farm; banked food
// is treated as 0 here (cheap) - the bank is the reactive pantry, not the durable supply.
// (needFoodSupply moved to provision-food.js)

// ---- JOB-LEVEL ARBITER: the bot->state snapshot the pure authority (arbiter.jobSurvivalNeed)
// reads. This is the ONE place the scattered survival predicates are gathered; every progress
// job consults survivalNeed(bot)/mayDoProgress(bot) instead of its own food/hp/threat checks.
// (survivalState moved to survival-snapshot.js)
// The highest UNMET survival need blocking progress, or null. opts.foodThreshold: 14 to START a
// progress job (default), 6 for a mid-activity CRITICAL bail. THE single authority.
// (survivalNeed moved to survival-snapshot.js)
// May a progress job (gearup/build/mine/gather) run RIGHT NOW? False when a SURVIVE need is
// unmet. Callers yield to the need (secure food / flee / shelter) and resume once it's met.
// (mayDoProgress moved to survival-snapshot.js)

// SCHEDULER SNAPSHOT (S4, DESIGN §4): assemble the full plain-data snapshot the pure scheduler
// (scheduler.js) consumes - a SUPERSET of survivalState(bot). Async because the bank read
// (resources.totalCounts) is async; both call sites (the /cmd busy-gate and the ~15s tick) are
// async. Every sub-read is individually try/catch-wrapped so a half-broken world yields a PARTIAL
// snapshot (an absent field = "not blocking" per the scheduler contract), never a throw. The bank
// read is cachedOnly (MANDATORY, REDESIGN §11: never walk the bot from a tick). SCHEDULER=0 never
// calls this.
// ACTIVE-JOB SYNTHESIS (S7 §3.3), factored out of schedulerState so BOTH the snapshot AND the 5s
// watchdog interval read ONE definition. SYNC + cheap (no bank reads, no awaits): commands' running
// activity first (classified), else the five survival latches - exactly as before. Two fields are
// now REAL: lastProgressAt = max(the verified-progress clock, this job's own startedAt) so a job
// entered by a path that forgot to touch at t0 still starts its clock at startedAt rather than
// inheriting a stale global clock (the pure watchdog prefers lastProgressAt when non-null, so a
// too-old value would insta-fail a fresh job); blockedOn = the §6 nudge marker, cleared by any touch.
// Never throws.
// (activeJobInfo moved to survival-snapshot.js)

// (schedulerState moved to survival-snapshot.js)

// #52 FISH_FROM_BANK — PURE bank-stand predicate. A cell is a safe fishing STAND iff its feet/head
// are a genuinely-dry standable pocket (shelterSite.feetCellDry: 2 air, no water in feet/head or the
// 4 feet-level neighbours - never a puddle edge that floods) AND some water is horizontally adjacent
// so a cast actually reaches the pond. hasAdjacentWater is computed at the GROUND level by the caller
// (feet-level water is excluded by feetCellDry). Extracted for unit testing.
// (isBankStand moved to provision-bank.js)

// #52 FISH_FROM_BANK — the nearest DRY, castable bank stand cell adjacent to water `w`, or null.
// Scans solid ground blocks within ~3b horizontally of w (a small y-window covers a flush shore or a
// one-block lip), tests each with isBankStand, and returns the feet Vec3 nearest the bot. Never picks
// a cell in/under water - the whole point is to fish standing dry, casting INTO the pond.
// (bankStandFor moved to provision-bank.js)

// #61 SKIP_DEAD_FISHING - the runtime fishing gate. Fishing is confirmed DEAD on this stack (0
// catches all session); every fishing entry point consults THIS, so a single flag governs them
// all. DEFAULT OFF (the deliberate exception to the usual default-ON convention - see food.shouldFish).
// FISHING_ENABLED=1 restores today's fishing behavior byte-for-byte. GATE only: all rod/string/#52
// machinery is kept intact so re-enabling is a one-flag flip if fishing is ever fixed upstream.
// (fishingEnabled moved to provision-food.js)

// (fishForFood moved to provision-food.js)

// ---- SECURE FOOD: the ONE "get me fed" routine -------------------------------------
// Every starving flow funnels here (gather loop, travel legs, smelt rotations, material
// rounds, and the body's food-crisis reflex). A player's order of ops: eat what you
// carry -> raid the pantry (bank) -> cook -> hunt what's visible -> harvest the farm ->
// fish -> go LOOKING for animals -> and if the land is truly barren, hole up at home
// instead of working on at 1hp. Starvation itself stops at half a heart - every actual
// starve-death was chip damage taken while it kept working (verified live, repeatedly).
// (RISKY_EAT moved to provision-food.js)
// One EATING policy (commands.eatFood delegates here): most filling SAFE food first;
// risky food only when starving (<=6) or critically hurt with hunger already low.
// (eatBestFood moved to provision-food.js)

// Eat down the pack until reasonably full or out of (safe) food - one bite of the chain's
// hard-won meat doesn't stop the next starve 10 minutes later.
// (eatUp moved to provision-food.js)

// BAKE BREAD from banked wheat (the live rescue): the bot's bank wheat is RAW/inedible, so a
// starving bot standing at home with 5 wheat + a farm still can't eat without baking. Top up
// the pack from the bank (runCraft only crafts from ON-HAND) then craft bread at the home
// table via runCraft - the SAME primitive tendWheatFarm/fishing-rod use (ensureTable finds/
// places the table; bot.recipesFor/bot.craft; verified through the pathfix path). Skips
// GRACEFULLY (returns 0, never throws) if no table is reachable or the wheat can't be found.
// (bakeBreadFromWheat moved to provision-food.js)

// #62 §A FOOD_BANK_FIRST (default on): the crisis deadlock-breaker. At hp1/food0 the far farm is
// UNREACHABLE, but the hut BANK is not - if it holds edible food, WITHDRAW enough to reach a safe
// food level and EAT it BEFORE any farm trek / fishing / hold. Reuses resources.ensureFood (the
// same hut-anchored, range-bounded withdraw step 1 uses) gated by the pure bankFoodWithdrawPts
// decision (only bothers when the bank actually holds food worth pulling). BOUNDED (maxDist 64 -
// never a far trek) and fully guarded: a dry/unreachable bank falls straight through with nothing
// lost. Anchors on hutAnchor()/knownBed() (works even when opts.home is null, the ladder/crisis
// dispatch). Returns { fed }. FOOD_BANK_FIRST=0 -> immediate no-op (byte-for-byte).
// (bankFoodFirst moved to provision-food.js)

// (_securingFood moved to provision-food.js)
// (isSecuringFood moved to provision-food.js)
// FOOD_FLOOR F4: the no-progress escalation counter (module-local; a restart re-allows a fresh
// attempt). Advanced by the floor branch on a zero-food dispatch, reset on food gain, and BUMPED
// by the watchdog's `(wd) CYCLE repeatFail` on the recovery ladder (index.js) - so the eternal
// re-loop escalates (widen the water scout one ring + active fishing over a passive outdoor hold)
// instead of re-running the identical failing sequence. Capped (foodFloorEscalation).
// (_foodFloorNoProgress moved to provision-food.js)
// (escalateFoodFloor moved to provision-food.js)
// (_foodFloorState moved to provision-food.js) // test/introspection seam
// (secureFood moved to provision-food.js)
// (secureFoodInner moved to provision-food.js)

// PROACTIVE, SYSTEMATIC food scouting (the core exploration fix): sweep UNSEARCHED ground
// outward in a real pattern (explore.octantSweep - 8 octants x expanding rings around home)
// to FIND animals + water, biased AWAY from sectors swept recently (persisted, decaying
// negative-memory in worldMem.scouted). The old scoutHunt re-tread stale remembered pastures
// (NE/SE) and never covered the SW/NW where the food actually was (live: starved 88 blocks
// from a river of sheep). Remembers finds: animals -> 'pasture' infra, water -> 'water' infra.
// Returns { found: 'animals'|'water'|null, kills }. Bounded by maxMs + maxLegs.
// (scoutForFood moved to provision-food.js)

// Walk expanding legs looking for food animals. Remembers where it finds them
// ('pasture' infra) so the next famine treks straight back instead of re-searching.
// (scoutHunt moved to provision-food.js)

// BOUNDED HOLD (S5, replaces the old famine-hold - the I5 migration): nothing edible anywhere -> retreat
// home/indoors and WAIT in the ONE bounded way whose wake provably occurs, instead of dying to
// chip damage at 1hp. Built FROM the old famine-hold's proven body (same get-home preamble + 90s re-eval
// loop with the FORCED-FRESH bank re-check - the 11h-stale-cache starvation fix, DO NOT LOSE IT),
// PLUS a grave-appeared wake (a fresh grave IS a recovery input - the ladder's next pass runs R1)
// and a sealed-pit branch (existing digInForNight) for night-exposed-no-bed. Refuses to hold on
// nightStuck (eternal night has no dawn wake - the caller acts by night instead). The hard deadline
// is unconditional (BOUNDED_HOLD_MS, default 90s). Returns { held, wake }.
// (boundedHold moved to provision-recovery.js)

// Bounded water scout: 4 cardinal legs x expanding radius, scanning for surface water at
// each stop. Feeds BOTH fishing and the wheat farm (found ponds land in 'water' memory).
// (scoutForWater moved to provision-shelter.js)

// ---- SCAFFOLD TEARDOWN: the pathfinder pillars up to tall canopies and abandons the
// dirt towers (operator: "a massive mess"). The patch layer remembers every self-placed
// block; after a harvest, ride the tower back down and pocket the dirt.
// (cleanupScaffold moved to provision-maintain.js)

// ---- INVENTORY HYGIENE: mob-drop junk (spider eyes, string, flint...) quietly eats the
// slots the build materials need (seen live: ~8 slots of trash mid-castle-provision).
// Toss what has no use; KEEP bones (they become bone meal for the tree farm) and a small
// rotten-flesh famine reserve (the risky-food ranking eats it only when starving).
// (JUNK_RE moved to provision-maintain.js)
// (dumpJunk moved to provision-maintain.js)

// HOLD until the night is survived: a nightRest attempt returns false when another flow
// already holds the shelter lock (the idle reflex sealed a pit while a resume was booting)
// - and callers treated false as "carry on", walking straight back into the dark (died
// that way at 350,64,36). This BLOCKS until day/armored/stopped, re-attempting rest
// whenever nothing else is resting.
// (restUntilSafe moved to provision-recovery.js)

// LOW-HP SHELTER-AND-HOLD: a hurt bot that is still exposed (dark night or a mob in range) is
// grinding to death (live: armored far-gather 18.7->11.7->0.77->dead). Latched like secureFood/
// nightRest so the reflex and the inline job-loop entry are mutually exclusive (no double-shelter).
// Reuses ONLY existing primitives: eat from the pack to restore regen fuel, dig-in/sleep via
// nightRest when it's night or a hostile is close, then hold-and-watch until hp recovers. Bounded
// (3 min), and BAILS honestly when it can't recover here (frozen night, out of food, still taking
// damage) so the food chain / flee / defend that DO own those cases take over.
// (_recoveringHp moved to provision-recovery.js)
// (isRecoveringHp moved to provision-recovery.js)
// (recoverHp moved to provision-recovery.js)

// RECOVERY LADDER (S5): the rung->executor map. Every action string that recoveryPlan emits maps
// to an EXISTING, bounded, live-verified executor (no new dig/place/nav paths). `commands` is a
// LAZY require (cycle-safe). `o` = { isStopped, say, home, dbg }. Actions with no executor
// (trekOrchard - a WOOD grove, not a food producer) are simply absent -> the ladder skips them.
// (RUNG_EXECUTORS moved to provision-recovery.js)

// (_recoveringDegraded moved to provision-recovery.js)
// (isRecoveringDegraded moved to provision-recovery.js)

// ==== #58 DEADLOCK_RESET: suicide-reset an unbreakable hp<=2/food0 starvation deadlock =========
// See DESIGN-deadlock-suicide-reset.md. The bot floors at hp1/food0 FOREVER when no food is
// reachable (fishing dead, no water for the farm) - starvation never kills on Normal, so the
// recovery ladder pings the same failing rungs and makes zero progress. A respawn is a CLEAN full
// reset (hp20/food20 at the bed) that lets it range far enough to actually reach food. So when
// GENUINELY deadlocked: STASH EVERYTHING at the bank (empty pack -> empty grave -> zero loss),
// deliberately DIE (fall damage), respawn fresh, recover properly from full. DEADLOCK_RESET=0 ->
// today's hold-and-starve, byte-for-byte (the detector never fires, no code path changes).
// (DEADLOCK_HP moved to provision-recovery.js)
// (DEADLOCK_FAILS moved to provision-recovery.js)
// (DEADLOCK_FALL_H moved to provision-recovery.js)
// (DEADLOCK_RESET_COOLDOWN_MS moved to provision-recovery.js)
// (DEADLOCK_MAX_NOFOOD moved to provision-recovery.js)
// #63 SUICIDE_DIES (default on): make the suicide-reset actually DIE when it can't pillar-to-fall
// under its own roof. §A robustly reaches OPEN SKY before pillaring; §B falls back to DROWN then
// PIT-DROP when open sky is unreachable. Each `=0` -> today's fall-only-then-abort byte-for-byte.
// (SUICIDE_EXIT_OPEN_SKY moved to provision-recovery.js)
// (SUICIDE_FALLBACK_DEATH moved to provision-recovery.js)
// (SUICIDE_DROWN moved to provision-recovery.js)
// (_deadlockFails moved to provision-recovery.js)
// (_deadlockResetting moved to provision-recovery.js)

// PURE detector (unit-tested): does a GENUINE multi-cycle deadlock warrant a suicide-reset NOW?
// Fires ONLY at hp<=HP & food===0 & no pack food & failCount>=FAILS & the cooldown has elapsed,
// with the flag on. Everything is passed in (no bot / no I/O) so the trigger is fully testable.
// opts.enabled===false (the DEADLOCK_RESET=0 flag) hard-disables it; hp/fails/cooldownMs override
// the module defaults for the unit tests.
// (deadlockResetDue moved to provision-recovery.js)

// Persisted (world-mem, the gearupState pattern) so a restart can't bypass the cooldown or the
// no-food back-off. { at: last reset timestamp, count: consecutive resets with no food gained }.
// (deadlockResetState moved to provision-recovery.js)
// Record that a reset is FIRING (called once, before the stash+die): stamps the cooldown clock and
// bumps the no-food streak. Stamping on FIRE (not on success) guarantees the detector can't re-fire
// for DEADLOCK_RESET_COOLDOWN_MS even if this attempt aborts - so an unreachable bank / un-diable
// spot can never spin retries. The WARNING surfaces the real root (food source still broken).
// (noteDeadlockReset moved to provision-recovery.js)
// Any REAL food/hp progress clears both the in-run fail counter and the persisted no-food streak
// (the food source works again). Called each recover cycle + on a successful recovery.
// (_noteDeadlockProgress moved to provision-recovery.js)
// #41 P4: is post-death recovery complete enough to let the build drive again? Builds the snapshot
// and asks scheduler.recoveryReady; CLEARS the P0 latch when ready (so resumeBuild proceeds). A hard
// RECOVERY_MAX_MS ceiling on how long the latch has been held guarantees the build is never trapped
// forever (P4 "never hides forever"), and any error fails OPEN (ready) - a snapshot glitch must not
// stall a saved build. RESILIENT_RECOVERY=0 -> always ready (the latch is inert).
// (recoveryReadyNow moved to provision-recovery.js)
// RECOVER FROM DEGRADED (S5): the survival-class orchestrator that EXECUTES scheduler.recoveryPlan.
// Loops { s = schedulerState; exit on ladderDone/isStopped/deadline; plan = recoveryPlan(s); take
// the FIRST rung that is rungFeasible + has an executor + this run hasn't tried; run it; mark tried
// on BOTH success and failure (once per action per run => <=8 executions => termination); re-loop -
// each rung changes the world, so we re-snapshot + re-plan }. Bounded by RECOVERY_MAX_MS (default
// 15 min), the once-per-action rule, and isStopped. No distance gates (recoveryPlan owns
// sequencing), no new dig/place, no buildAbort/resumeJob touching. Returns { done, rungs, reason }.
// (recoverFromDegraded moved to provision-recovery.js)

// #58 DEADLOCK_RESET - the last-resort suicide-reset action (impure). STASH ALL non-essential at
// the bank (aggressive: raw_iron/tools/materials, leave the pack empty so the grave holds nothing),
// then DIE via fall damage so the vanilla respawn resets hp20/food20 at the bed with an empty pack
// and the normal post-death recovery runs from FULL. Bounded; aborts to holding on ANY snag (bank
// unreachable, chest full, can't pillar, didn't die) - NEVER suicides while still holding gear.
// Returns true only if the bot actually died. The cooldown timestamp is stamped by the caller
// (noteDeadlockReset) BEFORE this runs, so an abort still imposes the full anti-loop gap.
// (deadlockSuicideReset moved to provision-recovery.js)

// #63 SUICIDE_DIES §A (PURE, unit-tested): given a list of candidate cells each already world-
// sampled + tagged { solidCeiling, standable }, return the FIRST that is genuine OPEN SKY and
// stand-able (!solidCeiling && standable), else null. The suicide-reset uses this to choose where
// to walk before pillaring for the lethal fall. Pure -> testable without a live bot.
// (pickOpenSkyCell moved to provision-shelter.js)

// #63 §A: world-sample the column at (x,z) near surfaceY. Find the top stand-able cell (solid non-
// fluid floor with 2 air above) within a small vertical window, and whether that cell is inside our
// own hut or has a SOLID ceiling within `ceil` blocks (leaves ignored - a canopy isn't a roof).
// Returns { x, y, z, standable, solidCeiling }; a not-standable column reports standable:false.
// (sampleColumnForSky moved to provision-recovery.js)

// #63 SUICIDE_DIES §A: robustly get the bot to an OPEN-SKY, stand-able cell before pillaring for the
// lethal fall (pillarUpTo refuses under our own roof). The live bug: a single 6-block step-out
// failed to clear a big hut. Instead we sample a RING of candidate columns at radius 8-12 around the
// hut anchor (8 compass bearings), rank them with pickOpenSkyCell, walk to the first genuinely open-
// sky one, and RE-VERIFY open sky on arrival with the bot-position predicate (the authority) before
// returning. Bounded (~deadlineMs, default 60s). Returns whether the bot ends genuinely under open
// sky; the caller falls through to §B when it can't. SUICIDE_EXIT_OPEN_SKY=0 -> not called.
// (reachOpenSky moved to provision-recovery.js)

// #63 SUICIDE_DIES §B: FALLBACK deaths when pillar+fall can't be set up (still under our own roof).
// Tries, in order, each independently bounded and abort-to-hold on failure: (1) DROWN in remembered
// deep water, (2) PIT-DROP into a dug shaft beside the hut. Returns true only if the bot actually
// died. SUICIDE_FALLBACK_DEATH=0 -> not called (caller aborts as today). Never wedges.
// (deadlockFallbackDeath moved to provision-recovery.js)

// #63 §B.1: DROWN on purpose. Walk to the nearest remembered DEEP (>=2) water, drive into it, then
// clear all controls (crucially NOT jump) so the bot SINKS and its head stays submerged - the
// navigate deliberate-drown latch stops the drown-escape reflex from swimming it out - and wait for
// oxygen to deplete to death. Bounded (~90s total). The latch is set in the try and cleared in the
// finally, so a normal accidental water entry ALWAYS still escapes. Returns true only if it died.
// (suicideByDrown moved to provision-recovery.js)

// #63 §B.2: PIT-DROP. Dig a ~6-deep OPEN shaft in the column one step FORWARD (never on the build
// footprint / farm), then step into it so the >=5b fall kills at hp<=2. Because reach caps a single-
// position dig at ~3-4 blocks, we deepen in two stages: dig the front column from the surface, drop
// ONE into our own cell to regain reach, dig the front column deeper, then pillar the ONE block back
// up so we stand at the shaft rim and step off. Bounded; refuses build/farm/protected blocks and
// aborts to hold on any snag. Returns true only if the bot actually died.
// (suicideByPitDrop moved to provision-recovery.js)

// Deliberate, bounded death by FALL (the most controllable method - no reflex fights it, unlike
// drowning which WATER_ESCAPE would resist). Get to open sky near home (pillarUpTo refuses under
// our own roof), pillar ~DEADLOCK_FALL_H, then step off the edge -> a >=3b fall is lethal at hp<=2.
// Bounded 30s; returns true only if the bot actually died, else aborts to holding (never wedges).
// #63 SUICIDE_DIES: §A robustly reaches open sky first (reachOpenSky); if still roofed, §B falls
// back to drown/pit-drop before the honest abort. Both flags =0 -> today's fall-only-then-abort.
// (deadlockDieByFall moved to provision-recovery.js)

// ==== S6: PROACTIVE MAINTENANCE PASS (§4.2/§5) ===========================================
// The single maintain-class job. A thin, bounded composition of EXISTING routines keyed off
// maintain.needs(snapshot): harvest orchard, tend/expand the farm, cook+bake, COURIER the food
// surplus into the bank, SAFEKEEP spare kit, then top up gear/tools/torches + repair home. It
// NEVER preempts progress/build (rank 1, tick admission, command-path stopMaintenance) and bails
// on any survival need. MAINTAIN=0 -> the tick never dispatches this (defer-note restored).
// (_maintaining moved to provision-maintain.js)
// (_maintStop moved to provision-maintain.js)
// (isMaintaining moved to provision-maintain.js)
// (stopMaintenance moved to provision-maintain.js) // the running pass unwinds at its next isStopped poll
// (_setMaintaining moved to provision-maintain.js) // test-only seam (schedstatetest activeJob synthesis)
// (_maintState moved to provision-maintain.js)

// Resolve the hut bank chest exactly as consolidateBank does: the bed-adjacent chest inside the
// hut, else the nearest verified chest <=16b of the hut anchor. null (log+skip) if no bank -
// making one is maintainHome's job (step 9). Returns the chest cell {x,y,z} or null.
// (resolveBankCell moved to provision-bank.js)

// ==== #64 DYNAMIC_FOOD (§B/§C wiring) =======================================================
// Read "what is the bot about to do" from bot position + the scheduler snapshot into the PURE
// foodNeedForPlan's plan shape {activity, distHome, depth, homeReachable}. PHYSICAL-FIRST + robust
// (the mandate: derive distHome from bot pos vs hutAnchor, depth from surface Y vs bot Y; default to
// the home baseline when unknown) so a stale/absent job label never mis-sizes the ration. `override`
// lets a caller that KNOWS its plan (branchMine knows the descent target depth) force the numbers.
// (DFOOD_DEEP moved to provision-food.js)
// (DFOOD_FAR moved to provision-food.js)
// (foodPlanNow moved to provision-food.js)

// The imminent-excursion plan hint: set by branchMine/runGather at the pre-trip point so the courier
// (which can fire from the pre-mine secureFood) keeps the TRIP-sized ration instead of stripping food
// down to the home baseline just before descending (§C's "do NOT courier food away when an excursion
// is imminent" guard). Save/restore nests correctly (runGather -> branchMine). Only ever consulted
// when DYNAMIC_FOOD is on.
// (_foodPlanHint moved to provision-food.js)
// (_setFoodPlanHint moved to provision-food.js)

// §C - BOUNDED, FAIL-SAFE pre-trip food top-up. Before a deep-mine / far excursion, if the pack food
// (points) is below what the plan needs, WITHDRAW the shortfall as bread from the bank (reuse
// resources.acquire, bank-first: craft:false so it never kicks off a gather right before the trip).
// Bounded (a loaf count), fail-safe (bank unreachable/empty -> withdraw no-ops -> the job proceeds with
// what's carried; never blocks). DYNAMIC_FOOD=0 -> the caller skips this entirely (no top-up). Returns
// the loaves withdrawn (0 if already stocked / nothing banked).
// (topUpFoodForPlan moved to provision-food.js)

// THE COURIER (§5.2): deposit the pack's food surplus into the hut bank so R2's raid-the-cache
// always works. Reuses depositMaterials' open/deposit/close body via the explicit-list mode; the
// pure maintain.courierPlan decides what moves. Refreshes the chest cache so bankFoodPts updates
// next tick. Returns how many food items were banked.
// (courierFoodToBank moved to provision-food.js)

// SAFEKEEPING (§5.3, FIRM): stash spare tools + build-material surplus into the bank so a death
// mid-excursion costs only the bounded loadout. Same bank + deposit mode as the courier; the pure
// maintain.safekeepPlan (never the last working tool of a kind) decides. REFUSES during build
// placement (belt-and-suspenders; trigger 3 lives in planner). Returns how many items were stashed.
// (safekeepSweep moved to provision-maintain.js)

// SPARE-KIT COURIER (#41 RESILIENT_RECOVERY, §P2): deposit a SURPLUS/dupe spare set (4 armor + pick
// + sword) into the hut bank so a post-death respawn can withdraw + re-arm (rearmFromBank) WITHOUT
// depending on a lost/lethal grave. Same bank + deposit machinery as the food courier; the pure
// maintain.spareKitCourierPlan (never strips the bot's only kit) decides what moves. Returns how
// many spare items were banked. SPAREKIT=0 / RESILIENT_RECOVERY=0 -> no-op.
// (spareKitToBank moved to provision-maintain.js)

// maintenancePass(bot, opts) - the orchestrator. opts: { say, nightIndoorOnly, isStopped }.
// Returns { ok, steps: [label...], reason } for the tick's one-line note.
// (maintenancePass moved to provision-maintain.js)

// ---- INFRA CONSOLIDATION (fix #13) --------------------------------------------------------
// Every "x,y,z" cell the bot has in its OWN infra memory, any kind. Used by lonelyFurnace to
// exempt the bot's own table/chest/torch next to a camp furnace from the structure scan.
// (ownInfraCells moved to provision-bank.js)

// PURE: is the furnace at `cell` "in the middle of nowhere" - i.e. nothing PLAYER-built within
// radius 5? readBlock(x,y,z) -> block|null. ownCells: Set/array of "x,y,z" the bot placed. A
// STRUCTURE_RE hit disqualifies UNLESS it's (a) the furnace cell itself, (b) an own-remembered
// cell (bot's own camp table/chest), or (c) a torch (the bot lights its own smelt camps). Any
// other structure block (planks, door, wall, chest, another furnace...) => false, never touched.
// Offline-unit-testable with a fake reader (exported).
// (lonelyFurnace moved to provision-bank.js)

// STEP 10 body: reclaim up to 2 scattered field furnaces per pass (>KEEP_R and <=MAX_R from the
// hut). A bounded generalization of furnishHut's grab() - SAME primitives, NO new dig path:
// re-read blockAt at the cell, require name==='furnace' EXACTLY (a player blast_furnace never
// qualifies), toolForBlock('stone'), dig, collectDrops, forgetInfra. Eligibility is evaluated
// AFTER walking to the furnace (so the lonely-furnace structure scan reads LOADED blocks - a
// far furnace's chunk is unloaded and would scan blind; this is strictly safer than a pre-walk
// scan). Returns the count reclaimed.
// (consolidateFurnaces moved to provision-bank.js)

// STEP 11 body: walk to ONE far registered scaffold cluster within LITTER_PATROL_R of home and
// teardownVerified it. Registry-only + hut box excluded (alsoTrail OFF - the pathfix trail
// remembers build fabric near home). Reuses scaffold.teardownVerified UNMODIFIED (its own
// FILLER_RE re-read + canDigBlock + exclude gates). Returns blocks removed.
// (litterPatrol moved to provision-bank.js)

// ---- TREE FARMING (user-approved): the castle region is chopped bare, so the bot keeps
// its own wood supply alive like a player would - replant after every chop, fish saplings
// out of the leaves when it has none, and when the land is truly dry, plant a grove near
// home and let it grow instead of wandering 300 blocks into the night.
// (PLANTABLE_GROUND moved to provision-farm.js)
// (saplingFor moved to provision-farm.js)
// (saplingCount moved to provision-farm.js)

// Is this XZ inside the current build's keep-out box? (footprint + canopy margin,
// threaded down from autoBuild) - NEVER plant a future tree inside the castle.
// (inAvoidBox moved to provision-farm.js)

// Plant one sapling on open ground near `around` (a just-felled trunk or a grove cell).
// (plantSaplingNear moved to provision-farm.js)

// Bone-meal a planted sapling until it grows (or we run out) - turns the tree farm from
// "wait ~20 min per tree" into "instant tree" whenever skeletons have paid their dues.
// Crafts bone meal from bones on the fly (2x2 recipe, no table needed).
// (boneMealSapling moved to provision-farm.js)

// No saplings in the pack? Break a handful of this tree's leaves (natural only) and sweep
// the drops - oak leaves shed a sapling ~5% of the time, so 10-12 leaves is a fair shot.
// (fishSaplings moved to provision-farm.js)

// PREP one orchard cell at (cx, ~baseY, cz): find the ground, clear vegetation above it,
// shave natural bumps toward plot level, fill a shallow dip with dirt, and top non-soil
// with dirt. Returns the plantable ground block, or null.
// (prepOrchardCell moved to provision-farm.js)

// Level ONE plot cell toward baseY: clear soft cover, shave a bump (<=2, natural only),
// fill a 1-deep dip with dirt. The whole-plot flattening pass (operator review: "very
// uneven terrain, not a clean flat area") - each call is cheap when the cell's already flat.
// (levelPlotCell moved to provision-farm.js)

// Plant an ORCHARD: an even grid (5-block lanes) on prepped, level ground near - but
// never inside - the build's keep-out box. Operator spec: "a nice opening with flat
// ground, trees planted evenly so it's easy to navigate and use". Returns count planted.
// (plantGrove moved to provision-farm.js)

async function gatherLoop (bot, item, count, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const sources = GATHER_SOURCES[item]
  if (!sources) return { gathered: 0, reason: `don't know how to gather ${item}` }
  // some blocks drop NOTHING without the right tool - fail loudly, don't spin
  const reqTool = GATHER_TOOL[item] // e.g. cobblestone needs a pickaxe
  if (reqTool) {
    const kind = reqTool.split('_').pop() // 'pickaxe'
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name.endsWith('_' + kind))) {
      return { gathered: 0, reason: `need a ${kind} to mine ${sources[0]} (mining it bare-handed drops nothing)` }
    }
  }
  const ids = sources.map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(x => x != null)
  const toolKind = reqTool ? reqTool.split('_').pop() : null
  const haveReqTool = () => !toolKind || (bot.inventory ? bot.inventory.items() : []).some(i => i.name.endsWith('_' + toolKind))
  const start = countItem(bot, item)
  // Per-position failure blacklist. Without it a findable-but-unreachable block
  // (e.g. a trunk boxed in by leaves the pathfinder won't break) loops FOREVER:
  // find it -> can't path -> find the same block again. Verified live.
  const failed = new Map()
  const visitedMem = new Set() // remembered spots already tried this gather
  const pkey = p => `${p.x},${p.y},${p.z}`
  let mined = 0
  let exploreIdx = 0
  let dryExplores = 0 // consecutive explores that turned up nothing new
  let noYield = 0     // blocks mined lately with NO item gain (drops lost to gaps)
  let stripDug = 0    // times we've strip-mined DOWN this gather (bounded)
  let reachFails = 0  // consecutive "found stone but couldn't reach it" (buried -> strip-mine)
  let mineReentryTried = false // stone-relocate (#22): re-enter a known mine at most once per gather
  let saidNoStone = false      // stone-relocate: fire the "no stone up here" say at most once per gather
  let drownEscapes = 0 // consecutive water-escapes at this spot (abandon after a couple)
  let lastFoodHunt = 0 // throttle the survival-hunt so it doesn't chase every loop
  let lastShelter = 0  // throttle the night-shelter check
  const isLogGather = /_log$/.test(item) // logs get the natural-tree-only anti-grief filter
  // ORCHARD-FIRST (#50): before committing to far wild timber the pathfinder can't reach
  // (~264b treks, 33 reachFails - live), check our OWN renewable orchard ONCE per run.
  // ORCHARD_FIRST=0 restores today's behavior (no hoisted check, no re-arm, old latch).
  const ORCHARD_FIRST = process.env.ORCHARD_FIRST !== '0'
  // LOG reachfail cap (#50): abandon a doomed far grove after this many consecutive reach
  // failures instead of grinding it one 8s goto at a time. A large value -> today's behavior.
  const LOG_REACHFAIL_CAP = parseInt(process.env.LOG_REACHFAIL_CAP || '6', 10)
  const MAX_EXPLORE = 20 // wander this many times before truly giving up (48-block hops; 20 spans a real trek to the next biome)
  // ROAM FENCE: stay within maxRoam (XZ) of the build anchor so gathering CONVERGES back to
  // the site instead of drifting 150 blocks off chasing one more tree/cow. Stone is under
  // every point (strip-mine), so it gets a tight fence; logs a looser one. Env-overridable.
  const home = opts.home || { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }
  const MAX_ROAM = parseInt(process.env.GATHER_MAX_ROAM || (reqTool ? '64' : (isLogGather ? '160' : '96')), 10) // logs 96->160: the castle site sits in a treeless pocket wider than the old leash
  // The fence is ADAPTIVE: when this site's resource is genuinely inaccessible inside it
  // (verified live: stone under the site was a flooded aquifer - every shaft/dive aborted
  // on water), a player walks FURTHER. waterAborts/failed shafts widen it in +32 steps.
  let maxRoam = MAX_ROAM
  let waterAborts = 0
  let firstLoop = true // first iteration extends the fence over a far continuation start
  let orchardPlanted = false // orchard mode fires at most once per gather run
  let orchardHarvested = false // orchard-first harvest fires at most once per gather run
  let orchardTried = false // ORCHARD_FIRST (#50): the orchard is VISITED at most once per run (grown or not) - no ping-pong
  const widenFence = why => {
    if (maxRoam >= MAX_ROAM + 128) return
    maxRoam = Math.min(MAX_ROAM + 128, maxRoam + 32) // dry looks can ultimately reach ~288 blocks out
    dbg('  gather fence widened to', maxRoam, '(' + why + ')')
  }
  const distHome = () => Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z)
  // Is the roam anchor sitting ON the bot's own hut? Then it's UN-diggable (the apron/
  // structure no-dig guard refuses every shaft there). A strip gather anchored at the hut
  // used to bounce forever: strip out 28b -> shaft fails -> "return home to strip" -> hut
  // apron refuses -> wander out -> repeat, minutes of walking, mined=0 (verified live).
  // Knowing the anchor is un-diggable up front, we NEVER trek back to it to strip - we work
  // the ore field where we are instead.
  const homeUndiggable = listInfra('hut').some(h => Math.hypot(h.x - home.x, h.z - home.z) <= 6)
  if (homeUndiggable) dbg('  gather: anchor is on my hut (no-dig) - will strip the ore field, not trek back home')
  // ORE gather (iron/gold/copper/redstone/...): the target ore is DEEP, not at the
  // stone-just-under-grass layer. Iron in 1.18+ follows a triangular distribution that's
  // sparse above ~y48 and common toward y30; a 16-block depth cap floored strips at y50
  // where 16-block tunnels struck ZERO iron (verified live: 3 gearups, mined=0 across
  // y54-60). Ore gathers therefore dig DEEPER (down to the STRIP_FLOOR, still the hard
  // safety floor), run more shafts, and cut longer tunnels so a vein is actually hit.
  // (Hoisted above the deadline: a deep ore run needs the travel-class budget too.)
  const deepOre = sources.some(s => /_ore$/.test(s)) || /^raw_(iron|gold|copper)$|^(redstone|lapis_lazuli|diamond|emerald)$/.test(item)
  // Wall-clock deadline: even a legit strip-mine run must end (bounded so the BUILD phase runs).
  // Logs (the tool-chain ROOT) AND deep ore get extra travel headroom: a treeless base's nearest
  // woods (or a treeless base with only sparse-tail surface iron) can sit far off in ONE direction,
  // and the descent/directed sweep below needs time to walk out there and work before returning.
  // Other gathers keep the tighter budget so a build isn't stalled waiting on abundant material.
  const deadline = Date.now() + (opts.deadlineMs || Math.min(480000, (isLogGather || deepOre ? 300000 : 120000) + count * 4000))
  const timedOut = () => Date.now() > deadline
  // Whether this resource can be reached by digging DOWN (stone/ore under the surface).
  // Plains/grassland have none exposed, so instead of wandering forever we mine a shaft.
  const canStrip = sources.some(s => /stone|deepslate|cobble|granite|diorite|andesite|tuff|_ore$|ancient_debris/.test(s))
  // DEEP-FIRST ROUTING: for iron near the surface with only sparse-tail ore visible, route
  // straight to the organized branch mine instead of scratching unreachable surface candidates
  // (the ~1 iron/7min + hut-wedge live bug). branchTries caps the attempts so a site that can't
  // be descended (apron/water/lava) falls back to today's scratch/wander path (no wedge).
  const useBranch = deepOre && process.env.BRANCH_MINE !== '0'
  // STONE RELOCATE (#22): when a stone/cobble gather finds nothing exposed at the surface,
  // DESCEND to the stone layer (staircase / known-mine re-entry) instead of the blind wander.
  // Default ON; STONE_RELOCATE=0 restores today's digShaftDown-strip-then-wander path exactly.
  const STONE_RELOCATE = process.env.STONE_RELOCATE !== '0'
  let branchTries = 0
  const MAX_STRIP = deepOre ? 10 : 5 // shafts per gather before giving up (ore needs several to reach + work the deep levels)
  const NO_YIELD_LIMIT = 10 // mine-with-no-pickup before relocating to better ground
  const cap = count * 4 + 80 // ultimate backstop against grinding forever
  // Depth cap for MINING (tool-required) gathers: chasing exposed stone down into a
  // cave/ravine strands the bot (can't climb ~30 blocks back). Track the highest
  // ground we've stood on and never target stone/ore more than MAX_MINE_DEPTH below
  // it, so mining stays near the surface. Surface resources (logs/dirt) are exempt.
  // Anchor to the PERSISTENT surface (passed from the build/provision run) if we have
  // it, NOT the current position - else each batch re-anchors to wherever we ended up
  // (often already deep from a failed climb-out) and the depth cap slides down with us,
  // ratcheting the bot toward lava (verified live: sank to y4 on deepslate). Only ever
  // moves UP (Math.max), never down.
  let surfaceY = opts.surfaceY != null ? opts.surfaceY : bot.entity.position.y
  // Generous enough to reach hillside/plateau-edge stone, tight enough to refuse the
  // 30+ block dive into a cave/ravine that stranded the bot.
  // ABSOLUTE floor: never mine/dig below this Y, so a runaway descent can't reach the
  // deep lava layer no matter what. Well above 1.21 lava pockets. (Defined before the
  // depth cap so ore gathers can key their reach off it.)
  const STRIP_FLOOR = parseInt(process.env.STRIP_FLOOR_Y || '30', 10)
  // Ore digs to the STRIP_FLOOR (iron territory); everything else stays near the surface.
  const MAX_MINE_DEPTH = deepOre
    ? Math.max(16, Math.floor(surfaceY) - STRIP_FLOOR)
    : parseInt(process.env.GATHER_MAX_DEPTH || '16', 10)
  const belowCap = y => (reqTool && y < surfaceY - MAX_MINE_DEPTH) || y <= STRIP_FLOOR
  // How far we may still safely dig DOWN from here before hitting the depth cap or the
  // absolute floor. <=0 means "already deep enough - do NOT dig, climb out instead".
  // This is what stops the ratchet: even a failed climb-out can't make it sink further.
  const stripBudget = () => {
    const y = Math.floor(bot.entity.position.y)
    return Math.min(6, y - (surfaceY - MAX_MINE_DEPTH), y - STRIP_FLOOR)
  }

  // DIRECTED OUTWARD SWEEP for surface resources that must be TRAVELLED to (logs above all;
  // also any non-tool, non-strippable gather). GROUNDED LIVE: the roomba `explore` fans 48-block
  // hops out from the CURRENT spot with rotating bearings, so within the time budget it only
  // reaches ~110-120 blocks from home before the give-up/deadline bites - LESS than the log fence
  // (160) and short of the exact live blocker (a treeless base whose nearest woods are ~150 blocks
  // off toward spawn). The wood never got found and the whole tool chain (hoe/table/bed) stalled.
  // This sweep instead COMMITS to compass bearings and walks an expanding octagon spiral anchored
  // at HOME: the bearing rotates 45 deg each leg and the radius grows every full lap, so every
  // direction is pushed to the fence edge in re-scanned legs and timber anywhere inside the fence
  // is actually walked to. Mining/ore is unaffected (it strip-mines DOWN, canStrip below).
  const wantsTravel = isLogGather || (!reqTool && !canStrip)
  // 8 bearings walked as an ADJACENT octagon ring (E,SE,S,SW,W,NW,N,NE): consecutive legs are
  // only 45 deg apart so each is a short ~0.75x-reach hop around the ring - the most travel-
  // efficient way to visit every direction (a max-spread order like E-then-W turns each leg
  // into a full-diameter crossing and is far slower). 8 (not 4) dirs so adjacent rays overlap
  // the 64-block re-scan even at the fence edge.
  const SWEEP_DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  let sweepLeg = 0
  async function sweepTowardTimber () {
    const lap = Math.floor(sweepLeg / 8)
    // Sample the OUTER band FIRST, not a slow crawl out from the middle: timber that forces a
    // travel-gather sits near the fence edge (that's WHY we're roaming), and with the 64-block
    // re-scan a ring at ~0.6x the fence covers the whole fence in ONE 8-bearing lap. GROUNDED:
    // a first ring at reach 64 only detected timber within ~128 of home and burned the budget
    // before a second lap could reach ~150-block woods (live 0/2). Grows as widenFence pushes
    // the fence out on dry looks; stays just inside it so the loop-top fence-return can't fight it.
    const reach = Math.min(maxRoam - 8, 96 + lap * 44)
    const [dx, dz] = SWEEP_DIRS[sweepLeg % 8]
    const n = Math.hypot(dx, dz) || 1
    const tx = Math.round(home.x + (dx / n) * reach)
    const tz = Math.round(home.z + (dz / n) * reach)
    const from = bot.entity.position.clone()
    dbg('  gather timber-sweep leg=' + sweepLeg + ' bearing=' + (sweepLeg % 8) + ' reach=' + reach + ' -> ' + tx + ',' + tz)
    // walkStaged LOOPS 48-block sub-legs toward the target, retrying past a nudge/pit recovery
    // so it actually TRAVELS (a single navigateTo returns the instant it "recovers via nudge"
    // and never leaves home on pit-prone sand - grounded live, moved=false every leg). Bounded
    // per leg so a wedged direction can't hang the sweep; the re-scan happens at the gather loop
    // top after the leg. On a genuinely stuck leg walkStaged bails via its own stall detector.
    await walkStaged(bot, tx, tz, { isStopped, range: 6, timeoutMs: 45000 })
    sweepLeg++
    return bot.entity.position.distanceTo(from) > 8
  }

  // Surface to breathe when air runs low - mining near/into water otherwise drowns
  // us (verified live: the bot drowned mid-cobble-run in cratered savanna, losing
  // the whole provisioning run). Jumping swims us upward toward air.
  async function breathe () {
    if ((bot.oxygenLevel ?? 20) >= 8) return
    const deadline = Date.now() + 8000
    try {
      while ((bot.oxygenLevel ?? 20) < 16 && Date.now() < deadline && !isStopped()) {
        bot.setControlState('jump', true)
        await new Promise(r => setTimeout(r, 200))
      }
    } finally { bot.setControlState('jump', false) }
  }

  // Break one block: walk in reach, equip the right tool, dig. Returns true/throws.
  async function breakBlock (blk) {
    await breathe()
    if ((bot.oxygenLevel ?? 20) < 4) throw new Error('too deep underwater - surfacing') // never drown for a block
    if (bot.entity.position.distanceTo(blk.position) > 4.2) {
      // Budget 15000->8000: a reachable ore is walked to in well under 8s; the extra 7s was
      // pure standing-still on an UNPATHABLE spot (exposure-filtered now, but a face can seal
      // between scan and dig). On a timeout/no-path failure BLACKLIST the spot immediately
      // (failed=2) - the 2-try allowance is for transient dig failures, not "no route exists",
      // and retrying a doomed goto is exactly the ~50s/block churn we're killing.
      try {
        await gotoWithTimeout(bot, new goals.GoalNear(blk.position.x, blk.position.y, blk.position.z, 2), 8000)
      } catch (e) {
        if (/timed out|no ?path/i.test(e && e.message)) failed.set(pkey(blk.position), 2)
        throw e
      }
    }
    if (bot.entity.position.distanceTo(blk.position) > 5.5) throw new Error('out of reach')
    const tool = toolForBlock(bot, blk.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(blk)) throw new Error('cannot dig from here')
    // FLUID-FACE re-probe right before the dig (water flows between the candidate scan and now):
    // if breaking this block would open a fluid onto us, ABORT rather than crack the aquifer.
    // Scoped to the stone/ore path (logs are above-ground - a shore trunk isn't a flood risk).
    if (!isLogGather) {
      const nb = [blk.position.offset(1, 0, 0), blk.position.offset(-1, 0, 0), blk.position.offset(0, 0, 1), blk.position.offset(0, 0, -1), blk.position.offset(0, 1, 0), blk.position.offset(0, -1, 0)]
        .map(q => { const b = bot.blockAt(q); return b ? b.name : null })
      const hz = mining.digExposureHazard(nb)
      if (hz === 'water') throw new Error('water face - not opening the aquifer')
      if (hz === 'lava') throw new Error('lava face - not opening the lava')
    }
    bot.pathfinder.setGoal(null) // a lingering goal lets the pathfinder steer mid-dig and ABORT it (dig-restart loops, operator report)
    await bot.dig(blk)
    mined++
  }

  // MID-MINE COMBAT SURVIVAL: the ONE reaction to a hostile that closes (or hp crashing)
  // while mining. The dig loops bail to here; the gather loop polls it first each pass. Deep
  // underground -> RETREAT UP to the surface (climbToSurface: bounded, walls a staircase as
  // it goes, the only mob-safe escape from a shaft). Already at/near the surface, or hp
  // critical -> BAIL the whole gather so isBusy clears and the full flee/defend/shelter
  // reflexes (which are useless mid-dig) take over. Returns 'bail' | 'up' | false.
  let threatReacts = 0
  let recoverTries = 0            // hp-recover attempts this run (separate budget from threatReacts)
  let recoverSaid = false         // the status say fires at most once per runGather
  const RECOVER_ON = process.env.GATHER_HP_RECOVER !== '0' // flag off -> today's bail-on-low-hp verbatim
  // #53 NAKED_IRON_GRACE: a naked bot may grab a FEW already-found iron ore before it retreats,
  // so a threatened dive nets a couple iron instead of zero and can bootstrap boots. SAFETY-bounded
  // by arbiter.nakedGraceAllowed (hp floor, no-melee, <=GRACE_ORE). Flag off -> today's byte-for-byte.
  const NAKED_GRACE_ON = process.env.NAKED_IRON_GRACE !== '0'
  const GRACE_HP_FLOOR = parseInt(process.env.NAKED_GRACE_HP_FLOOR || '10', 10) // well above the hp-critical 6
  const GRACE_ORE = parseInt(process.env.NAKED_GRACE_ORE || '3', 10)            // hard cap on grabs per react
  const GRACE_MELEE = 2.5   // a mob this close -> react now, no grab (don't tank a hit naked)
  const GRACE_REACH = 4     // only ore ALREADY within ~4b (never a new/deeper search)
  const NAKED_ORE_RE = /^(raw_iron|iron_ore|deepslate_iron_ore)$/ // the iron-bootstrap ore only
  let graceSaid = false     // the naked-grace status say fires at most once per runGather
  async function surviveMiningThreat () {
    if (!mineDanger(bot)) return false
    threatReacts++                // count EVERY break-out exactly as today (climb budget byte-for-byte)
    const hp = bot.health ?? 20
    const feetY = Math.floor(bot.entity.position.y)
    const deep = feetY < Math.floor(surfaceY) - 3 && hasSolidCeiling(bot, 12, { ignoreLeaves: true })
    const hostileNear = nearHostile(bot, 6)
    // ONE authority classifies the break-out. mineDanger stays as sensitive as ever; this only
    // decides the RESPONSE. Every hostile/deep/critical case is today's 'up'/'bail'; the sole new
    // case (hurt, no hostile, on the surface) is 'recover' - eat + heal here, then keep gathering.
    let decision = arbiter.mineThreatDecision({ hp, hostileNear, deep, threatReacts, recoverTries }, {})
    if (decision === 'recover' && !RECOVER_ON) decision = 'bail' // flag off -> today's response
    // NEW: RECOVER-AND-RESUME. No threat, hp in (6,12), on the surface: the livelock. Instead of
    // bailing into a loop that can never end (hp<12 forever, food<18 -> never regens), eat to
    // comfortable, run the food chain only if the pack is bare, then hold for regen - then the
    // caller's `if (react) continue` re-polls and gathering resumes once hp is back up. Bounded.
    if (decision === 'recover') {
      recoverTries++
      dbg('  gather RECOVER #' + recoverTries + ' (hp=' + hp.toFixed(1) + ', food=' + (bot.food ?? 20) + ') - no threat, eating and healing before resuming')
      if (opts.say && !recoverSaid) { recoverSaid = true; opts.say('banged up - taking a breather to heal before i keep gathering') }
      try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
      // 1) eat what we carry (cook raw first) - food 14 -> >=18 starts natural regen. Fixes the live case.
      try { await eatFromPackToComfortable(bot, isStopped) } catch (e) { dbg('  gather recover: eat failed (' + e.message + ')') }
      // 2) only if still low AND the pack is bare, run the ONE food chain (canHold:false - a mid-gather
      //    pause is not the food<=1 boundedHold mechanism; the starving branch below keeps its canHold).
      if ((bot.food ?? 20) < 18 && !hasFood(bot)) {
        try { await secureFood(bot, { isStopped, say: opts.say || (() => {}), home, avoid: opts.avoid, canHold: false }) } catch (e) { dbg('  gather recover: secureFood failed (' + e.message + ')') }
      }
      // 3) hold-and-heal (eats again, night-rests behind cover if dark/mob<=16, <=3min, honest false).
      //    Its _recoveringHp latch makes this mutually exclusive with the index.js hp-crisis reflex.
      try { await recoverHp(bot, { isStopped, say: opts.say }) } catch (e) { dbg('  gather recover: recoverHp failed (' + e.message + ')') }
      return 'recovered'
    }
    // NAKED IRON GRACE (#53): a naked bot about to climb/bail on a threat grabs a FEW already-found
    // iron ore FIRST, so the dive nets a couple iron instead of zero (the keystone that bootstraps
    // boots). Bounded by arbiter.nakedGraceAllowed: NAKED + iron-ore gather + hp>GRACE_HP_FLOOR(10)
    // + NO mob in melee(~2.5b) + <GRACE_ORE(3) grabbed. Re-checks hp/melee/isStopped between EACH
    // break; only breaks ore ALREADY within ~4b (never a new/deeper search). Then falls straight
    // through to today's exact climb/bail below. Flag off / armored / non-iron -> byte-for-byte.
    if (NAKED_GRACE_ON) {
      const naked = armorPieceCount(bot) === 0
      const isOre = NAKED_ORE_RE.test(item)
      let grabbed = 0
      while (arbiter.nakedGraceAllowed(
        { naked, isOre, hp: bot.health ?? 20, hostileMelee: nearHostile(bot, GRACE_MELEE), oreGrabbed: grabbed },
        { enabled: true, graceHpFloor: GRACE_HP_FLOOR, graceOre: GRACE_ORE })) {
        if (isStopped()) break
        let ore = bot.findBlock({ matching: ids, maxDistance: GRACE_REACH }) // ALREADY next to us
        if (ore && belowCap(ore.position.y)) ore = null // never chase ore DOWN, only what's at reach
        if (!ore) break // nothing already in front of us -> fall to today's climb/bail
        try { await breakBlock(ore) } catch (e) { dbg('  gather naked-grace: grab failed (' + e.message + ')'); break }
        grabbed++
      }
      if (grabbed > 0) {
        try { await collectDrops(bot, 6) } catch {}
        dbg('  gather naked-grace grabbed ' + grabbed + ' ore before retreating (hp=' + (bot.health ?? 20).toFixed(1) + ')')
        if (opts.say && !graceSaid) { graceSaid = true; opts.say('grabbing the iron in front of me before i pull back') }
      }
    }
    dbg('  gather THREAT while mining #' + threatReacts + ' (hp=' + hp.toFixed(1) + ', hostile<=6=' + hostileNear + ', deep=' + deep + ') - reacting')
    // HONESTY: only claim "mob on me" when there actually IS a mob within 6 - an hp-only bail on
    // the surface says nothing (the loop already reports its bail reason).
    if (opts.say && hostileNear && threatReacts <= 2) opts.say('mob on me down here - breaking off to get clear')
    try { bot.pathfinder && bot.pathfinder.setGoal(null) } catch {}
    // DEEP: retreat UP (the staircase walls behind us as we climb, shedding the chasers) -
    // this is the mob-safe escape and the ONLY thing that reliably gets us out of a shaft.
    // Each climb is awaited (no busy-spin). After a few scares this run the spot is a
    // deathtrap - stop climbing and bail. SHALLOW (near/at surface): bail straight away so
    // the un-gated flee/defend/shelter reflexes (useless mid-dig) finally take over.
    if (decision === 'up') {
      try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch (e) { dbg('  gather threat: climb-out failed (' + e.message + ')') }
      return 'up'
    }
    // Distinguish the exhausted-recovery bail (hurt, no hostile, surface, recovery used up) from
    // the mob/critical bail so the reason line is honest and greppable. Only when the flag is on.
    if (RECOVER_ON && !hostileNear && !deep && hp > 6) return 'bail-hurt'
    return 'bail'
  }

  let lastBeat = 0 // throttled trace heartbeat - the LAST line before a hang names the branch
  while (countItem(bot, item) - start < count) {
    // SURVIVAL FIRST: a cave mob closing (or hp crashing) mid-mine gets reacted to BEFORE
    // any more digging - the death-carousel was naked gearup mining standing in a shaft at
    // 1hp because it never broke off. Deep -> climb out; surface/critical -> yield the gather.
    {
      const react = await surviveMiningThreat()
      if (react === 'bail') return { gathered: countItem(bot, item) - start, reason: 'broke off mining to survive a mob / low hp - getting to safety' }
      if (react === 'bail-hurt') return { gathered: countItem(bot, item) - start, reason: 'too hurt to keep gathering and could not recover here - backing off' }
      if (react) continue
    }
    // DROWNING FIRST (before/outside the !hasSolidCeiling gate below - a flooded tunnel HAS a
    // ceiling, exactly when the open-air gate skips): head underwater means the last dig opened
    // an aquifer under us. STOP the dig, drop the pathfinder goal (so it can't re-stomp the
    // manual escape) and hand the body to the bounded escapeWater. On success keep gathering;
    // if we keep ending up wet HERE, the spot is a pond edge - abandon it, not drown for it.
    {
      const dn = survivalNeed(bot, { foodThreshold: 6 })
      if (dn && dn.need === 'drowning') {
        dbg('  gather: DROWNING (' + dn.reason + ') - stopping the dig and escaping the water')
        if (opts.say && drownEscapes === 0) opts.say('dug into water - getting out before i drown')
        try { bot.stopDigging() } catch {}
        try { bot.pathfinder.setGoal(null) } catch {}
        const out = await navigate.escapeWater(bot, { isStopped })
        if (out) { drownEscapes = 0; continue }
        if (++drownEscapes >= 2) return { gathered: countItem(bot, item) - start, reason: 'kept ending up underwater here - abandoning this spot' }
        continue
      }
    }
    // CREEPER/THREAT beyond mineDanger's 6m reach: surviveMiningThreat (nearHostile 6 / hp<12)
    // never feels a creeper closing at 6-12m until it's point-blank. Consult the ONE authority
    // each iteration and, on a creeper/threat SURVIVE need out in the OPEN (not deep - deep keeps
    // its climb-out via surviveMiningThreat), BAIL the gather so isBusy clears and the body-side
    // flee/back-off reflex (useless mid-dig) takes over. foodThreshold 6 so a food dip doesn't bail
    // here (the secureFood branch below owns hunger). Mirrors branchMine's start-gate/mineDanger.
    if (!hasSolidCeiling(bot, 12, { ignoreLeaves: true })) {
      const need = survivalNeed(bot, { foodThreshold: 6 })
      if (need && (need.need === 'creeper' || need.need === 'threat' || need.need === 'heal')) {
        dbg('  gather: SURVIVE need (' + need.need + ' - ' + need.reason + ') in the open - breaking off so the flee/heal reflex can react')
        if (opts.say) opts.say(need.need === 'heal' ? 'too hurt to keep gathering - breaking off to shelter and heal' : 'creeper closing - breaking off to get clear')
        return { gathered: countItem(bot, item) - start, reason: 'broke off gathering to ' + (need.need === 'heal' ? 'shelter and heal' : 'avoid a ' + need.need) + ' - getting clear' }
      }
    }
    if (Date.now() - lastBeat > 5000) {
      lastBeat = Date.now()
      const p = bot.entity.position.floored()
      dbg('  gather', item, (countItem(bot, item) - start) + '/' + count, 'pos=' + p.x + ',' + p.y + ',' + p.z, 'mined=' + mined, 'dry=' + dryExplores, 'strip=' + stripDug, 'reachFails=' + reachFails, 'distHome=' + Math.round(distHome()))
    }
    if (isStopped()) return { gathered: countItem(bot, item) - start, reason: 'stopped' }
    if (timedOut()) return { gathered: countItem(bot, item) - start, reason: 'out of time - building with what i have' }
    // A round that CONTINUES far from home (autoBuild no longer forces the commute) begins
    // outside the fence BY DESIGN - cover the starting spot once, or the first iteration
    // walks halfway home and undoes the continuation (operator: "WHY the shuttling?????").
    if (firstLoop) { firstLoop = false; const d0 = distHome(); if (d0 + 48 > maxRoam) { maxRoam = Math.ceil(d0 + 48); dbg('  gather fence extended to ' + maxRoam + ' (round continues ' + Math.round(d0) + 'b out)') } }
    // ROAM FENCE: drifted too far from the build site -> walk back inside the fence before
    // scanning again, so the gather converges to the site instead of wandering off for good.
    if (distHome() > maxRoam) {
      dbg('  gather fence-return: distHome=' + Math.round(distHome()) + ' > ' + maxRoam)
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(home.x, home.z, Math.round(maxRoam * 0.5)), 30000) } catch {}
      dryExplores++
      if (dryExplores >= MAX_EXPLORE) return { gathered: countItem(bot, item) - start, reason: `gathered ${countItem(bot, item) - start}/${count} near the site` }
    }
    // SURVIVAL: starving with nothing to eat -> break off and hunt an animal for meat
    // (auto-eat feeds on it). Body-side because during a build the BRAIN is held and can't
    // do this; a long gather in a food-poor area otherwise runs the bot to 0 food / 1 hp
    // with no way back. Throttled so it doesn't chase every loop.
    // NEVER hunt when rest is due: roaming for animals in the dark at 1hp is how it died
    // at 479,67,85 (a sealed pit is safe at ANY hunger - starvation stops at half hearts;
    // a night hunt doesn't). The night-rest check below runs first via this guard.
    // #40 F3.1: trigger the in-loop secureFood EARLIER (FOOD_SURVIVAL: food<=12 with an empty
    // pack, vs the legacy <=6) so a busy, packless bot breaks off ~2 min from zero instead of
    // ~90s - and it fires even when the scheduler tick chain is stalled (this hook lives inside
    // the gather loop). Same 20s throttle + _securingFood latch keep it bounded. FOOD_SURVIVAL=0
    // -> foodSec.inLoopFoodTrigger resolves to 6, i.e. today's needsFood(bot) exactly.
    if (foodSec.inLoopFoodTrigger(bot.food, hasFood(bot)) && !nightRestWanted(bot) && Date.now() - lastFoodHunt > 20000) {
      lastFoodHunt = Date.now()
      if (opts.say) opts.say('starving - sorting out food before i keep working')
      dbg('  gather food (food=' + bot.food + ') -> secureFood')
      // The ONE food chain: eat -> bank -> cook -> hunt -> farm -> fish -> scout -> hold.
      // (This replaces the old inline hunt/farm/fish copy - one policy, one owner.)
      try { await secureFood(bot, { isStopped, say: opts.say || (() => {}), home, avoid: opts.avoid, canHold: true }) } catch (e) { dbg('  secureFood failed (' + e.message + ')') }
      dbg('  gather food done (foodItems=' + foodCount(bot) + ', food=' + bot.food + ')')
    }
    // OPPORTUNISTIC: a food animal is RIGHT THERE and the pack is light - take the free
    // meal before hunger ever forces a detour (operator ask). Close range only (<=12), so
    // it never wanders off-task chasing dinner; the reactive hunt above covers real need.
    // Threshold 15 (operator-set): keep a deep larder - the creeper death started at 0 food.
    if (!needsFood(bot) && foodCount(bot) < 15 && Date.now() - lastFoodHunt > 30000 && !isStopped()) {
      const snack = Object.values(bot.entities || {}).some(e => e && e.position &&
        /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test((e.name || '').toLowerCase()) &&
        e.position.distanceTo(bot.entity.position) <= 12)
      if (snack) {
        lastFoodHunt = Date.now()
        dbg('  gather opportunistic hunt (foodItems=' + foodCount(bot) + ')')
        // an EMPTY pantry needs a batch, not a bite - one raw kill gets eaten on the
        // spot and the larder never rebuilds (watched live: hand-to-mouth at 9hp)
        const kills = foodCount(bot) <= 2 ? 3 : 1
        try { for (let k = 0; k < kills && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped })) break } } catch { /* keep gathering */ }
        // cook the haul if a furnace is in reach - cooked meat feeds 3x raw
        try { if (foodCount(bot) >= 2) await cookRawMeat(bot, { isStopped }) } catch {}
      }
    }
    // SHELTER: naked at night with a hostile bearing down -> dig in and wait it out. A sealed
    // pit survives a creeper where fleeing didn't (it died to one, unarmed, mid-gather). Only
    // when actually threatened + under-armored, so it doesn't burrow every night for nothing.
    if (nightRestWanted(bot) && Date.now() - lastShelter > 15000) {
      lastShelter = Date.now()
      dbg('  gather night-rest (timeOfDay=' + (bot.time && bot.time.timeOfDay) + ')')
      // NAKED: this BLOCKS until day (rest failure must never mean "keep working in the
      // dark"). Armored near the bed: one sleep attempt, then work on if it can't.
      if (underArmored(bot)) { try { await restUntilSafe(bot, { isStopped, say: opts.say }) } catch {} }
      else { try { await nightRest(bot, { isStopped, say: opts.say }) } catch {} }
      dbg('  gather night-rest done (timeOfDay=' + (bot.time && bot.time.timeOfDay) + ')')
      continue // morning (or interrupted) - rescan from wherever the night left us
    }
    // INVENTORY HYGIENE: junk drops crowd out the material we're gathering - toss them
    // once slots run low (keeps bones for the tree farm + a rotten-flesh famine reserve).
    if (bot.inventory && bot.inventory.emptySlotCount() < 4) { try { await dumpJunk(bot) } catch {} }
    if (!haveReqTool()) return { gathered: countItem(bot, item) - start, reason: `my ${toolKind} broke` } // ran out mid-job
    if (mined >= cap) { await collectDrops(bot, 12); if (countItem(bot, item) - start < count) return { gathered: countItem(bot, item) - start, reason: `mined ${mined} blocks but couldn't collect enough (drops lost?)` } }

    surfaceY = Math.max(surfaceY, bot.entity.position.y) // highest ground we've stood on
    const feetY = Math.floor(bot.entity.position.y)
    // ORCHARD-FIRST (#50, ORCHARD_FIRST): before the candidate scan can lock onto far wild
    // timber the pathfinder can't reach, check our OWN renewable orchard ONCE per run. If
    // world-mem has a READY (harvestReadyAt reached) + NEAR orchard, walk there and harvest our
    // trees first. Visited <=1/run via orchardTried (no ping-pong). Grown -> harvest + renew;
    // not grown -> re-arm the grow timer (never stranded ripe) and fall through to the wild scan.
    // ORCHARD_FIRST=0 -> this whole arm is skipped (byte-for-byte today).
    if (ORCHARD_FIRST && isLogGather && !orchardTried) {
      const orch = loadWorldMem().orchard
      const GROW_MS = parseInt(process.env.ORCHARD_GROW_MS || String(10 * 60000), 10)
      const now = Date.now()
      const ready = orch && orch.harvestReadyAt != null && now >= orch.harvestReadyAt
      if (orch && ready && Math.hypot(orch.x - home.x, orch.z - home.z) <= maxRoam + 40) {
        orchardTried = true // attempted the walk - don't return to the orchard again this run
        dbg('  gather ORCHARD-first (hoisted): grove at ' + orch.x + ',' + orch.z + ' ready - harvesting my own trees before the wild')
        if (opts.say) opts.say('my orchard should be grown - harvesting my own trees first')
        try { await walkStaged(bot, orch.x + 5, orch.z + 5, { isStopped, range: 8, timeoutMs: 90000 }) } catch {}
        // bone-meal any still-short saplings so the walk isn't wasted (forces an instant harvest)
        if (countItem(bot, 'bone_meal') > 0) {
          const sapId = (mcData.blocksByName[saplingFor(item)] || {}).id
          const saps = sapId != null ? (bot.findBlocks({ matching: sapId, maxDistance: 24, count: 8 }) || []) : []
          for (const sp of saps.slice(0, 6)) { if (isStopped()) break; try { await boneMealSapling(bot, sp) } catch {} }
        }
        const grown = (bot.findBlocks({ matching: ids, maxDistance: 24, count: 8 }) || []).some(p => isWildTreeLog(bot, p))
        if (grown) {
          orchardHarvested = true
          const mm = loadWorldMem(); if (mm.orchard) { mm.orchard.at = now; mm.orchard.harvestReadyAt = now + GROW_MS; saveWorldMem() } // renewed: regrow before the next visit
          dbg('  gather ORCHARD-first (hoisted): grown logs present - rescanning to chop them')
          continue
        }
        // Not grown on arrival: DON'T permanently disable - push the grow timer forward so it is
        // never stranded ripe forever, then fall through to the normal wild scan.
        const mm = loadWorldMem(); if (mm.orchard) { mm.orchard.harvestReadyAt = now + GROW_MS; saveWorldMem() }
        dbg('  gather ORCHARD-first (hoisted): not grown yet on arrival - re-armed grow timer, falling through to the wild')
      }
    }
    // WEDGE TARGET FILTER (water-wedge escape, Change C): stop re-picking a site that just
    // wedged us. listWedges is already own-infra-suppressed on both record and recall, so a
    // wedge near home can never poison our own resources; the decay ages a spot back in.
    const wedges = process.env.WEDGE_TARGET_FILTER !== '0' ? listWedges() : []
    let candidates = bot.findBlocks({ matching: ids, maxDistance: 64, count: 32 })
      .filter(p => (failed.get(pkey(p)) || 0) < 2)
      // Never target a dig that would OPEN A FLUID onto us. Logs (above-ground, shore trees are
      // fine) keep the cheap water-ABOVE check; every other gather - the stone/ore SHALLOW path
      // where the pond-aquifer drowning happened - probes all 6 neighbours (incl. below), so
      // wet-adjacent ore is skipped and falls through to branchMine's organized y16 descent
      // (which has its own descentSafety/faceHazard). Dry ground: every neighbour is 'ok' - no-op.
      .filter(p => {
        if (isLogGather) { const a = bot.blockAt(p.offset(0, 1, 0)); return !(a && /water/i.test(a.name)) }
        const nb = [p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1), p.offset(0, 1, 0), p.offset(0, -1, 0)]
          .map(q => { const b = bot.blockAt(q); return b ? b.name : null })
        if (mining.digExposureHazard(nb) !== 'ok') return false
        // EXPOSURE (the mining-throughput root fix): only target ore with an open face. Ore
        // EMBEDDED in solid rock is unreachable by the anti-grief mining profile, so goto'ing
        // at it stands still until a silent timeout (~1 block/50s churn). Embedded ore is
        // skipped here and falls through to branchMine's organized descent. Reuses the 6
        // neighbour names already read for the fluid probe above - no extra world reads.
        return mining.faceExposed(nb)
      })
      // Don't chase stone/ore deep below the surface (cave-descent stranding). AT DEPTH, allow
      // same-level tunnel-wall ore (>= feetY-1) so a deep branch-mine can still work the walls
      // it exposes; STRIP_FLOOR still governs digging DOWN, and candidates never sit above feet.
      .filter(p => !belowCap(p.y) || (deepOre && p.y >= feetY - 1))
      // ANTI-GRIEF: logs must be NATURAL trees (never a village house / log build); every
      // OTHER gather (stone/dirt/sand/...) must not be right next to a player structure, so a
      // cobble/dirt run near a base can't dismantle a wall or crater a yard.
      .filter(p => isLogGather ? isWildTreeLog(bot, p) : !structureNearby(bot, p, 3))
      // ROAM FENCE: ignore targets outside the fence so a distant block can't lure the bot
      // out (findBlocks reaches ~64 past the bot). Strip-mining supplies stone inside the fence.
      .filter(p => Math.hypot(p.x - home.x, p.z - home.z) <= maxRoam + 8)
      // Skip any candidate within 8b of a live wedge (the waterlogged tree that froze us):
      // the scan falls through to the next tree / timber-sweep exactly like "no candidates".
      .filter(p => !routeMem.wedgeNearXZ(wedges, p, 8))
    // ORCHARD MODE (operator rule): grinding one tree per chunk wastes the day. Sparse
    // area (about one tree visible) + a real sapling stock + a big remaining need ->
    // plant a 16-tree orchard near the site RIGHT NOW (don't wait for total dryness) and
    // keep hunting while it grows; revisits bone-meal it into a mass harvest.
    if (isLogGather && !orchardPlanted && candidates.length > 0 && candidates.length < 8 &&
        (count - (countItem(bot, item) - start)) >= 24 && saplingCount(bot, item) >= 6 && !isStopped()) {
      orchardPlanted = true
      // ONE orchard per site per growth cycle: the flag resets each round, and every
      // round was re-walking the grid to plant into already-occupied cells (live, 3x).
      const orch = loadWorldMem().orchard
      if (orch && Math.hypot(orch.x - home.x, orch.z - home.z) <= 60 && Date.now() - orch.at < 40 * 60000) {
        dbg('  orchard already growing near home (planted ' + Math.round((Date.now() - orch.at) / 60000) + ' min ago) - not replanting')
        continue
      }
      dbg('  sparse woods (' + candidates.length + ' logs visible) + ' + saplingCount(bot, item) + ' saplings - planting an ORCHARD near home')
      if (opts.say) opts.say('these scattered trees are a waste of time - planting my own orchard by the site')
      try { await plantGrove(bot, home, item, { isStopped, say: opts.say, avoid: opts.avoid, max: 16 }) } catch (e) { dbg('  orchard failed (' + e.message + ')') }
      continue
    }
    // Underground (we strip-mined down), mine HORIZONTALLY, not straight down: a block
    // AT foot/head level drops cobble at our feet to auto-collect; mining the floor
    // drops it into the pit below and loses it (verified: got 1 cobble in 90s digging
    // down). Prefer targets at/above feet; only fall to lower ones if there are none.
    if (feetY < surfaceY - 1) {
      const level = candidates.filter(p => p.y >= feetY && p.y <= feetY + 2)
      if (level.length) candidates = level
    }
    // AT DEPTH, don't burn the budget scratch-pathing far cave-wall ore. When we're already
    // down a mine and every exposed candidate is >~16b away, drop them so the no-target route
    // below RE-ENTERS branchMine (which skips the descent when already at level and continues
    // its persisted corridor from the tip). branchTries/MAX_STRIP/deadline bound the re-entries.
    if (deepOre && candidates.length &&
        !mining.scratchWorthy(feetY, surfaceY, candidates.map(p => Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z)))) {
      dbg('  gather at-depth: nearest exposed ore >16b - back to branchMine instead of scratch-pathing')
      candidates = []
    }
    // DEEP-FIRST: at/near the surface with only sparse-tail iron visible (or none), don't
    // scratch the unreachable surface candidate - go STRAIGHT to the organized branch mine.
    // Capped at 2 tries: if we can't sink/enter a mine here (apron/water/lava), the guard
    // stops firing and the surface scratch/wander path below takes over (no wedge).
    if (useBranch && branchTries < 2 && mining.preferBranchMine(item, feetY, surfaceY, candidates.map(p => p.y))) {
      const need = count - (countItem(bot, item) - start)
      const r = await branchMine(bot, item, need, { isStopped, home, surfaceY, say: opts.say, avoid: opts.avoid, dirIdx: stripDug, deadlineMs: Math.max(20000, deadline - Date.now()) })
      dbg('  gather deep-first branchMine -> ' + JSON.stringify(r)); stripDug++
      if (r.gathered > 0) { dryExplores = 0; noYield = 0; continue }
      branchTries++
      continue
    }
    const target = candidates[0] && bot.blockAt(candidates[0])
    if (!target) {
      // Nothing reachable here - grab any nearby drops first.
      await collectDrops(bot, 12)
      // STRIP-MINE: for stone/ore, there may be none EXPOSED (plains) - dig our own
      // shaft down to the stone layer instead of wandering, then re-scan (the shaft
      // walls are now reachable stone). Bounded, and only while safely above bedrock.
      if (canStrip && stripDug < MAX_STRIP && (stripBudget() > 0 || useBranch)) {
        if (useBranch) {
          // ORGANIZED BRANCH MINE for deep ore: ONE descent to the iron band (~y16) + a
          // torch-lit corridor with perpendicular branches - far more ore per hole than the
          // old scattered N-shaft "mole" strip, and back-out-able. Owns its own descent/depth
          // (not gated by stripBudget/belowCap). Falls through to relocate/wander if it can't
          // even sink an entrance (apron/water/lava). BRANCH_MINE=0 restores the old strip.
          const need = count - (countItem(bot, item) - start)
          const r = await branchMine(bot, item, need, { isStopped, home, surfaceY, say: opts.say, avoid: opts.avoid, dirIdx: stripDug, deadlineMs: Math.max(20000, deadline - Date.now()) })
          dbg('  gather branchMine -> ' + JSON.stringify(r)); stripDug++
          if (r.gathered > 0) { dryExplores = 0; noYield = 0; continue }
        } else {
          // STONE RELOCATE (task #22): the surface here has no exposed stone, and a 6-block strip
          // can bottom out still in dirt (deep-soil terrain) -> DESCEND to the stone layer (or
          // re-enter a known mine) instead of scratching / standing still and then wandering.
          // Reuses the descent primitives, bounded shallow (<=12 treads); runGather's finally
          // climbs us back out. STONE_RELOCATE=0 -> only the legacy strip below runs (byte-for-byte).
          if (STONE_RELOCATE && !deepOre && mining.preferStoneDescend(item, feetY, surfaceY, candidates.map(p => p.y))) {
            // 1) FREE STONE: re-enter a remembered mine's exposed walls (at most once per gather).
            if (!mineReentryTried) {
              mineReentryTried = true
              const known = recallMine(bot, bot.entity.position, 48)
              if (known && !isStopped()) {
                dbg('  gather stone-relocate: re-entering a known mine at ' + known.x + ',' + known.z + ' for exposed stone')
                if (await enterExistingMine(bot, known, { isStopped })) { dryExplores = 0; continue }
                dbg('  gather stone-relocate: mine re-entry failed - descending a fresh staircase')
              }
            }
            // 2) DESCEND a walkable staircase to the stone layer (step off the apron first).
            if (opts.say && !saidNoStone) { saidNoStone = true; opts.say(`no ${sources[0]} up here - digging down to reach it`) }
            if (await stepOffApron(bot, { isStopped, home, tag: 'stone-descend' })) {
              const tY = mining.stoneDescendTargetY(surfaceY, { hardFloor: STRIP_FLOOR })
              const y0 = Math.floor(bot.entity.position.y)
              dbg('  gather stone-relocate: staircase to y' + tY + ' (from y' + y0 + ') for cobble')
              // digStaircaseDown probes each tread (descentSafety/#41 lava-safe), refuses player
              // blocks, bails on mineDanger, and collects its own drops - the treads yield the cobble.
              const r = await digStaircaseDown(bot, tY, { isStopped, dirIdx: stripDug, stopWhen: () => (countItem(bot, item) - start) >= count })
              dbg('  gather stone-relocate: staircase -> ' + JSON.stringify(r))
              if (Math.floor(bot.entity.position.y) < y0) { stripDug++; dryExplores = 0; continue } // descended -> loop-top rescan sees the stone walls; while-cond exits when count is met
              dbg('  gather stone-relocate: no descent (entrance blocked) - falling through to the legacy strip')
            } else {
              dbg('  gather stone-relocate: could not step off the apron - falling through to the legacy strip/wander')
            }
          }
          if (opts.say && stripDug === 0 && !saidNoStone) opts.say(`no ${sources[0]} up here - digging down to reach it`)
          dbg('  gather strip-shaft #' + stripDug + ' budget=' + stripBudget() + ' at y=' + Math.floor(bot.entity.position.y))
          const dug = await digShaftDown(bot, stripBudget(), { isStopped, home })
          dbg('  gather strip-shaft dug=' + dug)
          if (dug > 0) { const got = await mineTunnel(bot, item, deepOre ? 24 : 16, stripDug, { isStopped }); dbg('  gather tunnel got=' + got); stripDug++; dryExplores = 0; continue } // count only SUCCESSFUL shafts
        }
        // Couldn't dig down here (water/void/lava underfoot - e.g. a riverbed at the fence
        // edge). Normally head back to the build SITE (dry ground the operator chose) and
        // strip-mine THERE. BUT if the anchor is our own hut (un-diggable), trekking back
        // just bounces off the apron guard - sidestep to fresh ground and strip here instead.
        if (homeUndiggable && distHome() > 6) {
          const off = { x: bot.entity.position.x + (bot.entity.position.x >= home.x ? 6 : -6), z: bot.entity.position.z + (bot.entity.position.z >= home.z ? 6 : -6) }
          dbg('  gather shaft-failed off-home (hut anchor no-dig) - sidestepping to ' + Math.round(off.x) + ',' + Math.round(off.z) + ' to strip here, not trekking back')
          try { await gotoWithTimeout(bot, new goals.GoalNearXZ(off.x, off.z, 2), 12000) } catch {}
          continue
        }
        if (distHome() > 6) { dbg('  gather shaft-failed: returning home to strip there (distHome=' + Math.round(distHome()) + ')'); try { await gotoWithTimeout(bot, new goals.GoalNearXZ(home.x, home.z, 4), 30000) } catch {}; continue }
        dbg('  gather shaft-failed AT home - falling through to wander')
        widenFence('cannot shaft down at home') // water/void right under the site - hunt further out
        // already at home and STILL can't dig down -> fall through to wandering
      } else if (canStrip && stripBudget() <= 0 && Math.floor(bot.entity.position.y) < surfaceY - 3) {
        // already at the depth cap but no reachable stone -> we're stuck deep (a cave
        // fall or tapped-out shaft). Bail so runGather's climb-out gets us back up.
        return { gathered: countItem(bot, item) - start, reason: 'mined out down here - climbing back up' }
      }
      // WANDER to fresh terrain.
      if (dryExplores >= MAX_EXPLORE) {
        // Wood truly dry out here? Don't just give up - bank what we hold as a GROVE near
        // home so the next round has trees growing where the bot already works. (This is
        // the tree farm's seed step; grown trees are found by the normal scan next visit.)
        if (isLogGather && saplingCount(bot, item) > 0 && !isStopped()) {
          try { await plantGrove(bot, home, item, { isStopped, say: opts.say, avoid: opts.avoid }) } catch (e) { dbg('  grove planting failed (' + e.message + ')') }
          return { gathered: countItem(bot, item) - start, reason: `no ${sources.join('/')} left standing nearby - planted a grove by the site, it needs time to grow` }
        }
        return { gathered: countItem(bot, item) - start, reason: `searched far and wide, no reachable ${sources.join('/')}` }
      }
      // ORCHARD FIRST (renewable supply): before trekking to wild timber, if we planted a grove
      // and it has had time to grow (or we carry bone_meal to force it), walk to it and harvest
      // our OWN trees. The plot is ours but isWildTreeLog still passes (planted trees have canopy,
      // no structure) so the anti-grief filter is unchanged. Fires once per gather; on grown logs
      // we `continue` and the loop-top scan finds + chops them (existing replant keeps it stocked).
      if (isLogGather && !orchardHarvested && !(ORCHARD_FIRST && orchardTried)) {
        const orch = loadWorldMem().orchard
        const GROW_MS = parseInt(process.env.ORCHARD_GROW_MS || String(10 * 60000), 10)
        const mature = orch && (Date.now() - (orch.at || 0) > GROW_MS || countItem(bot, 'bone_meal') > 0)
        if (orch && mature && Math.hypot(orch.x - home.x, orch.z - home.z) <= maxRoam + 40) {
          if (ORCHARD_FIRST) orchardTried = true // count this as the <=1 orchard visit/run (shared with the hoisted arm)
          else orchardHarvested = true // flag off: today's latch (set BEFORE the grown check) - byte-for-byte
          dbg('  gather ORCHARD-first: grove at ' + orch.x + ',' + orch.z + ' mature (' + Math.round((Date.now() - (orch.at || 0)) / 60000) + ' min) - harvesting my own trees before the wild')
          if (opts.say) opts.say('my orchard should be grown - harvesting my own trees first')
          try { await walkStaged(bot, orch.x + 5, orch.z + 5, { isStopped, range: 8, timeoutMs: 90000 }) } catch {}
          // bone-meal any still-short saplings so the walk isn't wasted (forces an instant harvest)
          if (countItem(bot, 'bone_meal') > 0) {
            const sapId = (mcData.blocksByName[saplingFor(item)] || {}).id
            const saps = sapId != null ? (bot.findBlocks({ matching: sapId, maxDistance: 24, count: 8 }) || []) : []
            for (const sp of saps.slice(0, 6)) { if (isStopped()) break; try { await boneMealSapling(bot, sp) } catch {} }
          }
          const grown = (bot.findBlocks({ matching: ids, maxDistance: 24, count: 8 }) || []).some(p => isWildTreeLog(bot, p))
          if (grown) {
            if (ORCHARD_FIRST) orchardHarvested = true // LATCH-BUG FIX: disable the orchard for the run only AFTER a confirmed harvest
            const mm = loadWorldMem(); if (mm.orchard) { mm.orchard.at = Date.now(); mm.orchard.harvestReadyAt = Date.now() + GROW_MS; saveWorldMem() } // renewed: let it regrow before the next visit
            dbg('  gather ORCHARD-first: grown logs present - rescanning to chop them')
            continue
          }
          // Not grown: flag on -> re-arm the grow timer so a missed/early arrival never strands it ripe forever.
          if (ORCHARD_FIRST) { const mm = loadWorldMem(); if (mm.orchard) { mm.orchard.harvestReadyAt = Date.now() + GROW_MS; saveWorldMem() } }
          dbg('  gather ORCHARD-first: not grown yet on arrival - falling through to the wild')
        }
      }
      // WORLD MEMORY first: walk to a remembered source before wandering blind. Memory
      // deliberately overrides the roam fence - a known resource IS the reason to leave.
      const memSpot = recallSpot(item, bot.entity.position, visitedMem)
      // NEAR RING BEFORE A FAR MEMORY TREK: a naked bot at a treeless-nearby base has only FAR
      // (~320b) exhausted memories; the loop-top findBlocks(64) can't see fresh timber ~100b out.
      // Sweeping one octagon lap FIRST finds the near timber (rememberSpot records a NEAR spot that
      // out-scores the far ones forever); if the near ring is genuinely dry it falls straight
      // through to the far trek exactly as before. Bounded to one lap (sweepLeg<8); orchards and
      // near memories (<=NEAR from home) are trekked, not deferred.
      const NEAR = parseInt(process.env.WOOD_NEAR || '140', 10)
      if (isLogGather && memSpot && !memSpot.orchard && Math.hypot(memSpot.x - home.x, memSpot.z - home.z) > NEAR && sweepLeg < 8) {
        dbg('  gather NEAR-first: memory spot ' + memSpot.x + ',' + memSpot.z + ' is ' + Math.round(Math.hypot(memSpot.x - home.x, memSpot.z - home.z)) + 'b out (>' + NEAR + ') - sweeping the near ring first (leg ' + sweepLeg + ')')
        await sweepTowardTimber()
        dryExplores++
        continue
      }
      if (memSpot) {
        // Don't let a remembered spot lure us back onto a live wedge either: rest-cool it
        // (recallSpot honors spot.rest, provision.js) and re-plan, same as the growing-grove case.
        if (routeMem.wedgeNearXZ(wedges, memSpot, 8)) {
          dbg('  gather: remembered spot ' + memSpot.x + ',' + memSpot.z + ' is on a live wedge - resting it 30 min and re-planning')
          memSpot.rest = Date.now() + 30 * 60000; saveWorldMem(); continue
        }
        visitedMem.add(memSpot.x + ',' + memSpot.z)
        if (opts.say && dryExplores === 0) opts.say(`i remember ${sources[0]} over by ${memSpot.x},${memSpot.z} - heading there`)
        dbg('  gather heading to remembered spot ' + memSpot.x + ',' + memSpot.z + ' (hits ' + (memSpot.hits || 1) + ')')
        // The memory doesn't just justify LEAVING the fence - it justifies WORKING out
        // there. Extend the fence to cover the spot, or the loop-top fence-return drags
        // us straight home on arrival and the next iteration treks out again (verified
        // live: castle<->340,256 ping-pong, 0 logs gained).
        const dSpot = Math.hypot(memSpot.x - home.x, memSpot.z - home.z)
        if (dSpot + 48 > maxRoam) { maxRoam = Math.ceil(dSpot + 48); dbg('  gather fence extended to ' + maxRoam + ' (covers remembered spot)') }
        await walkStaged(bot, memSpot.x, memSpot.z, { isStopped, range: 8, timeoutMs: 150000 })
        // Judge the spot by what the miner will actually TOUCH: village-house logs pass a
        // raw block scan but fail the wild-tree filter, so a chopped-out spot next to a
        // village never dropped and kept luring the bot back (verified live, 0-log tours).
        const minable = (bot.findBlocks({ matching: ids, maxDistance: 24, count: 8 }) || [])
          .some(p => !isLogGather || isWildTreeLog(bot, p))
        // A GROWING grove counts as alive: saplings we (or anyone) planted here are the
        // reason to return. Bone-meal them on the spot if we're carrying bones - that
        // turns a revisit into an instant harvest.
        let growing = []
        if (!minable && isLogGather) {
          const sapId = (mcData.blocksByName[saplingFor(item)] || {}).id
          growing = sapId != null ? (bot.findBlocks({ matching: sapId, maxDistance: 24, count: 6 }) || []) : []
          for (const sp of growing.slice(0, 4)) { if (isStopped()) break; try { await boneMealSapling(bot, sp) } catch {} }
          // Still just saplings (no bones to force them)? COOLDOWN the spot ~8 min - trees
          // need time, and re-touring a nursery every round was half the shuttling.
          const nowMinable = (bot.findBlocks({ matching: ids, maxDistance: 24, count: 4 }) || []).some(p => isWildTreeLog(bot, p))
          if (!nowMinable && growing.length) { memSpot.rest = Date.now() + 8 * 60000; saveWorldMem(); dbg('  remembered spot is a GROWING grove - resting it 8 min') }
        }
        if (!minable && !growing.length) {
          // Before deleting: the SPOT may be dry while the FOREST it marked continues
          // deeper in (verified live: it ate the edge of the big woods at 567,304, the
          // 24-block re-scan missed the mass 30 blocks deeper, and the hard-drop deleted
          // its only pointer to the forest). Probe wider and MIGRATE the spot inward.
          const deeper = (bot.findBlocks({ matching: ids, maxDistance: 48, count: 8 }) || [])
            .filter(p => !isLogGather || isWildTreeLog(bot, p))
          if (deeper.length) {
            memSpot.x = Math.round(deeper[0].x); memSpot.z = Math.round(deeper[0].z); memSpot.at = Date.now(); saveWorldMem()
            dbg('  remembered spot edge is eaten - MIGRATING it deeper to ' + memSpot.x + ',' + memSpot.z)
          } else { dbg('  remembered spot is DRY on arrival (no minable ' + item + ') - dropping it'); forgetSpot(item, memSpot, true) }
        }
        continue // rescan from here; not a dry look
      }
      if (opts.say && dryExplores === 0) opts.say(`looking further afield for ${sources[0]}...`)
      // The fence only widened for flooded STONE - a site picked clean of wood kept the
      // bot pacing a barren 96-block circle while whole forests sat just outside it
      // (verified live: every log round died in ~2 min of dry looks). Dry looks now
      // widen the fence for ANY resource, so it walks to the next forest like a player.
      if (dryExplores > 0 && dryExplores % 3 === 0) widenFence(dryExplores + ' dry looks for ' + sources[0])
      // ROOMBA: this cell was searched and found empty - remember that, and steer the
      // next leg toward ground we HAVEN'T swept (negative memory, cleared by replanting).
      markSearched(item, bot.entity.position)
      // Surface resources (logs first) do the DIRECTED outward sweep - commit to a bearing and
      // push to the fence edge, re-scanning each leg - so timber ~150 blocks off in one direction
      // is actually reached. Everything else keeps the roomba explore (stone falls here only after
      // a failed strip and is best served by the negative-memory roomba near the site).
      let moved
      if (wantsTravel) {
        moved = await sweepTowardTimber()
        dbg('  gather timber-sweep moved=' + moved)
      } else {
        dbg('  gather explore #' + dryExplores)
        moved = await explore(bot, exploreIdx++, home, maxRoam, (x, z) => isSearchedDry(item, x, z))
        dbg('  gather explore moved=' + moved)
      }
      dryExplores++
      continue
    }
    dryExplores = 0 // found something within range

    const before = countItem(bot, item)
    try { await breakBlock(target) } catch (e) {
      failed.set(pkey(target.position), (failed.get(pkey(target.position)) || 0) + 1)
      reachFails++
      if (reachFails <= 3 || reachFails % 5 === 0) dbg('  gather breakBlock fail #' + reachFails + ' at ' + target.position.toString() + ': ' + e.message)
      if (/underwater|water face/.test(e.message) && ++waterAborts >= 3) { widenFence('approaches flooded'); waterAborts = 0 }
      // LOG REACHFAIL CAP (#50, LOG_REACHFAIL_CAP): a far wild grove we can SEE but the pathfinder
      // can't reach (across water / under canopy) used to be ground one doomed 8s goto at a time
      // with NO abandon (live: reachFails=33, distHome=264, ~4 min burned). Once the cap trips,
      // abandon it: demote the far wood-memory spot so it stops re-anchoring the scan (root #2),
      // drop the fence back to base, and give the local orchard one more shot (orchardTried=false)
      // before falling back near. Logs only; a large cap -> never trips -> today's behavior.
      if (isLogGather && reachFails >= LOG_REACHFAIL_CAP) {
        const d = Math.round(distHome())
        const spots = loadWorldMem()[item] || []
        const farSpot = spots.find(sp => Math.hypot(sp.x - bot.entity.position.x, sp.z - bot.entity.position.z) < 24 && Math.hypot(sp.x - home.x, sp.z - home.z) > MAX_ROAM)
        if (farSpot) forgetSpot(item, farSpot, true) // demote/migrate so recall skips this doomed far grove
        maxRoam = MAX_ROAM // undo any widen a stale far spot pulled the fence out to
        orchardTried = false // re-check the local orchard next iteration (it may have grown)
        reachFails = 0
        dbg('  gather ' + item + ': reachfail-cap ' + LOG_REACHFAIL_CAP + ' hit at distHome=' + d + ' - abandoning far grove, falling back to orchard/near')
        continue
      }
      // Stone is FOUND but we keep failing to reach it -> it's buried (plains): the
      // path can't dig dirt to get there. Strip-mine straight down to it instead of
      // grinding through dozens of doomed gotos, then re-scan from inside the stone.
      if (canStrip && reachFails >= 3 && stripDug < MAX_STRIP && stripBudget() > 0) {
        if (opts.say && stripDug === 0) opts.say(`the ${sources[0]} is all buried - digging down to it`)
        dbg('  gather buried-strip #' + stripDug + ' budget=' + stripBudget() + ' at y=' + Math.floor(bot.entity.position.y))
        // APRON GUARD: on our own hut apron digShaftDown always returns 0. The old code
        // then did stripDug++ ANYWAY, so buried ore near the hut burned the whole shaft
        // budget in seconds (verified live: stripDug 0->10 in 6s, all dug=0, then stranded
        // deep with a spent budget). Step to diggable ground first, and DON'T charge it.
        if (onHutApron(bot) || insideOwnStructure(bot)) {
          const off = { x: bot.entity.position.x + (bot.entity.position.x >= home.x ? 10 : -10), z: bot.entity.position.z + (bot.entity.position.z >= home.z ? 10 : -10) }
          dbg('  gather buried-strip on my hut apron - sidestepping to ' + Math.round(off.x) + ',' + Math.round(off.z) + ' (not burning shaft budget)')
          try { await gotoWithTimeout(bot, new goals.GoalNearXZ(off.x, off.z, 2), 12000) } catch {}
          reachFails = 0; continue
        }
        // Deep ore: run the ORGANIZED BRANCH MINE (one descent + branches) here too, so a
        // buried-ore trigger doesn't fall back to the scattered-shaft mole pattern either.
        if (deepOre && process.env.BRANCH_MINE !== '0') {
          const need = count - (countItem(bot, item) - start)
          const r = await branchMine(bot, item, need, { isStopped, home, surfaceY, say: opts.say, avoid: opts.avoid, dirIdx: stripDug, deadlineMs: Math.max(20000, deadline - Date.now()) })
          dbg('  gather buried branchMine -> ' + JSON.stringify(r)); stripDug++
          reachFails = 0; continue
        }
        const dug = await digShaftDown(bot, stripBudget(), { isStopped, home })
        // COUNT ONLY SUCCESSFUL SHAFTS (mirrors the strip-shaft path): a dug=0 shaft made
        // no descent, so charging it against MAX_STRIP just exhausts the budget uselessly.
        if (dug > 0) { const got = await mineTunnel(bot, item, deepOre ? 24 : 16, stripDug, { isStopped }); dbg('  gather buried-strip dug=' + dug + ' tunnel got=' + got); stripDug++ }
        else { dbg('  gather buried-strip dug=0 - fresh ground'); const off = { x: bot.entity.position.x + 6, z: bot.entity.position.z + 6 }; try { await gotoWithTimeout(bot, new goals.GoalNearXZ(off.x, off.z, 2), 10000) } catch {} }
        reachFails = 0
      }
      continue
    }
    reachFails = 0 // reached one - reset the buried-stone counter
    rememberSpot(item, target.position) // world memory: this place yields this resource
    // Mine the LOCAL cluster (adjacent same-type blocks) so we stay put and drops
    // land at our feet for proximity pickup - works for both trees and stone.
    let cur = bot.findBlock({ matching: ids, maxDistance: 4 })
    if (cur && belowCap(cur.position.y)) cur = null // don't descend via the cluster either
    let n = 0
    while (cur && n < 8 && countItem(bot, item) - start < count && haveReqTool()) {
      if (isStopped() || mineDanger(bot)) break // a mob closed mid-cluster -> back to the survival check at the loop top
      try { await breakBlock(cur) } catch { failed.set(pkey(cur.position), (failed.get(pkey(cur.position)) || 0) + 1); break }
      n++
      cur = bot.findBlock({ matching: ids, maxDistance: 4 })
      if (cur && belowCap(cur.position.y)) cur = null
    }
    await collectDrops(bot, 8) // sweep up what the cluster dropped
    // TREE FARM: keep the forest alive - fish a sapling out of the leaves if the pack has
    // none, then put one back where the trunk stood. A player who replants never runs dry.
    if (isLogGather && n > 0 && !isStopped()) {
      try {
        if (saplingCount(bot, item) < 1) await fishSaplings(bot, target.position, item, { isStopped })
        await plantSaplingNear(bot, target.position, item, { avoid: opts.avoid })
        await cleanupScaffold(bot, target.position, { isStopped }) // no abandoned dirt towers (operator rule)
      } catch (e) { dbg('  replant skipped (' + e.message + ')') }
    }

    // Lost-drop detection: we broke blocks but gained NO items - drops are falling
    // into gaps/void here (verified live: mining a platform edge lost every cobble).
    // Blacklist this spot and relocate to fresh ground rather than grind it dry.
    if (countItem(bot, item) === before) {
      failed.set(pkey(target.position), 2)
      noYield += n + 1
      if (noYield >= NO_YIELD_LIMIT) { await explore(bot, exploreIdx++, home, maxRoam, (x, z) => isSearchedDry(item, x, z)); noYield = 0 }
    } else { noYield = 0 }
  }
  return { gathered: countItem(bot, item) - start, reason: 'done' }
}

// Ensure a crafting table is reachable: use a nearby one (WALKING to it - a found-but-
// unpathable table is useless), or craft + place one right here. A roamy strip-mine
// routinely ends 20-40 blocks from the plan's own table across torn-up ground the
// anti-grief profile can't path ("No path to the goal!" killed the furnace craft twice,
// live) - so reach failures fall through to building a FRESH table where we stand.
async function ensureTable (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const tableId = mcData.blocksByName.crafting_table.id
  const reach = async (t) => {
    if (bot.entity.position.distanceTo(t.position) <= 3) return true
    // Through the UNIFIED navigator (not a raw goto): a table INSIDE our hut is unplannable
    // through a closed door, so the nav's door pre-flight crosses first. Tight at-base budgets.
    try { await navigate.navigateTo(bot, new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 0, nudge: 1, stepout: 1 }, label: 'table-reach' }); return true } catch (e) { dbg('  ensureTable: cannot reach table at', t.position.toString(), '-', e.message); return false }
  }
  let table = bot.findBlock({ matching: tableId, maxDistance: 16 }) // `let`: the place path below reassigns it
  if (table && await reach(table)) { rememberInfra('table', table.position); return table }
  if (!table) { // none close - check further out (the plan's table from before the roam)
    const far = bot.findBlock({ matching: tableId, maxDistance: 48 })
    if (far && await reach(far)) { rememberInfra('table', far.position); return far }
  }
  // Beyond loaded chunks: a table we REMEMBER placing may be a short walk away - reuse it
  // rather than littering a new one every roam (operator complaint: tables everywhere).
  const known = await recallAndReach(bot, 'table', tableId, 64, reach)
  if (known) { rememberInfra('table', known.position); return known }
  // No reachable table -> place/craft a fresh one HERE (pack table, or 4 planks).
  if (countItem(bot, 'crafting_table') === 0) {
    const def = mcData.itemsByName.crafting_table
    const recipe = bot.recipesFor(def.id, null, 1, null)[0]
    if (!recipe) throw new Error('cannot craft a crafting table (need 4 planks)')
    await bot.craft(recipe, 1, null)
  }
  // BELIEVABILITY: at the hut, put the SINGLE working table on a valid interior floor cell
  // (reachable through the door), like the chest/furnace. Falls back to the local spot search.
  const insideTable = await placeStationInInterior(bot, 'table', 'crafting_table', { hut: opts.home, isStopped: opts.isStopped })
  if (insideTable) return insideTable
  // place it on solid ground next to us
  const findSpot = () => {
    const b = bot.entity.position.floored()
    for (let r = 1; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx === 0 && dz === 0) continue
          for (const dy of [0, -1, 1]) { // slope-tolerant: a hillside ring has no cell at OUR exact y
            const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1 + dy, b.z + dz))
            const above = bot.blockAt(new Vec3(b.x + dx, b.y + dy, b.z + dz))
            if (ground && ground.boundingBox === 'block' && above && REPLACEABLE.test(above.name)) return ground
          }
        }
      }
    }
    return null
  }
  let ref = findSpot()
  if (!ref && opts.home) {
    // Nowhere here (e.g. up in a jungle canopy - leaves aren't placeable-into). Walk back
    // to the home anchor (the build site is cleared, real ground) and look again there.
    dbg('  ensureTable: no spot here (y=' + Math.floor(bot.entity.position.y) + ') - heading home to place')
    try { await gotoWithTimeout(bot, new goals.GoalNearXZ(opts.home.x, opts.home.z, 4), 30000) } catch {}
    ref = findSpot()
  }
  if (!ref) throw new Error('nowhere to place a crafting table')
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'crafting_table')
  await bot.equip(item, 'hand')
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
  await bot.placeBlock(ref, new Vec3(0, 1, 0))
  table = bot.findBlock({ matching: tableId, maxDistance: 8 })
  if (!table) throw new Error('placed a table but cannot find it')
  rememberInfra('table', table.position) // it's OURS now - future crafts come back here
  return table
}

// Craft `count` result items of `item` (walks to / places a table when needed).
async function runCraft (bot, item, count, needsTable, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const def = mcData.itemsByName[item]
  if (!def) throw new Error(`unknown item ${item}`)
  let table = null
  if (needsTable) {
    table = await ensureTable(bot, opts)
    if (bot.entity.position.distanceTo(table.position) > 3) {
      await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000)
    }
  }
  const before = countItem(bot, item)
  // INV_CRAFTROOM: never craft past free space (vanilla drops output that won't fit - the live
  // 147-plank spill). Make room if desperate, then CAP the count to what fits; a genuinely full
  // pack fails the task HONESTLY (runPlan handles task errors) instead of spilling on the ground.
  const invCraftRoom = process.env.INV_DISCIPLINE !== '0' && process.env.INV_CRAFTROOM !== '0'
  if (invCraftRoom) {
    const maintain = require('./maintain.js')
    let free = bot.inventory ? bot.inventory.emptySlotCount() : 36
    if (free <= 1) { try { free = await require('./resources.js').ensurePackRoom(bot, 4, { near: opts.home }) } catch {} }
    const reserve = Number(process.env.INV_CRAFT_RESERVE_SLOTS || 1)
    const cap = maintain.craftBudgetForSpace(count, bot.inventory ? bot.inventory.emptySlotCount() : free, def.stackSize || 64, reserve)
    if (cap === 0) throw new Error(`no pack room to craft ${item}`)
    if (cap < count) { dbg(`  capped ${item} craft to ${cap}/${count} (free slots)`); count = cap }
  }
  // Craft ONE recipe per call with a settle delay. Batching (craft(recipe, 11))
  // desyncs the client inventory - verified live: 11 logs "became" 96 planks of
  // which most were GHOSTS that vanished on the next real server slot-update.
  let guard = count * 2 + 8 // hard stop so a non-converging count can't loop forever
  while (countItem(bot, item) - before < count && guard-- > 0) {
    // INV_CRAFTROOM belt-and-braces: a mid-craft fill (drops from earlier iterations landing)
    // must not spill - bail with what we made so far (runPlan re-plans the shortfall).
    if (invCraftRoom && bot.inventory && bot.inventory.emptySlotCount() === 0) return countItem(bot, item) - before
    const recipe = bot.recipesFor(def.id, null, 1, table)[0]
    if (!recipe) throw new Error(`no craftable recipe for ${item} (missing ingredients?)`)
    try { await bot.craft(recipe, 1, table) } catch (e) {
      if (!/windowOpen/.test(e.message || '')) throw e
      // Paper sometimes never opens the table window (same transient as openFurnace) -
      // re-approach and retry once before failing the whole craft (live: camp chest)
      dbg('  craft windowOpen timeout - re-approaching the table for one retry')
      if (table) { try { await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 15000) } catch {} }
      await bot.craft(recipe, 1, table)
    }
    await new Promise(r => setTimeout(r, 250)) // let the server's slot updates land
  }
  const made = countItem(bot, item) - before
  if (made < count) throw new Error(`crafting stalled: made ${made}/${count} ${item}`)
  // TAKE YOUR TABLE WITH YOU: a field-craft far from home leaves a table in the middle
  // of nowhere (operator complaint). If this table is OURS (infra registry) and we're
  // far from the home anchor, break it and pocket it - next field craft places it from
  // the pack. The home-area table stays put (it's the workshop).
  if (table && opts.home && Math.hypot(table.position.x - opts.home.x, table.position.z - opts.home.z) > 64) {
    const ours = recallInfra('table', table.position, 3)
    if (ours) {
      try {
        const tool = toolForBlock(bot, 'oak_planks') // any axe speeds it; bare hand works
        if (tool) await bot.equip(tool, 'hand').catch(() => {})
        await bot.dig(bot.blockAt(table.position))
        await collectDrops(bot, 4)
        forgetInfra('table', ours)
        dbg('  packed up my field crafting table (' + table.position.toString() + ')')
      } catch (e) { dbg('  could not pack up field table (' + e.message + ')') }
    }
  }
  return made
}

// Place one block of `itemName` from inventory on solid ground nearby.
// Returns the Vec3 where the new block landed.
// A cell counts as OPEN if it's air OR replaceable vegetation (placing into grass
// replaces it, like a player does) - requiring exactly 'air' made every table/furnace/
// chest placement fail in grassy savanna ("nowhere to place a crafting table").
// (REPLACEABLE moved to provision-core.js)
async function placeFromInventory (bot, itemName) {
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === itemName)
  if (!item) throw new Error(`no ${itemName} to place`)
  const b = bot.entity.position.floored()
  let ref = null
  for (let r = 1; r <= 4 && !ref; r++) {
    for (let dx = -r; dx <= r && !ref; dx++) {
      for (let dz = -r; dz <= r && !ref; dz++) {
        if (dx === 0 && dz === 0) continue
        for (const dy of [0, -1, 1]) { // slope-tolerant (same rationale as ensureTable's findSpot)
          if (ownHutAt({ x: b.x + dx, y: b.y + dy, z: b.z + dz })) continue // never clutter the hut interior (3 furnaces on the bedroom floor, live)
          const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1 + dy, b.z + dz))
          const above = bot.blockAt(new Vec3(b.x + dx, b.y + dy, b.z + dz))
          if (ground && ground.boundingBox === 'block' && above && REPLACEABLE.test(above.name)) { ref = ground; break }
        }
      }
    }
  }
  if (!ref) throw new Error('no open ground to place on')
  await bot.equip(item, 'hand')
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
  await bot.placeBlock(ref, new Vec3(0, 1, 0))
  return ref.position.offset(0, 1, 0)
}

// Ensure a furnace is reachable: find a nearby one (WALKING to it - same rationale as
// ensureTable: found-but-unpathable is useless), or craft (8 cobblestone at a table) +
// place one. Returns the furnace block.
async function ensureFurnace (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const furnaceId = mcData.blocksByName.furnace.id
  const reach = async (f) => {
    if (bot.entity.position.distanceTo(f.position) <= 3) return true
    try { await gotoWithTimeout(bot, new goals.GoalNear(f.position.x, f.position.y, f.position.z, 2), 30000); return true } catch (e) { dbg('  ensureFurnace: cannot reach furnace at', f.position.toString(), '-', e.message); return false }
  }
  let furnace = bot.findBlock({ matching: furnaceId, maxDistance: 12 })
  if (furnace && await reach(furnace)) { rememberInfra('furnace', furnace.position); return furnace }
  // Reuse a furnace we REMEMBER before smelting 8 more cobble into a new one. fix #13: widen
  // the recall envelope 64->96 (env FURNACE_RECALL_R) when consolidating so a smelt within
  // ~96 of any remembered furnace walks to it instead of littering a fresh one; flag off => 64.
  const recallR = process.env.INFRA_CONSOLIDATE !== '0' ? Number(process.env.FURNACE_RECALL_R || 96) : 64
  const knownF = await recallAndReach(bot, 'furnace', furnaceId, recallR, reach)
  if (knownF) { rememberInfra('furnace', knownF.position); return knownF }
  if (countItem(bot, 'furnace') === 0) {
    const table = await ensureTable(bot, opts)
    if (bot.entity.position.distanceTo(table.position) > 3) await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000)
    const recipe = bot.recipesFor(mcData.itemsByName.furnace.id, null, 1, table)[0]
    if (!recipe) throw new Error('cannot craft a furnace (need 8 cobblestone)')
    await bot.craft(recipe, 1, table)
    await new Promise(r => setTimeout(r, 250))
  }
  // BELIEVABILITY: the SINGLE working furnace goes INSIDE the hut on a valid interior floor
  // cell (reachable through the door), like the chest/table - never through a wall. Bulk
  // parallel-smelt furnaces (ensureFurnaces) stay on the outdoor utility pad. Falls back to
  // local placement when not at the hut.
  const inside = await placeStationInInterior(bot, 'furnace', 'furnace', { hut: opts.home, isStopped: opts.isStopped })
  if (inside) return inside
  await placeFromInventory(bot, 'furnace')
  furnace = bot.findBlock({ matching: furnaceId, maxDistance: 8 })
  if (!furnace) throw new Error('placed a furnace but cannot find it')
  rememberInfra('furnace', furnace.position, { own: true }) // fix #13: genuine placement => own-tagged
  return furnace
}

// How many distinct furnace BLOCKS stand near the bot (for planProvision's
// opts.furnacesNearby - placed furnaces are reused, never re-bought as 8 cobble).
function countFurnacesNear (bot, maxDistance = 16) {
  try {
    const md = require('minecraft-data')(bot.version)
    const id = md.blocksByName.furnace.id
    const seen = new Set()
    for (const p of bot.findBlocks({ matching: id, maxDistance, count: 8 }) || []) seen.add(`${p.x},${p.y},${p.z}`)
    return seen.size
  } catch { return 0 }
}

// Ensure up to `n` furnaces near us (find existing, craft+place the deficit). Returns
// 1..n POSITIONS (Vec3 - Block objects go stale across window opens; re-resolve with
// blockAt at each visit). Never throws for a deficit - degrades to what it achieved;
// throws only if ZERO furnaces are possible (via the proven ensureFurnace fallback).
// The old version failed silently (no dbg, break-on-everything, re-scan races) and
// built 0 furnaces live - every exit here is logged and placements are VERIFIED.
async function ensureFurnaces (bot, n, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const furnaceId = mcData.blocksByName.furnace.id
  const found = []
  const seen = new Set()
  for (const p of bot.findBlocks({ matching: furnaceId, maxDistance: 12, count: 8 }) || []) {
    const k = `${p.x},${p.y},${p.z}`
    if (!seen.has(k) && found.length < n) { seen.add(k); found.push(p.clone ? p.clone() : new Vec3(p.x, p.y, p.z)) }
  }
  dbg('  ensureFurnaces want=' + n + ' found=' + found.length + ' furnaceItems=' + countItem(bot, 'furnace'))
  // SMELT BANK PLACEMENT: extra furnaces are utility clutter - never in the hut. If we're
  // standing in/at the hut, work from a spot clear of the walls first (live: 3 furnaces
  // crammed onto the hut floor next to the bed, "nowhere to place - stopping").
  if (found.length < n && (insideOwnStructure(bot) || onHutApron(bot))) {
    const h = insideOwnStructure(bot) || onHutApron(bot)
    dbg('  ensureFurnaces: at my hut - stepping to the utility spot before placing')
    try {
      const nav = require('./navigate.js') // door-assist: a plain goto can't route out through the hut door
      await nav.navigateTo(bot, new goals.GoalNearXZ(h.x + 9, h.z + 9, 2), { timeoutMs: 20000, deadlineMs: 40000, isStopped, climb: false, budgets: { door: 2, pit: 0, water: 1, nudge: 1 }, label: 'utility-spot' })
    } catch (e) { dbg('  ensureFurnaces: utility-spot walk failed (' + e.message + ') - placing where i can') }
  }
  let attempts = 0
  while (found.length < n && attempts++ < n * 2 + 2 && !isStopped()) {
    // 1) a furnace ITEM in the pack, crafting one if needed (8 cobble at a table)
    if (countItem(bot, 'furnace') === 0) {
      let table
      try { table = await ensureTable(bot, opts) } catch (e) { dbg('  ensureFurnaces: no table (' + e.message + ') - stopping at ' + found.length); break }
      if (bot.entity.position.distanceTo(table.position) > 3) await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000).catch(() => {})
      const recipe = bot.recipesFor(mcData.itemsByName.furnace.id, null, 1, table)[0]
      if (!recipe) { dbg('  ensureFurnaces: no cobble for furnace #' + (found.length + 1) + ' - stopping at ' + found.length); break }
      try { await bot.craft(recipe, 1, table) } catch (e) { dbg('  ensureFurnaces: craft failed (' + e.message + ') - stopping at ' + found.length); break }
      await new Promise(r => setTimeout(r, 250))
    }
    // 2) place it, with SPOT RECOVERY: the ring around a stationary bot fills up
    //    (table + furnaces already placed) - step to fresh ground and retry.
    let pos = null
    const dirs = [[4, 0], [0, 4], [-4, 0], [0, -4]]
    for (let step = 0; step <= 3 && !pos; step++) {
      try { pos = await placeFromInventory(bot, 'furnace') } catch (e) {
        dbg('  ensureFurnaces place fail (' + e.message + ') - stepping to fresh ground')
        const p = bot.entity.position
        await gotoWithTimeout(bot, new goals.GoalNearXZ(Math.round(p.x + dirs[step % 4][0]), Math.round(p.z + dirs[step % 4][1]), 1), 10000).catch(() => {})
      }
    }
    if (!pos) { dbg('  ensureFurnaces: nowhere to place - stopping at ' + found.length); break }
    // 3) VERIFY the block landed (block updates lag placement by 50-250ms) - never
    //    count an unverified spot (the old helper's re-scan race counted ghosts).
    let ok = false
    for (let i = 0; i < 8 && !ok; i++) {
      await new Promise(r => setTimeout(r, 250))
      const b = bot.blockAt(pos)
      if (b && b.name === 'furnace') ok = true
    }
    if (ok) { found.push(pos); rememberInfra('furnace', pos, { own: true }); dbg('  ensureFurnaces: placed #' + found.length + ' at ' + pos.toString()) } else dbg('  ensureFurnaces: placed but never saw a furnace block at ' + pos.toString()) // fix #13: bulk field furnaces are now VISIBLE to reconcile/consolidation (own-tagged), not invisible litter
  }
  if (!found.length) found.push((await ensureFurnace(bot, opts)).position) // proven fallback; may throw -> task fails loudly
  return found
}

// #26: loadable fuel units aboard, matching the runtime picker's set (SMART excludes raw
// logs/sticks). Shared by the smelt preflight below. Uses the module `unitsOf`.
function packFuelUnits (bot, smart = SMELT_FUEL_SMART) {
  let u = 0
  for (const [name, c] of Object.entries(inventoryCounts(bot))) {
    if (name === 'coal' || name === 'charcoal' || name === 'coal_block' || /_planks$/.test(name)) u += c * unitsOf(name)
    else if (!smart && (/_log$/.test(name) || name === 'stick')) u += c * unitsOf(name)
  }
  return u
}

// #26: craft planks from logs to cover a fuel shortfall (units). Craft-only, best-effort, never
// throws, bounded to <=16 crafts (~16 logs). Each log -> 4 planks = 6 items of fuel. Same 2x2
// no-table shape as ensureTorches. NEVER gathers wood (the planner/charcoal task sized that).
async function preflightFuelCraft (bot, shortfallUnits) {
  try {
    const mcData = require('minecraft-data')(bot.version)
    const logsToUse = Math.min(16, Math.max(0, Math.ceil(shortfallUnits / 6)))
    for (let i = 0; i < logsToUse; i++) {
      const logItem = (bot.inventory ? bot.inventory.items() : []).find(it => /_log$/.test(it.name))
      if (!logItem) break
      const plank = mcData.itemsByName[logItem.name.replace(/_log$/, '_planks')]
      if (!plank) break
      const recipe = (bot.recipesFor(plank.id, null, 1, null) || [])[0] // inventory 2x2 - no table
      if (!recipe) break
      try { await bot.craft(recipe, 1, null); await new Promise(r => setTimeout(r, 150)) } catch { break }
    }
  } catch { /* best-effort */ }
}

// #26: verify input + fuel are aboard BEFORE opening a furnace (and before ensureFurnaces eats
// the input cobble). ONE bounded input gather (120s, gatherable inputs only) + a plank-from-logs
// fuel craft, then SHRINK the smelt to what's coverable instead of opening a furnace that stalls
// 90s and throws. Returns the effective count (<= count); throws fast only when NOTHING is
// coverable. Reuses runGather + bot.recipesFor - no new subsystem.
async function smeltPreflight (bot, output, input, count, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  let haveIn = countItem(bot, input)
  if (haveIn < count && GATHER_SOURCES[input] && !isStopped()) {
    dbg('  smelt preflight: input short ' + haveIn + '/' + count + ' ' + input + ' - one bounded gather (120s)')
    try { await runGather(bot, input, count - haveIn, { ...opts, deadlineMs: 120000 }) } catch (e) { dbg('  smelt preflight: input gather failed (' + e.message + ')') }
    haveIn = countItem(bot, input)
  }
  let fuelUnits = packFuelUnits(bot)
  if (fuelUnits < count && !isStopped()) {
    await preflightFuelCraft(bot, count - fuelUnits)
    fuelUnits = packFuelUnits(bot)
  }
  const effective = Math.min(count, haveIn, Math.floor(fuelUnits))
  if (effective <= 0) throw new Error(`smelt preflight: no ${input}/fuel aboard for ${output} (input ${haveIn}, fuelUnits ${fuelUnits.toFixed(1)})`)
  if (effective < count) dbg('  smelt preflight: shrinking ' + count + '->' + effective + ' ' + output + ' (input ' + haveIn + ', fuelUnits ' + fuelUnits.toFixed(1) + ')')
  return effective
}

// Smelt `count` of `input` into `output`. Dispatcher: big smelts (per furnaceCountFor)
// run across N furnaces in parallel when >=2 furnaces actually materialize; everything
// else takes the PROVEN single-furnace path. Returns number produced. opts: {say,isStopped}.
async function runSmelt (bot, output, input, count, opts = {}) {
  // #26: preflight (input + fuel aboard, or shrink) BEFORE ensureFurnaces eats the input cobble.
  if (SMELT_FUEL_SMART) count = await smeltPreflight(bot, output, input, count, opts)
  const N = furnaceCountFor(count)
  if (N < 2) return runSmeltSingle(bot, output, input, count, opts)
  let positions = null
  try { positions = await ensureFurnaces(bot, N, opts) } catch (e) { dbg('runSmelt: ensureFurnaces threw (' + e.message + ')') }
  if (!positions || positions.length < 2) {
    dbg('runSmelt: parallel not possible (' + (positions ? positions.length : 0) + ' furnaces) - single path')
    return runSmeltSingle(bot, output, input, count, opts)
  }
  return runSmeltMulti(bot, output, input, count, positions, opts)
}

// The PROVEN single-furnace smelt loop (night-shelter + slot-6/stale-inventory handling).
async function runSmeltSingle (bot, output, input, count, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const inItem = mcData.itemsByName[input]
  dbg('runSmelt', output, 'x' + count, 'from', input, '- ensuring furnace... (have', countItem(bot, input), input + ',', countItem(bot, 'coal'), 'coal,', countItem(bot, 'furnace'), 'furnace item)')
  const furnaceBlock = await ensureFurnace(bot, opts)
  dbg('  furnace at', furnaceBlock.position.toString())
  if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
    await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000)
  }
  // #26: SMART never LOADS raw logs/sticks (they burn 1.5/0.5 items each and are build wood).
  // Flag off => today's permissive set. A log already in the furnace's fuel slot is still read
  // via furnace.fuelItem(), unaffected by this loadable-set narrowing.
  const isFuel = i => /_planks$/.test(i.name) || i.name === 'coal' || i.name === 'charcoal' || i.name === 'coal_block' || (!SMELT_FUEL_SMART && (/_log$/.test(i.name) || i.name === 'stick'))
  // openFurnace can time out when a mob is whacking the bot mid-open (verified live at
  // hp 2) - re-approach and retry once before giving the task up to the re-plan loop.
  let furnace
  try { furnace = await bot.openFurnace(furnaceBlock) } catch (e) {
    dbg('  openFurnace failed (' + e.message + ') - retrying once')
    await new Promise(r => setTimeout(r, 2000))
    await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000).catch(() => {})
    furnace = await bot.openFurnace(furnaceBlock)
  }
  dbg('  furnace window open')
  // (closures read the `furnace` BINDING, so they follow the reopen-after-shelter reassignment)
  const slotSum = name => (furnace.slots || []).filter(s => s && s.name === name).reduce((a, s) => a + s.count, 0)
  const outSum = () => slotSum(output)
  const inInv = name => {
    let n = 0; const sl = furnace.slots || []
    for (let i = 3; i < sl.length; i++) if (sl[i] && sl[i].name === name) n += sl[i].count
    return n
  }
  let before = outSum()
  let made = 0
  let stall = 0; let lastMade = 0; let lastSay = 0; let lastShelter = 0
  try {
    while (made < count) {
      if (isStopped()) break
      // NIGHT SHELTER (mirrors gatherLoop): while the furnace window is open the bot is
      // AFK for minutes - naked at night with a hostile closing, it just stood there and
      // DIED at the furnace (verified live, 26/44). Close the window, dig in, reopen.
      // Output keeps cooking while sheltered and is collected on reopen. (Shelter digging
      // can only yield terrain blocks / smelt INPUT, never the OUTPUT, so `made` is safe.)
      // STARVING at the furnace: the smelt loop is minutes of AFK - it stood here at 0
      // food / 1hp for 20 minutes (live). Close the window, run the food chain, reopen
      // (same shape as the night-shelter below; cooking continues while we're away).
      if (needsFood(bot) && !isSecuringFood() && Date.now() - lastShelter > 30000) {
        lastShelter = Date.now()
        dbg('  smelt food break at', made + '/' + count, '(food=' + bot.food + ')')
        try { furnace.close() } catch {}
        try { await secureFood(bot, { isStopped, say, canHold: false, scoutHunt: false }) } catch {}
        if (isStopped()) break
        if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
          await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000).catch(() => {})
        }
        furnace = await bot.openFurnace(furnaceBlock)
        before = outSum() - made
        stall = 0
        continue
      }
      if (nightRestWanted(bot) && Date.now() - lastShelter > 15000) {
        lastShelter = Date.now()
        say('night time - closing the furnace till it\'s safe')
        dbg('  smelt night-rest at', made + '/' + count, 'timeOfDay=' + (bot.time && bot.time.timeOfDay))
        try { furnace.close() } catch {}
        try { await nightRest(bot, { isStopped, say }) } catch {}
        if (isStopped()) break // death/stop while sheltered - unwind now (window already closed)
        if (bot.entity.position.distanceTo(furnaceBlock.position) > 3) {
          await gotoWithTimeout(bot, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000).catch(() => {})
        }
        furnace = await bot.openFurnace(furnaceBlock) // throws if destroyed -> task fails, autoBuild re-plans
        before = outSum() - made // rebase: shelter-time cooking counts as fresh progress next tick
        stall = 0 // shelter time must NOT count toward the 90s stall break
        dbg('  smelt reopened after shelter, rebased at made=' + made)
        continue
      }
      try { await furnace.takeOutput() } catch {}
      made = outSum() - before
      const stillNeed = count - made
      const cooking = furnace.inputItem() ? furnace.inputItem().count : 0
      if (!furnace.inputItem() && stillNeed > 0 && inInv(input) > 0) {
        try { await furnace.putInput(inItem.id, null, Math.min(stillNeed, inInv(input), 64)) } catch {}
      }
      if (!furnace.fuelItem() && stillNeed > 0 && (cooking > 0 || inInv(input) > 0)) {
        const fuelName = (SMELT_FUEL_SMART ? ['coal', 'charcoal', 'coal_block'] : ['coal', 'charcoal']).find(n => inInv(n) > 0) || (furnace.slots || []).slice(3).find(s => s && isFuel(s))?.name
        if (fuelName) {
          const fid = mcData.itemsByName[fuelName].id
          const want = /_planks$/.test(fuelName) ? Math.max(2, Math.ceil(stillNeed / ITEMS_PER_PLANK) + 1) : 8
          try { await furnace.putFuel(fid, null, Math.min(inInv(fuelName), want)) } catch {}
        }
      }
      if (made > lastMade) { lastMade = made; stall = 0; touchP('smelt'); dbg('  smelt progress', made + '/' + count) } else stall++ // S7 H4a: output collected from the OPEN furnace window
      const noFuel = !furnace.fuelItem() && !(furnace.slots || []).slice(3).some(s => s && isFuel(s))
      const noInput = !furnace.inputItem() && inInv(input) === 0
      if ((noFuel || noInput) && !furnace.outputItem() && cooking === 0) { dbg('  smelt BREAK: noFuel=' + noFuel + ' noInput=' + noInput + ' (made ' + made + '/' + count + ', fuelItem=' + !!furnace.fuelItem() + ' inputItem=' + !!furnace.inputItem() + ' invInput=' + inInv(input) + ' invCoal=' + inInv('coal') + ')'); break }
      if (stall > 90) { dbg('  smelt BREAK: stalled 90s at', made + '/' + count); break }
      if (made > 0 && Date.now() - lastSay > 20000) { say(`smelting… ${made}/${count} ${output}`); lastSay = Date.now() }
      await new Promise(r => setTimeout(r, 1000))
    }
    for (let i = 0; i < 4; i++) { try { await furnace.takeOutput() } catch {} await new Promise(r => setTimeout(r, 200)) }
    var madeFinal = outSum() - before
  } finally { try { furnace.close() } catch {} }
  await new Promise(r => setTimeout(r, 300))
  if ((madeFinal || 0) < count) throw new Error(`smelting stalled: ${madeFinal || 0}/${count} ${output} (out of fuel or input?)`)
  return madeFinal
}

// PARALLEL smelt across N furnace positions: load each furnace its share of input+fuel
// (they cook concurrently server-side), then rotate collecting/topping-up every ~10s.
// Only one window can be open at a time - the bot shuttles. All counts obey the furnace
// gotchas: read the OPEN window's slots (bot.inventory is stale while open; output lands
// in window slot 6 on 1.21.11). Same throw contract as the single path.
async function runSmeltMulti (bot, output, input, count, positions, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const inItem = mcData.itemsByName[input]
  // #26: same loadable-set narrowing as the single loop (unitsOf is now the shared module copy).
  const isFuel = i => /_planks$/.test(i.name) || i.name === 'coal' || i.name === 'charcoal' || i.name === 'coal_block' || (!SMELT_FUEL_SMART && (/_log$/.test(i.name) || i.name === 'stick'))
  const F = positions.map(pos => ({ pos, loaded: 0, dead: 0, inputEmpty: false, outputResidue: false }))
  const alive = () => F.filter(f => f.dead < 3)
  let made = 0
  let invOut0 = null // player-inventory output baseline, set at the FIRST window open
  let lastMade = 0
  let lastProgressAt = Date.now()
  let lastSay = 0
  const hardDeadline = Date.now() + 60000 + count * 12000 // generously above single-furnace pace
  dbg('runSmeltMulti', output, 'x' + count, 'across', F.length, 'furnaces')

  const totalLoaded = () => F.reduce((s, f) => s + f.loaded, 0)
  // One visit: open, drain output, top up input to this furnace's fair share, refuel
  // against ITS pending input (proportional fuel is emergent - no furnace can hoard).
  async function service (f, i) {
    const blk = bot.blockAt(f.pos)
    if (!blk || blk.name !== 'furnace') { f.dead = 3; dbg('  multi: furnace', i, 'gone at', f.pos.toString()); return }
    if (bot.entity.position.distanceTo(f.pos) > 2.5) {
      try { await gotoWithTimeout(bot, new goals.GoalNear(f.pos.x, f.pos.y, f.pos.z, 2), 15000) } catch (e) { f.dead++; dbg('  multi: visit', i, 'goto fail (' + e.message + ')'); return }
    }
    let w
    try { w = await bot.openFurnace(blk) } catch {
      await new Promise(r => setTimeout(r, 500))
      try { w = await bot.openFurnace(blk) } catch (e2) { f.dead++; dbg('  multi: visit', i, 'open fail (' + e2.message + ')'); return }
    }
    f.dead = 0
    try {
      const inInv = name => { let n = 0; const sl = w.slots || []; for (let k = 3; k < sl.length; k++) if (sl[k] && sl[k].name === name) n += sl[k].count; return n }
      if (invOut0 === null) invOut0 = inInv(output) // baseline BEFORE any drain
      for (let k = 0; k < 4; k++) { try { await w.takeOutput() } catch {} await new Promise(r => setTimeout(r, 200)) }
      made = inInv(output) - invOut0 // exact: only window ops change inventory output
      if (made > lastMade) { lastMade = made; lastProgressAt = Date.now(); touchP('smelt'); dbg('  multi: collect furnace', i, '->', made + '/' + count) } // S7 H4b: output collected from the OPEN furnace window
      // top up input toward this furnace's share of what's still unloaded
      const curIn = w.inputItem() ? w.inputItem().count : 0
      const share = Math.ceil(Math.max(0, count - totalLoaded()) / Math.max(1, alive().length))
      const put = Math.min(share, inInv(input), 64 - curIn)
      if (put > 0) {
        try { await w.putInput(inItem.id, null, put); f.loaded += put; dbg('  multi: load furnace', i, '+' + put, input, '(loaded ' + f.loaded + ', total ' + totalLoaded() + ')') } catch (e) { dbg('  multi: load fail furnace', i, e.message) }
      }
      // refuel against THIS furnace's pending input
      const pending = (w.inputItem() ? w.inputItem().count : 0)
      const fuelItem = w.fuelItem()
      const fuelUnits = fuelItem ? fuelItem.count * unitsOf(fuelItem.name) : 0
      if (pending > 0 && fuelUnits < pending) {
        const fuelName = (SMELT_FUEL_SMART ? ['coal', 'charcoal', 'coal_block'] : ['coal', 'charcoal']).find(n => inInv(n) > 0) || (w.slots || []).slice(3).find(s => s && isFuel(s))?.name
        if (fuelName) {
          const needUnits = pending - fuelUnits
          const n = Math.min(inInv(fuelName), Math.max(1, Math.ceil(needUnits / unitsOf(fuelName))))
          try { await w.putFuel(mcData.itemsByName[fuelName].id, null, n); dbg('  multi: fuel furnace', i, '+' + n, fuelName) } catch (e) { dbg('  multi: fuel fail furnace', i, e.message) }
        }
      }
      f.inputEmpty = !w.inputItem()
      f.outputResidue = ((w.slots || []).slice(0, 3).some(s => s && s.name === output))
      f.noFuelLeft = !w.fuelItem() && !(w.slots || []).slice(3).some(s => s && isFuel(s))
      f.noInputLeft = inInv(input) === 0
    } finally { try { w.close() } catch {} }
    await new Promise(r => setTimeout(r, 300)) // stale-inventory hygiene after close
  }

  // LOAD ROUND then COLLECT ROUNDS
  for (let i = 0; i < F.length; i++) { if (isStopped()) break; await service(F[i], i) }
  dbg('  multi: load round done, totalLoaded=' + totalLoaded())
  let idleRounds = 0
  while (made < count && !isStopped() && Date.now() < hardDeadline) {
    // NIGHT SHELTER between rotations (windows are all closed here)
    if (nightRestWanted(bot)) {
      dbg('  multi: night-rest at', made + '/' + count)
      try { await nightRest(bot, { isStopped, say }) } catch {}
      lastProgressAt = Date.now() // shelter time is not a stall
    }
    // STARVING between rotations: same deal as the single-furnace loop - feed first.
    if (needsFood(bot) && !isSecuringFood()) {
      dbg('  multi: food break at', made + '/' + count, '(food=' + bot.food + ')')
      try { await secureFood(bot, { isStopped, say, canHold: false, scoutHunt: false }) } catch {}
      lastProgressAt = Date.now()
    }
    await new Promise(r => setTimeout(r, 10000)) // ~1 item cooks per 10s; faster rotation is wasted walking
    for (let i = 0; i < F.length; i++) { if (isStopped()) break; if (F[i].dead < 3) await service(F[i], i) }
    if (made >= count) break
    const live = alive()
    if (!live.length) { dbg('  multi BREAK: all furnaces dead at ' + made + '/' + count); break }
    const allIdle = live.every(f => f.inputEmpty && !f.outputResidue)
    const exhausted = live.every(f => f.noInputLeft) || live.every(f => f.noFuelLeft)
    if (allIdle && exhausted) { if (++idleRounds >= 2) { dbg('  multi BREAK: exhausted at ' + made + '/' + count); break } } else idleRounds = 0
    if (Date.now() - lastProgressAt > 90000) { dbg('  multi BREAK: stalled 90s at ' + made + '/' + count); break }
    if (made > 0 && Date.now() - lastSay > 20000) { say(`smelting… ${made}/${count} ${output} (${live.length} furnaces)`); lastSay = Date.now() }
  }
  // final drain rotation
  for (let i = 0; i < F.length; i++) { if (F[i].dead < 3) await service(F[i], i).catch(() => {}) }
  if (made < count) throw new Error(`smelting stalled: ${made}/${count} ${output} (out of fuel or input?)`)
  return made
}

// Raw meats a furnace can cook, and what they become. Fish included - the bot eats those too.
// (RAW_COOKABLE moved to provision-food.js)

// Cook whatever raw meat we're carrying in a NEARBY furnace - the player-like tidy-up
// ("standing at the furnace anyway? toss the porkchops in"). Opportunistic on purpose:
// never crafts/places a furnace for this, needs fuel already in the pack, bounded to two
// meat types per pass. Returns how many items came out cooked (0 = nothing to do).
// (cookRawMeat moved to provision-food.js)

// Strip `count` base logs into stripped logs: place a log, right-click with an
// axe to strip it in-world, then mine it back. Returns number produced.
async function runStrip (bot, output, input, count, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const before = countItem(bot, output)
  bot.pathfinder.setMovements(gatherMovements(bot))
  try {
    let guard = count * 3 + 8
    while (countItem(bot, output) - before < count && guard-- > 0) {
      if (isStopped()) break
      if (countItem(bot, input) === 0) throw new Error(`out of ${input} to strip`)
      const pos = await placeFromInventory(bot, input) // place a base log
      const axe = (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_axe'))
      if (!axe) throw new Error('no axe to strip with')
      await bot.equip(axe, 'hand').catch(() => {})
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true).catch(() => {})
      const block = bot.blockAt(pos)
      try { await bot.activateBlock(block) } catch {} // right-click strips it
      await new Promise(r => setTimeout(r, 150))
      const stripped = bot.blockAt(pos) // should now be stripped_*
      try { await bot.dig(stripped) } catch {}
      await collectDrops(bot)
    }
  } finally {
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements()
  }
  const made = countItem(bot, output) - before
  if (made < count) throw new Error(`stripping stalled: ${made}/${count} ${output}`)
  return made
}

// Execute a plan task-by-task: gather -> craft -> smelt -> strip, in order.
async function runPlan (bot, plan, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  const results = []
  dbg('runPlan:', plan.tasks.map(t => `${t.type}:${t.item || t.output}x${t.count || t.crafts || ''}`).join(' > '))
  for (const task of plan.tasks) {
    if (isStopped()) { results.push({ task, ok: false, note: 'stopped' }); break }
    dbg('  task START', task.type, task.item || task.output)
    try {
      if (task.type === 'gather') {
        say(`gathering ${task.count}x ${task.item}...`)
        const r = await runGather(bot, task.item, task.count, opts)
        results.push({ task, ok: r.gathered >= task.count, note: `${r.gathered}/${task.count} (${r.reason})` })
        // A partial gather only DOOMS downstream when it's a tool-gated material (cobble/ore
        // whose smelt/craft can't run short) or we got nothing. A short LOG haul (fuel/planks
        // headroom) is fine - runSmelt burns whatever wood exists and autoBuild re-plans the
        // shortfall - so continue instead of aborting the whole plan (which left builds with 0
        // cobble because one fuel-wood gather came up short).
        if (r.gathered < task.count && (GATHER_TOOL[task.item] || r.gathered === 0)) break
      } else if (task.type === 'craft') {
        say(`crafting ${task.crafts * task.perCraft}x ${task.item}...`)
        const made = await runCraft(bot, task.item, task.crafts * task.perCraft, task.needsTable, opts)
        results.push({ task, ok: true, note: `made ${made}` })
      } else if (task.type === 'smelt') {
        say(`smelting ${task.count}x ${task.output}...`)
        const made = await runSmelt(bot, task.output, task.input, task.count, opts)
        results.push({ task, ok: made >= task.count, note: `smelted ${made}` })
        // Standing at a hot furnace anyway - cook any raw meat from the survival hunts
        // before moving on, like a player would. Best-effort, never fails the plan.
        try { const c = await cookRawMeat(bot, opts); if (c > 0) dbg('  cooked', c, 'raw meat after the smelt') } catch {}
        if (made < task.count) break
      } else if (task.type === 'strip') {
        say(`stripping ${task.count}x ${task.output}...`)
        const made = await runStrip(bot, task.output, task.input, task.count, opts)
        results.push({ task, ok: made >= task.count, note: `stripped ${made}` })
        if (made < task.count) break
      }
    } catch (e) {
      dbg('  task ERROR', task.type, task.item || task.output, '->', e.message)
      results.push({ task, ok: false, note: e.message })
      break
    }
    dbg('  task done', task.type, task.item || task.output, '->', results[results.length - 1]?.note)
  }
  return results
}

// ---- chest storage (for builds too big to hold in 36 slots) ------------------

// Items the bot KEEPS on itself and never stashes: tools, weapons, armor, food,
// utility blocks, and a little scaffold dirt. Everything else is build material
// that goes into the chest.
const KEEP_ON_BOT = /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|^shears$|_helmet$|_chestplate$|_leggings$|_boots$|^cooked_|_apple$|^bread$|^carrot$|^potato$|beef|porkchop|mutton|chicken|^cod$|^salmon$|^torch$|flint_and_steel|_bucket$|^bucket$|^crafting_table$|^furnace$|^chest$|^coal$|^charcoal$|_planks$|^stick$/

// Find a chest within range, or craft (8 planks) + place one next to us. Returns
// the chest Block. Reuses the table/furnace placement pattern.
// NO-REACHING-THROUGH-WALLS (believability, item 4): place a station on a VALID hut INTERIOR
// floor cell (self-structure freeStandCells via stationSlot) instead of wherever the bot
// happens to stand - so furniture ends up inside the room, reachable by walking to it through
// the door, never floating outside a wall or crammed on the bed. Returns the placed Block, or
// null if no interior cell / not near the hut (caller falls back to its normal placement).
// (placeStationInInterior moved to provision-bank.js)

// (ensureChest moved to provision-bank.js)

// ---- ORIENTED chest placement + double-chest heal -----------------------------------
// The hut bank must be ONE connected double chest. After the creeper rebuild the camp
// placed two mismatched singles (418,66,86 facing east + 418,66,87 facing north, live) -
// they never merge, the bank reads as two small chests. Two mechanics matter: a chest's
// facing follows the PLACER (it faces whoever placed it - yaw at placement), and sneak-
// placing (which the schematic builder does whenever the reference block is a chest, to
// avoid opening it) SUPPRESSES merging. So chests are placed deliberately: stand on the
// wanted-facing side, click the TOP of the FLOOR block (never the partner chest), no
// sneak, verify the facing landed - with one side-flip retry in case the convention is
// inverted. A wrong-facing chest is dug back up (fresh + empty + our own block).
// (FACING_OFF moved to provision-bank.js)
// (placeChestOriented moved to provision-bank.js)

// Detect two ADJACENT own single chests in the hut and re-place them with ONE shared
// perpendicular facing so they merge into a double. Contents move one chest at a time
// (the pack never holds the whole treasury); a chest is only dug once it READS empty.
// Returns true when the pair reads as a connected double afterwards.
// (healBankDouble moved to provision-bank.js)

// (gotoChest moved to provision-bank.js)

// Deposit all BUILD MATERIALS (everything not in KEEP_ON_BOT) into the chest, so
// the pack doesn't overflow mid-provision. Keeps `keepDirt` dirt for bridging.
// Returns the number of items deposited.
// opts.all: deposit EVERYTHING except active gear/food (tools, weapons, armor, torches,
// rod, a bite to eat) - for treasury refills and bank consolidation. The default keeps
// the usual working set (KEEP_ON_BOT). NOTE: the camp rebuild always passed all:true;
// it was silently ignored until now, leaving planks/coal stuck in the pack.
const KEEP_WHEN_ALL = /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|^shears$|_helmet$|_chestplate$|_leggings$|_boots$|^torch$|flint_and_steel|_bucket$|^bucket$|^fishing_rod$|^cooked_|^bread$|_apple$/
// (depositMaterials moved to provision-bank.js)

// Withdraw up to `count` of `itemName` from the chest. Returns how many came out.
// (withdrawItem moved to provision-bank.js)

// ---- CHEST MIGRATION (operator promise): the banking chest lived in the open - one
// creeper by the treasury loses the economy. Once the safehouse stands, the bank moves
// INSIDE. Item-safe order: the new chest exists and is verified before anything leaves
// the old one; the old chest is only dug up once it reads EMPTY.
// (migrateChestInto moved to provision-bank.js)

// ---- HOME BANK CONSOLIDATION (operator promise): ONE canonical treasury - the chest
// inside the hut. Every other remembered chest within `radius` gets ferried into it and
// dug up (item-safe: withdraw -> deposit round trips; the old chest is only removed once
// it reads EMPTY). Field stashes from old camps stop rotting in the open where one
// creeper audit loses the economy. Idempotent - runs every camp pass, fast no-op when
// the bank is the only chest. Returns how many field chests were fully consolidated.
// (consolidateBank moved to provision-bank.js)

// ---- FURNISH THE HUT (operator: "wheres the bed crafting table and furnace?"): the
// camp's loose infra moves indoors with the bank. Furnace and table get dug up and
// re-placed inside; the remembered bed is relocated and re-activated (spawn re-set).
// 6-wide footprint (via the model), not the old +4 (5-wide) box that misclassified the
// far wall row - used to tell an IN-hut station/chest from a field one.
// (insideHutBox moved to provision-hut.js)
// The doorway rim column, as a Vec3 at the door-lower / feet cell (anchor.y+1, the cell a
// bot actually stands in to cross the threshold), or null - derived from the self-structure
// model (schema-correct 6-wide rim, not the old 5-wide dx/dz 0..4 scan). anchor.y is the
// floor plank slab, so the walkable door cell is hut.y+1.
// (findHutDoorway moved to provision-hut.js)
// Standable FREE interior cells (Vec3s), from the model: the CORRECT 4x4 interior (dx/dz
// 1..4), floor-level only, threshold excluded, sorted furthest-from-door. The old scan was
// a 3x3 (dx/dz 1..3) that missed the very cells the bot wedged in, and could return a cell
// perched on a furniture/dirt pile.
// (hutFreeCells moved to provision-hut.js)
const HUT_FURNITURE = /chest$|barrel$|furnace$|smoker$|crafting_table$|_bed$|_door$/
// Is a block of kind `itemRe` already standing inside the hut interior? Scans the correct
// 4x4x(5) interior via the model, so a duplicate at dx/dz 4 (missed by the old 3x3) is seen.
// (furnitureInHut moved to provision-hut.js)
// (furnishHut moved to provision-hut.js)

// Read chest contents as { name: count } (build materials the chest is holding).
// (chestCounts moved to provision-bank.js)

module.exports = { GATHER_SOURCES, GATHER_TOOL, SMELT_MAP, STRIP_MAP, planProvision, smeltFuelPlan, inventoryCounts, runGather, runCraft, runSmelt, runStrip, runPlan, branchMine, digStaircaseDown, ensureTable, ensureFurnace, ensureChest, depositMaterials, withdrawItem, chestCounts, detectWood, KEEP_ON_BOT, climbToSurface, pillarUpTo, manualHopFromWater, breachWaterPocket, breachDryPocket, toolForBlock, migrateChestInto, consolidateBank, furnishHut, placeChestOriented, healBankDouble, hasSolidCeiling, insideOwnStructure, ownHutAt, onHutApron, healHomeCrater, gatherLeather, freeInteriorCell, reconcileInfra, cleanupHutInterior, stationInHut, stationSlot, maintainHut, maintainHome, hutAnchor, repairHutStructure, huntForFood, hasFood, needsFood, secureFood, isSecuringFood, boundedHold, recoverFromDegraded, isRecoveringDegraded, deadlockResetDue, deadlockResetState, pickOpenSkyCell, eatBestFood, scoutForWater, digInForNight, nightRest, nightRestWanted, restUntilSafe, isResting, recoverHp, isRecoveringHp, rememberBed, knownBed, ensureSpawnBed, recoverSpawnAnchor, homeRecoveryDecision, recoverHome, setSpawnSuspect, isSpawnSuspect, markBedUnusable, bedHeld, gearupState, gearupResult, gearupShouldArmBackoff, proactiveGearupGate, isSheltering, shelterNeeded, isNight, nightStuck, underArmored, furnaceCountFor, countFurnacesNear, ensureFurnaces, cookRawMeat, dumpJunk, listInfra, rememberInfra, forgetInfra, noteWaterCrossing, lonelyFurnace, consolidateFurnaces, litterPatrol, ensureWheatFarm, tendWheatFarm, WHEAT_FARM_TARGET, RAW_COOKABLE, ensureFoodSupply, needFoodSupply, hasStandingFarm, scoutForFood, fishForFood, ensureHutApron, ensureHutBed, foodCount, survivalState, survivalNeed, mayDoProgress, schedulerState, lowHpCalm, setBuildZone, setDebugSink, rememberRoute, recallRoute, planTrekRoute, dementRoute, recordWedge, listWedges, ownInfraAnchors,
  maintenancePass, isMaintaining, stopMaintenance, _setMaintaining, courierFoodToBank, safekeepSweep, spareKitToBank, recoveryReadyNow, cropExclusionStep, cropPlaceExclusion, farmFootprintHas, hazardStepExclusion, waterStepExclusion, deepWaterUnderfoot, gatherSeedsNear,
  activeJobInfo, stopSurvivalJob, escalateFoodFloor, _foodFloorState,
  wildTerrainMovements, trekMovements, DIGGABLE_NATURAL, STRUCTURE_RE, canBreakNaturally,
  collectDrops, huntSpiderForString, ensureFishingRod, isBankStand,
  // SIBLING BRIDGE: internals the split-out provision-* modules legitimately need at RUNTIME
  // (food planning, scaffold gating, staged walking). Kept off the public surface on purpose -
  // these are not part of the API index.js/commands.js/scheduler.js call, and the double
  // underscore is the signal. Siblings reach them via require('./provision.js').__siblings.
  __siblings: {
    get foodPlanNow () { return provFood.foodPlanNow },
    get topUpFoodForPlan () { return provFood.topUpFoodForPlan },
    get _setFoodPlanHint () { return provFood._setFoodPlanHint },
    // inWaterNow/armorPieceCount live in provision-shelter, but provision-mining CANNOT
    // import it: provision-shelter already requires provision-mining, so a direct import
    // would be a genuine cycle. Bank and food import them directly; mining uses these.
    get armorPieceCount () { return armorPieceCount },
    get inWaterNow () { return inWaterNow },
    get placeFromInventory () { return placeFromInventory },
    get scaffoldDigOK () { return scaffoldDigOK },
    get walkStaged () { return walkStaged },
    get KEEP_WHEN_ALL () { return KEEP_WHEN_ALL },
    get explore () { return explore },
    get isSurvStopped () { return () => _survStop }
  } }
