'use strict'
// PURE + fs helper for the compact, rolling state-history time-series (observability).
// index.js samples /state every ~5s and appends ONE flat JSON line here, so "what was
// the bot doing at 12:05?" is a grep over a small rotated file - not a 29 MB tail of
// brain-decisions.jsonl. Split out from index.js so the mapping + rotation are unit-
// testable offline (statehistorytest.js) with no bot, no server, no pathfinder.
//
// CLI:  node loghistory.js [sinceMs]   -> prints matching lines (used by `ctl.sh history`)

const fs = require('fs')
const path = require('path')

const NL = String.fromCharCode(10)
const HISTORY_FILE = process.env.STATE_HISTORY_FILE || path.join(__dirname, '..', 'logs', 'state-history.jsonl')
const HISTORY_CAP = 5 * 1024 * 1024 // ~5 MB, then rotate to one .old generation

function num (v) { return (typeof v === 'number' && isFinite(v)) ? v : null }

// PURE: map a commands.state(bot) snapshot -> the compact flat time-series line.
// Every field is best-effort; a missing/oddly-shaped snapshot yields nulls, never throws.
function compactSample (snap, now) {
  snap = snap || {}
  const pos = snap.pos || null
  const blockedOn = snap.stuck
    ? ('stuck ' + snap.stuck.forSec + 's')
    : (snap.lastResult && snap.lastResult.ok === false ? ('failed:' + snap.lastResult.action) : null)
  return {
    t: (now != null ? now : Date.now()),
    hp: num(snap.health),
    food: num(snap.food),
    pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
    activity: (snap.activity && snap.activity.name) ? snap.activity.name : null,
    job: (snap.checklist && snap.checklist.step) ? snap.checklist.step : null,
    blockedOn,
    threat: snap.threat ? (snap.threat.type || snap.threat.name || null) : null,
    moving: !!snap.moving,
    graves: (snap.died && typeof snap.died.graves === 'number') ? snap.died.graves : 0,
    biome: (snap.biome != null ? snap.biome : null),
    isDay: (snap.isDay != null ? snap.isDay : null)
  }
}

// PURE: should the file be rotated given its current byte size?
function shouldRotate (size, cap) {
  return typeof size === 'number' && size > (cap || HISTORY_CAP)
}

// Append one compact sample as a JSON line, size-rotating first (keep one .old
// generation). Defensive: recreates a vanished logs/ dir and retries once; a
// transient file lock / disk-full is swallowed so telemetry never kills the bot.
// Returns true on a successful write.
function appendSample (sample, opts) {
  const file = (opts && opts.file) || HISTORY_FILE
  const cap = (opts && opts.cap) || HISTORY_CAP
  const line = JSON.stringify(sample) + NL
  const write = () => {
    try { const st = fs.statSync(file); if (shouldRotate(st.size, cap)) fs.renameSync(file, file + '.old') } catch { /* no file yet, or rename raced - just append */ }
    fs.appendFileSync(file, line)
  }
  try { write(); return true } catch {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); write(); return true } catch { return false }
  }
}

// Read compact samples with t >= sinceMs, spanning the rotated .old then the live
// file (chronological). Best-effort: a missing file or a torn line is skipped.
function readSince (sinceMs, opts) {
  const file = (opts && opts.file) || HISTORY_FILE
  const out = []
  for (const f of [file + '.old', file]) {
    let data
    try { data = fs.readFileSync(f, 'utf8') } catch { continue }
    for (const ln of data.split(NL)) {
      if (!ln) continue
      let o
      try { o = JSON.parse(ln) } catch { continue }
      if (o && (sinceMs == null || (typeof o.t === 'number' && o.t >= sinceMs))) out.push(o)
    }
  }
  return out
}

module.exports = { compactSample, shouldRotate, appendSample, readSince, num, HISTORY_FILE, HISTORY_CAP }

// CLI entry: `node loghistory.js [sinceMs]` - defaults to the last hour.
if (require.main === module) {
  const arg = process.argv[2]
  const since = arg ? parseInt(arg, 10) : (Date.now() - 3600000)
  for (const o of readSince(Number.isFinite(since) ? since : 0)) process.stdout.write(JSON.stringify(o) + NL)
}
