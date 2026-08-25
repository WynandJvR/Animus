'use strict'
// OFFLINE test for ROOT H (2026-08-02): every latch that can gate the scheduler tick must be
// force-releasable, and the tick must SAY when one is holding it.
// Run:  cd bot && node tickgatetest.js
//
// THE FINDING, established live by elimination: rung 8 never fired, so `schedLastTickAt` was
// fresh and the tick WAS running every cycle - and yet `schedLastPick` went 412s stale, so every
// cycle returned before index.js:1182 ever assigned it. The gates between are `dispatchBusy()`
// (ruled out: revokeDispatch reported "holds no dispatch slot"), `commands.isEscaping()`,
// `navigate.isRecovering()/isForceUnsticking()`, and `bot.isSleeping`.
//
// All of ours are the SAME defect the repo has now hit four times: a latch raised before an await
// and lowered in a `finally` - correct for a throw, useless for a hang. `_maintaining` cost 4.5
// hours on 07-31; `_recoveringDegraded` cost a death on 08-02. And releaseBodyClaims - the ONE
// rung allowed to force-release - was releasing building/provisioning/buildReqActive, none of
// which gate the tick, and none of the four that do. The tick's gate list and the release list
// are two copies of one rule (#4) and they had already drifted.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

let failures = 0
const results = []
function ok (name) { results.push('PASS  ' + name) }
function bad (name, e) { failures++; results.push('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e)) }
function t (name, fn) { try { fn(); ok(name) } catch (e) { bad(name, e) } }
async function ta (name, fn) { try { await fn(); ok(name) } catch (e) { bad(name, e) } }

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8')
const idx = read('index.js')
const cmd = read('commands.js')
const nav = read('navigate.js')

// ---- 1. navigate's force-release, and the counter clamp (BEHAVIOURAL) -------------------
// recoveringDepth is a COUNTER. A force-release to 0 leaves any span still unwinding, and its
// `finally` would then drive it NEGATIVE - after which isRecovering()'s `> 0` test reads a LATER,
// legitimate recovery span as "not recovering". The protection inverted is worse than the stall.
async function clampCase () {
  const navigate = require('./navigate.js')
  const fake = {
    entity: { position: new Vec3(0, 64, 0), height: 1.62 },
    pathfinder: { setGoal () {}, goal: null },
    setControlState () {}, clearControlStates () {},
    blockAt () { return null },
    entities: {},
    isSleeping: false
  }
  const move = () => navigate.reactiveMove(fake, { toward: { x: 4, y: 64, z: 0 }, budgetMs: 200, sprint: false, jump: false })

  await ta('navigate: releaseNavLatches reports and clears a span the finally never reached', async () => {
    assert.strictEqual(navigate.releaseNavLatches(), null, 'nothing held to begin with')
    const p = move()
    assert.strictEqual(navigate.isRecovering(), true, 'the span is open - this is what gates the tick')
    const freed = navigate.releaseNavLatches()
    assert.ok(freed && /recoveringDepth\(1\)/.test(freed), 'the release names what it took back, with its number: ' + freed)
    assert.strictEqual(navigate.isRecovering(), false, 'and the tick is no longer gated')
    await p
  })

  await ta('navigate: the counter is CLAMPED at 0, so a later legitimate span still reads as recovering (MUTATION CHECK)', async () => {
    assert.strictEqual(navigate.isRecovering(), false, 'the unwound span left it at 0, not -1')
    const p2 = move()
    assert.strictEqual(navigate.isRecovering(), true,
      'with a bare `recoveringDepth--` the force-released span drives the counter to -1, and the NEXT ' +
      'real recovery brings it only back to 0 - so the flee/defend reflexes would hijack a live recovery')
    await p2
    assert.strictEqual(navigate.isRecovering(), false)
  })
}

t('navigate: every decrement goes through the clamped helper - no bare `recoveringDepth--` survives', () => {
  assert.ok(!/recoveringDepth--/.test(nav), 'a bare decrement is how the counter goes negative')
  assert.ok(/function endRecoverySpan \(\) \{ recoveringDepth = Math\.max\(0, recoveringDepth - 1\) \}/.test(nav),
    'one definition of "this span is over"')
  assert.strictEqual((nav.match(/endRecoverySpan\(\)/g) || []).length, 5,
    'the definition plus its four call sites (recoverOnce, crossOwnDoor, forceUnstick, reactiveMove)')
})

// ---- 2. the release list actually covers the gate list ---------------------------------
const relStart = cmd.indexOf('function releaseBodyClaims')
const rel = cmd.slice(relStart, cmd.indexOf('\nfunction ', relStart + 1))

t('releaseBodyClaims resets commands\' OWN tick-gating latches, not only the ones that never gated it', () => {
  // 2026-08-25 (review item 2): the release is now SCOPEABLE to a single body claim, because the
  // claim registry revokes ONE expired lease at a time and taking a live maintenance pass down with
  // a dead food run would be the coarse-release bug wearing a new hat. So each line carries the
  // claim key it belongs to. What must not change is what this test was written for: a WHOLE-BODY
  // release (no scope) still clears both of commands' own tick-gating latches.
  assert.ok(/const want = k => !only \|\| only\.includes\(k\)/.test(rel),
    'an omitted scope must mean EVERY claim - the tick-gate deadline rung passes no scope and depends on that')
  assert.ok(/if \(want\('escape'\) && escaping\) \{[^}]*escaping = false \}/.test(rel),
    '`escaping` (commands.js:99) GATES THE TICK and was never force-released')
  assert.ok(/if \(!only && recovering\) \{[^}]*recovering = false \}/.test(rel),
    'the recover mutex is the same shape - and it backs no body-owner claim, so only a whole-body release reaches it')
})

