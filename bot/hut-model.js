'use strict'
// SELF-STRUCTURE MODEL: a real, schema-derived model of the bot's own hut - every cell
// classified as wall / door / floor / interior-free / furniture(kind) - so navigation,
// placement, the pillar/dig guards, and cleanup all reason from ONE correct picture of
// home instead of a thin boolean gate over a corrupted registry.
//
// Why this exists (ground-truthed live): the bot repeatedly WEDGED inside its own 6x6
// hut and pillared out with DIRT (head-height dirt on top of its furniture), froze ~150s
// boxed in by bed+dirt+table, and accumulated a garbage registry (12 crafting_table
// entries, 7 furnaces, 0 beds for a bed that physically exists). Root: there was no
// interior model - insideOwnStructure was a boolean, hutFreeCells/furnitureInHut scanned
// a 5x5 interior (dx/dz 1..3) when the hut is SIX wide (Width=Length=6 in hut.schem, so
// the interior is dx/dz 1..4), and nothing reconciled memory against the world.
//
// PURE by design: every function takes an `anchor` ({x,y,z} = the hut's min corner, the
// infra.hut entry) and a `read(x,y,z)` callback returning a block-like {name, boundingBox}
// or null. No bot, no I/O, no Vec3 - so it is offline-testable (bot/hutmodeltest.js) and
// provision.js can wrap it with real world reads. Coordinates returned are plain {x,y,z}.

// hut.schem geometry (verified from the file: Width 6, Height 5, Length 6). CANONICAL
// CONVENTION: anchor.y is the FLOOR PLANK SLAB the bot stands ON (dy0 in the schematic is
// a full 6x6 plank floor). So: floor slab = anchor.y; the bot's FEET / door-lower /
// furniture sit at anchor.y+1 (dy1); door-upper / head at anchor.y+2 (dy2); interior air
// spans dy1..3; the roof plank slab is anchor.y+4 (dy4 = anchor.y+DIMS.h-1). Natural grade
// outside the hut is ~anchor.y-1. (The OLD model wrongly assumed a floorless schematic with
// feet at anchor.y - an off-by-one that made doorwayColumn/freeStandCells read the solid
// floor and return nothing.)
const DIMS = { w: 6, h: 5, l: 6 }
const WALL_RE = /_planks$/                                   // the hut shell is all planks
const DOOR_RE = /_door$/
// furniture = anything the bot stands things up inside the hut (a door is structural, not
// interior furniture, so it's NOT here - it lives in the wall as the door class).
const FURNITURE_RE = /chest$|barrel$|furnace$|smoker$|crafting_table$|_bed$|^torch$|_torch$/
// stray = loose FILLER the bot itself dropped (nav nudge/pillar/heal) or natural intrusion:
// never furniture, never the plank shell. This is exactly what cleanup digs.
const STRAY_FILLER_RE = /^(dirt|coarse_dirt|rooted_dirt|cobblestone|cobbled_deepslate|stone|granite|diorite|andesite|tuff|gravel|sand|red_sand|netherrack|clay|mud|grass_block|podzol)$/
const AIRISH = n => n === 'air' || n === 'cave_air' || n === 'void_air' || n == null

function box (a) {
  return { x0: a.x, y0: a.y, z0: a.z, x1: a.x + DIMS.w - 1, y1: a.y + DIMS.h - 1, z1: a.z + DIMS.l - 1, floorY: a.y }
}
const inBox = (a, x, z) => x >= a.x && x <= a.x + DIMS.w - 1 && z >= a.z && z <= a.z + DIMS.l - 1
const isRim = (a, x, z) => inBox(a, x, z) && (x === a.x || x === a.x + DIMS.w - 1 || z === a.z || z === a.z + DIMS.l - 1)
const isCorner = (a, x, z) => (x === a.x || x === a.x + DIMS.w - 1) && (z === a.z || z === a.z + DIMS.l - 1)
const isInterior = (a, x, z) => inBox(a, x, z) && !isRim(a, x, z) // 6-wide -> interior dx/dz 1..4 (4x4)

// The interior 4x4 columns as [x,z] pairs (the fix: 1..4, not the old 1..3).
function interiorColumns (a) {
  const out = []
  for (let x = a.x + 1; x <= a.x + DIMS.w - 2; x++) for (let z = a.z + 1; z <= a.z + DIMS.l - 2; z++) out.push([x, z])
  return out
}

