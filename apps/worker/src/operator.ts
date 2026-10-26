// The operator's workspace commands (architecture §9 "Operator commands"):
// one deployment serves several Linear workspaces (owner decision
// 2026-10-25), and whoever runs it lists them (`workspaces`), removes one
// (`remove`), deletes a revoked one's data now (`purge`), and refuses one
// from now on (`block` / `unblock`). There is no operator role in the
// planner; these run only from the worker's CLI, in a shell on the
// deployment. The engine resolves the names (an org id or URL key) and
// does the work; this module prints what happened.
//
// Output never holds a token or an email address: the engine's methods
// return none, and the free text that could (a sync error, a block reason)
// has credential-shaped runs and addresses replaced.

import { redactLinearSecrets } from '@better-tracker/core';
import {
  type AdmissionVerdict,
  type BlockedWorkspace,
  EngineInputError,
  OPERATOR_PURGE_MIN_MINUTES,
  PURGE_AFTER_DAYS,
  type RevokedReason,
  type WorkspaceOverview,
  type WorkspacePurge,
  type WorkspaceRemoval,
  type WorkspaceTable,
} from '@better-tracker/engine';

import type { OperatorCommand } from './cli';
import { type CommandContext, EXIT_FAILED, EXIT_OK, plural } from './commands';
import { formatDuration, isChronic } from './scaling';

const DAY_MS = 86_400_000;
const NAME_MAX = 32;
/** Anything shaped like an email address. */
const EMAIL = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]+/g;

/** What an operator command prints on stdout, and its exit code. */
export interface OperatorResult {
  code: 0 | 1;
  /** Lines for stdout: details first, the summary line last (JSON alone). */
  lines: string[];
}

/** One workspace's status word in `workspaces`. */
export type WorkspaceStatusLabel =
  | 'active'
  | `revoked:${RevokedReason}`
  | 'blocked'
  | 'not admitted'
  | 'not installed';

/** One workspace as `workspaces --json` prints it. */
export interface WorkspaceRow {
  id: string;
  urlKey: string | null;
  name: string | null;
  status: WorkspaceStatusLabel;
  admission: AdmissionVerdict;
  /** When the app was first installed; null when it never was. */
  installedAt: string | null;
  revokedAt: string | null;
  revokedReason: RevokedReason | null;
  /** When cleanup purges it (uninstalled or removed only), ISO. */
  purgeOn: string | null;
  /** The last full sync attempt; null when none was recorded. */
  lastSync: {
    at: string | null;
    status: 'ok' | 'failed' | null;
    durationMs: number | null;
    consecutiveFailures: number;
    lastSuccessAt: string | null;
    /** Redacted: no credentials, no email addresses. */
    error: string | null;
  } | null;
  /** Failing with no successful full sync for 24 hours (a tick warns). */
  chronic: boolean;
  /** Issues in the mirror at the last full sync that counted them. */
  issues: number | null;
  /** Unexpired sessions. */
  sessions: number;
}

/** A block as `workspaces --json` prints it. */
export interface BlockRow {
  key: string;
  kind: BlockedWorkspace['kind'];
  /** An id block's URL key (made under or pinned from); `unblock` takes it. */
  urlKey: string | null;
  reason: string | null;
  createdAt: string;
}

/** Free text with credential-shaped runs and email addresses replaced. */
export function redactText(text: string): string {
  return redactLinearSecrets(text).replace(EMAIL, '[email]');
}

/**
 * The status word: a block wins (it outlives a removal), then the revoke
 * and its reason, then a refusal by LINEAR_WORKSPACES, then whether
 * anyone installed it.
 */
export function statusLabel(status: WorkspaceOverview): WorkspaceStatusLabel {
  if (status.admission === 'blocked') return 'blocked';
  const installation = status.installation;
  if (installation?.revokedAt != null) {
    return `revoked:${installation.revokedReason ?? 'grant_dead'}`;
  }
  if (status.admission === 'not_allowed') return 'not admitted';
  return installation === null ? 'not installed' : 'active';
}

// When cleanup purges an uninstalled or removed workspace (earliest).
function purgeOn(status: WorkspaceOverview): string | null {
  const installation = status.installation;
  const reason = installation?.revokedReason ?? null;
  if (installation?.revokedAt == null) return null;
  if (reason !== 'uninstalled' && reason !== 'removed') return null;
  const at = Date.parse(installation.revokedAt);
  return Number.isNaN(at)
    ? null
    : new Date(at + PURGE_AFTER_DAYS * DAY_MS).toISOString();
}

