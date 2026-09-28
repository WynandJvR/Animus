'use strict'
// Getting raw materials out of the world: chop trees, dig surface blocks, take exposed ores.
// Large stone/ore quantities go to the mine (mining.js). Only visible blocks are targeted -
// the bot does not x-ray ores through solid rock.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const world = require('./world')
const inv = require('./inventory')
const move = require('./move')
const act = require('./act')
const mem = require('./memory')
const reflex = require('./reflex')
const { log } = require('./log')

const mining = () => require('./mining')
const base = () => require('./base')

// Remember where resources were seen, so a later trip goes straight there.
function noteResource (kind, pos) { noteResources([[kind, pos]]) }
// Several sightings in ONE memory write: each mem.update writes the whole memory file synchronously, and a survey noting
// its twenty sightings one by one did that twenty times a leg, on the event loop (audit, 2026-09-27).
function noteResources (notes) {
  if (!notes.length) return
  mem.update(m => {
    m.resources = m.resources || {}
    for (const [kind, pos] of notes) {
      const list = m.resources[kind] || (m.resources[kind] = [])
      // (full: the spot furthest from home goes, not the oldest - a 2000-block trek's sightings pushed every tree near home
      //  out of the list, 2026-09-27)
      if (!list.some(p => world.dist2(p, pos) < 24)) {
        list.push({ x: pos.x, y: pos.y, z: pos.z, t: Date.now() })
        const home = m.home
        if (list.length > 12) { let far = 0; if (home) list.forEach((p, i) => { if (world.dist2(p, home) > world.dist2(list[far], home)) far = i }); list.splice(far, 1) }
      }
    }
  })
}
function forgetResource (kind, pos) {
  mem.update(m => { if (m.resources && m.resources[kind]) m.resources[kind] = m.resources[kind].filter(p => world.dist2(p, pos) >= 24) })
}
// maxFromHome: how far from home a remembered spot still counts (clay can lie 300 blocks out - trees do not)
function knownResource (kind, from, { maxFromHome = 200 } = {}) {
  const home = mem.get().home
  const list = ((mem.get().resources || {})[kind] || []).filter(p => !home || world.dist2(p, home) < maxFromHome)
  if (!list.length) return null
  const me = from || home || { x: 0, z: 0 }
  return list.slice().sort((a, b) => world.dist2(a, me) - world.dist2(b, me))[0]
}

// Not in a protected zone - and not in the ground under one either: stone under the basilica was picked, refused by
// the dig, and picked again every 20s for minutes (2026-09-23). A zone's columns are off limits to the depth.
function outOfZones (b) { return !move.inZone(b.position, 2) && !move.inZone({ x: b.position.x, y: b.position.y + 12, z: b.position.z }, 1) }
// A tree the orchard grew: ours to cut (and replant). Every other zone keeps the axe out; the orchard's zone kept it out
// of its own trees too - "chop oak_log: no trees found" beside three grown ones, two sticks never made (2026-09-24).
function orchardTree (b) { const z = move.inZone(b.position, 0); return !!z && z.label === 'orchard' && !move.inZone(b.position, 2, ['orchard']) }
function treeOK (b) { return outOfZones(b) || orchardTree(b) }

// ---- trees ------------------------------------------------------------------------------
function trunkBase (bot, b) {
  let p = b.position.clone()
  for (let i = 0; i < 20; i++) {
    const below = bot.blockAt(p.offset(0, -1, 0))
    if (!below || !world.LOG_RE.test(below.name)) break
    p = p.offset(0, -1, 0)
  }
  return p
}
function isNaturalTree (bot, basePos) {
  const soil = bot.blockAt(basePos.offset(0, -1, 0))
  if (!soil || !/^(dirt|grass_block|podzol|coarse_dirt|rooted_dirt|mud|moss_block|mycelium|snow_block)$/.test(soil.name)) return false
  // leaves somewhere above = a tree, not a log cabin
  for (let dy = 1; dy < 12; dy++) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const b = bot.blockAt(basePos.offset(dx, dy, dz)); if (b && world.LEAF_RE.test(b.name)) return true
    }
  }
  return false
}

// A wild tree's log, one the axe may take: out of every zone but the orchard's, on a natural trunk. THE rule the chop,
// the survey and forage's sighting of a searched-out species all judge by.
function wildTree (bot, b) { return treeOK(b) && isNaturalTree(bot, trunkBase(bot, b)) }