// The doorway rim column: a non-corner rim column whose door-height cells (anchor.y+1 and
// anchor.y+2 - the feet + head courses, dy1..2) are NOT the plank shell (they're air, or a
// door/bed clutter shoved in). Detected from the world so it survives a door that's been dug
// or a bed jammed in the frame. Returns {x,z}|null.
//
// `opts.preferDoorBlock` (default false = today's byte-for-byte scan; the door-crossing
// caller passes it under DOOR_CROSS_GEOMETRIC): with a wall HOLE the plain gap-scan finds
// >=2 qualifying columns and picks whichever sorts first (hole or door), and a `null`
// (unloaded/edge-of-range) read makes ANY rim column look like a gap - so the chosen "door"
// flapped between the real door and the hole across calls. With preferDoorBlock:
//   1. FIRST return the column that actually holds a hung `_door` block (invariant to holes),
//   2. else fall back to the gap rule, but a `null` read is UNKNOWN - it never qualifies a
//      column as the doorway (kills the unloaded-chunk flap). Still pure/offline-testable.
function doorwayColumn (a, read, opts = {}) {
  if (opts.preferDoorBlock) {
    // Pass 1: the ACTUAL hung door (its lower half sits at anchor.y+1). Stable across holes.
    for (let x = a.x; x <= a.x + DIMS.w - 1; x++) {
      for (let z = a.z; z <= a.z + DIMS.l - 1; z++) {
        if (!isRim(a, x, z) || isCorner(a, x, z)) continue
        const lo = read(x, a.y + 1, z)
        if (lo && DOOR_RE.test(lo.name)) return { x, z }
      }
    }
  }
  for (let x = a.x; x <= a.x + DIMS.w - 1; x++) {
    for (let z = a.z; z <= a.z + DIMS.l - 1; z++) {
      if (!isRim(a, x, z) || isCorner(a, x, z)) continue
      const lo = read(x, a.y + 1, z); const hi = read(x, a.y + 2, z)
      if (opts.preferDoorBlock) {
        // Pass 2 (no door block anywhere): a KNOWN non-wall gap in BOTH courses. A null read
        // is unknown, not "open" - so it can never claim the doorway.
        if (lo != null && hi != null && !WALL_RE.test(lo.name) && !WALL_RE.test(hi.name)) return { x, z }
      } else {
        const loWall = lo && WALL_RE.test(lo.name); const hiWall = hi && WALL_RE.test(hi.name)
        if (!loWall && !hiWall) return { x, z }
      }
    }
  }
  return null
}

// The interior cell directly in FRONT of the doorway - kept walkable (a bed/table here
// blocks the entrance, live). Returns {x,z}|null.
function thresholdCell (a, door) {
  if (!door) return null
  const dx = door.x === a.x ? 1 : door.x === a.x + DIMS.w - 1 ? -1 : 0
  const dz = door.z === a.z ? 1 : door.z === a.z + DIMS.l - 1 ? -1 : 0
  return { x: door.x + dx, z: door.z + dz }
}

// The cell just OUTSIDE the doorway (opposite the interior threshold) - the plannable
// stand-off a bot paths to BEFORE crossing in (you can't goto a cell inside a closed box).
// Returns {x,z}|null.
function outsideCell (a, door) {
  if (!door) return null
  const dx = door.x === a.x ? -1 : door.x === a.x + DIMS.w - 1 ? 1 : 0
  const dz = door.z === a.z ? -1 : door.z === a.z + DIMS.l - 1 ? 1 : 0
  return { x: door.x + dx, z: door.z + dz }
}

// Classify one cell: 'outside' | 'wall' | 'door' | 'floor' | 'interior' | 'furniture' |
// 'stray'. `door` may be passed (else detected). Furniture/stray need a world read.
function classifyCell (a, read, x, y, z, door) {
  if (!inBox(a, x, z) || y < a.y || y > a.y + DIMS.h - 1) return { cls: 'outside' }
  door = door === undefined ? doorwayColumn(a, read) : door
  if (y === a.y) return isRim(a, x, z) ? { cls: 'wall' } : { cls: 'floor' } // the floor plank slab (interior) / its rim
  if (y === a.y + DIMS.h - 1) return { cls: 'wall' }                        // the roof plank slab (rim + interior are plank)
  if (isRim(a, x, z)) {
    if (door && x === door.x && z === door.z && (y === a.y + 1 || y === a.y + 2)) return { cls: 'door' }
    return { cls: 'wall' }
  }
  // interior air column, dy 1..3
  const b = read(x, y, z)
  if (!b || AIRISH(b.name)) return { cls: 'interior' }
  if (FURNITURE_RE.test(b.name)) return { cls: 'furniture', kind: furnitureKind(b.name) }
  if (STRAY_FILLER_RE.test(b.name)) return { cls: 'stray', name: b.name }
  return { cls: 'interior', name: b.name } // some other block - treat as occupied interior, not stray (don't dig unknowns)
}

