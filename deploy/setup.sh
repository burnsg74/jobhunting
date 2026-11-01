#!/usr/bin/env bash
# Idempotent setup for http://jobhunting.localhost
#   build frontend -> link nginx conf -> hosts -> pm2 jobhunting-api (+save) -> nginx via brew services -> verify
# Safe to re-run. Asks before replacing an existing nginx conf, or removing dangling nginx site links.
#   deploy/setup.sh [--fix-broken-links]
set -euo pipefail

APP=jobhunting
HOST=jobhunting.localhost
PORT=4002
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_SERVERS="$(brew --prefix 2>/dev/null || echo /opt/homebrew)/etc/nginx/servers"
CONF_SRC="$ROOT/deploy/nginx/$APP.conf"
CONF_DST="$NGINX_SERVERS/$APP.conf"
VAULT_PATH="${VAULT_PATH:-/Users/greg/Library/CloudStorage/Dropbox/Notebooks/Work}"
DATA_DIR="${DATA_DIR:-10 Projects/Job Hunting/data}"
FIX_LINKS=0
[[ "${1:-}" == "--fix-broken-links" ]] && FIX_LINKS=1

say() { printf '\n==> %s\n' "$*"; }
ask() { read -r -p "$1 [y/N] " reply; [[ "$reply" =~ ^[Yy]$ ]]; }

for bin in node npm nginx pm2 curl; do
  command -v "$bin" >/dev/null || { echo "missing required tool: $bin" >&2; exit 1; }
done

say "Data directory"
if [[ ! -f "$VAULT_PATH/$DATA_DIR/jobs.csv" || ! -f "$VAULT_PATH/$DATA_DIR/events.csv" ]]; then
  echo "No CSVs in $VAULT_PATH/$DATA_DIR" >&2
  echo "Run once: npm run export:prod   (needs the old Postgres DB)" >&2
  exit 1
fi
echo "ok: $VAULT_PATH/$DATA_DIR"

say "Port $PORT"
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && ! pm2 describe "$APP-api" >/dev/null 2>&1; then
  echo "Port $PORT is in use by something other than pm2 $APP-api. Aborting." >&2
  exit 1
fi

say "Build frontend"
(cd "$ROOT/frontend" && { [[ -d node_modules ]] || npm install; } && npm run build)

say "nginx site"
mkdir -p "$NGINX_SERVERS"
if [[ -e "$CONF_DST" || -L "$CONF_DST" ]]; then
  if [[ "$(readlink "$CONF_DST" || true)" == "$CONF_SRC" ]]; then
    echo "already linked"
  elif ask "$CONF_DST exists and is not this app's conf. Replace it?"; then
    ln -sfn "$CONF_SRC" "$CONF_DST"
  else
    echo "left $CONF_DST alone; aborting" >&2
    exit 1
  fi
else
  ln -s "$CONF_SRC" "$CONF_DST"
  echo "linked $CONF_DST"
fi

# A dangling symlink in servers/ makes `nginx -t` fail for every site.
for link in "$NGINX_SERVERS"/*; do
  [[ -L "$link" && ! -e "$link" ]] || continue
  echo "dangling nginx site link: $link -> $(readlink "$link")"
  if [[ $FIX_LINKS -eq 1 ]] || ask "Remove it?"; then rm "$link"; echo "removed"; fi
done

# Log files left root-owned by an earlier `sudo nginx` stop a user-level brew service from starting.
LOG_DIR="$(brew --prefix 2>/dev/null || echo /opt/homebrew)/var/log/nginx"
for log in "$LOG_DIR"/*.log; do
  [[ -e "$log" && ! -w "$log" ]] || continue
  echo "not writable: $log (owned by $(stat -f %Su "$log")); fixing with sudo chown"
  sudo chown "$(id -un)" "$log"
done
nginx -t

say "hosts ($HOST)"
for line in "127.0.0.1 $HOST" "::1 $HOST"; do
  if grep -qE "^[[:space:]]*${line%% *}[[:space:]]+.*\b${HOST}\b" /etc/hosts; then
    echo "present: $line"
  else
    echo "adding: $line (sudo)"
    echo "$line" | sudo tee -a /etc/hosts >/dev/null
  fi
done

say "pm2 $APP-api"
pm2 startOrReload "$ROOT/deploy/ecosystem.config.cjs" --update-env
pm2 save

say "nginx (brew services)"
if brew services list | awk '$1=="nginx"{print $2}' | grep -q started; then
  nginx -s reload || brew services restart nginx
else
  brew services start nginx
fi
sleep 1

say "Verify"
fail=0
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then echo "ok   $label"; else echo "FAIL $label"; fail=1; fi; }
check "API health (direct)"      curl -fsS "http://127.0.0.1:$PORT/api/health"
check "IPv4 $HOST/"              curl -fsS -4 --resolve "$HOST:80:127.0.0.1" "http://$HOST/"
check "IPv6 $HOST/"              curl -fsS -6 -H "Host: $HOST" "http://[::1]/"
check "API via nginx"            curl -fsS -4 --resolve "$HOST:80:127.0.0.1" "http://$HOST/api/health"
check "SPA deep link"            bash -c "curl -fsS -4 --resolve $HOST:80:127.0.0.1 'http://$HOST/jobs/test' | grep -q '<div id=\"app\">'"
check "jobs via API"             curl -fsS "http://127.0.0.1:$PORT/api/jobs"
check "pm2 online"               bash -c "pm2 jlist | grep -q '\"status\":\"online\"'"
check "plain name resolves"      curl -fsS "http://$HOST/"
echo
if [[ $fail -ne 0 ]]; then
  echo "Some checks failed (see above)." >&2
  echo "If the API health check reports a timeout reading the CSVs, macOS is blocking the pm2/launchd node" >&2
  echo "from the Dropbox folder: add this binary under System Settings > Privacy & Security > Full Disk Access," >&2
  echo "then run: pm2 restart $APP-api" >&2
  echo "  $(command -v node)  (pm2 uses the node set in deploy/ecosystem.config.cjs)" >&2
  curl -s -m 8 "http://127.0.0.1:$PORT/api/health" >&2 || true
  exit 1
fi
echo "Job Hunting is up: http://$HOST"
