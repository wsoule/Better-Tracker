import type { ReactNode } from 'react';

import styles from './kbd.module.css';
import { cx } from './render';
import type { KbdKeysProps, KbdProps } from './types';

/* A key cap in the machine voice: mono, square, a 1px border drawn in
   currentColor so it rides every surface (muted on paper, white on the
   orange flood, paper on an ink-filled row). */
export function Kbd({ children, className }: KbdProps): ReactNode {
  return <kbd className={cx(styles.kbd, className)}>{children}</kbd>;
}

/* A run of caps for one shortcut: ['G', 'W'] pressed in turn, or
   ['Ctrl', 'K'] held together. Read as one phrase by assistive tech. */
export function KbdKeys({ keys, className }: KbdKeysProps): ReactNode {
  return (
    <kbd className={cx(styles.keys, className)}>
      {keys.map((key, i) => (
        // Keys can repeat (G G), so the position is part of the identity.
        <kbd key={`${i}-${key}`} className={styles.kbd}>
          {key}
        </kbd>
      ))}
    </kbd>
  );
}
