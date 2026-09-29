'use strict'
// Minecraft 26.2 support ahead of the npm releases (the live server moved to 26.2 on 2026-09-22;
// minecraft-data 3.117.0 stops at 26.1). Overlays the pc 26.2 data from upstream's `pc_26_2`
// branch onto the installed minecraft-data and adds 26.2 wherever the libraries list 26.1.
// Re-run after every npm install in bot/ (idempotent). Delete once minecraft-data/mineflayer ship 26.2.
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

function patchData (src) {
  const have = JSON.parse(fs.readFileSync(path.join(data, 'dataPaths.json'), 'utf8'))
  if (have.pc['26.2'] && fs.existsSync(path.join(data, 'pc', '26.2', 'protocol.json'))) { console.log('[mc262] minecraft-data already has 26.2'); return }
  fs.cpSync(path.join(src, 'data/pc/26.2'), path.join(data, 'pc/26.2'), { recursive: true })
  fs.mkdirSync(path.join(data, 'pc/1.20.3'), { recursive: true })
  fs.copyFileSync(path.join(src, 'data/pc/1.20.3/windows.json'), path.join(data, 'pc/1.20.3/windows.json'))
  for (const f of ['features.json', 'protocolVersions.json', 'versions.json']) fs.copyFileSync(path.join(src, 'data/pc/common', f), path.join(data, 'pc/common', f))
  have.pc['26.2'] = JSON.parse(fs.readFileSync(path.join(src, 'data/dataPaths.json'), 'utf8')).pc['26.2']
  fs.writeFileSync(path.join(data, 'dataPaths.json'), JSON.stringify(have, null, 2))
  cp.execFileSync(process.execPath, [path.join(pkg, 'bin', 'generate_data.js')], { cwd: pkg, stdio: 'inherit' })
  console.log('[mc262] minecraft-data patched')
}

// the libraries gate on version lists: 26.2 goes wherever 26.1 is listed
const EDITS = [
  ['prismarine-chunk/src/index.js', "26.1: require('./pc/1.18/chunk')\n", "26.1: require('./pc/1.18/chunk'),\n    26.2: require('./pc/1.18/chunk')\n"],
  ['prismarine-physics/lib/features.json', /"26\.1"\]/g, '"26.1", "26.2"]'],
  ['mineflayer/lib/version.js', "'26.1']", "'26.1', '26.2']"],
  ['minecraft-protocol/src/version.js', "'26.1']", "'26.1', '26.2']"],
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
  ['mineflayer-pathfinder/index.js', "  function monitorMovement () {\n", "  function monitorMovement () { try { monitorMovement0() } catch (e) { try { resetPath('path_error') } catch {} bot.emit('path_error', e) } } // (bot2: a throw is one reset)\n  function monitorMovement0 () {\n"]
]
function patchGates () {
  for (const [f, from, to] of EDITS) {
    const copies = [path.join(nm, f), ...fs.readdirSync(nm).map(d => path.join(nm, d, 'node_modules', f))].filter(p => fs.existsSync(p))
    if (!copies.length) throw new Error('[mc262] not installed: ' + f)
    for (const p of copies) {
      const s = fs.readFileSync(p, 'utf8')
      if (s.includes(to)) continue
      const t = s.replace(from, to)
      if (t === s) throw new Error('[mc262] pattern not found in ' + p)
      fs.writeFileSync(p, t)
      console.log('[mc262] patched', path.relative(nm, p))
    }
  }
}

const src = fetchData(process.argv[2] || path.join(__dirname, '.mc262-data'))
patchData(src)
patchGates()
delete require.cache[require.resolve(pkg)]
if (!require(pkg)('26.2')) throw new Error('[mc262] minecraft-data still has no 26.2')
console.log('[mc262] ok - 26.2 ready')
