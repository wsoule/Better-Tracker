'use client';

import {
  BlockBar,
  Button,
  Notice,
  Switch,
  TimelineChart,
  type TimelineGroup,
  type TimelineZoom,
  UiLinkProvider,
  type UiLinkProps,
} from '@better-tracker/ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DEPENDENCIES,
  findMilestone,
  GROUPS,
  redateFixture,
  TODAY,
  WINDOW_END,
  WINDOW_START,
} from './fixtures';
import css from './page.module.css';

// The gallery's router: records where a link would go instead of
// navigating (the app routes need the engine), proving lane names render
// through UiLinkProvider. Modified clicks still behave natively.
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

/* Lanes whose project name matches the query (the toolbar's project
   search), dropping initiatives left empty. */
function filterGroups(groups: TimelineGroup[], query: string): TimelineGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return groups;
  return groups
    .map((g) => ({
      ...g,
      lanes: g.lanes.filter((l) => l.label.toLowerCase().includes(q)),
    }))
    .filter((g) => g.lanes.length > 0);
}

export default function TimelineGallery({
  themeToggle,
}: {
  themeToggle: ReactNode;
}) {
  const [groups, setGroups] = useState(GROUPS);
  const [zoom, setZoom] = useState<TimelineZoom>('weeks');
  const [showDeps, setShowDeps] = useState(true);
  const [rejectSaves, setRejectSaves] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [linked, setLinked] = useState<string | null>(null);
  const rejectRef = useRef(rejectSaves);
  const toggleReject = useCallback((next: boolean) => {
    rejectRef.current = next;
    setRejectSaves(next);
  }, []);

  // The fake PATCH: resolves after 400ms (and the fixture moves), or
  // rejects when "Reject saves" is on so the rollback can be seen.
  const onRedate = useCallback(
    (barId: string, newEnd: string) =>
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (rejectRef.current) {
            reject(new Error('Linear refused the change'));
            return;
          }
          setGroups((prev) => redateFixture(prev, barId, newEnd));
          resolve();
        }, 400);
      }),
    []
  );

  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);
  const opened =
    selected === undefined ? null : findMilestone(groups, selected);

  return (
    <RecordContext.Provider value={setLinked}>
      <UiLinkProvider link={GalleryLink}>
        <main className="page">
          <div className="block">
            <BlockBar
              index="00"
              title="UI gallery · timeline"
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
              <Notice tone="default" label="Try" role="status">
                {linked === null ? (
                  'Drag a bar’s right edge (or focus its handle: ←/→ a day, Shift a week, Enter saves, Esc cancels). Saves resolve after 400ms; turn on “Reject saves” to watch the rollback.'
                ) : (
                  <>
                    Lane link would open{' '}
                    <span className={css.mono}>{linked}</span>
                  </>
                )}
              </Notice>
            </div>
          </div>

          <div className="block">
            <BlockBar
              index="01"
              title="Timeline"
              meta="Wed 21 Oct 2026 · 8 projects · 3 initiatives"
            />
            <TimelineChart
              today={TODAY}
              windowStart={WINDOW_START}
              windowEnd={WINDOW_END}
              zoom={zoom}
              onZoomChange={setZoom}
              groups={visible}
              dependencies={DEPENDENCIES}
              showDependencies={showDeps}
              onShowDependenciesChange={setShowDeps}
              selectedBarId={selected}
              onOpenBar={setSelected}
              onRedate={onRedate}
              maxHeight="calc(100vh - 120px)"
              toolbarStart={
                <input
                  className={`input ${css.search}`}
                  type="search"
                  placeholder="Search projects"
                  aria-label="Search projects"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              }
              toolbarEnd={
                <Switch
                  checked={rejectSaves}
                  onChange={toggleReject}
                  label="Reject saves"
                  note="gallery only"
                />
              }
            />
            <div
              className={css.opened}
              role="status"
              aria-label="Opened milestone"
            >
              <span className={css.openedKey}>Opened</span>
              {opened === null ? (
                <span className={css.openedIdle}>
                  Select a bar or chip: the app opens the slide-over drawer
                </span>
              ) : (
                <>
                  <span className={css.openedName}>
                    {opened.project} / {opened.label}
                  </span>
                  <span className={css.openedDetail}>{opened.detail}</span>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => setSelected(undefined)}
                  >
                    Close
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="block">
            <BlockBar
              index="02"
              title="Read-only · focused lane"
              meta="no onRedate · months · ?project=p-cobalt"
            />
            <TimelineChart
              today={TODAY}
              windowStart={WINDOW_START}
              windowEnd={WINDOW_END}
              zoom="months"
              groups={GROUPS}
              dependencies={DEPENDENCIES}
              defaultShowDependencies={false}
              focusLaneId="p-cobalt"
              onOpenBar={setSelected}
              legend={false}
              label="Read-only timeline"
              maxHeight="420px"
            />
          </div>

          <div className="block">
            <BlockBar index="03" title="Empty" meta="groups: []" />
            <TimelineChart
              today={TODAY}
              windowStart={WINDOW_START}
              windowEnd={WINDOW_END}
              zoom="weeks"
              groups={[]}
              onOpenBar={setSelected}
              legend={false}
              label="Empty timeline"
              emptyLabel="Nothing on the timeline · no active projects with dated milestones"
            />
          </div>
        </main>
      </UiLinkProvider>
    </RecordContext.Provider>
  );
}
