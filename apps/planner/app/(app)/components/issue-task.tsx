'use client';

import type { IssuePatch } from '@better-tracker/core';
import {
  AssigneePicker,
  Button,
  DateField,
  EstimatePicker,
  InlineTextField,
  LabelPicker,
  MilestonePicker,
  Notice,
  PickerMarkView,
  PriorityGlyph,
  PriorityPicker,
  ProjectPicker,
  type PropertyListItem,
  StatePicker,
  StatusMark,
  TaskDescription,
  type TaskDetailProps,
  TaskDetailSection,
  TaskPropertyValue,
  type TaskRelation,
  TaskRelationPicker,
  type TaskSearchResult,
  TextAreaEditor,
  useToast,
} from '@better-tracker/ui';
import {
  ArrowUpRight,
  Calendar,
  Folder,
  Hourglass,
  Link2,
  Maximize2,
  Milestone,
  Network,
  SignalHigh,
  Tag,
  Timer,
  User,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useMemo } from 'react';

import type {
  IssueEditModel,
  IssueFact,
  IssueRelationModel,
  IssueSearchHit,
  IssueTaskModel,
} from '../../../lib/adapters/issue';
import { type ApiResult, getJson, sendJson } from '../../../lib/api-client';
import {
  type IssueWriteKind,
  issueWriteOutcome,
} from '../../../lib/issue-writes';
import css from './issue-task.module.css';
import ReadOnlyNotice from './read-only-notice';

// The issue's task view, shared by /issues/[id] (page layout) and the
// ?issue= slide-over on My week, the timeline and the graph (architecture
// §8.5). lib/adapters/issue.ts decided every word and option on the
// server; this file adds what needs the browser: the edit controls of
// @better-tracker/ui wired to the issue routes. Every save is optimistic
// in the control itself (pending, kept, or rolled back with "Not saved"
// beside it); a failure is also toasted (with "Allow edits" when the
// person's Linear token may not write), and a success refreshes the
// server data, so the page shows what Linear now holds.

/** The TaskDetail props of an issue, minus what the container decides. */
export type IssueTaskProps = Omit<
  TaskDetailProps,
  'layout' | 'header' | 'headingLevel'
>;

/** How relation rows open another issue. */
export interface IssueTaskNav {
  /** Opens another issue in place (the slide-over swaps). Without it, a
      row is a plain link to that issue's page. */
  openIssue?: (key: string) => void;
}

/** The planner's own wording for the edit controls' error lines. */
function formatError(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'Linear did not take the change.';
}

/**
 * The issue's writes: each PATCHes or POSTs one change, toasts a failure
 * and rejects with its message (the control rolls back and prints it),
 * and refreshes the server data on success. A refusal whose goal already
 * holds (removing a relation that is gone, adding a blocker that already
 * blocks) is not a failure: lib/issue-writes.ts decides.
 */
export function useIssueWrites(issueId: string): {
  patch: (patch: IssuePatch) => Promise<void>;
  comment: (body: string) => Promise<void>;
  addBlocker: (issueId: string, blockerIssueId: string) => Promise<void>;
  removeRelation: (relationId: string) => Promise<void>;
  search: (
    query: string,
    signal: AbortSignal
  ) => Promise<readonly TaskSearchResult[]>;
} {
  const router = useRouter();
  const { toast } = useToast();

  const settle = useCallback(
    (write: IssueWriteKind, result: ApiResult<unknown>): void => {
      const outcome = issueWriteOutcome(write, result);
      // A success, a refusal whose goal already holds, or a refusal that
      // says this view is stale (the issue or relation is gone): show what
      // the server holds now.
      if (outcome.kind !== 'failed' || outcome.refresh) router.refresh();
      if (outcome.kind === 'already' && outcome.note !== null) {
        toast({ kind: 'info', label: 'Already linked', message: outcome.note });
      }
      if (result.ok || outcome.kind !== 'failed') return;
      const grant = result.grantWriteHref;
      toast({
        kind: 'error',
        label: 'Not saved',
        message: result.message,
        action:
          grant === undefined
            ? undefined
            : {
                label: 'Allow edits',
                onClick: () => window.location.assign(grant),
              },
        duration: grant === undefined ? undefined : 10_000,
      });
      throw new Error(result.message);
    },
    [router, toast]
  );

  const url = `/api/issues/${encodeURIComponent(issueId)}`;
  return useMemo(
    () => ({
      patch: async (patch: IssuePatch) =>
        settle('patch', await sendJson('PATCH', url, patch)),
      comment: async (body: string) =>
        settle('comment', await sendJson('POST', `${url}/comments`, { body })),
      addBlocker: async (blocked: string, blocker: string) =>
        settle(
          'addBlocker',
          await sendJson(
            'POST',
            `/api/issues/${encodeURIComponent(blocked)}/blockers`,
            { blockerIssueId: blocker }
          )
        ),
      removeRelation: async (relationId: string) =>
        settle(
          'removeRelation',
          await sendJson(
            'DELETE',
            `/api/relations/${encodeURIComponent(relationId)}`,
            null
          )
        ),
      search: async (query: string, signal: AbortSignal) => {
        const body = await getJson(
          `/api/issues/search?q=${encodeURIComponent(query)}&near=${encodeURIComponent(issueId)}`,
          signal
        );
        return searchResults(body);
      },
    }),
    [settle, url, issueId]
  );
}

