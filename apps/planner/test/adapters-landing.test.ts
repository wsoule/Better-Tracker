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
  test('demo people: by name, with initials and no role', () => {
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
      label: null,
    });
  });

  // Owner decision 2026-10-22, "Guests limited to read only": a Linear
  // guest is labelled Guest (Linear's own flag, not a planner role) and
  // keeps their place by name.
  test('a Linear guest is labelled Guest', () => {
    const rows = demoUserRows([
      user('u-ben', 'Ben Carter'),
      { ...user('u-gus', 'Gus Hart'), guest: true },
    ]);
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      ['u-ben', null],
      ['u-gus', 'Guest'],
    ]);
  });

  test('read_only says why a guest cannot install or allow edits', () => {
    expect(authErrorMessage('read_only')).toMatch(/guest in Linear/);
    expect(authErrorMessage('read_only')).toMatch(/read-only/);
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

  // The sign-in list draws each person as a round initials avatar
  // (Gr8r's account rows), from the full name.
  // The Gr8r restyle (2026-10-22) shows no section or row numbers: the
  // features are cards keyed by a stable id that picks each card's icon.
  test('lists the design goals in order, each with a stable id', () => {
    expect(LANDING_FEATURES.map((f) => f.key)).toEqual([
      'my-week',
      'timeline',
      'dependencies',
      'allocation',
      'warnings',
      'rubric',
    ]);
  });
});
