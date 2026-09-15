import type { AlertHook, AlertHookResult, MessageDto } from '@gongyouquan/contracts';
import { HttpError } from '../http/errors.js';
import type { AlertRepository } from './alert-repository.js';

/**
 * The `/hooks/alert` use case: turn a verified alert into a message in the ops
 * group, and tell the sockets about it.
 *
 * Deliberately not `messages.service.send`. That function is the user-facing gate
 * - it insists on a text kind, a UUID clientMsgId, a membership check and the
 * per-user send buckets - and every one of those is wrong for a server-posted
 * system message whose author does not exist as a user. Reusing it would mean
 * either faking a sender or loosening a guard that protects the product against
 * its own users.
 */

export type AlertServiceOptions = {
  /** Existence check only; the alert group is not a permission boundary. */
  groups: { getGroup(groupId: string): Promise<unknown> };
  repo: AlertRepository;
  /** The same bus the user path publishes to, so the ops group behaves like any other. */
  publish?(event: 'message:new' | 'message:updated', message: MessageDto): Promise<void> | void;
  systemGroupId?: string;
};

export function createAlertService(options: AlertServiceOptions) {
  async function requireTargetGroup(): Promise<string> {
    const groupId = options.systemGroupId;
    // Both failures below answer 503 rather than 400: the request is fine, the
    // deployment is not, and the difference is what an operator acts on at 4am.
    if (!groupId) {
      throw new HttpError('OPS_GROUP_NOT_CONFIGURED', {
        reason: 'env-unset',
        hint: '跑 cli/create-admin.ts 建 #运维告警 群，把它打印的 SYSTEM_GROUP_ID 写进 .env',
      });
    }
    if (!(await options.groups.getGroup(groupId))) {
      throw new HttpError('OPS_GROUP_NOT_CONFIGURED', { reason: 'group-not-found', groupId });
    }
    return groupId;
  }

  return {
    async ingest(alert: AlertHook): Promise<AlertHookResult> {
      const groupId = await requireTargetGroup();
      const recorded = await options.repo.record({ ...alert, groupId });

      if (recorded.kind === 'replayed') {
        // No publish: the line is already in the group and every client that was
        // online for it has it. Re-broadcasting would double the bubble.
        return { messageId: recorded.messageId, deduplicated: true };
      }

      if (options.publish) {
        await options.publish(
          recorded.kind === 'created' ? 'message:new' : 'message:updated',
          recorded.message,
        );
      }
      return { messageId: recorded.message.id, deduplicated: false };
    },
  };
}

export type AlertService = ReturnType<typeof createAlertService>;
