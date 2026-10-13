"use strict";
// Kill switch (isteğe bağlı): sistem modu açıkken Tor/Pi dışına giden her bağlantıyı güvenlik duvarıyla keser.
// Böylece proxy ayarını yok sayan uygulamalar ya da kopan Tor, gerçek IP'yi sızdıramaz.
//  - Windows: netsh ile "engelle" kuralları. Windows'ta engelleme izne baskın gelir, bu yüzden izinli adresler
//    çıkarılır ve KALAN IPv4 aralıkları engellenir (yerel ağ, loopback, Pi serbest). IPv6 genel adresleri engellenir.
//  - macOS: pf, "com.apple/torip" anchor'ı; izinli adresler bir tabloda, gerisi engelli.
// Yönetici izni gerekir (Windows UAC, macOS şifre penceresi). Kurallar kapatınca/çıkışta/çökme sonrası kaldırılır.
// Pi bir Tailscale adresindeyse kullanılamaz: Tailscale'in kendi taşıyıcı bağlantısını da keserdi.
const { execFile } = require("child_process");

const RULE_V4 = "TorIP-KS-v4";
const RULE_V6 = "TorIP-KS-v6";
const PF_ANCHOR = "com.apple/torip";

// Her zaman serbest: loopback, 0/8 (DHCP), özel ağlar, link-local, multicast+broadcast
const ALWAYS_ALLOWED = [
  "0.0.0.0/8", "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4",
];

const IP4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const toNum = (ip) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const toIp = (n) => [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join(".");

function cidrRange(c) {
  const [ip, bitsRaw] = c.split("/");
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!IP4_RE.test(ip) || !Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error("Geçersiz ağ: " + c);
  const size = Math.pow(2, 32 - bits);
  const start = Math.floor(toNum(ip) / size) * size;
  return [start, start + size - 1];
}

// İzinli CIDR'ların tümleyeni: engellenecek IPv4 aralıkları ["a.b.c.d-e.f.g.h", ...]
function blockRanges(allowed) {
  const rs = allowed.map(cidrRange).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of rs) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out = [];
  let next = 0;
  for (const [s, e] of merged) {
    if (s > next) out.push([next, s - 1]);
    next = e + 1;
  }
  if (next <= 4294967295) out.push([next, 4294967295]);
  return out.map(([s, e]) => toIp(s) + "-" + toIp(e));
}

