'use client';

import { Maximize, Minus, Plus } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
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
import { blockerIndex, upstreamChain, waiterIndex } from './chain';
import styles from './dependency-graph.module.css';
import { layoutGraph } from './layout';
import type {
  DependencyGraphProps,
  GraphEdgeKind,
  GraphNodeData,
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

const EDGE_WORDS: Record<GraphEdgeKind, string> = {
  default: 'blocks',
  risk: 'blocks, on a risk chain',
  cycle: 'blocks, in a cycle',
  cross: 'blocks, across projects',
  resolved: 'blocked, now resolved',
};

const EDGE_CLASS: Record<GraphEdgeKind, string | undefined> = {
  default: styles.edgeDefault,
  risk: styles.edgeRisk,
  cycle: styles.edgeCycle,
  cross: styles.edgeCross,
  resolved: styles.edgeResolved,
};

/** A node or edge while a chain is shown: the node being read, part of
    its upstream chain, or receding. */
type HighlightState = 'active' | 'lit' | 'dim';

const STATE_CLASS: Record<HighlightState, string | undefined> = {
  active: styles.active,
  lit: styles.lit,
  dim: styles.dim,
};

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
 * The sentence a screen reader hears on a node: name, context, status,
 * flags, scope, how many open edges touch it, and last the focus words
 * when the graph is about this node.
 */
function nodeName(
  node: GraphNodeData,
  waitsOn: number,
  holdsUp: number,
  focusWords: string | null
): string {
  const parts = [node.label];
  if (node.sublabel !== undefined && node.sublabel !== '') {
    parts.push(node.sublabel);
  }
  if (node.statusLabel !== undefined && node.statusLabel !== '') {
    parts.push(node.statusLabel);
  }
  const tags = node.tags ?? [];
  if (tags.length > 0) parts.push(tags.map((t) => t.toLowerCase()).join(', '));
  if (node.external === true) parts.push('outside this scope');
  parts.push(`waits on ${waitsOn}, blocks ${holdsUp}`);
  if (focusWords !== null && focusWords !== '') parts.push(focusWords);
  return `${parts.join('. ')}.`;
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
 * in the neighbouring rank; across it, it steps within the rank.
 */
function neighbour(
  nodes: readonly LaidOutNode[],
  current: LaidOutNode,
  key: string,
  horizontal: boolean
): LaidOutNode | null {
  if (key === 'Home') return nodes[0] ?? null;
  if (key === 'End') return nodes[nodes.length - 1] ?? null;
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
 * the status hues for risk (amber chains, dashed red cycles, a red flood
 * for overdue, a 2px rule in the node's tone), dashes for project
 * crossings, grey for what is already resolved. The purple accent is never
 * a status here: it is the hover flood and the keyboard focus.
 *
 * - Hover or focus a node: its upstream chain (everything it transitively
 *   waits on) stays lit and the rest dims. With nothing hovered, the
 *   selected node's chain stays lit.
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
  toolbar,
  hint = 'Drag to pan · Ctrl + wheel to zoom',
  layout: givenLayout,
  focusId = null,
  focusLabel = 'focus',
  coveredRight,
  className,
}: DependencyGraphProps): ReactNode {
  // A host-computed layout is used as is; dagre runs only without one.
  const layout = useMemo(
    () => givenLayout ?? layoutGraph(nodes, edges, { direction, cluster }),
    [givenLayout, nodes, edges, direction, cluster]
  );
  const horizontal = layout.direction === 'LR';
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const blockers = useMemo(() => blockerIndex(edges), [edges]);
  const waiters = useMemo(() => waiterIndex(edges), [edges]);

  const [hoverId, setHoverId] = useState<string | null>(null);
  // The node holding keyboard focus (not the `focusId` prop, which names
  // the node the whole graph is about).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const candidate = hoverId ?? focusedId ?? selectedId;
  const activeId = candidate !== null && byId.has(candidate) ? candidate : null;
  const chain = useMemo(
    () => (activeId === null ? null : upstreamChain(activeId, blockers)),
    [activeId, blockers]
  );
  const lit = useMemo(
    () => (chain === null ? null : new Set([chain.id, ...chain.nodeIds])),
    [chain]
  );

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
  // drawing under the reader.
  const centredRef = useRef(false);
  const centreId = focusId ?? selectedId;
  useIsomorphicLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (centredRef.current || !hasNodes || viewport === null) return;
    centredRef.current = true;
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
  }, [hasNodes, centreId, layout]);

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
    const next = neighbour(layout.nodes, node, event.key, horizontal);
    if (next === null) return;
    event.preventDefault();
    focusNode(next.id);
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
  const labelOf = (id: string) => byId.get(id)?.label ?? id;

  return (
    <div className={cx(styles.graph, className)} onKeyDown={onFrameKeyDown}>
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
            {layout.groups.map((group) => (
              <div
                key={group.id}
                className={styles.group}
                style={{
                  left: group.x,
                  top: group.y,
                  width: group.width,
                  height: group.height,
                }}
                aria-hidden="true"
              >
                <span className={styles.groupTitle}>{group.label}</span>
              </div>
            ))}

            <svg
              className={styles.edges}
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label={ariaSummary}
            >
              {layout.edges.map((edge) => {
                const state: HighlightState | undefined =
                  chain === null
                    ? undefined
                    : chain.edgeKeys.has(edge.key)
                      ? 'lit'
                      : 'dim';
                return (
                  <g
                    key={edge.key}
                    className={cx(
                      styles.edge,
                      EDGE_CLASS[edge.kind],
                      state === undefined ? undefined : STATE_CLASS[state]
                    )}
                    data-edge={edge.key}
                    data-kind={edge.kind}
                    data-state={state}
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
              })}
            </svg>

            {layout.nodes.map((box) => {
              const node = byId.get(box.id);
              if (node === undefined) return null;
              const tags = node.tags ?? [];
              const overdue = tags.includes('OVERDUE');
              const inCycle = tags.includes('CYCLE');
              const selected = box.id === selectedId;
              const focus = box.id === focusId;
              const state: HighlightState | undefined =
                lit === null
                  ? undefined
                  : box.id === activeId
                    ? 'active'
                    : lit.has(box.id)
                      ? 'lit'
                      : 'dim';
              // A status tone (or a host's accent) draws the 2px rule in
              // its hue through the data-tone hook (tokens.css); muted
              // keeps its own faint look.
              const tone =
                node.tone === 'default' || node.tone === 'muted'
                  ? undefined
                  : node.tone;
              const classes = cx(
                styles.node,
                tone !== undefined && styles.toned,
                node.tone === 'muted' && styles.toneMuted,
                node.external === true && styles.external,
                overdue && styles.overdueNode,
                inCycle && styles.cycle,
                selected && styles.selected,
                focus && styles.focus,
                state === undefined ? undefined : STATE_CLASS[state]
              );
              const position: CSSProperties = {
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
              };
              const name = nodeName(
                node,
                blockers.get(box.id)?.length ?? 0,
                waiters.get(box.id)?.length ?? 0,
                focus ? focusLabel : null
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
                    {tags.length > 0 ? (
                      <span className={styles.tags}>
                        {tags.map((tag) => (
                          <span
                            key={tag}
                            className={cx(
                              styles.tag,
                              tag === 'UNASSIGNED' && styles.tagWarning
                            )}
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </>
              );
              const handlers = {
                'data-graph-node': box.id,
                'data-state': state,
                'data-focus': focus ? '' : undefined,
                ref: (el: HTMLElement | null) => {
                  if (el === null) nodeRefs.current.delete(box.id);
                  else nodeRefs.current.set(box.id, el);
                },
                onFocus: () => {
                  setFocusedId(box.id);
                  setRovingId(box.id);
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
                    onClick={() => onSelect(box.id)}
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
                  {...handlers}
                >
                  {body}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Key help every node points at (aria-describedby). */}
      <p id={helpId} className="srOnly">
        {onSelect !== undefined
          ? 'Arrow keys move between nodes, Home and End jump to the first and last, Enter selects. Minus, plus and 0 zoom.'
          : 'Arrow keys move between nodes, Home and End jump to the first and last. Minus, plus and 0 zoom.'}
      </p>

      {/* A table ignores width and overflow, so the visually-hidden
          wrapper is a div. The drawing already carries the summary, so
          the caption names the table rather than repeating it. */}
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
                <td>{labelOf(edge.from)}</td>
                <td>{labelOf(edge.to)}</td>
                <td>{EDGE_WORDS[edge.kind]}</td>
                <td>{edge.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
