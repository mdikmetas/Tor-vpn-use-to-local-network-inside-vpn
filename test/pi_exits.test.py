import sys, json, importlib.util
spec = importlib.util.spec_from_file_location("torpool", __import__("os").path.join(__import__("os").path.dirname(__import__("os").path.abspath(__file__)), "..", "pi", "torpool.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
raw = json.dumps({"relays": [{"country": "de"}, {"country": "DE"}, {"country": "nl"}, {}, {"country": "??"}, {"country": "tr"}], "bridges": []}).encode()
assert m.parse_exit_counts(raw) == {"de": 2, "nl": 1, "tr": 1}, m.parse_exit_counts(raw)
calls = []
def ok(u): calls.append(u); return raw
e = m.ExitCounts("x", 3600, ok)
c, ts, st = e.get(); e.get(); assert len(calls) == 1 and c["de"] == 2 and not st
# yenileme hatası: eski veriyi göster
e.ts = 0
def bad(u): raise OSError("ağ yok")
e.fetch = bad
c, ts, st = e.get(); assert st and c["de"] == 2
# hiç veri yokken hata
e2 = m.ExitCounts("x", 3600, bad)
try: e2.get(); raise SystemExit("hata bekleniyordu")
except RuntimeError as x: assert "alınamadı" in str(x)
try: e2.get()
except RuntimeError: pass
print("PI ÇIKIŞ SAYISI TESTLERİ GEÇTİ")
