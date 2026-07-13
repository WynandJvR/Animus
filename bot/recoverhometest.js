'use strict'
// OFFLINE unit test for the pure "am I far from home -> go home" decision
// (provision.homeRecoveryDecision) - no bot, no world. Run: cd bot && node recoverhometest.js
//
// The live bug it guards: hut bed creeper-destroyed -> respawn at WORLD SPAWN (0,65,1) ~570b
// from the hut (414,65,85) -> bot geared up in the wilderness and NEVER went home. The
// decision must say "far -> go home" for that case, pick the HUT over a lone bed / build site,
// and NOT trek home when we already respawned at (or near) the bed.
const P = require('./provision.js')

let failures = 0
function eq (got, want, label) {
  const g = JSON.stringify(got); const w = JSON.stringify(want)
  const ok = g === w
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok ? '' : `  got ${g} want ${w}`))
}

const hut = { x: 414, y: 65, z: 85 }
const bed = { x: 500, y: 70, z: 300 }
const resumeAt = { x: 430, y: 67, z: 85 }
const worldSpawn = { x: 0, y: 65, z: 1 } // where the destroyed-bed respawn dumped it

// ---- THE LIVE BUG: respawned at world spawn, hut exists -> far, aim at the HUT --------
{
  const d = P.homeRecoveryDecision({ hut, pos: worldSpawn, dist: 64 })
  eq(d.far, true, 'world spawn ~425b from hut -> FAR (go home)')
  eq(d.source, 'hut', 'far respawn aims at the hut')
  eq(d.anchor, { x: 416, y: 65, z: 87 }, 'hut anchor is +2,+2 into the footprint (stand inside)')
  eq(Math.round(d.dist), 425, 'distance is the XZ hypot to the hut stand-point')
}

// ---- anchor PRIORITY: hut > bed > resume-site ---------------------------------------
eq(P.homeRecoveryDecision({ hut, bed, resumeAt, pos: worldSpawn, dist: 64 }).source, 'hut', 'hut wins when all three known')
eq(P.homeRecoveryDecision({ bed, resumeAt, pos: worldSpawn, dist: 64 }).source, 'bed', 'bed wins when no hut')
eq(P.homeRecoveryDecision({ resumeAt, pos: worldSpawn, dist: 64 }).source, 'resume', 'build site is the last-resort anchor')
eq(P.homeRecoveryDecision({ resumeAt, pos: worldSpawn, dist: 64 }).anchor, resumeAt, 'resume anchor is the raw build site (no +2 offset)')
eq(P.homeRecoveryDecision({ bed, pos: worldSpawn, dist: 64 }).anchor, bed, 'bed anchor is the raw bed (no +2 offset)')

// ---- NOT far: already home (respawned AT the hut bed) -> do nothing -------------------
{
  const d = P.homeRecoveryDecision({ hut, pos: { x: 416, y: 66, z: 88 }, dist: 64 })
  eq(d.far, false, 'respawned inside the hut -> NOT far, stay and work')
}
// Just inside the threshold ring -> not far (no needless trek for a short hop).
eq(P.homeRecoveryDecision({ hut, pos: { x: 416 + 60, y: 65, z: 87 }, dist: 64 }).far, false, '60b out (<64) -> not far')
// Just outside the threshold ring -> far.
eq(P.homeRecoveryDecision({ hut, pos: { x: 416 + 70, y: 65, z: 87 }, dist: 64 }).far, true, '70b out (>64) -> far')

// ---- Y is IGNORED (respawn Y varies; "far" is horizontal) ---------------------------
eq(P.homeRecoveryDecision({ hut, pos: { x: 416, y: 5, z: 87 }, dist: 64 }).far, false, 'right above/below home but deep underground -> not far (XZ only)')

// ---- no anchor at all -> never "far" (nothing to trek to; honest no-op) ---------------
eq(P.homeRecoveryDecision({ pos: worldSpawn, dist: 64 }).far, false, 'no hut/bed/resume -> not far (no home to go to)')
eq(P.homeRecoveryDecision({ pos: worldSpawn, dist: 64 }).anchor, null, 'no anchor -> null')
// no position -> cannot decide -> not far.
eq(P.homeRecoveryDecision({ hut, dist: 64 }).far, false, 'no position -> not far')

// ---- threshold comes from RECOVER_HOME_DIST when dist not passed ---------------------
{
  const saved = process.env.RECOVER_HOME_DIST
  process.env.RECOVER_HOME_DIST = '1000'
  eq(P.homeRecoveryDecision({ hut, pos: worldSpawn }).far, false, 'RECOVER_HOME_DIST=1000 -> 425b not far')
  process.env.RECOVER_HOME_DIST = '32'
  eq(P.homeRecoveryDecision({ hut, pos: worldSpawn }).far, true, 'RECOVER_HOME_DIST=32 -> 425b far')
  delete process.env.RECOVER_HOME_DIST
  eq(P.homeRecoveryDecision({ hut, pos: worldSpawn }).far, true, 'default 64 -> 425b far')
  if (saved != null) process.env.RECOVER_HOME_DIST = saved
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
