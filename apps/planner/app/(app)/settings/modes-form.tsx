'use client';

import {
  Notice,
  Register,
  RegisterCell,
  RegisterRow,
  Switch,
} from '@better-tracker/ui';
import { type FormEvent, useState } from 'react';

import {
  MODE_CONSEQUENCE,
  type ModesState,
  modesPatch,
  modesSavedMessage,
  WARNINGS_GO_LIVE_NOTE,
} from '../../../lib/adapters/settings';
import FormBar from './form-bar';
import css from './page.module.css';
import { useSaveSettings } from './use-save-settings';

/* Settings → Modes: the allocation (dry run / live) and warnings
   (preview / live) switches, each with the plain consequence of its
   current position. PMs save both together; everyone else sees the
   switches disabled. */
export default function ModesForm({
  initial,
  canEdit,
}: {
  initial: ModesState;
  canEdit: boolean;
}) {
  const [state, setState] = useState(initial);
  // A save (or another PM's) refreshes `initial`: follow it.
  const [synced, setSynced] = useState(initial);
  if (
    synced.allocationMode !== initial.allocationMode ||
    synced.warningsMode !== initial.warningsMode
  ) {
    setSynced(initial);
    setState(initial);
  }
  const { saving, save } = useSaveSettings('Modes');
  const dirty =
    state.allocationMode !== initial.allocationMode ||
    state.warningsMode !== initial.warningsMode;
  const goingLive =
    state.warningsMode === 'live' && initial.warningsMode === 'preview';
  const allocationGoingLive =
    state.allocationMode === 'live' && initial.allocationMode === 'dry_run';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || !canEdit) return;
    void save({ ...modesPatch(state) }, modesSavedMessage(state));
  }

  return (
    <form onSubmit={submit} className={css.form} aria-label="Modes">
      <Register
        label="Modes"
        columns="minmax(0, 1fr) auto"
        stackWithin={700}
        stackedColumns="minmax(0, 1fr)"
      >
        <RegisterRow>
          <RegisterCell
            variant="name"
            sub={MODE_CONSEQUENCE.allocation[state.allocationMode]}
          >
            Allocation
          </RegisterCell>
          <RegisterCell align="end">
            <Switch
              label="Live"
              note={state.allocationMode === 'live' ? undefined : 'dry run'}
              checked={state.allocationMode === 'live'}
              disabled={!canEdit || saving}
              onChange={(on) =>
                setState((s) => ({
                  ...s,
                  allocationMode: on ? 'live' : 'dry_run',
                }))
              }
            />
          </RegisterCell>
        </RegisterRow>
        <RegisterRow>
          <RegisterCell
            variant="name"
            sub={MODE_CONSEQUENCE.warnings[state.warningsMode]}
          >
            Warnings
          </RegisterCell>
          <RegisterCell align="end">
            <Switch
              label="Live"
              note={state.warningsMode === 'live' ? undefined : 'preview'}
              checked={state.warningsMode === 'live'}
              disabled={!canEdit || saving}
              onChange={(on) =>
                setState((s) => ({
                  ...s,
                  warningsMode: on ? 'live' : 'preview',
                }))
              }
            />
          </RegisterCell>
        </RegisterRow>
      </Register>
      {allocationGoingLive ? (
        <Notice label="Live allocation">
          After saving, the next daily run and every Run now write to Linear:
          assignee, Backlog → Todo, and a comment on each issue.
        </Notice>
      ) : null}
      {goingLive ? (
        <Notice label="Live warnings">{WARNINGS_GO_LIVE_NOTE}</Notice>
      ) : null}
      {canEdit ? (
        <FormBar
          dirty={dirty}
          saving={saving}
          onReset={() => setState(initial)}
        />
      ) : null}
    </form>
  );
}
