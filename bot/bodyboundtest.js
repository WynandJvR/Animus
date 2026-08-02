'use strict'
// OFFLINE test for ROOT G (2026-08-02): THE BODY-PRIMITIVE CLASS IS ENUMERATED, AND THE RUNG
// CARRIES ITS OWN DEADLINE. No bot, no world, no server.  Run:  cd bot && node bodyboundtest.js
//
// WHY THIS FILE IS THE ACTUAL FIX. ROOT A bounded dig and look. ROOT F bounded craft. Each time,
// the hang moved to an entry point nobody had looked at, because the work was "fix the hang we
// can see", never "enumerate the class". Bounding a sixth primitive would buy the same week.
//
// So the durable artefact is an ENUMERATION derived FROM SOURCE, checked against a registry a
// human has to edit: pathfix.BODY_BOUNDS (wrapped in installPathfinderTuning) plus
// pathfix.NATIVELY_BOUNDED (mineflayer already bounds it; the row cites the file:line that
// does). Write `await bot.somethingNew(` anywhere in bot/*.js and this file fails until someone
// has read the library source and said, in writing, what makes that await settle.
//
// It also pins the enumeration COMMAND, because the enumeration this work started from was
// wrong: `grep -rhoE "await bot\.[a-zA-Z_]+\(" --include=*.js bot/ | grep -v node_modules`
// reports 37 entry points, but `-h` suppresses the filename so the `grep -v node_modules` has
// nothing to filter on - 19 of those 37 are mineflayer's own internal calls. The real number is
// 18. `enumerate()` below reads bot/*.js only, and asserts it.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const pathfix = require('./pathfix.js')
const scheduler = require('./scheduler.js')
const recovery = require('./provision-recovery.js')

