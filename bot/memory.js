'use strict'
// Tiny PERSISTENT memory for the bot — named waypoints that survive restarts, so
// it "knows your world" across sessions ("remember this as home" -> later "go
// home"). Stored as JSON next to the bot. Deliberately small and self-contained;
// room to grow into other remembered facts later.

const fs = require('fs')
const path = require('path')
const FILE = process.env.MEMORY_FILE || path.join(__dirname, 'memory.json')

let data = { waypoints: {} }
try {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  if (j && typeof j === 'object') data = { waypoints: j.waypoints || {} }
} catch { /* no memory file yet — start fresh */ }

function save () {
  try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)) } catch { /* best-effort; never crash the bot over memory */ }
}

function norm (name) { return String(name || '').trim().toLowerCase() }

function setWaypoint (name, pos) {
  const k = norm(name)
  if (!k || !pos) return null
  data.waypoints[k] = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }
  save()
  return data.waypoints[k]
}
function getWaypoint (name) { return data.waypoints[norm(name)] || null }
function removeWaypoint (name) {
  const k = norm(name)
  if (data.waypoints[k]) { delete data.waypoints[k]; save(); return true }
  return false
}
function listWaypoints () { return data.waypoints }
function waypointNames () { return Object.keys(data.waypoints) }

module.exports = { setWaypoint, getWaypoint, removeWaypoint, listWaypoints, waypointNames }
