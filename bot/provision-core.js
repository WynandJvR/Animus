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

let dbgSink = null // forwarded from provision.js's setDebugSink
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const AIRISH = n => n === 'air' || n === 'cave_air' || n === 'void_air'

const REPLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass)$/

const SHELTER_HOSTILE = /zombie|skeleton|spider|creeper|husk|drowned|witch|pillager|vindicator|stray|bogged|phantom|slime|enderman|silverfish|cave_spider|warden/

function inventoryCounts (bot) {
  const out = {}
  for (const i of (bot.inventory ? bot.inventory.items() : [])) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

function countItem (bot, name) { return inventoryCounts(bot)[name] || 0 }

function isNight (bot) { return !!(bot.time && bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 23500) }

function nearHostile (bot, r) {
  const me = bot.entity && bot.entity.position; if (!me) return false
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
    if (!SHELTER_HOSTILE.test((e.name || '').toLowerCase())) continue
    if (e.position.distanceTo(me) <= r) return true
  }
  return false
}

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

function gotoWithTimeout (bot, goal, ms) {
  return navigate.gotoOnce(bot, goal, ms)
}

async function collectDrops (bot, radius = 10, { patience = 1 } = {}) {
  await new Promise(r => setTimeout(r, 250)) // let freshly-broken drops settle/land
  let empties = 0
  const unreachable = new Set() // #82: items a goto failed on - skip them, never abort the sweep
  for (let n = 0; n < 20; n++) {
    let target = null; let best = radius
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e.name !== 'item') continue
      if (unreachable.has(e.id)) continue
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
    if (process.env.COLLECT_ROBUST !== '0') {
      // #82 COLLECT_ROBUST: (a) range 1, not 0 - farm drops sit ON FARMLAND, which the
      // anti-trample movement exclusion refuses to path INTO, so every range-0 goto to a farm
      // drop failed; standing in the ADJACENT cell is inside the pickup magnet and tramples
      // nothing. (b) a failed goto skips THAT item and keeps sweeping - the old catch{return}
      // let one unpathable drop abandon the whole field (live: harvested 22 -> wheat 4).
      try { await gotoWithTimeout(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1), 10000) } catch (e) { dbg('  collect: goto drop at ' + Math.round(target.position.x) + ',' + Math.round(target.position.y) + ',' + Math.round(target.position.z) + ' failed (' + e.message + ') - skipping it'); unreachable.add(target.id); continue }
    } else {
      try { await gotoWithTimeout(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 0), 10000) } catch { return }
    }
    await new Promise(r => setTimeout(r, 250))
  }
}

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

// Natural-terrain break test: diggable terrain that is NOT part of a built structure.
// Shared - nav-profile.js reasons about the same distinction.
const STRUCTURE_RE = /planks$|stairs$|_slab$|fence|_door$|trapdoor$|_wall$|glass|_bed$|torch|lantern|crafting_table|^furnace$|chest|barrel|bookshelf|ladder|_sign$|_carpet$|wool$|brick|cobblestone|_wood$|smooth_|polished_|composter|loom|^bell$|dirt_path|farmland|hay_block|stripped_/

const DIGGABLE_NATURAL = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|moss_block|stone|deepslate|granite|diorite|andesite|tuff|calcite|dripstone_block|pointed_dripstone|sand|red_sand|gravel|clay|mud|sandstone|red_sandstone|snow_block|snow|powder_snow|ice|packed_ice|blue_ice|frosted_ice|netherrack|soul_sand|soul_soil|magma_block|blackstone|basalt|end_stone)$|terracotta$|_ore$/

function canBreakNaturally (block) { return !!block && DIGGABLE_NATURAL.test(block.name) && !STRUCTURE_RE.test(block.name) }

module.exports = {
  setDebugSink,
  AIRISH, REPLACEABLE, SHELTER_HOSTILE, STRUCTURE_RE, DIGGABLE_NATURAL, canBreakNaturally,
  inventoryCounts, countItem, isNight, nearHostile, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt
}
