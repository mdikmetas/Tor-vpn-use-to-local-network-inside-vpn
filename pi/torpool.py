#!/usr/bin/env python3
"""torpool: tarayıcı profili başına ayrı bir Tor süreci yöneten küçük HTTP servisi (Raspberry Pi).

Her tarayıcı profili kendi rastgele kimliğiyle bir "oturum" açar. Oturum başına:
  - ayrı bir Tor süreci (ayrı devreler = ayrı IP),
  - ayrı SOCKS portu (ev ağına açık) ve ayrı kontrol portu (sadece 127.0.0.1),
  - ayrı çıkış ülkesi ve bağımsız "IP değiştir".
"""
import hmac
import html
import io
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

VERSION = "1.0"
CONFIG_PATH = os.environ.get("TORPOOL_CONFIG", "/etc/torpool/config.json")
ID_RE = re.compile(r"^[a-f0-9]{8,32}$")
CC_RE = re.compile(r"^(auto|[a-z]{2})$")
SEED_FILES = ("cached-certs", "cached-microdesc-consensus", "cached-microdescs", "cached-microdescs.new")

DEFAULTS = {
    "token": "",
    "api_bind": "0.0.0.0",
    "api_port": 8765,
    "socks_bind": "0.0.0.0",
    "socks_base": 9200,
    "control_base": 9300,
    "max_sessions": 20,
    "allowed_cidrs": ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "idle_hours": 72,
    "tor_bin": "/usr/bin/tor",
    "geoip": "/usr/share/tor/geoip",
    "geoip6": "/usr/share/tor/geoip6",
    "state_dir": "/var/lib/torpool",
    "bridges_file": "/etc/torpool/bridges.txt",
    "ext_dir": "/opt/torpool/ext",              # ext/chrome ve ext/firefox klasörleri
    "firefox_xpi": "/opt/torpool/firefox.xpi",  # (isteğe bağlı) Mozilla'dan imzalı paket
    "exits_url": "https://onionoo.torproject.org/details?flag=Exit&running=true&fields=country",
    "exits_ttl": 3600,                          # ülke başına çıkış rölesi sayısı önbellek süresi (sn)
    "probe_host": "check.torproject.org",       # hız/gecikme ölçümü hedefi (yalnız istek üzerine)
    "probe_port": 443,
    "probe_path": "/api/ip",
    "probe_tls": True,
}

FP_RE = re.compile(r"^[0-9A-Fa-f]{40}$")
HOST_RE = re.compile(r"^[A-Za-z0-9._-]{1,253}$")


PAGE = """<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tor IP eklentisi</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;padding:24px 16px;font:15px/1.5 system-ui,Segoe UI,sans-serif;background:#1b1b24;color:#e8e8ee}
 main{max-width:640px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:24px 0 6px}
 p,li{color:#c8c8d4} code,pre{background:#262633;border-radius:6px;padding:2px 6px}
 pre{padding:10px;overflow:auto;user-select:all}
 a.btn{display:inline-block;margin:6px 8px 6px 0;padding:10px 14px;border-radius:8px;background:#7d4cdb;color:#fff;text-decoration:none;font-weight:600}
 a.btn.sec{background:#3a3a4c} .card{background:#20202b;border-radius:10px;padding:14px 16px;margin-top:14px}
 .warn{color:#f0b429}
</style></head><body><main>
<h1>Tor IP eklentisi</h1>
<p>Bu Raspberry Pi'daki Tor'a bağlanır: ülke seç, tek tıkla IP değiştir. Her tarayıcı profilinin IP'si ayrıdır.</p>
%BODY%
</main></body></html>"""


