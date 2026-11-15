'use strict'
// Builds the Minecraft 26.3 (protocol 777) minecraft-data set into bot2/mc263/ from
//   - the installed, proven 26.2 data (bot2/node_modules/minecraft-data/minecraft-data/data/pc/26.2, installed by patch-mc262.js)
//   - ViaVersion/Mappings' registry tables mapping-26.2.json + mapping-26.3.json (ids in registry order), pinned below
//   - upstream minecraft-data pc_26_3 branch: only version.json and the common/ version lists, pinned below
//   - the hand-written protocol edits in protocol-263.js
// Every id-bearing file is remapped BY NAME from 26.2 ids to 26.3 ids; new 26.3 entries are cloned from their closest 26.2
// relative (see TEMPLATES / report). Deterministic and re-runnable:   node tools/mc263/build-data.js [--check]
// --check rebuilds in memory and fails if bot2/mc263 differs. Inputs are fetched over HTTPS (plain JSON) once into
// bot2/.mc263-data/ (gitignored) and verified by sha256.
const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')
const assert = require('assert')
const applyProtocol = require('./protocol-263')

const ROOT = path.join(__dirname, '..', '..')
const BOT2 = path.join(ROOT, 'bot2')
const D262 = path.join(BOT2, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '26.2')
const COMMON = path.join(BOT2, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', 'common')
const CACHE = path.join(BOT2, '.mc263-data')
const OUT = path.join(BOT2, 'mc263')

const MAPPINGS_SHA = 'f8417638304e82da3bdcca355596389b2d3d875c' // ViaVersion/Mappings, 2026-11-10
const MCDATA_SHA = 'e4cbec4b17815d6ce8d8ba991dd3b2d9d8f4a57d' // PrismarineJS/minecraft-data pc_26_3, 2026-09-15
const INPUTS = {
  'mappings/mapping-26.2.json': [`https://raw.githubusercontent.com/ViaVersion/Mappings/${MAPPINGS_SHA}/mappings/mapping-26.2.json`, 'bc9961304316def01b769fdfddcdbf7e6a96368fd8a6967846a28eb11c8c42e7'],
  'mappings/mapping-26.3.json': [`https://raw.githubusercontent.com/ViaVersion/Mappings/${MAPPINGS_SHA}/mappings/mapping-26.3.json`, '54f689bc3ab407c3596630d0a47955ec3d35fcd98225c2a8669104967b0c0a3e'],
  'data/pc/26.3/version.json': [`https://raw.githubusercontent.com/PrismarineJS/minecraft-data/${MCDATA_SHA}/data/pc/26.3/version.json`, null],
  'data/pc/common/protocolVersions.json': [`https://raw.githubusercontent.com/PrismarineJS/minecraft-data/${MCDATA_SHA}/data/pc/common/protocolVersions.json`, null],
  'data/pc/common/versions.json': [`https://raw.githubusercontent.com/PrismarineJS/minecraft-data/${MCDATA_SHA}/data/pc/common/versions.json`, null]
}
// sha256 of the installed 26.2 protocol.json this generator was written against (patch-mc262.js's pc_26_2 data)
const PROTOCOL_262_SHA = 'c24e5239cee9e8152c2d8b8c2cbcddff67c693d5ab0d2a3131ec6528802a4115'

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))
function get (url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mc263-build' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(url + ' -> HTTP ' + res.statusCode)); return }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}
async function input (rel) {
  const f = path.join(CACHE, rel)
  const [url, want] = INPUTS[rel]
  if (!fs.existsSync(f)) {
    console.log('[mc263] fetching', url)
    const b = await get(url)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, b)
  }
  const b = fs.readFileSync(f)
  if (want) assert.strictEqual(sha(b), want, '[mc263] sha256 mismatch for ' + f)
  return JSON.parse(b.toString('utf8'))
}

// ---------- names ----------
const title = n => n.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

