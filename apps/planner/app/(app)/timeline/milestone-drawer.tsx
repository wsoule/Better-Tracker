'use client';

import {
  AlertStrip,
  Button,
  Checklist,
  isCompleteDate,
  Link,
  type PickerOption,
  PickerPopover,
  ProgressRule,
  type PropertyListItem,
  PropertyList,
  SkeletonText,
  SlideOver,
  StateGlyph,
  StatusMark,
  type UiTone,
  useSaveControl,
  useToast,
} from '@better-tracker/ui';
import { ArrowUpRight, Calendar, Link2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  DrawerIssue,
  MilestoneDrawerModel,
} from '../../../lib/adapters/timeline';
import { notSavedToast, sendJson } from '../../../lib/api-client';
import { escapeResetsDraft } from '../../../lib/escape';
import { formatDate } from '../../../lib/format';
import type { IssueDrawerParts } from '../components/issue-drawer';
import ReadOnlyNotice from '../components/read-only-notice';
import css from './page.module.css';

interface MilestoneDrawerProps {
  open: boolean;
  /** The milestone the URL asks for (?milestone=), loaded or not. */
  milestoneId: string | null;
  /** A milestone was requested and its details are still on the way. */
  loading: boolean;
  model: MilestoneDrawerModel | null;
  /** Shown in the header while loading (from the bar that was clicked). */
  fallbackTitle: string;
  fallbackCrumb: string;
  /** The timeline URL that opens another milestone, keeping the filters. */
  hrefFor: (milestoneId: string) => string;
  onClose: () => void;
  /** An issue opened from here (§8.5): drawn in this same panel in place
      of the milestone, with its own title, crumb ("Back to …") and
      actions. */
  issue?: IssueDrawerParts | null;
  /** Opens one of the milestone's issues in place (?issue=<key>). */
  onOpenIssue?: (key: string) => void;
  /** The URL that opens an issue here (for new tabs and copied links). */
  issueHref?: (key: string) => string;
}

// Line breaks of any kind, including the Unicode line and paragraph
// separators (Zl, Zp), which the engine refuses in "done means…" too.
const LINE_BREAKS = /[\r\n\p{Zl}\p{Zp}]+/gu;

/** Counts what the person typed as characters (an emoji counts once), as
    the engine does for the "done means…" limit. */
function characterCount(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text)).length;
  }
  return Array.from(text).length;
}

/** Printed when a rejected save carries no message. */
const SAVE_FAILED = 'Could not save.';

/** A rejected save's sentence, for the line beside the field. */
function formatError(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : SAVE_FAILED;
}

/** What a field's save calls: the PATCH, its body and the toast's words. */
type Write = (url: string, body: unknown, success: string) => Promise<void>;

/**
 * Saves one change of the drawer the moment a field commits it (no Save
 * buttons): PATCHes it, then confirms it with a "Saved" toast and
 * refreshes the server data; or toasts why not (with "Allow edits" when
 * the person's Linear token may not write) and rejects with that message,
 * so the field rolls back and prints it beside itself (the edit family's
 * save contract, useSaveControl).
 */
function useWrite(): Write {
  const router = useRouter();
  const { toast } = useToast();
  return useCallback(
    async (url: string, body: unknown, success: string) => {
      const result = await sendJson('PATCH', url, body);
      if (!result.ok) {
        toast(notSavedToast(result, (href) => window.location.assign(href)));
        throw new Error(result.message);
      }
      toast({ kind: 'info', label: 'Saved', message: success });
      router.refresh();
    },
    [router, toast]
  );
}

/** "Saving" beside a value while its save runs (the live region below
    says it; this one is drawing). */
function PendingNote({ pending }: { pending: boolean }) {
  return pending ? (
    <span className={css.pending} aria-hidden="true">
      Saving
    </span>
  ) : null;
}

/** A field's save status: the polite "Saving <field>" announcement, and a
    rejected save's red "Not saved" line (an alert) under the field. */
function SaveStatus({
  field,
  pending,
  error,
}: {
  field: string;
  pending: boolean;
  error: string | null;
}) {
  return (
    <>
      <span className="srOnly" role="status">
        {pending ? `Saving ${field}` : ''}
      </span>
      {error === null ? null : (
        <span className={css.saveError} role="alert">
          <span className={css.saveErrorKey}>Not saved</span>
          <span className={css.saveErrorText}>{error}</span>
        </span>
      )}
    </>
  );
}

