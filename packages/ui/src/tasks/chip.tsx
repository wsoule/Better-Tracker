import StatusMark from '../components/status-mark';
import styles from './chip.module.css';
import { cx } from './class-names';
import type { ChipProps } from './types';

/* The Roster category chip: a mono uppercase label in a 1px box. Tone is
   the only variable: ink outline, grey idle, orange fill for "needs
   action", ink fill for the stronger claim. A leading status mark rides the
   chip's local tokens, so it stays legible on the filled tones. */
export function Chip({
  tone = 'default',
  status,
  statusLabel,
  title,
  children,
}: ChipProps) {
  return (
    <span
      className={cx(styles.chip, styles[tone])}
      data-tone={tone}
      title={title}
    >
      {status !== undefined ? (
        <span className={styles.mark}>
          <StatusMark status={status} label={statusLabel ?? status} />
        </span>
      ) : null}
      <span className={styles.text}>{children}</span>
    </span>
  );
}
