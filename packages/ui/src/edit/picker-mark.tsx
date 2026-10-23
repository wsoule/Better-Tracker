import { User } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import StatusMark from '../components/status-mark';
import { PriorityGlyph, StateGlyph } from '../tasks/task-glyphs';
import styles from './picker-mark.module.css';
import { avatarHue, initials, isHexColor } from './shared';
import type { PickerMark } from './types';

/* The person glyph inside an empty (nobody) avatar, per avatar size. */
const EMPTY_ICON_SIZE = { sm: 11, base: 12, md: 14, lg: 18 } as const;

/**
 * A person as Gr8r draws them: a round avatar with their initials on a
 * pastel tint of a hue picked from the name (decoration: the name is always
 * printed beside it). A blank name is nobody: a dashed empty circle, the
 * way an unassigned slot looks. `size` is 20px (sm) in a picker row or
 * trigger, 22px (base) in the sidebar footer, 26px (md) beside a comment
 * or in a list of people, 36px (lg) as a header. The one avatar of the
 * package and its hosts, so a person reads the same colour everywhere.
 */
export interface InitialsAvatarProps {
  name: string;
  size?: 'sm' | 'base' | 'md' | 'lg';
}

export function InitialsAvatar({
  name,
  size = 'sm',
}: InitialsAvatarProps): ReactNode {
  const empty = name.trim() === '';
  return (
    <span
      className={styles.avatar}
      aria-hidden="true"
      data-mark="avatar"
      data-size={size}
      data-hue={empty ? undefined : avatarHue(name)}
      data-empty={empty ? 'true' : undefined}
    >
      {empty ? (
        <User
          size={EMPTY_ICON_SIZE[size]}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/* The leading mark of a picker option or trigger, drawn from the system's
   own glyphs: the state circle, the priority bars, a round avatar, the
   milestone status mark, a label's colour square or a host's node. Not a
   client module, so a read-only face renders on the server too. The marks
   are decorative (the label is always printed beside them) except the
   status mark, which names its status. */
export interface PickerMarkViewProps {
  mark: PickerMark;
}

export function PickerMarkView({ mark }: PickerMarkViewProps): ReactNode {
  switch (mark.kind) {
    case 'state':
      return <StateGlyph kind={mark.state} size={14} />;
    case 'priority':
      return <PriorityGlyph priority={mark.priority} size={14} />;
    case 'avatar':
      return <InitialsAvatar name={mark.name} />;
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
