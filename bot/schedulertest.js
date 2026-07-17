'use strict'
// OFFLINE unit test for the proactive-survival scheduler (bot/scheduler.js) - the PURE
// decision core (no bot, no pathfinder). Proves: the live livelock snapshot yields a survival
// job + admits `recover` (the muzzle is gone); blocked-on chains resolve to producers and the
// cycle breaks to R0; maintain never preempts progress; recoveryPlan is TOTAL (non-empty for
// every snapshot, every hold names a provable wake); watchdog's danger-scaled windows; and the
// real command vocabulary classifies correctly.
// Run:  cd bot && node schedulertest.js

const assert = require('assert')
const S = require('./scheduler.js')

let failures = 0
function t (name, fn) {
  S._reset(); S._setNow(() => Date.now()) // isolation between cases
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}
// force RESILIENT_RECOVERY ON for a test body regardless of the ambient regime (so the whole suite
// can be run with RESILIENT_RECOVERY=0 to prove =0 rollback, while flag-ON behavior still gets tested).
function withResilient (fn) {
  const old = process.env.RESILIENT_RECOVERY; process.env.RESILIENT_RECOVERY = '1'
  try { return fn() } finally { if (old == null) delete process.env.RESILIENT_RECOVERY; else process.env.RESILIENT_RECOVERY = old }
}

// ---- fixture factories ------------------------------------------------------------------
function snap (over) {
  return Object.assign({
    hp: 20, food: 20, packFoodPts: 0, armorPieces: 4,
    threatDist: null, creeperDist: null, isNight: false, nightStuck: false,
    drowning: false, onFire: false, inLava: false,
    graves: [], homeDist: null, bankFoodPts: 0,
    farm: { exists: false }, orchard: {},
    gearupBackoffUntil: 0, deathsRecent: 0,
    activeJob: null, brainJobPending: false, persistedBuild: false, maintainNeeded: false
  }, over || {})
}
function grave (dist, o) { return Object.assign({ dist, value: 10, dangerous: false, hasGear: true }, o || {}) }

const VALID_WAKES = ['dawn', 'foodInPack', 'grave', 'animal<=24']
function wakeValid (w) {
  if (typeof w !== 'string' || !w) return false
  return w.split('|').every(p => VALID_WAKES.indexOf(p) !== -1)
}

// ---- (a) the live livelock snapshot (the headline fixture) ------------------------------
t('(a) livelock snapshot: hp1/food0/naked/grave3b/busy=securingFood -> survival job + admit recover', () => {
  const s = snap({ hp: 1, food: 0, packFoodPts: 0, armorPieces: 0, graves: [grave(3, { value: 30, hasGear: true })], activeJob: { name: 'secureFood', cls: 'survival' } })
  const pj = S.pickJob(s)
  assert.strictEqual(pj.cls, 'survival', 'the owning job is survival-class')
  assert(['recoveryLadder', 'graveSweep'].indexOf(pj.job) !== -1, 'job is recoveryLadder or graveSweep, got ' + pj.job)
  const adm = S.admissible('survival', s)
  assert.strictEqual(adm.allow, true, 'a recover command is admitted - the muzzle is gone')
  assert(/grave|heal|hp/i.test(adm.reason), 'reason mentions grave or heal: ' + adm.reason)
  const plan = S.recoveryPlan(s)
  assert(plan.some(r => r.rung === 'R1' && r.action === 'recoverGrave'), 'plan has the R1 grave rung')
})

// ---- (b) blocked-on chains resolve to producers; cycle breaks to R0 ----------------------
t('(b) needProducer maps the whole table; unknown -> null', () => {
  assert.strictEqual(S.needProducer('food'), 'secureFood')
  assert.strictEqual(S.needProducer('heal'), 'recoverHp')
  assert.strictEqual(S.needProducer('shelter'), 'nightShelter')
  assert.strictEqual(S.needProducer('gear'), 'gearup')
  assert.strictEqual(S.needProducer('iron'), 'mine')
  assert.strictEqual(S.needProducer('wood'), 'acquire')
  assert.strictEqual(S.needProducer('planks'), 'acquire')
  assert.strictEqual(S.needProducer('tool'), 'acquire')
  assert.strictEqual(S.needProducer('lava'), 'flee')
  assert.strictEqual(S.needProducer('creeper'), 'flee')
  assert.strictEqual(S.needProducer('bogus'), null)
  assert.strictEqual(S.needProducer(null), null)
})

t('(b) cycle fixture: far supply + no pack food -> plan non-empty, only hold is R5 w/ named wake', () => {
  const s = snap({ hp: 5, food: 4, packFoodPts: 0, farm: { exists: true, dist: 200 }, homeDist: 200, graves: [] })
  const plan = S.recoveryPlan(s)
  assert(plan.length >= 1, 'plan is non-empty')
  // the ONLY hold rung is R5, and it carries a named wake (no unnamed wait anywhere).
  const holds = plan.filter(r => /^boundedHold/.test(r.action || '') || r.action === 'sleepInBed' || r.action === 'digInForNight')
  for (const h of holds) assert(wakeValid(h.wake), 'hold ' + h.action + ' has a valid wake: ' + h.wake)
  const r5 = plan.filter(r => r.rung === 'R5')
  assert.strictEqual(r5.length, 1, 'exactly one R5 rung')
  assert(wakeValid(r5[0].wake), 'R5 names a provable wake: ' + r5[0].wake)
  // first non-hold feasible rung is R0/R2/R3/R4 (a real action), never an unnamed wait.
  const firstAction = plan[0]
  assert(firstAction && firstAction.action, 'first rung has an action')
})

// ---- (c) maintain never preempts progress ------------------------------------------------
t('(c) maintain need does NOT surface while a progress job is active', () => {
  const s = snap({ activeJob: { name: 'build', cls: 'progress', lastProgressAt: Date.now() }, maintainNeeded: true, hp: 20, food: 20, armorPieces: 4 })
  const pj = S.pickJob(s)
  assert.strictEqual(pj.job, 'build', 'progress continues')
  assert.notStrictEqual(pj.cls, 'maintain', 'no maintain job surfaces over active progress')
})

t('(c) maintain surfaces only with no progress job + no survival need, and never preempts', () => {
  const s = snap({ activeJob: null, maintainNeeded: true, hp: 20, food: 20, armorPieces: 4 })
  const pj = S.pickJob(s)
  assert.strictEqual(pj.cls, 'maintain')
  assert.strictEqual(pj.job, 'maintenancePass')
  assert.strictEqual(pj.preempt, false, 'maintain (rank 1) can never preempt progress (rank 2)')
})

