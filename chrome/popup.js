const $ = (id) => document.getElementById(id);
const els = {
  dot: $("dot"), addr: $("addr"), token: $("token"), save: $("save"),
  country: $("country"), toggle: $("toggle"), newip: $("newip"), del: $("del"),
  info: $("info"), msg: $("msg"), health: $("health"), notify: $("notify"), checknow: $("checknow"),
};

let busy = false;
let connecting = false;
let cancel = false;

for (const [code, name] of COUNTRIES) {
  const o = document.createElement("option");
  o.value = code; o.textContent = name;
  els.country.appendChild(o);
}

const setMsg = (t) => { els.msg.textContent = t || ""; };
const setInfo = (t) => { els.info.textContent = t; };
const setDot = (cls) => { els.dot.className = "dot " + (cls || ""); };
const countryName = (c) => (COUNTRIES.find((x) => x[0] === c) || [0, c])[1];

// Adres/token alanlarını doğrula, Pi adresi için izin iste, depoya yaz
async function saveConn() {
  const p = parseAddress(els.addr.value);
  if (!p) { setMsg("Pi adresi geçersiz. Örn: 192.168.1.50:8765"); return false; }
  const token = p.token || els.token.value.trim();
  if (!token) { setMsg("Token gerekli."); return false; }
  try {
    if (A.permissions && A.permissions.request) {
      const origins = [`http://${p.host}/*`];
      if (!(await A.permissions.contains({ origins }))) {
        if (!(await A.permissions.request({ origins }))) {
          setMsg("Pi adresine erişim izni verilmedi.");
          return false;
        }
      }
    }
  } catch (_) { /* Firefox'ta <all_urls> zaten verili */ }
  await store.set({ host: p.host, apiPort: p.port, token });
  els.addr.value = p.host + ":" + p.port;
  els.token.value = token;
  return true;
}

function renderButtons(cfg, hasSession, ready) {
  if (connecting) {
    els.toggle.textContent = "İptal";
    els.toggle.className = "big danger";
  } else if (cfg.enabled) {
    els.toggle.textContent = "Kes";
    els.toggle.className = "big danger";
  } else {
    els.toggle.textContent = "Bağlan";
    els.toggle.className = "big";
  }
  els.newip.disabled = !(hasSession && ready) || busy || connecting;
  els.del.hidden = !hasSession;
}

function renderHealth(h) {
  if (!h) { els.health.textContent = ""; els.health.className = ""; return; }
  const t = new Date(h.ts).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  if (h.state === "ok" && h.fails > 0) { els.health.className = ""; els.health.textContent = "Son ölçüm başarısız (" + t + "), tekrar denenecek."; }
  else if (h.state === "ok") { els.health.className = "good"; els.health.textContent = "Son kontrol " + t + ": her şey yolunda" + (h.ip ? " (IP " + h.ip + ")" : ""); }
  else if (h.state === "leak") { els.health.className = "bad"; els.health.textContent = "DİKKAT (" + t + "): trafik Tor'dan çıkmıyor" + (h.ip ? " — görünen IP " + h.ip : "") + ". " + (h.msg || ""); }
  else { els.health.className = "bad"; els.health.textContent = "Bağlantı kopuk (" + t + "): " + (h.msg || ""); }
}

// Ülke listesine çıkış rölesi sayılarını yaz (Pi önbelleğinden; alınamazsa sade liste kalır)
async function loadExitCounts() {
  try {
    const r = await api("GET", "/api/exits");
    if (!r || !r.counts) return;
    const keep = els.country.value;
    for (const o of els.country.options) {
      const name = (COUNTRIES.find((x) => x[0] === o.value) || [0, o.value])[1];
      o.textContent = countryLabel(o.value, name, r.counts);
    }
    els.country.value = keep;
  } catch (_) { /* Pi'a ulaşılamıyor: sayılar gösterilmez */ }
}

