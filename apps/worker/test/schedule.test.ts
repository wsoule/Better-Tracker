import { todayIn } from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  dailyRunTooLate,
  decideDailyRun,
  firstInstantAtOrAfter,
  parseDailyRunAt,
} from '../src/schedule';

const at = (iso: string): Date => new Date(iso);

describe('parseDailyRunAt', () => {
  test.each([
    ['00:00', { hour: 0, minute: 0 }],
    ['08:00', { hour: 8, minute: 0 }],
    ['13:07', { hour: 13, minute: 7 }],
    ['23:59', { hour: 23, minute: 59 }],
  ])('accepts %s', (value, expected) => {
    expect(parseDailyRunAt(value)).toEqual(expected);
  });

  test.each([
    '8:00',
    '24:00',
    '12:60',
    '08:00:00',
    ' 08:00',
    '08.00',
    '0800',
    '',
    '-1:00',
    'eight',
  ])('rejects %p', (value) => {
    expect(parseDailyRunAt(value)).toBeNull();
  });
});

describe('decideDailyRun: ordinary days', () => {
  test('UTC: due from 08:00 until midnight', () => {
    expect(
      decideDailyRun(at('2026-10-21T07:59:59.999Z'), 'UTC', '08:00')
    ).toEqual({
      due: false,
      localDate: '2026-10-21',
      localTime: '07:59',
      dueAt: '2026-10-21T08:00:00.000Z',
    });
    expect(
      decideDailyRun(at('2026-10-21T08:00:00.000Z'), 'UTC', '08:00').due
    ).toBe(true);
    expect(
      decideDailyRun(at('2026-10-21T23:59:59.999Z'), 'UTC', '08:00').due
    ).toBe(true);
  });

  test('a zone behind UTC uses its own wall clock', () => {
    // 08:00 EDT is 12:00Z.
    expect(
      decideDailyRun(at('2026-10-21T11:59:00Z'), 'America/New_York', '08:00')
    ).toMatchObject({ due: false, localTime: '07:59' });
    expect(
      decideDailyRun(at('2026-10-21T12:00:00Z'), 'America/New_York', '08:00')
    ).toMatchObject({
      due: true,
      localDate: '2026-10-21',
      dueAt: '2026-10-21T12:00:00.000Z',
    });
  });
});

describe('decideDailyRun: America/New_York spring-forward (2026-03-08)', () => {
  const zone = 'America/New_York';

  test('08:00 is counted on the new (EDT) offset', () => {
    // The day before, 08:00 EST is 13:00Z.
    expect(
      decideDailyRun(at('2026-03-07T13:00:00Z'), zone, '08:00')
    ).toMatchObject({ due: true, dueAt: '2026-03-07T13:00:00.000Z' });
    // On the day, 08:00 EDT is 12:00Z.
    expect(
      decideDailyRun(at('2026-03-08T11:59:00Z'), zone, '08:00')
    ).toMatchObject({
      due: false,
      localTime: '07:59',
      dueAt: '2026-03-08T12:00:00.000Z',
    });
    expect(decideDailyRun(at('2026-03-08T12:00:00Z'), zone, '08:00').due).toBe(
      true
    );
  });

  test('a time in the skipped hour is due from the transition (03:00 EDT)', () => {
    // 01:59 EST = 06:59Z; the clock then jumps from 02:00 EST to 03:00 EDT.
    expect(
      decideDailyRun(at('2026-03-08T06:59:00Z'), zone, '02:30')
    ).toMatchObject({
      due: false,
      localTime: '01:59',
      dueAt: '2026-03-08T07:00:00.000Z',
    });
    expect(
      decideDailyRun(at('2026-03-08T07:00:00Z'), zone, '02:30')
    ).toMatchObject({ due: true, localTime: '03:00' });
    expect(
      firstInstantAtOrAfter('2026-03-08', { hour: 2, minute: 0 }, zone)
    ).toBe(Date.parse('2026-03-08T07:00:00Z'));
    expect(
      firstInstantAtOrAfter('2026-03-08', { hour: 3, minute: 0 }, zone)
    ).toBe(Date.parse('2026-03-08T07:00:00Z'));
    expect(
      firstInstantAtOrAfter('2026-03-08', { hour: 1, minute: 59 }, zone)
    ).toBe(Date.parse('2026-03-08T06:59:00Z'));
  });
});

