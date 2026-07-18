'use strict'
// OFFLINE unit test for the pure POV core (bot/pov.js): camera math, DDA traversal and the wire
// encoding, all driven by synthetic `sample` callbacks. No bot, no server, no I/O.
// The last test drives computeFrame against a fake bot to prove the frame really is SLICED
// (more than one event-loop turn) and really does respect the step budget - the whole point of
// the design, since this code shares the live bot's loop.
// Run:  cd bot && node povtest.js

const assert = require('assert')
const P = require('./pov.js')

let failures = 0
function t (name, fn) { try { fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) } }
function finish () { console.log(failures ? `\n${failures} FAILURE(S)` : '\nall POV tests passed'); process.exit(failures ? 1 : 0) }

const FOV = 70 * Math.PI / 180
// GUI-POV-V2 §1.3 bumped the frame to 128x72, so nothing below may hardcode 80/45/7200: every
// dimension is derived from the module's own W/H.
const W = P.W
const H = P.H
// a flat stone floor filling everything below y=64
const floor64 = (x, y, z) => (y < 64 ? 'stone' : 0)
const empty = () => 0

// ---- (e) camera math -------------------------------------------------------

t('rayDir: centre pixel ~= the forward vector', () => {
  const yaw = 1.1; const pitch = -0.3
  const d = P.rayDir(W / 2 - 0.5, H / 2 - 0.5, W, H, FOV, yaw, pitch) // exact centre: col+0.5 = w/2, row+0.5 = h/2
  const cp = Math.cos(pitch)
  assert(Math.abs(d.x - (-Math.sin(yaw) * cp)) < 1e-9, 'x ' + d.x)
  assert(Math.abs(d.y - Math.sin(pitch)) < 1e-9, 'y ' + d.y)
  assert(Math.abs(d.z - (-Math.cos(yaw) * cp)) < 1e-9, 'z ' + d.z)
})

t('rayDir: left and right edge rays are ~70 deg apart (the horizontal FOV)', () => {
  const a = P.rayDir(0, H / 2, W, H, FOV, 0, 0)
  const b = P.rayDir(W - 1, H / 2, W, H, FOV, 0, 0)
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  const deg = Math.acos(dot) * 180 / Math.PI
  assert(deg > 68 && deg < 70, 'edge-to-edge angle ' + deg.toFixed(2)) // pixel centres -> just under 70
})

t('rayDir: all rays are unit length, even looking straight up (the degenerate cross product)', () => {
  for (const pitch of [0, 1.2, Math.PI / 2, -Math.PI / 2]) {
    for (const [c, r] of [[0, 0], [W - 1, H - 1], [W >> 1, H >> 1]]) {
      const d = P.rayDir(c, r, W, H, FOV, 0.7, pitch)
      assert(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9, `pitch ${pitch} px ${c},${r}`)
    }
  }
})

// ---- (a)(b)(c) DDA ---------------------------------------------------------

t('(a) a ray straight down into a flat floor returns the floor token at the right distance', () => {
  const hit = P.dda({ x: 8.5, y: 70.0, z: 8.5 }, { x: 0, y: -1, z: 0 }, 32, 96, floor64)
  assert(hit, 'expected a hit')
  assert.strictEqual(hit.token, 'stone')
  assert(Math.abs(hit.dist - 6) < 1e-9, 'dist ' + hit.dist) // eye 70 -> enters y=63 after 6 blocks
})

t('(a2) a slanted ray into the floor hits farther away than a vertical one', () => {
  const down = P.dda({ x: 8.5, y: 70, z: 8.5 }, { x: 0, y: -1, z: 0 }, 64, 96, floor64)
  const slant = P.dda({ x: 8.5, y: 70, z: 8.5 }, { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 }, 64, 96, floor64)
  assert(slant && slant.token === 'stone')
  assert(slant.dist > down.dist, `${slant.dist} !> ${down.dist}`)
  assert(Math.abs(slant.dist - 6 * Math.SQRT2) < 1e-9, 'dist ' + slant.dist)
})

t('(b) a ray into empty space returns null (sky)', () => {
  assert.strictEqual(P.dda({ x: 0.5, y: 70, z: 0.5 }, { x: 0, y: 1, z: 0 }, 32, 96, empty), null)
  // and upward over a floor world, too
  assert.strictEqual(P.dda({ x: 0.5, y: 70, z: 0.5 }, { x: 0, y: 1, z: 0 }, 32, 96, floor64), null)
})

t('(b2) a hit beyond maxDist is not a hit', () => {
  // floor is 6 blocks down; a 4-block range must not see it
  assert.strictEqual(P.dda({ x: 8.5, y: 70, z: 8.5 }, { x: 0, y: -1, z: 0 }, 4, 96, floor64), null)
})

