'use strict'
// OFFLINE SOURCE-LEVEL test for ROOT C (2026-08-02): the hold label must name the latch that is
// actually SET. Run:  cd bot && node holdlabeltest.js
//
// index.js dials the server on require, so this reads the source (the dispatchleasetest idiom).
//
// WHAT WENT WRONG: the command gate's `bodyBusy` tested FOUR latches -
//   isBusy || isResting || isSecuringFood || isRecoveringDegraded
// - while the label printed next to every refusal was built THREE separate times as
//   isBusy ? 'busy building' : (isSecuringFood ? 'securing food' : 'night-resting')
// with 'night-resting' as the UNCONDITIONAL else. So a hung recoverFromDegraded - a latch the
// label could not name - printed `held (night-resting)` 53 times on 2026-08-02, and the
// investigation went looking for a bed. A log line must state what happened (#7), and a rule
// tested in one place must not be re-derived in three others (#4).

const assert = require('assert')
const fs = require('fs')
const path = require('path')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
// strip line comments so a literal quoted inside an explanatory comment is not counted as code
const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

t('the old three-way ternary is GONE from all three sites (MUTATION CHECK)', () => {
  const n = (code.match(/'busy building' : \(provFood\.isSecuringFood/g) || []).length
  assert.strictEqual(n, 0, 'restoring any of the three label ternaries fails this: found ' + n)
  assert.ok(!/const label = commands\.isBusy && commands\.isBusy\(\) \? 'busy building'/.test(code),
    'no site may re-derive the label from a subset of the latches the gate actually tests')
})

t("'night-resting' appears exactly ONCE in code, inside the latch table, next to isResting", () => {
  const hits = (code.match(/'night-resting'/g) || []).length
  assert.strictEqual(hits, 1, "one definition of the label, got " + hits)
  assert.ok(/\['night-resting', \(\) => provRecovery\.isResting && provRecovery\.isResting\(\)\]/.test(code),
    'the label is bound to the predicate that makes it true - it can no longer be an assumed else-branch')
})

t('the table names ALL FOUR latches the gate tests - including the one that was unnameable', () => {
  const i = code.indexOf('const holdActive = [')
  assert.ok(i > 0, 'the latch table exists')
  const table = code.slice(i, code.indexOf('].filter(', i))
  for (const [label, pred] of [
    ['busy building', 'commands.isBusy'],
    ['night-resting', 'provRecovery.isResting'],
    ['securing food', 'provFood.isSecuringFood'],
    ['recovering-degraded', 'provRecovery.isRecoveringDegraded']
  ]) {
    assert.ok(table.includes("'" + label + "'"), 'label present: ' + label)
    assert.ok(table.includes(pred), 'predicate present: ' + pred)
  }
})

t('bodyBusy and the label BOTH derive from that one read (#4)', () => {
  assert.ok(/const bodyBusy = holdActive\.length > 0/.test(code),
    "the gate's truth value comes from the same table - identical to the old || chain, one read instead of five")
  assert.ok(/const holdLabel = holdActive\.join\('\+'\) \|\| 'unlabeled-hold'/.test(code),
    'concurrent latches print as e.g. "securing food+recovering-degraded"; an unlabelled hold says so rather than lying')
})

t('all three note sites use holdLabel', () => {
  const uses = (code.match(/holdLabel\}/g) || []).length
  assert.strictEqual(uses, 3, 'the two PREEMPT lines and the held line, got ' + uses)
  assert.ok(/PREEMPT \(under attack\) - defense outranks the \$\{holdLabel\} hold/.test(code))
  assert.ok(/PREEMPT \(post-death recovery\) - recovery outranks the \$\{holdLabel\} hold/.test(code))
  assert.ok(/held \(\$\{survivalCmd \? 'no survival need: ' \+ adm\.reason : holdLabel\}\)/.test(code))
})

t('what must NOT change: holdNeed (what the hold is FOR) is untouched', () => {
  assert.ok(/const holdNeed = \[/.test(code) && /arbiter\.needRank\(a\) - arbiter\.needRank\(b\)/.test(code),
    'holdNeed answers "what survival need does this hold serve" - a different question from "who holds it"')
  assert.ok(/const holdAdm = arbiter\.holdAdmissible\(liveCrisis, holdNeed\)/.test(code),
    'and the crisis-outranks-peacetime decision still runs off holdNeed, not off the display label')
})

t('ROOT C adds no process.env flag', () => {
  assert.ok(!/process\.env\.HOLD_LABEL/.test(src), 'flag debt is real debt')
})

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
process.exit(failures ? 1 : 0)
