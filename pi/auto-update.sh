#!/usr/bin/env bash
# Otomatik güvenlik güncellemelerini açar (unattended-upgrades).  Kullanım:  sudo bash auto-update.sh
# Kernel gibi yeniden başlatma isteyen güncellemelerden sonra Pi'ı gece kendiliğinden yeniden başlatmak için:  sudo bash auto-update.sh --reboot
# Birden fazla kez çalıştırılabilir. Geri almak için:  sudo bash auto-update-kapat.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Şöyle çalıştır:  sudo bash auto-update.sh"
  exit 1
fi

REBOOT=false
[ "${1:-}" = "--reboot" ] && REBOOT=true
STAMP="$(date +%Y%m%d-%H%M%S)"
AUTO=/etc/apt/apt.conf.d/20auto-upgrades
CONF=/etc/apt/apt.conf.d/52torpool-unattended
# Yedekler apt.conf.d dışında tutulur: apt, ".bak.<tarih>" uzantılı dosyaları yok saymaz ve eski ayarı yeniden okurdu.
BAKDIR=/var/backups/torpool
mkdir -p "$BAKDIR"

# install_conf <hedef> <yeni-içerik-dosyası>: içerik değiştiyse eskisini yedekleyip yazar (tekrar çalıştırmak güvenli)
install_conf() {
  if [ -f "$1" ] && cmp -s "$1" "$2"; then
    echo "  değişiklik yok: $1"
    return 0
  fi
  if [ -f "$1" ]; then
    cp -a "$1" "$BAKDIR/$(basename "$1").bak.$STAMP"
    echo "  yedek alındı: $BAKDIR/$(basename "$1").bak.$STAMP"
  fi
  install -m 644 "$2" "$1"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[1/4] unattended-upgrades kuruluyor…"
# Bozuk üçüncü taraf bir depo update'i hata ile bitirse de kuruluma devam edilir (install.sh ile aynı).
apt-get update -y || echo "  (uyarı: bazı apt depoları güncellenemedi, kuruluma devam ediliyor)"
apt-get install -y unattended-upgrades

echo "[2/4] Günlük güncelleme ayarı yazılıyor…"
cat > "$TMP/auto" <<'EOT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOT
install_conf "$AUTO" "$TMP/auto"

echo "[3/4] Güncelleme kaynakları yazılıyor…"
{
  echo '// torpool: otomatik güvenlik güncellemeleri (auto-update.sh tarafından yazıldı)'
  echo '// Mevcut Origins-Pattern listesine EKLER (:: kullanılır), başka ayarı silmez.'
  echo 'Unattended-Upgrade::Origins-Pattern:: "origin=Debian,codename=${distro_codename},label=Debian";'
  echo 'Unattended-Upgrade::Origins-Pattern:: "origin=Debian,codename=${distro_codename}-updates,label=Debian";'
  echo 'Unattended-Upgrade::Origins-Pattern:: "origin=Debian,codename=${distro_codename},label=Debian-Security";'
  echo 'Unattended-Upgrade::Origins-Pattern:: "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";'
  echo 'Unattended-Upgrade::Origins-Pattern:: "origin=Raspberry Pi Foundation,codename=${distro_codename}";'
  if grep -rqs "torproject" /etc/apt/sources.list.d/ 2>/dev/null; then
    echo 'Unattended-Upgrade::Origins-Pattern:: "site=deb.torproject.org";'
    echo "  (Tor Project deposu bulundu: Tor da otomatik güncellenecek)" >&2
  fi
  if $REBOOT; then
    echo 'Unattended-Upgrade::Automatic-Reboot "true";'
    echo 'Unattended-Upgrade::Automatic-Reboot-Time "04:30";'
    echo "  (Gerekirse Pi her gece 04:30'da kendiliğinden yeniden başlatılacak; torpool oturumları açılışta geri gelir)" >&2
  else
    echo 'Unattended-Upgrade::Automatic-Reboot "false";'
  fi
  echo 'Unattended-Upgrade::Remove-Unused-Dependencies "false";'
} > "$TMP/conf"
install_conf "$CONF" "$TMP/conf"

echo "[4/4] Deneme çalıştırması (hiçbir şey kurulmaz)…"
unattended-upgrade --dry-run -d 2>&1 | tail -n 15 || echo "  (uyarı: deneme çalıştırması hata verdi; ayrıntı için günlüğe bak)"

echo
echo "=============================================================="
echo " Otomatik güvenlik güncellemeleri AÇIK. Yeniden başlatma yapılmaz."
echo " Günlükler:   ls /var/log/unattended-upgrades/"
echo "              sudo tail -n 50 /var/log/unattended-upgrades/unattended-upgrades.log"
echo " Not: Tor güncellenirse çalışan oturumlar eski sürümde kalır;"
echo "      durum panelindeki 'Boştaki oturumları yenile' düğmesini kullan."
echo " Kapatmak için:  sudo bash auto-update-kapat.sh"
echo "=============================================================="
