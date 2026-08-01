'use strict'
// ==== #119 COMMITMENT_LEDGER - the ONE read of everything the bot owes the world ==========
//
// Root C (design §3.3): "everything the bot commits to the world - a temp block, a dug pit, an
// item in a container, a grave - is an entry in ONE ledger with a value and a location, and the
// scheduler treats outstanding ledger debt as a first-class need scored like any other."
//
// The state was never actually missing; the OWNERSHIP was. Four different stores already knew
// four different pieces of it and none of them was anybody's debt:
//   placed scaffold  -> scaffold-registry.json  (a chore that ran only when the bot was idle)
//   dug cells        -> scaffold-registry.json  (shaft debts; added by C-prevent, #111)
//   container items  -> nowhere at all          (the 20 abandoned beef; now world-memory infra
//                                                `contents`, added by this change)
//   graves           -> last-death.json         (owned by grave.js, which has its own policy)
//
// So this module is a VIEW, not a fifth store. §3.3 says so explicitly - "the ledger references
// the registry ids to avoid a risky data migration" - and it is the right call for a second
// reason: each of those stores has a lifetime rule its owner enforces (scaffold age-culls, the
// grave ledger expires and de-dupes against despawn). A copy would drift from all four. The
// contract this module adds is the one thing none of them had: a single question -
// "what do I owe, where, and what is it worth" - that the scheduler can score.
//
// PURE-ish and CHEAP by construction ([[body-first-priority]]): every source below is an
// in-memory read (a Map, a cached JSON object, an array). NO world reads, NO fs, NO awaits.
// It runs on the scheduler snapshot path, so it may never cost the event loop anything.

const KINDS = ['scaffold', 'shaft', 'container', 'grave']

// Coarse per-kind worth. These are not currency, they are an ORDERING: what should the body
// walk away from the build to go fix first. A 20-beef furnace (value ~40) outranks a dozen
// dirt scaffold blocks (value 12) which outranks a single shaft cell (value 2) - which is the
// operator's own priority, stated as arithmetic instead of as a hand-ordered ladder.
const SCAFFOLD_VALUE = 1  // one placed block: cheap to pay, but they arrive in the hundreds
const SHAFT_VALUE = 2     // a dug cell: a hole in the world reads worse than a block on it
                          // ([[natural-player-goal]] - visible terrain damage is the failure
                          // the operator has raised three separate times)

function num (x) { return typeof x === 'number' && Number.isFinite(x) ? x : 0 }
function dist2d (a, b) { return Math.hypot(num(a.x) - num(b.x), num(a.z) - num(b.z)) }

// ---- sources -----------------------------------------------------------------------------
// Each is wrapped: a source that throws must not take the snapshot down with it (the whole
// scheduler tick reads this). A source that fails contributes NO debt, which is the safe
// direction - the bot under-reclaims rather than acting on a broken read.
function scaffoldDebts (near, maxDist) {
  try {
    const scaffold = require('./scaffold.js')
    const out = []
    for (const p of scaffold.near(near, maxDist == null ? 1e9 : maxDist)) {
      out.push({ kind: 'scaffold', x: p.x, y: p.y, z: p.z, value: SCAFFOLD_VALUE, at: p.t, purpose: p.purpose, owed: !!p.owed })
    }
    for (const p of scaffold.shaftDebts(near, maxDist == null ? null : maxDist)) {
      out.push({ kind: 'shaft', x: p.x, y: p.y, z: p.z, value: SHAFT_VALUE, at: p.t, was: p.was })
    }
    return out
  } catch { return [] }
}
function containerDebts (near, maxDist) {
  try {
    // world-memory reports the CONTAINER TYPE as `kind` ('furnace'/'chest'); in the ledger's
    // vocabulary the kind is the COMMITMENT CLASS ('container') and the type is detail. Keeping
    // both is what lets settle() route back to the right store without a second lookup.
    return require('./world-memory.js').containerDebts(near, maxDist)
      .map(d => Object.assign({}, d, { kind: 'container', container: d.kind }))
  } catch { return [] }
}
// Graves stay OWNED by grave.js: its salvage policy already prices a grave NET OF THE HAZARD
// that made it (#112 Root E), and re-deriving that here would be exactly the duplicated-model
// defect Root G is about. The ledger only REPORTS them, so "what do I owe" is one question -
// the DECISION to go get one remains graveSweep's, at the survival tier, above this candidate.
function graveDebts (near, maxDist) {
  try {
    const grave = require('./grave.js')
    const out = []
    for (const d of grave.ledger()) {
      if (!d || d.retrieved) continue
      const dd = near ? dist2d(d, near) : 0
      if (maxDist != null && dd > maxDist) continue
      out.push({ kind: 'grave', x: num(d.x), y: num(d.y), z: num(d.z), value: num(d.value), at: d.at, dangerous: !!d.dangerous })
    }
    return out
  } catch { return [] }
}

