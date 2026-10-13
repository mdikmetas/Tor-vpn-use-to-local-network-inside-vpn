#!/usr/bin/env bash
# Firefox eklentisini Mozilla'ya (addons.mozilla.org) ÜCRETSİZ imzalatır.
# Gerekenler: Node.js, ücretsiz Mozilla hesabı ve API anahtarı:
#   https://addons.mozilla.org/developers/addon/api/key/   ->  "JWT issuer" ve "JWT secret"
#
# Kullanım:
#   export AMO_JWT_ISSUER="user:12345:67"
#   export AMO_JWT_SECRET="...."
#   bash sign-firefox.sh
#
# Sonuç: signed/ klasöründe imzalı .xpi. Pi'da indirme sayfasında görünmesi için:
#   scp signed/*.xpi KULLANICI@PI_IP:/tmp/firefox.xpi
#   ssh KULLANICI@PI_IP 'sudo install -m 644 /tmp/firefox.xpi /opt/torpool/firefox.xpi'
#
# Not: Eklentiyi her değiştirdiğinde firefox/manifest.json içindeki "version" artırılmalı (aynı sürüm tekrar imzalanamaz).
set -euo pipefail
cd "$(dirname "$0")"

: "${AMO_JWT_ISSUER:?AMO_JWT_ISSUER ayarlı değil (yukarıdaki bağlantıdan al)}"
: "${AMO_JWT_SECRET:?AMO_JWT_SECRET ayarlı değil}"
command -v npx >/dev/null || { echo "Node.js (npx) gerekli: https://nodejs.org"; exit 1; }

rm -rf signed
mkdir -p signed
npx --yes web-ext@8 sign \
  --source-dir firefox \
  --artifacts-dir signed \
  --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET" \
  --ignore-files preset.json

echo
ls -l signed/*.xpi
