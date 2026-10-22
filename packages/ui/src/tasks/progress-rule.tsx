import styles from './progress-rule.module.css';
import type { ProgressRuleProps } from './types';

/* completed/scope as Gr8r's progress bar: a 4px rounded track with an
   accent fill (or the tone's hue when the progress is itself a status:
   danger, warning, success, muted) and a "3/7" receipt in tabular figures.
   Exposed as a progressbar with a sentence value. */
export function ProgressRule({
  done,
  total,
  tone = 'default',
  label,
  'aria-label': ariaLabel = 'Progress',
}: ProgressRuleProps) {
  const safeTotal = Math.max(0, total);
  const safeDone = Math.min(Math.max(0, done), safeTotal);
  const ratio = safeTotal === 0 ? 0 : safeDone / safeTotal;
  const visible = label === undefined ? `${safeDone}/${safeTotal}` : label;

  return (
    <span className={styles.wrap} data-tone={tone}>
      <span
        className={styles.track}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuenow={safeDone}
        aria-valuetext={`${safeDone} of ${safeTotal} done`}
      >
        <span
          className={styles.fill}
          style={{ transform: `scaleX(${ratio})` }}
        />
      </span>
      {visible !== null ? (
        <span className={styles.label} aria-hidden="true">
          {visible}
        </span>
      ) : null}
    </span>
  );
}
