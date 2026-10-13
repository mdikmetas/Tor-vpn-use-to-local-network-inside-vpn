"use strict";
// Pi'daki torpool servisiyle konuşan istemci. Eklentideki mantıkla aynı: profil başına oturum kimliği.
const crypto = require("crypto");

const DEFAULT_API_PORT = 8765;
const API_TIMEOUT_MS = 8000;
const CC_RE = /^(auto|[a-z]{2})$/;

const COUNTRIES = [
  ["auto", "Rastgele (otomatik)"],
  ["tr", "Türkiye"], ["de", "Almanya"], ["nl", "Hollanda"], ["fr", "Fransa"],
  ["gb", "Birleşik Krallık"], ["us", "ABD"], ["ca", "Kanada"], ["se", "İsveç"],
  ["ch", "İsviçre"], ["at", "Avusturya"], ["be", "Belçika"], ["dk", "Danimarka"],
  ["fi", "Finlandiya"], ["no", "Norveç"], ["ie", "İrlanda"], ["is", "İzlanda"],
  ["es", "İspanya"], ["it", "İtalya"], ["pt", "Portekiz"], ["pl", "Polonya"],
  ["cz", "Çekya"], ["ro", "Romanya"], ["bg", "Bulgaristan"], ["hu", "Macaristan"],
  ["ua", "Ukrayna"], ["lt", "Litvanya"], ["lv", "Letonya"], ["ee", "Estonya"],
  ["md", "Moldova"], ["rs", "Sırbistan"], ["jp", "Japonya"], ["sg", "Singapur"],
  ["hk", "Hong Kong"], ["au", "Avustralya"], ["br", "Brezilya"], ["il", "İsrail"],
];

function randomId() {
  return crypto.randomBytes(8).toString("hex"); // Pi tarafı 8-32 hex karakter bekler
}

// "192.168.1.50:8765#TOKEN" -> { host, port, token }
function parseAddress(input) {
  let s = String(input || "").trim();
  let token = "";
  const i = s.indexOf("#");
  if (i >= 0) { token = s.slice(i + 1).trim(); s = s.slice(0, i).trim(); }
  s = s.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  let host = s, port = DEFAULT_API_PORT;
  const m = s.match(/^(.*):(\d{1,5})$/);
  if (m) { host = m[1]; port = parseInt(m[2], 10); }
  if (!/^[A-Za-z0-9._-]+$/.test(host) || port < 1 || port > 65535) return null;
  return { host, port, token };
}

class PiClient {
  constructor(cfg) {
    this.host = (cfg && cfg.host) || "";
    this.port = (cfg && cfg.port) || DEFAULT_API_PORT;
    this.token = (cfg && cfg.token) || "";
  }

  configured() {
    return !!(this.host && this.token);
  }

  async request(method, path, body) {
    if (!this.configured()) throw new Error("Pi adresi ve token girilmemiş.");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const r = await fetch(`http://${this.host}:${this.port}${path}`, {
        method,
        headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        cache: "no-store",
      });
      let j = null;
      try { j = await r.json(); } catch (_) { /* gövde yok */ }
      if (!r.ok) {
        const e = new Error((j && j.error) || "HTTP " + r.status);
        e.status = r.status;
        throw e;
      }
      return j;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("Pi'a ulaşılamadı (zaman aşımı).");
      if (e && e.name === "TypeError") throw new Error("Pi'a bağlanılamadı. Adres, port ve ağ bağlantısını kontrol et.");
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  exits() { return this.request("GET", "/api/exits"); }
  sessions() { return this.request("GET", "/api/sessions"); }

  async status(id) {
    try {
      return await this.request("GET", "/api/session/" + id);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  ensure(id, country) { return this.request("POST", "/api/session", { id, country }); }
  newnym(id) { return this.request("POST", `/api/session/${id}/newnym`); }
  setCountry(id, country) { return this.request("POST", `/api/session/${id}/country`, { country }); }
  pin(id, ip) { return this.request("POST", `/api/session/${id}/pin`, { ip: ip || "" }); }
  remove(id) { return this.request("DELETE", "/api/session/" + id); }
}

// Ülke listesindeki yazı: "Almanya (350)"; az ya da hiç çıkış varsa uyarı ekler. counts yoksa yalnız ad.
function countryLabel(code, name, counts) {
  if (code === "auto" || !counts) return name;
  const n = counts[code] || 0;
  if (n === 0) return `${name} (çıkış yok!)`;
  if (n < 5) return `${name} (az: ${n})`;
  return `${name} (${n})`;
}

module.exports = { countryLabel, PiClient, parseAddress, randomId, COUNTRIES, CC_RE, DEFAULT_API_PORT };
