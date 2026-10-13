/* Ortak yardımcılar: Chrome/Edge/Brave (MV3) ve Firefox (MV2) */
const A = globalThis.browser || globalThis.chrome;
const ACTION = A.action || A.browserAction;
const FF_PROXY = !!(A.proxy && A.proxy.onRequest); // Firefox: istek bazlı proxy
const API_TIMEOUT_MS = 8000;
const DEFAULT_API_PORT = 8765;

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

const store = {
  get: (k) => A.storage.local.get(k),
  set: (o) => A.storage.local.set(o),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Pi'ın indirme sayfasından gelen zip'te preset.json bulunur: adres ve token ilk açılışta otomatik alınır
async function loadPreset() {
  try {
    const r = await fetch(A.runtime.getURL("preset.json"), { cache: "no-store" });
    if (!r.ok) return null;
    const p = await r.json();
    return p && p.host && p.token ? p : null;
  } catch (_) {
    return null;
  }
}

async function getCfg() {
  const s = await store.get(["sid", "host", "apiPort", "token", "country", "enabled", "socksPort", "flip"]);
  if (!s.host && !s.token) {
    const p = await loadPreset();
    if (p) {
      s.host = p.host;
      s.apiPort = p.apiPort || DEFAULT_API_PORT;
      s.token = p.token;
      await store.set({ host: s.host, apiPort: s.apiPort, token: s.token });
    }
  }
  if (!s.sid) {
    s.sid = randomId(); // bu tarayıcı profiline özel kimlik -> Pi'da kendi Tor'u
    await store.set({ sid: s.sid });
  }
  return {
    sid: s.sid,
    host: s.host || "",
    apiPort: s.apiPort || DEFAULT_API_PORT,
    token: s.token || "",
    country: s.country || "auto",
    enabled: !!s.enabled,
    socksPort: s.socksPort || 0,
    flip: !!s.flip,
  };
}

// "192.168.1.50:8765#TOKEN" -> { host, port, token }
function parseAddress(input) {
  let s = (input || "").trim();
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

function isLocalHost(h) {
  h = (h || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h === "::1") return true;
  if (!h.includes(".") && !h.includes(":")) return true; // intranet adı
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return h.endsWith(".local");
}

// ---- Pi API ----
async function api(method, path, body) {
  const c = await getCfg();
  if (!c.host || !c.token) throw new Error("Pi adresi ve token girilmemiş.");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(`http://${c.host}:${c.apiPort}${path}`, {
      method,
      headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: "no-store",
    });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) {
      const e = new Error((j && j.error) || "HTTP " + r.status);
      e.status = r.status;
      throw e;
    }
    return j;
  } catch (e) {
    const ts = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(c.host) || /\.ts\.net$/i.test(c.host)
      ? " Tailscale adresi kullanıyorsun: bu bilgisayarda Tailscale açık ve bağlı mı?" : "";
    if (e && e.name === "AbortError") throw new Error("Pi'a ulaşılamadı (zaman aşımı)." + ts);
    if (e && e.name === "TypeError") throw new Error("Pi'a bağlanılamadı. Adres, port ve ağ bağlantısını kontrol et." + ts);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function sessionStatus() {
  const c = await getCfg();
  try {
    return await api("GET", "/api/session/" + c.sid);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// ---- Proxy ----
function badge(text, color) {
  try {
    ACTION.setBadgeText({ text });
    if (color) ACTION.setBadgeBackgroundColor({ color });
  } catch (_) {}
}

async function protectWebRtc(on) {
  const n = A.privacy && A.privacy.network;
  if (!n) return;
  try {
    if (n.webRTCIPHandlingPolicy) {
      if (on) await n.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
      else await n.webRTCIPHandlingPolicy.clear({});
      return;
    }
  } catch (_) {}
  try {
    if (FF_PROXY && n.peerConnectionEnabled) {
      if (on) await n.peerConnectionEnabled.set({ value: false });
      else await n.peerConnectionEnabled.clear({});
    }
  } catch (_) {}
}

// Proxy'yi aç (Chrome: ayar yazılır; Firefox: arka plan dinleyicisi depodaki duruma bakar)
async function enableProxy() {
  const c = await getCfg();
  if (!c.host || !c.socksPort) return;
  if (!FF_PROXY) {
    const only = await getOnly();
    if (only.on && only.list.length) {
      // Sadece listedeki siteler Tor'dan; geri kalan her şey doğrudan. PAC'ta DIRECT yedeği YOK:
      // Pi'a ulaşılamazsa listedeki site açılmaz, gerçek IP'yle de açılmaz.
      await A.proxy.settings.set({
        scope: "regular",
        value: { mode: "pac_script", pacScript: { data: buildPac(c.host, c.socksPort, only.list) } },
      });
      await protectWebRtc(true);
      await store.set({ enabled: true });
      badge("TOR", "#3ecf6e");
      return;
    }
    const flip = !c.flip; // her çağrıda ayarı hafifçe değiştir: Chrome boştaki bağlantıları bırakır
    const bypass = [
      "localhost", "127.0.0.1", "[::1]",
      "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", c.host,
    ];
    if (flip) bypass.push("<local>");
    const dr = await getDirect();
    if (dr.on) for (const d of dr.list) bypass.push(d, "*." + d); // banka/e-devlet gibi siteler doğrudan
    await A.proxy.settings.set({
      scope: "regular",
      value: {
        mode: "fixed_servers",
        rules: { singleProxy: { scheme: "socks5", host: c.host, port: c.socksPort }, bypassList: bypass },
      },
    });
    await store.set({ flip });
  }
  await protectWebRtc(true);
  await store.set({ enabled: true });
  badge("TOR", "#3ecf6e");
}

async function disableProxy() {
  if (!FF_PROXY) await A.proxy.settings.clear({ scope: "regular" });
  await protectWebRtc(false);
  await store.set({ enabled: false, guard: false });
  badge("", "");
  await syncGuard();
}

// Tarayıcı kapanırken / yeniden açılırken: proxy'yi kapat, Pi'daki oturumu sil (Pi panelinde profil satırı kalkar, boş'a döner).
// keepalive: tarayıcı kapanırken servis çalışanı ölse bile istek gönderilir.
// Pi'a gönderilen oturum isteği: tarayıcı kapanınca temizlik açıksa "ttl" ile Pi'a de haber verilir.
// Eklenti her dakika Pi'ı yoklar; 3 dk yoklama gelmezse (Chrome kapandı) Pi oturumu kendisi siler.
const HEARTBEAT_TTL_S = 180;
async function sessionBody(c, country) {
  const o = await store.get("delOnClose");
  return { id: c.sid, country: country || c.country, ttl: o.delOnClose === false ? 0 : HEARTBEAT_TTL_S };
}

async function closeCleanup() {
  const o = await store.get("delOnClose");
  if (o.delOnClose === false) return;
  const c = await getCfg();
  const hadSession = c.enabled || c.socksPort > 0;
  if (!hadSession) return;
  // Tarayıcı her an kapanabilir: ÖNCE Pi'a istek gönder, proxy'yi sonra kapat
  let sent = false;
  if (c.host && c.token) {
    try {
      await fetch(`http://${c.host}:${c.apiPort}/api/session/${c.sid}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" },
        keepalive: true,
        cache: "no-store",
      });
      sent = true;
    } catch (_) { /* Pi'a ulaşılamadı: Pi yoklama kesilince kendisi siler; açılışta (onStartup) yeniden denenir */ }
  }
  try { await disableProxy(); } catch (_) {}
  if (sent) await store.set({ socksPort: 0, health: null });
}

// "Sadece listedeki siteler" modu açıkken Tor bağlı DEĞİLSE listedeki siteler gerçek IP'yle açılmasın:
// proxy ölü bir adrese (127.0.0.1:1) yönlendirilir, site açılmaz. Bağlanınca enableProxy gerçek porta geçirir.
async function syncGuard() {
  if (FF_PROXY) return; // Firefox'ta onRequest dinleyicisi aynı işi yapar (background.js)
  const c = await getCfg();
  if (c.enabled) return;
  const o = await getOnly();
  const st = await store.get("guard");
  if (o.on && o.list.length) {
    await A.proxy.settings.set({
      scope: "regular",
      value: { mode: "pac_script", pacScript: { data: buildPac("127.0.0.1", 1, o.list) } },
    });
    await store.set({ guard: true });
  } else if (st.guard) {
    await A.proxy.settings.clear({ scope: "regular" });
    await store.set({ guard: false });
  }
}

// Listedeki siteye girilince Tor kapalıysa otomatik bağlan (Bağlan düğmesindeki işin aynısı), hazır olunca sekmeyi yenile
let autoBusy = false;
async function autoConnect(tabId) {
  const o = await store.get("onlyAuto");
  const only = await getOnly();
  if (!only.on || o.onlyAuto !== true || autoBusy) return;
  const c = await getCfg();
  if (!c.host || !c.token) return;
  autoBusy = true;
  try {
    badge("…", "#f0b429");
    let st = await api("POST", "/api/session", await sessionBody(c));
    const deadline = Date.now() + 240000;
    while (!(st && st.ready)) {
      if (Date.now() > deadline) throw new Error("Tor 4 dakikada bağlanamadı.");
      await new Promise((r) => setTimeout(r, 1500));
      st = await sessionStatus();
      if (!st) throw new Error("Pi oturumu kayboldu.");
    }
    await store.set({ socksPort: st.port });
    await enableProxy();
    if (tabId != null && A.tabs && A.tabs.reload) { try { await A.tabs.reload(tabId); } catch (_) {} }
  } catch (e) {
    badge("!", "#e5484d");
    await store.set({ health: { state: "down", fails: 2, ip: "", ts: Date.now(), msg: "Otomatik bağlanma başarısız: " + e.message } });
    try {
      if (A.notifications) A.notifications.create("ehm-auto-" + Date.now(), { type: "basic", iconUrl: A.runtime.getURL("icon.png"), title: "Tor IP: otomatik bağlanma başarısız", message: e.message, priority: 2 });
    } catch (_) {}
  } finally {
    autoBusy = false;
  }
}

async function fetchIp() {
  try {
    const r = await fetch("https://check.torproject.org/api/ip?r=" + Date.now(), { cache: "no-store" });
    return await r.json(); // { IsTor, IP }
  } catch (_) {
    return null;
  }
}

// ---- Sağlık izleme: saf mantık (arka plan her dakika ölçer, burada karar verilir) ----
// prev: önceki sağlık kaydı | null ; probe: { state: "ok"|"down"|"leak", ip?, msg? }
// Tek bir kötü ölçümde alarm vermez (anlık takılmalar olur); art arda 2 kötü ölçüm gerekir.
// Dönüş: { health, notify } ; notify: null | { kind: "down"|"leak"|"recovered", message }
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

// ---- Ülke başına çıkış rölesi sayısı (Pi'dan) ----
function countryLabel(code, name, counts) {
  if (code === "auto" || !counts) return name;
  const n = counts[code] || 0;
  if (n === 0) return name + " (çıkış yok!)";
  if (n < 5) return name + " (az: " + n + ")";
  return name + " (" + n + ")";
}

// ---- Doğrudan çıkan siteler (masaüstü lib/sites.js ile aynı mantık) ----
const BANK_DIRECT = [
  "gov.tr", "bel.tr",
  "ziraatbank.com.tr", "halkbank.com.tr", "vakifbank.com.tr", "isbank.com.tr", "garantibbva.com.tr", "garanti.com.tr",
  "yapikredi.com.tr", "akbank.com", "qnb.com.tr", "qnbfinansbank.com", "denizbank.com", "teb.com.tr", "ingbank.com.tr",
  "enpara.com", "odeabank.com.tr", "sekerbank.com.tr", "kuveytturk.com.tr", "albaraka.com.tr", "turkiyefinans.com.tr",
  "fibabanka.com.tr", "anadolubank.com.tr", "hsbc.com.tr", "alternatifbank.com.tr", "ziraatkatilim.com.tr",
  "vakifkatilim.com.tr", "emlakkatilim.com.tr", "papara.com",
];
// Yapay zekâ / geliştirici siteleri (v2 eklemesi): bunlar Tor'u engelleyebilir ya da hesabı şüpheli giriş diye kilitleyebilir
const AI_DIRECT = [
  "claude.ai", "claude.com", "anthropic.com",
  "google.com", "google.com.tr", "gstatic.com", "googleapis.com", "googleusercontent.com",
  "openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com",
  "x.ai", "grok.com", "perplexity.ai", "mistral.ai", "deepseek.com", "poe.com", "meta.ai", "character.ai",
  "copilot.microsoft.com", "openrouter.ai", "groq.com", "cohere.com", "together.ai", "qwen.ai", "kimi.com",
  "huggingface.co", "hf.co",
];
const DEV_DIRECT = ["github.com", "githubusercontent.com", "githubassets.com", "github.io", "githubcopilot.com", "ghcr.io"]; // v3
const X_CRYPTO_DIRECT = [ // v4: X ve kripto borsaları (Tor çıkış IP'sini engelleyebilir, hesabı kilitleyebilir)
  "x.com", "twitter.com", "twimg.com", "t.co",
  "binance.com", "binance.me", "okx.com", "bybit.com", "kucoin.com", "gate.io", "gate.com", "mexc.com", "bitget.com",
  "coinbase.com", "kraken.com", "htx.com", "bitfinex.com", "bitstamp.net", "bingx.com", "crypto.com", "upbit.com",
  "paribu.com", "btcturk.com", "bitexen.com", "icrypex.com", "cointr.com", "coingecko.com",
];
const DIRECT_VERSION = 4; // listeye yeni varsayılanlar eklendikçe artar; kayıtlı listeye, görmediği sürümlerin eklemeleri bir kez eklenir
// [sürüm, liste]: kullanıcı eski sürümün eklemelerini silmişse geri gelmez
const DIRECT_ADDITIONS = [[2, AI_DIRECT], [3, DEV_DIRECT], [4, X_CRYPTO_DIRECT]];
const addedSince = (ver) => DIRECT_ADDITIONS.filter((a) => a[0] > ver).flatMap((a) => a[1]);
const DEFAULT_DIRECT = BANK_DIRECT.concat(AI_DIRECT, DEV_DIRECT, X_CRYPTO_DIRECT);

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Serbest metni ("https://www.x.com/yol", "*.x.com", satır ya da virgülle ayrılmış) temiz alan adı listesine çevirir
function normalizeDomains(input) {
  const parts = Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/);
  const out = [];
  for (let p of parts) {
    p = String(p || "").trim().toLowerCase();
    if (!p) continue;
    p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^\*?\./, "").replace(/^www\./, "");
    if (DOMAIN_RE.test(p) && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 300);
}

// host, listedeki bir alan adının kendisi ya da alt alan adı mı?
function matchesDirect(host, list) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return (list || []).some((d) => h === d || h.endsWith("." + d));
}


async function getDirect() {
  const o = await store.get(["direct", "directOn", "directVer"]);
  let list = Array.isArray(o.direct) ? o.direct : DEFAULT_DIRECT.slice();
  if (Array.isArray(o.direct) && (o.directVer || 1) < DIRECT_VERSION) {
    // Kayıtlı listeye yeni varsayılanları bir kez ekle (kullanıcının eklediklerine dokunma)
    list = list.concat(addedSince(o.directVer || 1).filter((d) => !list.includes(d)));
    await store.set({ direct: list, directVer: DIRECT_VERSION });
  } else if (!o.directVer) {
    await store.set({ directVer: DIRECT_VERSION });
  }
  return { on: o.directOn !== false, list };
}

// ---- Sadece listedeki siteler Tor'dan (diğer her şey doğrudan) ----
// "Sadece listedeki siteler Tor'dan" için hazır liste: kontrol/test siteleri ve bitcointalk (Tor'a özel kullanım için)
const ONLY_DEFAULT = ["bitcointalk.org", "check.torproject.org", "ip-adresim.net", "browserleaks.com"];

async function getOnly() {
  const o = await store.get(["only", "onlyList", "onlyVer"]);
  let list = Array.isArray(o.onlyList) ? o.onlyList : [];
  if (!o.onlyVer) {
    // ilk sürümde hazır siteleri bir kez ekle (kullanıcının eklediklerine dokunma, silerse geri gelmez)
    list = list.concat(ONLY_DEFAULT.filter((d) => !list.includes(d)));
    await store.set({ onlyList: list, onlyVer: 1 });
  }
  return { on: o.only === true, list };
}

// Chrome PAC: listedeki alan adı ve alt alan adları SOCKS5'ten (uzaktan DNS), gerisi DIRECT
function buildPac(host, port, list) {
  const doms = normalizeDomains(list);
  const proxy = "SOCKS5 " + host + ":" + port;
  return "function FindProxyForURL(url, host) {\n" +
    "  host = host.toLowerCase();\n" +
    "  var L = " + JSON.stringify(doms) + ";\n" +
    "  for (var i = 0; i < L.length; i++) {\n" +
    "    if (host === L[i] || dnsDomainIs(host, '.' + L[i])) return " + JSON.stringify(proxy) + ";\n" +
    "  }\n" +
    "  return 'DIRECT';\n}\n";
}
