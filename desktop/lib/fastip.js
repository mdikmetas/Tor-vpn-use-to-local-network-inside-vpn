"use strict";
// "En hızlı IP'yi bul": yeni çıkış IP'si al, gecikmesini ölç; hedefin altındaysa dur, değilse değiştir.
// Deneme bitince en düşük gecikmeli çıkış rölesi Pi'da sabitlenir (ExitNodes=<ip>).
//   measure()  -> { ip, ms }   (ms: devre üzerinden küçük bir isteğin en düşük süresi)
//   newnym()   -> yeni devre iste ve bitmesini bekle
//   pin(ip)    -> çıkışı o IP'ye sabitle ("" = sabitlemeyi kaldır)
async function findFast(o) {
  const attempts = Math.max(1, Math.min(30, o.attempts | 0 || 8));
  const targetMs = Math.max(50, o.targetMs | 0 || 700);
  const tried = [];
  let best = null;
  const say = (m) => o.onProgress && o.onProgress(m);

  for (let i = 1; i <= attempts && !o.cancelled(); i++) {
    if (i > 1) { say(`Yeni IP isteniyor (${i}/${attempts})…`); await o.newnym(); }
    say(`Ölçülüyor (${i}/${attempts})…`);
    let r = null;
    try { r = await o.measure(); } catch (_) { r = null; }
    if (!r || !r.ip || !(r.ms > 0)) { tried.push({ ip: null, ms: null }); continue; }
    tried.push(r);
    if (!best || r.ms < best.ms) best = r;
    say(`${r.ip}: ${r.ms} ms`);
    if (r.ms <= targetMs) return { done: true, reached: true, current: r, best: r, tried, pinned: false };
  }
  if (o.cancelled()) return { done: false, cancelled: true, tried, best };
  if (!best) return { done: false, error: "Hiçbir denemede ölçüm alınamadı.", tried };

  // Hedefe ulaşılamadı: şu anki IP en iyisi değilse, en iyisine geri dön (çıkışı sabitle)
  const last = tried[tried.length - 1];
  if (last && last.ip === best.ip) return { done: true, reached: false, current: last, best, tried, pinned: false };
  say(`En iyi IP'ye (${best.ip}, ${best.ms} ms) dönülüyor…`);
  try {
    await o.pin(best.ip);
    await o.newnym();
    const c = await o.measure();
    if (c && c.ip === best.ip && c.ms <= best.ms * 2) {
      return { done: true, reached: false, current: c, best, tried, pinned: true };
    }
    await o.pin("");   // sabitleme tutmadı: eski haline dön
    return { done: true, reached: false, current: c || null, best, tried, pinned: false, pinFailed: true };
  } catch (e) {
    try { await o.pin(""); } catch (_) { /* sabitleme yoktu */ }
    return { done: true, reached: false, current: last, best, tried, pinned: false, pinFailed: true, pinError: e.message };
  }
}

module.exports = { findFast };
