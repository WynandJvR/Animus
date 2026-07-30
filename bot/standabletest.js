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

// ==== THE OTHER HALF: "how does this bot ENTER water" ====================================
// standable() governs the REACTIVE path (a steer picking a cell directly). waterPolicy() governs
// the PLANNED path (what A* charges for water). Both were duplicated per-caller; both drowned the
// bot. FIX 23 set liquidCost on the default profile and stopped there - but there were SIX
// Movements profiles, and four of them still let the pathfinder plan an UNBOUNDED FALL into water
// (infiniteLiquidDropdownDistance defaults to true). The bot did not stumble in; A* aimed it.

t('waterPolicy prices water above land', () => {
  const m = { liquidCost: 1, infiniteLiquidDropdownDistance: true }
  np.waterPolicy(m)
  assert.strictEqual(m.liquidCost, np.WILD_LIQUID_COST)
  assert(m.liquidCost > 1, 'water must not be priced like grass')
})
t('waterPolicy bounds the drop INTO water', () => {
  const m = { liquidCost: 1, infiniteLiquidDropdownDistance: true }
  np.waterPolicy(m)
  assert.strictEqual(m.infiniteLiquidDropdownDistance, false)
})
t('waterPolicy is COST-only: it never forbids (stays under the library cost>100 drop threshold)', () => {
  const m = {}
  np.waterPolicy(m)
  assert(m.liquidCost < 100, 'a forbid would make the river farm / fishing spot unreachable')
})
t('waterPolicy does not invent a field the library lacks, and tolerates null', () => {
  const m = { liquidCost: 1 }                       // older pathfinder: no dropdown field
  np.waterPolicy(m)
  assert.strictEqual('infiniteLiquidDropdownDistance' in m, false, 'a dead property reads as configured')
  assert.doesNotThrow(() => np.waterPolicy(null))
})
t('waterPolicy leaves per-profile settings alone (climb/build legitimately differ)', () => {
  const m = { maxDropDown: 8, canDig: true, allowParkour: false, liquidCost: 1 }
  np.waterPolicy(m)
  assert.strictEqual(m.maxDropDown, 8)
  assert.strictEqual(m.canDig, true)
  assert.strictEqual(m.allowParkour, false)
})

// ---- THE ANTI-DRIFT PIN: every profile must be stamped -----------------------------------
// A SEVENTH `new Movements` added without water policy is this bug returning. Scanning the source
// is what makes that impossible rather than merely unlikely: a new profile fails this test on the
// commit that adds it, not on the night it drowns the bot.
const PROFILE_FILES = ['commands.js', 'provision.js', 'provision-mining.js', 'schematic.js']
t('ANTI-DRIFT: EVERY `new Movements` site applies waterPolicy', () => {
  let sites = 0
  for (const f of PROFILE_FILES) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
    const lines = src.split('\n')
    lines.forEach((ln, i) => {
      if (!/new Movements\s*\(/.test(ln)) return
      sites++
      // the stamp must appear inside the same profile function - bounded look-ahead to the next
      // `function ` at column 0, or 60 lines, whichever comes first.
      let end = i + 1
      while (end < lines.length && end - i < 60 && !/^function /.test(lines[end])) end++
      const body = lines.slice(i, end).join('\n')
      assert(/waterPolicy\s*\(m\)/.test(body),
        `${f}:${i + 1} builds a Movements profile with no water policy - it will swim for free and fall into lakes`)
    })
  }
  assert(sites >= 6, `expected the 6 known profiles, scanned ${sites} - did a file move?`)
})
t('ANTI-DRIFT: nobody hand-sets liquidCost / the drop flag outside nav-profile.js', () => {
  for (const f of PROFILE_FILES) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n') // ignore comments
    assert(!/^\s*m\.liquidCost\s*=/m.test(code),
      `${f} sets liquidCost by hand - that is the per-profile copy that drifted`)
    assert(!/^\s*if \('infiniteLiquidDropdownDistance' in m\)/m.test(code),
      `${f} sets the drop flag by hand - route it through waterPolicy()`)
  }
})
t('ANTI-DRIFT: waterPolicy is exported so there is something to consult', () => {
  assert.strictEqual(typeof np.waterPolicy, 'function')
})

