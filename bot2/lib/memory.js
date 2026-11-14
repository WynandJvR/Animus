'use strict'
// Persistent facts about the world the bot has learned: home, bed, chests, furnaces, the mine,
// the build job, deaths. One JSON file, written on every change (small, rare writes).
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'memory.json')

const DEFAULTS = {
  home: null, // {x,y,z} - the base anchor
  bed: null, // {x,y,z} - our bed block (foot)
  chests: [], // [{x,y,z}] - chests we own at the base
  furnaces: [], // [{x,y,z}]
  tables: [], // [{x,y,z}]
  mine: null, // {entrance:{x,y,z}, dir:{x,z}, level:y, next:{x,y,z}, torches:n}
  build: null, // {name, origin:{x,y,z}}
  deaths: [], // [{x,y,z,t,cause,items}]
  scaffold: [], // [{x,y,z}] temp blocks placed for building, to remove later
  dangers: [], // [{x,y,z,t,why}] places that nearly killed us
  stats: {}
}

let mem = null

function load () {
  if (mem) return mem
  try { mem = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8'))) } catch { mem = JSON.parse(JSON.stringify(DEFAULTS)) }
  return mem
}

// THE WRITE, BATCHED: a change marks the file dirty and one write goes out a second later, off the body's loop. Written
// synchronously on every change, a build step's withdrawals - each chest's contents a change - wrote the 55 KB file seven
// times in five seconds at 400-700ms each, the body frozen 3s (2026-09-28). A crash loses a second of memory at most; an
// exit writes it at once (flushSync).
let dirty = false; let timer = null; let writing = false
function flushSync () {
  if (timer) { clearTimeout(timer); timer = null }
  if (!dirty || !mem) return
  dirty = false
  // (its own tmp name - an async write may be mid-flight to '.tmp' at exit - and a second try: a rename onto the file can
  //  fail EPERM on Windows while another process has it open; audit)
  const tmp = FILE + '.exit.tmp'; const body = JSON.stringify(mem, null, 1)
  for (let i = 0; i < 2; i++) { try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, FILE); return } catch {} }
}
async function flush () {
  timer = null
  if (!dirty || !mem) return
  if (writing) { timer = setTimeout(flush, 250); return } // (one write at a time: the next once this lands)
  dirty = false; writing = true
  try { await fs.promises.writeFile(FILE + '.tmp', JSON.stringify(mem, null, 1)); await fs.promises.rename(FILE + '.tmp', FILE) } catch { dirty = true } finally { writing = false }
  if (dirty && !timer) timer = setTimeout(flush, 1000)
}
function save () {
  dirty = true
  if (!timer) timer = setTimeout(flush, 1000)
}
process.on('exit', flushSync)

function get () { return load() }
function set (key, value) { load()[key] = value; save(); return value }
function update (fn) { fn(load()); save() }

function addUnique (key, pos) {
  const m = load()
  const list = m[key] || (m[key] = [])
  if (!list.some(p => p.x === pos.x && p.y === pos.y && p.z === pos.z)) { list.push({ x: pos.x, y: pos.y, z: pos.z }); save() }
}
function removePos (key, pos) {
  const m = load()
  const list = m[key] || []
  const n = list.length
  m[key] = list.filter(p => !(p.x === pos.x && p.y === pos.y && p.z === pos.z))
  if (m[key].length !== n) save()
}
function bump (stat, by = 1) { const m = load(); m.stats[stat] = (m.stats[stat] || 0) + by; save() }

// A Map kept in memory.json - for the day-keyed rests (a trip put off today, a stray given up today): in memory only, a
// restart - ten deploys in a night - wiped them all, and no day rule ever held (2026-09-30; audit). get/has/set/delete;
// set and delete save (set() coalesces the writes)
// (a real Map - every Map operation works by construction: a hand-listed look-alike lacked the spread, and build's pocket
//  signature threw "coverMiss is not iterable" every step after the deploy, 2026-09-30; audit)
class PersistedMap extends Map {
  constructor (name) { super(Object.entries(get()[name] || {})); this.name = name; this.ready = true }
  keep () { if (this.ready) set(this.name, Object.fromEntries(this)) }
  set (k, v) { super.set(k, v); this.keep(); return this }
  delete (k) { const r = super.delete(k); if (r) this.keep(); return r }
  clear () { super.clear(); this.keep() }
}
function persistedMap (name) { return new PersistedMap(name) }
module.exports = { get, set, update, save, flushSync, addUnique, removePos, bump, persistedMap, FILE }
