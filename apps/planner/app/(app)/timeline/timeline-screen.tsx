'use client';

import {
  Button,
  Notice,
  SegmentedControl,
  TimelineChart,
  type TimelineZoom,
  useToast,
} from '@better-tracker/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { withIssueParam } from '../../../lib/adapters/issue';
import {
  countLanes,
  filterTimelineGroups,
  GRANT_WRITE_HREF,
  initiativeOptions,
  type MilestoneDrawerModel,
  milestoneNames,
  parseTimelineSearch,
  SHOW_OPTIONS,
  showFilters,
  type TimelinePageModel,
  type TimelineSelection,
  timelineShow,
  type TimelineUrlState,
  timelineHref,
  visibleDependencies,
  withLaneHrefs,
} from '../../../lib/adapters/timeline';
import { sendJson } from '../../../lib/api-client';
import { formatDate, plural } from '../../../lib/format';
import {
  type IssueDrawerServer,
  useIssueDrawerParts,
  useIssueDrawerState,
} from '../components/issue-drawer';
import { PageCrumb } from '../components/page-crumb';
import MilestoneDrawer from './milestone-drawer';
import css from './page.module.css';
import TimelineBanners from './timeline-banners';

interface TimelineScreenProps {
  model: TimelinePageModel;
  /** Filters, zoom and dependencies as the server parsed them from the URL. */
  urlState: TimelineUrlState;
  focusProjectId: string | null;
  drawer: MilestoneDrawerModel | null;
  /** ?milestone= named a milestone the mirror does not have. */
  missingMilestoneId: string | null;
  /** ?issue=: the issue opened from the milestone drawer (§8.5). */
  issueDrawer: IssueDrawerServer;
}

/** Rewrites the address bar without a server round trip (Next keeps
    useSearchParams in step with native history calls). Returns the query
    string it wrote, as useSearchParams will echo it back. */
function replaceUrl(href: string): string {
  window.history.replaceState(null, '', href);
  const at = href.indexOf('?');
  return at === -1 ? '' : href.slice(at + 1);
}

/* The timeline's client island (architecture §8.4): banners, the toolbar
   (search, initiative, Show all / active / at risk, plus the chart's own
   zoom, Today and Dependencies), the chart, and the milestone
   drawer. Filter and zoom state is mirrored to the URL in place; opening
   or closing a milestone navigates (?milestone=) so the server loads its
   details. Re-dating PATCHes the milestone and refreshes; a failure is
   toasted and rethrown so the chart rolls the bar back. */
