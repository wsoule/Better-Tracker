import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { shareableLink } from '../app/(app)/components/workspace-frame';

// "Copy link" actions name the workspace the link is for (architecture §7
// "Links that leave the app", owner decision 2026-10-25: a browser holds
// several workspaces and keys repeat across them, so a pasted
// /issues/ENG-1 would open whichever ENG-1 the browser has active).

const ORIGIN = 'http://localhost:3480';

describe('shareableLink', () => {
  test('a planner path on the origin, with ws=<org id>', () => {
    expect(shareableLink('/issues/ENG-1', ORIGIN, 'org-acme')).toBe(
      `${ORIGIN}/issues/ENG-1?ws=org-acme`
    );
    expect(
      shareableLink('/issues?q=export&issue=ENG-1', ORIGIN, 'org-acme')
    ).toBe(`${ORIGIN}/issues?q=export&issue=ENG-1&ws=org-acme`);
    expect(
      shareableLink('/timeline?milestone=m1#entries', ORIGIN, 'org-globex')
    ).toBe(`${ORIGIN}/timeline?milestone=m1&ws=org-globex#entries`);
    // The page's own URL (window.location.href) works the same way.
    expect(
      shareableLink(`${ORIGIN}/issues?state=all`, ORIGIN, 'org-acme')
    ).toBe(`${ORIGIN}/issues?state=all&ws=org-acme`);
  });

  test('personal API keys (and outside the shell) name no workspace', () => {
    expect(shareableLink('/issues/ENG-1', ORIGIN, undefined)).toBe(
      `${ORIGIN}/issues/ENG-1`
    );
  });
});

describe('every Copy link action', () => {
  test('builds its URL with useShareableLink', () => {
    const root = join(import.meta.dir, '..', 'app', '(app)');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const copying = files.filter((path) => {
      const text = readFileSync(path, 'utf8');
      // The graph's Mermaid source is text, not a link.
      return (
        text.includes('clipboard.writeText(url)') ||
        /clipboard\.writeText\([^)]*(href|origin|URL)/.test(text)
      );
    });
    expect(copying.length).toBeGreaterThanOrEqual(3);
    const unnamed = copying
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        return (
          !text.includes('useShareableLink()') ||
          text.includes('window.location.origin') ||
          /const url = window\.location\.href/.test(text)
        );
      })
      .map((path) => relative(root, path));
    expect(unnamed).toEqual([]);
  });
});
