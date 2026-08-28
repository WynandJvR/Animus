'use strict'
// PROVISION CORE: the small shared primitives every provisioning job reaches for -
// inventory counts, "is this air", the tool for a block, walk-with-a-deadline, sweep up
// drops, step into a cell, place a block. Split out of provision.js unchanged.
//
// WHY THIS FILE EXISTS, AND WHY IT CAME FIRST: the refactor brief suggested splitting the
// LEAVES first (farm, mining, food, recovery). Measured against the code, that does not
// work - the wheat-farm region alone reaches for 24 provision.js bindings, most of them
// these primitives. Extracting a leaf first would mean threading two dozen injected
// helpers through it. Pulling the shared floor out first is what makes each leaf a small,
// honest module afterwards.
//
// Everything here is low-level and world-facing: it takes `bot` plus plain values and does
// one thing. No job state, no latches, no policy.
//
// DELIBERATELY NOT HERE:
//   walkStaged      - pulls 12 nav bindings (GoalNearXZBanded, NAV_HAZARD_LEGS, PROBE_MS,
//                     routeMem, climbToSurface, trekMovements...). It belongs to a nav
//                     slice of its own, not to the shared floor.
//   hasSolidCeiling - calls insideOwnStructure, which is the hut/infra layer.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder') // GoalNear, for the drop-collect walk
const navigate = require('./navigate.js') // unified navigation: ONE goto + the stuck-recovery ladder
const mining = require('./mining.js')     // PURE tool-durability model (stepInto reads it)

const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[prov]') // §4: one definition of the sink rule; this module still owns its own sink

const AIRISH = n => n === 'air' || n === 'cave_air' || n === 'void_air'

const REPLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass)$/

const SHELTER_HOSTILE = /zombie|skeleton|spider|creeper|husk|drowned|witch|pillager|vindicator|stray|bogged|phantom|slime|enderman|silverfish|cave_spider|warden/

// Current inventory as {itemName: count}.
function inventoryCounts (bot) {
  const out = {}
  for (const i of (bot.inventory ? bot.inventory.items() : [])) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

function countItem (bot, name) { return inventoryCounts(bot)[name] || 0 }

function isNight (bot) { return !!(bot.time && bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 23500) }
// FIRST LIGHT IS NOT MORNING (2026-08-27 23:50-23:52): the pit opened at tod 23400, the job resumed
// at the site, and a zombie the sun had not yet burned killed a full-hp bot in ninety seconds. The
// night's undead burn off in the first ~1000 ticks of the day; a player waits for the sun to be up.
function isFirstLight (bot) { return !!(bot.time && (bot.time.timeOfDay >= 23000 || bot.time.timeOfDay < 1000)) }

function nearHostile (bot, r) {
  const me = bot.entity && bot.entity.position; if (!me) return false
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
    if (!SHELTER_HOSTILE.test((e.name || '').toLowerCase())) continue
    if (e.position.distanceTo(me) <= r) return true
  }
  return false
}

// Pick the right tool KIND in inventory for a block (pickaxe/axe/shovel), best
// material first. Returns the item or null (bare hands).
//
// This WAS a second copy of gear.bestTool with narrower patterns, and the narrowness cost drops:
// measured against minecraft-data over all 1060 blocks in 1.21 it returned null - bare hands - for
// 110 blocks that REQUIRE a tool to drop anything (gold_block, iron_block, obsidian, furnace,
// netherrack, terracotta, anvils, bricks). This module's own callers know the stakes -
// provision-bank.js:590 says "wrong-tool digs drop NOTHING" - so the rule now has ONE definition
// in gear.js (a pure leaf; no cycle) and this is the same function under this module's name.
const gear = require('./gear.js')
const toolForBlock = gear.bestTool

