import {
  assessWorkspace,
  buildIssueList,
  buildIssueListOptions,
  DEFAULT_ISSUE_LIST_QUERY,
  DEFAULT_TUNING,
  type EvalContext,
  indexWorkspace,
  type IssueListOptions,
  type IssueListQuery,
  type IssueListView,
  type MilestoneMeta,
  normalizeIssueListQuery,
  planAllocation,
  type WorkspaceData,
} from '@better-tracker/core';
import {
  createFixtureWorkspace,
  FIXTURE_MILESTONE_META,
} from '@better-tracker/linear';
import { describe, expect, test } from 'bun:test';

import {
  buildIssueListPage,
  facetPickerOptions,
  filterBadgeCount,
  filterMenuOptions,
  filterValueNames,
  groupLabel,
  groupMenuOptions,
  type IssueListPageInput,
  issueListChips,
  issueDueNote,
  issueDueTone,
  issueListColumns,
  issueListGraphHref,
  issueListHref,
  issueListReceipts,
  issueListTabs,
  mergeNames,
  milestoneProjectLookup,
  moreOption,
  namesFromFilterNames,
  namesFromOptions,
  namesFromRefs,
  oneChoicePerPart,
  parseIssueListParams,
  parseIssueListSearch,
  PICKER_OPTION_LIMIT,
  sortLabel,
  sortMenuOptions,
  withDefaultFilters,
  withFilterValues,
  withGroupMenu,
  withMoreRows,
  withoutInitiatives,
  withQuick,
  withSortMenu,
} from '../lib/adapters/issue-list';

// The Issues page's adapter (architecture §8.4 "Issues"): the URL grammar,
// the filter cascade, the chips, tabs and menus, and the page model built
// from core's IssueListView over the demo workspace (what demo mode
// serves on 2026-10-22: 44 open issues in 9 projects).

const TODAY = '2026-10-22';

function workspace(edit?: (data: WorkspaceData) => void) {
  const data = createFixtureWorkspace(TODAY);
  edit?.(data);
  const snapshot = indexWorkspace(data);
  const ctx: EvalContext = {
    today: TODAY,
    now: '2026-10-22T12:00:00.000Z',
    tuning: DEFAULT_TUNING,
    meta: new Map<string, MilestoneMeta>(
      FIXTURE_MILESTONE_META.map((m) => [
        m.milestoneId,
        { ...m, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: null },
      ])
    ),
  };
  const assessments = assessWorkspace(snapshot, ctx);
  const allocationPlan = planAllocation(snapshot, ctx, assessments);
  return {
    snapshot,
    view: (query: IssueListQuery, viewerId: string | null = 'user-chloe') =>
      buildIssueList({
        snapshot,
        ctx,
        assessments,
        allocationPlan,
        query,
        viewerId,
      }),
    options: () => buildIssueListOptions(snapshot, ctx, assessments),
  };
}

// The demo's own due dates live in the fixture gateway's fields store;
// the two the tests read are set here.
const DUE: Record<string, string> = {
  'iss-eng-12': '2026-10-20',
  'iss-eng-54': '2026-10-23',
};

const demo = workspace((data) => {
  data.issues = data.issues.map((issue) =>
    DUE[issue.id] === undefined ? issue : { ...issue, dueDate: DUE[issue.id] }
  );
});

/** The view a URL's parameters describe, as the server builds it. */
function viewOf(params: Record<string, string>): {
  query: IssueListQuery;
  view: IssueListView;
} {
  const query = parseIssueListParams(params);
  return { query, view: demo.view(query) };
}

const MEMBER = {
  viewerId: 'user-chloe',
  readOnly: false,
  canWriteLinear: true,
  canMove: false,
} as const;

function pageOf(
  params: Record<string, string>,
  who: Partial<IssueListPageInput> = {}
) {
  const { query, view } = viewOf(params);
  return buildIssueListPage({ ...MEMBER, view, query, ...who });
}

