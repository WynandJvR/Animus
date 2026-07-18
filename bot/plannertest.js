'use strict'
// OFFLINE unit test for the planner's DECISION logic (bot/planner.js decide()).
// No server, no bot, no I/O - pure planProvision + frontier/blocked-set/legality
// checks against synthetic holdings (same style as the old plantest.js scripts).
// Run:  cd bot && node plannertest.js   -> prints PASS/FAIL per case, exits non-zero on fail.

const assert = require('assert')
const mcData = require('minecraft-data')('1.21.11')
const { decide, packHasToolFor, taskKey, shouldRegroupForCraft } = require('./planner.js')

const GOAL_BOOTS = { iron_boots: 1 }
const GOAL_SET = { iron_boots: 1, iron_helmet: 1, iron_leggings: 1, iron_chestplate: 1 }

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

// 1) NAKED + TOOLLESS: the very first doable action must be "get wood" - the root of
// the whole chain (log -> planks -> table/sticks -> wooden pick -> cobble -> ...).
t('holdings={} -> first action is gather:<wood log>', () => {
  const d = decide(mcData, GOAL_SET, {})
  assert(d.task, 'expected a task, got ' + JSON.stringify(d))
  assert.strictEqual(d.task.type, 'gather')
  assert(/_log$/.test(d.task.item), 'expected a log gather, got ' + taskKey(d.task))
})

// 2) MID-TREE: stone pick + furnace + table + coal in hand -> the frontier must be
// "mine iron" (nothing earlier in the chain is missing; coal covers the smelt fuel).
t('stone pickaxe + furnace + coal + table -> mine iron', () => {
  const holdings = { stone_pickaxe: 1, furnace: 1, crafting_table: 1, coal: 8 }
  const d = decide(mcData, GOAL_BOOTS, holdings)
  assert(d.task, 'expected a task, got ' + JSON.stringify(d))
  assert.strictEqual(taskKey(d.task), 'gather:raw_iron')
})

// 3) BLOCKED PRIMARY -> ALTERNATIVE, never nothing. Same mid-tree state but the iron
// gather is blocked (hut apron / unreachable face): decide must offer RELOCATE (move
// somewhere diggable and retry), not give up - the reference-trap fix.
t('blocked gather:raw_iron -> relocate alternative (not nothing)', () => {
  const holdings = { stone_pickaxe: 1, furnace: 1, crafting_table: 1, coal: 8 }
  const d = decide(mcData, GOAL_BOOTS, holdings, { blocked: new Set(['gather:raw_iron']) })
  assert.strictEqual(d.type, 'relocate', 'expected relocate, got ' + JSON.stringify({ type: d.type, task: d.task && taskKey(d.task) }))
  assert.strictEqual(d.item, 'raw_iron')
})

// 4) RELOCATE ALSO BLOCKED -> still an action (explore), not a dead end.
t('blocked gather + blocked relocate -> explore', () => {
  const holdings = { stone_pickaxe: 1, furnace: 1, crafting_table: 1, coal: 8 }
  const d = decide(mcData, GOAL_BOOTS, holdings, { blocked: new Set(['gather:raw_iron', 'relocate:raw_iron']) })
  assert.strictEqual(d.type, 'explore', 'expected explore, got ' + JSON.stringify({ type: d.type, task: d.task && taskKey(d.task) }))
})

// 5) LEGALITY SKIP (the planProvision phase-ordering quirk): plan lists gather:raw_iron
// BEFORE craft:stone_pickaxe (otherGathers phase precedes finals), but with only a
// WOODEN pick that gather is illegal (iron ore drops nothing below stone tier) - the
// frontier must skip it and pick an enabling craft instead of mining ore for nothing.
t('only wooden pick -> skips gather:raw_iron, picks an enabling craft', () => {
  const holdings = { wooden_pickaxe: 1, crafting_table: 1, oak_planks: 24, stick: 8, cobblestone: 24, coal: 8 }
  const d = decide(mcData, GOAL_BOOTS, holdings)
  assert(d.task, 'expected a task, got ' + JSON.stringify(d))
  assert.notStrictEqual(taskKey(d.task), 'gather:raw_iron', 'must not mine iron with a wooden pick')
  assert.strictEqual(d.task.type, 'craft', 'expected a craft (stone pick / furnace), got ' + taskKey(d.task))
})

