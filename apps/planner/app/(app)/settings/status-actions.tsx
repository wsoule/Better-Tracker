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
import { useState } from 'react';

import {
  type DigestPreview,
  type DigestPreviewModel,
  isDigestPreviewModel,
} from '../../../lib/adapters/settings';
import { syncFailureMessage } from '../../../lib/adapters/shell';
import { sendJson } from '../../../lib/api-client';
import css from './page.module.css';

/* Settings → Status, PM controls: "Resync now" (POST /api/sync, then the
   page re-reads the sync time) and "Preview today's digests" (POST
   /api/warnings/preview: built, never recorded or sent), rendered inline
   below as one block per recipient. Failures are toasted. */
export default function StatusActions() {
  const router = useRouter();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<DigestPreviewModel | null>(null);

  async function resync() {
    setSyncing(true);
    const result = await sendJson('POST', '/api/sync', {});
    setSyncing(false);
    if (!result.ok) {
      toast({ kind: 'error', label: 'Sync', message: result.message });
      return;
    }
    const failure = syncFailureMessage(result.data);
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
    const result = await sendJson('POST', '/api/warnings/preview', {});
    setPreviewing(false);
    if (!result.ok) {
      toast({ kind: 'error', label: 'Preview', message: result.message });
      return;
    }
    const body = result.data as { preview?: unknown } | null;
    if (!isDigestPreviewModel(body?.preview)) {
      toast({
        kind: 'error',
        label: 'Preview',
        message: 'The preview came back in an unexpected shape.',
      });
      return;
    }
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
        <p className={css.formStatus}>The preview records and sends nothing.</p>
      </div>
      {preview !== null ? <DigestPreviewBlock preview={preview} /> : null}
    </div>
  );
}

function DigestPreviewBlock({ preview }: { preview: DigestPreviewModel }) {
  return (
    <section
      className={css.preview}
      aria-labelledby="digest-preview-title"
      aria-live="polite"
    >
      <h3 id="digest-preview-title" className={css.previewTitle}>
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
      {/* The milestone leads each row: it is the card's title once the
          register stacks. */}
      <Register
        label={`Digest for ${digest.recipient}`}
        columns="minmax(0, 1fr) 176px minmax(0, 0.5fr)"
        stackWithin={700}
        header={[
          { id: 'what', label: 'Milestone' },
          { id: 'kind', label: 'Why' },
          { id: 'due', label: 'Due' },
        ]}
      >
        {digest.items.map((item) => (
          <RegisterRow key={item.id} tone={item.tone}>
            <RegisterCell
              label="Milestone"
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
            <RegisterCell label="Due" variant="mono" tone={item.tone}>
              {item.due ?? 'Whole project'}
            </RegisterCell>
          </RegisterRow>
        ))}
      </Register>
    </div>
  );
}