// How the last chop ended, for a caller that must tell "searched and none found" from "cut short" (forage.noteTrip: only
// a real search counts a species as searched out - audit R7, 2026-09-27). outcome: 'done' | 'none-found' (explored, no
// tree) | 'stopped' (shouldStop) | 'budget' (the 20 minutes spent - trees there, not got to). at: when it ended.
let lastChop = null
function lastChopOutcome () { return lastChop }
async function chop (bot, re, n, ctx = {}) {
  const itemName = String(re).replace(/^\/\^|\$\/$/g, '')
  const end = (outcome, r, extra) => { lastChop = Object.assign({ item: itemName, outcome, at: Date.now() }, extra); return r }
  const target = inv.count(bot, itemName) + n
  let emptyScans = 0
  const t0 = Date.now()
  // trunks this trip could not get to: not walked at again (a trunk over a 10-block drop at the plaza's corner was
  // walked at every 33s for 20 minutes, 2026-09-26)
  const unreachable = new Set(); const tk = p => `${p.x},${p.y},${p.z}`
  const landTried = new Set()
  let axeFailed = false
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return end('stopped', false)
    if (Date.now() - t0 > 20 * 60000) { log('gather', `chop ${itemName}: 20 min budget spent`); return end('budget', false) }
    await reflex.waitClear()
    if (inv.freeSlots(bot) <= 1) await base().makeRoom(bot, 3)
    const logs = world.findBlocks(bot, re, { maxDistance: 64, count: 40, filter: b => treeOK(b) })
    let trunk = null
    for (const b of logs) {
      const bp = trunkBase(bot, b)
      if (Math.abs(bp.y - bot.entity.position.y) > 12) continue
      if (!isNaturalTree(bot, bp) || unreachable.has(tk(bp))) continue
      trunk = bp; break
    }
    if (!trunk) {
      // everything in sight before remembered spots or walking rings: the client holds every chunk the server sent
      // (~10 chunks round us), as a player sees them. A forest 150 blocks west of home was in view the whole time the
      // 64-block search said "no trees found" and the operator had to point it out (2026-09-24).
      if (emptyScans === 0) {
        const seen = (await world.scanBlocks(bot, re, { maxDistance: world.sightReach(bot), count: 40, filter: b => wildTree(bot, b) }))
          .sort((a, b) => world.dist3(a.position, bot.entity.position) - world.dist3(b.position, bot.entity.position))[0]
        if (seen && world.dist2(seen.position, bot.entity.position) > 20) {
          noteResource(itemName, seen.position)
          log('gather', `no ${itemName} close by - the nearest in sight is at ${move.fmt(seen.position)} (${Math.round(world.dist2(seen.position, bot.entity.position))}b)`)
          emptyScans++
          const r = await move.travel(bot, seen.position, { range: 8, shouldStop: ctx.shouldStop, label: 'to trees' })
          if (r.ok) emptyScans = 0
          continue
        }
      }
      if (++emptyScans > 4) { log('gather', `chop ${itemName}: no trees found after exploring`); return end('none-found', false) }
      // (a species from a country of its own: the trees found there count however far out - the next trip goes straight to them)
      const known = knownResource(itemName, bot.entity.position, SPECIES_BIOMES[itemName.replace(/_log$/, '')] ? { maxFromHome: 2000 } : undefined)
      if (known && world.dist2(known, bot.entity.position) > 40 && emptyScans === 1) {
        // (trees of a far country found on an expedition are remembered 2000b out: the same day's-trip rule as the land -
        //  too far today, and past a dawn start the next expedition goes to them)
        if (!ctx.expedition && SPECIES_BIOMES[itemName.replace(/_log$/, '')]) {
          const me = bot.entity.position; const home = mem.get().home || me
          const trip = world.walkTicks(me, known) + world.walkTicks(known, home) + CHOP_TICKS + world.HOME_MARGIN
          if (trip > world.ticksUntilNight(bot)) { log('gather', `the ${itemName} i know of is ${Math.round(world.dist2(known, me))}b off - too far to go and come back today`); return end('too-far', false, { land: { x: known.x, z: known.z, biome: 'known trees' }, trip }) }
        }
        log('gather', `no ${itemName} here - heading to where i saw some at ${move.fmt(known)}`)
        const r = await move.travel(bot, known, { range: 8, shouldStop: ctx.shouldStop, label: 'to trees' })
        if (!r.ok) forgetResource(itemName, known)
      } else {
        let land = !known && emptyScans <= 2 ? speciesLand(itemName, bot.entity.position) : null
        const lead = !land && !known && emptyScans <= 2 ? climateLead(bot, itemName, bot.entity.position) : null
        if (lead && lead.d > 48) land = Object.assign(lead, { lead: true })
        if (land && landTried.has(tk(land))) land = null // (once a trip: a route that failed is not walked twice)
        if (land && land.d > 48) {
          landTried.add(tk(land))
          // there, some chopping and home again before dark - the one rule every day trip keeps (director.homeByDark). Too
          // far today is no "none here": not a searched trip (R7), and no rings round home instead - they cost the same
          // afternoon for nothing; the morning goes (audit 2026-09-27)
          const me = bot.entity.position; const home = mem.get().home || me
          const at = { x: land.x, y: me.y, z: land.z }
          const trip = world.walkTicks(me, at) + world.walkTicks(at, home) + CHOP_TICKS + world.HOME_MARGIN
          // (an expedition - days out, the nights camped - has no day to fit: it goes on from wherever it stands)
          if (!ctx.expedition && trip > world.ticksUntilNight(bot)) { log('gather', `${land.lead ? 'the way to ' + itemName + ' country leads to' : itemName + ' grows in'} the ${land.biome} ${Math.round(land.d)}b off - too far to go and come back today`); return end('too-far', false, { land: { x: land.x, z: land.z, biome: land.biome, lead: !!land.lead }, trip }) }
          log('gather', land.lead ? `no ${itemName} country on record - heading for the ${land.biome} ${Math.round(land.d)}b off, the land nearest its climate` : `no ${itemName} round here - heading for the ${land.biome} ${Math.round(land.d)}b off, where it grows`)
          const r = await move.travel(bot, { x: land.x, y: Math.floor(me.y), z: land.z }, { range: 16, shouldStop: ctx.shouldStop, label: 'to the ' + land.biome, anyY: true })
          // (a route that failed today - no boat, a stuck path - says nothing of the land: only arriving and seeing none of
          //  it there proves the sample wrong - a snowy plain with no trees)
          // (a lead walked: the view from there, now - its country in sight goes on to it, the next check; none, and this trip
          //  ends: not "none here" (R7) while leads remain, the next trip starts from the next lead)
          if (r.ok && land.lead) { walkedLead(land); try { biomesAt = null; noteBiomes(bot) } catch {} if (!speciesLand(itemName, bot.entity.position)) return end('lead', false) }
          else if (r.ok) {
            const trees = await world.scanBlocks(bot, re, { maxDistance: world.sightReach(bot), count: 8, filter: b => wildTree(bot, b) })
            if (!trees.length) { log('gather', `the ${land.biome} here has no ${itemName} in sight - forgetting it`); forgetLand(land) } else noteResource(itemName, trees[0].position)
          }
        } else if (ctx.expedition) {
          // (out on an expedition: rings round a home days away are no search - none here, and the expedition decides)
          return end('none-found', false)
        } else {
          // (a species with a country of its own and none of it on record: the rings go wider, like clay's)
          await explore(bot, b => re.test(b.name), { shouldStop: ctx.shouldStop, label: itemName, rings: SPECIES_BIOMES[itemName.replace(/_log$/, '')] ? 9 : null, accept: b => outOfZones(b) && isNaturalTree(bot, trunkBase(bot, b)) })
        }
      }
      continue
    }
    emptyScans = 0
    noteResource(itemName, trunk)
    // (the axe worn out mid-chop: a new one from the pack before the next tree - the tools rule runs only between tasks;
    //  craft.keepTool. Latched only on a failed make: a stone axe is 131 logs and an expedition's chop fells more)
    if (!axeFailed && !inv.bestTool(bot, 'axe', 1) && !await require('./craft').keepTool(bot, 'axe', { minUses: 1, shouldStop: ctx.shouldStop })) axeFailed = true
    const got = await fellTree(bot, trunk, re, { leaves: !!ctx.leaves, allowZones: move.inZone(trunk, 0) ? ['orchard'] : [], shouldStop: ctx.shouldStop })
    if (!got) { unreachable.add(tk(trunk)); await move.sleep(300) }
  }
  return end('done', true)
}

