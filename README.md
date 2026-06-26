# mc-bot-lab

An AI-controllable Minecraft bot that joins a server as its own player, walks
around, and builds things on command. The **body** (the bot) is separate from
the **brain** (what decides). The brain is swappable:

- **Claude** — drives the bot interactively over a small local HTTP API.
- **A local model** (llama.cpp or Ollama) — drives it autonomously, offline.

Same body, same command surface, two brains.

## Architecture

```
            ┌─────────────┐       HTTP control API        ┌──────────────┐
 brain ───► │  index.js   │ ◄──── POST /cmd, GET /state ──│  Claude (curl)│
            │  (the body) │                                │  or you       │
            │  Mineflayer │ ◄──── same API ───────────────│  brain-llm.js │
            └─────┬───────┘                                │  (local model)│
                  │ Minecraft protocol                     └──────────────┘
            ┌─────▼───────┐
            │  MC server  │
            └─────────────┘
```

## Layout

```
mc-bot-lab/
├── testserver/        isolated Paper 1.21.11 test server (localhost, offline-mode, :25599)
│   ├── start.sh       small heap, no pre-touch — won't disturb a live server
│   └── server.properties
├── bot/
│   ├── index.js       the body: Mineflayer + HTTP control API (:3001)
│   ├── index-bedrock.js  alternative body over the Bedrock protocol (Geyser/Floodgate)
│   ├── commands.js    actions + building primitives (wall/tower/house/fill/...)
│   ├── brain-llm.js   optional local-model driver (llama.cpp / Ollama)
│   ├── command.gbnf   llama.cpp grammar — forces valid JSON commands
│   ├── access.js      operator allowlist + "is this addressed to me?" logic
│   └── config.json    host/port/username/operators
├── start-lab.sh       bring the whole lab up (test server + bot)
├── stop-lab.sh        tear it down and free the RAM
└── ctl.sh             shell helper to send commands to the bot
```

## Requirements

- **Node.js 18+** (for the bot).
- **bash** environment for the helper scripts — Linux, macOS, WSL, or Git Bash on
  Windows. `ctl.sh` also uses `curl` and `python3`.
