'use strict'
// GEAR SELECTION (pure): which tool for a block, which slot a piece is worn in, and
// which of several candidate pieces is strongest. Split out of commands.js unchanged.
//
// Pure by construction - these take a block name, an item name, or an array of item
// stacks and return a choice. bestTool reads bot.inventory but holds no module state.
// The ACTING code (equipCarriedArmor, provisionArmor, survivalPrep) stays in
// commands.js; only the "which one" decisions live here.
//
// The KNOWN DIVERGENCE this header used to describe - provision-core.toolForBlock answering the
// same question with a different branch order - is RESOLVED. It was a behaviour change, as the old
// note said, but the two did not merely disagree on ordering: the other copy's patterns were far
// narrower and left 110 pickaxe-required blocks on bare hands. toolKindFor below is now the single
// answer and provision-core delegates to it. See toolKindFor for the measurement.

// Material preference, strongest first. Shared by the tool and armor pickers, which
// use different lists (tools have no chainmail/turtle tier; armor has no stone/wooden).
const TOOL_MATS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
const ARMOR_MATS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather', 'turtle']

// Which KIND of tool a block wants (pickaxe/axe/shovel), or null for bare hands.
//
// ONE DEFINITION (§4). provision-core.toolForBlock was a second, NARROWER copy of this rule, and
// the narrowness was a live bug: measured against minecraft-data's harvestTools over all 1060
// blocks in 1.21, it answered `null` - bare hands - for gold_block, iron_block, obsidian, furnace,
// netherrack, every terracotta, the anvils, the brick family. Those REQUIRE a pickaxe and drop
// NOTHING without one, which is the failure provision-bank.js:590 already warns about in a comment.
// 110 blocks wrong there vs 31 here, so the broad patterns won and the copy now delegates.
//
// PICKAXE IS TESTED FIRST. The old axe-first order sent an axe to iron_door, iron_trapdoor,
// ender_chest and nether_brick_fence - all pickaxe-required - because the axe pattern matches
// "door"/"chest"/"fence" before the stone pattern gets a look. Nothing that genuinely needs an axe
// matches the pickaxe pattern, so the swap costs nothing and fixes those four.
// THE NAME PATTERNS ARE A FALLBACK, NOT THE ANSWER. minecraft-data ships the game's own
// harvestTools table and is already a mineflayer dependency, so guessing from the block name is
// guessing at data we have on disk. Scored over the 387 blocks that REQUIRE a tool in 1.21:
// the old provision-core copy got 241 wrong, the old gear copy 162, the merged patterns 145 -
// every one of them a bare-handed dig on a block that drops NOTHING without the tool
// (lapis_block, diamond_block, quartz, prismarine, hopper, dispenser, spawner, iron_bars).
// Reading harvestTools gets them right by construction and never needs a pattern added again.
//
// The patterns still earn their place for the blocks harvestTools says nothing about: a log does
// not REQUIRE an axe, but a player still uses one. So harvestTools answers "what must I hold to
// get the drop", and the patterns answer "what is faster" when nothing is required.
const PICKAXE_RE = /stone|ore|cobble|deepslate|granite|diorite|andesite|tuff|obsidian|brick|furnace|anvil|concrete|terracotta|netherrack|basalt|blackstone|amethyst|raw_|rail|iron_block|gold_block|iron_door|iron_trapdoor|ender_chest|cauldron/
const AXE_RE = /_log$|_wood$|plank|_stem$|fence|door|chest|crafting|bookshelf|barrel|sign|ladder|wooden/
const SHOVEL_RE = /dirt|grass_block|sand|gravel|clay|soul_|mud|path|farmland|snow|podzol|mycelium/

const _mcCache = new Map()
function _harvestKind (blockName, version) {
  if (!version) return undefined
  try {
    if (!_mcCache.has(version)) _mcCache.set(version, require('minecraft-data')(version))
    const md = _mcCache.get(version)
    const b = md && md.blocksByName && md.blocksByName[blockName]
    if (!b || !b.harvestTools) return undefined            // no entry, or nothing required
    for (const id of Object.keys(b.harvestTools)) {
      const nm = (md.items[id] || {}).name || ''
      if (/_pickaxe$/.test(nm)) return 'pickaxe'
      if (/_axe$/.test(nm)) return 'axe'
      if (/_shovel$/.test(nm)) return 'shovel'
    }
    return undefined
  } catch { return undefined }                              // never let a data miss break a dig
}

