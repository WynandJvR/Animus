'use strict'
// OFFLINE unit test: NEVER EXPORT MUTABLE STATE BY VALUE - REACH A LIVE LATCH THROUGH ITS OWNER.
//
// The live defect (2026-08-26, spawn). The bot spent every night standing in the open instead of
// digging in, died three times in ten minutes at hp20/food20 holding 30 dirt, and the only clue was
// one line from the claim reaper:
//
//   (claim) REVOKED shelter (the night shelter) - no world delta credited to it for 151s
//   (claim) ...nothing to take back: the latch behind shelter is outside releaseBodyClaims'
//           owners table - a wiring hole, not a decision
//
// It was not outside the table. commands.BODY_LATCHES routes the 'shelter' claim to
// provision-recovery.releaseRecoveryLatches, exactly as designed. The wiring hole was one word in
// a destructure: provision-recovery did
//
//   const { ..., _sheltering } = provShelter
//
// and `_sheltering` is a `let` in provision-shelter, exported by VALUE. So provision-recovery got a
// snapshot of `false` taken once at require time - a dead local, not the latch. Three consequences,
// all silent:
//   - isResting() could never see a live shelter, so the claim system misreported it;
//   - releaseRecoveryLatches cleared the dead copy, so the REAL flag was never lowered;
//   - digInForNight's first line is `if (!bot.entity || _sheltering) return false`, reading the real
//     flag - so after the first revoked shelter, every dig-in for the rest of the process returned
//     false immediately and the bot could not shelter again, ever.
//
// Run:  cd bot && node shelterlatchtest.js

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')

// AMBIENT-PROOF: nothing inherited from the shell.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelterlatch-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.SCAFFOLD_FILE = path.join(tmp, 'scaffold-registry.json')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')
process.env.BUILD_DEBUG = ''

const provShelter = require('./provision-shelter.js')
const provRecovery = require('./provision-recovery.js')

let failures = 0
const queue = []
function t (name, fn) { queue.push([name, fn]) }

// ---- 1. the trap itself: the flag must not be exported by value ------------------------------
t('provision-shelter does NOT export _sheltering (a `let` in an object literal is a snapshot)', () => {
  assert.ok(!('_sheltering' in provShelter),
    'exporting the raw `let` hands every importer a dead copy of `false` - export isSheltering()/releaseShelterLatch() instead')
})

t('it exports the two accessors that CAN see and clear the live latch', () => {
  assert.strictEqual(typeof provShelter.isSheltering, 'function')
  assert.strictEqual(typeof provShelter.releaseShelterLatch, 'function')
})

t('provision-recovery does not destructure the mutable flag out of provision-shelter', () => {
  const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/[{,]\s*_sheltering\s*[,}]/.test(code),
    'destructuring _sheltering captures a snapshot; reach it through provShelter.isSheltering()')
})

// ---- 2. the behaviour those wires exist for ---------------------------------------------------
// The module object is the seam both sides now go through, so replacing a method here is exactly
// what the fixed code does at call time - and what the broken code could not have observed.
function withShelterHeld (fn) {
  const realIs = provShelter.isSheltering
  const realRelease = provShelter.releaseShelterLatch
  let held = true
  let releaseCalls = 0
  provShelter.isSheltering = () => held
  provShelter.releaseShelterLatch = () => { releaseCalls++; const was = held; held = false; return was }
  try { return fn(() => held, () => releaseCalls) } finally {
    provShelter.isSheltering = realIs
    provShelter.releaseShelterLatch = realRelease
  }
}

t('isResting() reflects a LIVE shelter, not a require-time snapshot', () => {
  withShelterHeld(() => {
    assert.strictEqual(provRecovery.isResting(), true,
      'a raised shelter latch must be visible to isResting - this is the claim system\'s only window onto it')
  })
  assert.strictEqual(provRecovery.isResting(), false, 'and false again once it is down')
})

t('THE FIX: revoking the shelter claim actually lowers the owner\'s latch', () => {
  withShelterHeld((held, calls) => {
    const freed = provRecovery.releaseRecoveryLatches(['shelter'])
    assert.strictEqual(freed, true, 'the release must REPORT that it freed something - the live log said it freed nothing')
    assert.strictEqual(calls(), 1, 'it must call through to provision-shelter.releaseShelterLatch')
    assert.strictEqual(held(), false, 'and the real latch must now be DOWN, so digInForNight can run again')
  })
})

t('releasing an unrelated claim does not take the shelter down with it', () => {
  withShelterHeld((held) => {
    provRecovery.releaseRecoveryLatches(['ladder'])
    assert.strictEqual(held(), true, 'per-claim revocation must stay per-claim (the `only` filter exists for this)')
  })
})

// ---- 3. the claim table still names it where the reclaimer can see it -------------------------
t('commands.bodyClaimHeld("shelter") reads the same live latch the release clears', () => {
  const commands = require('./commands.js')
  withShelterHeld(() => {
    assert.strictEqual(commands.bodyClaimHeld('shelter'), true,
      'the query and the release must describe one world (rule 4) - a snapshot made them describe two')
  })
})

// ---- run --------------------------------------------------------------------------------------
;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('  ok  ' + name) } catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message) }
  }
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall ' + queue.length + ' passed')
  process.exit(failures ? 1 : 0)
})()
