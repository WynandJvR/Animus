'use strict'
// OFFLINE unit test: A RIM ONE BLOCK UP IS A STEP, NOT A PILLAR.
//
// Live 2026-08-26, spawn. The bot stood in cell (-1,60,-2) with every neighbour stone at y60 and
// air at y61 - a one-block scrape - and did not leave it for minutes:
//   [nav] unstick: in a pit at (-1,60,-2) - plan pit > nudge > stepout
//   [nav] recovery: in a PIT with nothing to pillar with - digging filler out of the wall first
//   (claim) REVOKED navRecovery - no world delta credited to it for 150s, held 150s
// Operator: "its literally out in the open in a small pit it can walk out of wtf is going on?"
//
// detectPit says YES to a 1-deep scrape as loudly as to a 6-deep shaft; rimY is the only thing that
// separates them, and the pit rung never read it before choosing HOW to get out. It went straight to
// "pillar", found an empty pack, and went mining for filler it did not need - holding the body for
// the whole claim lease while nudge/stepout, which would have stepped up, waited behind it.
// Run:  cd bot && node pitsteptest.js

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pitstep-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.SCAFFOLD_FILE = path.join(tmp, 'scaffold-registry.json')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')
process.env.BUILD_DEBUG = ''

let failures = 0
const queue = []
function t (name, fn) { queue.push([name, fn]) }

const navSrc = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
const pitRung = navSrc.slice(navSrc.indexOf("kind: 'pit'"), navSrc.indexOf("kind: 'door'"))

t('the pit rung reads rimY BEFORE deciding to pillar', () => {
  assert.ok(pitRung.length > 0, 'found the pit rung')
  // Match the CALL SITE, not the log text - the comment above the fix quotes that log line.
  const declineAt = pitRung.indexOf('return false', pitRung.indexOf('pit DECLINED'))
  const fillerAt = pitRung.indexOf('ensurePillarFiller')
  assert.notStrictEqual(pitRung.indexOf('pit DECLINED'), -1, 'the rung must be able to decline a one-step rim')
  assert.notStrictEqual(fillerAt, -1, 'the filler hunt is still the fallback for real pits')
  assert.ok(declineAt < fillerAt,
    'the decline must come BEFORE the filler hunt - going mining first is exactly what held the body for 150s')
})

t('the decline is a rimY comparison against the feet, not a new constant', () => {
  assert.ok(/pit\.rimY\s*<=\s*feetNow\.y\s*\+\s*1/.test(pitRung),
    'a step is rim <= feet+1 - read from detectPit, not a tuned number')
})

t('declining returns false so the WALKING rungs get the attempt', () => {
  const seg = pitRung.slice(pitRung.indexOf('pit DECLINED'))
  const ret = seg.slice(0, seg.indexOf('\n', seg.indexOf('return')) + 1)
  assert.ok(/return false/.test(ret), 'it must hand the attempt on, not claim success and not act')
})

// detectPit's own arithmetic is the contract this leans on: solid neighbour at dy=0 => rim = feet+1.
// Pinned here so a change to detectPit that shifts rimY cannot silently turn every step into a pillar.
t('detectPit: a neighbour solid at foot level puts the rim ONE above the feet', () => {
  const navSrcPit = navSrc.slice(navSrc.indexOf('function detectPit'), navSrc.indexOf('function cliffAhead'))
  assert.ok(/rimY\s*=\s*Math\.max\(rimY,\s*f0\.y\s*\+\s*dy\s*\+\s*1\)/.test(navSrcPit),
    'rimY = feet + dy + 1, so dy=0 (solid at foot level) means rim = feet+1 = a step')
  assert.ok(/pitWalls\s*<\s*3/.test(navSrcPit), 'and it still needs 3 of 4 walls to call anything a pit at all')
})

t('a genuinely DEEP pit still pillars - the rung is not disabled', () => {
  // rim >= feet+2 must not hit the decline path: the guard is strictly `<= feet + 1`.
  assert.ok(!/pit\.rimY\s*<=\s*feetNow\.y\s*\+\s*[2-9]/.test(pitRung),
    'the step threshold must stay at one block; a 2-deep hole is a real pillar job')
  assert.ok(/pillaring out to y=/.test(pitRung), 'the pillar path is still there for real pits')
})

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('  ok  ' + name) } catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message) }
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall ' + queue.length + ' passed')
  process.exit(failures ? 1 : 0)
})()
