import type { ReactNode } from 'react';

/* The hatched titlebar every block opens with (the chrome zone of a
   technical drawing), using the global .blockBar classes so the whole app
   reads as one register. */
export default function BlockBar({
  index,
  title,
  meta,
  children,
}: {
  /** Two-digit section key, e.g. "01". */
  index: string;
  title: string;
  /** Right-aligned mono note: dates, counts, sync time. */
  meta?: ReactNode;
  /** Extra controls placed before the meta. */
  children?: ReactNode;
}) {
  return (
    <div className="blockBar">
      <span className="blockKey">{index}</span>
      <h2 className="blockTitle">{title}</h2>
      {children}
      {meta !== undefined && meta !== null ? (
        <span className="blockMeta">{meta}</span>
      ) : null}
    </div>
  );
}
