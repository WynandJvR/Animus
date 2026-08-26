'use strict'
// OFFLINE unit test for THE ONE RESCUE PATH after the strip of 2026-08-26.
//
// The rescue ladder - indoor, water, wetbreach, pit, door, climb, nudge, stepout, drybreach, with
// per-cell attempt memory, a self-forcing retry and wedge records - is gone. Terrain is the
// PLANNER's job: digs are priced as time (nav-profile WILD_DIG_COST), towers as permanent (pathfix
// PLACE_COST), a goto's deadline is on progress, and a failed leg RE-PLANS. What remains here is
// only what A* physically cannot do: water (the physics never registers on-ground in water),
// the bot's own door (the planner cannot plan through a door cell), and the interior of its own
// house (the way out is the door, never the roof).
//
// Run:  cd bot && node unsticktest.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const nav = require('./navigate.js')

let failures = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}
const srcOf = f => fs.readFileSync(path.join(__dirname, f), 'utf8')
const code = f => srcOf(f).replace(/^\s*\/\/.*$/gm, '') // strip comment-only lines: tombstones QUOTE what was deleted

// ============ 1. THE PLAN NAMES ONLY WHAT THE PLANNER CANNOT DO =============================
const base = { indoors: false, wet: false, submerged: false, door: false }
t('plan: on plain terrain there is NO rescue - the planner re-plans', () => {
  assert.deepStrictEqual(nav.unstickPlan(base), [])
})
t('plan: a pit, a crater, a shaft, a ceiling are all TERRAIN - still no rescue', () => {
  // the old snapshot fields are simply not consulted any more
  assert.deepStrictEqual(nav.unstickPlan({ ...base, pit: true, roofed: true, trappedHere: true, cut: true, climb: true }), [])
})
t('plan: feet in water -> water', () => {
  assert.deepStrictEqual(nav.unstickPlan({ ...base, wet: true }), ['water'])
})
t('plan: head under water -> water FIRST, whatever else is true', () => {
  assert.deepStrictEqual(nav.unstickPlan({ ...base, submerged: true, indoors: true, door: true }), ['water', 'indoor', 'door'])
})
t('plan: inside my own structure -> indoor then door (never the roof)', () => {
  assert.deepStrictEqual(nav.unstickPlan({ ...base, indoors: true }), ['indoor', 'door'])
})
t('plan: a door nearby, outdoors -> door', () => {
  assert.deepStrictEqual(nav.unstickPlan({ ...base, door: true }), ['door'])
})
t('plan: is pure - the same snapshot always gives the same plan', () => {
  const w = { ...base, wet: true, door: true }
  assert.deepStrictEqual(nav.unstickPlan(w), nav.unstickPlan(w))
})

// ============ 2. THE LADDER IS GONE, NOT HIDDEN ============================================
const navCode = code('navigate.js')
t('strip: no pit / climb / nudge / stepout / drybreach / wetbreach rung exists in navigate.js', () => {
  for (const k of ['pit', 'climb', 'nudge', 'stepout', 'drybreach', 'wetbreach']) {
    assert(!navCode.includes("kind: '" + k + "'"), 'rung ' + k + ' still defined')
  }
})
t('strip: the kept rungs are exactly indoor, water, door', () => {
  const kinds = [...navCode.matchAll(/kind: '([a-z]+)'/g)].map(m => m[1]).sort()
  assert.deepStrictEqual(kinds, ['door', 'indoor', 'water'])
})
t('strip: no per-cell attempt memory and no wedge records are written by the rescue', () => {
  assert(!navCode.includes("attempts.record('unstick'"), 'attempts.record(unstick) still present')
  assert(!navCode.includes('recordWedge('), 'recordWedge still called from navigate.js')
  assert(!navCode.includes("require('./attempts.js')"), 'attempts.js still imported')
})
t('strip: the geometry guessers detectPit / cliffAhead are gone', () => {
  assert(!/function detectPit|function cliffAhead/.test(navCode))
})
t('strip: a failed leg RE-PLANS until its deadline (navigateToInner) instead of escalating a rung', () => {
  assert(navCode.includes('re-planning the leg from'), 'the re-plan branch is missing')
  assert(!navCode.includes('the next rescue escalates on its own record'), 'the escalation branch survived')
})

// ============ 3. THE VERDICT SHAPE STAYS - callers (terminal action, walkStaged) rely on it =====
t('unstick: a bot with no body -> verdict no-body, nothing thrown', async () => {
  const r = await nav.unstick({ entity: null }, null, {})
  assert.strictEqual(r.verdict, 'no-body'); assert.strictEqual(r.moved, false)
})

// ============ 4. THE PLANNER IS ALLOWED TO DO THE JOB ======================================
t('pricing: WILD_DIG_COST makes a bare-hand stone dig PLANNABLE (< the library cap of 100)', () => {
  const np = require('./nav-profile.js')
  assert((1 + 3 * 7.5) * np.WILD_DIG_COST < 100)
})
t('pricing: WATER_ESCAPE defaults ON (the OFF side is the river that killed the trek)', () => {
  assert(navCode.includes("process.env.WATER_ESCAPE !== '0'"))
})

setTimeout(() => {
  if (failures) { console.log('unsticktest: ' + failures + ' FAILED'); process.exit(1) }
  console.log('unsticktest: all passed')
}, 50)
