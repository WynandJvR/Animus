'use strict'
// OFFLINE unit test: ONE DEFINITION OF "THE RESCUE MOVED ME".
//
// Live 2026-08-26, spawn. The bot shuffled between two cells for minutes while its own memory
// filled up with failures it had not had:
//   [nav] recovery stepout -> MOVED
//   [nav] unstick: stepout moved us to (0, 61, -3)
//   [prov] wedge: recorded stuck-spot 1,-1 (n=4)
//   [nav] unstick FAILED at (0, 61, -2) (in the open): tried nudge, stepout - attempt 4
// The step-out netted 1.3b. Its own success test wanted >= 1.0 and passed. unstick's verdict,
// two lines later, wanted >= 1.5 and failed - and the verdict is the half that writes history:
// an "achieved nothing here" record against every rung tried (so they get skipped next time),
// plus a wedge. Those false wedges are the input to `trappedHere`, which front-loads the
// expensive climbing rung - so this defect manufactures the evidence for that one.
// Run:  cd bot && node rescuemovedtest.js

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rescuemoved-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.SCAFFOLD_FILE = path.join(tmp, 'scaffold-registry.json')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')
process.env.BUILD_DEBUG = ''

let failures = 0
const queue = []
function t (name, fn) { queue.push([name, fn]) }

const src = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

t('there is exactly ONE relocation threshold constant', () => {
  const decls = code.match(/const RESCUE_MOVED_B\s*=/g) || []
  assert.strictEqual(decls.length, 1, 'one constant, declared once')
})

t('every rescue call site asks the SAME helper', () => {
  // recoverOnce.movedEnough and unstick's verdict (the stepout rung went with the ladder, 2026-08-26).
  const uses = code.match(/relocated\s*\(/g) || []
  assert.ok(uses.length >= 3, 'the definition plus at least two callers, got ' + uses.length)
  assert.ok(/movedEnough\s*=\s*\(\)\s*=>\s*relocated\(/.test(code), 'recoverOnce.movedEnough delegates')
  assert.ok(/const moved\s*=\s*relocated\(p0, p1\)/.test(code), "unstick's verdict delegates")
})

t('THE BUG: no rescue site carries its own private threshold any more', () => {
  // The three literals that disagreed: >= 2 (movedEnough), >= 1.5 (verdict), >= 1.0 (stepout).
  const rescueRegion = code.slice(code.indexOf('function recoverOnce'))
  const privateThresholds = rescueRegion.match(/Math\.hypot\([^)]*\)\s*>=\s*[0-9.]+/g) || []
  assert.deepStrictEqual(privateThresholds, [],
    'a rescue site with its own number is how MOVED and FAILED were reported for one event: ' + privateThresholds.join(' | '))
})

// The behaviour those wires exist for. relocated is module-private, so exercise it through the
// arithmetic it is specified by - the live case is the one that must flip.
t('the live case: a 1.3b step-out counts as moved (it was booked as a wedge)', () => {
  const B = Number((code.match(/const RESCUE_MOVED_B\s*=\s*([0-9.]+)/) || [])[1])
  assert.ok(Number.isFinite(B), 'the constant is a number')
  assert.ok(1.3 >= B, 'a 1.3b relocation must satisfy the one threshold - it did not satisfy the old 1.5 verdict')
  assert.ok(B >= 1.0, 'but a sub-block jiggle must NOT count as a rescue (that is fidgeting, not escaping)')
})

t('a 0.4b jiggle is still NOT a rescue', () => {
  const B = Number((code.match(/const RESCUE_MOVED_B\s*=\s*([0-9.]+)/) || [])[1])
  assert.ok(!(0.4 >= B), 'reactive-move reports "netted 0.4b -> short"; that must not clear a wedge')
})

t('a pure vertical escape still counts (pillaring up nets ~0 XZ)', () => {
  assert.ok(/Math\.abs\(p1\.y - p0\.y\) >= 1/.test(code),
    'the Y clause is what makes a pillar-out or a fall count at all')
})

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('  ok  ' + name) } catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message) }
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall ' + queue.length + ' passed')
  process.exit(failures ? 1 : 0)
})()
