import type { User } from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  authErrorMessage,
  demoUserRows,
  firstParam,
  LANDING_FEATURES,
} from '../lib/adapters/landing';

function user(id: string, name: string): User {
  return {
    id,
    name,
    displayName: name.toLowerCase(),
    email: `${id}@example.com`,
    avatarUrl: null,
    active: true,
    app: false,
  };
}

describe('landing', () => {
  test('auth errors read as plain sentences', () => {
    expect(authErrorMessage(undefined)).toBeNull();
    expect(authErrorMessage('')).toBeNull();
    expect(authErrorMessage('access_denied')).toMatch(/cancelled/);
    expect(authErrorMessage('session_secret')).toMatch(/SESSION_SECRET/);
    expect(authErrorMessage('linear_network')).toMatch(/Linear could not/);
    expect(authErrorMessage('brand_new')).toBe(
      'Sign-in did not finish (brand_new). Start again.'
    );
  });

  test('a demo person who cannot sign in is told so, not "sign-in is off"', () => {
    expect(authErrorMessage('demo_inactive')).toMatch(/deactivated/);
    expect(authErrorMessage('invalid')).not.toMatch(/not available/);
  });

  test('copy follows the allocation rules (§2.8): Backlog → Todo only, never Triage', () => {
    const allocation = LANDING_FEATURES.find((f) => f.title === 'Allocation');
    expect(allocation?.body).toMatch(/Backlog move to Todo/);
    expect(allocation?.body).toMatch(/Triage issues are never handed out/);
    const rubric = LANDING_FEATURES.find((f) => f.title === 'Rubric');
    expect(rubric?.body).toMatch(/next milestone with a gap stops allocation/);
  });

  test('codes that are not plain words are not echoed back', () => {
    expect(authErrorMessage('<script>alert(1)</script>')).toBe(
      'Sign-in did not finish. Start again.'
    );
  });

  // Owner decision 2026-10-22: no PM role, so the demo picker lists
  // people plainly, by name, with no badge or role column.
  test('demo people: by name, with a first-name action and no role', () => {
    const rows = demoUserRows([
      user('u-cy', 'Cy Diaz'),
      user('u-ben', 'Ben Carter'),
      user('u-al', 'Al Ng'),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['u-al', 'u-ben', 'u-cy']);
    expect(rows[1]).toEqual({
      id: 'u-ben',
      name: 'Ben Carter',
      email: 'u-ben@example.com',
      action: 'Sign in as Ben',
    });
  });

  test('no copy names a PM role, and not_pm is not a known code', () => {
    for (const feature of LANDING_FEATURES) {
      expect(feature.body).not.toMatch(/\bPMs?\b/);
    }
    expect(authErrorMessage('not_pm')).toBe(
      'Sign-in did not finish (not_pm). Start again.'
    );
  });

  test('first search param wins', () => {
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam('a')).toBe('a');
    expect(firstParam(undefined)).toBeUndefined();
  });

  test('lists the design goals in order, each with a key', () => {
    expect(LANDING_FEATURES.map((f) => f.key)).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
    ]);
  });
});
