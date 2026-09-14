import type { MentionPublisher, MessageEvent, MessagePublisher } from './service.js';

/**
 * The write path is built before Socket.IO exists, and Socket.IO is what knows
 * how to reach a room, so the two meet here: main.ts hands the messages service
 * this bus, and buildApp attaches the real emitter once the server is up.
 *
 * Nothing attached means publishing is a no-op - correct for unit tests that
 * never open a socket, and it keeps Socket.IO out of src/messages entirely.
 */
export type BusListener = (event: MessageEvent, message: import('@gongyouquan/contracts').MessageDto) => void;

/**
 * A personal event for one user's own room. `mention:new` travels here rather than
 * on the group channel because line 758 puts it in `user:{uid}`: being mentioned has
 * to reach you whichever room you happen to be looking at, including one in a
 * different group.
 */
export type UserBusListener = (
  event: 'mention:new',
  payload: import('@gongyouquan/contracts').MentionNewEvent,
  toUserId: string,
) => void;

export type MessageBus = {
  /** Pass straight to createMessagesService({ publish }). */
  publish: MessagePublisher;
  /** Pass straight to createMessagesService({ publishMention }). */
  publishToUser: MentionPublisher;
  attach(listener: BusListener): () => void;
  attachToUser(listener: UserBusListener): () => void;
};

export function createMessageBus(): MessageBus {
  const listeners = new Set<BusListener>();
  const userListeners = new Set<UserBusListener>();
  return {
    async publish(event, message) {
      for (const listener of listeners) listener(event, message);
    },
    async publishToUser(event, toUserId) {
      for (const listener of userListeners) listener('mention:new', event, toUserId);
    },
    attach(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attachToUser(listener) {
      userListeners.add(listener);
      return () => {
        userListeners.delete(listener);
      };
    },
  };
}
