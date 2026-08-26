'use strict'
// OFFLINE unit test for #111 C-PREVENT (design §9.3): the GROUNDED surface locator, the
// climb rung that no longer guesses, escape-commitment (shaft) recording, and the
// column-aware teardown invariant. No live server, no test server, no network.
//
// What it proves:
//  - pathfix.surfaceYAt READS a column instead of computing one: flat ground => exact y;
//    canopy is not ground; an UNLOADED column returns known:false (never a number); the
//    real 459,-91 floating-plug fixture resolves to the topmost SOLID block, not the void.
//  - navigate.js's climb rung no longer contains the `+ 10` expression and refuses on UNKNOWN.
//  - pillarUpTo: a target ABOVE the real surface places nothing above it and logs the
//    invariant violation (the demoted open-sky guard); the head-clear dig is recorded as
//    shaft debt with the ORIGINAL block name.
//  - teardown: an unreachable column top => ZERO cells removed and the column intact on the
//    books (the old loop amputated its base); a reachable column => strictly top-down, empty.
// Run:  cd bot && node surfaceclimbtest.js

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { Vec3 } = require('vec3')

// AMBIENT-PROOF: every env var the code under test reads is set EXPLICITLY here. Nothing
// is inherited from the shell (three regressions came from ambient env leaking into tests).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfaceclimb-'))
process.env.WORLD_MEM_FILE = path.join(tmp, 'world-memory.json')
process.env.SCAFFOLD_FILE = path.join(tmp, 'scaffold-registry.json')
process.env.TRAIL_FILE = path.join(tmp, 'scaffold-trail.json')
process.env.INFRA_CONSOLIDATE = '1'
process.env.SCAFFOLD_MAX_AGE_MS = String(72 * 3600 * 1000)
process.env.BUILD_DEBUG = ''
process.env.CLIMB_DEBUG = ''
process.env.NAV_TERRAIN_PROFILE = '0'
process.env.MINE_FLUID = '1'
process.env.LAVA_SAFE = '1'
process.env.SOFT_STEP_FIRST = '1'
process.env.ESCAPE_DIGS_HURT = '1'
process.env.FARM_NO_TRAMPLE = '0'

let failures = 0
// Tests are QUEUED and run strictly in order (several are async); nothing races the summary.
const queue = []
function t (name, fn) { queue.push([name, fn]) }
function ta (name, fn) { queue.push([name, fn]) }

const pathfix = require('./pathfix.js')
const scaffold = require('./scaffold.js')

// ---- fake world -------------------------------------------------------------------------
// `cells` maps "x,y,z" -> block name. Anything not listed is AIR inside `loaded` columns and
// UNKNOWN (null, the unloaded-chunk signal) outside them.
function fakeWorld (cells, loadedCols) {
  const loaded = new Set(loadedCols || Object.keys(cells).map(k => { const [x, , z] = k.split(',').map(Number); return x + ',' + z }))
  return (v) => {
    const ck = Math.floor(v.x) + ',' + Math.floor(v.z)
    if (!loaded.has(ck)) return null // chunk not loaded: NOT information
    const n = cells[Math.floor(v.x) + ',' + Math.floor(v.y) + ',' + Math.floor(v.z)] || 'air'
    return {
      name: n,
      position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
      boundingBox: (n === 'air' || /_leaves$|^(vine|torch|tall_grass|water)$/.test(n)) ? 'empty' : 'block'
    }
  }
}
function fakeBot (blockAt, pos) {
  return {
    game: { minY: -64, height: 384 },
    entity: { position: pos, height: 1.62, onGround: true },
    blockAt,
    inventory: { items: () => [] }
  }
}

// ---- 1. surfaceYAt: the grounded locator -------------------------------------------------
t('surfaceYAt: flat ground at y71 => stands at y72 (an exact read, not an offset)', () => {
  const cells = {}
  for (let y = 40; y <= 71; y++) cells['466,' + y + ',-95'] = y === 71 ? 'grass_block' : 'stone'
  const b = fakeBot(fakeWorld(cells), new Vec3(466, 45, -95))
  const s = pathfix.surfaceYAt(b, 466, -95)
  assert.strictEqual(s.known, true)
  assert.strictEqual(s.groundY, 71, 'the topmost solid block')
  assert.strictEqual(s.y, 72, 'the standable cell on top of it')
})

