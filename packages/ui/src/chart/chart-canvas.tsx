'use client';

import { Maximize, Minus, Plus } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
} from 'react';

import { cx } from '../tasks/class-names';
import {
  type ChartLayout,
  type PlacedBox,
  type Point,
  roundedPath,
} from './chart-layout';
import styles from './dependency-chart.module.css';
import type { ChartViewportApi } from './use-chart-viewport';

/** How a box reads while something is selected: the selection itself,
    what it waits on, what it holds up, a member of a highlighted set, or
    faded into the background. */
export type NodeTrace = 'sel' | 'up' | 'down' | 'set' | 'dim';

/** An edge's look: at rest, traced up or down from the selection, inside
    a highlighted set, or faded. */
export type EdgeTone = 'idle' | 'up' | 'down' | 'set' | 'dim';

export interface CanvasEdge {
  id: string;
  points: readonly Point[];
  labelAt: Point;
  tone: EdgeTone;
  /** Dotted: the wait no longer blocks (one end is done). */
  resolved?: boolean;
  /** On a blocking cycle: long red dashes at rest. */
  cycle?: boolean;
  /** A count pill on the edge's longest run (relations it stands for). */
  label?: string;
  /** Says in words what the pill counts. */
  hint?: string;
}

/** A frame the layout boxed boxes into, with what a double-click on its
    title opens. */
export interface CanvasGroupAction {
  label: string;
  onOpen: () => void;
}

/** The marker per line colour; a faded edge keeps its idle marker. */
type MarkerKey = 'idle' | 'up' | 'down' | 'set' | 'cycle';
const MARKER_KEYS: readonly MarkerKey[] = [
  'idle',
  'up',
  'down',
  'set',
  'cycle',
];

function markerOf(edge: CanvasEdge): MarkerKey {
  if (edge.tone === 'up' || edge.tone === 'down' || edge.tone === 'set') {
    return edge.tone;
  }
  return edge.cycle === true && edge.tone === 'idle' ? 'cycle' : 'idle';
}

/** A short line in a trace colour: the legend's and the inspector's key. */
export function TraceSwatch({ dir }: { dir: 'up' | 'down' }) {
  return <span aria-hidden className={styles.traceSwatch} data-dir={dir} />;
}

/** One edge: the routed line and an optional count pill. */
function ChartEdge({
  edge,
  markerId,
}: {
  edge: CanvasEdge;
  markerId: (key: MarkerKey) => string;
}) {
  const d = roundedPath(edge.points);
  const pillWidth = edge.label === undefined ? 0 : edge.label.length * 7 + 12;
  return (
    <g
      data-chart-edge=""
      data-tone={edge.tone}
      data-resolved={edge.resolved === true ? '' : undefined}
      data-cycle={edge.cycle === true ? '' : undefined}
      className={styles.edge}
    >
      <path
        d={d}
        className={styles.edgeLine}
        markerEnd={`url(#${markerId(markerOf(edge))})`}
      />
      {edge.label !== undefined ? (
        <g className={styles.edgePill}>
          {edge.hint !== undefined ? <title>{edge.hint}</title> : null}
          <rect
            x={edge.labelAt.x - pillWidth / 2}
            y={edge.labelAt.y - 9}
            width={pillWidth}
            height={18}
            rx={9}
          />
          <text x={edge.labelAt.x} y={edge.labelAt.y + 4} textAnchor="middle">
            {edge.label}
          </text>
        </g>
      ) : null}
    </g>
  );
}

interface ChartCanvasProps {
  viewport: ChartViewportApi;
  layout: ChartLayout | null;
  /** Shown over the stage while laying out, or when the layout failed. */
  message: string | null;
  edges: readonly CanvasEdge[];
  /** A box's body; it fills the placed box. */
  renderNode: (box: PlacedBox) => ReactNode;
  nodeTrace: (id: string) => NodeTrace | null;
  /** What a double-click on a frame's title opens, by group id. */
  groupAction: (id: string) => CanvasGroupAction | null;
  /** A plain click on the canvas itself (not a box or a control). */
  onBackgroundClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFit: () => void;
  legend: ReactNode;
  ariaLabel: string;
}

/**
 * The stage the dependency chart draws on, panned and zoomed by hand: a
 * dotted canvas, one layer holding the routed SVG edges and frames under
 * absolutely placed boxes (real buttons, so focus and keyboard work),
 * zoom controls and a legend. The layer is moved by useChartViewport
 * with a CSS transform, so panning never re-renders the chart.
 */
