"use strict";
// Çalıştır: npm test   (Pi gerekmez)
// İsteğe bağlı entegrasyon testi: TORPOOL_TEST_ADDR="127.0.0.1:8765#TOKEN" npm test
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PiClient, parseAddress, randomId } = require("../lib/pi");
const { Store, ID_RE } = require("../lib/config");
const B = require("../lib/browsers");

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log("ok   " + name);
  } catch (e) {
    console.log("FAIL " + name + "\n     " + (e && e.stack || e));
    process.exitCode = 1;
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "torip-"));

(async () => {
  await t("parseAddress: tam", () => {
    assert.deepStrictEqual(parseAddress("192.168.1.50:8765#abc123"), { host: "192.168.1.50", port: 8765, token: "abc123" });
    assert.deepStrictEqual(parseAddress("http://pi.local:9000/x#t"), { host: "pi.local", port: 9000, token: "t" });
  });
  await t("parseAddress: varsayılan port ve hatalar", () => {
    assert.deepStrictEqual(parseAddress("pi.local"), { host: "pi.local", port: 8765, token: "" });
    assert.strictEqual(parseAddress("bad host!"), null);
    assert.strictEqual(parseAddress("a:99999"), null);
    assert.strictEqual(parseAddress(""), null);
  });
  await t("countryLabel: sayı, az uyarısı, çıkış yok uyarısı", () => {
    const { countryLabel } = require("../lib/pi");
    const c = { de: 350, lv: 3 };
    assert.strictEqual(countryLabel("de", "Almanya", c), "Almanya (350)");
    assert.strictEqual(countryLabel("lv", "Letonya", c), "Letonya (az: 3)");
    assert.strictEqual(countryLabel("md", "Moldova", c), "Moldova (çıkış yok!)");
    assert.strictEqual(countryLabel("auto", "Rastgele (otomatik)", c), "Rastgele (otomatik)");
    assert.strictEqual(countryLabel("de", "Almanya", null), "Almanya");
  });
  await t("kayıtlı iyi çıkışlar: ekle, ping'e göre sırala, tekrarı birleştir, sil, geçersizi reddet", () => {
    const os = require("os"), path = require("path"), fs = require("fs");
    const { Store } = require("../lib/config");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "good-"));
    const st = new Store(path.join(dir, "c.json"));
    const p = st.addProfile("x");
    st.addGoodExit(p.id, { ip: "1.1.1.1", ms: 900 });
    st.addGoodExit(p.id, { ip: "2.2.2.2", ms: 300 });
    st.addGoodExit(p.id, { ip: "3.3.3.3", ms: null });
    st.addGoodExit(p.id, { ip: "1.1.1.1", ms: 500 });   // daha iyi ping birleşir
    st.addGoodExit(p.id, { ip: "2.2.2.2", ms: 800 });   // daha kötü ping eskisini bozmaz
    assert.deepStrictEqual(st.find(p.id).goodExits.map((g) => g.ip + ":" + g.ms), ["2.2.2.2:300", "1.1.1.1:500", "3.3.3.3:null"]);
    assert.throws(() => st.addGoodExit(p.id, { ip: "999.1.1.1" }));
    assert.throws(() => st.addGoodExit(p.id, { ip: "a.b.c.d" }));
    const again = new Store(path.join(dir, "c.json")); // diskten yeniden yüklenince korunur
    assert.strictEqual(again.find(p.id).goodExits.length, 3);
    st.removeGoodExit(p.id, "1.1.1.1");
    assert.strictEqual(st.find(p.id).goodExits.length, 2);
    for (let i = 0; i < 30; i++) st.addGoodExit(p.id, { ip: "9.9.9." + i, ms: 100 + i });
    assert.strictEqual(st.find(p.id).goodExits.length, 20);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await t("randomId Pi'ın beklediği biçimde", () => {
    for (let i = 0; i < 20; i++) assert.ok(ID_RE.test(randomId()));
  });

  await t("detect: Windows", () => {
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local" };
    const have = new Set([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    ]);
    const f = B.detect({ platform: "win32", env, home: "C:\\Users\\m", exists: (p) => have.has(p) });
    assert.deepStrictEqual(f.map((x) => x.id), ["chrome", "firefox"]);
    assert.strictEqual(f[1].kind, "firefox");
  });
  await t("detect: macOS", () => {
    const have = new Set(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Users/m/Applications/Firefox.app/Contents/MacOS/firefox"]);
    const f = B.detect({ platform: "darwin", env: {}, home: "/Users/m", exists: (p) => have.has(p) });
    assert.deepStrictEqual(f.map((x) => x.id), ["chrome", "firefox"]);
  });
  await t("Discord: Windows'ta en yeni sürüm bulunur, auto seçmez, proxy bayrakları verilir", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local" };
    const exe = (v) => "C:\\Users\\m\\AppData\\Local\\Discord\\app-" + v + "\\Discord.exe";
    const have = new Set([exe("1.0.9"), exe("1.0.10")]);
    const f = B.detect({ platform: "win32", env, home: "C:\\Users\\m", exists: (p) => have.has(p), readdir: () => ["app-1.0.9", "app-1.0.10", "Update.exe", "packages"] });
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].kind, "discord");
    assert.strictEqual(f[0].path, exe("1.0.10"));
    assert.strictEqual(B.resolveBrowser(f, "auto"), null);
    assert.strictEqual(B.resolveBrowser(f, "discord").id, "discord");
    const l = B.buildLaunch({ kind: "discord", exe: f[0].path, dataDir: require("os").tmpdir() + "/dc-test", host: "192.168.1.5", port: 9201 });
    assert.ok(l.args.includes("--proxy-server=socks5://192.168.1.5:9201"));
    assert.ok(l.args.some((a) => a.startsWith("--user-data-dir=")));
  });
  await t("detect: macOS Discord", () => {
    const have = new Set(["/Applications/Discord.app/Contents/MacOS/Discord"]);
    const f = B.detect({ platform: "darwin", env: {}, home: "/Users/m", exists: (p) => have.has(p) });
    assert.deepStrictEqual(f.map((x) => x.id), ["discord"]);
  });
  await t("resolveBrowser", () => {
    const found = [{ id: "chrome", name: "Google Chrome", kind: "chromium", path: "/x/chrome" }, { id: "firefox", name: "Mozilla Firefox", kind: "firefox", path: "/x/firefox" }];
    assert.strictEqual(B.resolveBrowser(found, "auto").id, "chrome");
    assert.strictEqual(B.resolveBrowser(found, "firefox").kind, "firefox");
    assert.strictEqual(B.resolveBrowser(found, "yok"), null);
    const c = B.resolveBrowser(found, "custom:/opt/Firefox-Dev/firefox", () => true);
    assert.deepStrictEqual([c.id, c.kind], ["custom", "firefox"]);
    assert.strictEqual(B.resolveBrowser(found, "custom:/yok/yok", () => false), null);
    assert.strictEqual(B.resolveBrowser([], "auto"), null);
  });

  await t("buildLaunch: Chromium bayrakları", () => {
    const d = path.join(tmp(), "p1");
    const s = B.buildLaunch({ kind: "chromium", exe: "/x/chrome", dataDir: d, host: "192.168.1.50", port: 9201 });
    assert.ok(fs.existsSync(d));
    assert.ok(s.args.includes("--user-data-dir=" + d));
    assert.ok(s.args.includes("--proxy-server=socks5://192.168.1.50:9201"));
    assert.ok(s.args.some((a) => a.startsWith("--proxy-bypass-list=") && a.includes("192.168.0.0/16")));
    assert.ok(s.args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
    assert.ok(!s.args.some((a) => a.includes("socks4")));
  });
  await t("buildLaunch: Firefox user.js", () => {
    const d = path.join(tmp(), "ff");
    const s = B.buildLaunch({ kind: "firefox", exe: "/x/firefox", dataDir: d, host: "pi.local", port: 9205 });
    assert.deepStrictEqual(s.args, ["-no-remote", "-profile", d]);
    const js = fs.readFileSync(path.join(d, "user.js"), "utf8");
    for (const line of [
      'user_pref("network.proxy.type", 1);',
      'user_pref("network.proxy.socks", "pi.local");',
      'user_pref("network.proxy.socks_port", 9205);',
      'user_pref("network.proxy.socks_version", 5);',
      'user_pref("network.proxy.socks_remote_dns", true);',
      'user_pref("network.proxy.failover_direct", false);',
      'user_pref("media.peerconnection.enabled", false);',
    ]) assert.ok(js.includes(line), "eksik: " + line);
  });
  if (process.platform !== "win32") {
    await t("launch: tarayıcıyı gerçekten başlatır", async () => {
      const dir = tmp();
      const out = path.join(dir, "argv.txt");
      const exe = path.join(dir, "fake-browser");
      fs.writeFileSync(exe, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`, { mode: 0o755 });
      const spec = B.buildLaunch({ kind: "chromium", exe, dataDir: path.join(dir, "d"), host: "10.0.0.2", port: 9200 });
      const pid = await B.launch(spec.exe, spec.args);
      assert.ok(pid > 0);
      for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(fs.readFileSync(out, "utf8").includes("--proxy-server=socks5://10.0.0.2:9200"));
      await assert.rejects(() => B.launch(path.join(dir, "yok"), []));
    });
  }

  await t("Store: kaydet, yükle, doğrula", () => {
    const f = path.join(tmp(), "config.json");
    const s = new Store(f);
    assert.deepStrictEqual(s.data.profiles, []);
    s.setPi({ host: "pi.local", port: 8765, token: "tok" });
    const p = s.addProfile("Hesap A");
    s.updateProfile(p.id, { country: "de", browser: "firefox", name: "Hesap B" });
    assert.throws(() => s.updateProfile(p.id, { country: "x;y" }));
    const s2 = new Store(f);
    assert.strictEqual(s2.data.pi.host, "pi.local");
    assert.deepStrictEqual([s2.data.profiles[0].name, s2.data.profiles[0].country, s2.data.profiles[0].browser], ["Hesap B", "de", "firefox"]);
    assert.ok(s2.removeProfile(p.id));
    assert.strictEqual(s2.removeProfile(p.id), false);
    fs.writeFileSync(f, "{bozuk");
    assert.deepStrictEqual(new Store(f).data.profiles, []);
    fs.writeFileSync(f, JSON.stringify({ profiles: [{ id: "../../etc", name: "x" }, { id: "aaaaaaaabbbbbbbb", country: "zz9" }] }));
    const s3 = new Store(f);
    assert.strictEqual(s3.data.profiles.length, 1);
    assert.strictEqual(s3.data.profiles[0].country, "auto");
  });

  await t("PiClient: ulaşılamayan Pi anlaşılır hata verir", async () => {
    const c = new PiClient({ host: "127.0.0.1", port: 1, token: "x" });
    await assert.rejects(() => c.sessions(), /Pi'a bağlanılamadı/);
    await assert.rejects(() => new PiClient({}).sessions(), /girilmemiş/);
  });

  if (process.env.TORPOOL_TEST_ADDR) {
    const a = parseAddress(process.env.TORPOOL_TEST_ADDR);
    const c = new PiClient(a);
    const id = randomId();
    await t("entegrasyon: oturum aç, hazır ol, ülke, IP değiştir, sil", async () => {
      assert.strictEqual(await c.status(id), null);
      let st = await c.ensure(id, "de");
      assert.strictEqual(st.country, "de");
      for (let i = 0; i < 40 && !st.ready; i++) { await new Promise((r) => setTimeout(r, 500)); st = await c.status(id); }
      assert.ok(st.ready, "oturum hazır olmadı");
      assert.ok(st.port > 0);
      st = await c.setCountry(id, "nl");
      assert.strictEqual(st.country, "nl");
      assert.ok((await c.newnym(id)).ok);
      assert.ok((await c.sessions()).sessions.some((s) => s.id === id));
      await c.remove(id);
      assert.strictEqual(await c.status(id), null);
    });
    await t("entegrasyon: yanlış token", async () => {
      await assert.rejects(() => new PiClient({ host: a.host, port: a.port, token: "yanlis-token-1" }).sessions(), /Token hatalı/);
    });
  }

  console.log(process.exitCode ? "\nBAZI TESTLER BAŞARISIZ" : `\nTÜM TESTLER GEÇTİ (${passed})`);
})();