/* The milestone slide-over (architecture §8.3): Project / Milestone crumb
   with Open in Linear and Copy link as ghost icon buttons beside the
   close (the issue drawer's header pattern), the overdue alert, the
   property list in Gr8r's form (values that commit as they change, no
   Save buttons: the due date and lead as value pills with Linear write
   access, the weight and "done means…" for everyone but a guest), the
   rubric checklist, the issues with their blockers, and what the
   milestone waits on. While the server loads a newly clicked milestone
   the panel is already open with a skeleton. */
export default function MilestoneDrawer({
  open,
  milestoneId,
  loading,
  model,
  fallbackTitle,
  fallbackCrumb,
  hrefFor,
  onClose,
  issue,
  onOpenIssue,
  issueHref,
}: MilestoneDrawerProps) {
  const { toast } = useToast();
  const dateRef = useRef<HTMLButtonElement>(null);

  const copyLink = useCallback(async () => {
    if (model === null) return;
    const url = new URL(model.path, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      toast({
        kind: 'info',
        label: 'Copied',
        message: 'Link to this milestone copied.',
      });
    } catch {
      toast({
        kind: 'error',
        label: 'Copy',
        message: `Could not copy the link. It is ${url}`,
      });
    }
  }, [model, toast]);

  const ready = !loading && model !== null;
  if (issue !== undefined && issue !== null) {
    // The same panel, showing the issue: no second slide-in.
    return (
      <SlideOver
        open={open}
        onClose={onClose}
        title={issue.title}
        breadcrumb={issue.breadcrumb}
        actions={issue.actions}
        closeLabel={issue.closeLabel}
        contentKey={issue.contentKey}
      >
        {issue.body}
      </SlideOver>
    );
  }
  return (
    <SlideOver
      open={open}
      onClose={onClose}
      contentKey={`milestone:${milestoneId ?? ''}`}
      title={ready ? model.title : fallbackTitle}
      breadcrumb={
        ready
          ? model.breadcrumb
          : fallbackCrumb === ''
            ? 'Milestone'
            : `${fallbackCrumb} / ${fallbackTitle}`
      }
      closeLabel="Close milestone"
      actions={
        ready ? (
          <>
            <Button
              size="sm"
              variant="quiet"
              href={model.linearUrl}
              external
              title="Open the project in Linear"
              aria-label="Open the project in Linear (opens in a new tab)"
              icon={<ArrowUpRight size={14} strokeWidth={1.8} />}
            />
            <Button
              size="sm"
              variant="quiet"
              title="Copy a link to this milestone"
              aria-label="Copy a link to this milestone"
              icon={<Link2 size={14} strokeWidth={1.8} />}
              onClick={() => void copyLink()}
            />
          </>
        ) : null
      }
    >
      {ready ? (
        <DrawerBody
          key={model.milestoneId}
          model={model}
          dateRef={dateRef}
          hrefFor={hrefFor}
          onOpenIssue={onOpenIssue}
          issueHref={issueHref}
        />
      ) : (
        <div className={css.drawerLoading}>
          <SkeletonText lines={6} label="Loading the milestone" />
        </div>
      )}
    </SlideOver>
  );
}

