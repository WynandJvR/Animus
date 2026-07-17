'use strict'
// OFFLINE unit test for the proactive-buffer model (bot/maintain.js) - PURE, no bot. Proves:
// the food->gear->torches ordering; each floor triggers independently at floor-1 and NOT at
// target; the floor/target gap is a real hysteresis band (a buffer between floor and target is
// NOT re-triggered); all-satisfied -> []; env overrides apply live; bankFood needs home
// reachable.
// Run:  cd bot && node maintaintest.js

const assert = require('assert')
const M = require('./maintain.js')

let failures = 0
function t (name, fn) {
  M._reset()
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}

// a fully-satisfied snapshot; override to force individual deficits.
function snap (over) {
  return Object.assign({
    packFoodPts: 24, bankFoodPts: 40, armorPieces: 4,
    tools: { pick: true, axe: true, sword: true, sparePick: true },
    torches: 8, homeReachable: true
  }, over || {})
}
const keys = arr => arr.map(x => x.key)

t('ordering: packFood, armor, torches under floor -> keys in food->gear->torches order', () => {
  const s = snap({ packFoodPts: 0, armorPieces: 2, torches: 0 })
  assert.deepStrictEqual(keys(M.needs(s)), ['packFood', 'armor', 'torches'])
})

t('full ordering across all five buffers', () => {
  const s = snap({ packFoodPts: 0, bankFoodPts: 0, armorPieces: 1, tools: { pick: false, axe: true, sword: true, sparePick: true }, torches: 0 })
  assert.deepStrictEqual(keys(M.needs(s)), ['packFood', 'bankFood', 'armor', 'tools', 'torches'])
})

t('each floor triggers at floor-1, NOT at target', () => {
  assert.deepStrictEqual(keys(M.needs(snap({ packFoodPts: 11 }))), ['packFood'], 'packFood at 11 (<12)')
  assert.deepStrictEqual(keys(M.needs(snap({ packFoodPts: 24 }))), [], 'packFood at target 24 -> none')
  assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 15 }))), ['bankFood'], 'bankFood at 15 (<16)')
  assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 40 }))), [], 'bankFood at target 40 -> none')
  assert.deepStrictEqual(keys(M.needs(snap({ torches: 3 }))), ['torches'], 'torches at 3 (<4)')
  assert.deepStrictEqual(keys(M.needs(snap({ torches: 8 }))), [], 'torches at target 8 -> none')
  assert.deepStrictEqual(keys(M.needs(snap({ armorPieces: 3 }))), ['armor'], 'armor 3 (<4)')
  assert.deepStrictEqual(keys(M.needs(snap({ armorPieces: 4 }))), [], 'armor 4 -> none')
})

t('hysteresis band: packFood between floor(12) and target(24) is NOT a need', () => {
  assert.deepStrictEqual(keys(M.needs(snap({ packFoodPts: 18 }))), [], 'in the band (18) -> satisfied, anti-churn')
  assert.deepStrictEqual(keys(M.needs(snap({ packFoodPts: 11 }))), ['packFood'], 'below floor (11) -> need')
  assert.deepStrictEqual(keys(M.needs(snap({ packFoodPts: 24 }))), [], 'at target (24) -> satisfied')
})

t('deficit + target reported', () => {
  const n = M.needs(snap({ packFoodPts: 4 }))[0]
  assert.strictEqual(n.key, 'packFood')
  assert.strictEqual(n.target, 24)
  assert.strictEqual(n.deficit, 20)
})

t('all-satisfied -> []', () => {
  assert.deepStrictEqual(M.needs(snap({})), [])
})

t('tools: absent tools object is NOT measured (no spurious need)', () => {
  const s = snap({}); delete s.tools
  assert.deepStrictEqual(keys(M.needs(s)), [], 'no tools field -> tools not measured')
  // but a present tools object with a gap DOES trigger
  assert.deepStrictEqual(keys(M.needs(snap({ tools: { pick: true, axe: false, sword: true, sparePick: true } }))), ['tools'])
})

t('env override: MAINT_PACKFOOD_FLOOR=20 makes packFoodPts 18 a need (restored in finally)', () => {
  const saved = process.env.MAINT_PACKFOOD_FLOOR
  try {
    process.env.MAINT_PACKFOOD_FLOOR = '20'
    assert.deepStrictEqual(keys(M.needs(snap({ packFoodPts: 18 }))), ['packFood'], '18 < 20 now triggers')
  } finally {
    if (saved != null) process.env.MAINT_PACKFOOD_FLOOR = saved
    else delete process.env.MAINT_PACKFOOD_FLOOR
  }
  // restored: 18 is back in the band and no longer a need
  assert.deepStrictEqual(keys(M.needs(snap({ packFoodPts: 18 }))), [], 'env restored -> 18 satisfied again')
})