// THE SHARED SHORT-HOP. This was `navigate.gotoOnce` - a single BARE pathfinder attempt with no
// door handling - and it is what nearly every provision module uses to step to a cell near home.
// The farm WRAPS the hut and the bank/furnaces sit outside it, so most of those hops cross the
// bot's own doorway, which a bare goto cannot do: it answers `No path to the goal!` for a cell
// FOUR BLOCKS away. Three separate subsystems failed on this in a single day:
//   furnace-food: could not get to 185,-106                 (c9ab8ec - patched at the call site)
//   collect: goto drop at 193,68,-95 failed (No path)       (0ae206c - patched at the call site)
//   wheat farm [dry]: cell failed (No path to the goal!)    <- 26 RIPE wheat it could not reach,
//     while the castle sat blocked on a food reserve those very crops were meant to fill
// Two call-site patches is whack-a-mole; the defect is in the primitive, so it is fixed here.
//
// navigateTo is the ONE entry point that owns the door pre-flight. `escalate: false` keeps this a
// SHORT HOP: the doorway is handled, but the full stuck-recovery ladder (and its dig-out) stays
// the property of a real navigation - so a 10-second hop can never recurse into the one rescue path (navigate.unstick).
function gotoWithTimeout (bot, goal, ms) {
  return navigate.navigateTo(bot, goal, { timeoutMs: ms, escalate: false })
}

// Walk onto nearby dropped items so they're picked up. Waits for drops to settle,
// then sweeps the nearest item repeatedly (walk ONTO it - range 0). More persistent
// than before because scattered drops on jagged terrain were being left behind.
async function collectDrops (bot, radius = 10, { patience = 1 } = {}) {
  await new Promise(r => setTimeout(r, 250)) // let freshly-broken drops settle/land
  let empties = 0
  const unreachable = new Set() // #82: items a goto failed on - skip them, never abort the sweep
  for (let n = 0; n < 20; n++) {
    let target = null; let best = radius
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e.name !== 'item') continue
      if (unreachable.has(e.id)) continue
      // A DROP IN THE WATER WITH A HOSTILE ABOUT IS NOT WORTH WADING FOR (2026-08-27). Three deaths
      // at one pond in one evening, all the same shape: a harvested wheat rolls into the farm pond,
      // this sweep walks in after it, and the Drowned living there finishes the bot. A player lets
      // a floating wheat go when something is in the water with it.
      try {
        const cell = bot.blockAt(e.position)
        if (cell && /water/.test(cell.name) && nearHostile(bot, 16)) { unreachable.add(e.id); dbg('  collect: leaving a drop in the water at ' + e.position.floored() + ' - a hostile is within 16b, not wading in'); continue }
      } catch {}
      const d = e.position.distanceTo(bot.entity.position)
      if (d < best) { best = d; target = e }
    }
    if (!target) {
      // DON'T bail on the first empty scan. A just-broken drop can take a beat to spawn/sync,
      // or land a hair outside `radius` (a wheat drop from a cell against a pond bounces toward
      // the water edge). The old early-return abandoned those drops the instant nothing was in
      // range after 250ms - the "harvested N -> wheat=0" loss. Wait + re-look `patience` times
      // before concluding there's genuinely nothing here.
      if (empties++ >= patience) {
        // #82c: before concluding, say what we're LEAVING - the harvest keeps losing ~60% of drops
        // with zero goto failures logged, so either the scan never sees them (out of `radius`) or
        // they sit somewhere specific (water channel?). This names the cells for the next fix.
        if (process.env.COLLECT_ROBUST !== '0') {
          try {
            const me = bot.entity.position
            const left = Object.values(bot.entities || {}).filter(e => e && e.position && e.name === 'item' && e.position.distanceTo(me) < radius + 12)
            if (left.length) dbg('  collect: sweep ended with ' + left.length + ' item(s) still visible: ' + left.slice(0, 5).map(e => Math.round(e.position.x) + ',' + Math.round(e.position.y) + ',' + Math.round(e.position.z) + (unreachable.has(e.id) ? '(unreach)' : '')).join(' '))
          } catch {}
        }
        return
      }
      await new Promise(r => setTimeout(r, 300))
      continue
    }
    empties = 0
    {
      // #82 COLLECT_ROBUST: (a) range 1, not 0 - farm drops sit ON FARMLAND, which the
      // anti-trample movement exclusion refuses to path INTO, so every range-0 goto to a farm
      // drop failed; standing in the ADJACENT cell is inside the pickup magnet and tramples
      // nothing. (b) a failed goto skips THAT item and keeps sweeping - the old catch{return}
      // let one unpathable drop abandon the whole field (live: harvested 22 -> wheat 4).
      // (c) THE ONE NAV ENTRY POINT, not a bare goto (2026-07-31). #82c's open question was
      // "the harvest keeps losing ~60% of drops with zero goto failures logged" - this is the
      // cause, and it now logs loudly: the farm wraps the hut, so the bot is usually INSIDE and
      // the drops are OUTSIDE, and every pickup has to cross its own door. gotoWithTimeout is a
      // bare pathfinder goto with no door handling, so it answered `No path to the goal!` for
      // items on flat ground FOUR BLOCKS AWAY. Live 2026-07-31 01:34: `harvested 6` and
      // `sweep ended with 11 item(s) still visible ... (unreach)`, while the build sat blocked
      // on a bank food reserve those very drops were supposed to fill.
      // navigate.navigateTo owns door-crossing and the recovery ladder - same fix as the furnace
      // pantry (c9ab8ec). Kept range 1 (never path INTO farmland) and the skip-on-fail sweep.
      try {
        const nav = require('./navigate.js')
        // A DROP A FEW BLOCKS AWAY IS A FEW SECONDS' WALK (2026-08-28 12:32-12:37): with no deadline the
        // leg budget grew to 40s per drop, and three unreachable drops on the crop cells / pond edge
        // cost every farm pass two minutes. The budget is the distance: ~1s per block plus a floor.
        await nav.navigateTo(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1), { timeoutMs: Math.min(10000, 2000 + Math.round(best) * 800), deadlineMs: Math.min(12000, 3000 + Math.round(best) * 1000), label: 'collect' })
      } catch (e) { dbg('  collect: goto drop at ' + Math.round(target.position.x) + ',' + Math.round(target.position.y) + ',' + Math.round(target.position.z) + ' failed (' + e.message + ') - skipping it'); unreachable.add(target.id); continue }
    }
    // The COLLECT_ROBUST=0 rollback leg is DELETED, not repaired. It was a second copy of this
    // one operation carrying BOTH original defects (range 0 -> refuses to path onto farmland;
    // catch{return} -> one unpathable drop abandons the whole field) AND the bare-goto door
    // blindness fixed above. Two implementations of one rule is how the rule drifts - the #108
    // precedent applies. Rollback is `git revert`, never a second living implementation.
    await new Promise(r => setTimeout(r, 250))
  }
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