export default function TimelineScreen({
  model,
  urlState,
  focusProjectId,
  drawer,
  missingMilestoneId,
  issueDrawer,
}: TimelineScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const searchId = useId();
  const initiativeId = useId();

  // Local filter state that follows the address bar whenever it changes
  // under the island: back/forward (the cached page still carries the
  // props it was first rendered with), the sidebar's plain /timeline link
  // or a project link while filters are on. The query strings this island
  // wrote itself come back here too, possibly late while someone types, so
  // those are recognised and skipped; a URL that means the state already
  // shown (a drawer push carries the filters) keeps it, half-typed search
  // included.
  const [state, setState] = useState(urlState);
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
    const next = parseTimelineSearch(new URLSearchParams(urlSearch));
    setState((current) =>
      timelineHref(current) === timelineHref(next) ? current : next
    );
  }, [urlSearch]);

  // The drawer opens at once on click (with a skeleton) and fills in when
  // the server's details arrive; it follows the server when the URL moves,
  // and closes when the server says the milestone is gone.
  const drawerId = drawer?.milestoneId ?? null;
  const serverKey = JSON.stringify([drawerId, missingMilestoneId]);
  const [syncedServerKey, setSyncedServerKey] = useState(serverKey);
  const [requestedId, setRequestedId] = useState(drawerId);
  if (syncedServerKey !== serverKey) {
    setSyncedServerKey(serverKey);
    setRequestedId(drawerId);
  }

  const focus = focusProjectId ?? undefined;
  const hrefFor = useCallback(
    (selection: TimelineSelection) => timelineHref(state, selection),
    [state]
  );

  // An issue opened from the drawer's list replaces the milestone in the
  // same panel; its crumb goes back to the milestone (§8.5).
  const issue = useIssueDrawerState(issueDrawer);
  const issueRequested = issue.requested;

  const update = useCallback(
    (patch: Partial<TimelineUrlState>) => {
      const next = { ...state, ...patch };
      setState(next);
      written.current.push(
        replaceUrl(
          withIssueParam(
            timelineHref(next, {
              projectId: focusProjectId,
              milestoneId: requestedId,
            }),
            issueRequested
          )
        )
      );
    },
    [state, focusProjectId, requestedId, issueRequested]
  );

  const groups = useMemo(
    () =>
      withLaneHrefs(model.groups, (laneId) =>
        timelineHref(state, { projectId: laneId })
      ),
    [model.groups, state]
  );
  const options = useMemo(
    () => initiativeOptions(model.groups),
    [model.groups]
  );
  // A stale ?initiative= (no such group any more) reads as "all".
  const initiative = options.some((option) => option.id === state.initiative)
    ? state.initiative
    : 'all';
  const visible = useMemo(
    () => filterTimelineGroups(groups, { ...state, initiative }),
    [groups, state, initiative]
  );
  const dependencies = useMemo(
    () => visibleDependencies(model.dependencies, visible),
    [model.dependencies, visible]
  );
  const names = useMemo(() => milestoneNames(model.groups), [model.groups]);
  const total = countLanes(model.groups);
  const shown = countLanes(visible);

  const forgetIssue = issue.forget;
  const openBar = useCallback(
    (barId: string) => {
      forgetIssue();
      setRequestedId(barId);
      router.push(
        timelineHref(state, { projectId: focusProjectId, milestoneId: barId }),
        { scroll: false }
      );
    },
    [router, state, focusProjectId, forgetIssue]
  );

  // Closes the panel, issue and milestone alike (the URL keeps neither).
  const closeDrawer = useCallback(() => {
    forgetIssue();
    setRequestedId(null);
    router.push(timelineHref(state, { projectId: focusProjectId }), {
      scroll: false,
    });
  }, [router, state, focusProjectId, forgetIssue]);

  const onRedate = useCallback(
    async (barId: string, newEnd: string) => {
      const name = names[barId]?.label ?? 'The milestone';
      const result = await sendJson(
        'PATCH',
        `/api/milestones/${encodeURIComponent(barId)}`,
        { targetDate: newEnd }
      );
      if (!result.ok) {
        toast({ kind: 'error', label: 'Not saved', message: result.message });
        throw new Error(result.message);
      }
      toast({
        kind: 'info',
        label: 'Saved',
        message: `${name} is now due ${formatDate(newEnd, model.today)}.`,
      });
      router.refresh();
    },
    [names, toast, router, model.today]
  );

  const requested = requestedId === null ? undefined : names[requestedId];
  const milestoneLabel =
    drawer !== null && drawer.milestoneId === requestedId
      ? drawer.title
      : requested?.label;
  const issueParts = useIssueDrawerParts(issue, {
    back:
      requestedId === null
        ? undefined
        : { label: milestoneLabel ?? 'Milestone', onBack: issue.close },
    fallbackTitle: drawer?.issues.find(
      (row) => row.key.toUpperCase() === issueRequested?.toUpperCase()
    )?.title,
  });
  const focusName =
    focusProjectId === null
      ? undefined
      : model.groups
          .flatMap((group) => group.lanes)
          .find((lane) => lane.id === focusProjectId)?.label;
  const crumb = drawer?.projectName ?? requested?.projectName ?? focusName;
  const narrowed =
    state.query.trim() !== '' ||
    initiative !== 'all' ||
    state.activeOnly ||
    state.riskOnly;

  return (
    <>
      {crumb === undefined ? null : <PageCrumb label={crumb} />}

      {model.banners.length > 0 ||
      model.needsWriteGrant ||
      missingMilestoneId !== null ? (
        <div className={css.notices}>
          {missingMilestoneId === null ? null : (
            <Notice label="Not found" role="status" tone="default">
              That milestone is not on the timeline any more. It may have been
              deleted in Linear or moved to a completed project.
            </Notice>
          )}
          {model.needsWriteGrant ? (
            <Notice
              label="Read only"
              tone="default"
              action={
                <Button size="sm" href={GRANT_WRITE_HREF}>
                  Allow edits
                </Button>
              }
            >
              You are a PM, but the planner can only read Linear for you. Allow
              edits to re-date milestones, set project leads and edit issues.
            </Notice>
          ) : null}
          <TimelineBanners banners={model.banners} hrefFor={hrefFor} />
        </div>
      ) : null}

      <section className={css.chartWrap} aria-label="Milestone timeline">
        <TimelineChart
          today={model.today}
          windowStart={model.windowStart}
          windowEnd={model.windowEnd}
          zoom={state.zoom}
          onZoomChange={(zoom: TimelineZoom) => update({ zoom })}
          groups={visible}
          dependencies={dependencies}
          showDependencies={state.showDependencies}
          onShowDependenciesChange={(show) =>
            update({ showDependencies: show })
          }
          selectedBarId={requestedId ?? undefined}
          focusLaneId={focus}
          onOpenBar={openBar}
          onRedate={model.canEditLinear ? onRedate : undefined}
          emptyLabel={
            total === 0
              ? 'No open projects. Projects appear here once they exist in Linear and are not completed or canceled.'
              : 'No projects match these filters. Clear the search or turn a filter off.'
          }
          toolbarStart={
            <div className={css.filters}>
              <label className="srOnly" htmlFor={searchId}>
                Search projects
              </label>
              <input
                id={searchId}
                className={`input ${css.search}`}
                type="search"
                placeholder="Search"
                autoComplete="off"
                value={state.query}
                onChange={(event) => update({ query: event.target.value })}
              />
              <label className="srOnly" htmlFor={initiativeId}>
                Initiative
              </label>
              <select
                id={initiativeId}
                className={`select ${css.select}`}
                value={initiative}
                onChange={(event) => update({ initiative: event.target.value })}
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          }
          toolbarEnd={
            <>
              <SegmentedControl
                size="sm"
                label="Show projects"
                options={[...SHOW_OPTIONS]}
                value={timelineShow(state)}
                onChange={(id) => update(showFilters(id))}
              />
              {/* Each initiative row of the chart shows its count; this
                  says the total when a filter or the search changes it. */}
              <p className="srOnly" aria-live="polite">
                {narrowed
                  ? `${shown} of ${plural(total, 'project')}`
                  : plural(total, 'project')}
              </p>
            </>
          }
          maxHeight="calc(100vh - 150px)"
        />
      </section>

      <MilestoneDrawer
        open={requestedId !== null || issueRequested !== null}
        loading={requestedId !== null && drawerId !== requestedId}
        model={drawerId === requestedId ? drawer : null}
        fallbackTitle={requested?.label ?? 'Milestone'}
        fallbackCrumb={requested?.projectName ?? ''}
        hrefFor={(milestoneId) =>
          hrefFor({ projectId: focusProjectId, milestoneId })
        }
        onClose={closeDrawer}
        issue={issueRequested === null ? null : issueParts}
        onOpenIssue={issue.open}
        issueHref={issue.hrefFor}
      />
    </>
  );
}
