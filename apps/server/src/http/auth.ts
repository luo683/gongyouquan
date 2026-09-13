import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { errorEnvelope } from './errors.js';

export type RequestUser = {
  id: string;
  sessionId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    user?: RequestUser;
  }
}

/**
 * Verifies the HS256 access token from `Authorization: Bearer <token>`.
 * Deliberately does not query the database (backend spec 3.1): a kicked device's
 * token stays valid for at most the remaining 15 minutes.
 */
export function createAuthenticator(secret: Uint8Array) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return reply.status(401).send(errorEnvelope(request, 'UNAUTHENTICATED'));

    try {
      const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0 || typeof payload.sid !== 'string') {
        return reply.status(401).send(errorEnvelope(request, 'UNAUTHENTICATED'));
      }
      request.user = { id: payload.sub, sessionId: payload.sid };
    } catch (error) {
      // jose throws JWTExpired (ERR_JWT_EXPIRED) for exp failures and JWS errors otherwise;
      // duck-typing the code keeps this stable across jose minor versions.
      const code = (error as { code?: string }).code === 'ERR_JWT_EXPIRED' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED';
      return reply.status(401).send(errorEnvelope(request, code));
    }
  };
}
