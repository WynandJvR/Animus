'use strict'
// REGRESSION TESTS FOR THE THREE LOOPS IN AUDIT-2026-07-29-survival-systems.md.
//
// Each fixture below is a real snapshot shape taken from logs/bot-events.log on 2026-07-20, and
// each assertion states what the bot did then and must never do again. Pure functions only - no
// bot, no server, no clock.
const assert = require('assert')
const S = require('./scheduler.js')
const core = require('./scheduler-core.js')

let fails = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fails++ } }
function withEnv (name, val, fn) {
  const old = process.env[name]
  if (val == null) delete process.env[name]; else process.env[name] = val
  try { return fn() } finally { if (old == null) delete process.env[name]; else process.env[name] = old }
}

function snap (over) {
  return Object.assign({
    hp: 20, food: 20, packFoodPts: 0, armorPieces: 4, underArmored: false,
    threatDist: null, creeperDist: null, isNight: false, nightStuck: false,
    drowning: false, onFire: false, inLava: false,
    graves: [], homeDist: null, homeReachable: false, bankFoodPts: 0,
    farm: { exists: false }, orchard: {}, tools: { pick: true, sword: true },
    gearupBackoffUntil: 0, deathsRecent: 0, bankArmorPieces: 0,
    activeJob: null, brainJobPending: false, persistedBuild: false, maintainNeeded: false,
    postDeathRecovery: false, spawnAnchored: true, spawnSuspect: false
  }, over || {})
}

// The exact state at 10:56:11 on 2026-07-20: just respawned at world spawn, naked, night,
// 486 blocks from a hut whose bed is gone, having already died 7 times in the last 20 minutes.
const THE_TREADMILL = snap({
  hp: 20, food: 20, armorPieces: 0, underArmored: true, isNight: true,
  homeDist: 486, homeReachable: false, deathsRecent: 7,
  postDeathRecovery: true, spawnAnchored: false, spawnSuspect: true,
  tools: { pick: false, sword: false }
})

// ============ LOOP A - the respawn treadmill =============================================
t('LOOP A: the 486b naked night crossing is REFUSED (it killed the bot 8x in 7 minutes)', () => {
  const j = S.journeyAdmissible(THE_TREADMILL, 486)
  assert.strictEqual(j.ok, false, 'the crossing that killed the bot eight times must not be admissible')
  assert.strictEqual(j.blockedOn, 'dawn', 'and the blocker is the dark, which is a condition that provably clears')
})
t('LOOP A: homecomingPlan says STABILISE, not travel', () => {
  const p = S.homecomingPlan(THE_TREADMILL)
  assert.strictEqual(p.action, 'stabilise', 'get safe where you stand instead of marching')
  assert.strictEqual(p.blockedOn, 'dawn')
})
t('LOOP A: the same crossing IS admissible once the sun is up and the bot is armoured', () => {
  const day = Object.assign({}, THE_TREADMILL, { isNight: false, armorPieces: 4, underArmored: false, deathsRecent: 0 })
  const p = S.homecomingPlan(day)
  assert.strictEqual(p.action, 'travel', 'the stand-down must release itself - it is a wait, not a ban')
})
t('LOOP A: a DAYLIGHT crossing is still refused while the bot is spiralling and naked', () => {
  const day = Object.assign({}, THE_TREADMILL, { isNight: false })
  const j = S.journeyAdmissible(day, 486)
  assert.strictEqual(j.ok, false, '3+ deaths in 20 min + naked + far = the crossing IS the thing killing us')
  assert.strictEqual(j.blockedOn, 'anchor')
})
t('LOOP A: a SHORT hop is never blocked (no gate may ever leave the bot unable to act)', () => {
  for (const d of [0, 5, 16, 32]) {
    assert.strictEqual(S.journeyAdmissible(THE_TREADMILL, d).ok, true, `${d}b must stay allowed`)
  }
})
t('LOOP A: an ARMOURED bot may still cross at night (the rule is about being naked, not about the dark)', () => {
  const armoured = Object.assign({}, THE_TREADMILL, { armorPieces: 4, underArmored: false, deathsRecent: 0 })
  assert.strictEqual(S.journeyAdmissible(armoured, 486).ok, true)
})
t('LOOP A: eternal night lifts the gate (never wait for a dawn that will not come)', () => {
  const stuck = Object.assign({}, THE_TREADMILL, { nightStuck: true })
  assert.strictEqual(S.journeyAdmissible(stuck, 486).ok, true)
})

