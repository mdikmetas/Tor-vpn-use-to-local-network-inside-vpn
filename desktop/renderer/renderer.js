"use strict";
const $ = (id) => document.getElementById(id);

let S = null;          // ana süreçten gelen durum: pi, profiles, browsers, countries
let selected = null;   // seçili profil kimliği
let busy = false;      // IP değiştirme / ülke uygulama sürerken
let opening = false;   // tarayıcı hazırlanırken (iptal edilebilir)
let fastBusy = false;
let lastIp = null;           // ekranda gösterilen son çıkış IP'si ({id, ip})
let sysBusy = false;   // sistem geneli mod açılırken / kapanırken
let recoveredShown = false;
let last = null;       // seçili profilin son Pi durumu (null: oturum yok, undefined: bilinmiyor)

const countryName = (cc) => ((S.countries.find((c) => c[0] === cc)) || [0, cc])[1];
const profile = () => (S && S.profiles.find((p) => p.id === selected)) || null;

function setMsg(text, ok) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = "msg" + (ok ? " ok" : "");
}

function setDot(cls) { $("dot").className = "dot " + (cls || ""); }

function renderHealth() {
  const el = $("health");
  const h = S && S.health && S.health[selected];
  $("notify").checked = !!(S && S.notify);
  if (!h) { el.className = "health"; el.textContent = "Sağlık kontrolü: tarayıcıyı ya da sistem modunu açınca her dakika izlenir."; return; }
  const t = new Date(h.ts).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  if (h.state === "ok" && h.fails > 0) { el.className = "health"; el.textContent = `Son ölçüm başarısız (${t}), tekrar denenecek.`; }
  else if (h.state === "ok") { el.className = "health good"; el.textContent = `Son kontrol ${t}: her şey yolunda${h.ip ? " (IP " + h.ip + ")" : ""}`; }
  else if (h.state === "leak") { el.className = "health bad"; el.textContent = `DİKKAT (${t}): trafik Tor'dan çıkmıyor${h.ip ? " — görünen IP " + h.ip : ""}. ${h.msg || ""}`; }
  else { el.className = "health bad"; el.textContent = `Bağlantı kopuk (${t}): ${h.msg || ""}`; }
}

function applyState(s) {
  S = s;
  if (!S.profiles.some((p) => p.id === selected)) selected = S.profiles[0] ? S.profiles[0].id : null;
  renderPi();
  renderList();
  renderDetail();
  if (S.system.recovered && !recoveredShown) {
    recoveredShown = true;
    setMsg("Önceki oturumdan kalan sistem proxy ayarı eski haline getirildi.", true);
  }
}

async function call(promise) {
  const r = await promise;
  if (!r.ok) throw new Error(r.error || "Bilinmeyen hata");
  return r;
}

// ---- Pi bağlantısı ----
function renderPi() {
  if (document.activeElement !== $("addr")) {
    $("addr").value = S.pi.host ? S.pi.host + ":" + S.pi.port : "";
  }
  $("token").placeholder = S.pi.hasToken ? "Token kayıtlı (değiştirmek için yaz)" : "Token";
  if (!S.pi.host || !S.pi.hasToken) {
    $("piMsg").textContent = "Önce Pi adresini ve token'ı gir.";
    $("piMsg").className = "msg";
  }
}

$("savePi").addEventListener("click", async () => {
  const m = $("piMsg");
  m.className = "msg"; m.textContent = "Deneniyor…";
  try {
    const r = await call(window.api.savePi($("addr").value, $("token").value));
    $("token").value = "";
    m.className = "msg ok"; m.textContent = "Bağlantı tamam, kaydedildi.";
    applyState(r.state);
    pollStatus();
  } catch (e) {
    m.className = "msg"; m.textContent = e.message;
  }
});

// ---- Profil listesi ----
function renderList() {
  const ul = $("list");
  ul.textContent = "";
  for (const p of S.profiles) {
    const li = document.createElement("li");
    if (p.id === selected) li.className = "sel";
    const d = document.createElement("span");
    d.className = "dot";
    const n = document.createElement("span");
    n.textContent = p.name + " · " + countryName(p.country);
    li.append(d, n);
    if (S.system.active && S.system.profileId === p.id) {
      const tag = document.createElement("span");
      tag.className = "sys";
      tag.textContent = "sistem";
      li.appendChild(tag);
    }
    li.addEventListener("click", () => select(p.id));
    ul.appendChild(li);
  }
}

