// #115 GROUNDED_CLAIMS - the Root A contract (DESIGN-grounded-truth-and-home-first.md §3.1).
//
// The bot had no boundary between belief and observation. pathfix.js already stated the right
// charter for place/dig/window ("the world re-read is the ONLY arbiter") but arrival, survey,
// occupancy and memory-ingestion were left on the honour system, and every one of them lied on
// the live tape of 2026-07-19. These tests pin the three consequences of the contract -
// UNKNOWN, grounded arrival, and the life epoch - plus the ingestion rule that makes a phantom
// record unrepresentable.
//
// AMBIENT-PROOF: every env var this file's subjects read is set EXPLICITLY below and restored
// after. No test here may depend on the shell's environment.
'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ENV_KEYS = ['GROUNDED_OBS', 'BUILD_DEBUG']
const SAVED = {}
for (const k of ENV_KEYS) SAVED[k] = process.env[k]
process.env.GROUNDED_OBS = '1'
delete process.env.BUILD_DEBUG

let pass = 0; let fail = 0
function t (name, fn) {
  try { fn(); console.log('PASS  ' + name); pass++ } catch (e) { console.log('FAIL  ' + name); console.log('      ' + (e && e.stack ? e.stack : e)); fail++ }
}

// isolate world memory on a scratch file BEFORE any module reads the path at load time,
// so this test can never touch (or trek the live bot to) the real world map.
const MEMFILE = path.join(require('os').tmpdir(), 'gc115-world-memory-' + process.pid + '.json')
process.env.WORLD_MEM_FILE = MEMFILE

const pathfix = require('./pathfix.js')

// ---- a fake world: a map of "x,y,z" -> block name. ANYTHING NOT IN THE MAP IS UNLOADED,
// which is exactly the distinction the old code could not make.
function fakeBot (cells, feet) {
  const at = p => cells[Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z)]
  return {
    entity: { position: { x: feet.x, y: feet.y, z: feet.z, floored: () => ({ x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) }) } },
    blockAt (p) { const n = at(p); return n ? { name: n, position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } } : null }
  }
}
const mismatch = (want, got) => want !== got

// Source pins must read the CODE, not the commentary. This slice's comments quote the exact
// broken lines they replaced (that is the point - a deleted patch-scar should stay legible),
// so a naive grep for the old shape would match the tombstone instead of a regression.
// NOTE the CRLF normalisation, and why it is load-bearing: this repo checks out CRLF, and
// `.` in a JS regex does not match \r (it is a line terminator), so a per-line
// `/(^|[^:])\/\/.*$/` silently strips NOTHING on a CRLF file - every pin below then greps the
// commentary it was meant to look past and reports the fixed defect as still present. That is
// exactly how five green tests turned red between a local run and a clean checkout. Normalise
// first, strip block comments, then line comments.
// The grounded-claim contract's OWN source, delimited by its first and last function rather
// than by a byte offset. `+200` past bumpEpoch used to spill into isSelfPlaced - pre-existing
// code that legitimately uses Date.now() - and failed the no-timers pin on someone else's line.
function contractRegion () {
  const pf = codeOf('pathfix.js')
  const start = pf.indexOf('function surveyCells')
  const last = pf.indexOf('function bumpEpoch')
  assert.ok(start > 0 && last > start, 'the grounded-claim contract could not be delimited')
  return pf.slice(start, pf.indexOf('\n', last) + 1)
}

