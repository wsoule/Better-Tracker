import { Link } from '../lib/link';
import { cx } from './class-names';
import styles from './nav-tabs.module.css';
import type { NavTabsProps } from './types';

/* Gr8r's tabs as navigation: each cell is a link (through the host's
   <Link>), the current one is underlined in ink (horizontal) or a raised
   pill (vertical) and marked aria-current="page". Unlike SegmentedControl (a
   radio group that changes state in place) every cell is a destination:
   a level switch whose levels are routes, or a settings sub-nav.
   Horizontal cells sit on one hairline and wrap; vertical cells stack
   into a column (Gr8r's settings sub-nav) and turn into a wrapping strip
   on narrow screens. A cell without href cannot be followed yet: it is
   drawn dimmed, with its note saying why. */
export function NavTabs({
  items,
  label,
  orientation = 'horizontal',
  size = 'md',
  fill = false,
  className,
}: NavTabsProps) {
  return (
    <nav
      aria-label={label}
      className={cx(
        styles.nav,
        orientation === 'vertical' ? styles.vertical : styles.horizontal,
        styles[size],
        fill ? styles.fill : undefined,
        className
      )}
    >
      <ul className={styles.list}>
        {items.map((item) => {
          const body = (
            <>
              <span className={styles.text}>{item.label}</span>
              {item.count !== undefined ? (
                <span className={styles.count}>{item.count}</span>
              ) : null}
              {item.note !== undefined && item.note !== '' ? (
                <span className={styles.note}>{item.note}</span>
              ) : null}
            </>
          );
          return (
            <li key={item.id} className={styles.item}>
              {item.href !== undefined ? (
                <Link
                  href={item.href}
                  className={cx(
                    styles.tab,
                    item.current === true ? styles.current : undefined
                  )}
                  aria-current={item.current === true ? 'page' : undefined}
                >
                  {body}
                </Link>
              ) : (
                <span
                  className={cx(styles.tab, styles.unavailable)}
                  aria-disabled="true"
                >
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
