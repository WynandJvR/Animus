# DESIGN S2: run.js external liveness supervisor (REDESIGN §8, layer d)

Status: design for implementation. One flag: `SUPERVISE` (default ON; `=0` disables the whole
liveness ladder — run.js behaves byte-for-byte as today: restart-on-exit only). Scope:
`bot/run.js`, ONE NEW pure module `bot/supervise.js` + its offline test `bot/supervisortest.js`,
and a ~4-line exemption in `bot/index.js`. `commands.js` / `provision.js` / `navigate.js` /
`arbiter.js` UNTOUCHED. The heartbeat writer (index.js:1810-1837) is ALREADY COMMITTED and is
consumed as-is — do not modify it.

All line numbers are as of commit `d60c95e` (working tree 2026-07-16; bot/*.js clean vs HEAD).

---

## 1. Problem

No in-process rule can catch a hung event loop or a never-settling promise that wedges the whole
decision loop — the in-process watchdogs are themselves on that loop. `bot/run.js` is already the
out-of-process parent (launch.ps1:40 runs `node run.js` in production), but today it is 36 lines
that only react to child **exit** (run.js:20-28). A process that is alive-but-wedged runs forever;
a process whose body is frozen while HTTP still answers runs forever. REDESIGN-proactive-survival.md
§8 specifies the fix: an external liveness ladder in run.js. The signals half (§8.1) is already
live; this slice is the consumer half (§8.2/§8.3).

## 2. What already exists (verified at d60c95e — consume, don't redesign)

### 2.1 The heartbeat writer — index.js:1810-1837

Gated on `process.env.STATE_HISTORY !== '0'` (index.js:1819). A plain `setInterval(historyTick,
5000)` (index.js:1835), **unref'd** (1836), writes `HEARTBEAT_FILE` = `process.env.HEARTBEAT_FILE
|| path.join(__dirname, 'heartbeat.json')` (index.js:1818 — i.e. `bot/heartbeat.json`) every ~5s
via `fs.writeFileSync` (index.js:1832). The object written is
`Object.assign({}, loghistory.compactSample(commands.state(bot), Date.now()), { connected: !!bot.entity, lastProgressAt })`,
so the EXACT shape (compactSample: loghistory.js:21-41) is:

```
{ t: <ms epoch>,                    // sample time
  hp: <number|null>,                // bot.health
  food: <number|null>,
  pos: {x,y,z} | null,              // toFixed(1) numbers (commands.js:2310)
  activity: <string|null>,          // activity.name ONLY - a STRING, not the /state object
  job: <string|null>, blockedOn: <string|null>, threat: <string|null>,
  moving: <bool>, graves: <number>, biome: <string|null>, isDay: <bool|null>,
  connected: <bool>,                // !!bot.entity
  lastProgressAt: <ms epoch> }      // see below
```

`lastProgressAt` (index.js:1820-1831) advances ONLY when the body materially moved: the tick
compares `sample.pos` to the previous tick's pos and bumps it when `|dx|+|dy|+|dz| >= 1`
(index.js:1830). It initializes to process-start `Date.now()` (1821). So "lastProgressAt older
than 5 min" IS "hasn't moved a block in 5 min" — the supervisor needs no pos-history of its own
for that half of the frozen test. Failure modes the supervisor must tolerate: `historyTick` wraps
everything in try/catch (1823/1833) — if `commands.state` throws persistently the file silently
STOPS updating (goes stale) — and with `STATE_HISTORY=0` the file is NEVER written (absent, or a
leftover from a previous run).

### 2.2 The control API — index.js:1586-1808

`http.createServer` (index.js:1586) listening on `CONTROL_HOST`/`CONTROL_PORT` env else
`cfg.controlHost`/`cfg.controlPort` (index.js:1804-1806) — live config: `127.0.0.1:3001`
(bot/config.json). Relevant routes:

- `GET /health` (index.js:1587) → `{ ok: true, spawned: !!bot.entity }`. Cheapest possible
  event-loop-liveness probe; never touches state assembly, cannot 500.
- `GET /state` (1588-1606) → full snapshot; `activity` here is the OBJECT
  `{name, detail, forSec}|null` (commands.js:2343) — note the shape differs from the heartbeat's
  string. Can 500 pre-spawn.
- `POST /cmd` (1609-1702) — the brain's command path. Payload: raw text line, or JSON
  `{ "command": "<line>", "reason": "<why>" }` (parsed at index.js:1615). Gates, in order:
  - **1619-1622** CHEAT_CMDS confinement (access.js:129) — does NOT match `stop`/`recover`.
  - **1639-1642** persisted-build stop-hold: `stop` while `commands.persistedResume()` truthy →
    held ("the brain may not cancel it"). BLOCKS a supervisor `stop`.
  - **1643-1676** busy-gate: `bodyBusy && !readOnly` → held. `stop` is not readOnly (1645) and
    not a survivalCmd (1655), so it's held; `recover` IS a survivalCmd but is held whenever
    `survivalAdmissible` (index.js:1573-1585) says no unmet need — exactly the frozen-with-full-
    hearts case the supervisor exists for. BLOCKS both supervisor verbs.
  - **1681-1685** one-job-at-a-time: matches only movement/build verbs — `stop`/`recover` pass.
  - **1686-1687** gateSay/gateImpactful: `say` and give/build only — `stop`/`recover` pass.
- `POST /op/cmd` (1774-1798) — operator path, no gates. **Deliberately NOT used by the
  supervisor**: (a) every /op/cmd is logged to brain-decisions.jsonl as a gold-standard HUMAN
  demonstration (index.js:1785-1793) — autonomic nudges would poison the training data; (b) it is
  full-power (`source:'operator'` unlocks `cancelbuild`, commands.js:2160) — the supervisor must
  stay confined to two verbs. Hence the header exemption on /cmd (§6).

### 2.3 `stop` and `recover` are already restart/supervisor-safe

- `stop` (commands.js:1602-1616) = **pause, not destroy** (commit 4a4638d): clears follow/goal/
  in-memory job, sets buildAbort, but KEEPS the persisted build and stamps a hold — it auto-
  resumes after `RESUME_HOLD_MS`; only operator `cancelbuild` deletes (commands.js:2160). A
  supervisor `stop` can never erase operator intent.
- `recover` (commands.js:1389-1418) is mutexed ("already recovering"), no-grave-safe ("i haven't
  died recently - nothing to go get"), lava-death-safe, and night+naked-gated. Firing it blind is
  harmless when there is nothing to recover.
- **S4 restart-safety is assumed, not designed here** (REDESIGN §7): death ledger, world-memory,
  chest-cache, persistedResume, spawn-suspect flag all persist — `child.kill()` + restart is
  always a legal move that lands in recoverable state.

### 2.4 run.js today (all 36 lines)

`spawn(node, [index.js], {stdio:'inherit'})` (run.js:16-19); on `exit` (20-28): quick-crash
counter (`ranMs < 4000` → `quickCrashes++`, line 23), restart delay `code === 0 && !quickCrashes
? 500 : min(2000*quickCrashes, 15000)` (line 25) — exit(0) is the intentional "Save & reconnect"
restart (index.js:1768) and must stay fast. SIGINT/SIGTERM → `stopping = true; child.kill();
exit(0)` (29-31). `child` is local to `start()`; `lastStart` is module-level (line 12).

## 3. The design in one paragraph

A NEW PURE module `bot/supervise.js` (house style of route-mem.js/arbiter.js: no bot, no timers,
no sockets in the decision core) exports one decision function `decide(hb, probe, now, st)` →
`{action, st}` implementing the §8.2 ladder — startup grace, frozen-vitals nudge, stale/silent
kill, 10-min kill rate-limit — plus three thin stdlib I/O helpers (read+parse the heartbeat file,
GET /health with a hard timeout, POST /cmd with the `X-Supervisor: 1` header) and an intervention
logger appending to `logs/supervisor.log`. `bot/run.js` grows ~35 lines of wiring: hoist `child`,
one `setInterval(pollTick, 15000)` created only when `SUPERVISE !== '0'`, which gathers the two
signals, calls `decide`, and acts — `nudge` = POST `stop`, 20s later POST `recover`; `kill` =
`child.kill()`, after which the EXISTING exit handler restarts with the existing backoff. In
`bot/index.js`, exactly two brain-gates get a `!fromSupervisor` exemption (the persisted-build
stop-hold at 1639 and the busy-gate at 1646), where `fromSupervisor` is true ONLY for the
`X-Supervisor: 1` header AND the command being exactly `stop` or `recover` — the supervisor
bypasses brain-suppression (which guards against the *brain*, not ops) but stays inside the CHEAT
confinement and can never run any other verb.

---

## 4. NEW pure module `bot/supervise.js`

Style-match arbiter.js/route-mem.js: `'use strict'`, plain data in/out, every tunable a named
export so the test pins them. Only `readHeartbeat`/`probeHealth`/`postCmd`/`logIntervention`
touch fs/http (stdlib only — `fs`, `path`, `http`); `decide` and `freshState` are pure.

### 4.1 Constants (exported as `T`)

```
T = { POLL_MS: 15000,            // ladder cadence (§8.2)
      HB_STALE_MS: 90000,        // heartbeat silent -> kill class
      FROZEN_MS: 300000,         // lastProgressAt older than 5 min
      START_GRACE_MS: 120000,    // no verdicts right after (re)start - login/auth/device-code
      NUDGE_WAIT_MS: 20000,      // stop -> recover gap
      NUDGE_COOLDOWN_MS: 300000, // at most one nudge per 5 min
      KILL_COOLDOWN_MS: 600000,  // >=10 min between supervisor kills (§8.2 item 4)
      PROBE_TIMEOUT_MS: 5000,
      DOWN_POLLS_KILL: 3,        // probe down 3 consecutive polls (~45s)
      FROZEN_POLLS_KILL: 3 }     // nudge at 1, wait at 2, kill at 3
```

Builder may tune ±small; every bound stays finite; the doc's values are the defaults.

### 4.2 The decision core — EXACT signature

```
freshState(now) -> { startedAt: now, lastKillAt: 0, lastNudgeAt: 0,
                     downPolls: 0, frozenPolls: 0, prevPos: null, prevActivity: null }

decide(hb, probe, now, st) -> { action: 'ok'|'grace'|'nudge'|'kill'|'kill-suppressed', st }
  hb    : the parsed heartbeat object (§2.1 shape) or null (file missing / unreadable /
          unparsable / STATE_HISTORY=0). null is NEVER stale - it means "no heartbeat signal".
  probe : 'ok' | 'down'. ANY HTTP response (any status incl. 500) = 'ok' - a 500 still proves
          the event loop is alive. Timeout / connection refused / socket error = 'down'.
  now   : ms epoch (injected - no Date.now() inside, mirroring arbiter's testability).
  st    : the threaded state (returned updated every call; caller stores it).
```

Decision order (each step falls through unless it returns):

1. **Grace**: `now - st.startedAt < T.START_GRACE_MS` → `'grace'`; zero `downPolls`/`frozenPolls`,
   still update `prevPos`/`prevActivity` from `hb`. This is what makes a LEFTOVER stale
   heartbeat.json from before a restart harmless (first fresh write lands within ~5s of spawn,
   long before grace ends) and what protects the slow microsoft device-code login.
2. **Track down-streak**: `probe === 'down'` → `st.downPolls++`, else `st.downPolls = 0`.
3. **Track frozen-streak** — frozen this poll iff ALL of:
   `probe === 'ok'` AND `hb != null` AND `hb.connected !== false` AND
   `typeof hb.activity === 'string' && hb.activity` (activity != null — an idle bot standing
   still at home is NOT a wedge) AND `typeof hb.lastProgressAt === 'number' &&
   now - hb.lastProgressAt > T.FROZEN_MS` AND `st.prevPos && hb.pos &&
   |dx|+|dy|+|dz| < 1` (same-pos rule = the writer's own progress rule, index.js:1830) AND
   `hb.activity === st.prevActivity`.
   Frozen → `st.frozenPolls++`, else `st.frozenPolls = 0`. Then update `st.prevPos = hb.pos`,
   `st.prevActivity = hb.activity` (when `hb` non-null). First poll after start has
   `prevPos === null` → never frozen → the baseline builds; minimum two polls to a nudge.
4. **Kill class**: `stale || st.downPolls >= T.DOWN_POLLS_KILL || st.frozenPolls >=
   T.FROZEN_POLLS_KILL`, where `stale = hb != null && typeof hb.t === 'number' &&
   now - hb.t > T.HB_STALE_MS` (stale-OR-silent per §8.2 item 3; a live /health with a dead
   heartbeat writer means commands.state is permanently throwing — restart is correct).
   If in kill class: `st.lastKillAt > 0 && now - st.lastKillAt < T.KILL_COOLDOWN_MS` →
   `'kill-suppressed'` (counters NOT reset — re-evaluated next poll; the shell logs it so a
   crash-looping bug surfaces instead of masking itself). Else set `st.lastKillAt = now`, reset
   `downPolls`/`frozenPolls` → `'kill'`.
5. **Nudge**: `st.frozenPolls === 1 && (st.lastNudgeAt === 0 || now - st.lastNudgeAt >
   T.NUDGE_COOLDOWN_MS)` → set `st.lastNudgeAt = now` → `'nudge'`. (frozenPolls 2 → `'ok'` — the
   "still frozen next two polls" wait; a nudge that merely flaps the activity string restarts the
   streak but the cooldown stops nudge-spam, so the streak climbs to 3 → kill.)
6. Otherwise `'ok'`.

### 4.3 I/O helpers (stdlib; each independently testable)

- `readHeartbeat(file)` → parsed object or `null`. `fs.readFileSync` + `JSON.parse`, any throw →
  null. No caching.
- `probeHealth(host, port, timeoutMs)` → `Promise<'ok'|'down'>`. `http.get({host, port,
  path:'/health', timeout})`; ANY response → consume+discard body, `'ok'`; `'timeout'` event →
  `req.destroy()`, `'down'`; `'error'` → `'down'`. Never rejects.
- `postCmd(host, port, command, reason, timeoutMs)` → `Promise<{sent:bool, body?:string}>`.
  `http.request` POST `/cmd`, headers `{'Content-Type':'application/json', 'X-Supervisor':'1'}`,
  body `JSON.stringify({command, reason})` (matches the parser at index.js:1615). **Timeout after
  connect = success-in-progress**: `recover` runs to completion before /cmd responds (it awaits
  `commands.handle`, index.js:1690 — a grave trek can take minutes); the server keeps executing
  after a client disconnect, so destroy the request at ~10s and treat it as `{sent:true}`. Never
  rejects.
- `logIntervention(entry, file)` → append `JSON.stringify(entry)` + newline to
  `logs/supervisor.log` (default `path.join(__dirname, '..', 'logs', 'supervisor.log')`),
  `mkdirSync recursive` + retry once, swallow errors — same defensive shape as
  `loghistory.appendSample` (loghistory.js:52-63). No rotation (interventions are rare by
  construction; note for a future slice if it ever grows).

Exports: `{ decide, freshState, readHeartbeat, probeHealth, postCmd, logIntervention, T }`.
No side effects at require time (run.js requires it unconditionally).

## 5. `bot/run.js` changes (wiring only, ~35 lines)

All insertions preserve the existing lines verbatim; with `SUPERVISE=0` no interval is ever
created and behavior is byte-for-byte today's (the `let child` hoist and the require are inert).

1. **Requires** (after run.js:8): `const supervise = require('./supervise.js')` and
   `const SUPERVISE = process.env.SUPERVISE !== '0'`.
2. **Hoist the child** (next to run.js:10-12 state): `let child = null` module-level;
   `start()` assigns `child = spawn(...)` instead of `const child` (run.js:16). Also module-level
   `let st = supervise.freshState(Date.now())`, `let killedBySupervisor = false`,
   `let nudgeTimer = null`.
3. **On (re)start** (inside `start()`, next to `lastStart = Date.now()`, run.js:15):
   `st = Object.assign(supervise.freshState(Date.now()), { lastKillAt: st.lastKillAt })` — the
   kill rate-limit survives a supervisor-kill restart (else kill→restart→grace→kill would loop at
   grace-speed), and the grace window re-arms.
4. **In the exit handler** (run.js:20, first lines): `if (nudgeTimer) { clearTimeout(nudgeTimer);
   nudgeTimer = null }` and `if (!killedBySupervisor) st.lastKillAt = 0; killedBySupervisor =
   false` — "≥10 min between kills UNLESS the child exited on its own" (§8.2 item 4). The
   quick-crash math (run.js:23-25) and the exit(0) fast path are untouched. Note: a supervisor
   `child.kill()` arrives here as `code null, signal SIGTERM` → delay 2000ms via the existing
   formula — acceptable, no change.
5. **Config for the probe** (module level): best-effort read of `bot/config.json` (same file
   index.js requires at index.js:22) → `controlHost`/`controlPort`, env overrides
   `CONTROL_HOST`/`CONTROL_PORT` mirroring index.js:1804-1805, hard fallback `127.0.0.1`/`3001`.
   Heartbeat path: `process.env.HEARTBEAT_FILE || path.join(__dirname, 'heartbeat.json')` — the
   IDENTICAL expression to index.js:1818 (same `__dirname`, `bot/`).
6. **The poll** (after `start()`'s definition, before the banner at run.js:34), only when
   `SUPERVISE`:

```
setInterval(pollTick, supervise.T.POLL_MS)   // plain interval; the child holds the process open
async function pollTick () {
  if (stopping || !child || child.exitCode != null) return   // no child - nothing to supervise
  const hb = supervise.readHeartbeat(HB_FILE)
  const probe = await supervise.probeHealth(host, port, supervise.T.PROBE_TIMEOUT_MS)
  const r = supervise.decide(hb, probe, Date.now(), st); st = r.st
  if (r.action === 'ok' || r.action === 'grace') return
  log + act (below)
}
```

   - `'nudge'` → log `{t, action:'nudge', reason:'frozen-vitals', activity:hb.activity, pos:hb.pos,
     lastProgressAgoSec}` → `await postCmd(host, port, 'stop', 'supervisor: frozen-vitals nudge')`
     → `nudgeTimer = setTimeout(() => { nudgeTimer = null; postCmd(host, port, 'recover',
     'supervisor: post-stop recover') }, T.NUDGE_WAIT_MS)`. A `nudgeInFlight`-style overlap guard
     is unnecessary — `decide`'s cooldown already serializes nudges.
   - `'kill'` → log `{t, action:'kill', reason: stale?'heartbeat-stale':(downPolls?'probe-silent':
     'frozen-after-nudge'), ...counters}` (builder: have `decide` include a `why` string in its
     return, or recompute — either is fine, log the truth) → `killedBySupervisor = true;
     try { child.kill() } catch {}`. The existing exit handler restarts it.
   - `'kill-suppressed'` → log it (this is the operator's crash-loop alarm), do nothing else.
   - Also mirror each intervention to the console: `console.log('[run] SUPERVISOR ' + ...)` — the
     same channel as run.js:26.
7. **Ctrl+C** (run.js:29-31): unchanged — `process.exit(0)` tears the interval down with the
   process.

## 6. `bot/index.js` — the `X-Supervisor` exemption (the ONE gate change)

**Insertion point: index.js:1616**, immediately after `line`/`why` are parsed (1613-1615) and
BEFORE the CHEAT gate (1619):

```
const fromSupervisor = req.headers['x-supervisor'] === '1' && /^(stop|recover)\s*$/i.test(String(line).trim())
```

(node lowercases incoming header names; the verb allowlist means the header can NEVER unlock any
other command — a buggy/compromised local process gains nothing the loopback bind, index.js:1806
+ config.json `controlHost: 127.0.0.1`, didn't already grant.)

Then exactly TWO gates learn the exemption:

1. **index.js:1639** (persisted-build stop-hold) — prepend the guard:
   `if (!fromSupervisor && /^stop\b/i.test(String(line).trim()) && commands.persistedResume && commands.persistedResume())`.
   Safe because post-4a4638d `stop` PAUSES the saved build (commands.js:1607-1615); the hold
   exists to stop the *brain's* whims, and §8.2 says exactly this: the suppression guards against
   the brain, not ops.
2. **index.js:1646** (busy-gate) — `if (bodyBusy && !readOnly && !fromSupervisor)`. This frees
   both verbs: `stop` (not readOnly, not survival-class) and `recover` (survival-class but
   inadmissible when vitals are fine — the exact alive-but-wedged case).

No other gate matches the two verbs (verified: CHEAT_CMDS access.js:129; one-job gate
index.js:1681-1682; gateSay index.js:135; gateImpactful index.js:176-182) — leave them all
untouched, INCLUDING the CHEAT gate at 1619, which deliberately still applies to supervisor
requests (defense in depth).

Two cosmetic-but-required log touches so interventions are attributable in bot-events.log:
at **index.js:1690** pass `{ source: fromSupervisor ? 'supervisor' : 'brain' }` (gate-neutral:
the only source check in commands.js is `=== 'operator'` at commands.js:2160), and include a
`[supervisor]` marker in the `note()` at **index.js:1694** when `fromSupervisor`.

## 7. Safety argument (hard constraints, stated)

- **The supervisor never makes gameplay decisions.** Its complete verb set is `stop`, `recover`,
  `child.kill()`. The `fromSupervisor` predicate is verb-allowlisted at the parse site (§6), so
  even a forged header cannot grief, build, move, or `cancelbuild`. The CHEAT confinement stays
  in force on its requests.
- **Operator intent is preserved.** Supervisor `stop` = pause (commands.js:1607-1615); the saved
  build survives and auto-resumes; only a human `cancelbuild` deletes. `recover` is mutexed and
  no-op-safe (commands.js:1394, 1403-1408).
- **Dependency-free node**: run.js/supervise.js use only `child_process`, `path`, `http`, `fs`.
- **"Save & reconnect" unbroken**: exit(0) still restarts in 500ms (run.js:25 untouched); the
  supervisor state resets with a fresh grace window on every start; a natural exit clears the
  kill cooldown so it never delays a legitimate restart.
- **Quick-crash backoff unbroken**: the exit handler's counters are untouched; a supervisor kill
  flows through the same handler.
- **Bounded everywhere**: one nudge per 5 min, one kill per 10 min (unless natural exit), 3-poll
  streaks, 5s probe timeout, 120s startup grace, every intervention logged to
  `logs/supervisor.log` AND the console — a crash-looping bug becomes loud, never masked.
- **Restart is always legal** (assumed from §7 S4, not designed here): death ledger,
  world-memory, chest-cache, persistedResume, spawn-suspect flag all persist; the startup path
  runs the recovery ladder.
- **Degrades honestly**: `hb === null` (file missing / STATE_HISTORY=0) disables the
  stale+frozen signals — it is NEVER treated as stale — and the probe-silence ladder still
  works. A wedged event loop stops BOTH signals, which is the point.
- **No self-fights**: the nudge order (stop → 20s → recover) is load-bearing — `stop` clears
  goal/latches (commands.js:1602-1606) so `recover` starts on a freed body; the 5-min nudge
  cooldown means the supervisor can never machine-gun the command path.

## 8. Flags & rollback

- `SUPERVISE=0`: no interval created; run.js behaves byte-for-byte as today (restart-on-exit
  only). The index.js exemption is inert without the header — no other client sends it.
- `STATE_HISTORY=0` (pre-existing flag, index.js:1819): heartbeat absent → supervisor runs
  probe-only (no frozen-vitals, no staleness). Supported, but the deploy default keeps both ON.
- Code rollback: one commit, three files + one new test; `git revert` clean. No data migration —
  the only new artifact is `logs/supervisor.log`, append-only.

## 9. Test plan (light gate)

**Syntax**: `node --check` on `bot/run.js`, `bot/supervise.js`, `bot/supervisortest.js`,
`bot/index.js`.

**NEW offline test `bot/supervisortest.js`** (`cd bot && node supervisortest.js`; same
`t(name, fn)`/assert harness as routememtest.js:12-15, plus a tiny sequential `ta(name, asyncFn)`
runner for the two async cases; `process.exitCode = 1` on any failure). Use a helper
`hbAt({tAgo, progressAgo, pos, activity, connected})` to build heartbeat fixtures around a fixed
`NOW`. Decision cases the builder must make pass (thread `st` through consecutive calls exactly
as run.js will; start from `freshState(NOW - 10*60000)` so grace is over unless stated):

| # | input | expected |
|---|---|---|
| 1 | fresh hb (t=NOW-5s, lastProgressAt=NOW-10s, activity 'gather'), probe 'ok' | `'ok'` |
| 2 | hb `null` (file missing / STATE_HISTORY=0), probe 'ok' | `'ok'` — null is never stale |
| 3 | poll A: frozen hb (activity 'gather', lastProgressAt=NOW-6min, pos {10,64,10}); poll B (+15s): identical pos/activity | A `'ok'` (baseline), B `'nudge'` |
| 4 | continue #3: polls C,D still identical | C `'ok'` (frozenPolls 2), D `'kill'` + `st.lastKillAt = now` |
| 5 | same geometry as #3 but `activity: null` (idle at home, 6 min still) | never nudge — `'ok'` on every poll |
| 6 | same as #3 but `connected: false` | `'ok'` — disconnected is not a wedge |
| 7 | hb stale (t=NOW-120s), probe 'ok', fresh state | `'kill'` (stale-OR-silent) |
| 8 | hb fresh, probe 'down' three consecutive polls | `'ok'`,`'ok'`,`'kill'` |
| 9 | kill class (as #7) but `st.lastKillAt = NOW-4min` | `'kill-suppressed'`, counters intact; with `lastKillAt = NOW-11min` → `'kill'` |
| 10 | `st.startedAt = NOW-30s`, hb stale leftover (t=NOW-10min) | `'grace'` — restart never insta-kills on the old file |
| 11 | frozen streak at 1 but `st.lastNudgeAt = NOW-60s` (recent nudge) | `'ok'` at poll 1... and `'kill'` when the streak reaches 3 (cooldown never blocks the kill) |
| 12 | poll A frozen baseline as #3, poll B pos moved to {13,64,10} | B `'ok'`, `frozenPolls === 0` (movement resets) |

Plus the §8.3 I/O cases (stdlib mock, no bot): `readHeartbeat` on a scratch file — fresh JSON →
object, garbage bytes → null, missing path → null (write fixtures under the scratchpad/`os.tmpdir`,
not the repo). `probeHealth` against a real `http.createServer` on an ephemeral port (`listen(0)`)
answering `/health` → `'ok'`; after `server.close()` (conn refused) → `'down'`; a server that
never responds → `'down'` within ~PROBE_TIMEOUT_MS. `postCmd` against a mock that captures the
request → assert method POST, path `/cmd`, header `x-supervisor: '1'`, JSON body
`{command:'stop', reason:...}` (this pins the payload contract to index.js:1615 + §6's predicate).

**Non-regression**: run the existing offline suites (`arbitertest`, `routememtest`, `miningtest`,
`plannertest`, `statehistorytest`, `pocketescapetest`, ... the standalone `bot/*test.js`) — all
green.

**ONE bounded local smoke** (~5 min, no test server, no live bot): point run.js at a stub —
`HEARTBEAT_FILE=<scratch>\hb.json CONTROL_PORT=3199 SUPERVISE=1 BOT_ENTRY` is over-engineering;
simplest honest variant: temporarily copy run.js's spawn target trick is NOT needed — instead run
`node run.js` in a scratch checkout is heavy too. Do it in-process: a 20-line throwaway script in
the scratchpad that requires `./supervise.js`, stands up a fake `/health`-less port + a stale
heartbeat file, and drives `pollTick`'s exact call sequence, asserting a `kill` decision fires
after grace and `logs/supervisor.log` receives the line. Then deploy LIVE (launch.ps1 path
unchanged — `node run.js` picks the feature up automatically) and watch with cheap bash polls for
~15 min: `logs/supervisor.log` must stay EMPTY while the bot works normally (no false nudges/
kills — the primary live risk), heartbeat.json mtime ticking, `/health` answering. Any snag →
bail and report per the light-gate rule.

## 10. Definition of done

- `node --check` clean on all four files; supervisortest 12 decision + 3 I/O cases green; all
  existing offline suites green.
- `SUPERVISE=0` verified: run.js restart-on-exit behavior identical (read the diff — no interval,
  no behavior change on that path).
- Local smoke: stale-heartbeat stub → one logged `kill` after grace, restart via the existing
  handler, second kill suppressed inside 10 min.
- Live: ≥15 min under `node run.js` with zero false interventions; `supervisor.log` exists and
  is silent; "Save & reconnect" round-trips once (exit 0 → 500ms restart) untouched.

## 11. Deliberately out of scope / deferred to the builder

- **Constants** (§4.1): tune ±small, keep finite, keep the ladder ordering.
- **Frozen-vitals from /state instead of the heartbeat file**: §8.1 sketched probing /state; this
  design reads the vitals from heartbeat.json and probes the cheaper `/health` (index.js:1587) —
  same fields, one fewer heavy state assembly per poll, and the pure core needs only
  `(hb, probe)`. Do not "fix" this back.
- **supervisor.log rotation**, heartbeat schema changes, any index.js watchdog work (layer b),
  the scheduler (§3), restart-safety hardening (§7 S4) — other slices.
- **No new verbs**: resist adding e.g. a supervisor `say` or `goto` — the two-verb + kill
  boundary is the safety property.
- Exact log wording / console phrasing — builder's call, keep the `[run] SUPERVISOR` prefix.
