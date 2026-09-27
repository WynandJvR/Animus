process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || require('path').join(__dirname, 'test-events.log') // (never the live log)
// the coordinate rule: while a non-operator is on, no line that names where the base is (by value, any format)
const LIB = 'C:/mc-bot-lab/bot2/lib/'
const mem = require(LIB + 'memory.js'); const M = { home: { x: -1234, y: 119, z: -5678 }, bed: { x: -1234, y: 119, z: -5677 } }
mem.get = () => M; mem.set = (k, v) => { M[k] = v }; mem.update = f => f(M)
const { Vec3 } = require('vec3')
const said = []
const bot = { username: '_D1gital_', players: { _D1gital_: {}, '.Digital3093': {}, Stranger: {} }, entity: { position: new Vec3(-1238, 119, -5685) }, chat: m => said.push(m), on () {} }
const director = { info: () => null, isPaused: () => false, TASKS: {} }
const { make } = require(LIB + 'commands.js')
const cmds = make(bot, director)
let ok = true
const t = async (msg, want) => { const out = await cmds.handle('say ' + msg, { source: 'brain' }); const blocked = /where the base is/.test(out); if (blocked !== want) ok = false; console.log(`${blocked === want ? 'PASS' : 'FAIL'} ${want ? 'blocks' : 'allows'} "${msg}" -> ${out}`); await new Promise(r => setTimeout(r, 2600)) }
;(async () => {
  for (const m of ['stuff is at -1,234 -5678', 'base is at -1234, -5678', 'x -1234 z -5678', '-1234/119/-5678', '-1234 ~ -5678', 'about 1234 west 5678 north', '-1234 119 -5678']) await t(m, true)
  for (const m of ['i have 12 stone and 3 logs', '63 of 13888 placed', 'need 400 logs']) await t(m, false)
  bot.players = { _D1gital_: {}, '.Digital3093': {} }
  await t('base is at -1234, -5678', false)
  console.log(ok ? 'ALL PASS' : 'SOME FAILED'); process.exit(0)
})()