/** The search route's hits as TaskRelationPicker results. */
function searchResults(body: unknown): TaskSearchResult[] {
  if (typeof body !== 'object' || body === null) return [];
  const raw = (body as { results?: unknown }).results;
  if (!Array.isArray(raw)) return [];
  return (raw as IssueSearchHit[]).map((hit) => ({
    id: hit.id,
    taskKey: hit.key,
    title: hit.title,
    state: { kind: hit.stateKind, label: hit.stateName },
    group: hit.group ?? 'No project',
  }));
}

/* The property sheet's label icons (Gr8r's .kv: 14px, drawn in the icon
   text step by the property list), one per property id. */
const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;
const PROPERTY_ICONS: Record<string, ReactNode> = {
  assignee: <User {...ICON} />,
  priority: <SignalHigh {...ICON} />,
  labels: <Tag {...ICON} />,
  estimate: <Timer {...ICON} />,
  due: <Calendar {...ICON} />,
  project: <Folder {...ICON} />,
  milestone: <Milestone {...ICON} />,
  'in-state': <Hourglass {...ICON} />,
};

/** A read-only label as its chip shows it: the name and Linear's colour. */
interface FactLabel {
  name: string;
  color?: string;
}

/** Read-only labels as Gr8r's label chips: a neutral chip with a small
    square in Linear's colour (PickerMarkView paints hex values only) and
    the name, the same chip LabelPicker draws. Keyed by position: two
    label groups may share a name. */
function LabelChips({ labels }: { labels: readonly FactLabel[] }): ReactNode {
  return (
    <span className={css.labels}>
      {labels.map((label, i) => (
        <span key={`${i}-${label.name}`} className={css.label}>
          <PickerMarkView mark={{ kind: 'swatch', color: label.color ?? '' }} />
          <span dir="auto">{label.name}</span>
        </span>
      ))}
    </span>
  );
}

/** The issue's labels as chips, from the live label ids and the team's
    label choices (colours); null when Linear could not be read or a label
    is not among the choices, so the fact's own words stand. */
function factLabels(edit: IssueEditModel): FactLabel[] | null {
  const ids = edit.values.live?.labelIds;
  if (ids === undefined || ids.length === 0) return null;
  const byId = new Map(edit.labels.map((label) => [label.id, label]));
  const labels: FactLabel[] = [];
  for (const id of ids) {
    const label = byId.get(id);
    if (label === undefined) return null;
    labels.push({ name: label.name, color: label.color });
  }
  return labels;
}

/** Whose round avatar leads the read-only assignee: the person's name
    (from the people list, else the fact's words without "(you)"), or ''
    for nobody (the dashed empty circle). */
function assigneeAvatar(edit: IssueEditModel, fact: IssueFact): string {
  const id = edit.values.assigneeId;
  if (id === null) return '';
  const person = edit.people.find((choice) => choice.id === id);
  return person?.name ?? fact.text.replace(/ \(you\)$/, '');
}

/**
 * A read-only property value, as the adapter worded it. `avatar` leads it
 * with the person's round avatar (a blank name: the dashed nobody circle);
 * `labels` draws label chips in place of the comma-separated names.
 */