t('bankFood needs home reachable: unreachable bank -> deficit NOT emitted', () => {
  assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 0, homeReachable: false }))), [], 'cannot courier to an unreachable bank')
  assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 0, homeReachable: true }))), ['bankFood'], 'reachable bank low -> need')
})

// ==== BREAD_ENGINE: engine-aware bank floor/target =======================================
// helper: run fn with a temporary env, always restored.
function withEnv (overrides, fn) {
  const saved = {}
  for (const k of Object.keys(overrides)) saved[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(overrides)) { if (v == null) delete process.env[k]; else process.env[k] = v }
    fn()
  } finally {
    for (const k of Object.keys(overrides)) { if (saved[k] != null) process.env[k] = saved[k]; else delete process.env[k] }
  }
}

t('needs(): BREAD_ENGINE ON (default) -> bank floor 40 / target 80', () => {
  withEnv({ BREAD_ENGINE: null, MAINT_BANKFOOD_FLOOR: null, MAINT_BANKFOOD_TARGET: null, BREAD_BANK_TARGET: null }, () => {
    assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 39 }))), ['bankFood'], '39 < 40 floor -> need')
    assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 40 }))), [], 'at 40 floor -> satisfied')
    const n = M.needs(snap({ bankFoodPts: 0 }))[0]
    assert.strictEqual(n.target, 80, 'engine target is 80')
    assert.strictEqual(n.deficit, 80, 'deficit tops up to 80')
  })
})

t('needs(): BREAD_ENGINE=0 -> legacy bank floor 16 / target 40', () => {
  withEnv({ BREAD_ENGINE: '0', MAINT_BANKFOOD_FLOOR: null, MAINT_BANKFOOD_TARGET: null, BREAD_BANK_TARGET: null }, () => {
    assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 15 }))), ['bankFood'], '15 < 16 floor -> need')
    assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 16 }))), [], 'at 16 floor -> satisfied')
    const n = M.needs(snap({ bankFoodPts: 0 }))[0]
    assert.strictEqual(n.target, 40, 'legacy target 40')
  })
})

t('needs(): explicit MAINT_BANKFOOD_* env overrides the engine defaults', () => {
  withEnv({ BREAD_ENGINE: null, MAINT_BANKFOOD_FLOOR: '50', MAINT_BANKFOOD_TARGET: '60' }, () => {
    assert.deepStrictEqual(keys(M.needs(snap({ bankFoodPts: 45 }))), ['bankFood'], '45 < explicit floor 50 -> need')
    const n = M.needs(snap({ bankFoodPts: 0 }))[0]
    assert.strictEqual(n.target, 60, 'explicit target wins over engine 80')
  })
  // BREAD_BANK_TARGET tunes the engine target when MAINT_BANKFOOD_TARGET is unset
  withEnv({ BREAD_ENGINE: null, MAINT_BANKFOOD_TARGET: null, BREAD_BANK_TARGET: '100' }, () => {
    assert.strictEqual(M.needs(snap({ bankFoodPts: 0 }))[0].target, 100, 'BREAD_BANK_TARGET sets engine target')
  })
})

// ==== S6: courierPlan =====================================================================
const names = arr => arr.map(x => x.name)
const byName = arr => { const o = {}; for (const d of arr) o[d.name] = (o[d.name] || 0) + d.count; return o }

t('courierPlan(): BREAD_ENGINE ON (default) fills the bank to 80', () => {
  withEnv({ BREAD_ENGINE: null, MAINT_BANKFOOD_TARGET: null, BREAD_BANK_TARGET: null }, () => {
    // cooked_beef 8 pts x10 = 80. Keep 3 (24 pts); surplus 7; bank 0->80 wants 10 -> ships all 7.
    const plan = M.courierPlan([{ name: 'cooked_beef', count: 10, foodPoints: 8, tier: 0 }], 0, {})
    assert.deepStrictEqual(byName(plan), { cooked_beef: 7 }, 'engine target 80 -> ships all 7 surplus')
    // bank already at 40 is now UNDER the 80 target -> still ships toward 80.
    const plan2 = M.courierPlan([{ name: 'bread', count: 10, foodPoints: 5, tier: 0 }], 40, {})
    assert.deepStrictEqual(byName(plan2), { bread: 5 }, 'bank 40 < 80 target -> ships surplus 5')
  })
})

