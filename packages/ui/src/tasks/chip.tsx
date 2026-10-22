import StatusMark from '../components/status-mark';
import styles from './chip.module.css';
import { cx } from './class-names';
import type { ChipProps, ChipTone } from './types';

/* The tones drawn as a status-coloured outline. */
const SEMANTIC: ReadonlySet<ChipTone> = new Set<ChipTone>([
  'danger',
  'warning',
  'success',
  'info',
]);

/* The Roster category chip: a mono uppercase label in a 1px box. Tone is
   the only variable: ink outline, grey idle, accent fill (new, unread), ink
   fill for the stronger claim, and the status tones (danger, warning,
   success, info) as the same outline with border and text in the status
   hue (data-tone gives the CSS --tone-ink), or, with `filled`, a slab of
   the hue (--tone) with its own text colour (--on-tone). A leading status
   mark rides the chip's local tokens, so it stays legible on the filled
   tones. */
export function Chip({
  tone = 'default',
  filled = false,
  status,
  statusLabel,
  title,
  children,
}: ChipProps) {
  const semantic = SEMANTIC.has(tone);
  return (
    <span
      className={cx(
        styles.chip,
        styles[tone],
        semantic ? (filled ? styles.statusFilled : styles.status) : undefined
      )}
      data-tone={tone}
      data-filled={semantic && filled ? '' : undefined}
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
