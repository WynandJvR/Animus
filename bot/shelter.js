'use strict'
// SHELTER SITING (pure logic): "can a safe night-pit be dug at this cell?" and picking the
// nearest DIGGABLE DRY cell to relocate to. Kept PURE (block NAME strings in, boolean/rank
// out - no bot, no I/O) so it is offline-testable (bot/sheltertest.js), like hut-model.js /
// mining.js. The driver (provision.digInForNight / findDiggableDryCell) supplies real world
// reads.
//
// Why this exists (live bug, river biome at night): digInForNight's flooding guard correctly
// REFUSES to dig when water sits beside the next cell, and ensureAshore gets the bot out of
// the water but not necessarily onto DIGGABLE DRY ground - so every pit attempt hit the guard
// and the shelter flow spun forever ("water beside the next cell - not digging deeper" ->
// "NO-OP (dug 0)" every ~4s), bricking the bot before the branch mine could even start. The
// fix: a "can I dig a safe pit here?" predicate + relocate to the nearest cell that passes.

const AIRISH = n => n === 'air' || n === 'cave_air' || n === 'void_air' || n == null
const FLUID_RE = /lava|water|seagrass|kelp|bubble_column/
// Blocks a survival dig can never break (bedrock/obsidian/etc.). The runtime anti-grief gate
// is canBreakNaturally (player-placed blocks); this pure check just rejects obvious undiggables.
const UNDIGGABLE_RE = /^(bedrock|obsidian|crying_obsidian|barrier|reinforced_deepslate|end_portal|end_portal_frame|command_block|structure_block|jigsaw)/

// Can we safely dig a night-pit straight down here? Inputs are block NAMES:
//   below  - the block directly under our feet (the first block we'd dig). Must be solid
//            natural-ish ground, not air (a hole already) and not a fluid.
//   below2 - one deeper (becomes the pit floor). A fluid here floods the pit.
//   sides  - the 4 blocks BESIDE `below` (same Y). A fluid touching the shaft wall floods
//            the pit the instant the wall drops (the exact live drowning/entombment cause).
// Returns true only when the column is diggable AND dry on all those faces.
function shelterDiggable (below, below2, sides = []) {
  if (AIRISH(below)) return false            // nothing to dig into / already open
  if (FLUID_RE.test(below)) return false      // digging into lava/water
  if (UNDIGGABLE_RE.test(below)) return false // bedrock/obsidian/etc.
  if (below2 != null && FLUID_RE.test(below2)) return false // fluid one deeper -> floods
  for (const s of sides) if (s != null && FLUID_RE.test(s)) return false // aquifer beside the shaft
  return true
}

// Is a candidate FEET cell DRY - no water in the feet/head cell or the 4 horizontal
// neighbours at feet level? Inputs: feetName, headName, and the 4 side names at feet level.
// (A cell can be "ashore" yet still water-adjacent on every side - that's what kept failing.)
function feetCellDry (feetName, headName, sideNamesAtFeet = []) {
  if (!AIRISH(feetName) || !AIRISH(headName)) return false // must be standable (2 air)
  if (FLUID_RE.test(feetName) || FLUID_RE.test(headName)) return false
  for (const s of sideNamesAtFeet) if (s != null && /water|seagrass|kelp|bubble_column/.test(s)) return false
  return true
}

// Rank candidate cells ({x,y,z}) by XZ distance from a point, nearest first (a relocate
// should be the SHORTEST safe walk). Pure; returns a new sorted array.
function rankByDistance (cells, from) {
  return cells.slice().sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))
}

module.exports = { AIRISH, FLUID_RE, UNDIGGABLE_RE, shelterDiggable, feetCellDry, rankByDistance }
