#!/bin/bash
# VectraArch Legacy — Auth Guard Patch
# Run from: /var/www/vectraarch.live/legacy/
# Usage:    bash patch-auth-guard.sh

set -e
LEGACY_DIR="/var/www/vectraarch.live/legacy"
GUARD='<script src="/legacy/auth-guard.js"></script>'

echo "=== VectraArch Legacy Auth Guard Patch ==="
echo ""

# ── STEP 1: Add auth-guard.js to every HTML page that needs it ────────────────
# We insert it as the very first <script> tag in <head>.
# Pages to patch: index.html, admin.html, calendar.html, finances.html, profilesettings.html
# login.html is excluded — it IS the login page.

for FILE in index.html admin.html calendar.html finances.html profilesettings.html; do
  FILEPATH="$LEGACY_DIR/$FILE"
  if [ ! -f "$FILEPATH" ]; then
    echo "  SKIP  $FILE (not found)"
    continue
  fi

  # Skip if guard already added
  if grep -q "auth-guard.js" "$FILEPATH"; then
    echo "  SKIP  $FILE (guard already present)"
    continue
  fi

  # Insert guard as first line after <head> opening tag
  # Uses sed to find the first <script src= line and insert before it
  sed -i "0,/<script /s|<script |${GUARD}\n  <script |" "$FILEPATH"
  echo "  PATCH $FILE — auth guard injected"
done

echo ""

# ── STEP 2: Replace 'index.html' redirect targets with 'login.html' ──────────
# In all Legacy pages EXCEPT index.html and login.html themselves,
# every window.location.href = 'index.html' should go to 'login.html'.
# Same for href="index.html" anchor tags.

for FILE in admin.html calendar.html finances.html profilesettings.html; do
  FILEPATH="$LEGACY_DIR/$FILE"
  if [ ! -f "$FILEPATH" ]; then
    echo "  SKIP  $FILE (not found)"
    continue
  fi

  COUNT=$(grep -c "index\.html" "$FILEPATH" 2>/dev/null || echo 0)
  if [ "$COUNT" -eq 0 ]; then
    echo "  SKIP  $FILE (no index.html references)"
    continue
  fi

  # Backup before editing
  cp "$FILEPATH" "${FILEPATH}.bak2"

  # Replace all occurrences of 'index.html' (in JS string context and href context)
  sed -i "s|'index\.html'|'login.html'|g" "$FILEPATH"
  sed -i 's|"index\.html"|"login.html"|g' "$FILEPATH"

  echo "  PATCH $FILE — $COUNT reference(s) updated: index.html → login.html"
done

# ── STEP 3: In index.html itself, redirect unauthenticated users ──────────────
# The auth-guard.js handles this now, but we also ensure any internal
# logout/auth-fail redirects in index.html go to login.html not index.html.
# (index.html redirecting to itself would cause a loop)

FILEPATH="$LEGACY_DIR/index.html"
if [ -f "$FILEPATH" ]; then
  cp "$FILEPATH" "${FILEPATH}.bak2"
  # Only replace JS string occurrences (not meta or link references)
  sed -i "s|href: 'index\.html'|href: 'login.html'|g" "$FILEPATH"
  sed -i "s|= 'index\.html'|= 'login.html'|g" "$FILEPATH"
  sed -i 's|= "index\.html"|= "login.html"|g' "$FILEPATH"
  echo "  PATCH index.html — logout/auth-fail redirects → login.html"
fi

echo ""
echo "=== Done. No server restart needed — static files served directly. ==="
echo ""
echo "Verify the guard loaded:"
echo "  curl -s https://vectraarch.live/legacy/auth-guard.js | head -3"
echo ""
echo "Test the redirect:"
echo "  Open https://vectraarch.live/legacy/ in a private window (no localStorage)"
echo "  Should land on /legacy/login.html"
