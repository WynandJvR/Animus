'use strict'
// SCAFFOLD MANAGER: the one owner of "blocks I placed to move/reach", as distinct from
// blocks that are supposed to STAY (build fabric, shelter walls). The pathfix trail
// remembers every placement (safety net: dig-guard, don't-plant-on-own-blocks); THIS
// registry remembers only the temporary ones, with purpose and time, so teardown can be
// deterministic near a build without ever chewing the build itself - FILLER_RE alone
// couldn't tell a scaffold tower from a fresh cobblestone castle wall.
//
// How entries get in:
//  - a SESSION brackets pathfinder-driven movement (navigate.gotoOnce wraps every goto):
//    any block the lib places while executing a goto is by definition movement scaffold -
//    build fabric is placed AFTER the goto completes, outside the bracket.
//  - explicit add() from the manual placers (pillarUpTo's tower blocks).
// pathfix's verifiedPlace calls onPlaced() for every world-verified placement; we file
// it only when a session is open.

const fs = require('fs')
const path = require('path')

let dbgSink = null
function setDebugSink (fn) { dbgSink = fn }
const dbg = (...a) => {
  const line = '[scaffold] ' + a.map(x => String(x)).join(' ')
  if (process.env.BUILD_DEBUG) console.log(line)
  if (dbgSink) dbgSink(line)
}

const MAX_AGE_MS = 6 * 3600 * 1000 // registry entries older than this are landscape now
const FILE = process.env.SCAFFOLD_FILE || path.join(__dirname, 'scaffold-registry.json')
const reg = new Map() // "x,y,z" -> { t, purpose }
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const cut = Date.now() - MAX_AGE_MS
  for (const [k, v] of Object.entries(saved)) { if (v && v.t >= cut) reg.set(k, v) }
} catch {}
let saveTimer = null
function save () {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try { fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(reg))) } catch {}
  }, 2000)
}
function key (p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` }
function sweep () {
  const cut = Date.now() - MAX_AGE_MS
  for (const [k, v] of reg) { if (v.t < cut) reg.delete(k) }
  save()
}

// ---- sessions -----------------------------------------------------------------
const sessions = [] // stack of purpose strings; any open session tags placements
function beginSession (purpose) { sessions.push(purpose || 'move') }
function endSession () { sessions.pop() }
async function inSession (purpose, fn) {
  beginSession(purpose)
  try { return await fn() } finally { endSession() }
}

// ---- writes ---------------------------------------------------------------------
function add (pos, purpose) {
  reg.set(key(pos), { t: Date.now(), purpose: purpose || 'scaffold' })
  if (reg.size > 512) sweep()
  save()
}
// called by pathfix.verifiedPlace on EVERY world-verified placement
function onPlaced (pos) {
  if (!sessions.length) return
  add(pos, sessions[sessions.length - 1])
}
function forget (pos) { reg.delete(key(pos)); save() }

// ---- reads -----------------------------------------------------------------------
function isScaffold (pos, maxAgeMs) {
  const e = reg.get(key(pos))
  return !!e && e.t >= Date.now() - (maxAgeMs || MAX_AGE_MS)
}
function near (pos, r, maxAgeMs) {
  const out = []
  const cut = Date.now() - (maxAgeMs || MAX_AGE_MS)
  for (const [k, v] of reg) {
    if (v.t < cut) continue
    const [x, y, z] = k.split(',').map(Number)
    if (Math.hypot(x - pos.x, z - pos.z) <= r) out.push({ x, y, z, t: v.t, purpose: v.purpose })
  }
  return out
}
function count () { return reg.size }

// ---- filler policy -----------------------------------------------------------------
// Dirt FIRST: cobble towers read as stone litter and the leveler has to shave them;
// dirt pockets back into scaffold supply. One policy for every scaffold placer.
const FILLER_RE = /^(cobblestone|dirt|coarse_dirt|stone|gravel|andesite|diorite|granite|cobbled_deepslate|netherrack|tuff|deepslate)$/
function pickFiller (bot) {
  const items = bot.inventory ? bot.inventory.items() : []
  return items.find(i => /^(dirt|coarse_dirt)$/.test(i.name)) || items.find(i => FILLER_RE.test(i.name))
}

// ---- teardown -----------------------------------------------------------------------
// Ride the towers back down and pocket the filler. Registry-driven and double-gated:
// only cells WE registered, and only if the world still shows a filler block there
// (anything else means the cell got repurposed - drop the entry, never dig).
// opts.alsoTrail: additionally sweep the pathfix trail (legacy/untagged towers) - safe
// ONLY away from builds, since the trail remembers build fabric too.
async function teardown (bot, around, opts = {}) {
  const isStopped = opts.isStopped || (() => false)
  const radius = opts.radius || 12
  const { Vec3 } = require('vec3')
  const { goals } = require('mineflayer-pathfinder')
  const provision = require('./provision.js') // lazy: toolForBlock lives there
  let spots = near(around, radius)
  if (opts.alsoTrail) {
    try {
      const pf = require('./pathfix.js')
      const seen = new Set(spots.map(s => `${s.x},${s.y},${s.z}`))
      for (const p of (pf.selfPlacedNear(around, radius) || [])) {
        const k = `${p.x},${p.y},${p.z}`
        if (!seen.has(k)) { seen.add(k); spots.push(p) }
      }
    } catch {}
  }
  if (!spots.length) return 0
  spots.sort((a, b) => b.y - a.y) // top-down: digging under our own feet rides us down
  let removed = 0
  for (const p of spots.slice(0, opts.max || 32)) {
    if (isStopped()) break
    if (opts.exclude && opts.exclude(p)) continue // e.g. cells the schematic owns
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (!b || !FILLER_RE.test(b.name)) { forget(p); continue } // repurposed/already gone
    if (bot.entity.position.distanceTo(b.position) > 4.5) {
      try { await require('./navigate.js').gotoOnce(bot, new goals.GoalNear(p.x, p.y, p.z, 3), 8000) } catch { continue }
    }
    const tool = provision.toolForBlock ? provision.toolForBlock(bot, b.name) : null // wrong-tool digs drop NOTHING (hoe-dug scaffold vanished, live)
    if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
    if (bot.canDigBlock && !bot.canDigBlock(b)) { continue }
    try { await bot.dig(b); removed++; forget(p); await new Promise(r => setTimeout(r, 150)) } catch {}
  }
  if (removed) dbg('tore down ' + removed + ' scaffold block(s) near ' + Math.round(around.x) + ',' + Math.round(around.z) + ' (' + reg.size + ' registered left)')
  return removed
}

module.exports = { beginSession, endSession, inSession, add, onPlaced, forget, isScaffold, near, count, pickFiller, teardown, setDebugSink, FILLER_RE }
