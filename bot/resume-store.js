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

let dbgSink = null // forwarded from commands.js's setDebugSink
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[build] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const RESUME_FILE = process.env.RESUME_FILE || path.join(__dirname, 'resume-job.json') // env-overridable (test isolation)
const RESUME_HOLD_MS = parseInt(process.env.RESUME_HOLD_MS || '900000', 10) // pause hold before autonomy resumes (15min)

function persistResume (name, at) {
  try { fs.writeFileSync(RESUME_FILE, JSON.stringify({ name, at: { x: at.x, y: at.y, z: at.z }, savedAt: new Date().toISOString() })) } catch (e) { dbg('persistResume FAILED: ' + e.message) }
}

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

module.exports = { setDebugSink, persistResume, clearPersistedResume, persistedResume, markResumePaused, resumeHoldRemaining, finishDisposition, RESUME_FILE, RESUME_HOLD_MS }