t('courierPlan(): explicit target env / opts win over the engine default', () => {
  withEnv({ BREAD_ENGINE: null, MAINT_BANKFOOD_TARGET: '40' }, () => {
    const plan = M.courierPlan([{ name: 'cooked_beef', count: 10, foodPoints: 8, tier: 0 }], 0, {})
    assert.deepStrictEqual(byName(plan), { cooked_beef: 5 }, 'explicit MAINT_BANKFOOD_TARGET=40 wins')
  })
  withEnv({ BREAD_ENGINE: null, MAINT_BANKFOOD_TARGET: null }, () => {
    const plan = M.courierPlan([{ name: 'cooked_beef', count: 10, foodPoints: 8, tier: 0 }], 0, { bankTarget: 40 })
    assert.deepStrictEqual(byName(plan), { cooked_beef: 5 }, 'opts.bankTarget wins over engine default')
  })
})

t('courierPlan: keeps ~24 pts on the bot, ships surplus, stops filling the bank at 40', () => {
  // LEGACY (BREAD_ENGINE=0) target 40. cooked_beef = 8 pts (tier 0), x10 = 80 pts. bank empty.
  // Keep ceil(24/8)=3 (24 pts); deposit until bank hits 40 -> 5 beef (40 pts). Pack retains 5.
  const saved = process.env.BREAD_ENGINE
  try {
    process.env.BREAD_ENGINE = '0'
    const plan = M.courierPlan([{ name: 'cooked_beef', count: 10, foodPoints: 8, tier: 0 }], 0, {})
    assert.deepStrictEqual(byName(plan), { cooked_beef: 5 }, 'ship 5 beef (bank 0->40); keep 5 (>=24 pts)')
  } finally { if (saved != null) process.env.BREAD_ENGINE = saved; else delete process.env.BREAD_ENGINE }
})

t('courierPlan: rotten_flesh (tier 2) never ships and never counts as pack keep', () => {
  const plan = M.courierPlan([
    { name: 'rotten_flesh', count: 20, foodPoints: 4, tier: 2 },
    { name: 'bread', count: 10, foodPoints: 5, tier: 0 }
  ], 0, {})
  assert.ok(!names(plan).includes('rotten_flesh'), 'rotten never in the deposit list')
  // bread keep = ceil(24/5)=5 (25 pts); surplus 5; bank 0->40 wants 8 -> ships all 5.
  assert.deepStrictEqual(byName(plan), { bread: 5 }, 'only bread ships')
})

t('courierPlan: bank already at/over target -> [] (nothing to do)', () => {
  // LEGACY (BREAD_ENGINE=0) target 40.
  const saved = process.env.BREAD_ENGINE
  try {
    process.env.BREAD_ENGINE = '0'
    assert.deepStrictEqual(M.courierPlan([{ name: 'bread', count: 10, foodPoints: 5, tier: 0 }], 40, {}), [])
    assert.deepStrictEqual(M.courierPlan([{ name: 'bread', count: 10, foodPoints: 5, tier: 0 }], 45, {}), [])
  } finally { if (saved != null) process.env.BREAD_ENGINE = saved; else delete process.env.BREAD_ENGINE }
})

t('courierPlan: empty pack -> []; and never deposits below the pack keep', () => {
  assert.deepStrictEqual(M.courierPlan([], 0, {}), [])
  // exactly the keep on hand (24 pts of bread = 5 loaves rounds to keep all) -> nothing surplus
  const plan = M.courierPlan([{ name: 'bread', count: 5, foodPoints: 5, tier: 0 }], 0, {})
  assert.deepStrictEqual(plan, [], '5 bread = 25 pts, all needed for the 24 keep -> ship nothing')
})

t('courierPlan: keeps the BEST tier on the bot, ships the lesser food to the bank', () => {
  // 3 cooked_beef (tier0, 8pts=24) fully cover the keep; raw beef (tier1) is all surplus.
  const plan = M.courierPlan([
    { name: 'cooked_beef', count: 3, foodPoints: 8, tier: 0 },
    { name: 'beef', count: 10, foodPoints: 3, tier: 1 }
  ], 0, {})
  assert.ok(!names(plan).includes('cooked_beef'), 'the ready-to-eat food stays on the bot')
  assert.ok(names(plan).includes('beef'), 'the raw surplus is what ships')
})

// ==== S6: safekeepPlan ====================================================================
t('safekeepPlan: the LIVE case - 53 planks + 1 hoe -> deposit 37 planks, keep the hoe', () => {
  const plan = M.safekeepPlan([
    { name: 'oak_planks', count: 53 },
    { name: 'wooden_hoe', count: 1 }
  ], {})
  assert.deepStrictEqual(byName(plan), { oak_planks: 37 }, 'keep 16 planks, ship 37; hoe never ships')
})

t('safekeepPlan: never the last working tool of a kind', () => {
  const plan = M.safekeepPlan([
    { name: 'stone_pickaxe', count: 1, usesLeft: 40 },
    { name: 'stone_axe', count: 1 },
    { name: 'iron_sword', count: 1 },
    { name: 'wooden_shovel', count: 1 }
  ], {})
  assert.deepStrictEqual(plan, [], 'one of each kind (one pick) -> nothing surplus, nothing ships')
})

