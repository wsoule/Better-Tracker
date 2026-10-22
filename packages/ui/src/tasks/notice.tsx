import { cx } from './class-names';
import styles from './notice.module.css';
import type { EmptyStateProps, NoticeProps } from './types';

/* The 2px-accent notice strip (.notice) with its mono key: blocked states,
   errors, the demo-mode banner. role is opt-in: "status" for something that
   just changed, "alert" for an error; static copy needs neither. */
export function Notice({
  label,
  children,
  tone = 'accent',
  role,
  action,
}: NoticeProps) {
  return (
    <div
      className={cx('notice', tone === 'default' ? styles.quiet : undefined)}
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
