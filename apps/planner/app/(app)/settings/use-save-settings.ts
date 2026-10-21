'use client';

import { useToast } from '@better-tracker/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { sendJson } from '../../../lib/api-client';

/**
 * Saving one settings section: PATCH /api/settings with that section's
 * fields only, a toast either way, then router.refresh() so every server
 * view (and the shell) re-reads the saved settings. Resolves true when
 * the save went through.
 */
export function useSaveSettings(label: string): {
  saving: boolean;
  save: (
    patch: Record<string, unknown>,
    savedMessage: string
  ) => Promise<boolean>;
} {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (patch: Record<string, unknown>, savedMessage: string) => {
      setSaving(true);
      const result = await sendJson('PATCH', '/api/settings', patch);
      setSaving(false);
      if (!result.ok) {
        toast({ kind: 'error', label, message: result.message });
        return false;
      }
      toast({ kind: 'info', label, message: savedMessage });
      router.refresh();
      return true;
    },
    [label, router, toast]
  );
  return { saving, save };
}
