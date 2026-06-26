#!/usr/bin/env bash
# Stop the lab and release its RAM (recommended when not actively testing,
# so the live server keeps full headroom).
LAB="$(cd "$(dirname "$0")" && pwd)"
echo "stopping bot..."
pkill -f "$LAB/bot/index.js" 2>/dev/null || pkill -f "node index.js" 2>/dev/null || true
echo "stopping test server..."
[ -f "$LAB/logs/testserver.pid" ] && kill "$(cat "$LAB/logs/testserver.pid")" 2>/dev/null || true
# fall back to matching our jar if pid file is stale
pkill -f "paper-1.21.11-69.jar" 2>/dev/null || true
sleep 2
ss -tln 2>/dev/null | grep -qE ':25599|:3001' && echo "WARN: something still listening" || echo "lab stopped."
free -h | awk 'NR==1||/Mem/'