// Place a block from inventory (name matching `match`) AT world position `target`, using any
// solid neighbouring face to place against. Best-effort; returns whether a block landed.
async function placeAt (bot, target, match) {
  placeAt.lastFail = null // observability: WHY the last placement failed (cap-fail debugging)
  const item = (bot.inventory ? bot.inventory.items() : []).find(i => match.test(i.name))
  if (!item) { placeAt.lastFail = 'no matching item in inventory'; return false }
  // THE PLACEMENT RULE, asked ONCE and BEFORE the equip (#4: the same placeBlocked
  // pathfix.verifiedPlace enforces, so there is one definition and no way to drift). Asking it
  // here as well is not a second guard - it is what turns a thrown refusal from the primitive,
  // repeated once per candidate face, into one honest lastFail line naming the blocker.
  const blocked = placeBlocked(bot, target, item.name)
  if (blocked) { placeAt.lastFail = 'refused: ' + blocked; dbg('  placeAt: REFUSING ' + item.name + ' at ' + target.toString() + ' - ' + blocked); return false }
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

// Natural-terrain break test: diggable terrain that is NOT part of a built structure.
// Shared - nav-profile.js reasons about the same distinction.
const STRUCTURE_RE = /planks$|stairs$|_slab$|fence|_door$|trapdoor$|_wall$|glass|_bed$|torch|lantern|crafting_table|^furnace$|chest|barrel|bookshelf|ladder|_sign$|_carpet$|wool$|brick|cobblestone|_wood$|smooth_|polished_|composter|loom|^bell$|dirt_path|farmland|hay_block|stripped_/

// ANTI-GRIEF for EVERY dig primitive (strip-shaft, tunnel, staircase, pillar, shelter): the
// ONLY blocks any of them may break are NATURAL terrain/ore - never a player-placed build
// block. `canBreakNaturally` is the single gate; without it the climb-out/strip-mine punch
// straight through a base's floor/wall (bot.canDigBlock is a reach/harvest test, NOT a
// protection check). Note: `cobblestone` is deliberately EXCLUDED (it's a common player
// block) - the strip-mine digs `stone` and gets cobble as the drop.
const DIGGABLE_NATURAL = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|moss_block|stone|deepslate|granite|diorite|andesite|tuff|calcite|dripstone_block|pointed_dripstone|sand|red_sand|gravel|clay|mud|sandstone|red_sandstone|snow_block|snow|powder_snow|ice|packed_ice|blue_ice|frosted_ice|netherrack|soul_sand|soul_soil|magma_block|blackstone|basalt|end_stone)$|terracotta$|_ore$/

