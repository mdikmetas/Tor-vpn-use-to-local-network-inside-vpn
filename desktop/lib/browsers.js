"use strict";
// Tarayıcıyı, profile özel veri klasörü ve Pi'daki Tor'a (SOCKS5) bağlı proxy ayarıyla başlatır.
// Sistem proxy'sine dokunmaz: proxy yalnızca bu profilin tarayıcısı için geçerlidir,
// Pi'a ulaşılamazsa tarayıcı doğrudan çıkmaz (bağlantı başarısız olur).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromiumBypass, firefoxBypass } = require("./sites");

// Yerel ağ doğrudan gider (router, NAS, Pi'in kendisi); eklentideki liste ile aynı
const BYPASS = ["localhost", "127.0.0.1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];

// Windows'ta Discord, %LOCALAPPDATA%\\Discord\\app-<sürüm>\\Discord.exe altına kurulur: en yeni sürümü seç
function discordWin(root, readdir, J) {
  let dirs = [];
  try { dirs = readdir(root).filter((d) => /^app-\d+(\.\d+)*$/.test(d)); } catch (_) { return []; }
  const ver = (d) => d.slice(4).split(".").map(Number);
  dirs.sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; } return 0; });
  return dirs.map((d) => J(root, d, "Discord.exe"));
}

function knownBrowsers(platform, env, home, readdir) {
  const out = [];
  const add = (id, name, kind, paths) => out.push({ id, name, kind, paths });
  if (platform === "win32") {
    const J = path.win32.join;
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const la = env.LOCALAPPDATA || J(home, "AppData", "Local");
    const all = (rel) => [pf, pf86, la].map((b) => J(b, rel));
    add("chrome", "Google Chrome", "chromium", all("Google\\Chrome\\Application\\chrome.exe"));
    add("edge", "Microsoft Edge", "chromium", all("Microsoft\\Edge\\Application\\msedge.exe"));
    add("brave", "Brave", "chromium", all("BraveSoftware\\Brave-Browser\\Application\\brave.exe"));
    add("firefox", "Mozilla Firefox", "firefox", all("Mozilla Firefox\\firefox.exe"));
    add("discord", "Discord", "discord", discordWin(J(la, "Discord"), readdir, J));
  } else if (platform === "darwin") {
    const J = path.posix.join;
    const apps = ["/Applications", J(home, "Applications")];
    const app = (n, bin) => apps.map((a) => J(a, n + ".app", "Contents", "MacOS", bin));
    add("chrome", "Google Chrome", "chromium", app("Google Chrome", "Google Chrome"));
    add("edge", "Microsoft Edge", "chromium", app("Microsoft Edge", "Microsoft Edge"));
    add("brave", "Brave", "chromium", app("Brave Browser", "Brave Browser"));
    add("firefox", "Mozilla Firefox", "firefox", app("Firefox", "firefox"));
    add("discord", "Discord", "discord", app("Discord", "Discord"));
  } else {
    add("chrome", "Google Chrome", "chromium", [
      "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
      "/usr/bin/chromium-browser", "/snap/bin/chromium",
    ]);
    add("edge", "Microsoft Edge", "chromium", ["/usr/bin/microsoft-edge"]);
    add("brave", "Brave", "chromium", ["/usr/bin/brave-browser"]);
    add("firefox", "Mozilla Firefox", "firefox", ["/usr/bin/firefox", "/snap/bin/firefox"]);
    add("discord", "Discord", "discord", ["/usr/bin/discord", "/usr/share/discord/Discord", "/opt/discord/Discord", "/var/lib/flatpak/exports/bin/com.discordapp.Discord"]);
  }
  return out;
}

// Bilgisayarda kurulu tarayıcıları bul: [{id, name, kind, path}]
function detect(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const exists = o.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const found = [];
  const readdir = o.readdir || ((d) => fs.readdirSync(d));
  for (const b of knownBrowsers(platform, env, home, readdir)) {
    const p = b.paths.find((x) => exists(x));
    if (p) found.push({ id: b.id, name: b.name, kind: b.kind, path: p });
  }
  return found;
}

// Profildeki tarayıcı seçimini çöz: "auto" | bulunan id | "custom:<yol>"
function resolveBrowser(found, value, exists) {
  const ex = exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const v = value || "auto";
  if (v === "auto") return found.find((b) => b.kind !== "discord") || null;
  if (v.startsWith("custom:")) {
    const p = v.slice(7);
    if (!p || !ex(p)) return null;
    const base = path.basename(p).replace(/\.exe$/i, "");
    return { id: "custom", name: base, kind: /firefox/i.test(base) ? "firefox" : "chromium", path: p };
  }
  return found.find((b) => b.id === v) || null;
}

function firefoxUserJs(host, port, direct) {
  const s = (x) => JSON.stringify(String(x));
  const prefs = [
    ["network.proxy.type", 1],
    ["network.proxy.socks", s(host)],
    ["network.proxy.socks_port", port],
    ["network.proxy.socks_version", 5],
    ["network.proxy.socks_remote_dns", true],       // DNS de Tor üzerinden çözülür
    ["network.proxy.failover_direct", false],       // Pi'a ulaşılamazsa doğrudan çıkma
    ["network.proxy.no_proxies_on", s(BYPASS.concat(firefoxBypass(direct)).join(", "))],
    ["network.trr.mode", 5],                        // DNS-over-HTTPS kapalı (proxy'yi atlamasın)
    ["media.peerconnection.enabled", false],        // WebRTC gerçek IP'yi sızdırmasın
    ["browser.shell.checkDefaultBrowser", false],
    ["browser.startup.page", 0],
  ];
  return prefs.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${v});`).join("\n") + "\n";
}

// Başlatma komutunu hazırla (Firefox için profil klasörüne user.js yazar)
function buildLaunch(opts) {
  const { kind, exe, dataDir, host, port } = opts;
  const direct = opts.direct || [];
  fs.mkdirSync(dataDir, { recursive: true });
  if (kind === "firefox") {
    fs.writeFileSync(path.join(dataDir, "user.js"), firefoxUserJs(host, port, direct));
    return { exe, args: ["-no-remote", "-profile", dataDir] };
  }
  const bypass = Array.from(new Set(BYPASS.concat([host], chromiumBypass(direct))));
  if (kind === "discord") {
    // Discord bir Electron uygulamasıdır: sohbet/giriş trafiği SOCKS5 ile Tor'dan çıkar.
    // Ayrı --user-data-dir ile ayrı oturum açar ve normal Discord'un yanında çalışabilir.
    return {
      exe,
      args: [
        "--user-data-dir=" + dataDir,
        `--proxy-server=socks5://${host}:${port}`,
        "--proxy-bypass-list=" + bypass.join(";"),
        "--disable-quic",
      ],
    };
  }
  return {
    exe,
    args: [
      "--user-data-dir=" + dataDir,
      `--proxy-server=socks5://${host}:${port}`,
      "--proxy-bypass-list=" + bypass.join(";"),
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-quic",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
}

function launch(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(child.pid); });
  });
}

module.exports = { detect, resolveBrowser, buildLaunch, launch, firefoxUserJs, BYPASS };
