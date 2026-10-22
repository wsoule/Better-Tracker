import type { ReactNode } from 'react';

import type { UiStatus } from '../types';

// Prop vocabulary of the graph family: a dependency graph as plain data.
// Hosts map their own model (the planner's core DependencyGraph, Dispatch's
// blockedBy tasks) onto these shapes in a thin adapter; nothing here knows
// about Linear, milestones or issues.

/** Node emphasis: ink hairline, the accent ("needs action"), or faint. */
export type GraphNodeTone = 'default' | 'accent' | 'muted';

/**
 * Flags drawn on a node as mono chips. OVERDUE also floods the node with
 * the accent; CYCLE adds the dashed accent outline. Any other string is
 * shown as a plain chip.
 */
export type GraphNodeTag = 'UNASSIGNED' | 'OVERDUE' | 'CYCLE' | (string & {});

export interface GraphNodeData {
  id: string;
  /** The name: a milestone or issue title. */
  label: string;
  /** Mono second line: "ATLAS · DUE OCT 18", "ATL-41 · ANA". */
  sublabel?: string;
  /** Where the node lives (open in Linear, the timeline drawer…). */
  href?: string;
  /** Outside the requested scope (one hop away): dashed muted border. */
  external?: boolean;
  tone: GraphNodeTone;
  status?: UiStatus;
  /** Human wording for the status mark ("Overdue", "In progress"). */
  statusLabel?: string;
  tags?: GraphNodeTag[];
  /**
   * Cluster key and label (the project). Nodes sharing a group are drawn
   * inside one hatched frame when the graph is asked to cluster.
   */
  group?: string;
}

/**
 * How an edge is drawn. One kind per edge; when several apply, hosts pick
 * in this precedence: resolved > cycle > risk > cross > default.
 * - default: 1px ink, the blocker blocks the waiting node
 * - risk: accent, part of a chain ending in an unassigned/overdue blocker
 * - cycle: dashed accent, both ends wait on each other
 * - cross: dashed ink, crosses a project (or owner) boundary
 * - resolved: --grey-3, the blocker is already closed
 */
export type GraphEdgeKind = 'default' | 'risk' | 'cycle' | 'cross' | 'resolved';

export interface GraphEdgeData {
  /** The blocker. */
  from: string;
  /** The node that waits on it. */
  to: string;
  kind: GraphEdgeKind;
  /** Relations this edge summarises; shown as a mono count when > 1. */
  weight?: number;
}

/** LR = blockers on the left (the planner); TB = blockers on top. */
export type GraphDirection = 'LR' | 'TB';

export interface GraphLayoutOptions {
  direction?: GraphDirection;
  /**
   * Draw groups as hatched frames (dagre compound clusters). Off by
   * default: frames keep a project together but spread a graph with many
   * cross-group edges out, so hosts opt in where groups are few.
   */
  cluster?: boolean;
}

/** A node placed by layoutGraph: top-left box plus its wrapped label. */
export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0-based column (LR) or row (TB) the layout put the node in. */
  rank: number;
  /** The label broken into at most two lines that fit the box. */
  labelLines: string[];
  /** The sublabel cut to fit one line. */
  sublabelLine: string;
}

/** An edge routed by layoutGraph. */
export interface LaidOutEdge {
  /** Stable key, `${from}->${to}`. */
  key: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  weight: number;
  /** Polyline from the blocker's border to the waiting node's border. */
  points: { x: number; y: number }[];
  /** SVG path data: a smoothed curve through `points`. */
  path: string;
  /** Arrowhead triangle at the waiting end (SVG path data). */
  arrow: string;
  /** Where the weight label sits, when weight > 1. */
  label: { x: number; y: number; width: number; height: number } | null;
}

/** A group frame placed by layoutGraph. */
export interface LaidOutGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  direction: GraphDirection;
  /** Nodes in focus order: by rank, then across the rank. */
  nodes: LaidOutNode[];
  /** Edges in paint order: resolved first, accent kinds last (on top). */
  edges: LaidOutEdge[];
  groups: LaidOutGroup[];
}

/** The highlight a graph is drawn with (the planner's `?highlight=`). */
export type GraphHighlight = 'status' | 'risk' | 'critical';

/** Where a node stands in the blocking flow (architecture §2.10). */
export type GraphReadinessState = 'ready' | 'blocked' | 'done';

/**
 * What a host knows about a node's readiness over all of its data, not
 * only the drawn part (the planner fills it from core's GraphNode
 * readiness fields). The path walks (paths.ts) read it; hosts without it
 * get their drawn-edge fallbacks.
 */
export interface GraphNodeReadiness {
  /** done: closed; blocked: open with an open blocker; ready otherwise. */
  state: GraphReadinessState;
  /** The chip word ("Ready", "Blocked by 2", "Clear"); '' when done. */
  label: string;
  /** Distinct open blockers (a self-loop counts); may exceed the drawn ones. */
  blockedBy: number;
  /** What finishing it alone would free; may exceed the drawn ones. */
  unblocks: number;
  /**
   * False when nothing in it can start although nothing outside holds it
   * up (a box whose every open issue waits on another inside it). Default
   * true. "Start with" never points at such a node.
   */
  canStart?: boolean;
}

