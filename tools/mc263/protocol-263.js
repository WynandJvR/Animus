'use strict'
// Hand-written Minecraft 26.2 (776) -> 26.3 (777) protocol edits, applied to a deep copy of the installed 26.2 protocol.json.
// Every edit asserts the 26.2 shape it replaces, so a different 26.2 base fails loudly instead of producing garbage.
// Sources (read the 26.3 format from both directions):
//   ViaVersion  common/.../protocols/v26_2to26_3/**            (26.2 server -> 26.3 client; "mapped" = 26.3)
//   ViaBackwards common/.../protocol/v26_3to26_2/**             (26.3 server -> 26.2 client; reads the 26.3 format)
//   ViaVersion  api/.../data/StructuredDataKey.java, item/data/** (component types), EntityDataTypes26_3, packet enums.
const assert = require('assert')

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function expect (actual, expected, what) {
  assert(eq(actual, expected), `[mc263] 26.2 base differs at ${what}:\n  have ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`)
}
const field = (container, name) => {
  const f = container[1].find(x => x.name === name)
  assert(f, '[mc263] missing field ' + name)
  return f
}
const hex = i => '0x' + i.toString(16).padStart(2, '0')
const mapperOf = list => Object.fromEntries(list.map((n, i) => [String(i), n]))

