"use strict";
// Sistem geneli proxy: işletim sisteminin proxy ayarını bir Pi oturumuna (SOCKS5) yönlendirir.
//  - Windows: HKCU Internet Settings -> AutoConfigURL (uygulamanın yerel PAC sunucusu) ; önceki değerler yedeklenir
//  - macOS:   networksetup ile her ağ servisinin SOCKS proxy'si ; önceki ayarlar yedeklenir
// Yedek diske yazılır: uygulama çökerse bir sonraki açılışta ayarlar eski haline getirilir.
const { execFile } = require("child_process");
const { startPacServer, HOST_RE } = require("./pac");
const { macBypass } = require("./sites");

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const WIN_VALUES = ["AutoConfigURL", "ProxyEnable", "ProxyServer", "ProxyOverride"];
const MAC_BYPASS = ["127.0.0.1", "localhost", "*.local", "169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// Küçük kalıcı depo: { load(), save(obj), clear() }
function createSysProxy(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const run = o.run || defaultRun;
  const pacStarter = o.startPacServer || startPacServer;
  const store = o.store;
  const supported = platform === "win32" || platform === "darwin";
  let state = { active: false, pac: null, host: "", port: 0 };

  const must = async (cmd, args, what) => {
    const r = await run(cmd, args);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || "").trim().split("\n")[0];
      throw new Error(`${what} başarısız oldu${detail ? ": " + detail : "."}`);
    }
    return r;
  };

  // ---------------- Windows ----------------
  async function winRead(name) {
    const r = await run("reg", ["query", REG_KEY, "/v", name]);
    if (r.code !== 0) return null;
    const m = new RegExp("^\\s+" + name + "\\s+(REG_\\w+)\\s+(.*?)\\s*$", "m").exec(r.stdout);
    return m ? { type: m[1], data: m[2] } : null;
  }

  async function winBackup() {
    const win = {};
    for (const n of WIN_VALUES) win[n] = await winRead(n);
    return { platform: "win32", win };
  }

  async function winNotify() {
    // Açık programlara proxy ayarının değiştiğini bildir (olmazsa ayar bir sonraki bağlantıda anlaşılmaz)
    const script =
      "$s='[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);';" +
      "$t=Add-Type -MemberDefinition $s -Name W -Namespace N -PassThru;" +
      "$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null;" +
      "$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null";
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
  }

  async function winApply(pacUrl) {
    await must("reg", ["add", REG_KEY, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", pacUrl, "/f"], "Proxy ayarı (AutoConfigURL) yazma");
    // Elle girilmiş bir proxy varsa PAC ile çakışmasın: geçici olarak kapat (yedekten geri gelir)
    await must("reg", ["add", REG_KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"], "Proxy ayarı (ProxyEnable) yazma");
    await winNotify();
  }

  async function winRestore(backup) {
    const errs = [];
    for (const n of WIN_VALUES) {
      const v = backup.win && backup.win[n];
      const r = v
        ? await run("reg", ["add", REG_KEY, "/v", n, "/t", v.type, "/d", v.data, "/f"])
        : await run("reg", ["delete", REG_KEY, "/v", n, "/f"]);
      // Değer zaten yoksa silme hatası önemsiz
      if (v && r.code !== 0) errs.push(n);
    }
    await winNotify();
    if (errs.length) throw new Error("Eski proxy ayarı geri yüklenemedi: " + errs.join(", "));
  }

  // ---------------- macOS ----------------
  async function macServices() {
    const r = await must("networksetup", ["-listallnetworkservices"], "Ağ servisleri listesi");
    return r.stdout.split("\n").slice(1).map((s) => s.trim()).filter((s) => s && !s.startsWith("*"));
  }

  async function macBackup() {
    const mac = {};
    for (const svc of await macServices()) {
      const sk = await run("networksetup", ["-getsocksfirewallproxy", svc]);
      const g = (k) => { const m = new RegExp("^" + k + ":\\s*(.*)$", "mi").exec(sk.stdout); return m ? m[1].trim() : ""; };
      const bp = await run("networksetup", ["-getproxybypassdomains", svc]);
      const list = /There aren't any/i.test(bp.stdout) ? [] : bp.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      mac[svc] = { enabled: /^yes$/i.test(g("Enabled")), server: g("Server"), port: parseInt(g("Port"), 10) || 0, bypass: list };
    }
    return { platform: "darwin", mac };
  }

  async function macApply(host, port, services, direct) {
    const bypass = Array.from(new Set(MAC_BYPASS.concat([host], macBypass(direct))));
    for (const svc of services) {
      await must("networksetup", ["-setsocksfirewallproxy", svc, host, String(port), "off"], `"${svc}" için SOCKS proxy ayarı`);
      await must("networksetup", ["-setsocksfirewallproxystate", svc, "on"], `"${svc}" için SOCKS proxy'yi açma`);
      await must("networksetup", ["-setproxybypassdomains", svc].concat(bypass), `"${svc}" için istisna listesi`);
    }
  }

  async function macRestore(backup) {
    const errs = [];
    for (const [svc, s] of Object.entries(backup.mac || {})) {
      if (s.server && s.port) {
        const r = await run("networksetup", ["-setsocksfirewallproxy", svc, s.server, String(s.port), "off"]);
        if (r.code !== 0) errs.push(svc);
      }
      const st = await run("networksetup", ["-setsocksfirewallproxystate", svc, s.enabled ? "on" : "off"]);
      if (st.code !== 0) errs.push(svc);
      const bp = await run("networksetup", ["-setproxybypassdomains", svc].concat(s.bypass && s.bypass.length ? s.bypass : ["Empty"]));
      if (bp.code !== 0) errs.push(svc);
    }
    if (errs.length) throw new Error("Eski proxy ayarı geri yüklenemedi: " + Array.from(new Set(errs)).join(", "));
  }

  // ---------------- ortak ----------------
  async function restoreFrom(backup) {
    if (backup.platform === "win32") await winRestore(backup);
    else if (backup.platform === "darwin") await macRestore(backup);
  }

  async function closePac() {
    if (state.pac) { try { await state.pac.close(); } catch (_) { /* kapanmış olabilir */ } }
    state.pac = null;
  }

  return {
    supported,
    active: () => state.active,

    async enable(host, port, direct) {
      if (!supported) throw new Error("Sistem geneli mod bu işletim sisteminde desteklenmiyor.");
      if (!HOST_RE.test(String(host))) throw new Error("Geçersiz Pi adresi.");
      if (!Number.isInteger(port)) throw new Error("Geçersiz port.");

      let backup = state.active ? await store.load() : null;
      if (!backup) {
        const stale = await store.load(); // önceki çalışmadan kalmış yedek: önce onu geri yükle
        if (stale) { await restoreFrom(stale); await store.clear(); }
        backup = platform === "win32" ? await winBackup() : await macBackup();
        await store.save(backup); // ayar değişmeden ÖNCE yaz: çökerse geri alınabilsin
      }

      try {
        if (platform === "win32") {
          await closePac();
          state.pac = await pacStarter(host, port, direct || []);
          await winApply(state.pac.url);
        } else {
          await macApply(host, port, Object.keys(backup.mac), direct || []);
        }
      } catch (e) {
        try { await restoreFrom(backup); await store.clear(); } catch (_) { /* en azından hatayı göster */ }
        await closePac();
        state.active = false;
        throw e;
      }
      state.active = true;
      state.host = host; state.port = port;
    },

    // Çalışırken doğrudan çıkan siteler değişirse uygula (Windows: PAC anında güncellenir; Mac: istisna listesi yeniden yazılır)
    async setDirect(direct) {
      if (!state.active) return;
      if (platform === "win32") { if (state.pac && state.pac.update) state.pac.update(direct || []); return; }
      const backup = await store.load();
      if (backup && backup.mac) await macApply(state.host, state.port, Object.keys(backup.mac), direct || []);
    },

    async disable() {
      const backup = await store.load();
      let err = null;
      if (backup) {
        try { await restoreFrom(backup); await store.clear(); } catch (e) { err = e; }
      }
      await closePac();
      state.active = false;
      if (err) throw err;
    },

    // Uygulama açılırken: önceki oturumdan kalmış sistem proxy ayarı varsa eski haline getir
    async recover() {
      const backup = await store.load();
      if (!backup) return false;
      await restoreFrom(backup);
      await store.clear();
      return true;
    },
  };
}

module.exports = { createSysProxy, REG_KEY, WIN_VALUES, MAC_BYPASS };
