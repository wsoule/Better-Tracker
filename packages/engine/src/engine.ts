// createEngine: wires the engine modules into the Engine contract
// (src/types.ts). Each method delegates to a focused module; this file only
// adds the small listings that need no logic of their own, and the one
// read-only guard (owner decision 2026-10-22, "Guests limited to read
// only"): every method that changes something for a person is wrapped in
// `writable` (or calls requireWritable itself), so a Linear guest is
// refused with read_only before any module runs.

import { runAllocation } from './allocation-run';
import {
  authenticate,
  devSignIn,
  finishInstall,
  finishSignIn,
  listDemoUsers,
  publicInstallation,
  signOut,
  startOAuth,
} from './auth';
import { cleanup } from './cleanup';
import { runDaily } from './daily';
import { getIssueDetail } from './issue-detail';
import {
  addBlocker,
  addComment,
  removeRelation,
  updateIssue,
} from './issue-edits';
import { loadWorkspace } from './load';
import {
  setMilestoneDoneMeans,
  setMilestoneTargetDate,
  setMilestoneWeight,
  setProjectLead,
} from './milestone-edits';
import { requireWritable } from './permissions';
import { createRuntime, readSettings } from './runtime';
import { updateSettings } from './settings';
import { fullSync } from './sync';
import type { Actor, Engine, EngineDeps, LoadedWorkspace } from './types';
import {
  getGraph,
  getMilestoneDetail,
  getTimelineView,
  getWeekView,
} from './views';
import {
  viewerSnapshot,
  visibleAuditEntries,
  visibleRunEntries,
} from './visibility';
import { runWarnings } from './warning-run';
import { handleWebhook } from './webhooks';

/**
 * Wraps a mutating method whose first argument is the person making the
 * change: the read-only guard runs first (a rejected promise, like every
 * other engine error), then the module.
 */
function writable<Rest extends unknown[], R>(
  fn: (actor: Actor, ...rest: Rest) => Promise<R>
): (actor: Actor, ...rest: Rest) => Promise<R> {
  return async (actor, ...rest) => {
    requireWritable(actor);
    return fn(actor, ...rest);
  };
}