describe('decideDailyRun: America/New_York fall-back (2026-11-01)', () => {
  const zone = 'America/New_York';

  test('08:00 is counted on the new (EST) offset', () => {
    // The day before, 08:00 EDT is 12:00Z; on the day 12:00Z is 07:00 EST.
    expect(decideDailyRun(at('2026-10-31T12:00:00Z'), zone, '08:00').due).toBe(
      true
    );
    expect(
      decideDailyRun(at('2026-11-01T12:00:00Z'), zone, '08:00')
    ).toMatchObject({
      due: false,
      localTime: '07:00',
      dueAt: '2026-11-01T13:00:00.000Z',
    });
    expect(decideDailyRun(at('2026-11-01T13:00:00Z'), zone, '08:00').due).toBe(
      true
    );
  });

  test('a repeated time is due from its first occurrence and stays due', () => {
    // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    expect(
      decideDailyRun(at('2026-11-01T05:29:00Z'), zone, '01:30')
    ).toMatchObject({
      due: false,
      localTime: '01:29',
      dueAt: '2026-11-01T05:30:00.000Z',
    });
    expect(decideDailyRun(at('2026-11-01T05:30:00Z'), zone, '01:30').due).toBe(
      true
    );
    // 06:10Z is 01:10 EST, after the clock went back: still due, even though
    // the wall clock reads earlier than 01:30.
    expect(
      decideDailyRun(at('2026-11-01T06:10:00Z'), zone, '01:30')
    ).toMatchObject({ due: true, localTime: '01:10', localDate: '2026-11-01' });
    // 02:00 shows once, on EST (07:00Z).
    expect(
      firstInstantAtOrAfter('2026-11-01', { hour: 2, minute: 0 }, zone)
    ).toBe(Date.parse('2026-11-01T07:00:00Z'));
  });
});

describe('decideDailyRun: Pacific/Auckland (ahead of UTC)', () => {
  const zone = 'Pacific/Auckland';

  test('the local date runs ahead of the UTC date', () => {
    // NZDT is UTC+13: 08:00 on the 21st is 19:00Z on the 20th.
    expect(decideDailyRun(at('2026-10-20T18:59:00Z'), zone, '08:00')).toEqual({
      due: false,
      localDate: '2026-10-21',
      localTime: '07:59',
      dueAt: '2026-10-20T19:00:00.000Z',
    });
    expect(decideDailyRun(at('2026-10-20T19:00:00Z'), zone, '08:00').due).toBe(
      true
    );
  });

  test('local midnight starts a new day that is not due yet', () => {
    // 10:59Z = 23:59 on the 21st; 11:00Z = 00:00 on the 22nd.
    expect(
      decideDailyRun(at('2026-10-21T10:59:00Z'), zone, '08:00')
    ).toMatchObject({ due: true, localDate: '2026-10-21' });
    expect(
      decideDailyRun(at('2026-10-21T11:00:00Z'), zone, '08:00')
    ).toMatchObject({
      due: false,
      localDate: '2026-10-22',
      localTime: '00:00',
      dueAt: '2026-10-21T19:00:00.000Z',
    });
  });

  test('daylight saving days', () => {
    // Spring-forward 2026-09-27: 02:00 NZST → 03:00 NZDT at 14:00Z on the 26th.
    expect(
      firstInstantAtOrAfter('2026-09-27', { hour: 2, minute: 30 }, zone)
    ).toBe(Date.parse('2026-09-26T14:00:00Z'));
    expect(
      firstInstantAtOrAfter('2026-09-27', { hour: 8, minute: 0 }, zone)
    ).toBe(Date.parse('2026-09-26T19:00:00Z'));
    // Fall-back 2026-04-05: 03:00 NZDT → 02:00 NZST; 02:30 shows first at 13:30Z.
    expect(
      firstInstantAtOrAfter('2026-04-05', { hour: 2, minute: 30 }, zone)
    ).toBe(Date.parse('2026-04-04T13:30:00Z'));
  });
});

describe('decideDailyRun: midnight boundaries', () => {
  test('00:00 is due all day from local midnight', () => {
    expect(decideDailyRun(at('2026-10-21T00:00:00Z'), 'UTC', '00:00')).toEqual({
      due: true,
      localDate: '2026-10-21',
      localTime: '00:00',
      dueAt: '2026-10-21T00:00:00.000Z',
    });
    expect(
      decideDailyRun(at('2026-10-20T23:59:59.999Z'), 'UTC', '00:00')
    ).toMatchObject({ due: true, localDate: '2026-10-20' });
  });

  test('23:59 is due for its last minute only, then the next day starts', () => {
    expect(decideDailyRun(at('2026-10-21T23:58:59Z'), 'UTC', '23:59').due).toBe(
      false
    );
    expect(decideDailyRun(at('2026-10-21T23:59:00Z'), 'UTC', '23:59').due).toBe(
      true
    );
    expect(
      decideDailyRun(at('2026-10-22T00:00:00Z'), 'UTC', '23:59')
    ).toMatchObject({ due: false, localDate: '2026-10-22' });
  });

  test('local midnight, not UTC midnight, changes the day', () => {
    // 03:59Z is 23:59 EDT on the 21st; 04:00Z is midnight on the 22nd.
    expect(
      decideDailyRun(at('2026-10-22T03:59:00Z'), 'America/New_York', '08:00')
    ).toMatchObject({ due: true, localDate: '2026-10-21' });
    expect(
      decideDailyRun(at('2026-10-22T04:00:00Z'), 'America/New_York', '08:00')
    ).toMatchObject({
      due: false,
      localDate: '2026-10-22',
      localTime: '00:00',
    });
  });
});

