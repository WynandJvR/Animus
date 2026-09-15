'use strict'
// One abort signal for the whole body. abort() ends every running walk/dig/place loop at its next
// check; token() captures the current epoch so a loop can ask "was I cancelled since I began?".
let epoch = 0
function abort () { epoch++ }
function token () { const e = epoch; return () => epoch !== e }
function current () { return epoch }
module.exports = { abort, token, current }