/**
 * Wording of the path readout (paths.ts `defaultGraphPathWords` holds the
 * defaults); hosts override any part. `{n}`, `{names}`, `{k}`, `{s}` and
 * `{unit}` are filled in.
 */
export interface GraphPathWords {
  /** The drawn thing, singular and plural, for "{n} {unit}". */
  unit: readonly [one: string, other: string];
  waitsOn: string;
  startWith: string;
  waitsOnNone: string;
  waitsOnOutside: string;
  startsOutside: string;
  selfLoop: string;
  blockersDone: string;
  holdsUp: string;
  holdsUpNone: string;
  unblock: string;
  /** The pill on what finishing the active node alone would unblock. */
  next: string;
  notDrawn: string;
  /** The readout's state word for a done node without a statusLabel. */
  done: string;
  noLongerBlocks: string;
  step: string;
  through: string;
  offChain: string;
  tapAgain: string;
  hint: string;
  tapHint: string;
  more: string;
}

/** The transitive blockers of one node (see upstreamChain). */
export interface UpstreamChain {
  /** The node the chain was computed for. */
  id: string;
  /** Every node it waits on, nearest first; never includes `id` itself. */
  nodeIds: string[];
  /** Keys (`${from}->${to}`) of the edges walked. */
  edgeKeys: Set<string>;
}

export interface DependencyGraphProps {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  /** Persistently marked node (ink fill); its chain shows when idle. */
  selectedId?: string | null;
  /** Click / Enter on a node. Omit for a read-only graph. */
  onSelect?: (id: string) => void;
  /** One full sentence: what the graph shows, for the role="img" label. */
  ariaSummary: string;
  /** Honest copy for a graph with no nodes. */
  emptyMessage: string;
  direction?: GraphDirection;
  /** Override clustering (see GraphLayoutOptions.cluster). */
  cluster?: boolean;
  /** Controls placed at the start of the toolbar (level switch, copy). */
  toolbar?: ReactNode;
  /** Wording of the toolbar hint; pass null to hide it. */
  hint?: string | null;
  /**
   * Precomputed by the host with `layoutGraph` from the same nodes, edges
   * and options; used as is, so the client never runs dagre (a server
   * render can lay the graph out once). `direction` and `cluster` are then
   * ignored: the layout already carries them.
   */
  layout?: GraphLayout;
  /**
   * The node the graph is about (one issue's chain): a 2px ink rule inside
   * its box. It lights nothing, unlike selection; its accessible name ends
   * with `focusLabel`. On the first paint the frame scrolls it (else the
   * selected node) into the middle of the viewport.
   */
  focusId?: string | null;
  /** Last words of the focus node's accessible name. Defaults to "focus". */
  focusLabel?: string;
  /**
   * Width in px of a panel fixed along the window's right edge that is
   * open over the graph (an open SlideOver: `SLIDE_OVER_WIDTH`); unset or
   * 0 for none. While it is set the frame keeps room at its right for the
   * part the panel covers, so the first paint brings `focusId` (else
   * `selectedId`) into the part the panel does not hide, even in a drawing
   * that fits the frame: centred there, or scrolled only far enough to
   * show the whole box when that is less, so what it waits on (to its
   * left) stays in view. No room is kept when the panel would leave the frame
   * almost nothing (a phone's full-width sheet). Pass it only while the
   * panel the page opened on arrival stays open: later selections never
   * move the drawing.
   */
  coveredRight?: number;
  className?: string;
}

/** What a legend swatch draws. */
export type GraphLegendMark =
  | 'node'
  | 'node-accent'
  | 'node-overdue'
  | 'node-external'
  | 'node-cycle'
  | 'node-muted'
  | 'node-focus'
  | 'edge-default'
  | 'edge-risk'
  | 'edge-cycle'
  | 'edge-cross'
  | 'edge-resolved'
  | 'weight';

export interface GraphLegendItem {
  mark: GraphLegendMark;
  /** Mono uppercase name ("RISK CHAIN"). */
  label: string;
  /** Muted explanation ("waits on an unassigned or overdue blocker"). */
  note?: string;
}

export interface GraphLegendProps {
  /** Defaults to every mark the graph draws (defaultGraphLegend). */
  items?: GraphLegendItem[];
  /** Accessible name of the list. */
  label?: string;
  className?: string;
}

export interface MermaidSourceProps {
  /** The Mermaid text to copy and show. */
  source: string;
  /** Button wording (uppercased by the style). */
  copyLabel?: string;
  /** Wording during the 1600ms confirmation. */
  copiedLabel?: string;
  /** Wording when the clipboard refused. */
  failedLabel?: string;
  /** The <details> summary. */
  sourceLabel?: string;
  /** Told whether the copy worked, e.g. to raise a toast. */
  onCopy?: (ok: boolean) => void;
  className?: string;
}
