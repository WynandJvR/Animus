'use strict'
// OFFLINE unit test for the DYNAMIC_CORE Phase 1 choosing layer (bot/scheduler-core.js) - the PURE
// activity chooser (no bot, no clock, no world). Proves the ~20 canonical situations map to the
// expected dispatchable job + a plain-language reason, that a real crisis HARD-DOMINATES every
// utility score, that dusk-recall EMERGES from risk x time-to-nightfall (no per-path gate), that
// bootstrap-vs-build is a live utility trade-off, that the active-job progress bonus damps thrash
// WITHOUT a timer, and that the module reads no clock (same inputs -> same output).
// Run:  cd bot && node schedulercoretest.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const C = require('./scheduler-core.js')

let failures = 0
const rows = [] // situation -> chosen job, for the summary table
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
}
// force one env flag to a value for a test body, restoring it after.
function withEnv (name, val, fn) {
  const old = process.env[name]
  if (val == null) delete process.env[name]; else process.env[name] = val
  try { return fn() } finally { if (old == null) delete process.env[name]; else process.env[name] = old }
}

// ---- fixture: a HEALTHY, SAFE, day, at-home baseline (nothing pressing) ------------------
function snap (over) {
  return Object.assign({
    hp: 20, food: 20, packFoodPts: 0, armorPieces: 4, underArmored: false,
    threatDist: null, creeperDist: null, isNight: false, nightStuck: false,
    drowning: false, onFire: false, inLava: false,
    graves: [], homeDist: 4, homeReachable: true, bankFoodPts: 60, baseLit: true,
    farm: { exists: true }, orchard: {}, gearupBackoffUntil: 0, deathsRecent: 0,
    rawIron: 8, activeJob: null, brainJobPending: false, persistedBuild: true, maintainNeeded: false,
    timeOfDay: 6000 // noon
  }, over || {})
}
function grave (dist, o) { return Object.assign({ dist, value: 30, dangerous: false, hasGear: true }, o || {}) }
// record a row for the printed table (situation -> job)
function choose (label, s, opts) { const c = C.chooseActivity(s, opts || {}); rows.push([label, c.job === null ? 'null (build)' : c.job, c.reason]); return c }

// =========================================================================================
// 1. dusk-far-naked -> nightShelter (go-home). EMERGES from dusk x exposure - no night gate,
//    and even though armor bootstrap is available it LOSES to the more urgent shelter.
t('01 dusk-far-naked -> nightShelter', () => {
  const c = choose('dusk-far-naked', snap({ armorPieces: 0, underArmored: true, homeDist: 80, homeReachable: false, rawIron: 0, baseLit: null, bankFoodPts: 0, farm: { exists: false }, timeOfDay: 12500 }))
  assert.strictEqual(c.job, 'nightShelter', 'far naked at dusk heads home to shelter, got ' + c.job)
  assert.strictEqual(c.cls, 'survival')
  assert(/dusk|shelter|home/i.test(c.reason), 'reason mentions dusk/shelter/home: ' + c.reason)
})

// 2. day-healthy-no-reserve -> maintenancePass (food bootstrap). The calm-window infra build.
t('02 day-healthy-no-reserve -> maintenancePass (bootstrap food)', () => {
  const c = choose('day-healthy-no-reserve', snap({ bankFoodPts: 0, farm: { exists: false } }))
  assert.strictEqual(c.job, 'maintenancePass', 'got ' + c.job)
  assert.strictEqual(c.cls, 'maintain')
  assert.strictEqual(c.bootstrap, 'food')
  assert(/bootstrap food/i.test(c.reason), 'reason: ' + c.reason)
})

// 3. hp1/food0 -> recoveryLadder (compound crisis hard-dominates).
t('03 hp1/food0 -> recoveryLadder', () => {
  const c = choose('hp1/food0', snap({ hp: 1, food: 0, armorPieces: 0 }))
  assert.strictEqual(c.job, 'recoveryLadder', 'got ' + c.job)
  assert.strictEqual(c.cls, 'survival')
  assert.strictEqual(c.score, 1000, 'crisis carries the hard-dominance sentinel score')
  assert(/crisis|degraded|ladder/i.test(c.reason), 'reason: ' + c.reason)
})

// 4. near worthwhile grave -> graveSweep (free gear at arm's reach IS the survival move).
t('04 near worthwhile grave -> graveSweep', () => {
  const c = choose('near-grave', snap({ graves: [grave(10)] }))
  assert.strictEqual(c.job, 'graveSweep', 'got ' + c.job)
  assert.strictEqual(c.cls, 'survival')
  assert(/grave/i.test(c.reason), 'reason: ' + c.reason)
})

// 5. reserve-full + armored + lit -> null (build proceeds). Nothing to bootstrap, safe -> build.
t('05 reserve-full+armored+lit -> null (build proceeds)', () => {
  const c = choose('all-set', snap({}))
  assert.strictEqual(c.job, null, 'build proceeds (null), got ' + c.job)
  assert(/build|resum/i.test(c.reason), 'reason: ' + c.reason)
})

