'use client';

import { Button, Link, Notice, useToast } from '@better-tracker/ui';
import { Eye, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { runIdFrom } from '../../../lib/adapters/shell';
import { sendJson } from '../../../lib/api-client';
import css from './page.module.css';

type Mode = 'dry_run' | 'live';

const STARTED: Record<Mode, string> = {
  dry_run: 'Dry run started: syncing from Linear, then planning.',
  live: 'Live run started: syncing from Linear, then assigning in Linear.',
};

const LABEL: Record<Mode, string> = { dry_run: 'Dry run', live: 'Live run' };

/* The run controls above the log (PMs only; the route enforces it too):
   "Preview (dry run)" always, "Run now" only while allocation is live —
   behind a second click, since it writes to Linear. A run answers when it
   is finished, so the buttons wait, then open the new run. Failures are
   toasted. Everyone else gets one line saying who can start a run. */
export default function RunActions({
  isPm,
  liveRunsOn,
  pmNames,
}: {
  isPm: boolean;
  liveRunsOn: boolean;
  pmNames: string[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<Mode | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!isPm) {
    return (
      <div className={css.actions}>
        <Notice label="Read only" tone="default">
          Only PMs can start a run
          {pmNames.length > 0 ? ` (${pmNames.join(', ')})` : ''}. The scheduled
          daily run starts on its own.
        </Notice>
      </div>
    );
  }

  async function start(mode: Mode) {
    setBusy(mode);
    setConfirming(false);
    toast({ kind: 'info', label: LABEL[mode], message: STARTED[mode] });
    const result = await sendJson('POST', '/api/runs', { mode });
    setBusy(null);
    if (!result.ok) {
      toast({ kind: 'error', label: LABEL[mode], message: result.message });
      return;
    }
    const id = runIdFrom(result.data);
    toast({
      kind: 'info',
      label: LABEL[mode],
      message: 'Finished. Opening the run log entry.',
    });
    if (id === null) router.refresh();
    else router.push(`/runs/${encodeURIComponent(id)}`);
  }

  return (
    <div className={css.actions}>
      <div className={css.actionBar}>
        <Button
          variant={liveRunsOn ? 'secondary' : 'primary'}
          icon={<Eye size={14} strokeWidth={1.5} />}
          disabled={busy !== null}
          onClick={() => void start('dry_run')}
        >
          {busy === 'dry_run' ? 'Planning…' : 'Preview (dry run)'}
        </Button>
        {liveRunsOn ? (
          confirming ? (
            <>
              <Button
                variant="danger"
                icon={<Play size={14} strokeWidth={1.5} />}
                disabled={busy !== null}
                onClick={() => void start('live')}
              >
                Assign in Linear now
              </Button>
              <Button
                variant="quiet"
                disabled={busy !== null}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon={<Play size={14} strokeWidth={1.5} />}
              disabled={busy !== null}
              onClick={() => setConfirming(true)}
            >
              {busy === 'live' ? 'Assigning…' : 'Run now'}
            </Button>
          )
        ) : null}
        <p className={css.actionNote} aria-live="polite">
          {confirming
            ? 'A live run assigns each project’s unassigned next-milestone issues to its lead in Linear, moves them Backlog → Todo and comments why.'
            : liveRunsOn
              ? 'A dry run only records what it would assign. Run now writes to Linear.'
              : null}
          {!liveRunsOn ? (
            <>
              Run now is off while allocation is in dry run. A PM can switch
              allocation to live in{' '}
              <Link href="/settings" className="accentLink">
                Settings → Modes
              </Link>
              .
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
