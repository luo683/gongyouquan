import { z } from 'zod';

/**
 * A variable that is present but blank is unset.
 *
 * Compose has no way to express "pass this through only if it has a value":
 * `SYSTEM_GROUP_ID: '${SYSTEM_GROUP_ID:-}'` puts an empty string into the
 * container, and `z.string().min(1).optional()` rejects that - so the whole API
 * would refuse to start over the one variable that only /hooks/alert reads. The
 * safe direction is the one that matches what the operator meant.
 */
const blankToUndefined = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  UPLOAD_DIR: z.string().min(1),
  PUBLIC_ORIGIN: z.string().url(),
  MEILI_URL: z.string().url(),
  MEILI_MASTER_KEY: z.string().min(1),
  ALERT_HMAC_SECRET: z.string().min(1),
  SYSTEM_GROUP_ID: blankToUndefined,
  OPS_APPROVER_GROUP_ID: blankToUndefined,
  CONTRACT_VERSION: blankToUndefined,
  /**
   * Optional. Loopback always reads /internal/metrics; this is what any other
   * caller must present. It exists for the case where the port gets published by
   * mistake - the payload carries pool sizes and connection counts, which is
   * reconnaissance material rather than a secret in itself, but there is no reason
   * to hand it out.
   */
  INTERNAL_METRICS_TOKEN: blankToUndefined,
  LOG_LEVEL: z.string().min(1).default('info'),
});

export type ServerEnv = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  uploadDir: string;
  publicOrigin: string;
  meiliUrl: string;
  meiliMasterKey: string;
  alertHmacSecret: string;
  systemGroupId?: string;
  opsApproverGroupId?: string;
  contractVersion?: string;
  internalMetricsToken?: string;
  logLevel: string;
};

export function parseEnv(input: Record<string, string | undefined>): ServerEnv {
  const parsed = rawEnvSchema.parse(input);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    jwtSecret: parsed.JWT_SECRET,
    uploadDir: parsed.UPLOAD_DIR,
    publicOrigin: parsed.PUBLIC_ORIGIN,
    meiliUrl: parsed.MEILI_URL,
    meiliMasterKey: parsed.MEILI_MASTER_KEY,
    alertHmacSecret: parsed.ALERT_HMAC_SECRET,
    systemGroupId: parsed.SYSTEM_GROUP_ID,
    opsApproverGroupId: parsed.OPS_APPROVER_GROUP_ID,
    contractVersion: parsed.CONTRACT_VERSION,
    internalMetricsToken: parsed.INTERNAL_METRICS_TOKEN,
    logLevel: parsed.LOG_LEVEL,
  };
}
