process.env.BOT2_LOG_FILE = process.env.BOT2_LOG_FILE || require('path').join(__dirname, 'test-events.log') // (never the live log)
// the coordinate rule: while a non-operator is on, no line that names where the base is (by value, any format)
const path = require('path'); const bot2 = path.join(__dirname, '..', '..', 'bot2'); const LIB = path.join(bot2, 'lib') + path.sep
// (the operator: whoever bot2/config.json lists - commands.js reads the same file; no account name is written here)
const OP = ((() => { try { return require(path.join(bot2, 'config.json')).operators } catch { return null } })() || [])[0]
if (!OP) { console.log('SKIP no operator in bot2/config.json (the rule under test reads its operators there)'); process.exit(0) }
const mem = require(LIB + 'memory.js'); const M = { home: { x: -1234, y: 119, z: -5678 }, bed: { x: -1234, y: 119, z: -5677 } }
mem.get = () => M; mem.set = (k, v) => { M[k] = v }; mem.update = f => f(M)
const { Vec3 } = require(require.resolve('vec3', { paths: [bot2] }))
const said = []
const bot = { username: '_St3ve_', players: { _St3ve_: {}, [OP]: {}, Stranger: {} }, entity: { position: new Vec3(-1238, 119, -5685) }, chat: m => said.push(m), on () {} }
const director = { info: () => null, isPaused: () => false, TASKS: {} }
const { make } = require(LIB + 'commands.js')
const cmds = make(bot, director)
let ok = true
const t = async (msg, want) => { const out = await cmds.handle('say ' + msg, { source: 'brain' }); const blocked = /where the base is/.test(out); if (blocked !== want) ok = false; console.log(`${blocked === want ? 'PASS' : 'FAIL'} ${want ? 'blocks' : 'allows'} "${msg}" -> ${out}`); await new Promise(r => setTimeout(r, 2600)) }
;(async () => {
  for (const m of ['stuff is at -1,234 -5678', 'base is at -1234, -5678', 'x -1234 z -5678', '-1234/119/-5678', '-1234 ~ -5678', 'about 1234 west 5678 north', '-1234 119 -5678']) await t(m, true)
  for (const m of ['i have 12 stone and 3 logs', '63 of 13888 placed', 'need 400 logs']) await t(m, false)
  bot.players = { _St3ve_: {}, [OP]: {} }
  await t('base is at -1234, -5678', false)
  console.log(ok ? 'ALL PASS' : 'SOME FAILED'); process.exit(0)
})()
