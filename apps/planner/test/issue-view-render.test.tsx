import {
  ToastProvider,
  UiLinkProvider,
  type UiLinkProps,
} from '@better-tracker/ui';
import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { extrasFor, detailOf, modelFor } from './issue-fixture';

// The issue view's client islands rendered to HTML (no browser): which
// controls a person gets is decided by the model's canEdit, and the
// read-only view offers the grant_write link instead. next/navigation's
// hooks need a mounted app router, so they are replaced here (the rest of
// the module stays real: module mocks outlive this file).

const realNavigation = await import('next/navigation');
void mock.module('next/navigation', () => ({
  ...realNavigation,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/week',
  useSearchParams: () => new URLSearchParams('issue=ENG-24'),
}));

const { default: IssuePageView } =
  await import('../app/(app)/issues/[id]/issue-page-view');
const { IssueDrawer, useIssueDrawerState } =
  await import('../app/(app)/components/issue-drawer');

function PlainLink({ children, ...rest }: UiLinkProps) {
  return <a {...rest}>{children}</a>;
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <UiLinkProvider link={PlainLink}>
      <ToastProvider>{node}</ToastProvider>
    </UiLinkProvider>
  );
}

describe('the issue page view', () => {
  test('with write access: every edit control, no grant notice', () => {
    const html = render(<IssuePageView model={modelFor('ENG-24')} />);
    for (const name of [
      'Status: Todo',
      'Assignee: Ana Moreno',
      'Priority: Medium',
      'Project: Beacon search',
      'Milestone: Search v2 beta',
      'Add blocked by',
      'Add blocks',
    ]) {
      expect(html).toContain(`aria-label="${name}"`);
    }
    expect(html).toContain('aria-label="New comment"');
    expect(html).toContain('Markdown source · saved to Linear as you');
    expect(html).not.toContain('Allow edits in Linear');
  });

  test('without write access: read-only values and the grant_write link', () => {
    const model = modelFor('ENG-24', { canEdit: false });
    const html = render(<IssuePageView model={model} />);
    expect(html).toContain('Allow edits in Linear');
    expect(html).toContain(
      'href="/api/auth/linear?intent=grant_write&amp;returnTo=%2Fx"'
    );
    expect(html).not.toContain('aria-label="Priority:');
    expect(html).not.toContain('aria-label="Add blocked by"');
    expect(html).not.toContain('aria-label="New comment"');
    expect(html).toContain('Medium');
    // The description is printed as text, never as markup.
    expect(html).toContain('Line one');
  });

  // Owner decision 2026-10-22, "Guests limited to read only".
  test('a Linear guest: read-only values, one notice, no grant link', () => {
    const model = modelFor('ENG-24', { canEdit: false, readOnly: true });
    const html = render(<IssuePageView model={model} />);
    expect(html).toContain(
      'You are a guest in Linear, so this view is read-only.'
    );
    expect(html).not.toContain('Allow edits in Linear');
    expect(html).not.toContain('intent=grant_write');
    expect(html).not.toContain('aria-label="Priority:');
    expect(html).not.toContain('aria-label="Status:');
    expect(html).not.toContain('aria-label="Assignee:');
    expect(html).not.toContain('aria-label="Add blocked by"');
    expect(html).not.toContain('aria-label="Add blocks"');
    expect(html).not.toContain('aria-label="New comment"');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<input');
    // What Linear shows the guest is still there.
    expect(html).toContain('Medium');
    expect(html).toContain('Line one');
  });

  test('when Linear cannot be read, the live fields are not editable', () => {
    const model = modelFor('ENG-24', {
      extra: null,
      labels: [],
      estimateScale: null,
      estimateOptions: [],
      extraError: 'Linear did not answer.',
      extraSource: null,
    });
    const html = render(<IssuePageView model={model} />);
    expect(html).toContain('Linear did not answer.');
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('aria-label="Labels');
    // The mirror's fields stay editable.
    expect(html).toContain('aria-label="Priority: Medium"');
  });

  test('a markdown description with HTML is printed as text', () => {
    const detail = detailOf('ENG-24');
    const model = modelFor('ENG-24', {
      canEdit: false,
      extra: extrasFor(detail, { description: '<b>bold</b> **md**' }),
    });
    const html = render(<IssuePageView model={model} />);
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; **md**');
    expect(html).not.toContain('<b>bold</b>');
  });

  // Titles, descriptions, comments and authors come from Linear, where
  // anyone may type anything; the editable view (the editors' read faces,
  // the comment list) prints them as text too.
  test('markup in Linear text is printed as text in the editable view', () => {
    const detail = detailOf('ENG-24');
    const payload = '<img src=x onerror=alert(1)>';
    const base = extrasFor(detail);
    const model = modelFor('ENG-24', {
      detail: { ...detail, issue: { ...detail.issue, title: payload } },
      extra: {
        ...base,
        description: `${payload} in the description`,
        comments: base.comments.map((comment) => ({
          ...comment,
          body: `${payload} in a comment`,
          author: { id: 'user-x', name: `${payload} author` },
        })),
      },
    });
    for (const html of [
      render(<IssuePageView model={model} />),
      render(<IssuePageView model={{ ...model, canEdit: false }} />),
    ]) {
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; in a comment');
      expect(html).toContain(
        '&lt;img src=x onerror=alert(1)&gt; in the description'
      );
    }
  });
});

describe('the issue slide-over', () => {
  function Drawer({
    param,
    model,
  }: {
    param: string;
    model: ReturnType<typeof modelFor> | null;
  }) {
    const state = useIssueDrawerState({ param, model });
    return <IssueDrawer state={state} />;
  }

  test('renders the issue with its trail and the page link', () => {
    const html = render(<Drawer param="ENG-24" model={modelFor('ENG-24')} />);
    expect(html).toContain('Search analytics events');
    expect(html).toContain('Beacon search');
    expect(html).toContain('href="/issues/ENG-24"');
    expect(html).toContain('aria-label="Open ENG-24 as a page"');
    expect(html).toContain('aria-label="Close issue"');
  });

  test('an issue the planner does not hold says so', () => {
    const html = render(<Drawer param="ENG-999" model={null} />);
    expect(html).toContain('Issue not found');
    expect(html).toContain('ENG-999 is not in the planner.');
  });
});
