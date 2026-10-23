import type { ReactNode } from 'react';

import type { UiStatus, UiTone } from '../types';

// Prop vocabulary of the graph family: a dependency graph as plain data.
// Hosts map their own model (the planner's core DependencyGraph, Dispatch's
// blockedBy tasks) onto these shapes in a thin adapter; nothing here knows
// about Linear, milestones or issues.

/**
 * Node emphasis in the status tones (docs/architecture.md §8.2): an ink
 * hairline (default), faint (muted: closed or inactive work, its status
 * mark in the inactive grey), or a 2px rule in the tone's status hue:
 * danger (red: overdue), warning (amber: at risk, unassigned, needs
 * action), success (green) or info (blue). `accent` draws the rule in the
 * purple for a host's own emphasis; it is never a status (the graph keeps
 * the purple for selection, hover and keyboard focus). Under the Status
 * highlight a node's readiness tone replaces it, and a ready node
 * (success) is drawn as a 1px green edge only, so it reads apart from the
 * 2px rule of a blocked one without its hue.
 */
export type GraphNodeTone = UiTone;

/**
 * Flags drawn on a node as mono chips. OVERDUE also floods the node with
 * the red status hue; CYCLE adds the dashed red outline (drawn from the
 * tag); UNASSIGNED is a filled amber chip. Any other string is shown as a
 * plain chip.
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
   * inside one hatched frame when the graph is asked to cluster. Ignored
   * when the graph is given `clusters`.
   */
  group?: string;
  /**
   * The id of the innermost of the graph's `clusters` the node is drawn
   * in (its milestone, its project…). An unknown id, or none, puts it at
   * the top level.
   */
  cluster?: string;
  /**
   * A short identifier ("ENG-23"): the path readout names the node by it,
   * else by its label cut to 32 characters.
   */
  key?: string;
  /**
   * Where the node stands in the blocking flow, over all of the host's
   * data. It draws the readiness chip (first, before the tags, in every
   * highlight so the layout never moves), the Status highlight's tone, and
   * the counts the readout and the accessible name give. Without it the
   * Status highlight falls back to `tone` and the walks to drawn edges.
   */
  readiness?: GraphNodeReadiness;
}

/**
 * A labelled frame around the nodes that share a parent (a milestone, a
 * project, an initiative), given to the graph as `clusters`. Frames nest
 * through `parent`. Inside a frame the nodes on an arrow flow along the
 * layout direction and the rest pack into a compact grid; frames with no
 * arrow pack onto shelves, so a graph of every item never becomes one
 * long column.
 */
export interface GraphClusterData {
  id: string;
  /** Mono caps title in the frame's top-left corner. */
  label: string;
  /** The enclosing cluster's id; none (or an unknown id) for the top. */
  parent?: string;
  /** Inactive work: a hatched frame with a dim title. */
  muted?: boolean;
  /** Outside the scope: a dashed frame. */
  external?: boolean;
}

/**
 * How an edge is drawn. One kind per edge; when several apply, hosts pick
 * in this precedence: resolved > cycle > risk > cross > default.
 * - default: 1px ink, the blocker blocks the waiting node
 * - risk: amber (the warning hue), part of a chain ending in an
 *   unassigned/overdue blocker
 * - cycle: dashed red (the danger hue), both ends wait on each other
 * - cross: dashed ink, crosses a project (or owner) boundary
 * - resolved: dotted grey (green dots under the Status highlight): one
 *   end is done (the blocker, or the node that waited), so it no longer
 *   blocks; the path walks and the critical path skip it
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
  /**
   * It crosses a project (or owner) boundary, whatever its kind. The
   * Status and Critical path highlights dash such an edge when it still
   * blocks and is not a cycle (dots and cycle dashes win: one line has
   * one dash pattern); the Risk highlight dashes the `cross` kind only.
   */
  cross?: boolean;
}

/** LR = blockers on the left (the planner); TB = blockers on top. */
export type GraphDirection = 'LR' | 'TB';

