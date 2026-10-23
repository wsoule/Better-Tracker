import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  TimelineChart,
  type TimelineChartProps,
  type TimelineGroup,
} from '../src/index';
import {
  barDueTone,
  laneSublabelTone,
  receiptsTone,
  undatedTone,
} from '../src/timeline/tones';

// Status colours on the timeline (owner decision 2026-10-22,
// docs/architecture.md §8.2 "Status colours"): bars, diamonds, the legend,
// the milestones row, connectors, the lane sublabel and the phone cards
// draw status with the status hues (red overdue, amber at risk and a
// missing input, green on track and done, grey inactive), keeping every
// shape; the purple accent stays for today, selection, focus and hover
// only. CSS modules resolve to empty objects under Bun, so the colours are
// checked in the stylesheets and the components through their data-tone.

afterEach(cleanup);

const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet under src, comments removed and whitespace collapsed. */
function css(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect([selector, at >= 0]).toEqual([selector, true]);
  const open = sheet.indexOf('{', at);
  return sheet.slice(open + 1, sheet.indexOf('}', open)).trim();
}

describe('bars and diamonds (timeline-bar.module.css)', () => {
  const sheet = css('timeline/timeline-bar.module.css');

  test('each status keeps its shape and takes its hue', () => {
    expect(rule(sheet, '.on_track')).toBe('border-color: var(--green);');
    expect(rule(sheet, '.at_risk')).toContain('border: 2px solid var(--amber)');
    expect(rule(sheet, '.at_risk .progress')).toContain(
      'color: var(--amber-ink)'
    );
    expect(rule(sheet, '.overdue')).toContain('background: var(--red)');
    expect(rule(sheet, '.overdue')).toContain('color: var(--on-red)');
    // Done stays the ink fill: a green fill has the red one's lightness,
    // so without red-green vision the two would be the same filled bar.
    expect(rule(sheet, '.done')).toContain('background: var(--foreground)');
    expect(rule(sheet, '.done')).toContain('color: var(--background)');
    // Missing input: still the hatch with a grey rule.
    expect(rule(sheet, '.missing')).toContain('border-color: var(--muted)');
    expect(rule(sheet, '.missing')).toContain('repeating-linear-gradient');
    // An inactive lane: the inactive mark grey, no hue in its words.
    expect(rule(sheet, '.muted')).toContain('border-color: var(--grey)');
    expect(
      rule(sheet, '.muted .progress, .muted .tag, .muted .missingLine')
    ).toBe('color: var(--grey-2-ink);');
  });

  test('words on a filled bar take the fill’s own text token', () => {
    expect(
      rule(sheet, '.overdue .progress, .overdue .cue, .overdue .missingLine')
    ).toBe('color: var(--on-red);');
    expect(rule(sheet, '.done .progress, .done .cue')).toBe(
      'color: var(--muted-inverse);'
    );
  });

  test('the missing input is named in the warning text', () => {
    expect(rule(sheet, '.missingLine')).toContain('color: var(--amber-ink)');
    // On the hatch it takes the darker amber step (tokens.css).
    expect(rule(sheet, '.missing .missingLine')).toBe(
      'color: var(--amber-ink-strong);'
    );
  });

  test('the due-date diamond repeats the bar’s mark', () => {
    expect(rule(sheet, '.d_done')).toContain('background: var(--foreground)');
    expect(rule(sheet, '.d_on_track')).toContain('border-color: var(--green)');
    expect(rule(sheet, '.d_at_risk')).toBe('border: 2px solid var(--amber);');
    expect(rule(sheet, '.d_overdue')).toContain('background: var(--red)');
    expect(rule(sheet, '.d_muted')).toBe('border-color: var(--grey);');
  });

  test('no status rule uses the purple accent', () => {
    for (const selector of [
      '.on_track',
      '.at_risk',
      '.at_risk .progress',
      '.overdue',
      '.done',
      '.missing',
      '.missingLine',
      '.muted',
      '.d_done',
      '.d_on_track',
      '.d_at_risk',
      '.d_overdue',
      '.d_missing',
      '.d_muted',
    ]) {
      expect([selector, rule(sheet, selector)]).not.toEqual([
        selector,
        expect.stringContaining('accent'),
      ]);
    }
  });

  test('forced colours keep the filled bars and diamonds filled', () => {
    const at = sheet.indexOf('@media (forced-colors: active)');
    expect(at).toBeGreaterThanOrEqual(0);
    const block = sheet.slice(at);
    expect(block).toContain('.overdue, .done { forced-color-adjust: none;');
    expect(block).toContain('background: CanvasText');
    expect(block).toContain('.d_overdue, .d_done {');
  });
});

