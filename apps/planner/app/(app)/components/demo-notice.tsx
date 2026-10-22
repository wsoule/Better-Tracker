import { Notice } from '@better-tracker/ui';

/* The permanent demo-mode strip (architecture §8.4): every screen says the
   data is fictional and that nothing reaches Linear. A quiet neutral
   notice (Gr8r's default alert), not a call to action. */
export default function DemoNotice() {
  return (
    <Notice label="Demo data" tone="default">
      Not connected to Linear. Every person, project and issue here is
      fictional, and edits change only this server&apos;s in-memory copy.
    </Notice>
  );
}
