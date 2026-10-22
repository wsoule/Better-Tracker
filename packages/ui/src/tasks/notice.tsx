import type { UiTone } from '../types';
import { cx } from './class-names';
import styles from './notice.module.css';
import type { EmptyStateProps, NoticeProps } from './types';

/* The tones whose 2px frame and key take a status hue. */
const SEMANTIC: ReadonlySet<UiTone> = new Set<UiTone>([
  'danger',
  'warning',
  'success',
  'info',
]);

/* The 2px-accent notice strip (.notice) with its mono key: blocked states,
   errors, the demo-mode banner. A status tone (danger, warning, success,
   info) draws the same 2px frame and key in its hue; default and muted are
   the quiet 1px hairline (muted with a grey key). role is opt-in: "status"
   for something that just changed, "alert" for an error; static copy needs
   neither. */
export function Notice({
  label,
  children,
  tone = 'accent',
  role,
  action,
}: NoticeProps) {
  const status = SEMANTIC.has(tone);
  return (
    <div
      className={cx(
        'notice',
        tone === 'default' || tone === 'muted' ? styles.quiet : undefined,
        status ? styles.toned : undefined
      )}
      role={role}
      data-tone={tone}
    >
      {label !== undefined && label !== '' ? (
        <span
          className={cx(
            'key',
            styles.key,
            status || tone === 'muted' ? styles.toneKey : undefined
          )}
        >
          {label}
        </span>
      ) : null}
      <div className={styles.body}>{children}</div>
      {action !== undefined ? (
        <div className={styles.action}>{action}</div>
      ) : null}
    </div>
  );
}

/* Empty states are honest copy (.empty), never an illustration: an
   optional mono key, then the sentence in the body face; hatched when the
   emptiness is a missing input. */
export function EmptyState({
  children,
  label,
  action,
  hatched = false,
}: EmptyStateProps) {
  return (
    <div className={cx('empty', hatched ? 'hatched' : undefined, styles.empty)}>
      <p className={styles.emptyText}>
        {label !== undefined && label !== '' ? (
          <span className={cx('label', styles.emptyKey)}>{label}</span>
        ) : null}
        {children}
      </p>
      {action !== undefined ? (
        <div className={styles.emptyAction}>{action}</div>
      ) : null}
    </div>
  );
}
