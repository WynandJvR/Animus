'use strict'
// OFFLINE test for ROOT R (2026-08-02): AN UNREAD CHEST IS NOT AN EMPTY BANK.
// No server, no world. Run:  cd bot && node bankunknowntest.js
//
// resources.totalCounts' cachedOnly line was `counts = (c && c.counts) || {}`, so a chest that
// has NEVER been successfully read - cache entry `{"counts":{},"at":0,"fails":1}`, which is
// exactly what the sealed bank chest at 192,68,-103 produced - contributed ZERO and was
// indistinguishable from a chest opened and found bare. schedulerState reads that with
// cachedOnly:true (MANDATORY - the tick must never walk the bot), so the snapshot the PURE
// scheduler reasons from called the bank EMPTY on every tick.
//
// VERIFIED downstream consequences, and what each one now does with the uncertainty:
//   scheduler.bootstrapNeed   'food' held the build forever (reserve 0 < FOOD_RESERVE_TARGET 40)
//   scheduler.recoveryPlan    R1.5 rearmFromBank was SKIPPED -> the ladder fell through to the
//                             outbound gearup/mining rungs: mining iron the bank already held
//   maintain.needs            spareKit emitted a deficit for a bank that may hold a full set
//
// The rule everywhere is the same and it is design principle #10 verbatim: "a field that was
// never measured must never invent a need." A verdict that HOLDS PROGRESS must be measured; a
// verdict whose producer GOES AND LOOKS need not be.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const scheduler = require('./scheduler.js')
const maintain = require('./maintain.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

// ---- 1. the source of the lie: totalCountsDetailed --------------------------------------
// Driven through a stub cache file so the live chest-cache.json is never touched.
const os = require('os')
const tmp = path.join(os.tmpdir(), 'bankunknowntest-' + process.pid + '.json')

function withCache (entries, chests, fn) {
  fs.writeFileSync(tmp, JSON.stringify(entries))
  const saved = process.env.CHEST_CACHE_FILE
  process.env.CHEST_CACHE_FILE = tmp
  for (const k of Object.keys(require.cache)) { if (/resources\.js$/.test(k)) delete require.cache[k] }
  const res = require('./resources.js')
  const provision = require('./provision.js')
  const savedList = provision.listInfra
  provision.listInfra = () => chests.map(c => ({ ...c }))
  try { return fn(res) } finally {
    provision.listInfra = savedList
    if (saved === undefined) delete process.env.CHEST_CACHE_FILE; else process.env.CHEST_CACHE_FILE = saved
    for (const k of Object.keys(require.cache)) { if (/resources\.js$/.test(k)) delete require.cache[k] }
    try { fs.unlinkSync(tmp) } catch {}
  }
}
const botStub = { inventory: { items: () => [] }, entity: { position: { x: 192, y: 68, z: -103 } } }

;(async () => {
  await withCache({ '192,68,-103': { counts: {}, at: 0, fails: 1, failUntil: Date.now() + 60000 } },
    [{ x: 192, y: 68, z: -103 }], async (res) => {
      const d = await res.totalCountsDetailed(botStub, { cachedOnly: true, near: { x: 192, y: 68, z: -103 }, maxDist: 64 })
      t('totalCountsDetailed: `at: 0` is UNKNOWN, and the counts are still the honest lower bound', () => {
        assert.strictEqual(d.chests, 1)
        assert.strictEqual(d.unknown, 1, 'never opened -> nobody has seen inside; THIS is the state that must not read as zero')
        assert.strictEqual(d.read, 0)
        assert.deepStrictEqual(d.counts, {}, 'the tally itself is unchanged - it was always a lower bound, it just could not say so')
      })
    })

  await withCache({ '192,68,-103': { counts: { bread: 8 }, at: Date.now() - 3600000 } },
    [{ x: 192, y: 68, z: -103 }], async (res) => {
      const d = await res.totalCountsDetailed(botStub, { cachedOnly: true, near: { x: 192, y: 68, z: -103 }, maxDist: 64 })
      t('totalCountsDetailed: a STALE reading is still a reading - old evidence is evidence', () => {
        assert.strictEqual(d.unknown, 0, 'the line is "has this ever been opened", not "is the reading fresh"')
        assert.strictEqual(d.read, 1)
        assert.strictEqual(d.counts.bread, 8, 'and its counts still contribute - dropping them would be a NEW lie in the other direction')
      })
    })

  await withCache({}, [{ x: 192, y: 68, z: -103 }, { x: 192, y: 68, z: -102 }], async (res) => {
    const d = await res.totalCountsDetailed(botStub, { cachedOnly: true, near: { x: 192, y: 68, z: -103 }, maxDist: 64 })
    t('totalCountsDetailed: no cache entry at all is unknown too (a fresh restart, a new chest)', () => {
      // the two cells are a double chest - verifiedChests collapses adjacent same-y halves to one
      assert.strictEqual(d.chests, 1, 'a double chest is ONE container, not two')
      assert.strictEqual(d.unknown, 1)
    })
  })

  t('totalCounts is now a thin wrapper - ONE traversal, so the tally and its uncertainty cannot drift', () => {
    const src = fs.readFileSync(path.join(__dirname, 'resources.js'), 'utf8')
    const i = src.indexOf('async function totalCounts (bot, opts = {})')
    const fn = src.slice(i, src.indexOf('\n}', i))
    assert.ok(/return \(await totalCountsDetailed\(bot, opts\)\)\.counts/.test(fn), 'no second copy of the loop (#4)')
  })

  // ---- 2. detecting SEALED vs TOO FAR ---------------------------------------------------
  t('the code can tell a SEALED container from an unreachable one, and stops punishing the sealed one', () => {
    const src = fs.readFileSync(path.join(__dirname, 'resources.js'), 'utf8')
    assert.ok(/function sealedBy \(bot, e\)/.test(src), 'a GROUNDED positive test: is there a solid full cube on the lid')
    const i = src.indexOf('function chestFailed (bot, e, err)')
    const fn = src.slice(i, src.indexOf('\nfunction chestWorked', i))
    assert.ok(/cannot reach the container/.test(fn),
      "pathfix's openBlock wrapper already throws two DIFFERENT errors - 'cannot reach the container (Nb away after " +
      "approach)' vs '(2 attempts, in reach 1.1b - genuine window failure)'. The information was there; nothing used it.")
    assert.ok(/ent\.sealedBy = by/.test(fn) && /return$/m.test(fn), 'a sealed chest earns NO strike and NO cool-off')
    assert.ok(/huttidy|cleanupHutInterior/.test(fn),
      '#5: the refusal names a real owner. cleanupHutInterior digs interior strays (the sealing block IS one) ' +
      'and `huttidy` is the operator command for it.')
    // and the strike path it now bypasses is the one that DEREGISTERS the bank
    assert.ok(/DEREGISTERED after/.test(src), 'the 5-strike deregistration is still there for a genuinely dead chest')
  })

  t('a chest that opens is no longer sealed (the flag clears on success)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'resources.js'), 'utf8')
    const i = src.indexOf('function chestWorked (e)')
    const fn = src.slice(i, src.indexOf('\n}', i))
    assert.ok(/delete ent\.sealedBy/.test(fn), 'a latch nothing clears is a permanent lie')
  })

  // ---- 3. the snapshot: where UNKNOWN lives ---------------------------------------------
  t('schedulerState carries bankUnknownChests, and says so in the log and in s.unknown', () => {
    const src = fs.readFileSync(path.join(__dirname, 'survival-snapshot.js'), 'utf8')
    assert.ok(/totalCountsDetailed\(bot, \{ cachedOnly: true/.test(src), 'still cachedOnly - the tick may never walk the bot')
    assert.ok(/s\.bankUnknownChests = det\.unknown/.test(src), 'the field the pure deciders can read')
    assert.ok(/if \(det\.unknown > 0\) \{\s*\n\s*s\.unknown\.push\('bank'\)/.test(src), 'and the existing observability channel names it too')
    assert.ok(/LOWER BOUND/.test(src), 'the meaning of the bank fields is written down where they are set')
    // the throw path must be honest as well
    const i = src.lastIndexOf("s.bankFoodPts = 0; s.bankArmorPieces = 0") // the CODE, not the header comment quoting it
    assert.ok(i > 0 && /s\.bankUnknownChests = 1/.test(src.slice(i, src.indexOf('\n  }', i))),
      'a bank read that THREW measured nothing at all - it must not leave the field saying "fully measured"')
  })

  // ---- 4. the three verified consumers ---------------------------------------------------
  const base = { hp: 20, food: 20, homeReachable: true, armorPieces: 4, hutExists: true, hutVerified: true, spawnAnchored: true, baseLit: true }

  t('CONSEQUENCE 1: bootstrapNeed no longer holds the build on a bank it could not read', () => {
    assert.strictEqual(scheduler.bootstrapNeed({ ...base, bankFoodPts: 0 }), 'food',
      'a MEASURED empty bank still needs stocking - the fix must not disable the reserve')
    assert.strictEqual(scheduler.bootstrapNeed({ ...base, bankFoodPts: 0, bankUnknownChests: 1 }), null,
      'THE live hold: sealed chest -> bankFoodPts 0 forever -> the castle pinned on \'food\' while ~8 loaves sat in it')
    assert.strictEqual(scheduler.bootstrapNeed({ ...base, bankFoodPts: 0, bankUnknownChests: 0 }), 'food',
      'explicitly measured-and-empty is unchanged')
    assert.strictEqual(scheduler.bootstrapNeed({ ...base, bankFoodPts: 80, bankUnknownChests: 1 }), null,
      'a stocked bank was never a need anyway')
  })

  t('...and standing down does NOT abandon the bank: maintain still wants it stocked, and its producer LOOKS', () => {
    const needs = maintain.needs({ ...base, packFoodPts: 40, bankFoodPts: 0, bankUnknownChests: 1, torches: 8, tools: { pick: true, sparePick: true, axe: true, sword: true } })
    assert.ok(needs.some(n => n.key === 'bankFood'),
      'bankFood is the verdict whose producer (the maintenancePass courier/bake chain) OPENS the chest - ' +
      'that read is what resolves the uncertainty, so it must keep firing')
  })

  t('CONSEQUENCE 2: the recovery ladder plans rearmFromBank on an UNKNOWN bank instead of going mining', () => {
    const naked = { ...base, armorPieces: 0, packArmorPieces: 0, packFoodPts: 0, tools: { pick: false, sword: false }, homeDist: 10, graves: [] }
    const cold = scheduler.recoveryPlan({ ...naked, bankArmorPieces: 0, bankHasPick: false, bankHasSword: false })
    assert.ok(!cold.some(r => r.rung === 'R1.5'), 'a MEASURED empty bank still skips the rung - unchanged')
    const unknown = scheduler.recoveryPlan({ ...naked, bankArmorPieces: 0, bankHasPick: false, bankHasSword: false, bankUnknownChests: 1 })
    assert.ok(unknown.some(r => r.rung === 'R1.5' && r.action === 'rearmFromBank'),
      'THE live mis-routing: the bank read as empty, R1.5 was skipped, and the ladder fell through to the outbound ' +
      'gearup/mining rungs - the bot went mining iron it already owned. rearmFromBank WALKS HOME AND OPENS THE ' +
      'CHEST, so on an unmeasured bank it is both the cheapest way to find out and the better plan if it is right.')
    const i15 = unknown.findIndex(r => r.rung === 'R1.5')
    const outbound = unknown.findIndex(r => /R3|R4/.test(r.rung))
    assert.ok(i15 >= 0 && (outbound < 0 || i15 < outbound), 'and it still sits BEFORE any outbound rung')
  })

  t('CONSEQUENCE 3: maintain no longer invents a spareKit need from a bank nobody could open', () => {
    const s = { ...base, packFoodPts: 40, bankFoodPts: 80, torches: 8, tools: { pick: true, sparePick: true, axe: true, sword: true }, packArmorPieces: 2, bankArmorPieces: 0, bankHasPick: false, bankHasSword: false }
    assert.ok(maintain.needs(s).some(n => n.key === 'spareKit'), 'a measured-incomplete bank + a donatable dupe still asks')
    assert.ok(!maintain.needs({ ...s, bankUnknownChests: 1 }).some(n => n.key === 'spareKit'),
      '`bankArmorPieces != null` only proved the snapshot RAN the read, never that it SAW anything')
  })

  t('EVERY consumer tests `> 0`, so an absent field is byte-for-byte today (MUTATION CHECK)', () => {
    const s = { ...base, bankFoodPts: 0 }
    assert.strictEqual(scheduler.bootstrapNeed(s), 'food', 'no field -> the old verdict')
    for (const [file, name] of [['scheduler.js', 'bootstrapNeed/recoveryPlan'], ['maintain.js', 'needs']]) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8')
      const code = src.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).filter(l => l.includes('bankUnknownChests'))
      assert.ok(code.length, name + ' reads the field')
      for (const l of code) {
        assert.ok(/\(s\.bankUnknownChests \|\| 0\) > 0/.test(l),
          'every read must be `(s.bankUnknownChests || 0) > 0` so undefined means "no claim": ' + l.trim())
      }
    }
  })

  t('ROOT R adds no process.env flag', () => {
    for (const [file, marker] of [['resources.js', 'async function totalCountsDetailed'], ['resources.js', 'function sealedBy (bot, e)']]) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8')
      const i = src.indexOf(marker)
      assert.ok(!/process\.env/.test(src.slice(i, src.indexOf('\n}', i))), marker + ' has no off switch')
    }
  })

  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
