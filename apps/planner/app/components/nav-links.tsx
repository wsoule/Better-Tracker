'use client';

import { usePathname } from 'next/navigation';

import styles from './nav.module.css';

export interface NavLink {
  href: string;
  label: string;
}

/* The link strip. A client island only so the current section can carry
   aria-current (its drawn underline stays on). */
export default function NavLinks({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  return (
    <ul className={styles.links}>
      {links.map((link) => {
        const current =
          pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <li key={link.href}>
            <a
              className={styles.link}
              href={link.href}
              aria-current={current ? 'page' : undefined}
            >
              {link.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
