"use strict";
const assert = require("assert");
const { findFast } = require("../lib/fastip");

async function t(name, fn) { try { await fn(); console.log("ok   " + name); } catch (e) { console.log("FAIL " + name + "\n  " + e.stack); process.exitCode = 1; } }

function sim(seq) {
  const log = { pins: [], newnyms: 0 };
  let i = -1, pinnedIp = null;
  const o = {
    cancelled: () => false,
    newnym: async () => { log.newnyms++; },
    pin: async (ip) => { log.pins.push(ip); pinnedIp = ip || null; },
    measure: async () => {
      if (pinnedIp) { const f = seq.find((x) => x.ip === pinnedIp); return f ? { ip: f.ip, ms: f.ms } : null; }
      i++; return seq[Math.min(i, seq.length - 1)];
    },
  };
  return { o, log };
}

(async () => {
  await t("hedefin altına inince durur", async () => {
    const { o, log } = sim([{ ip: "1.1.1.1", ms: 900 }, { ip: "2.2.2.2", ms: 300 }, { ip: "3.3.3.3", ms: 100 }]);
    const r = await findFast(Object.assign(o, { attempts: 8, targetMs: 500 }));
    assert.strictEqual(r.reached, true);
    assert.strictEqual(r.best.ip, "2.2.2.2");
    assert.strictEqual(log.newnyms, 1);
    assert.deepStrictEqual(log.pins, []);
  });
  await t("hedefe ulaşılamazsa en iyiye dönüp sabitler", async () => {
    const { o, log } = sim([{ ip: "1.1.1.1", ms: 900 }, { ip: "2.2.2.2", ms: 600 }, { ip: "3.3.3.3", ms: 1200 }]);
    const r = await findFast(Object.assign(o, { attempts: 3, targetMs: 200 }));
    assert.strictEqual(r.reached, false);
    assert.strictEqual(r.pinned, true);
    assert.strictEqual(r.best.ip, "2.2.2.2");
    assert.deepStrictEqual(log.pins, ["2.2.2.2"]);
  });
  await t("son deneme zaten en iyiyse sabitleme yapmaz", async () => {
    const { o, log } = sim([{ ip: "1.1.1.1", ms: 900 }, { ip: "2.2.2.2", ms: 600 }]);
    const r = await findFast(Object.assign(o, { attempts: 2, targetMs: 200 }));
    assert.strictEqual(r.pinned, false);
    assert.deepStrictEqual(log.pins, []);
  });
  await t("sabitleme tutmazsa kaldırılır ve bildirilir", async () => {
    const { o, log } = sim([{ ip: "1.1.1.1", ms: 900 }, { ip: "2.2.2.2", ms: 600 }, { ip: "3.3.3.3", ms: 1200 }]);
    o.measure = (() => { let n = 0; return async () => { n++; return n <= 3 ? [{ ip: "1.1.1.1", ms: 900 }, { ip: "2.2.2.2", ms: 600 }, { ip: "3.3.3.3", ms: 1200 }][n - 1] : { ip: "9.9.9.9", ms: 5000 }; }; })();
    const r = await findFast(Object.assign(o, { attempts: 3, targetMs: 200 }));
    assert.strictEqual(r.pinFailed, true);
    assert.deepStrictEqual(log.pins, ["2.2.2.2", ""]);
  });
  await t("ölçüm hataları atlanır; hiç ölçüm yoksa hata", async () => {
    const r = await findFast({ attempts: 3, targetMs: 100, cancelled: () => false, newnym: async () => {}, pin: async () => {}, measure: async () => { throw new Error("x"); } });
    assert.ok(r.error);
  });
  await t("iptal edilir", async () => {
    let c = false;
    const r = await findFast({ attempts: 9, targetMs: 1, cancelled: () => c, newnym: async () => {}, pin: async () => {}, measure: async () => { c = true; return { ip: "1.1.1.1", ms: 500 }; } });
    assert.strictEqual(r.cancelled, true);
  });
  if (!process.exitCode) console.log("\nHIZ TESTLERİ GEÇTİ");
})();
