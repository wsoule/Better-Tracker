// Human wording for dates and countdowns, shared by every page and adapter
// so the whole app says "Oct 28", "in 3 days", "3 days overdue" the same
// way. Pure functions over YYYY-MM-DD strings; no locale or timezone
// dependence (the engine already decided what "today" is).

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function parts(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** "Oct 28", or "Oct 28, 2026" when the year differs from `today`'s. */
export function formatDate(date: string, today?: string): string {
  const { y, m, d } = parts(date);
  const short = `${MONTHS[m - 1]} ${d}`;
  if (today === undefined) return `${short}, ${y}`;
  return parts(today).y === y ? short : `${short}, ${y}`;
}

/** "Wednesday, October 21" for page headers. */
export function formatLongDate(date: string): string {
  const { y, m, d } = parts(date);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${FULL_MONTHS[m - 1]} ${d}`;
}

/** "due today", "due tomorrow", "in 3 days", "1 day overdue", "3 days overdue". */
export function daysLeftPhrase(daysLeft: number): string {
  if (daysLeft === 0) return 'due today';
  if (daysLeft === 1) return 'due tomorrow';
  if (daysLeft > 1) return `in ${daysLeft} days`;
  const late = -daysLeft;
  return late === 1 ? '1 day overdue' : `${late} days overdue`;
}

/**
 * "Oct 28 · in 3 days"; just the phrase when there is no date. Pass the
 * milestone's status (§2.5) where it is known: a complete milestone (every
 * issue done or canceled) has no countdown, since finished work is never
 * "20 days overdue" or "in 3 days", so it reads "Oct 1 · complete".
 */
export function dueLabel(
  targetDate: string | null,
  daysLeft: number | null,
  today: string,
  status?: string | null
): string {
  if (targetDate === null) return 'No target date';
  const when = formatDate(targetDate, today);
  if (status === 'complete') return `${when} · complete`;
  return daysLeft === null ? when : `${when} · ${daysLeftPhrase(daysLeft)}`;
}

/** Pluralises a count: plural(3, 'issue') → "3 issues". */
export function plural(count: number, noun: string, many?: string): string {
  return `${count} ${count === 1 ? noun : (many ?? `${noun}s`)}`;
}

/** Morning / afternoon / evening greeting from an hour 0–23. */
export function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "Oct 21, 3:04 PM UTC"-style timestamp for logs and run lists. */
export function formatInstant(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(date);
}

/** "9:12 AM"-style clock time in `timeZone`, as formatInstant writes it
    (Settings → Status, for times within a day of now). */
export function formatClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/** Whether two instants fall on the same calendar day in `timeZone`. */
export function sameLocalDay(a: string, b: string, timeZone: string): boolean {
  const day = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  });
  const first = new Date(a);
  const second = new Date(b);
  if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) {
    return false;
  }
  return day.format(first) === day.format(second);
}
