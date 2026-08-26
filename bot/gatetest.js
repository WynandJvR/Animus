'use strict'
// ==== CONTRACT TESTS FOR THE REFUSAL REGISTRY (gate.js) ======================================
// design-docs/DESIGN-2026-08-25-deadlock-free-arbitration.md §2.4, milestone M1.
// Run:  cd bot && node gatetest.js
//
// gate.js exists because the /cmd handler was a SECOND ARBITER: nine hand-written branches with
// no executable floor and no feedback, deciding over the brain's proposals while scheduler-core
// decided over everything else. On 2026-08-25 it refused `mine 23 64 -13 «need to get materials
// to craft armor»` twenty-one times on behalf of a saved build whose own reconcile list asked for
// cobblestone and raw_iron - and nothing in the process could notice, because a refused command
// evaporated at the HTTP handler.
//
// M1 moves those nine branches into a table and changes NOTHING ELSE. That claim is the whole
// deliverable, so most of this file is spent proving it:
//
//   A  schema         every row declares principal / reads / applies / refusal / successor, and
//                     the lease-or-escalation field its `guards` kind requires
//   B  well-founded   the successor graph is acyclic and every path grounds out
//   C  honest reads   `applies` (and the strings it renders) touch ONLY declared fields, checked
//                     by a Proxy, and never throw anywhere in the declared boundary space
//   D  INERTNESS      the table is swept against a verbatim transcription of the if-stack it
//                     replaced, over the full cartesian product of the decision variables
//   E  the tape       every historical `held (...)`/`PREEMPT (...)`/`BLOCKED (...)` line in both
//                     event logs is replayed through the table and must render byte-identically
//   F  side effects   the lazy snapshot calls bodyOwner()/persistedResume() in exactly the places
//                     the if-stack called them - laziness here is behaviour, not an optimisation
//   G  source guard   a `held (` may be constructed in gate.js and nowhere else; the brain-facing
//                     replies live in one file; the /cmd handler no longer reads persistedResume
//
// D and E are the ones that matter. A refactor of an arbiter is only worth doing if it can be
// shown to be inert, and "I read it carefully" is not a proof.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const gate = require('./gate.js')
const reflexes = require('./reflexes.js')

let pass = 0
let fail = 0
function t (name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)) }
}
// Same, awaited. The sweep and the tape replay are async, and an un-awaited assertion is an
// unhandled rejection that a suite runner can report as a PASS - the exact failure mode a test
// file about honest verdicts must not have.
async function ta (name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)) }
}
// CRLF-normalised: this repo checks out CRLF and it has burned three source-pinning tests.
const srcOf = f => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')
const stripComments = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

console.log('gate: the refusal registry contract')

// ============ A - SCHEMA =====================================================================
const GUARD_KINDS = ['operator-intent', 'principal', 'survival-floor']
const VERDICTS = ['block', 'refuse', 'preempt']
const REFLEX_NAMES = new Set(reflexes.REFLEXES.map(r => r.name))
const OWNER_KEYS = new Set(reflexes.BODY_OWNERS.map(o => o.key))
const resolves = n => gate.SINKS.includes(n) || REFLEX_NAMES.has(n) || OWNER_KEYS.has(n)

t('A: the table is not empty and every key is unique and greppable', () => {
  assert(gate.ROWS.length > 0, 'an empty table would make this whole suite vacuous')
  const keys = gate.ROWS.map(r => r.key)
  assert.deepStrictEqual(keys.length, new Set(keys).size, 'duplicate row keys: ' + keys.join(','))
  for (const k of keys) assert(/^[a-z][A-Za-z]+$/.test(k), k + ' is not a greppable identifier')
})

t('A: every row declares the full shape', () => {
  for (const r of gate.ROWS) {
    assert(VERDICTS.includes(r.verdict), `${r.key}: verdict "${r.verdict}" is not one of ${VERDICTS.join('/')}`)
    assert(GUARD_KINDS.includes(r.guards), `${r.key}: guards "${r.guards}" is not one of ${GUARD_KINDS.join('/')}`)
    assert(Array.isArray(r.reads) && r.reads.length > 0, `${r.key}: must declare what it reads`)
    assert(typeof r.applies === 'function', `${r.key}: applies must be a pure function`)
    assert(r.refusal != null, `${r.key}: must carry the reason text it prints`)
    assert(r.successor != null, `${r.key}: NO ROW MAY REFUSE WITHOUT NAMING WHAT HAPPENS INSTEAD (#5)`)
    assert(gate.SCOPES.some(s => s.key === r.scope), `${r.key}: scope "${r.scope}" is not a declared scope`)
  }
})

t('A: every declared read is a field that actually exists in the snapshot or the proposal', () => {
  const known = new Set([...Object.keys(gate.SNAPSHOT_FIELDS), ...Object.keys(gate.PROPOSAL_FIELDS)])
  for (const r of [...gate.ROWS, ...gate.SCOPES]) {
    for (const f of (r.reads || [])) assert(known.has(f), `${r.key}: reads undeclared field "${f}"`)
  }
})

