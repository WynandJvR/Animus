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

// What may occupy an interior AIR cell and be removed: loose filler AND the hut's own plank.
// PLANKS were added 2026-07-30: with the anchor drifted one cell (see bestAnchor below) the
// repairer walled the interior row z=4 with 10 oak_planks, and because strayCells only matched
// dirt/cobble the bot printed `interior already clean` next to `12 bad` for five hours. A plank
// standing in the bot's OWN interior is its own over-placement - it is the single material the
// hut is built from - and clearing it is restoring the building to spec, not griefing.
// Deliberately NOT furniture: a bed/chest/furnace/table/torch indoors is a furnished home, and
// the bed in particular is the spawn anchor and is not in the schematic at all.
const INTERIOR_PLANK_RE = /^[a-z_]+_planks$/
const isInteriorObstruction = name =>
  !!name && !FURNITURE_RE.test(name) && (STRAY_FILLER_RE.test(name) || INTERIOR_PLANK_RE.test(name))

// STRAY blocks sitting in interior AIR cells (dy 1..h-2) - filler on the floor slab, piled on
// furniture, or the bot's own misplaced planks. Skips the floor slab (dy0) and roof (dy h-1)
// planks, which are fabric. These are what cleanup digs. Returns [{x,y,z,name}].
function strayCells (a, read) {
  const out = []
  for (const [x, z] of interiorColumns(a)) {
    for (let dy = 1; dy <= DIMS.h - 2; dy++) {
      const y = a.y + dy
      const b = read(x, y, z)
      if (b && !AIRISH(b.name) && isInteriorObstruction(b.name)) out.push({ x, y, z, name: b.name })
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

// ---- WHERE IS MY HUT: the anchor is found, never derived (2026-07-30) ---------------
// THE LIVE BUG. With infra.hut empty the camp step computed the hut's coordinate frame from
// the BED: `snapToGround(bot, schem, Vec3(kb.x+3, kb.y-1, kb.z-2))`. The bed moved one block
// (185,-103 at 14:03 -> 185,-102 at 16:52) and took the whole hut with it (anchor z -105 ->
// -104). Under the stale frame world z=-100 read as the z=5 RIM WALL, so the repairer dutifully
// walled it up: 10 planks straight across the interior. It also explains `place plank at
// (191,67,-105)`, a cell outside the real hut entirely.
//
// A structure's location is a property of the STRUCTURE. These two PURE functions resolve it
// from the world - the frame where the building actually stands - so a neighbour that moves
// can never move the hut. `relCells` is the schematic as [{dx,dy,dz,want}]; `read(x,y,z)`
// returns a block-like {name} or null/undefined for "not loaded" (which is UNKNOWN, never a
// match - the #115 rule holds here too: a frame nobody can see wins nothing).

// How well does the standing world match the schematic if the anchor were `at`?
function anchorFit (relCells, at, read) {
  let match = 0; let known = 0
  for (const c of (relCells || [])) {
    const b = read(at.x + c.dx, at.y + c.dy, at.z + c.dz)
    if (b == null) continue
    known++
    if (!cellMismatch(c.want, b.name)) match++
  }
  return { match, known, total: (relCells || []).length }
}

// The best-fitting anchor within `radius` of `seed`, or null when nothing fits confidently.
// Confidence has three parts, all necessary: enough of the window is LOADED (minKnown), the
// winner actually looks like the hut (minMatch), and it beats the runner-up by `margin` so an
// ambiguous frame refuses rather than guesses. Deterministic tie-break toward the seed.
function bestAnchor (seed, relCells, read, opts = {}) {
  const radius = opts.radius != null ? opts.radius : 2
  const minKnown = opts.minKnown != null ? opts.minKnown : 0.9
  const minMatch = opts.minMatch != null ? opts.minMatch : 0.6
  const margin = opts.margin != null ? opts.margin : 4
  const total = (relCells || []).length
  if (!seed || !total) return null
  const scored = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const at = { x: seed.x + dx, y: seed.y + dy, z: seed.z + dz }
        const f = anchorFit(relCells, at, read)
        if (f.known < minKnown * total) continue          // too much unloaded to judge
        scored.push({ at, ...f, off: Math.abs(dx) + Math.abs(dy) + Math.abs(dz) })
      }
    }
  }
  if (!scored.length) return null
  scored.sort((a, b) => (b.match - a.match) || (a.off - b.off))
  const best = scored[0]
  if (best.match < minMatch * total) return null           // nothing here looks like the hut
  const rival = scored.find(s => s.at.x !== best.at.x || s.at.y !== best.at.y || s.at.z !== best.at.z)
  if (rival && best.match - rival.match < margin) return null // ambiguous - refuse to guess
  return { anchor: best.at, match: best.match, known: best.known, total, runnerUp: rival ? rival.match : 0 }
}

