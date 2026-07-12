'use strict'
// PATCH LAYER over mineflayer-pathfinder (same durable pattern as installDigTimeGuard:
// we override behavior at runtime instead of forking, so npm installs never undo it and
// upstream fixes still arrive). Each patch targets a failure we watched live.
//
// PATCH 1 - never break your own fresh scaffold. The planner re-plans mid-move and treats
// the block the bot JUST placed as an obstacle: pillar up, break own dirt, pillar again
// (operator watched the full loop). Blocks self-placed in the last 60s are off-limits to
// the planner's dig moves - it walks around/on them like anyone sane.

const RECENT_MS = 60000  // dig-guard window (the planner may not break these)
const TRAIL_MS = 1800000 // trail window - 30 min (5 min expired before slow harvests finished; towers orphaned)
const recentlyPlaced = new Map() // "x,y,z" -> timestamp

// PERSIST the trail: it lived only in memory, so every death-restart/deploy orphaned
// whatever towers stood at that moment - the operator found COBBLE scaffolds abandoned
// in the orchard after a restart-heavy morning. Loaded on boot, saved debounced.
const fs = require('fs')
const path = require('path')
const TRAIL_FILE = process.env.TRAIL_FILE || path.join(__dirname, 'scaffold-trail.json')
try {
  const saved = JSON.parse(fs.readFileSync(TRAIL_FILE, 'utf8'))
  const cut = Date.now() - TRAIL_MS
  for (const [k, t] of Object.entries(saved)) { if (t >= cut) recentlyPlaced.set(k, t) }
} catch {}
let trailTimer = null
function saveTrail () {
  if (trailTimer) return
  trailTimer = setTimeout(() => {
    trailTimer = null
    try { fs.writeFileSync(TRAIL_FILE, JSON.stringify(Object.fromEntries(recentlyPlaced))) } catch {}
  }, 2000)
}

function key (p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` }

function sweep () {
  const cut = Date.now() - TRAIL_MS
  for (const [k, t] of recentlyPlaced) { if (t < cut) recentlyPlaced.delete(k) }
  saveTrail()
}

// Point query: was THIS cell self-placed recently? The replant reflex was planting
// saplings on the bot's own scaffold dirt (operator caught it live) - scaffold is
// temporary by definition, nothing should treat it as real ground.
function isSelfPlaced (pos, maxAgeMs) {
  const t = recentlyPlaced.get(key(pos))
  return !!t && t >= Date.now() - (maxAgeMs || TRAIL_MS)
}

// Self-placed blocks near a point (for scaffold teardown after tall-tree harvests -
// the operator found dirt towers abandoned all over the forest).
function selfPlacedNear (pos, r, maxAgeMs) {
  const out = []
  const cut = Date.now() - (maxAgeMs || TRAIL_MS)
  for (const [k, t] of recentlyPlaced) {
    if (t < cut) continue
    const [x, y, z] = k.split(',').map(Number)
    if (Math.hypot(x - pos.x, z - pos.z) <= r) out.push({ x, y, z, t })
  }
  return out
}

function installPathfinderTuning (bot) {
  // Wrap placeBlock once - three patches ride on it:
  //  1. record self-placed cells (feeds the scaffold guard below)
  //  2. TOWER TIMING: when placing the block under our own feet (1x1 tower), wait for
  //     the jump APEX before sending - the lib fires at arbitrary jump phases and the
  //     server rejects the mistimed ones, which is the bunny-hop spam the operator
  //     watched ("jumps for a few seconds before it places one block")
  //  3. PHANTOM FAILURES: Paper often never echoes the blockUpdate for a SUCCESSFUL
  //     placement - the lib treats it as a miss and re-tries onto an existing block.
  //     On that specific timeout, check the world before failing.
  const origPlace = bot.placeBlock.bind(bot)
  bot.placeBlock = async function (referenceBlock, faceVector) {
    const target = referenceBlock.position.plus(faceVector)
    try {
      const feet = bot.entity.position.floored()
      if (faceVector.y === 1 && target.x === feet.x && target.z === feet.z && target.y === feet.y) {
        const t0 = Date.now()
        while (Date.now() - t0 < 700 && (bot.entity.position.y - feet.y) < 0.95) await new Promise(r => setTimeout(r, 20))
      }
    } catch {}
    try {
      const r = await origPlace(referenceBlock, faceVector)
      try { recentlyPlaced.set(key(target), Date.now()); saveTrail(); if (recentlyPlaced.size > 256) sweep() } catch {}
      return r
    } catch (e) {
      if (/blockUpdate/.test(e.message || '')) {
        await new Promise(r => setTimeout(r, 350))
        const b = bot.blockAt(target)
        if (b && !/^(air|cave_air|void_air)$/.test(b.name)) {
          try { recentlyPlaced.set(key(target), Date.now()); saveTrail() } catch {}
          return // it landed - swallow the phantom failure
        }
      }
      throw e
    }
  }
  // forbid the planner from digging those cells: safeToBreak is the single gate every
  // dig move consults (prototype patch -> covers every Movements profile in the codebase)
  const { Movements } = require('mineflayer-pathfinder')
  if (!Movements.prototype.__selfScaffoldGuard) {
    const orig = Movements.prototype.safeToBreak
    Movements.prototype.safeToBreak = function (block) {
      const t = block && block.position && recentlyPlaced.get(key(block.position))
      if (t && Date.now() - t < RECENT_MS) return false // our own fresh scaffold - walk, don't chew (older trail entries are breakable again)
      return orig.call(this, block)
    }
    Movements.prototype.__selfScaffoldGuard = true
  }

  // PATH RELIABILITY (operator: "fix the pathfinding, it seems unreliable"): the stock
  // 5s think budget throws "Took too long to decide path" in tight/cluttered terrain
  // (getting into the cramped hut, around furniture). More compute per attempt + a bigger
  // per-tick slice makes short indoor paths actually resolve instead of bailing.
  try {
    if (bot.pathfinder) {
      bot.pathfinder.thinkTimeout = 20000 // ms to find a path (was 5000)
      bot.pathfinder.tickTimeout = 80     // ms of compute per tick (was 40)
      if ('searchRadius' in bot.pathfinder) bot.pathfinder.searchRadius = -1 // unbounded (default)
    }
  } catch {}
}

module.exports = { installPathfinderTuning, selfPlacedNear, isSelfPlaced }