// ---- the homecoming CANDIDATE (it must exist, and must not steal a build) ----------------
t('LOOP A: a displaced bot gets a homecoming candidate, refused while the crossing is unsafe', () => {
  const c = core.chooseActivity(THE_TREADMILL, {})
  // Something must be chosen, and it must NOT be the lethal walk.
  assert.notStrictEqual(c.job, 'homecoming', 'the walk is refused while it is the thing killing us')
})
t('LOOP A: once safe, the displaced bot DOES choose to come home', () => {
  const safe = snap({ homeDist: 300, homeReachable: false, postDeathRecovery: true, spawnSuspect: true, isNight: false })
  const c = core.chooseActivity(safe, {})
  assert.strictEqual(c.job, 'homecoming', 'a healthy displaced bot crosses back - the stand-down is not a strand')
})
t('LOOP A: a bot far from home ON ITS OWN BUILD is never walked home off the job', () => {
  const building = snap({ homeDist: 460, activeJob: { name: 'autobuild', cls: 'progress' }, persistedBuild: true, isNight: false })
  const c = core.chooseActivity(building, { activeJob: 'autobuild', activeCls: 'progress' })
  assert.notStrictEqual(c.job, 'homecoming', 'being far from home on purpose is not displacement')
})

// ============ LOOP B - the recovery-ladder livelock ======================================
// 08:10-08:13: at home, night, naked, food falling 9 -> 8 -> 7. The ladder's own log for that
// window shows the plan it kept re-deriving: `R2 > R5` and `R5 > R2`, nothing else. R3 (the farm)
// and R4 (forage) were planned and barred by the dark; no grave was in the ladder's band. R2 walks
// to a home with no food and R5's "hold" returns instantly at food > 4 - so nothing the ladder
// could run was able to move its own exit condition (food >= 14). That is the livelock.
const THE_LIVELOCK = snap({
  hp: 20, food: 5, armorPieces: 0, underArmored: true, isNight: true,
  homeDist: 4, homeReachable: true, bankFoodPts: 0, packFoodPts: 0,
  farm: { exists: true }, graves: []
})

