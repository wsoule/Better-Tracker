import {
  type GraphScope,
  indexWorkspace,
  type Snapshot,
  viewerScope,
  visibleSnapshot,
} from '@better-tracker/core';
import { createFixtureWorkspace } from '@better-tracker/linear';
import { describe, expect, test } from 'bun:test';

import {
  chainHref,
  GRAPH_DRAW_LIMITS,
  graphHref,
  graphTrail,
  levelTabs,
  parseGraphParams,
  parseGraphScope,
} from '../lib/adapters/graph-scope';

// The /graph URL vocabulary: reading a query string into a scope (and the
// ?node= arrival selection), writing a scope's canonical URL, the drill-up
// trail and the level tabs. The trail reads the demo mirror, as a member
// and as the guest (who sees no initiatives).

const TODAY = '2026-10-21';

/** "?a=1&b=2" as Next hands search params to a page. */
function query(search: string): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const seen = params[key];
    if (seen === undefined) params[key] = value;
    else params[key] = [...(Array.isArray(seen) ? seen : [seen]), value];
  }
  return params;
}

/** The URL a /graph link names, read back as the page reads it. */
function read(href: string) {
  const at = href.indexOf('?');
  return parseGraphParams(query(at === -1 ? '' : href.slice(at + 1)));
}

describe('parseGraphParams ↔ graphHref', () => {
  const urls: [string, GraphScope, string | null][] = [
    ['/graph', { level: 'milestone' }, null],
    ['/graph?level=initiative', { level: 'initiative' }, null],
    ['/graph?level=project', { level: 'project' }, null],
    ['/graph?level=issue', { level: 'issue' }, null],
    [
      '/graph?initiative=init-growth',
      { level: 'project', initiativeId: 'init-growth' },
      null,
    ],
    [
      '/graph?initiative=init-growth&level=milestone',
      { level: 'milestone', initiativeId: 'init-growth' },
      null,
    ],
    [
      '/graph?initiative=init-growth&level=issue',
      { level: 'issue', initiativeId: 'init-growth' },
      null,
    ],
    [
      '/graph?initiative=none',
      { level: 'project', initiativeId: 'none' },
      null,
    ],
    [
      '/graph?project=proj-atlas',
      { level: 'issue', projectId: 'proj-atlas' },
      null,
    ],
    [
      '/graph?project=proj-atlas&level=milestone',
      { level: 'milestone', projectId: 'proj-atlas' },
      null,
    ],
    [
      '/graph?milestone=ms-atlas-2',
      { level: 'issue', milestoneId: 'ms-atlas-2' },
      null,
    ],
    ['/graph?chain=ENG-24', { level: 'issue', issueId: 'ENG-24' }, null],
    ['/graph?node=ms-atlas-2', { level: 'milestone' }, 'ms-atlas-2'],
    [
      '/graph?project=proj-atlas&level=milestone&node=ms-atlas-2',
      { level: 'milestone', projectId: 'proj-atlas' },
      'ms-atlas-2',
    ],
  ];

  test.each(urls)('%s', (href, scope, nodeId) => {
    expect(read(href)).toEqual({ scope, nodeId });
    expect(graphHref(scope, { node: nodeId })).toBe(href);
  });

  test('a chain link is written with the identifier', () => {
    expect(chainHref('ENG-24')).toBe('/graph?chain=ENG-24');
    expect(chainHref('a b')).toBe('/graph?chain=a%20b');
  });

  test('hrefs encode ids', () => {
    expect(graphHref({ level: 'issue', milestoneId: 'a b&c' })).toBe(
      '/graph?milestone=a%20b%26c'
    );
    expect(
      graphHref({ level: 'milestone', initiativeId: 'i/1' }, { node: 'm&1' })
    ).toBe('/graph?initiative=i%2F1&level=milestone&node=m%261');
  });
});

