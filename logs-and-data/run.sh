#!/usr/bin/env bash
# Run the "logs-and-data" suite. Extra flags (e.g. --workload <id>, --limit N) pass through.
set -e
cd "$(dirname "$0")/.."
exec ./run.sh --suite logs-and-data "$@"
