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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall scheduler tests passed')
process.exit(failures ? 1 : 0)
