import type { UiTone } from '@better-tracker/ui';
import type { ReactNode } from 'react';

import css from './page.module.css';

/* Gr8r's settings rows (pages/settings.css .srow / .sblock), shared by
   every section: a row is the setting's name (medium) over one quiet
   line on what it does, with its control (a switch, a field, a value) on
   the right, rows split by soft dividers; a block groups rows under a
   small heading with a --border rule. Server- and client-safe. */

/** One setting: its name and help on the left, the control on the right. */
export function SettingRow({
  title,
  help,
  helpId,
  labelFor,
  control,
}: {
  title: ReactNode;
  help?: ReactNode;
  /** Id of the help line, for the control's aria-describedby. */
  helpId?: string;
  /** Makes the name the <label> of this input id. */
  labelFor?: string;
  control?: ReactNode;
}) {
  return (
    <div className={css.srow}>
      <div className={css.srowText}>
        {labelFor !== undefined ? (
          <label htmlFor={labelFor} className={css.srowTitle}>
            {title}
          </label>
        ) : (
          <p className={css.srowTitle}>{title}</p>
        )}
        {help !== undefined && help !== null ? (
          <p id={helpId} className={css.srowHelp}>
            {help}
          </p>
        ) : null}
      </div>
      {control !== undefined ? (
        <div className={css.srowControl}>{control}</div>
      ) : null}
    </div>
  );
}

/** A setting's value as plain text (a guest's view, the Status rows),
    coloured by its tone. */
export function SettingValue({
  tone = 'default',
  children,
}: {
  tone?: UiTone;
  children: ReactNode;
}) {
  return (
    <span className={css.srowValue} data-tone={tone}>
      {children}
    </span>
  );
}

/** A group of rows under a heading; without a title, just the rows. */
export function SettingBlock({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  if (title === undefined || title === '') {
    return <div className={css.sblock}>{children}</div>;
  }
  return (
    <section className={css.sblock}>
      <h2 className={css.sblockTitle}>{title}</h2>
      {children}
    </section>
  );
}