describe('parseGraphParams', () => {
  test('the narrowest container wins: chain > milestone > project > initiative', () => {
    const all = {
      chain: 'ENG-1',
      milestone: 'm',
      project: 'p',
      initiative: 'i',
    };
    expect(parseGraphScope(all)).toEqual({ level: 'issue', issueId: 'ENG-1' });
    expect(parseGraphScope({ ...all, chain: undefined })).toEqual({
      level: 'issue',
      milestoneId: 'm',
    });
    expect(
      parseGraphScope({ project: 'p', initiative: 'i', level: 'milestone' })
    ).toEqual({ level: 'milestone', projectId: 'p' });
    expect(parseGraphScope({ initiative: 'i', level: 'issue' })).toEqual({
      level: 'issue',
      initiativeId: 'i',
    });
  });

  test('levels: any case, plurals, and the default when not offered', () => {
    expect(parseGraphScope({ level: 'Initiatives' })).toEqual({
      level: 'initiative',
    });
    expect(parseGraphScope({ level: 'ISSUES', project: 'p' })).toEqual({
      level: 'issue',
      projectId: 'p',
    });
    // Unknown, or not offered by the container: its default level.
    expect(parseGraphScope({ level: 'teams' })).toEqual({ level: 'milestone' });
    // Object.prototype's names are no levels either.
    for (const level of ['constructors', '__proto__', 'toStrings']) {
      expect(parseGraphScope({ level, project: 'p' })).toEqual({
        level: 'issue',
        projectId: 'p',
      });
    }
    expect(parseGraphScope({ level: 'initiative', initiative: 'i' })).toEqual({
      level: 'project',
      initiativeId: 'i',
    });
    expect(parseGraphScope({ level: 'project', project: 'p' })).toEqual({
      level: 'issue',
      projectId: 'p',
    });
    expect(parseGraphScope({ level: 'milestone', milestone: 'm' })).toEqual({
      level: 'issue',
      milestoneId: 'm',
    });
    expect(parseGraphScope({ level: 'project', chain: 'ENG-1' })).toEqual({
      level: 'issue',
      issueId: 'ENG-1',
    });
  });

  test('first value of a list, trimmed; blank or oversized values are ignored', () => {
    expect(parseGraphScope({ milestone: ' ms-1 ', project: 'p-1' })).toEqual({
      level: 'issue',
      milestoneId: 'ms-1',
    });
    expect(parseGraphScope({ project: ['p-1', 'p-2'] })).toEqual({
      level: 'issue',
      projectId: 'p-1',
    });
    expect(
      parseGraphScope({ chain: '  ', initiative: 'x'.repeat(201) })
    ).toEqual({ level: 'milestone' });
    expect(parseGraphParams({ node: ' ' }).nodeId).toBeNull();
    expect(parseGraphParams({ node: 'x'.repeat(201) }).nodeId).toBeNull();
    expect(parseGraphParams({ node: [' ms-1 ', 'ms-2'] }).nodeId).toBe('ms-1');
  });

  test('every /graph URL in use before the levels reads as it did', () => {
    // Sidebar, tab bar, palette, e2e and sign-in returnTo.
    expect(read('/graph').scope).toEqual({ level: 'milestone' });
    // Milestone drawer, node panels, the issue Blocked alert.
    expect(read('/graph?milestone=ms-atlas-2').scope).toEqual({
      level: 'issue',
      milestoneId: 'ms-atlas-2',
    });
    // Projects register rows, the tasks gallery.
    expect(read('/graph?project=proj-atlas').scope).toEqual({
      level: 'issue',
      projectId: 'proj-atlas',
    });
    // ?issue= opens a slide-over and changes nothing else.
    expect(read('/graph?milestone=ms-atlas-2&issue=ENG-12')).toEqual({
      scope: { level: 'issue', milestoneId: 'ms-atlas-2' },
      nodeId: null,
    });
  });

  test('the draw limits are 200 boxes and 300 arrows', () => {
    expect(GRAPH_DRAW_LIMITS).toEqual({ nodes: 200, edges: 300 });
  });
});

