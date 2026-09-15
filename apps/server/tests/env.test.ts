import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

describe('server environment', () => {
  const base = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/app',
    JWT_SECRET: 'jwt-secret',
    UPLOAD_DIR: './uploads',
    PUBLIC_ORIGIN: 'http://localhost:5173',
    MEILI_URL: 'http://localhost:7700',
    MEILI_MASTER_KEY: 'meili-key',
    ALERT_HMAC_SECRET: 'alert-secret',
  };

  it('fails at startup when required configuration is missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('parses required configuration and defaults the port', () => {
    const env = parseEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/app',
      JWT_SECRET: 'jwt-secret',
      UPLOAD_DIR: './uploads',
      PUBLIC_ORIGIN: 'http://localhost:5173',
      MEILI_URL: 'http://localhost:7700',
      MEILI_MASTER_KEY: 'meili-key',
      ALERT_HMAC_SECRET: 'alert-secret',
    });

    expect(env).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      databaseUrl: 'postgres://user:pass@localhost:5432/app',
      contractVersion: undefined,
    });
  });

  it('reads a blank optional variable as unset, which is what compose sends', () => {
    // `${SYSTEM_GROUP_ID:-}` renders as an empty string, not as "absent". Taking
    // that literally would make the API refuse to boot over a variable only
    // /hooks/alert reads - and `SYSTEM_GROUP_ID=` in a fresh .env is the ordinary
    // state of a machine that has not created the ops group yet.
    const blank = parseEnv({ ...base, SYSTEM_GROUP_ID: '', CONTRACT_VERSION: '' });

    expect(blank.systemGroupId).toBeUndefined();
    expect(blank.contractVersion).toBeUndefined();

    expect(parseEnv({ ...base, SYSTEM_GROUP_ID: '1' }).systemGroupId).toBe('1');
  });

  it('rejects invalid ports and origins', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/app',
        JWT_SECRET: 'jwt-secret',
        UPLOAD_DIR: './uploads',
        PUBLIC_ORIGIN: 'not-a-url',
        MEILI_URL: 'http://localhost:7700',
        MEILI_MASTER_KEY: 'meili-key',
        ALERT_HMAC_SECRET: 'alert-secret',
        PORT: '0',
      }),
    ).toThrow();
  });
});
