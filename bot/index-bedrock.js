'use strict'
// The "body" — BEDROCK edition. A drop-in alternative to index.js that connects
// to a Bedrock endpoint (e.g. a Java server fronted by Geyser/Floodgate) instead
// of the Java protocol, while exposing the EXACT SAME local control API and
// command surface. The brain (brain-llm.js) and the human (ctl.sh) talk to it
// identically — they cannot tell which body is running.
//
//   GET  /health          -> { ok, spawned }
//   GET  /state           -> JSON world/self state
//   GET  /log             -> recent chat / events
//   POST /cmd  "<line>"    -> runs one command, returns text
//
// HOW IT DIFFERS FROM THE JAVA BODY
//   bedrock-protocol is a LOW-LEVEL client: there is no Mineflayer-style world
//   model or pathfinder. So this body is honest about what it can do:
//     * build / admin  -> full: sent as server commands (/fill, /setblock, ...)
//     * movement        -> command-based teleport (/tp), reliable but not physical
//     * self + entities -> tracked from packets (position, players, mobs, time)
//     * block perception (scan/find/block) -> NOT available (no world model);
//       these return a clear message instead of looping the brain.
//
// CONFIG (env overrides config.json):
//   MC_HOST       server host (default config.host)            e.g. your-server.example.com
//   MC_PORT       Bedrock UDP port (default 19132)
//   MC_USERNAME   gamertag / display name (default config.username)
//   MC_AUTH       'offline' (default) | 'microsoft'
//   BEDROCK_VERSION  pin the protocol version if auto-negotiation fails
//   CONTROL_HOST/CONTROL_PORT  control API bind (default 127.0.0.1:3001)

const http = require('http')
const crypto = require('crypto')
const bedrock = require('bedrock-protocol')
const cfg = require('./config.json')
const access = require('./access.js')

// BRAIN CONFINEMENT: world-editing/admin commands are blocked on the HTTP /cmd
// path so an autonomous brain can't grief or dupe. The list is shared from
// access.js so the Java and Bedrock bodies can never drift apart.
const CHEAT_CMDS = access.CHEAT_CMDS

const HOST = process.env.MC_HOST || cfg.host
const PORT = parseInt(process.env.MC_PORT || cfg.bedrockPort || '19132', 10)
const USERNAME = process.env.MC_USERNAME || cfg.username || 'Claudebot'
const OFFLINE = (process.env.MC_AUTH || cfg.auth || 'offline') !== 'microsoft'
const VERSION = process.env.BEDROCK_VERSION || undefined
const CONTROL_HOST = process.env.CONTROL_HOST || cfg.controlHost || '127.0.0.1'
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || cfg.controlPort || '3001', 10)

// ---- logging ---------------------------------------------------------------

const log = []
function note (msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  log.push(line)
  if (log.length > 200) log.shift()
  console.log(line)
}

// ---- live world snapshot (maintained from packets) -------------------------

const self = {
  runtimeId: null,
  pos: null,            // {x,y,z}
  yaw: 0,               // degrees; Bedrock yaw 0 = south (+z)
  pitch: 0,
  gameMode: null,
  dimension: 0,
  health: null,
  time: null,
  spawned: false
}
// keyed by runtime id
const players = new Map()  // runtimeId -> { username, uuid, pos }
const entities = new Map() // runtimeId -> { type, pos }
const uniqueToRuntime = new Map() // entity_unique_id -> runtimeId (for removal)

// chat addressed to the bot, surfaced in /state so the brain can reply.
// Each message is handed to the brain once (seen flag) so it can't loop.
const recentChat = []
function recordChat (from, text) {
  recentChat.push({ from, text, ts: Date.now(), seen: false })
  if (recentChat.length > 6) recentChat.shift()
}
// Hard cap on outgoing chat so a chatty brain can't trip server anti-spam.
const CHAT_COOLDOWN_MS = parseInt(process.env.CHAT_COOLDOWN_MS || '4000', 10)
let lastSayAt = 0
let lastSayText = ''

