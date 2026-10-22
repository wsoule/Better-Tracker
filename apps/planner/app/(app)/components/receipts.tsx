import type { ReactNode } from 'react';

import styles from './receipts.module.css';

export interface ReceiptItem {
  /** A stable id ("my-week", "admin-approves"); never shown. */
  key: string;
  title: string;
  body: string;
  /** A 16px lucide icon (cards only). */
  icon?: ReactNode;
}

/* What the planner does (landing) or what an install does (/setup), in
   Gr8r's two list forms. "cards": a grid of soft bordered cards, each an
   icon, a title and a sentence or two (Gr8r's option cards). "steps": one
   panel of numbered rows split by soft dividers, for things that happen
   in order; the number is drawn in a small round badge and hidden from
   assistive tech, which reads the <ol>'s own numbering. */
export default function Receipts({
  items,
  label,
  variant = 'cards',
}: {
  items: readonly ReceiptItem[];
  /** Accessible name of the list. */
  label: string;
  variant?: 'cards' | 'steps';
}) {
  if (variant === 'steps') {
    return (
      <ol className={styles.steps} aria-label={label}>
        {items.map((item, index) => (
          <li key={item.key} className={styles.step}>
            <span className={styles.number} aria-hidden="true">
              {index + 1}
            </span>
            <span className={styles.stepText}>
              <span className={styles.title}>{item.title}</span>
              <span className={styles.body}>{item.body}</span>
            </span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ul className={styles.cards} aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className={styles.card}>
          {item.icon !== undefined ? (
            <span className={styles.icon} aria-hidden="true">
              {item.icon}
            </span>
          ) : null}
          <span className={styles.title}>{item.title}</span>
          <span className={styles.body}>{item.body}</span>
        </li>
      ))}
    </ul>
  );
}