// ---- ONE DEFINITION OF HUT DAMAGE (2026-07-30) --------------------------------------
// repairHutStructure counted 136 cells, the camp decision 180, the shell survey 176, and they
// disagreed forever (`2 cell(s) off` / `bad=14/136` / `12 bad of 176`, same hut, same second).
// Worse, the only repair actor could not SEE the direction the surveys were counting. This is
// the single scan all three read from, split by the role that names each part's OWNER:
//   enclosure  -> repairHutStructure places it, and it alone gates registration
//   clearance  -> cleanupHutInterior digs it
//   furnishing -> repairHutStructure places it
// UNKNOWN cells are counted separately and never as damage (#115).
function hutDamage (relCells, at, read) {
  const out = { enclosure: [], clearance: [], furnishing: [], unknown: 0, total: (relCells || []).length }
  for (const c of (relCells || [])) {
    const p = { x: at.x + c.dx, y: at.y + c.dy, z: at.z + c.dz }
    const b = read(p.x, p.y, p.z)
    if (b == null) { out.unknown++; continue }
    if (!cellMismatch(c.want, b.name)) continue
    out[cellRole(c.want)].push({ x: p.x, y: p.y, z: p.z, want: c.want, got: b.name })
  }
  return out
}

// Which duplicate station to KEEP. Live 2026-07-30 cleanupHutInterior deduped by scan order
// (lowest z first), so it kept the strays at z=-101 and dug the table + furnace standing in the
// schematic's OWN cells at z=-100 - manufacturing the two furniture holes repairHut then
// reported as damage forever. The schematic decides: a station in its designed cell is the
// keeper. Stable, so same-priority cells keep their scan order.
function dedupeOrder (cells, protectedCells) {
  const prot = protectedCells || []
  const isProt = c => prot.some(p => p.x === c.x && p.y === c.y && p.z === c.z)
  return (cells || []).map((c, i) => ({ c, i })).sort((a, b) => (isProt(b.c) ? 1 : 0) - (isProt(a.c) ? 1 : 0) || (a.i - b.i)).map(e => e.c)
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

// ==== SHELL vs FURNISHING: "does it shelter me" is not "is it perfect" (2026-07-30) ======
// A hut is only REGISTERED (rememberInfra('hut')) when the build verified PERFECT:
//   const builtClean = sv2.verdict === 'OK' && hr.total && hr.placed >= hr.total
// Live 2026-07-30 the hut built 45/47 with 1 cell off - the missing cells were FURNISHING (it
// held 0 wool, so `camp: hut bed -> none`). The walls, roof and door were all up. But because
// the gate is all-or-nothing, `hutAnchor()` stayed null and a 96%-complete shelter counted as NO
// HUT AT ALL, which silently killed everything keyed off it:
//   consolidate: no bank chest inside the hut yet / safekeep: no hut bank chest - skipping
//   bed-upgrade: [noop] ... / reconcileInfra: bed 0->0
// The shelter existed in the world and not in the bot's model.
//
// The all-or-nothing gate was deliberate (#115: unconditional registration once let the bot
// "believe home was established and walk away for hours"), so the fix is NOT to loosen the proof.
// It is that "proven to exist" and "proven perfect" are two different claims and the code only
// had one. Furnishing gaps are repair debt, tracked and patched, never a reason to disown the
// building.
//
// ==== ROLES: ONE VOCABULARY, ONE ACTOR EACH (2026-07-30) ================================
// The first cut of this split put the interior AIR cells in the shell, reasoning that "the
// interior that must stay clear" is part of what shelters you. Live, that produced damage NO
// CODE COULD REPAIR: repairHutStructure opens with `if (schema wants air) continue - never
// fill`, so it cannot see an air cell at all, and strayCells only matched dirt/cobble, so it
// could not see a PLANK sitting in one. The bot had walled its own interior row (10 planks at
// world z=-100, measured) and every pass read `12 bad` and `interior already clean` together,
// forever. A cell counted as damage by a survey and visible to no actor is a deadlock by
// construction - it is the shape of every bug in this session.
//
// So each cell's want-name has exactly one ROLE, and each role has exactly one owner:
//   'enclosure'  planks + door -> what makes it SHELTER you.  Gates registration.
//   'clearance'  air           -> must be free of non-furniture. Owned by cleanupHutInterior.
//   'furnishing' chest/furnace/table/anything else -> repair debt. Owned by repairHutStructure.
// isShellCell is now enclosure-only. That is 525e235's "does it shelter me is not is it
// perfect" applied one level deeper: a crafting table standing one cell off does not make a
// bot homeless, and a 130-plank box with both door halves up IS a shelter. The claim stays
// strict about the thing it actually asserts.
const ENCLOSURE_CLASSES = new Set(['plank', 'door'])
function cellRole (wantName) {
  const c = cellClass(wantName)
  if (ENCLOSURE_CLASSES.has(c)) return 'enclosure'
  if (c === 'air') return 'clearance'
  return 'furnishing'
}
function isShellCell (wantName) { return cellRole(wantName) === 'enclosure' }

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
  // ==== ABSENCE IS NOT DAMAGE (2026-07-30) ==============================================
  // Falling through to 'patch' when EVERY cell is missing is an answer that cannot work:
  // there is no structure to repair, and the patch route ("re-places missing planks") had
  // nothing to anchor to. Live 2026-07-30, bad=136 of solidTotal=136 for hours:
  //   camp: hut repair decision=patch (verdict=BAD, bad=136/136 solid, lastAction=rebuild)
  //   (build) creeper damage on my hut - patching 135 block(s)
  // ...calling a hut that was never built "creeper damage", forever, because the stall latch
  // had downgraded the only capable action. The latch write is fixed at its source (see
  // commands.js #121), and this is the independent guard: when nothing is standing, the
  // decision is a BUILD regardless of what has been tried, because 'patch' is not merely
  // worse here - it is incapable. Guarded on a grounded solidTotal; the caller has already
  // refused to decide at all on an UNKNOWN survey (#115), so this can only fire on a hut the
  // bot has genuinely LOOKED at and found absent.
  if (solidTotal > 0 && bad >= solidTotal) return 'rebuild'
  return 'patch'
}

