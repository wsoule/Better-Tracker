'use client';

import {
  BlockBar,
  Button,
  Chip,
  EmptyState,
  Link,
  Register,
  RegisterCell,
  RegisterRow,
  useToast,
} from '@better-tracker/ui';
import { Mail, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type RefObject, useEffect, useRef, useState } from 'react';

import {
  type DigestPreview,
  type DigestPreviewModel,
  isDigestPreviewModel,
} from '../../../lib/adapters/settings';
import { syncFailureMessage } from '../../../lib/adapters/shell';
import { sendJson } from '../../../lib/api-client';
import css from './page.module.css';

/** The status line's resting words. */
const PREVIEW_NOTE = 'The preview records and sends nothing.';

/* Settings → Status, for everyone signed in: "Resync now" (POST
   /api/sync, then the page re-reads the sync time) and "Preview today's
   digests" (POST /api/warnings/preview: built, never recorded or sent),
   rendered inline below as one block per recipient. Failures are
   toasted. Each button disables while it works, so keyboard focus first
   moves to the status line beside them (tabIndex=-1, a live region saying
   what is happening and how it went); a finished preview takes focus to
   its heading. */
export default function StatusActions() {
  const router = useRouter();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<DigestPreviewModel | null>(null);
  const [note, setNote] = useState(PREVIEW_NOTE);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Focus the preview's heading once a new preview has rendered.
  useEffect(() => {
    if (preview !== null) headingRef.current?.focus();
  }, [preview]);

  async function resync() {
    setSyncing(true);
    setNote('Syncing from Linear…');
    statusRef.current?.focus();
    const result = await sendJson('POST', '/api/sync', {});
    setSyncing(false);
    if (!result.ok) {
      setNote(`Sync failed: ${result.message}`);
      toast({ kind: 'error', label: 'Sync', message: result.message });
      return;
    }
    const failure = syncFailureMessage(result.data);
    setNote(
      failure === null ? 'Synced from Linear.' : `Sync failed: ${failure}`
    );
    toast(
      failure === null
        ? {
            kind: 'info',
            label: 'Synced',
            message: 'Resynced from Linear; every screen now shows it.',
          }
        : { kind: 'error', label: 'Sync', message: failure }
    );
    router.refresh();
  }

  async function previewDigests() {
    setPreviewing(true);
    setNote('Building today’s digests…');
    statusRef.current?.focus();
    const result = await sendJson('POST', '/api/warnings/preview', {});
    setPreviewing(false);
    if (!result.ok) {
      setNote(`Preview failed: ${result.message}`);
      toast({ kind: 'error', label: 'Preview', message: result.message });
      return;
    }
    const body = result.data as { preview?: unknown } | null;
    if (!isDigestPreviewModel(body?.preview)) {
      setNote('Preview failed: it came back in an unexpected shape.');
      toast({
        kind: 'error',
        label: 'Preview',
        message: 'The preview came back in an unexpected shape.',
      });
      return;
    }
    setNote(PREVIEW_NOTE);
    setPreview(body.preview);
  }

  return (
    <div className={css.form}>
      <div className={css.formBar}>
        <Button
          size="sm"
          icon={<RefreshCw size={14} strokeWidth={1.5} />}
          disabled={syncing}
          onClick={() => void resync()}
        >
          {syncing ? 'Syncing…' : 'Resync now'}
        </Button>
        <Button
          size="sm"
          icon={<Mail size={14} strokeWidth={1.5} />}
          disabled={previewing}
          onClick={() => void previewDigests()}
        >
          {previewing ? 'Building…' : 'Preview today’s digests'}
        </Button>
        <p
          ref={statusRef}
          tabIndex={-1}
          className={css.formStatus}
          aria-live="polite"
        >
          {note}
        </p>
      </div>
      {preview !== null ? (
        <DigestPreviewBlock preview={preview} headingRef={headingRef} />
      ) : null}
    </div>
  );
}

// The preview takes focus on its heading when it arrives (rather than
// being a live region that would read every digest aloud).
function DigestPreviewBlock({
  preview,
  headingRef,
}: {
  preview: DigestPreviewModel;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section className={css.preview} aria-labelledby="digest-preview-title">
      <h3
        id="digest-preview-title"
        ref={headingRef}
        tabIndex={-1}
        className={css.previewTitle}
      >
        {preview.heading}
      </h3>
      <p className={css.previewSummary}>{preview.summary}</p>
      {preview.digests.length === 0 ? (
        <EmptyState>No digests today</EmptyState>
      ) : (
        preview.digests.map((digest, index) => (
          <DigestBlock
            key={digest.recipientId}
            digest={digest}
            index={String(index + 1).padStart(2, '0')}
          />
        ))
      )}
    </section>
  );
}

function DigestBlock({
  digest,
  index,
}: {
  digest: DigestPreview;
  index: string;
}) {
  return (
    <div className={css.collapse}>
      <BlockBar
        index={index}
        title={digest.recipient}
        meta={`${digest.items.length} ${digest.items.length === 1 ? 'item' : 'items'} · ${digest.email ?? 'no email in Linear'}`}
      />
      {/* The subject (a milestone, or a project whose allocation stopped)
          leads each row: it is the card's title once the register
          stacks. */}
      <Register
        label={`Digest for ${digest.recipient}`}
        columns="minmax(0, 1fr) 176px minmax(0, 0.5fr)"
        stackWithin={700}
        header={[
          { id: 'what', label: 'What' },
          { id: 'kind', label: 'Why' },
          { id: 'due', label: 'Due' },
        ]}
      >
        {digest.items.map((item) => (
          <RegisterRow key={item.id} tone={item.tone}>
            <RegisterCell
              label="What"
              variant="name"
              sub={item.lines.join(' · ')}
            >
              <Link href={item.href}>{item.title}</Link>
            </RegisterCell>
            <RegisterCell label="Why">
              <Chip tone={item.tone === 'accent' ? 'accent' : 'default'}>
                {item.kindLabel}
              </Chip>
            </RegisterCell>
            <RegisterCell
              label="Due"
              variant="mono"
              tone={item.tone}
              sub={item.dueNote ?? undefined}
            >
              {item.due ?? 'Whole project'}
            </RegisterCell>
          </RegisterRow>
        ))}
      </Register>
    </div>
  );
}
