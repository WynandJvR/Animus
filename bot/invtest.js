'use strict'
// OFFLINE unit tests for the INV_DISCIPLINE (banking + inventory discipline) pure logic:
//   mining.toolUsesLeft / pickUsesLeft delegation, maintain.toolIsJunk, maintain.craftBudgetForSpace,
//   and the planProvision wooden-pickaxe bank-awareness (bankPickaxes). No server, no bot, no I/O.
// Run:  cd bot && node invtest.js   -> prints PASS/FAIL per case, exits non-zero on fail.

const assert = require('assert')
const mining = require('./mining.js')
const maintain = require('./maintain.js')
const provision = require('./provision.js')
const mcData = require('minecraft-data')('1.21.11')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.stack) } }

// ---- toolUsesLeft: per-material, all tool kinds; pickUsesLeft delegation identical ----------
t('toolUsesLeft: per-material durability for every tool kind', () => {
  assert.strictEqual(mining.toolMaxUses('wooden_pickaxe'), 59)
  assert.strictEqual(mining.toolMaxUses('stone_axe'), 131)
  assert.strictEqual(mining.toolMaxUses('iron_sword'), 250)
  assert.strictEqual(mining.toolMaxUses('golden_shovel'), 32)
  assert.strictEqual(mining.toolMaxUses('diamond_hoe'), 1561)
  assert.strictEqual(mining.toolMaxUses('netherite_pickaxe'), 2031)
  assert.strictEqual(mining.toolMaxUses('not_a_tool'), 0)
  assert.strictEqual(mining.toolUsesLeft('wooden_pickaxe', 0), 59, 'brand new')
  assert.strictEqual(mining.toolUsesLeft('wooden_pickaxe', undefined), 59, 'undefined = new')
  assert.strictEqual(mining.toolUsesLeft('stone_axe', 120), 11)
  assert.strictEqual(mining.toolUsesLeft('iron_sword', 250), 0, 'spent')
  assert.strictEqual(mining.toolUsesLeft('iron_sword', 9999), 0, 'never negative')
  assert.strictEqual(mining.toolUsesLeft('not_a_tool', 0), 0)
})

t('pickUsesLeft: delegates to toolUsesLeft but stays pickaxe-only (unchanged behavior)', () => {
  // identical to the old table for pickaxes
  assert.strictEqual(mining.pickUsesLeft('stone_pickaxe', 0), 131)
  assert.strictEqual(mining.pickUsesLeft('stone_pickaxe', 120), 11)
  assert.strictEqual(mining.pickUsesLeft('stone_pickaxe', 200), 0)
  // pickaxe-only: a sword/axe still returns 0 from pickUsesLeft (would-be 250 via toolUsesLeft)
  assert.strictEqual(mining.pickUsesLeft('iron_sword', 0), 0, 'pickUsesLeft must NOT report a sword')
  assert.strictEqual(mining.pickUsesLeft('stone_axe', 0), 0, 'pickUsesLeft must NOT report an axe')
  // matches toolUsesLeft on pickaxes exactly
  for (const m of ['wooden', 'stone', 'iron', 'diamond', 'netherite', 'golden']) {
    const n = m + '_pickaxe'
    assert.strictEqual(mining.pickUsesLeft(n, 5), mining.toolUsesLeft(n, 5), n + ' delegation identical')
  }
})

// ---- toolIsJunk ------------------------------------------------------------------------------
t('toolIsJunk: worn pick with a working spare -> junk', () => {
  assert.strictEqual(maintain.toolIsJunk({ name: 'stone_pickaxe', usesLeft: 5 }, { workingSameKind: 1, bestSameKindTier: 3, junkMinUses: 10 }), true)
})
t('toolIsJunk: worn pick that is the LAST working -> keep (I2)', () => {
  assert.strictEqual(maintain.toolIsJunk({ name: 'stone_pickaxe', usesLeft: 5 }, { workingSameKind: 0, bestSameKindTier: 3, junkMinUses: 10 }), false)
})
t('toolIsJunk: wooden pick with a working stone pick -> junk (obsolete)', () => {
  assert.strictEqual(maintain.toolIsJunk({ name: 'wooden_pickaxe', usesLeft: 40 }, { workingSameKind: 0, bestSameKindTier: 3, junkMinUses: 10 }), true)
})
t('toolIsJunk: wooden pick alone -> keep', () => {
  assert.strictEqual(maintain.toolIsJunk({ name: 'wooden_pickaxe', usesLeft: 40 }, { workingSameKind: 0, bestSameKindTier: 1, junkMinUses: 10 }), false)
})
t('toolIsJunk: wooden sword vs a stone sword -> junk (obsolete, same ladder)', () => {
  assert.strictEqual(maintain.toolIsJunk({ name: 'wooden_sword', usesLeft: 30 }, { workingSameKind: 0, bestSameKindTier: 3, junkMinUses: 10 }), true)
})
t('toolIsJunk: brand-new wooden pick with a stone pick -> junk (obsolete beats fresh)', () => {
  assert.strictEqual(maintain.toolIsJunk({ name: 'wooden_pickaxe', usesLeft: 59 }, { workingSameKind: 0, bestSameKindTier: 3, junkMinUses: 10 }), true)
})
t('toolIsJunk: undefined usesLeft (assume working) + no better tool -> keep', () => {
  assert.strictEqual(maintain.toolIsJunk({ name: 'stone_pickaxe', usesLeft: undefined }, { workingSameKind: 0, bestSameKindTier: 3, junkMinUses: 10 }), false)
})

