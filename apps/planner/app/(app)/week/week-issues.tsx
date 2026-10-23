'use client';

import {
  type TaskColumnId,
  TaskGroupTable,
  type TaskSectionData,
} from '@better-tracker/ui';
import { useMemo } from 'react';

import {
  IssueDrawer,
  type IssueDrawerServer,
  useIssueDrawerState,
} from '../components/issue-drawer';

/* My week's issue list and its issue slide-over (architecture §8.4, §8.5):
   a row's title opens the issue in the drawer (?issue=<key>, so the open
   issue is linkable and survives a refresh), its ↗ icon opens it in
   Linear, and the open row keeps the accent tint. The server renders the
   drawer's issue from the URL; the drawer opens at once on a click with a
   skeleton until it arrives. */
export default function WeekIssues({
  sections,
  columns,
  label,
  emptyMessage,
  drawer,
}: {
  sections: TaskSectionData[];
  columns: TaskColumnId[];
  label: string;
  emptyMessage: string;
  drawer: IssueDrawerServer;
}) {
  const state = useIssueDrawerState(drawer);
  const rows = useMemo(
    () =>
      sections.flatMap((section) =>
        section.groups.flatMap((group) => group.rows)
      ),
    [sections]
  );
  const wanted = state.requested?.toUpperCase() ?? null;
  const active =
    wanted === null
      ? undefined
      : rows.find(
          (row) =>
            row.key.toUpperCase() === wanted || row.id.toUpperCase() === wanted
        );
  return (
    <>
      <TaskGroupTable
        sections={sections}
        columns={columns}
        label={label}
        headingLevel={2}
        storageKey="milestone-planner:week:collapsed"
        emptyMessage={emptyMessage}
        onOpenRow={(row) => state.open(row.key)}
        activeRowId={active?.id}
      />
      <IssueDrawer state={state} fallbackTitle={active?.title} />
    </>
  );
}