// 6) SMELT LEGALITY: raw iron in hand + furnace -> smelt is the frontier (no gather,
// no craft before it); with NO raw iron the smelt is illegal and the gather comes first.
t('raw iron in hand -> smelt is next; none -> gather first', () => {
  const rich = { stone_pickaxe: 1, furnace: 1, crafting_table: 1, coal: 8, raw_iron: 4 }
  const d1 = decide(mcData, GOAL_BOOTS, rich)
  assert(d1.task, 'expected a task, got ' + JSON.stringify(d1))
  assert.strictEqual(taskKey(d1.task), 'smelt:iron_ingot')
  const poor = { ...rich, raw_iron: 0 }
  const d2 = decide(mcData, GOAL_BOOTS, poor)
  assert.strictEqual(taskKey(d2.task), 'gather:raw_iron')
})

// 7) DONE: holdings already satisfy the goal -> {done:true}, no task invented.
t('goal already held -> done', () => {
  const d = decide(mcData, GOAL_BOOTS, { iron_boots: 1 })
  assert.strictEqual(d.done, true, 'expected done, got ' + JSON.stringify({ type: d.type, task: d.task && taskKey(d.task) }))
})

// 8) INGOTS IN THE BANK -> craft, not mine: 24 ingots + a table means the whole set is
// a pure craft job (withdraw>craft>gather - the resource-model rule holds in the plan).
t('24 ingots + table -> first action is a craft, never a gather', () => {
  const d = decide(mcData, GOAL_SET, { iron_ingot: 24, crafting_table: 1 })
  assert(d.task, 'expected a task, got ' + JSON.stringify(d))
  assert.strictEqual(d.task.type, 'craft', 'expected craft, got ' + taskKey(d.task))
  assert(/^iron_/.test(d.task.item), 'expected an iron piece craft, got ' + d.task.item)
})

// 9) TOOL-TIER GUARD: golden/wooden picks must NOT satisfy a stone_pickaxe gate;
// stone and better must.
t('packHasToolFor tiers: wood/gold fail stone gate, stone/iron pass', () => {
  assert.strictEqual(packHasToolFor({ wooden_pickaxe: 1 }, 'stone_pickaxe'), false)
  assert.strictEqual(packHasToolFor({ golden_pickaxe: 1 }, 'stone_pickaxe'), false)
  assert.strictEqual(packHasToolFor({ stone_pickaxe: 1 }, 'stone_pickaxe'), true)
  assert.strictEqual(packHasToolFor({ iron_pickaxe: 1 }, 'stone_pickaxe'), true)
  assert.strictEqual(packHasToolFor({ iron_axe: 1 }, 'stone_pickaxe'), false) // right tier, wrong kind
})

