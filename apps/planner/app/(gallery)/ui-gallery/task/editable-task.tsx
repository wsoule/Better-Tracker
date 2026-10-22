'use client';

import {
  AssigneePicker,
  Button,
  DateField,
  EstimatePicker,
  InlineTextField,
  LabelPicker,
  MilestonePicker,
  PickerPopover,
  PriorityPicker,
  ProjectPicker,
  StatePicker,
  type TaskActivityItem,
  type TaskComment,
  TaskDescription,
  TaskDetail,
  type TaskDetailProps,
  type TaskPriority,
  TaskPropertyValue,
  type TaskRelation,
  TaskRelationPicker,
  type TaskSearchResult,
  TaskSlideOver,
  TextAreaEditor,
  useToast,
} from '@better-tracker/ui';
import { type ReactNode, useState } from 'react';

import {
  COMMENTS,
  ESTIMATES,
  LABELS,
  ME,
  MILESTONES,
  PEOPLE,
  PROJECTS,
  SEARCHABLE,
  searchTasks,
  STATES,
} from './edit-fixtures';
import { linearUrl } from './fixtures';
import css from './page.module.css';

// The editable variant of /ui-gallery/task: the real edit controls of
// @better-tracker/ui wired to fake saves. Every save waits SAVE_MS, then
// lands in this component's state (and the activity), except the estimate,
// which always fails so the rollback can be seen.

const SAVE_MS = 600;

/** A save that settles after SAVE_MS: applies the change, or rejects. */
function fakeSave(apply: () => void, failWith?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (failWith !== undefined) {
        reject(new Error(failWith));
        return;
      }
      apply();
      resolve();
    }, SAVE_MS);
  });
}

const ESTIMATE_FAILURE =
  'Linear refused the change: the estimate always fails in this demo, to show the rollback.';

function stateById(id: string) {
  return STATES.find((state) => state.id === id) ?? STATES[1];
}

function relationFor(task: TaskSearchResult): TaskRelation {
  return {
    id: task.id,
    taskKey: task.taskKey,
    title: task.title,
    href: linearUrl(task.taskKey),
    state: task.state ?? { kind: 'unstarted', label: 'Todo' },
    context: task.group,
    resolved: task.state?.kind === 'completed',
  };
}

const INITIAL_DESCRIPTION = `Send search analytics events so we can tell whether Search v2 beats v1 before the beta opens.

- search_performed: query length, filters, result count, latency_ms
- result_clicked: position, result type, time since the search

Never log the raw query text; hash it with the workspace salt.`;

/**
 * The editable task's state and controls, as one TaskDetail prop set, so
 * the page layout and the drawer edit the same task.
 */
function useEditableTask(): Omit<
  TaskDetailProps,
  'layout' | 'header' | 'headingLevel'
