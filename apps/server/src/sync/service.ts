import type {
  MessageSyncPage,
  ReadPositionDto,
  ReadUpdate,
  SyncHello,
  SyncPull,
  SyncReady,
  SyncStateDto,
} from '@gongyouquan/contracts';
import { HttpError } from '../http/errors.js';
import type { SyncRepository } from './repository.js';

export type SyncServiceOptions = {
  repo: SyncRepository;
  contractVersion: string;
};

/**
 * What hello can answer on its own: watermarks and the contract version. The
 * presence snapshot the full `SyncReady` requires is the runtime's to add, because
 * the runtime owns the in-process presence map and this service owns nothing but
 * the database. Making hello return a whole SyncReady would force it to know
 * about sockets.
 */
export type SyncHelloAnswer = Omit<SyncReady, 'online'>;

export function createSyncService(options: SyncServiceOptions) {
  const { repo, contractVersion } = options;

  /** A non-member is refused with 403, not a silent empty page: spec line 1642. */
  async function watermarkOrForbidden(groupId: string, actor: string): Promise<NonNullable<Awaited<ReturnType<SyncRepository['watermark']>>>> {
    const found = await repo.watermark(groupId, actor);
    if (!found) throw new HttpError('FORBIDDEN_NOT_MEMBER');
    return found;
  }

  return {
    /**
     * Answering only with the groups the caller is still in is what stops hello
     * from becoming an oracle for group existence, and it is also what makes the
     * socket join the right rooms.
     */
    async hello(actor: string, hello: SyncHello): Promise<SyncHelloAnswer> {
      const ids = hello.groups.map((group) => group.groupId);
      const found = await repo.watermarks(actor, ids);
      return {
        groups: found.map((group) => ({ groupId: group.groupId, lastSeq: group.lastSeq })),
        contractVersion,
      };
    },

    async pull(actor: string, pull: SyncPull): Promise<MessageSyncPage> {
      await watermarkOrForbidden(pull.groupId, actor);
      return repo.pullAfter(pull.groupId, pull.sinceSeq, pull.limit);
    },

    async state(actor: string, groupId: string): Promise<SyncStateDto> {
      const found = await watermarkOrForbidden(groupId, actor);
      return {
        lastSeq: found.lastSeq,
        myLastReadSeq: found.myLastReadSeq,
        myMentionsReadSeq: found.myMentionsReadSeq,
      };
    },

    async read(actor: string, update: ReadUpdate): Promise<ReadPositionDto> {
      await watermarkOrForbidden(update.groupId, actor);
      if (update.lastReadSeq === undefined && update.mentionsReadSeq === undefined) {
        throw new HttpError('INVALID_ARGUMENT', { field: 'lastReadSeq or mentionsReadSeq' });
      }
      return repo.advancePosition(update.groupId, actor, update.lastReadSeq, update.mentionsReadSeq);
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
