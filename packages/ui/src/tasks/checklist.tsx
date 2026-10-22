import styles from './checklist.module.css';
import { Chip } from './chip';
import { cx } from './class-names';
import type { ChecklistProps } from './types';

/* The rubric as a short checklist panel, Gr8r's: a met item has a green
   disc with a tick and a quiet "Met", a missing one a dashed amber ring
   and an amber "Missing" chip (docs/architecture.md §8.2: met = success,
   missing = warning). The result is always said in words too, so the mark
   is never the only carrier of meaning. */
export function Checklist({
  items,
  label,
  metLabel = 'Met',
  missingLabel = 'Missing',
}: ChecklistProps) {
  return (
    <ul className={styles.list} aria-label={label}>
      {items.map((item, i) => (
        <li
          key={item.id ?? `${i}:${item.label}`}
          className={cx(styles.item, item.met ? styles.met : styles.missing)}
          data-met={item.met}
        >
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.main}>
            <span className={styles.label}>{item.label}</span>
            {item.note !== undefined && item.note !== '' ? (
              <span className={styles.note}>{item.note}</span>
            ) : null}
          </span>
          <span className={styles.state}>
            {item.met ? metLabel : <Chip tone="warning">{missingLabel}</Chip>}
          </span>
        </li>
      ))}
    </ul>
  );
}