// opts.leaves: clear the tree's own leaves too (they drop the saplings the orchard grows from; wild leaves left to decay
// drop them after we have gone). opts.allowZones: the orchard's trees stand in its zone.
async function fellTree (bot, basePos, re, { leaves = false, allowZones = [], shouldStop } = {}) {
  const before = inv.count(bot, b => re.test(b))
  const pillar = [] // (the blocks towered up to reach the top logs: taken down again after)
  // stand next to the trunk
  const r = await move.goTo(bot, new goals.GoalNear(basePos.x, basePos.y, basePos.z, 2), { timeoutMs: 40000, label: 'to tree', shouldStop })
  if (!r.ok) return false
  // the column, bottom up; then neighbouring trunks (2x2 trees)
  const column = []
  for (let dy = 0; dy < 24; dy++) {
    const b = bot.blockAt(basePos.offset(0, dy, 0))
    if (!b || !re.test(b.name)) { if (dy > 0) break; else continue }
    column.push(b.position)
  }
  for (const p of column) {
    if (p.y - bot.entity.position.y > 4.5) {
      // step into the stump column to reach higher logs
      const below = bot.blockAt(new Vec3(basePos.x, basePos.y, basePos.z))
      if (below && world.isAirish(below) && Math.floor(bot.entity.position.x) !== basePos.x) {
        await move.goTo(bot, new goals.GoalBlock(basePos.x, basePos.y, basePos.z), { timeoutMs: 8000, place: false, label: 'into stump' })
      }
      if (p.y - bot.entity.position.y > 5.2) {
        // tower one block under ourselves to reach
        if (!await towerUp(bot, { allowZones: allowZones.concat(['orchard']), onPlaced: c => pillar.push(c) })) break
      }
    }
    await act.dig(bot, p, { timeoutMs: 15000, allowZones })
  }
  // THE PILLAR DOWN FROM ON TOP, straight after the last log - a player's way: stand on it, dig the block under the feet,
  // drop one onto the next, to the ground. From the stump a 10-high pillar top is out of reach, and the walk to reach it
  // towered a second pillar beside it (audit 2026-09-28). Only while the cell under the feet is ours.
  {
    const ours = c => pillar.some(q => q.x === c.x && q.y === c.y && q.z === c.z)
    for (let guard = 0; guard < 40 && pillar.length; guard++) {
      const me = bot.entity.position; const under = { x: Math.floor(me.x), y: Math.floor(me.y - 0.01), z: Math.floor(me.z) }
      if (!ours(under)) break
      if (!await act.dig(bot, under, { timeoutMs: 6000, noWalk: true, allowZones: allowZones.concat(['orchard']) }).catch(() => false)) break
      const t0 = Date.now(); while (!bot.entity.onGround && Date.now() - t0 < 1500) await move.sleep(50)
      pillar.splice(pillar.findIndex(q => q.x === under.x && q.y === under.y && q.z === under.z), 1)
    }
  }
  // (the trunk gone, its whole crown is borrowed footing - every natural leaf of it decays within seconds: stood on it,
  //  the bot fell 7 blocks when one rotted away, 2026-09-28. Down to the stump, on real ground, before anything else)
  {
    const me = bot.entity.position; const fl = world.at(bot, me.x, Math.floor(me.y - 0.01), me.z)
    let natural = false; try { const pr = fl && /_leaves$/.test(fl.name) ? fl.getProperties() : null; natural = !!pr && (pr.persistent === false || pr.persistent === 'false') } catch {}
    if (natural) {
      log('gather', 'standing on the crown of the felled tree - down to the stump first')
      await move.goTo(bot, new goals.GoalNear(basePos.x, basePos.y, basePos.z, 1), { timeoutMs: 12000, place: false, label: 'off the crown' })
    }
  }
  // (what is left of it - the bot walked off before it came down: the blocks in reach from here, the rest said)
  let left = 0
  for (const c of pillar.sort((a, b) => b.y - a.y)) {
    const b = world.at(bot, c.x, c.y, c.z)
    if (!b || !world.isSolid(b) || !/^(dirt|cobblestone|andesite|diorite|tuff|cobbled_deepslate|netherrack)$/.test(b.name)) continue
    if (!act.reach(bot, c, 4.5) || !await act.dig(bot, c, { timeoutMs: 6000, noWalk: true, allowZones: allowZones.concat(['orchard']) }).catch(() => false)) left++
  }
  if (left) log('gather', `${left} pillar block${left > 1 ? 's' : ''} left at ${pillar[0].x},${pillar[0].z} - out of reach`)
  if (leaves && column.length) {
    // the crown within reach, from where we stand: natural leaves only (persistent ones are someone's build)
    const top = column[column.length - 1]
    const lv = world.findBlocks(bot, world.LEAF_RE, { maxDistance: 4.5, count: 80, point: bot.entity.position.offset(0, 1.6, 0),
      filter: b => { try { return !b.getProperties().persistent && world.dist3(b.position, top) <= 4 } catch { return false } } })
    let n = 0
    for (const b of lv) { if (act.reach(bot, b.position, 4.5) && await act.dig(bot, b.position, { timeoutMs: 3000, noWalk: true, allowZones })) n++ }
    if (n) log('gather', `cleared ${n} leaves for saplings`)
  }
  // come back down if we climbed
  await act.collectDrops(bot, { radius: 7, maxMs: 10000 })
  // replant
  const sap = inv.items(bot).find(i => i.name.endsWith('_sapling') && basePos && i.name.startsWith(String(re).replace(/^\/\^|_log\$\/$/g, '')))
  if (sap) {
    const soil = bot.blockAt(basePos.offset(0, -1, 0)); const cell = bot.blockAt(basePos)
    if (soil && /^(dirt|grass_block|podzol|coarse_dirt|rooted_dirt)$/.test(soil.name) && cell && world.isAirish(cell)) await act.place(bot, basePos, sap.name, { faceHint: [[0, -1, 0]], allowZones })
  }
  const got = inv.count(bot, b => re.test(b)) - before
  if (got > 0) log('gather', `felled a tree at ${move.fmt(basePos)}: +${got} logs`)
  return got > 0
}

