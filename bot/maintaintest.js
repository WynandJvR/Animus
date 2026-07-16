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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall maintain tests passed')
process.exit(failures ? 1 : 0)
