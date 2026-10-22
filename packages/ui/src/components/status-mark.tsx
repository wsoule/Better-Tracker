import type { ReactNode } from 'react';

import type { UiStatus } from '../types';
import styles from './status-mark.module.css';

/* The competitors-site Mark idiom applied to status: the shape says the
   status (filled, hollow, 2px outline, hatched) and the status hue says it
   again (docs/architecture.md §8.2): overdue a filled red square, at risk
   a 2px amber outline, on track a hollow green square, done a filled ink
   square (ink, not green, so done and overdue never look alike without
   red-green vision), a missing input hatched grey, and open (no status
   claim of its own) the plain hollow ink square. The colour is never the only
   cue: the shapes differ and the label is always available to assistive
   tech. `muted` draws any status as a hollow grey square (an inactive
   project's milestone, which is never loud), like the timeline's inactive
   lanes. The purple accent is never a status. */
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
