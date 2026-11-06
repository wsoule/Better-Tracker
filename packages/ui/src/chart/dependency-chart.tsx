'use client';

import { PanelRight, Search, SlidersHorizontal } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type {
  GraphClusterData,
  GraphEdgeData,
  GraphNodeData,
} from '../graph/types';
import { Kbd } from '../shell/kbd';
import { cx } from '../tasks/class-names';
import { EmptyState } from '../tasks/notice';
import { Switch } from '../tasks/switch';
import {
  type CanvasEdge,
  type CanvasGroupAction,
  ChartCanvas,
  type EdgeTone,
  type NodeTrace,
  TraceSwatch,
} from './chart-canvas';
import {
  countOf,
  InspectorOverview,
  NodeInspector,
  SetInspector,
} from './chart-inspector';
import { type ChartLayout, type ChartSpec, layoutChart } from './chart-layout';
import {
  type ChartModel,
  chartModel,
  drawnNodes,
  pairKey,
  traceChart,
} from './chart-model';
import { ChartNodeCard, STATE_LEGEND, StateSwatch } from './chart-node';
import { chartSpec } from './chart-spec';
import { type Box, unionBox } from './chart-viewport';
import styles from './dependency-chart.module.css';
import { type ChartViewportApi, useChartViewport } from './use-chart-viewport';

/** The chart's display choices, remembered per scope (`prefsKey`). */
export interface ChartPrefs {
  hideDone: boolean;
  showUnlinked: boolean;
  /** Draw boxes inside their frames (off by default: frames stretch the
      layout; each card names its frames instead). */
  framed: boolean;
  inspector: boolean;
}

export const DEFAULT_CHART_PREFS: ChartPrefs = {
  hideDone: false,
  showUnlinked: false,
  framed: false,
  inspector: true,
};

const PREFS_PREFIX = 'bt:graph-chart:';

// The chart's display choices per scope: kept in localStorage (and in
// memory, for a browser whose storage throws) and read through
// useSyncExternalStore, so the server and the first client render agree
// (both read nothing) and every chart on the page sees a change at once.
const memoryPrefs = new Map<string, string>();
const prefsListeners = new Set<() => void>();

function readStoredPrefs(key: string): string | null {
  const kept = memoryPrefs.get(key);
  if (kept !== undefined) return kept;
  try {
    return localStorage.getItem(PREFS_PREFIX + key);
  } catch {
    return null;
  }
}

function writeStoredPrefs(key: string, prefs: ChartPrefs): void {
  const raw = JSON.stringify(prefs);
  memoryPrefs.set(key, raw);
  try {
    localStorage.setItem(PREFS_PREFIX + key, raw);
  } catch {
    // Kept in memory for this page only.
  }
  for (const listener of prefsListeners) listener();
}

function subscribePrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  return () => prefsListeners.delete(listener);
}

// Reads each flag on its own, so a stored object from an older shape
// keeps what still fits.
function parsePrefs(raw: string | null, defaults: ChartPrefs): ChartPrefs {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (typeof value !== 'object' || value === null) return defaults;
    const flag = (name: keyof ChartPrefs) => {
      const stored: unknown = Reflect.get(value, name);
      return typeof stored === 'boolean' ? stored : defaults[name];
    };
    return {
      hideDone: flag('hideDone'),
      showUnlinked: flag('showUnlinked'),
      framed: flag('framed'),
      inspector: flag('inspector'),
    };
  } catch {
    return defaults;
  }
}

/** What the chart has selected: one box, or a highlight preset (kept by
    id, so it follows the data). */
type Selection = { kind: 'node'; id: string } | { kind: 'preset'; id: string };

interface Preset {
  id: string;
  label: string;
  blurb: (unit: readonly [string, string]) => string;
  ids: (model: ChartModel) => readonly string[];
}