t('releaseBodyClaims reaches navigate through the OWNING module, like the other three', () => {
  assert.ok(/\['\.\/navigate\.js', 'releaseNavLatches',/.test(rel),
    "the owners table's own comment: requiring the owner makes a missing function a loud TypeError " +
    'instead of the silent skip a facade `&&` gives')
})

// ---- 3. THE INVARIANT: no tick gate without a force-release -----------------------------
// This is the anti-drift assertion. The gate list and the release list drifted once already;
// a future gate added to TICK_GATES with no owner fails here rather than live, three hours in.
const gateStart = idx.indexOf('const TICK_GATES = [')
const gateBlock = idx.slice(gateStart, idx.indexOf('\n]', gateStart) + 2)

t('index.js names its tick gates in ONE table', () => {
  assert.ok(gateBlock.length > 40, 'TICK_GATES exists')
  for (const g of ['escaping', 'nav-recovering', 'nav-force-unstick', 'sleeping']) {
    assert.ok(gateBlock.includes("'" + g + "'"), 'the table names ' + g)
  }
})

t('EVERY tick gate has a force-release owner, and the owner really releases it (THE INVARIANT)', () => {
  const rows = [...gateBlock.matchAll(/\['([^']+)',[\s\S]*?,\s*'([^']+)'\]/g)].map(m => ({ gate: m[1], owner: m[2] }))
  assert.strictEqual(rows.length, 4, 'parsed every row: ' + JSON.stringify(rows))
  for (const r of rows) {
    if (r.owner === 'engine-state') {
      assert.strictEqual(r.gate, 'sleeping',
        'the only gate that is not ours is bot.isSleeping - mineflayer sets and clears it, a genuinely ' +
        'sleeping bot SHOULD gate the tick, and there is nothing for us to release')
      continue
    }
    const [mod, fn] = r.owner.split('.')
    if (mod === 'commands') {
      assert.ok(new RegExp('function ' + fn).test(cmd), r.gate + ": commands must define " + fn)
      continue
    }
    assert.ok(new RegExp("'\\./" + mod + "\\.js', '" + fn + "'").test(rel),
      r.gate + ' is gated by ' + r.owner + ', which releaseBodyClaims does not call - a gate nothing can clear')
    assert.ok(new RegExp('function ' + fn).test(read(mod + '.js')), mod + '.js must define ' + fn)
  }
})

t('the tick reads the table - the gate decision and the log can no longer disagree', () => {
  const i = idx.indexOf('const tick = async () =>')
  const body = idx.slice(i, i + 4000)
  assert.ok(/const gatedBy = TICK_GATES\.filter/.test(body), 'ONE read of the gates')
  assert.ok(!/if \(navigate\.isRecovering\(\) \|\| navigate\.isForceUnsticking\(\)\) return/.test(body),
    'the hand-written copy of the gate list is gone (MUTATION CHECK: restore it and this fails)')
  assert.ok(!/if \(bot\.isSleeping\) return/.test(body), 'and so is the sleeping copy')
})

// ---- 4. #7: a tick that returns silently for seven minutes is the defect ----------------
t('a long-held gate is NAMED, with its age, and is throttled by the shared staleness number', () => {
  const i = idx.indexOf('const gatedBy = TICK_GATES.filter')
  const body = idx.slice(i, i + 1400)
  assert.ok(/tick gated by/.test(body), 'the line exists at all - it did not, and that cost an hour of elimination')
  assert.ok(/schedGateSince/.test(body) && /\/ 1000\)/.test(body), 'it carries the age in seconds, not just a name')
  assert.ok(/force-release owner/.test(body), 'and it names WHO can clear it - every refusal logs what would clear it (#7)')
  assert.ok(/TICK_STALE_MS/.test(body) && !/\b(30000|60000|120000)\b/.test(body),
    'throttled on the SAME number rungs 7 and 8 use, not a fourth copy of "too long" (#4)')
  assert.ok(/owner !== 'engine-state'/.test(body),
    'a sleeping bot must not raise a complaint every 90s all night (#8) - only OUR gates can')
})

