#!/bin/sh
# Deploy + run for legacy.vectraarch.live
#
# The SPA shell is now built by Vite into dist/ (gitignored). The Express server
# serves dist/index.html for `/`, so dist/ MUST exist before the service starts —
# otherwise GET / returns 404. Run this script on every deploy.
set -e
cd "$(dirname "$0")"

# --include=dev: vite + @vitejs/plugin-react are devDependencies and are required
# to build, even when the server runs with NODE_ENV=production.
npm install --include=dev

# Emit dist/index.html + dist/assets/*. set -e aborts the deploy on a build
# failure so we never (re)start the service pointing at a stale/empty dist/.
npm run build

# Start, or hot-reload if already running under pm2.
pm2 restart VectraArchLegacy --update-env 2>/dev/null \
  || pm2 start VectraArchLegacy.js --name VectraArchLegacy
