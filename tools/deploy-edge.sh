#!/usr/bin/env bash
# Publishes the Worker that answers on api.tapemarket.io (edge/worker.mjs) and gives it the key it shares with
# the relayer's server. Run tools/server-install.sh afterwards (or before): it puts the same key on the server,
# whose front door then answers nothing that does not carry it.
#
#   tools/deploy-edge.sh
#
#   KEYS=~/keys/tape-eth   edge.key lives here; it is made on first use and never shown
#
# Needs wrangler, logged in to the Cloudflare account that holds the tapemarket.io zone. Wrangler 4 needs Node 22
# or newer: NODE22 and WRANGLER_JS as for tools/deploy-site.sh.
set -euo pipefail
cd "$(dirname "$0")/../edge"
KEYS=${KEYS:-$HOME/keys/tape-eth}
if [ ! -s "$KEYS/edge.key" ]; then
  (umask 077 && openssl rand -hex 32 > "$KEYS/edge.key")
  echo "made $KEYS/edge.key"
fi
W() { if [ -n "${WRANGLER_JS:-}" ]; then "${NODE22:-node}" "$WRANGLER_JS" "$@"; else npx wrangler "$@"; fi; }
# The server's address stays out of the repository: UPSTREAM, or the one line in $KEYS/upstream.txt.
UPSTREAM=${UPSTREAM:-$(tr -d '\r\n' < "$KEYS/upstream.txt" 2> /dev/null || true)}
[ -n "$UPSTREAM" ] || { echo "say where the relayer's server is: UPSTREAM=https://... or put it in $KEYS/upstream.txt" >&2; exit 1; }
W deploy --config wrangler.jsonc --var "UPSTREAM:$UPSTREAM"
# No line ending: a header's value cannot hold one.
tr -d '\r\n' < "$KEYS/edge.key" | W secret put EDGE_KEY --config wrangler.jsonc
