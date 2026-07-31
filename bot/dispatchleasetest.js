'use strict'
// OFFLINE contract test for THE DISPATCH LEASE - the rule that makes a soft-lock impossible.
// No bot, no world, no clock (time is passed in).
//
// WHY THIS FILE EXISTS. `schedJob` is an exclusive claim on the body: while it is set, the scheduler
// tick dispatches NOTHING. Its release was coupled to runJob's promise resolving, so an executor
// that never resolved held it forever. Live 2026-07-30, on three different jobs:
//   (wd) stop latch ineffective on recoveryLadder - a hung promise; standing down, layer d ... owns this
//   (wd) stop latch ineffective on secureFood     - a hung promise; ...
//   (wd) stop latch ineffective on recover        - a hung promise; ... every 2-3 min, for hours
// GIVEUP - the LAST rung of NUDGE -> FAIL-JOB -> GIVEUP - only logged, and deferred to a "layer d"
// that never collected them. A rung with no power is not a rung.
//
// Every latch above it is COOPERATIVE: only a job that awaits something polling isStopped() can see
// one. The final rung exists precisely for the case where that assumption has already failed, so the
// final rung must not itself be cooperative.
//
// reflexes.js already had the right rule and said so: "an expired hold is NOT a hold: the watchdog
// gets the body back". The dispatch slot was the one exclusive claim exempt from it.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

let fails = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fails++ } }

// ---- a faithful model of the lease + epoch semantics in index.js ------------------------
// Mirrors dispatchBusy / revokeDispatch / runJob's epoch-guarded finally. Kept as a MODEL (like
// foodtest's dead-band sweep) so the RULE is pinned independently of the live wiring, which the
// source pins below cover.
function makeSlot (leaseMs) {
  let slot = null
  let gen = 0
  const released = []       // hold tokens handed back, in order
  return {
    dispatch (name, now, holdToken) {
      const myGen = ++gen
      slot = { name, startedAt: now, until: now + leaseMs, gen: myGen, holdToken }
      return myGen
    },
    busy (now) {                                   // dispatchBusy(): lazily expires on READ
      if (!slot) return null
      if (slot.until != null && slot.until <= now) { this.revoke(now); return null }
      return slot
    },
    revoke () {                                    // revokeDispatch(): take the body back
      if (!slot) return false
      if (slot.holdToken) released.push(slot.holdToken)
      slot = null
      gen++
      return true
    },
    finish (myGen) {                               // runJob's epoch-guarded finally
      const mine = slot && slot.gen === myGen
      if (mine) { if (slot.holdToken) released.push(slot.holdToken); slot = null; return 'cleared' }
      return 'not-mine'
    },
    released,
    peek () { return slot }
  }
}

const LEASE = 600000

// ---- THE LIVE SOFT-LOCK, as a fixture --------------------------------------------------
t('THE SOFT-LOCK: a hung executor holds the slot forever without a lease', () => {
  const s = makeSlot(Infinity)                     // Infinity = the old behaviour: no expiry
  s.dispatch('recoveryLadder', 0, 'h1')
  // the promise never resolves, so `finish` is never called
  assert(s.busy(60 * 60 * 1000), 'an un-leased slot is still held an hour later - nothing can dispatch')
})
t('...and with a lease, the body comes back on its own', () => {
  const s = makeSlot(LEASE)
  s.dispatch('recoveryLadder', 0, 'h1')
  assert(s.busy(LEASE - 1), 'still owned inside the lease')
  assert.strictEqual(s.busy(LEASE), null, 'the lease expires and the slot frees itself')
})
t('...and GIVEUP can take it back immediately, without waiting for the lease', () => {
  const s = makeSlot(LEASE)
  s.dispatch('recover', 0, 'h1')
  assert.strictEqual(s.revoke(), true)
  assert.strictEqual(s.busy(1000), null, 'revoked -> the next job may dispatch')
})

// ---- the hold must come back too -------------------------------------------------------
t('a revoke RELEASES the declared body hold (else reflexes still thinks the job owns the body)', () => {
  const s = makeSlot(LEASE)
  s.dispatch('secureFood', 0, 'hTok')
  s.revoke()
  assert.deepStrictEqual(s.released, ['hTok'])
})
t('a lease expiry releases the hold as well - same path, no second rule', () => {
  const s = makeSlot(LEASE)
  s.dispatch('secureFood', 0, 'hTok')
  s.busy(LEASE)                                    // expiry runs through revoke
  assert.deepStrictEqual(s.released, ['hTok'])
})

