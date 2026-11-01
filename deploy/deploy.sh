#!/usr/bin/env bash
# Later updates: rebuild the frontend, restart the API, reload nginx.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(cd "$ROOT/frontend" && npm run build)
pm2 startOrReload "$ROOT/deploy/ecosystem.config.cjs" --update-env
pm2 save
nginx -t && nginx -s reload
curl -fsS http://127.0.0.1:4002/api/health >/dev/null && echo "deployed: http://jobhunting.localhost"
