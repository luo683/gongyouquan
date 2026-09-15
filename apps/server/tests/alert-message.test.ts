import { describe, expect, it } from 'vitest';
import { ALERT_DETAIL_MAX_CHARS, renderAlertMessage } from '../src/ops/alert-message.js';

const BASE = {
  source: 'backup',
  title: '备份失败',
  severity: 'critical' as const,
  hitCount: 1,
  openedAt: '2026-09-15T04:00:11.000Z',
  lastSeenAt: '2026-09-15T04:00:11.000Z',
};

describe('renderAlertMessage', () => {
  it('shows severity, title and source with a single hit', () => {
    const { body } = renderAlertMessage({ ...BASE });
    expect(body).toContain('【critical】备份失败');
    expect(body).toContain('backup');
    // One hit is not a count. Printing "×1" on the first line of an alert makes
    // every single occurrence look like a repeat of something already known.
    expect(body).not.toContain('×');
  });

  it('carries the count once the window has merged hits', () => {
    const { body } = renderAlertMessage({ ...BASE, hitCount: 7 });
    expect(body).toContain('【critical】备份失败 ×7');
  });

  it('reports the window rather than a single instant once it has spanned time', () => {
    const { body } = renderAlertMessage({ ...BASE, hitCount: 3, lastSeenAt: '2026-09-15T04:03:22.000Z' });
    expect(body).toContain('04:00:11');
    expect(body).toContain('04:03:22');
  });

  it('keeps the times in UTC and labels the zone', () => {
    // The ops group is read by whoever is awake, not by whoever shares the server's
    // timezone; an unlabelled 03:00 next to a cron line that says 03:00 local is a
    // wrong conclusion waiting to be drawn.
    const { body } = renderAlertMessage({ ...BASE });
    expect(body).toContain('UTC');
  });

  it('appends the detail when there is one', () => {
    const { body } = renderAlertMessage({ ...BASE, detail: 'FATAL: 未配置 RESTIC_REPOSITORY' });
    expect(body).toContain('FATAL: 未配置 RESTIC_REPOSITORY');
  });

  it('truncates a detail that is longer than the display cap and says so', () => {
    const detail = 'x'.repeat(ALERT_DETAIL_MAX_CHARS + 500);
    const { body } = renderAlertMessage({ ...BASE, detail });
    expect(body).toContain('已截断');
    // The cap counts rendered characters, not bytes: a pg_restore log is mostly
    // ASCII, but the tail marker must not be what pushes the message over.
    expect(body.length).toBeLessThan(ALERT_DETAIL_MAX_CHARS + 200);
  });

  it('survives a detail with no content at all', () => {
    expect(renderAlertMessage({ ...BASE, detail: '' }).body).toContain('【critical】备份失败');
  });

  it('puts the machine-readable copy in meta, not only in the body', () => {
    const { meta } = renderAlertMessage({ ...BASE, hitCount: 4, fingerprint: 'disk-full-2026-09-15' });
    expect(meta).toEqual({
      alert: {
        source: 'backup',
        title: '备份失败',
        severity: 'critical',
        fingerprint: 'disk-full-2026-09-15',
        hitCount: 4,
        openedAt: '2026-09-15T04:00:11.000Z',
        lastSeenAt: '2026-09-15T04:00:11.000Z',
        truncated: false,
      },
    });
  });

  it('marks truncation in meta so a client can offer the full text later', () => {
    const { meta } = renderAlertMessage({ ...BASE, detail: 'y'.repeat(ALERT_DETAIL_MAX_CHARS + 1) });
    expect(meta.alert.truncated).toBe(true);
  });

  it('escapes nothing, because a chat body is not markup', () => {
    // Recorded so the next reader knows this is deliberate: the web client renders
    // message bodies as text nodes, so <script> inside an alert title arrives as
    // literal characters.
    const { body } = renderAlertMessage({ ...BASE, title: '<b>x</b>' });
    expect(body).toContain('<b>x</b>');
  });
});