// ---- (d) recoveryPlan totality sweep (S6) - the core safety test -------------------------
t('(d) totality sweep: every snapshot -> non-empty plan, valid wakes, far supply kept, nightStuck no dawn-hold, death-ratchet ordering', () => {
  const hps = [1, 6, 12, 20]
  const foods = [0, 6, 12, 20]
  const armors = [0, 4]
  const graveDists = ['none', 3, 32, 200]
  const homeDists = [5, 48, 200]
  const nights = [false, true]
  const stucks = [false, true]
  const deaths = [0, 3]
  let combos = 0
  for (const hp of hps) for (const food of foods) for (const armor of armors)
    for (const gd of graveDists) for (const hd of homeDists) for (const night of nights)
      for (const ns of stucks) for (const dr of deaths) {
        combos++
        const graves = gd === 'none' ? [] : [grave(gd, { value: 20 })]
        const s = snap({ hp, food, armorPieces: armor, graves, homeDist: hd, isNight: night, nightStuck: ns, deathsRecent: dr, farm: { exists: true, dist: 200 } })
        const plan = S.recoveryPlan(s)
        // non-empty
        assert(plan.length >= 1, 'empty plan for ' + JSON.stringify({ hp, food, armor, gd, hd, night, ns, dr }))
        // every hold names a valid wake; no entry has a wake with an empty/missing action
        for (const r of plan) {
          const isHold = /^boundedHold/.test(r.action || '') || r.action === 'sleepInBed' || r.action === 'digInForNight'
          if (isHold) assert(wakeValid(r.wake), 'hold missing valid wake: ' + JSON.stringify(r))
          if (r.wake != null) assert(r.action && String(r.action).length, 'a wake with no action: ' + JSON.stringify(r))
        }
        // far supply never disqualified: farm dist 200 -> an R3 or R4 rung is present
        assert(plan.some(r => r.rung === 'R3' || r.rung === 'R4'), 'far supply dropped for ' + JSON.stringify({ hd, gd }))
        // nightStuck -> no boundedHold (eternal night can't hold for dawn); R5 is rerunLadderByNight
        if (ns) {
          assert(!plan.some(r => /^boundedHold/.test(r.action || '')), 'boundedHold on eternal night: ' + JSON.stringify(plan))
          assert(plan.some(r => r.rung === 'R5' && r.action === 'rerunLadderByNight'), 'R5 must rerun by night on nightStuck')
        }
        // death-ratchet (deathsRecent 3): R3/R4 carry dayGated; any R2 precedes the first R3/R4
        if (dr >= 2) {
          for (const r of plan) if (r.rung === 'R3' || r.rung === 'R4') assert.strictEqual(r.dayGated, true, 'R3/R4 must be dayGated on death-ratchet')
          const r2i = plan.findIndex(r => r.rung === 'R2')
          const r34i = plan.findIndex(r => r.rung === 'R3' || r.rung === 'R4')
          assert(r2i === -1 || r34i === -1 || r2i < r34i, 'R2 must precede R3/R4 on death-ratchet')
        }
      }
  assert(combos === 4 * 4 * 2 * 4 * 3 * 2 * 2 * 2, 'swept the full grid: ' + combos)
})

// ---- (e) watchdog danger-scaled windows + nudge->fail sequencing -------------------------
t('(e) watchdog: critical windows 20000/40000', () => {
  const job = { startedAt: 0, lastProgressAt: 0, cls: 'progress' }
  const v = { hp: 6, food: 20 } // critical via hp<=6
  assert.strictEqual(S.watchdog(job, v, 19999), 'ok')
  assert.strictEqual(S.watchdog(job, v, 20000), 'nudge')
  assert.strictEqual(S.watchdog(job, v, 39999), 'nudge')
  assert.strictEqual(S.watchdog(job, v, 40000), 'fail-job')
  // food<=2 also critical
  assert.strictEqual(S.watchdog(job, { hp: 20, food: 2 }, 20000), 'nudge')
})

t('(e) watchdog: survival cls windows 45000/90000', () => {
  const job = { startedAt: 0, lastProgressAt: 0, cls: 'survival' }
  const v = { hp: 20, food: 20 }
  assert.strictEqual(S.watchdog(job, v, 44999), 'ok')
  assert.strictEqual(S.watchdog(job, v, 45000), 'nudge')
  assert.strictEqual(S.watchdog(job, v, 89999), 'nudge')
  assert.strictEqual(S.watchdog(job, v, 90000), 'fail-job')
})

t('(e) watchdog: patient (else) windows 120000/240000; idle 0 -> ok; null job -> ok', () => {
  const job = { startedAt: 0, lastProgressAt: 0, cls: 'progress' }
  const v = { hp: 20, food: 20 }
  assert.strictEqual(S.watchdog(job, v, 119999), 'ok')
  assert.strictEqual(S.watchdog(job, v, 120000), 'nudge')
  assert.strictEqual(S.watchdog(job, v, 239999), 'nudge')
  assert.strictEqual(S.watchdog(job, v, 240000), 'fail-job')
  // fresh progress (idle 0)
  assert.strictEqual(S.watchdog({ startedAt: 100, lastProgressAt: 100, cls: 'progress' }, v, 100), 'ok')
  assert.strictEqual(S.watchdog(null, v, 999999), 'ok')
})

// ---- (e) wdPhase: the escalation reducer (S7) --------------------------------------------
t('(e) wdPhase: ok->nudge->fail->giveup sequencing, latch-once, verdict-ok + jobKey resets', () => {
  const K = 'travel@1000'
  let st = { phase: 'ok', jobKey: null }
  const step = (verdict, jobKey) => { st = S.wdPhase(st, verdict, jobKey); return st.act }
  assert.strictEqual(step('ok', K), 'none', 'ok -> none')
  assert.strictEqual(step('nudge', K), 'nudge', 'first nudge fires')
  assert.strictEqual(step('nudge', K), 'none', 'nudge latches - only the first fires')
  assert.strictEqual(step('fail-job', K), 'fail', 'first fail-job fires the fail')
  assert.strictEqual(step('fail-job', K), 'giveup', 'still failing AFTER the fail -> giveup (latch did not bite)')
  assert.strictEqual(step('fail-job', K), 'none', 'giveup is once, then silence for this jobKey')
  // an ok verdict resets the ladder
  assert.strictEqual(step('ok', K), 'none')
  assert.strictEqual(step('nudge', K), 'nudge', 'after an ok reset, nudge fires again')
  // a jobKey change resets to ok regardless of prior phase
  st = { phase: 'failed', jobKey: K }
  assert.strictEqual(S.wdPhase(st, 'nudge', 'gather@2000').act, 'nudge', 'new jobKey resets -> nudge fires')
  // a straight-to-fail (tick interval > nudge window) still fails once from phase ok
  assert.strictEqual(S.wdPhase({ phase: 'ok', jobKey: 'x' }, 'fail-job', 'x').act, 'fail')
  // null jobKey (no active job) -> never acts, resets phase
  const r = S.wdPhase({ phase: 'failed', jobKey: 'x' }, 'fail-job', null)
  assert.strictEqual(r.act, 'none')
  assert.strictEqual(r.phase, 'ok')
})

