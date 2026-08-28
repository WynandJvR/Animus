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
  // 2026-08-27: ...when the deaths were ON THE WAY. Seven deaths at the respawn point itself are
  // not evidence about the road: with deathsAway 0 the daylight crossing is admissible.
  const atTheDoor = Object.assign({}, day, { deathsAway: 0 })
  assert.strictEqual(S.journeyAdmissible(atTheDoor, 486).ok, true, 'spawn-night deaths do not bar the daylight crossing')
  const onTheRoad = Object.assign({}, day, { deathsAway: 3 })
  assert.strictEqual(S.journeyAdmissible(onTheRoad, 486).blockedOn, 'anchor', 'three deaths on the way still do')
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
  // WAS: assert(/CRISIS UNANSWERED/.test(c.reason)). That assertion pinned a LIE, and the live log
  // paid for it 847 times in a day: here the ladder is refused and the chooser answers the crisis
  // with nightShelter - a real survival action, dispatched - while the reason line shouted that the
  // crisis was unanswered. 353 of the 847 were this shape (the chosen job was not even the build
  // fallback). Under §3.3 the line means exactly one thing: nobody answered. So the behaviour this
  // test was bought to protect - a refused ladder never leaves the bot idle - is asserted directly.
  assert.strictEqual(c.cls, 'survival', 'the crisis still gets a survival-class answer. Got ' + c.job)
  assert(!/CRISIS UNANSWERED/.test(c.reason), 'and a crisis that IS answered must not be logged as unanswered: ' + c.reason)
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
t('FIX 22: the ONE watchdog reads the one declaration - and nothing else can dig a hold out', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8')
  const nav = require('fs').readFileSync(require('path').join(__dirname, 'navigate.js'), 'utf8')
  // the forward-progress watchdog (which FAIL-JOBbed the ladder at 90s)...
  assert(/const hold = reflexes\.activeHold\(/.test(src), 'the S7 watchdog consults the declared hold')
  // ...and the position-freeze watchdog that dug the bot out at 195s is GONE, not guarded.
  const code = src.replace(/^\s*\/\/.*$/gm, '') // the tombstones quote both names on purpose; the ban is on the CODE
  assert(!/position FROZEN/.test(code), 'the freeze watchdog stays deleted - a tombstone comment is fine, a timer is not')
  assert(!/WEDGE_WATCHDOG/.test(code), 'and its flag with it')
  // The one rescue path that CAN move the body physically stands down for a declared hold.
  assert(/opts\.holdOK \? opts\.holdOK\(\) : null/.test(nav) && /verdict: 'held'/.test(nav),
    'unstick stands down for a hold its caller vouches for - stillness can be the goal')
  // 2026-07-31: a hold now also DECLARES its premise and the RUNNER resolves it (reflexes may not
  // read the body - invariant 2). BOTH watchdogs must pass that resolver, and it must be the SAME
  // one - otherwise a hold whose premise is false keeps vouching for stillness to one of them.
  // nightShelter claimed "resting until dawn" while stuck 31 blocks underground, and the bot sat
  // in a mineshaft for half an hour.
  assert(/const hold = reflexes\.activeHold\(holdPremiseOK\)/.test(src), 'the S7 watchdog must RESOLVE the premise, not trust it blindly')
  assert(/holdOK: \(\) => \{[^}]*reflexes\.activeHold\(holdPremiseOK\)/.test(src),
    'the runner hands the SAME resolver to the terminal action, which is now the only layer that can move a holding body')
  const rfx = require('fs').readFileSync(require('path').join(__dirname, 'reflexes.js'), 'utf8')
  assert(/holdOK: ctx\.holdOK/.test(rfx), 'and the terminal action passes it into the rescue instead of trusting every hold')
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

// ============ LOOP D - THE GEARUP TREK (measured 2026-08-02 18:43-18:47 local) ============
// The same defect outboundBlocked's own comment describes, arriving from the other direction.
// From logs/state-history.jsonl, four consecutive lives inside four minutes:
//   18:43:45 activity=gearup armor=0 isDay=FALSE pos 191,-104 hp 20  (home is 188,-104)
//   18:44:40                              pos 254,-161 hp 0.2 -> killed by a Zombie
//   ...respawn, set out again, die at 216,-150; again, 203,-72; again, 141,-78.
// `gearup` is the journey an unarmoured bot makes to FIND armour. It is not a ladder rung and not
// a scheduler dispatch - it is commands.js `armorup`, whose only abort was `buildAbort` - so the
// hp abort (food.outboundRungAdmissible, one caller: the ladder) and the crossing hp floor
// (journeyAdmissible, one caller: the homecoming) both existed and neither was ever asked.
const THE_GEARUP_TREK = snap({
  hp: 2.3, food: 15, armorPieces: 0, underArmored: true, isNight: true,
  homeDist: 90, homeReachable: true, deathsRecent: 3, postDeathRecovery: true
})

t('LOOP D: an hp-2 bot is NOT fit to be out - and that verdict no longer belongs to the ladder alone', () => {
  const a = S.outboundAdmissible(THE_GEARUP_TREK)
  assert.strictEqual(a.ok, false, 'two hearts, 90b out, naked, at night')
  assert.strictEqual(a.blockedOn, 'heal', 'and the blocker names the producer that clears it (needProducer -> recoverHp)')
  assert.strictEqual(S.needProducer(a.blockedOn), 'recoverHp', 'a blocker with an owner, not a bare refusal (#5)')
})

t('LOOP D: the hp clause fires on its OWN, with no help from the armour/dark clause', () => {
  // isolate it: fully armoured, broad daylight, so outboundBlocked provably returns null and the
  // ONLY thing that can refuse is the hp abort that used to govern ladder rungs and nothing else.
  const hurtButArmoured = snap({ hp: 4, armorPieces: 4, underArmored: false, isNight: false })
  assert.strictEqual(S.outboundBlocked(hurtButArmoured), null, 'the dark rule has nothing to say here')
  assert.strictEqual(S.outboundAdmissible(hurtButArmoured).ok, false, 'and the hp rule still stops the trek')
  assert.strictEqual(S.outboundAdmissible(snap({ hp: 7, armorPieces: 4, underArmored: false })).ok, true, 'hp 7 is above the line - work carries on')
})

t('LOOP D INVARIANT: journeyAdmissible and the ladder rung ask ONE function for the hp abort', () => {
  const hurt = snap({ hp: 3, food: 20, armorPieces: 4, underArmored: false })
  const j = S.journeyAdmissible(hurt, 400)
  const o = S.outboundAdmissible(hurt)
  assert.strictEqual(j.ok, false)
  assert.strictEqual(j.blockedOn, o.blockedOn, 'same blocker')
  assert.strictEqual(j.why, o.why, 'same words, because it is the same call')
  // MUTATION CHECK: restore the hand-written `hp <= JOURNEY_HP_FLOOR` copy and this fails.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'scheduler.js'), 'utf8')
  assert(!/process\.env\.JOURNEY_HP_FLOOR/.test(src), 'the duplicate flag is READ nowhere - it is deleted, not renamed (the name survives only in the comment that records why)')
  assert(/foodSec\.outboundRungAdmissible/.test(src), 'and the one definition is delegated to, not copied')
})

t('LOOP D: the FOOD_FLOOR fishing carve-out stays CALLER-scoped - a starving rung may go, a crossing may not', () => {
  const starving = snap({ hp: 1, food: 0, armorPieces: 4, underArmored: false })
  assert.strictEqual(S.outboundAdmissible(starving, { food: 0 }).ok, true,
    'the ladder passes food ONLY for the secureFood rung: one bounded fishing trip beats sitting at hp1/food0 forever')
  assert.strictEqual(S.outboundAdmissible(starving).ok, false, 'every other caller passes nothing and gets the plain hp abort')
  assert.strictEqual(S.journeyAdmissible(starving, 400).ok, false, 'so a 400-block crossing at one heart is still refused')
})

t('LOOP D: the ARMORUP EXCURSION asks the rule - it is the journey, and it had no abort but buildAbort', () => {
  const cmd = require('fs').readFileSync(require('path').join(__dirname, 'commands.js'), 'utf8')
  const i = cmd.indexOf("case 'gearup': {")
  assert(i > 0, 'the armorup/gearup case still exists')
  const body = cmd.slice(i, cmd.indexOf("case 'huttidy'", i))
  assert(/outboundAdmissible/.test(body), 'the excursion asks the ONE rule')
  // MUTATION CHECK: put `isStopped: () => buildAbort` back on either driver and this fails.
  assert(!/isStopped: \(\) => buildAbort/.test(body),
    'neither the planner nor the bootstrap driver may be handed the bare build latch any more - ' +
    'that latch means "a build preempted me", never "I am dying"')
  assert((body.match(/isStopped: gearupStopped/g) || []).length === 3, 'all THREE drivers (the wooden-sword-first acquire, planner.gearUp and provisionArmor) get the composed stop, never the bare build latch') // 2026-08-28: +1 for the arm-first sword craft
})

t('LOOP D: the outbound-PRODUCER route asks the whole question, not half of it', () => {
  const core2 = require('fs').readFileSync(require('path').join(__dirname, 'scheduler-core.js'), 'utf8')
  assert(/scheduler\.outboundAdmissible\(s\)\.ok/.test(core2), 'the producer fallback asks the composed rule')
  assert(!/producerIsOutbound\(producer\) && !!scheduler\.outboundBlocked\(s\)/.test(core2),
    'MUTATION CHECK: restore the armour/dark-only test and this fails')
  // ...and the LOOP B behaviour it already guaranteed is unchanged.
  const refused = new Map([['recoveryLadder', 'blocked on dawn']])
  assert.strictEqual(core.chooseActivity(THE_LIVELOCK, { refused }).job, 'nightShelter')
})

// ============ LOOP E - THE EXCURSION THAT NEVER CAME HOME (measured 2026-08-02) ============
// Six hours of uptime and NOTHING to show for it: inventory [], armor 0/4, the bank chest at
// 192,68,-103 empty, buildProgress null. Not a hang - the bot simply was never at home to use
// its own infrastructure. From logs/bot-events.log, the same four lines every night:
//   (sched) pick=recoverHp reason="crisis: hp 8.97 <= 10 while night" | armor=0 home=108b
//   [prov] nightRest: bed too far (108 > 32) - pitting here
//   (auto-eat) ate rotten_flesh (food 20)
// Its farm (41 registered cells), bed, chest and furnace were all at home ~188,-104.
//
// THE ROOT, the same defect a third time: three rules govern any journey, and the third was
// still single-caller. journeyAdmissible's every caller is INBOUND - the homecoming candidate
// (scheduler-core B1b), recoverHome and recoverSpawnAnchor (via crossingAdmissible) and
// homecomingPlan - so the rule that says "this crossing is too far" had never been asked by a
// journey walking AWAY. Nothing leashed how far the gearup/gather excursions went.
const THE_LONG_AFTERNOON = snap({
  hp: 18, food: 14, armorPieces: 0, underArmored: true, isNight: false,
  homeDist: 108, homeReachable: false, timeOfDay: 10000, packFoodPts: 20
})

t('LOOP E: the leash is a CONDITION - it shrinks with the daylight, it is not a radius', () => {
  const at = tod => S.homeLeash(snap({ timeOfDay: tod }))
  assert(at(0) > at(6000), 'dawn allows further out than noon (' + Math.round(at(0)) + ' vs ' + Math.round(at(6000)) + ')')
  assert(at(6000) > at(10000), 'noon further than mid-afternoon')
  assert(at(10000) > at(11500), 'and it keeps closing as the sun goes down')
  assert(at(11500) > at(12500), 'right through dusk')
  // ...and past the deadline it is EXACTLY the range the shelter code will walk to the bed.
  const shelter = require('./shelter.js')
  assert.strictEqual(at(12500), shelter.BED_TREK_RANGE, 'at dusk the leash IS the bed trek range')
  assert.strictEqual(at(15000), shelter.BED_TREK_RANGE, 'and it stays there all night')
  // MUTATION CHECK: hard-code 32 (or any radius) into homeLeash and the ramp assertions above fail;
  // return a constant leash and every > comparison fails.
})

t('LOOP E: the leash is DERIVED - from the shelter deadline, the bed range and the trek budget', () => {
  const shelter = require('./shelter.js')
  const pace = S.TREK_LEG_BLOCKS / (S.TREK_LEG_DEADLINE_MS / 1000)
  const expect = tod => shelter.BED_TREK_RANGE + ((shelter.SHELTER_TOD - tod) / 20) * pace
  assert.strictEqual(S.homeLeash(snap({ timeOfDay: 10000 })), expect(10000), 'no third invented number')
  assert.strictEqual(S.homeLeash(snap({ timeOfDay: 6000 })), expect(6000))
  // MUTATION CHECK: change any of the three sources and this fails, because the leash is computed
  // from those exact three and nothing else.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'scheduler.js'), 'utf8')
  assert(/shelterTiming\.BED_TREK_RANGE/.test(src) && /shelterTiming\.SHELTER_TOD/.test(src),
    'the deadline and the arrival radius are READ from shelter.js, not re-typed here')
})

t('LOOP E: #10 - with no clock reading there is no deadline, so no leash is invented', () => {
  assert.strictEqual(S.homeLeash(snap({ timeOfDay: undefined })), Infinity, 'unmeasured is not unmet')
  assert.strictEqual(S.homeLeash(snap({ timeOfDay: undefined, isNight: true })), require('./shelter.js').BED_TREK_RANGE,
    '...but a different sensor saying it is dark PROVES the deadline has passed')
})

t('LOOP E: THE MEASURED CASE - 108b out in the afternoon is refused, and the refusal GOES HOME', () => {
  const a = S.excursionAdmissible(THE_LONG_AFTERNOON)
  assert.strictEqual(a.ok, false, '108b out at t=10000 is past the leash (' + Math.round(S.homeLeash(THE_LONG_AFTERNOON)) + 'b)')
  assert.strictEqual(a.stage, 'leash', 'and it is the LEASH that stopped it, not the crossing rule')
  assert.strictEqual(a.returnHome, true, '#5: the leash is the last moment the walk home still fits - so take it')
  assert.strictEqual(a.blockedOn, 'home')
  // ...and earlier in the same day, at the same spot, it is allowed to be out there.
  assert.strictEqual(S.excursionAdmissible({ ...THE_LONG_AFTERNOON, timeOfDay: 4000 }).ok, true,
    'the leash recalls the bot by the CLOCK, it does not fence it in')
})

t('LOOP E: a naked bot far out AT NIGHT stands down - it is not marched home through the dark', () => {
  // Both clauses refuse here. The order matters: marching 108b naked in the dark is the exact
  // 2026-07-20 carousel, so the crossing rule wins and the scheduler shelters where the bot stands.
  const night = { ...THE_LONG_AFTERNOON, isNight: true, timeOfDay: 15000 }
  const a = S.excursionAdmissible(night)
  assert.strictEqual(a.ok, false)
  assert.strictEqual(a.stage, 'crossing', 'the crossing rule is asked BEFORE the leash')
  assert.strictEqual(a.blockedOn, 'dawn', 'and its blocker is the dark - a condition that provably clears')
  assert.strictEqual(a.returnHome, false, 'NOTHING walks this bot home tonight')
})

t('LOOP E: the excursion finally asks the DISTANCE rule - same call, same blocker, same words', () => {
  const spiral = snap({ hp: 20, food: 20, armorPieces: 0, underArmored: true, isNight: false,
    homeDist: 300, timeOfDay: 0, deathsRecent: 4 })
  const j = S.journeyAdmissible(spiral, 300)
  const e = S.excursionAdmissible(spiral)
  assert.strictEqual(j.ok, false, 'four deaths and a 300b naked crossing is the spiral clause')
  assert.strictEqual(e.ok, false, 'and the excursion inherits it now that it asks')
  assert.strictEqual(e.blockedOn, j.blockedOn, 'same blocker, because it is the same function')
  assert(e.why.startsWith(j.why), 'same words')
  // MUTATION CHECK: drop the journeyAdmissible call from excursionAdmissible and this fails -
  // the leash alone would pass this fixture (t=0 leash is ~420b).
  assert(S.homeLeash(spiral) > 300, 'proof that only the crossing clause can be refusing here')
})

t('LOOP E: NO DEADLOCK - gearing up at your own door is always legal, naked, at night', () => {
  const atHome = snap({ hp: 20, food: 20, armorPieces: 0, underArmored: true, isNight: true,
    timeOfDay: 15000, homeDist: 12, bankArmorPieces: 4 })
  assert.strictEqual(S.excursionAdmissible(atHome).ok, true,
    'journeyAdmissible SHORT_HOP keeps close work admissible - the armour clause must never bar the ' +
    'one journey an unarmoured bot makes at every distance')
  // ...and the hp clause still bites at EVERY distance, including underfoot.
  assert.strictEqual(S.excursionAdmissible({ ...atHome, hp: 3 }).ok, false, 'three hearts is three hearts at any range')
  assert.strictEqual(S.excursionAdmissible({ ...atHome, hp: 3 }).stage, 'fit')
  assert.strictEqual(S.excursionAdmissible({ ...atHome, hp: 3 }).returnHome, false,
    'a hurt bot heals where it stands - the scheduler owns that, not a walk')
})

t('LOOP E: no home anchor -> nothing to be leashed to (never strands a homeless bot)', () => {
  assert.strictEqual(S.excursionAdmissible(snap({ homeDist: null, timeOfDay: 15000, isNight: true })).ok, true)
})

t('LOOP E WIRING: BOTH excursions ask the one poll, and neither carries the bare build latch', () => {
  const cmd = require('fs').readFileSync(require('path').join(__dirname, 'commands.js'), 'utf8')
  assert(/function makeExcursionStop \(bot, label\)/.test(cmd), 'there is ONE excursion stop-poll')
  assert(/excursionAdmissible\(require\('\.\/survival-snapshot\.js'\)\.excursionState\(bot\)\)/.test(cmd),
    'and it asks the ONE composed verdict against the sync journey snapshot')
  const gearBody = cmd.slice(cmd.indexOf("case 'gearup': {"), cmd.indexOf("case 'huttidy'"))
  const gathBody = cmd.slice(cmd.indexOf("case 'gather': {"), cmd.indexOf("case 'provision': {"))
  assert(/makeExcursionStop\(bot, 'gearup'\)/.test(gearBody), 'gearup uses it')
  assert(/makeExcursionStop\(bot, 'gather'\)/.test(gathBody), 'gather - which treks just as far - uses the SAME one')
  // MUTATION CHECK: put `isStopped: () => buildAbort` back on either and this fails.
  assert(!/isStopped: \(\) => buildAbort/.test(gearBody + gathBody),
    'the build latch means "a build preempted me", never "I am dying" and never "I am too far out"')
})

t('LOOP E WIRING #5: the aborting excursion RETURNS HOME, via the existing homecoming owner', () => {
  const cmd = require('fs').readFileSync(require('path').join(__dirname, 'commands.js'), 'utf8')
  const fn = cmd.slice(cmd.indexOf('async function excursionGoHome'), cmd.indexOf('let recovering = false'))
  assert(/provRecovery\(\)\.recoverHome\(bot, \{ say, dist: v\.leash \}\)/.test(fn),
    'it calls recoverHome - the same owner reflexes.js `homecoming` dispatches - and hands it the ' +
    'leash as its own "how far is far", so the two cannot disagree about being out of position')
  assert(/if \(!v \|\| !v\.returnHome\) return null/.test(fn), 'and ONLY the leash stage triggers it')
  assert(!/walkStaged|GoalNear|pathfinder/.test(fn), 'MUTATION CHECK: no new walk is written here')
  const gearBody = cmd.slice(cmd.indexOf("case 'gearup': {"), cmd.indexOf("case 'huttidy'"))
  const gathBody = cmd.slice(cmd.indexOf("case 'gather': {"), cmd.indexOf("case 'provision': {"))
  assert(/excursionGoHome\(bot, gearupStopped, 'gearup'/.test(gearBody), 'gearup performs it')
  assert(/excursionGoHome\(bot, gatherStopped, 'gather'/.test(gathBody), 'gather performs it')
})

t('LOOP E INVARIANT: the leash inputs have ONE definition each, in the file that owns them', () => {
  const read = f => require('fs').readFileSync(require('path').join(__dirname, f), 'utf8')
  // the DEADLINE: the shelter rule that fires at it reads it from shelter.js
  assert(/timeOfDay >= shelter\.SHELTER_TOD/.test(read('provision-shelter.js')),
    'shelterNeeded reads SHELTER_TOD - MUTATION: re-type 12200 here and the leash can drift off the rule it serves')
  // the ARRIVAL RADIUS: the shelter call that enforces it reads it from shelter.js
  assert(/bedRange: shelterSite\.BED_TREK_RANGE/.test(read('provision-recovery.js')),
    'recoverHp passes BED_TREK_RANGE - MUTATION: re-type 32 here and "bed too far (108 > 32)" comes back')
  // the PACE: the trek loop the leash models reads its budget from the same constants
  const prov = read('provision.js')
  assert(/Math\.min\(scheduler\.TREK_LEG_BLOCKS, d\)/.test(prov), 'walkStaged legs ARE the leash pace numerator')
  assert(/scheduler\.TREK_LEG_DEADLINE_MS : 30000/.test(prov), '...and its budget is the denominator')
})

// ============ D3: THE ARBITER MAY NOT ACCEPT "NO" FOR AN ANSWER ===========================
// (structural review 2026-08-25, §3.3. The HEAD-era day these fixtures come from: 847 ticks of
// `CRISIS UNANSWERED`, 494 of them settling on "continuing the active build" - 63% of every
// decision the bot made was the do-nothing fallback - while 736 + 651 refusals cited two anti-loop
// latches whose only re-arm was a world change a wedged bot cannot produce.)
const attempts = require('./attempts.js')
const reflexes = require('./reflexes.js')

t('D3 ATTEMPT MEMORY: the re-arm is REACHABLE FROM A WEDGE - moving four blocks clears it', () => {
  attempts._reset()
  const here = { x: 100.5, y: 64, z: 200.5 }
  const cell = attempts.cellOf(here)
  attempts.record('nightShelter', '-', cell, { sig: 'FROZEN', why: 'no bed and no diggable ground', now: 1 })
  assert(attempts.futile('nightShelter', '-', cell, 'FROZEN'), 'in the same cell, same world: provably pointless, refuse it')
  // THE WHOLE POINT. The old latch keyed on recoverySignature, which has no position in it, so a
  // bot standing still at full hp had a frozen key and stayed disqualified forever. Four blocks:
  const moved = attempts.cellOf({ x: 105.5, y: 64, z: 200.5 })
  assert.notStrictEqual(moved, cell, 'four blocks is a different cell')
  assert.strictEqual(attempts.futile('nightShelter', '-', moved, 'FROZEN'), null,
    'and somewhere else it is a fresh attempt - THIS is the re-arm the signature latch could not reach')
})
t('D3 ATTEMPT MEMORY: the world moving still clears it, in place (the old re-arm survives)', () => {
  attempts._reset()
  const cell = attempts.cellOf({ x: 0, y: 64, z: 0 })
  attempts.record('recoveryLadder', '-', cell, { sig: 'n1|f1', why: 'blocked on dawn', now: 1 })
  assert(attempts.futile('recoveryLadder', '-', cell, 'n1|f1'), 'same world: still pointless')
  assert.strictEqual(attempts.futile('recoveryLadder', '-', cell, 'n0|f1'), null, 'dawn broke: live again')
  assert.strictEqual(attempts.futile('recoveryLadder', '-', cell, 'n1|f1'), null, 'and the stale record is DROPPED on read, not left to rot')
})
t('D3 ATTEMPT MEMORY: a different step is a different attempt (item 7 plugs into this key)', () => {
  attempts._reset()
  const cell = attempts.cellOf({ x: 0, y: 64, z: 0 })
  attempts.record('autobuild', 'gather:oak_log', cell, { sig: 'W', why: 'no logs in reach', now: 1 })
  assert(attempts.futile('autobuild', 'gather:oak_log', cell, 'W'), 'that step, here, achieved nothing')
  assert.strictEqual(attempts.futile('autobuild', 'place:wall', cell, 'W'), null, 'another step has its own memory')
})
t('D3 ATTEMPT MEMORY: it is bounded, and a full reset spares only the terminal action\'s own record', () => {
  attempts._reset()
  for (let i = 0; i < attempts.MAX_RECORDS + 40; i++) attempts.record('j' + i, '-', 'c' + i, { sig: 'x', now: i })
  assert(attempts.size() <= attempts.MAX_RECORDS, 'a map that only grows is a leak with a slow fuse')
  attempts._reset()
  attempts.record('secureFood', '-', 'c1', { sig: 'x', now: 1 })
  attempts.record(reflexes.TERMINAL, 'reset', 'c1', { sig: '', now: 1 })
  const n = attempts.forgetAll({ except: reflexes.TERMINAL })
  assert.strictEqual(n, 1, 'the refusals are cleared - a reset that leaves them standing is not a reset')
  assert(attempts.recall(reflexes.TERMINAL, 'reset', 'c1'), 'but a memory that erases itself cannot escalate')
})

// ---- the terminal tier ------------------------------------------------------------------
const CRISIS_REFUSED = () => new Map([
  ['recoveryLadder', 'last pass made no progress and nothing has changed since'],
  ['secureFood', 'un-armoured at night - foraging out into the dark is the death'],
  ['nightShelter', 'already tried this here and it achieved nothing'],
  ['recoverHp', 'just tried to heal'],
  ['maintenancePass', 'a job owns the body'],
  ['reclaim', 'a job owns the body'],
  ['build', 'post-death recovery in progress']
])
t('D3 TERMINAL: a crisis every candidate refused produces an ACTION, never a fallback', () => {
  const c = core.chooseActivity(THE_LIVELOCK, { refused: CRISIS_REFUSED() })
  assert.strictEqual(c.job, reflexes.TERMINAL, 'the floor runs. Got ' + c.job)
  assert.strictEqual(c.cls, 'survival', 'and it outranks whatever holds the body')
  assert(!/CRISIS UNANSWERED/.test(c.reason), 'the accepted-standoff outcome is gone: ' + c.reason)
  assert(/recoveryLadder: |nightShelter: /.test(c.reason), 'and the terminal line still names every refusal it stepped over (#7)')
})
t('D3 TERMINAL: the floor is EXECUTABLE - the row exists, dispatches, and cannot refuse', () => {
  const row = reflexes.get(reflexes.TERMINAL)
  assert(row, 'the name the core chooses must be a real registry row - otherwise the arbiter is total on paper only')
  assert.strictEqual(typeof row.run, 'function', 'it has an executor of its own (never an `owner` it defers to)')
  assert.strictEqual(row.refuse, undefined, 'and NO refuse(), by contract - not one that returns null, absent')
  assert.strictEqual(reflexes.REFLEXES.filter(r => r.terminal).length, 1, 'exactly one floor')
})
t('D3 TERMINAL: a crisis somebody is ALREADY ANSWERING is not unanswered (248 of the 847)', () => {
  const c = core.chooseActivity(THE_LIVELOCK, { refused: CRISIS_REFUSED(), survivalActor: { key: 'foodRun', label: 'a food run' } })
  assert.notStrictEqual(c.job, reflexes.TERMINAL, 'the terminal must not yank the body off a live food run')
  assert(/being answered by a food run/.test(c.reason), 'and the log says who is answering it: ' + c.reason)
  assert(!/CRISIS UNANSWERED/.test(c.reason), 'a crisis with an actor was never unanswered')
})
t('D3 TERMINAL: a need that is not crisis-grade does NOT abandon the build (220 of the 847)', () => {
  const c = core.chooseActivity(THE_LIVELOCK, { refused: CRISIS_REFUSED(), crisisGrade: false })
  assert.notStrictEqual(c.job, reflexes.TERMINAL, 'a sub-crisis need may not full-reset the bot; that is thrash, not rescue')
  assert(/not crisis-grade/.test(c.reason), 'and the line says exactly that instead of crying crisis: ' + c.reason)
})
t('D3 TERMINAL: CRISIS UNANSWERED survives ONLY as a defect detector, target count zero', () => {
  // The one path that can still print it: the floor itself refused, which it has no way to do.
  const refused = CRISIS_REFUSED(); refused.set(reflexes.TERMINAL, 'someone gave the floor a refuse()')
  const c = core.chooseActivity(THE_LIVELOCK, { refused })
  assert(/CRISIS UNANSWERED/.test(c.reason), 'it is still printed when it is genuinely true')
  assert(/wiring defect/.test(c.reason), '...and it says the line itself is the bug report')
})
t('D3 TERMINAL: an ANSWERED crisis never borrows the alarm (353 of the 847)', () => {
  // only the ladder refused: nightShelter is chosen and dispatched, which IS an answer.
  const c = core.chooseActivity(THE_LIVELOCK, { refused: new Map([['recoveryLadder', 'no progress']]) })
  assert.strictEqual(c.job, 'nightShelter')
  assert(!/CRISIS UNANSWERED/.test(c.reason), 'the chooser answered it - saying otherwise is the log lying (#7)')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall death-loop regression tests passed')
process.exit(fails ? 1 : 0)
