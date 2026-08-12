#!/bin/sh
# Interleaved A/B over the tool payload arms.
#
# The arms alternate invocation by invocation, so drift in API-side conditions
# cannot masquerade as an arm effect. Each invocation runs the task list once.
#
#   sh bench/ab-tools.sh 6                              # full then defs, all 3 tasks
#   sh bench/ab-tools.sh 6 --cache                      # same, prompt cache on
#   sh bench/ab-tools.sh 12 --arms="defs full" --task=object-insert
#   sh bench/ab-tools.sh 14 --arms="full full" --task=object-insert   # A/A control
#
# --arms sets the two arms and the order they run inside each pair; object-insert
# turned out to be sensitive to that order, so run it both ways. --arms="X X" is
# an A/A control: two byte-identical arms, which measures the design's own noise.
# Every other flag is forwarded to agent-bench.mjs.
#
# A results file records its own arm, so the mapping does not depend on file
# order — except in an A/A run, where both files say the same thing and the
# order is all there is.
set -e
PAIRS=${1:-6}
shift 2>/dev/null || true
ARMS="full defs"
TASKS=object-insert,rewrite,table-report
BATCH=""
FORWARD=""
for arg in "$@"; do
  case "$arg" in
    --arms=*) ARMS=${arg#--arms=} ;;
    --task=*) TASKS=${arg#--task=} ;;
    --batch=*) BATCH=${arg#--batch=} ;;
    *) FORWARD="$FORWARD $arg" ;;
  esac
done
[ -n "$BATCH" ] || BATCH="$(echo "$ARMS" | tr ' ' '-')-$(echo "$TASKS" | tr ',' '+')"
for i in $(seq 1 "$PAIRS"); do
  POS=1
  for ARM in $ARMS; do
    echo "=== pair $i arm $ARM ==="
    # shellcheck disable=SC2086
    nice -n 19 node bench/agent-bench.mjs --task="$TASKS" --tools="$ARM" \
      --batch="$BATCH" --position="$POS" $FORWARD || true
    POS=$((POS + 1))
  done
done
