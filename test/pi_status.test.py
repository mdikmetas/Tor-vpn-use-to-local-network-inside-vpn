"""Pi durum paneli testleri: ayrıştırıcılar, SOCKS5 istemcisi, uçtan uca servis (sahte Tor ile).
Çalıştırma:  python3 test/pi_status.test.py   (hata olursa sıfırdan farklı kodla çıkar)"""
import http.server, importlib.util, json, os, shutil, signal, socket, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PI = os.path.join(HERE, "..", "pi", "torpool.py")
spec = importlib.util.spec_from_file_location("torpool", PI)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

FAILS = []
def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("BAŞARISIZ:", msg)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

# ---------------- 1) saf ayrıştırıcılar ----------------
A, B, C, D = "A" * 40, "B" * 40, "C" * 40, "D" * 40
lines = [
    "250+circuit-status=",
    "99 BUILT $%s~g,$%s~m,$%s~old BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL TIME_CREATED=2024-01-01T00:00:00" % (A, B, C),
    "123 BUILT $%s~g,$%s~m,$%s~exitnick PURPOSE=GENERAL" % (A, B, C),
    "130 EXTENDED $%s~g,$%s~m PURPOSE=GENERAL" % (A, B),
    "140 BUILT $%s~g,$%s~m,$%s~hsdir PURPOSE=HS_CLIENT_HSDIR" % (A, B, D),
    "250 OK",
]
r = m.parse_exit_from_circuits(lines)
check(r and r["fingerprint"] == C and r["name"] == "exitnick" and r["circuit"] == "123", "en büyük numaralı BUILT GENERAL devre seçilmeli: %r" % r)
r = m.parse_exit_from_circuits(["125 BUILT $%s=eqname PURPOSE=GENERAL" % C.lower()])
check(r and r["fingerprint"] == C and r["name"] == "eqname", "$FP=nick biçimi: %r" % r)
r = m.parse_exit_from_circuits(["7 BUILT $%s PURPOSE=GENERAL" % C])
check(r and r["name"] == "", "takma adsız halka: %r" % r)
r = m.parse_exit_from_circuits(["250-circuit-status=5 BUILT $%s~one PURPOSE=GENERAL" % A])
check(r and r["name"] == "one", "tek satırlı yanıt: %r" % r)
check(m.parse_exit_from_circuits([]) is None, "boş -> None")
check(m.parse_exit_from_circuits(["1 LAUNCHED $%s~x PURPOSE=GENERAL" % A, "250 OK"]) is None, "BUILT olmayan -> None")
check(m.parse_exit_from_circuits(["1 BUILT $zzz~x PURPOSE=GENERAL"]) is None, "bozuk parmak izi -> None")

ns = ["250+ns/id/%s=" % C, "r exitnick cWJ1 ZGln 2024-01-01 00:00:00 203.0.113.9 9001 0", "s Exit Fast", ".", "250 OK"]
check(m.parse_router_ip(ns[:2]) == "203.0.113.9", "r satırı IPv4")
check(m.parse_router_ip(ns) == "203.0.113.9", "tam yanıt")
check(m.parse_router_ip(["r n a b d t 999.1.1.1 9001 0"]) is None, "geçersiz IP -> None")
check(m.parse_router_ip(["r n a b"]) is None, "kısa satır -> None")
check(m.parse_router_ip([]) is None, "boş -> None")
check(m.parse_tor_version("Tor version 0.4.8.12.\n") == "0.4.8.12", "sürüm 1")
check(m.parse_tor_version("Tor version 0.4.9.1-alpha (git-abc).") == "0.4.9.1-alpha", "sürüm 2")
check(m.parse_tor_version("nonsense") == "", "sürüm yok")

# TorBinInfo: tor_outdated mantığı
d0 = tempfile.mkdtemp(prefix="pistat-")
fake_bin = os.path.join(d0, "tor")
open(fake_bin, "w").write("#!/bin/sh\necho 'Tor version 1.2.3.4.'\n"); os.chmod(fake_bin, 0o755)
link = os.path.join(d0, "tor-link"); os.symlink(fake_bin, link)
started = time.time()
os.utime(fake_bin, (started - 100, started - 100))
ti = m.TorBinInfo(link, started, recheck=0)
check(ti.version == "1.2.3.4", "tor sürümü okunmalı: %r" % ti.version)
check(ti.outdated() is False, "eski mtime -> güncel")
os.utime(fake_bin, (started + 50, started + 50))
check(ti.outdated() is True, "yeni mtime (symlink çözülerek) -> eski sürüm uyarısı")
ti2 = m.TorBinInfo(os.path.join(d0, "yok"), started, recheck=0)
check(ti2.version == "" and ti2.outdated() is False, "ikili yoksa hata vermemeli")
ti3 = m.TorBinInfo(fake_bin, started, recheck=60)
ti3.outdated(); os.utime(fake_bin, (started - 100, started - 100))
check(ti3.outdated() is True, "60 sn içinde yeniden kontrol edilmemeli")

