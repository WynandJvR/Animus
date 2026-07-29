'use strict'
// ==== THE CAPABILITY REGISTRY =============================================================
// ONE table that answers, for any item: "what can produce this, and what does it need?"
//
// WHY IT EXISTS. On 2026-07-29 four separate defects were fixed in one session. They are the
// same defect:
//   trekOrchard     planned by scheduler.recoveryPlan since S5, no key in RUNG_EXECUTORS, so
//                   `if (!RUNG_EXECUTORS[r.action]) continue` skipped it on EVERY pass - a food
//                   source the bot plants, remembers, and was structurally incapable of eating
//   pillar filler   existed and was wired only to the suicide-reset, so a blockless bot spawned
//                   in its own shelter pit and pillared 60x without moving
//   wool            had no entry in ANY producer map, so the bed planner emitted a
//                   lapis->dye->wool chain for wool it did not have, gave up in a field of
//                   sheep, and never once set a spawn anchor across two multi-hour sessions
//   digStaircaseUp  existed; only climbToSurface could reach it and that rung is gated on being
//                   underground, so an open-sky 1x1 shaft held the bot 3+ min until a teleport
//
// The common shape: a planner NAMES something; nothing guarantees a producer EXISTS for the
// things a planner can name; and the miss is SILENT (a `continue`, a swallowed catch, a
// "don't know how to gather X" that nobody reads). Capability was wired one call site at a
// time, so "can the bot obtain wool / dig out of a shaft / harvest its orchard?" was answered
// by whoever remembered to wire it.
//
// This file is the single answer, and bot/capabilitytest.js ENUMERATES it against every
// planner that consumes it - so the next gap is a red test, not a bot standing still.
// "Unobtainable" is a legitimate answer here; silence is not (DESIGN-PRINCIPLES §5).
//
// PURE data + pure lookups: no bot handle, no I/O, no require of a bot module. Nothing in here
// can degrade into a try{}catch{}, and the contract test can enumerate it offline.

// ---- item producers ----------------------------------------------------------------------
// item name -> { via, ...what that producer needs }
//   via:'gather'  mine BLOCKS in the world for it.  blocks:[...]  tool:<required tool|null>
//                 NATURAL blocks only - anti-grief, same philosophy as commands.js's MINABLE
//                 allowlist. Never target a placed/crafted block (a common player block).
//   via:'smelt'   furnace output.                   input:<item>  (recursively provisioned)
//   via:'strip'   strip a PLACED log with an axe.   input:<log>   tool:<axe>  (1:1)
//   via:'hunt'    kill a MOB and take the drop.     entity:<re>  drop:<re>  types:[...]
// A `tool` is MANDATORY, not merely faster: stone mined bare-handed drops NOTHING, and iron
// ore drops nothing below stone tier.
//
// The `hunt` kind is what was MISSING ENTIRELY. Every producer map in this codebase was block
// mining, so no planner could represent "that comes off an animal" - and the bed planner, in a
// field of sheep, emitted lapis -> blue_dye -> blue_wool -> bone_meal -> white_dye -> white_wool
// trying to RE-DYE wool it did not have, then gave up. No bed, therefore no spawn anchor, ever.
// `drop` is a FAMILY regex on purpose: a sheep drops ITS OWN colour, so a hunt for white_wool
// legitimately comes back with brown_wool. The hunt reports what it actually got and the caller
// re-plans against real holdings - it never claims the exact item it was asked for.
const ITEMS = {}
function def (item, entry) { ITEMS[item] = Object.assign({ item }, entry); return ITEMS[item] }

// ONE wood list, and every wood on it is both choppable and strippable. There used to be three
// lists that had to agree and did not: provision.detectWood scanned nine woods, STRIP_MAP had
// nine, GATHER_SOURCES had eight. In a pale-oak grove detectWood therefore returned 'pale_oak'
// as the plan's primary wood, every generic wood need (planks, sticks, tools, fuel, charcoal)
// resolved to pale_oak_log, and pale_oak_log had no producer - so the WHOLE plan stranded as
// unobtainable while standing in a forest. Found by the S4 contract test, which now pins
// detectWood's list against this one.
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak']

// -- gather (block mining) --
def('cobblestone', { via: 'gather', blocks: ['stone'], tool: 'wooden_pickaxe' }) // mine natural STONE (drops cobble); never placed cobblestone
def('raw_iron', { via: 'gather', blocks: ['iron_ore', 'deepslate_iron_ore'], tool: 'stone_pickaxe' }) // iron armor bootstrap (pillager patrols eat naked bots)
def('dirt', { via: 'gather', blocks: ['dirt', 'grass_block'], tool: null })
def('sand', { via: 'gather', blocks: ['sand'], tool: null })
def('red_sand', { via: 'gather', blocks: ['red_sand'], tool: null })
def('gravel', { via: 'gather', blocks: ['gravel'], tool: null })
def('clay_ball', { via: 'gather', blocks: ['clay'], tool: null })
for (const w of WOODS) def(`${w}_log`, { via: 'gather', blocks: [`${w}_log`], tool: null })

// -- smelt (furnace output -> input, recursively provisioned) --
def('iron_ingot', { via: 'smelt', input: 'raw_iron' })
def('glass', { via: 'smelt', input: 'sand' })
def('stone', { via: 'smelt', input: 'cobblestone' })
def('smooth_stone', { via: 'smelt', input: 'stone' })
def('brick', { via: 'smelt', input: 'clay_ball' })
def('smooth_sandstone', { via: 'smelt', input: 'sandstone' })
def('charcoal', { via: 'smelt', input: 'oak_log' }) // planProvision substitutes the LOCAL wood (primaryWood)