t('LOOP B: the livelock state names its blocker instead of returning "all rungs tried"', () => {
  const b = S.ladderBlocker(THE_LIVELOCK)
  assert.strictEqual(b, 'dawn', 'every rung that could produce food is barred by the dark - say so')
  assert(/night/i.test(S.blockerText(b)), 'and say it in words a human can act on')
})
t('LOOP B: an identical world produces an identical signature (so a re-run is provably pointless)', () => {
  assert.strictEqual(S.recoverySignature(THE_LIVELOCK), S.recoverySignature(Object.assign({}, THE_LIVELOCK)))
})
t('LOOP B: the signature CHANGES when dawn breaks - the stand-down releases itself', () => {
  const dawn = Object.assign({}, THE_LIVELOCK, { isNight: false })
  assert.notStrictEqual(S.recoverySignature(THE_LIVELOCK), S.recoverySignature(dawn))
})
t('LOOP B: the signature changes when food is gained, when armour is worn, and when a grave appears', () => {
  const base = S.recoverySignature(THE_LIVELOCK)
  assert.notStrictEqual(base, S.recoverySignature(Object.assign({}, THE_LIVELOCK, { food: 18 })), 'food gained')
  assert.notStrictEqual(base, S.recoverySignature(Object.assign({}, THE_LIVELOCK, { armorPieces: 4, underArmored: false })), 'armoured')
  assert.notStrictEqual(base, S.recoverySignature(Object.assign({}, THE_LIVELOCK, { graves: [{ dist: 10, value: 30, dangerous: false, hasGear: true }] })), 'a grave appeared')
  assert.notStrictEqual(base, S.recoverySignature(Object.assign({}, THE_LIVELOCK, { packFoodPts: 5 })), 'food in the pack')
})
t('LOOP B: the signature does NOT churn on a single point of food drift (that would re-open the spin)', () => {
  // 8 and 7 sit in the same bucket; the gate must not re-fire on noise.
  assert.strictEqual(S.recoverySignature(Object.assign({}, THE_LIVELOCK, { food: 5 })),
    S.recoverySignature(Object.assign({}, THE_LIVELOCK, { food: 4 })), 'same bucket -> same signature')
})
t('LOOP B: a REAL deterioration crosses a bucket and re-opens the ladder', () => {
  assert.notStrictEqual(S.recoverySignature(Object.assign({}, THE_LIVELOCK, { food: 7 })),
    S.recoverySignature(Object.assign({}, THE_LIVELOCK, { food: 2 })), 'falling to a worse bucket warrants a fresh attempt')
})
t('LOOP B: a refused ladder does NOT leave the bot idle - the chooser picks the next best thing', () => {
  const refused = new Map([['recoveryLadder', 'no progress and nothing has changed']])
  const c = core.chooseActivity(THE_LIVELOCK, { refused })
  assert(c, 'a verdict is always returned')
  assert.notStrictEqual(c.job, 'recoveryLadder', 'the refused job is not re-chosen')
  assert(/CRISIS UNANSWERED/.test(c.reason), 'and the log says a crisis is live but its producer declined')
})
t('LOOP B: with the ladder refused, sheltering is what the bot picks at night', () => {
  const refused = new Map([['recoveryLadder', 'blocked on dawn']])
  const c = core.chooseActivity(THE_LIVELOCK, { refused })
  assert.strictEqual(c.job, 'nightShelter', 'naked + dark + nothing else to do = go to bed, which is what ends the night')
})
// ==== THE TOTAL STANDOFF (found live 2026-07-29 22:15, hp 3.17, food 17) =================
//   (core) recoveryLadder REFUSED: last pass made no progress and nothing has changed since
//   (core) maintenancePass REFUSED: survival first: hp 3.1666 <= 6
//   (core) reclaim REFUSED: survival first: hp 3.1666 <= 6
//   (core) build/idle REFUSED: post-death recovery in progress
// ...repeated every two seconds, at three hearts, with a FULL food bar. A degraded state routes
// to the ladder; when the ladder is refused Phase A fell through to the utility phase, where
// recoverHp is not a candidate at all - so the need was 'heal', its producer existed, worked, and
// carried its own cooldown, and nothing on any path could reach it.
const THE_STANDOFF = snap({
  hp: 3.1666, food: 17, armorPieces: 0, underArmored: true, isNight: false,
  homeDist: null, postDeathRecovery: true, graves: []
})
t('STANDOFF: a refused ladder falls back to the NEED\'s own producer, not to idling', () => {
  const refused = new Map([['recoveryLadder', 'no progress'], ['maintenancePass', 'survival first'], ['reclaim', 'survival first'], ['build', 'post-death recovery']])
  const c = core.chooseActivity(THE_STANDOFF, { refused })
  assert.strictEqual(c.job, 'recoverHp', 'three hearts and a full food bar: heal. Got ' + c.job)
  assert(/ladder is refused/.test(c.reason), 'and the reason says which route it took and why')
})
t('STANDOFF: the fallback NEVER routes to an outbound producer while setting out is barred', () => {
  // this is the regression the LOOP B fixture caught before it shipped: naked + night + food 5,
  // the ladder blocked on 'dawn' precisely BECAUSE foraging out is the death - so falling back to
  // secureFood would have walked the bot into it.
  const refused = new Map([['recoveryLadder', 'blocked on dawn']])
  const c = core.chooseActivity(THE_LIVELOCK, { refused })
  assert.notStrictEqual(c.job, 'secureFood', 'a naked bot must not be routed out to forage at night')
  assert.strictEqual(c.job, 'nightShelter', 'the answer at night is shelter')
  // ...and the rule it asks is the SHARED one, not a copy
  assert.strictEqual(S.producerIsOutbound('secureFood'), true)
  assert.strictEqual(S.producerIsOutbound('recoverHp'), false)
  assert.strictEqual(S.outboundBlocked(THE_LIVELOCK), 'dawn')
})
t('STANDOFF: when even the producer is refused, the verdict is an HONEST standoff, not a lie', () => {
  const refused = new Map([['recoveryLadder', 'no progress'], ['recoverHp', 'cooling off'], ['maintenancePass', 'x'], ['reclaim', 'x'], ['build', 'x'], ['nightShelter', 'x']])
  const c = core.chooseActivity(THE_STANDOFF, { refused })
  assert(c.standoff, 'it must SAY every candidate refused')
  assert(Array.isArray(c.refusals) && c.refusals.length > 0, 'and name them')
})

