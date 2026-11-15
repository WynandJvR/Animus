'use strict'
// Minecraft 26.3 semantics mineflayer 4.39 does not know. Copied by patch-mc262.js into mineflayer/lib/mc263compat.js and
// installed from loader.js (createBot -> next) when the server is 26.3 or newer, before any plugin listens on the client.
// The wire formats live in the protocol data; this file only maps meanings that changed between 26.2 and 26.3
// (source: ViaVersion Protocol26_2To26_3 / ViaBackwards Protocol26_3To26_2, EntityPacketRewriter26_3):
//  - player_action (block_dig): 26.3 inserted action 1 "change destroy direction"; every 26.2 status >= 1 moves up one
//  - swing (arm_animation) is gone: 26.3 has an empty "punch" (main hand only; an off-hand swing has no 26.3 form)
//  - animate (animation): arm swings moved to their own swing_animation packet; the rest renumbered 0 wake, 1 crit, 2 magic crit
module.exports = function install (bot) {
  const client = bot._client
  if (!client || client.__mc263compat) return
  client.__mc263compat = true

  const write = client.write.bind(client)
  client.write = function (name, params) {
    if (name === 'block_dig' && params && params.status >= 1) params = Object.assign({}, params, { status: params.status + 1 })
    else if (name === 'arm_animation') {
      if (params && params.hand === 1) return // off hand: no 26.3 packet
      name = 'punch'; params = {}
    }
    return write(name, params)
  }

  const ANIMATE = { 0: 2, 1: 4, 2: 5 } // 26.3 animate id -> 26.2 id (mineflayer's animationEvents table)
  const emit = client.emit.bind(client)
  client.emit = function (name, data, ...rest) {
    if (name === 'animation' && data && ANIMATE[data.animation] !== undefined && !data.__mc263) {
      data.animation = ANIMATE[data.animation]; data.__mc263 = true
    } else if (name === 'swing_animation' && data) {
      const r = emit(name, data, ...rest)
      if (data.swing && data.swing.type === 'none') return r // no visible swing (ViaBackwards drops it too)
      return emit('animation', { entityId: data.entityId, animation: data.hand === 1 ? 3 : 0, __mc263: true }, ...rest)
    }
    return emit(name, data, ...rest)
  }
}