// The toolbar's highlights: Vadim's Longest chain (the planner's critical
// path), Ready and In progress, and the planner's risk warnings in place
// of Dispatch's "Needs you".
const PRESETS: readonly Preset[] = [
  {
    id: 'critical',
    label: 'Critical path',
    blurb: ([, many]) =>
      `The longest run of open ${many} where each waits on the one before. Nothing at its end can finish until every step before it does.`,
    ids: (model) => model.longestChain,
  },
  {
    id: 'ready',
    label: 'Ready',
    blurb: ([, many]) =>
      `Open ${many} in the blocking flow whose blockers are all done.`,
    ids: (model) => model.readyNow,
  },
  {
    id: 'progress',
    label: 'In progress',
    blurb: ([, many]) => `Open ${many} whose work has started.`,
    ids: (model) => model.inProgress,
  },
  {
    id: 'risk',
    label: 'At risk',
    blurb: ([, many]) =>
      `Open ${many} that are overdue, unassigned, on a cycle, or wait on one that is.`,
    ids: (model) => model.atRisk,
  },
];

const ZOOM_STEP = 1.35;
// Below this stage width a whole chart is too small to read, so the first
// fit frames the head of the critical path instead.
const NARROW_STAGE_PX = 600;

/** The world box around some placed boxes, with room to breathe. */
function boxOf(layout: ChartLayout, ids: Iterable<string>): Box | null {
  const boxes: Box[] = [];
  for (const id of ids) {
    const box = layout.nodes.get(id);
    if (box !== undefined) boxes.push(box);
  }
  const union = unionBox(boxes);
  if (union === null) return null;
  return {
    x: union.x - 20,
    y: union.y - 20,
    width: union.width + 40,
    height: union.height + 40,
  };
}

function wholeBox(layout: ChartLayout): Box {
  return { x: 0, y: 0, width: layout.width, height: layout.height };
}

/** Whether a world box shows entirely on the stage. */
function onStage(viewport: ChartViewportApi, box: Box): boolean {
  const { x, y, k } = viewport.transform();
  const { width, height } = viewport.size();
  const left = box.x * k + x;
  const top = box.y * k + y;
  return (
    left >= 0 &&
    top >= 0 &&
    left + box.width * k <= width &&
    top + box.height * k <= height
  );
}

/** An id made safe inside an attribute selector. */
function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');
}

/** Per-box and per-edge emphasis for the current selection. */
interface Highlight {
  node: (id: string) => NodeTrace | null;
  edge: (from: string, to: string) => EdgeTone | null;
}

const AT_REST: Highlight = { node: () => null, edge: () => null };

/**
 * What lights up for a selection: a box lights everything upstream amber
 * and downstream teal (an edge counts as traced only when both its ends
 * are, so a blocker's other dependents stay faded); a set lights its
 * members and the edges between them; everything else fades.
 */
function highlightFor(
  selection: Selection | null,
  setIds: readonly string[] | null,
  model: ChartModel
): Highlight {
  if (selection === null) return AT_REST;
  if (selection.kind === 'node') {
    const sel = selection.id;
    const up = traceChart(model, sel, 'up');
    const down = traceChart(model, sel, 'down');
    return {
      node: (id) =>
        id === sel ? 'sel' : up.has(id) ? 'up' : down.has(id) ? 'down' : 'dim',
      edge: (from, to) =>
        up.has(from) && (to === sel || up.has(to))
          ? 'up'
          : down.has(to) && (from === sel || down.has(from))
            ? 'down'
            : 'dim',
    };
  }
  if (setIds === null || setIds.length === 0) return AT_REST;
  const members = new Set(setIds);
  return {
    node: (id) => (members.has(id) ? 'set' : 'dim'),
    edge: (from, to) => (members.has(from) && members.has(to) ? 'set' : 'dim'),
  };
}