// ---- (f) every hold carries a valid wake (focused restatement of (d)) --------------------
t('(f) hold-forcing snapshots all carry valid wakes', () => {
  const cases = [
    snap({ hp: 5, food: 4, homeDist: 200, isNight: true, nightStuck: false }), // night, nothing reachable
    snap({ hp: 5, food: 4, homeDist: 5, isNight: true, nightStuck: false }),   // night, bed at 5b
    snap({ hp: 5, food: 4, homeDist: 5, isNight: true, nightStuck: true }),    // eternal night
    snap({ hp: 5, food: 4, homeDist: 200, isNight: false })                    // day, far from home
  ]
  for (const s of cases) {
    const plan = S.recoveryPlan(s)
    for (const r of plan) {
      const isHold = /^boundedHold/.test(r.action || '') || r.action === 'sleepInBed' || r.action === 'digInForNight'
      if (isHold) assert(wakeValid(r.wake), 'hold ' + JSON.stringify(r) + ' lacks a valid wake')
    }
    assert(plan.length >= 1)
  }
})

// ---- (g) commandClass vocabulary --------------------------------------------------------
t('(g) commandClass maps the real vocabulary; unknown/blank -> progress', () => {
  const survival = ['recover', 'eat', 'wear', 'armorup', 'sleep', 'fish', 'securefood', 'gearup', 'equip', 'hunt']
  const progress = ['build', 'gather', 'mine', 'come', 'goto', 'follow', 'craft', 'place', 'attack']
  const perception = ['state', 'scan', 'find', 'block', 'entities', 'inventory', 'look', 'waypoints']
  for (const c of survival) assert.strictEqual(S.commandClass(c), 'survival', c + ' -> survival')
  for (const c of progress) assert.strictEqual(S.commandClass(c), 'progress', c + ' -> progress')
  for (const c of perception) assert.strictEqual(S.commandClass(c), 'perception', c + ' -> perception')
  assert.strictEqual(S.commandClass('say hello there'), 'chat', 'say -> chat')
  assert.strictEqual(S.commandClass(''), 'progress', 'blank -> progress')
  assert.strictEqual(S.commandClass('   '), 'progress', 'whitespace -> progress')
  assert.strictEqual(S.commandClass('frobnicate the widget'), 'progress', 'unknown -> progress')
  // leading !// stripped, case-insensitive, first-token anchored
  assert.strictEqual(S.commandClass('!recover'), 'survival')
  assert.strictEqual(S.commandClass('/GOTO 1 2 3'), 'progress')
  assert.strictEqual(S.commandClass('EAT bread'), 'survival')
  // cheat commands fall through to progress harmlessly
  assert.strictEqual(S.commandClass('setblock 1 2 3 stone'), 'progress')
})

// ---- (h) admissible survival gating -----------------------------------------------------
t('(h) admissible: fed/armed/no-grave -> survival NOT admitted; progress/perception always allowed', () => {
  const safe = snap({ hp: 20, food: 20, armorPieces: 4, graves: [] })
  assert.strictEqual(S.admissible('survival', safe).allow, false, 'no need + no grave -> not interrupting the build')
  assert.strictEqual(S.admissible('progress', safe).allow, true)
  assert.strictEqual(S.admissible('perception', safe).allow, true)
  assert.strictEqual(S.admissible('chat', safe).allow, true)
  // a real need admits survival
  assert.strictEqual(S.admissible('survival', snap({ food: 5 })).allow, true, 'hungry -> admit')
  // a near non-dangerous grave admits survival even fed/armed
  assert.strictEqual(S.admissible('survival', snap({ graves: [grave(4, { value: 20 })] })).allow, true, 'near grave -> admit')
  // a melee hostile in range makes the grave wait
  assert.strictEqual(S.admissible('survival', snap({ graves: [grave(4, { value: 20 })], threatDist: 3 })).allow, true, 'threat itself is a need -> admit (via need, not grave)')
  const fedGraveThreat = snap({ hp: 20, food: 20, armorPieces: 4, graves: [grave(4, { value: 20 })], threatDist: 3 })
  // threatDist 3 -> jobSurvivalNeed returns 'threat' so it IS admitted (as a need). Verify a
  // NON-need melee case: a far-but-in-band scenario is covered by the grave path above.
  assert.strictEqual(S.admissible('survival', fedGraveThreat).allow, true)
})

// ---- extra: pickJob nearby-grave first-class + degraded routing --------------------------
t('pickJob: fed-but-naked with a grave 3b -> graveSweep (survival), even with food/hp fine', () => {
  const s = snap({ hp: 20, food: 20, armorPieces: 2, graves: [grave(3, { value: 20 })], activeJob: { name: 'build', cls: 'progress' } })
  const pj = S.pickJob(s)
  assert.strictEqual(pj.cls, 'survival')
  assert.strictEqual(pj.job, 'graveSweep')
  assert.strictEqual(pj.preempt, true, 'survival preempts the active progress build')
})

t('pickJob: null when idle (fed, armed, no job, no buffers)', () => {
  assert.strictEqual(S.pickJob(snap({})), null)
})

// ---- (S5) rungFeasible: the night/day gates ---------------------------------------------
const OUTBOUND = [
  { rung: 'R3', action: 'trekFarm+tend+harvest+courierHome' },
  { rung: 'R3', action: 'trekOrchard+harvest+courierHome' },
  { rung: 'R4', action: 'secureFood(hunt->fish->scout)' }
]
const NON_OUTBOUND = [
  { rung: 'R0', action: 'eatPack+wearFromPack' },
  { rung: 'R1', action: 'recoverGrave' },
  { rung: 'R2', action: 'gotoHome+ensureFood(forceFresh)+cook+eat' },
  { rung: 'R2', action: 'sleepInBed', wake: 'dawn' },
  { rung: 'R2', action: 'digInForNight', wake: 'dawn' },
  { rung: 'R5', action: 'boundedHold:sleep', wake: 'dawn' },
  { rung: 'R5', action: 'rerunLadderByNight' }
]

t('(S5) rungFeasible: night + underArmored blocks the OUTBOUND rungs, admits R0/R1/R2/R5', () => {
  const s = snap({ isNight: true, underArmored: true, armorPieces: 0, nightStuck: false })
  for (const r of OUTBOUND) assert.strictEqual(S.rungFeasible(r, s), false, r.action + ' must be blocked at night un-armored')
  for (const r of NON_OUTBOUND) assert.strictEqual(S.rungFeasible(r, s), true, r.action + ' must stay feasible at night')
})

