# DESIGN: Build persistence that survives the brain's panic (stop = pause, cancel = operator-only)

Status: design for implementation. Flag-gated by `STOP_KEEPS_BUILD` (default ON; `STOP_KEEPS_BUILD=0`
restores today's behavior byte-for-byte). Scope: `bot/commands.js`, `bot/index.js`, `bot/access.js`
only. `provision.js` / `navigate.js` / `mining.js` / `arbiter.js` untouched.

All line numbers are as of commit `f0696d4` (working tree 2026-07-15). The operator's reported line
numbers had drifted slightly; corrected citations are given throughout and diagnosis corrections are
called out in §2.

---

## 1. Problem

An operator build ("build the castle at 430,67,85") is persisted to disk so deaths and process
restarts resume it:

- **Written** by `persistResume(name, at)` — `bot/commands.js:2957-2959`, file
  `RESUME_FILE` = `bot/resume-job.json` (env-overridable, commands.js:2956). Written at build-request
  time via `setResumeJob` (commands.js:2951, called from `startNaturalBuild`, index.js:478) and again
  with the ground-snapped origin at `case 'autobuild'` (commands.js:2093).
- **Read** by `persistedResume()` — commands.js:2961-2963. Consumers: boot auto-resume
  (index.js:241-257), the 2-minute re-arm loop (index.js:263-274), the respawn go-home anchor
  (index.js:614), the brain `stop`-hold (index.js:1606), the one-job-at-a-time gate (index.js:1648).
- **Deleted** by `clearPersistedResume()` — commands.js:2960 (`fs.unlinkSync`).

The delete fires in three places, and two of them are wrong:

1. **`case 'stop'` destroys the save.** commands.js:1596-1600:
   ```js
   case 'stop':
     followTarget = null
     buildAbort = true
     resumeJob = null; buildInterrupted = false; resumeDeaths = 0; clearPersistedResume() // an explicit stop cancels auto-resume too
     bot.pathfinder.setGoal(null); return 'stopped'
   ```
   Any `stop` that reaches the handler erases the operator's castle. The LLM brain is *instructed*
   to emit `stop` when wedged (bot/brain-llm.js:248-250: "First `stop`, then pick a DIFFERENT
   approach"), so in a death-spiral it spams exactly the command that deletes the job. Live:
   `(cmd) stop «armorup failed, need to reset» -> stopped`.

2. **A false "done" destroys the save.** commands.js:2107 (`resumeJob = null; if (!r.stopped)
   clearPersistedResume()`) and commands.js:3106 (`if (result && !result.stopped)
   clearPersistedResume()`). `buildSurvival` returns `stopped:false` whenever its placement loop
   drains — including "nothing reachable and no progress -> the rest is genuinely blocked"
   (bot/schematic.js:719) and the all-materials-skipped case (schematic.js:735-742). An autoBuild
   run far from the site "finished" 0/2350 all-skipped and **cleared the castle job, verified
   live** — the code's own comment says so (commands.js:3060-3063). The travel-retry fix reduced
   that window but the clear condition itself is still `!stopped`, not "actually finished".

3. The one *correct* delete: a genuinely finished build. That must survive the redesign.

The owner's framing: the bot is autonomous; a saved build is **operator intent**; nothing but an
explicit operator cancel may throw it away. A save a confused brain (or a false "done") can silently
delete is worthless.

## 2. Corrections to the reported diagnosis

- **Guard location:** the brain `stop`-hold is at **index.js:1606**, not 1568 (code drift). It reads:
  `if (/^stop\b/i.test(String(line).trim()) && commands.persistedResume && commands.persistedResume())`
  → hold, on the `/cmd` path only.
- **The guard did not "leak" a brain stop through while the file existed.** The hold is checked
  before `commands.handle` is ever called and the regex covers `stop`, `Stop`, `stop building`, etc.
  What actually happens is worse: **the guard's predicate is the existence of the file it is
  guarding.** Once anything else deletes the file — the false-done clear at commands.js:2107/3106
  (live-verified, see the comment at 3060-3063), or `persistedResume()` returning `null` on a
  transient FS read error (its `catch { return null }` at commands.js:2962 fails *open*) — the
  brain's next `stop` passes the guard *legitimately* and logs `-> stopped`. The observed log line
  is the symptom; the false-done clear is the destroyer.
- **Structural weakness (real even if it hasn't fired yet):** the guard lives in one caller. Every
  other route to `case 'stop'` bypasses it:
  - the operator `!stop` chat path (index.js:359),
  - the natural-language `directCommand` path (index.js:388) — which maps **"wait", "hold on",
    "stay", "stay put", "hold up"** to `stop` (index.js:406), so an operator saying "wait" in
    conversation deletes their own castle today,
  - the **`/op/cmd` operator HTTP path (index.js:1741-1749)** — "full power, NOT brain-confined",
    used by the Animus GUI; a GUI `stop` deletes the save with no guard at all.
  Enforcement must move from the callers to the destructive primitive itself.
- `clearPersistedResume` is at commands.js:2960 and `persistedResume` at 2961-2963 (reported as
  2960/2961 — off by one, immaterial).
- The `RESUME_MAX_DEATHS` give-up (commands.js:2975-2984) does keep the disk file, as reported —
  correct pattern. But note (§6 row 4): the 2-minute re-arm loop (index.js:263-274) calls
  `resumebuild`, which resets `resumeDeaths = 0` (commands.js:2127), so today the "give-up" is a
  2-minute breather before the death-march resumes. The redesign gives it a real hold.

## 3. The model: PAUSE vs CANCEL

The resume file gets a tiny state machine instead of exists/deleted:

```
ACTIVE   {name, at, savedAt}                          -> resumed by boot/re-arm/respawn as today
PAUSED   {..., pausedAt, pausedWhy}                   -> resume machinery holds off until the hold expires
(gone)   file deleted                                 -> ONLY on real completion or operator cancelbuild
archived resume-job.cancelled.json                    -> cancelbuild renames rather than unlinks (cheap undo)
```

- **`stop` = halt NOW + pause.** Every current effect of `stop` is preserved: `followTarget = null`,
  `buildAbort = true` (build/provision loops watch it), `resumeJob = null` (no instant death-resume),
  `buildInterrupted = false`, `resumeDeaths = 0`, `setGoal(null)`. The **only** change: instead of
  `clearPersistedResume()`, stamp `pausedAt` into the file (`markResumePaused('operator stop')`).
- **The pause is a hold, not an abandonment.** Boot auto-resume (index.js:247) and the re-arm loop
  (index.js:267) skip a job whose `pausedAt` is fresher than `RESUME_HOLD_MS` (default 15 min).
  After the hold, autonomy wins and the build resumes itself — consistent with the north star
  ("nothing but an explicit operator cancel ever throws it away"; an idle autonomous bot goes back
  to its job). Operator levers: `resumebuild` resumes immediately (clears `pausedAt`);
  `cancelbuild` ends it forever. `RESUME_HOLD_MS=0` → next re-arm tick; a huge value → effectively
  indefinite pause. The `stop` reply makes this legible:
  `stopped ("castle" stays saved - resuming in ~15min; "resumebuild" to continue now, "cancelbuild" to drop it)`.
- **`cancelbuild` (alias `abandonbuild`) is the only delete.** Two-step confirm (§4.3).
- **A build that ends short of complete never deletes** — it pauses (§5).

Why pause-with-expiry rather than pause-forever: while the file exists, the one-job-at-a-time gate
(index.js:1648-1652) holds the brain's movement commands. A forever-pause plus that gate would
deadlock the bot into idling until a human returns — the opposite of the autonomy mandate. A bounded
hold keeps `stop` meaning "stop NOW" while the system self-heals.

## 4. Authority model — and making it airtight

### 4.1 How operator vs brain are distinguished today

| Channel | Path | Gate today |
|---|---|---|
| In-game `!command` | index.js:349-362 → `commands.handle` | `access.isOperator(username, cfg)` (access.js:28-33; allowlist from `config.operators` + `OPERATORS` env, empty = locked) |
| In-game natural language (`directCommand`, build requests) | index.js:385-393, 369-377 | same `isOperator` gate |
| Brain HTTP `POST /cmd` | index.js:1576-1668 → `commands.handle` (1657) | `CHEAT_CMDS` regex block (access.js:129, applied index.js:1586, lift with `BRAIN_ALLOW_CHEATS=1`); busy-hold (1610-1643); `stop`-hold while a saved job exists (1606); one-job movement hold (1648) |
| Operator HTTP `POST /op/cmd` (Animus GUI / console human) | index.js:1741-1749 → `commands.handle` | **none** — full power by design |
| Internal calls | e.g. index.js:251/270 (auto-resume), 655 (respawn recover), 912 (armorup); commands.js self-calls (2605, 2646, 3052, …) | none |

`commands.handle(bot, line)` takes **no source argument** — once a line reaches the handler,
operator and brain are indistinguishable. That is the root of the structural weakness.

### 4.2 The fix: three independent layers

**Layer 1 — the primitive stops being destructive (closes every leak at once).** With
`STOP_KEEPS_BUILD` on, `case 'stop'` cannot delete the file no matter who called it or through which
channel. A brain stop that slips any future gate, an operator's conversational "wait", a GUI stop —
all now pause at worst. This is the layer that makes guard-leak analysis moot: there is no longer a
destructive stop to guard.

**Layer 2 — keep the existing caller-side brain holds, unchanged.** The `/cmd` `stop`-hold
(index.js:1606) and the busy/one-job holds stay exactly as they are: the brain still can't even
*pause* an operator build, and its stated motive keeps appearing in `/log`. (Relaxing 1606 so the
brain can use `stop` to unwedge itself — now that stop is harmless — is a tempting follow-up but is
explicitly out of scope; it changes live brain behavior and needs its own observation window.)

**Layer 3 — source-authenticated cancel.** `commands.handle` gains an options argument:
`handle(bot, line, opts = {})` with `opts.source ∈ {'operator','brain','internal'}`,
**default = undefined = not an operator (fail closed)**. Callers updated:

- index.js:359 (`!cmd`), 388 (`directCommand`), 474/491/498 (`startNaturalBuild`), 1749 (`/op/cmd`)
  → `{ source: 'operator' }`
- index.js:1657 (`/cmd`) → `{ source: 'brain' }` (explicit, though the default already fails closed)
- index.js:251/270/655/912 and all internal `handle(bot, ...)` recursions inside commands.js
  → unchanged 2-arg calls → default → cannot cancel.

`case 'cancelbuild'` refuses unless `opts.source === 'operator'`. Additionally `cancelbuild` and
`abandonbuild` are added to `CHEAT_CMDS` (access.js:129) so the `/cmd` path blocks them *before*
`handle` is even called — same channel rule as `autobuild` itself (commands.js:2068-2069 documents
autobuild as "Operator-only (in CHEAT_CMDS)"). Two independent checks; either alone suffices.

Why 1606 leaked, restated against this model: it was a Layer-2-only design whose predicate
(file exists) was owned by unguarded Layer-1 deleters on other channels. Layer 1 removes the
deleters; Layer 3 authenticates the one deleter that remains.

### 4.3 `cancelbuild` command surface

```
cancelbuild            -> arms: 'this deletes the saved build "castle" at 430,67,85 for good -
                          say "cancelbuild confirm" within 60s'   (no state change)
cancelbuild confirm    -> within 60s of arming: halts any running build (buildAbort = true,
                          resumeJob = null, buildInterrupted = false, resumeDeaths = 0),
                          renames RESUME_FILE -> RESUME_FILE + '.cancelled' (overwrite ok),
                          returns 'cancelled "castle" - the save is archived, not resumable'
abandonbuild [confirm] -> alias
```

- Arming state: module-level `let cancelArmedAt = 0` in commands.js; `confirm` without a fresh arm
  re-arms and says so. No file to cancel → `'no saved build to cancel'`.
- Archive-not-unlink: a fat-fingered confirm is recoverable by renaming the file back and running
  `resumebuild`. (The unlink in `clearPersistedResume` itself stays an unlink — real completion has
  nothing worth archiving.)
- Channels: in-game `!cancelbuild` / natural chat is NOT wired into `directCommand` (deliberate — a
  destructive order should require the explicit `!` form), and `/op/cmd` works for the GUI. `/cmd`
  (brain) is blocked twice (CHEAT_CMDS + source check).

## 5. Completion clears only on REAL completion

**Signal available today:** `buildSurvival` returns `{ placed, total, skipped, stopped, passes,
cleared, scaffoldRemoved }` (schematic.js:611, 770-771), where
`skipped = build.actions.filter(place).length + matSkipped` — i.e. **placements still owed plus
materials given up on**. A genuinely finished build ends with `skipped === 0` (unplaceable tech
blocks are removed from the action list entirely at schematic.js:729, so they inflate neither
`placed` nor `skipped`). `resumeBuild` additionally returns `{stopped:true, ...}` sentinels and
`{deferred:true}` (commands.js:2993); `autoBuild` can return `{stopped:true, phase:'provision', ...}`
(commands.js:2904).

**Tighten:** replace both `!r.stopped → clear` sites with a **pure disposition function** in
commands.js:

```js
// pure - exported for offline tests
function finishDisposition (r) {
  if (!r) return 'keep'                                   // errored/undefined - never delete on a throw
  if (r.deferred) return 'keep'
  if (r.stopped) return 'keep'                            // aborted, not finished
  if ((r.skipped || 0) > 0) return 'pause'                // "done" but blocks are owed - shortfall
  return 'clear'                                          // placed everything it set out to place
}
```

Applied at commands.js:2107 and 3105-3107 (flag-gated):

```js
resumeJob = null
const disp = STOP_KEEPS_BUILD ? finishDisposition(r) : (!r.stopped ? 'clear' : 'keep')
if (disp === 'clear') clearPersistedResume()
else if (disp === 'pause') { markResumePaused(`shortfall: ${r.placed}/${r.total} placed, ${r.skipped} skipped`)
                             say(`build ended short (${r.placed}/${r.total}, ${r.skipped} skipped) - keeping it saved; "cancelbuild" drops it`) }
```

- The live killer — 0/2350 all-skipped — becomes `pause`: the job survives, and the `pausedAt` stamp
  gives the retry a bounded cadence instead of a hot 2-minute loop.
- A build that finished *minus* genuinely unobtainable materials (the `opts.skip` set,
  schematic.js:735-742) also pauses rather than clears. That is the honest reading of operator
  intent: the schematic is not standing. It retries each `RESUME_HOLD_MS`; the operator ends it with
  `cancelbuild` (or fixes the material and `resumebuild`s). This is a deliberate behavior change
  from today (today it clears and forgets) and is called out in §9.
- **Optional belt-and-braces, `COMPLETE_VERIFY=1` (default off):** before a `clear`, re-run the
  standing-scan autoBuild already performs (commands.js:2488-2503: `schem.getBlock` vs `bot.blockAt`
  over the box) and require 0 missing non-air cells (excluding names in the skip set); any missing →
  `pause`. Off by default because unloaded chunks read as `blockAt === null` and tech blocks can
  never match — it must be observed on the test server before defaulting on.

## 6. Full clear-path audit (every way the persisted build is lost today)

Grep-complete over `clearPersistedResume|resumeJob = null|persistResume|RESUME_FILE` (only
commands.js touches the file; verified nothing else reads/writes it).

| # | Path | Code | Legit? | Change |
|---|---|---|---|---|
| 1 | `stop` command (any channel: `!stop`, directCommand "stop/wait/hold on/stay" index.js:406, `/op/cmd` GUI stop, brain `/cmd` stop when no file exists) | commands.js:1599 `clearPersistedResume()` | **BUG** — destroys operator intent; the brain is instructed to emit `stop` when stuck | stop = pause: keep every other effect, replace the clear with `markResumePaused('operator stop')` (§3) |
| 2 | autobuild settle, "done for real" | commands.js:2107 `if (!r.stopped) clearPersistedResume()` | **BUG** — `!stopped` ≠ finished; blocked/all-skipped runs return `stopped:false` (schematic.js:719, 735-742); cleared the castle live (comment at commands.js:3060-3063) | gate on `finishDisposition(r) === 'clear'`; shortfall → pause (§5) |
| 3 | autobuild error settle | commands.js:2113 `resumeJob = null` (disk file KEPT; re-arm loop restores) | Legit | none |
| 4 | `RESUME_MAX_DEATHS` give-up | commands.js:2975-2984 — keeps the file, drops in-memory job | **Legit — the correct pattern to mirror.** One gap: the 2-min re-arm (index.js:263-274) calls `resumebuild`, which resets `resumeDeaths = 0` (commands.js:2127), so the give-up holds for ~2 min only | stamp `markResumePaused('gave up after N deaths')` at 2983 so the hold is real (`RESUME_HOLD_MS`); flag-gated with the rest |
| 5 | resume settle, "resumed to a real finish" | commands.js:3105-3106 `if (result && !result.stopped) clearPersistedResume()` | **BUG** — same false-done as #2 (unreachable-site is routed to keep via `buildInterrupted = true` at 3077, but an on-site blocked/skipped drain still clears) | same `finishDisposition` gate (§5) |
| 6 | New build overwrites the file | `persistResume` at commands.js:2093 (`autobuild`) and 2951 (`setResumeJob`, from index.js:478) | Legit — one job at a time; a new operator build implicitly replaces the old | none required; optional courtesy chat when overwriting a *different* saved name |
| 7 | Process restart / crash / reboot | file survives; boot auto-resume index.js:241-257 + re-arm 263-274 pick it up | Legit — this is the feature working | both loops honor `pausedAt` (§3) |
| 8 | Deploy / git operations | `bot/resume-job.json` is gitignored (.gitignore:53) → checkout/pull/deploy safe; **`git clean -xdf` or a from-scratch re-clone deletes it** | Ops hazard, not code | note in NOTES.md; for belt-and-braces set `RESUME_FILE` outside the repo in the supervisor env. No code change |
| 9 | `resumebuild` when the schematic file can't reload | commands.js:2124-2125 — returns an error, file kept | Legit | none |
| 10 | Silent persist FAILURE (no file ever written) | `persistResume`'s `catch {}` (commands.js:2958) swallows write errors — disk full/locked means *no protection and no warning* | **Gap** | log via `dbg('persistResume FAILED: ' + e.message)` in the catch (one line) |
| 11 | Transient read error makes the file invisible | `persistedResume` `catch { return null }` (commands.js:2962) — a locked/AV-scanned file momentarily disables every guard keyed on it (index.js:1606, 1648) | Gap (race), previously a real leak window for the destructive stop | Layer 1 makes the worst case harmless (a slipped stop now pauses at most). No further change |
| 12 | `cancelbuild` (new) | §4.3 | Legit — the ONLY intended delete | archive-rename, operator-source + CHEAT_CMDS double gate, two-step confirm |

## 7. Per-file change list

**bot/commands.js**
1. Top: `const STOP_KEEPS_BUILD = process.env.STOP_KEEPS_BUILD !== '0'` and
   `const RESUME_HOLD_MS = parseInt(process.env.RESUME_HOLD_MS || '900000', 10)` (15 min), near
   `RESUME_MAX_DEATHS` (line 175). Module-level `let cancelArmedAt = 0`.
2. `handle (bot, line)` → `handle (bot, line, opts = {})` (commands.js:1033; signature only — no
   behavior change for existing callers).
3. `case 'stop'` (1596-1600): under the flag, replace `clearPersistedResume()` with
   `markResumePaused('operator stop')`; new reply string naming the kept build. `STOP_KEEPS_BUILD=0`
   → today's line verbatim.
4. New `case 'cancelbuild': case 'abandonbuild':` per §4.3 (source check → arm/confirm → halt +
   rename). ~20 lines, next to `case 'resumebuild'`.
5. `case 'resumebuild'` (2118-2132): on success path, rewrite the file without `pausedAt`
   (explicit resume clears the hold).
6. Near `persistResume` (2957): add
   `function markResumePaused (why)` — read file, stamp `pausedAt: Date.now(), pausedWhy: why`,
   write back (all in the existing try/catch style);
   `function resumeHoldRemaining (saved, now)` — pure:
   `saved && saved.pausedAt ? Math.max(0, saved.pausedAt + RESUME_HOLD_MS - now) : 0`;
   `function finishDisposition (r)` — pure, §5. Add a `dbg` line to `persistResume`'s catch (audit #10).
7. Settle sites 2107-2108 and 3105-3107: `finishDisposition` gate per §5 (flag-gated).
8. Give-up at 2983: add `markResumePaused('gave up after ' + resumeDeaths + ' deaths')` before the
   nulls (flag-gated) — mirrors and completes the already-correct keep-on-disk pattern.
9. Exports (3112): add `finishDisposition, resumeHoldRemaining, markResumePaused` (tests) — `handle`
   is already exported.

**bot/index.js**
1. Boot auto-resume (247-255) and re-arm loop (263-274): before calling `resumebuild`, skip while
   `commands.resumeHoldRemaining(commands.persistedResume(), Date.now()) > 0` (log
   `(resume) held (paused Xs ago - 'resumebuild' overrides)` once per state change, not per tick).
2. Source stamps: `{ source: 'operator' }` at 359, 388, 474, 491, 498, 1749; `{ source: 'brain' }`
   at 1657. Lines 251/270/655/912 unchanged.
3. The 1606 stop-hold, busy-hold, one-job hold: **unchanged**.

**bot/access.js**
1. `CHEAT_CMDS` (129): add `cancelbuild|abandonbuild` to the alternation.

**No changes** to schematic.js, brain-llm.js, provision.js, navigate.js, mining.js, arbiter.js,
index-bedrock.js (the bedrock body's `stop` at index-bedrock.js:405 only ends follow — it has no
resume system).

## 8. Flags / env

| Var | Default | Meaning |
|---|---|---|
| `STOP_KEEPS_BUILD` | `1` | Master flag for everything in this design (stop-pause, finish gate, give-up hold, cancelbuild source check). `=0` restores today's behavior at every touched site. `cancelbuild` itself remains available either way (new, harmless). |
| `RESUME_HOLD_MS` | `900000` | Pause hold used by operator stop, shortfall finishes, and death give-up. `0` = resume on next re-arm tick; large = effectively indefinite. |
| `COMPLETE_VERIFY` | `0` | Optional world-scan before a completion clear (§5). Off until observed live. |
| `RESUME_FILE` | `bot/resume-job.json` | Existing (commands.js:2956); tests point it at scratch space. |

## 9. Test plan

**Offline unit suite: `bot/resumetest.js`** (style of miningtest.js/foodtest.js; runs with
`node bot/resumetest.js`; sets `process.env.RESUME_FILE` to a scratch path *before*
`require('./commands.js')`; stub bot = `{ pathfinder: { setGoal(){}, setMovements(){} }, chat(){},
inventory: null, entity: { position: {x:0,y:64,z:0} } }`).

Pure functions:
1. `finishDisposition`: `null → keep`; `{deferred:true} → keep`; `{stopped:true} → keep`;
   `{stopped:false, skipped:5, placed:0, total:2350} → pause` (the live killer);
   `{stopped:false, skipped:0, placed:5, total:5} → clear`; `{stopped:false, skipped:0, placed:0,
   total:0} → clear` (already-standing resume).
2. `resumeHoldRemaining`: no file / no `pausedAt` → 0; fresh pause → >0; expired → 0; malformed
   `pausedAt` → 0 (fail-open to *resume*, the safe direction).

Command behavior (file seeded by writing the JSON directly, same schema as `persistResume`):
3. `stop`, flag on, operator source → file still exists, `pausedAt` stamped, reply names the build.
4. `stop`, `STOP_KEEPS_BUILD=0` → file deleted (regression lock on rollback).
5. `stop` with no file → same reply as today, no file created.
6. `cancelbuild` from `source:'brain'` / no source → refused, file intact.
7. `cancelbuild` operator, unarmed → arm message, file intact; `+ 'confirm'` within window → file
   renamed to `.cancelled`, `resumeJob` nulled; confirm after 60s → re-arms, file intact.
8. `access.CHEAT_CMDS.test('cancelbuild confirm') === true`, `('abandonbuild')` true, `('stop')`
   still false.
9. `resumebuild` on a paused file → `pausedAt` removed from the file.

**Gate (per build-agent light gate memory):** `node --check` on the three files, the new suite, the
existing non-regression suites, then ONE bounded live smoke on the test server (real terrain): plant
a `resume-job.json`, (a) `POST /cmd {"command":"stop"}` → held, file intact; (b) in-game `!stop` →
"stopped (…stays saved…)", file has `pausedAt`, re-arm log shows the hold; (c) `!resumebuild` →
resumes immediately; (d) `!cancelbuild` + `!cancelbuild confirm` → archived. Bail-and-report on any
snag; prove long-horizon behavior on the live bot afterwards with cheap poll watches.

## 10. Risks and non-goals

- **Behavior change: shortfall builds no longer self-clear.** A build that ends with skipped
  materials now stays saved and retries each `RESUME_HOLD_MS` until an operator `cancelbuild`s or it
  completes. Deliberate (operator intent stands until the schematic does), but it can produce
  periodic retry chatter on a build that can never finish. Mitigation: the pause stamp bounds the
  cadence; the chat message tells the operator the exit.
- **Auto-resume after an operator stop** (default 15 min) may surprise an operator who meant
  "abandon". Mitigated by the reply text; `cancelbuild` is the abandon verb; `RESUME_HOLD_MS`
  tunable.
- **The brain still cannot use `stop` to unwedge itself during a saved build** (index.js:1606 hold
  kept). Now that stop is non-destructive, relaxing that hold is attractive — explicitly deferred; a
  brain that can pause a build every heartbeat is its own failure mode.
- **`/op/cmd` is trusted-by-port** (index.js:1739-1741). Anything that can POST to it is "operator",
  including its `cancelbuild`. Unchanged from today's trust model; bind-address hardening is out of
  scope.
- **Not fixed here:** why the brain panics (`armorup failed, need to reset` loops), build
  completion *quality* (skipped-material provisioning), multi-build queueing, moving `RESUME_FILE`
  out of the repo (ops note in audit #8), `COMPLETE_VERIFY` default-on (needs live observation),
  index-bedrock.js parity (no resume system there).
- **Rollback:** `STOP_KEEPS_BUILD=0` restores every touched site to today's behavior; `cancelbuild`
  remains but is inert on a system where `stop` already deletes.
