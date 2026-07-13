'use strict'
// OFFLINE unit test for the pure exploration sweep (bot/explore.js). No bot, no I/O.
// Run:  cd bot && node exploretest.js

const assert = require('assert')
const E = require('./explore.js')
const home = { x: 414, z: 85 }

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }

t('octantSweep: covers all 8 octants at every ring, near-ring first', () => {
  const wps = E.octantSweep(home, { rings: [48, 96] })
  assert.strictEqual(wps.length, 16, '2 rings x 8 octants')
  assert.strictEqual(wps[0].ring, 48, 'near ring first')
  assert(wps.slice(0, 8).every(w => w.ring === 48) && wps.slice(8).every(w => w.ring === 96))
  assert.strictEqual(new Set(wps.map(w => w.key)).size, 16, 'keys are unique')
})

t('octantSweep: the live food (335,47 = ~88 blocks off) IS covered by some sweep waypoint', () => {
  const wps = E.octantSweep(home, { rings: [48, 96, 144] })
  // 335,47 relative to 414,85 is WEST+NORTH (NW). The point: the systematic sweep reaches it
  // - the bot never has to be TOLD, it sweeps every octant outward.
  let best = null; let bd = Infinity
  for (const w of wps) { const d = Math.hypot(w.x - 335, w.z - 47); if (d < bd) { bd = d; best = w } }
  assert(bd < 40, 'a sweep waypoint passes within 40 of the food (nearest was ' + best.name + '-' + best.ring + ' at ' + best.x + ',' + best.z + ', dist ' + Math.round(bd) + ')')
})

t('firstUnswept: steers to UNSEARCHED ground, skips recently-swept sectors', () => {
  const wps = E.octantSweep(home, { rings: [48, 96] })
  // pretend the whole near ring + the NE/SE octants were already swept (the stale bias)
  const searched = new Set(wps.filter(w => w.ring === 48 || w.name === 'NE' || w.name === 'SE').map(w => w.key))
  const next = E.firstUnswept(wps, searched)
  assert(next, 'there is still unsearched ground')
  assert.strictEqual(next.ring, 96, 'moves out to the far ring after the near ring is done')
  assert(!['NE', 'SE'].includes(next.name), 'does NOT re-tread the stale NE/SE - picks a fresh octant (e.g. the SW where food is)')
})

t('firstUnswept: all swept -> null (honest give-up, driver waits)', () => {
  const wps = E.octantSweep(home, { rings: [48] })
  assert.strictEqual(E.firstUnswept(wps, new Set(wps.map(w => w.key))), null)
})

t('sectorKeyAt: a world position maps to its NEAREST sweep sector', () => {
  const wps = E.octantSweep(home, { rings: [48, 96] })
  const k = E.sectorKeyAt(335, 47, home, { rings: [48, 96] })
  let best = null; let bd = Infinity
  for (const w of wps) { const d = Math.hypot(w.x - 335, w.z - 47); if (d < bd) { bd = d; best = w } }
  assert.strictEqual(k, best.key, 'standing at the food credits its nearest sector as searched')
})

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall exploration tests passed')
process.exit(failures ? 1 : 0)
