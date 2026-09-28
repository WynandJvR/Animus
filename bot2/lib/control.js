'use strict'
// One abort signal for the whole body. abort() ends every running walk/dig/place loop at its next
// check; token() captures the current epoch so a loop can ask "was I cancelled since I began?".
// TASK SCOPE: a token taken in a task's own async chain - every await it makes, every action it starts - counts from the
// TASK's start, not its own, so after an abort whatever the dying task still begins is cancelled at once. Counted from
// its own start, the walk the next line began after a death was fresh: the night mine's "to mine face" walked the
// respawned body 40 blocks back into the dark, and it died there again with nothing on it (2026-09-28). Bound to the
// task's async context (AsyncLocalStorage), never global: a reflex acting from the physics tick, an op command, a
// timer - outside the chain - takes its own fresh token as ever, so a dig-in in the middle of the unwind still works
// (a global scope disabled every survival reflex for as long as the dying task's slowest walk; audit 2026-09-28).
const { AsyncLocalStorage } = require('async_hooks')
const als = new AsyncLocalStorage()
let epoch = 0
function abort () { epoch++ }
function token () { const s = als.getStore(); const e = s ? s.start : epoch; return () => epoch !== e }
function current () { return epoch }
// begin(): the task's scope - run(fn) runs fn inside it; cancelled() is the task's own token
function begin () { const s = { start: epoch }; return { cancelled: () => epoch !== s.start, run: fn => als.run(s, fn) } }
module.exports = { abort, token, current, begin }
