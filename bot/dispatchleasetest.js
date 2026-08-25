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
  const t0 = progressAt + 1                   // this dispatch's own baseline (2026-08-25: the advanceCount read at dispatch; it used to be a touchProgress('dispatch:'+name) stamp, which told every reader the body had progressed just for being dispatched)
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
  // A fresh job legitimately starts at zero idle - since 2026-08-25 the work ledger gives it that
  // by re-basing on its own jobKey, rather than by stamping a global cell. What was fatal
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

// ==== THE ACTIVITY LABEL IS THE THIRD EXCLUSIVE CLAIM (live 2026-07-31) ======================
// beginActivity/endActivity are correctly paired at every call site. That is only sufficient
// while the awaited work RESOLVES - and `planner.gearUp` hung, so the try body never finished,
// the catch never fired, and the label stayed open for FIFTY-TWO MINUTES:
//   activity: {name:'gearup', forSec:3150}   body frozen at (216,58,-124), moving:false
//   (wd) NUDGE gearup -> FAIL-JOB gearup -> stop latch ineffective on gearup
//   (wd) gearup holds no dispatch slot - releasing the controls    ...19x, every 2.5 min
// It held no slot because maintenancePass had long since returned: the watchdog was failing a
// job that was not running, and had nothing to revoke. Same rule as the other two exclusive
// claims - "an expired hold is NOT a hold", "the slot is a LEASE, not a flag" - now applied to
// the last one that was exempt.
t('ACTIVITY LEASE: a fresh activity is live', () => {
  delete require.cache[require.resolve('./telemetry.js')]
  process.env.ACTIVITY_LEASE_MS = '900000'
  const tel = require('./telemetry.js')
  tel.beginActivity('gearup', 'armor')
  const a = tel.activityInfo()
  assert(a && a.name === 'gearup', 'a just-begun activity must report')
})

t('THE 52-MINUTE GHOST: the phantom label is cleared by EVIDENCE, not by a clock', () => {
  delete require.cache[require.resolve('./telemetry.js')]
  const tel = require('./telemetry.js')
  tel.beginActivity('gearup', 'armor')
  assert(tel.activityInfo(), 'a live activity reports while its work is running')
  // the watchdog's terminal rung - after the full verified-progress ladder - reclaims it
  assert.strictEqual(tel.clearActivity('watchdog giveup'), true, 'the rung must be able to drop a hung label')
  assert.strictEqual(tel.activityInfo(), null, 'a hung promise must not leave a permanent phantom job for the watchdog to chase')
})

t('NO INVENTED TIMERS: neither the activity nor the body claim carries a lease of its own', () => {
  // The first cut of both fixes used a 15-minute constant. DESIGN-PRINCIPLES #6 forbids the
  // blanket timer and #3 asks for a condition over a constant; the verified-progress ladder IS
  // the condition, and the giveup rung is its one owner. A number reappearing here means someone
  // has gone back to guessing how long "too long" is.
  const tel = fs.readFileSync(path.join(__dirname, 'telemetry.js'), 'utf8')
  const cmd = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  assert(!/ACTIVITY_LEASE_MS/.test(tel), 'the activity label must not re-grow a timer')
  assert(!/BODY_CLAIM_LEASE_MS/.test(cmd), 'the body claim must not re-grow a timer')
  assert(/function clearActivity/.test(tel), 'the label is reclaimed by an explicit call from the watchdog')
  assert(/function releaseBodyClaims/.test(cmd), 'so is the body claim')
})

// ==== THE FOURTH EXCLUSIVE CLAIM: isBusy (live 2026-07-31) ==================================
// `provisioning = true; try { await planner.gearUp(...) } finally { provisioning = false }` is
// correct ONLY while the awaited work resolves. planner.gearUp HUNG, the finally never ran,
// provisioning stayed true, and isBusy() gated the scheduler for 51 MINUTES - the tick chain
// re-armed, ran, and refused to dispatch anything while the bot stood frozen at (242,45,-102):
//   16:24:06 (core) chose maintenancePass     <- the last job ever chosen
//   17:15:32 (wd) NUDGE maintenancePass - no verified progress for 120s
// Three sibling claims had already been given leases (reflex hold / dispatch slot / activity
// label). Fixing them one at a time was the whack-a-mole; this pins the RULE.
t('THE 51-MINUTE GATE: releaseBodyClaims frees the body isBusy was holding', () => {
  delete require.cache[require.resolve('./commands.js')]
  const cmds = require('./commands.js')
  assert.strictEqual(cmds.isBusy(), false, 'nothing is claimed to begin with')
  assert.strictEqual(cmds.releaseBodyClaims('nothing held'), null, 'releasing nothing reports nothing - an honest no-op')
})

