"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./tabs.module.css";

/* Client-side tab strip from the competitors site: a grid of bordered tabs,
   selected = ink fill, hover = orange flood, arrow-key roving focus. */
export type TabItem = { id: string; label: string; content: ReactNode };

export default function Tabs({ items }: { items: TabItem[] }) {
  const [active, setActive] = useState(items[0].id);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = setActive;

  function onKey(e: React.KeyboardEvent, i: number) {
    const n = items.length;
    const next = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[
      e.key
    ];
    if (next === undefined) return;
    e.preventDefault();
    select(items[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div className={`block ${styles.wrap}`}>
      <div
        role="tablist"
        aria-label="Sections"
        className={styles.tablist}
        style={{ "--tab-count": items.length } as CSSProperties}
      >
        {items.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === active}
            aria-controls={`panel-${t.id}`}
            tabIndex={t.id === active ? 0 : -1}
            className={styles.tab}
            onClick={() => select(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`panel-${t.id}`}
          aria-labelledby={`tab-${t.id}`}
          hidden={t.id !== active}
          className={styles.panel}
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
