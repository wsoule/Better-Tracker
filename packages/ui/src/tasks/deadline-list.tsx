'use client';

import { CalendarCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import StatusMark from '../components/status-mark';
import { Link } from '../lib/link';
import styles from './deadline-list.module.css';
import { EmptyState } from './notice';
import type { DeadlineListProps } from './types';

type HeadingTag = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/* Gr8r's "Upcoming deadlines" panel: groups (Overdue / Today / Tomorrow /
   This week) with a semibold label and a count, each item a linked row
   (status mark, milestone, a quiet line under it, due). The group's tone
   (data-tone on the group) colours its label and dates. Empty groups are
   left out; when every group is empty the panel gives way to one
   EmptyState saying `emptyLabel`. Long groups show `limit` items and a
   "+N more" disclosure; opening it moves focus to the first revealed item
   so keyboard users land on the new content. */
export function DeadlineList({
  groups,
  limit = 4,
  emptyLabel = 'Nothing due',
  label = 'Upcoming deadlines',
  headingLevel = 3,
}: DeadlineListProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  // The group whose overflow was just revealed; its first new item takes
  // focus after the render that mounts it.
  const pendingFocus = useRef<string | null>(null);
  const Heading = `h${headingLevel}` as HeadingTag;
  const baseId = useId();

  useEffect(() => {
    const groupId = pendingFocus.current;
    if (groupId === null) return;
    pendingFocus.current = null;
    const items = rootRef.current?.querySelectorAll<HTMLElement>(
      `[data-deadline-group="${CSS.escape(groupId)}"] [data-deadline-item] a`
    );
    items?.[limit]?.focus();
  }, [open, limit]);

  function toggle(groupId: string) {
    const next = new Set(open);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
      pendingFocus.current = groupId;
    }
    setOpen(next);
  }

  const filled = groups.filter((group) => group.items.length > 0);
  if (filled.length === 0) {
    return (
      <div role="group" aria-label={label}>
        <EmptyState icon={<CalendarCheck size={22} strokeWidth={1.8} />}>
          {emptyLabel}
        </EmptyState>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={styles.root} role="group" aria-label={label}>
      {filled.map((group) => {
        const expanded = open.has(group.id);
        const shown = expanded ? group.items : group.items.slice(0, limit);
        const hidden = group.items.length - limit;
        const headingId = `${baseId}-${group.id}`;
        const listId = `${baseId}-${group.id}-items`;
        return (
          <section
            key={group.id}
            className={styles.group}
            aria-labelledby={headingId}
            data-deadline-group={group.id}
            data-tone={group.tone ?? 'default'}
          >
            <Heading id={headingId} className={styles.head}>
              <span className={styles.label}>{group.label}</span>
              <span className={styles.count}>
                <span className="srOnly">, </span>
                {group.items.length}
              </span>
            </Heading>
            <ul id={listId} className={styles.items}>
              {shown.map((item) => (
                <li key={item.id} data-deadline-item="">
                  <Link href={item.href} className={styles.link}>
                    <StatusMark status={item.status} label={item.statusLabel} />
                    <span className={styles.main}>
                      <span className={styles.itemLabel}>{item.label}</span>
                      {item.sublabel !== undefined && item.sublabel !== '' ? (
                        <span className={styles.sub}>{item.sublabel}</span>
                      ) : null}
                    </span>
                    <span className={styles.due}>{item.dueLabel}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {hidden > 0 ? (
              <button
                type="button"
                className={styles.more}
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => toggle(group.id)}
              >
                {expanded ? 'Show fewer' : `+${hidden} more`}
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
