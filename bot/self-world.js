'use strict'
// ONE SELF/WORLD TRUTH: the single answer to "is this cell MINE, and am I at home?"
//
// ==== WHY THIS MODULE EXISTS (structural review 2026-08-25, D5 / §3.4) ==================
// The bot had THREE partial, mutually-contradicting answers to "where am I and what did I
// build", and nothing required them to agree:
//
//   1. pathfix.surfaceYAt walked a column downward and called the FIRST solid block "the
//      surface". It skipped registered scaffold (AUDIT 2026-07-29 FIX 8) and NOTHING else -
//      so the bot's own roof, its own walls and its own floor slab all read as TERRAIN.
//   2. provision-hut.hasSolidCeiling refused the hut INTERIOR (insideOwnStructure) and
//      nothing else - so a bot in the crawlspace under its own floor, or on its own
//      doorstep under its own eaves, read as "buried underground".
//   3. provision-core.digBlocked (correct, and untouched by this module) refused to cut
//      own-infra at all.
//
// Compose those and you get the terminal loop of 2026-08-03: at (190,69,-100), two blocks
// from its own bed, the bot was told it was "stuck UNDERGROUND", aimed at a "surface" that
// was its own roof slab, tried to cut its way there, and was correctly refused - 243 times
// (`climb -> no progress`). One subsystem's protected structure was another subsystem's
// terrain. No arbitration fix supplies the missing piece; the pieces existed, the
// UNIFICATION did not (review PART 2: one of only two genuine capability gaps).
//
// So: one place answers ownership, and every world-READ that cares routes through it
// (principle #4 - one rule, one definition).
//
// ==== THE SEAM THAT MATTERS: FABRIC vs SUPPORT ==========================================
// "Mine" is not one thing, and conflating the two halves is how this would go wrong in the
// opposite direction:
//
//   MY FABRIC   (ownStructureAt / ownScaffoldAt) - blocks that exist because I PUT them
//               there: the hut shell/floor/roof, a registered chest/furnace/table/bed, a
//               registered scaffold tower. These are NOT terrain. A column scan looking for
//               the ground must read THROUGH them, and a ceiling scan must not call them a
//               cave roof.
//   MY SUPPORT  (ownSupportAt) - the natural dirt and stone my structure STANDS ON. It is
//               protected (hutModel.inSupport, unbounded downward) but it IS the world's
//               ground. Skipping it in a surface scan would send every read straight to
//               bedrock. It is terrain that I am forbidden to cut - which is a fact about
//               PERMISSION, not about what the block is.
//
// ownBlockAt() is the fabric half and ONLY the fabric half. noDigAt() is the permission
// half, exported so a nav rung can stop attempting climbs the one dig rule structurally
// forbids, instead of discovering the refusal 243 times.
//
// ==== WHAT THIS MODULE DOES NOT DO ======================================================
// It does not decide what may be dug or placed - provision-core.digBlocked/placeBlocked are
// still the one answer to that, and they are unchanged. It reads NO blocks: every predicate
// here is pure arithmetic over the infra registry + the scaffold registry, so it is cheap
// enough to sit inside a 380-cell column scan (principle #8). "foreign vs unknown" is a
// question about a block's MATERIAL and belongs to canBreakNaturally; duplicating it here
// would create the fourth truth this module exists to prevent.
//
// Offline tests: bot/selfworldtest.js (plus surfaceclimbtest.js / underfloortest.js /
// hutmodeltest.js, which exercise the consumers).

const hutModel = require('./hut-model.js')     // PURE self-structure geometry (schema-derived)
const worldMemory = require('./world-memory.js') // the infra registry (where my structures ARE)
const scaffold = require('./scaffold.js')      // the temp-block registry (what I put up to move)

// The point-infra kinds whose registered cell IS a block I placed. Same list as
// provision-hut's POINT_INFRA_KINDS, and deliberately NOT 'shelter'/'water'/'wheatFarm':
// those records are a PLACE (a dug pit, a pond, a plot anchor), not a block, and claiming
// their cell as my fabric would tell a surface scan to read through open ground.
const POINT_INFRA_KINDS = ['chest', 'furnace', 'table', 'bed']

const floorOf = (pos) => ({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) })

function huts () { try { return worldMemory.listInfra('hut') } catch { return [] } }

// ---- MY FABRIC ---------------------------------------------------------------------------

// The hut BOX: footprint x dy 0..4 - floor slab, walls, interior, roof slab. Pure geometry
// over the registry, no world read, and it FAILS PROTECTIVE (an unloaded chunk cannot make a
// registered hut stop being mine). Kept as its own entry point because digBlocked asks exactly
// this question over up to 64 candidate cells in one pass (ensurePillarFiller): routing it
// through the point-infra sweep below would multiply that by five registry reads for nothing
// (principle #8 - cheap by construction). Returns the hut record, or null.
function ownHutBoxAt (pos) {
  if (!pos) return null
  const { x, y, z } = floorOf(pos)
  for (const h of huts()) {
    if (hutModel.inBox(h, x, z) && y >= h.y && y <= h.y + hutModel.DIMS.h - 1) return h
  }
  return null
}

// "Is this cell part of a structure I built?" The hut box, or a registered point-infra cell
// (a chest/furnace/table/bed IS a block the bot placed). Returns { kind, rec } or null.
function ownStructureAt (pos) {
  if (!pos) return null
  const h = ownHutBoxAt(pos)
  if (h) return { kind: 'hut', rec: h }
  const { x, y, z } = floorOf(pos)
  for (const kind of POINT_INFRA_KINDS) {
    let list = []
    try { list = worldMemory.listInfra(kind) } catch {}
    for (const e of list) { if (e.x === x && e.y === y && e.z === z) return { kind, rec: e } }
  }
  return null
}

