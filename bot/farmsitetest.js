'use strict'
// OFFLINE unit test for #118 FARM_SITED_FROM_HOME (Root F, DESIGN-grounded-truth-and-home-first
// §3.6). Reproduces the live defect the operator watched: the bot walked 140 blocks SOUTH, past a
// pond 50 blocks from its hut, to inspect a remembered "pond" that was cave water at y48 - a fact
// its own stored record already contained.
//
// Three stacked causes, all covered here:
//   1. the farm site was recalled from bot.entity.position, not HOME  -> siting drifted with the body
//   2. a 300-block recall radius                                      -> far junk beat near quality
//   3. a first-truthy ladder, not a comparison                        -> one record suppressed discovery
//
// Covers: farm.rankFarmSites / farm.farmSiteQualified (pure), provision-farm.chooseFarmSite +
// surveyWaterSite (stub bot, no live world), food.foodSupplyAction, and SOURCE PINS that the
// deleted ladder and the deleted bot-anchored 300b recall have not crept back.
// Run:  cd bot && node farmsitetest.js

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')

// isolate persisted state - this must never touch live world memory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farmsite-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

const farm = require('./farm.js')
const foodSec = require('./food.js')
const provFarm = require('./provision-farm.js')
const worldMemory = require('./world-memory.js')

// score knobs pinned in the PURE tests so the suite is ambient-proof (no env dependence).
const OPTS = { target: 33, distWeight: 0.75, minTillable: 6, minFlatFrac: 0.6 }
const HOME = { x: 0, y: 64, z: 0 }

// ---- 1. THE LIVE CASE: near beats far, on lifetime tend-cost --------------------------------
t('rankFarmSites: a decent pond 50b from home BEATS a better pond 140b away (the live trek)', () => {
  const near = { x: 0, y: 63, z: 50, openSky: true, tillable: 12, flat: 1, source: 'discovered' }
  const far = { x: 0, y: 63, z: 140, openSky: true, tillable: 33, flat: 1, source: 'memory' }
  const best = farm.rankFarmSites([far, near], Object.assign({ home: HOME }, OPTS))
  assert.ok(best, 'a site was chosen')
  assert.strictEqual(best.z, 50, 'the NEAR pond wins - a farm is tended for a lifetime, not visited once')
  // and the order of the array must not decide it
  assert.strictEqual(farm.rankFarmSites([near, far], Object.assign({ home: HOME }, OPTS)).z, 50)
})

t('rankFarmSites: far only wins when it is better by MORE than the tend-distance it costs', () => {
  const near = { x: 0, y: 63, z: 50, openSky: true, tillable: 6, flat: 0.6 }
  const far = { x: 0, y: 63, z: 52, openSky: true, tillable: 33, flat: 1 }
  const best = farm.rankFarmSites([near, far], Object.assign({ home: HOME }, OPTS))
  assert.strictEqual(best.z, 52, 'a hugely better site 2b farther still wins - this is a comparison, not a near-only rule')
})

// ---- 2. QUALIFIED AT WRITE TIME: the cave-water record can never be picked -------------------
t('rankFarmSites: the cave-water record at y48 is NEVER a candidate (openSky false)', () => {
  const cave = { x: 0, y: 48, z: 140, openSky: false, tillable: 40, flat: 1, source: 'memory' }
  assert.strictEqual(farm.farmSiteQualified(cave), false, 'covered water does not qualify')
  assert.strictEqual(farm.rankFarmSites([cave], Object.assign({ home: HOME }, OPTS)), null,
    'no amount of tillable bank makes cave water a farm site')
})

