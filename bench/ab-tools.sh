#!/bin/sh
# Interleaved A/B over the tool payload arms.
#
# Arm A is --tools=full (every $ref expanded, i.e. the payload the engine sent
# before the $defs hoist) and arm B is --tools=defs. The arms alternate
# invocation by invocation, so drift in API-side conditions cannot masquerade
# as an arm effect. Each invocation runs the same task list once.
#
#   sh bench/ab-tools.sh 6                  # 6 pairs, uncached
#   sh bench/ab-tools.sh 6 --cache          # 6 pairs, prompt cache on
#
# The results files sort into the order printed here; a results file records
# its own arm in the "arm" field, so the mapping does not depend on the order.
set -e
PAIRS=${1:-6}
shift 2>/dev/null || true
TASKS=object-insert,rewrite,table-report
for i in $(seq 1 "$PAIRS"); do
  for ARM in full defs; do
    echo "=== pair $i arm $ARM ==="
    nice -n 19 node bench/agent-bench.mjs --task="$TASKS" --tools="$ARM" "$@" || true
  done
done
