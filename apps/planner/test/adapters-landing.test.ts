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

describe('landing with personal API keys', () => {
  test('every connect code has its own sentence', async () => {
    const { authErrorMessage: message } =
      await import('../lib/adapters/landing');
    for (const code of [
      'key_shape',
      'key_rejected',
      'key_cannot_read',
      'key_wrong_workspace',
      'guest_cannot_bind',
      'connect_rate_limited',
      'insecure_transport',
      'key_capacity',
      'linear_unreachable',
    ]) {
      const sentence = message(code, { apiKeyMode: true }) ?? '';
      expect(sentence).not.toBe('');
      expect(sentence).not.toContain(code);
      expect(sentence).not.toMatch(/Start again\.$/);
    }
    expect(message('key_shape', { apiKeyMode: true })).toContain('lin_api_');
  });

  test('not_signed_in, read_only and wrong_workspace read for keys', async () => {
    const { authErrorMessage: message } =
      await import('../lib/adapters/landing');
    expect(message('not_signed_in', { apiKeyMode: true })).toBe(
      'That Linear account cannot connect: it is deactivated, or it is an app user rather than a person.'
    );
    const readOnly = message('read_only', { apiKeyMode: true }) ?? '';
    expect(readOnly).not.toMatch(/install/i);
    expect(message('wrong_workspace', { apiKeyMode: true })).toBe(
      'That key belongs to a different Linear workspace from the one this planner serves.'
    );
    // OAuth keeps its own wording.
    expect(message('read_only')).toMatch(/install the app/);
  });

  test('landingFeatures: allocation and warnings variants; OAuth unchanged', async () => {
    const { landingFeatures } = await import('../lib/adapters/landing');
    expect(landingFeatures({ apiKeyMode: false })).toBe(LANDING_FEATURES);
    const keyed = landingFeatures({ apiKeyMode: true });
    expect(keyed.map((f) => f.key)).toEqual(LANDING_FEATURES.map((f) => f.key));
    const allocation = keyed.find((f) => f.title === 'Allocation');
    expect(allocation?.body).toContain(
      'runs when someone starts it, over what they can see, written as that person in Linear.'
    );
    const warnings = keyed.find((f) => f.title === 'Warnings');
    expect(warnings?.body).toStartWith(
      'Preview only: no digests are sent with personal API keys.'
    );
    for (const feature of keyed)
      expect(feature.body).not.toMatch(/sign(ed)? in/i);
  });
});
