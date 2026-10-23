'use client';

import {
  AlertStrip,
  BlockBar,
  blockerIndex,
  Button,
  Chip,
  type ChipTone,
  defaultGraphLegend,
  DependencyGraph,
  downstreamChain,
  type GraphHighlight,
  type GraphLegendItem,
  GraphLegend,
  type GraphNodeData,
  type GraphPathWords,
  layoutGraph,
  MermaidSource,
  PropertyList,
  SegmentedControl,
  SlideOver,
  StatusMark,
  Switch,
  ToastProvider,
  UiLinkProvider,
  type UiLinkProps,
  upstreamChain,
  useToast,
  waiterIndex,
} from '@better-tracker/ui';
import { type ReactNode, useMemo, useState } from 'react';

import {
  CHAIN_GRAPH,
  EPIC_EDGES,
  EPIC_NODES,
  type GraphFixture,
  GRAPHS,
  LEVELS,
  MILESTONE_GRAPH,
  toMermaid,
} from './fixtures';
import styles from './page.module.css';

/* Gallery links never leave the page: they say where they would have gone.
   Gallery routes and external URLs behave normally. */
function GalleryLink({ href, children, onClick, ...rest }: UiLinkProps) {
  const { toast } = useToast();
  const stays = href.startsWith('#') || href.startsWith('/ui-gallery');
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || stays) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        toast({ kind: 'info', label: 'Link', message: `Would open ${href}.` });
      }}
    >
      {children}
    </a>
  );
}

/* Inline 14px "open" glyph (the gallery imports only from the UI package). */
function OpenGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M9 2.5h4.5V7M13.5 2.5 7 9M12 9.5V13a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 3 13V5a.5.5 0 0 1 .5-.5H7" />
    </svg>
  );
}

function countCycles(fixture: GraphFixture): number {
  return fixture.edges.filter((edge) => edge.kind === 'cycle').length / 2;
}

/* One node in the slide-over's "Waits on" / "Holds up" lists: a row that
   re-selects that node, so the reader can walk the chain from the panel. */
function NodeRow({
  node,
  onSelect,
}: {
  node: GraphNodeData;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={styles.nodeRow}
        onClick={() => onSelect(node.id)}
      >
        {node.status !== undefined ? (
          <StatusMark status={node.status} label={node.statusLabel ?? ''} />
        ) : null}
        <span className={styles.nodeRowName}>{node.label}</span>
        <span className={styles.nodeRowSub}>{node.sublabel}</span>
      </button>
    </li>
  );
}

/* A flag chip's tone: the status hue of what it says (architecture §8.2:
   OVERDUE red, UNASSIGNED amber, both still filled chips, as slabs of the
   hue); CYCLE stays ink, as on the box, and any other flag (+N MORE) keeps
   the filled accent it had. */
function flagTone(tag: string): ChipTone {
  if (tag === 'OVERDUE') return 'danger';
  if (tag === 'UNASSIGNED') return 'warning';
  if (tag === 'CYCLE') return 'default';
  return 'accent';
}

/* The selection panel the /graph page opens: what the node is, what it
   waits on (the same upstream chain the graph lights), what it holds up. */
