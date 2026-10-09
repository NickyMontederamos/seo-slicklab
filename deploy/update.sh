#!/usr/bin/env bash
# Update seo.slicklab.digital to the latest main and reinstall packages if they changed.
set -euo pipefail
cd "$(dirname "$0")/.."
before=$(git rev-parse HEAD 2>/dev/null || echo none)
git fetch -q origin main
git reset -q --hard origin/main
if [ "$before" = none ] || ! git diff --quiet "$before" HEAD -- package.json package-lock.json; then
  npm ci --omit=dev --omit=optional --no-audit --no-fund
fi
chown -R www:www . 2>/dev/null || true
node seo-slicklab.js --version >/dev/null 2>&1 || node -e "require('./seo-slicklab.js')"
echo "Now at $(git log --oneline -1)"
