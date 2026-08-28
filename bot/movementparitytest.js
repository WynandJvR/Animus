'use strict'
// ==== THE TWO MOVEMENT CONFIGS MUST AGREE ON GETTING OUT ====================================
// Run:  cd bot && node movementparitytest.js
//
// WHY THIS FILE EXISTS. 2026-08-26, after ~15 hours of a bot sitting in a small creeper crater:
//
//   travelMovements  (7 call sites)  : allow1by1towers = true,  scafoldingBlocks = [dirt, cobble, ...]
//   setupMovements  (17 call sites)  : allow1by1towers = false, scafoldingBlocks = []
//
// canDig:false is the anti-grief rule that matters and both had it. But the DEFAULT config - the
// one used for gathering, sheltering, recovering, most of the bot's life - could not dig, could
// not pillar, and had no block to place. Minecraft climbing needs a ONE BLOCK step; a creeper
// crater has a 2-3 block inner wall. So there was NO LEGAL MOVE OUT of any steep hole, and the
// only exits in the whole system were three rescue rungs - which is why every bug in those rungs
// cost an entire day, and why the operator watched it sit in a crater for hours.
//
// It could climb out while walking to the castle and not while doing anything else. One rule,
// two answers, 17 sites against 7 (#4).
//
// The operator's ask, verbatim: "i dont want us to ever make that mistake again, look how many
// problems that caused". So this pins the CLASS, not the instance: the two configs must agree on
// every capability that decides whether the body can leave a hole. They may still differ on speed
// and comfort - sprinting, drop height, free motion - because those do not trap anything.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0
function t (name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)) }
}

// A Movements stub: we are testing what the two functions SET, not what mineflayer does with it.
function fakeBot () {
  return { version: '1.21.11', entity: { position: { x: 0, y: 64, z: 0, floored: () => ({ x: 0, y: 64, z: 0 }) } }, inventory: { items: () => [] } }
}
function capture (fnName) {
  // Both functions build `new Movements(bot)` and mutate it. Rather than load mineflayer-pathfinder
  // (a live dependency), read what each one ASSIGNS, from source. That is also what makes this a
  // drift guard rather than a behaviour test: it fails when someone edits one and not the other.
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  const i = src.indexOf('function ' + fnName + ' (bot)')
  assert.ok(i > 0, 'found ' + fnName + ' - re-pin this test, do not delete it')
  // the function body ends at the next top-level `function ` declaration
  const j = src.indexOf('\nfunction ', i + 10)
  const body = src.slice(i, j > i ? j : src.length)
  const out = {}
  for (const m of body.matchAll(/m\.([a-zA-Z0-9_]+)\s*=\s*([^\n]+)/g)) {
    // Strip a trailing line comment by INDEX, not by regex: these values carry explanatory
    // comments on the same line, and the regex here was mangled on write and silently left them
    // attached - so every comparison was string vs string-plus-prose and could never be equal.
    var v = m[2]
    var c = v.indexOf('//')
    if (c >= 0) v = v.slice(0, c)
    v = v.trim()
    while (v.length && (v[v.length-1] === ';' || v[v.length-1] === ',')) v = v.slice(0, -1)
    out[m[1]] = v.trim()
  }
  return { body, set: out }
}

// The capabilities that decide whether a body can LEAVE somewhere. If these two ever disagree
// again, the bot can escape in one mode and not the other, and the symptom is a bot that looks
// stupid for hours in a hole a player would step out of.
const ESCAPE_CRITICAL = ['canDig', 'allow1by1towers', 'canOpenDoors', 'allowParkour']

const travel = capture('travelMovements')
const setup = capture('setupMovements')

t('both movement configs exist and assign the escape-critical capabilities', () => {
  for (const k of ESCAPE_CRITICAL) {
    assert.ok(k in travel.set, 'travelMovements must state ' + k + ' explicitly, not inherit it')
    assert.ok(k in setup.set, 'setupMovements must state ' + k + ' explicitly, not inherit it')
  }
})

t('they AGREE on every escape-critical capability (the 2026-08-26 crater bug)', () => {
  for (const k of ESCAPE_CRITICAL) {
    assert.strictEqual(setup.set[k], travel.set[k],
      'setupMovements.' + k + ' = ' + setup.set[k] + ' but travelMovements.' + k + ' = ' + travel.set[k] +
      ' - a body that can leave a hole in one mode and not the other is the bug this file exists for')
  }
})

t('canDig stays FALSE in both - the anti-grief rule that actually matters is untouched', () => {
  assert.strictEqual(setup.set.canDig, 'false', 'the bot must never chew through a build to make a path')
  assert.strictEqual(travel.set.canDig, 'false')
})

t('both can pillar, and BOTH have blocks to pillar with (allow1by1towers is inert without them)', () => {
  assert.strictEqual(setup.set.allow1by1towers, 'true', 'the default config is 17 of the 24 call sites - it must be able to climb out')
  assert.ok(/scafoldingBlocks = ids/.test(setup.body), 'setupMovements must hand the pathfinder a real block list')
  assert.ok(/scafoldingBlocks = ids/.test(travel.body), 'travelMovements must too')
  assert.ok(!/scafoldingBlocks = \[\]/.test(setup.body.replace(/catch \{[^}]*\}/g, '')),
    'an EMPTY list outside the mcData catch means "you may tower, with nothing" - the same trap one field over')
})

t('the bridge/pillar block list has ONE definition, read by both (#4)', () => {
  // 2026-08-28: the ONE definition moved to nav-profile.PILLAR_ITEMS (planks joined it; a bot in a
  // 2-deep pit with four planks had "no block to place" while four hand-lists disagreed). Every
  // profile that towers or bridges reads THAT list; no file carries a literal copy any more.
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  const np = fs.readFileSync(path.join(__dirname, 'nav-profile.js'), 'utf8')
  assert.strictEqual((np.match(/const PILLAR_ITEMS = \[/g) || []).length, 1, 'exactly one list, in nav-profile; two copies drift and this whole file is about drift')
  assert.ok(/PILLAR_ITEMS,/.test(np.split('module.exports')[1]), 'and it is exported')
  assert.ok(/const SCAFFOLD_BRIDGE = require\('\.\/nav-profile\.js'\)\.PILLAR_ITEMS/.test(src), 'commands.js reads the shared list, it does not copy it')
  assert.ok(/const bridge = SCAFFOLD_BRIDGE/.test(src), 'travelMovements reads the shared list')
  assert.ok(/SCAFFOLD_BRIDGE\.map/.test(src), 'setupMovements reads the shared list')
  for (const f of ['commands.js', 'provision.js', 'provision-mining.js']) {
    const body = fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/\['dirt', 'cobblestone'/.test(body) && !/\['dirt', 'grass_block', 'cobblestone'/.test(body), f + ' carries no literal copy of the pillar list')
  }
  assert.ok(/birch_planks/.test(np), 'planks are on the list - a player pillars with what is in the hand')
})

t('they may still differ on SPEED and COMFORT - this guard is not a straitjacket', () => {
  // sprinting / maxDropDown / allowFreeMotion legitimately differ: a long trek sprints and accepts
  // a bigger drop, close work does not. None of them can trap a body, so none of them are pinned.
  const comfort = ['allowSprinting', 'maxDropDown', 'allowFreeMotion']
  const differs = comfort.some(k => (travel.set[k] || null) !== (setup.set[k] || null))
  assert.ok(differs || true, 'documented as allowed to differ; asserted only so the list is visible here')
})

console.log(pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
