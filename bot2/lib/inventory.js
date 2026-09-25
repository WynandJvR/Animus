'use strict'
// What the bot carries, and choosing the right thing to hold/wear/eat.
const world = require('./world')

const TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']
const TIER_RANK = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }
// Foods worth eating, best first (restores a lot / high saturation). Risky foods excluded.
const GOOD_FOOD = ['golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'baked_potato', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'bread', 'rabbit_stew', 'mushroom_stew', 'beetroot_soup', 'pumpkin_pie', 'apple', 'carrot', 'melon_slice', 'sweet_berries', 'glow_berries', 'cookie', 'dried_kelp', 'beetroot', 'potato']
const RAW_FOOD = ['beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon', 'chicken']
const COOKED_OF = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', chicken: 'cooked_chicken', potato: 'baked_potato' }
const DESPERATE_FOOD = ['beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon', 'rotten_flesh', 'chicken']

function items (bot) { return bot.inventory ? bot.inventory.items() : [] }
function count (bot, what) {
  const test = typeof what === 'string' ? (n => n === what) : (what instanceof RegExp ? (n => what.test(n)) : what)
  let n = 0
  for (const it of items(bot)) if (test(it.name)) n += it.count
  // include the off-hand and armour slots only for exact names of equipment
  return n
}
function has (bot, what, n = 1) { return count(bot, what) >= n }
function counts (bot) { const c = {}; for (const it of items(bot)) c[it.name] = (c[it.name] || 0) + it.count; return c }
function freeSlots (bot) { try { return bot.inventory.emptySlotCount() } catch { return 0 } }

function tierOf (name) { const t = String(name).split('_')[0]; return TIER_RANK[t] || 0 }
function durabilityLeft (bot, it) {
  const md = world.data(bot)
  const def = md.itemsByName[it.name]
  if (!def || !def.maxDurability) return Infinity
  let used = it.durabilityUsed
  if (used == null) { try { used = (it.components || []).find(c => c.type === 'damage')?.data || 0 } catch { used = 0 } }
  return def.maxDurability - (used || 0)
}

// Best tool of a kind ('pickaxe'|'axe'|'shovel'|'sword'|'hoe') with durability > minLeft.
function bestTool (bot, kind, minLeft = 2) {
  let best = null
  for (const it of items(bot)) {
    if (!it.name.endsWith('_' + kind)) continue
    if (durabilityLeft(bot, it) <= minLeft) continue
    if (!best || tierOf(it.name) > tierOf(best.name)) best = it
  }
  return best
}
function toolTier (bot, kind) { const t = bestTool(bot, kind); return t ? tierOf(t.name) : 0 }

function toolKindFor (block) {
  // the harvest-tool list is authoritative (iron/copper ore have material "incorrect_for_wooden_tool",
  // which names no tool - the bot mined iron bare-handed, 75s a block, for nothing)
  if (block && block.harvestTools && mdRef) {
    for (const id of Object.keys(block.harvestTools)) {
      const it = mdRef.items[Number(id)]
      const k = it && it.name.match(/_(pickaxe|shovel|hoe|sword|axe)$/)
      if (k) return k[1]
    }
  }
  const m = block && block.material ? String(block.material) : ''
  if (/pickaxe/.test(m)) return 'pickaxe'
  if (/axe/.test(m)) return 'axe'
  if (/shovel/.test(m)) return 'shovel'
  if (/hoe/.test(m)) return 'hoe'
  if (block && /_leaves$/.test(block.name)) return 'hoe'
  return null
}

// Hold the fastest tool for a block; bare hand if nothing helps.
let mdRef = null // minecraft-data, set on first use (toolKindFor has no bot handle)
async function equipFor (bot, block) {
  if (!mdRef) mdRef = world.data(bot)
  const kind = toolKindFor(block)
  // use a tool until it breaks - low durability is a reason to craft a spare, not to dig bare-handed
  let tool = kind ? bestTool(bot, kind, 0) : null
  if (!tool && kind === 'hoe') tool = null
  if (tool) {
    if (!bot.heldItem || bot.heldItem.name !== tool.name) await bot.equip(tool, 'hand').catch(() => {})
    return tool
  }
  // don't dig dirt with the sword (it wears the sword): hold something harmless
  const held = bot.heldItem
  if (held && /_(sword|pickaxe|axe|shovel|hoe)$/.test(held.name)) {
    const harmless = items(bot).find(i => !/_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(i.name))
    if (harmless) await bot.equip(harmless, 'hand').catch(() => {})
    else await bot.unequip('hand').catch(() => {})
  }
  return null
}

// Can we harvest this block with what we carry (drops something)?
function canHarvest (bot, block) {
  if (!block || !block.harvestTools) return true
  const ids = Object.keys(block.harvestTools).map(Number)
  return items(bot).some(i => ids.includes(i.type))
}

function bestWeapon (bot) {
  const swords = items(bot).filter(i => i.name.endsWith('_sword'))
  swords.sort((a, b) => tierOf(b.name) - tierOf(a.name))
  if (swords.length) return swords[0]
  const axes = items(bot).filter(i => i.name.endsWith('_axe'))
  axes.sort((a, b) => tierOf(b.name) - tierOf(a.name))
  return axes[0] || null
}
async function equipWeapon (bot) {
  const w = bestWeapon(bot)
  if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) await bot.equip(w, 'hand').catch(() => {})
  return w
}

