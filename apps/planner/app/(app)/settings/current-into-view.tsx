'use client';

import { type ReactNode, useEffect, useRef } from 'react';

/* On a phone the settings sub-nav is one sideways-scrolling strip, and a
   section late in the list (Notifications, Audit) would start out of
   view: once mounted, scroll the strip (only the strip, never the page)
   so the current item sits in it. */
export default function CurrentIntoView({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const current = ref.current?.querySelector<HTMLElement>(
      '[aria-current="page"]'
    );
    const strip = current?.closest('ul');
    if (current == null || strip == null) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    const left =
      current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
    strip.scrollLeft = Math.max(0, left);
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
