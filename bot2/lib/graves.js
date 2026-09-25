'use strict'
// Deaths and graves. The server's grave plugin (AxGraves) keeps items in an entity at the death
// spot; right-clicking it opens a GUI. A grave is worth a trip when it holds real gear, is fresh,
// and the thing that killed us there (lava, the void, deep water) is not still waiting.
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const { log } = require('./log')

const MAX_AGE_MS = 12 * 60000 // graves on this server were gone by ~19 min (one found at 9 min)
let lastInventory = []
let lastPos = null
// the last ~10s of where we were (a second apart): a death record says how the body got there - a fall on the mine
// stairs 110 blocks out left only "died at y41" and no way to tell where the ground went (2026-09-24)
const trail = []

function snapshot (bot) {
  if (!bot.entity || bot.health <= 0) return
  lastInventory = inv.items(bot).map(i => ({ name: i.name, count: i.count }))
  for (const a of Object.values(inv.wornArmor(bot))) if (a) lastInventory.push({ name: a.name, count: 1 })
  lastPos = bot.entity.position.floored()
  trail.push({ x: lastPos.x, y: lastPos.y, z: lastPos.z, g: !!bot.entity.onGround })
  if (trail.length > 10) trail.shift()
}

// What killed us, in the server's own words. Every vanilla death message is "<name> <how>" ("was shot by Skeleton",
// "fell from a high place", "drowned") and it arrives with the death itself (a few ms either side of the health
// packet). The block under the body only knew "water" or "lava": 16 of 20 deaths on 2026-09-23 were "unknown", and
// three "water" deaths were Drowned killing the bot, not the air running out.
function classify (msg) {
  const m = String(msg || '')
  const by = (m.match(/ (?:by|from|fighting|escape) (?:an? |the )?([A-Z][A-Za-z ]*?|[a-z_]+)(?: using .*| whilst .*| while .*)?$/) || [])[1]
  const kind = /drowned$|drowned whilst|drowned while/.test(m) ? 'drown'
    : /lava/.test(m) ? 'lava'
    : /burn|went up in flames|fire|walked into the danger zone/.test(m) ? 'fire'
    : /fell|hit the ground|high place|fall|doomed to fall|squashed/.test(m) ? 'fall'
    : /out of the world|didn't want to live/.test(m) ? 'void'
    : /suffocated|squished|crammed/.test(m) ? 'suffocate'
    : /starved/.test(m) ? 'starve'
    : /blew up|blown up|explod/.test(m) ? 'explosion'
    : /slain|shot|killed|impaled|stung|fireballed|pummeled|skewered|obliterated/.test(m) ? 'mob'
    : 'other'
  return { kind, by: by ? by.trim().toLowerCase().replace(/ /g, '_') : null }
}

let lastMsg = null // { text, t } - the server's last line about us
let lastDeathT = 0

