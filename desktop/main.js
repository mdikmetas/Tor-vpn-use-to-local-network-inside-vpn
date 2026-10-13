"use strict";
const { app, BrowserWindow, ipcMain, dialog, session, Notification } = require("electron");
const fs = require("fs");
const path = require("path");
const { PiClient, parseAddress, COUNTRIES, CC_RE } = require("./lib/pi");
const { Store, ID_RE, IP4_RE } = require("./lib/config");
const browsers = require("./lib/browsers");
const { findFast } = require("./lib/fastip");
const { createSysProxy } = require("./lib/sysproxy");
const { createMonitor } = require("./lib/health");
const tailscale = require("./lib/tailscale");
const { DEFAULT_DIRECT, normalizeDomains } = require("./lib/sites");
const { createKillSwitch } = require("./lib/killswitch");
const dns = require("dns").promises;

const READY_TIMEOUT_MS = 240000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let store = null;
let sys = null;
let ks = null;               // güvenlik duvarı kill switch'i
let ksError = "";            // son kill switch hatası (arayüzde gösterilir)
let sys_ = null;              // sistem geneli proxy yöneticisi
let sysProfile = null;       // sistem geneli modun bağlı olduğu profil id'si
let recovered = false;       // önceki oturumdan kalan sistem proxy'si bu açılışta temizlendi mi
let quitting = false;
const watch = new Set();      // sağlığı izlenen profiller (bu çalışmada tarayıcısı ya da sistem modu açılanlar)
let monitor = null;
let exitCounts = null;       // ülke -> çıkış rölesi sayısı (Pi'dan)
const pinned = new Set();     // çıkışı belirli bir röleye sabitlenmiş profiller
const jobs = new Map(); // profil id -> { cancel }

// Sistem proxy yedeği: çökmeden sonra eski ayarı geri getirebilmek için diske yazılır
function backupStore(file) {
  return {
    load: () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } },
    save: (o) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o), { mode: 0o600 }); },
    clear: () => { try { fs.unlinkSync(file); } catch (_) { /* yoksa sorun değil */ } },
  };
}

const client = () => new PiClient(store.data.pi);
const dataDir = (id) => path.join(app.getPath("userData"), "browsers", id);

function profileOrThrow(id) {
  if (!ID_RE.test(String(id))) throw new Error("Geçersiz profil.");
  const p = store.find(id);
  if (!p) throw new Error("Profil bulunamadı.");
  return p;
}

