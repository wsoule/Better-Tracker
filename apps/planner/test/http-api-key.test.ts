// errorResponse and jsonError for api_key mode (architecture §8.1).

import { describe, expect, test } from 'bun:test';

import { errorResponse, jsonError } from '../lib/http';

function engineError(name: string, code: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, { code });
}

describe('errorResponse in api_key mode', () => {
  test('no_reader is a 503 with its sentence, not "signed out"', async () => {
    const response = errorResponse(
      engineError(
        'EngineAuthError',
        'no_reader',
        'No workspace member has a Linear key connected right now.'
      )
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'no_reader',
        message: 'No workspace member has a Linear key connected right now.',
      },
    });
  });

  test('jsonError redacts a credential in its message, in every mode', async () => {
    const response = jsonError(
      502,
      'linear_server',
      'Linear echoed lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc back'
    );
    const text = await response.text();
    expect(text).not.toContain('TESTKEY');
    expect(text).toContain('lin_api_[redacted]');
  });
});
