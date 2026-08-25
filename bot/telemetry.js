'use strict'
// BODY OBSERVABILITY: what the body is DOING, how the last long op ENDED, whether it is
// making VERIFIED progress, and whether it is WEDGED. Split out of commands.js unchanged.
//
// The brain reads /state to make high-level calls; without these a stuck or failed body
// looks identical to a working one, so the brain re-issues the same doomed command and
// idles up to a heartbeat before noticing. These surface enough for the brain to change
// approach - the low-level recovery stays body-side.
//
// ---- THE CYCLE THIS SPLIT HAD TO BREAK ----------------------------------------------
// commands.js's trackTick did three things in one function: stamp the bot reference, take
// an inventory snapshot for the DEATH LEDGER, and run position/stuck tracking. That made
// telemetry and the grave ledger mutually dependent - trackTick (telemetry) called
// snapInventory (grave), while snapInventory called touchProgress (telemetry) - so
// neither could move first.
//
// Broken by SPLITTING the tick rather than the modules: this file owns trackPosition(),
// commands.js keeps a thin trackTick() that calls snapInventory and then trackPosition.
// The dependency is now one-way (grave -> telemetry) and the orchestration stays with the
// module that owns both halves' state.
//
// isBusy/escaping are INJECTED for the same reason - they are commands.js build latches,
// and reaching back for them is what made this file inseparable in the first place.

const fs = require('fs')
const path = require('path')

const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[build]') // §4: one definition of the sink rule; this module still owns its own sink

// ---- ACTIVITY + OUTCOME --------------------------------------------------------------
let activity = null    // { name, detail, startedAt } - a long op running RIGHT NOW
let lastOutcome = null // { action, ok, detail, at } - how the last long op ended
const EPISODE_LOG = process.env.EPISODE_LOG || path.join(__dirname, 'body-episodes.jsonl')
let globalBot = null // set by trackTick; lets endActivity snapshot vitals without threading bot everywhere
function setBot (bot) { globalBot = bot }

// activityInfo: a one-liner over the module `activity` record (set by beginActivity) so
// schedulerState can read the active op's name/detail/startedAt WITHOUT building the
// heavyweight state(bot) snapshot (blockAtCursor/entity summaries) on every tick.
// null when nothing is running.
// ==== AN ACTIVITY IS A LEASE, NOT A FLAG (2026-07-31) =======================================
// beginActivity/endActivity are correctly paired at every call site (try / catch / finally). That
// is only sufficient while the awaited work RESOLVES. `planner.gearUp` did not: it hung, so the
// try body never finished, the catch never fired, endActivity never ran - and the label stayed
// open for FIFTY-TWO MINUTES. The bot stood frozen at (216,58,-124) reporting
// `activity: gearup, forSec: 3150` while the watchdog failed a job that was not running:
//   (wd) NUDGE gearup -> FAIL-JOB gearup -> stop latch ineffective -> gearup holds no dispatch
//   slot - releasing the controls        ...19 times, every 2.5 minutes
// It held no dispatch slot because maintenancePass had long since returned. The watchdog was
// chasing a ghost, and had nothing it could revoke.
//
// This is the SAME rule the repo already applies twice, and states in its own comments:
//   reflexes.activeHold - "an expired hold is NOT a hold: the watchdog gets the body back"
//   dispatchBusy        - "the slot is a LEASE, not a flag" (55857e6)
// The activity label was the last exclusive claim exempt from it. Now it expires lazily on read,
// exactly as those two do, so a hung promise can no longer leave a permanent phantom job.
// The first cut of this bounded the label with a 15-MINUTE LEASE. That was a blanket timer and a
// number I invented - exactly what DESIGN-PRINCIPLES #6 forbids ("gate on has the world changed
// in a way that matters, not on N minutes have passed") - and 15 minutes is far too long to be a
// useful backstop anyway. DELETED. The condition that actually matters is "is the work behind
// this label still making verified progress", and the watchdog already measures precisely that
// and escalates NUDGE -> FAIL-JOB -> GIVEUP on it. Its terminal rung is the ONE owner of
// reclaiming a hung body, and it calls clearActivity() below. One owner, no constant.
function activityInfo () { return activity ? { name: activity.name, detail: activity.detail, startedAt: activity.startedAt } : null }

// Drop a label whose work is provably hung. Only the watchdog's terminal rung calls this, and
// only after the full verified-progress ladder has run - so this is evidence, never a timeout.
function clearActivity (why) {
  if (!activity) return false
  activity = null
  return true
}

