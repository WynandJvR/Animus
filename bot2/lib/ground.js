'use strict'
// Groundwork: the one way the bot makes an area of ground clean and level. Used before building (the hut,
// the farm) and after it (the castle's surroundings). For every column in the area:
//   - anything standing above ground level that isn't kept (stray blocks, scaffold, pillars, logs, plants)
//     is taken down
//   - a hole at ground level is filled with dirt (and the cell under it if that is open too)
// `keep(block)` protects what belongs there (crops, torches, furniture, the build itself); `skip(x, z)`
// leaves whole columns alone (the castle footprint, the hut).
// Only natural terrain is ever taken (world.NATURAL_RE - the rule act.dig itself holds), never with force: every dig here
// once passed force, which skipped that rule and the zones, and the farm's 9x9 six high took whatever stood in it - a
// smoker, a composter, fences, ladders, signs, glass (audit, 2026-09-27). The scaffold ledger's force arm went too: every
// scaffold and filler block is natural already, so it only ever forced a NON-natural block that had since taken a
// ledger cell - our composter, a player's block (audit #3, 2026-09-27).
// A job act.dig would refuse is no job at all - crafted, in a zone this ground does not own, beside or over lava - nor is
// a fill act.place would refuse (a lava cell): queued, it is refused forever and the plot never reads level (the farm's
// skip judged zones at the water's level only while clearing reached six up, audit R9, 2026-09-27).
// `allowZones` (default base + build): the zones this ground lies in, the only ones its digs may enter.
const world = require('./world')
const inv = require('./inventory')
const act = require('./act')
const move = require('./move')
const reflex = require('./reflex')
const { log } = require('./log')

const FURNITURE = world.FURNITURE_RE // (world.js: the one list)
const DEFAULT_ZONES = ['base'] // (the build's cells only when a caller says so - the site's own finishing; a yard or hut
//  fill defaulting into 'build' could put dirt in a castle cell still waiting for its block; audit 2026-09-28)

// May the groundwork take this block? act.dig's own refusals, asked before a job is queued: natural terrain, outside
// every zone but this ground's own, and holding back no lava.
function takeable (bot, b, zones) { return !act.digRefusal(bot, b, { allowZones: zones }) }

// (`soil`: the ground block itself must be one of these - a farm's cobblestone or stone at the soil level is dug out and
//  dirt goes in its place: nothing tills it)
function work (bot, { x1, z1, x2, z2, groundY, height = 3, keep = () => false, skip = () => false, soil = null, allowZones = DEFAULT_ZONES }) {
  const out = []
  const ok = b => takeable(bot, b, allowZones)
  // (a fill is a place: into a zone this ground does not own, no)
  const mayFill = (x, y, z) => { const zn = move.inZone({ x, y, z }); return !zn || allowZones.includes(zn.label) }
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
    if (skip(x, z)) continue
    for (let y = groundY + height; y >= groundY + 1; y--) {
      const b = world.at(bot, x, y, z)
      if (!b || world.isAirish(b) || world.isLiquidWater(b) || FURNITURE.test(b.name) || keep(b) || !ok(b)) continue
      out.push({ kind: 'clear', x, y, z })
    }
    const g = world.at(bot, x, groundY, z)
    // (a hole with something crafted standing in it - a sign, a torch, a pot - is left as it is: filling it means taking that)
    // (and a lava cell is no fill: act.place refuses a block into lava, so the job stood forever)
    const thing = g && !/^(air|cave_air|void_air)$/.test(g.name)
    if (g && !world.isSolid(g) && !world.isLiquidWater(g) && !world.isLavaBlock(g) && !keep(g)) { if ((!thing || ok(g)) && mayFill(x, groundY, z)) out.push({ kind: 'fill', x, y: groundY, z }) } else if (soil && g && world.isSolid(g) && !soil.test(g.name) && !keep(g) && !FURNITURE.test(g.name) && ok(g)) out.push({ kind: 'soil', x, y: groundY, z })
    // (and water that only flowed there - a cell beside the source with no soil in it spills the source down into
    //  the holes under the plot; a source block is the farm's own water or the water fixer's to judge)
    else if (soil && g && world.isLiquidWater(g) && !keep(g) && mayFill(x, groundY, z) && (() => { try { return Number(g.getProperties().level) !== 0 } catch { return false } })()) out.push({ kind: 'fill', x, y: groundY, z })
  }
  return out
}

async function prepare (bot, area, { shouldStop, label = 'ground' } = {}) {
  const jobs = work(bot, area)
  const zones = area.allowZones || DEFAULT_ZONES
  const dig = (j, timeoutMs) => act.dig(bot, j, { allowZones: zones, timeoutMs })
  if (!jobs.length) return 0
  const fills = jobs.filter(j => j.kind !== 'clear').length
  if (fills && inv.count(bot, 'dirt') < fills + 2) {
    await require('./base').withdraw(bot, 'dirt', fills + 2 - inv.count(bot, 'dirt')).catch(() => 0)
    if (inv.count(bot, 'dirt') < fills) await require('./craft').ensure(bot, 'dirt', fills + 2, { noWithdraw: true, shouldStop }).catch(() => false)
  }
  let done = 0
  // top down: clear first (a crop over a low cell comes off here), then fill
  jobs.sort((a, b) => (a.kind !== 'clear') - (b.kind !== 'clear') || b.y - a.y)
  for (const j of jobs) { const b0 = world.at(bot, j.x, j.y, j.z); j.was = b0 ? b0.name : '?' }
  for (const j of jobs) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    if (j.kind === 'clear') { if (await dig(j, 8000)) done++; continue }
    const cur = world.at(bot, j.x, j.y, j.z)
    if (j.kind === 'soil' && cur && world.isSolid(cur) && !await dig(j, 8000)) continue
    if (cur && !world.isAirish(cur) && !world.isSolid(cur) && !world.isLiquidWater(cur)) await dig(j, 4000)
    const filler = () => inv.items(bot).find(i => /^(dirt|coarse_dirt)$/.test(i.name))
    const under = world.at(bot, j.x, j.y - 1, j.z)
    if (under && !world.isSolid(under) && filler()) await act.place(bot, { x: j.x, y: j.y - 1, z: j.z }, filler().name, { allowZones: zones, sneak: false })
    if (filler() && await act.place(bot, j, filler().name, { allowZones: zones, sneak: false })) done++
  }
  await act.collectDrops(bot, { radius: 8, maxMs: 5000 })
  // (none done says why too: a yard 'levelled' four times over in a millisecond each, saying nothing, 2026-09-28)
  log('ground', `${label}: ${done} of ${jobs.length} fixes done (${jobs.slice(0, 8).map(j => `${j.kind} ${j.x},${j.y},${j.z}${j.was ? ' ' + j.was : ''}${!done ? ' zone ' + ((move.inZone(j) || {}).label || '-') : ''}`).join('; ')})${!done ? ' - zones allowed: ' + zones.join(',') + ', dirt ' + inv.count(bot, 'dirt') : ''}`)
  return done
}

module.exports = { work, prepare, FURNITURE }