/** One workspace's row for `workspaces`, at `now`. */
export function workspaceRow(
  status: WorkspaceOverview,
  now: Date
): WorkspaceRow {
  const label = statusLabel(status);
  const sync = status.sync;
  return {
    id: status.workspaceId,
    urlKey: status.urlKey,
    name: status.workspaceName,
    status: label,
    admission: status.admission,
    installedAt: status.installation?.createdAt ?? null,
    revokedAt: status.installation?.revokedAt ?? null,
    revokedReason:
      status.installation?.revokedAt == null
        ? null
        : (status.installation.revokedReason ?? 'grant_dead'),
    purgeOn: purgeOn(status),
    lastSync:
      sync === null
        ? null
        : {
            at: sync.lastFullSyncAt,
            status: sync.lastFullSyncStatus,
            durationMs: sync.lastFullSyncMs,
            consecutiveFailures: sync.consecutiveFailures,
            lastSuccessAt: sync.lastSuccessAt,
            error:
              sync.lastFullSyncError === null
                ? null
                : redactText(sync.lastFullSyncError),
          },
    chronic:
      label === 'active' &&
      sync?.lastFullSyncStatus !== 'ok' &&
      isChronic(status, now),
    issues: sync?.mirrorIssueCount ?? null,
    sessions: status.sessionCount,
  };
}

// `2026-10-25 08:00Z`; '' for null.
function minute(iso: string | null): string {
  if (iso === null) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

// `2026-11-24`; '' for null.
function day(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10);
}

// A sync duration: `812 ms`, `12.3 s`, `2.5 min`.
function syncTime(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms);
}

// The "Last sync" cell: when, how, how long, failures in a row.
function lastSyncCell(row: WorkspaceRow): string {
  const sync = row.lastSync;
  if (sync === null || sync.at === null) return 'never';
  const parts = [`${minute(sync.at)} ${sync.status ?? '?'}`];
  if (sync.status === 'ok' && sync.durationMs !== null) {
    parts[0] += ` ${syncTime(sync.durationMs)}`;
  }
  if (sync.consecutiveFailures > 0) {
    parts.push(`${sync.consecutiveFailures} failed in a row`);
  }
  if (row.chronic) parts.push('chronic');
  return parts.join(', ');
}

// Cuts a name to NAME_MAX characters for the table.
function shortName(name: string | null): string {
  if (name === null) return '';
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
}

// Left-aligned columns separated by two spaces, header first.
function table(header: readonly string[], rows: readonly string[][]): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length))
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

/** The human `workspaces` listing: a table, then the blocks. */
export function workspacesTable(
  rows: readonly WorkspaceRow[],
  blocks: readonly BlockRow[]
): string[] {
  const lines: string[] =
    rows.length === 0
      ? ['No workspaces yet: nobody has signed in or installed the app.']
      : table(
          [
            'Workspace id',
            'URL key',
            'Name',
            'Status',
            'Installed',
            'Purge on',
            'Last sync',
            'Issues',
            'Sessions',
          ],
          rows.map((row) => [
            row.id,
            row.urlKey ?? '',
            shortName(row.name),
            row.status,
            day(row.installedAt),
            day(row.purgeOn),
            lastSyncCell(row),
            row.issues === null ? '' : String(row.issues),
            String(row.sessions),
          ])
        );
  if (blocks.length > 0) {
    lines.push('', 'Blocks:');
    lines.push(
      ...table(
        ['Key', 'By', 'Since', 'Reason'],
        blocks.map((block) => [
          block.key,
          block.kind === 'url_key'
            ? 'URL key (not seen yet)'
            : block.urlKey === null
              ? 'organization id'
              : `organization id (URL key ${block.urlKey})`,
          day(block.createdAt),
          block.reason ?? '',
        ])
      ).map((line) => `  ${line}`)
    );
  }
  return lines;
}

// `4 workspaces (2 active, 1 revoked:removed, 1 not admitted); 1 block`.
function workspacesSummary(
  rows: readonly WorkspaceRow[],
  blocks: readonly BlockRow[]
): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const byStatus = [...counts]
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  const chronic = rows.filter((row) => row.chronic).length;
  const parts = [
    rows.length === 0
      ? 'no workspaces'
      : `${plural(rows.length, 'workspace')} (${byStatus})`,
  ];
  if (chronic > 0) parts.push(`${chronic} chronic`);
  if (blocks.length > 0) parts.push(plural(blocks.length, 'block'));
  return `workspaces ok — ${parts.join('; ')}`;
}

// What `remove` (or `block` of an installed workspace) did, as phrases.
function removalPhrases(removal: WorkspaceRemoval, now: Date): string[] {
  const parts: string[] = [];
  parts.push(
    removal.revoked
      ? `installation revoked as removed; its data is purged on ${day(new Date(now.getTime() + PURGE_AFTER_DAYS * DAY_MS).toISOString())} unless an admin installs the app again`
      : 'no active installation to revoke (never installed, or already uninstalled or removed)'
  );
  if (removal.appTokenRevoked === true) {
    parts.push("the app's token revoked with Linear");
  } else if (removal.appTokenRevoked === false) {
    parts.push(
      "Linear did not confirm revoking the app's token (see the warn log; it is wiped here all the same)"
    );
  }
  const grants =
    removal.endedSessions === 0
      ? ''
      : ` (${plural(removal.revokedTokens, 'Linear grant')} revoked${removal.revokeFailures > 0 ? `, ${removal.revokeFailures} could not be` : ''})`;
  parts.push(`${plural(removal.endedSessions, 'session')} ended${grants}`);
  return parts;
}