function beginActivity (name, detail) { activity = { name, detail: detail || '', startedAt: Date.now() } } // no t0 stamp: `startedAt` IS this job's zero-idle mark, and the work ledger re-bases on the new key (the old touchProgress('begin:') told EVERY reader the body had progressed - a lie a fresh label had no business telling)

// Record an outcome the brain should NOTICE: any FAILURE, a DETACHED flow (build/
// provision/autobuild resolve after /cmd already returned, so their result never
// reaches the brain otherwise), or anything that ran > 45s (likely outlived the brain's
// 60s /cmd fetch). Short successful awaited commands already reach the brain via the
// /cmd reply + history, so we skip those to avoid redundant wakes.
function endActivity (ok, detail, opts = {}) {
  const a = activity
  if (a && (!ok || opts.detached || Date.now() - a.startedAt > 45000)) {
    lastOutcome = { action: a.name + (a.detail ? ' ' + a.detail : ''), ok: !!ok, detail: String(detail || '').slice(0, 100), at: Date.now() }
  }
  // TRAINING DATA (episodes): the body's autonomous task-level competence - gathers,
  // recoveries, travels, builds - with real outcomes and durations. The brain dataset
  // only captures brain choices; this captures what the BODY can do (the richer skill).
  if (a) {
    try { pushOutcomeRing(a.name + (a.detail ? ' ' + a.detail : ''), ok, detail, (!ok && /\(stopped\)/.test(String(detail || '')))) } catch {} // task #34: feed the outcome ring (successes too - they reset a repeat-fail streak); #49: a "(stopped)" fail is a watchdog/preempt-induced PAUSE, not a behavioral failure -> tag selfAbort
    try {
      const b = globalBot
      fs.appendFile(EPISODE_LOG, JSON.stringify({
        t: Date.now(), episode: a.name, detail: String(a.detail || '').slice(0, 60), ok: !!ok,
        note: String(detail || '').slice(0, 100), ms: Date.now() - a.startedAt,
        hp: b && b.health != null ? Math.round(b.health * 10) / 10 : null,
        food: b && b.food != null ? b.food : null,
        pos: b && b.entity ? { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) } : null
      }) + '\n', () => {})
    } catch {}
  }
  if (a && a.name === 'autobuild') jobList = null // the job's checklist dies with the job
  activity = null
}

// Let non-command code (reflexes) record an outcome directly (e.g. a wedged follow).
function recordOutcome (action, ok, detail) { lastOutcome = { action, ok: !!ok, detail: String(detail || '').slice(0, 100), at: Date.now() }; try { pushOutcomeRing(action, ok, detail, /^watchdog:/.test(String(action || ''))) } catch {} } // task #34: also feed the bounded outcome ring; #49: watchdog:* records are the watchdog's own verdict -> tag selfAbort

function lastOutcomeInfo () { return lastOutcome }

