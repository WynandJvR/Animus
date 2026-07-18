'use strict'
// MINING: getting down to the iron zone and back up alive. Shafts, staircases, the branch
// mine, torching, pick self-sufficiency, and the vertical-escape primitives (climbToSurface,
// pillarUpTo). Split out of provision.js unchanged.
//
// mining.js holds the PURE model - depth bands, descent-safety classification, branch
// geometry. This is the executor that digs it, and the two are deliberately separate: the
// geometry is unit-tested offline, the digging needs a world.
//
// The vertical primitives live here rather than in provision-core because they are mining's
// own escape hatches (a shaft you dug is a shaft you must climb out of), and because
// climbToSurface pulls the same dig-safety rules as the descent.
//
// UPWARD CALLS: this layer legitimately consults the survival/food side before committing
// to a long dig (topUpFoodForPlan, foodPlanNow, secureFood, survivalNeed) and the scaffold
// gate while placing. Public ones resolve through a lazy require of provision.js; the
// internal ones come from provision.js's __siblings bridge, which exists precisely so this
// file does not have to widen provision's public API to reach them.

const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const mining = require('./mining.js')       // PURE depth model + branch geometry
const navigate = require('./navigate.js')
const scaffold = require('./scaffold.js')
const provCore = require('./provision-core.js')
const { AIRISH, REPLACEABLE, canBreakNaturally, countItem, inventoryCounts, toolForBlock,
  gotoWithTimeout, collectDrops, stepInto, placeAt, nearHostile, isNight, SHELTER_HOSTILE,
  STRUCTURE_RE } = provCore
const worldMemory = require('./world-memory.js')
const { loadWorldMem, saveWorldMem, loadMines, rememberMine, recallMine, forgetMine,
  updateMineProgress, listInfra, rememberInfra, recallInfra } = worldMemory
const provFarm = require('./provision-farm.js')
const { cropExclusionStep, cropPlaceExclusion } = provFarm
const provHut = require('./provision-hut.js')
const { hutAnchor, insideOwnStructure, hasSolidCeiling, onHutApron, stepOffApron } = provHut

const P = () => require('./provision.js')          // public provisioning surface, at call time
const S = () => require('./provision.js').__siblings // internals shared between provision-* modules

let dbgSink = null // forwarded from provision.js's setDebugSink
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[prov] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
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
    if (!canBreakNaturally(b) && !S().scaffoldDigOK(b)) return false // anti-grief: don't cut through a player build (own registry-proven scaffold allowed under NAV_TERRAIN_PROFILE)
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
        if (!canBreakNaturally(above) && !S().scaffoldDigOK(above)) { bot.clearControlStates(); return } // anti-grief: don't pillar up through a build (own registry-proven scaffold allowed under NAV_TERRAIN_PROFILE)
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
    // #56 FARM_EXCLUDE_YFIX (defense-in-depth): never lay a pillar block on our own wheat-farm
    // footprint (a crop cell / its farmland / the block above) - bricking it kills+floods the crop.
    if (scaffold.onFarmFootprint(feet)) { dbg('  pillar: feet on wheat-farm footprint - refusing to pillar over crops'); bot.clearControlStates(); return }
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

async function mineTunnel (bot, itemName, maxLen, dirIdx, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const DANGER = /lava|water/
  const DIRS = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]
  const dir = DIRS[((dirIdx % 4) + 4) % 4]
  const before = countItem(bot, itemName)
  const FLUID = process.env.MINE_FLUID !== '0'
  const LAVA_SAFE = process.env.LAVA_SAFE !== '0' // #41: close residual holes (ceiling pocket above the new head; FLUID - not just open air - beyond the face)
  const SWEEP_EVERY = parseInt(process.env.MINE_SWEEP_EVERY || '4', 10)
  const TORCH_EVERY = parseInt(opts.torchEvery || 0, 10) // #71: >0 -> light INSIDE the tunnel every Nth block (naked bootstrap only); 0 -> today's no-in-tunnel-torching
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
    // #71 ARMOR_BOOTSTRAP: light the freshly-dug naked tunnel every Nth block so mobs can't spawn on
    // it. Best-effort (placeTorch no-ops when out of torches - never blocks the dig). Off by default.
    if (TORCH_EVERY > 0 && mining.sweepDue(i, TORCH_EVERY)) { try { await placeTorch(bot) } catch {} }
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