// Which KIND of tool a block wants (pickaxe/axe/shovel), or null for bare hands.
// `version` is optional - pass bot.version to get the authoritative answer.
function toolKindFor (blockName, version) {
  const n = String(blockName || '')
  const required = _harvestKind(n, version)
  if (required) return required
  if (PICKAXE_RE.test(n)) return 'pickaxe'
  if (AXE_RE.test(n)) return 'axe'
  if (SHOVEL_RE.test(n)) return 'shovel'
  return null
}

// Pick the best tool in inventory for a block (axe/pickaxe/shovel, best material).
function bestTool (bot, blockName) {
  const kind = toolKindFor(blockName, bot && bot.version)
  if (!kind) return null
  const items = bot.inventory ? bot.inventory.items() : []
  const tools = items.filter(i => i.name.endsWith('_' + kind))
  for (const m of TOOL_MATS) { const t = tools.find(i => i.name.startsWith(m)); if (t) return t }
  return tools[0] || null
}

// Which body slot an item is WORN in (so armor is put on, not just held). Returns
// 'head'|'torso'|'legs'|'feet' for armor, else null. mineflayer's bot.equip needs
// this destination - equipping armor to 'hand' only holds it (the "put it on did
// nothing" bug). Covers every armor material + turtle helmet, elytra, pumpkin hat.
function armorSlot (name) {
  if (/_helmet$|^turtle_helmet$|^carved_pumpkin$/.test(name)) return 'head'
  if (/_chestplate$|^elytra$/.test(name)) return 'torso'
  if (/_leggings$/.test(name)) return 'legs'
  if (/_boots$/.test(name)) return 'feet'
  return null
}

// The armor pieces the bot ACTUALLY has equipped, per slot (null if bare). Read straight from
// the armor inventory slots, so /state reflects worn gear and the brain can't claim to be wearing
// something it isn't (or re-wear what it has on).
// ONE DEFINITION (§4): perception.js (as `wornArmor`) and planner.js each carried a byte-identical
// copy of this - planner's noting it was "inlined rather than imported from commands.js" to dodge a
// cycle. gear.js requires nothing, so both import it from here instead and the rule cannot drift.
function wornBySlot (bot) {
  const out = { head: null, torso: null, legs: null, feet: null }
  try {
    for (const slot of ['head', 'torso', 'legs', 'feet']) {
      const it = bot.inventory && bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
      if (it) out[slot] = it.name
    }
  } catch { /* not spawned / slots not ready */ }
  return out
}

// Best armor piece among candidates for one slot (strongest material wins).
function bestArmor (pieces) {
  for (const m of ARMOR_MATS) { const p = pieces.find(i => i.name.startsWith(m)); if (p) return p }
  return pieces[0] || null
}

// Material rank for a standard armor piece (same preference order as bestArmor); an empty slot or a
// non-standard piece (elytra/carved_pumpkin) ranks 0 so it's never a downgrade target.
const ARMOR_MAT = /^(netherite|diamond|iron|chainmail|golden|leather|turtle)_/
const ARMOR_RANK = { turtle: 1, leather: 2, golden: 3, chainmail: 4, iron: 5, diamond: 6, netherite: 7 }
function armorRank (name) { const m = ARMOR_MAT.exec(name || ''); return m ? (ARMOR_RANK[m[1]] || 0) : 0 }

// Leather-armor pieces in PROTECTION-PER-LEATHER order, so a partial haul still
// guards the most valuable slots first: chestplate (3 armor / 8 leather) beats
// leggings (2/7) beats helmet (1/5) beats boots (1/4). Leather armor is the
// from-NOTHING tier - the recipes are pure leather (no sticks/planks), so the only
// crafting prerequisite is a table.
const LEATHER_PIECES = [
  { item: 'leather_chestplate', slot: 'torso', leather: 8 },
  { item: 'leather_leggings', slot: 'legs', leather: 7 },
  { item: 'leather_helmet', slot: 'head', leather: 5 },
  { item: 'leather_boots', slot: 'feet', leather: 4 }
]

module.exports = { bestTool, toolKindFor, armorSlot, wornBySlot, bestArmor, armorRank, ARMOR_MAT, ARMOR_RANK, LEATHER_PIECES }