function FactValue({
  fact,
  avatar,
  labels,
}: {
  fact: IssueFact;
  avatar?: string;
  labels?: readonly FactLabel[] | null;
}): ReactNode {
  if (labels !== undefined && labels !== null && labels.length > 0) {
    return (
      <TaskPropertyValue note={fact.note} noteTone={fact.noteTone}>
        <LabelChips labels={labels} />
      </TaskPropertyValue>
    );
  }
  return (
    <TaskPropertyValue
      tone={fact.tone}
      note={fact.note}
      noteTone={fact.noteTone}
      mono={fact.mono}
    >
      {avatar !== undefined ? (
        <PickerMarkView mark={{ kind: 'avatar', name: avatar }} />
      ) : null}
      {fact.glyph?.kind === 'priority' ? (
        <PriorityGlyph priority={fact.glyph.priority} size={14} />
      ) : null}
      {fact.glyph?.kind === 'status' ? (
        <StatusMark
          status={fact.glyph.status}
          label={fact.glyph.label}
          muted={fact.glyph.muted}
        />
      ) : null}
      {fact.text}
    </TaskPropertyValue>
  );
}

/** A control with the fact's note under it (the lead, the milestone's
    status line, why the planner gave it to this person). */
function Controlled({
  fact,
  children,
}: {
  fact: IssueFact;
  children: ReactNode;
}): ReactNode {
  return (
    <TaskPropertyValue note={fact.note} noteTone={fact.noteTone}>
      {children}
    </TaskPropertyValue>
  );
}

/**
 * Header actions: Linear (new tab), Copy link (the planner's page) and,
 * in the slide-over (`compact`), the page itself; there Copy link and Page
 * are icons, so the drawer's breadcrumb keeps its room.
 */
