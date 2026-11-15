'use strict'
// Minecraft 26.2 + 26.3 support ahead of the npm releases (the live server moved to 26.2 on 2026-09-22;
// minecraft-data 3.117.0 stops at 26.1). Overlays the pc 26.2 data from upstream's `pc_26_2`
// branch onto the installed minecraft-data and adds 26.2 wherever the libraries list 26.1.
// 26.3 (protocol 777): installs the committed home-made data set in ./mc263 (built by tools/mc263/build-data.js from the
// 26.2 data + ViaVersion's 26.2->26.3 changes) as pc/26.3, the 26.3 wire types minecraft-protocol needs
// (mc263/lib/nmp-types.js) and the 26.3 packet meanings for mineflayer (mc263/lib/mineflayer-compat.js), and adds 26.3
// wherever the libraries list 26.2. Both versions resolve after one run.
// Re-run after every npm install in bot2/ (idempotent). Delete once minecraft-data/mineflayer ship 26.2/26.3.
//   node patch-mc262.js [dataCloneDir]
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const nm = path.join(__dirname, 'node_modules')
const pkg = path.join(nm, 'minecraft-data')
const data = path.join(pkg, 'minecraft-data', 'data')

function fetchData (dir) {
  if (fs.existsSync(path.join(dir, 'data', 'pc', '26.2', 'protocol.json'))) return dir
  console.log('[mc262] fetching pc_26_2 data from PrismarineJS/minecraft-data')
  fs.rmSync(dir, { recursive: true, force: true })
  const git = (...a) => cp.execFileSync('git', a, { stdio: 'inherit', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) })
  git('clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', '-b', 'pc_26_2', 'https://github.com/PrismarineJS/minecraft-data.git', dir)
  git('-C', dir, 'sparse-checkout', 'set', '--no-cone', '/data/pc/26.2/', '/data/pc/common/', '/data/dataPaths.json', '/data/pc/1.20.3/windows.json')
  return dir
}

// --quiet (the panel runs this on every Start): only what was CHANGED is said, a run with nothing to do says nothing
const QUIET = process.argv.includes('--quiet')
const say = (...a) => { if (!QUIET) console.log(...a) }
function patchData (srcDir) {
  const have = JSON.parse(fs.readFileSync(path.join(data, 'dataPaths.json'), 'utf8'))
  if (have.pc['26.2'] && fs.existsSync(path.join(data, 'pc', '26.2', 'protocol.json'))) { say('[mc262] minecraft-data already has 26.2'); return }
  const src = fetchData(srcDir) // (fetched only when it is needed: a Start with the data in place needs neither git nor the network)
  fs.cpSync(path.join(src, 'data/pc/26.2'), path.join(data, 'pc/26.2'), { recursive: true })
  fs.mkdirSync(path.join(data, 'pc/1.20.3'), { recursive: true })
  fs.copyFileSync(path.join(src, 'data/pc/1.20.3/windows.json'), path.join(data, 'pc/1.20.3/windows.json'))
  for (const f of ['features.json', 'protocolVersions.json', 'versions.json']) fs.copyFileSync(path.join(src, 'data/pc/common', f), path.join(data, 'pc/common', f))
  have.pc['26.2'] = JSON.parse(fs.readFileSync(path.join(src, 'data/dataPaths.json'), 'utf8')).pc['26.2']
  fs.writeFileSync(path.join(data, 'dataPaths.json'), JSON.stringify(have, null, 2))
  cp.execFileSync(process.execPath, [path.join(pkg, 'bin', 'generate_data.js')], { cwd: pkg, stdio: 'inherit' })
  console.log('[mc262] minecraft-data patched')
}

