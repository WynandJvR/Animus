'use strict'
// Offline tests for death-cause.js (AUDIT 2026-07-29, defect D3: 32 of 34 deaths were `unknown`).
// Everything under test is PURE - no bot, no server, no clock (the clock is injected).
const dc = require('./death-cause.js')

let fails = 0
function ok (cond, name) { if (cond) console.log('PASS  ' + name); else { console.log('FAIL  ' + name); fails++ } }
function eq (a, b, name) { ok(a === b, name + (a === b ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)) }

// ---- LAYER 1: the server's own death message ------------------------------------------
const U = 'Animus'
const cause = (t) => { const r = dc.parseDeathMessage(t, U); return r && r.cause }
const who = (t) => { const r = dc.parseDeathMessage(t, U); return r && r.attacker }

eq(cause('Animus was shot by Skeleton'), 'mob', 'message: shot by a skeleton -> mob')
eq(who('Animus was shot by Skeleton'), 'Skeleton', 'message: names the killer')
eq(cause('Animus was slain by Zombie'), 'mob', 'message: slain by -> mob')
eq(who('Animus was slain by Zombie using Iron Sword'), 'Zombie', 'message: "using <item>" is stripped from the killer')
eq(cause('Animus was blown up by Creeper'), 'explosion', 'message: blown up -> explosion (not mob)')
eq(cause('Animus fell from a high place'), 'fall', 'message: fell from a high place -> fall')
eq(cause('Animus hit the ground too hard'), 'fall', 'message: hit the ground too hard -> fall')
eq(cause('Animus drowned'), 'drowning', 'message: drowned')
eq(cause('Animus tried to swim in lava'), 'lava', 'message: swam in lava')
eq(cause('Animus burned to death'), 'fire', 'message: burned to death -> fire')
eq(cause('Animus starved to death'), 'starvation', 'message: starved')
eq(cause('Animus suffocated in a wall'), 'suffocation', 'message: suffocated')
eq(cause('Animus fell out of the world'), 'void', 'message: fell out of the world -> void')
eq(cause('Animus was pricked to death'), 'cactus', 'message: cactus')
eq(cause('Animus withered away'), 'magic', 'message: withered -> magic')
eq(cause('Animus was struck by lightning'), 'lightning', 'message: lightning')
eq(cause('Animus froze to death'), 'freezing', 'message: froze')

// The vocabulary must stay a SUPERSET of grave-policy's, so causeWritesOff / HAZARD_MEDIUM keep
// working on the causes they already knew.
const gp = require('./grave-policy.js')
ok(gp.causeWritesOff('lava') && gp.causeWritesOff('fire') && gp.causeWritesOff('void'),
  'vocabulary: the three write-off causes keep their exact spelling')
ok(!gp.causeWritesOff('mob') && !gp.causeWritesOff('explosion') && !gp.causeWritesOff('fall'),
  'vocabulary: the NEW causes are not write-offs (the gear is still lying there)')

// ---- impersonation / false-positive guards --------------------------------------------
eq(dc.parseDeathMessage('<Steve> Animus was shot by Skeleton lol', U), null,
  'guard: a CHAT line that merely mentions the bot is not a death report')
eq(dc.parseDeathMessage('AnimusBot fell from a high place', U), null,
  'guard: a prefix match on a different player is not our death')
eq(dc.parseDeathMessage('Steve was shot by Skeleton', U), null,
  'guard: another player dying is not our death')
eq(dc.parseDeathMessage('Animus joined the game', U), null,
  'guard: a non-death message about us returns null')
eq(dc.parseDeathMessage('Animus was shot by Skeleton', null), null,
  'guard: no username -> no attribution (never guess)')
eq(dc.parseDeathMessage('', U), null, 'guard: empty line')

// ---- LAYER 2: the damage log ----------------------------------------------------------
const T = 1000000
const s = (over) => Object.assign({ t: T, drop: 2, hostile: null, inWater: false, inLava: false, buried: false, onFire: false, drowning: false, falling: false, foodZero: false }, over)

eq(dc.causeFromDamage([], { now: T }), null, 'damage: an empty log says nothing (never invents a cause)')
eq(dc.causeFromDamage([s({ t: T - 60000, hostile: { type: 'zombie', dist: 2 } })], { now: T }), null,
  'damage: samples older than the window are ignored')