// Packet enums, in id order (ViaVersion ClientboundPackets26_3 / ServerboundPackets26_3 / ClientboundConfigurationPackets26_3).
// 26.2 used ViaVersion's 26_1 enums unchanged, and the installed 26.2 protocol.json lists the same packets in the same order,
// so each 26_1 enum name maps to the minecraft-data name at the same 26.2 id.
const CB_26_1 = 'BUNDLE_DELIMITER ADD_ENTITY ANIMATE AWARD_STATS BLOCK_CHANGED_ACK BLOCK_DESTRUCTION BLOCK_ENTITY_DATA BLOCK_EVENT BLOCK_UPDATE BOSS_EVENT CHANGE_DIFFICULTY CHUNK_BATCH_FINISHED CHUNK_BATCH_START CHUNKS_BIOMES CLEAR_TITLES COMMAND_SUGGESTIONS COMMANDS CONTAINER_CLOSE CONTAINER_SET_CONTENT CONTAINER_SET_DATA CONTAINER_SET_SLOT COOKIE_REQUEST COOLDOWN CUSTOM_CHAT_COMPLETIONS CUSTOM_PAYLOAD DAMAGE_EVENT DEBUG_BLOCK_VALUE DEBUG_CHUNK_VALUE DEBUG_ENTITY_VALUE DEBUG_EVENT DEBUG_SAMPLE DELETE_CHAT DISCONNECT DISGUISED_CHAT ENTITY_EVENT ENTITY_POSITION_SYNC EXPLODE FORGET_LEVEL_CHUNK GAME_EVENT GAME_RULE_VALUES GAME_TEST_HIGHLIGHT_POS MOUNT_SCREEN_OPEN HURT_ANIMATION INITIALIZE_BORDER KEEP_ALIVE LEVEL_CHUNK_WITH_LIGHT LEVEL_EVENT LEVEL_PARTICLES LIGHT_UPDATE LOGIN LOW_DISK_SPACE_WARNING MAP_ITEM_DATA MERCHANT_OFFERS MOVE_ENTITY_POS MOVE_ENTITY_POS_ROT MOVE_MINECART_ALONG_TRACK MOVE_ENTITY_ROT MOVE_VEHICLE OPEN_BOOK OPEN_SCREEN OPEN_SIGN_EDITOR PING PONG_RESPONSE PLACE_GHOST_RECIPE PLAYER_ABILITIES PLAYER_CHAT PLAYER_COMBAT_END PLAYER_COMBAT_ENTER PLAYER_COMBAT_KILL PLAYER_INFO_REMOVE PLAYER_INFO_UPDATE PLAYER_LOOK_AT PLAYER_POSITION PLAYER_ROTATION RECIPE_BOOK_ADD RECIPE_BOOK_REMOVE RECIPE_BOOK_SETTINGS REMOVE_ENTITIES REMOVE_MOB_EFFECT RESET_SCORE RESOURCE_PACK_POP RESOURCE_PACK_PUSH RESPAWN ROTATE_HEAD SECTION_BLOCKS_UPDATE SELECT_ADVANCEMENTS_TAB SERVER_DATA SET_ACTION_BAR_TEXT SET_BORDER_CENTER SET_BORDER_LERP_SIZE SET_BORDER_SIZE SET_BORDER_WARNING_DELAY SET_BORDER_WARNING_DISTANCE SET_CAMERA SET_CHUNK_CACHE_CENTER SET_CHUNK_CACHE_RADIUS SET_CURSOR_ITEM SET_DEFAULT_SPAWN_POSITION SET_DISPLAY_OBJECTIVE SET_ENTITY_DATA SET_ENTITY_LINK SET_ENTITY_MOTION SET_EQUIPMENT SET_EXPERIENCE SET_HEALTH SET_HELD_SLOT SET_OBJECTIVE SET_PASSENGERS SET_PLAYER_INVENTORY SET_PLAYER_TEAM SET_SCORE SET_SIMULATION_DISTANCE SET_SUBTITLE_TEXT SET_TIME SET_TITLE_TEXT SET_TITLES_ANIMATION SOUND_ENTITY SOUND START_CONFIGURATION STOP_SOUND STORE_COOKIE SYSTEM_CHAT TAB_LIST TAG_QUERY TAKE_ITEM_ENTITY TELEPORT_ENTITY TEST_INSTANCE_BLOCK_STATUS TICKING_STATE TICKING_STEP TRANSFER UPDATE_ADVANCEMENTS UPDATE_ATTRIBUTES UPDATE_MOB_EFFECT UPDATE_RECIPES UPDATE_TAGS PROJECTILE_POWER CUSTOM_REPORT_DETAILS SERVER_LINKS TRACKED_WAYPOINT CLEAR_DIALOG SHOW_DIALOG'.split(' ')
const CB_26_3 = 'BUNDLE_DELIMITER ADD_ENTITY ANIMATE AWARD_STATS BLOCK_CHANGED_ACK BLOCK_DESTRUCTION BLOCK_ENTITY_DATA BLOCK_EVENT BLOCK_UPDATE BOSS_EVENT CHANGE_DIFFICULTY CHUNK_BATCH_FINISHED CHUNK_BATCH_START CHUNKS_BIOMES CLEAR_TITLES COMMAND_SUGGESTIONS COMMANDS CONTAINER_CLOSE CONTAINER_SET_CONTENT CONTAINER_SET_DATA CONTAINER_SET_SLOT COOKIE_REQUEST COOLDOWN CUSTOM_CHAT_COMPLETIONS CUSTOM_PAYLOAD DAMAGE_EVENT DEBUG_BLOCK_VALUE DEBUG_CHUNK_VALUE DEBUG_ENTITY_VALUE DEBUG_EVENT DEBUG_SAMPLE DELETE_CHAT DISCONNECT DISGUISED_CHAT ENTITY_EVENT ENTITY_POSITION_SYNC EXPLODE ADD_TRANSIENT_BLOCK FORGET_LEVEL_CHUNK GAME_EVENT GAME_RULE_VALUES GAME_TEST_HIGHLIGHT_POS MOUNT_SCREEN_OPEN HURT_ANIMATION INITIALIZE_BORDER KEEP_ALIVE LEVEL_CHUNK_WITH_LIGHT LEVEL_EVENT LEVEL_PARTICLES LIGHT_UPDATE LOGIN LOW_DISK_SPACE_WARNING MAP_ITEM_DATA MERCHANT_OFFERS MOVE_ENTITY_POS MOVE_ENTITY_POS_ROT MOVE_MINECART_ALONG_TRACK MOVE_ENTITY_ROT MOVE_VEHICLE OPEN_BOOK OPEN_SCREEN OPEN_SIGN_EDITOR PING PONG_RESPONSE PLACE_GHOST_RECIPE PLAYER_ABILITIES PLAYER_CHAT PLAYER_COMBAT_END PLAYER_COMBAT_ENTER PLAYER_COMBAT_KILL PLAYER_INFO_REMOVE PLAYER_INFO_UPDATE PLAYER_LOOK_AT PLAYER_POSITION PLAYER_ROTATION RECIPE_BOOK_ADD RECIPE_BOOK_REMOVE RECIPE_BOOK_SETTINGS REMOVE_ENTITIES REMOVE_MOB_EFFECT RESET_SCORE RESOURCE_PACK_POP RESOURCE_PACK_PUSH POST_EFFECTS RESPAWN ROTATE_HEAD SECTION_BLOCKS_UPDATE SELECT_ADVANCEMENTS_TAB SERVER_DATA SET_ACTION_BAR_TEXT SET_BORDER_CENTER SET_BORDER_LERP_SIZE SET_BORDER_SIZE SET_BORDER_WARNING_DELAY SET_BORDER_WARNING_DISTANCE SET_CAMERA SET_CHUNK_CACHE_CENTER SET_CHUNK_CACHE_RADIUS SET_CURSOR_ITEM SET_DEFAULT_SPAWN_POSITION SET_DISPLAY_OBJECTIVE SET_ENTITY_DATA SET_ENTITY_LINK SET_ENTITY_MOTION SET_EQUIPMENT SET_EXPERIENCE SET_HEALTH SET_HELD_SLOT SET_OBJECTIVE SET_PASSENGERS SET_PLAYER_INVENTORY SET_PLAYER_TEAM SET_SCORE SET_SIMULATION_DISTANCE SET_SUBTITLE_TEXT SET_TIME SET_TITLE_TEXT SET_TITLES_ANIMATION SOUND_ENTITY SOUND START_CONFIGURATION STOP_SOUND STORE_COOKIE SWING_ANIMATION SYSTEM_CHAT TAB_LIST TAG_QUERY TAKE_ITEM_ENTITY TELEPORT_ENTITY TEST_INSTANCE_BLOCK_STATUS TICKING_STATE TICKING_STEP TRANSFER UPDATE_ADVANCEMENTS UPDATE_ATTRIBUTES UPDATE_MOB_EFFECT UPDATE_RECIPES UPDATE_TAGS PROJECTILE_POWER CUSTOM_REPORT_DETAILS SERVER_LINKS TRACKED_WAYPOINT CLEAR_DIALOG SHOW_DIALOG'.split(' ')
const SB_26_1 = 'ACCEPT_TELEPORTATION ATTACK BLOCK_ENTITY_TAG_QUERY BUNDLE_ITEM_SELECTED CHANGE_DIFFICULTY CHANGE_GAME_MODE CHAT_ACK CHAT_COMMAND CHAT_COMMAND_SIGNED CHAT CHAT_SESSION_UPDATE CHUNK_BATCH_RECEIVED CLIENT_COMMAND CLIENT_TICK_END CLIENT_INFORMATION COMMAND_SUGGESTION CONFIGURATION_ACKNOWLEDGED CONTAINER_BUTTON_CLICK CONTAINER_CLICK CONTAINER_CLOSE CONTAINER_SLOT_STATE_CHANGED COOKIE_RESPONSE CUSTOM_PAYLOAD DEBUG_SUBSCRIPTION_REQUEST EDIT_BOOK ENTITY_TAG_QUERY INTERACT JIGSAW_GENERATE KEEP_ALIVE LOCK_DIFFICULTY MOVE_PLAYER_POS MOVE_PLAYER_POS_ROT MOVE_PLAYER_ROT MOVE_PLAYER_STATUS_ONLY MOVE_VEHICLE PADDLE_BOAT PICK_ITEM_FROM_BLOCK PICK_ITEM_FROM_ENTITY PING_REQUEST PLACE_RECIPE PLAYER_ABILITIES PLAYER_ACTION PLAYER_COMMAND PLAYER_INPUT PLAYER_LOADED PONG RECIPE_BOOK_CHANGE_SETTINGS RECIPE_BOOK_SEEN_RECIPE RENAME_ITEM RESOURCE_PACK SEEN_ADVANCEMENTS SELECT_TRADE SET_BEACON SET_CARRIED_ITEM SET_COMMAND_BLOCK SET_COMMAND_MINECART SET_CREATIVE_MODE_SLOT SET_GAME_RULE SET_JIGSAW_BLOCK SET_STRUCTURE_BLOCK SET_TEST_BLOCK SIGN_UPDATE SPECTATE_ENTITY SWING TELEPORT_TO_ENTITY TEST_INSTANCE_BLOCK_ACTION USE_ITEM_ON USE_ITEM CUSTOM_CLICK_ACTION'.split(' ')
const SB_26_3 = 'ACCEPT_TELEPORTATION ATTACK BLOCK_ENTITY_TAG_QUERY BUNDLE_ITEM_SELECTED CHANGE_DIFFICULTY CHANGE_GAME_MODE CHAT_ACK CHAT_COMMAND CHAT_COMMAND_SIGNED CHAT CHAT_SESSION_UPDATE CHUNK_BATCH_RECEIVED CLIENT_COMMAND CLIENT_TICK_END CLIENT_INFORMATION COMMAND_SUGGESTION CONFIGURATION_ACKNOWLEDGED CONTAINER_BUTTON_CLICK CONTAINER_CLICK CONTAINER_CLOSE CONTAINER_SLOT_STATE_CHANGED COOKIE_RESPONSE CUSTOM_PAYLOAD DEBUG_SUBSCRIPTION_REQUEST EDIT_BOOK ENTITY_TAG_QUERY INTERACT JIGSAW_GENERATE KEEP_ALIVE LOCK_DIFFICULTY MOVE_PLAYER_POS MOVE_PLAYER_POS_ROT MOVE_PLAYER_ROT MOVE_PLAYER_STATUS_ONLY MOVE_VEHICLE PADDLE_BOAT PICK_ITEM_FROM_BLOCK PICK_ITEM_FROM_ENTITY PING_REQUEST PLACE_RECIPE PLAYER_ABILITIES PLAYER_ACTION PLAYER_COMMAND PLAYER_INPUT PLAYER_LOADED PONG PUNCH RECIPE_BOOK_CHANGE_SETTINGS RECIPE_BOOK_SEEN_RECIPE RENAME_ITEM RESOURCE_PACK SEEN_ADVANCEMENTS SELECT_TRADE SET_BEACON SET_CARRIED_ITEM SET_COMMAND_BLOCK SET_COMMAND_MINECART SET_CREATIVE_MODE_SLOT SET_GAME_RULE SET_JIGSAW_BLOCK SET_STRUCTURE_BLOCK SET_TEST_BLOCK SIGN_UPDATE SPECTATOR_ACTION TELEPORT_TO_ENTITY TEST_INSTANCE_BLOCK_ACTION USE_ITEM_ON USE_ITEM CUSTOM_CLICK_ACTION'.split(' ')
// new 26.3 packets -> minecraft-data names; SPECTATOR_ACTION is ViaVersion's straight rename of SPECTATE_ENTITY
const NEW_NAMES = { ADD_TRANSIENT_BLOCK: 'add_transient_block', POST_EFFECTS: 'post_effects', SWING_ANIMATION: 'swing_animation', PUNCH: 'punch' }
const RENAMED = { SPECTATOR_ACTION: 'SPECTATE_ENTITY' }