// ==== "IS THE ESCAPE FINISHED?" - the predicate that let it drown holding a success claim ====
// Live 2026-07-30, TWO deaths ten minutes apart, each preceded by the escape announcing victory:
//   10:34:33 [nav] drown-escape: out of the water at (-8, 62, 117)
//   10:34:43 (death) at -8,62,115 (drowning - Drowned, via message)
// escapeWater's loop tested headInWater, so a bot TREADING water (head clear, nothing underfoot)
// satisfied it: the ladder stopped, the maneuver ENDED, the body was released, the bot sank.
// The fix is not a new rung - it is that "am I done" asks for a FLOOR, so the ladder escalates to
// the rung that works (`hop`) instead of believing `rise`.
const EC = np.escapeComplete

t('THE DROWNING: treading water (head clear, NO floor) is NOT finished', () => {
  assert.strictEqual(EC({ head: 'air', groundSolid: false }), false)
})
t('...still submerged is not finished either', () => {
  assert.strictEqual(EC({ head: 'water', groundSolid: true }), false)
})
t('standing in a 1-deep puddle IS finished - a floor underfoot is the whole point', () => {
  assert.strictEqual(EC({ head: 'air', groundSolid: true }), true)
})
t('the water FAMILY counts as submerged, not as clear air', () => {
  for (const n of ['water', 'flowing_water', 'seagrass', 'kelp', 'bubble_column']) {
    assert.strictEqual(EC({ head: n, groundSolid: true }), false, n + ' overhead must not read as out')
  }
})
t('a lava ceiling is never "out"', () => {
  assert.strictEqual(EC({ head: 'lava', groundSolid: true }), false)
})
t('UNKNOWN head -> not finished (fails CLOSED, keep working the bounded ladder)', () => {
  assert.strictEqual(EC({ head: null, groundSolid: true }), false)
})
t('the two questions stay SEPARATE: escapeComplete is not standable', () => {
  // submerged with a floor: standable(allowWater) says "you may swim here", escapeComplete says
  // "you are not out yet". Conflating them is what produced the false victory.
  assert.strictEqual(S({ groundSolid: true, ground: 'sand', feet: 'water', head: 'water' }, { allowWater: true }), true)
  assert.strictEqual(EC({ head: 'water', groundSolid: true }), false)
})

// ---- ANTI-DRIFT: one predicate, read by BOTH sides -------------------------------------
t('ANTI-DRIFT: escapeWater stops on outOfWater, NOT on headInWater', () => {
  const src = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
  const i = src.indexOf('async function escapeWater')
  assert(i > 0, 'escapeWater still exists')
  const body = src.slice(i, i + 3000)
  assert(/const wet = \(\) => !outOfWater\(bot\)/.test(body),
    'the ladder must keep working until the bot actually has a floor')
  assert(!/const wet = \(\) => headInWater\(bot\)/.test(body),
    'the head-clear stop is what ended the maneuver on a floating bot')
})
t('ANTI-DRIFT: the drown-crisis caller judges by the SAME predicate', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  assert(/navigate\.outOfWater\(bot\)/.test(src), 'index must read the one definition')
  assert(!/\?\s*!navigate\.feetInWater\(bot\)\s*:\s*ok/.test(src),
    'a correct success verdict must not be behind a flag')
})
t('ANTI-DRIFT: outOfWater delegates to nav-profile instead of re-deriving', () => {
  const src = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
  const i = src.indexOf('function outOfWater')
  assert(i > 0, 'outOfWater exists')
  assert(/navProfile\.escapeComplete\(/.test(src.slice(i, i + 700)), 'it must consult the one definition')
  assert.strictEqual(typeof np.escapeComplete, 'function')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall water-contract tests passed')
process.exit(fails ? 1 : 0)