// Her IPC çağrısı { ok: true, ... } ya da { ok: false, error } döndürür
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const r = await fn(...args);
      return Object.assign({ ok: true }, r || {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
}

function publicState() {
  const pi = store.data.pi;
  return {
    pi: { host: pi.host, port: pi.port, hasToken: !!pi.token },
    profiles: store.data.profiles,
    browsers: browsers.detect(),
    countries: COUNTRIES,
    platform: process.platform,
    notify: store.data.notify,
    killSwitch: { supported: ks.supported, wanted: store.data.killSwitch, active: ks.active(), error: ksError },
    direct: { on: store.data.directOn, list: store.data.direct, defaults: DEFAULT_DIRECT },
    exits: exitCounts,
    health: monitor ? monitor.all() : {},
    system: { supported: sys.supported, active: sys.active(), profileId: sys.active() ? sysProfile : null, recovered },
  };
}

// Pi adresi Tailscale adresiyse Tailscale'in açık olduğundan emin ol (kapalıysa açmayı dener).
// Dönüş: { message? } ; message doluysa bağlantı hatasına eklenir.
let lastNetTry = 0;
async function ensureNetwork(force) {
  const host = store.data.pi.host;
  if (!tailscale.isTailscaleAddr(host)) return {};
  if (!force && Date.now() - lastNetTry < 120000) return {}; // sürekli denememek için
  lastNetTry = Date.now();
  try {
    const r = await tailscale.ensureUp();
    return r.state === "up" || r.state === "started" ? {} : { message: r.message };
  } catch (e) {
    return { message: "Tailscale kontrol edilemedi: " + e.message };
  }
}

// Pi'daki Tor hazır olana kadar bekle (ilerlemeyi arayüze bildir)
async function ensureReady(id) {
  const p = profileOrThrow(id);
  if (jobs.has(id)) throw new Error("Bu profil zaten hazırlanıyor.");
  const job = { cancel: false };
  jobs.set(id, job);
  try {
    const pi = client();
    if (win && !win.isDestroyed()) win.webContents.send("progress", { id, bootstrap: 0, summary: "Bağlantı hazırlanıyor…" });
    const net = await ensureNetwork(true);
    let st;
    try {
      st = await pi.ensure(id, p.country);
    } catch (e) {
      if (net.message) e.message += "\n" + net.message;
      throw e;
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!job.cancel && !st.ready) {
      if (Date.now() > deadline) {
        throw new Error("Pi'daki Tor 4 dakikada bağlanamadı. Pi'da /etc/torpool/bridges.txt dosyasına köprü ekleyip 'sudo systemctl restart torpool' dene.");
      }
      if (win && !win.isDestroyed()) win.webContents.send("progress", { id, bootstrap: st.bootstrap || 0, summary: st.summary || "" });
      await sleep(1500);
      st = await pi.status(id);
      if (!st) throw new Error("Pi oturumu kayboldu, yeniden dene.");
    }
    return job.cancel ? { cancelled: true } : { status: st };
  } finally {
    jobs.delete(id);
  }
}

// Profilin SOCKS portu üzerinden çıkış IP'sini sorgula (tarayıcı kullanmadan, Electron'un kendi ağı ile)
async function checkIp(id) {
  const st = await client().status(id);
  if (!st || !st.running) throw new Error("Bu profilin Pi'daki Tor'u çalışmıyor.");
  if (!st.ready) throw new Error("Tor henüz hazır değil (%" + (st.bootstrap || 0) + ").");
  const host = store.data.pi.host;
  const ses = session.fromPartition(`ipcheck-${id}-${st.port}`);
  await ses.setProxy({ proxyRules: `socks5://${host}:${st.port}` });
  try { await ses.closeAllConnections(); } catch (_) { /* eski bağlantı yoksa sorun değil */ }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await ses.fetch("https://check.torproject.org/api/ip?r=" + Date.now(), { signal: ctl.signal, cache: "no-store" });
    const j = await r.json();
    return { ip: j.IP, isTor: j.IsTor, country: st.country };
  } catch (e) {
    throw new Error("IP alınamadı. Seçtiğin ülkede çıkış rölesi olmayabilir; 'Rastgele' dene.");
  } finally {
    clearTimeout(t);
  }
}

// Profilin Tor devresi üzerinden gecikme ölç: ilk istek IP'yi verir, sonraki 3 isteğin en düşüğü gecikmedir
async function measureLatency(id) {
  const st = await client().status(id);
  if (!st || !st.ready) throw new Error("Tor hazır değil.");
  const ses = session.fromPartition(`fast-${id}-${st.port}-${Date.now()}`, { cache: false });
  await ses.setProxy({ proxyRules: `socks5://${store.data.pi.host}:${st.port}` });
  const get = async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const t0 = Date.now();
    try {
      const r = await ses.fetch("https://check.torproject.org/api/ip?r=" + Math.random(), { signal: ctl.signal, cache: "no-store" });
      const j = await r.json();
      return { ip: j.IP, ms: Date.now() - t0 };
    } finally { clearTimeout(t); }
  };
  const first = await get();
  let min = Infinity;
  for (let i = 0; i < 3; i++) { try { min = Math.min(min, (await get()).ms); } catch (_) { /* tek ölçüm kaybı önemsiz */ } }
  try { await ses.closeAllConnections(); } catch (_) { /* kapanmış olabilir */ }
  return { ip: first.ip, ms: Number.isFinite(min) ? min : first.ms };
}

