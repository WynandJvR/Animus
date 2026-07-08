'use strict'
// Action layer ("what the body can do"). Every command is plain text in,
// text result out, so the same surface works for a human, for Claude (curl),
// and for a local model. Building uses server commands (/fill, /setblock) -
// the bot is op+creative on the lab server, which makes structures reliable
// instead of fighting physical block-placement reach/inventory rules.

const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const memory = require('./memory.js') // persistent named waypoints
const schematic = require('./schematic.js') // download/parse + survival physical building
const provision = require('./provision.js') // BOM -> gather/craft plan + execution

// entity names treated as hostile for attack/defend and auto-defense
const HOSTILE = /zombie|skeleton|spider|creeper|enderman|witch|husk|drowned|pillager|vindicator|ravager|slime|magma_cube|blaze|piglin|hoglin|phantom|zoglin|stray|silverfish|guardian|vex|wither|warden|ghast|shulker|illusioner|evoker|breeze|bogged/i

// remembered spot of the last block/tree broken, so "plant where you chopped" works
let lastBrokeAt = null

// schematic build state (one bot per process, so module-level is fine).
// loadedSchem: the parsed schematic ready to build; building: a build is running;
// buildAbort: set by `stop` to halt an in-progress build cleanly.
let loadedSchem = null
let building = false
let buildAbort = false // set by `stop`; watched by schematic builds AND provision runs
let provisioning = false

// pathfinder.goto with a hard deadline. An unreachable target (a player who flew
// somewhere unpathable, an item across a ravine) can otherwise hang goto FOREVER,
// and because the brain awaits each /cmd, that one stuck call freezes the WHOLE
// brain loop with no recovery. Racing a timer + cancelling the goal turns "the bot
// went catatonic" into a normal "couldn't reach" result that the caller handles.
function gotoTimed (bot, goal, ms = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { bot.pathfinder.setGoal(null) } catch {}
      reject(new Error('goto timed out'))
    }, ms)
    bot.pathfinder.goto(goal).then(
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } },
      e => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } }
    )
  })
}

// How close the bot trails a player when following. Range 2 settles right on top of
// them (felt crowding); ~3 blocks reads as walking alongside. Tunable via FOLLOW_RANGE.
const FOLLOW_RANGE = Math.max(1, parseInt(process.env.FOLLOW_RANGE || '3', 10))

// ---- helpers ---------------------------------------------------------------

