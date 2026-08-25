'use strict'
// ==== ATTEMPT MEMORY: "I tried this, HERE, and it achieved nothing" =========================
// (structural review 2026-08-25, D3 / §3.3 - replaces `runner.noOp` and `runner.ladderBlock`)
//
// THE THING IT REPLACES, AND WHY IT HAD TO GO.
// Two anti-loop latches keyed on scheduler.recoverySignature: a bucketed fingerprint of the hour,
// the gear, the vitals, the graves and the home/farm/bank distances. Both said the same sentence -
// "re-running a plan whose INPUTS have not changed cannot produce a different result" - and both
// were right about that. What neither of them noticed is that POSITION IS NOT IN THE SIGNATURE.
// A bot wedged at full hp beside its own house has a signature that cannot move: standing still
// costs no hunger, gains no gear, meets no grave and changes no distance. So the re-arm condition
// was unreachable from precisely the state the latch was fired in, and the latch became permanent:
//   736 x "already tried this in exactly this situation and it achieved nothing"
//   651 x "last pass made no progress and nothing has changed since"
// in ONE HEAD-era day, alongside 847 ticks of CRISIS UNANSWERED. The bot is stuck, so the world
// does not change, so the rescuer stays disqualified, so the bot stays stuck.
//
// THE FIX IS TO CHANGE WHAT THE MEMORY IS ABOUT (principle #1: not a new guard - a new meaning).
// A no-op verdict is a fact about a PLACE and a STEP, not about an abstract world state:
// "digging in for the night achieved nothing" is true of THIS ground, and stops being true four
// blocks away. So the key is (job, step, 4-block cell) and the re-arm is reachable by the one
// thing a stuck bot can still be made to do - MOVE. Escaping the cell is exactly what changes the
// key, so the terminal action (§3.3) that walks the body somewhere else re-arms every candidate
// it walked away from, by construction and without clearing anything.
//
// recoverySignature is NOT deleted - it is demoted. It rides along on the record as data, and it
// is only ever allowed to CLEAR one (a world that has moved makes an old no-op stale). It can no
// longer be the thing that decides to refuse, which is the whole of what "recoverySignature as a
// gate" meant. Three clearing conditions, all conditions and never timers (#6):
//   1. the body moved to another cell   (the one the old latch could not reach)
//   2. the job is on another step        (item 7's checklist steps; '-' until then)
//   3. the world moved                   (the old signature, now a clearing condition only)
//
// PURE and LEAF: no requires, no clock of its own (callers pass `now`, exactly as scheduler-core
// takes opts.now), no bot handle. reflexes.js can top-require it without touching its load-order
// contract, and it is testable offline with plain numbers.

// 4 blocks, per §3.3. Small enough that a step-out or a door crossing re-arms; big enough that
// jitter inside one stuck cell (pathfinder shuffling, a nudge that lands 1.2b away) does not
// launder a no-op into a fresh attempt. Same 4b radius the freeze watchdog already used to decide
// two failures happened "at the same cell".
const CELL = 4
// Bounded by construction. The key space is (jobs x steps x cells visited), and cells visited is
// unbounded over a long session - a map that only grows is a leak with a slow fuse. Oldest-first
// eviction: the record we are least likely to need is the one about a place we left longest ago.
const MAX_RECORDS = 240

const records = new Map() // key -> { job, step, cell, sig, why, at, n }

// The cell a position falls in. `null` is a legitimate input (a snapshot taken before the entity
// exists), and it gets its own honest key rather than silently sharing cell 0,0,0 with spawn.
function cellOf (pos, size) {
  if (!pos || pos.x == null || pos.z == null) return 'nowhere'
  const s = size || CELL
  return Math.floor(pos.x / s) + ',' + Math.floor((pos.y == null ? 0 : pos.y) / s) + ',' + Math.floor(pos.z / s)
}
function keyOf (job, step, cell) { return String(job) + '|' + String(step || '-') + '|' + String(cell) }

// Write the verdict. `sig` is the world fingerprint AT THE MOMENT OF THE VERDICT - stored, never
// keyed on. `why` is the executor's own words for what blocked it, so the refusal this record
// later produces can name the blocker (#7: every refusal logs the blocker).
function record (job, step, cell, opts = {}) {
  const key = keyOf(job, step, cell)
  const prev = records.get(key)
  if (prev) records.delete(key) // re-insert: LRU by last write, so a place we keep failing at stays warm
  const rec = {
    job, step: step || '-', cell,
    sig: opts.sig || '',
    why: opts.why || 'it achieved nothing',
    at: opts.now != null ? opts.now : 0,
    n: prev ? prev.n + 1 : 1
  }
  records.set(key, rec)
  while (records.size > MAX_RECORDS) records.delete(records.keys().next().value)
  return rec
}

function recall (job, step, cell) { return records.get(keyOf(job, step, cell)) || null }

// THE ONE QUESTION THE ARBITER ASKS: has this job already achieved nothing, here, in a world that
// still reads the same? Returns the record (so the caller can quote its blocker and its count) or
// null. A record whose world HAS moved is deleted on the spot - "on read", the same lazy-expiry
// idiom reflexes.js's holds and claims use, so nothing has to remember to sweep it.
function futile (job, step, cell, sig) {
  const key = keyOf(job, step, cell)
  const rec = records.get(key)
  if (!rec) return null
  if (sig && rec.sig && sig !== rec.sig) { records.delete(key); return null }
  return rec
}

function forget (job, step, cell) { return records.delete(keyOf(job, step, cell)) }

// THE FULL RESET's half of §3.3 ("clear every refusal latch"). `except` names the job whose
// records survive - the terminal action's own, because a memory that erases itself cannot
// escalate, and "this is the third full reset in this cell" is the one verdict item 5's rescue
// path needs from this layer.
function forgetAll (opts = {}) {
  const except = opts.except || null
  let n = 0
  for (const [k, rec] of Array.from(records.entries())) {
    if (except && rec.job === except) continue
    records.delete(k); n++
  }
  return n
}

// One greppable line with the numbers in it (#7), for the log and the panel.
function info () {
  return Array.from(records.values()).map(r => ({ job: r.job, step: r.step, cell: r.cell, n: r.n, at: r.at, why: r.why }))
}
function size () { return records.size }
function _reset () { records.clear() }

module.exports = { CELL, MAX_RECORDS, cellOf, keyOf, record, recall, futile, forget, forgetAll, info, size, _reset }
