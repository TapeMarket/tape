#!/usr/bin/env bash
# Builds the site and publishes the static files to Cloudflare, where tapemarket.io points.
#
#   tools/deploy-site.sh                                         live Ethereum exchange (.env.production)
#   VITE_PREVIEW=1 tools/deploy-site.sh                          practice preview, no real funds
#
# The files are built here and uploaded as they are; nothing runs on the server. The site answers on
# tapemarket.io, www.tapemarket.io and tape.vector-dex.workers.dev (web/wrangler.jsonc).
#
# Needs wrangler, logged in to the Cloudflare account that holds the tapemarket.io zone
# (`wrangler whoami`). Wrangler 4 needs Node 22 or newer. If the default `node` is older, point
# NODE22 at a newer one and WRANGLER_JS at wrangler's script:
#
#   NODE22=~/tools/node-v22.23.2-win-x64/node.exe \
#   WRANGLER_JS=~/binary-options/strike/node_modules/wrangler/bin/wrangler.js tools/deploy-site.sh
set -euo pipefail
cd "$(dirname "$0")/../web"

npm run build

# The site may only talk to itself, the preview's price feed, and its relayer. If the relayer is
# somewhere other than api.tapemarket.io, the security policy has to name that origin instead.
API_URL="${VITE_API_URL:-https://api.tapemarket.io/v3}"
API_SCHEME="${API_URL%%://*}"
API_HOST="${API_URL#*://}"
API_HOST="${API_HOST%%/*}"
API_ORIGIN="${API_SCHEME}://${API_HOST}"
grep -v '^#' cloudflare.headers | sed "s#https://api.tapemarket.io#${API_ORIGIN}#g" | sed '/./,$!d' > dist/_headers

# The app is one page that draws every address itself. The host is told about each address it
# should answer (a file apiece), so that anything else, above all a script from a build that has
# been replaced, is a plain 404 and never the page. Keep this list in step with ROUTES in
# web/src/lib/route-preload.ts; web/e2e/live-core.mjs checks every page on the published site.
for page in trade jackpot portfolio vault staking leaderboard dashboard stats status docs referrals support; do
  cp dist/index.html "dist/${page}.html"
done
# What an address that is no page gets: the app, which then moves to the trade page.
cp dist/index.html dist/404.html

if [ -n "${WRANGLER_JS:-}" ]; then
  "${NODE22:-node}" "$WRANGLER_JS" deploy --config wrangler.jsonc
else
  npx wrangler deploy --config wrangler.jsonc
fi
