"use strict";
// "Doğrudan çıkan siteler": bu alan adlarına (ve alt alan adlarına) Tor kullanılmaz, gerçek IP ile girilir.
// Neden: bankalar, e-devlet ve benzeri siteler Tor çıkış IP'lerini engelleyebilir ya da hesabı kilitleyebilir.
// Aynı mantık eklentide (src/lib.js) da var; ikisi birebir aynı davranmalı.

// Elle derlenmiş başlangıç listesi: eksik ya da güncelliğini yitirmiş olabilir, kendi bankanı ekle.
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

// Chromium / Electron --proxy-bypass-list girdileri
const chromiumBypass = (list) => (list || []).flatMap((d) => [d, "*." + d]);
// Firefox network.proxy.no_proxies_on girdileri
const firefoxBypass = (list) => (list || []).flatMap((d) => [d, "." + d]);
// macOS networksetup istisna alan adları
const macBypass = (list) => (list || []).flatMap((d) => [d, "*." + d]);

module.exports = { DEFAULT_DIRECT, AI_DIRECT, DEV_DIRECT, DIRECT_VERSION, addedSince, DOMAIN_RE, normalizeDomains, matchesDirect, chromiumBypass, firefoxBypass, macBypass };
