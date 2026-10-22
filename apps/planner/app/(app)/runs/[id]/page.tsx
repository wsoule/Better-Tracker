import {
  BlockBar,
  Chip,
  EmptyState,
  Link,
  Notice,
  PropertyList,
  Register,
  RegisterCell,
  RegisterRow,
  StatsStrip,
} from '@better-tracker/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  alreadyAssignedLine,
  buildRunDetail,
  parseRunId,
  type RunIssueRow,
  type RunProjectGroup,
} from '../../../../lib/adapters/runs';
import { orSetup, requireInstalledActor } from '../../../../lib/load';
import { PageCrumb } from '../../components/page-crumb';
import css from '../page.module.css';

export const metadata: Metadata = { title: 'Run' };

const COLUMNS =
  'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 128px minmax(0, 1.6fr)';

const HEADER = [
  { id: 'issue', label: 'Issue' },
  { id: 'to', label: 'Assign to' },
  { id: 'state', label: 'State' },
  { id: 'outcome', label: 'Outcome' },
  { id: 'note', label: 'Note' },
];

/* /runs/[id] (architecture §8.4 "Runs", §6.12 "logged, not undone"): one
   allocation run — mode, trigger, who, duration, status — then what it did
   per project: assigned or would assign (key, title, to whom, the state
   move), stale and failed writes with their reason, skips (already
   assigned issues collapsed into a count) and blocked projects with the
   missing inputs. Unknown ids are a 404. Read-only for everyone. */
export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const { engine, actor, workspaceId } = await requireInstalledActor(
    `/runs/${encodeURIComponent(raw)}`
  );
  const id = parseRunId(raw);
  if (id === null) notFound();
  const [found, loaded] = await orSetup(
    Promise.all([
      engine.getRun(workspaceId, id, actor),
      engine.load(workspaceId, actor),
    ])
  );
  if (found === null) notFound();
  const model = buildRunDetail({
    run: found.run,
    entries: found.entries,
    snapshot: loaded.snapshot,
    timeZone: loaded.settings.timezone,
  });

  return (
    <>
      <header className={css.head}>
        <div className={css.titleRow}>
          <h1 className={css.title}>{model.heading}</h1>
          <span className={css.chips}>
            <Chip tone={model.modeTone} dot>
              {model.modeLabel}
            </Chip>
            <Chip tone={model.statusTone}>{model.statusLabel}</Chip>
          </span>
        </div>
        <p className={css.receipts}>{model.receipts}</p>
      </header>
      <div className={css.body}>
        <StatsStrip
          label="What this run did"
          cells={model.stats.map((stat) => ({
            id: stat.id,
            label: stat.label,
            value: stat.value,
            note: stat.note,
            tone: stat.tone,
          }))}
        />
        {model.error !== null ? (
          <Notice label="Error" tone="danger" role="alert">
            {model.error}
          </Notice>
        ) : null}
        <Notice label={model.note.label} tone="default">
          {model.note.body}
        </Notice>
        <section className={css.section} aria-label="Run details">
          <BlockBar title="Run" />
          <div className={css.facts}>
            <PropertyList
              label="Run details"
              items={model.properties.map((p) => ({
                label: p.label,
                value: p.value,
              }))}
            />
          </div>
        </section>
        {model.groups.length === 0 ? (
          <EmptyState label="Nothing logged">
            This run logged nothing: no active project had an open milestone to
            plan.
          </EmptyState>
        ) : (
          model.groups.map((group) => (
            <ProjectBlock key={group.id} group={group} />
          ))
        )}
      </div>
      <PageCrumb label={model.crumb} />
    </>
  );
}

/* One project's part of the run: its heading and counts, the amber
   "Blocked" callout when allocation stopped there, the issues as a
   register panel, and the already-assigned skips as one quiet line. */
function ProjectBlock({ group }: { group: RunProjectGroup }) {
  return (
    <section className={css.section} aria-label={group.name}>
      <BlockBar title={group.name} meta={group.meta} />
      {group.block !== null ? (
        <Notice
          label="Blocked"
          tone="warning"
          action={
            <Link href={group.href} className="accentLink">
              Timeline lane
            </Link>
          }
        >
          {group.block.sentence} Nothing in this project was allocated.
          {group.block.gapLines.length > 0 ? (
            <ul className={css.blockGaps}>
              {group.block.gapLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {group.rows.length > 0 ? (
        <Register
          label={`${group.name}: issues in this run`}
          columns={COLUMNS}
          header={HEADER}
          stackWithin={700}
        >
          {group.rows.map((row) => (
            <IssueRow key={row.key} row={row} />
          ))}
        </Register>
      ) : null}
      {group.alreadyAssigned > 0 ? (
        <p className={css.skipLine}>
          {alreadyAssignedLine(group.alreadyAssigned)}
        </p>
      ) : null}
    </section>
  );
}

function IssueRow({ row }: { row: RunIssueRow }) {
  const cells = (
    <>
      <RegisterCell label="Issue" variant="name">
        <span className={css.issue}>
          <span className={css.issueKey}>{row.identifier}</span>
          <span className={css.issueTitle}>{row.title}</span>
        </span>
      </RegisterCell>
      <RegisterCell
        label="Assign to"
        tone={row.assignee === null ? 'muted' : 'default'}
      >
        {row.assignee ?? '—'}
      </RegisterCell>
      <RegisterCell
        label="State"
        tone={row.stateMove === null ? 'muted' : 'default'}
      >
        {row.stateMove ?? '—'}
      </RegisterCell>
      <RegisterCell label="Outcome">
        <Chip tone={row.outcomeTone}>{row.outcomeLabel}</Chip>
      </RegisterCell>
      <RegisterCell label="Note" tone={row.reasonTone}>
        {row.reason ?? '—'}
      </RegisterCell>
    </>
  );
  const tone = row.outcome === 'failed' ? 'danger' : 'default';
  if (row.href === null) return <RegisterRow tone={tone}>{cells}</RegisterRow>;
  return (
    <RegisterRow
      href={row.href}
      external
      rowLabel={`${row.identifier} ${row.title} in Linear`}
      tone={tone}
    >
      {cells}
    </RegisterRow>
  );
}
