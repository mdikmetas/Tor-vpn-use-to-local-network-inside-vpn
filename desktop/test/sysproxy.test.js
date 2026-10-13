"use strict";
// Sistem geneli mod testleri: gerçek kayıt defterine / ağ ayarlarına dokunmaz, sahte reg ve networksetup kullanır.
const assert = require("assert");
const http = require("http");
const vm = require("vm");
const { createSysProxy, REG_KEY } = require("../lib/sysproxy");
const { pacScript, startPacServer } = require("../lib/pac");

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + (e && e.stack || e)); process.exitCode = 1; }
}

const memStore = () => { let v = null; return { load: async () => v, save: async (x) => { v = JSON.parse(JSON.stringify(x)); }, clear: async () => { v = null; }, peek: () => v }; };
const ok = { code: 0, stdout: "", stderr: "" };

// ---- sahte Windows kayıt defteri ----
function fakeWindows(initial, failOn) {
  const reg = new Map(Object.entries(initial || {}));
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd].concat(args));
    if (failOn && failOn(cmd, args)) return { code: 1, stdout: "", stderr: "ERROR: erişim engellendi" };
    if (cmd === "reg") {
      assert.strictEqual(args[1], REG_KEY);
      const op = args[0], name = args[3];
      if (op === "query") {
        if (!reg.has(name)) return { code: 1, stdout: "", stderr: "ERROR: değer yok" };
        const [type, data] = reg.get(name);
        return { code: 0, stdout: `\r\n${REG_KEY}\r\n    ${name}    ${type}    ${data}\r\n\r\n`, stderr: "" };
      }
      if (op === "add") { reg.set(name, [args[5], args[7]]); return ok; }
      if (op === "delete") { reg.delete(name); return { code: reg.has(name) ? 1 : 0, stdout: "", stderr: "" }; }
    }
    if (/powershell/i.test(cmd)) return ok;
    throw new Error("beklenmeyen komut: " + cmd);
  };
  return { run, reg, calls };
}

// ---- sahte macOS networksetup ----
function fakeMac(services, failOn) {
  const st = {};
  for (const [name, v] of Object.entries(services)) st[name] = Object.assign({ enabled: false, server: "", port: 0, bypass: [] }, v);
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd].concat(args));
    if (failOn && failOn(args)) return { code: 1, stdout: "", stderr: "** Error: Yönetici yetkisi gerekli." };
    assert.strictEqual(cmd, "networksetup");
    const [op, svc, ...rest] = args;
    if (op === "-listallnetworkservices") return { code: 0, stdout: "An asterisk (*) denotes that a network service is disabled.\n" + Object.keys(st).join("\n") + "\n*Eski Servis\n", stderr: "" };
    const s = st[svc];
    if (op === "-getsocksfirewallproxy") return { code: 0, stdout: `Enabled: ${s.enabled ? "Yes" : "No"}\nServer: ${s.server}\nPort: ${s.port}\nAuthenticated Proxy Enabled: 0\n`, stderr: "" };
    if (op === "-getproxybypassdomains") return { code: 0, stdout: s.bypass.length ? s.bypass.join("\n") + "\n" : `There aren't any bypass domains set on ${svc}.\n`, stderr: "" };
    if (op === "-setsocksfirewallproxy") { s.server = rest[0]; s.port = parseInt(rest[1], 10); return ok; }
    if (op === "-setsocksfirewallproxystate") { s.enabled = rest[0] === "on"; return ok; }
    if (op === "-setproxybypassdomains") { s.bypass = rest[0] === "Empty" ? [] : rest.slice(); return ok; }
    throw new Error("beklenmeyen networksetup: " + op);
  };
  return { run, st, calls };
}

const fakePac = () => { const log = { started: [], closed: 0 }; return { log, start: async (h, p) => { log.started.push([h, p]); return { url: "http://127.0.0.1:5555/proxy.pac", port: 5555, close: async () => { log.closed++; } }; } }; };

