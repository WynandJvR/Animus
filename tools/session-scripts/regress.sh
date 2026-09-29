#!/bin/bash
# regress.sh [deploy ISO time, e.g. 2026-09-27T20:25] [minutes=30]: the same counts for the N minutes before and after a
# deploy, so a regression shows as a number that went up (deaths, repeated failures, loops, stalls, throws, lag)
# (no time given: the last deploy's, from last-deploy.txt. Run bare before 2026-09-29 it compared two EMPTY windows and
#  printed zeros - a day of "clean" reports were that; now the windows and their line counts are printed, and an empty
#  one is an error)
S=$(cd "$(dirname "$0")" && pwd)
L=/c/mc-bot-lab/logs/bot2-events.log; t=$1; m=${2:-30}
if [ -z "$t" ]; then t=$(cut -d' ' -f1 "$S/last-deploy.txt" 2>/dev/null); [ -n "$t" ] && echo "(no time given: the last deploy, $t)"; fi
[[ "$t" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$ ]] || { echo "usage: regress.sh <YYYY-MM-DDTHH:MM> [minutes]"; exit 2; }
sp="${t/T/ }"; b0=$(date -d "$sp $m minutes ago" +%Y-%m-%dT%H:%M); a1=$(date -d "$sp $m minutes" +%Y-%m-%dT%H:%M) # ("T" breaks date -d arithmetic)
win () { cat $L.old $L 2>/dev/null | awk -v a="[$1" -v b="[$2" 'substr($0,1,17) >= a && substr($0,1,17) < b'; } # (the rotated log too: a window may start there)
count () { grep -ac "$1"; }
nb=$(win $b0 $t | wc -l); na=$(win $t $a1 | wc -l)
echo "before $b0..$t: $nb lines   after $t..$a1: $na lines"
[ "$nb" -eq 0 ] || [ "$na" -eq 0 ] && { echo "EMPTY WINDOW - nothing to compare (the after-window not yet run, or the log rotated: see bot2-events.log.old)"; exit 3; }
printf "%-28s %8s %8s\n" metric before after
for k in "(death) died" "did not succeed" "something is looping" "busy or looping" "stuck after" "PINNED" " threw" "(lag)" "won't place" "gave up"; do
  printf "%-28s %8s %8s\n" "$k" "$(win $b0 $t | count "$k")" "$(win $t $a1 | count "$k")"
done
