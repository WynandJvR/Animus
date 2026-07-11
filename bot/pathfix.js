'use strict'
// PATCH LAYER over mineflayer-pathfinder (same durable pattern as installDigTimeGuard:
// we override behavior at runtime instead of forking, so npm installs never undo it and
// upstream fixes still arrive). Each patch targets a failure we watched live.
//
// PATCH 1 - never break your own fresh scaffold. The planner re-plans mid-move and treats
// the block the bot JUST placed as an obstacle: pillar up, break own dirt, pillar again
// (operator watched the full loop). Blocks self-placed in the last 60s are off-limits to
// the planner's dig moves - it walks around/on them like anyone sane.

const RECENT_MS = 60000
const recentlyPlaced = new Map() // "x,y,z" -> timestamp

function key (p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` }

function sweep () {
  const cut = Date.now() - RECENT_MS
  for (const [k, t] of recentlyPlaced) { if (t < cut) recentlyPlaced.delete(k) }
}

function installPathfinderTuning (bot) {
  // record every block the bot itself places (placeBlock resolves AFTER the block lands,
  // referenceBlock+faceVector addresses the new cell)
  const origPlace = bot.placeBlock.bind(bot)
  bot.placeBlock = async function (referenceBlock, faceVector) {
    const r = await origPlace(referenceBlock, faceVector)
    try { recentlyPlaced.set(key(referenceBlock.position.plus(faceVector)), Date.now()); if (recentlyPlaced.size > 256) sweep() } catch {}
    return r
  }
  // forbid the planner from digging those cells: safeToBreak is the single gate every
  // dig move consults (prototype patch -> covers every Movements profile in the codebase)
  const { Movements } = require('mineflayer-pathfinder')
  if (!Movements.prototype.__selfScaffoldGuard) {
    const orig = Movements.prototype.safeToBreak
    Movements.prototype.safeToBreak = function (block) {
      const t = block && block.position && recentlyPlaced.get(key(block.position))
      if (t && Date.now() - t < RECENT_MS) return false // our own fresh scaffold - walk, don't chew
      return orig.call(this, block)
    }
    Movements.prototype.__selfScaffoldGuard = true
  }
}

module.exports = { installPathfinderTuning }