// Jump and place a filler block under our feet.
// allowZones: the zones the pillar may stand in; builder: only the builder's own pillars may put a block in a cell of
// the build (placed or not) - an escape may climb out inside the build's zone, never into its cells (audit 2026-09-28). onPlaced(cell): the caller's ledger of
// the pillar it raised, to take it down again (the chop digs its own; an orchard kept its dirt pillars for ever).
let lastPillar = null
async function towerUp (bot, { allowZones = [], onPlaced = null, builder = false } = {}) {
  const filler = inv.items(bot).find(i => /^(dirt|cobblestone|andesite|diorite|tuff|cobbled_deepslate|netherrack)$/.test(i.name))
  if (!filler) return false
  const y0 = Math.floor(bot.entity.position.y)
  const above = world.at(bot, bot.entity.position.x, y0 + 2, bot.entity.position.z)
  if (!above || !world.isAirish(above)) return false
  // THE COLUMN we stand on, taken before the jump, and the body centred on it first, crouched (a crouch never walks off an
  // edge): jumped from 0.3 off a column's edge beside a pit, the place went to the column the body had drifted over -
  // air - and it came down ten blocks, hp 20 -> 12, felling an orchard tree (2026-09-28)
  const x0 = Math.floor(bot.entity.position.x); const z0 = Math.floor(bot.entity.position.z)
  try { bot.pathfinder.setGoal(null) } catch {} // (the tower owns the body now: a planner's left-over goal kept the body moving)
  const off = () => Math.hypot(bot.entity.position.x - (x0 + 0.5), bot.entity.position.z - (z0 + 0.5))
  try {
    await bot.equip(filler, 'hand')
    if (off() > 0.2) {
      bot.setControlState('sneak', true)
      const t1 = Date.now()
      while (off() > 0.2 && Date.now() - t1 < 1500) {
        const p = bot.entity.position
        await bot.look(Math.atan2(-((x0 + 0.5) - p.x), -((z0 + 0.5) - p.z)), 0, true)
        // (a nudge that eases off near the centre: held on to 0.2 it overshot and left the body moving for the jump)
        bot.setControlState('forward', off() >= 0.25)
        await move.sleep(50)
      }
      bot.setControlState('forward', false); bot.setControlState('sneak', false)
      if (off() > 0.3 || Math.floor(bot.entity.position.x) !== x0 || Math.floor(bot.entity.position.z) !== z0) return false // (could not centre: no jump)
    }
    // (still before the jump - the real protection: 0.04 a tick across is ~0.3 of a block by the apex, over a column's
    //  edge from a start 0.2 off; settled, a straight-up jump comes down where it left - audit 2026-09-28)
    for (let k = 0; k < 10 && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) >= 0.01; k++) await bot.waitForTicks(1)
    // (still moving after the wait: no jump at all - the wait running out and jumping anyway drifted it into the same pit
    //  a second time, 2026-09-28 04:51)
    if (Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) >= 0.01) return false
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    bot.setControlState('jump', true)
    const t0 = Date.now()
    while (bot.entity.position.y < y0 + 1.05 && Date.now() - t0 < 800) await move.sleep(30)
    bot.setControlState('jump', false)
    // (drifted off the column mid-jump: no place onto a column it is not over - a backstop only: a body whose centre is
    //  past the edge comes down in the next column whatever we do; the settle above is what keeps it over its own)
    if (Math.floor(bot.entity.position.x) !== x0 || Math.floor(bot.entity.position.z) !== z0) { await move.sleep(300); return false }
    const below = bot.blockAt(new Vec3(x0, y0 - 1, z0))
    // (the cell the block goes into - the column's own, at y0)
    const cellB = world.at(bot, x0, y0, z0); const zn = move.inZone({ x: x0, y: y0, z: z0 })
    if (!builder && cellB && move.isProtected(cellB, 'fill')) { log('gather', `no tower at ${x0},${y0},${z0} - a cell of the build`); await move.sleep(300); return false }
    if (zn && !allowZones.includes('*') && !allowZones.includes(zn.label)) { log('gather', `no tower at ${x0},${y0},${z0} - inside the ${zn.label}`); await move.sleep(300); return false }
    if (below) await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(() => {})
    { const nb = world.at(bot, x0, y0, z0); if (nb && world.isSolid(nb)) { lastPillar = { x: x0, y: y0, z: z0 }; if (onPlaced) onPlaced(lastPillar) } }
    await move.sleep(300)
    return Math.floor(bot.entity.position.y) >= y0 + 1
  } catch { bot.setControlState('jump', false); bot.setControlState('forward', false); bot.setControlState('sneak', false); return false }
}

// ---- surface blocks and exposed ores ------------------------------------------------------
// THE rule for a block worth going to - the scan here, the far look, the explore's "found some" test and the survey
// all use it. With the explore on a looser rule (any sand in sight: the waterline, buried) every leg ended at once on
// sand this scan refuses, and "no reachable sand around" left the glass panes - and the house - waiting (2026-09-23).
// THE HOME GROUNDS: the safehouse, its furnace bank (rings out to 12 from the room) and the farm by it - the surface
// there is the base, not a quarry. The nearest dirt to a bot at home is its own yard: scaffold dirt and the farm's own
// hole-filling were dug from beside the farm until a pit 12 x 10 and 7 deep lay against the plot, the terrace and the
// furnace bank gone into it (2026-09-24). Underground (a mine under the yard) is not the surface.
function onGrounds (p) {
  const home = mem.get().home
  if (!home || p.y < home.y - 6) return false
  const hp = mem.get().hutPlan
  const i = hp && hp.interior ? hp.interior : { x1: home.x - 2, x2: home.x + 2, z1: home.z - 2, z2: home.z + 2 }
  const R = 2 * require('./hut').BANK_RINGS + 1 // the furnace bank's last ring and a step past it
  if (p.x >= i.x1 - R && p.x <= i.x2 + R && p.z >= i.z1 - R && p.z <= i.z2 + R) return true
  const f = mem.get().farm
  const a = f && require('./farm').area ? require('./farm').area(f) : null
  return !!a && p.x >= a.x1 - 2 && p.x <= a.x2 + 2 && p.z >= a.z1 - 2 && p.z <= a.z2 + 2
}