// 6. thrash-resistance: on a NEAR-TIED snapshot the active job STAYS chosen (progress bonus),
//    whichever of the two tied candidates it is. Same snapshot, different active job -> that job.
// Near-tie fixture (shared by 06/20): nightShelter is the slightly HIGHER raw candidate (~0.30),
// maintenancePass(upkeep) the slightly LOWER (~0.234) - a gap (~0.066) INSIDE the progress bonus
// (0.15). So the active-job bonus can flip the winner, which is exactly what 06/20 probe.
function nearTie () {
  return snap({ armorPieces: 4, underArmored: false, baseLit: true, bankFoodPts: 60, homeDist: 10,
    homeReachable: true, timeOfDay: 12834, farm: { exists: true }, maintainNeeded: true, persistedBuild: true })
}
t('06 thrash-resistance: active job stays on a near-tie', () => {
  const tie = nearTie(); const now = 100000
  const keepMaint = C.chooseActivity(tie, { activeJob: 'maintenancePass', activeCls: 'maintain', lastProgressAt: now - 1000, now })
  const keepShelter = C.chooseActivity(tie, { activeJob: 'nightShelter', activeCls: 'survival', lastProgressAt: now - 1000, now })
  assert.strictEqual(keepMaint.job, 'maintenancePass', 'the progress bonus holds active maintenancePass over the slightly-higher nightShelter, got ' + keepMaint.job)
  assert.strictEqual(keepShelter.job, 'nightShelter', 'active nightShelter is held, got ' + keepShelter.job)
  rows.push(['thrash: active=maintenancePass', keepMaint.job, keepMaint.reason])
  rows.push(['thrash: active=nightShelter', keepShelter.job, keepShelter.reason])
})

// 7. no-timer proof: (a) the same inputs (INCLUDING opts.now) yield an identical decision; (b) the
//    source file contains NO Date.now / new Date - the fn holds no clock.
t('07 no-timer: deterministic + no clock read in source', () => {
  const s = snap({ armorPieces: 0, underArmored: true, homeDist: 80, homeReachable: false, timeOfDay: 12500, rawIron: 0 })
  const a = C.chooseActivity(s, { activeJob: 'nightShelter', activeCls: 'survival', lastProgressAt: 5000, now: 6000 })
  const b = C.chooseActivity(s, { activeJob: 'nightShelter', activeCls: 'survival', lastProgressAt: 5000, now: 6000 })
  assert.deepStrictEqual(a, b, 'same inputs -> same output')
  const src = fs.readFileSync(path.join(__dirname, 'scheduler-core.js'), 'utf8')
  assert(!/\bDate\.now\b/.test(src), 'scheduler-core.js must not call Date.now()')
  assert(!/\bnew\s+Date\b/.test(src), 'scheduler-core.js must not call new Date()')
})

// 8. moderate hunger (food 10) -> secureFood via the arbiter guard (below crisis, still survival).
t('08 moderate hunger (food 10) -> secureFood', () => {
  const c = choose('food10', snap({ food: 10 }))
  assert.strictEqual(c.job, 'secureFood', 'got ' + c.job)
  assert.strictEqual(c.cls, 'survival')
})

// 9. naked-healthy-fed, home FAR (day) -> maintenancePass (bootstrap armor; armor needs no home).
t('09 naked healthy, home far, day -> maintenancePass (bootstrap armor)', () => {
  const c = choose('naked-far-day', snap({ armorPieces: 0, underArmored: true, homeDist: 90, homeReachable: false, bankFoodPts: 60, rawIron: 0, farm: { exists: true }, timeOfDay: 6000 }))
  assert.strictEqual(c.job, 'maintenancePass', 'got ' + c.job)
  assert.strictEqual(c.bootstrap, 'armor', 'armor bootstrap needs no home, got ' + c.bootstrap)
})

// 10. melee threat in range -> guard 'flee' (reflex-owned; the tick no-ops it, exactly as pickJob).
t('10 melee threat -> flee (reflex-owned survival guard)', () => {
  const c = choose('threat-melee', snap({ threatDist: 4 }))
  assert.strictEqual(c.job, 'flee', 'threat routes to the reflex-owned flee producer, got ' + c.job)
  assert.strictEqual(c.cls, 'survival')
  assert.strictEqual(c.score, 1000)
})

// 11. ACTIVE build + a bootstrap due -> build CONTINUES (single-goal; bootstrap does not interrupt a
//     running progress job, mirroring pickJob step 4 above step 4b).
t('11 active build + bootstrap due -> build continues (null)', () => {
  const s = snap({ bankFoodPts: 0, farm: { exists: false }, activeJob: { name: 'autobuild', cls: 'progress', lastProgressAt: 9000 } })
  const c = choose('active-build+bootstrap', s, { activeJob: 'autobuild', activeCls: 'progress', lastProgressAt: 9000, now: 10000 })
  assert.strictEqual(c.job, null, 'active build is not interrupted by a bootstrap, got ' + c.job)
  assert.strictEqual(c.preempt, false)
})

