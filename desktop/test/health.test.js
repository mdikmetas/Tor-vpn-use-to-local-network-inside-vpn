"use strict";
const assert = require("assert");
const { nextHealth, createMonitor } = require("../lib/health");
let n = 0;
async function t(name, fn) { try { await fn(); n++; console.log("ok   " + name); } catch (e) { console.error("FAIL " + name + "\n" + (e.stack || e)); process.exit(1); } }

(async () => {
  await t("tek kötü ölçüm alarm vermez, 2. verir, tekrar etmez, düzelince haber verir", () => {
    let r = nextHealth(null, { state: "ok", ip: "1.1.1.1" }, 1);
    assert.strictEqual(r.notify, null);
    r = nextHealth(r.health, { state: "down", msg: "x" }, 2); assert.strictEqual(r.notify, null);
    r = nextHealth(r.health, { state: "down", msg: "x" }, 3); assert.strictEqual(r.notify.kind, "down");
    r = nextHealth(r.health, { state: "down", msg: "x" }, 4); assert.strictEqual(r.notify, null);
    r = nextHealth(r.health, { state: "ok", ip: "2.2.2.2" }, 5); assert.strictEqual(r.notify.kind, "recovered");
  });

  await t("izleyici: her profili ölçer, bildirimi bir kez gönderir, null ölçümü saymaz", async () => {
    const seq = { a: [{ state: "ok", ip: "1.1.1.1" }, { state: "down", msg: "k" }, { state: "down", msg: "k" }, { state: "down", msg: "k" }, { state: "ok", ip: "3.3.3.3" }], b: [null, null] };
    const notes = [];
    const m = createMonitor({
      intervalMs: 10, getIds: () => ["a", "b"],
      probe: async (id) => (seq[id].length ? seq[id].shift() : { state: "ok", ip: "9.9.9.9" }),
      onResult: (id, h, nf) => { if (nf) notes.push(id + ":" + nf.kind); },
    });
    for (let i = 0; i < 5; i++) await m.tick();
    assert.deepStrictEqual(notes, ["a:down", "a:recovered"]);
    assert.strictEqual(m.get("a").state, "ok");
    assert.strictEqual(m.get("b").state, "ok"); // null ölçümler sayılmadı
  });

  await t("izleyici: probe hata fırlatırsa 'down' sayılır, turlar çakışmaz", async () => {
    let calls = 0, active = 0, maxActive = 0;
    const m = createMonitor({
      getIds: () => ["a"],
      probe: async () => { calls++; active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; throw new Error("boom"); },
    });
    await Promise.all([m.tick(), m.tick(), m.tick()]);
    assert.strictEqual(calls, 1); assert.strictEqual(maxActive, 1);
    await m.tick();
    assert.strictEqual(m.get("a").state, "down");
  });

  await t("izleyici: start/stop zamanlayıcıyı çalıştırır ve durdurur", async () => {
    let calls = 0;
    const m = createMonitor({ intervalMs: 15, getIds: () => ["a"], probe: async () => { calls++; return { state: "ok", ip: "1.1.1.1" }; } });
    m.start();
    await new Promise((r) => setTimeout(r, 80));
    m.stop();
    const c = calls;
    assert.ok(c >= 2, "çalışmadı: " + c);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(calls, c);
  });
  console.log("\nSAĞLIK TESTLERİ GEÇTİ (" + n + ")");
})();