let failures = 0
const results = []
function ok (name) { results.push('PASS  ' + name) }
function bad (name, e) { failures++; results.push('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e)) }
function t (name, fn) { try { fn(); ok(name) } catch (e) { bad(name, e) } }
async function ta (name, fn) { try { await fn(); ok(name) } catch (e) { bad(name, e) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const never = () => new Promise(() => {})

// THE SUITE'S OWN DEADLINE, and it is not decoration. This file tests things that HANG for a
// living, so a regression can leave the runner with an empty event loop and no pending work -
// node then exits 0, silently, having printed nothing, and `for f in *test*.js; do node $f` scores
// that as a PASS. A REFERENCED timer makes a silent exit impossible and turns a hang into a loud
// failure. (Verified: mutation M6 - deleting the rung deadline - produced exactly that silent
// exit 0 before this existed.)
const WALL = setTimeout(() => {
  console.log('FAIL  the suite did not finish within 60s - something in it HUNG (a bound is gone)')
  console.log('\n1 FAILED')
  process.exit(1)
}, 60000)

// ---- the enumeration, from source ------------------------------------------------------
// Own code only: the FILES of bot/, never its node_modules. That single distinction is the one
// the broken grep lost.
const AWAIT_BOT_RE = /await\s+bot\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g
// Comment lines are PROSE, not call sites: this very file, and pathfix's registry comment, both
// discuss `await bot.<x>(` in English. A whole-line skip (never a mid-line truncation) means a
// real call can never be hidden by a `//` inside a string.
function isCommentLine (s) { const x = s.trim(); return x.startsWith('//') || x.startsWith('*') || x.startsWith('/*') }
function enumerate () {
  const hits = new Map() // name -> [ 'file:line', ... ]
  const files = fs.readdirSync(__dirname, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.js'))
    .map(d => path.join(__dirname, d.name))
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    let inBlock = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const wasBlock = inBlock
      if (!inBlock && /\/\*/.test(line) && !/\*\//.test(line)) inBlock = true
      else if (inBlock && /\*\//.test(line)) inBlock = false
      if (wasBlock || inBlock || isCommentLine(line)) continue
      AWAIT_BOT_RE.lastIndex = 0
      let m
      while ((m = AWAIT_BOT_RE.exec(line)) !== null) {
        if (!hits.has(m[1])) hits.set(m[1], [])
        hits.get(m[1]).push(path.basename(f) + ':' + (i + 1))
      }
    }
  }
  return { hits, files }
}

function registryChecks () {
  const { hits, files } = enumerate()

  t('enumeration reads bot/*.js only - never node_modules (the grep -h bug that produced the wrong list)', () => {
    for (const f of files) {
      assert.ok(!/node_modules/.test(f), 'node_modules leaked into the enumeration: ' + f)
      assert.strictEqual(path.dirname(f), __dirname, 'the scan must not recurse: ' + f)
    }
    assert.ok(files.length > 40, 'the scan found only ' + files.length + ' files - it is not looking at bot/')
  })

  // THE ONE THAT BREAKS ON A NEW UNBOUNDED AWAIT.
  t('every `await bot.X(` in bot/*.js is classified in pathfix BODY_BOUNDS or NATIVELY_BOUNDED', () => {
    const unclassified = []
    for (const [name, sites] of hits) {
      if (!pathfix.bodyEntryPointRow(name)) unclassified.push(name + ' (' + sites.slice(0, 3).join(', ') + (sites.length > 3 ? ', +' + (sites.length - 3) + ' more' : '') + ')')
    }
    assert.deepStrictEqual(unclassified, [],
      'A NEW BODY ENTRY POINT APPEARED AND NOBODY CLASSIFIED IT.\n' +
      '      Read the mineflayer source for each name below and add a row to pathfix.js:\n' +
      '        - BODY_BOUNDS      if pathfix has to install the bound (say what the settle is)\n' +
      '        - NATIVELY_BOUNDED if the library already bounds it (cite the file:line that does)\n' +
      '      Unclassified: ' + unclassified.join('; '))
  })

  t('every registry row states what settles it and cites where - a row with no citation is a guess', () => {
    for (const half of ['BODY_BOUNDS', 'NATIVELY_BOUNDED']) {
      for (const [name, row] of Object.entries(pathfix[half])) {
        assert.ok(row && typeof row.by === 'string' && row.by.length > 10, half + '.' + name + ': `by` must say what makes the await settle')
        assert.ok(row && typeof row.where === 'string' && row.where.length > 3, half + '.' + name + ': `where` must cite the code that does it')
        assert.ok(['throws', 'succeeds', 'n/a'].includes(row.cut), half + '.' + name + ': `cut` must say what a caller sees when the bound bites (got ' + row.cut + ')')
      }
    }
  })

  t('a registry row never lives in both halves (one entry point, one classification)', () => {
    const both = Object.keys(pathfix.BODY_BOUNDS).filter(n => n in pathfix.NATIVELY_BOUNDED)
    assert.deepStrictEqual(both, [], 'classified twice: ' + both.join(', '))
  })

  t('every library citation resolves: the file exists and is at least that long', () => {
    const root = path.join(__dirname, 'node_modules')
    const bad = []
    for (const half of ['BODY_BOUNDS', 'NATIVELY_BOUNDED']) {
      for (const [name, row] of Object.entries(pathfix[half])) {
        const re = /([A-Za-z0-9_./-]+\.js):(\d+)/g
        let m
        while ((m = re.exec(row.where)) !== null) {
          const rel = m[1]
          const line = Number(m[2])
          const candidates = [path.join(root, rel), path.join(__dirname, rel), path.join(root, 'mineflayer/lib', rel)]
          const found = candidates.find(p => { try { return fs.statSync(p).isFile() } catch { return false } })
          if (!found) { bad.push(name + ' -> ' + rel + ' (no such file)'); continue }
          const n = fs.readFileSync(found, 'utf8').split('\n').length
          if (line > n) bad.push(name + ' -> ' + rel + ':' + line + ' but the file has ' + n + ' lines')
        }
      }
    }
    assert.deepStrictEqual(bad, [], 'a citation that does not resolve is a lie in the record (#7): ' + bad.join('; '))
  })

  // Every wrapped row must ACTUALLY be wrapped. A row claiming "pathfix bounds this" while
  // installPathfinderTuning quietly stopped wrapping it would be the worst kind of green test.
  t('every BODY_BOUNDS row is genuinely replaced by installPathfinderTuning (not merely declared)', () => {
    const { EventEmitter } = require('events')
    const { Vec3 } = require('vec3')
    const bot = new EventEmitter()
    bot.entity = { position: new Vec3(0, 64, 0), height: 1.62 }
    bot.game = { minY: -64, height: 384 }
    bot.blockAt = () => null
    bot.digTime = () => 0
    bot.stopDigging = () => {}
    bot.clearControlStates = () => {}
    bot.dig = async () => {}
    bot.look = async () => {}
    bot.lookAt = async () => {}
    bot.craft = async () => {}
    bot._placeBlockWithOptions = async () => {}
    bot.placeBlock = async () => {}
    bot.openBlock = async () => ({})
    bot.openEntity = async () => ({})
    const before = {}
    for (const n of Object.keys(pathfix.BODY_BOUNDS)) before[n] = bot[n]
    pathfix.installPathfinderTuning(bot)
    for (const n of Object.keys(pathfix.BODY_BOUNDS)) {
      assert.notStrictEqual(bot[n], before[n], 'BODY_BOUNDS.' + n + ' claims pathfix wraps it, but installPathfinderTuning left bot.' + n + ' untouched')
    }
  })

  t('the enumeration is our code\'s, not the library\'s (18 entry points, not the grep -h 37)', () => {
    assert.ok(hits.size >= 10 && hits.size <= 25,
      'expected the OWN-CODE entry-point count (18 at ROOT G), got ' + hits.size + ': ' + [...hits.keys()].sort().join(',') +
      '. A jump toward 37 means the scan is reading node_modules again.')
  })
}

// ---- the rung deadline -----------------------------------------------------------------
// Everything is injected, so these run in milliseconds instead of the live 150s.
function rungOpts (extra) {
  return Object.assign({ noProgressMs: 300, pollMs: 10, progressAt: () => 0, heldNow: () => false }, extra)
}

async function rungDeadline () {
  t('the rung deadline is DERIVED from the supervisor, not chosen: SURVIVAL_FAIL_MS + LATCH_GRACE_MS', () => {
    assert.strictEqual(recovery.RUNG_NOPROGRESS_MS, scheduler.SURVIVAL_FAIL_MS + scheduler.LATCH_GRACE_MS,
      'the rung may only be cut once the supervisor has already concluded the job is hung AND its stop latch did not bite')
    assert.strictEqual(typeof scheduler.SURVIVAL_FAIL_MS, 'number')
    assert.strictEqual(typeof scheduler.LATCH_GRACE_MS, 'number')
  })

  t('ROOT G adds NO new env flag', () => {
    const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
    assert.ok(/const RUNG_NOPROGRESS_MS = scheduler\.SURVIVAL_FAIL_MS \+ scheduler\.LATCH_GRACE_MS/.test(src),
      'RUNG_NOPROGRESS_MS must be a plain derived const - flag debt is real debt')
    assert.ok(!/process\.env\.RUNG_/.test(src), 'no RUNG_* env switch may exist')
  })

  await ta('boundedRung: a rung that finishes passes its value through untouched', async () => {
    const v = await recovery.boundedRung({}, 'R0:x', () => false, async () => 'done', rungOpts())
    assert.strictEqual(v, 'done')
  })

  await ta('boundedRung: a rung that throws passes its error through untouched (a real failure stays a real failure)', async () => {
    const e = new Error('no bed reachable')
    let caught = null
    try { await recovery.boundedRung({}, 'R2:x', () => false, async () => { throw e }, rungOpts()) } catch (x) { caught = x }
    assert.strictEqual(caught, e, 'the original error object, not a wrapper')
  })

  await ta('boundedRung: a rung that never settles and never progresses is CUT, and the cut is a FAILURE (MUTATION CHECK)', async () => {
    let caught = null
    const t0 = Date.now()
    const verdict = await Promise.race([
      recovery.boundedRung({}, 'R1:recoverGrave', () => false, () => never(), rungOpts()).then(() => 'resolved', e => { caught = e; return 'rejected' }),
      sleep(6000).then(() => 'HUNG')
    ])
    assert.strictEqual(verdict, 'rejected',
      "a hung rung must come back as a rung FAILURE so the ladder advances (got '" + verdict + "' after " +
      (Date.now() - t0) + 'ms). HUNG here means the rung deadline in provision-recovery.js is gone.')
    assert.ok(/bounded rung/.test(caught.message), 'the error names itself so the tape is greppable: ' + caught.message)
  })

  await ta('boundedRung: the cut FLIPS the stop the abandoned rung polls (the settle - no second body-mover)', async () => {
    let sawStop = false
    let stopFn = null
    const p = recovery.boundedRung({}, 'R3:trek', () => false, (stop) => { stopFn = stop; return never() }, rungOpts())
    await p.catch(() => {})
    assert.ok(stopFn, 'the rung is handed the composed stop, not the raw one')
    sawStop = stopFn()
    assert.strictEqual(sawStop, true,
      'after a cut, the abandoned rung must observe isStopped()===true at its next cooperative check')
  })

  await ta('boundedRung: a rung that keeps making verified progress is NEVER cut (no blanket timer, #6)', async () => {
    let at = Date.now()
    const stamp = setInterval(() => { at = Date.now() }, 20)
    let done = null
    const run = () => new Promise(r => { done = r })
    const p = recovery.boundedRung({}, 'R2:trek', () => false, run, rungOpts({ progressAt: () => at, noProgressMs: 200 }))
    await sleep(900) // 4.5x the no-progress window - a blanket timer would have fired long ago
    done('finished a 900ms leg')
    clearInterval(stamp)
    assert.strictEqual(await p, 'finished a 900ms leg', 'progress re-bases the clock; only ABSENCE of progress cuts')
  })

  await ta('boundedRung: a DECLARED hold suspends the clock - waiting for dawn is the rung doing its job', async () => {
    let held = true
    let done = null
    // settled EAGERLY: a floating promise that rejects while we sleep would crash the runner on
    // an unhandled rejection instead of reporting an honest FAIL
    const p = recovery.boundedRung({}, 'R5:boundedHold:sleep', () => false, () => new Promise(r => { done = r }),
      rungOpts({ noProgressMs: 150, heldNow: () => held })).then(v => ({ ok: true, v }), e => ({ ok: false, e }))
    await sleep(700) // no progress at all for 4.6 windows, but the hold vouches for the stillness
    done('slept to dawn')
    held = false
    const r = await p
    assert.ok(r.ok, 'a rung inside a declared hold must NOT be cut: ' + (r.e && r.e.message))
    assert.strictEqual(r.v, 'slept to dawn',
      'reflexes.beginHold is the codebase\'s declaration that stillness is the goal; the rung clock must honour it')
  })

  await ta('boundedRung: when the hold ENDS, the clock re-bases from that moment (it does not fire instantly)', async () => {
    let held = true
    const p = recovery.boundedRung({}, 'R5:boundedHold:sleep', () => false, () => never(),
      rungOpts({ noProgressMs: 400, heldNow: () => held })).catch(() => {})
    await sleep(300)
    held = false
    const t0 = Date.now()
    await p
    const after = Date.now() - t0
    assert.ok(after >= 350, 'a hold that ends must not leave a stale clock that cuts on the next poll (cut ' + after + 'ms after the hold ended)')
  })

  await ta('boundedRung: the ladder call site reports a cut through its existing rung-failure path', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'provision-recovery.js'), 'utf8')
    assert.ok(/await boundedRung\(bot, label, rungAdmissible, stop => RUNG_EXECUTORS\[chosen\.action\]/.test(src),
      'the ladder must run every rung through boundedRung - a rung dispatched around it is an unbounded rung')
    assert.ok(/boundedRung\([\s\S]{0,400}?\n\s*catch \(e\) \{ dbg\('\(ladder\) ' \+ label \+ ' failed: '/.test(src),
      'a cut must land in the SAME catch a rung failure has always landed in, so `tried` is marked and the ladder advances')
  })
}

;(async () => {
  registryChecks()
  await rungDeadline()
  clearTimeout(WALL)
  for (const r of results) console.log(r)
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
