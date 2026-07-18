# Animus - Findings & Operating Notes

Hard-won notes from getting the AI bot running well on this machine + the live server.
Read this before debugging "it's slow / it griefs / it ignores me" again.

---

## 1. Hardware & inference (the core constraint)

- **GPU: RTX 5070 Ti, 16 GB VRAM** - the *only* CUDA-visible GPU.
- **RTX 3070 Ti (8 GB) is NOT used by Ollama** (not exposed to CUDA). Enabling it → 24 GB total, which *would* let 26-32B models run fully on GPU. Not set up.
- Ryzen 5 5600X (6c/12t), 32 GB RAM.
- **Ollama 0.30.10** (upgraded from 0.20.7 - older version couldn't pull newer model manifests).
- Ollama env opts already set (help, but don't change the VRAM ceiling): `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_CONTEXT_LENGTH=32768`.

**Key rule:** at Q4, ~14B is the max that fits **fully on GPU** (fast). 26B/35B (17-27 GB) spill to CPU → **15-45 s/decision = unusable** for a real-time bot. It's a **VRAM-capacity** limit, not GPU speed. Flash-attn / q8-KV shrink the *context*, not the *weights*.

---

## 2. The brain model - what works (THE key discovery)

| Model | Speed (real bot prompts) | Verdict |
|---|---|---|
| `qwen2.5:14b` | ~0.7-1.2 s | fast but dumb - fixates, spams, ignores requests |
| **`qwen3:14b`** | **~0.5-1 s** (thinking OFF) | **winner - fast AND good at natural language** |
| `qwen3:14b` via OpenAI `/v1` | **5-43 s** | thinking can't be disabled there → unusable |
| `gemma4:12b` | ~18-25 s | too slow even though it fits GPU |
| `gemma4:26b` / `qwen3.5:35b-a3b` | 15-45 s | spill to CPU - unusable; fine for *coding* (not real-time) |

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

(Fill in your own host/ports below - placeholders here so nothing personal is published.)

- Host: **`your-server.example.com`** (or a LAN/tailnet IP like `10.0.0.5`).
- **Java: port `25565`** (typical) - e.g. Paper **1.21.11**, online-mode, crossplay (Geyser+Floodgate), ViaVersion.
- **Bedrock (Geyser): UDP `19132`.**
- **Watch out for a web-map port** (e.g. BlueMap on `8100`) - it is NOT the MC port. Connecting mineflayer there hangs, because it speaks the MC protocol to an HTTP server.
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

These were real incidents on the live server - keep them fixed:

- **Pathfinder was digging through builds.** `setupMovements`: `canDig=false`, `allow1by1towers=false`, empty `scafoldingBlocks`, `canOpenDoors=true`. (Tradeoff: it now fails to path into sealed/gapped spots instead of tunneling - intended.)
- **`mine <name>` would hunt down crafted blocks (planks/glass) in builds.** Now: only **natural** blocks (`MINABLE` allowlist, anchored so `polished_*`/`*_bricks`/`raw_*_block` don't leak) are searched far (≤32); **crafted blocks only break if ≤4 blocks away** ("break these planks"). Never falls back to breaking a random looked-at block when a named target isn't found.
- **`say` strips a leading `/`** so a brain reply can't run a server/op command (the bot is op).
- **Brain is confined**: `CHEAT_CMDS` (`give/fill/setblock/clear/wall/tower/house/gamemode/tp`) are blocked on the `POST /cmd` path (operators keep them via in-game `!commands`). No eval/shell/fs anywhere; control API is `127.0.0.1`-only.
- **`AUTO_CREATIVE` off by default** - bot never changes gamemode on its own (it once flipped the account to creative).
- **Combat safety**: never melee/attack **players** (entity-type check, not name), never auto-melee **creepers** (it **flees** them), never melee ghast/warden/wither.

---

## 6. Behavior-tuning lessons

- **"Vary your actions / don't repeat" → fidgeting** (it inserted pointless turn/scan/stop between follows). Replaced with *"calm following or waiting is correct; don't fidget."*
- **Tasks that take time must BLOCK to completion**, or the brain reverts to `follow` mid-task and "runs back." `come`/`goto` now `await pathfinder.goto`; `break` chops the whole tree (cap 8); `hunt` chases (cap ~8 hits). Bounded so the brain isn't frozen too long.
- **Player requests must dominate the prompt** - surfaced loudly at the top of the user message (`unanswered`), delivered for `MAX_DELIVERIES` ticks, else the model under-weights them.
- **Chat: speak only when addressed** (gate on `lastAddressedAt > lastReplyAt`) + cooldown + dedupe - kills random chatter and spam-kicks.
- **Tools ≠ hardcoding.** Commands are the bot's *hands* (every agent has a fixed action set); the *behavior* (when/how) is the brain's, and it's autonomous. Adding commands expands capability, it does not script behavior.
- **Idle change-detector (2026-06-26) - the big efficiency/naturalness win.** The brain used to fire a full LLM inference every tick (~0.5s) even when nothing changed - measured ~100 identical `follow` decisions in 50s while just following someone. Now `brain-llm.js` computes a `signature()` of the SALIENT state (player *names* present, nearest threat bucket, hp/food buckets, day/night, pending-chat count) and, when it's unchanged AND no one's waiting, it **holds the current behaviour and polls cheaply** (`IDLE_POLL_MS=900`) instead of re-deciding - the body keeps executing the active goal (a `follow` keeps tracking a moving player on its own). It still thinks instantly on any real change, on a player chat, or every `IDLE_HEARTBEAT_MS=40000` as a slow heartbeat. Re-measured: ~14 decisions over the same kind of window. Player distance is deliberately left OUT of the signature so a moving follow-target doesn't wake the LLM each step.
- **Don't surface the bot's own name as a target.** `findPlayer()` named-branch now excludes `bot.username`; when *alone* the brain used to read `name:"Claudebot"` + `players:[]` and issue `follow Claudebot` (following itself → idle jitter). Now `follow/come <ownname>` returns "no player", `state` exposes `alone:true`, and the prompt says never follow/come yourself - so alone = it waits calmly.
- **One request → one action.** A pending chat is re-offered for `MAX_DELIVERIES` ticks; that used to make a single "follow me" re-fire ~6×. Now the body clears the pending request as soon as the brain takes a *fulfilling* action (anything except the preparatory perception cmds `scan/find/entities/block/look/state/inventory`), so a "look first, then answer" sequence still completes but "follow me" fires once.
- **Equip-first rule was misfiring.** Asked "what are you holding?", the model would `equip <random item>` first (the prompt's old literal `diamond_shovel` example leaked into the action). Prompt now scopes equip-first to explicit hold/show/equip *requests* and says a "what are you holding?" question is answered straight from `heldItem`.
- **Follow distance.** `GoalFollow` range was `2` → bot crowded the player ("too close"). Now `FOLLOW_RANGE` (default `3`, env-tunable) → measured ~4 blocks while walking, settling ~2.8 standing. Note `GoalFollow` only ever *closes* distance, never backs away, so a player walking into the parked bot is briefly close - inherent, not worth a custom goal. (`hunt` keeps range 2 - it needs to be in melee.)
- **New perception fields the brain can reason on:** `biome` (now actually populated - read from the solid block below, not the air at the feet), `threat` (`{type,dist,flee}` for the nearest hostile, so it can retreat/flee vs. fight instead of relying only on the reflex auto-defend), and `alone`.
- **Persona + "vibe chat" (2026-07-06) - making it feel ALIVE, not just functional.** The SYSTEM prompt now opens with a wild-gamer persona (lowercase, slang, profanity, trash-talk, roasts gameplay; hard line: no slurs / identity hate - also `LLM_TEMP` env, default **0.6**, was 0.3 then 0.8). The old "brain may only speak when addressed" gate is now a **rate-limited budget**: unprompted one-liners pass at most once per `VIBE_CHAT_MS` (default 10 min); a quip does NOT count as a reply (doesn't clear pending requests). Lessons re-learned while tuning against qwen3:14b:
  - **Literal strings in the prompt leak into output** (again - see equip-first above). A concrete example sentence for the say format got parroted verbatim; `say "nothing" if null` produced the literal chat line `nothing`. Use placeholders (`say <the words you want>`) and "in your own words" phrasing. Style samples are OK if explicitly marked "never copy verbatim" (dedupe gate backstops).
  - **The model put chat text in `"reason"`** (bare `{"command":"say"}` = says nothing in game) until the prompt spelled out that reason is private and the message goes inside the command.
  - **Persona and accuracy rules fight each other** - any rule worded like "say so plainly" flattens the voice; word accuracy rules as "in your own voice".
  - Verified with 5 realistic prompt scenarios straight at Ollama (reply-to-question, roast-back, action request, threat, idle heartbeat): in-character, valid JSON, correct commands, ~0.5-1s unchanged.

---

## 7. Current capabilities (all natural-language driven via the brain)

perceive (state/scan/find/block/entities/inventory/look) · move (come/goto/follow/stop/turn) ·
remember/forget/waypoints + `goto <name>` (persistent named places, see §9) ·
break|mine (right tool, whole tree, natural-only far / crafted ≤4) · collect (+auto-collect) · plant (replants at last chop spot) ·
place · craft (walks to a table) · hunt (food animals) · sleep/wake · attack/defend (+auto-defend, creeper-flee) ·
eat (+auto-eat) · drop · equip · say · anti-AFK. Operator-only via in-game `!`: build/give/gamemode/tp.

---

## 8. Known limitations / future ideas

- **Can't go to a player it can't see** (vanilla client only knows nearby entity positions). Needs coords, or an op `tpto` (declined - cheat).
- ~~**No strip-mining**~~ - SHIPPED. `bot/mining.js` holds the pure depth model, descent-safety classification and branch-mine geometry; `provision.js` `branchMine()`/`digStaircaseDown()` drive it, and mines are remembered in world-memory so the bot re-enters an existing staircase instead of re-descending.
- **Bedrock body (`index-bedrock.js`) is written but NOT live-tested.** It now has the `CHEAT_CMDS` confinement block on its `/cmd` path (added 2026-06-26, mirrors the Java body), but still lacks auto-eat/auto-defend/anti-AFK.
- Growing the toolset further → use **grammar / tool-calling** (constrained output) so a small model reliably picks from a big menu. (Next up - biggest reliability win for the local model.)
- ~~Make the mineflayer patch durable~~ - DONE (see §4, `installDigTimeGuard`).
- **Auto-torch - DONE as opt-in (2026-06-26, see §9). Leash / stuck-recovery - DONE (2026-06-26, see §9).**

---

## 9. Persistent memory & natural-companion reflexes (2026-06-26)

Borrowed the genuinely-fitting ideas from the wider LLM-Minecraft ecosystem (Mindcraft's always-on "modes", JARVIS-1-style persistent memory) - adapted to this bot's minimal/fast/anti-grief philosophy.

- **Persistent waypoints (`bot/memory.js`).** Named places saved to `bot/memory.json` (gitignored - personal/runtime data), surviving restarts so the bot "knows your world". Commands: `remember <name>` (saves current spot), `forget <name>`, `waypoints` (list), and `goto <name>` walks to one. The state exposes a `waypoints` name list so the brain knows what it can recall; the prompt maps "remember this as home" → `remember home` and "go home" → `goto home`. Verified live: full save/list/goto/forget flow + the unknown-name path.
- **Auto-collect reflex (`index.js`, `AUTO_COLLECT`, default on).** When IDLE (no active pathfinder goal) and a dropped item is within ~8 blocks, the bot walks over and picks it up - tidies up after a chop/hunt with zero brain involvement. Gated on `bot.pathfinder.goal` being null so it **never** yanks itself off a follow/goto. Verified live: an idle bot auto-picked a fresh drop (`cobblestone x8` → `x12`).
  - **Two bugs found & fixed here:** (1) dropped items match by `entity.name === 'item'` - `entity.objectType` is deprecated in this prismarine-entity and spewed a `console.trace` every 3s (flooded the err log to 155 KB). (2) Pickup used `GoalNear(item, 1)`, which can count as "arrived" a block short of the item so the bot never actually touches it (worked before only by luck of where items landed). Now `GoalNear(item, 0)` - walk ONTO the item. **Both fixes also apply to the on-demand `collect` command**, which had the same latent range-1 bug.
- **Leash / stuck-recovery reflex (`index.js`, `LEASH`, default on).** While *following a player*, if the bot stops making progress (`moved < 0.6` per 1.5s tick) while the target is still far (`> 6` blocks), it re-issues the follow goal to kick the pathfinder - recovering from transient give-ups (e.g. the player climbed somewhere it can't path with `canDig=false`). Re-paths at most every ~3s; after ~12s genuinely stuck it logs `(leash) can't reach … - blocked, holding` **once** and stops hammering (the dynamic follow resumes on its own once the target moves somewhere reachable). Only acts on entity-follows (ignores `goto`-to-coords). Verified live: bot followed a watcher who flew 10m up → re-pathed at stuck 2s/6s/9s → "blocked, holding" at 12s.
- **Gaze / attention reflex (`index.js`, `GAZE`, default on) - the biggest "natural player" win so far.** Makes the head behave like a real player's instead of staring into space. Priority each 500ms tick: (1) face an attacker for ~2.5s after being hurt (a hostile at range, or a close player puncher), (2) yield to auto-defend when a hostile is in melee range, (3) make eye contact with whoever just spoke (`recordChat` sets the focus), (4) otherwise track the nearest player / glance at nearby motion. **Yields the head to the pathfinder while walking** (`isMoving()` → pathfinder already aims toward travel) and to a manual `look`/`turn` for 6s (`noteManualLook`). Smooth (`lookAt` force=false, no snapping); LLM-free; doesn't touch goals so it never affects the brain or pathing. Verified live: the bot's yaw tracked a moving watcher to 4 distinct positions (diff ~0.02 rad ≈ 1°) and faced the player after a punch; head stays still when alone (no fidget).
- **Auto-torch reflex (`index.js`, `AUTO_TORCH`, OPT-IN / default OFF).** A companion that lights the way at night - but an autonomous block-placer, so it's off by default and deliberately conservative: only at night (`timeOfDay >= 13000`), only via `commands.placeTorchNearby` which places on a **natural-ground allowlist** (never planks/bricks/wool/glass - never your builds), throttled (`AUTO_TORCH_MS`, default 8s), and skipped if a torch/lantern is already within 6 blocks (no spam). `placeTorchNearby` verifies the block after a `placeBlock` timeout (Paper sometimes doesn't echo the `blockUpdate` even when the torch placed) so it doesn't log a false failure and retry-spam. Verified live: 3 consecutive natural-ground placements; the first place-after-spawn is flaky in mineflayer (one-time), which the 3s reflex cadence rides out.

---

## 10. Schematic building - SURVIVAL, like a real player (2026-07-06)

Goal: paste a schematic link (or point at a local file) and have the bot **build it in survival, by hand**, from materials the player supplies - no `/fill`, `/setblock`, `/give`, creative, tp or fly anywhere. The player provides blocks; when the bot runs short it **pauses and asks for exactly what it needs**, then resumes. This is the [natural-player goal] applied to building.

**Tooling (in `bot/`, versions pinned in package.json):**
- `prismarine-schematic` 1.3.0 - parse `.schem`. **Only reads Sponge v1/v2 + mcedit.**
- `mineflayer-builder` 1.0.1 - we reuse **only its `lib/Build`** class (action ordering, face/orientation math). Its own build loop is **creative-only** (`bot.creative.setInventorySlot`) and unusable for survival - the placement loop is ours (`bot/schematic.js` → `buildSurvival`).
- Compat with mineflayer 4.37.1 / MC 1.21.11 verified statically + with an offline `Build` spike (all internal APIs present: `_placeBlockWithOptions`, `GoalPlaceBlock.getFaceAndRef`, `shapes.getShapeFaceCenters`).

**Download - the key finding:** most schematic sites gate downloads and won't work with "paste a link":
- **`mineschematic.com` does NOT work** - Next.js **Server Action** (`DownloadAction`) behind Cloudflare, no static/presigned `.schem` URL (only thumbnails are pre-signed). Automating it needs a headless browser (rejected - too heavy).
- **`buildingguide.app` WORKS** - serves clean **direct** URLs: `https://buildingguide.app/schematics/<name>.schem` → gzipped-NBT file, `application/octet-stream`, no login/JS. This is the recommended paste-a-link source.
- The `schematic load <url>` command accepts **any DIRECT file URL** (validates gzip `1f8b` / NBT `0a` magic, rejects HTML), so GitHub raw / Discord CDN / Dropbox-direct links also work.

**Sponge v3 adapter (the second key finding):** modern exporters (WorldEdit 7.3+, buildingguide) write **Sponge Schematic v3** - blocks nested under `Blocks.{Palette,Data}`, wrapped in a `Schematic` root - which prismarine-schematic 1.3.0 can't read. `bot/schematic.js` carries a small **v3 reader** (`readSchematic`) that adapts v3 into a prismarine-schematic `Schematic`, resolving block states against the **server** version (1.21.11) so stateIds match what we build on. Falls back to the stock reader for v1/v2/mcedit. Verified: bank.schem (32×14×23, 1606 blocks, 14 types) + barrel-house.schem (24×9×16, 432 blocks) parse with **0 unmapped blocks**.

**Commands (operator-only - in `CHEAT_CMDS`, so the brain can't fetch URLs / build autonomously):**
- `schematic load <url|file>` - download (or read local), parse, cache under `bot/schematics/` (gitignored), report size + **bill of materials** ("Bring me - 432 blocks: 126x stone, 82x spruce_stairs, …").
- `schematic materials` - re-print the BOM.
- `schematic build [here | <x y z>]` - build in survival at the origin. Runs detached (builds take minutes), chats progress every 25 blocks, asks for materials when short, `stop` cancels (sets `buildAbort`).

**Build-mode movement (`buildMovements`):** a temporary `Movements` profile used only during a build - `canDig=false` stays (never breaks existing blocks) but `allow1by1towers=true` + `scafoldingBlocks` (cheap fillers only: dirt/cobble/…) let it pillar/bridge to reach height like a survival player. Restored to the anti-grief profile in a `finally` via `restoreMovements()`.

**STATUS - what's verified vs not:**
- ✅ **VERIFIED offline:** download from buildingguide, v3 + v1/v2 parse on 1.21.11, bill-of-materials, HTML rejection, and the `schematic load`/`materials` command paths through the real dispatcher.
- ✅ **VERIFIED LIVE (2026-07-06)** on a local Paper 1.21.11 test server (superflat, survival, bot fed materials via op `/give`): the bot physically placed a 44-block oak_planks box (4×3×4: floor+walls+roof) **44/44 by hand in survival** - walked to each spot, equipped from real inventory, placed against a face, and **pillared up with dirt to reach the roof**.

**Live-test findings (each fixed/documented):**
1. **Single-pass loop left gaps (38/44).** Blocks that only become reachable after neighbours exist were dropped permanently. **Fixed:** `buildSurvival` now re-computes placeable actions every iteration (adaptive nearest-pick) + a `deferred` set retried after any progress → floor/walls went to 100%.
2. **A racy post-place confirmation made it WORSE (28/44)** - reading `getBlockStateId` immediately after placing raced Paper's block-update and tripped early termination. **Fixed:** trust place-on-no-exception + a 120ms settle delay.
3. **Roof needs scaffolding (0/16 → 16/16).** The bot builds from the ground outside the box and can't reach roof height without **pillaring up**, which needs cheap filler blocks in inventory. `buildMovements.scafoldingBlocks` = dirt/cobble/etc.; with only oak_planks it couldn't climb (0 roof). Give it dirt → it pillars and finishes the roof. **`schematic load` now tells the player to also bring dirt/cobble when the build is >3 tall.**

**Remaining gaps (real, not yet fixed):**
- **Scaffold litter:** ~3 dirt blocks left behind after pillaring - no cleanup pass yet (pathfinder places them internally, so tracking/removing them needs work).
- `dig` actions are skipped → **build site must be pre-cleared/flat.**
- Multi-block / oriented pieces (doors, beds, stairs facing, tall flowers, gravity blocks like sand) **unproven** - the test was single-material full blocks. Next: test a real downloaded house (e.g. buildingguide `barrel-house`, 432 blocks / 8 types incl. stairs+doors+trapdoors).
- **Test harness:** local server in `testserver/` (Paper 1.21.11, :25599, offline-mode, flat, peaceful); op the bot in `ops.json`; run bot with `BRAIN_ALLOW_CHEATS=1` and drive via `curl` to the `:3001` control API (`/cmd`, `/state`). Synthetic test schematic generated at `bot/schematics/testbox.schem`.
- **Pathfinder `goto(GoalPlaceBlock)` can hang FOREVER** on an unresolvable goal - froze a 432-block build at 50 for 10+ min. **Fixed:** `gotoWithTimeout` (20s race + `setGoal(null)`) in schematic.js + provision.js.

---

## 11. Self-sufficient provisioning - build from NOTHING (2026-07-07)

**MILESTONE: the wilderness MVP works.** An empty-handed bot on normal terrain (savanna, new world `world-gather`) **chopped its own oak (11 logs by fist), crafted its own 44 planks, gathered its own scaffold dirt, and built the 4×3×4 testbox - 44/44 verified block-by-block in the world** (2 dirt litter). This is the first full run of the [natural-player goal] end state: give it a schematic, it does the rest.

**New module `bot/provision.js`:**
- `planProvision(mcData, bom, inventory)` - pure/offline-testable planner: expands recipe chains via minecraft-data (stairs←planks←logs; result counts honored), knows **smelt-only** outputs (`SMELT_MAP`: glass←sand, stone←cobblestone…), **gatherable** raws (`GATHER_SOURCES`: logs/dirt/sand/cobblestone-from-stone…), uses stock first, prefers recipe variants whose ingredients are already in the plan (else one craft drags in a new wood type), plans a crafting_table when any recipe is 3×3. Reports honest `unobtainable` (e.g. stripped logs - axe-stripping not implemented).
- `runGather` - quantity-driven gathering with **gather-mode Movements**: may break **ONLY leaves** (canDig=true + blocksCantBreak=everything-except-leaves - punches through canopies like a player), `maxDropDown=8` (hops off ledges/plateaus), per-position **failure blacklist** (findable-but-unreachable block otherwise loops forever), chops whole trees, walks onto drops.
- `runCraft` - crafts **ONE recipe per call + 250ms settle** and re-counts. ⚠️ **Batched `bot.craft(recipe, N)` DESYNCS the client inventory** - verified live: 11 logs "became" 96 planks in the client view; the ghosts vanish on the next real slot update (that's why a previous run's planks "disappeared" - they were real server-side, invisible client-side). Crafts table-recipes at a table it finds/crafts/places (`ensureTable`).
- `runPlan` - executes gather→smelt(→reported unsupported)→craft in order, chats progress, honest per-task results.

**Commands:** `gather <item> [count≤64]` (brain-accessible, capped - natural-player action) · `provision [run]` (operator-only in `CHEAT_CMDS`) - plans/executes the loaded schematic's whole BOM **plus auto-included scaffold dirt** (8+2·height when height>2; verified: without dirt the roof of even a 3-tall box is unreachable → 28/44; with it 44/44).

**More live-found bugs fixed:** stale `buildAbort` from a previous `stop` instantly aborting fresh gathers (now reset per command) · **auto-collect reflex stealing the bot mid-provision** (wandered 46 blocks chasing leaf drops while "idle" during crafting) - reflexes now respect `commands.isBusy()` (building‖provisioning).

### Planner v2 + smelt/strip/tools - the FULL tech tree (2026-07-07)

Provisioning now covers the whole survival tech tree. **Verified live end-to-end**: an empty bot (given nothing but the schematic) chopped oak → crafted planks/table/sticks/**pickaxe+axe** → mined its own cobblestone → crafted a **furnace** → **smelted** 9 stone + 1 glass → **stripped** a log → crafted stairs → **built the structure (11/12, self-made materials placed correctly)**. Every material made from scratch.

- **Planner v2:** tool-gating (`GATHER_TOOL`: cobblestone REQUIRES a pickaxe - stone mined bare-handed drops NOTHING); **multiple pickaxes** for durability (`ceil(cobble/50)`; one wooden pickaxe = 59 blocks, verified it broke mid-job); **furnace + plank fuel** (`ITEMS_PER_PLANK=1.5`) planned once for all smelts; **strip** transform (`STRIP_MAP`: stripped_X_log ← place X_log, axe it, mine it); tech-tree **phase ordering** (wood→basics/tools→stone/other→furnace→smelt→strip→finals); a **primaryWood** pick so generic wood needs (table/sticks/tools/fuel) converge on the build's dominant tree instead of dragging in cherry/bamboo.
- **Executors:** `runSmelt` (ensureFurnace, load input+fuel, wait), `runStrip` (place→activateBlock→dig), tool-aware `runGather` (right tool per block; **local cluster-mining** so drops land at feet + a **mined-blocks cap** so lost drops don't make it quarry a mountain until the tool breaks).
- ⚠️ **THE furnace gotcha (cost hours):** on 1.21.11 the smelted output lands in **window slot 6**, but `furnace.outputItem()`/`takeOutput()` read slot 2 → always empty. AND while a furnace window is OPEN, `bot.inventory` is **stale**. Fix: count output by summing the item across the live `furnace.slots`, not `countItem`. `takeOutput()` also throws "falsy value" when it thinks the slot's empty - call it defensively.
- **Site prep + scaffold cleanup** (`schematic.js`): `prepSite` clears vegetation (CLEARABLE regex, natural only) from the footprint; `cleanupScaffold` diffs a pre-build snapshot to pull down dirt/cobble it pillared with. ⚠️ prepSite does NOT level terrain - an origin buried in a hillside still fails (0/12 on sloped granite; the footprint must be air). **Uneven-site leveling is still unsolved.**

**LLM brain re-verified with all this added (2026-07-07):** ran `brain-llm.js` (qwen3:14b, native, 100% GPU) against the confined bot. Sub-second warm decisions (582-781ms), answered chat naturally + **accurately** ("holding a wooden axe" = true from heldItem), pursued its wood-gathering goal, idle-held without fidgeting, and stayed **confined** - `provision`/`schematic build` blocked ("operator-only"), `gather` allowed. The new commands don't destabilize the brain loop.

### Grand test: barrel-house-from-nothing WITH the brain connected (2026-07-07)

Ran the full 430-block acacia barrel-house (spruce remapped to acacia - savanna has no spruce; offset-based palette remap in a throwaway `barrel-acacia.schem`) from nothing, with the LLM brain connected and an **operator ("Steve") triggering** `!provision run` via in-game chat. **Brain + long autonomous build coexist cleanly** - added a guard in index.js: while `commands.isBusy()` the brain's `/cmd` movement commands return "busy building - holding" (only perception + `say` + `stop` pass), so the brain never fights the body; it just chats (throttled, in-character - quipped *"fine, but you're paying for this nightmare"*). **This is the headline: the product works as a whole - brain personality layered over a deterministic multi-hour build.**

Provisioning got far: **gathered 186 acacia logs (~31 min), crafted 456 planks, crafted tools + 3 pickaxes**, before two issues:
- **Pickaxe-durability bug (FIXED):** a *worn leftover* pickaxe broke after 4 cobble because the spare-pickaxe planning only fired for freshly-crafted pickaxes. Fix: `planProvision` now zeroes `avail.wooden_pickaxe` and crafts `ceil(cobble/50)` FRESH pickaxes regardless of (possibly-worn) inventory ones. Verified: re-plan crafted 3.
- **Full completion NOT reached** - cobble gathering stalled near the build site because the **operator-filled stone platform interfered with the gather** (the bot mined platform stone and the cobble drops fell into the cleared-air gap below, uncollected). Compounded by the general terrain-sensitivity. Stopped there.

**Verdict:** the from-nothing pipeline is proven at scale (186 logs → 456 planks → tools → pickaxes) and every component is individually verified (provtest built 11/12 from true nothing); brain coexistence is proven. The **full 430-block single run is bottlenecked by terrain-sensitive gathering** (no exploration; drops lost on artificial/uneven terrain; must be near resources) - the real next-step work, not a pipeline gap.

### Gather robustness - exploration + drop-loss recovery (2026-07-07)

Directly addressed the grand-test bottleneck. `gatherLoop` (provision.js) upgrades:
- **Exploration:** when nothing's reachable within 64 blocks, instead of giving up it `explore()`s - walks ~48 blocks in a rotating compass direction (`GoalNearXZ`, 30s timeout) to load fresh chunks, bounded by `MAX_EXPLORE=20` dry wanders before truly failing. Turns "no reachable X" stalls into "keep looking."
- **Lost-drop relocation:** if it breaks blocks but gains NO items (drops falling into gaps/void - the exact platform-edge failure from the grand test), it blacklists the spot and relocates after `NO_YIELD_LIMIT=10` wasted breaks, rather than grinding until the tool breaks.
- **Persistent collection:** `collectDrops` now waits for drops to settle (250ms) and sweeps up to 20 times.
- **VERIFIED LIVE:** `gather acacia_log 60` on the cratered savanna → **60/60, bot roamed ~140 blocks** cluster-to-cluster with ZERO stalls (previously it stalled the whole grand test). Natural roaming (blacklist + moving findBlocks) kept trees within 64 so explicit `explore()` wasn't even needed here, but it's there for barren stretches.

**Remaining:** vertical reachability (trees on cliffs/ledges above a valley the bot dropped into - it can't climb back in gather mode); uneven-site build leveling; oriented-block skips. But **big-scale gathering is now robust** - the grand test's cobble-stall would now self-recover via lost-drop relocation.

**Still open:** occasional single oriented-block (stair) skip; scaffold cleanup relies on a diff (misses blocks pushed >2 outside footprint); food/hunger on very long gathers; and the **full barrel-house-from-nothing single run** (validated in all its components - gather/tools/mine/smelt/strip/build - but a ~1hr end-to-end run needs a spruce biome and un-cratered terrain; deferred, not a code gap). Sparse-biome gathering also needs the bot near resources (64-block search) - no long-range exploration yet.

## 12. Body-brain bridge hardening + self-clearing build sites (2026-07-08)

A Sonnet review of the body-brain bridge (`/state` + `/cmd` + `brain-llm.js`) plus a
fresh end-to-end pass on a local terrain server (`world-gather`, savanna, survival,
empty-handed start - gather→craft→build, no op/give). Verdict: the bridge was sound
(idle change-detector, confinement, "surface the ask loudly" prompt all measured wins);
the real gaps were robustness and site-flatness, not intelligence. Fixed:

**Bridge (verified live):**
- **⚠️ The brain loop could hang FOREVER.** `come`/`goto`/`collect`/craft-walk/sleep all
  called `pathfinder.goto` unguarded, and `brain-llm.js` fetched with no timeout - one
  unreachable target froze the *entire* loop (no backoff, no log). Now `gotoTimed()`
  (commands.js, mirrors schematic's `gotoWithTimeout`) caps all 8 movement verbs, and
  `fetchT()` (AbortController) caps every brain↔body/LLM call (state 10s, cmd/LLM 60s).
  Verified: an unreachable `goto` returns in ~5s instead of hanging.
- **Delivery budget was drained by ANY `/state` poll** (the dashboard's 1s poll expired a
  player's message before the brain answered). Now only the brain's poll - tagged
  `/state?brain=1` - spends the budget. Verified: plain polls hold `unanswered` at 1;
  `?brain=1` polls drain it to 0 after `MAX_DELIVERIES` (6).
- **`clearPendingChat()` cleared ALL pending msgs** when one action answered one → a 2nd
  player's message got dropped. Now resolves the **oldest** only; each gets its own turn.
- **New `/state` fields:** `moving`, `goal` (pathfinder goal type), `busy` (build/provision
  running). The brain now **holds** instead of burning heartbeat inferences while busy
  (logged `body busy - holding` 13× during a build). Trimmed noise the prompt never used:
  `eye`, `yaw`, `pitch`, `onGround`, `blockAtFeet`.
- **Cheaper idle loop:** `/brain` settings polled every 3s + cached (not every tick);
  `decide()` tries `JSON.parse` directly before the greedy `{…}` regex.

**Self-clearing build sites (closes the "sites must be flat" gap):**
- `schematic.clearVolume()` empties the schematic's whole box by hand before building -
  right tool per block (`equipToolFor`: pickaxe/shovel/axe, barehanded fallback), top-down,
  multi-pass (blocks become reachable as those above them go). Scoped to the footprint the
  operator chose; never touches anything outside the box. Exposed as **`schematic clear
  [here|x y z]`** and a **`clear`** flag on build: `schematic build here clear`.
- **GOTCHA (found + fixed live):** the reach test `bot.canDigBlock(b)` must run **after**
  walking to the block, not before - it includes a range check, so testing it first skips
  every out-of-reach block (`cleared 0`). Order it goto→canDigBlock→dig, like `prepSite`.
- **VERIFIED LIVE:** the exact sloped savanna spot that gave **18/44** without clearing now
  builds **43/44** with `build … clear` (cleared 6 intruding blocks, 2 scaffold cleaned) -
  still fully self-provisioned (gathered/crafted its own 44 planks + dirt first).
- Remaining: 1 oriented/floating cell still skipped on steep ground; a smelt-only
  provision plan (glass alone) can pick `cobbled_deepslate` for the furnace and call it
  unobtainable instead of falling back to cobblestone (minor planner variant-choice bug).

## 13. Stone-from-nothing: drowning + cave-descent + clean clearing (2026-07-08)

Pushing the [natural-player goal] onto the FULL mineral tech tree - a `stone` build
from an empty inventory (generated `stonebox.schem` by swapping testbox's palette
oak_planks→stone). This exercises the part the wood builds never did: mine cobblestone
→ craft+fuel a furnace → smelt to stone. It works, but only after fixing three
survival hazards the mining path hit live (all in `provision.js` / `schematic.js`):

- **Drowning (FIXED).** First run: `cobblestone 0/52 (pickaxe broke)` was actually
  `Claudebot drowned` - it mined into water in the cratered savanna and lost the whole
  run (empty inv + spawn respawn). `runGather` now has a breath guard: `breathe()`
  swims up (jump) when `oxygenLevel < 8` and refuses to dig at `<4`; candidates whose
  block-above is water are skipped. Verified: the retry mined all 52 cobble, no death.
- **Cave-descent stranding (FIXED - the "proper" fix, no more tp).** Chasing exposed
  stone, the bot mined DOWN a ravine to y48 and couldn't climb ~30 blocks back (gather
  movements didn't pillar) - the dirt step then failed with "no reachable dirt" because
  it was underground. First time I escaped with an op `tp` (a workaround, not a fix).
  Proper fix, two parts: (1) **depth cap** - tool-required (mining) gathers never target
  stone/ore more than `GATHER_MAX_DEPTH` (default 16) below the highest ground stood on,
  so it won't dive into caves; (2) **pillar-up** - `gatherMovements` now `allow1by1towers`
  + cheap `scafoldingBlocks` (dirt/cobble/stone family) so it can ALWAYS climb back out.
  The net-count gather loop auto-compensates for scaffold it consumes (it over-gathered
  cobble to 82 to still net 52). GOTCHA: cap must be generous (16, not 10) or plateau/mesa
  spawns where surface stone sits ~12 below get "no reachable stone" stalls.
- **Clear destroyed correct cells (FIXED).** `clearVolume` was clearing EVERY solid in
  the box - including cells that already matched the schematic (stone box on stone
  terrain), which the Build planner had skipped - punching permanent holes (a stone run
  came out 25/40). Now it leaves a cell alone when the world block already equals the
  schematic's desired block. Also recall the earlier `canDigBlock`-ordering gotcha (§12):
  walk to the block BEFORE the reach-gated dig test.

**VERIFIED LIVE (2026-07-08), empty inventory → finished stone structure, zero
intervention:** gather oak → craft 2 pickaxes → mine 52 cobble (ended y108 up a mesa,
never trapped) → gather dirt → furnace → smelt 44 stone → walked to a flat spot →
`schematic build here clear` → **44/44 placed, 1 cleared, 3 scaffold cleaned**. No op,
no `/give`, no tp, no drowning, no stranding. The mineral tech tree is now proven clean
end-to-end, same as the wood tech tree.

Env-litter lesson: after ~6 runs the savanna was full of pits/half-builds/pillars and
depleted of oak; a wedged bot in that mess mimicked a movement bug. For a clean run,
reset the bot to a fresh spawn (delete its `world-gather/playerdata/<uuid>.dat*` → it
respawns empty at world spawn). Savanna oak is sparse - the planner still hard-prefers
oak for planks; picking whatever wood is local is a future planner improvement.

[natural-player goal]: the bot should behave indistinguishably from a real human player; believability beats raw capability.
