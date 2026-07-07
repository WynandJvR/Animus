# Running Animus on your own server (Java / Microsoft account)

One-time setup, then it's a double-click every time.

## One-time setup

1. **Make sure Ollama has the brain model** (only needed once):
   ```
   ollama pull qwen3:14b
   ```
   And make sure Ollama is running (it usually runs in the background on Windows).

2. **Point the bot at your server** - edit `bot/config.json`:
   ```json
   {
     "host": "your-server-address.com",   // your server's IP or hostname
     "port": 25565,                        // your server's Java port (usually 25565)
     "username": "your-account@email.com", // the Microsoft account the bot logs in as
     "auth": "microsoft",                  // <-- change from "offline" to "microsoft"
     "version": "1.21.11",                 // your server's Minecraft version (or "auto")
     "operators": ["YourInGameName"],      // who may drive it with !commands (your MC name)
     "aliases": ["claude"],
     "controlHost": "127.0.0.1",
     "controlPort": 3001
   }
   ```
   - `operators` = the players allowed to command it in chat with `!` (put YOUR in-game name here).
   - The bot's Microsoft account should be **op** on your server if you want it to run build/admin `!commands`.

## Every time - just launch it

- **Double-click `launch.bat`** (in the project root).

That opens two windows and your **dashboard** in the browser:
- **Animus BOT** - connects to your server. **On the very first run** it prints a `microsoft.com/link` code - open that link in a browser and enter the code to log the bot's account in. (It caches after that, so you only do it once.)
- **Animus BRAIN** - the qwen3:14b brain that drives it.
- **Dashboard** at **http://127.0.0.1:3001** - live status, inventory, chat/activity, a command box, and a **brain switcher** (see below).

To stop: close either window.

## The dashboard (http://127.0.0.1:3001)

Open in any browser (the launcher opens it for you). It shows the bot's live health/food/position/inventory/nearby players, a scrolling activity log, and:
- A **command box** - type any command (full operator power, no restrictions), e.g. `come`, `gather oak_log 10`, `schematic build here`. Quick-action buttons for common ones.
- A **Brain** panel - pick a different **model** from the dropdown (any model you've `ollama pull`ed), edit the **goal**, or toggle the brain **on/off** - all live, no restart. The brain picks up the change on its next tick.

## Driving it in-game

- Just talk to it - say its name and it responds (e.g. "Claudebot, follow me").
- As an operator (your name in `operators`), use `!commands` for the powerful stuff:
  - `!schematic load <url-or-file>` then `!schematic build here` - build a schematic in survival
  - `!provision run` - gather + craft the whole bill of materials from scratch
  - `!come`, `!follow`, `!house oak_planks 9 7 5`, etc.
- Non-operators can chat with it but can't run `!commands`.

## If something's off

- **Bot window closes / never spawns:** wrong host/port/version, or the Microsoft login wasn't finished. Check the BOT window text.
- **Brain does nothing / errors:** Ollama isn't running, or `qwen3:14b` isn't pulled (`ollama pull qwen3:14b`).
- **"not an operator":** add your exact in-game name to `operators` in `bot/config.json`.
- Prefer the terminal? You can still run the two pieces by hand - see `NOTES.md` §2 (brain env) and §3 (live-server launch).
