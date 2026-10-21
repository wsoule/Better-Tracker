'use client';

import {
  Button,
  Notice,
  Switch,
  TimelineChart,
  type TimelineZoom,
  useToast,
} from '@better-tracker/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useMemo, useState } from 'react';

import {
  countLanes,
  filterTimelineGroups,
  GRANT_WRITE_HREF,
  initiativeOptions,
  type MilestoneDrawerModel,
  milestoneNames,
  type TimelinePageModel,
  type TimelineSelection,
  type TimelineUrlState,
  timelineHref,
  visibleDependencies,
  withLaneHrefs,
} from '../../../lib/adapters/timeline';
import { sendJson } from '../../../lib/api-client';
import { formatDate, plural } from '../../../lib/format';
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
}

/** Rewrites the address bar without a server round trip (Next keeps
    useSearchParams in step with native history calls). */
function replaceUrl(href: string): void {
  window.history.replaceState(null, '', href);
}

/* The timeline's client island (architecture §8.4): banners, the toolbar
   (search, initiative, only active, only at risk / overdue, plus the
   chart's own zoom, Today and Dependencies), the chart, and the milestone
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
}: TimelineScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const searchId = useId();
  const initiativeId = useId();

  // Local filter state, reset whenever a navigation brings a different URL
  // state from the server (the sidebar's project links, back/forward).
  // Our own replaceState writes never re-render the server page, and our
  // pushes carry the current state, so they leave it alone.
  const urlKey = timelineHref(urlState);
  const [syncedKey, setSyncedKey] = useState(urlKey);
  const [state, setState] = useState(urlState);
  if (syncedKey !== urlKey) {
    setSyncedKey(urlKey);
    setState(urlState);
  }

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

  const update = useCallback(
    (patch: Partial<TimelineUrlState>) => {
      const next = { ...state, ...patch };
      setState(next);
      replaceUrl(
        timelineHref(next, {
          projectId: focusProjectId,
          milestoneId: requestedId,
        })
      );
    },
    [state, focusProjectId, requestedId]
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

  const openBar = useCallback(
    (barId: string) => {
      setRequestedId(barId);
      router.push(
        timelineHref(state, { projectId: focusProjectId, milestoneId: barId }),
        { scroll: false }
      );
    },
    [router, state, focusProjectId]
  );

  const closeDrawer = useCallback(() => {
    setRequestedId(null);
    router.push(timelineHref(state, { projectId: focusProjectId }), {
      scroll: false,
    });
  }, [router, state, focusProjectId]);

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
              edits to re-date milestones and set project leads.
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
                placeholder="Search projects"
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
              <Switch
                checked={state.activeOnly}
                onChange={(on) => update({ activeOnly: on })}
                label="Only active"
              />
              <Switch
                checked={state.riskOnly}
                onChange={(on) => update({ riskOnly: on })}
                label="Only at risk / overdue"
              />
              <p className={css.count} aria-live="polite">
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
        open={requestedId !== null}
        loading={requestedId !== null && drawerId !== requestedId}
        model={drawerId === requestedId ? drawer : null}
        fallbackTitle={requested?.label ?? 'Milestone'}
        fallbackCrumb={requested?.projectName ?? ''}
        hrefFor={(milestoneId) =>
          hrefFor({ projectId: focusProjectId, milestoneId })
        }
        onClose={closeDrawer}
      />
    </>
  );
}
