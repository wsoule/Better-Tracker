import type { ComponentType, ReactNode } from 'react';

// Shared prop vocabulary. Deliberately free of any planner/Linear types so
// the components port to other apps (e.g. Dispatch): hosts map their own
// models onto these shapes in a thin adapter.

/**
 * Status in the Analytics Mark idiom: filled vs hollow, ink vs accent.
 * done = filled ink, on_track = hollow ink, at_risk = 2px accent outline,
 * overdue = filled accent, missing = hatched (an input is missing).
 */
export type UiStatus = 'done' | 'on_track' | 'at_risk' | 'overdue' | 'missing';

/** Text emphasis: default ink, muted grey, or the accent ("needs action"). */
export type UiTone = 'default' | 'muted' | 'accent';

export interface UiLinkProps {
  href: string;
  className?: string;
  children?: ReactNode;
  'aria-current'?: 'page' | undefined;
  'aria-label'?: string;
  title?: string;
  target?: string;
  rel?: string;
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}

/** The host's link component (next/link, a router Link, or a plain <a>). */
export type UiLinkComponent = ComponentType<UiLinkProps>;