describe('the URL grammar', () => {
  test('no parameters are the default view, and it writes back as /issues', () => {
    const query = parseIssueListParams({});
    expect(query).toEqual(DEFAULT_ISSUE_LIST_QUERY);
    expect(issueListHref(query)).toBe('/issues');
  });

  test('parameters come back in the canonical order, defaults left out', () => {
    const query = parseIssueListParams({
      sort: 'due',
      dir: 'asc',
      limit: '500',
      group: 'project',
      state: 'all',
      assignee: 'me,none',
      project: 'proj-atlas,proj-garnet',
      q: 'billing',
      quick: 'blocked',
      priority: 'urgent,high',
      team: 'team-eng',
      milestone: 'none',
      initiative: 'init-platform',
    });
    expect(issueListHref(query, { issue: 'ENG-24' })).toBe(
      '/issues?q=billing&initiative=init-platform&project=proj-atlas,proj-garnet&milestone=none&assignee=me,none&team=team-eng&state=all&priority=urgent,high&quick=blocked&group=project&sort=due&issue=ENG-24'
    );
  });

  test('the four open status types are the default; a direction only when not the sort’s own', () => {
    expect(
      issueListHref(
        parseIssueListParams({ state: 'started,triage,backlog,unstarted' })
      )
    ).toBe('/issues');
    expect(
      issueListHref(parseIssueListParams({ state: 'started,completed' }))
    ).toBe('/issues?state=started,completed');
    expect(
      issueListHref(parseIssueListParams({ sort: 'updated', dir: 'desc' }))
    ).toBe('/issues?sort=updated');
    expect(
      issueListHref(parseIssueListParams({ sort: 'updated', dir: 'asc' }))
    ).toBe('/issues?sort=updated&dir=asc');
    // The weight order has no direction.
    expect(issueListHref(parseIssueListParams({ dir: 'desc' }))).toBe(
      '/issues'
    );
  });

  test('the row budget steps by 500 between 500 and 2,000', () => {
    expect(parseIssueListParams({ limit: '700' }).limit).toBe(1000);
    expect(parseIssueListParams({ limit: '99999' }).limit).toBe(2000);
    expect(parseIssueListParams({ limit: 'many' }).limit).toBe(500);
    expect(issueListHref(parseIssueListParams({ limit: '1000' }))).toBe(
      '/issues?limit=1000'
    );
  });

  test('unknown values are dropped, so old and shared links keep working', () => {
    const query = parseIssueListParams({
      state: 'bogus,started',
      priority: 'urgent,zzz',
      quick: 'blocked,nope',
      group: 'colour',
      sort: 'random',
      sections: 'teams',
      project: ' proj-atlas , ,proj-atlas',
    });
    expect(issueListHref(query)).toBe(
      '/issues?project=proj-atlas&state=started&priority=urgent&quick=blocked'
    );
  });

  test('a field keeps 50 values, a value 200 characters, the search 200', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `p-${i}`);
    expect(
      parseIssueListParams({ project: ids.join(',') }).filters.projectIds
    ).toHaveLength(50);
    expect(
      parseIssueListParams({ milestone: `${'m'.repeat(201)},ms-atlas-2` })
        .filters.milestoneIds
    ).toEqual(['ms-atlas-2']);
    expect(parseIssueListParams({ q: 'x'.repeat(250) }).filters.q).toHaveLength(
      200
    );
  });

  test('sections that cannot divide the grouping are dropped', () => {
    expect(
      issueListHref(
        parseIssueListParams({ group: 'initiative', sections: 'initiative' })
      )
    ).toBe('/issues?group=initiative');
    expect(
      issueListHref(
        parseIssueListParams({ group: 'assignee', sections: 'project' })
      )
    ).toBe('/issues?group=assignee&sections=project');
  });

  test('a repeated parameter reads as one list; a query string reads the same', () => {
    const fromArray = parseIssueListParams({
      project: ['proj-atlas', 'proj-garnet'],
    });
    expect(fromArray.filters.projectIds).toEqual(['proj-atlas', 'proj-garnet']);
    expect(
      parseIssueListSearch('project=proj-atlas&project=proj-garnet&q=item+4')
    ).toEqual({
      ...fromArray,
      filters: { ...fromArray.filters, q: 'item 4' },
    });
    expect(issueListHref(parseIssueListSearch('q=item+4'))).toBe(
      '/issues?q=item%204'
    );
  });
});

describe('filter changes', () => {
  const lookup = milestoneProjectLookup(
    {
      initiatives: {},
      projects: {},
      milestones: {
        'ms-garnet-1': { name: 'Offline mode', projectId: 'proj-garnet' },
        'ms-atlas-2': { name: 'Dual-write', projectId: 'proj-atlas' },
      },
      people: {},
      teams: {},
    },
    null
  );

  test('removing a project drops its milestones from the milestone filter', () => {
    const query = parseIssueListParams({
      project: 'proj-garnet,proj-atlas',
      milestone: 'ms-garnet-1,ms-atlas-2,none',
      limit: '1500',
    });
    const next = withFilterValues(query, 'projectIds', ['proj-atlas'], lookup);
    expect(next.filters.projectIds).toEqual(['proj-atlas']);
    expect(next.filters.milestoneIds).toEqual(['ms-atlas-2', 'none']);
    // A new filter is a new view: the row budget starts over.
    expect(next.limit).toBe(500);
    // Without a way to tell a milestone's project, nothing cascades.
    expect(
      withFilterValues(query, 'projectIds', ['proj-atlas']).filters.milestoneIds
    ).toEqual(['ms-garnet-1', 'ms-atlas-2', 'none']);
  });

  test('quick filters toggle; Clear all keeps the layout; Show more steps', () => {
    const query = parseIssueListParams({ group: 'state', sort: 'due' });
    const blocked = withQuick(query, 'blocked', true);
    expect(issueListHref(blocked)).toBe(
      '/issues?quick=blocked&group=state&sort=due'
    );
    expect(issueListHref(withQuick(blocked, 'blocked', false))).toBe(
      '/issues?group=state&sort=due'
    );
    const filtered = parseIssueListParams({
      project: 'proj-atlas',
      group: 'state',
    });
    expect(issueListHref(withDefaultFilters(filtered))).toBe(
      '/issues?group=state'
    );
    expect(withMoreRows(query).limit).toBe(1000);
    expect(withMoreRows(parseIssueListParams({ limit: '2000' })).limit).toBe(
      2000
    );
  });

  test('the Group and Sort menus keep one choice per part', () => {
    expect(
      oneChoicePerPart(['group:milestone', 'sections:none'], 'group:state')
    ).toEqual(['sections:none', 'group:state']);
    const query = parseIssueListParams({});
    expect(
      issueListHref(
        withGroupMenu(query, ['group:milestone', 'sections:initiative'])
      )
    ).toBe('/issues?sections=initiative');
    // A new sort starts at its own direction; a direction then flips it.
    const due = withSortMenu(query, ['sort:due']);
    expect(due.dir).toBe('asc');
    const reversed = withSortMenu(due, ['sort:due', 'dir:desc']);
    expect(issueListHref(reversed)).toBe('/issues?sort=due&dir=desc');
    expect(sortLabel(reversed)).toBe('Due date, reversed');
    expect(sortLabel(query)).toBe('Weight');
    expect(withSortMenu(reversed, ['sort:updated', 'dir:desc']).dir).toBe(
      'desc'
    );
    expect(groupLabel(parseIssueListParams({ sections: 'initiative' }))).toBe(
      'Milestone · by initiative'
    );
  });

  test('the Group menu disables sections that cannot divide the grouping', () => {
    const byProject = groupMenuOptions(
      parseIssueListParams({ group: 'project' })
    );
    const sections = byProject.filter((o) => o.group === 'Sections');
    expect(sections.map((o) => [o.label, o.disabled === true, o.hint])).toEqual(
      [
        ['No sections', false, undefined],
        ['By initiative', false, undefined],
        ['By project', true, 'Already grouped by project'],
      ]
    );
    const byInitiative = groupMenuOptions(
      parseIssueListParams({ group: 'initiative' })
    );
    expect(
      byInitiative.filter((o) => o.disabled === true).map((o) => o.value)
    ).toEqual(['sections:initiative', 'sections:project']);
  });

  test('a viewer without initiatives: the fallback and the Group menu say so', () => {
    const asked = parseIssueListParams({
      initiative: 'init-platform',
      group: 'initiative',
      sections: 'none',
    });
    expect(issueListHref(withoutInitiatives(asked))).toBe(
      '/issues?group=project'
    );
    const bySections = parseIssueListParams({ sections: 'initiative' });
    expect(issueListHref(withoutInitiatives(bySections))).toBe('/issues');
    const plain = parseIssueListParams({ project: 'proj-atlas' });
    expect(withoutInitiatives(plain)).toBe(plain);
    const menu = groupMenuOptions(plain, false);
    expect(
      menu.filter((o) => o.disabled === true).map((o) => [o.value, o.hint])
    ).toEqual([
      ['group:initiative', 'No initiatives to show'],
      ['sections:initiative', 'No initiatives to show'],
    ]);
  });

  test('the Sort menu offers a direction for a field sort only', () => {
    expect(
      sortMenuOptions(parseIssueListParams({})).map((o) => o.value)
    ).toEqual([
      'sort:weight',
      'sort:priority',
      'sort:due',
      'sort:updated',
      'sort:created',
      'sort:title',
    ]);
    expect(
      sortMenuOptions(parseIssueListParams({ sort: 'title' }))
        .slice(-2)
        .map((o) => o.label)
    ).toEqual(['Ascending', 'Descending']);
  });
});

