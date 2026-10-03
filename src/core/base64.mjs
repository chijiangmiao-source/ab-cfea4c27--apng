// Strict Base64 decoder. Locates and reports the first illegal character
// so the review API can surface a precise violation offset.
export function strictBase64Decode(text) {
  // Tolerate an optional data URL prefix.
  let s = text;
  const comma = s.indexOf(',');
  if (s.startsWith('data:') && comma !== -1) {
    s = s.slice(comma + 1);
  }
  // Only whitespace is permitted around/in the payload; strip it while
  // remembering original offsets for error reporting.
  const stripped = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const isSpace =
      ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x0c || ch === 0x0b;
    if (!isSpace) stripped.push(i);
  }
  const alphabet = (ch) =>
    (ch >= 65 && ch <= 90) ||
    (ch >= 97 && ch <= 122) ||
    (ch >= 48 && ch <= 57) ||
    ch === 43 ||
    ch === 47 ||
    ch === 61;

  for (const origIdx of stripped) {
    const ch = s.charCodeAt(origIdx);
    if (!alphabet(ch)) {
      return { error: { offset: origIdx, char: s[origIdx] } };
    }
  }
  let payload = stripped.map((i) => s[i]).join('');

  // '=' padding is only legal at the very end, in groups of one or two.
  const eq = payload.indexOf('=');
  if (eq !== -1 && !/^={1,2}$/.test(payload.slice(eq))) {
    return { error: { offset: stripped[eq], char: '=' } };
  }
  if (payload.length % 4 !== 0) {
    // un-padded base64 is accepted by Node but we require canonical padding
    // to keep submitted blobs unambiguous; report first missing position.
    return { error: { offset: s.length, char: null, reason: '长度不是 4 的倍数（缺少填充）' } };
  }
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.length === 0) {
    return { error: { offset: 0, char: null, reason: '空内容' } };
  }
  return { data: decoded };
}
