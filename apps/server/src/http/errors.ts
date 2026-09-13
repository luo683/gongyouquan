import type { FastifyReply, FastifyRequest } from 'fastify';

/** Application-level error carrying a machine-readable code from the shared contract. */
export class HttpError extends Error {
  constructor(public readonly code: string) {
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
};

export function statusForErrorCode(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
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
    await reply.status(statusForErrorCode(code)).send(errorEnvelope(request, code));
    return undefined;
  }
}