t('(b3) sample returning null (unloaded chunk) ends the ray as sky', () => {
  const sample = (x, y, z) => (x >= 3 ? null : 0)
  assert.strictEqual(P.dda({ x: 0.5, y: 70, z: 0.5 }, { x: 1, y: 0, z: 0 }, 32, 96, sample), null)
})

t('(c) DDA hits the FIRST solid voxel, not a later one', () => {
  const seen = []
  const sample = (x, y, z) => { seen.push(x); return (x === 5 ? 'near' : (x === 9 ? 'far' : 0)) }
  const hit = P.dda({ x: 0.5, y: 70.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 32, 96, sample)
  assert.strictEqual(hit.token, 'near')
  assert(Math.abs(hit.dist - 4.5) < 1e-9, 'dist ' + hit.dist) // x=0.5 -> plane x=5
  assert.strictEqual(Math.max(...seen), 5, 'walked past the first hit: ' + seen.join(','))
})

t('(c2) DDA does not skip corner voxels a 0.25-step sampler would miss', () => {
  // one lone voxel sitting exactly on the diagonal; a coarse sampler can step over it
  const sample = (x, y, z) => (x === 3 && z === 3 ? 'corner' : 0)
  const hit = P.dda({ x: 0.5, y: 70.5, z: 0.5 }, { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }, 32, 96, sample)
  assert(hit && hit.token === 'corner', 'missed the diagonal voxel')
})

t('(c3) maxSteps caps the walk', () => {
  let calls = 0
  const sample = () => { calls++; return 0 }
  P.dda({ x: 0.5, y: 70.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 1e9, 96, sample)
  assert.strictEqual(calls, 96)
})

// ---- (i) face: the axis stepped to ENTER the hit voxel (GUI-POV-V2 §1.1) ----
// The whole legibility fix hangs on this being the ENTRY face and not the axis the DDA would
// step NEXT - an off-by-one there inverts the shading (floors would render as dim side faces).

t('(i) straight down into a floor -> face 0 (top)', () => {
  const hit = P.dda({ x: 8.5, y: 70, z: 8.5 }, { x: 0, y: -1, z: 0 }, 32, 96, floor64)
  assert.strictEqual(hit.face, 0)
})

t('(i2) straight up into a ceiling -> face 1 (bottom)', () => {
  const ceiling = (x, y, z) => (y >= 70 ? 'stone' : 0)
  const hit = P.dda({ x: 8.5, y: 65.5, z: 8.5 }, { x: 0, y: 1, z: 0 }, 32, 96, ceiling)
  assert(hit && hit.token === 'stone')
  assert.strictEqual(hit.face, 1)
})

t('(i3) horizontal into an X wall -> face 2, in BOTH x directions', () => {
  const east = (x, y, z) => (x >= 5 ? 'stone' : 0)
  const west = (x, y, z) => (x <= -5 ? 'stone' : 0)
  assert.strictEqual(P.dda({ x: 0.5, y: 70.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 32, 96, east).face, 2)
  assert.strictEqual(P.dda({ x: 0.5, y: 70.5, z: 0.5 }, { x: -1, y: 0, z: 0 }, 32, 96, west).face, 2)
})

t('(i4) horizontal into a Z wall -> face 3, in BOTH z directions', () => {
  const south = (x, y, z) => (z >= 5 ? 'stone' : 0)
  const north = (x, y, z) => (z <= -5 ? 'stone' : 0)
  assert.strictEqual(P.dda({ x: 0.5, y: 70.5, z: 0.5 }, { x: 0, y: 0, z: 1 }, 32, 96, south).face, 3)
  assert.strictEqual(P.dda({ x: 0.5, y: 70.5, z: 0.5 }, { x: 0, y: 0, z: -1 }, 32, 96, north).face, 3)
})

t('(i5) the eye inside a solid voxel (no step taken) -> face 0, i.e. bright not black', () => {
  const solid = () => 'water'
  const hit = P.dda({ x: 8.5, y: 70.5, z: 8.5 }, { x: 0.4, y: -0.5, z: 0.7 }, 32, 96, solid)
  assert(hit && hit.token === 'water')
  assert.strictEqual(hit.dist, 0)
  assert.strictEqual(hit.face, 0)
})

t('(i6) the face is the ENTRY axis, not the next one the DDA would step', () => {
  // Tuned so the ray enters the wall voxel through its X face at t=2.577 while the very next
  // pending crossing is the Y one (t=2.598). Reporting "the axis with the smallest tMax now"
  // instead of the axis actually stepped would return 1 (bottom) here - the classic off-by-one.
  const wall = (x, y, z) => (x >= 3 ? 'stone' : 0)
  const d = { x: 0.9701425001453319, y: 0.24253562503633297, z: 0 } // normalize(4,1,0)
  const hit = P.dda({ x: 0.5, y: 70.37, z: 0.5 }, d, 32, 96, wall)
  assert(hit && hit.token === 'stone')
  assert.strictEqual(hit.face, 2, 'entered through the X face')
})

// ---- (d)(e) encodeFrame ----------------------------------------------------

const B64 = /^[A-Za-z0-9\-_]+$/

t('(d) encodeFrame emits exactly 2*w*h chars over the base64url alphabet', () => {
  const hits = []
  for (let i = 0; i < W * H; i++) hits.push(i % 3 === 0 ? null : { token: 'stone', dist: (i % 32), face: i % 4 })
  const { data } = P.encodeFrame(hits, W, H, 32)
  assert.strictEqual(data.length, 2 * W * H)
  assert.strictEqual(data.length, 2 * 128 * 72) // 18432 - the §1.2 line-2 length
  assert(B64.test(data), 'non-base64url char in the pixel line')
})

t('(d2) palette indices and distances round-trip', () => {
  const hits = [
    { token: 'stone', dist: 0 },
    { token: 'water', dist: 16 },
    { token: 'stone', dist: 31.9 },
    null
  ]
  const { palette, data } = P.encodeFrame(hits, 2, 2, 32)
  assert.deepStrictEqual(palette, ['stone', 'water']) // first-hit order
  const dec = i => [P.ALPHABET.indexOf(data[i * 2]), P.ALPHABET.indexOf(data[i * 2 + 1])]
  assert.deepStrictEqual(dec(0), [0, 0])
  assert.strictEqual(dec(1)[0], 1)
  assert.strictEqual(dec(1)[1], Math.floor(16 / 32 * 63)) // 31
  assert.strictEqual(dec(2)[0], 0) // 'stone' reuses index 0
  assert(Math.abs(dec(2)[1] / 63 * 32 - 31.9) < 32 / 63 + 1e-9, 'distance off by more than one quantum')
  assert.deepStrictEqual(dec(3), [63, 63])
})

t('(e) the sky sentinel is index 63 = "_"', () => {
  assert.strictEqual(P.ALPHABET.length, 64)
  assert.strictEqual(P.ALPHABET[63], '_')
  assert.strictEqual(P.ALPHABET[62], '-')
  const { palette, data } = P.encodeFrame([null], 1, 1, 32)
  assert.strictEqual(data, '__')
  assert.deepStrictEqual(palette, [])
})

t('(f) palette overflow: 70 distinct tokens -> everything past 62 collapses to index 62', () => {
  const hits = []
  for (let i = 0; i < 70; i++) hits.push({ token: 'block_' + i, dist: 1 })
  const { palette, data } = P.encodeFrame(hits, 70, 1, 32)
  assert.strictEqual(palette.length, 62)
  assert.strictEqual(palette[61], 'block_61')
  for (let i = 0; i < 62; i++) assert.strictEqual(P.ALPHABET.indexOf(data[i * 2]), i)
  for (let i = 62; i < 70; i++) assert.strictEqual(P.ALPHABET.indexOf(data[i * 2]), 62, 'ray ' + i)
  assert(!palette.includes('block_69'), '63rd+ name must not enter the palette')
})

t('(g) never emits index 63 for a real hit (63 is reserved for sky)', () => {
  const hits = []
  for (let i = 0; i < 200; i++) hits.push({ token: 'block_' + i, dist: 32 })
  const { data } = P.encodeFrame(hits, 200, 1, 32)
  for (let i = 0; i < 200; i++) {
    assert.notStrictEqual(P.ALPHABET.indexOf(data[i * 2]), 63, 'palette char 63 leaked at ' + i)
    assert.notStrictEqual(P.ALPHABET.indexOf(data[i * 2 + 1]), 63, 'distance char 63 leaked at ' + i)
  }
})

// ---- (j) the v2 face plane + v1 backward compatibility (GUI-POV-V2 §1.2) ---

t('(j) encodeFrame emits a w*h face plane, "_" for sky, ALPHABET[face] for a hit', () => {
  const hits = [
    { token: 'stone', dist: 4, face: 0 },
    { token: 'stone', dist: 4, face: 1 },
    null,
    { token: 'stone', dist: 4, face: 2 },
    { token: 'stone', dist: 4, face: 3 },
    { token: 'stone', dist: 4 } // no face at all -> 0 (top, multiplier 1.0 = today's flat look)
  ]
  const { data, faces } = P.encodeFrame(hits, 6, 1, 32)
  assert.strictEqual(faces.length, 6)
  assert.strictEqual(data.length, 12)
  assert.strictEqual(faces, 'AB_CDA')
})

t('(j2) face chars are never outside 0..3 or the sky sentinel for real DDA output', () => {
  // drive the real dda over a floor world across the whole frame and check the encoded plane
  const hits = []
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      hits.push(P.dda({ x: 8.5, y: 70, z: 8.5 }, P.rayDir(col, row, W, H, FOV, 0.4, -0.2), 32, 96, floor64))
    }
  }
  const { faces } = P.encodeFrame(hits, W, H, 32)
  assert.strictEqual(faces.length, W * H)
  for (let i = 0; i < faces.length; i++) {
    assert('ABCD_'.indexOf(faces[i]) >= 0, 'unexpected face char ' + faces[i] + ' at ' + i)
  }
  assert(faces.indexOf('A') >= 0, 'a floor frame must contain top faces')
})

// THE compatibility property. §1.2 chose a third line over bit-packing precisely so the SHIPPED
// (v1) GUI keeps working against a v2 bot: its DecodeFrame takes everything after the FIRST '\n'
// and then its pixel loop reads only indices [0, 2*w*h). We reproduce that parse here verbatim
// and assert what it sees is a complete, valid v1 pixel line - untouched by the face plane.
t('(j3) v1/v2 compat: the OLD GUI parse still reads a valid v1 pixel line out of a v2 body', () => {
  const hits = []
  for (let i = 0; i < W * H; i++) hits.push(i % 5 === 0 ? null : { token: 'blk_' + (i % 7), dist: (i % 32), face: i % 4 })
  const { palette, data, faces } = P.encodeFrame(hits, W, H, 32)
  const header = JSON.stringify({ v: 2, w: W, h: H, fovH: 70, maxDist: 32, palette })
  const body = header + '\n' + data + '\n' + faces

  // --- the old GUI's parse, step for step ---
  const nl = body.indexOf('\n')
  const oldData = body.substring(nl + 1).trim() // interior '\n' retained, as in the shipped decoder
  assert(oldData.length >= 2 * W * H, 'old GUI would reject this as a short frame')
  const oldPixels = oldData.substring(0, 2 * W * H) // its loop bound - it never reads past this
  assert.strictEqual(oldPixels, data, 'the v1 pixel span is not byte-identical to the v1 encoding')
  assert(B64.test(oldPixels), 'the old GUI would read a non-base64url char')
  assert.strictEqual(oldPixels.indexOf('\n'), -1, 'a newline leaked inside the v1 pixel span')
  assert.strictEqual(oldData[2 * W * H], '\n', 'the separator must sit exactly at 2*w*h')
  assert.strictEqual(oldData.length, 3 * W * H + 1, 'v2 body tail must be 3*w*h + 1 chars')
})

t('(j4) the §1.2 new-GUI parse rule handles both a v2 body and a v1 (no "v") body', () => {
  // A faithful JS mirror of the C# rule in §1.2 - it must yield faces for v2 and fall back to the
  // flat v1 path (no faces, no "bad frame") for a header with no "v".
  function parse (body) {
    const nl = body.indexOf('\n')
    const head = JSON.parse(body.substring(0, nl))
    const v = Object.prototype.hasOwnProperty.call(head, 'v') ? head.v : 1
    const rest = body.substring(nl + 1)
    const n = head.w * head.h
    if (v >= 2 && rest.length >= 3 * n + 1 && rest[2 * n] === '\n') {
      return { v, head, pixels: rest.substring(0, 2 * n), faces: rest.substring(2 * n + 1, 2 * n + 1 + n) }
    }
    assert(rest.length >= 2 * n, 'v1 frame too short')
    return { v, head, pixels: rest.substring(0, 2 * n), faces: null }
  }

  const hits = [{ token: 'stone', dist: 8, face: 2 }, null, { token: 'dirt', dist: 3, face: 0 }, { token: 'dirt', dist: 3, face: 3 }]
  const { palette, data, faces } = P.encodeFrame(hits, 2, 2, 32)

  const v2 = parse(JSON.stringify({ v: 2, w: 2, h: 2, palette }) + '\n' + data + '\n' + faces)
  assert.strictEqual(v2.v, 2)
  assert.strictEqual(v2.pixels, data)
  assert.strictEqual(v2.faces, 'C_AD')

  const v1 = parse(JSON.stringify({ w: 2, h: 2, palette }) + '\n' + data) // old bot: no "v", 2 lines
  assert.strictEqual(v1.v, 1)
  assert.strictEqual(v1.pixels, data)
  assert.strictEqual(v1.faces, null) // -> multiplier 1.0 everywhere, exactly today's flat render

  // v>=2 but a truncated/missing face plane must degrade to the v1 path, never throw ("belt and
  // suspenders", §1.2).
  const short = parse(JSON.stringify({ v: 2, w: 2, h: 2, palette }) + '\n' + data + '\n' + faces.slice(0, 2))
  assert.strictEqual(short.faces, null)
  assert.strictEqual(short.pixels, data)
})

// ---- (h) the bounded smoke: computeFrame against a fake bot -----------------
// Proves the three properties that keep the live bot alive: it completes, it SLICES across
// event-loop turns, and it stops sampling once the step budget is gone.

function fakeBot (opts) {
  const col = { getBlockStateId: p => (p.y < 64 ? 1 : 0) } // 1 = stone, 0 = air
  return {
    entity: { position: { x: 8.5, y: 70, z: 8.5 }, yaw: 0.4, pitch: -0.2 },
    game: { minY: -64, height: 384, dimension: 'minecraft:overworld' },
    time: { timeOfDay: 1000 },
    registry: { blocksByStateId: { 0: { name: 'air' }, 1: { name: 'stone' } } },
    world: { getColumn: () => (opts && opts.unloaded ? null : col) }
  }
}

function step (name, fn) { steps.push({ name, fn }) }
const steps = []
function runSteps () {
  const s = steps.shift()
  if (!s) return finish()
  s.fn(ok => {
    if (ok === true) console.log('PASS  ' + s.name)
    else { failures++; console.log('FAIL  ' + s.name + '\n      ' + ok) }
    // The module frame cache has a 250 ms TTL and allows only one build in flight, so the
    // async steps MUST run strictly one after another with the TTL elapsed between them -
    // otherwise a later step is silently served the earlier step's frame.
    setTimeout(runSteps, 300)
  })
}

step('(h) computeFrame completes, yields across many event-loop turns, and is well-formed', done => {
  const bot = fakeBot()
  // count event-loop turns for the lifetime of the build
  let turns = 0
  const tick = () => { turns++; if (!finished) setImmediate(tick) }
  let finished = false
  setImmediate(tick)

  const t0 = Date.now()
  P.requestFrame(bot, body => {
    finished = true
    try {
      const parts = body.split('\n')
      assert.strictEqual(parts.length, 3, 'v2 body must be exactly three lines, got ' + parts.length)
      const header = JSON.parse(parts[0])
      const data = parts[1]
      const faces = parts[2]
      assert.strictEqual(header.v, 2) // GUI-POV-V2 §1.2
      assert.strictEqual(header.w, W)
      assert.strictEqual(header.h, H)
      assert.strictEqual(header.w, 128) // §1.3 pins the actual numbers, not just self-consistency
      assert.strictEqual(header.h, 72)
      assert.strictEqual(header.fovH, 70)
      assert.strictEqual(header.maxDist, 32)
      assert.strictEqual(header.dim, 'overworld') // "minecraft:" stripped
      assert.strictEqual(header.day, true)
      assert(header.ageMs >= 0 && header.ageMs < 5000, 'ageMs ' + header.ageMs)
      assert.deepStrictEqual(header.palette, ['stone'])
      assert.strictEqual(data.length, 2 * W * H)
      assert.strictEqual(faces.length, W * H)
      assert(B64.test(data), 'non-base64url pixel data')
      assert(B64.test(faces), 'non-base64url face plane')
      // looking slightly DOWN over a floor: the bottom rows must be ground, the top rows sky
      const px = (c, r) => data.slice((r * W + c) * 2, (r * W + c) * 2 + 2)
      const fc = (c, r) => faces[r * W + c]
      assert.strictEqual(px(W >> 1, H - 1)[0], 'A', 'bottom-centre ray should hit the floor (palette 0)')
      assert.strictEqual(px(W >> 1, 0), '__', 'top-centre ray should be sky')
      // a flat floor seen from above is entered through its TOP face (§1.1 face 0 = 'A')
      assert.strictEqual(fc(W >> 1, H - 1), 'A', 'floor must encode as face 0 (top)')
      assert.strictEqual(fc(W >> 1, 0), '_', 'sky must be "_" in the face plane too')
      // the two planes must agree ray-for-ray on what is sky: a mismatch would shade holes in the
      // sky (or leave a lit surface unshaded) once the GUI multiplies the two together.
      for (let i = 0; i < W * H; i++) {
        assert.strictEqual(data.slice(i * 2, i * 2 + 2) === '__', faces[i] === '_', 'plane mismatch at ray ' + i)
      }
      // GUI-POV-V3 §2.1 amended this bound. It used to read `turns > 3`, which was really an
      // assertion about the deleted SLICE_ROWS = 4 cap (18 hops/frame). Bail-driven slicing makes
      // the hop count ceil(CPU / SLICE_MS) ~ 3, so the property worth pinning here is only "it
      // still yields the loop at all"; the exact ceiling is pinned by (h4), and the fact that an
      // EXPENSIVE frame still spans several turns by (h4b). A cheap synthetic frame may now
      // legitimately complete in a single 8 ms hop, so >1 here would be a flake.
      assert(turns >= 1, 'frame did not slice - only ' + turns + ' event-loop turn(s)')
      assert(Date.now() - t0 < 5000, 'frame took too long')
      done(true)
    } catch (e) { finished = true; done(e.message) }
  })
})

step('(h2) an unloaded world degrades to a full sky frame instead of throwing', done => {
  P.requestFrame(fakeBot({ unloaded: true }), body => {
    try {
      const parts = body.split('\n')
      assert.strictEqual(parts.length, 3)
      assert.strictEqual(parts[1].length, 2 * W * H)
      assert.strictEqual(parts[2].length, W * H)
      assert.strictEqual(parts[1].replace(/_/g, ''), '', 'unloaded world must render as all sky')
      assert.strictEqual(parts[2].replace(/_/g, ''), '', 'sky rays carry no face')
      done(true)
    } catch (e) { done(e.message) }
  })
})

step('(h3) two requests inside the 250 ms TTL share one build (the cache holds)', done => {
  const bot = fakeBot()
  let firstBody = null
  P.requestFrame(bot, a => {
    firstBody = a
    // move the bot: if the cache is honoured the second frame must be byte-identical below the
    // header, i.e. the world was NOT re-traced.
    bot.entity.yaw = 3.0
    P.requestFrame(bot, b => {
      try {
        assert.strictEqual(b.slice(b.indexOf('\n') + 1), firstBody.slice(firstBody.indexOf('\n') + 1), 'cached frame was recomputed')
        assert.strictEqual(JSON.parse(b.slice(0, b.indexOf('\n'))).yaw, 0.4, 'header must come from the cached frame')
        done(true)
      } catch (e) { done(e.message) }
    })
  })
})

// ---- GUI-POV-V3: bail-driven slicing, serve-stale-while-revalidate, BUSY mode ----------------
// Three properties, in the order §7 lists them. The first is the SAFETY number (the 8 ms bail is
// the whole reason this panel is allowed to share the bot's loop); the second is the latency
// defect §1.1(4) identified; the third is the load-shedding that keeps the body first.

// Counts event-loop hops and times each one, by shimming setImmediate for the duration of ONE
// computeFrame. `delayMs` (used by the BUSY cases) defers every hop, which is exactly the §1.1
// congestion mechanism - wall = CPU + hops x queue-wait - without burning any extra CPU, and far
// more deterministic than busy-waiting inside `sample`.
function instrumented (bot, delayMs, done) {
  const realSI = global.setImmediate
  const hops = []
  let hopCount = 0
  global.setImmediate = fn => realSI(() => {
    const sched = () => {
      const a = process.hrtime.bigint()
      hopCount++
      // finally, not after fn(): the LAST hop calls done() synchronously from inside fn, and the
      // final turn is a legitimate candidate for the worst-turn number.
      try { fn() } finally { hops.push(Number(process.hrtime.bigint() - a) / 1e6) }
    }
    if (delayMs) setTimeout(sched, delayMs); else sched()
  })
  const t0 = process.hrtime.bigint()
  let out = null
  P.computeFrame(bot, frame => { out = { frame, totalMs: Number(process.hrtime.bigint() - t0) / 1e6 } })
  // Report on a later real turn so the last hop's timing has been recorded.
  const settle = () => {
    if (!out) return realSI(settle)
    global.setImmediate = realSI
    done({ frame: out.frame, totalMs: out.totalMs, hops: hopCount, worstTurnMs: Math.max(...hops), turns: hops })
  }
  realSI(settle)
}

step('(h4) V3 §2.1: slicing is bail-driven - few hops, every turn inside the 8 ms bail', done => {
  P.__test('reset')
  const bot = fakeBot()
  instrumented(bot, 0, r => {
    try {
      console.log(`      hops=${r.hops}  total=${r.totalMs.toFixed(2)}ms  worstTurn=${r.worstTurnMs.toFixed(2)}ms  turns=[${r.turns.map(x => x.toFixed(2)).join(', ')}]`)
      // §2.2: ceil(frameCPU / SLICE_MS) - ~4 synthetic, ~5 projected live, vs 18+ under the old
      // row cap. 8 is the ceiling §7 asks for. Deliberately NOT a lower bound of 2: the hop count
      // is now purely CPU-driven, and this trivial synthetic scene legitimately finishes inside a
      // single 8 ms window once the JIT and the stateId memo are warm (it flaked as `> 1`). The
      // invariant that matters at the low end is that computeFrame is never SYNCHRONOUS - it
      // always hands the loop back at least once - which >= 1 pins; that an EXPENSIVE frame still
      // splits is pinned separately below.
      assert(r.hops >= 1, 'computeFrame ran synchronously - it must yield the loop')
      assert(r.hops <= 8, 'hop count regressed to ' + r.hops + ' - the row cap is back?')
      // THE SAFETY NUMBER (§1.2, §6). The bail is checked after every row, so the worst
      // synchronous burst is SLICE_MS + one row's overshoot (~1.3 ms worst measured basis). If
      // this ever fails, the loop guarantee is broken and the bot's body is at risk.
      assert(r.worstTurnMs <= P.SLICE_MS + 2,
        `worst turn ${r.worstTurnMs.toFixed(2)}ms exceeds the ${P.SLICE_MS}ms bail + one row`)

      // ...and the frame is still COMPLETE and identical to the un-sliced expectation: dropping
      // the row cap must change scheduling only, never a pixel.
      const hits = []
      const eye = { x: 8.5, y: 70 + 1.62, z: 8.5 }
      for (let row = 0; row < H; row++) {
        for (let col = 0; col < W; col++) {
          hits.push(P.dda(eye, P.rayDir(col, row, W, H, FOV, 0.4, -0.2), 32, 96, floor64))
        }
      }
      const expect = P.encodeFrame(hits, W, H, 32)
      assert.strictEqual(r.frame.data, expect.data, 'sliced pixel plane differs from the un-sliced trace')
      assert.strictEqual(r.frame.faces, expect.faces, 'sliced face plane differs from the un-sliced trace')
      done(true)
    } catch (e) { done(e.message) }
  })
})

step('(h4b) V3 §2.1: an EXPENSIVE frame still splits, and every turn still respects the bail', done => {
  P.__test('reset')
  // The worst realistic scene for the DDA: nothing but air, so every one of the 9216 rays walks
  // the full MAX_STEPS/MAX_DIST instead of terminating on a floor. This is what proves the bail
  // (not a row cap) is what bounds a slice - and that the bound holds when the frame is dear.
  const bot = fakeBot()
  bot.world.getColumn = () => ({ getBlockStateId: () => 0 })
  instrumented(bot, 0, r => {
    try {
      console.log(`      expensive: hops=${r.hops}  total=${r.totalMs.toFixed(2)}ms  worstTurn=${r.worstTurnMs.toFixed(2)}ms`)
      assert(r.hops > 1, 'an expensive frame must span several turns, got ' + r.hops)
      assert(r.hops <= 16, 'hop count ' + r.hops + ' - far above ceil(CPU/8)')
      // The safety number again, where it counts. Same bound: SLICE_MS + one row's overshoot.
      assert(r.worstTurnMs <= P.SLICE_MS + 2,
        `worst turn ${r.worstTurnMs.toFixed(2)}ms exceeds the ${P.SLICE_MS}ms bail + one row`)
      assert.strictEqual(r.frame.data.replace(/_/g, ''), '', 'an all-air world must render as sky')
      done(true)
    } catch (e) { done(e.message) }
  })
})

// The state machine, §3.3 / §7(2). One chain: a slow build lights BUSY, the next stale request is
// served the OLD frame PROMPTLY instead of riding the build, and one fast build restores FAST.
step('(h5) V3 §3.3: a request during an in-flight build gets the stale frame promptly, not the build', done => {
  P.__test('reset')
  const bot = fakeBot()
  const fired = [] // every cb in this case is pushed here exactly once (§6 double-fire risk)

  // --- 1. a SLOW build (hops deferred 150 ms each => wall > BUSY_WALL_MS) lights BUSY.
  const realSI = global.setImmediate
  global.setImmediate = fn => realSI(() => setTimeout(fn, 150))
  const slowStart = Date.now()
  P.requestFrame(bot, body => {
    fired.push('slow')
    global.setImmediate = realSI
    try {
      const slowWall = Date.now() - slowStart
      assert(slowWall > P.BUSY_WALL_MS, `the slow build only took ${slowWall}ms - cannot exercise BUSY`)
      const h = JSON.parse(body.slice(0, body.indexOf('\n')))
      // §3.4 header keys. `busy` is stamped at SERVE time, and this frame is served from `finish`
      // right after lastWallMs was updated, so it already carries the mode it just measured.
      assert(typeof h.buildMs === 'number', 'header must always carry buildMs')
      assert(h.buildMs > P.BUSY_WALL_MS, 'buildMs ' + h.buildMs + ' should reflect the slow wall')
      assert.strictEqual(h.busy, true, 'a >250ms build must light busy')
      assert.strictEqual(P.__test('state').busy, true)
    } catch (e) { global.setImmediate = realSI; return done(e.message) }

    // --- 2. let the BUSY TTL lapse, then request again with the SAME slow scheduling. The old
    // code would have parked this caller on a multi-second build and blown the GUI's 1000 ms
    // budget; serve-stale must answer it before the build even starts running rows.
    setTimeout(() => {
      bot.entity.yaw = 3.0 // so a stale answer is distinguishable from a fresh one by its header
      const staleAgeFloor = Date.now() - P.TTL_BUSY_MS
      global.setImmediate = fn => realSI(() => setTimeout(fn, 150))
      let returnedSynchronously = false
      const t0 = Date.now()
      P.requestFrame(bot, body2 => {
        fired.push('stale')
        returnedSynchronously = true
        const dt = Date.now() - t0
        try {
          const h2 = JSON.parse(body2.slice(0, body2.indexOf('\n')))
          // PROMPTLY: the whole point. Not "eventually" - before any slice ran.
          assert(dt < 50, `serve-stale took ${dt}ms - the request rode the build`)
          assert.strictEqual(h2.yaw, 0.4, 'must be the STALE frame (old pose), not a fresh trace')
          assert(h2.ageMs >= P.TTL_BUSY_MS - 50, 'stale frame should be ~TTL_BUSY old, got ' + h2.ageMs)
          assert(h2.ageMs <= Date.now() - staleAgeFloor + 200, 'implausible ageMs ' + h2.ageMs)
          assert.strictEqual(h2.busy, true, 'still BUSY while serving stale')
        } catch (e) { return done(e.message) }
      })
      if (!returnedSynchronously) { global.setImmediate = realSI; return done('serve-stale did not answer synchronously') }
      // ...and the revalidation really is in flight behind it (§3.3: request-driven, so the
      // polled-only property holds - no timer ever starts a build).
      const st = P.__test('state')
      if (!st.building) { global.setImmediate = realSI; return done('serve-stale did not start a background rebuild') }

      // --- 3. wait out that background slow build, then prove ONE fast build restores FAST.
      const waitIdle = () => {
        if (P.__test('state').building) return setTimeout(waitIdle, 25)
        global.setImmediate = realSI // congestion over: the next build runs at full speed
        setTimeout(() => {
          P.requestFrame(bot, () => { fired.push('revalidate') }) // BUSY: serves stale, rebuilds fast
          const waitFast = () => {
            if (P.__test('state').building) return setTimeout(waitFast, 10)
            try {
              const st2 = P.__test('state')
              assert(st2.lastWallMs <= P.BUSY_WALL_MS, 'a fast build left lastWallMs at ' + st2.lastWallMs)
              assert.strictEqual(st2.busy, false, 'BUSY must not stick after one fast build (§3.2)')
              // FAST mode restored => the next stale request PARKS for a fresh frame (§3.3).
              setTimeout(() => {
                bot.entity.yaw = 1.25
                let sync = true
                P.requestFrame(bot, body4 => {
                  fired.push('fast')
                  try {
                    assert.strictEqual(sync, false, 'FAST mode must park the requester, not serve stale')
                    const h4 = JSON.parse(body4.slice(0, body4.indexOf('\n')))
                    assert.strictEqual(h4.yaw, 1.25, 'FAST mode must deliver the FRESH frame')
                    assert.strictEqual(h4.busy, undefined, 'busy must be OMITTED when not busy (§3.4)')
                    assert(typeof h4.buildMs === 'number', 'buildMs is always present')
                    assert.deepStrictEqual(fired, ['slow', 'stale', 'revalidate', 'fast'],
                      'every cb must fire exactly once, in order: ' + fired.join(','))
                    done(true)
                  } catch (e) { done(e.message) }
                })
                sync = false
              }, P.CACHE_TTL_MS + 50)
            } catch (e) { done(e.message) }
          }
          waitFast()
        }, P.TTL_BUSY_MS + 50)
      }
      waitIdle()
    }, P.TTL_BUSY_MS + 50)
  })
})

step('(h6) V3 §3.4: buildMs/busy are ADDITIVE - a v2 parser that ignores them still decodes', done => {
  P.__test('reset')
  P.requestFrame(fakeBot(), body => {
    try {
      // The §1.2 v2 parse, verbatim in spirit: it knows nothing about buildMs/busy and must be
      // completely unaffected by them (this is the old-GUI compat guarantee, §3.4).
      const nl = body.indexOf('\n')
      const head = JSON.parse(body.substring(0, nl))
      const rest = body.substring(nl + 1)
      const n = head.w * head.h
      assert.strictEqual(head.v, 2, 'v3 must NOT bump the wire version')
      assert(typeof head.buildMs === 'number', 'buildMs missing')
      assert.strictEqual(head.busy, undefined, 'a fast synthetic build must not be busy')
      assert(rest.length >= 3 * n + 1 && rest[2 * n] === '\n', 'v2 plane layout changed')
      assert.strictEqual(rest.substring(0, 2 * n).length, 2 * n)
      assert.strictEqual(rest.substring(2 * n + 1).length, n)
      assert(B64.test(rest.substring(0, 2 * n)), 'pixel plane not byte-clean')
      // And the keys really are additive: dropping them leaves exactly the v2 header set.
      const known = ['v', 'w', 'h', 'fovH', 'maxDist', 'pos', 'yaw', 'pitch', 'dim', 'day', 'ageMs', 'palette']
      const extra = Object.keys(head).filter(k => !known.includes(k))
      assert.deepStrictEqual(extra, ['buildMs'], 'unexpected new header keys: ' + extra.join(','))
      done(true)
    } catch (e) { done(e.message) }
  })
})

runSteps()