function select(id) {
  if (id === selected) return;
  selected = id;
  last = null;
  $("ip").textContent = "";
  setMsg("");
  renderList();
  renderDetail();
  pollStatus();
}

$("add").addEventListener("click", async () => {
  try {
    const r = await call(window.api.addProfile());
    selected = r.profile.id;
    last = null;
    applyState(r.state);
    pollStatus();
  } catch (e) { setMsg(e.message); }
});

// ---- Seçili profil ----
// Ülke listesi yazısı: "Almanya (350)"; az/hiç çıkış varsa uyarı (lib/pi.js countryLabel ile aynı)
function countryLabel(code, name) {
  const counts = S && S.exits;
  if (code === "auto" || !counts) return name;
  const n = counts[code] || 0;
  if (n === 0) return `${name} (çıkış yok!)`;
  if (n < 5) return `${name} (az: ${n})`;
  return `${name} (${n})`;
}

function fillSelect(el, items, value) {
  el.textContent = "";
  for (const [v, t] of items) {
    const o = document.createElement("option");
    o.value = v; o.textContent = t;
    el.appendChild(o);
  }
  el.value = value;
}

function renderDetail() {
  const p = profile();
  $("empty").hidden = !!p;
  $("detail").hidden = !p;
  if (!p) return;

  if (document.activeElement !== $("name")) $("name").value = p.name;
  fillSelect($("country"), S.countries.map(([c, n]) => [c, countryLabel(c, n)]), p.country);

  const web = S.browsers.filter((b) => b.kind !== "discord");
  const items = [["auto", web.length ? "Otomatik (" + web[0].name + ")" : "Otomatik (tarayıcı bulunamadı)"]];
  for (const b of web) items.push([b.id, b.name]);
  for (const b of S.browsers) if (b.kind === "discord") items.push([b.id, "Discord (uygulama)"]);
  if (p.browser.startsWith("custom:")) items.push([p.browser, p.browser.slice(7).split(/[\\/]/).pop()]);
  items.push(["__pick__", "Başka tarayıcı seç…"]);
  fillSelect($("browser"), items, items.some((i) => i[0] === p.browser) ? p.browser : "auto");

  renderHealth();
  renderDirect();
  renderGood();
  renderButtons();
}

const SYS_NOTES = {
  common: [
    "Uygulama kapanınca sistem proxy'si otomatik eski haline döner; geri almak istemezsen uygulamayı açık bırak.",
    "Proxy ayarını kullanmayan programlar (bazı oyunlar, VPN ve torrent istemcileri) Tor'dan geçmez.",
    "WebRTC/UDP trafiği (görüntülü görüşme siteleri) gerçek IP'yi sızdırabilir. Hassas işler için uygulama tabanlı modu kullan.",
  ],
  win32: ["Windows'ta ayar uygulamanın yerel PAC sunucusuyla yapılır; uygulama aniden kapanırsa internet bir süre doğrudan çıkabilir, uygulamayı yeniden açınca eski ayar geri gelir."],
  darwin: ["macOS ağ ayarını değiştirmek için parola ya da Touch ID isteyebilir. Pi'a ulaşılamazsa bağlantılar kesilir, doğrudan çıkmaz."],
};

