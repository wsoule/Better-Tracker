import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';

import { BulkBar, type BulkBarConfirm } from '../src/index';

afterEach(cleanup);

// BulkBar: the inverted toolbar of a list selection. The count is a live
// region; a confirmation replaces the actions and takes focus; busy and a
// note disable the actions; Esc clears.

function actions() {
  return (
    <>
      <button type="button">Move to milestone</button>
      <button type="button">Assignee</button>
    </>
  );
}

describe('BulkBar', () => {
  test('renders nothing without a selection', () => {
    const view = render(
      <BulkBar count={0} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    expect(view.container.innerHTML).toBe('');
  });

  test('a named toolbar with the count in a polite live region', () => {
    const view = render(
      <BulkBar count={3} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    const bar = view.getByRole('toolbar', {
      name: 'Actions for 3 selected issues',
    });
    const status = view.getByRole('status');
    expect(status.textContent).toBe('3 selected');
    expect(bar.contains(status)).toBe(true);
    view.rerender(
      <BulkBar
        count={1}
        countLabel="1 issue selected"
        onClear={() => undefined}
      >
        {actions()}
      </BulkBar>
    );
    expect(view.getByRole('status').textContent).toBe('1 issue selected');
    expect(
      view.getByRole('toolbar', { name: 'Actions for 1 selected issue' })
    ).toBeTruthy();
  });

  test('the confirm strip takes focus; Cancel brings the actions back', () => {
    function Host() {
      const [confirm, setConfirm] = useState<BulkBarConfirm | null>(null);
      return (
        <BulkBar count={24} onClear={() => undefined} confirm={confirm}>
          <button
            type="button"
            onClick={() =>
              setConfirm({
                message:
                  'Move 24 issues to Garnet mobile app › Push notifications? This changes them in Linear, as you.',
                confirmLabel: 'Move 24 issues',
                onConfirm: () => undefined,
                onCancel: () => setConfirm(null),
              })
            }
          >
            Move to milestone
          </button>
        </BulkBar>
      );
    }
    const view = render(<Host />);
    const move = view.getByRole('button', { name: 'Move to milestone' });
    move.focus();
    fireEvent.click(move);
    const primary = view.getByRole('button', { name: 'Move 24 issues' });
    expect(document.activeElement).toBe(primary);
    expect(
      view.queryByRole('button', { name: 'Move to milestone' })
    ).toBeNull();
    expect(view.getByRole('toolbar').textContent).toContain(
      'This changes them in Linear, as you.'
    );
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    const back = view.getByRole('button', { name: 'Move to milestone' });
    expect(document.activeElement).toBe(back);
  });

  test('Esc during a confirmation cancels it rather than clearing', () => {
    const onClear = mock(() => {});
    const onCancel = mock(() => {});
    const view = render(
      <BulkBar
        count={20}
        onClear={onClear}
        confirm={{
          message: 'Set 20 issues to High priority?',
          confirmLabel: 'Set 20 issues',
          onConfirm: () => undefined,
          onCancel,
        }}
      >
        {actions()}
      </BulkBar>
    );
    fireEvent.keyDown(view.getByRole('button', { name: 'Set 20 issues' }), {
      key: 'Escape',
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });

  test('busy says so in the count’s place and disables the actions', () => {
    const view = render(
      <BulkBar count={12} busy="Moving 12 issues…" onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    expect(view.getByRole('status').textContent).toBe('Moving 12 issues…');
    const move = view.getByRole('button', { name: 'Move to milestone' });
    // A disabled fieldset disables every control in it (browsers do;
    // happy-dom does not compute it, so the fieldset is what is checked).
    expect(move.closest('fieldset')?.disabled).toBe(true);
    // Clearing stays possible.
    expect(
      (
        view.getByRole('button', {
          name: 'Clear selection',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  test('a note is shown and disables the actions', () => {
    const view = render(
      <BulkBar
        count={312}
        note="At most 100 at a time (312 selected)."
        onClear={() => undefined}
      >
        {actions()}
      </BulkBar>
    );
    expect(view.getByRole('toolbar').textContent).toContain(
      'At most 100 at a time (312 selected).'
    );
    expect(
      view.getByRole('button', { name: 'Assignee' }).closest('fieldset')
        ?.disabled
    ).toBe(true);
  });

  test('Esc clears the selection; ✕ does too; ← → move between buttons', () => {
    const onClear = mock(() => {});
    const view = render(
      <BulkBar count={2} onClear={onClear}>
        {actions()}
      </BulkBar>
    );
    const move = view.getByRole('button', { name: 'Move to milestone' });
    move.focus();
    fireEvent.keyDown(move, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Assignee' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(move);
    fireEvent.keyDown(move, { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  test('an Esc a picker inside already handled is left alone', () => {
    const onClear = mock(() => {});
    const view = render(
      <BulkBar count={2} onClear={onClear}>
        <span data-picker-popup="">
          <input aria-label="Search people" />
        </span>
      </BulkBar>
    );
    const field = view.getByRole('textbox', { name: 'Search people' });
    act(() => field.focus());
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onClear).not.toHaveBeenCalled();
  });
});

describe('BulkBar and the toasts', () => {
  test('while up it is marked for the toasts and publishes its height', () => {
    const root = document.documentElement;
    const view = render(
      <BulkBar count={2} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    const bar = view.getByRole('toolbar');
    expect(bar.getAttribute('data-bulk-bar')).toBe('true');
    // happy-dom lays nothing out: the measured height is 0px, but set.
    expect(root.style.getPropertyValue('--bulk-bar-h')).toBe('0px');
    view.rerender(
      <BulkBar count={0} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    expect(root.style.getPropertyValue('--bulk-bar-h')).toBe('');
  });

  test('the toast stack sits above a bulk bar, on desktop and on phones', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'shell', 'toast.module.css'),
      'utf8'
    );
    expect(css).toContain(
      ":global(body:has([data-bulk-bar='true'])) .viewport {\n  bottom: calc(24px + var(--bulk-bar-h, 44px) + 12px);"
    );
    expect(css).toMatch(
      /:global\(body:has\(\[data-shell-tabbar='true'\]\):has\(\[data-bulk-bar='true'\]\)\)/
    );
  });
});