// "Is this cell a block I stood up to MOVE (a pillar/bridge/pathfinder tower)?" The scaffold
// registry is the only thing that can tell a floating 1x1 tower from ground - see the FIX 8
// note in scaffold.js about the 336 unpaid cells that made surfaceYAt read litter as terrain.
function ownScaffoldAt (pos) {
  if (!pos) return false
  try { return !!scaffold.isScaffold(floorOf(pos)) } catch { return false }
}

// THE PREDICATE THE COLUMN SCANS ASK. "A solid block read at this cell is MINE, not the
// world's" -> 'structure' | 'scaffold' | null. This is the one definition that
// pathfix.surfaceYAt (scanning DOWN for ground) and provision-hut.hasSolidCeiling (scanning
// UP for a roof) now share. Before, each had its own half of it and they disagreed.
function ownBlockAt (pos) {
  if (ownStructureAt(pos)) return 'structure'
  if (ownScaffoldAt(pos)) return 'scaffold'
  return null
}

// ---- MY GROUND (protected terrain, NOT fabric) --------------------------------------------

// "Is this cell holding up something of mine?" The positional half of dig permission,
// verbatim the rule provision-hut.ownInfraSupportAt has enforced since 2026-08-02: the hut
// footprint + a 1-cell ring, whole column at/below the floor (hutModel.inSupport), plus the
// 3x3 column beneath a registered chest/furnace/table/bed. Terrain, not fabric - see the
// FABRIC vs SUPPORT note at the top. Returns the record, or null.
function ownSupportAt (pos) {
  if (!pos) return null
  const { x, y, z } = floorOf(pos)
  for (const h of huts()) { if (hutModel.inSupport(h, x, y, z)) return h }
  for (const kind of POINT_INFRA_KINDS) {
    let list = []
    try { list = worldMemory.listInfra(kind) } catch {}
    for (const e of list) { if (Math.abs(x - e.x) <= 1 && Math.abs(z - e.z) <= 1 && y < e.y) return e }
  }
  return null
}

// The crawlspace UNDER my own floor, inside the footprint (hutModel.underFloor). Named
// separately because it is the exact gap the bot fell into on 2026-08-02: geometrically
// "not in the hut" (ownStructureAt stops AT the floor), so every own-structure guard read
// false while the ceiling overhead was the bot's own oak_planks.
function underOwnFloorAt (pos) {
  if (!pos) return null
  const { x, y, z } = floorOf(pos)
  for (const h of huts()) { if (hutModel.underFloor(h, x, y, z)) return h }
  return null
}

// The 2-cell apron around the hut: the doorstep and the working ring. Not dig-protected (the
// support region already covers what holds the hut up); this is "I am AT home", not "this is
// my block".
function onOwnApronAt (pos) {
  if (!pos) return null
  const { x, z } = floorOf(pos)
  for (const h of huts()) {
    if (x >= h.x - 2 && x <= h.x + hutModel.DIMS.w && z >= h.z - 2 && z <= h.z + hutModel.DIMS.l) return h
  }
  return null
}

// ---- THE COMPOSED ANSWERS -----------------------------------------------------------------

// Every cell, classified. 'my-structure' | 'my-scaffold' | 'my-support' | 'my-apron' |
// 'natural'. Registry-only, so 'natural' means "not mine" and NOT "safe to cut" - the
// material rule (canBreakNaturally) owns that half and is not duplicated here.
function classifyCell (pos) {
  if (ownStructureAt(pos)) return 'my-structure'
  if (ownScaffoldAt(pos)) return 'my-scaffold'
  if (ownSupportAt(pos)) return 'my-support'
  if (onOwnApronAt(pos)) return 'my-apron'
  return 'natural'
}

// THE HOME VOLUME (review §3.4): fabric + the ground it stands on + the crawlspace under it
// + the 2-cell apron. This is the region where "I am stuck" means "I am at home and the way
// out is the DOOR" - never "I am buried and must cut my way to the sky".
// Returns { zone, hut } or null. zone: 'structure' | 'under-floor' | 'support' | 'apron'.
function homeVolumeAt (pos) {
  if (!pos) return null
  const s = ownStructureAt(pos)
  if (s) return { zone: 'structure', hut: s.kind === 'hut' ? s.rec : null, kind: s.kind }
  const uf = underOwnFloorAt(pos)
  if (uf) return { zone: 'under-floor', hut: uf }
  const sup = ownSupportAt(pos)
  if (sup) return { zone: 'support', hut: sup }
  const ap = onOwnApronAt(pos)
  if (ap) return { zone: 'apron', hut: ap }
  return null
}

// THE PERMISSION HALF, exported so a rung can agree with the dig rule instead of discovering
// it. These are exactly the two arms provision-core.digBlocked composes for the hut/infra
// side (the farm arms stay in provision-farm, where they are defined). A maneuver that works
// by CUTTING blocks cannot help in a cell this returns non-null for: the one dig rule will
// refuse every swing, and an attempt that is refused by construction is not an attempt, it is
// 243 log lines (principle #5 - a decision must produce an action).
// NOTE: this does not grant or withhold anything. digBlocked is still the only authority; it
// is asked here so nobody writes a second, drifting copy of "don't cut your own house".
function noDigAt (pos) {
  const s = ownStructureAt(pos)
  return s ? s.rec : ownSupportAt(pos)
}

module.exports = {
  POINT_INFRA_KINDS,
  ownHutBoxAt,
  ownStructureAt,
  ownScaffoldAt,
  ownBlockAt,
  ownSupportAt,
  underOwnFloorAt,
  onOwnApronAt,
  classifyCell,
  homeVolumeAt,
  noDigAt
}
