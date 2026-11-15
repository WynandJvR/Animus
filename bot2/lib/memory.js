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

// ONLY A FILE THAT IS NOT THERE IS A FRESH START. Every failure used to be one: a file cut short by a crash or a power
// loss (the write is a tmp file renamed over it, never synced), a read refused while another program held it - memory began
// again from nothing, and the first save a second later wrote that nothing over the file: home, the chests, the build, the
// graves, and the records of whose blocks are whose (the anti-grief guard's). Now: the file; failing that, the newest of
// the write's own tmp copies that reads whole; failing that, the bad file is kept beside it (memory.json.corrupt-<time>)
// before anything is written over it, and said.
function load () {
  if (mem) return mem
  const read = f => Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(f, 'utf8')))
  const say = m => { try { require('./log').log('memory', m) } catch {} }
  // (a read REFUSED - another program holding the file open, Windows - is asked again, a second in all: it is not a bad file)
  let e = null
  for (let i = 0; i < 5; i++) {
    try { mem = read(FILE); return mem } catch (err) { e = err }
    if (e.code === 'ENOENT' || e instanceof SyntaxError) break
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250) } catch {}
  }
  // (no file: a fresh start, as ever - a deleted memory.json is the operator's way to one, and no tmp copy brings it back)
  if (e.code === 'ENOENT') { mem = JSON.parse(JSON.stringify(DEFAULTS)); return mem }
  // (REFUSED to the end - the file is there and may be whole, only not ours to read just now: no empty memory is begun on
  //  it - its first save would go over the good file the moment the hold lifts. Out, said; the supervisor starts us again
  //  and the read is asked again then; audit)
  if (!(e instanceof SyntaxError)) {
    say(`memory.json could not be read (${e.code || ''} ${e.message}) - not starting on an empty memory; exiting for the supervisor to try again`)
    try { console.error(`[memory] memory.json could not be read (${e.message}) - exiting`) } catch {}
    process.exit(1)
  }
  // (a copy as new as the file itself, to the minute - one left behind by a rename that failed weeks ago is another time's memory)
  const since = (() => { try { return fs.statSync(FILE).mtimeMs - 60000 } catch { return Infinity } })()
  const spare = [FILE + '.tmp', FILE + '.exit.tmp']
    .map(f => { try { return { f, t: fs.statSync(f).mtimeMs, m: read(f) } } catch { return null } })
    .filter(s => s && s.t >= since).sort((a, b) => b.t - a.t)[0]
  if (spare) {
    mem = spare.m
    say(`memory.json would not read (${e.message}) - memory taken from ${path.basename(spare.f)} (written ${new Date(spare.t).toISOString()})`)
  } else {
    mem = JSON.parse(JSON.stringify(DEFAULTS))
    say(`memory.json would not read (${e.message}) and no spare copy reads either - starting with an empty memory`)
  }
  try { const keep = `${FILE}.corrupt-${Date.now()}`; fs.copyFileSync(FILE, keep); say(`the unreadable memory.json kept as ${path.basename(keep)}`) } catch {}
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
