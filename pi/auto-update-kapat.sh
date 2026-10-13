#!/usr/bin/env bash
# auto-update.sh'in yaptığı ayarları geri alır.  Kullanım:  sudo bash auto-update-kapat.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Şöyle çalıştır:  sudo bash auto-update-kapat.sh"
  exit 1
fi

AUTO=/etc/apt/apt.conf.d/20auto-upgrades
CONF=/etc/apt/apt.conf.d/52torpool-unattended
BAKDIR=/var/backups/torpool

# Kendi ayar dosyamızı sil
if [ -f "$CONF" ]; then
  rm -f "$CONF"
  echo "Silindi: $CONF"
else
  echo "Zaten yok: $CONF"
fi

# 20auto-upgrades: en eski yedek (auto-update.sh'ten önceki hâl) varsa onu geri yükle, yoksa sil
OLDEST="$(ls -1 "$BAKDIR"/20auto-upgrades.bak.* 2>/dev/null | sort | head -n 1 || true)"
if [ -n "$OLDEST" ]; then
  cp -a "$OLDEST" "$AUTO"
  echo "Geri yüklendi: $AUTO  (kaynak: $OLDEST)"
elif [ -f "$AUTO" ]; then
  rm -f "$AUTO"
  echo "Silindi: $AUTO"
else
  echo "Zaten yok: $AUTO"
fi

echo "Otomatik güncellemeler kapatıldı. (unattended-upgrades paketi kurulu kaldı; kaldırmak için: sudo apt-get remove unattended-upgrades)"
