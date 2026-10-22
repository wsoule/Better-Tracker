import type { ComponentType, ReactNode } from 'react';

// Shared prop vocabulary. Deliberately free of any planner/Linear types so
// the components port to other apps (e.g. Dispatch): hosts map their own
// models onto these shapes in a thin adapter.

/**
 * A milestone's status as drawn by StatusMark, in Gr8r's shapes and the
 * semantic hues: done = green disc with a tick, on_track = green ring,
 * at_risk = amber half-filled ring, overdue = red disc, missing (an input
 * is missing: no date, no issues, a rubric gap) = dashed grey ring.
 */
export type UiStatus = 'done' | 'on_track' | 'at_risk' | 'overdue' | 'missing';

/**
 * A semantic status colour (docs/architecture.md §8.2): danger = red
 * (overdue, failed, urgent), warning = amber (at risk, blocked, missing
 * input, stalled), success = green (on track, complete, met, succeeded),
 * info = blue (in progress, running, live).
 */
export type SemanticTone = 'danger' | 'warning' | 'success' | 'info';

/**
 * The colour of a piece of text, a chip, a notice or a count: default ink,
 * muted grey (inactive, undated, nothing to do), accent (the brand purple:
 * new, unread, selected; never a status), or a semantic tone. Components
 * emit it as `data-tone`, which defines --tone, --tone-ink, --tone-soft and
 * --tone-line for their CSS (primitives.css).
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
