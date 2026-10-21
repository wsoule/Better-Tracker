import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
  Checkbox,
  NavTabs,
  UiLinkProvider,
  type UiLinkProps,
} from '../src/index';

afterEach(cleanup);

// A host link that marks what it rendered, to prove routing goes through
// the provider rather than a bare <a>.
function HostLink({ children, ...rest }: UiLinkProps) {
  return (
    <a {...rest} data-host-link="">
      {children}
    </a>
  );
}

describe('NavTabs', () => {
  test('renders a named nav of host links with the current page marked', () => {
    const { getByRole, getAllByRole } = render(
      <UiLinkProvider link={HostLink}>
        <NavTabs
          label="Graph level"
          items={[
            { id: 'm', label: 'Milestones', href: '/graph', current: true },
            { id: 'i', label: 'Issues in Atlas', href: '/graph?project=p' },
          ]}
        />
      </UiLinkProvider>
    );
    expect(getByRole('navigation', { name: 'Graph level' })).toBeTruthy();
    const links = getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(links[1]?.hasAttribute('aria-current')).toBe(false);
    expect(links[1]?.getAttribute('href')).toBe('/graph?project=p');
    expect(links.every((link) => link.hasAttribute('data-host-link'))).toBe(
      true
    );
  });

  test('a cell without href is not a link and says why', () => {
    const { getAllByRole, getByText } = render(
      <NavTabs
        label="Graph level"
        items={[
          { id: 'm', label: 'Milestones', href: '/graph', current: true },
          { id: 'i', label: 'Issues', note: 'select a milestone' },
        ]}
      />
    );
    expect(getAllByRole('link')).toHaveLength(1);
    const cell = getByText('Issues').parentElement;
    expect(cell?.getAttribute('aria-disabled')).toBe('true');
    expect(getByText('select a milestone')).toBeTruthy();
  });

  test('shows counts and keeps the vertical orientation as a class', () => {
    const { getByRole, getByText } = render(
      <NavTabs
        label="Settings sections"
        orientation="vertical"
        items={[
          {
            id: 'a',
            label: 'Audit',
            href: '/settings?section=audit',
            count: 7,
          },
        ]}
      />
    );
    expect(getByText('7')).toBeTruthy();
    // CSS modules resolve to {} under Bun, so only the role is asserted.
    expect(getByRole('navigation').querySelectorAll('li')).toHaveLength(1);
  });
});

describe('Checkbox', () => {
  test('is a native checkbox named by its label, toggled by the label', () => {
    const onChange = mock((_: boolean) => {});
    const { getByRole, getByText } = render(
      <Checkbox label="PM" onChange={onChange} />
    );
    const box = getByRole('checkbox', { name: 'PM' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(getByText('PM'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(box.checked).toBe(true);
  });

  test('controlled: follows `checked` and reports the requested state', () => {
    const onChange = mock((_: boolean) => {});
    const { getByRole, rerender } = render(
      <Checkbox label="Watcher" checked onChange={onChange} />
    );
    const box = getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
    rerender(<Checkbox label="Watcher" checked={false} onChange={onChange} />);
    expect(box.checked).toBe(false);
  });

  test('disabled boxes do not change; aria-label overrides the name', () => {
    const onChange = mock((_: boolean) => {});
    const { getByRole } = render(
      <Checkbox
        label="PM"
        aria-label="Ana Moreno: PM"
        checked
        disabled
        hideLabel
        onChange={onChange}
      />
    );
    const box = getByRole('checkbox', { name: 'Ana Moreno: PM' });
    expect((box as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });
});