export interface GraphLayoutOptions {
  direction?: GraphDirection;
  /**
   * Draw groups as hatched frames (dagre compound clusters). Off by
   * default: frames keep a project together but spread a graph with many
   * cross-group edges out, so hosts opt in where groups are few. Ignored
   * when `clusters` is given.
   */
  cluster?: boolean;
  /**
   * Lay the graph out in labelled, nested frames (GraphClusterData, nodes
   * placed by `GraphNodeData.cluster`): inside each frame the nodes and
   * frames on an arrow flow along the direction (dagre over that frame's
   * own items) and the rest pack, nodes into a grid and frames onto
   * shelves. Given at all (even empty), it also packs the top level's
   * nodes that touch no arrow. Linear in nodes plus edges besides the
   * dagre runs, each over one frame's linked items only.
   */
  clusters?: readonly GraphClusterData[];
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
  /** The group's label (`group` frames) or the cluster's id. */
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * `cluster` for a frame from `clusters` (the title inside its top-left
   * corner), absent for a hatched `group` frame (the title on its rule).
   */
  kind?: 'cluster';
  /** Nesting depth of a cluster frame: 0 at the top. */
  depth?: number;
  /** A muted cluster (GraphClusterData.muted). */
  muted?: boolean;
  /** An external cluster (GraphClusterData.external). */
  external?: boolean;
}

export interface GraphLayout {
  width: number;
  height: number;
  direction: GraphDirection;
  /** Nodes in focus order: by rank, then across the rank. */
  nodes: LaidOutNode[];
  /** Edges in paint order: resolved first, risk and cycle last (on top). */
  edges: LaidOutEdge[];
  /**
   * Frames in paint order. Cluster frames come parents first (each
   * frame before the frames inside it), in cluster order.
   */
  groups: LaidOutGroup[];
  /**
   * Laid out in clusters (`clusters` was given): nodes come in reading
   * order (frame by frame, each frame's flow then its grid) and the arrow
   * keys move by position rather than by rank.
   */
  clustered?: boolean;
}

/** The highlight a graph is drawn with (the planner's `?highlight=`). */
export type GraphHighlight = 'status' | 'risk' | 'critical';

/**
 * Where a node stands in the blocking flow (architecture §2.10):
 * `independent` is open work that neither blocks nor waits on anything
 * ("No dependencies"), drawn neutral with no chip; `empty` is a box no
 * issue counts toward ("No issues"), walked like a done one but never
 * called done.
 */
export type GraphReadinessState =
  | 'ready'
  | 'blocked'
  | 'done'
  | 'independent'
  | 'empty';

/**
 * What a host knows about a node's readiness over all of its data, not
 * only the drawn part (the planner fills it from core's GraphNode
 * readiness fields). The path walks (paths.ts) read it; hosts without it
 * get their drawn-edge fallbacks.
 */
