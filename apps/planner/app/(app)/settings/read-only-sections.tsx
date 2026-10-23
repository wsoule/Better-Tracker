import { Chip, InitialsAvatar } from '@better-tracker/ui';

import type {
  PersonRow,
  ReadOnlySettingRow,
} from '../../../lib/adapters/settings';
import css from './page.module.css';
import { SettingBlock, SettingRow, SettingValue } from './setting-rows';

/* Settings for a Linear guest (owner decision 2026-10-22, "Guests limited
   to read only"): the same rows and headings as the forms, with every
   value as plain text and no Save, Reset, switches, boxes or inputs. The
   page puts the one read-only notice above them; PATCH /api/settings and
   the engine refuse a guest's save whatever is shown. */

/** Modes or Schedule as setting rows with their values, grouped under the
    form's headings where the rows carry one. */
export function ReadOnlySettings({
  label,
  rows,
}: {
  label: string;
  rows: ReadOnlySettingRow[];
}) {
  const groups: { title: string | undefined; rows: ReadOnlySettingRow[] }[] =
    [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last !== undefined && last.title === row.group) last.rows.push(row);
    else groups.push({ title: row.group, rows: [row] });
  }
  return (
    <div className={css.form} aria-label={label} role="group">
      {groups.map((group) => (
        <SettingBlock key={group.title ?? '-'} title={group.title}>
          {group.rows.map((row) => (
            <SettingRow
              key={row.id}
              title={row.label}
              help={row.sub}
              control={<SettingValue>{row.value}</SettingValue>}
            />
          ))}
        </SettingBlock>
      ))}
    </div>
  );
}

/** Watchers as Gr8r's member list: each person and whether they watch. */
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
      <ul className={css.people} aria-label="Watchers">
        {rows.map((row) => (
          <li
            key={row.id}
            className={css.person}
            data-inactive={row.active ? undefined : 'true'}
          >
            <PersonCell row={row} />
            <span className={css.personControl}>
              {watching.has(row.id) ? (
                <Chip>Watcher</Chip>
              ) : (
                <span className="srOnly">Not a watcher</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className={css.formHint}>{hint}</p>
    </div>
  );
}

/** A person's round initials, name (with "Deactivated in Linear" when
    so) and email: the left side of a Watchers row. */
export function PersonCell({ row }: { row: PersonRow }) {
  return (
    <>
      <InitialsAvatar name={row.name} size="md" />
      <span className={css.personText}>
        <span className={css.personName}>
          {row.name}
          {row.note !== null ? <Chip tone="muted">{row.note}</Chip> : null}
        </span>
        <span className={css.personMeta}>{row.email ?? 'No email'}</span>
      </span>
    </>
  );
}
