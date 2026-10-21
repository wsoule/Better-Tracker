import { EngineAuthError, EngineInputError } from '@better-tracker/engine';
import { describe, expect, test } from 'bun:test';

import { engineAuthCode, engineInputCode } from '../lib/engine-errors';
import { errorResponse } from '../lib/http';

// Stand-ins for errors thrown by another bundle's copy of the engine: same
// name and code, different class.
class ForeignAuthError extends Error {
  readonly code = 'not_pm';
  constructor() {
    super('Only PMs can do that.');
    this.name = 'EngineAuthError';
  }
}

class ForeignInputError extends Error {
  readonly code = 'not_found';
  constructor() {
    super('No such demo user.');
    this.name = 'EngineInputError';
  }
}

describe('engine error checks across bundle copies', () => {
  test('recognise the real classes', () => {
    expect(engineAuthCode(new EngineAuthError('not_installed', 'x'))).toBe(
      'not_installed'
    );
    expect(engineInputCode(new EngineInputError('conflict', 'x'))).toBe(
      'conflict'
    );
  });

  test('recognise another copy by name and code', () => {
    expect(engineAuthCode(new ForeignAuthError())).toBe('not_pm');
    expect(engineInputCode(new ForeignInputError())).toBe('not_found');
    expect(engineAuthCode(new ForeignInputError())).toBeNull();
    expect(engineAuthCode(new Error('plain'))).toBeNull();
    expect(engineInputCode('not_found')).toBeNull();
  });

  test('errorResponse maps them to their statuses, not 500', async () => {
    const forbidden = errorResponse(new ForeignAuthError());
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: { code: 'not_pm', message: 'Only PMs can do that.' },
    });
    expect(errorResponse(new ForeignInputError()).status).toBe(404);
    expect(
      errorResponse(new EngineAuthError('not_signed_in', 'Sign in.')).status
    ).toBe(401);
  });
});
