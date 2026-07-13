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

// hut.schem geometry (verified from the file: Width 6, Height 5, Length 6). The schematic
// has NO floor layer - walls start AT anchor.y - so the interior floor is the terrain at
// anchor.y-1 and a standing bot's feet sit at anchor.y (dy 0). Walls are 5 tall (dy 0..4).
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
  return { x0: a.x, y0: a.y, z0: a.z, x1: a.x + DIMS.w - 1, y1: a.y + DIMS.h - 1, z1: a.z + DIMS.l - 1, floorY: a.y - 1 }
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

// The doorway rim column: a non-corner rim column whose lower two cells (dy 0..1) are NOT
// the plank shell (they're air, or a door/bed clutter shoved in). Detected from the world
// so it survives a door that's been dug or a bed jammed in the frame. Returns {x,z}|null.
function doorwayColumn (a, read) {
  for (let x = a.x; x <= a.x + DIMS.w - 1; x++) {
    for (let z = a.z; z <= a.z + DIMS.l - 1; z++) {
      if (!isRim(a, x, z) || isCorner(a, x, z)) continue
      const lo = read(x, a.y, z); const hi = read(x, a.y + 1, z)
      const loWall = lo && WALL_RE.test(lo.name); const hiWall = hi && WALL_RE.test(hi.name)
      if (!loWall && !hiWall) return { x, z }
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

// Classify one cell: 'outside' | 'wall' | 'door' | 'floor' | 'interior' | 'furniture' |
// 'stray'. `door` may be passed (else detected). Furniture/stray need a world read.
function classifyCell (a, read, x, y, z, door) {
  if (!inBox(a, x, z) || y < a.y - 1 || y > a.y + DIMS.h - 1) return { cls: 'outside' }
  door = door === undefined ? doorwayColumn(a, read) : door
  if (y === a.y - 1) return isInterior(a, x, z) ? { cls: 'floor' } : { cls: 'outside' } // floor only under the interior
  if (isRim(a, x, z)) {
    if (door && x === door.x && z === door.z && (y === a.y || y === a.y + 1)) return { cls: 'door' }
    return { cls: 'wall' }
  }
  // interior column, dy 0..4
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

// STANDABLE free interior cells (feet position). A real player stands on the FLOOR, so
// this is strictly the floor-level cell (feet at anchor.y): feet + head air, a solid
// non-furniture floor directly below, and not the doorway threshold. Deliberately does
// NOT accept a cell perched on top of a furniture/dirt pile (that's where the bad
// pillar-out put the bot). Sorted FURTHEST from the door first (an unstick/place picks the
// deepest free corner, not the entrance). Returns [{x,y,z}].
function freeStandCells (a, read) {
  const door = doorwayColumn(a, read)
  const thr = thresholdCell(a, door)
  const out = []
  const y = a.y
  for (const [x, z] of interiorColumns(a)) {
    if (thr && x === thr.x && z === thr.z) continue
    const feet = read(x, y, z); const head = read(x, y + 1, z); const below = read(x, y - 1, z)
    const belowFloor = below && below.boundingBox === 'block' && !FURNITURE_RE.test(below.name)
    if (AIRISH(feet && feet.name) && AIRISH(head && head.name) && belowFloor) out.push({ x, y, z })
  }
  if (door) out.sort((p, q) => Math.hypot(q.x - door.x, q.z - door.z) - Math.hypot(p.x - door.x, p.z - door.z))
  return out
}

// STRAY filler blocks sitting in interior cells (dy 0..h-1) - loose dirt/cobble on the
// floor or piled on furniture. These are what cleanup digs. Returns [{x,y,z,name}].
function strayCells (a, read) {
  const out = []
  for (const [x, z] of interiorColumns(a)) {
    for (let dy = 0; dy <= DIMS.h - 1; dy++) {
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
    for (let dy = 0; dy <= DIMS.h - 1; dy++) {
      const y = a.y + dy
      const b = read(x, y, z)
      if (b && !AIRISH(b.name) && FURNITURE_RE.test(b.name)) out[furnitureKind(b.name)].push({ x, y, z, name: b.name })
    }
  }
  return out
}

// A floor cell that is a HOLE (air/liquid where a solid floor should be). Returns [{x,y,z}].
function floorHoles (a, read) {
  const out = []
  for (const [x, z] of interiorColumns(a)) {
    const y = a.y - 1
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

module.exports = {
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
  classifyCell,
  furnitureKind,
  freeStandCells,
  strayCells,
  stationCells,
  floorHoles,
  reconcileCells
}