function takeable (bot, b) {
  return outOfZones(b) && !onGrounds(b.position) && world.hasAirNeighbour(bot, b.position) &&
    (!/^(dirt|grass_block|sand|gravel)$/.test(b.name) || (world.isAirish(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) && !world.lavaNear(bot, b.position, 2))) &&
    // (sand, gravel and clay live beside water: for them the rule is dry standing ground, not dry neighbours)
    // (no block with water beside or over it - sand included: a sand pit dug under the water line at the river filled
    //  with falling water and the bot drowned in it, 2026-09-23; clay has its own skill)
    // (refined: water beside it at its own level is only the shore - taking the beach's top layer leaves a puddle;
    //  water over it or beside it a level up is what pours into the hole. The strict rule left no sand on any beach)
    !world.waterNear(bot, b.position, 1, 1, 1) && !world.isWaterBlock(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) &&
    (!world.waterNear(bot, b.position, 1, 0, 0) || /^(sand|gravel|red_sand)$/.test(b.name)) && !world.lavaNear(bot, b.position, 1) && standableNear(bot, b.position)
}

// What a player notices on the way: sand, gravel and clay in view, remembered where it can be taken (the gather's own
// rules), so a later need walks straight there instead of searching. 150 blocks of forest round the Nordic site had
// no sand while the trek there had passed beaches (2026-09-23). Called after each travel leg; runs in the background,
// in slices, one survey at a time.
// ---- the lie of the land: which biomes lie where ----------------------------------------------------------
// A wood the build needs exactly grows only in its own country: no ring round a savanna home ever finds spruce, and a
// castle waited on 535 spruce logs with none on record (2026-09-27). The survey notes the biomes of the chunks in view as
// it walks - the client holds them, as a player sees the land change - and a chop with none of its species in sight or
// memory heads for the nearest country it grows in.
const SPECIES_BIOMES = {
  spruce: /^(taiga|snowy_taiga|old_growth_pine_taiga|old_growth_spruce_taiga|grove|windswept_forest|windswept_hills|snowy_plains)$/,
  birch: /^(birch_forest|old_growth_birch_forest|forest|meadow)$/,
  jungle: /^(jungle|sparse_jungle|bamboo_jungle)$/,
  acacia: /^(savanna|savanna_plateau|windswept_savanna)$/,
  dark_oak: /^dark_forest$/,
  cherry: /^cherry_grove$/,
  mangrove: /^mangrove_swamp$/,
  pale_oak: /^pale_garden$/
}
const CHOP_TICKS = 2400 // (two minutes at the trees: a trip's worth)
const BIOME_SPOTS = 8 // per biome: the nearest to home kept
let biomesAt = null
function noteBiomes (bot) {
  const me = bot.entity.position
  if (me.y < 55 || (biomesAt && world.dist2(biomesAt, me) < 48)) return // (underground: cave biomes; unmoved: nothing new)
  biomesAt = { x: me.x, z: me.z }
  const reg = bot.registry; const R = Math.min(world.sightReach(bot) || 96, 192)
  const seen = []
  for (let dx = -R; dx <= R; dx += 32) {
    for (let dz = -R; dz <= R; dz += 32) {
      const x = Math.floor(me.x) + dx; const z = Math.floor(me.z) + dz
      if (!bot.world.getColumnAt(new Vec3(x, 0, z))) continue // (not loaded: getBiome answers 0, a real biome's id)
      // (at the ground, where the trees are: at the bot's height a hill's column is rock, and 3D biomes there are caves)
      const gy = world.groundY(bot, x, z, Math.floor(me.y) + 48)
      if (gy == null) continue
      const p = new Vec3(x, gy + 1, z)
      const b = reg.biomes && reg.biomes[bot.world.getBiome(p)]
      if (b && b.name) seen.push([b.name.replace(/^minecraft:/, ''), p])
    }
  }
  const has = mem.get().biomes || {}; const home = mem.get().home
  // (new to the list, and one a full list would keep - else it goes straight out again, and the whole memory file is
  //  written on the event loop for nothing, every leg of a long walk)
  const keeps = (list, p) => list.length < BIOME_SPOTS || spreadEvict(list.concat([p]), home) !== list.length
  const fresh = seen.filter(([n, p]) => { const list = has[n] || []; return !list.some(q => world.dist2(q, p) < 96) && keeps(list, p) })
  if (!fresh.length) return
  const before = new Set(Object.keys(has).filter(n => has[n].length)) // (names, now: `has` IS the list the update grows)
  const added = new Set()
  mem.update(m => {
    m.biomes = m.biomes || {}
    for (const [n, p] of fresh) {
      const list = m.biomes[n] || (m.biomes[n] = [])
      if (list.some(q => world.dist2(q, p) < 96)) continue
      list.push({ x: p.x, z: p.z }); added.add(n)
      if (list.length > BIOME_SPOTS) list.splice(spreadEvict(list, m.home), 1)
    }
  })
  const novel = [...added].filter(n => !before.has(n))
  if (novel.length) log('gather', `new country in view: ${novel.join(', ')}`)
}
// A full biome list keeps a SPREAD, not the nearest: the spot nearest home stays (speciesLand walks to it), and the one
// crowding its neighbours closest goes - the list holding only the nearest eight refused every sighting further out, and
// the climate leads (which walk to the frontier) could never step past a few hundred blocks (audit 2026-09-28)
function spreadEvict (list, home) {
  let keep = -1
  if (home) list.forEach((q, i) => { if (keep < 0 || world.dist2(q, home) < world.dist2(list[keep], home)) keep = i })
  let worst = -1; let worstD = Infinity
  list.forEach((q, i) => {
    if (i === keep) return
    let nn = Infinity; list.forEach((r, j) => { if (j !== i) nn = Math.min(nn, world.dist2(q, r)) })
    if (nn < worstD || (nn === worstD && i > worst)) { worst = i; worstD = nn }
  })
  return worst
}
// The nearest remembered land a species grows in, from `from` (null: none known, or the species grows anywhere - oak)
function speciesLand (itemName, from) {
  const re = SPECIES_BIOMES[String(itemName).replace(/_(log|wood)$/, '')]
  if (!re) return null
  let best = null
  for (const [n, list] of Object.entries(mem.get().biomes || {})) {
    if (!re.test(n)) continue
    for (const q of list) { const d = world.dist2(q, from); if (!best || d < best.d) best = { x: q.x, z: q.z, biome: n, d } }
  }
  return best
}
// None of its country on record: the land nearest its CLIMATE. The world lays biomes out by temperature - taiga borders
// the cool forests, not a jungle - so the coolest land seen is the way towards spruce, and a trip there sees 160b further
// on; each one a step down the gradient till the country itself is in view. Water's biomes (rivers, shores, the sea)
// carry no climate of their own; a spot once walked to is not a lead again (2026-09-28: the home is jungle and savanna
// for 430b round, the one cool land a birch forest 410b west)
// (peaks and slopes neither: bare rock and snow, a climb not a walk - frozen peaks would outrank every forest by
//  temperature and send the bot up a cliff; audit 2026-09-28)
const NO_CLIMATE = /river|ocean|beach|shore|swamp|peaks|slopes|caves|deep_dark/ // (caves: a cave mouth in the sample - lush caves would outrank the birch forests; 2026-09-28)
function climateLead (bot, itemName, from) {
  const re = SPECIES_BIOMES[String(itemName).replace(/_(log|wood)$/, '')]
  const byName = (bot.registry && bot.registry.biomesByName) || {}
  const temp = n => { const b = byName[n] || byName['minecraft:' + n]; return b && typeof b.temperature === 'number' ? b.temperature : null }
  if (!re) return null
  const own = Object.keys(byName).map(n => n.replace(/^minecraft:/, '')).filter(n => re.test(n)).map(temp).filter(t => t != null)
  if (!own.length) return null
  const target = own.reduce((a, b) => a + b, 0) / own.length
  const walked = mem.get().climateLeads || []
  // (ties - every spot of one forest scores alike - go to the frontier, furthest from home: the nearest won a random walk
  //  among equals, not a descent; and one inside what the survey already sees opens nothing new - audit 2026-09-28)
  const home = mem.get().home || from; const seen = Math.min(world.sightReach(bot) || 96, 192)
  let best = null
  for (const [n, list] of Object.entries(mem.get().biomes || {})) {
    const t = temp(n); if (t == null || NO_CLIMATE.test(n)) continue
    const score = Math.abs(t - target)
    for (const q of list) {
      if (walked.some(w => world.dist2(w, q) < 96)) continue
      const d = world.dist2(q, from); if (d < seen) continue
      const out = world.dist2(q, home)
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) < 1e-9 && out > best.out)) best = { x: q.x, z: q.z, biome: n, d, out, score }
    }
  }
  return best
}
function walkedLead (spot) { mem.update(m => { (m.climateLeads = m.climateLeads || []).push({ x: spot.x, z: spot.z }); if (m.climateLeads.length > 32) m.climateLeads.shift() }) }
function forgetLand (spot) {
  mem.update(m => { for (const list of Object.values(m.biomes || {})) { const i = list.findIndex(q => q.x === spot.x && q.z === spot.z); if (i >= 0) list.splice(i, 1) } })
}

