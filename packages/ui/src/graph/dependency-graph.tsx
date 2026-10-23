'use client';

import { Maximize, Minus, Plus } from 'lucide-react';
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Link } from '../lib/link';
import { cx } from '../tasks/class-names';
import styles from './dependency-graph.module.css';
import { CLUSTER_METRICS, edgeKey, layoutGraph } from './layout';
import {
  describePaths,
  longestChain,
  nodePaths,
  type PathNameCounts,
  pathContext,
  pathNameCounts,
  pathNamePhrase,
  resolvePathWords,
} from './paths';
import type {
  DependencyGraphProps,
  GraphClusterData,
  GraphEdgeKind,
  GraphHighlight,
  GraphLayout,
  GraphNodeData,
  GraphNodeTone,
  LaidOutEdge,
  LaidOutGroup,
  LaidOutNode,
} from './types';

// Zoom bounds and steps. Buttons and keys step by a fixed factor; ctrl /
// cmd + wheel (and trackpad pinch, which browsers report as ctrl + wheel)
// zooms continuously around the pointer.
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const ZOOM_STEP = 1.2;
const WHEEL_RATE = 0.0025;
const FIT_PADDING = 16;
/** Pointer travel (px) before a press on the background becomes a pan. */
const PAN_THRESHOLD = 3;
/** The least frame width (px) a host's right-hand panel must leave
    uncovered for the graph to keep room beside it (coveredRight). */
const MIN_UNCOVERED = 240;

/**
 * How many px at the frame's right a panel of `width` px, fixed along the
 * window's right edge, covers: 0 for no panel, for one that misses the
 * frame, or for one that would leave less than MIN_UNCOVERED of it (a
 * phone's full-width sheet, where moving the drawing helps nobody).
 */
function coveredPart(viewport: HTMLElement, width: number): number {
  if (width <= 0) return 0;
  const frame = viewport.getBoundingClientRect();
  const panelLeft = window.innerWidth - Math.min(width, window.innerWidth);
  const covered = Math.max(0, frame.right - Math.max(panelLeft, frame.left));
  return viewport.clientWidth - covered >= MIN_UNCOVERED
    ? Math.round(covered)
    : 0;
}

/**
 * The boxes a framed drawing opens on: those of the top-level frame that
 * holds the first box in reading order (layoutGraph lists a clustered
 * layout's boxes frame by frame, and packs the frames from the top-left),
 * or, when that box sits in no frame, the loose boxes at the top level.
 */
function firstFrameNodes(layout: GraphLayout): readonly LaidOutNode[] {
  const first = layout.nodes[0];
  if (first === undefined) return [];
  const within = (n: LaidOutNode, g: LaidOutGroup) =>
    n.x >= g.x &&
    n.y >= g.y &&
    n.x + n.width <= g.x + g.width &&
    n.y + n.height <= g.y + g.height;
  const tops = layout.groups.filter(
    (g) => g.kind === 'cluster' && (g.depth ?? 0) === 0
  );
  const frame = tops.find((g) => within(first, g));
  return frame === undefined
    ? layout.nodes.filter((n) => !tops.some((g) => within(n, g)))
    : layout.nodes.filter((n) => within(n, frame));
}

/**
 * Where a graph with nothing to centre on (no focus, no selection) opens,
 * as frame scroll offsets at zoom `k`. dagre leaves empty space around a
 * layered drawing, so a big graph scrolled to (0, 0) can show no box at
 * all. In an unframed drawing blockers sit left of what waits (above it,
 * top-down), so the flow starts at the drawing's first layer: the frame
 * stays at the start of the flow axis and slides along the other axis to
 * the band, starting at a box, where the most boxes of that first
 * frame-length show whole (the earliest such band on a tie). A framed
 * drawing (`clustered`) opens on its first frame instead, which the
 * packing puts at the top-left: it stays at (0, 0) while that frame shows
 * a box whole there, and otherwise slides to the band of that frame's own
 * boxes, never to a later frame. Null, so nothing moves, when the frame
 * has no size, the drawing fits it across, or no box fits its flow length.
 */
function openingScroll(
  layout: GraphLayout,
  horizontal: boolean,
  frameWidth: number,
  frameHeight: number,
  k: number
): { left: number; top: number } | null {
  const flowLength = horizontal ? frameWidth : frameHeight;
  const crossLength = horizontal ? frameHeight : frameWidth;
  if (flowLength <= 0 || crossLength <= 0) return null;
  let crossExtent = 0;
  for (const n of layout.nodes) {
    crossExtent = Math.max(
      crossExtent,
      (horizontal ? n.y + n.height : n.x + n.width) * k
    );
  }
  if (crossExtent <= crossLength) return null;
  const framed = layout.clustered === true;
  // The candidate boxes whole along the flow from its start, as
  // cross-axis spans.
  const spans: { start: number; end: number }[] = [];
  for (const n of framed ? firstFrameNodes(layout) : layout.nodes) {
    const start = (horizontal ? n.y : n.x) * k;
    const end = start + (horizontal ? n.height : n.width) * k;
    const flowEnd = (horizontal ? n.x + n.width : n.y + n.height) * k;
    if (flowEnd <= flowLength) spans.push({ start, end });
  }
  if (spans.length === 0) return null;
  // The first frame already shows a box whole at the origin.
  if (framed && spans.some((s) => s.end <= crossLength)) return null;
  // Each band starts just above (left of) one of those boxes.
  let best = Number.POSITIVE_INFINITY;
  let bestCount = 0;
  for (const band of spans) {
    const offset = Math.max(0, band.start - FIT_PADDING);
    let count = 0;
    for (const s of spans) {
      if (s.start >= offset && s.end <= offset + crossLength) count += 1;
    }
    if (count > bestCount || (count === bestCount && offset < best)) {
      best = offset;
      bestCount = count;
    }
  }
  // No box fits across the frame whole: show the start of the first one.
  if (bestCount === 0) {
    best = Math.max(0, Math.min(...spans.map((s) => s.start)) - FIT_PADDING);
  }
  const cross = Math.round(best);
  return horizontal ? { left: 0, top: cross } : { left: cross, top: 0 };
}