eq(dc.causeFromDamage([s({ hostile: { type: 'skeleton', dist: 4 }, drop: 3 })], { now: T }), 'mob',
  'damage: a hostile in reach while we bled -> mob (the case the old classifier could not represent)')
eq(dc.causeFromDamage([s({ hostile: { type: 'skeleton', dist: 14 }, drop: 3 })], { now: T }), 'mob',
  'damage: a RANGED killer out of melee range still reads as mob')
eq(dc.causeFromDamage([s({ hostile: { type: 'creeper', dist: 2 }, drop: 12 })], { now: T }), 'explosion',
  'damage: one huge creeper hit -> explosion')
eq(dc.causeFromDamage([s({ hostile: { type: 'creeper', dist: 2 }, drop: 2 })], { now: T }), 'mob',
  'damage: a creeper that merely walked into us is not an explosion')
eq(dc.causeFromDamage([s({ inLava: true, hostile: { type: 'zombie', dist: 1 } })], { now: T }), 'lava',
  'damage: standing in lava outranks a mob stood next to us')
eq(dc.causeFromDamage([s({ inWater: true, drowning: true })], { now: T }), 'drowning', 'damage: submerged + bleeding -> drowning')
eq(dc.causeFromDamage([s({ buried: true })], { now: T }), 'suffocation', 'damage: a solid block at the head -> suffocation')
eq(dc.causeFromDamage([s({ falling: true, drop: 9 })], { now: T }), 'fall', 'damage: a big hit while falling -> fall')
eq(dc.causeFromDamage([s({ foodZero: true, drop: 1 }), s({ foodZero: true, drop: 1 })], { now: T }), 'starvation',
  'damage: repeated small ticks at food 0 -> starvation')
eq(dc.causeFromDamage([s({ foodZero: true, drop: 1 }), s({ foodZero: true, drop: 6, hostile: { type: 'zombie', dist: 2 } })], { now: T }), 'mob',
  'damage: a hungry bot BEATEN to death died of the zombie, not of hunger')

// ---- LAYER 3: composition + precedence ------------------------------------------------
eq(dc.attributeDeath({ message: 'Animus was shot by Skeleton', username: U, samples: [s({ inLava: true })], blockCause: 'lava', now: T }).source,
  'message', 'compose: the server message outranks both the damage log and the block reads')
eq(dc.attributeDeath({ message: 'Animus was shot by Skeleton', username: U, samples: [s({ inLava: true })], blockCause: 'lava', now: T }).cause,
  'mob', 'compose: ...and its verdict is the one recorded')
eq(dc.attributeDeath({ message: null, username: U, samples: [s({ hostile: { type: 'zombie', dist: 2 } })], blockCause: 'unknown', now: T }).source,
  'damage', 'compose: with no message, the damage log answers')
eq(dc.attributeDeath({ message: null, username: U, samples: [], blockCause: 'drowning', now: T }).source,
  'blocks', 'compose: with neither, today\'s block reading is the floor')
eq(dc.attributeDeath({ message: null, username: U, samples: [], blockCause: 'drowning', now: T }).cause,
  'drowning', 'compose: the floor is BYTE-FOR-BYTE today (removing layers 1-2 changes nothing)')
eq(dc.attributeDeath({ now: T }).cause, 'unknown', 'compose: nothing known at all is still honestly `unknown`')
eq(dc.attributeDeath({ message: 'Animus drowned', username: U, now: T }).attacker, null,
  'compose: a death with no killer names no attacker')

// ---- the regression this module exists for --------------------------------------------
// The 2026-07-20 tape: 34 deaths, 32 recorded `unknown`. Every one of those was a mob death at
// night with a hostile on us. Replay that shape and assert it is no longer `unknown`.
const tape = [s({ t: T - 4000, drop: 4, hostile: { type: 'skeleton', dist: 9 } }),
  s({ t: T - 2000, drop: 3, hostile: { type: 'skeleton', dist: 7 } }),
  s({ t: T - 500, drop: 5, hostile: { type: 'zombie', dist: 1.4 } })]
const replay = dc.attributeDeath({ message: null, username: U, samples: tape, blockCause: 'unknown', now: T })
eq(replay.cause, 'mob', 'REGRESSION: the 2026-07-20 death shape is attributed instead of `unknown`')
eq(replay.attacker, 'zombie', 'REGRESSION: ...and it names what was on us at the end')

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall death-cause tests passed')
process.exit(fails ? 1 : 0)