// ---- SECURE_BASE: spawn-proofing geometry (pure) ------------------------------------
// A dark base breeds mobs: creepers/spiders that survive daylight linger and harass the
// bot at home. A real player spawn-proofs by lighting the perimeter - torches on a spacing
// lattice so every ground cell reads light>=8 and denies spawns. These three PURE helpers
// are that policy; the executor (provision-hut.secureBase) reads the world through them.
//
// baseTorchAnchors(): the lattice COLUMNS (x,z) to light - a grid at `spacing`, within
// `radius` of the hut centre, OUTSIDE the hut footprint (the interior is sealed/roofed, not
// spawn ground). Anchored on the hut centre so it is DETERMINISTIC every visit, which is
// what lets the persisted torched-cell list CONVERGE instead of re-placing forever.
function baseTorchAnchors (anchor, { radius = 18, spacing = 6 } = {}) {
  if (!anchor) return []
  const cx = anchor.x + (DIMS.w - 1) / 2
  const cz = anchor.z + (DIMS.l - 1) / 2
  const step = Math.max(2, Math.floor(spacing))
  const r = Math.max(step, Math.floor(radius))
  const out = []
  for (let dx = -r; dx <= r; dx += step) for (let dz = -r; dz <= r; dz += step) {
    if (dx * dx + dz * dz > r * r) continue          // circular spawn radius
    const x = Math.round(cx + dx); const z = Math.round(cz + dz)
    if (inBox(anchor, x, z)) continue                // never inside the hut box
    out.push({ x, z })
  }
  return out
}