const EDGE_WORDS: Record<GraphEdgeKind, string> = {
  default: 'blocks',
  risk: 'blocks, on a risk chain',
  cycle: 'blocks, in a cycle',
  cross: 'blocks, across projects',
  resolved: 'no longer blocks',
};

const EDGE_CLASS: Record<GraphEdgeKind, string | undefined> = {
  default: styles.edgeDefault,
  risk: styles.edgeRisk,
  cycle: styles.edgeCycle,
  cross: styles.edgeCross,
  resolved: styles.edgeResolved,
};

/** A node or edge while paths are shown: the node being read, what it
    waits on (lit), what it holds up (down), on the critical path shown
    (chain), or receding (dim). */
type HighlightState = 'active' | 'lit' | 'down' | 'chain' | 'dim';

const STATE_CLASS: Record<HighlightState, string | undefined> = {
  active: styles.active,
  lit: styles.lit,
  down: styles.down,
  chain: styles.chain,
  dim: styles.dim,
};

/** Overlay paint order: what it holds up, then what it waits on (an edge
    walked both ways is drawn as upstream), then the critical path. */
const OVERLAY_ORDER: readonly HighlightState[] = ['down', 'lit', 'chain'];

/**
 * The tone a node is drawn in under `highlight`: Status takes the host's
 * readiness tone (else its `tone`), Risk its `tone`, and Critical keeps
 * only closed or paused work faint, so the numbered path is all that
 * stands out.
 */
function shownTone(
  node: GraphNodeData,
  highlight: GraphHighlight
): GraphNodeTone {
  if (highlight === 'status') return node.readiness?.tone ?? node.tone;
  if (highlight === 'critical') {
    return node.tone === 'muted' || node.readiness?.tone === 'muted'
      ? 'muted'
      : 'default';
  }
  return node.tone;
}

// useLayoutEffect warns nowhere in React 19, but it never runs on the
// server; the alias keeps intent clear for hosts that render there.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** True when a key press belongs to a text field, not to the graph. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * The labels of the frames each node sits in, innermost first ("Beta",
 * "Orion"), from the graph's clusters: what a sighted reader gets from the
 * frame around a box. A parent chain that loops back stops where it
 * repeats.
 */
function frameLabels(
  nodes: readonly GraphNodeData[],
  clusters: readonly GraphClusterData[] | undefined
): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  if (clusters === undefined || clusters.length === 0) return labels;
  const byId = new Map<string, GraphClusterData>();
  for (const cluster of clusters) {
    if (!byId.has(cluster.id)) byId.set(cluster.id, cluster);
  }
  for (const node of nodes) {
    const path: string[] = [];
    const seen = new Set<string>();
    let id = node.cluster;
    while (id !== undefined && !seen.has(id)) {
      const cluster = byId.get(id);
      if (cluster === undefined) break;
      seen.add(id);
      path.push(cluster.label);
      id = cluster.parent;
    }
    if (path.length > 0) labels.set(node.id, path);
  }
  return labels;
}

/**
 * The next box from `current` for an arrow key in a clustered layout,
 * where columns are per frame rather than global: the nearest box whose
 * centre lies that way, a step straight along the key's axis counting
 * half as much as one across it. Null when nothing lies that way.
 */
function nearestThatWay(
  nodes: readonly LaidOutNode[],
  current: LaidOutNode,
  key: string
): LaidOutNode | null {
  const dirs: Record<string, [number, number]> = {
    ArrowRight: [1, 0],
    ArrowLeft: [-1, 0],
    ArrowDown: [0, 1],
    ArrowUp: [0, -1],
  };
  const dir = dirs[key];
  if (dir === undefined) return null;
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  let best: LaidOutNode | null = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    if (n === current) continue;
    const dx = n.x + n.width / 2 - cx;
    const dy = n.y + n.height / 2 - cy;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 1) continue;
    const across = Math.abs(dx * dir[1] + dy * dir[0]);
    const score = along + across * 2;
    if (score < bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The sentence a screen reader hears on a node: name, context, status,
 * its readiness word and flags, scope, how many nodes it waits on and
 * holds up over the drawn edges (transitive within PATH_NAME_BUDGET, else
 * direct) and what finishing it would unblock, its step on the critical
 * path shown at rest (Critical only), and last the focus words when the
 * graph is about this node. Computed once per edge list, so it never
 * changes under the reader's focus.
 */
function nodeName(
  node: GraphNodeData,
  counts: PathNameCounts | undefined,
  step: { k: number; s: number } | null,
  focusWords: string | null,
  frames: readonly string[] = []
): string {
  const parts = [node.label];
  if (node.sublabel !== undefined && node.sublabel !== '') {
    parts.push(node.sublabel);
  }
  if (frames.length > 0) parts.push(`in ${frames.join(', ')}`);
  if (node.statusLabel !== undefined && node.statusLabel !== '') {
    parts.push(node.statusLabel);
  }
  const flags = [node.readiness?.label ?? '', ...(node.tags ?? [])].filter(
    (flag) => flag !== ''
  );
  if (flags.length > 0) {
    parts.push(flags.map((flag) => flag.toLowerCase()).join(', '));
  }
  if (node.external === true) parts.push('outside this scope');
  parts.push(
    pathNamePhrase(
      counts ?? { transitive: true, waitsOn: 0, holdsUp: 0, unblocks: 0 }
    )
  );
  if (step !== null) {
    parts.push(`step ${step.k} of ${step.s} on the critical path`);
  }
  if (focusWords !== null && focusWords !== '') parts.push(focusWords);
  return `${parts.join('. ')}.`;
}

/** The ids of edges marked `cross`, keyed as drawn (the first of a
    repeated pair wins, layoutGraph's rule). */
function crossKeysOf(edges: DependencyGraphProps['edges']): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    if (edge.cross === true) keys.add(key);
  }
  return keys;
}