// New 26.3 blocks/items/entities -> their closest 26.2 relative.
//   stats: hardness/resistance/material/harvest tools/light/stack size; shape: states layout, default state, collision, transparency
//   from/to: name substitution used for drops, loot and recipes
function template (name) {
  let m
  if (name.includes('poplar')) { const t = name.replace(/(red_|orange_|yellow_)?poplar/, 'pale_oak'); return { stats: t, shape: t, from: 'pale_oak', to: 'poplar', guess: false } }
  if ((m = name.match(/^(.+)_(wool|concrete)_(stairs|slab)$/))) {
    const shape = 'oak_' + m[3]
    return { stats: `${m[1]}_${m[2]}`, shape, from: shape, to: name, material: `${m[1]}_${m[2]}`, guess: true }
  }
  if ((m = name.match(/^(.+)_cushion$/)) && COLORS.includes(m[1])) return { stats: `${m[1]}_carpet`, shape: `${m[1]}_carpet`, from: `${m[1]}_carpet`, to: name, guess: true }
  if (name === 'straw_bed') return { stats: 'white_bed', shape: 'white_bed', from: 'white_bed', to: name, guess: true }
  if (name === 'red_shrub') return { stats: 'bush', shape: 'bush', from: 'bush', to: name, guess: true }
  if (name === 'shelf_mushroom') return { stats: 'brown_mushroom', shape: 'brown_mushroom', from: 'brown_mushroom', to: name, guess: true }
  if (/_map$/.test(name)) return { stats: 'filled_map', shape: 'filled_map', from: 'filled_map', to: name, guess: true }
  if (name === 'cushion') return { entity: 'falling_block', guess: true }
  throw new Error('[mc263] no template rule for new 26.3 entry ' + name)
}

// ---------- block states ----------
function parseState (s) {
  const m = s.match(/^([^[]+)(?:\[(.*)\])?$/)
  return { name: m[1], props: m[2] ? Object.fromEntries(m[2].split(',').map(kv => kv.split('='))) : {} }
}
function groupStates (table) {
  const g = new Map()
  table.blockstates.forEach((s, id) => {
    const p = parseState(s)
    if (!g.has(p.name)) g.set(p.name, { min: id, list: [] })
    g.get(p.name).list.push(p.props)
  })
  return g
}
function enumerate (states) { // minecraft-data order: first property slowest, values in listed order, bool true first
  let combos = [{}]
  for (const st of states) {
    const vals = st.type === 'bool' ? ['true', 'false'] : st.values
    const next = []
    for (const c of combos) for (const v of vals) next.push(Object.assign({}, c, { [st.name]: v }))
    combos = next
  }
  return combos
}
const sameProps = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k])
function deriveStates (list) { // a new block's property list from its states in id order
  const names = Object.keys(list[0])
  const info = names.map(n => {
    const values = []
    for (const s of list) if (!values.includes(s[n])) values.push(s[n])
    const stride = list.findIndex(s => s[n] !== list[0][n])
    let type = 'enum'
    if (values.every(v => v === 'true' || v === 'false')) type = 'bool'
    else if (values.every(v => /^\d+$/.test(v))) type = 'int'
    const st = { name: n, type, num_values: values.length }
    if (type !== 'bool') st.values = values
    else assert.deepStrictEqual(values, ['true', 'false'], 'bool order')
    return { st, stride: stride < 0 ? Infinity : stride }
  })
  info.sort((a, b) => b.stride - a.stride)
  const states = info.map(i => i.st)
  const combos = enumerate(states)
  assert.strictEqual(combos.length, list.length)
  combos.forEach((c, i) => assert(sameProps(c, list[i]), 'derived state order'))
  return states
}

