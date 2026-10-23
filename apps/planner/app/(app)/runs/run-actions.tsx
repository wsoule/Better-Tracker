'use client';

import { Button, Link, useToast } from '@better-tracker/ui';
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

/* The run controls in the page header, for everyone signed in (owner
   decision 2026-10-22: no roles): "Preview (dry run)" always, "Run now"
   only while allocation is live — behind a second click, since it writes
   to Linear. The route enforces the live gate too. A run answers when it
   is finished, so the buttons wait, then open the new run. Failures are
   toasted. Two pieces for the header's grid: the buttons (top right, as
   Gr8r puts header actions) and one line on what they do (under the
   receipts). */
export default function RunActions({ liveRunsOn }: { liveRunsOn: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<Mode | null>(null);
  const [confirming, setConfirming] = useState(false);

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
    <>
      <div className={css.actionBar}>
        <Button
          variant={liveRunsOn ? 'secondary' : 'primary'}
          icon={<Eye size={14} strokeWidth={1.8} />}
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
                icon={<Play size={14} strokeWidth={1.8} />}
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
              icon={<Play size={14} strokeWidth={1.8} />}
              disabled={busy !== null}
              onClick={() => setConfirming(true)}
            >
              {busy === 'live' ? 'Assigning…' : 'Run now'}
            </Button>
          )
        ) : null}
      </div>
      <p className={css.actionNote} aria-live="polite">
        {confirming
          ? 'A live run assigns each project’s unassigned next-milestone issues to its lead in Linear, moves them Backlog → Todo and comments why.'
          : liveRunsOn
            ? 'A dry run only records what it would assign. Run now writes to Linear.'
            : null}
        {!liveRunsOn ? (
          <>
            Run now is off while allocation is in dry run. Anyone can switch
            allocation to live in{' '}
            <Link href="/settings" className="accentLink">
              Settings → Modes
            </Link>{' '}
            (the switch is audited).
          </>
        ) : null}
      </p>
    </>
  );
}