describe('chips, tabs and the toolbar', () => {
  const names = mergeNames(
    namesFromRefs(
      viewOf({ project: 'proj-atlas,proj-garnet,proj-beacon' }).view.refs
    ),
    namesFromOptions(demo.options())
  );

  test('the default status reads "Status is open" and is not counted', () => {
    const chips = issueListChips(parseIssueListParams({}), names);
    expect(chips.map((c) => [c.field, c.summary, c.isDefault])).toEqual([
      ['Status', 'open', true],
    ]);
    expect(filterBadgeCount(chips)).toBe(0);
    // Removing it means every status, which its own chip then says (and
    // counts); that chip's × goes back to open issues.
    const all = chips[0]?.removed;
    expect(all === undefined ? '' : issueListHref(all)).toBe(
      '/issues?state=all'
    );
    const any = issueListChips(parseIssueListParams({ state: 'all' }), names);
    expect(
      any.map((c) => [c.field, c.summary, c.isDefault, c.removeLabel])
    ).toEqual([['Status', 'any', false, 'Back to open issues only']]);
    expect(filterBadgeCount(any)).toBe(1);
    const back = any[0]?.removed;
    expect(back === undefined ? '' : issueListHref(back)).toBe('/issues');
  });

  test('one chip per field in URL order; three values read as a count', () => {
    const query = parseIssueListParams({
      quick: 'blocked',
      priority: 'urgent',
      project: 'proj-atlas,proj-garnet,proj-beacon',
      assignee: 'me,none',
      state: 'started',
    });
    const chips = issueListChips(query, names);
    expect(chips.map((c) => `${c.field} is ${c.summary}`)).toEqual([
      'Project is 3 projects',
      'Assignee is Me, Unassigned',
      'Status is In progress',
      'Priority is Urgent',
      'Issue is blocked',
    ]);
    expect(chips.map((c) => c.removeLabel)).toEqual([
      'Remove project filter',
      'Remove assignee filter',
      'Remove status filter',
      'Remove priority filter',
      'Remove the blocked filter',
    ]);
    expect(filterBadgeCount(chips)).toBe(5);
    expect(issueListHref(chips[0]?.removed ?? query)).toBe(
      '/issues?assignee=me,none&state=started&priority=urgent&quick=blocked'
    );
  });

  test('a value the planner does not hold reads "Not found"', () => {
    const chips = issueListChips(
      parseIssueListParams({ milestone: 'ms-gone,ms-atlas-2' }),
      names
    );
    expect(chips[0]?.summary).toBe('Not found, Dual-write');
    expect(chips[0]?.unknown).toBe(true);
  });

  test('the tabs keep the layout, count their own preset and mark the current one', () => {
    const { query, view } = viewOf({ group: 'project', sort: 'due' });
    const tabs = issueListTabs(query, view.counts);
    expect(tabs.map((t) => [t.label, t.count, t.current, t.href])).toEqual([
      ['All', 44, true, '/issues?group=project&sort=due'],
      ['Mine', 3, false, '/issues?assignee=me&group=project&sort=due'],
      ['Unplanned', 6, false, '/issues?milestone=none&group=project&sort=due'],
      ['Unassigned', 15, false, '/issues?assignee=none&group=project&sort=due'],
      ['Blocked', 5, false, '/issues?quick=blocked&group=project&sort=due'],
      ['At risk', 19, false, '/issues?quick=at_risk&group=project&sort=due'],
    ]);
    // Each count is what the tab then shows.
    for (const tab of tabs) {
      const shown = demo.view(
        parseIssueListSearch(tab.href?.split('?')[1] ?? '')
      );
      expect(shown.total).toBe(tab.count ?? -1);
    }
    const filtered = parseIssueListParams({ project: 'proj-atlas' });
    expect(
      issueListTabs(filtered, view.counts).some((t) => t.current === true)
    ).toBe(false);
  });

  test('Open as graph opens the narrowest single container', () => {
    const href = (params: Record<string, string>) =>
      issueListGraphHref(parseIssueListParams(params));
    expect(href({ milestone: 'ms-atlas-2', project: 'proj-atlas' })).toBe(
      '/graph?milestone=ms-atlas-2'
    );
    // "none" is not a container: the project decides.
    expect(href({ milestone: 'none', project: 'proj-garnet' })).toBe(
      '/graph?project=proj-garnet'
    );
    expect(
      href({ milestone: 'ms-atlas-2,ms-atlas-3', project: 'proj-atlas' })
    ).toBe('/graph?project=proj-atlas');
    expect(href({ project: 'proj-atlas,proj-garnet' })).toBe('/graph');
    // One initiative opens its projects; "No initiative" is a container
    // there (§8.4 graph levels). Two initiatives name no single one.
    expect(href({ initiative: 'init-platform' })).toBe(
      '/graph?initiative=init-platform'
    );
    expect(href({ initiative: 'none' })).toBe('/graph?initiative=none');
    expect(href({ initiative: 'init-platform,none' })).toBe('/graph');
    // The project still wins over its initiative.
    expect(href({ initiative: 'init-platform', project: 'proj-atlas' })).toBe(
      '/graph?project=proj-atlas'
    );
    expect(href({})).toBe('/graph');
  });

  test('the column the grouping names is dropped', () => {
    expect(issueListColumns('milestone')).toEqual([
      'assignee',
      'state',
      'priority',
      'due',
    ]);
    expect(issueListColumns('assignee')).toEqual([
      'milestone',
      'state',
      'priority',
      'due',
    ]);
    expect(issueListColumns('state')).toEqual([
      'milestone',
      'assignee',
      'priority',
      'due',
    ]);
    expect(issueListColumns('priority')).toEqual([
      'milestone',
      'assignee',
      'state',
      'due',
    ]);
    expect(issueListColumns('project')).toEqual([
      'milestone',
      'assignee',
      'state',
      'priority',
      'due',
    ]);
  });

  test('the Filter menu offers Initiative and Team only where they apply', () => {
    const query = parseIssueListParams({ quick: 'at_risk' });
    const full = filterMenuOptions(query, {
      hasInitiatives: true,
      teamCount: 2,
    });
    expect(full.map((o) => o.label)).toEqual([
      'Initiative',
      'Project',
      'Milestone',
      'Assignee',
      'Team',
      'Status',
      'Priority',
      'Blocked',
      'At risk',
      'In next milestones',
    ]);
    expect(full.find((o) => o.value === 'quick:at_risk')?.hint).toBe('On');
    const guest = filterMenuOptions(query, {
      hasInitiatives: false,
      teamCount: 1,
    });
    expect(guest.map((o) => o.value)).not.toContain('field:initiativeIds');
    expect(guest.map((o) => o.value)).not.toContain('field:teamIds');
  });
});

