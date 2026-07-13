'use strict'
// LINE-OF-SIGHT (pure): is the straight segment from `from` to `to` blocked by a SOLID cell
// other than the endpoints? Used to stop the bot INTERACTING WITH A STATION/CHEST THROUGH A
// WALL (item 4, believability): a chest can be within 4.5-block reach yet on the far side of a
// wall - a real player walks around to a face they can actually see. PURE (a solidity callback
// in, boolean out - no bot) so it is offline-testable (bot/lostest.js).

// Sample the segment finely and report the first intervening SOLID voxel (excluding the start
// and target cells). isSolid(x,y,z) => boolean (a full-cube collider that isn't air/the target).
function lineBlocked (from, to, isSolid, opts = {}) {
  const step = opts.step != null ? opts.step : 0.25
  const dx = to.x - from.x; const dy = to.y - from.y; const dz = to.z - from.z
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-6) return false
  const n = Math.max(1, Math.ceil(len / step))
  const startCell = Math.floor(from.x) + ',' + Math.floor(from.y) + ',' + Math.floor(from.z)
  const endCell = Math.floor(to.x) + ',' + Math.floor(to.y) + ',' + Math.floor(to.z)
  let last = null
  for (let i = 1; i < n; i++) {
    const t = i / n
    const x = Math.floor(from.x + dx * t); const y = Math.floor(from.y + dy * t); const z = Math.floor(from.z + dz * t)
    const k = x + ',' + y + ',' + z
    if (k === last || k === startCell || k === endCell) continue
    last = k
    if (isSolid(x, y, z)) return true
  }
  return false
}

// The candidate standing cells around a station block (the 4 horizontal neighbours, and the
// same one block up/down for a step) - where a bot could stand to use it with a clear line.
// Returns [{x,y,z}] feet cells (station block Y, i.e. standing beside it). PURE.
function faceApproachCells (station) {
  const out = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, -1, 1]) out.push({ x: station.x + dx, y: station.y + dy, z: station.z + dz })
  }
  return out
}

module.exports = { lineBlocked, faceApproachCells }
