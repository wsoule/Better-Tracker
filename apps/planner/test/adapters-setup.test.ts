import { describe, expect, test } from 'bun:test';

import {
  INSTALL_STEPS,
  installationFacts,
  type SetupInstallation,
  setupState,
} from '../lib/adapters/setup';

const INSTALLED: SetupInstallation = {
  workspaceName: 'Northwind Labs',
  urlKey: 'northwind',
  installedByUserId: 'user-ana',
  revokedAt: null,
  createdAt: '2026-10-01T15:00:00.000Z',
  updatedAt: '2026-10-01T15:00:00.000Z',
};

describe('setup', () => {
  test('three states: installed, revoked (dead grant), not installed', () => {
    expect(setupState(INSTALLED)).toBe('installed');
    expect(
      setupState({ ...INSTALLED, revokedAt: '2026-10-20T09:00:00.000Z' })
    ).toBe('revoked');
    expect(setupState(null)).toBe('not_installed');
  });

  test('facts name the workspace, installer and date', () => {
    const facts = installationFacts(INSTALLED, 'Ana Moreno', 'UTC');
    expect(facts.map((f) => f.label)).toEqual([
      'Workspace',
      'Installed by',
      'Installed',
    ]);
    expect(facts[0]?.value).toBe('Northwind Labs · linear.app/northwind');
    expect(facts[1]?.value).toBe('Ana Moreno');
    expect(facts[2]?.value).toBe('Oct 1, 3:00 PM UTC');
  });

  test('a reinstall adds its date; an unknown installer reads generically', () => {
    const facts = installationFacts(
      { ...INSTALLED, updatedAt: '2026-10-15T15:00:00.000Z' },
      null,
      'UTC'
    );
    expect(facts.map((f) => f.label)).toContain('Last reinstalled');
    expect(facts[1]?.value).toBe('A workspace admin');
  });

  // Owner decision 2026-10-22: no PM role. The installer becomes the first
  // watcher, never "a PM"; the steps name no deployment internals
  // (2026-10-25, stranger-facing copy).
  test('install steps make the installer the first watcher, not a PM', () => {
    const copy = INSTALL_STEPS.map((step) => step.body).join(' ');
    expect(copy).not.toMatch(/\bPMs?\b/);
    expect(copy).not.toMatch(/deployment/i);
    expect(INSTALL_STEPS[3]?.body).toContain(
      'The installer becomes the first watcher.'
    );
  });
});