STATUS_PAGE = """<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tor havuzu durumu</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;padding:24px 16px;font:15px/1.5 system-ui,Segoe UI,sans-serif;background:#1b1b24;color:#e8e8ee}
 main{max-width:1000px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px} p{color:#c8c8d4;margin:4px 0}
 .card{background:#20202b;border-radius:10px;padding:14px 16px;margin-top:14px;overflow:auto}
 .banner{background:#4a1d24;border:1px solid #e5606a;color:#ffd7da;border-radius:10px;padding:12px 16px;margin-top:14px}
 .hidden{display:none}
 table{border-collapse:collapse;width:100%;min-width:720px}
 th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #2e2e3c;white-space:nowrap}
 th{color:#9a9ab0;font-weight:600;font-size:13px}
 code{background:#262633;border-radius:6px;padding:2px 6px}
 .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:#e5606a}
 .dot.ok{background:#4cd08a} .dot.wait{background:#f0b429} .dot.off{background:#e5606a}
 .ok{color:#4cd08a} .bad{color:#e5606a} .warn{color:#f0b429} .muted{color:#9a9ab0}
 button{padding:6px 12px;border:0;border-radius:8px;background:#7d4cdb;color:#fff;font-weight:600;cursor:pointer}
 button.sec{background:#3a3a4c}
 button:disabled{background:#3a3a4c;color:#9a9ab0;cursor:default}
 .bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px}
</style></head><body><main>
<h1>Tor havuzu durumu</h1>
<p id="hdr" class="muted">Yükleniyor...</p>
<div id="banner" class="banner hidden">Tor güncellendi; çalışan oturumlar eski sürümde. 'Boştaki oturumları yenile' ile yenile.</div>
<p id="err" class="warn"></p>
<div class="bar"><span id="tot"></span>
 <button id="rst" class="sec" type="button">Boştaki oturumları yenile</button><button id="purge" class="sec" type="button">1 saatten uzun boşta olanları sil</button><button id="purgenr" class="sec" type="button">Bağlanamayanları sil</button><span id="rstmsg" class="muted"></span></div>
<div class="card"><b>Tor sürümü</b>
 <p id="torver" class="muted">...</p>
 <div class="bar" style="margin-top:6px"><button id="torupd" type="button">Tor'u güncelle</button><span id="torupdmsg" class="muted"></span></div>
 <label style="display:block;margin-top:10px"><input id="torauto" type="checkbox"> Otomatik güncelle (6 saatte bir kontrol eder, yeni sürüm varsa kurar)</label></div>
<div class="card"><b>Boşta kalan oturumun silinme süresi</b>
 <p class="muted">Bir profil bu kadar saat hiç istek atmazsa Pi oturumunu siler (varsayılan 72). Hazır havuz oturumları silinmez.</p>
 <div class="bar" style="margin-top:6px"><input id="idlehrs" type="number" min="1" max="8760" value="72" style="width:80px;padding:6px;border-radius:8px;border:1px solid #3a3a4c;background:#262633;color:inherit"> saat
 <button id="idlesave" type="button">Kaydet</button><span id="idlemsg" class="muted"></span></div></div>
<div class="card"><b>En çok oturum sayısı</b>
 <p class="muted">Pi'da aynı anda en fazla bu kadar Tor oturumu (profil + hazır havuz) olabilir (varsayılan 20). Her oturum ayrı bir Tor sürecidir; Pi 4 / 4 GB için 10-15 rahattır. Sınırı düşürmek mevcut oturumları silmez.</p>
 <div class="bar" style="margin-top:6px"><input id="maxs" type="number" min="1" max="100" value="20" style="width:70px;padding:6px;border-radius:8px;border:1px solid #3a3a4c;background:#262633;color:inherit">
 <button id="maxsave" type="button">Kaydet</button><span id="maxmsg" class="muted"></span></div></div>
<div class="card"><b>Hazır oturum havuzu</b>
 <p class="muted">Pi bu kadar boşta Tor oturumunu önceden açık tutar. Bir eklenti/uygulama ilk kez bağlanınca bunlardan birini alır (bekleme olmaz), Pi yenisini açar. 0 = kapalı.</p>
 <div class="bar" style="margin-top:6px"><input id="poolsz" type="number" min="0" value="0" style="width:70px;padding:6px;border-radius:8px;border:1px solid #3a3a4c;background:#262633;color:inherit">
 <button id="poolsave" type="button">Kaydet</button><span id="poolmsg" class="muted"></span></div></div>
<div class="card"><table>
 <thead><tr><th>Oturum</th><th>Ülke</th><th>Durum</th><th>Bootstrap</th><th>Tahmini çıkış IP / röle</th><th>Boşta</th><th>Ölçüm</th><th></th></tr></thead>
 <tbody id="rows"></tbody>
</table></div>
<p class="muted">Çıkış IP'si tahminidir: Tor hangi devrenin şu an kullanıldığını bildirmez. Kesin sonuç için "Ölç" düğmesini kullan.</p>
<script>
(function(){
 var tok=new URLSearchParams(location.search).get("t")||"";
 try{history.replaceState(null,"",location.pathname);}catch(e){}
 var hdr={"Authorization":"Bearer "+tok};
 var busy={},results={},poolDirty=false,idleDirty=false,maxDirty=false;
 function $(id){return document.getElementById(id);}
 function el(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;}
 function dur(s){s=Math.max(0,Math.floor(s));var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  if(d)return d+" gün "+h+" sa";if(h)return h+" sa "+m+" dk";if(m)return m+" dk";return s+" sn";}
 function probeCell(id){
  var td=el("td");var r=results[id];
  var b=el("button",busy[id]?"Ölçülüyor...":"Ölç");b.type="button";b.disabled=!!busy[id];
  b.addEventListener("click",function(){probe(id);});td.appendChild(b);
  if(r){td.appendChild(document.createTextNode(" "));
   if(r.error){td.appendChild(el("span","hata: "+r.error,"warn"));}
   else{td.appendChild(el("span",r.ip+" · "+Math.round(r.ms)+" ms · ","muted"));
    td.appendChild(el("span",r.is_tor?"Tor ✓":"Tor ✗",r.is_tor?"ok":"bad"));}}
  return td;
 }
 function render(d){
  $("hdr").textContent="Pi sürümü "+d.version+" · Tor "+(d.tor_version||"?")+" · çalışma süresi "+dur(d.uptime_s);
  $("banner").className=d.tor_outdated?"banner":"banner hidden";
  $("tot").textContent=d.totals.running+" aktif / "+d.totals.ready+" hazır / "+d.totals.total+" toplam oturum";
  if(d.idle_hours!=null&&document.activeElement!==$("idlehrs")&&!idleDirty)$("idlehrs").value=d.idle_hours;
  var u=d.tor_update;
  if(u){
   $("torver").textContent="Kurulu: "+(u.installed||d.tor_version||"?")+" · Pakette en yeni: "+(u.candidate||"?")+(u.can_update?" (güncelleme var)":u.candidate&&u.installed?" (güncel)":"")+
    ((u.candidate||"")===""?" — paket listesi eski olabilir, güncelle'ye basınca yenilenir":"")+
    (u.can_update?"":" · Yeni sürüm gelmiyorsa Pi'da: sudo bash tor-repo-ekle.sh (Tor Project deposu)");
   if(document.activeElement!==$("torauto"))$("torauto").checked=!!u.auto;
   $("torauto").disabled=!u.supported;
   var run=(u.state==="requested"||u.state==="running");
   $("torupd").disabled=run||!u.supported;
   $("torupdmsg").textContent=!u.supported?"Güncelleme servisi kurulu değil: Pi'da yeni sürümle 'sudo bash install.sh' çalıştır.":
    (u.state==="requested"?"Başlatılıyor...":u.state==="running"?(u.msg||"Çalışıyor..."):u.state==="done"?u.msg:u.state==="error"?u.msg:"");
  }
  if(d.pool){$("poolmsg").textContent="Havuz: "+d.pool.ready+" hazır / "+d.pool.spares+" açık / hedef "+d.pool.size+" (en çok "+d.pool.max+")";
   if(document.activeElement!==$("poolsz")&&!poolDirty)$("poolsz").value=d.pool.size;
   if(document.activeElement!==$("maxs")&&!maxDirty)$("maxs").value=d.pool.max;}
  var tb=$("rows");tb.textContent="";
  if(!d.sessions.length){var r0=el("tr");var c0=el("td","Henüz oturum yok.","muted");c0.colSpan=8;r0.appendChild(c0);tb.appendChild(r0);}
  d.sessions.forEach(function(s){
   var tr=el("tr");
   var td=el("td");var code=el("code",String(s.short));code.title=String(s.id);td.appendChild(code);tr.appendChild(td);
   tr.appendChild(el("td",s.spare?"havuz (boşta)":s.country==="auto"?"otomatik":String(s.country).toUpperCase()));
   var st=s.ready?["hazır","ok"]:s.running?["bağlanıyor","wait"]:["kapalı","off"];
   var tds=el("td");tds.appendChild(el("span","","dot "+st[1]));tds.appendChild(document.createTextNode(st[0]));tr.appendChild(tds);
   tr.appendChild(el("td",s.running?"%"+s.bootstrap:"-"));
   tr.appendChild(el("td",s.exit_ip?(s.exit_ip+(s.exit_name?" ("+s.exit_name+")":"")+" ~"):(s.exit_name?s.exit_name+" ~":"-")));
   tr.appendChild(el("td",dur(s.idle_s)));
   var pc=probeCell(s.id);if(!s.ready)pc.firstChild.disabled=true;tr.appendChild(pc);
   var dt=el("td");var db=el("button","Sil");db.type="button";db.className="sec";
   db.addEventListener("click",function(){if(confirm("Bu oturum silinsin mi? (kod "+s.short+")"))del(s.id);});
   dt.appendChild(db);tr.appendChild(dt);
   tb.appendChild(tr);
  });
 }
 function load(){
  return fetch("/api/status",{headers:hdr,cache:"no-store"}).then(function(r){
   return r.json().then(function(j){
    if(!r.ok||!j.ok){throw new Error(j.error||("HTTP "+r.status));}
    $("err").textContent="";render(j);
   });
  }).catch(function(e){$("err").textContent="Durum alınamadı: "+e.message+(tok?"":" (Token yok: sayfayı Pi'nın verdiği bağlantıyla yeniden aç.)");});
 }
 function del(id){
  fetch("/api/session/"+encodeURIComponent(id),{method:"DELETE",headers:hdr})
   .then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));});})
   .catch(function(e){$("rstmsg").textContent="Hata: "+e.message;}).then(function(){load();});
 }
 function probe(id){
  busy[id]=true;load();
  fetch("/api/session/"+encodeURIComponent(id)+"/probe",{method:"POST",headers:hdr})
   .then(function(r){return r.json().catch(function(){return {};}).then(function(j){
     if(r.ok&&j.ok){results[id]={ip:String(j.ip),ms:Number(j.ms),is_tor:!!j.is_tor};}
     else{results[id]={error:String(j.error||("HTTP "+r.status))};}});})
   .catch(function(e){results[id]={error:String(e.message)};})
   .then(function(){delete busy[id];load();});
 }
 $("rst").addEventListener("click",function(){
  var b=$("rst");b.disabled=true;$("rstmsg").textContent="Yenileniyor...";
  fetch("/api/restart-idle",{method:"POST",headers:hdr}).then(function(r){return r.json().then(function(j){
    if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));
    $("rstmsg").textContent=j.restarted+" oturum yenilendi"+(j.failed?(", "+j.failed+" başarısız"):"")+".";
  });}).catch(function(e){$("rstmsg").textContent="Hata: "+e.message;}).then(function(){b.disabled=false;load();});
 });
 $("idlehrs").addEventListener("input",function(){idleDirty=true;});
 $("idlesave").addEventListener("click",function(){
  var b=$("idlesave");b.disabled=true;
  fetch("/api/idle-hours",{method:"POST",headers:Object.assign({"Content-Type":"application/json"},hdr),body:JSON.stringify({hours:parseFloat($("idlehrs").value)})})
   .then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));idleDirty=false;$("idlemsg").textContent="Kaydedildi.";});})
   .catch(function(e){$("idlemsg").textContent="Hata: "+e.message;}).then(function(){b.disabled=false;load();});
 });
 $("purge").addEventListener("click",function(){
  if(!confirm("1 saatten uzun süredir boşta olan oturumlar silinsin mi? (Hazır havuz oturumlarına dokunulmaz.)"))return;
  var b=$("purge");b.disabled=true;
  fetch("/api/purge-idle",{method:"POST",headers:Object.assign({"Content-Type":"application/json"},hdr),body:JSON.stringify({hours:1})})
   .then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));$("rstmsg").textContent=j.deleted+" oturum silindi.";});})
   .catch(function(e){$("rstmsg").textContent="Hata: "+e.message;}).then(function(){b.disabled=false;load();});
 });
 $("purgenr").addEventListener("click",function(){
  if(!confirm("Hazır olmayan (bağlanamayan/kapalı) tüm oturumlar silinsin mi? Şu an bağlanmakta olanlara (son 30 sn içinde istek atanlar) dokunulmaz, hazır olanlar kalır."))return;
  var b=$("purgenr");b.disabled=true;
  fetch("/api/purge-idle",{method:"POST",headers:Object.assign({"Content-Type":"application/json"},hdr),body:JSON.stringify({hours:30/3600,not_ready_only:true})})
   .then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));$("rstmsg").textContent=j.deleted+" oturum silindi.";});})
   .catch(function(e){$("rstmsg").textContent="Hata: "+e.message;}).then(function(){b.disabled=false;load();});
 });
 $("torupd").addEventListener("click",function(){
  var b=$("torupd");b.disabled=true;
  fetch("/api/update-tor",{method:"POST",headers:hdr}).then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));});})
   .catch(function(e){$("torupdmsg").textContent="Hata: "+e.message;}).then(function(){load();});
 });
 $("torauto").addEventListener("change",function(){
  var c=$("torauto");
  fetch("/api/auto-update",{method:"POST",headers:Object.assign({"Content-Type":"application/json"},hdr),body:JSON.stringify({on:c.checked})})
   .then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));});})
   .catch(function(e){$("torupdmsg").textContent="Hata: "+e.message;}).then(function(){load();});
 });
 $("maxs").addEventListener("input",function(){maxDirty=true;});
 $("maxsave").addEventListener("click",function(){
  var b=$("maxsave");b.disabled=true;
  fetch("/api/max-sessions",{method:"POST",headers:Object.assign({"Content-Type":"application/json"},hdr),body:JSON.stringify({max:parseInt($("maxs").value,10)})})
   .then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));maxDirty=false;$("maxmsg").textContent="Kaydedildi.";});})
   .catch(function(e){$("maxmsg").textContent="Hata: "+e.message;}).then(function(){b.disabled=false;load();});
 });
 $("poolsz").addEventListener("input",function(){poolDirty=true;});
 $("poolsave").addEventListener("click",function(){
  var b=$("poolsave");b.disabled=true;
  fetch("/api/pool",{method:"POST",headers:Object.assign({"Content-Type":"application/json"},hdr),body:JSON.stringify({size:parseInt($("poolsz").value,10)})})
   .then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok)throw new Error(j.error||("HTTP "+r.status));poolDirty=false;});})
   .catch(function(e){$("poolmsg").textContent="Hata: "+e.message;}).then(function(){b.disabled=false;load();});
 });
 load();setInterval(load,5000);
})();
</script>
</main></body></html>"""


def render_page(body):
    return PAGE.replace("%BODY%", body)


RECENT_SEC = 900  # açılışta hemen başlatılacak "yakın zamanda kullanıldı" eşiği
DEFAULT_POOL_SIZE = 2  # panelden değiştirilir; 0 = kapalı


class LimitError(Exception):
    pass


