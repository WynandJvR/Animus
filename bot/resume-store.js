'use strict'
// BUILD-RESUME STORE: the on-disk record of an interrupted build, plus the pure timing and
// disposition rules around it. Split out of commands.js unchanged.
//
// A build used to die with the process (a crash, a restart, a death mid-reboot), which lost
// the castle job twice live. The saved job is {schematic name, origin} so a FRESH process can
// pick the build back up via the `resumebuild` command.
//
// WHAT IS HERE vs WHAT STAYED: this file owns the FILE and the RULES - write, read, clear,
// pause, how long a pause holds, and what a finished build loop should do with the record.
// It does NOT own the build. markBuildInterrupted, setResumeJob and resumeBuild stayed in
// commands.js because they read and write the live build latches (buildAbort, building,
// loadedSchem) and resumeBuild actually re-enters autoBuild. Moving those would mean moving
// the build executor, which is a much bigger decision than this slice.
//
// The two PURE functions (resumeHoldRemaining, finishDisposition) are the reason the split is
// worth it: they encode "when may autonomy take the job back" and "did this build really
// finish", and they are testable here without a bot, a file, or a build.

const fs = require('fs')
const path = require('path')

const { dbg, setDebugSink } = require('./debug-sink.js').makeDebug('[build]') // §4: one definition of the sink rule; this module still owns its own sink

const RESUME_FILE = process.env.RESUME_FILE || path.join(__dirname, 'resume-job.json') // env-overridable (test isolation)
const RESUME_HOLD_MS = parseInt(process.env.RESUME_HOLD_MS || '900000', 10) // pause hold before autonomy resumes (15min)

// THE SAVED BUILD CARRIES ITS FOOTPRINT (2026-08-30 20:33, live: the flat farm plot was sited at 244..249,-257..-252
// - on the castle's own site at 244,68,-261 - because the build zone exists only while a build is RUNNING and the
// resume record held nothing but a centre). `box` is the same avoid-box autoBuild sets as the live build zone.
function persistResume (name, at, box) {
  try {
    const prev = (() => { try { return JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8')) } catch { return null } })()
    const keep = box || (prev && prev.name === name && prev.box) || undefined
    fs.writeFileSync(RESUME_FILE, JSON.stringify({ name, at: { x: at.x, y: at.y, z: at.z }, box: keep, savedAt: new Date().toISOString() }))
  } catch (e) { dbg('persistResume FAILED: ' + e.message) }
}
// The footprint every SITER asks (farm plot, shelter pit, mine entrance): the saved build's box, or null.
function savedBuildBox () { const s = persistedResume(); return (s && s.box && Number.isFinite(s.box.x1)) ? s.box : null }

function clearPersistedResume () { try { fs.unlinkSync(RESUME_FILE) } catch {} }

function persistedResume () {
  try { return JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8')) } catch { return null }
}

// PAUSE the saved job in place (operator stop / shortfall finish / death give-up): stamp
// pausedAt so the resume machinery holds off for RESUME_HOLD_MS, then autonomy picks it back
// up. NOT a delete - operator intent survives; only cancelbuild or a real finish removes it.
function markResumePaused (why, holdMs) {
  try {
    const saved = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'))
    saved.pausedAt = Date.now(); saved.pausedWhy = String(why || '')
    // optional per-pause hold (supervisor unstick = short); absent -> resumeHoldRemaining uses RESUME_HOLD_MS
    if (holdMs != null && Number(holdMs) > 0) saved.pauseHoldMs = Number(holdMs); else delete saved.pauseHoldMs
    fs.writeFileSync(RESUME_FILE, JSON.stringify(saved))
  } catch (e) { dbg('markResumePaused failed: ' + e.message) }
}

// PURE: ms left on a pause hold (0 = resume now). No file / no pausedAt / malformed pausedAt
// all -> 0 (fail OPEN to resume, the safe direction - a saved build must not stall forever).
function resumeHoldRemaining (saved, now) {
  const paused = saved && Number(saved.pausedAt)
  if (!paused || Number.isNaN(paused)) return 0
  const hold = (saved && Number(saved.pauseHoldMs) > 0) ? Number(saved.pauseHoldMs) : RESUME_HOLD_MS
  return Math.max(0, paused + hold - now)
}

// PURE: what to do with the saved build when a build loop settles. Clear ONLY a genuine
// finish; shortfall/all-skipped -> pause (keep the job); errored/deferred/aborted -> keep.
function finishDisposition (r) {
  if (!r) return 'keep'                    // errored/undefined - never delete on a throw
  if (r.deferred) return 'keep'            // resume deferred (old loop still unwinding)
  if (r.stopped) return 'keep'             // aborted, not finished
  if ((r.skipped || 0) > 0) return 'pause' // "done" but blocks/materials are still owed - shortfall
  return 'clear'                           // placed everything it set out to place
}

module.exports = { setDebugSink, persistResume, savedBuildBox, clearPersistedResume, persistedResume, markResumePaused, resumeHoldRemaining, finishDisposition, RESUME_FILE, RESUME_HOLD_MS }
