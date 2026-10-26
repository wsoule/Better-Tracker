// createEngine: wires the engine modules into the Engine contract
// (src/types.ts). Each method delegates to a focused module; this file only
// adds the small listings that need no logic of their own, and the one
// read-only guard (owner decision 2026-10-22, "Guests limited to read
// only"): every method that changes something for a person is wrapped in
// `writable` (or calls requireWritable itself), so a Linear guest is
// refused with read_only before any module runs. finishInstall uses
// requireCanInstall, which also lets a workspace whose first sync has not
// landed be reinstalled. With personal API keys (config.auth api_key) the
// auth methods go to key-auth.ts, OAuth is off, nothing runs unattended
// (no scheduled run, digest or webhook) and the logs fail closed. In OAuth
// mode one deployment serves every workspace admission admits (owner
// decision 2026-10-25, admission.ts): admission gates workspaces, never
// people, so it adds no permission distinction.

import { admittedInstalledWorkspaceIds, workspaceOverview } from './admission';
import { runAllocation } from './allocation-run';
import {
  authenticate,
  checkSession,
  describeSessions,
  devSignIn,
  finishInstall,
  finishSignIn,
  listDemoUsers,
  OAUTH_OFF_MESSAGE,
  publicInstallation,
  signOut,
  startOAuth,
} from './auth';
import { updateIssues } from './bulk-issue-edits';
import { cleanup } from './cleanup';
import { runDaily } from './daily';
import { sharedSlackReason } from './fail-safes';
import { getIssueDetail } from './issue-detail';
import {
  addBlocker,
  addComment,
  removeRelation,
  updateIssue,
} from './issue-edits';
import { getIssueList, getIssueListOptions } from './issue-list';
import {
  authenticateWithKey,
  bindingFor,
  connectApiKey,
  getKeyConnection,
  signOutWithKey,
} from './key-auth';
import { loadWorkspace } from './load';
import {
  setMilestoneDoneMeans,
  setMilestoneTargetDate,
  setMilestoneWeight,
  setProjectLead,
} from './milestone-edits';
import { requireCanInstall, requireWritable } from './permissions';
import { createRuntime, readSettings } from './runtime';
import { updateSettings } from './settings';
import { fullSync } from './sync';
import {
  type Actor,
  type Engine,
  type EngineDeps,
  EngineInputError,
  type LoadedWorkspace,
} from './types';
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
import {
  blockWorkspace,
  OPERATOR_OFF_MESSAGE,
  purgeWorkspaceNow,
  removeWorkspace,
  revokeWorkspace,
  unblockWorkspace,
} from './workspaces';

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

/** What scheduled work says with personal API keys (§7.8). */
export const SCHEDULED_OFF_MESSAGE =
  'Scheduled runs are off when the planner uses personal API keys: nothing can read Linear while nobody is connected.';