// Sistem proxy'si gerçekten uygulanıyor mu? Electron'un varsayılan oturumu sistem proxy'sini kullanır:
// hangi proxy'ye çözüldüğünü ve görünen IP'yi (Tor mu?) döndür.
async function systemProbe() {
  const ses = session.defaultSession;
  try { await ses.forceReloadProxyConfig(); } catch (_) { /* eski sürüm */ }
  try { await ses.closeAllConnections(); } catch (_) { /* bağlantı yoksa sorun değil */ }
  const resolved = await ses.resolveProxy("https://check.torproject.org/");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await ses.fetch("https://check.torproject.org/api/ip?r=" + Date.now(), { signal: ctl.signal, cache: "no-store" });
    const j = await r.json();
    return { resolved, ip: j.IP, isTor: !!j.IsTor };
  } catch (e) {
    return { resolved, error: (e && e.message) || "bağlantı kurulamadı" };
  } finally {
    clearTimeout(t);
  }
}

// Bir profilin sağlığı: Pi'da Tor ayakta mı, gerçekten Tor'dan mı çıkıyor; sistem modundaysa sistem trafiği de Tor'dan mı
async function probeProfile(id) {
  let st;
  try { st = await client().status(id); } catch (e) {
    const net = await ensureNetwork(false); // Tailscale kapanmış olabilir: açmayı dene
    return { state: "down", msg: "Pi'a ulaşılamıyor: " + e.message + (net.message ? " " + net.message : "") };
  }
  if (!st || !st.running) return { state: "down", msg: "Pi'da bu profilin Tor'u çalışmıyor." };
  if (!st.ready) return null; // bağlanıyor: alarm sayılmaz
  let r;
  try { r = await checkIp(id); } catch (e) { return { state: "down", msg: "Tor üzerinden internete çıkış yok." }; }
  if (!r.isTor) return { state: "leak", ip: r.ip, msg: "Çıkış Tor ağında görünmüyor." };
  if (sys.active() && sysProfile === id) {
    const s = await systemProbe();
    if (s.error) return { state: "down", ip: r.ip, msg: "Sistem trafiği çıkış yapamıyor (" + s.error + ")." };
    if (!s.isTor) return { state: "leak", ip: s.ip, msg: "Sistem proxy ayarı Tor'a yönlenmiyor; başka bir program ayarı değiştirmiş olabilir." };
  }
  return { state: "ok", ip: r.ip };
}

function notifyHealth(n) {
  if (!store.data.notify || !Notification.isSupported()) return;
  const title = n.kind === "recovered" ? "Tor IP: bağlantı geldi" : n.kind === "leak" ? "Tor IP: DİKKAT, trafik Tor'dan çıkmıyor" : "Tor IP: bağlantı koptu";
  try { new Notification({ title, body: n.message, silent: n.kind === "recovered" }).show(); } catch (_) { /* bildirim gösterilemedi */ }
}

// Pi'dan ülke başına çıkış rölesi sayılarını al (Pi önbellekler; hata olursa eski değer kalır)
async function refreshExits() {
  if (!store.data.pi.host || !store.data.pi.token) return false;
  try {
    const r = await client().exits();
    if (r && r.counts) { exitCounts = r.counts; return true; }
  } catch (_) { /* Pi kapalı ya da liste alınamadı: sayılar gösterilmez/eski kalır */ }
  return false;
}

// Kill switch'i uygula: Pi'ın IPv4 adresi bulunup güvenlik duvarı kuralları yazılır
async function applyKs() {
  const host = store.data.pi.host;
  if (tailscale.isTailscaleAddr(host)) {
    throw new Error("Pi Tailscale üzerinden bağlı: güvenlik duvarı kill switch'i Tailscale'in kendi bağlantısını da keseceği için kullanılamaz.");
  }
  let ip = host;
  if (!IP4_RE.test(host)) {
    try { ip = (await dns.lookup(host, { family: 4 })).address; } catch (_) { throw new Error("Pi adresi çözülemedi; kill switch için IP adresi kullan."); }
  }
  await ks.enable(ip);
}

// Doğrudan çıkan siteler: kapalıysa boş liste
const activeDirect = () => (store.data.directOn ? store.data.direct : []);

