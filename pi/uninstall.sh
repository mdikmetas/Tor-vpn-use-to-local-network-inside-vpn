#!/usr/bin/env bash
# Tor havuzunu kaldırır.  Kullanım:  sudo bash uninstall.sh
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Şöyle çalıştır:  sudo bash uninstall.sh"; exit 1; fi
systemctl disable --now torpool-update.path torpool.service 2>/dev/null || true
rm -f /etc/systemd/system/torpool.service /etc/systemd/system/torpool-update.service /etc/systemd/system/torpool-update.path
systemctl daemon-reload
rm -rf /opt/torpool /var/lib/torpool
echo "Kaldırıldı. Ayarlar /etc/torpool içinde duruyor (token, köprüler); istersen sil:  sudo rm -rf /etc/torpool"
