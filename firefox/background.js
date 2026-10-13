// Chrome'da servis çalışanı, Firefox'ta arka plan sayfası. lib.js Firefox'ta manifestten yüklenir.
if (typeof importScripts === "function" && typeof window === "undefined") importScripts("lib.js");

// ---- Firefox: istek bazlı SOCKS yönlendirme ----
if (FF_PROXY) {
  let st = { enabled: false, host: "", port: 0, direct: [], only: false, onlyList: [] };
  const load = async () => {
    const c = await getCfg();
    const d = await getDirect();
    const o = await getOnly();
    st = { enabled: c.enabled && !!c.socksPort, host: c.host, port: c.socksPort, direct: d.on ? d.list : [], only: o.on && o.list.length > 0, onlyList: o.list };
  };
  const ready = load();
  A.storage.onChanged.addListener(() => { load(); });
  A.proxy.onRequest.addListener(
    async (info) => {
      await ready;
      let h = "";
      try { h = new URL(info.url).hostname; } catch (_) {}
      if (!st.enabled) {
        // Sadece-liste modu: Tor bağlı değilken listedeki site gerçek IP'yle açılmasın (ölü proxy), otomatik bağlanmayı tetikle
        if (st.only && h && !isLocalHost(h) && matchesDirect(h, st.onlyList)) {
          if (info.type === "main_frame") autoConnect(info.tabId);
          return { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true, failoverTimeout: 1 };
        }
        return { type: "direct" };
      }
      if (isLocalHost(h) || h === st.host) return { type: "direct" };
      if (st.only) { // sadece listedeki siteler Tor'dan
        if (!matchesDirect(h, st.onlyList)) return { type: "direct" };
        return { type: "socks", host: st.host, port: st.port, proxyDNS: true };
      }
      if (matchesDirect(h, st.direct)) return { type: "direct" };
      // Tek proxy, geri dönüş yok: Pi'a ulaşılamazsa istek başarısız olur, doğrudan çıkmaz
      return { type: "socks", host: st.host, port: st.port, proxyDNS: true };
    },
    { urls: ["<all_urls>"] }
  );
}

// ---- Chrome: doğrudan çıkan siteler değişince proxy ayarını yeniden yaz; bağlı değilken koruma (ölü proxy) ----
if (!FF_PROXY) {
  A.storage.onChanged.addListener((ch) => {
    if (ch.direct || ch.directOn || ch.only || ch.onlyList) getCfg().then((c) => { if (c.enabled) enableProxy(); else syncGuard(); });
    else if (ch.enabled) syncGuard();
  });
  A.runtime.onStartup.addListener(syncGuard);
  A.runtime.onInstalled.addListener(syncGuard);
  syncGuard();
  // Listedeki bir siteye gidilince Tor kapalıysa otomatik bağlan
  if (A.webNavigation) {
    A.webNavigation.onBeforeNavigate.addListener(async (d) => {
      if (d.frameId !== 0) return;
      let h = "";
      try { h = new URL(d.url).hostname; } catch (_) { return; }
      const o = await getOnly();
      if (!o.on || !matchesDirect(h, o.list)) return;
      const c = await getCfg();
      if (!c.enabled) { autoConnect(d.tabId); return; }
      // "Bağlı" görünüyor ama Pi'daki oturum kaybolmuş/hazır değilse (Pi yeniden başladı, boşta silindi) yine otomatik bağlan
      let ok = false;
      try { const st = await sessionStatus(); ok = !!(st && st.ready); } catch (_) {}
      if (!ok) autoConnect(d.tabId);
    });
  }
}

// ---- Tarayıcı kapanınca bağlantıyı kes + Pi'daki oturumu sil ----
// Son pencere kapanınca çalışır. Tarayıcı bu sırada tamamen kapanırsa istek yarıda kalabilir; bu yüzden
// açılışta da (onStartup) kalıntı bağlantı varsa aynı temizlik yapılır.
if (A.windows && A.windows.onRemoved) {
  A.windows.onRemoved.addListener(async () => {
    try {
      const left = await A.windows.getAll();
      if (left.length === 0) await closeCleanup();
    } catch (_) {}
  });
}
A.runtime.onStartup.addListener(() => { closeCleanup(); });

// ---- Sağlık denetimi: her dakika Pi + gerçek çıkış IP'si (Tor'dan mı çıkıyoruz?) ----
// Alarm ve rozet burada; karar mantığı lib.js'teki nextHealth'te.
async function notifyUser(n) {
  const o = await store.get("notify");
  if (o.notify === false || !A.notifications) return;
  try {
    A.notifications.create("ehm-" + n.kind + "-" + Date.now(), {
      type: "basic",
      iconUrl: A.runtime.getURL("icon.png"),
      title: n.kind === "recovered" ? "Tor IP: bağlantı geldi" : n.kind === "leak" ? "Tor IP: DİKKAT, trafik Tor'dan çıkmıyor" : "Tor IP: bağlantı koptu",
      message: n.message,
      priority: n.kind === "recovered" ? 0 : 2,
    });
  } catch (_) {}
}

let checking = null;
function check() {
  if (!checking) checking = doCheck().finally(() => { checking = null; });
  return checking;
}

async function doCheck() {
  const c = await getCfg();
  if (!c.enabled) {
    badge("", ""); await store.set({ health: null });
    // Kes'te Pi oturumu silinmediyse (ayar kapalı) Pi'ın o oturumu "kapandı" sanmaması için yoklamaya devam et
    if (c.socksPort) { try { if (!(await sessionStatus())) await store.set({ socksPort: 0 }); } catch (_) {} }
    return null;
  }
  let probe = null;
  try {
    let s = await sessionStatus();
    if (!s) s = await api("POST", "/api/session", await sessionBody(c));
    if (s.port && s.port !== c.socksPort) {
      await store.set({ socksPort: s.port });
      await enableProxy();
    }
    if (!s.ready) {
      badge("…", "#f0b429"); // Tor bağlanıyor: alarm sayılmaz
    } else if ((await getOnly()).on) {
      probe = { state: "ok", ip: "" }; // sadece-liste modunda genel trafik doğrudan; dış IP testi anlamsız
    } else {
      const j = await fetchIp();
      if (!j) probe = { state: "down", msg: "Pi'da Tor çalışıyor ama internete çıkış yok." };
      else if (j.IsTor === false) probe = { state: "leak", ip: j.IP, msg: "Başka bir eklenti proxy ayarını değiştirmiş olabilir." };
      else probe = { state: "ok", ip: j.IP };
    }
  } catch (e) {
    probe = { state: "down", msg: e.message }; // Pi'a ulaşılamıyor; proxy yerinde kalır, trafik doğrudan çıkmaz
  }
  if (!probe) return null;
  const prev = (await store.get("health")).health || null;
  const r = nextHealth(prev, probe, Date.now());
  await store.set({ health: r.health });
  if (r.health.state === "ok") badge("TOR", "#3ecf6e");
  else if (r.health.state === "leak") badge("!!", "#e5484d");
  else badge("!", "#e5484d");
  if (r.notify) await notifyUser(r.notify);
  return r.health;
}

A.alarms.create("ehm-check", { periodInMinutes: 1 });
A.alarms.onAlarm.addListener((a) => { if (a.name === "ehm-check") check(); });
A.runtime.onStartup.addListener(check);
A.runtime.onInstalled.addListener(check);
// Açılır pencereden "şimdi kontrol et"
A.runtime.onMessage.addListener((m, _s, reply) => {
  if (m && m.type === "check") { check().then((h) => reply({ health: h }), () => reply({ health: null })); return true; }
});
