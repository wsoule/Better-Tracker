// When is a workspace's daily run due? (architecture §9 `tick`.) Pure
// functions of an instant, an IANA timezone and the configured
// `DAILY_RUN_AT` wall-clock time, so the scheduler's only judgement call is
// unit-tested without a clock or a database.
//
// Rule: the daily run for local date D is due from the first instant of D
// at which the local wall clock shows DAILY_RUN_AT or later, until local
// midnight. Two daylight-saving cases make "first instant" matter:
//
// - Fall-back (a wall-clock hour repeats): the earlier of the two instants
//   counts, and the run stays due through the repeated hour instead of
//   flickering back to "not due" when the clock is set back.
// - Spring-forward (a wall-clock hour is skipped): a time inside the gap
//   never shows on the clock, so the run is due from the transition itself
//   (02:30 on a 02:00 → 03:00 day is due from 03:00).
//
// Running it twice on one day is prevented elsewhere (the engine claims
// (workspace, 'daily', D) before running); this module only decides "due".

/** Default `DAILY_RUN_AT`: 08:00 in each workspace's timezone. */
export const DEFAULT_DAILY_RUN_AT = '08:00';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DAILY_RUN_AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A validated `HH:MM` wall-clock time. */
export interface DailyTime {
  hour: number;
  minute: number;
}

/** What the scheduler decided for one workspace at one instant. */
export interface DailyRunDecision {
  /** The daily run for `localDate` is due (or overdue) at `now`. */
  due: boolean;
  /** The calendar date at `now` in the workspace timezone (`YYYY-MM-DD`). */
  localDate: string;
  /** The wall-clock time at `now` in the workspace timezone (`HH:MM`). */
  localTime: string;
  /** The instant the run for `localDate` became (or becomes) due, ISO UTC. */
  dueAt: string;
}

/**
 * Parses `DAILY_RUN_AT`: exactly `HH:MM` on a 24-hour clock, 00:00–23:59.
 * Returns null for anything else (`8:00`, `24:00`, `08:00:00`, padding).
 */
export function parseDailyRunAt(value: string): DailyTime | null {
  const match = DAILY_RUN_AT_PATTERN.exec(value);
  if (match === null) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// One formatter per timezone (constructing Intl.DateTimeFormat is costly).
const formatters = new Map<string, Intl.DateTimeFormat>();

// A formatter yielding numeric Gregorian date and 24-hour time parts in
// `timeZone`, independent of the host locale. Throws RangeError for an
// unknown timezone.
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// The wall clock in `timeZone` at the instant `ms` (epoch milliseconds).
function wallClockAt(ms: number, timeZone: string): WallClock {
  const clock: WallClock = {
    year: 0,
    month: 0,
    day: 0,
    hour: 0,
    minute: 0,
    second: 0,
  };
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type in clock) {
      clock[part.type as keyof WallClock] = Number(part.value);
    }
  }
  // Some engines print midnight as hour 24 even with h23.
  if (clock.hour === 24) clock.hour = 0;
  return clock;
}

// Epoch milliseconds of a wall-clock reading interpreted as if it were UTC.
function wallAsUtcMs(clock: WallClock): number {
  const date = new Date(0);
  date.setUTCFullYear(clock.year, clock.month - 1, clock.day);
  date.setUTCHours(clock.hour, clock.minute, clock.second, 0);
  return date.getTime();
}

// The timezone's UTC offset in milliseconds at the instant `ms` (positive
// east of UTC: +13 h for Pacific/Auckland in summer, -4 h for New York).
function offsetAt(ms: number, timeZone: string): number {
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return wallAsUtcMs(wallClockAt(ms, timeZone)) - wholeSecond;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDate(clock: WallClock): string {
  return `${String(clock.year).padStart(4, '0')}-${pad2(clock.month)}-${pad2(clock.day)}`;
}

/**
 * The first instant (epoch ms) on local date `date` (`YYYY-MM-DD`) at which
 * the wall clock in `timeZone` reads `time` or later. For a repeated
 * (fall-back) time that is the earlier instant; for a skipped
 * (spring-forward) time it is the transition instant.
 */
export function firstInstantAtOrAfter(
  date: string,
  time: DailyTime,
  timeZone: string
): number {
  const match = ISO_DATE_PATTERN.exec(date);
  if (match === null) {
    throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${date}`);
  }
  const naive = wallAsUtcMs({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: time.hour,
    minute: time.minute,
    second: 0,
  });
  // The real instant is `naive - offset` for an offset in effect within a
  // day of it; sampling a day either side catches both sides of a
  // transition near the target.
  const offsets = [
    ...new Set([
      offsetAt(naive - DAY_MS, timeZone),
      offsetAt(naive, timeZone),
      offsetAt(naive + DAY_MS, timeZone),
    ]),
  ];
  const valid = offsets
    .map((offset) => naive - offset)
    .filter((instant) => instant + offsetAt(instant, timeZone) === naive);
  if (valid.length > 0) return Math.min(...valid);

  // Skipped by a forward transition. The transition lies between the
  // instants the target would have under the old and the new offset; find
  // the first millisecond on the new offset by bisection.
  const candidates = offsets.map((offset) => naive - offset);
  let low = Math.min(...candidates);
  let high = Math.max(...candidates);
  const after = offsetAt(high, timeZone);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(middle, timeZone) === after) high = middle;
    else low = middle;
  }
  return high;
}

/**
 * Decides whether the daily run is due at `now` for a workspace in
 * `timezone` (IANA name) with `DAILY_RUN_AT` = `dailyAt` (`HH:MM`). Due once
 * the local wall clock has reached `dailyAt` today (see the module comment
 * for daylight-saving days), until local midnight. Throws RangeError for an
 * invalid `dailyAt` or an unknown timezone.
 */
export function decideDailyRun(
  now: Date,
  timezone: string,
  dailyAt: string
): DailyRunDecision {
  const time = parseDailyRunAt(dailyAt);
  if (time === null) {
    throw new RangeError(
      `DAILY_RUN_AT must be HH:MM (00:00–23:59): ${dailyAt}`
    );
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('now is not a valid date');
  const clock = wallClockAt(nowMs, timezone);
  const localDate = formatDate(clock);
  const dueAtMs = firstInstantAtOrAfter(localDate, time, timezone);
  return {
    due: nowMs >= dueAtMs,
    localDate,
    localTime: `${pad2(clock.hour)}:${pad2(clock.minute)}`,
    dueAt: new Date(dueAtMs).toISOString(),
  };
}

/** Minutes after local midnight of a `HH:MM` time. */
export function minutesOfDay(time: DailyTime): number {
  return time.hour * 60 + time.minute;
}

/**
 * True when a scheduler ticking every `intervalMinutes` might never tick
 * between `dailyAt` and local midnight, so the daily run could be missed
 * (e.g. 23:50 with a 15-minute cron). Used for a startup warning.
 */
export function dailyRunTooLate(
  dailyAt: DailyTime,
  intervalMinutes: number
): boolean {
  return minutesOfDay(dailyAt) + intervalMinutes > DAY_MS / MINUTE_MS;
}
