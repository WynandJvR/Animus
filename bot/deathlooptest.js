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

// ============ LOOP C - a decision must produce an action ==================================
t('LOOP C: every survival job the chooser can pick has a dispatch branch in the tick', () => {
  // The tick used to be an exhaustive if/else over four names; nightShelter fell through to a log
  // line and homecoming did not exist. Assert the dispatchable set is what the chooser can emit.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8')
  for (const job of ['graveSweep', 'secureFood', 'recoverHp', 'nightShelter', 'recoveryLadder', 'homecoming']) {
    assert(new RegExp("pick\\.job === '" + job + "'").test(src), `the tick must handle a ${job} pick`)
  }
  assert(/has NO executor - nothing dispatched/.test(src), 'and an unhandled pick must be LOUD, not silent')
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
  assert(/provision\.nightRest\(bot, \{ say: schedSay \}\)/.test(src), 'it calls the real shelter executor')
})

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall death-loop regression tests passed')
process.exit(fails ? 1 : 0)