function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 120000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// AppleScript metin sabitine gömmek için
const asQuote = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function createKillSwitch(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const run = o.run || defaultRun;
  const store = o.store;
  const supported = platform === "win32" || platform === "darwin";
  let on = false;

  // Windows: tek UAC isteğiyle yükseltilmiş komut (cmd /c "a && b"); çıkış kodu geri döner
  async function winElevated(cmdline) {
    const ps = `$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','${cmdline.replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps]);
  }

  async function macAdmin(shellCmd) {
    return run("osascript", ["-e", `do shell script "${asQuote(shellCmd)}" with administrator privileges`]);
  }

  function pfRules(piIp) {
    const ok = ALWAYS_ALLOWED.concat([piIp + "/32"]).filter((c) => !c.startsWith("0.0.0.0/8") && !c.startsWith("240."));
    return [
      `table <torip_ok> const { ${ok.join(", ")}, 255.255.255.255 }`,
      "table <torip_ok6> const { fe80::/10, fc00::/7, ff00::/8, ::1 }",
      "pass out quick on lo0 all",
      "pass out quick inet from any to <torip_ok>",
      "pass out quick inet proto udp from any port 68 to any port 67",
      "block drop out quick inet all",
      "pass out quick inet6 from any to <torip_ok6>",
      "block drop out quick inet6 all",
    ];
  }

  async function removeRules(saved) {
    if (platform === "win32") {
      const r = await winElevated(`netsh advfirewall firewall delete rule name=${RULE_V4} & netsh advfirewall firewall delete rule name=${RULE_V6}`);
      // Kural yoksa silme hatası önemsiz; yönetici izni verilmediyse (UAC reddi) hata say
      if (r.code !== 0 && /elevat|denied|cancel|reddedil|iptal|1223/i.test(r.stderr + r.stdout)) throw new Error("Güvenlik duvarı kuralları kaldırılamadı (yönetici izni verilmedi).");
      return r;
    }
    const tok = saved && saved.token ? ` ; /sbin/pfctl -X ${String(saved.token).replace(/[^0-9]/g, "")}` : "";
    const r = await macAdmin(`/sbin/pfctl -a ${PF_ANCHOR} -F all${tok} ; true`);
    if (r.code !== 0) throw new Error("Güvenlik duvarı kuralları kaldırılamadı: " + (r.stderr || r.stdout).trim().split("\n")[0]);
    return r;
  }

  return {
    supported,
    active: () => on,
    ALWAYS_ALLOWED,

    // piIp: Pi'ın IPv4 adresi
    async enable(piIp) {
      if (!supported) throw new Error("Kill switch bu işletim sisteminde desteklenmiyor.");
      if (!IP4_RE.test(String(piIp))) throw new Error("Kill switch için Pi'ın IPv4 adresi gerekli.");
      if (on) return;
      await store.save({ platform, pending: true }); // kurallar yazılmadan ÖNCE kaydet: çökerse kaldırılabilsin
      try {
        if (platform === "win32") {
          const ranges = blockRanges(ALWAYS_ALLOWED.concat([piIp + "/32"])).join(",");
          const r = await winElevated(
            `netsh advfirewall firewall add rule name=${RULE_V4} dir=out action=block protocol=any remoteip=${ranges} profile=any enable=yes` +
            ` && netsh advfirewall firewall add rule name=${RULE_V6} dir=out action=block protocol=any remoteip=2000::/3 profile=any enable=yes`
          );
          if (r.code !== 0) throw new Error("Güvenlik duvarı kuralı eklenemedi. Yönetici izni (UAC penceresi) verilmiş olmalı.");
        } else {
          const rules = pfRules(piIp).map(shQuote).join(" ");
          const r = await macAdmin(`printf '%s\\n' ${rules} | /sbin/pfctl -a ${PF_ANCHOR} -f - 2>&1 && /sbin/pfctl -E 2>&1`);
          if (r.code !== 0) throw new Error("pf kuralı eklenemedi (şifre girilmediyse iptal edilmiştir): " + (r.stderr || r.stdout).trim().split("\n")[0]);
          const m = /Token\s*:\s*(\d+)/i.exec(r.stdout + r.stderr);
          await store.save({ platform, pending: true, token: m ? m[1] : "" });
        }
      } catch (e) {
        // İzin penceresi reddedildiyse kural yazılmamıştır; ikinci bir izin penceresi açma
        if (!/Yönetici izni|iptal edilmiştir/.test(e.message)) { try { await removeRules(null); } catch (_) { /* en azından hatayı göster */ } }
        await store.clear();
        throw e;
      }
      on = true;
      const cur = await store.load();
      await store.save(Object.assign({}, cur, { pending: false }));
    },

    async disable() {
      const saved = await store.load();
      if (!saved && !on) return;
      try {
        await removeRules(saved);
        await store.clear();
        on = false;
      } catch (e) {
        throw e; // kaldırılamadıysa yedek durur: bir sonraki açılışta yeniden denenir
      }
    },

    // Uygulama açılırken: önceki çalışmadan kalmış kural varsa kaldır
    async recover() {
      const saved = await store.load();
      if (!saved) return false;
      await removeRules(saved);
      await store.clear();
      return true;
    },
  };
}

module.exports = { createKillSwitch, blockRanges, ALWAYS_ALLOWED, RULE_V4, RULE_V6, PF_ANCHOR };