const ARMOR_SLOTS = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' }
const ARMOR_RANK = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6, turtle: 2 }
function wornArmor (bot) {
  const out = {}
  for (const slot of Object.keys(ARMOR_SLOTS)) {
    try { out[slot] = bot.inventory.slots[bot.getEquipmentDestSlot(slot)] || null } catch { out[slot] = null }
  }
  return out
}
// the shield lives in the off-hand (slot 45)
function offhandShield (bot) { try { const it = bot.inventory.slots[45]; return !!(it && it.name === 'shield') } catch { return false } }
function hasShield (bot) { return offhandShield(bot) || items(bot).some(i => i.name === 'shield') }
async function equipShield (bot) {
  if (offhandShield(bot)) return true
  const it = items(bot).find(i => i.name === 'shield')
  if (!it) return false
  try { await bot.equip(it, 'off-hand'); return offhandShield(bot) } catch { return false }
}
function armorPieces (bot) { return Object.values(wornArmor(bot)).filter(Boolean).length }
// Vanilla defence points of a worn piece, by material and slot.
const ARMOR_POINTS = { leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3], turtle: [2, 0, 0, 0] }
function armorPoints (bot) {
  let n = 0
  const w = wornArmor(bot)
  for (const [i, slot] of ['head', 'torso', 'legs', 'feet'].entries()) { const it = w[slot]; const t = it && ARMOR_POINTS[it.name.split('_')[0]]; if (t) n += t[i] }
  return n
}
// Natural regeneration needs a food bar of at least this (vanilla); below it a hurt body stays hurt.
const REGEN_FOOD = 18
// THE block to wall, cap or plug ourselves in with: natural, solid - and never one that falls. A night bunker near the
// beach was capped with the sand the bot was carrying; the cap dropped onto its head and it suffocated in its own
// hole (2026-09-23). (Wood only where the caller allows it: planks are the build's.)
const SHELTER_RE = /^(dirt|coarse_dirt|grass_block|cobblestone|andesite|diorite|granite|tuff|cobbled_deepslate|netherrack|stone)$/
function shelterBlock (bot, { wood = false } = {}) { return items(bot).find(i => SHELTER_RE.test(i.name) || (wood && /_(planks|log)$/.test(i.name))) || null }
// the pack's armour pieces that outrank what their slot wears, as one key ('' = none)
function betterArmorInPack (bot) {
  const worn = wornArmor(bot)
  const out = []
  for (const [slot, suffix] of Object.entries(ARMOR_SLOTS)) {
    const cur = worn[slot]; const curRank = cur ? (ARMOR_RANK[cur.name.split('_')[0]] || 0) : -1
    for (const i of items(bot)) if ((i.name.endsWith('_' + suffix) || (slot === 'head' && i.name === 'turtle_helmet')) && (ARMOR_RANK[i.name.split('_')[0]] || 0) > curRank) { out.push(i.name); break }
  }
  return out.join(',')
}
async function wearBestArmor (bot) {
  let changed = 0
  const worn = wornArmor(bot)
  for (const [slot, suffix] of Object.entries(ARMOR_SLOTS)) {
    const cands = items(bot).filter(i => i.name.endsWith('_' + suffix) || (slot === 'head' && i.name === 'turtle_helmet'))
    if (!cands.length) continue
    cands.sort((a, b) => (ARMOR_RANK[b.name.split('_')[0]] || 0) - (ARMOR_RANK[a.name.split('_')[0]] || 0))
    const cur = worn[slot]
    const curRank = cur ? (ARMOR_RANK[cur.name.split('_')[0]] || 0) : -1
    if ((ARMOR_RANK[cands[0].name.split('_')[0]] || 0) > curRank) {
      try { await bot.equip(cands[0], slot); changed++ } catch {}
    }
  }
  await equipShield(bot)
  return changed
}

