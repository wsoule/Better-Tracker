'use client';

import {
  Checkbox,
  Register,
  RegisterCell,
  RegisterRow,
} from '@better-tracker/ui';
import { type FormEvent, useState } from 'react';

import {
  lockedPmIds,
  type PersonRow,
  peopleSavedMessage,
  sameIds,
  toggleId,
} from '../../../lib/adapters/settings';
import { plural } from '../../../lib/format';
import FormBar from './form-bar';
import css from './page.module.css';
import { useSaveSettings } from './use-save-settings';

const COLUMNS = 'minmax(0, 1.2fr) minmax(0, 1fr) 88px 104px';

const HEADER = [
  { id: 'person', label: 'Person' },
  { id: 'email', label: 'Email' },
  { id: 'pm', label: 'PM' },
  { id: 'watcher', label: 'Watcher' },
];

/* Settings → People: one register row per active person (and anyone
   deactivated who is still on a list), with a PM and a Watcher box each.
   The last active PM's box is locked on (the engine refuses a lockout
   too). PMs save both lists together. */
export default function PeopleForm({
  rows,
  pmUserIds,
  watcherUserIds,
  canEdit,
}: {
  rows: PersonRow[];
  pmUserIds: string[];
  watcherUserIds: string[];
  canEdit: boolean;
}) {
  const [pms, setPms] = useState(pmUserIds);
  const [watchers, setWatchers] = useState(watcherUserIds);
  // Follow the server after a save (or another PM's change).
  const [synced, setSynced] = useState({ pmUserIds, watcherUserIds });
  if (
    !sameIds(synced.pmUserIds, pmUserIds) ||
    !sameIds(synced.watcherUserIds, watcherUserIds)
  ) {
    setSynced({ pmUserIds, watcherUserIds });
    setPms(pmUserIds);
    setWatchers(watcherUserIds);
  }
  const { saving, outcome, statusRef, save, discarded } =
    useSaveSettings('People');
  const locked = lockedPmIds(pms, rows);
  const dirty = !sameIds(pms, pmUserIds) || !sameIds(watchers, watcherUserIds);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || !canEdit) return;
    void save(
      { pmUserIds: pms, watcherUserIds: watchers },
      peopleSavedMessage(pms.length, watchers.length)
    );
  }

  return (
    <form onSubmit={submit} className={css.form} aria-label="People">
      <Register
        label="People"
        columns={COLUMNS}
        header={HEADER}
        stackWithin={700}
        stackedColumns="minmax(0, 1fr) auto auto"
      >
        {rows.map((row) => {
          const isPm = pms.includes(row.id);
          const isLocked = locked.has(row.id);
          return (
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
              <RegisterCell label="PM">
                <Checkbox
                  label="PM"
                  hideLabel
                  aria-label={`${row.name}: PM`}
                  checked={isPm}
                  disabled={!canEdit || saving || (isPm && isLocked)}
                  onChange={(on) => setPms((ids) => toggleId(ids, row.id, on))}
                />
              </RegisterCell>
              <RegisterCell label="Watcher">
                <Checkbox
                  label="Watcher"
                  hideLabel
                  aria-label={`${row.name}: watcher`}
                  checked={watchers.includes(row.id)}
                  disabled={!canEdit || saving}
                  onChange={(on) =>
                    setWatchers((ids) => toggleId(ids, row.id, on))
                  }
                />
              </RegisterCell>
            </RegisterRow>
          );
        })}
      </Register>
      <p className={css.formHint}>
        {plural(pms.length, 'PM')} may edit dates, leads, weights, “done means…”
        and these settings. {plural(watchers.length, 'watcher')} hear about
        every milestone at risk, besides each project’s lead.
        {locked.size > 0
          ? ' The last active PM cannot be unchecked: someone must be able to change settings.'
          : ''}
      </p>
      {canEdit ? (
        <FormBar
          dirty={dirty}
          saving={saving}
          outcome={outcome}
          statusRef={statusRef}
          onDiscarded={discarded}
          onReset={() => {
            setPms(pmUserIds);
            setWatchers(watcherUserIds);
          }}
        />
      ) : null}
    </form>
  );
}
