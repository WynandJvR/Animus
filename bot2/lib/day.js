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
  const next = !night && (d.night || (lastTod != null && t < lastTod))
  lastTod = t
  if (next || d.night !== night) mem.set('dayNo', { n: d.n + (next ? 1 : 0), night })
  return d.n + (next ? 1 : 0)
}
module.exports = { dayNo }
