'use client';

import {
  BlockBar,
  Button,
  TaskDetail,
  type TaskRelation,
  TaskSlideOver,
  ToastProvider,
  UiLinkProvider,
  type UiLinkProps,
  useToast,
} from '@better-tracker/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { EditableTaskDemo, EditControlsDemo } from './editable-task';
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

function GalleryBody({
  themeToggle,
  initialDrawerOpen,
}: {
  themeToggle: ReactNode;
  initialDrawerOpen: boolean;
}) {
  const [drawerKey, setDrawerKey] = useState('ENG-24');
  const [drawerOpen, setDrawerOpen] = useState(initialDrawerOpen);
  // Block 04's drawer: opening either one closes the other.
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const errorTask = useRetryingDescription();

  const openTask = useCallback((key: string) => {
    setDrawerKey(key);
    setDrawerOpen(true);
    setEditDrawerOpen(false);
  }, []);
  const toggleEditDrawer = useCallback((open: boolean) => {
    setEditDrawerOpen(open);
    if (open) setDrawerOpen(false);
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
          person, how long it has sat in its state). Every property value is a
          node: read-only here, or the edit controls (block 04), which save
          through the host with the signed-in person&apos;s own token.
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
            onClick={() => {
              setDrawerOpen((open) => !open);
              setEditDrawerOpen(false);
            }}
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
            Editable task · the edit controls
          </h2>
          <span className="blockMeta">
            titleControl · status.control · pickers · sectionMeta · comments
          </span>
        </div>
        <EditableTaskDemo
          headerActions={(key) => <HeaderActions taskKey={key} />}
          drawer={editDrawerOpen}
          setDrawer={toggleEditDrawer}
        />
      </section>

      <section className="block" aria-labelledby="controls-title">
        <div className="blockBar">
          <span className="blockKey">05</span>
          <h2 id="controls-title" className="blockTitle">
            Edit controls · states
          </h2>
          <span className="blockMeta">
            loading · failed · disabled · search · limits
          </span>
        </div>
        <EditControlsDemo />
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