function miningPicks (bot) {
  return (bot.inventory ? bot.inventory.items() : [])
    .filter(i => /(stone|iron|diamond|netherite)_pickaxe$/.test(i.name))
    .map(i => ({ item: i, usesLeft: mining.pickUsesLeft(i.name, i.durabilityUsed || 0) }))
}

function bestPick (bot) { let b = null; for (const p of miningPicks(bot)) if (p.usesLeft > 0 && (!b || p.usesLeft > b.usesLeft)) b = p; return b }

function workingPickCount (bot) { return miningPicks(bot).filter(p => p.usesLeft > 0).length }

function workingMiningPick (bot) { return !!bestPick(bot) }

function carriedPickUsesLeft (bot) { return miningPicks(bot).reduce((s, p) => s + p.usesLeft, 0) }

async function craftOneFromInv (bot, itemName, tableBlock = null) {
  const mcData = require('minecraft-data')(bot.version)
  const it = mcData.itemsByName[itemName]; if (!it) return false
  const rec = (bot.recipesFor(it.id, null, 1, tableBlock) || [])[0]
  if (!rec) return false
  const before = countItem(bot, itemName)
  try { await bot.craft(rec, 1, tableBlock || undefined); await new Promise(r => setTimeout(r, 150)) } catch { return false }
  return countItem(bot, itemName) > before
}

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
    try { pos = await S().placeFromInventory(bot, 'crafting_table') } catch {}
    tb = pos ? bot.blockAt(pos) : bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 })
  }
  if (!tb) { dbg('  reTool: could not place a table at depth'); return false }
  // 4) craft the pick at the local table
  const ok = await craftOneFromInv(bot, 'stone_pickaxe', tb)
  if (ok) dbg('  reTool: crafted a fresh stone pickaxe at depth (y=' + Math.floor(bot.entity.position.y) + ')')
  return ok && workingMiningPick(bot)
}

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