describe('graphTrail', () => {
  const member: Snapshot = indexWorkspace(createFixtureWorkspace(TODAY));
  const guest: Snapshot = visibleSnapshot(
    member,
    viewerScope(member, 'user-gus')
  );

  test('the workspace levels have no trail', () => {
    for (const level of [
      'initiative',
      'project',
      'milestone',
      'issue',
    ] as const) {
      expect(graphTrail(member, { level })).toEqual([]);
    }
  });

  test('an initiative, and the projects with none', () => {
    expect(
      graphTrail(member, { level: 'milestone', initiativeId: 'init-platform' })
    ).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      { label: 'Platform reliability' },
    ]);
    expect(
      graphTrail(member, { level: 'project', initiativeId: 'none' })
    ).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      { label: 'No initiative' },
    ]);
  });

  test('a project and a milestone link up at their natural levels', () => {
    expect(
      graphTrail(member, { level: 'issue', projectId: 'proj-garnet' })
    ).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      { label: 'No initiative', href: '/graph?initiative=none' },
      { label: 'Garnet mobile app' },
    ]);
    expect(
      graphTrail(member, { level: 'issue', milestoneId: 'ms-juniper-1' })
    ).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      // Juniper is in both initiatives: its first one, as on the timeline.
      {
        label: 'Platform reliability',
        href: '/graph?initiative=init-platform',
      },
      {
        label: 'Juniper design system',
        href: '/graph?project=proj-juniper&level=milestone',
      },
      { label: 'Tokens and type' },
    ]);
  });

  test('a chain skips the levels its issue lacks', () => {
    // ENG-18: Atlas, no milestone.
    expect(
      graphTrail(member, { level: 'issue', issueId: 'iss-eng-18' })
    ).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      {
        label: 'Platform reliability',
        href: '/graph?initiative=init-platform',
      },
      {
        label: 'Atlas billing migration',
        href: '/graph?project=proj-atlas&level=milestone',
      },
      { label: 'ENG-18' },
    ]);
    // ENG-80: no project at all; the identifier may be in any case.
    expect(graphTrail(member, { level: 'issue', issueId: 'eng-80' })).toEqual([
      { label: 'Workspace', href: '/graph?level=initiative' },
      { label: 'ENG-80' },
    ]);
  });

  test('a guest sees no initiatives: no initiative crumb, Workspace opens projects', () => {
    expect(guest.initiatives.size).toBe(0);
    expect(
      graphTrail(guest, { level: 'issue', projectId: 'proj-delta' })
    ).toEqual([
      { label: 'Workspace', href: '/graph?level=project' },
      { label: 'Delta exports' },
    ]);
    expect(
      graphTrail(guest, { level: 'issue', milestoneId: 'ms-delta-1' })
    ).toEqual([
      { label: 'Workspace', href: '/graph?level=project' },
      {
        label: 'Delta exports',
        href: '/graph?project=proj-delta&level=milestone',
      },
      { label: 'CSV exports' },
    ]);
  });
});

describe('levelTabs', () => {
  const tabs = (scope: GraphScope, hasInitiatives = true) =>
    levelTabs(scope, { hasInitiatives }).map((tab) => [
      tab.label,
      tab.href,
      tab.current,
    ]);

  test('the workspace offers every level, Initiatives only with initiatives', () => {
    expect(tabs({ level: 'milestone' })).toEqual([
      ['Initiatives', '/graph?level=initiative', false],
      ['Projects', '/graph?level=project', false],
      ['Milestones', '/graph', true],
      ['Issues', '/graph?level=issue', false],
    ]);
    expect(tabs({ level: 'project' }, false)).toEqual([
      ['Projects', '/graph?level=project', true],
      ['Milestones', '/graph', false],
      ['Issues', '/graph?level=issue', false],
    ]);
  });

  test('an initiative and a project offer the levels finer than themselves', () => {
    expect(tabs({ level: 'issue', initiativeId: 'none' })).toEqual([
      ['Projects', '/graph?initiative=none', false],
      ['Milestones', '/graph?initiative=none&level=milestone', false],
      ['Issues', '/graph?initiative=none&level=issue', true],
    ]);
    expect(tabs({ level: 'issue', projectId: 'proj-atlas' }, false)).toEqual([
      ['Milestones', '/graph?project=proj-atlas&level=milestone', false],
      ['Issues', '/graph?project=proj-atlas', true],
    ]);
  });

  test('a milestone and a chain offer one level: no tabs', () => {
    expect(tabs({ level: 'issue', milestoneId: 'ms-atlas-2' })).toEqual([]);
    expect(tabs({ level: 'issue', issueId: 'ENG-24' })).toEqual([]);
  });
});