/** Builds the engine over its dependencies (store, Linear, channel, …). */
export function createEngine(deps: EngineDeps): Engine {
  const rt = createRuntime(deps);
  const apiKeyMode = deps.config.auth === 'api_key';
  const pin = deps.config.apiKey?.workspacePin ?? null;
  const oauthOff = (): never => {
    throw new EngineInputError('invalid', OAUTH_OFF_MESSAGE);
  };
  const scheduledOff = (): never => {
    throw new EngineInputError('invalid', SCHEDULED_OFF_MESSAGE);
  };
  // Log entries pass the visibility filters failing closed with personal
  // keys: the mirror is then the reader key's view (§7.6).
  const logVisibility = { failClosed: apiKeyMode };
  return {
    config: deps.config,
    mode: deps.linear.mode,

    startOAuth: (intent) => (apiKeyMode ? oauthOff() : startOAuth(rt, intent)),
    finishSignIn: async (input) =>
      apiKeyMode ? oauthOff() : finishSignIn(rt, input),
    finishInstall: async (input) => {
      if (apiKeyMode) oauthOff();
      requireCanInstall(input.actor);
      return finishInstall(rt, input);
    },
    devSignIn: async (userId) =>
      apiKeyMode ? oauthOff() : devSignIn(rt, userId),
    authenticate: (token) =>
      apiKeyMode ? authenticateWithKey(rt, token) : authenticate(rt, token),
    // Switching workspaces: neither is a write, so no requireWritable (a
    // guest may switch); both are null / [] with personal API keys.
    checkSession: (token) => checkSession(rt, token),
    describeSessions: (tokens) => describeSessions(rt, tokens),
    signOut: async (token, options) =>
      apiKeyMode ? signOutWithKey(rt, token, options) : signOut(rt, token),
    connectApiKey: (input) => connectApiKey(rt, input),
    getKeyConnection: (actor) => getKeyConnection(rt, actor),
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
    // Reads: a guest gets the list and its options too.
    getIssueList: (workspaceId, query, viewer) =>
      getIssueList(rt, workspaceId, query, viewer),
    getIssueListOptions: (workspaceId, viewer) =>
      getIssueListOptions(rt, workspaceId, viewer),
    listRuns: (workspaceId, limit) => deps.store.listRuns(workspaceId, limit),
    getRun: async (workspaceId, runId, viewer) => {
      const found = await deps.store.getRun(workspaceId, runId);
      if (found === null || viewer === undefined) return found;
      const loaded = await loadWorkspace(rt, workspaceId, { viewer });
      const seen = viewerSnapshot(loaded.fullSnapshot, workspaceId, viewer);
      return {
        run: found.run,
        entries: visibleRunEntries(
          loaded.fullSnapshot,
          seen,
          found.entries,
          logVisibility
        ),
      };
    },
    listNotifications: (workspaceId, limit) =>
      deps.store.listNotifications(workspaceId, { limit }),
    listAudit: async (workspaceId, limit, viewer) => {
      const entries = await deps.store.listAudit(workspaceId, limit);
      if (viewer === undefined) return entries;
      const loaded = await loadWorkspace(rt, workspaceId, { viewer });
      const seen = viewerSnapshot(loaded.fullSnapshot, workspaceId, viewer);
      return visibleAuditEntries(
        loaded.fullSnapshot,
        seen,
        entries,
        logVisibility
      );
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
    // The digest preview shows everyone's digests: not for a guest. With
    // personal keys only the preview runs (nothing is sent).
    runWarnings: async (input) => {
      if (apiKeyMode && input.previewOnly !== true) scheduledOff();
      if (input.viewer !== undefined) requireWritable(input.viewer);
      return runWarnings(rt, input);
    },
    runDaily: async (input) =>
      apiKeyMode ? scheduledOff() : runDaily(rt, input),
    listWorkspaceIds: async () => {
      if (apiKeyMode) {
        const binding = await bindingFor(deps.store, pin);
        return binding === null || binding.revokedAt !== null
          ? []
          : [binding.workspaceId];
      }
      // Active installations admission admits, least recently synced
      // first; refused ones are skipped (info), never failures.
      return admittedInstalledWorkspaceIds(rt);
    },
    listRevokedWorkspaceIds: async () =>
      apiKeyMode
        ? []
        : (await deps.store.listInstallations())
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
    updateIssues: writable((actor, issueIds, patch) =>
      updateIssues(rt, actor, issueIds, patch)
    ),

    // Workspace lifecycle and the operator's commands (workspaces.ts): for
    // the worker's CLI only, never a planner route.
    listWorkspaceStatus: () => workspaceOverview(rt),
    revokeWorkspace: async (workspaceId, reason, options) => {
      if (apiKeyMode) {
        throw new EngineInputError('invalid', OPERATOR_OFF_MESSAGE);
      }
      return revokeWorkspace(rt, workspaceId, reason, options);
    },
    removeWorkspace: (idOrUrlKey) => removeWorkspace(rt, idOrUrlKey),
    purgeWorkspaceNow: (idOrUrlKey, options) =>
      purgeWorkspaceNow(rt, idOrUrlKey, options),
    blockWorkspace: (idOrUrlKey, reason) =>
      blockWorkspace(rt, idOrUrlKey, reason),
    unblockWorkspace: (idOrUrlKey) => unblockWorkspace(rt, idOrUrlKey),
    listBlockedWorkspaces: () => deps.store.listBlockedWorkspaces(),

    cleanup: async () => {
      // Personal keys: forget expired ones too (the scheduler also does).
      rt.keys?.vault.sweep();
      return cleanup(rt);
    },
    now: () => rt.nowIso(),
    ping: () => deps.store.ping(),
    digestChannel: async () => {
      const { channel } = deps;
      if (channel.name !== 'slack' || !channel.delivers) return 'outbox';
      try {
        return (await sharedSlackReason(deps.config, deps.store)) === null
          ? 'slack'
          : 'outbox';
      } catch {
        return 'slack';
      }
    },
    close: async () => {
      rt.keys?.scheduler?.close();
      rt.keys?.vault.clear();
      await deps.store.close();
    },
  };
}