t('ANTI-DRIFT: the giveup rung releases the CLAIM, not just the nav goal', () => {
  // The rung decided "hung - take the body back" and then cleared only the pathfinder goal, which
  // was never what held the body: `provisioning` gates every dispatch through isBusy(). A decision
  // must produce an action (#5).
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  const i = idx.indexOf('holds no dispatch slot - releasing the controls instead')
  assert(i > 0, 'the no-lease giveup branch still exists')
  const branch = idx.slice(i, i + 1400)
  assert(/releaseBodyClaims\(/.test(branch), 'the terminal rung must release the body claim - clearing the nav goal alone leaves isBusy true forever')
  assert(/clearControlStates/.test(branch), 'and still let go of the controls')
})

// ==== "THE BODY IS FREE FOR THE NEXT JOB" WAS NOT TRUE (measured 2026-08-02) =============
// The slot is only ONE of the two records of "this job owns the body". The other is the executor's
// own latch, raised before the await and lowered in a `finally` a hung executor never reaches - and
// reflexes.BODY_OWNERS reads THOSE, not the slot. `ladder` is hard:true, so it refuses everything.
//   18:12:40 (wd) REVOKED the dispatch slot from recoverFromDegraded - lease expired after 605s;
//                 the body is free for the next job
//   ...then, for the next NINETEEN minutes, at hp 20 / food 20 / armor 0, on one block, through a
//   whole night: "(core) nightShelter REFUSED: the recovery ladder owns the body", and
//   "(core) chose build/idle: standoff ... CRISIS UNANSWERED (nightShelter: the recovery ladder
//   owns the body; maintenancePass: ...; reclaim: ...; scaffoldSweep: ...)".
// The two branches of ONE verdict disagreed about what taking the body back means: the no-slot
// branch below released the claim, the revoke branch printed that it had.
t('REVOKE: taking the slot back also takes the LATCH back - the two records of one claim (#4/#7)', () => {
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  const i = idx.indexOf('function revokeDispatch (why)')
  assert(i > 0, 'revokeDispatch still exists')
  const fn = idx.slice(i, idx.indexOf('\nlet schedLastLog', i))
  assert(/releaseBodyClaims\(/.test(fn),
    'MUTATION CHECK: delete this call and the revoke goes back to freeing a slot nothing reads while ' +
    'the latch the chooser DOES read stays set - 19 minutes of CRISIS UNANSWERED, measured')
  assert(/schedJob = null/.test(fn) && /schedGen\+\+/.test(fn), 'and it still frees the slot and bumps the epoch')
  // the release must be the SAME function the giveup rung uses - not a second idea of "free" (#4)
  const cmd = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  assert(/function releaseBodyClaims/.test(cmd), 'through the one owner')
  assert(!/_recoveringDegraded = false/.test(fn), 'and never by reaching into another module\'s latch itself')
})

t('REVOKE: the release is BEHIND the verdict, never a timeout on a job that is merely slow', () => {
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  // exactly two callers, and both are already terminal judgements about an abandoned executor:
  // the 600s dispatch lease expiring, and the watchdog giveup rung after its full progress ladder.
  const callers = (idx.match(/revokeDispatch\(/g) || []).length // the definition is `revokeDispatch (why)` - a space, so it is not counted
  assert.strictEqual(callers, 2, 'exactly TWO callers (lease expiry, giveup rung) - found ' + callers)
  assert(/revokeDispatch\('lease expired after /.test(idx), 'caller 1: the lease')
  assert(/revokeDispatch\('hung promise: /.test(idx), 'caller 2: the giveup rung')
})

t('THE 4.5-HOUR GHOST: a stuck provision latch is released too, not just isBusy', () => {
  // The exact live state, 2026-07-31 18:06-22:30: activityInfo() null, isBusy() false, and
  // `_maintaining` alone reporting 'maintenancePass' to activeJobInfo forever. The scheduler
  // dispatched NOTHING for four and a half hours. stopMaintenance() cannot help - it is a
  // COOPERATIVE flag the pass polls, and a hung await polls nothing.
  delete require.cache[require.resolve('./commands.js')]
  const cmds = require('./commands.js')
  const pm = require('./provision-maintain.js')
  const ss = require('./survival-snapshot.js')
  pm._setMaintaining(true)
  assert.strictEqual(cmds.isBusy(), false, 'isBusy is clean - this ghost is NOT one of its flags')
  const before = ss.activeJobInfo()
  assert(before && before.name === 'maintenancePass', 'the phantom job is what the watchdog chases')
  const freed = cmds.releaseBodyClaims('watchdog giveup on maintenancePass')
  assert(freed && /maintaining/.test(freed), 'the reclaimer must free the provision latch too: ' + freed)
  assert.strictEqual(ss.activeJobInfo(), null, 'and the phantom job is gone, so the scheduler can dispatch again')
})

t('ANTI-DRIFT: the reclaimer covers EVERY latch activeJobInfo can report', () => {
  // activeJobInfo names a job from five provision latches. Any one of them left out is another
  // 4.5-hour stall waiting to happen, in a different costume.
  const snap = fs.readFileSync(path.join(__dirname, 'survival-snapshot.js'), 'utf8')
  const cmd = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  const i = snap.indexOf('function activeJobInfo')
  const fn = snap.slice(i, snap.indexOf('async function schedulerState', i))
  const latches = [...fn.matchAll(/if \((is[A-Za-z]+)\(\)\)/g)].map(m => m[1])
  assert(latches.length >= 5, 'expected the five job latches, found ' + latches.join(','))
  // slice to the END of the function, not a magic byte count: ROOT H (2026-08-02) added two more
  // latches and their rationale, and a fixed 2200-char window silently cut the assertion's own
  // evidence in half - the test was measuring comment length, not coverage.
  const relStart = cmd.indexOf('function releaseBodyClaims')
  const rel = cmd.slice(relStart, cmd.indexOf('\nfunction ', relStart + 1))
  assert(/releaseMaintainLatch/.test(rel) && /releaseFoodLatch/.test(rel) && /releaseRecoveryLatches/.test(rel),
    'the reclaimer must force-release the maintain, food and recovery latch groups - ' + latches.join(',') + ' can each name a phantom job')
})

t('ANTI-DRIFT: every body claim is STAMPED where it is taken (so the release can report it)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  for (const c of ['building', 'provisioning', 'buildReqActive']) {
    const sets = (src.match(new RegExp('\\b' + c + ' = true\\b', 'g')) || []).length
    const stamps = (src.match(new RegExp("claimStamp\\('" + c + "'\\)", 'g')) || []).length
    assert.strictEqual(stamps, sets, c + ': every `= true` must be stamped (' + sets + ' sets, ' + stamps + ' stamps)')
  }
  assert(/function releaseBodyClaims/.test(src), 'and there must be exactly one place that hands the body back')
})

// ==== A KICK THAT ONLY LOGS IS NOT A KICK (live 2026-08-01) =================================
// The IDLE-WITH-WORK clause detects a survival pick sitting undispatched while the body is truly
// idle, announces "kicking", and then - unless vitals were at crisis - did nothing at all. Live,
// at FULL hp and food, with the castle build resumed and waiting 17 blocks away:
//   (wd) IDLE WITH WORK 30s+: pick=recoveryLadder undispatched - kicking   x4, no dispatch
// The bot stood still for four minutes being "kicked".
t('IDLE-WITH-WORK: the kick clears the stale back-offs at ANY vitals, not only at crisis', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  const i = src.indexOf("IDLE WITH WORK 30s+")
  assert(i > 0, 'the idle-with-work clause still exists')
  const clause = src.slice(i, i + 1800)
  // the remedy must not sit behind a vitals gate - the condition that names the branch is enough
  assert(!/if \(bot\.health <= 6 \|\| bot\.food <= 2\) \{[\s\S]{0,400}attempts\.forgetAll/.test(clause),
    'the clearing is gated on crisis vitals again - at any healthy reading the kick is just a log line')
  // runner.ladderBlock / runner.noOp.clear() WERE two of the four names checked here. They are
  // deleted (review D3/§3.6): "I tried this and it achieved nothing" is a fact about a place now,
  // and attempts.forgetAll() is the ONE clear that covers what both of them used to hold. The
  // behaviour this test bought - the kick actually clears the back-offs, at any vitals - is
  // unchanged and still asserted; only the number of things to clear went from four to three.
  for (const back of ['runner.graveCooldownUntil', 'runner.hpCooldownUntil', 'attempts.forgetAll']) {
    assert(clause.includes(back), 'the kick must actually clear ' + back)
  }
  // and it has to be reachable: the clears sit directly in the clause body, not inside any `if`
  const body = clause.slice(clause.indexOf('undispatched - kicking'))
  const clears = body.indexOf('runner.graveCooldownUntil')
  const anyIf = body.slice(0, clears).lastIndexOf('if (')
  assert(anyIf === -1, 'nothing may stand between detecting the stall and clearing the back-offs')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall dispatch-lease tests passed')
process.exit(fails ? 1 : 0)
