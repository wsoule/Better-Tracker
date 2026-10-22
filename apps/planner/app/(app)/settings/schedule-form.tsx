'use client';

import { Checkbox } from '@better-tracker/ui';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

import {
  parseScheduleForm,
  PROJECT_STATUS_OPTIONS,
  SCHEDULE_PROJECTS_GROUP,
  SCHEDULE_TIME_GROUP,
  type ScheduleForm as ScheduleFormState,
  scheduleFieldError,
  scheduleSavedMessage,
  TUNING_FIELDS,
  TUNING_GROUPS,
} from '../../../lib/adapters/settings';
import FormBar from './form-bar';
import css from './page.module.css';
import { SettingBlock, SettingRow } from './setting-rows';
import { useSaveSettings } from './use-save-settings';

function sameForm(a: ScheduleFormState, b: ScheduleFormState): boolean {
  return (
    a.timezone === b.timezone &&
    TUNING_FIELDS.every((f) => a.values[f.key] === b.values[f.key]) &&
    a.statuses.length === b.statuses.length &&
    a.statuses.every((s) => b.statuses.includes(s))
  );
}

/** An input's aria-describedby: its help line, then its error if any. */
function describedBy(help: string, error: string | undefined): string {
  return error === undefined ? help : `${help} ${error}`;
}

/** The error keys in the order the rows show them (first one gets focus). */
const FIELD_ORDER = [
  'timezone',
  ...TUNING_FIELDS.map((f) => f.key),
  'statuses',
] as const;

/* Settings → Schedule: the workspace timezone (checked against the IANA
   database on the server), the tuning numbers behind risk, warnings and
   the timeline, and the active project statuses, as Gr8r setting rows
   under four headings, each with one line on what it changes. The form
   checks ranges before sending; the server checks everything again, and
   its timezone refusal is shown on the timezone field like the form's own
   errors. Whenever a submit stops on a field error, focus moves to the
   first field marked. */