function install (bot) {
  setInterval(() => snapshot(bot), 1000)
  const me = () => bot.username + ' '
  bot.on('messagestr', (msg, position) => {
    if (position === 'chat' || !msg.startsWith(me())) return
    const text = msg.slice(me().length)
    if (/^(joined|left) the game|^has made the advancement|^has completed|^has reached/.test(text)) return
    lastMsg = { text, t: Date.now() }
    // (the message came after the death: fill in the record already written)
    if (lastDeathT && Date.now() - lastDeathT < 3000) {
      const c = classify(text)
      mem.update(m => { const x = (m.deaths || []).find(q => q.t === lastDeathT); if (x) { x.msg = text; x.cause = placeCause(x.place, c.kind); x.by = c.by } })
      log('death', `cause (server): ${text}`)
    }
  })
  bot.on('death', () => {
    const p = lastPos || (bot.entity ? bot.entity.position.floored() : null)
    if (!p) return
    const items = lastInventory.reduce((s, i) => s + i.count, 0)
    const valuable = lastInventory.filter(i => /_(pickaxe|sword|axe|helmet|chestplate|leggings|boots)$|iron|diamond|_bed$/.test(i.name)).map(i => i.name)
    let place = null
    try {
      const feet = world.at(bot, p.x, p.y, p.z)
      if (feet && world.isLavaBlock(feet)) place = 'lava'
      else if (feet && world.isWaterBlock(feet)) place = 'water'
      else if (p.y < -60) place = 'void'
    } catch {}
    const now = Date.now()
    const said = lastMsg && now - lastMsg.t < 3000 ? lastMsg.text : null
    const c = said ? classify(said) : { kind: null, by: null }
    let hurt = null
    try { hurt = require('./reflex').lastHurt() } catch {}
    const d = { x: p.x, y: p.y, z: p.z, t: now, items, valuable, cause: placeCause(place, c.kind), place, by: c.by, msg: said, lastHurtBy: hurt && hurt.by, task: null, sky: (() => { try { return world.openSky(bot, p) } catch { return null } })(), trail: trail.map(q => `${q.x},${q.y},${q.z}${q.g ? '' : '^'}`).join(' ') }
    try { const ti = require('./director').info(); d.task = ti && ti.name } catch {}
    lastDeathT = now
    // killed on the way back for a grave: that grave is a trap, however far along the way it happened (a grave at
    // y-14 in a cave killed the bot twice, the second time 30 blocks short of it, 2026-09-23)
    const going = mem.get().recovering
    // (and the grave this death leaves is in the same trap: going back for THAT one took the bot down the ravine again)
    if (going && Date.now() - going.at < 10 * 60000) { d.abandoned = true; mem.update(m => { const x = (m.deaths || []).find(q => q.t === going.t); if (x) { x.abandoned = true; log('grave', `died going back for the grave at ${x.x},${x.y},${x.z} - leaving it, and this one`) } m.recovering = null }) }
    mem.update(m => { m.deaths.push(d); if (m.deaths.length > 30) m.deaths.shift() })
    mem.bump('deaths')
    log('death', `trail (1/s, ^ = off the ground): ${d.trail}`)
    log('death', `died at ${move.fmt(p)} (${said || d.cause}${place ? ', in ' + place : ''}${hurt && hurt.by ? ', last hit by ' + hurt.by + ' ' + Math.round((now - hurt.at) / 100) / 10 + 's before' : ''}${d.task ? ', task ' + d.task : ''}) carrying ${items} items${valuable.length ? ': ' + valuable.slice(0, 6).join(',') : ''}`)
  })
}

// ONE cause per death: the server's word for it when we have it, else where the body lay. lava/void from either
// (a grave in lava or the void is gone either way).
function placeCause (place, kind) {
  if (place === 'lava' || kind === 'lava') return 'lava'
  if (place === 'void' || kind === 'void') return 'void'
  return kind || (place === 'water' ? 'water' : 'unknown')
}

function bestGrave (bot) {
  if (!bot.entity) return null
  const now = Date.now()
  // a grave is worth the walk in proportion to what is in it: tools/armour/a bed justify a long trip,
  // a handful of dirt from a respawn death does not (it would walk back into the same trap)
  const worth = d => {
    const dist = world.dist2(d, bot.entity.position)
    if (d.valuable && d.valuable.length) return dist < 400
    if (d.items >= 64) return dist < 200
    return d.items >= 4 && dist < 48
  }
  const deaths = mem.get().deaths || []
  // died again near a grave while going back for it: that spot is a trap - leave it
  // (or two deaths in the same place within the hour, whichever grave is newer - both are the same trap)
  const trapped = d => deaths.some(o => o !== d && world.dist3(o, d) < 24 && (o.t > d.t || Math.abs(o.t - d.t) < 60 * 60000))
  // a drowning underground (a flooded tunnel) is not a place to swim back into
  const home = mem.get().home
  // (underground = no sky over the spot, recorded at the death; "10 below home" stood in for it and on a mountain-top
  //  home an open lake 54 below counted as a flooded tunnel - a 365-item grave never looked for, 2026-09-24)
  const floodedTunnel = d => (d.place || (d.cause === 'water' ? 'water' : null)) === 'water' && (d.sky != null ? !d.sky : (home && d.y < home.y - 10))
  const list = deaths.filter(d => !d.retrieved && !d.abandoned && now - d.t < MAX_AGE_MS && d.cause !== 'lava' && d.cause !== 'void' && !floodedTunnel(d) && worth(d) && !trapped(d))
  list.sort((a, b) => (b.valuable.length * 20 + b.items) / (world.dist2(b, bot.entity.position) + 20) - (a.valuable.length * 20 + a.items) / (world.dist2(a, bot.entity.position) + 20))
  return list[0] || null
}

function mark (d, field) {
  mem.update(m => { const x = m.deaths.find(q => q.t === d.t); if (x) x[field] = true })
}

