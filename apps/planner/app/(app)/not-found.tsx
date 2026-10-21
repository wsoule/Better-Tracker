import { Button } from '@better-tracker/ui';

import MessageBlock from './components/message-block';
import { PageCrumb } from './components/page-crumb';

/* notFound() anywhere under (app): a milestone, project or run id that
   does not exist (or no longer does in Linear). */
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
        The link may be old or mistyped, or the project or milestone it pointed
        to was removed or archived in Linear.
      </p>
      <PageCrumb label="Not found" />
    </MessageBlock>
  );
}