const SURVEY = [
  { kind: 'sand', re: /^sand$/, ok: (bot, b) => takeable(bot, b) },
  { kind: 'gravel', re: /^gravel$/, ok: (bot, b) => takeable(bot, b) },
  { kind: 'clay', re: /^clay$/, ok: (bot, b) => require('./clay').claySought(bot, b.position) },
  // woods, by species (noted under the log's own name): a forest 150 blocks past the site was never looked at while
  // the searches round home found nothing (2026-09-24)
  { kind: null, re: /^(oak|spruce|birch|jungle|acacia|cherry|dark_oak|mangrove|pale_oak)_log$/, names: 9, ok: (bot, b) => wildTree(bot, b) }
]
let surveying = false
function survey (bot) {
  if (surveying || !bot.entity) return
  surveying = true
  const run = async () => {
    try { noteBiomes(bot) } catch {}
    const notes = []
    for (const s of SURVEY) {
      // the nearest of EACH kind the pattern covers (woods by species): one hit a scan noted only whichever tree stood
      // nearest - a whole trek past spruce and dark oak put neither on record (2026-09-27). Judged in the scan, and only a
      // block NEARER than the best of its name so far (the nearest 60 logs of a one-species forest hid every other species
      // behind it, each judged a natural tree first - audit, 2026-09-27). "The first of a name in section order" was not the
      // nearest (audit R16, 2026-09-27): the nearest per name is read off the scan's distance order.
      const me = bot.entity.position.floored()
      const best = new Map()
      const d2 = p => (p.x - me.x) ** 2 + (p.y - me.y) ** 2 + (p.z - me.z) ** 2
      const nearer = x => { const d = d2(x.position); if (best.has(x.name) && d >= best.get(x.name)) return false; if (!s.ok(bot, x)) return false; best.set(x.name, d); return true }
      const hits = await world.scanBlocks(bot, s.re, { maxDistance: 48, count: 16 * (s.names || 1), filter: nearer })
      const had = new Set()
      for (const b of hits) if (!had.has(b.name)) { had.add(b.name); notes.push([s.kind || b.name, b.position]) }
    }
    // a source searched out round home (forage: acacia leaves, a bee nest full of honey, still water by a shore) seen on
    // the way opens again - the survey looks for exactly those, so it costs nothing while nothing is searched out
    const f = require('./forage'); const w = f.watch()
    f.sightMobs(bot)
    if (w) {
      const hits = await world.scanBlocks(bot, w.re, { maxDistance: 48, count: 8, filter: x => outOfZones(x) && w.sighted(bot, x).length > 0 })
      for (const b of hits) { notes.push([b.name, b.position]); f.seen(w.sighted(bot, b)) }
    }
    noteResources(notes)
  }
  run().catch(() => {}).finally(() => { surveying = false })
}