export interface GraphNodeReadiness {
  /**
   * done: closed; empty: a box with no issues at all; blocked: open with
   * an open blocker; independent: open and on no relation; ready
   * otherwise.
   */
  state: GraphReadinessState;
  /**
   * The chip word ("Ready", "Blocked by 2", "Clear"); '' when done or
   * empty. An
   * independent node's word ("No dependencies") is said in its name and
   * the readout but drawn as no chip, so a graph of every item does not
   * repeat it on most boxes.
   */
  label: string;
  /**
   * The Status highlight's tone for the node and its chip: success
   * (ready: a 1px green edge), warning (blocked: the 2px amber rule),
   * danger (stuck), muted (done or paused work).
   */
  tone: GraphNodeTone;
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
  /** Nothing drawn waits on it ("Nothing here waits on it"): finishing it
      may still free something outside the graph (`unblock` says so). */
  holdsUpNone: string;
  unblock: string;
  /** The square tag on what finishing the active node alone would unblock. */
  next: string;
  notDrawn: string;
  /** The readout's state word for a done node without a statusLabel. */
  done: string;
  /** The readout's state word for an empty box without a statusLabel. */
  empty: string;
  noLongerBlocks: string;
  step: string;
  through: string;
  offChain: string;
  tapAgain: string;
  /** The idle hint under Status and Risk, where a box shows its paths. */
  hint: string;
  tapHint: string;
  /** The idle hint under Critical path, where a box shows the longest
      chain through it. */
  hintCritical: string;
  tapHintCritical: string;
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
  /** Persistently marked node (ink fill); its paths show when idle. */
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
  /**
   * Labelled, nested frames the nodes are drawn in (GraphClusterData; see
   * GraphLayoutOptions.clusters). A node's accessible name ends its
   * context with the frames it sits in ("in Beta, Orion").
   */
  clusters?: GraphClusterData[];
  /** Controls placed at the start of the toolbar (level switch, copy). */
  toolbar?: ReactNode;
  /** Wording of the toolbar hint; pass null to hide it. */
  hint?: string | null;
  /**
   * Precomputed by the host with `layoutGraph` from the same nodes, edges
   * and options; used as is, so the client never runs dagre (a server
   * render can lay the graph out once). `direction`, `cluster` and the
   * layout of `clusters` are then ignored: the layout already carries
   * them (pass the same `clusters` for the names).
   */
  layout?: GraphLayout;
  /**
   * The node the graph is about (one issue's chain): a 2px ink rule inside
   * its box. It lights nothing, unlike selection (under the Critical path
   * highlight the chain shown at rest runs through it); the readout
   * describes it while nothing else is active, and its accessible name
   * ends with `focusLabel`. On the first paint the frame scrolls it (else
   * the selected node) into the middle of the viewport.
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
  /**
   * What the drawing emphasises (default `risk`, today's look): `status`
   * tones each node by its readiness and draws unblocked edges as green
   * dots; `risk` keeps the risk tones and edges; `critical` dims all but
   * the critical path (the longest chain of blocking edges, a cycle
   * counted as one step), numbering its boxes. Switching never moves a
   * box: the layout ignores it. Pointing at, focusing, tapping or
   * selecting a node lights what it waits on (accent rings and lines) and
   * what it holds up (ink), marking what finishing it alone would unblock
   * with a `pathWords.next` tag; under `critical` it shows the longest
   * chain through it instead.
   */
  highlight?: GraphHighlight;
  /**
   * The readout line under the drawing names the node being read and its
   * paths (paths.ts describePaths). With nothing active it shows this text
   * (the host's summary for the highlight), then how to trace a node.
   * Null hides the line.
   */
  readout?: string | null;
  /** The readout's and the tag's wording (paths.ts defaultGraphPathWords). */
  pathWords?: Partial<GraphPathWords>;
  className?: string;
}

/**
 * What a legend swatch draws: `node-warning` the 2px amber rule (at risk,
 * needs action), `node-overdue` the red flood, `node-cycle` the dashed red
 * outline; `node-accent` the 2px purple rule of a host's own emphasis.
 * The Status highlight's boxes: `node-ready` the 1px green edge,
 * `node-blocked` the 2px amber rule, `node-stuck` the 2px red rule; the
 * Critical path's: `node-chain` an ink ring with a step number,
 * `node-faded` a box off the path. `edge-unblocked` green dots,
 * `edge-chain` the 2.5px ink line. The `path-*` marks (a Paths row) show
 * what pointing at a node lights: `path-active` the accent flood of the
 * node being read (pointed at, focused or tapped), `path-up` the accent
 * ring of what it waits on, `path-down` the ink ring of what it holds up,
 * `path-next` the square tag on what finishing it would unblock,
 * `path-chain` the ink ring and step number of the chain through it (as
 * `node-chain`: the critical path is ink, never the accent). `cluster` is a frame around the boxes that share a
 * parent (`clusters`), `cluster-muted` a hatched one of inactive work;
 * both sit in the Nodes row, and a plain `node` swatch can say "No
 * dependencies".
 */
export type GraphLegendMark =
  | 'node'
  | 'node-accent'
  | 'node-warning'
  | 'node-overdue'
  | 'node-external'
  | 'node-cycle'
  | 'node-muted'
  | 'node-focus'
  | 'node-ready'
  | 'node-blocked'
  | 'node-stuck'
  | 'node-chain'
  | 'node-faded'
  | 'edge-default'
  | 'edge-risk'
  | 'edge-cycle'
  | 'edge-cross'
  | 'edge-resolved'
  | 'edge-unblocked'
  | 'edge-chain'
  | 'weight'
  | 'path-active'
  | 'path-up'
  | 'path-down'
  | 'path-next'
  | 'path-chain'
  | 'cluster'
  | 'cluster-muted';

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
