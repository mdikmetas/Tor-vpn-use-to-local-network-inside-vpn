# Tor IP: Raspberry Pi'da Tor havuzu, her cihaz için ayrı IP

Raspberry Pi'da çalışan küçük bir **Tor havuzu** ve ona bağlanan istemciler: **Chrome / Firefox eklentisi** ile **Windows / macOS masaüstü uygulaması**.
Her tarayıcı profili Pi'da **kendi Tor süreciyle**, yani kendi çıkış IP'siyle, kendi ülkesiyle ve kendi "IP değiştir" düğmesiyle çalışır.
Kiralık sunucu gerekmez; Pi senin ağında durur.

> Bu bir VPN değildir. Trafik Tor ağından geçer: gizlilik için uygundur, hız için değil. Ayrıntı için [Sınırlar](#sınırlar) bölümüne bak.

```
 Chrome / Firefox eklentisi ─┐                      ┌─ Tor (profil A) ─┐
 Masaüstü uygulaması ────────┼──►  torpool (Pi)  ───┼─ Tor (profil B) ─┼──► İnternet
 (her profil ayrı kimlik)    ┘   HTTP API + SOCKS   └─ Tor (profil C) ─┘
```

## Özellikler

**Pi tarafı (`pi/`)**
- Profil başına ayrı Tor süreci (ayrı SOCKS portu, ayrı çıkış IP'si), ülke seçimi, "IP değiştir" (NEWNYM), çıkış IP'si sabitleme
- Durum paneli (`/status`): oturumlar, tahmini çıkış IP'si, hız ölçümü, Tor sürümü
- Hazır oturum havuzu (varsayılan 2): Pi önceden N boşta Tor açık tutar, istemci bağlanınca bekleme olmaz
- Panelden **Tor güncelleme** ve isteğe bağlı otomatik güncelleme (servis root değil, ayrı bir root birimi yalnızca `tor` paketini yükseltir)
- Kendini toparlama: servis `Restart=always`, çöken Tor'u 30 sn içinde yeniden başlatma, Tor paketi güncellenince boştaki eski oturumları yenileme
- Ülke başına çıkış rölesi sayısı (Onionoo), köprü (bridge) desteği
- Erişim: yerel ağ izin listesi (`allowed_cidrs`), Bearer token, yanlış denemelerde IP kilidi

**Chrome / Firefox eklentisi (`src/` → `chrome/`, `firefox/`)**
- Ülke seç, **Bağlan**, IP değiştir
- Doğrudan çıkan siteler (banka, e-devlet, yapay zekâ siteleri, kripto borsaları vb. Tor'suz açılır)
- **"Sadece seçtiğim siteler Tor'dan çıksın"** modu: listedeki siteler Tor'dan, gerisi doğrudan. Tor bağlı değilse listedeki site açılmaz (gerçek IP'yle asla), isteğe bağlı otomatik bağlanma
- Sağlık izleme: her dakika Pi ve gerçek çıkış IP'si kontrol edilir, bildirim ve rozet
- WebRTC sızıntı koruması

**Masaüstü uygulaması (`desktop/`, Electron)**
- Profil başına ayrı tarayıcı (Chrome / Edge / Brave / Firefox) ve ayrı IP
- İki ayrı mod: **uygulama tabanlı** (yalnızca açılan tarayıcı Tor'dan çıkar) ve **sistem geneli** (işletim sistemi proxy'si)
- Kill switch (güvenlik duvarı), sağlık izleme, iyi çıkışları kaydetme, hızlı IP seçimi, Tailscale desteği

## Kurulum

### 1. Pi (bir kez)
Tüm klasörü Pi'a kopyala (`chrome`, `firefox` ve `pi` yan yana olmalı), sonra:

```bash
cd torpool/pi
sudo bash install.sh
```

Sonunda token'lı bir bağlantı yazdırılır. İstemcilerde bu bağlantıyı aç; eklentiyi oradan indirirsin, adres ve token hazır gelir.

İsteğe bağlı:
```bash
sudo bash auto-update.sh            # otomatik güvenlik güncellemeleri (--reboot: gerekirse gece yeniden başlat)
sudo bash tor-repo-ekle.sh          # Tor Project'in kendi deposu: yeni Tor sürümleri Debian'dan önce gelir (yalnızca arm64/amd64)
sudo nano /etc/torpool/bridges.txt  # Tor engelliyorsa köprüler
```

### 2. Eklenti
- **Chrome / Edge / Brave:** Pi'ın indirme sayfasından zip'i indir, kalıcı bir klasöre çıkar, `chrome://extensions` → Geliştirici modu → *Paketlenmemiş öğe yükle*. Her Chrome profilinde aynı klasörü yükleyebilirsin; her profil Pi'da ayrı oturum alır.
- **Firefox:** imzalı paket için `sign-firefox.sh`, ayrıntı [`KURULUM.txt`](KURULUM.txt) içinde.

### 3. Masaüstü uygulaması
GitHub Actions ile derle (Actions → *Masaüstü uygulamasını derle* → Run workflow) ya da yerelde:

```bash
cd desktop
npm install
npm start          # derlemeden dene
npm run dist:win   # veya dist:mac
```
Uygulama imzalı değildir; ilk açılış uyarıları ve macOS için `Mac-Kur.sh` anlatımı [`KURULUM.txt`](KURULUM.txt) içinde.

### Evden / başka ağdan kullanmak
Pi ofis ağındaysa ve dışarıdan erişim yoksa **Tailscale** kullan: Pi ve istemciye kur, Pi adresi olarak Tailscale IP'sini yaz ve Pi'da `allowed_cidrs` listesine `100.64.0.0/10` ekle (varsayılan yerel aralıkları silmeden). Ayrıntı: [`KURULUM.txt`](KURULUM.txt).

## Nasıl çalışıyor?
Her istemci (tarayıcı profili) kendi rastgele **oturum kimliğini** üretir ve Pi'a `POST /api/session` ile bildirir. Pi o kimlik için ayrı bir Tor süreci açar. Aynı kimlik tekrar gelirse aynı oturum kullanılır. Pi, "aktif" bağlantıyı gerçek trafikten değil, istemcinin her dakika attığı durum isteğinden çıkarır (panelde *Boşta* süresi). Oturumlar 72 saat (`idle_hours`) boşta kalırsa silinir.

## Yapılandırma
`/etc/torpool/config.json` (en az `token`; diğerleri isteğe bağlı):

| Anahtar | Varsayılan | Açıklama |
|---|---|---|
| `token` | (kurulumda üretilir) | API ve panel için gizli anahtar, en az 6 karakter |
| `api_port` | `8765` | API ve panel portu |
| `max_sessions` | `20` | En çok eşzamanlı oturum (havuz dahil). Pi panelinden ("En çok oturum sayısı") de değişir; panelden kaydedilen değer bu dosyadakini geçer |
| `idle_hours` | `72` | Boşta kalan oturumun silinme süresi |
| `allowed_cidrs` | yerel ağ aralıkları | Erişime izinli ağlar |

## Testler
```bash
node test/ext.test.js                                   # eklenti mantığı
for t in pi_status pi_recovery pi_pool pi_update pi_exits; do python3 test/$t.test.py; done
bash test/tor_repo.test.sh                              # Tor Project depo betiği (sahte apt ile)
cd desktop && npm test                                  # masaüstü uygulaması
```
Testler sahte Tor ile çalışır. Windows, macOS ve gerçek Pi üzerindeki davranışlar (sistem proxy'si, kill switch, apt güncellemesi) otomatik testle kapsanmaz.

## Sınırlar
- Tor yavaştır ve bazı siteler Tor çıkış IP'lerini engeller. Bu yüzden "doğrudan çıkan siteler" listesi var.
- Eklenti yalnızca tarayıcı trafiğini yönlendirir. Masaüstü *sistem geneli* modu proxy ayarını yok sayan uygulamaları (bazı oyunlar, torrent, VPN) kapsamaz ve UDP/WebRTC sızabilir.
- Kısa token yerel ağ için tasarlandı; Pi'ı internete açma. Uzaktan erişim için Tailscale kullan. Bkz. [`SECURITY.md`](SECURITY.md).
- Masaüstü uygulaması imzasızdır (Windows SmartScreen / macOS Gatekeeper uyarısı verir).

## Lisans
[MIT](LICENSE)
