import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  Chip,
  Notice,
  PriorityGlyph,
  ProgressRule,
  Register,
  RegisterCell,
  RegisterRow,
  StateGlyph,
  StatsStrip,
  TaskDetail,
  type SemanticTone,
  type UiTone,
} from '../src/index';
import AlertStrip from '../src/shell/alert-strip';

// Status colours on the shared atoms (owner decision 2026-10-22,
// docs/architecture.md §8.2). CSS modules resolve to empty objects under
// Bun, so the atoms are checked through the data-tone they emit, and the
// colours through their stylesheets: status is drawn with the status hues
// (--red, --amber, --green, --blue, --grey) or the data-tone hook (--tone,
// --tone-ink), never with the purple accent.

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

const SEMANTIC: SemanticTone[] = ['danger', 'warning', 'success', 'info'];

describe('StatusMark colours (status-mark.module.css)', () => {
  const sheet = css('components/status-mark.module.css');

  test('each status takes its hue, in its own shape', () => {
    // Done stays the filled ink square: a green fill has the red fill's
    // lightness, so without red-green vision done and overdue would match.
    expect(rule(sheet, '.done')).toBe('background: var(--foreground);');
    expect(rule(sheet, '.on_track')).toContain('background: transparent');
    expect(rule(sheet, '.on_track')).toContain('border-color: var(--green)');
    expect(rule(sheet, '.at_risk')).toContain('border: 2px solid var(--amber)');
    expect(rule(sheet, '.overdue')).toContain('background: var(--red)');
    expect(rule(sheet, '.missing')).toContain('repeating-linear-gradient');
    expect(rule(sheet, '.muted')).toContain('border-color: var(--grey)');
  });

  test('the accent never draws a status', () => {
    expect(sheet).not.toContain('--accent');
  });
});

describe('Chip', () => {
  test('a status tone is emitted as data-tone and drawn in --tone-ink', () => {
    for (const tone of SEMANTIC) {
      const view = render(<Chip tone={tone}>{tone}</Chip>);
      expect(view.container.firstElementChild?.getAttribute('data-tone')).toBe(
        tone
      );
      view.unmount();
    }
    const sheet = css('tasks/chip.module.css');
    expect(rule(sheet, '.status')).toBe(
      'border-color: var(--tone-ink); color: var(--tone-ink);'
    );
  });

  test('filled keeps a status chip a slab: the hue with its own text', () => {
    for (const tone of SEMANTIC) {
      const view = render(
        <Chip tone={tone} filled>
          {tone}
        </Chip>
      );
      const chip = view.container.firstElementChild;
      expect(chip?.getAttribute('data-tone')).toBe(tone);
      expect(chip?.hasAttribute('data-filled')).toBe(true);
      view.unmount();
    }
    // Not a status tone, or not asked: filled changes nothing.
    const plain = render(<Chip filled>Nothing to do</Chip>);
    expect(plain.container.firstElementChild?.hasAttribute('data-filled')).toBe(
      false
    );
    plain.unmount();
    const outline = render(<Chip tone="danger">Failed</Chip>);
    expect(
      outline.container.firstElementChild?.hasAttribute('data-filled')
    ).toBe(false);
    outline.unmount();
    const sheet = css('tasks/chip.module.css');
    expect(rule(sheet, '.statusFilled')).toBe(
      'border-color: var(--tone); background: var(--tone); color: var(--on-tone);'
    );
  });

  test('on the accent fill a status mark turns white', () => {
    const sheet = css('tasks/chip.module.css');
    const body = rule(sheet, '.accent .mark');
    for (const hue of ['--red', '--amber', '--green', '--grey']) {
      expect(body).toContain(`${hue}: var(--on-accent)`);
    }
  });
});

