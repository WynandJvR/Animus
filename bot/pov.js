'use strict'
// BOT POV (GUI-OVERHAUL §2, amended by GUI-POV-V2): render what the bot actually sees as a
// 128x72 depth+material+face frame for the Animus POV panel. This runs on the LIVE bot's single event loop - the same
// loop that owns physics, combat reflexes and the pathfinder - so the design constraint is
// not "fast", it is "never holds the loop for a tick".
//
// WHY a purpose-built DDA and not the obvious two alternatives (§2.1):
//   - los.js `lineBlocked` is a SAMPLER (0.25-block steps, boolean out). It skips corner voxels
//     between samples and cannot report which voxel was hit or how far. Wrong tool; los.js stays
//     untouched.
//   - `bot.world.raycast` is a correct voxel walk but calls getBlock() per step, building a full
//     prismarine-block object (state resolution + collision shapes) for every voxel traversed.
//     At ~3600 rays x 20-60 steps that is 100-200k object allocations per frame: GC-heavy work
//     measured in hundreds of ms, on the loop that keeps the bot alive. Rejected.
// So: Amanatides-Woo DDA over integer state ids, with a per-frame chunk-column memo (consecutive
// DDA steps almost always stay in the same column) and a module-level stateId -> token memo
// (version-static, warms once, makes the steady-state per-voxel cost a Map hit).
//
// The pure core (rayDir/dda/encodeFrame) takes callbacks, never a bot, so povtest.js can test it
// offline. All logic lives here; bot/index.js only routes.

// GUI-POV-V2 §1.3: 80x45 -> 128x72. The measured live cost (14 ms/frame, worst turn 4 ms against
// an 8 ms bail) showed the original budgets were sized ~2.5x too conservatively. 128x72 is exact
// 16:9, 2.56x the rays, projected ~36 ms/frame across 18 turns with a ~5.1 ms worst turn - still
// under the 8 ms intra-slice bail, which remains the thing that actually protects the loop.
const W = 128
const H = 72
const FOV_H_DEG = 70 // Minecraft default; vertical FOV falls out of the aspect (square pixels).
const FOV_H_RAD = FOV_H_DEG * Math.PI / 180
const MAX_DIST = 32 // beyond this the panel cannot resolve detail; halves worst-case steps vs 64
const MAX_STEPS = 96 // >= ceil(32*sqrt(3)) with margin; a hard cap independent of the distance math
const STEP_BUDGET = 640000 // 250k x 2.56, same rationale (9216*96 ~ 885k capped) - unloaded sky
// GUI-POV-V3 §2.1: SLICE_ROWS (was 4) is DELETED. It was the sole reason a frame took 18 hops
// (72/4), and each hop is a full event-loop iteration - so under congestion the frame's WALL clock
// was CPU + 18 x queue-wait, which is how ageMs reached 6 s (§1.1). The row cap contributed
// NOTHING to safety: the 8 ms bail below is checked after every row regardless, so the worst
// synchronous burst is 8 ms + one row's overshoot (~9.3 ms) with or without it (§1.2). Slices are
// now purely bail-driven -> ceil(CPU/8) ~ 4-5 hops. The honest price: the bail now binds on every
// slice, so the TYPICAL burst rises ~2 ms -> ~8 ms, which is the envelope GUI-OVERHAUL §2.2
// already defends. If tick jitter is ever observed live the knob is SLICE_MS = 6 - never the cap.
const SLICE_MS = 8 // intra-slice bail: checked after every row, well under the 50 ms physics tick
const CACHE_TTL_MS = 250 // max 4 computed fps no matter how many clients poll (GUI polls ~3.3 fps)
const MAX_WAITERS = 4 // never accumulate an unbounded pile of parked responses

// GUI-POV-V3 §3.2 - BUSY mode. The signal is the bot's OWN build wall-clock, deliberately NOT
// bot.activity/busy/moving: those proxy the CAUSE, would couple pov.js to supervisor/pathfinder
// internals, and would miss congestion from chunk floods or GC. Build wall-clock measures the
// SYMPTOM directly - "my ~36 ms of work took 1.7 s to schedule" IS "the body is busy" - with zero
// new plumbing and no bot/index.js involvement.
const BUSY_WALL_MS = 250 // last completed build took > 250 ms wall => the loop is congested.
// Idle wall is ~36-50 ms and the observed defect implies multi-second walls, so 250 sits an order
// of magnitude from both: no tuning sensitivity.
const TTL_BUSY_MS = 1000 // effective cache TTL while BUSY: at most 1 build/s, so POV duty falls to
// <=3.6 % and keeps shrinking as congestion worsens (a 5 s build = 0.7 %). A choppy panel during
// combat/pathing is CORRECT body-first behaviour; the HUD labels it (§4).
const EYE_HEIGHT = 1.62

