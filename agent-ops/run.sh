#!/usr/bin/env bash
# Run the "agent-ops" suite. Extra flags (e.g. --workload <id>, --limit N) pass through.
set -e
cd "$(dirname "$0")/.."
exec ./run.sh --suite agent-ops "$@"
