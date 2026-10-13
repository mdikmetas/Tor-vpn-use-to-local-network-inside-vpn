"use strict";
// Eklenti sağlık mantığı (src/lib.js -> nextHealth) testi
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ctx = { chrome: { storage: { local: {} }, action: {}, runtime: {} }, crypto: require("crypto").webcrypto, console, setTimeout, URL };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "lib.js"), "utf8") + "\nglobalThis.nextHealth = nextHealth; globalThis.normalizeDomains = normalizeDomains; globalThis.matchesDirect = matchesDirect; globalThis.DEFAULT_DIRECT = DEFAULT_DIRECT; globalThis.buildPac = buildPac; globalThis.ONLY_DEFAULT = ONLY_DEFAULT;", ctx);
const nh = ctx.nextHealth;
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exit(1); } };

t("ilk iyi ölçüm: alarm yok", () => {
  const r = nh(null, { state: "ok", ip: "1.1.1.1" }, 1);
  assert.strictEqual(r.health.state, "ok"); assert.strictEqual(r.notify, null);
});
t("tek kötü ölçüm alarm vermez", () => {
  const r = nh({ state: "ok", fails: 0 }, { state: "down", msg: "x" }, 2);
  assert.strictEqual(r.health.state, "ok"); assert.strictEqual(r.health.fails, 1); assert.strictEqual(r.notify, null);
});
t("art arda 2 kötü ölçüm: bir kez 'koptu' bildirimi", () => {
  let r = nh({ state: "ok", fails: 0 }, { state: "down", msg: "x" }, 2);
  r = nh(r.health, { state: "down", msg: "x" }, 3);
  assert.strictEqual(r.health.state, "down"); assert.strictEqual(r.notify.kind, "down");
  const r3 = nh(r.health, { state: "down", msg: "x" }, 4);
  assert.strictEqual(r3.notify, null); // tekrar bildirmez
});
t("arada iyi ölçüm sayacı sıfırlar", () => {
  let r = nh({ state: "ok", fails: 0 }, { state: "down" }, 2);
  r = nh(r.health, { state: "ok", ip: "2.2.2.2" }, 3);
  r = nh(r.health, { state: "down" }, 4);
  assert.strictEqual(r.health.state, "ok");
});
t("sızıntı bildirimi IP'yi içerir", () => {
  let r = nh({ state: "ok", fails: 0 }, { state: "leak", ip: "9.9.9.9" }, 2);
  r = nh(r.health, { state: "leak", ip: "9.9.9.9" }, 3);
  assert.strictEqual(r.notify.kind, "leak"); assert.ok(r.notify.message.includes("9.9.9.9"));
});
t("kopuktan toparlanınca 'geri geldi' bildirimi", () => {
  const r = nh({ state: "down", fails: 3 }, { state: "ok", ip: "3.3.3.3" }, 5);
  assert.strictEqual(r.health.state, "ok"); assert.strictEqual(r.notify.kind, "recovered");
});
t("kopukken sızıntıya dönerse yeniden bildirir", () => {
  const r = nh({ state: "down", fails: 3 }, { state: "leak", ip: "4.4.4.4" }, 5);
  assert.strictEqual(r.notify.kind, "leak");
});
t("site kuralı: alan adı temizleme", () => {
  const r = ctx.normalizeDomains("https://www.Garantibbva.com.tr/yol?x=1\n*.gov.tr, .akbank.com:443  gecersiz_ad  localhost 1.2.3.4 gov.tr");
  assert.deepStrictEqual(Array.from(r), ["garantibbva.com.tr", "gov.tr", "akbank.com"]);
});
t("site kuralı: alt alan adı eşleşir, benzer ad eşleşmez", () => {
  const l = ["gov.tr", "akbank.com"];
  assert.ok(ctx.matchesDirect("turkiye.gov.tr", l));
  assert.ok(ctx.matchesDirect("gov.tr", l));
  assert.ok(ctx.matchesDirect("WWW.AKBANK.COM.", l));
  assert.ok(!ctx.matchesDirect("evilgov.tr", l));
  assert.ok(!ctx.matchesDirect("akbank.com.evil.org", l));
  assert.ok(!ctx.matchesDirect("", l));
});
t("varsayılan liste geçerli ve tekrarsız", () => {
  const d = Array.from(ctx.DEFAULT_DIRECT);
  assert.deepStrictEqual(Array.from(ctx.normalizeDomains(d)), d);
});
t("PAC: listedeki site ve alt alan SOCKS5, gerisi DIRECT, yedek yok", () => {
  const pac = ctx.buildPac("100.1.2.3", 9205, ["example.com", "https://www.Foo.org/x"]);
  const f = new Function("dnsDomainIs", pac + "; return FindProxyForURL;")((h, d) => h.endsWith(d));
  assert.strictEqual(f("https://example.com/", "example.com"), "SOCKS5 100.1.2.3:9205");
  assert.strictEqual(f("https://a.b.example.com/", "a.b.example.com"), "SOCKS5 100.1.2.3:9205");
  assert.strictEqual(f("https://foo.org/", "FOO.org"), "SOCKS5 100.1.2.3:9205");
  assert.strictEqual(f("https://notexample.com/", "notexample.com"), "DIRECT");
  assert.strictEqual(f("https://google.com/", "google.com"), "DIRECT");
});

t("sadece-liste hazır siteleri geçerli", () => {
  const l = Array.from(ctx.ONLY_DEFAULT);
  assert.deepStrictEqual(Array.from(ctx.normalizeDomains(l)), l);
});

console.log("\nEKLENTİ TESTLERİ GEÇTİ (" + n + ")");
