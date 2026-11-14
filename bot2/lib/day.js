'use strict'
// THE DAY, counted once for everyone - the tidy's and the site teardown's once-a-day gates, a trip put off till tomorrow,
// an expedition's nights, the teardown's rests: a new day is a night seen and then day, or the clock wrapped back (a night
// slept through). Never bot.time.day (it did not count the days the gates saw). Kept in memory: a restart keeps the count
// - only a wrap across the downtime itself is missed, late by one. Read it every tick (the director does) so no edge is
// missed between the readers (audit 2026-09-29: four copies of the rule had grown apart)
const world = require('./world')
const mem = require('./memory')
let lastTod = null
function dayNo (bot) {
  const d = mem.get().dayNo || { n: 0, night: false }
  const t = world.tod(bot); const night = world.isNight(bot)
  // ONE DAWN, TWO EDGES: night ends at 23200 and the clock wraps at 24000 some 40s later - each read as a new day, every
  // dawn counted twice once the day was read each second (audit 2026-10-03). The wrap within minutes of a counted night's
  // end is that same dawn (a whole day is 20 minutes); a wrap with no night seen - the night read by nobody, a bed's jump -
  // is the dawn itself
  const edge = !night && d.night
  const wrap = !night && lastTod != null && t < lastTod && !(d.dawnAt && Date.now() - d.dawnAt < 3 * 60000)
  const next = edge || wrap
  lastTod = t
  if (next || d.night !== night) mem.set('dayNo', { n: d.n + (next ? 1 : 0), night, dawnAt: edge ? Date.now() : (wrap ? null : d.dawnAt || null) })
  return d.n + (next ? 1 : 0)
}
// (read on every time packet, not only between the director's tasks: a bunker begun at dusk held the loop all night, the
//  next read came at 23300 - day, before the wrap - and the wrap fell inside the next long task; the night went uncounted
//  and an expedition stayed out past its last night, 2026-10-03)
function install (bot) { bot.on('time', () => { try { if (bot.entity) dayNo(bot) } catch {} }) }
module.exports = { dayNo, install }
