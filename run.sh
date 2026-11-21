#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export PORT="${PORT:-4317}"
export VITE_PORT="${VITE_PORT:-5173}"
[[ -d node_modules ]] || npm install
[[ -x "${HOME}/Scripts/devrun" ]] || exec npm run dev

exec "${HOME}/Scripts/devrun" vsdebug "${VITE_PORT}" "$@" -- npm run --silent dev
