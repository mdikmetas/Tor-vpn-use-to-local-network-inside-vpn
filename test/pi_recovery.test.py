#!/usr/bin/env python3
"""Pi toparlanma testi: çöken Tor yeniden başlar; Tor paketi güncellenince boştaki eski oturumlar yenilenir, aktif olana dokunulmaz."""
import importlib.util, os, re, signal, socket, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("torpool", os.path.join(HERE, "..", "pi", "torpool.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def check(c, msg):
    if not c:
        print("FAIL", msg); sys.exit(1)
    print("ok  ", msg)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

# sahte tor: pi_status testindekiyle aynı betik
src = open(os.path.join(HERE, "pi_status.test.py"), encoding="utf-8").read()
FAKE = re.search(r"FAKE_TOR = r'''(.*?)'''", src, re.S).group(1)
d = tempfile.mkdtemp(prefix="pirec-")
tor_bin = os.path.join(d, "faketor.py")
open(tor_bin, "w").write(FAKE); os.chmod(tor_bin, 0o755)
os.utime(tor_bin, (time.time() - 3600, time.time() - 3600))

cfg = dict(m.DEFAULTS)
cfg.update({"pool_size": 0, "token": "t" * 16, "api_bind": "127.0.0.1", "api_port": 0, "socks_bind": "127.0.0.1",
            "socks_base": free_port(), "control_base": free_port(), "state_dir": d, "tor_bin": tor_bin,
            "bridges_file": os.path.join(d, "none.txt"), "allowed_cidrs": ["127.0.0.0/8"],
            "ext_dir": os.path.join(d, "x"), "geoip": "/nonexistent", "geoip6": "/nonexistent"})

def wait(cond, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond(): return True
        time.sleep(0.3)
    return False

mgr = m.Manager(cfg)
a = mgr.create("a1a1a1a1", "auto"); b = mgr.create("b2b2b2b2", "auto")
try:
    check(wait(lambda: a.status()["ready"] and b.status()["ready"]), "iki oturum hazır")
    check(not mgr.any_stale(), "başlangıçta eski sürüm uyarısı yok")

    # 1) Tor süreci çöker -> reaper turu yeniden başlatır
    old = a.proc.pid
    os.kill(old, signal.SIGKILL); a.proc.wait()
    check(not a.running(), "çöktü")
    mgr.reap_once(1)
    check(a.running() and a.proc.pid != old, "çöken Tor reaper turunda yeniden başladı")
    check(wait(lambda: a.status()["ready"]), "yeniden başlayan oturum hazır")

    # 2) Tor paketi güncellendi (ikili daha yeni)
    os.utime(tor_bin, (time.time(), time.time())); time.sleep(1.1)
    check(mgr.any_stale(), "Tor güncellenince eski sürüm uyarısı var")
    a.last_active = time.time() - 1200   # boşta
    b.last_active = time.time() - 10     # kullanımda
    pa, pb = a.proc.pid, b.proc.pid
    mgr.reap_once(10)
    check(a.proc.pid != pa, "boştaki eski oturum kendiliğinden yenilendi")
    check(b.proc.pid == pb, "kullanımdaki oturuma dokunulmadı")
    check(wait(lambda: a.status()["ready"]), "yenilenen oturum hazır")
    check(not mgr.is_stale(a) and mgr.is_stale(b), "yenilenen güncel, kullanımdaki hâlâ eski")
    check(mgr.any_stale(), "kullanımdaki eski olduğu için uyarı sürüyor")
    b.last_active = time.time() - 1200
    mgr.reap_once(20)
    check(wait(lambda: b.status()["ready"]) and not mgr.any_stale(), "boşa çıkınca o da yenilendi, uyarı kalktı")
finally:
    mgr.stop_all()
print("PI TOPARLANMA TESTLERİ GEÇTİ")