t('LOOP B: a ladder with a REACHABLE food producer is not blocked at all', () => {
  const day = Object.assign({}, THE_LIVELOCK, { isNight: false, armorPieces: 4, underArmored: false })
  assert.strictEqual(S.ladderBlocker(day), 'no-progress', 'by day with armour the food rungs are admissible')
})
t('LOOP B: with NOTHING in the world that could supply food, the blocker says so honestly', () => {
  const barren = Object.assign({}, THE_LIVELOCK, { isNight: false, armorPieces: 4, underArmored: false, farm: { exists: false } })
  // secureFood (forage) is always planned, so a truly barren state is 'no-progress', not silence -
  // what matters is that it is NAMED rather than reported as "all rungs tried".
  assert(['no-progress', 'no-producer'].indexOf(S.ladderBlocker(barren)) !== -1)
})

// ============ the "one rule, one definition" invariant ====================================
t('INVARIANT: rungFeasible and journeyAdmissible agree - they share outboundBlocked', () => {
  const naked = snap({ underArmored: true, isNight: true, armorPieces: 0 })
  const rung = { rung: 'R4', action: 'secureFood(hunt->fish->scout)' }
  assert.strictEqual(S.rungFeasible(rung, naked), false, 'the rung is barred')
  assert.strictEqual(S.journeyAdmissible(naked, 200).ok, false, 'and so is the equivalent journey')
  assert.strictEqual(S.outboundBlocked(naked), 'dawn', 'because ONE function says so, for both')
})
t('INVARIANT: an armoured daylight bot is blocked by neither', () => {
  const fine = snap({ isNight: false, armorPieces: 4, underArmored: false })
  assert.strictEqual(S.outboundBlocked(fine), null)
  assert.strictEqual(S.rungFeasible({ rung: 'R4', action: 'secureFood(hunt->fish->scout)' }, fine), true)
  assert.strictEqual(S.journeyAdmissible(fine, 400).ok, true)
})
t('INVARIANT: RESILIENT_RECOVERY=0 keeps the old night-only rule (rollback is still honest)', () => {
  withEnv('RESILIENT_RECOVERY', '0', () => {
    const dayNaked = snap({ isNight: false, armorPieces: 0, underArmored: true, bankArmorPieces: 4, bankHasPick: true, bankHasSword: true })
    assert.strictEqual(S.outboundBlocked(dayNaked), null, 'flag off -> only night blocks')
  })
})

// ============ FIX 5 - a failed read is not a fact =========================================
// Every pure predicate defaults a missing vital to 20, so a snapshot whose vitals read FAILED
// used to be indistinguishable from a perfectly healthy bot. Demonstrated 2026-07-29: with hp and
// food absent, jobSurvivalNeed returned null, isDegraded was false, and a 500-block crossing came
// back "clear to travel".
const BLIND = snap({ hp: undefined, food: undefined, vitalsKnown: false, homeDist: 500, armorPieces: 0, underArmored: true })
delete BLIND.hp; delete BLIND.food