function dist (a, b) {
  if (!a || !b) return Infinity
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

// ---- connect ---------------------------------------------------------------

const client = bedrock.createClient({
  host: HOST,
  port: PORT,
  username: USERNAME,
  offline: OFFLINE,
  version: VERSION,
  // surface the Microsoft device-code link prominently when auth is online
  onMsaCode (data) {
    note(`MICROSOFT SIGN-IN: open ${data.verification_uri} and enter code ${data.user_code}`)
  }
})

note(`bedrock body connecting to ${HOST}:${PORT} as ${USERNAME} (auth=${OFFLINE ? 'offline' : 'microsoft'})`)

client.on('join', () => note('joined (server accepted login)'))

client.on('spawn', () => {
  self.spawned = true
  note(`spawned as ${USERNAME} at ${self.pos ? `${self.pos.x},${self.pos.y},${self.pos.z}` : '?'}`)
  // Do NOT change gamemode by default — just join and idle. Opt in for the lab
  // with AUTO_CREATIVE=1 or config.autoCreative.
  if (process.env.AUTO_CREATIVE === '1' || cfg.autoCreative) sendCommand('/gamemode creative @s').catch(() => {})
})

client.on('error', (err) => note(`ERROR: ${err.message}`))
client.on('disconnect', (p) => note(`disconnected: ${p && (p.message || p.reason) ? (p.message || p.reason) : ''}`))
client.on('kick', (p) => note(`KICKED: ${JSON.stringify(p).slice(0, 200)}`))

// ---- packet handlers (wrapped so an unexpected shape never crashes us) -----

function on (name, fn) {
  client.on(name, (params) => { try { fn(params) } catch (e) { /* tolerate shape drift */ } })
}

on('start_game', (p) => {
  self.runtimeId = p.runtime_entity_id
  if (p.player_position) self.pos = roundPos(p.player_position)
  if (p.rotation) { self.pitch = p.rotation.x; self.yaw = p.rotation.z }
  if (p.player_gamemode != null) self.gameMode = String(p.player_gamemode)
  if (p.dimension != null) self.dimension = p.dimension
})

on('move_player', (p) => {
  if (p.runtime_id !== self.runtimeId) return
  if (p.position) self.pos = roundPos(p.position)
  if (p.pitch != null) self.pitch = p.pitch
  if (p.yaw != null) self.yaw = p.yaw
})

on('set_time', (p) => { self.time = p.time })

on('update_attributes', (p) => {
  if (p.runtime_entity_id !== self.runtimeId || !p.attributes) return
  const h = p.attributes.find(a => a.name === 'minecraft:health')
  if (h) self.health = h.current
})
on('set_health', (p) => { if (p.health != null) self.health = p.health })

on('player_list', (p) => {
  if (!p.records) return
  const recs = p.records.records || p.records
  if (p.records.type === 'add' || p.records.type === 0) {
    for (const r of recs) {
      // store under uuid until we see a runtime id via add_player
      players.set(`uuid:${r.uuid}`, { username: r.username, uuid: r.uuid, pos: null })
    }
  } else { // remove
    for (const r of recs) players.delete(`uuid:${r.uuid}`)
  }
})

on('add_player', (p) => {
  const rid = p.runtime_id ?? p.runtime_entity_id
  players.delete(`uuid:${p.uuid}`)
  players.set(rid, { username: p.username, uuid: p.uuid, pos: roundPos(p.position) })
  if (p.unique_id != null) uniqueToRuntime.set(String(p.unique_id), rid)
})

on('add_entity', handleAddActor)
on('add_actor', handleAddActor) // legacy name on older versions; harmless if it never fires
function handleAddActor (p) {
  const rid = p.runtime_id ?? p.runtime_entity_id
  entities.set(rid, { type: p.entity_type || 'entity', pos: roundPos(p.position) })
  if (p.unique_id != null) uniqueToRuntime.set(String(p.unique_id), rid)
}

// 1.26.30 uses *_entity packet names (the legacy *_actor names don't exist here)
on('move_entity', (p) => {
  const rid = p.runtime_entity_id ?? p.runtime_id
  const e = entities.get(rid) || players.get(rid)
  if (e && p.position) e.pos = roundPos(p.position)
})
on('move_entity_delta', (p) => {
  const rid = p.runtime_entity_id ?? p.runtime_id
  const e = entities.get(rid) || players.get(rid)
  if (!e || !e.pos) return
  if (p.x != null) e.pos.x = round1(p.x)
  if (p.y != null) e.pos.y = round1(p.y)
  if (p.z != null) e.pos.z = round1(p.z)
})

on('remove_entity', (p) => {
  const uid = String(p.entity_id_self ?? p.entity_unique_id)
  const rid = uniqueToRuntime.get(uid)
  if (rid != null) { entities.delete(rid); players.delete(rid); uniqueToRuntime.delete(uid) }
})

on('text', (p) => {
  const from = p.source_name || p.xuid || '?'
  const message = p.message || ''
  if (from === USERNAME) return
  if (p.type === 'chat' || p.type === 'whisper') {
    note(`<${from}> ${message}`)
    if (message.startsWith('!')) {
      if (!access.isOperator(from, cfg)) { note(`(denied) ${from} is not an operator`); return }
      handle(message.slice(1))
        .then(r => note(`(chat-cmd) ${r}`))
        .catch(e => note(`(chat-cmd error) ${e.message}`))
    } else if (access.isAddressed(message, USERNAME, cfg)) {
      recordChat(from, message)
    }
  }
})

function roundPos (v) { return v ? { x: +(+v.x).toFixed(1), y: +(+v.y).toFixed(1), z: +(+v.z).toFixed(1) } : null }
function round1 (n) { return +(+n).toFixed(1) }

// ---- sending server commands + capturing their output ----------------------

const pending = new Map() // request_id -> resolve

on('command_output', (p) => {
  const rid = p.origin && p.origin.request_id
  const resolve = rid && pending.get(rid)
  if (!resolve) return
  pending.delete(rid)
  // 1.26.30: output is an array of { message_id, success, parameters[] }
  const msgs = (p.output || [])
    .map(o => [o.message_id, ...(o.parameters || [])].filter(Boolean).join(' '))
    .filter(Boolean).join('; ')
  resolve(msgs || (p.success_count != null ? `ok (${p.success_count})` : 'ok'))
})

// Send a slash command; resolve with the server's textual response (or 'sent'
// after a short wait if the server returns no command_output).
function sendCommand (command) {
  const request_id = crypto.randomUUID()
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    pending.set(request_id, finish)
    try {
      // field shapes verified against minecraft-data bedrock 1.26.30:
      // version is a STRING, origin needs a real uuid + player_entity_id (li64).
      client.queue('command_request', {
        command,
        origin: { type: 'player', uuid: '00000000-0000-0000-0000-000000000000', request_id, player_entity_id: 0 },
        internal: false,
        version: '52'
      })
    } catch (e) {
      pending.delete(request_id)
      return finish(`send error: ${e.message}`)
    }
    setTimeout(() => { pending.delete(request_id); finish('sent') }, 700)
  })
}

