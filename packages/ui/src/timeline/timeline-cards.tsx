'use client';

import {
  memo,
  type NamedExoticComponent,
  type ReactElement,
  useMemo,
} from 'react';

import StatusMark from '../components/status-mark';
import { Link } from '../lib/link';
import { cx } from '../tasks/class-names';
import { formatDay } from './dates';
import { describeMilestone } from './describe';
import { applyOverrides } from './layout';
import styles from './timeline-cards.module.css';
import type { TimelineBar, TimelineGroup } from './types';

// The phone (≤ 900px) fallback, after the competitors Matrix cards: one
// hairline card per project listing its milestones as rows (status mark,
// name, receipts, due date), in due-date order with the undated last. No
// drag here: re-dating needs the drawer's date field on a phone.

export interface TimelineCardsProps {
  groups: TimelineGroup[];
  today: string;
  /** Optimistic due dates by bar id. */
  overrides: ReadonlyMap<string, string>;
  selectedBarId?: string;
  focusLaneId?: string;
  onOpenBar: (barId: string) => void;
}

/** One line of receipts under a milestone name: status, progress, tags,
 * the missing input. */
function receipts(bar: TimelineBar): string {
  const parts = [bar.statusLabel];
  if (bar.progressLabel !== undefined) parts.push(bar.progressLabel);
  for (const tag of bar.tags ?? []) parts.push(tag);
  if (bar.missing !== undefined) parts.push(bar.missing);
  return parts.join(' · ');
}

function TimelineCardsImpl({
  groups,
  today,
  overrides,
  selectedBarId,
  focusLaneId,
  onOpenBar,
}: TimelineCardsProps): ReactElement {
  // Bars per lane with optimistic dates applied, sorted by due date.
  const sorted = useMemo(() => {
    const out = new Map<string, TimelineBar[]>();
    for (const group of groups) {
      for (const lane of group.lanes) {
        const bars = [...applyOverrides(lane.bars, overrides)];
        bars.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
        out.set(lane.id, bars);
      }
    }
    return out;
  }, [groups, overrides]);

  return (
    <div className={styles.cards}>
      {groups.map((group) => (
        <section
          key={group.id}
          className={styles.group}
          aria-label={group.label}
        >
          <h3 className={styles.groupHead}>
            {group.label}
            <span className={styles.groupCount}>
              {group.lanes.length}{' '}
              {group.lanes.length === 1 ? 'project' : 'projects'}
            </span>
          </h3>
          {group.lanes.map((lane) => {
            const bars = sorted.get(lane.id) ?? [];
            return (
              <article
                key={lane.id}
                className={cx(
                  styles.card,
                  lane.muted === true ? styles.cardMuted : undefined,
                  lane.id === focusLaneId ? styles.cardFocus : undefined
                )}
              >
                <header className={styles.cardHead}>
                  {lane.href !== undefined ? (
                    <Link href={lane.href} className={styles.cardName}>
                      {lane.label}
                    </Link>
                  ) : (
                    <span className={styles.cardName}>{lane.label}</span>
                  )}
                  {lane.sublabel !== undefined ? (
                    <span
                      className={cx(
                        styles.cardSub,
                        lane.sublabelTone === 'accent'
                          ? styles.cardSubAccent
                          : undefined
                      )}
                    >
                      {lane.sublabel}
                    </span>
                  ) : null}
                </header>
                {bars.length === 0 && lane.undated.length === 0 ? (
                  <p className={styles.none}>No milestones</p>
                ) : (
                  <ul className={styles.rows}>
                    {bars.map((bar) => (
                      <li key={bar.id}>
                        <button
                          type="button"
                          className={cx(
                            styles.row,
                            bar.id === selectedBarId
                              ? styles.rowSelected
                              : undefined
                          )}
                          aria-label={describeMilestone(bar, today).join(', ')}
                          aria-current={
                            bar.id === selectedBarId ? 'true' : undefined
                          }
                          onClick={() => onOpenBar(bar.id)}
                        >
                          <StatusMark
                            status={
                              lane.muted === true ? 'on_track' : bar.status
                            }
                            label={bar.statusLabel}
                          />
                          <span className={styles.rowBody}>
                            <span className={styles.rowName}>{bar.label}</span>
                            <span
                              className={cx(
                                styles.rowMeta,
                                bar.missing !== undefined ||
                                  bar.status === 'overdue'
                                  ? styles.rowMetaAccent
                                  : undefined
                              )}
                            >
                              {receipts(bar)}
                            </span>
                          </span>
                          <span
                            className={cx(
                              styles.rowDue,
                              bar.status === 'overdue'
                                ? styles.rowDueAccent
                                : undefined
                            )}
                          >
                            {formatDay(bar.end)}
                          </span>
                        </button>
                      </li>
                    ))}
                    {lane.undated.map((chip) => (
                      <li key={chip.id}>
                        <button
                          type="button"
                          className={cx(
                            styles.row,
                            chip.id === selectedBarId
                              ? styles.rowSelected
                              : undefined
                          )}
                          aria-label={`${chip.label}, ${chip.statusLabel}, no due date`}
                          aria-current={
                            chip.id === selectedBarId ? 'true' : undefined
                          }
                          onClick={() => onOpenBar(chip.id)}
                        >
                          <StatusMark status="missing" label="No date" />
                          <span className={styles.rowBody}>
                            <span className={styles.rowName}>{chip.label}</span>
                            <span className={styles.rowMeta}>
                              {chip.statusLabel}
                            </span>
                          </span>
                          <span className={styles.rowDue}>No date</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}

export const TimelineCards: NamedExoticComponent<TimelineCardsProps> =
  memo(TimelineCardsImpl);