function codeOf (file) {
  return fs.readFileSync(path.resolve(__dirname, file), 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
}

// =====================================================================================
// 0. THE PINS' OWN PIN. Every source-assertion below is only as honest as codeOf. When it
// silently stopped stripping (CRLF + `.` not matching \r), five pins greped the tombstone
// comments instead of the code and reported four fixed defects as still present - a false
// alarm that costs a deploy. So the helper is tested FIRST and explicitly: if it breaks
// again it fails HERE, as one legible failure, instead of as a scatter of confusing ones.
// =====================================================================================

t('codeOf: strips line and block comments, on LF *and* CRLF input', () => {
  const f = path.join(require('os').tmpdir(), 'gc115-codeof-' + process.pid + '.js')
  const body = "const a = 1 // if (!g) continue\n/* if (!g) continue */\nconst b = 2\nconst u = 'http://x' // tail\n"
  for (const [label, text] of [['LF', body], ['CRLF', body.replace(/\n/g, '\r\n')]]) {
    fs.writeFileSync(f, text)
    const out = codeOf(f)
    assert.ok(!/if \(!g\) continue/.test(out), label + ': comments were not stripped - every source pin below is worthless')
    assert.ok(/const a = 1/.test(out) && /const b = 2/.test(out), label + ': stripping ate real code')
    assert.ok(/http:\/\/x/.test(out), label + ': a URL inside a string was mangled')
    assert.ok(!/\r/.test(out), label + ': carriage returns survived normalisation')
  }
  try { fs.unlinkSync(f) } catch {}
})

// =====================================================================================
// 1. surveyCells - a survey that cannot see its subject REFUSES TO DECIDE
// =====================================================================================

t('surveyCells: every cell loaded and correct -> OK, zero unknown', () => {
  const bot = fakeBot({ '0,64,0': 'oak_planks', '1,64,0': 'oak_planks' }, { x: 0, y: 64, z: 0 })
  const r = pathfix.surveyCells(bot, [
    { pos: { x: 0, y: 64, z: 0 }, want: 'oak_planks' },
    { pos: { x: 1, y: 64, z: 0 }, want: 'oak_planks' }
  ], mismatch)
  assert.strictEqual(r.verdict, 'OK')
  assert.strictEqual(r.bad, 0); assert.strictEqual(r.unknown, 0); assert.strictEqual(r.solid, 2)
  assert.strictEqual(r.partial, false)
})

t('surveyCells: every cell loaded, one wrong -> BAD (only this verdict may authorise damage)', () => {
  const bot = fakeBot({ '0,64,0': 'oak_planks', '1,64,0': 'air' }, { x: 0, y: 64, z: 0 })
  const r = pathfix.surveyCells(bot, [
    { pos: { x: 0, y: 64, z: 0 }, want: 'oak_planks' },
    { pos: { x: 1, y: 64, z: 0 }, want: 'oak_planks' }
  ], mismatch)
  assert.strictEqual(r.verdict, 'BAD'); assert.strictEqual(r.bad, 1); assert.strictEqual(r.unknown, 0)
})

t('surveyCells: THE LIVE BUG - one unreadable cell makes the whole verdict UNKNOWN', () => {
  // Live 2026-07-19: `bad=111/136` decided from ~200b away underground, then `0 cell(s) still
  // off` printed four seconds after the bot died, with 0/94 blocks placed. The old loop did
  // `if (!g) continue`, so an unloaded chunk counted as ZERO damage: an absent hut verified as
  // PERFECT and a hut nobody could see authorised a destructive rebuild.
  const bot = fakeBot({ '0,64,0': 'oak_planks' }, { x: 0, y: 64, z: 0 })
  const r = pathfix.surveyCells(bot, [
    { pos: { x: 0, y: 64, z: 0 }, want: 'oak_planks' },
    { pos: { x: 1, y: 64, z: 0 }, want: 'oak_planks' } // never sent this chunk
  ], mismatch)
  assert.strictEqual(r.verdict, 'UNKNOWN', 'a blind survey must not answer OK or BAD')
  assert.strictEqual(r.unknown, 1)
  assert.strictEqual(r.partial, true, 'the counts must be MARKED partial, not quietly returned')
})

t('surveyCells: a completely unloaded region is UNKNOWN, never OK', () => {
  const bot = fakeBot({}, { x: 0, y: 64, z: 0 })
  const cells = []
  for (let i = 0; i < 94; i++) cells.push({ pos: { x: i, y: 64, z: 0 }, want: 'oak_planks' })
  const r = pathfix.surveyCells(bot, cells, mismatch)
  assert.strictEqual(r.verdict, 'UNKNOWN')
  assert.strictEqual(r.bad, 0, 'bad is 0 here - which is EXACTLY why bad===0 may never be read as success')
  assert.notStrictEqual(r.verdict, 'OK')
})

// MUTATION CHECK (design §7): reintroduce `if (!g) continue` semantics and the contract must break.
t('surveyCells MUTATION: the old skip-on-null classifier would call a blind survey clean', () => {
  const bot = fakeBot({}, { x: 0, y: 64, z: 0 })
  const cells = [{ pos: { x: 9, y: 64, z: 9 }, want: 'oak_planks' }]
  const oldWay = (() => { let bad = 0; for (const c of cells) { const g = bot.blockAt(c.pos); if (!g) continue; if (mismatch(c.want, g.name)) bad++ } return bad })()
  assert.strictEqual(oldWay, 0, 'the old code really did report zero damage here')
  assert.strictEqual(pathfix.surveyCells(bot, cells, mismatch).verdict, 'UNKNOWN', 'the new code must refuse')
})

// =====================================================================================
// 2. the destructive rebuild is UNREACHABLE from an ungrounded survey (anti-grief)
// =====================================================================================

t('ANTI-GRIEF: an UNKNOWN verdict can never produce the destructive rebuild decision', () => {
  const src = codeOf('commands.js')
  const i = src.indexOf('const decision = ')
  assert.ok(i > 0, 'hut repair decision site not found')
  const line = src.slice(i, src.indexOf('\n', i))
  assert.ok(/hutVerdict === 'UNKNOWN'/.test(line),
    "decideHutRepair must be short-circuited on UNKNOWN - found: " + line.trim())
  assert.ok(/'none'/.test(line), 'an UNKNOWN survey must resolve to the non-destructive decision')
  // and the pre-survey must have refused to decide at all
  assert.ok(/refusing to judge the safehouse/.test(src), 'the honest refusal path is missing')
})

t('ANTI-GRIEF: no `if (!g) continue` survey skip survives anywhere in commands.js', () => {
  const src = codeOf('commands.js')
  assert.ok(!/if \(!g\) continue/.test(src), 'the unloaded-chunk skip is back - a blind survey can verify as perfect again')
})

t('ANTI-GRIEF: the bank teardown treats an unreadable chest as NOT emptied', () => {
  const src = codeOf('commands.js')
  const i = src.indexOf('let emptied = true')
  assert.ok(i > 0)
  const block = src.slice(i, i + 2200)
  assert.ok(!/catch \{ left = \{ unknown: 1 \} \}/.test(block), 'the groping-for-UNKNOWN hack is still here')
  assert.ok(/leftUnknown/.test(block), 'a failed re-read must be an explicit UNKNOWN')
  // a failed FIRST read used to `continue`, leaving emptied===true: that is how
  // `camp: bank verified empty -> 0 items` was printed about chests it could not reach.
  assert.ok(/contents UNKNOWN, aborting the teardown/.test(block), 'a failed chest read must abort, not skip')
  assert.ok(/not tearing anything down/.test(block), 'an unloaded chest cell must abort, not skip')
})

t('ANTI-GRIEF: the post-build verify may only claim success on verdict OK', () => {
  const src = codeOf('commands.js')
  const i = src.indexOf('const builtClean')
  assert.ok(i > 0)
  const line = src.slice(i, src.indexOf('\n', i))
  assert.ok(/sv2\.verdict === 'OK'/.test(line), 'builtClean must require an OK verdict, found: ' + line.trim())
  assert.ok(!/bad2 === 0 &&/.test(line), 'bad2===0 is satisfiable by a survey that saw nothing')
})

// =====================================================================================
// 3. arrivedOK - 3D arrival, and the swallowed approach
// =====================================================================================

t('arrivedOK: THE LIVE BUG - a grave 18 blocks STRAIGHT DOWN is not "arrived"', () => {
  // recoverGrave measured `Math.hypot(dx, dz)` - XZ only. A grave at y53 under a bot at y71
  // measured 7.6 blocks away, so the approach branch was skipped as "already here".
  const grave = { x: 468, y: 53, z: -117 }
  const bot = fakeBot({}, { x: 461, y: 71, z: -114 })
  const oldXZ = Math.hypot(grave.x - 461, grave.z - -114)
  assert.ok(oldXZ < 8, 'the XZ measure really was ~7.6 blocks')
  assert.strictEqual(pathfix.arrivedOK(bot, { x: grave.x, y: grave.y, z: grave.z, range: 3 }), false,
    'Y must count: 18 blocks of stone is not arrival')
})

t('arrivedOK: standing at the grave IS arrival', () => {
  const bot = fakeBot({}, { x: 468, y: 54, z: -117 })
  assert.strictEqual(pathfix.arrivedOK(bot, { x: 468, y: 53, z: -117, range: 3 }), true)
})

t('arrivedOK: a goal object is arbitrated by its OWN isEnd against re-read feet', () => {
  const bot = fakeBot({}, { x: 10, y: 64, z: 10 })
  let sawFeet = null
  const goal = { isEnd: p => { sawFeet = p; return p.x === 10 && p.y === 64 && p.z === 10 } }
  assert.strictEqual(pathfix.arrivedOK(bot, goal), true)
  assert.deepStrictEqual(sawFeet, { x: 10, y: 64, z: 10 }, 'isEnd must be given the re-read body, not a remembered position')
})

t('recoverGrave: the approach failure is no longer swallowed, and arrival is re-read', () => {
  const src = codeOf('commands.js')
  const i = src.indexOf('let approachErr = null')
  assert.ok(i > 0, 'the honest approach block is missing')
  // anchored to real landmarks, never a byte offset: a fixed-size window silently slides off
  // its subject the moment anyone edits nearby, and then pins pass or fail for no reason.
  const block = src.slice(src.indexOf('const e0 = pathfix.epoch()'), src.indexOf('const invTotal ='))
  assert.ok(block.length > 0 && block.length < 4000, 'the recover approach block could not be delimited')
  assert.ok(!/await gotoTimedDA\(bot, new goals\.GoalNear\(d\.x, d\.y, d\.z, 2\), 20000\) \} catch \{\}/.test(src),
    'the bare try{}catch{} around the grave approach is back')
  assert.ok(/catch \(e\) \{ approachErr =/.test(block), 'the approach error must be captured')
  assert.ok(/couldn't reach my grave at/.test(block), 'a failed approach must report honestly')
  assert.ok(/pathfix\.arrivedOK\(bot, graveGoal\)/.test(block), 'arrival must come from arrivedOK')
  // `endActivity(true, 'reached death site')` may only follow a grounded arrival
  const claim = src.indexOf("endActivity(true, 'reached death site')")
  assert.ok(claim > 0)
  const before = src.slice(i, claim)
  assert.ok(/arrivedOK\(bot, graveGoal\)/.test(before), 'the arrival claim must be downstream of arrivedOK')
  assert.ok(!/r\.dist > 24/.test(src), 'the "failed but within 24 XZ blocks counts as arrival" rule is back')
})

t('recoverGrave: "grave still present: false" cannot be concluded from a scan at the wrong place', () => {
  const src = codeOf('commands.js')
  const arrive = src.indexOf("endActivity(true, 'reached death site')")
  const scan = src.indexOf('const stillSomething =')
  assert.ok(arrive > 0 && scan > arrive,
    'the entity scan that concludes the grave despawned must sit AFTER the grounded arrival gate')
  // and every early return between them must be a REFUSAL, never a write-off
  const between = src.slice(src.indexOf('let approachErr = null'), arrive)
  assert.ok(/not going to pretend it's gone/.test(between),
    'failing to arrive must return without ever entering the loot/verdict phase')
})

// =====================================================================================
// 4. the life epoch - observations do not survive the bot that made them
// =====================================================================================

t('epoch: increments on death, and sameEpoch invalidates a pre-death observation', () => {
  const e0 = pathfix.epoch()
  assert.strictEqual(pathfix.sameEpoch(e0), true)
  pathfix.bumpEpoch()
  assert.strictEqual(pathfix.sameEpoch(e0), false, 'a claim made before the death must not validate after it')
  assert.strictEqual(pathfix.epoch(), e0 + 1)
})

t('epoch: it is wired to the bot death event, not to a timer', () => {
  const src = codeOf('pathfix.js')
  assert.ok(/bot\.on\('death', \(\) => \{ bumpEpoch\(\) \}\)/.test(src), 'the epoch must be bumped by the death event')
  assert.ok(!/setTimeout|Date\.now\(\)/.test(contractRegion()), 'the epoch must carry no time component at all')
})

t('epoch: recoverGrave captures its life at entry and refuses to decide across a death', () => {
  const src = codeOf('commands.js')
  const i = src.indexOf('const e0 = pathfix.epoch()')
  assert.ok(i > 0, 'recoverGrave must capture its epoch at entry')
  const verdict = src.indexOf('const stillSomething =')
  assert.ok(verdict > i, 'the grave verdict must sit after the epoch capture')
  const rest = src.slice(i, verdict)
  // BOTH re-checks must fall between capturing the life and deciding the grave's fate:
  // one after the approach (a death on the way back), one before the verdict (a death
  // mid-loot, which is what let a scan finished in the afterlife write the grave off).
  assert.strictEqual((rest.match(/sameEpoch\(e0\)/g) || []).length, 2,
    'the epoch must be re-checked after the approach AND before the grave verdict')
  assert.ok(/i died again while recovering/.test(rest), 'a death mid-recovery must not write the grave off')
})

// =====================================================================================
// 5. verified occupancy - geometry alone may no longer answer
// =====================================================================================

const provHut = require('./provision-hut.js')
const worldMemory = require('./world-memory.js')

function resetMem (infra) {
  try { fs.unlinkSync(MEMFILE) } catch {}
  const m = worldMemory.loadWorldMem()
  m.infra = infra || {}
  worldMemory.saveWorldMem()
}
const memWorks = (() => { try { resetMem({ hut: [{ x: 1, y: 1, z: 1, at: 1 }] }); return worldMemory.loadWorldMem().infra.hut.length === 1 } catch { return false } })()

function hutWorld (solidCorners) {
  const cells = {}
  const corners = [[0, 0], [5, 0], [0, 5], [5, 5]]
  for (let i = 0; i < solidCorners; i++) cells[(456 + corners[i][0]) + ',69,' + (-142 + corners[i][1])] = 'oak_planks'
  for (let i = solidCorners; i < 4; i++) cells[(456 + corners[i][0]) + ',69,' + (-142 + corners[i][1])] = 'air'
  return cells
}

if (!memWorks) {
  console.log('SKIP  occupancy/ingestion tests - world-memory could not be isolated in this environment')
} else {
  t('insideOwnStructure: THE LIVE LIE - a registry hut with no blocks in the world is NOT occupancy', () => {
    // Live 2026-07-19: `boundedHold: holding inside my hut` printed one line after
    // `crossOwnDoor(in): still on the wrong side`. The registry box at 456,68,-142 was ingested
    // straight after a rebuild that placed 0/94 blocks, and a pure geometry test happily said yes.
    resetMem({ hut: [{ x: 456, y: 68, z: -142, at: Date.now() }] })
    const bot = fakeBot(hutWorld(0), { x: 458, y: 69, z: -140 })
    assert.strictEqual(provHut.ownHutAt(bot.entity.position) != null, true, 'geometry alone still says yes - that was the bug')
    assert.strictEqual(provHut.insideOwnStructure(bot), null, 'the verified predicate must say no')
  })

  t('insideOwnStructure: a hut that really stands IS occupancy, and the record heals to verified', () => {
    resetMem({ hut: [{ x: 456, y: 68, z: -142, at: Date.now() }] })
    const bot = fakeBot(hutWorld(4), { x: 458, y: 69, z: -140 })
    const h = provHut.insideOwnStructure(bot)
    assert.ok(h, 'a standing hut must answer')
    assert.strictEqual(worldMemory.loadWorldMem().infra.hut[0].verified, true,
      'seeing the structure IS the proof - the hint must be upgraded in place')
  })

  t('insideOwnStructure: unloaded probes are "can\'t tell", not "yes"', () => {
    resetMem({ hut: [{ x: 456, y: 68, z: -142, at: Date.now() }] })
    const bot = fakeBot({}, { x: 458, y: 69, z: -140 }) // nothing loaded at all
    assert.strictEqual(provHut.insideOwnStructure(bot), null, 'UNKNOWN must refuse, never assume')
    assert.notStrictEqual(worldMemory.loadWorldMem().infra.hut[0].verified, true, 'and it must not have written a claim')
  })

  t('insideOwnStructure: outside the box is a fast geometric NO - no world reads on the hot path', () => {
    resetMem({ hut: [{ x: 456, y: 68, z: -142, at: Date.now() }] })
    let reads = 0
    const bot = fakeBot(hutWorld(4), { x: 900, y: 69, z: 900 })
    const orig = bot.blockAt.bind(bot)
    bot.blockAt = p => { reads++; return orig(p) }
    assert.strictEqual(provHut.insideOwnStructure(bot), null)
    assert.strictEqual(reads, 0, 'this predicate runs hot - geometry must short-circuit before any probe')
  })

  // =====================================================================================
  // 6. memory ingests only proof-backed writes, with provenance
  // =====================================================================================

  t('rememberInfra: a write with NO proof is a hint - stored, but never verified', () => {
    resetMem({})
    worldMemory.rememberInfra('chest', { x: 10, y: 64, z: 10 })
    const e = worldMemory.loadWorldMem().infra.chest[0]
    assert.strictEqual(e.verified, false, 'an unproven write may not claim verification')
    assert.ok(e.observedAt > 0, 'every record carries WHEN')
  })

  t('rememberInfra: a write whose CLAIMED proof does not hold is REJECTED outright', () => {
    resetMem({})
    // this is the phantom hut exactly: a claim of proof from a survey that saw nothing
    worldMemory.rememberInfra('hut', { x: 456, y: 68, z: -142 }, { proof: { verdict: 'UNKNOWN', epoch: pathfix.epoch() } })
    assert.ok(!(worldMemory.loadWorldMem().infra.hut || []).length, 'an UNKNOWN survey proves nothing - the write must be dropped')
    worldMemory.rememberInfra('hut', { x: 456, y: 68, z: -142 }, { proof: { verdict: 'BAD', epoch: pathfix.epoch() } })
    assert.ok(!(worldMemory.loadWorldMem().infra.hut || []).length, 'a BAD survey proves nothing either')
  })

  t('rememberInfra: proof from a PREVIOUS LIFE is stale and rejected', () => {
    resetMem({})
    const stale = pathfix.epoch() - 1
    worldMemory.rememberInfra('hut', { x: 456, y: 68, z: -142 }, { proof: { verdict: 'OK', epoch: stale } })
    assert.ok(!(worldMemory.loadWorldMem().infra.hut || []).length, 'an observation from before a death may not ingest')
  })

  t('rememberInfra: an OK survey this life is proof, and stamps provenance', () => {
    resetMem({})
    worldMemory.rememberInfra('hut', { x: 456, y: 68, z: -142 }, { proof: { verdict: 'OK', epoch: pathfix.epoch() } })
    const e = worldMemory.loadWorldMem().infra.hut[0]
    assert.strictEqual(e.verified, true)
    assert.strictEqual(e.epoch, pathfix.epoch(), 'a record must know WHICH LIFE it was verified in')
    assert.ok(e.observedAt > 0)
  })

  t('rememberInfra: a readCell proof must match BOTH the kind and the cell', () => {
    resetMem({})
    const wrongBlock = { known: true, block: { name: 'oak_planks', position: { x: 10, y: 64, z: 10 } }, epoch: pathfix.epoch() }
    worldMemory.rememberInfra('chest', { x: 10, y: 64, z: 10 }, { proof: wrongBlock })
    assert.ok(!(worldMemory.loadWorldMem().infra.chest || []).length, 'planks do not prove a chest')
    const wrongCell = { known: true, block: { name: 'chest', position: { x: 99, y: 64, z: 99 } }, epoch: pathfix.epoch() }
    worldMemory.rememberInfra('chest', { x: 10, y: 64, z: 10 }, { proof: wrongCell })
    assert.ok(!(worldMemory.loadWorldMem().infra.chest || []).length, 'a chest somewhere else does not prove one here')
    const right = { known: true, block: { name: 'chest', position: { x: 10, y: 64, z: 10 } }, epoch: pathfix.epoch() }
    worldMemory.rememberInfra('chest', { x: 10, y: 64, z: 10 }, { proof: right })
    assert.strictEqual(worldMemory.loadWorldMem().infra.chest[0].verified, true)
  })

  t('rememberInfra: an UNKNOWN readCell proves nothing', () => {
    resetMem({})
    worldMemory.rememberInfra('chest', { x: 10, y: 64, z: 10 }, { proof: { known: false, block: null, epoch: pathfix.epoch() } })
    assert.ok(!(worldMemory.loadWorldMem().infra.chest || []).length)
  })

  t('migration: a v1 record loaded from disk is unverified until something SEES it', () => {
    resetMem({ chest: [{ x: 10, y: 64, z: 10, at: Date.now() }] }) // no verified field: legacy
    assert.notStrictEqual(worldMemory.loadWorldMem().infra.chest[0].verified, true)
    const blind = fakeBot({}, { x: 0, y: 64, z: 0 })
    worldMemory.listInfra('chest', blind)
    assert.notStrictEqual(worldMemory.loadWorldMem().infra.chest[0].verified, true, 'an unloaded chunk cannot verify it')
    assert.strictEqual(worldMemory.loadWorldMem().infra.chest.length, 1, 'nor disprove it - UNKNOWN keeps the hint')
    const seeing = fakeBot({ '10,64,10': 'chest' }, { x: 10, y: 65, z: 10 })
    worldMemory.listInfra('chest', seeing)
    assert.strictEqual(worldMemory.loadWorldMem().infra.chest[0].verified, true, 'looking straight at it IS the proof')
  })

  t('listInfra: a record the bot can SEE is wrong is still pruned', () => {
    resetMem({ chest: [{ x: 10, y: 64, z: 10, at: Date.now(), verified: true, epoch: pathfix.epoch() }] })
    const seeing = fakeBot({ '10,64,10': 'air' }, { x: 10, y: 65, z: 10 })
    assert.strictEqual(worldMemory.listInfra('chest', seeing).length, 0)
  })

  try { fs.unlinkSync(MEMFILE) } catch {}
}

// =====================================================================================
// 7. no blanket time holds anywhere in this slice (memory rule: ABSOLUTE)
// =====================================================================================

t('NO TIME HOLDS: nothing this slice added gates on elapsed time', () => {
  assert.ok(!/setTimeout|Date\.now|cooldown|Until\b/i.test(contractRegion()),
    'the grounded-claim contract must be condition-only - no timers, no cooldowns, no holds')
})

// ==== #121 NO_OP_IS_A_VERDICT applied to the hut anti-thrash latch (live 2026-07-30) ======
// The latch that stops a destructive rebuild-loop was written from ANY failed rebuild, including
// one refused AT ENTRY - before the world scan, before any clearing, with the bank put straight
// back (buildSurvival returns cleared:0 there). Latching from an untouched site recorded evidence
// that was never gathered, and because `stalled = lastAction != null && !improved` it PERMANENTLY
// downgraded the decision to 'patch', which cannot create cells that were never there:
//   [schem] build: REFUSED at entry - stop signal already live (nothing placed, nothing claimed)
//   camp: hut build -> placed 0/0 REFUSED(stopped)   /   camp: bank restored (188 redeposited)
//   ...then for hours: decision=patch, "creeper damage on my hut - patching 135 block(s)"
t('#121: the hut anti-thrash latch is written from EVIDENCE, not from an attempt', () => {
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  const i = src.indexOf("const why = (hr && hr.refused) || 'nothing-placed'")
  assert.ok(i > 0, 'the rebuild-refusal site still exists')
  const blk = src.slice(i, i + 1400)
  // The site-disturbed test must actually READ the world evidence. Asserting that the text
  // `hr.cleared` appears somewhere in the block is too weak - `const touched = true` satisfies it
  // while restoring the exact live bug (found by mutation-testing this pin). So read the
  // ASSIGNMENT LINE and require the evidence in it.
  const touchedLine = (blk.split('\n').find(l => /const touched\s*=/.test(l)) || '')
  assert.ok(touchedLine, 'the site-disturbed test must exist')
  assert.ok(/hr\.cleared/.test(touchedLine),
    'the latch condition must read cleared>0 - the proof the teardown really happened - not a constant: ' + touchedLine.trim())
  assert.ok(/hr\.placed/.test(touchedLine), 'placed>0 counts as disturbed too')
  assert.ok(!/=\s*(true|false)\s*$/.test(touchedLine.trim()), 'a constant here re-creates the live bug')
  assert.ok(/if \(touched\) \{/.test(blk), 'and the latch write must sit inside it')
  // an UNTOUCHED refusal must take a branch that does NOT assign the latch
  const untouched = blk.slice(blk.indexOf('} else {'))
  assert.ok(untouched.length > 0, 'there must be an untouched branch')
  assert.ok(!/hutRepairLatch = \{/.test(untouched),
    'an untouched refusal must not write the latch - it proves nothing about rebuilding')
})
// #115 extended: the SHELL registration path must be as grounded as the perfect-build path.
// A hut is now registered when its shell verifies even if furnishing is missing - but "verifies"
// must mean OK, never merely "not BAD". An UNKNOWN survey (unloaded chunk, failed read) is exactly
// the absence-of-observation that #115 exists to stop being read as observation-of-absence.
t('#115: a shell survey may register a hut only on OK - never on UNKNOWN', () => {
  const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  const i = src.indexOf('let shellOK = false')
  assert.ok(i > 0, 'the shell survey still exists')
  const blk = src.slice(i, i + 900)
  const line = (blk.split('\n').find(l => /shellOK\s*=\s*svShell/.test(l)) || '')
  assert.ok(line, 'the shell verdict must be assigned from the survey')
  assert.ok(/svShell\.verdict === 'OK'/.test(line),
    'shellOK must require verdict OK; "!== BAD" would let an UNKNOWN chunk register a hut: ' + line.trim())
  assert.ok(!/!==\s*'BAD'/.test(line), 'not-BAD is not evidence of OK')
})
// (the "exactly ONE rememberInfra('hut') write site" invariant is already pinned, correctly and
//  comment-aware, by onehutpathtest.js's census - it caught this very refactor adding a second.
//  Not duplicated here: a second, weaker copy of an invariant is worse than one good one.)

t('#121: absence is not damage - the model cannot answer "patch" with nothing standing', () => {
  const H = require('./hut-model.js')
  assert.strictEqual(H.decideHutRepair({ bad: 136, solidTotal: 136, lastBad: 136, lastAction: 'rebuild' }), 'rebuild')
})

for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k] }
console.log('')
if (fail) { console.log(fail + ' FAILED (' + pass + ' passed)'); process.exit(1) }
console.log('all ' + pass + ' grounded-claims (#115) tests passed')
