import type { ReactNode } from 'react';

import { cx } from '../tasks/class-names';
import styles from './graph-legend.module.css';
import type {
  GraphLegendItem,
  GraphLegendMark,
  GraphLegendProps,
} from './types';

/** Every mark DependencyGraph draws, in the order a reader meets them. */
export const defaultGraphLegend: GraphLegendItem[] = [
  { mark: 'node', label: 'Node', note: 'blockers sit left of what waits' },
  { mark: 'node-overdue', label: 'Overdue', note: 'past its date' },
  {
    mark: 'node-accent',
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
  'node-accent': styles.nodeAccent,
  'node-overdue': styles.nodeOverdue,
  'node-external': styles.nodeExternal,
  'node-cycle': styles.nodeCycle,
  'node-muted': styles.nodeMuted,
};

/** The small drawing beside a legend label, in the graph's own marks. */
function Swatch({ mark }: { mark: GraphLegendMark }): ReactNode {
  if (mark === 'weight') {
    return (
      <span className={styles.weight} aria-hidden="true">
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
        aria-hidden="true"
      >
        <path className={styles.edgeLine} d="M0.5,5L22,5" />
        <path className={styles.edgeArrow} d="M28,5L22,2L22,8Z" />
      </svg>
    );
  }
  return (
    <span className={cx(styles.node, NODE_SWATCH[mark])} aria-hidden="true" />
  );
}

/**
 * The graph's key, in the Matrix legend idiom: one hairline strip, a mono
 * NODES / EDGES key per row, then swatch + bold mono name + muted note.
 * Notes drop away on narrower screens; the names carry the meaning.
 */
export function GraphLegend({
  items = defaultGraphLegend,
  label = 'Graph legend',
  className,
}: GraphLegendProps): ReactNode {
  const nodeItems = items.filter((item) => item.mark.startsWith('node'));
  const edgeItems = items.filter((item) => !item.mark.startsWith('node'));
  const rows = [
    { key: 'Nodes', list: nodeItems },
    { key: 'Edges', list: edgeItems },
  ].filter((row) => row.list.length > 0);
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
              <li key={`${item.mark}:${item.label}`} className={styles.item}>
                <Swatch mark={item.mark} />
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