> {
  const [title, setTitle] = useState('Search analytics events');
  const [stateId, setStateId] = useState('s-todo');
  const [assignee, setAssignee] = useState<string | null>('u-ana');
  const [priority, setPriority] = useState<TaskPriority>(3);
  const [labels, setLabels] = useState<string[]>([
    'l-feature',
    'l-search',
    'l-m',
  ]);
  const [project, setProject] = useState<string | null>('p-beacon');
  const [milestone, setMilestone] = useState<string | null>('m-beta');
  const [estimate] = useState<number | null>(2);
  const [due, setDue] = useState<string | null>('2026-10-23');
  const [description, setDescription] = useState(INITIAL_DESCRIPTION);
  const [blockedBy, setBlockedBy] = useState<TaskSearchResult[]>(() =>
    SEARCHABLE.filter((task) => task.id === 'i-23' || task.id === 'i-12')
  );
  const [blocks, setBlocks] = useState<TaskSearchResult[]>(() =>
    SEARCHABLE.filter((task) => task.id === 'i-25')
  );
  const [comments, setComments] = useState<TaskComment[]>(COMMENTS);
  const [activity, setActivity] = useState<TaskActivityItem[]>([
    {
      id: 'assigned',
      at: 'Oct 12',
      dateTime: '2026-10-12',
      label: 'Assigned to Ana Moreno by the planner',
      detail: 'Daily run: she leads Beacon search and had the most room.',
    },
    {
      id: 'created',
      at: 'Oct 9',
      dateTime: '2026-10-09',
      label: 'Created in Linear by Dev Patel',
      tone: 'muted',
    },
  ]);

  /** Records an edit the way Linear's history would credit it. */
  function logged(what: string): void {
    setActivity((items) => [
      {
        id: `edit-${Date.now()}-${items.length}`,
        at: 'Just now',
        label: (
          <>
            <strong>You</strong> {what}
          </>
        ),
        detail: 'Saved to Linear with your own token.',
      },
      ...items,
    ]);
  }

  const state = stateById(stateId);
  const linked = new Set([
    'i-24',
    ...blockedBy.map((task) => task.id),
    ...blocks.map((task) => task.id),
  ]);

  const unlink = (list: 'blockedBy' | 'blocks', task: TaskSearchResult) => () =>
    fakeSave(() => {
      const set = list === 'blockedBy' ? setBlockedBy : setBlocks;
      set((items) => items.filter((item) => item.id !== task.id));
      logged(
        `removed ${task.taskKey} from ${list === 'blockedBy' ? 'blocked by' : 'blocks'}`
      );
    });

  return {
    taskKey: 'ENG-24',
    title,
    titleControl: (
      <InlineTextField
        label="Title"
        value={title}
        maxLength={255}
        onSave={(next) =>
          fakeSave(() => {
            setTitle(next);
            logged('renamed the task');
          })
        }
      />
    ),
    href: linearUrl('ENG-24'),
    breadcrumb: [
      { label: 'Beacon search', href: '/timeline?project=proj-beacon' },
      { label: 'ENG-24' },
    ],
    status: {
      kind: state.kind,
      label: state.name,
      control: (
        <StatePicker
          states={STATES}
          value={stateId}
          onChange={(next) =>
            fakeSave(() => {
              setStateId(next);
              logged(`moved it to ${stateById(next).name}`);
            })
          }
        />
      ),
    },
    properties: [
      {
        id: 'assignee',
        label: 'Assignee',
        value: (
          <AssigneePicker
            people={PEOPLE}
            meId={ME.id}
            value={assignee}
            onChange={(next) =>
              fakeSave(() => {
                setAssignee(next);
                const name = PEOPLE.find((p) => p.id === next)?.name;
                logged(
                  name === undefined
                    ? 'unassigned it'
                    : `assigned it to ${name}`
                );
              })
            }
          />
        ),
      },
      {
        id: 'priority',
        label: 'Priority',
        value: (
          <PriorityPicker
            value={priority}
            onChange={(next) =>
              fakeSave(() => {
                setPriority(next);
                logged('changed the priority');
              })
            }
          />
        ),
      },
      {
        id: 'labels',
        label: 'Labels',
        value: (
          <LabelPicker
            labelOptions={LABELS}
            value={labels}
            onChange={(next) =>
              fakeSave(() => {
                setLabels(next);
                logged('changed the labels');
              })
            }
          />
        ),
      },
      {
        id: 'project',
        label: 'Project',
        value: (
          <ProjectPicker
            projects={PROJECTS}
            value={project}
            onChange={(next) =>
              fakeSave(() => {
                setProject(next);
                // Linear clears the milestone when the project changes.
                if (next !== project) setMilestone(null);
                logged('moved it to another project');
              })
            }
          />
        ),
      },
      {
        id: 'milestone',
        label: 'Milestone',
        value: (
          <MilestonePicker
            milestones={project === null ? [] : (MILESTONES[project] ?? [])}
            value={milestone}
            disabled={project === null}
            emptyLabel="This project has no milestones"
            onChange={(next) =>
              fakeSave(() => {
                setMilestone(next);
                logged('changed the milestone');
              })
            }
          />
        ),
      },
      {
        id: 'estimate',
        label: 'Estimate',
        value: (
          <TaskPropertyValue note="Always fails here, to show the rollback">
            <EstimatePicker
              estimates={ESTIMATES}
              value={estimate}
              onChange={() => fakeSave(() => undefined, ESTIMATE_FAILURE)}
            />
          </TaskPropertyValue>
        ),
      },
      {
        id: 'due',
        label: 'Due date',
        value: (
          <DateField
            label="Due date"
            value={due}
            onChange={(next) =>
              fakeSave(() => {
                setDue(next);
                logged(
                  next === null
                    ? 'cleared the due date'
                    : 'changed the due date'
                );
              })
            }
          />
        ),
      },
    ],
    description: {
      text: null,
      content: (
        <TextAreaEditor
          label="Description"
          value={description}
          maxLength={4000}
          emptyLabel="No description"
          placeholder="Add a description (markdown)…"
          view={(text) => (
            // The read view keeps the clamp and its Show more.
            <TaskDescription text={text} clampLines={8} />
          )}
          onSave={(next) =>
            fakeSave(() => {
              setDescription(next);
              logged('edited the description');
            })
          }
        />
      ),
      sourceLabel: 'Markdown source · saved to Linear',
    },
    relations: {
      blockedBy: blockedBy.map((task) => ({
        ...relationFor(task),
        onRemove: unlink('blockedBy', task),
      })),
      blocks: blocks.map((task) => ({
        ...relationFor(task),
        onRemove: unlink('blocks', task),
      })),
    },
    sectionMeta: {
      blockedBy: (
        <TaskRelationPicker
          label="Add blocked by"
          search={searchTasks}
          exclude={[...linked]}
          onSelect={(task) =>
            fakeSave(() => {
              setBlockedBy((items) => [...items, task]);
              logged(`marked it blocked by ${task.taskKey}`);
            })
          }
        />
      ),
      blocks: (
        <TaskRelationPicker
          label="Add blocks"
          search={searchTasks}
          exclude={[...linked]}
          onSelect={(task) =>
            fakeSave(() => {
              setBlocks((items) => [...items, task]);
              logged(`marked it as blocking ${task.taskKey}`);
            })
          }
        />
      ),
      comments: 'From Linear',
    },
    comments: {
      items: comments,
      composer: (
        <TextAreaEditor
          mode="compose"
          label="New comment"
          placeholder="Leave a comment… (markdown)"
          maxLength={2000}
          onSave={(body) =>
            fakeSave(() => {
              setComments((items) => [
                ...items,
                {
                  id: `c-${items.length + 1}`,
                  author: ME.name,
                  at: 'Just now',
                  body,
                },
              ]);
            })
          }
        />
      ),
    },
    activity,
  };
}

