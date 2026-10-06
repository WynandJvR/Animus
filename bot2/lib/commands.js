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
  // who is talking to the bot: the chat gate's own record (a message that named it, held for an answer) - ANY player
  // chat used to count, and two players talking among themselves unlocked the brain's quips for 2 minutes (the audit)
  const chatGate = require('path').join(__dirname, '..', 'chat-gate.js')
  function coordLeak (msg) {
    if (/-?\d{1,7}[\s,xyzXYZ:=/~]+-?\d{1,4}[\s,xyzXYZ:=/~]+-?\d{1,7}/.test(msg)) return true
    // (the graves - the deaths' spots - above all: "come get my stuff at..." is what a death invites; the farm and chests too)
    const m = mem.get(); const j = build.getJob(); const pts = [m.home, m.bed, m.mine && m.mine.entrance, m.mine && m.mine.cursor, j && j.origin, bot.entity && bot.entity.position].concat((m.deaths || []).slice(-6), m.farm && m.farm.water ? [m.farm.water] : [], (m.chests || []).slice(0, 4))
    const secrets = []; for (const p of pts) if (p && p.x != null) { secrets.push(Math.abs(Math.floor(p.x)), Math.abs(Math.floor(p.z))) }
    // ("2,286" is one number)
    const nums = (msg.replace(/(\d),(\d{3})\b/g, '$1$2').match(/-?\d+/g) || []).map(n => Math.abs(parseInt(n, 10))).filter(n => n >= 100)
    return nums.some(n => secrets.some(sv => Math.abs(n - sv) <= 64))
  }
  // (an operator command has a deadline: a `collect` walking to drops in a hole held the lock over two minutes and every
  //  command after it answered "busy" - the operator locked out. At the deadline: every running action told to stop, the
  //  body still, the lock let go; audit 2026-09-28)
  const OP_DEADLINE_MS = { collect: 60000, tower: 90000, dig: 30000 }
  async function exclusive (label, fn) {
    if (running) return `busy with ${running}`
    running = label
    const wasPaused = director.isPaused()
    director.setPaused(true)
    await director.waitIdle()
    const ms = OP_DEADLINE_MS[label] || 180000
    let timer = null
    const dl = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms) })
    try {
      const r = await Promise.race([fn(), dl])
      if (r && r.timedOut) { require('./control').abort(); move.stopMoving(bot); return `${label} timed out after ${Math.round(ms / 1000)}s - stopped` }
      return r
    } finally { clearTimeout(timer); running = null; if (!wasPaused) director.setPaused(false) }
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
        // the brain's lines through the old runtime's own chat gate: one reply per message addressed to the bot, near-
        // duplicates refused, a short cooldown, and unprompted quips rare and never while working - four rephrasings of
        // "whatever, i'm doing the work" answered one "digital stfu" in 7s through the exact-match check alone (2026-09-27)
        // never a base's coordinates in public: an x y z triple is said only while nobody but the operator is on (the
        // operator's rule, 2026-09-27 - any player can ask the brain now, and a posted base is how bases get griefed)
        // never where the base is, in public: judged by the VALUES, not a format - an x/z pair, "-1234/64/-5678", "1234 west
        // 553 north" all name the base. Any number near a secret x or z (home, bed, mine, the build, where we stand) is
        // refused while anyone but the operator is on; a full triple too (spawn-side bases). The operator's rule and the
        // audit, 2026-09-27 - any player can ask the brain now, and a posted base is how bases get griefed.
        if (source !== 'operator' && coordLeak(msg)) {
          const opNames = (require(require('path').join(__dirname, '..', 'config.json')).operators || []).map(o => String(o).toLowerCase())
          const others = Object.keys(bot.players || {}).filter(n => n !== bot.username && !opNames.includes(n.toLowerCase()))
          if (others.length) return 'skipped - where the base is is not said while other players are on'
        }
        if (source !== 'operator') {
          const drop = require(chatGate).gateSay('say ' + msg, true, { isBusy: () => !!director.info() && director.info().name !== 'idle' })
          if (drop) return 'skipped - ' + drop
        }
        bot.chat(msg.slice(0, 250)); return 'said'
      }
      case 'status': case 'state': {
        const d = director.info()
        const st = build.getJob() ? build.cachedStatus(bot) : null
        const p = bot.entity ? bot.entity.position : null
        return JSON.stringify({ pos: p && move.fmt(p), hp: bot.health, food: bot.food, task: d, paused: director.isPaused(), home: mem.get().home, bed: mem.get().bed, build: st && { done: st.done, total: st.total, need: st.need }, packFood: inv.foodPoints(bot) })
      }
      // (and what is WORN and in the off-hand: the pack alone read "golden boots only" of a body in iron, 2026-10-06)
      case 'inventory': { const w = inv.wornArmor(bot); const off = bot.inventory.slots[45]; return (Object.entries(inv.counts(bot)).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty') + ` | worn: ${['head', 'torso', 'legs', 'feet'].map(k => w[k] ? w[k].name : '-').join(', ')} (${inv.armorPoints(bot)} pts) | off-hand: ${off ? off.name : '-'}` }
      case 'decide': { const d = director.decide(); return `${d.name}: ${d.why}` }
      case 'pause': director.setPaused(true); move.stopMoving(bot); setFlag(true); return 'paused'
      case 'resume': director.setPaused(false); setFlag(false); return 'resumed'
      case 'stop': director.setPaused(true); move.stopMoving(bot); setFlag(true); return 'stopped (paused) - "resume" to continue'
      case 'task': { director.setPaused(false); return director.forceTask(a[0]) ? `next task: ${a[0]}` : 'unknown task: ' + Object.keys(director.TASKS).join(', ') }
      case 'ensure': case 'obtain': return exclusive('ensure', async () => { const ok = await craft.ensure(bot, a[0], num(1, 1)); return `ensure ${a[0]}: ${ok ? 'ok' : 'failed'} (holding ${inv.count(bot, a[0])})` })
      case 'goto': return exclusive('goto', async () => { const r = await move.travel(bot, { x: num(0), y: num(1), z: num(2) }, { range: 2, underground: true }); return `goto: ${r.ok ? 'arrived' : r.why}` })
      // walk x z [range] - the operator's hands-off walk: no block broken, none placed (out of someone else's base)
      // walk3 x y z [range] - the same to a block (a goal by x/z alone wanders the tunnels under it)
      case 'walk': case 'walk3': return exclusive('walk', async () => { const r = await move.goTo(bot, cmd === 'walk3' ? new goals.GoalNear(num(0), num(1), num(2), num(3, 2)) : new goals.GoalNearXZ(num(0), num(1), num(2, 3)), { timeoutMs: 120000, stuckMs: 15000, dig: false, place: false, label: 'walk (no dig)' }); return `walk: ${r.ok ? 'arrived' : r.why} at ${move.fmt(bot.entity.position)}` })
      case 'home': return exclusive('home', async () => { const r = await base.goHome(bot); return `home: ${r.ok ? 'arrived' : r.why}` })
      case 'movebase': { // movebase save <name> <schematic> <x> <y> <z> [corner] [anywood] | movebase restore <name> | movebase list
        // A SECOND BASE FOR A FAR BUILD: every per-home record (the home-abandon list in director.js, the bed's spawn) and the
        // build job with its box saved whole under a name and cleared, the new far build set in the same step, so the director
        // settles a new home beside it; restored, the old base and its build are home again. Saved bases stay OURS to the
        // anti-grief guard (foreign.js) - their box, mine, furniture, bed and grounds (audit 2026-10-03)
        const F = ['home', 'bed', 'hutPlan', 'hut', 'chests', 'chestContents', 'furnaces', 'tables', 'farm', 'orchard', 'pen', 'mine', 'bunker', 'spawnSetAt', 'shaftsToFill']
        const EMPTY = { chests: [], chestContents: {}, furnaces: [], tables: [] }
        const clone = v => v === undefined || v === null ? null : JSON.parse(JSON.stringify(v))
        const snap = async () => {
          const m = mem.get(); const rec = {}; for (const k of F) rec[k] = clone(m[k]); rec.build = clone(m.build)
          // (the box of the build on record - never a job still loading or another one's; else from the schematic itself)
          const j = build.getJob(); const b = m.build; const o = b && b.origin
          rec.box = j && j.box && b && j.name === b.name && o && j.origin.x === o.x && j.origin.y === o.y && j.origin.z === o.z ? clone(j.box)
            : b && b.name && o ? await build.boxFor(bot, b.name, o, b.prefs).catch(e => { log('base', `box for ${b.name}: ${e.message}`); return null }) : null
          return rec
        }
        const op = a[0]; const nm = a[1]
        if (op === 'list') return JSON.stringify(Object.fromEntries(Object.entries(mem.get().bases || {}).map(([k, v]) => [k, { home: v.home, build: v.build && v.build.name }])))
        // (never while the boot still loads the build: its setJob finishing last left the restored base with the old build)
        if ((op === 'save' || op === 'restore') && director.isReady && !director.isReady()) return 'still loading the build - try again in a moment'
        if (op === 'save') {
          if (!nm || a.length < 6) return 'usage: movebase save <name> <schematic> <x> <y> <z> [corner] [anywood]   (the new far build, coords the CENTRE)'
          const schem = a[2]; let origin = { x: Number(a[3]), y: Number(a[4]), z: Number(a[5]) }
          if (![origin.x, origin.y, origin.z].every(Number.isFinite)) return 'bad coordinates'
          const s = await build.loadSchematic(schem, bot.version)
          if (!a.includes('corner')) { const en = s.end(); const st = s.start(); origin = { x: origin.x - Math.floor((en.x - st.x) / 2), y: origin.y, z: origin.z - Math.floor((en.z - st.z) / 2) } }
          // (only for a FAR build: one near the old home would settle beside it again - audit)
          const h = mem.get().home
          if (h && Math.hypot(origin.x - h.x, origin.z - h.z) < 256) return `the new build is ${Math.round(Math.hypot(origin.x - h.x, origin.z - h.z))} from home - movebase is for a build 256+ away; use build`
          director.setPaused(true); move.stopMoving(bot)
          const rec = await snap()
          mem.update(mm => { mm.bases = Object.assign({}, mm.bases, { [nm]: rec }); for (const k of F) mm[k] = EMPTY[k] !== undefined ? clone(EMPTY[k]) : null })
          // (a job that will not set leaves the old base as it was - never homeless with the castle's job; audit)
          try { await build.setJob(bot, schem, origin, { exactWood: !a.includes('anywood') }) } catch (e) { mem.update(mm => { for (const k of F) mm[k] = rec[k]; delete mm.bases[nm] }); return `the new build would not set (${e.message}) - the base is as it was` }
          log('base', `base "${nm}" saved (home ${rec.home ? move.fmt(rec.home) : '-'}, ${(rec.chests || []).length} chests, build ${rec.build ? rec.build.name : '-'}) and cleared; new build ${schem} at ${move.fmt(origin)}`)
          return `saved base "${nm}"; build set: ${schem} origin ${move.fmt(origin)} - paused; restart the bot (zones are read at boot), then resume`
        }
        if (op === 'restore') {
          if (!nm) return 'usage: movebase restore <name>'
          const rec = (mem.get().bases || {})[nm]; if (!rec) return `no saved base "${nm}"`
          const curName = 'auto-' + ((mem.get().build && mem.get().build.name) || 'base')
          if (mem.get().home && curName === nm) return `the base left would be saved as "${curName}" - the name being restored; rename it first`
          director.setPaused(true); move.stopMoving(bot)
          // (the base we leave is saved first, never dropped: its chests and their contents - audit)
          const cur = mem.get().home ? await snap() : null
          const before = { bases: clone(mem.get().bases) }; for (const k of F) before[k] = clone(mem.get()[k])
          mem.update(mm => {
            if (cur) mm.bases = Object.assign({}, mm.bases, { [curName]: cur })
            for (const k of F) mm[k] = rec[k] === undefined || rec[k] === null ? (EMPTY[k] !== undefined ? clone(EMPTY[k]) : null) : rec[k]
            mm.spawnSetAt = null // (the server's spawn is the other base's bed now: set again at this bed - audit)
            delete mm.bases[nm]
          })
          // (a build that will not set leaves both bases as they were - audit)
          if (rec.build && rec.build.name && rec.build.origin) {
            try { await build.setJob(bot, rec.build.name, rec.build.origin, { exactWood: rec.build.exactWood === true, prefs: rec.build.prefs || null }) } catch (e) {
              mem.update(mm => { for (const k of F) mm[k] = before[k]; mm.bases = before.bases || {} })
              return `the restored build would not set (${e.message}) - the bases are as they were (paused)`
            }
          }
          log('base', `base "${nm}" restored (home ${rec.home ? move.fmt(rec.home) : '-'}, build ${rec.build ? rec.build.name : '-'})${cur ? `; the base left saved as "${curName}"` : ''}`)
          return `restored base "${nm}"${cur ? ` (the current one saved as "${curName}")` : ''} - paused; restart the bot, then resume`
        }
        return 'usage: movebase save <name> <schematic> <x> <y> <z> [corner] [anywood] | movebase restore <name> | movebase list'
      }
      case 'withdraw': return exclusive('withdraw', async () => { const n = Math.max(1, Number(a[1]) || 64); const got = await base.withdraw(bot, a[0], n).catch(e => 'threw ' + e.message); return `withdraw ${a[0]}: took ${got}` }) // withdraw <item> [n] - out of the chests into the pack
      case 'sethome': {
        const p = a.length >= 3 ? { x: num(0), y: num(1), z: num(2) } : world.feetPos(bot)
        base.setHome(p); return `home set ${move.fmt(p)}`
      }
      case 'dig': { // dig x y z [own] - the operator's hand: dig one block from where the body stands (a body wedged under a
        // closed trapdoor in a one-high space, pinned by the server and back in the same cell after every relog, 2026-09-28)
        const [x, y, z] = [0, 1, 2].map(i => num(i))
        if (![x, y, z].every(Number.isFinite)) return 'dig x y z [own]'
        const own = a[3] === 'own'
        return exclusive('dig', async () => { const b = world.at(bot, x, y, z); const ok = b ? await require('./act').digBlock(bot, b, { own }) : false; return `dig ${b ? b.name : '?'} at ${x},${y},${z}: ${ok ? 'done' : 'refused or failed'}` })
      }
      case 'fillhole': { // fillhole x y z - queue a hole on the grounds to be capped at that level (director fillShaft)
        const [x, y, z] = [0, 1, 2].map(i => num(i))
        if (![x, y, z].every(Number.isFinite)) return 'fillhole x y z'
        mem.update(m => { const l = m.shaftsToFill = m.shaftsToFill || []; if (!l.some(q => q.x === x && q.z === z)) l.push({ x, y, z }) })
        return `queued the hole at ${x},${y},${z} to be capped`
      }
      case 'unmark': { // unmark <flag> - clear a remembered verdict the bot reached wrongly (a dusk-cut trip marked iron "dry")
        const OK = ['ironTripDry', 'buildWaiting', 'wantBoat', 'spawnSetAt'] // (spawnSetAt: the respawn moved before the bot could see it - another player slept on the account)
        if (!OK.includes(a[0])) return `usage: unmark ${OK.join('|')}`
        mem.set(a[0], null); return `${a[0]} cleared`
      }
      case 'biome': { // biome - why /state.biome reads "": the registry's biome table and the raw id under our feet
        const p = bot.entity.position.floored()
        const b = bot.blockAt(p)
        const reg = bot.registry
        let raw = null; try { const col = bot.world.getColumnAt(p); raw = col && col.getBiome ? col.getBiome(new Vec3(p.x & 15, p.y, p.z & 15)) : null } catch (e) { raw = 'err ' + e.message }
        return JSON.stringify({ biomesKnown: reg.biomes ? Object.keys(reg.biomes).length : null, byName: reg.biomesByName ? Object.keys(reg.biomesByName).length : null, rawId: raw, blockBiome: b && b.biome ? { id: b.biome.id, name: b.biome.name } : null, sample: reg.biomesArray ? reg.biomesArray.slice(0, 3).map(x => x && (x.name + '#' + x.id)) : null })
      }
      case 'wood': { // wood exact|any - the current job's wood rule, switched live
        const j = build.getJob()
        if (!j || !/^(exact|any)$/.test(a[0] || '')) return `usage: wood exact|any (now ${build.exactWood() ? 'exact' : 'any'})`
        await build.setJob(bot, j.name, j.origin, { exactWood: a[0] === 'exact' })
        require('./materials').resetPlanner()
        return `wood: ${a[0]} for ${j.name}`
      }
      // what a blueprint costs to gather, the dear blocks flagged (the panel's Build dialog asks this before it starts one)
      case 'buildcost': {
        if (!a[0]) return 'usage: buildcost <schematic>'
        return JSON.stringify(await build.costReport(bot, a[0]))
      }
      case 'build': {
        const name = a[0]
        if (!name || a.length < 4) return 'usage: build <schematic> <x> <y> <z> [corner] [anywood] [skip=block,block] [swap=block>block,block>block]   (coords are the CENTRE unless "corner"; wood is the blueprint species unless "anywood"; skip/swap: the cost check\'s choices)'
        let origin = { x: num(1), y: num(2), z: num(3) }
        const corner = a.includes('corner')
        // the operator's choices from the cost check (block names, no spaces): skip=anvil,bell swap=lightning_rod>oak_fence
        const prefs = { skip: [], swap: {} }
        for (const w of a) {
          if (/^skip=/.test(w)) prefs.skip.push(...w.slice(5).split(',').filter(Boolean))
          if (/^swap=/.test(w)) for (const pr of w.slice(5).split(',')) { const [f, t] = pr.split('>'); if (f && t) prefs.swap[f] = t }
        }
        const chosen = prefs.skip.length || Object.keys(prefs.swap).length ? prefs : null
        const s = await build.loadSchematic(name, bot.version, chosen)
        if (!corner) { const en = s.end(); const st = s.start(); origin = { x: origin.x - Math.floor((en.x - st.x) / 2), y: origin.y, z: origin.z - Math.floor((en.z - st.z) / 2) } }
        // the blueprint's own wood species unless "anywood" (then any local wood stands in for any)
        await build.setJob(bot, name, origin, { exactWood: !a.includes('anywood'), prefs: chosen })
        return `build job set: ${name} origin ${move.fmt(origin)}${a.includes('anywood') ? ' (any local wood)' : ' (exact wood species)'}${chosen ? ` (the choices applied: ${JSON.stringify((s.report && s.report.chosen) || {})})` : ''}`
      }
      case 'door': return exclusive('door', async () => { const g = new goals.GoalBlock(num(0), num(1), num(2)); const ok = await move.crossDoor(bot, g).catch(e => 'threw ' + e.stack); return `crossDoor: ${ok} now at ${move.fmt(bot.entity.position)}` })
      case 'furnaces': return exclusive('furnaces', async () => {
        const home = mem.get().home
        const out = []
        for (const fb of world.findBlocks(bot, /^furnace$/, { maxDistance: 16, count: 20, point: new Vec3(home.x, home.y, home.z) })) {
          try {
            if (!require('./act').reach(bot, fb.position, 4)) await move.goTo(bot, new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2), { timeoutMs: 15000, label: 'to furnace' })
            const f = await require('./act').openSettled(bot, bot.blockAt(fb.position), 'openFurnace')
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
        // (missing y1 y2 - only those layers, 400 listed: the first 60 of 11,000 said nothing of the layers above)
        const y1 = a.length >= 2 ? num(0) : -Infinity; const y2 = a.length >= 2 ? num(1) : Infinity; const lim = a.length >= 2 ? 400 : 60
        const miss = j.cells.filter(c => c.y >= y1 && c.y <= y2 && build.cellDone(bot, c) !== true).map(c => { const b = world.at(bot, c.x, c.y, c.z); let p = ''; try { const bp = b ? b.getProperties() : {}; p = build.KEY_PROPS.filter(k => bp[k] != null).map(k => `${k}=${bp[k]}`).join(',') } catch {} ; const w = build.wantOf(c); return `${c.x},${c.y},${c.z} want ${c.name}${w ? JSON.stringify(w) : ''} have ${b ? b.name + (p ? '[' + p + ']' : '') : 'unloaded'}` })
        const s = build.survey(bot, 0, { full: true })
        return JSON.stringify({ missing: miss.length, cells: miss.slice(0, lim), snapshot: s.snapshot, strayFiller: s.scaffold.length, stray: s.scaffold.slice(0, 80).map(p => `${p.name}@${p.x},${p.y},${p.z}`), holes: s.holes.length, complete: build.complete(bot) })
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
        // heights x1 z1 x2 z2 [step] - top solid (non-leaf, non-plant) block per column, as rows of full y-values (~ = water)
        // (it scanned y110 down and printed two digits: a y116-119 plateau read "10" = 110 and a build's base looked 9
        //  blocks in the air, 2026-09-24)
        const [x1, z1, x2, z2] = [0, 1, 2, 3].map(i => num(i)); const step = num(4, 1)
        const rows = []; const tally = {}
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z += step) {
          let r = ''
          for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += step) {
            let y = null
            const top = Math.min(bot.game.minY + bot.game.height - 1, Math.floor(bot.entity.position.y) + 96)
            for (let yy = top; yy > bot.game.minY; yy--) { const b = world.at(bot, x, yy, z); if (!b) break; if (world.isSolid(b) && !world.LEAF_RE.test(b.name) && !world.LOG_RE.test(b.name)) { y = yy; tally[b.name] = (tally[b.name] || 0) + 1; break } if (world.isWaterBlock(b)) { y = -yy; break } }
            r += y == null ? '   ..' : y < 0 ? '  ~' + String(-y).padStart(3) : ' ' + String(y).padStart(4)
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
      case 'mobs': { // mobs [r] - the hostiles within r (24): name, position, distance, whether seen, on the surface
        const r = num(0, 24); const rf = require('./reflex')
        return JSON.stringify(rf.hostiles(r).map(h => ({ n: h.e.name, at: move.fmt(h.e.position.floored()), d: Math.round(h.d * 10) / 10, seen: rf.canSee(h.e), surface: rf.onSurface(h.e) })))
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
      case 'buildstatus': { const st = build.getJob() ? build.cachedStatus(bot) : null; return st ? JSON.stringify(st) : 'no build job' }
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
      case 'note': {
        // note <kind> <x> <y> <z> - remember a resource there (an operator's hint: "lots of oak at ..."); kind as the bot
        // names it: oak_log, sand, clay, gravel...
        if (!a[0] || a.length < 4) return 'usage: note <kind> <x> <y> <z>'
        require('./gather').noteResource(a[0], { x: num(1), y: num(2), z: num(3) })
        return `noted ${a[0]} at ${num(1)},${num(2)},${num(3)}`
      }
      case 'orelevel': return (async () => {
        // orelevel [item] - where the mine would work for an ore, and the ore counted per level round home
        const item = a[0] || 'raw_iron'
        const g = require('./craft').GATHER[item]
        if (!g) return 'no such ore item'
        const ores = await world.scanBlocks(bot, g.blocks, { maxDistance: num(1, 64), count: 4000, point: mem.get().home })
        const at = {}; for (const b of ores) at[b.position.y] = (at[b.position.y] || 0) + 1
        const open = ores.filter(b => world.hasAirNeighbour(bot, b.position))
        const lit = open.filter(b => world.skyLitFace(bot, b.position))
        return `${ores.length} found (${open.length} showing to air, ${lit.length} in daylight, nearest ${open.slice(0, 8).map(b => b.position.x + ',' + b.position.y + ',' + b.position.z).join(' ')}); pick ${JSON.stringify(await mining.oreLevel(bot, item))}; by y ${Object.keys(at).sort((x, y) => y - x).map(y => y + ':' + at[y]).join(' ')}`
      })()
      case 'tower': return exclusive('tower', async () => {
        // tower <n> - jump-place up n blocks where we stand (the builder's pillar), reporting each step
        const out = []
        for (let i = 0; i < num(0, 3); i++) {
          const y0 = bot.entity.position.y; const held = bot.heldItem ? bot.heldItem.name : '-'
          const ok = await require('./gather').towerUp(bot, { allowZones: ['*'] })
          out.push(`${ok ? 'up' : 'FAIL'} ${y0.toFixed(2)}->${bot.entity.position.y.toFixed(2)} held ${held}->${bot.heldItem ? bot.heldItem.name : '-'} sneak ${!!(bot.controlState && bot.controlState.sneak)}`)
          if (!ok) break
        }
        return out.join(' | ')
      })
      case 'obstr': {
        // obstr - what the site clearing would take down, by block name, with a few positions
        const o = build.unskippedObstructions(bot, {})
        const by = {}; for (const b of o) { const k = b.name; (by[k] = by[k] || []).push(`${b.position.x},${b.position.y},${b.position.z}`) }
        return `${o.length}: ` + Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k} x${v.length} (${v.slice(0, 4).join(' ')})`).join('; ')
      }
      case 'stray': return (async () => {
        // stray <regex> [dist] - blocks of that kind in the world that are NOT a build cell wanting that block
        const re = new RegExp(a[0] || '^glass$')
        const j = build.getJob()
        const found = await world.scanBlocks(bot, re, { maxDistance: num(1, 160), count: 5000 })
        const out = found.filter(b => { const c = j && j.index.get(`${b.position.x},${b.position.y},${b.position.z}`); return !c || !re.test(c.name) })
        return `${found.length} found, ${found.length - out.length} in build cells that want them, ${out.length} stray: ${out.slice(0, 40).map(b => `${b.position.x},${b.position.y},${b.position.z}`).join(' ')}`
      })()
      // forgetforeign x y z - the operator's correction of a wrong record: the place someone else's round that point forgotten
      case 'forgetforeign': { const n = require('./foreign').forgetAt({ x: num(0), y: num(1), z: num(2) }); return `forgot ${n} place(s) round ${num(0)},${num(1)},${num(2)}` }
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
        // (a 4th arg "f": a filter that refuses everything - the worst case of a filtered search)
        const r = world.findBlocks(bot, re, { maxDistance: num(1, 32), count: num(2, 10), filter: a[3] === 'f' ? () => false : undefined })
        const t1 = Date.now()
        const ids = world.blockIds(bot, re)
        const raw = bot.findBlocks({ matching: ids, maxDistance: num(1, 32), count: num(2, 10) })
        return `findBlocks ${re} d=${num(1, 32)}: ${r.length} in ${t1 - t0}ms (world wrapper); raw ${raw.length} in ${Date.now() - t1}ms; ids=${ids.length}`
      }
      // (`plan <item> [n]`: what the planner would take for it from the stock we hold - raw still to fetch, crafts, unknowns;
      //  the builder's "craftable from stock" is this, and purple_wool read craftable with no wool anywhere, 2026-09-29)
      case 'plan': {
        const r = require('./materials').planFor(bot, { [a[0]]: num(1, 1) })
        return JSON.stringify({ raw: r.raw, unknown: r.unknown, crafts: r.crafts || r.steps || undefined }).slice(0, 1500)
      }
      case 'entities': {
        const me = bot.entity.position
        // (`entities meta`: each animal's metadata by the registry's key names - baby, age_locked, wool - against the raw
        //  indices, so a key list off by one on the patched data shows before a filter reads it; audit 2026-09-29)
        if (a[0] === 'meta') {
          const d = require('./world').data(bot)
          return Object.values(bot.entities).filter(e => e !== bot.entity && e.position && e.position.distanceTo(me) < 48 && e.type !== 'player' && d.entitiesByName[e.name]).map(e => {
            const keys = d.entitiesByName[e.name].metadataKeys || []
            const md = e.metadata || []
            const named = ['mob_flags', 'baby', 'age_locked', 'wool'].map(k => { const i = keys.indexOf(k); return i >= 0 ? `${k}[${i}]=${JSON.stringify(md[i])}` : null }).filter(Boolean).join(' ')
            return `${e.name}@${Math.round(e.position.distanceTo(me))} ${named} raw=${JSON.stringify(md.slice(14, 20))}`
          }).join('\n')
        }
        return Object.values(bot.entities).filter(e => e !== bot.entity && e.position && e.position.distanceTo(me) < 32).map(e => `${e.name}@${Math.round(e.position.distanceTo(me))}`).join(', ')
      }
      case 'look': case 'scan': return 'ok'
      default: return `unknown command "${cmd}" - try help`
    }
  }
  return { handle, isRunning: () => running }
}

module.exports = { make }
