import type { AlertSeverity } from '@gongyouquan/contracts';

/**
 * The group message an alert turns into.
 *
 * Split out from the repository because this is the only part of the alert path a
 * reader of the ops group actually sees, and it is pure: the truncation rule, the
 * count rule and the timezone rule are all assertable without a database, and the
 * repository stays a transaction.
 */

/**
 * Display cap for `detail`. The contract accepts 20 KB so a sender never loses an
 * alert to a length check; this is where the length is dealt with instead, by
 * showing the head of it and saying the rest was cut. A pg_restore log can be
 * tens of kilobytes, and a chat bubble holding all of it is unreadable in the one
 * place that has to be readable in a hurry.
 */
export const ALERT_DETAIL_MAX_CHARS = 1000;

export type AlertRenderInput = {
  source: string;
  title: string;
  severity: AlertSeverity;
  hitCount: number;
  /** ISO strings; the database clock produced them, so they are already absolute. */
  openedAt: string;
  lastSeenAt: string;
  detail?: string | null;
  fingerprint?: string | null;
};

export type AlertMessageMeta = {
  alert: {
    source: string;
    title: string;
    severity: AlertSeverity;
    fingerprint: string | null;
    hitCount: number;
    openedAt: string;
    lastSeenAt: string;
    /** True when `detail` was cut for display. The full text is not stored. */
    truncated: boolean;
  };
};

function clockOf(iso: string): string {
  const asDate = new Date(iso);
  // An unparseable stamp used to print "NaN:NaN:NaN" into the ops group, which is
  // the worst possible thing for the one line that tells you what went wrong.
  if (Number.isNaN(asDate.getTime())) return iso;
  return asDate.toISOString().slice(11, 19);
}

export function renderAlertMessage(input: AlertRenderInput): { body: string; meta: AlertMessageMeta } {
  const headline =
    input.hitCount > 1
      ? `【${input.severity}】${input.title} ×${input.hitCount}`
      : `【${input.severity}】${input.title}`;

  const opened = clockOf(input.openedAt);
  const lastSeen = clockOf(input.lastSeenAt);
  const when = opened === lastSeen ? `${opened} UTC` : `${opened} → ${lastSeen} UTC`;

  const lines = [headline, `${input.source} · ${when}`];

  const detail = input.detail ?? '';
  let truncated = false;
  if (detail !== '') {
    if (detail.length > ALERT_DETAIL_MAX_CHARS) {
      truncated = true;
      lines.push(detail.slice(0, ALERT_DETAIL_MAX_CHARS) + '…（已截断）');
    } else {
      lines.push(detail);
    }
  }

  return {
    body: lines.join('\n'),
    meta: {
      alert: {
        source: input.source,
        title: input.title,
        severity: input.severity,
        fingerprint: input.fingerprint ?? null,
        hitCount: input.hitCount,
        openedAt: input.openedAt,
        lastSeenAt: input.lastSeenAt,
        truncated,
      },
    },
  };
}