async function build () {
  const p2 = await input('mappings/mapping-26.2.json')
  const p3 = await input('mappings/mapping-26.3.json')
  const version = await input('data/pc/26.3/version.json')
  const upVersions = await input('data/pc/common/versions.json')
  const upProtocolVersions = await input('data/pc/common/protocolVersions.json')
  const protoBuf = fs.readFileSync(path.join(D262, 'protocol.json'))
  assert.strictEqual(sha(protoBuf), PROTOCOL_262_SHA, '[mc263] the installed 26.2 protocol.json is not the one this generator was written against')
  const old = n => readJson(path.join(D262, n + '.json'))
  const report = { guesses: [], counts: {} }
  const out = {}

  // ----- items -----
  const items2 = old('items')
  items2.forEach(it => assert.strictEqual(p2.items[it.id], it.name, 'mapping-26.2 items vs installed 26.2'))
  const item2ByName = new Map(items2.map(i => [i.name, i]))
  const itemId3 = new Map(p3.items.map((n, i) => [n, i]))
  const itemName2 = new Map(items2.map(i => [i.id, i.name]))
  const mapItem = id => {
    if (id === null || id === undefined) return id
    const n = itemName2.get(id)
    assert(n !== undefined, '[mc263] unknown 26.2 item id ' + id)
    const nid = itemId3.get(n)
    assert(nid !== undefined, '[mc263] 26.2 item missing in 26.3: ' + n)
    return nid
  }
  out.items = p3.items.map((name, id) => {
    const o = item2ByName.get(name)
    if (o) return Object.assign({}, o, { id })
    const t = template(name)
    const base = item2ByName.get(t.stats)
    assert(base, '[mc263] item template missing: ' + t.stats)
    const it = { id, name, displayName: title(name), stackSize: base.stackSize }
    for (const k of Object.keys(base)) if (!(k in it)) it[k] = base[k]
    if (t.guess) report.guesses.push(`item ${name}: stack size ${it.stackSize} from ${t.stats}`)
    return it
  })

  // ----- blocks -----
  const blocks2 = old('blocks')
  const block2ByName = new Map(blocks2.map(b => [b.name, b]))
  const g2 = groupStates(p2); const g3 = groupStates(p3)
  for (const b of blocks2) { // the 26.2 table is read correctly: same state layout as the installed data
    assert.strictEqual(p2.blocks[b.id], b.name)
    const e = enumerate(b.states)
    const g = g2.get(b.name)
    assert(g.min === b.minStateId && g.list.length === e.length && e.every((c, i) => sameProps(c, g.list[i])), 'states of ' + b.name)
  }
  assert.deepStrictEqual([...g3.keys()], p3.blocks, 'mapping-26.3 blockstates follow block order')
  const remapTools = h => h && Object.fromEntries(Object.entries(h).map(([k, v]) => [String(mapItem(+k)), v]).sort((a, b) => a[0] - b[0]))
  const subName = (t, n, self) => { // a template's drop -> the new entry's equivalent (its own item for the template itself)
    if ((n === t.stats || n === t.shape) && itemId3.has(self)) return self
    const s = n.split(t.from).join(t.to)
    return s !== n && itemId3.has(s) ? s : n
  }
  out.blocks = p3.blocks.map((name, id) => {
    const g = g3.get(name)
    const o = block2ByName.get(name)
    if (o) {
      assert(sameProps(g.list[0], g2.get(name).list[0]) && g.list.length === g2.get(name).list.length, 'block states changed: ' + name)
      const b = Object.assign({}, o, { id, minStateId: g.min, maxStateId: g.min + g.list.length - 1, defaultState: g.min + (o.defaultState - o.minStateId) })
      if (b.drops) b.drops = b.drops.map(mapItem)
      if (b.harvestTools) b.harvestTools = remapTools(b.harvestTools)
      return b
    }
    const t = template(name)
    const stats = block2ByName.get(t.stats); const shape = block2ByName.get(t.shape)
    assert(stats && shape, '[mc263] block template missing for ' + name)
    const states = g.list.length === 1 && Object.keys(g.list[0]).length === 0 ? [] : deriveStates(g.list)
    let def = 0
    if (shape.states.length && eq(shape.states.map(s => s.name).sort(), states.map(s => s.name).sort())) {
      const tdef = enumerate(shape.states)[shape.defaultState - shape.minStateId]
      def = Math.max(0, g.list.findIndex(s => sameProps(s, tdef)))
    } else if (states.length) report.guesses.push(`block ${name}: default state = its first state (no template with the same properties)`)
    const b = {
      id,
      name,
      displayName: title(name),
      hardness: stats.hardness,
      resistance: stats.resistance,
      stackSize: (out.items.find(i => i.name === name) || stats).stackSize,
      diggable: stats.diggable,
      material: stats.material,
      transparent: shape.transparent,
      emitLight: stats.emitLight,
      filterLight: shape.filterLight,
      defaultState: g.min + def,
      minStateId: g.min,
      maxStateId: g.min + g.list.length - 1,
      states
    }
    if (stats.harvestTools) b.harvestTools = remapTools(stats.harvestTools)
    b.drops = (t.material ? [itemId3.get(name)] : (stats.drops || []).map(d => itemId3.get(subName(t, itemName2.get(d), name)))).filter(x => x !== undefined)
    b.boundingBox = shape.boundingBox
    if (t.guess) report.guesses.push(`block ${name}: hardness/material/tools from ${t.stats}, shape/transparency from ${t.shape}, drops ${JSON.stringify(b.drops.map(d => p3.items[d]))}`)
    return b
  })

  // ----- collision shapes -----
  const cs = old('blockCollisionShapes')
  out.blockCollisionShapes = { blocks: {}, shapes: cs.shapes }
  for (const b of out.blocks) {
    if (b.name in cs.blocks) { out.blockCollisionShapes.blocks[b.name] = cs.blocks[b.name]; continue }
    const t = template(b.name)
    const v = cs.blocks[t.shape]
    assert(v !== undefined, 'collision template ' + t.shape)
    if (Array.isArray(v)) assert.strictEqual(v.length, b.maxStateId - b.minStateId + 1, 'collision states ' + b.name)
    out.blockCollisionShapes.blocks[b.name] = v
  }

  // ----- entities -----
  const ents2 = old('entities')
  ents2.forEach(e => assert.strictEqual(p2.entities[e.id], e.name, 'mapping-26.2 entities vs installed'))
  const ent2ByName = new Map(ents2.map(e => [e.name, e]))
  out.entities = p3.entities.map((name, id) => {
    const o = ent2ByName.get(name)
    if (o) return Object.assign({}, o, { id, internalId: id })
    const t = template(name)
    if (t.entity) { // cushion: ViaBackwards shows it as a falling white carpet with no gravity; it has entity data past index 7
      const base = ent2ByName.get(t.entity)
      const e = { id, internalId: id, name, displayName: title(name), width: 1, height: 0.0625, type: base.type, category: base.category, metadataKeys: base.metadataKeys.slice(0, 8).concat(['color']) }
      report.guesses.push(`entity ${name}: size 1 x 0.0625 (a carpet), metadata keys base entity + "color"`)
      return e
    }
    const base = ent2ByName.get(t.stats)
    assert(base, 'entity template ' + t.stats)
    return Object.assign({}, base, { id, internalId: id, name, displayName: base.displayName.replace('Pale Oak', 'Poplar') })
  })

  // ----- particles, sounds -----
  const parts2 = old('particles')
  parts2.forEach(p => assert.strictEqual(p2.particles[p.id], p.name))
  out.particles = p3.particles.map((name, id) => ({ id, name }))
  const sounds2 = old('sounds')
  sounds2.forEach(s => assert.strictEqual(p2.sounds[s.id - 1], s.name))
  out.sounds = p3.sounds.map((name, i) => ({ id: i + 1, name }))

  // ----- foods, materials -----
  out.foods = old('foods').map(f => Object.assign({}, f, { id: mapItem(f.id) })).sort((a, b) => a.id - b.id)
  const mats = old('materials')
  out.materials = Object.fromEntries(Object.entries(mats).map(([k, v]) => [k, remapTools(v)]))

  // ----- recipes -----
  const rec2 = old('recipes')
  const mapRecipe = r => {
    const o = {}
    if (r.inShape) o.inShape = r.inShape.map(row => row.map(mapItem))
    if (r.outShape) o.outShape = r.outShape.map(row => row.map(mapItem))
    if (r.ingredients) o.ingredients = r.ingredients.map(mapItem)
    o.result = Object.assign({}, r.result, { id: mapItem(r.result.id) })
    for (const k of Object.keys(r)) if (!(k in o)) o[k] = r[k]
    return o
  }
  const rec = {}
  for (const [k, list] of Object.entries(rec2)) rec[mapItem(+k)] = list.map(mapRecipe)
  const idsOf = r => [...(r.inShape || []).flat(), ...(r.outShape || []).flat(), ...(r.ingredients || []), r.result.id].filter(x => x !== null && x !== undefined)
  const subRecipe = (r, f) => {
    const m = id => id === null || id === undefined ? id : f(id)
    const o = JSON.parse(JSON.stringify(r))
    if (o.inShape) o.inShape = o.inShape.map(row => row.map(m))
    if (o.outShape) o.outShape = o.outShape.map(row => row.map(m))
    if (o.ingredients) o.ingredients = o.ingredients.map(m)
    o.result.id = m(o.result.id)
    return o
  }
  const addRecipe = r => {
    const list = rec[r.result.id] = rec[r.result.id] || []
    if (!list.some(x => eq(x, r))) list.push(r)
  }
  // wood set: every recipe that uses or makes a pale oak item gets a poplar twin (both are plain overworld wood sets)
  let poplarRecipes = 0
  for (const list of Object.values(rec)) {
    for (const r of list.slice()) {
      const ids = idsOf(r)
      if (!ids.some(id => p3.items[id].includes('pale_oak'))) continue
      let ok = true
      const t = subRecipe(r, id => {
        const n = p3.items[id]
        if (!n.includes('pale_oak')) return id
        const s = n.replace('pale_oak', 'poplar')
        if (!itemId3.has(s)) { ok = false; return id }
        return itemId3.get(s)
      })
      if (ok) { addRecipe(t); poplarRecipes++ }
    }
  }
  // wool / concrete stairs and slabs: shaped like every other stairs/slab recipe (guess, see report)
  const oakStairs = rec[itemId3.get('oak_stairs')].find(r => idsOf(r).includes(itemId3.get('oak_planks')))
  const oakSlab = rec[itemId3.get('oak_slab')].find(r => idsOf(r).includes(itemId3.get('oak_planks')))
  for (const name of p3.items) {
    const m = name.match(/^(.+_(?:wool|concrete))_(stairs|slab)$/)
    if (!m) continue
    const base = m[2] === 'stairs' ? oakStairs : oakSlab
    addRecipe(subRecipe(base, id => id === itemId3.get('oak_planks') ? itemId3.get(m[1]) : id === base.result.id ? itemId3.get(name) : id))
  }
  report.guesses.push('recipes: wool/concrete stairs (6 -> 4) and slabs (3 -> 6) shaped like oak; none for straw_bed, cushions, red_shrub, shelf_mushroom, explorer maps (unknown)')
  report.counts.poplarRecipes = poplarRecipes
  out.recipes = Object.fromEntries(Object.keys(rec).map(Number).sort((a, b) => a - b).map(k => [String(k), rec[k]]))
  for (const [k, list] of Object.entries(out.recipes)) for (const r of list) for (const id of idsOf(r)) assert(p3.items[id] !== undefined, 'recipe id ' + id + ' in ' + k)

  // ----- loot (by name) -----
  const bl2 = old('blockLoot')
  const blByName = new Map(bl2.map(l => [l.block, l]))
  out.blockLoot = out.blocks.map(b => {
    const l = blByName.get(b.name)
    if (l) return l
    if (block2ByName.has(b.name)) return null // no loot entry in 26.2 either
    const t = template(b.name)
    const tl = blByName.get(t.material ? t.shape : t.stats)
    if (!tl) return { block: b.name, drops: b.drops.map(d => ({ item: p3.items[d], dropChance: 1, stackSizeRange: [1, 1] })) } // (the 26.2 loot table has no entry for the template either)
    return { block: b.name, drops: tl.drops.map(d => Object.assign({}, d, { item: subName(t, d.item, b.name) })) }
  }).filter(Boolean)
  const el2 = old('entityLoot')
  const elByName = new Map(el2.map(l => [l.entity, l]))
  out.entityLoot = out.entities.map(e => {
    const l = elByName.get(e.name)
    if (l) return l
    if (ent2ByName.has(e.name)) return null
    const t = template(e.name)
    const tl = t.entity ? null : elByName.get(t.stats)
    return { entity: e.name, drops: tl ? tl.drops.map(d => Object.assign({}, d, { item: subName(t, d.item, e.name) })) : [] }
  }).filter(Boolean)

  // ----- protocol -----
  out.protocol = applyProtocol(JSON.parse(protoBuf.toString('utf8')), { p2, p3 })
  out.version = version
  assert.strictEqual(version.version, 777)

  // ----- common: protocolVersions (upstream is a superset of the installed list) + versions (both 26.2 and 26.3) -----
  const instPV = readJson(path.join(COMMON, 'protocolVersions.json'))
  const upKeys = new Set(upProtocolVersions.map(x => JSON.stringify(x)))
  const missing = instPV.filter(x => !upKeys.has(JSON.stringify(x)))
  out['common/protocolVersions'] = missing.length ? upProtocolVersions.concat(missing) : upProtocolVersions
  assert(out['common/protocolVersions'].some(x => x.minecraftVersion === '26.2' && x.version === 776))
  assert(out['common/protocolVersions'].some(x => x.minecraftVersion === '26.3' && x.version === 777))
  const instV = readJson(path.join(COMMON, 'versions.json'))
  const vers = instV.slice()
  for (const v of upVersions) if (!vers.includes(v)) vers.push(v)
  out['common/versions'] = vers

  // ----- dataPaths entry: changed files from pc/26.3, the rest stays on the 26.2 entry -----
  const dp = readJson(path.join(BOT2, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'dataPaths.json')).pc['26.2']
  assert(dp, '[mc263] installed dataPaths has no 26.2 entry - run patch-mc262.js first')
  const own = ['protocol', 'version', 'blocks', 'items', 'entities', 'recipes', 'foods', 'materials', 'particles', 'blockCollisionShapes', 'sounds', 'blockLoot', 'entityLoot']
  out.dataPaths = Object.fromEntries(Object.entries(dp).map(([k, v]) => [k, own.includes(k) ? 'pc/26.3' : v]))
  for (const k of own) assert(k in out.dataPaths, 'dataPaths key ' + k)

  report.counts.blocks = out.blocks.length; report.counts.states = p3.blockstates.length
  report.counts.items = out.items.length; report.counts.entities = out.entities.length
  return { out, report }
}