function SelectionPanel({
  fixture,
  selectedId,
  onSelect,
  onClose,
}: {
  fixture: GraphFixture;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const byId = useMemo(
    () => new Map(fixture.nodes.map((node) => [node.id, node])),
    [fixture]
  );
  const blockers = useMemo(() => blockerIndex(fixture.edges), [fixture]);
  const waiters = useMemo(() => waiterIndex(fixture.edges), [fixture]);
  // Keep the last node while the panel slides out.
  const [shown, setShown] = useState<string | null>(selectedId);
  if (selectedId !== null && selectedId !== shown) setShown(selectedId);
  const node = shown === null ? undefined : byId.get(shown);

  const chain = node === undefined ? null : upstreamChain(node.id, blockers);
  const waitsOn = (chain?.nodeIds ?? [])
    .map((id) => byId.get(id))
    .filter((n): n is GraphNodeData => n !== undefined);
  // What it holds up, transitively (the ink path the canvas lights).
  const holdsUp = (
    node === undefined ? [] : downstreamChain(node.id, waiters).nodeIds
  )
    .map((id) => byId.get(id))
    .filter((n): n is GraphNodeData => n !== undefined);
  const tags = node?.tags ?? [];

  return (
    <SlideOver
      open={selectedId !== null && node !== undefined}
      onClose={onClose}
      title={node?.label ?? ''}
      breadcrumb={node?.group ?? fixture.title}
      actions={
        node?.href !== undefined ? (
          <Button
            href={node.href}
            external={/^https?:/.test(node.href)}
            variant="quiet"
            size="sm"
            icon={<OpenGlyph />}
          >
            Open
          </Button>
        ) : null
      }
    >
      {node === undefined ? null : (
        <div className={styles.panel}>
          {tags.includes('OVERDUE') ? (
            <AlertStrip label="Overdue" tone="danger">
              {holdsUp.length === 0
                ? 'Past its date.'
                : `Past its date, and ${holdsUp.length} ${holdsUp.length === 1 ? 'node waits' : 'nodes wait'} on it.`}
            </AlertStrip>
          ) : null}
          <PropertyList
            label="Node details"
            items={[
              {
                label: 'Status',
                value:
                  node.status !== undefined ? (
                    <StatusMark
                      status={node.status}
                      label={node.statusLabel ?? ''}
                      showLabel
                    />
                  ) : (
                    '—'
                  ),
              },
              { label: 'Context', value: node.sublabel ?? '—' },
              {
                label: 'Flags',
                value:
                  tags.length === 0 && node.external !== true ? (
                    '—'
                  ) : (
                    <span className={styles.chips}>
                      {tags.map((tag) => (
                        <Chip
                          key={tag}
                          tone={flagTone(tag)}
                          filled={tag === 'OVERDUE' || tag === 'UNASSIGNED'}
                        >
                          {tag}
                        </Chip>
                      ))}
                      {node.external === true ? (
                        <Chip tone="muted">External</Chip>
                      ) : null}
                    </span>
                  ),
              },
              {
                label: 'Readiness',
                value:
                  node.readiness === undefined || node.readiness.label === ''
                    ? 'Done'
                    : node.readiness.label,
              },
              {
                label: 'Waits on',
                value: `${waitsOn.length} upstream`,
              },
              { label: 'Holds up', value: `${holdsUp.length} downstream` },
            ]}
          />
          <section className={styles.panelSection} aria-label="Waits on">
            <h3 className={styles.panelKey}>Waits on</h3>
            {waitsOn.length === 0 ? (
              <p className={styles.panelEmpty}>Nothing open upstream.</p>
            ) : (
              <ul className={styles.nodeList}>
                {waitsOn.map((n) => (
                  <NodeRow key={n.id} node={n} onSelect={onSelect} />
                ))}
              </ul>
            )}
          </section>
          <section className={styles.panelSection} aria-label="Holds up">
            <h3 className={styles.panelKey}>Holds up</h3>
            {holdsUp.length === 0 ? (
              <p className={styles.panelEmpty}>Nothing waits on this.</p>
            ) : (
              <ul className={styles.nodeList}>
                {holdsUp.map((n) => (
                  <NodeRow key={n.id} node={n} onSelect={onSelect} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </SlideOver>
  );
}

const EPIC_LEGEND: GraphLegendItem[] = [
  { mark: 'node', label: 'Task' },
  { mark: 'node-warning', label: 'Needs you' },
  { mark: 'node-muted', label: 'Landed' },
  { mark: 'edge-default', label: 'Blocks' },
  { mark: 'edge-risk', label: 'Waits on you' },
  { mark: 'edge-resolved', label: 'Done' },
];

const CHAIN_LEGEND: GraphLegendItem[] = [
  { mark: 'node', label: 'Issue', note: 'blockers sit left of what waits' },
  {
    mark: 'node-focus',
    label: 'Focus',
    note: 'the issue this chain is about',
  },
  { mark: 'node-warning', label: 'Needs action', note: 'open and unassigned' },
  { mark: 'edge-default', label: 'Blocks' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'the blocker is unassigned or overdue, or waits on one',
  },
  { mark: 'edge-cross', label: 'Cross-project', note: 'leaves its project' },
  { mark: 'edge-resolved', label: 'Unblocked', note: 'one end is done' },
];

/** The highlight switch, as the planner's /graph toolbar offers it. */
const HIGHLIGHTS: { id: GraphHighlight; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'risk', label: 'Risk' },
  { id: 'critical', label: 'Critical path' },
];

/** Each highlight's legend for the milestone and issue fixtures. */
const LEGENDS: Record<GraphHighlight, GraphLegendItem[]> = {
  status: [
    { mark: 'node-ready', label: 'Ready', note: 'nothing open blocks it' },
    {
      mark: 'node',
      label: 'No dependencies',
      note: 'it neither blocks nor waits on anything',
    },
    { mark: 'node-blocked', label: 'Blocked', note: 'an open one blocks it' },
    { mark: 'node-stuck', label: 'Stuck', note: 'on a blocking cycle' },
    { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
    { mark: 'node-muted', label: 'Done', note: 'closed' },
    { mark: 'node-external', label: 'External', note: 'outside this scope' },
    { mark: 'edge-default', label: 'Blocks', note: 'the blocker is open' },
    {
      mark: 'edge-unblocked',
      label: 'Unblocked',
      note: 'one end is done: no longer blocking',
    },
    { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
    { mark: 'edge-cross', label: 'Cross-project', note: 'leaves its project' },
    {
      mark: 'path-up',
      label: 'Waits on',
      note: 'what the box you point at waits on',
    },
    { mark: 'path-down', label: 'Holds up', note: 'what waits on it' },
    { mark: 'path-next', label: 'Ready next', note: 'ready once it is done' },
  ],
  risk: defaultGraphLegend,
  critical: [
    {
      mark: 'node-chain',
      label: 'Critical path',
      note: 'numbered in order; each waits on the one before',
    },
    { mark: 'node-faded', label: 'Off the path', note: 'faded' },
    { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
    {
      mark: 'edge-chain',
      label: 'Critical path',
      note: 'the longest chain of open blockers',
    },
    { mark: 'edge-default', label: 'Blocks' },
    { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
    { mark: 'edge-resolved', label: 'Unblocked', note: 'one end is done' },
    {
      mark: 'path-chain',
      label: 'Critical path',
      note: 'through the box you point at',
    },
  ],
};

/** The milestone fixture's boxes are cleared, not unblocked (the
    planner's aggregate words). */
const BOX_WORDS: Partial<GraphPathWords> = {
  unit: ['milestone', 'milestones'],
  waitsOn: 'Waits on {n}',
  waitsOnNone: 'Nothing outside it holds it up',
  unblock: 'Finishing it would clear {n}: {names}',
  next: 'Clear next',
  done: 'Complete',
};
const ISSUE_WORDS: Partial<GraphPathWords> = { unit: ['issue', 'issues'] };

/** The Status legend's box rows in the milestone fixture's words. */
const BOX_STATUS_LEGEND: GraphLegendItem[] = LEGENDS.status.map((item) =>
  item.mark === 'node-ready'
    ? { ...item, label: 'Clear', note: 'nothing outside it holds it up' }
    : item.mark === 'node-blocked'
      ? { ...item, label: 'Waiting', note: 'it waits on another milestone' }
      : item.mark === 'path-next'
        ? { ...item, label: 'Clear next', note: 'clear once it is finished' }
        : item
);

/** The frames' swatches, as the planner's legends end their Nodes row. */
const FRAME_LEGEND: GraphLegendItem[] = [
  { mark: 'cluster', label: 'Project', note: 'a frame of its boxes' },
];

/** The legend of a fixture in a highlight (boxes say clear / waiting),
    with the frames' swatch while they are drawn. */
function legendOf(
  fixture: GraphFixture,
  highlight: GraphHighlight,
  frames: boolean
) {
  const items =
    highlight === 'status' && fixture === MILESTONE_GRAPH
      ? BOX_STATUS_LEGEND
      : LEGENDS[highlight];
  return frames ? [...items, ...FRAME_LEGEND] : items;
}

/** The idle readout per highlight: readiness counts, or a plain line. */
function idleReadout(fixture: GraphFixture, highlight: GraphHighlight) {
  if (highlight === 'risk') {
    const risk = fixture.edges.filter((edge) => edge.kind === 'risk').length;
    return `${risk} on a risk chain · ${countCycles(fixture)} cycle`;
  }
  if (highlight === 'critical') return 'The longest open chain is numbered.';
  const count = (state: string) =>
    fixture.nodes.filter((node) => node.readiness?.state === state).length;
  const boxes = fixture === MILESTONE_GRAPH;
  return [
    [count('ready'), boxes ? 'clear' : 'ready'],
    [count('blocked'), boxes ? 'waiting' : 'blocked'],
    [count('independent'), 'with no dependencies'],
    [count('done'), boxes ? 'complete' : 'done'],
  ]
    .filter(([n]) => n !== 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ');
}

/* Laid out once at module load and handed over through `layout`, as the
   planner's server render does: the component then runs no dagre. */
const CHAIN_LAYOUT = layoutGraph(CHAIN_GRAPH.nodes, CHAIN_GRAPH.edges, {
  direction: 'LR',
});

function Gallery({ themeToggle }: { themeToggle: ReactNode }) {
  const { toast } = useToast();
  const [level, setLevel] = useState(MILESTONE_GRAPH.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // On by default, as the planner draws every graph but a chain framed.
  const [frames, setFrames] = useState(true);
  const [highlight, setHighlight] = useState<GraphHighlight>('status');
  const fixture = GRAPHS[level] ?? MILESTONE_GRAPH;
  const mermaid = useMemo(
    () => toMermaid(fixture, highlight, frames ? fixture.clusters : []),
    [fixture, highlight, frames]
  );
  const highlightSwitch = (
    <SegmentedControl
      label="Highlight"
      size="sm"
      options={HIGHLIGHTS}
      value={highlight}
      onChange={(id) => {
        const next = HIGHLIGHTS.find((option) => option.id === id);
        if (next !== undefined) setHighlight(next.id);
      }}
    />
  );

  return (
    <main className={`page ${styles.page}`}>
      <div className="block">
        <BlockBar
          index="00"
          title="UI gallery · graph"
          meta={
            <span className={styles.barMeta}>
              <a className="accentLink" href="/ui-gallery">
                All families
              </a>
              {themeToggle}
            </span>
          }
        />
      </div>

      <section className="block" aria-labelledby="graph-page">
        <BlockBar
          index="01"
          title="Dependencies"
          meta={`${fixture.nodes.length} nodes · ${fixture.edges.length} edges · ${countCycles(fixture)} cycle`}
        />
        <h2 id="graph-page" className="srOnly">
          Dependency graph, {fixture.title}
        </h2>
        <GraphLegend
          items={legendOf(fixture, highlight, frames)}
          label={`Graph legend: ${HIGHLIGHTS.find((h) => h.id === highlight)?.label ?? ''}`}
        />
        <DependencyGraph
          nodes={fixture.nodes}
          edges={fixture.edges}
          highlight={highlight}
          readout={idleReadout(fixture, highlight)}
          pathWords={fixture === MILESTONE_GRAPH ? BOX_WORDS : ISSUE_WORDS}
          selectedId={selectedId}
          onSelect={(id) =>
            setSelectedId((current) => (current === id ? null : id))
          }
          ariaSummary={fixture.ariaSummary}
          emptyMessage={fixture.emptyMessage}
          clusters={frames ? fixture.clusters : undefined}
          toolbar={
            <>
              <SegmentedControl
                label="Graph level"
                size="sm"
                options={LEVELS}
                value={level}
                onChange={(id) => {
                  setLevel(id);
                  setSelectedId(null);
                }}
              />
              {highlightSwitch}
              <Switch
                label="Frames"
                note="by project and milestone"
                checked={frames}
                onChange={setFrames}
              />
            </>
          }
        />
        <MermaidSource
          source={mermaid}
          onCopy={(ok) =>
            toast(
              ok
                ? {
                    kind: 'info',
                    label: 'Copied',
                    message: 'The Mermaid source is on your clipboard.',
                  }
                : {
                    kind: 'error',
                    label: 'Copy failed',
                    message: 'The browser refused; the source is selected.',
                  }
            )
          }
        />
      </section>

      <section className="block" aria-labelledby="graph-epic">
        <BlockBar
          index="02"
          title="Read-only · top to bottom"
          meta="Dispatch epic shape · no selection · focus still lights the chain"
        />
        <h2 id="graph-epic" className="srOnly">
          A read-only epic graph, top to bottom
        </h2>
        <GraphLegend items={EPIC_LEGEND} label="Epic graph legend" />
        <DependencyGraph
          nodes={EPIC_NODES}
          edges={EPIC_EDGES}
          highlight={highlight}
          direction="TB"
          ariaSummary="Epic graph of 5 tasks: the client queue needs you and holds up conflict resolution, which holds up shipping behind a flag."
          emptyMessage="No tasks yet."
          hint={null}
        />
      </section>

      <section className="block" aria-labelledby="graph-chain">
        <BlockBar
          index="03"
          title="Chain · focus"
          meta="One issue's chain · focusId ruled · +2 MORE leads on · precomputed layout"
        />
        <h2 id="graph-chain" className="srOnly">
          {CHAIN_GRAPH.title}
        </h2>
        <GraphLegend items={CHAIN_LEGEND} label="Chain graph legend" />
        <DependencyGraph
          nodes={CHAIN_GRAPH.nodes}
          edges={CHAIN_GRAPH.edges}
          layout={CHAIN_LAYOUT}
          highlight={highlight}
          pathWords={ISSUE_WORDS}
          toolbar={highlightSwitch}
          focusId={CHAIN_GRAPH.focusId}
          focusLabel="the issue this chain is about"
          ariaSummary={CHAIN_GRAPH.ariaSummary}
          emptyMessage={CHAIN_GRAPH.emptyMessage}
        />
      </section>

      <section className="block" aria-labelledby="graph-empty">
        <BlockBar index="04" title="Empty" meta="emptyMessage" />
        <h2 id="graph-empty" className="srOnly">
          Empty graph
        </h2>
        <DependencyGraph
          nodes={[]}
          edges={[]}
          ariaSummary="Empty dependency graph."
          emptyMessage="No milestone waits on another. Nothing to draw."
        />
      </section>

      <SelectionPanel
        fixture={fixture}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onClose={() => setSelectedId(null)}
      />
    </main>
  );
}

export default function GraphGallery({
  themeToggle,
}: {
  themeToggle: ReactNode;
}) {
  return (
    <ToastProvider>
      <UiLinkProvider link={GalleryLink}>
        <Gallery themeToggle={themeToggle} />
      </UiLinkProvider>
    </ToastProvider>
  );
}
