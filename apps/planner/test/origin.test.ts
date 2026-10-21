import { describe, expect, test } from 'bun:test';

import { rejectCrossOrigin } from '../lib/origin';

const APP_URL = 'https://planner.example.com';

function request(headers: Record<string, string>, url = `${APP_URL}/api/x`) {
  return new Request(url, { method: 'POST', headers });
}

describe('rejectCrossOrigin', () => {
  test('allows the configured public origin', () => {
    expect(rejectCrossOrigin(request({ origin: APP_URL }), APP_URL)).toBeNull();
  });

  test('allows the origin the request arrived on (e.g. a dev port)', () => {
    const req = request(
      { origin: 'http://localhost:3010' },
      'http://localhost:3010/api/x'
    );
    expect(rejectCrossOrigin(req, 'http://localhost:3000')).toBeNull();
  });

  test('refuses a foreign origin with 403', async () => {
    const res = rejectCrossOrigin(
      request({ origin: 'https://evil.example' }),
      APP_URL
    );
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({
      error: { code: 'cross_origin', message: 'Cross-origin request refused.' },
    });
  });

  test('without Origin, requires Sec-Fetch-Site same-origin', () => {
    expect(
      rejectCrossOrigin(request({ 'sec-fetch-site': 'same-origin' }), APP_URL)
    ).toBeNull();
    expect(
      rejectCrossOrigin(request({ 'sec-fetch-site': 'cross-site' }), APP_URL)
        ?.status
    ).toBe(403);
    expect(rejectCrossOrigin(request({}), APP_URL)?.status).toBe(403);
  });

  test('a malformed APP_URL only narrows the allow-list', () => {
    const req = request({ origin: APP_URL });
    expect(rejectCrossOrigin(req, 'not a url')).toBeNull();
  });
});
