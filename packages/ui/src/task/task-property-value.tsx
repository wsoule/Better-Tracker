import type { ReactNode } from 'react';

import { cx } from '../tasks/class-names';
import styles from './task-property-value.module.css';
import type { TaskPropertyValueProps } from './types';

/* A property value with an optional sentence under it, for the facts the
   tracker does not show: "Ana Moreno" over "Given by the planner: she
   leads Beacon search", "Todo" over "for 9 days". Value and note colour
   themselves by tone (data-tone). Drop it into a PropertyListItem's
   value; editors (Dispatch's pickers) can be its children just as well as
   text. */
export function TaskPropertyValue({
  children,
  note,
  tone = 'default',
  noteTone = 'muted',
  mono = false,
}: TaskPropertyValueProps): ReactNode {
  return (
    <span className={styles.stack}>
      <span
        className={cx(styles.value, mono ? styles.mono : undefined)}
        data-tone={tone}
      >
        {children}
      </span>
      {note !== undefined && note !== null && note !== '' ? (
        <span
          className={cx(
            styles.note,
            noteTone === 'default' ? styles.noteDefault : undefined
          )}
          data-tone={noteTone}
          dir="auto"
        >
          {note}
        </span>
      ) : null}
    </span>
  );
}