// 26.3: the committed data set in ./mc263 becomes pc/26.3; the common version lists keep 26.2 and gain 26.3
const MC263 = path.join(__dirname, 'mc263')
function patchData263 () {
  const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))
  const writeIfChanged = (f, s) => { if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s) return false; fs.writeFileSync(f, s); return true }
  let changed = false
  const dst = path.join(data, 'pc', '26.3')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of fs.readdirSync(MC263).filter(f => f.endsWith('.json') && f !== 'dataPaths.json')) {
    changed = writeIfChanged(path.join(dst, f), fs.readFileSync(path.join(MC263, f), 'utf8')) || changed
  }
  // protocolVersions: the mc263 list is upstream's 26.3 list (a superset); keep any installed entry it lacks
  const pvFile = path.join(data, 'pc', 'common', 'protocolVersions.json')
  const pv = readJson(path.join(MC263, 'common', 'protocolVersions.json'))
  const keys = new Set(pv.map(x => JSON.stringify(x)))
  for (const x of readJson(pvFile)) if (!keys.has(JSON.stringify(x))) pv.push(x)
  changed = writeIfChanged(pvFile, JSON.stringify(pv, null, 2)) || changed
  const vFile = path.join(data, 'pc', 'common', 'versions.json')
  const v = readJson(vFile)
  for (const x of readJson(path.join(MC263, 'common', 'versions.json'))) if (!v.includes(x)) v.push(x)
  changed = writeIfChanged(vFile, JSON.stringify(v, null, 2)) || changed
  const have = readJson(path.join(data, 'dataPaths.json'))
  const entry = readJson(path.join(MC263, 'dataPaths.json'))
  if (JSON.stringify(have.pc['26.3']) !== JSON.stringify(entry)) {
    have.pc['26.3'] = entry
    fs.writeFileSync(path.join(data, 'dataPaths.json'), JSON.stringify(have, null, 2))
    changed = true
  }
  if (!changed && fs.readFileSync(path.join(pkg, 'data.js'), 'utf8').includes("'26.3'")) { say('[mc263] minecraft-data already has 26.3'); return }
  cp.execFileSync(process.execPath, [path.join(pkg, 'bin', 'generate_data.js')], { cwd: pkg, stdio: 'inherit' })
  console.log('[mc263] minecraft-data patched')
}

// 26.3 code files: copied next to the library code that loads them (every installed copy of the library)
const FILES = [
  ['minecraft-protocol/src/datatypes/mc263-types.js', 'lib/nmp-types.js'],
  ['mineflayer/lib/mc263compat.js', 'lib/mineflayer-compat.js']
]
function copyFiles () {
  for (const [f, src] of FILES) {
    const lib = f.split('/')[0]
    const dirs = [path.join(nm, lib), ...fs.readdirSync(nm).map(d => path.join(nm, d, 'node_modules', lib))].filter(p => fs.existsSync(p))
    if (!dirs.length) throw new Error('[mc263] not installed: ' + lib)
    const body = fs.readFileSync(path.join(MC263, src), 'utf8')
    for (const d of dirs) {
      const p = path.join(d, f.slice(lib.length + 1))
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === body) continue
      fs.writeFileSync(p, body)
      console.log('[mc263] wrote', path.relative(nm, p))
    }
  }
}