// ---- debts() ------------------------------------------------------------------------------
// The one read. `near` anchors distance (pass HOME, not the body, when scoring lifetime cost);
// `maxDist` bounds it; `kind` filters. Sorted by value DESC then distance ASC so the caller's
// first element is the debt most worth paying.
function debts (opts = {}) {
  const near = opts.near || { x: 0, y: 0, z: 0 }
  const maxDist = opts.maxDist != null ? opts.maxDist : null
  const want = opts.kind ? (Array.isArray(opts.kind) ? opts.kind : [opts.kind]) : KINDS
  let out = []
  if (want.includes('scaffold') || want.includes('shaft')) out = out.concat(scaffoldDebts(near, maxDist))
  if (want.includes('container')) out = out.concat(containerDebts(near, maxDist))
  if (want.includes('grave')) out = out.concat(graveDebts(near, maxDist))
  out = out.filter(d => want.includes(d.kind))
  for (const d of out) if (d.dist == null) d.dist = dist2d(d, near)
  out.sort((a, b) => (b.value - a.value) || (a.dist - b.dist))
  return out
}

// ---- clusters() ---------------------------------------------------------------------------
// Scattered single blocks are not worth a trip; forty in one place are. Group same-kind debts
// into XZ clusters within `radius` and value the cluster as the sum, so the reclaim candidate
// scores A TRIP, not a block. (Greedy seeded grouping - deterministic given a sorted input,
// which debts() guarantees.)
function clusters (opts = {}) {
  const radius = opts.radius != null ? opts.radius : 12
  const all = debts(opts)
  const out = []
  const taken = new Set()
  for (let i = 0; i < all.length; i++) {
    if (taken.has(i)) continue
    const seed = all[i]
    const members = [seed]
    taken.add(i)
    for (let j = i + 1; j < all.length; j++) {
      if (taken.has(j) || all[j].kind !== seed.kind) continue
      if (dist2d(all[j], seed) <= radius) { taken.add(j); members.push(all[j]) }
    }
    out.push({
      kind: seed.kind, x: seed.x, y: seed.y, z: seed.z, dist: seed.dist,
      n: members.length, value: members.reduce((v, m) => v + m.value, 0), members
    })
  }
  out.sort((a, b) => (b.value - a.value) || (a.dist - b.dist))
  return out
}

// ---- summary() ----------------------------------------------------------------------------
// What the scheduler snapshot carries: total outstanding value, how many entries, and the
// single best cluster to go pay. Kept to plain numbers so scheduler-core stays PURE (it may
// not require this module - it reasons only over the snapshot, exactly like every other term).
//
// `graves` are EXCLUDED from the reclaim summary on purpose: they are already a survival-tier
// candidate (graveSweep) with its own hazard-net pricing, and letting them ALSO inflate a
// maintain-tier reclaim score would double-count the same debt into two competing jobs.
function summary (opts = {}) {
  const o = Object.assign({}, opts, { kind: ['scaffold', 'shaft', 'container'] })
  const cs = clusters(o)
  let value = 0; let n = 0
  for (const c of cs) { value += c.value; n += c.n }
  const best = cs[0] || null
  return {
    value,
    n,
    best: best ? { kind: best.kind, x: best.x, y: best.y, z: best.z, dist: best.dist, n: best.n, value: best.value } : null
  }
}

// ---- owe / settle -------------------------------------------------------------------------
// Write dispatchers, so a caller records a commitment against ONE vocabulary instead of
// knowing which of the four stores owns its kind. Each simply forwards to the store that
// already enforces that kind's lifetime rules.
function owe (entry) {
  if (!entry || !entry.kind) return
  try {
    if (entry.kind === 'shaft') return require('./scaffold.js').oweShaft(entry, entry.was)
    if (entry.kind === 'scaffold') return require('./scaffold.js').add(entry, entry.purpose || 'scaffold')
    if (entry.kind === 'container') return require('./world-memory.js').noteContainer(entry.container || 'furnace', entry, entry.items)
  } catch {}
}
function settle (entry) {
  if (!entry || !entry.kind) return
  try {
    if (entry.kind === 'shaft') return require('./scaffold.js').settleShaft(entry)
    if (entry.kind === 'scaffold') return require('./scaffold.js').forget(entry)
    if (entry.kind === 'container') return require('./world-memory.js').settleContainer(entry.container || 'furnace', entry)
  } catch {}
}

module.exports = { debts, clusters, summary, owe, settle }
