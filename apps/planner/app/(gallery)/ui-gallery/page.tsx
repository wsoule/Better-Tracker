import { BlockBar, StatusMark, ThemeToggle } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../fonts';

export const metadata = { title: 'UI gallery' };

/* Index of the component gallery. Each component family adds a section
   (or a sub-route under /ui-gallery/<family>) rendering realistic fixture
   props in every state. */
export default function GalleryIndex() {
  return (
    <main className="page">
      <div className="block">
        <BlockBar
          index="00"
          title="UI gallery"
          meta={<ThemeToggle storageKey={THEME_STORAGE_KEY} />}
        />
        <div className="empty">
          <StatusMark status="done" label="Complete" showLabel />{' '}
          <StatusMark status="on_track" label="On track" showLabel />{' '}
          <StatusMark status="at_risk" label="At risk" showLabel />{' '}
          <StatusMark status="overdue" label="Overdue" showLabel />{' '}
          <StatusMark status="missing" label="Missing input" showLabel />
        </div>
        <p className="empty">
          <a className="accentLink" href="/ui-gallery/tasks">
            Tasks · primitives, task table, deadlines, registers
          </a>
        </p>
        <p className="empty">
          <a className="accentLink" href="/ui-gallery/task">
            Task · task detail drawer and page, relations, description, activity
          </a>
        </p>
        <p className="empty">
          <a className="accentLink" href="/ui-gallery/shell">
            Shell · app frame, command palette, toasts, slide-over, skeletons
          </a>
        </p>
        <p className="empty">
          <a className="accentLink" href="/ui-gallery/timeline">
            Timeline · Gantt chart, re-dating, dependencies, phone cards
          </a>
        </p>
        <p className="empty">
          <a className="accentLink" href="/ui-gallery/graph">
            Graph · dependency graph, upstream chains, legend, Copy Mermaid
          </a>
        </p>
      </div>
    </main>
  );
}