(async () => {
  // ---- PAC betiği ----
  const pac = pacScript("192.168.1.50", 9201);
  const ctx = vm.createContext({ isPlainHostName: (h) => !h.includes("."), dnsDomainIs: (h, d) => h.endsWith(d) });
  vm.runInContext(pac, ctx);
  const f = (h) => ctx.FindProxyForURL("http://" + h + "/", h);

  await t("PAC: internet SOCKS5, yerel ağ DIRECT", () => {
    assert.strictEqual(f("example.com"), "SOCKS5 192.168.1.50:9201");
    assert.strictEqual(f("8.8.8.8"), "SOCKS5 192.168.1.50:9201");
    assert.strictEqual(f("172.32.0.1"), "SOCKS5 192.168.1.50:9201");   // 172.16-31 dışı
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.7", "172.16.5.5", "172.31.9.9", "169.254.1.1", "nas", "printer.local", "192.168.1.50"]) {
      assert.strictEqual(f(h), "DIRECT", h);
    }
  });
  await t("PAC: DNS sızıntısı yapan işlevleri kullanmaz", () => {
    assert.ok(!/isInNet|dnsResolve|myIpAddress/.test(pac));
  });
  await t("PAC: geçersiz adres/port reddedilir", () => {
    assert.throws(() => pacScript('x"; evil()//', 9200));
    assert.throws(() => pacScript("pi.local", 0));
  });
  await t("PAC sunucusu /proxy.pac yayınlar", async () => {
    const srv = await startPacServer("pi.lan", 9200);
    const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res({ s: r.statusCode, ct: r.headers["content-type"], b })); }).on("error", rej));
    const r = await get(srv.url);
    assert.strictEqual(r.s, 200);
    assert.ok(r.ct.includes("proxy-autoconfig") && r.b.includes("SOCKS5 pi.lan:9200"));
    assert.strictEqual((await get(srv.url.replace("proxy.pac", "x"))).s, 404);
    await srv.close();
  });

  // ---- Windows ----
  await t("Windows: aç, eski ayarlar yedeklenir, kapatınca birebir geri gelir", async () => {
    const w = fakeWindows({ ProxyEnable: ["REG_DWORD", "0x1"], ProxyServer: ["REG_SZ", "kurumsal:8080"], ProxyOverride: ["REG_SZ", "<local>"] });
    const p = fakePac(), store = memStore();
    const sp = createSysProxy({ platform: "win32", run: w.run, store, startPacServer: p.start });
    await sp.enable("192.168.1.50", 9201);
    assert.ok(sp.active());
    assert.deepStrictEqual(p.log.started, [["192.168.1.50", 9201]]);
    assert.deepStrictEqual(w.reg.get("AutoConfigURL"), ["REG_SZ", "http://127.0.0.1:5555/proxy.pac"]);
    assert.deepStrictEqual(w.reg.get("ProxyEnable"), ["REG_DWORD", "0"]);
    assert.ok(store.peek(), "yedek diskte olmalı");
    assert.ok(w.calls.some((c) => /powershell/i.test(c[0])), "WinINET bildirimi");
    await sp.disable();
    assert.ok(!sp.active());
    assert.ok(!w.reg.has("AutoConfigURL"), "eskiden yoktu, silinmeli");
    assert.deepStrictEqual(w.reg.get("ProxyEnable"), ["REG_DWORD", "0x1"]);
    assert.deepStrictEqual(w.reg.get("ProxyServer"), ["REG_SZ", "kurumsal:8080"]);
    assert.strictEqual(store.peek(), null);
    assert.strictEqual(p.log.closed, 1);
  });
  await t("Windows: başka profile geçince yedek korunur (ilk ayarlar kaybolmaz)", async () => {
    const w = fakeWindows({ AutoConfigURL: ["REG_SZ", "http://wpad/orijinal.pac"] });
    const p = fakePac(), store = memStore();
    const sp = createSysProxy({ platform: "win32", run: w.run, store, startPacServer: p.start });
    await sp.enable("pi.lan", 9200);
    await sp.enable("pi.lan", 9203);
    assert.strictEqual(p.log.started.length, 2);
    await sp.disable();
    assert.deepStrictEqual(w.reg.get("AutoConfigURL"), ["REG_SZ", "http://wpad/orijinal.pac"]);
  });
  await t("Windows: yazma hatasında ayarlar geri alınır ve hata gösterilir", async () => {
    const w = fakeWindows({ ProxyEnable: ["REG_DWORD", "0x1"] }, (cmd, args) => cmd === "reg" && args[0] === "add" && args[3] === "ProxyEnable" && args[7] === "0");
    const p = fakePac(), store = memStore();
    const sp = createSysProxy({ platform: "win32", run: w.run, store, startPacServer: p.start });
    await assert.rejects(() => sp.enable("pi.lan", 9200), /ProxyEnable/);
    assert.ok(!sp.active());
    assert.ok(!w.reg.has("AutoConfigURL"));
    assert.strictEqual(store.peek(), null);
    assert.strictEqual(p.log.closed, 1);
  });
  await t("Windows: çökme sonrası recover() eski ayarı getirir", async () => {
    const w = fakeWindows({ ProxyEnable: ["REG_DWORD", "0x1"], ProxyServer: ["REG_SZ", "kurumsal:8080"] });
    const store = memStore();
    const a = createSysProxy({ platform: "win32", run: w.run, store, startPacServer: fakePac().start });
    await a.enable("pi.lan", 9200);
    // uygulama çöktü: yeni örnek, aynı depo
    const b = createSysProxy({ platform: "win32", run: w.run, store, startPacServer: fakePac().start });
    assert.strictEqual(await b.recover(), true);
    assert.ok(!w.reg.has("AutoConfigURL"));
    assert.deepStrictEqual(w.reg.get("ProxyEnable"), ["REG_DWORD", "0x1"]);
    assert.strictEqual(await b.recover(), false);
  });

  // ---- macOS ----
  await t("macOS: etkin servislere SOCKS proxy yazılır, devre dışı servislere dokunulmaz, geri alınır", async () => {
    const m = fakeMac({ "Wi-Fi": { enabled: true, server: "eski.proxy", port: 1080, bypass: ["*.intranet"] }, Ethernet: {} });
    const store = memStore();
    const sp = createSysProxy({ platform: "darwin", run: m.run, store });
    await sp.enable("192.168.1.50", 9201);
    for (const svc of ["Wi-Fi", "Ethernet"]) {
      assert.deepStrictEqual([m.st[svc].enabled, m.st[svc].server, m.st[svc].port], [true, "192.168.1.50", 9201], svc);
      assert.ok(m.st[svc].bypass.includes("192.168.0.0/16") && m.st[svc].bypass.includes("localhost"));
    }
    assert.ok(!m.calls.some((c) => c.includes("Eski Servis")));
    await sp.disable();
    assert.deepStrictEqual(m.st["Wi-Fi"], { enabled: true, server: "eski.proxy", port: 1080, bypass: ["*.intranet"] });
    // Eskiden proxy tanımı olmayan servis: proxy KAPALI ve istisna listesi boş döner. (networksetup boş adres
    // yazmaya izin vermediği için kapalı proxy'nin adres alanında Pi adresi kalır; işlevi etkilemez.)
    assert.deepStrictEqual([m.st.Ethernet.enabled, m.st.Ethernet.bypass], [false, []]);
    assert.strictEqual(store.peek(), null);
  });
  await t("macOS: yetki hatasında geri alınır, anlaşılır hata verir", async () => {
    const m = fakeMac({ "Wi-Fi": { enabled: false } }, (args) => args[0] === "-setproxybypassdomains" && !args.includes("Empty"));
    const sp = createSysProxy({ platform: "darwin", run: m.run, store: memStore() });
    await assert.rejects(() => sp.enable("pi.lan", 9200), /istisna listesi başarısız/);
    assert.strictEqual(m.st["Wi-Fi"].enabled, false);
    assert.ok(!sp.active());
  });
  await t("Desteklenmeyen sistemde açılmaz", async () => {
    const sp = createSysProxy({ platform: "linux", run: async () => ok, store: memStore() });
    assert.strictEqual(sp.supported, false);
    await assert.rejects(() => sp.enable("pi.lan", 9200), /desteklenmiyor/);
  });
  await t("Geçersiz host/port reddedilir", async () => {
    const sp = createSysProxy({ platform: "darwin", run: async () => ok, store: memStore() });
    await assert.rejects(() => sp.enable("a b;rm", 9200), /Geçersiz/);
    await assert.rejects(() => sp.enable("pi.lan", "9200"), /Geçersiz/);
  });

  console.log(process.exitCode ? "\nBAZI SİSTEM TESTLERİ BAŞARISIZ" : `\nSİSTEM TESTLERİ GEÇTİ (${passed})`);
})();