// base64url, so char index == value 0..63. Index 62 is the reserved "unknown block" palette slot
// and 63 ('_') is the sky/no-hit sentinel, which is why the palette itself caps at 62 entries.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const SKY_CHAR = ALPHABET[63]
const UNKNOWN_INDEX = 62
const PALETTE_MAX = 62

// Pass-through set is exactly the three air blocks. Everything else - water, grass tufts, glass,
// flowers - counts as a hit: honest, cheap, and water reading as a blue surface is what a POV
// should show.
const PASS_THROUGH = new Set(['air', 'cave_air', 'void_air'])

// ---- pure core -------------------------------------------------------------

// Ray direction for pixel (col,row), row 0 = TOP. mineflayer's own look basis (§2.3):
// forward = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)). If the live view ever comes
// out mirrored left<->right, negate `r` here - one line, deliberately isolated.
function rayDir (col, row, w, h, fovHRad, yaw, pitch) {
  const cp = Math.cos(pitch)
  const fx = -Math.sin(yaw) * cp
  const fy = Math.sin(pitch)
  const fz = -Math.cos(yaw) * cp

  // r = normalize(f x up). Degenerate when looking straight up/down (f is parallel to up), where
  // the cross product collapses to zero - fall back to the yaw-only right vector, which is the
  // limit of the same expression.
  let rx = -fz; let ry = 0; let rz = fx
  const rlen = Math.hypot(rx, ry, rz)
  if (rlen < 1e-8) { rx = Math.cos(yaw); ry = 0; rz = -Math.sin(yaw) } else { rx /= rlen; ry /= rlen; rz /= rlen }

  // u = r x f
  const ux = ry * fz - rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy - ry * fx

  const tanH = Math.tan(fovHRad / 2)
  const ndcX = 2 * (col + 0.5) / w - 1
  const ndcY = 1 - 2 * (row + 0.5) / h
  const sx = ndcX * tanH
  const sy = ndcY * tanH * h / w // square pixels: vertical half-angle scales by the aspect

  let dx = fx + rx * sx + ux * sy
  let dy = fy + ry * sx + uy * sy
  let dz = fz + rz * sx + uz * sy
  const len = Math.hypot(dx, dy, dz) || 1
  dx /= len; dy /= len; dz /= len
  return { x: dx, y: dy, z: dz }
}

// Amanatides-Woo voxel traversal. Returns the FIRST non-pass-through voxel, the exact distance
// at which the ray entered it, and the FACE it entered THROUGH, or null for "no hit" (sky, void,
// unloaded chunk, out of range).
//   sample(x,y,z) -> string : palette token for a visible voxel
//                  -> 0     : pass-through (air family) - keep walking
//                  -> null  : outside the world / unloaded - the ray ends as sky
//
// GUI-POV-V2 §1.1: `face` is the axis the DDA stepped to ENTER the hit voxel - it is already
// computed by the step branches below and was simply discarded before. Collapsed to the 4 values
// that matter for directional lighting:
//   0 = top (+Y face; ray moving down, stepY === -1)   2 = X side (east/west)
//   1 = bottom (-Y face; ray moving up, stepY === +1)  3 = Z side (north/south)
// The face is assigned WHEN THE STEP IS TAKEN, so the value carried into the next iteration
// describes how we entered the voxel sampled there - not the axis we would step next. Getting
// that off by one inverts the shading. A hit at step 0 (eye inside a solid/water voxel: no axis
// has ever been stepped) keeps the initial face 0 = top/brightest, so a submerged or suffocating
// frame renders bright rather than black. Values 4..62 are reserved for future per-ray data.
function dda (origin, dir, maxDist, maxSteps, sample) {
  let vx = Math.floor(origin.x); let vy = Math.floor(origin.y); let vz = Math.floor(origin.z)

  const stepX = dir.x > 0 ? 1 : (dir.x < 0 ? -1 : 0)
  const stepY = dir.y > 0 ? 1 : (dir.y < 0 ? -1 : 0)
  const stepZ = dir.z > 0 ? 1 : (dir.z < 0 ? -1 : 0)

  // tDelta = distance along the ray between successive crossings of each axis' planes;
  // tMax = distance to the FIRST crossing. A zero component never crosses -> Infinity.
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dir.x)
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dir.y)
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dir.z)
  let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? (vx + 1 - origin.x) : (origin.x - vx)) * tDeltaX
  let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? (vy + 1 - origin.y) : (origin.y - vy)) * tDeltaY
  let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? (vz + 1 - origin.z) : (origin.z - vz)) * tDeltaZ

  let t = 0
  let face = 0 // origin-voxel default: top/brightest (see the header comment)
  for (let i = 0; i < maxSteps; i++) {
    const tok = sample(vx, vy, vz)
    if (tok === null) return null
    if (tok !== 0) return { token: tok, dist: t, face }

    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) { vx += stepX; t = tMaxX; tMaxX += tDeltaX; face = 2 } else { vz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = 3 }
    } else {
      if (tMaxY < tMaxZ) { vy += stepY; t = tMaxY; tMaxY += tDeltaY; face = stepY < 0 ? 0 : 1 } else { vz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = 3 }
    }
    if (t > maxDist) return null
  }
  return null
}