t('rankFarmSites: an UNSURVEYED record is unverified, not good - and cannot veto a verified rival', () => {
  const unsurveyed = { x: 0, y: 63, z: 20, source: 'memory' } // bare x/y/z: the pre-#118 record shape
  const good = { x: 0, y: 63, z: 90, openSky: true, tillable: 20, flat: 1, source: 'discovered' }
  assert.strictEqual(farm.farmSiteQualified(unsurveyed), false)
  const best = farm.rankFarmSites([unsurveyed, good], Object.assign({ home: HOME }, OPTS))
  assert.ok(best && best.z === 90, 'the nearer UNVERIFIED record neither wins nor suppresses the verified one')
})

t('rankFarmSites: openSky unknown (null - an unloaded column) is unverified, never "good"', () => {
  const unknown = { x: 0, y: 63, z: 10, openSky: null, tillable: 30, flat: 1 }
  assert.strictEqual(farm.rankFarmSites([unknown], Object.assign({ home: HOME }, OPTS)), null)
})

// ---- 3. HOME OR NOTHING ---------------------------------------------------------------------
t('rankFarmSites: no home anchor => no site (permanent infra is sited from home or not at all)', () => {
  const good = { x: 0, y: 63, z: 20, openSky: true, tillable: 30, flat: 1 }
  assert.strictEqual(farm.rankFarmSites([good], Object.assign({ home: null }, OPTS)), null)
})

// ---- 4. foodSupplyAction: the ladder's INPUT is a chosen site, not a bare memory hit ---------
t('foodSupplyAction: a chosen site builds; NO chosen site falls through to hunt/sweep', () => {
  assert.strictEqual(foodSec.foodSupplyAction(true, true, true), 'tend')
  assert.strictEqual(foodSec.foodSupplyAction(false, true, true), 'buildFarm')
  assert.strictEqual(foodSec.foodSupplyAction(false, false, true), 'huntNear',
    'nothing near home qualified -> hunt, instead of trekking to junk memory')
  assert.strictEqual(foodSec.foodSupplyAction(false, false, false), 'sweep',
    'sweep now means "nothing near home qualified", not "we happen to remember nothing"')
})

// ---- 5. chooseFarmSite over a stub world ----------------------------------------------------
// A tiny fake world: everything not in `blocks` reads as KNOWN AIR (so sky columns are open).
function stubBot (blocks, discovered, botPos) {
  const { Vec3 } = require('vec3')
  const key = (x, y, z) => Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z)
  return {
    version: '1.21.1',
    entity: { position: new Vec3(botPos.x, botPos.y, botPos.z) },
    blockAt (p) {
      const n = blocks[key(p.x, p.y, p.z)] || 'air'
      return { name: n, boundingBox: (n === 'air' || n === 'water') ? 'empty' : 'block', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    },
    findBlocks () { return discovered.map(d => new Vec3(d.x, d.y, d.z)) }
  }
}
// a farmable pond column at (px,63,pz): water + two rings of grass bank with air above.
function pond (blocks, px, pz) {
  blocks[px + ',63,' + pz] = 'water'
  for (let r = 1; r <= 2; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        blocks[(px + dx) + ',63,' + (pz + dz)] = 'grass_block'
      }
    }
  }
  return blocks
}
// world memory is CACHED in-process, so deleting the file would not clear it - forget the
// records through the module's own API (a stale record leaking between cases would silently
// invalidate exactly the "only one record exists" assertions below).
function resetMem () { for (const e of worldMemory.listInfra('water').slice()) worldMemory.forgetInfra('water', e) }

t('surveyWaterSite: qualifies open-sky + counts the bank it will actually plant into', () => {
  resetMem()
  const bot = stubBot(pond({}, 50, 0), [], { x: 0, y: 64, z: 0 })
  const sv = provFarm.surveyWaterSite(bot, { x: 50, y: 63, z: 0 })
  assert.strictEqual(sv.openSky, true)
  assert.strictEqual(sv.tillable, 24, 'ring 1 (8) + ring 2 (16) grass cells')
  assert.strictEqual(sv.flat, 1)
})