// ---- THE ANTI-CLOBBER EPOCH: the subtle way this fix could break everything -------------
t('EPOCH: a late-returning abandoned job must NOT clear its successor\'s slot', () => {
  const s = makeSlot(LEASE)
  const hungGen = s.dispatch('recover', 0, 'h1')
  s.revoke()                                       // GIVEUP takes the body back
  s.dispatch('secureFood', 1000, 'h2')             // a NEW job now owns the slot
  assert.strictEqual(s.finish(hungGen), 'not-mine', 'the zombie must not free the new job\'s slot')
  assert(s.busy(2000), 'the successor still owns the body')
  assert.strictEqual(s.peek().name, 'secureFood')
})
t('EPOCH: a normal job DOES clear its own slot', () => {
  const s = makeSlot(LEASE)
  const g = s.dispatch('gather', 0, 'h1')
  assert.strictEqual(s.finish(g), 'cleared')
  assert.strictEqual(s.busy(1), null)
})
t('EPOCH: two dispatches in a row never collide', () => {
  const s = makeSlot(LEASE)
  const g1 = s.dispatch('a', 0, 'h1')
  assert.strictEqual(s.finish(g1), 'cleared')
  const g2 = s.dispatch('b', 10, 'h2')
  assert.notStrictEqual(g1, g2, 'each dispatch is its own epoch')
  assert.strictEqual(s.finish(g2), 'cleared')
})
t('EPOCH: revoke bumps the epoch, so the revoked job can never be "mine" again', () => {
  const s = makeSlot(LEASE)
  const g = s.dispatch('recover', 0, 'h1')
  s.revoke()
  assert.strictEqual(s.finish(g), 'not-mine')
})

// ---- the invariant, swept -------------------------------------------------------------
t('INVARIANT: no elapsed time leaves the slot permanently held', () => {
  const stuck = []
  for (const elapsed of [0, 1, 1000, 60000, LEASE - 1, LEASE, LEASE + 1, 3600000, 86400000]) {
    const s = makeSlot(LEASE)
    s.dispatch('hung', 0, 'h1')                    // never finishes
    if (elapsed >= LEASE && s.busy(elapsed)) stuck.push(elapsed)
  }
  assert.deepStrictEqual(stuck, [], 'elapsed times where a hung job still owns the body: ' + stuck.join(', '))
})

// ---- ANTI-DRIFT: the live wiring must match the rule ------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')