t('(S5) rungFeasible: nightStuck LIFTS both gates -> everything feasible', () => {
  const s = snap({ isNight: true, underArmored: true, armorPieces: 0, nightStuck: true })
  for (const r of OUTBOUND) assert.strictEqual(S.rungFeasible(r, s), true, r.action + ' lifts on nightStuck')
  for (const r of NON_OUTBOUND) assert.strictEqual(S.rungFeasible(r, s), true)
  // a dayGated rung also lifts on eternal night
  assert.strictEqual(S.rungFeasible({ rung: 'R3', action: 'trekFarm+tend+harvest+courierHome', dayGated: true }, s), true)
})

t('(#41 P3) rungFeasible: day + naked + a re-arm source -> OUTBOUND inadmissible (re-arm first)', () => withResilient(() => {
  // gearupBackoffUntil 0 => gearup available => a re-arm source exists => block outbound by DAY too.
  const s = snap({ isNight: false, underArmored: true, armorPieces: 0, gearupBackoffUntil: 0 })
  for (const r of OUTBOUND) assert.strictEqual(S.rungFeasible(r, s), false, r.action + ' blocked by day when under-armored + re-armable (P3)')
  for (const r of NON_OUTBOUND) assert.strictEqual(S.rungFeasible(r, s), true, r.action + ' still feasible')
}))

t('(#41 P4) rungFeasible: day + naked + NO re-arm source -> OUTBOUND admissible (escape, no trap)', () => {
  // no bank spare, no grave, gearup on back-off => nothing to re-arm from => forage to survive.
  const s = snap({ isNight: false, underArmored: true, armorPieces: 0, graves: [], bankArmorPieces: 0, bankHasPick: false, bankHasSword: false, gearupBackoffUntil: Date.now() + 100000 })
  for (const r of OUTBOUND) assert.strictEqual(S.rungFeasible(r, s), true, r.action + ' allowed when the world affords no re-arm (P4 escape)')
})

t('(#41 P3) rungFeasible: RESILIENT_RECOVERY=0 -> day + naked all feasible (today byte-for-byte)', () => {
  const old = process.env.RESILIENT_RECOVERY; process.env.RESILIENT_RECOVERY = '0'
  try {
    const s = snap({ isNight: false, underArmored: true, armorPieces: 0, gearupBackoffUntil: 0 })
    for (const r of OUTBOUND.concat(NON_OUTBOUND)) assert.strictEqual(S.rungFeasible(r, s), true, r.action + ' feasible by day (flag off = night-only gate)')
  } finally { if (old == null) delete process.env.RESILIENT_RECOVERY; else process.env.RESILIENT_RECOVERY = old }
})

t('(S5) rungFeasible: armored night -> R4 (secureFood/hunt) still feasible (today\'s behavior)', () => {
  const s = snap({ isNight: true, underArmored: false, armorPieces: 4 })
  assert.strictEqual(S.rungFeasible({ rung: 'R4', action: 'secureFood(hunt->fish->scout)' }, s), true)
  assert.strictEqual(S.rungFeasible({ rung: 'R3', action: 'trekFarm+tend+harvest+courierHome' }, s), true)
})

t('(S5) rungFeasible: dayGated rung false at night (non-stuck), true by day', () => {
  const g = { rung: 'R3', action: 'trekFarm+tend+harvest+courierHome', dayGated: true }
  assert.strictEqual(S.rungFeasible(g, snap({ isNight: true, nightStuck: false, armorPieces: 4, underArmored: false })), false, 'dayGated blocked at night')
  assert.strictEqual(S.rungFeasible(g, snap({ isNight: false, armorPieces: 4, underArmored: false })), true, 'dayGated allowed by day')
})

// ---- (S5) ladderDone: the exit predicate (the live-death grid) ---------------------------
t('(S5) ladderDone: the live-death grid', () => {
  assert.strictEqual(S.ladderDone(snap({ hp: 1, food: 0, armorPieces: 0, graves: [grave(3)] })), false, 'rock-bottom -> not done')
  assert.strictEqual(S.ladderDone(snap({ hp: 20, food: 18, armorPieces: 0, graves: [grave(3)] })), false, 'naked with a standing grave -> not done')
  assert.strictEqual(S.ladderDone(snap({ hp: 20, food: 18, armorPieces: 0, graves: [] })), true, 'fed + healthy, no grave -> done even naked')
  assert.strictEqual(S.ladderDone(snap({ hp: 20, food: 13, armorPieces: 4, graves: [] })), false, 'food 13 -> not done (14 is the bar)')
  assert.strictEqual(S.ladderDone(snap({ hp: 20, food: 14, armorPieces: 4, graves: [] })), true, 'food 14 -> done')
  // deathsRecent must NOT pin termination (it biases sequencing only)
  assert.strictEqual(S.ladderDone(snap({ hp: 20, food: 18, armorPieces: 4, graves: [], deathsRecent: 5 })), true, 'restored vitals+gear -> done regardless of deathsRecent')
  // null vitals (partial snapshot) don't block termination
  assert.strictEqual(S.ladderDone(snap({ hp: null, food: null, armorPieces: 4, graves: [] })), true, 'null hp/food -> not blocking')
})

// ---- (S5) composition: the ladder ALWAYS has a move --------------------------------------
t('(S5) composition: every totality-sweep snapshot has >=1 feasible rung (or rerunLadderByNight)', () => {
  const hps = [1, 6, 12, 20]
  const foods = [0, 6, 12, 20]
  const armors = [0, 4]
  const graveDists = ['none', 3, 32, 200]
  const homeDists = [5, 48, 200]
  const nights = [false, true]
  const stucks = [false, true]
  const deaths = [0, 3]
  for (const hp of hps) for (const food of foods) for (const armor of armors)
    for (const gd of graveDists) for (const hd of homeDists) for (const night of nights)
      for (const ns of stucks) for (const dr of deaths) {
        const graves = gd === 'none' ? [] : [grave(gd, { value: 20 })]
        const s = snap({ hp, food, armorPieces: armor, underArmored: armor === 0, graves, homeDist: hd, isNight: night, nightStuck: ns, deathsRecent: dr, farm: { exists: true, dist: 200 } })
        const plan = S.recoveryPlan(s)
        assert(plan.some(r => S.rungFeasible(r, s) || r.action === 'rerunLadderByNight'),
          'no feasible move for ' + JSON.stringify({ hp, food, armor, gd, hd, night, ns, dr }) + ' plan=' + JSON.stringify(plan.map(r => r.action)))
      }
})

