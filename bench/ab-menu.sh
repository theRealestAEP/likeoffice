#!/bin/sh
# Interleaved A/B for the tiered-union experiment: --tools=defs (shipped)
# against --tools=menu (create-vs-adjust tiering plus its prompt sentence).
#
#   sh bench/ab-menu.sh 6
set -e
PAIRS=${1:-6}
shift 2>/dev/null || true
TASKS=object-insert,rewrite,table-report
for i in $(seq 1 "$PAIRS"); do
  for ARM in defs menu; do
    echo "=== pair $i arm $ARM ==="
    nice -n 19 node bench/agent-bench.mjs --task="$TASKS" --tools="$ARM" "$@" || true
  done
done
