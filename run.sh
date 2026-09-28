#!/usr/bin/env bash
# Bootstrap deps and run the direct-vs-gateway comparison. Forwards all flags:
#   ./run.sh --all
#   ./run.sh --suite memory-recall --workload 18-session-recall
set -e
cd "$(dirname "$0")"

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "No .env found — copying .env.example. Set ANYRAY_GATEWAY_URL in it."
  cp .env.example .env
fi
# Load .env if present (export every var).
if [ -f .env ]; then set -a; . ./.env; set +a; fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

node run.mjs "$@"   # replay suite (secondary); the agent benchmark is run_agent.mjs
