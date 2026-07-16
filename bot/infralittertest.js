'use strict'
// OFFLINE unit test for fix #13 (infra litter consolidation). No bot, no live world.
//  - provision.lonelyFurnace: the PURE structure scan that gates legacy/untagged field
//    furnaces (bare/own-table/torch => reclaimable; anything player-built within 5 => never).
//  - scaffold.js retention env (INFRA_CONSOLIDATE on => 72h / off => 6h) + sweep() size-cap
//    eviction (oldest-first down to 512, flag-on only; flag-off = unbounded like fd90c9f).
// Run:  cd bot && node infralittertest.js

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')

// isolate all persisted state so this never touches live world/scaffold memory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infralitter-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

// ---- lonelyFurnace (pure) -------------------------------------------------------------
const provision = require('./provision.js')

// fake world reader: blocks is a map "x,y,z" -> block name.
function reader (blocks) {
  return (x, y, z) => { const n = blocks[x + ',' + y + ',' + z]; return n ? { name: n, position: { x, y, z } } : null }
}
const cell = { x: 100, y: 64, z: 200 }
const fKey = '100,64,200'

t('lonelyFurnace: a bare furnace (nothing around) => true', () => {
  assert.strictEqual(provision.lonelyFurnace(reader({ [fKey]: 'furnace' }), cell, new Set()), true)
})

t('lonelyFurnace: furnace + own-remembered table nearby => true', () => {
  const tableKey = '101,64,200'
  const b = reader({ [fKey]: 'furnace', [tableKey]: 'crafting_table' })
  assert.strictEqual(provision.lonelyFurnace(b, cell, new Set([tableKey])), true, 'own table is exempt')
})

t('lonelyFurnace: furnace + a torch nearby => true', () => {
  const b = reader({ [fKey]: 'furnace', '100,65,200': 'wall_torch' })
  assert.strictEqual(provision.lonelyFurnace(b, cell, new Set()), true, 'a torch alone is not a base')
})

t('lonelyFurnace: furnace + UN-remembered planks/chest/door/cobble => false', () => {
  for (const name of ['oak_planks', 'chest', 'oak_door', 'cobblestone']) {
    const b = reader({ [fKey]: 'furnace', '102,64,201': name })
    assert.strictEqual(provision.lonelyFurnace(b, cell, new Set()), false, name + ' nearby => not lonely')
  }
})

t('lonelyFurnace: an UN-remembered table (someone else\'s) => false', () => {
  const b = reader({ [fKey]: 'furnace', '101,64,200': 'crafting_table' })
  assert.strictEqual(provision.lonelyFurnace(b, cell, new Set()), false, 'a table NOT in own memory disqualifies')
})

t('lonelyFurnace: a build block OUTSIDE radius 5 is ignored => true', () => {
  const b = reader({ [fKey]: 'furnace', '107,64,200': 'oak_planks' }) // 7 blocks away
  assert.strictEqual(provision.lonelyFurnace(b, cell, new Set()), true, 'radius-5 scan does not reach 7b')
})

t('lonelyFurnace: a torch AND own-table both exempt, still true', () => {
  const b = reader({ [fKey]: 'furnace', '99,64,200': 'torch', '101,64,200': 'crafting_table' })
  assert.strictEqual(provision.lonelyFurnace(b, cell, new Set(['101,64,200'])), true)
})

// ---- scaffold.js retention + size-cap eviction ----------------------------------------
function freshScaffold (flagOff, seed) {
  if (flagOff) process.env.INFRA_CONSOLIDATE = '0'; else delete process.env.INFRA_CONSOLIDATE
  const file = path.join(tmp, 'scaf-' + Math.random().toString(36).slice(2) + '.json')
  if (seed) fs.writeFileSync(file, JSON.stringify(seed))
  process.env.SCAFFOLD_FILE = file
  delete require.cache[require.resolve('./scaffold.js')]
  return require('./scaffold.js')
}

const tenHoursAgo = Date.now() - 10 * 3600 * 1000

t('scaffold retention: flag ON keeps a 10h-old entry (72h window)', () => {
  const s = freshScaffold(false, { '1,64,1': { t: tenHoursAgo, purpose: 'move' } })
  assert.strictEqual(s.count(), 1, 'flag on: 10h-old entry survives (72h retention)')
})

t('scaffold retention: flag OFF drops a 10h-old entry (6h window, byte-equivalent)', () => {
  const s = freshScaffold(true, { '1,64,1': { t: tenHoursAgo, purpose: 'move' } })
  assert.strictEqual(s.count(), 0, 'flag off: 10h-old entry dropped at load (6h retention)')
})

function seed600 () {
  const base = Date.now() - 60000 // all fresh (well within either window)
  const seed = {}
  for (let i = 0; i < 600; i++) seed['0,' + i + ',0'] = { t: base + i, purpose: 'move' }
  return seed
}

t('scaffold sweep: flag ON caps the registry at 512, evicting oldest-first', () => {
  const s = freshScaffold(false, seed600())
  assert.strictEqual(s.count(), 600, 'all 600 loaded (all fresh)')
  s.add({ x: 9, y: 9, z: 9 }, 'move') // 601 -> reg.size>512 -> sweep -> size eviction
  assert.ok(s.count() <= 512, 'capped to <=512, got ' + s.count())
  assert.strictEqual(s.isScaffold({ x: 0, y: 0, z: 0 }), false, 'the oldest entry (t=base) was evicted')
  assert.strictEqual(s.isScaffold({ x: 0, y: 599, z: 0 }), true, 'a newest entry survives')
  assert.strictEqual(s.isScaffold({ x: 9, y: 9, z: 9 }), true, 'the just-added entry survives')
})

t('scaffold sweep: flag OFF does NOT size-evict (unbounded, byte-equivalent to fd90c9f)', () => {
  const s = freshScaffold(true, seed600())
  s.add({ x: 9, y: 9, z: 9 }, 'move')
  assert.strictEqual(s.count(), 601, 'flag off: no size eviction (601 kept)')
})

console.log(failures ? ('\n' + failures + ' FAILED') : '\nALL PASS')
process.exit(failures ? 1 : 0)