t('A: principal and successor name something real', () => {
  for (const r of gate.ROWS) {
    for (const pr of [].concat(r.principal)) {
      assert(resolves(pr), `${r.key}: principal "${pr}" is not a reflex row, a body owner, or a declared sink`)
    }
    // A successor may be a SET: two rows are held by whichever of the four body latches is live,
    // and naming one of them statically would be false three times out of four. It may also name
    // ANOTHER ROW IN THIS TABLE - that is the redirection form the design describes, and it is
    // exactly the form that can go circular, which is what check B exists for.
    const rowKeys = new Set(gate.ROWS.map(x => x.key))
    for (const su of [].concat(r.successor)) {
      assert(resolves(su) || rowKeys.has(su), `${r.key}: successor "${su}" resolves to nothing that can act`)
    }
  }
})

t('A: a principal gate declares its LEASE; an operator gate declares its ESCALATION', () => {
  // §2.2/§2.3. A refusal is a lease on someone else's freedom - it must say what ends it. The two
  // rows that guard the OPERATOR instead of a job never void on the bot's own judgement
  // ([[operator-stop-is-sacred]]), so they declare an escalation instead, and must NOT declare a
  // void. M1 only requires the field to be present and truthful; M3 evaluates it.
  for (const r of gate.ROWS) {
    if (r.guards === 'principal') {
      assert(r.voidWhen, `${r.key}: a gate held on a job's behalf must say what ends it`)
      assert(!r.escalation, `${r.key}: a job's gate voids, it does not escalate`)
    }
    if (r.guards === 'operator-intent') {
      assert(r.escalation, `${r.key}: an operator gate must declare what high escalation does to it`)
      assert(!r.voidWhen, `${r.key}: operator intent is never voided by the bot's own judgement`)
      assert.strictEqual(r.principal, 'operator', `${r.key}: an operator gate serves the operator`)
    }
    if (r.guards === 'survival-floor') {
      // The PREEMPT arms. They do not refuse anything, so there is no lease and no escalation:
      // they revoke a hold so the proposal itself can run, which is why their successor is 'self'.
      assert.strictEqual(r.verdict, 'preempt', `${r.key}: only a preempt may guard the survival floor`)
      assert.strictEqual(r.successor, 'self', `${r.key}: a preempt's successor IS the proposal`)
      assert(!r.voidWhen && !r.escalation, `${r.key}: a preempt has no lease to expire`)
      assert(r.preempt === true, `${r.key}: must be flagged so the caller revokes the hold`)
      assert(r.reply == null, `${r.key}: a preempt falls through and the command answers for itself`)
    }
  }
})

t('A: every refusal answers the caller, and every preempt does not', () => {
  for (const r of gate.ROWS) {
    if (r.verdict === 'preempt') continue
    assert(typeof r.reply === 'string' && r.reply.length > 0, `${r.key}: a refused command must still get an answer`)
  }
})

t('A: the four body-hold latches are the SAME list the refusals name as their principal', () => {
  // #4: the set that decides "is the body held" and the set the refusal claims to serve must be
  // one list. They were two for months, which is how `held (night-resting)` printed 53 times.
  for (const r of gate.ROWS) {
    if (!Array.isArray(r.principal)) continue
    assert.deepStrictEqual(r.principal, gate.BODY_HOLD_PRINCIPALS, `${r.key}: principal set has drifted from the latch table`)
  }
  assert.deepStrictEqual(gate.BODY_HOLD_PRINCIPALS, gate.BODY_HOLD_LATCHES.map(([, k]) => k))
})

// ============ B - WELL-FOUNDEDNESS ===========================================================
t('B: the successor graph is acyclic and every path grounds out in something that acts', () => {
  // §2.4.2. An edge exists only when a row's successor names ANOTHER ROW IN THIS TABLE; a
  // successor that names a reflex row or a sink is where the walk ends. The cycle report prints
  // the path so a future offender does not have to be reverse-engineered.
  // A successor may name a set, so this is a DFS over a graph, not a walk down a list.
  const byKey = new Map(gate.ROWS.map(r => [r.key, r]))
  const walk = (row, path) => {
    assert(!path.includes(row.key), 'REFUSAL CYCLE: ' + path.concat(row.key).join(' -> '))
    const here = path.concat(row.key)
    for (const su of [].concat(row.successor)) {
      const next = byKey.get(su)
      if (next) { walk(next, here); continue }
      assert(gate.SINKS.includes(su) || REFLEX_NAMES.has(su) || OWNER_KEYS.has(su),
        `${here.join(' -> ')}: the walk ends at "${su}", which nothing runs`)
    }
  }
  for (const start of gate.ROWS) walk(start, [])
})

t('B: the terminal floor is reachable - deleting a row cannot orphan it', () => {
  // §2.4.5, in the form M1 can honestly assert: the reflex registry's terminal row exists, exactly
  // one row is terminal, and it carries no refusal of its own. gate.js can only ground out in the
  // reflex registry, so if THAT floor rots the whole successor vocabulary is a fiction.
  const terminals = reflexes.REFLEXES.filter(r => r.terminal)
  assert.strictEqual(terminals.length, 1, 'exactly one terminal row, got ' + terminals.length)
  assert.strictEqual(terminals[0].name, reflexes.TERMINAL)
  assert(!terminals[0].refuse, 'a floor that can refuse itself is not a floor')
})

