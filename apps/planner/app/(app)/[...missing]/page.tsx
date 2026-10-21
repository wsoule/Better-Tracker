import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

// not-found.tsx cannot export metadata, so the catch-all names the tab.
export const metadata: Metadata = { title: 'Not found' };

/* Any URL no route matches. With two root layouts ((app) and (gallery))
   Next has no single root not-found page, so unmatched URLs would get its
   unstyled default; routing them here renders (app)/not-found.tsx inside
   the app frame instead. Every real route is more specific and wins. */
export default function MissingPage(): never {
  notFound();
}
