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
const shelterSite = require('./shelter.js') // pure shelter-siting: "can a safe pit be dug here" + nearest diggable dry cell
const foodSec = require('./food.js') // pure food-security decisions: when to proactively build a fishing supply
const farm = require('./farm.js') // pure wheat-farm geometry (flood-safe bank pick) + crop-state (VERIFIED wheat, never faith)
const arbiter = require('./arbiter.js') // JOB-LEVEL arbitration: survive > progress authority (jobSurvivalNeed/jobMayProgress)
const scheduler = require('./scheduler.js') // PURE survival-tier decision core; top-level-safe (scheduler requires only arbiter - no cycle back to provision). Used by schedulerState to classify the active job.
const routeMem = require('./route-mem.js') // PURE route/wedge geometry: replay proven treks + soft-steer around learned wedges (semantic-world-map slice 1)
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
function setDebugSink (fn) { dbgSink = fn }
// fix #15 Piece C (flag DEFEND_WHEN_HIT, default ON, read once at module load - mirrors index.js):
// a sealed shelter that is nonetheless TAKING DAMAGE (breached/leaky seal, mob fell in before the
// cap) must bail out to fight/flee instead of holding _sheltering for up to 600s while hits land.
// =0 reverts both pit waits to their old `!fullySealed`/`!recapped`-only damage bails.
const DEFEND_WHEN_HIT_ON = process.env.DEFEND_WHEN_HIT !== '0'
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
function cropExclusionStep (bot) {
  if (process.env.FARM_NO_TRAMPLE === '0') return null
  let cells = null
  try { const wf = loadWorldMem().wheatFarm; cells = (wf && wf.cells) || null } catch { return null }
  if (!cells || !cells.length) return null
  const cols = new Set()
  let cy = null
  for (const c of cells) { cols.add(c.x + ',' + c.z); if (cy == null) cy = c.y }
  const COST = Number(process.env.MAINT_CROP_STEP_COST || 50)
  return (block) => {
    const p = block && block.position
    if (!p) return 0
    if (cy != null && Math.abs(p.y - cy) > 1) return 0
    return cols.has(p.x + ',' + p.z) ? COST : 0
  }
}

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
function cropPlaceExclusion (bot) {
  if (process.env.NO_PLACE_ON_FARM === '0') return null
  let cells = null
  try { const wf = loadWorldMem().wheatFarm; cells = (wf && wf.cells) || null } catch { return null }
  if (!cells || !cells.length) return null
  const cols = new Set()
  let cy = null
  for (const c of cells) { cols.add(c.x + ',' + c.z); if (cy == null) cy = c.y }
  const COST = Number(process.env.NO_PLACE_ON_FARM_COST || 1000000) // effectively forbid: A* routes around unless the ONLY path (survival) crosses the farm
  return (block) => {
    const p = block && block.position
    if (!p) return 0
    if (cy != null && Math.abs(p.y - cy) > 1) return 0
    return cols.has(p.x + ',' + p.z) ? COST : 0
  }
}

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
// mid-leg). navigateToInner re-runs this thunk before EVERY attempt (navigate.js:770), so the
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
const STRUCTURE_RE = /planks$|stairs$|_slab$|fence|_door$|trapdoor$|_wall$|glass|_bed$|torch|lantern|crafting_table|^furnace$|chest|barrel|bookshelf|ladder|_sign$|_carpet$|wool$|brick|cobblestone|_wood$|smooth_|polished_|composter|loom|^bell$|dirt_path|farmland|hay_block|stripped_/
// ANTI-GRIEF for EVERY dig primitive (strip-shaft, tunnel, staircase, pillar, shelter): the
// ONLY blocks any of them may break are NATURAL terrain/ore - never a player-placed build
// block. `canBreakNaturally` is the single gate; without it the climb-out/strip-mine punch
// straight through a base's floor/wall (bot.canDigBlock is a reach/harvest test, NOT a
// protection check). Note: `cobblestone` is deliberately EXCLUDED (it's a common player
// block) - the strip-mine digs `stone` and gets cobble as the drop.
const DIGGABLE_NATURAL = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|moss_block|stone|deepslate|granite|diorite|andesite|tuff|calcite|dripstone_block|pointed_dripstone|sand|red_sand|gravel|clay|mud|sandstone|red_sandstone|snow_block|snow|powder_snow|ice|packed_ice|blue_ice|frosted_ice|netherrack|soul_sand|soul_soil|magma_block|blackstone|basalt|end_stone)$|terracotta$|_ore$/
function canBreakNaturally (block) { return !!block && DIGGABLE_NATURAL.test(block.name) && !STRUCTURE_RE.test(block.name) }
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
function inventoryCounts (bot) {
  const out = {}
  for (const i of (bot.inventory ? bot.inventory.items() : [])) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

// ---- executors (live bot) ----------------------------------------------------

function countItem (bot, name) { return inventoryCounts(bot)[name] || 0 }

// pathfinder.goto with a deadline (goto can hang forever on an unreachable target).
// One shared implementation now - navigate.js.
function gotoWithTimeout (bot, goal, ms) {
  return navigate.gotoOnce(bot, goal, ms)
}

// Walk onto nearby dropped items so they're picked up. Waits for drops to settle,
// then sweeps the nearest item repeatedly (walk ONTO it - range 0). More persistent
// than before because scattered drops on jagged terrain were being left behind.
async function collectDrops (bot, radius = 10, { patience = 1 } = {}) {
  await new Promise(r => setTimeout(r, 250)) // let freshly-broken drops settle/land
  let empties = 0
  for (let n = 0; n < 20; n++) {
    let target = null; let best = radius
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e.name !== 'item') continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < best) { best = d; target = e }
    }
    if (!target) {
      // DON'T bail on the first empty scan. A just-broken drop can take a beat to spawn/sync,
      // or land a hair outside `radius` (a wheat drop from a cell against a pond bounces toward
      // the water edge). The old early-return abandoned those drops the instant nothing was in
      // range after 250ms - the "harvested N -> wheat=0" loss. Wait + re-look `patience` times
      // before concluding there's genuinely nothing here.
      if (empties++ >= patience) return
      await new Promise(r => setTimeout(r, 300))
      continue
    }
    empties = 0
    try { await gotoWithTimeout(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 0), 10000) } catch { return }
    await new Promise(r => setTimeout(r, 250))
  }
}

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
const AIRISH = n => n === 'air' || n === 'cave_air' || n === 'void_air'

const FILLER_RE = /^(cobblestone|dirt|coarse_dirt|stone|gravel|andesite|diorite|granite|cobbled_deepslate|netherrack|tuff|deepslate)$/

// STRIP-MINE downward to reach buried stone (plains - it's all under dirt). Digs a SAFE
// vertical shaft: only break the block underfoot when the block TWO below is solid and
// non-dangerous, so we never drop into lava/water/a cave. One at a time, falling in,
// with the right tool. Returns how deep it dug. Climb back out via pillarUpTo.
// Is the bot standing on/next to a remembered HUT (footprint + a 2-block apron, so the
// doorway stays walkable)? Strip-mining must NOT open a shaft here - it dug a pit right
// in front of the door and the bot then struggled to get into its own safehouse (live).
function onHutApron (bot, pos) {
  const p = pos || bot.entity.position.floored()
  for (const h of listInfra('hut')) {
    if (p.x >= h.x - 2 && p.x <= h.x + 6 && p.z >= h.z - 2 && p.z <= h.z + 6) return h
  }
  return null
}

// ---- OWN-STRUCTURE AWARENESS ---------------------------------------------------
// The hut is 6x5x6 (hut.schem: anchor + 0..5 in x/z, + 0..4 in y). Being INSIDE it is
// not "underground": before this predicate the roofed interior tripped hasSolidCeiling,
// so climb-out dug through the bot's own roof, pit-escape pillared dirt onto the floor,
// and fishing/farming refused to run "in a cave" while the bot stood in its living room.
function ownHutAt (pos) {
  if (!pos) return null
  const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
  for (const h of listInfra('hut')) {
    if (x >= h.x && x <= h.x + 5 && z >= h.z && z <= h.z + 5 && y >= h.y && y <= h.y + 4) return h
  }
  return null
}
// Feet (or `pos`) inside one of the bot's own roofed structures. Returns the hut anchor
// entry or null - truthiness is the common use.
function insideOwnStructure (bot, pos) {
  const p = pos || (bot && bot.entity && bot.entity.position)
  return p ? ownHutAt(p) : null
}

// STEP OFF THE HUT APRON before sinking a shaft/staircase, so the doorstep itself is never dug
// (the onHutApron refusal is KEPT) but "just off the apron" is actually reachable. The old
// step-off tried ONE fixed target (home if far, else the +12,+12 diagonal) with one goto - if
// that single direction was wedged/cratered/watered it returned 0 forever, so a stone gather at
// a dirt-surface hut never got underground (task #22, R2). With STONE_RELOCATE on we rotate the 4
// mining.DIRS at `radius` blocks (exactly branchMine's entrance-relocation pattern) and stop at
// the first cell clear of the apron AND the hut interior. STONE_RELOCATE=0 restores today's
// one-shot target (byte-for-byte movement). NEVER digs. Returns true if we ended clear of the
// apron; the caller keeps its own refuse-and-return on false.
async function stepOffApron (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const h = onHutApron(bot)
  if (!h) return true // not on the apron - nothing to step off
  const tag = opts.tag || 'shaft'
  if (process.env.STONE_RELOCATE === '0') { // legacy one-shot: today's exact behavior
    const away = opts.home && (Math.abs(opts.home.x - h.x) > 8 || Math.abs(opts.home.z - h.z) > 8)
      ? new Vec3(opts.home.x, bot.entity.position.y, opts.home.z)
      : new Vec3(h.x + 12, bot.entity.position.y, h.z + 12)
    dbg('  ' + tag + ': on the hut apron - stepping clear to ' + Math.round(away.x) + ',' + Math.round(away.z) + ' before digging')
    try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 3), 20000) } catch {}
    return !onHutApron(bot)
  }
  // STONE_RELOCATE on: rotate the compass so a single wedged direction no longer sticks.
  const radius = opts.radius != null ? opts.radius : 12
  const tries = opts.tries != null ? opts.tries : 4
  for (let i = 0; i < tries && !isStopped(); i++) {
    const [dx, dz] = mining.DIRS[i % 4]
    const away = new Vec3(h.x + dx * radius, bot.entity.position.y, h.z + dz * radius)
    dbg('  ' + tag + ': on the hut apron - stepping clear (dir ' + i + ') to ' + Math.round(away.x) + ',' + Math.round(away.z))
    try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 3), 12000) } catch {}
    if (!onHutApron(bot) && !insideOwnStructure(bot)) return true
  }
  return !onHutApron(bot) && !insideOwnStructure(bot)
}

// After the hut builds, GUARANTEE a flush doorstep. The ground right in front of the door is
// often 1-2 blocks below the hut floor (median-surface snap + natural slope + gather shafts),
// so the bot steps straight out the door into a pit and then struggles to get back into its own
// safehouse ("hole at the front door", seen live repeatedly). onHutApron only STOPS new digging;
// this positively FILLS the exit lane up to floor level. Best-effort + idempotent: runs each camp
// pass and re-heals any hole a gather cycle re-opens. `at` = hut anchor; the schematic door sits
// at rel (2,*,0) on the z=0 wall, so it opens toward -z (outside = at.z - 1).
async function ensureHutApron (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const doorX = at.x + 2; const floorY = at.y; const outZ = at.z - 1
  // only bother if the door is actually there (its lower half sits at floorY+1)
  const dl = bot.blockAt(new Vec3(doorX, floorY + 1, at.z))
  if (!dl || !/_door$/.test(dl.name)) return 0
  // get within reach of the threshold
  try { await gotoWithTimeout(bot, new goals.GoalNearXZ(doorX, at.z, 2), 20000) } catch {}
  const DIRTLIKE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|tuff|gravel|netherrack)$/
  const ANYFILL = /(_planks|dirt|cobblestone|cobbled_deepslate|stone)$/
  const fillCell = async (wx, wy, wz) => {
    const b = bot.blockAt(new Vec3(wx, wy, wz))
    if (b && b.boundingBox === 'block' && !AIRISH(b.name)) return false // already solid
    let ok = await placeAt(bot, new Vec3(wx, wy, wz), DIRTLIKE) // cheap filler first (save planks)
    if (!ok) ok = await placeAt(bot, new Vec3(wx, wy, wz), ANYFILL)
    return ok
  }
  let filled = 0
  // door width +-1, the immediate step-out row. Fill support (floorY-1) THEN walk-surface (floorY),
  // bottom-up so each layer has a solid face beneath/beside to place against. A block at floorY tops
  // out flush with the inside floor -> a level walk through the door instead of a fall.
  for (let dx = -1; dx <= 1 && !isStopped(); dx++) {
    if (await fillCell(doorX + dx, floorY - 1, outZ)) filled++
    if (await fillCell(doorX + dx, floorY, outZ)) filled++
  }
  if (filled) { say(`sealed the doorstep - filled ${filled} apron cell(s) so the exit stays walkable`); dbg('  apron: filled ' + filled + ' doorstep cell(s) at ' + doorX + ',' + floorY + ',' + outZ) }
  return filled
}

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
async function healHomeCrater (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const reposition = opts.reposition !== false
  const floorY = at.y; const doorX = at.x + 2
  const DIRTLIKE = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|tuff|gravel|netherrack)$/
  const ANYFILL = /(_planks|dirt|cobblestone|cobbled_deepslate|stone)$/
  const X0 = doorX - 2; const X1 = doorX + 5    // 414..421 - FULL crater width incl. the east pit
  const Z1 = at.z - 1; const Z0 = at.z - 4      // 84..81 - out to the crater's north edge
  const solidAt = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!(b && b.boundingBox === 'block' && !AIRISH(b.name)) }
  const inFootprint = (x, z) => (z >= at.z) || !!ownHutAt(new Vec3(x, floorY, z)) // NEVER inside the hut
  // Restore the WALK SURFACE (y=floorY) across the crater by BRIDGING outward from solid
  // ground - not a bottom-up depth fill, which can't be reached: from the doorstep the
  // pathfinder can't route ACROSS the open pit to the far (east) cells (live: 'none
  // placeable'). Instead place the nearest surface hole that has a solid face, STEP ONTO
  // it, and reach the next - exactly how a player bridges a gap. A 1-thick dirt surface is
  // stable (only sand/gravel fall) and stops the fall-in death; the air below is harmless.
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  // A cell is a real crater ONLY if it's not already walkable at natural grade: intact
  // ground sits one block LOW (grade top at floorY-1, feet at floorY), so a cell that is
  // solid at floorY-1 is fine even though floorY itself is air - filling it would build a
  // waist-high dirt shelf across intact apron (live bug). Only air at BOTH floorY and
  // floorY-1 is an actual pit to bridge.
  const targets = []
  for (let wz = Z1; wz >= Z0; wz--) for (let wx = X0; wx <= X1; wx++) {
    if (inFootprint(wx, wz)) continue
    if (!solidAt(wx, floorY, wz) && !solidAt(wx, floorY - 1, wz)) targets.push({ x: wx, z: wz })
  }
  const holes = targets.length
  if (!holes) return 0
  let filled = 0; let progress = true; let guard = 0
  while (targets.length && progress && guard++ < 80 && !isStopped()) {
    progress = false
    targets.sort((a, b) => bot.entity.position.distanceTo(new Vec3(a.x, floorY, a.z)) - bot.entity.position.distanceTo(new Vec3(b.x, floorY, b.z)))
    for (let i = 0; i < targets.length && !isStopped(); i++) {
      const t = targets[i]
      const sideN = N4.map(([dx, dz]) => ({ x: t.x + dx, z: t.z + dz })).filter(n => !inFootprint(n.x, n.z) && (solidAt(n.x, floorY, n.z) || solidAt(n.x, floorY - 1, n.z)))
      const belowSolid = solidAt(t.x, floorY - 1, t.z)
      if (!sideN.length && !belowSolid) continue // no face to place against yet - a nearer cell bridges here first
      const tv = new Vec3(t.x, floorY, t.z)
      if (bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) > 4.3) {
        if (!reposition) continue // doorway quick-pass: only what's reachable without walking
        let ok = false
        for (const n of sideN) { // stand ON a solid neighbour (its top) to get in reach
          try { await gotoWithTimeout(bot, new goals.GoalBlock(n.x, floorY + 1, n.z), 6000) } catch {}
          if (bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) <= 4.6) { ok = true; break }
        }
        if (!ok && bot.entity.position.distanceTo(tv.offset(0.5, 0.5, 0.5)) > 4.6) continue
      }
      let ok = await placeAt(bot, tv, DIRTLIKE) // cheap filler first (save planks)
      if (!ok) ok = await placeAt(bot, tv, ANYFILL)
      if (ok) { filled++; targets.splice(i, 1); i--; progress = true }
    }
  }
  if (filled) { say(`patched the creeper crater at my door - bridged ${filled} block(s) so it's walkable`); dbg('  crater heal: bridged ' + filled + '/' + holes + ' surface hole(s), x' + X0 + '-' + X1 + ' z' + Z0 + '-' + Z1 + (targets.length ? ' (' + targets.length + ' left for a later pass)' : '')) }
  else dbg('  crater heal: ' + holes + ' surface hole(s), none bridgeable from here' + (reposition ? '' : ' (no-reposition pass)'))
  return filled
}

// Make sure the hut has a usable BED and our spawn is set on it. Runs every camp pass
// (decoupled from the bad>3 rebuild, where the only bed path used to live - so a recovered
// bed rode around unplaced forever, no spawn). If a bed already stands in the hut, (re)assert
// spawn on it once; else, if we're carrying one, walk inside (the apron is filled so entry
// works) and lay it on an interior floor cell clear of the furniture, then set spawn. Every
// place is verified (Fable's placedOK is live) - a fail just leaves the bed in the pack, no
// worse than before. Returns 'present' | 'placed' | 'none' | 'fail'. `at` = hut anchor.
async function ensureHutBed (bot, at, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  // 1) already a bed standing in the footprint? assert spawn once, then leave it be.
  for (let dy = 0; dy <= 3 && !isStopped(); dy++) for (let dz = 0; dz <= 5; dz++) for (let dx = 0; dx <= 5; dx++) {
    const b = bot.blockAt(new Vec3(at.x + dx, at.y + dy, at.z + dz))
    if (b && /_bed$/.test(b.name)) {
      const kb = knownBed()
      // opts.force = the server anchor is KNOWN wrong (spawn-suspect) - a matching memory
      // proves nothing then; walk over and genuinely re-activate the bed.
      if (!opts.force && kb && kb.x === b.position.x && kb.y === b.position.y && kb.z === b.position.z) return 'present' // spawn already set here - don't re-trek every pass
      try { await gotoWithTimeout(bot, new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2), 15000) } catch {}
      try { await bot.activateBlock(b); rememberBed(b.position) } catch {}
      return 'present'
    }
  }
  // 2) carrying a bed? lay it on an interior floor cell. foot (2,1,2) + head (2,1,3): both must
  //    be air over a solid floor. (chest 4,1,1/2, furnace 4,1,4, table 1,1,4 are all clear of this.)
  let bedItem = (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name))
  if (!bedItem) {
    // No bed in the pack: wool is operator-supplied here (no sheep), so a spare bed
    // BANKED in the hut chest is the only other source - withdraw > craft > gather.
    try {
      const res = require('./resources.js') // lazy - resources requires provision at load
      const near = { x: at.x + 2, y: at.y + 1, z: at.z + 2 }
      const totals = await res.totalCounts(bot, { near, maxDist: 24 })
      const banked = Object.keys(totals).find(n => /_bed$/.test(n) && totals[n] > 0)
      if (banked) {
        dbg('  ensureHutBed: no bed in the pack but a ' + banked + ' is banked - withdrawing it')
        await res.withdrawItems(bot, banked, 1, { near })
        bedItem = (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name))
      }
    } catch (e) { dbg('  ensureHutBed: bank bed check failed (' + e.message + ')') }
  }
  if (!bedItem) return 'none'
  const foot = new Vec3(at.x + 2, at.y + 1, at.z + 2)
  const head = new Vec3(at.x + 2, at.y + 1, at.z + 3)
  for (const c of [foot, head]) {
    const cb = bot.blockAt(c); const fl = bot.blockAt(c.offset(0, -1, 0))
    if (cb && !AIRISH(cb.name)) { dbg('  ensureHutBed: interior spot blocked by ' + cb.name); return 'fail' }
    if (!fl || fl.boundingBox !== 'block') { dbg('  ensureHutBed: no solid floor under the bed spot'); return 'fail' }
  }
  try { await gotoWithTimeout(bot, new goals.GoalNear(foot.x, foot.y, foot.z, 2), 15000) } catch {}
  try {
    await bot.equip(bedItem, 'hand')
    await bot.lookAt(head.offset(0.5, 0.0, 0.5), true) // face +z so the head lays toward (2,1,3)
    await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0)), new Vec3(0, 1, 0))
  } catch (e) { dbg('  ensureHutBed: place failed (' + e.message + ')'); return 'fail' }
  await new Promise(r => setTimeout(r, 400))
  for (let dz = 0; dz <= 5; dz++) for (let dx = 0; dx <= 5; dx++) { // verify a bed actually landed, then set spawn
    const b = bot.blockAt(new Vec3(at.x + dx, at.y + 1, at.z + dz))
    if (b && /_bed$/.test(b.name)) {
      try { await bot.activateBlock(b); rememberBed(b.position) } catch {}
      say('set my bed in the hut - spawn point secured')
      return 'placed'
    }
  }
  dbg('  ensureHutBed: placement did not verify - bed still in pack')
  return 'fail'
}

async function digShaftDown (bot, maxDepth, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const FLUID = process.env.MINE_FLUID !== '0'
  const LAVA_SAFE = process.env.LAVA_SAFE !== '0' // #41 §2c: a pool at shaft-bottom level flows in SIDEWAYS (below/below2 only look straight down)
  const DANGER = /lava|water/
  // Never sink a shaft on the hut's doorstep. Step clear of the apron first (toward the
  // build site if we know it, else just off the apron) so the entrance stays intact.
  if (onHutApron(bot)) {
    // Step clear of the doorstep via the shared 4-direction helper (STONE_RELOCATE=0 -> today's
    // single home/diagonal one-shot). The refusal to dig the apron itself is KEPT.
    if (!(await stepOffApron(bot, { isStopped, home: opts.home, tag: 'shaft' }))) { dbg('  shaft: still on apron - refusing to dig here'); return 0 }
  }
  let dug = 0
  while (dug < maxDepth && !isStopped()) {
    if (mineDanger(bot)) { dbg('  shaft: hostile close / hp low - bailing the descent to react'); break } // hand control back to the gather's survival reflex
    const feet = bot.entity.position.floored()
    const below = bot.blockAt(feet.offset(0, -1, 0))
    const below2 = bot.blockAt(feet.offset(0, -2, 0))
    if (!below || AIRISH(below.name) || DANGER.test(below.name)) break
    if (!below2 || AIRISH(below2.name) || DANGER.test(below2.name)) break // drop/lava/cave beneath -> STOP
    if (LAVA_SAFE) { // #41: fluid in a SIDE neighbour of our feet cell or of the cell we'll drop into -> it floods in horizontally; stop the shaft
      const sides = []
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = bot.blockAt(feet.offset(dx, 0, dz)); const b = bot.blockAt(feet.offset(dx, -1, dz)); sides.push(a && a.name, b && b.name) }
      if (mining.digExposureHazard(sides) !== 'ok') break
    }
    if (!canBreakNaturally(below)) break // anti-grief: never dig a player-placed block
    const tool = toolForBlock(bot, below.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(below)) break
    try { await bot.dig(below) } catch { break }
    dug++
    if (FLUID) {
      // BOUNDED FALL-SETTLE: wait only until we've actually dropped onto the new floor (cap
      // 300ms) instead of a fixed 250ms every block. Keeps the fall-physics purpose, drops the
      // flat floor when the fall is instant. (MINE_FLUID=0 keeps the fixed 250ms sleep.)
      const y0 = Math.floor(bot.entity.position.y); const t = Date.now()
      while (Date.now() - t < 300) {
        await new Promise(r => setTimeout(r, 20))
        if (bot.entity.onGround && Math.floor(bot.entity.position.y) < y0) break
      }
    } else {
      await new Promise(r => setTimeout(r, 250))
    }
  }
  return dug
}

// Classic pillar-up: rise to targetY by clearing the 2 blocks above and placing a
// filler block (cobble/dirt we carry) under our feet each hop. STOPS exactly at targetY
// - how a player climbs out of a mine, reliable where the pathfinder's dig-straight-up
// isn't. Out of filler -> stop (caller falls back to walking out).
// Climb back to the surface by digging a SPIRAL STAIRCASE UP (walkable, deterministic -
// scripted pillaring kept trapping the bot in the surface dirt). Each step rotates a
// quarter-turn and rises one: place a floor block if the next step is over air, dig the
// feet+head cells there and our own head clearance, then walk onto it. Stops at targetY.
async function digStaircaseUp (bot, targetY, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (insideOwnStructure(bot)) { dbg('  staircase: inside my own hut - not cutting up through it'); return }
  const FLUID = process.env.MINE_FLUID !== '0'
  const LAVA_SAFE = process.env.LAVA_SAFE !== '0' // #41: refuse a lava-adjacent/lava-floored step; =0 -> byte-for-byte today
  const FACE6 = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  const nameAt = (v) => { const b = bot.blockAt(v); return b ? b.name : null }
  const DIRS = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]
  const digIf = async (p) => {
    const b = bot.blockAt(p)
    if (!b || AIRISH(b.name)) return true
    if (/lava|water/.test(b.name)) return false
    if (!canBreakNaturally(b) && !scaffoldDigOK(b)) return false // anti-grief: don't cut through a player build (own registry-proven scaffold allowed under NAV_TERRAIN_PROFILE)
    const tool = toolForBlock(bot, b.name)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) return false
    try { await bot.dig(b); return true } catch { return false }
  }
  const startY = Math.floor(bot.entity.position.y)
  let di = 0; let stuck = 0
  while (Math.floor(bot.entity.position.y) < targetY && !isStopped() && stuck < 8) {
    if (LAVA_SAFE && mineDanger(bot)) break // #41: in-lava/on-fire/hostile/low-hp -> stop digging & hand control back (the 3 sibling primitives already bail; this one didn't - death 1 climbed ~9s while burning)
    if (Math.floor(bot.entity.position.y) > startY && !hasSolidCeiling(bot, 20, { ignoreLeaves: true })) break // broke into open sky - done
    const y0 = Math.floor(bot.entity.position.y)
    const feet = bot.entity.position.floored()
    await digIf(feet.offset(0, 2, 0))             // our own head-clearance to move up
    let dir, sFloor, sFeet, sHead
    if (LAVA_SAFE) {
      // #41 gap #1/#2: pick the first of the 4 quarter-turn directions whose step is lava-safe.
      // For each candidate probe climbStepSafety over the tread's support (descentSafety) + every
      // cell the step opens/enters and its face-neighbours (a lava tread, or a pocket beside a
      // cell we crack open). All 4 hazardous -> abandon the staircase (return); climbToSurface
      // then falls through to its column-safe pillarUpTo fallback. No new escalation machinery.
      let chosen = null; let lastHz = 'ok'
      for (let k = 0; k < 4; k++) {
        const cand = DIRS[(di + k) % 4]
        const cFloor = feet.plus(cand); const cFeet = cFloor.offset(0, 1, 0); const cHead = cFloor.offset(0, 2, 0)
        const under = cFloor.offset(0, -1, 0)
        const probe = []
        for (const c of [feet.offset(0, 2, 0), cFeet, cHead, cFloor]) { probe.push(nameAt(c)); for (const n of FACE6) probe.push(nameAt(c.plus(n))) }
        const hz = mining.climbStepSafety(nameAt(under), nameAt(under.offset(0, -1, 0)), probe)
        if (hz === 'ok') { chosen = { dir: cand, off: k }; break }
        lastHz = hz
      }
      if (!chosen) { dbg('  staircase: all 4 directions hazardous (' + lastHz + ') at ' + feet.toString() + ' - handing to pillar fallback'); return }
      dir = chosen.dir; di += chosen.off + 1
    } else {
      dir = DIRS[di % 4]; di++
    }
    sFloor = feet.plus(dir)                        // block we'll stand on (same Y as feet)
    sFeet = feet.plus(dir).offset(0, 1, 0)         // new feet cell
    sHead = feet.plus(dir).offset(0, 2, 0)         // new head cell
    const fb = bot.blockAt(sFloor)
    if (!fb || AIRISH(fb.name)) { // no floor for the step -> place one
      const filler = scaffold.pickFiller(bot) // dirt-first, one policy for every scaffold placer
      if (filler) {
        await bot.equip(filler, 'hand').catch(() => {})
        const under = bot.blockAt(sFloor.offset(0, -1, 0))
        try { if (under && !AIRISH(under.name)) { await bot.placeBlock(under, new Vec3(0, 1, 0)); scaffold.add(sFloor, 'staircase') } } catch {}
      }
    }
    if (!(await digIf(sFeet)) || !(await digIf(sHead))) { stuck++; continue }
    // CHEAP ADJACENT STEP UP onto the just-cleared tread (forward + a jump pulse); fall through
    // to today's exact per-step goto if it doesn't arrive. The stuck-counter below is unchanged.
    let arrived = false
    if (FLUID) { arrived = await stepInto(bot, sFeet, { jump: true, isStopped }) }
    if (!arrived) { try { await gotoWithTimeout(bot, new goals.GoalBlock(sFeet.x, sFeet.y, sFeet.z), 6000) } catch {} }
    if (Math.floor(bot.entity.position.y) <= y0) stuck++; else stuck = 0
  }
}

// Movement profile for DIGGING OUR WAY BACK to the surface after strip-mining: it may
// break the overburden (canDig) and pillar up, so a stone ceiling can't trap us. Only
// used to escape a mine we dug ourselves - never near player builds.
function climbMovements (bot) {
  const m = new Movements(bot)
  m.canDig = true
  m.allow1by1towers = true    // pillar straight up through a stone ceiling...
  m.canOpenDoors = true
  m.allowParkour = true
  m.maxDropDown = 4
  m.digCost = 1
  // ...but only if it has blocks to pillar WITH - give the pathfinder our cheap filler
  // so allow1by1towers can actually place a tower (else it can't rise over a gap/void).
  try {
    const md = require('minecraft-data')(bot.version)
    const fill = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'gravel', 'andesite', 'granite', 'diorite', 'tuff']
    const ids = fill.map(n => md.itemsByName[n] && md.itemsByName[n].id).filter(x => x != null)
    if ('scafoldingBlocks' in m) m.scafoldingBlocks = ids
    // ANTI-GRIEF: canDig=true here would otherwise let the pathfinder cut THROUGH a player
    // build to climb out (bypassing the per-primitive canBreakNaturally guards). Deny every
    // structural block so the climb-out routes around a base, never through it.
    if (m.blocksCantBreak && typeof m.blocksCantBreak.add === 'function') {
      for (const b of Object.values(md.blocksByName || {})) { if (STRUCTURE_RE.test(b.name)) m.blocksCantBreak.add(b.id) }
    }
  } catch { /* mcData not ready */ }
  try { const ex = cropExclusionStep(bot); if (ex && Array.isArray(m.exclusionAreasStep)) m.exclusionAreasStep.push(ex) } catch {} // FARM_NO_TRAMPLE: climb-out routes around our plot too
  try { const px = cropPlaceExclusion(bot); if (px && Array.isArray(m.exclusionAreasPlace)) m.exclusionAreasPlace.push(px) } catch {} // NO_PLACE_ON_FARM (fix #17): never bridge/place on our own farmland
  return m
}

// Is there a solid ceiling overhead? i.e. are we in a cave/underground rather than out in
// the open under the sky. Scans the column above the head for a real (block-shaped) block.
// Lets travel tell "dropped into a cave" (climb out) apart from "walking through a valley"
// (fine - don't pointlessly pillar up in the open).
function hasSolidCeiling (bot, upTo = 45, opts = {}) {
  if (!bot.entity) return false
  // Inside the bot's own hut: roofed, yes - underground, no. Without this the interior
  // read as a cave and every "buried" consumer (climb-out, travel surfacing, the fishing/
  // farming gates, /state hazards) misfired while the bot idled at home.
  if (insideOwnStructure(bot)) return false
  const base = bot.entity.position.floored()
  for (let dy = 2; dy <= upTo; dy++) {
    const b = bot.blockAt(base.offset(0, dy, 0))
    if (!b || AIRISH(b.name) || b.boundingBox !== 'block') continue
    // leaves have a 'block' bounding box but a canopy isn't a cave roof - so an
    // "underground" check (opts.ignoreLeaves) sees through a tree, while travelFar's
    // buried() check (default) still treats an overhang as cover.
    if (opts.ignoreLeaves && /_leaves$/.test(b.name)) continue
    return true
  }
  return false
}

// Escape UPWARD when stranded underground (e.g. cross-country travel dropped us into a
// cave/ravine we can't path out of): dig a walkable staircase up to targetY with dig-
// capable climb movements, then restore the caller's movement profile. Anti-grief-safe:
// digStaircaseUp refuses lava/water and honours canDigBlock, so it cuts natural stone to
// surface but won't chew through protected/player blocks. Stops early once we break out
// into open sky even if that's below targetY (no point digging a hill from the inside).
async function climbToSurface (bot, targetY, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const prev = bot.pathfinder && bot.pathfinder.movements
  const need = () => bot.entity && Math.floor(bot.entity.position.y) < targetY - 1 &&
    hasSolidCeiling(bot) && !isStopped()
  try {
    // 1) SPIRAL STAIRCASE up - cuts a WALKABLE ramp to the surface (fast, and once up we
    //    can just walk on out). Proven to clear tens of blocks of solid overburden. The
    //    flee reflex is held off (escaping flag) so mobs can't drag us off it mid-climb.
    if (need()) {
      if (bot.pathfinder) bot.pathfinder.setMovements(climbMovements(bot))
      const y0 = bot.entity.position.y
      try { await digStaircaseUp(bot, targetY, { isStopped }) } catch (e) { if (process.env.CLIMB_DEBUG) console.error('[climb] staircase threw', e.message) }
      if (process.env.CLIMB_DEBUG) console.error(`[climb] staircase ${y0.toFixed(1)} -> ${bot.entity.position.y.toFixed(1)} (target ${targetY})`)
    }
    // 2) PILLAR STRAIGHT UP as a fallback - if the staircase stalls (awkward/open cavern
    //    geometry it can step off of), rise on a 1-wide column that can't be fallen off.
    if (need()) {
      const y0 = bot.entity.position.y
      try { await pillarUpTo(bot, targetY, { isStopped }) } catch (e) { if (process.env.CLIMB_DEBUG) console.error('[climb] pillar threw', e.message) }
      if (process.env.CLIMB_DEBUG) console.error(`[climb] pillar ${y0.toFixed(1)} -> ${bot.entity.position.y.toFixed(1)}`)
    }
  } finally {
    if (prev && bot.pathfinder) bot.pathfinder.setMovements(prev)
  }
}

// Pillar STRAIGHT UP to targetY: dig any block above the head, then jump and - at the top
// of the hop, once we've actually cleared a block - place a filler block underfoot. The
// mob-safest escape: you rise onto a 1-wide column above ground mobs and can't be walked
// back down into the pit. Stops on lava/water above, out of filler, or protected blocks.
async function pillarUpTo (bot, targetY, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (insideOwnStructure(bot)) { dbg('  pillar: inside my own hut - not pillaring through the roof'); return }
  const startY = Math.floor(bot.entity.position.y)
  let stuck = 0
  let equippedFiller = null
  while (Math.floor(bot.entity.position.y) < targetY && !isStopped() && stuck < 15) {
    // Stop the MOMENT we break into open sky (no ceiling) - keeping on to targetY builds a
    // useless 1x1 tower into the air and strands the bot on top (targetY is a rough surface
    // guess and overshoots in valleys). Once above where we started with clear sky, we're out.
    if (Math.floor(bot.entity.position.y) > startY && !hasSolidCeiling(bot, 20, { ignoreLeaves: true })) break
    const y0 = Math.floor(bot.entity.position.y)
    const feet = bot.entity.position.floored()
    // Clear TWO blocks above our head (y+2 and y+3): a full jump-up needs the head to pass
    // y+3, so clearing only y+2 caps the hop just short of a block and placements miss.
    for (const up of [2, 3]) {
      const above = bot.blockAt(feet.offset(0, up, 0))
      if (above && !AIRISH(above.name)) {
        if (/lava|water/.test(above.name)) { bot.clearControlStates(); return }
        if (!canBreakNaturally(above) && !scaffoldDigOK(above)) { bot.clearControlStates(); return } // anti-grief: don't pillar up through a build (own registry-proven scaffold allowed under NAV_TERRAIN_PROFILE)
        if (bot.canDigBlock && !bot.canDigBlock(above)) { bot.clearControlStates(); return }
        const tool = toolForBlock(bot, above.name)
        if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
        try { await bot.dig(above) } catch {}
        equippedFiller = null // we swapped to a tool
      }
    }
    // The FEET cell must be empty to receive the placed block: a sapling/bush standing in
    // it silently blocks EVERY placement - the bot jump-placed on its own orchard sapling
    // forever (operator watched it live). Soft vegetation only; anything solid we ride.
    const inFeet = bot.blockAt(feet)
    if (inFeet && !AIRISH(inFeet.name) && /sapling|_propagule$|grass|fern|flower|dead_bush|snow|vine/.test(inFeet.name)) {
      try { await bot.dig(inFeet); await new Promise(r => setTimeout(r, 150)) } catch {}
    }
    // dirt FIRST: cobble towers in the orchard read as stone litter (operator), and the
    // leveler has to shave them - dirt pockets back into scaffold supply instead.
    const filler = scaffold.pickFiller(bot)
    if (!filler) { bot.clearControlStates(); return } // nothing to pillar with
    if (equippedFiller !== filler.name) { await bot.equip(filler, 'hand').catch(() => {}); equippedFiller = filler.name }
    const ref = bot.blockAt(feet.offset(0, -1, 0)) // the block we're standing on
    if (ref && !AIRISH(ref.name)) {
      try { await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true) } catch {}
      bot.setControlState('jump', true)
      const t = Date.now()
      // wait until we've genuinely risen ~1 block, THEN place (fixed sleeps miss the apex)
      while (Date.now() - t < 1000 && !isStopped()) {
        await new Promise(r => setTimeout(r, 15))
        if (bot.entity.position.y - y0 >= 1.0) {
          // the placeBlock wrapper (pathfix) verifies against the world - no exception
          // means the block is really there; register it as tower scaffold for teardown
          try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); scaffold.add(feet, 'pillar') } catch { await new Promise(r => setTimeout(r, 150)) }
          break
        }
      }
      bot.setControlState('jump', false)
    }
    await new Promise(r => setTimeout(r, 90)) // settle onto the new block
    if (Math.floor(bot.entity.position.y) <= y0) stuck++; else { stuck = 0 }
  }
  bot.clearControlStates()
}

// Cheap ADJACENT step for the mining loops (the mine-one-pause-one fix): walk ONE block into
// a cell the dig loop just cleared and floor-verified, driving controls directly instead of
// re-issuing a full pathfinder goto per block. Look at the cell centre at ~eye height, hold
// forward (+ a jump when stepping UP), poll ~20ms until our floored position is the cell (or
// we're within 0.35b of its centre horizontally), hard-capped by `ms`. ALWAYS clears controls
// in `finally` so a survival flee/defend reflex firing after the loop breaks gets clean
// controls (same discipline as pillarUpTo). Returns whether we arrived. Never digs or places.
async function stepInto (bot, cell, { jump = false, ms = 1200, isStopped = () => false } = {}) {
  if (process.env.LAVA_SAFE !== '0') { // #41 belt-and-braces for EVERY caller: never walk into a lava cell or onto a lava floor (death 2 walked sideways into lava). Returning false falls through to the caller's pathfinder goto, which refuses lava cells natively.
    const dst = bot.blockAt(cell); const dstFloor = bot.blockAt(cell.offset(0, -1, 0))
    if ((dst && mining.LAVA_RE.test(dst.name)) || (dstFloor && mining.LAVA_RE.test(dstFloor.name))) { dbg('  stepInto: lava at/under ' + cell.toString() + ' - refusing to step in'); return false }
  }
  let arrived = false
  try {
    try { await bot.lookAt(cell.offset(0.5, 1.5, 0.5), true) } catch {} // aim at ~eye height of the target cell
    bot.setControlState('forward', true)
    if (jump) bot.setControlState('jump', true)
    const t = Date.now()
    const cx = cell.x + 0.5; const cz = cell.z + 0.5
    while (Date.now() - t < ms && !isStopped()) {
      await new Promise(r => setTimeout(r, 20))
      const p = bot.entity.position.floored()
      const horiz = Math.hypot(bot.entity.position.x - cx, bot.entity.position.z - cz)
      if ((p.x === cell.x && p.y === cell.y && p.z === cell.z) || horiz < 0.35) { arrived = true; break }
    }
  } finally {
    bot.clearControlStates()
  }
  return arrived
}

// Mine a straight horizontal 1x2 TUNNEL forward, collecting drops at our feet so cobble
// isn't lost down a pit (the generic loop mined the floor and dropped it into the hole).
// Digs the two blocks ahead (feet + head level), sweeps drops, steps in, repeats. Safe:
// stops at lava/water or a missing floor (cave). Returns net `itemName` gained.
async function mineTunnel (bot, itemName, maxLen, dirIdx, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const DANGER = /lava|water/
  const DIRS = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]
  const dir = DIRS[((dirIdx % 4) + 4) % 4]
  const before = countItem(bot, itemName)
  const FLUID = process.env.MINE_FLUID !== '0'
  const LAVA_SAFE = process.env.LAVA_SAFE !== '0' // #41: close residual holes (ceiling pocket above the new head; FLUID - not just open air - beyond the face)
  const SWEEP_EVERY = parseInt(process.env.MINE_SWEEP_EVERY || '4', 10)
  const oreWord = String(itemName).replace(/^raw_/, '')
  for (let i = 0; i < maxLen && !isStopped(); i++) {
    if (mineDanger(bot)) break // hostile close / hp low -> return control to the gather's survival reflex (don't stay locked in dig-awaits taking hits)
    const feet = bot.entity.position.floored()
    const ahead = feet.plus(dir)
    const aheadUp = ahead.offset(0, 1, 0)
    const floor = ahead.offset(0, -1, 0)
    const fB = bot.blockAt(floor)
    if ([ahead, aheadUp, floor].some(p => { const b = bot.blockAt(p); return b && DANGER.test(b.name) })) break
    if (!fB || AIRISH(fB.name)) break // drop/cave ahead -> stop (don't walk into a hole)
    // DON'T OPEN A CAVERN naked: if the cells one step BEYOND the face are already open
    // air, breaking in exposes us to whatever's in the dark cave (the zombie+skeleton
    // ambush that killed the gearup bot came from tunnelling into an open cave at y39).
    const beyond = ahead.plus(dir)
    const bBeyond = bot.blockAt(beyond); const bBeyondUp = bot.blockAt(beyond.offset(0, 1, 0))
    if ((bBeyond && AIRISH(bBeyond.name)) && (bBeyondUp && AIRISH(bBeyondUp.name))) break
    if (LAVA_SAFE) { // #41 §2c: a ceiling lava pocket ABOVE the new head cell, or FLUID (not just air) one step beyond the face
      const bAbove = bot.blockAt(aheadUp.offset(0, 1, 0)) // = ahead.offset(0,2,0), above the new head cell
      if (mining.digExposureHazard([bAbove && bAbove.name, bBeyond && bBeyond.name, bBeyondUp && bBeyondUp.name]) !== 'ok') break
    }
    let dugAny = false
    for (const p of [aheadUp, ahead]) {
      const b = bot.blockAt(p)
      if (!b || AIRISH(b.name)) continue
      if (!canBreakNaturally(b)) { return countItem(bot, itemName) - before } // anti-grief: hit a player block -> stop tunnelling
      const tool = toolForBlock(bot, b.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(b)) { return countItem(bot, itemName) - before }
      try { await bot.dig(b); dugAny = true } catch { return countItem(bot, itemName) - before }
    }
    // BATCHED HARVEST (mine-one-pause-one fix): drops persist 5 min and walking forward into
    // the just-dug cell auto-collects them, so sweep on a cadence (every SWEEP_EVERY steps),
    // not every step - killing the per-step 250ms sleeps + drop-chase gotos. On a sweep step
    // widen the bycatch radius 3->5 so the skipped steps' wall ore is still covered. Under
    // MINE_FLUID=0 this fires every step at radius 3 = today's byte-for-byte cadence. The
    // COAL BYCATCH (furnace fuel) + TARGET-ORE BYCATCH (iron veins exposed in the WALLS that a
    // dead-ahead tunnel would slide past - the reason deep tunnels returned got=0) run here.
    if (!FLUID || mining.sweepDue(i, SWEEP_EVERY)) {
      const rr = FLUID ? 5 : 3
      await collectDrops(bot, 3)
      try { await grabNearbyOre(bot, /coal_ore$/, rr, 2, { isStopped }) } catch {}
      if (oreWord && oreWord !== itemName) { try { await grabNearbyOre(bot, new RegExp(oreWord + '_ore$'), rr, 5, { isStopped }) } catch {} }
    }
    // CHEAP ADJACENT STEP: the cell was just dug clear (above) with a floor-verified solid
    // tread - walk into it directly instead of re-planning a 1-block pathfinder goto. Only on
    // !arrived (1.2s cap missed) fall through to today's exact per-block goto.
    let arrived = false
    if (FLUID) { arrived = await stepInto(bot, ahead, { isStopped }) }
    if (!arrived) { try { await gotoWithTimeout(bot, new goals.GoalBlock(ahead.x, ahead.y, ahead.z), 5000) } catch { break } }
    if (!dugAny) break
  }
  // FINAL SWEEP: bank everything left on the floor so the return count + branchMine's got()
  // are accurate and nothing's stranded. Runs on EVERY break path (blocked/end-of-run) because
  // it's after the loop. SKIP it if a hostile/hp crisis broke the loop - danger first, drops
  // are recoverable (5-min despawn). (MINE_FLUID=0 keeps today's no-final-sweep cadence.)
  if (FLUID && !mineDanger(bot)) {
    await collectDrops(bot, 5)
    try { await grabNearbyOre(bot, /coal_ore$/, 5, 2, { isStopped }) } catch {}
    if (oreWord && oreWord !== itemName) { try { await grabNearbyOre(bot, new RegExp(oreWord + '_ore$'), 5, 5, { isStopped }) } catch {} }
  }
  return countItem(bot, itemName) - before
}

// ---- ORGANIZED BRANCH MINE (mining-strategy-design.md) ---------------------------------
// Place a torch on the floor beneath us if we carry one - lights the mine so mobs don't
// spawn in the fresh tunnels (a lightly-armored bot dies to a dark-cave ambush). Best-effort.
async function placeTorch (bot) {
  const torch = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'torch')
  if (!torch) return false
  const feet = bot.entity.position.floored()
  // place on the floor of an ADJACENT open cell (not under our own feet - we occupy that):
  // stand-in-tunnel, torch on the ground beside us. Best-effort across the 4 neighbours.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const side = feet.offset(dx, 0, dz)
    const cell = bot.blockAt(side); const floor = bot.blockAt(side.offset(0, -1, 0))
    if (cell && AIRISH(cell.name) && floor && floor.boundingBox === 'block' && !/lava|water/.test(floor.name)) {
      try { await bot.equip(torch, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)); return true } catch { /* try next side */ }
    }
  }
  return false
}

// Make a few torches so the mine can be lit: coal/charcoal (1) + stick (1) -> 4 torches, no
// table needed. Best-effort - the bot picks up coal as bycatch while tunnelling, and carries
// sticks from tool-crafting; if it has neither it just mines darker (the efba7bd reflex is
// the backstop). Never throws.
async function ensureTorches (bot, want = 8) {
  try {
    if (countItem(bot, 'torch') >= want) return
    const mcData = require('minecraft-data')(bot.version)
    const torch = mcData.itemsByName.torch
    if (!torch) return
    for (let i = 0; i < 4 && countItem(bot, 'torch') < want; i++) {
      const recipe = (bot.recipesFor(torch.id, null, 1, null) || [])[0] // inventory 2x2 crafting - no table
      if (!recipe) break
      try { await bot.craft(recipe, 1, null); await new Promise(r => setTimeout(r, 150)) } catch { break }
    }
    if (countItem(bot, 'torch') > 0) dbg('  mine: have ' + countItem(bot, 'torch') + ' torches to light the tunnels')
  } catch { /* best-effort */ }
}

// ---- SELF-SUFFICIENT tooling at depth -------------------------------------------------
// Pickaxes in the pack (stone-or-better - the tier that actually drops iron/stone), with
// their remaining uses. A deep mine wears these out; if none has uses left the bot can't
// mine and (before this) got dragged to a surface table -> stranded on cave terrain (live).
function miningPicks (bot) {
  return (bot.inventory ? bot.inventory.items() : [])
    .filter(i => /(stone|iron|diamond|netherite)_pickaxe$/.test(i.name))
    .map(i => ({ item: i, usesLeft: mining.pickUsesLeft(i.name, i.durabilityUsed || 0) }))
}
function bestPick (bot) { let b = null; for (const p of miningPicks(bot)) if (p.usesLeft > 0 && (!b || p.usesLeft > b.usesLeft)) b = p; return b }
function workingPickCount (bot) { return miningPicks(bot).filter(p => p.usesLeft > 0).length }
function workingMiningPick (bot) { return !!bestPick(bot) }
function carriedPickUsesLeft (bot) { return miningPicks(bot).reduce((s, p) => s + p.usesLeft, 0) }

// Craft ONE of `itemName` from carried ingredients at `tableBlock` (or the 2x2 grid when
// null). Best-effort, never throws. Returns whether one was made.
async function craftOneFromInv (bot, itemName, tableBlock = null) {
  const mcData = require('minecraft-data')(bot.version)
  const it = mcData.itemsByName[itemName]; if (!it) return false
  const rec = (bot.recipesFor(it.id, null, 1, tableBlock) || [])[0]
  if (!rec) return false
  const before = countItem(bot, itemName)
  try { await bot.craft(rec, 1, tableBlock || undefined); await new Promise(r => setTimeout(r, 150)) } catch { return false }
  return countItem(bot, itemName) > before
}

// Craft a stone pickaxe RIGHT HERE (surface OR depth) - LOCAL only, never walking to a
// remembered surface table (that walk is the stranding). Mines a little cobble with the
// still-working pick if short (why we re-tool BEFORE the pick breaks), tops up sticks from
// carried planks, places a carried/crafted table beside us, and crafts. Returns success.
async function craftStonePickHere (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  // 1) cobble: 3 per pick. Mine surrounding natural stone with the (still-working) pick -
  //    wider search than the tight bycatch radius so it can grab the last block or two at the
  //    surface too (the up-front kit reported "have 2" and provisioned nothing, live).
  if (countItem(bot, 'cobblestone') < 3 && workingMiningPick(bot)) {
    try { await grabNearbyOre(bot, /^(stone|cobblestone|deepslate|cobbled_deepslate|granite|diorite|andesite|tuff)$/, parseInt(process.env.MINE_COBBLE_RADIUS || '8', 10), 4, { isStopped }) } catch {}
  }
  if (countItem(bot, 'cobblestone') < 3) { dbg('  reTool: not enough cobble to craft a pick (have ' + countItem(bot, 'cobblestone') + ') - skipping, will re-tool at depth where stone is everywhere'); return false }
  // 2) sticks: 2 per pick. Cannot be mined - make from carried planks, else fail honestly.
  if (countItem(bot, 'stick') < 2) { await craftOneFromInv(bot, 'stick'); if (countItem(bot, 'stick') < 2) { dbg('  reTool: no sticks and no planks to make them - cannot re-tool here'); return false } }
  // 3) a table WITHIN REACH: reuse one placed nearby, else place a carried one, else craft
  //    one from carried planks. NEVER goto a far/remembered table (the stranding walk).
  let tb = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 })
  if (!tb) {
    if (countItem(bot, 'crafting_table') < 1) { if (!await craftOneFromInv(bot, 'crafting_table')) { dbg('  reTool: no crafting table and no planks to make one'); return false } }
    let pos = null
    try { pos = await placeFromInventory(bot, 'crafting_table') } catch {}
    tb = pos ? bot.blockAt(pos) : bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 })
  }
  if (!tb) { dbg('  reTool: could not place a table at depth'); return false }
  // 4) craft the pick at the local table
  const ok = await craftOneFromInv(bot, 'stone_pickaxe', tb)
  if (ok) dbg('  reTool: crafted a fresh stone pickaxe at depth (y=' + Math.floor(bot.entity.position.y) + ')')
  return ok && workingMiningPick(bot)
}

// UP-FRONT mining kit (surface, before the descent): carry enough pick durability for the
// excursion + a table + sticks so a break at depth is re-tooled IN PLACE, never a surface
// round-trip. Best-effort with carried materials (the bot already made its first stone pick,
// so it has cobble/planks/sticks around); depth re-tool + honest bail cover any shortfall.
async function ensureMiningKit (bot, depth, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  // a table to carry for depth re-tool
  if (countItem(bot, 'crafting_table') < 1) await craftOneFromInv(bot, 'crafting_table')
  // sticks buffer (can't be mined at depth): craft a handful from carried planks
  const wantSticks = parseInt(process.env.MINE_KIT_STICKS || '8', 10)
  for (let i = 0; i < 4 && countItem(bot, 'stick') < wantSticks && !isStopped(); i++) { if (!await craftOneFromInv(bot, 'stick')) break }
  // spare stone picks sized to the expected dig (bounded so we don't over-grind cobble)
  const estBlocks = mining.estExcursionBlocks(depth, { branches: parseInt(process.env.MINE_KIT_BRANCHES || '6', 10), branchLen: parseInt(process.env.MINE_BRANCH_LEN || '12', 10), spacing: parseInt(process.env.MINE_SPACING || '3', 10) })
  const maxPicks = parseInt(process.env.MINE_MAX_PICKS || '4', 10)
  const toCraft = Math.min(maxPicks, mining.picksToCraft(carriedPickUsesLeft(bot), estBlocks))
  for (let i = 0; i < toCraft && !isStopped(); i++) { if (!await craftStonePickHere(bot, { isStopped })) break }
  dbg('  ensureMiningKit: stone_picks=' + countItem(bot, 'stone_pickaxe') + ' pickUsesLeft=' + carriedPickUsesLeft(bot) + ' table=' + countItem(bot, 'crafting_table') + ' sticks=' + countItem(bot, 'stick') + ' (est ' + estBlocks + ' blocks, wanted ' + toCraft + ' spares)')
}

// Dig a single WALKABLE staircase DOWN to targetY (one entrance, back-out-able - the fix
// for N scattered vertical shafts). Each step clears the forward feet+head cells and the
// forward-down tread, then walks onto it. SAFETY: never step onto lava/water/void - probe
// the landing's floor first (mining.descentSafety). Returns { reached, reason, blocked }
// where `blocked` (lava/water/void) tells branchMine to relocate the entrance.
async function digStaircaseDown (bot, targetY, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const dirIdx = ((opts.dirIdx || 0) % 4 + 4) % 4
  const [ddx, ddz] = mining.DIRS[dirIdx]
  const dir = new Vec3(ddx, 0, ddz)
  const FLUID = process.env.MINE_FLUID !== '0'
  const LAVA_SAFE = process.env.LAVA_SAFE !== '0' // #41 §2c: descentSafety only probes UNDER the tread; a pool beside/above the dug cells still pours in
  const stopWhen = opts.stopWhen || null // optional early-stop (stone-relocate: stop once enough cobble is in hand). Absent -> today byte-for-byte.
  let steps = 0
  while (Math.floor(bot.entity.position.y) > targetY && !isStopped() && steps < 96 && !(stopWhen && stopWhen())) {
    if (mineDanger(bot)) return { reached: false, reason: 'hostile/hp during descent', blocked: null }
    const feet = bot.entity.position.floored()
    const ahead = feet.plus(dir)            // forward at feet level
    const aheadUp = ahead.offset(0, 1, 0)   // forward head clearance
    const step = ahead.offset(0, -1, 0)     // the tread we descend onto
    const stepFloor = step.offset(0, -1, 0) // what our feet will stand on after stepping
    const stepFloor2 = step.offset(0, -2, 0)
    const fb = bot.blockAt(stepFloor); const fb2 = bot.blockAt(stepFloor2)
    const safety = mining.descentSafety(fb && fb.name, fb2 && fb2.name)
    if (safety !== 'ok') { dbg('  staircase: ' + safety + ' under the next tread at ' + step.toString() + ' - stopping this shaft'); return { reached: false, reason: safety + ' below', blocked: safety } }
    if (LAVA_SAFE) { // #41: fluid in a SIDE/ABOVE neighbour of the cells we're about to open -> relocate the entrance (branchMine already knows how)
      const nb = []
      for (const cell of [aheadUp, ahead, step]) { for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) { const b = bot.blockAt(cell.offset(dx, dy, dz)); nb.push(b && b.name) } }
      const hz = mining.digExposureHazard(nb)
      if (hz !== 'ok') { dbg('  staircase-down: ' + hz + ' beside the face at ' + step.toString() + ' - relocating entrance'); return { reached: false, reason: hz + ' beside face', blocked: hz } }
    }
    // don't break INTO an open cavern (dark mob ambush) - if the tread cell and its head are
    // already open air with more air beyond, hand back to relocate rather than crack it open.
    const dig = async (p) => {
      const b = bot.blockAt(p)
      if (!b || AIRISH(b.name)) return true
      if (/lava|water/.test(b.name)) return false
      if (!canBreakNaturally(b)) return false
      const tool = toolForBlock(bot, b.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(b)) return false
      try { await bot.dig(b) } catch { return false }
      return true
    }
    if (!(await dig(aheadUp)) || !(await dig(ahead)) || !(await dig(step))) { return { reached: false, reason: 'blocked face', blocked: 'void' } }
    if (!FLUID) await collectDrops(bot, 2) // MINE_FLUID=0: legacy per-step sweep (fluid batches into the steps%4 sweep below)
    // CHEAP ADJACENT STEP down onto the just-cleared, descentSafety-verified tread; only fall
    // through to today's exact per-step goto if the manual step doesn't land in time.
    let arrived = false
    if (FLUID) { arrived = await stepInto(bot, step, { isStopped }) }
    if (!arrived) {
      try { await gotoWithTimeout(bot, new goals.GoalBlock(step.x, step.y, step.z), 6000) } catch {
        if (FLUID && !mineDanger(bot)) await collectDrops(bot, 4) // bank this step's fresh drops on the "could not step down" exit
        return { reached: false, reason: 'could not step down', blocked: null }
      }
    }
    steps++
    // opportunistic: light the descent every few steps + grab coal exposed in the staircase
    // walls (cheap, bounded - coal is fuel + torches; don't sidetrack far mid-descent). Under
    // FLUID the batched drop-sweep (radius 4, covers 4 treads) folds in here too.
    if (steps % 4 === 0) { await placeTorch(bot).catch(() => {}); if (FLUID) await collectDrops(bot, 4); try { await grabNearbyOre(bot, /coal_ore$/, 3, 2, { isStopped }) } catch {} }
  }
  if (FLUID && !mineDanger(bot)) await collectDrops(bot, 4) // final sweep: bank the descent's drops (danger-first: skip under threat)
  return { reached: Math.floor(bot.entity.position.y) <= targetY + 1, reason: 'at level', blocked: null }
}

// ---- PERSISTENT MINE (world-memory 'mines'): remember a dug mine so the next excursion
// RE-ENTERS it instead of re-digging the descent (on cave terrain the descent ate the whole
// excursion, gathered:0 "out of time" - live). A mine record: entrance {x,z}+top (surface),
// level (mining Y), lx/lz (staircase bottom), dirIdx (corridor dir), tip {x,y,z} (corridor
// end - where to resume), branches (count done), at.
function loadMines () { const m = loadWorldMem(); return (m.mines = m.mines || []) }
function rememberMine (entry) {
  const mines = loadMines()
  const i = mines.findIndex(e => Math.hypot(e.x - entry.x, e.z - entry.z) <= 3)
  const rec = { ...(i >= 0 ? mines[i] : {}), ...entry, at: Date.now() }
  if (i >= 0) mines[i] = rec; else mines.push(rec)
  if (mines.length > 8) { mines.sort((a, b) => b.at - a.at); mines.length = 8 }
  saveWorldMem()
  return rec
}
function recallMine (bot, near, maxDist, opts = {}) {
  const now = Date.now()
  let best = null; let bd = Infinity
  for (const e of loadMines()) {
    if (!mining.mineReusable(e, near, { maxDist, now, ...opts })) continue
    const d = Math.hypot(e.x - near.x, e.z - near.z); if (d < bd) { bd = d; best = e }
  }
  return best
}
function forgetMine (entry) {
  const m = loadWorldMem(); if (!m.mines) return
  m.mines = m.mines.filter(e => !(Math.abs(e.x - entry.x) <= 3 && Math.abs(e.z - entry.z) <= 3))
  saveWorldMem()
}
function updateMineProgress (entry, branches, tip) {
  const mines = loadMines()
  const i = mines.findIndex(e => Math.abs(e.x - entry.x) <= 3 && Math.abs(e.z - entry.z) <= 3)
  if (i >= 0) { mines[i].branches = branches; if (tip) mines[i].tip = { x: tip.x, y: tip.y, z: tip.z }; mines[i].at = Date.now(); saveWorldMem() }
}

// Walk to a remembered mine's entrance and descend the EXISTING staircase to the mining
// level, then to the corridor tip - NO re-digging (the whole point). VERIFIES on arrival
// (world-read: reached the level and it isn't flooded); returns false if the staircase is
// gone/blocked/flooded so branchMine digs fresh + re-persists.
async function enterExistingMine (bot, mine, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const here = bot.entity.position
  // 1) to the entrance XZ at the surface (staged trek for a far mine)
  if (Math.hypot(here.x - mine.x, here.z - mine.z) > 4) {
    try { await walkStaged(bot, mine.x, mine.z, { isStopped, range: 3, timeoutMs: 60000 }) } catch {}
    try { await gotoWithTimeout(bot, new goals.GoalNearXZ(mine.x, mine.z, 2), 20000) } catch {}
  }
  if (isStopped()) return false
  // 2) walk DOWN the open staircase to the mining level (no dig - it's already cut)
  const lx = mine.lx != null ? mine.lx : mine.x; const lz = mine.lz != null ? mine.lz : mine.z
  try { await gotoWithTimeout(bot, new goals.GoalNear(lx, mine.level, lz, 2), 40000) } catch {}
  if (Math.abs(Math.floor(bot.entity.position.y) - mine.level) > 3) {
    dbg('  reEnter: could not reach the mine level (y' + Math.floor(bot.entity.position.y) + ' vs ' + mine.level + ') - staircase gone/blocked, digging fresh')
    return false
  }
  if (inWaterNow(bot)) { dbg('  reEnter: mine is flooded - abandoning it'); return false }
  // 3) to the corridor tip so we mine FRESH stone, not re-walk the open corridor
  if (mine.tip) { try { await gotoWithTimeout(bot, new goals.GoalNear(mine.tip.x, mine.tip.y, mine.tip.z, 2), 30000) } catch {} }
  dbg('  reEnter: back in my mine at y' + Math.floor(bot.entity.position.y) + ' (level ' + mine.level + ', ' + (mine.branches || 0) + ' branches done) - MINING, not re-digging')
  return true
}

// ONE organized branch mine for a DEEP ore (iron/gold/copper/...). Descends a single
// staircase to the iron band (~y16, mining.targetMineY) - relocating the entrance on
// water/lava/void instead of stalling - then drives a central corridor with perpendicular
// branches (classic 2-3-spaced branch mine: far more ore per hole than the old scattered
// shafts), torch-lit, with ore-in-the-walls bycatch. RE-ENTERS a persisted mine when one
// exists (spend the budget mining, not re-descending). Danger (mob closes / hp crashes) ->
// climb out and bail to the deployed survival reflexes. Bounded by count + a wall-clock
// deadline + a branch cap. Returns { gathered, reason }.
async function branchMine (bot, item, count, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const start = countItem(bot, item)
  const got = () => countItem(bot, item) - start
  const surfaceY = opts.surfaceY != null ? opts.surfaceY : Math.floor(bot.entity.position.y)
  // ARMOR-MODULATED DEPTH: a naked bot digs shallower/shorter with fewer torches so it doesn't
  // die on the same deep excursion an armored bot survives (naked-deep deaths, live). NEVER
  // blocks - iron armor needs iron, so it only TUNES the plan (food is still owned by the
  // start-gate below). Env IRON_TARGET_Y (armored) / MINE_NAKED_Y (naked) override the target.
  const plan = mining.deepMinePlan(armorPieceCount(bot), {
    targetY: process.env.IRON_TARGET_Y != null ? parseInt(process.env.IRON_TARGET_Y, 10) : undefined,
    nakedY: process.env.MINE_NAKED_Y != null ? parseInt(process.env.MINE_NAKED_Y, 10) : undefined
  })
  const targetY = mining.targetMineY(surfaceY, {
    targetY: plan.targetY,
    hardFloor: parseInt(process.env.MINE_HARD_FLOOR || '5', 10)
  })
  const deadline = Date.now() + (opts.deadlineMs || 300000)
  const oreRe = new RegExp(String(item).replace(/^raw_/, '') + '_ore$')
  // Any depth at/below this is a WORTHWHILE iron level - branch-mine there rather than
  // burning relocations chasing the ideal targetY through cave-riddled terrain (env-tunable).
  const minIronY = parseInt(process.env.MIN_IRON_Y || '40', 10)
  const goodEnough = () => mining.worthMiningHere(bot.entity.position.y, { minIronY })
  const pickLow = parseInt(process.env.MINE_PICK_LOW || '20', 10)
  dbg('  branchMine: item=' + item + ' need=' + count + ' surfaceY=' + surfaceY + ' targetY=' + targetY + ' minIronY=' + minIronY)

  // JOB ARBITER (survive > progress): a progress job (deep mining) may not START while an
  // unmet SURVIVE need exists - the ONE authority replaces the old scattered food<14 check.
  // If the need is food, resolve it (secureFood) and re-check; any other need (threat/hp/lava/
  // shelter) -> yield the excursion so the survival reflexes handle it, resume next pass.
  {
    let need = survivalNeed(bot) // start-gate: foodThreshold 14
    if (need && !isStopped()) {
      dbg('  branchMine: SURVIVE need before descending: ' + need.need + ' (' + need.reason + ') - resolving before progress')
      if (need.need === 'food') {
        if (opts.say) say('too hungry to mine deep - eating first')
        try { await secureFood(bot, { home: opts.home, isStopped, say: opts.say, threshold: 14 }) } catch (e) { dbg('  branchMine: pre-mine secureFood failed (' + e.message + ')') }
        need = survivalNeed(bot)
      }
      if (need) return { gathered: got(), reason: 'yielding to survival need (' + need.need + ') before descending - resume when met' }
    }
  }

  // SELF-SUFFICIENT TOOLING: keep a working pickaxe at depth. Re-tool BEFORE the held pick
  // breaks (while it can still mine the cobble a new pick needs) and only when no spare
  // exists. Returns whether we still have a working pick after the attempt. Never walks to a
  // surface table (that round-trip is the stranding bug). Called each junction + after descent.
  const keepPickReady = async () => {
    const bp = bestPick(bot)
    const spares = workingPickCount(bot) - (bp ? 1 : 0)
    if (mining.needReTool(bp ? bp.usesLeft : 0, spares, { low: pickLow })) {
      dbg('  branchMine: pick low (' + (bp ? bp.usesLeft : 0) + ' uses, ' + spares + ' spare) - re-tooling AT DEPTH, not climbing out')
      if (opts.say && !bp) say('pick\'s worn out - making a fresh one down here')
      await craftStonePickHere(bot, { isStopped })
    }
    return workingMiningPick(bot)
  }

  const persist = process.env.MINE_PERSIST !== '0'
  let corridorDir = opts.dirIdx || 0
  let mineRec = null
  let startBranches = 0

  // 0) RE-ENTER a remembered mine instead of re-digging the descent - the whole point on
  // cave terrain (a fresh descent ate the entire excursion, gathered:0). If a reachable mine
  // exists, walk in and pick up mining where we left off; only dig fresh if it's gone/flooded.
  if (persist && Math.floor(bot.entity.position.y) > targetY + 1 && !isStopped()) {
    const depthGate = process.env.MINE_REUSE_DEPTH_GATE !== '0'
    const remembered = recallMine(bot, bot.entity.position,
      parseInt(process.env.MINE_REUSE_DIST || '80', 10),
      depthGate ? { maxLevelY: minIronY } : {})
    if (remembered) {
      if (opts.say) say('heading back to my mine to keep digging')
      if (await enterExistingMine(bot, remembered, { isStopped })) {
        mineRec = remembered; corridorDir = remembered.dirIdx || 0; startBranches = remembered.branches || 0
      } else { forgetMine(remembered) }
    }
  }

  // 1) DESCEND ONCE (only if we didn't re-enter), sited off the hut apron so the camp doesn't
  // get riddled with holes.
  if (!mineRec && Math.floor(bot.entity.position.y) > targetY + 1) {
    if (onHutApron(bot)) {
      // Shared 4-direction step-off (STONE_RELOCATE=0 -> today's single +12,+12 one-shot).
      if (!(await stepOffApron(bot, { isStopped, tag: 'branchMine' }))) { dbg('  branchMine: still on apron - not mining the doorstep'); return { gathered: 0, reason: 'too close to home to dig here' } }
    }
    if (opts.say) say('digging down to the iron level (~y' + targetY + ')')
    // the entrance = the surface top of this staircase (persisted so we re-enter here)
    const entrance = { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z), top: Math.floor(bot.entity.position.y) }
    let reached = false
    for (let reloc = 0; reloc < 4 && !reached && !isStopped() && Date.now() < deadline; reloc++) {
      const r = await digStaircaseDown(bot, targetY, { isStopped, dirIdx: reloc })
      if (r.reached) { reached = true; break }
      if (mineDanger(bot)) break
      // pick wore out on the way down -> re-tool HERE and keep descending (don't relocate/bail)
      if (!workingMiningPick(bot)) { if (await keepPickReady()) { reloc--; continue } else { dbg('  branchMine: pick broke mid-descent and cannot re-tool - stopping the descent'); break } }
      // GOOD-ENOUGH DEPTH (the live gap): a cave/void/water blocked the last stretch, but we're
      // already at a worthwhile iron depth (e.g. y28) - STOP relocating and MINE HERE instead
      // of chasing y16 through cave-riddled ground and returning empty. The hit cave is an
      // opportunity: it exposes ore and the branch loop's wall-bycatch works it.
      if (goodEnough()) { dbg('  branchMine: descent stopped at y=' + Math.floor(bot.entity.position.y) + ' (' + r.reason + ') - a workable iron depth, mining HERE not chasing y' + targetY); break }
      // still too shallow: relocate the entrance (sidestep) and retry a fresh staircase.
      dbg('  branchMine: descent blocked (' + r.reason + ') and still shallow (y=' + Math.floor(bot.entity.position.y) + ') - relocating the entrance')
      const p = bot.entity.position; const [sx, sz] = mining.DIRS[(reloc + 1) % 4]
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(Math.round(p.x + sx * 4), Math.round(p.z + sz * 4), 2), 12000) } catch {}
    }
    // Only bail if we NEVER got meaningfully below the surface; otherwise fall through and
    // branch-mine at whatever depth we reached. THE LIVE GAP (16:45, live base): it bailed at
    // y46 - an iron-viable depth, and SHALLOWER than the old y30 strip - because y46 > minIronY
    // (40) so goodEnough() was false. Iron spawns from ~y72 down, so any real descent is worth
    // mining. mineableWhenBlocked is the permissive floor for the blocked case: mine here if we
    // descended a real distance (>=12) or are below the iron ceiling (y52), never return empty.
    const mineableNow = () => mining.mineableWhenBlocked(bot.entity.position.y, surfaceY)
    if (!reached && !goodEnough() && !mineableNow()) {
      return { gathered: got(), reason: 'could not get below the surface to any iron level (water/lava/blocked descent, stuck at y' + Math.floor(bot.entity.position.y) + ')' }
    }
    if (!reached && !goodEnough()) {
      dbg('  branchMine: blocked short of y' + targetY + ' but at y' + Math.floor(bot.entity.position.y) + ' (descended ' + (Math.floor(surfaceY) - Math.floor(bot.entity.position.y)) + ') - iron-viable, MINING HERE not returning empty')
      if (opts.say) say('couldn\'t get all the way down, but there\'s iron at this depth - mining here')
    }
    // PERSIST the fresh mine so the NEXT excursion re-enters here (AMORTIZE the descent): even
    // if THIS excursion runs out of time right after descending, the staircase is banked and
    // the next one picks up mining immediately - never re-descend to 0 excursion after excursion.
    if (persist && Math.floor(bot.entity.position.y) < surfaceY - 6) {
      mineRec = rememberMine({ x: entrance.x, z: entrance.z, top: entrance.top, level: Math.floor(bot.entity.position.y), lx: Math.round(bot.entity.position.x), lz: Math.round(bot.entity.position.z), dirIdx: corridorDir, branches: 0, tip: bot.entity.position.floored() })
      dbg('  branchMine: persisted mine entrance ' + entrance.x + ',' + entrance.z + ' level y' + mineRec.level + ' - next excursion re-enters, no re-dig')
    }
  }

  // 2) BRANCH MINE at level: corridor + perpendicular branches, torch-lit.
  // Provision the tool kit HERE (at depth, both fresh-descent and re-entry paths): stone is
  // everywhere down here, so it can actually gather the cobble for spare picks + a table +
  // sticks - fixing the up-front "provisioned 0 spares" (surface had no stone). Mid-descent
  // breaks were already covered by keepPickReady (the staircase dig yields cobble).
  if (Math.floor(bot.entity.position.y) < surfaceY - 4) {
    try { await ensureMiningKit(bot, Math.max(0, Math.floor(surfaceY) - Math.floor(bot.entity.position.y)), { isStopped }) } catch (e) { dbg('  ensureMiningKit failed (' + e.message + ') - relying on depth re-tool') }
  }
  await ensureTorches(bot, plan.wantTorches)
  const L = mining.branchLayout(corridorDir, {
    branchLen: parseInt(process.env.MINE_BRANCH_LEN || '12', 10),
    spacing: parseInt(process.env.MINE_SPACING || '3', 10)
  })
  let branches = startBranches
  const maxBranches = startBranches + (opts.maxBranches || plan.maxBranches)
  while (got() < count && Date.now() < deadline && !isStopped() && branches < maxBranches) {
    if (mineDanger(bot)) {
      dbg('  branchMine: threat/hp down here - climbing out and handing off to the survival reflex')
      if (opts.say && branches < 2) say('mob down here - breaking off the mine to get clear')
      try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch {}
      return { gathered: got(), reason: 'broke off to survive a mob / low hp underground' }
    }
    // DROWNING mid-mine (a branch broke into an aquifer): get the head out of the water FIRST
    // (bounded escapeWater - drops the goal + stops the dig so the manual escape isn't stomped),
    // THEN climb out and bail honestly. Same shape as the food branch. escapeWater before
    // climbToSurface: climbToSurface's digs refuse water, so it must run only once we're clear.
    {
      const need = survivalNeed(bot, { foodThreshold: 6 })
      if (need && need.need === 'drowning') {
        dbg('  branchMine: DROWNING mid-mine (' + need.reason + ') - escaping the water then climbing out')
        if (opts.say) say('the mine flooded - getting out before i drown')
        try { bot.stopDigging() } catch {}
        try { await navigate.escapeWater(bot, { isStopped }) } catch {}
        try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch {}
        return { gathered: got(), reason: 'broke off - the mine flooded' }
      }
    }
    // JOB ARBITER mid-activity (CONTINUE gate, critical thresholds): a normal food dip after
    // descending fed is fine, but a genuine crash (food <=6) or a new danger the mineDanger
    // check above missed -> climb out and yield. One authority, critical foodThreshold=6.
    {
      const need = survivalNeed(bot, { foodThreshold: 6 })
      if (need && need.need === 'food') {
        dbg('  branchMine: food ' + bot.food + ' critical mid-mine (arbiter) - climbing out to eat')
        if (opts.say) say('starving down here - heading up to eat')
        try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch {}
        return { gathered: got(), reason: 'broke off to eat (food ' + bot.food + ') - too hungry to mine deep' }
      }
    }
    // KEEP A WORKING PICK: re-tool at depth before the pick breaks. If it's gone AND we can't
    // make one down here (no cobble/sticks/planks/table), climb out CLEANLY and bail honestly -
    // never wedge deep with a dead pick waiting on a surface craft-regroup (the stranding bug).
    if (!await keepPickReady()) {
      dbg('  branchMine: no working pickaxe and cannot re-tool at depth - climbing out cleanly (not stranded)')
      if (opts.say) say('out of picks down here and can\'t make one - heading back up')
      try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch {}
      return { gathered: got(), reason: 'pickaxe gone and could not re-tool at depth - climbed out' }
    }
    // advance the main corridor `spacing`, then a junction: torch + left branch + right branch
    await mineTunnel(bot, item, L.spacing, L.corridorIdx, { isStopped })
    const junc = bot.entity.position.floored()
    if (branches % L.torchEvery === 0) await placeTorch(bot).catch(() => {})
    await mineTunnel(bot, item, L.branchLen, L.leftIdx, { isStopped })
    try { await gotoWithTimeout(bot, new goals.GoalBlock(junc.x, junc.y, junc.z), 15000) } catch {}
    if (got() >= count || isStopped()) break
    await mineTunnel(bot, item, L.branchLen, L.rightIdx, { isStopped })
    try { await gotoWithTimeout(bot, new goals.GoalBlock(junc.x, junc.y, junc.z), 15000) } catch {}
    try { await grabNearbyOre(bot, oreRe, 4, 6, { isStopped }) } catch {} // ore exposed in the junction walls
    // COAL BYCATCH (regression fix): while branch-mining for iron, also grab any coal_ore in
    // the junction walls - coal = torches (the mine wants light) + smelting fuel, so it's
    // high-value and free. Bounded radius/cap so it never sidetracks far from the branch.
    try { await grabNearbyOre(bot, /coal_ore$/, 4, 3, { isStopped }) } catch {}
    branches++
    // BANK PROGRESS: record the branch count + corridor tip so the next excursion resumes at
    // the fresh face, not the staircase bottom (which would re-walk the open corridor).
    if (persist && mineRec) { try { updateMineProgress(mineRec, branches, junc) } catch {} }
    dbg('  branchMine: junction ' + branches + '/' + maxBranches + ' got=' + got() + '/' + count + ' y=' + Math.floor(bot.entity.position.y))
  }
  return { gathered: got(), reason: got() >= count ? 'done' : (Date.now() >= deadline ? 'out of time' : 'worked the branches') }
}

// Mine up to `max` blocks matching `oreRe` within `r` of the bot - opportunistic bycatch
// while tunnelling (coal for the furnace, etc.). Only natural blocks; best-effort.
async function grabNearbyOre (bot, oreRe, r, max, { isStopped = () => false } = {}) {
  const FLUID = process.env.MINE_FLUID !== '0'
  let got = 0
  const found = bot.findBlocks({ matching: b => b && oreRe.test(b.name), maxDistance: r, count: max }) || []
  for (const p of found) {
    if (isStopped() || got >= max) break
    const b = bot.blockAt(p)
    if (!b || !canBreakNaturally(b)) continue
    // The 6 face-neighbour names, read ONCE for the exposure skip + the fluid safety probe.
    const nb = [p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1), p.offset(0, 1, 0), p.offset(0, -1, 0)]
      .map(q => { const bb = bot.blockAt(q); return bb ? bb.name : null })
    // EXPOSURE: skip ore embedded in solid rock rather than goto'ing at it (the ~7-9 noPath
    // bursts). An open face means it's actually reachable by the mining profile.
    if (!mining.faceExposed(nb)) continue
    // SAFETY (grabNearbyOre lacked it): don't crack an aquifer/lava face onto ourselves.
    if (mining.digExposureHazard(nb) !== 'ok') continue
    try {
      if (bot.entity.position.distanceTo(b.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 6000)
      const tool = toolForBlock(bot, b.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      if (bot.canDigBlock && !bot.canDigBlock(b)) continue
      await bot.dig(b); if (!FLUID) await collectDrops(bot, 2); got++
    } catch { /* skip this one */ }
  }
  // BATCHED: one sweep after the whole vein rather than a per-ore collectDrops - adjacent vein
  // blocks are auto-collected by the gotos between them anyway. (MINE_FLUID=0 = per-ore sweep.)
  if (FLUID && got > 0) await collectDrops(bot, 3)
  if (got) dbg('  bycatch: grabbed ' + got + ' ' + oreRe.source)
  return got
}

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
  try {
    return await gatherLoop(bot, item, count, { ...opts, surfaceY, home })
  } finally {
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
const LEATHER_ANIMALS = /^(cow|mooshroom)$/

// Hunt nearby cows for LEATHER until we have `target` more in inventory, or we hit
// the bounds (max kills / time / no-animals-found). BOUNDED on purpose: a survival
// run must never HANG here when no cows are around - it returns whatever it got and
// the caller proceeds with a partial (or empty) armor set. Returns {leather, killed}.
// Same movement/anti-grief profile as gathering (can't tunnel through builds).
async function gatherLeather (bot, target, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const deadline = Date.now() + (opts.timeMs || 120000) // 2 min hard cap
  const maxKills = opts.maxKills || 16
  const maxExplores = opts.maxExplores != null ? opts.maxExplores : 2 // don't roam far for armor
  const home = opts.home // roam fence anchor (build site), if given
  const maxRoam = opts.maxRoam || 48
  const leatherNow = () => countItem(bot, 'leather')
  const start = leatherNow()
  bot.pathfinder.setMovements(gatherMovements(bot)) // anti-grief while chasing
  let killed = 0
  let explores = 0
  try {
    while (leatherNow() - start < target && killed < maxKills && Date.now() < deadline && !isStopped()) {
      // nearest leather animal within the fence (never chase a cow beyond maxRoam of home)
      let tgt = null; let best = 32
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
        if (!LEATHER_ANIMALS.test((e.name || '').toLowerCase())) continue
        if (home && Math.hypot(e.position.x - home.x, e.position.z - home.z) > maxRoam) continue
        const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
      }
      if (!tgt) { // none in range - roam to find some, but only a couple times (armor is optional)
        if (explores++ >= maxExplores) break
        await explore(bot, explores, home, maxRoam)
        continue
      }
      // wield the best melee we have (sword > axe > fist) and chase it down
      const items = bot.inventory ? bot.inventory.items() : []
      const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      const killStart = Date.now()
      bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 2), true)
      while (tgt.isValid && Date.now() - killStart < 15000 && !isStopped()) {
        if (bot.entity.position.distanceTo(tgt.position) <= 3.5) {
          await bot.lookAt(tgt.position.offset(0, (tgt.height || 1) * 0.7, 0)).catch(() => {})
          bot.attack(tgt)
          await new Promise(r => setTimeout(r, 600)) // attack-cooldown cadence
        } else {
          await new Promise(r => setTimeout(r, 300))
        }
      }
      bot.pathfinder.setGoal(null)
      if (!tgt.isValid) killed++
      await collectDrops(bot, 8) // grab the dropped leather (and beef)
    }
  } finally {
    bot.pathfinder.setGoal(null)
    if (opts.restoreMovements) opts.restoreMovements()
  }
  const got = leatherNow() - start
  if (got > 0) say(`got ${got} leather off ${killed} ${killed === 1 ? 'cow' : 'cows'}`)
  return { leather: got, killed }
}

// Animals whose drops FEED you (raw meat is edible). Used by the survival-hunt so a long
// job in a food-poor area doesn't run the bot down to 0 food / 1 hp with nothing to eat.
const FOOD_ANIMALS = /^(cow|mooshroom|pig|chicken|sheep|rabbit)$/
function hasFood (bot) {
  const md = require('minecraft-data')(bot.version)
  const foods = (md && md.foodsByName) || {}
  return (bot.inventory ? bot.inventory.items() : []).some(i => foods[i.name])
}
// How many edible items it's carrying (for "stock up" decisions, not just "any food?").
function foodCount (bot) {
  const md = require('minecraft-data')(bot.version)
  const foods = (md && md.foodsByName) || {}
  return (bot.inventory ? bot.inventory.items() : []).reduce((n, i) => n + (foods[i.name] ? i.count : 0), 0)
}
// The ONLY time the bot must go hunt: it's hungry AND has nothing to eat. (With food on
// hand, auto-eat handles it; well-fed, no need.) food<=6 = hunger low enough that regen
// has stopped, so act before it hits 0 and gets pinned at 1 hp.
function needsFood (bot) { return bot.food != null && bot.food <= 6 && !hasFood(bot) }
// Kill the nearest food animal and collect the meat (auto-eat then eats it, raw is fine).
// Bounded: one animal within ~24 blocks, ~12s. Returns true if something died. Uses the
// movement profile already set (chasing needs no digging, so anti-grief holds). No-op if
// no animal is near - it can't conjure food from an empty field.
async function huntForFood (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (!bot.entity) return false
  let tgt = null; let best = opts.range || 24
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
    if (!FOOD_ANIMALS.test((e.name || '').toLowerCase())) continue
    const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
  }
  if (!tgt) return false
  const items = bot.inventory ? bot.inventory.items() : []
  const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
  if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
  const killStart = Date.now()
  try {
    bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 2), true)
    while (tgt.isValid && Date.now() - killStart < 12000 && !isStopped()) {
      if (bot.entity.position.distanceTo(tgt.position) <= 3.5) {
        await bot.lookAt(tgt.position.offset(0, (tgt.height || 1) * 0.7, 0)).catch(() => {})
        bot.attack(tgt)
        await new Promise(r => setTimeout(r, 600))
      } else { await new Promise(r => setTimeout(r, 300)) }
    }
  } finally { bot.pathfinder.setGoal(null) }
  await collectDrops(bot, 8)
  return !tgt.isValid
}

// ROD_SUPPLY (M2): a bounded near-clone of huntForFood that finishes off a NEARBY spider for its
// STRING drop (a rod = 3 sticks + 2 string, and on this no-animal site spiders-at-night are the
// only realistic string source). Same GoalFollow/attack/collect shape + ~12s cap as huntForFood,
// but targets spider|cave_spider within `range` (default 16b) - NEVER a hunt across the map, never
// a creeper/skeleton. No-op if no spider is near (honest, like huntForFood on an empty field).
// BOUNDED: ONE pass, no loop; the string need + flag gate live at the ensureFishingRod call site.
// Returns true if a spider died. Uses the movement profile already set (chasing needs no digging,
// so anti-grief holds).
const ROD_SPIDERS = /^(spider|cave_spider)$/
async function huntSpiderForString (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (!bot.entity) return false
  let tgt = null; let best = opts.range || Number(process.env.ROD_SPIDER_RANGE || 16)
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
    if (!ROD_SPIDERS.test((e.name || '').toLowerCase())) continue
    const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; tgt = e }
  }
  if (!tgt) return false
  const items = bot.inventory ? bot.inventory.items() : []
  const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
  if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
  const killStart = Date.now()
  try {
    bot.pathfinder.setGoal(new goals.GoalFollow(tgt, 2), true)
    while (tgt.isValid && Date.now() - killStart < 12000 && !isStopped()) {
      if (bot.entity.position.distanceTo(tgt.position) <= 3.5) {
        await bot.lookAt(tgt.position.offset(0, (tgt.height || 1) * 0.7, 0)).catch(() => {})
        bot.attack(tgt)
        await new Promise(r => setTimeout(r, 600))
      } else { await new Promise(r => setTimeout(r, 300)) }
    }
  } finally { bot.pathfinder.setGoal(null) }
  await collectDrops(bot, 8)
  return !tgt.isValid
}

// ---- night survival: dig-in shelter for a NAKED bot ------------------------------
const SHELTER_HOSTILE = /zombie|skeleton|spider|creeper|husk|drowned|witch|pillager|vindicator|stray|bogged|phantom|slime|enderman|silverfish|cave_spider|warden/
let _sheltering = false
function isSheltering () { return _sheltering } // reflexes (flee/defend) yield while true

// NEVER rest IN water. The night carousel drowned the bot in its own flooding pit
// (observed on test server, hp 20 -> death while every command was held): resting flows
// cycled dig attempts while it bobbed in a basin, and nothing ever LEFT the water.
// Every rest/shelter entry point gets ashore first; bounded, honest about failure.
function inWaterNow (bot) {
  if (!bot.entity) return false
  const f = bot.blockAt(bot.entity.position.floored())
  const h = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))
  return !!((f && /water/.test(f.name)) || (h && /water/.test(h.name)))
}
async function ensureAshore (bot, isStopped = () => false) {
  if (!inWaterNow(bot)) return true
  dbg('rest: in water - getting ashore before any resting')
  try { if (await navigate.swimToShore(bot, isStopped)) return true } catch {}
  try { await manualHopFromWater(bot) } catch {}
  return !inWaterNow(bot)
}

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
const SHELTER_FARM_R = Number(process.env.SHELTER_FARM_R || 7)
function shelterFarmConflict (bot, pos) {
  if (process.env.SHELTER_AVOID_FARM === '0' || !pos) return null
  let wf = null
  try { wf = loadWorldMem().wheatFarm } catch { return null }
  if (!wf) return null
  return shelterSite.farmConflict(wf, wf.cells || [], pos, SHELTER_FARM_R) ? wf : null
}

async function findDiggableDryCell (bot, opts = {}) {
  const radius = opts.radius || 24
  if (!bot.entity) return null
  const mcData = require('minecraft-data')(bot.version)
  const GROUND_RE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mud|sand|red_sand|gravel|stone|deepslate|granite|diorite|andesite|tuff|clay|terracotta|netherrack|moss_block|snow_block|calcite)$/
  const ids = Object.values(mcData.blocksByName).filter(b => GROUND_RE.test(b.name)).map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 96 }) || []
  const nameAt = p => { const b = bot.blockAt(p); return b ? b.name : null }
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const cand = []
  const nearFarm = [] // fix #30: cells inside the farm buffer - used ONLY as a last resort
  for (const gp of found) {
    const feet = gp.offset(0, 1, 0); const head = gp.offset(0, 2, 0)
    // standable + dry to STAND on (no water in the feet/head cell or its horizontal neighbours)
    if (!shelterSite.feetCellDry(nameAt(feet), nameAt(head), SIDES.map(([dx, dz]) => nameAt(feet.offset(dx, 0, dz))))) continue
    // a safe pit can be dug straight down from here (solid, no fluid below/beside the shaft,
    // and not a thin shelf over a cave - below3 lets shelterDiggable reject a void two deep)
    const below = nameAt(gp); const below2 = nameAt(gp.offset(0, -1, 0)); const below3 = nameAt(gp.offset(0, -2, 0))
    if (!shelterSite.shelterDiggable(below, below2, SIDES.map(([dx, dz]) => nameAt(gp.offset(dx, 0, dz))), below3)) continue
    // must be real natural ground the anti-grief dig will actually break (not a player block)
    const gb = bot.blockAt(gp); if (gb && !canBreakNaturally(gb)) continue
    // never relocate the pit onto our own hut apron (defaces the doorstep)
    if (onHutApron(bot, feet)) continue
    // SHELTER_AVOID_FARM (fix #30): never relocate the pit into our own farm (floods/wrecks
    // the crop) - hold these aside and only fall back to them if NOTHING clear of the farm exists.
    if (shelterFarmConflict(bot, feet)) { nearFarm.push({ x: feet.x, y: feet.y, z: feet.z }); continue }
    cand.push({ x: feet.x, y: feet.y, z: feet.z })
  }
  const ranked = shelterSite.rankByDistance(cand, bot.entity.position)
  if (ranked.length) return new Vec3(ranked[0].x, ranked[0].y, ranked[0].z)
  // LAST RESORT (survival > farm): no dry diggable ground clear of the farm - take a farm-buffer
  // cell rather than freeze exposed all night, and log the override.
  const rankedFarm = shelterSite.rankByDistance(nearFarm, bot.entity.position)
  if (rankedFarm.length) { dbg('shelter: NO dry diggable ground clear of the farm - relocating INTO the farm buffer as a last resort (survival > crops)'); return new Vec3(rankedFarm[0].x, rankedFarm[0].y, rankedFarm[0].z) }
  return null
}
// Where a shelter pit last FLOODED - do not dig another hole next to the same aquifer
// for a while (the re-dig loop beside water is the entombment/drowning mechanism).
let lastFlood = null // {x, z, at}
function nearRecentFlood (bot) {
  if (!lastFlood || Date.now() - lastFlood.at > 600000 || !bot.entity) return false
  return Math.hypot(bot.entity.position.x - lastFlood.x, bot.entity.position.z - lastFlood.z) <= 6
}
function nearHostile (bot, r) {
  const me = bot.entity && bot.entity.position; if (!me) return false
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
    if (!SHELTER_HOSTILE.test((e.name || '').toLowerCase())) continue
    if (e.position.distanceTo(me) <= r) return true
  }
  return false
}
// DANGER WHILE MINING: a cave hostile has closed to melee/bow range, or hp is crashing.
// The idle flee/defend reflexes can't help mid-dig (the bot is committed inside bot.dig()
// awaits, not the pathfinder), so the tight dig loops + the gather loop poll THIS and bail
// to a survival reaction. Naked deep gearup mining died at ~1hp three times (verified live:
// y39-40, zombie in melee + skeleton firing, flee:false) - this is the missing reflex.
function mineDanger (bot) { return nearHostile(bot, 6) || (bot.health ?? 20) < 12 || (process.env.LAVA_SAFE !== '0' && !!(bot.entity && (bot.entity.isInLava || bot.entity.onFire))) } // #41: in-lava/on-fire is a dig-abort for every mining primitive (isInLava/onFire are reliable entity flags; oxygenLevel is not)
// LOW-HP-BUT-CALM: hurt below the mine-danger arm with NOTHING attacking - the livelock state
// (hp<12, no hostile) that the arbiter heal/food needs both miss (heal fires at hp<=6 or hp<=10
// only while endangered; food at food<14). The material-round heal entry widens on THIS so the
// bank-side recover gets a second chance. Flag-gated with the gather recover path (GATHER_HP_RECOVER).
function lowHpCalm (bot) {
  if (process.env.GATHER_HP_RECOVER === '0') return false
  return (bot.health ?? 20) < 12 && !nearHostile(bot, 6)
}
function underArmored (bot) {
  try { for (const s of ['head', 'torso', 'legs', 'feet']) { if (!(bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(s)])) return true } return false } catch { return true }
}
// How many armor slots are actually worn (0-4). Modulates the deep-mine plan (deepMinePlan):
// a naked bot digs shallower/shorter so it doesn't die on the same deep excursion an armored
// bot survives (naked-deep deaths, live). Complements underArmored (which is a boolean gate).
function armorPieceCount (bot) {
  let n = 0
  try { for (const s of ['head', 'torso', 'legs', 'feet']) { if (bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(s)]) n++ } } catch { return 0 }
  return n
}
function isNight (bot) { return !!(bot.time && bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 23500) }
// Fire night-rest whenever we're under-armored and DUSK is falling. This USED to also wait for
// a hostile within 12 blocks - which meant the bot wandered exposed all night and only started
// digging once a skeleton was already shooting it (verified live: 7 night deaths in one
// evening, several while "sheltering"). A naked player doesn't wait to be chased: at dusk they
// go to bed or hole up BEFORE the mobs arrive. Trigger at DUSK (12200), NOT mob-spawn (13000):
// a fresh pit takes ~15-20s to dig + seal, so starting after dark means a zombie walks straight
// into the open hole mid-dig (verified live: began the pit at timeOfDay 13618, a zombie walked
// in during the dig, died). The ~800-tick (~40s) head start lets the pit be sealed before any
// mob spawns. isNight (13000) stays the trigger for the ARMORED "wanted" cases below.
function shelterNeeded (bot) { return !!(bot.time && bot.time.timeOfDay >= 12200 && bot.time.timeOfDay < 23500) && underArmored(bot) }
// FROZEN / ETERNAL NIGHT: on the live server doDaylightCycle is off - timeOfDay is pinned in the
// night band and DAWN NEVER COMES (grounded live: tod stuck ~15438, delta 0 over 45s). Left to
// the normal rhythm the bot shelters forever: underArmored -> shelterNeeded -> it re-seals its
// bunker every cycle, and gearup is night-gated so it never re-arms - the exact "no armor, mobs
// about" hole it never climbed out of (live 379,62,40, pinned 25+ min). Detect a night that will
// not end so the reflexes can shelter BRIEFLY, then resume careful progress (gear up first). On a
// NORMAL server timeOfDay always advances, so this never trips and nights end at dawn as before.
const NIGHT_FROZEN_MS = parseInt(process.env.NIGHT_STUCK_MS || '90000', 10) // tod pinned this long at night = dawn isn't coming
const NIGHT_OVERLONG_MS = 900000 // ...or one continuous night runs 15 min (a normal night's dark is ~8-9 min; backstop for a non-frozen but stuck/very-laggy night)
let _todSeen = { tod: null, at: 0 } // last time timeOfDay changed meaningfully
let _nightStart = 0 // start of the current unbroken night
function nightStuck (bot) {
  if (!bot || !bot.time) return false
  const now = Date.now()
  const tod = bot.time.timeOfDay
  if (_todSeen.tod == null || Math.abs(tod - _todSeen.tod) > 30) _todSeen = { tod, at: now } // ~1.5s of ticks; frozen tod never refreshes this
  if (!isNight(bot)) { _nightStart = 0; return false }
  if (!_nightStart) _nightStart = now
  return (now - _todSeen.at) > NIGHT_FROZEN_MS || (now - _nightStart) > NIGHT_OVERLONG_MS
}
// Rest is WANTED (not just needed) when night catches us with the bed close by - even in
// full armor a player sleeps if home is right there (operator rule: safer overall). Far
// from the bed and armored, keep working the night; the commute would cost more than the
// safety buys.
function nightRestWanted (bot) {
  if (shelterNeeded(bot)) return true
  if (!isNight(bot) || !bot.entity) return false
  if ((bot.health ?? 20) <= 8) return true // critically hurt at night: rest, armored or not (died at 1hp hunting in the dark)
  const bed = knownBed()
  return !!bed && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 100 // must COVER THE BUILD SITE: it died working the castle at night, 66 blocks from bed, 2 past the old radius
}
// (anti-grief helpers canBreakNaturally / structureNearby are defined up top, next to
// STRUCTURE_RE, and shared by every dig primitive + the shelter + the gather filter.)

// Place a block from inventory (name matching `match`) AT world position `target`, using any
// solid neighbouring face to place against. Best-effort; returns whether a block landed.
async function placeAt (bot, target, match) {
  placeAt.lastFail = null // observability: WHY the last placement failed (cap-fail debugging)
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => match.test(i.name))
  if (!item) { placeAt.lastFail = 'no matching item in inventory'; return false }
  await bot.equip(item, 'hand').catch(() => {})
  let sawRef = false
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const ref = bot.blockAt(target.offset(dx, dy, dz))
    if (ref && ref.boundingBox === 'block' && !AIRISH(ref.name)) {
      sawRef = true
      try { await bot.lookAt(target.offset(0.5, 0.5, 0.5), true) } catch {}
      try { await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)); return true } catch (e) {
        placeAt.lastFail = `place vs ${ref.name} face ${-dx},${-dy},${-dz}: ${e.message}`
        // Paper often doesn't echo the blockUpdate even when the block PLACED (same quirk
        // as the torch reflex, see NOTES.md) - check the world before calling it a miss.
        if (/blockUpdate/.test(e.message)) {
          await new Promise(r => setTimeout(r, 400))
          const b = bot.blockAt(target)
          if (b && !AIRISH(b.name)) return true
        }
      }
    }
  }
  if (!sawRef) placeAt.lastFail = 'no solid neighbour to place against'
  return false
}

// ACTIVE BUILD ZONE (set by autoBuild, cleared when it ends): the shelter must never dig
// its bunker inside the build footprint - a pit under the castle floor is a hole in the
// build (operator rule). Module-level so every shelter entry point respects it without
// threading a box through each caller.
let buildZone = null
function setBuildZone (box) { buildZone = box || null }
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
async function sealShaft (bot, interior = {}) {
  const CAP_RE = /terracotta|dirt|cobble|stone|gravel|sand|netherrack|deepslate|tuff|granite|diorite|andesite|clay|mud|_planks$|_log$|_concrete/
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const feet = interior.feet || bot.entity.position.floored()
  const keep = [interior.feet, interior.head, interior.alcoveCell].filter(Boolean)
  const isInterior = c => keep.some(m => m.x === c.x && m.y === c.y && m.z === c.z)
  // 1) WALLS FIRST: dy=0 ring (each cell places against the solid floor under it) THEN dy=1
  //    ring (each places against the dy=0 block just laid) - this ordering is what makes cave
  //    geometry sealable. Liquid counts as a hole (AIRISH misses water). Skip interior cells
  //    (the alcove) so we never wall the torch back in.
  let sideHoles = 0
  for (const dy of [0, 1]) {
    for (const [dx, dz] of SIDES) {
      const cell = feet.offset(dx, dy, dz)
      if (isInterior(cell)) continue
      const b = bot.blockAt(cell)
      if (b && (AIRISH(b.name) || /lava|water/.test(b.name))) {
        if (await placeAt(bot, cell, CAP_RE)) dbg('shelter: walled a side hole at ' + cell.toString())
        else { sideHoles++; dbg('shelter: side hole at ' + cell.toString() + ' UNSEALED (' + b.name + ') - ' + (placeAt.lastFail || '?')) }
      }
    }
  }
  // 2) CAP SECOND - the head ring now gives the cap cell solid neighbours so placeAt succeeds.
  let capPos = bot.entity.position.floored().offset(0, 2, 0)
  let capped = await placeAt(bot, capPos, CAP_RE)
  if (!capped) dbg('shelter: cap attempt 1 failed - ' + (placeAt.lastFail || '?'))
  // VERIFY the cap landed (placement can miss from inside a 1x1 pit) and retry once - an
  // uncapped pit is a mob funnel (they fall in ON TOP of the bot, seen live).
  if (!capped || AIRISH((bot.blockAt(capPos) || {}).name || 'air')) {
    await new Promise(r => setTimeout(r, 300))
    capped = await placeAt(bot, capPos, CAP_RE)
    if (!capped) dbg('shelter: cap attempt 2 failed - ' + (placeAt.lastFail || '?'))
  }
  // Last resort: dig one deeper and cap one lower - a 3-deep shaft with a lid at -2 still seals
  // (head keeps a 1-block air gap under the cap), and the deeper shaft gives a wall ring to place
  // against that some placements need.
  if (!capped || AIRISH((bot.blockAt(capPos) || {}).name || 'air')) {
    const f = bot.entity.position.floored()
    const below = bot.blockAt(f.offset(0, -1, 0))
    const below2 = bot.blockAt(f.offset(0, -2, 0))
    if (below && !AIRISH(below.name) && !/lava|water/.test(below.name) && canBreakNaturally(below) &&
        !(below2 && /lava|water/.test(below2.name))) {
      try {
        await bot.dig(below); await new Promise(r => setTimeout(r, 300)); await collectDrops(bot, 3)
        capPos = bot.entity.position.floored().offset(0, 2, 0)
        capped = await placeAt(bot, capPos, CAP_RE)
        if (!capped) dbg('shelter: deep-cap attempt failed - ' + (placeAt.lastFail || '?'))
      } catch (e) { dbg('shelter: deeper dig failed (' + e.message + ')') }
    }
  }
  return { capped, sideHoles, capPos }
}

// Widen ONE floor-level neighbour of `feet` into a torch alcove so a sealed pit can be LIT.
// PROBE everything first (world re-reads): the candidate must be natural + breakable, and its
// floor, far wall, both side faces AND ceiling must all be solid non-liquid (alcoveSafe) with no
// liquid on any of its 6 faces - so cutting the one cell keeps the box a complete seal. ONE
// attempt, first candidate that passes; returns the dug cell Vec3 or null. The ONLY new dig in
// the shelter flow, gated by canBreakNaturally (anti-grief) + the liquid probes.
async function digTorchAlcove (bot, feet) {
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]
  for (const [dx, dz] of SIDES) {
    const cell = feet.offset(dx, 0, dz)
    const cb = bot.blockAt(cell)
    if (!cb || AIRISH(cb.name) || /lava|water/.test(cb.name)) continue // must be a block we open INTO
    if (!canBreakNaturally(cb)) continue // anti-grief: never cut a player block
    if (bot.canDigBlock && !bot.canDigBlock(cb)) continue
    const floor = bot.blockAt(cell.offset(0, -1, 0))
    const farWall = bot.blockAt(cell.offset(dx, 0, dz))
    const perp = dx !== 0 ? [[0, 0, 1], [0, 0, -1]] : [[1, 0, 0], [-1, 0, 0]]
    const side1 = bot.blockAt(cell.offset(perp[0][0], perp[0][1], perp[0][2]))
    const side2 = bot.blockAt(cell.offset(perp[1][0], perp[1][1], perp[1][2]))
    const ceil = bot.blockAt(cell.offset(0, 1, 0))
    if (!shelterSite.alcoveSafe([floor, farWall, side1, side2, ceil].map(b => (b ? b.name : null)))) continue
    if (N6.some(([ox, oy, oz]) => { const b = bot.blockAt(cell.offset(ox, oy, oz)); return b && /lava|water/.test(b.name) })) continue // no liquid touching the pocket
    const tool = toolForBlock(bot, cb.name)
    if (tool) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(cb); await collectDrops(bot, 3); dbg('shelter: opened a torch alcove at ' + cell.toString()); return cell } catch (e) { dbg('shelter: alcove dig failed (' + e.message + ')'); return null }
  }
  return null
}

async function digInForNight (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  if (!bot.entity || _sheltering) return false
  // ETERNAL/FROZEN NIGHT: don't start a fresh dig-in that would just break out on the next poll -
  // dawn isn't coming, so resume careful progress (gear up) instead of re-bunkering every cycle.
  // The brief initial shelter already ran while the night still looked normal (see nightStuck).
  if (nightStuck(bot)) { dbg('shelter: night is stuck/eternal - not digging in; time to re-arm and work carefully'); return false }
  // ANTI-GRIEF is handled PER-DIG below (canBreakNaturally): the shelter can only cut natural
  // ground, never a placed block - so it can't punch through a base's floor, yet it CAN still
  // dig a bunker in natural dirt right next to a build (incl. the bot's OWN castle at the build
  // site, where it most needs to shelter). Standing ON a player floor -> the dig loop's natural
  // check fails immediately -> no hole, it just flees instead.
  _sheltering = true
  try {
    bot.pathfinder && bot.pathfinder.setGoal(null)
    // LIGHT THE SHELTER: try to have a couple of torches ready (free from coal/charcoal mine
    // bycatch + carried sticks; silent no-op if we have neither). A lit sealed alcove stops
    // mob spawns through a long night - the missing half of "an actual safe space, not a hole".
    try { await ensureTorches(bot, 2) } catch {}
    // IN WATER? Get ashore FIRST - digging attempts from a water column all fail while
    // the bot drowns through the retry carousel (watched it die that way on the test
    // server). If we can't reach land, say so honestly instead of pretending to shelter.
    if (!(await ensureAshore(bot, isStopped))) { dbg('shelter: stuck in water - cannot dig in here'); return false }
    // Don't dig a fresh hole beside the aquifer that just flooded the last one - walk
    // clear of it first (re-digging at the same wet spot is the drowning loop).
    if (nearRecentFlood(bot)) {
      const away = { x: bot.entity.position.x + (bot.entity.position.x >= lastFlood.x ? 8 : -8), z: bot.entity.position.z + (bot.entity.position.z >= lastFlood.z ? 8 : -8) }
      dbg('shelter: too close to the pit that flooded - moving to ' + Math.round(away.x) + ',' + Math.round(away.z) + ' first')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 2), 15000) } catch {}
    }
    // NEVER dig the bunker inside the active build footprint - step just past the nearest
    // edge first (a pit under the castle floor is a hole in the build, operator rule).
    const p0 = bot.entity.position
    if (inBuildZone(p0.x, p0.z)) {
      const exits = [
        { x: buildZone.x1 - 5, z: p0.z }, { x: buildZone.x2 + 5, z: p0.z },
        { x: p0.x, z: buildZone.z1 - 5 }, { x: p0.x, z: buildZone.z2 + 5 }
      ].sort((a, b) => Math.hypot(a.x - p0.x, a.z - p0.z) - Math.hypot(b.x - p0.x, b.z - p0.z))
      dbg('shelter: inside the build footprint - stepping out to ' + Math.round(exits[0].x) + ',' + Math.round(exits[0].z) + ' before digging')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(exits[0].x, exits[0].z, 2), 20000) } catch (e) { dbg('shelter: footprint exit walk failed (' + e.message + ') - digging where i stand') }
    }
    // MY HUT IS THE SHELTER: at the doorstep of the bot's own hut, step INSIDE (door-
    // assist) instead of digging a pit beside the walls; already inside, just wait the
    // night out - walls and roof beat any hole in the ground, and pitting here is how
    // the interior kept getting defaced (dirt piles, floor holes - live, repeatedly).
    if (!insideOwnStructure(bot)) {
      const hutNear = onHutApron(bot)
      if (hutNear) {
        try {
          const nav = require('./navigate.js') // lazy - navigate requires provision the same way
          // ATOMIC ENTER-MY-STRUCTURE (nav slice B): stand off just outside the door, then one
          // reflex-protected open-align-step-through - robust vs the plain goto that timed out
          // trying to path into the closed box and got its goal stolen mid-crossing (live).
          if (!await nav.enterStructure(bot, hutNear, { isStopped })) {
            await nav.navigateTo(bot, new goals.GoalNear(hutNear.x + 2, hutNear.y + 1, hutNear.z + 2, 1), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 0, water: 1, nudge: 1 }, label: 'shelter-home' })
          }
        } catch (e) { dbg('shelter: could not get inside my hut (' + e.message + ')') }
      }
    }
    if (insideOwnStructure(bot)) {
      dbg('shelter: inside my own hut - waiting out the night, no digging')
      say('holed up at home for the night')
      const dl = Date.now() + 600000
      const hpIn = bot.health || 20
      let hurtInside = false
      while (Date.now() < dl && !isStopped()) {
        // hold through the DUSK HEAD-START too (shelterNeeded fires at 12200, isNight at
        // 13000): breaking on "!isNight" alone made this return success instantly at dusk,
        // so the 5s reflex re-entered forever - the "waiting out the night" log spam (live)
        if ((!shelterNeeded(bot) && !isNight(bot) && !nearHostile(bot, 10)) || nightStuck(bot)) break // stuck night: stop waiting for a dawn that won't come
        if ((bot.health || 20) < hpIn - 3) { dbg('shelter: taking damage INSIDE the hut - releasing shelter to FIGHT'); hurtInside = true; break }
        if (inWaterNow(bot)) { dbg('shelter: hut interior flooding - bailing'); hurtInside = true; break }
        await new Promise(r => setTimeout(r, 3000))
      }
      if (!hurtInside) return true
      // Hurt while holed up inside the hut (an enderman teleported in, a mob at the door):
      // do NOT abandon the walls to dig a pit - RELEASE the shelter so the now-ungated
      // flee/defend reflexes take over. Armored, inside its own walls, the bot wins the
      // fight; a creeper it flees. Standing still absorbing hits killed it (live: enderman
      // -> 'attack suppressed' -> dead). restUntilSafe re-shelters once the threat clears.
      if (inWaterNow(bot)) { /* flooding: fall through to relocate/pit below */ } else return false
    }
    // Near (but not in) the hut with no way inside: dig AWAY from the walls/apron, never
    // against them - same rule as the build footprint below.
    if (onHutApron(bot)) {
      const h = onHutApron(bot)
      const away = { x: h.x + 12, z: h.z + 12 }
      dbg('shelter: on my hut apron - stepping clear to ' + away.x + ',' + away.z + ' before digging')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 2), 15000) } catch {}
    }
    // SHELTER_AVOID_FARM (fix #30): never dig the bunker into/beside our own wheat farm - a pit at
    // the farm waterline floods and WRECKS the crop (#28's physical cause). Step clear of the farm
    // first, same rule as the build footprint / hut apron above. The relocation cell-picker
    // (findDiggableDryCell) also excludes the farm, so a blocked in-place dig won't fall back onto it.
    const farmHere = shelterFarmConflict(bot, bot.entity.position)
    if (farmHere) {
      const p = bot.entity.position
      let dx = p.x - farmHere.x, dz = p.z - farmHere.z
      if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) { dx = 1; dz = 1 } // standing on the anchor: pick a corner
      const norm = Math.hypot(dx, dz) || 1
      const away = { x: Math.round(farmHere.x + (dx / norm) * (SHELTER_FARM_R + 6)), z: Math.round(farmHere.z + (dz / norm) * (SHELTER_FARM_R + 6)) }
      dbg('shelter: too close to my wheat farm - stepping clear to ' + away.x + ',' + away.z + ' before digging (would flood the crops)')
      try { await gotoWithTimeout(bot, new goals.GoalNearXZ(away.x, away.z, 2), 15000) } catch {}
    }
    // REUSE MY BUNKER: four nights of fresh digs at one spot, each side-sealing against
    // the previous night's holes, ENTOMBED the bot in a hillside (live - needed a rescue
    // agent). If a registered shelter is within 24, go sit in it and re-SEAL instead (24 not
    // 12: a branch-mine head drifts, and a bounded goto to a known bunker beats a fresh dig).
    const oldPit = recallInfra('shelter', bot.entity.position, 24)
    if (oldPit) {
      dbg('shelter: reusing my bunker at ' + oldPit.x + ',' + oldPit.y + ',' + oldPit.z)
      try { await gotoWithTimeout(bot, new goals.GoalBlock(oldPit.x, oldPit.y, oldPit.z), 15000) } catch {}
      const here = bot.entity.position.floored()
      if (Math.abs(here.x - oldPit.x) <= 1 && Math.abs(here.z - oldPit.z) <= 1 && here.y <= oldPit.y + 1) {
        // we're in the old hole - RE-SEAL it (walls too, not just the lid: a reused pit can have
        // caved-in / re-opened sides), light a torch alcove if we carry one, then wait the night.
        const feet0 = bot.entity.position.floored()
        const head0 = feet0.offset(0, 1, 0)
        let alcove0 = null
        if (countItem(bot, 'torch') > 0) { try { alcove0 = await digTorchAlcove(bot, feet0) } catch {} }
        const seal0 = await sealShaft(bot, { feet: feet0, head: head0, alcoveCell: alcove0 })
        if (alcove0) { try { await placeTorch(bot) } catch {} }
        const capPos0 = seal0.capPos
        const recapped = seal0.capped && !seal0.sideHoles
        dbg('shelter: bunker re-entered, ' + (recapped ? 'RE-SEALED' : 'OPEN (leaky)') + (seal0.sideHoles ? ' ' + seal0.sideHoles + ' side(s)' : ''))
        say(recapped ? 'back in my bunker for the night' : 'in my bunker (lid open)')
        const dl = Date.now() + (recapped ? 600000 : 120000)
        const hpX = bot.health || 20
        while (Date.now() < dl && !isStopped()) {
          if ((!isNight(bot) && !nearHostile(bot, 10)) || nightStuck(bot)) break // stuck night: don't squat till a dawn that won't come
          if ((!recapped || DEFEND_WHEN_HIT_ON) && (bot.health || 20) < hpX - 3) { dbg('shelter: taking damage in the ' + (recapped ? 'SEALED bunker - breached' : 'open bunker') + ' - bailing out to fight/flee'); break }
          // same flooding bail as the fresh-pit wait: a reused bunker beside an aquifer
          // can flood too, and this loop had no way out (drowned sealed, test server)
          if (inWaterNow(bot)) {
            dbg('shelter: reused bunker is FLOODING - emergency exit')
            lastFlood = { x: bot.entity.position.x, z: bot.entity.position.z, at: Date.now() }
            break
          }
          await new Promise(r => setTimeout(r, 3000))
        }
        try {
          const cap = bot.blockAt(capPos0)
          if (cap && !AIRISH(cap.name) && (!bot.canDigBlock || bot.canDigBlock(cap))) { try { await bot.dig(cap) } catch {} }
          await collectDrops(bot, 3)
          await climbToSurface(bot, Math.floor(bot.entity.position.y) + 4, { isStopped })
        } catch {}
        return true
      }
      dbg('shelter: could not re-enter the bunker - digging fresh')
    }
    // ON A TREE CANOPY? The shelter can't dig leaves (not in DIGGABLE_NATURAL) and used to
    // NO-OP in a 5s loop all night (reproduced on test server, savanna oak). Leaves are
    // always natural: if the ground is close below, punch through and drop; if it's a tall
    // tree (jungle!), walk off to real ground instead - never a lethal fall.
    for (let i = 0; i < 8; i++) {
      const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!under || !/_leaves$/.test(under.name)) break
      let depth = 0 // how far we'd fall past this leaf layer
      for (let dy = 2; dy <= 8; dy++) { const b = bot.blockAt(bot.entity.position.floored().offset(0, -dy, 0)); if (b && !AIRISH(b.name) && !/_leaves$/.test(b.name)) break; depth++ }
      if (depth > 4) {
        dbg('shelter: on a TALL canopy (' + depth + '+ drop) - walking to ground instead of punching through')
        const mcData = require('minecraft-data')(bot.version)
        const gids = Object.values(mcData.blocksByName).filter(b => /^(grass_block|dirt|coarse_dirt|podzol|sand|red_sand|gravel|stone)$/.test(b.name)).map(b => b.id)
        const spots = (bot.findBlocks({ matching: gids, maxDistance: 16, count: 12 }) || [])
          .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); const a2 = bot.blockAt(p.offset(0, 2, 0)); return a && AIRISH(a.name) && a2 && AIRISH(a2.name) })
        if (spots.length) { try { await gotoWithTimeout(bot, new goals.GoalBlock(spots[0].x, spots[0].y + 1, spots[0].z), 12000) } catch (e) { dbg('shelter: walk-to-ground failed (' + e.message + ')') } }
        break
      }
      try { await bot.dig(under) } catch (e) { dbg('shelter: leaf-punch failed (' + e.message + ')'); break }
      await new Promise(r => setTimeout(r, 400)) // drop through
    }
    // CENTER on the feet cell. Digging from a cell edge (x.5/z.5 boundary) digs the
    // column under floored(feet) while the body stays supported by the NEIGHBOUR block -
    // the bot opens a perfect pit and stands beside it all night with the "cap" aimed at
    // thin air (root cause of every 'ducked into a hole' night death; reproduced on the
    // test server at x=-330.5: "cap failed - no solid neighbour to place against").
    // Dig the pit HERE; if the flooding/obstruction guard blocks it, RELOCATE to the nearest
    // diggable DRY cell and retry (bounded). ensureAshore only gets us OUT of the water - on a
    // river bank the bot can be ashore yet water-adjacent on every side, so an in-place-only
    // pit hits the side-liquid guard forever ("water beside the next cell" -> "NO-OP" every
    // ~4s, bricked the bot, live). Relocating to genuinely diggable dry ground is the fix.
    let dug = 0
    let surfaceY = Math.floor(bot.entity.position.y)
    let shaft = bot.entity.position.floored()
    const RELOCATE_TRIES = 3
    for (let attempt = 0; attempt <= RELOCATE_TRIES && dug < 1 && !isStopped(); attempt++) {
      // CENTER on the feet cell. Digging from a cell edge (x.5/z.5) digs the column under
      // floored(feet) while the body stays supported by the NEIGHBOUR block - the bot opens a
      // perfect pit and stands beside it with the "cap" aimed at thin air (every 'ducked into
      // a hole' night death; reproduced at x=-330.5: "no solid neighbour to place against").
      try { const f0 = bot.entity.position.floored(); await gotoWithTimeout(bot, new goals.GoalBlock(f0.x, f0.y, f0.z), 4000) } catch {}
      surfaceY = Math.floor(bot.entity.position.y)
      shaft = bot.entity.position.floored() // the column we dig - we must END UP inside it
      // 1) dig straight down 2, keeping the blocks (need one to cap with). NEVER dig into a
      //    void/lava/water below, and ONLY natural terrain (never a player build block).
      for (let i = 0; i < 2 && !isStopped(); i++) {
        const feet = bot.entity.position.floored()
        const below = bot.blockAt(feet.offset(0, -1, 0))
        const below2 = bot.blockAt(feet.offset(0, -2, 0))
        if (!below || AIRISH(below.name) || /lava|water/.test(below.name) || !canBreakNaturally(below)) { dbg('shelter: dig blocked at ' + i + ' (' + (below ? below.name : 'unloaded') + ')'); break }
        if (below2 && /lava|water/.test(below2.name)) { dbg('shelter: liquid 2 below - not digging'); break }
        // VOID BELOW: if BOTH below2 AND below3 are airish we're on a thin shelf over a CAVE -
        // digging `below` drops us >=2 blocks into the open cavern (the exposed dark-cave death
        // this fix targets). below2-air over SOLID below3 is legit 3-deep geometry -> allowed.
        // Break into the relocate machinery to find real ground instead of falling in.
        const below3 = bot.blockAt(feet.offset(0, -3, 0))
        const airish = b => !b || AIRISH(b.name)
        if (airish(below2) && airish(below3)) { dbg('shelter: void 2+ below (thin shelf over a cave) - not digging, relocating'); break }
        // NEVER open a cell whose SIDE touches liquid - an aquifer beside the shaft floods
        // the pit the instant the wall drops (drowned at 4hp in its own sealed pit, live).
        let sideLiquid = null
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const s = bot.blockAt(below.position.offset(dx, 0, dz))
          if (s && /lava|water/.test(s.name)) { sideLiquid = s.name; break }
        }
        if (sideLiquid) { dbg('shelter: ' + sideLiquid + ' beside the next cell - not digging deeper'); break }
        const tool = toolForBlock(bot, below.name)
        if (tool) await bot.equip(tool, 'hand').catch(() => {})
        if (bot.canDigBlock && !bot.canDigBlock(below)) { dbg('shelter: canDigBlock=false for ' + below.name); break }
        try { await bot.dig(below) } catch (e) { dbg('shelter: dig failed (' + e.message + ')'); break }
        await new Promise(r => setTimeout(r, 250)) // fall into the hole
        // VERIFY we dropped in - a straddling bot digs without falling. Steer into the shaft.
        if (Math.floor(bot.entity.position.y) > feet.y - 1) {
          try { await gotoWithTimeout(bot, new goals.GoalBlock(shaft.x, feet.y - 1, shaft.z), 3000) } catch {}
          await new Promise(r => setTimeout(r, 200))
        }
        dug++
      }
      if (dug >= 1) break
      // Blocked in place (water-adjacent / obstruction). Walk to the nearest diggable dry cell
      // and try again - PROGRESS instead of the 4s NO-OP spin. Widen the search each retry.
      if (attempt < RELOCATE_TRIES) {
        const dry = await findDiggableDryCell(bot, { radius: 20 + attempt * 12 })
        if (!dry) { dbg('shelter: no diggable dry ground within reach - cannot pit'); break }
        dbg('shelter: cannot dig here (water/obstruction) - relocating to diggable dry ground at ' + dry.toString() + ' (try ' + (attempt + 1) + '/' + RELOCATE_TRIES + ')')
        if (opts.say && attempt === 0) opts.say('ground here is too wet to dig into - moving to dry ground to shelter')
        try { await gotoWithTimeout(bot, new goals.GoalBlock(dry.x, dry.y, dry.z), 20000) } catch (e) { dbg('shelter: relocate walk failed (' + e.message + ')') }
        if (inWaterNow(bot)) { try { await ensureAshore(bot, isStopped) } catch {} }
      }
    }
    if (dug < 1) { dbg('shelter: NO-OP (dug 0 after ' + RELOCATE_TRIES + ' relocation tries) - caller must do something else'); return false } // genuinely nowhere diggable+dry nearby
    if (Math.floor(bot.entity.position.y) >= surfaceY) { dbg('shelter: dug ' + dug + ' but NEVER FELL IN (still at surface) - aborting, not pretending'); return false }
    await collectDrops(bot, 3)
    // LIT ALCOVE: BEFORE sealing, if we carry a torch, widen ONE floor-level neighbour into a
    // torch alcove (probed for solidity + dryness) so the sealed box is LIT - no mob spawns
    // through a long night. Skipped on any probe fail / no torch (a sealed 1x1 needs no light).
    const feet = bot.entity.position.floored()
    const head = feet.offset(0, 1, 0)
    let alcoveCell = null
    if (countItem(bot, 'torch') > 0) { try { alcoveCell = await digTorchAlcove(bot, feet) } catch {} }
    // WALLS FIRST, THEN CAP (sealShaft) - the head ring gives the cap solid faces so it seals in
    // open-cave geometry, and the alcove cell is kept OPEN (not walled) for the torch.
    const { capped, sideHoles, capPos } = await sealShaft(bot, { feet, head, alcoveCell })
    // Light it: after sealing, the alcove is the sole open floor-level neighbour, so placeTorch
    // lands the torch there (not against some other still-open side).
    if (alcoveCell) { try { await placeTorch(bot) } catch {} }
    dbg('shelter: pit ' + (capped ? 'SEALED' : 'OPEN (cap failed - mob funnel risk)') + (sideHoles ? ' with ' + sideHoles + ' open side(s)' : '') + (alcoveCell ? ' (lit alcove)' : ''))
    say(capped ? 'holed up till it\'s safe' : 'ducked into a hole till it\'s safe')
    // 3) wait until DAY and no hostile near, or a hard timeout (~one full night). An OPEN
    // pit is NOT a shelter - don't squat in a mob funnel for 10 minutes: short deadline,
    // and bail immediately if we're taking hits down there (fight/flee reflexes resume).
    const fullySealed = capped && !sideHoles
    if (fullySealed) { try { rememberInfra('shelter', bot.entity.position.floored()) } catch {} } // bunkers are reusable knowledge
    const deadline = Date.now() + (fullySealed ? 600000 : 120000)
    const hp0 = bot.health || 20
    while (Date.now() < deadline && !isStopped()) {
      if ((!isNight(bot) && !nearHostile(bot, 10)) || nightStuck(bot)) break // stuck night: climb out and re-arm rather than wait forever
      if ((!fullySealed || DEFEND_WHEN_HIT_ON) && (bot.health || 20) < hp0 - 3) { dbg('shelter: taking damage in the ' + (fullySealed ? 'SEALED pit - breached' : 'LEAKY pit') + ' - bailing out to fight/flee'); break }
      // DROWNING BAIL: water reaching the body cells means the pit is flooding - get out
      // NOW, sealed or not (a "sealed" pit beside an aquifer drowned the bot at 4hp, live)
      if (inWaterNow(bot)) {
        dbg('shelter: pit is FLOODING - emergency exit')
        // remember the spot so the next shelter attempt digs somewhere DRY, and drop the
        // registered bunker here - re-entering a flooded pit is not shelter
        lastFlood = { x: bot.entity.position.x, z: bot.entity.position.z, at: Date.now() }
        try { const reg = recallInfra('shelter', bot.entity.position, 3); if (reg) forgetInfra('shelter', listInfra('shelter').find(e => e.x === reg.x && e.z === reg.z)) } catch {}
        break
      }
      await new Promise(r => setTimeout(r, 3000))
    }
    // 4) break the cap and climb back to the surface. Use climbToSurface (staircase-up,
    //    which cuts steps and needs NO filler blocks) - pillarUpTo alone stranded the bot
    //    when it had no dirt left (deaths strip inventory), ratcheting it deeper each night.
    try {
      const cap = bot.blockAt(capPos)
      if (cap && !AIRISH(cap.name) && (!bot.canDigBlock || bot.canDigBlock(cap))) { try { await bot.dig(cap) } catch {} }
      await collectDrops(bot, 3) // recover the cap block as filler
      await climbToSurface(bot, surfaceY, { isStopped })
      // a FLOODED pit defeats climbToSurface (its dig primitives refuse water) - swim out
      if (inWaterNow(bot)) await ensureAshore(bot, isStopped)
    } catch {}
    return true
  } finally { _sheltering = false; bot.clearControlStates && bot.clearControlStates() }
}

// Pick the right tool KIND in inventory for a block (pickaxe/axe/shovel), best
// material first. Returns the item or null (bare hands).
function toolForBlock (bot, blockName) {
  let kind = null
  if (/stone|cobble|ore|deepslate|granite|diorite|andesite|tuff|basalt|blackstone/.test(blockName)) kind = 'pickaxe'
  else if (/_log$|_wood$|_stem$/.test(blockName)) kind = 'axe'
  else if (/dirt|grass_block|sand|gravel|clay|mud/.test(blockName)) kind = 'shovel'
  if (!kind) return null
  const items = (bot.inventory ? bot.inventory.items() : []).filter(i => i.name.endsWith('_' + kind))
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
  for (const m of order) { const t = items.find(i => i.name.startsWith(m)); if (t) return t }
  return items[0] || null
}

// ---- WORLD MEMORY (semantic map, layer 1: resources) --------------------------------
// Perception ends at loaded chunks (~64 blocks) and exploration was memoryless - every
// batch re-searched the world at random (verified live: chopped oak at ~570,30 twice,
// then wandered off southwest and forgot it). Like a player, the bot now REMEMBERS where
// it successfully gathered each resource (bot/world-memory.json), heads straight back
// next time, and forgets spots that dry up.
const WORLD_MEM_FILE = process.env.WORLD_MEM_FILE || path.join(__dirname, 'world-memory.json') // env-overridable so a TEST bot never treks to live-world coords / stomps live memory
let worldMem = null
let worldMemTimer = null
function loadWorldMem () {
  if (worldMem) return worldMem
  try { worldMem = JSON.parse(fs.readFileSync(WORLD_MEM_FILE, 'utf8')) } catch { worldMem = {} }
  return worldMem
}
function saveWorldMem () {
  clearTimeout(worldMemTimer)
  worldMemTimer = setTimeout(() => { try { fs.writeFileSync(WORLD_MEM_FILE, JSON.stringify(worldMem, null, 1)) } catch {} }, 2000)
  if (worldMemTimer.unref) worldMemTimer.unref()
}
// ---- SEMANTIC WORLD-MAP slice 1: ROUTE-REUSE + WEDGE-MEMORY -------------------------
// Persistent routes + wedges live in the SAME world-memory.json under the SAME debounced
// saveWorldMem writer (no second writer). Pure geometry is in route-mem.js; these thin
// accessors are the ONLY bot-side wiring. HONEST: this reduces getting-stuck, it does not
// cure it - the blind static straight-line planner is still the root cause (see route-mem.js).
//
// Own-infra anchors (XZ) for the #1 rule: the bot must NEVER route AROUND its own
// hut/build/bank, even if it died or wedged there. Used to SUPPRESS wedges on BOTH the
// record and the recall side (12b). Routes need no suppression (a home<->X route ends AT
// home by construction - a feature).
function ownInfraAnchors () {
  const m = loadWorldMem()
  const out = []
  const push = e => { if (e && typeof e.x === 'number' && typeof e.z === 'number') out.push({ x: e.x, z: e.z }) }
  const infra = m.infra || {}
  for (const kind of ['hut', 'bed', 'chest', 'table', 'furnace', 'shelter', 'water']) for (const e of (infra[kind] || [])) push(e)
  if (m.bed) push(m.bed)                       // the spawn bed (mirrored outside infra too)
  if (m.wheatFarm) push(m.wheatFarm)           // our farm plot anchor
  if (buildZone) push({ x: (buildZone.x1 + buildZone.x2) / 2, z: (buildZone.z1 + buildZone.z2) / 2 }) // active build job
  return out
}
// Record a proven trek as a reusable route (from -> to, thinned crumbs). Rejects trips too
// short to be worth reusing and any polyline that wandered too far off the straight line
// (a survival/shelter detour must never get baked into the line). Merges with an existing
// route on the same endpoints (ok++, fresh crumbs).
function rememberRoute (from, to, crumbs) {
  try {
    if (!from || !to || !Array.isArray(crumbs) || crumbs.length < 2) return
    const straight = Math.hypot(to.x - from.x, to.z - from.z)
    if (straight < routeMem.ROUTE_MIN_LEN) return
    const pts = routeMem.thinPolyline(crumbs)
    if (pts.length < 2) return
    const len = routeMem.polylineLength(pts)
    if (len > routeMem.ROUTE_LEN_SANITY * straight) { dbg('route: not recording - polyline ' + Math.round(len) + 'b is >1.6x the ' + Math.round(straight) + 'b straight-line (detour)'); return }
    const m = loadWorldMem()
    const routes = m.routes = m.routes || []
    routeMem.mergeRoute(routes, { a: { x: Math.round(from.x), z: Math.round(from.z) }, b: { x: Math.round(to.x), z: Math.round(to.z) }, pts, len, at: Date.now() })
    saveWorldMem()
    dbg('route: recorded ' + Math.round(straight) + 'b trek (' + pts.length + ' pts) ' + Math.round(from.x) + ',' + Math.round(from.z) + ' -> ' + Math.round(to.x) + ',' + Math.round(to.z))
  } catch (e) { dbg('route: remember failed - ' + e.message) }
}
// Look up a usable route between two points (endpoints +-24b, net-successes, length sane).
// Returns { route, reversed, pts } (pts already oriented in the travel direction) or null.
function recallRoute (from, to) {
  try {
    const routes = (loadWorldMem().routes) || []
    const m = routeMem.matchRoute(routes, from, to)
    if (!m || !routeMem.routeUsable(m.route)) return null
    const pts = m.reversed ? m.route.pts.slice().reverse() : m.route.pts.slice()
    if (pts.length < 2) return null
    return { route: m.route, reversed: m.reversed, pts }
  } catch { return null }
}
// NAV Phase C (NAV_WAYPOINT_GRAPH): compose a route over the WAYPOINT GRAPH built from ALL usable
// routes + own-infra anchors - so a trek between two proven areas can stitch segments from
// DIFFERENT routes (a shared corridor) that no single recallRoute covers. Returns { pts } (an
// ordered {x,z} polyline to walk like a replay) or null (=> caller falls back to recallRoute, then
// bearing). Length-sane guard: a composed detour >1.6x the straight line is rejected (never bake a
// wander into the line). Reuses the same worldMem.routes / ownInfraAnchors - no new store/writer.
function planTrekRoute (from, to) {
  if (!NAV_WAYPOINT_GRAPH) return null
  try {
    const routes = (loadWorldMem().routes) || []
    if (routes.length < 2) return null // one route is already served by recallRoute's whole-route replay - the graph earns its keep only by COMPOSING >=2
    const graph = routeMem.buildGraph(routes, ownInfraAnchors())
    const nodes = routeMem.planOverGraph(graph, from, to)
    if (!nodes || nodes.length < 2) return null
    const straight = Math.hypot(to.x - from.x, to.z - from.z)
    const plen = routeMem.polylineLength(nodes)
    if (straight > 0 && plen > routeMem.ROUTE_LEN_SANITY * straight) { dbg('graph: composed plan ' + Math.round(plen) + 'b >1.6x the ' + Math.round(straight) + 'b straight-line - falling back'); return null }
    return { pts: nodes }
  } catch (e) { dbg('graph: plan failed - ' + e.message); return null }
}
// A replay stalled (measured, non-reflex) - the route is stale. fail++; 2 consecutive fails
// evict it. Caller then falls back to today's blind bearing UNCHANGED.
function dementRoute (route) {
  try {
    if (!route) return
    route.fail = (route.fail || 0) + 1
    if (routeMem.routeShouldEvict(route)) {
      const routes = (loadWorldMem().routes) || []
      const i = routes.indexOf(route)
      if (i >= 0) routes.splice(i, 1)
      dbg('route: evicted after 2 consecutive fails')
    } else dbg('route: demoted (fail ' + route.fail + ')')
    saveWorldMem()
  } catch (e) { dbg('route: dement failed - ' + e.message) }
}
// Record a physical stuck-spot (forceUnstick fired here). NO-OP under 12b own-infra
// suppression (record side of the #1 rule) - a wedge at/near home must never be learned.
function recordWedge (pos) {
  try {
    if (!pos || typeof pos.x !== 'number') return
    if (routeMem.suppressedNearAnchors(ownInfraAnchors(), pos)) { dbg('wedge: not recording - within 12b of own infra (' + Math.round(pos.x) + ',' + Math.round(pos.z) + ')'); return }
    const m = loadWorldMem()
    const wedges = m.wedges = m.wedges || []
    routeMem.mergeWedge(wedges, pos)
    saveWorldMem()
    dbg('wedge: recorded stuck-spot ' + Math.round(pos.x) + ',' + Math.round(pos.z))
  } catch (e) { dbg('wedge: record failed - ' + e.message) }
}
// The steer-eligible wedge list: alive (age-weighted) AND re-checked NOW against the
// current infra list (recall side of the #1 rule) - a hut built after a wedge, or a stale
// entry near home, is filtered out before it can ever steer routing.
function listWedges () {
  try { return routeMem.activeWedges((loadWorldMem().wedges) || [], ownInfraAnchors()) } catch { return [] }
}
function rememberSpot (item, pos, tag) {
  const m = loadWorldMem()
  const list = m[item] = m[item] || []
  for (const sp of list) {
    if (Math.hypot(sp.x - pos.x, sp.z - pos.z) < 24) {
      sp.hits = (sp.hits || 1) + 1; sp.at = Date.now()
      if (sp.dryAt) delete sp.dryAt // a fresh success here clears the dry-on-arrival cooldown
      if (tag) Object.assign(sp, tag)  // e.g. { orchard:true } so this entry is never hard-deleted
      saveWorldMem(); return
    }
  }
  const e = { x: Math.round(pos.x), z: Math.round(pos.z), at: Date.now(), hits: 1 }
  if (tag) Object.assign(e, tag)
  list.push(e)
  if (list.length > 20) { list.sort((a, b) => (b.hits - a.hits) || (b.at - a.at)); list.length = 20 }
  saveWorldMem()
}
function forgetSpot (item, spot, hard) {
  const list = loadWorldMem()[item] || []
  if (!hard) {
    // soft forget (decrement-decay): the spot lost a little confidence, delete at zero.
    spot.hits = (spot.hits || 1) - 1
    if (spot.hits <= 0) { const i = list.indexOf(spot); if (i >= 0) list.splice(i, 1) }
    saveWorldMem(); return
  }
  // HARD: the spot was BONE-DRY on arrival after a deliberate trek. An ORCHARD entry regrows -
  // NEVER hard-delete it, just rest-cool it so recall skips it while the trees come back. A wild
  // spot: MARK it (dryAt suppresses recall for a cooldown, hits demoted) and give regrowth ONE
  // chance; twice-dead (tries>=2) = gone. Marking-not-deleting stops a hits:5 chopped-out spot
  // from staying a top recall candidate while still remembering the forest may regrow.
  if (spot.orchard) { spot.rest = Date.now() + 8 * 60000; spot.hits = 0; saveWorldMem(); return }
  spot.tries = (spot.tries || 0) + 1
  spot.dryAt = Date.now()
  spot.hits = 0
  if (spot.tries >= 2) { const i = list.indexOf(spot); if (i >= 0) list.splice(i, 1) }
  saveWorldMem()
}
function recallSpot (item, pos, visited) {
  const list = loadWorldMem()[item] || []
  // SCORED pick (not just nearest-unvisited): skip exhausted/cooling spots, and prefer a spot
  // that is NEAR and RECENTLY-PRODUCTIVE over a far/stale one. The old nearest-first pick treks
  // 320b to a stale hits:5 spot, finds it dry, drops it, recalls the next far spot - burning the
  // deadline before the near ring is ever swept.
  const now = Date.now(); const DRY_COOLDOWN = 20 * 60000; const STALE = 45 * 60000
  let best = null; let bs = Infinity
  for (const sp of list) {
    if (visited.has(sp.x + ',' + sp.z)) continue
    if (sp.rest && sp.rest > now) continue // growing grove on cooldown - let the trees grow
    if (sp.dryAt && now - sp.dryAt < DRY_COOLDOWN) continue // just came up dry - don't re-trek it yet
    const d = Math.hypot(sp.x - pos.x, sp.z - pos.z)
    if (d > 400 || d < 16) continue // too far to trek / already here
    const stalePenalty = (now - (sp.at || 0) > STALE) ? 200 : 0
    const score = d + stalePenalty - Math.min(48, (sp.hits || 1) * 8) // near + recently-productive wins
    if (score < bs) { bs = score; best = sp }
  }
  return best
}

// INFRASTRUCTURE MEMORY (operator-requested): remember our OWN tables/furnaces/chests and
// walk back to them instead of littering the landscape with a fresh crafting table every
// time the last one fell out of the loaded chunks or behind torn-up terrain.
function rememberInfra (kind, pos, meta) {
  // PROVENANCE (fix #13): genuine PLACEMENT sites tag { own: true } so furnace consolidation
  // can tell a furnace the bot provably placed from a merely-adopted (possibly player) one.
  // Adoption sites pass no meta => no `own` field (byte-equivalent to fd90c9f when unset).
  const own = !!(meta && meta.own)
  // FARM_EXPAND (§4.5): a whitelisted quality tag for water edges. ensureWheatFarm/scouts survey
  // a bank while standing there and remember tillable/flat/surveyedAt for free; siting reads them
  // back. Byte-equivalent when meta carries none of these (every existing caller passes {own} or
  // nothing). Refreshes on the exact-cell dedup hit so a re-survey overwrites stale numbers.
  const applyMeta = e => {
    if (!meta) return
    if (meta.tillable != null) e.tillable = meta.tillable
    if (meta.flat != null) e.flat = meta.flat
    if (meta.surveyedAt != null) e.surveyedAt = meta.surveyedAt
  }
  const m = loadWorldMem()
  const s = m.infra = m.infra || {}
  const list = s[kind] = s[kind] || []
  // EXACT-cell dedup: the old radius-2 merge collapsed adjacent blocks into ONE entry, so
  // a double chest (two adjacent) or a chest+table read as a single remembered thing and
  // the bot lost track of what it had placed (operator: duplicate table, table on chest).
  // On a dedup hit, PRESERVE an existing own flag and only ever SET it (never clear it).
  for (const e of list) { if (e.x === Math.floor(pos.x) && e.y === Math.floor(pos.y) && e.z === Math.floor(pos.z)) { e.at = Date.now(); if (own) e.own = true; applyMeta(e); saveWorldMem(); return } }
  const entry = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at: Date.now() }
  if (own) entry.own = true
  applyMeta(entry)
  list.push(entry)
  if (list.length > 12) { list.sort((a, b) => b.at - a.at); list.length = 12 }
  saveWorldMem()
}
function recallInfra (kind, pos, maxDist) {
  const list = (loadWorldMem().infra || {})[kind] || []
  let best = null; let bd = Infinity
  for (const e of list) { const d = Math.hypot(e.x - pos.x, e.z - pos.z); if (d <= maxDist && d < bd) { bd = d; best = e } }
  return best
}
function forgetInfra (kind, entry) {
  const list = (loadWorldMem().infra || {})[kind] || []
  let i = list.indexOf(entry)
  // callers hold COPIES (resources.js maps/spreads the entries), so reference identity
  // alone never matched for them - fall back to coordinate identity
  if (i < 0) i = list.findIndex(e => e.x === entry.x && e.y === entry.y && e.z === entry.z)
  if (i >= 0) { list.splice(i, 1); saveWorldMem() }
}
// What block each infra kind IS in the world - lets memory be VERIFIED against reality
// (operator: "fix the memory completely so it applies to everything it needs memory for").
// Remembering a coordinate is worthless if the bot never checks the block is still there.
const INFRA_BLOCK = { table: /crafting_table$/, furnace: /furnace$/, chest: /chest$/, bed: /_bed$/ }
// List remembered infra of a kind. Pass `bot` to VERIFY against the world: any entry whose
// chunk is loaded but no longer holds the expected block is pruned (dead placement, someone
// broke it, a bad memory). Unloaded chunks (blockAt null) are kept - we can't disprove them.
function listInfra (kind, bot) {
  const list = (((loadWorldMem().infra || {})[kind]) || []).slice()
  const re = INFRA_BLOCK[kind]
  if (!bot || !re) return list
  const survivors = []; let changed = false
  for (const e of list) {
    const b = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (b == null) { survivors.push(e); continue } // chunk not loaded - can't verify, keep
    if (re.test(b.name)) survivors.push(e); else changed = true // gone/wrong -> prune
  }
  if (changed) { const m = loadWorldMem(); if (m.infra) { m.infra[kind] = survivors; saveWorldMem() } }
  return survivors
}
// Recall the nearest remembered infra of a kind, VERIFIED against the world when `bot` given.
function recallInfraVerified (bot, kind, pos, maxDist) {
  const list = listInfra(kind, bot)
  let best = null; let bd = Infinity
  for (const e of list) { const d = Math.hypot(e.x - pos.x, e.z - pos.z); if (d <= maxDist && d < bd) { bd = d; best = e } }
  return best
}
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
function hutAnchor () { return (listInfra('hut')[0]) || null }
// A world-read closure for the hut-model's pure functions.
function hutReader (bot) { return (x, y, z) => bot.blockAt(new Vec3(x, y, z)) }

// A standable FREE interior cell (floor-level, schema-correct 4x4, threshold excluded),
// nearest to `near` (default: the bot). This is the ONLY sanctioned way to unstick INSIDE
// the hut - step here, NEVER pillar dirt through the roof. Returns a Vec3 or null.
function freeInteriorCell (bot, hut, near) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const cells = hutModel.freeStandCells(hut, hutReader(bot))
  if (!cells.length) return null
  const p = near || bot.entity.position
  cells.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
  const c = cells[0]
  return new Vec3(c.x, c.y, c.z)
}

// REGISTRY INTEGRITY: reconcile the infra registry against the WORLD so the bot's model of
// its own home matches reality. The live registry was garbage (12 crafting_table entries,
// 7 furnaces, 0 beds for a bed that exists) because nothing pruned dead/duplicate cells.
// For every kind: dedupe exact cells and DROP entries whose loaded cell no longer holds
// the block (unloaded/unknown kept). Then re-seed from what physically stands INSIDE the
// hut (the authoritative count) so the true stations are always registered - including the
// bed (also mirrored into m.bed / knownBed, the spawn anchor). Returns a summary.
function reconcileInfra (bot) {
  const m = loadWorldMem()
  const infra = m.infra = m.infra || {}
  const summary = {}
  const hut = hutAnchor()
  const inHut = e => hut && hutModel.isInterior(hut, e.x, e.z) && e.y >= hut.y && e.y <= hut.y + hutModel.DIMS.h - 1
  for (const kind of ['table', 'furnace', 'chest', 'bed']) {
    const re = INFRA_BLOCK[kind]
    const list = (infra[kind] || []).slice()
    const verify = e => { const b = bot.blockAt(new Vec3(e.x, e.y, e.z)); if (b == null) return null; return re.test(b.name) }
    let { keep } = hutModel.reconcileCells(list, verify)
    summary[kind] = { was: list.length }
    // Re-seed the true in-hut stations (world scan) so real furniture is never lost from
    // memory, and phantom in-hut entries (cell now empty) are already gone from `keep`.
    if (hut) {
      const stations = hutModel.stationCells(hut, hutReader(bot))[kind] || []
      for (const s of stations) if (!keep.some(e => e.x === s.x && e.y === s.y && e.z === s.z)) keep.push({ x: s.x, y: s.y, z: s.z, at: Date.now() })
      // any KEEP entry that is inside the hut box but no longer a real station was already
      // dropped by verify; nothing more to do.
    }
    infra[kind] = keep
    summary[kind].now = keep.length
  }
  saveWorldMem()
  // Bed doubles as the spawn anchor - if one stands in the hut and m.bed is empty/stale,
  // point knownBed at it so ensureSpawnBed stops hunting a phantom.
  try {
    if (hut) {
      const beds = hutModel.stationCells(hut, hutReader(bot)).bed
      if (beds.length && (!m.bed || !bot.blockAt(new Vec3(m.bed.x, m.bed.y, m.bed.z)) || !/_bed$/.test((bot.blockAt(new Vec3(m.bed.x, m.bed.y, m.bed.z)) || {}).name || ''))) {
        rememberBed(new Vec3(beds[0].x, beds[0].y, beds[0].z))
        summary.bed.seededSpawn = true
      }
    }
  } catch (e) { dbg('reconcileInfra: bed/spawn reseed failed (' + e.message + ')') }
  dbg('reconcileInfra: ' + Object.entries(summary).map(([k, v]) => `${k} ${v.was}->${v.now}`).join(', '))
  return summary
}

// INTERIOR CLEANUP with a VERIFIED postcondition: dig every stray filler block in the
// interior (floor piles + head-height pillar remnants), remove DUPLICATE in-hut stations
// (keep one per kind), fill floor holes, and RE-RUN until a fresh world read confirms the
// interior is clean - not best-effort. Uses the self-structure model to know stray vs
// legit. Operator-triggerable (the `huttidy` command) to fix the current dirty hut.
// Returns { ok, passes, remaining, dug, removedDupes }.
async function cleanupHutInterior (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hut = hut || hutAnchor()
  if (!hut) return { ok: false, passes: 0, remaining: ['no hut registered'], dug: 0, removedDupes: 0 }
  const read = hutReader(bot)
  const maxPasses = opts.maxPasses || 4
  let dug = 0; let removedDupes = 0; let pass = 0
  const digAt = async (c) => {
    const p = new Vec3(c.x, c.y, c.z)
    const b = bot.blockAt(p)
    if (!b || AIRISH(b.name)) return false
    try {
      if (bot.entity.position.distanceTo(p) > 4) await navigate.gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 12000)
    } catch { /* dig test below still gates reach */ }
    const tool = toolForBlock(bot, b.name); if (tool) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) { dbg('  huttidy: cannot reach ' + b.name + ' at ' + p.toString() + ' this pass'); return false }
    try { await bot.dig(b); await collectDrops(bot, 3); return true } catch (e) { dbg('  huttidy: dig failed at ' + p.toString() + ' (' + e.message + ')'); return false }
  }
  for (pass = 1; pass <= maxPasses; pass++) {
    if (isStopped()) break
    // 1) stray filler (dig top-down so a pile clears cleanly)
    const strays = hutModel.strayCells(hut, read).sort((a, b) => b.y - a.y)
    for (const s of strays) { if (isStopped()) break; if (await digAt(s)) dug++ }
    // 2) duplicate stations: keep the FIRST of each kind, dig the rest (a second table
    //    boxes the bot in; only one is needed). Chests are exempt (a double chest is two
    //    legit adjacent cells) and so are beds (one bed, never dig the spawn anchor here).
    for (const kind of ['table', 'furnace']) {
      const cells = hutModel.stationCells(hut, read)[kind] || []
      for (let i = 1; i < cells.length; i++) {
        if (isStopped()) break
        if (await digAt(cells[i])) { removedDupes++; dbg('  huttidy: removed duplicate ' + kind + ' at ' + cells[i].x + ',' + cells[i].y + ',' + cells[i].z) }
      }
    }
    // 3) floor holes -> fill with carried filler (a hole wedges/traps; NOT a pillar - this
    //    is the floor level, anchor.y-1, the one place filling is legitimate indoors)
    for (const h of hutModel.floorHoles(hut, read)) {
      if (isStopped()) break
      try { await placeAt(bot, new Vec3(h.x, h.y, h.z), /^(dirt|coarse_dirt|cobblestone)$/) } catch {}
    }
    // VERIFY (fresh reads): clean iff no stray, <=1 table, <=1 furnace, no floor hole
    const strayLeft = hutModel.strayCells(hut, read)
    const st = hutModel.stationCells(hut, read)
    const holesLeft = hutModel.floorHoles(hut, read)
    const remaining = []
    if (strayLeft.length) remaining.push(strayLeft.length + ' stray')
    if (st.table.length > 1) remaining.push(st.table.length + ' tables')
    if (st.furnace.length > 1) remaining.push(st.furnace.length + ' furnaces')
    if (holesLeft.length) remaining.push(holesLeft.length + ' floor holes')
    dbg('  huttidy pass ' + pass + ': dug=' + dug + ' dupes=' + removedDupes + ' remaining=[' + remaining.join(', ') + ']')
    if (!remaining.length) { try { reconcileInfra(bot) } catch (e) { dbg('  huttidy: reconcile failed (' + e.message + ')') }; return { ok: true, passes: pass, remaining: [], dug, removedDupes } }
    if (pass === maxPasses) { try { reconcileInfra(bot) } catch {}; return { ok: false, passes: pass, remaining, dug, removedDupes } }
  }
  return { ok: false, passes: pass, remaining: ['stopped'], dug, removedDupes }
}

// A station of `kind` physically standing in the hut interior (world scan, not the lying
// registry), or null. The authoritative "do I already have one inside" check.
function stationInHut (bot, kind, hut) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const cells = hutModel.stationCells(hut, hutReader(bot))[kind] || []
  return cells.length ? new Vec3(cells[0].x, cells[0].y, cells[0].z) : null
}

// Where to place a NEW station of `kind` inside the hut - a free interior FLOOR cell (Vec3),
// or null when `desired` of that kind already stand (never duplicate) or the interior is
// full. The placement guard the ensure*/furnish flows consult so they stop re-duplicating.
function stationSlot (bot, kind, desired = 1, hut) {
  hut = hut || hutAnchor()
  if (!hut) return null
  const c = hutModel.stationSlot(hut, hutReader(bot), kind, desired)
  return c ? new Vec3(c.x, c.y, c.z) : null
}

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
let _hutSchemCache = null
async function loadHutSchem (version) {
  if (_hutSchemCache && _hutSchemCache.version === version) return _hutSchemCache.schem
  try {
    const schematic = require('./schematic.js') // lazy - schematic requires provision back
    const schem = await schematic.loadFile('hut.schem', version)
    _hutSchemCache = { version, schem }
    return schem
  } catch (e) { dbg('repairHut: schematic load failed (' + e.message + ')'); return null }
}
async function repairHutStructure (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hut = hut || hutAnchor()
  if (!hut) return { skipped: 'no hut' }
  if (process.env.HUT_REPAIR === '0') return { skipped: 'disabled' }
  // repairing under attack means standing still placing blocks while a mob hits us - defer.
  if (nearHostile(bot, 10) && underArmored(bot)) return { skipped: 'hostiles near' }
  const schem = await loadHutSchem(bot.version)
  if (!schem) return { skipped: 'no schematic' }
  const st = schem.start(); const en = schem.end()
  const AIRRE = /^(air|cave_air|void_air)$/
  const missPlank = []                 // world coords wanting a plank the world lacks
  let doorLower = null                  // world coord of the door's LOWER cell (place the item once)
  let doorPresent = false
  const missFurn = []                   // { pos, kind, item, re }
  const FURN = {
    chest: { item: 'chest', re: /chest$/ },
    furnace: { item: 'furnace', re: /^furnace$/ },
    crafting_table: { item: 'crafting_table', re: /^crafting_table$/ }
  }
  // 1) scan the schematic, block-read each cell, classify what's MISSING.
  for (let y = st.y; y <= en.y; y++) for (let z = st.z; z <= en.z; z++) for (let x = st.x; x <= en.x; x++) {
    const w = schem.getBlock(new Vec3(x, y, z))
    if (!w || !w.name || AIRRE.test(w.name)) continue // schema wants air/interior - never fill
    const wp = new Vec3(hut.x + (x - st.x), hut.y + (y - st.y), hut.z + (z - st.z))
    const g = bot.blockAt(wp)
    if (!g) continue // unloaded chunk - skip this pass
    if (/_planks$/.test(w.name)) { if (!/_planks$/.test(g.name)) missPlank.push(wp) }
    else if (/_door$/.test(w.name)) {
      if (/_door$/.test(g.name)) { doorPresent = true } else if (!doorLower || wp.y < doorLower.y) doorLower = wp // lowest door cell = where the item goes
    } else if (/crafting_table$/.test(w.name)) { if (!FURN.crafting_table.re.test(g.name)) missFurn.push({ pos: wp, kind: 'table', item: 'crafting_table', re: FURN.crafting_table.re }) } else if (/^furnace$|furnace$/.test(w.name)) { if (!FURN.furnace.re.test(g.name)) missFurn.push({ pos: wp, kind: 'furnace', item: 'furnace', re: FURN.furnace.re }) } else if (/chest$/.test(w.name)) { if (!FURN.chest.re.test(g.name)) missFurn.push({ pos: wp, kind: 'chest', item: 'chest', re: FURN.chest.re }) }
  }
  const wantDoor = !!doorLower && !doorPresent
  const missing = missPlank.length + (wantDoor ? 1 : 0) + missFurn.length
  if (!missing) { dbg('repairHut: intact - no-op'); return { planks: 0, doors: 0, furniture: 0, missing: 0 } }
  dbg('repairHut: ' + missing + ' cell(s) off (planks ' + missPlank.length + ', door ' + (wantDoor ? 1 : 0) + ', furniture ' + missFurn.length + ') - patching')
  say('creeper damage on my hut - patching ' + missing + ' block(s)')
  const res = require('./resources.js')
  const near = { x: hut.x + 2, y: hut.y + 1, z: hut.z + 2 }
  // helper: dig a natural intruder occupying a cell we need (dirt washed in / grass), never a build block
  const clearCell = async (wp, keepRe) => {
    const b = bot.blockAt(wp)
    if (b && !AIRRE.test(b.name) && !keepRe.test(b.name) && canBreakNaturally(b)) {
      try { if (bot.entity.position.distanceTo(wp) > 4) await navigate.gotoOnce(bot, new goals.GoalNear(wp.x, wp.y, wp.z, 2), 8000); const t = toolForBlock(bot, b.name); if (t) await bot.equip(t, 'hand').catch(() => {}); await bot.dig(b) } catch {}
    }
  }
  // 2) SHELL PLANKS - acquire in one batch, place BOTTOM-UP (each course/roof cell then has a
  //    solid neighbour below/beside to place against). oak to match the schematic (any plank
  //    still works structurally, but matching keeps the camp's mismatch count quiet).
  let plankDone = 0
  if (missPlank.length) {
    try { await res.acquire(bot, 'oak_planks', Math.min(missPlank.length, 128), { near, batch: 64, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: plank acquire failed (' + e.message + ')') }
    for (const wp of missPlank.sort((a, b) => a.y - b.y)) {
      if (isStopped()) break
      const g = bot.blockAt(wp); if (g && /_planks$/.test(g.name)) { plankDone++; continue }
      if (!(bot.inventory ? bot.inventory.items() : []).some(i => /_planks$/.test(i.name))) { dbg('repairHut: out of planks - ' + (missPlank.length - plankDone) + ' wall cell(s) left'); break }
      await clearCell(wp, /_planks$/)
      if (bot.entity.position.distanceTo(wp) > 4) { try { await navigate.gotoOnce(bot, new goals.GoalNear(wp.x, wp.y, wp.z, 2), 12000) } catch {} }
      if (await placeAt(bot, wp, /_planks$/)) plankDone++
      else dbg('repairHut: could not place plank at ' + wp.toString() + ' (' + placeAt.lastFail + ')')
    }
  }
  // 3) DOOR - one item hangs the whole 2-tall door. Stand OUTSIDE facing the hut centre so it
  //    opens the right way (schematic door on the z0 wall opens toward -z).
  let doorDone = 0
  if (wantDoor) {
    let door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name))
    if (!door) { try { await res.acquire(bot, 'oak_door', 1, { near, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: door acquire failed (' + e.message + ')') } ; door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name)) }
    const floor = bot.blockAt(doorLower.offset(0, -1, 0))
    if (door && floor && floor.boundingBox === 'block') {
      const ox = doorLower.x === hut.x ? -1 : doorLower.x === hut.x + hutModel.DIMS.w - 1 ? 1 : 0
      const oz = doorLower.z === hut.z ? -1 : doorLower.z === hut.z + hutModel.DIMS.l - 1 ? 1 : 0
      try { await navigate.gotoOnce(bot, new goals.GoalBlock(doorLower.x + ox, doorLower.y, doorLower.z + oz), 12000) } catch {}
      try { await bot.lookAt(new Vec3(hut.x + 2.5, hut.y + 1.5, hut.z + 2.5), true) } catch {}
      try { await bot.equip(door, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)); doorDone++ } catch (e) { dbg('repairHut: door place failed (' + e.message + ')') }
    } else if (!door) dbg('repairHut: no door and could not craft one')
  }
  // 4) FURNITURE - place each missing chest/furnace/table at its exact cell (the schematic's
  //    two adjacent chests auto-merge into the double bank). Re-register so the infra registry
  //    knows the rebuilt station.
  let furnDone = 0
  for (const f of missFurn) {
    if (isStopped()) break
    const g = bot.blockAt(f.pos); if (g && f.re.test(g.name)) { furnDone++; continue }
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name === f.item)) {
      try { await res.acquire(bot, f.item, 1, { near, batch: 1, isStopped, say, planOpts: { primaryWood: 'oak' } }) } catch (e) { dbg('repairHut: ' + f.item + ' acquire failed (' + e.message + ')') }
    }
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name === f.item)) { dbg('repairHut: no ' + f.item + ' to place (kept a wall/door open? gather short)'); continue }
    await clearCell(f.pos, f.re)
    if (bot.entity.position.distanceTo(f.pos) > 3) { try { await navigate.gotoOnce(bot, new goals.GoalNear(f.pos.x, f.pos.y, f.pos.z, 2), 12000) } catch {} }
    if (await placeAt(bot, f.pos, f.re)) { furnDone++; rememberInfra(f.kind === 'table' ? 'table' : f.kind, f.pos); dbg('repairHut: re-placed ' + f.kind + ' at ' + f.pos.toString()) } else dbg('repairHut: could not place ' + f.kind + ' at ' + f.pos.toString() + ' (' + placeAt.lastFail + ')')
  }
  try { reconcileInfra(bot) } catch {}
  const done = plankDone + doorDone + furnDone
  if (done) say('hut repaired - ' + [plankDone && plankDone + ' wall', doorDone && 'door', furnDone && furnDone + ' station'].filter(Boolean).join(' + ') + ' back')
  dbg('repairHut: patched planks ' + plankDone + '/' + missPlank.length + ', door ' + doorDone + '/' + (wantDoor ? 1 : 0) + ', furniture ' + furnDone + '/' + missFurn.length)
  return { planks: plankDone, doors: doorDone, furniture: furnDone, missing }
}

// SELF-HEALING hut maintenance for the camp pass: reconcile the registry against the world,
// REPAIR structural creeper damage (missing wall/door/floor/roof + chest/furnace/table), then
// tidy the interior IFF a cheap model scan says it's dirty (stray filler / duplicate station /
// floor hole) - an early no-op when the hut is already clean+intact, so it's safe to run every
// pass. Returns { clean/cleanup..., repair }. Gated by the caller's isStopped.
async function maintainHut (bot, hut, opts = {}) {
  hut = hut || hutAnchor()
  if (!hut) return { skipped: 'no hut' }
  try { reconcileInfra(bot) } catch (e) { dbg('maintainHut: reconcile failed (' + e.message + ')') }
  // STRUCTURAL REPAIR first: a hole in the shell lets mobs in and the bank chest may be gone
  // (live: a creeper flattened the door, west wall, bank chest, furnace + bed). Idempotent.
  let repair = null
  try { repair = await repairHutStructure(bot, hut, opts) } catch (e) { dbg('maintainHut: structural repair failed (' + e.message + ')') }
  const read = hutReader(bot)
  let strays, st, holes
  try { strays = hutModel.strayCells(hut, read); st = hutModel.stationCells(hut, read); holes = hutModel.floorHoles(hut, read) } catch (e) { dbg('maintainHut: scan failed (' + e.message + ')'); return { skipped: e.message, repair } }
  const dirty = strays.length || (st.table.length > 1) || (st.furnace.length > 1) || holes.length
  if (!dirty) { dbg('maintainHut: interior already clean - no-op'); return { clean: !repair || !repair.missing, repair } }
  dbg('maintainHut: interior dirty (stray=' + strays.length + ' tables=' + st.table.length + ' furnaces=' + st.furnace.length + ' holes=' + holes.length + ') - tidying')
  const r = await cleanupHutInterior(bot, hut, opts)
  return { ...r, repair }
}

// SURVIVAL-REFLEX home upkeep, shared with the camp pass (commands.js) so there is ONE code
// path. Runs the SAME liveability chain the camp pass always ran - apron -> bed -> bank
// double-heal -> spawn re-assert -> structural repair + interior tidy -> consolidate field
// chests - each step in its own try/catch with the SAME 'camp:' dbg lines. Extracted so a
// creeper-damaged base self-heals during ordinary idle survival too, not only inside a full
// camp job (which gates on a ~>=500-block BOM). Each underlying step already no-ops fast when
// its piece is intact, so this is cheap to run when nothing is broken - no forced rebuilds.
// Returns { bed, chestFixed, repair, consolidated, damaged }; `damaged` is true when any step
// actually did work, so the reflex can log/back off meaningfully when the home was intact.
async function maintainHome (bot, hutAt, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  hutAt = hutAt || hutAnchor()
  const out = { bed: null, chestFixed: false, repair: null, consolidated: 0, damaged: false }
  if (!hutAt) return out
  try { await ensureHutApron(bot, hutAt, { isStopped, say }) } catch (e) { dbg('camp: apron fill failed (' + e.message + ')') }
  // rebuild/verify the bed. Anything but 'present' means a bed was missing/placed/unplaceable
  // = the home needed work.
  try { const bs = await ensureHutBed(bot, hutAt, { isStopped, say }); out.bed = bs; dbg('camp: hut bed -> ' + bs); if (bs !== 'present') out.damaged = true } catch (e) { dbg('camp: hut bed failed (' + e.message + ')') }
  // BANK DOUBLE-CHEST HEAL (liveability, every pass): a rebuild that left the bank as two
  // mismatched single chests gets re-faced into one connected double. Idempotent: a merged
  // pair is a fast no-op (returns false).
  try { if (await healBankDouble(bot, { x: hutAt.x, y: hutAt.y, z: hutAt.z }, { isStopped, say })) { out.chestFixed = true; out.damaged = true; say('fixed the bank - one proper double chest again') } } catch (e) { dbg('camp: bank double-heal failed (' + e.message + ')') }
  // SPAWN re-assert (hourly no-op): a bed standing in the hut is worthless if the server
  // anchor drifted - use it again so every death keeps coming home.
  try { await ensureSpawnBed(bot, { isStopped, say }) } catch (e) { dbg('camp: spawn assert failed (' + e.message + ')') }
  // SELF-HEALING structure + interior (liveability, every pass): reconcile the registry, REPAIR
  // creeper damage (missing wall/door/furniture cells), then tidy the interior. Early no-op when
  // already clean+intact. repair.missing (0 = intact) is the cheap structural-damage signal.
  try { const mr = await maintainHut(bot, hutAt, { isStopped, say }); if (mr) { out.repair = mr.repair || null; if (mr.repair && mr.repair.missing) out.damaged = true; if (!mr.clean && !mr.skipped) { out.damaged = true; dbg('camp: hut self-heal -> ' + JSON.stringify({ ok: mr.ok, dug: mr.dug, dupes: mr.removedDupes, passes: mr.passes })) } } } catch (e) { dbg('camp: hut self-heal failed (' + e.message + ')') }
  // HOME BANK (operator promise): the hut chest is the ONE treasury - ferry every loose field
  // chest within 64 into it and pack the empties up. Idempotent.
  try { const nc = await consolidateBank(bot, hutAt, { isStopped, say }); if (nc) { out.consolidated = nc; out.damaged = true; dbg('camp: consolidated ' + nc + ' field chest(s) into the bank') } } catch (e) { dbg('camp: bank consolidation failed (' + e.message + ')') }
  return out
}

// Walk to REMEMBERED ones (up to 3 nearest) and verify each still stands; forget the dead.
// Trying only the single nearest made one stale entry cause a brand-new placement while a
// perfectly good chest stood 9 blocks further (live: three chests at one site).
async function recallAndReach (bot, kind, blockId, maxDist, reach) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const known = recallInfra(kind, bot.entity.position, maxDist)
    if (!known) return null
    dbg('  remembered ' + kind + ' at ' + known.x + ',' + known.y + ',' + known.z + ' - reusing it instead of placing a new one')
    await walkStaged(bot, known.x, known.z, { range: 10, timeoutMs: 60000 })
    const blk = bot.blockAt(new Vec3(known.x, known.y, known.z))
    if (!blk || blk.type !== blockId) { dbg('  remembered ' + kind + ' is gone - forgetting it'); forgetInfra(kind, known); continue }
    if (await reach(blk)) return blk
    return null // it stands but we can't reach it - placing fresh beats looping
  }
  return null
}

// NEGATIVE MEMORY (roomba rule, operator-requested): remember 32-block cells that were
// SEARCHED AND EMPTY, and stop re-sweeping them - the blind compass kept walking the same
// barren ground round after round. A cell un-marks when we PLANT saplings there (that's a
// reason to come back) or after 2h (world changes - players build, trees grow).
const SEARCH_CELL = 32
function searchCellKey (x, z) { return Math.floor(x / SEARCH_CELL) + ',' + Math.floor(z / SEARCH_CELL) }
function markSearched (item, pos) {
  const m = loadWorldMem()
  const s = m.searched = m.searched || {}
  const l = s[item] = s[item] || {}
  l[searchCellKey(pos.x, pos.z)] = Date.now()
  const keys = Object.keys(l)
  if (keys.length > 300) { keys.sort((a, b) => l[a] - l[b]); for (const k of keys.slice(0, keys.length - 300)) delete l[k] }
  saveWorldMem()
}
function isSearchedDry (item, x, z) {
  const l = (loadWorldMem().searched || {})[item] || {}
  const t = l[searchCellKey(x, z)]
  return !!t && Date.now() - t < 2 * 3600 * 1000
}
// GEAR-UP CONVERGENCE (persisted): the iron/armor bootstrap must converge, not flail.
// Every fruitless attempt (no new piece worn, no net iron gained) widens a back-off
// window so the same death-march doesn't re-run on every resume pass; any real progress
// resets it. Survives restarts - the flailing was worst right after respawns.
function gearupState () { return loadWorldMem().gearup || { fails: 0, until: 0 } }
// opts.naked (bool): the attempt ended fully naked (0 pieces worn). #53 NAKED_IRON_GRACE caps a
// naked bot's fruitless cooldown at 12 min (not 45) so it keeps trying to bootstrap armor instead
// of sitting locked out while it dies naked. Armored/partial + flag off -> today's min(45, fails*10).
function gearupResult (progressed, opts = {}) {
  const m = loadWorldMem()
  const g = m.gearup = m.gearup || { fails: 0, until: 0 }
  if (progressed) { g.fails = 0; g.until = 0 } else {
    g.fails++
    const base = Math.min(45, g.fails * 10)
    const mins = arbiter.gearupCooldownMin(g.fails, !!opts.naked, { enabled: process.env.NAKED_IRON_GRACE !== '0' })
    g.until = Date.now() + mins * 60000
    dbg('gearup: fruitless attempt #' + g.fails + ' - backing off ' + mins + ' min' + (mins < base ? ' (naked cap)' : ''))
  }
  saveWorldMem()
}

function clearSearched (item, pos) {
  const l = (loadWorldMem().searched || {})[item]
  if (l && l[searchCellKey(pos.x, pos.z)]) { delete l[searchCellKey(pos.x, pos.z)]; saveWorldMem() }
}

// BED MEMORY: the server knows the bot's spawn bed but never tells the client, and the
// sleep command only scans 48 blocks around wherever the bot happens to stand - so at
// dusk 150 blocks out it "had no bed" and dug a pit instead (7 night deaths in one
// evening, live). Remember the bed like a player does: saved on every successful
// sleep/spawn-set, consulted first every night.
// Every rememberBed call site follows an actual spawn-setting action (a sleep or a
// day bed-use), so it doubles as the "spawn last asserted" timestamp ensureSpawnBed
// keys off.
function rememberBed (pos) { const m = loadWorldMem(); m.bed = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), at: Date.now() }; m.bedAssertAt = Date.now(); delete m.spawnSuspect; saveWorldMem(); _bedHold = { until: 0, key: '' } }
function knownBed () { return loadWorldMem().bed || null }
function forgetBed () { const m = loadWorldMem(); delete m.bed; saveWorldMem(); _bedHold = { until: 0, key: '' } }

// UNUSABLE-BED HOLD (fix #14, flag SHELTER_BED_FALLBACK): sleepInBedHere's non-/monster/
// failure is stateless, so nightRestInner re-committed every caller to a bed mineflayer had
// just proven unusable (cant-click reach is position-deterministic) - paying a ~40s doomed
// bed prefix each cycle and starving flee/defend. Remember, per-bed and time-bounded, that
// THIS remembered bed just failed so nightRest pits straight away within the window. The bed
// itself is NEVER forgotten (hold != forget - the fell-short regression guard stays); the hold
// is cleared by expiry, a real sleep (rememberBed), or forgetBed, and never persisted (a
// restart forgets it => one extra bed attempt, which is safe). now-injectable for the test.
let _bedHold = { until: 0, key: '' }
function bedKey (pos) { return Math.round(pos.x) + '|' + Math.round(pos.y) + '|' + Math.round(pos.z) }
function markBedUnusable (pos, ms, why, now = Date.now()) {
  if (process.env.SHELTER_BED_FALLBACK === '0' || !pos || !(ms > 0)) return
  _bedHold = { until: now + ms, key: bedKey(pos) }
  dbg('nightRest: bed at ' + bedKey(pos).replace(/\|/g, ',') + ' unusable (' + why + ') - holding off it for ' + Math.round(ms / 1000) + 's')
}
function bedHeld (pos, now = Date.now()) { return !!pos && _bedHold.key === bedKey(pos) && now < _bedHold.until }

// SPAWN-SUSPECT flag, PERSISTED: a respawn landed far from the remembered bed, so the
// server-side anchor is wrong (bed broken/obstructed) - every death is a world-spawn
// carousel until a bed is re-asserted. The old flag lived in commands.js RAM and died
// with every restart/deploy mid-crisis (the overnight spiral straddled several). Cleared
// by rememberBed (every real spawn-setting action goes through it).
function setSpawnSuspect (v) { const m = loadWorldMem(); if (v) m.spawnSuspect = Date.now(); else delete m.spawnSuspect; saveWorldMem() }
function isSpawnSuspect () { return !!loadWorldMem().spawnSuspect }

// SPAWN GUARANTEE: make sure the respawn anchor really is the (hut) bed. USE the bed -
// sets the spawn even at day - whenever we're near it and haven't asserted it recently
// (opts.force skips the freshness check; a respawn far from the remembered bed means the
// server spawn is WRONG - bed broken/obstructed/moved - and every death becomes a world-
// spawn carousel until this runs). If the remembered bed is gone, scan close (rebuilds
// shift it a cell), else lay a fresh one in the hut. Bounded, honest return.
async function ensureSpawnBed (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  if (!bot.entity) return false
  const m = loadWorldMem()
  const bed = knownBed()
  const hut0 = listInfra('hut')[0]
  if (!bed) {
    // no bed memory at all - the hut path is the only play
    if (!hut0) return false
    const r = await ensureHutBed(bot, new Vec3(hut0.x, hut0.y, hut0.z), opts).catch(() => 'fail')
    return r === 'present' || r === 'placed'
  }
  if (!opts.force && m.bedAssertAt && Date.now() - m.bedAssertAt < 3600 * 1000) return true // asserted within the hour
  // PREFER THE HUT BED: a remembered bed far from the hut is a stale anchor (the overnight
  // carousel re-learned a bed at world spawn and kept "asserting" THERE) - never keep it
  // silently while a home hut exists. Re-anchor at the hut; the far bed is only an honest
  // fallback when the hut can't take a bed right now (no bed item - wool is operator-supplied).
  if (hut0 && Math.hypot(bed.x - (hut0.x + 2), bed.z - (hut0.z + 2)) > 24) {
    dbg('spawn: remembered bed ' + bed.x + ',' + bed.z + ' is far from my hut at ' + hut0.x + ',' + hut0.z + ' - re-anchoring at the hut instead')
    const r = await ensureHutBed(bot, new Vec3(hut0.x, hut0.y, hut0.z), opts).catch(() => 'fail')
    if (r === 'present' || r === 'placed') return true
    dbg('spawn: hut bed unavailable (' + r + ') - falling back to the FAR bed at ' + bed.x + ',' + bed.z + ' (better than world spawn)')
  }
  const d = Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z)
  if (d > (opts.maxTrek != null ? opts.maxTrek : 120)) { dbg('spawn: bed too far to assert from here (' + Math.round(d) + 'b)'); return false }
  if (d > 6) { try { await walkStaged(bot, bed.x, bed.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {} }
  let bb = bot.blockAt(new Vec3(bed.x, bed.y, bed.z))
  if (!bb || !/_bed$/.test(bb.name)) {
    const md = require('minecraft-data')(bot.version)
    const ids = Object.values(md.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
    const near = bot.findBlock({ matching: ids, maxDistance: 12 })
    if (near) { bb = near; dbg('spawn: remembered bed shifted - found one at ' + near.position.toString()) }
    else {
      dbg('spawn: remembered bed is GONE - laying a new one')
      forgetBed()
      const hut = listInfra('hut')[0]
      if (hut) { const r = await ensureHutBed(bot, new Vec3(hut.x, hut.y, hut.z), opts).catch(() => 'fail'); return r === 'present' || r === 'placed' }
      return false
    }
  }
  if (bot.entity.position.distanceTo(bb.position) > 2.5) {
    try {
      const nav = require('./navigate.js') // door-assist: the bed lives indoors
      await nav.navigateTo(bot, new goals.GoalNear(bb.position.x, bb.position.y, bb.position.z, 2), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 1, water: 1, nudge: 1 }, label: 'spawn-bed' })
    } catch (e) { dbg('spawn: cannot reach the bed (' + e.message + ')'); return false }
  }
  try {
    if (isNight(bot)) { if (await sleepInBedHere(bot, opts)) return true } // a real sleep sets it
    await bot.activateBlock(bb) // day: right-clicking the bed sets the respawn point
    rememberBed(bb.position)
    dbg('spawn: asserted at the bed ' + bb.position.toString())
    return true
  } catch (e) { dbg('spawn: bed use failed (' + e.message + ')'); return false }
}

// WRONG-ANCHOR RECOVERY, survival tier: the server respawn anchor is lost or far (the
// world-spawn carousel - every death dropped the bot ~430 blocks from home, and it could
// never re-assert because the re-assert only ran "when home"). Getting home and re-
// asserting the hut bed IS the goal here, above build/gather/gear: long-legged trek
// straight to the remembered bed (or the hut), then a FORCED ensureSpawnBed. No 120-block
// maxTrek cop-out - this is exactly the "too far" case. Honest return; the caller retries
// on the next respawn (the persisted spawn-suspect flag survives deaths and restarts).
async function recoverSpawnAnchor (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const bed = knownBed()
  const hut = listInfra('hut')[0]
  // aim at the hut when it exists (the bed we want to anchor); a lone far bed otherwise
  const tx = hut ? hut.x + 2 : (bed ? bed.x : null)
  const tz = hut ? hut.z + 2 : (bed ? bed.z : null)
  if (tx == null) { dbg('spawn-recovery: no hut or bed remembered - nowhere to anchor'); return false }
  const dist = () => Math.hypot(tx - bot.entity.position.x, tz - bot.entity.position.z)
  if (dist() > 6) {
    say(`my spawn point is wrong - heading home (${Math.round(dist())}b) to fix it before anything else`)
    dbg('spawn-recovery: trekking home ' + Math.round(dist()) + 'b to re-anchor the spawn')
    for (let leg = 0; leg < 3 && dist() > 6 && !isStopped(); leg++) {
      try { await walkStaged(bot, tx, tz, { isStopped, range: 5, timeoutMs: 300000 }) } catch (e) { dbg('spawn-recovery: trek leg failed (' + e.message + ')') }
    }
  }
  if (dist() > 12) { dbg('spawn-recovery: could not get home (still ' + Math.round(dist()) + 'b out) - will retry next respawn'); return false }
  const ok = await ensureSpawnBed(bot, { ...opts, force: true, maxTrek: 1e9 })
  dbg('spawn-recovery: ' + (ok ? 'anchor RESTORED at the bed' : 'home but could NOT re-anchor (no usable bed)'))
  return ok
}

// GO-HOME-FIRST decision (PURE, offline-testable): the bot's hut BED got creeper-destroyed,
// so the server respawn fell back to WORLD SPAWN ~570 blocks from base - and live it then
// just GEARED UP out in the wilderness, abandoning its hut/farm/chest and re-doing everything
// from scratch far away. A bot 500 blocks from home should WALK HOME, not re-build its life in
// the wild. This picks the home anchor (hut > remembered bed > persisted build site) and
// decides whether we landed far enough to trek home BEFORE any gear-up/local gathering. XZ
// distance only - respawn Y varies, and "far" is a horizontal concept. No bot handle, just
// data, so the "am I far from home -> go home" logic is unit-tested without a world.
function homeRecoveryDecision ({ hut, bed, resumeAt, pos, dist } = {}) {
  const D = dist != null ? dist : Number(process.env.RECOVER_HOME_DIST || 64)
  // Anchor priority: the HUT is true home (its bed is the spawn we want back). A lone
  // remembered bed is next. The persisted build site is a last resort - still far better
  // than stranding at world spawn. Stand-point is +2,+2 into the hut footprint so the trek
  // ends INSIDE (where ensureHutBed lays the bed), not against an outer wall.
  let anchor = null; let source = null
  if (hut) { anchor = { x: hut.x + 2, y: hut.y, z: hut.z + 2 }; source = 'hut' }
  else if (bed) { anchor = { x: bed.x, y: bed.y, z: bed.z }; source = 'bed' }
  else if (resumeAt) { anchor = { x: resumeAt.x, y: resumeAt.y, z: resumeAt.z }; source = 'resume' }
  if (!anchor || !pos) return { anchor, source, dist: null, far: false }
  const d = Math.hypot(anchor.x - pos.x, anchor.z - pos.z)
  return { anchor, source, dist: d, far: d > D }
}

// GO-HOME-FIRST recovery, survival tier (outranks gear-up/gather): if we respawned FAR from
// home, trek back BEFORE resuming any local work, then rebuild the bed + re-assert the spawn
// so future deaths return HOME instead of world spawn - closing the "abandon base at world
// spawn" loop. Bounded (maxLegs) + honest: an unreachable home fails loudly and the caller
// retries on the next respawn rather than wedging forever. Food/threat survival still applies
// en route (auto-eat + nav's water/pit/climb recovery run through walkStaged). Distinct from
// recoverSpawnAnchor (which is gated on the spawn-suspect flag AND no build to resume): this
// fires purely on DISTANCE, considers the build site as a fallback anchor, and explicitly
// rebuilds the bed. RECOVER_HOME=0 disables it at the caller.
async function recoverHome (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  if (!bot.entity) return { far: false }
  const decision = homeRecoveryDecision({
    hut: hutAnchor(), bed: knownBed(), resumeAt: opts.resumeAt,
    pos: bot.entity.position, dist: opts.dist
  })
  if (!decision.far) { dbg('recoverHome: ' + (decision.anchor ? 'within ' + Math.round(decision.dist) + 'b of the ' + decision.source + ' - already home, nothing to do' : 'no home anchor remembered - nothing to trek to')); return { ...decision, arrived: false } }
  const { anchor } = decision
  // The exact line a live watcher greps for.
  say(`landed ${Math.round(decision.dist)} blocks from home - trekking back before anything else`)
  dbg('recoverHome: ' + Math.round(decision.dist) + 'b from the ' + decision.source + ' at ' + anchor.x + ',' + anchor.z + ' - going home before gear-up/gather')
  const distNow = () => Math.hypot(anchor.x - bot.entity.position.x, anchor.z - bot.entity.position.z)
  const arrive = opts.arrive != null ? opts.arrive : 8
  const maxLegs = opts.maxLegs != null ? opts.maxLegs : 12 // bounded so an unreachable home can't wedge us here forever
  // FOOD SURVIVAL EN ROUTE: on a far respawn the pack is EMPTY - respawn only refills the food
  // BAR to 20, which then drains over a long trek (this is exactly what starved the bot to death
  // mid-carousel). Before each leg, if we're getting hungry with nothing to eat, HOLD the trek
  // and secure food (hunt a nearby animal - raw is fine, auto-eat then eats it) rather than push
  // blindly to food 0. Bounded (one animal, ~12s); if the field is empty we press on but at least
  // tried. FOOD_HOLD is generous (<=10) because the remaining trek only burns more.
  const foodHold = Number(process.env.RECOVER_HOME_FOOD_HOLD || 10)
  for (let leg = 0; leg < maxLegs && distNow() > arrive && !isStopped(); leg++) {
    if (bot.food != null && bot.food <= foodHold && !hasFood(bot)) {
      dbg('recoverHome: hungry en route (food ' + bot.food + ', empty pack) - securing food before pushing on')
      try { const got = await huntForFood(bot, { isStopped }); if (got) { await eatUp(bot).catch(() => {}) ; dbg('recoverHome: hunted + ate en route (food now ' + bot.food + ')') } else dbg('recoverHome: no food animal near the route - pressing on carefully') } catch (e) { dbg('recoverHome: en-route food secure failed (' + e.message + ')') }
    }
    const before = distNow()
    try { await walkStaged(bot, anchor.x, anchor.z, { isStopped, range: arrive, timeoutMs: 300000 }) } catch (e) { dbg('recoverHome: trek leg ' + leg + ' failed (' + e.message + ')') }
    if (before - distNow() < 4 && distNow() > arrive) dbg('recoverHome: leg ' + leg + ' made no headway (still ' + Math.round(distNow()) + 'b out)')
  }
  const arrived = distNow() <= Math.max(arrive, 16)
  if (!arrived) { dbg('recoverHome: still ' + Math.round(distNow()) + 'b out after ' + maxLegs + ' legs - giving up honestly, will retry on the next respawn'); return { ...decision, arrived: false } }
  // Home: rebuild the bed if a creeper took it, then FORCE-re-assert the spawn so the NEXT
  // death lands here, not at world spawn. ensureSpawnBed also rebuilds via ensureHutBed, but
  // call ensureHutBed first so the bed physically exists before we try to sleep-anchor on it.
  let bedOk = false
  try {
    const hut = hutAnchor()
    if (hut) await ensureHutBed(bot, new Vec3(hut.x, hut.y, hut.z), { isStopped, say }).catch(() => 'fail')
    bedOk = await ensureSpawnBed(bot, { isStopped, say, force: true, maxTrek: 1e9 }).catch(() => false)
  } catch (e) { dbg('recoverHome: bed re-assert failed (' + e.message + ')') }
  dbg('recoverHome: home - spawn ' + (bedOk ? 're-asserted at the bed (future deaths return here)' : 'could NOT be re-asserted (no usable bed - will retry next respawn)'))
  return { ...decision, arrived: true, bedOk }
}

// Sleep in the remembered bed if we're standing near it. Returns true only if we actually
// slept through to daylight (or the night got skipped) - anything else falls back to the pit.
async function sleepInBedHere (bot, { say = () => {}, isStopped = () => false } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const bedIds = Object.values(mcData.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
  const bed = bot.findBlock({ matching: bedIds, maxDistance: 8 })
  if (!bed) {
    // Only forget the bed when we're actually STANDING at the remembered spot and it's
    // gone - a trek that fell short (death, blocked path) used to wipe the memory
    // permanently, and the bot pit-slept for hours with a perfectly good bed 76 blocks
    // away (live, 18:01). Fell-short = keep the memory, pit tonight, try again tomorrow.
    const kb = knownBed()
    const there = kb && Math.hypot(kb.x - bot.entity.position.x, kb.z - bot.entity.position.z) <= 4
    if (there) { dbg('nightRest: bed is GONE from ' + kb.x + ',' + kb.y + ',' + kb.z + ' - forgetting it'); forgetBed() }
    else { dbg('nightRest: fell short of the bed - keeping the memory, pitting tonight'); if (kb) markBedUnusable(kb, shelterSite.BED_HOLD_FELLSHORT_MS, 'fell short of the bed') }
    return false
  }
  // SLEEP-VIABILITY GATE (the "sleep failed (it's not night and it's not a thunderstorm)"
  // spam, live 07-13): bot.sleep only works from timeOfDay ~12542 (or in a thunderstorm),
  // but the shelter reflex fires at the 12200 dusk head-start - so every attempt in that
  // window failed LOUDLY on the reflex's 5s cadence, night after night. Wait QUIETLY at
  // the bed for the sleepable window instead of hammering the server; and plain daytime
  // rain (no thunder) can never become sleepable soon - bail once, silently.
  const canSleepNow = () => ((bot.thunderState || 0) > 0) || (bot.time && bot.time.timeOfDay >= 12542 && bot.time.timeOfDay <= 23458)
  if (!canSleepNow()) {
    const tod = bot.time ? bot.time.timeOfDay : -1
    if (tod >= 11800 && tod < 12542) {
      dbg('nightRest: at the bed ahead of sleep-time (timeOfDay ' + tod + ') - waiting quietly for nightfall')
      if (bot.entity.position.distanceTo(bed.position) > 2.5) { try { await gotoWithTimeout(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 20000) } catch {} }
      const dl = Date.now() + 90000
      while (!canSleepNow() && Date.now() < dl && !isStopped()) {
        if (nearHostile(bot, 10) && underArmored(bot)) { dbg('nightRest: hostiles closing during the dusk wait - pitting instead'); return false }
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    if (!canSleepNow()) { dbg('nightRest: bed here but sleep is impossible right now (timeOfDay ' + (bot.time ? bot.time.timeOfDay : '?') + ', no thunder) - not hammering it'); return false }
  }
  // MOB-BLOCKS-SLEEP PRE-GATE (fix #14): vanilla's monster box is +-8 around the bed head
  // (bed.js) and would refuse anyway - but today a wedge's 'cant click the bed' fires FIRST
  // and masks the monster error entirely, so the /monster/ retry never runs and we loop. A
  // naked bot with a hostile in the wake-radius can't sleep here: hold the bed briefly and pit.
  if (nearHostile(bot, 8) && underArmored(bot)) {
    dbg('nightRest: hostile in the bed wake-radius while under-armored - pitting instead of clicking the bed')
    markBedUnusable(bed.position, shelterSite.BED_HOLD_MONSTER_MS, 'hostile in the wake-radius')
    return false
  }
  for (let tries = 0; tries < 3 && !isStopped(); tries++) {
    try {
      if (bot.entity.position.distanceTo(bed.position) > 2.5) { try { await gotoWithTimeout(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 20000) } catch {} }
      await bot.sleep(bed)
      rememberBed(bed.position) // sleeping re-arms the spawn - keep the memory fresh
      say('sleeping till morning')
      dbg('nightRest: asleep in bed at ' + bed.position.toString())
      while (bot.isSleeping && isNight(bot) && !isStopped()) { await new Promise(r => setTimeout(r, 2000)) }
      if (!isNight(bot)) { try { await bot.wake() } catch {} ; dbg('nightRest: morning - up and about'); return true }
      dbg('nightRest: woken early (still night) - falling back to shelter')
      return false // kicked out of bed (attacked / player woke us)
    } catch (e) {
      dbg('nightRest: sleep failed (' + e.message + ')')
      const kind = shelterSite.sleepFailKind(e.message) // fix #14: classify so an unusable bed is held, not re-tried forever
      if (kind === 'monsters') {
        // hostiles CLOSE while we're under-armored: don't stand at the bed taking hits
        // for 3 retries (verified on test server: hp 20 -> 17 doing exactly that) - seal
        // a pit right here and let the day burn them off.
        if (nearHostile(bot, 10) && underArmored(bot)) { dbg('nightRest: hostiles at the bed - pitting NOW instead of waiting'); markBedUnusable(bed.position, shelterSite.BED_HOLD_MONSTER_MS, e.message); return false }
        await new Promise(r => setTimeout(r, 6000)); continue // borderline-range mobs may wander off
      }
      if (kind === 'unusable') markBedUnusable(bed.position, shelterSite.BED_HOLD_MS, e.message)
      return false // 'transient' keeps today's bare bail (no mark)
    }
  }
  return false
}

// Night survival, in a player's order of preference: WALK HOME AND SLEEP if the bed is in
// range, else seal a pit where we stand. Every digInForNight call site goes through this.
// _resting covers the WHOLE span (bed trek + sleep + pit): the brain's goto/attack commands
// were yanking the pathfinder out from under the shelter dig mid-carousel (test server:
// 14 deaths in 6 min with the brain fighting the body for control). index.js holds brain
// commands while isResting(), same as the build busy-guard.
let _resting = false
function isResting () { return _resting || _sheltering }
async function nightRest (bot, opts = {}) {
  _resting = true
  try { return await nightRestInner(bot, opts) } finally { _resting = false }
}
async function nightRestInner (bot, opts = {}) {
  const say = opts.say || (() => {})
  const isStopped = opts.isStopped || (() => false)
  // dusk catches the bot swimming often enough (rivers everywhere) - get to land BEFORE
  // deciding bed-vs-pit, or the pit path dig-fails in a loop while it drowns
  await ensureAshore(bot, isStopped)
  const bed = knownBed()
  // THE CHOKE POINT (fix #14): a bed on an unusable-hold falls straight to the pit with ZERO
  // bed prefix (no ~40s doomed 2x20s goto) - de-looping EVERY nightRest caller without touching
  // a signature. Within the hold window the bed attempt provably can't succeed (position-
  // deterministic reach), so skipping it loses nothing; the bed is never forgotten (retried on
  // hold expiry / next night).
  // BED_HELD_OVERRIDE (default on): the unusable-hold is a reach-failure guard measured from a
  // FARTHER position. If the bot is now RIGHT NEXT to the bed (<=4b, clickable), that stale hold no
  // longer applies - use the bed instead of digging a hole beside it (the live "bed 3 blocks away,
  // on a 2s hold -> pitting instead" dumbness). sleepInBedHere still bails/pits on a real monster or
  // sleep-timing block, so this only recovers the reachable-bed case. =0 -> today's byte-for-byte.
  const bedClickable = bed && bot.entity && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 4
  const bedOk = bed && bot.entity && !_sheltering && (!bedHeld(bed) || (process.env.BED_HELD_OVERRIDE !== '0' && bedClickable))
  if (bedOk) {
    const d = Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z)
    if (d <= (opts.bedRange || 200)) {
      dbg('nightRest: bed remembered at ' + bed.x + ',' + bed.y + ',' + bed.z + ' (' + Math.round(d) + ' blocks) - heading there')
      if (d > 4) {
        say('night time - heading home to sleep')
        if (!await walkStaged(bot, bed.x, bed.z, { isStopped, range: 6, timeoutMs: 150000 })) dbg('nightRest: staged trek to bed fell short')
        try { await gotoWithTimeout(bot, new goals.GoalNear(bed.x, bed.y, bed.z, 2), 20000) } catch (e) { dbg('nightRest: final approach to bed failed (' + e.message + ')') }
      }
      if (isStopped()) return false
      if (Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 8) {
        if (await sleepInBedHere(bot, { say, isStopped })) return true
      } else { dbg('nightRest: never reached the bed - pitting where i stand'); markBedUnusable(bed, shelterSite.BED_HOLD_FELLSHORT_MS, 'never reached the bed') }
    } else dbg('nightRest: bed too far (' + Math.round(d) + ' > ' + (opts.bedRange || 200) + ') - pitting here')
  } else if (bed && bedHeld(bed)) {
    dbg('nightRest: bed at ' + bed.x + ',' + bed.y + ',' + bed.z + ' is on an unusable-hold (' + Math.max(0, Math.round((_bedHold.until - Date.now()) / 1000)) + 's left) - pitting instead')
  }
  return digInForNight(bot, opts)
}

// ---- WHEAT FARM (operator order: "make the wheat farm now so it stops starving").
// The Sonnet shepherd proved the region can run dry of animals - the bot worked at 1hp
// until death with no food fallback. Same pattern as the orchard: renewable supply at
// the camp. Water-edge plot, tilled with a crafted hoe, seeded from grass, bone-mealed
// when bones allow, harvested into bread.
async function boneMealBlock (bot, pos, times) {
  const mcData = require('minecraft-data')(bot.version)
  for (let u = 0; u < times; u++) {
    let meal = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone_meal')
    if (!meal) {
      const bone = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone')
      if (!bone) return
      try { const r = bot.recipesFor(mcData.itemsByName.bone_meal.id, null, 1, null)[0]; if (!r) return; await bot.craft(r, 1, null); meal = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'bone_meal') } catch { return }
      if (!meal) return
    }
    const b = bot.blockAt(pos)
    if (!b || (b.getProperties && (b.getProperties().age ?? 0) >= 7)) return
    try { await bot.equip(meal, 'hand'); await bot.activateBlock(b); await new Promise(r => setTimeout(r, 300)) } catch { return }
  }
}

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
async function tillCell (bot, cell) {
  const cropPos = cell.position.offset(0, 1, 0)
  let base = bot.blockAt(cell.position)
  if (base && farm.farmlandReady(base.name)) return 'farmland'
  if (!base || !farm.tillableBank(base.name)) return 'unfarmable'
  // Ensure the crop cell above is air, or the hoe silently no-ops.
  let above = bot.blockAt(cropPos)
  if (above && !AIRISH(above.name)) {
    if (/water|bubble_column|kelp|seagrass/.test(above.name)) {
      // Displace the water: drop a carried block into the cell, then break it. A lone source
      // is consumed (cell -> air); water still fed by a neighbour source reflows and we skip.
      const filler = (bot.inventory ? bot.inventory.items() : []).find(i => /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|netherrack|gravel)$/.test(i.name))
      if (filler) {
        try {
          if (await placeAt(bot, cropPos, new RegExp('^' + filler.name + '$'))) {
            const plug = bot.blockAt(cropPos)
            if (plug && plug.boundingBox === 'block') await bot.dig(plug)
          }
        } catch {}
      }
    } else if (REPLACEABLE.test(above.name)) {
      try { await bot.dig(above) } catch {}
    }
    await new Promise(r => setTimeout(r, 350)) // let any flow settle before re-reading
    above = bot.blockAt(cropPos)
    if (above && !AIRISH(above.name)) { dbg('  till: crop cell above ' + cropPos.toString() + " won't clear (" + above.name + ') - skipping (flood-prone)'); return 'flooded' }
  }
  const hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
  if (!hoe) return 'nohoe'
  await bot.equip(hoe, 'hand')
  base = bot.blockAt(cell.position) // re-read (position stable; name may have swapped)
  try { await bot.activateBlock(base) } catch (e) { dbg('  till: activateBlock threw (' + e.message + ')') }
  await new Promise(r => setTimeout(r, 200))
  const tilled = bot.blockAt(cell.position)
  return (tilled && farm.farmlandReady(tilled.name)) ? 'farmland' : false
}

const WHEAT_FARM_TARGET = Number(process.env.WHEAT_FARM_TARGET || (process.env.FARM_EXPAND !== '0' ? 33 : 20)) // §4.8: 33 (~11 bread/cycle, breaks the food death-spiral) when FARM_EXPAND on; 20 off. >=20 crop cells: 12 barely covered 0->full (10 wheat ~3 bread ~15 hunger); 20 -> ~6 bread -> 0->full + surplus/buffer (was 12/6)

// SEED GATHERING (extracted from ensureWheatFarm step 3, §5.4): break tall grass/ferns for
// wheat_seeds up to `want`, roaming a few compass legs if the immediate area is barren. Same
// grassIds / roam legs / budgets as before (behavior identical when want=3). Now also reusable
// by the tend path so a seed-starved plot self-fills. Returns the seed count on hand.
async function gatherSeedsNear (bot, want, { isStopped = () => false } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const seedCount = () => countItem(bot, 'wheat_seeds')
  if (seedCount() >= want) return seedCount()
  const grassIds = ['short_grass', 'tall_grass', 'grass', 'fern', 'large_fern'].map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(x => x != null)
  let broken = 0; let legs = 0
  const searchGrass = () => bot.findBlock({ matching: grassIds, maxDistance: 48 })
  while (seedCount() < want && broken < 60 && !isStopped()) {
    let g = searchGrass()
    if (!g && legs < 4) { // barren here - roam a compass leg toward likely meadow, then re-search
      legs++
      const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][legs % 4]
      const tx = Math.round(bot.entity.position.x + dir[0] * 32); const tz = Math.round(bot.entity.position.z + dir[1] * 32)
      dbg('  seeds: no grass in 48 - roaming a leg to ' + tx + ',' + tz + ' to find grass for seeds')
      try { await walkStaged(bot, tx, tz, { isStopped, range: 6, timeoutMs: 40000 }) } catch {}
      g = searchGrass()
    }
    if (!g) break
    try {
      if (bot.entity.position.distanceTo(g.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(g.position.x, g.position.y, g.position.z, 2), 10000)
      await bot.dig(g); broken++
    } catch { break }
    if (broken % 6 === 0) await collectDrops(bot, 6)
  }
  await collectDrops(bot, 8)
  dbg('  seeds: broke ' + broken + ' grass -> ' + seedCount() + ' seeds')
  return seedCount()
}

async function ensureWheatFarm (bot, home, { isStopped = () => false, say = () => {}, avoid = null } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const m = loadWorldMem()
  // FARM_EXPAND (river farm expansion): bank-following growth, flat-site selection, honest maxed,
  // 33-cell target. All EXPAND-gated; FARM_EXPAND=0 = today byte-for-byte (8 cols, 32-merge around
  // w, old maxed expr, target 20, no survey/memory-meta/crossing-note/re-site). See DESIGN-river-
  // farm-expansion.md.
  const EXPAND = process.env.FARM_EXPAND !== '0'
  const SITE_RADIUS = Number(process.env.FARM_SITE_RADIUS || (EXPAND ? 40 : 32))
  const WATER_COLS = Number(process.env.FARM_WATER_COLS || (EXPAND ? 32 : 8))
  const DIST_WEIGHT = Number(process.env.FARM_DIST_WEIGHT || 0.75)
  const MIN_TILLABLE = Number(process.env.FARM_MIN_TILLABLE || 6)
  const NEAR_HOME = Number(process.env.FARM_NEAR_HOME || 112)
  const RESITE = EXPAND && process.env.FARM_RESITE !== '0'
  const RESITE_SLACK = Number(process.env.FARM_RESITE_SLACK || 16)
  const RESITE_MARGIN = Number(process.env.FARM_RESITE_MARGIN || 8)
  const RESITE_COOLDOWN_MS = Number(process.env.FARM_RESITE_COOLDOWN_MS || 6 * 3600 * 1000)
  // one farm per site - but only once it's BIG ENOUGH. A stale/pre-schema record with 0 cells
  // (live: a farm record at 382,38 with cells:[]) used to block re-planting forever while tend
  // had nothing to tend - a dead-farm deadlock. 0 live cells = no farm, rebuild. AND a 1-cell
  // farm (live: a pond that offered only 1 bank cell) yields 1 wheat/cycle - never the 3 needed
  // for bread. So DON'T early-return at 1 cell: keep coming back to EXPAND until we hit the
  // target (>=6 cells -> >=3 wheat -> bread), or until the site can't grow any further (`maxed`).
  const existingLen = (m.wheatFarm && m.wheatFarm.cells && m.wheatFarm.cells.length) || 0
  const nearExisting = m.wheatFarm && Math.hypot(m.wheatFarm.x - home.x, m.wheatFarm.z - home.z) <= 80
  // §4.6 re-site eligibility: a maxed + demonstrably-tiny farm may relocate ONCE per cooldown.
  // When eligible we SKIP the early-return so the pass can survey a better bank (the ONLY new code
  // reachable while `maxed` is latched); the actual move still needs shouldResite to pass below.
  const tinyMaxed = !!(m.wheatFarm && m.wheatFarm.maxed && existingLen > 0 && existingLen < Math.ceil(WHEAT_FARM_TARGET / 2))
  const resiteEligible = RESITE && nearExisting && tinyMaxed && (Date.now() - (m.farmResiteAt || 0) > RESITE_COOLDOWN_MS)
  if (nearExisting && (existingLen >= WHEAT_FARM_TARGET || (existingLen > 0 && m.wheatFarm.maxed)) && !resiteEligible) return true
  // BAD MOMENT guard: the last attempt ran while being chased INTO A CAVE - it searched
  // for grass from underground and found none. Farming is a peacetime surface job.
  // FIX #39: farming is a peacetime SURFACE job - defer if we're truly caved-in, hunted, or it's
  // night. Fix A (FARM_CAVE_STRICT): a LEAF CANOPY is not a cave roof. hasSolidCeiling counts any
  // 'block'-bounding-box block above, so tree leaves / an overhang within 12b read as a ceiling and
  // farming was skipped in broad daylight (verified: isDay + no threat still deferred). ignoreLeaves
  // makes the ceiling check require a real opaque (non-leaf) block. FARM_CAVE_STRICT=0 = legacy.
  // Fix B: split the lumped message so the log names WHICH condition fired (this vagueness
  // misdiagnosed the defer twice) - pure observability, always on.
  const ceilStrict = process.env.FARM_CAVE_STRICT !== '0'
  const ceiling = hasSolidCeiling(bot, 12, { ignoreLeaves: ceilStrict })
  const hostile = nearHostile(bot, 16)
  const night = isNight(bot)
  if (ceiling || hostile || night) {
    const why = ceiling ? 'solid ceiling <=12b (real cave roof)' : hostile ? 'hostile within 16b' : 'night'
    dbg('  wheat farm: bad moment - ' + why + ' - deferred')
    return false
  }
  // 1) surface water within reach of home - farmland must sit beside it
  const waterId = mcData.blocksByName.water.id
  // SURFACE water only: cave/ravine pools pass the air-above test but have stone banks
  // and no light for crops - "0 bank cells" at two remembered underground pools, live.
  const seesSky = p => {
    for (let dy = 1; dy <= 40; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false
    }
    return true
  }
  const findWaters = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 }) || [])
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
    .filter(p => !inAvoidBox(avoid, p.x, p.z))
    .filter(seesSky)
  let waters = findWaters()
  if (!waters.length) {
    // No pond in sight - but maybe we REMEMBER one. The camp runs this from the site,
    // where the nearest pond sits beyond 48 blocks: every camp farm attempt deferred
    // forever while the bot starved (live, all morning). Ponds seen during any earlier
    // attempt are in the infra registry - trek back to one.
    const known = recallInfra('water', bot.entity.position, 250) // the discovered pond can be >120 out (sweep ring 96/144)
    if (known && !isStopped()) {
      dbg('  wheat farm: no water in sight - walking to remembered pond at ' + known.x + ',' + known.z)
      try { await walkStaged(bot, known.x, known.z, { isStopped, range: 6, timeoutMs: 150000 }) } catch {}
      waters = findWaters()
      // ONLY forget the remembered pond if we actually ARRIVED near it and it's genuinely
      // gone - a trek that fell short (blocked path) must NOT erase a good remembered pond
      // (that's how the bot lost its one water and could never farm again).
      if (!waters.length && Math.hypot(bot.entity.position.x - known.x, bot.entity.position.z - known.z) <= 8) {
        dbg('  wheat farm: arrived at remembered pond ' + known.x + ',' + known.z + ' but no open-sky water there anymore - forgetting it')
        forgetInfra('water', listInfra('water').find(e => e.x === known.x && e.z === known.z))
      } else if (!waters.length) dbg('  wheat farm: could not reach remembered pond ' + known.x + ',' + known.z + ' (trek fell short) - keeping it for next time')
    }
  }
  if (!waters.length) { dbg('  wheat farm: no surface water within 48 - deferred'); return false }
  const w = waters[0]
  rememberInfra('water', { x: w.x, y: w.y, z: w.z }) // future camp passes trek straight back
  // ---- FARM_EXPAND site selection + anchor pinning (§4.1/4.2/4.4/4.6) -----------------
  const homeXZ = hutAnchor() || home
  // scanBank(siteVec): the ring build's OWN predicate as a reusable closure - the exact bands,
  // BANK_DYS, base regex, REPLACEABLE-above test and cross-band dedup as the legacy loop. Returns
  // { block, x, z, band, flat } candidates. The survey uses it to PREDICT a site (no new block
  // semantics); the plant loop uses it to build the actual ring. flag OFF: cols = waters.slice(0,8)
  // with no radius filter -> byte-identical ring.
  const scanBank = (siteVec) => {
    const out = []; const seen = new Set()
    const cols = (EXPAND ? waters.filter(wp => Math.hypot(wp.x - siteVec.x, wp.z - siteVec.z) <= SITE_RADIUS) : waters).slice(0, WATER_COLS)
    for (const r of [1, 2]) {
      const offs = []
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { if (Math.max(Math.abs(dx), Math.abs(dz)) === r) offs.push([dx, dz]) }
      for (const wp of cols) {
        for (const [dx, dz] of offs) {
          const k = (wp.x + dx) + ',' + (wp.z + dz)
          if (seen.has(k) || inAvoidBox(avoid, wp.x + dx, wp.z + dz)) continue
          seen.add(k)
          for (const dy of farm.BANK_DYS) {
            const gp = wp.offset(dx, dy, dz)
            const g = bot.blockAt(gp); const above = bot.blockAt(gp.offset(0, 1, 0))
            if (g && /^(grass_block|dirt|sand|red_sand|gravel|clay)$/.test(g.name) && above && REPLACEABLE.test(above.name)) { out.push({ block: g, x: wp.x + dx, z: wp.z + dz, band: r, flat: dy === 0 }); break }
          }
        }
      }
    }
    return out
  }
  // surveyAt(col): count tillable / flatFrac / distHome for a candidate anchor (cheap block reads).
  const surveyAt = (col) => {
    const cs = scanBank(new Vec3(col.x, col.y, col.z))
    const tillable = cs.length
    const flatFrac = tillable ? cs.filter(c => c.flat).length / tillable : 0
    const distHome = homeXZ ? Math.hypot(col.x - homeXZ.x, col.z - homeXZ.z) : 0
    return { tillable, flatFrac, distHome }
  }
  // pickBestSite(exclude): score up to 4 near-home candidate columns (nearest first, spaced >=16
  // apart) and return { col, score, dist } of the highest ACCEPTABLE one, else null. Remembers the
  // survey meta on each (§4.5.1). `exclude` (the current site on a re-site) is skipped.
  const pickBestSite = (exclude) => {
    const byHome = waters.slice().sort((a, b) => (homeXZ ? Math.hypot(a.x - homeXZ.x, a.z - homeXZ.z) - Math.hypot(b.x - homeXZ.x, b.z - homeXZ.z) : 0))
    const picks = []
    for (const c of byHome) {
      if (homeXZ && Math.hypot(c.x - homeXZ.x, c.z - homeXZ.z) > NEAR_HOME) continue
      if (exclude && Math.hypot(c.x - exclude.x, c.z - exclude.z) <= SITE_RADIUS) continue
      if (picks.some(p => Math.hypot(p.x - c.x, p.z - c.z) < 16)) continue
      picks.push(c); if (picks.length >= 4) break
    }
    let best = null
    for (const c of picks) {
      const sv = surveyAt(c)
      const sc = farm.scoreFarmSite({ tillable: sv.tillable, flatFrac: sv.flatFrac, distHome: sv.distHome, target: WHEAT_FARM_TARGET }, { distWeight: DIST_WEIGHT, minTillable: MIN_TILLABLE })
      rememberInfra('water', { x: c.x, y: c.y, z: c.z }, { tillable: sv.tillable, flat: sv.flatFrac, surveyedAt: Date.now() })
      if (sc.acceptable && (!best || sc.score > best.score)) best = { col: c, score: sc.score, dist: sv.distHome }
    }
    return best
  }
  // §4.1 pin the anchor: an existing farm within SITE_RADIUS keeps its anchor FOREVER (no drift,
  // no per-pass re-scoring, no dropped cells). Fresh siting (or post-re-site) scores a flat bank.
  let priorFarm = (EXPAND && m.wheatFarm && m.wheatFarm.cells && m.wheatFarm.cells.length &&
                   Math.hypot(m.wheatFarm.x - w.x, m.wheatFarm.z - w.z) <= SITE_RADIUS) ? m.wheatFarm : null
  let resiting = false
  let resiteSite = null
  // A maxed farm only reaches here via resiteEligible (else the early-return fired). If we can't
  // pin it as priorFarm (the bot is standing at a DIFFERENT water than the record), we must NOT
  // clobber it with a competing fresh farm - re-site is only evaluable from the farm's own site.
  if (resiteEligible && !priorFarm) return true
  // §4.6 re-site: a maxed + tiny farm relocates to a clearly-better, no-farther bank (once/cooldown).
  if (resiteEligible && priorFarm) {
    const curDist = homeXZ ? Math.hypot(m.wheatFarm.x - homeXZ.x, m.wheatFarm.z - homeXZ.z) : 0
    const curSv = surveyAt({ x: m.wheatFarm.x, y: m.wheatFarm.y, z: m.wheatFarm.z })
    const curScore = farm.scoreFarmSite({ tillable: curSv.tillable, flatFrac: curSv.flatFrac, distHome: curSv.distHome, target: WHEAT_FARM_TARGET }, { distWeight: DIST_WEIGHT, minTillable: MIN_TILLABLE }).score
    const best = pickBestSite({ x: m.wheatFarm.x, z: m.wheatFarm.z })
    if (best && farm.shouldResite({ curCells: existingLen, curMaxed: true, curScore, curDist, bestScore: best.score, bestDist: best.dist, target: WHEAT_FARM_TARGET }, { margin: RESITE_MARGIN, nearHome: NEAR_HOME, slack: RESITE_SLACK, minCellsFrac: 0.5 })) {
      dbg('  wheat farm: RE-SITE ' + m.wheatFarm.x + ',' + m.wheatFarm.z + ' (' + existingLen + ' cells, score ' + curScore.toFixed(1) + ' @' + curDist.toFixed(0) + 'b) -> ' + best.col.x + ',' + best.col.z + ' (score ' + best.score.toFixed(1) + ' @' + best.dist.toFixed(0) + 'b)')
      m.wheatFarmOld = Object.assign({}, m.wheatFarm, { retiredAt: Date.now() })
      m.farmResiteAt = Date.now()
      delete m.wheatFarm
      saveWorldMem()
      resiting = true; priorFarm = null
      resiteSite = new Vec3(best.col.x, best.col.y, best.col.z)
      w.x = best.col.x; w.y = best.col.y; w.z = best.col.z // seed-gather + logs point at the new bank
    } else {
      m.farmResiteAt = Date.now() // cooldown consumed even on a failed attempt (no thrash)
      saveWorldMem()
      dbg('  wheat farm: re-site declined (no clearly-better near-home bank) - keeping the ' + existingLen + '-cell farm')
      return true
    }
  }
  const site = !EXPAND ? new Vec3(w.x, w.y, w.z)
    : resiteSite ? resiteSite
    : priorFarm ? new Vec3(priorFarm.x, priorFarm.y, priorFarm.z)
    : (() => { const b = pickBestSite(null); return b ? new Vec3(b.col.x, b.col.y, b.col.z) : new Vec3(w.x, w.y, w.z) })()
  // 2) a hoe (wooden: 2 planks + 2 sticks). ACQUIRE IT VIA THE RESOURCE MODEL, never a bare
  // runCraft: runCraft crafts only from what's ON HAND and THROWS "cannot craft" when
  // planks/sticks aren't already held - the exact live blocker ("no hoe and cannot craft one")
  // even though the bot had logs. reconcile withdraws banked planks/sticks/hoe if any, else
  // plans wooden_hoe <- (planks + sticks) <- planks <- logs and GATHERS wood if short; a bot
  // that can reach one log can make a hoe. runReconciled executes withdraw+gather+craft.
  let hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
  if (!hoe) {
    try {
      const res = require('./resources.js') // lazy (resources requires provision at load)
      // maxAgeMs:0 forces a REAL chest open before concluding wood must be gathered: operator-
      // added / freshly-banked wood inside the 180s cache window otherwise reads stale-empty and
      // the bot treks for wood it already owns (withdraw > gather). Mirrors ensureFood's forceFresh.
      const rec = await res.reconcile(bot, { wooden_hoe: 1 }, { near: home, maxAgeMs: 0, planOpts: { primaryWood: detectWood(bot) || 'oak' } })
      dbg('  wheat farm: acquiring a wooden hoe (' + (rec.plan.tasks.map(t => `${t.type}:${t.item || t.output}`).join(' > ') || (rec.withdraws.length ? 'from bank' : 'from hand')) + ')')
      if (rec.withdraws.length || rec.plan.tasks.length) await res.runReconciled(bot, rec, { isStopped, say, home })
    } catch (e) { dbg('  wheat farm: hoe acquisition failed (' + e.message + ')') }
    hoe = (bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))
    if (!hoe) { dbg('  wheat farm: still no hoe (no reachable wood/planks/sticks or no table) - deferred'); return false }
    dbg('  wheat farm: got a ' + hoe.name)
  }
  // 3) seeds - break tall grass/ferns to get wheat_seeds. ACQUIRE them (search WIDE + roam a
  // few compass legs if the pond bank is barren) rather than deferring - grass grows patchily
  // and the pond edge often has none, but a meadow is usually within a short walk.
  const seedCount = () => countItem(bot, 'wheat_seeds')
  // FARM_SEED_TOPUP: gather enough seeds for what THIS expansion pass can plant (up to the
  // 12-cell per-pass cap), so a 20-cell target actually accumulates seeds instead of planting 3
  // and deferring. FARM_SEED_TOPUP=0 restores the hardcoded-3 goal byte-for-byte.
  const seedWant = process.env.FARM_SEED_TOPUP === '0' ? 3 : Math.max(3, Math.min(12, WHEAT_FARM_TARGET - existingLen))
  if (seedCount() < seedWant) {
    try { await gotoWithTimeout(bot, new goals.GoalNear(w.x, w.y, w.z, 4), 60000) } catch {}
    await gatherSeedsNear(bot, seedWant, { isStopped })
    if (seedCount() < 1) { dbg('  wheat farm: no grass anywhere within reach - genuinely no seeds here, deferred'); return false }
  }
  // 4) till + plant the water's bank: same-y neighbours of the waterline
  say('setting up a wheat farm by the water - no more starving')
  let planted = 0
  // BANK BAND (§4.2): the ring build's exact predicate via scanBank - Chebyshev 1 then 2,
  // farm.BANK_DYS, base regex, REPLACEABLE-above, cross-band dedup. flag OFF -> byte-identical.
  // flag ON: candidates around the PINNED site (not the drifting waters[0]), spread along the
  // bank (WATER_COLS cols within SITE_RADIUS), minus owned + barren columns, ordered outward.
  const bankBarren = EXPAND ? Object.assign({}, (priorFarm && priorFarm.bankBarren) || {}) : null
  let cands = scanBank(site)
  if (EXPAND) {
    const ownedCols = new Set(((m.wheatFarm && m.wheatFarm.cells) || []).map(c => c.x + ',' + c.z))
    cands = cands.filter(c => !ownedCols.has(c.x + ',' + c.z) && (bankBarren[c.x + ',' + c.z] || 0) < 2) // skip owned + struck-out (§4.2)
    cands = farm.orderBankCandidates(cands, site) // grow contiguously outward (§4.2)
  }
  const ring = cands.map(c => c.block)
  // §4.2 barren memo: a till/plant failure on a never-planted column earns strikes so it stops
  // shadowing candidates 13+ forever. Capped at 128 keys (evict oldest by insertion order).
  const addStrike = (colKey, failKind) => {
    if (!EXPAND) return
    bankBarren[colKey] = farm.barrenStep(bankBarren[colKey] || 0, failKind).strikes
    const keys = Object.keys(bankBarren)
    if (keys.length > 128) delete bankBarren[keys[0]]
  }
  dbg('  wheat farm: ' + ring.length + ' bank cell(s) by the water at ' + w.x + ',' + w.z + (EXPAND ? ' (site ' + site.x + ',' + site.z + ')' : ''))
  const plantedCells = [] // EXACT crop-cell coords, persisted so tend reads the real cells
  let attempted = 0
  for (let cell of ring.slice(0, 12)) {
    if (isStopped() || seedCount() < 1) break
    attempted++
    const colKey = cell.position.x + ',' + cell.position.z
    try {
      if (bot.entity.position.distanceTo(cell.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(cell.position.x, cell.position.y, cell.position.z, 2), 12000)
      const veg = bot.blockAt(cell.position.offset(0, 1, 0))
      if (veg && !AIRISH(veg.name)) { try { await bot.dig(veg) } catch {} }
      if (/sand|gravel|clay/.test(cell.name)) { // UNTILLABLE-BANK SWAP: dig it, lay owned dirt, till that
        const dirtItem = (bot.inventory ? bot.inventory.items() : []).find(i => /^dirt$/.test(i.name))
        if (!dirtItem) continue
        try { await bot.dig(cell) } catch { continue }
        if (!await placeAt(bot, cell.position, /^dirt$/)) { dbg('  wheat farm: dirt swap failed at ' + cell.position.toString()); continue }
        const swapped = bot.blockAt(cell.position)
        if (!swapped || !/^(dirt|grass_block)$/.test(swapped.name)) continue
        cell = swapped
      }
      // TILL to farmland - tillCell guarantees the crop cell above is air first (a watered
      // crop cell makes the hoe a silent no-op: the live "till did not take (got dirt)" bug).
      const tr = await tillCell(bot, cell)
      if (tr === 'nohoe') { dbg('  wheat farm: hoe vanished mid-pass - aborting (no strike)'); break } // transient, not a barren column (§4.2)
      if (tr !== 'farmland') { addStrike(colKey, (tr === 'flooded' || tr === 'unfarmable') ? tr : 'other'); dbg('  wheat farm: till did not take at ' + cell.position.toString() + ' (' + tr + ', got ' + ((bot.blockAt(cell.position) || {}).name || '?') + ')'); continue }
      const tilled = bot.blockAt(cell.position)
      const seeds = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'wheat_seeds')
      if (!seeds) break
      await bot.equip(seeds, 'hand')
      const cropPos = cell.position.offset(0, 1, 0)
      try { await bot.placeBlock(tilled, new Vec3(0, 1, 0)) } catch (e) { dbg('  wheat farm: seed place threw (' + e.message + ')') }
      await new Promise(r => setTimeout(r, 200))
      // BLOCK-READ the plant: the OLD bug counted placeBlock() calls, so a silently-failed or
      // instantly-flooded seed still logged "PLANTED" and persisted a phantom farm with 0 wheat
      // (live: 2.5h of `harvested 0`). Only a VERIFIED `wheat` block counts + gets persisted.
      const crop = bot.blockAt(cropPos)
      if (crop && crop.name === 'wheat') {
        planted++
        plantedCells.push({ x: cropPos.x, y: cropPos.y, z: cropPos.z })
        await boneMealBlock(bot, cropPos, 2)
      } else { addStrike(colKey, 'other'); dbg('  wheat farm: seed did NOT take at ' + cropPos.x + ',' + cropPos.y + ',' + cropPos.z + ' (got ' + ((crop && crop.name) || '?') + ') - not counting it') } // +1 strike (§4.2)
    } catch (e) { dbg('  wheat farm: cell failed (' + e.message + ')') }
  }
  const eligibleRemaining = Math.max(0, ring.length - attempted) // §4.3: candidates left untried this pass
  // MERGE with any cells already registered at THIS site (expansion pass) so we grow the plot
  // instead of clobbering it. §4.1: keep prior cells within SITE_RADIUS of the PINNED site anchor
  // (flag off: <=32 around w) - fixes the 2e clobber where a drifting waters[0] silently dropped
  // cells; union with the newly-verified cells, de-duped by coord.
  const priorSame = ((m.wheatFarm && m.wheatFarm.cells) || []).filter(c => Math.hypot(c.x - site.x, c.z - site.z) <= SITE_RADIUS)
  const byKey = new Map()
  for (const c of priorSame) byKey.set(c.x + ',' + c.y + ',' + c.z, { x: c.x, y: c.y, z: c.z })
  for (const c of plantedCells) byKey.set(c.x + ',' + c.y + ',' + c.z, c)
  const merged = [...byKey.values()]
  if (merged.length) {
    // Persist the EXACT crop cells (block-verified above) alongside the PINNED site anchor, so
    // tendWheatFarm reads THESE cells (harvest/replant) instead of blind-scanning for wheat.
    // §4.3 honest maxed: latch only when a pass planted NOTHING and no eligible candidate remains.
    const maxed = farm.expansionMaxed({ expand: EXPAND, planted, eligibleRemaining, cells: merged.length, target: WHEAT_FARM_TARGET })
    m.wheatFarm = { x: site.x, y: site.y, z: site.z, cells: merged, at: Date.now(), maxed }
    if (EXPAND) m.wheatFarm.bankBarren = bankBarren // §4.2 persist the barren-column memo
    saveWorldMem()
    dbg('  wheat farm: ' + planted + ' new cell(s) planted, ' + merged.length + ' total VERIFIED cell(s) at ' + site.x + ',' + site.z + (maxed ? ' (site maxed - ' + eligibleRemaining + ' eligible left)' : ''))
    if (planted) say(`wheat farm ${priorSame.length ? 'expanded' : 'planted'} (${merged.length} cells) - bread incoming`)
  } else {
    // §4.6 restore-on-failure: a re-site that persisted 0 cells must never leave the bot farm-less.
    if (resiting && m.wheatFarmOld) { m.wheatFarm = m.wheatFarmOld; delete m.wheatFarmOld; saveWorldMem(); dbg('  wheat farm: re-site built 0 cells - restored the old ' + (m.wheatFarm.cells || []).length + '-cell farm (cooldown stays consumed)') }
    else dbg('  wheat farm: could not plant any cell (none verified as wheat)')
  }
  return merged.length > 0
}

// (Re)establish ONE crop cell: till the farmland if needed, then plant a seed - VERIFIED by
// a world re-read (returns true only if a `wheat` block actually stands after). This is the
// self-heal primitive tend uses to re-plant cells a creeper/trample/failed-plant emptied.
// `cropPos` = the crop cell (one above the farmland). Needs a seed; tills only if a hoe is on
// hand and the base is real dirt/grass (never water/air/stone).
async function replantCropCell (bot, cropPos, { isStopped = () => false } = {}) {
  const seeds = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'wheat_seeds')
  if (!seeds) return false
  const basePos = cropPos.offset(0, -1, 0)
  let base = bot.blockAt(basePos)
  if (!base) return false
  if (bot.entity.position.distanceTo(cropPos) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(cropPos.x, cropPos.y, cropPos.z, 2), 10000) } catch {} }
  // clear anything sitting IN the crop cell (loose veg) so the seed has room
  const occ = bot.blockAt(cropPos)
  if (occ && !AIRISH(occ.name) && REPLACEABLE.test(occ.name)) { try { await bot.dig(occ) } catch {} }
  if (!farm.farmlandReady(base.name)) {
    if (!farm.tillableBank(base.name)) { dbg('  wheat replant: base at ' + basePos.toString() + ' is ' + base.name + ' - cannot till here'); return false }
    if (!(bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))) { dbg('  wheat replant: cell needs tilling but no hoe on hand'); return false }
    // tillCell clears any water in the crop cell first (the silent-no-op till bug), then fires.
    const tr = await tillCell(bot, { position: basePos, name: base.name })
    if (tr !== 'farmland') { dbg('  wheat replant: till did not take at ' + basePos.toString() + ' (' + tr + ')'); return false }
    base = bot.blockAt(basePos)
    if (!base || !farm.farmlandReady(base.name)) return false
  }
  try { await bot.equip(seeds, 'hand'); await bot.placeBlock(base, new Vec3(0, 1, 0)) } catch (e) { dbg('  wheat replant: seed place failed (' + e.message + ')') }
  await new Promise(r => setTimeout(r, 150))
  const crop = bot.blockAt(cropPos)
  return !!(crop && crop.name === 'wheat')
}

// Visit the farm: harvest ripe wheat (age 7), replant harvested cells, RE-PLANT any cell the
// world says is empty/destroyed (creeper/trample/failed plant), bone-meal what's still growing,
// and craft bread (3 wheat each). Called when hungry + huntless AND proactively by the food
// supply pass. GROUNDED: reads the EXACT persisted crop cells and block-reads each - the old
// blind `findBlocks(wheat)` scan returned nothing when planting had faith-failed, so tend
// logged `harvested 0` forever. Robust to partial destruction: re-plants missing cells.
async function tendWheatFarm (bot, { isStopped = () => false, say = () => {} } = {}) {
  const m = loadWorldMem()
  if (!m.wheatFarm) return false
  // FARM-DEGRADATION FIX (REDESIGN §4.2/§11): a hoe-less bot can re-till nothing, so trampled/
  // reverted cells stay bare dirt and the plot shrinks ("needs tilling but no hoe on hand" -
  // observed live at food 0 with 53 planks in hand). Ensure a hoe BEFORE tending, reconciled
  // exactly as ensureWheatFarm does (withdraw banked > craft wooden_hoe from planks+sticks >
  // gather wood). Best-effort: if none can be made, tend still harvests ripe wheat + replants
  // intact farmland (no hoe needed there) - only re-tilling a reverted cell defers, as today.
  // FARM_TEND_HOE=0 rolls back to the old bail-on-no-hoe behavior.
  if (process.env.FARM_TEND_HOE !== '0' && !(bot.inventory ? bot.inventory.items() : []).find(i => /_hoe$/.test(i.name))) {
    try {
      const res = require('./resources.js') // lazy (resources requires provision at load)
      const near = hutAnchor() || { x: m.wheatFarm.x, y: Math.floor(bot.entity.position.y), z: m.wheatFarm.z }
      const rec = await res.reconcile(bot, { wooden_hoe: 1 }, { near, maxAgeMs: 0, planOpts: { primaryWood: detectWood(bot) || 'oak' } })
      if (rec.withdraws.length || rec.plan.tasks.length) {
        dbg('  wheat tend: acquiring a hoe to re-till (' + (rec.plan.tasks.map(t => `${t.type}:${t.item || t.output}`).join(' > ') || 'from bank') + ')')
        await res.runReconciled(bot, rec, { isStopped, say, home: near })
      }
    } catch (e) { dbg('  wheat tend: hoe acquisition failed (' + e.message + ') - tending without re-till') }
  }
  const mcData = require('minecraft-data')(bot.version)
  const wheatId = mcData.blocksByName.wheat.id
  await walkStaged(bot, m.wheatFarm.x, m.wheatFarm.z, { isStopped, range: 6, timeoutMs: 120000 })
  // TEND-SIDE SEED TOP-UP (FARM_SEED_TOPUP, §5.4): replantCropCell bails seedless, so a seed-
  // starved plot decays. Count the cells that need (re)seeding - 'gone' cells + the under-target
  // shortfall - and if the pack is short, gather from the grass beside the plot BEFORE the
  // harvest/replant loop. A producing farm is seed-self-sufficient; this matters for the
  // seed-starved bootstrap. FARM_SEED_TOPUP=0 skips it (no tend-side gathering, as before).
  if (process.env.FARM_SEED_TOPUP !== '0') {
    try {
      const cellsArr = (m.wheatFarm.cells || [])
      let gone = 0
      for (const c of cellsArr) { const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (farm.cropCellState(b && b.name) === 'gone') gone++ }
      const missing = gone + Math.max(0, WHEAT_FARM_TARGET - cellsArr.length)
      if (missing > 0 && countItem(bot, 'wheat_seeds') < missing) {
        dbg('  wheat tend: seed-starved (' + countItem(bot, 'wheat_seeds') + ' seeds, ' + missing + ' cells need seeding) - gathering from the grass')
        await gatherSeedsNear(bot, Math.min(missing, 12), { isStopped })
      }
    } catch (e) { dbg('  wheat tend: seed top-up failed (' + e.message + ')') }
  }
  // AUTHORITATIVE cell list: the exact crop cells persisted at plant time (block-verified).
  // Fall back to a live scan only for a legacy farm saved before cells were persisted, and
  // ALWAYS also fold in any wheat visible nearby (a growing cell not in the list).
  let cells = (m.wheatFarm.cells || []).map(c => new Vec3(c.x, c.y, c.z))
  const seen = new Set(cells.map(c => c.x + ',' + c.y + ',' + c.z))
  // Fold in wheat visible nearby (a growing cell not in the list) - but ONLY wheat that belongs
  // to OUR plot. The bot spawns next to a village wheat field within 16 blocks; the old blanket
  // findBlocks(16) pulled that foreign field in, so tend wandered off-plot to harvest someone
  // else's wheat (drops landing in the village pond, out of reach -> `harvested N, wheat=0`).
  // Own = within 2 blocks (x/z) of a persisted cell, or within 6 of the farm's water anchor.
  const ownCells = (m.wheatFarm.cells || [])
  const anchor = m.wheatFarm
  const isOurs = q => ownCells.some(c => Math.abs(c.x - q.x) <= 2 && Math.abs(c.z - q.z) <= 2) ||
                      Math.hypot(q.x - anchor.x, q.z - anchor.z) <= 6
  for (const p of (bot.findBlocks({ matching: wheatId, maxDistance: 16, count: 24 }) || [])) {
    const k = p.x + ',' + p.y + ',' + p.z
    if (seen.has(k)) continue
    if (ownCells.length && !isOurs(p)) continue // don't wander into a foreign/village field
    seen.add(k); cells.push(new Vec3(p.x, p.y, p.z))
  }
  let harvested = 0; let replanted = 0
  // FARM_RESEED (§4.2): a cell-health ledger that retires cells the field can no longer hold
  // (water-washed / obstructed) so the record stops "standing" dead and the maxed latch can
  // clear -> the existing ensure ring replants fresh ground. All new statements are gated; with
  // FARM_RESEED=0 this is today's path exactly (the cellHealth field, if present, stays inert).
  const RESEED = process.env.FARM_RESEED !== '0'
  const DEAD_PASSES = Number(process.env.FARM_RESEED_DEAD_PASSES || 3)
  const persistedKeys = new Set((m.wheatFarm.cells || []).map(c => c.x + ',' + c.y + ',' + c.z)) // only PERSISTED cells are ledgered/retired - never the foldin scan wheat
  if (RESEED && !m.wheatFarm.cellHealth) m.wheatFarm.cellHealth = {}
  const cellHealth = RESEED ? m.wheatFarm.cellHealth : null
  const retired = [] // keys retired THIS pass
  let cWheat = 0; let cMature = 0; let cGone = 0; let cFlooded = 0; let cBlocked = 0
  for (const p of cells) {
    if (isStopped()) break
    const b = bot.blockAt(p)
    const state = farm.cropCellState(b && b.name)
    let replantOk = null // captured for the 'gone' branch -> cellHealthStep
    if (state === 'wheat') {
      const age = b.getProperties ? b.getProperties().age : null
      if (farm.matureForHarvest(age)) {
        try {
          if (bot.entity.position.distanceTo(p) > 4) await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 10000)
          await bot.dig(b); harvested++
          // STAND ON THE DROP, then collect wider + patiently. A wheat drop from a cell against
          // the pond bounces toward the water edge and takes a beat to settle; walking onto the
          // crop cell (where the wheat stood, on top of the farmland) puts the pickup box over
          // it, and the wider/patient collect grabs one that drifted a block onto land/water.
          // This is the core "harvested N -> wheat=0" fix.
          try { await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 0), 6000) } catch {}
          await collectDrops(bot, 6, { patience: 5 })
          if (await replantCropCell(bot, p, { isStopped })) replanted++ // reseed the cell we just cleared
        } catch (e) { dbg('  wheat harvest failed (' + e.message + ')') }
      } else if (age != null) {
        await boneMealBlock(bot, p, 2) // still growing - speed it up if bones allow
      }
    } else if (state === 'gone') {
      // SELF-HEAL: creeper/trample/failed plant left this cell empty - re-establish it so the
      // farm converges back to full instead of decaying to zero (ensureWheatFarm won't re-run
      // once a farm is registered, so tend is the ONLY repair path).
      replantOk = await replantCropCell(bot, p, { isStopped })
      if (replantOk) replanted++
    } // 'flooded'/'blocked': leave it - not fixable from here (retirement below handles a persistent one)
    // FARM_RESEED: tally + age the health of PERSISTED cells only (foldins aren't in the ledger).
    if (RESEED && persistedKeys.has(p.x + ',' + p.y + ',' + p.z)) {
      const key = p.x + ',' + p.y + ',' + p.z
      if (state === 'wheat') { cWheat++; if (farm.matureForHarvest(b.getProperties ? b.getProperties().age : null)) cMature++ } else if (state === 'gone') cGone++
      else if (state === 'flooded') cFlooded++
      else cBlocked++
      const step = farm.cellHealthStep(state, replantOk, cellHealth[key] || 0, DEAD_PASSES)
      if (step.retire) retired.push(key)
      else if (step.deadRuns > 0) cellHealth[key] = step.deadRuns
      else delete cellHealth[key]
    }
  }
  // FARM_RESEED (§4.2): retire the dead cells, un-latch maxed, and reseed while standing here.
  if (RESEED) {
    if (retired.length) {
      const retiredSet = new Set(retired)
      const survivors = (m.wheatFarm.cells || []).filter(c => !retiredSet.has(c.x + ',' + c.y + ',' + c.z))
      m.wheatFarm.cells = survivors
      for (const key of retired) delete cellHealth[key]
      // §4.9 (#28 handshake): FARM_EXPAND on -> a cell #28 retired must not be the widened ring's
      // first re-till candidate (retire->re-till->wash->retire churn). Column key its "x,z" into
      // bankBarren at 2 strikes (out) before the ensure ring re-scans.
      if (process.env.FARM_EXPAND !== '0') {
        m.wheatFarm.bankBarren = m.wheatFarm.bankBarren || {}
        for (const key of retired) { const parts = key.split(','); m.wheatFarm.bankBarren[parts[0] + ',' + parts[2]] = 2 }
      }
      const unlatch = farm.plotShouldUnlatch(retired.length, survivors.length, WHEAT_FARM_TARGET)
      if (unlatch) m.wheatFarm.maxed = false
      saveWorldMem()
      dbg('  farm reseed: retired ' + retired.length + ' dead cell(s), ' + survivors.length + ' live remain' + (unlatch ? ', maxed cleared' : ''))
    }
    dbg('  farm health: wheat=' + cWheat + '(mature ' + cMature + ') gone=' + cGone + ' flooded=' + cFlooded + ' blocked=' + cBlocked + ' retired-total=' + retired.length)
    // Immediate reseed while standing at the pond: retirement freed the maxed latch, so let the
    // EXISTING ensure ring till+plant fresh cells with the seeds on hand (bounded, block-verified;
    // water is within 48 by construction so no trek in the normal case). One attempt per pass;
    // if ensure defers (night/hostiles/no bank) the durable un-latched maxed lets later callers retry.
    if (retired.length && !m.wheatFarm.maxed && !isStopped() && countItem(bot, 'wheat_seeds') > 0) {
      try { await ensureWheatFarm(bot, { x: m.wheatFarm.x, z: m.wheatFarm.z }, { isStopped, say }) } catch (e) { dbg('  farm reseed: inline ensure failed (' + e.message + ')') }
    }
  }
  // FIX #38: WHOLE-PLOT collect sweep. A big plot (live: 22 cells at 446,31) spans past radius 6,
  // so the old fixed-6 sweep left drops at far cells on the ground ("harvested 8 -> wheat=1"). Center
  // on the plot (the water anchor) and collect out to a radius that covers its bounding box, so every
  // cell's drop is in range. Bounded: one sweep, radius capped (farm.plotCollectRadius). Off-plot
  // drops stay out via the cap. FARM_COLLECT_PLOT=0 restores today's radius-6 sweep.
  if (harvested) {
    if (process.env.FARM_COLLECT_PLOT !== '0') {
      const pcells = m.wheatFarm.cells || []
      const rad = farm.plotCollectRadius(pcells, { x: m.wheatFarm.x, z: m.wheatFarm.z })
      const cy = (pcells[0] && pcells[0].y) || Math.floor(bot.entity.position.y)
      try { await gotoWithTimeout(bot, new goals.GoalNear(m.wheatFarm.x, cy, m.wheatFarm.z, 2), 12000) } catch {}
      await collectDrops(bot, rad, { patience: 3 })
    } else {
      await collectDrops(bot, 6, { patience: 3 }) // legacy: tight radius sweep at the current spot
    }
  }
  const wheatN = countItem(bot, 'wheat')
  if (wheatN >= 3) { try { const made = await runCraft(bot, 'bread', Math.floor(wheatN / 3), true, { isStopped }); say('baked ' + made + ' bread - crisis over'); dbg('  baked ' + made + ' bread') } catch (e) { dbg('  bread craft failed (' + e.message + ')') } }
  dbg('  wheat farm tended: harvested ' + harvested + ', replanted ' + replanted + ', wheat=' + countItem(bot, 'wheat') + ', bread=' + countItem(bot, 'bread'))
  return harvested > 0 || replanted > 0 || countItem(bot, 'bread') > 0
}

// ---- FISHING: the food of last resort that works ANYWHERE with water (the guardian
// escort proved this region has no animals - one sheep in 40 minutes - and the bot
// starved through every other fallback). A rod is 3 sticks + 2 string; spiders pay the
// string; raw cod/salmon are safe food the auto-eat handles.
async function ensureFishingRod (bot, { isStopped = () => false, home } = {}) {
  const has = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'fishing_rod')
  if (has()) return true
  // FOOD_FLOOR F2: guarantee the rod. A naked post-death bot has 0 string (can't craft), so the
  // #40-maintained bank reserve (F3 tops it up) is the reliable source - WITHDRAW the reserved rod
  // before falling back to a craft. Bounded chest read (<=64b); a dry bank falls through to craft.
  // FOOD_FLOOR=0 -> skip straight to today's string/craft path (byte-for-byte).
  if (process.env.FOOD_FLOOR !== '0') {
    try { await require('./resources.js').withdrawItems(bot, 'fishing_rod', 1, { near: home, maxDist: 64 }) } catch (e) { dbg('  fishing: rod bank-withdraw failed (' + e.message + ')') }
    if (has()) { dbg('  fishing: withdrew a fishing_rod from the bank reserve'); return true }
  }
  // B-slice-1 (PLANNER_FOOD, default on): route the rod through the reconcile PLANNER (resources.acquire)
  // so it WITHDRAWS the string + sticks sitting in the BANK and crafts a rod. The hand path below only
  // ever read PACK string, so the bot starved with 3 string in its own chest. acquire recurses the
  // recipe (rod->string+sticks) against pack+bank holdings and crafts, and REFUSES to wander off and
  // gather (safe to run at a food crisis). reconcile structurally can't obtain string from the WORLD
  // (not gatherable), so a truly dry bank falls through to the spider hunt below. PLANNER_FOOD=0 ->
  // skip this block (today's hand string-check path, byte-for-byte).
  if (process.env.PLANNER_FOOD !== '0') {
    try {
      const res = require('./resources.js')
      if (await res.acquire(bot, 'fishing_rod', 1, { near: home, isStopped, say: m => dbg('  ' + m) }) && has()) {
        dbg('  fishing: got a rod via the planner (bank string -> craft)'); return true
      }
    } catch (e) { dbg('  fishing: planner rod acquire failed (' + e.message + ')') }
  }
  const inv = inventoryCounts(bot)
  let stringN = inv.string || 0
  // ROD_SUPPLY (M2): before deferring on <2 string, make the craft REACHABLE - a rod-less,
  // string-short bot finishes off a NEARBY spider for its string (bounded ONE pass; no-op if none
  // near), then re-reads. The F2 bank-withdraw already ran above (dry, or FOOD_FLOOR=0), so
  // bankRods=0 here. Still short -> today's honest defer. Flag off => byte-for-byte (no hunt/re-read).
  if (process.env.ROD_SUPPLY === '1' && foodSec.needStringForRod({ hasRod: false, packString: stringN, bankRods: 0 })) {
    dbg('  fishing: no rod + ' + stringN + ' string - one bounded spider-string hunt')
    try { await huntSpiderForString(bot, { isStopped }) } catch (e) { dbg('  fishing: spider-string hunt failed (' + e.message + ')') }
    stringN = inventoryCounts(bot).string || 0
  }
  if (stringN < 2) { dbg('  fishing: no rod and only ' + stringN + ' string - deferred'); return false }
  try { await runCraft(bot, 'fishing_rod', 1, true, { isStopped, home }) } catch (e) { dbg('  fishing: rod craft failed (' + e.message + ')'); return false }
  return !!has()
}

// A standing wheat farm (planted + remembered) = the renewable food source.
function hasStandingFarm () { const wf = loadWorldMem().wheatFarm; return !!(wf && wf.cells && wf.cells.length > 0) } // a 0-cell (stale/failed) record is NOT a standing farm - else the food system thinks farming is handled when there's no plot

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
function nearestFoodAnimal (bot, maxDist = 40) {
  const me = bot.entity && bot.entity.position
  if (!me) return null
  let best = null; let bd = maxDist
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
    if (!FOOD_ANIMALS.test((e.name || '').toLowerCase())) continue
    const d = e.position.distanceTo(me); if (d < bd) { bd = d; best = { name: e.name, dist: d } }
  }
  return best
}

// Eat what's in the pack up to comfortable - cook raw meat FIRST (raw is poor food), then eat.
// Fixes "idled at food=13 holding beef" - never sit hungry with food in hand.
async function eatFromPackToComfortable (bot, isStopped = () => false) {
  try { if (bot.food != null && bot.food < 18 && Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped }) } catch {}
  try { await eatUp(bot) } catch {}
}

async function ensureFoodSupply (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const anchor = opts.home || { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }
  const animalRange = parseInt(process.env.FOOD_ANIMAL_RANGE || '40', 10)
  // 0) EAT what we carry first (cook raw -> eat to comfortable) - never idle hungry with food.
  await eatFromPackToComfortable(bot, isStopped)
  // DECISION LOOP (foodSupplyAction): tend / buildFarm-at-known-water / huntNear / sweep. The
  // KEY fix - after a sweep discovers + remembers water, the NEXT iteration sees knownWater and
  // BUILDS THE FARM there instead of idling at the hut ("found it, did nothing"). Bounded.
  let sweeps = 0
  for (let step = 0; step < 4 && !isStopped(); step++) {
    if (hasStandingFarm()) {
      let tended = false
      try { tended = await tendWheatFarm(bot, { isStopped, say }) } catch (e) { dbg('  foodSupply: tend failed (' + e.message + ')') }
      // GROW a standing-but-undersized farm on the fed-idle pass too (same guard as secureFood):
      // tend returning true no longer blocks expansion - re-admit an under-target, un-maxed farm.
      const wf = loadWorldMem().wheatFarm
      const under = wf && (wf.cells || []).length > 0 && (wf.cells || []).length < WHEAT_FARM_TARGET && !wf.maxed
      if (!tended || under) {
        try { await ensureWheatFarm(bot, anchor, { isStopped, say }) } catch (e) { dbg('  foodSupply: expand failed (' + e.message + ')') }
      }
      return { ok: true, reason: 'wheat farm stands - tended it' }
    }
    const knownWater = recallInfra('water', bot.entity.position, 300)
    const nearAnimal = nearestFoodAnimal(bot, animalRange)
    const action = foodSec.foodSupplyAction(false, !!knownWater, !!nearAnimal)
    dbg('  ensureFoodSupply[step ' + step + ']: action=' + action +
        ' knownWater=' + (knownWater ? knownWater.x + ',' + knownWater.z : 'none') +
        ' nearAnimal=' + (nearAnimal ? nearAnimal.name + '@' + Math.round(nearAnimal.dist) + 'b' : 'none'))
    if (action === 'buildFarm') {
      // THE MISSING HANDOFF: WALK to the found/remembered pond first (ensureWheatFarm only
      // searches ~48 locally), VERIFY it's an open-sky pond ON ARRIVAL, then build there.
      say('found water at ' + knownWater.x + ',' + knownWater.z + ' - going there to build a wheat farm')
      dbg('  ensureFoodSupply: trekking to the pond at ' + knownWater.x + ',' + knownWater.z + ' to farm it')
      try { await walkStaged(bot, knownWater.x, knownWater.z, { isStopped, range: 6, timeoutMs: 150000 }) } catch {}
      // on arrival: is there OPEN-SKY water within reach? A remembered pond can be cave/covered
      // (older pre-seesSky memory) - drop it and try the NEXT remembered pond, don't loop on it.
      const md = require('minecraft-data')(bot.version)
      const seesSky = p => { for (let dy = 1; dy <= 40; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false } return true }
      const arrived = Math.hypot(bot.entity.position.x - knownWater.x, bot.entity.position.z - knownWater.z) <= 10
      const openWater = arrived && (bot.findBlocks({ matching: md.blocksByName.water.id, maxDistance: 24, count: 32 }) || []).some(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) && seesSky(p) })
      if (arrived && !openWater) {
        dbg('  ensureFoodSupply: remembered pond ' + knownWater.x + ',' + knownWater.z + ' is cave/covered on arrival - forgetting it, trying the next')
        try { forgetInfra('water', listInfra('water').find(e => e.x === knownWater.x && e.z === knownWater.z)) } catch {}
        continue // loop: next remembered pond, or sweep farther
      }
      if (!arrived) { dbg('  ensureFoodSupply: could not reach the pond (trek fell short) - keeping it, will retry'); return { ok: false, reason: 'could not reach the discovered pond - retry next pass' } }
      // we're AT an open-sky pond -> build the farm here (ensureWheatFarm finds water locally now)
      try { await ensureWheatFarm(bot, { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }, { isStopped, say, avoid: opts.avoid }) } catch (e) { dbg('  foodSupply: wheat farm setup error (' + e.message + ')') }
      if (hasStandingFarm()) { await eatFromPackToComfortable(bot, isStopped); return { ok: true, reason: 'wheat farm PLANTED at the discovered pond ' + knownWater.x + ',' + knownWater.z } }
      // at a good pond but the farm still deferred (hoe/seeds) - the pond is FINE, don't forget
      // it; the wheat-farm log names the reason (now the hoe is resource-model-crafted). Retry.
      dbg('  ensureFoodSupply: at the open-sky pond but farm setup deferred (hoe/seeds - see wheat-farm log)')
      return { ok: false, reason: 'at the pond but farm setup deferred (hoe/seeds) - retry next pass' }
    } else if (action === 'huntNear') {
      dbg('  ensureFoodSupply: ' + nearAnimal.name + ' ' + Math.round(nearAnimal.dist) + 'b away - hunting it')
      try { await huntForFood(bot, { isStopped, range: animalRange }) } catch {}
      if (foodCount(bot) > 0) { await eatFromPackToComfortable(bot, isStopped); return { ok: true, reason: 'hunted a nearby animal' } }
    } else { // 'sweep' - discover water/animals; widen the rings on later sweeps
      const rings = sweeps === 0 ? [48, 96] : [96, 144, 192]
      sweeps++
      dbg('  ensureFoodSupply: no known food source - SWEEPING (rings ' + rings.join('/') + ') to discover one')
      try {
        const r = await scoutForFood(bot, anchor, { isStopped, say, rings, maxMs: opts.scoutMs || 240000 })
        if (r && r.found === 'animals' && r.kills > 0) { await eatFromPackToComfortable(bot, isStopped); return { ok: true, reason: 'scouted out animals and hunted ' + r.kills } }
        // the sweep remembered water -> the NEXT loop iteration will pick 'buildFarm'
      } catch (e) { dbg('  foodSupply: scout failed (' + e.message + ')') }
    }
  }
  return { ok: hasStandingFarm() || foodCount(bot) > 0, reason: hasStandingFarm() ? 'wheat farm planted' : 'still looking for a farmable open-sky pond (swept, none tillable yet - will retry)' }
}

// Cheap check (NO bank walk): should a fed, idle, safe bot proactively establish its food
// supply now? The index reflex gates on this. Renewable = a standing wheat farm; banked food
// is treated as 0 here (cheap) - the bank is the reactive pantry, not the durable supply.
function needFoodSupply (bot) {
  if (!bot.entity || bot.food == null) return false
  const safe = !nearHostile(bot, 12) && (bot.health ?? 20) >= 12 && !isNight(bot) && !hasSolidCeiling(bot, 12)
  return foodSec.needsFoodSupply(bot.food, hasStandingFarm(), foodCount(bot), 0, safe)
}

// ---- JOB-LEVEL ARBITER: the bot->state snapshot the pure authority (arbiter.jobSurvivalNeed)
// reads. This is the ONE place the scattered survival predicates are gathered; every progress
// job consults survivalNeed(bot)/mayDoProgress(bot) instead of its own food/hp/threat checks.
function survivalState (bot) {
  const me = bot.entity && bot.entity.position
  let threatDist = null
  let creeperDist = null // tracked SEPARATELY: a creeper triggers avoidance at a longer range
  if (me) {
    // LOS/reachability gate: a hostile walled off behind solid rock (deep in a cave, on the
    // far side of a shaft wall) is NOT a live progress-block - discount it so a fully-enclosed
    // mob doesn't freeze mining/build forever. Close floor (<=5b) ALWAYS counts (may be right
    // above/below or breaking through); the raycast only runs in the 5..16.5b band so far-mob
    // values stay bit-identical to before. THREAT_LOS=0 disables (blocked stays false).
    const losOn = process.env.THREAT_LOS !== '0'
    const losFloor = parseInt(process.env.THREAT_LOS_FLOOR || '5', 10)
    let los = null
    const eye = me.offset(0, (bot.entity && bot.entity.height) || 1.62, 0)
    const isSolid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!(b && b.boundingBox === 'block' && !AIRISH(b.name)) }
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
      const name = (e.name || '').toLowerCase()
      const d = e.position.distanceTo(me)
      // occlusion: BOTH feet-center and head rays must be blocked to discount (conservative
      // vs 1-block gaps). FAIL-OPEN: any error leaves blocked=false so the mob counts.
      let blocked = false
      if (losOn && d > losFloor && d <= 16.5) {
        try {
          if (!los) los = require('./los.js')
          const feet = los.lineBlocked(eye, e.position.offset(0, 0.5, 0), isSolid)
          const head = feet ? los.lineBlocked(eye, e.position.offset(0, (e.height || 1.6) - 0.1, 0), isSolid) : false
          blocked = feet && head
        } catch { blocked = false }
      }
      if (!arbiter.hostileThreatens(d, blocked, { floor: losFloor })) continue
      if (/creeper/.test(name) && (creeperDist == null || d < creeperDist)) creeperDist = d
      if (!SHELTER_HOSTILE.test(name)) continue
      if (threatDist == null || d < threatDist) threatDist = d
    }
  }
  let drowning = false
  try { const h = me && bot.blockAt(me.floored().offset(0, 1, 0)); drowning = !!(h && /water|seagrass|kelp|bubble_column/.test(h.name)) } catch {}
  return {
    food: bot.food,
    hp: bot.health,
    threatDist,
    creeperDist,
    drowning,
    inLava: !!(bot.entity && bot.entity.isInLava),
    onFire: false, // the auto-defend/hazard reflexes own fire; not a progress-gate need here
    isNight: isNight(bot),
    underArmored: underArmored(bot),
    nightStuck: nightStuck(bot) // frozen/eternal night -> don't surface the "shelter" progress-block
  }
}
// The highest UNMET survival need blocking progress, or null. opts.foodThreshold: 14 to START a
// progress job (default), 6 for a mid-activity CRITICAL bail. THE single authority.
function survivalNeed (bot, opts = {}) {
  if (!bot.entity) return null
  const foodThreshold = opts.foodThreshold != null ? opts.foodThreshold : parseInt(process.env.PROGRESS_FOOD_MIN || '14', 10)
  return arbiter.jobSurvivalNeed(survivalState(bot), { ...opts, foodThreshold })
}
// May a progress job (gearup/build/mine/gather) run RIGHT NOW? False when a SURVIVE need is
// unmet. Callers yield to the need (secure food / flee / shelter) and resume once it's met.
function mayDoProgress (bot, opts = {}) { return survivalNeed(bot, opts) == null }

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
function activeJobInfo () {
  const commands = require('./commands.js')
  const prog = (() => { try { return commands.progressInfo() } catch { return { at: 0, stalled: false } } })()
  const mk = (name, cls, startedAt) => ({
    name,
    cls,
    startedAt: startedAt != null ? startedAt : null,
    lastProgressAt: Math.max(prog.at || 0, startedAt || 0),
    blockedOn: prog.stalled ? 'stalled' : null
  })
  const a = commands.activityInfo && commands.activityInfo()
  if (a && a.name) return mk(a.name, scheduler.commandClass(a.name), a.startedAt)
  if (isRecoveringDegraded()) return mk('recoveryLadder', 'survival', null)
  if (isSecuringFood()) return mk('secureFood', 'survival', null)
  if (isRecoveringHp()) return mk('recoverHp', 'survival', null)
  if (isResting()) return mk('nightShelter', 'survival', null)
  if (isMaintaining()) return mk('maintenancePass', 'maintain', null)
  return null
}

async function schedulerState (bot) {
  const s = {}
  try { Object.assign(s, survivalState(bot)) } catch {} // spread the base survival threat/vitals scan ONCE
  const me = (bot && bot.entity && bot.entity.position) || null
  const home = (() => { try { return hutAnchor() || knownBed() || null } catch { return null } })()
  // packFoodPts: the exact bank foodPoints sum (below), applied to the pack; foodTier<2 gates out
  // rotten/poisonous (BAD_FOOD = tier 2).
  try {
    const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
    let pts = 0
    for (const i of (bot.inventory ? bot.inventory.items() : [])) {
      if (foods[i.name] && foodSec.foodTier(i.name) < 2) pts += (foods[i.name].foodPoints || 0) * i.count
    }
    s.packFoodPts = pts
  } catch { s.packFoodPts = 0 }
  try { s.armorPieces = armorPieceCount(bot) } catch {}
  // packArmorPieces: unworn armor carried in the pack (recoveryPlan R0 wears it). Same armor-name
  // regex the grave notables use (commands.js).
  try {
    s.packArmorPieces = (bot.inventory ? bot.inventory.items() : [])
      .filter(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name))
      .reduce((n, i) => n + i.count, 0)
  } catch { s.packArmorPieces = 0 }
  // #41: a spare (2nd+) sword carried in the pack is a donatable dupe for the banked spare-kit need.
  try { s.spareSwordInPack = (bot.inventory ? bot.inventory.items() : []).filter(i => /_sword$/.test(i.name)).reduce((n, i) => n + i.count, 0) >= 2 } catch { s.spareSwordInPack = false }
  // graves + deathsRecent from the death ledger. LAZY require: commands already requires provision,
  // so a top-level require would be a cycle (established pattern - cf. the inline resources require).
  try {
    const commands = require('./commands.js')
    const g = commands.gravesSnapshot({ pos: me, home })
    s.graves = g.graves; s.deathsRecent = g.deathsRecent
  } catch { s.graves = []; s.deathsRecent = 0 }
  // homeDist: XZ to the hut anchor else the bed; null if neither.
  try { s.homeDist = (me && home) ? Math.hypot(me.x - home.x, me.z - home.z) : null } catch { s.homeDist = null }
  // bankFoodPts: cachedOnly chest counts near home -> foodPoints sum (the live HOME-FOOD-FIRST
  // pattern). cachedOnly is MANDATORY so the tick never walks the bot to open a chest.
  try {
    let totals = {}
    if (home) totals = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: home, maxDist: 64 })
    const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
    let pts = 0
    for (const [n, c] of Object.entries(totals)) if (foods[n]) pts += (foods[n].foodPoints || 0) * c
    s.bankFoodPts = pts
    // #41 RESILIENT_RECOVERY: what the bank holds toward ONE spare set (same cachedOnly read as
    // bankFoodPts - never walks). Feeds maintain.needs(spareKit), scheduler.recoveryReady, and the
    // rearmFromBank rung gate. Absent -> maintain treats spareKit as "not measured" (no spurious need).
    s.bankArmorPieces = Object.entries(totals).filter(([n]) => /_(helmet|chestplate|leggings|boots)$/.test(n)).reduce((a, [, c]) => a + c, 0)
    s.bankHasPick = Object.keys(totals).some(n => /_pickaxe$/.test(n))
    s.bankHasSword = Object.keys(totals).some(n => /_sword$/.test(n))
  } catch { s.bankFoodPts = 0; s.bankArmorPieces = 0; s.bankHasPick = false; s.bankHasSword = false }
  // farm: standing wheat farm + XZ distance to its water anchor.
  try {
    const wf = loadWorldMem().wheatFarm
    s.farm = { exists: hasStandingFarm(), dist: (wf && me) ? Math.hypot(me.x - wf.x, me.z - wf.z) : null }
  } catch { s.farm = { exists: false, dist: null } }
  // orchard: XZ distance + when the grove is next harvestable.
  try {
    const o = loadWorldMem().orchard
    s.orchard = o ? { dist: me ? Math.hypot(me.x - o.x, me.z - o.z) : null, readyAt: o.harvestReadyAt != null ? o.harvestReadyAt : null } : {}
  } catch { s.orchard = {} }
  try { s.gearupBackoffUntil = (gearupState() || {}).until || 0 } catch { s.gearupBackoffUntil = 0 }
  // activeJob: the running activity/survival-latch synthesis (S7: factored into activeJobInfo so the
  // snapshot and the 5s watchdog share ONE definition; lastProgressAt/blockedOn are now REAL data).
  try { s.activeJob = activeJobInfo() } catch { s.activeJob = null }
  try { const commands = require('./commands.js'); s.persistedBuild = !!(commands.persistedResume && commands.persistedResume()) } catch { s.persistedBuild = false }
  // maintain.needs inputs.
  try { s.torches = countItem(bot, 'torch') } catch { s.torches = 0 }
  // tools booleans (S6): pick/sparePick via workingPickCount (>=1/>=2 usable picks); axe/sword
  // via an inventory name scan (/_axe$/ does NOT match /_pickaxe$/). Feeds maintain.needs' tools.
  try {
    const pc = workingPickCount(bot)
    const inv = (bot.inventory ? bot.inventory.items() : [])
    // FIX #20 (TOOL_TIER_UPGRADE, default on): a sword/axe is "adequate" only at STONE tier+ ONCE
    // the bot can mine cobble (has a working pick). A wooden-only sword/axe with a pick in hand
    // reads as a NEED so maintain STEP 7 up-tiers it (wooden->stone) - before, mere existence
    // satisfied it, so a bot that mined cobble carried a wooden sword forever. Never demands an
    // upgrade it can't afford: with NO working pick, wooden stays adequate (can't gather cobble
    // yet) and STEP 7 acquires the pick first anyway. TOOL_TIER_UPGRADE=0 -> existence-only.
    const TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }
    const bestTier = re => inv.filter(i => re.test(i.name)).reduce((m, i) => { const g = /^(wooden|golden|stone|iron|diamond|netherite)_/.exec(i.name); return Math.max(m, g ? (TIER[g[1]] || 0) : 0) }, 0)
    const tierUp = process.env.TOOL_TIER_UPGRADE !== '0'
    const adequate = re => { const bt = bestTier(re); if (bt <= 0) return false; if (!tierUp) return true; return bt >= 2 || pc < 1 }
    s.tools = { pick: pc >= 1, sparePick: pc >= 2, axe: adequate(/_axe$/), sword: adequate(/_sword$/) }
  } catch { s.tools = { pick: false, sparePick: false, axe: false, sword: false } }
  s.homeReachable = s.homeDist != null && s.homeDist <= 48
  // maintainNeeded computed LAST on the fully-assembled base snapshot (pure, no cycle). S4 never
  // dispatches maintain; the field exists so pickJob is exercised with real data (S6 = one-line enable).
  try { const maintain = require('./maintain.js'); s.maintainNeeded = maintain.needs(s).length > 0 } catch { s.maintainNeeded = false }
  return s
}

// #52 FISH_FROM_BANK — PURE bank-stand predicate. A cell is a safe fishing STAND iff its feet/head
// are a genuinely-dry standable pocket (shelterSite.feetCellDry: 2 air, no water in feet/head or the
// 4 feet-level neighbours - never a puddle edge that floods) AND some water is horizontally adjacent
// so a cast actually reaches the pond. hasAdjacentWater is computed at the GROUND level by the caller
// (feet-level water is excluded by feetCellDry). Extracted for unit testing.
function isBankStand (feetName, headName, sideNames, hasAdjacentWater) {
  if (!hasAdjacentWater) return false // dry but landlocked - a cast can't reach water
  return shelterSite.feetCellDry(feetName, headName, sideNames || [])
}

// #52 FISH_FROM_BANK — the nearest DRY, castable bank stand cell adjacent to water `w`, or null.
// Scans solid ground blocks within ~3b horizontally of w (a small y-window covers a flush shore or a
// one-block lip), tests each with isBankStand, and returns the feet Vec3 nearest the bot. Never picks
// a cell in/under water - the whole point is to fish standing dry, casting INTO the pond.
function bankStandFor (bot, w) {
  if (!bot.entity || !w) return null
  const nameAt = p => { const b = bot.blockAt(p); return b ? b.name : null }
  const isSolid = p => { const b = bot.blockAt(p); return !!(b && b.boundingBox === 'block' && !/water|lava/.test(b.name)) }
  const isWater = n => n != null && /water/.test(n)
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const R = 3
  const cand = []
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      if (dx === 0 && dz === 0) continue
      if (Math.hypot(dx, dz) > R + 0.001) continue // within ~3b horizontally of the water (cast range)
      for (let dy = -2; dy <= 2; dy++) {
        const g = new Vec3(w.x + dx, w.y + dy, w.z + dz)
        if (!isSolid(g)) continue // must be a solid block to stand ON
        const feet = g.offset(0, 1, 0); const head = g.offset(0, 2, 0)
        const feetName = nameAt(feet); const headName = nameAt(head)
        const feetSides = SIDES.map(([sx, sz]) => nameAt(feet.offset(sx, 0, sz)))
        // castable: water horizontally adjacent to the GROUND block (at g's level or one below - a
        // flush shore or the foot of a low lip); feet-level neighbours stay dry per feetCellDry.
        const hasAdjacentWater = SIDES.some(([sx, sz]) => isWater(nameAt(g.offset(sx, 0, sz))) || isWater(nameAt(g.offset(sx, -1, sz))))
        if (!isBankStand(feetName, headName, feetSides, hasAdjacentWater)) continue
        cand.push({ x: feet.x, y: feet.y, z: feet.z })
      }
    }
  }
  const ranked = shelterSite.rankByDistance(cand, bot.entity.position)
  return ranked.length ? new Vec3(ranked[0].x, ranked[0].y, ranked[0].z) : null
}

async function fishForFood (bot, { isStopped = () => false, say = () => {}, target = 6, home, scout = false, scoutRings } = {}) {
  if (hasSolidCeiling(bot, 12)) { dbg('  fishing: underground - not here'); return false }
  const mcData = require('minecraft-data')(bot.version)
  const edible = () => (bot.inventory ? bot.inventory.items() : []).filter(i => mcData.foodsByName && mcData.foodsByName[i.name] && !/rotten|spider_eye|poisonous/.test(i.name)).reduce((s, i) => s + i.count, 0)
  if (!await ensureFishingRod(bot, { isStopped, home })) return false
  const waterId = mcData.blocksByName.water.id
  const findWaters = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 64 }) || []) // sample WIDE: the nearest N blocks of a lake are all submerged and fail the air-above filter
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
  let waters = findWaters()
  if (!waters.length) {
    // no water in sight - a REMEMBERED pond first (shared with the wheat farm), then, in a
    // real famine (opts.scout), a bounded scout for one. Water is the guaranteed food path.
    const known = recallInfra('water', bot.entity.position, 160)
    if (known && !isStopped()) {
      dbg('  fishing: walking to remembered water at ' + known.x + ',' + known.z)
      try { await walkStaged(bot, known.x, known.z, { isStopped, range: 6, timeoutMs: 120000 }) } catch {}
      waters = findWaters()
    }
    if (!waters.length && scout && !isStopped()) waters = await scoutForWater(bot, { isStopped, rings: scoutRings })
  }
  if (!waters.length) { dbg('  fishing: no surface water within 48' + (scout ? ' (scout came up dry too)' : '')); return false }
  // #52 FISH_FROM_BANK (default on): fish standing on a DRY SOLID BANK at the water's edge - never IN
  // the deep water (the pond drownings: GoalNear(water,3) is satisfied standing submerged). Iterate
  // candidate waters nearest-first; for each, walk to a verified-dry adjacent bank stand and cast from
  // there. FISH_FROM_BANK=0 -> the original waters[0] + GoalNear(water,3) path, byte-for-byte.
  let w
  if (process.env.FISH_FROM_BANK !== '0') {
    const nav = require('./navigate.js')
    let stood = false
    for (const cw of waters.slice(0, 8)) {
      if (isStopped()) return false
      const stand = bankStandFor(bot, cw)
      if (!stand) continue
      try { await nav.navigateTo(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 20000, deadlineMs: 40000, budgets: { water: 0, pit: 0, door: 1, nudge: 1, stepout: 1 }, label: 'fish-stand' }) } catch {}
      if (isStopped()) return false
      if (inWaterNow(bot)) { dbg('  fishing: arrived wet at the ' + cw.x + ',' + cw.z + ' bank - trying the next water'); continue }
      w = cw; stood = true; break // standing DRY on the bank - cast at this water
    }
    if (!stood) { dbg('  fishing: no dry bank at any nearby water - skipping (won\'t fish from in the water)'); return false }
    rememberInfra('water', { x: w.x, y: w.y, z: w.z }) // the farm + future famines trek straight back
  } else {
    w = waters[0]
    rememberInfra('water', { x: w.x, y: w.y, z: w.z }) // the farm + future famines trek straight back
    try { await gotoWithTimeout(bot, new goals.GoalNear(w.x, w.y + 1, w.z, 3), 45000) } catch {}
  }
  if (isStopped()) return false
  say('nothing to hunt around here - fishing for dinner instead')
  dbg('  fishing at the water near ' + w.x + ',' + w.z + ' (edible now: ' + edible() + ', target ' + target + ')')
  const deadline = Date.now() + 240000 // a real session, not forever
  let catches = 0
  while (edible() < target && Date.now() < deadline && !isStopped()) {
    if (nearHostile(bot, 12)) { dbg('  fishing: hostile closing - reeling out'); break }
    const rod = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'fishing_rod')
    if (!rod) break // rod broke
    try { await bot.equip(rod, 'hand') } catch { break }
    try { await bot.lookAt(new Vec3(w.x + 0.5, w.y, w.z + 0.5), true) } catch {}
    try {
      await Promise.race([bot.fish(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('cast timeout')), 45000))])
      catches++
    } catch (e) {
      try { bot.activateItem() } catch {} // reel a dangling line back in
      dbg('  fishing: cast failed (' + e.message + ')')
      await new Promise(r => setTimeout(r, 1500))
    }
    await collectDrops(bot, 4)
  }
  dbg('  fishing done: ' + catches + ' catches, edible=' + edible())
  if (catches > 0) say(`caught ${catches} fish - that'll do`)
  return edible() > 0
}

// ---- SECURE FOOD: the ONE "get me fed" routine -------------------------------------
// Every starving flow funnels here (gather loop, travel legs, smelt rotations, material
// rounds, and the body's food-crisis reflex). A player's order of ops: eat what you
// carry -> raid the pantry (bank) -> cook -> hunt what's visible -> harvest the farm ->
// fish -> go LOOKING for animals -> and if the land is truly barren, hole up at home
// instead of working on at 1hp. Starvation itself stops at half a heart - every actual
// starve-death was chip damage taken while it kept working (verified live, repeatedly).
const RISKY_EAT = /^(rotten_flesh|chicken|spider_eye|poisonous_potato|pufferfish)$/
// One EATING policy (commands.eatFood delegates here): most filling SAFE food first;
// risky food only when starving (<=6) or critically hurt with hunger already low.
async function eatBestFood (bot) {
  if (bot.food != null && bot.food >= 20) return 'not hungry'
  const mcData = require('minecraft-data')(bot.version)
  const foods = (mcData && mcData.foodsByName) || {}
  const items = bot.inventory ? bot.inventory.items() : []
  const edible = items.filter(i => foods[i.name]).sort((a, b) => {
    const risk = (RISKY_EAT.test(a.name) ? 1 : 0) - (RISKY_EAT.test(b.name) ? 1 : 0)
    if (risk) return risk
    return (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0)
  })
  if (!edible.length) return 'no food in inventory'
  const food = edible[0]
  if (RISKY_EAT.test(food.name) && bot.food > 6 && !((bot.health ?? 20) <= 8 && bot.food < 18)) return 'only risky food left - holding out'
  await bot.equip(food, 'hand')
  await bot.consume()
  return `ate ${food.name} (food ${bot.food})`
}

// Eat down the pack until reasonably full or out of (safe) food - one bite of the chain's
// hard-won meat doesn't stop the next starve 10 minutes later.
async function eatUp (bot) {
  for (let i = 0; i < 6; i++) {
    if (bot.food == null || bot.food >= 18) return
    const r = await eatBestFood(bot).catch(() => 'err')
    if (!/^ate /.test(r)) return
  }
}

// BAKE BREAD from banked wheat (the live rescue): the bot's bank wheat is RAW/inedible, so a
// starving bot standing at home with 5 wheat + a farm still can't eat without baking. Top up
// the pack from the bank (runCraft only crafts from ON-HAND) then craft bread at the home
// table via runCraft - the SAME primitive tendWheatFarm/fishing-rod use (ensureTable finds/
// places the table; bot.recipesFor/bot.craft; verified through the pathfix path). Skips
// GRACEFULLY (returns 0, never throws) if no table is reachable or the wheat can't be found.
async function bakeBreadFromWheat (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const home = opts.home || null
  try {
    let wheatN = countItem(bot, 'wheat')
    // BREAD_ENGINE (default on): withdraw enough banked wheat to top the banked reserve up to
    // target (bounded to 33 wheat / 11 loaves per call), not a fixed 3. Reads the bank via the
    // cheap cachedOnly home-food pattern (never walks). BREAD_ENGINE=0 restores the old `3 - wheatN`.
    if (process.env.BREAD_ENGINE !== '0') {
      let bankWheat = 0, bankFoodPts = 0
      try {
        const t = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: home, maxDist: 64 })
        const mdB = require('minecraft-data')(bot.version); const foodsB = (mdB && mdB.foodsByName) || {}
        bankWheat = t.wheat || 0
        for (const [n, c] of Object.entries(t)) if (foodsB[n]) bankFoodPts += (foodsB[n].foodPoints || 0) * c
      } catch (e) { dbg('  bakeBread: bank read failed (' + e.message + ')') }
      const bankTargetPts = Number(process.env.MAINT_BANKFOOD_TARGET || Number(process.env.BREAD_BANK_TARGET || 80))
      const want = foodSec.wheatWithdrawForBake({ packWheat: wheatN, bankWheat, bankFoodPts, bankTargetPts })
      if (want > 0) {
        try { await require('./resources.js').withdrawItems(bot, 'wheat', want, { near: home, maxDist: 64 }) } catch (e) { dbg('  bakeBread: wheat withdraw failed (' + e.message + ')') }
        wheatN = countItem(bot, 'wheat')
      }
    } else if (wheatN < 3) {
      try { await require('./resources.js').withdrawItems(bot, 'wheat', 3 - wheatN, { near: home, maxDist: 64 }) } catch (e) { dbg('  bakeBread: wheat withdraw failed (' + e.message + ')') }
      wheatN = countItem(bot, 'wheat')
    }
    const loaves = foodSec.breadFromWheat(wheatN)
    if (loaves < 1) { dbg('  bakeBread: only ' + wheatN + ' wheat on hand - need 3 for a loaf'); return 0 }
    const made = await runCraft(bot, 'bread', loaves, true, { isStopped, home })
    dbg('  bakeBread: baked ' + made + ' bread from ' + wheatN + ' wheat')
    return made
  } catch (e) { dbg('  bakeBread: skipped (' + e.message + ')'); return 0 }
}

let _securingFood = false
function isSecuringFood () { return _securingFood }
// FOOD_FLOOR F4: the no-progress escalation counter (module-local; a restart re-allows a fresh
// attempt). Advanced by the floor branch on a zero-food dispatch, reset on food gain, and BUMPED
// by the watchdog's `(wd) CYCLE repeatFail` on the recovery ladder (index.js) - so the eternal
// re-loop escalates (widen the water scout one ring + active fishing over a passive outdoor hold)
// instead of re-running the identical failing sequence. Capped (foodFloorEscalation).
let _foodFloorNoProgress = 0
function escalateFoodFloor () { if (process.env.FOOD_FLOOR !== '0') _foodFloorNoProgress = foodSec.foodFloorEscalation(_foodFloorNoProgress, false) }
function _foodFloorState () { return _foodFloorNoProgress } // test/introspection seam
async function secureFood (bot, opts = {}) {
  if (_securingFood) return { fed: false, blockedOn: 'busy' }
  _securingFood = true
  _survStop = false; touchP('secureFood') // S7 H5c: per-dispatch latch clear + zero-idle at t0
  try { return await secureFoodInner(bot, opts) } finally { _securingFood = false }
}
async function secureFoodInner (bot, opts = {}) {
  const isStopped = () => _survStop || (opts.isStopped ? opts.isStopped() : false) // S7: fold the watchdog latch into the existing abort poll
  const say = opts.say || (() => {})
  const home = opts.home || null
  const cookIfRaw = async () => { try { if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped }) } catch {} }
  // EAT TO COMFORTABLE, not just "stopped starving" (live: it cooked beef then wandered off to
  // mine at food=10 and died). "Fed" = the food bar is COMFORTABLE (>=18) - the surplus food
  // left in the pack after eating up to 18 IS the carried buffer. The old release at food>12
  // OR "3 food items" is exactly what let it leave hungry with cooked meat in the pack.
  const comfortable = opts.comfortable != null ? opts.comfortable : 18
  const fedEnough = () => bot.food != null && bot.food >= comfortable
  let triedHomeFood = false // HOME FOOD FIRST: at most ONE home trek per call (loop-safe)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // EATING MUST WIN over a stalled brain goal: the bot idled at food=0 stuck in a stalled
  // item-recovery `travel` while food sat in its chest (live). Drop any lingering goal so the
  // eat -> withdraw -> cook steps below own the body and can walk to the bank/furnace.
  try { if (bot.pathfinder && bot.pathfinder.goal) bot.pathfinder.setGoal(null) } catch {}
  dbg('secureFood: food=' + bot.food + ' packFood=' + foodCount(bot))
  // 0) eat what we carry. COOK-BEFORE-EAT: if the pack's only non-bad food is RAW meat (tier 1
  // and NO ready-to-eat tier-0 food), cook it first (mirror eatFromPackToComfortable) so it
  // doesn't scarf raw mutton at 1/3 value next to a furnace. GUARDED to "no tier-0 in pack" so
  // a genuine crisis holding bread doesn't detour to a furnace before eating it.
  try {
    const md0 = require('minecraft-data')(bot.version); const f0 = (md0 && md0.foodsByName) || {}
    const packFoods = (bot.inventory ? bot.inventory.items() : []).filter(i => f0[i.name])
    const hasReady = packFoods.some(i => foodSec.foodTier(i.name) === 0)
    const hasRaw = packFoods.some(i => foodSec.foodTier(i.name) === 1)
    if (!hasReady && hasRaw) await cookIfRaw()
  } catch {}
  await eatUp(bot)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // 1) the pantry: withdraw banked food. FORCE A FRESH chest read (opts.forceFresh) - a stale
  // cache reported the bank empty for 11h and the bot starved AT its own chest without ever
  // re-opening it (live). A hungry bot near its bank must really open it before giving up.
  try {
    const got = await require('./resources.js').ensureFood(bot, { near: home, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true })
    // COOK RAW BEFORE EATING: the bank holds raw mutton/porkchop + some cooked; if we pulled
    // raw and a furnace is in reach, cook it first (raw is poor food) - eat raw only as the
    // last-resort starving fallback (eatBestFood already gates raw meat to food<=6).
    if (got) { dbg('secureFood: withdrew ' + got + ' food from the bank'); await cookIfRaw(); await eatUp(bot) }
  } catch (e) { dbg('secureFood: bank check failed (' + e.message + ')') }
  if (fedEnough()) return { fed: true, blockedOn: null }
  // 2) raw meat in the pack + a furnace in reach -> cook (3x the food value of raw)
  await cookIfRaw(); await eatUp(bot)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // CHEAP food (pack/bank/cook) is drained. Only GENUINE hunger (<= the acquire trigger)
  // justifies the EXPENSIVE discovery below (hunt/farm/fish/scout) - a moderately-fed bot
  // (e.g. food 15) must not go farming every planner round for the last few points. It eats
  // to comfortable from ready food when it can, and only truly hungry does it go get more.
  const acquireTrigger = opts.threshold != null ? opts.threshold : 12
  if ((bot.food ?? 20) > acquireTrigger) { dbg('secureFood: food=' + bot.food + ' > acquire-trigger ' + acquireTrigger + ' and ready food drained - not hunting/farming for the last points'); return { fed: true, blockedOn: null } }
  // 2.5) HOME FOOD FIRST (HOME_FOOD_FIRST=0 restores today's behavior). Step 1's bank withdraw
  // is RANGE-BOUNDED (maxDist 64): once the bot has drifted beyond it, that read silently
  // no-ops and the chain below marches OUTWARD (scout) hunting NEW food while the bot's own
  // bank + farm sit at home (live: starved 110b out with 5 wheat + a farm at the hut). Before
  // any outward discovery, if we're beyond withdraw range of home AND home holds USABLE food
  // (real banked food, or >=3 bakeable wheat, or a standing farm), trek BACK and use what we
  // own: re-run the in-range pantry, BAKE the raw banked wheat (the actual live rescue), then
  // tend/harvest the farm. ONCE per call + fully guarded: a failed trek or a dry home falls
  // straight through to today's exact chain (hunt/fish/scout) with nothing lost.
  if (process.env.HOME_FOOD_FIRST !== '0' && !triedHomeFood) {
    triedHomeFood = true
    const anchor = home || hutAnchor() || knownBed()
    if (anchor && bot.entity && bot.entity.position) {
      const range = Number(process.env.HOME_FOOD_RANGE || 48)
      const pos = bot.entity.position
      const distHome = Math.hypot(pos.x - anchor.x, pos.z - anchor.z)
      let totals = {}
      try { totals = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: anchor, maxDist: 64 }) } catch {}
      const mdH = require('minecraft-data')(bot.version); const foodsH = (mdH && mdH.foodsByName) || {}
      let bankFoodPts = 0
      for (const [n, c] of Object.entries(totals)) if (foodsH[n]) bankFoodPts += (foodsH[n].foodPoints || 0) * c
      const wheatCount = totals.wheat || 0
      const snap = { distHome, bankFoodPts, wheatCount, hasFarm: hasStandingFarm() }
      if (foodSec.shouldTrekHomeForFood(snap, { range })) {
        say('starving out here - heading home to eat from my own stores')
        dbg('secureFood: HOME FOOD FIRST - ' + Math.round(distHome) + 'b out (range ' + range + '), bankFoodPts=' + bankFoodPts + ' wheat=' + wheatCount + ' farm=' + snap.hasFarm + ' -> trekking home')
        try { await walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 6, timeoutMs: 180000 }) } catch (e) { dbg('  home-food: trek home failed (' + e.message + ')') }
        // re-run the in-range pantry now that we should be home (fresh chest read)
        try {
          const got = await require('./resources.js').ensureFood(bot, { near: anchor, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true })
          if (got) { dbg('  home-food: withdrew ' + got + ' food from the bank'); await cookIfRaw(); await eatUp(bot) }
        } catch (e) { dbg('  home-food: pantry failed (' + e.message + ')') }
        if (fedEnough()) return { fed: true, blockedOn: null }
        // still hungry: BAKE the banked wheat (it's raw/inedible - the live rescue)
        if (snap.wheatCount >= 3 || countItem(bot, 'wheat') >= 3) {
          try { await bakeBreadFromWheat(bot, { isStopped, home: anchor }); await eatUp(bot) } catch (e) { dbg('  home-food: bake failed (' + e.message + ')') }
          if (fedEnough()) return { fed: true, blockedOn: null }
        }
        // last home resort: tend/harvest the farm, then eat what came off it
        try { await tendWheatFarm(bot, { isStopped, say }); await eatUp(bot) } catch (e) { dbg('  home-food: farm tend failed (' + e.message + ')') }
        if (fedEnough()) return { fed: true, blockedOn: null }
        // home came up dry - fall through to today's exact chain below (nothing lost)
      }
    }
  }
  // 3) hunt what's visible (batch - one kill barely dents the deficit)
  try { for (let k = 0; k < 4 && foodCount(bot) < 5 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped, range: 32 })) break } } catch {}
  await cookIfRaw(); await eatUp(bot)
  // F1' FOOD FLOOR (FOOD_FLOOR, default on): the DEDICATED starvation floor - runs BEFORE the
  // isStopped short-circuit below so the ONE reliable acquisition (fishing at remembered / farm-
  // pond / scouted open-sky water) FIRES even when an hp-abort or a stopped latch would otherwise
  // return here with ZERO food (the 3.5h hp1/food0 livelock, §2.2/§2.0). Only at genuine starvation
  // (food<=floorFood) with a dry pack (the bank was already tried at step 1). Rod is guaranteed by
  // ensureFishingRod (bank-withdraw then craft, F2); bounded by fishForFood's 240s cap + hostile
  // reel-out. The floor only fires at food<=floorFood, which IS the §4 spiral exception, so it is
  // never spiral-suppressed. FOOD_FLOOR=0 -> the whole branch is skipped (byte-for-byte).
  let floorFished = false
  if (process.env.FOOD_FLOOR !== '0' && !fedEnough() && foodSec.foodFloorTriggered({ hp: bot.health, food: bot.food, hasPackFood: foodCount(bot) >= 1 })) {
    const escalate = foodSec.foodFloorEscalated(_foodFloorNoProgress)
    const foodBefore = bot.food ?? 0
    dbg('secureFood: FOOD FLOOR - food=' + bot.food + ' hp=' + bot.health + ' pack dry -> fishing floor' + (escalate ? ' (ESCALATED - widening the water scout)' : ''))
    say('starving - going fishing, it\'s the one food source that always works')
    try {
      if (await ensureFishingRod(bot, { isStopped, home })) {
        await fishForFood(bot, { isStopped, say, home, scout: true, scoutRings: escalate ? [48, 96, 144] : undefined })
      } else dbg('  FOOD FLOOR: no rod obtainable (bank reserve dry + can\'t craft) - cannot fish (honest fallback: hold)')
    } catch (e) { dbg('  FOOD FLOOR: fishing floor failed (' + e.message + ')') }
    await cookIfRaw(); await eatUp(bot)
    floorFished = true
    const gained = (bot.food ?? 0) > foodBefore || foodCount(bot) > 0
    _foodFloorNoProgress = foodSec.foodFloorEscalation(_foodFloorNoProgress, gained)
    if (fedEnough()) {
      // F3: a SUCCESSFUL floor session restocks the bank reserve (surplus fish + a spare rod) so R2
      // gotoHome+ensureFood pays out instantly next crisis. Reuses the #40 courier (bounded).
      if (process.env.MAINTAIN !== '0') { try { await courierFoodToBank(bot, { isStopped, say }) } catch {} }
      return { fed: true, blockedOn: null }
    }
  }
  if (fedEnough() || isStopped()) return { fed: fedEnough(), blockedOn: fedEnough() ? null : (isStopped() ? 'stopped' : 'food') }
  // #40 F4.2: a STARVING bot (food<=4) that just trekked home and found the pantry dry must NOT
  // then march OUT to farm/fish/scout - those excursions are what get a 1-hp bot killed. Skip the
  // outward legs and hold indoors (bounded); the caller / crisis reflex re-runs the whole chain
  // later. Only when it can hold and only after HOME-FOOD-FIRST was tried; food>4 (or no-hold
  // callers like the mid-trek chain) keep today's exact hunt/farm/fish/scout ordering.
  // #54 FAMINE_FORAGE_SAFE (default on): the famine-hold (food<=4) is meant to stop a bot from
  // marching out to DIE on a fishing trip - but at hp OK + DAY + no mob near, foraging is SAFE, and
  // holding indoors here just FREEZES the bot forever (food pinned at 4 while perfectly still ->
  // never drains to the food<=2 crisis floor -> never fishes -> zero progress, the live 06:1x stuck).
  // When it's genuinely safe, SKIP the hold so execution reaches the farm-rebuild (5358) + the
  // unconditional fishing leg (5382, fish-from-bank #52) + the scout (5387) and the bot FEEDS itself.
  // Night / mob-near / hp<=floor still holds (the #40 death-march stays fixed). =0 -> today byte-for-byte.
  const safeToForage = process.env.FAMINE_FORAGE_SAFE !== '0' &&
    (bot.health ?? 20) > Number(process.env.FAMINE_FORAGE_HP || 10) && !isNight(bot) && !nearHostile(bot, 12)
  if (opts.canHold && triedHomeFood && foodSec.famineHoldFood(bot.food) && !safeToForage && !isStopped()) {
    dbg('secureFood: famine-hold - food=' + bot.food + ' and home stores dry - holding indoors, not trekking out to fish/scout')
    say('nothing to eat out here and home is dry - holing up rather than starving on a fishing trip')
    try { await boundedHold(bot, { isStopped, say }) } catch {}
    const fedH = foodCount(bot) > 0
    return { fed: fedH, blockedOn: fedH ? null : (isStopped() ? 'stopped' : (isNight(bot) ? 'night' : 'food')) }
  }
  // 4) the farm (harvest what's ripe / plant one by remembered water)
  try {
    // EXPAND, don't just tend: a standing-but-undersized farm (tend returns true after
    // harvesting) never used to grow because ensureWheatFarm only ran when tend returned FALSE.
    // Re-admit an under-target, un-maxed farm so it keeps expanding toward WHEAT_FARM_TARGET.
    const tended = await tendWheatFarm(bot, { isStopped, say })
    const wf = loadWorldMem().wheatFarm
    const under = wf && (wf.cells || []).length > 0 && (wf.cells || []).length < WHEAT_FARM_TARGET && !wf.maxed
    if (!tended || under) {
      // REBUILD the farm even when the BED is gone: a creeper-destroyed bed makes knownBed()->
      // home null, and the old `if (home)` guard then SILENTLY skipped the rebuild - so a bot with
      // no bed + a dead 0-cell farm looped at food 10 forever, never re-planting (live 00:3x, food
      // 10 < 14 gearup-hold, `wheat farm tended: harvested 0` every 20s, ensureWheatFarm never
      // called). Anchor on the hut, else where we STAND (we reach here standing at the pond), so
      // the till-fixed builder actually re-establishes the plot.
      const farmHome = home || (bot.entity && bot.entity.position) || hutAnchor()
      if (farmHome) await ensureWheatFarm(bot, farmHome, { isStopped, say, avoid: opts.avoid })
    }
  } catch (e) { dbg('secureFood: farm fallback failed (' + e.message + ')') }
  await eatUp(bot)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // 5) fish - works anywhere with surface water (scouts for a pond in a real crisis). Skip when the
  // F1' floor already ran the fishing leg this call (no double 240s session); FOOD_FLOOR=0 ->
  // floorFished is always false -> today's unconditional fishing (byte-for-byte).
  try { if (!floorFished) await fishForFood(bot, { isStopped, say, home, scout: bot.food <= 4 }) } catch (e) { dbg('secureFood: fishing failed (' + e.message + ')') }
  await eatUp(bot)
  if (fedEnough()) return { fed: true, blockedOn: null }
  // 6) crisis: SYSTEMATICALLY sweep unexplored ground for animals + water (not the old
  // re-tread-stale-pastures scoutHunt) - the SW/NW food the bot never found was here.
  if (bot.food <= 4 && !isStopped() && opts.scoutHunt !== false && !isNight(bot)) {
    try { await scoutForFood(bot, home || undefined, { isStopped, say, maxMs: opts.scoutMs || 180000 }) } catch (e) { dbg('secureFood: scout failed (' + e.message + ')') }
    await cookIfRaw(); await eatUp(bot)
    if (fedEnough()) return { fed: true, blockedOn: null }
  }
  // 7) famine hold: NOTHING panned out - get home/indoors and sit it out (bounded; the
  // caller or the crisis reflex re-runs the whole chain later).
  if (opts.canHold && (bot.food ?? 20) <= 1 && !isStopped()) { try { await boundedHold(bot, { isStopped, say }) } catch {} }
  const fed = foodCount(bot) > 0
  return { fed, blockedOn: fed ? null : (isStopped() ? 'stopped' : (isNight(bot) ? 'night' : 'food')) }
}

// PROACTIVE, SYSTEMATIC food scouting (the core exploration fix): sweep UNSEARCHED ground
// outward in a real pattern (explore.octantSweep - 8 octants x expanding rings around home)
// to FIND animals + water, biased AWAY from sectors swept recently (persisted, decaying
// negative-memory in worldMem.scouted). The old scoutHunt re-tread stale remembered pastures
// (NE/SE) and never covered the SW/NW where the food actually was (live: starved 88 blocks
// from a river of sheep). Remembers finds: animals -> 'pasture' infra, water -> 'water' infra.
// Returns { found: 'animals'|'water'|null, kills }. Bounded by maxMs + maxLegs.
async function scoutForFood (bot, home, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const say = opts.say || (() => {})
  const explore = require('./explore.js')
  const mcData = require('minecraft-data')(bot.version)
  const anchor = home || { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }
  const rings = opts.rings || [48, 96, 144]
  const m = loadWorldMem()
  const scouted = m.scouted = m.scouted || {}
  const now = Date.now()
  const decayMs = opts.decayMs || 30 * 60000 // a swept sector re-opens after 30 min (mobs wander back)
  const searched = new Set(Object.keys(scouted).filter(k => now - (scouted[k] || 0) < decayMs))
  const waypoints = explore.octantSweep(anchor, { rings })
  const deadline = now + (opts.maxMs || 240000)
  const seesFood = () => Object.values(bot.entities || {}).some(e => e && e.position && FOOD_ANIMALS.test((e.name || '').toLowerCase()))
  // Remember only OPEN-SKY water the wheat farm can actually use (the DISCOVERY<->ACTION
  // mismatch fix): the sweep used to remember ANY air-topped water incl. cave/ravine pools that
  // ensureWheatFarm then REJECTS (seesSky), so "found water" led to a farm that never built.
  const seesSky = p => { for (let dy = 1; dy <= 40; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name)) return false } return true }
  const rememberWaterNear = () => {
    try {
      const w = (bot.findBlocks({ matching: mcData.blocksByName.water.id, maxDistance: 32, count: 32 }) || [])
        .find(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) && seesSky(p) })
      if (w) { rememberInfra('water', { x: w.x, y: w.y, z: w.z }); dbg('  scoutForFood: remembered OPEN-SKY water at ' + w.x + ',' + w.z + ' (farmable)'); return true }
    } catch {}
    return false
  }
  say('scouting the area for food - sweeping ground i haven\'t checked')
  dbg('scoutForFood: sweeping from ' + anchor.x + ',' + anchor.z + ' (rings ' + rings.join('/') + ', ' + searched.size + ' sectors already swept)')
  let visited = 0; let foundWater = false
  while (Date.now() < deadline && !isStopped() && visited < (opts.maxLegs || 8)) {
    if (isNight(bot)) { dbg('  scoutForFood: night - not roaming the dark'); break }
    const wp = explore.firstUnswept(waypoints, searched)
    if (!wp) { dbg('  scoutForFood: every sector swept recently - nothing new to check'); break }
    dbg('  scoutForFood: sweeping octant ' + wp.name + ' ring ' + wp.ring + ' -> walking to ' + wp.x + ',' + wp.z + ' (leg ' + (visited + 1) + '/' + (opts.maxLegs || 8) + ')')
    if (say && visited === 0) say('scouting ' + wp.name + ' for food')
    try { await walkStaged(bot, wp.x, wp.z, { isStopped, range: 8, timeoutMs: 100000 }) } catch {}
    // credit the sector we ACTUALLY reached (a trek that fell short shouldn't mark the far one)
    const hereKey = explore.sectorKeyAt(bot.entity.position.x, bot.entity.position.z, anchor, { rings })
    if (hereKey) { searched.add(hereKey); scouted[hereKey] = Date.now() }
    searched.add(wp.key); scouted[wp.key] = Date.now(); saveWorldMem()
    visited++
    if (rememberWaterNear()) foundWater = true
    if (seesFood()) {
      rememberInfra('pasture', bot.entity.position)
      say('found animals - hunting')
      let kills = 0
      try { for (let k = 0; k < 5 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped, range: 40 })) break; kills++ } } catch {}
      if (kills > 0) { dbg('  scoutForFood: hunted ' + kills + ' at ' + Math.round(bot.entity.position.x) + ',' + Math.round(bot.entity.position.z)); return { found: 'animals', kills } }
    }
  }
  return { found: seesFood() ? 'animals' : (foundWater ? 'water' : null), kills: 0 }
}

// Walk expanding legs looking for food animals. Remembers where it finds them
// ('pasture' infra) so the next famine treks straight back instead of re-searching.
async function scoutHunt (bot, { isStopped = () => false, say = () => {}, maxMs = 180000 } = {}) {
  const start = bot.entity.position.clone()
  const deadline = Date.now() + maxMs
  const seesFood = () => Object.values(bot.entities || {}).some(e => e && e.position && FOOD_ANIMALS.test((e.name || '').toLowerCase()))
  const legs = []
  const known = recallInfra('pasture', start, 200)
  if (known) legs.push({ x: known.x, z: known.z })
  for (const r of [40, 80, 120]) for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) legs.push({ x: start.x + dx * r, z: start.z + dz * r })
  say('nothing to eat around here - going to find animals')
  dbg('scoutHunt: searching from ' + Math.round(start.x) + ',' + Math.round(start.z) + (known ? ' (remembered pasture first)' : ''))
  for (const leg of legs) {
    if (isStopped() || Date.now() > deadline) break
    if (isNight(bot)) { dbg('scoutHunt: night fell - not roaming the dark for dinner'); break }
    try { await walkStaged(bot, leg.x, leg.z, { isStopped, range: 8, timeoutMs: 60000 }) } catch {}
    if (seesFood()) {
      rememberInfra('pasture', bot.entity.position)
      dbg('scoutHunt: animals near ' + Math.round(bot.entity.position.x) + ',' + Math.round(bot.entity.position.z) + ' - remembered as pasture')
      let kills = 0
      try { for (let k = 0; k < 4 && !isStopped(); k++) { if (!await huntForFood(bot, { isStopped, range: 32 })) break; kills++ } } catch {}
      if (kills > 0) return true
    }
  }
  dbg('scoutHunt: no animals found (searched ~120 blocks out)')
  return false
}

// BOUNDED HOLD (S5, replaces the old famine-hold - the I5 migration): nothing edible anywhere -> retreat
// home/indoors and WAIT in the ONE bounded way whose wake provably occurs, instead of dying to
// chip damage at 1hp. Built FROM the old famine-hold's proven body (same get-home preamble + 90s re-eval
// loop with the FORCED-FRESH bank re-check - the 11h-stale-cache starvation fix, DO NOT LOSE IT),
// PLUS a grave-appeared wake (a fresh grave IS a recovery input - the ladder's next pass runs R1)
// and a sealed-pit branch (existing digInForNight) for night-exposed-no-bed. Refuses to hold on
// nightStuck (eternal night has no dawn wake - the caller acts by night instead). The hard deadline
// is unconditional (BOUNDED_HOLD_MS, default 90s). Returns { held, wake }.
async function boundedHold (bot, { isStopped = () => false, say = () => {}, deadlineMs = Number(process.env.BOUNDED_HOLD_MS || 90000) } = {}) {
  if (nightStuck(bot)) return { held: false, wake: 'nightStuck' } // eternal night: act, don't wait for a dawn that won't come
  const hut = listInfra('hut')[0] || null
  const bed = knownBed()
  const target = hut ? { x: hut.x + 2, y: hut.y + 1, z: hut.z + 2 } : bed
  if (target && bot.entity) {
    const d = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
    if (d > 4 && d < 250) {
      say("i'm starving and the land is bare - heading home to hole up")
      try { await walkStaged(bot, target.x, target.z, { isStopped, range: 6, timeoutMs: 180000 }) } catch {}
    }
    if (hut && !insideOwnStructure(bot) && Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z) <= 12) {
      try {
        const nav = require('./navigate.js')
        await nav.navigateTo(bot, new goals.GoalNear(target.x, target.y, target.z, 1), { timeoutMs: 20000, deadlineMs: 45000, isStopped, climb: false, budgets: { door: 2, pit: 1, water: 1, nudge: 1 }, label: 'famine-home' })
      } catch (e) { dbg('boundedHold: could not get indoors (' + e.message + ')') }
    }
  }
  const indoors = !!insideOwnStructure(bot)
  dbg('boundedHold: holding ' + (indoors ? 'inside my hut' : 'where i am') + ' (food=' + bot.food + ')')
  say('waiting it out at home - too weak to work safely')
  const dl = Date.now() + deadlineMs
  const near = (bot.entity && bot.entity.position) || target || bed
  let sealedPit = false
  while (Date.now() < dl && !isStopped()) {
    touchP('boundedHold') // S7 H7: a DECLARED hold with named wakes + a 90s deadline - the loop body IS the validity check
    if (foodCount(bot) > 0 || (bot.food ?? 0) > 4) return { held: true, wake: 'foodInPack' }
    // RE-CHECK THE BANK each pass (FORCE a fresh chest read): banked food a stale cache hid - or
    // food an operator/courier just restocked - is the fastest exit from the hold. Then eat it.
    try { const got = await require('./resources.js').ensureFood(bot, { near, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true }); if (got) await eatUp(bot) } catch (e) { dbg('boundedHold: bank re-check failed (' + e.message + ')') }
    if (foodCount(bot) > 0 || (bot.food ?? 0) > 4) return { held: true, wake: 'foodInPack' }
    // a fresh grave appeared -> release; the ladder's next pass runs R1 (free gear at arm's reach)
    try { const commands = require('./commands.js'); if (commands.worthwhileGrave && commands.worthwhileGrave()) return { held: true, wake: 'grave' } } catch {}
    // an animal wandered into range -> release the hold, the chain re-runs
    if (Object.values(bot.entities || {}).some(e => e && e.position && FOOD_ANIMALS.test((e.name || '').toLowerCase()) && e.position.distanceTo(bot.entity.position) <= 24)) return { held: true, wake: 'animal<=24' }
    // NIGHT -> sleep to dawn (a NAMED wake that provably occurs; starvation stops at half a heart
    // indoors so a slept night at low food survives). Bed within 8b -> sleep it. Otherwise, if
    // EXPOSED (not inside own structure), seal a pit ONCE (digInForNight carries its own dawn wake
    // + hazard bails; the 90s deadline governs only the un-sheltered portions - the I5 intent).
    if (isNight(bot) && bed && Math.hypot(bed.x - bot.entity.position.x, bed.z - bot.entity.position.z) <= 8) { try { await sleepInBedHere(bot, { say, isStopped }) } catch {} }
    else if (isNight(bot) && !insideOwnStructure(bot) && !sealedPit) { sealedPit = true; try { await digInForNight(bot, { isStopped, say }) } catch (e) { dbg('boundedHold: seal-pit failed (' + e.message + ')') } }
    await new Promise(r => setTimeout(r, 5000))
  }
  const fed = foodCount(bot) > 0
  return { held: fed, wake: fed ? 'foodInPack' : 'deadline' }
}

// Bounded water scout: 4 cardinal legs x expanding radius, scanning for surface water at
// each stop. Feeds BOTH fishing and the wheat farm (found ponds land in 'water' memory).
async function scoutForWater (bot, { isStopped = () => false, maxMs = 150000, rings } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const waterId = mcData.blocksByName.water.id
  const start = bot.entity.position.clone()
  const deadline = Date.now() + maxMs
  const surface = () => (bot.findBlocks({ matching: waterId, maxDistance: 48, count: 32 }) || [])
    .filter(p => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && AIRISH(a.name) })
  // FOOD_FLOOR F4: the escalated floor widens the rings by one (a caller passes [48,96,144]);
  // default is today's [48,96] byte-for-byte.
  for (const r of (rings && rings.length ? rings : [48, 96])) {
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      if (isStopped() || Date.now() > deadline) return []
      try { await walkStaged(bot, start.x + dx * r, start.z + dz * r, { isStopped, range: 10, timeoutMs: 45000 }) } catch {}
      const w = surface()
      if (w.length) { rememberInfra('water', { x: w[0].x, y: w[0].y, z: w[0].z }); dbg('  water scout: surface water at ' + w[0].x + ',' + w[0].z); return w }
    }
  }
  dbg('  water scout: no surface water within ~96 blocks')
  return []
}

// ---- SCAFFOLD TEARDOWN: the pathfinder pillars up to tall canopies and abandons the
// dirt towers (operator: "a massive mess"). The patch layer remembers every self-placed
// block; after a harvest, ride the tower back down and pocket the dirt.
async function cleanupScaffold (bot, around, { isStopped = () => false } = {}) {
  // Registry-driven (bot/scaffold.js) + the legacy trail for towers placed before the
  // registry existed. Away from builds only (alsoTrail sweeps ALL own placements).
  const removed = await scaffold.teardown(bot, around, { isStopped, radius: 10, max: 24, alsoTrail: true })
  if (removed) await collectDrops(bot, 6)
  return removed
}

// ---- INVENTORY HYGIENE: mob-drop junk (spider eyes, string, flint...) quietly eats the
// slots the build materials need (seen live: ~8 slots of trash mid-castle-provision).
// Toss what has no use; KEEP bones (they become bone meal for the tree farm) and a small
// rotten-flesh famine reserve (the risky-food ranking eats it only when starving).
const JUNK_RE = /^(rotten_flesh|spider_eye|poisonous_potato|flint|feather|egg|beetroot_seeds|melon_seeds|pumpkin_seeds|arrow|gunpowder|phantom_membrane|rabbit_hide|rabbit_foot|ink_sac|glow_ink_sac|slime_ball|fermented_spider_eye)$/ // string STAYS (fishing rods!); wheat_seeds stay (the farm)
async function dumpJunk (bot) {
  let tossed = 0
  for (const it of (bot.inventory ? bot.inventory.items() : [])) {
    if (!JUNK_RE.test(it.name)) continue
    const n = it.name === 'rotten_flesh' ? it.count - 3 : it.count
    if (n <= 0) continue
    try { await bot.toss(it.type, null, n); tossed += n; await new Promise(r => setTimeout(r, 250)) } catch {}
  }
  // INV_TOOLJUNK: durability-aware TOOL pass - toss worn/obsolete tools, NEVER the last working
  // of a kind (toolIsJunk enforces it). This makes every dumpJunk caller durability-aware for free.
  if (process.env.INV_DISCIPLINE !== '0' && process.env.INV_TOOLJUNK !== '0') {
    try {
      const maintain = require('./maintain.js')
      const junkMinUses = Number(process.env.INV_JUNK_MIN_USES || 10)
      const KIND_RE = [/_pickaxe$/, /_axe$/, /_sword$/, /_shovel$/, /_hoe$/]
      for (const re of KIND_RE) {
        const units = (bot.inventory ? bot.inventory.items() : []).filter(i => re.test(i.name))
          .map(i => ({ item: i, name: i.name, usesLeft: mining.toolUsesLeft(i.name, i.durabilityUsed || 0) }))
        if (units.length <= 1) continue // never risk the last of a kind
        const working = units.filter(u => u.usesLeft >= junkMinUses)
        const bestWorkingTier = working.reduce((t, u) => Math.max(t, maintain.toolTier(u.name)), 0)
        for (const u of units) {
          const workingSameKind = working.filter(w => w.item !== u.item).length
          if (!maintain.toolIsJunk({ name: u.name, usesLeft: u.usesLeft }, { workingSameKind, bestSameKindTier: bestWorkingTier, junkMinUses })) continue
          // belt-and-braces I2: never toss the only working unit of a kind
          if (u.usesLeft >= junkMinUses && working.length <= 1) continue
          try { await bot.toss(u.item.type, null, u.item.count); tossed += u.item.count; await new Promise(r => setTimeout(r, 250)) } catch {}
        }
      }
    } catch {}
  }
  if (tossed) dbg('  dumped ' + tossed + ' junk items (slots free: ' + (bot.inventory ? bot.inventory.emptySlotCount() : '?') + ')')
  return tossed
}

// HOLD until the night is survived: a nightRest attempt returns false when another flow
// already holds the shelter lock (the idle reflex sealed a pit while a resume was booting)
// - and callers treated false as "carry on", walking straight back into the dark (died
// that way at 350,64,36). This BLOCKS until day/armored/stopped, re-attempting rest
// whenever nothing else is resting.
async function restUntilSafe (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const maxFails = opts.maxShelterFails || 4
  let waited = false; let fails = 0
  while ((isNight(bot) || shelterNeeded(bot)) && underArmored(bot) && !nightStuck(bot) && !isStopped() && bot.entity) {
    // FROZEN/ETERNAL NIGHT: stop HOLDING for a dawn that won't come - hand back so the job
    // resumes careful night work (it re-arms first via gearup). Otherwise this loop pinned
    // any job that hit night on a doDaylightCycle-off server for the whole session (live).
    // HOLDING must never mean holding UNDERWATER - the 4s waits between failed rest
    // attempts are exactly where the bot drowned (test server, in its flooded basin)
    if (inWaterNow(bot)) { try { await ensureAshore(bot, isStopped) } catch {} }
    if (!isResting()) {
      let ok = false
      try { ok = await nightRest(bot, opts) } catch {}
      if (ok) { waited = true; fails = 0; continue }
      // nightRest FAILED to shelter (couldn't dig even after relocating, and no reachable
      // bed). Do NOT spin in place forever (the live 4s NO-OP loop): after maxFails, hand
      // back HONESTLY so the CALLER relocates the whole job somewhere it CAN shelter, rather
      // than re-digging the same wet spot. Bounded progress beats an unbounded hold.
      if (++fails >= maxFails) { dbg('restUntilSafe: could not shelter after ' + fails + ' tries (no diggable dry ground / no bed reachable) - handing back so the caller can relocate'); return false }
    }
    if (!waited) { waited = true; dbg('restUntilSafe: HOLDING for the night (another rest active or rest failed - not working in the dark)') }
    await new Promise(r => setTimeout(r, 4000))
  }
  return true
}

// LOW-HP SHELTER-AND-HOLD: a hurt bot that is still exposed (dark night or a mob in range) is
// grinding to death (live: armored far-gather 18.7->11.7->0.77->dead). Latched like secureFood/
// nightRest so the reflex and the inline job-loop entry are mutually exclusive (no double-shelter).
// Reuses ONLY existing primitives: eat from the pack to restore regen fuel, dig-in/sleep via
// nightRest when it's night or a hostile is close, then hold-and-watch until hp recovers. Bounded
// (3 min), and BAILS honestly when it can't recover here (frozen night, out of food, still taking
// damage) so the food chain / flee / defend that DO own those cases take over.
let _recoveringHp = false
function isRecoveringHp () { return _recoveringHp }
async function recoverHp (bot, opts = {}) {
  const isStopped = () => _survStop || (opts.isStopped ? opts.isStopped() : false) // S7: fold the watchdog latch into the abort poll
  const say = opts.say || (() => {})
  const resumeHp = opts.resumeHp != null ? opts.resumeHp : 16
  if (_recoveringHp) return false
  _recoveringHp = true
  _survStop = false; touchP('recoverHp') // S7 H5c: per-dispatch latch clear + zero-idle at t0
  try {
    try { bot.pathfinder.setGoal(null) } catch {}
    // regen needs food>=18 - eat FIRST so the hold below actually heals.
    await eatFromPackToComfortable(bot, isStopped)
    // Get behind cover if it's dark or a mob is near. bedRange 32: sleep in a nearby bed if home
    // is right there, but don't trek 200b through the dark - pit where we stand past that.
    if (isNight(bot) || nearHostile(bot, 16)) { try { await nightRest(bot, { isStopped, say, bedRange: 32 }) } catch {} }
    await eatFromPackToComfortable(bot, isStopped)
    const dl = Date.now() + 180000
    const hp0 = bot.health ?? 20
    let hpPrev = bot.health ?? 20 // S7 H6: a rising hp between 2s passes is the world verifiably healing the bot
    while (!isStopped() && Date.now() < dl) {
      const hp = bot.health ?? 20
      if (hp > hpPrev) touchP('regen') // without this, a legit heal-hold at hp<=6 would trip the 20s/40s crisis window
      hpPrev = hp
      if (hp >= resumeHp) return true
      if (nightStuck(bot)) return false                              // frozen night: hand back, act (re-arm, don't hide)
      if ((bot.food ?? 20) < 18 && !hasFood(bot)) return false       // can't regen with no food - the food chain owns acquisition
      if (hp < hp0 - 2) return false                                 // still taking damage while 'recovering' - release to flee/defend
      await new Promise(r => setTimeout(r, 2000))
    }
    return (bot.health ?? 20) >= resumeHp
  } finally { _recoveringHp = false }
}

// RECOVERY LADDER (S5): the rung->executor map. Every action string that recoveryPlan emits maps
// to an EXISTING, bounded, live-verified executor (no new dig/place/nav paths). `commands` is a
// LAZY require (cycle-safe). `o` = { isStopped, say, home, dbg }. Actions with no executor
// (trekOrchard - a WOOD grove, not a food producer) are simply absent -> the ladder skips them.
const RUNG_EXECUTORS = {
  // R0: eat what we carry, then wear every carried piece (bare `wear` = wantAll; never downgrades)
  'eatPack+wearFromPack': async (bot, o) => { await eatUp(bot); try { await require('./commands.js').handle(bot, 'wear') } catch (e) { o.dbg('(ladder) wear failed: ' + e.message) } },
  // R1: fetch the nearest worthwhile grave (recover has its OWN night-shelter-first gate)
  'recoverGrave': async (bot, o) => { await require('./commands.js').handle(bot, 'recover') },
  // R2: get home, eat the cache (forceFresh - the stale-cache fix), cook, eat, bake surplus wheat
  'gotoHome+ensureFood(forceFresh)+cook+eat': async (bot, o) => {
    const home = o.home
    if (home && bot.entity) { try { await walkStaged(bot, home.x, home.z, { isStopped: o.isStopped, range: 6, timeoutMs: 180000 }) } catch (e) { o.dbg('(ladder) R2 home trek failed: ' + e.message) } }
    try { await require('./resources.js').ensureFood(bot, { near: home, threshold: 20, minPack: 1, maxDist: 64, forceFresh: true }) } catch (e) { o.dbg('(ladder) R2 ensureFood failed: ' + e.message) }
    try { if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped: o.isStopped }) } catch {}
    await eatUp(bot)
    if (countItem(bot, 'wheat') >= 3) { try { await bakeBreadFromWheat(bot, { isStopped: o.isStopped, home }); await eatUp(bot) } catch (e) { o.dbg('(ladder) R2 bake failed: ' + e.message) } }
  },
  // R1.5 (#41 RESILIENT_RECOVERY): re-arm from the banked spare set. Walk HOME, withdraw a spare set
  // (fill each bare armor slot + a pick + a sword, best material available), equip the armor (#19).
  // WALK + chest-window + equip ONLY - no dig/place path (anti-grief untouched). Decouples re-arm
  // from a lost/lethal grave (RC-C).
  'rearmFromBank': async (bot, o) => {
    const home = o.home
    const res = require('./resources.js')
    if (home && bot.entity) { try { await walkStaged(bot, home.x, home.z, { isStopped: o.isStopped, range: 6, timeoutMs: 180000 }) } catch (e) { o.dbg('(ladder) R1.5 home trek failed: ' + e.message) } }
    if (o.isStopped()) return
    let totals = {}
    try { totals = await res.totalCounts(bot, { near: home, maxDist: 64 }) } catch {}
    const MAT = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']
    const bestArmorName = (slotRe) => { for (const m of MAT) { const nm = Object.keys(totals).find(n => n.startsWith(m + '_') && slotRe.test(n) && totals[n] > 0); if (nm) return nm } return null }
    for (const re of [/helmet$/, /chestplate$/, /leggings$/, /boots$/]) {
      if (o.isStopped()) break
      const nm = bestArmorName(re)
      if (nm) { try { await res.withdrawItems(bot, nm, 1, { near: home, maxDist: 64 }) } catch (e) { o.dbg('(ladder) rearm withdraw ' + nm + ' failed: ' + e.message) } }
    }
    const TOOLMAT = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
    const bestTool = (suffix) => { for (const m of TOOLMAT) { const nm = m + '_' + suffix; if (totals[nm] > 0) return nm } return null }
    for (const suffix of ['pickaxe', 'sword']) {
      if (o.isStopped()) break
      const nm = bestTool(suffix)
      if (nm) { try { await res.withdrawItems(bot, nm, 1, { near: home, maxDist: 64 }) } catch (e) { o.dbg('(ladder) rearm withdraw ' + nm + ' failed: ' + e.message) } }
    }
    try { const wore = await require('./commands.js').equipCarriedArmor(bot); if (wore && wore.length) o.dbg('(ladder) rearm equipped ' + wore.join(',')) } catch (e) { o.dbg('(ladder) rearm equip failed: ' + e.message) }
  },
  // R2 night: sleep to dawn (self-releases at morning) / dig a sealed pit to dawn
  'sleepInBed': async (bot, o) => { await nightRest(bot, { isStopped: o.isStopped, say: o.say }) },
  'digInForNight': async (bot, o) => { await digInForNight(bot, { isStopped: o.isStopped, say: o.say }) },
  // R3: tend/harvest the owned farm (hoe-aware), eat what came off it. courierHome = S6, logged-skip.
  'trekFarm+tend+harvest+courierHome': async (bot, o) => {
    await tendWheatFarm(bot, { isStopped: o.isStopped, say: o.say }); await eatUp(bot)
    // S6: courier the food surplus home so a famine recovery restocks the pantry on its way out
    // (the §4.2-step-4 promise). Behind MAINTAIN; MAINTAIN=0 keeps the old logged-skip.
    if (process.env.MAINTAIN !== '0') { try { await courierFoodToBank(bot, { isStopped: o.isStopped, say: o.say }) } catch (e) { o.dbg('(ladder) courier failed: ' + e.message) } }
    else o.dbg('(ladder) courier deferred (MAINTAIN=0)')
  },
  // R4: acquire NEW supply (hunt->fish->scout). canHold:false - the ladder owns holding (R5).
  'secureFood(hunt->fish->scout)': async (bot, o) => { await secureFood(bot, { home: o.home, canHold: false, isStopped: o.isStopped, say: o.say }) },
  // R5: the one bounded hold (bed-sleep -> hut -> pit; its own preference order covers both variants)
  'boundedHold:sleep': async (bot, o) => { await boundedHold(bot, { isStopped: o.isStopped, say: o.say }) },
  'boundedHold:sealPit': async (bot, o) => { await boundedHold(bot, { isStopped: o.isStopped, say: o.say }) },
  // R5 eternal night: no hold - the no-op just re-loops so R3/R4 run by night (rungFeasible lifts
  // the night gates under nightStuck; the executors carry their own shelter discipline).
  'rerunLadderByNight': async (bot, o) => { o.dbg('(ladder) rerun by night - re-planning') }
}

let _recoveringDegraded = false
function isRecoveringDegraded () { return _recoveringDegraded }
// #41 P4: is post-death recovery complete enough to let the build drive again? Builds the snapshot
// and asks scheduler.recoveryReady; CLEARS the P0 latch when ready (so resumeBuild proceeds). A hard
// RECOVERY_MAX_MS ceiling on how long the latch has been held guarantees the build is never trapped
// forever (P4 "never hides forever"), and any error fails OPEN (ready) - a snapshot glitch must not
// stall a saved build. RESILIENT_RECOVERY=0 -> always ready (the latch is inert).
async function recoveryReadyNow (bot) {
  if (process.env.RESILIENT_RECOVERY === '0') return true
  const commands = require('./commands.js')
  try {
    const heldMs = commands.postDeathRecoveryHeldMs ? commands.postDeathRecoveryHeldMs() : 0
    if (heldMs > Number(process.env.RECOVERY_MAX_MS || 900000)) { try { commands.clearPostDeathRecovery() } catch {} return true }
  } catch {}
  let ready = true
  try { ready = scheduler.recoveryReady(await schedulerState(bot)).ready } catch { ready = true }
  if (ready) { try { commands.clearPostDeathRecovery() } catch {} }
  return ready
}
// RECOVER FROM DEGRADED (S5): the survival-class orchestrator that EXECUTES scheduler.recoveryPlan.
// Loops { s = schedulerState; exit on ladderDone/isStopped/deadline; plan = recoveryPlan(s); take
// the FIRST rung that is rungFeasible + has an executor + this run hasn't tried; run it; mark tried
// on BOTH success and failure (once per action per run => <=8 executions => termination); re-loop -
// each rung changes the world, so we re-snapshot + re-plan }. Bounded by RECOVERY_MAX_MS (default
// 15 min), the once-per-action rule, and isStopped. No distance gates (recoveryPlan owns
// sequencing), no new dig/place, no buildAbort/resumeJob touching. Returns { done, rungs, reason }.
async function recoverFromDegraded (bot, { isStopped = () => false, say = () => {}, maxMs = Number(process.env.RECOVERY_MAX_MS || 900000), reason } = {}) {
  if (_recoveringDegraded) return { done: false, rungs: [], reason: 'busy' }
  _recoveringDegraded = true
  _survStop = false; touchP('recoverFromDegraded') // S7 H5c: per-dispatch latch clear + zero-idle at t0
  const rungs = []
  const tried = new Set()
  const deadline = Date.now() + maxMs
  const home = (() => { try { return hutAnchor() || knownBed() || null } catch { return null } })()
  try {
    while (true) {
      const s = await schedulerState(bot)
      // P4: exit on recoveryReady (hp>=18, food>=14, 4 armor, pick&&sword; best-affordable escape) -
      // NOT the naked-tolerant ladderDone (RC-D). Clearing the exit clears the P0 latch so the build
      // may resume. RESILIENT_RECOVERY=0 restores ladderDone byte-for-byte.
      if (process.env.RESILIENT_RECOVERY !== '0') {
        const rr = scheduler.recoveryReady(s)
        if (rr.ready) { try { require('./commands.js').clearPostDeathRecovery() } catch {} return { done: true, rungs, reason: reason || (rr.maxCaution ? 'recovered (best-affordable)' : 'recovered'), maxCaution: rr.maxCaution } }
      } else if (scheduler.ladderDone(s)) return { done: true, rungs, reason: reason || 'recovered' }
      if (isStopped() || _survStop) return { done: false, rungs, reason: 'stopped' } // S7: watchdog fail-job lever folded in
      if (Date.now() > deadline) return { done: false, rungs, reason: 'deadline' }
      const plan = scheduler.recoveryPlan(s)
      let chosen = null
      for (const r of plan) {
        if (!scheduler.rungFeasible(r, s)) continue
        if (tried.has(r.action)) continue
        if (!RUNG_EXECUTORS[r.action]) continue // no executor (e.g. trekOrchard) - skip, never binds
        chosen = r; break
      }
      // recoveryPlan is TOTAL (>=1 rung, R5 always appended); if every feasible rung is tried,
      // hand back honestly - the tick re-dispatches after its 60s cooldown (the outer retry).
      if (!chosen) return { done: false, rungs, reason: 'all rungs tried' }
      tried.add(chosen.action)
      const label = chosen.rung + ':' + chosen.action
      dbg('(ladder) ' + label + ' -> executing')
      // #40 F4.1: on an OUTBOUND rung (trek/tend/secureFood) compose isStopped with an hp-abort so
      // a bot burned to <=6 hp mid-trek/tend/seed-gather BAILS to the next rung (-> R5 bounded hold)
      // instead of farming grass at 1 hp for minutes. Non-outbound rungs (eat/grave/shelter/hold)
      // keep plain isStopped. FOOD_SURVIVAL=0 -> outboundRungAdmissible is always true (today).
      const outbound = process.env.FOOD_SURVIVAL !== '0' && scheduler.OUTBOUND_RE.test(chosen.action || '')
      // FOOD_FLOOR (default on): the hp-abort must NOT forbid the ONE bounded acquisition that ends
      // the starvation (secureFood->fishing) - so at food<=floorFood admit the SECUREFOOD rung
      // regardless of hp. RUNG-AWARE guardrail: pass bot.food ONLY for the secureFood rung; the
      // long trekFarm/trekOrchard trek gets {} -> today's pure hp<=6 abort (the §5 invariant: the
      // farm trek still aborts, only the fishing leg is admitted). FOOD_FLOOR=0 -> {} for all.
      const foodAcqRung = process.env.FOOD_FLOOR !== '0' && /^secureFood/.test(chosen.action || '')
      const rungStopped = outbound
        ? () => isStopped() || !foodSec.outboundRungAdmissible(bot.health, foodAcqRung ? { food: bot.food } : {})
        : isStopped
      try { await RUNG_EXECUTORS[chosen.action](bot, { isStopped: rungStopped, say, home, dbg }) }
      catch (e) { dbg('(ladder) ' + label + ' failed: ' + e.message) }
      rungs.push(label)
      touchP('ladderRung') // S7 H5a: a bounded, live-verified rung completed
    }
  } finally { _recoveringDegraded = false }
}

// ==== S6: PROACTIVE MAINTENANCE PASS (§4.2/§5) ===========================================
// The single maintain-class job. A thin, bounded composition of EXISTING routines keyed off
// maintain.needs(snapshot): harvest orchard, tend/expand the farm, cook+bake, COURIER the food
// surplus into the bank, SAFEKEEP spare kit, then top up gear/tools/torches + repair home. It
// NEVER preempts progress/build (rank 1, tick admission, command-path stopMaintenance) and bails
// on any survival need. MAINTAIN=0 -> the tick never dispatches this (defer-note restored).
let _maintaining = false
let _maintStop = false
function isMaintaining () { return _maintaining }
function stopMaintenance () { _maintStop = true } // the running pass unwinds at its next isStopped poll
function _setMaintaining (v) { _maintaining = !!v } // test-only seam (schedstatetest activeJob synthesis)
const _maintState = {} // module-local per-step cadence (stepDue); NOT persisted - a restart re-allows all steps (every step is a no-op when its buffer is fine)

// Resolve the hut bank chest exactly as consolidateBank does: the bed-adjacent chest inside the
// hut, else the nearest verified chest <=16b of the hut anchor. null (log+skip) if no bank -
// making one is maintainHome's job (step 9). Returns the chest cell {x,y,z} or null.
function resolveBankCell (bot) {
  try {
    const bank = listInfra('chest', bot).find(e => ownHutAt({ x: e.x, y: e.y, z: e.z }))
    if (bank) return { x: bank.x, y: bank.y, z: bank.z }
    const hut = hutAnchor()
    if (hut) { const v = require('./resources.js').verifiedChests(bot, hut, 16)[0]; if (v) return { x: v.x, y: v.y, z: v.z } }
  } catch {}
  return null
}

// THE COURIER (§5.2): deposit the pack's food surplus into the hut bank so R2's raid-the-cache
// always works. Reuses depositMaterials' open/deposit/close body via the explicit-list mode; the
// pure maintain.courierPlan decides what moves. Refreshes the chest cache so bankFoodPts updates
// next tick. Returns how many food items were banked.
async function courierFoodToBank (bot, { isStopped = () => false, say = () => {} } = {}) {
  const res = require('./resources.js')
  const maintain = require('./maintain.js')
  const cell = resolveBankCell(bot)
  if (!cell) { dbg('  courier: no hut bank chest - skipping (home-repair owns making one)'); return 0 }
  const hut = hutAnchor()
  const anchor = hut || cell
  if (bot.entity && bot.entity.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) > 6) {
    try { await walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {}
  }
  if (isStopped()) return 0
  const md = require('minecraft-data')(bot.version); const foods = (md && md.foodsByName) || {}
  const packItems = []
  for (const i of (bot.inventory ? bot.inventory.items() : [])) {
    if (foods[i.name]) packItems.push({ name: i.name, count: i.count, foodPoints: foods[i.name].foodPoints || 0, tier: foodSec.foodTier(i.name) })
  }
  // BANK-only food points (a real read - we're standing at the chest): totalCounts would fold in
  // the pack surplus we're about to deposit and wrongly read the pantry as full.
  let bankFoodPts = 0; let bankRods = 0
  try { const counts = await res.readChest(bot, cell); for (const [n, c] of Object.entries(counts || {})) { if (foods[n]) bankFoodPts += (foods[n].foodPoints || 0) * c; if (n === 'fishing_rod') bankRods += c } } catch {}
  const plan = maintain.courierPlan(packItems, bankFoodPts, {})
  // FOOD_FLOOR F3: leave a spare fishing_rod in the reserve alongside the food, so the post-death
  // naked bot's floor can WITHDRAW a rod (F2) instead of scrambling for 0 string. Ships only a
  // TRUE dupe (keeps 1 rod on the bot); rodReserveTopUp bounds it. FOOD_FLOOR=0 -> no rod line.
  // ROD_SUPPLY (M4): also seed the reserve on the MAINTENANCE courier pass (this same call) so the
  // moment the bot EVER holds a spare rod (e.g. a fresh self-craft) it banks it - the reserve then
  // survives death and F2 pays out on every later crisis, independent of a successful fish trip.
  if (process.env.FOOD_FLOOR !== '0' || process.env.ROD_SUPPLY === '1') {
    const packRods = countItem(bot, 'fishing_rod')
    const shipRods = maintain.rodReserveTopUp(bankRods, packRods)
    if (shipRods > 0) plan.push({ name: 'fishing_rod', count: shipRods })
  }
  if (!plan.length) { dbg('  courier: pack keep met / pantry stocked (' + bankFoodPts + ' pts) - nothing to deposit'); return 0 }
  const blk = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
  if (!blk || !/chest/.test(blk.name)) { dbg('  courier: bank cell no longer a chest'); return 0 }
  let n = 0
  try { n = await depositMaterials(bot, blk, { deposits: plan }) } catch (e) { dbg('  courier: deposit failed (' + e.message + ')') }
  try { await res.readChest(bot, cell) } catch {} // refresh cache so bankFoodPts/maintainNeeded update next tick
  if (n) { dbg('  courier: banked ' + n + ' food item(s) into the pantry'); say('stocking the pantry - ' + n + ' food in the chest') }
  return n
}

// SAFEKEEPING (§5.3, FIRM): stash spare tools + build-material surplus into the bank so a death
// mid-excursion costs only the bounded loadout. Same bank + deposit mode as the courier; the pure
// maintain.safekeepPlan (never the last working tool of a kind) decides. REFUSES during build
// placement (belt-and-suspenders; trigger 3 lives in planner). Returns how many items were stashed.
async function safekeepSweep (bot, { isStopped = () => false, say = () => {}, duringBuildOk = false } = {}) {
  if (process.env.MAINT_SAFEKEEP === '0') return 0
  try {
    const commands = require('./commands.js')
    // INV_SHED: a mere persistedResume() (the castle resume persists essentially always since
    // commit 4a4638d) no longer blocks the sweep - only ACTIVE placement does (the activityInfo
    // guard below stays, I3). Flag off => today's saved-build guard.
    const invShed = process.env.INV_DISCIPLINE !== '0' && process.env.INV_SHED !== '0'
    if (!invShed && !duringBuildOk && commands.persistedResume && commands.persistedResume()) { dbg('  safekeep: a saved build exists - not sweeping'); return 0 }
    const a = commands.activityInfo && commands.activityInfo()
    if (a && a.name && /build|schem|wall|tower|house|castle/i.test(a.name)) { dbg('  safekeep: build placement running - not sweeping'); return 0 }
  } catch {}
  const res = require('./resources.js')
  const maintain = require('./maintain.js')
  const cell = resolveBankCell(bot)
  if (!cell) { dbg('  safekeep: no hut bank chest - skipping'); return 0 }
  const hut = hutAnchor()
  const anchor = hut || cell
  if (bot.entity && bot.entity.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) > 6) {
    try { await walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {}
  }
  if (isStopped()) return 0
  // INV_TOOLJUNK: toss worn/obsolete tools FIRST so safekeep only ever BANKS good surplus.
  if (process.env.INV_DISCIPLINE !== '0' && process.env.INV_TOOLJUNK !== '0') { try { await dumpJunk(bot) } catch {} }
  // usesLeft per tool. INV_SHED uses the GENERAL helper (covers wooden picks too, so safekeepPlan
  // ranks/ships them correctly); flag off => today's miningPicks (stone+ only).
  const invShedUses = process.env.INV_DISCIPLINE !== '0' && process.env.INV_SHED !== '0'
  const usesByItem = new Map()
  if (invShedUses) {
    for (const it of (bot.inventory ? bot.inventory.items() : [])) {
      if (/_(pickaxe|axe|sword|shovel|hoe)$/.test(it.name)) usesByItem.set(it, mining.toolUsesLeft(it.name, it.durabilityUsed || 0))
    }
  } else {
    for (const p of miningPicks(bot)) usesByItem.set(p.item, p.usesLeft)
  }
  const packItems = (bot.inventory ? bot.inventory.items() : []).map(i => ({ name: i.name, count: i.count, usesLeft: usesByItem.has(i) ? usesByItem.get(i) : undefined }))
  const plan = maintain.safekeepPlan(packItems, {})
  if (!plan.length) { dbg('  safekeep: nothing surplus to stash'); return 0 }
  const blk = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
  if (!blk || !/chest/.test(blk.name)) { dbg('  safekeep: bank cell no longer a chest'); return 0 }
  let n = 0
  try { n = await depositMaterials(bot, blk, { deposits: plan }) } catch (e) { dbg('  safekeep: deposit failed (' + e.message + ')') }
  try { await res.readChest(bot, cell) } catch {}
  if (n) { dbg('  safekeep: stashed ' + n + ' surplus item(s) - departing light'); say('stashing spare kit in the bank before i head out') }
  return n
}

// SPARE-KIT COURIER (#41 RESILIENT_RECOVERY, §P2): deposit a SURPLUS/dupe spare set (4 armor + pick
// + sword) into the hut bank so a post-death respawn can withdraw + re-arm (rearmFromBank) WITHOUT
// depending on a lost/lethal grave. Same bank + deposit machinery as the food courier; the pure
// maintain.spareKitCourierPlan (never strips the bot's only kit) decides what moves. Returns how
// many spare items were banked. SPAREKIT=0 / RESILIENT_RECOVERY=0 -> no-op.
async function spareKitToBank (bot, { isStopped = () => false, say = () => {} } = {}) {
  if (process.env.RESILIENT_RECOVERY === '0' || process.env.SPAREKIT === '0') return 0
  const res = require('./resources.js')
  const maintain = require('./maintain.js')
  const cell = resolveBankCell(bot)
  if (!cell) { dbg('  spareKit: no hut bank chest - skipping'); return 0 }
  const hut = hutAnchor()
  const anchor = hut || cell
  if (bot.entity && bot.entity.position.distanceTo(new Vec3(anchor.x, anchor.y, anchor.z)) > 6) {
    try { await walkStaged(bot, anchor.x, anchor.z, { isStopped, range: 4, timeoutMs: 120000 }) } catch {}
  }
  if (isStopped()) return 0
  // what the bank already holds toward the spare (a REAL read - we're standing at the chest).
  const bankKit = { armorPieces: 0, hasPick: false, hasSword: false }
  try {
    const counts = await res.readChest(bot, cell)
    bankKit.armorPieces = Object.entries(counts || {}).filter(([n]) => /_(helmet|chestplate|leggings|boots)$/.test(n)).reduce((a, [, c]) => a + c, 0)
    bankKit.hasPick = Object.keys(counts || {}).some(n => /_pickaxe$/.test(n))
    bankKit.hasSword = Object.keys(counts || {}).some(n => /_sword$/.test(n))
  } catch {}
  // pack items with usesLeft for tools so the plan keeps the best WORKING pick/sword on the bot.
  const usesByItem = new Map()
  for (const it of (bot.inventory ? bot.inventory.items() : [])) { if (/_(pickaxe|sword)$/.test(it.name)) usesByItem.set(it, mining.toolUsesLeft(it.name, it.durabilityUsed || 0)) }
  const packItems = (bot.inventory ? bot.inventory.items() : []).map(i => ({ name: i.name, count: i.count, usesLeft: usesByItem.has(i) ? usesByItem.get(i) : undefined }))
  const plan = maintain.spareKitCourierPlan(packItems, bankKit, {})
  if (!plan.length) { dbg('  spareKit: bank spare complete / no dupe to donate'); return 0 }
  const blk = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
  if (!blk || !/chest/.test(blk.name)) { dbg('  spareKit: bank cell no longer a chest'); return 0 }
  let n = 0
  try { n = await depositMaterials(bot, blk, { deposits: plan }) } catch (e) { dbg('  spareKit: deposit failed (' + e.message + ')') }
  try { await res.readChest(bot, cell) } catch {}
  if (n) { dbg('  spareKit: banked ' + n + ' spare-kit item(s) - a re-arm floor for the next death'); say('stashing a spare kit in the bank - re-arm insurance') }
  return n
}

// maintenancePass(bot, opts) - the orchestrator. opts: { say, nightIndoorOnly, isStopped }.
// Returns { ok, steps: [label...], reason } for the tick's one-line note.
async function maintenancePass (bot, opts = {}) {
  if (_maintaining) return { ok: false, steps: [], reason: 'busy' }
  _maintaining = true; _maintStop = false
  touchP('maintenancePass') // S7 H5c: zero-idle at t0
  const say = opts.say || (() => {})
  const nightIndoorOnly = !!opts.nightIndoorOnly
  const opportunistic = !!opts.opportunistic // at-hut window during the build era: home-anchored steps only, and the safekeep build-guard is lifted (the caller paused the build and stands at the bank)
  const steps = []
  const stepDone = (label) => { steps[steps.length] = label; touchP('maintStep') } // S7 H5b: each completed chore sub-step is verified progress (steps[...]= avoids a literal .push so the sweep below leaves this line alone)
  const deadline = Date.now() + Number(process.env.MAINT_PASS_MAX_MS || 600000)
  const crisisFood = Number(process.env.SCHED_CRISIS_FOOD || 6)
  // isStopped: crisis-grade survival probe (unwinds within one executor poll) + the deadline.
  const isStopped = () => {
    if (_maintStop || (opts.isStopped && opts.isStopped()) || Date.now() > deadline) return true
    try { return survivalNeed(bot, { foodThreshold: crisisFood }) != null } catch { return false }
  }
  // between steps: the fuller survivalNeed (default threshold 14) - bail honestly to the tick.
  const between = () => { if (isStopped()) return true; try { return survivalNeed(bot) != null } catch { return false } }
  const maintain = require('./maintain.js')
  const home = (() => { try { return hutAnchor() || knownBed() || null } catch { return null } })()
  const atHome = () => { try { return !!(home && bot.entity && Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z) <= 24) } catch { return false } }
  const day = () => !isNight(bot)
  const due = (key, ms) => maintain.stepDue(_maintState, key, ms, Date.now()).due
  try {
    let snap = {}
    try { snap = await schedulerState(bot) } catch {}
    // the needs list, once (cheap, pure), so each step gate reads the same authority as the tick.
    let needList = []
    try { needList = maintain.needs(snap) } catch {}
    const has = k => needList.some(x => x.key === k)
    const farmUnderTarget = () => { try { const wf = loadWorldMem().wheatFarm; return !!(wf && (wf.cells || []).length > 0 && (wf.cells || []).length < WHEAT_FARM_TARGET && !wf.maxed) } catch { return false } }
    const orchardReady = () => { try { const o = loadWorldMem().orchard; return !!(o && o.harvestReadyAt != null && Date.now() >= o.harvestReadyAt) } catch { return false } }
    const woodLow = async () => { try { const t = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: home, maxDist: 64 }); let n = 0; for (const [k, v] of Object.entries(t)) if (/_planks$|_log$/.test(k)) n += v; return n < 32 } catch { return false } }
    const packTarget = Number(process.env.MAINT_PACKFOOD_TARGET || 24)
    // BREAD_ENGINE: one cheap cachedOnly home-food read per pass (never walks), reused by the
    // STEP 4 bake gate and the STEP 5 reserve observability line. Off = legacy (no read, no gate change).
    const breadEngine = process.env.BREAD_ENGINE !== '0'
    const bankTargetPts = Number(process.env.MAINT_BANKFOOD_TARGET || (breadEngine ? Number(process.env.BREAD_BANK_TARGET || 80) : 40))
    let cachedBankWheat = 0, cachedBankFoodPts = 0
    if (breadEngine) {
      try {
        const t = await require('./resources.js').totalCounts(bot, { cachedOnly: true, near: home, maxDist: 64 })
        const mdM = require('minecraft-data')(bot.version); const foodsM = (mdM && mdM.foodsByName) || {}
        cachedBankWheat = t.wheat || 0
        for (const [n, c] of Object.entries(t)) if (foodsM[n]) cachedBankFoodPts += (foodsM[n].foodPoints || 0) * c
      } catch {}
    }

    // STEP 0: safekeep-out - stash spare kit BEFORE any outbound trek leaves the hut.
    if (process.env.MAINT_SAFEKEEP !== '0' && !nightIndoorOnly && atHome()) {
      const outboundDue = (process.env.FOOD_SUPPLY !== '0' && (has('bankFood') || has('packFood') || farmUnderTarget())) ||
                          orchardReady() ||
                          (process.env.GEAR_REFLEX !== '0' && has('armor'))
      if (outboundDue && due('safekeep', 600000)) {
        try { const n = await safekeepSweep(bot, { isStopped, say, duringBuildOk: opportunistic }); if (n) stepDone('safekeep-out(' + n + ')') } catch (e) { dbg('  maint: safekeep-out failed (' + e.message + ')') }
      }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 1: packFood - top the carried buffer up (R2 pattern) + cook/bake + eat.
    if (process.env.FOOD_TOPUP !== '0' && has('packFood') && due('packFood', 600000)) {
      try {
        await require('./resources.js').ensureFood(bot, { near: home, threshold: 20, minPack: 1, maxDist: 64 })
        if (Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0)) await cookRawMeat(bot, { isStopped })
        await bakeBreadFromWheat(bot, { isStopped, home })
        await eatUp(bot)
        stepDone('packFood')
      } catch (e) { dbg('  maint: packFood failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 2: farm - tend + under-target expansion (with the seed top-up). Daylight only.
    if (process.env.FOOD_SUPPLY !== '0' && !nightIndoorOnly && day() && (has('bankFood') || has('packFood') || farmUnderTarget()) && (!opportunistic || (snap.farm && snap.farm.exists && snap.farm.dist != null && snap.farm.dist <= Number(process.env.BREAD_FARM_DIST || (process.env.BREAD_ENGINE !== '0' ? 48 : 32)))) && due('farm', 1200000)) {
      try { await ensureFoodSupply(bot, { home, say, isStopped }); stepDone('farm') } catch (e) { dbg('  maint: farm failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 3: orchard - harvest our OWN grove when ripe AND wood is low. Daylight only.
    if (!nightIndoorOnly && !opportunistic && day() && orchardReady() && await woodLow() && due('orchard', 900000)) {
      try { await runGather(bot, (detectWood(bot) || 'oak') + '_log', 16, { home, isStopped, say }); stepDone('orchard') } catch (e) { dbg('  maint: orchard failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 4: cook + bake at the (reused hut) furnace.
    if ((Object.keys(RAW_COOKABLE).some(n => countItem(bot, n) > 0) || countItem(bot, 'wheat') >= 3 || (breadEngine && cachedBankFoodPts < bankTargetPts && cachedBankWheat >= 3)) && due('cook', 600000)) {
      try { await cookRawMeat(bot, { isStopped }); await bakeBreadFromWheat(bot, { isStopped, home }); stepDone('cook') } catch (e) { dbg('  maint: cook failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 5: THE COURIER - deposit the food surplus into the bed-adjacent bank.
    if ((has('bankFood') || (snap.packFoodPts || 0) > packTarget) && snap.homeReachable && due('courier', 600000)) {
      try { const n = await courierFoodToBank(bot, { isStopped, say }); if (n) stepDone('courier(' + n + ')') } catch (e) { dbg('  maint: courier failed (' + e.message + ')') }
    }
    if (breadEngine) dbg('  (bread-engine) reserve ' + cachedBankFoodPts + '/' + bankTargetPts + ' pts')
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 5b: safekeep-home - same bank visit as the courier (shares the 'safekeep' window).
    if (process.env.MAINT_SAFEKEEP !== '0' && atHome() && due('safekeep', 600000)) {
      try { const n = await safekeepSweep(bot, { isStopped, say, duringBuildOk: opportunistic }); if (n) stepDone('safekeep(' + n + ')') } catch (e) { dbg('  maint: safekeep failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 5c: spare-kit courier (#41) - bank a SURPLUS spare set (post-death re-arm floor), same
    // bank visit. Deposits only dupes (never the bot's only kit); no-op unless flagged + a surplus.
    if (process.env.RESILIENT_RECOVERY !== '0' && process.env.SPAREKIT !== '0' && has('spareKit') && atHome() && due('spareKit', 600000)) {
      try { const n = await spareKitToBank(bot, { isStopped, say }); if (n) stepDone('spareKit(' + n + ')') } catch (e) { dbg('  maint: spareKit failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // INV_SHED survival hook: a NAKED bot with a cluttered pack frees working room BEFORE gearing
    // up (ensurePackRoom's shed step moves the plank/furnace/spare-tool pile to the bank so STEP 6/7
    // have slots to craft/equip). No new machinery - one existing ensurePackRoom call.
    if (process.env.INV_DISCIPLINE !== '0' && process.env.INV_SHED !== '0' && (snap.armorPieces || 0) < 4 && bot.inventory && bot.inventory.emptySlotCount() < 6) {
      try { const f = await require('./resources.js').ensurePackRoom(bot, 6, { near: home, isStopped }); if (f >= 6) stepDone('shedroom') } catch (e) { dbg('  maint: shedroom failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 6: armor - the GEAR_REFLEX executor, same back-off + nightStuck exception. Outbound.
    if (process.env.GEAR_REFLEX !== '0' && !nightIndoorOnly && !opportunistic && has('armor') && (day() || nightStuck(bot)) && due('armor', 900000)) {
      const gb = gearupState()
      if (!(gb && gb.until > Date.now())) {
        try { const r = await require('./commands.js').handle(bot, 'armorup'); stepDone('armor'); dbg('  maint armor -> ' + String(r || '').split('\n')[0]) } catch (e) { dbg('  maint: armor failed (' + e.message + ')') }
      }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 7: tools - ONE missing tool per pass via the resource model (withdraw > craft > gather).
    if (has('tools') && !nightIndoorOnly && !opportunistic && due('tools', 900000)) {
      const t = snap.tools || {}
      try {
        const res = require('./resources.js')
        if (!t.pick || !t.sparePick) await res.acquire(bot, 'stone_pickaxe', 1, { near: home, isStopped, say })
        else if (!t.axe) await res.acquire(bot, 'stone_axe', 1, { near: home, isStopped, say })
        else if (!t.sword) await res.acquire(bot, process.env.TOOL_TIER_UPGRADE !== '0' ? 'stone_sword' : 'wooden_sword', 1, { near: home, isStopped, say })
        stepDone('tools')
      } catch (e) { dbg('  maint: tools failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 8: torches - withdraw coal+sticks if short, then craft from carried coal+stick.
    if (has('torches') && !nightIndoorOnly && due('torches', 900000)) {
      try {
        const torchTarget = Number(process.env.MAINT_TORCH_TARGET || 8)
        const res = require('./resources.js')
        if (countItem(bot, 'coal') + countItem(bot, 'charcoal') < 1) { try { await res.withdrawItems(bot, 'coal', 8, { near: home, maxDist: 64 }) } catch {} }
        if (countItem(bot, 'stick') < 1) { try { await res.withdrawItems(bot, 'stick', 4, { near: home, maxDist: 64 }) } catch {} }
        await ensureTorches(bot, torchTarget)
        stepDone('torches')
      } catch (e) { dbg('  maint: torches failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 9: homeRepair - the HOME_REPAIR chain when already home (5-min floor via stepDue).
    if (process.env.HOME_REPAIR !== '0' && atHome() && due('homeRepair', 300000)) {
      try { const r = await maintainHome(bot, hutAnchor(), { isStopped, say }); if (r && r.damaged) stepDone('homeRepair') } catch (e) { dbg('  maint: homeRepair failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 10: furnace consolidation (fix #13 Part A) - reclaim scattered field furnaces
    // (>32 and <=96 from the hut, <=2/pass) via the proven grab() primitive: re-verify the
    // block IS a furnace at dig time + own-tagged/lonely, else skip+forget (NEVER dig a
    // non-furnace or a furnace near anything player-built). Hourly, daytime, at-hut.
    if (process.env.INFRA_CONSOLIDATE !== '0' && !nightIndoorOnly && !opportunistic && day() && hutAnchor() && due('furnaceConsol', 3600000)) {
      try { const n = await consolidateFurnaces(bot, { isStopped, say }); if (n) stepDone('furnaceConsol(' + n + ')') } catch (e) { dbg('  maint: furnaceConsol failed (' + e.message + ')') }
    }
    if (between()) return { ok: true, steps, reason: 'bail:survival' }

    // STEP 11: scaffold litter patrol (fix #13 Part B) - walk to ONE far registered scaffold
    // cluster within 64 of home and teardownVerified it (registry-only, FILLER_RE re-read,
    // hut box excluded). Every dig is a cell the bot registered itself. Half-hourly, daytime.
    if (process.env.INFRA_CONSOLIDATE !== '0' && !nightIndoorOnly && !opportunistic && day() && home && due('litterPatrol', 1800000)) {
      try { const n = await litterPatrol(bot, home, { isStopped, say }); if (n) stepDone('litter(' + n + ')') } catch (e) { dbg('  maint: litterPatrol failed (' + e.message + ')') }
    }
    return { ok: true, steps, reason: steps.length ? steps.join('+') : 'nothing due' }
  } finally { _maintaining = false }
}

// ---- INFRA CONSOLIDATION (fix #13) --------------------------------------------------------
// Every "x,y,z" cell the bot has in its OWN infra memory, any kind. Used by lonelyFurnace to
// exempt the bot's own table/chest/torch next to a camp furnace from the structure scan.
function ownInfraCells () {
  const infra = (loadWorldMem().infra || {})
  const set = new Set()
  for (const kind of Object.keys(infra)) {
    for (const e of (infra[kind] || [])) {
      if (e && Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)) set.add(Math.floor(e.x) + ',' + Math.floor(e.y) + ',' + Math.floor(e.z))
    }
  }
  return set
}

// PURE: is the furnace at `cell` "in the middle of nowhere" - i.e. nothing PLAYER-built within
// radius 5? readBlock(x,y,z) -> block|null. ownCells: Set/array of "x,y,z" the bot placed. A
// STRUCTURE_RE hit disqualifies UNLESS it's (a) the furnace cell itself, (b) an own-remembered
// cell (bot's own camp table/chest), or (c) a torch (the bot lights its own smelt camps). Any
// other structure block (planks, door, wall, chest, another furnace...) => false, never touched.
// Offline-unit-testable with a fake reader (exported).
function lonelyFurnace (readBlock, cell, ownCells) {
  const own = ownCells instanceof Set ? ownCells : new Set(ownCells || [])
  const cx = Math.floor(cell.x); const cy = Math.floor(cell.y); const cz = Math.floor(cell.z)
  const R = 5
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        if (dx * dx + dy * dy + dz * dz > R * R) continue
        const x = cx + dx; const y = cy + dy; const z = cz + dz
        if (x === cx && y === cy && z === cz) continue // (a) the furnace cell itself
        const b = readBlock(x, y, z)
        if (!b || !b.name) continue // air / unloaded / natural - fine
        if (!STRUCTURE_RE.test(b.name)) continue // natural terrain - fine
        if (/torch/.test(b.name)) continue // (c) own smelt-camp lighting - a torch alone isn't a base
        if (own.has(x + ',' + y + ',' + z)) continue // (b) own remembered infra next to the camp furnace
        return false // player-built structure block adjacent - never reclaim this furnace
      }
    }
  }
  return true
}

// STEP 10 body: reclaim up to 2 scattered field furnaces per pass (>KEEP_R and <=MAX_R from the
// hut). A bounded generalization of furnishHut's grab() - SAME primitives, NO new dig path:
// re-read blockAt at the cell, require name==='furnace' EXACTLY (a player blast_furnace never
// qualifies), toolForBlock('stone'), dig, collectDrops, forgetInfra. Eligibility is evaluated
// AFTER walking to the furnace (so the lonely-furnace structure scan reads LOADED blocks - a
// far furnace's chunk is unloaded and would scan blind; this is strictly safer than a pre-walk
// scan). Returns the count reclaimed.
async function consolidateFurnaces (bot, { isStopped = () => false, say = () => {} } = {}) {
  const home = hutAnchor()
  if (!home) return 0
  const KEEP_R = Number(process.env.FURNACE_KEEP_R || 32) // keep the in-hut + utility-pad (hut+9,+9) furnaces
  const MAX_R = Number(process.env.FURNACE_MAX_R || 96) // travel bound
  const cands = listInfra('furnace', bot)
    .map(e => ({ e, d: Math.hypot(e.x - home.x, e.z - home.z) }))
    .filter(o => o.d > KEEP_R && o.d <= MAX_R)
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
  if (!cands.length) return 0
  const own = ownInfraCells()
  let reclaimed = 0
  for (const { e } of cands) {
    if (isStopped()) break
    // Walk there first so the chunk loads (recallAndReach pattern, provision.js:3074).
    try { await walkStaged(bot, e.x, e.z, { range: 10, timeoutMs: 60000, isStopped }) } catch { continue } // unreachable - keep the entry, retry a later pass
    if (isStopped()) break
    // RE-VERIFY at dig time: the block IS a furnace (exact - stricter than INFRA_BLOCK's
    // /furnace$/, so a player's blast_furnace never qualifies). Not a furnace => forget, NEVER dig.
    const b = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (!(b && b.name === 'furnace')) { forgetInfra('furnace', e); continue }
    // ELIGIBILITY (now that the chunk is loaded): own-tagged (bot provably placed it) OR the
    // lonely-furnace structure scan passes (nothing player-built within 5). Else skip forever.
    const eligible = e.own === true || lonelyFurnace((x, y, z) => bot.blockAt(new Vec3(x, y, z)), e, own)
    if (!eligible) { dbg('  consolidateFurnaces: furnace at ' + e.x + ',' + e.z + ' is near a build - leaving it'); continue }
    if (bot.entity.position.distanceTo(b.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(e.x, e.y, e.z, 2), 20000) } catch { continue } }
    const tool = toolForBlock(bot, 'stone') // wrong-tool digs drop NOTHING
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) continue
    try {
      await bot.dig(b)
      await collectDrops(bot, 4) // breaking a furnace also drops its contents
      forgetInfra('furnace', e)
      reclaimed++
      dbg('  consolidateFurnaces: reclaimed a field furnace at ' + e.x + ',' + e.y + ',' + e.z + ' (' + Math.round(Math.hypot(e.x - home.x, e.z - home.z)) + 'b out)')
    } catch (err) { dbg('  consolidateFurnaces: dig failed at ' + e.x + ',' + e.z + ' (' + err.message + ')') }
  }
  return reclaimed
}

// STEP 11 body: walk to ONE far registered scaffold cluster within LITTER_PATROL_R of home and
// teardownVerified it. Registry-only + hut box excluded (alsoTrail OFF - the pathfix trail
// remembers build fabric near home). Reuses scaffold.teardownVerified UNMODIFIED (its own
// FILLER_RE re-read + canDigBlock + exclude gates). Returns blocks removed.
async function litterPatrol (bot, home, { isStopped = () => false, say = () => {} } = {}) {
  const R = Number(process.env.LITTER_PATROL_R || 64)
  const now = Date.now()
  const hb = hutAnchor()
  // Hut box + 2-margin: the apron's self-placed dirt must never be shaved.
  const inHutApron = p => {
    if (ownHutAt(p)) return true
    if (!hb) return false
    const m = 2
    return p.x >= hb.x - m && p.x <= hb.x + 5 + m && p.z >= hb.z - m && p.z <= hb.z + 5 + m
  }
  const spots = scaffold.near(home, R).filter(s => (now - s.t > 600000) && !inHutApron(s)) // older than 10 min, not the hut apron
  if (!spots.length) return 0
  // Pick the densest cluster (most registry neighbors within 8; ties: oldest).
  const neighbors = s => spots.reduce((n, o) => n + (Math.hypot(o.x - s.x, o.z - s.z) <= 8 ? 1 : 0), 0)
  spots.sort((a, b) => (neighbors(b) - neighbors(a)) || (a.t - b.t))
  const spot = spots[0]
  try { await gotoWithTimeout(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 3), 45000) } catch {}
  let removed = 0
  try {
    const r = await scaffold.teardownVerified(bot, spot, { radius: 16, max: 48, maxPasses: 3, isStopped, exclude: p => !!ownHutAt(p) })
    removed = (r && r.removed) || 0
  } catch (e) { dbg('  litterPatrol: teardown failed (' + e.message + ')') }
  try { await collectDrops(bot, 8) } catch {}
  return removed
}

// ---- TREE FARMING (user-approved): the castle region is chopped bare, so the bot keeps
// its own wood supply alive like a player would - replant after every chop, fish saplings
// out of the leaves when it has none, and when the land is truly dry, plant a grove near
// home and let it grow instead of wandering 300 blocks into the night.
const PLANTABLE_GROUND = /^(grass_block|dirt|podzol|coarse_dirt|rooted_dirt|mud|moss_block)$/
function saplingFor (logItem) { return logItem.replace(/_log$/, '_sapling') }
function saplingCount (bot, logItem) { return (bot.inventory ? bot.inventory.items() : []).filter(i => i.name === saplingFor(logItem)).reduce((s, i) => s + i.count, 0) }

// Is this XZ inside the current build's keep-out box? (footprint + canopy margin,
// threaded down from autoBuild) - NEVER plant a future tree inside the castle.
function inAvoidBox (avoid, x, z) { return !!avoid && x >= avoid.x1 && x <= avoid.x2 && z >= avoid.z1 && z <= avoid.z2 }

// Plant one sapling on open ground near `around` (a just-felled trunk or a grove cell).
async function plantSaplingNear (bot, around, logItem, opts = {}) {
  const sap = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === saplingFor(logItem))
  if (!sap) return false
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -3; dy <= 1; dy++) {
    const gp = new Vec3(Math.floor(around.x) + dx, Math.floor(around.y) + dy, Math.floor(around.z) + dz)
    if (inAvoidBox(opts.avoid, gp.x, gp.z)) continue // a tree here would grow into the build
    try { const pf = require('./pathfix.js'); if (pf.isSelfPlaced && pf.isSelfPlaced(gp)) continue } catch {} // own scaffold dirt is NOT ground (sapling on the tower, live)
    if (scaffold.isScaffold(gp)) continue // registry outlives the 30-min trail (6h) - old towers aren't ground either
    const ground = bot.blockAt(gp); const above = bot.blockAt(gp.offset(0, 1, 0))
    if (!ground || !PLANTABLE_GROUND.test(ground.name) || !above || !AIRISH(above.name)) continue
    if (bot.entity.position.distanceTo(gp) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(gp.x, gp.y, gp.z, 2), 10000) } catch { continue } }
    try {
      await bot.equip(sap, 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
      dbg('  replanted ' + saplingFor(logItem) + ' at ' + gp.offset(0, 1, 0).toString())
      clearSearched(logItem, gp) // roomba rule: planting here makes this cell worth revisiting
      rememberSpot(logItem, gp)  // ...and puts it back on the map as a future wood source
      await boneMealSapling(bot, gp.offset(0, 1, 0)) // bones -> bone meal -> instant tree (why we KEEP bones)
      return true
    } catch (e) { dbg('  replant failed at ' + gp.toString() + ' (' + e.message + ')') }
  }
  return false
}

// Bone-meal a planted sapling until it grows (or we run out) - turns the tree farm from
// "wait ~20 min per tree" into "instant tree" whenever skeletons have paid their dues.
// Crafts bone meal from bones on the fly (2x2 recipe, no table needed).
async function boneMealSapling (bot, sapPos) {
  const mcData = require('minecraft-data')(bot.version)
  const items = () => bot.inventory ? bot.inventory.items() : []
  for (let uses = 0; uses < 6; uses++) {
    const sapBlock = bot.blockAt(sapPos)
    if (!sapBlock || !/_sapling$/.test(sapBlock.name)) return uses > 0 // grew (or gone)
    let meal = items().find(i => i.name === 'bone_meal')
    if (!meal) {
      const bone = items().find(i => i.name === 'bone')
      if (!bone) return false
      try {
        const recipe = bot.recipesFor(mcData.itemsByName.bone_meal.id, null, 1, null)[0]
        if (!recipe) return false
        await bot.craft(recipe, 1, null)
        meal = items().find(i => i.name === 'bone_meal')
      } catch (e) { dbg('  bone meal craft failed (' + e.message + ')'); return false }
      if (!meal) return false
    }
    try {
      await bot.equip(meal, 'hand')
      await bot.activateBlock(sapBlock)
      await new Promise(r => setTimeout(r, 350))
    } catch (e) { dbg('  bone-mealing failed (' + e.message + ')'); return false }
  }
  return !/_sapling$/.test((bot.blockAt(sapPos) || {}).name || '')
}

// No saplings in the pack? Break a handful of this tree's leaves (natural only) and sweep
// the drops - oak leaves shed a sapling ~5% of the time, so 10-12 leaves is a fair shot.
async function fishSaplings (bot, around, logItem, { isStopped = () => false } = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const leaf = mcData.blocksByName[logItem.replace(/_log$/, '_leaves')]
  if (!leaf) return
  let broken = 0
  while (broken < 16 && !isStopped() && saplingCount(bot, logItem) < 4) { // fish harder: the orchard wants stock
    const b = bot.findBlock({ matching: leaf.id, maxDistance: 4 })
    if (!b || !canBreakNaturally(b)) break
    try { await bot.dig(b) } catch { break }
    broken++
  }
  if (broken) { await collectDrops(bot, 6); dbg('  leaf-fished ' + broken + ' leaves -> ' + saplingCount(bot, logItem) + ' saplings') }
}

// PREP one orchard cell at (cx, ~baseY, cz): find the ground, clear vegetation above it,
// shave natural bumps toward plot level, fill a shallow dip with dirt, and top non-soil
// with dirt. Returns the plantable ground block, or null.
async function prepOrchardCell (bot, cx, baseY, cz, { isStopped = () => false } = {}) {
  // find ground: first solid block scanning down from a bit above plot level
  let ground = null
  for (let y = baseY + 3; y >= baseY - 3; y--) {
    const b = bot.blockAt(new Vec3(cx, y, cz))
    const a = bot.blockAt(new Vec3(cx, y + 1, cz))
    if (b && b.boundingBox === 'block' && a && REPLACEABLE.test(a.name)) { ground = b; break }
  }
  if (!ground) return null
  // OPEN SKY, CLEAR COLUMN (operator rule: no caves, no obstructions): a sapling under a
  // cave ceiling or overhang never grows into a usable tree. The full growing column must
  // be free of solid blocks - vegetation gets cleared below, neighbour-crown leaves are OK.
  for (let dy = 1; dy <= 14; dy++) {
    const b = bot.blockAt(ground.position.offset(0, dy, 0))
    if (!b) break // above loaded height - open enough
    if (!AIRISH(b.name) && !/grass|fern|flower|dead_bush|snow|vine|_leaves$|_sapling$/.test(b.name)) return null
  }
  if (bot.entity.position.distanceTo(ground.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(cx, ground.position.y, cz, 3), 15000) } catch { return null } }
  // clear vegetation/soft cover above the cell (never crafted blocks)
  for (let dy = 1; dy <= 2 && !isStopped(); dy++) {
    const b = bot.blockAt(ground.position.offset(0, dy, 0))
    if (b && !AIRISH(b.name) && /grass|fern|flower|dead_bush|snow|vine|_leaves$/.test(b.name)) { try { await bot.dig(b) } catch {} }
  }
  // shave a bump: ground sticking up past plot level gets cut down (natural blocks only,
  // plus loose cobble - pathfinder bridging litters plots with scaffold cobblestone that
  // "natural-only" could never remove, operator review)
  let guard = 3
  while (ground.position.y > baseY && guard-- > 0 && !isStopped()) {
    const shaveable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (!shaveable || (bot.canDigBlock && !bot.canDigBlock(ground))) break
    const tool = toolForBlock(bot, ground.name) // stone shaved wrong-tool drops nothing
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(ground); await collectDrops(bot, 3) } catch { break }
    const nb = bot.blockAt(new Vec3(cx, ground.position.y - 1, cz))
    if (!nb || nb.boundingBox !== 'block') break
    ground = nb
  }
  // fill a shallow dip with dirt so the row stays level
  if (ground.position.y < baseY - 1) {
    if (await placeAt(bot, ground.position.offset(0, 1, 0), /^(dirt|grass_block)$/)) {
      const nb = bot.blockAt(ground.position.offset(0, 1, 0)); if (nb && nb.boundingBox === 'block') ground = nb
    }
  }
  // saplings need soil - top stone/sand with a dirt block if we carry one
  if (!PLANTABLE_GROUND.test(ground.name)) {
    if (!await placeAt(bot, ground.position.offset(0, 1, 0), /^dirt$/)) return null
    const nb = bot.blockAt(ground.position.offset(0, 1, 0))
    if (!nb || !PLANTABLE_GROUND.test(nb.name)) return null
    ground = nb
  }
  return ground
}

// Level ONE plot cell toward baseY: clear soft cover, shave a bump (<=2, natural only),
// fill a 1-deep dip with dirt. The whole-plot flattening pass (operator review: "very
// uneven terrain, not a clean flat area") - each call is cheap when the cell's already flat.
async function levelPlotCell (bot, cx, baseY, cz, { isStopped = () => false } = {}) {
  let ground = null
  for (let y = baseY + 3; y >= baseY - 2; y--) {
    const b = bot.blockAt(new Vec3(cx, y, cz)); const a = bot.blockAt(new Vec3(cx, y + 1, cz))
    if (b && b.boundingBox === 'block' && a && (AIRISH(a.name) || REPLACEABLE.test(a.name))) { ground = b; break }
  }
  if (!ground) return false
  if (ground.position.y === baseY && AIRISH((bot.blockAt(ground.position.offset(0, 1, 0)) || { name: 'air' }).name)) return true // already flat
  if (bot.entity.position.distanceTo(ground.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(cx, ground.position.y, cz, 3), 8000) } catch { return false } }
  for (let dy = 1; dy <= 2; dy++) { // soft cover off first
    const v = bot.blockAt(ground.position.offset(0, dy, 0))
    if (v && !AIRISH(v.name) && /grass|fern|flower|dead_bush|snow|vine/.test(v.name)) { try { await bot.dig(v) } catch {} }
  }
  let guard = 3
  while (ground.position.y > baseY && guard-- > 0 && !isStopped()) { // shave bump (incl. scaffold cobble litter)
    const shaveable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (!shaveable || (bot.canDigBlock && !bot.canDigBlock(ground))) break
    const tool = toolForBlock(bot, ground.name) // stone shaved wrong-tool drops nothing
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(ground); await collectDrops(bot, 3) } catch { break }
    const nb = bot.blockAt(new Vec3(cx, ground.position.y - 1, cz))
    if (!nb || nb.boundingBox !== 'block') break
    ground = nb
  }
  if (ground.position.y < baseY) { // fill the dip ALL the way up with dirt (operator: "flat ground floor with dirt")
    let fills = 4
    while (ground.position.y < baseY && fills-- > 0 && !isStopped()) {
      if (!await placeAt(bot, ground.position.offset(0, 1, 0), /^(dirt|coarse_dirt|grass_block)$/)) break
      const nb = bot.blockAt(ground.position.offset(0, 1, 0))
      if (!nb || nb.boundingBox !== 'block') break
      ground = nb
    }
  }
  // uniform DIRT surface: a stone/gravel/cobble top reads as mess even when level -
  // swap it for dirt (operator order: the plot is a flat DIRT floor, not mixed rubble)
  if (ground.position.y === baseY && !/^(grass_block|dirt|coarse_dirt|podzol|mycelium|farmland)$/.test(ground.name)) {
    const swappable = canBreakNaturally(ground) || /^(cobblestone|cobbled_deepslate)$/.test(ground.name)
    if (swappable && (bot.inventory ? bot.inventory.items() : []).some(i => /^(dirt|coarse_dirt)$/.test(i.name))) {
      const tool = toolForBlock(bot, ground.name)
      if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
      try {
        await bot.dig(ground); await collectDrops(bot, 2)
        await placeAt(bot, ground.position, /^(dirt|coarse_dirt)$/)
      } catch {}
    }
  }
  return true
}

// Plant an ORCHARD: an even grid (5-block lanes) on prepped, level ground near - but
// never inside - the build's keep-out box. Operator spec: "a nice opening with flat
// ground, trees planted evenly so it's easy to navigate and use". Returns count planted.
async function plantGrove (bot, home, logItem, { isStopped = () => false, say = () => {}, avoid = null, max = 8 } = {}) {
  if (saplingCount(bot, logItem) < 1) return 0
  // anchor shifted +24 south of the original (pre-leveling) plot: the operator ordered
  // the messy first orchard torn down and future ones built on cleanly prepared ground
  const gx = Math.floor(avoid ? avoid.x2 + 8 : home.x + 18); const gz = Math.floor(home.z) + 24
  await walkStaged(bot, gx, gz, { isStopped, range: 6, timeoutMs: 90000 })
  if (isStopped()) return 0
  const baseY = Math.floor(bot.entity.position.y) - 1 // plot level = the ground we stand on
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(max))))
  // FLATTEN THE WHOLE PLOT first - lanes included (operator review: the per-cell-only
  // prep left "very uneven terrain, not a clean flat area"). Bounded: corrective work
  // is capped, flat cells cost one block-read each.
  {
    const w = cols * 5; const h = 4 * 5
    let ops = 0
    // STOCK DIRT first (operator order: flat DIRT floor): hole-fills and rubble-top
    // swaps both eat dirt, and running dry mid-plot left holes. Dirt digs fast anywhere.
    if (countItem(bot, 'dirt') < 48 && !isStopped()) {
      dbg('  orchard: stocking dirt for the leveling (' + countItem(bot, 'dirt') + ' on hand)')
      try { await runGather(bot, 'dirt', 64, { isStopped, restoreMovements: () => {}, home: { x: gx, z: gz }, avoid }) } catch (e) { dbg('  orchard: dirt stock-up failed (' + e.message + ') - leveling with what we have') }
    }
    say('leveling the orchard plot first')
    // MULTI-PASS until actually flat (operator review: one 60-cell pass left "holes and
    // a little bit of hill"). Each pass shaves deeper and fills another layer, so bumps
    // and dips CONVERGE; stop when a full sweep corrects nothing or the budget is spent.
    for (let pass = 0; pass < 4 && !isStopped() && ops < 240; pass++) {
      let fixed = 0
      outerLevel:
      for (let dz = -1; dz <= h && !isStopped(); dz++) {
        for (let dx = -1; dx <= w; dx++) {
          const cx = gx + dx; const cz = gz + dz
          if (inAvoidBox(avoid, cx, cz)) continue
          const g0 = bot.blockAt(new Vec3(cx, baseY, cz))
          const a0 = bot.blockAt(new Vec3(cx, baseY + 1, cz))
          if (g0 && g0.boundingBox === 'block' && a0 && AIRISH(a0.name)) continue // flat already - free
          try { if (await levelPlotCell(bot, cx, baseY, cz, { isStopped })) { ops++; fixed++ } } catch {}
          if (ops >= 240) { dbg('  orchard: leveling budget spent (' + ops + ' cells corrected) - planting on what we have'); break outerLevel }
        }
      }
      if (!fixed) break // converged: the whole sweep found nothing to correct
    }
    dbg('  orchard: plot leveled (' + ops + ' cells corrected)')
  }
  const sap = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === saplingFor(logItem))
  let planted = 0
  for (let r = 0; r < 4 && planted < max && !isStopped(); r++) {
    for (let c = 0; c < cols && planted < max && !isStopped(); c++) {
      if (!sap()) break
      const cx = gx + c * 5; const cz = gz + r * 5 // 5-block lanes: walkable + crowns don't merge
      if (inAvoidBox(avoid, cx, cz)) continue
      const ground = await prepOrchardCell(bot, cx, baseY, cz, { isStopped })
      if (!ground) { dbg('  orchard: cell ' + cx + ',' + cz + ' unusable - skipping'); continue }
      try {
        await bot.equip(sap(), 'hand')
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        planted++
        clearSearched(logItem, ground.position)
        dbg('  orchard: planted ' + saplingFor(logItem) + ' at ' + cx + ',' + (ground.position.y + 1) + ',' + cz + ' (' + planted + '/' + max + ')')
        await boneMealSapling(bot, ground.position.offset(0, 1, 0))
      } catch (e) { dbg('  orchard: plant failed at ' + cx + ',' + cz + ' (' + e.message + ')') }
    }
  }
  if (planted) {
    // dedup: one orchard per site per growth cycle. Growth fields (planted/harvestReadyAt) let
    // the gather loop treat the grove as a RENEWABLE first-stop once it has had time to mature.
    const GROW_MS = parseInt(process.env.ORCHARD_GROW_MS || String(10 * 60000), 10)
    const m = loadWorldMem(); m.orchard = { x: gx, z: gz, at: Date.now(), planted, harvestReadyAt: Date.now() + GROW_MS }; saveWorldMem()
    rememberSpot(logItem, new Vec3(gx + 5, baseY, gz + 5), { orchard: true }) // the plot is a renewable wood source now (never hard-deleted)
    // a torch in the plot: saplings keep growing through the night and mobs stay out
    try { await placeAt(bot, new Vec3(gx + 2, baseY + 1, gz + 2), /^torch$/) } catch {}
    say(`planted a ${planted}-tree orchard by the site - rows are straight, come have a look`)
    dbg('  orchard: ' + planted + ' planted in a ' + cols + '-wide grid at ' + gx + ',' + gz)
  }
  return planted
}

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
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass)$/
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
const RAW_COOKABLE = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon'
}

// Cook whatever raw meat we're carrying in a NEARBY furnace - the player-like tidy-up
// ("standing at the furnace anyway? toss the porkchops in"). Opportunistic on purpose:
// never crafts/places a furnace for this, needs fuel already in the pack, bounded to two
// meat types per pass. Returns how many items came out cooked (0 = nothing to do).
async function cookRawMeat (bot, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const mcData = require('minecraft-data')(bot.version)
  const raw = Object.keys(RAW_COOKABLE).filter(n => countItem(bot, n) > 0)
  if (!raw.length) return 0
  const furnaceId = mcData.blocksByName.furnace.id
  let blk = bot.findBlock({ matching: furnaceId, maxDistance: 12 })
  if (!blk) {
    // the camp furnace lives in the hut now - worth a short walk (operator: "now that
    // it has a furnace why is it eating raw food?"); cooked feeds ~3x raw.
    const known = recallInfraVerified(bot, 'furnace', bot.entity.position, hutAnchor() ? 48 : 32) // §8: the farm sits ~76b out; 48 walks a far cook pass home to the hut furnace (which also sets up the courier bank visit)
    if (known) {
      try { await gotoWithTimeout(bot, new goals.GoalNear(known.x, known.y, known.z, 2), 30000) } catch {}
      blk = bot.findBlock({ matching: furnaceId, maxDistance: 6 })
    }
  }
  if (!blk) return 0
  const hasFuel = (bot.inventory ? bot.inventory.items() : []).some(i =>
    i.name === 'coal' || i.name === 'charcoal' || i.name === 'coal_block' || /_planks$/.test(i.name))
  if (!hasFuel) return 0
  if (bot.entity.position.distanceTo(blk.position) > 2.5) {
    try { await gotoWithTimeout(bot, new goals.GoalNear(blk.position.x, blk.position.y, blk.position.z, 2), 15000) } catch { return 0 }
  }
  let cooked = 0
  dbg('cookRawMeat:', raw.map(n => countItem(bot, n) + 'x ' + n).join(', '))
  for (const name of raw.slice(0, 2)) { // bound the detour
    if (isStopped()) break
    const n = countItem(bot, name)
    // runSmeltSingle throws on a shortfall (e.g. fuel ran out mid-cook) - whatever DID
    // cook was already drained into the pack, so a partial pass is fine.
    try { cooked += await runSmeltSingle(bot, RAW_COOKABLE[name], name, n, opts) } catch { break }
  }
  return cooked
}

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
async function placeStationInInterior (bot, kind, itemName, opts = {}) {
  const hut = (opts.hut) || (listInfra('hut')[0])
  if (!hut) return null
  // only when we're actually AT the hut (else this is a field station - place locally)
  if (!insideOwnStructure(bot) && !onHutApron(bot)) return null
  if (!(bot.inventory ? bot.inventory.items() : []).some(i => i.name === itemName)) return null
  const cell = stationSlot(bot, kind, opts.desired != null ? opts.desired : 1, hut) // null if one already stands / interior full
  if (!cell) return null
  try {
    const nav = require('./navigate.js')
    if (!insideOwnStructure(bot)) { try { await nav.enterStructure(bot, hut, { isStopped: opts.isStopped }) } catch {} } // walk IN through the door first
    if (bot.entity.position.distanceTo(cell) > 3) await gotoWithTimeout(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), 15000)
    if (!await placeAt(bot, cell, new RegExp('^' + itemName + '$'))) { dbg('  interior place: ' + itemName + ' did not land at ' + cell.toString()); return null }
    const md = require('minecraft-data')(bot.version)
    const blk = bot.blockAt(cell)
    if (blk && blk.name === itemName) { rememberInfra(kind, cell, { own: true }); dbg('  placed ' + kind + ' inside the hut at ' + cell.toString() + ' (reachable through the door, not across a wall)'); return blk }
    void md
  } catch (e) { dbg('  interior place failed (' + e.message + ')') }
  return null
}

async function ensureChest (bot, opts = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const chestId = mcData.blocksByName.chest.id
  let chest = bot.findBlock({ matching: chestId, maxDistance: 8 })
  if (chest) { rememberInfra('chest', chest.position); return chest }
  // Reuse the site chest we REMEMBER (tight radius - the stash chest belongs at the site).
  const knownC = await recallAndReach(bot, 'chest', chestId, 24, async () => true)
  if (knownC) { rememberInfra('chest', knownC.position); return knownC }
  if (countItem(bot, 'chest') === 0) {
    const table = await ensureTable(bot, opts)
    // Unified navigator (door pre-flight crosses into the hut if the table's inside); tight at-base budgets.
    if (bot.entity.position.distanceTo(table.position) > 3) { try { await navigate.navigateTo(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 0, nudge: 1, stepout: 1 }, label: 'chest-table-reach' }) } catch {} }
    const recipe = bot.recipesFor(mcData.itemsByName.chest.id, null, 1, table)[0]
    if (!recipe) throw new Error('cannot craft a chest (need 8 planks)')
    await bot.craft(recipe, 1, table)
    await new Promise(r => setTimeout(r, 250))
  }
  // BELIEVABILITY: at the hut, place the chest on a valid INTERIOR floor cell (reachable
  // through the door), not floating outside a wall. Falls back to local placement elsewhere.
  const inside = await placeStationInInterior(bot, 'chest', 'chest', { hut: opts.home, isStopped: opts.isStopped })
  if (inside) return inside
  await placeFromInventory(bot, 'chest')
  chest = bot.findBlock({ matching: chestId, maxDistance: 6 })
  if (!chest) throw new Error('placed a chest but cannot find it')
  rememberInfra('chest', chest.position)
  return chest
}

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
const FACING_OFF = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
async function placeChestOriented (bot, target, want, opts = {}) {
  const off = FACING_OFF[want]
  const item = () => (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  if (!off || !item()) return false
  const floor = bot.blockAt(target.offset(0, -1, 0))
  if (!floor || floor.boundingBox !== 'block' || /chest/.test(floor.name)) return false
  for (const sign of [1, -1]) { // stand on the facing side; one flip retry
    if (!item()) return false
    const stand = target.offset(off[0] * sign, 0, off[1] * sign)
    const clear = b => b && b.boundingBox !== 'block'
    const f = bot.blockAt(stand); const h = bot.blockAt(stand.offset(0, 1, 0)); const g = bot.blockAt(stand.offset(0, -1, 0))
    if (!(clear(f) && clear(h) && g && g.boundingBox === 'block')) { dbg('  orientedChest: no standing room ' + want + (sign < 0 ? '-flipped' : '') + ' of ' + target); continue }
    try {
      // door-assist approach: the stand cell is INSIDE the hut and a raw goto can't plan
      // through the closed door (live: the heal's re-place silently failed from outside)
      const nav = require('./navigate.js')
      await nav.navigateTo(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 0, water: 0, nudge: 1, stepout: 1 }, label: 'chest-stand' })
    } catch (e) { dbg('  orientedChest: cannot reach the stand cell ' + stand + ' (' + e.message + ')'); continue }
    const cur = bot.blockAt(target)
    if (cur && /chest/.test(cur.name)) return false // filled meanwhile
    try {
      await bot.equip(item(), 'hand')
      await bot.lookAt(target.offset(0.5, -0.4, 0.5), true) // down through the target cell at the floor
      await bot.placeBlock(floor, new Vec3(0, 1, 0))
    } catch (e) { dbg('  orientedChest: place failed (' + e.message + ')'); return false }
    await new Promise(r => setTimeout(r, 350))
    const b = bot.blockAt(target)
    if (!b || !/chest/.test(b.name)) return false
    let got = null; try { got = (b.getProperties() || {}).facing } catch {}
    if (got === want) return true
    dbg('  orientedChest: landed facing ' + got + ' (wanted ' + want + ') - taking it back, flipping sides')
    try { await bot.dig(b); await collectDrops(bot, 3) } catch { return false }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

// Detect two ADJACENT own single chests in the hut and re-place them with ONE shared
// perpendicular facing so they merge into a double. Contents move one chest at a time
// (the pack never holds the whole treasury); a chest is only dug once it READS empty.
// Returns true when the pair reads as a connected double afterwards.
async function healBankDouble (bot, hut, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const list = listInfra('chest', bot).filter(e => insideHutBox(e, hut))
  if (!list.length) return false
  const blkOf = e => bot.blockAt(new Vec3(e.x, e.y, e.z))
  const prop = (b, k) => { try { return (b.getProperties() || {})[k] } catch { return null } }
  let pair = null
  for (const a of list) {
    const b = list.find(o => o !== a && o.y === a.y && Math.abs(o.x - a.x) + Math.abs(o.z - a.z) === 1)
    if (b) { pair = [a, b]; break }
  }
  if (!pair) {
    // The other half STANDS in the world but fell out of infra memory (the schematic
    // rebuild registers only ONE chest cell; an aborted heal forgets the half it dug,
    // live: 418,66,87 west stood unregistered while the model saw a lone single). An
    // adjacent standing chest inside the bot's own hut IS the bank's other half - adopt
    // it back into the registry.
    for (const a of list) {
      for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const cell = { x: a.x + dx, y: a.y, z: a.z + dz }
        if (!insideHutBox(cell, hut)) continue
        const cb = bot.blockAt(new Vec3(cell.x, cell.y, cell.z))
        if (cb && /chest$/.test(cb.name)) {
          rememberInfra('chest', new Vec3(cell.x, cell.y, cell.z))
          dbg('bank heal: adopted the unregistered half at ' + cell.x + ',' + cell.y + ',' + cell.z + ' back into the registry')
          pair = [a, cell]; break
        }
      }
      if (pair) break
    }
  }
  if (!pair && list.length === 1 && (bot.inventory ? bot.inventory.items() : []).some(i => i.name === 'chest')) {
    // HALF THE BANK IS IN THE PACK (an aborted heal dug it and could not re-place, live
    // 05:44): adopt the free adjacent interior cell as the missing half - the loop below
    // places it oriented and re-registers it.
    const a = list[0]
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const cell = { x: a.x + dx, y: a.y, z: a.z + dz }
      if (!insideHutBox(cell, hut)) continue
      const cb = bot.blockAt(new Vec3(cell.x, cell.y, cell.z)); const fl = bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z))
      if (cb && AIRISH(cb.name) && fl && fl.boundingBox === 'block') { pair = [a, cell]; dbg('bank heal: missing half is in my pack - restoring it at ' + cell.x + ',' + cell.y + ',' + cell.z); break }
    }
  }
  if (!pair) return false
  const [A, B] = pair.map(blkOf)
  const chestish = b => b && /chest$/.test(b.name)
  const airish = b => !b || AIRISH(b.name)
  if (!(chestish(A) || airish(A)) || !(chestish(B) || airish(B))) return false
  if (chestish(A) && chestish(B) && (prop(A, 'type') !== 'single' || prop(B, 'type') !== 'single')) return false // already merged
  // shared facing PERPENDICULAR to the pair axis, on a side with interior standing room
  const axisZ = pair[0].x === pair[1].x
  let want = null
  for (const w of (axisZ ? ['west', 'east'] : ['north', 'south'])) {
    const off = FACING_OFF[w]
    const ok = pair.every(e => {
      const s = new Vec3(e.x + off[0], e.y, e.z + off[1])
      const f = bot.blockAt(s); const g = bot.blockAt(s.offset(0, -1, 0))
      return f && f.boundingBox !== 'block' && g && g.boundingBox === 'block'
    })
    if (ok) { want = w; break }
  }
  if (!want) { dbg('bank heal: no standable shared facing side - leaving the pair as-is'); return false }
  dbg('bank heal: two SINGLE chests at ' + pair.map(e => e.x + ',' + e.y + ',' + e.z).join(' + ') + ' - re-facing both ' + want + ' to merge them')
  for (const e of pair) {
    if (isStopped()) return false
    let b = blkOf(e)
    const missing = airish(b) // this half is in the pack (aborted earlier heal) - just place it
    if (!missing && !/chest$/.test(b.name)) return false
    if (!missing && prop(b, 'facing') === want) continue // this half is already right
    if (!missing) {
      // 1a) SHUTTLE the bulk into the OTHER half first - the pack alone can't hold a
      //     full bank (live: 871 items in one half), and the treasury must never sit
      //     in a dropped pile. withdraw -> deposit trips, bounded.
      const other = pair.find(o => o !== e)
      const otherBlk = () => { const ob = other && blkOf(other); return ob && /chest$/.test(ob.name) ? ob : null }
      if (otherBlk()) {
        for (let trip = 0; trip < 8; trip++) {
          let counts = {}
          try { counts = await chestCounts(bot, blkOf(e)) } catch { break }
          const names = Object.keys(counts)
          if (!names.length) break
          for (const n of names) {
            if ((bot.inventory ? bot.inventory.emptySlotCount() : 0) < 3) break
            try { await withdrawItem(bot, blkOf(e), n, counts[n]) } catch {}
          }
          if (!otherBlk()) break
          try { await depositMaterials(bot, otherBlk(), { all: true, keepDirt: 0 }) } catch (err) { dbg('bank heal: shuttle deposit failed (' + err.message + ')'); break }
        }
      }
      // 1b) empty the remainder into the pack (verified) - never dig a chest with anything inside
      try {
        const counts = await chestCounts(bot, b)
        for (const n of Object.keys(counts)) { await withdrawItem(bot, blkOf(e), n, counts[n]) }
      } catch (err) { dbg('bank heal: empty failed (' + err.message + ') - aborting'); return false }
      let left = {}
      try { left = await chestCounts(bot, blkOf(e)) } catch { left = { unknown: 1 } }
      if (Object.keys(left).length) {
        dbg('bank heal: chest still holds ' + Object.keys(left).join(',') + ' (pack full?) - aborting, nothing lost')
        return false
      }
      // 2) dig + re-place oriented + re-register
      forgetInfra('chest', listInfra('chest').find(x => x.x === e.x && x.y === e.y && x.z === e.z))
      try { await bot.dig(blkOf(e)); await collectDrops(bot, 3) } catch (err) { dbg('bank heal: dig failed (' + err.message + ')'); return false }
    }
    if (!await placeChestOriented(bot, new Vec3(e.x, e.y, e.z), want, opts)) {
      dbg('bank heal: oriented re-place failed - putting a chest back plainly so the bank cell is not lost')
      try { await placeAt(bot, new Vec3(e.x, e.y, e.z), /^chest$/) } catch {}
    }
    const nb = blkOf(e)
    if (!nb || !/chest$/.test(nb.name)) { dbg('bank heal: chest did not go back at ' + e.x + ',' + e.y + ',' + e.z + ' - it is in my pack, next camp pass retries'); return false }
    rememberInfra('chest', new Vec3(e.x, e.y, e.z))
    // 3) put the goods back (working set stays on the bot as usual)
    try { await depositMaterials(bot, nb, { keepDirt: 8 }) } catch (err) { dbg('bank heal: redeposit failed (' + err.message + ') - items safe in my pack') }
  }
  const [A2, B2] = pair.map(blkOf)
  const merged = A2 && B2 && /chest$/.test(A2.name) && /chest$/.test(B2.name) &&
    prop(A2, 'type') !== 'single' && prop(B2, 'type') !== 'single'
  dbg('bank heal: pair now reads ' + (merged ? 'CONNECTED DOUBLE (' + prop(A2, 'type') + '/' + prop(B2, 'type') + ')' : 'still not merged'))
  return !!merged
}

async function gotoChest (bot, chestBlock) {
  // BANKING REACH: a single 15s goto times out on a far bank ("chest read failed (goto
  // timed out)", live at 80b out) and the treasury reads as unreachable. Staged legs
  // first when far, then the precise approach - through the hut door if need be.
  const d = bot.entity.position.distanceTo(chestBlock.position)
  if (d > 40) { try { await walkStaged(bot, chestBlock.position.x, chestBlock.position.z, { range: 8, timeoutMs: 120000 }) } catch {} }
  if (bot.entity.position.distanceTo(chestBlock.position) > 3) {
    // The bank lives INSIDE the hut - a plain goto can't plan through the door, so go straight
    // through the UNIFIED navigator (its door pre-flight crosses in). Tight at-base budgets.
    try {
      await navigate.navigateTo(bot, new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), { timeoutMs: 15000, deadlineMs: 35000, climb: false, budgets: { door: 2, pit: 0, nudge: 1, stepout: 1 }, label: 'bank' })
    } catch {}
  }
}

// Deposit all BUILD MATERIALS (everything not in KEEP_ON_BOT) into the chest, so
// the pack doesn't overflow mid-provision. Keeps `keepDirt` dirt for bridging.
// Returns the number of items deposited.
// opts.all: deposit EVERYTHING except active gear/food (tools, weapons, armor, torches,
// rod, a bite to eat) - for treasury refills and bank consolidation. The default keeps
// the usual working set (KEEP_ON_BOT). NOTE: the camp rebuild always passed all:true;
// it was silently ignored until now, leaving planks/coal stuck in the pack.
const KEEP_WHEN_ALL = /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|^shears$|_helmet$|_chestplate$|_leggings$|_boots$|^torch$|flint_and_steel|_bucket$|^bucket$|^fishing_rod$|^cooked_|^bread$|_apple$/
async function depositMaterials (bot, chestBlock, opts = {}) {
  const keepDirt = opts.keepDirt || 0
  const keepRe = opts.all ? KEEP_WHEN_ALL : KEEP_ON_BOT
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  let n = 0
  try {
    if (opts.deposits) {
      // EXPLICIT-LIST mode (S6 courier/safekeep): deposit EXACTLY the named counts and IGNORE
      // the keep regexes - KEEP_ON_BOT/KEEP_WHEN_ALL would otherwise pin food/planks on the bot
      // forever (the pure courierPlan/safekeepPlan already decided what is safe to move). The
      // regex modes below stay byte-identical for every existing caller (opts.deposits absent).
      const want = new Map()
      for (const d of opts.deposits) { if (d && d.name && d.count > 0) want.set(d.name, (want.get(d.name) || 0) + d.count) }
      for (const [name, cnt] of want) {
        let remaining = cnt
        for (const it of bot.inventory.items()) {
          if (remaining <= 0) break
          if (it.name !== name) continue
          const take = Math.min(remaining, it.count)
          try { await chest.deposit(it.type, null, take); n += take; remaining -= take } catch { /* chest full / slot race */ }
        }
      }
    } else {
      for (const it of bot.inventory.items()) {
        if (keepRe.test(it.name)) continue
        let count = it.count
        if (it.name === 'dirt' && keepDirt) count = Math.max(0, it.count - keepDirt)
        if (count <= 0) continue
        try { await chest.deposit(it.type, null, count); n += count } catch { /* chest full / slot race */ }
      }
    }
  } finally { chest.close() }
  return n
}

// Withdraw up to `count` of `itemName` from the chest. Returns how many came out.
async function withdrawItem (bot, chestBlock, itemName, count) {
  const mcData = require('minecraft-data')(bot.version)
  const def = mcData.itemsByName[itemName]
  if (!def || count <= 0) return 0
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  let got = 0
  try {
    const have = chest.containerItems().filter(i => i.name === itemName).reduce((a, b) => a + b.count, 0)
    const take = Math.min(count, have)
    if (take > 0) { await chest.withdraw(def.id, null, take); got = take }
  } finally { chest.close() }
  return got
}

// ---- CHEST MIGRATION (operator promise): the banking chest lived in the open - one
// creeper by the treasury loses the economy. Once the safehouse stands, the bank moves
// INSIDE. Item-safe order: the new chest exists and is verified before anything leaves
// the old one; the old chest is only dug up once it reads EMPTY.
async function migrateChestInto (bot, oldPos, hut, { isStopped = () => false, say = () => {} } = {}) {
  // WALL-HUGGING interior cells (operator: "why did it place its chest in the middle") -
  // the centre [2,2] stays walkable; corners/edges first. Collect free cells, then find
  // an adjacent PAIR for a DOUBLE chest (operator: "make it a double chest for more space").
  const interior = []
  const order = [[1, 1], [1, 3], [3, 1], [3, 3], [1, 2], [2, 1], [2, 3], [3, 2]] // corners then edges, NEVER [2,2]
  for (const [dx, dz] of order) {
    for (let dy = 0; dy <= 3; dy++) {
      const p = new Vec3(hut.x + dx, hut.y + dy, hut.z + dz)
      const b = bot.blockAt(p); const below = bot.blockAt(p.offset(0, -1, 0)); const above = bot.blockAt(p.offset(0, 1, 0))
      if (b && AIRISH(b.name) && below && below.boundingBox === 'block' && above && AIRISH(above.name)) { interior.push(p); break }
    }
  }
  if (!interior.length) { dbg('  chest migration: no free interior cell in the hut'); return false }
  let target = interior[0]; let target2 = null
  for (const a of interior) { // a same-y neighbour makes the two chests merge into a double
    const n = interior.find(o => o.y === a.y && Math.abs(o.x - a.x) + Math.abs(o.z - a.z) === 1)
    if (n) { target = a; target2 = n; break }
  }
  let chestItem = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  const chestCount = () => countItem(bot, 'chest')
  if (chestCount() < 2) { // want TWO for the double chest
    try { await runCraft(bot, 'chest', 2 - chestCount(), true, { isStopped, home: { x: hut.x, y: hut.y, z: hut.z } }) } catch (e) { dbg('  chest migration: cannot craft chests (' + e.message + ')') }
    chestItem = (bot.inventory ? bot.inventory.items() : []).find(i => i.name === 'chest')
  }
  if (!chestItem) { dbg('  chest migration: no chest to place'); return false }
  if (bot.entity.position.distanceTo(target) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(target.x, target.y, target.z, 2), 20000) } catch {} }
  if (!await placeAt(bot, target, /^chest$/)) { dbg('  chest migration: could not place inside - ' + (placeAt.lastFail || '?')); return false }
  const newBlk = bot.blockAt(target)
  if (!newBlk || !/chest/.test(newBlk.name)) return false
  rememberInfra('chest', target)
  // second half of the double chest, if we have a pair-cell and a spare chest
  if (target2 && chestCount() >= 1) {
    if (bot.entity.position.distanceTo(target2) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(target2.x, target2.y, target2.z, 2), 15000) } catch {} }
    if (await placeAt(bot, target2, /^chest$/)) { const b2 = bot.blockAt(target2); if (b2 && /chest/.test(b2.name)) { rememberInfra('chest', target2); dbg('  chest migration: double chest placed') } }
  }
  say('moving the bank into the hut where creepers cannot audit it')
  let trips = 0
  while (!isStopped() && trips++ < 6) {
    const oldBlk = bot.blockAt(new Vec3(oldPos.x, oldPos.y, oldPos.z))
    if (!oldBlk || !/chest/.test(oldBlk.name)) break
    let counts
    try { counts = await chestCounts(bot, oldBlk) } catch (e) { dbg('  chest migration: old chest read failed (' + e.message + ')'); break }
    const names = Object.keys(counts)
    if (!names.length) break
    for (const n of names) {
      if ((bot.inventory ? bot.inventory.emptySlotCount() : 36) < 2) break
      try { await withdrawItem(bot, oldBlk, n, counts[n]) } catch {}
    }
    try { await depositMaterials(bot, bot.blockAt(target), { keepDirt: 8 }) } catch (e) { dbg('  chest migration: deposit failed (' + e.message + ')') }
  }
  const oldBlk2 = bot.blockAt(new Vec3(oldPos.x, oldPos.y, oldPos.z))
  let left = {}
  if (oldBlk2 && /chest/.test(oldBlk2.name)) { try { left = await chestCounts(bot, oldBlk2) } catch { left = { unknown: 1 } } }
  if (oldBlk2 && /chest/.test(oldBlk2.name) && !Object.keys(left).length) {
    try {
      const tool = toolForBlock(bot, 'oak_planks')
      if (tool) await bot.equip(tool, 'hand').catch(() => {})
      await bot.dig(oldBlk2); await collectDrops(bot, 4)
      const entry = listInfra('chest').find(e => e.x === Math.floor(oldPos.x) && e.y === Math.floor(oldPos.y) && e.z === Math.floor(oldPos.z))
      if (entry) forgetInfra('chest', entry)
      say('bank moved - old chest packed up')
    } catch (e) { dbg('  chest migration: old chest pickup failed (' + e.message + ')') }
  } else if (Object.keys(left).length) dbg('  chest migration: old chest NOT empty after trips - leaving it standing')
  return true
}

// ---- HOME BANK CONSOLIDATION (operator promise): ONE canonical treasury - the chest
// inside the hut. Every other remembered chest within `radius` gets ferried into it and
// dug up (item-safe: withdraw -> deposit round trips; the old chest is only removed once
// it reads EMPTY). Field stashes from old camps stop rotting in the open where one
// creeper audit loses the economy. Idempotent - runs every camp pass, fast no-op when
// the bank is the only chest. Returns how many field chests were fully consolidated.
async function consolidateBank (bot, hut, { isStopped = () => false, say = () => {}, radius = 64 } = {}) {
  const chests = listInfra('chest', bot)
  const bank = chests.find(e => ownHutAt({ x: e.x, y: e.y, z: e.z }))
  if (!bank) { dbg('  consolidate: no bank chest inside the hut yet'); return 0 }
  const bankBlk = () => bot.blockAt(new Vec3(bank.x, bank.y, bank.z))
  const bb0 = bankBlk()
  if (!bb0 || !/chest/.test(bb0.name)) { dbg('  consolidate: bank cell does not hold a chest'); return 0 }
  let consolidated = 0
  for (const e of chests) {
    if (isStopped()) break
    if (ownHutAt({ x: e.x, y: e.y, z: e.z })) continue // the bank itself / its double half
    if (Math.hypot(e.x - hut.x, e.z - hut.z) > radius) continue
    const blk = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (!blk || !/chest/.test(blk.name)) continue // unloaded or pruned - a later pass gets it
    dbg('  consolidate: ferrying field chest at ' + e.x + ',' + e.y + ',' + e.z + ' into the bank')
    say('moving a field chest into the bank')
    let trips = 0
    while (!isStopped() && trips++ < 6) {
      const ob = bot.blockAt(new Vec3(e.x, e.y, e.z))
      if (!ob || !/chest/.test(ob.name)) break
      let counts
      try { counts = await chestCounts(bot, ob) } catch (err) { dbg('  consolidate: field chest read failed (' + err.message + ')'); break }
      if (!Object.keys(counts).length) break
      for (const n of Object.keys(counts)) {
        if ((bot.inventory ? bot.inventory.emptySlotCount() : 36) < 2) break
        try { await withdrawItem(bot, ob, n, counts[n]) } catch {}
      }
      const bb = bankBlk()
      if (!bb || !/chest/.test(bb.name)) { dbg('  consolidate: bank vanished mid-ferry - stopping'); return consolidated }
      try { await depositMaterials(bot, bb, { keepDirt: 8, all: true }) } catch (err) { dbg('  consolidate: bank deposit failed (' + err.message + ')') }
    }
    // remove the old chest only once it verifies EMPTY (world re-read is the arbiter)
    const ob2 = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (ob2 && /chest/.test(ob2.name)) {
      let left = { unknown: 1 }
      try { left = await chestCounts(bot, ob2) } catch {}
      if (!Object.keys(left).length) {
        try {
          await bot.dig(ob2); await collectDrops(bot, 4)
          forgetInfra('chest', e)
          consolidated++
          dbg('  consolidate: field chest at ' + e.x + ',' + e.z + ' emptied + packed up')
        } catch (err) { dbg('  consolidate: empty chest pickup failed (' + err.message + ')') }
      } else dbg('  consolidate: field chest not empty after trips - leaving it standing (pack full?)')
    } else { forgetInfra('chest', e); consolidated++ }
    // bank whatever the ferry left in the pack before moving to the next chest
    try { const bb = bankBlk(); if (bb && /chest/.test(bb.name)) await depositMaterials(bot, bb, { keepDirt: 8, all: true }) } catch {}
  }
  if (consolidated) say(`bank consolidated - ${consolidated} field chest(s) moved into the hut`)
  return consolidated
}

// ---- FURNISH THE HUT (operator: "wheres the bed crafting table and furnace?"): the
// camp's loose infra moves indoors with the bank. Furnace and table get dug up and
// re-placed inside; the remembered bed is relocated and re-activated (spawn re-set).
// 6-wide footprint (via the model), not the old +4 (5-wide) box that misclassified the
// far wall row - used to tell an IN-hut station/chest from a field one.
const insideHutBox = (p, hut) => hutModel.inBox(hut, p.x, p.z)
// The doorway rim column, as a Vec3 at the door-lower / feet cell (anchor.y+1, the cell a
// bot actually stands in to cross the threshold), or null - derived from the self-structure
// model (schema-correct 6-wide rim, not the old 5-wide dx/dz 0..4 scan). anchor.y is the
// floor plank slab, so the walkable door cell is hut.y+1.
function findHutDoorway (bot, hut) {
  const d = hutModel.doorwayColumn(hut, hutReader(bot), { preferDoorBlock: process.env.DOOR_CROSS_GEOMETRIC !== '0' })
  return d ? new Vec3(d.x, hut.y + 1, d.z) : null
}
// Standable FREE interior cells (Vec3s), from the model: the CORRECT 4x4 interior (dx/dz
// 1..4), floor-level only, threshold excluded, sorted furthest-from-door. The old scan was
// a 3x3 (dx/dz 1..3) that missed the very cells the bot wedged in, and could return a cell
// perched on a furniture/dirt pile.
function hutFreeCells (bot, hut) {
  return hutModel.freeStandCells(hut, hutReader(bot)).map(c => new Vec3(c.x, c.y, c.z))
}
const HUT_FURNITURE = /chest$|barrel$|furnace$|smoker$|crafting_table$|_bed$|_door$/
// Is a block of kind `itemRe` already standing inside the hut interior? Scans the correct
// 4x4x(5) interior via the model, so a duplicate at dx/dz 4 (missed by the old 3x3) is seen.
function furnitureInHut (bot, hut, itemRe) {
  const read = hutReader(bot)
  for (const [x, z] of hutModel.interiorColumns(hut)) for (let dy = 0; dy < hutModel.DIMS.h; dy++) {
    const b = read(x, hut.y + dy, z)
    if (b && itemRe.test(b.name)) return new Vec3(x, hut.y + dy, z)
  }
  return null
}
async function furnishHut (bot, hut, { isStopped = () => false, say = () => {} } = {}) {
  const moved = []
  // MAINTENANCE, MODEL-DRIVEN: level the floor (fill real holes ONLY, never dump filler
  // into interior air), dig stray dirt/cobble (incl. head-height pillar remnants), remove
  // DUPLICATE stations, and reconcile the registry - all via the schema-correct 4x4 model
  // with a verified postcondition. This replaces the old hand-rolled floor/dedupe/declutter
  // passes that scanned a 3x3 (missing dx/dz 4) and could place filler at interior air.
  try { const r = await cleanupHutInterior(bot, hut, { isStopped, say }); if (r && (r.dug || r.removedDupes)) moved.push('tidy'); dbg('  furnish: interior maintained (' + JSON.stringify({ dug: r && r.dug, dupes: r && r.removedDupes, ok: r && r.ok }) + ')') } catch (e) { dbg('  furnish: interior maintenance failed (' + e.message + ')') }
  const grab = async (kind, nameRe) => { // dig a remembered outdoor one and pocket it
    if (furnitureInHut(bot, hut, nameRe)) return false // already have one inside - don't fetch another
    const e = listInfra(kind, bot).find(x => Math.hypot(x.x - hut.x, x.z - hut.z) <= 60 && !insideHutBox(x, hut))
    if (!e) return false
    const blk = bot.blockAt(new Vec3(e.x, e.y, e.z))
    if (!blk || !nameRe.test(blk.name)) { forgetInfra(kind, listInfra(kind).find(x => x.x === e.x && x.y === e.y && x.z === e.z)); return false }
    if (bot.entity.position.distanceTo(blk.position) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(e.x, e.y, e.z, 2), 30000) } catch { return false } }
    const tool = toolForBlock(bot, /furnace/.test(blk.name) ? 'stone' : 'oak_planks')
    if (tool) await bot.equip(tool, 'hand').catch(() => {})
    try { await bot.dig(blk); await collectDrops(bot, 4) } catch (err) { dbg('  furnish: could not dig ' + kind + ' (' + err.message + ')'); return false }
    forgetInfra(kind, listInfra(kind).find(x => x.x === e.x && x.y === e.y && x.z === e.z))
    return true
  }
  const placeInside = async (kind, itemRe) => {
    if (!(bot.inventory ? bot.inventory.items() : []).some(i => itemRe.test(i.name))) return false
    if (furnitureInHut(bot, hut, itemRe)) { dbg('  furnish: ' + kind + ' already inside - not duplicating'); return false }
    const cell = hutFreeCells(bot, hut)[0]
    if (!cell) { dbg('  furnish: no free cell for the ' + kind); return false }
    if (bot.entity.position.distanceTo(cell) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(cell.x, cell.y, cell.z, 2), 20000) } catch {} }
    if (!await placeAt(bot, cell, itemRe)) { dbg('  furnish: could not place ' + kind + ' - ' + (placeAt.lastFail || '?')); return false }
    rememberInfra(kind, cell); moved.push(kind)
    return true
  }
  try { if (await grab('furnace', /furnace/)) await placeInside('furnace', /^furnace$/) } catch (e) { dbg('  furnish: furnace move failed (' + e.message + ')') }
  try {
    let haveTable = (bot.inventory ? bot.inventory.items() : []).some(i => i.name === 'crafting_table')
    if (!haveTable) haveTable = await grab('table', /crafting_table/)
    if (haveTable) await placeInside('table', /^crafting_table$/)
  } catch (e) { dbg('  furnish: table move failed (' + e.message + ')') }
  // BED last and only when it's SAFE: digging the bed clears the spawn point until it's
  // re-placed and used - dying in that window means a world-spawn respawn far away.
  try {
    // A bed shoved into the doorway/threshold gets RELOCATED (operator: "it placed its
    // bed inside the door frame") - dig with pickup-verify; the placement below re-sites
    // it on the doorway-aware cells.
    const dw = findHutDoorway(bot, hut)
    if (dw) {
      const thr = new Vec3(dw.x + (dw.x === hut.x ? 1 : dw.x === hut.x + 4 ? -1 : 0), dw.y, dw.z + (dw.z === hut.z ? 1 : dw.z === hut.z + 4 ? -1 : 0))
      for (const p of [dw, thr]) {
        const b = bot.blockAt(p)
        if (b && /_bed$/.test(b.name)) {
          dbg('  furnish: bed is blocking the doorway - relocating it')
          if (bot.entity.position.distanceTo(p) > 4) { try { await gotoWithTimeout(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 20000) } catch {} }
          try {
            await bot.dig(b)
            for (let tries = 0; tries < 4 && !(bot.inventory ? bot.inventory.items() : []).some(i => /_bed$/.test(i.name)); tries++) { await collectDrops(bot, 6); await new Promise(r => setTimeout(r, 500)) }
            if ((bot.inventory ? bot.inventory.items() : []).some(i => /_bed$/.test(i.name))) forgetBed() // memory points at the dug spot
          } catch (e) { dbg('  furnish: doorway-bed dig failed (' + e.message + ')') }
          break
        }
      }
    }
    const kb = knownBed()
    if (kb && !insideHutBox(kb, hut) && Math.hypot(kb.x - hut.x, kb.z - hut.z) <= 150 && (bot.health || 20) >= 12 && !isNight(bot)) {
      await walkStaged(bot, kb.x, kb.z, { isStopped, range: 4, timeoutMs: 120000 })
      const bblk = bot.findBlock({ matching: b => /_bed$/.test(b.name), maxDistance: 6 })
      if (bblk) {
        try {
          await bot.dig(bblk)
          // VERIFY the bed ITEM is in the pack before moving on - a restart cut the
          // pickup off once and the bed despawned on the ground (spawn point lost, live).
          for (let tries = 0; tries < 4 && !(bot.inventory ? bot.inventory.items() : []).some(i => /_bed$/.test(i.name)); tries++) {
            await collectDrops(bot, 6)
            await new Promise(r => setTimeout(r, 500))
          }
          if ((bot.inventory ? bot.inventory.items() : []).some(i => /_bed$/.test(i.name))) forgetBed()
          else { say('i broke my bed and LOST it - i need a new one'); dbg('  furnish: bed item never landed in the pack') }
        } catch (e) { dbg('  furnish: bed dig failed (' + e.message + ')') }
      }
    }
    const bedItem = (bot.inventory ? bot.inventory.items() : []).find(i => /_bed$/.test(i.name))
    if (bedItem) {
      await walkStaged(bot, hut.x + 2, hut.z + 2, { isStopped, range: 4, timeoutMs: 120000 })
      // try up to 3 candidate pairs, VERIFYING the bed actually stands each time - a
      // phantom-swallowed placeBlock left the bed silently in the pack (live, no log line)
      const cells = hutFreeCells(bot, hut)
      let placedBed = false
      for (let attempt = 0; attempt < 3 && !placedBed && !isStopped(); attempt++) {
        let foot = null; let head = null
        for (const c of cells.slice(attempt)) { const n = cells.find(o => o.y === c.y && Math.abs(o.x - c.x) + Math.abs(o.z - c.z) === 1); if (n) { foot = c; head = n; break } }
        if (!foot) { dbg('  furnish: no 2-cell space for the bed'); break }
        // STAND OFF the bed's two cells before placing - the server rejects a bed placed
        // into the space the placer occupies (every attempt blockUpdate-timed-out, live)
        const stand = cells.find(c => !(c.x === foot.x && c.z === foot.z) && !(c.x === head.x && c.z === head.z) && Math.abs(c.x - foot.x) + Math.abs(c.z - foot.z) <= 3)
        if (stand) { try { await gotoWithTimeout(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), 12000) } catch {} }
        else if (bot.entity.position.distanceTo(foot) > 3) { try { await gotoWithTimeout(bot, new goals.GoalNear(foot.x, foot.y, foot.z, 2), 15000) } catch {} }
        if (Math.floor(bot.entity.position.x) === foot.x && Math.floor(bot.entity.position.z) === foot.z) { dbg('  furnish: still standing on the bed cell - skipping this spot'); continue }
        const below = bot.blockAt(foot.offset(0, -1, 0))
        await bot.equip(bedItem, 'hand')
        try { await bot.lookAt(head.offset(0.5, 0.5, 0.5), true) } catch {}
        try { await bot.placeBlock(below, new Vec3(0, 1, 0)) } catch (e) { dbg('  furnish: bed place failed (' + e.message + ')') }
        await new Promise(r => setTimeout(r, 400))
        const nb = bot.blockAt(foot)
        if (nb && /_bed$/.test(nb.name)) {
          try { await bot.activateBlock(nb) } catch {} // day = sets spawn; night = sleeps
          rememberBed(foot); moved.push('bed'); placedBed = true
        } else dbg('  furnish: bed did not land at ' + foot.toString() + ' - trying another spot')
      }
    }
  } catch (e) { dbg('  furnish: bed move failed (' + e.message + ')') }
  // DOOR the doorway (operator: "no door on its hut so mobs and creepers can still
  // enter"): the shell schematic leaves a 2-high hole but owns no door block.
  try {
    let hasDoor = false
    for (let dx = 0; dx <= 4 && !hasDoor; dx++) {
      for (let dz = 0; dz <= 4 && !hasDoor; dz++) {
        for (let dy = 1; dy <= 2 && !hasDoor; dy++) {
          const b = bot.blockAt(new Vec3(hut.x + dx, hut.y + dy, hut.z + dz))
          if (b && /_door$/.test(b.name)) hasDoor = true
        }
      }
    }
    if (!hasDoor) {
      const doorway = (() => {
        const d = findHutDoorway(bot, hut)
        if (!d) return null
        const lo = bot.blockAt(d); const hi = bot.blockAt(d.offset(0, 1, 0)); const floor = bot.blockAt(d.offset(0, -1, 0))
        return (lo && AIRISH(lo.name) && hi && AIRISH(hi.name) && floor && floor.boundingBox === 'block') ? d : null
      })()
      if (doorway) {
        let door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name))
        if (!door) { try { await runCraft(bot, 'oak_door', 1, true, { isStopped, home: { x: hut.x, y: hut.y, z: hut.z } }) } catch (e) { dbg('  furnish: cannot craft a door (' + e.message + ')') } }
        door = (bot.inventory ? bot.inventory.items() : []).find(i => /_door$/.test(i.name))
        if (door) {
          // stand OUTSIDE the gap facing the hut centre so the door hangs the right way
          const ox = doorway.x === hut.x ? -1 : doorway.x === hut.x + 4 ? 1 : 0
          const oz = doorway.z === hut.z ? -1 : doorway.z === hut.z + 4 ? 1 : 0
          try { await gotoWithTimeout(bot, new goals.GoalBlock(doorway.x + ox, doorway.y, doorway.z + oz), 15000) } catch {}
          try { await bot.lookAt(new Vec3(hut.x + 2.5, hut.y + 1.5, hut.z + 2.5), true) } catch {}
          const floor = bot.blockAt(doorway.offset(0, -1, 0))
          await bot.equip(door, 'hand')
          try { await bot.placeBlock(floor, new Vec3(0, 1, 0)); moved.push('door') } catch (e) { dbg('  furnish: door place failed (' + e.message + ')') }
        }
      } else dbg('  furnish: no doorway hole found to hang a door in')
    }
  } catch (e) { dbg('  furnish: door failed (' + e.message + ')') }
  // THRESHOLD APRON (operator: "hole in front of its door, it struggles entering"): the
  // 2 cells just outside the doorway get levelled to the door's floor so the bot walks
  // in and out flat. Runs every furnish, so a pit dug there later self-heals.
  try {
    const dwF = findHutDoorway(bot, hut)
    if (dwF) {
      const ox = dwF.x === hut.x ? -1 : dwF.x === hut.x + 4 ? 1 : 0
      const oz = dwF.z === hut.z ? -1 : dwF.z === hut.z + 4 ? 1 : 0
      const floorY = dwF.y - 1 // solid surface the door sits on
      // stand at the doorway (inside the door cell) so we can reach the apron pit from
      // above and build it up toward us - the bot can't stand IN the pit to fill it
      try { await gotoWithTimeout(bot, new goals.GoalBlock(dwF.x, dwF.y, dwF.z), 15000) } catch {}
      for (let step = 1; step <= 2 && !isStopped(); step++) {
        const ax = dwF.x + ox * step; const az = dwF.z + oz * step
        // clear anything blocking the 2-high walkway at floor level and above
        for (const dy of [0, 1]) {
          const b = bot.blockAt(new Vec3(ax, dwF.y + dy, az))
          if (b && !AIRISH(b.name) && canBreakNaturally(b)) {
            try {
              if (bot.entity.position.distanceTo(b.position) > 4) await gotoWithTimeout(bot, new goals.GoalNear(ax, dwF.y + dy, az, 2), 8000)
              const t = toolForBlock(bot, b.name); if (t) await bot.equip(t, 'hand').catch(() => {})
              await bot.dig(b); await collectDrops(bot, 2)
            } catch {}
          }
        }
        // fill the pit from the BOTTOM up to floor level (416,63 AND 416,64 were both air -
        // a single top placement had no support and failed, live). Find the lowest air
        // cell sitting on something solid and stack dirt upward.
        let guard = 7
        while (guard-- > 0 && !isStopped()) {
          const top = bot.blockAt(new Vec3(ax, floorY, az))
          if (top && !AIRISH(top.name) && !/water/.test(top.name)) break // walkway complete
          let py = floorY
          while (py > floorY - 6) {
            const here = bot.blockAt(new Vec3(ax, py, az)); const below = bot.blockAt(new Vec3(ax, py - 1, az))
            if (here && (AIRISH(here.name) || /water/.test(here.name)) && below && below.boundingBox === 'block') break
            py--
          }
          if (py <= floorY - 6) break // no solid base within reach - give up on this cell
          if (!await placeAt(bot, new Vec3(ax, py, az), /^(dirt|coarse_dirt|cobblestone)$/)) break
        }
      }
      dbg('  furnish: threshold apron levelled in front of the door')
    }
  } catch (e) { dbg('  furnish: threshold apron failed (' + e.message + ')') }
  if (moved.length) say('hut furnished - ' + moved.join(' + ') + ' moved indoors')
  return moved.length
}

// Read chest contents as { name: count } (build materials the chest is holding).
async function chestCounts (bot, chestBlock) {
  await gotoChest(bot, chestBlock)
  const chest = await bot.openContainer(chestBlock)
  const out = {}
  try { for (const i of chest.containerItems()) out[i.name] = (out[i.name] || 0) + i.count } finally { chest.close() }
  return out
}

module.exports = { GATHER_SOURCES, GATHER_TOOL, SMELT_MAP, STRIP_MAP, planProvision, smeltFuelPlan, inventoryCounts, runGather, runCraft, runSmelt, runStrip, runPlan, branchMine, digStaircaseDown, ensureTable, ensureFurnace, ensureChest, depositMaterials, withdrawItem, chestCounts, detectWood, KEEP_ON_BOT, climbToSurface, pillarUpTo, manualHopFromWater, breachWaterPocket, breachDryPocket, toolForBlock, migrateChestInto, consolidateBank, furnishHut, placeChestOriented, healBankDouble, hasSolidCeiling, insideOwnStructure, ownHutAt, onHutApron, healHomeCrater, gatherLeather, freeInteriorCell, reconcileInfra, cleanupHutInterior, stationInHut, stationSlot, maintainHut, maintainHome, hutAnchor, repairHutStructure, huntForFood, hasFood, needsFood, secureFood, isSecuringFood, boundedHold, recoverFromDegraded, isRecoveringDegraded, eatBestFood, scoutForWater, digInForNight, nightRest, nightRestWanted, restUntilSafe, isResting, recoverHp, isRecoveringHp, rememberBed, knownBed, ensureSpawnBed, recoverSpawnAnchor, homeRecoveryDecision, recoverHome, setSpawnSuspect, isSpawnSuspect, markBedUnusable, bedHeld, gearupState, gearupResult, isSheltering, shelterNeeded, isNight, nightStuck, underArmored, furnaceCountFor, countFurnacesNear, ensureFurnaces, cookRawMeat, dumpJunk, listInfra, rememberInfra, forgetInfra, noteWaterCrossing, lonelyFurnace, consolidateFurnaces, litterPatrol, ensureWheatFarm, tendWheatFarm, WHEAT_FARM_TARGET, RAW_COOKABLE, ensureFoodSupply, needFoodSupply, hasStandingFarm, scoutForFood, fishForFood, ensureHutApron, ensureHutBed, foodCount, survivalState, survivalNeed, mayDoProgress, schedulerState, lowHpCalm, setBuildZone, setDebugSink, rememberRoute, recallRoute, planTrekRoute, dementRoute, recordWedge, listWedges, ownInfraAnchors,
  maintenancePass, isMaintaining, stopMaintenance, _setMaintaining, courierFoodToBank, safekeepSweep, spareKitToBank, recoveryReadyNow, cropExclusionStep, cropPlaceExclusion, hazardStepExclusion, waterStepExclusion, deepWaterUnderfoot, gatherSeedsNear,
  activeJobInfo, stopSurvivalJob, escalateFoodFloor, _foodFloorState,
  wildTerrainMovements, trekMovements, DIGGABLE_NATURAL, STRUCTURE_RE, canBreakNaturally,
  collectDrops, huntSpiderForString, ensureFishingRod, isBankStand }