async function refresh() {
  const o = await store.get(["health", "notify"]);
  renderHealth(o.health);
  els.notify.checked = o.notify !== false;
  const cfg = await getCfg();
  if (document.activeElement !== els.addr && cfg.host) els.addr.value = cfg.host + ":" + cfg.apiPort;
  if (document.activeElement !== els.token) els.token.value = cfg.token;
  els.country.value = cfg.country;

  if (!cfg.host || !cfg.token) {
    setDot("");
    setInfo("Önce Pi adresini ve token'ı gir.");
    renderButtons(cfg, false, false);
    return;
  }
  if (connecting) return;

  let st;
  try {
    st = await sessionStatus();
    if (!st && cfg.enabled) st = await api("POST", "/api/session", await sessionBody(cfg));
  } catch (e) {
    setDot("err");
    setInfo("Pi'a ulaşılamıyor.");
    setMsg(e.message + (cfg.enabled ? "\nProxy açık olduğu için trafik kesik. Normal gezmek için 'Kes'e bas." : ""));
    renderButtons(cfg, false, false);
    return;
  }

  const ready = !!(st && st.ready);
  if (cfg.enabled && ready) {
    setDot("on");
    let t = "Tor açık • Ülke: " + countryName(cfg.country);
    if ((await getOnly()).on) {
      t += "\nMod: sadece listedeki siteler Tor'dan, gerisi doğrudan";
    } else {
      const j = await fetchIp();
      if (j) t += "\nIP: " + j.IP + (j.IsTor === false ? " (Tor değil!)" : "");
      else t += "\nIP alınamadı (seçtiğin ülkede çıkış rölesi olmayabilir; 'Rastgele' dene).";
    }
    t += "\nPi: " + cfg.host + " • oturum: " + String(cfg.sid).slice(0, 6) + " (panelde bu kod görünür)";
    setInfo(t);
  } else if (cfg.enabled) {
    setDot("wait");
    setInfo("Pi'da Tor bağlanıyor… %" + ((st && st.bootstrap) || 0) + ((st && st.summary) ? "\n" + st.summary : ""));
  } else if (st) {
    setDot("wait");
    setInfo(ready
      ? "Pi'da hazır, proxy kapalı (şu an doğrudan bağlanıyorsun).\nBağlan'a basınca anında devreye girer."
      : "Pi'da Tor bağlanıyor… %" + (st.bootstrap || 0));
  } else {
    setDot("");
    setInfo("Bağlı değil. Bağlan'a basınca Pi'da bu profil için Tor açılır.");
  }
  renderButtons(cfg, !!st, ready);
}

// Pi'daki bu profil oturumunu siler ve gerçekten silindiğini doğrular (bir kez yeniden dener). Hata mesajı döner, başarıda "".
async function dropPiSession(sid) {
  let err = "";
  for (let i = 0; i < 2; i++) {
    try {
      await api("DELETE", "/api/session/" + sid);
    } catch (e) {
      if (e.status !== 404) err = e.message; else err = "";
    }
    try {
      if (!(await sessionStatus())) { await store.set({ socksPort: 0 }); return ""; }
      err = err || "Oturum Pi'da hâlâ görünüyor.";
    } catch (e) { err = e.message; }
    await sleep(800);
  }
  return err;
}

