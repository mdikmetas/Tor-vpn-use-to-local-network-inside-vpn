"use strict";
const assert = require("assert");
const { createKillSwitch, blockRanges, ALWAYS_ALLOWED } = require("../lib/killswitch");
let n = 0;
async function t(name, fn) { try { await fn(); n++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + (e.stack || e)); process.exit(1); } }
const toNum = (ip) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const mkStore = () => { const s = { v: null, load: () => s.v, save: (o) => { s.v = o; }, clear: () => { s.v = null; } }; return s; };

(async () => {
  await t("tümleyen aralıklar: izinliler dışında her IPv4 engelli, çakışma ve boşluk yok", () => {
    const allowed = ALWAYS_ALLOWED.concat(["203.0.113.9/32"]);
    const ranges = blockRanges(allowed).map((r) => r.split("-").map(toNum));
    const inRanges = (rs, x) => rs.some(([s, e]) => x >= s && x <= e);
    const allowedNums = allowed.map((c) => { const [ip, b] = c.split("/"); const sz = Math.pow(2, 32 - Number(b)); const s = Math.floor(toNum(ip) / sz) * sz; return [s, s + sz - 1]; });
    const samples = ["8.8.8.8", "1.1.1.1", "100.64.0.1", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "203.0.113.8", "203.0.113.10", "223.255.255.255", "126.255.255.255", "128.0.0.0", "9.255.255.255", "11.0.0.0",
      "10.1.2.3", "127.0.0.1", "192.168.1.5", "172.16.0.9", "169.254.1.1", "224.0.0.251", "255.255.255.255", "203.0.113.9", "0.0.0.0"];
    for (const ip of samples) {
      const x = toNum(ip);
      assert.strictEqual(inRanges(ranges, x), !inRanges(allowedNums, x), ip + " yanlış sınıflandı");
    }
    for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][1] + 1 || ranges[i][0] > ranges[i - 1][1], "aralıklar çakışıyor");
  });
  await t("Windows: tek yükseltilmiş komutta iki kural eklenir, kural adları sabit", async () => {
    const calls = [];
    const ks = createKillSwitch({ platform: "win32", store: mkStore(), run: async (c, a) => { calls.push([c].concat(a).join(" ")); return { code: 0, stdout: "", stderr: "" }; } });
    await ks.enable("192.168.1.5");
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("-Verb RunAs") && calls[0].includes("TorIP-KS-v4") && calls[0].includes("TorIP-KS-v6") && calls[0].includes("2000::/3"));
    assert.ok(/remoteip=0\.0\.0\.0-/.test(calls[0]) === false, "0/8 serbest olmalı, engel aralığı 1.0.0.0'dan başlamalı");
    assert.ok(calls[0].includes("remoteip=1.0.0.0-9.255.255.255"), calls[0]);
    assert.ok(ks.active());
  });
  await t("Windows: UAC reddedilirse hata verir, açık sayılmaz, yedek temizlenir", async () => {
    const st = mkStore();
    const ks = createKillSwitch({ platform: "win32", store: st, run: async (c, a) => (a.join(" ").includes("delete rule") ? { code: 0, stdout: "", stderr: "" } : { code: 1223, stdout: "", stderr: "" }) });
    await assert.rejects(() => ks.enable("192.168.1.5"), /Yönetici izni/);
    assert.ok(!ks.active());
    assert.strictEqual(st.v, null);
  });
  await t("Windows: kapatınca kurallar silinir; çökme sonrası recover() kaldırır", async () => {
    const calls = [];
    const st = mkStore();
    const run = async (c, a) => { calls.push(a.join(" ")); return { code: 0, stdout: "", stderr: "" }; };
    const ks = createKillSwitch({ platform: "win32", store: st, run });
    await ks.enable("192.168.1.5");
    assert.ok(st.v && st.v.pending === false);
    await ks.disable();
    assert.ok(calls.some((c) => c.includes("delete rule name=TorIP-KS-v4") && c.includes("delete rule name=TorIP-KS-v6")));
    assert.strictEqual(st.v, null);
    // çökme: yedek kaldı, yeni örnek açılırken temizler
    st.v = { platform: "win32", pending: false };
    calls.length = 0;
    const ks2 = createKillSwitch({ platform: "win32", store: st, run });
    assert.strictEqual(await ks2.recover(), true);
    assert.ok(calls.some((c) => c.includes("delete rule")));
    assert.strictEqual(await ks2.recover(), false);
  });
  await t("macOS: pf kuralları stdin'den yüklenir, token saklanır, kapatınca anchor boşaltılır ve token bırakılır", async () => {
    const calls = [];
    const st = mkStore();
    const run = async (c, a) => {
      calls.push([c].concat(a).join(" "));
      if (a.join(" ").includes("-f -")) return { code: 0, stdout: "pf enabled\nToken : 4242\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const ks = createKillSwitch({ platform: "darwin", store: st, run });
    await ks.enable("192.168.1.5");
    assert.ok(calls[0].startsWith("osascript -e do shell script"));
    assert.ok(calls[0].includes("com.apple/torip") && calls[0].includes("192.168.1.5/32") && calls[0].includes("block drop out quick inet all"));
    assert.strictEqual(st.v.token, "4242");
    await ks.disable();
    const last = calls[calls.length - 1];
    assert.ok(last.includes("pfctl -a com.apple/torip -F all") && last.includes("pfctl -X 4242"), last);
    assert.strictEqual(st.v, null);
  });
  await t("Pi IPv4 değilse reddeder; desteklenmeyen sistemde açılmaz", async () => {
    const ks = createKillSwitch({ platform: "win32", store: mkStore(), run: async () => ({ code: 0, stdout: "", stderr: "" }) });
    await assert.rejects(() => ks.enable("node.local"), /IPv4/);
    const lx = createKillSwitch({ platform: "linux", store: mkStore() });
    assert.strictEqual(lx.supported, false);
    await assert.rejects(() => lx.enable("192.168.1.5"), /desteklenmiyor/);
  });
  console.log("\nKILL SWITCH TESTLERİ GEÇTİ (" + n + ")");
})();
