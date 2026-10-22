import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  parseCollapsed,
  serializeCollapsed,
  type TaskGroupData,
  TaskGroupTable,
  type TaskRowData,
  type TaskSectionData,
  toggleCollapsed,
  UiLinkProvider,
  type UiLinkProps,
} from '../src/index';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
});

function HostLink({ children, ...rest }: UiLinkProps) {
  return (
    <a {...rest} data-host-link="">
      {children}
    </a>
  );
}

function row(id: string, extra: Partial<TaskRowData> = {}): TaskRowData {
  return {
    id,
    key: id.toUpperCase(),
    title: `Issue ${id}`,
    href: `/issues/${id}`,
    project: 'Atlas',
    state: 'Todo',
    stateKind: 'unstarted',
    priority: 3,
    priorityLabel: 'Medium',
    due: 'Oct 23',
    ...extra,
  };
}

const SECTIONS: TaskSectionData[] = [
  {
    id: 'week',
    label: 'This week',
    groups: [
      {
        id: 'g1',
        eyebrow: 'Atlas',
        title: 'Cutover',
        href: '/timeline?milestone=g1',
        status: 'overdue',
        statusLabel: 'Overdue',
        dueLabel: 'Oct 19',
        daysLeftLabel: '2 days overdue',
        dueTone: 'accent',
        progress: { done: 4, total: 7 },
        rows: [
          row('a-1', {
            chips: [
              {
                label: 'New — given to you because you lead Atlas',
                tone: 'accent',
              },
            ],
          }),
          row('a-2', {
            stateKind: 'started',
            state: 'In Progress',
            priority: 1,
            priorityLabel: 'Urgent',
          }),
        ],
      },
      {
        id: 'g2',
        eyebrow: 'Beacon',
        title: 'Public beta',
        rows: [
          row('b-1', {
            href: 'https://linear.app/x/issue/B-1',
            external: true,
            stateKind: 'triage',
            state: 'Triage',
          }),
        ],
      },
    ],
  },
  {
    id: 'none',
    label: 'No milestone',
    groups: [{ id: 'g3', title: 'Unplanned', rows: [row('c-1')] }],
  },
];

function renderTable(
  props: Partial<Parameters<typeof TaskGroupTable>[0]> = {}
) {
  return render(
    <UiLinkProvider link={HostLink}>
      <TaskGroupTable sections={SECTIONS} label="My issues" {...props} />
    </UiLinkProvider>
  );
}

const toggleOf = (name: string) => (el: ReturnType<typeof renderTable>) =>
  el.getByRole('button', { name });