function DrawerBody({
  model,
  dateRef,
  hrefFor,
  onOpenIssue,
  issueHref,
}: {
  model: MilestoneDrawerModel;
  dateRef: RefObject<HTMLButtonElement | null>;
  hrefFor: (milestoneId: string) => string;
  onOpenIssue?: (key: string) => void;
  issueHref?: (key: string) => string;
}) {
  const write = useWrite();
  const { permissions } = model;
  const milestoneUrl = `/api/milestones/${encodeURIComponent(model.milestoneId)}`;
  const projectUrl = `/api/projects/${encodeURIComponent(model.projectId)}`;

  const items: PropertyListItem[] = [
    {
      id: 'status',
      label: 'Status',
      value: (
        <span className={css.stack}>
          <StatusMark
            status={model.status.status}
            label={model.status.label}
            showLabel
            muted={model.muted}
          />
          {model.status.lines.length > 0 ? (
            // Risk reasons and the missing input: the warning tone, except
            // in an inactive project (never loud).
            <span
              className={css.note}
              data-tone={model.muted ? 'default' : 'warning'}
            >
              {model.status.lines.join(' · ')}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'due',
      label: 'Due date',
      value: permissions.canEditLinear ? (
        <DueDateField
          value={model.due.value}
          label={model.due.label}
          tone={model.due.tone}
          today={model.today}
          triggerRef={dateRef}
          onSave={(next) =>
            write(
              milestoneUrl,
              { targetDate: next },
              next === null
                ? `${model.title} has no target date now.`
                : `${model.title} is now due ${formatDate(next, model.today)}.`
            )
          }
        />
      ) : (
        <span className={css.toned} data-tone={model.due.tone}>
          {model.due.label}
        </span>
      ),
    },
    {
      id: 'lead',
      label: 'Lead',
      value: permissions.canEditLinear ? (
        <LeadField
          model={model}
          onSave={(leadId, name) =>
            write(
              projectUrl,
              { leadId },
              leadId === null
                ? `${model.projectName} has no lead now.`
                : `${name} now leads ${model.projectName}.`
            )
          }
        />
      ) : (
        <LeadText model={model} />
      ),
    },
    {
      id: 'progress',
      label: 'Progress',
      value: (
        <span className={css.progress}>
          <ProgressRule
            done={model.progress.done}
            total={model.progress.total}
            tone={model.progress.tone}
            label={
              model.progress.canceled > 0
                ? `${model.progress.done}/${model.progress.total} · ${model.progress.canceled} canceled`
                : undefined
            }
            aria-label={`${model.title} progress`}
          />
        </span>
      ),
    },
    {
      id: 'weight',
      label: 'Weight',
      // A Linear guest edits nothing (owner decision 2026-10-22).
      value: permissions.readOnly ? (
        model.weight.label
      ) : (
        <WeightField
          model={model}
          onSave={(weight) =>
            write(
              milestoneUrl,
              { weight },
              weight === null
                ? `${model.title} is back in date order.`
                : `${model.title} has weight ${weight} now.`
            )
          }
        />
      ),
    },
    {
      id: 'next',
      label: 'Next milestone',
      value:
        model.next.note === null ? (
          model.next.value
        ) : (
          <span className={css.stack}>
            <span>{model.next.value}</span>
            <span className={css.note} data-tone={model.next.tone}>
              {model.next.note}
            </span>
          </span>
        ),
    },
    {
      id: 'done',
      label: 'Done means…',
      value: permissions.readOnly ? (
        <DoneMeansText model={model} />
      ) : (
        <DoneMeansField
          model={model}
          onSave={(text) =>
            write(
              milestoneUrl,
              { doneMeans: text },
              text === null
                ? `"Done means…" for ${model.title} is cleared.`
                : `"Done means…" for ${model.title} is saved.`
            )
          }
        />
      ),
    },
  ];

  return (
    <>
      {model.overdueText === null ? null : (
        <div className={css.alert}>
          <AlertStrip
            label="Overdue"
            tone="danger"
            action={
              permissions.canEditLinear
                ? {
                    label: 'Reschedule',
                    // Focuses the due-date pill and opens its calendar
                    // (still inside this click's user activation).
                    onClick: () => {
                      dateRef.current?.focus();
                      dateRef.current?.scrollIntoView({ block: 'nearest' });
                      dateRef.current?.click();
                    },
                  }
                : undefined
            }
          >
            {model.overdueText}
          </AlertStrip>
        </div>
      )}

      <PropertyList label="Milestone details" items={items} />
      {permissions.readOnly ? (
        <div className={css.readOnlyNote}>
          <ReadOnlyNotice />
        </div>
      ) : permissions.grantWriteHref === null ? (
        <p className={css.editNote}>
          Due date and lead changes are written to Linear as you. Weight and
          “done means…” are kept in the planner.
        </p>
      ) : (
        <p className={css.editNote}>
          Weight and “done means…” are kept in the planner. Due date and lead
          are written to Linear as you, so they need Linear write access:{' '}
          {/* A plain anchor: the OAuth start must never be prefetched. */}
          <a className={css.editLink} href={permissions.grantWriteHref}>
            Allow edits in Linear
          </a>
          .
        </p>
      )}

      <h3 className={css.subhead}>
        Checklist
        <span className={css.subheadMeta}>
          {model.rubric.filter((item) => item.met).length}/{model.rubric.length}{' '}
          met
        </span>
      </h3>
      <Checklist label="Milestone rubric" items={model.rubric} />

      <h3 className={css.subhead}>
        Issues
        <span className={css.subheadMeta}>
          {model.openIssues} open · {model.issues.length} total
        </span>
      </h3>
      {model.issues.length === 0 ? (
        <p className={`empty ${css.drawerEmpty}`}>
          No issues in this milestone yet
        </p>
      ) : (
        <ul className={css.issues} aria-label="Issues in this milestone">
          {model.issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              quiet={model.muted}
              onOpen={onOpenIssue}
              href={issueHref?.(issue.key)}
            />
          ))}
        </ul>
      )}

      <h3 className={css.subhead}>What does this wait on?</h3>
      {model.waitsOn.length === 0 ? (
        <p className={css.para}>
          Nothing: no open issue here is blocked by an open issue in another
          milestone.
        </p>
      ) : (
        <ul className={css.waits}>
          {model.waitsOn.map((other) => (
            <li key={other.id}>
              <Link href={hrefFor(other.id)} className={css.waitLink}>
                {other.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {/* "What it waits on" (when it waits on something) selects this
          milestone on a milestone graph; "Its issues" draws its issues. */}
      <p className={css.graphLink}>
        {model.graphLinks.map((link) => (
          <Link key={link.label} href={link.href} className="accentLink">
            {link.label}
          </Link>
        ))}
      </p>
    </>
  );
}

/** A plain primary click (no modifier, no middle button): the only click
    the in-place opener takes over; the others keep the link's new tab. */
function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** One issue of the milestone: the row opens the issue in this panel
    (§8.5), its ↗ the issue in Linear. "Unassigned" (open) and "Blocked by"
    are in the warning tone; `quiet` (an inactive project, §2.8) keeps them
    neutral: nothing there is allocated or warned about while the project
    is paused. */
function IssueRow({
  issue,
  quiet,
  onOpen,
  href,
}: {
  issue: DrawerIssue;
  quiet: boolean;
  onOpen?: (key: string) => void;
  href?: string;
}) {
  const inApp = href !== undefined;
  return (
    <li className={css.issueItem}>
      <Link
        className={`${css.issue} ${issue.open ? '' : css.issueClosed}`}
        href={href ?? issue.url}
        target={inApp ? undefined : '_blank'}
        rel={inApp ? undefined : 'noreferrer noopener'}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (onOpen === undefined || !isPlainClick(event)) return;
          event.preventDefault();
          onOpen(issue.key);
        }}
      >
        <span className={css.issueKey}>{issue.key}</span>
        <span className={css.issueTitle}>
          {issue.title}
          {inApp ? null : (
            <span className="srOnly"> (opens Linear in a new tab)</span>
          )}
        </span>
        <span className={css.issueMeta}>
          <span className={css.issueState}>
            <StateGlyph kind={issue.stateKind} size={12} />
            {issue.state}
          </span>
          <span
            className={css.toned}
            data-tone={
              issue.assignee === null && issue.open && !quiet
                ? 'warning'
                : 'default'
            }
          >
            {issue.assignee ?? 'Unassigned'}
          </span>
          {issue.blockedBy.length > 0 ? (
            <span
              className={css.toned}
              data-tone={quiet ? 'default' : 'warning'}
            >
              Blocked by {issue.blockedBy.join(', ')}
            </span>
          ) : null}
        </span>
      </Link>
      {inApp ? (
        <a
          className={css.issueOut}
          href={issue.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open ${issue.key} in Linear`}
          title={`Open ${issue.key} in Linear`}
        >
          <ArrowUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
        </a>
      ) : null}
    </li>
  );
}

// The lead as plain text: "No lead" and a deactivated lead's note in the
// warning tone (allocation is blocked, §8.2); quiet in an inactive project.
function LeadText({ model }: { model: MilestoneDrawerModel }) {
  const tone = model.muted ? 'default' : 'warning';
  if (model.lead.name === null) {
    return (
      <span className={css.toned} data-tone={tone}>
        No lead
      </span>
    );
  }
  return (
    <span className={css.stack}>
      <span>{model.lead.name}</span>
      {model.lead.note === null ? null : (
        <span className={css.note} data-tone={tone}>
          {model.lead.note}
        </span>
      )}
    </span>
  );
}

/* The due date as a Gr8r value pill: a 13px calendar icon and the date
   ("Oct 18 · 3 days overdue") in its tone, which opens the browser's own
   calendar (showPicker) on a native date field kept out of sight under
   the pill. A pick saves after a short pause (the calendar's arrow keys
   may move the field's value through several days on the way), confirmed
   by a toast; the calendar's Clear, or the X beside the pill, removes the
   date. Where showPicker is missing the field itself appears in the pill's
   place: a complete date saves on Enter or when the field is left, Esc
   puts the pill back. */
function DueDateField({
  value,
  label,
  tone,
  today,
  triggerRef,
  onSave,
}: {
  value: string | null;
  /** The server's wording of `value` ("Oct 18 · 3 days overdue"). */
  label: string;
  tone: UiTone;
  today: string;
  /** The pill (the overdue alert's Reschedule focuses and opens it). */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSave: (next: string | null) => Promise<void>;
}) {
  const control = useSaveControl(value, onSave, formatError, SAVE_FAILED);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The fallback: the native field shown in the pill's place.
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const shown = control.shown;

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  function commit(text: string): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (text === '') {
      if (shown !== null) void control.save(null);
      return;
    }
    if (isCompleteDate(text) && text !== shown) void control.save(text);
  }

  function open(): void {
    const input = inputRef.current;
    if (input === null) return;
    control.clearError();
    input.value = shown ?? '';
    setDraft(shown ?? '');
    try {
      input.showPicker();
      return;
    } catch {
      // No showPicker here (or it refused): show the field instead.
    }
    setTyping(true);
  }

  function onInput(text: string): void {
    setDraft(text);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    // Typing in the visible field saves on Enter or leaving it; a pick in
    // the calendar saves after the pause.
    if (!typing && (text === '' || isCompleteDate(text))) {
      timer.current = setTimeout(() => commit(text), 700);
    }
  }

  function closeField(refocus: boolean): void {
    setTyping(false);
    if (refocus) {
      // The pill comes back on the next render; focus it then.
      setTimeout(() => triggerRef.current?.focus(), 0);
    }
  }

  // While a save runs, or after one before the server's wording arrives,
  // the pill says the new date plainly.
  const face =
    shown === value
      ? label
      : shown === null
        ? 'No target date'
        : formatDate(shown, today);
  const faceTone = shown === value ? tone : 'default';

  return (
    <span className={css.field}>
      <span className={css.fieldRow}>
        <span className={css.datePill}>
          {typing ? null : (
            <button
              ref={triggerRef}
              type="button"
              className={css.valuePill}
              aria-label={`Due date: ${face}. Change`}
              aria-haspopup="dialog"
              data-pending={control.pending ? 'true' : undefined}
              onClick={open}
            >
              <Calendar
                className={css.pillIcon}
                size={13}
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className={css.toned} data-tone={faceTone}>
                {face}
              </span>
            </button>
          )}
          <input
            ref={inputRef}
            type="date"
            className={typing ? css.dateField : css.dateNative}
            aria-label="Due date"
            aria-hidden={typing ? undefined : 'true'}
            tabIndex={typing ? undefined : -1}
            value={draft}
            onChange={(event) => onInput(event.target.value)}
            onKeyDown={(event) => {
              if (!typing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(draft);
                closeField(true);
              } else if (event.key === 'Escape') {
                // Handled here: the drawer stays open.
                event.preventDefault();
                closeField(true);
              }
            }}
            onBlur={() => {
              if (!typing) return;
              commit(draft);
              closeField(false);
            }}
          />
        </span>
        {shown !== null && !typing ? (
          <button
            type="button"
            className={css.pillClear}
            aria-label="Clear the due date"
            title="Clear the due date"
            onClick={() => commit('')}
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
        <PendingNote pending={control.pending} />
      </span>
      <SaveStatus
        field="Due date"
        pending={control.pending}
        error={control.error}
      />
    </span>
  );
}

/* The project's lead as a Gr8r value pill (PickerPopover): the active
   people with their avatars, "No lead" first. A pick saves at once (the
   picker shows it pending, and rolls back with the reason beside it if
   Linear refuses), confirmed by a toast. "No lead", or a lead Linear has
   deactivated, stops allocation: the warning tone (§8.2), quiet in an
   inactive project. */
function LeadField({
  model,
  onSave,
}: {
  model: MilestoneDrawerModel;
  onSave: (leadId: string | null, name: string) => Promise<void>;
}) {
  const current = model.lead.id;
  const options = useMemo<PickerOption[]>(
    () =>
      model.leadOptions.map((option) => ({
        value: option.id,
        label: option.label,
        disabled: option.disabled,
        mark: { kind: 'avatar', name: option.label },
      })),
    [model.leadOptions]
  );
  const loud = !model.muted;
  const tone =
    loud && (current === null || model.lead.note !== null)
      ? 'warning'
      : 'default';
  return (
    <span className={css.field}>
      <PickerPopover
        label="Project lead"
        options={options}
        value={current}
        valueLabel={model.lead.name ?? undefined}
        placeholder="No lead"
        placeholderTone={loud ? 'warning' : 'muted'}
        noneLabel="No lead"
        noneMark={{ kind: 'avatar', name: '' }}
        searchPlaceholder="Set the lead…"
        formatError={formatError}
        onChange={(leadId) =>
          onSave(
            leadId,
            options.find((option) => option.value === leadId)?.label ?? ''
          )
        }
      />
      <span className={css.note} data-tone={tone}>
        {current === null
          ? 'No lead: nothing in this project is allocated.'
          : (model.lead.note ?? `Project lead of ${model.projectName}`)}
      </span>
    </span>
  );
}

// "Done means…" as plain text, for a person who may not edit it: the text
// and where it comes from, or that it is missing.
function DoneMeansText({ model }: { model: MilestoneDrawerModel }) {
  if (model.doneMeans.text === null) {
    return (
      <span
        className={css.toned}
        data-tone={model.muted ? 'default' : 'warning'}
      >
        Not set
      </span>
    );
  }
  return (
    <span className={css.stack}>
      <span>{model.doneMeans.text}</span>
      {model.doneMeans.sourceLabel === null ? null : (
        <span className={css.note}>{model.doneMeans.sourceLabel}</span>
      )}
    </span>
  );
}

/** The weight field's text for a weight (empty for none). */
function weightText(weight: number | null): string {
  return weight === null ? '' : String(weight);
}

/* The weight as a value pill: a number field that reads as its value
   ("None" when empty) and shows its edge on hover and focus. A change
   saves on Enter or when the field is left (empty puts the milestone back
   in date order), confirmed by a toast; Esc with unsaved text puts the
   saved weight back and keeps the drawer open (the next Esc closes it).
   Range and whole-number rules are the route's (its message is printed),
   so the browser's own validation is off; text the field cannot read as a
   number is refused here, never saved as "empty". */
function WeightField({
  model,
  onSave,
}: {
  model: MilestoneDrawerModel;
  onSave: (weight: number | null) => Promise<void>;
}) {
  const current = model.weight.value;
  const control = useSaveControl(current, onSave, formatError, SAVE_FAILED);
  const [draft, setDraft] = useState(weightText(current));
  const [unreadable, setUnreadable] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const inputId = useId();
  const shown = control.shown;
  // Follow the saved value (a save, a rollback, the server's refresh)
  // while nothing unsaved is typed.
  const [synced, setSynced] = useState(shown);
  if (synced !== shown) {
    setSynced(shown);
    setDraft(weightText(shown));
  }
  const trimmed = draft.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const dirty = unreadable || parsed !== shown;

  function commit(): void {
    if (!dirty) return;
    if (unreadable || (parsed !== null && Number.isNaN(parsed))) {
      setInvalid('Weight must be a whole number, or empty for date order.');
      return;
    }
    setInvalid(null);
    void control.save(parsed);
  }

  function reset(): void {
    setDraft(weightText(shown));
    setUnreadable(false);
    setInvalid(null);
    control.clearError();
  }

  return (
    <span className={css.field}>
      <span className={css.fieldRow}>
        <label className="srOnly" htmlFor={inputId}>
          Weight override
        </label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          step={1}
          min={model.limits.weightMin}
          max={model.limits.weightMax}
          className={css.weightInput}
          placeholder="None"
          value={draft}
          aria-invalid={
            invalid !== null || control.error !== null ? 'true' : undefined
          }
          data-pending={control.pending ? 'true' : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setUnreadable(event.target.validity.badInput);
            if (invalid !== null) setInvalid(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
              return;
            }
            escapeResetsDraft(event, dirty, reset);
          }}
          onBlur={commit}
        />
        <PendingNote pending={control.pending} />
      </span>
      <SaveStatus
        field="Weight"
        pending={control.pending}
        error={invalid ?? control.error}
      />
      <span className={css.note}>
        Weight changes display order only, never which milestone is next.
      </span>
    </span>
  );
}

/* "Done means…" as Gr8r's borderless text box (its edge shows on hover
   and focus): one line of up to the engine's limit (line breaks become
   spaces, Enter saves), saved when the field is left or on Enter and
   confirmed by a toast; emptied, it clears the planner's text. Esc with
   unsaved text puts the saved text back and keeps the drawer open. The
   count and the save status sit under it; over the limit nothing is
   saved and the count turns red. */
function DoneMeansField({
  model,
  onSave,
}: {
  model: MilestoneDrawerModel;
  onSave: (text: string | null) => Promise<void>;
}) {
  const saved = model.doneMeans.plannerText;
  const control = useSaveControl<string | null>(
    saved === '' ? null : saved,
    onSave,
    formatError,
    SAVE_FAILED
  );
  const current = control.shown ?? '';
  const [draft, setDraft] = useState(current);
  const [synced, setSynced] = useState(current);
  if (synced !== current) {
    setSynced(current);
    setDraft(current);
  }
  const areaId = useId();
  const count = characterCount(draft.trim());
  const max = model.limits.doneMeansMax;
  const over = count > max;
  const dirty = draft.trim() !== current.trim();
  const fromLinear =
    model.doneMeans.sourceLabel !== null && current === ''
      ? model.doneMeans.text
      : null;

  function commit(): void {
    if (!dirty || over) return;
    const text = draft.trim();
    void control.save(text === '' ? null : text);
  }

  return (
    <span className={css.field}>
      {fromLinear === null ? null : (
        <span className={css.stack}>
          <span>{fromLinear}</span>
          <span className={css.note}>
            From the Linear description. Write one here to override it.
          </span>
        </span>
      )}
      <label className="srOnly" htmlFor={areaId}>
        Done means…
      </label>
      <textarea
        id={areaId}
        className={css.doneArea}
        rows={1}
        value={draft}
        aria-invalid={over || control.error !== null ? 'true' : undefined}
        data-pending={control.pending ? 'true' : undefined}
        placeholder={
          fromLinear === null
            ? 'One line: what is true when this milestone is done'
            : 'Override the Linear description'
        }
        // One line only (the engine refuses line breaks): Enter saves.
        onChange={(event) =>
          setDraft(event.target.value.replace(LINE_BREAKS, ' '))
        }
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          escapeResetsDraft(event, dirty, () => {
            setDraft(current);
            control.clearError();
          });
        }}
        onBlur={commit}
      />
      <span className={css.fieldRow}>
        <span
          className={css.note}
          data-tone={over ? 'danger' : 'default'}
          aria-live="polite"
        >
          {count}/{max}
          {over ? ' · too long to save' : ''}
          {!over && model.doneMeans.sourceLabel === 'Written in the planner'
            ? ' · written in the planner'
            : ''}
        </span>
        <PendingNote pending={control.pending} />
      </span>
      <SaveStatus
        field="Done means…"
        pending={control.pending}
        error={control.error}
      />
    </span>
  );
}
