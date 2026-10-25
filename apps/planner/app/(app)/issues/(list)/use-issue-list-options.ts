'use client';

import type { IssueListOptions } from '@better-tracker/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getIssueListOptions } from '../../../../lib/api-client';

/** The Issues page's picker options, fetched lazily. */
export interface IssueListOptionsState {
  /** The last answer (null until the first one arrives). */
  options: IssueListOptions | null;
  loading: boolean;
  error: string | null;
  /** Fetches the options unless they are here and fresh, being fetched,
      or failed (call it when a picker that needs them opens). */
  load: () => void;
  /** Fetches them again after a failure (the picker's Retry). */
  retry: () => void;
}

/**
 * GET /api/issues/options, once, on the first `load()` (the first popover
 * that needs them): at 50,000 issues the milestones alone are hundreds of
 * kilobytes, and most visits never open a picker. The answer is kept by
 * the mirror version it was built from; once the page renders from a
 * newer version (someone moved an issue, a webhook landed), the next
 * picker that opens fetches them again. They are kept by workspace too
 * (owner decision 2026-10-25: a browser holds several): versions of two
 * workspaces' mirrors say nothing about each other, so a page of another
 * workspace never reuses them.
 */
export function useIssueListOptions(
  pageMirrorVersion: number,
  workspaceId: string
): IssueListOptionsState {
  const [state, setState] = useState<{
    options: IssueListOptions | null;
    version: number;
    workspaceId: string | null;
    loading: boolean;
    error: string | null;
  }>({
    options: null,
    version: -1,
    workspaceId: null,
    loading: false,
    error: null,
  });
  const inFlight = useRef<AbortController | null>(null);

  const fetchNow = useCallback(() => {
    const forWorkspace = workspaceId;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setState((current) => ({ ...current, loading: true, error: null }));
    getIssueListOptions(controller.signal).then(
      (body) => {
        if (controller.signal.aborted) return;
        inFlight.current = null;
        setState({
          options: body.options,
          version: body.mirrorVersion,
          workspaceId: forWorkspace,
          loading: false,
          error: null,
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        inFlight.current = null;
        setState((current) => ({
          ...current,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : 'The options could not be loaded.',
        }));
      }
    );
  }, [workspaceId]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const failed = state.error !== null;
  const load = useCallback(() => {
    if (inFlight.current !== null || failed) return;
    if (
      state.options !== null &&
      state.workspaceId === workspaceId &&
      pageMirrorVersion <= state.version
    ) {
      return;
    }
    fetchNow();
  }, [
    fetchNow,
    failed,
    state.options,
    state.version,
    state.workspaceId,
    workspaceId,
    pageMirrorVersion,
  ]);

  // One object while nothing in it changes: every row's cell pickers take
  // it, and a new one each render would redraw all of them.
  // Options of another workspace are never shown.
  const options = state.workspaceId === workspaceId ? state.options : null;
  return useMemo(
    () => ({
      options,
      loading: state.loading,
      error: state.error,
      load,
      retry: fetchNow,
    }),
    [options, state.loading, state.error, load, fetchNow]
  );
}
