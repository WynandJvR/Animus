# mc-bot-lab

An AI-controllable Minecraft bot that joins a server as its own player, walks
around, and builds things on command. The **body** (the bot) is separate from
the **brain** (what decides). The brain is swappable:

- **Claude** — drives the bot interactively over a small local HTTP API.
- **A local model** (llama.cpp or Ollama) — drives it autonomously, offline.

Same body, same command surface, two brains.

## Layout

```
mc-bot-lab/
├── testserver/        isolated Paper 1.21.11 test server (localhost, offline-mode, :25599)
│   ├── start.sh       small heap, no pre-touch — does NOT disturb the live server
│   └── server.properties
├── bot/
│   ├── index.js       the body: Mineflayer + HTTP control API (:3001)
│   ├── commands.js    actions + building primitives (wall/tower/house/fill/...)
│   ├── brain-llm.js   optional local-model driver (OpenAI-compatible endpoint)
│   ├── command.gbnf   llama.cpp grammar — forces valid JSON commands
│   └── config.json    host/port/username
├── ctl.sh             shell helper to send commands to the bot
└── .gitignore
```

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

## Run (local test server)

```bash
# 1) start the isolated test server (offline-mode, localhost:25599)
cd testserver && ./start.sh           # leave running in its own terminal

# 2) start the bot (joins as "Claudebot")
cd bot && PATH="$HOME/mc-bot-lab/node/bin:$PATH" node index.js

# 3) drive it
../ctl.sh state
../ctl.sh cmd "house oak_planks 9 7 5"
../ctl.sh cmd "tower stone 12 3"
```

In-game you can also type `!house oak_planks` etc. in chat.

## Local-model brain (llama.cpp)

```bash
# serve a small Gemma with grammar-constrained output
./llama-server -m gemma-3-4b-it-Q4_K_M.gguf --port 8080 --grammar-file bot/command.gbnf

# point the brain at it
cd bot && GOAL="follow the player and build a small house" node brain-llm.js
```

Or Ollama: `LLM_URL=http://127.0.0.1:11434/v1/chat/completions LLM_MODEL=gemma3:4b node brain-llm.js`

## Security

- **Localhost only.** The test server (`:25599`) and the bot control API (`:3001`)
  are bound to `127.0.0.1` and must stay that way. The lab runs **`online-mode=false`**
  with an **op + creative** bot — fine on loopback, trivially abusable if you expose
  those ports to the internet. Don't port-forward them; don't bind to `0.0.0.0`.
- The control API has **no authentication** by design (local dev tool). Anything that
  can reach `:3001` can drive the bot. Keep it local.

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

## In-game players & access

Players interact with the bot two ways, on **both** bodies:

- **Commands** — type `!<command>` in chat (`!house oak_planks`, `!come`, `!follow Steve`,
  `!tower stone 12`, `!stop`). These run only for **allowlisted operators**:

  ```json
  // config.json
  "operators": ["Steve", "Alex"],        // usernames allowed to run !commands
  "floodgatePrefix": "."                  // stripped before matching Bedrock names
  ```
  Also overridable with env: `OPERATORS="Steve,Alex"` and `FLOODGATE_PREFIX="."`.
  An **empty list = nobody** can command the bot (locked down by default).
  Non-operators' `!commands` are ignored.

- **Natural conversation** — anyone can talk to the bot by **mentioning its name**
  ("hey Claudebot, what are you building?"). The body surfaces such messages in
  `/state.unanswered`; the brain (`brain-llm.js`) replies in-character with `say`.
  Requires the brain + a local model running. Replies use real chat (no op needed).

## Notes

- The test server is **offline-mode** so the bot needs no paid account. To run
  against the live (online-mode) server you need either a second Java account,
  or a Bedrock bot via Floodgate (free, more work).
- Building uses `/fill` and `/setblock` (the bot is op+creative on the lab
  server) for reliability. Physical block-by-block placement is a later option.

## License

MIT — see [LICENSE](LICENSE).
