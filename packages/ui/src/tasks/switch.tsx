'use client';

import { useState } from 'react';

import styles from './switch.module.css';
import type { SwitchProps } from './types';

/* The Matrix switch idiom: a 13px square glyph that fills accent when on,
   beside a mono label (and an optional sans note). The whole line is the
   control, role=switch with aria-checked, so Space/Enter and click toggle
   it natively; hover and focus turn the label orange. */
export function Switch({
  checked,
  defaultChecked = false,
  onChange,
  label,
  note,
  disabled,
  id,
}: SwitchProps) {
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;

  function toggle() {
    const next = !on;
    if (checked === undefined) setInner(next);
    onChange?.(next);
  }

  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={on}
      disabled={disabled}
      className={styles.switch}
      onClick={toggle}
    >
      <span className={styles.glyph} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
      {note !== undefined && note !== '' ? (
        <span className={styles.note}>{note}</span>
      ) : null}
    </button>
  );
}