describe('Notice', () => {
  test('defaults to the accent frame; a status tone is emitted', () => {
    const plain = render(<Notice label="Demo data">Fictional.</Notice>);
    expect(plain.container.firstElementChild?.getAttribute('data-tone')).toBe(
      'accent'
    );
    plain.unmount();
    const failed = render(
      <Notice label="Failed" tone="danger" role="alert">
        Linear refused the write.
      </Notice>
    );
    expect(failed.getByRole('alert').getAttribute('data-tone')).toBe('danger');
  });

  test('a status notice draws its frame and key from the tone hook', () => {
    const sheet = css('tasks/notice.module.css');
    expect(rule(sheet, ':global(.notice).toned')).toBe(
      'border-color: var(--tone);'
    );
    expect(rule(sheet, '.key.toneKey')).toBe('color: var(--tone-ink);');
  });
});

describe('AlertStrip', () => {
  test('defaults to the accent and takes a status tone', () => {
    const plain = render(<AlertStrip label="Note">Hello.</AlertStrip>);
    expect(plain.container.firstElementChild?.getAttribute('data-tone')).toBe(
      'accent'
    );
    plain.unmount();
    const overdue = render(
      <AlertStrip label="Overdue" tone="danger">
        Overdue by 3 days.
      </AlertStrip>
    );
    expect(overdue.container.firstElementChild?.getAttribute('data-tone')).toBe(
      'danger'
    );
  });

  test('frame and key come from the hook; the follow-up link stays purple', () => {
    const sheet = css('shell/alert-strip.module.css');
    expect(rule(sheet, '.strip')).toContain('border: 2px solid var(--tone)');
    expect(rule(sheet, '.key')).toContain('color: var(--tone-ink)');
    expect(rule(sheet, '.action')).toContain('color: var(--accent-ink)');
  });

  test('TaskDetail passes an alert tone through', () => {
    const view = render(
      <TaskDetail
        taskKey="ENG-12"
        title="Dual-write invoices"
        status={{ kind: 'started', label: 'In Progress' }}
        properties={[]}
        alerts={[
          { label: 'Overdue', tone: 'danger', message: 'Overdue by 3 days.' },
          { label: 'Stalled', tone: 'warning', message: 'In Todo for 9 days.' },
          { label: 'Note', message: 'Default tone.' },
        ]}
      />
    );
    const strips = [...view.container.querySelectorAll('[data-tone]')].filter(
      (el) => /Overdue|Stalled|Note/.test(el.textContent ?? '')
    );
    expect(strips.map((el) => el.getAttribute('data-tone'))).toEqual([
      'danger',
      'warning',
      'accent',
    ]);
  });
});

describe('ProgressRule', () => {
  test('any tone but default paints the fill and receipt from the hook', () => {
    for (const tone of [...SEMANTIC, 'muted', 'accent'] as UiTone[]) {
      const view = render(<ProgressRule done={1} total={2} tone={tone} />);
      expect(view.container.firstElementChild?.getAttribute('data-tone')).toBe(
        tone
      );
      view.unmount();
    }
    const sheet = css('tasks/progress-rule.module.css');
    expect(rule(sheet, '.fill')).toContain('background: var(--foreground)');
    expect(rule(sheet, '.toned .fill')).toBe('background: var(--tone);');
    expect(rule(sheet, '.toned .label')).toBe('color: var(--tone-ink);');
  });
});

describe('Register', () => {
  test('rows and cells emit their status tone', () => {
    const view = render(
      <Register label="Projects" columns="1fr 1fr">
        <RegisterRow tone="warning">
          <RegisterCell variant="name">Delta exports</RegisterCell>
          <RegisterCell variant="mono" tone="warning">
            Blocked
          </RegisterCell>
        </RegisterRow>
        <RegisterRow tone="danger">
          <RegisterCell variant="name">Run 12</RegisterCell>
          <RegisterCell variant="mono" tone="danger">
            Failed
          </RegisterCell>
        </RegisterRow>
      </Register>
    );
    const rows = view.getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-tone'))).toEqual([
      'warning',
      'danger',
    ]);
    expect(
      view.getByText('Blocked').parentElement?.getAttribute('data-tone')
    ).toBe('warning');
  });

  test('the left rule and the toned text come from the hook', () => {
    const sheet = css('tasks/register.module.css');
    expect(rule(sheet, '.rowRule')).toContain(
      'border-left: 2px solid var(--tone)'
    );
    expect(rule(sheet, '.toneText .cellValue, .toneText .cellSub')).toBe(
      'color: var(--tone-ink);'
    );
  });
});

