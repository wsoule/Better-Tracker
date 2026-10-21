'use client';

import {
  memo,
  type NamedExoticComponent,
  type ReactElement,
  useMemo,
} from 'react';

import { cx } from '../tasks/class-names';
import {
  createScale,
  dayTicks,
  type MonthSpan,
  monthSpans,
  weekendSpans,
  weekTicks,
} from './dates';
import styles from './timeline-scale.module.css';
import type { TimelineZoom } from './types';

// The chart's time furniture, both memoised on primitives so a re-date or
// a selection change never re-renders a hundred tick cells: the two-row
// sticky header (months; day or week ticks) and the grid layer behind the
// rows (weekend shading, week and month rules, the TODAY rule).

/* The longest month name that fits its span (mono 10px caps at 0.14em
   tracking ≈ 7.4px a character, plus the 20px of padding): a month only
   partly inside the window says "Sep 2026" or "Sep" instead of running
   into the next month's name. */
function fitMonthLabel(span: MonthSpan): string {
  for (const label of [span.label, span.shortLabel, span.tinyLabel]) {
    if (label.length * 7.4 + 22 <= span.width) return label;
  }
  return '';
}

interface ScaleProps {
  windowStart: string;
  windowEnd: string;
  dayWidth: number;
  zoom: TimelineZoom;
  today: string;
  /** Centre of today's column, or null outside the window. */
  todayX: number | null;
}

function TimelineScaleHeaderImpl({
  windowStart,
  windowEnd,
  dayWidth,
  zoom,
  today,
  todayX,
}: ScaleProps): ReactElement {
  const ticks = useMemo(() => {
    const scale = createScale(windowStart, windowEnd, dayWidth);
    return {
      width: scale.width,
      months: monthSpans(scale),
      days: zoom === 'weeks' ? dayTicks(scale) : [],
      weeks: zoom === 'months' ? weekTicks(scale) : [],
    };
  }, [windowStart, windowEnd, dayWidth, zoom]);

  return (
    <div className={styles.scale} style={{ width: ticks.width }}>
      <div className={styles.months}>
        {ticks.months.map((m) => (
          <div
            key={m.key}
            className={styles.month}
            style={{ left: m.x, width: m.width }}
          >
            <span className={styles.monthLabel}>{fitMonthLabel(m)}</span>
          </div>
        ))}
      </div>
      <div className={styles.ticks}>
        {ticks.days.map((d) => (
          <div
            key={d.iso}
            className={cx(
              styles.tick,
              d.weekend ? styles.weekend : undefined,
              d.iso === today ? styles.todayTick : undefined
            )}
            style={{ left: d.x, width: dayWidth }}
          >
            {d.day}
          </div>
        ))}
        {ticks.weeks.map((w) => (
          <div
            key={w.iso}
            className={cx(styles.tick, styles.weekTick)}
            style={{ left: w.x, width: w.width }}
          >
            {w.width >= 44 ? w.label : null}
          </div>
        ))}
      </div>
      {todayX === null ? null : (
        <>
          <span className={styles.todayFlag} style={{ left: todayX }}>
            Today
          </span>
          <span className={styles.todayRule} style={{ left: todayX }} />
        </>
      )}
    </div>
  );
}

export const TimelineScaleHeader: NamedExoticComponent<ScaleProps> = memo(
  TimelineScaleHeaderImpl
);

interface GridProps extends ScaleProps {
  height: number;
}

function TimelineGridLayerImpl({
  windowStart,
  windowEnd,
  dayWidth,
  zoom,
  todayX,
  height,
}: GridProps): ReactElement {
  const lines = useMemo(() => {
    const scale = createScale(windowStart, windowEnd, dayWidth);
    return {
      width: scale.width,
      weekends: zoom === 'weeks' ? weekendSpans(scale) : [],
      weeks: weekTicks(scale).filter((w) => w.x > 0),
      months: monthSpans(scale).filter((m) => m.x > 0),
    };
  }, [windowStart, windowEnd, dayWidth, zoom]);

  return (
    <div
      className={styles.grid}
      style={{ width: lines.width, height }}
      aria-hidden="true"
    >
      {lines.weekends.map((s) => (
        <div
          key={s.x}
          className={styles.weekendBand}
          style={{ left: s.x, width: s.width }}
        />
      ))}
      {lines.weeks.map((w) => (
        <div key={w.iso} className={styles.weekRule} style={{ left: w.x }} />
      ))}
      {lines.months.map((m) => (
        <div key={m.key} className={styles.monthRule} style={{ left: m.x }} />
      ))}
      {todayX === null ? null : (
        <div className={styles.todayLine} style={{ left: todayX }} />
      )}
    </div>
  );
}

export const TimelineGridLayer: NamedExoticComponent<GridProps> = memo(
  TimelineGridLayerImpl
);