// ============ C - HONEST READS ===============================================================
// §2.4.3: `applies` is run against a Proxy that records every property access. Touching a field
// outside `reads` fails. This is what makes the enumeration in D sound rather than optimistic -
// a row cannot smuggle in a world read that the sweep does not vary.
function proxied (obj, seen, tag) {
  return new Proxy(obj, {
    get (o, k) { if (typeof k === 'string') seen.push(tag + k); return o[k] }
  })
}
// The declared boundary space of one row: the cartesian product of its own fields' domains.
function combos (fields, domains) {
  let out = [{}]
  for (const f of fields) {
    const vals = domains[f]
    if (!vals) continue
    out = out.flatMap(base => vals.map(v => ({ ...base, [f]: v })))
  }
  return out
}
t('C: no row reads a field it did not declare, and none throws inside its declared space', () => {
  for (const r of gate.ROWS) {
    const sFields = r.reads.filter(f => f in gate.SNAPSHOT_FIELDS)
    const pFields = r.reads.filter(f => f in gate.PROPOSAL_FIELDS)
    for (const sv of combos(sFields, gate.SNAPSHOT_FIELDS)) {
      for (const pv of combos(pFields, gate.PROPOSAL_FIELDS)) {
        // The evaluator's own invariant, mirrored from the if-stack: `adm` is materialised only
        // for a survival-class command (`const adm = survivalCmd ? ... : null`), so the pair
        // (survival:true, adm:null) is not a state the table can be handed. Sweeping it would be
        // testing an impossible world, not the row.
        if (pv.survival === true && sv.adm === null) continue
        if (pv.survival === false && sv.adm !== null && 'adm' in sv) continue
        const seen = []
        const s = proxied(sv, seen, 's.')
        const p = proxied(pv, seen, 'p.')
        let hit
        assert.doesNotThrow(() => { hit = r.applies(p, s) }, `${r.key}: applies threw on ${JSON.stringify({ ...pv, ...sv })}`)
        if (hit) {
          assert.doesNotThrow(() => {
            const txt = typeof r.refusal === 'function' ? r.refusal(p, s) : r.refusal
            const tail = typeof r.tail === 'function' ? r.tail(p, s) : r.tail
            assert(typeof txt === 'string' && txt.length > 0, 'empty reason')
            assert(tail == null || typeof tail === 'string', 'tail must render to a string')
          }, `${r.key}: rendering threw on ${JSON.stringify({ ...pv, ...sv })}`)
        }
        const declared = new Set([...sFields.map(f => 's.' + f), ...pFields.map(f => 'p.' + f)])
        const undeclared = [...new Set(seen)].filter(k => !declared.has(k))
        assert.deepStrictEqual(undeclared, [], `${r.key} touched undeclared fields: ${undeclared.join(', ')} (declared: ${r.reads.join(', ')})`)
      }
    }
  }
})

// ============ D - INERTNESS: the differential sweep ==========================================
// THE TRANSCRIPTION. This is index.js:2676-2825 at 6823533, the commit before the extraction,
// rewritten over (proposal, state) with nothing else changed - same conditions, same order, same
// template strings. It is deliberately ugly: it is evidence, not code to be admired. If M2/M3
// change behaviour on purpose, this function is what they must be shown to diverge from, and the
// divergence must be argued line by line.
const CHEAT_RE = /^(give|fill|setblock|clear|clearinv|wall|tower|house|schem|schematic|provision|autobuild|cancelbuild|abandonbuild|stash|unstash|gamemode|tp)\b/i
function legacy (p, s) {
  if (!s.cheatsAllowed && CHEAT_RE.test(p.trimmed)) {
    return { text: 'BLOCKED (world-edit/admin is operator-only)', reply: 'blocked: world-editing/admin commands are operator-only', preempt: false, busyReply: false }
  }
  if (!p.fromSupervisor && /^stop\b/i.test(p.trimmed) && s.persistedBuild) {
    return { text: 'held (a saved build job exists - the brain may not cancel it)', reply: "held: there's a build to finish - i shouldn't stop it", preempt: false, busyReply: false }
  }
  const bodyBusy = s.bodyBusy
  const holdLabel = s.holdLabel
  if (bodyBusy && !p.readOnly && !p.fromSupervisor) {
    const defenseCmd = /^(attack|defend)\b/i.test(p.trimmed)
    const defendPreempt = s.defendWhenHit && defenseCmd && s.beingHit
    const latchOn = s.postDeathLatch
    const recoveryMove = latchOn && s.recoveryMoveCmd
    const survivalCmd = p.survival
    const adm = survivalCmd ? s.adm : null
    const holdAdm = s.holdAdm
    if (defendPreempt) {
      return { text: `PREEMPT (under attack) - defense outranks the ${holdLabel} hold`, reply: null, preempt: true, busyReply: false }
    } else if (recoveryMove) {
      return { text: `PREEMPT (post-death recovery) - recovery outranks the ${holdLabel} hold`, reply: null, preempt: true, busyReply: false }
    } else if (survivalCmd && adm.allow) {
      return { text: `PREEMPT (${adm.reason}) - survival outranks the current hold`, reply: null, preempt: true, busyReply: false }
    } else if (!holdAdm.ok) {
      return { text: `PREEMPT (crisis) - ${holdAdm.reason}`, reply: null, preempt: true, busyReply: false }
    } else {
      return { text: `held (${survivalCmd ? 'no survival need: ' + adm.reason : holdLabel}) - brain command suppressed`, reply: "busy building right now - I'll hold until it's done", preempt: false, busyReply: true }
    }
  }
  if (!bodyBusy && s.persistedBuild && /^(goto|travel|explore|collect|gather|mine|chop|dig|follow|come|build)\b/i.test(p.trimmed)) {
    return { text: 'held (a build job is waiting - one job at a time)', reply: 'held: i have a build to get back to - no side trips', preempt: false, busyReply: false }
  }
  return null
}

