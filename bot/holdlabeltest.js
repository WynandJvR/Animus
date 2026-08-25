'use strict'
// OFFLINE test for ROOT C (2026-08-02): the hold label must name the latch that is actually SET.
// Run:  cd bot && node holdlabeltest.js
//
// WHAT WENT WRONG: the command gate's `bodyBusy` tested FOUR latches -
//   isBusy || isResting || isSecuringFood || isRecoveringDegraded
// - while the label printed next to every refusal was built THREE separate times as
//   isBusy ? 'busy building' : (isSecuringFood ? 'securing food' : 'night-resting')
// with 'night-resting' as the UNCONDITIONAL else. So a hung recoverFromDegraded - a latch the
// label could not name - printed `held (night-resting)` 53 times on 2026-08-02, and the
// investigation went looking for a bed. A log line must state what happened (#7), and a rule
// tested in one place must not be re-derived in three others (#4).
//
// 2026-08-25, M1 of the deadlock-free-arbitration design: the gate this file guards MOVED. The
// nine hand-written branches in index.js's /cmd handler became rows in bot/gate.js, byte-for-byte
// (gatetest.js sweeps the whole input space against a transcription of the old if-stack). Every
// guarantee below is unchanged; each assertion now points at the half of the split that owns it:
//   - the LABEL TABLE, the one read it derives from, and the three sites that print it -> gate.js
//   - the LATCH OBSERVATION (which claim key is raised by which predicate)            -> index.js
//   - the write-through before the labels are read (bodyOwner)                        -> the seam
// Nothing here was weakened to make the move pass; two assertions got STRONGER, because gate.js
// is pure and can be required, so the label is now checked by rendering the real verdict rather
// than by matching the source text that renders it.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const gate = require('./gate.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

// strip line comments so a literal quoted inside an explanatory comment is not counted as code
const stripped = f => fs.readFileSync(path.join(__dirname, f), 'utf8')
  .split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
const code = stripped('index.js')
const gcode = stripped('gate.js')

