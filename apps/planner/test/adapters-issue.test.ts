import type { EstimateScale, IssueDetail } from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  buildIssueTaskModel,
  estimateText,
  findIssue,
  issueActivity,
  issueAlerts,
  issueChainHref,
  issuePagePath,
  parseIssueParam,
  searchIssueMirror,
  whenDue,
  withIssueParam,
} from '../lib/adapters/issue';
import {
  detailOf,
  extrasFor,
  FIBONACCI,
  history,
  modelFor,
  names,
  resultFor,
  snapshot,
  TODAY,
} from './issue-fixture';

// The issue view model against the demo workspace (test/issue-fixture.ts:
// what LINEAR_FIXTURE=1 serves, on Wednesday, October 21, 2026).

describe('links and lookups', () => {
  test('the page path and the ?issue= link keep the rest of the URL', () => {
    expect(issuePagePath('ENG-24')).toBe('/issues/ENG-24');
    expect(withIssueParam('/week', 'ENG-24')).toBe('/week?issue=ENG-24');
    expect(withIssueParam('/week?user=user-ben', 'ENG-1')).toBe(
      '/week?user=user-ben&issue=ENG-1'
    );
    expect(withIssueParam('/timeline?milestone=m1&issue=ENG-1', 'ENG-2')).toBe(
      '/timeline?milestone=m1&issue=ENG-2'
    );
    expect(withIssueParam('/graph?issue=ENG-1', null)).toBe('/graph');
    expect(withIssueParam('/graph?project=p&issue=ENG-1', null)).toBe(
      '/graph?project=p'
    );
  });

  test('?issue= is read once, trimmed, and bounded', () => {
    expect(parseIssueParam({ issue: ' ENG-24 ' })).toBe('ENG-24');
    expect(parseIssueParam({ issue: ['ENG-1', 'ENG-2'] })).toBe('ENG-1');
    expect(parseIssueParam({ issue: '' })).toBeNull();
    expect(parseIssueParam({ issue: 'x'.repeat(201) })).toBeNull();
    expect(parseIssueParam({})).toBeNull();
  });

  test('an issue is found by id or by identifier in any case', () => {
    // core's findIssue, still exported here for the routes and loaders.
    expect(findIssue(snapshot.issues, 'iss-eng-24')?.identifier).toBe('ENG-24');
    expect(findIssue(snapshot.issues, 'eng-24')?.id).toBe('iss-eng-24');
    expect(findIssue(snapshot.issues, 'ENG-999')).toBeUndefined();
  });
});

describe('searchIssueMirror', () => {
  test('identifiers first (exact, prefix, containing), then titles', () => {
    expect(searchIssueMirror(snapshot, 'eng-12')[0]?.key).toBe('ENG-12');
    const byNumber = searchIssueMirror(snapshot, '24').map((hit) => hit.key);
    expect(byNumber).toContain('ENG-24');
    const byTitle = searchIssueMirror(snapshot, 'search analytics');
    expect(byTitle.map((hit) => hit.key)).toEqual(['ENG-24']);
    expect(byTitle[0]).toMatchObject({
      id: 'iss-eng-24',
      title: 'Search analytics events',
      stateKind: 'unstarted',
      stateName: 'Todo',
      open: true,
      group: 'Beacon search / Search v2 beta',
    });
  });

  test('accents and case are ignored; open issues lead', () => {
    const hits = searchIssueMirror(snapshot, 'DUAL');
    expect(hits.length).toBeGreaterThan(0);
    const firstClosed = hits.findIndex((hit) => !hit.open);
    const lastOpen = hits.map((hit) => hit.open).lastIndexOf(true);
    if (firstClosed !== -1) expect(lastOpen).toBeLessThan(firstClosed);
    expect(searchIssueMirror(snapshot, 'dúal').length).toBe(hits.length);
  });

  test('an empty query lists open issues, the near issue’s milestone first', () => {
    const hits = searchIssueMirror(snapshot, '', { near: 'iss-eng-24' });
    expect(hits.length).toBe(20);
    expect(hits.every((hit) => hit.open)).toBe(true);
    expect(hits[0]?.group).toBe('Beacon search / Search v2 beta');
    expect(searchIssueMirror(snapshot, '', { limit: 3 })).toHaveLength(3);
  });
});