describe('the filter pickers', () => {
  const options = demo.options();
  const context = (params: Record<string, string>, search = '') => ({
    query: parseIssueListParams(params),
    today: TODAY,
    viewerId: 'user-chloe',
    search,
  });

  test('milestones follow the project filter and end with "No milestone"', () => {
    const list = facetPickerOptions(
      'milestoneIds',
      options,
      context({ project: 'proj-garnet' })
    );
    expect(list.options.map((o) => [o.label, o.group, o.hint])).toEqual([
      ['Offline mode', 'Garnet mobile app', 'Oct 28'],
      ['Push notifications', 'Garnet mobile app', 'Nov 11'],
      ['No milestone', 'None', undefined],
    ]);
    expect(list.more).toBe(0);
    // Searching matches the project name too.
    const atlas = facetPickerOptions(
      'milestoneIds',
      options,
      context({}, 'atlas')
    );
    expect(atlas.options.map((o) => o.label)).toEqual([
      'Schema cutover',
      'Dual-write',
      'Read path switch',
    ]);
    expect(atlas.options[0]?.hint).toBe('complete');
  });

  test('a long list is cut to 200 with a "keep typing" line', () => {
    const many: IssueListOptions = {
      ...options,
      projects: [
        {
          id: 'proj-big',
          name: 'Big',
          active: true,
          statusName: 'In Progress',
          homeInitiativeId: null,
          teamIds: [],
          leadId: null,
          milestones: Array.from({ length: 250 }, (_, i) => ({
            id: `ms-${i}`,
            name: `Milestone ${i}`,
            targetDate: null,
            daysLeft: null,
            status: 'unscheduled' as const,
            isNext: false,
            weight: null,
          })),
        },
      ],
    };
    const list = facetPickerOptions('milestoneIds', many, context({}));
    expect(list.options).toHaveLength(PICKER_OPTION_LIMIT);
    expect(list.more).toBe(51);
    expect(moreOption(1800).label).toBe('Keep typing to narrow 1,800 more');
    expect(moreOption(1800).disabled).toBe(true);
  });

  test('people: me first, then unassigned, active people, deactivated ones', () => {
    const list = facetPickerOptions('assigneeIds', options, context({}));
    const labels = list.options.map((o) => o.label);
    expect(labels.slice(0, 2)).toEqual(['Me (Chloe Diaz)', 'Unassigned']);
    expect(labels).not.toContain('Chloe Diaz');
    expect(list.options.at(-1)).toMatchObject({
      label: 'Hugo Laurent',
      hint: 'deactivated',
    });
  });

  test('projects: active, then the rest, then "No project"; fixed lists need no fetch', () => {
    const projects = facetPickerOptions('projectIds', options, context({}));
    expect(projects.options.at(-2)).toMatchObject({
      label: 'Fjord analytics',
      group: 'Other projects',
    });
    expect(projects.options.at(-1)).toMatchObject({
      value: 'none',
      label: 'No project',
    });
    expect(
      facetPickerOptions('stateTypes', null, context({})).options.map(
        (o) => o.label
      )
    ).toEqual(['Triage', 'Backlog', 'Todo', 'In progress', 'Done', 'Canceled']);
    expect(
      facetPickerOptions('priorities', null, context({})).options.map(
        (o) => o.value
      )
    ).toEqual(['1', '2', '3', '4', '0']);
  });
});