describe('chart furniture (timeline-chart.module.css)', () => {
  const sheet = css('timeline/timeline-chart.module.css');

  test('the legend swatches are the bars in miniature', () => {
    expect(rule(sheet, '.s_on_track')).toBe('border-color: var(--green);');
    expect(rule(sheet, '.s_overdue')).toContain('background: var(--red)');
    expect(rule(sheet, '.s_at_risk')).toBe('border: 2px solid var(--amber);');
    expect(rule(sheet, '.s_done')).toBe('background: var(--foreground);');
    expect(rule(sheet, '.s_missing')).toContain('repeating-linear-gradient');
  });

  test('the milestones row marks take the same hues', () => {
    expect(rule(sheet, '.m_on_track')).toBe('border-color: var(--green);');
    expect(rule(sheet, '.m_done')).toBe('background: var(--foreground);');
    expect(rule(sheet, '.m_at_risk')).toBe('border: 2px solid var(--amber);');
    expect(rule(sheet, '.m_overdue')).toContain('background: var(--red)');
    expect(rule(sheet, '.m_muted')).toBe('border-color: var(--grey);');
  });

  test('risk chains are amber, NO LEAD and "No date" use the tone hook', () => {
    // The 1px connector takes the amber TEXT colour: it crosses the
    // weekend columns, where the MARK colour is under 3:1.
    expect(rule(sheet, '.edgeRisk path')).toBe('stroke: var(--amber-ink);');
    expect(rule(sheet, '.edgeSelected.edgeRisk path')).toBe(
      'stroke: var(--amber-ink);'
    );
    expect(rule(sheet, '.laneSubToned')).toContain('color: var(--tone-ink)');
    expect(rule(sheet, '.chipNoteToned')).toBe('color: var(--tone-ink);');
  });

  test('a save error is red', () => {
    expect(rule(sheet, '.liveError .liveKey')).toBe('color: var(--red-ink);');
  });

  test('today stays the purple accent', () => {
    const scale = css('timeline/timeline-scale.module.css');
    expect(rule(scale, '.todayRule')).toContain('background: var(--accent)');
    expect(rule(scale, '.todayLine')).toContain('background: var(--accent)');
    expect(rule(scale, '.todayFlag')).toContain('background: var(--accent)');
  });
});

describe('phone cards (timeline-cards.module.css)', () => {
  const sheet = css('timeline/timeline-cards.module.css');

  test('status words take their tone’s text colour', () => {
    expect(rule(sheet, '.cardSubToned')).toContain('color: var(--tone-ink)');
    expect(rule(sheet, '.rowMetaToned')).toContain('color: var(--tone-ink)');
    expect(rule(sheet, '.rowDueToned')).toBe('color: var(--tone-ink);');
  });
});

describe('tone helpers (timeline/tones.ts)', () => {
  test('a sublabel is coloured only by a status tone on an active lane', () => {
    expect(laneSublabelTone({ sublabelTone: 'warning' })).toBe('warning');
    expect(
      laneSublabelTone({ sublabelTone: 'warning', muted: true })
    ).toBeUndefined();
    expect(laneSublabelTone({ sublabelTone: 'default' })).toBeUndefined();
    expect(laneSublabelTone({ sublabelTone: 'muted' })).toBeUndefined();
    expect(laneSublabelTone({})).toBeUndefined();
  });

  test('receipts: overdue danger, at risk or missing warning, else plain', () => {
    expect(receiptsTone({ status: 'overdue' }, true)).toBe('danger');
    expect(receiptsTone({ status: 'at_risk' }, true)).toBe('warning');
    expect(receiptsTone({ status: 'missing' }, true)).toBe('warning');
    expect(
      receiptsTone({ status: 'on_track', missing: 'Missing: lead' }, true)
    ).toBe('warning');
    expect(receiptsTone({ status: 'on_track' }, true)).toBe('default');
    expect(receiptsTone({ status: 'done' }, true)).toBe('default');
    expect(receiptsTone({ status: 'overdue' }, false)).toBe('default');
  });

  test('due dates: overdue danger; "No date" warning; never on a quiet lane', () => {
    expect(barDueTone({ status: 'overdue' }, true)).toBe('danger');
    expect(barDueTone({ status: 'at_risk' }, true)).toBe('default');
    expect(barDueTone({ status: 'overdue' }, false)).toBe('default');
    expect(undatedTone(true)).toBe('warning');
    expect(undatedTone(false)).toBe('default');
  });
});

