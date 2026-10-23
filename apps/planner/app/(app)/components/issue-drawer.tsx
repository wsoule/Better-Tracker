'use client';

import {
  EmptyState,
  SkeletonText,
  SlideOver,
  TaskCrumbs,
  TaskDetail,
} from '@better-tracker/ui';
import { ChevronLeft } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

import {
  type IssueTaskModel,
  withIssueParam,
} from '../../../lib/adapters/issue';
import css from './issue-drawer.module.css';
import {
  IssueHeaderActions,
  IssueTitleField,
  useIssueTaskProps,
} from './issue-task';

// The issue slide-over (architecture §8.5): `?issue=<identifier or id>`
// on My week, the timeline and the graph. The page's server component
// reads the parameter and renders the issue's model (lib/issue-load.ts);
// this island opens the drawer at once on a click, with a skeleton, and
// fills it when the server answers, like the milestone drawer. Closing
// removes the parameter. On the timeline the issue replaces the milestone
// drawer's content in the same panel, with a "Back to <milestone>" crumb.

/** What the server rendered for ?issue=: the raw value and its model
    (null when the planner does not hold that issue). */
export interface IssueDrawerServer {
  param: string | null;
  model: IssueTaskModel | null;
}

export interface IssueDrawerState {
  /** The issue the person asked for (the URL's, or a click's ahead of it). */
  requested: string | null;
  /** Requested, and the server has not answered for it yet. */
  loading: boolean;
  /** The drawer's own navigation (open, swap or close) is on its way. */
  navigating: boolean;
  /** The answered model of `requested` (null while loading or missing). */
  model: IssueTaskModel | null;
  /** The server answered: no such issue in the planner. */
  missing: boolean;
  /** Opens (or swaps to) an issue: navigates to ?issue=<key>. */
  open: (key: string) => void;
  /** Closes the drawer: navigates without ?issue=. */
  close: () => void;
  /** Forgets the request without navigating (a host that navigates
      itself, such as the timeline closing both drawers at once). */
  forget: () => void;
  /** The current URL with ?issue= set to `key`. */
  hrefFor: (key: string) => string;
}

/**
 * The drawer's request state, following the server: the URL's ?issue= on
 * first render and whenever the server answers for a new one, and a click
 * ahead of it (navigating with scroll kept).
 */
export function useIssueDrawerState(
  server: IssueDrawerServer
): IssueDrawerState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const current = query === '' ? pathname : `${pathname}?${query}`;

  const [synced, setSynced] = useState(server.param);
  const [requested, setRequested] = useState(server.param);
  if (synced !== server.param) {
    setSynced(server.param);
    setRequested(server.param);
  }

  const hrefFor = useCallback(
    (key: string) => withIssueParam(current, key),
    [current]
  );
  // The drawer's own navigations run in a transition, so the screen can
  // tell one is on its way (a history write would cancel it).
  const [navigating, startNavigation] = useTransition();
  const open = useCallback(
    (key: string) => {
      setRequested(key);
      startNavigation(() => {
        router.push(withIssueParam(current, key), { scroll: false });
      });
    },
    [router, current]
  );
  const close = useCallback(() => {
    setRequested(null);
    startNavigation(() => {
      router.push(withIssueParam(current, null), { scroll: false });
    });
  }, [router, current]);
  const forget = useCallback(() => setRequested(null), []);

  const answered = requested !== null && requested === server.param;
  return {
    requested,
    navigating,
    loading: requested !== null && !answered,
    model: answered ? server.model : null,
    missing: answered && server.model === null,
    open,
    close,
    forget,
    hrefFor,
  };
}

/** The pieces a SlideOver draws for the issue. */
export interface IssueDrawerParts {
  /** The SlideOver's `contentKey` ("issue:ENG-24", by the requested key,
      so loading → loaded is not a swap): a new one is a swap in place. */
  contentKey: string;
  title: ReactNode;
  breadcrumb: ReactNode;
  actions: ReactNode;
  closeLabel: string;
  body: ReactNode;
}

/** Back to the drawer the issue was opened from (the milestone). */
export interface IssueDrawerBack {
  label: string;
  onBack: () => void;
}

