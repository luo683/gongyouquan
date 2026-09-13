import type { FastifyInstance } from 'fastify';

export type Readiness = {
  ok: boolean;
  checks: {
    db: 'up' | 'down';
    meili: 'up' | 'down' | 'degraded';
    outboxLag: number | null;
  };
};

export type ReadinessProvider = {
  getReadiness(): Promise<Readiness>;
};

export async function registerHealthRoutes(
  app: FastifyInstance,
  provider: ReadinessProvider,
): Promise<void> {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (request, reply) => {
    const readiness = await provider.getReadiness();
    if (readiness.ok) return readiness;

    return reply.status(503).send({
      error: {
        code: 'NOT_READY',
        message: 'service is not ready',
        details: { checks: readiness.checks },
        requestId: request.id,
      },
    });
  });
}
