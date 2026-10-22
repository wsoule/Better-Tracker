'use client';

import {
  AlertStrip,
  Button,
  Checklist,
  Link,
  ProgressRule,
  type PropertyListItem,
  PropertyList,
  SkeletonText,
  SlideOver,
  StateGlyph,
  StatusMark,
  useToast,
} from '@better-tracker/ui';
import { ArrowUpRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  type FormEvent,
  type MouseEvent,
  type RefObject,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react';

import type {
  DrawerIssue,
  MilestoneDrawerModel,
} from '../../../lib/adapters/timeline';
import { notSavedToast, sendJson } from '../../../lib/api-client';
import { formatDate } from '../../../lib/format';
import type { IssueDrawerParts } from '../components/issue-drawer';
import css from './page.module.css';

interface MilestoneDrawerProps {
  open: boolean;
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

/**
 * PATCHes one change, toasts the outcome and refreshes the server data.
 * `busy` names the field being saved so its button can say so.
 */
function useSave(): {
  busy: string | null;
  save: (
    field: string,
    url: string,
    body: unknown,
    success: string
  ) => Promise<boolean>;
} {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const save = useCallback(
    async (field: string, url: string, body: unknown, success: string) => {
      setBusy(field);
      const result = await sendJson('PATCH', url, body);
      setBusy(null);
      if (!result.ok) {
        toast(notSavedToast(result, (href) => window.location.assign(href)));
        return false;
      }
      toast({ kind: 'info', label: 'Saved', message: success });
      router.refresh();
      return true;
    },
    [router, toast]
  );
  return { busy, save };
}

/* The milestone slide-over (architecture §8.3): PROJECT / MILESTONE crumb
   with Open in Linear and Copy link, the overdue strip, the property list
   (weight and "done means…" editable by everyone, date and lead with
   Linear write access), the rubric checklist, the issues with
   their blockers, and what the milestone waits on. While the server loads
   a newly clicked milestone the panel is already open with a skeleton. */
export default function MilestoneDrawer({
  open,
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
  const dateRef = useRef<HTMLInputElement>(null);

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
      >
        {issue.body}
      </SlideOver>
    );
  }
  return (
    <SlideOver
      open={open}
      onClose={onClose}
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
            >
              Open in Linear
            </Button>
            <Button size="sm" variant="quiet" onClick={() => void copyLink()}>
              Copy link
            </Button>
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
  dateRef: RefObject<HTMLInputElement | null>;
  hrefFor: (milestoneId: string) => string;
  onOpenIssue?: (key: string) => void;
  issueHref?: (key: string) => string;
}) {
  const { busy, save } = useSave();
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
            <span className={model.muted ? css.note : css.reasons}>
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
          key={model.due.value ?? 'none'}
          value={model.due.value}
          label={model.due.label}
          tone={model.due.tone}
          inputRef={dateRef}
          busy={busy === 'due'}
          onSave={(next) =>
            save(
              'due',
              milestoneUrl,
              { targetDate: next },
              next === null
                ? `${model.title} has no target date now.`
                : `${model.title} is now due ${formatDate(next, model.today)}.`
            )
          }
        />
      ) : (
        <span className={model.due.tone === 'accent' ? css.accent : undefined}>
          {model.due.label}
        </span>
      ),
    },
    {
      id: 'lead',
      label: 'Lead',
      value: permissions.canEditLinear ? (
        <LeadField
          key={model.lead.id ?? 'none'}
          model={model}
          busy={busy === 'lead'}
          onSave={(leadId, name) =>
            save(
              'lead',
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
      value: (
        <WeightField
          key={String(model.weight.value)}
          model={model}
          busy={busy === 'weight'}
          onSave={(weight) =>
            save(
              'weight',
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
            <span
              className={
                model.next.tone === 'accent' ? css.accentNote : css.note
              }
            >
              {model.next.note}
            </span>
          </span>
        ),
    },
    {
      id: 'done',
      label: 'Done means…',
      value: (
        <DoneMeansField
          key={model.doneMeans.plannerText}
          model={model}
          busy={busy === 'done'}
          onSave={(text) =>
            save(
              'done',
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
            action={
              permissions.canEditLinear
                ? {
                    label: 'Reschedule',
                    onClick: () => {
                      dateRef.current?.focus();
                      dateRef.current?.scrollIntoView({ block: 'nearest' });
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
      {permissions.grantWriteHref === null ? (
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

      <h3 className={css.subhead}>Checklist</h3>
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
      <p className={css.graphLink}>
        <Link href={model.graphHref} className="accentLink">
          Open the dependency graph
        </Link>
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
    (§8.5), its ↗ the issue in Linear. `quiet` (an inactive project, §2.8)
    keeps "Unassigned" and "Blocked by" out of the accent: nothing there is
    allocated or warned about while the project is paused. */
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
            className={
              issue.assignee === null && issue.open && !quiet
                ? css.accent
                : undefined
            }
          >
            {issue.assignee ?? 'Unassigned'}
          </span>
          {issue.blockedBy.length > 0 ? (
            <span className={quiet ? undefined : css.accent}>
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
          <ArrowUpRight size={13} strokeWidth={1.5} aria-hidden="true" />
        </a>
      ) : null}
    </li>
  );
}

function LeadText({ model }: { model: MilestoneDrawerModel }) {
  if (model.lead.name === null) {
    return <span className={css.accentMono}>No lead</span>;
  }
  return (
    <span className={css.stack}>
      <span>{model.lead.name}</span>
      {model.lead.note === null ? null : (
        <span className={css.accentNote}>{model.lead.note}</span>
      )}
    </span>
  );
}

function DueDateField({
  value,
  label,
  tone,
  inputRef,
  busy,
  onSave,
}: {
  value: string | null;
  label: string;
  tone: 'default' | 'muted' | 'accent';
  inputRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  onSave: (next: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const next = draft === '' ? null : draft;
  const unchanged = next === value;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!unchanged && !busy) void onSave(next);
  }
  return (
    <form className={css.field} onSubmit={submit} noValidate>
      <span className={css.fieldRow}>
        <input
          ref={inputRef}
          type="date"
          className={`input ${css.dateInput}`}
          aria-label="Due date"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={unchanged || busy}>
          {busy
            ? 'Saving'
            : next === null && value !== null
              ? 'Clear date'
              : 'Save'}
        </Button>
      </span>
      <span className={tone === 'accent' ? css.accentNote : css.note}>
        {label}
      </span>
    </form>
  );
}

function LeadField({
  model,
  busy,
  onSave,
}: {
  model: MilestoneDrawerModel;
  busy: boolean;
  onSave: (leadId: string | null, name: string) => Promise<boolean>;
}) {
  const current = model.lead.id ?? '';
  const [draft, setDraft] = useState(current);
  const selectId = useId();
  const unchanged = draft === current;
  const name =
    model.leadOptions.find((option) => option.id === draft)?.label ?? '';
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!unchanged && !busy) void onSave(draft === '' ? null : draft, name);
  }
  return (
    <form className={css.field} onSubmit={submit}>
      <span className={css.fieldRow}>
        <label className="srOnly" htmlFor={selectId}>
          Project lead
        </label>
        <select
          id={selectId}
          className={`select ${css.leadSelect} ${current === '' ? css.selectAccent : ''}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        >
          <option value="">No lead</option>
          {model.leadOptions.map((option) => (
            <option
              key={option.id}
              value={option.id}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
        <Button size="sm" type="submit" disabled={unchanged || busy}>
          {busy ? 'Saving' : 'Save'}
        </Button>
      </span>
      <span
        className={
          current === '' || model.lead.note !== null ? css.accentNote : css.note
        }
      >
        {current === ''
          ? 'No lead: nothing in this project is allocated.'
          : (model.lead.note ?? `Project lead of ${model.projectName}`)}
      </span>
    </form>
  );
}

function WeightField({
  model,
  busy,
  onSave,
}: {
  model: MilestoneDrawerModel;
  busy: boolean;
  onSave: (weight: number | null) => Promise<boolean>;
}) {
  const { toast } = useToast();
  const current = model.weight.value;
  const [draft, setDraft] = useState(current === null ? '' : String(current));
  const inputId = useId();
  const trimmed = draft.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const unchanged = parsed === current;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (unchanged || busy) return;
    if (parsed !== null && Number.isNaN(parsed)) {
      toast({
        kind: 'error',
        label: 'Not saved',
        message: 'Weight must be a number, or empty for date order.',
      });
      return;
    }
    // Range and whole-number rules are the route's (its message is what
    // the toast says), so the browser's own validation is off.
    void onSave(parsed);
  }
  return (
    <form className={css.field} onSubmit={submit} noValidate>
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
          className={`input ${css.weightInput}`}
          placeholder="None"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={unchanged || busy}>
          {busy ? 'Saving' : 'Save'}
        </Button>
        {current === null ? null : (
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={() => void onSave(null)}
          >
            Clear
          </Button>
        )}
      </span>
      <span className={css.note}>
        Weight changes display order only, never which milestone is next.
      </span>
    </form>
  );
}

function DoneMeansField({
  model,
  busy,
  onSave,
}: {
  model: MilestoneDrawerModel;
  busy: boolean;
  onSave: (text: string | null) => Promise<boolean>;
}) {
  const current = model.doneMeans.plannerText;
  const [draft, setDraft] = useState(current);
  const areaId = useId();
  const count = characterCount(draft.trim());
  const max = model.limits.doneMeansMax;
  const over = count > max;
  const unchanged = draft.trim() === current.trim();
  const fromLinear =
    model.doneMeans.sourceLabel !== null && current === ''
      ? model.doneMeans.text
      : null;
  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (unchanged || busy || over) return;
    const text = draft.trim();
    void onSave(text === '' ? null : text);
  }
  return (
    <form className={css.field} onSubmit={submit}>
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
        className={`textarea ${css.doneArea}`}
        rows={2}
        value={draft}
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
            submit();
          }
        }}
      />
      <span className={css.fieldRow}>
        <Button size="sm" type="submit" disabled={unchanged || busy || over}>
          {busy
            ? 'Saving'
            : draft.trim() === '' && current !== ''
              ? 'Clear'
              : 'Save'}
        </Button>
        <span className={over ? css.accentNote : css.note} aria-live="polite">
          {count}/{max}
          {model.doneMeans.sourceLabel === 'Written in the planner'
            ? ' · written in the planner'
            : ''}
        </span>
      </span>
    </form>
  );
}
