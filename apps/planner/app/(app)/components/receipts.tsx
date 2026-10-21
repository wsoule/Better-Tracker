import styles from './receipts.module.css';

export interface ReceiptItem {
  key: string;
  title: string;
  body: string;
}

/* A receipts list: hairline rows of mono key, mono title and a sentence or
   two, collapsed on -1px margins under a block bar. The landing page lists
   what the tool does with it, /setup what an install does. */
export default function Receipts({
  items,
  label,
}: {
  items: readonly ReceiptItem[];
  /** Accessible name of the list. */
  label: string;
}) {
  return (
    <ol className={styles.list} aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className={styles.row}>
          <span className={styles.key}>{item.key}</span>
          <span className={styles.title}>{item.title}</span>
          <p className={styles.body}>{item.body}</p>
        </li>
      ))}
    </ol>
  );
}