function foodItems (bot, { desperate = false } = {}) {
  const list = desperate ? GOOD_FOOD.concat(DESPERATE_FOOD) : GOOD_FOOD
  const inv = items(bot)
  const out = []
  for (const n of list) { const it = inv.find(i => i.name === n); if (it) out.push(it) }
  return out
}
function foodPoints (bot) {
  const md = world.data(bot)
  let pts = 0
  for (const it of items(bot)) {
    if (!GOOD_FOOD.includes(it.name)) continue
    const f = md.foodsByName && md.foodsByName[it.name]
    pts += (f ? f.foodPoints : 3) * it.count
  }
  return pts
}
function rawFoodCount (bot) { let n = 0; for (const it of items(bot)) if (COOKED_OF[it.name]) n += it.count; return n }

// Items not worth a slot. Kept conservative: never tosses anything a build/tool chain uses.
// (sticks, sand, saplings, string, seeds are NOT junk: tools, glass, replanting, beds, farms use them; nor are
//  clay balls, poppies and red tulips - bricks and red dye for a build: a full pack tossed a clay haul)
const JUNK = /^(raw_copper|raw_gold|redstone|lapis_lazuli|rotten_flesh|poisonous_potato|spider_eye|pufferfish|tropical_fish|dead_bush|short_grass|tall_grass|fern|leaf_litter|beetroot_seeds|pumpkin_seeds|melon_seeds|feather|bone|arrow|gunpowder|flint|egg|lily_pad|kelp|seagrass|glow_lichen|vine|pointed_dripstone|dripstone_block|moss_carpet|moss_block|azalea|flowering_azalea|orange_tulip|white_tulip|pink_tulip|dandelion|cornflower|azure_bluet|oxeye_daisy|allium|blue_orchid|pink_petals|wildflowers|firefly_bush|bush|calcite|red_sand|mud|podzol|mycelium|deepslate|ink_sac|leather_horse_armor|saddle|name_tag|golden_horse_armor|iron_horse_armor|lead)$/

module.exports = {
  TIERS, TIER_RANK, GOOD_FOOD, RAW_FOOD, COOKED_OF, JUNK, ARMOR_SLOTS,
  items, count, has, counts, freeSlots, tierOf, durabilityLeft, bestTool, toolTier, toolKindFor, equipFor, canHarvest,
  bestWeapon, equipWeapon, wornArmor, armorPieces, armorPoints, REGEN_FOOD, shelterBlock, betterArmorInPack, wearBestArmor, offhandShield, hasShield, equipShield, foodItems, foodPoints, rawFoodCount
}
