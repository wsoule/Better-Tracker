'use client';

import {
  BlockBar,
  Button,
  Chip,
  EmptyState,
  ProgressRule,
  Register,
  RegisterCell,
  RegisterRow,
  SegmentedControl,
  type SegmentedOption,
  StatusMark,
} from '@better-tracker/ui';
import { ArrowUpRight, Network, Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  filterProjectGroups,
  parseProjectFilter,
  parseProjectsSearch,
  type ProjectFilterId,
  type ProjectGroupModel,
  type ProjectRowModel,
} from '../../../lib/adapters/projects';
import { plural } from '../../../lib/format';
import css from './page.module.css';

const COLUMNS =
  'minmax(180px, 1.4fr) 112px minmax(0, 1.4fr) 120px minmax(0, 0.8fr) minmax(0, 1fr) 72px';

/* Gr8r keeps the table: the seven columns stay readable down to a
   register 900px wide (a 1280px window with the sidebar open leaves 932),
   the project name keeping at least 180px and the links two 26px icon
   buttons. Narrower (a tablet, a phone) each row becomes a card: the
   project on top, the other cells in as many 150px columns as fit (two on
   a phone). */
const STACKED_COLUMNS = 'repeat(auto-fill, minmax(150px, 1fr))';

const HEADER = [
  { id: 'name', label: 'Project' },
  { id: 'status', label: 'Linear' },
  { id: 'next', label: 'Next milestone' },
  { id: 'progress', label: 'Progress' },
  { id: 'lead', label: 'Lead' },
  { id: 'allocation', label: 'Allocation' },
  { id: 'links', label: 'Links', align: 'end' as const },
];

/** Mirrors the search and filter into the URL without a server round trip,
    so a filtered register can be reloaded or linked. Returns the query
    string it wrote (Next echoes it back through useSearchParams). */
