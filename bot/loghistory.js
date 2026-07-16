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

// APPROXIMATE ready-to-eat pack count (S4): points need minecraft-data, which this PURE module
// must not require - so match names against the staples instead. Keeps raw meats and rotten/
// poisonous/spider_eye OUT (guarded below) so the count means "ready to eat" (mirrors foodTier<1
// in spirit). Approximate by design - the operator reads it as a trend, not an exact point total.
const EDIBLE_RE = /bread|cooked_|apple|carrot|baked_potato|melon_slice|cookie|pumpkin_pie|_stew|beetroot|cod|salmon|tropical_fish|dried_kelp|honey_bottle|glow_berries|sweet_berries|chorus_fruit/

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
    isDay: (snap.isDay != null ? snap.isDay : null),
    // S4 survival-signature fields, mapped from data commands.state(bot) already carries (no new
    // plumbing): worn-armor count, approx ready-to-eat pack count, oxygen, and water/underground
    // hazard flags - so the naked-drowning / naked-starving signatures are readable after the fact.
    armor: snap.wearing ? ['head', 'torso', 'legs', 'feet'].filter(k => snap.wearing[k]).length : null,
    packFood: Array.isArray(snap.inventory)
      ? snap.inventory.reduce((sum, e) => {
          const str = String(e); const name = str.split(' ')[0]
          if (!EDIBLE_RE.test(name) || /rotten|spider_eye|poisonous/.test(name)) return sum
          const m = / x(\d+)/.exec(str); return sum + (m ? parseInt(m[1], 10) : 1)
        }, 0)
      : null,
    oxy: num(snap.oxygen), // memory: oxygenLevel is unreliable on live 1.21 (reads ~4 on dry land) - recorded raw anyway, nulls included
    inWater: snap.hazards ? !!snap.hazards.inWater : null,
    underground: snap.hazards ? !!snap.hazards.underground : null,
    // NAV P0 (operator-requested): the remaining hazard flags + the pathfinder goal. The water-pocket
    // wedge signature is inWater+underground+!onGround; nav-wedge INTENT (what it was pathing toward)
    // was otherwise only in bot-events.log, not the time-series. All from data commands.state carries.
    onGround: snap.hazards && snap.hazards.onGround != null ? !!snap.hazards.onGround : null,
    inLava: snap.hazards ? !!snap.hazards.inLava : null,
    onFire: snap.hazards ? !!snap.hazards.onFire : null,
    drowning: snap.hazards ? !!snap.hazards.drowning : null,
    goal: (snap.goal != null ? snap.goal : null)
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
