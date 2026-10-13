#!/usr/bin/env python3
"""Panelden Tor güncelleme: apt policy ayrıştırma, istek/durum dosyaları, update-tor.sh (sahte apt ile)."""
import importlib.util, json, os, stat, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("torpool", os.path.join(HERE, "..", "pi", "torpool.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def check(c, msg):
    if not c:
        print("FAIL", msg); sys.exit(1)
    print("ok  ", msg)

POLICY = """tor:
  Installed: 0.4.9.11-1~deb12u1
  Candidate: 0.4.9.13-1~deb12u1
  Version table:
"""
check(m.parse_apt_policy(POLICY) == ("0.4.9.11-1~deb12u1", "0.4.9.13-1~deb12u1"), "apt policy ayrıştırıldı")
check(m.parse_apt_policy("tor:\n  Installed: (none)\n  Candidate: 1.0\n") == ("", "1.0"), "kurulu değil -> boş")
check(m.parse_apt_policy("") == ("", ""), "boş çıktı")

d = tempfile.mkdtemp(prefix="piupd-")
unit = os.path.join(d, "unit.path")
u = m.TorUpdater(d, unit=unit)
check(not u.supported(), "birim yokken desteklenmiyor")
open(unit, "w").write("x")
check(u.supported(), "birim varken destekleniyor")
check(u.read()["state"] == "idle", "başlangıçta idle")
check(u.request() is True and os.path.exists(u.req), "istek dosyası bırakıldı")
check(u.read()["state"] == "requested", "durum: requested")
check(u.request() is False, "sürerken ikinci istek reddedildi")

# sahte apt-get / dpkg-query / systemctl ile gerçek betik
bin_ = os.path.join(d, "bin"); os.makedirs(bin_)
def fake(name, body):
    p = os.path.join(bin_, name); open(p, "w").write("#!/bin/sh\n" + body + "\n"); os.chmod(p, 0o755)
vf = os.path.join(d, "ver"); open(vf, "w").write("0.4.9.11")
fake("dpkg-query", 'cat "%s"' % vf)
fake("apt-get", 'case "$*" in *install*) echo 0.4.9.13 > "%s";; esac; echo apt-get "$@"' % vf)
fake("systemctl", "exit 0")
env = dict(os.environ, PATH=bin_ + ":" + os.environ["PATH"], TORPOOL_STATE=d)
r = subprocess.run(["bash", os.path.join(HERE, "..", "pi", "update-tor.sh")], env=env, capture_output=True, text=True)
check(r.returncode == 0, "betik başarıyla bitti: %s" % r.stderr[-200:])
check(not os.path.exists(u.req), "istek dosyası betik tarafından silindi")
st = u.read()
check(st["state"] == "done" and "0.4.9.11 -> 0.4.9.13" in st["msg"], "durum done, sürümler yazıldı: %r" % st)
check("--only-upgrade" in open(os.path.join(d, "update.log")).read() and "tor" in open(os.path.join(d, "update.log")).read(), "yalnızca tor yükseltildi")

# başarısız apt -> error
fake("apt-get", 'case "$*" in *install*) exit 100;; esac')
open(u.req, "w").write("1")
r = subprocess.run(["bash", os.path.join(HERE, "..", "pi", "update-tor.sh")], env=env, capture_output=True, text=True)
check(r.returncode == 1 and u.read()["state"] == "error", "apt hatası -> error durumu")

# Manager: bitince boştaki eski oturumlar yenilenir (bir kez), tekrar tetiklenmez
calls = []
class FakeMgr(m.Manager):
    def __init__(s): pass
    def restart_idle(s, min_idle=0, only_stale=False): calls.append(only_stale); return {}
fm = FakeMgr(); fm.updater = u
json.dump({"state": "done", "msg": "ok", "ts": 123}, open(u.st, "w"))
if os.path.exists(u.req): os.remove(u.req)
fm.check_update_done(); fm.check_update_done()
check(calls == [True], "güncelleme bitince yalnızca bir kez 'eski oturumları yenile' çalıştı")
# otomatik güncelleme: açıkken 6 saatte bir istek bırakır, kapalıyken bırakmaz
os.remove(u.st)
cfg = dict(m.DEFAULTS); cfg.update({"pool_size": 0, "state_dir": d, "max_sessions": 5, "tor_bin": "/nonexistent", "token": "t" * 8})
T0 = time.time()
mg = m.Manager(cfg); mg.updater = u
check(mg.auto_update_tick(T0) is False, "kapalıyken otomatik istek yok")
mg.set_auto_tor_update(True)
check(mg.auto_update_tick(T0) is True and os.path.exists(u.req), "açıkken istek bırakıldı")
os.remove(u.req); os.remove(u.st)
check(mg.auto_update_tick(T0 + 3600) is False, "6 saat dolmadan tekrar istemez")
check(mg.auto_update_tick(T0 + 6 * 3600 + 1) is True, "6 saat sonra yeniden ister")
mg2 = m.Manager(cfg)
check(mg2.auto_tor_update is True, "ayar yeniden başlatmada korunur")
mg2.set_pool_size(2); mg3 = m.Manager(cfg)
check(mg3.auto_tor_update is True and mg3.pool_size == 2, "havuz ayarı otomatik güncelleme ayarını silmez")
print("\nTOR GÜNCELLEME TESTLERİ GEÇTİ")
