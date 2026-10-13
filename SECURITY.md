# Güvenlik

## Tehdit modeli
Pi servisi **yerel ağ için** tasarlandı. Erişim iki katmanla sınırlanır:
- `allowed_cidrs`: yalnızca bu ağlardan gelen istekler kabul edilir (varsayılan: yerel/özel aralıklar).
- Bearer **token**: API ve panel için gerekli. Token kısa tutulabildiği için (en az 6 karakter) bir IP, 10 dakika içinde 8 yanlış denemeden sonra 10 dakika kilitlenir.

## Yapmaman gerekenler
- Pi'ın API portunu (`8765`) internete açma. Uzaktan erişim için [Tailscale](https://tailscale.com) gibi bir özel ağ kullan ve `allowed_cidrs` içine yalnızca `100.64.0.0/10` ekle.
- Token'ı depoya koyma. `config.json` `.gitignore` içindedir; indirme bağlantılarındaki `?t=TOKEN` kısmını paylaşma.
- Token'ın sızdıysa: `/etc/torpool/config.json` içindeki `token` değerini değiştir, `sudo systemctl restart torpool`, istemcilerde yeniden gir.

## Tasarım notları
- Servis root değildir (`User=torpool`, `NoNewPrivileges=true`). Panelden Tor güncelleme, servisin root olmasına gerek kalmadan çalışır: servis bir istek dosyası bırakır, ayrı bir systemd birimi yalnızca `apt-get install --only-upgrade tor` komutunu çalıştırır.
- Eklenti "Sadece seçtiğim siteler" modunda Tor bağlı değilken listedeki siteleri engeller; gerçek IP'yle açmaz. Yine de tarayıcıdan gelen DNS ön çözümlemesi ve WebRTC gibi kanallar için `browserleaks.com` ile kendi kurulumunu doğrula.
- Masaüstü uygulaması imzasızdır; yalnızca kaynağını kontrol ettiğin derlemeleri çalıştır.

## Açık bildirme
Bir güvenlik sorunu bulursan herkese açık bir issue açmadan önce depo sahibine özel olarak yaz (GitHub'ın *Security → Report a vulnerability* bölümü).
