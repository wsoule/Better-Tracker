'use client';

import {
  BlockBar,
  Button,
  Chip,
  PriorityGlyph,
  StateGlyph,
  TaskDetail,
  TaskDetailSection,
  type TaskRelation,
  TaskSlideOver,
  ToastProvider,
  UiLinkProvider,
  type UiLinkProps,
  useToast,
} from '@better-tracker/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import {
  DRAWER_TASKS,
  ENG_22,
  ENG_23,
  ENG_24,
  ENG_25,
  ENG_27,
  ENG_27_TEXT,
  ENG_32,
  ENG_35,
  type GalleryTask,
  linearUrl,
  PLATFORM_1042,
} from './fixtures';
import css from './page.module.css';

/* Gallery links never leave the page: they say where they would have gone.
   Gallery routes and hash links behave normally; external URLs never reach
   this component (Link renders those as plain anchors). */
function GalleryLink({ href, children, onClick, ...rest }: UiLinkProps) {
  const { toast } = useToast();
  return (
    <a
      href={href}
      {...rest}
      data-gallery-link=""
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (href.startsWith('#') || href.startsWith('/ui-gallery')) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        toast({ kind: 'info', label: 'Link', message: `Would open ${href}.` });
      }}
    >
      {children}
    </a>
  );
}

/* Inline 14px icons on the lucide grid (the gallery imports only from the
   UI package). */
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

/** The planner's header actions: open the issue in Linear, copy a link. */
function HeaderActions({ taskKey }: { taskKey: string }) {
  const { toast } = useToast();
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        href={linearUrl(taskKey)}
        external
        iconAfter={<ArrowIcon />}
      >
        Linear
      </Button>
      <Button
        variant="quiet"
        size="sm"
        icon={<LinkIcon />}
        onClick={() =>
          toast({
            kind: 'info',
            label: 'Copied',
            message: `Link to ${taskKey} copied to the clipboard.`,
          })
        }
      >
        Copy link
      </Button>
    </>
  );
}

/** Gives each relation the gallery has a fixture for an in-place opener;
    the rest keep their Linear link. */
function withOpeners(
  task: GalleryTask,
  open: (key: string) => void
): GalleryTask {
  if (task.relations === undefined) return task;
  const wire = (items: TaskRelation[]) =>
    items.map((item) =>
      DRAWER_TASKS[item.taskKey] === undefined
        ? item
        : { ...item, onOpen: () => open(item.taskKey) }
    );
  return {
    ...task,
    relations: {
      blockedBy: wire(task.relations.blockedBy),
      blocks: wire(task.relations.blocks),
    },
  };
}

const STATES: { id: string; label: string; task: GalleryTask }[] = [
  { id: 'alerts', label: 'Blocked · stalled · unassigned', task: ENG_32 },
  { id: 'external', label: 'Relations outside the view', task: ENG_23 },
  { id: 'loading', label: 'Description loading', task: ENG_25 },
  { id: 'error', label: 'Description failed to load', task: ENG_27 },
  { id: 'empty', label: 'No relations, no description', task: ENG_35 },
  { id: 'done', label: 'Done · resolved blocker', task: ENG_22 },
  {
    id: 'hostile',
    label: 'Hostile input · markup, long tokens, RTL',
    task: PLATFORM_1042,
  },
];

