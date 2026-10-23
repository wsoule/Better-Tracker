import type { ComponentType, ReactNode } from 'react';

// Shared prop vocabulary. Deliberately free of any planner/Linear types so
// the components port to other apps (e.g. Dispatch): hosts map their own
// models onto these shapes in a thin adapter.

/**
 * Status in the Analytics Mark idiom (filled vs hollow vs hatched squares),
 * coloured by the status hues (docs/architecture.md §8.2): done = filled
 * ink (never green: a green fill reads as the red one without red-green
 * vision), on_track = hollow green, at_risk = 2px amber outline, overdue =
 * filled red, missing = hatched grey (an input is missing), open = hollow
 * ink (open work that makes no status claim of its own, such as an issue
 * box on the graph, whose status is its milestone's).
 */
export type UiStatus =
  | 'done'
  | 'on_track'
  | 'at_risk'
  | 'overdue'
  | 'missing'
  | 'open';

/**
 * A status colour (owner decision 2026-10-22, docs/architecture.md §8.2):
 * danger = red (overdue, failed, urgent), warning = amber (at risk,
 * blocked, unassigned, a missing input), success = green (on track, done,
 * met, succeeded), info = blue (in progress, running, live).
 */
export type SemanticTone = 'danger' | 'warning' | 'success' | 'info';

/**
 * The colour of a piece of text, a chip, a notice, a count or a fill:
 * default ink, muted grey (inactive, nothing to do), accent (the brand
 * purple: new, unread, selected; never a status), or a status tone.
 * Components emit it as `data-tone`, which gives their CSS --tone (mark),
 * --tone-ink (text) and --on-tone (tokens.css, TONE HOOK).
 */
export type UiTone = 'default' | 'muted' | 'accent' | SemanticTone;

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
