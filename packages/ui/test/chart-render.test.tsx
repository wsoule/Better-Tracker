import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  DependencyChart,
  type DependencyChartProps,
} from '../src/chart/dependency-chart';
import { CLUSTERS, ISSUE_EDGES, ISSUES, issueId } from './chart-fixture';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function renderChart(props: Partial<DependencyChartProps> = {}) {
  return render(
    <DependencyChart
      nodes={ISSUES}
      edges={ISSUE_EDGES}
      clusters={CLUSTERS}
      prefsKey="/graph?level=issue"
      unit={['issue', 'issues']}
      ariaLabel="Issue dependency chart"
      emptyMessage="No issues here."
      {...props}
    />
  );
}

/** The drawn box for an issue key, once the layout has placed it. */
async function box(key: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(
      `[data-chart-node="${issueId(key)}"]`
    );
    if (el === null) throw new Error(`${key} is not drawn`);
    return el;
  });
}

function nameButton(el: HTMLElement): HTMLElement {
  const button = el.querySelector<HTMLElement>('button');
  if (button === null) throw new Error('no name button');
  return button;
}

function inspector(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-chart-inspector]');
  if (el === null) throw new Error('no inspector');
  return el;
}

describe('DependencyChart', () => {
  test('draws the linked boxes and keeps the unlinked one off by default', async () => {
    renderChart();
    await box('ATL-4');
    expect(document.querySelectorAll('[data-chart-node]')).toHaveLength(9);
    expect(
      document.querySelector(`[data-chart-node="${issueId('ATL-8')}"]`)
    ).toBeNull();
    expect(document.querySelectorAll('[data-chart-edge]')).toHaveLength(7);
    // The overview says what was left off and offers it.
    const overview = within(inspector());
    expect(
      overview.getByText(/1 issue with no blocking relation/)
    ).toBeTruthy();
    fireEvent.click(overview.getByRole('button', { name: 'Show unlinked' }));
    await box('ATL-8');
    // Remembered for this scope.
    expect(
      JSON.parse(
        localStorage.getItem('bt:graph-chart:/graph?level=issue') ?? '{}'
      )
    ).toMatchObject({ showUnlinked: true });
  });

  test('a click traces upstream and downstream and fills the inspector', async () => {
    renderChart();
    fireEvent.click(nameButton(await box('ATL-3')));
    expect((await box('ATL-3')).dataset.trace).toBe('sel');
    expect((await box('ATL-2')).dataset.trace).toBe('up');
    expect((await box('ATL-1')).dataset.trace).toBe('up');
    expect((await box('ATL-4')).dataset.trace).toBe('down');
    expect((await box('ATL-5')).dataset.trace).toBe('dim');
    const tones = [...document.querySelectorAll('[data-chart-edge]')].map(
      (el) => (el as HTMLElement).dataset.tone
    );
    expect(tones.filter((t) => t === 'up')).toHaveLength(2);
    expect(tones.filter((t) => t === 'down')).toHaveLength(1);
    const panel = within(inspector());
    expect(panel.getByRole('heading', { name: /Backfill/ })).toBeTruthy();
    expect(panel.getByText('Atlas / Beta')).toBeTruthy();
    expect(
      panel.getByText('2 issues upstream in all, 1 still open.')
    ).toBeTruthy();
    // A row picks that box instead.
    fireEvent.click(panel.getByRole('button', { name: /Cutover/ }));
    expect((await box('ATL-4')).dataset.trace).toBe('sel');
    expect(
      within(inspector()).getByText(
        '1 more open blocker is outside this graph.'
      )
    ).toBeTruthy();
    // Escape on the canvas clears it.
    fireEvent.keyDown(nameButton(await box('ATL-4')), { key: 'Escape' });
    expect((await box('ATL-4')).dataset.trace).toBeUndefined();
  });

  test('a double-click activates; the inspector opens and drills', async () => {
    const onOpen = mock((_id: string) => {});
    const onActivate = mock((_id: string) => {});
    renderChart({
      onOpen,
      onActivate,
      openLabel: () => 'Open issue',
      drillHrefFor: (href) => `${href}&from=chart`,
    });
    fireEvent.doubleClick(nameButton(await box('ATL-2')));
    expect(onActivate).toHaveBeenCalledWith(issueId('ATL-2'));
    fireEvent.click(nameButton(await box('ATL-2')));
    const panel = within(inspector());
    fireEvent.click(panel.getByRole('button', { name: 'Open issue' }));
    expect(onOpen).toHaveBeenCalledWith(issueId('ATL-2'));
    expect(
      panel.getByRole('link', { name: 'Open graph' }).getAttribute('href')
    ).toBe('/graph?chain=ATL-2&from=chart');
  });

  test('the critical path highlight numbers its steps', async () => {
    renderChart();
    await box('ATL-2');
    const critical = document.querySelector<HTMLElement>(
      '[data-chart-preset="critical"]'
    );
    expect(critical?.textContent).toBe('Critical path3');
    if (critical === null) throw new Error('no preset');
    fireEvent.click(critical);
    expect(critical.getAttribute('aria-pressed')).toBe('true');
    expect((await box('ATL-2')).dataset.trace).toBe('set');
    expect((await box('ATL-5')).dataset.trace).toBe('dim');
    expect((await box('ATL-4')).textContent).toContain('3');
    expect(within(inspector()).getByText('Critical path · 3')).toBeTruthy();
    fireEvent.click(critical);
    expect(critical.getAttribute('aria-pressed')).toBe('false');
  });

  test('Find selects a box, turning on the toggle that draws it', async () => {
    renderChart();
    await box('ATL-2');
    const stage = document.querySelector<HTMLElement>('[data-chart-stage]');
    if (stage === null) throw new Error('no stage');
    fireEvent.keyDown(stage, { key: '/' });
    const input = screen.getByRole('combobox', { name: 'Find on the chart' });
    fireEvent.change(input, { target: { value: 'docs' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await box('ATL-8')).dataset.trace).toBe('sel');
  });

  test('Box by parent draws the nested frames, and a frame title drills', async () => {
    const onDrill = mock((_href: string) => {});
    renderChart({ onDrill });
    await box('ATL-2');
    expect(document.querySelector('[data-chart-group]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Box by parent' }));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-chart-group]')).toHaveLength(3)
    );
    const beta = document.querySelector<HTMLElement>(
      '[data-chart-group-title="ms-beta"]'
    );
    if (beta === null) throw new Error('no Beta title');
    fireEvent.doubleClick(beta);
    expect(onDrill).toHaveBeenCalledWith('/graph?milestone=beta');
  });

  test('a chain focus is selected on arrival and always drawn', async () => {
    renderChart({ focusId: issueId('ATL-8') });
    const focus = await box('ATL-8');
    expect(focus.dataset.trace).toBe('sel');
    expect(focus.querySelector('[data-focus]')).not.toBeNull();
  });

  test('nothing to draw shows the empty message and the host toolbar', () => {
    render(
      <DependencyChart
        nodes={[]}
        edges={[]}
        prefsKey="empty"
        ariaLabel="Chart"
        emptyMessage="No issues here."
        toolbar={<span>Tabs</span>}
      />
    );
    expect(screen.getByText('No issues here.')).toBeTruthy();
    expect(screen.getByText('Tabs')).toBeTruthy();
  });
});