t('safekeepPlan: keeps best pick + 1 spare working pick; ships the 3rd', () => {
  const plan = M.safekeepPlan([
    { name: 'iron_pickaxe', count: 1, usesLeft: 200 },
    { name: 'stone_pickaxe', count: 1, usesLeft: 100 },
    { name: 'stone_pickaxe', count: 1, usesLeft: 5 }
  ], {})
  // keep the iron (best) + one stone (spare); ship the weakest stone pick.
  assert.deepStrictEqual(byName(plan), { stone_pickaxe: 1 }, 'ship exactly one surplus stone pick')
})

t('safekeepPlan: a broken (usesLeft 0) 2nd pick is surplus - keep only the working one', () => {
  const plan = M.safekeepPlan([
    { name: 'stone_pickaxe', count: 1, usesLeft: 50 },
    { name: 'iron_pickaxe', count: 1, usesLeft: 0 },
    { name: 'stone_pickaxe', count: 1, usesLeft: 30 }
  ], {})
  // two working picks kept (the working stones), the broken iron ships.
  assert.deepStrictEqual(byName(plan), { iron_pickaxe: 1 }, 'the broken pick is the surplus one')
})

t('safekeepPlan: material allowances (dirt16/cobble16/sticks8/coal+charcoal8/logs8/util1)', () => {
  const plan = M.safekeepPlan([
    { name: 'dirt', count: 30 },
    { name: 'cobblestone', count: 20 },
    { name: 'stick', count: 12 },
    { name: 'coal', count: 6 },
    { name: 'charcoal', count: 6 },
    { name: 'oak_log', count: 20 },
    { name: 'crafting_table', count: 3 },
    { name: 'furnace', count: 1 },
    { name: 'bucket', count: 2 }
  ], {})
  const b = byName(plan)
  assert.strictEqual(b.dirt, 14, 'dirt 30-16')
  assert.strictEqual(b.cobblestone, 4, 'cobble 20-16')
  assert.strictEqual(b.stick, 4, 'stick 12-8')
  assert.strictEqual(b.oak_log, 12, 'log 20-8')
  assert.strictEqual(b.crafting_table, 2, 'keep 1 table')
  assert.strictEqual(b.bucket, 1, 'keep 1 bucket')
  assert.ok(!('furnace' in b), 'a single furnace is the keep, not surplus')
  // coal+charcoal = 12, allow 8 -> ship 4, charcoal first
  assert.strictEqual((b.charcoal || 0) + (b.coal || 0), 4, 'fuel excess 4 total')
  assert.strictEqual(b.charcoal, 4, 'charcoal ships first')
})

t('safekeepPlan: food / armor / seeds / iron are NEVER touched (allow-list)', () => {
  const plan = M.safekeepPlan([
    { name: 'bread', count: 40 },
    { name: 'cooked_beef', count: 30 },
    { name: 'iron_helmet', count: 1 },
    { name: 'iron_ingot', count: 30 },
    { name: 'wheat_seeds', count: 40 },
    { name: 'diamond', count: 5 }
  ], {})
  assert.deepStrictEqual(plan, [], 'nothing food/armor/seed/valuable is ever stripped')
})

// ==== S6: stepDue =========================================================================
t('stepDue: first call is due + arms; no re-fire inside the armed window', () => {
  const st = { __rng: 12345 }
  const r1 = M.stepDue(st, 'farm', 1000, 0)
  assert.strictEqual(r1.due, true, 'first check is due')
  assert.ok(r1.nextAt > 0, 'armed a nextAt')
  assert.strictEqual(M.stepDue(st, 'farm', 1000, r1.nextAt - 1).due, false, 'not due 1ms before nextAt')
  assert.strictEqual(M.stepDue(st, 'farm', 1000, r1.nextAt).due, true, 're-due at nextAt')
})

t('stepDue: jitter stays within +-30% of the interval', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const st = { __rng: seed * 7919 }
    const r = M.stepDue(st, 'k', 1000, 0)
    assert.ok(r.nextAt >= 700 && r.nextAt <= 1300, 'nextAt in [700,1300] for seed ' + seed + ' got ' + r.nextAt)
  }
})

t('stepDue: independent keys arm independently', () => {
  const st = { __rng: 42 }
  assert.strictEqual(M.stepDue(st, 'a', 1000, 0).due, true)
  assert.strictEqual(M.stepDue(st, 'b', 1000, 0).due, true, 'a different key is due even though a just armed')
  assert.strictEqual(M.stepDue(st, 'a', 1000, 10).due, false, 'a stays armed')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall maintain tests passed')
process.exit(failures ? 1 : 0)
