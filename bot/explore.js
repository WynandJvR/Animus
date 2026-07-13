'use strict'
// PROACTIVE EXPLORATION (pure): a systematic outward sweep to FIND resources (animals/water)
// the bot hasn't seen. The core fix for "starved 88 blocks from a river full of sheep because
// it only ever looked NE and re-tread stale remembered pastures". 8 compass OCTANTS x
// expanding RINGS around home, ordered near-ring-first; the driver marks each visited sector
// (persisted, decaying) so it steers to genuinely-UNSEARCHED ground instead of blindly
// re-expanding from known-empty spots. PURE (offline-testable: bot/exploretest.js).
//
// This is the first bounded slice of the [[semantic-world-map]] / natural-player scouting
// drive: a real player drops into a new area and sweeps it in a pattern, remembering what's
// where - it doesn't wait until starving to look, and it doesn't only look one way.

// E, SE, S, SW, W, NW, N, NE (unit vectors; SW is index 3 - where the live food was).
const OCTANTS = [
  [1, 0], [0.707, 0.707], [0, 1], [-0.707, 0.707],
  [-1, 0], [-0.707, -0.707], [0, -1], [0.707, -0.707]
]
const OCT_NAMES = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']

// All sweep waypoints: every octant at every ring, ordered NEAR-RING-FIRST (find close food
// before trekking far) then by octant. Each has a stable `key` the driver marks as searched.
function octantSweep (home, opts = {}) {
  const rings = opts.rings || [48, 96, 144]
  const out = []
  for (const r of rings) {
    for (let o = 0; o < OCTANTS.length; o++) {
      out.push({
        x: Math.round(home.x + OCTANTS[o][0] * r),
        z: Math.round(home.z + OCTANTS[o][1] * r),
        key: 'r' + r + 'o' + o,
        ring: r,
        oct: o,
        name: OCT_NAMES[o]
      })
    }
  }
  return out
}

// The first waypoint whose sector hasn't been searched (recently) - what the driver treks to
// next. `searchedSet` is a Set of keys the driver has visited within the decay window. Returns
// null when every sector has been swept recently (the driver then waits / gives up honestly).
function firstUnswept (waypoints, searchedSet) {
  for (const w of waypoints) if (!searchedSet || !searchedSet.has(w.key)) return w
  return null
}

// Which sweep sector a world position falls in (for crediting a sector as searched by the
// bot's ACTUAL position, not just the intended waypoint). Nearest waypoint by distance.
function sectorKeyAt (x, z, home, opts = {}) {
  const wps = octantSweep(home, opts)
  let best = null; let bd = Infinity
  for (const w of wps) { const d = Math.hypot(w.x - x, w.z - z); if (d < bd) { bd = d; best = w } }
  return best ? best.key : null
}

module.exports = { OCTANTS, OCT_NAMES, octantSweep, firstUnswept, sectorKeyAt }