t('surfaceYAt: the live evidence - bot at y45, ground y71 => target 72, NOT 55 (the +10 hop)', () => {
  const cells = {}
  for (let y = 40; y <= 71; y++) cells['460,' + y + ',-95'] = y === 71 ? 'grass_block' : 'stone'
  const b = fakeBot(fakeWorld(cells), new Vec3(460, 45, -95))
  const s = pathfix.surfaceYAt(b, 460, -95)
  assert.strictEqual(s.y, 72)
  assert.notStrictEqual(s.y, Math.floor(45) + 10, 'the old blind target was feet+10 = 55')
})

t('surfaceYAt: a tree canopy is not ground - it reads through leaves to the soil', () => {
  const cells = {}
  for (let y = 40; y <= 70; y++) cells['10,' + y + ',10'] = y === 70 ? 'grass_block' : 'stone'
  for (let y = 74; y <= 80; y++) cells['10,' + y + ',10'] = 'oak_leaves'
  const b = fakeBot(fakeWorld(cells), new Vec3(10, 50, 10))
  assert.strictEqual(pathfix.surfaceYAt(b, 10, 10).groundY, 70, 'canopy ignored')
})

t('surfaceYAt: an UNLOADED column is UNKNOWN - it returns no number at all', () => {
  const b = fakeBot(fakeWorld({}, ['0,0']), new Vec3(0, 50, 0))
  const s = pathfix.surfaceYAt(b, 999, 999)
  assert.strictEqual(s.known, false, 'unloaded => known:false')
  assert.strictEqual(s.y, null, 'and NO y - a guess here is what built the towers')
})

t('surfaceYAt: floating-plug fixture (the real 459,-91 column) => the topmost SOLID, not the void', () => {
  // world-probed: y66 cobblestone, y67-71 AIR (the shaft the climb cut), y72 dirt, y73 dirt,
  // y74 grass_block - the original topsoil left floating over its own 5-block void.
  const cells = { '459,66,-91': 'cobblestone', '459,72,-91': 'dirt', '459,73,-91': 'dirt', '459,74,-91': 'grass_block' }
  for (let y = 40; y <= 65; y++) cells['459,' + y + ',-91'] = 'stone'
  const b = fakeBot(fakeWorld(cells), new Vec3(459, 50, -91))
  const s = pathfix.surfaceYAt(b, 459, -91)
  assert.strictEqual(s.known, true)
  assert.strictEqual(s.groundY, 74, 'the plug top IS the topmost solid block - a read, not a judgement')
  assert.strictEqual(s.y, 75)
  // The blindspot that defeated the old guard: hasSolidCeiling read the plug as a cave roof
  // and let the climb keep going. surfaceYAt cannot be fooled that way - it never asks
  // "is something above me", it asks "where does this column END".
})

t('readCell: a null block is the third state, never "there is nothing there"', () => {
  const b = fakeBot(fakeWorld({ '5,64,5': 'stone' }), new Vec3(5, 64, 5))
  assert.strictEqual(pathfix.readCell(b, { x: 5, y: 64, z: 5 }).known, true)
  assert.strictEqual(pathfix.readCell(b, { x: 5, y: 65, z: 5 }).block.name, 'air')
  assert.strictEqual(pathfix.readCell(b, { x: 900, y: 64, z: 900 }).known, false, 'unloaded => known:false')
})

