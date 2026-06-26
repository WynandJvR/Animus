#!/usr/bin/env bash
# Convenience wrapper to drive the bot's control API from the shell.
#   ./ctl.sh state
#   ./ctl.sh log
#   ./ctl.sh cmd "house oak_planks 9 7 5"
#   ./ctl.sh cmd "come"
BOT_URL="${BOT_URL:-http://127.0.0.1:3001}"
case "${1:-}" in
  state) curl -s "$BOT_URL/state"; echo ;;
  log)   curl -s "$BOT_URL/log";   echo ;;
  health) curl -s "$BOT_URL/health"; echo ;;
  cmd)   shift; curl -s -X POST "$BOT_URL/cmd" -H 'Content-Type: application/json' \
            -d "$(printf '{"command":%s}' "$(printf '%s' "$*" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"; echo ;;
  *) echo "usage: $0 {state|log|health|cmd \"<command>\"}" ;;
esac
