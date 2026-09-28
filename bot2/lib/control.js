'use strict'
// One abort signal for the whole body. abort() ends every running walk/dig/place loop at its next
// check; token() captures the current epoch so a loop can ask "was I cancelled since I began?".
// TASK SCOPE: while a task runs, a token counts from the TASK's start, not its own - so after an abort every action the
// dying task still begins is cancelled at once. Counted from its own start, the walk the next line began after a death
// was fresh: the night mine's "to mine face" walked the respawned body 40 blocks back into the dark, and it died there
// again with nothing on it (2026-09-28). The scope ends when the task settles: reflexes, a paused body, the next task
// take fresh tokens again.
let epoch = 0
let scope = null
function abort () { epoch++ }
function token () { const e = scope ? scope.start : epoch; return () => epoch !== e }
function current () { return epoch }
function begin () { const s = { start: epoch }; scope = s; return { cancelled: () => epoch !== s.start, end: () => { if (scope === s) scope = null } } }
module.exports = { abort, token, current, begin }