# ---------------- 2) SOCKS5 istemcisi ----------------
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/ip":
            body = json.dumps({"IsTor": True, "IP": "203.0.113.9"}).encode(); code = 200
        else:
            body = b"yok"; code = 404
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
web = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=web.serve_forever, daemon=True).start()
web_port = web.server_address[1]

SEEN = []
def pump(a, b):
    try:
        while True:
            x = a.recv(4096)
            if not x: break
            b.sendall(x)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass

def socks_server(port, mode="ok"):
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port)); srv.listen(5)
    def rd(c, n):
        b = b""
        while len(b) < n:
            x = c.recv(n - len(b))
            if not x: raise EOFError
            b += x
        return b
    def handle(c):
        try:
            ver, n = rd(c, 2); rd(c, n)
            c.sendall(b"\x05\x00")
            _v, cmd, _r, atyp = rd(c, 4)
            assert atyp == 3, "alan adıyla CONNECT bekleniyordu"
            name = rd(c, rd(c, 1)[0]).decode(); prt = int.from_bytes(rd(c, 2), "big")
            SEEN.append((name, prt))
            if mode == "refuse":
                c.sendall(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00"); c.close(); return
            up = socket.create_connection(("127.0.0.1", web_port))
            c.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
            threading.Thread(target=pump, args=(up, c), daemon=True).start()
            pump(c, up)
        except Exception:
            pass
        finally:
            c.close()
    def loop():
        while True:
            try: c, _ = srv.accept()
            except OSError: return
            threading.Thread(target=handle, args=(c,), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()
    return srv

sp = free_port(); s1 = socks_server(sp)
r = m.socks5_http_get("127.0.0.1", sp, "check.example", web_port, "/api/ip", False, 5)
check(r["status"] == 200 and json.loads(r["body"]) == {"IsTor": True, "IP": "203.0.113.9"}, "SOCKS5 GET gövdesi: %r" % r)
check(r["ms"] >= r["connect_ms"] >= 0, "süre alanları: %r" % r)
check(SEEN and SEEN[-1] == ("check.example", web_port), "CONNECT alan adıyla yapılmalı (uzaktan DNS): %r" % SEEN)
r = m.socks5_http_get("127.0.0.1", sp, "check.example", web_port, "/yok", False, 5)
check(r["status"] == 404, "404 durumu iletilmeli")
s1.close()
sp2 = free_port(); s2 = socks_server(sp2, "refuse")
try:
    m.socks5_http_get("127.0.0.1", sp2, "check.example", 443, "/", False, 5); check(False, "reddedilen CONNECT hata vermeli")
except RuntimeError as e:
    check("reddedildi" in str(e), "reddedilme mesajı Türkçe olmalı: %s" % e)
s2.close()
try:
    m.socks5_http_get("127.0.0.1", free_port(), "x.example", 80, "/", False, 3); check(False, "dinleyen yok -> hata")
except RuntimeError as e:
    check("SOCKS" in str(e), "bağlantı hatası mesajı: %s" % e)
try:
    m.socks5_http_get("127.0.0.1", 1, "x.example", 80, "/a b", False, 3); check(False, "geçersiz yol hata vermeli")
except RuntimeError:
    pass
# zaman aşımı: kabul eden ama yanıt vermeyen sunucu
dead = socket.socket(); dead.bind(("127.0.0.1", 0)); dead.listen(5)
t0 = time.time()
try:
    m.socks5_http_get("127.0.0.1", dead.getsockname()[1], "x.example", 80, "/", False, 1); check(False, "zaman aşımı bekleniyordu")
except RuntimeError as e:
    check("zaman aşımı" in str(e) and time.time() - t0 < 4, "zaman aşımı mesajı/süresi: %s" % e)
dead.close()

# ---------------- 3) Manager.restart_idle (süreç içi) ----------------
FAKE_TOR = r'''#!/usr/bin/env python3
import sys, os, re, socket, threading, time
if "--version" in sys.argv:
    print("Tor version 0.4.8.99 (git-fake)."); sys.exit(0)
rc = sys.argv[sys.argv.index("-f") + 1]
conf = open(rc).read()
datadir = re.search(r"^DataDirectory (.+)$", conf, re.M).group(1).strip()
ctl = int(re.search(r"^ControlPort 127\.0\.0\.1:(\d+)", conf, re.M).group(1))
os.makedirs(datadir, exist_ok=True)
open(os.path.join(datadir, "control_auth_cookie"), "wb").write(b"0123456789abcdef0123456789abcdef")
log = open(os.path.join(datadir, "cmds.log"), "a")
t0 = time.time()
def prog():
    p = min(100, int((time.time() - t0) * 40))
    if p >= 100:
        open(os.path.join(datadir, "cached-microdesc-consensus"), "w").write("c")
    return p
A, B, C, D = "A" * 40, "B" * 40, "C" * 40, "D" * 40
def serve(c):
    f = c.makefile("rb")
    for raw in f:
        l = raw.decode().strip(); log.write(l + "\n"); log.flush()
        if l == "GETINFO status/bootstrap-phase":
            c.sendall(('250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=%d TAG=x SUMMARY="Test"\r\n250 OK\r\n' % prog()).encode())
        elif l == "GETINFO circuit-status":
            c.sendall(("250+circuit-status=\r\n"
              "99 BUILT $%s~guard,$%s~mid,$%s~oldexit BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL TIME_CREATED=2024-01-01T00:00:00.1\r\n"
              "123 BUILT $%s~guard,$%s~mid,$%s~exitnick BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL TIME_CREATED=2024-01-01T00:01:00.1\r\n"
              "124 BUILT $%s~guard,$%s~mid,$%s~hsdir PURPOSE=HS_CLIENT_HSDIR\r\n.\r\n250 OK\r\n" % (A, B, C, A, B, C, A, B, D)).encode())
        elif l.startswith("GETINFO ns/id/"):
            fp = l.split("/")[-1]
            c.sendall(("250+ns/id/%s=\r\nr exitnick cWJ1YmJ1YmJ1YmJ1YmJ1YmJ1Yg ZGlnZXN0ZGlnZXN0ZGlnZXN0 2024-01-01 00:00:00 203.0.113.9 9001 0\r\ns Exit Fast Running Valid\r\n.\r\n250 OK\r\n" % fp).encode())
        elif l == "SIGNAL SHUTDOWN":
            c.sendall(b"250 OK\r\n"); os._exit(0)
        else:
            c.sendall(b"250 OK\r\n")
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", ctl)); srv.listen(5)
while True:
    c, _ = srv.accept(); threading.Thread(target=serve, args=(c,), daemon=True).start()
'''
tordir = tempfile.mkdtemp(prefix="pistat-tor-")
tor_bin = os.path.join(tordir, "faketor.py")
open(tor_bin, "w").write(FAKE_TOR); os.chmod(tor_bin, 0o755)
os.utime(tor_bin, (time.time() - 3600, time.time() - 3600))

def make_cfg(state, api, **kw):
    sb = free_port(); cb = free_port()
    cfg = dict(m.DEFAULTS)
    cfg.update({"pool_size": 0, "token": "testtoken123456", "api_bind": "127.0.0.1", "api_port": api, "socks_bind": "127.0.0.1",
                "socks_base": sb, "control_base": cb, "state_dir": state, "tor_bin": tor_bin,
                "bridges_file": os.path.join(state, "none.txt"), "allowed_cidrs": ["127.0.0.0/8"],
                "ext_dir": os.path.join(state, "x"), "geoip": "/nonexistent", "geoip6": "/nonexistent"})
    cfg.update(kw)
    return cfg

def wait(cond, timeout=30, step=0.3):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond(): return True
        time.sleep(step)
    return False

st1 = tempfile.mkdtemp(prefix="pistat-st1-")
mgr = m.Manager(make_cfg(st1, 0))
ids = ["a1" * 4, "b2" * 4, "c3" * 4]
try:
    # çakışmayı önlemek için ctl/socks tabanları farklı oturumlar için n ile artar; portlar ardışık boş olmayabilir -> yeniden dene
    insts = [mgr.create(i, cc) for i, cc in zip(ids, ["de", "auto", "nl"])]
    check(wait(lambda: all(i.status()["ready"] for i in insts), 40), "3 oturum hazır olmalı")
    old_pids = [i.proc.pid for i in insts]
    now = time.time()
    insts[0].last_active = now - 1200   # boşta
    insts[1].last_active = now - 1200   # boşta ama restart hata verecek
    insts[2].last_active = now - 30     # aktif
    port0, ctl0, n0 = insts[0].socks, insts[0].ctl, insts[0].n
    orig = insts[1].restart
    def boom(): raise OSError("deneme hatası")
    insts[1].restart = boom
    res = mgr.restart_idle()
    check(res["restarted"] == 1 and res["failed"] == 1 and len(res["errors"]) == 1 and res["errors"][0]["id"] == ids[1],
          "restart_idle sonucu: %r" % res)
    check(insts[0].proc.pid != old_pids[0], "boştaki oturum yeniden başlatılmalı")
    check(insts[2].proc.pid == old_pids[2], "aktif oturuma dokunulmamalı")
    check(insts[1].proc.pid == old_pids[1], "hata veren oturum eski haliyle kalmalı")
    check((insts[0].socks, insts[0].ctl, insts[0].n, insts[0].country) == (port0, ctl0, n0, "de"), "port/ülke/n aynı kalmalı")
    check(wait(lambda: insts[0].status()["ready"], 30) and insts[0].applied, "yenilenen oturum yeniden hazır olmalı (applied tekrar uygulanmalı)")
    log0 = open(os.path.join(insts[0].dir, "cmds.log")).read()
    check(log0.count("SETCONF ExitNodes={de} StrictNodes=1") >= 2, "ülke kısıtı yeni süreçte tekrar uygulanmalı")
    saved = json.load(open(mgr.state_file))
    check(all(saved[ids[0]].get(k) == v for k, v in {"n": n0, "country": "de", "spare": False}.items()) and isinstance(saved[ids[0]].get("last_active"), int) and len(saved) == 3, "kayıtlı durum tutarlı: %r" % saved)
    insts[1].restart = orig
    # eşzamanlı ikinci yenileme reddedilir
    mgr.restart_lock.acquire()
    try:
        mgr.restart_idle(); check(False, "eşzamanlı yenileme LimitError vermeli")
    except m.LimitError:
        pass
    finally:
        mgr.restart_lock.release()
finally:
    mgr.stop_all()

# ---------------- 4) uçtan uca servis ----------------
api = free_port()
st2 = tempfile.mkdtemp(prefix="pistat-st2-")
cfg = make_cfg(st2, api, probe_tls=False, probe_host="check.test", probe_port=web_port, probe_path="/api/ip")
cfgfile = os.path.join(st2, "config.json")
json.dump(cfg, open(cfgfile, "w"))
env = dict(os.environ, TORPOOL_CONFIG=cfgfile)
proc = subprocess.Popen([sys.executable, PI], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
BASE = "http://127.0.0.1:%d" % api
TOK = cfg["token"]

def call(method, path, auth=True, body=None, token=TOK):
    req = urllib.request.Request(BASE + path, method=method, data=(json.dumps(body).encode() if body is not None else None))
    if auth: req.add_header("Authorization", "Bearer " + token)
    if body is not None: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def jcall(*a, **k):
    code, raw = call(*a, **k)
    return code, json.loads(raw.decode("utf-8"))

try:
    def up():
        try:
            return call("GET", "/api/ping", auth=False)[0] == 200
        except OSError:
            return False
    check(wait(up, 10) and proc.poll() is None, "servis başlamalı")
    code, j = jcall("GET", "/api/status", auth=False)
    check(code == 401, "/api/status token'sız 401 olmalı: %s" % code)
    code, j = jcall("GET", "/api/status")
    check(code == 200 and j["ok"] and j["version"] == m.VERSION and j["sessions"] == [] and j["totals"] == {"total": 0, "running": 0, "ready": 0}, "boş durum: %r" % j)
    check(j["tor_version"] == "0.4.8.99" and j["tor_outdated"] is False and isinstance(j["uptime_s"], int), "tor sürümü/outdated: %r" % j)

    sid = "ab12cd34ef56ab12cd34ef56ab12cd34"
    code, j = jcall("POST", "/api/session", body={"id": sid, "country": "de"})
    check(code == 200, "oturum açılmalı: %s %r" % (code, j))
    def ready():
        c, j = jcall("GET", "/api/status")
        return c == 200 and j["totals"]["ready"] == 1
    check(wait(ready, 40), "oturum hazır olmalı")
    code, j = jcall("GET", "/api/status")
    s = j["sessions"][0] if j["sessions"] else {}
    check(s.get("id") == sid and s.get("short") == sid[:6] and s.get("country") == "de" and s.get("running") and s.get("ready")
          and s.get("bootstrap") == 100 and isinstance(s.get("socks_port"), int) and isinstance(s.get("idle_s"), int),
          "oturum alanları: %r" % s)
    check(s.get("exit_ip") == "203.0.113.9" and s.get("exit_name") == "exitnick", "çıkış IP/ad (en büyük devre): %r" % s)
    check(j["totals"] == {"total": 1, "running": 1, "ready": 1}, "toplamlar: %r" % j["totals"])
    check(set(s) == {"id", "short", "country", "running", "ready", "bootstrap", "socks_port", "idle_s", "exit_ip", "exit_name", "spare"}, "alan kümesi: %r" % sorted(s))

    # /status HTML
    code, raw = call("GET", "/status?t=" + TOK, auth=False)
    page = raw.decode("utf-8")
    check(code == 200 and "<title>" in page and "Tor havuzu durumu" in page, "/status sayfası")
    check(TOK not in page, "token sayfaya yazılmamalı")
    check("history.replaceState" in page and "/api/status" in page and "Bearer" in page and "Boştaki oturumları yenile" in page, "sayfa JS'i")
    check("innerHTML" not in page and "http://" not in page.replace("http://www.w3.org", "") and "https://" not in page, "innerHTML ve dış kaynak olmamalı")
    check("Tor güncellendi; çalışan oturumlar eski sürümde." in page, "uyarı bandı metni")
    code, raw = call("GET", "/status", auth=False); check(code == 401 and TOK not in raw.decode("utf-8"), "/status token'sız 401")
    code, raw = call("GET", "/status?t=yanlis", auth=False); check(code == 401, "/status yanlış token 401")
    code, raw = call("GET", "/?t=" + TOK, auth=False)
    check(code == 200 and b"/status?t=" in raw, "indirme sayfasında durum paneli bağlantısı")

    # ölçüm: hata yolu (SOCKS portu dinlemiyor) -> temiz 502
    code, j = jcall("POST", "/api/session/%s/probe" % sid)
    check(code == 502 and j["ok"] is False and "Ölçüm başarısız" in j["error"], "ölçüm 502 vermeli: %s %r" % (code, j))
    code, j = jcall("POST", "/api/session/%s/probe" % sid)
    check(code == 429, "5 sn bekleme süresi 429 vermeli: %s %r" % (code, j))
    code, j = jcall("POST", "/api/session/%s/probe" % ("0" * 32)); check(code == 404, "olmayan oturum 404: %s" % code)
    code, j = jcall("POST", "/api/session/%s/probe" % sid, auth=False); check(code == 401, "ölçüm token'sız 401")
    # SOCKS ayağa kalkınca (bekleme dolduktan sonra) başarılı ölçüm
    s_port = s["socks_port"]
    fs = socks_server(s_port)
    time.sleep(5.3)
    code, j = jcall("POST", "/api/session/%s/probe" % sid)
    check(code == 200 and j["ok"] and j["ip"] == "203.0.113.9" and j["is_tor"] is True and j["ms"] >= j["connect_ms"] >= 0, "başarılı ölçüm: %s %r" % (code, j))
    check(SEEN and SEEN[-1][0] == "check.test", "ölçüm alan adıyla CONNECT yapmalı")
    fs.close()

    # restart-idle
    code, j = jcall("POST", "/api/restart-idle", auth=False); check(code == 401, "restart-idle token'sız 401")
    code, j = jcall("POST", "/api/restart-idle")
    check(code == 200 and j["ok"] and j["restarted"] == 0 and j["failed"] == 0, "taze oturum yenilenmemeli: %r" % j)
    # durmuş oturum: 409
    code, j = jcall("GET", "/api/status"); check(code == 200 and j["totals"]["ready"] == 1, "restart-idle sonrası hâlâ hazır")
    code, j = jcall("DELETE", "/api/session/" + sid); check(code == 200, "oturum silinmeli")
    code, j = jcall("GET", "/api/status"); check(j["totals"]["total"] == 0, "silinince toplam 0")
finally:
    proc.send_signal(signal.SIGTERM)
    try: proc.wait(10)
    except subprocess.TimeoutExpired: proc.kill()
    web.shutdown()
    for d in (d0, tordir, st1, st2):
        shutil.rmtree(d, ignore_errors=True)
    os.system("pkill -f '%s' >/dev/null 2>&1" % tor_bin)

if FAILS:
    print("%d TEST BAŞARISIZ" % len(FAILS)); sys.exit(1)
print("PI DURUM PANELİ TESTLERİ GEÇTİ")