// 12. idle, everything satisfied, no build -> null (idle).
t('12 idle, nothing pressing -> null (idle)', () => {
  const c = choose('idle', snap({ persistedBuild: false, brainJobPending: false }))
  assert.strictEqual(c.job, null)
  assert.strictEqual(c.cls, 'idle')
  assert(/idle/i.test(c.reason), 'reason: ' + c.reason)
})

// 13. base UNLIT (armored, reserve full, home reachable, day) -> maintenancePass (bootstrap base).
t('13 base unlit -> maintenancePass (bootstrap base)', () => {
  const c = choose('base-unlit', snap({ baseLit: false }))
  assert.strictEqual(c.job, 'maintenancePass', 'got ' + c.job)
  assert.strictEqual(c.bootstrap, 'base')
})

// 14. naked + a far-but-in-ladder-band grave (out of near-reach) -> recoveryLadder (degraded signature).
t('14 naked + far grave (in ladder band) -> recoveryLadder', () => {
  const c = choose('naked+far-grave', snap({ armorPieces: 0, underArmored: true, graves: [grave(30)] }))
  assert.strictEqual(c.job, 'recoveryLadder', 'degraded (naked w/ reachable grave) runs the ladder, got ' + c.job)
  assert.strictEqual(c.cls, 'survival')
})

// 15. dusk but ARMORED + a food-reserve bootstrap due -> maintenancePass beats a weak dusk signal.
t('15 dusk armored + reserve low -> maintenancePass (food) beats weak dusk', () => {
  const c = choose('dusk-armored-reserve', snap({ armorPieces: 4, underArmored: false, homeDist: 6, homeReachable: true, bankFoodPts: 0, farm: { exists: false }, timeOfDay: 12300 }))
  assert.strictEqual(c.job, 'maintenancePass', 'a strong food bootstrap outscores a low-exposure dusk, got ' + c.job)
  assert.strictEqual(c.bootstrap, 'food')
})

// 16. point-blank creeper -> guard 'flee' (creeper is its own survival need).
t('16 creeper point-blank -> flee', () => {
  const c = choose('creeper', snap({ creeperDist: 3 }))
  assert.strictEqual(c.job, 'flee')
  assert.strictEqual(c.cls, 'survival')
})

// 17. death ratchet at night (>=2 recent deaths, night) -> recoveryLadder (degraded ratchet).
t('17 death-ratchet at night -> recoveryLadder', () => {
  const c = choose('ratchet-night', snap({ deathsRecent: 2, isNight: true, timeOfDay: 15000, armorPieces: 4, underArmored: false }))
  assert.strictEqual(c.job, 'recoveryLadder', 'the ratchet degraded signature runs the ladder, got ' + c.job)
})

// 18. crisis while an ACTIVE build is running -> PREEMPT true (survival out-ranks progress).
t('18 crisis vs active build -> preempt=true', () => {
  const s = snap({ food: 0, hp: 1, armorPieces: 0, activeJob: { name: 'autobuild', cls: 'progress' } })
  const c = choose('crisis-vs-build', s, { activeJob: 'autobuild', activeCls: 'progress', now: 10000, lastProgressAt: 9000 })
  assert.strictEqual(c.cls, 'survival')
  assert.strictEqual(c.preempt, true, 'a survival crisis preempts a busy build')
})

// 19. bootstrap while IDLE -> maintenancePass with preempt=false (maintain never preempts; no victim).
t('19 bootstrap while idle -> maintenancePass, preempt=false', () => {
  const c = choose('bootstrap-idle', snap({ bankFoodPts: 0, farm: { exists: false }, activeJob: null }))
  assert.strictEqual(c.job, 'maintenancePass')
  assert.strictEqual(c.preempt, false, 'maintain rank cannot preempt; and there is no active victim')
})

// 20. hysteresis is PROGRESS-gated, not a clock: on the SAME near-tie, if the active job is NOT
//     making progress (lastProgressAt stale) the bonus is GONE and the tie breaks by tier
//     (survival > maintain) -> nightShelter wins, NOT the stalled maintenancePass. Proves the
//     bonus needs live progress, so the core can never latch onto a stuck job the way a timer would.
t('20 stalled active job loses the bonus (no time-latch)', () => {
  const tie = nearTie(); const now = 100000
  const stalled = C.chooseActivity(tie, { activeJob: 'maintenancePass', activeCls: 'maintain', lastProgressAt: now - 999000, now }) // far stale
  assert.strictEqual(stalled.job, 'nightShelter', 'a stalled maintenancePass loses its bonus; the higher raw candidate (nightShelter) now wins - progress-gated, not a timer, got ' + stalled.job)
  rows.push(['stalled active=maintenancePass (no progress)', stalled.job, stalled.reason])
})

// ---- summary table ----------------------------------------------------------------------
console.log('\nSITUATION -> CHOSEN JOB')
console.log('-'.repeat(96))
for (const [sit, job, reason] of rows) {
  console.log('  ' + sit.padEnd(40) + ' -> ' + String(job).padEnd(16) + ' | ' + String(reason).slice(0, 60))
}
console.log('-'.repeat(96))

if (failures) { console.log('\n' + failures + ' FAILURE(S)'); process.exit(1) }
console.log('\nALL PASS')
