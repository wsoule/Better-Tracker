import {
  BlockBar,
  Chip,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
} from '@better-tracker/ui';
import { History } from 'lucide-react';
import type { Metadata } from 'next';

import { buildRunsPage, type RunRowModel } from '../../../lib/adapters/runs';
import { orSetup, requireInstalledActor } from '../../../lib/load';
import ReadOnlyNotice from '../components/read-only-notice';
import WorkspaceGuard from '../components/workspace-guard';
import css from './page.module.css';
import RunActions from './run-actions';

export const metadata: Metadata = { title: 'Runs' };

/** The empty state's 22px glyph (EmptyState's icon). */
const EMPTY_ICON = { size: 22, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** How many runs the register lists (newest first). */
const RUN_LIMIT = 50;

// Seven fixed columns leave the start and finish times about 170px each
// on a 1440px window; narrower registers (stackWithin) become cards whose
// eight cells flow into as many ~120px columns as fit: two rows at 1024
// and 1280 with the sidebar open, three on a phone.
const COLUMNS =
  'minmax(0, 1.3fr) 80px 104px 64px 96px 56px 64px 64px minmax(0, 1.2fr)';

const HEADER = [
  { id: 'run', label: 'Started' },
  { id: 'mode', label: 'Mode' },
  { id: 'status', label: 'Status' },
  { id: 'assigned', label: 'Assigned', align: 'end' as const },
  { id: 'would', label: 'Would assign', align: 'end' as const },
  { id: 'failed', label: 'Failed', align: 'end' as const },
  { id: 'blocked', label: 'Blocked', align: 'end' as const },
  { id: 'skipped', label: 'Skipped', align: 'end' as const },
  { id: 'finished', label: 'Finished' },
];

/* /runs (architecture §8.4 "Runs", §7 runAllocation): the allocation run
   log, newest first, with "Preview (dry run)" and, only while Settings
   says allocation is live, "Run now" for everyone signed in (owner
   decision 2026-10-22: no roles); the route enforces the live gate too.
   A Linear guest gets the read-only notice instead of the buttons (owner
   decision 2026-10-22, "Guests limited to read only"); the route and the
   engine refuse their runs. Each row opens the run's detail. */
export default async function RunsPage() {
  const { engine, actor, workspaceId } = await requireInstalledActor('/runs');
  const [runs, loaded] = await orSetup(
    Promise.all([
      engine.listRuns(workspaceId, RUN_LIMIT),
      engine.load(workspaceId, actor),
    ])
  );
  const page = buildRunsPage({
    runs,
    snapshot: loaded.snapshot,
    timeZone: loaded.settings.timezone,
    allocationMode: loaded.settings.allocationMode,
  });

  return (
    <>
      <WorkspaceGuard />
      {/* The run controls sit top right in the header (Gr8r's header
          actions), their note under the receipts. */}
      <header className={`${css.head} ${css.headActions}`}>
        <h1 className={css.title}>Runs</h1>
        <p className={css.receipts}>{page.receipts}</p>
        {actor.readOnly ? null : <RunActions liveRunsOn={page.liveRunsOn} />}
        {engine.config.auth === 'api_key' && !actor.readOnly ? (
          <p className={css.keyNote}>
            Runs plan over what you can see. Live runs write with your Linear
            key: assignments and their comments appear in Linear as you.
          </p>
        ) : null}
      </header>
      <div className={css.body}>
        {actor.readOnly ? <ReadOnlyNotice /> : null}
        <section className={css.section} aria-label="Allocation runs">
          <BlockBar
            title="Allocation runs"
            meta={`Times in ${loaded.settings.timezone}`}
          />
          {page.rows.length === 0 ? (
            <EmptyState label="No runs" icon={<History {...EMPTY_ICON} />}>
              {engine.config.auth === 'api_key'
                ? 'No allocation runs yet. Runs appear here when someone starts one with Preview (dry run); nothing runs on a schedule.'
                : 'No allocation runs yet. Runs appear here after the scheduled daily run, or when someone starts one with Preview (dry run).'}
            </EmptyState>
          ) : (
            <Register
              label="Allocation runs, newest first"
              columns={COLUMNS}
              header={HEADER}
              stackWithin={1000}
              stackedColumns="repeat(auto-fill, minmax(min(120px, 30%), 1fr))"
            >
              {page.rows.map((row) => (
                <RunRow key={row.id} row={row} />
              ))}
            </Register>
          )}
        </section>
      </div>
    </>
  );
}

/** One count cell; `tone` colours a non-zero count (danger for failed
    writes, warning for blocked projects, architecture §8.2). */
function Count({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number | null;
  tone?: 'default' | 'warning' | 'danger';
}) {
  return (
    <RegisterCell
      label={label}
      align="end"
      tone={value === null ? 'muted' : value > 0 ? tone : 'default'}
    >
      <span className={css.count}>{value ?? '—'}</span>
    </RegisterCell>
  );
}

function RunRow({ row }: { row: RunRowModel }) {
  const counts = row.counts;
  return (
    <RegisterRow href={row.href} rowLabel={row.rowLabel} tone={row.rowTone}>
      <RegisterCell label="Started" variant="name" sub={row.byline}>
        {row.title}
      </RegisterCell>
      <RegisterCell label="Mode">
        <Chip tone={row.modeTone} filled={row.modeFilled}>
          {row.modeLabel}
        </Chip>
      </RegisterCell>
      <RegisterCell label="Status">
        <Chip tone={row.statusTone} filled={row.statusFilled}>
          {row.statusLabel}
        </Chip>
      </RegisterCell>
      <Count label="Assigned" value={counts?.assigned ?? null} />
      <Count label="Would assign" value={counts?.wouldAssign ?? null} />
      <Count label="Failed" value={counts?.failed ?? null} tone="danger" />
      <Count label="Blocked" value={counts?.blocked ?? null} tone="warning" />
      <Count label="Skipped" value={counts?.skipped ?? null} />
      <RegisterCell label="Finished" sub={row.took ?? undefined}>
        {row.finished}
      </RegisterCell>
    </RegisterRow>
  );
}
