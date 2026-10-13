"use strict";
// Pi adresi bir Tailscale adresiyse (100.64.0.0/10) bağlanmadan önce Tailscale'in açık olduğundan emin ol.
// Kapalıysa "tailscale up" ile açmayı dener. Kapatmaz (Tailscale'i başka işler için de kullanıyor olabilirsin).
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function isTailscaleAddr(host) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(host || ""));
  if (!m) return /\.ts\.net$/i.test(String(host || ""));
  const a = +m[1], b = +m[2];
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10
}

function cliCandidates(platform, env) {
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    return [path.win32.join(pf, "Tailscale", "tailscale.exe")];
  }
  if (platform === "darwin") {
    return ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];
  }
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];
}

function defaultRun(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeout || 15000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// Dönüş: { state: "up" | "started" | "missing" | "login" | "failed", message? }
async function ensureUp(o) {
  const opt = o || {};
  const platform = opt.platform || process.platform;
  const exists = opt.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const run = opt.run || defaultRun;
  const sleep = opt.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cli = cliCandidates(platform, opt.env || process.env).find(exists) || (platform === "linux" ? "tailscale" : null);
  if (!cli) return { state: "missing", message: "Pi adresi bir Tailscale adresi ama bu bilgisayarda Tailscale kurulu görünmüyor. tailscale.com/download adresinden kur ve giriş yap." };

  const status = async () => {
    const r = await run(cli, ["status", "--json"]);
    if (r.code !== 0 && !r.stdout) return { backend: "Unknown", raw: r };
    try { return { backend: JSON.parse(r.stdout).BackendState || "Unknown" }; } catch (_) { return { backend: "Unknown", raw: r }; }
  };

  let s = await status();
  if (s.backend === "Running") return { state: "up" };
  if (s.backend === "NeedsLogin") return { state: "login", message: "Tailscale'de oturum açık değil. Tailscale uygulamasını açıp giriş yap." };
  if (s.backend === "Unknown" && platform !== "linux" && s.raw && /connect|pipe|socket|not running|isn't running/i.test(s.raw.stderr + s.raw.stdout)) {
    return { state: "failed", message: "Tailscale çalışmıyor. Tailscale uygulamasını başlat." };
  }

  // Kapalı (Stopped/Starting): açmayı dene
  const up = await run(cli, ["up"], 20000);
  for (let i = 0; i < 10; i++) {
    s = await status();
    if (s.backend === "Running") return { state: "started" };
    if (s.backend === "NeedsLogin") return { state: "login", message: "Tailscale'de oturum açık değil. Tailscale uygulamasını açıp giriş yap." };
    await sleep(1000);
  }
  const why = (up.stderr || up.stdout || "").trim().split("\n")[0];
  return { state: "failed", message: "Tailscale açılamadı" + (why ? ": " + why : ".") + " Tailscale uygulamasından elle bağlan." };
}

module.exports = { isTailscaleAddr, ensureUp, cliCandidates };
