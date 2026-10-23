import { cx } from './class-names';
import styles from './progress-rule.module.css';
import type { ProgressRuleProps } from './types';

/* completed/scope as a drawn rule: a 1px ghost track (--grey-4) with an ink
   fill sitting on it and a mono "3/7" receipt. Any tone but default paints
   the fill in the tone's MARK colour and the receipt in its TEXT colour
   (data-tone): danger overdue, warning behind pace, success complete, muted
   inactive, accent for a fill that is not a status. Exposed as a
   progressbar with a sentence value. */
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
    <span
      className={cx(styles.wrap, tone === 'default' ? undefined : styles.toned)}
      data-tone={tone}
    >
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
