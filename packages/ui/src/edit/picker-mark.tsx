import type { CSSProperties, ReactNode } from 'react';

import StatusMark from '../components/status-mark';
import { PriorityGlyph, StateGlyph } from '../tasks/task-glyphs';
import styles from './picker-mark.module.css';
import { initials, isHexColor } from './shared';
import type { PickerMark } from './types';

/* The leading mark of a picker option or trigger, drawn from the system's
   own glyphs: the state circle, the priority bars, square initials, the
   milestone status square, a label's colour square or a host's node. Not
   a client module, so a read-only face renders on the server too. The
   marks are decorative (the label is always printed beside them) except
   the status square, which names its status. */
export function PickerMarkView({ mark }: { mark: PickerMark }): ReactNode {
  switch (mark.kind) {
    case 'state':
      return <StateGlyph kind={mark.state} size={13} />;
    case 'priority':
      return <PriorityGlyph priority={mark.priority} size={13} />;
    case 'avatar':
      return (
        <span className={styles.avatar} aria-hidden="true" data-mark="avatar">
          {initials(mark.name)}
        </span>
      );
    case 'status':
      return (
        <StatusMark
          status={mark.status}
          label={mark.label}
          muted={mark.muted === true}
        />
      );
    case 'swatch': {
      // A colour from data is painted only here, and only when it is a
      // plain hex value; anything else draws the hollow square.
      const valid = isHexColor(mark.color);
      const style: CSSProperties | undefined = valid
        ? { backgroundColor: mark.color }
        : undefined;
      return (
        <span
          className={styles.swatch}
          style={style}
          aria-hidden="true"
          data-mark="swatch"
          data-empty={valid ? undefined : 'true'}
        />
      );
    }
    case 'node':
      return mark.node;
    default:
      return null;
  }
}