function serialize (out) {
  const files = {}
  for (const [k, v] of Object.entries(out)) files[k + '.json'] = JSON.stringify(v, null, 2) + '\n'
  return files
}

async function main () {
  const { out, report } = await build()
  const files = serialize(out)
  if (process.argv.includes('--check')) {
    let bad = 0
    for (const [f, s] of Object.entries(files)) {
      const p = path.join(OUT, f)
      if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== s) { console.log('[mc263] differs:', f); bad++ }
    }
    if (bad) process.exit(1)
    console.log('[mc263] bot2/mc263 is up to date')
    return
  }
  for (const [f, s] of Object.entries(files)) {
    const p = path.join(OUT, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, s)
  }
  console.log('[mc263] wrote', Object.keys(files).length, 'files to', path.relative(ROOT, OUT), JSON.stringify(report.counts))
  const colors = new RegExp('\\b(' + COLORS.slice().sort((a, b) => b.length - a.length).join('|') + ')_', 'g')
  const seen = new Map()
  for (const g of report.guesses) { const k = g.replace(colors, '<color>_'); seen.set(k, (seen.get(k) || 0) + 1) }
  for (const [g, n] of seen) console.log('[mc263] guess:', g + (n > 1 ? ` (x${n})` : ''))
}

if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1) })
module.exports = { build }
