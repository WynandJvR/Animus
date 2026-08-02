'use strict'
// OFFLINE test for ROOT B (2026-08-02): one physical door = one candidate.
// No bot, no world. Run:  cd bot && node doorfoottest.js
//
// bot.findBlocks matches BOTH halves of a door against the openable id list, so openNearbyDoor's
// collection loop - which deduped on the exact "x,y,z" - produced TWO candidates for ONE piece of
// wood. Each candidate then burned a 15-second gotoOnce and a door-budget slot on the same
// doorway, and the "N door/gate candidates near me/goal" line reported a number that was not the
// number of doors. The HALF normalisation already existed in the per-candidate geometry - i.e.
// AFTER the goto had been spent. This is that same rule, applied at collection time too (#4).

const assert = require('assert')
const { Vec3 } = require('vec3')
const navigate = require('./navigate.js')
const arbiter = require('./arbiter.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

const doorFootCell = navigate.doorFootCell

// A world with one door at (5,64,5) (lower) / (5,65,5) (upper), one fence gate at (9,64,9)
// (gates carry no `half`), and nothing else loaded.
function fakeBot (opts = {}) {
  return {
    blockAt (p) {
      if (opts.unloaded) return null
      const k = Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z)
      if (k === '5,64,5') return { name: 'oak_door', getProperties: () => ({ half: 'lower', facing: 'north' }) }
      if (k === '5,65,5') return { name: 'oak_door', getProperties: () => ({ half: 'upper', facing: 'north' }) }
      if (k === '9,64,9') return { name: 'oak_fence_gate', getProperties: () => ({ facing: 'east' }) }
      return null
    }
  }
}

t('the UPPER half resolves to the foot cell one block down', () => {
  const foot = doorFootCell(fakeBot(), new Vec3(5, 65, 5))
  assert.strictEqual(foot.x + ',' + foot.y + ',' + foot.z, '5,64,5')
})

t('the LOWER half is already the foot - returned unchanged', () => {
  const foot = doorFootCell(fakeBot(), new Vec3(5, 64, 5))
  assert.strictEqual(foot.x + ',' + foot.y + ',' + foot.z, '5,64,5')
})

t('a gate/trapdoor (no `half` property) passes through unchanged', () => {
  const foot = doorFootCell(fakeBot(), new Vec3(9, 64, 9))
  assert.strictEqual(foot.x + ',' + foot.y + ',' + foot.z, '9,64,9')
})

t('an UNREADABLE cell fails OPEN - the per-candidate loop already re-reads and tolerates it', () => {
  const p = new Vec3(5, 65, 5)
  assert.strictEqual(doorFootCell(fakeBot({ unloaded: true }), p), p, 'unchanged, never a guess one block down')
  assert.strictEqual(doorFootCell({ blockAt () { throw new Error('boom') } }, p), p, 'a throwing read is not a reason to move the cell')
})

t('BOTH halves of one door collapse to ONE candidate (the whole point)', () => {
  const bot = fakeBot()
  const found = [new Vec3(5, 65, 5), new Vec3(5, 64, 5), new Vec3(9, 64, 9)] // what findBlocks hands back
  const seen = new Set(); const cands = []
  for (const c of found) {
    const foot = doorFootCell(bot, c)
    const k = foot.x + ',' + foot.y + ',' + foot.z
    if (!seen.has(k)) { seen.add(k); cands.push(foot) }
  }
  assert.strictEqual(cands.length, 2, 'one door + one gate = two candidates, not three')
  assert.deepStrictEqual(cands.map(c => c.y), [64, 64], 'and the door candidate is its FOOT, not its head')
})

// ---- source-level: the collection loop really uses it (MUTATION CHECK) ------------------
t('openNearbyDoor collects on the FOOT cell, not the raw findBlocks hit (MUTATION CHECK)', () => {
  const fs = require('fs')
  const src = fs.readFileSync(require('path').join(__dirname, 'navigate.js'), 'utf8')
  const i = src.indexOf('async function openNearbyDoor')
  assert.ok(i > 0, 'openNearbyDoor still exists')
  const fn = src.slice(i, src.indexOf('\nasync function', i + 10))
  assert.ok(/const foot = doorFootCell\(bot, c\)/.test(fn),
    'the collection loop must normalise BEFORE it dedupes and before it spends the 15s goto')
  assert.ok(!/const k = c\.x \+ ',' \+ c\.y \+ ',' \+ c\.z/.test(fn),
    'reverting the loop to key on the raw hit is the mutation this catches')
  assert.ok(/const base = doorFootCell\(bot, p\)/.test(fn),
    'and the per-candidate geometry uses the SAME function - one rule, one definition (#4)')
  assert.ok(!/half === 'upper' \? p\.offset\(0, -1, 0\) : p/.test(fn),
    'the second hand-written copy of the half-normalisation is gone')
})

// ---- the GoalChanged line names who else was driving -----------------------------------
t('a `goal was changed` door failure now names the active maneuver spans', () => {
  const fs = require('fs')
  const src = fs.readFileSync(require('path').join(__dirname, 'navigate.js'), 'utf8')
  assert.ok(/goal was changed[\s\S]{0,120}?arbiter\.describeSpans\(\)/.test(src),
    'the one witness to "someone else called setGoal" must say who was maneuvering (#7)')
})

t('arbiter.describeSpans reports label@TIER(Ns), and empty string when nothing is maneuvering', () => {
  arbiter._reset()
  assert.strictEqual(arbiter.describeSpans(), '', 'no spans -> empty, never "none" prose')
  const a = arbiter.beginManeuver('cross-door', arbiter.PRIORITY.PRESERVE, 8000)
  const b = arbiter.beginManeuver('reactive-move', arbiter.PRIORITY.SURVIVE, 2000)
  const s = arbiter.describeSpans()
  assert.ok(/cross-door@PRESERVE\(\d+s\)/.test(s), 'names the span, its tier and its remaining ttl: ' + s)
  assert.ok(/reactive-move@SURVIVE\(\d+s\)/.test(s), 'concurrent spans are all listed: ' + s)
  arbiter.endManeuver(a); arbiter.endManeuver(b)
  assert.strictEqual(arbiter.describeSpans(), '', 'and it is read-only - ending the spans empties it')
  arbiter._reset()
})

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
process.exit(failures ? 1 : 0)