function packetTable (dir, oldEnum, newEnum) {
  const pk = dir.types.packet
  const mapper = pk[1][0].type[1].mappings
  const sw = pk[1][1].type[1].fields
  const oldNames = Object.keys(mapper).sort((a, b) => parseInt(a) - parseInt(b)).map(k => mapper[k])
  assert.strictEqual(oldNames.length, oldEnum.length, '[mc263] 26.2 packet count != 26_1 enum')
  const byVia = Object.fromEntries(oldEnum.map((v, i) => [v, oldNames[i]]))
  const names = newEnum.map(v => NEW_NAMES[v] || byVia[RENAMED[v] || v])
  names.forEach((n, i) => assert(n, '[mc263] no name for ' + newEnum[i]))
  pk[1][0].type[1].mappings = Object.fromEntries(names.map((n, i) => [hex(i), n]))
  const fields = {}
  for (const n of names) fields[n] = sw[n] || 'packet_' + n
  pk[1][1].type[1].fields = fields
  for (const n of oldNames) if (!names.includes(n)) { delete dir.types[sw[n]]; delete dir.types['packet_' + n] }
  return names
}

module.exports = function apply (proto, m26) { // m26 = { p2: mapping-26.2.json, p3: mapping-26.3.json }
  const T = proto.types
  const pc = proto.play.toClient.types
  const ps = proto.play.toServer.types

  // ---------- packet id tables ----------
  packetTable(proto.play.toClient, CB_26_1, CB_26_3)
  packetTable(proto.play.toServer, SB_26_1, SB_26_3)
  { // configuration clientbound: POST_EFFECTS inserted after RESOURCE_PACK_PUSH (0x09); serverbound unchanged (1_21_9 enum)
    const pk = proto.configuration.toClient.types.packet
    const mp = pk[1][0].type[1].mappings
    const names = Object.keys(mp).sort((a, b) => parseInt(a) - parseInt(b)).map(k => mp[k])
    expect(names.slice(8, 11), ['remove_resource_pack', 'add_resource_pack', 'store_cookie'], 'configuration.toClient ids 8-10')
    assert.strictEqual(names.length, 20)
    names.splice(10, 0, 'post_effects')
    pk[1][0].type[1].mappings = Object.fromEntries(names.map((n, i) => [hex(i), n]))
    pk[1][1].type[1].fields.post_effects = 'packet_post_effects'
    proto.configuration.toClient.types.packet_post_effects = ['container', [{ name: 'data', type: 'restBuffer' }]] // structure unknown (ViaBackwards cancels it)
  }

  // ---------- play clientbound ----------
  // unknown structure: ViaBackwards just cancels these, ViaVersion never creates them. restBuffer parses any body.
  pc.packet_add_transient_block = ['container', [{ name: 'data', type: 'restBuffer' }]]
  pc.packet_post_effects = ['container', [{ name: 'data', type: 'restBuffer' }]]
  // SWING_ANIMATION: entity varint, hand varint, SwingAnimation (varint type none/whack/stab, varint duration)
  pc.packet_swing_animation = ['container', [
    { name: 'entityId', type: 'varint' },
    { name: 'hand', type: 'varint' },
    { name: 'swing', type: ['container', [{ name: 'type', type: ['mapper', { type: 'varint', mappings: { 0: 'none', 1: 'whack', 2: 'stab' } }] }, { name: 'duration', type: 'varint' }]] }
  ]]

  // MOVE_ENTITY_POS / _POS_ROT: varint props (on ground | steps << 1) + deltas or steps (native mc263MoveSteps, inlined so the
  // packet still carries dX/dY/dZ/onGround); on ground left the end of the packet
  const moveSteps = { anon: true, type: ['switch', { compareTo: 'entityId', fields: {}, default: 'mc263MoveSteps' }] }
  expect(pc.packet_rel_entity_move, ['container', [{ name: 'entityId', type: 'varint' }, { name: 'dX', type: 'i16' }, { name: 'dY', type: 'i16' }, { name: 'dZ', type: 'i16' }, { name: 'onGround', type: 'bool' }]], 'rel_entity_move')
  pc.packet_rel_entity_move = ['container', [{ name: 'entityId', type: 'varint' }, moveSteps]]
  expect(pc.packet_entity_move_look[1].map(f => f.name), ['entityId', 'dX', 'dY', 'dZ', 'yaw', 'pitch', 'onGround'], 'entity_move_look')
  pc.packet_entity_move_look = ['container', [{ name: 'entityId', type: 'varint' }, moveSteps, { name: 'yaw', type: 'i8' }, { name: 'pitch', type: 'i8' }]]
  // MOVE_ENTITY_ROT: on ground moved before the rotation
  expect(pc.packet_entity_look[1].map(f => f.name), ['entityId', 'yaw', 'pitch', 'onGround'], 'entity_look')
  pc.packet_entity_look = ['container', [{ name: 'entityId', type: 'varint' }, { name: 'onGround', type: 'bool' }, { name: 'yaw', type: 'i8' }, { name: 'pitch', type: 'i8' }]]
  // ENTITY_POSITION_SYNC: path (linear x y z, or steps of x y z + tick offset); the delta movement is gone (native computes dx/dy/dz)
  expect(pc.packet_sync_entity_position[1].map(f => f.name), ['entityId', 'x', 'y', 'z', 'dx', 'dy', 'dz', 'yaw', 'pitch', 'onGround'], 'sync_entity_position')
  pc.packet_sync_entity_position = ['container', [
    { name: 'entityId', type: 'varint' },
    { anon: true, type: ['switch', { compareTo: 'entityId', fields: {}, default: 'mc263PositionPath' }] },
    { name: 'yaw', type: 'f32' }, { name: 'pitch', type: 'f32' }, { name: 'onGround', type: 'bool' }
  ]]

  // LOGIN / RESPAWN spawn info: game mode byte -> varint, previous game mode byte (-1 none) -> optional varint (0 none, else +1)
  {
    const gm = field(pc.SpawnInfo, 'gamemode'); const pg = field(pc.SpawnInfo, 'previousGamemode')
    expect(gm.type, ['mapper', { type: 'i8', mappings: { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' } }], 'SpawnInfo.gamemode')
    expect(pg.type, 'u8', 'SpawnInfo.previousGamemode')
    gm.type = ['mapper', { type: 'varint', mappings: { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' } }]
    pg.type = 'optvarint'
  }

  // LEVEL_PARTICLES: particle first; max speed per axis; count varint; + randomization type (0 default)
  expect(pc.packet_world_particles[1].map(f => f.name + ':' + JSON.stringify(f.type)), ['longDistance:"bool"', 'alwaysShow:"bool"', 'x:"f64"', 'y:"f64"', 'z:"f64"', 'offsetX:"f32"', 'offsetY:"f32"', 'offsetZ:"f32"', 'velocityOffset:"f32"', 'amount:"i32"', 'particle:"Particle"'], 'world_particles')
  pc.packet_world_particles = ['container', [
    { name: 'particle', type: 'Particle' },
    { name: 'longDistance', type: 'bool' }, { name: 'alwaysShow', type: 'bool' },
    { name: 'x', type: 'f64' }, { name: 'y', type: 'f64' }, { name: 'z', type: 'f64' },
    { name: 'offsetX', type: 'f32' }, { name: 'offsetY', type: 'f32' }, { name: 'offsetZ', type: 'f32' },
    { name: 'velocityOffset', type: 'f32' }, { name: 'velocityOffsetY', type: 'f32' }, { name: 'velocityOffsetZ', type: 'f32' },
    { name: 'amount', type: 'varint' },
    { name: 'randomization', type: 'varint' }
  ]]

  // EXPLODE: + play sound (bool) at the end
  expect(pc.packet_explosion[1].map(f => f.name), ['center', 'radius', 'blockCount', 'playerKnockback', 'explosionParticle', 'sound', 'blockParticles'], 'explosion')
  pc.packet_explosion[1].push({ name: 'playSound', type: 'bool' })

  // OPEN_SIGN_EDITOR: front-text bool -> varint sign text slot (1 front, 0 back). The field keeps its name: true/false write 1/0.
  expect(pc.packet_open_sign_entity, ['container', [{ name: 'location', type: 'position' }, { name: 'isFrontText', type: 'bool' }]], 'open_sign_entity')
  field(pc.packet_open_sign_entity, 'isFrontText').type = 'varint'

  // LIGHT_UPDATE / LEVEL_CHUNK_WITH_LIGHT: the four masks long[] -> BitSet (varint byte count + bytes)
  for (const n of ['packet_update_light', 'packet_map_chunk']) {
    for (const m of ['skyLightMask', 'blockLightMask', 'emptySkyLightMask', 'emptyBlockLightMask']) {
      const f = field(pc[n], m)
      expect(f.type, ['array', { countType: 'varint', type: 'i64' }], n + '.' + m)
      f.type = 'mc263BitSet'
    }
  }

  // PLAYER_CHAT: partially filtered mask long[] -> BitSet
  {
    const f = field(pc.packet_player_chat, 'filterTypeMask')
    expect(f.type, ['switch', { compareTo: 'filterType', fields: { 2: ['array', { countType: 'varint', type: 'i64' }] }, default: 'void' }], 'player_chat.filterTypeMask')
    f.type[1].fields['2'] = 'mc263BitSet'
  }

  // UPDATE_ADVANCEMENTS: x/y moved out of the display data to after "sends telemetry", always present
  {
    const value = pc.packet_advancements[1][1].type[1].type[1][1].type
    const disp = field(value, 'displayData').type[1]
    expect(disp[1].slice(-2), [{ name: 'xCord', type: 'f32' }, { name: 'yCord', type: 'f32' }], 'advancements display x/y')
    disp[1].splice(-2, 2)
    expect(value[1].map(f => f.name), ['parentId', 'displayData', 'requirements', 'sendsTelemtryData'], 'advancements value')
    value[1].push({ name: 'xCord', type: 'f32' }, { name: 'yCord', type: 'f32' })
  }

  // COMMANDS: argument type registry (5 new parsers, all without properties - ViaBackwards maps them to a plain string)
  {
    const parser = JSON.stringify(T.command_node).match(/"name":"parser","type":(\["mapper",\{"type":"varint","mappings":\{[^}]*\}\}\])/)
    assert(parser, '[mc263] command_node parser mapper')
    const old = JSON.parse(parser[1])[1].mappings
    assert.strictEqual(Object.keys(old).length, m26.p2.argumenttypes.length, '[mc263] 26.2 argument type count')
    const byId = {}
    m26.p2.argumenttypes.forEach((n, i) => { byId[n] = old[i] }) // minecraft-data's own name for each 26.2 id (team_color is still minecraft:color)
    const neu = m26.p3.argumenttypes.map(n => byId[n] || (n.includes(':') ? n : 'minecraft:' + n))
    const s = JSON.stringify(T.command_node).replace(parser[1], JSON.stringify(['mapper', { type: 'varint', mappings: mapperOf(neu) }]))
    T.command_node = JSON.parse(s)
    const props = JSON.stringify(T.command_node).includes('"compareTo":"parser"')
    assert(props)
    // the new parsers carry no properties: give them an explicit void case
    const walk = o => {
      if (Array.isArray(o)) { o.forEach(walk); return }
      if (o && typeof o === 'object') {
        if (o.compareTo === 'parser' && o.fields) for (const n of neu.filter(n => !byIdHas(n))) o.fields[n] = 'void'
        Object.values(o).forEach(walk)
      }
    }
    const known = new Set(Object.values(old))
    const byIdHas = n => known.has(n)
    walk(T.command_node)
  }

  // RECIPE displays: the "tag" slot display is now a holder set of items (tag name or item id list)
  expect(pc.SlotDisplay[1][1].type[1].fields.tag, 'string', 'SlotDisplay.tag')
  pc.SlotDisplay[1][1].type[1].fields.tag = 'IDSet'

  // ---------- play serverbound ----------
  // ACCEPT_TELEPORTATION carries the position the client ends up at (the 26.3 client sends no move packet after it)
  expect(ps.packet_teleport_confirm, ['container', [{ name: 'teleportId', type: 'varint' }]], 'teleport_confirm')
  ps.packet_teleport_confirm = ['container', [{ name: 'teleportId', type: 'varint' }, { name: 'x', type: 'f64' }, { name: 'y', type: 'f64' }, { name: 'z', type: 'f64' }, { name: 'yaw', type: 'f32' }, { name: 'pitch', type: 'f32' }]]
  // PUNCH replaces SWING (arm_animation): no fields, main hand only
  ps.packet_punch = ['container', []]
  // SIGN_UPDATE: the front-text bool became a varint slot at the end (1 front, 0 back)
  expect(ps.packet_update_sign[1].map(f => f.name), ['location', 'isFrontText', 'text1', 'text2', 'text3', 'text4'], 'update_sign')
  ps.packet_update_sign = ['container', [{ name: 'location', type: 'position' }, { name: 'text1', type: 'string' }, { name: 'text2', type: 'string' }, { name: 'text3', type: 'string' }, { name: 'text4', type: 'string' }, { name: 'isFrontText', type: 'varint' }]]
  // PLAYER_ACTION (block_dig): same fields; action 1 is new ("change destroy direction"), later ones moved up by one (mineflayer-compat)

  // ---------- particles ----------
  {
    const mp = field(T.Particle, 'type').type[1]
    const old = Object.keys(mp.mappings).sort((a, b) => a - b).map(k => mp.mappings[k])
    assert.strictEqual(old.length, m26.p2.particles.length, '[mc263] particle count')
    // minecraft-data's protocol keeps its own names for two (trial_spawner_detected_player[_ominous] = registry
    // trial_spawner_detection[_ominous]); the data switch is keyed by them, so keep them by 26.2 id
    const alias = {}
    m26.p2.particles.forEach((n, i) => { alias[n] = old[i]; if (n !== old[i]) assert(/^trial_spawner_detect/.test(n), 'particle name ' + n) })
    mp.mappings = mapperOf(m26.p3.particles.map(n => alias[n] || n)) // new red/orange/yellow_poplar_leaves carry no data (ParticleType.Fillers.fill26_2)
  }

  // ---------- entity metadata: new type 43 dye_color (varint) ----------
  {
    const e = T.entityMetadataEntry
    const mp = field(e, 'type').type[1].mappings
    assert.strictEqual(mp['42'], 'humanoid_arm')
    mp['43'] = 'dye_color'
    field(e, 'value').type[1].fields.dye_color = 'varint'
  }
  // painting variant (also component painting/variant): width/height are varints (audit vs ViaVersion PaintingVariant.TYPE1_21_2)
  expect(T.EntityMetadataPaintingVariant[1].slice(0, 2), [{ name: 'width', type: 'i32' }, { name: 'height', type: 'i32' }], 'EntityMetadataPaintingVariant')
  T.EntityMetadataPaintingVariant[1][0].type = 'varint'; T.EntityMetadataPaintingVariant[1][1].type = 'varint'

  // ---------- item data components ----------
  {
    const mp = T.SlotComponentType[1].mappings
    expect(Object.keys(mp).sort((a, b) => a - b).map(k => mp[k]), m26.p2.data_component_type, 'SlotComponentType vs mapping-26.2')
    T.SlotComponentType[1].mappings = mapperOf(m26.p3.data_component_type)
    const F = T.SlotComponent[1][1].type[1].fields
    const DyeColor = 'DyeColor'
    T.ResolvableInt = ['container', [{ name: 'isValue', type: 'bool' }, { name: 'value', type: ['switch', { compareTo: 'isValue', fields: { true: 'i32', false: 'string' } }] }]]
    T.ResolvableFloat = ['container', [{ name: 'isValue', type: 'bool' }, { name: 'value', type: ['switch', { compareTo: 'isValue', fields: { true: 'f32', false: 'string' } }] }]]
    const signText = ['container', [
      { name: 'messages', type: ['array', { count: 4, type: 'anonymousNbt' }] },
      { name: 'filteredMessages', type: ['option', ['array', { count: 4, type: 'anonymousNbt' }]] },
      { name: 'color', type: DyeColor },
      { name: 'hasGlowingText', type: 'bool' }
    ]]
    const swing = F.swing_animation
    expect(swing, ['container', [{ name: 'type', type: ['mapper', { type: 'varint', mappings: { 0: 'none', 1: 'whack', 2: 'stab' } }] }, { name: 'duration', type: 'varint' }]], 'swing_animation')
    // ArmorTrimMaterial26_3: palette id + description (asset name and per-armor overrides are gone)
    T.ArmorTrimMaterial = ['container', [{ name: 'paletteId', type: 'string' }, { name: 'description', type: 'anonymousNbt' }]]
    // Instrument TYPE26_3: + durability damage (varint) before the description
    expect(T.InstrumentData[1].map(f => f.name), ['soundEvent', 'useDuration', 'range', 'description'], 'InstrumentData')
    T.InstrumentData[1].splice(3, 0, { name: 'durabilityDamage', type: 'varint' })
    // consume effect teleport_randomly: + directional particles (bool)
    {
      const sw = T.ItemConsumeEffect[1][1].type[1].fields
      expect(sw.teleport_randomly, ['container', [{ name: 'diameter', type: 'f32' }]], 'ItemConsumeEffect.teleport_randomly')
      sw.teleport_randomly = ['container', [{ name: 'diameter', type: 'f32' }, { name: 'directionalParticles', type: 'bool' }]]
    }
    // fixes found by comparing every 26.3 component with ViaVersion (all were already wrong in the 26.2 data; 26.1+ formats):
    T.ItemWrittenBookPage = ['container', [{ name: 'content', type: 'anonymousNbt' }, { name: 'filteredContent', type: ['option', 'anonymousNbt'] }]]
    field(T.ItemBlockPredicate, 'nbt').type = ['option', 'anonymousNbt']
    field(T.DataComponentMatchers, 'partialMatchers').type = ['array', { countType: 'varint', type: ['container', [{ name: 'isPredicateType', type: 'bool' }, { name: 'type', type: 'varint' }, { name: 'predicate', type: 'anonymousNbt' }]] }]
    field(F.blocks_attacks, 'bypassedBy').type = ['option', 'IDSet']

    const holder = (base, type) => ['registryEntryHolder', { baseName: base, otherwise: { name: 'data', type } }]
    const neu = {
      attack_animation: swing,
      interact_animation: swing,
      block_transformer: 'varint', // registry id (block_transformer)
      villager_food: 'varint', // nutrition
      compostable: 'ResolvableInt', // layers
      cooking_fuel: ['container', [{ name: 'burnTime', type: 'ResolvableInt' }, { name: 'speedMultiplier', type: 'ResolvableFloat' }]],
      brewing_fuel: ['container', [{ name: 'uses', type: 'ResolvableInt' }, { name: 'speedMultiplier', type: 'ResolvableFloat' }]],
      mob_visibility: ['container', [{ name: 'targetingEntityTypes', type: 'IDSet' }, { name: 'visibility', type: 'f32' }]],
      provides_pottery_pattern: 'varint', // registry id (decorated_pot_pattern)
      sign_text_front: signText,
      sign_text_back: signText,
      waxed: 'void',
      'cushion/color': DyeColor,
      trim: ['container', [{ name: 'material', type: holder('materialId', 'ArmorTrimMaterial') }, field(F.trim, 'pattern')]],
      instrument: holder('instrumentId', 'InstrumentData'),
      provides_trim_material: holder('materialId', 'ArmorTrimMaterial'),
      pot_decorations: ['container', ['back', 'left', 'right', 'front'].map(n => ({ name: n, type: ['option', 'ItemStackTemplate'] }))],
      jukebox_playable: holder('songId', 'JukeboxSongData'),
      damage_resistant: 'IDSet',
      provides_banner_patterns: 'IDSet',
      damage_type: 'varint',
      'chicken/variant': 'varint',
      'chicken/sound_variant': 'varint',
      'zombie_nautilus/variant': 'varint',
      bees: ['container', [{ name: 'bees', type: ['array', { countType: 'varint', type: ['container', [{ name: 'entityData', type: ['container', [{ name: 'type', type: 'varint' }, { name: 'nbtData', type: 'anonymousNbt' }]] }, { name: 'ticksInHive', type: 'varint' }, { name: 'minTicksInHive', type: 'varint' }]] }] }]]
    }
    const out = {}
    for (const n of m26.p3.data_component_type) {
      const t = n in neu ? neu[n] : F[n]
      assert(t !== undefined, '[mc263] no component type for ' + n)
      out[n] = t
    }
    T.SlotComponent[1][1].type[1].fields = out
  }
  return proto
}