async function mine (bot, itemName, g, n, ctx = {}) {
  const target = inv.count(bot, itemName) + n
  // big stone/ore orders go underground
  if ((itemName === 'cobblestone' && n > 24) || g.ore) {
    const r = await mining().mineFor(bot, itemName, target, ctx)
    if (r || !g.ore) return inv.count(bot, itemName) >= target || r
  }
  let emptyScans = 0
  const t0 = Date.now()
  const refused = new Set() // blocks that would not dig this call: never the same one twice
  const triedKnown = new Set() // remembered spots walked to this call
  let atKnown = null // the remembered spot we just walked to: nothing takeable there now means forget it
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return false
    if (Date.now() - t0 > 15 * 60000) return false
    await reflex.waitClear()
    if (inv.freeSlots(bot) <= 1) await base().makeRoom(bot, 3)
    const me = bot.entity.position
    const cands = await world.scanBlocks(bot, g.blocks, {
      maxDistance: 40,
      // loose ground is mostly buried: the nearest 30 dirt blocks were all underground and the surface never
      // came up - look at more of them
      count: /^(dirt|sand|gravel|clay_ball)$/.test(itemName) ? 160 : 30,
      // (surface blocks at or above our feet: digging down into pits found a lava pocket under the castle)
      // (loose ground blocks only with their top open to the sky-side air - the surface, not the bottom of a pit -
      //  and no lava within 2: a pit dug toward a lava pocket killed the bot. Judged by the block, never by our
      //  own height: standing on the castle wall the old rule rejected every dirt block on the ground)
      filter: b => takeable(bot, b) && Math.abs(b.position.y - me.y) < 20
    })
    if (!cands.length) {
      log('gather', `no exposed ${itemName} within reach of standable ground nearby`)
      if (atKnown) { forgetResource(itemName, atKnown); log('gather', `the ${itemName} remembered at ${move.fmt(atKnown)} is gone - forgotten`); atKnown = null }
      if (itemName === 'cobblestone' || g.ore) return mining().mineFor(bot, itemName, target, ctx)
      // some further out (explore stops as soon as any is in sight, the scan above only looks 40 blocks):
      // walk over to the nearest and look again from there
      const far = (await world.scanBlocks(bot, g.blocks, { maxDistance: 128, count: 12, filter: b => takeable(bot, b) }))
        .sort((a, b) => world.dist3(a.position, me) - world.dist3(b.position, me))[0]
      if (far && world.dist3(far.position, me) > 30 && emptyScans < 3) {
        emptyScans++
        log('gather', `${itemName} at ${move.fmt(far.position)} - going there`)
        await move.travel(bot, far.position, { range: 6, shouldStop: ctx.shouldStop, label: 'to ' + itemName })
        continue
      }
      // some seen before (dug here, or noticed on a walk): go back to it
      const known = knownResource(itemName, me)
      if (known && !triedKnown.has(`${known.x},${known.z}`)) {
        triedKnown.add(`${known.x},${known.z}`)
        log('gather', `${itemName} remembered at ${move.fmt(known)} (${Math.round(world.dist2(known, me))}b) - going there`)
        await move.travel(bot, known, { range: 6, shouldStop: ctx.shouldStop, label: 'to ' + itemName })
        atKnown = known
        continue
      }
      if (++emptyScans > 4) { log('gather', `no reachable ${itemName} around`); return false }
      // sand and gravel lie where water meets land (beaches, river banks): a player walks to the shore to look, not in
      // rings - 150 blocks of forest round the Nordic site had none, the rings never reached the coast (2026-09-23)
      if (/^(sand|gravel)$/.test(itemName) && await toShore(bot, itemName, ctx)) continue
      await explore(bot, b => g.blocks.test(b.name), { shouldStop: ctx.shouldStop, label: itemName, accept: b => takeable(bot, b) })
      continue
    }
    emptyScans = 0
    atKnown = null
    const b = cands.find(c => !refused.has(`${c.position.x},${c.position.y},${c.position.z}`))
    if (!b) { log('gather', `every ${itemName} in reach refused to dig`); return false }
    noteResource(itemName, b.position)
    if (!inv.canHarvest(bot, b)) { log('gather', `can't harvest ${b.name} with my tools`); return false }
    const ok = await act.dig(bot, b.position, { timeoutMs: 20000 })
    if (ok) await act.collectDrops(bot, { radius: 5, maxMs: 5000 })
    else { refused.add(`${b.position.x},${b.position.y},${b.position.z}`); log('gather', `couldn't dig ${b.name} at ${move.fmt(b.position)}`) }
  }
  return true
}

