#!/bin/bash
# Tor IP'yi Mac'te kurar. Node, Xcode, Homebrew GEREKMEZ (macOS'un kendi araçları yeter).
# Kullanım (Terminal'de):   bash Mac-Kur.sh
# Ne yapar: resmî Electron paketini indirir, uygulama dosyalarını içine koyar, "Tor IP.app" oluşturur.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
V=44.5.1

case "$(uname -m)" in
  arm64)  ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Desteklenmeyen işlemci: $(uname -m)"; exit 1 ;;
esac

for f in main.js preload.js package.json lib renderer build/icon.png; do
  if [ ! -e "$HERE/$f" ]; then
    echo "Eksik dosya: $f  (Mac-Kur.sh, uygulama dosyalarıyla aynı klasörde olmalı)"
    exit 1
  fi
done

if [ -w /Applications ]; then DEST="/Applications"; else DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
APP="$DEST/Tor IP.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Electron $V ($ARCH) indiriliyor (yaklaşık 120 MB)…"
curl -fL --progress-bar -o "$TMP/electron.zip" \
  "https://github.com/electron/electron/releases/download/v$V/electron-v$V-darwin-$ARCH.zip"

echo "Uygulama hazırlanıyor…"
ditto -x -k "$TMP/electron.zip" "$TMP/x"
rm -rf "$APP"
mv "$TMP/x/Electron.app" "$APP"

R="$APP/Contents/Resources"
rm -f "$R/default_app.asar"
mkdir -p "$R/app/build"
cp -R "$HERE/main.js" "$HERE/preload.js" "$HERE/package.json" "$HERE/lib" "$HERE/renderer" "$R/app/"
cp "$HERE/build/icon.png" "$R/app/build/icon.png"
sips -s format icns "$HERE/build/icon.png" --out "$R/electron.icns" >/dev/null 2>&1 || true
xattr -cr "$APP" 2>/dev/null || true

echo
echo "Tamam: $APP"
echo "Açılıyor… (Sonra Launchpad'den ya da Uygulamalar klasöründen de açabilirsin.)"
open "$APP"