// ---- craftBudgetForSpace ---------------------------------------------------------------------
t('craftBudgetForSpace: reserves a slot and caps to what fits', () => {
  assert.strictEqual(maintain.craftBudgetForSpace(147, 0, 64), 0, 'no free slots -> 0')
  assert.strictEqual(maintain.craftBudgetForSpace(147, 1, 64, 1), 0, 'one slot, reserve 1 -> 0')
  assert.strictEqual(maintain.craftBudgetForSpace(147, 3, 64, 1), 128, 'min(147, (3-1)*64)')
  assert.strictEqual(maintain.craftBudgetForSpace(10, 5, 64, 1), 10, 'needed < capacity -> needed')
  assert.strictEqual(maintain.craftBudgetForSpace(147, -5, 64, 1), 0, 'never negative')
  assert.strictEqual(maintain.craftBudgetForSpace(10, 5, 1, 1), 4, 'stackSize 1 (tools): (5-1)*1')
})

// ---- planProvision: banked wooden picks -> withdraw, not craft (INV_TOOLBANK core) -----------
t('planProvision: bankPickaxes vouches banked picks -> NO craft:wooden_pickaxe, used>=1', () => {
  const bom = { cobblestone: 64 } // gathers.cobblestone -> the wooden-pick special-case fires
  const plan = provision.planProvision(mcData, bom, { wooden_pickaxe: 10 }, { freshPickaxes: 0, bankPickaxes: 10 })
  const keys = plan.tasks.map(x => x.type + ':' + (x.item || x.output))
  assert(!keys.includes('craft:wooden_pickaxe'), 'must NOT craft a pick with 10 banked: ' + keys.join(' > '))
  assert(!(plan.crafts && plan.crafts.wooden_pickaxe), 'no wooden_pickaxe craftReq: ' + JSON.stringify(plan.crafts && plan.crafts.wooden_pickaxe))
  assert((plan.used.wooden_pickaxe || 0) >= 1, 'must consume banked stock so reconcile withdraws it: ' + JSON.stringify(plan.used))
})

t('planProvision: bankPickaxes=0 -> crafts (today behavior preserved byte-for-byte)', () => {
  const bom = { cobblestone: 64 }
  const withBank0 = provision.planProvision(mcData, bom, { wooden_pickaxe: 10 }, { freshPickaxes: 0, bankPickaxes: 0 })
  const legacy = provision.planProvision(mcData, bom, { wooden_pickaxe: 10 }, { freshPickaxes: 0 }) // no bankPickaxes at all
  const k0 = withBank0.tasks.map(x => x.type + ':' + (x.item || x.output))
  const kl = legacy.tasks.map(x => x.type + ':' + (x.item || x.output))
  assert(k0.includes('craft:wooden_pickaxe'), 'bankPickaxes=0 must craft a pick (today): ' + k0.join(' > '))
  assert.deepStrictEqual(k0, kl, 'bankPickaxes=0 and bankPickaxes-absent must be identical plans')
  assert.deepStrictEqual(withBank0.used, legacy.used, 'used ledger identical')
})

t('planProvision: bankPickaxes is INERT when no cobble is gathered (I6 no collateral)', () => {
  // The wooden-pick special-case only fires under `gathers.cobblestone`. A BOM that never gathers
  // cobble must produce a byte-identical plan whether or not bankPickaxes is supplied - proving the
  // new input enters ONLY through the pickaxe block and touches nothing else.
  const bom = { crafting_table: 1, stick: 4 } // wood-phase only, no pick-gated gather
  const a = provision.planProvision(mcData, bom, {}, { freshPickaxes: 0, bankPickaxes: 5, primaryWood: 'oak' })
  const b = provision.planProvision(mcData, bom, {}, { freshPickaxes: 0, primaryWood: 'oak' })
  assert.deepStrictEqual(a.tasks, b.tasks, 'task list identical - bankPickaxes inert without a cobble gather')
  assert.deepStrictEqual(a.used, b.used, 'used ledger identical')
  assert.deepStrictEqual(a.gathers, b.gathers, 'gathers identical')
  assert.deepStrictEqual(a.crafts, b.crafts, 'craftReq identical')
})

t('planProvision: with a cobble gather, bankPickaxes changes ONLY the wooden_pickaxe used-entry', () => {
  // When the pick block DOES fire, banked picks reduce pick crafting; the only used-ledger key that
  // may differ is wooden_pickaxe itself (downstream wood for those picks is a correct consequence,
  // not collateral on an unrelated resource). No OTHER used key changes.
  const bom = { cobblestone: 64 }
  const a = provision.planProvision(mcData, bom, { wooden_pickaxe: 10 }, { freshPickaxes: 0, bankPickaxes: 10 })
  const b = provision.planProvision(mcData, bom, { wooden_pickaxe: 10 }, { freshPickaxes: 0, bankPickaxes: 0 })
  const noPick = u => { const o = { ...u }; delete o.wooden_pickaxe; return o }
  assert.deepStrictEqual(noPick(a.used), noPick(b.used), 'no non-pickaxe used key changes')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall inventory-discipline tests passed')
process.exit(failures ? 1 : 0)