describe('StatsStrip', () => {
  test('a status count is coloured by its tone', () => {
    const view = render(
      <StatsStrip
        cells={[
          { id: 'o', label: 'Overdue milestones', value: 1, tone: 'danger' },
          { id: 'r', label: 'At risk', value: 2, tone: 'warning' },
          { id: 'n', label: 'New to you', value: 3, tone: 'accent' },
        ]}
      />
    );
    expect(
      view.getAllByRole('listitem').map((c) => c.getAttribute('data-tone'))
    ).toEqual(['danger', 'warning', 'accent']);
    const sheet = css('tasks/stats-strip.module.css');
    for (const tone of ['accent', ...SEMANTIC]) {
      expect(sheet).toContain(`.${tone} .value`);
    }
    expect(sheet).toContain('.info .note { color: var(--tone-ink); }');
  });
});

describe('Glyphs', () => {
  test('urgent is red, in progress blue, done green', () => {
    const sheet = css('tasks/task-glyphs.module.css');
    expect(rule(sheet, '.urgent')).toBe('color: var(--red);');
    expect(rule(sheet, '.started')).toBe('color: var(--blue);');
    expect(rule(sheet, '.completed')).toBe('color: var(--green);');
    expect(sheet).not.toContain('--accent');
    // Still decorative: the state and priority names say it.
    const view = render(
      <>
        <PriorityGlyph priority={1} />
        <StateGlyph kind="started" />
      </>
    );
    for (const svg of view.container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('Button', () => {
  test('danger is red at rest, on hover and when pressed, never purple', () => {
    const sheet = css('tasks/button.module.css');
    expect(rule(sheet, '.danger')).toBe(
      'border-color: var(--red); color: var(--red-ink);'
    );
    expect(rule(sheet, '.danger:not(:disabled):hover')).toContain(
      'background: var(--red)'
    );
    expect(rule(sheet, '.danger:not(:disabled):active')).toContain(
      'color: var(--on-red)'
    );
  });
});

describe('Checklist (the rubric)', () => {
  test('met is a filled green square, missing a hollow amber one', () => {
    const sheet = css('tasks/checklist.module.css');
    expect(rule(sheet, '.met .mark')).toContain('background: var(--green)');
    expect(rule(sheet, '.missing .mark')).toBe('border-color: var(--amber);');
    expect(rule(sheet, '.missing .state')).toBe('color: var(--amber-ink);');
    expect(sheet).not.toContain('--accent');
  });
});

describe('Errors are red (a failed write or load)', () => {
  test('every error key and the error toast use the red hue', () => {
    const cases: [string, string, string][] = [
      ['edit/save-status.module.css', '.key', '--red-ink'],
      ['edit/picker-popover.module.css', '.errorKey', '--red-ink'],
      ['task/task-comment-list.module.css', '.errorKey', '--red-ink'],
      ['task/task-description.module.css', '.errorKey', '--red-ink'],
      ['task/task-relation-list.module.css', '.removeErrorKey', '--red-ink'],
      ['shell/command-palette.module.css', '.groupError', '--red-ink'],
      ['shell/toast.module.css', '.error', '--red'],
      ['shell/toast.module.css', '.error .label', '--red-ink'],
      ['shell/toast.module.css', '.error .timer', '--red'],
    ];
    for (const [file, selector, token] of cases) {
      expect([file, selector, rule(css(file), selector)]).toEqual([
        file,
        selector,
        expect.stringContaining(`var(${token})`),
      ]);
    }
  });

  test('a toned picker placeholder takes the tone hook', () => {
    expect(
      rule(css('edit/picker-popover.module.css'), '.placeholder.toned')
    ).toBe('color: var(--tone-ink);');
  });
});
