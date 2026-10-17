#!/usr/bin/env bash
# Puts the relayer on a server, behind TLS, and optionally the site in real mode beside it.
# Run from this machine: it logs in as root over SSH (key only) and can be run again to update. An update
# takes the relayer down for a few seconds only (the new code is uploaded and checked beside the running
# one, then swapped in), and a failed install leaves the old relayer running.
#
#   tools/server-install.sh <server-ip> [--site]
#
#   KEYS=~/keys/tape-eth  folder holding operator.key, backup-operator.key, price-signer.key and edge.key
#   API_HOST=tape-api.<ip>.sslip.io   name the SERVER answers on (sslip.io names resolve to the IP in them, so TLS
#                                works with no DNS record). No browser should ever be given this name: wallets
#                                flag every sslip.io address as malicious (MetaMask did, 2026-10-12). The public
#                                name is api.tapemarket.io, a Cloudflare Worker that passes requests on to here
#                                (tools/deploy-edge.sh). With edge.key in KEYS the server answers nothing that
#                                does not carry that key, so the Worker is the only way in.
#   APP_HOST=tape-app.<ip>.sslip.io   name a copy of the site answers on, with --site (for looking at a build from
#                                outside; see the warning above before sending anyone there)
#   PUBLIC_API=<url>             where to check the relayer from outside; default https://api.tapemarket.io when
#                                edge.key exists, otherwise https://$API_HOST
#   RPC_URL=<url>                the relayer's Ethereum RPC (a private one in production); default: a public one
#   CORS_ORIGIN=<origins>        allowed site origins; defaults to tapemarket.io and www.tapemarket.io
#   PORT=8787                   local relayer port; change it if another service already uses it
#
# What ends up on the server:
#   /opt/tape             relayer/, shared/, abi/, deployments/, .env (no key in it, only where they are)
#   /etc/tape             operator.key and price-signer.key, readable by the service's user alone
#   /var/www/tape         the site's static files (--site)
#   tape-relayer.service  the relayer, listening on 127.0.0.1:8787; Caddy in front of it holds the certificate
#
# THE PRICE SIGNER'S KEY SETS THE PRICE. After this it is on the server; a relayer anywhere else with the same key
# must be stopped first (two signers sign two prices for one second).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
IP=${1:?usage: tools/server-install.sh <server-ip> [--site]}
SITE=
[ "${2:-}" != "--site" ] || SITE=1
KEYS=${KEYS:-$HOME/keys/tape-eth}
DASHED=${IP//./-}
API_HOST=${API_HOST:-tape-api.$DASHED.sslip.io}
APP_HOST=${APP_HOST:-tape-app.$DASHED.sslip.io}
RPC_URL=${RPC_URL:-https://ethereum-rpc.publicnode.com}
CORS_ORIGIN=${CORS_ORIGIN:-https://tapemarket.io,https://www.tapemarket.io}
PORT=${PORT:-8787}
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || { echo "PORT must be 1 to 65535" >&2; exit 1; }
EDGE=
[ ! -s "$KEYS/edge.key" ] || EDGE=$(tr -d '\r\n' < "$KEYS/edge.key")
if [ -n "$EDGE" ]; then PUBLIC_API=${PUBLIC_API:-https://api.tapemarket.io}; else PUBLIC_API=${PUBLIC_API:-https://$API_HOST}; fi

# Every step is its own SSH connection, and a server on the open internet now and then refuses one
# (it did on 2026-10-13, halfway through an install). A connection that fails is tried again; a
# command that ran and failed is not.
remote() {
  local try code
  for try in 1 2 3 4 5 6; do
    code=0
    ssh -n -o BatchMode=yes -o ConnectTimeout=20 "root@$IP" "$@" || code=$?
    [ "$code" -eq 255 ] || return "$code"
    echo "  (no connection to the server; trying again, $try of 6)" >&2
    sleep $((try * 4))
  done
  return 1
}
# The same for a step that is fed something (a file, an archive), which is kept so it can be sent again.
remote_in() {
  local input try code
  input=$(mktemp)
  cat > "$input"
  for try in 1 2 3 4 5 6; do
    code=0
    ssh -o BatchMode=yes -o ConnectTimeout=20 "root@$IP" "$@" < "$input" || code=$?
    [ "$code" -eq 255 ] || { rm -f "$input"; return "$code"; }
    echo "  (no connection to the server; trying again, $try of 6)" >&2
    sleep $((try * 4))
  done
  rm -f "$input"
  return 1
}
SSH=remote
trap 'echo >&2; echo "INSTALL FAILED. The relayer on the server is: $(remote "systemctl is-active tape-relayer" 2> /dev/null || echo unknown)" >&2' ERR

say() { printf '\n== %s\n' "$*"; }
[ -s deployments/1.json ] || { echo "deployments/1.json is missing: deploy the exchange first" >&2; exit 1; }
for f in operator.key backup-operator.key price-signer.key; do [ -s "$KEYS/$f" ] || { echo "$KEYS/$f is missing" >&2; exit 1; }; done

say "packages and folders on $IP"
remote_in 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
node -v | grep -qE '^v(2[2-9]|[3-9][0-9])\.' || { echo "the server needs Node 22 or newer (has $(node -v 2>/dev/null || echo none))" >&2; exit 1; }
command -v caddy > /dev/null || { apt-get update -qq && apt-get install -y -qq caddy > /dev/null; }
if ! id tape > /dev/null 2>&1; then
  getent group tape > /dev/null || groupadd --system tape
  useradd --system --gid tape --home-dir /opt/tape --shell /usr/sbin/nologin tape
fi
install -d -m 755 /opt/tape /var/www/tape
install -d -m 755 /etc/caddy/tape
install -d -m 700 -o tape -g tape /etc/tape
timedatectl | grep -q 'System clock synchronized: yes' || { echo "the server's clock is not synchronised: the relayer signs nothing with a clock more than 2 s off" >&2; exit 1; }
echo "node $(node -v), $(caddy version | cut -d' ' -f1), clock synchronised"
REMOTE

say "the relayer's code"
# It goes beside the running relayer first, in /opt/tape/.next. The service is not touched until
# everything is on the server and checked: see "the service" below.
# The relayer's dependencies travel with it: they are plain JavaScript (no compiled part), so this machine's
# copy runs there as it is, and the server needs neither npm nor a way out to the package registry.
[ -d relayer/node_modules/viem ] || { echo "relayer/node_modules is missing: run npm --prefix relayer ci" >&2; exit 1; }
[ -z "$(find relayer/node_modules -name '*.node' -print -quit)" ] || { echo "relayer/node_modules holds a compiled addon: it cannot simply be copied to the server" >&2; exit 1; }
FILES="relayer/src relayer/node_modules relayer/test/hyperliquid-live.mjs relayer/package.json relayer/package-lock.json relayer/tape-relayer.service shared abi deployments/1.json"
[ ! -s deployments/1-coin.json ] || FILES="$FILES deployments/1-coin.json"
# shellcheck disable=SC2086
$SSH 'rm -rf /opt/tape/.next && mkdir -p /opt/tape/.next /opt/tape/relayer/data'
tar czf - $FILES | remote_in 'tar xzf - -C /opt/tape/.next'
$SSH 'cd /opt/tape/.next/relayer && node -e "import(\"viem\").then(v => console.log(\"code and dependencies in place, viem\", Object.keys(v).length > 100 ? \"loads\" : \"?\"))"'

say "keys (copied, never shown)"
for f in operator.key backup-operator.key price-signer.key; do
  scp -q -o BatchMode=yes "$KEYS/$f" "root@$IP:/etc/tape/$f.new" || { sleep 6; scp -q -o BatchMode=yes "$KEYS/$f" "root@$IP:/etc/tape/$f.new"; }
  $SSH "install -m 600 -o tape -g tape /etc/tape/$f.new /etc/tape/$f && rm -f /etc/tape/$f.new"
done
$SSH 'ls -l /etc/tape | tail -n +2 | awk "{print \$1, \$3, \$9}"'

say "settings"
# No secret is written here unless RPC_URL carries one, and the file is the service user's alone.
remote_in "umask 077 && cat > /opt/tape/.env" <<ENV
CHAIN_ID=1
RELAYER_RPC_URL=$RPC_URL
OPERATOR_KEY_FILE=/etc/tape/operator.key
BACKUP_OPERATOR_KEY_FILES=/etc/tape/backup-operator.key
PRICE_SIGNER_KEY_FILE=/etc/tape/price-signer.key
PRICE_SOURCE=hyperliquid
PRICE_REFERENCE=oracle
PRICE_SANITY_BPS=150
PRICE_MAX_SPREAD_BPS=100
GAS_MIN_ETH=0.02
CASH_FLOOR_USD=2000000
CASH_MULTIPLE=50
DATA_DIR=/opt/tape/relayer/data
PORT=$PORT
HOST=127.0.0.1
TRUST_PROXY=1
CORS_ORIGIN=$CORS_ORIGIN
ENV
$SSH 'chown -R tape:tape /opt/tape && chmod 600 /opt/tape/.env'

say "the price feed, from the server (20 seconds against Hyperliquid's real API)"
$SSH 'cd /opt/tape/.next && sudo -u tape node relayer/test/hyperliquid-live.mjs 20 2>&1 | grep -E "^\[|ALL GOOD|FAILED"'

say "TLS in front (Caddy) and the firewall"
{
  echo "# Written by tools/server-install.sh. The relayer listens on this machine only; this holds the certificate."
  echo "$API_HOST {"
  if [ -n "$EDGE" ]; then
    cat <<CADDY
	# Only Cloudflare's Worker (edge/worker.mjs, api.tapemarket.io) knows this key. Nothing else gets past.
	@edge header X-Edge-Key $EDGE
	handle @edge {
		reverse_proxy 127.0.0.1:$PORT {
			# One long-lived event stream per visitor: pass each event on at once.
			flush_interval -1
			# The visitor's address as Cloudflare saw it: the relayer's limits are per visitor.
			header_up X-Forwarded-For {header.X-Client-Ip}
			header_up -X-Edge-Key
			header_up -X-Client-Ip
		}
	}
	handle {
		respond "Not here." 403
	}
CADDY
  else
    cat <<CADDY
	reverse_proxy 127.0.0.1:$PORT {
		# One long-lived event stream per visitor: pass each event on at once.
		flush_interval -1
	}
CADDY
  fi
  echo "}"
  [ -z "$SITE" ] || cat <<CADDY
$APP_HOST {
	root * /var/www/tape
	encode zstd gzip
	# A script that is not there is a 404, never the page: a replaced build's file must not come back as HTML.
	@assets path /assets/*
	handle @assets {
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}
	handle {
		header Cache-Control "no-cache"
		try_files {path} {path}.html /index.html
		file_server
	}
}
CADDY
} | remote_in 'umask 027 && cat > /etc/caddy/tape/Caddyfile.new && chgrp caddy /etc/caddy/tape/Caddyfile.new && chmod 640 /etc/caddy/tape/Caddyfile.new'
# Without --site no copy of the site stays behind on the server.
[ -n "$SITE" ] || $SSH 'rm -rf /var/www/tape/*'
# Caddy is every visitor's way in, so it is touched only when its file really changed, and then
# restarted, never reloaded: a reload with visitors' streams open crashed it on 2026-10-13 (a panic
# inside Caddy), and nothing brought it back for six minutes. systemd restarts it from now on.
remote_in 'bash -s' <<'REMOTE'
set -eu
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nRestart=on-failure\nRestartSec=2s\n' > /etc/systemd/system/caddy.service.d/restart.conf
systemctl daemon-reload
systemctl enable -q caddy
cd /etc/caddy
IMPORT='import /etc/caddy/tape/Caddyfile'
touch Caddyfile
if [ -f tape/Caddyfile ] && cmp -s tape/Caddyfile.new tape/Caddyfile && grep -Fqx "$IMPORT" Caddyfile; then
  rm -f tape/Caddyfile.new
  echo "the front door's settings have not changed: Caddy left running"
else
  # Keep every other project's site block and its secrets intact. Tape owns this
  # one imported fragment. Back up both files before validation or a restart.
  cp -p Caddyfile Caddyfile.tape-backup
  HAD_FRAGMENT=
  if [ -f tape/Caddyfile ]; then cp -p tape/Caddyfile tape/Caddyfile.backup; HAD_FRAGMENT=1; fi
  restore_caddy() {
    cp -p Caddyfile.tape-backup Caddyfile
    if [ -n "$HAD_FRAGMENT" ]; then cp -p tape/Caddyfile.backup tape/Caddyfile; else rm -f tape/Caddyfile; fi
  }
  mv tape/Caddyfile.new tape/Caddyfile
  cp -p Caddyfile Caddyfile.new
  grep -Fqx "$IMPORT" Caddyfile.new || printf '\n%s\n' "$IMPORT" >> Caddyfile.new
  if ! caddy validate --config Caddyfile.new --adapter caddyfile > /dev/null 2>&1; then
    restore_caddy
    rm -f Caddyfile.new
    echo "Tape's Caddy settings failed validation; the existing settings were restored." >&2
    exit 1
  fi
  mv Caddyfile.new Caddyfile
  if ! systemctl restart caddy; then
    restore_caddy
    systemctl restart caddy
    echo "Caddy failed to restart with Tape's settings; the existing settings were restored." >&2
    exit 1
  fi
  echo "Tape's site settings installed; all existing site blocks preserved"
fi
sleep 2
systemctl is-active -q caddy || systemctl restart caddy
ufw allow 80/tcp > /dev/null; ufw allow 443/tcp > /dev/null
echo "caddy $(systemctl is-active caddy), ports 80 and 443 open"
REMOTE

say "the service"
# The only moment the relayer is down: stop, put the new code where the old was (a rename), start. A few
# seconds. The swap runs on the server from a file of its own, keeps going if this connection drops, and
# whatever happens on the way it ends by starting the service: an install that goes wrong must not leave
# the exchange without its relayer (a stopped relayer busts nobody).
remote_in 'cat > /opt/tape/swap.sh' <<'REMOTE'
trap '' HUP PIPE
exec > /opt/tape/swap.log 2>&1
trap 'systemctl start tape-relayer; echo "relayer: $(systemctl is-active tape-relayer)"' EXIT
set -eu
cd /opt/tape
if [ ! -d .next ]; then echo "nothing to swap in: already done"; exit 0; fi
[ -d .next/relayer/src ] && [ -d .next/relayer/node_modules ] && [ -d .next/shared ] && [ -d .next/abi ] || { echo "the new code is not all on the server"; exit 1; }
systemctl stop tape-relayer 2> /dev/null || true
for part in relayer/src relayer/node_modules shared abi; do
  rm -rf "$part.old"
  [ ! -e "$part" ] || mv "$part" "$part.old"
  mv ".next/$part" "$part"
done
mkdir -p relayer/test relayer/data deployments
cp -f .next/relayer/test/hyperliquid-live.mjs relayer/test/
cp -f .next/relayer/package.json .next/relayer/package-lock.json .next/relayer/tape-relayer.service relayer/
cp -f .next/deployments/*.json deployments/
chown -R tape:tape /opt/tape
cp relayer/tape-relayer.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q tape-relayer
systemctl start tape-relayer
rm -rf relayer/src.old relayer/node_modules.old shared.old abi.old .next
echo "new code swapped in"
REMOTE
$SSH 'bash /opt/tape/swap.sh; code=$?; cat /opt/tape/swap.log; exit $code'
$SSH 'sleep 8 && systemctl is-active tape-relayer && journalctl -u tape-relayer -n 14 --no-pager -o cat | cut -c1-220'

if [ -n "$SITE" ]; then
  say "the site, in real mode, talking to $PUBLIC_API"
  (cd web && VITE_API_URL="$PUBLIC_API" npx vite build --outDir dist-live > /dev/null 2>&1)
  tar czf - -C web/dist-live . | remote_in 'rm -rf /var/www/tape/* && tar xzf - -C /var/www/tape && chmod -R a+rX /var/www/tape && echo "$(find /var/www/tape -type f | wc -l) files"'
fi

say "from outside"
for _ in $(seq 1 30); do [ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$PUBLIC_API/health")" = 200 ] && break; sleep 2; done
echo "relayer, at $PUBLIC_API: $(curl -s -m 10 "$PUBLIC_API/health" | cut -c1-160)"
[ -z "$EDGE" ] || echo "the server itself, asked without the key: HTTP $(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://$API_HOST/health") (403 is right)"
[ -z "$SITE" ] || echo "site:    HTTP $(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://$APP_HOST/") at https://$APP_HOST"