async function recover (bot, d, opts = {}) {
  try { return await recoverInner(bot, d, opts) } finally { if (bot.health > 0) mem.set('recovering', null) }
}
async function recoverInner (bot, d, { shouldStop } = {}) {
  if (!d) return false
  log('grave', `going back for my stuff at ${move.fmt(d)} (${d.items} items)`)
  mem.set('recovering', { t: d.t, at: Date.now() })
  const r = await move.travel(bot, d, { range: 2, shouldStop, label: 'to grave' })
  if (!r.ok && world.dist3(bot.entity.position, d) > 6) {
    mem.update(m => { const x = m.deaths.find(q => q.t === d.t); if (x) x.tries = (x.tries || 0) + 1; if (x && x.tries >= 3) x.abandoned = true })
    return false
  }
  const before = inv.items(bot).reduce((s, i) => s + i.count, 0)
  let cands = []
  // the grave plugin moves a grave out of water/void to safe ground nearby: look around, not just on the spot
  for (let i = 0; i < 10 && !cands.length; i++) {
    // (the plugin moves a grave to safe ground - 16 blocks down a cave from where the body was last seen, 2026-09-24:
    //  the whole column counts, the nearest first)
    cands = Object.values(bot.entities).filter(e => e && e.position && Math.abs(e.position.y - d.y) <= 32 && world.dist2(e.position, d) <= 10 &&
      /armor_stand|item_display|block_display|text_display|interaction/.test(e.name || ''))
    if (!cands.length) await move.sleep(500)
  }
  if (!cands.length) {
    const seen = Object.values(bot.entities).filter(e => e && e.position && e !== bot.entity && world.dist2(e.position, d) <= 24).map(e => `${e.name}@${move.fmt(e.position)}`)
    log('grave', `no grave entity near ${move.fmt(d)} - nearby entities: ${seen.slice(0, 12).join(' ') || 'none'}`)
  } else {
    cands.sort((a, b) => world.dist3(a.position, d) - world.dist3(b.position, d))
    const c0 = cands[0]
    if (world.dist3(c0.position, bot.entity.position) > 3) await move.goTo(bot, new goals.GoalNear(c0.position.x, c0.position.y, c0.position.z, 2), { timeoutMs: 20000, label: 'to grave entity' })
  }
  for (const g of cands) {
    await move.goTo(bot, new goals.GoalNear(g.position.x, g.position.y, g.position.z, 2), { timeoutMs: 10000 })
    const invBefore = inv.items(bot).reduce((s, i) => s + i.count, 0)
    for (const how of ['interact_at', 'interact', 'attack']) {
      try { await bot.lookAt(g.position.offset(0, 0.4, 0), true) } catch {}
      try {
        if (how === 'interact_at' && bot.activateEntityAt) await bot.activateEntityAt(g, g.position)
        else if (how === 'interact') await bot.activateEntity(g)
        else bot.attack(g)
      } catch {}
      await move.sleep(700)
      if (bot.currentWindow || inv.items(bot).reduce((s, i) => s + i.count, 0) > invBefore) break
    }
    const w = bot.currentWindow
    if (w) {
      const end = w.inventoryStart != null ? w.inventoryStart : w.slots.length - 36
      for (let pass = 0; pass < 4; pass++) {
        let any = false
        for (let s = 0; s < end; s++) {
          if (bot.currentWindow !== w) break
          if (w.slots[s] && inv.freeSlots(bot) > 0) { any = true; try { await bot.clickWindow(s, 0, 1) } catch {} ; await move.sleep(100) }
        }
        if (!any) break
        await move.sleep(300)
      }
      try { bot.closeWindow(w) } catch {}
    }
    await act.collectDrops(bot, { radius: 8, maxMs: 10000 })
  }
  const gained = inv.items(bot).reduce((s, i) => s + i.count, 0) - before
  await inv.wearBestArmor(bot)
  log('grave', `recovered ${gained} items at ${move.fmt(d)}`)
  // done only when most of it came back: one stray item picked up by the spot marked a 308-item grave "retrieved"
  if (gained >= Math.max(1, Math.floor(d.items / 2))) mark(d, 'retrieved')
  else if (cands.length === 0) mark(d, 'abandoned')
  else mem.update(m => { const x = m.deaths.find(q => q.t === d.t); if (x) { x.tries = (x.tries || 0) + 1; if (x.tries >= 3) x.abandoned = true } })
  return gained > 0
}

module.exports = { install, bestGrave, recover, classify }
