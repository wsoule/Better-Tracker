'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';

import css from './page.module.css';

/* The "whose week" picker everyone gets: a native select that navigates
   to /week?user=<id> (plain /week for the viewer's own). The server decides
   whether the id is honoured; this only changes the URL. Remount it with a
   key of the shown user so it follows navigation. */
export default function WeekUserPicker({
  options,
  value,
  viewerId,
}: {
  options: { id: string; label: string }[];
  value: string;
  viewerId: string;
}) {
  const router = useRouter();
  const id = useId();
  const [selected, setSelected] = useState(value);
  const [pending, startTransition] = useTransition();

  return (
    <div className={css.picker} data-pending={pending ? '' : undefined}>
      <label className={css.pickerLabel} htmlFor={id}>
        Showing
      </label>
      <select
        id={id}
        className={`select ${css.pickerSelect}`}
        value={selected}
        aria-busy={pending}
        onChange={(event) => {
          const next = event.target.value;
          setSelected(next);
          startTransition(() => {
            router.push(
              next === viewerId
                ? '/week'
                : `/week?user=${encodeURIComponent(next)}`
            );
          });
        }}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
