#!/usr/bin/env bash
# Run the "tools-and-rag" suite. Extra flags (e.g. --workload <id>, --limit N) pass through.
set -e
cd "$(dirname "$0")/.."
exec ./run.sh --suite tools-and-rag "$@"
