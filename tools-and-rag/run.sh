#!/usr/bin/env bash
# Run this suite (named by its directory). Extra flags (--workload <id>, --limit N) pass through.
set -e
suite="$(basename "$(cd "$(dirname "$0")" && pwd)")"
cd "$(dirname "$0")/.."
exec ./run.sh --suite "$suite" "$@"
