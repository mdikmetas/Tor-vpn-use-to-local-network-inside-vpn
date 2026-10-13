"use strict";
const assert = require("assert");
const vm = require("vm");
const S = require("../lib/sites");
const { pacScript } = require("../lib/pac");
const B = require("../lib/browsers");
const { createSysProxy } = require("../lib/sysproxy");
let n = 0;
async function t(name, fn) { try { await fn(); n++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + (e.stack || e)); process.exit(1); } }

// PAC betiğini gerçek bir PAC ortamının işlevleriyle çalıştır
function runPac(script, host) {
  const ctx = {
    isPlainHostName: (h) => !h.includes("."),
    dnsDomainIs: (h, d) => h.endsWith(d),
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return vm.runInContext(`FindProxyForURL("https://${host}/", "${host}")`, ctx);
}

(async () => {
  await t("normalizeDomains + matchesDirect", () => {
    assert.deepStrictEqual(S.normalizeDomains("https://www.X.com.tr/a\n*.gov.tr, gov.tr, çök_ük"), ["x.com.tr", "gov.tr"]);
    assert.ok(S.matchesDirect("a.b.gov.tr", ["gov.tr"]));
    assert.ok(!S.matchesDirect("notgov.tr", ["gov.tr"]));
  });
  await t("PAC: doğrudan siteler DIRECT, diğerleri SOCKS5, yerel ağ DIRECT", () => {
    const pac = pacScript("192.168.1.5", 9201, ["gov.tr", "akbank.com"]);
    assert.strictEqual(runPac(pac, "turkiye.gov.tr"), "DIRECT");
    assert.strictEqual(runPac(pac, "gov.tr"), "DIRECT");
    assert.strictEqual(runPac(pac, "www.akbank.com"), "DIRECT");
    assert.strictEqual(runPac(pac, "evilgov.tr"), "SOCKS5 192.168.1.5:9201");
    assert.strictEqual(runPac(pac, "example.com"), "SOCKS5 192.168.1.5:9201");
    assert.strictEqual(runPac(pac, "192.168.1.9"), "DIRECT");
    assert.ok(!/isInNet|dnsResolve/.test(pac));
  });
  await t("PAC: geçersiz girdi betiğe sızamaz", () => {
    const pac = pacScript("192.168.1.5", 9201, ['x.com"); evil();//', "ok.com"]);
    assert.ok(!pac.includes("evil"));
    assert.strictEqual(runPac(pac, "ok.com"), "DIRECT");
  });
  await t("tarayıcı bayrakları: Chromium ve Firefox", () => {
    const os = require("os"), path = require("path"), fs = require("fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sites-"));
    const c = B.buildLaunch({ kind: "chromium", exe: "x", dataDir: path.join(dir, "c"), host: "192.168.1.5", port: 9201, direct: ["gov.tr"] });
    const bl = c.args.find((a) => a.startsWith("--proxy-bypass-list="));
    assert.ok(bl.includes("gov.tr;*.gov.tr"), bl);
    B.buildLaunch({ kind: "firefox", exe: "x", dataDir: path.join(dir, "f"), host: "192.168.1.5", port: 9201, direct: ["gov.tr"] });
    const uj = fs.readFileSync(path.join(dir, "f", "user.js"), "utf8");
    assert.ok(/no_proxies_on.*gov\.tr, \.gov\.tr/.test(uj), uj);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await t("Windows: PAC canlı güncellenir", async () => {
    let updated = null;
    const store = { v: null, load: () => store.v, save: (o) => { store.v = o; }, clear: () => { store.v = null; } };
    const sp = createSysProxy({ platform: "win32", run: async () => ({ code: 0, stdout: "", stderr: "" }), store, startPacServer: async () => ({ url: "http://127.0.0.1:1/proxy.pac", close: async () => {}, update: (d) => { updated = d; } }) });
    await sp.enable("192.168.1.5", 9201, ["gov.tr"]);
    await sp.setDirect(["gov.tr", "x.com"]);
    assert.deepStrictEqual(updated, ["gov.tr", "x.com"]);
  });
  await t("macOS: istisna listesine doğrudan siteler yazılır", async () => {
    const calls = [];
    const store = { v: null, load: () => store.v, save: (o) => { store.v = o; }, clear: () => { store.v = null; } };
    const run = async (cmd, args) => {
      calls.push([cmd].concat(args).join(" "));
      if (args[0] === "-listallnetworkservices") return { code: 0, stdout: "An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const sp = createSysProxy({ platform: "darwin", run, store });
    await sp.enable("192.168.1.5", 9201, ["gov.tr"]);
    assert.ok(calls.some((c) => c.startsWith("networksetup -setproxybypassdomains Wi-Fi") && c.includes("*.gov.tr") && c.includes(" gov.tr")), calls.join("\n"));
    calls.length = 0;
    await sp.setDirect(["akbank.com"]);
    assert.ok(calls.some((c) => c.includes("-setproxybypassdomains Wi-Fi") && c.includes("*.akbank.com")), calls.join("\n"));
  });
  console.log("\nSİTE KURALI TESTLERİ GEÇTİ (" + n + ")");
})();
