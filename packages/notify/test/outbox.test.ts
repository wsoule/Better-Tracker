import { describe, expect, test } from 'bun:test';

import * as notify from '../src/index';
import { createOutboxChannel } from '../src/outbox';
import { CONTEXT, makeDigest, makeItem } from './helpers';

describe('createOutboxChannel', () => {
  test('never delivers and says why', async () => {
    const channel = createOutboxChannel();
    expect(channel.name).toBe('outbox');
    expect(channel.delivers).toBe(false);
    expect(await channel.send(makeDigest([makeItem()]), CONTEXT)).toEqual({
      status: 'undeliverable',
      channel: 'outbox',
      detail: 'Slack is not configured; digest kept in the outbox',
    });
  });
});

describe('package entry point', () => {
  test('exports the channels and the renderer', () => {
    expect(typeof notify.createSlackChannel).toBe('function');
    expect(typeof notify.createOutboxChannel).toBe('function');
    expect(typeof notify.renderDigest).toBe('function');
  });
});
