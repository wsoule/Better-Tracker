import {
  type AllocationMode,
  BLOCK_REASON_LABEL,
  ISSUE_SKIP_REASON_LABEL,
  missingLine,
  orderProjects,
  type RubricGap,
  RUBRIC_GAP_LABEL,
  type Snapshot,
} from '@better-tracker/core';
import type { Engine } from '@better-tracker/engine';
import type { ChipTone } from '@better-tracker/ui';

import { formatInstant, plural } from '../format';

/** The store's run row, as the engine returns it. */
export type AllocationRun = Awaited<ReturnType<Engine['listRuns']>>[number];
/** One logged decision of a run (assign / skip / block). */
export type RunEntry = NonNullable<
  Awaited<ReturnType<Engine['getRun']>>
>['entries'][number];
export type RunStatus = AllocationRun['status'];

// The allocation run log (architecture §8.4 "Runs", §7 runAllocation): the
// /runs register and the /runs/[id] detail, mapped from the store's
// AllocationRun and RunEntry rows. Names come from the mirror (people,
// projects, issues, workflow states); every instant is shown in the
// workspace timezone. Pure functions; the pages stay thin.

/**
 * Why a planned live assignment was not written (the engine's
 * STALE_REASON_LABEL, restated here so client bundles never import the
 * engine package).
 */
export const STALE_REASON_TEXT: Record<string, string> = {
  not_found: 'No longer exists in Linear',
  closed: 'Closed in Linear since the plan was made',
  now_assigned: 'Someone was assigned in Linear since the plan was made',
  moved_milestone: 'Moved to another milestone since the plan was made',
  now_triage: 'Moved back to Triage since the plan was made',
};

export const MODE_LABEL: Record<AllocationMode, string> = {
  dry_run: 'Dry run',
  live: 'Live',
};

/** DRY RUN is a hollow ink chip; LIVE (it wrote to Linear) the accent. */
export const MODE_TONE: Record<AllocationMode, ChipTone> = {
  dry_run: 'default',
  live: 'accent',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partly failed',
  failed: 'Failed',
};

const RUN_STATUS_TONE: Record<RunStatus, ChipTone> = {
  running: 'muted',
  succeeded: 'default',
  partial: 'accent',
  failed: 'accent',
};

export function runHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

/** "0.4 s", "12 s", "3 min 4 s"; null while the run has not finished. */
export function formatDuration(
  startedAt: string,
  finishedAt: string | null
): string | null {
  if (finishedAt === null) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 100) return 'under 0.1 s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

function personName(snapshot: Snapshot, userId: string | null): string | null {
  if (userId === null) return null;
  return snapshot.users.get(userId)?.name ?? 'Someone no longer in Linear';
}

/**
 * Who started a run: the daily schedule, a person, or (manual with nobody
 * attached) the worker's command line.
 */
export function startedByLabel(
  run: Pick<AllocationRun, 'trigger' | 'startedByUserId'>,
  snapshot: Snapshot
): string {
  if (run.trigger === 'schedule') return 'Daily schedule';
  return personName(snapshot, run.startedByUserId) ?? 'Worker command line';
}

// ---------------------------------------------------------------------------
// /runs
// ---------------------------------------------------------------------------