// the libraries gate on version lists: 26.2 goes wherever 26.1 is listed, 26.3 wherever 26.2 is.
// [file, from, to, done]: an edit is skipped when its file already contains `done` (default: `to`)
const EDITS = [
  ['prismarine-chunk/src/index.js', "26.1: require('./pc/1.18/chunk')\n", "26.1: require('./pc/1.18/chunk'),\n    26.2: require('./pc/1.18/chunk')\n", '26.2: require'],
  ['prismarine-chunk/src/index.js', "26.2: require('./pc/1.18/chunk')\n", "26.2: require('./pc/1.18/chunk'),\n    26.3: require('./pc/1.18/chunk')\n", '26.3: require'],
  ['prismarine-physics/lib/features.json', /"26\.1"\]/g, '"26.1", "26.2"]', '"26.2"'],
  ['prismarine-physics/lib/features.json', /"26\.2"\]/g, '"26.2", "26.3"]', '"26.3"'],
  // (an OPEN TRAPDOOR OVER A LADDER, facing as it does, is climbed - vanilla since 1.9 and still in 26.3 (LivingEntity
  //  onClimbable, trapdoorUsableAsLadder); the library lists it to 1.20 only, so the client fell where the server climbs - the
  //  castle's shaft hatch, 2026-11-14. The physics, the planner (move.js) and the walk model (rooms.js) one reading:
  //  world.climbableTrapdoor)
  ['prismarine-physics/lib/features.json', '"Trapdoors placed directly above ladders become climbable",\n    "versions": ["1.9", "1.10", "1.11", "1.12", "1.13", "1.14", "1.15", "1.16", "1.17", "1.18", "1.19", "1.20"]', '"Trapdoors placed directly above ladders become climbable",\n    "versions": ["1.9", "1.10", "1.11", "1.12", "1.13", "1.14", "1.15", "1.16", "1.17", "1.18", "1.19", "1.20", "1.21", "26.1", "26.2", "26.3"]'],
  ['mineflayer/lib/version.js', "'26.1']", "'26.1', '26.2']", "'26.2'"],
  ['mineflayer/lib/version.js', "'26.2']", "'26.2', '26.3']", "'26.3'"],
  ['minecraft-protocol/src/version.js', "'26.1']", "'26.1', '26.2']", "'26.2'"],
  ['minecraft-protocol/src/version.js', "'26.2']", "'26.2', '26.3']", "'26.3'"],
  // 26.3 wire types (entity movement steps, position paths, BitSet masks) for the protocol compiler (mc263/lib/nmp-types.js)
  ['minecraft-protocol/src/transforms/serializer.js', "    compiler.addTypes(require('../datatypes/compiler-minecraft'))\n", "    compiler.addTypes(require('../datatypes/compiler-minecraft'))\n    compiler.addTypes(require('../datatypes/mc263-types')) // 26.3 wire types (bot2 patch-mc262.js)\n"],
  // 26.3 packet meanings (dig action numbers, punch, animate ids), installed before any plugin listens (mc263/lib/mineflayer-compat.js)
  ['mineflayer/lib/loader.js', '    bot.supportFeature = bot.registry.supportFeature\n', "    bot.supportFeature = bot.registry.supportFeature\n    if (versionData['>=']('26.3')) require('./mc263compat')(bot) // 26.3 packet meanings (bot2 patch-mc262.js)\n"],
  // the 26.3 teleport accept carries the position the client ends up at (older versions' serializers ignore the extra fields)
  ['mineflayer/lib/plugins/physics.js', "      bot._client.write('teleport_confirm', { teleportId: packet.teleportId })\n", "      bot._client.write('teleport_confirm', { teleportId: packet.teleportId, x: pos.x, y: pos.y, z: pos.z, yaw: newYaw, pitch: newPitch }) // 26.3: + where we end up\n"],
  // ...and nothing after it: a 26.3 server takes the position from the accept. The position_look older clients send on top is a
  // second position inside one client tick, which 26.3 answers with a kick ("invalid_player_movement": at most one position
  // per tick, the tick closed by the client's tick_end - Paper 26.3 handleMovePlayer; ViaBackwards 26.3->26.2 swallows it too)
  ['mineflayer/lib/plugins/physics.js', "    // After death/respawn, delay the forced position_look response.\n", "    if (bot._client.__mc263compat) { // 26.3: the accept carried the position - no move packet on top (bot2 patch-mc262.js)\n      const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)\n      lastSent.x = pos.x\n      lastSent.y = pos.y\n      lastSent.z = pos.z\n      lastSent.yaw = newYaw\n      lastSent.pitch = newPitch\n      lastSent.onGround = bot.entity.onGround\n      lastSent.flags = { onGround: bot.entity.onGround, hasHorizontalCollision: undefined }\n      respawnTimer = 0\n      shouldUsePhysics = true\n      bot.jumpTicks = 0\n      lastSentYaw = bot.entity.yaw\n      lastSentPitch = bot.entity.pitch\n      bot.emit('move', oldPos)\n      bot.emit('forcedMove')\n      return\n    }\n\n    // After death/respawn, delay the forced position_look response.\n", '26.3: the accept carried the position'],
  // the client's tick end, every tick in play: mineflayer never sent it, and a 26.3 server counts positions per client tick -
  // without it the SECOND position packet of the session is the kick. Sent even when the tick's listeners threw (finally):
  // a tick left open makes the next tick's position the second one. 'clientTick' just before it: a sender with its own clock
  // (the boat ride) hands its packets to the tick instead of writing between two of them
  ['mineflayer/lib/plugins/physics.js', "  function tickPhysics (now) {\n", "  function tickPhysics (now) {\n    try {\n      tickPhysicsBody(now)\n      if (bot._client.__mc263compat && bot._client.state === 'play') bot.emit('clientTick') // what must go out INSIDE this tick (bot2 boat.js)\n    } finally {\n      if (bot._client.__mc263compat && bot._client.state === 'play') bot._client.write('tick_end', {}) // 26.3: closes the client tick (bot2 patch-mc262.js)\n    }\n  }\n\n  function tickPhysicsBody (now) {\n", 'function tickPhysicsBody'],
  // mineflayer keeps ONE stateId, the last one seen on any window. A 26.2 server keeps sending player-
  // inventory (window 0) slot updates while a crafting table is open, so every table click went out with
  // window 0's stateId, the server answered each with a full resync, the resync reset the cursor the
  // craft loop thought it held, and sticks landed as planks: no table recipe ever completed. Track it per window.
  ['mineflayer/lib/plugins/inventory.js', 'const listener = packet => { stateId = packet.stateId }', 'const listener = packet => { stateId = packet.stateId; stateIds[packet.windowId] = packet.stateId } // 26.2 per-window stateId'],
  ['mineflayer/lib/plugins/inventory.js', '  let stateId = -1\n', '  let stateId = -1\n  const stateIds = {}\n'],
  ['mineflayer/lib/plugins/inventory.js', '        windowId: window.id,\n        stateId,\n        slot,', '        windowId: window.id,\n        stateId: stateIds[window.id] ?? stateId,\n        slot,'],
  // a modern server says "you got out" as the vehicle's passenger list WITHOUT us (set_passengers boat []); mineflayer
  // only knew the old "vehicle -1" form, kept bot.vehicle set, and the bot "drove" a boat it had left, 15 minutes at
  // sea until a drowned killed it (2026-09-23, traced with bot2 `boatout`)
  ['mineflayer/lib/plugins/entities.js', "        bot.vehicle = bot.entities[entityId]\n        bot.emit('mount')\n      }\n    }\n", "        bot.vehicle = bot.entities[entityId]\n        bot.emit('mount')\n      }\n    } else if (bot.vehicle && bot.vehicle.id === entityId) { const v = bot.vehicle; bot.vehicle = null; bot.emit('dismount', v) } // 26.2 dismount\n"],
  // (not 26.2-specific) a .schem's int properties were read as the number itself, not its place in the value list: a
  // list that starts at 1 came out one higher - acacia leaves distance=7 read as cherry leaves, 4 candles as a white
  // candle (the castle schematic, 2026-09-27)
  // a registry entry that arrives WITHOUT data (the entry form allows it; minecraft-protocol itself sends packs:[], so
  // this is a guard, not the cause of the empty biome - that was prismarine-block's static lookup, below): the merge threw
  // on the missing element - the static biome of the same name stands in
  ['prismarine-registry/lib/pc/transforms.js', "    const equivalent = staticData.biomesByName[name]\n    return Object.assign(biome.element, {", "    const equivalent = staticData.biomesByName[name]\n    if (!biome.element) biome.element = {} // known-pack entry: no data sent, the static biome stands in\n    return Object.assign(biome.element, {"],
  // ...and the blocks looked their biome up in the STATIC data of the version (its ids are not the server's: id 29 read ""),
  // through a table captured at load that the server's registry later replaces - the live registry, read at lookup time
  ['prismarine-block/index.js', "  return provider(registry, { Biome: require('prismarine-biome')(version), version })", "  return provider(registry, { Biome: require('prismarine-biome')(registry), version }) // the live registry: the server's biome ids"],
  ['prismarine-biome/index.js', "  const biomes = registry.biomes\n  return function Biome (id) {\n    return biomes?.[id] || { ...emptyBiome, id }", "  return function Biome (id) {\n    return registry.biomes?.[id] || { ...emptyBiome, id } // (read now: the server's registry replaces the table after load)"],
  ['prismarine-schematic/lib/states.js', "  if (value === 'true') return 0\n", "  if (state.values && state.values.includes(value)) return state.values.indexOf(value) // int lists start at 1\n  if (value === 'true') return 0\n"],
  // pathfinder: a gate/door opened on the way (useOne) shifts the next "place" off the list - undefined when it was the
  // last - and left `placing` set: every physics tick after read placingBlock.y and threw, 20 a second, the body frozen
  // (2026-09-29, the sheep pen's gate). Placing ends when there is nothing left to place.
  ['mineflayer-pathfinder/index.js', "          lockUseBlock.release()\n          placingBlock = nextPoint.toPlace.shift()\n", "          lockUseBlock.release()\n          placingBlock = nextPoint.toPlace.shift()\n          if (!placingBlock) placing = false // (the last one: nothing left to place)\n"],
  ['mineflayer-pathfinder/index.js', "      const block = stateMovements.getScaffoldingItem()\n", "      if (!placingBlock) { placing = false; return } // (nothing to place: never read .y of nothing)\n      const block = stateMovements.getScaffoldingItem()\n"],
  // ...and ANY throw in the pathfinder's tick costs a path reset, never the reflexes: it is a physicsTick listener attached
  // before bot2's, and a listener that throws ends the emit - the edge guard, the creeper hold, air, fight and eat never
  // ran for the two minutes above (audit). bot2 counts 'path_error' (move.js)
  // (a gate or door the path opens refused the click: upstream said it only on the console - retried every tick, the body
  //  stopped, unseen. bot2 logs 'path_use_error' and the watchdog alarms on a streak at one spot; audit)
  ['mineflayer-pathfinder/index.js', "          console.error(err)\n", "          bot.emit('path_use_error', { pos: placingBlock ? { x: placingBlock.x, y: placingBlock.y, z: placingBlock.z } : null, err })\n"],
  ['mineflayer-pathfinder/index.js', "  function monitorMovement () {\n", "  function monitorMovement () { try { monitorMovement0() } catch (e) { try { resetPath('path_error') } catch {} bot.emit('path_error', e) } } // (bot2: a throw is one reset)\n  function monitorMovement0 () {\n"],
  // A WAYPOINT ON WHAT THE BODY WALKS THROUGH: postProcessPath stands each node on top of the block in its feet cell, read raw
  // from the world - an OPEN trapdoor or a door, which the movements walk through (non-physical: bot2's movementsFor), was
  // stood on: the waypoint one block over the floor and pulled toward the plate, the body jumped into the plate for it -
  // "stuck x3, next node <x.703125,y,z.5>", a trap at the castle's east passage twice a day, 2026-10-07. A feet block
  // the movements call non-physical is no floor: the block under it is (the upstream fallback). One rule - the movements'
  // own verdict, never a list of names (castlewalktest counts the class)
  // THE WAY BACK AFTER A PLACE OUTLIVED THE PATH: placing a block under a node beside it (LOSWhenPlacingBlocks), the
  // pathfinder walks back to the node's centre - returningPos - and every tick until it gets there it does nothing else:
  // no plan, no goal, forward held toward it. resetPath (a new goal, setGoal(null), a stuck reset) never cleared it, so a
  // return the body could not make - the server pinned it a step short - held the body 11 minutes: every walk "stuck x3,
  // next -, 0 nodes", the escape acting on a frozen body, until a relog, 2026-10-07 14:45. A reset abandons the return
  ['mineflayer-pathfinder/index.js', "    placing = false\n    pathUpdated = false\n", "    placing = false\n    returningPos = null // (bot2: a reset abandons the walk back to a placed node - it held every walk after it)\n    pathUpdated = false\n"],
  // ...and THE RETURN ITSELF NEVER ARRIVED ON A LOW FLOOR: moveToBlock judged "centred" by the 3D distance to the node, whose
  // y is the cell's - on a bottom slab the feet stand 0.5 under it, the distance never fell under 0.2, and the forward key
  // was held at the node's middle for good (the 14:45 body stood on a spruce slab, y 125.50 against a node at 126). The
  // centring it is for is across the floor: judged on x and z
  ['mineflayer-pathfinder/index.js', "    if (bot.entity.position.distanceSquared(targetPos) > minDistanceSq) {\n", "    if ((bot.entity.position.x - targetPos.x) ** 2 + (bot.entity.position.z - targetPos.z) ** 2 > minDistanceSq) { // (bot2: centred across the floor - a slab's feet stand under the node's y)\n"],
  ['mineflayer-pathfinder/index.js', "      let np = getPositionOnTopOf(b)\n", "      let np = (b && b.shapes.length && stateMovements && (() => { try { return stateMovements.getBlock(b.position, 0, 0, 0).physical === false } catch { return false } })()) ? null : getPositionOnTopOf(b) // (bot2: a block the movements walk through is no floor)\n"],
  // A STEP PRICES ITS CELL ONCE: getMoveForward added exclusionStep(blockC) itself and then safeOrBreak(blockC), whose
  // first line adds it again - every cell a straight step goes into was priced twice, so each "dear, not refused" price of
  // 50 or more (a remembered trap 50, a fall's takeoff 60, the pen 50, a crown leaf 70) was a wall to the planner while the
  // walk model - one price a cell - walked it: legs noPath along ways the search found, "the walks and the model disagree"
  // (a ladder cell's fall price, 2026-11-15 00:24). The explicit one stays where safeOrBreak(blockC) is skipped (a gate
  // opened on the way)
  ['mineflayer-pathfinder/lib/movements.js', "    let cost = 1 // move cost\n    cost += this.exclusionStep(blockC)\n", "    let cost = 1 // move cost\n    if (this.canOpenDoors && blockC.openable && blockC.shapes && blockC.shapes.length !== 0) cost += this.exclusionStep(blockC) // (bot2 patch-mc262.js: priced ONCE - safeOrBreak(blockC) below prices it on every other step)\n", 'priced ONCE - safeOrBreak(blockC)'],
  // THE START ON A SLAB, by the body, never by the ground flag: the planner starts a body standing on a block shorter than
  //  a cell (a bottom slab, a trapdoor) one cell up, on top of it - only while bot.entity.onGround reads true. mineflayer
  //  reads it false a tick at a time standing still on a slab ("ground flag corrected to TRUE" - body.js), and the start
  //  fell INTO the slab's own cell: every move from there a bridge onto the cell under it (air - nothing to click) or a
  //  drop - noPath, the partial path walked off the ledge's lip, 8 blocks, the slab row by the chimney campfires,
  //  2026-11-15 02:16:57 ("gave up (noPath x3) ... onGround false; next node -2263.5,127.5"). The feet resting on a top
  //  of ANY of the block's shapes is standing on it - a stair's low step too (its high one tops the cell; audit F24-1)
  ['mineflayer-pathfinder/index.js', "      const offset = (b && dy > 0.001 && bot.entity.onGround && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0\n", "      const offset = (b && dy > 0.001 && (bot.entity.onGround || (b.shapes && b.shapes.some(s => Math.abs(dy - s[4]) < 0.002))) && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0 // (bot2 patch-mc262.js: the feet on a top of the block's own stand on it, whatever the ground flag)\n", 'the feet on a top of the block\'s own stand on it'],
  // A LADDER ENTERED FROM THE SIDE ALONG ITS PLATE: climbing up, the path's point in a ladder cell is the plate's own top
  //  (getPositionOnTopOf - 0.297 in from the plate's wall): the body is steered INTO the plate, to press on it and climb.
  //  From below, or square at the plate, it does; from a side PARALLEL to the plate - a doorway beside the shaft - the body
  //  lines up on the plate's line before the cell and stops on the plate's end, and jumps there for ever: the castle's
  //  south shaft, "couldn't reach the step in front of the door at -2291,125,-607", the body at z -606.7 = the plate end
  //  plus its half width, 2026-11-15 02:33-02:40. The FIRST point of a ladder column is where the body may stand beside
  //  the plate (its inner face + the half width + 0.02), at the cell's floor as a descent's point is; the points above it
  //  keep the plate's top - the press that climbs
  ['mineflayer-pathfinder/index.js', "      if (np === null) np = getPositionOnTopOf(bot.blockAt(new Vec3(curPoint.x, curPoint.y - 1, curPoint.z)))\n      if (np) {\n", "      if (np === null) np = getPositionOnTopOf(bot.blockAt(new Vec3(curPoint.x, curPoint.y - 1, curPoint.z)))\n      if (np && b && b.type === ladderId && b.shapes.length === 1) { // (bot2 patch-mc262.js: a ladder column's first point beside its plate, never on it)\n        const pv = i > 0 ? path[i - 1] : bot.entity.position\n        if (Math.floor(pv.x) !== b.position.x || Math.floor(pv.z) !== b.position.z) {\n          const sh = b.shapes[0]; const fx = sh[3] - sh[0] < 1; const fz = sh[5] - sh[2] < 1\n          const at = (lo, hi) => lo === 0 ? hi + 0.32 : hi === 1 ? lo - 0.32 : 0.5\n          np = new Vec3(b.position.x + (fx ? at(sh[0], sh[3]) : 0.5), b.position.y, b.position.z + (fz ? at(sh[2], sh[5]) : 0.5))\n        }\n      }\n      if (np) {\n", 'first point beside its plate, never on it']
]
function patchGates () {
  for (const [f, from, to, done] of EDITS) {
    const copies = [path.join(nm, f), ...fs.readdirSync(nm).map(d => path.join(nm, d, 'node_modules', f))].filter(p => fs.existsSync(p))
    if (!copies.length) throw new Error('[mc262] not installed: ' + f)
    for (const p of copies) {
      const s = fs.readFileSync(p, 'utf8')
      if (s.includes(done || to)) continue
      const t = s.replace(from, to)
      if (t === s) throw new Error('[mc262] pattern not found in ' + p)
      fs.writeFileSync(p, t)
      console.log('[mc262] patched', path.relative(nm, p))
    }
  }
}

patchData(process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(__dirname, '.mc262-data'))
patchData263()
copyFiles()
patchGates()
for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}minecraft-data${path.sep}`)) delete require.cache[k]
if (!require(pkg)('26.2')) throw new Error('[mc262] minecraft-data still has no 26.2')
const v263 = require(pkg)('26.3')
if (!v263 || v263.version.version !== 777) throw new Error('[mc263] minecraft-data still has no 26.3')
say('[mc262] ok - 26.2 and 26.3 ready')
