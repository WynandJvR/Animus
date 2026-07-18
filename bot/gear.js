'use strict'
// GEAR SELECTION (pure): which tool for a block, which slot a piece is worn in, and
// which of several candidate pieces is strongest. Split out of commands.js unchanged.
//
// Pure by construction - these take a block name, an item name, or an array of item
// stacks and return a choice. bestTool reads bot.inventory but holds no module state.
// The ACTING code (equipCarriedArmor, provisionArmor, survivalPrep) stays in
// commands.js; only the "which one" decisions live here.
//
// KNOWN DIVERGENCE, deliberately preserved: provision.js has its own toolForBlock()
// with the same shape (same material order, same fallback) but a DIFFERENT branch
// order - it tests pickaxe before axe, while bestTool tests axe first. For a block
// name matching both patterns the two can disagree. Unifying them would be a
// behaviour change, not a refactor, so both are left exactly as they were; this note
// exists so the next person finds the pair instead of rediscovering it.

// Material preference, strongest first. Shared by the tool and armor pickers, which
// use different lists (tools have no chainmail/turtle tier; armor has no stone/wooden).
const TOOL_MATS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
const ARMOR_MATS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather', 'turtle']

// Pick the best tool in inventory for a block (axe/pickaxe/shovel, best material).
function bestTool (bot, blockName) {
  const items = bot.inventory ? bot.inventory.items() : []
  let kind = null
  if (/_log$|_wood$|plank|_stem$|fence|door|chest|crafting|bookshelf|barrel|sign|ladder|wooden/.test(blockName)) kind = 'axe'
  else if (/stone|ore|cobble|deepslate|granite|diorite|andesite|obsidian|brick|furnace|anvil|concrete|terracotta|netherrack|basalt|blackstone|amethyst|raw_|rail|iron_block|gold_block/.test(blockName)) kind = 'pickaxe'
  else if (/dirt|grass_block|sand|gravel|clay|soul_|mud|path|farmland|snow|podzol|mycelium/.test(blockName)) kind = 'shovel'
  if (!kind) return null
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

module.exports = { bestTool, armorSlot, bestArmor, armorRank, ARMOR_MAT, ARMOR_RANK, ARMOR_MATS, TOOL_MATS, LEATHER_PIECES }