/** Block 04: the editable task in the page layout, and the same task in
    the drawer (its open state is the gallery's, so only one drawer is
    ever open). */
export function EditableTaskDemo({
  headerActions,
  drawer,
  setDrawer,
}: {
  headerActions: (taskKey: string) => ReactNode;
  drawer: boolean;
  setDrawer: (open: boolean) => void;
}) {
  const task = useEditableTask();
  return (
    <>
      <div className={css.controls}>
        <Button
          variant={drawer ? 'primary' : 'secondary'}
          size="sm"
          aria-expanded={drawer}
          onClick={() => setDrawer(!drawer)}
        >
          {drawer ? 'Close the drawer' : 'Edit in the drawer'}
        </Button>
        <span className={css.inlineNote}>
          Signed in as {ME.name} · every save waits {SAVE_MS} ms · the estimate
          always fails
        </span>
      </div>
      <div className={css.pageSlot}>
        <TaskDetail
          {...task}
          layout="page"
          headingLevel={3}
          activityLimit={4}
          headerActions={headerActions(task.taskKey)}
        />
      </div>
      <TaskSlideOver
        {...task}
        open={drawer}
        onClose={() => setDrawer(false)}
        activityLimit={4}
        headerActions={headerActions(task.taskKey)}
      />
    </>
  );
}

/** One labelled cell of the edit-controls section. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className={css.cell}>
      <p className={css.stateLabel}>{label}</p>
      <div className={css.cellBody}>{children}</div>
    </li>
  );
}

/** Each control on its own, in the states the editable task does not
    reach (loading and failed options, no access, a near-full editor). */
export function EditControlsDemo() {
  const { toast } = useToast();
  const [retryPhase, setRetryPhase] = useState<'error' | 'loading' | 'ready'>(
    'error'
  );
  const [owner, setOwner] = useState<string | null>(null);
  const [note, setNote] = useState(
    'Search now forgives one typo per word, logs both the typed and the corrected query, and samples analytics at 100% for the 40 beta workspaces. Ranking v2 ships next week; tell us which results feel off.'
  );
  const [plain, setPlain] = useState('A field outside any heading');
  const [due, setDue] = useState<string | null>('2026-11-06');

  return (
    <ul className={css.cells}>
      <Cell label="Options loading">
        <PickerPopover
          label="Reviewer"
          options={[]}
          loading
          value={null}
          placeholder="No reviewer"
          noneLabel="No reviewer"
          onChange={() => undefined}
        />
      </Cell>
      <Cell label="Options failed · Retry">
        <PickerPopover
          label="Owner"
          options={
            retryPhase === 'ready'
              ? PEOPLE.map((person) => ({
                  value: person.id,
                  label: person.name,
                  mark: { kind: 'avatar', name: person.name },
                }))
              : []
          }
          loading={retryPhase === 'loading'}
          error={
            retryPhase === 'error' ? 'Linear did not answer in time.' : null
          }
          onRetry={() => {
            setRetryPhase('loading');
            setTimeout(() => setRetryPhase('ready'), 900);
          }}
          value={owner}
          placeholder="No owner"
          onChange={(next) => fakeSave(() => setOwner(next))}
        />
      </Cell>
      <Cell label="No write access · disabled">
        <AssigneePicker
          people={PEOPLE}
          value="u-dev"
          disabled
          onChange={() => undefined}
        />
      </Cell>
      <Cell label="Relation search · 2 characters first">
        <TaskRelationPicker
          label="Add related task"
          search={searchTasks}
          minQueryLength={2}
          hintLabel="Type a key or two letters of a title"
          onSelect={(task) =>
            fakeSave(() =>
              toast({
                kind: 'info',
                label: 'Linked',
                message: `${task.taskKey} would be linked.`,
              })
            )
          }
        />
      </Cell>
      <Cell label="Inline text · outside a heading">
        <InlineTextField
          label="Summary"
          value={plain}
          onSave={(next) => fakeSave(() => setPlain(next))}
        />
      </Cell>
      <Cell label="Date · always fails">
        <DateField
          label="Start date"
          value={due}
          onChange={(next) =>
            fakeSave(
              () => setDue(next),
              'Linear refused the date (this one always fails).'
            )
          }
        />
      </Cell>
      <Cell label="Editor near its limit · 240">
        <TextAreaEditor
          label="Release note"
          value={note}
          maxLength={240}
          rows={4}
          onSave={(next) => fakeSave(() => setNote(next))}
        />
      </Cell>
      <Cell label="Pill trigger · the status line">
        <StatePicker
          states={STATES}
          value="s-review"
          onChange={() => undefined}
        />
      </Cell>
    </ul>
  );
}