describe('alerts', () => {
  test('an overdue, stalled, unassigned next-milestone issue that holds others up', () => {
    const detail = detailOf('ENG-12');
    const alerts = issueAlerts(detail, TODAY, { closed: false, quiet: false });
    // Stalled and unassigned are said once, by the toned "Time in state"
    // and "Assignee" properties, not again as alerts.
    expect(alerts.map((a) => a.label)).toEqual(['Overdue', 'Holds up']);
    // Status colours (architecture §8.2): overdue is danger, the rest warn.
    expect(alerts.map((a) => a.tone)).toEqual(['danger', 'warning']);
    expect(alerts[0]?.message).toBe('Dual-write was due Oct 18, 3 days ago.');
    expect(alerts[1]?.message).toContain('Beacon search / Search v2 beta');
    // Holds up opens the issue's own blocking chain.
    expect(alerts[1]?.action).toEqual({
      label: 'Graph',
      href: '/graph?chain=ENG-12',
    });
    const facts = modelFor('ENG-12').facts;
    expect(facts.inState).toMatchObject({
      tone: 'warning',
      noteTone: 'warning',
    });
    expect(facts.inState.note).toMatch(
      /^Stalled: Backlog with no change since /
    );
    expect(facts.assignee).toMatchObject({
      text: 'Unassigned',
      tone: 'warning',
    });
    expect(facts.assignee.note).toMatch(
      /^In the next milestone, Dual-write \(due Oct 18, 3 days overdue\)/
    );
  });

  test('a blocked issue names what it waits on, with its chain as a graph', () => {
    const alerts = issueAlerts(detailOf('ENG-23'), TODAY, {
      closed: false,
      quiet: false,
    });
    const blocked = alerts.find((a) => a.id === 'blocked');
    expect(blocked?.tone).toBe('warning');
    expect(blocked?.message).toBe('Waiting on ENG-12 (Backlog, unassigned).');
    // It was the milestone's issue graph (?milestone=ms-beacon-1) before
    // graphs at every level; now it is ENG-23's own blocking chain.
    expect(blocked?.action).toEqual({
      label: 'Graph',
      href: '/graph?chain=ENG-23',
    });
  });

  test('the chain link exists only for an issue with a relation', () => {
    expect(issueChainHref(detailOf('ENG-23'))).toBe('/graph?chain=ENG-23');
    expect(issueChainHref(detailOf('ENG-12'))).toBe('/graph?chain=ENG-12');
    // ENG-24 neither blocks nor waits on anything in the demo.
    expect(issueChainHref(detailOf('ENG-24'))).toBeNull();
    expect(modelFor('ENG-23').chainHref).toBe('/graph?chain=ENG-23');
    expect(modelFor('ENG-24').chainHref).toBeNull();
  });

  test('a slide-over drawn over its own chain offers no link to it', () => {
    // /graph?chain=ENG-23&issue=ENG-23: the chain is already the page.
    const own = modelFor('ENG-23', {}, 'user-chloe', '/graph?chain=ENG-23');
    expect(own.chainHref).toBeNull();
    expect(own.alerts.find((a) => a.id === 'blocked')?.action).toBeUndefined();
    // Over another issue's chain (or anywhere else) the link stays.
    const other = modelFor('ENG-23', {}, 'user-chloe', '/graph?chain=ENG-12');
    expect(other.chainHref).toBe('/graph?chain=ENG-23');
    expect(other.alerts.find((a) => a.id === 'blocked')?.action).toEqual({
      label: 'Graph',
      href: '/graph?chain=ENG-23',
    });
  });

  test('closed issues and inactive projects stay quiet', () => {
    expect(
      issueAlerts(detailOf('ENG-12'), TODAY, { closed: true, quiet: false })
    ).toEqual([]);
    const fjord = modelFor('OPS-8');
    expect(fjord.quiet).toBe(true);
    expect(fjord.alerts).toEqual([]);
    expect(fjord.facts.milestone.glyph).toMatchObject({
      kind: 'status',
      muted: true,
      label: 'Overdue · inactive project',
    });
    expect(fjord.facts.project.note).toMatch(/inactive project$/);
    expect(fjord.facts.inState.tone).toBe('default');
    expect(fjord.facts.dueDate.tone).toBe('default');
  });

  test('allocation is called stopped when the project has no working lead', () => {
    const detail = detailOf('ENG-31');
    const noLead: IssueDetail = {
      ...detail,
      project:
        detail.project === null ? null : { ...detail.project, lead: null },
    };
    const assignee = modelFor('ENG-31', { detail: noLead }).facts.assignee;
    expect(assignee.note).toContain(
      'has no lead, so nothing in it is allocated.'
    );
    expect(assignee.noteTone).toBe('warning');
  });
});

