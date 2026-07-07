'use strict'
// Supervisor: keeps index.js (the bot + control API + dashboard) running, and
// restarts it when it exits - which is how the dashboard's "Save & reconnect"
// applies new server/account settings (index.js writes config.json, exits, and
// we bring it right back up with the new config). Rapid crashes back off so a
// bad config doesn't spin the CPU. Ctrl+C stops for good.
const { spawn } = require('child_process')
const path = require('path')

let stopping = false
let quickCrashes = 0
let lastStart = 0

function start () {
  lastStart = Date.now()
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    stdio: 'inherit', // pass through console - incl. the microsoft.com/link device code
    env: process.env
  })
  child.on('exit', (code, signal) => {
    if (stopping) return
    const ranMs = Date.now() - lastStart
    if (ranMs < 4000) quickCrashes++; else quickCrashes = 0
    // exit(0) = intentional restart (reconnect) -> come back fast; crashes back off
    const delay = code === 0 && quickCrashes === 0 ? 500 : Math.min(2000 * Math.max(1, quickCrashes), 15000)
    console.log(`[run] bot exited (code ${code}${signal ? ', ' + signal : ''}); restarting in ${delay}ms...`)
    setTimeout(start, delay)
  })
  const stop = () => { stopping = true; try { child.kill() } catch {}; process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

console.log('[run] supervising the bot (Ctrl+C to stop). The dashboard\'s "Save & reconnect" restarts through here.')
start()
