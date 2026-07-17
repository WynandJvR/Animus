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
//   below3 - two deeper. AIR at BOTH below2 and below3 means the pit floor is a thin shelf
//            over a CAVE - digging drops the bot >=2 blocks into the open cavern (the exposed
//            dark-cave "shelter" this whole fix targets). below2-air over a SOLID below3 is the
//            existing legit 3-deep geometry, so it stays allowed.
// Returns true only when the column is diggable AND dry AND not a lid over a void.
function shelterDiggable (below, below2, sides = [], below3 = null) {
  if (AIRISH(below)) return false            // nothing to dig into / already open
  if (FLUID_RE.test(below)) return false      // digging into lava/water
  if (UNDIGGABLE_RE.test(below)) return false // bedrock/obsidian/etc.
  if (below2 != null && FLUID_RE.test(below2)) return false // fluid one deeper -> floods
  if (AIRISH(below2) && AIRISH(below3)) return false // thin shelf over a cave -> we'd fall in
  for (const s of sides) if (s != null && FLUID_RE.test(s)) return false // aquifer beside the shaft
  return true
}

// Is a candidate torch-alcove pocket a COMPLETE seal? Inputs are the block NAMES of the pocket's
// enclosing faces (floor, far wall, both side walls, ceiling). Every face must be a solid,
// non-liquid, non-leaf, non-void block so that widening one cell for the torch does NOT open a
// new hole in the sealed shelter. Pure so it's offline table-testable.
const SOLID_FACE = n => n != null && !AIRISH(n) && !FLUID_RE.test(n) && !/_leaves$/.test(n)
function alcoveSafe (faceNames = []) {
  if (!faceNames.length) return false
  for (const n of faceNames) if (!SOLID_FACE(n)) return false
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

// SHELTER_AVOID_FARM (fix #30): is `pos` within r blocks (XZ) of our own wheat farm - its
// anchor OR any of its cells? A night-bunker dug at the farm waterline floods and wrecks the
// crop (the #28 physical cause), so the driver steps clear of a conflict before digging and
// never relocates a pit into one. Pure (coords in, bool out) so sheltertest.js table-tests it.
function farmConflict (anchor, cells, pos, r) {
  if (!pos || !(r > 0)) return false
  if (anchor && Math.hypot(anchor.x - pos.x, anchor.z - pos.z) <= r) return true
  for (const c of (cells || [])) { if (Math.hypot(c.x - pos.x, c.z - pos.z) <= r) return true }
  return false
}

// ---- SLEEP-FAILURE CLASSIFIER + BED-HOLD POLICY (fix #14) --------------------------------
// bot.sleep (mineflayer bed.js) throws a spread of messages; classify them so provision.js
// can decide whether to hold OFF a bed that just proved unusable, and for how long. Pure
// (string in, tag/number out) so sheltertest.js table-tests it. The live loop: at hp1 with a
// zombie at the bed, mineflayer threw 'cant click the bed' (canDigBlock reach) forever - a
// position-deterministic failure that the stateless catch re-tried every cycle.
//   transient - not a real bed problem (wrong time / already sleeping/awake); NEVER hold (the
//               dusk-wait already owns the not-night case quietly).
//   monsters  - vanilla's 'there are monsters nearby'; hold briefly (they wander off / burn).
//   unusable  - the bed can't be clicked/reached/used right now (cant click, too far, occupied,
//               only half bed, wrong block, waitUntilSleep's 'bot is not sleeping' timeout);
//               hold ~a night. UNKNOWN messages default here: an unrecognised error that repeats
//               is a loop, and the hold is short + self-expiring so mis-classing is cheap.
const BED_HOLD_MS = parseInt(process.env.BED_HOLD_MS || '480000', 10)                 // unusable ~ rest of the dark span
const BED_HOLD_MONSTER_MS = parseInt(process.env.BED_HOLD_MONSTER_MS || '90000', 10)  // a mob wanders off / burns
const BED_HOLD_FELLSHORT_MS = parseInt(process.env.BED_HOLD_FELLSHORT_MS || '120000', 10) // wedge fails identically ~soon
function sleepFailKind (msg) {
  const m = String(msg == null ? '' : msg)
  if (/not night and it's not a thunderstorm|already sleeping|already awake/i.test(m)) return 'transient'
  if (/monster/i.test(m)) return 'monsters'
  if (/cant click|too far|only half bed|wrong block|occupied|not sleeping/i.test(m)) return 'unusable'
  return 'unusable' // any unrecognised repeating error is a loop; a short self-expiring hold is cheap
}
function bedHoldMs (kind) {
  if (kind === 'transient') return 0
  if (kind === 'monsters') return BED_HOLD_MONSTER_MS
  return BED_HOLD_MS // unusable (and any unknown kind)
}

module.exports = {
  AIRISH, FLUID_RE, UNDIGGABLE_RE, shelterDiggable, feetCellDry, rankByDistance, alcoveSafe, farmConflict,
  sleepFailKind, bedHoldMs, BED_HOLD_MS, BED_HOLD_MONSTER_MS, BED_HOLD_FELLSHORT_MS
}
