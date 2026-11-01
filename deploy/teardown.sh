#!/usr/bin/env bash
# Remove jobhunting.localhost: nginx site, pm2 process, hosts lines. Never touches vault data or the repo.
set -euo pipefail
NGINX_SERVERS="$(brew --prefix 2>/dev/null || echo /opt/homebrew)/etc/nginx/servers"

rm -f "$NGINX_SERVERS/jobhunting.conf"
nginx -t && nginx -s reload || true
pm2 delete jobhunting-api 2>/dev/null || true
pm2 save
sudo sed -i '' '/[[:space:]]jobhunting\.localhost$/d' /etc/hosts
echo "removed. Vault data (10 Projects/Job Hunting/data) and this folder are untouched."