function renderSystem() {
  const p = profile();
  const card = $("sysCard");
  if (!p) return;
  const sysS = S.system;
  card.hidden = false;
  const notes = $("sysNotes");
  notes.textContent = "";
  const ksS = S.killSwitch || {};
  $("ksBox").hidden = !ksS.supported;
  $("ksOn").checked = !!ksS.wanted;
  $("ksMsg").className = ksS.error ? "msg" : "msg ok";
  $("ksMsg").textContent = ksS.error ? ksS.error : ksS.active ? "Aktif: Tor/Pi dışındaki tüm bağlantılar engelleniyor." : ksS.wanted ? "Sistem modu açılınca devreye girer." : "";
  if (!sysS.supported) {
    $("sysState").textContent = "Sistem geneli mod bu işletim sisteminde desteklenmiyor (Windows ve macOS).";
    $("sysBtn").hidden = true;
    $("sysTag").hidden = true;
    return;
  }
  $("sysBtn").hidden = false;
  const on = sysS.active && sysS.profileId === p.id;
  const other = sysS.active && !on ? S.profiles.find((x) => x.id === sysS.profileId) : null;
  $("sysTag").hidden = !on;
  if (sysBusy) {
    $("sysState").textContent = "Hazırlanıyor…";
  } else if (on) {
    $("sysState").textContent = "Açık: bu bilgisayarın trafiği bu profilin Tor'undan çıkıyor.";
  } else if (other) {
    $("sysState").textContent = `Şu an "${other.name}" profiline bağlı. Buraya geçirirsen oradaki bağlantı kapanır.`;
  } else {
    $("sysState").textContent = "Kapalı. Bilgisayar normal bağlantısını kullanıyor.";
  }
  for (const line of SYS_NOTES.common.concat(SYS_NOTES[S.platform] || [])) {
    const li = document.createElement("li");
    li.textContent = line;
    notes.appendChild(li);
  }
  $("sysBtn").textContent = sysBusy ? "İptal" : on ? "Sistem proxy'sini kapat" : other ? "Sistemi bu profile geçir" : "Sistemi bu profile bağla";
  $("sysBtn").className = "big " + (on || sysBusy ? "danger" : "sec");
  $("sysBtn").disabled = busy || opening;
  $("sysTest").hidden = !on;
}

function renderButtons() {
  const isDiscord = (profile() || {}).browser === "discord";
  $("open").textContent = opening ? "İptal" : isDiscord ? "Discord'u aç" : "Tarayıcıyı aç";
  $("appNote").hidden = !isDiscord;
  $("open").className = "big" + (opening ? " sec" : "");
  $("open").disabled = busy || sysBusy;
  $("newip").disabled = busy || opening || sysBusy || fastBusy || !(last && last.ready);
  $("fastBtn").disabled = !fastBusy && (busy || opening || sysBusy || !(last && last.ready));
  $("fastBtn").textContent = fastBusy ? "İptal" : "En hızlı IP'yi bul";
  $("country").disabled = busy || opening || sysBusy;
  renderSystem();
}

function renderStatus() {
  if (opening) return;
  if (last === undefined) return;
  if (last === null) {
    setDot("");
    $("state").textContent = "Pi'da bu profil için Tor yok. Tarayıcıyı açınca kurulur.";
  } else if (last.ready) {
    setDot("on");
    $("state").textContent = "Pi'da Tor hazır • " + countryName(last.country);
  } else {
    setDot("wait");
    $("state").textContent = "Pi'da Tor bağlanıyor… %" + (last.bootstrap || 0) + (last.summary ? " (" + last.summary + ")" : "");
  }
  renderButtons();
}

let piDown = false;

async function pollStatus() {
  const id = selected;
  if (!id || busy || opening || sysBusy) return;
  if (!S.pi.host || !S.pi.hasToken) {
    last = undefined;
    setDot("");
    $("state").textContent = "Önce soldan Pi adresini ve token'ı kaydet.";
    renderButtons();
    return;
  }
  const r = await window.api.status(id);
  if (id !== selected || busy || opening || sysBusy) return;
  if (!r.ok) {
    last = undefined;
    piDown = true;
    setDot("err");
    $("state").textContent = "Pi'a ulaşılamıyor.";
    setMsg(r.error);
    renderButtons();
    return;
  }
  if (piDown) { piDown = false; setMsg(""); }
  last = r.status;
  renderStatus();
}

async function showIp() {
  const id = selected;
  $("ip").textContent = "IP sorgulanıyor…";
  const r = await window.api.checkIp(id);
  if (id !== selected) return;
  if (!r.ok) { $("ip").textContent = ""; setMsg(r.error); return; }
  $("ip").textContent = "IP: " + r.ip + (r.isTor === false ? " (Tor değil!)" : "");
  if (r.isTor !== false && r.ip) { lastIp = { id, ip: r.ip }; renderGood(); }
}

