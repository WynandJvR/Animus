#!/bin/bash
# gated-deploy.sh [maxSec]: waits until the bot is on the surface (or inside the safehouse), not in water, within 20 of
# home, hp >= 14, not at night, no threat within 16, no reflex running, not paused; then snapshots the code and restarts it. Exits 2 if the gate never opens.
# (--paused-ok as 2nd arg: a bot paused on purpose - held off a task until new code is in - passes the gate on that one
#  count; every other check stands. A hand-rolled deploy round the pause skipped the underground check, 2026-09-28)
# (--stuck-ok: a body pinned where it stands - its own relog already put it back in the same cell - is not "away from home"
#  or "underground" in the sense those checks guard: hp, night, threat and the rest still stand)
S=$(cd "$(dirname "$0")" && pwd); lim=${1:-1800}; end=$((SECONDS+lim)); PAUSEDOK=$([ "$2" = "--paused-ok" ] && echo 1 || echo 0); STUCKOK=$([ "$2" = "--stuck-ok" ] && echo 1 || echo 0); NEAROK=$([ "$2" = "--near-ok" ] && echo 1 || echo 0)
# (--near-ok: the build site is the workday - within 64 of home, on the surface, passes the distance check; the rest stand.
#  Within 12 of home's height too: the first one went out with the bot 54 below home in a ravine on a sheep hunt.
#  Held for "within 20" the fixes for a 117s-a-try door loop waited behind the gate while the bot worked the site, 2026-09-28)
# (the code is fingerprinted NOW: a reconnect loads bot2 from disk, so an edit saved while the gate is shut would ship
#  unaudited - it nearly did twice on 2026-09-28. Changed when the gate opens = refused; start the deploy again)
fp () { cat /c/mc-bot-lab/bot2/main.js /c/mc-bot-lab/bot2/lib/*.js | md5sum | cut -d' ' -f1; }
FP0=$(fp); echo "code fingerprint $FP0 ($(git -C /c/mc-bot-lab rev-parse --short HEAD))"
while [ $SECONDS -lt $end ]; do
  st=$(curl -s -m 5 http://127.0.0.1:3001/state)
  ok=$(node -e "try{const j=JSON.parse(process.argv[1]);const h=j.home;const d=h?Math.hypot(j.pos.x-h.x,j.pos.z-h.z):99;const t=j.timeOfDay;const night=!(t>=1500&&t<11400);const threat=j.threat&&(j.threat.dist==null||j.threat.dist<16);const reflex=!!j.maneuver;const stuck=process.argv[3]==='1';const near=process.argv[4]==='1';console.log((stuck||!j.hazards.underground||d<8)&&!j.hazards.inWater&&(stuck||d<20||(near&&d<64&&Math.abs(j.pos.y-h.y)<=12&&j.hazards.onGround&&!j.hazards.lip))&&j.health>=14&&!night&&!threat&&!reflex&&(!j.paused||process.argv[2]==='1')?'yes':'no')}catch(e){console.log('no')}" "$st" "$PAUSEDOK" "$STUCKOK" "$NEAROK")
  if [ "$ok" = yes ]; then
    [ "$(fp)" = "$FP0" ] || { echo "REFUSED: bot2 changed while the gate was shut - what is on disk now is not what this deploy was started for"; exit 3; }
    cd /c/mc-bot-lab/bot2; for f in main.js lib/*.js; do node --no-lazy --check "$f" || { echo "SYNTAX FAIL $f"; exit 1; }; done
    NODE_PATH=/c/mc-bot-lab/bot/node_modules node /c/mc-bot-lab/tools/session-scripts/xmodcheck.js /c/mc-bot-lab/bot2 > /dev/null || { echo "CROSS-MODULE NAME MISSING - run tools/session-scripts/xmodcheck.js"; exit 1; }
    PREV=$(ls -d $S/rollback/candidate-* 2>/dev/null | tail -1)
    N=$S/rollback/candidate-$(date +%H%M); mkdir -p $N; cp -r lib main.js $N/; cp ../bot/config.json $N/
    # (the last three snapshots only - each is a whole copy of bot2: thirteen in a day were 439 files, 13MB)
    ls -d $S/rollback/candidate-* 2>/dev/null | head -n -3 | xargs -r rm -rf
    echo "$(date +%Y-%m-%dT%H:%M) prev=$PREV new=$N" > $S/last-deploy.txt # (rollback target = prev: the snapshot is of the NEW code)
    curl -s -m 5 -X POST -H "Content-Type: application/json" -d '{"reconnect":true}' http://127.0.0.1:3001/config; echo " deployed: $(cat $S/last-deploy.txt)"; exit 0
  fi
  sleep 15
done
echo "gate never opened"; exit 2
