'use client';

import type {
  IssueListOptions,
  IssueListQuery,
  IssuePatch,
} from '@better-tracker/core';
import type { IssueBulkResult } from '@better-tracker/engine';
import {
  type BulkBarConfirm,
  type TaskSectionData,
  useToast,
} from '@better-tracker/ui';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';

import {
  issueListHref,
  type IssueListPageModel,
} from '../../../../lib/adapters/issue-list';
import {
  bulkConfirm,
  bulkResultToast,
  type FailureNote,
  failureNotes,
  type IssueChange,
  ISSUE_MOVE_MAX,
  leavesFilters,
  type MoveToastModel,
  notChangedIds,
  refusalRefreshes,
  type RowOverlay,
  rowOverlay,
  staleUndoToast,
  undoRequests,
  undoResultToast,
} from '../../../../lib/adapters/issue-moves';
import {
  type ApiResult,
  notSavedToast,
  patchIssues,
  sendJson,
} from '../../../../lib/api-client';
import { issueWriteOutcome } from '../../../../lib/issue-writes';

/** A media query's current answer (false on the server and in tests). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined' || !('matchMedia' in window)) {
        return () => {};
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== 'undefined' &&
      'matchMedia' in window &&
      window.matchMedia(query).matches,
    () => false
  );
}

/** A change waiting for the bulk bar's confirmation. */
interface PendingConfirm {
  issueIds: string[];
  change: IssueChange;
  text: { message: string; confirmLabel: string };
}

/** A row's change in flight: what it shows, and which send it belongs to. */
interface Overlay {
  overlay: RowOverlay;
  batch: number;
}

export interface IssueMovesInput {
  page: IssueListPageModel;
  /** The view the island shows (returnTo, "no longer match"). */
  query: IssueListQuery;
  viewerId: string;
  /** The pickers' options once fetched (names for the confirmation). */
  options: IssueListOptions | null;
}

export interface IssueMoves {
  selected: ReadonlySet<string>;
  /** The table's selection changes (a click, x, a range, pruning). */
  onSelectionChange: (next: ReadonlySet<string>) => void;
  clearSelection: () => void;
  /** Sends a change for these issues: at once, or through the bulk bar's
      confirmation when the rule asks for one (≥ 20, or a drag across
      projects). */
  send: (
    issueIds: readonly string[],
    change: IssueChange,
    options?: { drag?: boolean }
  ) => void;
  /** A cell's single edit (PATCH /api/issues/[id]): resolves once saved,
      rejects with the sentence the cell prints. */
  saveIssue: (issueId: string, patch: IssuePatch) => Promise<void>;
  /** The bulk bar's state. */
  bar: {
    busy: string | null;
    note: string | null;
    confirm: BulkBarConfirm | null;
  };
  /** A change is being sent (the bar's actions wait). */
  sending: boolean;
  /** The rows with their pending values and notes. */
  decorate: (sections: TaskSectionData[]) => TaskSectionData[];
  /** Rows waiting for a change (no cell pickers while pending). */
  pending: ReadonlySet<string>;
  /** Runs the newest Undo toast's Undo while it is up (the page's Z
      key); false when there is none. */
  undoLatest: () => boolean;
}

// What a screen reader hears for a move toast: "Project › Milestone" read
// as "Project, Milestone" ("›" is spoken as "right angle quote"), plus
// the keyboard way to Undo while the toast offers it.
function spokenToast(message: string, undo: boolean): string {
  const spoken = message.replace(/\s*›\s*/gu, ', ');
  return undo ? `${spoken} Press Z to undo.` : spoken;
}

/** Where keyboard focus was when a change was sent from inside a row
    (its "…" menu, a row key's picker, a cell picker): that row, the rows
    next to it at that moment (the ones moving left out) and its group. */
interface FocusOrigin {
  rowId: string;
  around: string[];
  groupId: string | null;
}

const ROW_SELECTOR = '[data-nav-item="row"][data-row-id]';

// A row's title (its link, or its button without an href), wherever the
// row now is.
function rowTitle(rowId: string): HTMLElement | null {
  const row = `[data-nav-item="row"][data-row-id="${CSS.escape(rowId)}"]`;
  return document.querySelector<HTMLElement>(
    `${row} [data-nav-target] > a, ${row} [data-nav-target] > button`
  );
}

