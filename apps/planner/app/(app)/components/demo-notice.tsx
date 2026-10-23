import { Notice } from '@better-tracker/ui';
import { Info } from 'lucide-react';

import css from './demo-notice.module.css';

const LONG =
  'Not connected to Linear. Every person, project and issue here is fictional, and edits change only this server’s in-memory copy.';
const SHORT = 'Fictional, nothing reaches Linear.';

/* The permanent demo-mode notice (architecture §8.4): every screen says the
   data is fictional and that nothing reaches Linear. Inside the app shell
   it is `strip`: Gr8r's thin full-bleed banner under the topbar (the
   shell draws the strip), one quiet line that shortens on narrow screens.
   On the signed-out landing page it is the neutral bordered Notice. Not a
   call to action either way. */
export default function DemoNotice({
  variant = 'notice',
}: {
  variant?: 'notice' | 'strip';
}) {
  if (variant === 'strip') {
    return (
      <p className={css.strip}>
        <Info
          className={css.icon}
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className="key">Demo data</span>
        <span className={css.sep} aria-hidden="true">
          ·
        </span>
        <span className={`${css.text} ${css.long}`}>{LONG}</span>
        <span className={`${css.text} ${css.short}`}>{SHORT}</span>
      </p>
    );
  }
  return (
    <Notice label="Demo data" tone="default">
      {LONG}
    </Notice>
  );
}
