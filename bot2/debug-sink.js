'use strict'
// ONE definition of the debug-sink rule (DESIGN-PRINCIPLES §4).
//
// Twelve modules carried a byte-identical copy of the same four-line idea: own a sink, prefix the
// line, echo it to stdout under BUILD_DEBUG, and forward it to whoever registered. Twelve copies of
// a rule is twelve places for it to drift - and the drift would be invisible, because a debug line
// that silently stops being forwarded looks exactly like a quiet subsystem.
//
// Each caller still owns its OWN sink: makeDebug() closes over a fresh one, so registering a sink
// on provision-food never redirects provision-hut's lines. That per-module ownership is why this is
// a factory and not a shared singleton.
function makeDebug (prefix) {
  let sink = null
  const dbg = (...a) => {
    const line = prefix + ' ' + a.map(x => String(x)).join(' ')
    if (process.env.BUILD_DEBUG) console.log(line)
    if (sink) sink(line)
  }
  return { dbg, setDebugSink (fn) { sink = fn } }
}

module.exports = { makeDebug }