async function connect() {
  if (!(await saveConn())) return;
  connecting = true; cancel = false;
  const cfg = await getCfg();
  renderButtons(cfg, false, false);
  try {
    const country = els.country.value;
    await store.set({ country });
    let st = await api("POST", "/api/session", await sessionBody(cfg, country));
    const deadline = Date.now() + 240000;
    while (!cancel && !(st && st.ready)) {
      if (Date.now() > deadline) {
        throw new Error("Pi'daki Tor 4 dakikada bağlanamadı. Pi'da /etc/torpool/bridges.txt dosyasına köprü ekleyip 'sudo systemctl restart torpool' dene.");
      }
      setDot("wait");
      setInfo("Pi'da Tor bağlanıyor… %" + (st.bootstrap || 0) + (st.summary ? "\n" + st.summary : ""));
      await sleep(1500);
      st = await sessionStatus();
      if (!st) throw new Error("Pi oturumu kayboldu, yeniden dene.");
    }
    if (cancel) {
      if ((await store.get("delOnStop")).delOnStop !== false) {
        const er = await dropPiSession(cfg.sid);
        setMsg(er ? "İptal edildi; Pi'daki oturum silinemedi: " + er : "İptal edildi, Pi'daki oturum silindi.");
      } else {
        setMsg("İptal edildi. Pi'daki Tor arka planda bağlanmaya devam eder.");
      }
    } else {
      await store.set({ socksPort: st.port });
      await enableProxy();
    }
  } catch (e) {
    setMsg(e.message);
  } finally {
    connecting = false;
  }
  await refresh();
}

els.save.addEventListener("click", async () => {
  if (await saveConn()) { setMsg("Kaydedildi."); await refresh(); }
});

els.toggle.addEventListener("click", async () => {
  if (connecting) { cancel = true; return; }
  setMsg("");
  const cfg = await getCfg();
  if (cfg.enabled) {
    try { await disableProxy(); } catch (e) { setMsg("Proxy kapatılamadı: " + e.message); }
    // Varsayılan: Pi'daki oturum da silinir (yer açılır). Kapalıysa Tor Pi'da açık kalır, sonraki Bağlan anında olur.
    if ((await store.get("delOnStop")).delOnStop !== false) {
      const er = await dropPiSession(cfg.sid);
      if (er) setMsg("Kesildi; Pi'daki oturum silinemedi: " + er);
    }
    await refresh();
    return;
  }
  await connect();
});

els.country.addEventListener("change", async () => {
  const country = els.country.value;
  await store.set({ country });
  const cfg = await getCfg();
  let st = null;
  try { st = await sessionStatus(); } catch (_) {}
  if (!st) return; // oturum yoksa Bağlan'da uygulanır
  busy = true; els.newip.disabled = true; setMsg("Ülke değiştiriliyor…");
  try {
    st = await api("POST", `/api/session/${cfg.sid}/country`, { country });
    for (let i = 0; i < 60 && !(st && st.ready); i++) {
      await sleep(1000);
      st = await sessionStatus();
    }
    await sleep(1500);
    if ((await getCfg()).enabled) await enableProxy();
    setMsg("");
  } catch (e) {
    setMsg(e.message);
  }
  busy = false;
  await refresh();
});

els.newip.addEventListener("click", async () => {
  if (busy || connecting) return;
  busy = true; els.newip.disabled = true; setMsg("IP değiştiriliyor…");
  const cfg = await getCfg();
  try {
    await api("POST", `/api/session/${cfg.sid}/newnym`);
    await sleep(2500);
    if ((await getCfg()).enabled) await enableProxy(); // bağlantı havuzunu temizler
    setMsg("");
  } catch (e) {
    setMsg(e.message);
  }
  busy = false;
  await refresh();
});

els.del.addEventListener("click", async () => {
  const cfg = await getCfg();
  try {
    await disableProxy();
    await api("DELETE", "/api/session/" + cfg.sid);
    await store.set({ socksPort: 0 });
    setMsg("Pi'daki oturum silindi.");
  } catch (e) {
    setMsg(e.message);
  }
  await refresh();
});

