import type { ReactNode } from 'react';

import StatusMark from '../components/status-mark';
import { cx } from '../tasks/class-names';
import { StateGlyph } from '../tasks/task-glyphs';
import styles from './graph-legend.module.css';
import type {
  GraphLegendItem,
  GraphLegendMark,
  GraphLegendProps,
} from './types';

/** Every mark DependencyGraph draws, in the order a reader meets them. */
export const defaultGraphLegend: GraphLegendItem[] = [
  { mark: 'node', label: 'Node', note: 'blockers sit left of what waits' },
  { mark: 'node-danger', label: 'Overdue', note: 'past its date' },
  {
    mark: 'node-warning',
    label: 'Needs action',
    note: 'unassigned or at risk',
  },
  { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
  { mark: 'node-external', label: 'External', note: 'outside this scope' },
  { mark: 'edge-default', label: 'Blocks', note: 'blocker → waiting' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'ends in an unassigned or overdue blocker',
  },
  { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
  { mark: 'edge-cross', label: 'Cross-project', note: 'leaves its project' },
  { mark: 'edge-resolved', label: 'Resolved', note: 'blocker closed' },
  { mark: 'weight', label: 'Count', note: 'relations on one edge' },
];

const EDGE_SWATCH: Partial<Record<GraphLegendMark, string | undefined>> = {
  'edge-default': styles.edgeDefault,
  'edge-risk': styles.edgeRisk,
  'edge-cycle': styles.edgeCycle,
  'edge-cross': styles.edgeCross,
  'edge-resolved': styles.edgeResolved,
};

const NODE_SWATCH: Partial<Record<GraphLegendMark, string | undefined>> = {
  node: undefined,
  'node-danger': styles.nodeDanger,
  'node-warning': styles.nodeWarning,
  'node-external': styles.nodeExternal,
  'node-cycle': styles.nodeCycle,
  'node-muted': styles.nodeMuted,
  'node-focus': styles.nodeFocus,
};

/** Which row of the key a mark belongs to. */
function rowOf(mark: GraphLegendMark): 'Status' | 'Boxes' | 'Arrows' {
  if (mark === 'status' || mark === 'state') return 'Status';
  return mark.startsWith('node') ? 'Boxes' : 'Arrows';
}

/** The small drawing beside a legend label, in the graph's own marks.
    `data-mark` names the mark for hosts' and tests' queries. Hidden from
    assistive tech: the label beside it says what it means. */
function Swatch({ item }: { item: GraphLegendItem }): ReactNode {
  const { mark } = item;
  if (mark === 'status') {
    return (
      <span className={styles.mark} data-mark={mark} aria-hidden="true">
        <StatusMark status={item.status ?? 'on_track'} label={item.label} />
      </span>
    );
  }
  if (mark === 'state') {
    return (
      <span className={styles.mark} data-mark={mark} aria-hidden="true">
        <StateGlyph kind={item.state ?? 'unstarted'} size={14} />
      </span>
    );
  }
  if (mark === 'weight') {
    return (
      <span className={styles.weight} data-mark={mark} aria-hidden="true">
        3
      </span>
    );
  }
  if (mark in EDGE_SWATCH) {
    return (
      <svg
        className={cx(styles.edge, EDGE_SWATCH[mark])}
        width="28"
        height="10"
        viewBox="0 0 28 10"
        data-mark={mark}
        aria-hidden="true"
      >
        <path className={styles.edgeLine} d="M1,5L22,5" />
        <path className={styles.edgeArrow} d="M28,5L22,2L22,8Z" />
      </svg>
    );
  }
  return (
    <span
      className={cx(styles.node, NODE_SWATCH[mark])}
      data-mark={mark}
      aria-hidden="true"
    />
  );
}

/**
 * The graph's key as Gr8r-style key rows: a quiet row name (Status,
 * Boxes, Arrows), then swatch + sentence-case name + quiet note per item,
 * so the status diamonds, the card looks and the edge kinds never mix.
 * Notes drop away on narrower screens; the names carry the meaning.
 */
export function GraphLegend({
  items = defaultGraphLegend,
  label = 'Graph legend',
  className,
}: GraphLegendProps): ReactNode {
  const rows = (['Status', 'Boxes', 'Arrows'] as const)
    .map((key) => ({
      key,
      list: items.filter((item) => rowOf(item.mark) === key),
    }))
    .filter((row) => row.list.length > 0);
  return (
    <div
      className={cx(styles.legend, className)}
      role="group"
      aria-label={label}
    >
      {rows.map((row) => (
        <div key={row.key} className={styles.row}>
          <span className={styles.rowKey}>{row.key}</span>
          <ul className={styles.list}>
            {row.list.map((item) => (
              <li
                key={`${item.mark}:${item.status ?? item.state ?? ''}:${item.label}`}
                className={styles.item}
              >
                <Swatch item={item} />
                <span className={styles.label}>{item.label}</span>
                {item.note !== undefined && item.note !== '' ? (
                  <span className={styles.note}>{item.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
