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

  test('muted draws any status in greys but keeps its name', () => {
    const loud = render(<StatusMark status="overdue" label="Overdue" />);
    const loudMark = loud.container.querySelector('[role="img"]');
    expect(loudMark?.hasAttribute('data-muted')).toBe(false);
    const quiet = render(
      <StatusMark status="overdue" label="Overdue · inactive project" muted />
    );
    const mark = quiet.container.querySelector('[role="img"]');
    expect(mark?.hasAttribute('data-muted')).toBe(true);
    expect(mark?.getAttribute('aria-label')).toBe('Overdue · inactive project');
  });
});
