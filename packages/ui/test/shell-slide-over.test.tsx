import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { useState } from 'react';

import AlertStrip from '../src/shell/alert-strip';
import PropertyList from '../src/shell/property-list';
import SlideOver from '../src/shell/slide-over';

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open M3 cutover
      </button>
      <SlideOver
        open={open}
        onClose={() => setOpen(false)}
        title="M3 cutover"
        breadcrumb="Atlas / M3"
        actions={
          <button type="button" aria-label="Copy link">
            Copy
          </button>
        }
      >
        <AlertStrip
          label="Overdue"
          action={{ label: 'Reschedule', onClick: () => undefined }}
        >
          Overdue by 3 days.
        </AlertStrip>
        <PropertyList
          label="Milestone details"
          items={[
            { label: 'Status', value: 'Overdue' },
            { label: 'Due date', value: 'Oct 18' },
          ]}
        />
      </SlideOver>
    </>
  );
}

describe('SlideOver', () => {
  test('is a labelled dialog that takes focus when opened', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open M3 cutover' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'M3 cutover' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Desktop: the page beside it stays usable, so it is not aria-modal.
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(screen.getByText('Overdue by 3 days.')).toBeTruthy();
    expect(screen.getByText('Due date').tagName).toBe('DT');
  });

  test('Esc closes it and focus returns to the opener', () => {
    jest.useFakeTimers();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open M3 cutover' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });
    // Hidden from assistive tech while the exit slide plays…
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    // …and unmounted after it.
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(screen.queryByText('M3 cutover')).toBeNull();
  });

  test('the close button closes it too', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open M3 cutover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('Tab wraps inside the panel', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open M3 cutover' }));
    const dialog = screen.getByRole('dialog');
    const copy = screen.getByRole('button', { name: 'Copy link' });
    const reschedule = screen.getByRole('button', { name: 'Reschedule' });
    reschedule.focus();
    fireEvent.keyDown(reschedule, { key: 'Tab' });
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(reschedule);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
