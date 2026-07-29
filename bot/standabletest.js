'use strict'
// OFFLINE contract test for THE definition of "can the bot stand in this cell"
// (nav-profile.standable). No bot, no world, no clock.
//
// WHY THIS FILE EXISTS. Six places decided this independently and each got it slightly wrong in a
// different way; on 2026-07-29 the bot drowned repeatedly because ONE of them - the flee steer -
// asked `!solid(feet)` to mean "clear", and water is not solid. A lake with a sand bottom read as
// perfectly walkable, so a retreat from a creeper sprinted into it. `liquidCost` could not help:
// a reactive flee drives the controls and never consults the pathfinder.
//
// The fix was not "add a water check to the flee steer" - that is the seventh variant. It was to
// make the decision ONCE and give the difference between "somewhere dry to stand" and "somewhere
// to swim toward" a NAME (opts.allowWater). This file pins that, and pins that the consumers use
// it rather than re-deriving it.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const np = require('./nav-profile.js')

let fails = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fails++ } }

const S = np.standable

// ---- the live drowning, as a fixture ----------------------------------------------------
t('THE DROWNING: a lake with a solid bottom is NOT standable under the dry policy', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'sand', feet: 'water', head: 'water' }), false)
})
t('...and a 1-deep puddle is not either (head air, feet water)', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'sand', feet: 'water', head: 'air' }), false)
})
t('...but the SAME cell IS a valid swim target when that is what the caller means', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'sand', feet: 'water', head: 'water' }, { allowWater: true }), true)
})

// ---- the ordinary cases still work ------------------------------------------------------
t('dry ground is standable', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'grass_block', feet: 'air', head: 'air' }), true)
})
t('cave air counts as body space', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'stone', feet: 'cave_air', head: 'cave_air' }), true)
})
t('no floor -> not standable', () => {
  assert.strictEqual(S({ groundSolid: false, ground: 'air', feet: 'air', head: 'air' }), false)
})
t('a WATER floor is not a floor', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'water', feet: 'air', head: 'air' }), false)
})
t('a solid block in the body space -> not standable', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'stone', feet: 'stone', head: 'air' }), false)
})

// ---- fail CLOSED on the unknown ---------------------------------------------------------
// shelter.js's AIRISH counts `null` as air. On an unloaded cell that is a fail-OPEN, and it is the
// same class the grounded-claims work removed everywhere else.
t('UNKNOWN feet -> not standable (an unloaded cell is not evidence of safety)', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'grass_block', feet: null, head: 'air' }), false)
})
t('UNKNOWN head -> not standable', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'grass_block', feet: 'air', head: null }), false)
})

// ---- lava is never acceptable, whatever the caller asked for ----------------------------
t('lava body space is refused even under allowWater', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'stone', feet: 'lava', head: 'air' }, { allowWater: true }), false)
  assert.strictEqual(S({ groundSolid: true, ground: 'stone', feet: 'air', head: 'lava' }, { allowWater: true }), false)
})
t('a lava floor is not a floor', () => {
  assert.strictEqual(S({ groundSolid: true, ground: 'lava', feet: 'air', head: 'air' }), false)
})

// ---- water-family blocks all count as water ---------------------------------------------
t('seagrass / kelp / bubble columns are water, not air', () => {
  for (const n of ['seagrass', 'kelp', 'bubble_column']) {
    assert.strictEqual(S({ groundSolid: true, ground: 'sand', feet: n, head: 'air' }), false, n + ' must not read as clear')
  }
})

// ---- THE ANTI-DRIFT PIN: consumers must ASK, not re-derive -------------------------------
// This is the part that makes the class extinct rather than the instance. A seventh hand-written
// water check anywhere in the retreat path is the bug coming back.
t('ANTI-DRIFT: the flee steer asks standable() instead of re-deriving "clear"', () => {
  const src = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
  const i = src.indexOf('function fleeSteerTarget')
  assert(i > 0, 'fleeSteerTarget still exists')
  const body = src.slice(i, i + 1400)
  assert(/navProfile\.standable\(/.test(body), 'it must consult the one definition')
  assert(!/return solidAt\(x, fy - 1, z\) && !solidAt\(x, fy, z\)/.test(body),
    'the old `water is not solid, therefore clear` test must be gone')
})
t('ANTI-DRIFT: standable is exported so there is something to consult', () => {
  assert.strictEqual(typeof np.standable, 'function')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall standable-contract tests passed')
process.exit(fails ? 1 : 0)
