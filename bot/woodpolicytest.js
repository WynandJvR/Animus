'use strict'
// OFFLINE unit test for wood-policy.js (LOCAL_WOOD) - no bot, no world.
// Run: cd bot && node woodpolicytest.js
//
// Pins the two decisions the live feature hinges on:
//   1. grow-ready / orchard-DIVERT preference (orchardWorthVisiting)
//   2. gather-preference: wild roam cap + carry-sapling-home + establish gate
// and, above all, that LOCAL_WOOD=0 is byte-for-byte today's behavior at every call site.

const wp = require('./wood-policy.js')

let failures = 0
function ok (cond, msg) { if (!cond) { failures++; console.log('  FAIL: ' + msg) } else { console.log('  ok: ' + msg) } }
function eq (a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')') }

// ---- woodRoamCap ----------------------------------------------------------------------
// ON: a log gather is fenced to <=96 (default) even though the caller's base is 160.
eq(wp.woodRoamCap(160, true, true), 96, 'ON: log roam capped 160 -> 96')
// ON: never RAISES a cap already tighter than the fence.
eq(wp.woodRoamCap(64, true, true), 64, 'ON: tool/tight cap 64 kept (min, never raised)')
// ON: non-log gathers are untouched (stone/ore keep their own fence).
eq(wp.woodRoamCap(96, false, true), 96, 'ON: non-log gather uncapped')
// OFF: byte-for-byte - the caller default passes straight through.
eq(wp.woodRoamCap(160, true, false), 160, 'OFF: byte-for-byte 160')
eq(wp.woodRoamCap(96, false, false), 96, 'OFF: byte-for-byte non-log')

// ---- orchardWorthVisiting (grow-ready / divert decision) ------------------------------
const orch = { x: 10, z: 10, planted: 8 }
// OFF: ONLY the wall-clock timer triggers - identical to today's `ready` gate.
eq(wp.orchardWorthVisiting({ orch, timerReady: true, hasBoneMeal: true, saplingsPlanted: 8, on: false }), true, 'OFF: timer-ready -> visit')
eq(wp.orchardWorthVisiting({ orch, timerReady: false, hasBoneMeal: true, saplingsPlanted: 8, on: false }), false, 'OFF: bone_meal alone does NOT divert (byte-for-byte)')
eq(wp.orchardWorthVisiting({ orch: null, timerReady: true, on: false }), false, 'OFF: no orchard -> never')
// ON: timer-ready still diverts.
eq(wp.orchardWorthVisiting({ orch, timerReady: true, hasBoneMeal: false, saplingsPlanted: 8, on: true }), true, 'ON: timer-ready -> visit')
// ON: bone_meal + a REAL plot force-grows now, no timer needed (kills the phantom wait).
eq(wp.orchardWorthVisiting({ orch, timerReady: false, hasBoneMeal: true, saplingsPlanted: 8, on: true }), true, 'ON: bone_meal + planted -> visit without timer')
// ON: bone_meal but the plot has NO verified saplings -> do not waste the walk.
eq(wp.orchardWorthVisiting({ orch, timerReady: false, hasBoneMeal: true, saplingsPlanted: 0, on: true }), false, 'ON: bone_meal but empty plot -> no visit')
// ON: no bone_meal and not ready -> wait (fall through to the wild scan).
eq(wp.orchardWorthVisiting({ orch, timerReady: false, hasBoneMeal: false, saplingsPlanted: 8, on: true }), false, 'ON: no bone_meal, not ready -> no visit')
eq(wp.orchardWorthVisiting({ orch: null, timerReady: true, on: true }), false, 'ON: no orchard -> never')

// ---- replantHome (carry saplings home vs scatter at the far grove) ---------------------
// OFF: never carry home - today always replants at the chop site.
eq(wp.replantHome(200, false), false, 'OFF: far chop still replants on the spot')
eq(wp.replantHome(5, false), false, 'OFF: near chop replants on the spot')
// ON: beyond the home radius (48) keep the sapling for the home orchard...
eq(wp.replantHome(94, true), true, 'ON: 94b out -> carry the sapling home')
// ...but at/under the radius replant on the spot (that IS home).
eq(wp.replantHome(48, true), false, 'ON: 48b (== radius) -> replant on the spot')
eq(wp.replantHome(10, true), false, 'ON: near home -> replant on the spot')

// ---- shouldEstablishOrchard (proactive plant gate) ------------------------------------
// OFF: never (the caller keeps its own narrow today-gate).
eq(wp.shouldEstablishOrchard({ need: 300, saplings: 8, haveLiveOrchard: false, on: false }), false, 'OFF: never establishes')
// ON: big remaining need + saplings + no live orchard -> establish.
eq(wp.shouldEstablishOrchard({ need: 300, saplings: 8, haveLiveOrchard: false, on: true }), true, 'ON: need+saplings, no live -> establish')
// ON: a live orchard already growing -> do NOT re-plant blindly (convergence).
eq(wp.shouldEstablishOrchard({ need: 300, saplings: 8, haveLiveOrchard: true, on: true }), false, 'ON: live orchard -> no blind re-plant')
// ON: too few saplings / small need -> hold.
eq(wp.shouldEstablishOrchard({ need: 300, saplings: 3, haveLiveOrchard: false, on: true }), false, 'ON: <4 saplings -> hold')
eq(wp.shouldEstablishOrchard({ need: 12, saplings: 8, haveLiveOrchard: false, on: true }), false, 'ON: small need -> hold')

// ---- default-on: absent env == ON (the shipped default) --------------------------------
delete process.env.LOCAL_WOOD
eq(wp.localWoodOn(), true, 'default (no env) -> ON')
eq(wp.woodRoamCap(160, true), 96, 'default -> log roam capped')
process.env.LOCAL_WOOD = '0'
eq(wp.localWoodOn(), false, 'LOCAL_WOOD=0 -> OFF')
eq(wp.woodRoamCap(160, true), 160, 'LOCAL_WOOD=0 -> byte-for-byte roam')
delete process.env.LOCAL_WOOD

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
