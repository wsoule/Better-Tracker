import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import AlertStrip from '../src/shell/alert-strip';

afterEach(cleanup);

// The AlertStrip is Gr8r's tinted alert: its colour comes from data-tone
// (docs/architecture.md §8.2), so these pin the tone hook and the words,
// not a stylesheet.
describe('AlertStrip', () => {
  test('defaults to the warning tone with a sentence-case lead-in', () => {
    const { container } = render(
      <AlertStrip label="Unassigned">Nobody has this issue.</AlertStrip>
    );
    const strip = container.firstElementChild;
    expect(strip?.getAttribute('data-tone')).toBe('warning');
    expect(strip?.textContent).toBe('UnassignedNobody has this issue.');
  });

  test('renders the tone it is given', () => {
    const { container } = render(
      <AlertStrip label="Overdue" tone="danger">
        Overdue by 3 days.
      </AlertStrip>
    );
    expect(container.firstElementChild?.getAttribute('data-tone')).toBe(
      'danger'
    );
  });

  test('the follow-up is a button in place, a link when it goes somewhere', () => {
    const onClick = mock(() => undefined);
    render(
      <>
        <AlertStrip
          label="Overdue"
          tone="danger"
          action={{ label: 'Reschedule', onClick }}
        >
          Overdue by 3 days.
        </AlertStrip>
        <AlertStrip label="Blocked" action={{ label: 'Graph', href: '/graph' }}>
          Two open blockers.
        </AlertStrip>
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('link', { name: 'Graph' }).getAttribute('href')
    ).toBe('/graph');
  });
});