function blockPos (bot) {
  const p = bot.entity.position
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

// An anchor a few blocks in front of the bot's facing, so it never builds on
// top of itself. Yaw 0 = south(+z); we snap to the nearest cardinal.
function anchorInFront (bot, dist = 3) {
  const b = blockPos(bot)
  const yaw = bot.entity.yaw
  const dirs = [
    { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }
  ]
  const idx = (Math.round(yaw / (Math.PI / 2)) % 4 + 4) % 4
  const d = dirs[idx]
  return { x: b.x + d.x * dist, y: b.y, z: b.z + d.z * dist }
}

function fill (bot, x1, y1, z1, x2, y2, z2, block) {
  bot.chat(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${block}`)
}
function setblock (bot, x, y, z, block) {
  bot.chat(`/setblock ${x} ${y} ${z} ${block}`)
}

// normalize a username for fuzzy matching: lowercase + drop a leading
// non-alphanumeric prefix (e.g. Bedrock/Floodgate names like ".PlayerName")
function normName (n) { return String(n || '').toLowerCase().replace(/^[^a-z0-9_]+/i, '') }

function findPlayer (bot, name) {
  if (name) {
    // never target yourself: the bot appears in bot.players under its own name, and
    // an alone brain otherwise latches onto its own name ("follow Claudebot" -> self)
    const want = normName(name)
    if (name === bot.username || want === normName(bot.username)) return null
    // exact first, then case-/prefix-insensitive (so "PlayerName" finds ".PlayerName")
    if (bot.players[name] && bot.players[name].entity) return bot.players[name].entity
    for (const p of Object.values(bot.players)) {
      if (!p.entity || p.username === bot.username) continue
      if (normName(p.username) === want) return p.entity
    }
    return null
  }
  // nearest other player
  let best = null
  let bestD = Infinity
  for (const p of Object.values(bot.players)) {
    if (!p.entity || p.username === bot.username) continue
    const d = p.entity.position.distanceTo(bot.entity.position)
    if (d < bestD) { bestD = d; best = p.entity }
  }
  return best
}

// ---- building primitives ---------------------------------------------------

function buildWall (bot, material, length, height, a) {
  fill(bot, a.x, a.y, a.z, a.x + length - 1, a.y + height - 1, a.z, material)
  return `wall: ${material} ${length}x${height} at ${a.x},${a.y},${a.z}`
}

function buildTower (bot, material, height, size, a) {
  const x2 = a.x + size - 1
  const z2 = a.z + size - 1
  // solid then hollow to leave a climbable shaft
  fill(bot, a.x, a.y, a.z, x2, a.y + height - 1, z2, material)
  if (size > 2) {
    fill(bot, a.x + 1, a.y, a.z + 1, x2 - 1, a.y + height - 1, z2 - 1, 'air')
  }
  return `tower: ${material} ${size}x${size} h${height} at ${a.x},${a.y},${a.z}`
}

function buildHouse (bot, material, w, l, h, a) {
  const x1 = a.x; const y1 = a.y; const z1 = a.z
  const x2 = a.x + w - 1; const y2 = a.y + h - 1; const z2 = a.z + l - 1
  // floor
  fill(bot, x1, y1, z1, x2, y1, z2, material)
  // solid shell up to roof
  fill(bot, x1, y1, z1, x2, y2, z2, material)
  // hollow interior
  fill(bot, x1 + 1, y1 + 1, z1 + 1, x2 - 1, y2 - 1, z2 - 1, 'air')
  // flat roof
  fill(bot, x1, y2, z1, x2, y2, z2, material)
  // doorway (2 high) centred on the -z wall
  const dx = Math.floor((x1 + x2) / 2)
  setblock(bot, dx, y1 + 1, z1, 'air')
  setblock(bot, dx, y1 + 2, z1, 'air')
  // a couple of window holes on the +x / -x walls
  setblock(bot, x1, y1 + 2, Math.floor((z1 + z2) / 2), 'glass')
  setblock(bot, x2, y1 + 2, Math.floor((z1 + z2) / 2), 'glass')
  return `house: ${material} ${w}x${l}x${h} at ${x1},${y1},${z1} (door on -z side)`
}

// Eat the best food in inventory so the bot doesn't starve. Returns a status
// string. Safe to call often - no-ops if already full or no food on hand.
async function eatFood (bot) {
  if (bot.food != null && bot.food >= 20) return 'not hungry'
  const mcData = require('minecraft-data')(bot.version)
  const foods = (mcData && mcData.foodsByName) || {}
  const items = bot.inventory ? bot.inventory.items() : []
  // prefer the most filling food available
  const edible = items.filter(i => foods[i.name]).sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0))
  if (!edible.length) return 'no food in inventory'
  const food = edible[0]
  await bot.equip(food, 'hand')
  await bot.consume()
  return `ate ${food.name} (food ${bot.food})`
}

// Natural ground a torch may be auto-placed on. Anchored/explicit so crafted or
// build blocks (planks, bricks, wool, glass, concrete...) never qualify - the
// auto-torch reflex must light natural terrain, never decorate someone's build.
const TORCH_GROUND = /grass_block|^dirt$|coarse_dirt|podzol|rooted_dirt|^stone$|deepslate$|^tuff$|^andesite$|^diorite$|^granite$|^sand$|^red_sand$|^gravel$|^netherrack$|^cobblestone$|moss_block|^mud$|^sandstone$|^snow_block$|^calcite$|^basalt$|^blackstone$|grass_path|dirt_path/

// Place ONE torch on natural ground next to the bot (for the opt-in auto-torch
// reflex). Returns a status string; safe to call often - no-ops cleanly if there's
// no torch in hand-reach inventory or no suitable natural spot adjacent.
async function placeTorchNearby (bot) {
  const items = bot.inventory ? bot.inventory.items() : []
  const torch = items.find(i => i.name === 'torch')
  if (!torch) return 'no torch in inventory'
  const b = blockPos(bot)
  let ref = null
  for (let r = 1; r <= 2 && !ref; r++) {
    for (let dx = -r; dx <= r && !ref; dx++) {
      for (let dz = -r; dz <= r && !ref; dz++) {
        if (dx === 0 && dz === 0) continue // not under our own feet
        const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1, b.z + dz))
        const above = bot.blockAt(new Vec3(b.x + dx, b.y, b.z + dz))
        if (ground && TORCH_GROUND.test(ground.name) && above && above.name === 'air') ref = ground
      }
    }
  }
  if (!ref) return 'no natural ground nearby for a torch'
  await bot.equip(torch, 'hand').catch(() => {})
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
  try {
    await bot.placeBlock(ref, new Vec3(0, 1, 0))
  } catch (e) {
    // Paper/creative sometimes doesn't echo the blockUpdate in time even though the
    // torch WAS placed - read the spot back before reporting failure, so the reflex
    // doesn't log a false "couldn't place" (and then retry-spam).
    const placed = bot.blockAt(ref.position.offset(0, 1, 0))
    if (!placed || !/torch/.test(placed.name)) return `couldn't place torch: ${e.message}`
  }
  return `placed torch at ${ref.position.x},${ref.position.y + 1},${ref.position.z}`
}

// Pick the best tool in inventory for a block (axe/pickaxe/shovel, best material).
function bestTool (bot, blockName) {
  const items = bot.inventory ? bot.inventory.items() : []
  let kind = null
  if (/_log$|_wood$|plank|_stem$|fence|door|chest|crafting|bookshelf|barrel|sign|ladder|wooden/.test(blockName)) kind = 'axe'
  else if (/stone|ore|cobble|deepslate|granite|diorite|andesite|obsidian|brick|furnace|anvil|concrete|terracotta|netherrack|basalt|blackstone|amethyst|raw_|rail|iron_block|gold_block/.test(blockName)) kind = 'pickaxe'
  else if (/dirt|grass_block|sand|gravel|clay|soul_|mud|path|farmland|snow|podzol|mycelium/.test(blockName)) kind = 'shovel'
  if (!kind) return null
  const tools = items.filter(i => i.name.endsWith('_' + kind))
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
  for (const m of order) { const t = tools.find(i => i.name.startsWith(m)); if (t) return t }
  return tools[0] || null
}

// ---- command dispatch ------------------------------------------------------

async function handle (bot, line) {
  const parts = String(line).trim().split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase()
  const a = parts.slice(1)

  switch (cmd) {
    case '':
      return 'ok'
    case 'help':
      return [
        'commands:',
        ' perception:',
        '  state                    full self+world snapshot (JSON)',
        '  scan [radius=6]          tally nearby block types + ground height',
        '  find <block> [radius=32] locate nearest block of a type',
        '  block <x> <y> <z>        name of block at a coord',
        '  entities [radius=24]     nearby mobs/items/players',
        '  inventory', '  look <x> <y> <z>',
        ' movement:',
        '  come [player]            walk to a player (nearest if omitted)',
        '  goto <x> <y> <z> | goto <waypoint>', '  follow <player>', '  stop',
        '  turn <around|left|right|north|south|east|west>',
        '  remember <name>          save current spot as a waypoint',
        '  forget <name> | waypoints   manage saved places',
        ' survival/actions:',
        '  mine|break [block|x y z]  break a block; bare "break" chops nearest tree',
        '  gather <item> [count<=64] gather natural resources until count reached',
        '  collect                   pick up nearby dropped items',
        '  plant <item>              place a sapling on grass/dirt',
        '  place <item> [x y z]      place a block on a solid surface',
        '  craft <item> [count]      craft (walks to a table if needed)',
        '  hunt [animal]             kill a nearby animal for food',
        '  sleep | wake              sleep in a nearby bed / wake up',
        '  attack | defend           fight nearest hostile (flees creepers)',
        '  eat | drop <item> [n] | equip <item>',
        ' building (op):',
        '  setblock <x> <y> <z> <block>',
        '  fill <x1 y1 z1 x2 y2 z2> <block>',
        '  wall <material> <length> <height>',
        '  tower <material> [height=10] [size=3]',
        '  house <material> [w=7] [l=7] [h=4]',
        '  schematic load <url|file>   load a .schem (direct link or local file)',
        '  schematic materials         list blocks the loaded build needs',
        '  schematic build [here|x y z]  build it in SURVIVAL from inventory (asks for materials)',
        '  provision [run]             plan/execute gathering+crafting the whole bill of materials',
        '  clear [radius=8]', '  give <item> [count]',
        ' admin:  tp <x> <y> <z> | gamemode <mode> | say <msg>'
      ].join('\n')

    case 'say': {
      // CHAT ONLY. mineflayer runs a leading "/" as a server command, and the
      // bot is op - so a brain-issued "say /stop" or "say /op x" would escape
      // normal play into server admin. Strip leading slashes so say can only
      // ever produce plain chat, never a command. Also bound the length.
      const msg = a.join(' ').replace(/^[\s/]+/, '').replace(/[\r\n]/g, ' ').trim()
      if (!msg) return 'nothing to say'
      bot.chat(msg.slice(0, 256)); return 'said'
    }

    case 'state':
      return JSON.stringify(state(bot))

    case 'block': {
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: block <x> <y> <z>'
      const b = bot.blockAt(new Vec3(x, y, z))
      return b ? b.name : 'unknown (chunk not loaded)'
    }

    case 'scan': {
      // Tally block types in a cube around the bot + report ground height.
      const r = Math.min(parseInt(a[0] || '6', 10), 12)
      const b = blockPos(bot)
      const counts = {}
      let minGroundY = Infinity; let maxGroundY = -Infinity
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          let surface = null
          for (let dy = r; dy >= -r; dy--) {
            const bl = bot.blockAt(new Vec3(b.x + dx, b.y + dy, b.z + dz))
            if (!bl || bl.name === 'air' || bl.name === 'cave_air' || bl.name === 'void_air') continue
            counts[bl.name] = (counts[bl.name] || 0) + 1
            if (surface === null) { surface = b.y + dy; minGroundY = Math.min(minGroundY, surface); maxGroundY = Math.max(maxGroundY, surface) }
          }
        }
      }
      const top = Object.entries(counts).sort((a2, b2) => b2[1] - a2[1]).slice(0, 8)
      return JSON.stringify({
        center: b, radius: r,
        groundY: minGroundY === Infinity ? null : { min: minGroundY, max: maxGroundY },
        blocks: Object.fromEntries(top)
      })
    }

    case 'find': {
      const name = a[0]
      if (!name) return 'usage: find <block> [radius=32]'
      const maxDistance = Math.min(parseInt(a[1] || '32', 10), 64)
      const mcData = require('minecraft-data')(bot.version)
      const def = mcData.blocksByName[name]
      if (!def) return `unknown block: ${name}`
      const found = bot.findBlock({ matching: def.id, maxDistance, count: 1 })
      if (!found) return `no ${name} within ${maxDistance}`
      const d = found.position.distanceTo(bot.entity.position)
      return `${name} at ${found.position.x},${found.position.y},${found.position.z} (dist ${d.toFixed(1)})`
    }

    case 'entities':
      return JSON.stringify(summariseEntities(bot, parseInt(a[0] || '24', 10)))

    case 'inventory':
      return JSON.stringify((bot.inventory ? bot.inventory.items() : []).map(i => `${i.name} x${i.count}`))

    case 'look': {
      // look at a point (updates lookingAt / blockAtCursor for surveying)
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: look <x> <y> <z>'
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      return `looking at ${x},${y},${z}`
    }

    case 'turn':
    case 'lookbehind': {
      // rotate the view: around/back, left, right, or a cardinal direction.
      // mineflayer yaw: 0=south, PI/2=west, PI=north, 3PI/2=east.
      const dir = (a[0] || 'around').toLowerCase()
      const cur = bot.entity.yaw
      const cardinals = { south: 0, west: Math.PI / 2, north: Math.PI, east: 3 * Math.PI / 2 }
      let yaw
      if (dir in cardinals) yaw = cardinals[dir]
      else if (['around', 'behind', 'back'].includes(dir)) yaw = cur + Math.PI
      // yaw increases south->west->north->east, so a right turn ADDS pi/2
      else if (dir === 'left') yaw = cur - Math.PI / 2
      else if (dir === 'right') yaw = cur + Math.PI / 2
      else return 'usage: turn <around|left|right|north|south|east|west>'
      bot.pathfinder.setGoal(null) // stop following so the turn isn't snapped back
      await bot.look(yaw, 0, true)
      return `turned ${dir} (now facing ${facing(bot.entity.yaw)})`
    }

    case 'give': {
      // creative material grab (for physical placement / survival-style builds)
      const item = a[0]
      const count = parseInt(a[1] || '64', 10)
      if (!item) return 'usage: give <item> [count]'
      bot.chat(`/give ${bot.username} ${item} ${count}`)
      return `gave ${count} ${item}`
    }

    case 'eat': return await eatFood(bot)

    case 'drop':
    case 'toss': {
      // toss REAL items from inventory (not duped) - the legit way to share
      const name = a[0]
      if (!name) return 'usage: drop <item> [count]'
      const items = bot.inventory ? bot.inventory.items() : []
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return `no ${name} in inventory`
      let count = item.count
      if (a[1]) { const n = parseInt(a[1], 10); if (Number.isFinite(n) && n > 0) count = Math.min(n, item.count) }
      await bot.toss(item.type, null, count)
      return `dropped ${count} ${item.name}`
    }

    case 'equip':
    case 'hold': {
      // actually hold an item from inventory, so "show me your sword" is true
      const name = a[0]
      if (!name) return 'usage: equip <item>'
      const items = bot.inventory ? bot.inventory.items() : []
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return `no ${name} in inventory (have: ${items.map(i => i.name).join(', ') || 'nothing'})`
      await bot.equip(item, 'hand')
      return `equipped ${item.name}`
    }

    case 'come': {
      const t = findPlayer(bot, a[0])
      if (!t) return `no player ${a[0] || 'nearby'}`
      const p = t.position
      // BLOCK until we actually arrive, so the brain can't revert to following
      // someone else mid-walk and run back.
      try { await gotoTimed(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 20000) } catch (e) { return `couldn't reach ${a[0] || 'player'}: ${e.message}` }
      return `arrived at ${a[0] || 'player'}`
    }
    case 'goto': {
      // a named waypoint ("goto home") or explicit coords ("goto 10 -60 4")
      if (a[0] && Number.isNaN(Number(a[0]))) {
        const wp = memory.getWaypoint(a[0])
        if (!wp) return `no waypoint "${a[0]}" (known: ${memory.waypointNames().join(', ') || 'none'})`
        try { await gotoTimed(bot, new goals.GoalNear(wp.x, wp.y, wp.z, 1), 20000) } catch (e) { return `couldn't reach ${a[0]}: ${e.message}` }
        return `arrived at ${a[0].toLowerCase()} (${wp.x},${wp.y},${wp.z})`
      }
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: goto <x> <y> <z> | goto <waypoint>'
      try { await gotoTimed(bot, new goals.GoalNear(x, y, z, 1), 20000) } catch (e) { return `couldn't reach ${x},${y},${z}: ${e.message}` }
      return `arrived at ${x},${y},${z}`
    }
    case 'remember':
    case 'savepoint': {
      // save the bot's current spot as a named waypoint (persists across restarts)
      const name = a[0]
      if (!name) return 'usage: remember <name>  (saves your current location)'
      const wp = memory.setWaypoint(name, bot.entity.position)
      return wp ? `remembered "${name.toLowerCase()}" at ${wp.x},${wp.y},${wp.z}` : 'usage: remember <name>'
    }
    case 'forget': {
      const name = a[0]
      if (!name) return 'usage: forget <name>'
      return memory.removeWaypoint(name) ? `forgot "${name.toLowerCase()}"` : `no waypoint "${name}"`
    }
    case 'waypoints':
    case 'places': {
      const wps = memory.listWaypoints()
      const names = Object.keys(wps)
      if (!names.length) return 'no waypoints saved yet (use "remember <name>")'
      return JSON.stringify(Object.fromEntries(names.map(n => [n, `${wps[n].x},${wps[n].y},${wps[n].z}`])))
    }
    case 'follow': {
      const t = findPlayer(bot, a[0])
      if (!t) return `no player ${a[0] || 'nearby'}`
      bot.pathfinder.setGoal(new goals.GoalFollow(t, FOLLOW_RANGE), true)
      return `following ${a[0] || 'nearest player'}`
    }
    case 'stop':
      buildAbort = true // also halts an in-progress schematic build
      bot.pathfinder.setGoal(null); return 'stopped'

    case 'attack':
    case 'defend': {
      const me = bot.entity.position
      let target = null; let best = 16
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || e === bot.entity) continue
        if (e.type !== 'mob' && e.type !== 'hostile') continue // never players/animals/objects
        if (!HOSTILE.test(e.name || '') || /creeper/.test(e.name || '')) continue // never melee creepers
        const d = e.position.distanceTo(me)
        if (d < best) { best = d; target = e }
      }
      if (!target) return 'no hostile mobs nearby'
      const items = bot.inventory ? bot.inventory.items() : []
      const weapon = items.find(i => i.name.endsWith('_sword')) || items.find(i => i.name.endsWith('_axe'))
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      await bot.lookAt(target.position.offset(0, 1, 0), true).catch(() => {})
      bot.attack(target)
      return `attacking ${target.name || 'mob'} (dist ${best.toFixed(1)})`
    }

    case 'mine':
    case 'break':
    case 'dig': {
      const mcData = require('minecraft-data')(bot.version)
      let target = null
      let requested = null // a SPECIFIC block/coords was asked for
      const nums = a.slice(0, 3).map(Number)
      if (a.length >= 3 && !nums.some(Number.isNaN)) {
        requested = 'there'
        target = bot.blockAt(new Vec3(nums[0], nums[1], nums[2]))
        if (target && target.name === 'air') target = null
      } else if (a[0] && Number.isNaN(Number(a[0]))) {
        requested = a[0]
        // anchored so crafted variants (polished_deepslate, deepslate_bricks,
        // raw_iron_block, moss_carpet, polished_blackstone...) don't leak in
        const MINABLE = /_log$|_wood$|_stem$|_ore$|ancient_debris|^stone$|^cobblestone$|^deepslate$|^dirt$|^coarse_dirt$|grass_block|^gravel$|^sand$|^red_sand$|^clay$|^andesite$|^diorite$|^granite$|^tuff$|^calcite$|^netherrack$|^basalt$|^blackstone$|^obsidian$|^moss_block$|^mud$|^pumpkin$|^melon$/
        const all = Object.values(mcData.blocksByName).filter(b => b.name === a[0] || b.name.includes(a[0]))
        const natural = all.filter(b => MINABLE.test(b.name))
        // natural resources -> search far; crafted/built blocks (planks/glass/...) ->
        // only break ones RIGHT HERE (<=4), so "break these planks" works but it
        // never wanders off to tear into a distant build.
        if (natural.length) target = bot.findBlock({ matching: natural.map(b => b.id), maxDistance: 32 })
        else if (all.length) target = bot.findBlock({ matching: all.map(b => b.id), maxDistance: 4 })
        else return `I don't recognize the block "${a[0]}"`
      }
      // If a SPECIFIC block was requested but not found, STOP - never fall back to
      // breaking whatever the bot happens to look at (that's how it broke a window).
      if (requested && !target) return `no ${requested === 'there' ? 'block there' : requested + ' nearby'}`
      if (!target && typeof bot.blockAtCursor === 'function') {
        const look = bot.blockAtCursor(5)
        if (look && look.name !== 'air') target = look // bare "break": the block we're looking at
      }
      if (!target) { // bare "break": default to the nearest tree
        const logIds = Object.values(mcData.blocksByName).filter(b => /_log$|_stem$/.test(b.name)).map(b => b.id)
        if (logIds.length) target = bot.findBlock({ matching: logIds, maxDistance: 16 })
      }
      if (!target || target.name === 'air') return 'no block or tree to break nearby'
      const isTree = /_log$|_stem$/.test(target.name)
      const logIds = Object.values(mcData.blocksByName).filter(b => /_log$|_stem$/.test(b.name)).map(b => b.id)
      let broke = 0
      let cur = target
      do {
        // re-pick the right tool for EACH block (auto-eat/defend may have swapped
        // the held item mid-chop). Only equip if not already holding it.
        const tool = bestTool(bot, cur.name)
        if (tool && (!bot.heldItem || bot.heldItem.name !== tool.name)) await bot.equip(tool, 'hand').catch(() => {})
        if (bot.entity.position.distanceTo(cur.position) > 4) {
          try { await gotoTimed(bot, new goals.GoalNear(cur.position.x, cur.position.y, cur.position.z, 2), 15000) } catch { break }
        }
        if (bot.canDigBlock && !bot.canDigBlock(cur)) break
        if (broke === 0) lastBrokeAt = cur.position.clone() // remember the base, for replanting
        try { await bot.dig(cur) } catch (e) { return broke ? `broke ${broke} log(s)` : `couldn't break ${cur.name}: ${e.message}` }
        broke++
        cur = isTree ? bot.findBlock({ matching: logIds, maxDistance: 5 }) : null // chop the whole tree
      } while (cur && broke < 8) // bounded so the brain isn't blocked too long (creeper exposure)
      return `broke ${broke} ${isTree ? 'log(s)' : target.name}`
    }

    case 'collect':
    case 'pickup': {
      // walk onto the nearest dropped item to pick it up (auto-collected on contact)
      let target = null; let best = 32
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position) continue
        if (e.name !== 'item') continue // real drops only (the 'item' entity type, not item_frames)
        const d = e.position.distanceTo(bot.entity.position)
        if (d < best) { best = d; target = e }
      }
      if (!target) return 'no dropped items nearby'
      try { await gotoTimed(bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 0), 15000) } catch (e) { return `couldn't reach item: ${e.message}` }
      return 'went to pick up nearby items'
    }

    case 'plant': {
      const name = a[0]
      if (!name) return 'usage: plant <item>'
      const items = bot.inventory ? bot.inventory.items() : []
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return `no ${name} in inventory`
      const PLANTABLE = /grass_block|^dirt$|podzol|coarse_dirt|rooted_dirt|mud|moss_block|mycelium/
      let ref = null
      // 1) explicit coords
      const nums = a.slice(1, 4).map(Number)
      if (a.length >= 4 && !nums.some(Number.isNaN)) {
        const g = bot.blockAt(new Vec3(nums[0], nums[1] - 1, nums[2]))
        if (g && PLANTABLE.test(g.name)) ref = g
      }
      // 2) where we last chopped -> "plant where you broke the tree" (only if it's
      // still nearby, so a bare plant doesn't path back to an old, distant spot)
      if (!ref && lastBrokeAt && bot.entity.position.distanceTo(lastBrokeAt) < 12) {
        const g = bot.blockAt(lastBrokeAt.offset(0, -1, 0))
        const above = bot.blockAt(lastBrokeAt)
        if (g && PLANTABLE.test(g.name) && above && above.name === 'air') ref = g
      }
      // 3) nearest suitable ground to the bot
      if (!ref) {
        const b = blockPos(bot)
        for (let r = 1; r <= 4 && !ref; r++) {
          for (let dx = -r; dx <= r && !ref; dx++) {
            for (let dz = -r; dz <= r && !ref; dz++) {
              if (dx === 0 && dz === 0) continue
              const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1, b.z + dz))
              const above = bot.blockAt(new Vec3(b.x + dx, b.y, b.z + dz))
              if (ground && PLANTABLE.test(ground.name) && above && above.name === 'air') ref = ground
            }
          }
        }
      }
      if (!ref) return 'no grass/dirt with open space nearby to plant on'
      if (bot.entity.position.distanceTo(ref.position) > 4) { try { await gotoTimed(bot, new goals.GoalNear(ref.position.x, ref.position.y, ref.position.z, 2), 15000) } catch {} }
      await bot.equip(item, 'hand').catch(() => {})
      await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
      try { await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch (e) { return `couldn't plant ${item.name}: ${e.message}` }
      return `planted ${item.name} at ${ref.position.x},${ref.position.y + 1},${ref.position.z}`
    }

    case 'place': {
      // general physical placement onto any solid surface (torches, blocks, table...)
      const name = a[0]
      if (!name) return 'usage: place <item> [x y z]'
      const items = bot.inventory ? bot.inventory.items() : []
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return `no ${name} in inventory`
      let ref = null
      const nums = a.slice(1, 4).map(Number)
      if (a.length >= 4 && !nums.some(Number.isNaN)) ref = bot.blockAt(new Vec3(nums[0], nums[1] - 1, nums[2]))
      if (!ref) {
        const b = blockPos(bot)
        for (let r = 1; r <= 4 && !ref; r++) {
          for (let dx = -r; dx <= r && !ref; dx++) {
            for (let dz = -r; dz <= r && !ref; dz++) {
              if (dx === 0 && dz === 0) continue
              const ground = bot.blockAt(new Vec3(b.x + dx, b.y - 1, b.z + dz))
              const above = bot.blockAt(new Vec3(b.x + dx, b.y, b.z + dz))
              if (ground && ground.boundingBox === 'block' && above && above.name === 'air') ref = ground
            }
          }
        }
      }
      if (!ref) return 'no solid surface with open space nearby'
      await bot.equip(item, 'hand').catch(() => {})
      await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true).catch(() => {})
      try { await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch (e) { return `couldn't place ${item.name}: ${e.message}` }
      return `placed ${item.name}`
    }

    case 'craft': {
      const name = a[0]
      if (!name) return 'usage: craft <item> [count]'
      const mcData = require('minecraft-data')(bot.version)
      const def = mcData.itemsByName[name] // recipesFor needs an ITEM id (block ids differ)
      if (!def) return `can't craft "${name}" (unknown item)`
      const count = Math.max(1, parseInt(a[1] || '1', 10))
      const tableId = mcData.blocksByName.crafting_table && mcData.blocksByName.crafting_table.id
      let table = tableId ? bot.findBlock({ matching: tableId, maxDistance: 4 }) : null
      let recipe = bot.recipesFor(def.id, null, 1, table)[0]
      if (!recipe && tableId) { // need a table - walk to the nearest one
        table = bot.findBlock({ matching: tableId, maxDistance: 48 })
        if (table) {
          try { await gotoTimed(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 15000) } catch {}
          recipe = bot.recipesFor(def.id, null, 1, table)[0]
        }
      }
      if (!recipe) return `can't craft ${name}${table ? ' (missing materials)' : ' (need a crafting table / materials)'}`
      try { await bot.craft(recipe, count, table) } catch (e) { return `couldn't craft ${name}: ${e.message}` }
      return `crafted ${count}x ${name}`
    }

    case 'hunt': {
      // kill a passive animal (for food/resources). Defaults to common food mobs.
      const want = (a[0] || '').toLowerCase()
      const FOOD = /cow|pig|chicken|sheep|rabbit|mooshroom|goat/
      let target = null; let best = 24
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position || (e.type !== 'mob' && e.type !== 'animal')) continue
        const n = (e.name || '').toLowerCase()
        if (want ? !n.includes(want) : !FOOD.test(n)) continue
        const d = e.position.distanceTo(bot.entity.position); if (d < best) { best = d; target = e }
      }
      if (!target) return `no ${want || 'animal'} nearby`
      const weapon = (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_sword')) || (bot.inventory ? bot.inventory.items() : []).find(i => i.name.endsWith('_axe'))
      if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      let hits = 0
      while (target.isValid && hits < 8) { // bounded so the brain isn't frozen too long
        if (bot.entity.position.distanceTo(target.position) <= 3.5) {
          await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.7, 0)).catch(() => {})
          bot.attack(target); hits++
        }
        await new Promise(r => setTimeout(r, 600))
      }
      bot.pathfinder.setGoal(null)
      return target.isValid ? `chasing ${want || 'animal'}` : `hunted ${want || 'animal'}`
    }

    case 'sleep': {
      const mcData = require('minecraft-data')(bot.version)
      const bedIds = Object.values(mcData.blocksByName).filter(b => /_bed$/.test(b.name)).map(b => b.id)
      const bed = bedIds.length ? bot.findBlock({ matching: bedIds, maxDistance: 16 }) : null
      if (!bed) return 'no bed nearby'
      if (bot.entity.position.distanceTo(bed.position) > 3) { try { await gotoTimed(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 12000) } catch {} }
      try { await bot.sleep(bed) } catch (e) { return `can't sleep: ${e.message}` }
      return 'sleeping'
    }
    case 'wake':
    case 'wakeup': {
      try { await bot.wake() } catch (e) { return `couldn't wake: ${e.message}` }
      return 'awake'
    }

    case 'setblock': {
      const [x, y, z] = a.slice(0, 3).map(Number)
      const block = a[3]
      if (!block || [x, y, z].some(Number.isNaN)) return 'usage: setblock <x> <y> <z> <block>'
      setblock(bot, x, y, z, block); return `setblock ${block} @ ${x},${y},${z}`
    }
    case 'fill': {
      const n = a.slice(0, 6).map(Number)
      const block = a[6]
      if (!block || n.some(Number.isNaN)) return 'usage: fill <x1 y1 z1 x2 y2 z2> <block>'
      fill(bot, ...n, block); return `filled ${block}`
    }
    case 'wall': {
      const material = a[0] || 'stone'
      const length = parseInt(a[1] || '5', 10)
      const height = parseInt(a[2] || '3', 10)
      return buildWall(bot, material, length, height, anchorInFront(bot))
    }
    case 'tower': {
      const material = a[0] || 'stone'
      const height = parseInt(a[1] || '10', 10)
      const size = parseInt(a[2] || '3', 10)
      return buildTower(bot, material, height, size, anchorInFront(bot))
    }
    case 'house': {
      const material = a[0] || 'oak_planks'
      const w = parseInt(a[1] || '7', 10)
      const l = parseInt(a[2] || '7', 10)
      const h = parseInt(a[3] || '4', 10)
      return buildHouse(bot, material, w, l, h, anchorInFront(bot, 2))
    }
    case 'clear': {
      const r = parseInt(a[0] || '8', 10)
      const b = blockPos(bot)
      fill(bot, b.x - r, b.y, b.z - r, b.x + r, b.y + r, b.z + r, 'air')
      return `cleared r${r} around ${b.x},${b.y},${b.z}`
    }
    case 'schem':
    case 'schematic': {
      // Load and physically build a schematic IN SURVIVAL (real blocks from
      // inventory, placed by hand - no /fill or creative). Operator-only (in
      // CHEAT_CMDS) so the autonomous brain can't fetch URLs / build on its own.
      const sub = (a[0] || '').toLowerCase()
      if (sub === 'load') {
        const src = a[1]
        if (!src) return 'usage: schematic load <url|file>  (url must be a DIRECT .schem link, e.g. buildingguide.app/schematics/<name>.schem)'
        try {
          if (/^https?:\/\//i.test(src)) {
            const buf = await schematic.download(src)
            const name = schematic.nameFromUrl(src)
            schematic.saveLocal(name, buf) // cache locally so a rebuild needs no re-download
            loadedSchem = { schem: await schematic.readSchematic(buf, bot.version), name }
          } else {
            loadedSchem = { schem: await schematic.loadFile(src, bot.version), name: src }
          }
        } catch (e) { return `couldn't load schematic: ${e.message}` }
        const s = loadedSchem.schem.size
        const m = schematic.materialsSummary(loadedSchem.schem)
        // Anything taller than ~3 blocks needs scaffolding to reach - the bot
        // pillars up with cheap filler blocks (verified live: no dirt = no roof).
        const scaffold = s.y > 3 ? ' - and a stack of dirt/cobblestone so I can scaffold up to reach the top' : ''
        return `loaded "${loadedSchem.name}" (${s.x}x${s.y}x${s.z}). Bring me - ${m.text}${scaffold}`
      }
      if (sub === 'materials' || sub === 'mats' || sub === 'bom') {
        if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
        return schematic.materialsSummary(loadedSchem.schem).text
      }
      if (sub === 'build') {
        if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
        if (building) return 'already building - say "stop" to cancel first'
        // Origin: "here" (bot's feet) or explicit coords. Optional trailing "clear"
        // flattens the footprint first so the build completes on unflat ground.
        const rest = a.slice(1)
        const doClear = rest.some(t => t.toLowerCase() === 'clear')
        const originArgs = rest.filter(t => t.toLowerCase() !== 'clear')
        let at
        if (!originArgs.length || originArgs[0] === 'here') { const p = blockPos(bot); at = new Vec3(p.x, p.y, p.z) } else {
          const n = originArgs.slice(0, 3).map(Number)
          if (n.some(Number.isNaN)) return 'usage: schematic build [here | <x> <y> <z>] [clear]'
          at = new Vec3(n[0], n[1], n[2])
        }
        building = true; buildAbort = false
        // Long-running (minutes) - run detached, chat progress, and return the
        // kickoff line now so the command/HTTP call doesn't block for the whole build.
        schematic.buildSurvival(bot, loadedSchem.schem, at, {
          say: msg => bot.chat(String(msg).slice(0, 256)),
          isStopped: () => buildAbort,
          restoreMovements: () => setupMovements(bot),
          clear: doClear
        }).then(r => {
          building = false
          bot.chat(`build ${r.stopped ? 'stopped' : 'done'}: ${r.placed}/${r.total} placed${r.skipped ? `, ${r.skipped} skipped` : ''}`)
        }).catch(e => {
          building = false; setupMovements(bot)
          bot.chat(`build error: ${e.message}`)
        })
        return `building "${loadedSchem.name}" at ${at.x},${at.y},${at.z} in survival${doClear ? ' (clearing the site first)' : ''} - I'll ask for materials as I go. Say "stop" to cancel.`
      }
      if (sub === 'clear') {
        // Flatten a build site by hand: empty the loaded schematic's whole box.
        if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
        if (building) return 'already building - say "stop" to cancel first'
        const rest = a.slice(1)
        let at
        if (!rest.length || rest[0] === 'here') { const p = blockPos(bot); at = new Vec3(p.x, p.y, p.z) } else {
          const n = rest.slice(0, 3).map(Number)
          if (n.some(Number.isNaN)) return 'usage: schematic clear [here | <x> <y> <z>]'
          at = new Vec3(n[0], n[1], n[2])
        }
        building = true; buildAbort = false
        schematic.clearVolume(bot, loadedSchem.schem, at, { isStopped: () => buildAbort })
          .then(rm => { building = false; setupMovements(bot); bot.chat(`cleared ${rm} block(s) - site flat at ${at.x},${at.y},${at.z}, ready to build`) })
          .catch(e => { building = false; setupMovements(bot); bot.chat(`clear error: ${e.message}`) })
        return `clearing the build site at ${at.x},${at.y},${at.z} in survival - say "stop" to cancel.`
      }
      return 'usage: schematic <load <url|file> | materials | build [here|x y z] [clear] | clear [here|x y z]>'
    }

    case 'gather': {
      // Gather natural resources by hand (chop trees / mine natural blocks) until
      // a count is reached. Natural-player action, so brain-accessible - but
      // capped per call so it can't strip a landscape on one decision.
      const item = a[0]
      const count = Math.min(parseInt(a[1] || '16', 10) || 16, 64)
      if (!item) return `usage: gather <item> [count<=64]  (know how: ${Object.keys(provision.GATHER_SOURCES).join(', ')})`
      if (!provision.GATHER_SOURCES[item]) return `I don't know how to gather ${item} (know: ${Object.keys(provision.GATHER_SOURCES).join(', ')})`
      buildAbort = false // a PREVIOUS stop must not abort this fresh gather
      const r = await provision.runGather(bot, item, count, { isStopped: () => buildAbort, restoreMovements: () => setupMovements(bot) })
      return `gathered ${r.gathered}/${count} ${item} (${r.reason})`
    }

    case 'provision': {
      // Plan (and run) acquiring the loaded schematic's ENTIRE bill of materials
      // from nothing: gather -> craft tools/basics -> mine -> smelt -> strip ->
      // craft finals. Operator-only like schematic - a long autonomous action.
      if (!loadedSchem) return 'no schematic loaded - schematic load <url|file> first'
      const mcData = require('minecraft-data')(bot.version)
      const bom = { ...schematic.billOfMaterials(loadedSchem.schem).counts }
      // scaffold dirt for anything the bot can't reach from the ground - verified
      // live: without pillar blocks the roof of even a 3-tall box is unreachable
      if (loadedSchem.schem.size.y > 2) bom.dirt = (bom.dirt || 0) + 8 + 2 * loadedSchem.schem.size.y
      const plan = provision.planProvision(mcData, bom, provision.inventoryCounts(bot))
      const planLines = plan.tasks.map(t =>
        t.type === 'gather' ? `gather ${t.count}x ${t.item}${t.tool ? ` [${t.tool}]` : ''}`
          : t.type === 'craft' ? `craft ${t.crafts * t.perCraft}x ${t.item}${t.needsTable ? ' (table)' : ''}`
            : t.type === 'smelt' ? `smelt ${t.count}x ${t.output}`
              : t.type === 'strip' ? `strip ${t.count}x ${t.output}`
                : JSON.stringify(t))
      const unob = Object.entries(plan.unobtainable).map(([n, c]) => `${c}x ${n}`)
      if ((a[0] || '').toLowerCase() !== 'run') {
        if (!plan.tasks.length && !unob.length) return 'inventory already covers the bill of materials - ready to build'
        return `plan (${plan.tasks.length} steps): ${planLines.join('; ')}${unob.length ? ` | CAN'T OBTAIN: ${unob.join(', ')}` : ''} - "provision run" to execute`
      }
      if (provisioning) return 'already provisioning - say "stop" to cancel first'
      if (unob.length) return `can't provision: no way to obtain ${unob.join(', ')}`
      if (!plan.tasks.length) return 'inventory already covers the bill of materials - ready to build'
      provisioning = true; buildAbort = false
      // long-running: run detached (like schematic build), chat progress
      provision.runPlan(bot, plan, {
        say: msg => bot.chat(String(msg).slice(0, 256)),
        isStopped: () => buildAbort,
        restoreMovements: () => setupMovements(bot)
      }).then(results => {
        provisioning = false
        const bad = results.filter(r => !r.ok)
        bot.chat(bad.length
          ? `provisioning stopped: ${bad.map(r => `${r.task.type} ${r.task.item || r.task.output}: ${r.note}`).join('; ')}`.slice(0, 256)
          : 'provisioning done - I have everything, ready to build')
      }).catch(e => { provisioning = false; bot.chat(`provisioning error: ${e.message}`.slice(0, 250)) })
      return `provisioning ${plan.tasks.length} steps - I'll gather and craft everything myself. Say "stop" to cancel.`
    }

    case 'clearinv': {
      // wipe the bot's own inventory (op /clear) - for clean provisioning tests
      bot.chat(`/clear ${bot.username}`); return 'cleared inventory'
    }
    case 'tp': {
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: tp <x> <y> <z>'
      bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`); return `tp -> ${x},${y},${z}`
    }
    case 'gamemode':
      bot.chat(`/gamemode ${a[0] || 'creative'} ${bot.username}`); return `gamemode ${a[0]}`

    default:
      return `unknown command: ${cmd} (try "help")`
  }
}

// Cardinal facing from yaw, so the brain knows which way "forward" is.
function facing (yaw) {
  const dirs = ['south', 'west', 'north', 'east']
  return dirs[(Math.round(yaw / (Math.PI / 2)) % 4 + 4) % 4]
}

function summariseEntities (bot, maxDist = 16) {
  const me = bot.entity.position
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue
    const d = e.position.distanceTo(me)
    if (d > maxDist) continue
    out.push({
      type: e.name || e.displayName || e.type,
      kind: e.type, // 'player' | 'mob' | 'object' | 'orb' ...
      dist: +d.toFixed(1),
      pos: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) }
    })
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, 12)
}

// Biome at a position. atFeet is usually air (whose biome can read blank), so
// prefer the solid block below; fall back to the world biome table by id.
function biomeName (bot, p) {
  try {
    const b = bot.blockAt(p.offset(0, -1, 0)) || bot.blockAt(p)
    if (b && b.biome && b.biome.name) return b.biome.name
    if (bot.world && typeof bot.world.getBiome === 'function') {
      const md = require('minecraft-data')(bot.version)
      const bio = md.biomes && md.biomes[bot.world.getBiome(p)]
      if (bio && bio.name) return bio.name
    }
  } catch { /* biome data not ready */ }
  return null
}

// Nearest hostile mob, so the brain can reason about danger (retreat / call for
// help / pick a safe fight) instead of relying only on the reflex auto-defend.
function nearestThreat (bot, maxDist = 16) {
  const me = bot.entity && bot.entity.position
  if (!me) return null
  let best = null; let bestD = maxDist
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || (e.type !== 'mob' && e.type !== 'hostile')) continue
    if (!HOSTILE.test(e.name || '')) continue
    const d = e.position.distanceTo(me); if (d < bestD) { bestD = d; best = e }
  }
  return best ? { type: best.name, dist: +bestD.toFixed(1), flee: /creeper/.test(best.name || '') } : null
}

function nearbyPlayers (bot) {
  const me = bot.entity.position
  return Object.values(bot.players || {})
    .filter(p => p.entity && p.username !== bot.username)
    .map(p => ({
      name: p.username,
      dist: +p.entity.position.distanceTo(me).toFixed(1),
      pos: { x: Math.round(p.entity.position.x), y: Math.round(p.entity.position.y), z: Math.round(p.entity.position.z) }
    }))
    .sort((a, b) => a.dist - b.dist)
}

// Rich self+world snapshot so any brain can reason about what to do.
function state (bot) {
  const ent = bot.entity
  const p = ent ? ent.position : null
  const below = p ? bot.blockAt(p.offset(0, -1, 0)) : null
  // blockAtCursor ray-traces nearby entities and throws if one lacks a position
  // (e.g. just after join, before the world settles) - never let that break /state
  let looking = null
  try { if (typeof bot.blockAtCursor === 'function') looking = bot.blockAtCursor(6) } catch { looking = null }
  const biome = p ? biomeName(bot, p) : null
  const players = nearbyPlayers(bot)
  // Ground truth about what the BODY is doing right now, so the brain's idle-hold
  // can tell when a goal silently died and skip inferences during long autonomous
  // flows instead of assuming "the body is still executing my last behaviour".
  const pf = bot.pathfinder
  const moving = pf && typeof pf.isMoving === 'function' ? pf.isMoving() : false
  const goal = pf && pf.goal ? ((pf.goal.constructor && pf.goal.constructor.name) || 'goal') : null

  return {
    name: bot.username,
    pos: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null,
    facing: ent ? facing(ent.yaw) : null,
    health: bot.health,
    food: bot.food,
    oxygen: bot.oxygenLevel,
    gameMode: bot.game ? bot.game.gameMode : null,
    dimension: bot.game ? bot.game.dimension : null,
    biome,
    timeOfDay: bot.time ? bot.time.timeOfDay : null,
    isDay: bot.time ? bot.time.timeOfDay < 13000 : null,
    isRaining: bot.isRaining,
    blockBelow: below ? below.name : null,
    lookingAt: looking ? { name: looking.name, pos: { x: looking.position.x, y: looking.position.y, z: looking.position.z } } : null,
    heldItem: bot.heldItem ? bot.heldItem.name : null,
    inventory: (bot.inventory ? bot.inventory.items() : []).map(i => `${i.name} x${i.count}`),
    players,
    alone: players.length === 0, // no OTHER players nearby (you are never in this list)
    threat: nearestThreat(bot),   // nearest hostile, or null
    moving,                       // is the body currently pathing somewhere?
    goal,                         // current pathfinder goal type (GoalFollow/GoalNear/...) or null
    busy: isBusy(),               // an operator build/provision is driving the body - the brain should hold
    waypoints: memory.waypointNames(), // named places you can "goto <name>"
    entities: summariseEntities(bot)
  }
}

function setupMovements (bot) {
  const m = new Movements(bot)
  m.allowFreeMotion = true
  m.canDig = false            // NEVER break blocks to make a path (was griefing builds)
  m.allow1by1towers = false   // don't pillar up
  m.canOpenDoors = true       // open doors instead of getting stuck / breaking them
  m.allowParkour = true
  if ('scafoldingBlocks' in m) m.scafoldingBlocks = [] // don't place blocks to bridge
  bot.pathfinder.setMovements(m)
}

// busy = a long autonomous flow (schematic build / provisioning) is running;
// idle reflexes (auto-collect...) must not steal the bot's movement meanwhile
function isBusy () { return building || provisioning }

module.exports = { handle, state, setupMovements, eatFood, placeTorchNearby, isBusy }
