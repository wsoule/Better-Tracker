'use client';

import {
  BlockBar,
  Button,
  Checklist,
  Chip,
  DeadlineList,
  EmptyState,
  Link,
  Notice,
  PriorityGlyph,
  ProgressRule,
  Register,
  RegisterCell,
  RegisterRow,
  SegmentedControl,
  StateGlyph,
  StatsStrip,
  StatusMark,
  Switch,
  TaskGroupTable,
  type TaskPriority,
  type TaskStateKind,
  UiLinkProvider,
  type UiLinkProps,
} from '@better-tracker/ui';
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';

import {
  DEADLINES,
  HOME_TABS,
  PROJECT_FILTERS,
  PROJECTS,
  RUBRIC,
  RUNS,
  WEEK_SECTIONS,
  WEEK_STATS,
  ZOOM_OPTIONS,
} from './fixtures';
import { IssueListGallery } from './issue-list-gallery';
import css from './page.module.css';

// The gallery's router: a plain anchor that records the href instead of
// navigating (the app routes need the engine). It proves every component
// renders links through UiLinkProvider; modified clicks still behave
// natively, and external URLs never reach it (Link renders those itself).
const RecordContext = createContext<(href: string) => void>(() => {});

function GalleryLink({ href, children, onClick, ...rest }: UiLinkProps) {
  const record = useContext(RecordContext);
  return (
    <a
      href={href}
      {...rest}
      data-gallery-link=""
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        record(href);
      }}
    >
      {children}
    </a>
  );
}

/* Inline 14px icons (the gallery imports only from the UI package). */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const PlayIcon = () => (
  <Glyph>
    <path d="M4 2.5v9l7-4.5-7-4.5Z" />
  </Glyph>
);
const EyeIcon = () => (
  <Glyph>
    <path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" />
    <circle cx="7" cy="7" r="1.8" />
  </Glyph>
);
const ArrowIcon = () => (
  <Glyph>
    <path d="M4 10 10 4M5 4h5v5" />
  </Glyph>
);
const LinkIcon = () => (
  <Glyph>
    <path d="M6 8a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 8 2.5l-.7.7M8 6a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 6 11.5l.7-.7" />
  </Glyph>
);

const STATE_KINDS: { kind: TaskStateKind; label: string }[] = [
  { kind: 'triage', label: 'Triage' },
  { kind: 'backlog', label: 'Backlog' },
  { kind: 'unstarted', label: 'Todo' },
  { kind: 'started', label: 'In Progress' },
  { kind: 'completed', label: 'Done' },
  { kind: 'canceled', label: 'Canceled' },
];

const PRIORITIES: { priority: TaskPriority; label: string }[] = [
  { priority: 1, label: 'Urgent' },
  { priority: 2, label: 'High' },
  { priority: 3, label: 'Medium' },
  { priority: 4, label: 'Low' },
  { priority: 0, label: 'No priority' },
];

