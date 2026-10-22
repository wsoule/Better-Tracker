'use client';

import { Checkbox } from '@better-tracker/ui';
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
import { PersonCell } from './read-only-sections';
import { useSaveSettings } from './use-save-settings';

/* Settings → Watchers, as Gr8r's member list: one row per active person
   (and anyone deactivated who is still a watcher) with round initials,
   name and email, and a Watcher box on the right. Watchers hear about
   every at-risk milestone besides its lead; they are not a role (owner
   decision 2026-10-22: everyone signed in edits everything). Anyone may
   change the list, and it may be emptied. */
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
      <ul className={css.people} aria-label="People">
        {rows.map((row) => (
          <li
            key={row.id}
            className={css.person}
            data-inactive={row.active ? undefined : 'true'}
          >
            <PersonCell row={row} />
            <span className={css.personControl}>
              <Checkbox
                label="Watcher"
                aria-label={`${row.name}: watcher`}
                checked={watchers.includes(row.id)}
                disabled={saving}
                onChange={(on) =>
                  setWatchers((ids) => toggleId(ids, row.id, on))
                }
              />
            </span>
          </li>
        ))}
      </ul>
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