export interface DependencyChartProps {
  nodes: readonly GraphNodeData[];
  edges: readonly GraphEdgeData[];
  /** The frames boxes sit in; "Box by parent" draws them. */
  clusters?: readonly GraphClusterData[];
  /** Keys the remembered display choices (the scope being drawn). */
  prefsKey: string;
  /** Display choices before the reader makes any here. */
  defaultPrefs?: Partial<ChartPrefs>;
  /** The box selected (traced) on arrival. */
  initialSelectedId?: string | null;
  /** The box the chart is about (a chain's issue): ringed, always drawn. */
  focusId?: string | null;
  /** The drawn thing, singular and plural ("issue", "issues"). */
  unit?: readonly [string, string];
  /** Opens a box (the inspector's primary button; the default for a
      double-click). */
  onOpen?: (id: string) => void;
  /** The inspector's primary button words for a box, or null for none. */
  openLabel?: (node: GraphNodeData) => string | null;
  /** A double-click on a box. Default: onOpen. */
  onActivate?: (id: string) => void;
  /** Follows a box's or a frame's drillHref (a double-click on a frame
      title). Default: a full page load. */
  onDrill?: (href: string) => void;
  /** Rewrites every drillHref before it is drawn or followed. */
  drillHrefFor?: (href: string) => string;
  /** Told when the traced box changes (null when cleared). */
  onSelectionChange?: (id: string | null) => void;
  /** Controls at the start of the toolbar (the host's level tabs). */
  toolbar?: ReactNode;
  /** The canvas group's accessible name. */
  ariaLabel: string;
  /** Honest copy for a chart with nothing to draw. */
  emptyMessage: string;
  className?: string;
}

/**
 * The interactive dependency chart (Vadim Sevriuk's, from the Dispatch
 * desktop): boxes laid out left to right by elkjs with right-angle edges
 * on a dotted canvas that pans and zooms. Clicking a box traces what it
 * waits on in amber and what it holds up in teal, fading the rest, and an
 * inspector lists both with the transitive reach. The toolbar finds a box
 * (/), highlights the critical path, what is ready, in progress or at
 * risk, and holds the display toggles (hide done, show unlinked, box by
 * parent, inspector), remembered per scope.
 */