function furnitureKind (name) {
  if (/crafting_table$/.test(name)) return 'table'
  if (/furnace$|smoker$/.test(name)) return 'furnace'
  if (/chest$|barrel$/.test(name)) return 'chest'
  if (/_bed$/.test(name)) return 'bed'
  if (/torch/.test(name)) return 'torch'
  return 'other'
}

// STANDABLE free interior cells (feet position). A real player stands ON the floor plank
// slab, so the feet cell is anchor.y+1: feet + head air, the solid non-furniture plank floor
// directly below (anchor.y), and not the doorway threshold. Deliberately does NOT accept a
// cell perched on top of a furniture/dirt pile (that's where the bad pillar-out put the bot).
// Sorted FURTHEST from the door first (an unstick/place picks the deepest free corner, not
// the entrance). Returns [{x,y,z}] with y = anchor.y+1.
function freeStandCells (a, read) {
  const door = doorwayColumn(a, read)
  const thr = thresholdCell(a, door)
  const out = []
  const y = a.y + 1
  for (const [x, z] of interiorColumns(a)) {
    if (thr && x === thr.x && z === thr.z) continue
    const feet = read(x, y, z); const head = read(x, y + 1, z); const below = read(x, y - 1, z)
    const belowFloor = below && below.boundingBox === 'block' && !FURNITURE_RE.test(below.name)
    if (AIRISH(feet && feet.name) && AIRISH(head && head.name) && belowFloor) out.push({ x, y, z })
  }
  if (door) out.sort((p, q) => Math.hypot(q.x - door.x, q.z - door.z) - Math.hypot(p.x - door.x, p.z - door.z))
  return out
}

// STRAY filler blocks sitting in interior AIR cells (dy 1..h-2) - loose dirt/cobble on the
// floor slab or piled on furniture. Skips the floor slab (dy0) and roof (dy h-1) planks.
// These are what cleanup digs. Returns [{x,y,z,name}].
function strayCells (a, read) {
  const out = []
  for (const [x, z] of interiorColumns(a)) {
    for (let dy = 1; dy <= DIMS.h - 2; dy++) {
      const y = a.y + dy
      const b = read(x, y, z)
      if (b && !AIRISH(b.name) && STRAY_FILLER_RE.test(b.name)) out.push({ x, y, z, name: b.name })
    }
  }
  return out
}

// Furniture blocks physically standing in the interior, grouped by kind. The authoritative
// count of what's REALLY inside (vs the corrupted registry). Returns {table:[{x,y,z}],...}.
function stationCells (a, read) {
  const out = { table: [], furnace: [], chest: [], bed: [], torch: [], other: [] }
  for (const [x, z] of interiorColumns(a)) {
    for (let dy = 1; dy <= DIMS.h - 2; dy++) {
      const y = a.y + dy
      const b = read(x, y, z)
      if (b && !AIRISH(b.name) && FURNITURE_RE.test(b.name)) out[furnitureKind(b.name)].push({ x, y, z, name: b.name })
    }
  }
  return out
}

// PLACEMENT DECISION (pure - the deliverable-2/3 logic): where (if anywhere) to place a
// NEW station of `kind`. Returns null when `desired` of that kind already physically stand
// inside the hut (NEVER duplicate - trust the world scan, not the lying registry), else the
// deepest free interior FLOOR cell to place into (never a wall/door/threshold/occupied cell).
// null also when the interior is full. This is what stops the duplicate-table recurrence.
function stationSlot (a, read, kind, desired = 1) {
  const have = (stationCells(a, read)[kind] || []).length
  if (have >= desired) return null // already have enough - do not place another
  const free = freeStandCells(a, read)
  return free.length ? free[0] : null
}

// A floor cell that is a HOLE (air/liquid where a solid floor PLANK should be). The floor is
// the plank slab at anchor.y (not the dirt under it). Returns [{x,y,z}].
function floorHoles (a, read) {
  const out = []
  for (const [x, z] of interiorColumns(a)) {
    const y = a.y
    const b = read(x, y, z)
    if (!b || AIRISH(b.name) || /water|lava/.test(b.name)) out.push({ x, y, z })
  }
  return out
}

