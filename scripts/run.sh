#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PROJECT_ROOT"

TASK="${1:-}"

if [[ -z "$TASK" ]]; then
  echo "Usage: scripts/run.sh {standup-push|standup-second-remind|standup-mark-missing|standup-summary|daily-summary|dashboard|overdue-scan}"
  exit 1
fi

# Try to call local node API
RESPONSE=$(curl -s -X POST http://127.0.0.1:8090/api/jobs/"$TASK" -H "Content-Type: application/json" -d '{}')
if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "Job $TASK triggered successfully."
elif echo "$RESPONSE" | grep -q '"skipped":true'; then
  echo "Job $TASK skipped (e.g. holiday or weekend)."
else
  echo "Job $TASK failed or API not reachable: $RESPONSE"
  exit 1
fi
