'use strict'
// Operator console (Animus panel, /op/cmd, in-game "!" from an operator). Plain verbs that call
// straight into the skills. The brain's /cmd path only reaches say/state/inventory.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const mem = require('./memory')
const { log } = require('./log')

const FLAG = require('path').join(__dirname, '..', 'paused.flag')
function setFlag (on) { try { if (on) require('fs').writeFileSync(FLAG, new Date().toISOString()); else require('fs').unlinkSync(FLAG) } catch {} }

function make (bot, director) {
  const craft = require('./craft')
  const base = require('./base')
  const build = require('./build')
  const mining = require('./mining')
  const food = require('./food')
  const shelter = require('./shelter')
  const smelt = require('./smelt')

  let running = null
  let lastSaidAt = 0
  let lastPlayerChatAt = 0
  const recentSaid = []
  bot.on('chat', (from) => { if (from !== bot.username) lastPlayerChatAt = Date.now() })
  async function exclusive (label, fn) {
    if (running) return `busy with ${running}`
    running = label
    const wasPaused = director.isPaused()
    director.setPaused(true)
    await director.waitIdle()
    try { return await fn() } finally { running = null; if (!wasPaused) director.setPaused(false) }
  }

  async function handle (line, { source = 'operator' } = {}) {
    const parts = String(line).trim().split(/\s+/)
    const cmd = (parts[0] || '').toLowerCase().replace(/^!/, '')
    const a = parts.slice(1)
    const num = (i, d) => { const n = parseInt(a[i], 10); return Number.isFinite(n) ? n : d }
    switch (cmd) {
      case '': case 'help':
        return 'bot2 commands: status | pause | resume | task <name> | decide | say <msg> | inventory | ensure <item> [n] | goto <x y z> | home | sethome [x y z] | build <schem> <x y z> [corner] | buildstatus | mine [n] | deposit | food | bed | bunker | sleep | smelt <output> [n] | collect | stop'
      case 'say': {
        const msg = a.join(' ').replace(/^\/+/, '').trim()
        if (!msg) return 'nothing to say'
        if (source !== 'operator') {
          const now = Date.now()
          const addressed = now - lastPlayerChatAt < 120000
          if (recentSaid.includes(msg.toLowerCase())) return 'skipped - said that already'
          if (!addressed && now - lastSaidAt < 5 * 60000) return 'skipped - nobody is talking to me, keep it rare'
          lastSaidAt = now
          recentSaid.push(msg.toLowerCase()); if (recentSaid.length > 20) recentSaid.shift()
        }
        bot.chat(msg.slice(0, 250)); return 'said'
      }
      case 'status': case 'state': {
        const d = director.info()
        const st = build.getJob() ? build.status(bot) : null
        const p = bot.entity ? bot.entity.position : null
        return JSON.stringify({ pos: p && move.fmt(p), hp: bot.health, food: bot.food, task: d, paused: director.isPaused(), home: mem.get().home, bed: mem.get().bed, build: st && { done: st.done, total: st.total, need: st.need }, packFood: inv.foodPoints(bot) })
      }
      case 'inventory': return Object.entries(inv.counts(bot)).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty'
      case 'decide': { const d = director.decide(); return `${d.name}: ${d.why}` }
      case 'pause': director.setPaused(true); move.stopMoving(bot); setFlag(true); return 'paused'
      case 'resume': director.setPaused(false); setFlag(false); return 'resumed'
      case 'stop': director.setPaused(true); move.stopMoving(bot); setFlag(true); return 'stopped (paused) - "resume" to continue'
      case 'task': { director.setPaused(false); return director.forceTask(a[0]) ? `next task: ${a[0]}` : 'unknown task: ' + Object.keys(director.TASKS).join(', ') }
      case 'ensure': case 'obtain': return exclusive('ensure', async () => { const ok = await craft.ensure(bot, a[0], num(1, 1)); return `ensure ${a[0]}: ${ok ? 'ok' : 'failed'} (holding ${inv.count(bot, a[0])})` })
      case 'goto': return exclusive('goto', async () => { const r = await move.travel(bot, { x: num(0), y: num(1), z: num(2) }, { range: 2 }); return `goto: ${r.ok ? 'arrived' : r.why}` })
      case 'home': return exclusive('home', async () => { const r = await base.goHome(bot); return `home: ${r.ok ? 'arrived' : r.why}` })
      case 'sethome': {
        const p = a.length >= 3 ? { x: num(0), y: num(1), z: num(2) } : world.feetPos(bot)
        base.setHome(p); return `home set ${move.fmt(p)}`
      }
      case 'build': {
        const name = a[0]
        if (!name || a.length < 4) return 'usage: build <schematic> <x> <y> <z> [corner]   (coords are the CENTRE unless "corner")'
        let origin = { x: num(1), y: num(2), z: num(3) }
        const corner = a.includes('corner')
        const s = await build.loadSchematic(name, bot.version)
        if (!corner) { const en = s.end(); const st = s.start(); origin = { x: origin.x - Math.floor((en.x - st.x) / 2), y: origin.y, z: origin.z - Math.floor((en.z - st.z) / 2) } }
        await build.setJob(bot, name, origin)
        return `build job set: ${name} origin ${move.fmt(origin)}`
      }
      case 'door': return exclusive('door', async () => { const g = new goals.GoalBlock(num(0), num(1), num(2)); const ok = await move.crossDoor(bot, g).catch(e => 'threw ' + e.stack); return `crossDoor: ${ok} now at ${move.fmt(bot.entity.position)}` })
      case 'furnaces': return exclusive('furnaces', async () => {
        const home = mem.get().home
        const out = []
        for (const fb of world.findBlocks(bot, /^furnace$/, { maxDistance: 16, count: 20, point: new Vec3(home.x, home.y, home.z) })) {
          try {
            if (!require('./act').reach(bot, fb.position, 4)) await move.goTo(bot, new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2), { timeoutMs: 15000, label: 'to furnace' })
            const f = await bot.openFurnace(bot.blockAt(fb.position))
            const n = it => it ? `${it.name}x${it.count}` : '-'
            out.push(`${move.fmt(fb.position)} in=${n(f.inputItem())} fuel=${n(f.fuelItem())} out=${n(f.outputItem())}`)
            f.close()
          } catch (e) { out.push(`${move.fmt(fb.position)} ${e.message}`) }
        }
        return out.join(' | ')
      })
      case 'obs': {
        if (!build.getJob()) return 'no build job'
        const t = {}; const ex = []
        for (const b of build.unskippedObstructions(bot)) { if (world.LEAF_RE.test(b.name)) continue; t[b.name] = (t[b.name] || 0) + 1; if (ex.length < 30) ex.push(`${b.name}@${b.position.x},${b.position.y},${b.position.z}`) }
        return JSON.stringify({ tally: t, ex })
      }
      case 'missing': {
        // missing - every unfinished cell of the build (what is there now), and filler/scaffold blocks
        // standing in or round the footprint that are not part of it
        const j = build.getJob()
        if (!j) return 'no build job'
        // (the state compared is only what makes the look: facing/half/type/axis/hanging - build.wantOf)
        const miss = j.cells.filter(c => build.cellDone(bot, c) !== true).map(c => { const b = world.at(bot, c.x, c.y, c.z); let p = ''; try { const bp = b ? b.getProperties() : {}; p = build.KEY_PROPS.filter(k => bp[k] != null).map(k => `${k}=${bp[k]}`).join(',') } catch {} ; const w = build.wantOf(c); return `${c.x},${c.y},${c.z} want ${c.name}${w ? JSON.stringify(w) : ''} have ${b ? b.name + (p ? '[' + p + ']' : '') : 'unloaded'}` })
        const s = build.survey(bot, 0, { full: true })
        return JSON.stringify({ missing: miss.length, cells: miss.slice(0, 60), snapshot: s.snapshot, strayFiller: s.scaffold.length, stray: s.scaffold.slice(0, 80).map(p => `${p.name}@${p.x},${p.y},${p.z}`), holes: s.holes.length, complete: build.complete(bot) })
      }
      // scaffold - what the bot left standing round the build: the diff against the site snapshot (blocks where
      // the site was open that are filler or crafted, not cells of the build), and the holes left in the ground
      case 'scaffold': {
        if (!build.getJob()) return 'no build job'
        const s = build.survey(bot, 0, { full: true })
        if (!s.snapshot) return 'no site snapshot yet - see "snapshot"'
        const t = {}; for (const p of s.scaffold) t[p.name] = (t[p.name] || 0) + 1
        return JSON.stringify({ scaffold: s.scaffold.length, tally: t, blocks: s.scaffold.slice(0, 120).map(p => `${p.name}@${p.x},${p.y},${p.z} (was ${p.was})`), holes: s.holes.length, holeList: s.holes.slice(0, 40).map(p => `${p.x},${p.y},${p.z} (was ${p.was})`) })
      }
      case 'snapshot': { const i = build.snapshotInfo(bot); return i ? JSON.stringify(i) : 'no build job' }
      case 'crafttrace': return exclusive('crafttrace', async () => {
        // crafttrace <item> - craft one and record the window traffic (clicks out, slot updates in)
        const md = world.data(bot)
        const nm = id => (md.items[id] || {}).name || id
        const trace = []
        const t0 = Date.now()
        const T = () => Date.now() - t0
        const w0 = bot._client.write.bind(bot._client)
        bot._client.write = (name, p) => { if (/window_click|close_window|place_recipe|craft_recipe/.test(name)) trace.push(`${T()} OUT ${name} slot=${p.slot} btn=${p.mouseButton} mode=${p.mode} state=${p.stateId} cursor=${p.cursorItem ? nm(p.cursorItem.itemId) + 'x' + p.cursorItem.itemCount : '-'} changed=${(p.changedSlots || []).map(c => c.location + ':' + (c.item ? nm(c.item.itemId) + 'x' + c.item.itemCount : '-')).join(',')}`); return w0(name, p) }
        const onPacket = (p, meta) => {
          if (meta.name === 'set_slot' && p.windowId !== 0 || (meta.name === 'set_slot' && p.slot <= 9)) trace.push(`${T()} IN set_slot w=${p.windowId} slot=${p.slot} state=${p.stateId} ${p.item && p.item.itemCount ? nm(p.item.itemId) + 'x' + p.item.itemCount : '-'}`)
          else if (meta.name === 'window_items') trace.push(`${T()} IN window_items w=${p.windowId} state=${p.stateId} grid=${(p.items || []).slice(0, 10).map(i => i && i.itemCount ? nm(i.itemId) + 'x' + i.itemCount : '-').join(',')}`)
          else if (/cursor|open_window|close_window|recipe/.test(meta.name)) trace.push(`${T()} IN ${meta.name} ${JSON.stringify(p).slice(0, 120)}`)
        }
        bot._client.on('packet', onPacket)
        let res
        try { res = await craft.craftItem(bot, a[0], 1, {}) } catch (e) { res = 'threw ' + e.message } finally { bot._client.write = w0; bot._client.removeListener('packet', onPacket) }
        return JSON.stringify({ res, have: inv.count(bot, a[0]), trace: trace.slice(0, 80) })
      })
      case 'heights': {
        // heights x1 z1 x2 z2 [step] - top solid (non-leaf, non-plant) block per column, as rows of y-values (last two digits)
        const [x1, z1, x2, z2] = [0, 1, 2, 3].map(i => num(i)); const step = num(4, 1)
        const rows = []; const tally = {}
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z += step) {
          let r = ''
          for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += step) {
            let y = null
            for (let yy = 110; yy > 40; yy--) { const b = world.at(bot, x, yy, z); if (!b) break; if (world.isSolid(b) && !world.LEAF_RE.test(b.name) && !world.LOG_RE.test(b.name)) { y = yy; tally[b.name] = (tally[b.name] || 0) + 1; break } if (world.isWaterBlock(b)) { y = -yy; break } }
            r += y == null ? ' ..' : y < 0 ? ' ~' + String(-y % 100).padStart(2, '0') : ' ' + String(y % 100).padStart(2, '0')
          }
          rows.push(`${z}:${r}`)
        }
        return JSON.stringify({ rows, tally })
      }
      case 'boattest': return exclusive('boattest', async () => {
        // boattest x z - launch a boat toward x,z, sit 2s, then try to get out while tracing the server's answers
        const boat = require('./boat')
        const tr = []; const t0 = Date.now(); const T = () => Date.now() - t0
        const onP = (p, meta) => { if (/set_passengers|attach_entity|position|vehicle_move|entity_destroy|remove_entities|dismount|player_rotation/.test(meta.name)) tr.push(`${T()} IN ${meta.name} ${JSON.stringify(p).slice(0, 110)}`) }
        const w0 = bot._client.write.bind(bot._client)
        bot._client.write = (n, p) => { if (/player_input|use_entity|interact|vehicle_move|steer_boat|entity_action|player_command/.test(n)) tr.push(`${T()} OUT ${n} ${JSON.stringify(p).slice(0, 110)}`); return w0(n, p) }
        bot._client.on('packet', onP)
        let res = ''
        try {
          if (!inv.items(bot).some(i => /_boat$/.test(i.name))) res = 'no boat in the pack'
          else {
            const r = await boat.launch(bot, { x: num(0), y: bot.entity.position.y, z: num(1) })
            res = 'launch ' + (r ? 'ok' : 'failed') + ' vehicle=' + (bot.vehicle && bot.vehicle.name)
            await move.sleep(2000)
            const ok = await boat.dismount(bot, null)
            res += ' | dismount ' + ok + ' vehicle=' + (bot.vehicle && bot.vehicle.name)
          }
        } catch (e) { res += ' threw ' + e.message } finally { bot._client.write = w0; bot._client.removeListener('packet', onP) }
        log('boattest', res); for (const l of tr.filter(l => !/vehicle_move/.test(l)).slice(0, 40)) log('boattest', l); log('boattest', `vehicle_move packets: ${tr.filter(l => /vehicle_move/.test(l)).length}`)
        return JSON.stringify({ res, trace: tr.filter(l => !/vehicle_move/.test(l)).slice(0, 40), vmoves: tr.filter(l => /vehicle_move/.test(l)).length })
      })
      case 'boatout': {
        // boatout - get out of the boat we sit in, tracing what the server says (no exclusive: the director is paused)
        const tr = []; const t0 = Date.now(); const T = () => Date.now() - t0
        const onP = (p, meta) => { if (/^(set_passengers|attach_entity|position|vehicle_move|entity_destroy|remove_entities)$/.test(meta.name)) tr.push(`${T()} IN ${meta.name} ${JSON.stringify(p).slice(0, 120)}`) }
        const w0 = bot._client.write.bind(bot._client)
        bot._client.write = (n, p) => { if (!/^(position|position_look|look|flying|keep_alive)$/.test(n)) tr.push(`${T()} OUT ${n} ${JSON.stringify(p).slice(0, 120)}`); return w0(n, p) }
        bot._client.on('packet', onP)
        let ok = null
        try { ok = await require('./boat').dismount(bot, null) } catch (e) { ok = 'threw ' + e.message } finally { bot._client.write = w0; bot._client.removeListener('packet', onP) }
        for (const l of tr.slice(0, 40)) log('boattest', l)
        return `dismount=${ok} vehicle=${bot.vehicle ? bot.vehicle.name : 'none'} | ` + tr.slice(0, 30).join(' || ')
      }
      case 'blocks': {
        // blocks x1 y1 z1 x2 y2 z2 - every non-air block in a small box, with its state
        const [x1, y1, z1, x2, y2, z2] = [0, 1, 2, 3, 4, 5].map(i => num(i))
        const out = []
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
          const b = world.at(bot, x, y, z)
          if (!b || b.name === 'air') continue
          let p = ''; try { const pr = b.getProperties(); p = Object.keys(pr).length ? JSON.stringify(pr) : '' } catch {}
          out.push(`${x},${y},${z} ${b.name}${p}`)
          if (out.length >= 120) break
        }
        return out.join(' | ')
      }
      case 'around': {
        // around [r] - a map of the cells round the bot at feet and head level (and the floor): one char per block
        const r = num(0, 4)
        const me = world.feetPos(bot)
        const ch = b => !b ? '?' : world.isAirish(b) ? '.' : world.isWaterBlock(b) ? '~' : /_door$/.test(b.name) ? 'D' : /_stairs$/.test(b.name) ? 's' : /_slab$/.test(b.name) ? '_' : /fence|wall$/.test(b.name) ? 'f' : /_log$/.test(b.name) ? 'L' : /_planks$/.test(b.name) ? 'p' : /carpet/.test(b.name) ? 'r' : /torch|lantern/.test(b.name) ? 't' : /leaves/.test(b.name) ? '*' : /^(dirt|grass_block)$/.test(b.name) ? 'd' : '#'
        const out = {}
        for (const [label, dy] of [['floor', -1], ['feet', 0], ['head', 1], ['above', 2]]) {
          const rows = []
          for (let z = me.z - r; z <= me.z + r; z++) { let s = ''; for (let x = me.x - r; x <= me.x + r; x++) s += (x === me.x && z === me.z && dy >= 0 && dy <= 1) ? '@' : ch(world.at(bot, x, me.y + dy, z)); rows.push(`${z}: ${s}`) }
          out[label] = rows
        }
        return JSON.stringify({ me: move.fmt(me), x0: me.x - r, out })
      }
      case 'tablewin': return exclusive('tablewin', async () => {
        // tablewin - open a crafting table and report what the server sent (window type id, slot count)
        const t = await craft.getTable(bot, {})
        if (!t) return 'no table'
        if (!require('./act').reach(bot, t.position, 4)) await move.goTo(bot, new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2), { timeoutMs: 15000, label: 'to table' })
        const got = {}
        const onOpen = p => { got.open = { windowId: p.windowId, inventoryType: p.inventoryType, title: JSON.stringify(p.windowTitle).slice(0, 80) } }
        const onItems = p => { if (!got.items) got.items = { windowId: p.windowId, n: (p.items || []).length } }
        bot._client.on('open_window', onOpen); bot._client.on('window_items', onItems)
        try {
          const w = await bot.openBlock(bot.blockAt(t.position))
          await move.sleep(600)
          got.window = { type: w.type, slots: w.slots.length, inventoryStart: w.inventoryStart, craftingResultSlot: w.craftingResultSlot, id: w.id }
          bot.closeWindow(w)
        } catch (e) { got.error = e.message } finally { bot._client.removeListener('open_window', onOpen); bot._client.removeListener('window_items', onItems) }
        const pw = require('prismarine-windows')(bot.version)
        got.known = Object.entries(pw.windows || {}).filter(([, v]) => v.type >= 6 && v.type <= 14).map(([k, v]) => k + '=' + v.type).join(' ')
        return JSON.stringify(got)
      })
      case 'buildstatus': { const st = build.getJob() ? build.status(bot) : null; return st ? JSON.stringify(st) : 'no build job' }
      case 'mine': return exclusive('mine', async () => { const ok = await mining.mineFor(bot, 'cobblestone', inv.count(bot, 'cobblestone') + num(0, 64)); return `mine: ${ok ? 'ok' : 'stopped'} (cobble ${inv.count(bot, 'cobblestone')})` })
      case 'deposit': return exclusive('deposit', async () => { const ok = await base.depositHaul(bot); return `deposit: ${ok}` })
      // bankall - everything into the chests, tools and kit included (a fresh start with an empty pack)
      case 'bankall': return exclusive('bankall', async () => { const ok = await base.depositAll(bot, { keep: () => 0 }); return `bankall: ${ok} (left: ${Object.entries(inv.counts(bot)).map(([k, v]) => k + ' x' + v).join(', ') || 'nothing'})` })
      case 'food': return exclusive('food', async () => { const ok = await food.stockFood(bot, { targetPoints: num(0, 40) }); return `food: ${ok} (${inv.foodPoints(bot)} pts)` })
      case 'fish': return exclusive('fish', async () => { const ok = await food.fishFor(bot, num(0, 4)); await food.cookAll(bot); return `fish: ${ok} (pack food ${inv.foodPoints(bot)} pts)` })
      case 'bed': return exclusive('bed', async () => { const ok = (await shelter.obtainBed(bot)) && (await shelter.placeBed(bot, mem.get().home)); return `bed: ${ok}` })
      case 'bunker': return exclusive('bunker', async () => `bunker: ${await shelter.bunker(bot)}`)
      case 'sleep': return exclusive('sleep', async () => `sleep: ${await shelter.sleepInBed(bot)}`)
      case 'smelt': return exclusive('smelt', async () => `smelt: ${await smelt.smeltItem(bot, a[0], num(1, 8))}`)
      case 'collect': return exclusive('collect', async () => `collected ${await smelt.collectFurnaces(bot)}`)
      case 'scanbox': {
        // scanbox x1 y1 z1 x2 y2 z2 - tally blocks and list the notable ones (needs loaded chunks)
        const [x1, y1, z1, x2, y2, z2] = [0, 1, 2, 3, 4, 5].map(i => num(i))
        const tally = {}; const notable = []; let unloaded = 0
        for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
          const b = world.at(bot, x, y, z)
          if (!b) { unloaded++; continue }
          if (b.name === 'air') continue
          tally[b.name] = (tally[b.name] || 0) + 1
          if (/chest|_bed|door|furnace|crafting_table|torch|lantern|barrel/.test(b.name)) notable.push(`${b.name}@${x},${y},${z}`)
        }
        return JSON.stringify({ unloaded, notable: notable.slice(0, 40), tally })
      }
      case 'tidy': {
        // tidy x1 z1 x2 z2 groundY - clear leftovers above ground level and fill ground-level holes
        const [x1, z1, x2, z2, gy] = [0, 1, 2, 3, 4].map(i => num(i))
        return exclusive('tidy', async () => {
          if (inv.count(bot, 'dirt') < 16) await craft.ensure(bot, 'dirt', 24, { noWithdraw: true }).catch(() => false)
          const n = await require('./hut').restoreGround(bot, Math.min(x1, x2), Math.min(z1, z2), Math.max(x1, x2), Math.max(z1, z2), gy)
          return `tidied ${n} blocks`
        })
      }
      case 'hutplan': {
        const hut = require('./hut')
        const p = hut.getPlan(bot)
        if (!p) return 'no hut plan'
        const todo = p.cells.filter(c => build.cellDone(bot, c) !== true).map(c => `${c.x},${c.y},${c.z}:${c.name}${c.door ? '(door)' : ''}${c.floor ? '(floor)' : ''}${c.foundation ? '(fdn)' : ''} now=${(world.at(bot, c.x, c.y, c.z) || {}).name}`)
        return JSON.stringify({ box: p.box, door: p.door, interior: p.interior, todo })
      }
      case 'tools': {
        const out = inv.items(bot).filter(i => /_(pickaxe|axe|shovel|sword|hoe)$/.test(i.name)).map(i => `${i.name} slot${i.slot} left=${inv.durabilityLeft(bot, i)} used=${i.durabilityUsed}`)
        let eq = ''
        const pick = inv.bestTool(bot, 'pickaxe', 0)
        if (pick) { try { await bot.equip(pick, 'hand'); eq = 'equip ok -> held ' + (bot.heldItem && bot.heldItem.name) } catch (e) { eq = 'equip FAILED: ' + e.message } }
        return out.join(' | ') + ' || ' + eq + ' || window=' + (bot.currentWindow ? bot.currentWindow.type : 'none')
      }
      case 'findb': {
        // findb <regex> [dist] - positions and states of matching blocks
        const re = new RegExp(a[0] || '^stone$')
        const r = world.findBlocks(bot, re, { maxDistance: num(1, 64), count: 30 })
        return r.map(b => { let p = ''; try { p = JSON.stringify(b.getProperties()) } catch {} ; return `${b.name}@${b.position.x},${b.position.y},${b.position.z}${p !== '{}' ? p : ''}` }).join(' | ') || 'none'
      }
      case 'bench': {
        // bench <regex> [dist] [count] - time one findBlocks scan on the live process
        const re = new RegExp(a[0] || '^stone$')
        const t0 = Date.now()
        const r = world.findBlocks(bot, re, { maxDistance: num(1, 32), count: num(2, 10) })
        const t1 = Date.now()
        const ids = world.blockIds(bot, re)
        const raw = bot.findBlocks({ matching: ids, maxDistance: num(1, 32), count: num(2, 10) })
        return `findBlocks ${re} d=${num(1, 32)}: ${r.length} in ${t1 - t0}ms (world wrapper); raw ${raw.length} in ${Date.now() - t1}ms; ids=${ids.length}`
      }
      case 'entities': {
        const me = bot.entity.position
        return Object.values(bot.entities).filter(e => e !== bot.entity && e.position && e.position.distanceTo(me) < 32).map(e => `${e.name}@${Math.round(e.position.distanceTo(me))}`).join(', ')
      }
      case 'look': case 'scan': return 'ok'
      default: return `unknown command "${cmd}" - try help`
    }
  }
  return { handle, isRunning: () => running }
}

module.exports = { make }
