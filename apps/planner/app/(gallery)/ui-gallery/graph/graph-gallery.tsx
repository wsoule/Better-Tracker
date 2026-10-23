'use client';

import {
  AlertStrip,
  BlockBar,
  blockerIndex,
  Button,
  Chip,
  DependencyGraph,
  type GraphLegendItem,
  GraphLegend,
  type GraphNodeData,
  layoutGraph,
  MermaidSource,
  PropertyList,
  SegmentedControl,
  SlideOver,
  StateGlyph,
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

/* A node's key and sublabel as one quiet line ("ATL-43 · Ana"), or a
   dash when it has neither. */
function contextOf(node: GraphNodeData): string {
  const line = [node.key, node.sublabel]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');
  return line === '' ? '—' : line;
}

/* One node in the slide-over's "Waits on" / "Blocks" lists: a row that
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
        {node.state !== undefined ? (
          <span role="img" aria-label={node.statusLabel ?? ''}>
            <StateGlyph kind={node.state} size={14} />
          </span>
        ) : node.status !== undefined ? (
          <StatusMark status={node.status} label={node.statusLabel ?? ''} />
        ) : (
          <span />
        )}
        <span className={styles.nodeRowName}>{node.label}</span>
        <span className={styles.nodeRowSub}>
          {[node.key, node.sublabel]
            .filter((part) => part !== undefined && part !== '')
            .join(' · ')}
        </span>
      </button>
    </li>
  );
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
  const holdsUp = (node === undefined ? [] : (waiters.get(node.id) ?? []))
    .map((edge) => byId.get(edge.to))
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
          {node.tone === 'danger' ? (
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
                  node.state !== undefined ? (
                    <span className={styles.stateValue}>
                      <StateGlyph kind={node.state} size={14} />
                      {node.statusLabel ?? ''}
                    </span>
                  ) : node.status !== undefined ? (
                    <StatusMark
                      status={node.status}
                      label={node.statusLabel ?? ''}
                      showLabel
                    />
                  ) : (
                    '—'
                  ),
              },
              { label: 'Context', value: contextOf(node) },
              {
                label: 'Flags',
                value:
                  tags.length === 0 && node.external !== true ? (
                    '—'
                  ) : (
                    <span className={styles.chips}>
                      {tags.map((tag) => (
                        <Chip key={tag.label} tone={tag.tone ?? 'default'}>
                          {tag.label}
                        </Chip>
                      ))}
                      {node.external === true ? (
                        <Chip tone="muted">External</Chip>
                      ) : null}
                    </span>
                  ),
              },
              {
                label: 'Waits on',
                value: `${waitsOn.length} upstream`,
              },
              { label: 'Blocks', value: `${holdsUp.length} directly` },
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
          <section className={styles.panelSection} aria-label="Blocks">
            <h3 className={styles.panelKey}>Blocks</h3>
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
  { mark: 'status', status: 'done', label: 'Landed' },
  { mark: 'status', status: 'on_track', label: 'Working, ready' },
  { mark: 'status', status: 'at_risk', label: 'Needs you' },
  { mark: 'status', status: 'missing', label: 'Draft' },
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
  { mark: 'edge-resolved', label: 'Resolved', note: 'blocker closed' },
];

/* Laid out once at module load and handed over through `layout`, as the
   planner's server render does: the component then runs no dagre. */
const CHAIN_LAYOUT = layoutGraph(CHAIN_GRAPH.nodes, CHAIN_GRAPH.edges, {
  direction: 'LR',
});

function Gallery({ themeToggle }: { themeToggle: ReactNode }) {
  const { toast } = useToast();
  const [level, setLevel] = useState(MILESTONE_GRAPH.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frames, setFrames] = useState(false);
  const fixture = GRAPHS[level] ?? MILESTONE_GRAPH;
  const mermaid = useMemo(() => toMermaid(fixture), [fixture]);

  return (
    <main className={`page ${styles.page}`}>
      <div className="block">
        <BlockBar
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

      <section className={`block ${styles.stack}`} aria-labelledby="graph-page">
        <BlockBar
          title="Dependencies"
          meta={`${fixture.nodes.length} nodes · ${fixture.edges.length} edges · ${countCycles(fixture)} cycle`}
        />
        <h2 id="graph-page" className="srOnly">
          Dependency graph, {fixture.title}
        </h2>
        <GraphLegend className={styles.legend} />
        <DependencyGraph
          nodes={fixture.nodes}
          edges={fixture.edges}
          selectedId={selectedId}
          onSelect={(id) =>
            setSelectedId((current) => (current === id ? null : id))
          }
          ariaSummary={fixture.ariaSummary}
          emptyMessage={fixture.emptyMessage}
          cluster={frames}
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
              <Switch
                label="Frames"
                note="group by project"
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

      <section className={`block ${styles.stack}`} aria-labelledby="graph-epic">
        <BlockBar
          title="Read-only, top to bottom"
          meta="Dispatch epic shape · no selection · focus still lights the chain"
        />
        <h2 id="graph-epic" className="srOnly">
          A read-only epic graph, top to bottom
        </h2>
        <GraphLegend
          className={styles.legend}
          items={EPIC_LEGEND}
          label="Epic graph legend"
        />
        <DependencyGraph
          nodes={EPIC_NODES}
          edges={EPIC_EDGES}
          direction="TB"
          ariaSummary="Epic graph of 5 tasks: the client queue needs you and holds up conflict resolution, which holds up shipping behind a flag."
          emptyMessage="No tasks yet."
          hint={null}
        />
      </section>

      <section
        className={`block ${styles.stack}`}
        aria-labelledby="graph-chain"
      >
        <BlockBar
          title="Chain and focus"
          meta="One issue’s chain · focusId ringed · “+2 more” leads on · precomputed layout"
        />
        <h2 id="graph-chain" className="srOnly">
          {CHAIN_GRAPH.title}
        </h2>
        <GraphLegend
          className={styles.legend}
          items={CHAIN_LEGEND}
          label="Chain graph legend"
        />
        <DependencyGraph
          nodes={CHAIN_GRAPH.nodes}
          edges={CHAIN_GRAPH.edges}
          layout={CHAIN_LAYOUT}
          focusId={CHAIN_GRAPH.focusId}
          focusLabel="the issue this chain is about"
          ariaSummary={CHAIN_GRAPH.ariaSummary}
          emptyMessage={CHAIN_GRAPH.emptyMessage}
        />
      </section>

      <section
        className={`block ${styles.stack}`}
        aria-labelledby="graph-empty"
      >
        <BlockBar title="Empty" meta="emptyMessage" />
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