/**
 * True when a press on the frame landed on its own scrollbar. Browsers
 * report that press to the page but may never send the matching
 * pointerup, so it must not start a pan.
 */
function onScrollbar(
  viewport: HTMLElement,
  event: ReactPointerEvent<HTMLDivElement>
): boolean {
  if (event.target !== viewport) return false;
  const { offsetX, offsetY } = event.nativeEvent;
  return (
    (viewport.clientWidth > 0 && offsetX >= viewport.clientWidth) ||
    (viewport.clientHeight > 0 && offsetY >= viewport.clientHeight)
  );
}

/**
 * Next node for a key: Home/End jump to the first/last box in focus
 * order; along the rank axis an arrow jumps to the nearest box (by centre)
 * in the neighbouring rank; across it, it steps within the rank. In a
 * clustered layout an arrow moves to the nearest box that way instead
 * (nearestThatWay).
 */
function neighbour(
  nodes: readonly LaidOutNode[],
  current: LaidOutNode,
  key: string,
  horizontal: boolean,
  clustered = false
): LaidOutNode | null {
  if (key === 'Home') return nodes[0] ?? null;
  if (key === 'End') return nodes[nodes.length - 1] ?? null;
  if (clustered) return nearestThatWay(nodes, current, key);
  const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
  const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
  const down = horizontal ? 'ArrowDown' : 'ArrowRight';
  const up = horizontal ? 'ArrowUp' : 'ArrowLeft';
  const cross = (n: LaidOutNode) =>
    horizontal ? n.y + n.height / 2 : n.x + n.width / 2;
  if (key === down || key === up) {
    const rank = nodes.filter((n) => n.rank === current.rank);
    const at = rank.indexOf(current);
    return rank[at + (key === down ? 1 : -1)] ?? null;
  }
  if (key !== forward && key !== back) return null;
  const step = key === forward ? 1 : -1;
  let rank = current.rank + step;
  const last = nodes.length === 0 ? 0 : nodes[nodes.length - 1].rank;
  while (rank >= 0 && rank <= last) {
    let best: LaidOutNode | null = null;
    let bestDistance = Infinity;
    for (const n of nodes) {
      if (n.rank !== rank) continue;
      const distance = Math.abs(cross(n) - cross(current));
      if (distance < bestDistance) {
        best = n;
        bestDistance = distance;
      }
    }
    if (best !== null) return best;
    rank += step;
  }
  return null;
}

/**
 * A dependency graph drawn as a technical figure: hairline boxes with mono
 * labels, blockers on the left (or top), 1px edges with small arrowheads,
 * dashes for project crossings, dots for what no longer blocks. The
 * `highlight` picks the emphasis: `risk` (default) the status hues for
 * risk (amber chains, dashed red cycles, a red flood for overdue, a 2px
 * rule in the node's tone); `status` each node's readiness (a 1px green
 * edge when ready, the 2px amber rule when blocked, red when stuck) and
 * green dots for unblocked edges; `critical` the numbered critical path
 * with the rest receding. The purple accent is never a status here: it is
 * the hover flood, the keyboard focus and the upstream path.
 *
 * - Hover, focus, a touch tap or a selection on a node lights both paths:
 *   what it transitively waits on (accent rings and lines) and what waits
 *   on it (ink rings and lines), with a square tag on what finishing it alone
 *   would unblock; the rest dims, its words and status marks still
 *   legible. Under `critical` it lights the longest chain through it. The
 *   readout line under the drawing says the same in words.
 * - On a touch screen the first tap on a node traces it (a pin) and a
 *   second tap opens it; a tap on the background or Escape drops the pin.
 *   Mouse, pen, keyboard and assistive-tech activation open at once.
 * - Nodes are buttons in rank order behind one Tab stop (a roving
 *   tabindex: the last node focused, else the selected one, else the
 *   first). Enter selects (onSelect); arrows move between neighbouring
 *   boxes, Home/End to the first/last.
 * - The frame is a hairline box that scrolls inside itself: drag the
 *   background to pan, ctrl/cmd + wheel or the −/+/FIT buttons (or the
 *   - + 0 keys) to zoom. A plain wheel scrolls as usual and the page never
 *   loses its scroll.
 * - Screen readers get the summary sentence on the drawing and a hidden
 *   table of every edge.
 * - `focusId` marks the node the graph is about with an inner ink rule
 *   (it lights nothing); the first paint scrolls the frame so that node,
 *   else the selected one, sits in the middle (of the part a host's open
 *   right-hand panel leaves uncovered, `coveredRight`).
 * - `layout` takes a layout the host already computed (e.g. on the
 *   server), so the client never runs dagre.
 */