/**
 * The row focus is in, and the rows around it, as a change is sent: a
 * move remounts the row under another group (or drops it from the view),
 * which takes focus with it to <body>. Null when focus is not in a row.
 */
function focusOrigin(moving: readonly string[]): FocusOrigin | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const row = active.closest<HTMLElement>(ROW_SELECTOR);
  const rowId = row?.getAttribute('data-row-id') ?? null;
  if (row === null || rowId === null) return null;
  const skip = new Set([...moving, rowId]);
  const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const at = rows.indexOf(row);
  const firstKept = (list: HTMLElement[]) =>
    list
      .map((el) => el.getAttribute('data-row-id'))
      .find((id): id is string => id !== null && !skip.has(id));
  const next = firstKept(rows.slice(at + 1));
  const previous = firstKept(rows.slice(0, Math.max(at, 0)).reverse());
  return {
    rowId,
    around: [next, previous].filter((id): id is string => id !== undefined),
    groupId:
      row
        .closest<HTMLElement>('[data-group-id]')
        ?.getAttribute('data-group-id') ?? null,
  };
}

/**
 * Once the refresh has placed the rows: when focus fell to <body> (the
 * row it was in remounted elsewhere or left), it goes to that row's title
 * where the row now is, else to the row that took its place (the next,
 * else the previous), else to its group's toggle. Focus a person moved on
 * to meanwhile is left alone.
 */
function restoreFocus(origin: FocusOrigin): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body && active.isConnected) {
    return;
  }
  for (const id of [origin.rowId, ...origin.around]) {
    const title = rowTitle(id);
    if (title !== null) {
      title.focus();
      return;
    }
  }
  if (origin.groupId === null) return;
  document
    .querySelector<HTMLElement>(
      `[data-group-id="${CSS.escape(origin.groupId)}"] [data-nav-item="group"] button[data-nav-target]`
    )
    ?.focus();
}

// The toast's action as a button.
function toastAction(
  model: MoveToastModel,
  handlers: { undo: () => void; select: () => void }
): { label: string; onClick: () => void } | undefined {
  if (model.action === 'undo') return { label: 'Undo', onClick: handlers.undo };
  if (model.action === 'select') {
    return { label: 'Select them', onClick: handlers.select };
  }
  return undefined;
}

/**
 * The Issues page's moves (architecture §8.4 "Issues", moving): the
 * selection, the rows' pending values, sending a bulk change, a drop or
 * Undo through PATCH /api/issues with the bulk bar's confirmation, the
 * result toasts, and a cell's single edit through PATCH /api/issues/[id].
 * Rows stay where they are while a change is in flight, hatched, with
 * "Moving to …" and the new value in their cells; the server places them
 * once the refresh started after the answer has rendered. Rows whose
 * change did not happen keep a "Not moved · …" note until the next
 * selection change or change.
 */