class AuthGuard:
    """Kısa token'ın kaba kuvvetle bulunmasını engeller: bir IP 10 dk içinde 8 kez yanlış girerse 10 dk kilitlenir."""
    MAX_FAILS, WINDOW = 8, 600

    def __init__(self):
        self.lock = threading.Lock()
        self.fails = {}   # ip -> [sayaç, ilk hata zamanı]
        self.blocked = {}  # ip -> açılma zamanı

    def is_blocked(self, ip, now=None):
        now = time.time() if now is None else now
        with self.lock:
            until = self.blocked.get(ip, 0)
            if until > now:
                return True
            self.blocked.pop(ip, None)
            return False

    def fail(self, ip, now=None):
        now = time.time() if now is None else now
        with self.lock:
            n, t0 = self.fails.get(ip, [0, now])
            if now - t0 > self.WINDOW:
                n, t0 = 0, now
            n += 1
            self.fails[ip] = [n, t0]
            if n >= self.MAX_FAILS:
                self.blocked[ip] = now + self.WINDOW
                self.fails.pop(ip, None)
            if len(self.fails) > 2000:
                self.fails.clear()

    def ok(self, ip):
        with self.lock:
            self.fails.pop(ip, None)


GUARD = AuthGuard()


PROBE_COOLDOWN = 5.0      # aynı oturumda iki ölçüm arası en az süre (sn)
IDLE_RESTART_SEC = 600    # "boştaki oturumları yenile" için eşik


def load_config():
    cfg = dict(DEFAULTS)
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg.update(json.load(f))
    if len(str(cfg.get("token", ""))) < 6:
        sys.exit("config.json içinde en az 6 karakterlik bir 'token' olmalı.")
    cfg["max_sessions"] = max(1, min(100, int(cfg["max_sessions"])))
    try:
        cfg["probe_port"] = int(cfg["probe_port"])
        if not 1 <= cfg["probe_port"] <= 65535:
            raise ValueError
    except (TypeError, ValueError):
        sys.exit("config.json içinde 'probe_port' 1-65535 arası bir sayı olmalı.")
    if not HOST_RE.match(str(cfg["probe_host"])):
        sys.exit("config.json içindeki 'probe_host' geçerli bir alan adı olmalı.")
    if not str(cfg["probe_path"]).startswith("/") or re.search(r"[\s\x00-\x1f]", str(cfg["probe_path"])):
        sys.exit("config.json içindeki 'probe_path' '/' ile başlamalı ve boşluk içermemeli.")
    cfg["probe_tls"] = bool(cfg["probe_tls"])
    return cfg


# ---------- Tor kontrol portu ----------
class Control:
    def __init__(self, port, cookie_path, timeout=5):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.s.settimeout(timeout)
        self.f = self.s.makefile("rb")
        try:
            with open(cookie_path, "rb") as fh:
                cookie = fh.read().hex()
            code, lines = self.cmd("AUTHENTICATE " + cookie)
            if code != "250":
                raise RuntimeError("Kontrol kimlik doğrulaması başarısız: " + " ".join(lines))
        except Exception:
            self.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def _readline(self):
        raw = self.f.readline()
        if not raw:
            raise IOError("Tor kontrol bağlantısı kapandı")
        return raw.decode("utf-8", "replace").rstrip("\r\n")

    def cmd(self, line):
        self.s.sendall((line + "\r\n").encode())
        lines = []
        while True:
            l = self._readline()
            if len(l) < 4:
                raise IOError("Beklenmeyen kontrol yanıtı: " + l)
            lines.append(l)
            if l[3] == "+":  # veri bloğu, tek '.' satırına kadar
                while True:
                    d = self._readline()
                    if d == ".":
                        break
                    lines.append(d)
                continue
            if l[3] == " ":
                return l[:3], lines

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


def bootstrap(c):
    code, lines = c.cmd("GETINFO status/bootstrap-phase")
    for l in lines:
        m = re.search(r"PROGRESS=(\d+)", l)
        if m:
            s = re.search(r'SUMMARY="([^"]*)"', l)
            return int(m.group(1)), (s.group(1) if s else "")
    return 0, ""


def apply_country(c, cc):
    if cc == "auto":
        r = c.cmd("SETCONF ExitNodes StrictNodes=0")
    else:
        r = c.cmd("SETCONF ExitNodes={%s} StrictNodes=1" % cc)
    if r[0] != "250":
        raise RuntimeError("Ülke ayarı reddedildi: " + " ".join(r[1]))


def apply_pin(c, ip, country):
    """Çıkışı tek bir röleye (IPv4) sabitle; ip boşsa ülke ayarına dön."""
    if not ip:
        return apply_country(c, country)
    r = c.cmd("SETCONF ExitNodes=%s StrictNodes=1" % ip)
    if r[0] != "250":
        raise RuntimeError("Çıkış sabitleme reddedildi: " + " ".join(r[1]))


def do_newnym(c):
    code, lines = c.cmd("SIGNAL NEWNYM")
    if code != "250":
        raise RuntimeError("NEWNYM reddedildi: " + " ".join(lines))
    # NEWNYM sadece yeni bağlantıları etkiler; açık bağlantılar eski IP'de kalmasın diye devreleri kapat
    try:
        code, lines = c.cmd("GETINFO circuit-status")
        for l in lines:
            m = re.match(r"^(\d+) BUILT .*PURPOSE=GENERAL", l)
            if m:
                c.cmd("CLOSECIRCUIT " + m.group(1))
    except Exception:
        pass


# ---------- Çıkış rölesi bilgisi (saf ayrıştırıcılar) ----------
_CIRC_RE = re.compile(r"^(\d+) (\S+) (\$\S+)(.*)$")
_HOP_RE = re.compile(r"^\$([0-9A-Fa-f]{40})(?:[=~](\S+))?$")


def parse_exit_from_circuits(lines):
    """'GETINFO circuit-status' yanıtından tahmini çıkış rölesini bulur: {fingerprint, name, circuit} ya da None.

    Yalnızca BUILT ve PURPOSE=GENERAL devreler dikkate alınır; son halka çıkış rölesidir. Birden fazla
    devre varsa en büyük numaralı olan seçilir. Tor hangi devrenin şu an trafik taşıdığını söylemez;
    bu yüzden sonuç bir TAHMİNDİR.
    """
    best = None
    for l in lines:
        m = re.match(r"^250[-+ ]circuit-status=(.*)$", l)
        if m:
            l = m.group(1)
        m = _CIRC_RE.match(l.strip())
        if not m or m.group(2) != "BUILT":
            continue
        if not re.search(r"(^|\s)PURPOSE=GENERAL(\s|$)", m.group(4)):
            continue
        hop = _HOP_RE.match(m.group(3).split(",")[-1])
        if not hop:
            continue
        cid = int(m.group(1))
        if best is None or cid > best[0]:
            best = (cid, {"fingerprint": hop.group(1).upper(), "name": hop.group(2) or "", "circuit": m.group(1)})
    return best[1] if best else None


def parse_router_ip(lines):
    """'GETINFO ns/id/<FP>' yanıtındaki 'r' satırından IPv4 adresini döndürür (yoksa None).

    Biçim: r <takma-ad> <kimlik> <özet> <yayın-tarihi> <yayın-saati> <IP> <ORPort> <DirPort>
    """
    for l in lines:
        m = re.match(r"^250[-+ ]ns/id/[^=]*=(.*)$", l)
        if m:
            l = m.group(1)
        parts = l.strip().split()
        if len(parts) >= 8 and parts[0] == "r":
            try:
                return str(ipaddress.IPv4Address(parts[6]))
            except ValueError:
                return None
    return None


def parse_tor_version(text):
    """'Tor version 0.4.8.12.' -> '0.4.8.12' (bulunamazsa '')."""
    m = re.search(r"Tor version ([0-9][0-9A-Za-z.\-+]*)", text or "")
    return m.group(1).rstrip(".") if m else ""


def parse_apt_policy(text):
    """`apt-cache policy tor` çıktısından (Installed, Candidate) sürümleri."""
    inst = cand = ""
    for line in (text or "").splitlines():
        line = line.strip()
        if line.startswith("Installed:"):
            inst = line.split(":", 1)[1].strip()
        elif line.startswith("Candidate:"):
            cand = line.split(":", 1)[1].strip()
    if inst == "(none)":
        inst = ""
    if cand == "(none)":
        cand = ""
    return inst, cand


class TorUpdater:
    """Panelden Tor güncelleme: servis root değil, bu yüzden state_dir'e istek dosyası bırakır;
    systemd path birimi (torpool-update.path) root olarak update-tor.sh'yi çalıştırır, sonucu update-status'a yazar."""
    UNIT = "/etc/systemd/system/torpool-update.path"

    def __init__(self, state_dir, unit=None):
        self.req = os.path.join(state_dir, "update-request")
        self.st = os.path.join(state_dir, "update-status")
        self.unit = unit or self.UNIT
        self._apt = (0.0, ("", ""))
        self._lock = threading.Lock()
        self.handled_ts = 0

    def supported(self):
        return os.path.exists(self.unit)

    def apt_versions(self, ttl=300):
        with self._lock:
            now = time.time()
            if now - self._apt[0] < ttl:
                return self._apt[1]
            try:
                r = subprocess.run(["apt-cache", "policy", "tor"], capture_output=True, text=True, timeout=15,
                                   stdin=subprocess.DEVNULL, env=dict(os.environ, LC_ALL="C"))
                val = parse_apt_policy(r.stdout)
            except Exception:
                val = ("", "")
            self._apt = (now, val)
            return val

    def forget_versions(self):
        with self._lock:
            self._apt = (0.0, ("", ""))

    def read(self):
        try:
            with open(self.st, encoding="utf-8") as f:
                d = json.load(f)
            state = str(d.get("state", "idle"))
            msg, ts = str(d.get("msg", "")), int(d.get("ts", 0))
        except Exception:
            state, msg, ts = "idle", "", 0
        if os.path.exists(self.req) and state not in ("running",):
            state = "requested"
        return {"state": state, "msg": msg, "ts": ts}

    def request(self):
        """True: istek bırakıldı. False: zaten sürüyor."""
        cur = self.read()
        if cur["state"] in ("requested", "running"):
            return False
        with open(self.req, "w", encoding="utf-8") as f:
            f.write(str(int(time.time())))
        try:
            tmp = self.st + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"state": "requested", "msg": "Istek alindi", "ts": int(time.time())}, f)
            os.replace(tmp, self.st)
        except OSError:
            pass
        return True

    def info(self):
        inst, cand = self.apt_versions()
        d = self.read()
        d.update({"supported": self.supported(), "installed": inst, "candidate": cand,
                  "can_update": bool(cand and inst and cand != inst)})
        return d


