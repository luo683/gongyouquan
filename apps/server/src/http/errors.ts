import type { FastifyReply, FastifyRequest } from 'fastify';

/** Application-level error carrying a machine-readable code from the shared contract. */
export class HttpError extends Error {
  /**
   * `details` is the machine-readable half of the error contract (spec 8.1 reserves
   * envelope.details for it, and acceptance item 10 needs details.currentStatus).
   * Chinese copy stays in the client, keyed off `code`.
   */
  constructor(
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  INVITE_INVALID: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  REFRESH_INVALID: 401,
  REFRESH_REUSED: 401,
  FORBIDDEN_NOT_MEMBER: 403,
  FORBIDDEN_ROLE: 403,
  ACCOUNT_DISABLED: 403,
  CANNOT_REVIEW_OWN_SUBMISSION: 403,
  NOT_FOUND: 404,
  STATE_MACHINE_VIOLATION: 409,
  EDIT_WINDOW_EXPIRED: 409,
  DELETE_WINDOW_EXPIRED: 409,
  GROUP_ARCHIVED: 409,
  RATE_LIMITED: 429,
  // 401, not 403: the caller is not a known principal lacking a permission, they
  // proved nothing. Without this line the code falls through to 500, which reads
  // as "the endpoint is broken" to whoever is staring at a failing curl.
  HOOK_SIGNATURE_INVALID: 401,
  // 503, and it is worth the extra line: an operator who sees 500 assumes the code
  // is broken, while 503 plus details.reason says "set SYSTEM_GROUP_ID".
  OPS_GROUP_NOT_CONFIGURED: 503,
};

export function statusForErrorCode(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * A refused request that knows when it may try again.
 *
 * `Retry-After` is part of the contract (spec 8.1 says the 429 response
 * carries it), so the number has to ride on the error itself rather than be
 * re-derived by whichever layer happens to write the response - the socket
 * path has no headers to set and still has to tell the client how long.
 */
export class RateLimitedError extends HttpError {
  constructor(public readonly retryAfterSeconds: number, scope?: string) {
    super('RATE_LIMITED', { retryAfterSeconds, ...(scope ? { scope } : {}) });
    this.name = 'RateLimitedError';
  }
}

export function errorEnvelope(request: { id: string }, code: string, details?: unknown) {
  return {
    error: {
      code,
      message: code.toLowerCase().replaceAll('_', ' '),
      ...(details === undefined ? {} : { details }),
      requestId: request.id,
    },
  };
}

/** Runs a handler and maps HttpError codes to the unified envelope; returns undefined when handled. */
export async function guarded<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof HttpError)) console.error('unhandled request error', error);
    const details = error instanceof HttpError ? error.details : undefined;
    if (error instanceof RateLimitedError) {
      reply.header('retry-after', String(error.retryAfterSeconds));
    }
    await reply
      .status(statusForErrorCode(code))
      .send(errorEnvelope(request, code, details));
    return undefined;
  }
}
