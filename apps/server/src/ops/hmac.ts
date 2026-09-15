import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature check for `/hooks/*`.
 *
 * The ops manual specifies these endpoints as "HMAC 签名（无登录态）" and adds a
 * timestamp with a ±300 second window, but never pins the wire format - so this
 * file is the pin, and docs/decisions/0015 section one records what was chosen and
 * why. Two properties are load bearing:
 *
 * 1. The signature covers `<timestamp>\n<raw body>`. The raw bytes, not a reparsed
 *    object: `JSON.stringify(JSON.parse(x))` is not byte-stable (whitespace, key
 *    order, \u escapes), so a verifier that rebuilt the body would reject every
 *    hand-written curl in the ops scripts while accepting a machine-generated one -
 *    a failure mode that reads as "the secret is wrong" for hours.
 * 2. The timestamp is inside the signed string, so pushing it forward requires
 *    re-signing. Without that the window would bound nothing: a captured request
 *    could be replayed by editing the header alone.
 *
 * Replays inside the window are still possible and are answered by the
 * idempotency key rather than here - a captured body replayed is a no-op that
 * returns the same messageId, so the window is defence against unbounded replay,
 * not against a two-minute one.
 */

export const SIGNATURE_SKEW_SECONDS = 300;

export type SignatureFailure = 'missing' | 'malformed' | 'expired' | 'mismatch';

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/** Headers as Fastify hands them over: absent, a string, or an array when duplicated. */
export type SignatureHeaders = Record<string, string | string[] | undefined>;

const TIMESTAMP_PATTERN = /^\d{1,20}$/;
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;
const DIGEST_BYTES = 32;

export type AlertSignatureVerifier = {
  /**
   * `rawBody` is the exact payload the parser received. `undefined` means the
   * request arrived with a content type this route does not parse, so there are
   * no bytes to check against - reported as `missing` rather than `mismatch`,
   * because nothing was ever compared.
   */
  verify(headers: SignatureHeaders, rawBody: string | undefined): SignatureResult;
};

function headerValue(header: string | string[] | undefined): string | undefined {
  // A duplicated header is not two chances to be right. Node joins it with
  // ", ", which no single digest matches, so the strict patterns below reject it
  // as malformed - but reading only the first element would accept a request
  // whose second value was something else entirely.
  return Array.isArray(header) ? undefined : header;
}

export function createAlertSignatureVerifier(options: {
  secret: string;
  /** Injectable so a test pins the skew boundary instead of sleeping through it. */
  now?: () => number;
  skewSeconds?: number;
}): AlertSignatureVerifier {
  const now = options.now ?? Date.now;
  const skewSeconds = options.skewSeconds ?? SIGNATURE_SKEW_SECONDS;

  return {
    verify(headers, rawBody) {
      const timestampHeader = headerValue(headers['x-alert-timestamp']);
      const signatureHeader = headerValue(headers['x-alert-signature']);
      if (timestampHeader === undefined || signatureHeader === undefined || rawBody === undefined) {
        return { ok: false, reason: 'missing' };
      }

      if (!TIMESTAMP_PATTERN.test(timestampHeader)) return { ok: false, reason: 'malformed' };
      const matched = SIGNATURE_PATTERN.exec(signatureHeader);
      if (!matched?.[1]) return { ok: false, reason: 'malformed' };

      const claimed = Number(timestampHeader);
      // Past 2^53 a "timestamp" stops being an exact integer, and the skew
      // arithmetic below would silently compare rounded values.
      if (!Number.isSafeInteger(claimed)) return { ok: false, reason: 'malformed' };

      const skew = Math.abs(Math.floor(now() / 1000) - claimed);
      if (skew > skewSeconds) return { ok: false, reason: 'expired' };

      const provided = Buffer.from(matched[1], 'hex');
      const expected = createHmac('sha256', options.secret)
        .update(`${timestampHeader}\n${rawBody}`, 'utf8')
        .digest();
      // timingSafeEqual throws when the lengths differ. The pattern above already
      // pins 64 hex characters, so this is a guard against someone loosening it:
      // an endpoint that answers 500 to a short signature is a worse endpoint than
      // one that answers 401.
      if (provided.length !== DIGEST_BYTES) return { ok: false, reason: 'malformed' };

      return timingSafeEqual(provided, expected)
        ? { ok: true }
        : { ok: false, reason: 'mismatch' };
    },
  };
}

/**
 * The other half of the contract, for the scripts that call in. Kept here so the
 * string that gets signed lives in exactly one place in TypeScript-land; the
 * shell senders have their own copy and `tests/alert-hmac.test.ts` pins both
 * against the same vector.
 */
export function signAlertPayload(input: {
  secret: string;
  timestampSeconds: number;
  body: string;
}): { 'x-alert-timestamp': string; 'x-alert-signature': string } {
  const signature = createHmac('sha256', input.secret)
    .update(`${input.timestampSeconds}\n${input.body}`, 'utf8')
    .digest('hex');
  return {
    'x-alert-timestamp': String(input.timestampSeconds),
    'x-alert-signature': `sha256=${signature}`,
  };
}
