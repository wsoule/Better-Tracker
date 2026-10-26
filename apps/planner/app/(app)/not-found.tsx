import { Button } from '@better-tracker/ui';
import { FileQuestionMark } from 'lucide-react';

import MessageBlock from './components/message-block';
import { PageCrumb } from './components/page-crumb';
import WorkspaceGuard from './components/workspace-guard';

/* notFound() anywhere under (app): an issue, milestone, project or run
   that does not exist (or no longer does in Linear), or an unknown path.
   It renders the navigation guard too (a test checks): pages call
   notFound() before their own WorkspaceGuard, and in a tab left on Acme
   after the browser switched to Globex an Acme run or issue is looked up
   in Globex and missed, so without it the tab would say an existing Acme
   item is gone instead of reloading into Globex. */
export default function NotFound() {
  return (
    <MessageBlock
      label="Not found"
      headline="Nothing lives at this address."
      icon={<FileQuestionMark strokeWidth={1.8} />}
      actions={
        <>
          <Button href="/week" variant="primary">
            Go to My week
          </Button>
          <Button href="/timeline">Open the timeline</Button>
        </>
      }
    >
      <p>
        The link may be old or mistyped, or what it pointed to (an issue,
        project, milestone or run) was removed or archived in Linear, or is not
        visible to you.
      </p>
      <PageCrumb label="Not found" />
      <WorkspaceGuard />
    </MessageBlock>
  );
}
