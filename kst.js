// ── KST(14자리) ↔ ISO 8601 변환 ──────────────────────────────────────────────
// 장비 IECP 는 14자리 KST(YYYYMMDDHHmmss)를 사용한다. API 서버는 ISO 8601(timestamptz)
// 를 사용하므로 양방향 변환은 Gateway 책임이다. (Gateway Postman 문서 참조)

// 14자리 KST → ISO 8601 (+09:00 오프셋 명시)
function kstToIso(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!/^\d{14}$/.test(str)) return null;
  const y = str.slice(0, 4), mo = str.slice(4, 6), d = str.slice(6, 8);
  const h = str.slice(8, 10), mi = str.slice(10, 12), se = str.slice(12, 14);
  return `${y}-${mo}-${d}T${h}:${mi}:${se}+09:00`;
}

// ISO 8601(또는 Date) → 14자리 KST
function isoToKst(iso) {
  const dt = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  const k = new Date(dt.getTime() + 9 * 3600 * 1000); // UTC → KST
  const p = (n) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}${p(k.getUTCMonth() + 1)}${p(k.getUTCDate())}` +
         `${p(k.getUTCHours())}${p(k.getUTCMinutes())}${p(k.getUTCSeconds())}`;
}

module.exports = { kstToIso, isoToKst };
