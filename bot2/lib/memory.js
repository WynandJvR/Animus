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

function save () {
  try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(mem, null, 1)); fs.renameSync(FILE + '.tmp', FILE) } catch {}
}

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

module.exports = { get, set, update, save, addUnique, removePos, bump, FILE }
