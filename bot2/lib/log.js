'use strict'
// One log: every line goes to logs/bot2-events.log and to an in-memory ring the API serves.
// Log what HAPPENED, with the numbers in the line.
const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', '..', 'logs')
// (an offline test loads these modules too: BOT2_LOG_FILE sends its lines elsewhere - a test's "NO white_flower" lines
//  landed in the live log at 20:25 on 2026-09-27 and read like the bot's own)
const LOG_FILE = process.env.BOT2_LOG_FILE || path.join(LOG_DIR, 'bot2-events.log')
const MAX_BYTES = 8 * 1024 * 1024
const ring = []

function stamp () {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const local = new Date(d.getTime() + off * 60000).toISOString().replace('Z', '')
  const sign = off >= 0 ? '+' : '-'
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')
  const mm = String(Math.abs(off) % 60).padStart(2, '0')
  return `${local}${sign}${hh}:${mm}`
}

function rotate () {
  try {
    const st = fs.statSync(LOG_FILE)
    if (st.size > MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.old')
  } catch {}
}

// (buffered: one append every 200ms, not a synchronous write a line - a loop's 10,000 lines were 10,000 blocking writes
//  on the body's event loop, 2026-09-29; audit. Flushed synchronously on exit, so a crash's last lines are kept)
// (rotation only between appends - inside the flush, never with one in flight; the batch in flight is kept until its
//  write lands, so an exit mid-write writes it again: a duplicate beats a gap in a death's last lines; audit)
let writes = 0; let rotateDue = false
let buf = []; let timer = null; let inFlight = null
function flush () {
  timer = null
  if (!buf.length || inFlight) return
  if (rotateDue) { rotateDue = false; rotate() }
  inFlight = buf.join(''); buf = []
  fs.appendFile(LOG_FILE, inFlight, () => { inFlight = null; if (buf.length && !timer) timer = setTimeout(flush, 200) })
}
function flushSync () { const all = (inFlight || '') + buf.join(''); inFlight = null; buf = []; if (!all) return; try { fs.appendFileSync(LOG_FILE, all) } catch {} }
process.on('exit', flushSync)
function log (tag, ...parts) {
  const msg = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  const line = `[${stamp()}] (${tag}) ${msg}`
  ring.push(line)
  if (ring.length > 400) ring.shift()
  try {
    if (++writes % 500 === 0) rotateDue = true
    buf.push(line + '\n')
    if (!timer) timer = setTimeout(flush, 200)
  } catch {}
  if (process.env.BOT2_STDOUT) console.log(line)
  return line
}

function tail (n = 60) { return ring.slice(-n) }

try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}

module.exports = { log, tail, LOG_FILE, flushSync }
