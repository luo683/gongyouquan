import { describe, expect, it } from 'vitest';
import {
  groupCreateSchema,
  groupDtoSchema,
  groupSummaryDtoSchema,
  groupUpdateSchema,
  memberDtoSchema,
} from '../src/index.js';

const groupFixture = {
  id: '7',
  name: '工地A组',
  description: null,
  isArchived: false,
  isSystem: false,
  lastSeq: 0,
  createdAt: '2026-09-13T12:00:00+08:00',
  updatedAt: '2026-09-13T12:00:00+08:00',
};

describe('group contracts', () => {
  it('requires a name and allows an optional description', () => {
    expect(groupCreateSchema.parse({ name: '工地A组' })).toEqual({ name: '工地A组' });
    expect(() => groupCreateSchema.parse({ description: 'x' })).toThrow();
  });

  it('keeps group ids as strings and timestamps ISO-8601 with offset', () => {
    expect(groupDtoSchema.parse(groupFixture).id).toBe('7');
    expect(() => groupDtoSchema.parse({ ...groupFixture, id: 7 })).toThrow();
    expect(() => groupDtoSchema.parse({ ...groupFixture, createdAt: '2026-09-13 12:00' })).toThrow();
  });

  it('caps unread counts at the 100 sentinel and allows a null preview', () => {
    expect(groupSummaryDtoSchema.parse({
      ...groupFixture,
      memberCount: 8,
      unreadCount: 100,
      myLastReadSeq: 42,
      lastMessagePreview: null,
    }).unreadCount).toBe(100);

    expect(() => groupSummaryDtoSchema.parse({
      ...groupFixture,
      memberCount: 8,
      unreadCount: 101,
      myLastReadSeq: 42,
      lastMessagePreview: null,
    })).toThrow();
  });

  it('accepts the documented member roles only', () => {
    expect(memberDtoSchema.parse({
      userId: '3',
      username: 'worker',
      displayName: '工友',
      role: 'owner',
      joinedAt: '2026-09-13T12:00:00+08:00',
    }).role).toBe('owner');
    expect(() => memberDtoSchema.parse({
      userId: '3', username: 'worker', displayName: '工友', role: 'boss', joinedAt: '2026-09-13T12:00:00+08:00',
    })).toThrow();
  });

  it('rejects unknown fields in update payloads', () => {
    expect(groupUpdateSchema.parse({ name: '新名' })).toEqual({ name: '新名' });
    expect(() => groupUpdateSchema.parse({ name: '新名', isArchived: true })).toThrow();
  });
});