async function enterExistingMine (bot, mine, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const here = bot.entity.position
  // 1) to the entrance XZ at the surface (staged trek for a far mine)
  if (Math.hypot(here.x - mine.x, here.z - mine.z) > 4) {
    try { await S().walkStaged(bot, mine.x, mine.z, { isStopped, range: 3, timeoutMs: 60000 }) } catch {}
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
  if (S().inWaterNow(bot)) { dbg('  reEnter: mine is flooded - abandoning it'); return false }
  // 3) to the corridor tip so we mine FRESH stone, not re-walk the open corridor
  if (mine.tip) { try { await gotoWithTimeout(bot, new goals.GoalNear(mine.tip.x, mine.tip.y, mine.tip.z, 2), 30000) } catch {} }
  dbg('  reEnter: back in my mine at y' + Math.floor(bot.entity.position.y) + ' (level ' + mine.level + ', ' + (mine.branches || 0) + ' branches done) - MINING, not re-digging')
  return true
}

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
  // #71 ARMOR_BOOTSTRAP: while fully naked and short of a boots' worth of raw iron, mine a SHALLOW
  // safe band (far fewer skeletons/creepers than y<40) and retreat from ANY hostile within the wider
  // retreat band. Recomputed via bootNow() through the loop (armor/iron change). Flag off / armored /
  // has-boots'-iron -> inactive => the descent target + retreat gate are today's, byte-for-byte.
  const bootCfg = {
    enabled: process.env.ARMOR_BOOTSTRAP !== '0',
    bootsIron: parseInt(process.env.ARMOR_BOOTSTRAP_IRON || '4', 10),
    ymin: parseInt(process.env.ARMOR_BOOTSTRAP_YMIN || '45', 10),
    ymax: parseInt(process.env.ARMOR_BOOTSTRAP_YMAX || '58', 10),
    retreatDist: parseInt(process.env.ARMOR_BOOTSTRAP_RETREAT_DIST || '10', 10)
  }
  const bootNow = () => mining.armorBootstrapMining(S().armorPieceCount(bot), countItem(bot, 'raw_iron'), bootCfg)
  const boot0 = bootNow()
  const plan = mining.deepMinePlan(S().armorPieceCount(bot), {
    targetY: process.env.IRON_TARGET_Y != null ? parseInt(process.env.IRON_TARGET_Y, 10) : undefined,
    // bootstrapping -> the shallow-band floor overrides the naked target (y28); else today's exactly.
    nakedY: boot0.active ? boot0.targetY : (process.env.MINE_NAKED_Y != null ? parseInt(process.env.MINE_NAKED_Y, 10) : undefined)
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
  dbg('  branchMine: item=' + item + ' need=' + count + ' surfaceY=' + surfaceY + ' targetY=' + targetY + ' minIronY=' + minIronY + (boot0.active ? ' [ARMOR_BOOTSTRAP: shallow band y' + boot0.ymin + '-' + boot0.ymax + ', retreat<=' + boot0.retreatDist + 'b]' : ''))

  // #64 §C DYNAMIC_FOOD: leave home STOCKED for the descent. Size the ration to the KNOWN descent
  // target (depth = surfaceY - targetY - you can't nip home from y16 to eat) and top up the shortfall
  // from the bank (bounded, bank-first, fail-safe) BEFORE going down. Also mark the imminent deep-mine
  // (_foodPlanHint) so the pre-mine secureFood's own courier keeps the TRIP ration instead of
  // stripping food to the home baseline right as we descend (§C's "don't courier food away when an
  // excursion is imminent" guard). Restored before every path that leaves the arbiter. DYNAMIC_FOOD=0
  // -> no top-up, hint inert (courier falls back to the fixed FOOD_PACK_RESERVE - byte-for-byte #62).
  let _minePlanHintPrev = null; const _dynFood = process.env.DYNAMIC_FOOD !== '0'
  if (_dynFood) {
    const minePlan = S().foodPlanNow(bot, null, { activity: 'deep-mine', depth: Math.max(0, Math.floor(surfaceY) - targetY) })
    _minePlanHintPrev = S()._setFoodPlanHint(minePlan)
    if (!isStopped()) { try { await S().topUpFoodForPlan(bot, minePlan, { home: opts.home, isStopped }) } catch {} }
  }

  // JOB ARBITER (survive > progress): a progress job (deep mining) may not START while an
  // unmet SURVIVE need exists - the ONE authority replaces the old scattered food<14 check.
  // If the need is food, resolve it (secureFood) and re-check; any other need (threat/hp/lava/
  // shelter) -> yield the excursion so the survival reflexes handle it, resume next pass.
  {
    let need = P().survivalNeed(bot) // start-gate: foodThreshold 14
    if (need && !isStopped()) {
      dbg('  branchMine: SURVIVE need before descending: ' + need.need + ' (' + need.reason + ') - resolving before progress')
      if (need.need === 'food') {
        if (opts.say) say('too hungry to mine deep - eating first')
        try { await P().secureFood(bot, { home: opts.home, isStopped, say: opts.say, threshold: 14 }) } catch (e) { dbg('  branchMine: pre-mine secureFood failed (' + e.message + ')') }
        need = P().survivalNeed(bot)
      }
      if (need) { if (_dynFood) S()._setFoodPlanHint(_minePlanHintPrev); return { gathered: got(), reason: 'yielding to survival need (' + need.need + ') before descending - resume when met' } }
    }
  }
  // Past the pre-descent guard window: from here the descent puts the bot underground, where the
  // courier's physical-state read (depth>=DFOOD_DEEP) already sizes the deep-mine ration - so the
  // explicit hint is only needed for the surface pre-descent secureFood above. Restore it now.
  if (_dynFood) S()._setFoodPlanHint(_minePlanHintPrev)

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
  // #71: bootstrapping -> carry MORE torches and light the branches every few blocks (not just at
  // junctions) so nothing spawns on the freshly-dug naked tunnel. torchEvery=0 => today's cadence.
  const bootTorchEvery = boot0.active ? parseInt(process.env.ARMOR_BOOTSTRAP_TORCH_EVERY || '3', 10) : 0
  await ensureTorches(bot, boot0.active ? Math.max(plan.wantTorches, parseInt(process.env.ARMOR_BOOTSTRAP_TORCHES || '16', 10)) : plan.wantTorches)
  const L = mining.branchLayout(corridorDir, {
    branchLen: parseInt(process.env.MINE_BRANCH_LEN || '12', 10),
    spacing: parseInt(process.env.MINE_SPACING || '3', 10)
  })
  let branches = startBranches
  const maxBranches = startBranches + (opts.maxBranches || plan.maxBranches)
  while (got() < count && Date.now() < deadline && !isStopped() && branches < maxBranches) {
    // #71 ARMOR_BOOTSTRAP widens the retreat: a naked first-iron bot yields the moment a hostile is
    // within the retreat band (10b) - EARLIER than mineDanger's 6b - so a skeleton can't shoot it up
    // before it climbs out. Same climb-out + honest bail as the mineDanger path (flag off -> identical).
    const bootRetreat = mining.armorBootstrapRetreat(bootNow().active, nearHostile(bot, bootCfg.retreatDist) ? bootCfg.retreatDist : null, bootCfg.retreatDist)
    if (mineDanger(bot) || bootRetreat) {
      dbg('  branchMine: threat/hp down here' + (bootRetreat && !mineDanger(bot) ? ' (naked - retreating from a hostile in the wider ' + bootCfg.retreatDist + 'b band)' : '') + ' - climbing out and handing off to the survival reflex')
      if (opts.say && branches < 2) say(bootRetreat && !mineDanger(bot) ? 'mob near and i\'ve got no armor - pulling out before it shoots me up' : 'mob down here - breaking off the mine to get clear')
      try { await climbToSurface(bot, Math.floor(surfaceY), { isStopped }) } catch {}
      return { gathered: got(), reason: 'broke off to survive a mob / low hp underground' }
    }
    // DROWNING mid-mine (a branch broke into an aquifer): get the head out of the water FIRST
    // (bounded escapeWater - drops the goal + stops the dig so the manual escape isn't stomped),
    // THEN climb out and bail honestly. Same shape as the food branch. escapeWater before
    // climbToSurface: climbToSurface's digs refuse water, so it must run only once we're clear.
    {
      const need = P().survivalNeed(bot, { foodThreshold: 6 })
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
      const need = P().survivalNeed(bot, { foodThreshold: 6 })
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
    // advance the main corridor `spacing`, then a junction: torch + left branch + right branch.
    // #71: bootTorchEvery (>0 only while bootstrapping) also lights INSIDE each tunnel every few
    // blocks so the long naked branches aren't dark spawn-corridors. 0 -> today's junction-only light.
    await mineTunnel(bot, item, L.spacing, L.corridorIdx, { isStopped, torchEvery: bootTorchEvery })
    const junc = bot.entity.position.floored()
    if (branches % L.torchEvery === 0) await placeTorch(bot).catch(() => {})
    await mineTunnel(bot, item, L.branchLen, L.leftIdx, { isStopped, torchEvery: bootTorchEvery })
    try { await gotoWithTimeout(bot, new goals.GoalBlock(junc.x, junc.y, junc.z), 15000) } catch {}
    if (got() >= count || isStopped()) break
    await mineTunnel(bot, item, L.branchLen, L.rightIdx, { isStopped, torchEvery: bootTorchEvery })
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

function mineDanger (bot) { return nearHostile(bot, 6) || (bot.health ?? 20) < 12 || (process.env.LAVA_SAFE !== '0' && !!(bot.entity && (bot.entity.isInLava || bot.entity.onFire))) }

module.exports = {
  setDebugSink,
  digShaftDown, digStaircaseUp, climbMovements, climbToSurface, pillarUpTo, mineTunnel, placeTorch, ensureTorches, miningPicks, bestPick, workingPickCount, workingMiningPick, carriedPickUsesLeft, craftOneFromInv, craftStonePickHere, ensureMiningKit, digStaircaseDown, enterExistingMine, branchMine, grabNearbyOre, mineDanger
}
