#!/usr/bin/env bash
# Bootstrap deps and run the benchmark runner. Forwards all flags through:
#   ./run.sh --suite memory-recall
#   ./run.sh --all --limit 2
set -e
cd "$(dirname "$0")"

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "No .env found — copying .env.example. Edit it with your optimizer URL + admin token."
  cp .env.example .env
fi
# Load .env if present (export every var).
if [ -f .env ]; then set -a; . ./.env; set +a; fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

node run_benchmark.mjs "$@"