// hits: w*h array of ({token,dist,face}|null), row-major from top-left. Produces the wire pixel
// line (§2.5): one 2-char pair per ray - palette index, then quantized distance - both base64url,
// PLUS the v2 face plane (GUI-POV-V2 §1.2): a separate w*h line, one char per ray.
//
// WHY a separate plane rather than packing the face into the distance char: packing 4 faces into
// the 63 distance levels leaves 15 distance quanta (2.1 blocks), and distance precision drives
// fog - the other legibility lever - so it would buy payload we do not need (28 KB on loopback)
// at the cost of visible fog banding. The plane layout also buys BACKWARD COMPATIBILITY for free:
// the old GUI reads everything after the first '\n' and then indexes only [0, 2*w*h), which is
// exactly the untouched v1 pixel line. The '\n' and the face plane sit past its loop bound.
function encodeFrame (hits, w, h, maxDist) {
  const palette = []
  const index = new Map()
  const out = new Array(w * h)
  const faceOut = new Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const hit = hits[i]
    if (!hit) { out[i] = SKY_CHAR + SKY_CHAR; faceOut[i] = SKY_CHAR; continue }
    let idx = index.get(hit.token)
    if (idx === undefined) {
      if (palette.length < PALETTE_MAX) { idx = palette.length; palette.push(hit.token); index.set(hit.token, idx) } else { idx = UNKNOWN_INDEX }
    }
    const q = Math.min(62, Math.max(0, Math.floor(hit.dist / maxDist * 63)))
    out[i] = ALPHABET[idx] + ALPHABET[q]
    // A hit entry with no `face` (a hand-built fixture, or any future caller) encodes as 0 = top,
    // i.e. multiplier 1.0 GUI-side: exactly the flat v1 look, never a black pixel.
    const f = hit.face
    faceOut[i] = ALPHABET[(f >= 0 && f <= PALETTE_MAX) ? f : 0]
  }
  return { palette, data: out.join(''), faces: faceOut.join('') }
}

// ---- bot-facing ------------------------------------------------------------

// stateId -> palette token (or 0 for the air family). Module-level and never cleared: block
// states are version-static, the map is bounded by the registry's state count, so it warms once
// and every later frame pays a Map hit instead of a registry lookup + string test.
const tokenByStateId = new Map()

function tokenForStateId (registry, sid) {
  let tok = tokenByStateId.get(sid)
  if (tok !== undefined) return tok
  let name = null
  try { const b = registry && registry.blocksByStateId && registry.blocksByStateId[sid]; name = b ? b.name : null } catch { name = null }
  // An unresolvable state id means our registry disagrees with the server's data; treat it as
  // air rather than painting a wall of phantom blocks.
  tok = (!name || PASS_THROUGH.has(name)) ? 0 : name
  tokenByStateId.set(sid, tok)
  return tok
}