class TorBinInfo:
    """Tor sürümünü bir kez okur; Tor ikilisi servis başladıktan sonra değiştiyse 'eski' işaretler."""

    def __init__(self, tor_bin, started, recheck=60):
        self.tor_bin, self.started, self.recheck = tor_bin, started, recheck
        self.version = ""
        try:
            r = subprocess.run([tor_bin, "--version"], capture_output=True, text=True, timeout=10,
                               stdin=subprocess.DEVNULL)
            self.version = parse_tor_version(r.stdout)
        except Exception:
            pass
        self._ts, self._val = 0.0, False
        self._lock = threading.Lock()

    def outdated(self):
        with self._lock:
            now = time.time()
            if now - self._ts >= self.recheck:
                try:
                    mt = os.stat(os.path.realpath(self.tor_bin)).st_mtime
                    self._val = mt > self.started - 1
                except OSError:
                    self._val = False
                self._ts = now
            return self._val


# ---------- SOCKS5 üzerinden HTTP isteği ----------
def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise IOError("SOCKS bağlantısı beklenmedik şekilde kapandı")
        buf += chunk
    return buf


def parse_http_response(raw):
    """Ham HTTP/1.x yanıtı -> (durum_kodu, başlıklar{küçük harf}, gövde bytes). 'chunked' gövdeyi çözer."""
    head, sep, body = raw.partition(b"\r\n\r\n")
    if not sep:
        raise ValueError("Geçersiz HTTP yanıtı")
    rows = head.decode("iso-8859-1").split("\r\n")
    m = re.match(r"^HTTP/\d\.\d (\d{3})", rows[0])
    if not m:
        raise ValueError("Geçersiz HTTP durum satırı")
    headers = {}
    for r in rows[1:]:
        k, _, v = r.partition(":")
        headers[k.strip().lower()] = v.strip()
    if "chunked" in headers.get("transfer-encoding", "").lower():
        out, rest = b"", body
        while True:
            line, sep, rest = rest.partition(b"\r\n")
            if not sep:
                break  # yanıt yarım kaldı; eldekini kullan
            try:
                size = int(line.split(b";")[0].strip() or b"0", 16)
            except ValueError:
                raise ValueError("Geçersiz chunk boyutu")
            if size == 0:
                break
            out += rest[:size]
            rest = rest[size + 2:]
        body = out
    return int(m.group(1)), headers, body


_SOCKS_ERRORS = {1: "genel hata", 2: "kurala takıldı", 3: "ağa ulaşılamıyor", 4: "hedefe ulaşılamıyor",
                 5: "bağlantı reddedildi", 6: "TTL doldu", 7: "komut desteklenmiyor", 8: "adres türü desteklenmiyor"}


