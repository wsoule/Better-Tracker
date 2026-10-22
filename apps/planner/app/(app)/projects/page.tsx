import type { Metadata } from 'next';

import {
  buildProjectsPage,
  parseProjectFilter,
  PROJECT_QUERY_MAX,
} from '../../../lib/adapters/projects';
import { currentHref } from '../../../lib/issue-load';
import {
  loadTimelineView,
  orSetup,
  requireInstalledActor,
} from '../../../lib/load';
import css from './page.module.css';
import ProjectsRegister from './projects-register';

export const metadata: Metadata = { title: 'Projects' };

/* /projects (architecture §8.4 "Projects"): every project that is not
   completed or canceled, grouped by initiative, with its Linear status,
   next milestone, lead and what allocation would do. Read-only for
   everyone; ?filter= (all | blocked | at_risk | inactive) and ?q= seed the
   client-side search so a filtered view can be linked. */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Request data first: the page is per-request, never prerendered.
  const params = await searchParams;
  const { engine, actor, workspaceId } = await requireInstalledActor(
    currentHref('/projects', params)
  );
  const [timeline, loaded] = await orSetup(
    Promise.all([
      loadTimelineView(engine, workspaceId),
      engine.load(workspaceId, actor),
    ])
  );
  const statusNames = new Map(
    [...loaded.snapshot.projects.values()].map((project) => [
      project.id,
      project.statusName,
    ])
  );
  const page = buildProjectsPage({ timeline, statusNames });
  const query =
    typeof params.q === 'string' ? params.q.slice(0, PROJECT_QUERY_MAX) : '';

  return (
    <>
      <header className={css.head}>
        <h1 className={css.title}>Projects</h1>
        <p className={css.receipts}>{page.receipts}</p>
      </header>
      <ProjectsRegister
        groups={page.groups}
        filters={page.filters}
        initialFilter={parseProjectFilter(params.filter)}
        initialQuery={query}
      />
    </>
  );
}