export function DependencyChart({
  nodes,
  edges,
  clusters = [],
  prefsKey,
  defaultPrefs,
  initialSelectedId = null,
  focusId = null,
  unit = ['box', 'boxes'],
  onOpen,
  openLabel,
  onActivate,
  onDrill,
  drillHrefFor,
  onSelectionChange,
  toolbar,
  ariaLabel,
  emptyMessage,
  className,
}: DependencyChartProps) {
  const defaults = useMemo(
    () => ({ ...DEFAULT_CHART_PREFS, ...defaultPrefs }),
    [defaultPrefs]
  );
  const storedRaw = useSyncExternalStore(
    subscribePrefs,
    () => readStoredPrefs(prefsKey),
    () => null
  );
  const prefs = useMemo(
    () => parsePrefs(storedRaw, defaults),
    [storedRaw, defaults]
  );
  const initial = initialSelectedId ?? focusId;
  const [selection, setSelection] = useState<Selection | null>(
    initial === null ? null : { kind: 'node', id: initial }
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const viewport = useChartViewport();

  const model = useMemo(
    () => chartModel(nodes, edges, clusters),
    [nodes, edges, clusters]
  );
  const framesOffered = clusters.length > 0;
  const framed = prefs.framed && framesOffered;

  const drawn = useMemo(
    () =>
      drawnNodes(model, {
        hideDone: prefs.hideDone,
        showUnlinked: prefs.showUnlinked,
        keep: focusId,
      }),
    [model, prefs.hideDone, prefs.showUnlinked, focusId]
  );
  const drawnSet = useMemo(() => new Set(drawn), [drawn]);
  // Everything the chart can draw with every toggle open: what search
  // lists and what a pick can trace.
  const findable = model.order;
  const hiddenUnlinked =
    !prefs.showUnlinked && model.linked.size > 0
      ? model.order.filter((id) => !model.linked.has(id) && id !== focusId)
          .length
      : 0;

  const presetIds = useCallback(
    (id: string): readonly string[] | null =>
      PRESETS.find((p) => p.id === id)?.ids(model) ?? null,
    [model]
  );

  // A box that is no longer drawn (a toggle hid it) is no selection.
  const active: Selection | null =
    selection === null
      ? null
      : selection.kind === 'node'
        ? drawnSet.has(selection.id)
          ? selection
          : null
        : presetIds(selection.id) === null
          ? null
          : selection;
  const activeSet = active?.kind === 'preset' ? presetIds(active.id) : null;
  const selectedId = active?.kind === 'node' ? active.id : null;

  const changeRef = useRef(onSelectionChange);
  useEffect(() => {
    changeRef.current = onSelectionChange;
  });
  const lastTold = useRef<string | null>(selectedId);
  useEffect(() => {
    if (lastTold.current === selectedId) return;
    lastTold.current = selectedId;
    changeRef.current?.(selectedId);
  }, [selectedId]);

  // The spec is rebuilt from JSON so its identity changes only when its
  // content does: a render that moves nothing never re-runs the layout.
  const specJson = useMemo(
    (): string =>
      drawn.length === 0
        ? ''
        : JSON.stringify(chartSpec(model, drawn, clusters, framed)),
    [drawn, framed, model, clusters]
  );
  const spec = useMemo(
    (): ChartSpec | null =>
      specJson === '' ? null : (JSON.parse(specJson) as ChartSpec),
    [specJson]
  );

  const [placed, setPlaced] = useState<{
    spec: ChartSpec;
    layout: ChartLayout;
  } | null>(null);
  // A failed layout, tagged with the spec it failed for, so the next spec
  // starts with no error showing.
  const [failed, setFailed] = useState<{
    spec: ChartSpec;
    message: string;
  } | null>(null);
  const layoutError =
    failed !== null && failed.spec === spec ? failed.message : null;
  useEffect(() => {
    if (spec === null) return undefined;
    let live = true;
    layoutChart(spec).then(
      (result) => {
        if (live) setPlaced({ spec, layout: result });
      },
      (error: unknown) => {
        if (!live) return;
        setFailed({
          spec,
          message: `The chart could not be laid out: ${error instanceof Error ? error.message : 'unknown error'}`,
        });
      }
    );
    return () => {
      live = false;
    };
  }, [spec]);
  // A stale layout stays up while the next one computes.
  const shown = spec !== null && placed !== null ? placed.layout : null;
  const current =
    placed !== null && placed.spec === spec ? placed.layout : null;

  const framedIds = useMemo((): string[] => {
    if (active === null) return [];
    if (active.kind === 'node') return [active.id];
    return [...(activeSet ?? [])];
  }, [active, activeSet]);

  // A pending "zoom to these" for the next layout (a pick that had to turn
  // a toggle on first); what the chart was last framed for (the toggles
  // that reshape it), so only those changes fit the whole chart again;
  // and the layout last placed.
  const focusRef = useRef<{
    ids: ReadonlySet<string>;
    maxScale: number;
  } | null>(null);
  const framingKey = `${prefs.hideDone}|${prefs.showUnlinked}|${framed}`;
  const framedRef = useRef<string | null>(null);
  const lastLayoutRef = useRef<ChartLayout | null>(null);
  // A layout effect, so a new layout never paints a frame at the previous
  // framing.
  useLayoutEffect(() => {
    if (placed === null || placed.spec !== spec) return;
    const next = placed.layout;
    const previous = lastLayoutRef.current;
    if (previous === next) return;
    lastLayoutRef.current = next;
    const focus = focusRef.current;
    focusRef.current = null;
    const focusBox = focus === null ? null : boxOf(next, focus.ids);
    if (focusBox !== null && focus !== null) {
      framedRef.current = framingKey;
      viewport.fit(focusBox, { maxScale: focus.maxScale });
      return;
    }
    if (framedRef.current !== framingKey) {
      const first = framedRef.current === null;
      framedRef.current = framingKey;
      const head = model.longestChain[0];
      const narrow =
        viewport.size().width > 0 && viewport.size().width < NARROW_STAGE_PX;
      const headBox =
        first && narrow && head !== undefined ? boxOf(next, [head]) : null;
      if (headBox !== null) {
        viewport.fit(headBox, { maxScale: 0.6, animate: false });
      } else {
        viewport.fit(wholeBox(next), { animate: false });
      }
      return;
    }
    // The same chart redrawn: keep the selected box where it was.
    const before =
      selectedId === null ? undefined : previous?.nodes.get(selectedId);
    const after = selectedId === null ? undefined : next.nodes.get(selectedId);
    if (before !== undefined && after !== undefined) {
      const { k } = viewport.transform();
      viewport.pan((before.x - after.x) * k, (before.y - after.y) * k);
    } else if (!viewport.moved()) {
      viewport.fit(wholeBox(next), { animate: false });
    }
  }, [placed, spec, viewport, framingKey, model, selectedId]);

  const fitAll = useCallback(() => {
    if (current !== null) viewport.fit(wholeBox(current));
  }, [current, viewport]);

  // On a resize, an untouched chart refits; a selection that would end up
  // partly off the stage (an opened panel narrows it) is framed again at
  // no more than the current zoom; a view the reader moved is left alone.
  const resizeRef = useRef(() => {});
  useEffect(() => {
    resizeRef.current = () => {
      if (current === null) return;
      if (framedIds.length > 0) {
        const box = boxOf(current, framedIds);
        if (box !== null && !onStage(viewport, box)) {
          viewport.fit(box, {
            maxScale: viewport.transform().k,
            animate: false,
          });
        }
      } else if (!viewport.moved()) {
        viewport.fit(wholeBox(current), { animate: false });
      }
    };
  });
  useEffect(() => {
    viewport.onResize(() => resizeRef.current());
    return () => viewport.onResize(null);
  }, [viewport]);

  /** Zooms to `ids` now, or once the layout a toggle change starts lands. */
  const focusOn = (
    ids: ReadonlySet<string>,
    maxScale: number,
    awaitsLayout: boolean
  ) => {
    const box = !awaitsLayout && current !== null ? boxOf(current, ids) : null;
    if (box !== null) viewport.fit(box, { maxScale });
    else focusRef.current = { ids, maxScale };
  };

  const updatePrefs = (patch: Partial<ChartPrefs>) => {
    writeStoredPrefs(prefsKey, { ...prefs, ...patch });
  };

  /** The toggle changes that put `ids` on the chart. */
  const revealPatch = (ids: readonly string[]): Partial<ChartPrefs> => {
    const patch: Partial<ChartPrefs> = {};
    for (const id of ids) {
      const node = model.nodes.get(id);
      if (node === undefined || drawnSet.has(id)) continue;
      if (prefs.hideDone && (node.state === 'done' || node.state === 'empty')) {
        patch.hideDone = false;
      }
      if (!prefs.showUnlinked && !model.linked.has(id)) {
        patch.showUnlinked = true;
      }
    }
    return patch;
  };

  // A pick made from the inspector replaces the row that held focus;
  // focus follows to the picked box so the keyboard keeps its place.
  const asideRef = useRef<HTMLElement | null>(null);
  // The box keyboard focus moves to once it is drawn (a pick from the
  // inspector); consumed by the effect below.
  const focusNodeRef = useRef<string | null>(null);
  const fromInspector = () =>
    asideRef.current?.contains(document.activeElement) === true;

  /** Selects a box from anywhere (search, the inspector, a set), opening
      toggles as needed, and zooms to it. */
  const goTo = (id: string) => {
    if (!model.nodes.has(id)) return;
    const patch = revealPatch([id]);
    const awaitsLayout = Object.keys(patch).length > 0;
    if (fromInspector()) focusNodeRef.current = id;
    if (awaitsLayout) updatePrefs(patch);
    setSelection({ kind: 'node', id });
    focusOn(new Set([id]), 1, awaitsLayout);
  };

  useEffect(() => {
    const wanted = focusNodeRef.current;
    if (wanted === null || shown === null) return;
    const node = document
      .querySelector(`[data-chart-node="${cssEscape(wanted)}"]`)
      ?.querySelector<HTMLElement>('button');
    if (node === null || node === undefined) return;
    focusNodeRef.current = null;
    node.focus({ preventScroll: true });
  });

  const showPreset = (id: string) => {
    const ids = presetIds(id) ?? [];
    const patch = revealPatch(ids);
    const awaitsLayout = Object.keys(patch).length > 0;
    if (awaitsLayout) updatePrefs(patch);
    setSelection({ kind: 'preset', id });
    focusOn(new Set(ids), 0.9, awaitsLayout);
  };

  const clear = () => setSelection(null);

  const drillHref = (node: GraphNodeData): string | null =>
    node.drillHref === undefined
      ? null
      : (drillHrefFor?.(node.drillHref) ?? node.drillHref);
  const drill = (href: string) => {
    if (onDrill !== undefined) onDrill(href);
    else window.location.assign(href);
  };

  // Chart keys, live while the canvas or a box has focus.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (
      target.closest('input, textarea, select, [contenteditable="true"]') !==
      null
    ) {
      return;
    }
    let handled = true;
    if (event.key === '/') setSearchOpen(true);
    else if (event.key === 'Escape' && active !== null) clear();
    else if (event.key === '0') fitAll();
    else if (event.key === '+' || event.key === '=') viewport.zoomBy(ZOOM_STEP);
    else if (event.key === '-') viewport.zoomBy(1 / ZOOM_STEP);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const highlight = useMemo(
    () => highlightFor(active, activeSet, model),
    [active, activeSet, model]
  );

  const canvasEdges = useMemo((): CanvasEdge[] => {
    if (shown === null) return [];
    return shown.edges.map((edge) => {
      const key = pairKey(edge.from, edge.to);
      const weight = model.weights.get(key) ?? 1;
      const from = model.nodes.get(edge.from)?.data.label ?? edge.from;
      const to = model.nodes.get(edge.to)?.data.label ?? edge.to;
      return {
        id: edge.id,
        points: edge.points,
        labelAt: edge.labelAt,
        tone: highlight.edge(edge.from, edge.to) ?? 'idle',
        resolved: model.resolved.has(key),
        cycle: model.cycles.has(key),
        label: weight > 1 ? String(weight) : undefined,
        hint:
          weight > 1
            ? `${to} waits on ${from} through ${weight} blocking relations`
            : undefined,
      };
    });
  }, [shown, highlight, model]);

  const groupAction = (id: string): CanvasGroupAction | null => {
    const href = clusters.find((c) => c.id === id)?.drillHref;
    if (href === undefined) return null;
    const target = drillHrefFor?.(href) ?? href;
    return {
      label: 'Double-click to open its graph',
      onOpen: () => drill(target),
    };
  };

  // Stable handlers for the memoised cards: they read the latest props
  // through a ref.
  const handlersRef = useRef({ onOpen, onActivate });
  useEffect(() => {
    handlersRef.current = { onOpen, onActivate };
  });
  const onSelectNode = useCallback(
    (id: string) => setSelection({ kind: 'node', id }),
    []
  );
  const onActivateNode = useCallback((id: string) => {
    const { onOpen: open, onActivate: activate } = handlersRef.current;
    (activate ?? open)?.(id);
  }, []);

  const steps = useMemo(() => {
    if (active?.kind !== 'preset' || active.id !== 'critical') return null;
    return new Map(model.longestChain.map((id, i) => [id, i + 1]));
  }, [active, model]);

  const renderNode = (id: string) => {
    const node = model.nodes.get(id);
    if (node === undefined) return null;
    return (
      <ChartNodeCard
        node={node}
        showFrames={!framed && framesOffered}
        selected={selectedId === id}
        focus={focusId === id}
        step={steps?.get(id) ?? null}
        onSelect={onSelectNode}
        onOpen={onActivateNode}
      />
    );
  };

  const inspector = (() => {
    if (active?.kind === 'node') {
      const node = model.nodes.get(active.id);
      return (
        <NodeInspector
          model={model}
          id={active.id}
          unit={unit}
          openLabel={
            node === undefined || onOpen === undefined
              ? null
              : openLabel === undefined
                ? 'Open'
                : openLabel(node.data)
          }
          drillHref={node === undefined ? null : drillHref(node.data)}
          onPick={goTo}
          onFitChain={(ids) => focusOn(ids, 1, false)}
          onOpen={(id) => onOpen?.(id)}
          onClear={clear}
        />
      );
    }
    if (active?.kind === 'preset') {
      const preset = PRESETS.find((p) => p.id === active.id);
      if (preset !== undefined) {
        return (
          <SetInspector
            model={model}
            label={preset.label}
            blurb={preset.blurb(unit)}
            ids={activeSet ?? []}
            numbered={preset.id === 'critical'}
            onPick={goTo}
            onClear={clear}
          />
        );
      }
    }
    return (
      <InspectorOverview
        model={model}
        unit={unit}
        hiddenUnlinked={hiddenUnlinked}
        onPick={goTo}
        onShowUnlinked={() => updatePrefs({ showUnlinked: true })}
      />
    );
  })();

  // One line for screen readers when the selection changes.
  const status = (() => {
    if (active?.kind === 'node') {
      const node = model.nodes.get(active.id);
      const up = model.blockersOf.get(active.id)?.length ?? 0;
      const down = model.dependentsOf.get(active.id)?.length ?? 0;
      return node === undefined
        ? ''
        : `${node.data.label} selected: waits on ${up}, holds up ${down}.`;
    }
    if (activeSet !== null) {
      const label = PRESETS.find((p) => p.id === active?.id)?.label ?? '';
      return `${label} highlighted, ${countOf(activeSet.length, unit)}.`;
    }
    return '';
  })();

  if (model.order.length === 0) {
    return (
      <div className={cx(styles.chart, className)} data-dependency-chart="">
        {toolbar !== undefined ? (
          <div className={styles.toolbar}>{toolbar}</div>
        ) : null}
        <div className={styles.empty}>
          <EmptyState>{emptyMessage}</EmptyState>
        </div>
      </div>
    );
  }

  const nothingDrawn = drawn.length === 0;
  const states = new Set(drawn.map((id) => model.nodes.get(id)?.state));
  const risks = new Set(drawn.map((id) => model.nodes.get(id)?.data.tone));

  return (
    <div className={cx(styles.chart, className)} data-dependency-chart="">
      <div className={styles.toolbar} data-chart-toolbar="">
        {toolbar}
        <ChartSearch
          open={searchOpen}
          onOpenChange={setSearchOpen}
          model={model}
          ids={findable}
          onPick={(id) => {
            setSearchOpen(false);
            goTo(id);
          }}
        />
        <div className={styles.presets} role="group" aria-label="Highlight">
          {PRESETS.map((preset) => {
            const count = preset.ids(model).length;
            const pressed =
              active?.kind === 'preset' && active.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={styles.preset}
                data-chart-preset={preset.id}
                aria-pressed={pressed}
                // A pressed preset stays clickable once it empties, so it
                // can be let go.
                disabled={count === 0 && !pressed}
                onClick={() => (pressed ? clear() : showPreset(preset.id))}
              >
                {preset.label}
                <span className={styles.presetCount}>{count}</span>
              </button>
            );
          })}
        </div>
        <span className={styles.spacer} />
        <DisplayMenu
          open={displayOpen}
          onOpenChange={setDisplayOpen}
          prefs={prefs}
          framesOffered={framesOffered}
          unit={unit}
          onChange={updatePrefs}
        />
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Inspector"
          title="Inspector"
          aria-pressed={prefs.inspector}
          onClick={() => updatePrefs({ inspector: !prefs.inspector })}
        >
          <PanelRight size={15} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
      <div className={styles.body}>
        {nothingDrawn ? (
          <div className={styles.empty}>
            <EmptyState
              action={
                <button
                  type="button"
                  className={styles.preset}
                  onClick={() =>
                    updatePrefs({ hideDone: false, showUnlinked: true })
                  }
                >
                  Show everything
                </button>
              }
            >
              The display toggles hide every {unit[0]} here.
            </EmptyState>
          </div>
        ) : (
          <ChartCanvas
            viewport={viewport}
            layout={shown}
            message={
              layoutError ??
              (spec !== null && shown === null ? 'Laying out the chart…' : null)
            }
            edges={canvasEdges}
            renderNode={(box) => renderNode(box.id)}
            nodeTrace={highlight.node}
            groupAction={groupAction}
            onBackgroundClick={clear}
            onKeyDown={onKeyDown}
            onFit={fitAll}
            legend={
              <>
                {STATE_LEGEND.filter(({ state }) => states.has(state)).map(
                  ({ state, label }) => (
                    <span key={state} className={styles.legendItem}>
                      <StateSwatch state={state} />
                      {label}
                    </span>
                  )
                )}
                {risks.has('danger') ? (
                  <span className={styles.legendItem}>
                    <StateSwatch risk="danger" />
                    Overdue or on a cycle
                  </span>
                ) : null}
                {risks.has('warning') ? (
                  <span className={styles.legendItem}>
                    <StateSwatch risk="warning" />
                    At risk
                  </span>
                ) : null}
                <span className={styles.legendItem}>
                  <TraceSwatch dir="up" />
                  Waits on
                </span>
                <span className={styles.legendItem}>
                  <TraceSwatch dir="down" />
                  Holds up
                </span>
              </>
            }
            ariaLabel={ariaLabel}
          />
        )}
        <div role="status" className={styles.srOnly}>
          {status}
        </div>
        {prefs.inspector ? (
          <aside
            ref={asideRef}
            data-chart-inspector=""
            aria-label="Inspector"
            className={styles.inspector}
          >
            {inspector}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** Closes a toolbar popover on a press outside it or on Escape. */
function useDismiss(
  open: boolean,
  ref: { current: HTMLElement | null },
  close: () => void
): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        ref.current?.contains(event.target) === true
      ) {
        return;
      }
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [open, ref]);
}

