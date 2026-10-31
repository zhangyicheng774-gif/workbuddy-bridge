#!/usr/bin/env sh
# Start the bridge on 127.0.0.1:8787 (macOS / Linux).
set -eu
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -z "${WB_UPSTREAM_BASE_URL:-}" ] && [ ! -f vendor/wb/index.js ]; then
  echo "No upstream configured." >&2
  echo "  either export WB_UPSTREAM_BASE_URL + WB_UPSTREAM_API_KEY (any OpenAI-compatible endpoint)" >&2
  echo "  or put the WorkBuddy adapter at vendor/wb/index.js" >&2
  exit 2
fi

exec node server.mjs
