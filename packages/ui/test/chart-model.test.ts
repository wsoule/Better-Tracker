import { describe, expect, test } from 'bun:test';

import {
  chartModel,
  chartStateOf,
  drawnNodes,
  traceChart,
} from '../src/chart/chart-model';
import { chartSpec, NODE_SIZE } from '../src/chart/chart-spec';
import { CLUSTERS, ISSUE_EDGES, ISSUES, issueId } from './chart-fixture';

const model = chartModel(ISSUES, ISSUE_EDGES, CLUSTERS);
const ids = (...keys: string[]) => keys.map(issueId);

describe('chartModel', () => {
  test('each box gets its state from readiness, then in-progress', () => {
    const states = Object.fromEntries(
      [...model.nodes.values()].map((n) => [n.data.key, n.state])
    );
    expect(states).toEqual({
      'ATL-1': 'done',
      'ATL-2': 'progress',
      'ATL-3': 'blocked',
      'ATL-4': 'blocked',
      'ATL-5': 'blocked',
      'ATL-6': 'ready',
      'ATL-7': 'blocked',
      'ATL-8': 'open',
      'ATL-9': 'blocked',
      'ATL-10': 'blocked',
    });
    // Without readiness a box falls back to its status.
    expect(chartStateOf({ id: 'x', label: 'x', tone: 'default' })).toBe('open');
    expect(
      chartStateOf({ id: 'x', label: 'x', tone: 'muted', status: 'done' })
    ).toBe('done');
  });

  test('edges drop repeats and self-loops and keep their kinds', () => {
    expect(model.edges).toHaveLength(7);
    expect([...model.resolved]).toEqual([
      `${issueId('ATL-1')}\u0000${issueId('ATL-2')}`,
    ]);
    expect(model.cycles.size).toBe(2);
    expect(model.blockersOf.get(issueId('ATL-4'))).toEqual(ids('ATL-3'));
    expect(model.dependentsOf.get(issueId('ATL-2'))).toEqual(
      ids('ATL-3', 'ATL-5')
    );
  });

  test('frames are named outermost first', () => {
    expect(model.nodes.get(issueId('ATL-1'))?.frames).toEqual([
      'Atlas',
      'Beta',
    ]);
  });

  test('the critical path is the longest open chain over blocking edges', () => {
    // ATL-1 is done, so the chain starts at ATL-2.
    expect(model.longestChain).toEqual(ids('ATL-2', 'ATL-3', 'ATL-4'));
  });

  test('the sets: ready, in progress, at risk, unlinked', () => {
    expect(model.readyNow).toEqual(ids('ATL-6'));
    expect(model.inProgress).toEqual(ids('ATL-2'));
    expect(model.atRisk).toEqual(ids('ATL-4', 'ATL-9', 'ATL-10'));
    expect(model.unlinkedOpen).toEqual(ids('ATL-8'));
  });

  test('blockers counted beyond the drawn edges are outside the graph', () => {
    expect(model.hiddenBlockers.get(issueId('ATL-4'))).toBe(1);
    expect(model.hiddenBlockers.has(issueId('ATL-3'))).toBe(false);
  });
});

describe('traceChart', () => {
  test('walks everything upstream and downstream, nearest first', () => {
    expect([...traceChart(model, issueId('ATL-4'), 'up')]).toEqual(
      ids('ATL-3', 'ATL-2', 'ATL-1')
    );
    expect([...traceChart(model, issueId('ATL-2'), 'down')]).toEqual(
      ids('ATL-3', 'ATL-5', 'ATL-4')
    );
  });

  test('stops on a cycle, reaching the start again', () => {
    expect([...traceChart(model, issueId('ATL-9'), 'up')]).toEqual(
      ids('ATL-10', 'ATL-9')
    );
  });
});

describe('drawnNodes', () => {
  test('linked boxes by default, unlinked behind a toggle, done hideable', () => {
    expect(
      drawnNodes(model, { hideDone: false, showUnlinked: false })
    ).not.toContain(issueId('ATL-8'));
    expect(
      drawnNodes(model, { hideDone: false, showUnlinked: true })
    ).toContain(issueId('ATL-8'));
    expect(
      drawnNodes(model, { hideDone: true, showUnlinked: true })
    ).not.toContain(issueId('ATL-1'));
  });

  test('the focus is always drawn, and a graph with no edges draws everything', () => {
    expect(
      drawnNodes(model, {
        hideDone: true,
        showUnlinked: false,
        keep: issueId('ATL-1'),
      })
    ).toContain(issueId('ATL-1'));
    const loose = chartModel(ISSUES, []);
    expect(drawnNodes(loose, { hideDone: false, showUnlinked: false })).toEqual(
      [...loose.order]
    );
  });
});

describe('chartSpec', () => {
  test('unframed boxes are taller (their frame line) and sit at the root', () => {
    const drawn = drawnNodes(model, { hideDone: false, showUnlinked: true });
    const spec = chartSpec(model, drawn, CLUSTERS, false);
    expect(spec.groups).toEqual([]);
    expect(spec.nodes[0]).toEqual({
      id: issueId('ATL-1'),
      width: NODE_SIZE.width,
      height: NODE_SIZE.height + NODE_SIZE.frameLine,
      group: null,
    });
    expect(spec.edges).toHaveLength(7);
  });

  test('framed boxes nest in the frames that hold a drawn box', () => {
    const drawn = ids('ATL-1', 'ATL-2');
    const spec = chartSpec(model, drawn, CLUSTERS, true);
    expect(spec.groups).toEqual([
      { id: 'proj-atlas', label: 'Atlas', parent: null },
      { id: 'ms-beta', label: 'Beta', parent: 'proj-atlas' },
    ]);
    expect(spec.nodes.map((n) => n.group)).toEqual(['ms-beta', 'ms-beta']);
    expect(spec.edges).toHaveLength(1);
  });
});