export default function ScheduleForm({
  initial,
}: {
  initial: ScheduleFormState;
}) {
  const [form, setForm] = useState(initial);
  const [synced, setSynced] = useState(initial);
  if (!sameForm(synced, initial)) {
    setSynced(initial);
    setForm(initial);
  }
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const { saving, outcome, statusRef, save, discarded } =
    useSaveSettings('Schedule');
  const baseId = useId();
  const dirty = !sameForm(form, initial);
  const fieldId = (key: string) =>
    key === 'timezone' ? `${baseId}-tz` : `${baseId}-${key}`;

  // The field to focus once it is enabled again (inputs are disabled while
  // a save is in flight), set when a submit stops on a field error.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    if (saving || focusNext.current === null) return;
    const target = document.getElementById(focusNext.current);
    focusNext.current = null;
    const input =
      target instanceof HTMLInputElement
        ? target
        : target?.querySelector('input');
    input?.focus();
  });

  function showErrors(next: Partial<Record<string, string>>) {
    setErrors(next);
    const first = FIELD_ORDER.find((key) => next[key] !== undefined);
    focusNext.current = first === undefined ? null : fieldId(first);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    const parsed = parseScheduleForm(form);
    if (!parsed.ok) {
      showErrors(parsed.errors);
      return;
    }
    setErrors({});
    void save(
      { timezone: parsed.patch.timezone, tuning: parsed.patch.tuning },
      scheduleSavedMessage(initial, parsed.patch),
      (error) => {
        const field = scheduleFieldError(error);
        if (field === null) return false;
        showErrors({ [field.field]: field.message });
        return true;
      }
    );
  }

  const errorCount = Object.keys(errors).length;

  return (
    <form
      onSubmit={submit}
      className={css.form}
      aria-label="Schedule"
      noValidate
    >
      <SettingBlock title={SCHEDULE_TIME_GROUP}>
        <SettingRow
          title="Timezone"
          labelFor={`${baseId}-tz`}
          help="Decides what “today” is for due dates, the daily run and digests. An IANA name such as America/Chicago."
          helpId={`${baseId}-tz-help`}
          control={
            <span className={css.field}>
              <input
                id={`${baseId}-tz`}
                className={`input ${css.textInput}`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.timezone}
                disabled={saving}
                aria-invalid={errors.timezone !== undefined}
                aria-describedby={describedBy(
                  `${baseId}-tz-help`,
                  errors.timezone !== undefined
                    ? `${baseId}-tz-error`
                    : undefined
                )}
                onChange={(event) =>
                  setForm((f) => ({ ...f, timezone: event.target.value }))
                }
              />
              {errors.timezone !== undefined ? (
                <span id={`${baseId}-tz-error`} className={css.fieldError}>
                  {errors.timezone}
                </span>
              ) : null}
            </span>
          }
        />
      </SettingBlock>
      {TUNING_GROUPS.map((group) => (
        <SettingBlock key={group.id} title={group.title}>
          {TUNING_FIELDS.filter((field) => field.group === group.id).map(
            (field) => {
              const id = `${baseId}-${field.key}`;
              const error = errors[field.key];
              return (
                <SettingRow
                  key={field.key}
                  title={field.label}
                  labelFor={id}
                  help={field.help}
                  helpId={`${id}-help`}
                  control={
                    <span className={css.field}>
                      <span className={css.numberRow}>
                        <input
                          id={id}
                          className={`input ${css.numberInput}`}
                          type="number"
                          inputMode="numeric"
                          min={field.min}
                          max={field.max}
                          step={1}
                          value={form.values[field.key]}
                          disabled={saving}
                          aria-invalid={error !== undefined}
                          aria-describedby={describedBy(
                            `${id}-help`,
                            error !== undefined ? `${id}-error` : undefined
                          )}
                          onChange={(event) =>
                            setForm((f) => ({
                              ...f,
                              values: {
                                ...f.values,
                                [field.key]: event.target.value,
                              },
                            }))
                          }
                        />
                        <span className={css.unit}>days</span>
                      </span>
                      {error !== undefined ? (
                        <span id={`${id}-error`} className={css.fieldError}>
                          {error}
                        </span>
                      ) : null}
                    </span>
                  }
                />
              );
            }
          )}
        </SettingBlock>
      ))}
      <SettingBlock title={SCHEDULE_PROJECTS_GROUP}>
        <SettingRow
          title="Active project statuses"
          help="Projects in these Linear statuses get allocation and warnings; the rest are shown but left alone."
          control={
            <span className={css.field}>
              <span
                id={fieldId('statuses')}
                className={css.statusList}
                role="group"
                aria-label="Active project statuses"
                aria-describedby={
                  errors.statuses !== undefined
                    ? `${fieldId('statuses')}-error`
                    : undefined
                }
              >
                {PROJECT_STATUS_OPTIONS.map((option) => (
                  <Checkbox
                    key={option.id}
                    label={option.label}
                    checked={form.statuses.includes(option.id)}
                    disabled={saving}
                    onChange={(on) =>
                      setForm((f) => ({
                        ...f,
                        statuses: on
                          ? [
                              ...f.statuses.filter((s) => s !== option.id),
                              option.id,
                            ]
                          : f.statuses.filter((s) => s !== option.id),
                      }))
                    }
                  />
                ))}
              </span>
              {errors.statuses !== undefined ? (
                <span
                  id={`${fieldId('statuses')}-error`}
                  className={css.fieldError}
                >
                  {errors.statuses}
                </span>
              ) : null}
            </span>
          }
        />
      </SettingBlock>
      <FormBar
        dirty={dirty}
        saving={saving}
        outcome={outcome}
        statusRef={statusRef}
        onDiscarded={discarded}
        blocked={
          errorCount > 0
            ? `Fix ${errorCount === 1 ? 'the field' : `${errorCount} fields`} marked above`
            : null
        }
        onReset={() => {
          setForm(initial);
          setErrors({});
        }}
      />
    </form>
  );
}