export default function TasksGallery({
  themeToggle,
}: {
  themeToggle: ReactNode;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [zoom, setZoom] = useState('weeks');
  const [live, setLive] = useState(true);
  const [digest, setDigest] = useState(true);
  const [repeat, setRepeat] = useState('3');
  const [activeRow, setActiveRow] = useState<string | undefined>(undefined);

  const projects = useMemo(
    () =>
      PROJECTS.filter((p) => {
        if (filter === 'blocked') return p.allocation.startsWith('Blocked');
        if (filter === 'allocating')
          return p.allocation.startsWith('Allocating');
        if (filter === 'inactive') return !p.active;
        return true;
      }),
    [filter]
  );

  return (
    <RecordContext.Provider value={setOpened}>
      <UiLinkProvider link={GalleryLink}>
        <main className="page">
          <div className="block">
            <BlockBar
              index="00"
              title="UI gallery · tasks"
              meta={
                <span className={css.barMeta}>
                  <a className="accentLink" href="/ui-gallery">
                    All families
                  </a>
                  {themeToggle}
                </span>
              }
            />
            <div className={css.collapse}>
              <Notice
                tone="default"
                label="Router"
                role="status"
                action={
                  opened !== null ? (
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => {
                        setOpened(null);
                        setActiveRow(undefined);
                      }}
                    >
                      Clear
                    </Button>
                  ) : undefined
                }
              >
                {opened === null ? (
                  'Every link below renders through UiLinkProvider. Click one: the gallery records where it would go instead of navigating.'
                ) : (
                  <>
                    Would open <span className={css.mono}>{opened}</span>
                  </>
                )}
              </Notice>
            </div>
          </div>

          {/* ---- My week ------------------------------------------------ */}
          <section className="block" aria-labelledby="week-title">
            <BlockBar
              index="01"
              title="My week"
              meta="Wed 21 Oct 2026 · synced 08:02"
            />
            <div className={css.collapse}>
              <header className={css.hero}>
                <h1 id="week-title" className={css.greeting}>
                  Good morning, Pat
                </h1>
                <p className={css.receipts}>
                  Wednesday, October 21 · 7 issues due this week · 1 milestone
                  overdue
                </p>
              </header>
              <StatsStrip cells={WEEK_STATS} label="This week at a glance" />
            </div>
            <div className={css.columns}>
              <div className={css.main}>
                <TaskGroupTable
                  sections={WEEK_SECTIONS}
                  label="My issues"
                  storageKey="gallery:tasks:week-collapsed"
                  activeRowId={activeRow}
                  onOpenRow={(row) => {
                    // The planner opens the issue; here a plain click marks
                    // the row open (activeRowId) and records the href.
                    setActiveRow(row.id);
                    setOpened(row.href ?? row.key);
                  }}
                />
              </div>
              <aside className={css.side} aria-label="Deadlines and attention">
                <div className={css.collapse}>
                  <BlockBar
                    index="02"
                    title="Upcoming deadlines"
                    meta="7 days"
                  />
                  <DeadlineList groups={DEADLINES} />
                </div>
                <div className={css.collapse}>
                  <BlockBar
                    index="03"
                    title="Needs attention"
                    meta="Projects you lead"
                  />
                  <Register
                    columns="minmax(0, 1fr) auto"
                    label="Projects that need attention"
                    stackBelow={700}
                  >
                    <RegisterRow
                      href="/timeline?project=p-delta"
                      rowLabel="Delta: blocked, no lead"
                      tone="warning"
                    >
                      <RegisterCell variant="name" sub="Next: Search relevance">
                        Delta
                      </RegisterCell>
                      <RegisterCell variant="mono" tone="warning" align="end">
                        Blocked: no lead
                      </RegisterCell>
                    </RegisterRow>
                    <RegisterRow
                      href="/timeline?project=p-atlas"
                      rowLabel="Atlas migration: 2 unassigned"
                      tone="warning"
                    >
                      <RegisterCell
                        variant="name"
                        sub="Next: Cutover rehearsal"
                      >
                        Atlas migration
                      </RegisterCell>
                      <RegisterCell variant="mono" tone="warning" align="end">
                        2 unassigned
                      </RegisterCell>
                    </RegisterRow>
                  </Register>
                </div>
              </aside>
            </div>
          </section>

          {/* ---- Issue list --------------------------------------------- */}
          <section className="block" aria-labelledby="issues-title">
            <BlockBar
              index="04"
              title="Issue list"
              meta="Selection, drag, cell pickers, menus, chips, bulk bar"
            />
            <div className={css.collapse}>
              <header className={css.hero}>
                <h2 id="issues-title" className={css.greeting}>
                  Issues
                </h2>
                <p className={css.receipts}>
                  Every issue across 3 projects. Select rows (shift-click, x,
                  Shift+↓, ⌘A), drag one onto another group, or pick from a
                  cell; the rows are hatched while the pretend change is sent.
                </p>
              </header>
            </div>
            <IssueListGallery record={setOpened} />
          </section>

          {/* ---- Projects ----------------------------------------------- */}
          <section className="block" aria-label="Projects">
            <BlockBar
              index="05"
              title="Projects"
              meta="5 active · 1 inactive"
            />
            <div className={css.collapse}>
              <div className={css.toolbar}>
                <input
                  className={`input ${css.search}`}
                  type="search"
                  placeholder="Search projects"
                  aria-label="Search projects"
                />
                <SegmentedControl
                  label="Allocation state"
                  options={PROJECT_FILTERS}
                  value={filter}
                  onChange={setFilter}
                  size="sm"
                />
                <span className={css.toolbarEnd}>
                  <Button
                    variant="quiet"
                    size="sm"
                    href="/runs"
                    iconAfter={<ArrowIcon />}
                  >
                    Run log
                  </Button>
                </span>
              </div>
              <Register
                label="Projects"
                columns="minmax(0, 1.1fr) 116px minmax(0, 1.5fr) 150px 120px minmax(0, 1fr) 64px"
                header={[
                  { id: 'name', label: 'Project' },
                  { id: 'status', label: 'Linear' },
                  { id: 'next', label: 'Next milestone' },
                  { id: 'progress', label: 'Progress' },
                  { id: 'lead', label: 'Lead' },
                  { id: 'allocation', label: 'Allocation' },
                  { id: 'links', label: 'Graph', align: 'end' },
                ]}
              >
                {projects.map((p) => (
                  <RegisterRow
                    key={p.id}
                    href={`/timeline?project=${p.id}`}
                    rowLabel={`${p.name} on the timeline`}
                    tone={
                      p.allocationTone === 'warning'
                        ? 'warning'
                        : p.active
                          ? 'default'
                          : 'muted'
                    }
                  >
                    <RegisterCell
                      label="Project"
                      variant="name"
                      sub={p.initiative}
                    >
                      {p.name}
                    </RegisterCell>
                    <RegisterCell label="Linear">
                      <Chip tone={p.active ? 'default' : 'muted'}>
                        {p.linearStatus}
                      </Chip>
                    </RegisterCell>
                    <RegisterCell label="Next milestone" sub={p.milestoneDue}>
                      <span className={css.milestone}>
                        <StatusMark status={p.status} label={p.statusLabel} />
                        {p.milestone}
                      </span>
                    </RegisterCell>
                    <RegisterCell label="Progress">
                      <ProgressRule
                        done={p.done}
                        total={p.total}
                        tone={
                          !p.active
                            ? 'muted'
                            : p.status === 'overdue'
                              ? 'danger'
                              : p.status === 'done'
                                ? 'success'
                                : 'default'
                        }
                        aria-label={`${p.milestone} progress`}
                      />
                    </RegisterCell>
                    <RegisterCell
                      label="Lead"
                      variant={p.lead === null ? 'mono' : 'value'}
                      tone={
                        p.lead !== null
                          ? 'default'
                          : p.active
                            ? 'warning'
                            : 'muted'
                      }
                    >
                      {p.lead ?? 'No lead'}
                    </RegisterCell>
                    <RegisterCell
                      label="Allocation"
                      variant="mono"
                      tone={p.allocationTone}
                    >
                      {p.allocation}
                    </RegisterCell>
                    <RegisterCell align="end">
                      <GalleryAccentLink href={`/graph?project=${p.id}`}>
                        Graph
                      </GalleryAccentLink>
                    </RegisterCell>
                  </RegisterRow>
                ))}
              </Register>
            </div>
          </section>

          {/* ---- Runs + Settings ----------------------------------------- */}
          <div className={`block ${css.pair}`}>
            <section aria-label="Runs" className={css.collapse}>
              <BlockBar index="06" title="Runs" meta="Allocation log" />
              <Register
                label="Allocation runs"
                stackedColumns="repeat(3, minmax(0, 1fr))"
                columns="minmax(0, 1fr) 84px repeat(4, 54px)"
                header={[
                  { id: 'run', label: 'Run' },
                  { id: 'mode', label: 'Mode' },
                  { id: 'a', label: 'Asgn', align: 'end' },
                  { id: 's', label: 'Skip', align: 'end' },
                  { id: 'b', label: 'Blkd', align: 'end' },
                  { id: 'f', label: 'Fail', align: 'end' },
                ]}
              >
                {RUNS.map((run) => (
                  <RegisterRow
                    key={run.id}
                    href={`/runs/${run.id}`}
                    rowLabel={`Run ${run.id}, ${run.when}`}
                  >
                    <RegisterCell
                      label="Run"
                      variant="name"
                      sub={`${run.when} · ${run.trigger}`}
                    >
                      {run.id.replace('run-', 'Run ')}
                    </RegisterCell>
                    <RegisterCell label="Mode">
                      <Chip
                        tone={run.mode === 'Live' ? 'info' : 'default'}
                        filled={run.mode === 'Live'}
                      >
                        {run.mode}
                      </Chip>
                    </RegisterCell>
                    <RegisterCell label="Assigned" variant="mono" align="end">
                      {run.assigned}
                    </RegisterCell>
                    <RegisterCell
                      label="Skipped"
                      variant="mono"
                      align="end"
                      tone="muted"
                    >
                      {run.skipped}
                    </RegisterCell>
                    <RegisterCell
                      label="Blocked"
                      variant="mono"
                      align="end"
                      tone={run.blocked > 0 ? 'warning' : 'default'}
                    >
                      {run.blocked}
                    </RegisterCell>
                    <RegisterCell
                      label="Failed"
                      variant="mono"
                      align="end"
                      tone={run.failed > 0 ? 'danger' : 'default'}
                    >
                      {run.failed}
                    </RegisterCell>
                  </RegisterRow>
                ))}
              </Register>
            </section>
            <section aria-label="Settings" className={css.collapse}>
              <BlockBar index="07" title="Settings · modes" meta="Audited" />
              <Register
                label="Modes"
                columns="minmax(0, 1fr) auto"
                stackBelow={700}
                stackedColumns="minmax(0, 1fr)"
              >
                <RegisterRow>
                  <RegisterCell
                    variant="name"
                    sub="Writes assignee and state to Linear"
                  >
                    Live allocation
                  </RegisterCell>
                  <RegisterCell align="end">
                    <Switch label="Live" checked={live} onChange={setLive} />
                  </RegisterCell>
                </RegisterRow>
                <RegisterRow>
                  <RegisterCell
                    variant="name"
                    sub="Slack DM at 08:00 to leads and watchers"
                  >
                    Daily digest
                  </RegisterCell>
                  <RegisterCell align="end">
                    <Switch
                      label="Enabled"
                      checked={digest}
                      onChange={setDigest}
                    />
                  </RegisterCell>
                </RegisterRow>
                <RegisterRow>
                  <RegisterCell
                    variant="name"
                    sub="Re-send an overdue notice every"
                  >
                    Overdue repeats
                  </RegisterCell>
                  <RegisterCell align="end">
                    <SegmentedControl
                      label="Overdue repeat interval"
                      size="sm"
                      value={repeat}
                      onChange={setRepeat}
                      options={[
                        { id: '1', label: '1 day' },
                        { id: '3', label: '3 days' },
                        { id: '7', label: '7 days' },
                      ]}
                    />
                  </RegisterCell>
                </RegisterRow>
                <RegisterRow tone="muted">
                  <RegisterCell
                    variant="name"
                    sub="Disabled while a save is in flight"
                  >
                    Notify on at-risk
                  </RegisterCell>
                  <RegisterCell align="end">
                    <Switch label="Enabled" disabled />
                  </RegisterCell>
                </RegisterRow>
              </Register>
            </section>
          </div>

          {/* ---- Primitives --------------------------------------------- */}
          <section className="block" aria-label="Primitives">
            <BlockBar
              index="08"
              title="Primitives"
              meta="Tasks family sampler"
            />
            <div className={css.specimens}>
              <Specimen title="Button">
                <div className={css.line}>
                  <Button variant="primary" icon={<PlayIcon />}>
                    Run now
                  </Button>
                  <Button icon={<EyeIcon />}>Preview (dry run)</Button>
                  <Button variant="danger">Unassign</Button>
                  <Button disabled>Disabled</Button>
                </div>
                <div className={css.line}>
                  <Button variant="primary" size="sm">
                    Save
                  </Button>
                  <Button size="sm" href="/runs">
                    Link button
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    iconAfter={<ArrowIcon />}
                    href="/projects"
                  >
                    All projects
                  </Button>
                  <Button
                    size="sm"
                    icon={<LinkIcon />}
                    aria-label="Copy link"
                  />
                  <Button
                    size="sm"
                    href="https://linear.app/example/issue/BEA-95"
                    external
                    iconAfter={<ArrowIcon />}
                  >
                    Open in Linear
                  </Button>
                </div>
              </Specimen>
              <Specimen title="Chip">
                <div className={css.line}>
                  <Chip>In Progress</Chip>
                  <Chip tone="muted">Backlog</Chip>
                  <Chip tone="inverse">Live</Chip>
                  <Chip tone="warning" filled>
                    Blocked: no lead
                  </Chip>
                </div>
                <div className={css.line}>
                  <Chip tone="danger">Failed</Chip>
                  <Chip tone="warning">2 unassigned</Chip>
                  <Chip tone="success">Succeeded</Chip>
                  <Chip tone="info">Running</Chip>
                </div>
                <div className={css.line}>
                  <Chip tone="danger" filled>
                    Failed
                  </Chip>
                  <Chip tone="warning" filled>
                    Partly failed
                  </Chip>
                  <Chip tone="success" filled>
                    Assigned
                  </Chip>
                  <Chip tone="info" filled>
                    Live
                  </Chip>
                </div>
                <div className={css.line}>
                  <Chip status="overdue" statusLabel="Overdue">
                    Overdue
                  </Chip>
                  <Chip status="at_risk" statusLabel="At risk">
                    At risk
                  </Chip>
                  <Chip
                    tone="danger"
                    filled
                    status="overdue"
                    statusLabel="Overdue"
                  >
                    Overdue · 2 days
                  </Chip>
                  <Chip tone="inverse" status="done" statusLabel="Complete">
                    Complete
                  </Chip>
                </div>
                <div className={css.line}>
                  <Chip tone="accent">
                    New — given to you because you lead Atlas
                  </Chip>
                </div>
              </Specimen>
              <Specimen title="Segmented control">
                <div className={css.line}>
                  <SegmentedControl
                    label="My tasks"
                    options={HOME_TABS}
                    defaultValue="upcoming"
                  />
                </div>
                <div className={css.line}>
                  <SegmentedControl
                    label="Zoom"
                    options={ZOOM_OPTIONS}
                    value={zoom}
                    onChange={setZoom}
                    size="sm"
                  />
                  <span className={css.note}>Zoom: {zoom}</span>
                </div>
                <SegmentedControl
                  label="Level"
                  options={[
                    { id: 'm', label: 'Milestones' },
                    { id: 'i', label: 'Issues in Atlas' },
                  ]}
                  fill
                />
              </Specimen>
              <Specimen title="Switch">
                <div className={css.stack}>
                  <Switch label="Dependencies" defaultChecked />
                  <Switch
                    label="Only at risk / overdue"
                    note="hides on-track lanes"
                  />
                  <Switch
                    label="Live mode"
                    note="saving…"
                    disabled
                    defaultChecked
                  />
                </div>
              </Specimen>
              <Specimen title="Progress rule">
                <div className={css.stack}>
                  <ProgressRule
                    done={3}
                    total={7}
                    aria-label="Public beta progress"
                  />
                  <ProgressRule
                    done={4}
                    total={7}
                    tone="danger"
                    aria-label="Cutover rehearsal progress"
                  />
                  <ProgressRule
                    done={1}
                    total={6}
                    tone="warning"
                    aria-label="Read path switch progress"
                  />
                  <ProgressRule
                    done={0}
                    total={5}
                    aria-label="Decommission progress"
                  />
                  <ProgressRule
                    done={9}
                    total={9}
                    tone="success"
                    label="Complete"
                    aria-label="Docs progress"
                  />
                  <ProgressRule
                    done={2}
                    total={4}
                    tone="muted"
                    aria-label="Dashboards progress (inactive project)"
                  />
                </div>
              </Specimen>
              <Specimen title="State + priority glyphs">
                <ul className={css.legend} aria-label="Issue states">
                  {STATE_KINDS.map((s) => (
                    <li key={s.kind} className={css.legendItem}>
                      <StateGlyph kind={s.kind} />
                      <span className="label">{s.label}</span>
                    </li>
                  ))}
                </ul>
                <ul className={css.legend} aria-label="Priorities">
                  {PRIORITIES.map((p) => (
                    <li key={p.priority} className={css.legendItem}>
                      <PriorityGlyph priority={p.priority} />
                      <span className="label">{p.label}</span>
                    </li>
                  ))}
                </ul>
              </Specimen>
              <Specimen title="Notice">
                <div className={css.stack}>
                  <Notice
                    label="Blocked"
                    tone="warning"
                    action={
                      <Button size="sm" variant="secondary" href="/projects">
                        Set a lead
                      </Button>
                    }
                  >
                    Delta has no lead, so its next milestone cannot be
                    allocated.
                  </Notice>
                  <Notice tone="default" label="Synced">
                    Resynced from Linear at 08:02. 4 issues changed.
                  </Notice>
                  <Notice tone="danger" label="Run failed" role="alert">
                    Linear refused 2 of 5 writes. Nothing else was changed.
                  </Notice>
                  <Notice label="Demo data">
                    The default accent frame, for a note that is not a status.
                  </Notice>
                </div>
              </Specimen>
              <Specimen title="Empty state">
                <div className={css.stack}>
                  <EmptyState
                    action={
                      <Button size="sm" href="/timeline">
                        Open timeline
                      </Button>
                    }
                  >
                    Nothing due this week
                  </EmptyState>
                  <EmptyState hatched>Missing: target date</EmptyState>
                  <TaskGroupTable
                    sections={[]}
                    emptyMessage="No issues assigned to you"
                  />
                </div>
              </Specimen>
              <Specimen title="Checklist · rubric">
                <Checklist items={RUBRIC} label="Cutover rehearsal rubric" />
              </Specimen>
            </div>
          </section>
        </main>
      </UiLinkProvider>
    </RecordContext.Provider>
  );
}

function Specimen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={css.specimen}>
      <h3 className={css.caption}>{title}</h3>
      {children}
    </div>
  );
}

/* An accent text link inside a register cell, through the host link. */
function GalleryAccentLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className="accentLink">
      {children}
    </Link>
  );
}
