import { describe, expect, test } from 'bun:test';

import {
  grantWriteHref,
  installHref,
  withStartWorkspace,
} from '../lib/oauth-links';

// The links that start Linear OAuth for one workspace name the workspace
// the tab shows (owner decision 2026-10-25: a browser holds several), so
// GET /api/auth/linear can refuse a stale tab's install or write grant
// with workspace_changed (architecture §8.1 "Start").

describe('OAuth start links', () => {
  test('grant_write and install name the workspace when given', () => {
    expect(grantWriteHref('/issues/ENG-1', 'org-acme')).toBe(
      '/api/auth/linear?intent=grant_write&returnTo=%2Fissues%2FENG-1&workspace=org-acme'
    );
    expect(installHref('org-acme')).toBe(
      '/api/auth/linear?intent=install&workspace=org-acme'
    );
    // Without one they are what they always were.
    expect(grantWriteHref('/x')).toBe(
      '/api/auth/linear?intent=grant_write&returnTo=%2Fx'
    );
    expect(installHref()).toBe('/api/auth/linear?intent=install');
  });

  test('withStartWorkspace touches start links only, and replaces a value', () => {
    expect(
      withStartWorkspace(
        '/api/auth/linear?intent=grant_write&returnTo=%2Ftimeline&workspace=org-old',
        'org-acme'
      )
    ).toBe(
      '/api/auth/linear?intent=grant_write&returnTo=%2Ftimeline&workspace=org-acme'
    );
    expect(withStartWorkspace('/timeline', 'org-acme')).toBe('/timeline');
    expect(
      withStartWorkspace('/api/auth/linear?intent=install', undefined)
    ).toBe('/api/auth/linear?intent=install');
  });
});
