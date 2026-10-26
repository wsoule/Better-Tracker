'use client';

import { Notice, Switch } from '@better-tracker/ui';
import { type FormEvent, useState } from 'react';

import {
  API_KEY_ALLOCATION_CONSEQUENCE,
  API_KEY_DIGESTS_OFF,
  MODE_CONSEQUENCE,
  type ModesState,
  modesPatch,
  modesSavedMessage,
  WARNINGS_GO_LIVE_NOTE,
  warningsConsequence,
} from '../../../lib/adapters/settings';
import FormBar from './form-bar';
import css from './page.module.css';
import { SettingBlock, SettingRow, SettingValue } from './setting-rows';
import { useSaveSettings } from './use-save-settings';

/* Settings → Modes: the allocation (dry run / live) and warnings
   (preview / live) switches as two Gr8r setting rows, each with the plain
   consequence of its current position, saved together; each switch is
   named by its row ("Allocation live"), not just its visible "Live".
   Turning either live shows an amber note on what the save will start.
   Anyone signed in may switch either
   one (owner decision 2026-10-22: no roles), including allocation going
   live; the engine records the switch in the audit log. With personal
   API keys (`apiKeyMode`) no digest is ever sent, so warnings is a plain
   "off" row, and allocation only ever runs when someone starts it. Live
   warnings say "Slack DM" only with `slack` (a Slack channel is active
   now), otherwise that digests stay in the planner's outbox. */
export default function ModesForm({
  initial,
  apiKeyMode = false,
  slack = false,
}: {
  initial: ModesState;
  apiKeyMode?: boolean;
  slack?: boolean;
}) {
  const [state, setState] = useState(initial);
  // A save (or someone else's) refreshes `initial`: follow it.
  const [synced, setSynced] = useState(initial);
  if (
    synced.allocationMode !== initial.allocationMode ||
    synced.warningsMode !== initial.warningsMode
  ) {
    setSynced(initial);
    setState(initial);
  }
  const { saving, outcome, statusRef, save, discarded } =
    useSaveSettings('Modes');
  const dirty =
    state.allocationMode !== initial.allocationMode ||
    state.warningsMode !== initial.warningsMode;
  const goingLive =
    state.warningsMode === 'live' && initial.warningsMode === 'preview';
  const allocationGoingLive =
    state.allocationMode === 'live' && initial.allocationMode === 'dry_run';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    void save({ ...modesPatch(state) }, modesSavedMessage(state));
  }

  return (
    <form onSubmit={submit} className={css.form} aria-label="Modes">
      <SettingBlock>
        <SettingRow
          title="Allocation"
          help={
            apiKeyMode
              ? API_KEY_ALLOCATION_CONSEQUENCE[state.allocationMode]
              : MODE_CONSEQUENCE.allocation[state.allocationMode]
          }
          control={
            <Switch
              label="Live"
              aria-label="Allocation live"
              note={state.allocationMode === 'live' ? undefined : 'dry run'}
              checked={state.allocationMode === 'live'}
              disabled={saving}
              onChange={(on) =>
                setState((s) => ({
                  ...s,
                  allocationMode: on ? 'live' : 'dry_run',
                }))
              }
            />
          }
        />
        {apiKeyMode ? (
          <SettingRow
            title="Warnings"
            help={API_KEY_DIGESTS_OFF}
            control={<SettingValue tone="muted">Off</SettingValue>}
          />
        ) : (
          <SettingRow
            title="Warnings"
            help={warningsConsequence(state.warningsMode, slack)}
            control={
              <Switch
                label="Live"
                aria-label="Warnings live"
                note={state.warningsMode === 'live' ? undefined : 'preview'}
                checked={state.warningsMode === 'live'}
                disabled={saving}
                onChange={(on) =>
                  setState((s) => ({
                    ...s,
                    warningsMode: on ? 'live' : 'preview',
                  }))
                }
              />
            }
          />
        )}
      </SettingBlock>
      {allocationGoingLive ? (
        <Notice label="Live allocation" tone="warning">
          {apiKeyMode
            ? 'After saving, every Run now writes to Linear with the key of whoever starts it: assignee, Backlog → Todo, and a comment on each issue.'
            : 'After saving, the next daily run and every Run now write to Linear: assignee, Backlog → Todo, and a comment on each issue.'}
        </Notice>
      ) : null}
      {goingLive ? (
        <Notice label="Live warnings" tone="warning">
          {WARNINGS_GO_LIVE_NOTE}
        </Notice>
      ) : null}
      <FormBar
        dirty={dirty}
        saving={saving}
        outcome={outcome}
        statusRef={statusRef}
        onDiscarded={discarded}
        onReset={() => setState(initial)}
      />
    </form>
  );
}