/** The description error card: Retry shows the skeleton, then the text. */
function useRetryingDescription(): GalleryTask {
  const [phase, setPhase] = useState<'error' | 'loading' | 'loaded'>('error');
  useEffect(() => {
    if (phase !== 'loading') return undefined;
    const timer = setTimeout(() => setPhase('loaded'), 1200);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === 'loaded') {
    return {
      ...ENG_27,
      description: { text: ENG_27_TEXT, sourceLabel: 'From Linear' },
    };
  }
  if (phase === 'loading') {
    return { ...ENG_27, description: { text: null, loading: true } };
  }
  return {
    ...ENG_27,
    description: {
      text: null,
      error: 'Linear did not answer in time.',
      onRetry: () => setPhase('loading'),
    },
  };
}

/* What an editable host such as Dispatch passes: a title editor, a status
   picker, pickers as property values, its own sections in the rail, an
   unlink button on each relation it owns, and its own rendering of the
   description. Edits stay in this component's state. */
function EditableHostDemo() {
  const { toast } = useToast();
  const [title, setTitle] = useState('Typo tolerance');
  const [blockedBy, setBlockedBy] = useState<TaskRelation[]>(
    () => ENG_23.relations?.blockedBy ?? []
  );
  const picker = (what: string) => () =>
    toast({
      kind: 'info',
      label: 'Picker',
      message: `Would open the ${what} picker.`,
    });
  const unlink = (key: string) => {
    setBlockedBy((list) => list.filter((item) => item.taskKey !== key));
    toast({
      kind: 'info',
      label: 'Unlinked',
      message: `${key} no longer blocks this task.`,
    });
  };
  return (
    <TaskDetail
      taskKey="ENG-23"
      title={title}
      titleControl={
        <input
          className={css.titleInput}
          aria-label="Task title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      }
      href={linearUrl('ENG-23')}
      breadcrumb={[
        { label: 'Beacon search', href: '/timeline?project=proj-beacon' },
        { label: 'ENG-23' },
      ]}
      headerActions={<HeaderActions taskKey="ENG-23" />}
      status={{
        kind: 'started',
        label: 'In Progress',
        control: (
          <button
            type="button"
            className={css.picker}
            onClick={picker('status')}
          >
            <StateGlyph kind="started" size={13} />
            In Progress
          </button>
        ),
      }}
      properties={[
        {
          id: 'assignee',
          label: 'Assignee',
          value: (
            <button
              type="button"
              className={css.picker}
              onClick={picker('assignee')}
            >
              Dev Patel
            </button>
          ),
        },
        {
          id: 'priority',
          label: 'Priority',
          value: (
            <button
              type="button"
              className={css.picker}
              onClick={picker('priority')}
            >
              <PriorityGlyph priority={2} size={13} />
              High
            </button>
          ),
        },
        {
          id: 'estimate',
          label: 'Estimate',
          value: (
            <button
              type="button"
              className={css.picker}
              onClick={picker('estimate')}
            >
              3 points
            </button>
          ),
        },
      ]}
      rail={
        <TaskDetailSection
          title="Labels"
          headingLevel={4}
          meta={
            <Button variant="quiet" size="sm" onClick={picker('label')}>
              Add
            </Button>
          }
        >
          <p className={css.chips}>
            <Chip>search</Chip>
            <Chip>backend</Chip>
          </p>
        </TaskDetailSection>
      }
      relations={{
        blockedBy: blockedBy.map((item) => ({
          ...item,
          onRemove: () => unlink(item.taskKey),
        })),
        blocks: [],
      }}
      description={{
        text: null,
        content: (
          <ul className={css.rendered}>
            <li>
              <strong>Fuzzy match</strong> queries one edit away from a known
              term.
            </li>
            <li>Log the corrected form beside the original (see ENG-24).</li>
          </ul>
        ),
        sourceLabel: 'Rendered by the host',
      }}
      activity={[
        {
          id: 'moved',
          at: 'Oct 20',
          label: (
            <>
              <strong>Dev Patel</strong> moved it to In Progress
            </>
          ),
        },
      ]}
      layout="page"
      headingLevel={3}
    />
  );
}

function GalleryBody({
  themeToggle,
  initialDrawerOpen,
}: {
  themeToggle: ReactNode;
  initialDrawerOpen: boolean;
}) {
  const [drawerKey, setDrawerKey] = useState('ENG-24');
  const [drawerOpen, setDrawerOpen] = useState(initialDrawerOpen);
  const errorTask = useRetryingDescription();

  const openTask = useCallback((key: string) => {
    setDrawerKey(key);
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const drawerTask = withOpeners(DRAWER_TASKS[drawerKey] ?? ENG_24, openTask);

  return (
    <main className="page">
      <div className="block">
        <BlockBar index="00" title="Task detail" meta={themeToggle} />
        <p className={css.lede}>
          What opens when someone clicks a task: the issue&apos;s context that
          Linear does not show (its milestone and that milestone&apos;s status,
          what blocks it and what it blocks, why the planner gave it to this
          person, how long it has sat in its state). Read-only in the planner;
          every property value is a node, so a host can pass editors instead.
        </p>
      </div>

      <section className="block" aria-labelledby="drawer-title">
        <div className="blockBar">
          <span className="blockKey">01</span>
          <h2 id="drawer-title" className="blockTitle">
            Drawer · TaskSlideOver
          </h2>
        </div>
        <div className={css.controls}>
          <Button
            variant={drawerOpen ? 'primary' : 'secondary'}
            size="sm"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? 'Close drawer' : 'Open drawer'}
          </Button>
          {Object.keys(DRAWER_TASKS).map((key) => (
            <Button
              key={key}
              variant="quiet"
              size="sm"
              aria-pressed={drawerOpen && drawerKey === key}
              onClick={() => openTask(key)}
            >
              {key}
            </Button>
          ))}
        </div>
        <p className={css.note}>
          Esc closes · relation rows with a fixture open here, the rest go to
          Linear · ⌘-click always follows the link
        </p>
      </section>

      <section className="block" aria-labelledby="page-title">
        <div className="blockBar">
          <span className="blockKey">02</span>
          <h2 id="page-title" className="blockTitle">
            Page layout · TaskDetail layout=&quot;page&quot;
          </h2>
          <span className="blockMeta">rail at ≥ 760px of its own width</span>
        </div>
        <div className={css.pageSlot}>
          <TaskDetail
            {...ENG_24}
            layout="page"
            headingLevel={3}
            activityLimit={3}
            headerActions={<HeaderActions taskKey={ENG_24.taskKey} />}
          />
        </div>
      </section>

      <section className="block" aria-labelledby="states-title">
        <div className="blockBar">
          <span className="blockKey">03</span>
          <h2 id="states-title" className="blockTitle">
            States · drawer layout in a pane
          </h2>
        </div>
        <ul className={css.states}>
          {STATES.map((state, i) => {
            const task = state.id === 'error' ? errorTask : state.task;
            return (
              <li key={state.id} className={css.state}>
                <p className={css.stateLabel}>
                  <span className="key">{String(i + 1).padStart(2, '0')}</span>
                  {state.label}
                </p>
                <div className={css.pane}>
                  <TaskDetail
                    {...task}
                    layout="drawer"
                    headingLevel={3}
                    headerActions={<HeaderActions taskKey={task.taskKey} />}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="block" aria-labelledby="editable-title">
        <div className="blockBar">
          <span className="blockKey">04</span>
          <h2 id="editable-title" className="blockTitle">
            Editable host · Dispatch-style composition
          </h2>
          <span className="blockMeta">
            titleControl · status.control · rail · onRemove · content
          </span>
        </div>
        <div className={css.pageSlot}>
          <EditableHostDemo />
        </div>
      </section>

      <TaskSlideOver
        {...drawerTask}
        open={drawerOpen}
        onClose={closeDrawer}
        headerActions={<HeaderActions taskKey={drawerTask.taskKey} />}
      />
    </main>
  );
}

export default function TaskGallery({
  themeToggle,
  initialDrawerOpen = true,
}: {
  themeToggle: ReactNode;
  /** The drawer starts open unless the page says otherwise. */
  initialDrawerOpen?: boolean;
}) {
  return (
    <ToastProvider>
      <UiLinkProvider link={GalleryLink}>
        <GalleryBody
          themeToggle={themeToggle}
          initialDrawerOpen={initialDrawerOpen}
        />
      </UiLinkProvider>
    </ToastProvider>
  );
}