function syncUrl(query: string, filter: ProjectFilterId): string {
  const params = new URLSearchParams(window.location.search);
  if (query === '') params.delete('q');
  else params.set('q', query);
  if (filter === 'all') params.delete('filter');
  else params.set('filter', filter);
  const search = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search === '' ? '' : `?${search}`}`
  );
  return search;
}

/* The projects register's client island: search box and status filter
   over the rows the server built (filterProjectGroups does the matching),
   then one panel per initiative under its section title, whose quiet
   Graph button opens the initiative's dependency graph. Rows open the
   project's timeline lane; the end cell links to its graph and to Linear
   as 26px ghost icon buttons. */
export default function ProjectsRegister({
  groups,
  filters,
  initialFilter,
  initialQuery,
}: {
  groups: ProjectGroupModel[];
  filters: SegmentedOption[];
  initialFilter: ProjectFilterId;
  initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<ProjectFilterId>(initialFilter);
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);

  // Follow the address bar when it changes under the register: back and
  // forward (the cached page still carries the props it was first rendered
  // with) and links to /projects while a filter is on (the sidebar, G P).
  // The query strings this island wrote itself come back here too, possibly
  // late while someone types, so those are recognised and skipped.
  const searchParams = useSearchParams();
  const urlSearch = searchParams.toString();
  const written = useRef<string[]>([]);
  useEffect(() => {
    const own = written.current.indexOf(urlSearch);
    if (own !== -1) {
      written.current.splice(0, own + 1);
      return;
    }
    written.current = [];
    const next = parseProjectsSearch(new URLSearchParams(urlSearch));
    setQuery((current) =>
      current.trim() === next.query ? current : next.query
    );
    setFilter(next.filter);
  }, [urlSearch]);

  const shown = useMemo(
    () => filterProjectGroups(groups, query, filter),
    [groups, query, filter]
  );
  const shownCount = shown.reduce((sum, group) => sum + group.rows.length, 0);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const narrowed = query.trim() !== '' || filter !== 'all';

  function update(nextQuery: string, nextFilter: ProjectFilterId) {
    setQuery(nextQuery);
    setFilter(nextFilter);
    written.current.push(syncUrl(nextQuery.trim(), nextFilter));
  }

  return (
    <>
      <div className={css.toolbarWrap}>
        <div className={css.toolbar} role="search">
          <label className="srOnly" htmlFor={searchId}>
            Search projects
          </label>
          <span className={css.searchWrap}>
            <Search
              className={css.searchIcon}
              size={13}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <input
              id={searchId}
              ref={searchRef}
              className={`input ${css.search}`}
              type="search"
              placeholder="Search projects"
              autoComplete="off"
              value={query}
              onChange={(event) => update(event.target.value, filter)}
            />
          </span>
          <SegmentedControl
            label="Project status"
            options={filters}
            value={filter}
            onChange={(id) => update(query, parseProjectFilter(id))}
            size="sm"
          />
          <p className={css.count} aria-live="polite">
            {narrowed
              ? `${shownCount} of ${plural(total, 'project')}`
              : plural(total, 'project')}
          </p>
        </div>
      </div>

      {total === 0 ? (
        <div className={css.blocks}>
          <EmptyState label="No projects">
            No open projects. Projects appear here once they exist in Linear and
            are not completed or canceled.
          </EmptyState>
        </div>
      ) : shown.length === 0 ? (
        <div className={css.blocks}>
          <EmptyState
            action={
              <Button
                size="sm"
                onClick={() => {
                  update('', 'all');
                  // The button goes away with the empty state; keep the
                  // keyboard user in the toolbar instead of on <body>.
                  searchRef.current?.focus();
                }}
              >
                Show all projects
              </Button>
            }
          >
            No projects match
            {query.trim() === '' ? ' this filter' : ` "${query.trim()}"`}
          </EmptyState>
        </div>
      ) : (
        shown.map((group) => (
          <section
            key={group.id}
            className={css.blocks}
            aria-label={group.name}
          >
            <BlockBar
              title={group.name}
              meta={plural(group.rows.length, 'project')}
            >
              <Button
                href={group.graphHref}
                variant="quiet"
                size="sm"
                icon={<Network size={14} strokeWidth={1.8} />}
                aria-label={`Dependency graph of ${group.name}`}
              >
                Graph
              </Button>
            </BlockBar>
            <Register
              label={`${group.name} projects`}
              columns={COLUMNS}
              header={HEADER}
              stackWithin={900}
              stackedColumns={STACKED_COLUMNS}
            >
              {group.rows.map((row) => (
                <ProjectRow key={row.id} row={row} />
              ))}
            </Register>
          </section>
        ))
      )}
    </>
  );
}

function ProjectRow({ row }: { row: ProjectRowModel }) {
  const { next } = row;
  return (
    <RegisterRow
      href={row.timelineHref}
      rowLabel={`${row.name} on the timeline`}
      tone={row.rowTone}
    >
      {/* No initiative line: the panel's title already names it. */}
      <RegisterCell label="Project" variant="name">
        {row.name}
      </RegisterCell>
      <RegisterCell label="Linear">
        <Chip tone={row.linearStatusTone} dot>
          {row.linearStatus}
        </Chip>
      </RegisterCell>
      {next === null ? (
        <RegisterCell label="Next milestone" variant="mono" tone="muted">
          No open milestone
        </RegisterCell>
      ) : (
        <RegisterCell
          label="Next milestone"
          sub={
            <span className={css.due} data-tone={next.dueTone}>
              {next.dueLabel}
            </span>
          }
        >
          <span className={css.milestone}>
            <StatusMark
              status={next.status}
              label={next.statusLabel}
              muted={next.muted}
            />
            <span className={css.milestoneName}>{next.name}</span>
          </span>
        </RegisterCell>
      )}
      <RegisterCell label="Progress">
        {next === null ? (
          <span className={css.dash}>—</span>
        ) : (
          <ProgressRule
            done={next.done}
            total={next.total}
            tone={next.progressTone}
            aria-label={`${next.name} progress`}
          />
        )}
      </RegisterCell>
      <RegisterCell
        label="Lead"
        tone={row.lead === null ? 'warning' : 'default'}
      >
        {row.lead ?? 'No lead'}
      </RegisterCell>
      <RegisterCell label="Allocation" sub={row.allocation.detail}>
        <Chip tone={row.allocation.tone}>{row.allocation.label}</Chip>
      </RegisterCell>
      <RegisterCell align="end">
        <span className={css.links}>
          <Button
            href={row.graphHref}
            variant="quiet"
            size="sm"
            icon={<Network size={14} strokeWidth={1.8} />}
            title="Dependency graph"
            aria-label={`Dependency graph of ${row.name}`}
          />
          <Button
            href={row.linearUrl}
            external
            variant="quiet"
            size="sm"
            icon={<ArrowUpRight size={14} strokeWidth={1.8} />}
            title="Open in Linear"
            aria-label={`${row.name} in Linear (opens in a new tab)`}
          />
        </span>
      </RegisterCell>
    </RegisterRow>
  );
}