// 10) FULL-CHAIN SANITY: walk decide() forward from nothing, simulating perfect
// execution of each leaf, and check the chain visits wood -> wooden pick -> cobble ->
// stone pick -> iron -> smelt -> boots without ever going illegal or dead-ending.
t('simulated walk from nothing reaches iron_boots via the full tech tree', () => {
  const holdings = {}
  const visited = []
  for (let i = 0; i < 40; i++) {
    // vouch for the simulated (never-worn) picks like runGoal does at runtime -
    // planProvision zeroes unvouched picks and would re-plan one every round
    const d = decide(mcData, GOAL_BOOTS, holdings, { planOpts: { freshPickaxes: holdings.wooden_pickaxe || 0 } })
    if (d.done) break
    assert(d.task, 'walk dead-ended at step ' + i + ': ' + JSON.stringify({ type: d.type }))
    const t0 = d.task
    visited.push(taskKey(t0))
    // simulate perfect execution: credit the task's output into holdings (and consume
    // nothing - planProvision re-nets each round, surplus just shortens the walk)
    if (t0.type === 'gather') holdings[t0.item] = (holdings[t0.item] || 0) + t0.count
    else if (t0.type === 'craft') holdings[t0.item] = (holdings[t0.item] || 0) + t0.crafts * t0.perCraft
    else if (t0.type === 'smelt') holdings[t0.output] = (holdings[t0.output] || 0) + t0.count
    else if (t0.type === 'strip') holdings[t0.output] = (holdings[t0.output] || 0) + t0.count
  }
  const saw = re => visited.some(k => re.test(k))
  assert(saw(/^gather:\w+_log$/), 'never gathered wood: ' + visited.join(' > '))
  assert(saw(/^craft:wooden_pickaxe$/), 'never made a wooden pick: ' + visited.join(' > '))
  assert(saw(/^gather:cobblestone$/), 'never mined cobble: ' + visited.join(' > '))
  assert(saw(/^craft:stone_pickaxe$/), 'never made a stone pick: ' + visited.join(' > '))
  assert(saw(/^gather:raw_iron$/), 'never mined iron: ' + visited.join(' > '))
  assert(saw(/^smelt:iron_ingot$/), 'never smelted: ' + visited.join(' > '))
  assert(saw(/^craft:iron_boots$/), 'never crafted the boots: ' + visited.join(' > '))
  // and the tool gate held: iron was only mined AFTER the stone pick existed
  assert(visited.indexOf('gather:raw_iron') > visited.indexOf('craft:stone_pickaxe'), 'mined iron before the stone pick: ' + visited.join(' > '))
  console.log('      chain: ' + visited.join(' > '))
})

// 11) REGROUP-BEFORE-CRAFT (slice 1.1): a station-craft (table/furnace window) must NOT
// run in a mining pit - it windowOpen-times-out and the run ends naked (live). Regroup
// to open ground when underground OR off-anchor; gathers dig down on purpose (never
// regroup); withdrawing/wearing don't open a station.
t('shouldRegroupForCraft: craft/smelt regroup underground or far, gather never', () => {
  assert.strictEqual(shouldRegroupForCraft('craft', true, false), true, 'craft underground must regroup')
  assert.strictEqual(shouldRegroupForCraft('craft', false, true), true, 'craft far from anchor must regroup')
  assert.strictEqual(shouldRegroupForCraft('smelt', true, false), true, 'smelt underground must regroup')
  assert.strictEqual(shouldRegroupForCraft('craft', false, false), false, 'craft on open ground at anchor: no regroup')
  assert.strictEqual(shouldRegroupForCraft('gather', true, true), false, 'a gather digs down - never regroup it')
})

// 12) SUB-GOAL CAP (slice 1.2): the incremental gear-up runs ONE piece at a time. A
// single-piece goal makes decide() gather only THAT piece's iron (boots = 4), so the bot
// smelts+wears after ~4 iron - not after all 24. Contrast the whole-set goal (24), which
// is exactly the long naked-mining window sub-goals eliminate.
t('single-piece boots goal gathers 4 iron, full-set goal gathers 24 (why sub-goals)', () => {
  // 2 furnaces so a 24-item smelt doesn't plan a 2nd furnace (which would drag in
  // cobble->wooden_pick->wood and mask the count we're testing). Isolates iron count.
  const mid = { stone_pickaxe: 1, furnace: 2, crafting_table: 1, coal: 16 }
  const d1 = decide(mcData, { iron_boots: 1 }, mid)
  assert.strictEqual(taskKey(d1.task), 'gather:raw_iron', 'boots frontier should be the iron gather')
  assert.strictEqual(d1.task.count, 4, 'boots sub-goal must gather only 4 raw iron, got ' + d1.task.count)
  const dAll = decide(mcData, { iron_boots: 1, iron_helmet: 1, iron_leggings: 1, iron_chestplate: 1 }, mid)
  assert.strictEqual(taskKey(dAll.task), 'gather:raw_iron')
  assert.strictEqual(dAll.task.count, 24, 'the whole-set goal gathers 24 up front - the naked window sub-goals fix; got ' + dAll.task.count)
})

