import { BlockBar, StatusMark, ThemeToggle } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../fonts';
import css from './index.module.css';

export const metadata = { title: 'UI gallery' };

/** The component families, each a sub-route under /ui-gallery/<family>. */
const FAMILIES = [
  {
    href: '/ui-gallery/tasks',
    title: 'Tasks',
    body: 'Primitives, task table, deadlines, registers',
  },
  {
    href: '/ui-gallery/task',
    title: 'Task',
    body: 'Task detail drawer and page, relations, description, activity',
  },
  {
    href: '/ui-gallery/shell',
    title: 'Shell',
    body: 'App frame, command palette, toasts, slide-over, skeletons',
  },
  {
    href: '/ui-gallery/timeline',
    title: 'Timeline',
    body: 'Gantt chart, re-dating, dependencies, phone cards',
  },
  {
    href: '/ui-gallery/graph',
    title: 'Graph',
    body: 'Dependency graph, upstream chains, legend, Copy Mermaid',
  },
] as const;

/* Index of the component gallery: the milestone status marks, then one
   row per component family in a Gr8r panel. Each family renders
   realistic fixture props in every state on its own page. */
export default function GalleryIndex() {
  return (
    <main className="page">
      <div className="block">
        <BlockBar
          title="UI gallery"
          meta={<ThemeToggle storageKey={THEME_STORAGE_KEY} />}
        />
        <div className={css.marks}>
          <StatusMark status="done" label="Complete" showLabel />
          <StatusMark status="on_track" label="On track" showLabel />
          <StatusMark status="at_risk" label="At risk" showLabel />
          <StatusMark status="overdue" label="Overdue" showLabel />
          <StatusMark status="missing" label="Missing input" showLabel />
        </div>
        <ul className={css.families} aria-label="Component families">
          {FAMILIES.map((family) => (
            <li key={family.href}>
              <a className={css.family} href={family.href}>
                <span className={css.familyTitle}>{family.title}</span>
                <span className={css.familyBody}>{family.body}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
