#!/usr/bin/env bash
# Raspberry Pi OS üzerinde Tor havuzunu kurar.  Kullanım:  sudo bash install.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Şöyle çalıştır:  sudo bash install.sh"
  exit 1
fi

if [ ! -d ../chrome ] || [ ! -d ../firefox ]; then
  echo "Eklenti klasörleri bulunamadı. 'pi' klasörünü tek başına değil, TÜM torpool klasörünü Pi'a kopyala"
  echo "(torpool/chrome, torpool/firefox ve torpool/pi yan yana olmalı)."
  exit 1
fi

echo "[1/5] Paketler kuruluyor…"
# Bozuk üçüncü taraf bir depo (ör. yanlış Docker adresi) update'i hata ile bitirse de
# diğer depoların listeleri yenilenir; tor Debian'ın kendi deposundan kurulabilir.
apt-get update -y || echo "  (uyarı: bazı apt depoları güncellenemedi, kuruluma devam ediliyor)"
apt-get install -y tor tor-geoipdb python3
apt-get install -y obfs4proxy 2>/dev/null || apt-get install -y lyrebird 2>/dev/null \
  || echo "  (köprü programı kurulamadı; köprü kullanmayacaksan sorun değil)"
apt-get install -y snowflake-client 2>/dev/null || true

echo "[2/5] Sistemin kendi Tor servisi kapatılıyor (havuz kendi Tor'larını yönetir)…"
systemctl disable --now tor.service tor@default.service 2>/dev/null || true

echo "[3/5] Kullanıcı ve klasörler…"
id torpool >/dev/null 2>&1 || useradd --system --home-dir /var/lib/torpool --shell /usr/sbin/nologin torpool
mkdir -p /opt/torpool /etc/torpool /var/lib/torpool
install -m 755 torpool.py /opt/torpool/torpool.py
install -m 755 update-tor.sh /opt/torpool/update-tor.sh
rm -rf /opt/torpool/ext
mkdir -p /opt/torpool/ext
cp -r ../chrome ../firefox /opt/torpool/ext/
find /opt/torpool/ext -name 'preset.json' -delete
chmod -R a+rX /opt/torpool

if [ ! -f /etc/torpool/config.json ]; then
  TOKEN="$(python3 -c 'import secrets,string; a=string.ascii_lowercase+string.digits; print(''.join(secrets.choice(a) for _ in range(6)))')"
  cat > /etc/torpool/config.json <<EOF
{
  "token": "$TOKEN",
  "api_port": 8765,
  "max_sessions": 20,
  "idle_hours": 72
}
EOF
fi

if [ ! -f /etc/torpool/bridges.txt ]; then
  cat > /etc/torpool/bridges.txt <<'EOF'
# Tor engelleniyorsa buraya her satıra bir köprü yaz
# (bridges.torproject.org veya Telegram'da @GetBridgesBot).
# Örnek:
# obfs4 1.2.3.4:443 FINGERPRINT cert=... iat-mode=0
# Değişiklikten sonra:  sudo systemctl restart torpool
EOF
fi

chown -R torpool:torpool /var/lib/torpool
chown root:torpool /etc/torpool/config.json /etc/torpool/bridges.txt
chmod 640 /etc/torpool/config.json /etc/torpool/bridges.txt

echo "[4/5] Servis kuruluyor…"
install -m 644 torpool.service /etc/systemd/system/torpool.service
# Panelden "Tor'u güncelle": servis root değil; istek dosyasını izleyen ayrı bir root birimi yalnızca tor paketini yükseltir
install -m 644 torpool-update.service /etc/systemd/system/torpool-update.service
install -m 644 torpool-update.path /etc/systemd/system/torpool-update.path
rm -f /var/lib/torpool/update-request
systemctl daemon-reload
systemctl enable --now torpool-update.path
systemctl enable torpool.service
systemctl restart torpool.service
sleep 2
if ! systemctl is-active --quiet torpool.service; then
  echo "Servis başlamadı. Ayrıntı:  journalctl -u torpool -n 30"
  exit 1
fi

echo "[5/5] Hazır."
IP="$(hostname -I | awk '{print $1}')"
PORT="$(python3 -c 'import json;print(json.load(open("/etc/torpool/config.json")).get("api_port", 8765))')"
TOKEN="$(python3 -c 'import json;print(json.load(open("/etc/torpool/config.json"))["token"])')"
echo
echo "=============================================================="
echo " KURULDU. Her bilgisayarda tarayıcıdan şu bağlantıyı aç,"
echo " eklentiyi oradan indir (adres ve token zaten içinde hazır gelir):"
echo
echo "   http://${IP}:${PORT}/?t=${TOKEN}"
echo
echo " Durum paneli (oturumlar, çıkış IP'leri, ölçüm):"
echo "   http://${IP}:${PORT}/status?t=${TOKEN}"
echo
echo " Elle yapıştırmak istersen Pi adresi:  ${IP}:${PORT}#${TOKEN}"
echo " (Bağlantıyı tekrar görmek için bu betiği yeniden çalıştır; ayarların silinmez.)"
echo " Otomatik güvenlik güncellemeleri için:  sudo bash auto-update.sh"
echo " Tor yeni sürümleri Debian'dan önce almak için (arm64/amd64):  sudo bash tor-repo-ekle.sh"
echo " Pi'a sabit IP ver (router'dan DHCP rezervasyonu), yoksa adres değişir."
echo "=============================================================="