/** Builds the engine over its dependencies (store, Linear, channel, …). */
export function createEngine(deps: EngineDeps): Engine {
  const rt = createRuntime(deps);
  return {
    config: deps.config,
    mode: deps.linear.mode,

    startOAuth: (intent) => startOAuth(rt, intent),
    finishSignIn: (input) => finishSignIn(rt, input),
    finishInstall: async (input) => {
      requireWritable(input.actor);
      return finishInstall(rt, input);
    },
    devSignIn: (userId) => devSignIn(rt, userId),
    authenticate: (token) => authenticate(rt, token),
    signOut: (token) => signOut(rt, token),
    listDemoUsers: () => listDemoUsers(rt),

    load: async (workspaceId, viewer): Promise<LoadedWorkspace> => {
      // Hand out the contract's shape only (no internal eval context).
      const loaded = await loadWorkspace(rt, workspaceId, { viewer });
      return {
        workspaceId: loaded.workspaceId,
        snapshot: loaded.snapshot,
        settings: loaded.settings,
        today: loaded.today,
        assessments: loaded.assessments,
        allocationPlan: loaded.allocationPlan,
        syncState: loaded.syncState,
        mirrorVersion: loaded.mirrorVersion,
      };
    },
    getSettings: async (workspaceId) =>
      (await readSettings(rt, workspaceId)).settings,
    getWeekView: (workspaceId, userId, viewer) =>
      getWeekView(rt, workspaceId, userId, viewer),
    getTimelineView: (workspaceId, viewer) =>
      getTimelineView(rt, workspaceId, viewer),
    getGraph: (workspaceId, scope, viewer) =>
      getGraph(rt, workspaceId, scope, viewer),
    getMilestoneDetail: (workspaceId, milestoneId, viewer) =>
      getMilestoneDetail(rt, workspaceId, milestoneId, viewer),
    listRuns: (workspaceId, limit) => deps.store.listRuns(workspaceId, limit),
    getRun: async (workspaceId, runId, viewer) => {
      const found = await deps.store.getRun(workspaceId, runId);
      if (found === null || viewer === undefined) return found;
      const loaded = await loadWorkspace(rt, workspaceId, { viewer });
      const seen = viewerSnapshot(loaded.fullSnapshot, workspaceId, viewer);
      return {
        run: found.run,
        entries: visibleRunEntries(loaded.fullSnapshot, seen, found.entries),
      };
    },
    listNotifications: (workspaceId, limit) =>
      deps.store.listNotifications(workspaceId, { limit }),
    listAudit: async (workspaceId, limit, viewer) => {
      const entries = await deps.store.listAudit(workspaceId, limit);
      if (viewer === undefined) return entries;
      const loaded = await loadWorkspace(rt, workspaceId, { viewer });
      const seen = viewerSnapshot(loaded.fullSnapshot, workspaceId, viewer);
      return visibleAuditEntries(loaded.fullSnapshot, seen, entries);
    },
    getInstallation: async (workspaceId) => {
      const installation = await deps.store.getInstallation(workspaceId);
      return installation === null ? null : publicInstallation(installation);
    },

    fullSync: (workspaceId) => fullSync(rt, workspaceId),
    handleWebhook: (event) => handleWebhook(rt, event),
    // Only the contract's fields: a public caller can never skip the
    // fresh sync the plan depends on (syncFirst is internal to runDaily).
    // A person's run is a change; the worker's (actor null) is not theirs.
    runAllocation: async (input) => {
      if (input.actor !== null) requireWritable(input.actor);
      return runAllocation(rt, {
        workspaceId: input.workspaceId,
        mode: input.mode,
        trigger: input.trigger,
        actor: input.actor,
      });
    },
    // The digest preview shows everyone's digests: not for a guest.
    runWarnings: async (input) => {
      if (input.viewer !== undefined) requireWritable(input.viewer);
      return runWarnings(rt, input);
    },
    runDaily: (input) => runDaily(rt, input),
    listWorkspaceIds: async () =>
      (await deps.store.listInstallations())
        .filter((installation) => installation.revokedAt === null)
        .map((installation) => installation.workspaceId),
    listRevokedWorkspaceIds: async () =>
      (await deps.store.listInstallations())
        .filter((installation) => installation.revokedAt !== null)
        .map((installation) => installation.workspaceId),

    setMilestoneTargetDate: writable((actor, milestoneId, targetDate) =>
      setMilestoneTargetDate(rt, actor, milestoneId, targetDate)
    ),
    setProjectLead: writable((actor, projectId, leadId) =>
      setProjectLead(rt, actor, projectId, leadId)
    ),
    setMilestoneWeight: writable((actor, milestoneId, weight) =>
      setMilestoneWeight(rt, actor, milestoneId, weight)
    ),
    setMilestoneDoneMeans: writable((actor, milestoneId, text) =>
      setMilestoneDoneMeans(rt, actor, milestoneId, text)
    ),
    updateSettings: writable((actor, patch) =>
      updateSettings(rt, actor, patch)
    ),

    getIssueDetail: (actor, issueId) => getIssueDetail(rt, actor, issueId),
    updateIssue: writable((actor, issueId, patch) =>
      updateIssue(rt, actor, issueId, patch)
    ),
    addComment: writable((actor, issueId, body) =>
      addComment(rt, actor, issueId, body)
    ),
    addBlocker: writable((actor, issueId, blockerIssueId) =>
      addBlocker(rt, actor, issueId, blockerIssueId)
    ),
    removeRelation: writable((actor, relationId) =>
      removeRelation(rt, actor, relationId)
    ),

    cleanup: () => cleanup(rt),
    now: () => rt.nowIso(),
    close: () => deps.store.close(),
  };
}