// WHEAT FARM HOE CHAIN (food follow-through): a wooden_hoe from nothing must chain
// gather-log -> planks -> sticks -> hoe (NOT be "unobtainable"). This is what makes the farm
// build reliably instead of "no hoe and cannot craft one" - reconcile runs this plan.
t('wooden_hoe from nothing chains log->planks->sticks->hoe (never unobtainable)', () => {
  const provision = require('./provision.js')
  const fromNothing = provision.planProvision(mcData, { wooden_hoe: 1 }, {}, { primaryWood: 'oak' })
  assert.strictEqual(Object.keys(fromNothing.unobtainable || {}).length, 0, 'a hoe is always obtainable where wood is reachable')
  const keys = fromNothing.tasks.map(t => t.type + ':' + (t.item || t.output))
  assert(keys.some(k => /^gather:\w+_log$/.test(k)), 'gathers a log: ' + keys.join(' > '))
  assert(keys.includes('craft:stick'), 'crafts sticks')
  assert(keys.includes('craft:wooden_hoe'), 'crafts the hoe')
  // with logs already in hand -> no gather, just the craft chain
  const withLogs = provision.planProvision(mcData, { wooden_hoe: 1 }, { oak_log: 4 }, { primaryWood: 'oak' })
  assert(!withLogs.tasks.some(t => t.type === 'gather'), 'has logs -> no gather, just craft: ' + withLogs.tasks.map(t => t.type + ':' + (t.item || t.output)).join(' > '))
})

// GEAR-UP CONVERGENCE (#19): a pass that MINED iron but wore no piece must count as
// PROGRESS (banked iron survives death and counts next pass), so it must NOT feed the
// fruitless back-off. The old score read the PACK, which the end-of-run autoBank empties,
// so a productive mining pass read as zero progress and cooled itself off for ~28 min.
t('gearupProgressed: mined+banked iron (no piece worn) counts as PROGRESS', () => {
  const { gearupProgressed } = require('./planner.js')
  // 4 bare slots throughout (wore nothing), total iron 0 -> 4 (mined+banked): PROGRESS
  assert.strictEqual(gearupProgressed(4, 4, 0, 4), true, 'mining+banking iron must be progress')
  // wore a piece (bare 4 -> 3) even with no net iron gain (spent it on the piece): PROGRESS
  assert.strictEqual(gearupProgressed(4, 3, 0, 0), true, 'wearing a piece must be progress')
  // GENUINELY fruitless: no piece worn AND no iron netted anywhere -> back-off may fire
  assert.strictEqual(gearupProgressed(4, 4, 0, 0), false, 'no piece + no iron is fruitless')
  // withdraw/deposit shuffling nets to zero on a TOTAL measure -> not spurious progress
  assert.strictEqual(gearupProgressed(4, 4, 7, 7), false, 'flat total iron, no piece: not progress')
})

// BANKED IRON -> WITHDRAW+CRAFT, never re-gather (#19 short-circuit + Bug-3 verification).
// Given a boots goal and enough banked iron, planProvision must CONSUME the banked ingots
// (plan.used) and plan NO raw_iron gather and NO smelt - the reconcile path then withdraws
// them. This is what makes "4 ingots in the chest -> free boots" work instead of mining anew.
t('banked iron_ingot drives craft:iron_boots via plan.used (no re-gather, no smelt)', () => {
  const provision = require('./provision.js')
  const plan = provision.planProvision(mcData, { iron_boots: 1 }, { iron_ingot: 4 }, {})
  assert.strictEqual(plan.used.iron_ingot, 4, 'must consume the 4 banked ingots, got ' + JSON.stringify(plan.used))
  assert(!(plan.gathers && plan.gathers.raw_iron), 'must NOT re-gather raw iron: ' + JSON.stringify(plan.gathers))
  assert.strictEqual((plan.smelts || []).length, 0, 'must NOT smelt when ingots are already banked')
  const keys = plan.tasks.map(x => x.type + ':' + (x.item || x.output))
  assert(keys.includes('craft:iron_boots'), 'must craft the boots: ' + keys.join(' > '))
  // mixed banked stock (2 ingots + 2 raw) still credits BOTH toward the 4 needed (no over-mining)
  const mixed = provision.planProvision(mcData, { iron_boots: 1 }, { iron_ingot: 2, raw_iron: 2 }, {})
  assert.strictEqual(mixed.used.iron_ingot, 2, 'credits the 2 banked ingots')
  assert.strictEqual(mixed.used.raw_iron, 2, 'credits the 2 banked raw iron (smelts them, not mines more)')
  assert(!(mixed.gathers && mixed.gathers.raw_iron), 'no raw-iron gather when the 4 are already banked: ' + JSON.stringify(mixed.gathers))
})

