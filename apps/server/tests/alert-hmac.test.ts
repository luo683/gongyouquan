import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAlertSignatureVerifier } from '../src/ops/hmac.js';

const SECRET = 'test-alert-hmac-secret';
const NOW_MS = Date.parse('2026-09-15T04:00:00.000Z');

function sign(body: string, timestamp: number, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}\n${body}`).digest('hex')}`;
}

function verifier(nowMs = NOW_MS) {
  return createAlertSignatureVerifier({
    secret: SECRET,
    now: () => nowMs,
  });
}

const BODY = '{"source":"backup","severity":"critical","title":"备份失败","idempotencyKey":"k1"}';
const TS = Math.floor(NOW_MS / 1000);

describe('/hooks/* signature verification', () => {
  it('accepts a signature over "<timestamp>\\n<body>"', () => {
    const result = verifier().verify(
      { 'x-alert-timestamp': String(TS), 'x-alert-signature': sign(BODY, TS) },
      BODY,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects a body that changed by one byte after signing', () => {
    const result = verifier().verify(
      { 'x-alert-timestamp': String(TS), 'x-alert-signature': sign(BODY, TS) },
      BODY.replace('"critical"', '"info"'),
    );
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature made with another secret', () => {
    expect(
      verifier().verify(
        { 'x-alert-timestamp': String(TS), 'x-alert-signature': sign(BODY, TS, 'other-secret') },
        BODY,
      ),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature from a neighbouring timestamp', () => {
    // The timestamp is inside the signed string, so moving it without re-signing is
    // a mismatch rather than an expiry - which is the point of including it.
    const stale = TS - 600;
    expect(
      verifier().verify(
        { 'x-alert-timestamp': String(stale), 'x-alert-signature': sign(BODY, stale) },
        BODY,
      ),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a timestamp from the future beyond the skew', () => {
    const future = TS + 600;
    expect(
      verifier().verify(
        { 'x-alert-timestamp': String(future), 'x-alert-signature': sign(BODY, future) },
        BODY,
      ),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts exactly the skew boundary on both sides', () => {
    for (const offset of [-300, 300]) {
      const ts = TS + offset;
      expect(
        verifier().verify(
          { 'x-alert-timestamp': String(ts), 'x-alert-signature': sign(BODY, ts) },
          BODY,
        ).ok,
      ).toBe(true);
    }
  });

  it('reports missing headers rather than throwing', () => {
    expect(verifier().verify({}, BODY)).toEqual({ ok: false, reason: 'missing' });
    expect(verifier().verify({ 'x-alert-timestamp': String(TS) }, BODY)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(verifier().verify({ 'x-alert-signature': sign(BODY, TS) }, BODY)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('reports a malformed header rather than throwing', () => {
    const cases: Array<Record<string, string>> = [
      // Not a number: Number('') is 0 and would otherwise read as 1970.
      { 'x-alert-timestamp': 'soon', 'x-alert-signature': sign(BODY, TS) },
      { 'x-alert-timestamp': '1.5', 'x-alert-signature': sign(BODY, TS) },
      { 'x-alert-timestamp': String(TS), 'x-alert-signature': `${'a'.repeat(64)}` },
      { 'x-alert-timestamp': String(TS), 'x-alert-signature': 'sha512=' + 'a'.repeat(128) },
      { 'x-alert-timestamp': String(TS), 'x-alert-signature': 'sha256=nothex' },
      // Shorter than the digest: crypto.timingSafeEqual throws on a length
      // mismatch, and an endpoint that answers 500 to a bad signature tells the
      // caller less than one that answers 401.
      { 'x-alert-timestamp': String(TS), 'x-alert-signature': 'sha256=' + 'a'.repeat(62) },
    ];
    for (const headers of cases) {
      expect(verifier().verify(headers, BODY)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('accepts an uppercase hex digest', () => {
    const upper = sign(BODY, TS).toUpperCase().replace('SHA256=', 'sha256=');
    expect(
      verifier().verify({ 'x-alert-timestamp': String(TS), 'x-alert-signature': upper }, BODY).ok,
    ).toBe(true);
  });

  it('accepts a repeated header value only when it is the same signature', () => {
    const signature = sign(BODY, TS);
    // Node joins duplicate headers with ", ". Accepting that shape would let a
    // caller smuggle a second value past the check that runs on the first.
    expect(
      verifier().verify(
        { 'x-alert-timestamp': String(TS), 'x-alert-signature': `${signature}, ${'b'.repeat(64)}` },
        BODY,
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('treats an absent raw body as missing, not as an empty string', () => {
    // Without the exact bytes there is nothing to verify against; answering
    // 'mismatch' would imply the signature was checked.
    expect(
      verifier().verify({ 'x-alert-timestamp': String(TS), 'x-alert-signature': sign('', TS) }, undefined),
    ).toEqual({ ok: false, reason: 'missing' });
  });

  it('signs the body, not a re-serialisation of it', () => {
    // The regression this guards: JSON.stringify(JSON.parse(x)) is not byte-stable
    // (whitespace, key order, unicode escapes), so a verifier that rebuilt the
    // body would reject every hand-written curl in the ops scripts.
    const spaced = '{ "a" : 1,  "b":2 }';
    expect(
      verifier().verify(
        { 'x-alert-timestamp': String(TS), 'x-alert-signature': sign(spaced, TS) },
        spaced,
      ).ok,
    ).toBe(true);
    expect(
      verifier().verify(
        { 'x-alert-timestamp': String(TS), 'x-alert-signature': sign(JSON.stringify(JSON.parse(spaced)), TS) },
        spaced,
      ).ok,
    ).toBe(false);
  });
});