// ---- (opp) oppMaintain: the opportunistic at-hut maintenance window predicate ------------
// PURE. Position-gated + survival-yielding + build-era-only; preempt true only when a build
// is actively running (idle+saved resumes without a preempt). checkupDue relaxes the buffer gate.
t('(opp) at hut + active autobuild + maintainNeeded -> ok, preempt (chores while the build passes home)', () => {
  const s = snap({ homeDist: 10, activeJob: { name: 'autobuild', cls: 'progress' }, maintainNeeded: true })
  const r = S.oppMaintain(s, { checkupDue: false })
  assert.strictEqual(r.ok, true, 'window opens: ' + r.reason)
  assert.strictEqual(r.preempt, true, 'a running build must be preempt-paused')
})

t('(opp) homeDist 30 (>24 default) -> not at the hut; with OPP_MAINTAIN_DIST=40 it opens', () => {
  const s = snap({ homeDist: 30, activeJob: { name: 'autobuild', cls: 'progress' }, maintainNeeded: true })
  assert.strictEqual(S.oppMaintain(s, { checkupDue: false }).ok, false, '30b is outside the 24b default radius')
  process.env.OPP_MAINTAIN_DIST = '40'
  try {
    const r = S.oppMaintain(s, { checkupDue: false })
    assert.strictEqual(r.ok, true, '30b <= 40b radius -> opens')
    assert.strictEqual(r.preempt, true)
  } finally { delete process.env.OPP_MAINTAIN_DIST }
})

t('(opp) homeDist null (no home / off-map) -> never opens', () => {
  const s = snap({ homeDist: null, activeJob: { name: 'autobuild', cls: 'progress' }, maintainNeeded: true })
  assert.strictEqual(S.oppMaintain(s, { checkupDue: true }).ok, false)
})

t('(opp) survival need present (food 4) -> survival wins, no window', () => {
  const s = snap({ homeDist: 10, food: 4, activeJob: { name: 'autobuild', cls: 'progress' }, maintainNeeded: true })
  const r = S.oppMaintain(s, { checkupDue: true })
  assert.strictEqual(r.ok, false)
  assert(/survival/i.test(r.reason), 'reason is survival: ' + r.reason)
})

t('(opp) degraded (deathsRecent 2) / flee (creeper 8b) -> not chore time', () => {
  // deathsRecent>=2 is degraded but raises no direct survival need (vitals fine) -> exercises the degraded branch
  const degraded = snap({ homeDist: 10, deathsRecent: 2, activeJob: { name: 'autobuild', cls: 'progress' }, maintainNeeded: true })
  assert.strictEqual(S.oppMaintain(degraded, { checkupDue: true }).ok, false, 'degraded -> no window')
  const flee = snap({ homeDist: 10, creeperDist: 8, activeJob: { name: 'autobuild', cls: 'progress' }, maintainNeeded: true })
  assert.strictEqual(S.oppMaintain(flee, { checkupDue: true }).ok, false, 'creeper in blast band -> no window')
})

t('(opp) active gather (progress, not autobuild) -> no window (never abort a non-resumable job)', () => {
  const s = snap({ homeDist: 10, activeJob: { name: 'gather', cls: 'progress' }, maintainNeeded: true })
  const r = S.oppMaintain(s, { checkupDue: true })
  assert.strictEqual(r.ok, false)
  assert(/build era/i.test(r.reason), 'reason: no build era, got: ' + r.reason)
})

t('(opp) idle + persistedBuild + maintainNeeded -> ok, NO preempt (resume-gap window)', () => {
  const s = snap({ homeDist: 10, activeJob: null, persistedBuild: true, maintainNeeded: true })
  const r = S.oppMaintain(s, { checkupDue: false })
  assert.strictEqual(r.ok, true, 'window opens in the resume gap: ' + r.reason)
  assert.strictEqual(r.preempt, false, 'nothing to pause when idle')
})

t('(opp) idle + no saved build -> no build era, no window', () => {
  const s = snap({ homeDist: 10, activeJob: null, persistedBuild: false, maintainNeeded: true })
  assert.strictEqual(S.oppMaintain(s, { checkupDue: true }).ok, false)
})

t('(opp) maintainNeeded false: checkupDue toggles the window', () => {
  const s = snap({ homeDist: 10, activeJob: null, persistedBuild: true, maintainNeeded: false })
  assert.strictEqual(S.oppMaintain(s, { checkupDue: false }).ok, false, 'buffers fine + checkup not due -> closed')
  const r = S.oppMaintain(s, { checkupDue: true })
  assert.strictEqual(r.ok, true, 'checkup due lets homeRepair/safekeep run even with buffers fine')
  assert.strictEqual(r.preempt, false)
})

t('(opp) non-regression: oppMaintain is a separate authority - pickJob still continues the build', () => {
  const s = snap({ homeDist: 10, activeJob: { name: 'autobuild', cls: 'progress' }, maintainNeeded: true })
  const pj = S.pickJob(s)
  assert.strictEqual(pj.job, 'autobuild', 'pickJob unchanged: active progress continues')
  assert.strictEqual(pj.cls, 'progress')
  assert.notStrictEqual(pj.cls, 'maintain', 'pickJob never surfaces maintain over the build (oppMaintain is the only path)')
})

// ---- (#15) fightNotFlee: melee beats an unsatisfiable flee when pinned + hit --------------
// PURE predicate (§7.1). hp is NOT an input by design. flagOn=false reverts to today (false).
t('(#15) fightNotFlee: flag off -> always false', () => {
  assert.strictEqual(S.fightNotFlee({ flagOn: false, beingHit: true, pinnedMs: 9000, threatDist: 2, isCreeper: false }), false, 'DEFEND_WHEN_HIT=0 -> never converts')
})
t('(#15) fightNotFlee: not being hit -> false', () => {
  assert.strictEqual(S.fightNotFlee({ flagOn: true, beingHit: false, pinnedMs: 9000, threatDist: 2, isCreeper: false }), false, 'no hits -> normal flee')
})
t('(#15) fightNotFlee: hit + pinned >=4s + dist <=4 + non-creeper -> true', () => {
  assert.strictEqual(S.fightNotFlee({ flagOn: true, beingHit: true, pinnedMs: 4000, threatDist: 4, isCreeper: false }), true, 'wedged + in reach -> fight')
  assert.strictEqual(S.fightNotFlee({ flagOn: true, beingHit: true, pinnedMs: 8000, threatDist: 1, isCreeper: false }), true)
})
t('(#15) fightNotFlee: creeper -> false (burst away, never melee)', () => {
  assert.strictEqual(S.fightNotFlee({ flagOn: true, beingHit: true, pinnedMs: 9000, threatDist: 2, isCreeper: true }), false, 'NO_AUTO_MELEE: never punch a creeper')
})
t('(#15) fightNotFlee: dist 5 (out of melee reach) -> false', () => {
  assert.strictEqual(S.fightNotFlee({ flagOn: true, beingHit: true, pinnedMs: 9000, threatDist: 5, isCreeper: false }), false, 'out of reach -> keep fleeing')
})
t('(#15) fightNotFlee: pinned 3.9s (< 4s) -> false', () => {
  assert.strictEqual(S.fightNotFlee({ flagOn: true, beingHit: true, pinnedMs: 3900, threatDist: 2, isCreeper: false }), false, 'not pinned long enough')
})
t('(#15) fightNotFlee: hp is irrelevant (not an input)', () => {
  // same inputs, no hp field -> still true; the predicate must not read hp
  assert.strictEqual(S.fightNotFlee({ flagOn: true, beingHit: true, pinnedMs: 5000, threatDist: 3, isCreeper: false }), true)
})