// secureBaseRemaining(): the anchors NOT yet covered by a placed torch = the work still
// owed. A torch covers only its own lattice point (coverRadius < spacing), so EACH anchor
// needs its own torch and a blown one (dropped from the persisted list on world re-read)
// re-opens its anchor. Empty result => the ring is complete (converged) => the step no-ops.
function secureBaseRemaining (anchors, torched, { coverRadius = 3 } = {}) {
  const cov2 = Math.max(1, coverRadius) * Math.max(1, coverRadius)
  const pts = torched || []
  return (anchors || []).filter(a => !pts.some(t => {
    const dx = t.x - a.x; const dz = t.z - a.z
    return dx * dx + dz * dz <= cov2
  }))
}

// secureBaseGate(): mirror of proactiveGearupGate - light the base only in a genuinely calm
// window (daylight, at home, healthy, fed, no active survival crisis). Any false => defer,
// so the bot never stands in the open placing torches during a threat / low-food crisis.
function secureBaseGate ({ hp, fed, day, atHome, crisisActive } = {}, { safeHp = 14 } = {}) {
  if (crisisActive) return false
  if (!day) return false
  if (!atHome) return false
  if (!fed) return false
  return typeof hp === 'number' && hp >= safeHp
}

// sealDescentsGate() (#89 SEAL_HOME_DESCENTS): same calm-window shape as secureBaseGate - cap the
// cave/shaft mouths that feed mobs into the hut only in daylight, at home, healthy, fed, no active
// crisis. The ONE difference is `safeHp` defaults to 12, not 14: sealing the underground ramps is
// the PREREQUISITE for a night being survivable at all, so it must not wait on a 14 that food
// scarcity rarely allows - the exact trap that kept secureBase from ever running. Still pure.
function sealDescentsGate ({ hp, fed, day, atHome, crisisActive } = {}, { safeHp = 12 } = {}) {
  if (crisisActive) return false
  if (!day) return false
  if (!atHome) return false
  if (!fed) return false
  return typeof hp === 'number' && hp >= safeHp
}

// ---- WORLD_TIDY (#94): pure litter classifier ---------------------------------------
// Active reclaim of ORPHANED litter near own infra: the scaffold registry is empty
// (interrupted ops + restarts + unregistered placements) while the world holds ~2 days of
// leveling/pillar scraps, cobble on the hut, floating dirt in the farm, and duplicate-torch
// clusters. The executor (provision-hut.worldTidy) reads the world into a per-cell `ctx` and
// asks this PURE classifier whether the cell is litter to reclaim. Five world-read signatures:
//   dup-torch  - a torch with another torch within 2 cells (keep exactly ONE per cluster)
//   floating   - a filler block with >=5 airish faces (a classic leveling/pillar scrap)
//   tower      - a filler block in a >=3-tall 1x1 column with air on all 4 sides (a pillar)
//   hut-scrap  - a well-exposed filler block ON the hut faces/roof that is NOT schema fabric
//   farm-scrap - a filler block inside the farm/orchard plot footprint (at/above the surface)
// Anti-grief is BUILT IN and comes FIRST: only torch/filler classes are ever 'dig'; hut schema
// fabric (a plank/door/furniture/floor cell) and crop/farmland/sapling/tree cells are always
// 'keep' even when a signature flag is set. Returns { decision:'keep'|'dig', sig } - `sig` names
// the matched signature, used both for the executor's dig debug line and the per-signature unit
// tests. PURE: `ctx` carries pre-read world facts, so there is no bot / no I/O here.
//
// ctx shape (all optional; the executor fills what a cell needs):
//   name          world block name at the cell
//   self          {x,y,z} of the cell (for the torch keeper tie-break)
//   airFaces      count 0..6 of the 6 face-neighbours that are airish
//   sidesAir      count 0..4 of the 4 horizontal neighbours that are airish
//   towerRun      length of the consecutive vertical filler run through this cell
//   torchCluster  [{x,y,z}] of torches (incl. self) within 2 cells (torch cells only)
//   onHutExterior true when the cell sits on the hut wall-face/roof exterior layer
//   hutSchemaFabric true when hut-model classifies this cell as fabric (plank/door/furniture/floor)
//   inFarmPlot    true when the cell is inside a plot bbox at/above the plot surface band
//   isFarmland/isCrop/isTree  protective flags (never dig these, whatever else is set)
const TIDY_FILLER_RE = /^(cobblestone|dirt|coarse_dirt|rooted_dirt|stone|granite|diorite|andesite|tuff|gravel|sand|red_sand|cobbled_deepslate|deepslate|netherrack|clay|mud|grass_block|podzol)$/
const TIDY_TORCH_RE = /^(torch|wall_torch)$/
const isTidyFiller = name => !!name && TIDY_FILLER_RE.test(name)
const isTidyTorch = name => !!name && TIDY_TORCH_RE.test(name)

