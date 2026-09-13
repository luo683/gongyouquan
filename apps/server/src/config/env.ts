import { z } from 'zod';

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
  SYSTEM_GROUP_ID: z.string().min(1).optional(),
  OPS_APPROVER_GROUP_ID: z.string().min(1).optional(),
  CONTRACT_VERSION: z.string().min(1).optional(),
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
    logLevel: parsed.LOG_LEVEL,
  };
}
