#!/usr/bin/env python3
"""Nabız süresi (ttl) testi: tarayıcı kapanıp yoklama kesilince Pi oturumu kendisi siler; yoklayan/ttl'siz oturuma dokunmaz."""
import importlib.util, os, re, socket, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("torpool", os.path.join(HERE, "..", "pi", "torpool.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def check(c, msg):
    if not c:
        print("FAIL", msg); sys.exit(1)
    print("ok  ", msg)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

src = open(os.path.join(HERE, "pi_status.test.py"), encoding="utf-8").read()
FAKE = re.search(r"FAKE_TOR = r'''(.*?)'''", src, re.S).group(1)
d = tempfile.mkdtemp(prefix="pittl-")
tor_bin = os.path.join(d, "faketor.py")
open(tor_bin, "w").write(FAKE); os.chmod(tor_bin, 0o755)
cfg = dict(m.DEFAULTS)
cfg.update({"pool_size": 0, "token": "t" * 16, "api_bind": "127.0.0.1", "api_port": 0, "socks_bind": "127.0.0.1",
            "socks_base": free_port(), "control_base": free_port(), "state_dir": d, "tor_bin": tor_bin,
            "bridges_file": os.path.join(d, "none.txt"), "allowed_cidrs": ["127.0.0.0/8"],
            "ext_dir": os.path.join(d, "x"), "geoip": "/nonexistent", "geoip6": "/nonexistent"})

mgr = m.Manager(cfg)
try:
    a = mgr.create("a" * 16, "auto"); a.ttl = 180      # eklenti oturumu (nabızlı)
    b = mgr.create("b" * 16, "auto")                    # ttl'siz (masaüstü uygulaması vb.)
    c = mgr.create("c" * 16, "auto"); c.ttl = 180      # nabzı sürüyor
    old = time.time() - 400
    a.last_active = old; b.last_active = old; c.last_active = time.time() - 60
    mgr.save_state()
    mgr.reap_once(1)
    check("a" * 16 not in mgr.inst, "yoklaması kesilen (3 dk+) oturum silindi")
    check("b" * 16 in mgr.inst, "ttl'siz eski oturuma dokunulmadı")
    check("c" * 16 in mgr.inst, "yoklaması süren oturum duruyor")
    mgr.save_state()
    mgr2 = m.Manager(cfg)
    mgr2.load_and_start()
    check(mgr2.inst["c" * 16].ttl == 180, "ttl yeniden başlatmada korundu")
    mgr2.stop_all()
finally:
    mgr.stop_all()
print("\nTTL TESTLERI GECTI")
