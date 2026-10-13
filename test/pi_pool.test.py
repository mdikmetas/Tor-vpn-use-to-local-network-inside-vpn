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
try:
    # havuz 2: kendiliğinden 2 boşta oturum açılır
    check(mgr.set_pool_size(2) == 2, "havuz boyutu 2 kaydedildi")
    check(wait(lambda: len(mgr.spares()) == 2 and all(i.status()["ready"] for i in mgr.spares()), 60), "2 hazır havuz oturumu açıldı")
    old_sids = {i.sid for i in mgr.spares()}
    old_ports = {i.sid: i.socks for i in mgr.spares()}
    check(os.path.exists(os.path.join(d, "settings.json")), "ayar dosyaya yazıldı")

    # eklenti bağlanır: hazır havuz oturumunu devralır (yeni Tor açılmaz)
    cid = "c3c3c3c3c3c3c3c3"
    inst = mgr.create(cid, "auto")
    check(inst.sid == cid and not inst.spare, "istemci oturumu devraldı")
    check(inst.socks in old_ports.values(), "yeni Tor açılmadı, hazır olan port verildi")
    check(inst.status()["ready"], "devralınan oturum hazır")
    check(cid in mgr.inst and len(mgr.inst) == 3, "toplam 3 oturum (1 istemci + 2 havuz)")
    # havuz kendini tamamlar
    check(wait(lambda: len(mgr.spares()) == 2, 60), "havuz yeniden 2'ye tamamlandı")

    # aynı id tekrar gelirse yeni havuz oturumu tüketmez
    n0 = len(mgr.inst)
    again = mgr.create(cid, "auto")
    check(again is inst and len(mgr.inst) == n0, "aynı id havuzu tüketmedi")

    # havuz kapatılır: boştakiler silinir, istemci kalır
    mgr.set_pool_size(0)
    check(wait(lambda: len(mgr.spares()) == 0, 30), "havuz 0 -> boşta oturumlar silindi")
    check(cid in mgr.inst, "istemci oturumu duruyor")

    # spare bayrağı yeniden başlatmada korunur
    mgr.set_pool_size(1)
    check(wait(lambda: len(mgr.spares()) == 1, 30), "1 havuz oturumu")
    mgr.save_state()
    mgr2 = m.Manager(cfg)
    check(mgr2.pool_size == 1, "havuz boyutu yeniden başlatmada okundu")
    import json as _j
    data = _j.load(open(os.path.join(d, "state.json")))
    check(sum(1 for v in data.values() if v.get("spare")) == 1, "spare bayrağı state.json'a yazıldı")
    # boşta oturumları toplu sil: havuzdakilere ve yeni etkin olanlara dokunmaz
    mgr.set_pool_size(1)
    check(wait(lambda: len(mgr.spares()) == 1, 30), "havuz 1")
    old = mgr.create("d4d4d4d4d4d4d4d4", "auto"); fresh = mgr.create("e5e5e5e5e5e5e5e5", "auto")
    old.last_active = time.time() - 7200
    n = mgr.purge_idle(3600)
    check(n == 1 and "d4d4d4d4d4d4d4d4" not in mgr.inst, "2 saat boşta olan silindi")
    check("e5e5e5e5e5e5e5e5" in mgr.inst and wait(lambda: len(mgr.spares()) == 1, 30), "etkin oturum yerinde, havuz tamamlandı")
    # idle_hours panelden değişir, kalıcı olur, reaper yeni süreyi kullanır
    check(mgr.idle_hours == 72.0, "varsayılan 72 saat")
    mgr.set_idle_hours(0.0001)
    check(mgr.idle_hours == 1.0, "en az 1 saat")
    mgr.set_idle_hours(12)
    check(m.Manager(cfg).idle_hours == 12.0, "idle_hours yeniden başlatmada korunur")
    stale = mgr.create("f6f6f6f6f6f6f6f6", "auto"); stale.last_active = time.time() - 13 * 3600
    mgr.reap_once(10)
    check("f6f6f6f6f6f6f6f6" not in mgr.inst, "13 saat boşta kalan, 12 saatlik sınırla silindi")
    # ayar dosyası ve config anahtarı yoksa havuz varsayılan olarak 2
    c2 = {k: v for k, v in cfg.items() if k != "pool_size"}
    c2["state_dir"] = tempfile.mkdtemp(prefix="pidef-")
    check(m.Manager(c2).pool_size == 2, "varsayılan havuz boyutu 2")
    # Pi yeniden başlayınca: boşta süresi korunur, eski oturumlar kendiliğinden başlamaz, sahibi gelince başlar
    mgr.set_pool_size(0)
    check(wait(lambda: len(mgr.spares()) == 0, 30), "havuz kapalı")
    oldx = mgr.create("a7a7a7a7a7a7a7a7", "de"); oldx.last_active = time.time() - 3 * 3600
    recent = mgr.create("b8b8b8b8b8b8b8b8", "auto")
    mgr.save_state(); mgr.stop_all()
    mgr3 = m.Manager(cfg); mgr3.load_and_start()
    check(wait(lambda: mgr3.inst["b8b8b8b8b8b8b8b8"].running(), 20), "yakın zamanda kullanılan oturum açılışta başladı")
    check(not mgr3.inst["a7a7a7a7a7a7a7a7"].running(), "3 saattir boşta olan oturum açılışta BAŞLAMADI")
    check(mgr3.inst["a7a7a7a7a7a7a7a7"].last_active < time.time() - 3 * 3600 + 5, "boşta süresi yeniden başlatmada sıfırlanmadı")
    mgr3.reap_once(1)
    check(not mgr3.inst["a7a7a7a7a7a7a7a7"].running(), "reaper eski oturumu başlatmadı")
    # bağlanamayanları sil: hazır olmayan + boşta olan silinir, hazır olan kalır
    ghost = mgr3.inst["a7a7a7a7a7a7a7a7"]
    check(wait(lambda: mgr3.inst["b8b8b8b8b8b8b8b8"].status()["ready"], 90), "yakın oturum hazır")
    mgr3.inst["b8b8b8b8b8b8b8b8"].last_active = time.time() - 600
    n2 = mgr3.purge_idle(300, not_ready_only=True)
    check(n2 == 1 and "a7a7a7a7a7a7a7a7" not in mgr3.inst and "b8b8b8b8b8b8b8b8" in mgr3.inst, "yalnızca hazır olmayan silindi")
    mgr3.stop_all()
    # eski sürümden kalan state.json (last_active yok): açılışta başlamaz, hemen "bağlanamayanları sil" ile silinebilir
    import json as _j2
    legacy = {"c9c9c9c9c9c9c9c9": {"n": 5, "country": "de"}}
    _j2.dump(legacy, open(os.path.join(d, "state.json"), "w"))
    mgr4 = m.Manager(cfg); mgr4.load_and_start()
    time.sleep(1)
    check(not mgr4.inst["c9c9c9c9c9c9c9c9"].running(), "eski kayıt (last_active yok) açılışta başlamadı")
    check(mgr4.purge_idle(300, not_ready_only=True) == 1 and not mgr4.inst, "eski kayıt hemen 'bağlanamayanları sil' ile silindi")
    print("\nHAVUZ TESTLERI GECTI")
finally:
    mgr.pool_size = 0
    mgr.stop_all()
