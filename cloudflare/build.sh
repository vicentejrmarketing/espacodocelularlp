#!/usr/bin/env bash
# Build do Cloudflare Pages: copia só os arquivos públicos do site para dist/
# (as funções do servidor ficam em functions/ e api/ e não são publicadas como arquivos).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
cp index.html pre-analise.html central.html lojas.js dist/
cp -r fotos videos dist/
cp cloudflare/_headers dist/_headers
echo "dist/ pronto:"; ls -la dist
