import type { CSSProperties } from 'react';

import { Link } from '../lib/link';
import { cx } from './class-names';
import styles from './stats-strip.module.css';
import type { StatCell, StatsStripProps } from './types';

function CellBody({ cell }: { cell: StatCell }) {
  return (
    <>
      <span className={styles.label}>{cell.label}</span>
      <span className={styles.value}>{cell.value}</span>
      {cell.note !== undefined && cell.note !== '' ? (
        <span className={styles.note}>{cell.note}</span>
      ) : null}
    </>
  );
}

// Up to four across. The last cell spans whatever its row leaves empty, so
// the hairline frame closes at any count (3 + 2, 4 + 1, ...). Integers are
// computed here rather than with min() inside repeat(), which older WebKit
// (Tauri on macOS) does not resolve.
const MAX_COLUMNS = 4;

function lastCellSpan(count: number, columns: number): number {
  const remainder = count % columns;
  return remainder === 0 ? 1 : columns - remainder + 1;
}

/* Gr8r's four stat cards as one Analytics drawing: a hairline grid where
   each cell draws only its right and bottom line (the strip draws the top
   and left), so nothing is drawn twice at any column count. Mono numerals;
   a cell's tone colours its number and note (danger overdue, warning at
   risk, accent new). Four across, two on phones, with the last cell
   spanning the rest of its row so the frame closes. */
export function StatsStrip({ cells, label = 'Summary' }: StatsStripProps) {
  const columns = Math.max(1, Math.min(cells.length, MAX_COLUMNS));
  const span = lastCellSpan(cells.length, columns);
  return (
    <ul
      className={styles.strip}
      aria-label={label}
      style={{ '--stat-cols': columns } as CSSProperties}
    >
      {cells.map((cell, i) => {
        const tone = cell.tone ?? 'default';
        const last = i === cells.length - 1;
        return (
          <li
            key={cell.id}
            className={cx(styles.cell, styles[tone])}
            data-tone={tone}
            style={
              last && span > 1
                ? ({ '--stat-span': span } as CSSProperties)
                : undefined
            }
          >
            {cell.href !== undefined ? (
              <Link href={cell.href} className={styles.inner}>
                <CellBody cell={cell} />
              </Link>
            ) : (
              <div className={styles.inner}>
                <CellBody cell={cell} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