// Traces the whole frame, running rows until the slice has burned SLICE_MS (GUI-POV-V3 §2.1: the
// bail is now the ONLY slice terminator). done(frame) with { header, data, builtAt } - the header is deliberately handed
// back unserialized because `ageMs` must be stamped when the frame is SERVED, not when it is built
// (a cached frame is served many times).
function computeFrame (bot, done) {
  const world = bot.world
  const registry = bot.registry
  const entity = bot.entity
  const eye = { x: entity.position.x, y: entity.position.y + EYE_HEIGHT, z: entity.position.z }
  const yaw = entity.yaw
  const pitch = entity.pitch
  const minY = (bot.game && Number.isFinite(bot.game.minY)) ? bot.game.minY : -64
  const maxY = (bot.game && Number.isFinite(bot.game.height)) ? minY + bot.game.height : 320

  let steps = 0
  let lastCX = null; let lastCZ = null; let lastCol = null

  // Column-direct read. Verified against the INSTALLED libraries rather than assumed:
  // prismarine-world's WorldSync.getBlockStateId does getColumnAt(pos).getBlockStateId(posInChunk)
  // where posInChunk masks x/z to 0..15 and passes y through UNCHANGED (worldsync.js:5-7,106-110);
  // prismarine-chunk 1.40.0's 1.18 ChunkColumn.getBlockStateId does the `(pos.y - this.minY) >> 4`
  // section lookup itself (1.18/ChunkColumn.js:153-156). So absolute Y is correct here, and only
  // x/z need masking. It reads plain {x,y,z}, so no Vec3 allocation per voxel.
  function sample (x, y, z) {
    steps++
    if (y < minY || y >= maxY) return null
    const cx = x >> 4; const cz = z >> 4
    if (cx !== lastCX || cz !== lastCZ) { lastCol = world.getColumn(cx, cz) || null; lastCX = cx; lastCZ = cz }
    if (!lastCol) return null
    return tokenForStateId(registry, lastCol.getBlockStateId({ x: x & 15, y, z: z & 15 }))
  }

  const hits = new Array(W * H).fill(null)
  let row = 0

  // Every slice body is guarded: a throw inside a setImmediate callback is an UNCAUGHT exception
  // that would take the bot process down, so the async path cannot rely on requestFrame's
  // try/catch. Failure degrades to done(null) -> serve the last good frame.
  function slice () {
    try { sliceBody() } catch { done(null) }
  }

  function sliceBody () {
    const started = process.hrtime.bigint()
    // GUI-POV-V3 §2.1: run rows until the 8 ms bail fires. `started` and the per-row bail check
    // below are untouched - only the row cap that used to co-terminate the loop is gone.
    while (row < H) {
      if (steps < STEP_BUDGET) {
        const base = row * W
        for (let col = 0; col < W; col++) {
          hits[base + col] = dda(eye, rayDir(col, row, W, H, FOV_H_RAD, yaw, pitch), MAX_DIST, MAX_STEPS, sample)
        }
      } // budget blown: the rest of the frame stays null, i.e. renders as sky. Never overruns.
      row++
      // Bail mid-slice rather than at the slice boundary - a dense underground scene can make a
      // single slice much more expensive than an outdoor one.
      if (Number(process.hrtime.bigint() - started) / 1e6 > SLICE_MS) break
    }
    if (row < H) return setImmediate(slice)

    const { palette, data, faces } = encodeFrame(hits, W, H, MAX_DIST)
    done({
      builtAt: Date.now(),
      data,
      faces,
      header: {
        v: 2, // GUI-POV-V2 §1.2: wire version. Absent => v1 (2 chars/ray, no face plane).
        w: W,
        h: H,
        fovH: FOV_H_DEG,
        maxDist: MAX_DIST,
        pos: { x: round2(eye.x), y: round2(entity.position.y), z: round2(eye.z) },
        yaw: round3(yaw),
        pitch: round3(pitch),
        dim: String((bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, ''),
        day: !!(bot.time && bot.time.timeOfDay < 13000),
        palette
      }
    })
  }
  setImmediate(slice)
}

function round2 (n) { return Math.round(n * 100) / 100 }
function round3 (n) { return Math.round(n * 1000) / 1000 }

function serialize (frame, now) {
  // GUI-POV-V3 §3.4: `buildMs` and `busy` are ADDITIVE header keys - the wire stays v:2 and the
  // pixel/face planes are byte-identical, so an old GUI (which deserializes unknown keys into a
  // dictionary and never reads them) is unaffected, and a new GUI guards with ContainsKey so an
  // old bot renders fine too. `busy` is OMITTED when false rather than sent as false: it is a
  // label the HUD only reacts to when present.
  const header = Object.assign({}, frame.header, {
    ageMs: Math.max(0, now - frame.builtAt),
    buildMs: Math.round(lastWallMs)
  })
  if (isBusy()) header.busy = true
  // palette last, purely for readability when curling the endpoint by hand
  const { palette } = header
  delete header.palette
  header.palette = palette
  // v2 body = header \n pixels \n faces (GUI-POV-V2 §1.2). The face plane is APPENDED, never
  // interleaved, so an old GUI's `body.Substring(nl+1)` + `[0, 2*w*h)` pixel loop still reads a
  // complete, correct v1 pixel line and simply never looks at the rest.
  return JSON.stringify(header) + '\n' + frame.data + '\n' + (frame.faces || '')
}

let cache = null // last COMPLETE frame; survives errors so we always have something to serve
let building = false // exactly one build in flight, ever
let waiters = []
// GUI-POV-V3 §3.2: wall-clock of the most recent COMPLETED build; 0 until the first one finishes.
// This is the whole BUSY signal - no other state is consulted.
let lastWallMs = 0
let buildStartTs = 0 // stamped when `building` flips true

function isBusy () { return lastWallMs > BUSY_WALL_MS }

const BUSY = JSON.stringify({ ok: false, reason: 'pov busy' })
const ERR = JSON.stringify({ ok: false, reason: 'pov error' })

// cb(bodyString), invoked EXACTLY ONCE per call - bot/index.js's /pov route (line ~2500) depends
// on that and is otherwise untouched by v3.
//
// Serves the cache inside its (now adaptive) TTL; otherwise starts the one permitted build.
// GUI-POV-V3 §1.1(4) fixed here: previously the request that STARTED a build only got its callback
// from `finish`, so under congestion that one response RODE the whole multi-second build, blew the
// GUI's 1000 ms /pov budget and was discarded. While BUSY we now serve-stale-while-revalidate:
// answer instantly from the stale cache and let the rebuild proceed in the background. The only
// caller that may still legitimately wait is one with NO cache at all (the very first frame), and
// in FAST mode - where the wait is ~40 ms, 25x under the GUI timeout, and a fresh frame is
// strictly crisper than a 250 ms-old one.
function requestFrame (bot, cb) {
  const now = Date.now()
  // §3.3: the TTL is the only thing BUSY mode changes about admission - build attempts drop to
  // <=1/s exactly when the body needs the loop.
  const ttl = isBusy() ? TTL_BUSY_MS : CACHE_TTL_MS
  if (cache && now - cache.builtAt < ttl) return cb(serialize(cache, now))
  if (building) {
    if (cache) return cb(serialize(cache, now))
    if (waiters.length < MAX_WAITERS) { waiters.push(cb); return }
    return cb(BUSY) // not a frame: the GUI treats an unparseable header as "no signal" for a tick
  }

  building = true
  buildStartTs = now
  // Serve-stale-while-revalidate. `primary` is the requester still owed a response by `finish`;
  // in the BUSY branch we discharge the obligation NOW and null it so `finish` cannot double-fire.
  let primary = cb
  if (cache && isBusy()) {
    primary = null
    cb(serialize(cache, now))
  }
  let settled = false
  const finish = frame => {
    if (settled) return
    settled = true
    building = false
    const t = Date.now()
    // §3.2: the mode is re-evaluated on EVERY completed build, so BUSY cannot stick - one fast
    // build (~40 ms) restores FAST immediately. Measured even on a failed build: a build that
    // took seconds to fail is still evidence the loop is congested.
    lastWallMs = t - buildStartTs
    if (frame) cache = frame
    const body = cache ? serialize(cache, t) : ERR
    const parked = waiters; waiters = []
    if (primary) { const p = primary; primary = null; p(body) }
    for (const w of parked) w(body)
  }
  // A throw here (dimension change mid-frame, a chunk impl we did not expect) must degrade to the
  // last good frame, never take the process down - same guard discipline as /state.
  try {
    computeFrame(bot, frame => { try { finish(frame) } catch { finish(null) } })
  } catch {
    finish(null)
  }
}

// `computeFrame` and the __test hook exist only so povtest.js can pin GUI-POV-V3 §7's cases
// (hop ceiling around a raw build; the requestFrame state machine, which needs the module's
// cache/BUSY state reset between cases instead of sleeping out a 1000 ms BUSY TTL). Nothing in
// the bot may use them; the live surface is still requestFrame alone.
function __test (op) {
  if (op === 'reset') { cache = null; building = false; waiters = []; lastWallMs = 0; buildStartTs = 0; return }
  if (op === 'state') return { hasCache: !!cache, building, lastWallMs, busy: isBusy(), waiters: waiters.length }
}

module.exports = {
  requestFrame,
  computeFrame,
  rayDir,
  dda,
  encodeFrame,
  W,
  H,
  MAX_DIST,
  ALPHABET,
  SLICE_MS,
  CACHE_TTL_MS,
  BUSY_WALL_MS,
  TTL_BUSY_MS,
  __test
}