t('FIX 5: a bot that cannot read its own vitals does NOT set out across open ground', () => {
  const j = S.journeyAdmissible(BLIND, 500)
  assert.strictEqual(j.ok, false)
  assert.strictEqual(j.blockedOn, 'vitals')
})
t('FIX 5: ...but a SHORT hop stays allowed (blindness must never immobilise the body)', () => {
  assert.strictEqual(S.journeyAdmissible(BLIND, 20).ok, true)
})
t('FIX 5: a blind bot does not get to call itself "recovered"', () => {
  const r = S.recoveryReady(Object.assign({}, BLIND, { tools: { pick: true, sword: true } }))
  assert.strictEqual(r.ready, false, 'clearing the post-death latch is a claim about vitals nobody read')
  assert.strictEqual(r.maxCaution, true)
})
t('FIX 5: a SIGHTED snapshot is completely unaffected', () => {
  const ok = snap({ hp: 20, food: 20, vitalsKnown: true, armorPieces: 4, underArmored: false, homeDist: 500, tools: { pick: true, sword: true } })
  assert.strictEqual(S.journeyAdmissible(ok, 500).ok, true)
  assert.strictEqual(S.recoveryReady(ok).ready, true)
})
t('FIX 5: the snapshot can REPRESENT an unknown - vitals survive a scan failure', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'survival-snapshot.js'), 'utf8')
  assert(/s\.unknown\.push\(/.test(src), 'failed reads are recorded in s.unknown, not hidden')
  assert(/read FAILED:/.test(src), 'and every one of them is logged with the field name')
  assert(/s\.hp = bot\.health; s\.food = bot\.food/.test(src), 'a scan failure re-reads vitals direct from the body')
  assert(!/onFire: false,/.test(src), 'onFire is measured, not hardcoded false')
})

// ============ FIX 19 - the decision cadence must scale with lethality =====================
// Live 2026-07-29 18:40:37 -> 18:40:48: fell to hp 1, died to a second fall ELEVEN seconds later,
// having made no deliberate decision in between - the tick reschedules at a flat 15s +/- 3s, and
// the 8s HP_CRISIS reflex that used to cover this is disabled under SCHEDULER.
t('FIX 19: a calm bot keeps the cheap cadence', () => {
  assert.strictEqual(S.tickDelayMs({ hp: 20, food: 20 }), S.TICK_CALM_MS)
})
t('FIX 19: at hp 1 the bot may think every couple of seconds, not every 18', () => {
  assert.strictEqual(S.tickDelayMs({ hp: 1, food: 20 }), S.TICK_CRISIS_MS)
  assert(S.TICK_CRISIS_MS * 5 < 11000, 'the live window was 11s - a crisis tick must fit several times over')
})
t('FIX 19: drowning/lava/fire are crisis cadence regardless of hp', () => {
  assert.strictEqual(S.tickDelayMs({ hp: 20, food: 20, drowning: true }), S.TICK_CRISIS_MS)
  assert.strictEqual(S.tickDelayMs({ hp: 20, food: 20, inLava: true }), S.TICK_CRISIS_MS)
  assert.strictEqual(S.tickDelayMs({ hp: 20, food: 20, onFire: true }), S.TICK_CRISIS_MS)
})
t('FIX 19: hurt-or-hunted gets the middle cadence', () => {
  assert.strictEqual(S.tickDelayMs({ hp: 9, food: 20 }), S.TICK_ALERT_MS)
  assert.strictEqual(S.tickDelayMs({ hp: 20, food: 20, threatDist: 4 }), S.TICK_ALERT_MS)
  assert.strictEqual(S.tickDelayMs({ hp: 20, food: 20, creeperDist: 10 }), S.TICK_ALERT_MS)
})
t('FIX 19: starving is crisis cadence (food 0-2 kills as surely as damage)', () => {
  assert.strictEqual(S.tickDelayMs({ hp: 20, food: 1 }), S.TICK_CRISIS_MS)
})
t('FIX 19: UNMEASURED vitals do not manufacture a crisis (they keep the calm rate)', () => {
  assert.strictEqual(S.tickDelayMs({}), S.TICK_CALM_MS)
})
t('FIX 19: the tick actually USES it, and does not jitter a crisis', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8')
  assert(/scheduler\.tickDelayMs\(/.test(src), 'the reschedule consults the pure cadence fn')
  assert(!/setTimeout\(tick, 15000 \+ \(Math\.random/.test(src), 'the flat 15s reschedule is gone')
  assert(/delay >= scheduler\.TICK_CALM_MS\) delay \+=/.test(src), 'jitter applies to the calm cadence only')
})

// ============ FIX 21 - a near-miss is evidence too ========================================
// Measured live 2026-07-29: the bot went under water 40 times; SEVENTEEN of those were during a
// drown-escape - it climbed out of a pocket and walked straight back in. It escaped successfully
// 55 times and remembered none of them, because the hazard ledger only ever learned from DEATHS.
{
  const gp = require('./grave-policy.js')
  const miss = { x: 10, y: 62, z: 10, cause: 'drowning', deaths: [], misses: [1, 2] }
  const twoDeaths = { x: 20, y: 62, z: 20, cause: 'drowning', deaths: [1, 2], traversedSinceDeath: false }
  t('FIX 21: a survived near-miss prices the route', () => {
    assert(gp.hazardStepCost({ x: 10, y: 62, z: 10 }, 'water', [miss]) > 0, 'A* must bend around a pocket that nearly drowned us')
  })
  t('FIX 21: ...and costs nothing anywhere else', () => {
    assert.strictEqual(gp.hazardStepCost({ x: 200, y: 62, z: 200 }, 'water', [miss]), 0)
  })
  t('FIX 21: a near-miss can NEVER harden into a wall (surviving must not close terrain)', () => {
    assert.strictEqual(gp.hazardHardArmed(miss), false)
  })
  t('FIX 21: two real DEATHS still harden, exactly as before', () => {
    assert.strictEqual(gp.hazardHardArmed(twoDeaths), true)
  })
  t('FIX 21: only a NON-TRIVIAL escape is recorded (55/session would be noise, not memory)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'navigate.js'), 'utf8')
    assert(/rungsUsed > 1 \|\| Date\.now\(\) - startedAt > 3000/.test(src), 'one rung and out is ordinary swimming')
    assert(/recordHazardMiss\(entryPos, 'drowning'\)/.test(src), 'the ENTRY cell is what gets remembered')
  })
}