export interface RunCounts {
  assigned: number;
  wouldAssign: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export interface RunRowModel {
  id: string;
  href: string;
  /** When it started, in the workspace timezone. */
  title: string;
  /** "Daily schedule", "Ana Moreno". */
  startedBy: string;
  trigger: string;
  /** The mono line under the start time: "Manual · Ana Moreno", or
      "Daily schedule" (the trigger says the same thing twice there). */
  byline: string;
  mode: AllocationMode;
  modeLabel: string;
  modeTone: ChipTone;
  statusLabel: string;
  statusTone: ChipTone;
  /** Null while running (the summary is written when it finishes). */
  counts: RunCounts | null;
  /** "Oct 21, 3:04 PM CDT", or "Still running". */
  finished: string;
  /** "took 1.2 s", or null while running. */
  took: string | null;
  rowTone: 'default' | 'accent';
  rowLabel: string;
}

export function runRow(
  run: AllocationRun,
  snapshot: Snapshot,
  timeZone: string
): RunRowModel {
  const title = formatInstant(run.startedAt, timeZone);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  const summary = run.summary;
  const counts: RunCounts | null =
    summary === null
      ? null
      : {
          assigned: summary.assigned,
          wouldAssign: summary.wouldAssign,
          failed: summary.failed,
          blocked: summary.blockedProjects,
          skipped: summary.skippedIssues,
        };
  const needsAction =
    run.status === 'failed' ||
    run.status === 'partial' ||
    (counts !== null && counts.failed > 0);
  const startedBy = startedByLabel(run, snapshot);
  return {
    id: run.id,
    href: runHref(run.id),
    title,
    startedBy,
    trigger: run.trigger === 'schedule' ? 'Scheduled' : 'Manual',
    byline: run.trigger === 'schedule' ? startedBy : `Manual · ${startedBy}`,
    mode: run.mode,
    modeLabel: MODE_LABEL[run.mode],
    modeTone: MODE_TONE[run.mode],
    statusLabel: RUN_STATUS_LABEL[run.status],
    statusTone: RUN_STATUS_TONE[run.status],
    counts,
    finished:
      run.finishedAt === null
        ? 'Still running'
        : formatInstant(run.finishedAt, timeZone),
    took: duration === null ? null : `took ${duration}`,
    rowTone: needsAction ? 'accent' : 'default',
    rowLabel: `${MODE_LABEL[run.mode]} started ${title}`,
  };
}

export interface RunsPageModel {
  rows: RunRowModel[];
  receipts: string;
  /** settings.allocationMode is live: PMs may start a live run. */
  liveRunsOn: boolean;
  /** People who can start a run, for the copy non-PMs see. */
  pmNames: string[];
}

export function buildRunsPage(input: {
  runs: readonly AllocationRun[];
  snapshot: Snapshot;
  timeZone: string;
  allocationMode: AllocationMode;
  pmUserIds: readonly string[];
}): RunsPageModel {
  const rows = input.runs.map((run) =>
    runRow(run, input.snapshot, input.timeZone)
  );
  const liveRunsOn = input.allocationMode === 'live';
  const mode = liveRunsOn
    ? 'Allocation is live: the daily run assigns issues in Linear.'
    : 'Allocation is in dry run: runs record what they would assign and change nothing in Linear.';
  const count =
    rows.length === 0
      ? 'No runs logged yet.'
      : `${plural(rows.length, 'run')} logged, newest first.`;
  return {
    rows,
    receipts: `${mode} ${count}`,
    liveRunsOn,
    pmNames: input.pmUserIds
      .map((id) => input.snapshot.users.get(id))
      .filter((user) => user !== undefined && user.active && !user.app)
      .map((user) => user?.name ?? ''),
  };
}

// ---------------------------------------------------------------------------
// /runs/[id]
// ---------------------------------------------------------------------------

export type RunIssueOutcome =
  | 'planned'
  | 'applied'
  | 'failed'
  | 'stale'
  | 'skipped';

const OUTCOME_LABEL: Record<RunIssueOutcome, string> = {
  planned: 'Would assign',
  applied: 'Assigned',
  failed: 'Failed',
  stale: 'Not written',
  skipped: 'Skipped',
};

const OUTCOME_TONE: Record<RunIssueOutcome, ChipTone> = {
  planned: 'default',
  applied: 'inverse',
  failed: 'accent',
  stale: 'muted',
  skipped: 'muted',
};

export interface RunIssueRow {
  key: string;
  identifier: string;
  title: string;
  /** The issue in Linear, when the mirror still has it. */
  href: string | null;
  outcome: RunIssueOutcome;
  outcomeLabel: string;
  outcomeTone: ChipTone;
  /** "Ana Moreno" (to whom), or null for skips. */
  assignee: string | null;
  /** "Backlog → Todo", "Stays In Progress", or null. */
  stateMove: string | null;
  /** Why (stale/skip reason, the error), or null. */
  reason: string | null;
  reasonTone: 'default' | 'muted' | 'accent';
}

export interface RunBlock {
  reason: string;
  /** The notice's sentence: "Next milestone Public beta is missing
      required details.", "Project has no lead (next milestone: CSV
      exports)." */
  sentence: string;
  /** "missing: done means…, issues", or null. */
  gaps: string | null;
  /** Each missing item as a full line ("Missing a target date"). */
  gapLines: string[];
  milestone: string | null;
}

export interface RunProjectGroup {
  id: string;
  name: string;
  /** The project's lane on the timeline. */
  href: string;
  /** The next milestone the entries are for, if known. */
  milestone: string | null;
  meta: string;
  block: RunBlock | null;
  rows: RunIssueRow[];
  /** already_assigned skips, collapsed into one line. */
  alreadyAssigned: number;
  tone: 'default' | 'accent';
}

export interface RunProperty {
  label: string;
  value: string;
}

export interface RunStat {
  id: string;
  label: string;
  value: number;
  note?: string;
  tone: 'default' | 'muted' | 'accent';
}

export interface RunDetailModel {
  id: string;
  heading: string;
  receipts: string;
  mode: AllocationMode;
  modeLabel: string;
  modeTone: ChipTone;
  statusLabel: string;
  statusTone: ChipTone;
  properties: RunProperty[];
  stats: RunStat[];
  /** The run's own error (it threw, or assignments failed). */
  error: string | null;
  /** What this run did or did not write to Linear, and how to undo it. */
  note: { label: string; body: string };
  groups: RunProjectGroup[];
  crumb: string;
}

function stringField(detail: Record<string, unknown>, key: string) {
  const value = detail[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isRubricGap(value: unknown): value is RubricGap {
  return typeof value === 'string' && Object.hasOwn(RUBRIC_GAP_LABEL, value);
}

function stateName(snapshot: Snapshot, stateId: string | null): string | null {
  if (stateId === null) return null;
  return snapshot.states.get(stateId)?.name ?? null;
}

/**
 * "Backlog → Todo" when the entry moves the issue, "Stays In Progress"
 * when it keeps its state (already past Backlog, or the team has no Todo).
 */
export function stateMoveLabel(
  snapshot: Snapshot,
  detail: Record<string, unknown>
): string | null {
  const from = stateName(snapshot, stringField(detail, 'fromStateId'));
  const toId = stringField(detail, 'toStateId');
  const to = stateName(snapshot, toId);
  if (
    toId !== null &&
    from !== null &&
    to !== null &&
    toId !== stringField(detail, 'fromStateId')
  ) {
    return `${from} → ${to}`;
  }
  return from === null ? null : `Stays ${from}`;
}

function assignRow(entry: RunEntry, snapshot: Snapshot): RunIssueRow {
  const issue =
    entry.issueId === null ? undefined : snapshot.issues.get(entry.issueId);
  const identifier = entry.issueIdentifier ?? issue?.identifier ?? 'Issue';
  const title =
    stringField(entry.detail, 'title') ?? issue?.title ?? 'Untitled issue';
  let outcome: RunIssueOutcome;
  let reason: string | null = null;
  let reasonTone: RunIssueRow['reasonTone'] = 'default';
  switch (entry.outcome) {
    case 'applied':
      outcome = 'applied';
      if (entry.error !== null) {
        reason = entry.error;
        reasonTone = 'accent';
      } else {
        reason = 'Linear comment left on the issue';
        reasonTone = 'muted';
      }
      break;
    case 'failed':
      outcome = 'failed';
      reason = entry.error ?? 'The Linear write failed.';
      reasonTone = 'accent';
      break;
    case 'stale':
      outcome = 'stale';
      reason =
        entry.reason === null
          ? 'No longer applied when re-checked in Linear'
          : (STALE_REASON_TEXT[entry.reason] ?? entry.reason);
      reasonTone = 'muted';
      break;
    default:
      outcome = 'planned';
  }
  return {
    key: `${entry.seq}`,
    identifier,
    title,
    href: issue?.url ?? null,
    outcome,
    outcomeLabel: OUTCOME_LABEL[outcome],
    outcomeTone: OUTCOME_TONE[outcome],
    assignee: personName(snapshot, entry.assigneeId),
    stateMove: stateMoveLabel(snapshot, entry.detail),
    reason,
    reasonTone,
  };
}

function skipRow(entry: RunEntry, snapshot: Snapshot): RunIssueRow {
  const issue =
    entry.issueId === null ? undefined : snapshot.issues.get(entry.issueId);
  const reason =
    entry.reason !== null &&
    Object.hasOwn(ISSUE_SKIP_REASON_LABEL, entry.reason)
      ? ISSUE_SKIP_REASON_LABEL[
          entry.reason as keyof typeof ISSUE_SKIP_REASON_LABEL
        ]
      : (entry.reason ?? 'Skipped');
  return {
    key: `${entry.seq}`,
    identifier: entry.issueIdentifier ?? issue?.identifier ?? 'Issue',
    title: issue?.title ?? 'Issue no longer in the mirror',
    href: issue?.url ?? null,
    outcome: 'skipped',
    outcomeLabel: OUTCOME_LABEL.skipped,
    outcomeTone: OUTCOME_TONE.skipped,
    assignee: null,
    stateMove: null,
    reason,
    reasonTone: 'muted',
  };
}

function blockOf(entry: RunEntry, snapshot: Snapshot): RunBlock {
  const reason =
    entry.reason !== null && Object.hasOwn(BLOCK_REASON_LABEL, entry.reason)
      ? BLOCK_REASON_LABEL[entry.reason as keyof typeof BLOCK_REASON_LABEL]
      : (entry.reason ?? 'Blocked');
  const raw = entry.detail['gaps'];
  const gaps = Array.isArray(raw) ? raw.filter(isRubricGap) : [];
  const milestone =
    entry.milestoneId === null
      ? null
      : (snapshot.milestones.get(entry.milestoneId)?.name ?? null);
  // "Next milestone is missing required details (next milestone: X)"
  // names the milestone twice; say it once.
  const sentence =
    milestone === null
      ? `${reason}.`
      : entry.reason === 'next_milestone_invalid'
        ? `Next milestone ${milestone} is missing required details.`
        : `${reason} (next milestone: ${milestone}).`;
  return {
    reason,
    sentence,
    gaps: gaps.length === 0 ? null : missingLine(gaps),
    gapLines: gaps.map((gap) => RUBRIC_GAP_LABEL[gap]),
    milestone,
  };
}

/** The collapsed line for already-assigned skips ("Skipped 2 issues …"). */
export function alreadyAssignedLine(count: number): string {
  return `Skipped ${plural(count, 'issue')} that already ${count === 1 ? 'has' : 'have'} an assignee: allocation never reassigns.`;
}

/** Rows within a project: what was (or would be) assigned first, then skips. */
const OUTCOME_ORDER: Record<RunIssueOutcome, number> = {
  failed: 0,
  applied: 1,
  planned: 2,
  stale: 3,
  skipped: 4,
};

function groupMeta(group: RunProjectGroup): string {
  const parts: string[] = [];
  const count = (outcome: RunIssueOutcome) =>
    group.rows.filter((row) => row.outcome === outcome).length;
  if (group.block !== null) parts.push('Blocked');
  if (count('applied') > 0) parts.push(`${count('applied')} assigned`);
  if (count('planned') > 0) parts.push(`${count('planned')} would assign`);
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  if (count('stale') > 0) parts.push(`${count('stale')} not written`);
  const skipped = count('skipped') + group.alreadyAssigned;
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(' · ');
}

/**
 * Groups a run's entries by project, in timeline order (projects the
 * mirror no longer has last): assignments and Triage skips as rows,
 * already-assigned skips as a count, blocks as the group's reason.
 */
export function groupRunEntries(
  entries: readonly RunEntry[],
  snapshot: Snapshot
): RunProjectGroup[] {
  const order = new Map(
    orderProjects(snapshot).map((project, index) => [project.id, index])
  );
  const groups = new Map<string, RunProjectGroup>();
  for (const entry of entries) {
    let group = groups.get(entry.projectId);
    if (group === undefined) {
      const project = snapshot.projects.get(entry.projectId);
      group = {
        id: entry.projectId,
        name: project?.name ?? 'Project no longer in Linear',
        href: `/timeline?project=${encodeURIComponent(entry.projectId)}`,
        milestone: null,
        meta: '',
        block: null,
        rows: [],
        alreadyAssigned: 0,
        tone: 'default',
      };
      groups.set(entry.projectId, group);
    }
    if (group.milestone === null && entry.milestoneId !== null) {
      group.milestone =
        snapshot.milestones.get(entry.milestoneId)?.name ?? null;
    }
    if (entry.action === 'block') {
      group.block = blockOf(entry, snapshot);
    } else if (entry.action === 'skip') {
      if (entry.reason === 'already_assigned') group.alreadyAssigned += 1;
      else group.rows.push(skipRow(entry, snapshot));
    } else {
      group.rows.push(assignRow(entry, snapshot));
    }
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.rows.sort((a, b) => {
      const byOutcome = OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome];
      return byOutcome !== 0 ? byOutcome : Number(a.key) - Number(b.key);
    });
    group.meta = groupMeta(group);
    group.tone =
      group.block !== null || group.rows.some((row) => row.outcome === 'failed')
        ? 'accent'
        : 'default';
  }
  return list.sort((a, b) => {
    const byOrder =
      (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.id) ?? Number.MAX_SAFE_INTEGER);
    return byOrder !== 0 ? byOrder : a.name.localeCompare(b.name);
  });
}

function countOutcome(
  entries: readonly RunEntry[],
  outcome: RunEntry['outcome']
): number {
  return entries.filter(
    (entry) => entry.action === 'assign' && entry.outcome === outcome
  ).length;
}

/** Everything /runs/[id] shows for one run. */
export function buildRunDetail(input: {
  run: AllocationRun;
  entries: readonly RunEntry[];
  snapshot: Snapshot;
  timeZone: string;
}): RunDetailModel {
  const { run, entries, snapshot, timeZone } = input;
  const started = formatInstant(run.startedAt, timeZone);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  const who = startedByLabel(run, snapshot);
  const groups = groupRunEntries(entries, snapshot);
  const applied = countOutcome(entries, 'applied');
  const planned = countOutcome(entries, 'planned');
  const failed = countOutcome(entries, 'failed');
  const stale = countOutcome(entries, 'stale');
  const skipped = entries.filter((entry) => entry.action === 'skip').length;
  const blocked = entries.filter((entry) => entry.action === 'block').length;
  const live = run.mode === 'live';

  const properties: RunProperty[] = [
    { label: 'Mode', value: MODE_LABEL[run.mode] },
    {
      label: 'Trigger',
      value: run.trigger === 'schedule' ? 'Scheduled (daily)' : 'Manual',
    },
    { label: 'Started by', value: who },
    { label: 'Started', value: started },
    {
      label: 'Finished',
      value:
        run.finishedAt === null
          ? 'Still running'
          : formatInstant(run.finishedAt, timeZone),
    },
    { label: 'Duration', value: duration ?? '—' },
    { label: 'Status', value: RUN_STATUS_LABEL[run.status] },
  ];

  // At most four cells (the strip's width): a dry run cannot fail or go
  // stale, a live run's skips are listed per project below.
  const blockedStat: RunStat = {
    id: 'blocked',
    label: 'Blocked projects',
    value: blocked,
    note: blocked > 0 ? 'missing an input' : undefined,
    tone: blocked > 0 ? 'accent' : 'muted',
  };
  const stats: RunStat[] = live
    ? [
        {
          id: 'assigned',
          label: 'Assigned',
          value: applied,
          note: 'written to Linear',
          tone: 'default',
        },
        {
          id: 'failed',
          label: 'Failed',
          value: failed,
          note: failed > 0 ? 'Linear refused the write' : undefined,
          tone: failed > 0 ? 'accent' : 'muted',
        },
        {
          id: 'stale',
          label: 'Not written',
          value: stale,
          note: stale > 0 ? 'changed in Linear first' : undefined,
          tone: 'muted',
        },
        blockedStat,
      ]
    : [
        {
          id: 'would',
          label: 'Would assign',
          value: planned,
          note: 'nothing written',
          tone: 'default',
        },
        {
          id: 'skipped',
          label: 'Skipped',
          value: skipped,
          note: skipped > 0 ? 'already assigned or in Triage' : undefined,
          tone: 'muted',
        },
        blockedStat,
      ];

  const note = live
    ? {
        label: 'Undo by hand',
        body: 'Each applied assignment set the assignee (and moved Backlog → Todo where it applies) and left a Linear comment saying why. There is no undo button: to reverse one, unassign the issue in Linear, move it back to Backlog if this run moved it, and delete that comment.',
      }
    : {
        label: 'Dry run',
        body: 'Nothing was written to Linear. This is what a live run would have assigned at that moment; a live run re-checks every issue in Linear before writing.',
      };

  const status =
    run.status === 'running'
      ? 'still running'
      : `${RUN_STATUS_LABEL[run.status].toLowerCase()}${duration === null ? '' : ` in ${duration}`}`;
  const heading = `${MODE_LABEL[run.mode]} · ${started}`;
  return {
    id: run.id,
    heading,
    receipts: `${run.trigger === 'schedule' ? 'Scheduled run' : `Started by ${who}`}, ${status}. ${plural(groups.length, 'project')} in the log${skipped > 0 ? `, ${plural(skipped, 'issue')} skipped` : ''}.`,
    mode: run.mode,
    modeLabel: MODE_LABEL[run.mode],
    modeTone: MODE_TONE[run.mode],
    statusLabel: RUN_STATUS_LABEL[run.status],
    statusTone: RUN_STATUS_TONE[run.status],
    properties,
    stats,
    error: run.error,
    note,
    groups,
    crumb: heading,
  };
}

/** A route param (already decoded by Next) that can be a run id, else
    null (→ 404). */
export function parseRunId(raw: string): string | null {
  const id = raw.trim();
  return id === '' || id.length > 200 ? null : id;
}
