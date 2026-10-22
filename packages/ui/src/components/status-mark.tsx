import type { ReactNode } from 'react';

import type { UiStatus } from '../types';
import styles from './status-mark.module.css';

/* A milestone's status as a 12px round mark in Gr8r's status shapes and
   the semantic hues (docs/architecture.md §8.2): done = green disc with a
   tick, on track = green ring, at risk = amber half-filled ring, overdue =
   red disc, missing input = dashed grey ring. The accent is never used.
   The label is always available to assistive tech. `muted` draws any
   status as a faint grey ring (an inactive project's milestone, which is
   never loud), like the timeline's inactive lanes. */
export interface StatusMarkProps {
  status: UiStatus;
  /** Human wording, e.g. "At risk". */
  label: string;
  /** Also render the label beside the mark. */
  showLabel?: boolean;
  /** Greys only, whatever the status (the label still says it). */
  muted?: boolean;
}

export default function StatusMark({
  status,
  label,
  showLabel = false,
  muted = false,
}: StatusMarkProps): ReactNode {
  return (
    <span className={styles.wrap}>
      <span
        className={`${styles.mark} ${muted ? styles.muted : styles[status]}`}
        data-status={status}
        data-muted={muted ? '' : undefined}
        role="img"
        aria-label={label}
      />
      {showLabel ? <span className={styles.text}>{label}</span> : null}
    </span>
  );
}
