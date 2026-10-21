import { describe, expect, test } from 'bun:test';

import {
  describeItemKind,
  escapeAndTruncate,
  renderDigest,
  type SlackBlock,
} from '../src/render';
import { CONTEXT, makeDigest, makeItem } from './helpers';

// The mrkdwn text of every section block, in order.
function sectionTexts(blocks: SlackBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === 'section') out.push(block.text.text);
  }
  return out;
}

function headerText(blocks: SlackBlock[]): string {
  const first = blocks[0];
  if (first?.type !== 'header') throw new Error('first block is not a header');
  return first.text.text;
}

function lastContextText(blocks: SlackBlock[]): string | null {
  const last = blocks.at(-1);
  if (last?.type !== 'context') return null;
  const element = last.elements[0];
  return element === undefined ? null : element.text;
}

describe('renderDigest', () => {
  test('renders header, divider and one linked section per item', () => {
    const digest = makeDigest([
      makeItem({
        kind: 'overdue',
        daysLeft: -3,
        targetDate: '2026-10-18',
        lines: ['3 open issues unassigned', 'no state change in 9 days'],
        openCount: 5,
        unassignedCount: 3,
      }),
    ]);
    const { text, blocks } = renderDigest(digest, CONTEXT);

    expect(blocks).toEqual([
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Milestone Planner: 1 milestone needs attention',
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*<https://planner.example.com/timeline?milestone=ms-1|Orion › Beta>*',
            'Overdue by 3 days',
            '• 3 open issues unassigned',
            '• no state change in 9 days',
            'Due Oct 18, 2026 · 5 open · 3 unassigned',
          ].join('\n'),
        },
      },
    ]);
    expect(text).toBe(
      'Milestone Planner: 1 milestone needs attention\n• Orion › Beta — Overdue by 3 days'
    );
  });

  test('pluralizes the header count', () => {
    const digest = makeDigest([makeItem({ id: 'a' }), makeItem({ id: 'b' })]);
    expect(headerText(renderDigest(digest, CONTEXT).blocks)).toBe(
      'Milestone Planner: 2 milestones need attention'
    );
  });

  test('keeps digest.items order', () => {
    const digest = makeDigest([
      makeItem({
        id: 'z',
        milestoneName: 'Zeta',
        kind: 'overdue',
        daysLeft: -1,
      }),
      makeItem({ id: 'a', milestoneName: 'Alpha', kind: 'at_risk' }),
      makeItem({ id: 'm', milestoneName: 'Mu', kind: 'invalid_due_soon' }),
    ]);
    const { text, blocks } = renderDigest(digest, CONTEXT);
    const titles = sectionTexts(blocks).map((s) => s.split('\n')[0]);
    expect(titles).toEqual([
      '*<https://planner.example.com/timeline?milestone=z|Orion › Zeta>*',
      '*<https://planner.example.com/timeline?milestone=a|Orion › Alpha>*',
      '*<https://planner.example.com/timeline?milestone=m|Orion › Mu>*',
    ]);
    expect(text.split('\n').slice(1)).toEqual([
      '• Orion › Zeta — Overdue by 1 day',
      '• Orion › Alpha — Due in 2 days — at risk',
      '• Orion › Mu — Due in 2 days — fails the milestone rubric',
    ]);
  });

  test('a project-level item shows only the project and no due date', () => {
    const digest = makeDigest([
      makeItem({
        kind: 'allocation_blocked',
        milestoneName: null,
        targetDate: null,
        daysLeft: null,
        lines: ['project has no lead'],
        openCount: 2,
        unassignedCount: 2,
        url: 'https://planner.example.com/timeline?project=proj-1',
      }),
    ]);
    const [section] = sectionTexts(renderDigest(digest, CONTEXT).blocks);
    expect(section).toBe(
      [
        '*<https://planner.example.com/timeline?project=proj-1|Orion>*',
        'Allocation stopped',
        '• project has no lead',
        '2 open · 2 unassigned',
      ].join('\n')
    );
  });

  test('escapes &, < and > in names and lines, and strips | and > from labels', () => {
    const digest = makeDigest([
      makeItem({
        projectName: 'R&D <core>',
        milestoneName: 'A|B > C',
        lines: ['blocked by <ENG-1> & <ENG-2>', 'a | b > c'],
      }),
    ]);
    const { text, blocks } = renderDigest(digest, CONTEXT);
    const [section] = sectionTexts(blocks);
    const lines = section.split('\n');
    expect(lines[0]).toBe(
      '*<https://planner.example.com/timeline?milestone=ms-1|R&amp;D &lt;core › AB  C>*'
    );
    expect(lines[2]).toBe('• blocked by &lt;ENG-1&gt; &amp; &lt;ENG-2&gt;');
    expect(lines[3]).toBe('• a | b &gt; c');
    // The summary text is mrkdwn too, so it is escaped (labels unstripped).
    expect(text).toContain('• R&amp;D &lt;core&gt; › A|B &gt; C — ');
    // No raw control character survives outside the link syntax itself.
    const withoutLink = section
      .replace(/^\*<[^|]+\|/, '')
      .replace(/>\*\n/, '\n');
    expect(withoutLink).not.toMatch(/[<>]/);
  });

  test('link URLs cannot break out of the <url|label> syntax', () => {
    const digest = makeDigest([
      makeItem({ url: 'https://x.test/timeline?a=1&b=<2>|3 4' }),
    ]);
    const [section] = sectionTexts(renderDigest(digest, CONTEXT).blocks);
    expect(section.split('\n')[0]).toBe(
      '*<https://x.test/timeline?a=1&amp;b=%3C2%3E%7C3%204|Orion › Beta>*'
    );
  });

  test('the header is plain text and stays within 150 chars', () => {
    const digest = makeDigest([makeItem()]);
    const longName = `R&D ${'x'.repeat(400)}`;
    const { blocks, text } = renderDigest(digest, {
      ...CONTEXT,
      appName: longName,
    });
    const header = headerText(blocks);
    expect(header.length).toBeLessThanOrEqual(150);
    expect(header.startsWith('R&D xxx')).toBe(true);
    expect(header.endsWith('…: 1 milestone needs attention')).toBe(true);
    // The summary's first line is the same header, escaped and never cut.
    expect(text.split('\n')[0]).toBe(header.replace('&', '&amp;'));
  });

  test('escaping the app name in the summary text never cuts the count', () => {
    const digest = makeDigest([makeItem(), makeItem({ id: 'b' })]);
    const { blocks, text } = renderDigest(digest, {
      ...CONTEXT,
      appName: '&'.repeat(400),
    });
    const header = headerText(blocks);
    expect(header.length).toBeLessThanOrEqual(150);
    const firstLine = text.split('\n')[0];
    expect(firstLine.endsWith('…: 2 milestones need attention')).toBe(true);
    expect(firstLine).toBe(header.replaceAll('&', '&amp;'));
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  test('a malformed, very long target date cannot break the section limit', () => {
    const digest = makeDigest([
      makeItem({ targetDate: `<${'9'.repeat(5000)}` }),
    ]);
    const [section] = sectionTexts(renderDigest(digest, CONTEXT).blocks);
    expect(section.length).toBeLessThanOrEqual(3000);
    const last = section.split('\n').at(-1);
    expect(last).toMatch(/^Due &lt;9+… · 4 open · 3 unassigned$/);
    expect(last!.length).toBeLessThan(80);
  });

  test('an over-long appUrl leaves the overflow note unlinked, within limits', () => {
    const items = Array.from({ length: 49 }, (_, i) =>
      makeItem({ id: `m${i}` })
    );
    const { blocks } = renderDigest(makeDigest(items), {
      ...CONTEXT,
      appUrl: `https://planner.example.com/${'a'.repeat(4000)}`,
    });
    expect(lastContextText(blocks)).toBe(
      '…and 2 more — open the timeline: Timeline'
    );
  });

  test('an over-long or empty item URL leaves a bold, unlinked title', () => {
    for (const url of ['', `https://x.test/${'a'.repeat(2000)}`]) {
      const [section] = sectionTexts(
        renderDigest(makeDigest([makeItem({ url })]), CONTEXT).blocks
      );
      expect(section.split('\n')[0]).toBe('*Orion › Beta*');
      expect(section.length).toBeLessThanOrEqual(3000);
    }
  });

  test('describes every item kind', () => {
    const cases: [Parameters<typeof makeItem>[0], string][] = [
      [{ kind: 'overdue', daysLeft: -3 }, 'Overdue by 3 days'],
      [{ kind: 'overdue', daysLeft: -1 }, 'Overdue by 1 day'],
      [{ kind: 'overdue', daysLeft: null }, 'Overdue'],
      [{ kind: 'at_risk', daysLeft: 2 }, 'Due in 2 days — at risk'],
      [{ kind: 'at_risk', daysLeft: 1 }, 'Due in 1 day — at risk'],
      [{ kind: 'at_risk', daysLeft: 0 }, 'Due today — at risk'],
      [
        { kind: 'invalid_due_soon', daysLeft: 4 },
        'Due in 4 days — fails the milestone rubric',
      ],
      [
        { kind: 'invalid_due_soon', daysLeft: 0 },
        'Due today — fails the milestone rubric',
      ],
      [{ kind: 'allocation_blocked', daysLeft: null }, 'Allocation stopped'],
    ];
    for (const [overrides, expected] of cases) {
      const item = makeItem(overrides);
      expect(describeItemKind(item)).toBe(expected);
      const [section] = sectionTexts(
        renderDigest(makeDigest([item]), CONTEXT).blocks
      );
      expect(section.split('\n')[1]).toBe(expected);
    }
  });

  test('60 items fit in 50 blocks with an overflow context block', () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      makeItem({ id: `ms-${i}`, milestoneName: `Milestone ${i}` })
    );
    const { text, blocks } = renderDigest(makeDigest(items), CONTEXT);

    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.length).toBe(50);
    const sections = sectionTexts(blocks);
    expect(sections.length).toBe(47);
    expect(sections[0]).toContain('Milestone 0>');
    expect(sections[46]).toContain('Milestone 46>');
    expect(lastContextText(blocks)).toBe(
      '…and 13 more — open the timeline: <https://planner.example.com/timeline|Timeline>'
    );
    expect(headerText(blocks)).toBe(
      'Milestone Planner: 60 milestones need attention'
    );
    // The summary text lists every item (it is well under 4000 chars here).
    expect(text.split('\n').length).toBe(61);
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  test('48 items fill the message exactly without an overflow block', () => {
    const items = Array.from({ length: 48 }, (_, i) =>
      makeItem({ id: `m${i}` })
    );
    const { blocks } = renderDigest(makeDigest(items), CONTEXT);
    expect(blocks.length).toBe(50);
    expect(sectionTexts(blocks).length).toBe(48);
    expect(lastContextText(blocks)).toBeNull();
  });

  test('49 items overflow by two (one slot goes to the context block)', () => {
    const items = Array.from({ length: 49 }, (_, i) =>
      makeItem({ id: `m${i}` })
    );
    const { blocks } = renderDigest(makeDigest(items), CONTEXT);
    expect(blocks.length).toBe(50);
    expect(sectionTexts(blocks).length).toBe(47);
    expect(lastContextText(blocks)).toStartWith('…and 2 more');
  });

  test('a trailing slash on appUrl does not double up in the timeline link', () => {
    const items = Array.from({ length: 49 }, (_, i) =>
      makeItem({ id: `m${i}` })
    );
    const { blocks } = renderDigest(makeDigest(items), {
      ...CONTEXT,
      appUrl: 'https://planner.example.com/',
    });
    expect(lastContextText(blocks)).toContain(
      '<https://planner.example.com/timeline|Timeline>'
    );
  });

  test('very long titles and lines stay under 3000 chars per section', () => {
    const digest = makeDigest([
      makeItem({
        projectName: '&'.repeat(5000),
        milestoneName: '<'.repeat(5000),
        lines: Array.from({ length: 40 }, (_, i) => `${i} ${'&'.repeat(2000)}`),
      }),
    ]);
    const { blocks } = renderDigest(digest, CONTEXT);
    const [section] = sectionTexts(blocks);
    expect(section.length).toBeLessThanOrEqual(3000);
    const lines = section.split('\n');
    // Title is truncated with an ellipsis but keeps a complete link.
    expect(lines[0]).toMatch(/^\*<https:\/\/[^|]+\|(&amp;)+…>\*$/);
    expect(lines[1]).toBe('Due in 2 days — at risk');
    // Some bullets fit, then the rest are counted.
    expect(lines.at(-2)).toMatch(/^• …and \d+ more$/);
    expect(lines.at(-1)).toBe('Due Oct 23, 2026 · 4 open · 3 unassigned');
    // No entity is cut in half by the truncation.
    expect(section).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  test('top-level text stays under 4000 chars and counts the rest', () => {
    const items = Array.from({ length: 120 }, (_, i) =>
      makeItem({
        id: `ms-${i}`,
        projectName: `Project ${i} ${'p'.repeat(60)}`,
        milestoneName: `M ${i}`,
      })
    );
    const { text } = renderDigest(makeDigest(items), CONTEXT);
    expect(text.length).toBeLessThanOrEqual(4000);
    const lines = text.split('\n');
    const more = lines.at(-1)!;
    expect(more).toMatch(/^…and \d+ more$/);
    const listed = lines.length - 2; // minus header and the "more" line
    expect(listed + Number(/\d+/.exec(more)![0])).toBe(120);
    expect(lines[1]).toStartWith('• Project 0 ');
  });

  test('long labels in the top-level text are truncated per item', () => {
    const { text } = renderDigest(
      makeDigest([makeItem({ projectName: 'q'.repeat(1000) })]),
      CONTEXT
    );
    const line = text.split('\n')[1];
    expect(line).toBe(`• ${'q'.repeat(149)}… — Due in 2 days — at risk`);
  });

  test('newlines in user text do not add lines', () => {
    const { blocks } = renderDigest(
      makeDigest([
        makeItem({
          projectName: 'Orion\nNext',
          lines: ['first\nsecond', '   ', ''],
        }),
      ]),
      CONTEXT
    );
    const [section] = sectionTexts(blocks);
    expect(section.split('\n')).toEqual([
      '*<https://planner.example.com/timeline?milestone=ms-1|Orion Next › Beta>*',
      'Due in 2 days — at risk',
      '• first second',
      'Due Oct 23, 2026 · 4 open · 3 unassigned',
    ]);
  });

  test('is deterministic', () => {
    const items = Array.from({ length: 55 }, (_, i) =>
      makeItem({
        id: `ms-${i}`,
        kind: i % 2 === 0 ? 'overdue' : 'at_risk',
        daysLeft: i % 2 === 0 ? -i - 1 : 3,
      })
    );
    const digest = makeDigest(items);
    const first = renderDigest(digest, CONTEXT);
    const second = renderDigest(structuredClone(digest), { ...CONTEXT });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test('does not mutate its input', () => {
    const digest = makeDigest([makeItem({ lines: ['a\nb'] })]);
    const before = structuredClone(digest);
    renderDigest(digest, CONTEXT);
    expect(digest).toEqual(before);
  });
});

describe('escapeAndTruncate', () => {
  test('escapes without cutting when it fits', () => {
    expect(escapeAndTruncate('a & b < c > d', 100)).toBe(
      'a &amp; b &lt; c &gt; d'
    );
  });

  test('never cuts inside an entity or a surrogate pair', () => {
    expect(escapeAndTruncate('&&&&', 12)).toBe('&amp;&amp;…');
    expect(escapeAndTruncate('😀😀😀', 5)).toBe('😀😀…');
    expect(escapeAndTruncate('😀😀😀', 4)).toBe('😀…');
  });
});
