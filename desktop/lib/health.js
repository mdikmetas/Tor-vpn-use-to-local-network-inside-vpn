"use strict";
// Sağlık izleme: seçili profillerin Tor bağlantısını periyodik denetler, kopunca/dönünce haber verir.
// nextHealth, eklentideki (src/lib.js) mantıkla birebir aynıdır.

const HEALTH_BAD_AFTER = 2;
function nextHealth(prev, probe, now) {
  const p = prev || { state: "ok", fails: 0 };
  const wasBad = p.state === "down" || p.state === "leak";
  if (probe.state === "ok") {
    return {
      health: { state: "ok", fails: 0, ip: probe.ip || "", ts: now, msg: "" },
      notify: wasBad ? { kind: "recovered", message: "Tor bağlantısı geri geldi" + (probe.ip ? " (IP " + probe.ip + ")." : ".") } : null,
    };
  }
  const fails = (p.fails || 0) + 1;
  const base = { fails, ip: probe.ip || p.ip || "", ts: now, msg: probe.msg || "" };
  if (!wasBad && fails < HEALTH_BAD_AFTER) {
    return { health: Object.assign({ state: "ok" }, base), notify: null }; // henüz alarm yok
  }
  const changed = !wasBad || p.state !== probe.state;
  const message = probe.state === "leak"
    ? "Trafik Tor'dan ÇIKMIYOR" + (probe.ip ? " (görünen IP " + probe.ip + ")" : "") + ". " + (probe.msg || "")
    : "Tor bağlantısı kesildi. " + (probe.msg || "");
  return {
    health: Object.assign({ state: probe.state }, base),
    notify: changed ? { kind: probe.state, message: message.trim() } : null,
  };
}

// Tek seferde bir tur: ids için probe() çalıştırır, kararı nextHealth verir.
//   getIds()          -> izlenecek profil id'leri
//   probe(id)         -> { state, ip?, msg? } | null (null: henüz hazır değil, sayılmaz)
//   onResult(id, h, notify)
function createMonitor(o) {
  const health = new Map();
  let timer = null, running = false, stopped = true;
  const interval = o.intervalMs || 60000;

  async function checkOne(id) {
    let probe;
    try { probe = await o.probe(id); } catch (e) { probe = { state: "down", msg: (e && e.message) || "ölçülemedi" }; }
    if (!probe) return health.get(id) || null;
    const r = nextHealth(health.get(id) || null, probe, Date.now());
    health.set(id, r.health);
    if (o.onResult) o.onResult(id, r.health, r.notify);
    return r.health;
  }

  async function tick() {
    if (running) return;
    running = true;
    try { for (const id of Array.from(o.getIds())) await checkOne(id); } finally { running = false; }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => { await tick(); schedule(); }, interval);
    if (timer.unref) timer.unref();
  }

  return {
    start() { if (!stopped) return; stopped = false; schedule(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    tick, checkOne,
    get: (id) => health.get(id) || null,
    drop: (id) => health.delete(id),
    all: () => Object.fromEntries(health),
  };
}

module.exports = { nextHealth, createMonitor, HEALTH_BAD_AFTER };