/** Whether every word of the query is in the box's key, name or frames. */
function matches(model: ChartModel, id: string, words: readonly string[]) {
  const node = model.nodes.get(id);
  if (node === undefined) return false;
  const text = [node.data.key, node.data.label, ...node.frames]
    .filter((part) => part !== undefined)
    .join(' ')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Find (/): a combobox over every box the chart can draw. */
function ChartSearch({
  open,
  onOpenChange,
  model,
  ids,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ChartModel;
  ids: readonly string[];
  onPick: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  useDismiss(open, ref, () => onOpenChange(false));
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const results = (
    words.length === 0 ? ids : ids.filter((id) => matches(model, id, words))
  ).slice(0, 40);
  const listId = `${useId()}-list`;
  const choose = (id: string | undefined) => {
    if (id === undefined) return;
    setQuery('');
    onPick(id);
  };
  return (
    <div className={styles.popoverAnchor} ref={ref}>
      <button
        type="button"
        className={styles.preset}
        data-chart-search=""
        aria-expanded={open}
        aria-keyshortcuts="/"
        onClick={() => onOpenChange(!open)}
      >
        <Search size={13} strokeWidth={1.8} aria-hidden />
        Find
        <Kbd>/</Kbd>
      </button>
      {open ? (
        <div className={styles.popover} data-chart-ignore="">
          <input
            ref={inputRef}
            className={styles.searchInput}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-label="Find on the chart"
            placeholder="Find on this chart"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onOpenChange(false);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(results[activeIndex]);
              }
            }}
          />
          <ul id={listId} role="listbox" className={styles.results}>
            {results.length === 0 ? (
              <li className={styles.hint}>Nothing on this chart matches.</li>
            ) : (
              results.map((id, i) => {
                const node = model.nodes.get(id);
                if (node === undefined) return null;
                return (
                  <li
                    key={id}
                    role="option"
                    aria-selected={i === activeIndex}
                    className={styles.result}
                    data-active={i === activeIndex ? '' : undefined}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => choose(id)}
                  >
                    {node.data.key !== undefined ? (
                      <span className={styles.mono}>{node.data.key}</span>
                    ) : null}
                    <span className={styles.rowName}>{node.data.label}</span>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Display: the toggles that reshape the chart. */
function DisplayMenu({
  open,
  onOpenChange,
  prefs,
  framesOffered,
  unit,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: ChartPrefs;
  framesOffered: boolean;
  unit: readonly [string, string];
  onChange: (patch: Partial<ChartPrefs>) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(open, ref, () => onOpenChange(false));
  return (
    <div
      className={styles.popoverAnchor}
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          onOpenChange(false);
        }
      }}
    >
      <button
        type="button"
        className={styles.preset}
        data-chart-display=""
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <SlidersHorizontal size={13} strokeWidth={1.8} aria-hidden />
        Display
      </button>
      {open ? (
        <div
          className={cx(styles.popover, styles.popoverEnd)}
          data-chart-ignore=""
        >
          <Switch
            label={`Hide done ${unit[1]}`}
            checked={prefs.hideDone}
            onChange={(checked) => onChange({ hideDone: checked })}
          />
          <Switch
            label={`Show unlinked ${unit[1]}`}
            checked={prefs.showUnlinked}
            onChange={(checked) => onChange({ showUnlinked: checked })}
          />
          {framesOffered ? (
            <Switch
              label="Box by parent"
              checked={prefs.framed}
              onChange={(checked) => onChange({ framed: checked })}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