export function ChartCanvas({
  viewport,
  layout,
  message,
  edges,
  renderNode,
  nodeTrace,
  groupAction,
  onBackgroundClick,
  onKeyDown,
  onFit,
  legend,
  ariaLabel,
}: ChartCanvasProps) {
  // The viewport's element callbacks, wrapped so the ref props get plain
  // stable functions rather than members of the viewport object.
  const attachStage = useCallback(
    (el: HTMLDivElement | null) => viewport.attachStage(el),
    [viewport]
  );
  const attachLayer = useCallback(
    (el: HTMLDivElement | null) => viewport.attachLayer(el),
    [viewport]
  );
  const uid = useId().replace(/:/g, '');
  const markerId = (key: MarkerKey) => `chart-arrow-${key}-${uid}`;
  const width = layout?.width ?? 0;
  const height = layout?.height ?? 0;
  // Whether the press that ends in a click began on the bare canvas: a
  // popover that closes on pointerup lets the click land on whatever was
  // under it, and that click must not drop the selection it just made.
  const pressedBare = useRef(false);
  const isBare = (target: EventTarget) =>
    (target as Element).closest(
      '[data-chart-node],[data-chart-group-title],[data-chart-ignore]'
    ) === null;
  return (
    <div
      ref={attachStage}
      data-chart-stage=""
      // Focusable so the chart's keys (/, Esc, 0, +, −) work after a click
      // on the canvas; the boxes inside carry the visible focus rings.
      tabIndex={0}
      className={styles.stage}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        pressedBare.current = isBare(event.target);
      }}
      onClick={(event) => {
        const bare = pressedBare.current;
        pressedBare.current = false;
        if (!bare || viewport.wasDrag() || !isBare(event.target)) return;
        onBackgroundClick();
      }}
    >
      <div
        ref={attachLayer}
        role="group"
        aria-label={ariaLabel}
        className={styles.layer}
        style={{ width, height }}
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}
          className={styles.svg}
          aria-hidden
        >
          <defs>
            {MARKER_KEYS.map((key) => (
              <marker
                key={key}
                id={markerId(key)}
                viewBox="0 0 10 10"
                refX={9}
                refY={5}
                markerWidth={key === 'idle' || key === 'cycle' ? 7 : 6}
                markerHeight={key === 'idle' || key === 'cycle' ? 7 : 6}
                orient="auto-start-reverse"
              >
                <path
                  d="M0 0L10 5L0 10z"
                  className={styles.marker}
                  data-marker={key}
                />
              </marker>
            ))}
          </defs>
          {layout?.groups.map((group) => (
            <rect
              key={group.id}
              data-chart-group={group.id}
              data-depth={group.depth}
              className={styles.group}
              x={group.x}
              y={group.y}
              width={group.width}
              height={group.height}
              rx={8}
            />
          ))}
          {edges.map((edge) => (
            <ChartEdge key={edge.id} edge={edge} markerId={markerId} />
          ))}
        </svg>
        {layout?.groups.map((group) => {
          const action = groupAction(group.id);
          return (
            <span
              key={group.id}
              data-chart-group-title={group.id}
              className={cx(
                styles.groupTitle,
                action !== null && styles.groupTitleAction
              )}
              style={{
                left: group.x + 14,
                top: group.y + 12,
                maxWidth: Math.max(group.width - 28, 0),
              }}
              title={action === null ? group.label : action.label}
              onDoubleClick={action === null ? undefined : action.onOpen}
            >
              {group.label}
            </span>
          );
        })}
        {layout !== null
          ? [...layout.nodes.values()].map((box) => {
              const trace = nodeTrace(box.id);
              return (
                <div
                  key={box.id}
                  data-chart-node={box.id}
                  data-trace={trace ?? undefined}
                  className={styles.nodeSlot}
                  style={{
                    left: box.x,
                    top: box.y,
                    width: box.width,
                    height: box.height,
                  }}
                >
                  {renderNode(box)}
                </div>
              );
            })
          : null}
      </div>
      <div data-chart-ignore="" className={styles.zoom}>
        <ZoomButton label="Zoom in (+)" onClick={() => viewport.zoomBy(1.35)}>
          <Plus size={14} strokeWidth={1.8} aria-hidden />
        </ZoomButton>
        <ZoomButton
          label="Zoom out (−)"
          onClick={() => viewport.zoomBy(1 / 1.35)}
        >
          <Minus size={14} strokeWidth={1.8} aria-hidden />
        </ZoomButton>
        <ZoomButton label="Fit the whole chart (0)" onClick={onFit}>
          <Maximize size={14} strokeWidth={1.8} aria-hidden />
        </ZoomButton>
      </div>
      <div data-chart-ignore="" data-chart-legend="" className={styles.legend}>
        {legend}
        <span className={styles.legendHint}>Drag to pan · scroll to zoom</span>
      </div>
      {message !== null ? (
        <div data-chart-message="" className={styles.message}>
          {message}
        </div>
      ) : null}
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.zoomButton}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
