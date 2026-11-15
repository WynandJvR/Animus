'use strict'
// Offline proof that the installed 26.3 overlay works (run after bot2/patch-mc262.js). Exits non-zero on any failure.
//   node tools/mc263/check.js
// Never connects anywhere: protocol checks run serializer -> deserializer in memory, mineflayer runs on a fake client.
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const assert = require('assert')
const { createRequire } = require('module')

const BOT2 = path.join(__dirname, '..', '..', 'bot2')
const req = createRequire(path.join(BOT2, 'package.json'))
const MAPS = path.join(BOT2, '.mc263-data', 'mappings')
const PROTOCOL_262_SHA = 'c24e5239cee9e8152c2d8b8c2cbcddff67c693d5ab0d2a3131ec6528802a4115'

let failures = 0
const results = []
async function check (name, fn) {
  try {
    const note = await fn()
    results.push(`PASS ${name}${note ? ' - ' + note : ''}`)
  } catch (e) {
    failures++
    results.push(`FAIL ${name} - ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
  }
}
const parseState = s => {
  const m = s.match(/^([^[]+)(?:\[(.*)\])?$/)
  return { name: m[1], props: m[2] ? Object.fromEntries(m[2].split(',').map(kv => kv.split('='))) : {} }
}

async function main () {
  const mcData = req('minecraft-data')
  const m3 = JSON.parse(fs.readFileSync(path.join(MAPS, 'mapping-26.3.json'), 'utf8'))
  let d3

  await check('minecraft-data 26.3 loads', () => {
    d3 = mcData('26.3')
    assert(d3, 'no data')
    assert.strictEqual(d3.version.version, 777)
    assert.strictEqual(d3.version.minecraftVersion, '26.3')
    for (const n of ['chest', 'oak_planks', 'cobblestone', 'sugar_cane', 'white_bed', 'spruce_planks', 'poplar_log', 'white_wool_stairs']) assert(d3.blocksByName[n], 'missing block ' + n)
    return `protocol ${d3.version.version}, ${d3.blocksArray.length} blocks, ${d3.itemsArray.length} items, ${d3.entitiesArray.length} entities`
  })

  await check('block state ranges contiguous, non-overlapping, total = mapping-26.3 blockstates', () => {
    const bs = d3.blocksArray.slice().sort((a, b) => a.minStateId - b.minStateId)
    let next = 0
    for (const b of bs) {
      assert.strictEqual(b.minStateId, next, 'gap/overlap before ' + b.name)
      assert(b.maxStateId >= b.minStateId && b.defaultState >= b.minStateId && b.defaultState <= b.maxStateId, 'range ' + b.name)
      next = b.maxStateId + 1
    }
    assert.strictEqual(next, m3.blockstates.length)
    assert.strictEqual(d3.blocksArray.length, m3.blocks.length)
    d3.blocksArray.forEach(b => assert.strictEqual(m3.blocks[b.id], b.name, 'block id ' + b.id))
    return `${next} states`
  })

  await check('every state id: name and properties match mapping-26.3 (prismarine-block)', () => {
    const Block = req('prismarine-block')('26.3')
    let n = 0
    const step = 1 // all of them (a sample of >= 200 is the minimum asked for)
    for (let id = 0; id < m3.blockstates.length; id += step) {
      const want = parseState(m3.blockstates[id])
      assert.strictEqual(d3.blocksByStateId[id].name, want.name, 'state ' + id)
      const b = Block.fromStateId(id, 0)
      assert.strictEqual(b.name, want.name, 'prismarine-block state ' + id)
      const got = b.getProperties()
      for (const [k, v] of Object.entries(want.props)) assert.strictEqual(String(got[k]), v, `state ${id} ${want.name} ${k}`)
      assert.strictEqual(Object.keys(got).length, Object.keys(want.props).length, 'prop count ' + id)
      n++
    }
    return `${n} states checked`
  })

  await check('item ids and entity ids match mapping-26.3', () => {
    assert.strictEqual(d3.itemsArray.length, m3.items.length)
    m3.items.forEach((n, i) => assert.strictEqual(d3.items[i].name, n, 'item ' + i))
    assert.strictEqual(d3.entitiesArray.length, m3.entities.length)
    m3.entities.forEach((n, i) => assert.strictEqual(d3.entities[i].name, n, 'entity ' + i))
    m3.particles.forEach((n, i) => assert.strictEqual(d3.particles[i].name, n, 'particle ' + i))
    m3.sounds.forEach((n, i) => assert.strictEqual(d3.sounds[i + 1].name, n, 'sound ' + i))
    for (const b of d3.blocksArray) for (const id of b.drops || []) assert(d3.items[id], 'drop of ' + b.name)
    for (const b of d3.blocksArray) for (const id of Object.keys(b.harvestTools || {})) assert(d3.items[id], 'tool of ' + b.name)
    for (const f of d3.foodsArray) assert.strictEqual(d3.items[f.id].name, f.name, 'food ' + f.name)
    for (const [m, tools] of Object.entries(d3.materials)) for (const id of Object.keys(tools)) assert(d3.items[id], 'material ' + m)
    assert.deepStrictEqual(Object.keys(d3.blocksByName.stone.harvestTools).map(i => d3.items[i].name).sort(), ['copper_pickaxe', 'diamond_pickaxe', 'golden_pickaxe', 'iron_pickaxe', 'netherite_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'])
    assert.strictEqual(d3.foodsByName.bread.foodPoints, 5)
    return `${m3.items.length} items, ${m3.entities.length} entities, ${m3.particles.length} particles, ${m3.sounds.length} sounds`
  })

  await check('recipes: every id resolves; known recipes by name', () => {
    const name = id => { assert(d3.items[id], 'bad recipe id ' + id); return d3.items[id].name }
    let n = 0
    for (const [k, list] of Object.entries(d3.recipes)) {
      name(+k)
      for (const r of list) {
        n++
        assert.strictEqual(r.result.id, +k)
        for (const id of [...(r.inShape || []).flat(), ...(r.outShape || []).flat(), ...(r.ingredients || [])]) if (id !== null) name(id)
      }
    }
    const shapeNames = r => JSON.stringify((r.inShape || []).map(row => row.map(i => i === null ? null : name(i))))
    const ingNames = r => (r.ingredients || []).map(name).sort().join(',')
    const R = n => d3.recipes[d3.itemsByName[n].id] || []
    assert(R('crafting_table').some(r => shapeNames(r) === JSON.stringify([['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks']]) && r.result.count === 1), 'crafting_table')
    assert(R('crafting_table').some(r => shapeNames(r) === JSON.stringify([['poplar_planks', 'poplar_planks'], ['poplar_planks', 'poplar_planks']])), 'crafting_table from poplar')
    assert(R('stick').some(r => shapeNames(r) === JSON.stringify([['spruce_planks'], ['spruce_planks']]) && r.result.count === 4), 'stick')
    const ring = m => JSON.stringify([[m, m, m], [m, null, m], [m, m, m]])
    assert(R('chest').some(r => shapeNames(r) === ring('oak_planks') && r.result.count === 1), 'chest')
    assert(R('furnace').some(r => shapeNames(r) === ring('cobblestone')), 'furnace')
    assert(R('bread').some(r => shapeNames(r) === JSON.stringify([['wheat', 'wheat', 'wheat']]) || ingNames(r) === 'wheat,wheat,wheat'), 'bread')
    assert(R('oak_door').some(r => shapeNames(r) === JSON.stringify([['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks']]) && r.result.count === 3), 'oak_door')
    assert(R('oak_planks').some(r => ingNames(r) === 'oak_log' && r.result.count === 4), 'oak_planks')
    assert(R('poplar_planks').some(r => ingNames(r) === 'poplar_log' && r.result.count === 4), 'poplar_planks')
    const Recipe = req('prismarine-recipe')('26.3').Recipe
    assert(Recipe.find(d3.itemsByName.chest.id).length > 0, 'prismarine-recipe chest')
    return `${n} recipes`
  })

  // ---------------- protocol ----------------
  const mc = req('minecraft-protocol')
  const { createSerializer, createDeserializer } = req('minecraft-protocol/src/transforms/serializer')
  const states = req('minecraft-protocol/src/states')
  await check('minecraft-protocol builds (de)serializers for every 26.3 state and direction', () => {
    for (const state of [states.HANDSHAKING, states.STATUS, states.LOGIN, states.CONFIGURATION, states.PLAY]) {
      for (const isServer of [false, true]) {
        createSerializer({ state, isServer, version: '26.3' })
        createDeserializer({ state, isServer, version: '26.3' })
      }
    }
    assert(mc.supportedVersions.includes('26.3'), 'minecraft-protocol supportedVersions')
  })

  const clean = v => JSON.parse(JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : (x && x.type === 'Buffer' && Array.isArray(x.data)) ? x : x))
  function encode (state, toClient, name, params) {
    const ser = createSerializer({ state, isServer: toClient, version: '26.3' })
    return ser.createPacketBuffer({ name, params })
  }
  function decode (state, toClient, buf) {
    const des = createDeserializer({ state, isServer: !toClient, version: '26.3', noErrorLogging: true })
    const r = des.parsePacketBuffer(buf)
    assert.strictEqual(r.metadata.size, buf.length, 'did not consume the whole packet')
    return r.data
  }
  function roundTrip (state, toClient, name, params, expect = params) {
    const buf = encode(state, toClient, name, params)
    const back = decode(state, toClient, buf)
    assert.strictEqual(back.name, name)
    assert.deepStrictEqual(clean(back.params), clean(expect), name + ' round trip')
    return buf
  }
  const varint = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x) } while (n); return Buffer.from(b) }
  const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b }
  const f64 = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b }
  const f32 = n => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b }
  const pid = (dir, name) => {
    const m = d3.protocol.play[dir].types.packet[1][0].type[1].mappings
    return parseInt(Object.keys(m).find(k => m[k] === name), 16)
  }
  const P = states.PLAY

  await check('packet ids follow the 26.3 enums (spot checks)', () => {
    const want = { toClient: { add_transient_block: 0x25, map_chunk: 0x2e, world_particles: 0x30, login: 0x32, rel_entity_move: 0x36, position: 0x49, post_effects: 0x53, respawn: 0x54, entity_metadata: 0x65, set_slot: 0x14, window_items: 0x12, swing_animation: 0x7b, system_chat: 0x7c, show_dialog: 0x8f }, toServer: { teleport_confirm: 0x00, window_click: 0x12, position: 0x1e, block_dig: 0x29, punch: 0x2e, spectator_action: 0x3f, block_place: 0x42, use_item: 0x43, custom_click_action: 0x44 } }
    for (const dir of ['toClient', 'toServer']) for (const [n, id] of Object.entries(want[dir])) assert.strictEqual(pid(dir, n), id, `${dir} ${n}`)
    assert.strictEqual(pid('toServer', 'arm_animation'), NaN, 'arm_animation must be gone')
    const cfg = d3.protocol.configuration.toClient.types.packet[1][0].type[1].mappings
    assert.strictEqual(cfg['0x0a'], 'post_effects'); assert.strictEqual(cfg['0x14'], 'code_of_conduct')
  })

  const item = (name, components = [], removed = []) => ({ itemCount: 1, itemId: d3.itemsByName[name].id, addedComponentCount: components.length, removedComponentCount: removed.length, components, removeComponents: removed.map(type => ({ type })) })
  const nbtText = s => ({ type: 'string', value: s })
  const richItem = () => item('diamond_sword', [
    { type: 'damage', data: 12 },
    { type: 'custom_name', data: nbtText('Edge') },
    { type: 'enchantments', data: { enchantments: [{ id: 3, level: 2 }] } },
    { type: 'attack_animation', data: { type: 'stab', duration: 6 } },
    { type: 'cooking_fuel', data: { burnTime: { isValue: true, value: 200 }, speedMultiplier: { isValue: false, value: 'minecraft:fast' } } },
    { type: 'trim', data: { material: { data: { paletteId: 'minecraft:trim/gold', description: nbtText('Gold') } }, pattern: { patternId: 3 } } },
    { type: 'sign_text_front', data: { messages: [nbtText('a'), nbtText('b'), nbtText('c'), nbtText('d')], filteredMessages: undefined, color: 'black', hasGlowingText: false } },
    { type: 'waxed', data: undefined },
    { type: 'cushion/color', data: 'red' },
    { type: 'instrument', data: { instrumentId: 2 } },
    { type: 'pot_decorations', data: { back: { itemId: d3.itemsByName.brick.id, itemCount: 1, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] }, left: undefined, right: undefined, front: undefined } },
    { type: 'jukebox_playable', data: { songId: 4 } }
  ], ['food'])

  await check('round trip: serverbound position / teleport_confirm / punch / block_dig / block_place / use_item / update_sign', () => {
    roundTrip(P, false, 'position', { x: 1.5, y: 64, z: -2.25, flags: { onGround: true, hasHorizontalCollision: false } }, { x: 1.5, y: 64, z: -2.25, flags: { _value: 1, onGround: true, hasHorizontalCollision: false } })
    roundTrip(P, false, 'teleport_confirm', { teleportId: 7, x: 10.5, y: 65, z: -3.5, yaw: 90, pitch: 0 })
    const punch = roundTrip(P, false, 'punch', {})
    assert.deepStrictEqual([...punch], [0x2e])
    roundTrip(P, false, 'block_dig', { status: 2, location: { x: 1, y: 63, z: -5 }, face: 1, sequence: 9 })
    roundTrip(P, false, 'block_place', { hand: 0, location: { x: 1, y: 63, z: -5 }, direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false, worldBorderHit: false, sequence: 10 })
    roundTrip(P, false, 'use_item', { hand: 0, sequence: 11, rotation: { x: 0, y: 0 } })
    const sign = encode(P, false, 'update_sign', { location: { x: 0, y: 64, z: 0 }, text1: 'a', text2: 'b', text3: 'c', text4: 'd', isFrontText: true })
    assert.strictEqual(sign[sign.length - 1], 1, 'front text slot = 1 at the end')
  })

  await check('round trip: window_click with a hashed item carrying components', () => {
    roundTrip(P, false, 'window_click', {
      windowId: 3,
      stateId: 41,
      slot: 5,
      mouseButton: 0,
      mode: 0,
      changedSlots: [{ location: 5, item: { itemId: d3.itemsByName.oak_planks.id, itemCount: 4, components: [{ type: 'attack_animation', hash: 123 }, { type: 'waxed', hash: -5 }], removeComponents: [{ type: 'food' }] } }],
      cursorItem: { itemId: d3.itemsByName.diamond_sword.id, itemCount: 1, components: [{ type: 'damage', hash: 99 }], removeComponents: [] }
    })
  })

  await check('round trip: set_slot / window_items with 26.3 components', () => {
    roundTrip(P, true, 'set_slot', { windowId: 0, stateId: 2, slot: 36, item: richItem() })
    roundTrip(P, true, 'window_items', { windowId: 1, stateId: 3, items: [richItem(), { itemCount: 0 }, item('cobblestone')], carriedItem: item('stick') })
  })

  await check('round trip: entity_metadata (item, dye_color, painting, block state) and spawn_entity', () => {
    roundTrip(P, true, 'entity_metadata', {
      entityId: 77,
      metadata: [
        { key: 0, type: 'byte', value: 0 },
        { key: 8, type: 'item_stack', value: item('white_cushion') },
        { key: 9, type: 'dye_color', value: 14 },
        { key: 10, type: 'block_state', value: d3.blocksByName.poplar_log.defaultState },
        { key: 11, type: 'painting_variant', value: { variantData: { width: 2, height: 1, assetId: 'minecraft:kebab', title: undefined, author: undefined } } }
      ]
    })
    roundTrip(P, true, 'spawn_entity', { entityId: 77, objectUUID: '00000000-0000-0000-0000-000000000001', type: d3.entitiesByName.cushion.id, x: 1, y: 2, z: 3, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, headPitch: 0, objectData: 0 })
  })

  await check('round trip: map_chunk header with 26.3 BitSet light masks; update_light', () => {
    const mask = [[0, 0b1010]] // sections 1 and 3
    roundTrip(P, true, 'map_chunk', { x: 3, z: -4, heightmaps: [{ type: 'motion_blocking', data: [[0, 1]] }], chunkData: Buffer.alloc(0), blockEntities: [], skyLightMask: mask, blockLightMask: [], emptySkyLightMask: [[0, 1]], emptyBlockLightMask: [], skyLight: [[...Buffer.alloc(2048, 0xff)], [...Buffer.alloc(2048, 0xff)]], blockLight: [] })
    const buf = encode(P, true, 'update_light', { chunkX: 1, chunkZ: 2, skyLightMask: mask, blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [] })
    // wire: varint id, varint x, varint z, then the mask as a BitSet: 1 byte long, 0b1010
    assert.deepStrictEqual([...buf.slice(0, 6)], [0x31, 1, 2, 1, 0b1010, 0], 'BitSet bytes')
    const back = decode(P, true, buf).params
    assert.strictEqual(BigInt(back.skyLightMask[0]), 10n)
  })

  await check('entity movement: ViaVersion-shaped bytes decode to 26.2 fields; round trips', () => {
    // ViaVersion Protocol26_2To26_3 writes MOVE_ENTITY_POS as: id, varint (onGround | 1 step << 1), varint 3, xa, ya, za
    const one = Buffer.concat([varint(0x36), varint(5), varint(1 | 2), varint(3), i16(100), i16(-20), i16(7)])
    const p = decode(P, true, one).params
    assert.deepStrictEqual([p.entityId, p.onGround, p.dX, p.dY, p.dZ], [5, true, 100, -20, 7])
    // two steps sum up (ViaBackwards handleMovePos)
    const two = Buffer.concat([varint(0x36), varint(5), varint(0 | 4), varint(1), i16(10), i16(1), i16(0), varint(2), i16(5), i16(-1), i16(3)])
    const q = decode(P, true, two).params
    assert.deepStrictEqual([q.onGround, q.dX, q.dY, q.dZ, q.steps.length], [false, 15, 0, 3, 2])
    roundTrip(P, true, 'rel_entity_move', { entityId: 9, onGround: true, dX: 1, dY: 2, dZ: 3 })
    roundTrip(P, true, 'entity_move_look', { entityId: 9, onGround: false, steps: [{ delay: 3, dX: 4, dY: 5, dZ: 6 }], dX: 4, dY: 5, dZ: 6, yaw: 10, pitch: -5 })
    const look = roundTrip(P, true, 'entity_look', { entityId: 9, onGround: true, yaw: 1, pitch: 2 })
    assert.deepStrictEqual([...look], [0x39, 9, 1, 1, 2], 'on ground before rotation')
    // ENTITY_POSITION_SYNC as ViaVersion writes it: id, 1 (stepped), 1 step, x y z, 3 ticks, yaw, pitch, on ground
    const sync = Buffer.concat([varint(0x23), varint(5), varint(1), varint(1), f64(1.5), f64(70), f64(-2), varint(3), f32(45), f32(10), Buffer.from([1])])
    const s = decode(P, true, sync).params
    assert.deepStrictEqual([s.x, s.y, s.z, s.dx, s.yaw, s.pitch, s.onGround], [1.5, 70, -2, 0, 45, 10, true])
    roundTrip(P, true, 'sync_entity_position', { entityId: 5, pathType: 0, x: 1, y: 2, z: 3, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, onGround: false })
  })

  await check('round trip: chat (system_chat, player_chat with filter BitSet), world_particles, swing_animation, animation', () => {
    roundTrip(P, true, 'system_chat', { content: nbtText('hello'), isActionBar: false })
    roundTrip(P, true, 'player_chat', { globalIndex: 1, senderUuid: '00000000-0000-0000-0000-000000000002', index: 0, signature: undefined, plainMessage: 'hi', timestamp: [0, 5], salt: [0, 6], previousMessages: [], unsignedChatContent: undefined, filterType: 2, filterTypeMask: [[0, 3]], type: { chatType: 1 }, networkName: nbtText('Steve'), networkTargetName: undefined })
    roundTrip(P, true, 'world_particles', { particle: { type: 'orange_poplar_leaves', data: undefined }, longDistance: false, alwaysShow: false, x: 1, y: 2, z: 3, offsetX: 0, offsetY: 0, offsetZ: 0, velocityOffset: 0.5, velocityOffsetY: 0.25, velocityOffsetZ: 0.125, amount: 4, randomization: 0 })
    roundTrip(P, true, 'world_particles', { particle: { type: 'block', data: d3.blocksByName.stone.defaultState }, longDistance: true, alwaysShow: false, x: 1, y: 2, z: 3, offsetX: 0, offsetY: 0, offsetZ: 0, velocityOffset: 0, velocityOffsetY: 0, velocityOffsetZ: 0, amount: 1, randomization: 1 })
    roundTrip(P, true, 'swing_animation', { entityId: 3, hand: 0, swing: { type: 'whack', duration: 6 } })
    roundTrip(P, true, 'animation', { entityId: 3, animation: 1 })
  })

  await check('round trip: login / respawn spawn info (varint game modes), advancements', () => {
    const worldState = { dimension: 0, name: 'minecraft:overworld', hashedSeed: [0, 1], gamemode: 'survival', previousGamemode: 0, isDebug: false, isFlat: false, death: undefined, portalCooldown: 0, seaLevel: 63 }
    roundTrip(P, true, 'login', { entityId: 1, isHardcore: false, worldNames: ['minecraft:overworld'], maxPlayers: 20, viewDistance: 10, simulationDistance: 10, reducedDebugInfo: false, enableRespawnScreen: true, doLimitedCrafting: false, worldState, onlineMode: true, enforcesSecureChat: false })
    roundTrip(P, true, 'respawn', { worldState: Object.assign({}, worldState, { gamemode: 'creative', previousGamemode: 1 }), copyMetadata: 3 })
    roundTrip(P, true, 'advancements', {
      reset: true,
      advancementMapping: [{ key: 'minecraft:story/root', value: { parentId: undefined, displayData: { title: nbtText('Minecraft'), description: nbtText('x'), icon: { itemId: d3.itemsByName.grass_block.id, itemCount: 1, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] }, frameType: 0, flags: { unused: 0, hidden: 0, show_toast: 0, has_background_texture: 1 }, backgroundTexture: 'minecraft:gui/advancements/backgrounds/stone' }, requirements: [['crafting_table']], sendsTelemtryData: false, xCord: 0, yCord: 1.5 } }],
      identifiers: [],
      progressMapping: [],
      showAdvancements: true
    })
  })

  await check('declare_commands with a 26.3-only parser; recipe_book_add with a tag slot display (IDSet)', () => {
    const parsers = d3.protocol.types.command_node
    assert(JSON.stringify(parsers).includes('minecraft:swing_animation'))
    roundTrip(P, true, 'declare_commands', {
      nodes: [
        { flags: { unused: 0, allows_restricted: 0, has_custom_suggestions: 0, has_redirect_node: 0, has_command: 0, command_node_type: 0 }, children: [1], redirectNode: undefined, extraNodeData: undefined },
        { flags: { unused: 0, allows_restricted: 0, has_custom_suggestions: 0, has_redirect_node: 0, has_command: 1, command_node_type: 2 }, children: [], redirectNode: undefined, extraNodeData: { name: 'anim', parser: 'minecraft:swing_animation', properties: undefined, suggestionType: undefined } }
      ],
      rootIndex: 0
    })
    const tagDisplay = { type: 'tag', data: { ids: [d3.itemsByName.oak_planks.id, d3.itemsByName.poplar_planks.id] } }
    const bytes = encode(P, true, 'craft_recipe_response', { windowId: 1, recipeDisplay: { type: 'crafting_shapeless', data: { ingredients: [tagDisplay], result: { type: 'item', data: d3.itemsByName.stick.id }, craftingStation: { type: 'item', data: d3.itemsByName.crafting_table.id } } } })
    const back = decode(P, true, bytes).params
    assert.deepStrictEqual(back.recipeDisplay.data.ingredients[0].data.ids, tagDisplay.data.ids)
  })

  await check('configuration state: registry_data and post_effects (restBuffer) parse', () => {
    roundTrip(states.CONFIGURATION, true, 'registry_data', { id: 'minecraft:block_transformer', entries: [{ key: 'minecraft:strip', value: undefined }] })
    roundTrip(states.CONFIGURATION, true, 'post_effects', { data: Buffer.from([1, 2, 3]) })
    roundTrip(states.CONFIGURATION, false, 'settings', { locale: 'en_us', viewDistance: 10, chatFlags: 0, chatColors: true, skinParts: 127, mainHand: 1, enableTextFiltering: false, enableServerListing: true, particleStatus: 'all' })
  })

  // ---------------- libraries ----------------
  await check('mineflayer accepts 26.3 (version gate + compat on a fake client, no connection)', async () => {
    const mineflayer = req('mineflayer')
    assert(mineflayer.testedVersions.includes('26.3'), 'testedVersions')
    assert.strictEqual(mineflayer.latestSupportedVersion, '26.3')
    const client = new (req('minecraft-protocol').Client)(false, '26.3') // a real client object with no socket
    const written = []
    client.write = (name, params) => written.push([name, params])
    client.end = () => {}
    client.registerChannel = () => {}
    client.unregisterChannel = () => {}
    const bot = mineflayer.createBot({ client, version: '26.3', hideErrors: true, logErrors: false })
    await new Promise(resolve => setTimeout(resolve, 50)) // inject_allowed -> plugins
    assert.strictEqual(bot.protocolVersion, 777)
    assert(client.__mc263compat, 'compat installed')
    bot._client.write('block_dig', { status: 1, location: { x: 0, y: 0, z: 0 }, face: 1, sequence: 0 })
    bot._client.write('block_dig', { status: 0, location: { x: 0, y: 0, z: 0 }, face: 1, sequence: 0 })
    bot._client.write('arm_animation', { hand: 0 })
    bot._client.write('arm_animation', { hand: 1 })
    assert.deepStrictEqual(written.map(w => [w[0], w[1].status]), [['block_dig', 2], ['block_dig', 0], ['punch', undefined]])
    const events = []
    bot.on('entitySwingArm', e => events.push('swing:' + e.id))
    bot.on('entityWake', e => events.push('wake:' + e.id))
    bot.on('entityCriticalEffect', e => events.push('crit:' + e.id))
    client.emit('swing_animation', { entityId: 4, hand: 0, swing: { type: 'whack', duration: 6 } })
    client.emit('swing_animation', { entityId: 4, hand: 0, swing: { type: 'none', duration: 6 } })
    client.emit('animation', { entityId: 4, animation: 0 })
    client.emit('animation', { entityId: 4, animation: 1 })
    assert.deepStrictEqual(events, ['swing:4', 'wake:4', 'crit:4'])
    const physicsSrc = fs.readFileSync(req.resolve('mineflayer/lib/plugins/physics.js'), 'utf8')
    assert(physicsSrc.includes("teleportId: packet.teleportId, x: pos.x"), 'teleport_confirm carries the position')
    bot.removeAllListeners()
    return `${written.length} writes translated`
  })

  await check('prismarine libraries construct for 26.3', () => {
    const registry = req('prismarine-registry')('26.3')
    assert.strictEqual(registry.version.version, 777)
    const Chunk = req('prismarine-chunk')(registry)
    const { Vec3 } = req('vec3')
    const c = new Chunk({ minY: -64, worldHeight: 384 })
    const hi = registry.blocksArray.find(b => b.minStateId > 32767).minStateId // > 32767: needs the 16-bit global palette
    assert(hi > 32767)
    const ids = [registry.blocksByName.chest.defaultState, registry.blocksByName.poplar_log.defaultState, hi]
    for (let i = 0; i < 300; i++) c.setBlockStateId(new Vec3(i % 16, (i >> 4) % 16, (i >> 8) % 16), i < 3 ? ids[i] : 1 + (i * 97) % (registry.blocksArray.length * 20))
    const c2 = new Chunk({ minY: -64, worldHeight: 384 })
    c2.load(c.dump())
    for (let i = 0; i < 300; i++) { const p = new Vec3(i % 16, (i >> 4) % 16, (i >> 8) % 16); assert.strictEqual(c2.getBlockStateId(p), c.getBlockStateId(p), 'chunk round trip ' + i) }
    assert.strictEqual(c2.getBlock(new Vec3(2, 0, 0)).stateId, hi)
    const Block = req('prismarine-block')(registry)
    assert.strictEqual(Block.fromStateId(registry.blocksByName.oak_stairs.defaultState, 0).getProperties().facing, 'north')
    const Item = req('prismarine-item')(registry)
    const it = new Item(registry.itemsByName.diamond_pickaxe.id, 1)
    assert.strictEqual(it.name, 'diamond_pickaxe')
    const { Physics, PlayerState } = req('prismarine-physics')
    assert(Physics(registry, { getBlock: () => null }) && PlayerState)
    const windows = req('prismarine-windows')(registry)
    assert(windows.createWindow(1, 'minecraft:generic_9x3', 'Chest'))
    assert(req('prismarine-recipe')(registry).Recipe)
    req('prismarine-entity')
    return `global palette bits ${c.maxBitsPerBlock ?? '?'}`
  })

  await check('26.2 untouched: loads, same protocol.json bytes, serializers build', () => {
    const d2 = mcData('26.2')
    assert(d2 && d2.version.version === 776)
    const p = path.join(BOT2, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '26.2', 'protocol.json')
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), PROTOCOL_262_SHA)
    for (const state of [states.LOGIN, states.CONFIGURATION, states.PLAY]) for (const isServer of [false, true]) { createSerializer({ state, isServer, version: '26.2' }); createDeserializer({ state, isServer, version: '26.2' }) }
    const ser = createSerializer({ state: P, isServer: false, version: '26.2' })
    const b = ser.createPacketBuffer({ name: 'teleport_confirm', params: { teleportId: 5, x: 1, y: 2, z: 3, yaw: 0, pitch: 0 } })
    assert.deepStrictEqual([...b], [0x00, 5], '26.2 teleport_confirm ignores the 26.3 fields')
    assert.strictEqual(req('prismarine-registry')('26.2').blocksByName.chest.minStateId, d2.blocksByName.chest.minStateId)
  })

  for (const r of results) console.log(r)
  console.log(failures ? `\n${failures} check(s) FAILED` : `\nall ${results.length} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
