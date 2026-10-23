// The issue list's reads (owner request 2026-10-22, architecture §7) over
// the demo workspace: built from the viewer's narrowed snapshot, "me"
// resolved to the viewer, a guest served (with the no-initiatives
// fallback), and options that never name what the viewer cannot see.

import {
  DEFAULT_ISSUE_LIST_QUERY,
  normalizeIssueListQuery,
} from '@better-tracker/core';
import { FIXTURE_GUEST_USER_ID } from '@better-tracker/linear';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type Actor, EngineAuthError } from '../src/index';
import {
  actorFor,
  createDemoHarness,
  type DemoHarness,
  rejection,
  WORKSPACE_ID,
} from './helpers';

let h: DemoHarness;
let chloe: Actor;
let gus: Actor;

beforeAll(async () => {
  h = await createDemoHarness();
  chloe = await actorFor(h, 'user-chloe');
  gus = await actorFor(h, FIXTURE_GUEST_USER_ID);
});
afterAll(async () => {
  await h.close();
});

/** Every row's identifier, in display order. */
function identifiers(view: {
  sections: { groups: { rows: { identifier: string }[] }[] }[];
}): string[] {
  return view.sections.flatMap((section) =>
    section.groups.flatMap((group) => group.rows.map((row) => row.identifier))
  );
}

describe('getIssueList', () => {
  test('a member sees every open issue in milestone groups under the tiers', async () => {
    const { view, mirrorVersion } = await h.engine.getIssueList(
      WORKSPACE_ID,
      DEFAULT_ISSUE_LIST_QUERY,
      chloe
    );
    expect(mirrorVersion).toBe(
      (await h.engine.load(WORKSPACE_ID)).mirrorVersion
    );
    expect(view.sections.map((section) => section.key)).toEqual([
      't:overdue',
      't:upcoming',
      't:unplanned',
      't:inactive',
    ]);
    // Atlas's overdue Dual-write comes first; paused Fjord comes last.
    expect(view.sections[0]?.groups[0]?.key).toBe('t:overdue/m:ms-atlas-2');
    expect(view.sections[3]?.groups.map((group) => group.key)).toEqual([
      't:inactive/m:ms-fjord-1',
    ]);
    expect(view.fallback).toBeNull();
    expect(view.total).toBe(view.counts.all);
    expect(view.counts.all).toBe(44);
  });

  test('"me" is the viewer', async () => {
    const mine = normalizeIssueListQuery({ filters: { assigneeIds: ['me'] } });
    const { view } = await h.engine.getIssueList(WORKSPACE_ID, mine, chloe);
    expect(identifiers(view)).toEqual(['ENG-10', 'ENG-51', 'ENG-16']);
    expect(view.counts.mine).toBe(3);
    // Without a viewer (the worker's own reads), "me" matches nothing.
    const { view: nobody } = await h.engine.getIssueList(WORKSPACE_ID, mine);
    expect(nobody.total).toBe(0);
  });

  test('a guest sees Operations only, without initiatives, with the fallback', async () => {
    const query = normalizeIssueListQuery({
      filters: { initiativeIds: ['init-platform'] },
      group: 'initiative',
    });
    const { view } = await h.engine.getIssueList(WORKSPACE_ID, query, gus);
    expect(view.fallback).toEqual({ reason: 'no_initiatives' });
    expect(view.query.group).toBe('project');
    expect(view.query.filters.initiativeIds).toEqual([]);
    const keys = identifiers(view);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('OPS-'))).toBe(true);
    expect(Object.keys(view.refs.teams)).toEqual(['team-ops']);
    expect(view.refs.initiatives).toEqual({});
    // An Engineering milestone named in a URL is not found, like an unknown one.
    const named = await h.engine.getIssueList(
      WORKSPACE_ID,
      normalizeIssueListQuery({ filters: { milestoneIds: ['ms-atlas-2'] } }),
      gus
    );
    expect(named.view.unknownIds).toEqual([
      { facet: 'milestone', id: 'ms-atlas-2' },
    ]);
    expect(named.view.sections).toEqual([]);
    expect(JSON.stringify(named.view)).not.toContain('Dual-write');
  });

  test('a viewer of another workspace is refused', async () => {
    const stranger: Actor = {
      ...chloe,
      session: { ...chloe.session, workspaceId: 'ws-other' },
    };
    const error = await rejection(
      h.engine.getIssueList(WORKSPACE_ID, DEFAULT_ISSUE_LIST_QUERY, stranger)
    );
    expect(error).toBeInstanceOf(EngineAuthError);
    expect(error).toMatchObject({ code: 'wrong_workspace' });
    const options = await rejection(
      h.engine.getIssueListOptions(WORKSPACE_ID, stranger)
    );
    expect(options).toMatchObject({ code: 'wrong_workspace' });
  });
});

describe('getIssueListOptions', () => {
  test("a member gets every project; a guest only his team's, narrowed", async () => {
    const member = await h.engine.getIssueListOptions(WORKSPACE_ID, chloe);
    expect(member.mirrorVersion).toBe(
      (await h.engine.load(WORKSPACE_ID)).mirrorVersion
    );
    expect(member.options.initiatives.map((i) => i.id).sort()).toEqual([
      'init-growth',
      'init-platform',
    ]);
    expect(member.options.projects).toHaveLength(9);
    expect(
      member.options.projects.find((p) => p.id === 'proj-compass')?.teamIds
    ).toEqual(['team-eng', 'team-ops']);

    const guest = await h.engine.getIssueListOptions(WORKSPACE_ID, gus);
    expect(guest.options.initiatives).toEqual([]);
    expect(guest.options.teams.map((t) => t.id)).toEqual(['team-ops']);
    expect(
      guest.options.teams[0]?.states.every((s) => s.id.startsWith('st-ops-'))
    ).toBe(true);
    // Compass and Juniper are shared with Engineering, which Gus cannot
    // see: the browser gets only the team he sees.
    const shared = guest.options.projects.filter((p) =>
      ['proj-compass', 'proj-juniper'].includes(p.id)
    );
    expect(shared.map((p) => [p.id, p.teamIds])).toEqual([
      ['proj-compass', ['team-ops']],
      ['proj-juniper', ['team-ops']],
    ]);
    expect(guest.options.projects.map((p) => p.id)).not.toContain('proj-atlas');
    expect(
      guest.options.projects.every((p) => p.homeInitiativeId === null)
    ).toBe(true);
  });
});
