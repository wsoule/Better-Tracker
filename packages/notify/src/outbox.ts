// The channel used when Slack is not configured. It reaches nobody: the
// engine records the digest with status `preview`, so it stays readable in
// the app's outbox (Settings → notification history) instead of vanishing.

import type { NotificationChannel } from './types';

/** A channel that never delivers and says so in every result. */
export function createOutboxChannel(): NotificationChannel {
  return {
    name: 'outbox',
    delivers: false,
    send: () =>
      Promise.resolve({
        status: 'undeliverable',
        channel: 'outbox',
        detail: 'Slack is not configured; digest kept in the outbox',
      }),
  };
}