// Why purge did nothing, for its FAILED line.
function purgeRefusal(
  reason: Extract<WorkspacePurge, { purged: false }>['reason'],
  workspaceId: string
): string {
  switch (reason) {
    case 'not_revoked':
      return `it is still installed; run remove --workspace ${workspaceId} first`;
    case 'too_recent':
      return `it was revoked less than ${OPERATOR_PURGE_MIN_MINUTES} minutes ago and a sync may still be finishing; try again later`;
    case 'not_installed':
      return 'it was never installed (people only signed in); there is nothing to purge but their sessions, which remove ends';
  }
}

// The per-table row counts a purge deleted, aligned, tables with rows first.
function purgeCounts(counts: Record<WorkspaceTable, number>): string[] {
  const entries = Object.entries(counts) as Array<[WorkspaceTable, number]>;
  return table(
    ['Table', 'Rows deleted'],
    entries.map(([name, count]) => [name, String(count)])
  ).map((line) => `  ${line}`);
}

// Runs the command; EngineInputError (an unknown or ambiguous name, a
// malformed reason, api_key mode) becomes a FAILED line, anything else
// (the database) propagates to run.ts, which reports it.
async function runOperator(
  ctx: CommandContext,
  command: OperatorCommand
): Promise<OperatorResult> {
  const { engine } = ctx;
  const now = ctx.now();
  switch (command.name) {
    case 'workspaces': {
      const [statuses, blocked] = await Promise.all([
        engine.listWorkspaceStatus(),
        engine.listBlockedWorkspaces(),
      ]);
      const rows = statuses.map((status) => workspaceRow(status, now));
      const blocks: BlockRow[] = blocked.map((block) => ({
        key: block.key,
        kind: block.kind,
        urlKey: block.urlKey ?? null,
        reason: block.reason === null ? null : redactText(block.reason),
        createdAt: block.createdAt,
      }));
      if (command.json) {
        return {
          code: EXIT_OK,
          lines: [JSON.stringify({ workspaces: rows, blocks }, null, 2)],
        };
      }
      return {
        code: EXIT_OK,
        lines: [
          ...workspacesTable(rows, blocks),
          '',
          workspacesSummary(rows, blocks),
        ],
      };
    }
    case 'remove': {
      const removal = await engine.removeWorkspace(command.workspace);
      return {
        code: EXIT_OK,
        lines: [
          `remove ok — ${removal.workspaceId}: ${removalPhrases(removal, now).join('; ')}`,
        ],
      };
    }
    case 'purge': {
      const purge = await engine.purgeWorkspaceNow(command.workspace, {
        now: now.toISOString(),
      });
      if (!purge.purged) {
        return {
          code: EXIT_FAILED,
          lines: [
            `purge FAILED — ${purge.workspaceId}: not purged: ${purgeRefusal(purge.reason, purge.workspaceId)}`,
          ],
        };
      }
      const total = Object.values(purge.counts).reduce((a, b) => a + b, 0);
      return {
        code: EXIT_OK,
        lines: [
          ...purgeCounts(purge.counts),
          `purge ok — ${purge.workspaceId}: ${plural(total, 'row')} deleted; ${plural(purge.endedSessions, 'session')} ended`,
        ],
      };
    }
    case 'block': {
      const block = await engine.blockWorkspace(
        command.workspace,
        command.reason
      );
      const by = block.kind === 'id' ? 'organization id' : 'URL key';
      const parts = [`blocked by ${by}`];
      if (block.workspaceId === null) {
        parts.push(
          block.kind === 'id'
            ? 'no workspace here has that organization id yet; it cannot sign in or install'
            : 'no workspace here has that URL key yet; the block names its organization the first time it signs in or installs'
        );
      }
      if (block.removal !== null) {
        parts.push(...removalPhrases(block.removal, now));
      }
      return {
        code: EXIT_OK,
        lines: [
          `block ok — ${block.workspaceId ?? block.key}: ${parts.join('; ')}`,
        ],
      };
    }
    case 'unblock': {
      const removed = await engine.unblockWorkspace(command.workspace);
      return {
        code: EXIT_OK,
        lines: [
          removed
            ? `unblock ok — ${command.workspace}: block removed; the workspace stays removed until an admin installs the app again`
            : `unblock ok — ${command.workspace}: no block names it (neither that name, the organization it resolves to, nor a block made under that URL key); nothing changed. The workspaces command lists every block`,
        ],
      };
    }
  }
}

/**
 * Runs one operator command. Never prints a token or an email address.
 * EngineInputError (unknown name, a URL key two workspaces share, api_key
 * mode) is reported as `<command> FAILED — <why>` with exit 1; any other
 * error (the database) is thrown for run.ts to report.
 */
export async function runOperatorCommand(
  ctx: CommandContext,
  command: OperatorCommand
): Promise<OperatorResult> {
  try {
    const result = await runOperator(ctx, command);
    ctx.logger.info('operator command finished', {
      exitCode: result.code,
    });
    return result;
  } catch (error) {
    if (!(error instanceof EngineInputError)) throw error;
    ctx.logger.warn('operator command refused', {
      code: error.code,
      error: error.message,
    });
    return {
      code: EXIT_FAILED,
      lines: [`${command.name} FAILED — ${redactText(error.message)}`],
    };
  }
}