// Build a ctx over a plain state object, so the sweep exercises the REAL decide() - snapshot,
// scope guards, scope enter, row order - not just the table.
function ctxFor (state, log) {
  const tick = k => { if (log) log.push(k) }
  return {
    cheatsAllowed: () => { tick('cheatsAllowed'); return state.cheatsAllowed },
    persistedResume: () => { tick('persistedResume'); return state.persistedBuild },
    syncClaims: () => { tick('syncClaims') },
    claimInfo: key => { tick('claimInfo:' + key); return state._claims && state._claims[key] },
    defendWhenHit: () => { tick('defendWhenHit'); return state.defendWhenHit },
    beingHit: () => { tick('beingHit'); return state.beingHit },
    postDeathLatch: () => { tick('postDeathLatch'); return state.postDeathLatch },
    recoveryMoveCmd: () => { tick('recoveryMoveCmd'); return state.recoveryMoveCmd },
    admissible: async () => { tick('admissible'); return state.adm },
    holdNeeds: () => { tick('holdNeeds'); return state._holdNeeds || [] },
    liveCrisis: () => { tick('liveCrisis'); return state._crisis || null },
    // M3's lease reader. DEFAULTS TO NOT-STALLED, deliberately: the pre-extraction if-stack had
    // no lease, so 'principal in good standing' IS the world D and E are proving inertness
    // against. Sweeping it as a free variable would make D compare the new behaviour with the
    // old and call the difference a bug - the difference is the entire point of M3. The stalled
    // half is pinned by its own cases below, against the live tape that motivated it.
    principalStalled: () => { tick('principalStalled'); return !!state.principalStalled }
  }
}
// The gate reads bodyBusy/holdLabel through the claim registry; the sweep drives them directly by
// synthesising the claims that produce the wanted label.
function claimsFor (label) {
  const active = label === 'unlabeled-hold' ? [] : label.split('+')
  const out = {}
  for (const [l, k] of gate.BODY_HOLD_LATCHES) if (active.includes(l)) out[k] = { stalled: false }
  return out
}
function stateFor (raw) {
  const s = { ...raw }
  s._claims = claimsFor(raw.bodyBusy ? raw.holdLabel : 'unlabeled-hold')
  // holdAdm is produced by the arbiter inside gate.js; feed it the inputs that yield the wanted
  // verdict rather than the verdict itself (that is the point - the arbiter call did not move).
  if (raw.holdAdm.ok) { s._crisis = null; s._holdNeeds = [] } else { s._crisis = raw._crisisFor; s._holdNeeds = raw._needsFor }
  return s
}

