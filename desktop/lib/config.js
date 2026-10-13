"use strict";
// Ayarlar ve profiller: tek bir JSON dosyası (userData klasöründe).
const fs = require("fs");
const path = require("path");
const { CC_RE, randomId, DEFAULT_API_PORT } = require("./pi");
const { DEFAULT_DIRECT, addedSince, DIRECT_VERSION, normalizeDomains } = require("./sites");

const ID_RE = /^[a-f0-9]{8,32}$/;
const IP4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAX_GOOD = 20;

// Kayıtlı iyi çıkışlar: [{ ip, ms (null olabilir), ts }] ; ping'e göre sıralı (bilinmeyenler sonda)
function cleanGood(list) {
  const out = [];
  for (const g of (Array.isArray(list) ? list : [])) {
    if (!g || !IP4_RE.test(String(g.ip)) || out.some((x) => x.ip === g.ip)) continue;
    out.push({ ip: String(g.ip), ms: Number.isFinite(g.ms) && g.ms > 0 ? Math.round(g.ms) : null, ts: Number.isFinite(g.ts) ? g.ts : Date.now() });
  }
  out.sort((a, b) => (a.ms === null) - (b.ms === null) || a.ms - b.ms);
  return out.slice(0, MAX_GOOD);
}

function normalize(d) {
  const pi = (d && d.pi) || {};
  const out = {
    pi: {
      host: typeof pi.host === "string" ? pi.host : "",
      port: Number.isInteger(pi.port) ? pi.port : DEFAULT_API_PORT,
      token: typeof pi.token === "string" ? pi.token : "",
    },
    profiles: [],
    notify: !(d && d.notify === false), // bağlantı kopunca masaüstü bildirimi
    killSwitch: !!(d && d.killSwitch), // sistem modunda güvenlik duvarı kill switch'i (varsayılan kapalı)
    directOn: !(d && d.directOn === false), // banka/e-devlet gibi siteler Tor'suz
    direct: d && Array.isArray(d.direct) ? normalizeDomains(d.direct) : DEFAULT_DIRECT.slice(),
    directVer: DIRECT_VERSION,
  };
  if (d && Array.isArray(d.direct) && (d.directVer || 1) < DIRECT_VERSION) {
    // Kayıtlı listeye yeni varsayılanları bir kez ekle (kullanıcının eklediklerine dokunma)
    out.direct = normalizeDomains(out.direct.concat(addedSince(d.directVer || 1).filter((x) => !out.direct.includes(x))));
  }
  for (const p of (d && Array.isArray(d.profiles) ? d.profiles : [])) {
    if (!p || !ID_RE.test(String(p.id))) continue;
    out.profiles.push({
      id: String(p.id),
      name: String(p.name || "Profil").slice(0, 40),
      country: CC_RE.test(String(p.country)) ? String(p.country) : "auto",
      browser: typeof p.browser === "string" && p.browser.length <= 500 ? p.browser : "auto",
      goodExits: cleanGood(p.goodExits),
    });
  }
  return out;
}

class Store {
  constructor(file) {
    this.file = file;
    try {
      this.data = normalize(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (_) {
      this.data = normalize({});
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  setPi(pi) {
    this.data.pi = { host: pi.host, port: pi.port, token: pi.token };
    this.save();
  }

  setNotify(v) {
    this.data.notify = !!v;
    this.save();
  }

  setKillSwitch(v) {
    this.data.killSwitch = !!v;
    this.save();
  }

  setDirect(on, list) {
    this.data.directOn = !!on;
    this.data.direct = normalizeDomains(list);
    this.data.directVer = DIRECT_VERSION;
    this.save();
  }

  find(id) {
    return this.data.profiles.find((p) => p.id === id) || null;
  }

  addProfile(name) {
    const n = this.data.profiles.length + 1;
    const p = {
      id: randomId(),
      name: String(name || "Profil " + n).slice(0, 40),
      country: "auto",
      browser: "auto",
      goodExits: [],
    };
    this.data.profiles.push(p);
    this.save();
    return p;
  }

  updateProfile(id, patch) {
    const p = this.find(id);
    if (!p) throw new Error("Profil bulunamadı.");
    if (typeof patch.name === "string" && patch.name.trim()) p.name = patch.name.trim().slice(0, 40);
    if (typeof patch.country === "string") {
      if (!CC_RE.test(patch.country)) throw new Error("Geçersiz ülke kodu.");
      p.country = patch.country;
    }
    if (typeof patch.browser === "string" && patch.browser.length <= 500) p.browser = patch.browser;
    this.save();
    return p;
  }

  // Çıkışı kaydet (aynı IP varsa ping'i en iyi değerle güncelle)
  addGoodExit(id, ex) {
    const p = this.find(id);
    if (!p) throw new Error("Profil bulunamadı.");
    if (!ex || !IP4_RE.test(String(ex.ip))) throw new Error("Geçersiz IP.");
    const old = p.goodExits.find((g) => g.ip === ex.ip);
    const ms = Number.isFinite(ex.ms) && ex.ms > 0 ? ex.ms : null;
    const best = old && old.ms !== null && (ms === null || old.ms < ms) ? old.ms : ms;
    p.goodExits = cleanGood(p.goodExits.filter((g) => g.ip !== ex.ip).concat([{ ip: ex.ip, ms: best, ts: Date.now() }]));
    this.save();
    return p.goodExits;
  }

  removeGoodExit(id, ip) {
    const p = this.find(id);
    if (!p) throw new Error("Profil bulunamadı.");
    p.goodExits = p.goodExits.filter((g) => g.ip !== ip);
    this.save();
    return p.goodExits;
  }

  removeProfile(id) {
    const i = this.data.profiles.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.data.profiles.splice(i, 1);
    this.save();
    return true;
  }
}

module.exports = { Store, ID_RE, IP4_RE };