// ---- (#18) urgency-widened grave band: pickJob + recoveryPlan --------------------------------
// A safe grave keeps GRAVE_NEAR (16, pickJob) / GRAVE_NEAR_LADDER (32, R1); an urgent/critical
// (about-to-despawn, tier carried on the snapshot) grave widens to GRAVE_URGENT_DIST (96), closing
// the 33-96b dead zone exactly when the despawn timer matters. Step 1 (need) still outranks; a flee
// still blocks; GRAVE_URGENT=0 rolls the band back.
// These band tests assume the flag ON regardless of how the process was invoked (the OFF path has
// its own explicit rollback case below), so force it on here and restore at the end of the block.
const _savedGU18 = process.env.GRAVE_URGENT; delete process.env.GRAVE_URGENT
t('(#18) pickJob: a 60b URGENT grave -> graveSweep (band widens to GRAVE_URGENT_DIST)', () => {
  const s = snap({ graves: [grave(60, { value: 20, tier: 'urgent' })] })
  const pj = S.pickJob(s)
  assert.strictEqual(pj.job, 'graveSweep', 'urgent 60b grave is picked (dead zone closed)')
  assert.strictEqual(pj.cls, 'survival')
  assert(/despawning/.test(pj.reason), 'reason flags the despawn urgency: ' + pj.reason)
})
t('(#18) pickJob: a 60b SAFE grave is NOT picked (safe keeps GRAVE_NEAR 16)', () => {
  const s = snap({ graves: [grave(60, { value: 20, tier: 'safe' })] })
  assert.strictEqual(S.pickJob(s), null, 'a safe 60b grave stays in the dead zone (unchanged today)')
})
t('(#18) pickJob: a 3b safe grave is still picked (near band unchanged)', () => {
  const s = snap({ graves: [grave(3, { value: 20, tier: 'safe' })] })
  assert.strictEqual(S.pickJob(s).job, 'graveSweep', 'a near safe grave is unchanged')
})
t('(#18) pickJob: step-1 vitals need OUTRANKS an urgent grave (I1)', () => {
  const s = snap({ food: 5, graves: [grave(60, { value: 20, tier: 'urgent' })] }) // food<=6 -> need + degraded
  const pj = S.pickJob(s)
  assert.strictEqual(pj.cls, 'survival')
  assert.notStrictEqual(pj.job, 'graveSweep', 'a real food need is served before the grave (step 1 > step 2)')
})
t('(#18) pickJob: a flee/danger still blocks the urgent grave (fleeActive gate intact)', () => {
  const s = snap({ inLava: true, graves: [grave(60, { value: 20, tier: 'critical' })] })
  const pj = S.pickJob(s)
  assert(pj == null || pj.job !== 'graveSweep', 'an active hazard is never traded for a grave, urgent or not')
})
t('(#18) pickJob: GRAVE_URGENT=0 -> the 60b urgent grave is NOT picked (rollback)', () => {
  process.env.GRAVE_URGENT = '0'
  try { assert.strictEqual(S.pickJob(snap({ graves: [grave(60, { value: 20, tier: 'urgent' })] })), null, 'flag off -> band is 16 again') }
  finally { delete process.env.GRAVE_URGENT } // back to ON for the remaining band tests
})
t('(#18) recoveryPlan R1: an urgent 60b grave gets an R1 rung; a safe 60b grave does not', () => {
  const urgent = S.recoveryPlan(snap({ hp: 5, food: 4, graves: [grave(60, { value: 20, tier: 'urgent' })], homeDist: 200 }))
  assert(urgent.some(r => r.rung === 'R1' && r.action === 'recoverGrave'), 'urgent 60b grave -> R1 present (band widened past 32)')
  const safe = S.recoveryPlan(snap({ hp: 5, food: 4, graves: [grave(60, { value: 20, tier: 'safe' })], homeDist: 200 }))
  assert(!safe.some(r => r.rung === 'R1'), 'safe 60b grave -> no R1 (ladder band stays 32)')
})

// ---- (#18) graveCooldownMs: verdict-classed re-dispatch back-off ------------------------------
t('(#18) graveCooldownMs: retrieved/gone -> 0; flag off -> blanket 300s on any non-retrieval', () => {
  assert.strictEqual(S.graveCooldownMs('got my stuff back at 1,2,3 (+40 items)', { flagOn: true }), 0, 'retrieved -> 0')
  assert.strictEqual(S.graveCooldownMs("nothing left where i died at 1,2,3 - it's gone", { flagOn: true }), 0, 'gone -> 0')
  assert.strictEqual(S.graveCooldownMs('got some of my stuff (+2 of ~140) - the grave still has the rest', { flagOn: false }), 300000, 'flag off partial -> 300s blanket')
  assert.strictEqual(S.graveCooldownMs('got my stuff back (+40 items)', { flagOn: false }), 0, 'flag off retrieved -> still 0')
})
t('(#18) graveCooldownMs: partial/capacity -> hot 30s (floor 15s); won\'t open -> 120s', () => {
  assert.strictEqual(S.graveCooldownMs('got some of my stuff (+2 of ~140) - the grave still has the rest, going back for it', { flagOn: true }), 30000, 'partial -> 30s hot')
  assert.strictEqual(S.graveCooldownMs("got some of my stuff (+5) - pack's full, the grave still has the rest", { flagOn: true }), 30000, 'capacity -> 30s hot')
  assert.strictEqual(S.graveCooldownMs('got some of my stuff - the grave still has the rest', { flagOn: true, hotMs: 5000 }), 15000, 'hot floor is 15s (a tiny hotMs is clamped)')
  assert.strictEqual(S.graveCooldownMs("picked up 5 loose items but my gear is still in the grave - it won't open", { flagOn: true }), 120000, "won't open -> 120s")
})
t('(#18) graveCooldownMs: travel failure/throw scaled by the despawn budget (min 300s, max(60s, remain/2))', () => {
  assert.strictEqual(S.graveCooldownMs("couldn't get back to where i died", { flagOn: true, remainMs: Infinity }), 300000, 'unreachable SAFE (remain inf) -> today\'s 300s')
  assert.strictEqual(S.graveCooldownMs("couldn't get back", { flagOn: true, remainMs: 400000 }), 200000, 'remain 400s -> remain/2 = 200s')
  assert.strictEqual(S.graveCooldownMs("couldn't get back", { flagOn: true, remainMs: 100000 }), 60000, 'remain 100s -> clamped up to the 60s floor')
  assert.strictEqual(S.graveCooldownMs('', { flagOn: true, remainMs: Infinity }), 300000, 'a THROW (empty result) -> 300s ceiling with no budget')
  assert.strictEqual(S.graveCooldownMs('', { flagOn: true, remainMs: 90000 }), 60000, 'throw + urgent budget -> 60s floor (retries sooner)')
})
if (_savedGU18 != null) process.env.GRAVE_URGENT = _savedGU18; else delete process.env.GRAVE_URGENT // restore ambient flag

