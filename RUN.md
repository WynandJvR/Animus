# Running Animus on your own server (Java / Microsoft account)

One-time setup, then it's a double-click every time.

## One-time setup

1. **Make sure Ollama has the brain model** (only needed once):
   ```
   ollama pull gemma4:12b
   ```
   And make sure Ollama is running (it usually runs in the background on Windows).

2. **Point the bot at your server** - edit `bot2/config.json`:
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

- **Double-click `Animus.exe`** (in the project root), or run `Animus.exe --start` to open the panel and start
  straight away.

The Animus panel starts and owns both processes:
- **the bot** - connects to your server. **On the very first run** it prints a `microsoft.com/link` code - open that
  link in a browser and enter the code to log the bot's account in (it caches after that).
- **the brain** - the local model that talks and advises.

To stop: press Stop in the panel (closing the panel stops both).

## Driving it in-game

- Just talk to it - say its name and it responds (e.g. "Claudebot, follow me").
- As an operator (your name in `operators`), use `!commands` for the powerful stuff:
  - `!schematic load <url-or-file>` then `!schematic build here` - build a schematic in survival
  - `!provision run` - gather + craft the whole bill of materials from scratch
  - `!come`, `!follow`, `!house oak_planks 9 7 5`, etc.
- Non-operators can chat with it but can't run `!commands`.

## If something's off

- **Bot window closes / never spawns:** wrong host/port/version, or the Microsoft login wasn't finished. Check the BOT window text.
- **Brain does nothing / errors:** Ollama isn't running, or `gemma4:12b` isn't pulled (`ollama pull gemma4:12b`).
- **"not an operator":** add your exact in-game name to `operators` in `bot2/config.json`.
- Prefer the terminal? You can still run the two pieces by hand - see `NOTES.md` §2 (brain env) and §3 (live-server launch).
