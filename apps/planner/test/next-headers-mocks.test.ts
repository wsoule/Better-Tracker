import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bun keeps one module namespace per specifier for the whole test run, so
// the first file that mocks next/headers fixes which exports every later
// file can import from it. A mock without `headers` made the public pages
// test fail to load in CI ("Export named 'headers' not found") whenever it
// ran after that file. Every next/headers mock must define both exports.

const dir = import.meta.dir;

/** The `mock.module('next/headers', …)` calls of a test file, as source. */
function nextHeadersMocks(source: string): string[] {
  const calls: string[] = [];
  let from = source.indexOf("mock.module('next/headers'");
  while (from !== -1) {
    const end = source.indexOf('}));', from);
    calls.push(source.slice(from, end === -1 ? undefined : end));
    from = source.indexOf("mock.module('next/headers'", from + 1);
  }
  return calls;
}

describe('next/headers mocks', () => {
  test('every mock defines both cookies and headers', () => {
    // This file names the call in its own source, so it skips itself.
    const files = readdirSync(dir).filter(
      (name) =>
        /\.test\.tsx?$/.test(name) && name !== 'next-headers-mocks.test.ts'
    );
    const incomplete: string[] = [];
    let mocks = 0;
    for (const file of files) {
      for (const call of nextHeadersMocks(
        readFileSync(join(dir, file), 'utf8')
      )) {
        mocks += 1;
        if (!/\bcookies\s*:/.test(call) || !/\bheaders\s*:/.test(call)) {
          incomplete.push(file);
        }
      }
    }
    expect(mocks).toBeGreaterThan(0);
    expect(incomplete).toEqual([]);
  });
});