// ---- Kayıtlı iyi çıkışlar ----
function renderGood() {
  const p = profile();
  const list = $("goodList");
  list.textContent = "";
  const items = p ? (p.goodExits || []) : [];
  $("goodEmpty").hidden = items.length > 0;
  for (const g of items) {
    const li = document.createElement("li");
    const ip = document.createElement("span"); ip.className = "gip"; ip.textContent = g.ip;
    const ms = document.createElement("span"); ms.className = "gms"; ms.textContent = g.ms ? g.ms + " ms" : "—";
    const use = document.createElement("button"); use.className = "sec"; use.textContent = "Bu IP'ye geç"; use.dataset.act = "use"; use.dataset.ip = g.ip;
    const del = document.createElement("button"); del.className = "sec"; del.textContent = "Sil"; del.dataset.act = "del"; del.dataset.ip = g.ip;
    use.disabled = !(last && last.ready) || fastBusy || sysBusy || opening;
    li.append(ip, ms, use, del);
    list.appendChild(li);
  }
  const canSave = !!(p && lastIp && lastIp.id === p.id && !items.some((g) => g.ip === lastIp.ip));
  $("saveCurrent").disabled = !canSave;
  $("saveCurrent").textContent = canSave ? `Şu anki IP'yi kaydet (${lastIp.ip})` : "Şu anki IP'yi kaydet (önce 'Çıkış IP'sini göster')";
}

$("goodList").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  const p = profile();
  if (!b || !p) return;
  const ip = b.dataset.ip;
  try {
    if (b.dataset.act === "del") {
      applyState((await call(window.api.removeExit(p.id, ip))).state);
    } else if (b.dataset.act === "use") {
      b.disabled = true; setMsg("Çıkışa geçiliyor…");
      applyState((await call(window.api.useExit(p.id, ip))).state);
      lastIp = { id: p.id, ip };
      $("ip").textContent = "Çıkış IP: " + ip;
      setMsg("Çıkış " + ip + " olarak sabitlendi. 'IP Değiştir' ile sabitlemeyi bırakırsın.", true);
    }
  } catch (err) { setMsg(err.message); renderGood(); }
});

$("saveCurrent").addEventListener("click", async () => {
  const p = profile();
  if (!p || !lastIp || lastIp.id !== p.id) return;
  try { applyState((await call(window.api.saveExit(p.id, { ip: lastIp.ip, ms: null }))).state); setMsg("IP kaydedildi.", true); }
  catch (err) { setMsg(err.message); }
});

// ---- Doğrudan çıkan siteler ----
function renderDirect() {
  const d = S && S.direct;
  if (!d) return;
  $("directOn").checked = d.on;
  if (document.activeElement !== $("directList")) $("directList").value = d.list.join("\n");
}
async function saveDirect(on, list) {
  const m = $("directMsg");
  try {
    applyState((await call(window.api.setDirect(on, list))).state);
    m.className = "msg ok"; m.textContent = `Kaydedildi (${S.direct.list.length} site).`;
  } catch (e) { m.className = "msg"; m.textContent = e.message; }
}
$("directSave").addEventListener("click", () => saveDirect($("directOn").checked, $("directList").value));
$("directOn").addEventListener("change", () => saveDirect($("directOn").checked, $("directList").value));
$("directReset").addEventListener("click", () => saveDirect(true, S.direct.defaults.join("\n")));

// ---- Düğmeler ----
$("name").addEventListener("change", async () => {
  try { applyState((await call(window.api.updateProfile(selected, { name: $("name").value }))).state); }
  catch (e) { setMsg(e.message); }
});

$("browser").addEventListener("change", async () => {
  let v = $("browser").value;
  try {
    if (v === "__pick__") {
      const r = await call(window.api.pickBrowser());
      if (!r.path) { renderDetail(); return; }
      v = "custom:" + r.path;
    }
    applyState((await call(window.api.updateProfile(selected, { browser: v }))).state);
  } catch (e) { setMsg(e.message); renderDetail(); }
});

$("country").addEventListener("change", async () => {
  const id = selected;
  busy = true; renderButtons(); setMsg("Ülke değiştiriliyor…");
  try {
    await call(window.api.setCountry(id, $("country").value));
    setMsg("");
    const s = await call(window.api.state());
    applyState(s.state);
  } catch (e) { setMsg(e.message); }
  busy = false;
  renderButtons();
  await pollStatus();
  if (last && last.ready) showIp();
});

