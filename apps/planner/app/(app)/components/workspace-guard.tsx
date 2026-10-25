import { getPageContext } from '../../../lib/load';
import { WorkspaceGuardClient } from './workspace-frame';

/* Every (app) page renders this once (a test checks): its request's
   workspace id (null when signed out) for the navigation guard
   (workspace-frame.tsx). getPageContext is cached per request, so it
   costs no second authentication; only the id reaches the browser. */
export default async function WorkspaceGuard() {
  const { actor } = await getPageContext();
  return (
    <WorkspaceGuardClient workspaceId={actor?.session.workspaceId ?? null} />
  );
}