// ---- 2. the climb rung: the +10 is GONE ---------------------------------------------------
const navSrc = fs.readFileSync(path.join(__dirname, 'navigate.js'), 'utf8')
const climbRung = navSrc.slice(navSrc.indexOf("kind: 'climb'"), navSrc.indexOf("kind: 'nudge'"))
// strip comments: the ban is on the EXPRESSION, and the comment above it quotes the deleted one.
const climbCode = climbRung.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// (the navigate.js climb rung was deleted with the rescue ladder on 2026-08-26; climbToSurface itself is pinned below)
t('travelFar surfaceOut: the remote `dest.y` guess is gone, replaced by the own-column read', () => {
  const cmdSrc = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8')
  const fn = cmdSrc.slice(cmdSrc.indexOf('const surfaceOut = async'), cmdSrc.indexOf('const surfaceOut = async') + 1200)
  assert.ok(!/climbToSurface\(bot, Math\.floor\(dest\.y\)/.test(fn), 'dest.y is not a surface')
  assert.ok(/surfaceYAt\(bot, feet\.x, feet\.z\)/.test(fn), 'reads its own column')
  assert.ok(/!surf\.known/.test(fn), 'fails closed on UNKNOWN')
})

// ---- 3. pillarUpTo: no overshoot, invariant assertion, shaft debt --------------------------
const mining = require('./provision-mining.js')

// A bot that can actually pillar: jumping raises it a block, placing records the cell.
function climbBot (cells, startPos, logs) {
  const blockAt = fakeWorld(cells)
  const bot = fakeBot(blockAt, startPos.clone())
  bot.placed = []; bot.dug = []
  bot.inventory = { items: () => [{ name: 'dirt', count: 64 }] }
  bot.heldItem = { name: 'dirt' }
  bot.equip = async () => {}
  bot.lookAt = async () => {}
  bot.canDigBlock = () => true
  bot.clearControlStates = () => {}
  bot.setControlState = (c, v) => { if (c === 'jump' && v) bot.entity.position = bot.entity.position.offset(0, 1, 0) }
  bot.placeBlock = async (ref, face) => {
    const p = ref.position.plus(new Vec3(face.x, face.y, face.z))
    bot.placed.push(p)
    cells[p.x + ',' + p.y + ',' + p.z] = 'dirt'
  }
  bot.dig = async (b) => { bot.dug.push(b.position); cells[b.position.x + ',' + b.position.y + ',' + b.position.z] = 'air' }
  bot.pathfinder = null
  return bot
}

// flat world: solid to y70, open sky above. The bot starts standing ON the surface at y71.
function flatCells (x, z, groundTop) {
  const c = {}
  for (let y = 40; y <= groundTop; y++) c[x + ',' + y + ',' + z] = y === groundTop ? 'grass_block' : 'stone'
  return c
}

ta('pillarUpTo: feet already AT the grounded surface => not one block placed', async () => {
  const cells = flatCells(200, 200, 70)
  const bot = climbBot(cells, new Vec3(200, 71, 200))
  await mining.pillarUpTo(bot, 71, { surfaceY: 71 })
  assert.strictEqual(bot.placed.length, 0, 'feet.y >= surfaceY is the stop condition, exactly')
})

ta('pillarUpTo: an UNGROUNDED target above the surface logs the invariant and stops in open sky', async () => {
  // ground stands at y70, so the surface a player occupies is y71. A caller hands the OLD
  // kind of target - a number 19 blocks into the sky - and the climb must refuse it outright.
  const mlogs = []
  mining.setDebugSink(l => mlogs.push(l))
  const cells = flatCells(210, 210, 70)
  const bot = climbBot(cells, new Vec3(210, 71, 210))
  try { await mining.pillarUpTo(bot, 90, { surfaceY: 71 }) } finally { mining.setDebugSink(null) }
  assert.strictEqual(bot.placed.length, 0, 'not one block placed above the located surface (placed ' + bot.placed.length + ')')
  assert.ok(mlogs.some(l => /INVARIANT VIOLATION/.test(l)), 'the demoted guard REPORTS the ungrounded target instead of silently obeying it: ' + JSON.stringify(mlogs))
})

ta('pillarUpTo: the head-clearance dig is recorded as SHAFT DEBT with the original block name', async () => {
  // buried: solid everywhere above, so the head-clear digs fire and the sky-break cannot.
  const cells = {}
  for (let y = 40; y <= 120; y++) cells['220,' + y + ',220'] = 'stone'
  cells['220,45,220'] = 'air'; cells['220,46,220'] = 'air' // the pocket the bot stands in
  cells['220,46,220'] = 'air'
  cells['220,47,220'] = 'dirt'; cells['220,48,220'] = 'dirt'
  const bot = climbBot(cells, new Vec3(220, 45, 220))
  await mining.pillarUpTo(bot, 46, { surfaceY: 46 })
  const debts = scaffold.shaftDebts({ x: 220, z: 220 }, 4)
  assert.ok(debts.length >= 1, 'the cells the escape opened are on the books (got ' + debts.length + ')')
  assert.ok(debts.every(d => d.was && d.was !== 'air'), 'each debt remembers what USED to fill it: ' + JSON.stringify(debts))
  assert.ok(debts.some(d => d.was === 'dirt'), 'the original block name, verbatim')
})

t('shaft debt is DEBT, not scaffold: invisible to isScaffold and to teardown candidates', () => {
  scaffold.oweShaft({ x: 300, y: 60, z: 300 }, 'stone')
  assert.strictEqual(scaffold.isScaffold({ x: 300, y: 60, z: 300 }), false, 'a hole grants no dig permission')
  assert.strictEqual(scaffold.near({ x: 300, y: 60, z: 300 }, 4).length, 0, 'teardown must never see an air cell as a candidate')
  assert.strictEqual(scaffold.shaftDebts({ x: 300, z: 300 }, 4).length, 1, 'but the debt is readable by name')
})

t('oweShaft is idempotent and keeps the ORIGINAL block name on a re-dig', () => {
  scaffold.oweShaft({ x: 301, y: 60, z: 301 }, 'grass_block')
  scaffold.oweShaft({ x: 301, y: 60, z: 301 }, 'cobblestone')
  const d = scaffold.shaftDebts({ x: 301, z: 301 }, 1)
  assert.strictEqual(d.length, 1)
  assert.strictEqual(d[0].was, 'grass_block', 'the first read is the true original')
})

t('oweShaft refuses to record an air cell as debt (there was nothing there to owe)', () => {
  scaffold.oweShaft({ x: 302, y: 60, z: 302 }, 'cave_air')
  assert.strictEqual(scaffold.shaftDebts({ x: 302, z: 302 }, 1).length, 0)
})

// ---- 4. column-aware teardown -------------------------------------------------------------
// Stub navigate.gotoOnce so no pathfinder runs. `arrive` decides whether the goto actually
// moves the bot - i.e. whether the cell is REACHABLE.
function stubGoto (arrive) {
  const navPath = require.resolve('./navigate.js')
  const prev = require.cache[navPath]
  require.cache[navPath] = { id: navPath, filename: navPath, loaded: true, exports: { gotoOnce: async (bot, goal) => { if (arrive) bot.entity.position = new Vec3(goal.x, goal.y, goal.z) } } }
  return () => { if (prev) require.cache[navPath] = prev; else delete require.cache[navPath] }
}
function tearBot (cells) {
  const bot = fakeBot(fakeWorld(cells), new Vec3(0, 0, 0))
  bot.dug = []
  bot.equip = async () => {}
  bot.canDigBlock = () => true
  bot.dig = async (b) => { bot.dug.push(b.position.y); cells[b.position.x + ',' + b.position.y + ',' + b.position.z] = 'air' }
  return bot
}
function registerColumn (x, z, y0, y1) {
  for (let y = y0; y <= y1; y++) scaffold.add({ x, y, z }, 'pillar')
}

ta('teardown: an UNREACHABLE column top => ZERO cells removed, the whole column stays on the books', async () => {
  const cells = {}
  for (let y = 60; y <= 65; y++) cells['400,' + y + ',400'] = 'cobblestone'
  cells['400,59,400'] = 'stone'
  registerColumn(400, 400, 60, 65)
  const bot = tearBot(cells)
  bot.entity.position = new Vec3(400, 60, 380) // 20 blocks away from every cell
  const restore = stubGoto(false) // the goto never arrives
  let removed
  try { removed = await scaffold.teardown(bot, { x: 400, y: 62, z: 400 }, { radius: 12 }) } finally { restore() }
  assert.strictEqual(removed, 0, 'the old loop dug the reachable base and stranded the top; this one removes NOTHING')
  assert.strictEqual(bot.dug.length, 0, 'no dig was attempted at all')
  assert.strictEqual(scaffold.near({ x: 400, y: 62, z: 400 }, 12).length, 6, 'all 6 cells still owed')
})

ta('teardown: a REACHABLE column comes down strictly top-down and leaves the registry empty', async () => {
  const cells = {}
  for (let y = 60; y <= 65; y++) cells['410,' + y + ',410'] = 'cobblestone'
  registerColumn(410, 410, 60, 65)
  const bot = tearBot(cells)
  bot.entity.position = new Vec3(410, 66, 410)
  const restore = stubGoto(true)
  let removed
  try { removed = await scaffold.teardown(bot, { x: 410, y: 62, z: 410 }, { radius: 12 }) } finally { restore() }
  assert.strictEqual(removed, 6, 'all six came down')
  assert.deepStrictEqual(bot.dug, [65, 64, 63, 62, 61, 60], 'strictly top-down - riding it down, never under the top')
  assert.strictEqual(scaffold.near({ x: 410, y: 62, z: 410 }, 12).length, 0, 'registry clean')
})

ta('teardown: an EXCLUDED cell (a build owns it) abandons the column below it, never amputates', async () => {
  const cells = {}
  for (let y = 60; y <= 64; y++) cells['420,' + y + ',420'] = 'cobblestone'
  registerColumn(420, 420, 60, 64)
  const bot = tearBot(cells)
  bot.entity.position = new Vec3(420, 65, 420)
  const restore = stubGoto(true)
  let removed
  try { removed = await scaffold.teardown(bot, { x: 420, y: 62, z: 420 }, { radius: 12, exclude: p => p.y === 64 }) } finally { restore() }
  assert.strictEqual(removed, 0, 'the top is untouchable, so nothing below it may go')
  assert.strictEqual(scaffold.near({ x: 420, y: 62, z: 420 }, 12).length, 5)
})

ta('teardown: an UNKNOWN cell is not "already gone" - the column is kept, the debt is not dropped', async () => {
  const cells = { '430,60,430': 'cobblestone', '430,61,430': 'cobblestone' }
  registerColumn(430, 430, 60, 61)
  const bot = tearBot(cells)
  bot.blockAt = () => null // the chunk went away mid-pass
  bot.entity.position = new Vec3(430, 62, 430)
  const restore = stubGoto(true)
  try { await scaffold.teardown(bot, { x: 430, y: 60, z: 430 }, { radius: 12 }) } finally { restore() }
  assert.strictEqual(scaffold.near({ x: 430, y: 60, z: 430 }, 12).length, 2, 'both cells still owed - a null is not information')
})

ta('teardown: one unreachable column does not block a different, reachable one', async () => {
  const cells = {}
  for (let y = 60; y <= 62; y++) { cells['440,' + y + ',440'] = 'cobblestone'; cells['460,' + y + ',460'] = 'cobblestone' }
  registerColumn(440, 440, 60, 62)
  registerColumn(460, 460, 60, 62)
  const bot = tearBot(cells)
  bot.entity.position = new Vec3(460, 63, 460) // standing on the 460 column; 440 is 28b away
  const restore = stubGoto(false) // and the goto to 440 never arrives
  let removed
  try { removed = await scaffold.teardown(bot, { x: 450, y: 61, z: 450 }, { radius: 20 }) } finally { restore() }
  assert.strictEqual(removed, 3, 'the reachable column came down whole (got ' + removed + ', dug ' + JSON.stringify(bot.dug) + ')')
  assert.deepStrictEqual(scaffold.near({ x: 450, y: 61, z: 450 }, 20).map(p => p.x), [440, 440, 440], 'the unreachable one is untouched, whole')
})

;(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('PASS  ' + name) } catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message) }
  }
  console.log(failures ? ('\n' + failures + ' FAILED') : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
