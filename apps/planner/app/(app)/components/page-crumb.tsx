'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

// The topbar breadcrumb is the section (from the URL) plus, optionally, one
// crumb a page names itself: `<PageCrumb label="Atlas billing migration" />`
// anywhere in a page adds "TIMELINE › ATLAS BILLING MIGRATION". It renders
// nothing; it only tells the shell, and clears itself on unmount.

interface CrumbApi {
  crumb: string | null;
  setCrumb: (label: string | null) => void;
}

const CrumbContext = createContext<CrumbApi | null>(null);

export function CrumbProvider({ children }: { children: ReactNode }) {
  const [crumb, setCrumb] = useState<string | null>(null);
  const value = useMemo(() => ({ crumb, setCrumb }), [crumb]);
  return (
    <CrumbContext.Provider value={value}>{children}</CrumbContext.Provider>
  );
}

/** The crumb the current page set, or null. */
export function usePageCrumb(): string | null {
  return useContext(CrumbContext)?.crumb ?? null;
}

/** Names the current page in the breadcrumb (outside the shell: a no-op). */
export function PageCrumb({ label }: { label: string }): null {
  const setCrumb = useContext(CrumbContext)?.setCrumb;
  useEffect(() => {
    if (setCrumb === undefined) return undefined;
    setCrumb(label);
    return () => setCrumb(null);
  }, [label, setCrumb]);
  return null;
}
