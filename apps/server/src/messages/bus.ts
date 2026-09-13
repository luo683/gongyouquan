import type { MessageEvent, MessagePublisher } from './service.js';

/**
 * The write path is built before Socket.IO exists, and Socket.IO is what knows
 * how to reach a room, so the two meet here: main.ts hands the messages service
 * this bus, and buildApp attaches the real emitter once the server is up.
 *
 * Nothing attached means publishing is a no-op - correct for unit tests that
 * never open a socket, and it keeps Socket.IO out of src/messages entirely.
 */
export type BusListener = (event: MessageEvent, message: import('@gongyouquan/contracts').MessageDto) => void;

export type MessageBus = {
  /** Pass straight to createMessagesService({ publish }). */
  publish: MessagePublisher;
  attach(listener: BusListener): () => void;
};

export function createMessageBus(): MessageBus {
  const listeners = new Set<BusListener>();
  return {
    async publish(event, message) {
      for (const listener of listeners) listener(event, message);
    },
    attach(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
