'use client';

import { ListFilter, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from './button';
import styles from './filter-chips.module.css';
import type { FilterChipsProps } from './types';

/* Gr8r's filter chips bar (.chipsbar in view-engine.js): one chip per set
   filter, "Project is Atlas billing migration, Beacon search", joined by a
   quiet "and", each with its own × (named "Remove project filter"); then
   the host's "+ Filter" and, at the far right, Clear all. A chip's face can
   be wrapped in the host's picker (renderEditor), so a click on it reopens
   the values. Nothing is drawn while there are no chips. */
export function FilterChips({
  chips,
  add,
  onClearAll,
  clearDisabled = false,
  clearLabel = 'Clear all',
  label = 'Filters',
}: FilterChipsProps): ReactNode {
  if (chips.length === 0) return null;
  return (
    <div className={styles.bar} role="group" aria-label={label}>
      <ListFilter
        className={styles.lead}
        size={13}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <ul className={styles.list}>
        {chips.map((chip, index) => {
          const face = (
            <span className={styles.face}>
              {chip.icon !== undefined && chip.icon !== null ? (
                <span className={styles.icon} aria-hidden="true">
                  {chip.icon}
                </span>
              ) : null}
              <span className={styles.field}>{chip.field}</span>
              <span className={styles.is}>is</span>
              <span
                className={styles.summary}
                data-unknown={chip.unknown === true ? 'true' : undefined}
              >
                {chip.summary}
              </span>
            </span>
          );
          return (
            <li key={chip.id} className={styles.item}>
              {index > 0 ? <span className={styles.and}>and</span> : null}
              <span
                className={styles.chip}
                data-unknown={chip.unknown === true ? 'true' : undefined}
              >
                {chip.renderEditor !== undefined ? (
                  <span className={styles.editor}>
                    {chip.renderEditor(face)}
                  </span>
                ) : (
                  face
                )}
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={chip.removeLabel}
                  title={chip.removeLabel}
                  onClick={chip.onRemove}
                >
                  <X size={12} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {add !== undefined && add !== null ? (
        <span className={styles.add}>{add}</span>
      ) : null}
      {onClearAll !== undefined ? (
        <span className={styles.clear}>
          <Button
            variant="quiet"
            size="sm"
            disabled={clearDisabled}
            onClick={onClearAll}
          >
            {clearLabel}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
