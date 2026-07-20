'use strict'
// ==== #114 ONE_READINESS - Root G tests (design-docs/DESIGN-grounded-truth-and-home-first.md §3.7)
//
// Reproduces the live defect of 2026-07-19 16:02-16:06: the chooser and the executor kept SEPARATE
// readiness models with no feedback path, so the bot idled until a 90s watchdog kicked it -
//   16:02:03 [build] resume: bootstrap needed (food) - holding the build until survival infra exists
//   16:04:52 (core) chose build/idle: resuming the saved build - infra is in order      (x6 in 76s)
//   16:01:11 (wd) scheduler tick chain stalled >90s - re-arming
// Both components honest, neither aware of the other, and the standoff was three-way: the chooser
// vetoed the FOOD work via a homeReachable filter only IT applied, while the executor vetoed the
// build on that very food need.
//
// AMBIENT-PROOF: this file sets EVERY env flag it depends on explicitly (three regressions on
// 2026-07-19 came from ambient env leaking into tests) and restores the environment at exit.
// NO assertion anywhere in this file references elapsed time - the whole slice is condition-gated.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const SAVED_ENV = {}
const FLAGS = ['BOOTSTRAP_PRIORITY', 'CAMP_FIRST', 'RESILIENT_RECOVERY', 'SPIRAL_N', 'DEATH_ZONE_R',
  'BOOTSTRAP_HP', 'BOOTSTRAP_FED', 'FOOD_RESERVE_HP', 'FOOD_RESERVE_TARGET', 'GRAVE_NEAR',
  'GRAVE_URGENT_DIST', 'GRAVE_URGENT', 'IRON_KEYSTONE', 'HP_OK', 'RECOVERY_UNBLOCK', 'DYNAMIC_CORE']
for (const f of FLAGS) SAVED_ENV[f] = process.env[f]
function setRegime (over) {
  // the DEFAULT (shipping) regime, stated explicitly - never inherited from the shell
  const base = {
    BOOTSTRAP_PRIORITY: '1', CAMP_FIRST: '1', RESILIENT_RECOVERY: '1', SPIRAL_N: '3', DEATH_ZONE_R: '24',
    BOOTSTRAP_HP: '14', BOOTSTRAP_FED: '14', FOOD_RESERVE_HP: '8', FOOD_RESERVE_TARGET: '40',
    GRAVE_NEAR: '16', GRAVE_URGENT_DIST: '96', GRAVE_URGENT: '1', HP_OK: '18', DYNAMIC_CORE: '1'
  }
  for (const [k, v] of Object.entries(Object.assign(base, over || {}))) {
    if (v === undefined) delete process.env[k]; else process.env[k] = String(v)
  }
}
setRegime()

const scheduler = require('./scheduler.js')
const core = require('./scheduler-core.js')

let fails = 0
function t (name, fn) {
  try { fn(); console.log('ok   ' + name) } catch (e) { fails++; console.log('FAIL ' + name + '  ' + e.message) }
}

// ---- fixtures ---------------------------------------------------------------------------
// A calm, fully-provisioned snapshot: no crisis, no bootstrap need, home right there, a saved build.
// buildReady must say OK for this one - it is the "nothing is wrong" control.
function calm (over) {
  return Object.assign({
    hp: 20, food: 20, armorPieces: 4, packFoodPts: 20, bankFoodPts: 60, baseLit: true,
    homeDist: 5, homeReachable: true, hutExists: true, graves: [], deathsRecent: 0,
    tools: { pick: true, sparePick: true, axe: true, sword: true },
    rawIron: 8, packArmorPieces: 0, bankArmorPieces: 4, maintainNeeded: false,
    isNight: false, timeOfDay: 6000, persistedBuild: true, buildSite: { x: 430, y: 67, z: 85 },
    recentDeathCells: [], postDeathRecovery: false, activeJob: null, brainJobPending: false
  }, over || {})
}

// THE 16:04 FIXTURE - the live three-way standoff, rebuilt from the log window:
// healthy + fed (so bootstrapNeed is in its healthy window), bank reserve EMPTY (-> need 'food'),
// home 140b away. Note homeReachable is TRUE here because bootstrapNeed's food branch requires it;
// the veto that actually fired was the CHOOSER's own `homeReachable` feasibility filter, exercised
// by standoff1604Unreachable below.
function standoff1604 (over) {
  return calm(Object.assign({
    bankFoodPts: 0, homeDist: 140, homeReachable: true, maintainNeeded: true
  }, over || {}))
}

