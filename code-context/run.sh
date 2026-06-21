#!/usr/bin/env bash
# Run the "code-context" suite. Extra flags (e.g. --workload <id>, --limit N) pass through.
set -e
cd "$(dirname "$0")/.."
exec ./run.sh --suite code-context "$@"
