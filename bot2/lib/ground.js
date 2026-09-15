'use strict'
// Groundwork: the one way the bot makes an area of ground clean and level. Used before building (the hut,
// the farm) and after it (the castle's surroundings). For every column in the area:
//   - anything standing above ground level that isn't kept (stray blocks, scaffold, pillars, logs, plants)
//     is taken down
//   - a hole at ground level is filled with dirt (and the cell under it if that is open too)
// `keep(block)` protects what belongs there (crops, torches, furniture, the build itself); `skip(x, z)`
// leaves whole columns alone (the castle footprint, the hut).
const world = require('./world')
const inv = require('./inventory')
const act = require('./act')
const reflex = require('./reflex')
const { log } = require('./log')

const FURNITURE = /(chest|furnace|crafting_table|_door|_bed|barrel|torch|lantern)$/

function work (bot, { x1, z1, x2, z2, groundY, height = 3, keep = () => false, skip = () => false }) {
  const out = []
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
    if (skip(x, z)) continue
    for (let y = groundY + height; y >= groundY + 1; y--) {
      const b = world.at(bot, x, y, z)
      if (!b || world.isAirish(b) || world.isWaterBlock(b) || FURNITURE.test(b.name) || keep(b)) continue
      out.push({ kind: 'clear', x, y, z })
    }
    const g = world.at(bot, x, groundY, z)
    if (g && !world.isSolid(g) && !world.isWaterBlock(g) && !keep(g)) out.push({ kind: 'fill', x, y: groundY, z })
  }
  return out
}

async function prepare (bot, area, { shouldStop, label = 'ground' } = {}) {
  const jobs = work(bot, area)
  if (!jobs.length) return 0
  const fills = jobs.filter(j => j.kind === 'fill').length
  if (fills && inv.count(bot, 'dirt') < fills + 2) {
    await require('./base').withdraw(bot, 'dirt', fills + 2 - inv.count(bot, 'dirt')).catch(() => 0)
    if (inv.count(bot, 'dirt') < fills) await require('./craft').ensure(bot, 'dirt', fills + 2, { noWithdraw: true, shouldStop }).catch(() => false)
  }
  let done = 0
  // top down: clear first (a crop over a low cell comes off here), then fill
  jobs.sort((a, b) => (a.kind === 'fill') - (b.kind === 'fill') || b.y - a.y)
  for (const j of jobs) {
    if (shouldStop && shouldStop()) break
    await reflex.waitClear()
    if (j.kind === 'clear') { if (await act.dig(bot, j, { force: true, allowZones: ['base', 'build'], timeoutMs: 8000 })) done++; continue }
    const cur = world.at(bot, j.x, j.y, j.z)
    if (cur && !world.isAirish(cur) && !world.isSolid(cur)) await act.dig(bot, j, { force: true, allowZones: ['base', 'build'], timeoutMs: 4000 })
    const filler = () => inv.items(bot).find(i => /^(dirt|coarse_dirt)$/.test(i.name))
    const under = world.at(bot, j.x, j.y - 1, j.z)
    if (under && !world.isSolid(under) && filler()) await act.place(bot, { x: j.x, y: j.y - 1, z: j.z }, filler().name, { allowZones: ['base', 'build'], sneak: false })
    if (filler() && await act.place(bot, j, filler().name, { allowZones: ['base', 'build'], sneak: false })) done++
  }
  await act.collectDrops(bot, { radius: 8, maxMs: 5000 })
  if (done) log('ground', `${label}: ${done} of ${jobs.length} fixes done`)
  return done
}

module.exports = { work, prepare, FURNITURE }
