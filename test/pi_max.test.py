#!/usr/bin/env python3
"""En çok oturum sayısı panelden değişir: ayar kalıcı, havuz sınırı aşamaz, sınır dolunca yeni oturum reddedilir."""
import importlib.util, os, re, socket, sys, tempfile

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
d = tempfile.mkdtemp(prefix="pimax-")
tor_bin = os.path.join(d, "faketor.py")
open(tor_bin, "w").write(FAKE); os.chmod(tor_bin, 0o755)
cfg = dict(m.DEFAULTS)
cfg.update({"pool_size": 0, "max_sessions": 20, "token": "t" * 16, "api_bind": "127.0.0.1", "api_port": 0,
            "socks_bind": "127.0.0.1", "socks_base": free_port(), "control_base": free_port(), "state_dir": d,
            "tor_bin": tor_bin, "bridges_file": os.path.join(d, "none.txt"), "allowed_cidrs": ["127.0.0.0/8"],
            "ext_dir": os.path.join(d, "x"), "geoip": "/nonexistent", "geoip6": "/nonexistent"})

mgr = m.Manager(cfg)
try:
    check(mgr.max_sessions == 20, "varsayılan 20")
    check(mgr.set_max_sessions(2) == 2, "panelden 2'ye düşürüldü")
    mgr.create("a" * 16, "auto"); mgr.create("b" * 16, "auto")
    try:
        mgr.create("c" * 16, "auto"); ok = False
    except m.LimitError:
        ok = True
    check(ok, "sınır dolunca yeni oturum reddedildi")
    check(mgr.set_max_sessions(1) == 1 and len(mgr.inst) == 2, "sınırı düşürmek mevcut oturumları silmedi")
    mgr.set_pool_size(1)
    check(mgr.pool_size == 1, "havuz boyutu ayarlandı")
    mgr.set_max_sessions(500)
    check(mgr.max_sessions == 100, "üst sınır 100")
    mgr.set_max_sessions(0)
    check(mgr.max_sessions == 1, "alt sınır 1")
    mgr.set_max_sessions(30)
    mgr.set_pool_size(5)
    mgr.set_max_sessions(3)
    check(mgr.pool_size == 3, "havuz boyutu yeni sınıra çekildi")
    mgr.stop_all()
    mgr2 = m.Manager(cfg)
    check(mgr2.max_sessions == 3, "ayar yeniden başlatmada korundu (settings.json, config.json'u geçer)")
finally:
    mgr.stop_all()
print("\nMAX OTURUM TESTLERI GECTI")