describe('the page model', () => {
  test('heading, subtitle and receipts', () => {
    const page = pageOf({});
    expect(page.heading).toBe('Issues');
    expect(page.subtitle).toBe('Every issue across 9 projects.');
    expect(page.receipts).toBe(
      '44 open issues · 6 without a milestone · 5 blocked · 19 at risk'
    );
    expect(pageOf({ project: 'proj-garnet', milestone: 'none' }).receipts).toBe(
      '2 match these filters · 44 open in all'
    );
    const { view } = viewOf({ project: 'proj-atlas' });
    expect(issueListReceipts({ ...view, total: 700, shown: 500 })).toBe(
      '700 match these filters · 44 open in all · showing 500'
    );
  });

  test('the milestone cell names the milestone, then its project unless the view names it', () => {
    const rowOf = (params: Record<string, string>, key: string) =>
      pageOf(params)
        .sections.flatMap((s) => s.groups.flatMap((g) => g.rows))
        .find((row) => row.key === key);
    expect(rowOf({ group: 'state' }, 'ENG-12')).toMatchObject({
      milestone: 'Dual-write',
      milestoneProject: 'Atlas billing migration',
    });
    // Project groups and project sections already say it.
    const named: Record<string, string>[] = [
      { group: 'project' },
      { group: 'state', sections: 'project' },
    ];
    for (const params of named) {
      const row = rowOf(params, 'ENG-12');
      expect(row?.milestone).toBe('Dual-write');
      expect(row?.milestoneProject).toBeUndefined();
    }
    expect(rowOf({ group: 'state' }, 'ENG-54')).toMatchObject({
      milestone: null,
      milestoneProject: undefined,
    });
  });

  // Tones as the other screens draw the same states (architecture §8.2:
  // My week, the projects register, the issue page): an overdue date and
  // progress red, Blocked and Holds up filled amber chips, an open
  // unassigned issue's "Needs assignee" amber, an issue's own date due
  // tomorrow amber, each toned date with its word under it.
  test('the default view: tier dividers, milestone groups, toned rows', () => {
    const page = pageOf({});
    expect(page.sections.map((s) => s.label)).toEqual([
      'Overdue',
      'Upcoming',
      'No milestone',
      'Inactive projects',
    ]);
    const dualWrite = page.sections[0]?.groups[0];
    expect(dualWrite).toMatchObject({
      id: 't:overdue/m:ms-atlas-2',
      eyebrow: 'Atlas billing migration',
      title: 'Dual-write',
      href: '/timeline?milestone=ms-atlas-2',
      status: 'overdue',
      tags: ['Next'],
      count: 4,
      dueTone: 'danger',
      daysLeftLabel: '3 days overdue',
      progress: { done: 0, total: 4, tone: 'danger' },
      droppable: true,
    });
    const eng12 = dualWrite?.rows.find((r) => r.key === 'ENG-12');
    expect(eng12).toMatchObject({
      href: '/issues?issue=ENG-12',
      assignee: null,
      assigneeTone: 'warning',
      unassignedLabel: 'Needs assignee',
      due: 'Oct 20',
      dueTone: 'danger',
      dueNote: 'Overdue',
      chips: [
        { label: 'Holds up Search v2 beta', tone: 'warning', filled: true },
      ],
    });
    const upcoming = page.sections[1]?.groups ?? [];
    expect(upcoming[0]?.tags).toEqual(['Next', '↑5']);
    expect(upcoming.find((g) => g.title === 'Public beta')?.missingLabel).toBe(
      'Missing: done means…'
    );
    expect(
      upcoming.flatMap((g) => g.rows).find((r) => r.key === 'ENG-70')?.chips
    ).toEqual([{ label: 'Blocked', tone: 'warning', filled: true }]);
    const unplanned = page.sections[2]?.groups ?? [];
    expect(unplanned.map((g) => [g.eyebrow, g.title])).toEqual([
      ['Atlas billing migration', 'No milestone'],
      ['Garnet mobile app', 'No milestone'],
      [undefined, 'No project'],
    ]);
    // ENG-54 is due tomorrow: amber, as the issue page draws its date.
    const eng54 = unplanned[1]?.rows.find((r) => r.key === 'ENG-54');
    expect(eng54?.due).toBe('Oct 23');
    expect(eng54?.dueTone).toBe('warning');
    expect(eng54?.dueNote).toBe('Tomorrow');
    expect(page.columns).toEqual(['assignee', 'state', 'priority', 'due']);
    expect(page.storageKey).toBe(
      'milestone-planner:issues:collapsed:milestone'
    );
    expect(page.defaultCollapsed).toEqual([]);
    expect(page.empty).toBeNull();
  });

  // As My week and the projects register (progressTone): more work left
  // than time left tones the progress amber, not only an overdue date red.
  test('a behind-pace milestone draws its progress in amber', () => {
    const page = pageOf({});
    const upcoming = page.sections[1]?.groups ?? [];
    const byTitle = (title: string) => upcoming.find((g) => g.title === title);
    // At risk, behind pace: the progress is toned; the date is not due yet.
    expect(byTitle('Search v2 beta')).toMatchObject({
      status: 'at_risk',
      progress: { done: 3, total: 7, tone: 'warning' },
    });
    expect(byTitle('Search v2 beta')?.dueTone).toBeUndefined();
    expect(byTitle('Guided setup')?.progress?.tone).toBe('warning');
    // At risk only for being stalled: the progress itself says nothing.
    expect(byTitle('Offline mode')).toMatchObject({ status: 'at_risk' });
    expect(byTitle('Offline mode')?.progress?.tone).toBeUndefined();
    // On track: plain.
    expect(byTitle('Tokens and type')?.progress?.tone).toBeUndefined();
  });

  test('an inactive project is quiet everywhere', () => {
    const page = pageOf({});
    const fjord = page.sections[3]?.groups[0];
    expect(fjord).toMatchObject({
      eyebrow: 'Fjord analytics',
      muted: true,
      daysLeftLabel: 'Inactive project',
    });
    // Muted draws it grey: the inactive progress tone, no status hue.
    expect(fjord?.progress?.tone).toBe('muted');
    expect(fjord?.statusLabel?.endsWith(' · inactive project')).toBe(true);
    expect(fjord?.dueTone).toBeUndefined();
    for (const row of fjord?.rows ?? []) {
      expect(row.dueTone).toBeUndefined();
      expect(row.dueNote).toBeUndefined();
      expect(row.assigneeTone).toBeUndefined();
      expect(row.unassignedLabel).toBeUndefined();
      expect(row.chips).toBeUndefined();
    }
  });

  // One rule for "Unassigned" on every screen (§8.2 "Assignee", as the
  // milestone drawer, the graph slide-over and the issue page): amber
  // wherever the issue is open and its project active (or it has none),
  // in any milestone and in triage too; grey in an inactive project or
  // once closed. The amber one says "Needs assignee", so the two never
  // differ by hue alone.
  test('an open unassigned issue of an active project needs a person, in any milestone', () => {
    const rows = pageOf({ state: 'all' })
      .sections.flatMap((s) => s.groups)
      .flatMap((g) => g.rows);
    const tone = (key: string) => {
      const row = rows.find((r) => r.key === key);
      expect({ key, found: row !== undefined }).toEqual({ key, found: true });
      return [row?.assignee, row?.assigneeTone, row?.unassignedLabel];
    };
    const needs = [null, 'warning', 'Needs assignee'];
    const quiet = [null, undefined, undefined];
    // ENG-12 in Atlas's next milestone, ENG-17 in a later one, ENG-33 in
    // triage, OPS-31 in triage with no project.
    expect(tone('ENG-12')).toEqual(needs);
    expect(tone('ENG-17')).toEqual(needs);
    expect(tone('ENG-33')).toEqual(needs);
    expect(tone('OPS-31')).toEqual(needs);
    // OPS-9 in the inactive Fjord analytics, ENG-14 closed (a duplicate).
    expect(tone('OPS-9')).toEqual(quiet);
    expect(tone('ENG-14')).toEqual(quiet);
  });

  // The rest of §8.2's due-date and progress rules on the list: an undated
  // milestone's "No target date" is amber (a missing input), a complete
  // milestone's progress green with an ink date, and the group lines
  // ("Missing: …", "No lead", "Allocation stopped: …") the table draws in
  // amber.
  test('an undated milestone is amber, a complete one green, the group lines amber', () => {
    const upcoming = pageOf({}).sections[1]?.groups ?? [];
    expect(upcoming.find((g) => g.title === 'Localization')).toMatchObject({
      status: 'missing',
      dueLabel: 'No target date',
      dueTone: 'warning',
      missingLabel: 'Missing: target date',
    });
    const all = pageOf({ state: 'all' }).sections.flatMap((s) => s.groups);
    const done = all.find((g) => g.title === 'Schema cutover');
    expect(done).toMatchObject({
      status: 'done',
      daysLeftLabel: 'Complete',
      progress: { tone: 'success' },
    });
    expect(done?.dueTone).toBeUndefined();
    const projects = pageOf({ group: 'project' }).sections.flatMap(
      (s) => s.groups
    );
    expect(
      projects.find((g) => g.title === 'Delta exports')?.missingLabel
    ).toBe('Allocation stopped: Project has no lead');
    // Inactive projects carry neither a group line nor a toned row.
    const fjord = projects.find((g) => g.title === 'Fjord analytics');
    expect(fjord?.missingLabel).toBeUndefined();
    for (const row of fjord?.rows ?? []) {
      expect([row.chips, row.dueTone, row.assigneeTone]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
  });

  test('an issue’s own due date: red overdue, amber today or tomorrow, else plain', () => {
    expect(issueDueTone('2026-10-21', TODAY, false)).toBe('danger');
    expect(issueDueTone('2026-10-22', TODAY, false)).toBe('warning');
    expect(issueDueTone('2026-10-23', TODAY, false)).toBe('warning');
    expect(issueDueTone('2026-10-24', TODAY, false)).toBe('default');
    // A closed issue or one in an inactive project is never loud.
    expect(issueDueTone('2026-10-21', TODAY, true)).toBe('default');
    expect(issueDueTone('2026-10-23', TODAY, true)).toBe('default');
  });

  // The word under a toned date, so red and amber are never the only
  // difference (architecture §8.2 "due date"): only where there is a tone.
  test('a toned due date says its state in a word', () => {
    expect(issueDueNote('2026-10-19', TODAY, false)).toBe('Overdue');
    expect(issueDueNote('2026-10-21', TODAY, false)).toBe('Overdue');
    expect(issueDueNote('2026-10-22', TODAY, false)).toBe('Today');
    expect(issueDueNote('2026-10-23', TODAY, false)).toBe('Tomorrow');
    expect(issueDueNote('2026-10-24', TODAY, false)).toBeUndefined();
    expect(issueDueNote('2026-10-21', TODAY, true)).toBeUndefined();
    expect(issueDueNote('2026-10-23', TODAY, true)).toBeUndefined();
  });

  test('empty milestones of a named project are drop targets with the right sentence', () => {
    const page = pageOf({ project: 'proj-garnet', milestone: 'none' });
    const groups = page.sections.flatMap((s) => s.groups);
    const offline = groups.find((g) => g.title === 'Offline mode');
    expect(offline?.count).toBe(0);
    expect(offline?.emptyLabel).toBeUndefined();
    expect(offline?.footer?.text).toBe(
      'None of its 3 open issues match these filters.'
    );
    const only = offline?.footer?.actions[0];
    expect(only?.label).toBe('Only this milestone');
    expect(issueListHref(only?.query ?? DEFAULT_ISSUE_LIST_QUERY)).toBe(
      '/issues?project=proj-garnet&milestone=ms-garnet-1'
    );
    expect(only?.replace).toBe(false);
    const push = groups.find((g) => g.title === 'Push notifications');
    expect(push?.emptyLabel).toBe('No open issues here yet.');
    expect(push?.missingLabel).toBe('Missing: issues');
    const canMove = buildIssueListPage({
      ...MEMBER,
      canMove: true,
      ...viewOf({ project: 'proj-garnet', milestone: 'none' }),
    });
    expect(
      canMove.sections
        .flatMap((s) => s.groups)
        .find((g) => g.title === 'Push notifications')?.emptyLabel
    ).toBe(
      'No open issues here yet. Drag issues here, or use Move to milestone.'
    );
    expect(page.defaultCollapsed).toEqual([]);
  });

  test('a group cut by the row budget gets Show more and Only this …', () => {
    const { query, view } = viewOf({});
    const section = view.sections[1];
    const group = section?.groups[0];
    if (section === undefined || group === undefined)
      throw new Error('no group');
    const cut: IssueListView = {
      ...view,
      sections: [
        {
          ...section,
          groups: [
            { ...group, count: 212, rows: group.rows.slice(0, 2) },
            { ...group, key: 'x/unloaded', count: 9, rows: [] },
          ],
        },
      ],
    };
    const page = buildIssueListPage({ ...MEMBER, view: cut, query });
    const [shown, unloaded] = page.sections[0]?.groups ?? [];
    expect(shown?.footer?.text).toBe('Showing 2 of 212');
    expect(
      shown?.footer?.actions.map((a) => [a.label, a.replace, a.disabled])
    ).toEqual([
      ['Show more', true, false],
      ['Only this milestone', false, undefined],
    ]);
    expect(shown?.footer?.actions[0]?.query.limit).toBe(1000);
    expect(unloaded?.footer?.text).toBe('9 issues not shown');
    expect(page.defaultCollapsed).toEqual(['x/unloaded']);
    const atMax = buildIssueListPage({
      ...MEMBER,
      view: cut,
      query: { ...query, limit: 2000 },
    });
    const footer = atMax.sections[0]?.groups[0]?.footer;
    expect(footer?.text).toBe(
      'Showing 2 of 212. Narrow the filter to see the rest.'
    );
    expect(footer?.actions[0]?.disabled).toBe(true);
  });

  test('a complete milestone is folded by default', () => {
    const page = pageOf({ milestone: 'ms-atlas-1', state: 'all' });
    const group = page.sections.flatMap((s) => s.groups)[0];
    expect(group?.title).toBe('Schema cutover');
    expect(group?.daysLeftLabel).toBe('Complete');
    expect(page.defaultCollapsed).toEqual([group?.id]);
    // Closed rows are struck through, never toned.
    expect(group?.rows.every((r) => r.done === true)).toBe(true);
  });

  test('other groupings: people, statuses, priorities, projects, initiatives', () => {
    const people = pageOf({ group: 'assignee' }).sections[0]?.groups ?? [];
    expect(people[0]?.title).toBe('Chloe Diaz (you)');
    expect(people[0]?.mark).toEqual({ kind: 'avatar', name: 'Chloe Diaz' });
    expect(people.at(-1)?.title).toBe('Unassigned');
    const states = pageOf({ group: 'state' }).sections[0];
    expect(states?.label).toBeUndefined();
    expect(states?.groups.map((g) => g.title)).toEqual([
      'Triage',
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
    ]);
    expect(states?.groups[0]?.mark).toEqual({ kind: 'state', state: 'triage' });
    // In Review holds ENG's and OPS's issues alike.
    const review = states?.groups.find((g) => g.title === 'In Review');
    expect(review?.footer).toBeUndefined();
    const priorities = pageOf({ group: 'priority' }).sections[0]?.groups ?? [];
    expect(priorities.map((g) => g.title)).toEqual([
      'Urgent',
      'High',
      'Medium',
      'Low',
      'No priority',
    ]);
    const projects = pageOf({ group: 'project' }).sections[0]?.groups ?? [];
    const delta = projects.find((g) => g.title === 'Delta exports');
    expect(delta?.missingLabel).toBe('Allocation stopped: Project has no lead');
    const atlas = projects.find((g) => g.title === 'Atlas billing migration');
    expect(atlas?.eyebrow).toBe('Platform reliability');
    expect(atlas?.tags?.[0]?.startsWith('Lead: ')).toBe(true);
    const initiatives =
      pageOf({ group: 'initiative' }).sections[0]?.groups ?? [];
    expect(initiatives.map((g) => g.title)).toEqual([
      'Platform reliability',
      'Customer growth',
      'No initiative',
      'No project',
    ]);
    // An initiative takes no drop, but is asked so it can say why (the
    // reason shows while a row is dragged over it).
    expect(initiatives[0]?.droppable).toBe(true);
    const initiativePage = pageOf({ group: 'initiative' });
    expect(initiativePage.targets[initiatives[0]?.id ?? '']).toEqual({
      patch: null,
      projectOnly: false,
      reason:
        'Initiatives come from the project. Drop on a project or a milestone.',
      label: '',
    });
    expect(initiatives.map((g) => g.href)).toEqual([
      '/timeline?initiative=init-platform',
      '/timeline?initiative=init-growth',
      '/timeline?initiative=none',
      undefined,
    ]);
  });

  test('sections by initiative label each part', () => {
    const page = pageOf({ sections: 'initiative' });
    expect(page.sections.map((s) => s.label)).toEqual([
      'Platform reliability',
      'Customer growth',
      'No initiative',
      'No project',
    ]);
  });

  test('the notices, in order, worded by why', () => {
    const guest = pageOf(
      { initiative: 'init-platform', milestone: 'ms-gone' },
      {
        viewerId: 'user-gus',
        readOnly: true,
        readOnlyReason: 'guest',
        canWriteLinear: false,
      }
    );
    // The demo has initiatives, so no fallback here; a guest's snapshot
    // (tested below) lacks them.
    expect(guest.notices.map((n) => n.id)).toEqual(['read_only', 'unknown']);
    expect(guest.notices[0]?.text).toBe(
      'You are a guest in Linear, so this view is read-only.'
    );
    expect(guest.notices[0]?.action).toBeUndefined();

    const noGrant = pageOf(
      { project: 'proj-garnet', state: 'all' },
      { canWriteLinear: false }
    );
    expect(noGrant.notices.map((n) => n.id)).toEqual(['grant', 'closed']);
    expect(noGrant.notices[0]).toMatchObject({
      label: 'Linear read only',
      text: 'Allow edits in Linear to change issues here.',
      action: {
        label: 'Allow edits in Linear',
        href: `/api/auth/linear?intent=grant_write&returnTo=${encodeURIComponent('/issues?project=proj-garnet&state=all')}`,
      },
    });

    const cut = viewOf({});
    const more = buildIssueListPage({
      ...MEMBER,
      query: cut.query,
      view: { ...cut.view, moreGroups: { groups: 3, issues: 40 } },
    });
    expect(more.notices.map((n) => n.text)).toEqual([
      'Showing the first 200 groups. 3 more groups hold 40 issues. Narrow the filter to see them.',
    ]);
  });

  test('without initiatives the list falls back to projects, worded by why', () => {
    const plain = workspace((data) => {
      data.initiatives = [];
    });
    const query = parseIssueListParams({ group: 'initiative' });
    const view = plain.view(query);
    expect(view.fallback).toEqual({ reason: 'no_initiatives' });
    const words = (who: Partial<IssueListPageInput>) =>
      buildIssueListPage({ ...MEMBER, view, query, ...who }).notices.find(
        (n) => n.id === 'fallback'
      )?.text;
    expect(words({})).toBe(
      'This workspace has no initiatives in Linear, so the list is grouped by project.'
    );
    expect(words({ readOnly: true, readOnlyReason: 'guest' })).toBe(
      'Linear shows guests no initiatives, so this list covers every project you can see.'
    );
    expect(words({ readOnly: true, readOnlyReason: 'unknown' })).toBe(
      'The planner has not seen your Linear account yet, so it shows you no initiatives; this list covers every project you can see.'
    );
  });

  test('an initiative filter names the projects that count elsewhere', () => {
    const { view, query } = viewOf({ initiative: 'init-growth' });
    const page = buildIssueListPage({ ...MEMBER, view, query });
    const alsoIn = page.notices.filter((n) => n.id.startsWith('also_in:'));
    expect(alsoIn.length).toBe(view.alsoIn.length);
    for (const notice of alsoIn) {
      expect(notice.text).toMatch(
        /^.+ is also in Customer growth and counts under .+, its first initiative, as on the timeline\.$/
      );
    }
  });

  test('nothing matching: the empty state, with Clear filters when filtered', () => {
    expect(pageOf({ q: 'zzzz' }).empty).toEqual({
      message: 'No open issues match these filters.',
      clearable: true,
    });
    expect(pageOf({ q: 'zzzz', state: 'all' }).empty?.message).toBe(
      'No issues match these filters.'
    );
  });

  test('the model is plain data, and the filter names cross with it', () => {
    const { view } = viewOf({
      project: 'proj-garnet',
      milestone: 'ms-garnet-1',
      assignee: 'user-ben',
    });
    const page = buildIssueListPage({
      ...MEMBER,
      view,
      query: view.query,
    });
    expect(JSON.parse(JSON.stringify(page))).toEqual(page);
    const filterNames = filterValueNames(view);
    expect(filterNames).toEqual({
      initiatives: {},
      projects: { 'proj-garnet': 'Garnet mobile app' },
      milestones: {
        'ms-garnet-1': { name: 'Offline mode', projectId: 'proj-garnet' },
      },
      people: { 'user-ben': 'Ben Carter' },
      teams: {},
    });
    const names = namesFromFilterNames(filterNames);
    expect(names.milestone('ms-garnet-1')).toBe('Offline mode');
    expect(names.project('proj-atlas')).toBeUndefined();
    expect(
      milestoneProjectLookup(filterNames, demo.options())('ms-atlas-2')
    ).toBe('proj-atlas');
  });

  test('normalization stays core’s', () => {
    expect(parseIssueListParams({ group: 'state' })).toEqual(
      normalizeIssueListQuery({ group: 'state' })
    );
  });
});
