'use strict'
// One log: every line goes to logs/bot2-events.log and to an in-memory ring the API serves.
// Log what HAPPENED, with the numbers in the line.
const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', '..', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'bot2-events.log')
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

let writes = 0
function log (tag, ...parts) {
  const msg = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  const line = `[${stamp()}] (${tag}) ${msg}`
  ring.push(line)
  if (ring.length > 400) ring.shift()
  try {
    if (++writes % 500 === 0) rotate()
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {}
  if (process.env.BOT2_STDOUT) console.log(line)
  return line
}

function tail (n = 60) { return ring.slice(-n) }

try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}

module.exports = { log, tail, LOG_FILE }
