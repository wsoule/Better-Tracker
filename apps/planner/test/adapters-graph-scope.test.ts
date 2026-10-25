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
  addressHref,
  carryHighlight,
  chainHref,
  DEFAULT_GRAPH_HIGHLIGHT,
  effectiveHighlight,
  GRAPH_DRAW_LIMITS,
  GRAPH_HIGHLIGHT_LABEL,
  GRAPH_HIGHLIGHTS,
  graphHref,
  graphTrail,
  HIGHLIGHT_COOKIE,
  highlightCookie,
  highlightFromCookies,
  levelTabs,
  parseGraphParams,
  parseGraphScope,
  parseHighlight,
  withHighlightParam,
} from '../lib/adapters/graph-scope';
import {
  activeCookieName,
  oauthCookieName,
  stashCookieName,
} from '../lib/session-cookies';

// The /graph URL vocabulary: reading a query string into a scope (and the
// ?node= arrival selection), writing a scope's canonical URL, the drill-up
// trail, the level tabs, and the highlight (?highlight= and its cookie).
// The trail reads the demo mirror, as a member and as the guest (who sees
// no initiatives).

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

  test('the draw limits are 700 boxes and 1,000 arrows', () => {
    // Every item of a scope is drawn (owner decision 2026-10-23): about
    // 0.8 s of framed layout at these sizes (architecture §8.4).
    expect(GRAPH_DRAW_LIMITS).toEqual({ nodes: 700, edges: 1000 });
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

describe('the highlight', () => {
  test('three modes in switch order, Status by default', () => {
    expect(GRAPH_HIGHLIGHTS).toEqual(['status', 'risk', 'critical']);
    expect(GRAPH_HIGHLIGHTS.map((id) => GRAPH_HIGHLIGHT_LABEL[id])).toEqual([
      'Status',
      'Risk',
      'Critical path',
    ]);
    expect(DEFAULT_GRAPH_HIGHLIGHT).toBe('status');
  });

  test('?highlight= is lenient: any case, trimmed, critical-path, the first value', () => {
    expect(parseHighlight('Status')).toBe('status');
    expect(parseHighlight('RISK')).toBe('risk');
    expect(parseHighlight(' critical-path ')).toBe('critical');
    expect(parseHighlight('CriticalPath')).toBe('critical');
    expect(parseHighlight('critical')).toBe('critical');
    expect(parseHighlight(['risk', 'status'])).toBe('risk');
    expect(parseHighlight(query('highlight=Risk&highlight=x').highlight)).toBe(
      'risk'
    );
  });

  test('anything else is null, never a 404: junk, blanks, prototype names', () => {
    for (const value of [
      'junk',
      '',
      '   ',
      'critical path',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'r'.repeat(500),
    ]) {
      expect(parseHighlight(value)).toBeNull();
    }
    expect(parseHighlight(undefined)).toBeNull();
    expect(parseHighlight(null)).toBeNull();
  });

  test('the URL wins, then a valid cookie, then the default', () => {
    expect(effectiveHighlight('risk', 'critical')).toBe('risk');
    expect(effectiveHighlight(undefined, 'critical')).toBe('critical');
    expect(effectiveHighlight('junk', 'Critical')).toBe('critical');
    // An invalid cookie is ignored, whatever it holds.
    expect(effectiveHighlight(undefined, '__proto__')).toBe('status');
    expect(effectiveHighlight(undefined, 'risk; Path=/')).toBe('status');
    expect(effectiveHighlight(undefined, undefined)).toBe('status');
    expect(effectiveHighlight('status', 'risk')).toBe('status');
  });

  test('withHighlightParam changes only ?highlight=, keeping every other param as written', () => {
    expect(withHighlightParam('/graph?chain=ENG-23', 'critical')).toBe(
      '/graph?chain=ENG-23&highlight=critical'
    );
    expect(withHighlightParam('/graph', 'risk')).toBe('/graph?highlight=risk');
    // The default is never written; dropping the last param drops the "?".
    expect(withHighlightParam('/graph?highlight=risk', 'status')).toBe(
      '/graph'
    );
    expect(
      withHighlightParam('/graph?level=initiative&highlight=risk', 'status')
    ).toBe('/graph?level=initiative');
    // A changed mode replaces every repeat of the param, in any encoding.
    expect(
      withHighlightParam(
        '/graph?highlight=Risk&project=proj%2Fx&high%6Cight=status&issue=ENG-23',
        'critical'
      )
    ).toBe('/graph?project=proj%2Fx&issue=ENG-23&highlight=critical');
    // Other params keep their exact bytes (+, %20, empty values, order),
    // and a fragment stays last.
    expect(
      withHighlightParam('/graph?q=a+b&x=%20&empty=&node=ms-1#top', 'risk')
    ).toBe('/graph?q=a+b&x=%20&empty=&node=ms-1&highlight=risk#top');
    expect(withHighlightParam('/graph?highlights=1', 'status')).toBe(
      '/graph?highlights=1'
    );
  });

  test('the address bar drops ?highlight= only when the mode and a bare URL here are both Status', () => {
    // No cookie (or Status): Status is the bare URL, Risk is written.
    expect(addressHref('/graph?level=issue', 'status', 'status')).toBe(
      '/graph?level=issue'
    );
    expect(addressHref('/graph?level=issue', 'risk', 'status')).toBe(
      '/graph?level=issue&highlight=risk'
    );
    // A cookie that says Risk: Risk is still written (a copied link shows
    // it to anyone), and an explicit Status survives a reload here.
    expect(addressHref('/graph?level=issue', 'risk', 'risk')).toBe(
      '/graph?level=issue&highlight=risk'
    );
    expect(
      addressHref('/graph?level=issue&highlight=status', 'status', 'risk')
    ).toBe('/graph?level=issue&highlight=status');
  });

  test('links the screen draws carry the mode only when the next page would not pick it', () => {
    // Arrived on a shared ?highlight=critical, this device's own mode is
    // Status: a level tab, a trail crumb or a panel link keeps Critical.
    expect(carryHighlight('/graph', 'critical', 'status')).toBe(
      '/graph?highlight=critical'
    );
    expect(
      carryHighlight(
        '/graph?project=proj-atlas&level=milestone',
        'critical',
        'status'
      )
    ).toBe('/graph?project=proj-atlas&level=milestone&highlight=critical');
    // A Status page on a device whose cookie says Risk keeps Status too.
    expect(carryHighlight('/graph?level=issue', 'status', 'risk')).toBe(
      '/graph?level=issue&highlight=status'
    );
    // The mode the next page picks anyway: the link stays canonical.
    expect(carryHighlight('/graph?level=issue', 'risk', 'risk')).toBe(
      '/graph?level=issue'
    );
    // Only /graph links: an issue or timeline link is left alone.
    expect(
      carryHighlight('/timeline?milestone=ms-1', 'critical', 'status')
    ).toBe('/timeline?milestone=ms-1');
    // A panel's "Open as list" goes to the Issues page untouched.
    expect(
      carryHighlight('/issues?milestone=ms-atlas-2', 'critical', 'status')
    ).toBe('/issues?milestone=ms-atlas-2');
    expect(carryHighlight('/graphs', 'critical', 'status')).toBe('/graphs');
    // Links into the graph from other pages (the Issues row's Blocking
    // chain, its "Open as graph") stay canonical: the cookie, sent only to
    // /graph, picks the mode on arrival.
    expect(chainHref('ENG-23')).toBe('/graph?chain=ENG-23');
  });

  test('the cookie read takes the first valid graph-highlight pair, as the browser orders them', () => {
    // The reader's own Path=/graph pick comes first; a wider Path=/ one
    // (a parent domain's, say) after it never shadows it.
    expect(
      highlightFromCookies(
        'graph-highlight=risk; mp_session=abc; graph-highlight=critical'
      )
    ).toBe('risk');
    expect(
      highlightFromCookies('graph-highlight=evil; graph-highlight=critical')
    ).toBe('critical');
    expect(highlightFromCookies('mp_session=abc')).toBeNull();
    expect(highlightFromCookies('')).toBeNull();
    expect(highlightFromCookies(null)).toBeNull();
    expect(highlightFromCookies('graph-highlight=__proto__')).toBeNull();
    expect(highlightFromCookies('xgraph-highlight=risk')).toBeNull();
    expect(highlightFromCookies(' graph-highlight = Risk ')).toBe('risk');
  });

  test('the cookie: a year on /graph, Lax, Secure on https; never a session cookie', () => {
    expect(highlightCookie('critical', false)).toBe(
      'graph-highlight=critical; Path=/graph; Max-Age=31536000; SameSite=Lax'
    );
    expect(highlightCookie('risk', true)).toBe(
      'graph-highlight=risk; Path=/graph; Max-Age=31536000; SameSite=Lax; Secure'
    );
    expect(HIGHLIGHT_COOKIE).toBe('graph-highlight');
    for (const secure of [false, true]) {
      for (const mode of ['oauth', 'demo', 'api_key'] as const) {
        const scheme = { mode, secure };
        expect([
          activeCookieName(scheme),
          stashCookieName(scheme),
          oauthCookieName(scheme),
        ]).not.toContain(HIGHLIGHT_COOKIE);
      }
    }
  });

  test('graphHref never carries the highlight: links follow the cookie', () => {
    for (const href of [
      '/graph?highlight=critical',
      '/graph?chain=ENG-23&highlight=risk',
      '/graph?project=proj-atlas&level=milestone&node=ms-atlas-2&highlight=critical',
    ]) {
      const { scope, nodeId } = parseGraphParams(
        query(href.split('?')[1] ?? '')
      );
      expect(graphHref(scope, { node: nodeId })).not.toContain('highlight');
    }
  });
});