def socks5_http_get(socks_host, socks_port, host, port, path, tls, timeout):
    """SOCKS5 (auth yok, alan adıyla CONNECT = DNS uzaktan çözülür) üzerinden taze bağlantıyla HTTP GET yapar.

    Döner: {status, body (bytes), connect_ms, ms}. connect_ms = SOCKS CONNECT'in tamamlanma süresi,
    ms = isteğin (TLS dahil) bitişine kadar geçen toplam süre. Hata olursa RuntimeError (Türkçe mesajlı).
    """
    hb = host.encode("idna")
    if not 1 <= len(hb) <= 255:
        raise RuntimeError("Geçersiz hedef adı")
    if not str(path).startswith("/") or re.search(r"[\s\x00-\x1f]", str(path)):
        raise RuntimeError("Geçersiz istek yolu")
    t0 = time.time()
    deadline = t0 + timeout

    def left():
        r = deadline - time.time()
        if r <= 0:
            raise socket.timeout()
        return r

    s = None
    try:
        s = socket.create_connection((socks_host, int(socks_port)), timeout=min(5, left()))
        s.settimeout(left())
        s.sendall(b"\x05\x01\x00")
        if _recv_exact(s, 2) != b"\x05\x00":
            raise RuntimeError("SOCKS sunucusu kimlik doğrulamasız bağlantıyı kabul etmedi")
        s.settimeout(left())
        s.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + int(port).to_bytes(2, "big"))
        ver, rep, _rsv, atyp = _recv_exact(s, 4)
        if ver != 5:
            raise RuntimeError("Geçersiz SOCKS yanıtı")
        _recv_exact(s, (_recv_exact(s, 1)[0] if atyp == 3 else {1: 4, 4: 16}.get(atyp, 0)) + 2)
        if rep != 0:
            raise RuntimeError("Tor bağlantıyı kuramadı: %s (kod %d)" % (_SOCKS_ERRORS.get(rep, "bilinmeyen"), rep))
        connect_ms = (time.time() - t0) * 1000.0
        if tls:
            s.settimeout(left())
            s = ssl.create_default_context().wrap_socket(s, server_hostname=host)
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: torpool/%s\r\nAccept: */*\r\n"
               "Connection: close\r\n\r\n" % (path, host, VERSION))
        s.settimeout(left())
        s.sendall(req.encode("ascii"))
        raw = b""
        while len(raw) < 512 * 1024:
            s.settimeout(left())
            try:
                chunk = s.recv(16384)
            except ssl.SSLEOFError:
                break  # bazı sunucular close_notify göndermeden kapatır
            if not chunk:
                break
            raw += chunk
        ms = (time.time() - t0) * 1000.0
    except socket.timeout:
        raise RuntimeError("Ölçüm zaman aşımına uğradı (%d sn)" % timeout)
    except ssl.SSLError as e:
        raise RuntimeError("TLS hatası: %s" % e)
    except OSError as e:
        raise RuntimeError("SOCKS bağlantısı kurulamadı: %s" % e)
    finally:
        if s is not None:
            try:
                s.close()
            except Exception:
                pass
    try:
        status, _h, body = parse_http_response(raw)
    except ValueError as e:
        raise RuntimeError("Hedeften geçersiz yanıt geldi: %s" % e)
    return {"status": status, "body": body, "connect_ms": round(connect_ms, 1), "ms": round(ms, 1)}


# ---------- Tek bir Tor oturumu ----------
class Instance:
    def __init__(self, mgr, sid, n, country):
        cfg = mgr.cfg
        self.mgr = mgr
        self.sid = sid
        self.n = n
        self.country = country
        self.socks = cfg["socks_base"] + n
        self.ctl = cfg["control_base"] + n
        self.dir = os.path.join(cfg["state_dir"], "inst", str(n))
        self.cookie = os.path.join(self.dir, "control_auth_cookie")
        self.proc = None
        self.applied = False
        self.watcher = None
        self.last_active = time.time()
        self.ttl = 0  # >0: istemci bu kadar sn yoklama yapmazsa (tarayıcı kapandı) oturum silinir; 0 = kapalı
        self.spare = False  # havuzda hazır bekleyen (henüz kimseye verilmemiş) oturum
        self.started_at = 0.0  # Tor sürecinin başlama zamanı (Tor paketi sonradan güncellendi mi anlamak için)
        self.lock = threading.RLock()
        self.probe_lock = threading.Lock()
        self.probe_done = 0.0             # son ölçümün bittiği an (bekleme süresi için)
        self._exit_cache = (0.0, {})

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def _bridge_lines(self):
        path = self.mgr.cfg["bridges_file"]
        try:
            with open(path, encoding="utf-8") as f:
                rows = [l.strip() for l in f]
        except OSError:
            return []
        out = []
        for l in rows:
            if not l or l.startswith("#"):
                continue
            if l.lower().startswith("bridge "):
                l = l[7:].strip()
            out.append(l)
        return out

    def _torrc(self):
        cfg = self.mgr.cfg
        lines = [
            "DataDirectory " + self.dir,
            "SocksPort %s:%d" % (cfg["socks_bind"], self.socks),
            "ControlPort 127.0.0.1:%d" % self.ctl,
            "CookieAuthentication 1",
            "ClientOnly 1",
            "AvoidDiskWrites 1",
            "MaxCircuitDirtiness 86400",
            "Log notice file " + os.path.join(self.dir, "tor.log"),
        ]
        if os.path.isfile(cfg["geoip"]):
            lines.append("GeoIPFile " + cfg["geoip"])
        if os.path.isfile(cfg["geoip6"]):
            lines.append("GeoIPv6File " + cfg["geoip6"])
        for cidr in cfg["allowed_cidrs"]:
            lines.append("SocksPolicy accept " + cidr)
        lines.append("SocksPolicy reject *")

        bridges = self._bridge_lines()
        if bridges:
            lines.append("UseBridges 1")
            if os.path.isfile("/usr/bin/lyrebird"):
                lines.append("ClientTransportPlugin obfs4,meek_lite,webtunnel exec /usr/bin/lyrebird")
            elif os.path.isfile("/usr/bin/obfs4proxy"):
                lines.append("ClientTransportPlugin obfs4 exec /usr/bin/obfs4proxy")
            if os.path.isfile("/usr/bin/snowflake-client"):
                lines.append("ClientTransportPlugin snowflake exec /usr/bin/snowflake-client")
            for b in bridges:
                lines.append("Bridge " + b)
        return "\n".join(lines) + "\n"

    def start(self):
        with self.lock:
            if self.running():
                return
            os.makedirs(self.dir, exist_ok=True)
            try:
                os.chmod(self.dir, 0o700)
            except OSError:
                pass
            self.mgr.seed_into(self.dir)
            rc = os.path.join(self.dir, "torrc")
            with open(rc, "w", encoding="utf-8") as f:
                f.write(self._torrc())
            try:
                os.remove(self.cookie)
            except OSError:
                pass
            self.applied = False
            self.proc = subprocess.Popen(
                [self.mgr.cfg["tor_bin"], "-f", rc],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            self.started_at = time.time()
            self._spawn_watcher()

    def stop(self):
        with self.lock:
            p = self.proc
            self.proc = None
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    def _spawn_watcher(self):
        if self.watcher is not None and self.watcher.is_alive():
            return
        self.watcher = threading.Thread(target=self._watch, daemon=True)
        self.watcher.start()

    def _watch(self):
        """Tor tamamen bağlanınca ülke kısıtını uygula (açılışta uygulamak dizin indirmeyi takıp bırakabiliyor)."""
        deadline = time.time() + 1800
        while time.time() < deadline and self.running() and not self.applied:
            time.sleep(2)
            try:
                with Control(self.ctl, self.cookie) as c:
                    prog, _ = bootstrap(c)
                    if prog >= 100:
                        apply_country(c, self.country)
                        self.applied = True
                        self.mgr.maybe_seed(self.dir)
            except Exception:
                pass

    def status(self, timeout=5):
        st = {
            "id": self.sid, "port": self.socks, "country": self.country,
            "running": self.running(), "bootstrap": 0, "summary": "", "applied": self.applied,
        }
        if st["running"]:
            try:
                with Control(self.ctl, self.cookie, timeout) as c:
                    st["bootstrap"], st["summary"] = bootstrap(c)
            except Exception:
                pass
        st["ready"] = bool(st["running"] and st["bootstrap"] >= 100 and self.applied)
        return st

    def exit_info(self):
        """Tahmini çıkış rölesi: {ip, name}. Tor yoksa/yanıt vermezse {} (istisna fırlatmaz)."""
        if not self.running():
            return {}
        try:
            with Control(self.ctl, self.cookie, 2) as c:
                code, lines = c.cmd("GETINFO circuit-status")
                if code != "250":
                    return {}
                ex = parse_exit_from_circuits(lines)
                if not ex:
                    return {}
                info = {"ip": None, "name": ex["name"] or None}
                try:
                    code, lines = c.cmd("GETINFO ns/id/" + ex["fingerprint"])
                    if code == "250":
                        info["ip"] = parse_router_ip(lines)
                except Exception:
                    pass
                return info
        except Exception:
            return {}

    def exit_info_cached(self, max_age=4):
        """Panel her 5 sn yenilenirken Tor'a gereksiz yük bindirmemek için kısa önbellek."""
        ts, val = self._exit_cache
        if time.time() - ts < max_age:
            return val
        val = self.exit_info()
        self._exit_cache = (time.time(), val)
        return val

    def probe(self, timeout=25):
        """İsteğe bağlı ölçüm: {ip, is_tor, ms, connect_ms}. Hata olursa RuntimeError (Türkçe).

        Aynı oturumda aynı anda tek ölçüm ve ölçümler arası 5 sn bekleme (LimitError).
        """
        if not self.probe_lock.acquire(blocking=False):
            raise LimitError("Bu oturumda bir ölçüm zaten sürüyor.")
        try:
            wait = PROBE_COOLDOWN - (time.time() - self.probe_done)
            if wait > 0:
                raise LimitError("Çok sık ölçüm: %d sn sonra tekrar dene." % (int(wait) + 1))
            try:
                cfg = self.mgr.cfg
                bind = str(cfg["socks_bind"])
                host = "127.0.0.1" if bind in ("0.0.0.0", "::", "") else bind
                r = socks5_http_get(host, self.socks, cfg["probe_host"], int(cfg["probe_port"]),
                                    cfg["probe_path"], bool(cfg["probe_tls"]), timeout)
            finally:
                self.probe_done = time.time()
            if not 200 <= r["status"] < 300:
                raise RuntimeError("Hedef HTTP %d döndürdü." % r["status"])
            try:
                j = json.loads(r["body"].decode("utf-8", "replace"))
            except ValueError:
                raise RuntimeError("Hedeften beklenmeyen yanıt geldi.")
            if not isinstance(j, dict):
                raise RuntimeError("Hedeften beklenmeyen yanıt geldi.")
            ip = str(j.get("IP", ""))
            return {"ip": ip if re.fullmatch(r"[0-9a-fA-F:.]{3,45}", ip) else "",
                    "is_tor": bool(j.get("IsTor", False)), "ms": r["ms"], "connect_ms": r["connect_ms"]}
        finally:
            self.probe_lock.release()

    def restart(self):
        """Tor'u durdurup yeniden başlatır; ülke, SOCKS portu ve kayıtlı durum aynı kalır, 'applied' sıfırlanır."""
        self.stop()
        w = self.watcher
        if w is not None and w.is_alive() and w is not threading.current_thread():
            w.join(6)  # eski izleyici çıksın; yoksa yeni sürece ülke kısıtı uygulanmayabilir
        self._exit_cache = (0.0, {})
        self.start()
        self.mgr.save_state()

    def newnym(self):
        with Control(self.ctl, self.cookie) as c:
            do_newnym(c)

    def pin_exit(self, ip):
        with Control(self.ctl, self.cookie) as c:
            apply_pin(c, ip, self.country)
            do_newnym(c)

    def set_country(self, cc):
        self.country = cc
        self.applied = False
        if self.running():
            try:
                with Control(self.ctl, self.cookie) as c:
                    prog, _ = bootstrap(c)
                    if prog >= 100:
                        apply_country(c, cc)
                        self.applied = True
            except Exception:
                pass
            if not self.applied:
                self._spawn_watcher()
        self.mgr.save_state()


# ---------- Ülke başına çıkış rölesi sayısı (Tor Projesi / Onionoo) ----------
def parse_exit_counts(raw):
    """Onionoo 'details' yanıtından {ülke_kodu: çıkış_rölesi_sayısı} çıkarır."""
    data = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    counts = {}
    for r in data.get("relays", []):
        cc = str(r.get("country", "")).lower()
        if re.fullmatch(r"[a-z]{2}", cc):
            counts[cc] = counts.get(cc, 0) + 1
    return counts


class ExitCounts:
    """Sayıları Pi bir kez indirir ve önbellekte tutur; istemciler Pi'dan alır (herkes Onionoo'ya gitmez)."""

    def __init__(self, url, ttl, fetch=None):
        self.url, self.ttl = url, ttl
        self.fetch = fetch or self._http
        self.lock = threading.Lock()
        self.counts, self.ts, self.error = {}, 0.0, ""

    def _http(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": "torpool/" + VERSION})
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.read(8 * 1024 * 1024)

    def get(self):
        with self.lock:
            now = time.time()
            if self.counts and now - self.ts < self.ttl:
                return self.counts, self.ts, False
            if not self.counts and self.error and now - self.ts < 120:
                raise RuntimeError(self.error)  # sürekli denememek için kısa bekleme
            try:
                self.counts = parse_exit_counts(self.fetch(self.url))
                self.ts, self.error = now, ""
                return self.counts, self.ts, False
            except Exception as e:
                self.error = "Çıkış rölesi listesi alınamadı: %s" % e
                if self.counts:
                    return self.counts, self.ts, True  # eski veriyi göster
                self.ts = now
                raise RuntimeError(self.error)


# ---------- Yönetici ----------
class Manager:
    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.restart_lock = threading.Lock()
        self.inst = {}
        self.sdir = cfg["state_dir"]
        os.makedirs(os.path.join(self.sdir, "inst"), exist_ok=True)
        self.seed = os.path.join(self.sdir, "seed")
        self.state_file = os.path.join(self.sdir, "state.json")
        self.settings_file = os.path.join(self.sdir, "settings.json")
        self.updater = TorUpdater(self.sdir)
        self.auto_tor_update = False
        self.idle_hours = float(cfg["idle_hours"])  # panelden değiştirilirse settings.json'daki değer geçerli olur
        self.last_auto_update = 0.0
        self.max_sessions = int(cfg["max_sessions"])  # panelden değiştirilirse settings.json'daki değer geçerli olur
        self.pool_size = self._load_pool_size()
        self.filling = False

    # hazır oturum havuzu
    def _load_pool_size(self):
        try:
            with open(self.settings_file, encoding="utf-8") as f:
                d = json.load(f)
            if d.get("max_sessions") is not None:
                self.max_sessions = max(1, min(int(d["max_sessions"]), 100))
            n = int(d.get("pool_size", self.cfg.get("pool_size", DEFAULT_POOL_SIZE)))
            self.auto_tor_update = bool(d.get("auto_tor_update", False))
            self.last_auto_update = float(d.get("last_auto_update", 0))
            if d.get("idle_hours") is not None:
                self.idle_hours = max(1.0, min(float(d["idle_hours"]), 8760.0))
        except Exception:
            try:  # ayar dosyası yoksa config.json'daki "pool_size" (varsayılan 2): hazır havuz açık gelir, bağlanma beklemesin
                n = int(self.cfg.get("pool_size", DEFAULT_POOL_SIZE))
            except (TypeError, ValueError):
                n = DEFAULT_POOL_SIZE
        return max(0, min(n, self.max_sessions))

    def _save_settings(self):
        tmp = self.settings_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"pool_size": self.pool_size, "auto_tor_update": self.auto_tor_update,
                       "last_auto_update": self.last_auto_update, "idle_hours": self.idle_hours,
                       "max_sessions": self.max_sessions}, f)
        os.replace(tmp, self.settings_file)

    def set_pool_size(self, n):
        self.pool_size = max(0, min(int(n), self.max_sessions))
        self._save_settings()
        self.kick_refill()
        return self.pool_size

    def set_max_sessions(self, n):
        """En çok eşzamanlı oturum. Mevcut oturumlara dokunulmaz; sınırın altına inene kadar yeni oturum açılmaz."""
        self.max_sessions = max(1, min(int(n), 100))
        self.pool_size = min(self.pool_size, self.max_sessions)
        self._save_settings()
        self.kick_refill()
        return self.max_sessions

    def set_idle_hours(self, h):
        self.idle_hours = max(1.0, min(float(h), 8760.0))
        self._save_settings()
        return self.idle_hours

    def set_auto_tor_update(self, on):
        self.auto_tor_update = bool(on)
        if self.auto_tor_update:
            self.last_auto_update = 0.0  # açınca ilk kontrol hemen (bir sonraki turda)
        self._save_settings()
        return self.auto_tor_update

    AUTO_UPDATE_EVERY = 6 * 3600

    def auto_update_tick(self, now=None):
        """Otomatik Tor güncelleme açıksa 6 saatte bir güncelleme isteği bırakır (betik 'apt update' + yalnızca tor'u yükseltir)."""
        now = time.time() if now is None else now
        if not self.auto_tor_update or now - self.last_auto_update < self.AUTO_UPDATE_EVERY:
            return False
        if not self.updater.supported():
            return False
        self.last_auto_update = now
        self._save_settings()
        return self.updater.request()

    def spares(self):
        return [i for i in list(self.inst.values()) if i.spare]

    def refill_once(self):
        """Havuzu hedef boyuta yaklaştırır (bir adım). True: bir şey değişti."""
        with self.lock:
            sp = self.spares()
            if len(sp) > self.pool_size:
                extra = sorted(sp, key=lambda i: i.running())[0]  # önce çalışmayanı at
                sid = extra.sid
            elif len(sp) < self.pool_size and len(self.inst) < self.max_sessions:
                sid = None
            else:
                return False
        if sid is not None:
            self.delete(sid)
            return True
        used_sid = os.urandom(8).hex()
        inst = self.create(used_sid, "auto", spare=True)
        return inst is not None

    def kick_refill(self):
        with self.lock:
            if self.filling:
                return
            self.filling = True

        def go():
            try:
                for _ in range(100):
                    if not self.refill_once():
                        break
                    time.sleep(3)  # Pi'ı bir anda yormamak için kademeli
            except Exception:
                pass
            finally:
                self.filling = False
        threading.Thread(target=go, daemon=True).start()

    def _take_spare(self, sid):
        """Hazır bir havuz oturumunu sid'e devreder. Yoksa None."""
        cands = self.spares()
        if not cands:
            return None
        def ready(i):
            try:
                return i.running() and i.status(2)["ready"]
            except Exception:
                return False
        cands.sort(key=lambda i: not ready(i))  # hazır olanlar önce
        with self.lock:
            for i in cands:
                if i.spare and self.inst.get(i.sid) is i:
                    del self.inst[i.sid]
                    i.sid = sid
                    i.spare = False
                    i.last_active = time.time()
                    self.inst[sid] = i
                    self.save_state()
                    return i
        return None

    # kalıcı durum
    def save_state(self):
        with self.lock:
            data = {sid: {"n": i.n, "country": i.country, "spare": bool(i.spare), "last_active": int(i.last_active),
                           "ttl": int(i.ttl)}
                    for sid, i in self.inst.items()}
            tmp = self.state_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, self.state_file)

    def load_and_start(self):
        try:
            with open(self.state_file, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {}
        with self.lock:
            for sid, d in data.items():
                n = d.get("n")
                cc = d.get("country", "auto")
                if ID_RE.match(sid) and isinstance(n, int) and 0 <= n < 100 and CC_RE.match(str(cc)):
                    inst = Instance(self, sid, n, cc)
                    inst.spare = bool(d.get("spare"))
                    try:
                        inst.ttl = max(0, int(d.get("ttl", 0)))
                    except (TypeError, ValueError):
                        inst.ttl = 0
                    try:  # boşta süresi Pi yeniden başlayınca sıfırlanmasın
                        la = float(d.get("last_active", 0))
                        if 0 < la <= time.time():
                            inst.last_active = la
                        elif not d.get("last_active"):
                            # eski sürümden kalan kayıt (last_active yok): "yeni kullanıldı" sayma, açılışta başlatma
                            inst.last_active = time.time() - 2 * RECENT_SEC
                    except (TypeError, ValueError):
                        pass
                    self.inst[sid] = inst

        def go():
            # Yalnızca havuz oturumları ve son 15 dakikada kullanılanlar hemen başlar; eski/kullanılmayanlar
            # sahibi istek atınca başlar (hepsini birden başlatmak Pi'ı kilitleyip %0'da bırakıyordu).
            now = time.time()
            for i in list(self.inst.values()):
                if not (i.spare or now - i.last_active < RECENT_SEC):
                    continue
                try:
                    i.start()
                except Exception:
                    pass
                time.sleep(3)  # Pi'ı bir anda yormamak için kademeli
        threading.Thread(target=go, daemon=True).start()

    # dizin önbelleği tohumlama: yeni oturumlar hızlı bağlansın
    def seed_into(self, d):
        if os.path.exists(os.path.join(d, "cached-microdesc-consensus")):
            return
        if not os.path.exists(os.path.join(self.seed, "cached-microdesc-consensus")):
            return
        for n in SEED_FILES:
            try:
                shutil.copy2(os.path.join(self.seed, n), os.path.join(d, n))
            except OSError:
                pass

    def maybe_seed(self, d):
        cons = os.path.join(d, "cached-microdesc-consensus")
        dst = os.path.join(self.seed, "cached-microdesc-consensus")
        if not os.path.exists(cons):
            return
        try:
            if os.path.exists(dst) and time.time() - os.path.getmtime(dst) < 6 * 3600:
                return
            os.makedirs(self.seed, exist_ok=True)
            for n in SEED_FILES:
                s = os.path.join(d, n)
                if os.path.exists(s):
                    shutil.copy2(s, os.path.join(self.seed, n))
        except OSError:
            pass

    # oturum işlemleri
    def get(self, sid):
        return self.inst.get(sid)

    def create(self, sid, country, spare=False):
        if not spare and sid not in self.inst:
            taken = self._take_spare(sid)
            if taken is not None:
                if taken.country != country:
                    taken.set_country(country)
                taken.last_active = time.time()
                taken.start()
                self.kick_refill()
                return taken
        with self.lock:
            inst = self.inst.get(sid)
            if inst is None:
                if len(self.inst) >= self.max_sessions:
                    raise LimitError("Oturum sınırı doldu (%d). Kullanılmayan oturumları sil ya da Pi panelinden sınırı artır." % self.max_sessions)
                used = {i.n for i in self.inst.values()}
                n = next(k for k in range(100) if k not in used)
                inst = Instance(self, sid, n, country)
                inst.spare = spare
                self.inst[sid] = inst
                self.save_state()
            elif inst.country != country:
                inst.set_country(country)
        inst.last_active = time.time()
        inst.start()
        return inst

    def delete(self, sid):
        with self.lock:
            inst = self.inst.pop(sid, None)
            if inst:
                self.save_state()
        if not inst:
            return False
        inst.stop()
        shutil.rmtree(inst.dir, ignore_errors=True)
        return True

    def tor_mtime(self):
        try:
            return os.stat(os.path.realpath(self.cfg["tor_bin"])).st_mtime
        except OSError:
            return 0.0

    def is_stale(self, inst, mtime=None):
        """Çalışan Tor süreci, Tor ikilisi güncellenmeden ÖNCE başlamış mı (eski sürümde çalışıyor)?"""
        mt = self.tor_mtime() if mtime is None else mtime
        return bool(inst.running() and inst.started_at and mt > inst.started_at)

    def any_stale(self):
        mt = self.tor_mtime()
        return any(self.is_stale(i, mt) for i in list(self.inst.values()))

    def restart_idle(self, min_idle=IDLE_RESTART_SEC, only_stale=False):
        """min_idle sn'den uzun süredir boşta olan oturumların Tor'unu yeniden başlatır.

        Döner: {restarted, failed, errors[{id, error}]}. Biri başarısız olursa diğerlerine devam edilir.
        """
        if not self.restart_lock.acquire(blocking=False):
            raise LimitError("Yenileme zaten sürüyor.")
        try:
            now = time.time()
            mt = self.tor_mtime()
            todo = [i for i in list(self.inst.values())
                    if now - i.last_active > min_idle and (not only_stale or self.is_stale(i, mt))]
            errors = []

            def one(i):
                try:
                    i.restart()
                    return None
                except Exception as e:  # noqa: BLE001
                    return {"id": i.sid, "error": "%s: %s" % (type(e).__name__, e)}
            if todo:
                with ThreadPoolExecutor(max_workers=min(4, len(todo))) as ex:
                    errors = [r for r in ex.map(one, todo) if r]
            return {"restarted": len(todo) - len(errors), "failed": len(errors), "errors": errors}
        finally:
            self.restart_lock.release()

    def purge_idle(self, min_idle, not_ready_only=False):
        """min_idle sn'den uzun süredir boşta olan (havuzdakiler hariç) oturumları siler. not_ready_only: yalnızca
        hazır OLMAYANları (bağlanamayanlar, kapalılar). Döner: silinen sayısı."""
        now = time.time()

        def ready(i):
            try:
                return i.running() and i.status(2)["ready"]
            except Exception:
                return False
        sids = [i.sid for i in list(self.inst.values())
                if not i.spare and now - i.last_active > min_idle and not (not_ready_only and ready(i))]
        n = 0
        for sid in sids:
            try:
                if self.delete(sid):
                    n += 1
            except Exception:
                pass
        return n

    def stop_all(self):
        for i in list(self.inst.values()):
            i.stop()

    def reap_once(self, tick):
        """reaper'ın bir turu (test edilebilsin diye ayrı)."""
        now = time.time()
        for inst in list(self.inst.values()):
            try:
                if inst.ttl and not inst.spare and now - inst.last_active > inst.ttl:
                    self.delete(inst.sid)  # istemci (tarayıcı) yoklamayı bıraktı: kapanmış, oturumu bırak
                elif tick % 10 == 0 and not inst.spare and now - inst.last_active > self.idle_hours * 3600:
                    self.delete(inst.sid)
                elif not inst.running() and (inst.spare or now - inst.last_active < RECENT_SEC):
                    inst.start()  # kullanımdaki/havuz oturumu çökmüşse yeniden başlat (eskiler sahibi isteyince başlar)
            except Exception:
                pass
        try:
            if not self.filling:
                self.refill_once()
        except Exception:
            pass
        if tick % 10 == 0:
            try:
                self.save_state()  # boşta süreleri (last_active) kalıcı olsun
            except Exception:
                pass
        try:
            self.check_update_done()
            self.auto_update_tick()
        except Exception:
            pass
        if tick % 10 == 0:
            try:
                if self.any_stale():
                    self.restart_idle(only_stale=True)
            except Exception:
                pass

    def check_update_done(self):
        """Panelden başlatılan Tor güncellemesi bittiyse boştaki eski sürüm oturumlarını yenile (bir kez)."""
        d = self.updater.read()
        if d["state"] == "done" and d["ts"] and d["ts"] != self.updater.handled_ts:
            self.updater.handled_ts = d["ts"]
            self.updater.forget_versions()
            try:
                self.restart_idle(only_stale=True)
            except LimitError:
                pass

    def reaper(self):
        """Her 30 sn: çöken Tor'ları yeniden başlat. Her 5 dk: boşta kalanları sil, Tor paketi güncellendiyse
        boştaki eski sürüm oturumları kendiliğinden yenile (kullanımdaki oturumlara dokunulmaz)."""
        tick = 0
        while True:
            time.sleep(30)
            tick += 1
            self.reap_once(tick)


# ---------- HTTP API ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "torpool/" + VERSION
    protocol_version = "HTTP/1.1"
    mgr = None
    cfg = None
    nets = []
    torinfo = None
    started = time.time()

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, code, ctype, body, filename=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.end_headers()
        self.wfile.write(body)

    def _host_name(self):
        """Tarayıcının bu sayfaya ulaşmak için kullandığı Pi adresi (zip'e gömülür)."""
        h = (self.headers.get("Host") or "").strip()
        if h.startswith("["):
            return ""
        if ":" in h:
            h = h.rsplit(":", 1)[0]
        return h if re.fullmatch(r"[A-Za-z0-9._-]{1,253}", h) else ""

    def _build_zip(self, which, host):
        base = os.path.join(self.cfg["ext_dir"], which)
        if not os.path.isdir(base):
            return None
        preset = {"host": host, "apiPort": int(self.cfg["api_port"]), "token": self.cfg["token"]}
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for root, _dirs, files in os.walk(base):
                for f in sorted(files):
                    if f.startswith(".") or f == "preset.json":
                        continue
                    p = os.path.join(root, f)
                    arc = os.path.relpath(p, base).replace(os.sep, "/")
                    with open(p, "rb") as fh:
                        data = fh.read()
                    if which == "chrome" and arc == "manifest.json":
                        # Pi'a erişim izni manifestte hazır olsun: Chrome ayrıca izin sormasın
                        m = json.loads(data.decode("utf-8"))
                        hp = m.setdefault("host_permissions", [])
                        pat = "http://%s/*" % host
                        if pat not in hp:
                            hp.append(pat)
                        data = json.dumps(m, ensure_ascii=False, indent=2).encode("utf-8")
                    z.writestr(arc, data)
            z.writestr("preset.json", json.dumps(preset))
        return buf.getvalue()

    def _download_route(self, method, path):
        """Sayfa ve indirmeler. Yalnızca izinli ağdan ve token'lı bağlantıyla erişilir."""
        if method != "GET":
            return False
        if path not in ("", "/status", "/chrome.zip", "/firefox-dev.zip", "/firefox.xpi"):
            return False
        qs = parse_qs(urlsplit(self.path).query)
        tok = (qs.get("t") or [""])[0]
        cip = self.client_address[0]
        ok = (not GUARD.is_blocked(cip)) and hmac.compare_digest(tok.encode("utf-8"), str(self.cfg["token"]).encode("utf-8"))
        host = self._host_name()
        if ok:
            GUARD.ok(cip)
        else:
            GUARD.fail(cip)
            time.sleep(1)
            body = ('<div class="card"><p class="warn">Bu sayfa token ister.</p>'
                    "<p>Pi'daki kurulumun sonunda yazdırılan bağlantıyı kullan. "
                    "Tekrar görmek için Pi'da: <code>sudo bash install.sh</code> çalıştırman yeterli "
                    "(ayarlar silinmez) ya da <code>sudo cat /etc/torpool/config.json</code> ile token'ı oku "
                    "ve adresin sonuna <code>/?t=TOKEN</code> ekle.</p></div>")
            self._send_bytes(401, "text/html; charset=utf-8", render_page(body).encode("utf-8"))
            return True
        if path == "/status":
            self._send_bytes(200, "text/html; charset=utf-8", STATUS_PAGE.encode("utf-8"))
            return True
        if not host:
            self._send_bytes(400, "text/plain; charset=utf-8",
                             "Bu sayfayı IP adresi veya alan adıyla aç (örn. http://192.168.1.50:%s)."
                             % self.cfg["api_port"])
            return True

        if path == "/chrome.zip":
            data = self._build_zip("chrome", host)
            fname = "tor-ip-chrome.zip"
        elif path == "/firefox-dev.zip":
            data = self._build_zip("firefox", host)
            fname = "tor-ip-firefox-dev.zip"
        elif path == "/firefox.xpi":
            try:
                with open(self.cfg["firefox_xpi"], "rb") as fh:
                    data = fh.read()
            except OSError:
                data = None
            fname = "tor-ip-firefox.xpi"
        else:
            data = None
            fname = ""
        if path != "":
            if data is None:
                self._send_bytes(404, "text/plain; charset=utf-8", "Bu dosya bu Pi'da yok.".encode("utf-8"))
            else:
                ctype = "application/x-xpinstall" if fname.endswith(".xpi") else "application/zip"
                self._send_bytes(200, ctype, data, fname)
            return True

        t = quote(str(self.cfg["token"]), safe="")
        addr = "%s:%s#%s" % (host, self.cfg["api_port"], self.cfg["token"])
        has_ext = os.path.isdir(os.path.join(self.cfg["ext_dir"], "chrome"))
        has_xpi = os.path.isfile(self.cfg["firefox_xpi"])
        parts = []
        if has_ext:
            parts.append(
                '<div class="card"><h2>Chrome / Edge / Brave</h2>'
                '<a class="btn" href="/chrome.zip?t=%s">Eklentiyi indir (zip)</a>'
                "<ol><li>Zip'i bir klasöre çıkar ve klasörü <b>silme</b> (eklenti oradan çalışır).</li>"
                "<li><code>chrome://extensions</code> sayfasını aç, sağ üstten <b>Geliştirici modu</b>nu aç.</li>"
                "<li><b>Paketlenmemiş öğe yükle</b> de, çıkardığın klasörü seç.</li>"
                "<li>Eklenti simgesine tıkla: Pi adresi ve token hazır gelir, ülkeyi seçip <b>Bağlan</b>.</li></ol>"
                '<p>Her Chrome profilinde (hesabında) ayrı ayrı yükle; her profilin Pi\'da kendi Tor\'u olur. '
                "Chrome her açılışta \"geliştirici modundaki eklentiler\" uyarısı verir; kapatabilirsin.</p></div>"
                % t)
        if has_xpi:
            parts.append(
                '<div class="card"><h2>Firefox (imzalı paket)</h2>'
                '<a class="btn sec" href="/firefox.xpi?t=%s">Firefox eklentisini indir (.xpi)</a>'
                "<p>İndirince Firefox kurulumu sorar. İmzalı paket her cihazda aynı olduğu için Pi adresini "
                "<b>bir kez</b> eklentiye yapıştır (aşağıdaki kutudan kopyala).</p></div>" % t)
        if has_ext:
            parts.append(
                '<div class="card"><h2>Firefox Developer Edition / ESR (imzasız)</h2>'
                '<a class="btn sec" href="/firefox-dev.zip?t=%s">Firefox zip (ayarlı)</a>'
                "<p><code>about:config</code> içinde <code>xpinstall.signatures.required</code> değerini "
                "<code>false</code> yap, zip'i <code>.xpi</code> olarak yeniden adlandırıp Firefox'a sürükle. "
                "Normal Firefox'ta çalışmaz.</p></div>" % t)
        parts.append('<div class="card"><h2>Pi adresi (elle yapıştırmak istersen)</h2>'
                     "<pre>%s</pre></div>" % html.escape(addr))
        if not parts[:-1]:
            parts.insert(0, '<div class="card"><p class="warn">Eklenti dosyaları Pi\'da bulunamadı. '
                            "install.sh'yi tüm torpool klasörüyle çalıştır.</p></div>")
        parts.append('<div class="card"><h2>Durum paneli</h2>'
                     '<a class="btn sec" href="/status?t=%s">Durum paneli</a>'
                     "<p>Oturumlar, çıkış IP'leri ve isteğe bağlı hız ölçümü.</p></div>" % t)
        self._send_bytes(200, "text/html; charset=utf-8", render_page("".join(parts)).encode("utf-8"))
        return True

    def _status_payload(self):
        now = time.time()
        insts = list(self.mgr.inst.values())

        def one(i):
            st = i.status(2)
            ex = i.exit_info_cached() if st["ready"] else {}
            return {
                "id": i.sid, "short": i.sid[:6], "country": i.country, "running": st["running"],
                "ready": st["ready"], "bootstrap": st["bootstrap"], "socks_port": i.socks,
                "idle_s": max(0, int(now - i.last_active)),
                "exit_ip": ex.get("ip") or None, "exit_name": ex.get("name") or None,
                "spare": bool(i.spare),
            }
        if insts:
            with ThreadPoolExecutor(max_workers=min(8, len(insts))) as pool:
                rows = list(pool.map(one, insts))
        else:
            rows = []
        ti = self.torinfo
        return {
            "ok": True, "version": VERSION,
            "tor_version": ti.version if ti else "", "tor_outdated": bool(self.mgr.any_stale()),
            "idle_hours": self.mgr.idle_hours,
            "tor_update": dict(self.mgr.updater.info(), auto=bool(self.mgr.auto_tor_update)),
            "uptime_s": int(now - self.started), "sessions": rows,
            "pool": {"size": self.mgr.pool_size, "spares": sum(1 for r in rows if r["spare"]),
                     "ready": sum(1 for r in rows if r["spare"] and r["ready"]),
                     "max": self.mgr.max_sessions},
            "totals": {"total": len(rows), "running": sum(1 for r in rows if r["running"]),
                       "ready": sum(1 for r in rows if r["ready"])},
        }

    def _allowed(self):
        try:
            ip = ipaddress.ip_address(self.client_address[0])
            if getattr(ip, "ipv4_mapped", None):
                ip = ip.ipv4_mapped
            return any(ip in n for n in self.nets)
        except ValueError:
            return False

    def _auth(self):
        h = self.headers.get("Authorization", "")
        tok = h[7:] if h.startswith("Bearer ") else ""
        cip = self.client_address[0]
        ok = (not GUARD.is_blocked(cip)) and hmac.compare_digest(tok.encode("utf-8"), str(self.cfg["token"]).encode("utf-8"))
        if ok:
            GUARD.ok(cip)
        else:
            GUARD.fail(cip)
            time.sleep(1)  # kaba kuvveti yavaşlat
        return ok

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        if n > 4096:
            raise ValueError("Gövde çok büyük")
        data = json.loads(self.rfile.read(n).decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON nesnesi bekleniyor")
        return data

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method):
        try:
            self._route_inner(method)
        except LimitError as e:
            self._send(429, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})

    def _route_inner(self, method):
        if not self._allowed():
            return self._send(403, {"ok": False, "error": "Bu IP adresine izin verilmiyor."})
        path = self.path.split("?")[0].rstrip("/")
        if self._download_route(method, path):
            return
        if method == "GET" and path == "/api/ping":
            return self._send(200, {"ok": True, "version": VERSION})
        if not self._auth():
            return self._send(401, {"ok": False, "error": "Token hatalı."})
        try:
            body = self._body() if method in ("POST", "DELETE") else {}
        except (ValueError, json.JSONDecodeError) as e:
            return self._send(400, {"ok": False, "error": "Geçersiz istek gövdesi: %s" % e})
        m = self.mgr

        if method == "GET" and path == "/api/exits":
            try:
                counts, ts, stale = self.exits.get()
            except RuntimeError as e:
                return self._send(502, {"ok": False, "error": str(e)})
            return self._send(200, {"ok": True, "counts": counts, "updated": int(ts), "stale": stale})

        if method == "GET" and path == "/api/status":
            return self._send(200, self._status_payload())

        if method == "POST" and path == "/api/pool":
            try:
                n = int(body.get("size"))
            except (TypeError, ValueError):
                return self._send(400, {"ok": False, "error": "Geçersiz sayı."})
            if n < 0 or n > m.max_sessions:
                return self._send(400, {"ok": False, "error": "0 ile %d arasında olmalı." % m.max_sessions})
            return self._send(200, {"ok": True, "size": m.set_pool_size(n)})

        if method == "POST" and path == "/api/max-sessions":
            try:
                n = int(body.get("max"))
            except (TypeError, ValueError):
                return self._send(400, {"ok": False, "error": "Geçersiz sayı."})
            if n < 1 or n > 100:
                return self._send(400, {"ok": False, "error": "1 ile 100 arasında olmalı."})
            return self._send(200, {"ok": True, "max": m.set_max_sessions(n), "pool": m.pool_size})

        if method == "POST" and path == "/api/auto-update":
            if not m.updater.supported():
                return self._send(409, {"ok": False, "error": "Güncelleme servisi kurulu değil. Pi'da 'sudo bash install.sh' çalıştır (yeni sürümle)."})
            return self._send(200, {"ok": True, "auto": m.set_auto_tor_update(bool(body.get("on")))})

        if method == "POST" and path == "/api/update-tor":
            u = m.updater
            if not u.supported():
                return self._send(409, {"ok": False, "error": "Güncelleme servisi kurulu değil. Pi'da 'sudo bash install.sh' çalıştır (yeni sürümle)."})
            if not u.request():
                return self._send(409, {"ok": False, "error": "Güncelleme zaten sürüyor."})
            return self._send(200, {"ok": True})

        if method == "POST" and path == "/api/idle-hours":
            try:
                h = float(body.get("hours"))
            except (TypeError, ValueError):
                return self._send(400, {"ok": False, "error": "Geçersiz süre."})
            if h < 1 or h > 8760:
                return self._send(400, {"ok": False, "error": "Süre 1 ile 8760 saat arasında olmalı."})
            return self._send(200, {"ok": True, "hours": m.set_idle_hours(h)})

        if method == "POST" and path == "/api/purge-idle":
            try:
                hours = float(body.get("hours", 1))
            except (TypeError, ValueError):
                return self._send(400, {"ok": False, "error": "Geçersiz süre."})
            if hours < 0 or hours > 24 * 365:
                return self._send(400, {"ok": False, "error": "Süre 0 ile 8760 saat arasında olmalı."})
            return self._send(200, {"ok": True, "deleted": m.purge_idle(hours * 3600, bool(body.get("not_ready_only")))})

        if method == "POST" and path == "/api/restart-idle":
            r = m.restart_idle()
            return self._send(200, dict(r, ok=True))

        if method == "GET" and path == "/api/sessions":
            return self._send(200, {"ok": True, "sessions": [i.status() for i in list(m.inst.values())]})

        if method == "POST" and path == "/api/session":
            sid = str(body.get("id", ""))
            cc = str(body.get("country", "auto")).lower()
            if not ID_RE.match(sid):
                return self._send(400, {"ok": False, "error": "Geçersiz oturum kimliği."})
            if not CC_RE.match(cc):
                return self._send(400, {"ok": False, "error": "Geçersiz ülke kodu."})
            inst = m.create(sid, cc)
            if "ttl" in body:  # eklenti: her dakika yoklar; yoklama kesilirse (Chrome kapandı) oturum silinir
                try:
                    t = int(body.get("ttl") or 0)
                except (TypeError, ValueError):
                    t = 0
                inst.ttl = 0 if t <= 0 else max(120, min(t, 86400))
                m.save_state()
            return self._send(200, dict(inst.status(), ok=True))

        mm = re.fullmatch(r"/api/session/([a-f0-9]{8,32})(/newnym|/country|/pin|/probe)?", path)
        if mm:
            sid, sub = mm.group(1), mm.group(2)
            inst = m.get(sid)
            if inst is None:
                return self._send(404, {"ok": False, "error": "Oturum yok."})
            if sub != "/probe":  # ölçüm paneli oturumu "etkin" saymasın (boşta silme süresi işlemesin)
                inst.last_active = time.time()
                if method != "DELETE" and not inst.running():
                    inst.start()  # sahibi geri geldi: Pi yeniden başlayınca açılmamış oturumu başlat
            if method == "GET" and not sub:
                return self._send(200, dict(inst.status(), ok=True))
            if method == "POST" and sub == "/newnym":
                if not inst.running():
                    return self._send(409, {"ok": False, "error": "Bu oturumun Tor'u çalışmıyor."})
                inst.newnym()
                return self._send(200, {"ok": True})
            if method == "POST" and sub == "/probe":
                if not inst.running():
                    return self._send(409, {"ok": False, "error": "Bu oturumun Tor'u çalışmıyor."})
                if not inst.status(2)["ready"]:
                    return self._send(409, {"ok": False, "error": "Bu oturum henüz hazır değil."})
                try:
                    r = inst.probe(25)
                except LimitError:
                    raise
                except Exception as e:  # noqa: BLE001
                    return self._send(502, {"ok": False, "error": "Ölçüm başarısız: %s" % e})
                return self._send(200, dict(r, ok=True))
            if method == "POST" and sub == "/pin":
                if not inst.running():
                    return self._send(409, {"ok": False, "error": "Bu oturumun Tor'u çalışmıyor."})
                ip = str(body.get("ip", ""))
                if ip and not re.fullmatch(r"(\d{1,3})(\.\d{1,3}){3}", ip):
                    return self._send(400, {"ok": False, "error": "Geçersiz IP."})
                inst.pin_exit(ip)
                return self._send(200, {"ok": True})
            if method == "POST" and sub == "/country":
                cc = str(body.get("country", "")).lower()
                if not CC_RE.match(cc):
                    return self._send(400, {"ok": False, "error": "Geçersiz ülke kodu."})
                inst.set_country(cc)
                return self._send(200, dict(inst.status(), ok=True))
            if method == "DELETE" and not sub:
                m.delete(sid)
                return self._send(200, {"ok": True})

        return self._send(404, {"ok": False, "error": "Bilinmeyen yol."})


def main():
    cfg = load_config()
    mgr = Manager(cfg)
    mgr.load_and_start()
    mgr.kick_refill()  # hazır oturum havuzunu başlangıçta doldur
    threading.Thread(target=mgr.reaper, daemon=True).start()

    Handler.mgr = mgr
    Handler.exits = ExitCounts(cfg["exits_url"], int(cfg["exits_ttl"]))
    Handler.cfg = cfg
    Handler.started = time.time()
    Handler.torinfo = TorBinInfo(cfg["tor_bin"], Handler.started)
    Handler.nets = [ipaddress.ip_network(c, strict=False) for c in cfg["allowed_cidrs"]]
    srv = ThreadingHTTPServer((cfg["api_bind"], int(cfg["api_port"])), Handler)
    srv.daemon_threads = True

    def bye(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)
    try:
        srv.serve_forever()
    finally:
        mgr.stop_all()


if __name__ == "__main__":
    main()
