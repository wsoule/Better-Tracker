import { describe, expect, test } from 'bun:test';

import {
  daysLeftPhrase,
  dueLabel,
  formatClock,
  formatDate,
  formatInstant,
  formatLongDate,
  greeting,
  plural,
} from '../lib/format';

describe('format', () => {
  test('formatDate drops the year only when it matches today', () => {
    expect(formatDate('2026-10-28', '2026-10-21')).toBe('Oct 28');
    expect(formatDate('2027-01-04', '2026-10-21')).toBe('Jan 4, 2027');
    expect(formatDate('2026-10-28')).toBe('Oct 28, 2026');
  });

  test('formatLongDate names the weekday', () => {
    expect(formatLongDate('2026-10-21')).toBe('Wednesday, October 21');
  });

  test('daysLeftPhrase covers today, tomorrow, future and overdue', () => {
    expect(daysLeftPhrase(0)).toBe('due today');
    expect(daysLeftPhrase(1)).toBe('due tomorrow');
    expect(daysLeftPhrase(3)).toBe('in 3 days');
    expect(daysLeftPhrase(-1)).toBe('1 day overdue');
    expect(daysLeftPhrase(-3)).toBe('3 days overdue');
  });

  test('dueLabel combines date and phrase', () => {
    expect(dueLabel('2026-10-24', 3, '2026-10-21')).toBe('Oct 24 · in 3 days');
    expect(dueLabel(null, null, '2026-10-21')).toBe('No target date');
  });

  test('dueLabel gives a complete milestone no countdown', () => {
    // Done work is never overdue, whatever its date.
    expect(dueLabel('2026-10-01', -20, '2026-10-21', 'complete')).toBe(
      'Oct 1 · complete'
    );
    expect(dueLabel('2026-10-24', 3, '2026-10-21', 'complete')).toBe(
      'Oct 24 · complete'
    );
    expect(dueLabel('2026-10-01', -20, '2026-10-21', 'overdue')).toBe(
      'Oct 1 · 20 days overdue'
    );
    expect(dueLabel(null, null, '2026-10-21', 'complete')).toBe(
      'No target date'
    );
  });

  test('rejects malformed dates loudly', () => {
    expect(() => formatDate('10/28/2026')).toThrow(/YYYY-MM-DD/);
  });

  test('plural and greeting', () => {
    expect(plural(1, 'issue')).toBe('1 issue');
    expect(plural(2, 'issue')).toBe('2 issues');
    expect(plural(2, 'person', 'people')).toBe('2 people');
    expect(greeting(9)).toBe('Good morning');
    expect(greeting(13)).toBe('Good afternoon');
    expect(greeting(20)).toBe('Good evening');
  });

  // ICU versions disagree on the glue between date and time ("Oct 21, 3:04"
  // in Node, "Oct 21 at 3:04" in Bun on macOS 26) and on the space before
  // AM/PM (U+202F in Node), so the same instant must read the same on
  // every host.
  test('formatInstant and formatClock write the same text on every ICU', () => {
    const iso = '2026-10-21T15:04:00.000Z';
    expect(formatInstant(iso, 'UTC')).toBe('Oct 21, 3:04 PM UTC');
    expect(formatInstant(iso, 'America/Denver')).toBe('Oct 21, 9:04 AM MDT');
    expect(formatInstant('2026-10-21T00:05:00.000Z', 'UTC')).toBe(
      'Oct 21, 12:05 AM UTC'
    );
    expect(formatInstant('not a date', 'UTC')).toBe('not a date');
    expect(formatClock(iso, 'UTC')).toBe('3:04 PM');
    expect(formatClock('not a date', 'UTC')).toBe('not a date');
  });
});
