import { describe, expect, mock, test } from 'bun:test';

import { escapeResetsDraft } from '../lib/escape';

// The milestone drawer's Weight and "Done means…" fields: Esc with unsaved
// text resets the field and is marked handled, so the slide-over (which
// closes on any Esc not default-prevented) stays open.

function key(name: string) {
  return { key: name, preventDefault: mock(() => undefined) };
}

describe('escapeResetsDraft', () => {
  test('a dirty field: Esc restores the saved value and keeps the drawer', () => {
    const event = key('Escape');
    const reset = mock(() => undefined);
    escapeResetsDraft(event, true, reset);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  test('a clean field lets Esc through to close the drawer', () => {
    const event = key('Escape');
    const reset = mock(() => undefined);
    escapeResetsDraft(event, false, reset);
    expect(reset).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('other keys are untouched', () => {
    const event = key('a');
    const reset = mock(() => undefined);
    escapeResetsDraft(event, true, reset);
    expect(reset).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
