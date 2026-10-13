"use strict";
// Windows'ta sistem proxy'si bir PAC dosyasıyla kurulur: tarayıcılar "SOCKS5" sonucunu kesin olarak
// SOCKS5 + uzaktan DNS olarak uygular (WinINET'in "socks=" biçimi Chrome'da SOCKS4 sayılır, DNS sızdırır).
const http = require("http");

// Host adı yalnızca bu karakterlerden oluşabilir (betiğe güvenle gömülür)
const HOST_RE = /^[A-Za-z0-9._-]+$/;

// Doğrudan çıkan siteler: yalnızca geçerli alan adları betiğe girer (dnsDomainIs yerel DNS sorgusu yapmaz)
function directList(direct) {
  return (Array.isArray(direct) ? direct : []).filter((d) => /^[a-z0-9.-]+$/.test(String(d))).slice(0, 300);
}

// DİKKAT: isInNet/dnsResolve KULLANILMAZ; ikisi de yerel DNS sorgusu yapar ve sızıntıya yol açar.
// Yerel ağ kontrolü yalnızca IP adresi biçimindeki host'larda, elle yapılır.
function pacScript(host, port, direct) {
  if (!HOST_RE.test(host)) throw new Error("Geçersiz Pi adresi.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Geçersiz port.");
  return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host === "localhost" || host === "::1" || dnsDomainIs(host, ".local")) return "DIRECT";
  var m = /^(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(host);
  if (m) {
    var a = +m[1], b = +m[2];
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "DIRECT";
  }
  if (host === ${JSON.stringify(host)}) return "DIRECT";
  var direct = ${JSON.stringify(directList(direct))};
  for (var i = 0; i < direct.length; i++) {
    if (host === direct[i] || dnsDomainIs(host, "." + direct[i])) return "DIRECT";
  }
  return "SOCKS5 ${host}:${port}";
}
`;
}

// Yalnızca 127.0.0.1'de dinleyen küçük sunucu: /proxy.pac
function startPacServer(host, port, direct) {
  let body = pacScript(host, port, direct);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if ((req.url || "").split("?")[0] === "/proxy.pac") {
        res.writeHead(200, { "Content-Type": "application/x-ns-proxy-autoconfig", "Cache-Control": "no-store" });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      resolve({
        url: `http://127.0.0.1:${p}/proxy.pac`,
        port: p,
        update: (d) => { body = pacScript(host, port, d); },
        close: () => new Promise((r) => { srv.close(() => r()); if (srv.closeAllConnections) srv.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { pacScript, startPacServer, HOST_RE };
