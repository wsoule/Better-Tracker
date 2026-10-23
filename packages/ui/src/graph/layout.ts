import { graphlib, layout as dagreLayout } from '@dagrejs/dagre';

import type {
  GraphDirection,
  GraphEdgeData,
  GraphEdgeKind,
  GraphLayout,
  GraphLayoutOptions,
  GraphNodeData,
  GraphNodeTag,
  LaidOutEdge,
  LaidOutGroup,
  LaidOutNode,
} from './types';

// Pure layout for the dependency graph: node boxes sized from Geist text
// metrics (a per-character width table, below), positions and edge routes
// from dagre (rankdir LR by default). No DOM, no React, no randomness: the
// same input gives the same output on the server and the client, so the
// SVG hydrates without a diff.

/**
 * Box metrics shared with dependency-graph.module.css (Gr8r's card: 10px
 * by 12px padding, a 13.5px medium title, a 12px quiet line, chips under
 * it). Text widths come from GEIST_500 below. Change a size here and in the
 * CSS together.
 */
export const GRAPH_METRICS = {
  /** The node's 1px border, counted inside its box. */
  border: 1,
  padX: 12,
  padY: 10,
  /** Mark slot (StatusMark's 12px diamond, StateGlyph's 14px circle) and
      the gap after it. */
  glyph: 14,
  glyphGap: 8,
  /** Label: --fs (13.5px) Geist 500 on 18px lines. */
  labelSize: 13.5,
  labelLine: 18,
  /** Key (an issue id): --fs-2xs (11px) Geist Mono, 0.6em per glyph, then
      a gap before the sublabel. */
  keyAdvance: 11 * 0.6,
  keyGap: 6,
  /** Sublabel: --fs-xs (12px) Geist on a 16px line, 2px under the label. */
  subSize: 12,
  subLine: 16,
  subGap: 2,
  /** Tag chips: the Chip atom (12px Geist 500, 7px padding, 1px border,
      20px tall), 4px apart, 8px under the text. */
  tagSize: 12,
  tagPadX: 7,
  tagHeight: 20,
  tagGap: 4,
  tagsGap: 8,
  minWidth: 176,
  maxWidth: 264,
  /** Weight pill: 11px Geist 500 tabular figures (0.62em each). */
  weightAdvance: 11 * 0.62,
  weightPadX: 5,
  weightHeight: 16,
} as const;

const M = GRAPH_METRICS;
const MAX_LABEL_LINES = 2;
const ELLIPSIS = '…';
const GROUP_PREFIX = '__group__:';
const ARROW_LENGTH = 6;
const ARROW_HALF_WIDTH = 3;

/**
 * Geist's advance widths at weight 500, in thousandths of an em, for the
 * printable ASCII characters (space to tilde), measured in the browser with
 * the body's `ss01` / `cv11` features. Weight 400 runs about 2% narrower,
 * so the same table sizes the 400 sublabel safely.
 */
const GEIST_500: readonly number[] = [
  243, 228, 361, 515, 643, 810, 649, 186, 290, 290, 427, 562, 213, 418, 213,
  391, 683, 368, 630, 625, 629, 641, 604, 550, 624, 606, 302, 302, 546, 544,
  546, 570, 925, 689, 680, 713, 711, 602, 578, 713, 699, 263, 582, 638, 556,
  873, 728, 751, 638, 745, 680, 654, 578, 696, 679, 959, 633, 613, 561, 361,
  367, 361, 438, 558, 258, 564, 599, 554, 599, 567, 337, 598, 585, 239, 269,
  562, 273, 868, 574, 579, 599, 599, 360, 528, 350, 586, 560, 829, 567, 553,
  535, 395, 274, 395, 523,
];

/** A few common characters outside ASCII, same units. */
const GEIST_500_EXTRA: Readonly<Record<string, number>> = {
  '…': 612,
  '·': 213,
  '‘': 218,
  '’': 218,
  '“': 399,
  '”': 399,
  '—': 908,
  '–': 592,
  '›': 348,
  '→': 954,
};