describe('TaskGroupTable structure', () => {
  test('sections and groups are headings; rows are links via the host', () => {
    const view = renderTable();
    expect(view.getByRole('group', { name: 'My issues' })).toBeTruthy();
    expect(view.getByRole('heading', { name: /This week/ })).toBeTruthy();
    expect(view.getByRole('heading', { name: /No milestone/ })).toBeTruthy();
    const link = view.getByRole('link', { name: 'Issue a-1' });
    expect(link.getAttribute('href')).toBe('/issues/a-1');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    // The milestone title links through the host too.
    const group = view.getByRole('link', { name: 'Cutover' });
    expect(group.getAttribute('href')).toBe('/timeline?milestone=g1');
    expect(group.hasAttribute('data-host-link')).toBe(true);
  });

  test('section notes count issues', () => {
    const view = renderTable();
    expect(
      view.getByRole('heading', { name: /This week/ }).textContent
    ).toContain('3 issues');
  });

  test('group header carries status, due, days left and progress', () => {
    const view = renderTable();
    const header = view.container.querySelector('[data-group-id="g1"]');
    expect(header).not.toBeNull();
    const scope = within(header as HTMLElement);
    expect(scope.getByRole('img', { name: 'Overdue' })).toBeTruthy();
    expect(header?.textContent).toContain('Oct 19');
    expect(header?.textContent).toContain('2 days overdue');
    expect(
      scope
        .getByRole('progressbar', { name: 'Cutover progress' })
        .getAttribute('aria-valuetext')
    ).toBe('4 of 7 done');
  });

  test('chips and meta cells are readable text with column labels', () => {
    const view = renderTable();
    const item = view.getByRole('link', { name: 'Issue a-1' }).closest('li');
    const text = item?.textContent ?? '';
    expect(text).toContain('New — given to you because you lead Atlas');
    expect(text).toContain('State: Todo');
    expect(text).toContain('Priority: Medium');
    expect(text).toContain('Project: Atlas');
    expect(text).toContain('Due: Oct 23');
  });

  test('external rows open a new tab with a screen-reader note', () => {
    const view = renderTable();
    const link = view.getByRole('link', { name: /Issue b-1/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toContain('(opens in a new tab)');
    // Absolute URLs bypass the host router (Link renders a plain anchor).
    expect(link.hasAttribute('data-host-link')).toBe(false);
  });

  test('a row can carry a separate ↗ link beside an in-app title', () => {
    const onOpenRow = mock((_row: TaskRowData, _group: TaskGroupData) => {});
    const sections: TaskSectionData[] = [
      {
        id: 'week',
        label: 'This week',
        groups: [
          {
            id: 'g1',
            title: 'Cutover',
            rows: [
              row('a-1', {
                href: '/week?issue=A-1',
                externalHref: 'https://linear.app/x/issue/A-1',
                externalLabel: 'Open A-1 in Linear',
              }),
              row('a-2'),
            ],
          },
        ],
      },
    ];
    const view = renderTable({ sections, onOpenRow });
    const title = view.getByRole('link', { name: 'Issue a-1' });
    expect(title.getAttribute('href')).toBe('/week?issue=A-1');
    expect(title.getAttribute('target')).toBeNull();
    const out = view.getByRole('link', { name: 'Open A-1 in Linear' });
    expect(out.getAttribute('href')).toBe('https://linear.app/x/issue/A-1');
    expect(out.getAttribute('target')).toBe('_blank');
    expect(out.getAttribute('rel')).toContain('noopener');
    // The title keeps the row's own behaviour; the icon is its own link,
    // outside the title's nav target.
    fireEvent.click(title);
    expect(onOpenRow).toHaveBeenCalledTimes(1);
    expect(out.closest('[data-nav-target]')).toBeNull();
    expect(title.closest('[data-nav-target]')).not.toBeNull();
    // Rows without one draw no extra link.
    expect(view.queryByRole('link', { name: /A-2 in/ })).toBeNull();
  });

  test('columns are configurable', () => {
    const view = renderTable({ columns: ['due'] });
    const item = view.getByRole('link', { name: 'Issue a-1' }).closest('li');
    expect(item?.textContent).toContain('Due: Oct 23');
    expect(item?.textContent).not.toContain('Project:');
  });

  test('renders the empty message when there are no groups', () => {
    const view = render(
      <TaskGroupTable sections={[]} emptyMessage="Nothing assigned to you" />
    );
    expect(view.getByText('Nothing assigned to you')).toBeTruthy();
    expect(view.queryByRole('group')).toBeNull();
  });
});

describe('TaskGroupTable collapse', () => {
  test('the toggle is a disclosure that hides and shows rows', () => {
    const onToggleGroup = mock((_id: string, _c: boolean) => {});
    const view = renderTable({ onToggleGroup });
    const toggle = toggleOf('Atlas, Cutover')(view);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(
      toggle.getAttribute('aria-controls') ?? ''
    );
    expect(list?.tagName).toBe('UL');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByRole('link', { name: 'Issue a-1' })).toBeNull();
    expect(list?.hasAttribute('hidden')).toBe(true);
    expect(onToggleGroup).toHaveBeenCalledWith('g1', true);
    fireEvent.click(toggle);
    expect(view.getByRole('link', { name: 'Issue a-1' })).toBeTruthy();
  });

  test('defaultCollapsed applies when nothing is stored', () => {
    const view = renderTable({ defaultCollapsed: ['g2'] });
    expect(
      toggleOf('Beacon, Public beta')(view).getAttribute('aria-expanded')
    ).toBe('false');
    expect(view.queryByRole('link', { name: /Issue b-1/ })).toBeNull();
  });

  test('folds persist under storageKey and survive a remount', () => {
    const first = renderTable({ storageKey: 'test:folds' });
    fireEvent.click(toggleOf('Atlas, Cutover')(first));
    expect(localStorage.getItem('test:folds')).toBe('["g1"]');
    first.unmount();

    const second = renderTable({ storageKey: 'test:folds' });
    expect(
      toggleOf('Atlas, Cutover')(second).getAttribute('aria-expanded')
    ).toBe('false');
    expect(second.queryByRole('link', { name: 'Issue a-1' })).toBeNull();
  });

  test('session storage is honoured when asked for', () => {
    const view = renderTable({
      storageKey: 'test:session',
      storage: 'session',
    });
    fireEvent.click(toggleOf('Beacon, Public beta')(view));
    expect(sessionStorage.getItem('test:session')).toBe('["g2"]');
    expect(localStorage.getItem('test:session')).toBeNull();
    sessionStorage.clear();
  });

  test('a stored value wins over defaultCollapsed; corrupt storage means none', () => {
    localStorage.setItem('test:corrupt', '{not json');
    const view = renderTable({
      storageKey: 'test:corrupt',
      defaultCollapsed: ['g1'],
    });
    expect(toggleOf('Atlas, Cutover')(view).getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  test('collapse helpers are pure and stable', () => {
    expect(parseCollapsed('["b","a"]')).toEqual(new Set(['a', 'b']));
    expect(parseCollapsed('[1,"x"]')).toEqual(new Set(['x']));
    expect(parseCollapsed('nope')).toEqual(new Set());
    expect(serializeCollapsed(new Set(['b', 'a']))).toBe('["a","b"]');
    const base = new Set(['a']);
    expect(toggleCollapsed(base, 'a')).toEqual(new Set());
    expect(toggleCollapsed(base, 'b')).toEqual(new Set(['a', 'b']));
    expect(base).toEqual(new Set(['a']));
  });
});

describe('TaskGroupTable keyboard', () => {
  test('↑/↓ and j/k move between toggles and rows; Home/End jump', () => {
    const view = renderTable();
    const root = view.getByRole('group', { name: 'My issues' });
    const cutover = toggleOf('Atlas, Cutover')(view);
    cutover.focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-1' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'j' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-2' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(toggleOf('Beacon, Public beta')(view));
    fireEvent.keyDown(document.activeElement as Element, { key: 'k' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-2' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue c-1' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(cutover);
    // ↑ at the top stays put rather than wrapping.
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cutover);
    expect(root.contains(document.activeElement)).toBe(true);
  });

  test('← goes to the group, then collapses it; → expands, then enters', () => {
    const view = renderTable();
    const link = view.getByRole('link', { name: 'Issue a-2' });
    const toggle = toggleOf('Atlas, Cutover')(view);
    link.focus();
    fireEvent.keyDown(link, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(toggle, { key: 'ArrowLeft' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed rows are skipped by ↓.
    fireEvent.keyDown(toggle, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(toggleOf('Beacon, Public beta')(view));
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'ArrowRight' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(toggle, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-1' })
    );
  });

  test('keys with modifiers are left to the host', () => {
    const view = renderTable();
    const toggle = toggleOf('Atlas, Cutover')(view);
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'ArrowDown', metaKey: true });
    expect(document.activeElement).toBe(toggle);
  });
});

describe('TaskGroupTable callbacks', () => {
  test('onOpenRow takes plain clicks; modified clicks stay native', () => {
    const onOpenRow = mock((_r: TaskRowData, _g: TaskGroupData) => {});
    const view = renderTable({ onOpenRow });
    const link = view.getByRole('link', { name: 'Issue a-1' });
    const plain = fireEvent.click(link);
    expect(plain).toBe(false); // default prevented
    expect(onOpenRow).toHaveBeenCalledTimes(1);
    expect(onOpenRow.mock.calls[0][0].id).toBe('a-1');
    expect(onOpenRow.mock.calls[0][1].id).toBe('g1');
    const modified = fireEvent.click(link, { metaKey: true });
    expect(modified).toBe(true);
    expect(onOpenRow).toHaveBeenCalledTimes(1);
  });

  test('rows without href are buttons that call onOpenRow', () => {
    const onOpenRow = mock((_r: TaskRowData, _g: TaskGroupData) => {});
    const view = render(
      <TaskGroupTable
        onOpenRow={onOpenRow}
        sections={[
          {
            id: 's',
            label: 'Tasks',
            groups: [
              {
                id: 'g',
                title: 'Ready',
                rows: [row('t-1', { href: undefined })],
              },
            ],
          },
        ]}
      />
    );
    fireEvent.click(view.getByRole('button', { name: 'Issue t-1' }));
    expect(onOpenRow).toHaveBeenCalledTimes(1);
  });

  test('onOpenGroup takes the group title click', () => {
    const onOpenGroup = mock((_g: TaskGroupData) => {});
    const view = renderTable({ onOpenGroup });
    fireEvent.click(view.getByRole('link', { name: 'Cutover' }));
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
    expect(onOpenGroup.mock.calls[0][0].id).toBe('g1');
  });
});

describe('TaskGroupTable review additions', () => {
  test('folding a group while focus sits in its rows hands focus to its toggle', () => {
    const view = renderTable();
    const link = view.getByRole('link', { name: 'Issue a-2' });
    const toggle = toggleOf('Atlas, Cutover')(view);
    link.focus();
    expect(document.activeElement).toBe(link);
    // A pointer (or host) fold while a row has focus: the rows unmount, so
    // focus must not fall back to <body>.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  test('two tables on one key stay in step, and so do other tabs', () => {
    renderTable({ storageKey: 'test:sync' });
    render(
      <TaskGroupTable
        sections={SECTIONS}
        label="Second"
        storageKey="test:sync"
      />
    );
    // Both tables are in document.body, so every query is scoped.
    const toggleIn = (table: string, name: string) =>
      within(
        within(document.body).getByRole('group', { name: table })
      ).getByRole('button', { name });
    fireEvent.click(toggleIn('My issues', 'Atlas, Cutover'));
    expect(
      toggleIn('Second', 'Atlas, Cutover').getAttribute('aria-expanded')
    ).toBe('false');
    // Another document writes the key: the 'storage' event re-reads it.
    localStorage.setItem('test:sync', '["g2"]');
    act(() => {
      window.dispatchEvent(new Event('storage'));
    });
    expect(
      toggleIn('Second', 'Atlas, Cutover').getAttribute('aria-expanded')
    ).toBe('true');
    expect(
      toggleIn('My issues', 'Beacon, Public beta').getAttribute('aria-expanded')
    ).toBe('false');
  });

  test('blocked storage never throws; the fold still works for the session', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      const view = renderTable({ storageKey: 'test:blocked' });
      const toggle = toggleOf('Atlas, Cutover')(view);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  test('headingLevel sets sections and groups one level apart', () => {
    const view = renderTable({ headingLevel: 2 });
    expect(
      view.getByRole('heading', { level: 2, name: /This week/ })
    ).toBeTruthy();
    expect(
      view.getByRole('heading', { level: 3, name: /Cutover/ })
    ).toBeTruthy();
  });

  test('activeRowId marks the open row current', () => {
    const view = renderTable({ activeRowId: 'a-2' });
    const item = view.getByRole('link', { name: 'Issue a-2' }).closest('li');
    expect(item?.getAttribute('aria-current')).toBe('true');
    const other = view.getByRole('link', { name: 'Issue a-1' }).closest('li');
    expect(other?.hasAttribute('aria-current')).toBe(false);
  });

  test('onRowKeyDown gets keys the table leaves alone, modified ones too', () => {
    const seen: string[] = [];
    const onRowKeyDown = mock(
      (event: { key: string; metaKey: boolean }, r: TaskRowData) => {
        seen.push(`${event.metaKey ? 'meta+' : ''}${event.key}:${r.id}`);
      }
    );
    const view = renderTable({ onRowKeyDown });
    const link = view.getByRole('link', { name: 'Issue a-1' });
    link.focus();
    fireEvent.keyDown(link, { key: 'x' });
    fireEvent.keyDown(link, { key: 'c', metaKey: true });
    // Navigation keys stay the table's and are not forwarded.
    fireEvent.keyDown(link, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-2' })
    );
    // A modified arrow is not navigation; it reaches the host instead.
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'ArrowDown',
      metaKey: true,
    });
    // Keys on a group toggle are not row commands.
    fireEvent.keyDown(toggleOf('Atlas, Cutover')(view), { key: 'x' });
    expect(seen).toEqual(['x:a-1', 'meta+c:a-1', 'meta+ArrowDown:a-2']);
  });

  test('the project cell is flagged when it repeats the group heading', () => {
    const view = renderTable({
      sections: [
        {
          id: 's',
          label: 'This week',
          groups: [
            {
              id: 'g',
              eyebrow: 'Atlas',
              title: 'Cutover',
              rows: [row('r-1'), row('r-2', { project: 'Beacon' })],
            },
          ],
        },
      ],
    });
    const cellOf = (name: string) =>
      view
        .getByRole('link', { name })
        .closest('li')
        ?.querySelector('[data-column="project"]');
    expect(cellOf('Issue r-1')?.hasAttribute('data-repeats-heading')).toBe(
      true
    );
    expect(cellOf('Issue r-2')?.hasAttribute('data-repeats-heading')).toBe(
      false
    );
  });

  test('a section without groups says so; a group without rows says so', () => {
    const view = renderTable({
      sections: [
        { id: 'empty', label: 'Later', groups: [] },
        {
          id: 's',
          label: 'This week',
          groups: [{ id: 'g', title: 'Quiet', rows: [] }],
        },
      ],
    });
    expect(view.getByText('Nothing in this section')).toBeTruthy();
    expect(view.getByText('No open issues')).toBeTruthy();
  });

  test('an empty section can say its own sentence', () => {
    const view = renderTable({
      sections: [
        {
          id: 'week',
          label: 'This week',
          emptyLabel: 'Nothing of yours is due this week.',
          groups: [],
        },
        {
          id: 'later',
          label: 'Later',
          groups: [{ id: 'g', title: 'Cutover', rows: [row('l-1')] }],
        },
      ],
    });
    expect(view.getByText('Nothing of yours is due this week.')).toBeTruthy();
    expect(view.queryByText('Nothing in this section')).toBeNull();
  });

  test('a muted group is never loud: grey mark, no accent date or progress', () => {
    const view = renderTable({
      sections: [
        {
          id: 'week',
          label: 'This week',
          groups: [
            {
              id: 'quiet',
              eyebrow: 'Fjord',
              title: 'Dashboards',
              status: 'overdue',
              statusLabel: 'Overdue · inactive project',
              dueLabel: 'Oct 16',
              daysLeftLabel: 'Inactive project',
              dueTone: 'accent',
              progress: { done: 0, total: 2, tone: 'accent' },
              muted: true,
              rows: [row('f-1')],
            },
            {
              id: 'loud',
              title: 'Cutover',
              status: 'overdue',
              statusLabel: 'Overdue',
              dueLabel: 'Oct 19',
              dueTone: 'accent',
              progress: { done: 1, total: 2, tone: 'accent' },
              rows: [row('a-1')],
            },
          ],
        },
      ],
    });
    const header = (id: string) => {
      const el = view.container.querySelector(
        `[data-group-id="${id}"] [data-nav-item="group"]`
      );
      if (el === null) throw new Error(`no group ${id}`);
      return el;
    };
    const quiet = header('quiet');
    const quietMark = within(quiet as HTMLElement).getByRole('img', {
      name: 'Overdue · inactive project',
    });
    expect(quietMark.hasAttribute('data-muted')).toBe(true);
    const tones = (el: Element) =>
      [...el.querySelectorAll('[data-tone]')].map((n) =>
        n.getAttribute('data-tone')
      );
    // The due date, then the progress rule.
    expect(tones(quiet)).toEqual(['default', 'default']);
    const loud = header('loud');
    expect(
      within(loud as HTMLElement)
        .getByRole('img', { name: 'Overdue' })
        .hasAttribute('data-muted')
    ).toBe(false);
    expect(tones(loud)).toEqual(['accent', 'accent']);
  });
});