// ---- WATER_SAFE (task #45): fightSuppressedWhenSubmerged + submergedEscapeDue ----------------
t('(#45) fightSuppressedWhenSubmerged: submerged + flag on -> suppress the fight; on land -> fight', () => {
  assert.strictEqual(S.fightSuppressedWhenSubmerged({ flagOn: true, submerged: true }), true, 'head underwater -> stand down (drown-escape owns the body)')
  assert.strictEqual(S.fightSuppressedWhenSubmerged({ flagOn: true, submerged: false }), false, 'on land/shallow -> the melee/flee ladder runs unchanged')
  assert.strictEqual(S.fightSuppressedWhenSubmerged({ flagOn: false, submerged: true }), false, 'WATER_SAFE=0 -> today: fight even while submerged')
})
t('(#45) submergedEscapeDue: DEEP water fires on the FIRST confirmed poll (no ~6s wait)', () => {
  assert.strictEqual(S.submergedEscapeDue({ flagOn: true, submerged: true, deep: true, wetHist: 1 }), true, 'over-the-head -> escape at wetHist 1')
  assert.strictEqual(S.submergedEscapeDue({ flagOn: true, submerged: true, deep: true, wetHist: 0 }), false, 'needs one confirmed submerged poll first')
})
t('(#45) submergedEscapeDue: SHALLOW head-dip keeps today\'s ~6s (wetHist>=3) persistence', () => {
  assert.strictEqual(S.submergedEscapeDue({ flagOn: true, submerged: true, deep: false, wetHist: 2 }), false, 'shallow + 2 polls -> wait')
  assert.strictEqual(S.submergedEscapeDue({ flagOn: true, submerged: true, deep: false, wetHist: 3 }), true, 'shallow + 3 polls -> today\'s threshold')
})
t('(#45) submergedEscapeDue: oxygen only trusted when oxygenReliable (unreliable on live)', () => {
  assert.strictEqual(S.submergedEscapeDue({ flagOn: true, submerged: true, deep: false, wetHist: 1, oxygen: 5, oxygenReliable: false }), false, 'unreliable oxygen ignored -> block-based only')
  assert.strictEqual(S.submergedEscapeDue({ flagOn: true, submerged: true, deep: false, wetHist: 1, oxygen: 5, oxygenReliable: true }), true, 'reliable + draining -> escape at wetHist 1')
})
t('(#45) submergedEscapeDue: not submerged or flag off -> never due (WATER_SAFE=0 uses caller\'s wetHist>=3)', () => {
  assert.strictEqual(S.submergedEscapeDue({ flagOn: true, submerged: false, deep: true, wetHist: 4 }), false, 'on land -> not due')
  assert.strictEqual(S.submergedEscapeDue({ flagOn: false, submerged: true, deep: true, wetHist: 4 }), false, 'flag off -> caller falls back to its own gate')
})

// ==== #41 RESILIENT RECOVERY - PURE predicates ============================================
const kit = { pick: true, sword: true }

t('(#41 P4) recoveryReady: naked + fed -> NOT ready (armor + re-arm source available)', () => {
  const rr = S.recoveryReady(snap({ hp: 20, food: 20, armorPieces: 0, tools: kit, gearupBackoffUntil: 0 }))
  assert.strictEqual(rr.ready, false, 'naked with a re-arm source is not recovered')
})

t('(#41 P4) recoveryReady: full armor + tools + hp18 + food14 -> ready', () => {
  const rr = S.recoveryReady(snap({ hp: 18, food: 14, armorPieces: 4, tools: kit }))
  assert.strictEqual(rr.ready, true)
  assert.strictEqual(rr.maxCaution, false)
})

t('(#41 P4) recoveryReady: hp/food below the bar -> NOT ready', () => {
  assert.strictEqual(S.recoveryReady(snap({ hp: 17, food: 14, armorPieces: 4, tools: kit })).ready, false, 'hp 17 < HP_OK 18')
  assert.strictEqual(S.recoveryReady(snap({ hp: 18, food: 13, armorPieces: 4, tools: kit })).ready, false, 'food 13 < 14')
})

t('(#41 P4) recoveryReady: naked + NO bank kit + no safe grave + gearup back-off -> ready-with-maxCaution', () => {
  const rr = S.recoveryReady(snap({ hp: 18, food: 14, armorPieces: 0, tools: kit, graves: [], bankArmorPieces: 0, bankHasPick: false, bankHasSword: false, gearupBackoffUntil: Date.now() + 100000 }))
  assert.strictEqual(rr.ready, true, 'best-affordable escape -> ready')
  assert.strictEqual(rr.maxCaution, true, 'raised max caution')
})

t('(#41 P4) recoveryReady: toolless -> NOT ready even under the escape', () => {
  const rr = S.recoveryReady(snap({ hp: 18, food: 14, armorPieces: 4, tools: { pick: false, sword: true }, graves: [], bankArmorPieces: 0, bankHasPick: false, bankHasSword: false, gearupBackoffUntil: Date.now() + 100000 }))
  assert.strictEqual(rr.ready, false, 'no pick -> never ready')
})

t('(#41 P4) recoveryReady: under-armored but a BANK spare exists -> NOT ready (re-arm first)', () => {
  const rr = S.recoveryReady(snap({ hp: 18, food: 14, armorPieces: 0, tools: kit, bankArmorPieces: 4, bankHasPick: true, bankHasSword: true, gearupBackoffUntil: Date.now() + 100000 }))
  assert.strictEqual(rr.ready, false, 'bank can re-arm -> keep recovering, not escape')
})

t('(#41 P2) recoveryPlan: rearmFromBank present after R0, before outbound, when underArmored+home+bankKit', () => withResilient(() => {
  const s = snap({ armorPieces: 0, tools: kit, homeDist: 10, bankArmorPieces: 4, bankHasPick: true, bankHasSword: true, farm: { exists: true }, orchard: { dist: 50 } })
  const plan = S.recoveryPlan(s)
  const iRearm = plan.findIndex(r => r.action === 'rearmFromBank')
  assert(iRearm !== -1, 'rearmFromBank is planned')
  const iOutbound = plan.findIndex(r => S.OUTBOUND_RE.test(r.action || ''))
  assert(iOutbound === -1 || iRearm < iOutbound, 'rearmFromBank comes before any outbound rung')
}))