describe('decideDailyRun: input errors', () => {
  test('rejects an invalid DAILY_RUN_AT', () => {
    expect(() =>
      decideDailyRun(at('2026-10-21T08:00:00Z'), 'UTC', '8:00')
    ).toThrow(RangeError);
  });

  test('rejects an unknown timezone', () => {
    expect(() =>
      decideDailyRun(at('2026-10-21T08:00:00Z'), 'Mars/Olympus', '08:00')
    ).toThrow(RangeError);
  });

  test('rejects an invalid instant and a malformed date', () => {
    expect(() => decideDailyRun(new Date(Number.NaN), 'UTC', '08:00')).toThrow(
      RangeError
    );
    expect(() =>
      firstInstantAtOrAfter('2026-10-2', { hour: 8, minute: 0 }, 'UTC')
    ).toThrow(RangeError);
  });
});

// Reference implementation: walk the instants around a date minute by
// minute and return the first whose local date is `date` and whose wall
// clock reads `time` or later. Slow but obviously right (every transition
// in these zones falls on a whole minute).
function bruteForceFirstInstant(
  date: string,
  hour: number,
  minute: number,
  zone: string
): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const target = hour * 60 + minute;
  const start = Date.parse(`${date}T00:00:00Z`) - 15 * 3_600_000;
  for (let ms = start; ms < start + 54 * 3_600_000; ms += 60_000) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value])
    );
    const localDate = `${parts['year']}-${parts['month']}-${parts['day']}`;
    const wall = Number(parts['hour']) * 60 + Number(parts['minute']);
    if (localDate === date && wall >= target) return ms;
  }
  throw new Error(`no instant found for ${date} ${hour}:${minute} ${zone}`);
}

describe('firstInstantAtOrAfter matches a brute-force scan', () => {
  const cases: Array<[string, string]> = [
    ['America/New_York', '2026-03-08'],
    ['America/New_York', '2026-11-01'],
    ['America/New_York', '2026-10-21'],
    ['Europe/London', '2026-03-29'],
    ['Europe/London', '2026-10-25'],
    ['Pacific/Auckland', '2026-04-05'],
    ['Pacific/Auckland', '2026-09-27'],
    // 30-minute daylight-saving shifts.
    ['Australia/Lord_Howe', '2026-04-05'],
    ['Australia/Lord_Howe', '2026-10-04'],
    // Quarter-hour offsets, with and without daylight saving.
    ['Pacific/Chatham', '2026-04-05'],
    ['Pacific/Chatham', '2026-09-27'],
    ['Asia/Kathmandu', '2026-10-21'],
    // The extremes: UTC+14 and UTC-11.
    ['Pacific/Kiritimati', '2026-10-21'],
    ['Pacific/Pago_Pago', '2026-10-21'],
    // Transitions at local midnight: the day starts at 01:00 (spring) or
    // its last hour repeats (24:00 → 23:00), so midnight itself moves.
    ['America/Santiago', '2026-04-04'],
    ['America/Santiago', '2026-09-06'],
    ['America/Havana', '2026-03-08'],
    ['America/Havana', '2026-11-01'],
    ['Africa/Cairo', '2026-04-24'],
    ['Africa/Cairo', '2026-10-29'],
  ];
  const times: Array<[number, number]> = [
    [0, 0],
    [1, 30],
    [2, 0],
    [2, 15],
    [2, 30],
    [2, 45],
    [3, 0],
    [8, 0],
    [23, 59],
  ];
  test.each(cases)('%s on %s', (zone, date) => {
    for (const [hour, minute] of times) {
      const expected = bruteForceFirstInstant(date, hour, minute, zone);
      const actual = firstInstantAtOrAfter(date, { hour, minute }, zone);
      expect({
        zone,
        date,
        hour,
        minute,
        at: new Date(actual).toISOString(),
      }).toEqual({
        zone,
        date,
        hour,
        minute,
        at: new Date(expected).toISOString(),
      });
    }
  });
});

describe('decideDailyRun agrees with core todayIn', () => {
  test.each(['America/New_York', 'Pacific/Auckland', 'Australia/Lord_Howe'])(
    'hourly across transition days in %s',
    (zone) => {
      const start = Date.parse('2026-03-07T00:00:00Z');
      for (let ms = start; ms < start + 3 * 86_400_000; ms += 3_600_000) {
        const now = new Date(ms);
        expect(decideDailyRun(now, zone, '08:00').localDate).toBe(
          todayIn(zone, now)
        );
      }
      const autumn = Date.parse('2026-10-31T00:00:00Z');
      for (let ms = autumn; ms < autumn + 3 * 86_400_000; ms += 3_600_000) {
        const now = new Date(ms);
        expect(decideDailyRun(now, zone, '08:00').localDate).toBe(
          todayIn(zone, now)
        );
      }
    }
  );
});

describe('dailyRunTooLate', () => {
  test('warns only when no tick can land before midnight', () => {
    expect(dailyRunTooLate({ hour: 23, minute: 45 }, 15)).toBe(false);
    expect(dailyRunTooLate({ hour: 23, minute: 46 }, 15)).toBe(true);
    expect(dailyRunTooLate({ hour: 8, minute: 0 }, 15)).toBe(false);
    expect(dailyRunTooLate({ hour: 22, minute: 0 }, 180)).toBe(true);
  });
});