async function loadDirect() {
  const d = await getDirect();
  $("directOn").checked = d.on;
  if (document.activeElement !== $("directList")) $("directList").value = d.list.join("\n");
}
$("directOn").addEventListener("change", () => store.set({ directOn: $("directOn").checked }));
$("directSave").addEventListener("click", async () => {
  const list = normalizeDomains($("directList").value);
  await store.set({ direct: list });
  $("directList").value = list.join("\n");
  setMsg("Kaydedildi (" + list.length + " site). Açık sekmeleri yenile.");
});
$("directReset").addEventListener("click", async () => {
  await store.set({ direct: DEFAULT_DIRECT.slice() });
  await loadDirect();
loadOnly();
  setMsg("Varsayılan liste yüklendi.");
});
$("addSite").addEventListener("click", async () => {
  try {
    const tabs = await A.tabs.query({ active: true, currentWindow: true });
    const url = tabs && tabs[0] && tabs[0].url;
    const host = url ? new URL(url).hostname : "";
    const d = normalizeDomains(host);
    if (!d.length) { setMsg("Bu sekmenin adresi eklenemez."); return; }
    const cur = (await getDirect()).list;
    if (!cur.includes(d[0])) cur.push(d[0]);
    await store.set({ direct: cur });
    await loadDirect();
loadOnly();
    setMsg(d[0] + " eklendi. Sekmeyi yenile.");
  } catch (e) { setMsg(e.message); }
});

async function loadOnly() {
  const o = await getOnly();
  $("onlyOn").checked = o.on;
  $("onlyAuto").checked = (await store.get("onlyAuto")).onlyAuto === true;
  if (document.activeElement !== $("onlyList")) $("onlyList").value = o.list.join("\n");
}
$("onlyOn").addEventListener("change", async () => {
  const list = normalizeDomains($("onlyList").value);
  if ($("onlyOn").checked && !list.length) { $("onlyOn").checked = false; setMsg("Önce listeye en az bir site yaz ve Kaydet'e bas."); return; }
  await store.set({ only: $("onlyOn").checked });
  setMsg($("onlyOn").checked ? "Açıldı: listedeki siteler Tor'dan çıkar; Tor bağlı değilken açılmaz. İstersen otomatik bağlanmayı işaretle." : "Kapandı: normal mod.");
});
$("onlyAuto").addEventListener("change", () => store.set({ onlyAuto: $("onlyAuto").checked }));
$("onlySave").addEventListener("click", async () => {
  const list = normalizeDomains($("onlyList").value);
  await store.set({ onlyList: list });
  $("onlyList").value = list.join("\n");
  setMsg("Kaydedildi (" + list.length + " site). Açık sekmeleri yenile.");
});
$("onlyAdd").addEventListener("click", async () => {
  try {
    const tabs = await A.tabs.query({ active: true, currentWindow: true });
    const d = normalizeDomains(tabs && tabs[0] && tabs[0].url ? new URL(tabs[0].url).hostname : "");
    if (!d.length) { setMsg("Bu sekmenin adresi eklenemez."); return; }
    const cur = (await getOnly()).list;
    if (!cur.includes(d[0])) cur.push(d[0]);
    await store.set({ onlyList: cur });
    await loadOnly();
    setMsg(d[0] + " eklendi. Sekmeyi yenile.");
  } catch (e) { setMsg(e.message); }
});

store.get("delOnStop").then((o) => { $("delOnStop").checked = o.delOnStop !== false; });
$("delOnStop").addEventListener("change", () => store.set({ delOnStop: $("delOnStop").checked }));
store.get("delOnClose").then((o) => { $("delOnClose").checked = o.delOnClose !== false; });
$("delOnClose").addEventListener("change", () => store.set({ delOnClose: $("delOnClose").checked }));
els.notify.addEventListener("change", () => store.set({ notify: els.notify.checked }));
els.checknow.addEventListener("click", async () => {
  els.checknow.disabled = true; setMsg("Kontrol ediliyor…");
  try { const r = await A.runtime.sendMessage({ type: "check" }); renderHealth(r && r.health); setMsg(""); }
  catch (e) { setMsg(e.message); }
  els.checknow.disabled = false;
  await refresh();
});

refresh().then(loadExitCounts);
loadDirect();
loadOnly();