function registerIpc() {
  handle("ks:set", async (on) => {
    store.setKillSwitch(!!on);
    ksError = "";
    if (!on) {
      await ks.disable();
    } else if (sys.active()) {
      try { await applyKs(); } catch (e) { ksError = e.message; store.setKillSwitch(false); }
    }
    return { state: publicState() };
  });
  handle("exit:save", (id, ex) => {
    profileOrThrow(id);
    store.addGoodExit(id, ex || {});
    return { state: publicState() };
  });

  handle("exit:remove", (id, ip) => {
    profileOrThrow(id);
    store.removeGoodExit(id, String(ip));
    return { state: publicState() };
  });

  // Kayıtlı bir çıkışa geri dön: Pi'da o röleye sabitle, gerçekten o IP geldi mi doğrula
  handle("exit:use", async (id, ip) => {
    profileOrThrow(id);
    if (!IP4_RE.test(String(ip))) throw new Error("Geçersiz IP.");
    const pi = client();
    const st = await pi.status(id);
    if (!st || !st.ready) throw new Error("Önce Tor'u hazırla (tarayıcıyı aç ya da sistem modunu aç).");
    await pi.pin(id, ip);
    pinned.add(id);
    await sleep(3000);
    let r = null;
    try { r = await checkIp(id); } catch (_) { r = null; }
    if (!r || r.ip !== ip) {
      try { await pi.pin(id, ""); } catch (_) { /* sabitleme zaten tutmadı */ }
      pinned.delete(id);
      throw new Error("Bu çıkış şu an kullanılamıyor (röle kapanmış ya da ülke ayarıyla çakışıyor olabilir). Sabitleme kaldırıldı; listeden silebilirsin.");
    }
    store.addGoodExit(id, { ip, ms: null });
    return { ip, state: publicState() };
  });

  handle("settings:direct", async (on, list) => {
    store.setDirect(on, normalizeDomains(list));
    try { await sys.setDirect(activeDirect()); } catch (_) { /* sistem modu kapalıysa ya da yazılamadıysa bir sonraki bağlanışta uygulanır */ }
    return { state: publicState() };
  });
  handle("exits:refresh", async () => { await refreshExits(); return { state: publicState() }; });
  handle("settings:notify", (v) => { store.setNotify(!!v); return { state: publicState() }; });
  handle("health:check", async (id) => { profileOrThrow(id); watch.add(id); await monitor.checkOne(id); return { health: monitor.get(id) }; });

  handle("state:get", () => ({ state: publicState() }));

  handle("pi:save", async (addr, tokenField) => {
    const p = parseAddress(addr);
    if (!p) throw new Error("Pi adresi geçersiz. Örn: 192.168.1.50:8765");
    const token = p.token || String(tokenField || "").trim() || store.data.pi.token;
    if (!token) throw new Error("Token gerekli.");
    const next = { host: p.host, port: p.port, token };
    await new PiClient(next).sessions(); // adres ve token'ı dene
    store.setPi(next);
    await refreshExits();
    return { state: publicState() };
  });

  handle("profile:add", () => {
    const p = store.addProfile();
    return { profile: p, state: publicState() };
  });

  handle("profile:update", (id, patch) => {
    profileOrThrow(id);
    store.updateProfile(id, patch || {});
    return { state: publicState() };
  });

  // ---- Sistem geneli mod: bu bilgisayarın proxy ayarını seçili profilin Tor'una bağlar ----
  handle("sys:enable", async (id) => {
    profileOrThrow(id);
    if (!sys.supported) throw new Error("Sistem geneli mod bu işletim sisteminde desteklenmiyor.");
    const r = await ensureReady(id);
    if (r.cancelled) return { cancelled: true };
    await sys.enable(store.data.pi.host, r.status.port, activeDirect());
    sysProfile = id;
    ksError = "";
    if (store.data.killSwitch) { try { await applyKs(); } catch (e) { ksError = e.message; } }
    watch.add(id);
    recovered = false;
    return { state: publicState() };
  });

  handle("sys:disable", async () => {
    try { await sys.disable(); } finally { sysProfile = null; try { await ks.disable(); } catch (e) { ksError = e.message; } }
    return { state: publicState() };
  });

  // Sistem proxy'si gerçekten uygulanıyor mu? Electron'un varsayılan oturumu sistem proxy'sini kullanır:
  // hangi proxy'ye çözüldüğünü ve görünen IP'yi (Tor mu?) döndür.
  handle("sys:test", async () => ({ test: await systemProbe() }));

  // En hızlı IP'yi bul: dene, ölç, gerekirse değiştir; en düşük gecikmeli çıkışı sabitle
  handle("fast:run", async (id, opt) => {
    profileOrThrow(id);
    if (jobs.has(id)) throw new Error("Bu profil meşgul.");
    const job = { cancel: false };
    jobs.set(id, job);
    const pi = client();
    const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send("fastprogress", { id, message: m }); };
    try {
      const st = await pi.status(id);
      if (!st || !st.ready) throw new Error("Önce Tor'u hazırla (tarayıcıyı aç ya da sistem modunu aç).");
      if (pinned.has(id)) { await pi.pin(id, ""); pinned.delete(id); }
      const o = opt || {};
      const r = await findFast({
        attempts: Number(o.attempts), targetMs: Number(o.targetMs),
        cancelled: () => job.cancel,
        onProgress: send,
        measure: () => measureLatency(id),
        newnym: async () => { await pi.newnym(id); await sleep(3000); },
        pin: async (ip) => { await pi.pin(id, ip); if (ip) pinned.add(id); else pinned.delete(id); await sleep(1500); },
      });
      if (r.pinned) pinned.add(id);
      // Hedefin altında kalan çıkışları ve en iyiyi otomatik kaydet
      const target = Number(o.targetMs) || 700;
      try {
        for (const x of (r.tried || [])) if (x && x.ip && x.ms > 0 && x.ms <= target) store.addGoodExit(id, x);
        if (r.best && r.best.ip) store.addGoodExit(id, r.best);
      } catch (_) { /* kayıt başarısız olursa arama sonucu yine de gösterilir */ }
      return { result: r, state: publicState() };
    } finally {
      jobs.delete(id);
    }
  });

  handle("profile:remove", async (id, remote) => {
    profileOrThrow(id);
    if (sys.active() && sysProfile === id) {
      try { await sys.disable(); } finally { sysProfile = null; try { await ks.disable(); } catch (e) { ksError = e.message; } }
    }
    const job = jobs.get(id);
    if (job) job.cancel = true;
    if (remote) {
      try { await client().remove(id); } catch (e) { if (e.status !== 404) throw e; }
    }
    pinned.delete(id);
    watch.delete(id);
    monitor.drop(id);
    store.removeProfile(id);
    // Tarayıcı verisi (çerezler vb.) yalnızca uygulamanın kendi klasöründen silinir
    fs.rmSync(dataDir(id), { recursive: true, force: true });
    return { state: publicState() };
  });

  handle("session:status", async (id) => {
    profileOrThrow(id);
    return { status: await client().status(id) };
  });

  handle("session:ensure", (id) => ensureReady(id));

  handle("session:cancel", (id) => {
    const job = jobs.get(id);
    if (job) job.cancel = true;
    return {};
  });

  handle("session:newnym", async (id) => {
    profileOrThrow(id);
    if (pinned.has(id)) { await client().pin(id, ""); pinned.delete(id); } // sabit çıkış IP değişmez: önce bırak
    await client().newnym(id);
    await sleep(2500);
  });

  handle("session:country", async (id, cc) => {
    profileOrThrow(id);
    if (!CC_RE.test(String(cc))) throw new Error("Geçersiz ülke kodu.");
    store.updateProfile(id, { country: cc });
    pinned.delete(id); // ülke değişince Pi'daki sabitleme de kalkar
    const pi = client();
    const st = await pi.status(id);
    if (!st) return { applied: false }; // oturum yok: tarayıcı açılırken uygulanır
    let cur = await pi.setCountry(id, cc);
    for (let i = 0; i < 60 && !(cur && cur.ready); i++) {
      await sleep(1000);
      cur = await pi.status(id);
    }
    await sleep(1500);
    return { applied: true };
  });

  handle("browser:open", async (id) => {
    const p = profileOrThrow(id);
    const found = browsers.detect();
    const b = browsers.resolveBrowser(found, p.browser);
    if (!b) throw new Error("Tarayıcı bulunamadı. Profil ayarlarından bir tarayıcı seç.");
    const r = await ensureReady(id);
    if (r.cancelled) return { cancelled: true };
    const spec = browsers.buildLaunch({
      kind: b.kind, exe: b.path, dataDir: dataDir(id),
      host: store.data.pi.host, port: r.status.port,
      direct: activeDirect(),
    });
    await browsers.launch(spec.exe, spec.args);
    watch.add(id);
    return { status: r.status, browser: b.name };
  });

  handle("ip:check", (id) => {
    profileOrThrow(id);
    return checkIp(id);
  });

  handle("browser:pick", async () => {
    const filters = process.platform === "win32" ? [{ name: "Program", extensions: ["exe"] }] : [];
    const r = await dialog.showOpenDialog(win, { title: "Tarayıcı programını seç", properties: ["openFile"], filters });
    if (r.canceled || !r.filePaths[0]) return { path: "" };
    return { path: r.filePaths[0] };
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 940, height: 660, minWidth: 760, minHeight: 520,
    title: "Tor IP",
    backgroundColor: "#1b1b24",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Sistem geneli mod açıkken pencere kapatılırsa: proxy de kapanacağı için kullanıcıya sor
  win.on("close", (e) => {
    if (quitting || !sys.active()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      title: "Sistem geneli mod açık",
      message: "Bu bilgisayarın tüm trafiği şu an Tor'dan geçiyor.",
      detail: "Uygulamayı kapatırsan sistem proxy ayarı eski haline döner. İstersen pencereyi küçültüp arka planda açık bırakabilirsin.",
      buttons: ["Küçült", "Proxy'yi kapat ve çık", "Vazgeç"],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 1) return;       // kapanmaya devam: before-quit proxy'yi geri alır
    e.preventDefault();
    if (choice === 0) win.minimize();
  });
  win.on("closed", () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(async () => {
    store = new Store(path.join(app.getPath("userData"), "config.json"));
    if (store.data.profiles.length === 0) store.addProfile("Profil 1");
    sys = createSysProxy({ store: backupStore(path.join(app.getPath("userData"), "sysproxy-backup.json")) });
    // Önceki çalışma çöktüyse sistem proxy'si açık kalmış olabilir (Windows'ta PAC sunucusu da artık yok): eski haline getir
    ks = createKillSwitch({ store: backupStore(path.join(app.getPath("userData"), "killswitch-backup.json")) });
    try { recovered = await sys.recover(); } catch (_) { recovered = false; }
    try { await ks.recover(); } catch (e) { ksError = e.message; }
    monitor = createMonitor({
      intervalMs: 60000,
      getIds: () => Array.from(watch).filter((id) => store.find(id)),
      probe: probeProfile,
      onResult: (id, h, n) => {
        if (win && !win.isDestroyed()) win.webContents.send("health", { id, health: h });
        if (n) notifyHealth(n);
      },
    });
    monitor.start();
    refreshExits();
    setInterval(refreshExits, 30 * 60 * 1000).unref();
    registerIpc();
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on("window-all-closed", () => app.quit());

  // Çıkarken sistem proxy'sini mutlaka geri al
  app.on("before-quit", (e) => {
    if (quitting || !sys || !(sys.active() || (ks && ks.active()))) return;
    e.preventDefault();
    quitting = true;
    sys.disable().catch(() => {}).then(() => ks.disable()).catch(() => {}).finally(() => app.quit());
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { if (sys && (sys.active() || (ks && ks.active()))) { quitting = true; sys.disable().catch(() => {}).then(() => ks.disable()).catch(() => {}).finally(() => app.exit(0)); } else app.exit(0); });
  }
}