// -- strip (axe a placed log, 1:1) --
// Every wood, matching today's STRIP_MAP. (wood/hyphae variants left out.)
for (const w of WOODS) def(`stripped_${w}_log`, { via: 'strip', input: `${w}_log`, tool: 'wooden_axe' })

// -- hunt (kill a mob, take the drop) --
// `types` are mineflayer entity.type values; passive animals and hostiles are filtered
// differently, which is the only reason the three hand-written hunts diverged at all.
const WOOL_COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
for (const c of WOOL_COLOURS) {
  def(`${c}_wool`, { via: 'hunt', entity: /^sheep$/, drop: /_wool$/, family: 'wool', label: 'sheep', types: ['mob', 'animal'], maxKills: 8 })
}
def('leather', { via: 'hunt', entity: /^(cow|mooshroom)$/, drop: /^leather$/, label: 'cows', types: ['mob', 'animal'], maxKills: 16 })
def('string', { via: 'hunt', entity: /^(spider|cave_spider)$/, drop: /^string$/, label: 'spiders', types: ['mob', 'hostile'], maxKills: 4, hostile: true })

// ---- views ---------------------------------------------------------------------------------
// The four hand-maintained maps provision.js used to own, now DERIVED from the one table above.
// Existing callers keep working unchanged; there is exactly one place to add a capability.
const GATHER_SOURCES = {}
const GATHER_TOOL = {}
const SMELT_MAP = {}
const STRIP_MAP = {}
const HUNT_SOURCES = {}
for (const e of Object.values(ITEMS)) {
  if (e.via === 'gather') { GATHER_SOURCES[e.item] = e.blocks; if (e.tool) GATHER_TOOL[e.item] = e.tool }
  else if (e.via === 'smelt') SMELT_MAP[e.item] = e.input
  else if (e.via === 'strip') STRIP_MAP[e.item] = e.input
  else if (e.via === 'hunt') HUNT_SOURCES[e.item] = e
}

// The producer for `item`, or null. Null MEANS "no direct producer" - the caller must then say
// so out loud (a recipe may still make it; a planner reports `unobtainable` when nothing can).
function producerFor (item) {
  return (item != null && Object.prototype.hasOwnProperty.call(ITEMS, item)) ? ITEMS[item] : null
}
// Every item with a direct producer, for enumeration by the contract test.
function producedItems () { return Object.keys(ITEMS) }

// ---- action producers (the recovery ladder's vocabulary) ------------------------------------
// The SAME idea applied to actions instead of items: scheduler.recoveryPlan may only emit an
// action listed here, and provision-recovery.RUNG_EXECUTORS must have an executor for every one
// of them. capabilitytest.js asserts both directions, which is what makes `trekOrchard` -
// planned for months with nothing able to run it - impossible to reproduce.
//
//   rung      where it sits in the R0..R5 ladder (documentation; recoveryPlan owns the order)
//   outbound  this action SETS OUT across open ground, so the "never travel un-armoured at
//             night" rule (scheduler.outboundBlocked) governs it. ONE definition, consumed by
//             rungFeasible and by the ladder's per-rung hp-abort.
//   hold      this action WAITS rather than acts; `wake` names the condition that releases it.
const RUNG_ACTIONS = {
  'eatPack+wearFromPack': { rung: 'R0' },
  recoverGrave: { rung: 'R1' },
  rearmFromBank: { rung: 'R1.5' }, // walks HOME, so never outbound-gated
  'gotoHome+ensureFood(forceFresh)+cook+eat': { rung: 'R2' },
  sleepInBed: { rung: 'R2', hold: true, wake: 'dawn' },
  digInForNight: { rung: 'R2', hold: true, wake: 'dawn' },
  'trekFarm+tend+harvest+courierHome': { rung: 'R3', outbound: true },
  'trekOrchard+harvest+courierHome': { rung: 'R3', outbound: true },
  'secureFood(hunt->fish->scout)': { rung: 'R4', outbound: true },
  'boundedHold:sleep': { rung: 'R5', hold: true, wake: 'dawn' },
  'boundedHold:sealPit': { rung: 'R5', hold: true, wake: 'dawn|foodInPack|grave|animal<=24' },
  rerunLadderByNight: { rung: 'R5' } // eternal night: no hold - re-loop so R3/R4 run by night
}
function rungAction (action) {
  return (action != null && Object.prototype.hasOwnProperty.call(RUNG_ACTIONS, action)) ? RUNG_ACTIONS[action] : null
}
// Does this action set out across open ground? The single definition behind scheduler's
// OUTBOUND_RE and the ladder's outbound hp-abort.
function isOutboundAction (action) {
  const e = rungAction(action)
  return !!(e && e.outbound)
}
function rungActionNames () { return Object.keys(RUNG_ACTIONS) }

module.exports = {
  ITEMS,
  WOODS,
  WOOL_COLOURS,
  GATHER_SOURCES,
  GATHER_TOOL,
  SMELT_MAP,
  STRIP_MAP,
  HUNT_SOURCES,
  producerFor,
  producedItems,
  RUNG_ACTIONS,
  rungAction,
  rungActionNames,
  isOutboundAction
}