// ---- pure registry reconcile helpers (offline-testable) ---------------------------
// The corrupted-registry fix, as pure logic. `list` = infra entries [{x,y,z,at}];
// `verify(cell)` returns true (block present) / false (loaded, block GONE) / null
// (unloaded, unknown). Result: dedupe exact cells, DROP verified-gone, KEEP present +
// unknown. This is what collapses 12 phantom tables to the real count.
function reconcileCells (list, verify) {
  const seen = new Set()
  const keep = []
  const pruned = []
  for (const e of list) {
    const k = e.x + ',' + e.y + ',' + e.z
    if (seen.has(k)) { pruned.push(e); continue } // exact duplicate
    const v = verify ? verify(e) : null
    if (v === false) { pruned.push(e); continue }  // loaded and the block is gone
    seen.add(k); keep.push(e)
  }
  return { keep, pruned }
}

// ---- #37 non-destructive hut repair: decision predicate + tolerant classifier --------
// A creeper hole is NOT a reason to empty the bank + clearFurniture-teardown the hut. These
// two PURE functions let the camp pass route ordinary damage into the existing cell-by-cell
// patcher (repairHutStructure) and reserve the catastrophic rebuild for a genuinely
// flattened hut - and never fire the destructive path twice without measured improvement.

// Absolute floor for the rebuild threshold, so a tiny schematic can't trip the 50% rule on
// a handful of cells (135-cell hut.schem -> rebuild only at bad >= 68).
const REBUILD_MIN = 24

// The tolerant CLASS a block name belongs to for hut-repair mismatch purposes. Mirrors
// repairHutStructure's deliberately tolerant matching (any *_planks satisfies a plank cell,
// any *chest a chest cell, furnace/smoker a furnace cell, any *crafting_table a table, any
// *_door a door; air/cave_air/void_air collapse to 'air'). Anything else -> its exact name.
function cellClass (name) {
  if (AIRISH(name)) return 'air'
  if (/_planks$/.test(name)) return 'plank'
  if (/_door$/.test(name)) return 'door'
  if (/chest$/.test(name)) return 'chest'
  if (/furnace$|smoker$/.test(name)) return 'furnace'
  if (/crafting_table$/.test(name)) return 'table'
  return name
}

// TRUE when the world block `gotName` does NOT satisfy the schematic's `wantName` for a hut
// cell. Tolerant by class - a birch-plank patch satisfies an oak-plank cell, a trapped_chest
// a chest cell - so a legitimate repairHutStructure patch doesn't read as permanent damage
// (the divergence that would otherwise pin 'patch' forever, §4.2).
function cellMismatch (wantName, gotName) {
  return cellClass(wantName) !== cellClass(gotName)
}

// PURE repair decision. `bad` = grounded mismatch count; `solidTotal` = count of non-air
// schematic cells; `lastBad`/`lastAction` = the previous pass's in-memory progress latch.
//   bad <= 3     -> 'none'    (liveability chain still runs every pass, unchanged threshold)
//   bad > 3      -> 'patch'   (the DEFAULT - non-destructive repairHutStructure, bank sealed)
//   catastrophic -> 'rebuild' ONLY when bad >= max(REBUILD_MIN, ceil(0.5*solidTotal)) AND the
//                   latch permits: never 'rebuild' twice without `bad` decreasing (kills the
//                   re-empty-every-pass loop by construction). A prior action that didn't
//                   improve `bad` locks the destructive path down to 'patch'.
function decideHutRepair ({ bad, solidTotal, lastBad, lastAction } = {}) {
  if (!(bad > 3)) return 'none'
  const threshold = Math.max(REBUILD_MIN, Math.ceil(0.5 * (solidTotal || 0)))
  if (bad >= threshold) {
    const improved = typeof lastBad === 'number' && bad < lastBad
    const stalled = lastAction != null && !improved
    if (!stalled) return 'rebuild'
  }
  return 'patch'
}

module.exports = {
  REBUILD_MIN,
  cellClass,
  cellMismatch,
  decideHutRepair,
  DIMS,
  WALL_RE,
  DOOR_RE,
  FURNITURE_RE,
  STRAY_FILLER_RE,
  box,
  inBox,
  isRim,
  isInterior,
  interiorColumns,
  doorwayColumn,
  thresholdCell,
  outsideCell,
  classifyCell,
  furnitureKind,
  freeStandCells,
  strayCells,
  stationCells,
  stationSlot,
  floorHoles,
  reconcileCells
}
