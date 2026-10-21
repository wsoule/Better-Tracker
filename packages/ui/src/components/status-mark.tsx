import type { UiStatus } from '../types';
import styles from './status-mark.module.css';

/* The competitors-site Mark idiom applied to status: filled vs hollow, ink
   vs accent. No new hues — overdue is the accent at full strength, at risk
   the accent as a 2px outline, done is ink, and a missing input is
   hatched. The label is always available to assistive tech. */
export default function StatusMark({
  status,
  label,
  showLabel = false,
}: {
  status: UiStatus;
  /** Human wording, e.g. "At risk". */
  label: string;
  /** Also render the label beside the mark. */
  showLabel?: boolean;
}) {
  return (
    <span className={styles.wrap}>
      <span
        className={`${styles.mark} ${styles[status]}`}
        role="img"
        aria-label={label}
      />
      {showLabel ? <span className={styles.text}>{label}</span> : null}
    </span>
  );
}