// Flowers and the like: walk up, break, pick up. `itemName` is what the plant drops (counted in the pack; a
// RegExp when any of several will do - poppy, red tulip or rose bush for red dye).
// ctx.filter(b): which of the plants to take (a ripe cocoa pod, a cactus's top segment); ctx.force: a plant the dig's
// natural list lacks (cocoa, sea pickles, azaleas) - still never in a zone (outOfZones) nor a finished build cell (act.dig)
async function pickPlants (bot, re, itemName, n, ctx = {}) {
  const label = typeof itemName === 'string' ? itemName : ctx.label || (re.source.replace(/^\^\(?|\)?\$$/g, '').split('|')[0] + ' and the like')
  // (the red flowers' spots were stored as 'red flowers' before the label came from the pattern: still read, 2026-09-27)
  const legacy = typeof itemName !== 'string' && re.test('poppy') ? 'red flowers' : null
  const take = ctx.filter || (() => true)
  const target = inv.count(bot, itemName) + n
  let empty = 0
  const skip = new Set()
  while (inv.count(bot, itemName) < target) {
    await new Promise(r => setImmediate(r)) // yield: never spin on resolved promises
    if (ctx.shouldStop && ctx.shouldStop()) return false
    await reflex.waitClear()
    // (liquid water only: a waterlogged plant is a plant - every wild sea pickle is waterlogged, and the old test hid them
    //  all, 2026-09-27)
    const b = world.findBlocks(bot, re, { maxDistance: 48, count: 24, filter: x => outOfZones(x) && !skip.has(x.position.toString()) && !world.isLiquidWater(x) && take(x) })[0]
    if (!b) {
      if (++empty > 3) { log('gather', `no ${label} to pick around here`); return false }
      const known = knownResource(label, bot.entity.position) || (legacy && knownResource(legacy, bot.entity.position))
      if (known && empty === 1 && world.dist2(known, bot.entity.position) > 40) await move.travel(bot, known, { range: 8, shouldStop: ctx.shouldStop, label: 'to ' + label })
      else await explore(bot, x => re.test(x.name), { shouldStop: ctx.shouldStop, label, legs: 2, accept: x => outOfZones(x) && take(x) })
      continue
    }
    empty = 0
    noteResource(label, b.position)
    const before = inv.count(bot, itemName)
    if (await act.dig(bot, b.position, { timeoutMs: 15000, force: !!ctx.force })) await act.collectDrops(bot, { radius: 4, maxMs: 4000 })
    if (inv.count(bot, itemName) <= before) skip.add(b.position.toString())
  }
  return true
}

// Walk to surface water not looked at yet for `kind` (open sky over it, near the home's height): the shore is where
// sand and gravel show. Remembered per kind so each trip looks somewhere new. False when there is no such water.
async function toShore (bot, kind, ctx = {}) {
  const home = mem.get().home || bot.entity.position
  const key = 'shoreScouted_' + kind
  const seen = mem.get()[key] || []
  let next = 0
  const water = (await world.scanBlocks(bot, /^water$/, { maxDistance: 128, count: 40, filter: b => {
    if (b.position.y < home.y - 30 || (++next & 3)) return false // cheap first: height, and every 4th hit only
    return world.isAirish(world.at(bot, b.position.x, b.position.y + 1, b.position.z)) && world.openSky(bot, b.position) && outOfZones(b) && !seen.some(q => world.dist2(q, b.position) < 40)
  } })).filter(b => world.dist2(b.position, bot.entity.position) > 24)
  // nothing new in view (a coast 160 blocks off is out of the loaded chunks from home): go back to the shore looked at
  // longest ago - what it holds may be takeable now (the dig rule changed, a day's growth, other light)
  let w = water.length ? water[0].position : null
  if (!w && seen.length) { w = seen[0]; mem.update(m => { m[key] = (m[key] || []).slice(1) }) }
  if (!w) return false
  mem.update(m => { m[key] = (m[key] || []).concat([{ x: w.x, y: w.y, z: w.z }]).slice(-30) })
  log('gather', `no ${kind} in sight - heading to the water's edge at ${move.fmt(w)} to look`)
  await move.travel(bot, w, { range: 6, shouldStop: ctx.shouldStop, label: 'to the shore', maxMs: 3 * 60000 })
  return true
}

function standableNear (bot, p) {
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 1; dy++) {
    if (world.standable(bot, p.x + dx, p.y + dy, p.z + dz)) return true
  }
  return false
}

// Walk outward in a widening square from home (or here) until a matching block shows up.
async function explore (bot, match, { shouldStop, label = 'resources', legs = 4, accept = null, rings = null } = {}) {
  const home = mem.get().home || bot.entity.position
  mem.update(m => { m.exploreStep = (m.exploreStep || 0) + 1 })
  const step = mem.get().exploreStep
  // stay within ~150b of home (far trips cost more than they find) - animals in a hunted-out area are
  // the exception: they never respawn, so the search has to go wider; so is clay (rings: 9, out to ~300b)
  const radius = 48 + 32 * (step % (rings || (label === 'animals' ? 7 : 4)))
  const ang = step * 2.4
  const dest = { x: Math.round(home.x + Math.cos(ang) * radius), y: Math.round(bot.entity.position.y), z: Math.round(home.z + Math.sin(ang) * radius) }
  log('gather', `exploring for ${label} toward ${move.fmt(dest)} (radius ${radius})`)
  const t0 = Date.now()
  // (the walk polls stop() constantly: the look-around runs in the background, one at a time, at most every 2s, and
  //  stop() reads what the last one saw)
  let scannedAt = 0; let seen = null; let scanning = false
  const sighted = () => {
    if (!scanning && Date.now() - scannedAt > 2000) {
      scanning = true
      findMatching(bot, match, accept).then(r => { seen = r }, () => {}).finally(() => { scanning = false; scannedAt = Date.now() })
    }
    return seen
  }
  const stop = () => (shouldStop && shouldStop()) || Date.now() - t0 > 3 * 60000 || !!sighted()
  for (let i = 0; i < legs; i++) {
    const found = await findMatching(bot, match, accept)
    if (found) return found
    const r = await move.travel(bot, dest, { range: 10, shouldStop: stop, label: 'explore', maxMs: 90000, anyY: true })
    if (r.ok || r.why === 'stopped') break
  }
  return findMatching(bot, match, accept)
}
async function findMatching (bot, match, accept) {
  const names = Object.values(world.data(bot).blocksByName).filter(b => match({ name: b.name })).map(b => b.name)
  if (!names.length) return null
  const found = await world.scanBlocks(bot, new RegExp('^(' + names.join('|') + ')$'), { maxDistance: 64, count: accept ? 24 : 1 })
  if (!accept) return found[0] || null
  // only what the caller would actually take (the castle's own oak logs "found" a tree and ended every search)
  for (const b of found) if (accept(b)) return b
  return null
}

module.exports = { noteBiomes, speciesLand, climateLead, SPECIES_BIOMES, onGrounds, treeOK, wildTree, lastChopOutcome, outOfZones, chop, mine, explore, towerUp, noteResource, noteResources, forgetResource, knownResource, fellTree, pickPlants, survey, takeable }
