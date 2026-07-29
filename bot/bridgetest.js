'use strict'
// ==== THE BRIDGE CONTRACT: every P()/S() call resolves to something ========================
//
// The 2026-07-18 split gave the leaf modules two ways back to provision.js:
//   P()  the PUBLIC surface (module.exports)      - what any importer can call
//   S()  the __siblings bridge (internal getters) - what only the split modules may call
// Neither is checked by anything at load time, and provision.js is full of defensive
// try{}catch{} that DEGRADES rather than fails - so `P().somethingThatMoved(...)` resolves to
// undefined, throws a TypeError, lands in a swallowing catch, and reads in the log as "the bot
// quietly stopped doing X". Four regression classes shipped that way in one day.
//
// design-docs/check-extraction.py has caught this since; it is mutation-verified and it is
// better than this file (it also finds left-behind bindings and getter assignments). But it is a
// PYTHON script sitting outside `for f in bot/*test*.js`, which is the gate that actually gets
// run - and it had been reporting a real live defect, unfixed, for long enough that the ladder's
// whole orchard rung was a no-op: R3 trekked to the orchard and called P().gatherLoop, which is
// on NEITHER surface (gatherLoop is internal; runGather is its public router). The bot walked to
// its own trees and came back with nothing, silently, every time.
//
// So the one load-bearing check lives in the JS suite too. Run check-extraction.py as well.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

let fails = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fails++ } }

const provision = require('./provision.js')
const siblings = provision.__siblings || {}

// Every split module that reaches back into provision.js.
const MODULES = fs.readdirSync(__dirname)
  .filter(f => /^(provision-.*|survival-snapshot)\.js$/.test(f))
  .sort()

// CRLF-normalised, comments stripped - this repo checks out CRLF and a stripper that forgets
// that is a silent no-op (it has burned two source-pinning tests here).
function codeOf (file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')) // line comments, not the // in a URL/string
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function callsIn (src, re) {
  const out = new Set()
  let m
  while ((m = re.exec(src))) out.add(m[1])
  return [...out]
}

t('every split module exists to be checked (the enumeration is not empty)', () => {
  assert(MODULES.length >= 10, 'expected the split modules, found ' + MODULES.length)
  assert(Object.keys(siblings).length > 0, 'provision.__siblings is empty - the bridge is gone?')
})

t('WRONG-BRIDGE: every P().name resolves on the PUBLIC surface', () => {
  const bad = []
  for (const f of MODULES) {
    for (const name of callsIn(codeOf(f), /\bP\(\)\.(\w+)/g)) {
      if (provision[name] === undefined) bad.push(f + ': P().' + name)
    }
  }
  assert.deepStrictEqual(bad, [], 'calls that resolve to undefined and die in a swallowing catch:\n       ' + bad.join('\n       '))
})

t('WRONG-BRIDGE: every S().name resolves on the __siblings bridge', () => {
  const bad = []
  for (const f of MODULES) {
    for (const name of callsIn(codeOf(f), /\bS\(\)\.(\w+)/g)) {
      if (siblings[name] === undefined) bad.push(f + ': S().' + name)
    }
  }
  assert.deepStrictEqual(bad, [], 'calls that resolve to undefined and die in a swallowing catch:\n       ' + bad.join('\n       '))
})

t('no bridge getter resolves to undefined (assigning to a getter is silently lost)', () => {
  const undef = Object.keys(siblings).filter(k => siblings[k] === undefined)
  assert.deepStrictEqual(undef, [], 'siblings that resolve to undefined: ' + undef.join(', '))
})

t('THE ORCHARD RUNG: its harvest call resolves - the instance that was live when this was written', () => {
  assert.strictEqual(typeof siblings.gatherLoop, 'function', 'gatherLoop must be reachable over the bridge')
  const src = codeOf('provision-recovery.js')
  assert(/S\(\)\.gatherLoop\(/.test(src), 'the orchard rung must call it over the SIBLINGS bridge')
  assert(!/P\(\)\.gatherLoop\(/.test(src), 'and never over the public surface, where it does not exist')
})

t('the check is not vacuous: it actually found calls to check', () => {
  let n = 0
  for (const f of MODULES) {
    n += callsIn(codeOf(f), /\bP\(\)\.(\w+)/g).length + callsIn(codeOf(f), /\bS\(\)\.(\w+)/g).length
  }
  assert(n >= 20, 'only ' + n + ' bridge calls found - the regex or the comment stripper is broken')
  console.log('      (' + n + ' distinct bridge calls checked across ' + MODULES.length + ' modules)')
})

if (fails) { console.log('\n' + fails + ' FAILURE(S)'); process.exit(1) }
console.log('\nall bridge contract tests passed')