// ============ FIX 22 - a declared hold must say it is alive ===============================
// The exact live chain, 2026-07-29 19:20-19:24: `shelter: pit SEALED` -> watchdog NUDGE at 45s ->
// FAIL-JOB at 90s -> tick re-arm -> `position FROZEN ~195s - forcing an escape` -> climbed out of
// its own sealed pit into the dark -> killed by a creeper. The bot did the right thing and the
// forward-progress watchdog dug it out to die. Sitting still until dawn IS the goal.
// FIX 22 shipped a HEARTBEAT: the hold faked forward progress every 3s so the watchdog left it
// alone. That worked and was still the wrong shape - every hold had to REMEMBER to do it (this
// one had not, for its entire existence), and it claimed progress that never happened. It is a
// DECLARED hold now (PLAN-one-runner S4): the waiter names its wake once and both watchdogs read
// that single declaration, whoever called it.
t('FIX 22: every waiting loop DECLARES its hold - no loop fakes progress any more', () => {
  const shelterSrc = require('fs').readFileSync(require('path').join(__dirname, 'provision-shelter.js'), 'utf8')
  const recSrc = require('fs').readFileSync(require('path').join(__dirname, 'provision-recovery.js'), 'utf8')
  assert(/reflexes\.beginHold\('nightShelter:pit'/.test(shelterSrc), 'digInForNight must declare its hold while it waits out the night')
  assert(/reflexes\.beginHold\('boundedHold'/.test(recSrc), 'the famine hold declares itself too')
  assert(!/touchP\('nightShelter:hold'\)/.test(shelterSrc), 'the per-hold heartbeat is DELETED, not merely supplemented')
  assert(!/touchP\('boundedHold'\)\s/.test(recSrc), 'and so is its precedent')
  // both release exactly once, on the way out, even when the loop returns from inside
  assert(/finally \{ reflexes\.endHold\(holdToken\)/.test(shelterSrc), 'the shelter hold is released in a finally')
  assert(/finally \{ reflexes\.endHold\(holdToken\)/.test(recSrc), 'the famine hold is released in a finally')
})
t('FIX 22: the declared hold still sits around a loop that re-checks the world', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'provision-shelter.js'), 'utf8')
  const i = src.indexOf("reflexes.beginHold('nightShelter:pit'")
  const after = src.slice(i, i + 1400)
  // Declaring a hold must not mask a real hang: the loop body still breaks on every named wake.
  assert(/isNight\(bot\)/.test(after), 'still breaks at dawn')
  assert(/bot\.health/.test(after), 'still breaks when taking damage')
  assert(/inWaterNow\(bot\)/.test(after), 'still breaks when the pit floods')
})
t('FIX 22: BOTH watchdogs read the one declaration', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8')
  // the forward-progress watchdog (which FAIL-JOBbed the ladder at 90s)...
  assert(/const hold = reflexes\.activeHold\(/.test(src), 'the S7 watchdog consults the declared hold')
  // ...and the position-freeze watchdog, which is the one that actually dug the bot out at 195s
  const wedgeLine = src.split('\n').find(l => /wdHist = \[\]; return \}/.test(l)) || ''
  assert(/reflexes\.activeHold\(/.test(wedgeLine), 'the hard-wedge watchdog stands down for a declared hold')
  // 2026-07-31: a hold now also DECLARES its premise and the RUNNER resolves it (reflexes may not
  // read the body - invariant 2). BOTH watchdogs must pass that resolver, and it must be the SAME
  // one - otherwise a hold whose premise is false keeps vouching for stillness to one of them.
  // nightShelter claimed "resting until dawn" while stuck 31 blocks underground, and the bot sat
  // in a mineshaft for half an hour.
  assert(/const hold = reflexes\.activeHold\(holdPremiseOK\)/.test(src), 'the S7 watchdog must RESOLVE the premise, not trust it blindly')
  assert(/reflexes\.activeHold\(holdPremiseOK\)/.test(wedgeLine), 'the hard-wedge watchdog must resolve it with the SAME resolver')
  assert.strictEqual((src.match(/const holdPremiseOK =/g) || []).length, 1, 'exactly ONE definition of the premise resolver - two copies is how the watchdogs drift apart')
  // ...and it must be declared at MODULE SCOPE. Shipped 2026-07-31 declared at brace depth 1, so
  // the wedge watchdog - in a different branch of the tree - threw
  //   ReferenceError: holdPremiseOK is not defined   at index.js:2015
  // every time its 5s timer fired. The process died, run.js restarted it, and the bot rejoined
  // the server every ~18 seconds for half an hour. `node --check` passes (the SYNTAX is valid) and
  // all 58 offline suites passed (none of them fire that timer), and the source pin above matched
  // the TEXT `activeHold(holdPremiseOK)` without ever asking whether the NAME RESOLVES.
  // A brace-depth check is the cheap version of that question.
  {
    const lines = src.split('\n')
    let depth = 0; let inStr = null; let inCom = false; let declDepth = null
    for (const line of lines) {
      if (/^const holdPremiseOK =/.test(line) && declDepth === null) declDepth = depth
      for (let j = 0; j < line.length; j++) {
        const c = line[j]; const n = line[j + 1]
        if (inCom) { if (c === '*' && n === '/') { inCom = false; j++ } continue }
        if (inStr) { if (c === '\\') { j++; continue } if (c === inStr) inStr = null; continue }
        if (c === '/' && n === '/') break
        if (c === '/' && n === '*') { inCom = true; j++; continue }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
        if (c === '{') depth++; else if (c === '}') depth--
      }
    }
    assert.strictEqual(declDepth, 0, 'holdPremiseOK must be declared at MODULE scope (found brace depth ' + declDepth + ') - both watchdogs live in different scopes and a nested declaration is a ReferenceError in whichever one cannot see it')
  }
  // ...and the ceiling clause must be DEPTH-BOUNDED. A bare hasSolidCeiling is trivially true in
  // any mine, so the bot kept claiming "sheltering until dawn" at y37 - 31 blocks under its own
  // hut - even after the premise landed. A sealed night pit is a ceiling NEAR THE SURFACE.
  const resolver = src.slice(src.indexOf('const holdPremiseOK ='), src.indexOf('if (WATCHDOG_ON)'))
  assert(/hasSolidCeiling/.test(resolver), 'the sealed-pit case must still be vouched for (2026-07-29)')
  assert(/surfaceYAt/.test(resolver), 'the ceiling only counts near the SURFACE - a mine roof is not shelter')
  assert(!/hasSolidCeiling\(bot, 4\)\) return true/.test(resolver), 'a bare ceiling test is back - every mine reads as shelter')
})

