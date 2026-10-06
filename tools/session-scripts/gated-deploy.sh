#!/bin/bash
# gated-deploy.sh [maxSec]: waits until the bot is on the surface (or inside the safehouse), not in water, within 20 of
# home, hp >= 14, not at night, no threat within 16, no reflex running, not paused; then snapshots the code and restarts it. Exits 2 if the gate never opens.
# (--paused-ok as 2nd arg: a bot paused on purpose - held off a task until new code is in - passes the gate on that one
#  count; every other check stands. A hand-rolled deploy round the pause skipped the underground check, 2026-09-28)
# (--stuck-ok: a body pinned where it stands - its own relog already put it back in the same cell - is not "away from home"
#  or "underground" in the sense those checks guard: hp, night, threat and the rest still stand)
S=$(cd "$(dirname "$0")" && pwd); lim=${1:-1800}; end=$((SECONDS+lim)); PAUSEDOK=$(echo " $* " | grep -q " --paused-ok " && echo 1 || echo 0); STUCKOK=$(echo " $* " | grep -q " --stuck-ok " && echo 1 || echo 0); NEAROK=$(echo " $* " | grep -qE " --near(-fight)?-ok " && echo 1 || echo 0); FIGHTOK=$(echo " $* " | grep -q " --near-fight-ok " && echo 1 || echo 0); HUTOK=$(echo " $* " | grep -q " --hut-ok " && echo 1 || echo 0); FAROK=$(echo " $* " | grep -q " --far-ok " && echo 1 || echo 0); [ $FAROK = 1 ] && NEAROK=1
# (--near-fight-ok: --near-ok, and a fight reflex holding the body at hp 18+ does not hold the deploy - the old code's chase
#  of pillagers below a 21-block cliff held the body (and every deploy, the fix for it among them) for good, 2026-10-04.
#  The threat check still stands unless the fight is the threat: an unreachable shooter at hp 18+ is not a reconnect risk)
# (--hut-ok: a threat outside while the bot stands at home inside the safehouse (within 4 of home) - a patrol camped round
#  the house held every deploy for 40 minutes, 2026-10-04; the rest stand)
# (--far-ok: a bot travelling between bases - on the surface, on its feet, by day, no threat - however far from home;
#  a trek of thousands of blocks held every fix for days, 2026-10-06)
# (--near-ok: the build site is the workday - within 64 of home, on the surface, passes the distance check; the rest stand.
#  Within 12 of home's height too: the first one went out with the bot 54 below home in a ravine on a sheep hunt.
#  Held for "within 20" the fixes for a 117s-a-try door loop waited behind the gate while the bot worked the site, 2026-09-28)
# (the code is fingerprinted NOW: a reconnect loads bot2 from disk, so an edit saved while the gate is shut would ship
#  unaudited - it nearly did twice on 2026-09-28. Changed when the gate opens = refused; start the deploy again)
fp () { cat /c/mc-bot-lab/bot2/*.js /c/mc-bot-lab/bot2/lib/*.js | md5sum | cut -d' ' -f1; }
FP0=$(fp); echo "code fingerprint $FP0 ($(git -C /c/mc-bot-lab rev-parse --short HEAD))"
while [ $SECONDS -lt $end ]; do
  st=$(curl -s -m 5 http://127.0.0.1:3001/state)
  ok=$(node -e "try{const j=JSON.parse(process.argv[1]);const h=j.home;const d=h?Math.hypot(j.pos.x-h.x,j.pos.z-h.z):99;const t=j.timeOfDay;const night=!(t>=1500&&t<11400);const threat=j.threat&&(j.threat.dist==null||j.threat.dist<16);const fightOk=process.argv[6]==='1'&&j.maneuver&&j.maneuver.label==='fight'&&j.health>=18&&j.threat&&j.threat.dist!=null&&j.threat.dist>=8;const reflex=!!j.maneuver&&!fightOk;const stuck=process.argv[3]==='1';const near=process.argv[4]==='1';const hut=process.argv[5]==='1';console.log((stuck||!j.hazards.underground||d<8)&&!j.hazards.inWater&&(stuck||d<20||(near&&(process.argv[7]==='1'||(d<64&&Math.abs(j.pos.y-h.y)<=12))&&j.hazards.onGround&&!j.hazards.lip))&&j.health>=14&&!night&&(!threat||(hut&&d<4)||fightOk)&&!reflex&&(!j.paused||process.argv[2]==='1')?'yes':'no')}catch(e){console.log('no')}" "$st" "$PAUSEDOK" "$STUCKOK" "$NEAROK" "$HUTOK" "$FIGHTOK" "$FAROK")
  if [ "$ok" = yes ]; then
    [ "$(fp)" = "$FP0" ] || { echo "REFUSED: bot2 changed while the gate was shut - what is on disk now is not what this deploy was started for"; exit 3; }
    cd /c/mc-bot-lab/bot2; for f in main.js lib/*.js; do node --no-lazy --check "$f" || { echo "SYNTAX FAIL $f"; exit 1; }; done
    # (and no undeclared name: a renamed variable throws only when its branch runs - node --check cannot see it; tools lint/)
    $S/lint/node_modules/.bin/eslint -c $S/lint/eslint.config.js --no-warn-ignored *.js lib/*.js || { echo "NO-UNDEF FAIL - see above"; exit 1; }
    NODE_PATH=/c/mc-bot-lab/bot2/node_modules node /c/mc-bot-lab/tools/session-scripts/xmodcheck.js /c/mc-bot-lab/bot2 > /dev/null || { echo "CROSS-MODULE NAME MISSING - run tools/session-scripts/xmodcheck.js"; exit 1; }
    PREV=$(ls -dt $S/rollback/candidate-* 2>/dev/null | head -1)
    N=$S/rollback/candidate-$(date +%m%d-%H%M%S); mkdir -p $N; cp -r lib *.js command.gbnf config.json package.json $N/ 2>/dev/null; mkdir -p $N/schematics; cp schematics/hut.schem $N/schematics/ 2>/dev/null
    # (the last three snapshots only - each is a whole copy of bot2: thirteen in a day were 439 files, 13MB)
    ls -dt $S/rollback/candidate-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
    echo "$(date +%Y-%m-%dT%H:%M) prev=$PREV new=$N" > $S/last-deploy.txt # (rollback target = prev: the snapshot is of the NEW code)
    # (and once more right before the reconnect: the checks and the snapshot above take seconds, and an edit saved in them
    #  shipped with its fingerprint unchecked - the reconnect loads bot2 from disk; 2026-09-30, audit)
    # (THE LOCK: an edit saved between the last check and the reload - modules load from disk as the reconnect needs them -
    #  shipped unaudited, 2026-10-04. .deploying stands from here until the reload is done: nothing is saved into bot2 while
    #  it does; and the fingerprint is read again after - changed = said loudly, exit 4)
    echo "$$ $(date +%H:%M:%S)" > $S/.deploying; trap "rm -f $S/.deploying" EXIT
    [ "$(fp)" = "$FP0" ] || { echo "REFUSED: bot2 changed during the deploy's own checks - not restarting"; exit 3; }
    curl -s -m 5 -X POST -H "Content-Type: application/json" -d '{"reconnect":true}' http://127.0.0.1:3001/config; echo " deployed: $(cat $S/last-deploy.txt)"
    for i in $(seq 1 30); do sleep 3; curl -s -m 3 http://127.0.0.1:3001/state | grep -q '"pos"' && break; done; sleep 30 # (the job and its modules load in the first seconds after the login)
    [ "$(fp)" = "$FP0" ] || { echo "WARNING: bot2 changed during the reload - code NOT fingerprinted may be live; audit it or roll back to $PREV"; exit 4; }
    exit 0
  fi
  sleep 15
done
echo "gate never opened"; exit 2
