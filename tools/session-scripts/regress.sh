#!/bin/bash
# regress.sh <deploy ISO time, e.g. 2026-09-27T20:25> [minutes=30]: the same counts for the N minutes before and after a
# deploy, so a regression shows as a number that went up (deaths, repeated failures, loops, stalls, throws, lag)
L=/c/mc-bot-lab/logs/bot2-events.log; t=$1; m=${2:-30}
sp="${t/T/ }"; b0=$(date -d "$sp $m minutes ago" +%Y-%m-%dT%H:%M); a1=$(date -d "$sp $m minutes" +%Y-%m-%dT%H:%M) # ("T" breaks date -d arithmetic)
win () { awk -v a="[$1" -v b="[$2" 'substr($0,1,17) >= a && substr($0,1,17) < b' $L; }
count () { grep -ac "$1"; }
printf "%-28s %8s %8s\n" metric before after
for k in "(death) died" "did not succeed" "something is looping" "busy or looping" "stuck after" "PINNED" " threw" "(lag)" "won't place" "gave up"; do
  printf "%-28s %8s %8s\n" "$k" "$(win $b0 $t | count "$k")" "$(win $t $a1 | count "$k")"
done
