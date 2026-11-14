// edge guard: a cliff at x=4 (ground top y62 for x<=3; x>=4 floor top y39 -> 23-block drop; x in 6..7 water at y40)
const { Vec3 } = require('vec3')
const LIB = 'C:/mc-bot-lab/bot2/lib/'
const logs = []
require.cache[require.resolve(LIB + 'log.js')] = { id: 'l', filename: 'l', loaded: true, exports: { log: (t, m) => { logs.push(m); console.log(`   (${t}) ${m}`) }, tail: () => [] } }
require.cache[require.resolve(LIB + 'memory.js')] = { id: 'm', filename: 'm', loaded: true, exports: { get: () => ({}), update () {}, set () {} } }
let cliff = 'deep'
const name = (x, y, z) => {
  if (x <= 3) return y <= 62 ? 'dirt' : 'air'
  if (cliff === 'step') return y <= 59 ? 'dirt' : 'air' // 3-block step down: allowed
  if (cliff === 'water') return y <= 45 ? 'water' : 'air'
  return y <= 39 ? 'stone' : 'air'
}
const blockAt = p => { const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z); const n = name(x, y, z); return { name: n, position: new Vec3(x, y, z), boundingBox: /air|water/.test(n) ? 'empty' : 'block', getProperties: () => ({}) } }
const handlers = {}
const cs = { forward: false, back: false, sprint: false, jump: false, sneak: false, left: false, right: false }
const bot = { blockAt, entity: { position: new Vec3(3.3, 63, 0.5), velocity: new Vec3(0, 0, 0), yaw: -Math.PI / 2, onGround: true }, health: 20,
  on (ev, f) { (handlers[ev] = handlers[ev] || []).push(f) }, controlState: cs, setControlState (k, v) { cs[k] = v }, pathfinder: { isMoving: () => false } }
const reflex = require(LIB + 'reflex.js')
const orig = global.setInterval; global.setInterval = () => 0; reflex.install(bot); global.setInterval = orig
const tick = () => handlers.physicsTick.forEach(f => f())
let ok = true; const check = (c, w) => { console.log(`${c ? 'PASS' : 'FAIL'} ${w}`); if (!c) ok = false }
// 1. walking forward (+x) toward the ravine at x=4 from x=3.3
cs.forward = true; cs.sprint = true; tick()
check(!cs.forward && !cs.sprint && cs.sneak, 'forward toward a 23-block drop: keys cut, sneak braking')
// 2. backing away from the edge (facing +x, pressing back -> -x): no drop there, released
cs.back = true; tick()
check(cs.back && !cs.sneak, 'back away from the edge: allowed, brake released')
// 3. blind 'back' toward the edge (facing -x, back -> +x): the creeper-flee fallback
cs.back = true; bot.entity.yaw = Math.PI / 2; tick()
check(!cs.back && cs.sneak, "blind 'back' over the edge: cut")
// 4. sliding with no keys toward the edge at sprint speed
cs.back = false; cs.sneak = false; reflex.edgeAhead() && tick(); bot.entity.velocity = new Vec3(0.28, 0, 0); tick()
check(cs.sneak, 'momentum toward the edge: sneak brake')
// 5. far from the edge (x=1.5), forward: no veto
bot.entity.velocity = new Vec3(0, 0, 0); bot.entity.position = new Vec3(1.5, 63, 0.5); bot.entity.yaw = -Math.PI / 2; cs.forward = true; tick()
check(cs.forward && !cs.sneak, 'two blocks from the edge at walking speed: free')
// 6. a 3-block step down is a drop the body may take
cliff = 'step'; bot.entity.position = new Vec3(3.3, 63, 0.5); cs.forward = true; tick()
check(cs.forward, '3-block step down: allowed (SAFE_DROP)')
// 7. water below breaks the fall
cliff = 'water'; tick()
check(cs.forward, 'drop into water: allowed')
// 8. pathfinder driving toward a deep drop (an overshoot at an edge): cut too
cliff = 'deep'; bot.pathfinder.isMoving = () => true; bot.entity.position = new Vec3(4.1, 63, 0.5); bot.entity.velocity = new Vec3(0.28, 0, 0); cs.forward = true; tick()
check(!cs.forward, 'pathfinder steering over a 23-block drop: cut (it never plans one)')
// 9. pathfinder driving a planned 3-block step down: left alone
cliff = 'step'; bot.entity.position = new Vec3(3.6, 63, 0.5); cs.forward = true; cs.sneak = false; tick()
check(cs.forward, 'pathfinder steering a 3-block step down: allowed')
// 10. pathfinder stepping down onto a ledge one step before a deep drop: the far drop is not its next cell - left alone
cliff = 'deep'; bot.pathfinder.isMoving = () => true; bot.entity.position = new Vec3(2.5, 63, 0.5); bot.entity.yaw = -Math.PI / 2; cs.forward = true; cs.sneak = false; bot.entity.velocity = new Vec3(0.28, 0, 0); tick()
check(cs.forward, 'pathfinder 1.5 from the edge at sprint speed: the far probe is not used for it')
// 11. pathfinder moving diagonally past the corner of the drop: part of the hitbox stays on ground - left alone
bot.entity.position = new Vec3(3.2, 63, 0.2); bot.entity.velocity = new Vec3(0.05, 0, 0.2); cs.forward = true; cs.sneak = false; tick()
check(cs.forward, 'pathfinder brushing the corner of a drop (support left under the hitbox): not cut')
// 12. stepping onto a one-block ledge (the only way out of a pocket) at walking speed: 1 tick on, still on the ledge
bot.entity.position = new Vec3(3.5, 63, 0.5); bot.entity.velocity = new Vec3(0.2, 0, 0); cs.forward = true; cs.sneak = false; tick()
check(cs.forward, 'walking to the middle of the last block before the void: not cut')
console.log(ok ? 'ALL PASS' : 'SOME FAILED'); process.exit(ok ? 0 : 1)