// SMART SMELT FUEL (#26): the PURE smeltFuelPlan predicate. coal/charcoal=8 items each,
// coal_block=80; the uncovered remainder is MADE into charcoal (log->charcoal) above a floor,
// else covered with planks. Flag off reproduces today's plank numbers byte-for-byte.
t('smeltFuelPlan: coal covers all -> no charcoal, no planks', () => {
  const { smeltFuelPlan } = require('./provision.js')
  const fp = smeltFuelPlan(96, { coal: 12 }, { smart: true })          // 12*8 = 96 units
  assert.strictEqual(fp.makeCharcoal, 0, 'coal covers it -> make no charcoal')
  assert.strictEqual(fp.needPlanks, 0, 'coal covers it -> plan no planks')
  assert.strictEqual(fp.useCoal, true, 'nets the coal')
})

t('smeltFuelPlan: partial coal -> charcoal only for the remainder', () => {
  const { smeltFuelPlan } = require('./provision.js')
  const fp = smeltFuelPlan(96, { coal: 4 }, { smart: true })           // 32 covered, 64 uncovered
  assert.strictEqual(fp.makeCharcoal, Math.min(64, Math.ceil(64 / 8) + 1), 'charcoal sized to the uncovered 64 (=9)')
  assert.strictEqual(fp.makeCharcoal, 9)
  assert.strictEqual(fp.needPlanks, 0, 'no plank remainder when charcoal covers it')
})

t('smeltFuelPlan: small smelt (uncovered <= 12) -> planks only, no charcoal', () => {
  const { smeltFuelPlan } = require('./provision.js')
  const fp = smeltFuelPlan(10, {}, { smart: true, nWant: 1 })
  assert.strictEqual(fp.makeCharcoal, 0, 'below the floor -> no two-stage charcoal smelt')
  assert.strictEqual(fp.needPlanks, Math.ceil(10 / 1.5) + 2 + 2, 'plank branch covers the snack smelt')
  // boundary: 12 is NOT worth charcoal, 13 IS
  assert.strictEqual(smeltFuelPlan(12, {}, { smart: true }).makeCharcoal, 0, '12 -> planks')
  assert(smeltFuelPlan(13, {}, { smart: true }).makeCharcoal > 0, '13 -> charcoal')
})

t('smeltFuelPlan: charcoal capped at one stack (64) for monster smelts', () => {
  const { smeltFuelPlan } = require('./provision.js')
  const fp = smeltFuelPlan(600, {}, { smart: true })                   // ceil(600/8)+1 = 76 -> capped
  assert.strictEqual(fp.makeCharcoal, 64, 'nChar cap = 64')
  assert.strictEqual(fp.charcoalPlanks, Math.ceil(64 / 1.5) + 2, 'bootstrap planks sized to nChar only')
})

t('smeltFuelPlan: SMART off -> today plank numbers byte-for-byte (no charcoal ever)', () => {
  const { smeltFuelPlan } = require('./provision.js')
  for (const [count, nWant] of [[96, 1], [96, 4], [32, 1], [8, 2]]) {
    const fp = smeltFuelPlan(count, {}, { smart: false, nWant })
    assert.strictEqual(fp.makeCharcoal, 0, 'flag off never makes charcoal')
    assert.strictEqual(fp.needPlanks, Math.ceil(count / 1.5) + 2 + 2 * nWant, `legacy plank count for ${count}/${nWant}`)
  }
  // partial coal, flag off: nets coal, covers the rest with planks (old branch)
  const fp = smeltFuelPlan(96, { coal: 4 }, { smart: false, nWant: 1 })
  assert.strictEqual(fp.needPlanks, Math.ceil(64 / 1.5) + 2 + 2, 'flag off nets coal then planks the remainder')
})

