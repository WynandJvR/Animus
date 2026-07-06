# Animus — Findings & Operating Notes

Hard-won notes from getting the AI bot running well on this machine + the live server.
Read this before debugging "it's slow / it griefs / it ignores me" again.

---

## 1. Hardware & inference (the core constraint)

- **GPU: RTX 5070 Ti, 16 GB VRAM** — the *only* CUDA-visible GPU.
- **RTX 3070 Ti (8 GB) is NOT used by Ollama** (not exposed to CUDA). Enabling it → 24 GB total, which *would* let 26–32B models run fully on GPU. Not set up.
- Ryzen 5 5600X (6c/12t), 32 GB RAM.
- **Ollama 0.30.10** (upgraded from 0.20.7 — older version couldn't pull newer model manifests).
- Ollama env opts already set (help, but don't change the VRAM ceiling): `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_CONTEXT_LENGTH=32768`.

**Key rule:** at Q4, ~14B is the max that fits **fully on GPU** (fast). 26B/35B (17–27 GB) spill to CPU → **15–45 s/decision = unusable** for a real-time bot. It's a **VRAM-capacity** limit, not GPU speed. Flash-attn / q8-KV shrink the *context*, not the *weights*.

---

## 2. The brain model — what works (THE key discovery)

| Model | Speed (real bot prompts) | Verdict |
|---|---|---|
| `qwen2.5:14b` | ~0.7–1.2 s | fast but dumb — fixates, spams, ignores requests |
| **`qwen3:14b`** | **~0.5–1 s** (thinking OFF) | **winner — fast AND good at natural language** |
| `qwen3:14b` via OpenAI `/v1` | **5–43 s** | thinking can't be disabled there → unusable |
| `gemma4:12b` | ~18–25 s | too slow even though it fits GPU |
| `gemma4:26b` / `qwen3.5:35b-a3b` | 15–45 s | spill to CPU — unusable; fine for *coding* (not real-time) |

**Qwen3 has a hybrid "thinking" mode. It MUST be disabled or it's as slow as the big models.**
The OpenAI-compatible `/v1/chat/completions` endpoint **cannot** turn it off. Ollama's **native `/api/chat` with `think:false`** can.

**Working brain config (env for `brain-llm.js`):**
```
LLM_URL=http://127.0.0.1:11434/api/chat
OLLAMA_NATIVE=1
LLM_MODEL=qwen3:14b
```
(`brain-llm.js` switches request shape + response parsing on `OLLAMA_NATIVE`.)

Reasoning/"thinking" models are the wrong tool for a ~1 s control loop. Avoid them.

---

## 3. Running against a live / online-mode server

(Fill in your own host/ports below — placeholders here so nothing personal is published.)

- Host: **`your-server.example.com`** (or a LAN/tailnet IP like `10.0.0.5`).
- **Java: port `25565`** (typical) — e.g. Paper **1.21.11**, online-mode, crossplay (Geyser+Floodgate), ViaVersion.
- **Bedrock (Geyser): UDP `19132`.**
- **Watch out for a web-map port** (e.g. BlueMap on `8100`) — it is NOT the MC port. Connecting mineflayer there hangs, because it speaks the MC protocol to an HTTP server.
- online-mode → bot needs **`MC_AUTH=microsoft`** (device-code login, first run prints a `microsoft.com/link` code). The bot's Microsoft account must be **op** on the server for `!`build/admin commands.

**Launch the Java body against a live server:**
```
MC_HOST=your-server.example.com MC_PORT=25565 MC_AUTH=microsoft MC_VERSION=1.21.11 node index.js
```
(`index.js` reads `MC_HOST/MC_PORT/MC_USERNAME/MC_AUTH/MC_VERSION`; `MC_VERSION=auto` = autodetect, but if the server disables status/SLP you must pin the version, e.g. `1.21.11`.)

---

## 4. ⚠️ FRAGILE: the mineflayer enchant-crash patch

mineflayer **4.37.1** `lib/plugins/digging.js` (`digTime`) assumes `item.enchants` is an array and calls `.concat` → **`enchantments.concat is not a function`** on 1.21 **enchanted** tools. This crashes any `dig` while holding enchanted gear (the account's diamond tools).

**Patched** by guarding `Array.isArray(...)` on held + helmet enchants.
**NOW DURABLE (2026-06-26):** `index.js` re-applies the guard at spawn via
`installDigTimeGuard(bot)`, which overrides `bot.digTime` (the function `bot.dig`
calls) with an `Array.isArray`-guarded version. This lives in the repo, so a future
`npm install` that wipes the `node_modules/` edit can no longer break tool-use.
(The node_modules edit is now redundant but harmless.) Verified: `break dirt` digs
cleanly with the override installed.

---

## 5. Anti-grief lessons (learned the hard way on the LIVE world)

These were real incidents on the live server — keep them fixed:

- **Pathfinder was digging through builds.** `setupMovements`: `canDig=false`, `allow1by1towers=false`, empty `scafoldingBlocks`, `canOpenDoors=true`. (Tradeoff: it now fails to path into sealed/gapped spots instead of tunneling — intended.)
- **`mine <name>` would hunt down crafted blocks (planks/glass) in builds.** Now: only **natural** blocks (`MINABLE` allowlist, anchored so `polished_*`/`*_bricks`/`raw_*_block` don't leak) are searched far (≤32); **crafted blocks only break if ≤4 blocks away** ("break these planks"). Never falls back to breaking a random looked-at block when a named target isn't found.
- **`say` strips a leading `/`** so a brain reply can't run a server/op command (the bot is op).
- **Brain is confined**: `CHEAT_CMDS` (`give/fill/setblock/clear/wall/tower/house/gamemode/tp`) are blocked on the `POST /cmd` path (operators keep them via in-game `!commands`). No eval/shell/fs anywhere; control API is `127.0.0.1`-only.
- **`AUTO_CREATIVE` off by default** — bot never changes gamemode on its own (it once flipped the account to creative).
- **Combat safety**: never melee/attack **players** (entity-type check, not name), never auto-melee **creepers** (it **flees** them), never melee ghast/warden/wither.

---

## 6. Behavior-tuning lessons

- **"Vary your actions / don't repeat" → fidgeting** (it inserted pointless turn/scan/stop between follows). Replaced with *"calm following or waiting is correct; don't fidget."*
- **Tasks that take time must BLOCK to completion**, or the brain reverts to `follow` mid-task and "runs back." `come`/`goto` now `await pathfinder.goto`; `break` chops the whole tree (cap 8); `hunt` chases (cap ~8 hits). Bounded so the brain isn't frozen too long.
- **Player requests must dominate the prompt** — surfaced loudly at the top of the user message (`unanswered`), delivered for `MAX_DELIVERIES` ticks, else the model under-weights them.
- **Chat: speak only when addressed** (gate on `lastAddressedAt > lastReplyAt`) + cooldown + dedupe — kills random chatter and spam-kicks.
- **Tools ≠ hardcoding.** Commands are the bot's *hands* (every agent has a fixed action set); the *behavior* (when/how) is the brain's, and it's autonomous. Adding commands expands capability, it does not script behavior.
- **Idle change-detector (2026-06-26) — the big efficiency/naturalness win.** The brain used to fire a full LLM inference every tick (~0.5s) even when nothing changed — measured ~100 identical `follow` decisions in 50s while just following someone. Now `brain-llm.js` computes a `signature()` of the SALIENT state (player *names* present, nearest threat bucket, hp/food buckets, day/night, pending-chat count) and, when it's unchanged AND no one's waiting, it **holds the current behaviour and polls cheaply** (`IDLE_POLL_MS=900`) instead of re-deciding — the body keeps executing the active goal (a `follow` keeps tracking a moving player on its own). It still thinks instantly on any real change, on a player chat, or every `IDLE_HEARTBEAT_MS=15000` as a slow heartbeat. Re-measured: ~14 decisions over the same kind of window. Player distance is deliberately left OUT of the signature so a moving follow-target doesn't wake the LLM each step.
- **Don't surface the bot's own name as a target.** `findPlayer()` named-branch now excludes `bot.username`; when *alone* the brain used to read `name:"Claudebot"` + `players:[]` and issue `follow Claudebot` (following itself → idle jitter). Now `follow/come <ownname>` returns "no player", `state` exposes `alone:true`, and the prompt says never follow/come yourself — so alone = it waits calmly.
- **One request → one action.** A pending chat is re-offered for `MAX_DELIVERIES` ticks; that used to make a single "follow me" re-fire ~6×. Now the body clears the pending request as soon as the brain takes a *fulfilling* action (anything except the preparatory perception cmds `scan/find/entities/block/look/state/inventory`), so a "look first, then answer" sequence still completes but "follow me" fires once.
- **Equip-first rule was misfiring.** Asked "what are you holding?", the model would `equip <random item>` first (the prompt's old literal `diamond_shovel` example leaked into the action). Prompt now scopes equip-first to explicit hold/show/equip *requests* and says a "what are you holding?" question is answered straight from `heldItem`.
- **Follow distance.** `GoalFollow` range was `2` → bot crowded the player ("too close"). Now `FOLLOW_RANGE` (default `3`, env-tunable) → measured ~4 blocks while walking, settling ~2.8 standing. Note `GoalFollow` only ever *closes* distance, never backs away, so a player walking into the parked bot is briefly close — inherent, not worth a custom goal. (`hunt` keeps range 2 — it needs to be in melee.)
- **New perception fields the brain can reason on:** `biome` (now actually populated — read from the solid block below, not the air at the feet), `threat` (`{type,dist,flee}` for the nearest hostile, so it can retreat/flee vs. fight instead of relying only on the reflex auto-defend), and `alone`.
- **Persona + "vibe chat" (2026-07-06) — making it feel ALIVE, not just functional.** The SYSTEM prompt now opens with a wild-gamer persona (lowercase, slang, profanity, trash-talk, roasts gameplay; hard line: no slurs / identity hate — also `LLM_TEMP` env, default **0.8**, was 0.3). The old "brain may only speak when addressed" gate is now a **rate-limited budget**: unprompted one-liners pass at most once per `VIBE_CHAT_MS` (default 90s); a quip does NOT count as a reply (doesn't clear pending requests). Lessons re-learned while tuning against qwen3:14b:
  - **Literal strings in the prompt leak into output** (again — see equip-first above). A concrete example sentence for the say format got parroted verbatim; `say "nothing" if null` produced the literal chat line `nothing`. Use placeholders (`say <the words you want>`) and "in your own words" phrasing. Style samples are OK if explicitly marked "never copy verbatim" (dedupe gate backstops).
  - **The model put chat text in `"reason"`** (bare `{"command":"say"}` = says nothing in game) until the prompt spelled out that reason is private and the message goes inside the command.
  - **Persona and accuracy rules fight each other** — any rule worded like "say so plainly" flattens the voice; word accuracy rules as "in your own voice".
  - Verified with 5 realistic prompt scenarios straight at Ollama (reply-to-question, roast-back, action request, threat, idle heartbeat): in-character, valid JSON, correct commands, ~0.5–1s unchanged.

---

## 7. Current capabilities (all natural-language driven via the brain)

perceive (state/scan/find/block/entities/inventory/look) · move (come/goto/follow/stop/turn) ·
remember/forget/waypoints + `goto <name>` (persistent named places, see §9) ·
break|mine (right tool, whole tree, natural-only far / crafted ≤4) · collect (+auto-collect) · plant (replants at last chop spot) ·
place · craft (walks to a table) · hunt (food animals) · sleep/wake · attack/defend (+auto-defend, creeper-flee) ·
eat (+auto-eat) · drop · equip · say · anti-AFK. Operator-only via in-game `!`: build/give/gamemode/tp.

---

## 8. Known limitations / future ideas

- **Can't go to a player it can't see** (vanilla client only knows nearby entity positions). Needs coords, or an op `tpto` (declined — cheat).
- **No strip-mining** — only mines *exposed* ore. "go mine iron" on the surface → "no iron nearby". A real `stripmine` (dig down, branch-mine, follow veins) is a possible future feature.
- **Bedrock body (`index-bedrock.js`) is written but NOT live-tested.** It now has the `CHEAT_CMDS` confinement block on its `/cmd` path (added 2026-06-26, mirrors the Java body), but still lacks auto-eat/auto-defend/anti-AFK.
- Growing the toolset further → use **grammar / tool-calling** (constrained output) so a small model reliably picks from a big menu. (Next up — biggest reliability win for the local model.)
- ~~Make the mineflayer patch durable~~ — DONE (see §4, `installDigTimeGuard`).
- **Auto-torch — DONE as opt-in (2026-06-26, see §9). Leash / stuck-recovery — DONE (2026-06-26, see §9).**

---

## 9. Persistent memory & natural-companion reflexes (2026-06-26)

Borrowed the genuinely-fitting ideas from the wider LLM-Minecraft ecosystem (Mindcraft's always-on "modes", JARVIS-1-style persistent memory) — adapted to this bot's minimal/fast/anti-grief philosophy.

- **Persistent waypoints (`bot/memory.js`).** Named places saved to `bot/memory.json` (gitignored — personal/runtime data), surviving restarts so the bot "knows your world". Commands: `remember <name>` (saves current spot), `forget <name>`, `waypoints` (list), and `goto <name>` walks to one. The state exposes a `waypoints` name list so the brain knows what it can recall; the prompt maps "remember this as home" → `remember home` and "go home" → `goto home`. Verified live: full save/list/goto/forget flow + the unknown-name path.
- **Auto-collect reflex (`index.js`, `AUTO_COLLECT`, default on).** When IDLE (no active pathfinder goal) and a dropped item is within ~8 blocks, the bot walks over and picks it up — tidies up after a chop/hunt with zero brain involvement. Gated on `bot.pathfinder.goal` being null so it **never** yanks itself off a follow/goto. Verified live: an idle bot auto-picked a fresh drop (`cobblestone x8` → `x12`).
  - **Two bugs found & fixed here:** (1) dropped items match by `entity.name === 'item'` — `entity.objectType` is deprecated in this prismarine-entity and spewed a `console.trace` every 3s (flooded the err log to 155 KB). (2) Pickup used `GoalNear(item, 1)`, which can count as "arrived" a block short of the item so the bot never actually touches it (worked before only by luck of where items landed). Now `GoalNear(item, 0)` — walk ONTO the item. **Both fixes also apply to the on-demand `collect` command**, which had the same latent range-1 bug.
- **Leash / stuck-recovery reflex (`index.js`, `LEASH`, default on).** While *following a player*, if the bot stops making progress (`moved < 0.6` per 1.5s tick) while the target is still far (`> 6` blocks), it re-issues the follow goal to kick the pathfinder — recovering from transient give-ups (e.g. the player climbed somewhere it can't path with `canDig=false`). Re-paths at most every ~3s; after ~12s genuinely stuck it logs `(leash) can't reach … — blocked, holding` **once** and stops hammering (the dynamic follow resumes on its own once the target moves somewhere reachable). Only acts on entity-follows (ignores `goto`-to-coords). Verified live: bot followed a watcher who flew 10m up → re-pathed at stuck 2s/6s/9s → "blocked, holding" at 12s.
- **Gaze / attention reflex (`index.js`, `GAZE`, default on) — the biggest "natural player" win so far.** Makes the head behave like a real player's instead of staring into space. Priority each 500ms tick: (1) face an attacker for ~2.5s after being hurt (a hostile at range, or a close player puncher), (2) yield to auto-defend when a hostile is in melee range, (3) make eye contact with whoever just spoke (`recordChat` sets the focus), (4) otherwise track the nearest player / glance at nearby motion. **Yields the head to the pathfinder while walking** (`isMoving()` → pathfinder already aims toward travel) and to a manual `look`/`turn` for 6s (`noteManualLook`). Smooth (`lookAt` force=false, no snapping); LLM-free; doesn't touch goals so it never affects the brain or pathing. Verified live: the bot's yaw tracked a moving watcher to 4 distinct positions (diff ~0.02 rad ≈ 1°) and faced the player after a punch; head stays still when alone (no fidget).
- **Auto-torch reflex (`index.js`, `AUTO_TORCH`, OPT-IN / default OFF).** A companion that lights the way at night — but an autonomous block-placer, so it's off by default and deliberately conservative: only at night (`timeOfDay >= 13000`), only via `commands.placeTorchNearby` which places on a **natural-ground allowlist** (never planks/bricks/wool/glass — never your builds), throttled (`AUTO_TORCH_MS`, default 8s), and skipped if a torch/lantern is already within 6 blocks (no spam). `placeTorchNearby` verifies the block after a `placeBlock` timeout (Paper sometimes doesn't echo the `blockUpdate` even when the torch placed) so it doesn't log a false failure and retry-spam. Verified live: 3 consecutive natural-ground placements; the first place-after-spawn is flaky in mineflayer (one-time), which the 3s reflex cadence rides out.

---

## 10. Schematic building — SURVIVAL, like a real player (2026-07-06)

Goal: paste a schematic link (or point at a local file) and have the bot **build it in survival, by hand**, from materials the player supplies — no `/fill`, `/setblock`, `/give`, creative, tp or fly anywhere. The player provides blocks; when the bot runs short it **pauses and asks for exactly what it needs**, then resumes. This is the [natural-player goal] applied to building.

**Tooling (in `bot/`, versions pinned in package.json):**
- `prismarine-schematic` 1.3.0 — parse `.schem`. **Only reads Sponge v1/v2 + mcedit.**
- `mineflayer-builder` 1.0.1 — we reuse **only its `lib/Build`** class (action ordering, face/orientation math). Its own build loop is **creative-only** (`bot.creative.setInventorySlot`) and unusable for survival — the placement loop is ours (`bot/schematic.js` → `buildSurvival`).
- Compat with mineflayer 4.37.1 / MC 1.21.11 verified statically + with an offline `Build` spike (all internal APIs present: `_placeBlockWithOptions`, `GoalPlaceBlock.getFaceAndRef`, `shapes.getShapeFaceCenters`).

**Download — the key finding:** most schematic sites gate downloads and won't work with "paste a link":
- **`mineschematic.com` does NOT work** — Next.js **Server Action** (`DownloadAction`) behind Cloudflare, no static/presigned `.schem` URL (only thumbnails are pre-signed). Automating it needs a headless browser (rejected — too heavy).
- **`buildingguide.app` WORKS** — serves clean **direct** URLs: `https://buildingguide.app/schematics/<name>.schem` → gzipped-NBT file, `application/octet-stream`, no login/JS. This is the recommended paste-a-link source.
- The `schematic load <url>` command accepts **any DIRECT file URL** (validates gzip `1f8b` / NBT `0a` magic, rejects HTML), so GitHub raw / Discord CDN / Dropbox-direct links also work.

**Sponge v3 adapter (the second key finding):** modern exporters (WorldEdit 7.3+, buildingguide) write **Sponge Schematic v3** — blocks nested under `Blocks.{Palette,Data}`, wrapped in a `Schematic` root — which prismarine-schematic 1.3.0 can't read. `bot/schematic.js` carries a small **v3 reader** (`readSchematic`) that adapts v3 into a prismarine-schematic `Schematic`, resolving block states against the **server** version (1.21.11) so stateIds match what we build on. Falls back to the stock reader for v1/v2/mcedit. Verified: bank.schem (32×14×23, 1606 blocks, 14 types) + barrel-house.schem (24×9×16, 432 blocks) parse with **0 unmapped blocks**.

**Commands (operator-only — in `CHEAT_CMDS`, so the brain can't fetch URLs / build autonomously):**
- `schematic load <url|file>` — download (or read local), parse, cache under `bot/schematics/` (gitignored), report size + **bill of materials** ("Bring me — 432 blocks: 126x stone, 82x spruce_stairs, …").
- `schematic materials` — re-print the BOM.
- `schematic build [here | <x y z>]` — build in survival at the origin. Runs detached (builds take minutes), chats progress every 25 blocks, asks for materials when short, `stop` cancels (sets `buildAbort`).

**Build-mode movement (`buildMovements`):** a temporary `Movements` profile used only during a build — `canDig=false` stays (never breaks existing blocks) but `allow1by1towers=true` + `scafoldingBlocks` (cheap fillers only: dirt/cobble/…) let it pillar/bridge to reach height like a survival player. Restored to the anti-grief profile in a `finally` via `restoreMovements()`.

**STATUS — what's verified vs not:**
- ✅ **VERIFIED offline:** download from buildingguide, v3 + v1/v2 parse on 1.21.11, bill-of-materials, HTML rejection, and the `schematic load`/`materials` command paths through the real dispatcher.
- ✅ **VERIFIED LIVE (2026-07-06)** on a local Paper 1.21.11 test server (superflat, survival, bot fed materials via op `/give`): the bot physically placed a 44-block oak_planks box (4×3×4: floor+walls+roof) **44/44 by hand in survival** — walked to each spot, equipped from real inventory, placed against a face, and **pillared up with dirt to reach the roof**.

**Live-test findings (each fixed/documented):**
1. **Single-pass loop left gaps (38/44).** Blocks that only become reachable after neighbours exist were dropped permanently. **Fixed:** `buildSurvival` now re-computes placeable actions every iteration (adaptive nearest-pick) + a `deferred` set retried after any progress → floor/walls went to 100%.
2. **A racy post-place confirmation made it WORSE (28/44)** — reading `getBlockStateId` immediately after placing raced Paper's block-update and tripped early termination. **Fixed:** trust place-on-no-exception + a 120ms settle delay.
3. **Roof needs scaffolding (0/16 → 16/16).** The bot builds from the ground outside the box and can't reach roof height without **pillaring up**, which needs cheap filler blocks in inventory. `buildMovements.scafoldingBlocks` = dirt/cobble/etc.; with only oak_planks it couldn't climb (0 roof). Give it dirt → it pillars and finishes the roof. **`schematic load` now tells the player to also bring dirt/cobble when the build is >3 tall.**

**Remaining gaps (real, not yet fixed):**
- **Scaffold litter:** ~3 dirt blocks left behind after pillaring — no cleanup pass yet (pathfinder places them internally, so tracking/removing them needs work).
- `dig` actions are skipped → **build site must be pre-cleared/flat.**
- Multi-block / oriented pieces (doors, beds, stairs facing, tall flowers, gravity blocks like sand) **unproven** — the test was single-material full blocks. Next: test a real downloaded house (e.g. buildingguide `barrel-house`, 432 blocks / 8 types incl. stairs+doors+trapdoors).
- **Test harness:** local server in `testserver/` (Paper 1.21.11, :25599, offline-mode, flat, peaceful); op the bot in `ops.json`; run bot with `BRAIN_ALLOW_CHEATS=1` and drive via `curl` to the `:3001` control API (`/cmd`, `/state`). Synthetic test schematic generated at `bot/schematics/testbox.schem`.

[natural-player goal]: the bot should behave indistinguishably from a real human player; believability beats raw capability.
