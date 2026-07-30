#!/usr/bin/env bash
#
# Veröffentlicht packages/annotation-editor als eigenständiges GitHub-Repo
# via `git subtree split` und taggt die Version aus package.json.
#
# Voraussetzungen:
#   - Ausführung im Root des Workspace-Repos (dort, wo packages/ liegt)
#   - Das Ziel-Repo existiert auf GitHub (leer anlegen, ohne README/License)
#   - Push-Rechte auf das Ziel-Repo (SSH-Key oder HTTPS-Token)
#
# Verwendung:
#   ./packages/annotation-editor/scripts/publish-to-github.sh [remote-url]
#
#   remote-url  optional, Default: git@github.com:tolympsport/annotation-editor.git
#
# Danach in der Host-App (z. B. Modulo-CAD) installieren:
#   "dependencies": {
#     "@tolympsport/annotation-editor": "github:tolympsport/annotation-editor#v1.0.0"
#   }
# Beim Install baut das `prepare`-Script automatisch dist/ (ESM, d.ts, styles.css).

set -euo pipefail

PREFIX="packages/annotation-editor"
REMOTE_URL="${1:-git@github.com:tolympsport/annotation-editor.git}"
SPLIT_BRANCH="annotation-editor-split"

# Im Repo-Root ausführen
if [ ! -d "$PREFIX" ] || [ ! -d .git ]; then
  echo "FEHLER: Bitte im Root des Workspace-Repos ausführen (dort, wo $PREFIX liegt)." >&2
  exit 1
fi

VERSION="v$(node -p "require('./$PREFIX/package.json').version")"
echo "==> Paketversion: $VERSION"
echo "==> Ziel-Repo:    $REMOTE_URL"

# 1) Historie des Unterverzeichnisses als eigenen Branch extrahieren
echo "==> git subtree split (kann bei großer Historie etwas dauern) ..."
git subtree split --prefix="$PREFIX" -b "$SPLIT_BRANCH"

# 2) Split-Branch als main ins Ziel-Repo pushen
echo "==> Push nach $REMOTE_URL (main) ..."
git push "$REMOTE_URL" "$SPLIT_BRANCH:main" --force-with-lease=main

# 3) Version taggen und Tag pushen
SPLIT_SHA="$(git rev-parse "$SPLIT_BRANCH")"
echo "==> Tagge $VERSION auf $SPLIT_SHA ..."
git tag -f "$VERSION" "$SPLIT_BRANCH"
git push "$REMOTE_URL" "refs/tags/$VERSION" --force

# 4) Lokalen Split-Branch aufräumen (Tag bleibt lokal bestehen)
git branch -D "$SPLIT_BRANCH"

cat <<EOF

Fertig. Installation in der Host-App verifizieren:

  mkdir -p /tmp/ae-verify && cd /tmp/ae-verify && npm init -y
  npm install "github:tolympsport/annotation-editor#$VERSION"
  ls node_modules/@tolympsport/annotation-editor/dist   # index.js, tiptap.js, *.d.ts, styles.css

Für ein neues Release: Version in $PREFIX/package.json erhöhen,
committen und dieses Script erneut ausführen.
EOF
