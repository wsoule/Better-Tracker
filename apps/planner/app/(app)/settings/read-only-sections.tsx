import { Register, RegisterCell, RegisterRow } from '@better-tracker/ui';

import type {
  PersonRow,
  ReadOnlySettingRow,
} from '../../../lib/adapters/settings';
import css from './page.module.css';

/* Settings for a Linear guest (owner decision 2026-10-22, "Guests limited
   to read only"): the same registers as the forms, with every value as
   plain text and no Save, Reset, switches, boxes or inputs. The page puts
   the one read-only notice above them; PATCH /api/settings and the engine
   refuse a guest's save whatever is shown. */

/** Modes or Schedule as a two-column register of setting and value. */
export function ReadOnlySettings({
  label,
  rows,
}: {
  label: string;
  rows: ReadOnlySettingRow[];
}) {
  return (
    <Register
      label={label}
      columns="minmax(0, 1fr) 220px"
      stackWithin={700}
      stackedColumns="minmax(0, 1fr)"
    >
      {rows.map((row) => (
        <RegisterRow key={row.id}>
          <RegisterCell variant="name" sub={row.sub}>
            {row.label}
          </RegisterCell>
          <RegisterCell align="end" variant="mono">
            {row.value}
          </RegisterCell>
        </RegisterRow>
      ))}
    </Register>
  );
}

/** Watchers as a register: each person and whether they watch. */
export function ReadOnlyWatchers({
  rows,
  watcherUserIds,
  hint,
}: {
  rows: PersonRow[];
  watcherUserIds: readonly string[];
  hint: string;
}) {
  const watching = new Set(watcherUserIds);
  return (
    <div className={css.form}>
      <Register
        label="Watchers"
        columns="minmax(0, 1.2fr) minmax(0, 1fr) 104px"
        header={[
          { id: 'person', label: 'Person' },
          { id: 'email', label: 'Email' },
          { id: 'watcher', label: 'Watcher' },
        ]}
        stackWithin={700}
        stackedColumns="minmax(0, 1fr) auto auto"
      >
        {rows.map((row) => (
          <RegisterRow key={row.id} tone={row.active ? 'default' : 'muted'}>
            <RegisterCell
              label="Person"
              variant="name"
              sub={row.note ?? undefined}
            >
              {row.name}
            </RegisterCell>
            <RegisterCell label="Email" tone="muted">
              {row.email ?? '—'}
            </RegisterCell>
            <RegisterCell
              label="Watcher"
              variant="mono"
              tone={watching.has(row.id) ? 'default' : 'muted'}
            >
              {watching.has(row.id) ? 'Watcher' : '—'}
            </RegisterCell>
          </RegisterRow>
        ))}
      </Register>
      <p className={css.formHint}>{hint}</p>
    </div>
  );
}