/** Anything else (accented letters, other scripts): a wide-ish guess. */
const FALLBACK_ADVANCE = 640;

/** Headroom for rounding and the fallback face before Geist loads. */
const WIDTH_SAFETY = 1.04;

/**
 * The rendered width in px of `text` set in Geist at `size` px: the sum of
 * each character's advance (no kerning), with a little headroom. Exact
 * enough to wrap and clip labels on the server; CSS still ellipsizes a
 * line that comes out wider.
 */
export function textWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    units +=
      code >= 32 && code < 127
        ? GEIST_500[code - 32]
        : (GEIST_500_EXTRA[ch] ?? FALLBACK_ADVANCE);
  }
  return (units * size * WIDTH_SAFETY) / 1000;
}

// Paint order: faint lines underneath, the warning and danger kinds on top
// so a risk chain or a cycle is never hidden under an ordinary edge where
// they cross.
const KIND_ORDER: Record<GraphEdgeKind, number> = {
  resolved: 0,
  default: 1,
  cross: 2,
  risk: 3,
  cycle: 4,
};

export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/**
 * Cuts `text` to fit `maxWidth` px at `size`, ending in an ellipsis when
 * cut (the longest prefix that still fits with it).
 */
export function clipText(text: string, maxWidth: number, size: number): string {
  if (textWidth(text, size) <= maxWidth) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  // Binary search on the prefix length: width grows with it.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join('').trimEnd()}${ELLIPSIS}`;
    if (textWidth(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0
    ? ELLIPSIS
    : `${chars.slice(0, lo).join('').trimEnd()}${ELLIPSIS}`;
}

/** The longest prefix of `word` (at least one character) that fits. */
function fittingPrefix(word: string, maxWidth: number, size: number): string {
  const chars = Array.from(word);
  let n = 1;
  while (
    n < chars.length &&
    textWidth(chars.slice(0, n + 1).join(''), size) <= maxWidth
  ) {
    n += 1;
  }
  return chars.slice(0, n).join('');
}

/**
 * Greedy word wrap by measured width: at most `maxLines` lines no wider
 * than `maxWidth` px at `size`; a word wider than a line is broken, and
 * whatever does not fit ends the last line with an ellipsis.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index];
    const candidate = current === '' ? word : `${current} ${word}`;
    if (textWidth(candidate, size) <= maxWidth) {
      current = candidate;
      index += 1;
    } else if (current === '') {
      // A single word wider than the line: hard-break it.
      const head = fittingPrefix(word, maxWidth, size);
      lines.push(head);
      words[index] = word.slice(head.length);
    } else {
      lines.push(current);
      current = '';
    }
  }
  if (current !== '' && lines.length < maxLines) {
    lines.push(current);
  }
  if (index < words.length || (lines.length === maxLines && current !== '')) {
    // Text remains: the last line carries the ellipsis.
    const rest = [lines[lines.length - 1] ?? '', ...words.slice(index)]
      .join(' ')
      .trim();
    lines[lines.length - 1] = clipText(rest, maxWidth, size);
  }
  return lines.length > 0 ? lines : [''];
}

/** Width of one tag chip, border included. */
function tagWidth(tag: GraphNodeTag): number {
  return Math.ceil(textWidth(tag.label, M.tagSize) + M.tagPadX * 2 + 2);
}

/** Rows a flowed set of tag chips needs inside `width`. */
function tagRows(tags: readonly GraphNodeTag[], width: number): number {
  if (tags.length === 0) return 0;
  let rows = 1;
  let used = 0;
  for (const tag of tags) {
    const w = Math.min(tagWidth(tag), width);
    const next = used === 0 ? w : used + M.tagGap + w;
    if (next > width && used > 0) {
      rows += 1;
      used = w;
    } else {
      used = next;
    }
  }
  return rows;
}

export interface NodeMeasure {
  width: number;
  height: number;
  labelLines: string[];
  sublabelLine: string;
}

/**
 * The box a node needs: wide enough for its label on one line (clamped to
 * the min/max width), the label wrapped to two lines beyond that, one line
 * of key + sublabel, and the tag chips flowed under it.
 */
export function measureNode(node: GraphNodeData): NodeMeasure {
  const marked = node.status !== undefined || node.state !== undefined;
  const lead = marked ? M.glyph + M.glyphGap : 0;
  const chrome = (M.padX + M.border) * 2 + lead;
  const tags = node.tags ?? [];
  const sublabel = node.sublabel ?? '';
  const key = node.key ?? '';
  const keyWidth =
    key === ''
      ? 0
      : key.length * M.keyAdvance + (sublabel === '' ? 0 : M.keyGap);
  let tagsRow = 0;
  for (const tag of tags) {
    tagsRow += (tagsRow === 0 ? 0 : M.tagGap) + tagWidth(tag);
  }
  const natural = Math.max(
    textWidth(node.label, M.labelSize),
    keyWidth + textWidth(sublabel, M.subSize),
    tagsRow
  );
  const width = Math.ceil(
    Math.min(M.maxWidth, Math.max(M.minWidth, natural + chrome))
  );
  const inner = width - chrome;
  const labelLines = wrapText(node.label, inner, M.labelSize, MAX_LABEL_LINES);
  const sublabelLine =
    sublabel === ''
      ? ''
      : clipText(sublabel, Math.max(0, inner - keyWidth), M.subSize);
  const hasLine = key !== '' || sublabel !== '';
  const rows = tagRows(tags, inner);
  const height =
    (M.padY + M.border) * 2 +
    labelLines.length * M.labelLine +
    (hasLine ? M.subGap + M.subLine : 0) +
    (rows === 0 ? 0 : M.tagsGap + rows * M.tagHeight + (rows - 1) * M.tagGap);
  return { width, height: Math.ceil(height), labelLines, sublabelLine };
}

type Point = { x: number; y: number };

/** Rounds to a tenth of a pixel so output is stable and compact. */
function r(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * SVG path for a uniform cubic B-spline through `points` (d3's curveBasis,
 * the curve dagre's routes are meant for): passes through both ends,
 * smooths the corners between, and leaves tangent to the last segment, so
 * the arrowhead lines up with it.
 */
export function basisPath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const [first] = points;
  if (points.length === 1) return `M${r(first.x)},${r(first.y)}`;
  if (points.length === 2) {
    const [, last] = points;
    return `M${r(first.x)},${r(first.y)}L${r(last.x)},${r(last.y)}`;
  }
  let d = `M${r(first.x)},${r(first.y)}`;
  const curve = (a: Point, b: Point, c: Point) => {
    d +=
      `C${r((2 * a.x + b.x) / 3)},${r((2 * a.y + b.y) / 3)}` +
      ` ${r((a.x + 2 * b.x) / 3)},${r((a.y + 2 * b.y) / 3)}` +
      ` ${r((a.x + 4 * b.x + c.x) / 6)},${r((a.y + 4 * b.y + c.y) / 6)}`;
  };
  const [, second] = points;
  d += `L${r((5 * first.x + second.x) / 6)},${r((5 * first.y + second.y) / 6)}`;
  for (let i = 2; i < points.length; i += 1) {
    curve(points[i - 2], points[i - 1], points[i]);
  }
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  curve(a, b, b);
  d += `L${r(b.x)},${r(b.y)}`;
  return d;
}

/** A filled triangle whose tip sits on `tip`, pointing away from `from`. */
export function arrowPath(from: Point, tip: Point): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const hypot = Math.hypot(dx, dy);
  const len = hypot === 0 ? 1 : hypot;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip.x - ux * ARROW_LENGTH;
  const by = tip.y - uy * ARROW_LENGTH;
  const px = -uy * ARROW_HALF_WIDTH;
  const py = ux * ARROW_HALF_WIDTH;
  return (
    `M${r(tip.x)},${r(tip.y)}` +
    `L${r(bx + px)},${r(by + py)}` +
    `L${r(bx - px)},${r(by - py)}Z`
  );
}

/**
 * Where the drawn curve passes the point dagre reserved for an edge label.
 * A B-spline does not run through its control points: near point i it
 * passes (p[i-1] + 4·p[i] + p[i+1]) / 6, so the label is moved there to sit
 * on the line rather than beside it.
 */
function onCurve(points: readonly Point[], target: Point): Point {
  if (points.length < 3) {
    const [a, b] = points;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  let best = 1;
  let bestDistance = Infinity;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = Math.hypot(points[i].x - target.x, points[i].y - target.y);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  const [a, b, c] = [points[best - 1], points[best], points[best + 1]];
  return { x: (a.x + 4 * b.x + c.x) / 6, y: (a.y + 4 * b.y + c.y) / 6 };
}

interface DagreNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DagreEdge {
  points?: Point[];
  x?: number;
  y?: number;
}

/**
 * Lays the graph out left to right (or top to bottom): blockers before the
 * nodes that wait on them. Edges whose ends are not both in `nodes` are
 * dropped, as are repeats of the same blocker → waiting pair (the first
 * wins). Returns top-left boxes, curved edge paths with arrowheads, weight
 * label boxes, group frames and the overall size, all in CSS pixels.
 */
export function layoutGraph(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
  options: GraphLayoutOptions = {}
): GraphLayout {
  const direction: GraphDirection = options.direction ?? 'LR';
  const horizontal = direction === 'LR';
  const hasGroups = nodes.some(
    (node) => node.group !== undefined && node.group !== ''
  );
  const cluster = options.cluster === true && hasGroups;

  if (nodes.length === 0) {
    return { width: 0, height: 0, direction, nodes: [], edges: [], groups: [] };
  }

  const g = new graphlib.Graph({ compound: cluster, multigraph: false });
  g.setGraph({
    rankdir: direction,
    // Across ranks: room for a curve, an arrowhead and a weight label.
    ranksep: horizontal ? 64 : 52,
    // Within a rank: boxes breathe but stay a column.
    nodesep: horizontal ? 22 : 28,
    edgesep: 14,
    marginx: 24,
    // Group titles sit on the frame's top rule; give them headroom.
    marginy: cluster ? 30 : 24,
    ranker: 'network-simplex',
  });
  g.setDefaultEdgeLabel(() => ({}));

  const measures = new Map<string, NodeMeasure>();
  const groupLabels = new Map<string, string>();
  for (const node of nodes) {
    if (measures.has(node.id)) continue;
    const measure = measureNode(node);
    measures.set(node.id, measure);
    g.setNode(node.id, { width: measure.width, height: measure.height });
    if (cluster && node.group !== undefined && node.group !== '') {
      const groupId = `${GROUP_PREFIX}${node.group}`;
      if (!groupLabels.has(groupId)) {
        groupLabels.set(groupId, node.group);
        g.setNode(groupId, {});
      }
      g.setParent(node.id, groupId);
    }
  }

  const kept: { edge: GraphEdgeData; key: string }[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!measures.has(edge.from) || !measures.has(edge.to)) continue;
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ edge, key });
    const weight = edge.weight ?? 1;
    const text = weight > 1 ? String(weight) : '';
    g.setEdge(edge.from, edge.to, {
      // Risk chains and cycles pull straighter: dagre shortens heavier
      // edges first.
      weight: edge.kind === 'risk' || edge.kind === 'cycle' ? 2 : 1,
      minlen: 1,
      width:
        text === ''
          ? 0
          : Math.ceil(text.length * M.weightAdvance + M.weightPadX * 2),
      height: text === '' ? 0 : M.weightHeight,
      labelpos: 'c',
    });
  }

  dagreLayout(g);

  // Boxes: dagre reports centres; snap the top-left corner to whole pixels
  // so 1px borders stay crisp.
  const placed: (LaidOutNode & { cx: number; cy: number })[] = [];
  for (const [id, measure] of measures) {
    const box = g.node(id) as DagreNode;
    placed.push({
      id,
      x: Math.round(box.x - measure.width / 2),
      y: Math.round(box.y - measure.height / 2),
      width: measure.width,
      height: measure.height,
      rank: 0,
      labelLines: measure.labelLines,
      sublabelLine: measure.sublabelLine,
      cx: r(box.x),
      cy: r(box.y),
    });
  }

  // Ranks share a centre on the rank axis; number the distinct centres.
  const rankAxis = (n: { cx: number; cy: number }) =>
    horizontal ? n.cx : n.cy;
  const crossAxis = (n: { cx: number; cy: number }) =>
    horizontal ? n.cy : n.cx;
  const centres = [...new Set(placed.map((n) => Math.round(rankAxis(n))))].sort(
    (a, b) => a - b
  );
  const rankOf = new Map(centres.map((c, i) => [c, i]));
  for (const n of placed) n.rank = rankOf.get(Math.round(rankAxis(n))) ?? 0;
  placed.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const across = crossAxis(a) - crossAxis(b);
    if (across !== 0) return across;
    return a.id < b.id ? -1 : 1;
  });

  const laidEdges: LaidOutEdge[] = [];
  for (const { edge, key } of kept) {
    const route = g.edge(edge.from, edge.to) as DagreEdge | undefined;
    const points = (route?.points ?? []).map((p) => ({ x: r(p.x), y: r(p.y) }));
    if (points.length < 2) continue;
    const weight = edge.weight ?? 1;
    const tip = points[points.length - 1];
    const before = points[points.length - 2];
    const labelWidth = Math.ceil(
      String(weight).length * M.weightAdvance + M.weightPadX * 2
    );
    const at =
      weight > 1
        ? onCurve(points, {
            x: route?.x ?? points[0].x,
            y: route?.y ?? points[0].y,
          })
        : null;
    laidEdges.push({
      key,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      weight,
      points,
      path: basisPath(points),
      arrow: arrowPath(before, tip),
      label:
        at !== null
          ? {
              x: Math.round(at.x - labelWidth / 2),
              y: Math.round(at.y - M.weightHeight / 2),
              width: labelWidth,
              height: M.weightHeight,
            }
          : null,
    });
  }
  // Array sort is stable, so edges of one kind keep their input order.
  laidEdges.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const groups: LaidOutGroup[] = [];
  for (const [groupId, label] of groupLabels) {
    const box = g.node(groupId) as DagreNode | undefined;
    if (box === undefined || !Number.isFinite(box.x)) continue;
    groups.push({
      id: label,
      label,
      x: Math.round(box.x - box.width / 2),
      y: Math.round(box.y - box.height / 2),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  }
  groups.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  // The canvas covers everything drawn, plus the margin on the far sides.
  const graph = g.graph() as { width?: number; height?: number };
  let width = graph.width ?? 0;
  let height = graph.height ?? 0;
  for (const n of placed) {
    width = Math.max(width, n.x + n.width + 24);
    height = Math.max(height, n.y + n.height + 24);
  }
  for (const grp of groups) {
    width = Math.max(width, grp.x + grp.width + 24);
    height = Math.max(height, grp.y + grp.height + 24);
  }
  for (const e of laidEdges) {
    for (const p of e.points) {
      width = Math.max(width, p.x + 24);
      height = Math.max(height, p.y + 24);
    }
  }

  return {
    width: Math.ceil(width),
    height: Math.ceil(height),
    direction,
    nodes: placed.map(({ cx: _cx, cy: _cy, ...node }) => node),
    edges: laidEdges,
    groups,
  };
}