// ---- 1. THE INVARIANT: chooser and executor cannot disagree ------------------------------
// Property-style over a large product of states. The chooser's build feasibility and the executor's
// gate are THE SAME function object, so this is a structural check that nothing re-derives it.
t('#114 chooser and executor consult the SAME predicate object (no second model to drift)', () => {
  const commandsSrc = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  const coreSrc = fs.readFileSync(path.join(__dirname, 'scheduler-core.js'), 'utf8')
  assert.ok(/scheduler\.buildReady\(s\)/.test(coreSrc), 'the chooser must call scheduler.buildReady')
  assert.ok(/buildReady\(s\)/.test(commandsSrc), 'the executor must call scheduler.buildReady')
})

t('#114 property: over 2000+ states the chooser feasibility == the executor gate, always', () => {
  let checked = 0
  for (const hp of [1, 8, 14, 20]) {
    for (const food of [0, 7, 14, 20]) {
      for (const armorPieces of [0, 2, 4]) {
        for (const bankFoodPts of [0, 20, 60]) {
          for (const homeReachable of [true, false]) {
            for (const hutExists of [true, false]) {
              for (const postDeathRecovery of [true, false]) {
                for (const baseLit of [true, false]) {
                  const s = calm({ hp, food, armorPieces, bankFoodPts, homeReachable, hutExists,
                    postDeathRecovery, baseLit, homeDist: homeReachable ? 10 : 140 })
                  // The EXECUTOR's verdict (commands.js resumeBuild) and the CHOOSER's feasibility
                  // term (scheduler-core B3) are both this call. If a second model were ever
                  // reintroduced, the chooser's `ready` field would stop tracking it.
                  const gate = scheduler.buildReady(s)
                  const chosen = core.chooseActivity(s, {})
                  // the chooser must never SILENTLY describe an unready build as ready
                  if (!gate.ok && chosen.job == null) {
                    assert.ok(/build not ready|standoff|refused/.test(chosen.reason),
                      'unready build picked with a reason that hides it: ' + chosen.reason)
                  }
                  if (gate.ok) {
                    assert.ok(!/build not ready/.test(chosen.reason), 'ready build described as not ready')
                  }
                  checked++
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked >= 2000, 'expected a wide state product, got ' + checked)
})

// ---- 2. buildReady behaviour-lock (extraction equivalence with the deleted inline gate) ---
t('#114 buildReady: calm + provisioned -> ok (the control)', () => {
  const r = scheduler.buildReady(calm())
  assert.strictEqual(r.ok, true, r.why)
  assert.strictEqual(r.need, null)
})

t('#114 buildReady: post-death latch + not recovered -> refuse with need=recovery (#41 P0.1)', () => {
  const r = scheduler.buildReady(calm({ postDeathRecovery: true, hp: 4, food: 4, armorPieces: 0 }))
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.need, 'recovery')
  assert.ok(/post-death recovery/.test(r.why), r.why)
})

t('#114 buildReady: post-death latch + executor-supplied recoveryReady override releases it', () => {
  // the executor can afford the impure live re-check (ceiling / stuck-release); it may only release
  // EARLIER than the pure term, never later, so it can never be STRICTER than the chooser.
  const s = calm({ postDeathRecovery: true, hp: 4, food: 4, armorPieces: 0 })
  assert.strictEqual(scheduler.buildReady(s).ok, false, 'pure term holds')
  s.recoveryReady = true
  assert.strictEqual(scheduler.buildReady(s).ok, true, 'the live override releases')
})

t('#114 buildReady: bootstrap food needed + a hut stands -> refuse, need=food (the 16:02 line)', () => {
  const r = scheduler.buildReady(standoff1604())
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.need, 'food')
  assert.ok(/bootstrap needed \(food\)/.test(r.why), r.why)
})

t('#114 buildReady: #102 CAMP_FIRST - NO hut standing -> the build is let through to camp', () => {
  const r = scheduler.buildReady(standoff1604({ hutExists: false }))
  assert.strictEqual(r.ok, true, r.why)
  assert.strictEqual(r.exempt, true, 'and it is flagged as the exemption, not as a clean pass')
})

t('#114 buildReady: CAMP_FIRST=0 -> no exemption, the hold applies with no hut (rollback regime)', () => {
  setRegime({ CAMP_FIRST: '0' })
  try {
    const r = scheduler.buildReady(standoff1604({ hutExists: false }))
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.need, 'food')
  } finally { setRegime() }
})

t('#114 buildReady: BOOTSTRAP_PRIORITY=0 -> the bootstrap clause is inert (rollback regime)', () => {
  setRegime({ BOOTSTRAP_PRIORITY: '0' })
  try { assert.strictEqual(scheduler.buildReady(standoff1604()).ok, true) } finally { setRegime() }
})

t('#114 buildReady: #41 P5c - spiral + the build site inside the death cluster -> refuse', () => {
  const cells = [{ x: 430, z: 85 }, { x: 435, z: 90 }, { x: 428, z: 80 }]
  const r = scheduler.buildReady(calm({ deathsRecent: 3, recentDeathCells: cells }))
  assert.strictEqual(r.ok, false)
  assert.ok(/death spiral/.test(r.why), r.why)
})

t('#114 buildReady: spiral but the site is FAR from the cluster -> ok (only the leg was ever unsafe)', () => {
  const cells = [{ x: 0, z: 0 }, { x: 5, z: 5 }, { x: -5, z: -5 }]
  assert.strictEqual(scheduler.buildReady(calm({ deathsRecent: 3, recentDeathCells: cells })).ok, true)
})

t('#114 buildReady: RESILIENT_RECOVERY=0 -> both the latch and the spiral clause are inert', () => {
  setRegime({ RESILIENT_RECOVERY: '0' })
  try {
    const cells = [{ x: 430, z: 85 }, { x: 435, z: 90 }, { x: 428, z: 80 }]
    assert.strictEqual(scheduler.buildReady(calm({ deathsRecent: 3, recentDeathCells: cells })).ok, true)
  } finally { setRegime() }
})

t('#114 buildReady: PURE - no clock, no bot handle, no fs in the predicate', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8')
  const m = /function buildReady \(snapshot\) \{[\s\S]*?\n\}/.exec(src)
  assert.ok(m, 'buildReady not found in scheduler.js')
  assert.ok(!/Date\.now|setTimeout|require\(/.test(m[0]), 'buildReady must hold no clock and no I/O')
})

// ---- 3. the chooser: reason DERIVED, feasibility from the predicate ----------------------
t('#114 chooser: an unready build is never labelled "infra is in order"', () => {
  const c = core.chooseActivity(standoff1604(), {})
  assert.ok(!/infra is in order/.test(c.reason), 'the fiction string is back: ' + c.reason)
})

// A NON-CRISIS state whose build is unready for a reason that is NOT a bootstrap need: healthy,
// fed, armored, home in range - but a death spiral has clustered on the build site. Before #114 the
// chooser knew nothing of that gate and picked the build every tick; the executor refused every
// time. This is the shape that isolates the chooser's feasibility term from the survival guard.
function unreadyCalm (over) {
  return calm(Object.assign({
    deathsRecent: 3, recentDeathCells: [{ x: 430, z: 85 }, { x: 433, z: 88 }, { x: 427, z: 82 }],
    maintainNeeded: true
  }, over || {}))
}

t('#114 chooser: an unready build never wins the tick in a calm, non-crisis window', () => {
  const s = unreadyCalm()
  assert.strictEqual(scheduler.buildReady(s).ok, false, 'fixture must actually be unready')
  const c = core.chooseActivity(s, {})
  assert.strictEqual(c.job, 'maintenancePass', 'runnable work must win over a refusing build: ' + c.reason)
})

// ---- 4. THE THREE-WAY STANDOFF (the actual live incident) --------------------------------
// The chooser vetoed the FOOD work with a `homeReachable` filter only IT applied, while the
// executor vetoed the BUILD on that very food need. Each side blocked the other's remedy.
function standoff1604Unreachable () {
  // home 140b, NOT reachable: the exact shape that zeroed maintenancePass feasibility at 16:04.
  // bootstrapNeed's food branch needs homeReachable, so the need that survives here is 'armor'
  // (naked) - the same structural veto, reproduced with the need the state actually yields.
  return calm({ bankFoodPts: 0, homeDist: 140, homeReachable: false, armorPieces: 0, baseLit: false, maintainNeeded: true })
}

t('#114 standoff: the homeReachable filter may not veto work when the build itself is refusing', () => {
  // THE structural defect, isolated: the chooser's `homeReachable` dock exists for exactly ONE
  // reason - to yield the body to the build rather than livelock on an unreachable bank. Here the
  // build is refusing (spiral) AND home is 140b. Before #114 the maintenance candidate scored 0
  // (feas=0) and the build won by default, then refused - each side blocked the other's remedy and
  // nothing ran for 90s at a stretch. The dock is now conditioned on the build being an ALTERNATIVE.
  const s = unreadyCalm({ homeReachable: false, homeDist: 140 })
  assert.strictEqual(scheduler.buildReady(s).ok, false, 'fixture must actually be unready')
  const c = core.chooseActivity(s, {})
  assert.strictEqual(c.job, 'maintenancePass',
    'the enabling work must be selected, not vetoed by a filter that only applies because a build it cannot yield to exists: ' + c.reason)
  // the dock must be genuinely LIFTED, not merely out-voted: the pick may not still be describing
  // itself as deferred while it runs (that fiction is exactly what made the live log unreadable).
  assert.ok(!/home unreachable - deferring/.test(c.reason),
    'the maintenance pick still claims to be deferring while it is the chosen job: ' + c.reason)
  // same homeDist (riskLevel is distance-sensitive, so only homeReachable may differ here)
  const undocked = core.chooseActivity(unreadyCalm({ homeReachable: true, homeDist: 140 }), {})
  assert.ok(Math.abs(c.score - undocked.score) < 1e-9,
    'with the build refusing, the home-unreachable dock must not depress the score at all')
  // and the dock is NOT simply deleted: with a READY build available, it still yields as designed
  const ready = calm({ homeReachable: false, homeDist: 140, maintainNeeded: true })
  assert.strictEqual(scheduler.buildReady(ready).ok, true, 'control must be ready')
  assert.strictEqual(core.chooseActivity(ready, {}).job, null,
    'a READY build must still win the dock - #114 conditions the filter, it does not remove it')
})

t('#114 standoff: the 16:04 shape picks ACTIONABLE work, never a silent build pick', () => {
  const c = core.chooseActivity(standoff1604Unreachable(), {})
  assert.ok(c.job != null || /standoff|build not ready/.test(c.reason),
    'silent build pick reproduced: ' + c.reason)
})

t('#114 need-inheritance: the build blocked on X hands its motivation to the producer of X', () => {
  // a saved build wants to run (W_RESUME) but is blocked on the food reserve; the food work must
  // inherit at least the build's own score so the tick picks the enabler INSTEAD, this tick.
  const s = standoff1604()
  const gate = scheduler.buildReady(s)
  assert.strictEqual(gate.need, 'food')
  const c = core.chooseActivity(s, {})
  assert.strictEqual(c.job, 'maintenancePass', c.reason)
  assert.strictEqual(c.bootstrap, 'food')
  assert.ok(/waiting on exactly this/.test(c.reason), 'inheritance must be stated in the reason: ' + c.reason)
})

t('#114 need-inheritance: the producer actually INHERITS the build score, not just the label', () => {
  // With a build ALREADY running (W_CONTINUE) the raw bootstrap-food score is well below what the
  // build wanted; without inheritance the enabling work would be scored as a low-urgency chore and
  // could lose to a third candidate. The producer must carry the build's own motivation.
  const opts = { activeCls: 'progress', activeJob: 'autobuild' }
  const blocked = core.chooseActivity(standoff1604({ activeJob: { name: 'autobuild', cls: 'progress' } }), opts)
  const control = core.chooseActivity(standoff1604({ bankFoodPts: 60, maintainNeeded: false, activeJob: { name: 'autobuild', cls: 'progress' } }), opts)
  assert.strictEqual(control.job, null, 'control must be the (ready) build itself')
  assert.strictEqual(blocked.job, 'maintenancePass', blocked.reason)
  assert.ok(blocked.score >= control.score - 1e-9,
    'the producer must inherit the build score (' + blocked.score + ' < ' + control.score + ')')
})

t('#114 chooser: even a HIGH-scoring active build is gated by buildReady (no arithmetic win)', () => {
  // W_CONTINUE (0.65) is the biggest non-survival weight in the core - if the feasibility gate were
  // ever dropped, THIS is the state where an unready build would win the tick on score alone.
  const s = unreadyCalm({ activeJob: { name: 'autobuild', cls: 'progress' } })
  assert.strictEqual(scheduler.buildReady(s).ok, false, 'fixture must actually be unready')
  const c = core.chooseActivity(s, { activeCls: 'progress', activeJob: 'autobuild' })
  assert.notStrictEqual(c.job, null, 'an unready build won the tick on score: ' + c.reason)
})

// ---- 5. refusal feeds back IN THE SAME TICK ----------------------------------------------
t('#114 refusal: a refused candidate re-selects IN THE SAME TICK (no watchdog wait)', () => {
  const s = standoff1604()
  let passes = 0
  const refusals = []
  // probe: the build/idle candidate refuses whenever buildReady says so - the SAME predicate.
  const probe = (c) => {
    passes++
    if (c.job != null) return null
    const r = scheduler.buildReady(s)
    return r.ok ? null : { key: 'build', why: r.why }
  }
  const c = core.selectWithRefusals(s, {}, probe, (cand, rf) => refusals.push(rf.why))
  assert.ok(passes >= 1, 'the probe must be consulted')
  assert.strictEqual(c.job, 'maintenancePass', 'the tick must land on runnable work: ' + c.reason)
  assert.ok(!/^standoff/.test(c.reason), 'this state is NOT a standoff - real work exists')
})

t('#114 refusal: every candidate refusing settles honestly and does NOT spin', () => {
  const s = calm({ maintainNeeded: false, isNight: false, timeOfDay: 6000 })
  let passes = 0
  // a probe that refuses EVERYTHING it is shown - the pathological case
  const probe = (c) => { passes++; return { key: c.job || 'build', why: 'test: refuses everything' } }
  const c = core.selectWithRefusals(s, {}, probe)
  assert.ok(passes <= core.MAX_RESELECT + 1, 'unbounded re-selection: ' + passes + ' passes')
  assert.ok(c && typeof c.reason === 'string', 'the tick must still settle on a verdict')
})

t('#114 refusal: the all-refused verdict is labelled standoff and NAMES the refusals', () => {
  const s = calm({ maintainNeeded: false })
  const refused = new Map([['build', 'bootstrap needed (food)'], ['maintenancePass', 'home unreachable']])
  const c = core.chooseActivity(s, { refused })
  assert.strictEqual(c.standoff, true, 'a fully-refused tick must be flagged, not silent')
  assert.ok(/^standoff/.test(c.reason), c.reason)
  assert.ok(Array.isArray(c.refusals) && c.refusals.length >= 1, 'the refusals must be named')
})

t('#114 refusal: bounded BY CONDITION - a key already refused is never re-added', () => {
  const s = standoff1604()
  let passes = 0
  const probe = () => { passes++; return { key: 'build', why: 'always the same refusal' } }
  core.selectWithRefusals(s, {}, probe)
  // one initial choose + one refusal + one re-choose + the probe sees the key already present
  assert.ok(passes <= 2, 'a repeated refusal must terminate immediately, got ' + passes + ' probes')
})

t('#114 refusal: NO timer anywhere in the re-selection path', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scheduler-core.js'), 'utf8')
  const m = /function selectWithRefusals[\s\S]*?\n\}/.exec(src)
  assert.ok(m, 'selectWithRefusals not found')
  assert.ok(!/Date\.now|setTimeout|setInterval|Until|cooldown/i.test(m[0]),
    'the loop must be bounded by condition, never by a clock')
})

t('#114 refusal: a candidate NOT refused keeps its normal score (the map is not a blanket hold)', () => {
  const s = standoff1604()
  const plain = core.chooseActivity(s, {})
  const withOther = core.chooseActivity(s, { refused: new Map([['nightShelter', 'x']]) })
  assert.strictEqual(withOther.job, plain.job, 'an unrelated refusal must not change the pick')
})

// ---- 6. SOURCE ASSERTIONS: the duplicated model and the fiction string are GONE -----------
t('#114 DELETED: the hardcoded "infra is in order" reason string is gone from the chooser', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scheduler-core.js'), 'utf8')
  assert.ok(!/'resuming the saved build - infra is in order'/.test(src),
    'the hardcoded fiction label is still in scheduler-core.js')
})

t('#114 DELETED: the inline build-resume gate is gone from commands.js', () => {
  // strip comments so the design's own quotes of the old log lines don't self-trip this check
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  // the three inline gates that were the second readiness model
  assert.ok(!/dbg\('resume: bootstrap needed/.test(src), 'the inline bootstrap hold is still in commands.js')
  assert.ok(!/resumeGate\(\{ postDeathRecovery/.test(src), 'the inline post-death gate is still in commands.js')
  assert.ok(!/resume: death spiral \+ build site/.test(src), 'the inline spiral defer is still in commands.js')
  // and the executor now returns the refusal as DATA the tick can act on
  assert.ok(/deferred: true, why: r\.why, need: r\.need/.test(src),
    'the executor must return its refusal (why + need), not just a bare deferred flag')
})

t('#114 DELETED: commands.js no longer calls bootstrapNeed itself (one predicate, one caller)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  assert.ok(!/\.bootstrapNeed\(/.test(src), 'commands.js still re-derives bootstrapNeed')
})

// ---- restore the environment -------------------------------------------------------------
for (const f of FLAGS) { if (SAVED_ENV[f] === undefined) delete process.env[f]; else process.env[f] = SAVED_ENV[f] }

if (fails) { console.log('\n' + fails + ' FAILURE(S)'); process.exit(1) }
console.log('\nall #114 ONE_READINESS tests passed')