function canBreakNaturally (block) { return !!block && DIGGABLE_NATURAL.test(block.name) && !STRUCTURE_RE.test(block.name) }

// THE ONE ANSWER TO "MAY THIS BLOCK BE REMOVED". Returns the blocker string, or null for
// permitted. Hoisted here from provision-recovery.js's local `pitBlocked` (2026-08-01) with
// the arms in the SAME order, because a second copy of a dig-permission rule is how the
// 2026-08-01 sealed-hut deadlock happened: "do not dig the hut" was written twice (geometric
// ownHutAt + material canBreakNaturally) and lifting one left the other vetoing.
//
// What is NEW here is the own-infra arm. canBreakNaturally is MATERIAL-ONLY, so it protected
// the hut's planks and never the dirt under them, and nothing anywhere was positional about
// the ground beneath registered infra. That is why 16 hut floor cells stood over air on
// 2026-08-02 and why the filler dug the 2-deep holes beside the farm that the bot then wedged
// in. Own-infra now means the hut box + its support columns + point-infra columns + the
// farm's support ring - all derived from the registry, no magic radius, no invented depth.
//
// `allowOwnInfra` is the TRAPPED carve-out, and it bypasses the own-infra arm exactly as
// `allowOwnHut` did - INCLUDING skipping the material check for those cells: a bot trapped
// under its own roof may dig its own floor AND the dirt beneath it, because the shaft's spoil
// is what pays for the climb back (provision-recovery.js). The protection therefore cannot
// entomb the bot - the trapped rung bypasses it by construction, on the same latch as before.
// The farm footprint, fluids, and other people's builds stay unconditional, trapped or not.
//
// Cheap by construction (#8): pure arithmetic over cached registry reads, first match wins,
// no world reads of its own - ensurePillarFiller calls it over up to 64 candidates.
function digBlocked (bot, cell, b, { allowOwnInfra = false } = {}) {
  const scaffold = require('./scaffold.js')
  const provFarm = require('./provision-farm.js')
  const provHut = require('./provision-hut.js')
  if (scaffold.onFarmFootprint(cell) || provFarm.farmFootprintHas(cell)) return 'farm' // #115: exclusions use the geometric predicate - they must fail PROTECTIVE
  if (!b || AIRISH(b.name)) return null
  if (/water|lava/.test(b.name)) return 'fluid'
  if (provHut.ownHutAt(cell) || provHut.ownInfraSupportAt(cell) || provFarm.farmSupportHas(cell)) return allowOwnInfra ? null : 'own-infra'
  if (!canBreakNaturally(b)) return 'build' // someone else's / protected block
  return null
}

