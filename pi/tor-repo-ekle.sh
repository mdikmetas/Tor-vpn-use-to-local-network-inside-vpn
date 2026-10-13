#!/usr/bin/env bash
# Tor Project'in kendi Debian deposunu ekler (deb.torproject.org): yeni Tor sürümleri Debian'dan önce buradan gelir.
# Kullanım:  sudo bash tor-repo-ekle.sh        (geri almak için: sudo bash tor-repo-ekle.sh --kaldir)
# Yalnızca amd64 ve arm64 desteklenir (32-bit Raspberry Pi OS = armhf desteklenmez).
set -euo pipefail

SRC="${TORPOOL_SRC_FILE:-/etc/apt/sources.list.d/tor.sources}"
KEYRING="${TORPOOL_KEYRING:-/usr/share/keyrings/deb.torproject.org-keyring.gpg}"
KEY_URL="https://deb.torproject.org/torproject.org/A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89.asc"
KEY_FPR="A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89"   # Tor Project paket imzalama anahtarı (resmi sayfadan doğrula)
DOC="https://support.torproject.org/apt/tor-deb-repo/"

if [ "$(id -u)" -ne 0 ] && [ -z "${TORPOOL_SRC_FILE:-}" ]; then
  echo "Şöyle çalıştır:  sudo bash tor-repo-ekle.sh"; exit 1
fi

if [ "${1:-}" = "--kaldir" ]; then
  rm -f "$SRC"
  apt-get update -y || true
  echo "Tor Project deposu kaldırıldı. Tor, Debian'ın kendi deposundan güncellenir."
  echo "(Kurulu Tor paketi olduğu gibi kalır; istersen:  sudo apt install --reinstall tor)"
  exit 0
fi

ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64|arm64) ;;
  *) echo "Bu mimari ($ARCH) Tor Project deposunda desteklenmiyor (yalnızca amd64 ve arm64)."
     echo "Tor güncellemesi için Debian'ın kendi deposunu beklemen gerekir."; exit 1 ;;
esac

CODENAME="${TORPOOL_CODENAME:-$(. /etc/os-release && echo "${VERSION_CODENAME:-}")}"
if [ -z "$CODENAME" ]; then echo "Debian kod adı bulunamadı (/etc/os-release)."; exit 1; fi

echo "[1/4] Gerekli paketler…"
apt-get install -y apt-transport-https gnupg wget ca-certificates

echo "[2/4] İmza anahtarı indiriliyor ve parmak izi doğrulanıyor…"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
wget -qO "$TMP/key.asc" "$KEY_URL"
GOT="$(gpg --show-keys --with-colons "$TMP/key.asc" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')"
if [ "$GOT" != "$KEY_FPR" ]; then
  echo "HATA: indirilen anahtarın parmak izi beklenenle uyuşmuyor."
  echo "  beklenen: $KEY_FPR"
  echo "  gelen   : ${GOT:-yok}"
  echo "Güvenlik için durduruldu. Güncel parmak izini şu sayfadan kontrol et: $DOC"
  exit 1
fi
gpg --dearmor < "$TMP/key.asc" > "$TMP/key.gpg"
install -m 644 "$TMP/key.gpg" "$KEYRING"

echo "[3/4] Depo ekleniyor ($CODENAME, $ARCH)…"
cat > "$SRC" <<EOT
Types: deb
URIs: https://deb.torproject.org/torproject.org/
Suites: $CODENAME
Components: main
Signed-By: $KEYRING
EOT
if ! apt-get update -y; then
  rm -f "$SRC"
  echo "HATA: depo güncellenemedi (kod adı '$CODENAME' desteklenmiyor olabilir). Depo geri alındı."
  echo "Ayrıntı: $DOC"; exit 1
fi

echo "[4/4] Tor kuruluyor/güncelleniyor…"
apt-get install -y tor deb.torproject.org-keyring
# Havuz kendi Tor'larını yönetir; paket kurulumu sistemin Tor servisini açmış olabilir
systemctl disable --now tor.service tor@default.service 2>/dev/null || true
echo
echo "Tamam. Kurulu Tor: $(dpkg-query -W -f='${Version}' tor)"
echo "Panelde 'Tor'u güncelle' ya da 'Boştaki oturumları yenile' ile çalışan oturumları yeni sürüme geçir."
