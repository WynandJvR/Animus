#!/usr/bin/env bash
# Convenience wrapper to drive the bot's control API from the shell.
#   ./ctl.sh state
#   ./ctl.sh log
#   ./ctl.sh cmd "house oak_planks 9 7 5"
#   ./ctl.sh cmd "come"
#   ./ctl.sh history              # compact state samples since 1h ago (default)
#   ./ctl.sh history 1752570000000  # ...since a unix-ms timestamp
BOT_URL="${BOT_URL:-http://127.0.0.1:3001}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  state) curl -s "$BOT_URL/state"; echo ;;
  log)   curl -s "$BOT_URL/log";   echo ;;
  health) curl -s "$BOT_URL/health"; echo ;;
  # Reads logs/state-history.jsonl directly via the tested reader (no HTTP, no self-call).
  history) shift; node "$HERE/bot/loghistory.js" ${1:+"$1"} ;;
  cmd)   shift; curl -s -X POST "$BOT_URL/cmd" -H 'Content-Type: application/json' \
            -d "$(printf '{"command":%s}' "$(printf '%s' "$*" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"; echo ;;
  *) echo "usage: $0 {state|log|health|cmd \"<command>\"}" ;;
esac
