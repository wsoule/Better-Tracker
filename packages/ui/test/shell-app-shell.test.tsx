import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CalendarCheck, ChartGantt } from 'lucide-react';

import AppShell from '../src/shell/app-shell';
import { CommandPaletteProvider } from '../src/shell/command-palette';
import type { AppShellProps } from '../src/shell/types';

const KEY = 'test-shell-collapsed';

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

const PROPS: AppShellProps = {
  appName: 'Milestone Planner',
  workspaceName: 'Acme',
  brandHref: '/week',
  nav: [
    {
      id: 'week',
      label: 'My week',
      href: '/week',
      icon: CalendarCheck,
      count: 4,
      countLabel: '4 issues this week',
      current: true,
    },
    {
      id: 'timeline',
      label: 'Timeline',
      href: '/timeline',
      icon: <ChartGantt />,
    },
  ],
  sections: [
    {
      id: 'projects',
      title: 'Projects',
      action: { label: 'All', href: '/projects' },
      items: [
        {
          id: 'atlas',
          label: 'Atlas migration',
          href: '/timeline?project=atlas',
          status: 'overdue',
          statusLabel: 'Overdue',
        },
      ],
    },
  ],
  settings: { href: '/settings' },
  user: { name: 'Pat Lee', badge: 'PM' },
  signOut: { action: '/api/auth/logout', method: 'post' },
  crumbs: [
    { label: 'Timeline', href: '/timeline' },
    { label: 'Atlas migration' },
  ],
  storageKey: KEY,
};

function collapseButton(): HTMLElement {
  return screen.getByRole('button', { name: /sidebar/ });
}

describe('AppShell', () => {
  test('renders the frame with the current page marked', () => {
    render(<AppShell {...PROPS}>Body</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const current = nav.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain('My week');
    expect(current?.textContent).toContain('4 issues this week');
    expect(
      screen.getByRole('link', { name: /Overdue.*Atlas migration/ })
    ).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe(
      'Atlas migration'
    );
    expect(screen.getByRole('main').textContent).toBe('Body');
  });

  test('sign out is a real form post', () => {
    render(<AppShell {...PROPS} />);
    const button = screen.getByRole('button', { name: 'Sign out' });
    const form = button.closest('form');
    expect(form?.getAttribute('action')).toBe('/api/auth/logout');
    expect(form?.getAttribute('method')).toBe('post');
    expect(button.getAttribute('type')).toBe('submit');
  });

  test('"[" collapses the sidebar and the choice persists', () => {
    const first = render(<AppShell {...PROPS} />);
    expect(collapseButton().getAttribute('aria-label')).toBe(
      'Collapse sidebar'
    );
    fireEvent.keyDown(document.body, { key: '[' });
    expect(document.documentElement.dataset.shellCollapsed).toBe('true');
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(collapseButton().getAttribute('aria-label')).toBe('Expand sidebar');
    first.unmount();

    render(<AppShell {...PROPS} />);
    expect(collapseButton().getAttribute('aria-label')).toBe('Expand sidebar');
    expect(document.documentElement.dataset.shellCollapsed).toBe('true');
    fireEvent.click(collapseButton());
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(document.documentElement.dataset.shellCollapsed).toBe('false');
  });

  test('"[" is ignored while typing', () => {
    render(
      <AppShell {...PROPS}>
        <input aria-label="Filter" />
      </AppShell>
    );
    fireEvent.keyDown(screen.getByLabelText('Filter'), { key: '[' });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(collapseButton().getAttribute('aria-label')).toBe(
      'Collapse sidebar'
    );
  });

  test('tolerates storage that throws', () => {
    const original = Storage.prototype.setItem;
    const getOriginal = Storage.prototype.getItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      render(<AppShell {...PROPS} />);
      fireEvent.keyDown(document.body, { key: '[' });
      expect(collapseButton().getAttribute('aria-label')).toBe(
        'Expand sidebar'
      );
    } finally {
      Storage.prototype.setItem = original;
      Storage.prototype.getItem = getOriginal;
    }
  });

  test('the search trigger opens the command palette', () => {
    render(
      <CommandPaletteProvider
        items={[{ id: 'a', label: 'Go to Timeline', section: 'Navigation' }]}
      >
        <AppShell {...PROPS} />
      </CommandPaletteProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect(
      screen.getByRole('dialog', { name: 'Command palette' })
    ).toBeTruthy();
  });

  test('on a phone, More opens the drawer as a modal dialog; Esc closes it', () => {
    const viewport = (
      window as unknown as {
        happyDOM: {
          setViewport: (v: { width: number; height: number }) => void;
        };
      }
    ).happyDOM;
    viewport.setViewport({ width: 390, height: 844 });
    try {
      render(
        <AppShell
          {...PROPS}
          tabs={[
            {
              id: 'week',
              label: 'My week',
              href: '/week',
              icon: CalendarCheck,
              current: true,
            },
          ]}
        />
      );
      const tabs = screen.getByRole('navigation', { name: 'Sections' });
      const more = screen.getByRole('button', { name: 'More' });
      expect(tabs.contains(more)).toBe(true);
      more.focus();
      fireEvent.click(more);
      expect(more.getAttribute('aria-expanded')).toBe('true');
      const drawer = screen.getByRole('dialog', { name: 'Sidebar' });
      expect(drawer.getAttribute('aria-modal')).toBe('true');
      expect(drawer.contains(document.activeElement)).toBe(true);
      // "[" does nothing on a phone (and nothing under a modal).
      fireEvent.keyDown(document.body, { key: '[' });
      expect(localStorage.getItem(KEY)).toBeNull();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(more);
    } finally {
      viewport.setViewport({ width: 1024, height: 768 });
    }
  });

  test('a section action is named with its section ("All Projects")', () => {
    render(<AppShell {...PROPS} />);
    const all = screen.getByRole('link', { name: 'All Projects' });
    expect(all.getAttribute('href')).toBe('/projects');
  });

  test('the shortcuts sheet lists "[" on desktop, not on a phone', () => {
    const view = render(
      <CommandPaletteProvider>
        <AppShell {...PROPS} />
      </CommandPaletteProvider>
    );
    fireEvent.keyDown(document.body, { key: '?' });
    expect(
      screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent
    ).toContain('Collapse or expand the sidebar');
    view.unmount();

    const viewport = (
      window as unknown as {
        happyDOM: {
          setViewport: (v: { width: number; height: number }) => void;
        };
      }
    ).happyDOM;
    viewport.setViewport({ width: 390, height: 844 });
    try {
      render(
        <CommandPaletteProvider>
          <AppShell {...PROPS} />
        </CommandPaletteProvider>
      );
      fireEvent.keyDown(document.body, { key: '?' });
      expect(
        screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent
      ).not.toContain('Collapse or expand the sidebar');
    } finally {
      viewport.setViewport({ width: 1024, height: 768 });
    }
  });
});