// The canonical torch to KEEP in a cluster: lowest y, then lowest x, then lowest z. Deterministic
// so every torch in the same cluster agrees on the ONE keeper (exactly one 'keep', the rest 'dig').
function canonicalLitterTorch (cluster) {
  let best = null
  for (const t of (cluster || [])) {
    if (!best || t.y < best.y || (t.y === best.y && (t.x < best.x || (t.x === best.x && t.z < best.z)))) best = t
  }
  return best
}

function litterSignature (ctx) {
  const keep = sig => ({ decision: 'keep', sig: sig || 'none' })
  const dig = sig => ({ decision: 'dig', sig })
  if (!ctx || !ctx.name) return keep('empty')
  const torch = isTidyTorch(ctx.name)
  const filler = isTidyFiller(ctx.name)
  // HARD anti-grief, evaluated BEFORE any signature: only torch/filler are litter, and hut fabric
  // + crop/farmland/tree cells are sacrosanct no matter what a signature flag says.
  if (!torch && !filler) return keep('not-litter')
  if (ctx.hutSchemaFabric) return keep('hut-fabric')
  if (ctx.isFarmland || ctx.isCrop || ctx.isTree) return keep('protected')

  // 1) DUPLICATE TORCH - a cluster of >=2 keeps its canonical member; the extras are litter.
  if (torch) {
    const cluster = Array.isArray(ctx.torchCluster) ? ctx.torchCluster : []
    if (cluster.length >= 2 && ctx.self) {
      const keeper = canonicalLitterTorch(cluster)
      if (keeper && !(keeper.x === ctx.self.x && keeper.y === ctx.self.y && keeper.z === ctx.self.z)) return dig('dup-torch')
    }
    return keep('torch') // a lone torch or the cluster's keeper - leave it lit
  }

  // filler from here down.
  // 4) HUT-EXTERIOR SCRAP - a filler block stuck on the hut face/roof. Require >=3 air faces so a
  //    hillside the hut is dug into (a solid terrain mass against a wall) is never carved.
  if (ctx.onHutExterior && (ctx.airFaces || 0) >= 3) return dig('hut-scrap')
  // 5) FARM/ORCHARD FOOTPRINT SCRAP - filler inside the plot bbox, at/above the surface band.
  if (ctx.inFarmPlot) return dig('farm-scrap')
  // 2) FLOATING SINGLE BLOCK - a leveling/pillar scrap hanging in the air.
  if ((ctx.airFaces || 0) >= 5) return dig('floating')
  // 3) 1x1 TOWER - a pillar leftover: a >=3-tall filler column with air on all 4 sides.
  if ((ctx.towerRun || 0) >= 3 && (ctx.sidesAir || 0) >= 4) return dig('tower')
  return keep('none')
}

module.exports = {
  REBUILD_MIN,
  TIDY_FILLER_RE,
  TIDY_TORCH_RE,
  isTidyFiller,
  isTidyTorch,
  canonicalLitterTorch,
  litterSignature,
  cellClass,
  cellRole,
  isShellCell,
  isInteriorObstruction,
  anchorFit,
  bestAnchor,
  hutDamage,
  dedupeOrder,
  cellMismatch,
  decideHutRepair,
  baseTorchAnchors,
  secureBaseRemaining,
  secureBaseGate,
  sealDescentsGate,
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
