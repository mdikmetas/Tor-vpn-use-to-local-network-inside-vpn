#!/usr/bin/env bash
# tor-repo-ekle.sh testi: sahte dpkg/apt-get/wget/gpg ile (gerçek sisteme dokunmaz)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
D="$(mktemp -d)"; mkdir "$D/bin"
mk() { printf '#!/bin/sh\n%s\n' "$2" > "$D/bin/$1"; chmod +x "$D/bin/$1"; }
mk dpkg 'if [ "$1" = "--print-architecture" ]; then echo ${FAKE_ARCH:-arm64}; fi'
mk dpkg-query 'echo 0.4.9.13-0+deb12u1'
mk apt-get 'echo apt-get "$@" >> '"$D"'/apt.log; [ -n "${FAKE_APT_FAIL:-}" ] && case "$*" in *update*) exit 1;; esac; exit 0'
mk wget 'echo KEY > "$2"'
mk gpg 'case "$*" in *--show-keys*) echo "fpr:::::::::${FAKE_FPR:-A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89}:";; *--dearmor*) cat;; esac'
mk systemctl 'exit 0'
export PATH="$D/bin:$PATH" TORPOOL_SRC_FILE="$D/tor.sources" TORPOOL_KEYRING="$D/keyring.gpg" TORPOOL_CODENAME=bookworm
ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; exit 1; }
S="$HERE/../pi/tor-repo-ekle.sh"
bash "$S" >/dev/null 2>&1 || bad "normal kurulum başarısız"
grep -q "Suites: bookworm" "$D/tor.sources" && [ -f "$D/keyring.gpg" ] && ok "arm64: depo ve anahtar yazıldı" || bad "depo yazılmadı"
grep -q "install -y tor deb.torproject.org-keyring" "$D/apt.log" && ok "tor + keyring paketi kuruldu" || bad "paket kurulmadı"
rm -f "$D/tor.sources" "$D/keyring.gpg"
FAKE_FPR=AAAA bash "$S" >/dev/null 2>&1 && bad "yanlış parmak izi kabul edildi"
[ ! -f "$D/tor.sources" ] && [ ! -f "$D/keyring.gpg" ] && ok "yanlış parmak izi: durdu, hiçbir şey yazılmadı" || bad "yanlış parmak izinde dosya yazıldı"
FAKE_ARCH=armhf bash "$S" >/dev/null 2>&1 && bad "armhf kabul edildi"; ok "armhf reddedildi"
FAKE_APT_FAIL=1 bash "$S" >/dev/null 2>&1 && bad "apt update hatası geçti"
[ ! -f "$D/tor.sources" ] && ok "apt update hatasında depo geri alındı" || bad "depo geri alınmadı"
touch "$D/tor.sources"; bash "$S" --kaldir >/dev/null 2>&1; [ ! -f "$D/tor.sources" ] && ok "--kaldir depoyu sildi" || bad "--kaldir çalışmadı"
echo; echo "TOR DEPO TESTLERİ GEÇTİ"
