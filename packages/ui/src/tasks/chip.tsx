import StatusMark from '../components/status-mark';
import styles from './chip.module.css';
import { cx } from './class-names';
import type { ChipProps } from './types';

/* Gr8r's badge: a short sentence-case label in a 5px-radius chip. Tone is
   the variable: neutral (default), quieter (muted), or the tone's text on
   its soft tint (accent, info, success, warning, danger). With `dot` it is
   Gr8r's status pill instead: neutral and bordered, the tone only in a
   6px dot. An optional leading status mark names a milestone status. */
export function Chip({
  tone = 'default',
  dot = false,
  status,
  statusLabel,
  title,
  children,
}: ChipProps) {
  return (
    <span
      className={cx(styles.chip, dot ? styles.withDot : styles[tone])}
      data-tone={tone}
      title={title}
    >
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {status !== undefined ? (
        <span className={styles.mark}>
          <StatusMark status={status} label={statusLabel ?? status} />
        </span>
      ) : null}
      <span className={styles.text}>{children}</span>
    </span>
  );
}
