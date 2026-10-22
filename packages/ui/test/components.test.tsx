import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import {
  type BlockBarProps,
  type PickerMarkViewProps,
  type StatusMarkProps,
  type TabItem,
  Tabs,
  type TabsProps,
  ThemeToggle,
  type ThemeToggleProps,
  type UiLinkProviderProps,
} from '../src/index';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

const items: TabItem[] = [
  { id: 'overview', label: 'Overview', content: 'First panel' },
  { id: 'more', label: 'More', content: 'Second panel' },
];

describe('Tabs', () => {
  test('two strips with the same item ids keep their own tab/panel pairs', () => {
    render(
      <>
        <Tabs items={items} label="Milestone sections" />
        <Tabs items={items} />
      </>
    );
    const ids = Array.from(document.querySelectorAll('[id]')).map(
      (el) => el.id
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of screen.getAllByRole('tab')) {
      const panel = document.getElementById(
        tab.getAttribute('aria-controls') ?? ''
      );
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    expect(
      screen.getByRole('tablist', { name: 'Milestone sections' })
    ).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
  });

  test('an empty list renders nothing instead of throwing', () => {
    expect(renderToString(<Tabs items={[]} />)).toBe('');
  });

  test('arrow keys still move the selection', () => {
    render(<Tabs items={items} />);
    const [first, second] = screen.getAllByRole('tab');
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Second panel').hidden).toBe(false);
  });
});

describe('ThemeToggle', () => {
  function withOsDark(dark: boolean, run: () => void) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: dark && query.includes('dark'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      run();
    } finally {
      window.matchMedia = original;
    }
  }

  test('in "system" mode it flips to the opposite of what the OS shows', () => {
    withOsDark(true, () => {
      document.documentElement.dataset.theme = 'system';
      render(<ThemeToggle storageKey="bt-test-theme" />);
      fireEvent.click(screen.getByRole('button'));
      expect(document.documentElement.dataset.theme).toBe('light');
    });
  });

  test('otherwise it flips light and dark', () => {
    document.documentElement.dataset.theme = 'dark';
    render(<ThemeToggle storageKey="bt-test-theme" />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

// Every public component's props are a named, exported type (a host
// wrapping one needs no ComponentProps<typeof …>). Checked by tsc.
export type PublicProps = [
  BlockBarProps,
  PickerMarkViewProps,
  StatusMarkProps,
  TabsProps,
  ThemeToggleProps,
  UiLinkProviderProps,
];
