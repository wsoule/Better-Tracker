'use client';

import {
  Checkbox,
  Register,
  RegisterCell,
  RegisterRow,
} from '@better-tracker/ui';
import { type FormEvent, useState } from 'react';

import {
  type PersonRow,
  sameIds,
  toggleId,
  watchersHint,
  watchersSavedMessage,
} from '../../../lib/adapters/settings';
import FormBar from './form-bar';
import css from './page.module.css';
import { useSaveSettings } from './use-save-settings';

const COLUMNS = 'minmax(0, 1.2fr) minmax(0, 1fr) 104px';

const HEADER = [
  { id: 'person', label: 'Person' },
  { id: 'email', label: 'Email' },
  { id: 'watcher', label: 'Watcher' },
];

/* Settings → Watchers: one register row per active person (and anyone
   deactivated who is still a watcher), with a Watcher box each. Watchers
   hear about every at-risk milestone besides its lead; they are not a
   role (owner decision 2026-10-22: everyone signed in edits everything).
   Anyone may change the list, and it may be emptied. */
export default function WatchersForm({
  rows,
  watcherUserIds,
}: {
  rows: PersonRow[];
  watcherUserIds: string[];
}) {
  const [watchers, setWatchers] = useState(watcherUserIds);
  // Follow the server after a save (or someone else's change).
  const [synced, setSynced] = useState(watcherUserIds);
  if (!sameIds(synced, watcherUserIds)) {
    setSynced(watcherUserIds);
    setWatchers(watcherUserIds);
  }
  const { saving, outcome, statusRef, save, discarded } =
    useSaveSettings('Watchers');
  const dirty = !sameIds(watchers, watcherUserIds);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    void save(
      { watcherUserIds: watchers },
      watchersSavedMessage(watchers.length)
    );
  }

  return (
    <form onSubmit={submit} className={css.form} aria-label="Watchers">
      <Register
        label="Watchers"
        columns={COLUMNS}
        header={HEADER}
        stackWithin={700}
        stackedColumns="minmax(0, 1fr) auto auto"
      >
        {rows.map((row) => {
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
              <RegisterCell label="Watcher">
                <Checkbox
                  label="Watcher"
                  hideLabel
                  aria-label={`${row.name}: watcher`}
                  checked={watchers.includes(row.id)}
                  disabled={saving}
                  onChange={(on) =>
                    setWatchers((ids) => toggleId(ids, row.id, on))
                  }
                />
              </RegisterCell>
            </RegisterRow>
          );
        })}
      </Register>
      <p className={css.formHint}>{watchersHint(watchers.length)}</p>
      <FormBar
        dirty={dirty}
        saving={saving}
        outcome={outcome}
        statusRef={statusRef}
        onDiscarded={discarded}
        onReset={() => {
          setWatchers(watcherUserIds);
        }}
      />
    </form>
  );
}