$("open").addEventListener("click", async () => {
  const id = selected;
  if (opening) { window.api.cancel(id); return; }
  opening = true; setMsg(""); $("ip").textContent = ""; setDot("wait");
  $("state").textContent = "Pi'da Tor hazırlanıyor…";
  renderButtons();
  try {
    const r = await call(window.api.openBrowser(id));
    opening = false;
    if (r.cancelled) setMsg("İptal edildi. Pi'daki Tor arka planda bağlanmaya devam eder.");
    else setMsg(r.browser + " açıldı.", true);
  } catch (e) {
    opening = false;
    setMsg(e.message);
  }
  renderButtons();
  await pollStatus();
  if (last && last.ready && id === selected) showIp();
});

$("newip").addEventListener("click", async () => {
  const id = selected;
  busy = true; renderButtons(); setMsg("IP değiştiriliyor…"); $("ip").textContent = "";
  try {
    await call(window.api.newnym(id));
    setMsg("");
  } catch (e) { setMsg(e.message); }
  busy = false;
  renderButtons();
  await pollStatus();
  if (last && last.ready && id === selected) showIp();
});

$("showip").addEventListener("click", () => showIp());

// Sistem proxy'sinin gerçekten uygulandığını kontrol et ve sonucu açıkça göster
async function testSystem() {
  const el = $("sysResult");
  el.className = "msg"; el.textContent = "Sistem bağlantısı test ediliyor…";
  try {
    const t = (await call(window.api.sysTest())).test;
    const where = String(t.resolved || "");
    if (t.error) {
      el.textContent = `Test başarısız (${t.error}).\nSistemin proxy'si: ${where || "yok"}\n` +
        (/SOCKS/i.test(where) ? "Proxy ayarlanmış ama bağlantı kurulamadı: Pi'ın SOCKS portuna bu bilgisayardan ulaşılabiliyor mu?" : "Sistem proxy'si ayarı bu uygulamaya yansımamış.");
    } else if (t.isTor) {
      el.className = "msg ok"; el.textContent = `Çalışıyor: sistem trafiği Tor'dan çıkıyor (IP ${t.ip}).\nAçık tarayıcıda sayfayı yenile; olmazsa tarayıcıyı kapatıp aç.`;
    } else {
      el.textContent = `Sistem trafiği Tor'dan ÇIKMIYOR (görünen IP ${t.ip}).\nSistemin proxy'si: ${where || "DIRECT"}`;
    }
  } catch (e) { el.textContent = "Test yapılamadı: " + e.message; }
}
window.api.onFast((d) => { if (d.id === selected && fastBusy) $("fastMsg").textContent = d.message; });
$("fastBtn").addEventListener("click", async () => {
  const p = profile();
  if (!p) return;
  if (fastBusy) { window.api.cancel(p.id); return; }
  fastBusy = true; $("fastMsg").className = "msg"; $("fastMsg").textContent = "Başlıyor…"; renderButtons();
  try {
    const resp = await call(window.api.fastRun(p.id, { targetMs: $("fastTarget").value, attempts: $("fastTries").value }));
    const r = resp.result;
    if (resp.state) applyState(resp.state);
    if (r.current && r.current.ip) lastIp = { id: p.id, ip: r.current.ip };
    const el = $("fastMsg");
    if (r.cancelled) el.textContent = "İptal edildi.";
    else if (r.error) el.textContent = r.error;
    else if (r.reached) { el.className = "msg ok"; el.textContent = `Hedefe ulaşıldı: ${r.best.ip} — ${r.best.ms} ms (${r.tried.length} denemede).`; }
    else if (r.pinned) { el.className = "msg ok"; el.textContent = `Hedef (${$("fastTarget").value} ms) tutmadı; en iyisi seçildi ve sabitlendi: ${r.best.ip} — ${r.best.ms} ms.\nİstediğin zaman "IP Değiştir" ile sabitlemeyi bırakırsın.`; }
    else if (r.pinFailed) el.textContent = `Hedef tutmadı. En iyisi ${r.best.ip} (${r.best.ms} ms) idi ama o röleye dönülemedi${r.pinError ? " (" + r.pinError + ")" : ""}. Pi'daki torpool'u güncellediysen tekrar dene.`;
    else el.textContent = `Hedef tutmadı; mevcut IP zaten en iyisi: ${r.best.ip} — ${r.best.ms} ms.`;
    $("ip").textContent = r.current && r.current.ip ? `Çıkış IP: ${r.current.ip}` : $("ip").textContent;
  } catch (e) { $("fastMsg").textContent = e.message; }
  fastBusy = false; renderButtons(); pollStatus();
});
$("sysTest").addEventListener("click", testSystem);
$("ksOn").addEventListener("change", async () => {
  const want = $("ksOn").checked;
  $("ksOn").disabled = true;
  $("ksMsg").className = "msg"; $("ksMsg").textContent = want ? "İzin penceresi açılabilir…" : "Kapatılıyor…";
  try { applyState((await call(window.api.setKillSwitch(want))).state); }
  catch (e) { $("ksMsg").textContent = e.message; }
  $("ksOn").disabled = false;
});
window.api.onHealth((d) => { if (S) { S.health = S.health || {}; S.health[d.id] = d.health; if (d.id === selected) renderHealth(); } });
$("notify").addEventListener("change", async () => { try { applyState((await call(window.api.setNotify($("notify").checked))).state); } catch (e) { setMsg(e.message); } });
$("checkNow").addEventListener("click", async () => {
  const p = profile(); if (!p) return;
  $("checkNow").disabled = true; $("health").className = "health"; $("health").textContent = "Kontrol ediliyor…";
  try { const r = await call(window.api.healthCheck(p.id)); S.health = S.health || {}; if (r.health) S.health[p.id] = r.health; } catch (e) { setMsg(e.message); }
  $("checkNow").disabled = false; renderHealth();
});

