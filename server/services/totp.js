const crypto = require('crypto');

/**
 * Time-based one-time passwords (RFC 6238), implemented on node's crypto so
 * there is no dependency to trust. Compatible with Google Authenticator, Authy,
 * 1Password and any other standard TOTP app: HMAC-SHA1, 6 digits, 30s step.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh random secret, returned as the base32 string apps expect. */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** The 6-digit code for a given secret at a given time step. */
function codeAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
              (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Which time-step a code matches, or -1 if none.
 *
 * A ±1 step window absorbs clock drift between the server and the phone.
 * Steps at or below `after` are treated as already spent and skipped — this is
 * what makes a code single-use: the caller records the returned step and passes
 * it back as `after` next time, so the same code cannot be replayed within its
 * ~90s validity. Comparison is constant-time.
 */
function verifyStep(secret, token, { step = 30, window = 1, now = Date.now(), after = -Infinity } = {}) {
  if (!secret || !/^\d{6}$/.test(String(token || '').trim())) return -1;
  const counter = Math.floor(now / 1000 / step);
  const given = Buffer.from(String(token).trim());
  for (let w = -window; w <= window; w++) {
    const c = counter + w;
    if (c <= after) continue;                        // already spent
    const expected = Buffer.from(codeAt(secret, c));
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return c;
  }
  return -1;
}

/** Boolean form, for callers that don't track replay (e.g. one-shot checks). */
function verify(secret, token, opts = {}) {
  return verifyStep(secret, token, opts) >= 0;
}

/** otpauth:// URI, encoded into the enrolment QR. */
function otpauthUri(secret, { account, issuer = 'BluePrint EventPrint' } = {}) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, verify, verifyStep, otpauthUri, codeAt, base32Encode, base32Decode };
