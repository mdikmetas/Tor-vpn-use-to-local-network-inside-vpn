"use strict";
const assert = require("assert");
const { isTailscaleAddr, ensureUp } = require("../lib/tailscale");
let n = 0;
async function t(name, fn) { try { await fn(); n++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + (e.stack || e)); process.exit(1); } }

const mk = (states) => {
  const calls = [];
  let i = 0;
  const run = async (cmd, args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") { const b = states[Math.min(i++, states.length - 1)]; return { code: 0, stdout: JSON.stringify({ BackendState: b }), stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
};
const base = { platform: "linux", exists: () => true, sleep: async () => {} };

(async () => {
  await t("adres tanıma", () => {
    for (const h of ["100.118.31.82", "100.64.0.1", "100.127.255.254", "node.tail1234.ts.net"]) assert.ok(isTailscaleAddr(h), h);
    for (const h of ["192.168.1.5", "100.63.0.1", "100.128.0.1", "10.0.0.2", "example.com", ""]) assert.ok(!isTailscaleAddr(h), h);
  });
  await t("zaten açıksa dokunmaz", async () => {
    const m = mk(["Running"]);
    const r = await ensureUp(Object.assign({ run: m.run }, base));
    assert.strictEqual(r.state, "up");
    assert.ok(!m.calls.includes("up"));
  });
  await t("kapalıysa 'up' çalıştırır ve bekler", async () => {
    const m = mk(["Stopped", "Starting", "Running"]);
    const r = await ensureUp(Object.assign({ run: m.run }, base));
    assert.strictEqual(r.state, "started");
    assert.ok(m.calls.includes("up"));
  });
  await t("oturum yoksa açıklayıcı mesaj, 'up' denenmez", async () => {
    const m = mk(["NeedsLogin"]);
    const r = await ensureUp(Object.assign({ run: m.run }, base));
    assert.strictEqual(r.state, "login");
    assert.ok(!m.calls.includes("up"));
  });
  await t("kurulu değilse (Windows) 'missing'", async () => {
    const r = await ensureUp({ platform: "win32", env: {}, exists: () => false, run: async () => ({ code: 1, stdout: "", stderr: "" }), sleep: async () => {} });
    assert.strictEqual(r.state, "missing");
  });
  await t("açılamazsa 'failed' ve elle bağlan önerisi", async () => {
    const m = mk(["Stopped"]);
    const r = await ensureUp(Object.assign({ run: m.run }, base));
    assert.strictEqual(r.state, "failed");
    assert.ok(/elle/.test(r.message));
  });
  console.log("\nTAILSCALE TESTLERİ GEÇTİ (" + n + ")");
})();
