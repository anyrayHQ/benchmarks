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

# Route live-validation modes to run_live.mjs; everything else is the savings runner.
case "$1" in
  --live)     shift; exec node run_live.mjs --mode per-strategy "$@" ;;
  --pipeline) shift; exec node run_live.mjs --mode pipeline "$@" ;;
  --sweep)    shift; exec node run_live.mjs --mode sweep "$@" ;;
esac

node run_benchmark.mjs "$@"