// ---- S7 FORWARD-PROGRESS: TWO CLOCKS, BECAUSE THERE ARE TWO QUESTIONS ----------------
// There used to be ONE cell here and every touchProgress(tag) refreshed its timestamp, so
// "IS THIS JOB ADVANCING" was answered by "did ANYTHING happen to the body". Those are two
// different questions, and on 2026-08-03 16:54-20:10 they came apart and the process died in
// the gap. The bot was wedged one block from its own hut. The freeze watchdog fired at 195s,
// its step-out rungs netted 1.6-2.2b, returned MOVED and stamped navRung: - and the JOB
// watchdog's 240s fail rung, 45 seconds short, reset to zero. Thirty-two times, on an exact
// 4-minute period, for four hours: 32 NUDGE lines, ZERO FAIL-JOB, zero work of any kind.
// The layer whose entire purpose is to detect a stuck job was fed a clock that the stuck-ness
// itself wound (structural review 2026-08-25, D1).
//
// So the two questions have two records now:
//   bodyProgress   IS THE BODY DOING ANYTHING - any touch refreshes `at`. Read by /state, by the
//                  heartbeat merge and by provision-recovery's boundedRung (a rung that is
//                  walking is a rung doing its job). It is NOT a verdict about a job.
//   the WORK LEDGER (below)  IS THIS JOB ADVANCING - a WORLD-STATE DELTA, keyed by jobKey. The
//                  ONLY input to activeJobInfo.lastProgressAt -> scheduler.watchdog -> wdPhase.
//
// An ADVANCE is production (CYCLE_WORK_TAGS: an item/block/smelt/heal/rung/chore delta, all of
// them already re-read from the world by pathfix or by their own verify) or NEW GROUND (the
// ratchet in trackPosition below). Explicitly NOT an advance, and each one deleted at its call
// site rather than filtered here: being dispatched, a label opening, a declared hold existing,
// a navigation recovery rung returning ok, and re-treading ground already covered.
//
// task #34 (cycle detector): workCount stays PRODUCTION-ONLY and separate from advanceCount -
// the oscillation predicate requires ZERO work touches across its whole window, and crediting
// travel to it would let a chest<->build shuttle hide from the detector.
const CYCLE_WORK_TAGS = new Set(['itemDelta', 'placed', 'broke', 'smelt', 'regen', 'ladderRung', 'maintStep', 'harvest', 'replant'])
const GROUND_TAGS = new Set(['newGround']) // the anti-spin ratchet's stamp; see trackPosition
let bodyProgress = { at: Date.now(), by: 'boot', stalled: false, workCount: 0, advanceCount: 0, advanceAt: Date.now() }
function touchProgress (tag) {
  const p = bodyProgress
  const now = Date.now()
  const work = CYCLE_WORK_TAGS.has(tag)
  const advance = work || GROUND_TAGS.has(tag)
  bodyProgress = {
    at: now,                                              // the BODY clock: any touch
    by: tag || '',
    stalled: advance ? false : p.stalled,                 // the nudge marker is a verdict about the JOB, so only an ADVANCE clears it
    workCount: (p.workCount || 0) + (work ? 1 : 0),
    advanceCount: (p.advanceCount || 0) + (advance ? 1 : 0),
    advanceAt: advance ? now : (p.advanceAt || now)
  }
}
function progressInfo () { return bodyProgress }
function markStalled () { bodyProgress.stalled = true } // the nudge's blockedOn='stalled' marker; cleared by the next ADVANCE (never by a wiggle)

// ---- THE WORK LEDGER (per job) -------------------------------------------------------
// Reconciled LAZILY ON READ, the idiom this repo already uses for the other two exclusive
// records (reflexes.activeHold drops an expired hold on read; the dispatch slot is a lease).
// Two things it makes true that the global cell could not:
//   * A JOB'S CLOCK STARTS AT ITS OWN startedAt. That is exactly what the five `zero-idle at
//     t0` touches (begin:, dispatch:, and the survival t0 stamps) were faking through a global
//     cell, and faking it globally is what let any subsystem hand any other subsystem a fresh
//     clock. Now it is structural: a new key re-bases, nobody has to remember to stamp.
//   * WORK IS CREDITED TO THE JOB THAT WAS RUNNING, not to the process. A rescue can no longer
//     gift its jiggle to a build, because a jiggle is not an advance AND because the ledger
//     belongs to the key.
// NOTE the remaining honest gap, left for the ownership work (review item 2): while one job
// holds the key, ANY advance in the process credits it. Closing that needs a claim registry
// that says who is driving - not another counter here.
let workLedger = { key: null, at: 0, count: 0 }
let idleSuppressedAt = 0 // a DECLARED hold vouches for stillness: it SUPPRESSES this clock, it never feeds it
function jobProgress (jobKey, startedAt) {
  const now = Date.now()
  const c = bodyProgress.advanceCount || 0
  if (workLedger.key !== jobKey) {
    workLedger = { key: jobKey, at: (startedAt != null ? startedAt : now), count: c }
    bodyProgress.stalled = false // the nudge marker belongs to the job that was nudged; a new job has not been
  }
  else if (c !== workLedger.count) workLedger = { key: jobKey, at: bodyProgress.advanceAt || now, count: c }
  return { at: Math.max(workLedger.at, idleSuppressedAt), stalled: !!bodyProgress.stalled, workCount: bodyProgress.workCount || 0 }
}
// The watchdog's declared-hold branch calls this instead of stamping progress. "Sitting still IS
// the goal" is a reason not to count the seconds; it is not evidence that the job advanced, and
// writing it into the one progress cell told every other reader it was (#7).
function suppressJobIdle () { idleSuppressedAt = Date.now() }
// THE SAME EVIDENCE, WITHOUT A JOB KEY (review item 2). A body CLAIM is not a job: it has its own
// takenAt and it is not the thing the watchdog re-bases per dispatch, so it cannot ask jobProgress
// (which would re-key the ledger out from under the watchdog on every read). What it needs is the
// other half of the same record - WHEN DID THE WORLD LAST MOVE, or when was stillness last vouched
// for by a declared hold - and that is exactly `advanceAt` and `idleSuppressedAt`. One reading of
// one pair of cells: cheap enough for the ownership question, which is asked on the 1.5s follow
// timers as well as on the tick ([[body-first-priority]]).
function advanceInfo () { return { at: Math.max(bodyProgress.advanceAt || 0, idleSuppressedAt), count: bodyProgress.advanceCount || 0 } }
function _resetProgress () { bodyProgress = { at: Date.now(), by: 'reset', stalled: false, workCount: 0, advanceCount: 0, advanceAt: Date.now() }; workLedger = { key: null, at: 0, count: 0 }; idleSuppressedAt = 0 } // test seam (house pattern: _setNow/_setMaintaining)