export function DependencyGraph({
  nodes,
  edges,
  selectedId = null,
  onSelect,
  ariaSummary,
  emptyMessage,
  direction = 'LR',
  cluster,
  clusters,
  toolbar,
  hint = 'Drag to pan · Ctrl + wheel to zoom',
  layout: givenLayout,
  focusId = null,
  focusLabel = 'focus',
  coveredRight,
  highlight = 'risk',
  readout,
  pathWords,
  className,
}: DependencyGraphProps): ReactNode {
  // A host-computed layout is used as is; dagre runs only without one.
  const layout = useMemo(
    () =>
      givenLayout ??
      layoutGraph(nodes, edges, { direction, cluster, clusters }),
    [givenLayout, nodes, edges, direction, cluster, clusters]
  );
  const framesOf = useMemo(
    () => frameLabels(nodes, clusters),
    [nodes, clusters]
  );
  const horizontal = layout.direction === 'LR';
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // The drawn graph indexed once per node and edge list: the path walks,
  // the critical-path facts and every node's name counts.
  const ctx = useMemo(() => pathContext(nodes, edges), [nodes, edges]);
  const nameCounts = useMemo(() => pathNameCounts(ctx), [ctx]);
  const crossKeys = useMemo(() => crossKeysOf(edges), [edges]);
  const words = useMemo(() => resolvePathWords(pathWords), [pathWords]);
  const drawn = (id: string | null): string | null =>
    id !== null && byId.has(id) ? id : null;

  const [hoverId, setHoverId] = useState<string | null>(null);
  // The node holding keyboard focus (not the `focusId` prop, which names
  // the node the whole graph is about).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // A touch tap's pin: the first tap on a node traces it without opening.
  const [pinId, setPinId] = useState<string | null>(null);
  // The node a touch press went down on, until its click (or a cancel,
  // which a scroll sends) reads it: only a real touch press pins.
  const pendingTouch = useRef<string | null>(null);
  const pinnedId = drawn(pinId);
  // A touch press focuses the node in Chromium: that focus is the tap's,
  // not the keyboard's, so it never lights the paths on its own (the pin
  // does), and Escape dropping the pin clears the trace.
  const touchFocus = useRef<string | null>(null);
  // The node the reader is on right now (pointer, keyboard focus, touch
  // pin): drawn with the accent flood on every input, unlike a selection
  // or a chain's focus, which light their paths at rest.
  const pointedId =
    [hoverId, focusedId, pinnedId].find((id) => drawn(id) !== null) ?? null;
  // The node whose paths are lit: hover, else keyboard focus, else the
  // touch pin, else the selection; under Critical, else the chain's focus.
  const activeId =
    [
      hoverId,
      focusedId,
      pinnedId,
      selectedId,
      highlight === 'critical' ? focusId : null,
    ].find((id) => drawn(id) !== null) ?? null;
  const paths = useMemo(
    () =>
      activeId === null || highlight === 'critical'
        ? null
        : nodePaths(activeId, ctx),
    [activeId, highlight, ctx]
  );
  const nextIds = useMemo(() => new Set(paths?.next ?? []), [paths]);
  // Critical: the chain through the active node, else the graph-wide one.
  const shownChain = useMemo(
    () =>
      highlight !== 'critical' ? null : longestChain(ctx.chains, activeId),
    [highlight, ctx, activeId]
  );
  // The chain the names count steps on: the one shown at rest (through
  // the selection, else the focus, else graph-wide), so a name never
  // changes under hover.
  const restId = drawn(selectedId) ?? drawn(focusId);
  const nameChain = useMemo(
    () => (highlight !== 'critical' ? null : longestChain(ctx.chains, restId)),
    [highlight, ctx, restId]
  );
  const showing =
    highlight === 'critical'
      ? activeId !== null || shownChain !== null
      : paths !== null;

  /** A node's highlight state, undefined at rest. */
  const nodeState = (id: string): HighlightState | undefined => {
    if (!showing) return undefined;
    if (id === activeId) return 'active';
    if (highlight === 'critical') {
      return shownChain?.steps.has(id) === true ? 'chain' : 'dim';
    }
    if (paths?.upIds.has(id) === true) return 'lit';
    if (paths?.downIds.has(id) === true) return 'down';
    return 'dim';
  };

  /** An edge's highlight state, undefined at rest. */
  const edgeState = (key: string): HighlightState | undefined => {
    if (!showing) return undefined;
    if (highlight === 'critical') {
      return shownChain?.edgeKeys.has(key) === true ? 'chain' : 'dim';
    }
    if (paths?.upEdgeKeys.has(key) === true) return 'lit';
    if (paths?.downEdgeKeys.has(key) === true) return 'down';
    return 'dim';
  };

  // The readout's subject: the lit node, else the node the graph is about.
  const subjectId = activeId ?? drawn(focusId);
  const readoutLine = useMemo(() => {
    if (subjectId === null) return null;
    return describePaths(
      subjectId,
      ctx,
      words,
      highlight,
      highlight === 'critical' && subjectId === activeId
        ? shownChain
        : undefined
    );
  }, [subjectId, ctx, words, highlight, activeId, shownChain]);

  // The one node Tab reaches. Focus moves it; a new selection from
  // outside (a drawer's "Waits on" list) moves it too, so Tab returns to
  // what the reader picked last. Before either, Tab lands on the node the
  // graph is about.
  const [rovingId, setRovingId] = useState<string | null>(null);
  const [seenSelected, setSeenSelected] = useState(selectedId);
  if (selectedId !== seenSelected) {
    setSeenSelected(selectedId);
    if (selectedId !== null) setRovingId(selectedId);
  }
  const tabStop =
    [rovingId, selectedId, focusId].find((id) => id !== null && byId.has(id)) ??
    layout.nodes[0]?.id ??
    null;
  const helpId = useId();

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [zoom, setZoom] = useState(1);
  // A content point that must stay under a client point across a zoom.
  const anchorRef = useRef<{
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  // Event handlers read the zoom through a ref so the wheel listener is
  // attached once, not on every zoom step.
  const zoomRef = useRef(zoom);
  useIsomorphicLayoutEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  /** Zooms to `next`, keeping the content under (clientX, clientY) still. */
  const zoomAround = useCallback(
    (next: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      const canvas = canvasRef.current;
      const target = clampZoom(next);
      if (viewport === null || canvas === null) {
        setZoom(target);
        return;
      }
      const frame = viewport.getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      const cx0 = clientX ?? frame.left + frame.width / 2;
      const cy0 = clientY ?? frame.top + frame.height / 2;
      const k = zoomRef.current;
      anchorRef.current = {
        clientX: cx0,
        clientY: cy0,
        x: (cx0 - box.left) / k,
        y: (cy0 - box.top) / k,
      };
      setZoom(target);
    },
    []
  );

  // After a zoom renders, scroll so the anchored point is back under the
  // pointer (or the frame centre).
  useIsomorphicLayoutEffect(() => {
    const anchor = anchorRef.current;
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    anchorRef.current = null;
    if (anchor === null || viewport === null || canvas === null) return;
    const box = canvas.getBoundingClientRect();
    viewport.scrollLeft += box.left + anchor.x * zoom - anchor.clientX;
    viewport.scrollTop += box.top + anchor.y * zoom - anchor.clientY;
  }, [zoom]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null || layout.width === 0) return;
    const scale = Math.min(
      (viewport.clientWidth - FIT_PADDING * 2) / layout.width,
      (viewport.clientHeight - FIT_PADDING * 2) / layout.height,
      1
    );
    anchorRef.current = null;
    setZoom(clampZoom(scale));
    viewport.scrollTo({ left: 0, top: 0 });
  }, [layout.width, layout.height]);

  // Ctrl/cmd + wheel zooms. React's onWheel is passive, so the listener is
  // attached by hand; a plain wheel is never prevented. The frame only
  // exists while there are nodes, so the listener is (re)attached when it
  // appears: a graph that starts empty and fills later still zooms.
  const hasNodes = nodes.length > 0;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!hasNodes || viewport === null) return undefined;
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAround(
        zoomRef.current * Math.exp(-event.deltaY * WHEEL_RATE),
        event.clientX,
        event.clientY
      );
    }
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomAround, hasNodes]);

  // While a host panel covers the frame's right (coveredRight), the frame
  // gets that much right padding: a drawing narrower than the frame then
  // centres in the uncovered part, and a wider one can scroll its right
  // end out from under the panel. Set on the element before paint (and
  // before the centring below reads it), so nothing jumps.
  const reserveRef = useRef(0);
  useIsomorphicLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!hasNodes || viewport === null) return;
    const reserve = coveredPart(viewport, coveredRight ?? 0);
    reserveRef.current = reserve;
    viewport.style.paddingRight = reserve > 0 ? `${reserve}px` : '';
  }, [hasNodes, coveredRight]);

  // On the first paint that has a frame, centre the node the graph is
  // about (the focus, else the selection) in the frame, so a long chain
  // opens on its subject rather than on its leftmost blocker. Beside a
  // host panel it scrolls only as far as it takes to show the whole box in
  // the uncovered part (when that is less than centring), so the box is
  // not hidden under its own panel and what it waits on, to its left,
  // stays in view. Only the frame scrolls, never the page, with no
  // animation; it happens once, so later selections never move the
  // drawing under the reader. With neither, it opens where the flow starts,
  // or on its first frame when framed (openingScroll), so a big graph never
  // opens on dagre's empty corner or in the middle of a later frame.
  const centredRef = useRef(false);
  const centreId = focusId ?? selectedId;
  useIsomorphicLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (centredRef.current || !hasNodes || viewport === null) return;
    centredRef.current = true;
    if (centreId === null) {
      const start = openingScroll(
        layout,
        horizontal,
        viewport.clientWidth - reserveRef.current,
        viewport.clientHeight,
        zoomRef.current
      );
      if (start === null) return;
      viewport.scrollLeft = start.left;
      viewport.scrollTop = start.top;
      return;
    }
    const box =
      centreId === null
        ? undefined
        : layout.nodes.find((n) => n.id === centreId);
    if (box === undefined) return;
    const k = zoomRef.current;
    const visibleWidth = viewport.clientWidth - reserveRef.current;
    const centred = (box.x + box.width / 2) * k - visibleWidth / 2;
    const revealed = (box.x + box.width) * k + FIT_PADDING - visibleWidth;
    viewport.scrollLeft = Math.max(
      0,
      reserveRef.current > 0 ? Math.min(centred, revealed) : centred
    );
    viewport.scrollTop = Math.max(
      0,
      (box.y + box.height / 2) * k - viewport.clientHeight / 2
    );
  }, [hasNodes, centreId, layout, horizontal]);

  // Link nodes render through the host's <Link>, whose props carry no
  // tabIndex or aria-describedby, so the roving tab stop and the key help
  // are set on those anchors directly after each render.
  useEffect(() => {
    for (const [id, el] of nodeRefs.current) {
      if (el.matches('a, button, [tabindex]')) continue;
      const anchor = el.querySelector('a');
      if (anchor === null) continue;
      anchor.tabIndex = id === tabStop ? 0 : -1;
      anchor.setAttribute('aria-describedby', helpId);
    }
  }, [tabStop, helpId, layout]);

  // Drag-to-pan on the background with a mouse or pen; touch keeps native
  // scrolling. A press on a node is left alone so clicks still select.
  const pan = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch' || event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[data-graph-node]') !== null
    ) {
      return;
    }
    const viewport = viewportRef.current;
    if (viewport === null || onScrollbar(viewport, event)) return;
    pan.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      moved: false,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = pan.current;
    const viewport = viewportRef.current;
    if (state === null || viewport === null || state.id !== event.pointerId) {
      return;
    }
    // The button came up somewhere the pointerup never reached us (outside
    // the window, a native menu): the pan is over, not a hover-drag.
    if ((event.buttons & 1) === 0) {
      endPan(event);
      return;
    }
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
    if (!state.moved) {
      state.moved = true;
      viewport.setPointerCapture(event.pointerId);
      setPanning(true);
    }
    viewport.scrollLeft = state.left - dx;
    viewport.scrollTop = state.top - dy;
  }

  function endPan(event: ReactPointerEvent<HTMLDivElement>) {
    const state = pan.current;
    if (state === null || state.id !== event.pointerId) return;
    pan.current = null;
    if (state.moved) {
      viewportRef.current?.releasePointerCapture(event.pointerId);
      setPanning(false);
    }
  }

  // - + 0 zoom while focus is anywhere in the graph (never with ctrl/cmd,
  // which is the browser's own page zoom).
  function onFrameKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // A key press ends any touch gesture; Escape drops a touch pin, and
    // with it any trace a focus left by that tap still holds.
    pendingTouch.current = null;
    touchFocus.current = null;
    if (event.key === 'Escape' && pinnedId !== null) {
      setPinId(null);
      setFocusedId(null);
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target)) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAround(zoomRef.current * ZOOM_STEP);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomAround(zoomRef.current / ZOOM_STEP);
    } else if (event.key === '0') {
      event.preventDefault();
      fit();
    }
  }

  function onNodeKeyDown(
    event: ReactKeyboardEvent<HTMLElement>,
    node: LaidOutNode
  ) {
    if (event.key === 'Enter' && onSelect !== undefined) {
      event.preventDefault();
      onSelect(node.id);
      return;
    }
    const next = neighbour(
      layout.nodes,
      node,
      event.key,
      horizontal,
      layout.clustered === true
    );
    if (next === null) return;
    event.preventDefault();
    focusNode(next.id);
  }

  /**
   * A click on a node, before it opens: true when it came from a touch
   * press on this node that is not yet pinned, which only pins it (traces
   * its paths). A second tap, and any click without a touch press first
   * (mouse, keyboard, a screen reader's activation), opens as usual and
   * drops the pin.
   */
  function pinsOnly(id: string): boolean {
    const touched = pendingTouch.current === id;
    pendingTouch.current = null;
    // A tap on a node that already had focus fires no focus event.
    touchFocus.current = null;
    if (touched && pinnedId !== id) {
      setPinId(id);
      return true;
    }
    if (touched || pinnedId !== null) setPinId(null);
    return false;
  }

  // A tap or click on the background (not on a node) drops the pin.
  function onViewportClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (pinnedId === null) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[data-graph-node]') !== null
    ) {
      return;
    }
    setPinId(null);
  }

  // A node is the focusable element itself, or (for a link node) the
  // anchor inside its positioned wrapper.
  function focusNode(id: string) {
    const el = nodeRefs.current.get(id);
    if (el === undefined) return;
    const target = el.matches('a, button, [tabindex]')
      ? el
      : el.querySelector<HTMLElement>('a');
    target?.focus();
  }

  // A table ignores width and overflow, so the visually-hidden wrapper is
  // a div. The drawing already carries the summary, so the caption names
  // the table rather than repeating it. Built once per edge list: a hover
  // re-renders the graph, and a row per edge would be diffed each time.
  const edgeTable = useMemo(
    () => (
      <div className="srOnly">
        <table>
          <caption>
            Every edge: each blocker and the node that waits on it
          </caption>
          <thead>
            <tr>
              <th scope="col">Blocker</th>
              <th scope="col">Waiting</th>
              <th scope="col">Edge</th>
              <th scope="col">Relations</th>
            </tr>
          </thead>
          <tbody>
            {layout.edges.map((edge) => (
              <tr key={edge.key}>
                <td>{byId.get(edge.from)?.label ?? edge.from}</td>
                <td>{byId.get(edge.to)?.label ?? edge.to}</td>
                <td>{EDGE_WORDS[edge.kind]}</td>
                <td>{edge.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    [layout.edges, byId]
  );

  if (nodes.length === 0) {
    return (
      <p className={cx('empty', styles.emptyState, className)}>
        {emptyMessage}
      </p>
    );
  }

  const percent = `${Math.round(zoom * 100)}%`;
  const frameStyle = {
    '--graph-h': `${layout.height}px`,
  } as CSSProperties;
  const openable = (id: string): boolean => {
    const href = byId.get(id)?.href;
    return onSelect !== undefined || (href !== undefined && href !== '');
  };
  // While a touch pin is what lights the paths, the readout says that a
  // second tap opens the node.
  const readoutParts =
    readoutLine === null
      ? []
      : pinnedId !== null && activeId === pinnedId && openable(pinnedId)
        ? [...readoutLine.parts, words.tapAgain]
        : readoutLine.parts;
  const linkNodes = nodes.some((n) => n.href !== undefined && n.href !== '');

  /**
   * A frame: a cluster's hairline box (hatched when muted, dashed when
   * external; its title is drawn above the arrows by renderClusterTitle),
   * or a hatched group box with its title on the rule. Decorative: each
   * node's name says which frames it sits in.
   */
  const renderGroup = (group: LaidOutGroup): ReactNode => {
    const position = {
      left: group.x,
      top: group.y,
      width: group.width,
      height: group.height,
    };
    if (group.kind !== 'cluster') {
      return (
        <div
          key={group.id}
          className={styles.group}
          style={position}
          aria-hidden="true"
        >
          <span className={styles.groupTitle}>{group.label}</span>
        </div>
      );
    }
    return (
      <div
        key={group.id}
        className={cx(
          styles.cluster,
          group.muted === true && styles.clusterMuted,
          group.external === true && styles.clusterExternal
        )}
        style={position}
        aria-hidden="true"
        data-graph-cluster={group.id}
        data-depth={group.depth}
        data-muted={group.muted === true ? '' : undefined}
        data-external={group.external === true ? '' : undefined}
      />
    );
  };

  /**
   * A cluster's mono caps title inside its frame's top-left corner, on a
   * paper patch drawn above the arrows, so an arrow running into a box
   * near the top of a frame passes behind the title instead of through
   * its letters. Decorative, like the frame.
   */
  const renderClusterTitle = (group: LaidOutGroup): ReactNode =>
    group.kind !== 'cluster' ? null : (
      <span
        key={group.id}
        className={cx(
          styles.clusterTitle,
          group.depth === 0 && styles.clusterTitleTop,
          group.muted === true && styles.clusterTitleMuted
        )}
        style={{
          left: group.x + CLUSTER_METRICS.titleX,
          top: group.y + CLUSTER_METRICS.titleTop,
          maxWidth: Math.max(0, group.width - CLUSTER_METRICS.titleX * 2),
        }}
        aria-hidden="true"
        data-graph-cluster-title={group.id}
        title={group.label}
      >
        {group.label}
      </span>
    );

  /** One edge's drawing; the overlay copy carries no data hooks. */
  const renderEdge = (
    edge: LaidOutEdge,
    state: HighlightState | undefined,
    overlay: boolean
  ): ReactNode => (
    <g
      key={edge.key}
      className={cx(
        styles.edge,
        EDGE_CLASS[edge.kind],
        state === undefined ? undefined : STATE_CLASS[state]
      )}
      data-edge={overlay ? undefined : edge.key}
      data-kind={overlay ? undefined : edge.kind}
      data-state={overlay ? undefined : state}
      data-cross={crossKeys.has(edge.key) ? '' : undefined}
    >
      <path className={styles.edgeLine} d={edge.path} />
      <path className={styles.edgeArrow} d={edge.arrow} />
      {edge.label !== null ? (
        <g className={styles.weight}>
          <rect
            x={edge.label.x + 0.5}
            y={edge.label.y + 0.5}
            width={edge.label.width - 1}
            height={edge.label.height - 1}
          />
          <text
            x={edge.label.x + edge.label.width / 2}
            y={edge.label.y + edge.label.height / 2}
            dominantBaseline="central"
            textAnchor="middle"
          >
            {edge.weight}
          </text>
        </g>
      ) : null}
    </g>
  );
  // Lit, down and critical edges are drawn a second time above the rest,
  // so a path line never runs under a receding one where they cross.
  const overlayEdges = showing
    ? OVERLAY_ORDER.flatMap((state) =>
        layout.edges
          .filter((edge) => edgeState(edge.key) === state)
          .map((edge) => renderEdge(edge, state, true))
      )
    : [];

  return (
    <div
      className={cx(styles.graph, className)}
      data-highlight={highlight}
      onKeyDown={onFrameKeyDown}
    >
      <div className={styles.toolbar}>
        {toolbar !== undefined && toolbar !== null ? (
          <div className={styles.toolbarStart}>{toolbar}</div>
        ) : null}
        {hint !== null && hint !== '' ? (
          <span className={styles.hint}>{hint}</span>
        ) : null}
        <div className={styles.zoom} role="group" aria-label="Zoom">
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => zoomAround(zoom / ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            aria-keyshortcuts="-"
            title="Zoom out (-)"
          >
            <Minus size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <output className={styles.zoomValue} aria-live="polite">
            <span className="srOnly">Zoom </span>
            {percent}
          </output>
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => zoomAround(zoom * ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            aria-keyshortcuts="+"
            title="Zoom in (+)"
          >
            <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={cx(styles.zoomButton, styles.fitButton)}
            onClick={fit}
            aria-label="Fit the graph to the frame"
            aria-keyshortcuts="0"
            title="Fit (0)"
          >
            <Maximize size={14} strokeWidth={1.5} aria-hidden="true" />
            <span aria-hidden="true">Fit</span>
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={styles.viewport}
        data-graph-viewport=""
        style={frameStyle}
        data-panning={panning ? '' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onClick={onViewportClick}
      >
        <div
          ref={canvasRef}
          className={styles.canvas}
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          <div
            className={styles.stage}
            style={{
              width: layout.width,
              height: layout.height,
              transform: zoom === 1 ? undefined : `scale(${zoom})`,
            }}
          >
            {layout.groups.map((group) => renderGroup(group))}

            <svg
              className={styles.edges}
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label={ariaSummary}
            >
              {layout.edges.map((edge) =>
                renderEdge(edge, edgeState(edge.key), false)
              )}
              {overlayEdges.length > 0 ? (
                <g aria-hidden="true" data-overlay="">
                  {overlayEdges}
                </g>
              ) : null}
            </svg>

            {layout.groups.map((group) => renderClusterTitle(group))}

            {layout.nodes.map((box) => {
              const node = byId.get(box.id);
              if (node === undefined) return null;
              const tags = node.tags ?? [];
              // The red overdue flood is a Risk tint; elsewhere the
              // OVERDUE chip carries the red on its own.
              const flood = tags.includes('OVERDUE') && highlight === 'risk';
              const inCycle = tags.includes('CYCLE');
              const selected = box.id === selectedId;
              const focus = box.id === focusId;
              const state = nodeState(box.id);
              const readiness = node.readiness;
              const drawnTone = shownTone(node, highlight);
              // A status tone (or a host's accent) draws the 2px rule in
              // its hue through the data-tone hook (tokens.css); a ready
              // node under Status only a 1px edge in the green; muted
              // keeps its own faint look.
              const tone =
                drawnTone === 'default' || drawnTone === 'muted'
                  ? undefined
                  : drawnTone;
              const edgeOnly =
                highlight === 'status' &&
                readiness !== undefined &&
                tone === 'success';
              const step = shownChain?.steps.get(box.id);
              const next = nextIds.has(box.id);
              const pointed = box.id === pointedId;
              const classes = cx(
                styles.node,
                tone !== undefined &&
                  (edgeOnly ? styles.toneEdge : styles.toned),
                drawnTone === 'muted' && styles.toneMuted,
                node.external === true && styles.external,
                flood && styles.overdueNode,
                inCycle && styles.cycle,
                selected && styles.selected,
                focus && styles.focus,
                state === undefined ? undefined : STATE_CLASS[state],
                pointed && styles.pointed
              );
              // The readiness chip leads the chips in every highlight (the
              // layout never moves); only Status tones it. A node with no
              // dependencies gets none: its name and the readout say it.
              const chipWord =
                readiness?.state === 'independent'
                  ? ''
                  : (readiness?.label ?? '');
              const chipTone =
                highlight === 'status' &&
                readiness !== undefined &&
                readiness.tone !== 'default'
                  ? readiness.tone
                  : undefined;
              const position: CSSProperties = {
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
              };
              const nameStep = nameChain?.steps.get(box.id);
              const name = nodeName(
                node,
                nameCounts.get(box.id),
                nameChain !== null && nameStep !== undefined
                  ? { k: nameStep, s: nameChain.stepCount }
                  : null,
                focus ? focusLabel : null,
                framesOf.get(box.id)
              );
              const body = (
                <>
                  {node.status !== undefined ? (
                    <span
                      className={cx(styles.glyph, styles[node.status])}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className={styles.text}>
                    <span className={styles.label}>
                      {box.labelLines.map((line, i) => (
                        <span key={i} className={styles.line}>
                          {line}
                        </span>
                      ))}
                    </span>
                    {box.sublabelLine !== '' ? (
                      <span className={styles.sublabel}>
                        {box.sublabelLine}
                      </span>
                    ) : null}
                    {chipWord !== '' || tags.length > 0 ? (
                      <span className={styles.tags}>
                        {chipWord !== '' ? (
                          <span
                            className={cx(
                              styles.tag,
                              readiness?.state === 'ready' && styles.readyChip,
                              chipTone !== undefined && styles.tagToned
                            )}
                            data-tone={chipTone}
                            data-readiness-chip=""
                          >
                            {chipWord}
                          </span>
                        ) : null}
                        {tags.map((tag) => {
                          const red = tag === 'OVERDUE' && !flood;
                          return (
                            <span
                              key={tag}
                              className={cx(
                                styles.tag,
                                tag === 'UNASSIGNED' && styles.tagWarning,
                                red && styles.tagToned
                              )}
                              data-tone={red ? 'danger' : undefined}
                            >
                              {tag}
                            </span>
                          );
                        })}
                      </span>
                    ) : null}
                  </span>
                  {next ? (
                    <span
                      className={styles.next}
                      aria-hidden="true"
                      data-next-pill=""
                    >
                      {words.next}
                    </span>
                  ) : null}
                  {step !== undefined ? (
                    <span
                      className={styles.step}
                      aria-hidden="true"
                      data-step-badge=""
                    >
                      {step}
                    </span>
                  ) : null}
                </>
              );
              const handlers = {
                'data-graph-node': box.id,
                'data-state': state,
                'data-pointed': pointed ? '' : undefined,
                'data-focus': focus ? '' : undefined,
                'data-readiness': readiness?.state,
                'data-next': next ? '' : undefined,
                'data-step': step,
                ref: (el: HTMLElement | null) => {
                  if (el === null) nodeRefs.current.delete(box.id);
                  else nodeRefs.current.set(box.id, el);
                },
                onFocus: () => {
                  setRovingId(box.id);
                  // The focus a touch press gave it: the pin traces it.
                  if (touchFocus.current === box.id) {
                    touchFocus.current = null;
                    return;
                  }
                  setFocusedId(box.id);
                },
                onBlur: () =>
                  setFocusedId((current) =>
                    current === box.id ? null : current
                  ),
                onPointerEnter: (event: ReactPointerEvent) => {
                  if (event.pointerType !== 'touch') setHoverId(box.id);
                },
                onPointerLeave: () =>
                  setHoverId((current) =>
                    current === box.id ? null : current
                  ),
                onPointerDown: (event: ReactPointerEvent) => {
                  const touch = event.pointerType === 'touch';
                  pendingTouch.current = touch ? box.id : null;
                  touchFocus.current = touch ? box.id : null;
                },
                onPointerCancel: () => {
                  pendingTouch.current = null;
                  touchFocus.current = null;
                },
                onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) =>
                  onNodeKeyDown(event, box),
              };
              if (onSelect !== undefined) {
                return (
                  <button
                    key={box.id}
                    type="button"
                    className={classes}
                    data-tone={tone}
                    style={position}
                    tabIndex={box.id === tabStop ? 0 : -1}
                    aria-pressed={selected}
                    aria-label={name}
                    aria-describedby={helpId}
                    title={node.label}
                    onClick={() => {
                      if (!pinsOnly(box.id)) onSelect(box.id);
                    }}
                    {...handlers}
                  >
                    {body}
                  </button>
                );
              }
              if (node.href !== undefined && node.href !== '') {
                return (
                  <span
                    key={box.id}
                    className={styles.linkWrap}
                    style={position}
                    {...handlers}
                  >
                    <Link
                      href={node.href}
                      className={classes}
                      data-tone={tone}
                      aria-label={name}
                      title={node.label}
                      onClick={(event) => {
                        if (pinsOnly(box.id)) event.preventDefault();
                      }}
                    >
                      {body}
                    </Link>
                  </span>
                );
              }
              return (
                <div
                  key={box.id}
                  className={classes}
                  data-tone={tone}
                  style={position}
                  tabIndex={box.id === tabStop ? 0 : -1}
                  role="group"
                  aria-label={name}
                  aria-describedby={helpId}
                  title={node.label}
                  onClick={() => pinsOnly(box.id)}
                  {...handlers}
                >
                  {body}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* What the reader is tracing, in words: the lit node's paths, else
          the host's summary for this highlight and how to trace a node.
          Plain text, not a live region: it would chatter on hover. */}
      {readout !== null ? (
        <p className={styles.readout} data-graph-readout="">
          {readoutLine !== null ? (
            <>
              <span className={styles.readoutSubject}>
                {readoutLine.subject}
              </span>
              {readoutParts.map((part, i) => (
                <Fragment key={i}>
                  <span className={styles.readoutSep}> · </span>
                  <span>{part}</span>
                </Fragment>
              ))}
            </>
          ) : (
            <>
              {readout !== undefined && readout !== '' ? (
                <>
                  <span className={styles.readoutIdle}>{readout}</span>{' '}
                </>
              ) : null}
              <span className={styles.readoutHint}>
                <span className={styles.hintHover}>
                  {highlight === 'critical' ? words.hintCritical : words.hint}
                </span>
                <span className={styles.hintTap}>
                  {highlight === 'critical'
                    ? words.tapHintCritical
                    : words.tapHint}
                </span>
              </span>
            </>
          )}
        </p>
      ) : null}

      {/* Key help every node points at (aria-describedby). */}
      <p id={helpId} className="srOnly">
        {onSelect !== undefined
          ? 'Arrow keys move between nodes, Home and End jump to the first and last, Enter selects. Minus, plus and 0 zoom.'
          : 'Arrow keys move between nodes, Home and End jump to the first and last. Minus, plus and 0 zoom.'}
        {onSelect !== undefined || linkNodes
          ? " On a touch screen, the first tap traces a box's paths and a second tap opens it."
          : " On a touch screen, a tap traces a box's paths."}
      </p>

      {edgeTable}
    </div>
  );
}