- **A Paper 1.21.11 server jar** for the local test server (not bundled — see below).
- *Optional, for the local-model brain:* [Ollama](https://ollama.com) or
  [llama.cpp](https://github.com/ggerganov/llama.cpp), plus a GPU with enough VRAM
  (~16 GB runs a 14B model well — see [NOTES.md](NOTES.md)).

## Quickstart (local test server)

```bash
# 1) install the bot's dependencies
cd bot && npm install && cd ..

# 2) get a Paper jar for the test server
#    Download a Paper 1.21.11 build from https://papermc.io/downloads/paper
#    and save it as:  testserver/paper-1.21.11-69.jar

# 3) start the isolated test server (offline-mode, 127.0.0.1:25599)
cd testserver && ./start.sh           # leave running in its own terminal; back to root when done
cd ..

# 4) start the bot (joins as "Claudebot")
cd bot && node index.js               # leave running in its own terminal
cd ..

# 5) drive it
./ctl.sh state
./ctl.sh cmd "house oak_planks 9 7 5"
./ctl.sh cmd "tower stone 12 3"
```

In-game you can also type `!house oak_planks` etc. in chat (operators only — see
[In-game players & access](#in-game-players--access)).

### One-command lab

`start-lab.sh` does steps 3–4 for you (starts the test server, waits for it, then
starts the bot, both backgrounded with logs in `logs/`). If the Paper jar is
missing it tells you where to get one, or set `PAPER_JAR_SRC=/path/to/paper.jar`
to copy from a local source:

```bash
./start-lab.sh     # bring the lab up
./ctl.sh state     # drive it
./stop-lab.sh      # tear it down and release the RAM
```

### `ctl.sh` commands

```bash
./ctl.sh state              # full world/self state as JSON
./ctl.sh log                # recent bot log
./ctl.sh health             # liveness check
./ctl.sh cmd "<command>"    # send any command (see the capability list in NOTES.md)
```

Override the target with `BOT_URL` (default `http://127.0.0.1:3001`).

## Local-model brain (autonomous, offline)

The bot can run itself with a local LLM via `brain-llm.js`. With Ollama:

```bash
cd bot && \
  LLM_URL=http://127.0.0.1:11434/api/chat OLLAMA_NATIVE=1 LLM_MODEL=qwen3:14b \
  GOAL="follow the player and build a small house" \
  node brain-llm.js
```

> **Use Ollama's native `/api/chat` with a non-thinking model.** Qwen3's "thinking"
> mode makes each decision take 5–40 s; the OpenAI-compatible `/v1` endpoint can't
> turn it off, but native `/api/chat` (`OLLAMA_NATIVE=1`) sends `think:false` and
> drops it to ~1 s. See [NOTES.md §2](NOTES.md) for the full model comparison and
> hardware notes — this is the single biggest factor in whether the bot feels good.

Or with llama.cpp, using the bundled grammar to force valid JSON commands:

```bash
./llama-server -m your-model-Q4_K_M.gguf --port 8080 --grammar-file bot/command.gbnf
cd bot && LLM_URL=http://127.0.0.1:8080/v1/chat/completions \
  GOAL="follow the player and build a small house" node brain-llm.js
```

## Security

- **Localhost only.** The test server (`:25599`) and the bot control API (`:3001`)
  are bound to `127.0.0.1` and must stay that way. The lab runs **`online-mode=false`**
  with an **op + creative** bot — fine on loopback, trivially abusable if you expose
  those ports to the internet. Don't port-forward them; don't bind to `0.0.0.0`.
- The control API has **no authentication** by design (local dev tool). Anything that
  can reach `:3001` can drive the bot. Keep it local.
- The autonomous brain is confined: world-editing/admin commands
  (`give`/`fill`/`setblock`/`gamemode`/`tp`/build) are blocked on the `POST /cmd`
  path, and `say` strips a leading `/` so a reply can't run a server command.
  Operators keep full access via in-game `!commands`.

## In-game players & access

Players interact with the bot two ways, on **both** bodies:

- **Commands** — type `!<command>` in chat (`!house oak_planks`, `!come`,
  `!follow Steve`, `!tower stone 12`, `!stop`). These run only for **allowlisted
  operators**:

  ```json
  // bot/config.json
  "operators": ["Steve", "Alex"],   // usernames allowed to run !commands
  "floodgatePrefix": "."            // stripped before matching Bedrock names
  ```
  Also overridable with env: `OPERATORS="Steve,Alex"` and `FLOODGATE_PREFIX="."`.
  An **empty list = nobody** can command the bot (locked down by default).

- **Natural conversation** — anyone can talk to the bot by **mentioning its name**
  (or a configured alias): "hey Claudebot, what are you building?". The body
  surfaces these in `/state.unanswered`; the brain (`brain-llm.js`) replies
  in-character with `say`. Requires the brain + a local model running. Replies use
  real chat (no op needed).

## Bedrock body (Geyser/Floodgate servers)

`bot/index-bedrock.js` is an alternative **body** that connects over the
**Bedrock** protocol (e.g. a Java server fronted by Geyser/Floodgate) instead of
Java. It exposes the *same* control API (`:3001`) and command names, so the brain
and `ctl.sh` work against it unchanged — only the body differs.

```bash
# offline (no account) — for a Bedrock/Floodgate server in offline mode
cd bot && MC_HOST=your-server.example.com MC_PORT=19132 node index-bedrock.js

# with a real Microsoft account (prints a device-code link on first run)
cd bot && MC_HOST=your-server.example.com MC_AUTH=microsoft node index-bedrock.js
```

Env: `MC_HOST`, `MC_PORT` (default 19132/UDP), `MC_USERNAME`, `MC_AUTH`
(`offline`|`microsoft`), `BEDROCK_VERSION` (pin if auto-negotiation fails).

**What works vs. what doesn't** — `bedrock-protocol` is low-level (no Mineflayer
world model or pathfinder), so this body is deliberately honest:

| Capability | Bedrock body |
|---|---|
| build / admin (`wall`/`tower`/`house`/`fill`/`setblock`/`give`/`gamemode`/`say`) | ✅ full — sent as server commands |
| movement (`goto`/`come`/`follow`/`stop`) | ✅ teleport-based (`/tp`), not physical |
| self + nearby players/entities (`state`/`entities`) | ✅ tracked from packets |
| block perception (`scan`/`find`/`block`) | ❌ no world model — returns a clear note instead of looping the brain |

For full perception + physical pathfinding, use the Java body (`index.js`); on a
dual Java+Bedrock server the bot can run on Java while you play on Bedrock.

## Running against a live (online-mode) server

The included test server is offline-mode so the bot needs no paid account. To run
against a real online-mode server you need a Microsoft-authenticated account that
is **op** on that server (for build/admin commands):

```bash
cd bot && MC_HOST=your-server.example.com MC_PORT=25565 MC_AUTH=microsoft \
  MC_VERSION=1.21.11 node index.js
```

First run prints a `microsoft.com/link` device code to sign in. `index.js` reads
`MC_HOST` / `MC_PORT` / `MC_USERNAME` / `MC_AUTH` / `MC_VERSION` (`auto` =
autodetect; pin the version if the server disables status pings). See
[NOTES.md §3](NOTES.md) for gotchas (e.g. don't point it at a web-map port).

## Notes

- Building uses `/fill` and `/setblock` (the bot is op+creative on the lab server)
  for reliability; physical block-by-block placement is a later option.
- [NOTES.md](NOTES.md) has the full capability list, behavior-tuning lessons,
  anti-grief rules, and the hardware/model findings.

## License

MIT — see [LICENSE](LICENSE).
