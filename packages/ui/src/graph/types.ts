import type { ReactNode } from 'react';

import type { TaskStateKind } from '../tasks/types';
import type { SemanticTone, UiStatus, UiTone } from '../types';

// Prop vocabulary of the graph family: a dependency graph as plain data.
// Hosts map their own model (the planner's core DependencyGraph, Dispatch's
// blockedBy tasks) onto these shapes in a thin adapter; nothing here knows
// about Linear, milestones or issues.

/**
 * Node emphasis in the §8.2 status tones (docs/architecture.md): a neutral
 * card (default), a card tinted in a status tone (danger: overdue;
 * warning: at risk, unassigned, needs action; success / info when a host
 * wants them), or a quiet one (muted: closed, or inactive work). The
 * accent is never a status: the graph keeps it for selection, keyboard
 * focus, the lit chain and the chain's focus ring.
 */
export type GraphNodeTone = 'default' | 'muted' | SemanticTone;

/**
 * A word drawn on a node as a sentence-case Chip ("Overdue", "Unassigned",
 * "Cycle", "+2 more"), in a §8.2 tone (default: neutral). The word is the
 * meaning; the tone only repeats it, so it never relies on colour alone.
 */
export interface GraphNodeTag {
  label: string;
  tone?: UiTone;
}

export interface GraphNodeData {
  id: string;
  /** The name: a milestone or issue title. */
  label: string;
  /** A short identifier printed in mono before the sublabel ("ATL-41"). */
  key?: string;
  /** Quiet second line: "Atlas · Oct 18", "Ana". */
  sublabel?: string;
  /** Where the node lives (open in Linear, the timeline drawer…). */
  href?: string;
  /** Outside the requested scope (one hop away): a dashed neutral edge. */
  external?: boolean;
  tone: GraphNodeTone;
  /** A milestone-like status, drawn as StatusMark's diamond. */
  status?: UiStatus;
  /**
   * A task's workflow state (an issue), drawn as StateGlyph's circle
   * instead of the status diamond, so the two never look alike.
   */
  state?: TaskStateKind;
  /** Draw the status diamond in greys whatever the status (inactive
      work is never loud); the label still names the status. */
  statusMuted?: boolean;
  /** Human wording for the status mark ("Overdue", "In progress"). */
  statusLabel?: string;
  tags?: GraphNodeTag[];
  /**
   * On a blocking cycle: a dashed outline in the danger tone around the
   * box. Hosts also add a "Cycle" tag, so the word says it too.
   */
  inCycle?: boolean;
  /**
   * Cluster key and label (the project). Nodes sharing a group are drawn
   * inside one soft frame when the graph is asked to cluster.
   */
  group?: string;
}

/**
 * How an edge is drawn (Gr8r's thin connectors). One kind per edge; when
 * several apply, hosts pick in this precedence: resolved > cycle > risk >
 * cross > default. Each kind differs by more than its colour.
 * - default: a thin --text-3 curve, the blocker blocks the waiting node
 * - risk: thicker, in the warning tone: part of a chain ending in an
 *   unassigned or overdue blocker
 * - cycle: long dashes in the danger tone: both ends wait on each other
 * - cross: short dashes, --text-3: crosses a project (or initiative)
 * - resolved: dotted and faint: the blocker is already closed
 */
export type GraphEdgeKind = 'default' | 'risk' | 'cycle' | 'cross' | 'resolved';

export interface GraphEdgeData {
  /** The blocker. */
  from: string;
  /** The node that waits on it. */
  to: string;
  kind: GraphEdgeKind;
  /** Relations this edge summarises; shown as a count when > 1. */
  weight?: number;
}

/** LR = blockers on the left (the planner); TB = blockers on top. */
export type GraphDirection = 'LR' | 'TB';

export interface GraphLayoutOptions {
  direction?: GraphDirection;
  /**
   * Draw groups as soft frames (dagre compound clusters). Off by
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
  /** The sublabel cut to fit one line (after the key, when there is one). */
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
  /** Edges in paint order: resolved first, risk and cycle last (on top). */
  edges: LaidOutEdge[];
  groups: LaidOutGroup[];
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
  /** Persistently marked node (the accent selection: a soft accent fill
      inside an accent ring); its chain shows when idle. */
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
   * The node the graph is about (one issue's chain): a 2px accent ring
   * standing a few px off its box (selection hugs the box instead). It
   * lights nothing, unlike selection; its accessible name ends with
   * `focusLabel`. On the first paint the frame scrolls it (else the
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

/**
 * What a legend swatch draws: a status diamond or a workflow-state circle
 * (`status` / `state`, with the item's `status` / `state`), a node card in
 * one of the graph's looks, an edge, or the count pill.
 */
export type GraphLegendMark =
  | 'status'
  | 'state'
  | 'node'
  | 'node-danger'
  | 'node-warning'
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
  /** For `status`: which diamond. */
  status?: UiStatus;
  /** For `state`: which workflow-state circle. */
  state?: TaskStateKind;
  /** Sentence-case name ("Risk chain"). */
  label: string;
  /** Quiet explanation ("ends in an unassigned or overdue blocker"). */
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
  /** Button wording. */
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
