'use strict'
// WATER-WEDGE ESCAPE - PURE geometry core for the `wetbreach` recovery rung.
//
// The bot can get physically boxed in a 1-block water pocket under a solid ceiling (a
// waterlogged tree the gather walked it into): swim/hop both fail, every other recovery
// rung has an unsatisfiable precondition, and it freezes forever. This module plans the
// missing move - a BOUNDED dig to the nearest air/bank, horizontal-first (dig sideways one
// block and walk out) with a vertical overhead fallback - never re-opening water.
//
// PURE like route-mem.js / mining.js: no bot, no fs, no pathfinder. All world reads come in
// through `read(dx,dy,dz)` (block-name string or null=unloaded, relative to the bot's FEET
// cell); ALL anti-grief comes in through the injected `diggable` predicate. This module only
// does the geometry. The executor (breachWaterPocket) lives in provision.js.
//
// Offline tests: bot/pocketescapetest.js.

// A cell is OPEN if it is air; a FLUID if water/lava. null = unloaded = unknown = unsafe.
const AIRISH_RE = /^(air|cave_air|void_air)$/
function isFluid (name) { return name != null && /water|lava/.test(name) }
function isWater (name) { return name != null && /water/.test(name) }
// A KNOWN, non-air, non-fluid block - treated as solid for dig/floor purposes here (the
// injected diggable predicate + the executor's re-read do the real anti-grief/standability).
function isSolid (name) { return name != null && !AIRISH_RE.test(name) && !isFluid(name) }

// Surface line of the pocket at the feet column: the highest dy that is water (feet=dy0 is
// water by the caller's guard). A dig cell whose block ABOVE is water is only a hazard when
// that dig sits ABOVE this line - at/below it the cell is already wet, so opening it pours
// no NEW water onto the head.
function waterSurfaceDy (read) {
  let s = -1
  for (let dy = 0; dy <= 6; dy++) { const n = read(0, dy, 0); if (isWater(n)) s = dy; else break }
  return s
}
function aboveIsWaterHazard (read, dig, surfaceDy) {
  const above = read(dig.dx, dig.dy + 1, dig.dz)
  return isWater(above) && dig.dy > surfaceDy
}

// ---- horizontal breach (preferred): dig a 2-high corridor to a standable bank ----------
// For a single (direction, exit-height dy) march r=1..march. The corridor at each column is
// 2 cells high (dy body, dy+1 head). A body/head that is fluid OR unknown rejects the whole
// direction (this is what stops the rung ever connecting the pocket to a lake or lava - it
// only ever digs toward known solid/air). A column is an EXIT when its body+head can be made
// clear (already open, or a diggable solid) AND the floor beneath (dy-1) is a solid non-fluid
// block to stand on; the march stops at the first exit (fewest digs along that ray). A plan
// is rejected if total digs exceed maxDigs or any dig would drop water from above the line.
function tryDir (read, diggable, dir, dy, march, maxDigs, surfaceDy) {
  const digs = []
  for (let r = 1; r <= march; r++) {
    const bx = dir.dx * r; const bz = dir.dz * r
    const body = read(bx, dy, bz)
    const head = read(bx, dy + 1, bz)
    if (body == null || head == null) return null       // unknown anywhere in the corridor -> reject
    if (isFluid(body) || isFluid(head)) return null      // fluid anywhere in the corridor -> reject
    // body+head must be clear-able: already open, or a diggable solid (collected as digs)
    const colDigs = []
    for (const [nm, cy] of [[body, dy], [head, dy + 1]]) {
      if (AIRISH_RE.test(nm)) continue
      if (!diggable(nm, bx, cy, bz)) return null          // a non-diggable solid (player build) -> reject
      colDigs.push({ dx: bx, dy: cy, dz: bz })
    }
    // exit here? need a solid non-fluid floor to stand on
    const floor = read(bx, dy - 1, bz)
    if (isSolid(floor)) {
      const total = digs.concat(colDigs)
      if (total.length > maxDigs) return null
      for (const d of total) if (aboveIsWaterHazard(read, d, surfaceDy)) return null
      return { kind: 'horizontal', digs: total, exit: { dx: bx, dy, dz: bz } }
    }
    // no floor to stand on here (void/water/unknown below) -> keep marching
    digs.push(...colDigs)
    if (digs.length > maxDigs) return null
  }
  return null // no standable exit within march along this ray
}

function planHorizontal (read, diggable, march, maxDigs, surfaceDy) {
  const dirs = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }]
  const plans = []
  for (const dy of [0, 1]) {          // same level or one step UP - never down into the unknown
    for (const dir of dirs) {
      const plan = tryDir(read, diggable, dir, dy, march, maxDigs, surfaceDy)
      if (plan) plans.push(plan)
    }
  }
  if (!plans.length) return null
  plans.sort((a, b) => (a.digs.length - b.digs.length) || (a.exit.dy - b.exit.dy)) // fewest digs, tie: lower exit
  return plans[0]
}

// ---- vertical fallback: breach the ceiling straight up to the first air cell ------------
// Scan the column above the head (dy2..dy5), PAST the pocket's own water, to the first SOLID
// block S. Plan only if S is diggable, at most one more solid sits directly above it (cap 2
// digs), and the cell above the topmost dug block is a KNOWN air cell - i.e. the "never dig
// up into water" aquifer rule is preserved verbatim (fluid/unknown above -> null), it just
// looks one cell past the pocket's own water instead of refusing on it.
function planVertical (read, diggable) {
  let dyS = null
  for (let dy = 2; dy <= 5; dy++) {
    const n = read(0, dy, 0)
    if (n == null) return null              // unknown overhead -> unsafe
    if (isWater(n)) continue                // pocket water - pass through
    if (AIRISH_RE.test(n)) return null      // open air above the head - not a ceiling breach (swim/jumpForAir owns it)
    dyS = dy; break                         // first solid
  }
  if (dyS == null) return null
  const sName = read(0, dyS, 0)
  if (!diggable(sName, 0, dyS, 0)) return null
  const digs = [{ dx: 0, dy: dyS, dz: 0 }]
  let topDug = dyS
  const above = read(0, dyS + 1, 0)
  if (above == null || isFluid(above)) return null   // aquifer rule: never dig up into water/lava (or the unknown)
  if (!AIRISH_RE.test(above)) {
    // one more solid directly above S - allowed (cap 2 digs) only if it's diggable AND air is above THAT
    if (!diggable(above, 0, dyS + 1, 0)) return null
    const above2 = read(0, dyS + 2, 0)
    if (above2 == null || isFluid(above2) || !AIRISH_RE.test(above2)) return null
    digs.push({ dx: 0, dy: dyS + 1, dz: 0 }); topDug = dyS + 1
  }
  return { kind: 'vertical', digs, exit: { dx: 0, dy: topDug + 1, dz: 0 } }
}

// planPocketBreach(read, diggable, opts) -> { kind, digs:[{dx,dy,dz}...], exit:{dx,dy,dz} } | null
// Horizontal-first (the missing "dig sideways and walk out" rung); vertical overhead fallback.
function planPocketBreach (read, diggable, opts = {}) {
  const march = opts.march || 3
  const maxDigs = opts.maxDigs || 6
  const surfaceDy = waterSurfaceDy(read)
  const h = planHorizontal(read, diggable, march, maxDigs, surfaceDy)
  if (h) return h
  return planVertical(read, diggable)
}

module.exports = { planPocketBreach, planHorizontal, planVertical, AIRISH_RE, isFluid, isWater, isSolid, waterSurfaceDy }