// Send normal player chat (a text packet) — works WITHOUT op, unlike /say.
// Used for conversational replies; drops duplicates and respects the cooldown.
function sendChat (message) {
  // chat only — strip leading slashes/newlines and bound length (defense in depth)
  const text = String(message).replace(/^[\s/]+/, '').replace(/[\r\n]/g, ' ').trim().slice(0, 256)
  const now = Date.now()
  if (text && text === lastSayText) { note('chat suppressed (duplicate)'); return false }
  if (now - lastSayAt < CHAT_COOLDOWN_MS) { note(`chat throttled (cooldown ${CHAT_COOLDOWN_MS}ms)`); return false }
  lastSayAt = now; lastSayText = text
  try {
    client.queue('text', {
      needs_translation: false,
      category: 'authored',
      type: 'chat',
      source_name: USERNAME,
      message: text,
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false
    })
    return true
  } catch (e) { note(`chat send error: ${e.message}`); return false }
}

// ---- geometry (mirrors the Java body's building primitives) ----------------

function blockPos () {
  const p = self.pos || { x: 0, y: 64, z: 0 }
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

// An anchor a few blocks in front of facing. Bedrock yaw is in degrees,
// 0 = south(+z); snap to nearest cardinal (same mapping as the Java body).
function anchorInFront (d = 3) {
  const b = blockPos()
  const dirs = [{ x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }]
  const idx = ((Math.round(self.yaw / 90) % 4) + 4) % 4
  const dir = dirs[idx]
  return { x: b.x + dir.x * d, y: b.y, z: b.z + dir.z * d }
}

const fill = (x1, y1, z1, x2, y2, z2, block) => sendCommand(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${block}`)
const setblock = (x, y, z, block) => sendCommand(`/setblock ${x} ${y} ${z} ${block}`)

async function buildWall (material, length, height, a) {
  await fill(a.x, a.y, a.z, a.x + length - 1, a.y + height - 1, a.z, material)
  return `wall: ${material} ${length}x${height} at ${a.x},${a.y},${a.z}`
}
async function buildTower (material, height, size, a) {
  const x2 = a.x + size - 1; const z2 = a.z + size - 1
  await fill(a.x, a.y, a.z, x2, a.y + height - 1, z2, material)
  if (size > 2) await fill(a.x + 1, a.y, a.z + 1, x2 - 1, a.y + height - 1, z2 - 1, 'air')
  return `tower: ${material} ${size}x${size} h${height} at ${a.x},${a.y},${a.z}`
}
async function buildHouse (material, w, l, h, a) {
  const x1 = a.x; const y1 = a.y; const z1 = a.z
  const x2 = a.x + w - 1; const y2 = a.y + h - 1; const z2 = a.z + l - 1
  await fill(x1, y1, z1, x2, y2, z2, material)
  await fill(x1 + 1, y1 + 1, z1 + 1, x2 - 1, y2 - 1, z2 - 1, 'air')
  const dx = Math.floor((x1 + x2) / 2)
  await setblock(dx, y1 + 1, z1, 'air')
  await setblock(dx, y1 + 2, z1, 'air')
  await setblock(x1, y1 + 2, Math.floor((z1 + z2) / 2), 'glass')
  await setblock(x2, y1 + 2, Math.floor((z1 + z2) / 2), 'glass')
  return `house: ${material} ${w}x${l}x${h} at ${x1},${y1},${z1} (door on -z side)`
}

// ---- movement (command-based teleport; no physical pathfinder on Bedrock) --

let followTimer = null
function stopFollow () { if (followTimer) { clearInterval(followTimer); followTimer = null } }

function findPlayer (name) {
  const ps = [...players.values()].filter(p => p.username && p.username !== USERNAME)
  if (name) return ps.find(p => p.username === name) || null
  let best = null; let bestD = Infinity
  for (const p of ps) {
    if (!p.pos) continue
    const d = dist(p.pos, self.pos)
    if (d < bestD) { bestD = d; best = p }
  }
  return best || ps[0] || null
}

// ---- command dispatch (same surface as commands.js) ------------------------

const PERCEPTION_NOTE = 'block-perception (scan/find/block) is unavailable on the bedrock body — no world model. Use state/entities, then build or move.'

async function handle (line) {
  const parts = String(line).trim().split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase()
  const a = parts.slice(1)

  switch (cmd) {
    case '': return 'ok'
    case 'help':
      return [
        'bedrock body commands:',
        ' perception: state | entities | inventory(limited) | look(no-op)',
        '   (scan/find/block are NOT supported here — no world model)',
        ' movement (teleport-based): come [player] | goto <x> <y> <z> | follow <player> | stop',
        ' building: setblock <x y z> <block> | fill <x1 y1 z1 x2 y2 z2> <block>',
        '   wall <material> <length> <height> | tower <material> [h] [size] | house <material> [w] [l] [h]',
        '   clear [radius] | give <item> [count]',
        ' admin: tp <x> <y> <z> | gamemode <mode> | say <msg>'
      ].join('\n')

    case 'say': sendChat(a.join(' ')); return 'said' // real chat packet, no op needed
    case 'state': return JSON.stringify(state())
    case 'entities': return JSON.stringify(summariseEntities(parseInt(a[0] || '24', 10)))
    case 'inventory': return JSON.stringify([]) // not tracked on bedrock body
    case 'look': return 'ok (look is a no-op on the bedrock body)'

    // perception that needs a world model — degrade gracefully (don't loop the brain)
    case 'scan': return JSON.stringify({ note: PERCEPTION_NOTE, self: { pos: self.pos, facing: facing(self.yaw) }, players: nearbyPlayers(), entities: summariseEntities(12) })
    case 'find': return PERCEPTION_NOTE
    case 'block': return PERCEPTION_NOTE

    // movement via teleport
    case 'goto': {
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: goto <x> <y> <z>'
      stopFollow()
      await sendCommand(`/tp @s ${x} ${y} ${z}`)
      return `teleported toward ${x},${y},${z}`
    }
    case 'come': {
      const t = findPlayer(a[0])
      if (!t) return `no player ${a[0] || 'nearby'}`
      stopFollow()
      await sendCommand(`/tp @s "${t.username}"`)
      return `came to ${t.username}`
    }
    case 'follow': {
      const t = findPlayer(a[0])
      if (!t) return `no player ${a[0] || 'nearby'}`
      stopFollow()
      const name = t.username
      followTimer = setInterval(() => { sendCommand(`/tp @s "${name}"`).catch(() => {}) }, 1500)
      return `following ${name} (teleport every 1.5s; 'stop' to end)`
    }
    case 'stop': stopFollow(); return 'stopped'
    case 'equip': case 'hold': return 'equip is not supported on the bedrock body (no inventory control)'
    case 'eat': return 'eat is not supported on the bedrock body (no inventory control)'

    // building / admin via server commands
    case 'setblock': {
      const [x, y, z] = a.slice(0, 3).map(Number)
      const block = a[3]
      if (!block || [x, y, z].some(Number.isNaN)) return 'usage: setblock <x> <y> <z> <block>'
      return await setblock(x, y, z, block)
    }
    case 'fill': {
      const n = a.slice(0, 6).map(Number)
      const block = a[6]
      if (!block || n.some(Number.isNaN)) return 'usage: fill <x1 y1 z1 x2 y2 z2> <block>'
      return await fill(...n, block)
    }
    case 'wall': return await buildWall(a[0] || 'stone', parseInt(a[1] || '5', 10), parseInt(a[2] || '3', 10), anchorInFront())
    case 'tower': return await buildTower(a[0] || 'stone', parseInt(a[1] || '10', 10), parseInt(a[2] || '3', 10), anchorInFront())
    case 'house': return await buildHouse(a[0] || 'oak_planks', parseInt(a[1] || '7', 10), parseInt(a[2] || '7', 10), parseInt(a[3] || '4', 10), anchorInFront(2))
    case 'clear': {
      const r = parseInt(a[0] || '8', 10)
      const b = blockPos()
      return await fill(b.x - r, b.y, b.z - r, b.x + r, b.y + r, b.z + r, 'air')
    }
    case 'give': {
      const item = a[0]
      if (!item) return 'usage: give <item> [count]'
      await sendCommand(`/give @s ${item} ${parseInt(a[1] || '64', 10)}`)
      return `gave ${a[1] || 64} ${item}`
    }
    case 'tp': {
      const [x, y, z] = a.map(Number)
      if ([x, y, z].some(Number.isNaN)) return 'usage: tp <x> <y> <z>'
      await sendCommand(`/tp @s ${x} ${y} ${z}`)
      return `tp -> ${x},${y},${z}`
    }
    case 'gamemode': await sendCommand(`/gamemode ${a[0] || 'creative'} @s`); return `gamemode ${a[0] || 'creative'}`

    default: return `unknown command: ${cmd} (try "help")`
  }
}

// ---- state assembly --------------------------------------------------------

function facing (yawDeg) {
  const dirs = ['south', 'west', 'north', 'east']
  return dirs[((Math.round(yawDeg / 90) % 4) + 4) % 4]
}

function nearbyPlayers () {
  return [...players.values()]
    .filter(p => p.username && p.username !== USERNAME && p.pos)
    .map(p => ({ name: p.username, dist: +dist(p.pos, self.pos).toFixed(1), pos: p.pos }))
    .sort((x, y) => x.dist - y.dist)
}

function summariseEntities (maxDist = 24) {
  return [...entities.values()]
    .filter(e => e.pos && dist(e.pos, self.pos) <= maxDist)
    .map(e => ({ type: e.type, dist: +dist(e.pos, self.pos).toFixed(1), pos: e.pos }))
    .sort((x, y) => x.dist - y.dist)
    .slice(0, 12)
}

function state () {
  return {
    body: 'bedrock',
    name: USERNAME,
    pos: self.pos,
    facing: facing(self.yaw),
    yaw: +self.yaw.toFixed(2),
    pitch: +self.pitch.toFixed(2),
    health: self.health,
    gameMode: self.gameMode,
    dimension: self.dimension,
    timeOfDay: self.time,
    spawned: self.spawned,
    // honest about what this body cannot perceive, so the brain doesn't chase it
    worldPerception: 'unavailable (no block model on bedrock body)',
    players: nearbyPlayers(),
    entities: summariseEntities()
  }
}

// ---- control API (identical contract to index.js) --------------------------

function send (res, code, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' })
  res.end(payload)
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, spawned: self.spawned })
  if (req.method === 'GET' && req.url === '/state') {
    // guard like /cmd: the brain polls this every loop, so a state-assembly
    // throw must never become an uncaught exception that kills the process
    try {
      const s = state()
      s.unanswered = recentChat.filter(c => !c.seen).map(c => ({ from: c.from, text: c.text }))
      recentChat.forEach(c => { c.seen = true })
      return send(res, 200, s)
    } catch (e) { return send(res, 500, `error: ${e.message}`) }
  }
  if (req.method === 'GET' && req.url === '/log') return send(res, 200, log.slice(-40).join('\n'))
  if (req.method === 'POST' && req.url === '/cmd') {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', async () => {
      let line = data
      try { const j = JSON.parse(data); if (j && typeof j.command === 'string') line = j.command } catch {}
      if (process.env.BRAIN_ALLOW_CHEATS !== '1' && CHEAT_CMDS.test(String(line).trim())) {
        note(`(cmd) ${line} -> BLOCKED (world-edit/admin is operator-only)`)
        return send(res, 200, 'blocked: world-editing/admin commands are operator-only')
      }
      try {
        const result = await handle(line)
        note(`(cmd) ${line} -> ${String(result).split('\n')[0]}`)
        send(res, 200, String(result))
      } catch (e) {
        note(`(cmd error) ${line} -> ${e.message}`)
        send(res, 500, `error: ${e.message}`)
      }
    })
    return
  }
  send(res, 404, 'not found')
})

server.listen(CONTROL_PORT, CONTROL_HOST, () => {
  note(`control API on http://${CONTROL_HOST}:${CONTROL_PORT}`)
})