// The breadcrumb with a Back button first: "‹ DUAL-WRITE / ENG-24".
function BackCrumb({
  back,
  taskKey,
}: {
  back: IssueDrawerBack;
  taskKey: string;
}): ReactNode {
  return (
    <span className={css.crumb}>
      <button
        type="button"
        className={css.back}
        onClick={back.onBack}
        title={`Back to ${back.label}`}
      >
        <ChevronLeft size={12} strokeWidth={1.5} aria-hidden="true" />
        <span className="srOnly">Back to </span>
        <span className={css.backLabel}>{back.label}</span>
      </button>
      <span className={css.sep} aria-hidden="true">
        /
      </span>
      <span className={css.key}>{taskKey}</span>
    </span>
  );
}

/** The ready body: TaskDetail in the drawer layout, scrolled to the top
    whenever it swaps to another issue. */
function DrawerTask({
  model,
  openIssue,
}: {
  model: IssueTaskModel;
  openIssue: (key: string) => void;
}): ReactNode {
  const props = useIssueTaskProps(model, { openIssue });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = ref.current?.parentElement;
    if (body !== null && body !== undefined) body.scrollTop = 0;
  }, [model.issueId]);
  return (
    <div ref={ref}>
      <TaskDetail {...props} layout="drawer" header={false} headingLevel={2} />
    </div>
  );
}

// The title: the inline title editor when the person may write, else
// the plain title.
function DrawerTitle({ model }: { model: IssueTaskModel }): ReactNode {
  return model.canEdit ? (
    <IssueTitleField model={model} />
  ) : (
    <span dir="auto">{model.title}</span>
  );
}

/**
 * The SlideOver pieces for the issue drawer's current state: a skeleton
 * while the server loads it, a "not found" body for an issue the planner
 * does not hold, else the issue (keyed by id, so the controls never carry
 * one issue's pending state into the next).
 */
export function useIssueDrawerParts(
  state: IssueDrawerState,
  options: { back?: IssueDrawerBack; fallbackTitle?: string } = {}
): IssueDrawerParts | null {
  const { requested, model, missing, open } = state;
  const { back, fallbackTitle } = options;
  return useMemo(() => {
    if (requested === null) return null;
    const crumb = (key: string): ReactNode =>
      back === undefined ? (
        <TaskCrumbs
          breadcrumb={model?.crumbs}
          taskKey={key}
          label="Breadcrumb"
        />
      ) : (
        <BackCrumb back={back} taskKey={key} />
      );
    const contentKey = `issue:${requested}`;
    if (missing) {
      return {
        contentKey,
        title: 'Issue not found',
        breadcrumb: crumb(requested),
        actions: null,
        closeLabel: 'Close issue',
        body: (
          <div className={css.state}>
            <EmptyState label="Not found">
              {`${requested} is not in the planner. It may be in a completed or canceled project, in a team the app cannot see, or deleted in Linear.`}
            </EmptyState>
          </div>
        ),
      };
    }
    if (model === null) {
      return {
        contentKey,
        title: fallbackTitle ?? requested,
        breadcrumb: crumb(requested),
        actions: null,
        closeLabel: 'Close issue',
        body: (
          <div className={css.state}>
            <SkeletonText lines={8} label="Loading the issue" />
          </div>
        ),
      };
    }
    return {
      contentKey,
      title: <DrawerTitle key={model.issueId} model={model} />,
      breadcrumb: crumb(model.key),
      actions: <IssueHeaderActions model={model} compact />,
      closeLabel: 'Close issue',
      body: <DrawerTask key={model.issueId} model={model} openIssue={open} />,
    };
  }, [requested, model, missing, open, back, fallbackTitle]);
}

/**
 * The issue slide-over on its own (My week, and any page with no drawer
 * of its own to share): open while an issue is requested.
 */
export function IssueDrawer({
  state,
  fallbackTitle,
}: {
  state: IssueDrawerState;
  fallbackTitle?: string;
}): ReactNode {
  // Keep drawing the last issue while the panel slides out.
  const [last, setLast] = useState(state);
  if (
    state.requested !== null &&
    (state.requested !== last.requested ||
      state.model !== last.model ||
      state.missing !== last.missing)
  ) {
    setLast(state);
  }
  const shown = useIssueDrawerParts(state.requested === null ? last : state, {
    fallbackTitle,
  });
  return (
    <SlideOver
      open={state.requested !== null}
      onClose={state.close}
      title={shown?.title ?? ''}
      breadcrumb={shown?.breadcrumb}
      actions={shown?.actions}
      closeLabel={shown?.closeLabel ?? 'Close issue'}
      contentKey={shown?.contentKey}
    >
      {shown?.body}
    </SlideOver>
  );
}
