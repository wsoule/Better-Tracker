import { Button } from '@better-tracker/ui';

import MessageBlock from './components/message-block';
import { PageCrumb } from './components/page-crumb';

/* notFound() anywhere under (app): an issue, milestone, project or run
   that does not exist (or no longer does in Linear), or an unknown path. */
export default function NotFound() {
  return (
    <MessageBlock
      index="404"
      title="Not found"
      headline="Nothing lives at this address."
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
    </MessageBlock>
  );
}