describe('buildIssueTaskModel', () => {
  test('crumbs, status and the read-only facts', () => {
    const model = modelFor('ENG-24');
    expect(model).toMatchObject({
      issueId: 'iss-eng-24',
      key: 'ENG-24',
      title: 'Search analytics events',
      pagePath: '/issues/ENG-24',
      closed: false,
      quiet: false,
      status: { kind: 'unstarted', label: 'Todo' },
      canEdit: true,
      liveError: null,
    });
    expect(model.crumbs).toEqual([
      { label: 'Beacon search', href: '/timeline?project=proj-beacon' },
      { label: 'Search v2 beta', href: '/timeline?milestone=ms-beacon-1' },
      { label: 'ENG-24' },
    ]);
    expect(model.facts.priority).toMatchObject({
      text: 'Medium',
      glyph: { kind: 'priority', priority: 3 },
    });
    expect(model.facts.labels.text).toBe('Bug');
    // Read-only labels draw as chips in Linear's colour.
    expect(model.facts.labels.labels).toEqual([
      { name: 'Bug', color: expect.stringMatching(/^#[0-9a-f]{6}$/i) },
    ]);
    expect(model.facts.estimate).toMatchObject({
      text: '3 points',
      mono: true,
    });
    expect(model.facts.dueDate).toMatchObject({
      text: 'Oct 19',
      tone: 'danger',
      note: '2 days overdue',
      noteTone: 'muted',
    });
    expect(model.facts.project.note).toBe('Lead Dev Patel');
    expect(model.facts.inState).toMatchObject({
      text: '2 days',
      tone: 'default',
      note: 'Todo since Oct 19',
    });
    expect(modelFor('ENG-12').facts.inState).toMatchObject({
      tone: 'warning',
      note: 'Stalled: Backlog with no change since Oct 1',
      noteTone: 'warning',
    });
    expect(model.viewerId).toBe('user-chloe');
    expect(model.facts.milestone.note).toBe(
      'At risk · due Oct 23, in 2 days · 3 of 7 done · next milestone'
    );
  });

  test('due dates: overdue is danger, today or tomorrow warning, later neutral', () => {
    const due = (dueDate: string) =>
      modelFor('ENG-24', {
        extra: extrasFor(detailOf('ENG-24'), { dueDate }),
      }).facts.dueDate;
    expect(due('2026-10-21')).toMatchObject({
      tone: 'warning',
      note: 'Due today',
      noteTone: 'muted',
    });
    expect(due('2026-10-22')).toMatchObject({
      tone: 'warning',
      note: 'Due tomorrow',
    });
    expect(due('2026-10-30')).toMatchObject({
      tone: 'default',
      note: 'In 9 days',
      noteTone: 'muted',
    });
  });

  test('under a day in its state reads "today" or "yesterday" by the calendar', () => {
    const at = (lastStateChangeAt: string) => {
      const result = resultFor('ENG-24');
      return buildIssueTaskModel({
        result: {
          ...result,
          detail: {
            ...result.detail,
            timing: {
              ...result.detail.timing,
              lastStateChangeAt,
              daysInState: 0,
            },
          },
        },
        today: TODAY,
        timeZone: 'UTC',
        viewerId: 'user-chloe',
        grantWriteHref: '/x',
        names,
      }).facts.inState;
    };
    expect(at('2026-10-21T08:00:00.000Z')).toMatchObject({
      text: 'Since today',
      note: 'Todo since Oct 21',
    });
    // 15 hours ago on the clock, but the day before on the calendar.
    expect(at('2026-10-20T21:00:00.000Z')).toMatchObject({
      text: 'Since yesterday',
      note: 'Todo since Oct 20',
    });
  });

  test('an unassigned open issue is loud; the viewer reads as "you"', () => {
    expect(modelFor('ENG-13').facts.assignee).toMatchObject({
      text: 'Unassigned',
      tone: 'warning',
      avatar: '',
    });
    const mine = modelFor('ENG-24', {}, 'user-ana');
    expect(mine.facts.assignee.text).toBe('Ana Moreno (you)');
    expect(mine.facts.assignee.avatar).toBe('Ana Moreno');
  });

  test('the planner’s live assignment is named under the assignee', () => {
    const given = {
      allocationHistory: [
        history({
          issueId: 'iss-eng-16',
          assigneeId: detailOf('ENG-16').assignee?.id ?? 'user-chloe',
        }),
      ],
    };
    expect(modelFor('ENG-16', given, 'user-ana').facts.assignee.note).toBe(
      'Given by the planner on Oct 14: they lead Atlas billing migration.'
    );
    expect(modelFor('ENG-16', given, 'user-chloe').facts.assignee.note).toBe(
      'Given to you by the planner on Oct 14: you lead Atlas billing migration.'
    );
    // A dry run never gave it to anyone.
    const dry = { allocationHistory: [history({ runMode: 'dry_run' })] };
    expect(modelFor('ENG-16', dry).facts.assignee.note).toBeUndefined();
  });

  test('comments: authors, bots muted, oldest first, local dates', () => {
    const { comments } = modelFor('ENG-24');
    expect(comments.items).toEqual([
      {
        id: 'c-1',
        author: 'Dev Patel',
        at: 'Oct 20',
        dateTime: '2026-10-20T09:00:00.000Z',
        body: 'Started on this.',
        href: 'https://linear.app/northwind/issue/X#comment-c-1',
        tone: 'default',
      },
      {
        id: 'c-2',
        author: 'GitHub',
        at: 'Oct 21',
        dateTime: '2026-10-21T08:00:00.000Z',
        body: 'Synced from GitHub.',
        href: undefined,
        tone: 'muted',
      },
    ]);
    expect(comments.note).toBe('From Linear');
    const many = modelFor('ENG-24', {
      extra: extrasFor(detailOf('ENG-24'), { commentsTruncated: true }),
    });
    expect(many.comments.note).toBe('First 2 · more in Linear');
  });

  test('relations keep their Linear relation id and context', () => {
    const model = modelFor('ENG-23');
    expect(model.relations.blockedBy).toEqual([
      {
        relationId: expect.any(String) as string,
        issueId: 'iss-eng-12',
        taskKey: 'ENG-12',
        title: detailOf('ENG-12').issue.title,
        state: { kind: 'backlog', label: 'Backlog' },
        assignee: null,
        context: 'Atlas billing migration / Dual-write',
        external: false,
        resolved: false,
      },
    ]);
    expect(model.relations.blocks.map((row) => row.taskKey)).toEqual([
      'OPS-20',
    ]);
    expect(model.relations.hiddenNote).toBeNull();
  });

  test('the edit options: states in order, people, projects grouped, milestones per project', () => {
    const { edit } = modelFor('ENG-24');
    expect(edit.values).toMatchObject({
      title: 'Search analytics events',
      stateId: detailOf('ENG-24').state?.id,
      assigneeId: 'user-ana',
      priority: 3,
      projectId: 'proj-beacon',
      milestoneId: 'ms-beacon-1',
      live: {
        description: 'Line one\nLine two',
        labelIds: ['l-bug'],
        estimate: 3,
        dueDate: '2026-10-19',
      },
    });
    expect(edit.states.map((s) => s.kind)).toContain('unstarted');
    expect(edit.people.some((p) => p.id === 'user-app')).toBe(false);
    expect(edit.projects[0]?.group).toBe('Active projects');
    expect(edit.milestones['proj-beacon']?.map((m) => m.name)).toEqual([
      'Search v2 beta',
      'Search v2 GA',
    ]);
    expect(edit.labels.find((l) => l.id === 'l-s')?.group).toEqual({
      id: 'g-size',
      name: 'Size',
      singleSelect: true,
    });
    expect(edit.estimates?.map((e) => e.label)).toEqual([
      '1',
      '2',
      '3',
      '5',
      '8',
    ]);
    expect(edit.limits).toEqual({
      title: 255,
      description: 100_000,
      comment: 10_000,
    });
  });

  test('when Linear cannot be read, the live fields say so and are not editable', () => {
    const model = modelFor('ENG-24', {
      extra: null,
      labels: [],
      estimateScale: null,
      estimateOptions: [],
      extraError:
        'Linear did not answer; the description, labels and comments could not be loaded.',
      extraSource: null,
    });
    expect(model.edit.values.live).toBeNull();
    expect(model.edit.estimates).toBeNull();
    expect(model.facts.labels.text).toBe('Unavailable');
    expect(model.facts.dueDate.text).toBe('Unavailable');
    expect(model.description).toEqual({
      text: null,
      error:
        'Linear did not answer; the description, labels and comments could not be loaded.',
      sourceLabel: 'From Linear',
    });
    expect(model.comments.error).toBe(model.liveError);
  });

  test('a team without estimates gets no estimate picker', () => {
    const none: EstimateScale = {
      type: 'notUsed',
      allowZero: false,
      extended: false,
    };
    const detail = detailOf('ENG-24');
    const model = modelFor('ENG-24', {
      extra: extrasFor(detail, { estimate: null, estimateScale: none }),
      estimateScale: none,
      estimateOptions: [],
    });
    expect(model.edit.estimates).toBeNull();
    expect(model.facts.estimate.text).toBe('Not used');
  });

  test('without write access the model says so and carries the grant link', () => {
    const model = modelFor('ENG-24', { canEdit: false });
    expect(model.canEdit).toBe(false);
    expect(model.readOnly).toBe(false);
    expect(model.grantWriteHref).toBe(
      '/api/auth/linear?intent=grant_write&returnTo=%2Fx'
    );
  });

  // Owner decision 2026-10-22, "Guests limited to read only": a Linear
  // guest's view edits nothing, even from a result that still says canEdit.
  test('a Linear guest gets a read-only model', () => {
    expect(
      modelFor('ENG-24', { canEdit: false, readOnly: true })
    ).toMatchObject({ canEdit: false, readOnly: true });
    expect(modelFor('ENG-24', { canEdit: true, readOnly: true })).toMatchObject(
      { canEdit: false, readOnly: true }
    );
  });
});

describe('activity', () => {
  test('allocation decisions and lifecycle, newest first; repeats folded', () => {
    const detail = detailOf('ENG-13');
    const items = issueActivity(
      detail,
      [
        history({
          seq: 3,
          outcome: 'planned',
          runMode: 'dry_run',
          createdAt: '2026-10-21T06:00:00.000Z',
        }),
        history({
          seq: 2,
          outcome: 'planned',
          runMode: 'dry_run',
          createdAt: '2026-10-20T06:00:00.000Z',
        }),
        history({
          seq: 1,
          action: 'skip',
          outcome: 'noted',
          reason: 'triage',
          createdAt: '2026-10-19T06:00:00.000Z',
        }),
      ],
      { today: TODAY, timeZone: 'UTC', names }
    );
    const planned = items.find(
      (item) => item.label === 'Would be assigned to Chloe Diaz'
    );
    expect(planned).toMatchObject({
      at: 'Oct 21',
      tone: 'muted',
      href: '/runs/run-1',
    });
    expect(planned?.detail).toEqual(
      'Daily run · dry run · nothing was written to Linear. Seen in 2 runs.'
    );
    expect(
      items.find((item) => item.label === 'Skipped by the planner')?.detail
    ).toBe('Daily run: it was still in Triage.');
    expect(items.at(-1)?.label).toBe('Created in Linear');
    expect(items.at(-1)?.tone).toBe('muted');
    const instants = items.map((item) => item.dateTime ?? '');
    expect([...instants].sort().reverse()).toEqual(instants);
  });
});

describe('activity tones', () => {
  test('assigned is success, a failed comment warning, a failed write danger', () => {
    const items = issueActivity(
      detailOf('ENG-13'),
      [
        history({ seq: 3, createdAt: '2026-10-21T06:00:00.000Z' }),
        history({
          seq: 2,
          error: 'comment rejected',
          assigneeId: 'user-dev',
          createdAt: '2026-10-20T06:00:00.000Z',
        }),
        history({
          seq: 1,
          outcome: 'failed',
          error: 'Linear said no.',
          assigneeId: 'user-ana',
          createdAt: '2026-10-19T06:00:00.000Z',
        }),
      ],
      { today: TODAY, timeZone: 'UTC', names }
    );
    const tones = new Map(items.map((item) => [item.label, item.tone]));
    expect(tones.get('Assigned to Chloe Diaz by the planner')).toBe('success');
    expect(tones.get('Assigned to Dev Patel by the planner')).toBe('warning');
    expect(tones.get('Assigning Ana Moreno failed')).toBe('danger');
  });
});

describe('wording', () => {
  test('whenDue', () => {
    expect(whenDue(null, null, TODAY)).toBe('no target date');
    expect(whenDue('2026-10-21', 0, TODAY)).toBe('due today');
    expect(whenDue('2026-10-22', 1, TODAY)).toBe('due tomorrow');
    expect(whenDue('2026-10-23', 2, TODAY)).toBe('due Oct 23, in 2 days');
    expect(whenDue('2026-10-20', -1, TODAY)).toBe('due Oct 20, 1 day overdue');
    expect(whenDue('2026-10-01', -20, TODAY, true)).toBe('complete · Oct 1');
  });

  test('estimateText', () => {
    expect(estimateText(FIBONACCI, 1)).toBe('1 point');
    expect(estimateText(FIBONACCI, 5)).toBe('5 points');
    expect(
      estimateText({ type: 'tShirt', allowZero: false, extended: false }, 5)
    ).toBe('L');
  });
});