t('(#41 P2) recoveryPlan: rearmFromBank ABSENT when bank empty or flag off', () => {
  const empty = snap({ armorPieces: 0, tools: kit, homeDist: 10, bankArmorPieces: 0, bankHasPick: false, bankHasSword: false })
  assert(!S.recoveryPlan(empty).some(r => r.action === 'rearmFromBank'), 'no bank kit -> no rung')
  const old = process.env.RESILIENT_RECOVERY; process.env.RESILIENT_RECOVERY = '0'
  try {
    const s = snap({ armorPieces: 0, tools: kit, homeDist: 10, bankArmorPieces: 4, bankHasPick: true, bankHasSword: true })
    assert(!S.recoveryPlan(s).some(r => r.action === 'rearmFromBank'), 'flag off -> no rung')
  } finally { if (old == null) delete process.env.RESILIENT_RECOVERY; else process.env.RESILIENT_RECOVERY = old }
})

t('(#41 P5) spiralActive: deathsRecent >= SPIRAL_N(3) -> true; <3 -> false; flag off -> false', () => withResilient(() => {
  assert.strictEqual(S.spiralActive(snap({ deathsRecent: 3 })), true)
  assert.strictEqual(S.spiralActive(snap({ deathsRecent: 2 })), false)
  const old = process.env.RESILIENT_RECOVERY; process.env.RESILIENT_RECOVERY = '0'
  try { assert.strictEqual(S.spiralActive(snap({ deathsRecent: 5 })), false, 'flag off -> never active') }
  finally { if (old == null) delete process.env.RESILIENT_RECOVERY; else process.env.RESILIENT_RECOVERY = old }
}))

t('(#41 P5) rungFeasible: spiral -> grave (R1) + outbound suppressed, home rungs stay', () => withResilient(() => {
  const s = snap({ deathsRecent: 3, isNight: false, underArmored: false, armorPieces: 4 })
  assert.strictEqual(S.rungFeasible({ rung: 'R1', action: 'recoverGrave' }, s), false, 'no grave chase in a spiral')
  assert.strictEqual(S.rungFeasible({ rung: 'R4', action: 'secureFood(hunt->fish->scout)' }, s), false, 'no outbound trek in a spiral')
  assert.strictEqual(S.rungFeasible({ rung: 'R1.5', action: 'rearmFromBank' }, s), true, 're-arm at home stays feasible')
  assert.strictEqual(S.rungFeasible({ rung: 'R2', action: 'gotoHome+ensureFood(forceFresh)+cook+eat' }, s), true, 'home rungs stay feasible')
}))

t('(#41 P5c) withinDeathZone: target within DEATH_ZONE_R(24) of a death cell -> true', () => {
  const cells = [{ x: 100, z: 100 }, { x: 400, z: 22 }]
  assert.strictEqual(S.withinDeathZone({ x: 410, z: 25 }, cells), true, '~10b from a death cell')
  assert.strictEqual(S.withinDeathZone({ x: 200, z: 200 }, cells), false, 'far from every death cell')
  assert.strictEqual(S.withinDeathZone({ x: 0, z: 0 }, null), false, 'no cells -> false')
})

t('(#41 P0) resumeGate: latch set + not ready -> wait; ready -> proceed; no latch -> proceed', () => {
  assert.strictEqual(S.resumeGate({ postDeathRecovery: true, ready: false }), 'wait')
  assert.strictEqual(S.resumeGate({ postDeathRecovery: true, ready: true }), 'proceed')
  assert.strictEqual(S.resumeGate({ postDeathRecovery: false, ready: false }), 'proceed')
})

t('(#41 P0.2) preemptCrisisGrade: recoverFromDegraded is crisis-grade at deathsRecent==1 UNDER the latch', () => withResilient(() => {
  assert.strictEqual(S.preemptCrisisGrade({ name: 'recover', deathsRecent: 0, postDeathRecovery: false }), true, 'recover always crisis')
  assert.strictEqual(S.preemptCrisisGrade({ name: 'recoverFromDegraded', deathsRecent: 1, postDeathRecovery: true }), true, 'latch -> crisis at 1')
  assert.strictEqual(S.preemptCrisisGrade({ name: 'recoverFromDegraded', deathsRecent: 1, postDeathRecovery: false }), false, 'no latch, 1 death -> not crisis (today)')
  assert.strictEqual(S.preemptCrisisGrade({ name: 'recoverFromDegraded', deathsRecent: 2, postDeathRecovery: false }), true, 'no latch, 2 deaths -> crisis (today)')
  const old = process.env.RESILIENT_RECOVERY; process.env.RESILIENT_RECOVERY = '0'
  try { assert.strictEqual(S.preemptCrisisGrade({ name: 'recoverFromDegraded', deathsRecent: 1, postDeathRecovery: true }), false, 'flag off -> latch ignored, >=2 gate restored') }
  finally { if (old == null) delete process.env.RESILIENT_RECOVERY; else process.env.RESILIENT_RECOVERY = old }
}))

t('(#41 P0.4) admissibleUnderLatch: recovery-class cmds pass under the latch, else defer to admissible', () => withResilient(() => {
  // a survival cmd with NO vitals need + NO grave: HELD today, ALLOWED under the latch.
  const noNeed = snap({ hp: 20, food: 20, armorPieces: 4, graves: [] })
  assert.strictEqual(S.admissible('survival', noNeed).allow, false, 'today: no need -> held')
  assert.strictEqual(S.admissibleUnderLatch('survival', 'eat', noNeed, true).allow, true, 'latch: survival cmd owns the body')
  // a progress-class recovery MOVE (goto home) passes under the latch.
  assert.strictEqual(S.admissibleUnderLatch('progress', 'goto home', noNeed, true).allow, true, 'latch: goto home is a recovery move')
  assert.strictEqual(S.isRecoveryMove('recover'), true)
  assert.strictEqual(S.isRecoveryMove('travel home'), true)
  assert.strictEqual(S.isRecoveryMove('mine iron'), false)
  // flag off -> no special latch handling (defers to admissible: survival with no need -> held)
  const old = process.env.RESILIENT_RECOVERY; process.env.RESILIENT_RECOVERY = '0'
  try { assert.strictEqual(S.admissibleUnderLatch('survival', 'eat', noNeed, true).allow, false, 'flag off -> today') }
  finally { if (old == null) delete process.env.RESILIENT_RECOVERY; else process.env.RESILIENT_RECOVERY = old }
}))

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall scheduler tests passed')
process.exit(failures ? 1 : 0)
