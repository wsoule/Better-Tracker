import { cx } from './class-names';
import styles from './task-glyphs.module.css';
import type { TaskPriority, TaskStateKind } from './types';

/* Issue-state glyphs in the Gr8r/Linear shapes, drawn as monochrome
   hairlines: circles for issues so they never read as the square milestone
   status marks. Decorative only (aria-hidden): the state's name is always
   printed beside the glyph. */
export function StateGlyph({
  kind,
  size = 14,
}: {
  kind: TaskStateKind;
  size?: number;
}) {
  return (
    <svg
      className={cx(styles.glyph, styles[kind])}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      data-kind={kind}
    >
      {kind === 'completed' ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.4 7.2 6.2 9 9.7 5.3"
            className={styles.check}
            fill="none"
            strokeWidth="1.4"
          />
        </>
      ) : (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeDasharray={kind === 'triage' ? '2 1.6' : undefined}
        />
      )}
      {kind === 'started' ? (
        <path d="M7 3.5a3.5 3.5 0 0 1 0 7Z" fill="currentColor" />
      ) : null}
      {kind === 'canceled' ? (
        <line
          x1="3.2"
          y1="10.8"
          x2="10.8"
          y2="3.2"
          stroke="currentColor"
          strokeWidth="1.25"
        />
      ) : null}
    </svg>
  );
}

// Bars lit per Linear priority (0 none … 1 urgent … 4 low).
const LIT: Record<TaskPriority, number> = { 0: 0, 1: 4, 2: 3, 3: 2, 4: 1 };
const BAR_HEIGHTS = [4, 6.5, 9, 11.5];

/* Priority as a four-step bar glyph: ink bars for the level, ghost bars for
   the rest, all four in the accent for urgent (the one that needs action).
   Decorative only: the priority label is printed beside it. */
export function PriorityGlyph({
  priority,
  size = 14,
}: {
  priority: TaskPriority;
  size?: number;
}) {
  const lit = LIT[priority];
  return (
    <svg
      className={cx(styles.glyph, priority === 1 ? styles.urgent : undefined)}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      data-priority={priority}
    >
      {BAR_HEIGHTS.map((h, i) => (
        <rect
          key={h}
          x={1 + i * 3.25}
          y={12.5 - h}
          width="2.25"
          height={h}
          className={i < lit ? styles.lit : styles.ghost}
        />
      ))}
    </svg>
  );
}
