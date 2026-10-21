import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import StatusMark from '../src/components/status-mark';

describe('StatusMark', () => {
  test('exposes the label to assistive tech', () => {
    const { getByRole } = render(
      <StatusMark status="overdue" label="Overdue" />
    );
    expect(getByRole('img').getAttribute('aria-label')).toBe('Overdue');
  });

  test('renders the visible label only when asked', () => {
    const hidden = render(<StatusMark status="done" label="Complete" />);
    expect(hidden.queryByText('Complete')).toBeNull();
    hidden.unmount();
    const shown = render(
      <StatusMark status="done" label="Complete" showLabel />
    );
    expect(shown.getByText('Complete')).toBeTruthy();
  });
});
