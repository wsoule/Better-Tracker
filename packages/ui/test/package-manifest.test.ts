import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Hosts in another repository (Dispatch) install this package from the
// tarball `pnpm pack` makes (README "Installing from another repository"):
// pnpm writes exact versions for `catalog:` there, and `files` decides what
// ships. So every export must point inside the shipped files, tests and repo
// config stay out, and nothing may depend on an unpublished workspace
// package, which would not resolve outside this repository.

interface Manifest {
  files?: string[];
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const root = path.join(import.meta.dir, '..');
const manifest = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8')
) as Manifest;
const files = manifest.files ?? [];

/** Whether a package-relative path is inside one of the `files` entries. */
function ships(target: string): boolean {
  const relative = target.replace(/^\.\//, '');
  return files.some(
    (entry) => relative === entry || relative.startsWith(`${entry}/`)
  );
}

describe('the packed tarball', () => {
  test('lists its files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(Object.entries(manifest.exports))(
    'ships the target of export %s',
    (_name, target) => {
      expect(ships(target)).toBe(true);
    }
  );

  test.each(['test/setup.ts', 'moon.yml', 'tsconfig.json', 'bunfig.toml'])(
    'leaves %s out',
    (file) => {
      expect(ships(file)).toBe(false);
    }
  );

  test('depends on no workspace package, and on React only as a peer', () => {
    const dependencies = Object.entries(manifest.dependencies ?? {});
    expect(
      dependencies.filter(
        ([name, spec]) =>
          name.startsWith('@better-tracker/') || spec.startsWith('workspace:')
      )
    ).toEqual([]);
    expect(manifest.dependencies?.['react']).toBeUndefined();
    expect(manifest.dependencies?.['react-dom']).toBeUndefined();
    expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual([
      'react',
      'react-dom',
    ]);
  });
});