export function IssueHeaderActions({
  model,
  compact,
}: {
  model: IssueTaskModel;
  compact: boolean;
}): ReactNode {
  const { toast } = useToast();
  async function copy() {
    const url = new URL(model.pagePath, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      toast({
        kind: 'info',
        label: 'Copied',
        message: `Link to ${model.key} copied.`,
      });
    } catch {
      toast({
        kind: 'error',
        label: 'Copy',
        message: `Could not copy the link. It is ${url}`,
      });
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="quiet"
        href={model.linearUrl}
        external
        title={`Open ${model.key} in Linear`}
        iconAfter={<ArrowUpRight size={14} strokeWidth={1.8} />}
      >
        Linear
      </Button>
      <Button
        size="sm"
        variant="quiet"
        icon={<Link2 size={14} strokeWidth={1.8} />}
        title={`Copy a link to ${model.key}`}
        aria-label={compact ? `Copy a link to ${model.key}` : undefined}
        onClick={() => void copy()}
      >
        {compact ? null : 'Copy link'}
      </Button>
      {compact ? (
        <Button
          size="sm"
          variant="quiet"
          href={model.pagePath}
          title={`Open ${model.key} as a page`}
          aria-label={`Open ${model.key} as a page`}
          icon={<Maximize2 size={14} strokeWidth={1.8} />}
        />
      ) : null}
    </>
  );
}

/** The title editor (for people who may write): Enter saves, Esc cancels. */
export function IssueTitleField({
  model,
}: {
  model: IssueTaskModel;
}): ReactNode {
  const writes = useIssueWrites(model.issueId);
  return (
    <InlineTextField
      label="Title"
      value={model.edit.values.title}
      maxLength={model.edit.limits.title}
      onSave={(title) => writes.patch({ title })}
      formatError={formatError}
    />
  );
}

/**
 * The issue's TaskDetail props: read-only facts for everyone, the edit
 * controls when the person's Linear token may write (else one notice
 * offering the grant_write upgrade, or for a Linear guest the read-only
 * notice, since a guest is never offered it). Live fields (description, labels,
 * estimate, due date) stay read-only when Linear could not be read, since
 * an edit needs their current value.
 */
export function useIssueTaskProps(
  model: IssueTaskModel,
  nav: IssueTaskNav = {}
): IssueTaskProps {
  const writes = useIssueWrites(model.issueId);
  const { facts, edit, canEdit } = model;
  const { values } = edit;
  const live = values.live;
  const loud = !model.closed && !model.quiet;

  const relation = (
    row: IssueRelationModel,
    remove: boolean
  ): TaskRelation => ({
    id: row.relationId,
    taskKey: row.taskKey,
    title: row.title,
    href: `/issues/${encodeURIComponent(row.taskKey)}`,
    onOpen:
      nav.openIssue === undefined
        ? undefined
        : () => nav.openIssue?.(row.taskKey),
    state: row.state,
    assignee: row.assignee,
    context: row.context,
    external: row.external,
    resolved: row.resolved,
    onRemove: remove ? () => writes.removeRelation(row.relationId) : undefined,
  });

  const properties: PropertyListItem[] = canEdit
    ? [
        {
          id: 'assignee',
          label: 'Assignee',
          value: (
            <Controlled fact={facts.assignee}>
              <AssigneePicker
                people={edit.people}
                meId={model.viewerId}
                value={values.assigneeId}
                valueLabel={edit.assigneeLabel}
                placeholderTone={loud ? 'warning' : 'muted'}
                onChange={(assigneeId) => writes.patch({ assigneeId })}
                formatError={formatError}
              />
            </Controlled>
          ),
        },
        {
          id: 'priority',
          label: 'Priority',
          value: (
            <PriorityPicker
              value={values.priority}
              onChange={(priority) => writes.patch({ priority })}
              formatError={formatError}
            />
          ),
        },
        {
          id: 'labels',
          label: 'Labels',
          value:
            live === null ? (
              <FactValue fact={facts.labels} labels={factLabels(edit)} />
            ) : (
              <LabelPicker
                labelOptions={edit.labels}
                value={live.labelIds}
                onChange={(labelIds) => writes.patch({ labelIds })}
                formatError={formatError}
              />
            ),
        },
        {
          id: 'estimate',
          label: 'Estimate',
          value:
            live === null || edit.estimates === null ? (
              <FactValue fact={facts.estimate} />
            ) : (
              <EstimatePicker
                estimates={edit.estimates}
                value={live.estimate}
                onChange={(estimate) => writes.patch({ estimate })}
                formatError={formatError}
              />
            ),
        },
        {
          id: 'due',
          label: 'Due date',
          value:
            live === null ? (
              <FactValue fact={facts.dueDate} />
            ) : (
              <Controlled fact={facts.dueDate}>
                <DateField
                  label="Due date"
                  value={live.dueDate}
                  onChange={(dueDate) => writes.patch({ dueDate })}
                  formatError={formatError}
                />
              </Controlled>
            ),
        },
        {
          id: 'project',
          label: 'Project',
          value: (
            <Controlled fact={facts.project}>
              <ProjectPicker
                projects={edit.projects}
                value={values.projectId}
                valueLabel={edit.projectLabel}
                onChange={(projectId) => writes.patch({ projectId })}
                formatError={formatError}
              />
            </Controlled>
          ),
        },
        {
          id: 'milestone',
          label: 'Milestone',
          value: (
            <Controlled fact={facts.milestone}>
              <MilestonePicker
                milestones={
                  values.projectId === null
                    ? []
                    : (edit.milestones[values.projectId] ?? [])
                }
                value={values.milestoneId}
                valueLabel={edit.milestoneLabel}
                disabled={values.projectId === null}
                emptyLabel="This project has no milestones"
                onChange={(projectMilestoneId) =>
                  writes.patch({ projectMilestoneId })
                }
                formatError={formatError}
              />
            </Controlled>
          ),
        },
        {
          id: 'in-state',
          label: 'Time in state',
          value: <FactValue fact={facts.inState} />,
        },
      ]
    : [
        {
          id: 'assignee',
          label: 'Assignee',
          value: (
            <FactValue
              fact={facts.assignee}
              avatar={assigneeAvatar(edit, facts.assignee)}
            />
          ),
        },
        {
          id: 'priority',
          label: 'Priority',
          value: <FactValue fact={facts.priority} />,
        },
        {
          id: 'labels',
          label: 'Labels',
          value: <FactValue fact={facts.labels} labels={factLabels(edit)} />,
        },
        {
          id: 'estimate',
          label: 'Estimate',
          value: <FactValue fact={facts.estimate} />,
        },
        {
          id: 'due',
          label: 'Due date',
          value: <FactValue fact={facts.dueDate} />,
        },
        {
          id: 'project',
          label: 'Project',
          value: <FactValue fact={facts.project} />,
        },
        {
          id: 'milestone',
          label: 'Milestone',
          value: <FactValue fact={facts.milestone} />,
        },
        {
          id: 'in-state',
          label: 'Time in state',
          value: <FactValue fact={facts.inState} />,
        },
      ];

  const exclude = (rows: readonly IssueRelationModel[]): string[] => [
    model.issueId,
    ...rows.map((row) => row.issueId),
  ];

  // A Linear guest is never offered the write grant: one quiet read-only
  // notice instead (owner decision 2026-10-22).
  const rail = canEdit ? undefined : model.readOnly ? (
    <div className={css.notice}>
      <ReadOnlyNotice />
    </div>
  ) : (
    <div className={css.notice}>
      <Notice
        label="Read only"
        tone="default"
        action={
          // A plain anchor: the OAuth start must never be prefetched.
          <Button size="sm" href={model.grantWriteHref}>
            Allow edits in Linear
          </Button>
        }
      >
        You can read this issue. To change it here, allow the planner to edit
        Linear as you; Linear&apos;s own permissions still apply.
      </Notice>
    </div>
  );

  return {
    taskKey: model.key,
    title: model.title,
    titleControl: canEdit ? <IssueTitleField model={model} /> : undefined,
    href: model.linearUrl,
    breadcrumb: model.crumbs,
    status: {
      kind: model.status.kind,
      label: model.status.label,
      control:
        canEdit && edit.states.length > 0 ? (
          <StatePicker
            states={edit.states}
            value={values.stateId}
            onChange={(stateId) => writes.patch({ stateId })}
            formatError={formatError}
          />
        ) : undefined,
    },
    alerts: model.alerts,
    properties: properties.map((item) => ({
      ...item,
      icon: item.id === undefined ? undefined : PROPERTY_ICONS[item.id],
    })),
    rail,
    description:
      canEdit && live !== null
        ? {
            text: null,
            content: (
              <TextAreaEditor
                label="Description"
                value={live.description}
                maxLength={edit.limits.description}
                emptyLabel="No description"
                placeholder="Add a description (markdown)…"
                view={(text) => <TaskDescription text={text} />}
                onSave={(text) =>
                  writes.patch({
                    description: text.trim() === '' ? null : text,
                  })
                }
                formatError={formatError}
              />
            ),
            sourceLabel: 'Markdown source · saved to Linear as you',
          }
        : model.description,
    relations: {
      blockedBy: model.relations.blockedBy.map((row) => relation(row, canEdit)),
      blocks: model.relations.blocks.map((row) => relation(row, canEdit)),
    },
    sectionMeta: {
      blockedBy: relationMeta(
        model,
        'blockedBy',
        canEdit ? (
          <TaskRelationPicker
            label="Add blocked by"
            search={writes.search}
            exclude={exclude(model.relations.blockedBy)}
            searchPlaceholder="Issue this waits on…"
            onSelect={(task) => writes.addBlocker(model.issueId, task.id)}
            formatError={formatError}
          />
        ) : null
      ),
      blocks: relationMeta(
        model,
        'blocks',
        canEdit ? (
          <TaskRelationPicker
            label="Add blocks"
            search={writes.search}
            exclude={exclude(model.relations.blocks)}
            searchPlaceholder="Issue waiting on this…"
            onSelect={(task) => writes.addBlocker(task.id, model.issueId)}
            formatError={formatError}
          />
        ) : null
      ),
      comments: model.comments.note,
    },
    comments: {
      items: model.comments.items,
      error: model.comments.error,
      composer: canEdit ? (
        <TextAreaEditor
          mode="compose"
          label="New comment"
          placeholder="Leave a comment… (markdown)"
          maxLength={edit.limits.comment}
          onSave={(body) => writes.comment(body)}
          formatError={formatError}
        />
      ) : undefined,
    },
    activity: model.activity,
    activityLimit: 6,
    children:
      model.relations.hiddenNote === null ? undefined : (
        <TaskDetailSection title="Outside the planner">
          <p className={css.note}>{model.relations.hiddenNote}</p>
        </TaskDetailSection>
      ),
  };
}

/**
 * A relations heading's controls: the Graph link (a quiet button, like the
 * "+ Add" beside it) to the issue's blocking chain whenever it has a
 * relation (for everyone, guests too: the graph only reads), then the
 * "+ Add" picker for someone who may edit. The link
 * sits on "Blocked by", or on "Blocks" when nothing blocks the issue, so it
 * never stands over an empty "Nothing blocks this task." section.
 */
function relationMeta(
  model: IssueTaskModel,
  section: 'blockedBy' | 'blocks',
  picker: ReactNode
): ReactNode {
  const linkIn = model.relations.blockedBy.length > 0 ? 'blockedBy' : 'blocks';
  if (model.chainHref === null || section !== linkIn) {
    return picker ?? undefined;
  }
  return (
    <span className={css.sectionMeta}>
      <Button
        href={model.chainHref}
        variant="quiet"
        size="sm"
        icon={<Network size={14} strokeWidth={1.8} />}
        aria-label={`Blocking chain of ${model.key} as a graph`}
      >
        Graph
      </Button>
      {picker}
    </span>
  );
}
