import type { MilestoneStatus } from '@better-tracker/core';

import styles from './status-mark.module.css';

/* The competitors-site Mark idiom applied to milestone status: filled vs
   hollow, ink vs accent. No new hues — overdue is the accent at full
   strength, at risk is the accent as a 2px outline, done is ink, and
   anything missing an input is hatched. */
export const STATUS_MARK_LABEL: Record<MilestoneStatus, string> = {
  complete: 'Complete',
  on_track: 'On track',
  at_risk: 'At risk',
  overdue: 'Overdue',
  unscheduled: 'No target date',
  empty: 'No issues',
};

export default function StatusMark({
  status,
  label = false,
}: {
  status: MilestoneStatus;
  /** Also render the status name beside the mark. */
  label?: boolean;
}) {
  return (
    <span className={styles.wrap}>
      <span
        className={`${styles.mark} ${styles[status]}`}
        role="img"
        aria-label={STATUS_MARK_LABEL[status]}
      />
      {label ? (
        <span className={styles.text}>{STATUS_MARK_LABEL[status]}</span>
      ) : null}
    </span>
  );
}
