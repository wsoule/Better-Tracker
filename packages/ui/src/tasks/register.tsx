'use client';

import type { CSSProperties } from 'react';

import { Link } from '../lib/link';
import { cx } from './class-names';
import styles from './register.module.css';
import type {
  RegisterCellProps,
  RegisterProps,
  RegisterRowProps,
} from './types';

/* The Roster register as a layout: a list of hairline rows sharing one
   grid template (and an optional mono header row), collapsed on -1px
   margins. Used for Projects, Runs and Settings. Below `stackBelow` the
   rows become cards (subject cell on top, the rest on `stackedColumns`)
   and each cell shows its own micro-label,
   which the header otherwise carries (the labels stay readable to
   assistive tech either way, because the header itself is decorative). */
export function Register({
  columns,
  header,
  label,
  children,
  stackBelow = 900,
  stackedColumns = 'minmax(0, 1fr) minmax(0, 1fr)',
}: RegisterProps) {
  const hasHeader = header !== undefined && header.length > 0;
  return (
    <div
      className={cx(
        styles.register,
        hasHeader ? styles.hasHeader : undefined,
        stackBelow === 700 ? styles.stack700 : styles.stack900
      )}
      style={
        {
          '--register-cols': columns,
          '--register-stacked-cols': stackedColumns,
        } as CSSProperties
      }
    >
      {hasHeader ? (
        <div className={styles.header} aria-hidden="true">
          {header.map((column) => (
            <span
              key={column.id}
              className={cx(
                styles.headerCell,
                column.align === 'end' ? styles.end : undefined
              )}
            >
              {column.label}
            </span>
          ))}
        </div>
      ) : null}
      <ul className={styles.list} aria-label={label}>
        {children}
      </ul>
    </div>
  );
}

/* One register row. With href (or onActivate) the whole row is the target:
   a stretched link/button covers it, is reachable by Tab, and draws the
   focus ring around the row; links inside cells sit above it. Hover and
   focus flood the row to ink by swapping paper and ink tokens locally. */
export function RegisterRow({
  href,
  external = false,
  onActivate,
  rowLabel,
  tone = 'default',
  selected = false,
  children,
}: RegisterRowProps) {
  const linked = href !== undefined || onActivate !== undefined;
  const name =
    rowLabel !== undefined && external
      ? `${rowLabel} (opens in a new tab)`
      : rowLabel;
  return (
    <li
      className={cx(
        styles.row,
        tone === 'accent' ? styles.rowAccent : undefined,
        tone === 'muted' ? styles.rowMuted : undefined,
        selected ? styles.selected : undefined,
        linked ? styles.linked : undefined
      )}
      data-tone={tone}
      aria-current={selected ? 'true' : undefined}
    >
      {href !== undefined ? (
        <Link
          href={href}
          className={styles.overlay}
          aria-label={name}
          target={external ? '_blank' : undefined}
          rel={external ? 'noreferrer noopener' : undefined}
        />
      ) : onActivate !== undefined ? (
        <button
          type="button"
          className={styles.overlay}
          aria-label={name}
          onClick={onActivate}
        />
      ) : null}
      {children}
    </li>
  );
}

const VARIANT_CLASS: Record<
  NonNullable<RegisterCellProps['variant']>,
  string | undefined
> = {
  name: styles.variantName,
  value: styles.variantValue,
  mono: styles.variantMono,
};

/* A register cell: an optional mono micro-label over a value, in one of
   three voices: name (sans 15/600, the row's subject), value (body copy)
   or mono (machine furniture: states, counts, dates). */
export function RegisterCell({
  label,
  variant = 'value',
  sub,
  tone = 'default',
  align = 'start',
  children,
}: RegisterCellProps) {
  return (
    <div
      className={cx(
        styles.cell,
        VARIANT_CLASS[variant],
        tone === 'accent' ? styles.toneAccent : undefined,
        tone === 'muted' ? styles.toneMuted : undefined,
        align === 'end' ? styles.end : undefined
      )}
      data-tone={tone}
    >
      {label !== undefined && label !== '' ? (
        <span className={styles.cellLabel}>{label}</span>
      ) : null}
      {children !== undefined && children !== null ? (
        <span className={styles.cellValue}>{children}</span>
      ) : null}
      {sub !== undefined && sub !== null ? (
        <span className={styles.cellSub}>{sub}</span>
      ) : null}
    </div>
  );
}