t('ANTI-DRIFT: GIVEUP REVOKES - it is not allowed to merely log again', () => {
  const i = SRC.indexOf("wdState.act === 'giveup'")
  assert(i > 0, 'the giveup rung still exists')
  const rung = SRC.slice(i, i + 1900)
  // The revoke must be an UNCONDITIONAL STATEMENT. Asserting merely that the text `revokeDispatch(`
  // appears somewhere is too weak - `if (false && !revokeDispatch(...))` satisfies that and does
  // nothing (found by mutation testing this very pin). Requiring the bare assignment form means a
  // neutering edit has to touch the line the pin reads.
  assert(/const revoked = revokeDispatch\(/.test(rung),
    'the last rung must take the body back as a plain statement, not inside a condition that can be disabled')
  assert(!/(&&|\|\||\?)\s*!?revokeDispatch\(/.test(rung),
    'the revoke must not be guarded by an expression - that is how an action becomes a no-op again')
  assert(!/standing down, layer d \(supervisor frozen-vitals\/kill\) owns this/.test(rung),
    'deferring to a layer that never collected these is what made the ladder terminate in a no-op')
})
t('ANTI-DRIFT: nothing tests the raw slot - every read goes through the lease', () => {
  // strip the definition block (where touching schedJob directly is the point) and comments
  const body = SRC.split('\n')
    .filter(l => !/^\s*(\/\/|\*)/.test(l))
    .filter(l => !/schedJob = |schedJob\.gen|schedJob\.until|schedJob\.holdToken|const stale = schedJob|const j = schedJob|if \(!schedJob\) return|return schedJob/.test(l))
    .join('\n')
  const raw = body.split('\n').filter(l => /\bschedJob\b/.test(l))
  assert.deepStrictEqual(raw, [], 'these bypass the lease and can observe an expired claim:\n' + raw.join('\n'))
})
t('ANTI-DRIFT: the slot carries an expiry and a generation', () => {
  assert(/until: startedAt \+ DISPATCH_LEASE_MS/.test(SRC), 'a slot with no expiry is the soft-lock')
  assert(/const myGen = \+\+schedGen/.test(SRC), 'each dispatch needs its own epoch')
  assert(/schedGen\+\+/.test(SRC), 'a revoke must move the epoch on')
})
t('ANTI-DRIFT: runJob\'s finally is epoch-guarded', () => {
  const i = SRC.indexOf('const mine = schedJob && schedJob.gen === myGen')
  assert(i > 0, 'the finally must compare epochs before freeing anything')
  const fin = SRC.slice(i, i + 700)
  assert(/if \(mine\)/.test(fin), 'and only clear the slot when it is still its own')
})
t('ANTI-DRIFT: a revoke lets go of the CONTROLS, not just the bookkeeping', () => {
  const i = SRC.indexOf('function revokeDispatch')
  assert(i > 0, 'revokeDispatch exists')
  const fn = SRC.slice(i, i + 1200)
  assert(/reflexes\.endHold/.test(fn), 'the declared hold must come back')
  assert(/setGoal\(null\)/.test(fn), 'an abandoned executor may still be steering')
  assert(/clearControlStates/.test(fn), 'two actors driving one body is the invariant this breaks')
})

// ==== A JOB THAT MERELY RAN IS NOT PROGRESS (live 2026-07-31) ================================
// The build and the opportunistic maintain livelocked at ~90s per cycle:
//   OPPORTUNISTIC MAINTAIN - at the hut mid-build (pausing the build; it resumes via re-arm)
//   maintenancePass -> window abandoned - build did not unwind in time (60s retry)
// maintenancePass returns a plain STRING there, so runJob's finally stamped
// `holdReleased:maintenancePass` every cycle and reset the progress clock. The body did not move
// for 5.5 HOURS - not one [prov]/[build]/[nav] line - and the watchdog fired ZERO nudges, because
// the livelock kept feeding the very witness meant to catch it. A record written from an ATTEMPT
// instead of from EVIDENCE. The MODEL of the rule (the live wiring is pinned by source below):
function runJobProgress (progressAt, { touchedDuringRun }) {
  const t0 = progressAt + 1                   // touchProgress('dispatch:'+name) - this job's own t0
  const at = touchedDuringRun ? t0 + 500 : t0 // did anything real stamp between dispatch and release?
  return at !== t0 ? at + 1 : at              // stamp on release ONLY if the job did something
}

t('PROGRESS: a job that DID work stamps on release (a quiet ten-minute job stays fresh)', () => {
  const before = 1000
  const after = runJobProgress(before, { touchedDuringRun: true })
  assert(after > before + 1, 'real work during the run must refresh the clock on release')
})

t('THE 5.5-HOUR FREEZE: a job that touched NOTHING must not stamp progress on release', () => {
  const before = 1000
  const t0 = before + 1
  const after = runJobProgress(before, { touchedDuringRun: false })
  assert.strictEqual(after, t0, 'an abandoned window may not age the clock - the watchdog must keep counting')
})

t('THE 5.5-HOUR FREEZE: the clock must AGE inside an abandoned dispatch so NUDGE can fire', () => {
  // The dispatch stamp legitimately zeroes the clock (a fresh job is not stale). What was fatal
  // is the RELEASE stamp: with it, a 60s abandoned window was bracketed by two stamps and the
  // clock never reached the 40s nudge while a job was active. Without it, idle ages normally.
  const NUDGE_AT = 40000
  const dispatchAt = 100000
  const abandonedFor = 60000
  const clockAtRelease = runJobProgress(dispatchAt - 1, { touchedDuringRun: false })
  const idleWhileActive = (dispatchAt + abandonedFor) - clockAtRelease
  assert(idleWhileActive >= NUDGE_AT,
    'a 60s window that did nothing must show ' + Math.round(idleWhileActive / 1000) + 's of idle - enough for the watchdog to nudge')
})

t('ANTI-DRIFT: the live release stamp is CONDITIONAL on the job having touched progress', () => {
  const i = SRC.indexOf("touchProgress('holdReleased:'")
  assert(i > 0, 'the release stamp exists')
  const window = SRC.slice(Math.max(0, i - 900), i + 200)
  assert(/didWork/.test(window), 'the release stamp must be gated on the job having done something')
  assert(/t0Progress/.test(window), 'it must compare against this dispatch\'s own t0 stamp')
  assert(!/^\s*commands\.touchProgress\('holdReleased:' \+ name\)\s*$/m.test(SRC),
    'an UNCONDITIONAL release stamp is back - that is what blinded the watchdog for 5.5 hours')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall dispatch-lease tests passed')
process.exit(fails ? 1 : 0)