// ---- OUTCOME RING (task #34) ---------------------------------------------------------
// A bounded 16-entry history of how recent long ops ENDED, so the repeat-fail predicate can SEE
// the same failure recur. The architecture records each failure into the single-record
// `lastOutcome` and immediately forgets it (that is the "why is this even possible" gap); this
// ring is the memory. Pushed from the two EXISTING recording paths (endActivity / recordOutcome)
// + the scheduler's runJob catch. Each record: { t, action, ok, failClass, cell } where
// failClass = detail lowercased with digits/coords stripped (so "door at 433,62,112" repeats match)
// and cell = position floored to 4b. lastOutcome / the brain's lastResult are UNCHANGED (additive).
const CYCLE_OUTCOME_MAX = 16
let recentOutcomesRing = []
function cycleFailClass (detail) { return String(detail || '').toLowerCase().replace(/-?\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim() }
function cycleCellOf () { const b = globalBot; const p = b && b.entity && b.entity.position; if (!p) return null; return { x: Math.floor(p.x / 4) * 4, y: Math.floor(p.y / 4) * 4, z: Math.floor(p.z / 4) * 4 } }
function pushOutcomeRing (action, ok, detail, selfAbort) {
  recentOutcomesRing.push({ t: Date.now(), action: String(action || ''), ok: !!ok, failClass: ok ? '' : cycleFailClass(detail), cell: cycleCellOf(), selfAbort: !!selfAbort }) // #49: selfAbort tags watchdog/preempt-induced "(stopped)" pauses; additive + inert unless index.js filters on it
  if (recentOutcomesRing.length > CYCLE_OUTCOME_MAX) recentOutcomesRing.shift()
}
function recentOutcomes () { return recentOutcomesRing }

// ---- JOB CHECKLIST -------------------------------------------------------------------
// (operator order: a goal gets a CHECKLIST and is worked step by step - only survival may
// interrupt). Observational, not a scheduler: each phase of a job announces itself, so the
// flight recorder and /state always show exactly which step the job is on ("what is it doing"
// is never a guess). Cleared when the autobuild activity ends; each step's own code still
// decides whether it applies (no-op = quick).
let jobList = null // { steps: [names], current, startedAt }
const JOB_STEPS = ['travel to site', 'survey the site', 'basic tools', 'stone pickaxe',
  'camp: chest/furnace/bed', 'camp: safehouse hut', 'camp: bank into hut', 'camp: wheat farm', 'armor up', 'gather materials', 'build']
function checklistBegin (steps) { jobList = { steps: steps.slice(), current: null, startedAt: Date.now() } }
function checklistStep (name) {
  if (!jobList) return
  jobList.current = name
  dbg(`[job] step ${jobList.steps.indexOf(name) + 1}/${jobList.steps.length}: ${name}`)
}
function checklistInfo () { return jobList }

// ---- STUCK DETECTION -----------------------------------------------------------------
// The body is TRYING to get somewhere but making no progress. Driven by index.js on a 1s tick.
// "Trying" = a non-follow pathfinder goal is set, OR a travel/gather/come/recover activity is
// running. "No progress" = moved < 1.5 blocks (3-D, so a climb-out counts as progress) over the
// trailing ~12s. Excluded so we don't cry wolf: operator builds (isBusy - they legitimately
// stand still and self-recover), cave-escape climbs (escaping), active digs (targetDigBlock IS
// progress), and follow (a stationary player is not "stuck" - the leash reflex owns that).
// Surfaced in /state.stuck.
let posHist = []       // ring of { x, y, z, t }
let stuckSince = 0
let tryingSince = 0    // when the CURRENT move attempt began (goal/activity became active)
let groundTrail = []   // S7 H1: the last GROUND_TRAIL_MAX anchors of new ground (anti-spin ratchet; reset on respawn)
const STUCK_WINDOW_MS = 12000
const STUCK_DIST = 1.5
const GROUND_STEP = 8      // how far is "somewhere else"
const GROUND_TRAIL_MAX = 16 // ~128b of remembered trail - long enough that an A<->B shuttle never escapes it
function stuckInfo () { return stuckSince }
function resetProgressAnchor () { groundTrail = [] } // recordDeath: the respawn teleport must re-anchor cleanly (a huge displacement is not progress)

// The position/stuck half of the old trackTick. `opts.isBusy` / `opts.escaping` are the
// commands.js build latches, injected rather than reached for (see the cycle note above).
function trackPosition (bot, opts = {}) {
  const isBusy = typeof opts.isBusy === 'function' ? opts.isBusy : () => false
  const escaping = !!opts.escaping
  const ent = bot.entity
  if (!ent || !ent.position) { stuckSince = 0; tryingSince = 0; posHist = []; return }
  const now = Date.now()
  const p = ent.position
  posHist.push({ x: p.x, y: p.y, z: p.z, t: now })
  while (posHist.length && now - posHist[0].t > STUCK_WINDOW_MS + 2000) posHist.shift()
  // S7 H1 (before the isBusy early-return below - busy bodies are exactly who we watch): the
  // NEW-GROUND RATCHET. It used to be a single anchor: 8 blocks from where you last stamped and
  // you stamped again. That killed spinning/bobbing/pacing inside an 8b pocket, which is the only
  // case it was built for - but it happily paid an A<->B shuttle twice per lap, because B is
  // always 8b from A. Displacement is only evidence of progress when the ground is NEW, so the
  // anchor became a TRAIL: a stamp requires GROUND_STEP from EVERY remembered anchor, and
  // re-treading covered ground is worth exactly zero (structural review 2026-08-25, §3.1's
  // ratchet). Cost: <=16 hypots/s, on the tick that already ran one (#8).
  // What it deliberately does NOT know is the job's GOAL, so new ground walked while ESCAPING
  // still counts. That last mile needs the job to publish where it is going - review item 7.
  if (!groundTrail.some(a => Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) < GROUND_STEP)) {
    if (groundTrail.length) touchProgress('newGround') // the first anchor after a respawn/boot is a starting point, not a journey
    groundTrail.push({ x: p.x, y: p.y, z: p.z })
    if (groundTrail.length > GROUND_TRAIL_MAX) groundTrail.shift()
  }
  const goal = bot.pathfinder && bot.pathfinder.goal
  const following = goal && goal.constructor && goal.constructor.name === 'GoalFollow'
  const trying = (goal && !following) || (activity && /^(travel|gather|come|recover)$/.test(activity.name))
  if (!trying || bot.targetDigBlock || isBusy() || escaping) { stuckSince = 0; tryingSince = 0; return }
  if (!tryingSince) tryingSince = now // just started this attempt - clock starts NOW, so idle time
  // before the move began (pathfinding takes a second or two) never counts as "stuck".
  if (now - tryingSince < STUCK_WINDOW_MS) return // give the attempt a full window to show progress
  const cutoff = Math.max(now - STUCK_WINDOW_MS, tryingSince)
  const old = posHist.find(h => h.t >= cutoff)
  if (!old) return
  const moved = Math.hypot(p.x - old.x, p.y - old.y, p.z - old.z)
  if (moved < STUCK_DIST) { if (!stuckSince) stuckSince = now }
  else stuckSince = 0
}

module.exports = {
  setDebugSink,
  setBot,
  activityInfo, clearActivity,
  beginActivity,
  endActivity,
  recordOutcome,
  lastOutcomeInfo,
  touchProgress,
  progressInfo,
  jobProgress,
  suppressJobIdle,
  advanceInfo,
  markStalled,
  _resetProgress,
  recentOutcomes,
  cycleFailClass,
  checklistBegin,
  checklistStep,
  checklistInfo,
  JOB_STEPS,
  trackPosition,
  stuckInfo,
  resetProgressAnchor,
  CYCLE_WORK_TAGS
}
