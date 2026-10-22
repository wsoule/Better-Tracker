import { cx } from './class-names';
import styles from './notice.module.css';
import type { EmptyStateProps, NoticeProps } from './types';

/* Gr8r's alert (.notice) with a semibold lead-in: blocked states, errors,
   the demo-mode banner. default / muted is a bordered neutral box; every
   other tone fills it with its soft tint (accent = Gr8r's info alert, the
   default; danger, warning, success, info for status). role is opt-in:
   "status" for something that just changed, "alert" for an error; static
   copy needs neither. */
export function Notice({
  label,
  children,
  tone = 'accent',
  role,
  action,
}: NoticeProps) {
  return (
    <div
      className={cx(
        'notice',
        tone === 'default' || tone === 'muted' ? styles.quiet : undefined
      )}
      role={role}
      data-tone={tone}
    >
      {label !== undefined && label !== '' ? (
        <span className={cx('key', styles.key)}>{label}</span>
      ) : null}
      <div className={styles.body}>{children}</div>
      {action !== undefined ? (
        <div className={styles.action}>{action}</div>
      ) : null}
    </div>
  );
}

/* Empty states are honest copy (.empty), never an illustration: an
   optional title, then the sentence; a dashed edge (.hatched) when the
   emptiness is a missing input. The title is styled by the module alone:
   the global .label has the same specificity and would make it 12px
   grey wherever primitives.css loads after this module. */
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
          <span className={styles.emptyKey}>{label}</span>
        ) : null}
        {children}
      </p>
      {action !== undefined ? (
        <div className={styles.emptyAction}>{action}</div>
      ) : null}
    </div>
  );
}
