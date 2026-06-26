#!/usr/bin/env bash
# Start the ISOLATED bot-lab test server.
# Small heap, NO AlwaysPreTouch, so it does not steal RAM from the live
# server (which holds a pinned -Xms8G -Xmx8G at /opt/minecraft/server).
# Bound to 127.0.0.1:25599. Never enable on boot; run only while testing.
set -euo pipefail
cd "$(dirname "$0")"

JAR="paper-1.21.11-69.jar"

exec java \
  -Xms256M -Xmx1G \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
  -Djava.awt.headless=true \
  -jar "$JAR" --nogui
