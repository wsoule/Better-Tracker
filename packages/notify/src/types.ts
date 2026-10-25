import type { Digest } from '@better-tracker/core';

export interface DeliveryContext {
  appName: string;
  appUrl: string;
  /**
   * The workspace the digest is about (its Linear org id): the links the
   * renderer builds itself carry `ws=<it>` (core's withWorkspaceParam), as
   * the digest's own links do, so a browser that holds several workspaces
   * opens them in the right one.
   */
  workspaceId: string;
}

export type DeliveryResult =
  | { status: 'sent'; channel: 'slack'; detail: string | null }
  | { status: 'failed'; channel: 'slack' | 'outbox'; detail: string }
  /** The person has no reachable account on the channel. */
  | { status: 'undeliverable'; channel: 'slack' | 'outbox'; detail: string };

/** Delivers one person's daily digest. */
export interface NotificationChannel {
  readonly name: 'slack' | 'outbox';
  /** Whether send() can actually reach people (false for the outbox). */
  readonly delivers: boolean;
  send(digest: Digest, context: DeliveryContext): Promise<DeliveryResult>;
}
