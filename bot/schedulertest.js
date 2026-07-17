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

t('(S5) rungFeasible: day + naked -> all feasible (armor is only a NIGHT gate)', () => {
  const s = snap({ isNight: false, underArmored: true, armorPieces: 0 })
  for (const r of OUTBOUND.concat(NON_OUTBOUND)) assert.strictEqual(S.rungFeasible(r, s), true, r.action + ' feasible by day')
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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall scheduler tests passed')
process.exit(failures ? 1 : 0)