t('surveyWaterSite: a roofed column is DISQUALIFIED at write time (the y48 cave record)', () => {
  resetMem()
  const blocks = pond({}, 50, 0)
  blocks['50,70,0'] = 'stone' // a ceiling: this is cave water
  const bot = stubBot(blocks, [], { x: 0, y: 64, z: 0 })
  const sv = provFarm.surveyWaterSite(bot, { x: 50, y: 63, z: 0 })
  assert.strictEqual(sv.openSky, false, 'covered water is recorded as covered, where it was observed')
})

t('chooseFarmSite: DISCOVERY competes with memory instead of being suppressed by it', () => {
  resetMem()
  // memory holds the live case: a remembered pond 140b south, already surveyed and decent.
  worldMemory.rememberInfra('water', { x: 0, y: 63, z: 140 }, { openSky: true, tillable: 33, flat: 1, surveyedAt: Date.now() })
  // the world holds a good pond 50b from home that nothing had ever recorded.
  const bot = stubBot(pond({}, 50, 0), [{ x: 50, y: 63, z: 0 }], { x: 0, y: 64, z: 0 })
  const site = provFarm.chooseFarmSite(bot, { home: HOME })
  assert.ok(site, 'a site was chosen')
  assert.strictEqual(site.x, 50, 'the freshly DISCOVERED near pond wins over the remembered far one')
  assert.strictEqual(site.source, 'discovered')
  // and the discovery was qualified AT WRITE TIME, so the next pass compares it without walking
  const rec = worldMemory.listInfra('water').find(e => e.x === 50 && e.z === 0)
  assert.ok(rec && rec.openSky === true && rec.tillable === 24, 'the discovered pond was stored WITH its qualifying properties')
})

t('chooseFarmSite: the cave-water record is never chosen even when it is the ONLY record', () => {
  resetMem()
  worldMemory.rememberInfra('water', { x: 0, y: 48, z: 60 }, { openSky: false, tillable: 40, flat: 1, surveyedAt: Date.now() })
  const bot = stubBot({}, [], { x: 0, y: 64, z: 0 })
  assert.strictEqual(provFarm.chooseFarmSite(bot, { home: HOME }), null,
    'null => the caller sweeps/hunts - the discovery the old ladder suppressed')
})

t('chooseFarmSite: SITED FROM HOME - the same world yields the same site wherever the body stands', () => {
  resetMem()
  worldMemory.rememberInfra('water', { x: 0, y: 63, z: 100 }, { openSky: true, tillable: 33, flat: 1, surveyedAt: Date.now() })
  const world = pond({}, 50, 0)
  const atHome = provFarm.chooseFarmSite(stubBot(world, [{ x: 50, y: 63, z: 0 }], { x: 0, y: 64, z: 0 }), { home: HOME })
  resetMem()
  worldMemory.rememberInfra('water', { x: 0, y: 63, z: 100 }, { openSky: true, tillable: 33, flat: 1, surveyedAt: Date.now() })
  // the body has drifted 300 blocks away, right next to the FAR record - the old recall would
  // have picked it purely for being close to the feet.
  const adrift = provFarm.chooseFarmSite(stubBot(world, [{ x: 50, y: 63, z: 0 }], { x: 0, y: 64, z: 300 }), { home: HOME })
  assert.ok(atHome && adrift, 'both passes chose a site')
  assert.deepStrictEqual([adrift.x, adrift.z], [atHome.x, atHome.z], 'the body is not an input to siting')
  assert.strictEqual(atHome.x, 50)
})

t('chooseFarmSite: no home anchor => null (home comes first; a farm is not sited from the feet)', () => {
  resetMem()
  worldMemory.rememberInfra('water', { x: 0, y: 63, z: 20 }, { openSky: true, tillable: 33, flat: 1, surveyedAt: Date.now() })
  const bot = stubBot({}, [], { x: 0, y: 64, z: 0 })
  assert.strictEqual(provFarm.chooseFarmSite(bot, { home: null }), null)
})

