'use client';

import { useState } from 'react';

import styles from './checkbox.module.css';
import type { CheckboxProps } from './types';

/* A checkbox in the Mark idiom: the native input (kept for forms, focus
   and assistive tech, visually hidden) drives a 13px square glyph that
   fills accent with a drawn check when on, beside a mono label. The whole
   line is the <label>, so clicking the text toggles it. Use it for set
   membership ("who are the watchers"); Switch is for a mode that is on or
   off. */
export function Checkbox({
  checked,
  defaultChecked = false,
  onChange,
  label,
  note,
  disabled,
  id,
  name,
  value,
  hideLabel = false,
  'aria-label': ariaLabel,
}: CheckboxProps) {
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;

  return (
    <label className={styles.checkbox} data-disabled={disabled === true}>
      <input
        type="checkbox"
        className={styles.input}
        id={id}
        name={name}
        value={value}
        checked={on}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => {
          const next = event.target.checked;
          if (checked === undefined) setInner(next);
          onChange?.(next);
        }}
      />
      <span className={styles.glyph} aria-hidden="true">
        <svg viewBox="0 0 13 13" className={styles.check}>
          <path d="M3 6.6 5.4 9 10 4" />
        </svg>
      </span>
      <span className={hideLabel ? 'srOnly' : styles.label}>{label}</span>
      {note !== undefined && note !== '' ? (
        <span className={styles.note}>{note}</span>
      ) : null}
    </label>
  );
}