t('the old three-way ternary is GONE from all sites (MUTATION CHECK)', () => {
  for (const [f, c] of [['index.js', code], ['gate.js', gcode]]) {
    const n = (c.match(/'busy building' : \(provFood\.isSecuringFood/g) || []).length
    assert.strictEqual(n, 0, f + ': restoring any of the three label ternaries fails this: found ' + n)
    assert.ok(!/const label = commands\.isBusy && commands\.isBusy\(\) \? 'busy building'/.test(c),
      f + ': no site may re-derive the label from a subset of the latches the gate actually tests')
  }
})

t("'night-resting' appears exactly ONCE in code, inside the latch table, next to its claim key", () => {
  const hits = (gcode.match(/'night-resting'/g) || []).length
  assert.strictEqual(hits, 1, 'one definition of the label in gate.js, got ' + hits)
  assert.ok(/\['night-resting', 'shelter'\]/.test(gcode),
    'the label is bound to the claim that makes it true - it can no longer be an assumed else-branch')
  assert.strictEqual((code.match(/'night-resting'/g) || []).length, 0,
    'and the label does not survive as a second copy in index.js after the extraction')
})

t('the table names ALL FOUR latches the gate tests, and each key is bound to its latch in the ONE registry', () => {
  // 2026-08-25 (review D2): the table binds a label to a CLAIM KEY rather than to an inline latch
  // read, because a raw latch cannot say whether the work behind it is still alive - that is how
  // `held (busy building+securing food)` printed 110 times about a food run abandoned at 16:54:51.
  // The binding did not disappear, it moved one level down into bodyLatches(), which is the ONE
  // place that observes a latch at all. So this checks BOTH halves of the chain - and the table
  // half is now the exported constant, not a source slice.
  const li = code.indexOf('const bodyLatches = () => {')
  assert.ok(li > 0, 'the one latch-observation function exists')
  const latches = code.slice(li, code.indexOf('\n}', li))
  const expect = [
    ['busy building', 'job', 'commands.isBusy'],
    ['night-resting', 'shelter', 'provRecovery.isResting'],
    ['securing food', 'foodRun', 'provFood.isSecuringFood'],
    ['recovering-degraded', 'ladder', 'provRecovery.isRecoveringDegraded']
  ]
  assert.deepStrictEqual(gate.BODY_HOLD_LATCHES, expect.map(([l, k]) => [l, k]),
    'the four labels, bound to their claim keys, in the order bodyBusy always tested them')
  for (const [, key, pred] of expect) {
    assert.ok(new RegExp("probe\\('" + key + "', .*" + pred.replace('.', '\\.')).test(latches),
      'claim ' + key + ' is bound to ' + pred + ' in bodyLatches - the label can still only name a latch that is SET')
  }
})

t('the claim registry is written through BEFORE the labels are read', () => {
  // Was: `bodyOwner()` on the line above `const holdActive = [`. Now the same ordering, across the
  // seam: gate.js's one latch read calls the injected syncClaims FIRST and only then asks
  // claimInfo, and index.js binds syncClaims to bodyOwner(). A revoked lease still cannot print
  // as a hold - and it still cannot be revoked for a command the confinement row rejected, which
  // is why the field is lazy.
  const i = gcode.indexOf("lazy('_hold'")
  assert.ok(i > 0, 'gate.js has the ONE latch read')
  const one = gcode.slice(i, gcode.indexOf('})', i))
  assert.ok(one.indexOf('ctx.syncClaims()') > 0 && one.indexOf('ctx.syncClaims()') < one.indexOf('ctx.claimInfo('),
    'syncClaims (bodyOwner) runs before any claim is read')
  assert.ok(/syncClaims: \(\) => bodyOwner\(\)/.test(code), 'and index.js binds it to bodyOwner()')
})

t('bodyBusy and the label BOTH derive from that one read (#4)', () => {
  assert.ok(/lazy\('bodyBusy', \(\) => s\._hold\.length > 0\)/.test(gcode),
    "the gate's truth value comes from the same table - identical to the old || chain, one read instead of five")
  assert.ok(/lazy\('holdLabel', \(\) => s\._hold\.join\('\+'\) \|\| 'unlabeled-hold'\)/.test(gcode),
    'concurrent latches print as e.g. "securing food+recovering-degraded"; an unlabelled hold says so rather than lying')
})

t('all three note sites use holdLabel - and now RENDER it', () => {
  const uses = (gcode.match(/s\.holdLabel/g) || []).length
  assert.strictEqual(uses, 3, 'the two PREEMPT lines and the held line, got ' + uses)
  // STRONGER than the old source-regex: the table is pure, so the verdict lines are produced and
  // compared. A label that stopped reaching the log would pass a grep and fail this.
  const p = { trimmed: 'attack zombie', survival: false, readOnly: false, fromSupervisor: false }
  const s = { holdLabel: 'securing food+recovering-degraded', defendWhenHit: true, beingHit: true, postDeathLatch: true, recoveryMoveCmd: true, holdAdm: { ok: true }, adm: null, survival: false }
  assert.strictEqual(gate.evaluate(p, s, 'body-hold').text,
    'PREEMPT (under attack) - defense outranks the securing food+recovering-degraded hold')
  assert.strictEqual(gate.evaluate({ ...p, trimmed: 'recover' }, s, 'body-hold').text,
    'PREEMPT (post-death recovery) - recovery outranks the securing food+recovering-degraded hold')
  assert.strictEqual(gate.evaluate({ ...p, trimmed: 'goto 1 2 3' }, { ...s, postDeathLatch: false }, 'body-hold').text,
    'held (securing food+recovering-degraded) - brain command suppressed')
  assert.strictEqual(gate.evaluate({ ...p, trimmed: 'gearup', survival: true }, { ...s, postDeathLatch: false, adm: { allow: false, reason: 'no survival need and no grave in reach' } }, 'body-hold').text,
    'held (no survival need: no survival need and no grave in reach) - brain command suppressed')
})

t('what must NOT change: holdNeed (what the hold is FOR) is untouched', () => {
  assert.ok(/holdNeeds: \(\) => \[/.test(code) && /isRecoveringDegraded/.test(code) && /isSecuringFood/.test(code) && /isResting/.test(code),
    'holdNeed answers "what survival need does this hold serve" - a different question from "who holds it"')
  assert.ok(/arbiter\.needRank\(a\) - arbiter\.needRank\(b\)/.test(gcode),
    'most urgent wins when several are latched at once')
  assert.ok(/arbiter\.holdAdmissible\(crisis, need\)/.test(gcode),
    'and the crisis-outranks-peacetime decision still runs off holdNeed, not off the display label')
})

t('ROOT C adds no process.env flag', () => {
  assert.ok(!/process\.env\.HOLD_LABEL/.test(src), 'flag debt is real debt')
})

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
process.exit(failures ? 1 : 0)
