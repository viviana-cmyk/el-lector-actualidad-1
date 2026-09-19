#!/bin/bash
# Uso: bash scripts/publicar-mindefensa.sh
# Parsea mindefensa/latest.xlsx y publica los datos nacionales.

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "▶ Parseando mindefensa/latest.xlsx..."
node scripts/parse-mindefensa.mjs

echo "▶ Subiendo al repositorio..."
git add src/data/mindefensa.nacional.json
git commit -m "chore(cifras): actualizar indicadores nacionales Mindefensa $(date +'%Y-%m')"
GIT_EXEC_PATH=/opt/homebrew/Cellar/git/2.54.0/libexec/git-core git pull --rebase origin main
GIT_EXEC_PATH=/opt/homebrew/Cellar/git/2.54.0/libexec/git-core git push origin main

echo "✓ Listo. El sitio se actualizará en unos minutos."
