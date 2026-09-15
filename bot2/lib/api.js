'use strict'
// Control API on the same port the Animus panel and the brain already use. /state keeps the
// fields the panel reads. /op/cmd is the operator console; /cmd is the brain (chat + looking).
const http = require('http')
const world = require('./world')
const inv = require('./inventory')
const mem = require('./memory')
const reflex = require('./reflex')
const { log, tail } = require('./log')

function send (res, code, body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(s)
}

function start ({ bot, port, host, director, commands, brainSettings, pov, chat }) {
  const state = () => {
    if (!bot.entity) return { name: bot.username, connected: false }
    const p = bot.entity.position
    const worn = inv.wornArmor(bot)
    const b = require('./build')
    const st = b.getJob() ? b.status(bot) : null
    const act = director.info()
    const rf = reflex.info()
    return {
      name: bot.username,
      pos: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 },
      health: Math.round(bot.health * 10) / 10,
      food: bot.food,
      oxygen: bot.oxygenLevel,
      gameMode: bot.game ? bot.game.gameMode : null,
      dimension: bot.game ? bot.game.dimension : null,
      biome: (() => { try { const bl = bot.blockAt(p.offset(0, -1, 0)); return bl && bl.biome ? bl.biome.name : null } catch { return null } })(),
      timeOfDay: world.tod(bot),
      isDay: world.isDay(bot),
      isRaining: !!bot.isRaining,
      heldItem: bot.heldItem ? bot.heldItem.name : null,
      wearing: { head: worn.head ? worn.head.name : null, torso: worn.torso ? worn.torso.name : null, legs: worn.legs ? worn.legs.name : null, feet: worn.feet ? worn.feet.name : null },
      inventory: Object.entries(inv.counts(bot)).map(([k, v]) => `${k} x${v}`),
      players: Object.keys(bot.players || {}).filter(n => n !== bot.username),
      alone: Object.keys(bot.players || {}).filter(n => n !== bot.username).length === 0,
      threat: reflex.nearestThreat(),
      moving: !!(bot.pathfinder && bot.pathfinder.isMoving()),
      busy: !!act,
      activity: rf ? { name: 'reflex:' + rf.kind, detail: rf.detail || '', forSec: rf.forSec } : act,
      maneuver: rf ? { label: rf.kind, tier: 'SURVIVE' } : null,
      hold: null,
      goal: bot.pathfinder && bot.pathfinder.goal ? bot.pathfinder.goal.constructor.name : null,
      hazards: { underground: !world.openSky(bot, p.floored()), onFire: false, inLava: world.inLava(bot), inWater: world.feetInWater(bot), drowning: world.headInWater(bot), onGround: bot.entity.onGround },
      savedBuild: mem.get().build ? { name: mem.get().build.name, at: mem.get().build.origin, held: false } : null,
      buildProgress: st ? { phase: 'castle', have: st.done, need: st.total, done: st.done, total: st.total } : null,
      checklist: null,
      progress: { stalled: false },
      stuck: null,
      home: mem.get().home,
      bed: mem.get().bed,
      mine: mem.get().mine ? { cursor: mem.get().mine.cursor, blocks: mem.get().mine.blocks } : null,
      bank: require('./base').bankCounts(),
      deaths: (mem.get().stats || {}).deaths || 0,
      paused: director.isPaused(),
      waypoints: [],
      unanswered: chat ? chat.pending() : []
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url || ''
    if (req.method === 'OPTIONS') return send(res, 204, '')
    if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, spawned: !!bot.entity, connected: !!bot.entity, runtime: 'bot2' })
    if (req.method === 'GET' && (url === '/state' || url.startsWith('/state?'))) { try { return send(res, 200, state()) } catch (e) { return send(res, 500, 'error: ' + e.message) } }
    if (req.method === 'GET' && url === '/log') return send(res, 200, tail(40).join('\n'))
    if (req.method === 'GET' && url === '/chat') return send(res, 200, chat ? chat.tail().join('\n') : '')
    if (req.method === 'GET' && url === '/brain') return send(res, 200, { settings: brainSettings, models: [brainSettings.model] })
    if (req.method === 'GET' && url === '/pov') { if (!bot.entity || !pov) return send(res, 503, { ok: false }); return pov.requestFrame(bot, f => send(res, 200, f)) }
    if (req.method === 'GET' && url === '/director') return send(res, 200, { on: true, runtime: 'bot2', task: director.info(), paused: director.isPaused() })
    if (req.method === 'GET' && url === '/config') {
      let saved = {}
      try { saved = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'bot', 'config.json'), 'utf8')) } catch {}
      return send(res, 200, Object.assign({}, saved, { connected: !!bot.entity }))
    }
    if (req.method === 'POST') {
      let data = ''
      req.on('data', c => { data += c })
      req.on('end', async () => {
        let j = {}
        try { j = JSON.parse(data) } catch { j = { command: data } }
        if (url === '/brain') {
          if (j.model != null) brainSettings.model = String(j.model)
          if (j.goal != null) brainSettings.goal = String(j.goal)
          if (j.enabled != null) brainSettings.enabled = !!j.enabled
          return send(res, 200, brainSettings)
        }
        if (url === '/config') {
          send(res, 200, { ok: true, reconnect: !!j.reconnect })
          if (j.reconnect) setTimeout(() => { log('api', 'restart requested'); process.exit(0) }, 400)
          return
        }
        const line = String(j.command || '').trim()
        if (url === '/op/cmd') {
          try { const out = await commands.handle(line, { source: 'operator' }); log('op', `${line} -> ${String(out).split('\n')[0].slice(0, 200)}`); return send(res, 200, out) } catch (e) { return send(res, 500, 'error: ' + e.message) }
        }
        if (url === '/cmd') {
          // the brain may talk and look; the director drives the body
          if (!/^(say|state|inventory|look|scan|entities)\b/i.test(line)) return send(res, 200, 'the director drives the body - you can say things')
          try { const out = await commands.handle(line, { source: 'brain' }); return send(res, 200, out) } catch (e) { return send(res, 500, 'error: ' + e.message) }
        }
        return send(res, 404, 'not found')
      })
      return
    }
    return send(res, 404, 'not found')
  })
  server.listen(port, host, () => log('api', `control API on http://${host}:${port}`))
  server.on('error', e => { log('api', 'server error: ' + e.message); if (e.code === 'EADDRINUSE') setTimeout(() => process.exit(1), 2000) })
  return server
}

module.exports = { start }