// #66 FUEL_PROVISION (PURE): how many coal-family pieces to withdraw from the bank before a smelt,
// bank-first, given {smeltCount, packFuelUnits, bankCoal}. Flag-independent (the gate lives in
// provisionSmeltFuel), so this passes under both FUEL_PROVISION regimes.
t('fuelBankWithdrawAmount: sizes the bank coal withdraw from the smelt shortfall (bank-first)', () => {
  const { fuelBankWithdrawAmount } = require('./provision.js')
  // empty pack, need 32 items smelted: 32/8 = 4 coal, full bank covers it
  assert.strictEqual(fuelBankWithdrawAmount(32, 0, 64, 8), 4, 'empty pack, 32 items -> withdraw 4 coal')
  // pack already carries 16 units of fuel: only the 16-unit shortfall (ceil(16/8)=2) is drawn
  assert.strictEqual(fuelBankWithdrawAmount(32, 16, 64, 8), 2, 'pack has 16 units -> only 2 coal for the remainder')
  // non-multiple shortfall rounds UP (never leave 1 item uncovered)
  assert.strictEqual(fuelBankWithdrawAmount(4, 0, 64, 8), 1, '4 items -> 1 coal (round up)')
  // bank short: capped at what the bank holds, wood fallback covers the rest
  assert.strictEqual(fuelBankWithdrawAmount(80, 0, 3, 8), 3, 'bank has 3 -> withdraw all 3, wood covers the rest')
  // pack already covered -> 0 (no bank trip), never negative
  assert.strictEqual(fuelBankWithdrawAmount(8, 16, 64, 8), 0, 'pack over-covered -> 0, never negative')
  // unknown bank stock (null) -> request the full shortfall
  assert.strictEqual(fuelBankWithdrawAmount(64, 0, null, 8), 8, 'unknown bank -> full 8-coal shortfall')
  // coal_block smelts 80 items each -> one block covers a 64-item smelt
  assert.strictEqual(fuelBankWithdrawAmount(64, 0, 64, 80), 1, 'coal_block (80/pc) -> 1 block for 64 items')
})

// INTEGRATION: a stone smelt with no coal. SMART on (default) plans a charcoal smelt ORDERED
// BEFORE the stone smelt (charcoal is burned by it); SMART off plans no charcoal (legacy planks).
// Branches on the env flag so this passes under both settings (proves the byte-for-byte rollback).
t('planProvision: SMART orders charcoal smelt before the main smelt (off => legacy, no charcoal)', () => {
  const provision = require('./provision.js')
  const smart = process.env.SMELT_FUEL_SMART !== '0'
  const plan = provision.planProvision(mcData, { stone: 96 }, {}, { primaryWood: 'oak' })
  const smeltKeys = plan.tasks.filter(x => x.type === 'smelt').map(x => x.output)
  assert(smeltKeys.includes('stone'), 'always plans the stone smelt')
  assert(!plan.tasks.some(x => x.type === 'smelt' && x.input === 'stick'), 'never a stick-fuelled smelt')
  if (smart) {
    assert(smeltKeys.includes('charcoal'), 'SMART plans a charcoal fuel smelt: ' + smeltKeys.join(','))
    assert(smeltKeys.indexOf('charcoal') < smeltKeys.indexOf('stone'), 'charcoal must run before stone: ' + smeltKeys.join(','))
  } else {
    assert(!smeltKeys.includes('charcoal'), 'SMART off makes no charcoal: ' + smeltKeys.join(','))
    assert(plan.tasks.some(x => x.type === 'craft' && /_planks$/.test(x.item)), 'SMART off plans plank fuel')
  }
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall planner decision tests passed')
process.exit(failures ? 1 : 0)