async function sweep (onCase) {
  const P = gate.PROPOSAL_FIELDS
  const S = gate.SNAPSHOT_FIELDS
  let n = 0
  for (const trimmed of P.trimmed) {
    for (const fromSupervisor of P.fromSupervisor) {
      for (const readOnly of P.readOnly) {
        for (const survival of P.survival) {
          for (const cheatsAllowed of S.cheatsAllowed) {
            for (const persistedBuild of S.persistedBuild) {
              for (const bodyBusy of S.bodyBusy) {
                for (const holdLabel of S.holdLabel) {
                  for (const defendWhenHit of S.defendWhenHit) {
                    for (const beingHit of S.beingHit) {
                      for (const postDeathLatch of S.postDeathLatch) {
                        for (const recoveryMoveCmd of S.recoveryMoveCmd) {
                          for (const adm of S.adm.filter(a => a !== null)) {
                            for (const crisis of [null, { need: 'threat', reason: 'hostile 3.2b', tier: arbiter.PRIORITY.SURVIVE }]) {
                              const p = { trimmed, fromSupervisor, readOnly, survival }
                              const holdAdm = { ok: !crisis }
                              const raw = {
                                cheatsAllowed, persistedBuild, bodyBusy, holdLabel, defendWhenHit,
                                beingHit, postDeathLatch, recoveryMoveCmd,
                                adm: survival ? adm : null,
                                holdAdm, _crisisFor: crisis, _needsFor: []
                              }
                              await onCase(p, raw)
                              n++
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return n
}

// The legacy transcription needs holdLabel/bodyBusy/holdAdm as VALUES; the table derives them.
// Deriving them the same way for the oracle keeps the comparison about arbitration, not plumbing.
const arbiter = require('./arbiter.js')
function legacyState (raw) {
  const crisis = raw.holdAdm.ok ? null : raw._crisisFor
  return {
    ...raw,
    bodyBusy: raw.bodyBusy && raw.holdLabel !== 'unlabeled-hold',
    holdLabel: raw.bodyBusy && raw.holdLabel !== 'unlabeled-hold' ? raw.holdLabel : 'unlabeled-hold',
    holdAdm: arbiter.holdAdmissible(crisis, (raw._needsFor || [])[0] || null)
  }
}

let sweptCases = 0
let sweptVerdicts = 0
const seenRows = new Set()

// ============ E/F/G and the async sweep ======================================================
async function main () {
  // ---- D ----------------------------------------------------------------------------------
  const diffs = []
  sweptCases = await sweep(async (p, raw) => {
    const got = await gate.decide(p, ctxFor(stateFor(raw)))
    const want = legacy(p, legacyState(raw))
    const norm = v => (v ? { text: v.text, reply: v.reply == null ? null : v.reply, preempt: !!v.preempt, busyReply: !!v.busyReply } : null)
    if (JSON.stringify(norm(got)) !== JSON.stringify(norm(want))) {
      if (diffs.length < 5) diffs.push({ p, raw: { ...raw, _claims: undefined }, got: norm(got), want: norm(want) })
    }
    if (got) { sweptVerdicts++; seenRows.add(got.key) }
  })
  await ta('D: THE INERTNESS PROOF - the table agrees with the old if-stack on every point of the space', () => {
    assert.deepStrictEqual(diffs, [], 'DIVERGENCE from the pre-extraction behaviour:\n' + JSON.stringify(diffs, null, 1))
    assert(sweptCases > 5000, 'the sweep must actually be a sweep, got ' + sweptCases + ' cases')
  })
  await ta('D: the sweep reached EVERY row - an unexercised row proves nothing', () => {
    const missed = gate.ROWS.map(r => r.key).filter(k => !seenRows.has(k))
    assert.deepStrictEqual(missed, [], 'rows never triggered by the sweep: ' + missed.join(', '))
  })
  await ta('D: and it reached the fall-through - the gate is not a wall', () => {
    assert(sweptVerdicts < sweptCases, 'every single case was refused; the sweep is not exploring the allow path')
  })

  // ---- E - the tape -------------------------------------------------------------------------
  // Every verdict this gate has ever printed, replayed. The command text is REAL (it comes off the
  // log), so this is where the moved regexes are proven: if SIDE_TRIP_RE had lost a verb, the 478
  // one-job-at-a-time lines would stop reproducing.
  const CASES = [
    // [reason regex, how to build the state that must have been true, expected row]
    [/^a saved build job exists - the brain may not cancel it$/, () => ({ persistedBuild: { name: 'castle' } }), 'stopSavedBuild'],
    [/^a build job is waiting - one job at a time$/, () => ({ persistedBuild: { name: 'castle' } }), 'oneJobAtATime'],
    [/^world-edit\/admin is operator-only$/, () => ({}), 'cheatConfinement'],
    [/^under attack$/, m => ({ bodyBusy: true, holdLabel: m.tailLabel, defendWhenHit: true, beingHit: true }), 'defendUnderAttack'],
    [/^post-death recovery$/, m => ({ bodyBusy: true, holdLabel: m.tailLabel, postDeathLatch: true, recoveryMoveCmd: true }), 'postDeathRecoveryMove'],
    [/^no survival need: (.*)$/, m => ({ bodyBusy: true, holdLabel: 'busy building', survival: true, adm: { allow: false, reason: m[1] } }), 'noSurvivalNeed'],
    [/^crisis$/, m => ({ bodyBusy: true, holdLabel: 'busy building', _crisis: m.crisis, _needs: m.needs }), 'crisisOutranksHold']
  ]
  const logs = ['bot-events.log', 'bot-events.log.old']
    .map(f => path.join(__dirname, '..', 'logs', f))
    .filter(f => { try { return fs.statSync(f).isFile() } catch { return false } })
  const tape = []
  for (const f of logs) {
    for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = raw.match(/\(cmd\) (.*?) -> ((?:BLOCKED|held|PREEMPT) \(.*)$/)
      if (!m) continue
      const cmd = m[1].replace(/ «[^»]*»\s*$/, '').trim()
      tape.push({ cmd, text: m[2], file: path.basename(f) })
    }
  }
  const replayed = []
  const misses = []
  for (const e of tape) {
    const vm = e.text.match(/^(BLOCKED|held|PREEMPT) \((.*?)\)(.*)$/)
    if (!vm) { misses.push(e.text + '  [unparseable]'); continue }
    const reason = vm[2]
    const tail = vm[3]
    const tailLabel = (tail.match(/outranks the (.*) hold$/) || [])[1]
    let raw = null
    let expectRow = null
    for (const [re, mk, row] of CASES) {
      const rm = reason.match(re)
      if (!rm) continue
      rm.tailLabel = tailLabel
      if (row === 'crisisOutranksHold') {
        // `PREEMPT (crisis) - <reason>` is the arbiter's own sentence. Reproduce it by feeding the
        // arbiter the crisis/hold pair that generates it, never by injecting the string.
        const cm = tail.match(/^ - (\w+) \((.*)\) outranks (?:the (\w+) hold|peacetime work)$/)
        if (!cm) { misses.push(e.text + '  [crisis tail]'); break }
        rm.crisis = { tier: 999, need: cm[1], reason: cm[2] }
        rm.needs = cm[3] ? [cm[3]] : []
      }
      raw = mk(rm); expectRow = row; break
    }
    if (!raw) {
      // A `held (<label>) - brain command suppressed` whose reason is a hold LABEL.
      if (/ - brain command suppressed$/.test(tail) && vm[1] === 'held') { raw = { bodyBusy: true, holdLabel: reason }; expectRow = 'bodyHold' } else if (vm[1] === 'PREEMPT' && / - survival outranks the current hold$/.test(tail)) { raw = { bodyBusy: true, holdLabel: 'busy building', survival: true, adm: { allow: true, reason } }; expectRow = 'survivalOutranksHold' } else { misses.push(e.text + '  [no case]'); continue }
    }
    const st = {
      cheatsAllowed: false, persistedBuild: null, bodyBusy: false, holdLabel: 'unlabeled-hold',
      defendWhenHit: true, beingHit: false, postDeathLatch: false, recoveryMoveCmd: false,
      adm: null, ...raw
    }
    st._claims = claimsFor(st.bodyBusy ? st.holdLabel : 'unlabeled-hold')
    st._crisis = st._crisis || null
    st._holdNeeds = st._needs || []
    const p = {
      trimmed: e.cmd, fromSupervisor: false, survival: !!st.survival,
      readOnly: false
    }
    const got = await gate.decide(p, ctxFor(st))
    replayed.push({ e, got, expectRow })
  }
  await ta('E: every verdict this gate has ever printed replays byte-identically through the table', () => {
    assert(tape.length > 500, 'the tape should be substantial, found ' + tape.length + ' (cmd) verdict lines')
    assert.deepStrictEqual(misses, [], 'tape lines the replay could not model: ' + misses.slice(0, 5).join(' | '))
    const bad = replayed.filter(r => !r.got || r.got.text !== r.e.text || r.got.key !== r.expectRow)
      .slice(0, 5)
      .map(r => `${r.e.file}: "${r.e.cmd}"\n         want ${r.expectRow}: ${r.e.text}\n         got  ${r.got ? r.got.key + ': ' + r.got.text : 'NO VERDICT (the command would have RUN)'}`)
    assert.deepStrictEqual(bad, [], 'the table does not reproduce the tape:\n       ' + bad.join('\n       '))
    const rows = new Set(replayed.map(r => r.expectRow))
    assert(rows.size >= 8, 'the tape should exercise nearly every row, it exercised ' + [...rows].join(','))
  })

  // ---- F - the side effects the laziness protects --------------------------------------------
  await ta('F: bodyOwner() is NOT run for a command the pre-body rows reject', () => {
    // bodyOwner() REVOKES expired claims, releases their latches and logs. The if-stack returned
    // before reaching it for a cheat or a saved-build stop; eager snapshot assembly would have
    // silently started revoking claims on behalf of commands that never got that far.
    const run = async (p, st) => { const log = []; await gate.decide(p, ctxFor(st, log)); return log }
    return Promise.all([
      run({ trimmed: 'gamemode creative', fromSupervisor: false, readOnly: false, survival: false },
        { cheatsAllowed: false, _claims: {} }).then(log => assert(!log.includes('syncClaims'), 'cheat row must not touch the claim registry: ' + log.join(','))),
      run({ trimmed: 'stop', fromSupervisor: false, readOnly: false, survival: false },
        { cheatsAllowed: false, persistedBuild: { name: 'castle' }, _claims: {} }).then(log => assert(!log.includes('syncClaims'), 'saved-build row must not touch the claim registry: ' + log.join(','))),
      run({ trimmed: 'state', fromSupervisor: false, readOnly: true, survival: false },
        { cheatsAllowed: false, persistedBuild: null, _claims: {} }).then(log => assert(log.includes('syncClaims'), 'but every command that gets past them DOES write the registry through'))
    ])
  })
  await ta('F: the saved build is read only where the if-stack read it', () => {
    // Was: `commands.persistedResume()` on the stop path and again on the one-job path. A read is
    // a synchronous file read on the /cmd hot path, so where it happens is behaviour (#8).
    const run = async (p, st) => { const log = []; await gate.decide(p, ctxFor(st, log)); return log.filter(k => k === 'persistedResume').length }
    return Promise.all([
      run({ trimmed: 'look', fromSupervisor: false, readOnly: true, survival: false }, { _claims: { job: { stalled: false } } })
        .then(n => assert.strictEqual(n, 0, 'a read-only command under a hold never reads the file')),
      run({ trimmed: 'mine 1 2 3', fromSupervisor: false, readOnly: false, survival: false }, { _claims: {}, persistedBuild: null })
        .then(n => assert.strictEqual(n, 1, 'an idle side-trip reads it exactly once')),
      run({ trimmed: 'stop', fromSupervisor: false, readOnly: false, survival: false }, { _claims: {}, persistedBuild: null })
        .then(n => assert.strictEqual(n, 1, 'the stop path reads it once and the memoised value serves the one-job row too'))
    ])
  })
  await ta('F: the async admissibility read happens for exactly the commands the if-stack awaited it for', () => {
    // `await provision.schedulerState(bot)` is a full world scan. The if-stack computed it EAGERLY
    // at the top of the body-hold block, before testing any PREEMPT arm - so a defend-preempt that
    // won still paid for it. Materialising it lazily would delete that read; the scope's enter()
    // keeps it, and this is the pin that says so.
    const run = async (p, st) => { const log = []; await gate.decide(p, ctxFor(st, log)); return log.includes('admissible') }
    const held = { _claims: { job: { stalled: false } }, adm: { allow: false, reason: 'x' }, holdAdm: { ok: true } }
    return Promise.all([
      run({ trimmed: 'attack zombie', fromSupervisor: false, readOnly: false, survival: false }, { ...held, defendWhenHit: true, beingHit: true })
        .then(v => assert.strictEqual(v, false, 'a non-survival command never asked for it')),
      run({ trimmed: 'eat', fromSupervisor: false, readOnly: false, survival: true }, { ...held, defendWhenHit: true, beingHit: true })
        .then(v => assert.strictEqual(v, true, 'a survival command asks for it even when an arm above wins')),
      run({ trimmed: 'eat', fromSupervisor: false, readOnly: true, survival: true }, held)
        .then(v => assert.strictEqual(v, false, 'and a read-only command never enters the block at all'))
    ])
  })

  // ---- G - the source guard -------------------------------------------------------------------
  await ta('G: a `held (` may be constructed in gate.js and NOWHERE else', () => {
    // §2.4.4, the reflexestest idiom. A new hand-written gate is a red test before it is a live
    // incident. Comment-only lines are exempt on purpose: the post-mortems in this repo quote the
    // lines they are about, and deleting the evidence to satisfy a grep would be the worse trade.
    //
    // ONE declared exception: index-bedrock.js is the alternative Bedrock body, a separate /cmd
    // path that is written but never live-tested (NOTES.md). It carries its own copy of the CHEAT
    // confinement. That duplication is real and predates this work; it is named here so it stays
    // exactly one file, and so absorbing it is a visible piece of later work rather than a
    // discovery. A SECOND file joining this list fails the test.
    const EXCEPT = ['gate.js', 'index-bedrock.js']
    const offenders = []
    for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && !f.endsWith('test.js'))) {
      if (EXCEPT.includes(f)) continue
      const c = stripComments(srcOf(f))
      // The arrow forms are the /cmd verdict vocabulary and nothing else uses them. The bare
      // `'held: '` prefix deliberately is NOT checked here: reflexes.js builds `'held: ' + why` for
      // a REFLEX proposal's blocked reason - a different vocabulary, in the other arbiter - and
      // blanket-banning the word would either force a rename with no defect behind it or teach the
      // next reader that this list takes exceptions. The four brain-facing replies are pinned
      // exactly instead, by the next test, which is the assertion that actually matters.
      for (const re of [/->\s*held\s*\(/, /->\s*PREEMPT\s*\(/, /->\s*BLOCKED\s*\(/]) {
        if (re.test(c)) offenders.push(f + ' :: ' + re)
      }
    }
    assert.deepStrictEqual(offenders, [], 'a refusal is being constructed outside the registry: ' + offenders.join(', '))
    assert.strictEqual(EXCEPT.length, 2, 'the exception list may not grow')
  })

  await ta('G: every brain-facing refusal reply exists in exactly one file', () => {
    // Same declared exception as above: the Bedrock body has its own /cmd path and its own copy of
    // the CHEAT confinement's answer. Named, not silently tolerated.
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && !f.endsWith('test.js') && f !== 'index-bedrock.js')
    for (const r of gate.ROWS) {
      if (!r.reply) continue
      const where = files.filter(f => srcOf(f).includes(r.reply))
      assert.deepStrictEqual(where, ['gate.js'], `${r.key}: its answer to the brain also lives in ${where.filter(f => f !== 'gate.js').join(', ')}`)
    }
  })

  await ta('G: the /cmd handler reads the saved build only to FEED the gate, never to decide with', () => {
    // The if-stack's only evidence was `persistedResume()` - it read the file and nothing else,
    // which is exactly why it could refuse a build's own materials on the build's behalf. The
    // handler now asks the table; the file is reached through the injected accessor, once.
    const idx = srcOf('index.js')
    const i = idx.indexOf("if (req.method === 'POST' && req.url === '/cmd')")
    assert(i > 0, 'the /cmd handler is still findable')
    // CRLF: srcOf normalises, and BOTH ends of the slice are asserted FOUND rather than silently
    // defaulting to the whole file - three pins in this repo died that way in one day.
    const j = idx.indexOf('// ---- NO WEB UI. THE CONTROL SURFACE IS Animus.exe', i)
    assert(j > i, 'the marker that ends the /cmd handler is gone - re-pin this test, do not delete it')
    const handler = idx.slice(i, j)
    // Every line still mentioning the saved build, minus the one line that injects the accessor.
    const gates = stripComments(handler).split('\n')
      .map(l => l.replace(/\/\/.*$/, '')) // trailing comments too: several lines EXPLAIN the file
      .filter(l => /persistedResume/.test(l))
      .filter(l => !/persistedResume: \(\) => \(commands\.persistedResume \? commands\.persistedResume\(\) : null\)/.test(l))
      // ...and the one M3 added, for the same reason: it FEEDS the gate. The rule this pin buys is
      // that the handler may not DECIDE with the saved build - only gate.js may. A line inside a ctx
      // accessor is an injection, not a decision. Anything that branches on it still fails here.
      .filter(l => !/const j = commands\.persistedResume && commands\.persistedResume\(\)/.test(l))
      .map(l => l.trim())
    assert.deepStrictEqual(gates, [], 'the handler reads the saved build itself again: ' + gates.join(' | '))
    assert(/persistedResume: \(\) => \(commands\.persistedResume/.test(handler), 'and the injection is still there')
    // The sharper half, which is what the pin is actually for: no CONTROL FLOW in the handler may
    // turn on the saved build. Feeding it to gate.js is allowed; `if (persistedResume())` is not.
    const branches = stripComments(handler).split(String.fromCharCode(10))
      .filter(l => /persistedResume/.test(l))
      .filter(l => /(if|while|\?|&&|\|\|)\s*\(?\s*commands\.persistedResume/.test(l))
      .map(l => l.trim())
    assert.deepStrictEqual(branches, [], 'the handler BRANCHES on the saved build - that decision belongs to gate.js: ' + branches.join(' | '))
  })

  await ta('G: the nine branches are gone from index.js and the table has nine rows', () => {
    const c = stripComments(srcOf('index.js'))
    for (const gone of ['const holdActive = [', 'const defendPreempt =', 'const recoveryMove =', 'const survivalCmd =', 'const holdNeed = [', 'const holdAdm =']) {
      assert(!c.includes(gone), 'the if-stack is growing back: ' + gone)
    }
    assert.strictEqual(gate.ROWS.length, 9, 'nine branches went in; ' + gate.ROWS.length + ' rows came out')
    assert(/await cmdGate\.decide\(proposal, \{/.test(c), 'and the handler calls the table')
  })

  await ta('G: gate.js requires nothing that can see the bot', () => {
    // The rows are pure over (proposal, snapshot); the world arrives through injected callbacks.
    // A require of commands/provision/index here is how the table becomes a second body-toucher.
    const top = srcOf('gate.js').split('\n').filter(l => /^const .*= require\(/.test(l))
    assert.deepStrictEqual(top.map(l => (l.match(/require\('([^']+)'\)/) || [])[1]), ['./access.js', './arbiter.js'],
      'gate.js may only require the two pure vocabularies it shares with the rest of the arbiter')
  })

  await ta('G: the moved verb vocabularies are byte-identical to the ones they replaced', () => {
    // These regexes ARE the behaviour. A silently widened one is a new gate wearing an old name.
    assert.strictEqual(gate.STOP_RE.source, '^stop\\b')
    assert.strictEqual(gate.DEFENSE_RE.source, '^(attack|defend)\\b')
    assert.strictEqual(gate.SIDE_TRIP_RE.source, '^(goto|travel|explore|collect|gather|mine|chop|dig|follow|come|build)\\b')
    assert.strictEqual(gate.CHEAT_RE.source, CHEAT_RE.source, 'the confinement vocabulary still comes from access.js')
    for (const re of [gate.STOP_RE, gate.DEFENSE_RE, gate.SIDE_TRIP_RE, gate.CHEAT_RE]) {
      assert.strictEqual(re.flags, 'i')
      assert(!re.global, 'a /g regex carries lastIndex state between calls - a gate that fires every other time')
    }
  })

  await ta('G: the registry adds no process.env flag', () => {
    assert(!/process\.env/.test(srcOf('gate.js')), 'flag debt is real debt; the caller owns the flags')
  })

  console.log(`\ngate: ${pass} passed, ${fail} failed  (${sweptCases} swept states, ${tape.length} taped verdicts replayed)`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error((e && e.stack) || e); process.exit(1) })

// ============ M3 - THE LEASE: a gate may not refuse for a principal that is not running =====
// 2026-08-26 04:00:26, verbatim from logs/bot-events.log:
//   (cmd) goto hut <<fire is a problem, need to get to safety>> -> held (a build job is waiting)
//   (cmd) goto hut <<get out of fire>>                          -> held (a build job is waiting)
//   (death) at -6,61,0 (mob - Zombie)                           <- three seconds later
// The build being protected was blocked on crafting ONE AXE and had been FAIL-JOBing for hours.
// 26 deaths overnight, zero progress. persistedBuild only ever meant A FILE EXISTS ON DISK.
t('M3: a STALLED build does not get to refuse the escape that would save the bot', () => {
  const p = { trimmed: 'goto hut', survival: false, readOnly: false, fromSupervisor: false }
  const base = { persistedBuild: { name: 'castle' }, bodyBusy: false, holdLabel: '', cheatsAllowed: false }
  const running = gate.evaluate(p, { ...base, principalStalled: false }, 'idle')
  const stalled = gate.evaluate(p, { ...base, principalStalled: true }, 'idle')
  assert(running && running.key === 'oneJobAtATime', 'a build that IS running still bars side trips')
  assert(stalled === null, 'a STALLED build may not bar the escape - this is the line that killed it')
})

t('M3: the lease frees ONLY the leased row - an unleased refusal is untouched', () => {
  const stop = { trimmed: 'stop', survival: false, readOnly: false, fromSupervisor: false }
  const s = { persistedBuild: { name: 'castle' }, principalStalled: true, bodyBusy: false, holdLabel: '', cheatsAllowed: false }
  const v = gate.evaluate(stop, s, 'pre-body')
  assert(v && v.key === 'stopSavedBuild', 'stopSavedBuild is operator-intent, has no lease, and still fires')
})

t('M3: every row that DECLARES a lease is actually evaluated against it', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'gate.js'), 'utf8')
  const declared = (src.match(/voidWhen: 'principalStalled'/g) || []).length
  assert(declared >= 3, 'the three principal rows still declare their lease, got ' + declared)
  assert(/row\.voidWhen === 'principalStalled' && s\.principalStalled/.test(src),
    'evaluate() must READ the lease - M1 declared it and nothing evaluated it, which is how 04:00 happened')
})