// ---- 6. SOURCE PINS - the deleted shapes must not creep back --------------------------------
// #115b: pins that grep RAW source read their own tombstone comments and pass forever. Strip
// comments first. The repo checks out CRLF, and a naive stripper is a silent no-op on CRLF
// (trailing \r; JS `.` does not match \r) - so normalise, then SELF-TEST on both line endings.
function stripComments (raw) {
  return raw.replace(/\r\n/g, '\n').split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}
t('stripComments SELF-TEST: actually strips on LF *and* CRLF (the #115b / CRLF trap)', () => {
  assert.strictEqual(stripComments('code() // TOMBSTONE\nmore()\n').includes('TOMBSTONE'), false, 'LF')
  assert.strictEqual(stripComments('code() // TOMBSTONE\r\nmore()\r\n').includes('TOMBSTONE'), false, 'CRLF')
  assert.strictEqual(stripComments('/* TOMBSTONE */ code()').includes('TOMBSTONE'), false, 'block comment')
  assert.ok(stripComments('const u = "http://x" // c\r\n').includes('http://x'), 'a :// URL survives')
  assert.ok(stripComments('keep(1) // c\r\n').includes('keep(1)'), 'code before the comment survives')
})

const CODE = f => stripComments(fs.readFileSync(path.join(__dirname, f), 'utf8'))

t('PIN: the bot-anchored 300b farm-site recall is GONE from provision-food.js', () => {
  const src = CODE('provision-food.js')
  assert.ok(!/recallInfra\s*\(\s*['"]water['"]\s*,\s*bot\.entity\.position\s*,\s*300\s*\)/.test(src),
    'the 300b recall anchored on the body is back')
  assert.ok(/provFarm\.chooseFarmSite\s*\(\s*bot\s*,/.test(src), 'ensureFoodSupply sites through chooseFarmSite')
  assert.ok(/homeAnchor/.test(src), 'the site anchor is a home anchor, not the body')
})

t('PIN: the arrival-time forget-and-continue purge and its patch scar are GONE', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'provision-food.js'), 'utf8')
  assert.ok(!/pre-seesSky/.test(raw), 'the "older pre-seesSky memory" patch-scar comment is back')
  const src = CODE('provision-food.js')
  assert.ok(!/forgetInfra\s*\(\s*['"]water['"]/.test(src),
    'a remembered pond is CORRECTED at arrival now, never blind-erased')
})

t('PIN: foodSupplyAction no longer takes a bare memory hit (hasKnownWater is gone)', () => {
  const src = CODE('food.js')
  const m = /function foodSupplyAction \(([^)]*)\)/.exec(src)
  assert.ok(m, 'foodSupplyAction still exists')
  assert.strictEqual(m[1].replace(/\s+/g, ' ').trim(), 'hasFarm, hasChosenSite, hasNearAnimal',
    'the middle input is the verdict of a comparison, not "we remember some water"')
  const body = src.slice(m.index, src.indexOf('\n}', m.index))
  assert.ok(!/hasKnownWater/.test(body), 'the first-truthy known-water short-circuit is back')
})

t('PIN: the water write sites that can PROVE open-sky qualify their records', () => {
  const pf = CODE('provision-farm.js')
  assert.ok(/rememberInfra\('water',[^)]*\}\s*,\s*surveyWaterSite\(bot, w\)\)/.test(pf) ||
            /surveyWaterSite\(bot, w\)/.test(pf), 'the farm-establish write is qualified')
  assert.ok(/openSky: true/.test(pf), 'the surveyed-site write records open-sky')
  assert.ok(/surveyWaterSite\(bot, feet\.position\)/.test(CODE('provision.js')),
    'noteWaterCrossing - the feet-anywhere writer that fed cave water into siting - is qualified')
})

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall farm-site tests passed')
process.exit(failures ? 1 : 0)
