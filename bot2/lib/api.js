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
  // (reqUrl: only the BRAIN's poll - /state?brain=1 - spends a held message's delivery budget; the GUI's polls must not)
  // THE STATUS CACHE: the castle's status is a pass over every cell (14k here, 42k on the cathedral) and the hut's 149 -
  // worked out on every /state call, and the panel polls it every second or two: the body's event loop paid for it
  // whether anyone read it or not (the audit, 2026-09-27). Recomputed only when a block changed in the build or round
  // home (blockUpdate there moves `worldGen`), and stamped with its age.
  let worldGen = 1; let cache = { key: null }
  bot.on('blockUpdate', (o, n) => {
    const q = (n && n.position) || (o && o.position); if (!q) return
    const j = require('./build').getJob(); const h = mem.get().home
    if ((j && j.box && q.x >= j.box.x1 - 2 && q.x <= j.box.x2 + 2 && q.z >= j.box.z1 - 2 && q.z <= j.box.z2 + 2) || (h && Math.abs(q.x - h.x) <= 16 && Math.abs(q.z - h.z) <= 16)) worldGen++
  })
  // (cells unknown till their chunk loads - but only a chunk over the build or home counts: every chunk of a trek bumped
  //  it, several a second, and the full pass was back on every poll; audit D)
  bot.on('chunkColumnLoad', (c) => {
    if (!c) return
    const j = require('./build').getJob(); const h = mem.get().home
    const over = (x1, z1, x2, z2) => c.x <= x2 && c.x + 15 >= x1 && c.z <= z2 && c.z + 15 >= z1
    if ((j && j.box && over(j.box.x1 - 2, j.box.z1 - 2, j.box.x2 + 2, j.box.z2 + 2)) || (h && over(h.x - 16, h.z - 16, h.x + 16, h.z + 16))) worldGen++
  })
  const statuses = () => {
    const b = require('./build'); const hut = require('./hut')
    const j = b.getJob(); const h = mem.get().home
    const key = `${worldGen}|${j ? j.name + '@' + j.origin.x + ',' + j.origin.z : ''}|${h ? h.x + ',' + h.z : ''}` // (a new job or home is a new count)
    if (cache.key === key) return cache
    let st = null; let hs = null; let shell = false
    try { st = b.getJob() ? b.cachedStatus(bot) : null } catch {} // (build's own cache: one castle pass for everyone)
    try { hs = hut.status(bot); shell = hs ? hut.shellComplete(bot) : false } catch {}
    cache = { key, at: Date.now(), st, hs, shell }
    return cache
  }
  const state = (reqUrl = '') => {
    if (!bot.entity) return { name: bot.username, connected: false }
    const p = bot.entity.position
    const worn = inv.wornArmor(bot)
    const sc = statuses()
    const st = sc.st
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
      hazards: { underground: !world.openSky(bot, p.floored()), onFire: false, inLava: world.inLava(bot), inWater: world.feetInWater(bot), drowning: world.headInWater(bot), onGround: bot.entity.onGround,
        // (a drop that hurts beside the feet: the deploy gate's lip test - a reconnect's resync on a wall top or the rim
        //  slope can put the body over it; audit 2026-09-28)
        lip: (() => { const fy = Math.floor(p.y + 0.01); return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => world.dropAt(bot, Math.floor(p.x) + dx + 0.5, fy, Math.floor(p.z) + dz + 0.5) > world.SAFE_DROP) })() },
      savedBuild: mem.get().build ? { name: mem.get().build.name, at: mem.get().build.origin, held: false } : null,
      // what the build is and what it waits on - the brain answered "how's the build" with "starting on the wood" while the
      // real want was 1100 cobblestone (2026-09-27): the numbers it may quote, straight from the builder and the director
      buildProgress: st ? {
        name: st.name, blocksPlaced: st.done, blocksTotal: st.total, done: st.done, total: st.total, // (done/total: the panel's Build dialog reads them) percent: Math.round(1000 * st.done / Math.max(1, st.total)) / 10,
        topStillNeeded: Object.fromEntries(Object.entries(st.need || {}).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => [k.replace(/_/g, ' '), v])),
        materials: director.focus ? director.focus() : null,
        // handwork that stopped because its click did nothing (forage deadWork) - 234 cells waited seven hours on a silent
        // strip loop, and nothing here said so (audit 2026-09-28)
        stoppedWork: (() => { try { return require('./forage').stoppedWork() } catch { return [] } })()
      } : null,
      // where it is, in words the players use (distance to home and to the build site)
      whereAmI: (() => {
        const h = mem.get().home; const j = require('./build').getJob()
        const dh = h ? Math.round(world.dist2(p, h)) : null
        const site = j && j.box ? { x: (j.box.x1 + j.box.x2) / 2, z: (j.box.z1 + j.box.z2) / 2 } : null
        const ds = site ? Math.round(Math.hypot(p.x - site.x, p.z - site.z)) : null
        return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), blocksFromHome: dh, blocksFromBuildSite: ds, atHome: dh != null && dh < 12, atBuildSite: ds != null && ds < 30 }
      })(),
      // the base as it stands - what the brain answers "have you built your hut" from (with only the castle in its state it
      // answered every question about the base with the castle, 2026-09-27)
      base: (() => {
        try {
          const hs = sc.hs; const m = mem.get()
          const bedHeld = require('./inventory').items(bot).some(i => /_bed$/.test(i.name))
          // (where the bed is, and whether that is home: a field bed slept in on a trip is not "at home" - the audit)
          const bedAt = m.bed ? `placed at ${m.bed.x},${m.bed.y},${m.bed.z} (${m.home && world.dist2(m.bed, m.home) < 16 ? 'at home' : 'away from home'})` : null
          return {
            countedSecondsAgo: Math.round((Date.now() - sc.at) / 1000), // (as of the last block change: not a live count)
            hut: hs ? { blocksDone: hs.done, blocksTotal: hs.total, walledAndRoofed: sc.shell, complete: hs.done >= hs.total } : 'no hut planned (no home yet)',
            bed: bedAt || (bedHeld ? 'carried, not placed yet' : 'none'),
            chests: (m.chests || []).length, furnaces: (m.furnaces || []).length,
            farm: m.farm ? 'planted' : 'none', mine: m.mine ? { level: m.mine.level, blocksDug: m.mine.blocks } : 'none'
          }
        } catch { return null }
      })(),
      recent: director.recent ? director.recent() : [],
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
      unanswered: chat ? chat.pending(/[?&]brain=1(?:&|$)/.test(reqUrl || '')) : []
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url || ''
    if (req.method === 'OPTIONS') return send(res, 204, '')
    if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, spawned: !!bot.entity, connected: !!bot.entity, runtime: 'bot2' })
    if (req.method === 'GET' && (url === '/state' || url.startsWith('/state?'))) { try { return send(res, 200, state(url)) } catch (e) { return send(res, 500, 'error: ' + e.message) } }
    if (req.method === 'GET' && url === '/log') return send(res, 200, tail(40).join('\n'))
    // (the blocks as they stand round a point - read-only, for diagnosis: the blueprint is what should be there, this is what
    //  is. r at most 3, the non-air blocks with their states; 2026-09-29)
    if (req.method === 'GET' && url.startsWith('/blocks?')) {
      try {
        const q = new URLSearchParams(url.slice(8)); const x0 = Math.floor(+q.get('x')); const y0 = Math.floor(+q.get('y')); const z0 = Math.floor(+q.get('z')); const r = Math.min(3, Math.max(0, Math.floor(+(q.get('r') || 1))))
        if (![x0, y0, z0].every(Number.isFinite)) return send(res, 400, 'x, y, z wanted')
        const out = []
        for (let y = y0 - r; y <= y0 + r; y++) for (let z = z0 - r; z <= z0 + r; z++) for (let x = x0 - r; x <= x0 + r; x++) {
          const b = world.at(bot, x, y, z); if (!b || b.name === 'air' || b.name === 'cave_air') continue
          let props = {}; try { props = b.getProperties() || {} } catch {}
          out.push({ x, y, z, name: b.name, props })
        }
        return send(res, 200, out)
      } catch (e) { return send(res, 500, 'error: ' + e.message) }
    }
    if (req.method === 'GET' && url === '/chat') return send(res, 200, chat ? chat.tail().join('\n') : '')
    if (req.method === 'GET' && url === '/brain') return send(res, 200, { settings: brainSettings, models: [brainSettings.model] })
    if (req.method === 'GET' && url === '/pov') { if (!bot.entity || !pov) return send(res, 503, { ok: false }); return pov.requestFrame(bot, f => send(res, 200, f)) }
    if (req.method === 'GET' && url === '/director') return send(res, 200, { on: true, runtime: 'bot2', task: director.info(), paused: director.isPaused() })
    if (req.method === 'GET' && url === '/config') {
      let saved = {}
      try { saved = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf8')) } catch {}
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
          try {
            const out = await commands.handle(line, { source: 'brain' }) // (a reply marks its message answered in the chat gate)
            return send(res, 200, out)
          } catch (e) { return send(res, 500, 'error: ' + e.message) }
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
