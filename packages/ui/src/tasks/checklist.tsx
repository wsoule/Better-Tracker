import styles from './checklist.module.css';
import { cx } from './class-names';
import type { ChecklistProps } from './types';

/* The rubric as a register of marks: filled ink square = met (as a done
   milestone), hollow amber square = missing (a missing input is a
   warning, and the only hue in the list, so the item needing action
   stands out; the purple accent never means a status). Each item also
   states its result in words, right-aligned in the mono voice, so neither
   the mark nor its colour is ever the only carrier of meaning. */
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
            {item.met ? metLabel : missingLabel}
          </span>
        </li>
      ))}
    </ul>
  );
}