$("sysBtn").addEventListener("click", async () => {
  const p = profile();
  if (!p) return;
  if (sysBusy) { window.api.cancel(p.id); return; }   // hazırlanırken iptal
  const on = S.system.active && S.system.profileId === p.id;
  setMsg("");
  try {
    if (on) {
      sysBusy = true; renderButtons();
      applyState((await call(window.api.sysDisable())).state);
      setMsg("Sistem proxy'si kapatıldı, bilgisayar normal bağlantısına döndü.", true);
      $("sysResult").textContent = "";
    } else {
      sysBusy = true; setDot("wait"); $("state").textContent = "Pi'da Tor hazırlanıyor…"; renderButtons();
      const r = await call(window.api.sysEnable(p.id));
      if (r.cancelled) setMsg("İptal edildi. Pi'daki Tor arka planda bağlanmaya devam eder.");
      else { applyState(r.state); setMsg("Sistem geneli mod açıldı.", true); testSystem(); }
    }
  } catch (e) {
    setMsg(e.message);
    try { applyState((await call(window.api.state())).state); } catch (_) { /* durum alınamadı */ }
  }
  sysBusy = false;
  renderButtons();
  await pollStatus();
  if (last && last.ready && S.system.active && S.system.profileId === p.id && p.id === selected) showIp();
});

$("del").addEventListener("click", async () => {
  const p = profile();
  if (!p) return;
  if (!window.confirm(`"${p.name}" profili silinsin mi?\nPi'daki Tor oturumu ve bu profilin tarayıcı verisi (çerezler, geçmiş) de silinir.`)) return;
  try {
    applyState((await call(window.api.removeProfile(p.id, true))).state);
    last = null;
    pollStatus();
  } catch (e) { setMsg(e.message); }
});

window.api.onProgress((d) => {
  if (d.id !== selected || !(opening || sysBusy)) return;
  setDot("wait");
  $("state").textContent = "Pi'da Tor bağlanıyor… %" + d.bootstrap + (d.summary ? " (" + d.summary + ")" : "");
});

(async function init() {
  const r = await window.api.state();
  applyState(r.state);
  window.api.refreshExits().then((x) => { if (x && x.ok) applyState(x.state); }).catch(() => {});
  pollStatus();
  setInterval(() => { if (document.visibilityState === "visible") pollStatus(); }, 3000);
})();