// ==== THE PLACE MIRROR OF digBlocked (2026-08-02) =========================================
// digBlocked answers "may this block be REMOVED". Nothing anywhere answered "may a block be
// PUT HERE" - placeAt scanned six faces for anything solid to place against and never once
// asked what the placement would cover, seal or shut. That is the whole gap:
//
//   a dirt block landed at 192,69,-103, directly above the bank chest at 192,68,-103. In
//   vanilla an opaque full cube above a chest makes it unopenable, so every chest read threw
//   a genuine in-reach window failure, resources.js reported {} for that chest, and the
//   snapshot the PURE scheduler reasons from called the bank EMPTY. The operator broke the
//   block by hand. Nothing in the codebase could have refused that placement.
//
// SEALING vs NOT. What makes these cells matter is that they must stay OPENABLE or WALKABLE,
// so the question is not "is this my block" but "does this placement shut the cell". A torch,
// a sign, a carpet, a rail, a door, a trapdoor hang or lie flat and shut nothing; a full cube
// does. The allow-list is deliberately the SMALL side (fail PROTECTIVE, #115): an item nobody
// listed is treated as sealing, which costs at most a refused placement of something exotic.
const NON_SEALING_RE = /^(torch|wall_torch|soul_torch|redstone_torch|lantern|soul_lantern|ladder|vine|lever|tripwire_hook|flower_pot|end_rod|chain|[a-z_]*_(sign|banner|carpet|button|pressure_plate|rail|sapling|seeds|door|trapdoor|pane|candle|coral_fan|torch)|rail|wheat_seeds|redstone|repeater|comparator|string)$/

// THE ONE ANSWER TO "MAY A BLOCK BE PUT IN THIS CELL". Returns the blocker string, or null for
// permitted - the same shape, contract and cheapness as digBlocked above, and asked by the
// same discipline: ONE definition, every placer (provision-core.placeAt for an early honest
// refusal, and pathfix.verifiedPlace - the single wrapped placement primitive every other
// placer in the process funnels through, including mineflayer-pathfinder's own scaffolding
// and mineflayer-builder's tryPlace).
//
// ARMS, IN ORDER (first match wins), each with the exemption that makes it a rule about
// OBSTRUCTION rather than a blanket ban - a rule that could not put the door back in the
// doorway would be a bug, not a guard:
//   1. chest-headroom  the cell directly above a registered chest. Derived from the block:
//                      only the chest family needs headroom in 1.21; a furnace, a table and a
//                      barrel do not, so they are not claimed. Any NON-sealing placement is
//                      fine (a torch above a chest does not stop it opening).
//   2. bed             a registered bed cell (either half / the spawn anchor). Exempt: a bed.
//   3. door            the doorway column at the door courses. Exempt: a door.
//   4. door-approach   hutModel.approachCells - the body column just outside the doorway.
//                      Any non-sealing placement is fine.
//
// NO CARVE-OUT, DELIBERATELY, and this is the anti-entombment answer. A PLACE rule cannot trap
// the bot the way a dig rule can, so it needs no `allowOwnInfra` twin - and the two paths that
// legitimately place blocks AROUND the body (provision-shelter digInForNight -> sealShaft)
// already step 12 blocks clear of the hut apron before they dig (provision-shelter.js
// "shelter: on my hut apron - stepping clear"), so a survival pit's walls and cap cannot reach
// a reserved cell. In the one case where that step-clear walk fails and the bot pits ON its own
// doorstep, refusing is still the right answer: d4cf46c ("SEALED IN: the bot could not get out
// of its own front door") is what the other choice costs, and the refusal is logged with the
// blocker so the pit reports the hole it could not close (#7).
//
// CHEAP BY CONSTRUCTION (#8), same bar as digBlocked: arms 1-2 are pure arithmetic over cached
// registry reads. Arm 3-4 bounds-tests the hut box in arithmetic FIRST and only then consults
// the memoised doorway, so a cell anywhere but the bot's own front door costs no world read.
function placeBlocked (bot, cell, itemName) {
  if (!cell || !itemName) return null // nothing placed, nothing to refuse
  const provHut = require('./provision-hut.js')
  const seals = !NON_SEALING_RE.test(itemName)
  if (seals && provHut.containerHeadroomAt(cell)) return 'chest-headroom'
  if (provHut.ownBedCellAt(cell) && !/_bed$/.test(itemName)) return 'bed'
  const dw = provHut.doorwayReservationAt(bot, cell)
  if (dw === 'door' && !/_door$/.test(itemName)) return 'door'
  if (dw === 'approach' && seals) return 'door-approach'
  return null
}

module.exports = {
  setDebugSink,
  AIRISH, REPLACEABLE, SHELTER_HOSTILE, STRUCTURE_RE, DIGGABLE_NATURAL, canBreakNaturally, digBlocked,
  NON_SEALING_RE, placeBlocked,
  inventoryCounts, countItem, isNight, isFirstLight, nearHostile, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt
}
