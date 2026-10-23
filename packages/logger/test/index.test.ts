import { describe, expect, test } from 'bun:test';

import { createLogger, type LogLevel } from '../src/index';

function capture(level?: LogLevel) {
  const lines: { level: LogLevel; data: Record<string, unknown> }[] = [];
  const logger = createLogger({
    name: 'test',
    level,
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    sink: (lvl, line) => lines.push({ level: lvl, data: JSON.parse(line) }),
  });
  return { logger, lines };
}

describe('createLogger', () => {
  test('writes one JSON object per line with time, level, logger, msg', () => {
    const { logger, lines } = capture();
    logger.info('synced', { issues: 12 });
    expect(lines).toEqual([
      {
        level: 'info',
        data: {
          time: '2026-10-21T12:00:00.000Z',
          level: 'info',
          logger: 'test',
          msg: 'synced',
          issues: 12,
        },
      },
    ]);
  });

  test('drops lines below the threshold', () => {
    const { logger, lines } = capture('warn');
    logger.info('ignored');
    logger.warn('kept');
    expect(lines.map((l) => l.data.msg)).toEqual(['kept']);
  });

  test('redacts credential-looking keys at any depth', () => {
    const { logger, lines } = capture();
    logger.info('oauth', {
      accessToken: 'lin_oauth_abc',
      nested: { refresh_token: 'r', clientSecret: 's', tokenCount: 3 },
      headers: { authorization: 'Bearer x', cookie: 'mp_session=1' },
    });
    const data = lines[0].data;
    expect(data.accessToken).toBe('[redacted]');
    expect(data.nested).toEqual({
      refresh_token: '[redacted]',
      clientSecret: '[redacted]',
      tokenCount: 3,
    });
    expect(data.headers).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
    });
  });

  test('serialises errors and survives cycles', () => {
    const { logger, lines } = capture();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    logger.error('failed', { err: new Error('boom'), cyclic });
    const data = lines[0].data as {
      err: { name: string; message: string };
      cyclic: { self: string };
    };
    expect(data.err.name).toBe('Error');
    expect(data.err.message).toBe('boom');
    expect(data.cyclic.self).toBe('[circular]');
  });

  test('child loggers bind fields', () => {
    const { logger, lines } = capture();
    logger.child({ workspaceId: 'w1' }).child({ runId: 'r1' }).info('run');
    expect(lines[0].data.workspaceId).toBe('w1');
    expect(lines[0].data.runId).toBe('r1');
  });

  test('redacts Linear credential-shaped values everywhere', () => {
    const { logger, lines } = capture();
    const key = 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc';
    const cause = new Error(`inner ${key}`);
    const error = new Error(`outer ${key}`, { cause });
    logger.error(`message with ${key}`, {
      nested: { list: [`item ${key}`, 'plain'] },
      error,
    });
    const text = JSON.stringify(lines[0].data);
    expect(text).not.toContain('TESTKEY');
    expect(text).toContain('lin_api_[redacted]');
    const data = lines[0].data as {
      msg: string;
      nested: { list: string[] };
      error: {
        message: string;
        stack: string;
        cause: { message: string; stack: string };
      };
    };
    expect(data.msg).toBe('message with lin_api_[redacted]');
    expect(data.nested.list).toEqual(['item lin_api_[redacted]', 'plain']);
    expect(data.error.message).toBe('outer lin_api_[redacted]');
    expect(data.error.stack).not.toContain('TESTKEY');
    expect(data.error.cause.message).toBe('inner lin_api_[redacted]');
  });

  test('redacts key and apiKey by name, keeps keyCount', () => {
    const { logger, lines } = capture();
    logger.info('fields', {
      apiKey: 'anything',
      key: 'anything',
      credential: 'anything',
      keyCount: 3,
    });
    expect(lines[0].data.apiKey).toBe('[redacted]');
    expect(lines[0].data.key).toBe('[redacted]');
    expect(lines[0].data.credential).toBe('[redacted]');
    expect(lines[0].data.keyCount).toBe(3);
  });

  test('leaves ordinary words about bearers alone', () => {
    const { logger, lines } = capture();
    logger.warn('Bearer token refresh fails', { note: 'bearer of bad news' });
    expect(lines[0].data.msg).toBe('Bearer token refresh fails');
    expect(lines[0].data.note).toBe('bearer of bad news');
  });
});
