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

function snapshot (bot) {
  if (!bot.entity || bot.health <= 0) return
  lastInventory = inv.items(bot).map(i => ({ name: i.name, count: i.count }))
  for (const a of Object.values(inv.wornArmor(bot))) if (a) lastInventory.push({ name: a.name, count: 1 })
  lastPos = bot.entity.position.floored()
}

function install (bot) {
  setInterval(() => snapshot(bot), 1000)
  bot.on('death', () => {
    const p = lastPos || (bot.entity ? bot.entity.position.floored() : null)
    if (!p) return
    const items = lastInventory.reduce((s, i) => s + i.count, 0)
    const valuable = lastInventory.filter(i => /_(pickaxe|sword|axe|helmet|chestplate|leggings|boots)$|iron|diamond|_bed$/.test(i.name)).map(i => i.name)
    let cause = 'unknown'
    try {
      const feet = world.at(bot, p.x, p.y, p.z)
      if (feet && world.isLavaBlock(feet)) cause = 'lava'
      else if (feet && world.isWaterBlock(feet)) cause = 'water'
      else if (p.y < -60) cause = 'void'
    } catch {}
    const d = { x: p.x, y: p.y, z: p.z, t: Date.now(), items, valuable, cause, retrieved: items === 0 }
    mem.update(m => { m.deaths.push(d); if (m.deaths.length > 30) m.deaths.shift() })
    mem.bump('deaths')
    log('death', `died at ${move.fmt(p)} (${cause}) carrying ${items} items${valuable.length ? ': ' + valuable.slice(0, 6).join(',') : ''}`)
  })
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
  const trapped = d => deaths.some(o => o !== d && world.dist3(o, d) < 16 && (o.t > d.t || Math.abs(o.t - d.t) < 60 * 60000))
  // a drowning underground (a flooded tunnel) is not a place to swim back into
  const home = mem.get().home
  const floodedTunnel = d => d.cause === 'water' && home && d.y < home.y - 10
  const list = deaths.filter(d => !d.retrieved && !d.abandoned && now - d.t < MAX_AGE_MS && d.cause !== 'lava' && d.cause !== 'void' && !floodedTunnel(d) && worth(d) && !trapped(d))
  list.sort((a, b) => (b.valuable.length * 20 + b.items) / (world.dist2(b, bot.entity.position) + 20) - (a.valuable.length * 20 + a.items) / (world.dist2(a, bot.entity.position) + 20))
  return list[0] || null
}

function mark (d, field) {
  mem.update(m => { const x = m.deaths.find(q => q.t === d.t); if (x) x[field] = true })
}

async function recover (bot, d, { shouldStop } = {}) {
  if (!d) return false
  log('grave', `going back for my stuff at ${move.fmt(d)} (${d.items} items)`)
  const r = await move.travel(bot, d, { range: 2, shouldStop, label: 'to grave' })
  if (!r.ok && world.dist3(bot.entity.position, d) > 6) {
    mem.update(m => { const x = m.deaths.find(q => q.t === d.t); if (x) x.tries = (x.tries || 0) + 1; if (x && x.tries >= 3) x.abandoned = true })
    return false
  }
  const before = inv.items(bot).reduce((s, i) => s + i.count, 0)
  let cands = []
  // the grave plugin moves a grave out of water/void to safe ground nearby: look around, not just on the spot
  for (let i = 0; i < 10 && !cands.length; i++) {
    cands = Object.values(bot.entities).filter(e => e && e.position && Math.abs(e.position.y - d.y) <= 12 && world.dist2(e.position, d) <= 10 &&
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
  if (gained > 0 || cands.length === 0) mark(d, gained > 0 ? 'retrieved' : 'abandoned')
  return gained > 0
}

module.exports = { install, bestGrave, recover }
