// createEngine: wires the engine modules into the Engine contract
// (src/types.ts). Each method delegates to a focused module; this file only
// adds the small listings that need no logic of their own.

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
import { createRuntime, readSettings } from './runtime';
import { updateSettings } from './settings';
import { fullSync } from './sync';
import type { Engine, EngineDeps, LoadedWorkspace } from './types';
import {
  getGraph,
  getMilestoneDetail,
  getTimelineView,
  getWeekView,
} from './views';
import { runWarnings } from './warning-run';
import { handleWebhook } from './webhooks';

/** Builds the engine over its dependencies (store, Linear, channel, …). */
export function createEngine(deps: EngineDeps): Engine {
  const rt = createRuntime(deps);
  return {
    config: deps.config,
    mode: deps.linear.mode,

    startOAuth: (intent) => startOAuth(rt, intent),
    finishSignIn: (input) => finishSignIn(rt, input),
    finishInstall: (input) => finishInstall(rt, input),
    devSignIn: (userId) => devSignIn(rt, userId),
    authenticate: (token) => authenticate(rt, token),
    signOut: (token) => signOut(rt, token),
    listDemoUsers: () => listDemoUsers(rt),

    load: async (workspaceId): Promise<LoadedWorkspace> => {
      // Hand out the contract's shape only (no internal eval context).
      const loaded = await loadWorkspace(rt, workspaceId);
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
    getWeekView: (workspaceId, userId) => getWeekView(rt, workspaceId, userId),
    getTimelineView: (workspaceId) => getTimelineView(rt, workspaceId),
    getGraph: (workspaceId, scope) => getGraph(rt, workspaceId, scope),
    getMilestoneDetail: (workspaceId, milestoneId) =>
      getMilestoneDetail(rt, workspaceId, milestoneId),
    listRuns: (workspaceId, limit) => deps.store.listRuns(workspaceId, limit),
    getRun: (workspaceId, runId) => deps.store.getRun(workspaceId, runId),
    listNotifications: (workspaceId, limit) =>
      deps.store.listNotifications(workspaceId, { limit }),
    listAudit: (workspaceId, limit) => deps.store.listAudit(workspaceId, limit),
    getInstallation: async (workspaceId) => {
      const installation = await deps.store.getInstallation(workspaceId);
      return installation === null ? null : publicInstallation(installation);
    },

    fullSync: (workspaceId) => fullSync(rt, workspaceId),
    handleWebhook: (event) => handleWebhook(rt, event),
    // Only the contract's fields: a public caller can never skip the
    // fresh sync the plan depends on (syncFirst is internal to runDaily).
    runAllocation: (input) =>
      runAllocation(rt, {
        workspaceId: input.workspaceId,
        mode: input.mode,
        trigger: input.trigger,
        actor: input.actor,
      }),
    runWarnings: (input) => runWarnings(rt, input),
    runDaily: (input) => runDaily(rt, input),
    listWorkspaceIds: async () =>
      (await deps.store.listInstallations())
        .filter((installation) => installation.revokedAt === null)
        .map((installation) => installation.workspaceId),

    setMilestoneTargetDate: (actor, milestoneId, targetDate) =>
      setMilestoneTargetDate(rt, actor, milestoneId, targetDate),
    setProjectLead: (actor, projectId, leadId) =>
      setProjectLead(rt, actor, projectId, leadId),
    setMilestoneWeight: (actor, milestoneId, weight) =>
      setMilestoneWeight(rt, actor, milestoneId, weight),
    setMilestoneDoneMeans: (actor, milestoneId, text) =>
      setMilestoneDoneMeans(rt, actor, milestoneId, text),
    updateSettings: (actor, patch) => updateSettings(rt, actor, patch),

    getIssueDetail: (actor, issueId) => getIssueDetail(rt, actor, issueId),
    updateIssue: (actor, issueId, patch) =>
      updateIssue(rt, actor, issueId, patch),
    addComment: (actor, issueId, body) => addComment(rt, actor, issueId, body),
    addBlocker: (actor, issueId, blockerIssueId) =>
      addBlocker(rt, actor, issueId, blockerIssueId),
    removeRelation: (actor, relationId) =>
      removeRelation(rt, actor, relationId),

    cleanup: () => cleanup(rt),
    now: () => rt.nowIso(),
    close: () => deps.store.close(),
  };
}
