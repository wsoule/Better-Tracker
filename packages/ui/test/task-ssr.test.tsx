import { describe, expect, test } from 'bun:test';
import path from 'node:path';

// Server rendering of the task family without a DOM. The test process has
// happy-dom registered (test/setup.ts), which would hide any `window` or
// `document` read during render, so the render runs in a child process.

interface SsrResult {
  hasWindow: boolean;
  hasDocument: boolean;
  page: string;
  drawer: string;
}

function serverRender(): SsrResult {
  const entry = path.join(import.meta.dir, 'task-ssr-entry.tsx');
  const child = Bun.spawnSync([process.execPath, 'run', entry], {
    cwd: path.join(import.meta.dir, '..'),
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (child.exitCode !== 0) {
    throw new Error(`server render failed:\n${child.stderr.toString()}`);
  }
  return JSON.parse(child.stdout.toString()) as SsrResult;
}

describe('task family server render', () => {
  const result = serverRender();

  test('renders with no window or document', () => {
    expect(result.hasWindow).toBe(false);
    expect(result.hasDocument).toBe(false);
  });

  test('the page layout carries every section, the description as text', () => {
    const html = result.page;
    expect(html).toContain('data-layout="page"');
    expect(html).toContain('Search analytics events');
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('Stalled');
    expect(html).toContain('Ana Moreno');
    expect(html).toContain('Typo tolerance');
    expect(html).toContain('Flagged as stalled');
    // Escaped, never markup.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    // The long text is clamped on the server already (the first guess).
    expect(html).toContain('data-clamped="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Show more');
  });

  test('the slide-over renders open with the task inside', () => {
    const html = result.drawer;
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Search analytics events');
    expect(html).toContain('data-layout="drawer"');
    expect(html).toContain('Typo tolerance');
  });
});
