'use strict'
// OFFLINE SOURCE-LEVEL test for ROOT E (2026-08-02): the scheduler tick must not be a hostage
// of the executor it dispatches. Run:  cd bot && node tickdispatchtest.js
//
// index.js opens a control port and dials the server on require, so it can only be tested the
// way dispatchleasetest.js / suicidetest.js test it: by reading its source and asserting the
// SHAPE of the code. That is weaker than a behaviour test and is stated as such - but the thing
// being pinned here IS a shape: whether one keyword (`await`) sits in front of a dispatch.
//
// WHAT WENT WRONG (live 2026-08-02 13:47): the tick did `await runJob(...)` and re-armed itself
// in its own `finally`. An executor that never settles therefore means the finally never runs,
// which means there is no next tick - the whole scheduler dies on one hung promise, and the only
// thing left is a watchdog rung 90-300s away. The lease (schedJob) is ALREADY the mutual-exclusion
// mechanism; the await was a second mechanism for the same rule (#4), and it is the one that could
// kill the chain. runJob takes its lease SYNCHRONOUSLY (no await before `schedJob = {...}`), so
// dispatch-and-return cannot double-dispatch: the next tick early-returns on dispatchBusy().

const assert = require('assert')
const fs = require('fs')
const path = require('path')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')

// ---- 1. DISPATCH AND RETURN --------------------------------------------------------------
t('the tick DISPATCHES and returns - it never awaits an executor (MUTATION CHECK)', () => {
  assert.ok(!/await runJob\(name,/.test(src),
    'the primary dispatch must not be awaited - that is what tied the tick chain to the executor')
  assert.ok(!/await runJob\(alt\.label/.test(src),
    'the `alternative` dispatch must not be awaited either (same defect, same shape)')
  assert.ok(!/await runJob\(/.test(src), 'NO runJob dispatch anywhere in the tick may be awaited')
})

t('every dispatch carries a .catch - a dispatcher may never leak an unhandled rejection', () => {
  // The THREE dispatch sites in the tick. runJob catches everything internally, so these are a
  // defense line rather than a path - but an unhandled rejection escaping a dispatcher is never
  // acceptable, and `await` used to be what made that impossible.
  assert.ok(/runJob\(name,[\s\S]{0,400}?\.catch\(e => \{ try \{ note\('\(sched\) runJob\(/.test(src),
    'the primary dispatch attaches a .catch')
  assert.ok(/runJob\(alt\.label[\s\S]{0,400}?\.catch\(e => \{ try \{ note\('\(sched\) runJob\(/.test(src),
    'the alternative dispatch attaches a .catch')
  assert.ok(/runJob\('maintenancePass'[\s\S]*?\}\)\.catch\(e => \{ try \{ note\('\(sched\) runJob\(maintenancePass\)/.test(src),
    'the opportunistic-maintenance dispatch attaches a .catch (it is the one whose executor reaches ' +
    'bot.craft/putAway, the two mineflayer waits ROOT A deliberately does NOT bound)')
})

t('the safety net the change depends on is untouched: the lease is taken SYNCHRONOUSLY', () => {
  const i = src.indexOf('const runJob = async (name, executor, opts = {}) => {')
  assert.ok(i > 0, 'runJob still exists')
  const head = src.slice(i, src.indexOf('schedJob = { name, jobKey, startedAt', i)) // jobKey rides in the slot since 2026-08-25 (the claim registry's driver); the invariant below is unchanged
  assert.ok(head.length > 0 && !/\bawait\b/.test(head),
    'there must be NO await between runJob entry and taking the slot, or dispatch-and-return could double-dispatch')
  // ==== WHAT THIS PIN MEANS AFTER REVIEW ITEM 7 (2026-08-25) ==============================
  // It used to read `if (!bot.entity || dispatchBusy()) return` and it pinned TWO rules with one
  // line: (a) a dispatch in flight ends the tick, and (b) therefore the same job can never be
  // dispatched twice. (b) is the one THIS file is about - it is what makes dispatch-and-return
  // safe - and it is unchanged. (a) was only ever a proxy for it, and item 7 broke the proxy: the
  // BUILD is dispatched through this slot now, and a build runs for HOURS, so "a dispatch ends the
  // tick" would have meant the chooser could not weigh a night shelter, a food run, a grave or the
  // terminal action for the whole of that time - the 2026-08-03 standoff, rebuilt deliberately.
  // gatingDispatch keeps (a) for SURVIVE-tier work, where nothing out-ranks the incumbent so there
  // is genuinely nothing left to decide, and hands the PROGRESS-tier half to the ordering rule -
  // which is where arbitration belongs, and which now STATES (b) instead of inheriting it.
  // (2026-08-30: the early return now NAMES itself - noteEarlyReturn - so a muted chooser is one grep, not a
  // post-mortem; the guard is the same guard.)
  assert.ok(/const gd = gatingDispatch\(\)[\s\S]{0,400}if \(gd\) \{ noteEarlyReturn\([^\n]*\); return \}/.test(src),
    'the tick must still early-return on an in-flight dispatch it is not allowed to out-rank')
  assert.ok(/function gatingDispatch \(\)/.test(src) && /reflexes\.tierRank\(row\.tier\) >= reflexes\.TIERS\.SURVIVE/.test(src),
    'and gatingDispatch must keep that early-return for SURVIVE-tier dispatches')
  // (b), now that it is a rule rather than a side effect. Without BOTH of these, letting the tick
  // keep choosing re-opens the double-dispatch window between runJob taking the slot and its
  // executor raising the body latch the ownership rule reads.
  assert.ok(/if \(infl\.jobKey === job\) return \{ key: job, why: 'it is already running/.test(src),
    'a job holding the slot must be refused BY IDENTITY - it is the incumbent, not a candidate')
  assert.ok(/if \(reflexes\.tierRank\(p\.tier\) <= irank\) return \{ key: job, why: infl\.name \+ ' holds the dispatch slot/.test(src),
    'and a candidate that does not out-rank the incumbent may not be dispatched on top of it')
  assert.ok(/const myGen = \+\+schedGen/.test(src) && /schedJob && schedJob\.gen === myGen/.test(src),
    'the anti-clobber epoch guards are unweakened - a late abandoned executor still cannot clear a successor\'s slot')
})

// ---- 2. ONE STALENESS NUMBER, TWO CONSUMERS ----------------------------------------------
t('TICK_STALE_MS is declared ONCE and is the only staleness number both rungs use', () => {
  const decls = src.match(/const TICK_STALE_MS = \d+/g) || []
  assert.strictEqual(decls.length, 1, 'exactly one declaration, got ' + decls.length)
  const uses = (src.match(/TICK_STALE_MS/g) || []).length
  assert.ok(uses >= 4, 'referenced by rung 7 and rung 8 (and their log lines), got ' + uses + ' mentions')
})

t('rung 8 no longer carries the hard-coded 90000 / 300000 pair', () => {
  const i = src.indexOf('// 8. TICK-LIVENESS')
  assert.ok(i > 0, 'rung 8 still exists')
  const rung = src.slice(i, src.indexOf('} catch (e) { try { note(\'(wd) watchdog error', i))
  assert.ok(/now - schedLastTickAt > TICK_STALE_MS/.test(rung), 'detection uses the shared constant')
  assert.ok(/now - lastLivenessRearm > TICK_STALE_MS/.test(rung),
    'so does the rate limit - a deadline on an attempt, not a delay before thinking (#6)')
  assert.ok(!/300000/.test(rung), 'the 5-minute rate limit literal is gone')
  assert.ok(!/90000/.test(rung), 'the duplicated 90s literal is gone')
  assert.ok(/tickGen\+\+/.test(rung), 'the generation guard that makes re-arming idempotent-safe is KEPT')
})

// ---- 3. RUNG 7 IS STALENESS-HONEST -------------------------------------------------------
t('rung 7 kicks only on a FRESH pick, and says so with its age (MUTATION CHECK)', () => {
  const i = src.indexOf('// 7. IDLE-WITH-WORK')
  assert.ok(i > 0, 'rung 7 still exists')
  const rung = src.slice(i, src.indexOf('// 8. TICK-LIVENESS', i))
  assert.ok(/\(now - schedLastPickAt\) <= TICK_STALE_MS/.test(rung),
    'the kick condition must test the pick\'s freshness - reading schedLastPick with no staleness check ' +
    'is what made the watchdog assert a live pick from a dead tick chain, 20x on 2026-08-02')
  assert.ok(/IDLE WITH WORK 30s\+: pick=[\s\S]{0,120}?s old\)/.test(rung),
    'the kick line states the pick\'s age in numbers (#7)')
})

t('a STALE pick logs the truth and clears NOTHING', () => {
  const i = src.indexOf('// 7. IDLE-WITH-WORK')
  const rung = src.slice(i, src.indexOf('// 8. TICK-LIVENESS', i))
  const elseIdx = rung.indexOf('} else if (survivalPickIdle) {')
  assert.ok(elseIdx > 0, 'there is an explicit stale branch, not a silent fall-through (#5, #7)')
  const stale = rung.slice(elseIdx)
  assert.ok(/stale/.test(stale), 'and it says the word - the next reader of the tape must not have to infer it')
  assert.ok(!/runner\.graveCooldownUntil/.test(stale) && !/attempts\.forgetAll/.test(stale),
    'a stale pick must NOT clear back-offs that nothing is going to consume')
  const kick = rung.slice(0, elseIdx)
  // (runner.noOp.clear() -> attempts.forgetAll(): the job-identity latch is deleted, and the
  //  attempt memory that replaced it is what the kick now forgets. Same assertion, new name.)
  assert.ok(/runner\.graveCooldownUntil = runner\.hpCooldownUntil = 0/.test(kick) && /attempts\.forgetAll/.test(kick),
    'the fresh-pick kick still actually kicks (a kick that only logs is not a kick)')
})

// ---- 4. NO NEW ENV FLAGS -----------------------------------------------------------------
t('ROOT E adds no process.env flag', () => {
  assert.ok(!/process\.env\.TICK_STALE/.test(src) && !/process\.env\.DISPATCH_AND_RETURN/.test(src),
    'the staleness bound is a plain const; flag debt is real debt')
})

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
process.exit(failures ? 1 : 0)
