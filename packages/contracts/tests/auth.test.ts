import { describe, expect, it } from 'vitest';
import { authLoginSchema, authRegisterSchema, authRefreshSchema } from '../src/index.js';

describe('auth request schemas', () => {
  it('accepts the documented register and login shapes', () => {
    expect(authRegisterSchema.parse({
      code: 'invite-1',
      username: 'worker',
      displayName: '工友',
      password: 'password123',
    })).toMatchObject({ username: 'worker' });

    expect(authLoginSchema.parse({
      username: 'worker',
      password: 'password123',
      clientKind: 'desktop',
    }).clientKind).toBe('desktop');
  });

  it('rejects weak passwords and unsupported client kinds', () => {
    expect(() => authRegisterSchema.parse({
      code: 'invite-1',
      username: 'worker',
      displayName: '工友',
      password: '1234567890',
    })).toThrow();
    expect(() => authLoginSchema.parse({
      username: 'worker',
      password: 'password123',
      clientKind: 'mobile',
    })).toThrow();
  });

  it('allows an empty refresh body for the browser cookie path', () => {
    expect(authRefreshSchema.parse({})).toEqual({});
    expect(authRefreshSchema.parse({ refreshToken: 'refresh-token' })).toEqual({
      refreshToken: 'refresh-token',
    });
  });
});