// ---- 5. #5: naming a force-release and not calling it is a decision with no action ------
// Measured 2026-08-02 18:39:09-18:47:06 local: the line from section 4 printed SIX times, once
// per 90s, ending "...force-release owner: nav-recovering->navigate.releaseNavLatches" - while
// nav-recovering held the tick for 476 SECONDS. In that window the chooser made zero decisions
// and the bot died six times, naked, at night, to mobs. Every survival rule in this codebase -
// the hp abort, the night rule, the crisis pick - lives downstream of that `return`.
t('a gate held past the deadline CALLS the owner it names (#5)', () => {
  const i = idx.indexOf('const gatedBy = TICK_GATES.filter')
  const body = idx.slice(i, idx.indexOf('\n      schedGateKey = \'\'', i))
  assert.ok(/commands\.releaseBodyClaims\(/.test(body),
    'MUTATION CHECK: delete the call and this fails - the log line alone was already the complete ' +
    'diagnosis AND the complete instruction, printed at nobody, for eight minutes')
  assert.ok(/const freed = commands\.releaseBodyClaims/.test(body) && /note\(freed/.test(body),
    'and it reports what it ACTUALLY took back, never what it meant to (#7)')
  assert.ok(/wiring hole/.test(body),
    'a release that frees NOTHING means the gate is held by something outside the owners table - ' +
    'that is a wiring hole and must say so, not read as success')
})

t('the release is a DEADLINE ON THE GATE, not a second clock (#4/#6)', () => {
  const i = idx.indexOf('const gatedBy = TICK_GATES.filter')
  const body = idx.slice(i, idx.indexOf('\n      schedGateKey = \'\'', i))
  // the act and the note share ONE condition - so the log can never claim a release that did not
  // happen, and no third number joins TICK_STALE_MS.
  const code = body.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  const durations = (code.match(/\b\d{4,}\b/g) || []).filter(n => n !== '1000') // 1000 = ms->s for the log line
  assert.ok(/TICK_STALE_MS/.test(code) && durations.length === 0,
    'every duration here is the SHARED staleness number - a fourth copy of "too long" is #4 all over again')
  assert.ok(!/setTimeout|setInterval|Date\.now\(\) \+ /.test(code), 'and it starts no cooldown of its own')
  assert.ok(/ours\.length && now - schedGateSince > TICK_STALE_MS/.test(body),
    'the gate must have had TICK_STALE_MS of CONTINUOUS hold - schedGateSince resets whenever the gate set changes')
})

t('ROOT H adds NO new env flag', () => {
  assert.ok(!/process\.env/.test(gateBlock), 'the gate table is plain code')
  assert.ok(!/process\.env/.test(nav.slice(nav.indexOf('function releaseNavLatches'), nav.indexOf('function releaseNavLatches') + 500)))
})

;(async () => {
  await clampCase()
  for (const r of results) console.log(r)
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