const GROUPS: TimelineGroup[] = [
  {
    id: 'g',
    label: 'Platform',
    lanes: [
      {
        id: 'p-live',
        label: 'Ledger API',
        sublabel: 'No lead',
        sublabelTone: 'warning',
        bars: [
          {
            id: 'm-risk',
            label: 'Public beta',
            start: '2026-10-01',
            end: '2026-10-25',
            status: 'at_risk',
            statusLabel: 'At risk',
            progressLabel: '0/3',
          },
          {
            id: 'm-track',
            label: 'General availability',
            start: '2026-10-25',
            end: '2026-11-20',
            status: 'on_track',
            statusLabel: 'On track',
          },
        ],
        undated: [
          {
            id: 'm-undated',
            label: 'Pricing page',
            status: 'missing',
            statusLabel: 'No target date',
          },
        ],
      },
      {
        id: 'p-paused',
        label: 'Fjord analytics',
        sublabel: 'No lead',
        // An inactive lane never colours its sublabel, whatever it asks.
        sublabelTone: 'warning',
        muted: true,
        bars: [],
        undated: [
          {
            id: 'm-paused',
            label: 'Dashboards',
            status: 'missing',
            statusLabel: 'No target date',
          },
        ],
      },
    ],
  },
];

function renderChart(overrides: Partial<TimelineChartProps> = {}) {
  const props: TimelineChartProps = {
    today: '2026-10-21',
    windowStart: '2026-09-21',
    windowEnd: '2027-01-17',
    zoom: 'weeks',
    groups: GROUPS,
    onOpenBar: () => {},
    ...overrides,
  };
  return render(<TimelineChart {...props} />);
}

describe('the chart emits its tones', () => {
  test('NO LEAD is a warning on an active lane and quiet on an inactive one', () => {
    const { container } = renderChart();
    const live = container.querySelector(
      '[role="group"][data-lane-id="p-live"]'
    );
    const paused = container.querySelector(
      '[role="group"][data-lane-id="p-paused"]'
    );
    // The innermost span that says it (its line wrapper says it too).
    const sub = (lane: Element | null) =>
      [...(lane?.querySelectorAll('span') ?? [])].find(
        (el) => el.textContent === 'No lead' && el.children.length === 0
      );
    expect(sub(live)?.getAttribute('data-tone')).toBe('warning');
    expect(sub(paused)?.hasAttribute('data-tone')).toBe(false);
  });

  test('an undated chip says "No date" as a warning, quietly when inactive', () => {
    const { container } = renderChart();
    const note = (lane: string) =>
      [
        ...container.querySelectorAll(
          `[role="group"][data-lane-id="${lane}"] button span`
        ),
      ].find((el) => el.textContent === 'No date');
    expect(note('p-live')?.getAttribute('data-tone')).toBe('warning');
    expect(note('p-paused')?.getAttribute('data-tone')).toBe('default');
  });

  test('the phone cards colour receipts and dates by status', () => {
    const { container } = renderChart();
    const card = container.querySelector('article[data-lane-id="p-live"]');
    if (card === null) throw new Error('no card');
    const tones = [...card.querySelectorAll('button [data-tone]')].map((el) => [
      el.textContent,
      el.getAttribute('data-tone'),
    ]);
    // Receipts then due date per row; the undated row's "No date" is a
    // warning (its target date is a missing input).
    expect(tones).toEqual([
      ['At risk · 0/3', 'warning'],
      ['Oct 25', 'default'],
      ['On track', 'default'],
      ['Nov 20', 'default'],
      ['No date', 'warning'],
    ]);
    const sub = card.querySelector('header [data-tone]');
    expect(sub?.textContent).toBe('No lead');
    expect(sub?.getAttribute('data-tone')).toBe('warning');
    const paused = container.querySelector('article[data-lane-id="p-paused"]');
    expect(paused?.querySelector('header [data-tone]')).toBeNull();
  });

  test('the legend shows the five status swatches in order', () => {
    const { container } = renderChart();
    expect(
      [
        ...container.querySelectorAll('[aria-label="Legend"] [data-status]'),
      ].map((el) => el.getAttribute('data-status'))
    ).toEqual(['overdue', 'at_risk', 'on_track', 'done', 'missing']);
  });
});