export function useIssueMoves({
  page,
  query,
  viewerId,
  options,
}: IssueMovesInput): IssueMoves {
  const router = useRouter();
  const { toast, dismiss } = useToast();
  const [refreshing, startRefresh] = useTransition();

  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [overlays, setOverlays] = useState<ReadonlyMap<string, Overlay>>(
    () => new Map()
  );
  const [notes, setNotes] = useState<ReadonlyMap<string, FailureNote>>(
    () => new Map()
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  // The latest inputs, for callbacks that outlive a render (an answer
  // arriving after the view changed, a toast's Undo).
  const latest = useRef({ page, query, options });
  useEffect(() => {
    latest.current = { page, query, options };
  }, [page, query, options]);

  // ---- refreshes ----------------------------------------------------------

  // Sends answered whose refresh has been asked for, and those whose
  // refresh is running: once it has rendered, their rows are placed by
  // the server and their overlays go.
  const batchSeq = useRef(0);
  const answered = useRef<number[]>([]);
  const refreshingBatches = useRef<number[]>([]);
  // Where focus was when an answered change was sent from a row, waiting
  // for its refresh like the batches (the latest one wins).
  const focusAsked = useRef<FocusOrigin | null>(null);
  const focusRefreshing = useRef<FocusOrigin | null>(null);
  useEffect(() => {
    if (refreshing) {
      refreshingBatches.current.push(...answered.current);
      answered.current = [];
      if (focusAsked.current !== null) {
        focusRefreshing.current = focusAsked.current;
        focusAsked.current = null;
      }
      return;
    }
    const origin = focusAsked.current ?? focusRefreshing.current;
    focusAsked.current = null;
    focusRefreshing.current = null;
    if (origin !== null) restoreFocus(origin);
    const done = new Set([...refreshingBatches.current, ...answered.current]);
    refreshingBatches.current = [];
    answered.current = [];
    if (done.size === 0) return;
    setOverlays((current) => {
      let next: Map<string, Overlay> | null = null;
      for (const [id, overlay] of current) {
        if (!done.has(overlay.batch)) continue;
        next ??= new Map(current);
        next.delete(id);
      }
      return next ?? current;
    });
  }, [refreshing]);

  const refreshAfter = useCallback(
    (batch: number | null, origin: FocusOrigin | null = null) => {
      if (batch !== null) answered.current.push(batch);
      if (origin !== null) focusAsked.current = origin;
      startRefresh(() => router.refresh());
    },
    [router]
  );

  const dropBatch = useCallback(
    (batch: number, keep: ReadonlySet<string> = new Set()) => {
      setOverlays((current) => {
        let next: Map<string, Overlay> | null = null;
        for (const [id, overlay] of current) {
          if (overlay.batch !== batch || keep.has(id)) continue;
          next ??= new Map(current);
          next.delete(id);
        }
        return next ?? current;
      });
    },
    []
  );

  // ---- selection ----------------------------------------------------------

  // The selection as last set (the table's changes are judged against it).
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const onSelectionChange = useCallback((next: ReadonlySet<string>) => {
    const current = selectedRef.current;
    // Pruning (rows that left the view) keeps the failure notes and a
    // waiting confirmation; a person's own change of the selection
    // clears both.
    const facts = latest.current.page.rowFacts;
    const pruned =
      next.size < current.size &&
      [...next].every((id) => current.has(id)) &&
      [...current].every((id) => next.has(id) || facts[id] === undefined);
    if (!pruned) {
      setNotes((was) => (was.size === 0 ? was : new Map()));
      setConfirm(null);
    }
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const clearSelection = useCallback(() => {
    setConfirm(null);
    setSelected((current) => (current.size === 0 ? current : new Set()));
    setNotes((was) => (was.size === 0 ? was : new Map()));
  }, []);

  // ---- sending ------------------------------------------------------------

  const returnTo = useCallback(() => issueListHref(latest.current.query), []);

  // The newest toast that offers Undo, while it is up: Z runs it (the
  // toast closes after 8 seconds, often before Tab could reach it).
  const latestUndo = useRef<{ id: string; run: () => void } | null>(null);

  const showToast = useCallback(
    (
      model: MoveToastModel,
      handlers: { undo: () => void; select: () => void }
    ) => {
      const undoable = model.action === 'undo';
      // The id is known once toast() returns; onClose runs later.
      const shown = { id: '' };
      shown.id = toast({
        kind: model.kind,
        label: model.label,
        message: model.message,
        announce: spokenToast(model.message, undoable),
        action: toastAction(model, handlers),
        duration: model.duration,
        onClose: () => {
          if (latestUndo.current?.id === shown.id) latestUndo.current = null;
        },
      });
      if (undoable) latestUndo.current = { id: shown.id, run: handlers.undo };
    },
    [toast]
  );

  const undoLatest = useCallback((): boolean => {
    const latest = latestUndo.current;
    if (latest === null) return false;
    latestUndo.current = null;
    dismiss(latest.id);
    latest.run();
    return true;
  }, [dismiss]);

  const refused = useCallback(
    (answer: Extract<ApiResult<unknown>, { ok: false }>) => {
      toast(
        notSavedToast(answer, (href) => {
          window.location.assign(href);
        })
      );
    },
    [toast]
  );

  // Selects the rows a result did not change that are still shown.
  const selectNotChanged = useCallback((result: IssueBulkResult) => {
    const facts = latest.current.page.rowFacts;
    const ids = notChangedIds(result).filter((id) => facts[id] !== undefined);
    setConfirm(null);
    setSelected(new Set(ids));
  }, []);

  // Undo: the inverse changes, grouped by where the issues were, one
  // request after another; an ordinary audited edit.
  const undo = useCallback(
    async (result: IssueBulkResult, change: IssueChange) => {
      const requests = undoRequests(result, change.patch);
      const requested = requests.reduce((n, r) => n + r.issueIds.length, 0);
      if (requested === 0) return;
      const batch = (batchSeq.current += 1);
      // Z pressed on the moved row: focus follows it back.
      const origin = focusOrigin(requests.flatMap((r) => r.issueIds));
      setOverlays((current) => {
        const next = new Map(current);
        for (const request of requests) {
          for (const id of request.issueIds) {
            next.set(id, { overlay: { values: {}, note: 'Undoing…' }, batch });
          }
        }
        return next;
      });
      const results: IssueBulkResult[] = [];
      let refusal: Extract<ApiResult<unknown>, { ok: false }> | null = null;
      for (const request of requests) {
        const answer = await patchIssues({ ...request, returnTo: returnTo() });
        if (!answer.ok) {
          refusal = answer;
          break;
        }
        results.push(answer.data.result);
      }
      if (refusal !== null && !refusalRefreshes(refusal.code)) {
        // A tab left on another workspace: no refresh (it would show that
        // workspace here) and the "Undoing…" rows back as they were. The
        // refusal's toast with Reload, or, when earlier requests went
        // through, one that says how many were undone and to switch back
        // to this tab's workspace to see them (staleUndoToast).
        dropBatch(batch);
        const stale = staleUndoToast(results, requested, refusal);
        if (stale === null) {
          refused(refusal);
          return;
        }
        toast({
          kind: stale.kind,
          label: stale.label,
          message: stale.message,
          duration: stale.duration,
          action: { label: 'Reload', onClick: () => window.location.reload() },
        });
        return;
      }
      refreshAfter(batch, origin);
      const model = undoResultToast(
        results,
        requested,
        refusal?.message ?? null
      );
      toast({
        kind: model.kind,
        label: model.label,
        message: model.message,
        duration: model.duration,
      });
    },
    [dropBatch, refreshAfter, refused, returnTo, toast]
  );

  const commit = useCallback(
    async (issueIds: readonly string[], change: IssueChange) => {
      const batch = (batchSeq.current += 1);
      const origin = focusOrigin(issueIds);
      const overlay = rowOverlay(change);
      setNotes((was) => (was.size === 0 ? was : new Map()));
      setOverlays((current) => {
        const next = new Map(current);
        for (const id of issueIds) next.set(id, { overlay, batch });
        return next;
      });
      const n = issueIds.length;
      const noun = n === 1 ? 'issue' : 'issues';
      setBusy(
        change.patch.move !== undefined
          ? `Moving ${n} ${noun}…`
          : `Changing ${n} ${noun}…`
      );
      const answer = await patchIssues({
        issueIds,
        patch: change.patch,
        returnTo: returnTo(),
      });
      setBusy(null);
      if (!answer.ok) {
        dropBatch(batch);
        refused(answer);
        // A stale view refreshes, but never a tab left on another
        // workspace (issueWriteOutcome says why): its toast offers Reload.
        if (
          refusalRefreshes(answer.code) &&
          (answer.status === 404 || answer.status === 409)
        ) {
          refreshAfter(null);
        }
        return;
      }
      const result = answer.data.result;
      const changed = new Set(
        result.outcomes
          .filter((o) => o.status === 'changed')
          .map((o) => o.issueId)
      );
      // Unchanged, skipped and failed rows are back at once; changed ones
      // wait for the refresh that places them.
      dropBatch(batch, changed);
      setNotes(failureNotes(result, change));
      if (changed.size > 0) refreshAfter(batch, origin);
      else dropBatch(batch);
      const { page: now, query: shown, options: known } = latest.current;
      let left = 0;
      for (const id of changed) {
        const facts = now.rowFacts[id];
        if (
          facts !== undefined &&
          leavesFilters(shown, facts, change.patch, {
            viewerId,
            homeInitiative: (projectId) => {
              const project = known?.projects.find((p) => p.id === projectId);
              return project === undefined
                ? undefined
                : project.homeInitiativeId;
            },
          })
        ) {
          left += 1;
        }
      }
      showToast(bulkResultToast(result, change, { leftView: left }), {
        undo: () => void undo(result, change),
        select: () => selectNotChanged(result),
      });
    },
    [
      dropBatch,
      refreshAfter,
      refused,
      returnTo,
      selectNotChanged,
      showToast,
      undo,
      viewerId,
    ]
  );

  const send = useCallback(
    (
      ids: readonly string[],
      change: IssueChange,
      sendOptions: { drag?: boolean } = {}
    ) => {
      const issueIds = [...new Set(ids)];
      if (issueIds.length === 0) return;
      if (issueIds.length > ISSUE_MOVE_MAX) {
        toast({
          kind: 'error',
          label: 'Not sent',
          message: `At most ${ISSUE_MOVE_MAX} issues at a time (${issueIds.length} chosen).`,
        });
        return;
      }
      const { page: now, options: known } = latest.current;
      const text = bulkConfirm({
        change,
        issueIds,
        facts: now.rowFacts,
        drag: sendOptions.drag === true,
        names: {
          project: (id) =>
            now.projectNames[id] ??
            known?.projects.find((p) => p.id === id)?.name,
          projectTeamIds: (id) =>
            known?.projects.find((p) => p.id === id)?.teamIds,
          team: (id) => known?.teams.find((t) => t.id === id)?.name,
        },
      });
      if (text === null) {
        void commit(issueIds, change);
        return;
      }
      // The confirmation lives in the bulk bar, which shows the issues it
      // is about as the selection.
      setSelected((current) =>
        current.size === issueIds.length &&
        issueIds.every((id) => current.has(id))
          ? current
          : new Set(issueIds)
      );
      setConfirm({ issueIds, change, text });
    },
    [commit, toast]
  );

  // ---- a cell's single edit -----------------------------------------------

  const saveIssue = useCallback(
    async (issueId: string, patch: IssuePatch) => {
      // A cell's milestone, status or assignee can move the row to
      // another group: focus comes back to it there.
      const origin = focusOrigin([issueId]);
      const answer = await sendJson(
        'PATCH',
        `/api/issues/${encodeURIComponent(issueId)}`,
        patch
      );
      const outcome = issueWriteOutcome('patch', answer);
      if (outcome.kind !== 'failed' || outcome.refresh) {
        refreshAfter(null, answer.ok ? origin : null);
      }
      if (answer.ok) return;
      refused(answer);
      throw new Error(answer.message);
    },
    [refreshAfter, refused]
  );

  // ---- what the list shows ------------------------------------------------

  const decorate = useCallback(
    (sections: TaskSectionData[]): TaskSectionData[] => {
      if (overlays.size === 0 && notes.size === 0) return sections;
      return sections.map((section) => ({
        ...section,
        groups: section.groups.map((group) => ({
          ...group,
          rows: group.rows.map((row) => {
            const pending = overlays.get(row.id);
            if (pending !== undefined) {
              return {
                ...row,
                ...pending.overlay.values,
                pending: true,
                note: { text: pending.overlay.note },
              };
            }
            // "Not moved · …" / "Not saved · …" in red, failed or skipped.
            const note = notes.get(row.id);
            return note === undefined ? row : { ...row, note };
          }),
        })),
      }));
    },
    [overlays, notes]
  );

  const pending = useMemo(() => new Set(overlays.keys()), [overlays]);

  const count = selected.size;
  const confirmProps: BulkBarConfirm | null =
    confirm === null
      ? null
      : {
          message: confirm.text.message,
          confirmLabel: confirm.text.confirmLabel,
          onConfirm: () => {
            const { issueIds, change } = confirm;
            setConfirm(null);
            void commit(issueIds, change);
          },
          onCancel: () => setConfirm(null),
        };

  return {
    selected,
    onSelectionChange,
    clearSelection,
    send,
    saveIssue,
    bar: {
      busy,
      note:
        count > ISSUE_MOVE_MAX
          ? `At most ${ISSUE_MOVE_MAX} at a time (${count} selected).`
          : null,
      confirm: confirmProps,
    },
    sending: busy !== null,
    decorate,
    pending,
    undoLatest,
  };
}