// ============ LOOP C - a decision must produce an action ==================================
t('LOOP C: every survival job the chooser can pick has an executor that can run it', () => {
  // The tick used to be an exhaustive if/else over four names; nightShelter fell through to a log
  // line and homecoming did not exist. Then it became an if/else over six, which is the same
  // shape one incident later. It is a TABLE now (bot/reflexes.js), so this asks the table -
  // enumerable data - instead of grepping index.js for a branch that must be spelled just so.
  const reflexes = require('./reflexes.js')
  for (const job of ['graveSweep', 'secureFood', 'recoverHp', 'nightShelter', 'recoveryLadder', 'homecoming']) {
    const p = reflexes.get(job)
    assert(p, `the registry has no row for ${job} - the chooser can pick a job nothing can run`)
    assert(typeof p.run === 'function', `${job} is registered but has no executor`)
  }
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8')
  assert(/NOTHING in the registry can run it - nothing dispatched/.test(src), 'and an unhandled pick must be LOUD, not silent')
})
t('LOOP C: every rung recoveryPlan can PLAN has an executor that can RUN it', () => {
  // The orchard rung was planned by recoveryPlan from S5 onward and never had an executor, so
  // `if (!RUNG_EXECUTORS[r.action]) continue` skipped it on every pass - a food source the bot
  // plants, remembers and cannot eat from. A planned-but-unexecutable rung is a silent hole.
  const { RUNG_EXECUTORS } = require('./provision-recovery.js')
  const shapes = [
    snap({ hp: 5, food: 4, homeDist: 10, farm: { exists: true }, orchard: { dist: 40 }, packFoodPts: 2, armorPieces: 2, bankArmorPieces: 4, bankHasPick: true, bankHasSword: true }),
    snap({ hp: 20, food: 5, homeDist: 300, isNight: true, armorPieces: 0, underArmored: true }),
    snap({ hp: 2, food: 0, homeDist: 5, farm: { exists: true }, graves: [{ dist: 8, value: 40, dangerous: false, hasGear: true }] })
  ]
  for (const s of shapes) {
    for (const r of S.recoveryPlan(s)) {
      assert(RUNG_EXECUTORS[r.action], `recoveryPlan can plan "${r.action}" but nothing can execute it`)
    }
  }
})
t('LOOP C: nightShelter is dispatched, not logged-and-dropped', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8')
  assert(!/nightShelter - reflex-owned in S4, holding/.test(src), 'the "reflex-owned, holding" no-op is gone')
  const shelterSrc = String(require('./reflexes.js').get('nightShelter').run)
  assert(/provRecovery\(\)\.nightRest\(bot,/.test(shelterSrc), 'it calls the real shelter executor - through provision-recovery, its OWNER, not the facade')
  // ...and there is exactly ONE nightShelter actor now. The 5s reflex that used to race the tick
  // through eight private guards is DELETED, not merely gated (PLAN-one-runner S5).
  assert(!/process\.env\.NIGHT_SHELTER/.test(src), 'the rival night-shelter timer is gone from index.js')
  assert(!/nightRest\(bot, \{ say: m => bot\.chat/.test(src), 'and so is its call into the shelter executor')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall death-loop regression tests passed')
process.exit(fails ? 1 : 0)
