#!/usr/bin/env bash
# Tor paketini günceller. root olarak, torpool-update.service tarafından çalıştırılır
# (panelden "Tor'u güncelle" denince torpool bir istek dosyası bırakır, systemd bu betiği başlatır).
# Servisin kendisi root DEĞİL; bu betik sabit bir iş yapar: yalnızca "tor" paketini yükseltir.
set -u
SD="${TORPOOL_STATE:-/var/lib/torpool}"
LOG="$SD/update.log"
ST="$SD/update-status"

status() {  # status <durum> <mesaj>   (mesajda tırnak ve ters bölü olmamalı)
  printf '{"state":"%s","msg":"%s","ts":%s}\n' "$1" "$2" "$(date +%s)" > "$ST.tmp"
  chown torpool:torpool "$ST.tmp" 2>/dev/null || true
  mv -f "$ST.tmp" "$ST"
}
ver() { dpkg-query -W -f='${Version}' tor 2>/dev/null || echo "yok"; }

rm -f "$SD/update-request"
: > "$LOG"
before="$(ver)"
status running "Paket listesi yenileniyor"
apt-get update -o DPkg::Lock::Timeout=180 >> "$LOG" 2>&1 || echo "(uyari: apt update tam basarili degil)" >> "$LOG"
status running "Tor yukseltiliyor"
if ! DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade -o DPkg::Lock::Timeout=180 tor >> "$LOG" 2>&1; then
  status error "Tor guncellenemedi. Ayrinti: /var/lib/torpool/update.log"
  chown torpool:torpool "$LOG" 2>/dev/null || true
  exit 1
fi
after="$(ver)"
# Sistemin kendi Tor servisi kapalı kalmalı (havuz kendi Tor'larını yönetir); paket kurulumu onu açmış olabilir
systemctl disable --now tor.service tor@default.service >> "$LOG" 2>&1 || true
if [ "$before" = "$after" ]; then
  status done "Zaten guncel: $after"
else
  status done "Guncellendi: $before -> $after"
fi
chown torpool:torpool "$LOG" 2>/dev/null || true
